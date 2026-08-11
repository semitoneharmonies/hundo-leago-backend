const crypto = require("node:crypto");
const {
  isDeepStrictEqual,
} = require("node:util");

const {
  FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
  buildFreeAgentDraftDeadlineOccurrenceKey,
  buildFreeAgentDraftReminderOccurrenceKey,
  buildFreeAgentDraftRolloverOccurrenceKey,
  createFreeAgentDraftClock,
  parseFreeAgentDraftOccurrenceKey,
  validateFreeAgentDraftRolloverSequence,
  validateFreeAgentDraftStatusTransition,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
  createFreeAgentDraftReadinessAttemptEvidence,
  createFreeAgentDraftReadinessTriggerPlan,
  projectFreeAgentDraftReadinessPublicDiagnostics,
  validateFreeAgentDraftReadinessAttemptEvidence,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  finalizeFreeAgentDraftOpeningReadiness,
  inspectFreeAgentDraftOpeningReadiness,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftOpeningReadinessPolicy"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require(
  "../../../domain/leagues/socketInvalidation"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  createSqliteFreeAgentDraftReadRepository,
} = require("./SqliteFreeAgentDraftReadRepository");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BLOCKER_CODE_PATTERN =
  /^[A-Z][A-Z0-9_]{0,99}$/;
const CANDIDATE_SLOT_COUNTS = Object.freeze({
  F: 12,
  D: 6,
  B: 4,
});

const SETUP_PATH_BY_TRIGGER = Object.freeze({
  entry_draft_completed: "completed_entry_draft",
  no_draft_inaugural: "no_draft_inaugural",
  no_draft_initial_season2:
    "no_draft_initial_season2",
});

function deterministicUuid(value) {
  const hex = crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function openingPublicationIds({
  rootOutboxEventId,
  activityId,
  participants,
}) {
  return Object.freeze({
    activityOutboxEventId: deterministicUuid(
      `${rootOutboxEventId}:activity.created:${activityId}`
    ),
    participantOutboxEventIds: Object.freeze(
      participants.map(({ cardId, notificationId }) =>
        Object.freeze({
          cardOutboxEventId: deterministicUuid(
            `${rootOutboxEventId}:candidate_card.changed:${cardId}`
          ),
          notificationOutboxEventId: deterministicUuid(
            `${rootOutboxEventId}:notification.created:${notificationId}`
          ),
        })
      )
    ),
  });
}

function blockerNotificationOutboxId(notificationId) {
  return deterministicUuid(
    `${notificationId}:notification.created:fad-readiness-blocked`
  );
}

const REPOSITORY_METHODS = Object.freeze([
  "ensureReadinessOperation",
  "findReadinessByOccurrence",
  "blockReadinessOperation",
  "commitOpening",
  "findDraft",
  "listRollovers",
  "advanceStatus",
]);

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function notFound(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
    message
  );
}

function conflict(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message
  );
}

function incompatible(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, keys, description) {
  if (!isPlainObject(value)) {
    invalid(`An exact ${description} is required.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    invalid(`An exact ${description} is required.`);
  }
  return value;
}

function stableId(value, description, {
  nullable = false,
} = {}) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`
    );
  }
  return value;
}

function safeTimestamp(value, description, {
  nullable = false,
} = {}) {
  if (nullable && value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function positiveInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(
      `A positive ${description} is required.`
    );
  }
  return value;
}

function nonnegativeInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(
      `A nonnegative ${description} is required.`
    );
  }
  return value;
}

function boundedText(
  value,
  maximumLength,
  description,
  { nullable = false } = {}
) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(
      value
    )
  ) {
    invalid(`A bounded ${description} is required.`);
  }
  return value;
}

function validateReadinessOccurrence(
  occurrenceKey,
  leagueId,
  seasonId
) {
  boundedText(
    occurrenceKey,
    500,
    "FAD readiness occurrence key"
  );
  let parsed;
  try {
    parsed =
      parseFreeAgentDraftOccurrenceKey(
        occurrenceKey
      );
  } catch {
    invalid(
      "Canonical FAD readiness occurrence evidence is required."
    );
  }
  if (
    parsed.type !== "readiness" ||
    parsed.leagueId !== leagueId ||
    parsed.seasonId !== seasonId
  ) {
    invalid(
      "Canonical FAD readiness occurrence evidence is required."
    );
  }
  return occurrenceKey;
}

function normalizeReadinessIdentity(input) {
  try {
    return createFreeAgentDraftReadinessTriggerPlan(
      input
    );
  } catch {
    invalid(
      "Canonical FAD readiness trigger and job evidence is required."
    );
  }
}

function normalizeReadinessLookup(input) {
  exactObject(
    input,
    [
      "leagueId",
      "seasonId",
      "occurrenceKey",
    ],
    "FAD readiness lookup"
  );
  const leagueId = stableId(
    input.leagueId,
    "league identifier"
  );
  const seasonId = stableId(
    input.seasonId,
    "season identifier"
  );
  return Object.freeze({
    leagueId,
    seasonId,
    occurrenceKey:
      validateReadinessOccurrence(
        input.occurrenceKey,
        leagueId,
        seasonId
      ),
  });
}

function compareNullableText(left, right) {
  const leftValue = left ?? "";
  const rightValue = right ?? "";
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeBlocker(value) {
  exactObject(
    value,
    [
      "code",
      "field",
      "resourceType",
      "resourceId",
      "message",
    ],
    "safe FAD readiness blocker"
  );
  if (
    typeof value.code !== "string" ||
    !BLOCKER_CODE_PATTERN.test(value.code)
  ) {
    invalid(
      "A stable FAD readiness blocker code is required."
    );
  }
  const field = boundedText(
    value.field,
    100,
    "FAD readiness blocker field",
    { nullable: true }
  );
  const resourceType = boundedText(
    value.resourceType,
    100,
    "FAD readiness blocker resource type",
    { nullable: true }
  );
  const resourceId =
    value.resourceId === null
      ? null
      : boundedText(
          value.resourceId,
          500,
          "FAD readiness blocker resource identifier"
        );
  const message = boundedText(
    value.message,
    500,
    "FAD readiness blocker message"
  );
  return Object.freeze({
    code: value.code,
    field,
    resourceType,
    resourceId,
    message,
  });
}

function normalizeBlockers(values) {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 100
  ) {
    invalid(
      "At least one safe FAD readiness blocker is required."
    );
  }
  const blockers = values
    .map(normalizeBlocker)
    .sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareNullableText(
          left.field,
          right.field
        ) ||
        compareNullableText(
          left.resourceType,
          right.resourceType
        ) ||
        compareNullableText(
          left.resourceId,
          right.resourceId
        ) ||
        compareText(left.message, right.message)
    );
  const fingerprints = blockers.map(
    (blocker) => JSON.stringify(blocker)
  );
  if (
    new Set(fingerprints).size !==
    fingerprints.length
  ) {
    invalid(
      "Duplicate FAD readiness blockers are not allowed."
    );
  }
  return Object.freeze(blockers);
}

function normalizeJobExecution(
  value,
  operationAtMs
) {
  exactObject(
    value,
    [
      "runId",
      "leaseOwner",
      "leaseToken",
      "leaseExpiresAtMs",
      "expectedVersion",
    ],
    "FAD readiness job execution"
  );
  const leaseExpiresAtMs = safeTimestamp(
    value.leaseExpiresAtMs,
    "readiness job lease-expiry timestamp"
  );
  if (leaseExpiresAtMs <= operationAtMs) {
    invalid(
      "The FAD readiness job lease must remain live through the operation timestamp."
    );
  }
  return Object.freeze({
    runId: stableId(
      value.runId,
      "readiness job-run identifier"
    ),
    leaseOwner: boundedText(
      value.leaseOwner,
      128,
      "readiness job lease owner"
    ),
    leaseToken: boundedText(
      value.leaseToken,
      200,
      "readiness job lease token"
    ),
    leaseExpiresAtMs,
    expectedVersion: positiveInteger(
      value.expectedVersion,
      "readiness job version"
    ),
  });
}

function normalizeReadinessAttempt(value) {
  try {
    return createFreeAgentDraftReadinessAttemptEvidence(
      value
    );
  } catch {
    invalid(
      "Canonical FAD readiness attempt evidence is required."
    );
  }
}

function normalizeBlockCommand(input) {
  exactObject(
    input,
    [
      "leagueId",
      "seasonId",
      "occurrenceKey",
      "expectedVersion",
      "blockers",
      "blockedAtMs",
      "nextRetryAtMs",
      "notificationId",
      "jobExecution",
      "attempt",
    ],
    "FAD readiness blocker command"
  );
  const lookup = normalizeReadinessLookup({
    leagueId: input.leagueId,
    seasonId: input.seasonId,
    occurrenceKey: input.occurrenceKey,
  });
  const blockedAtMs = safeTimestamp(
    input.blockedAtMs,
    "readiness blocker timestamp"
  );
  const nextRetryAtMs = safeTimestamp(
    input.nextRetryAtMs,
    "readiness retry timestamp"
  );
  if (nextRetryAtMs <= blockedAtMs) {
    invalid(
      "The FAD readiness retry must be after the blocker timestamp."
    );
  }
  const blockers = normalizeBlockers(
    input.blockers
  );
  const jobExecution = normalizeJobExecution(
    input.jobExecution,
    blockedAtMs
  );
  const attempt = normalizeReadinessAttempt(
    input.attempt
  );
  let publicBlockers;
  try {
    publicBlockers =
      projectFreeAgentDraftReadinessPublicDiagnostics(
        blockers
      );
  } catch {
    invalid(
      "Canonical public FAD readiness blockers are required."
    );
  }
  if (
    attempt.leagueId !== lookup.leagueId ||
    attempt.seasonId !== lookup.seasonId ||
    attempt.jobRunId !== jobExecution.runId ||
    attempt.outcome !== "blocked" ||
    attempt.observedReadinessVersion !==
      positiveInteger(
        input.expectedVersion,
        "readiness version"
      ) ||
    jobExecution.expectedVersion !==
      attempt.observedReadinessVersion ||
    attempt.recordedAtMs !== blockedAtMs ||
    JSON.stringify(attempt.projection.blockers) !==
      JSON.stringify(publicBlockers)
  ) {
    invalid(
      "The blocked FAD readiness attempt does not match its command."
    );
  }
  return Object.freeze({
    ...lookup,
    expectedVersion: positiveInteger(
      input.expectedVersion,
      "readiness version"
    ),
    blockers,
    blockersJson: serializeCanonicalJsonV1(blockers),
    blockedAtMs,
    nextRetryAtMs,
    notificationId: stableId(
      input.notificationId,
      "readiness blocker notification identifier"
    ),
    jobExecution,
    attempt,
  });
}

function normalizeParticipant(value) {
  exactObject(
    value,
    [
      "teamId",
      "participantId",
      "cardId",
      "notificationId",
    ],
    "FAD opening participant evidence"
  );
  return Object.freeze({
    teamId: stableId(
      value.teamId,
      "participant team identifier"
    ),
    participantId: stableId(
      value.participantId,
      "participant evidence identifier"
    ),
    cardId: stableId(
      value.cardId,
      "Candidate Card identifier"
    ),
    notificationId: stableId(
      value.notificationId,
      "cards-opened notification identifier"
    ),
  });
}

function normalizeCarryoverDiagnostic(
  value,
  description
) {
  exactObject(
    value,
    [
      "code",
      "field",
      "message",
      "resourceId",
      "resourceType",
    ],
    description
  );
  if (
    typeof value.code !== "string" ||
    !BLOCKER_CODE_PATTERN.test(value.code)
  ) {
    invalid(
      `A canonical ${description} code is required.`
    );
  }
  return Object.freeze({
    code: value.code,
    field: boundedText(
      value.field,
      100,
      `${description} field`,
      { nullable: true }
    ),
    message: boundedText(
      value.message,
      500,
      `${description} message`
    ),
    resourceId: boundedText(
      value.resourceId,
      500,
      `${description} resource identifier`,
      { nullable: true }
    ),
    resourceType: boundedText(
      value.resourceType,
      100,
      `${description} resource type`,
      { nullable: true }
    ),
  });
}

function normalizeCarryoverEntry(value) {
  exactObject(
    value,
    [
      "ownershipId",
      "playerId",
      "contractId",
      "effectivePositionGroup",
      "sourceRosterCategory",
      "requestedSlotGroup",
      "requestedSlotNumber",
      "placementState",
      "conflictCode",
      "originalTotalValueCents",
      "originalTermYears",
      "aavCents",
      "remainingYears",
    ],
    "Candidate carryover entry"
  );
  const effectivePositionGroup =
    value.effectivePositionGroup;
  const requestedSlotGroup =
    value.requestedSlotGroup;
  const placementState = value.placementState;
  if (
    !["F", "D"].includes(
      effectivePositionGroup
    ) ||
    !["F", "D", "B"].includes(
      requestedSlotGroup
    ) ||
    !["Active", "Bench", "Injured Reserve"].includes(
      value.sourceRosterCategory
    ) ||
    !["placed", "conflict"].includes(
      placementState
    ) ||
    (
      placementState === "placed"
        ? value.conflictCode !== null
        : value.conflictCode !==
          "CARRYOVER_SLOT_CONFLICT"
    ) ||
    (
      value.sourceRosterCategory === "Bench"
        ? requestedSlotGroup !== "B"
        : requestedSlotGroup !==
          effectivePositionGroup
    )
  ) {
    invalid(
      "The Candidate carryover placement is invalid."
    );
  }
  const requestedSlotNumber = positiveInteger(
    value.requestedSlotNumber,
    "Candidate carryover slot number"
  );
  if (
    requestedSlotNumber >
    CANDIDATE_SLOT_COUNTS[requestedSlotGroup]
  ) {
    invalid(
      "The Candidate carryover slot number exceeds its slot group."
    );
  }
  const originalTermYears = positiveInteger(
    value.originalTermYears,
    "Candidate carryover original term"
  );
  const remainingYears = positiveInteger(
    value.remainingYears,
    "Candidate carryover remaining term"
  );
  if (remainingYears > originalTermYears) {
    invalid(
      "The Candidate carryover remaining term exceeds its original term."
    );
  }
  return Object.freeze({
    ownershipId: stableId(
      value.ownershipId,
      "Candidate carryover ownership identifier"
    ),
    playerId: stableId(
      value.playerId,
      "Candidate carryover player identifier"
    ),
    contractId: stableId(
      value.contractId,
      "Candidate carryover contract identifier"
    ),
    effectivePositionGroup,
    sourceRosterCategory:
      value.sourceRosterCategory,
    requestedSlotGroup,
    requestedSlotNumber,
    placementState,
    conflictCode: value.conflictCode,
    originalTotalValueCents: positiveInteger(
      value.originalTotalValueCents,
      "Candidate carryover original total value"
    ),
    originalTermYears,
    aavCents: positiveInteger(
      value.aavCents,
      "Candidate carryover AAV"
    ),
    remainingYears,
  });
}

function normalizeCarryoverProjection(
  value,
  expectedTeamProjections
) {
  exactObject(
    value,
    [
      "teams",
      "stateBlockers",
      "structuralWarnings",
    ],
    "Candidate carryover projection"
  );
  if (
    !Array.isArray(value.teams) ||
    !Array.isArray(value.stateBlockers) ||
    !Array.isArray(value.structuralWarnings) ||
    value.stateBlockers.length !== 0 ||
    value.teams.length !==
      expectedTeamProjections.length
  ) {
    invalid(
      "The successful Candidate carryover projection is incomplete or blocked."
    );
  }
  let priorTeamId = null;
  const teams = value.teams.map(
    (team, teamIndex) => {
      exactObject(
        team,
        [
          "teamId",
          "entries",
          "carryoverCount",
          "openForwardSlots",
          "openDefenceSlots",
          "openBenchSlots",
          "structuralConflictCount",
        ],
        "Candidate team carryover projection"
      );
      const teamId = stableId(
        team.teamId,
        "Candidate carryover team identifier"
      );
      if (
        priorTeamId !== null &&
        compareText(teamId, priorTeamId) <= 0
      ) {
        invalid(
          "Candidate carryover teams must use canonical order."
        );
      }
      if (!Array.isArray(team.entries)) {
        invalid(
          "Candidate carryover entries are required."
        );
      }
      let priorOwnershipId = null;
      const entries = team.entries.map((entry) => {
        const normalized =
          normalizeCarryoverEntry(entry);
        if (
          priorOwnershipId !== null &&
          compareText(
            normalized.ownershipId,
            priorOwnershipId
          ) <= 0
        ) {
          invalid(
            "Candidate carryover entries must use canonical ownership order."
          );
        }
        priorOwnershipId = normalized.ownershipId;
        return normalized;
      });
      const placedSlotKeys = new Set();
      const placedByGroup = {
        F: 0,
        D: 0,
        B: 0,
      };
      let conflicts = 0;
      for (const entry of entries) {
        if (entry.placementState === "conflict") {
          conflicts += 1;
          continue;
        }
        const slotIdentity =
          `${entry.requestedSlotGroup}:` +
          entry.requestedSlotNumber;
        if (placedSlotKeys.has(slotIdentity)) {
          invalid(
            "Candidate carryover placed slots must be unique."
          );
        }
        placedSlotKeys.add(slotIdentity);
        placedByGroup[
          entry.requestedSlotGroup
        ] += 1;
      }
      const carryoverCount =
        nonnegativeInteger(
          team.carryoverCount,
          "Candidate carryover count"
        );
      const openForwardSlots =
        nonnegativeInteger(
          team.openForwardSlots,
          "open Candidate forward-slot count"
        );
      const openDefenceSlots =
        nonnegativeInteger(
          team.openDefenceSlots,
          "open Candidate defence-slot count"
        );
      const openBenchSlots = nonnegativeInteger(
        team.openBenchSlots,
        "open Candidate bench-slot count"
      );
      const structuralConflictCount =
        nonnegativeInteger(
          team.structuralConflictCount,
          "Candidate structural-conflict count"
        );
      const expectedSummary =
        expectedTeamProjections[teamIndex];
      const summary = {
        teamId,
        carryoverCount,
        openForwardSlots,
        openDefenceSlots,
        openBenchSlots,
        structuralConflictCount,
      };
      if (
        carryoverCount !== entries.length ||
        structuralConflictCount !== conflicts ||
        openForwardSlots !==
          CANDIDATE_SLOT_COUNTS.F -
            placedByGroup.F ||
        openDefenceSlots !==
          CANDIDATE_SLOT_COUNTS.D -
            placedByGroup.D ||
        openBenchSlots !==
          CANDIDATE_SLOT_COUNTS.B -
            placedByGroup.B ||
        !expectedSummary ||
        !isDeepStrictEqual(summary, {
          teamId: expectedSummary.teamId,
          carryoverCount:
            expectedSummary.carryoverCount,
          openForwardSlots:
            expectedSummary.openForwardSlots,
          openDefenceSlots:
            expectedSummary.openDefenceSlots,
          openBenchSlots:
            expectedSummary.openBenchSlots,
          structuralConflictCount:
            expectedSummary.structuralConflictCount,
        })
      ) {
        invalid(
          "The Candidate carryover projection does not match the readiness team summary."
        );
      }
      priorTeamId = teamId;
      return Object.freeze({
        teamId,
        entries: Object.freeze(entries),
        carryoverCount,
        openForwardSlots,
        openDefenceSlots,
        openBenchSlots,
        structuralConflictCount,
      });
    }
  );
  const structuralWarnings =
    value.structuralWarnings.map((warning) =>
      normalizeCarryoverDiagnostic(
        warning,
        "Candidate carryover warning"
      )
    );
  return Object.freeze({
    teams: Object.freeze(teams),
    stateBlockers: Object.freeze([]),
    structuralWarnings:
      Object.freeze(structuralWarnings),
  });
}

function normalizeIdArray(
  value,
  expectedLength,
  description
) {
  if (
    !Array.isArray(value) ||
    value.length !== expectedLength
  ) {
    invalid(
      `Exactly ${expectedLength} ${description} are required.`
    );
  }
  const result = value.map((id) =>
    stableId(id, description)
  );
  if (new Set(result).size !== result.length) {
    invalid(`${description} must be unique.`);
  }
  return Object.freeze(result);
}

function normalizeScheduleBinding(
  input,
  description = "current schedule-generation binding"
) {
  exactObject(
    input,
    [
      "operationId",
      "version",
      "weekOneMatchupWeekId",
      "weekOneStartsAtMs",
    ],
    description
  );
  return Object.freeze({
    operationId: stableId(
      input.operationId,
      "schedule-operation identifier"
    ),
    version: positiveInteger(
      input.version,
      "schedule version"
    ),
    weekOneMatchupWeekId: stableId(
      input.weekOneMatchupWeekId,
      "competition Week 1 identifier"
    ),
    weekOneStartsAtMs: safeTimestamp(
      input.weekOneStartsAtMs,
      "competition Week 1 timestamp"
    ),
  });
}

function scheduleBindingFromGeneration(
  generation,
  description
) {
  if (
    !generation ||
    typeof generation !== "object" ||
    Array.isArray(generation)
  ) {
    invalid(`A ${description} is required.`);
  }
  return normalizeScheduleBinding(
    {
      operationId: generation.scheduleOperationId,
      version: generation.scheduleVersion,
      weekOneMatchupWeekId:
        generation.weekOneMatchupWeekId,
      weekOneStartsAtMs:
        generation.weekOneStartsAtMs,
    },
    description
  );
}

function schedulesMatch(left, right) {
  return (
    left.operationId === right.operationId &&
    left.version === right.version &&
    left.weekOneMatchupWeekId ===
      right.weekOneMatchupWeekId &&
    left.weekOneStartsAtMs ===
      right.weekOneStartsAtMs
  );
}

function normalizeScheduleRecoveryBoundary(
  plan,
  {
    leagueId,
    seasonId,
    fadId,
    recoveryKind,
    occurredAtMs,
    currentSchedule,
  }
) {
  if (plan === null) {
    return Object.freeze({
      plan: null,
      targetSchedule: currentSchedule,
    });
  }
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    plan.action !== "stage_recovery" ||
    plan.recoveryRequired !== true ||
    plan.recoveryKind !== recoveryKind ||
    !plan.scope ||
    plan.scope.leagueId !== leagueId ||
    plan.scope.seasonId !== seasonId ||
    plan.scope.fadId !== fadId ||
    !plan.recovery ||
    plan.recovery.id === undefined ||
    plan.recovery.recoveryKind !== recoveryKind ||
    plan.recovery.leagueId !== leagueId ||
    plan.recovery.seasonId !== seasonId ||
    plan.recovery.fadId !== fadId ||
    plan.recovery.completedAtMs !== occurredAtMs ||
    !plan.generation ||
    !plan.generation.expectedCurrent ||
    !plan.generation.replacement
  ) {
    invalid(
      "The FAD schedule-recovery plan does not match this lifecycle command."
    );
  }
  stableId(
    plan.recovery.id,
    "schedule-recovery identifier"
  );
  const expectedCurrent =
    scheduleBindingFromGeneration(
      plan.generation.expectedCurrent,
      "recovery current schedule-generation binding"
    );
  const targetSchedule =
    scheduleBindingFromGeneration(
      plan.generation.replacement,
      "recovery replacement schedule-generation binding"
    );
  if (
    !schedulesMatch(
      expectedCurrent,
      currentSchedule
    ) ||
    plan.recovery.oldScheduleOperationId !==
      expectedCurrent.operationId ||
    plan.recovery.oldScheduleVersion !==
      expectedCurrent.version ||
    plan.recovery.oldFirstMatchupWeekId !==
      expectedCurrent.weekOneMatchupWeekId ||
    plan.recovery.oldWeekOneStartsAtMs !==
      expectedCurrent.weekOneStartsAtMs ||
    plan.recovery.newScheduleOperationId !==
      targetSchedule.operationId ||
    plan.recovery.newScheduleVersion !==
      targetSchedule.version ||
    plan.recovery.newFirstMatchupWeekId !==
      targetSchedule.weekOneMatchupWeekId ||
    plan.recovery.newWeekOneStartsAtMs !==
      targetSchedule.weekOneStartsAtMs
  ) {
    invalid(
      "The FAD schedule-recovery plan is not bound to the command schedule generations."
    );
  }
  return Object.freeze({
    plan,
    targetSchedule,
  });
}

function normalizeOpeningCommand(input) {
  exactObject(
    input,
    [
      "leagueId",
      "seasonId",
      "occurrenceKey",
      "readinessOperationId",
      "expectedReadinessVersion",
      "openedAtMs",
      "setupPath",
      "entryDraftId",
      "setupExemptionId",
      "priorSeasonRolloverId",
      "noDraftReason",
      "schedule",
      "scheduleRecoveryPlan",
      "carryoverProjection",
      "evidence",
      "jobExecution",
      "attempt",
    ],
    "FAD opening command"
  );
  const lookup = normalizeReadinessLookup({
    leagueId: input.leagueId,
    seasonId: input.seasonId,
    occurrenceKey: input.occurrenceKey,
  });
  const openedAtMs = safeTimestamp(
    input.openedAtMs,
    "Candidate Card opening timestamp"
  );
  const schedule = normalizeScheduleBinding(
    input.schedule
  );
  const jobExecution = normalizeJobExecution(
    input.jobExecution,
    openedAtMs
  );
  const attempt = normalizeReadinessAttempt(
    input.attempt
  );
  const carryoverProjection =
    normalizeCarryoverProjection(
      input.carryoverProjection,
      attempt.projection.teamProjections
    );

  const entryDraftId = stableId(
    input.entryDraftId,
    "Entry Draft identifier",
    { nullable: true }
  );
  const setupExemptionId = stableId(
    input.setupExemptionId,
    "setup-exemption identifier",
    { nullable: true }
  );
  const priorSeasonRolloverId = stableId(
    input.priorSeasonRolloverId,
    "prior-season rollover identifier",
    { nullable: true }
  );
  const noDraftReason = boundedText(
    input.noDraftReason,
    500,
    "no-draft reason",
    { nullable: true }
  );
  if (
    !Object.values(
      SETUP_PATH_BY_TRIGGER
    ).includes(input.setupPath) ||
    (
      input.setupPath ===
        "completed_entry_draft" &&
      (
        entryDraftId === null ||
        setupExemptionId !== null ||
        priorSeasonRolloverId === null ||
        noDraftReason !== null
      )
    ) ||
    (
      input.setupPath ===
        "no_draft_inaugural" &&
      (
        entryDraftId !== null ||
        setupExemptionId !== null ||
        priorSeasonRolloverId !== null ||
        noDraftReason === null
      )
    ) ||
    (
      input.setupPath ===
        "no_draft_initial_season2" &&
      (
        entryDraftId !== null ||
        setupExemptionId === null ||
        priorSeasonRolloverId !== null ||
        noDraftReason === null
      )
    )
  ) {
    invalid(
      "The FAD opening path evidence is inconsistent."
    );
  }

  exactObject(
    input.evidence,
    [
      "fadId",
      "participants",
      "reminderJobRunId",
      "deadlineJobRunId",
      "rolloverIds",
      "rolloverJobRunIds",
      "activityId",
      "outboxEventId",
      "outboxAudienceId",
    ],
    "FAD opening evidence"
  );
  if (
    !Array.isArray(
      input.evidence.participants
    ) ||
    input.evidence.participants.length < 1
  ) {
    invalid(
      "At least one FAD participant is required."
    );
  }
  const participants =
    input.evidence.participants
      .map(normalizeParticipant)
      .sort((left, right) =>
        compareText(left.teamId, right.teamId)
      );
  for (const key of [
    "teamId",
    "participantId",
    "cardId",
    "notificationId",
  ]) {
    if (
      new Set(
        participants.map(
          (participant) => participant[key]
        )
      ).size !== participants.length
    ) {
      invalid(
        `FAD participant ${key} values must be unique.`
      );
    }
  }
  const rolloverIds = normalizeIdArray(
    input.evidence.rolloverIds,
    FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
    "initial rollover identifiers"
  );
  const rolloverJobRunIds =
    normalizeIdArray(
      input.evidence.rolloverJobRunIds,
      FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
      "initial rollover job-run identifiers"
    );
  const evidence = Object.freeze({
    fadId: stableId(
      input.evidence.fadId,
      "FAD identifier"
    ),
    participants: Object.freeze(participants),
    reminderJobRunId: stableId(
      input.evidence.reminderJobRunId,
      "deadline-reminder job-run identifier"
    ),
    deadlineJobRunId: stableId(
      input.evidence.deadlineJobRunId,
      "deadline job-run identifier"
    ),
    rolloverIds,
    rolloverJobRunIds,
    activityId: stableId(
      input.evidence.activityId,
      "cards-opened activity identifier"
    ),
    outboxEventId: stableId(
      input.evidence.outboxEventId,
      "cards-opened outbox identifier"
    ),
    outboxAudienceId: stableId(
      input.evidence.outboxAudienceId,
      "cards-opened audience identifier"
    ),
  });
  const publicationIds = openingPublicationIds({
    rootOutboxEventId: evidence.outboxEventId,
    activityId: evidence.activityId,
    participants,
  });
  const allEvidenceIds = [
    evidence.fadId,
    evidence.reminderJobRunId,
    evidence.deadlineJobRunId,
    evidence.activityId,
    evidence.outboxEventId,
    evidence.outboxAudienceId,
    publicationIds.activityOutboxEventId,
    ...publicationIds.participantOutboxEventIds.flatMap(
      ({
        cardOutboxEventId,
        notificationOutboxEventId,
      }) => [
        cardOutboxEventId,
        notificationOutboxEventId,
      ]
    ),
    attempt.id,
    ...evidence.rolloverIds,
    ...evidence.rolloverJobRunIds,
    ...participants.flatMap(
      ({
        participantId,
        cardId,
        notificationId,
      }) => [
        participantId,
        cardId,
        notificationId,
      ]
    ),
  ];
  if (
    new Set([
      ...allEvidenceIds,
      jobExecution.runId,
    ]).size !==
    allEvidenceIds.length + 1
  ) {
    invalid(
      "FAD opening evidence identifiers must be globally unique and distinct from the readiness job."
    );
  }
  const recoveryBoundary =
    normalizeScheduleRecoveryBoundary(
      input.scheduleRecoveryPlan,
      {
        leagueId: lookup.leagueId,
        seasonId: lookup.seasonId,
        fadId: evidence.fadId,
        recoveryKind: "pre_open",
        occurredAtMs: openedAtMs,
        currentSchedule: schedule,
      }
    );
  let clock;
  try {
    clock = createFreeAgentDraftClock({
      cardsOpenedAtMs: openedAtMs,
      firstMatchupStartsAtMs:
        recoveryBoundary.targetSchedule
          .weekOneStartsAtMs,
    });
  } catch {
    invalid(
      "The persisted schedule cannot produce a valid FAD clock."
    );
  }
  if (
    attempt.leagueId !== lookup.leagueId ||
    attempt.seasonId !== lookup.seasonId ||
    attempt.readinessOperationId !==
      input.readinessOperationId ||
    attempt.jobRunId !== jobExecution.runId ||
    attempt.outcome !== "succeeded" ||
    attempt.observedReadinessVersion !==
      input.expectedReadinessVersion ||
    jobExecution.expectedVersion !==
      attempt.observedReadinessVersion ||
    attempt.recordedAtMs !== openedAtMs ||
    attempt.projection.candidateDeadlineAtMs !==
      clock.candidateDeadlineAtMs ||
    attempt.projection.reminderAtMs !==
      clock.reminderAtMs ||
    attempt.projection.helpOpensAtMs !==
      clock.helpOpensAtMs ||
    JSON.stringify(
      attempt.projection.initialRollovers
    ) !== JSON.stringify(
      clock.initialRollovers.map(
        ({
          creationCutoffAtMs,
          opensAtMs,
          rollsOverAtMs,
          sequence,
        }) => ({
          creationCutoffAtMs,
          opensAtMs,
          rollsOverAtMs,
          sequence,
        })
      )
    ) ||
    attempt.projection.participatingTeamCount !==
      participants.length ||
    JSON.stringify(
      attempt.projection.firstMatchupWeekBefore
    ) !== JSON.stringify({
      sequence: 1,
      startsAtMs: schedule.weekOneStartsAtMs,
      version: schedule.version,
      weekId: schedule.weekOneMatchupWeekId,
    }) ||
    JSON.stringify(
      attempt.projection.firstMatchupWeekAfter
    ) !== JSON.stringify({
      sequence: 1,
      startsAtMs:
        recoveryBoundary.targetSchedule
          .weekOneStartsAtMs,
      version:
        recoveryBoundary.targetSchedule.version,
      weekId:
        recoveryBoundary.targetSchedule
          .weekOneMatchupWeekId,
    }) ||
    JSON.stringify(
      attempt.projection.teamProjections.map(
        ({ teamId }) => teamId
      )
    ) !== JSON.stringify(
      participants.map(({ teamId }) => teamId)
    ) ||
    (
      input.priorSeasonRolloverId === null
        ? attempt.projection
            .priorSeasonRollover !== null
        : attempt.projection
            .priorSeasonRollover?.rolloverId !==
          input.priorSeasonRolloverId
    )
  ) {
    invalid(
      "The successful FAD readiness attempt does not match its opening command."
    );
  }
  return Object.freeze({
    ...lookup,
    readinessOperationId: stableId(
      input.readinessOperationId,
      "readiness-operation identifier"
    ),
    expectedReadinessVersion:
      positiveInteger(
        input.expectedReadinessVersion,
        "readiness version"
      ),
    openedAtMs,
    setupPath: input.setupPath,
    entryDraftId,
    setupExemptionId,
    priorSeasonRolloverId,
    noDraftReason,
    schedule,
    scheduleRecoveryPlan:
      recoveryBoundary.plan,
    carryoverProjection,
    targetSchedule:
      recoveryBoundary.targetSchedule,
    clock,
    evidence,
    jobExecution,
    attempt,
  });
}

function normalizeDraftLookup(input) {
  exactObject(
    input,
    ["leagueId", "seasonId", "fadId"],
    "FAD lookup"
  );
  return Object.freeze({
    leagueId: stableId(
      input.leagueId,
      "league identifier"
    ),
    seasonId: stableId(
      input.seasonId,
      "season identifier"
    ),
    fadId: stableId(
      input.fadId,
      "FAD identifier"
    ),
  });
}

function normalizeTransition(input) {
  const hasJobExecution =
    isPlainObject(input) &&
    Object.prototype.hasOwnProperty.call(
      input,
      "jobExecution"
    );
  exactObject(
    input,
    [
      "leagueId",
      "seasonId",
      "fadId",
      "expectedVersion",
      "fromStatus",
      "toStatus",
      "occurredAtMs",
      "schedule",
      "scheduleRecoveryPlan",
      ...(hasJobExecution
        ? ["jobExecution"]
        : []),
    ],
    "FAD status transition"
  );
  let status;
  try {
    status =
      validateFreeAgentDraftStatusTransition({
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
      });
  } catch {
    invalid(
      "A valid forward FAD status transition is required."
    );
  }
  if (status.fromStatus === null) {
    invalid(
      "FAD creation must use the readiness opening transaction."
    );
  }
  const lookup = normalizeDraftLookup({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      fadId: input.fadId,
    });
  const occurredAtMs = safeTimestamp(
    input.occurredAtMs,
    "FAD transition timestamp"
  );
  const schedule = normalizeScheduleBinding(
    input.schedule
  );
  const recoveryBoundary =
    normalizeScheduleRecoveryBoundary(
      input.scheduleRecoveryPlan,
      {
        ...lookup,
        recoveryKind: "completion",
        occurredAtMs,
        currentSchedule: schedule,
      }
    );
  if (
    recoveryBoundary.plan !== null &&
    status.toStatus !== "completed"
  ) {
    invalid(
      "Only FAD completion may apply a schedule-recovery plan."
    );
  }
  return Object.freeze({
    ...lookup,
    expectedVersion: positiveInteger(
      input.expectedVersion,
      "FAD version"
    ),
    fromStatus: status.fromStatus,
    toStatus: status.toStatus,
    occurredAtMs,
    schedule,
    scheduleRecoveryPlan:
      recoveryBoundary.plan,
    targetSchedule:
      recoveryBoundary.targetSchedule,
    jobExecution: hasJobExecution
      ? normalizeTransitionJobExecution(
          input.jobExecution,
          occurredAtMs
        )
      : null,
  });
}

function normalizeTransitionJobExecution(
  input,
  occurredAtMs
) {
  exactObject(
    input,
    [
      "runId",
      "jobType",
      "occurrenceKey",
      "scheduledForMs",
      "leaseOwner",
      "leaseToken",
      "leaseExpiresAtMs",
      "startedAtMs",
      "attemptCount",
      "expectedVersion",
    ],
    "FAD transition job execution"
  );
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "FAD transition job scheduled timestamp"
  );
  const startedAtMs = safeTimestamp(
    input.startedAtMs,
    "FAD transition job start timestamp"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.leaseExpiresAtMs,
    "FAD transition job lease-expiry timestamp"
  );
  if (
    startedAtMs < scheduledForMs ||
    startedAtMs > occurredAtMs ||
    leaseExpiresAtMs <= occurredAtMs
  ) {
    invalid(
      "The FAD transition job execution has invalid timing."
    );
  }
  return Object.freeze({
    runId: stableId(
      input.runId,
      "FAD transition job-run identifier"
    ),
    jobType: boundedText(
      input.jobType,
      80,
      "FAD transition job type"
    ),
    occurrenceKey: boundedText(
      input.occurrenceKey,
      400,
      "FAD transition job occurrence key"
    ),
    scheduledForMs,
    leaseOwner: boundedText(
      input.leaseOwner,
      128,
      "FAD transition job lease owner"
    ),
    leaseToken: boundedText(
      input.leaseToken,
      200,
      "FAD transition job lease token"
    ),
    leaseExpiresAtMs,
    startedAtMs,
    attemptCount: positiveInteger(
      input.attemptCount,
      "FAD transition job attempt count"
    ),
    expectedVersion: positiveInteger(
      input.expectedVersion,
      "FAD transition job version"
    ),
  });
}

function readinessRecord(row) {
  if (!row) return null;
  let blockers;
  try {
    blockers = JSON.parse(row.blockers_json);
  } catch {
    incompatible(
      "Persisted FAD readiness blockers are not valid JSON."
    );
  }
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    occurrenceKey:
      row.readiness_occurrence_key,
    triggerKind: row.trigger_kind,
    entryDraftId: row.entry_draft_id,
    setupExemptionId: row.setup_exemption_id,
    jobRunId: row.job_run_id,
    status: row.status,
    attemptCount: row.attempt_count,
    blockers: Object.freeze(
      blockers.map((blocker) =>
        Object.freeze({ ...blocker })
      )
    ),
    matchupScheduleVersionBefore:
      row.matchup_schedule_version_before,
    matchupScheduleVersionAfter:
      row.matchup_schedule_version_after,
    scheduleRecoveryId:
      row.schedule_recovery_id,
    createdFadId: row.created_fad_id,
    reminderJobRunId:
      row.reminder_job_run_id,
    deadlineJobRunId:
      row.deadline_job_run_id,
    cardsOpenedActivityId:
      row.cards_opened_activity_id,
    cardsOpenedOutboxEventId:
      row.cards_opened_outbox_event_id,
    startedAtMs: row.started_at_ms,
    nextRetryAtMs: row.next_retry_at_ms,
    terminalAtMs: row.terminal_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
  });
}

function readinessAttemptRecord(row) {
  if (!row) return null;
  try {
    return validateFreeAgentDraftReadinessAttemptEvidence({
      id: row.id,
      leagueId: row.league_id,
      seasonId: row.season_id,
      readinessOperationId:
        row.readiness_operation_id,
      jobRunId: row.job_run_id,
      attemptNumber: row.attempt_number,
      observedReadinessVersion:
        row.observed_readiness_version,
      outcome: row.outcome,
      observedAtMs: row.observed_at_ms,
      recordedAtMs: row.recorded_at_ms,
      projectionJson: row.projection_json,
      projectionSha256:
        row.projection_sha256,
      version: row.version,
    });
  } catch {
    incompatible(
      "Persisted FAD readiness attempt evidence is noncanonical."
    );
  }
}

function sameReadinessAttempt(left, right) {
  return Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.leagueId === right.leagueId &&
    left.seasonId === right.seasonId &&
    left.readinessOperationId ===
      right.readinessOperationId &&
    left.jobRunId === right.jobRunId &&
    left.attemptNumber === right.attemptNumber &&
    left.observedReadinessVersion ===
      right.observedReadinessVersion &&
    left.outcome === right.outcome &&
    left.observedAtMs === right.observedAtMs &&
    left.recordedAtMs === right.recordedAtMs &&
    left.projectionJson === right.projectionJson &&
    left.projectionSha256 ===
      right.projectionSha256 &&
    left.version === right.version
  );
}

function requireCanonicalBlockerNotification(
  row,
  {
    leagueId,
    seasonId,
    readinessOperationId,
    userId,
    deduplicationKey,
  }
) {
  let message;
  try {
    message = JSON.parse(row.message_data_json);
  } catch {
    incompatible(
      "Persisted FAD readiness blocker notification data is invalid."
    );
  }
  const messageKeys = isPlainObject(message)
    ? Object.keys(message).sort()
    : [];
  const destinationKeys = isPlainObject(
    message?.destination
  )
    ? Object.keys(message.destination).sort()
    : [];
  const errorCodes = message?.errorCodes;
  let contract;
  try {
    contract = createFreeAgentDraftNotificationContract({
      type: "fad_readiness_blocked",
      recipientUserId: userId,
      messageData: message,
    });
  } catch {
    incompatible(
      "Persisted FAD readiness blocker notification data is noncanonical."
    );
  }
  if (
    !UUID_PATTERN.test(row.id) ||
    row.user_id !== userId ||
    row.league_id !== leagueId ||
    row.event_type !== "fad_readiness_blocked" ||
    row.related_feature !== "free_agent_draft" ||
    row.related_record_id !== readinessOperationId ||
    row.deduplication_key !== deduplicationKey ||
    row.message_data_json !==
      JSON.stringify(contract.messageData) ||
    row.delivery_status !== "pending" ||
    row.read_at_ms !== null ||
    row.delivered_at_ms !== null ||
    row.version !== 1 ||
    contract.deduplicationKey !== deduplicationKey ||
    messageKeys.join("|") !==
      "destination|errorCodes|leagueId|readinessOperationId|seasonId" ||
    destinationKeys.join("|") !==
      "kind|leagueId|seasonId" ||
    message.leagueId !== leagueId ||
    message.seasonId !== seasonId ||
    message.readinessOperationId !==
      readinessOperationId ||
    message.destination.kind !==
      "commissioner_fad" ||
    message.destination.leagueId !== leagueId ||
    message.destination.seasonId !== seasonId ||
    !Array.isArray(errorCodes) ||
    errorCodes.length < 1 ||
    errorCodes.some(
      (code) =>
        typeof code !== "string" ||
        !BLOCKER_CODE_PATTERN.test(code)
    ) ||
    new Set(errorCodes).size !== errorCodes.length ||
    errorCodes.some(
      (code, index) =>
        index > 0 &&
        errorCodes[index - 1] >= code
    )
  ) {
    incompatible(
      "Persisted FAD readiness blocker notification binding is noncanonical."
    );
  }
  return row;
}

function draftRecord(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    readinessOperationId:
      row.readiness_operation_id,
    readinessOccurrenceKey:
      row.readiness_occurrence_key,
    firstMatchupWeekId:
      row.first_matchup_week_id,
    currentCompetitionFirstMatchupWeekId:
      row.current_competition_first_matchup_week_id,
    scheduleRecoveryId:
      row.schedule_recovery_id,
    participatingTeamCount:
      row.participating_team_count,
    status: row.status,
    setupPath: row.setup_path,
    entryDraftId: row.entry_draft_id,
    setupExemptionId: row.setup_exemption_id,
    priorSeasonRolloverId:
      row.prior_season_rollover_id,
    noDraftReason: row.no_draft_reason,
    openingAuthority: row.opening_authority,
    openedAtMs: row.opened_at_ms,
    helpOpensAtMs: row.help_opens_at_ms,
    candidateDeadlineAtMs:
      row.candidate_deadline_at_ms,
    firstMatchupStartsAtMs:
      row.first_matchup_starts_at_ms,
    deadlineLockedAtMs:
      row.deadline_locked_at_ms,
    allocationCompletedAtMs:
      row.allocation_completed_at_ms,
    completedAtMs: row.completed_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
  });
}

function rolloverRecord(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    fadId: row.fad_id,
    sequence: row.sequence,
    windowKind: row.window_kind,
    predecessorRolloverId:
      row.predecessor_rollover_id,
    extensionReason: row.extension_reason,
    extensionSourceId:
      row.extension_source_id,
    opensAtMs: row.opens_at_ms,
    creationCutoffAtMs:
      row.creation_cutoff_at_ms,
    rollsOverAtMs: row.rolls_over_at_ms,
    status: row.status,
    processingJobRunId:
      row.processing_job_run_id,
    processingStartedAtMs:
      row.processing_started_at_ms,
    completedAtMs: row.completed_at_ms,
    lastErrorCode: row.last_error_code,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
  });
}

function uniqueRow(statement, parameters, description) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(`${description} was not unique.`);
  }
  return rows[0] || null;
}

function requireChanged(result, message) {
  if (result.changes !== 1) conflict(message);
}

function assertSynchronous(value, description) {
  if (
    value &&
    typeof value.then === "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      `${description} must be synchronous.`
    );
  }
}

function createSqliteFreeAgentDraftRepository({
  database,
  candidateCardWriter,
  scheduleRecoveryWriter,
  transitionWriter,
  notificationWriter,
  leagueOutboxWriter,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftRepository requires an opened database"
    );
  }
  if (
    candidateCardWriter !== undefined &&
    (
      !candidateCardWriter ||
      typeof candidateCardWriter.openAll !==
        "function"
    )
  ) {
    throw new TypeError(
      "FAD Candidate Card writer must expose openAll"
    );
  }
  if (
    scheduleRecoveryWriter !== undefined &&
    (
      !scheduleRecoveryWriter ||
      typeof scheduleRecoveryWriter.stage !==
        "function" ||
      typeof scheduleRecoveryWriter.seal !==
        "function" ||
      typeof scheduleRecoveryWriter.applyAndSeal !==
        "function"
    )
  ) {
    throw new TypeError(
      "FAD schedule-recovery writer must expose stage, seal, and applyAndSeal"
    );
  }
  if (
    transitionWriter !== undefined &&
    (
      !transitionWriter ||
      typeof transitionWriter.beforeTransition !==
        "function"
    )
  ) {
    throw new TypeError(
      "FAD transition writer must expose beforeTransition"
    );
  }
  if (
    transitionWriter?.afterTransition !== undefined &&
    typeof transitionWriter.afterTransition !==
      "function"
  ) {
    throw new TypeError(
      "FAD transition writer afterTransition must be a function"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "FAD beforeCommit must be a function"
    );
  }
  const notifications =
    resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
  const outbox = resolveSqliteLeagueOutboxWriter({
    database,
    leagueOutboxWriter,
  });
  const openingReader =
    createSqliteFreeAgentDraftReadRepository({
      database,
    });

  let readinessByOccurrenceStatement;
  let readinessBySeasonStatement;
  let readinessJobStatement;
  let readinessJobByIdentityStatement;
  let readinessExecutionStatement;
  let readinessAttemptStatement;
  let readinessAttemptByExecutionStatement;
  let insertReadinessAttemptStatement;
  let insertReadinessJobStatement;
  let insertReadinessStatement;
  let blockReadinessStatement;
  let failReadinessJobStatement;
  let succeedReadinessJobStatement;
  let blockerNotificationStatement;
  let blockerNotificationsByReadinessStatement;
  let blockerOutboxStatement;
  let readinessOpeningEvidenceStatement;
  let readinessOpeningPublicationStatement;
  let readinessOpeningNotificationsStatement;
  let commissionerStatement;
  let currentScheduleStatement;
  let activeParticipantsStatement;
  let insertDraftStatement;
  let insertParticipantStatement;
  let candidateCardCoverageStatement;
  let insertJobStatement;
  let insertRolloverStatement;
  let insertActivityStatement;
  let insertOutboxStatement;
  let insertOutboxAudienceStatement;
  let succeedReadinessStatement;
  let draftStatement;
  let participantsStatement;
  let cardsStatement;
  let candidateCardOpeningEntryStatement;
  let candidateCardOpeningRevisionStatement;
  let candidateCardOpeningOwnershipStatement;
  let rolloverStatement;
  let deadlineEvidenceStatement;
  let transitionDeadlineStatement;
  let transitionAllocatingStatement;
  let transitionRapidStatement;
  let transitionCompletedStatement;

  try {
    readinessByOccurrenceStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_readiness_operations
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND readiness_occurrence_key =
            @occurrenceKey
        LIMIT 2
      `);
    readinessBySeasonStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_readiness_operations
        WHERE league_id = @leagueId
          AND season_id = @seasonId
        LIMIT 2
      `);
    readinessJobStatement = database.prepare(`
      SELECT id
      FROM job_runs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @jobRunId
        AND job_type = @jobType
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
        AND status = 'pending'
        AND attempt_count = 0
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at_ms IS NULL
        AND started_at_ms IS NULL
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND created_at_ms = @createdAtMs
        AND updated_at_ms = @createdAtMs
        AND version = 1
      LIMIT 2
    `);
    readinessJobByIdentityStatement =
      database.prepare(`
        SELECT id
        FROM job_runs
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @jobRunId
          AND job_type = @jobType
          AND occurrence_key = @occurrenceKey
          AND scheduled_for_ms = @scheduledForMs
          AND created_at_ms = @createdAtMs
        LIMIT 2
      `);
    readinessExecutionStatement =
      database.prepare(`
        SELECT
          readiness.id AS readiness_id,
          readiness.job_run_id AS readiness_job_run_id,
          readiness.status AS readiness_status,
          readiness.attempt_count AS readiness_attempt_count,
          readiness.lease_owner AS readiness_lease_owner,
          readiness.lease_token AS readiness_lease_token,
          readiness.lease_expires_at_ms AS readiness_lease_expires_at_ms,
          readiness.blockers_json AS readiness_blockers_json,
          readiness.matchup_schedule_version_before AS readiness_schedule_version_before,
          readiness.matchup_schedule_version_after AS readiness_schedule_version_after,
          readiness.schedule_recovery_id AS readiness_schedule_recovery_id,
          readiness.created_fad_id AS readiness_created_fad_id,
          readiness.reminder_job_run_id AS readiness_reminder_job_run_id,
          readiness.deadline_job_run_id AS readiness_deadline_job_run_id,
          readiness.cards_opened_activity_id AS readiness_activity_id,
          readiness.cards_opened_outbox_event_id AS readiness_outbox_event_id,
          readiness.started_at_ms AS readiness_started_at_ms,
          readiness.next_retry_at_ms AS readiness_next_retry_at_ms,
          readiness.terminal_at_ms AS readiness_terminal_at_ms,
          readiness.created_at_ms AS readiness_created_at_ms,
          readiness.updated_at_ms AS readiness_updated_at_ms,
          readiness.version AS readiness_version,
          job.id AS job_id,
          job.job_type AS job_type,
          job.occurrence_key AS job_occurrence_key,
          job.scheduled_for_ms AS job_scheduled_for_ms,
          job.status AS job_status,
          job.attempt_count AS job_attempt_count,
          job.lease_owner AS job_lease_owner,
          job.lease_token AS job_lease_token,
          job.lease_expires_at_ms AS job_lease_expires_at_ms,
          job.started_at_ms AS job_started_at_ms,
          job.completed_at_ms AS job_completed_at_ms,
          job.result_json AS job_result_json,
          job.last_error_code AS job_last_error_code,
          job.next_attempt_at_ms AS job_next_attempt_at_ms,
          job.created_at_ms AS job_created_at_ms,
          job.updated_at_ms AS job_updated_at_ms,
          job.version AS job_version,
          season.version AS season_version
        FROM free_agent_draft_readiness_operations AS readiness
        JOIN job_runs AS job
          ON job.league_id = readiness.league_id
         AND job.season_id = readiness.season_id
         AND job.id = readiness.job_run_id
         AND job.occurrence_key = readiness.readiness_occurrence_key
        JOIN seasons AS season
          ON season.league_id = readiness.league_id
         AND season.id = readiness.season_id
        WHERE readiness.league_id = @leagueId
          AND readiness.season_id = @seasonId
          AND readiness.id = @readinessOperationId
          AND readiness.readiness_occurrence_key = @occurrenceKey
        LIMIT 2
      `);
    readinessAttemptStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_attempts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @attemptId
      LIMIT 2
    `);
    readinessAttemptByExecutionStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND readiness_operation_id =
            @readinessOperationId
          AND job_run_id = @jobRunId
          AND attempt_number = @attemptNumber
        LIMIT 2
      `);
    insertReadinessAttemptStatement =
      database.prepare(`
        INSERT INTO free_agent_draft_readiness_attempts (
          id,
          league_id,
          season_id,
          readiness_operation_id,
          job_run_id,
          attempt_number,
          observed_readiness_version,
          outcome,
          observed_at_ms,
          recorded_at_ms,
          projection_json,
          projection_sha256,
          version
        ) VALUES (
          @id,
          @leagueId,
          @seasonId,
          @readinessOperationId,
          @jobRunId,
          @attemptNumber,
          @observedReadinessVersion,
          @outcome,
          @observedAtMs,
          @recordedAtMs,
          @projectionJson,
          @projectionSha256,
          1
        )
      `);
    insertReadinessJobStatement =
      database.prepare(`
        INSERT INTO job_runs (
          id,
          league_id,
          season_id,
          job_type,
          occurrence_key,
          scheduled_for_ms,
          status,
          attempt_count,
          lease_owner,
          lease_expires_at_ms,
          started_at_ms,
          completed_at_ms,
          result_json,
          last_error_code,
          created_at_ms,
          updated_at_ms,
          version,
          lease_token,
          next_attempt_at_ms
        ) VALUES (
          @id,
          @leagueId,
          @seasonId,
          @jobType,
          @occurrenceKey,
          @scheduledForMs,
          'pending',
          0,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          @createdAtMs,
          @createdAtMs,
          1,
          NULL,
          NULL
        )
      `);
    insertReadinessStatement =
      database.prepare(`
        INSERT INTO free_agent_draft_readiness_operations (
          id,
          league_id,
          season_id,
          readiness_occurrence_key,
          trigger_kind,
          entry_draft_id,
          setup_exemption_id,
          job_run_id,
          status,
          attempt_count,
          lease_owner,
          lease_token,
          lease_expires_at_ms,
          blockers_json,
          matchup_schedule_version_before,
          matchup_schedule_version_after,
          schedule_recovery_id,
          created_fad_id,
          reminder_job_run_id,
          deadline_job_run_id,
          cards_opened_activity_id,
          cards_opened_outbox_event_id,
          started_at_ms,
          next_retry_at_ms,
          terminal_at_ms,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @operationId,
          @leagueId,
          @seasonId,
          @occurrenceKey,
          @triggerKind,
          @entryDraftId,
          @setupExemptionId,
          @jobRunId,
          'pending',
          0,
          NULL,
          NULL,
          NULL,
          '[]',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          @createdAtMs,
          @createdAtMs,
          1
        )
      `);
    blockReadinessStatement =
      database.prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET status = 'blocked',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            blockers_json = @blockersJson,
            next_retry_at_ms = @nextRetryAtMs,
            terminal_at_ms = @blockedAtMs,
            updated_at_ms = @blockedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @readinessOperationId
          AND readiness_occurrence_key =
            @occurrenceKey
          AND status = 'running'
          AND job_run_id = @jobRunId
          AND attempt_count = @attemptNumber
          AND version =
            @observedReadinessVersion
          AND lease_owner = @leaseOwner
          AND lease_token = @leaseToken
          AND lease_expires_at_ms =
            @leaseExpiresAtMs
          AND lease_expires_at_ms >
            @recordedAtMs
          AND started_at_ms = @startedAtMs
          AND blockers_json = '[]'
          AND matchup_schedule_version_before IS NULL
          AND matchup_schedule_version_after IS NULL
          AND schedule_recovery_id IS NULL
          AND created_fad_id IS NULL
          AND reminder_job_run_id IS NULL
          AND deadline_job_run_id IS NULL
          AND cards_opened_activity_id IS NULL
          AND cards_opened_outbox_event_id IS NULL
          AND next_retry_at_ms IS NULL
          AND terminal_at_ms IS NULL
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_readiness_attempts
              AS attempt
            WHERE attempt.league_id = @leagueId
              AND attempt.season_id = @seasonId
              AND attempt.id = @attemptId
              AND attempt.readiness_operation_id =
                @readinessOperationId
              AND attempt.job_run_id = @jobRunId
              AND attempt.attempt_number =
                @attemptNumber
              AND attempt.observed_readiness_version =
                @observedReadinessVersion
              AND attempt.outcome = 'blocked'
              AND attempt.recorded_at_ms =
                @recordedAtMs
              AND attempt.projection_sha256 =
                @projectionSha256
          )
      `);
    failReadinessJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @recordedAtMs,
          result_json = NULL,
          last_error_code =
            'FAD_READINESS_BLOCKED',
          next_attempt_at_ms = @nextRetryAtMs,
          updated_at_ms = @recordedAtMs,
          version = version + 1
      WHERE id = @jobRunId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND job_type =
          '${FREE_AGENT_DRAFT_READINESS_JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms =
          @readinessCreatedAtMs
        AND created_at_ms =
          @readinessCreatedAtMs
        AND status = 'running'
        AND attempt_count = @attemptNumber
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms =
          @leaseExpiresAtMs
        AND lease_expires_at_ms >
          @recordedAtMs
        AND started_at_ms = @startedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND updated_at_ms = @runningUpdatedAtMs
        AND version = @observedReadinessVersion
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_readiness_operations
            AS readiness
          WHERE readiness.league_id = @leagueId
            AND readiness.season_id = @seasonId
            AND readiness.id = @readinessOperationId
            AND readiness.job_run_id = @jobRunId
            AND readiness.readiness_occurrence_key =
              @occurrenceKey
            AND readiness.status = 'blocked'
            AND readiness.attempt_count =
              @attemptNumber
            AND readiness.version = @terminalVersion
            AND readiness.blockers_json =
              @blockersJson
            AND readiness.next_retry_at_ms =
              @nextRetryAtMs
            AND readiness.terminal_at_ms =
              @recordedAtMs
        )
    `);
    blockerNotificationStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE user_id = @userId
        AND event_type =
          'fad_readiness_blocked'
        AND deduplication_key =
          @deduplicationKey
      LIMIT 2
    `);
    blockerNotificationsByReadinessStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE league_id = @leagueId
        AND event_type = 'fad_readiness_blocked'
        AND related_feature = 'free_agent_draft'
        AND related_record_id = @readinessOperationId
        AND created_at_ms <= @recordedAtMs
      ORDER BY created_at_ms, user_id, id
    `);
    blockerOutboxStatement = database.prepare(`
      SELECT id
      FROM outbox_events
      WHERE league_id = @leagueId
        AND id = @eventId
      LIMIT 2
    `);
    commissionerStatement = database.prepare(`
      SELECT
        membership.user_id,
        membership.id AS membership_id
      FROM leagues AS league
      JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id =
         league.commissioner_membership_id
       AND membership.status = 'active'
       AND membership.ended_at_ms IS NULL
       AND membership.permission_category =
         'commissioner'
      JOIN users AS commissioner
        ON commissioner.id = membership.user_id
       AND commissioner.status = 'active'
      WHERE league.id = @leagueId
      LIMIT 2
    `);
    currentScheduleStatement =
      database.prepare(`
        SELECT
          generation.schedule_operation_id,
          generation.schedule_version,
          generation.week_one_matchup_week_id,
          generation.week_one_starts_at_ms
        FROM season_matchup_schedule_generations
          AS generation
        JOIN matchup_operations AS operation
          ON operation.league_id =
            generation.league_id
         AND operation.season_id =
            generation.season_id
         AND operation.id =
            generation.schedule_operation_id
         AND operation.operation_type =
           'schedule_generate'
         AND operation.status = 'succeeded'
         AND operation.completed_at_ms IS NOT NULL
        JOIN matchup_weeks AS week_one
          ON week_one.league_id =
            generation.league_id
         AND week_one.season_id =
            generation.season_id
         AND week_one.id =
            generation.week_one_matchup_week_id
         AND week_one.sequence = 1
         AND week_one.starts_at_ms =
            generation.week_one_starts_at_ms
        WHERE generation.league_id = @leagueId
          AND generation.season_id = @seasonId
          AND generation.status = 'current'
        LIMIT 2
      `);
    activeParticipantsStatement =
      database.prepare(`
        SELECT
          team.id AS team_id,
          assignment.id AS assignment_id,
          assignment.user_id,
          assignment.membership_id
        FROM teams AS team
        JOIN team_manager_assignments AS assignment
          ON assignment.league_id = team.league_id
         AND assignment.team_id = team.id
         AND assignment.status = 'accepted'
         AND assignment.accepted_at_ms IS NOT NULL
         AND assignment.ended_at_ms IS NULL
        JOIN league_memberships AS membership
          ON membership.league_id =
            assignment.league_id
         AND membership.id =
            assignment.membership_id
         AND membership.user_id =
            assignment.user_id
         AND membership.status = 'active'
         AND membership.ended_at_ms IS NULL
        JOIN users AS manager
          ON manager.id = assignment.user_id
         AND manager.status = 'active'
        WHERE team.league_id = @leagueId
          AND team.status = 'active'
        ORDER BY team.id, assignment.id
      `);
    insertDraftStatement = database.prepare(`
      INSERT INTO free_agent_drafts (
        id,
        league_id,
        season_id,
        readiness_operation_id,
        readiness_occurrence_key,
        first_matchup_week_id,
        current_competition_first_matchup_week_id,
        schedule_recovery_id,
        participating_team_count,
        status,
        setup_path,
        entry_draft_id,
        setup_exemption_id,
        prior_season_rollover_id,
        no_draft_reason,
        opening_authority,
        opened_at_ms,
        help_opens_at_ms,
        candidate_deadline_at_ms,
        first_matchup_starts_at_ms,
        deadline_locked_at_ms,
        allocation_completed_at_ms,
        completed_at_ms,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        @fadId,
        @leagueId,
        @seasonId,
        @readinessOperationId,
        @occurrenceKey,
        @weekOneMatchupWeekId,
        @weekOneMatchupWeekId,
        NULL,
        @participatingTeamCount,
        'cards_open',
        @setupPath,
        @entryDraftId,
        @setupExemptionId,
        @priorSeasonRolloverId,
        @noDraftReason,
        'system',
        @openedAtMs,
        @helpOpensAtMs,
        @candidateDeadlineAtMs,
        @firstMatchupStartsAtMs,
        NULL,
        NULL,
        NULL,
        @openedAtMs,
        @openedAtMs,
        1
      )
    `);
    insertParticipantStatement =
      database.prepare(`
        INSERT INTO free_agent_draft_teams (
          id,
          league_id,
          season_id,
          fad_id,
          team_id,
          team_status_at_setup,
          created_at_ms
        ) VALUES (
          @participantId,
          @leagueId,
          @seasonId,
          @fadId,
          @teamId,
          'active',
          @openedAtMs
        )
      `);
    candidateCardCoverageStatement =
      database.prepare(`
        SELECT
          participant.id AS participant_id,
          participant.team_id,
          card.id AS card_id,
          card.status AS card_status,
          card.version AS card_version,
          card.created_at_ms AS card_created_at_ms,
          card.updated_at_ms AS card_updated_at_ms
        FROM free_agent_draft_teams
          AS participant
        LEFT JOIN candidate_cards AS card
          ON card.league_id =
            participant.league_id
         AND card.season_id =
            participant.season_id
         AND card.fad_id = participant.fad_id
         AND card.team_id = participant.team_id
        WHERE participant.league_id = @leagueId
          AND participant.season_id = @seasonId
          AND participant.fad_id = @fadId
        ORDER BY participant.team_id
      `);
    insertJobStatement = database.prepare(`
      INSERT INTO job_runs (
        id,
        league_id,
        season_id,
        job_type,
        occurrence_key,
        scheduled_for_ms,
        status,
        attempt_count,
        lease_owner,
        lease_expires_at_ms,
        started_at_ms,
        completed_at_ms,
        result_json,
        last_error_code,
        created_at_ms,
        updated_at_ms,
        version,
        lease_token,
        next_attempt_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @jobType,
        @occurrenceKey,
        @scheduledForMs,
        'pending',
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        @createdAtMs,
        @createdAtMs,
        1,
        NULL,
        NULL
      )
    `);
    insertRolloverStatement =
      database.prepare(`
        INSERT INTO free_agent_draft_rollovers (
          id,
          league_id,
          season_id,
          fad_id,
          sequence,
          window_kind,
          predecessor_rollover_id,
          extension_reason,
          extension_source_id,
          opens_at_ms,
          creation_cutoff_at_ms,
          rolls_over_at_ms,
          status,
          processing_job_run_id,
          processing_started_at_ms,
          completed_at_ms,
          last_error_code,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @id,
          @leagueId,
          @seasonId,
          @fadId,
          @sequence,
          'initial',
          @predecessorRolloverId,
          NULL,
          NULL,
          @opensAtMs,
          @creationCutoffAtMs,
          @rollsOverAtMs,
          'scheduled',
          NULL,
          NULL,
          NULL,
          NULL,
          @createdAtMs,
          @createdAtMs,
          1
        )
      `);
    insertActivityStatement =
      database.prepare(`
        INSERT INTO league_activity (
          id,
          league_id,
          season_id,
          event_type,
          actor_user_id,
          actor_authority,
          team_id,
          player_id,
          related_type,
          related_id,
          display_summary,
          reason,
          metadata_json,
          occurred_at_ms
        ) VALUES (
          @id,
          @leagueId,
          @seasonId,
          'free_agent_draft_started',
          NULL,
          'system',
          NULL,
          NULL,
          'free_agent_draft',
          @fadId,
          'Candidate Cards opened.',
          NULL,
          @metadataJson,
          @openedAtMs
        )
      `);
    insertOutboxStatement =
      database.prepare(`
        INSERT INTO outbox_events (
          id,
          league_id,
          event_type,
          aggregate_type,
          aggregate_id,
          payload_json,
          status,
          attempt_count,
          available_at_ms,
          published_at_ms,
          last_error_code,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @id,
          @leagueId,
          @eventType,
          @aggregateType,
          @aggregateId,
          @payloadJson,
          'pending',
          0,
          @openedAtMs,
          NULL,
          NULL,
          @openedAtMs,
          @openedAtMs,
          1
        )
      `);
    insertOutboxAudienceStatement =
      database.prepare(`
        INSERT INTO outbox_event_audiences (
          id,
          league_id,
          outbox_event_id,
          audience_kind,
          team_id,
          user_id,
          created_at_ms
        ) VALUES (
          @id,
          @leagueId,
          @outboxEventId,
          @audienceKind,
          @teamId,
          @userId,
          @openedAtMs
        )
      `);
    succeedReadinessStatement =
      database.prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET status = 'succeeded',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            blockers_json = '[]',
            matchup_schedule_version_before =
              @scheduleVersionBefore,
            matchup_schedule_version_after =
              @scheduleVersionAfter,
            schedule_recovery_id =
              @scheduleRecoveryId,
            created_fad_id = @fadId,
            reminder_job_run_id =
              @reminderJobRunId,
            deadline_job_run_id =
              @deadlineJobRunId,
            cards_opened_activity_id =
              @activityId,
            cards_opened_outbox_event_id =
              @outboxEventId,
            next_retry_at_ms = NULL,
            terminal_at_ms = @openedAtMs,
            updated_at_ms = @openedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @readinessOperationId
          AND readiness_occurrence_key =
            @occurrenceKey
          AND status = 'running'
          AND job_run_id = @jobRunId
          AND attempt_count = @attemptNumber
          AND version =
            @observedReadinessVersion
          AND lease_owner = @leaseOwner
          AND lease_token = @leaseToken
          AND lease_expires_at_ms =
            @leaseExpiresAtMs
          AND lease_expires_at_ms >
            @recordedAtMs
          AND started_at_ms = @startedAtMs
          AND blockers_json = '[]'
          AND matchup_schedule_version_before IS NULL
          AND matchup_schedule_version_after IS NULL
          AND schedule_recovery_id IS NULL
          AND created_fad_id IS NULL
          AND reminder_job_run_id IS NULL
          AND deadline_job_run_id IS NULL
          AND cards_opened_activity_id IS NULL
          AND cards_opened_outbox_event_id IS NULL
          AND next_retry_at_ms IS NULL
          AND terminal_at_ms IS NULL
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_readiness_attempts
              AS attempt
            WHERE attempt.league_id = @leagueId
              AND attempt.season_id = @seasonId
              AND attempt.id = @attemptId
              AND attempt.readiness_operation_id =
                @readinessOperationId
              AND attempt.job_run_id = @jobRunId
              AND attempt.attempt_number =
                @attemptNumber
              AND attempt.observed_readiness_version =
                @observedReadinessVersion
              AND attempt.outcome = 'succeeded'
              AND attempt.recorded_at_ms =
                @recordedAtMs
              AND attempt.projection_sha256 =
                @projectionSha256
          )
      `);
    succeedReadinessJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @recordedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @recordedAtMs,
          version = version + 1
      WHERE id = @jobRunId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND job_type =
          '${FREE_AGENT_DRAFT_READINESS_JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms =
          @readinessCreatedAtMs
        AND created_at_ms =
          @readinessCreatedAtMs
        AND status = 'running'
        AND attempt_count = @attemptNumber
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms =
          @leaseExpiresAtMs
        AND lease_expires_at_ms >
          @recordedAtMs
        AND started_at_ms = @startedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND updated_at_ms = @runningUpdatedAtMs
        AND version = @observedReadinessVersion
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_readiness_operations
            AS readiness
          WHERE readiness.league_id = @leagueId
            AND readiness.season_id = @seasonId
            AND readiness.id = @readinessOperationId
            AND readiness.job_run_id = @jobRunId
            AND readiness.readiness_occurrence_key =
              @occurrenceKey
            AND readiness.status = 'succeeded'
            AND readiness.attempt_count =
              @attemptNumber
            AND readiness.version = @terminalVersion
            AND readiness.created_fad_id = @fadId
            AND readiness.terminal_at_ms =
              @recordedAtMs
        )
    `);
    readinessOpeningEvidenceStatement =
      database.prepare(`
        SELECT
          (
            SELECT COUNT(*)
            FROM season_matchup_schedule_generations
              AS generation
            WHERE generation.league_id = @leagueId
              AND generation.season_id = @seasonId
              AND generation.schedule_version =
                @scheduleVersionBefore
              AND generation.week_one_matchup_week_id =
                @beforeWeekId
              AND generation.week_one_starts_at_ms =
                @beforeWeekStartsAtMs
          ) AS before_schedule_count,
          (
            SELECT COUNT(*)
            FROM season_matchup_schedule_generations
              AS generation
            WHERE generation.league_id = @leagueId
              AND generation.season_id = @seasonId
              AND generation.schedule_version =
                @scheduleVersionAfter
              AND generation.week_one_matchup_week_id =
                @afterWeekId
              AND generation.week_one_starts_at_ms =
                @afterWeekStartsAtMs
          ) AS after_schedule_count,
          (
            SELECT COUNT(*)
            FROM free_agent_draft_schedule_recoveries
              AS recovery
            WHERE recovery.league_id = @leagueId
              AND recovery.season_id = @seasonId
              AND recovery.fad_id = @fadId
              AND recovery.id = @scheduleRecoveryId
              AND recovery.recovery_kind = 'pre_open'
              AND recovery.old_schedule_version =
                @scheduleVersionBefore
              AND recovery.new_schedule_version =
                @scheduleVersionAfter
              AND recovery.old_first_matchup_week_id =
                @beforeWeekId
              AND recovery.new_first_matchup_week_id =
                @afterWeekId
              AND recovery.old_week_one_starts_at_ms =
                @beforeWeekStartsAtMs
              AND recovery.new_week_one_starts_at_ms =
                @afterWeekStartsAtMs
          ) AS recovery_count,
          (
            SELECT COUNT(*)
            FROM job_runs AS reminder
            WHERE reminder.league_id = @leagueId
              AND reminder.season_id = @seasonId
              AND reminder.id = @reminderJobRunId
              AND reminder.job_type =
                'fad_deadline_reminder'
              AND reminder.occurrence_key =
                @reminderOccurrenceKey
              AND reminder.scheduled_for_ms =
                @reminderAtMs
              AND reminder.created_at_ms = @openedAtMs
          ) AS reminder_job_count,
          (
            SELECT COUNT(*)
            FROM job_runs AS deadline
            WHERE deadline.league_id = @leagueId
              AND deadline.season_id = @seasonId
              AND deadline.id = @deadlineJobRunId
              AND deadline.job_type = 'fad_deadline'
              AND deadline.occurrence_key =
                @deadlineOccurrenceKey
              AND deadline.scheduled_for_ms =
                @candidateDeadlineAtMs
              AND deadline.created_at_ms = @openedAtMs
          ) AS deadline_job_count,
          (
            SELECT COUNT(*)
            FROM league_activity AS activity
            WHERE activity.league_id = @leagueId
              AND activity.season_id = @seasonId
              AND activity.id = @activityId
              AND activity.event_type =
                'free_agent_draft_started'
              AND activity.actor_user_id IS NULL
              AND activity.actor_authority = 'system'
              AND activity.related_type =
                'free_agent_draft'
              AND activity.related_id = @fadId
              AND activity.occurred_at_ms = @openedAtMs
          ) AS activity_count
      `);
    readinessOpeningPublicationStatement =
      database.prepare(`
        SELECT
          (
            SELECT COUNT(*)
            FROM outbox_events AS event
            WHERE event.league_id = @leagueId
              AND event.id = @eventId
              AND event.event_type = @eventType
              AND event.aggregate_type =
                @aggregateType
              AND event.aggregate_id = @aggregateId
              AND event.created_at_ms = @occurredAtMs
              AND event.payload_json = @payloadJson
          ) AS event_count,
          (
            SELECT COUNT(*)
            FROM outbox_event_audiences AS audience
            WHERE audience.league_id = @leagueId
              AND audience.outbox_event_id = @eventId
              AND audience.audience_kind =
                @audienceKind
              AND audience.team_id IS @teamId
              AND audience.user_id IS @userId
          ) AS expected_audience_count,
          (
            SELECT COUNT(*)
            FROM outbox_event_audiences AS audience
            WHERE audience.league_id = @leagueId
              AND audience.outbox_event_id = @eventId
          ) AS total_audience_count
      `);
    readinessOpeningNotificationsStatement =
      database.prepare(`
        SELECT
          id,
          user_id,
          message_data_json,
          deduplication_key
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_cards_opened'
          AND related_feature = 'free_agent_draft'
          AND related_record_id = @fadId
          AND created_at_ms = @openedAtMs
        ORDER BY id
      `);
    draftStatement = database.prepare(`
      SELECT *
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @fadId
      LIMIT 2
    `);
    participantsStatement = database.prepare(`
      SELECT
        id,
        team_id,
        created_at_ms
      FROM free_agent_draft_teams
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY team_id, id
    `);
    cardsStatement = database.prepare(`
      SELECT
        id,
        team_id,
        status,
        completeness_code,
        filled_mandatory_count,
        missing_mandatory_count,
        filled_bench_count,
        empty_bench_count,
        structural_conflict_count,
        carried_roster_structural_conflict_count,
        maximum_possible_cap_cents,
        version,
        created_at_ms,
        updated_at_ms
      FROM candidate_cards
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY team_id, id
    `);
    candidateCardOpeningEntryStatement =
      database.prepare(`
        SELECT
          id,
          card_id,
          team_id,
          entry_kind,
          player_id,
          effective_position_group,
          requested_slot_group,
          requested_slot_number,
          placement_state,
          conflict_code,
          carryover_ownership_id,
          carryover_contract_id,
          source_roster_category,
          carryover_original_total_value_cents,
          carryover_original_term_years,
          carryover_aav_cents,
          remaining_years,
          created_by_user_id,
          created_by_membership_id,
          created_by_authority,
          last_edited_by_user_id,
          last_edited_by_membership_id,
          last_edited_by_authority,
          created_at_ms,
          updated_at_ms,
          version
        FROM candidate_card_entries
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
        ORDER BY team_id, carryover_ownership_id, id
      `);
    candidateCardOpeningRevisionStatement =
      database.prepare(`
        SELECT
          id,
          card_id,
          team_id,
          resulting_card_version,
          action,
          affected_entry_id,
          player_id,
          actor_user_id,
          actor_membership_id,
          actor_authority,
          before_evidence_json,
          after_evidence_json,
          potential_illegality_acknowledged,
          warning_codes_json,
          occurred_at_ms,
          created_at_ms,
          version
        FROM candidate_card_revisions
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
        ORDER BY team_id, resulting_card_version, id
      `);
    candidateCardOpeningOwnershipStatement =
      database.prepare(`
        SELECT
          ownership.id AS ownership_id,
          ownership.team_id,
          ownership.player_id,
          ownership.roster_category,
          contract.id AS contract_id
        FROM player_ownerships AS ownership
        JOIN free_agent_draft_teams AS participant
          ON participant.league_id = ownership.league_id
         AND participant.season_id = ownership.season_id
         AND participant.fad_id = @fadId
         AND participant.team_id = ownership.team_id
        LEFT JOIN contracts AS contract
          ON contract.league_id = ownership.league_id
         AND contract.player_id = ownership.player_id
         AND contract.current_team_id = ownership.team_id
         AND contract.status = 'active'
         AND contract.contract_type IN (
           'normal',
           'fantasy_elc'
         )
        WHERE ownership.league_id = @leagueId
          AND ownership.season_id = @seasonId
          AND ownership.ownership_kind = 'Rostered'
          AND ownership.roster_category IN (
            'Active',
            'Bench',
            'Injured Reserve'
          )
        ORDER BY ownership.team_id, ownership.id
      `);
    rolloverStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_rollovers
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY sequence, id
    `);
    deadlineEvidenceStatement =
      database.prepare(`
        SELECT
          draft.participating_team_count,
          (
            SELECT COUNT(*)
            FROM free_agent_draft_teams
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
          ) AS participant_count,
          (
            SELECT COUNT(*)
            FROM candidate_cards
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
          ) AS card_count,
          (
            SELECT COUNT(*)
            FROM candidate_cards
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
              AND status IN (
                'locked_complete',
                'locked_incomplete',
                'locked_conflicted'
              )
              AND locked_at_ms =
                draft.candidate_deadline_at_ms
          ) AS locked_card_count,
          (
            SELECT COUNT(*)
            FROM candidate_card_snapshots
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
          ) AS snapshot_count,
          (
            SELECT COUNT(*)
            FROM candidate_card_snapshots AS snapshot
            JOIN candidate_cards AS card
              ON card.league_id =
                snapshot.league_id
             AND card.season_id =
                snapshot.season_id
             AND card.fad_id = snapshot.fad_id
             AND card.id = snapshot.card_id
             AND card.team_id =
                snapshot.team_id
             AND card.status =
                snapshot.locked_status
             AND card.version =
                snapshot.locked_card_version
             AND card.locked_at_ms =
                snapshot.effective_deadline_at_ms
            WHERE snapshot.league_id =
                draft.league_id
              AND snapshot.season_id =
                draft.season_id
              AND snapshot.fad_id = draft.id
              AND snapshot.effective_deadline_at_ms =
                draft.candidate_deadline_at_ms
          ) AS valid_snapshot_count,
          (
            SELECT COUNT(*)
            FROM candidate_card_snapshot_entries
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
              AND row_kind = 'slot'
          ) AS slot_snapshot_count,
          (
            SELECT COUNT(*)
            FROM candidate_card_help_requests
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
              AND status = 'active'
          ) AS active_help_count,
          (
            SELECT COUNT(DISTINCT player_id)
            FROM candidate_card_snapshot_entries
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
              AND occupant_kind = 'candidate'
              AND player_id IS NOT NULL
          ) AS candidate_player_count,
          (
            SELECT COUNT(*)
            FROM free_agent_draft_player_allocations
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
          ) AS allocation_count,
          (
            SELECT COUNT(*)
            FROM free_agent_draft_player_allocations
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND fad_id = draft.id
              AND status = 'pending'
          ) AS pending_allocation_count,
          (
            SELECT COUNT(*)
            FROM job_runs
            WHERE league_id = draft.league_id
              AND season_id = draft.season_id
              AND job_type = 'fad_deadline'
              AND occurrence_key =
                'fad:' || draft.id ||
                  ':deadline:' ||
                  draft.candidate_deadline_at_ms
              AND scheduled_for_ms =
                draft.candidate_deadline_at_ms
              AND status IN ('leased', 'running')
              AND attempt_count >= 1
              AND lease_owner IS NOT NULL
              AND lease_token IS NOT NULL
              AND lease_expires_at_ms >
                @occurredAtMs
              AND started_at_ms IS NOT NULL
              AND completed_at_ms IS NULL
          ) AS leased_deadline_job_count
        FROM free_agent_drafts AS draft
        WHERE draft.league_id = @leagueId
          AND draft.season_id = @seasonId
          AND draft.id = @fadId
        LIMIT 2
      `);
    transitionDeadlineStatement =
      database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'deadline_locked',
            deadline_locked_at_ms =
              @occurredAtMs,
            updated_at_ms = @occurredAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @fadId
          AND status = 'cards_open'
          AND version = @expectedVersion
          AND current_competition_first_matchup_week_id =
            @weekOneMatchupWeekId
      `);
    transitionAllocatingStatement =
      database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'allocating',
            updated_at_ms = @occurredAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @fadId
          AND status = 'deadline_locked'
          AND version = @expectedVersion
          AND current_competition_first_matchup_week_id =
            @weekOneMatchupWeekId
      `);
    transitionRapidStatement =
      database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'rapid',
            allocation_completed_at_ms =
              @occurredAtMs,
            updated_at_ms = @occurredAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @fadId
          AND status IN (
            'deadline_locked',
            'allocating'
          )
          AND status = @fromStatus
          AND version = @expectedVersion
          AND current_competition_first_matchup_week_id =
            @weekOneMatchupWeekId
      `);
    transitionCompletedStatement =
      database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'completed',
            current_competition_first_matchup_week_id =
              @weekOneMatchupWeekId,
            schedule_recovery_id =
              @scheduleRecoveryId,
            completed_at_ms = @occurredAtMs,
            updated_at_ms = @occurredAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @fadId
          AND status = 'rapid'
          AND version = @expectedVersion
      `);
  } catch (error) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "The SQLite schema does not support FAD lifecycle persistence.",
      { cause: error }
    );
  }

  function readReadiness(lookup) {
    return readinessRecord(
      uniqueRow(
        readinessByOccurrenceStatement,
        lookup,
        "FAD readiness occurrence"
      )
    );
  }

  function findReadinessByOccurrence(input) {
    const lookup =
      normalizeReadinessLookup(input);
    return readReadiness(lookup);
  }

  function readinessJobParameters(plan) {
    return {
      ...plan.job,
      jobRunId: plan.job.id,
      createdAtMs:
        plan.readiness.createdAtMs,
    };
  }

  function readinessAttemptParameters(command) {
    const attempt = command.attempt;
    return {
      id: attempt.id,
      attemptId: attempt.id,
      leagueId: attempt.leagueId,
      seasonId: attempt.seasonId,
      readinessOperationId:
        attempt.readinessOperationId,
      jobRunId: attempt.jobRunId,
      attemptNumber: attempt.attemptNumber,
      observedReadinessVersion:
        attempt.observedReadinessVersion,
      outcome: attempt.outcome,
      observedAtMs: attempt.observedAtMs,
      recordedAtMs: attempt.recordedAtMs,
      projectionJson: attempt.projectionJson,
      projectionSha256:
        attempt.projectionSha256,
      version: attempt.version,
    };
  }

  function readReadinessAttempt(command) {
    return readinessAttemptRecord(
      uniqueRow(
        readinessAttemptStatement,
        readinessAttemptParameters(command),
        "FAD readiness attempt"
      )
    );
  }

  function requireExactReadinessAttempt(command) {
    const persisted = readReadinessAttempt(command);
    if (
      !sameReadinessAttempt(
        persisted,
        command.attempt
      )
    ) {
      conflict(
        "The exact FAD readiness attempt evidence is unavailable or changed."
      );
    }
    return persisted;
  }

  function requireTerminalReadinessAttempt(
    readiness
  ) {
    const persisted = readinessAttemptRecord(
      uniqueRow(
        readinessAttemptByExecutionStatement,
        {
          leagueId: readiness.leagueId,
          seasonId: readiness.seasonId,
          readinessOperationId: readiness.id,
          jobRunId: readiness.jobRunId,
          attemptNumber: readiness.attemptCount,
        },
        "terminal FAD readiness attempt"
      )
    );
    if (!persisted) {
      conflict(
        "The terminal FAD readiness attempt evidence is unavailable."
      );
    }
    return persisted;
  }

  function insertExactReadinessAttempt(command) {
    if (readReadinessAttempt(command)) {
      conflict(
        "The FAD readiness attempt identifier is already in use."
      );
    }
    requireChanged(
      insertReadinessAttemptStatement.run(
        readinessAttemptParameters(command)
      ),
      "The FAD readiness attempt could not be persisted."
    );
    const persisted = readReadinessAttempt(command);
    if (
      !sameReadinessAttempt(
        persisted,
        command.attempt
      )
    ) {
      incompatible(
        "The persisted FAD readiness attempt changed during insertion."
      );
    }
    return persisted;
  }

  function readReadinessExecution(
    command,
    readinessOperationId =
      command.attempt.readinessOperationId
  ) {
    return uniqueRow(
      readinessExecutionStatement,
      {
        ...command,
        readinessOperationId,
      },
      "joined FAD readiness execution"
    );
  }

  function requireRunningReadinessExecution(
    readiness,
    command
  ) {
    const attempt = command.attempt;
    const job = command.jobExecution;
    const execution = readReadinessExecution(command);
    if (
      !execution ||
      readiness.id !==
        attempt.readinessOperationId ||
      readiness.jobRunId !== attempt.jobRunId ||
      attempt.jobRunId !== job.runId ||
      execution.readiness_id !== readiness.id ||
      execution.readiness_job_run_id !==
        attempt.jobRunId ||
      execution.job_id !== attempt.jobRunId ||
      execution.job_type !==
        FREE_AGENT_DRAFT_READINESS_JOB_TYPE ||
      execution.job_occurrence_key !==
        command.occurrenceKey ||
      execution.readiness_created_at_ms !==
        execution.job_scheduled_for_ms ||
      execution.job_created_at_ms !==
        execution.job_scheduled_for_ms ||
      execution.readiness_status !== "running" ||
      execution.job_status !== "running" ||
      execution.readiness_attempt_count !==
        attempt.attemptNumber ||
      execution.job_attempt_count !==
        attempt.attemptNumber ||
      execution.readiness_version !==
        attempt.observedReadinessVersion ||
      execution.job_version !==
        attempt.observedReadinessVersion ||
      job.expectedVersion !==
        attempt.observedReadinessVersion ||
      execution.readiness_lease_owner !==
        job.leaseOwner ||
      execution.job_lease_owner !==
        job.leaseOwner ||
      execution.readiness_lease_token !==
        job.leaseToken ||
      execution.job_lease_token !==
        job.leaseToken ||
      execution.readiness_lease_expires_at_ms !==
        job.leaseExpiresAtMs ||
      execution.job_lease_expires_at_ms !==
        job.leaseExpiresAtMs ||
      job.leaseExpiresAtMs <=
        attempt.recordedAtMs ||
      execution.readiness_started_at_ms === null ||
      execution.readiness_started_at_ms !==
        execution.job_started_at_ms ||
      execution.readiness_started_at_ms >
        attempt.observedAtMs ||
      execution.readiness_updated_at_ms !==
        execution.job_updated_at_ms ||
      execution.readiness_updated_at_ms >
        attempt.observedAtMs ||
      execution.readiness_blockers_json !== "[]" ||
      execution.readiness_schedule_version_before !==
        null ||
      execution.readiness_schedule_version_after !==
        null ||
      execution.readiness_schedule_recovery_id !==
        null ||
      execution.readiness_created_fad_id !== null ||
      execution.readiness_reminder_job_run_id !==
        null ||
      execution.readiness_deadline_job_run_id !==
        null ||
      execution.readiness_activity_id !== null ||
      execution.readiness_outbox_event_id !== null ||
      execution.readiness_next_retry_at_ms !== null ||
      execution.readiness_terminal_at_ms !== null ||
      execution.job_completed_at_ms !== null ||
      execution.job_result_json !== null ||
      execution.job_last_error_code !== null ||
      execution.job_next_attempt_at_ms !== null ||
      execution.season_version !==
        attempt.projection.observedSeasonVersion
    ) {
      conflict(
        "The exact synchronized live FAD readiness execution is unavailable or changed."
      );
    }
    return Object.freeze({
      ...readinessAttemptParameters(command),
      ...job,
      readinessCreatedAtMs:
        execution.readiness_created_at_ms,
      runningUpdatedAtMs:
        execution.readiness_updated_at_ms,
      startedAtMs:
        execution.readiness_started_at_ms,
      terminalVersion:
        attempt.observedReadinessVersion + 1,
    });
  }

  function requireOpeningPublication({
    leagueId,
    eventId,
    eventType,
    aggregateType,
    aggregateId,
    version,
    reasonCode,
    occurredAtMs,
    related,
    audienceKind,
    teamId = null,
    userId = null,
  }) {
    const publication = uniqueRow(
      readinessOpeningPublicationStatement,
      {
        leagueId,
        eventId,
        eventType,
        aggregateType,
        aggregateId,
        occurredAtMs,
        payloadJson: JSON.stringify(
          createSocketEventEnvelope({
            eventId,
            type: eventType,
            leagueId,
            resourceId: aggregateId,
            version,
            reasonCode,
            occurredAt: occurredAtMs,
            related,
          })
        ),
        audienceKind,
        teamId,
        userId,
      },
      "FAD opening publication"
    );
    if (
      !publication ||
      publication.event_count !== 1 ||
      publication.expected_audience_count !== 1 ||
      publication.total_audience_count !== 1
    ) {
      conflict(
        "The exact FAD opening publication is unavailable or changed."
      );
    }
  }

  function ensureBlockerNotificationPublication(
    notification,
    { allowCreate }
  ) {
    const eventId = blockerNotificationOutboxId(
      notification.id
    );
    let persisted = uniqueRow(
      blockerOutboxStatement,
      {
        leagueId: notification.league_id,
        eventId,
      },
      "FAD blocker notification publication"
    );
    if (!persisted && allowCreate) {
      assertSynchronous(
        outbox.write({
          id: eventId,
          leagueId: notification.league_id,
          eventType: "notification.created",
          aggregateType: "notification",
          aggregateId: notification.id,
          payload: createSocketEventEnvelope({
            eventId,
            type: "notification.created",
            leagueId: notification.league_id,
            resourceId: notification.id,
            version: notification.version,
            reasonCode: "notification_created",
            occurredAt: notification.created_at_ms,
            related: createEmptySocketRelated(),
          }),
          occurredAtMs: notification.created_at_ms,
          audiences: [
            {
              kind: "user",
              userId: notification.user_id,
            },
          ],
        }),
        "FAD blocker notification publication insertion"
      );
      persisted = uniqueRow(
        blockerOutboxStatement,
        {
          leagueId: notification.league_id,
          eventId,
        },
        "persisted FAD blocker notification publication"
      );
    }
    if (!persisted) {
      conflict(
        "The exact FAD blocker notification publication is unavailable or changed."
      );
    }
    requireOpeningPublication({
      leagueId: notification.league_id,
      eventId,
      eventType: "notification.created",
      aggregateType: "notification",
      aggregateId: notification.id,
      version: notification.version,
      reasonCode: "notification_created",
      occurredAtMs: notification.created_at_ms,
      related: createEmptySocketRelated(),
      audienceKind: "user",
      userId: notification.user_id,
    });
    return eventId;
  }

  function requireBlockedNotificationEvidence(
    command,
    attempt
  ) {
    const rows =
      blockerNotificationsByReadinessStatement.all({
        leagueId: command.leagueId,
        readinessOperationId:
          attempt.readinessOperationId,
        recordedAtMs: attempt.recordedAtMs,
      });
    if (rows.length < 1) {
      conflict(
        "The blocked FAD readiness has no protected notification evidence."
      );
    }
    for (const notification of rows) {
      const deduplicationKey =
        `fad-readiness:${command.seasonId}:` +
        `blocked:${attempt.readinessOperationId}:` +
        notification.user_id;
      requireCanonicalBlockerNotification(
        notification,
        {
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          readinessOperationId:
            attempt.readinessOperationId,
          userId: notification.user_id,
          deduplicationKey,
        }
      );
      ensureBlockerNotificationPublication(
        notification,
        { allowCreate: false }
      );
    }
  }

  function requireSucceededOpeningEvidence({
    command,
    attempt,
    execution,
    durable,
    enforceCommandEvidence,
  }) {
    const beforeWeek =
      attempt.projection.firstMatchupWeekBefore;
    const afterWeek =
      attempt.projection.firstMatchupWeekAfter;
    const projectedTeamIds =
      attempt.projection.teamProjections.map(
        ({ teamId }) => teamId
      );
    const durableTeamIds = durable.participants
      .map(({ teamId }) => teamId)
      .sort(compareText);
    const priorRollover =
      attempt.projection.priorSeasonRollover;
    const scheduleRecoveryId =
      execution.readiness_schedule_recovery_id;
    if (
      !beforeWeek ||
      !afterWeek ||
      durable.draft.readinessOperationId !==
        attempt.readinessOperationId ||
      durable.draft.readinessOccurrenceKey !==
        command.occurrenceKey ||
      durable.draft.openedAtMs !==
        attempt.recordedAtMs ||
      durable.draft.helpOpensAtMs !==
        attempt.projection.helpOpensAtMs ||
      durable.draft.candidateDeadlineAtMs !==
        attempt.projection.candidateDeadlineAtMs ||
      durable.draft.firstMatchupWeekId !==
        afterWeek.weekId ||
      durable.draft.firstMatchupStartsAtMs !==
        afterWeek.startsAtMs ||
      durable.draft.participatingTeamCount !==
        attempt.projection.participatingTeamCount ||
      durable.participants.length !==
        durable.draft.participatingTeamCount ||
      durable.cards.length !==
        durable.draft.participatingTeamCount ||
      durable.rollovers.length !==
        FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT ||
      JSON.stringify(projectedTeamIds) !==
        JSON.stringify(durableTeamIds) ||
      (
        durable.draft.priorSeasonRolloverId === null
          ? priorRollover !== null
          : priorRollover?.rolloverId !==
            durable.draft.priorSeasonRolloverId
      ) ||
      execution.readiness_schedule_version_before !==
        beforeWeek.version ||
      execution.readiness_schedule_version_after !==
        afterWeek.version ||
      execution.readiness_reminder_job_run_id === null ||
      execution.readiness_deadline_job_run_id === null ||
      execution.readiness_activity_id === null ||
      execution.readiness_outbox_event_id === null ||
      (
        scheduleRecoveryId === null &&
        beforeWeek.version !== afterWeek.version
      )
    ) {
      conflict(
        "The succeeded FAD readiness opening evidence is incomplete or changed."
      );
    }
    if (
      enforceCommandEvidence &&
      (
        execution.readiness_schedule_version_before !==
          command.schedule.version ||
        execution.readiness_schedule_version_after !==
          command.targetSchedule.version ||
        scheduleRecoveryId !==
          (command.scheduleRecoveryPlan?.recovery.id ??
            null) ||
        execution.readiness_reminder_job_run_id !==
          command.evidence.reminderJobRunId ||
        execution.readiness_deadline_job_run_id !==
          command.evidence.deadlineJobRunId ||
        execution.readiness_activity_id !==
          command.evidence.activityId ||
        execution.readiness_outbox_event_id !==
          command.evidence.outboxEventId
      )
    ) {
      conflict(
        "The terminal FAD readiness opening evidence does not match its command."
      );
    }
    const evidence = uniqueRow(
      readinessOpeningEvidenceStatement,
      {
        leagueId: durable.draft.leagueId,
        seasonId: durable.draft.seasonId,
        fadId: durable.draft.id,
        scheduleVersionBefore:
          beforeWeek.version,
        scheduleVersionAfter: afterWeek.version,
        beforeWeekId: beforeWeek.weekId,
        beforeWeekStartsAtMs:
          beforeWeek.startsAtMs,
        afterWeekId: afterWeek.weekId,
        afterWeekStartsAtMs:
          afterWeek.startsAtMs,
        scheduleRecoveryId,
        reminderJobRunId:
          execution.readiness_reminder_job_run_id,
        deadlineJobRunId:
          execution.readiness_deadline_job_run_id,
        reminderAtMs:
          attempt.projection.reminderAtMs,
        reminderOccurrenceKey:
          buildFreeAgentDraftReminderOccurrenceKey({
            fadId: durable.draft.id,
            reminderAtMs:
              attempt.projection.reminderAtMs,
          }),
        candidateDeadlineAtMs:
          attempt.projection.candidateDeadlineAtMs,
        deadlineOccurrenceKey:
          buildFreeAgentDraftDeadlineOccurrenceKey({
            fadId: durable.draft.id,
            deadlineAtMs:
              attempt.projection.candidateDeadlineAtMs,
          }),
        openedAtMs: attempt.recordedAtMs,
        activityId:
          execution.readiness_activity_id,
      },
      "durable FAD readiness opening evidence"
    );
    if (
      !evidence ||
      evidence.before_schedule_count !== 1 ||
      evidence.after_schedule_count !== 1 ||
      evidence.recovery_count !==
        (scheduleRecoveryId === null ? 0 : 1) ||
      evidence.reminder_job_count !== 1 ||
      evidence.deadline_job_count !== 1 ||
      evidence.activity_count !== 1
    ) {
      conflict(
        "The durable FAD opening dependencies are unavailable or changed."
      );
    }

    const cardsByTeamId = new Map(
      durable.cards.map((card) => [card.teamId, card])
    );
    if (
      cardsByTeamId.size !== durable.cards.length ||
      durableTeamIds.some(
        (teamId) => !cardsByTeamId.has(teamId)
      )
    ) {
      conflict(
        "The Candidate Card opening publication coverage is incomplete or ambiguous."
      );
    }
    const openingNotifications =
      readinessOpeningNotificationsStatement.all({
        leagueId: durable.draft.leagueId,
        fadId: durable.draft.id,
        openedAtMs: attempt.recordedAtMs,
      });
    const notificationByTeamId = new Map();
    for (const notification of openingNotifications) {
      let messageData;
      try {
        messageData = JSON.parse(
          notification.message_data_json
        );
      } catch {
        conflict(
          "The cards-opened notification evidence is malformed."
        );
      }
      const card = cardsByTeamId.get(messageData?.teamId);
      const expectedMessageData = card
        ? {
            leagueId: durable.draft.leagueId,
            seasonId: durable.draft.seasonId,
            fadId: durable.draft.id,
            teamId: card.teamId,
            cardId: card.id,
            candidateDeadlineAtMs:
              durable.draft.candidateDeadlineAtMs,
            destination: {
              kind: "private_card",
              leagueId: durable.draft.leagueId,
              fadId: durable.draft.id,
              teamId: card.teamId,
              cardId: card.id,
            },
          }
        : null;
      if (
        !expectedMessageData ||
        typeof notification.user_id !== "string" ||
        notification.user_id.length === 0 ||
        !isDeepStrictEqual(
          messageData,
          expectedMessageData
        ) ||
        notification.deduplication_key !==
          `fad:${durable.draft.id}:cards-opened:` +
            `${card.teamId}:${notification.user_id}` ||
        notificationByTeamId.has(card.teamId)
      ) {
        conflict(
          "The cards-opened notification evidence is incomplete or changed."
        );
      }
      notificationByTeamId.set(
        card.teamId,
        notification
      );
    }
    if (
      openingNotifications.length !==
        durable.draft.participatingTeamCount ||
      notificationByTeamId.size !==
        durable.draft.participatingTeamCount
    ) {
      conflict(
        "The cards-opened notification audience coverage is incomplete or ambiguous."
      );
    }

    const openingPublications = openingPublicationIds({
      rootOutboxEventId:
        execution.readiness_outbox_event_id,
      activityId: execution.readiness_activity_id,
      participants: durableTeamIds.map((teamId) => ({
        cardId: cardsByTeamId.get(teamId).id,
        notificationId:
          notificationByTeamId.get(teamId).id,
      })),
    });
    requireOpeningPublication({
      leagueId: durable.draft.leagueId,
      eventId: execution.readiness_outbox_event_id,
      eventType: "free_agent_draft.changed",
      aggregateType: "free_agent_draft",
      aggregateId: durable.draft.id,
      version: durable.draft.version,
      reasonCode: "cards_opened",
      occurredAtMs: attempt.recordedAtMs,
      related: createEmptySocketRelated({
        fadId: durable.draft.id,
      }),
      audienceKind: "league",
    });
    requireOpeningPublication({
      leagueId: durable.draft.leagueId,
      eventId: openingPublications.activityOutboxEventId,
      eventType: "activity.created",
      aggregateType: "league_activity",
      aggregateId: execution.readiness_activity_id,
      version: 1,
      reasonCode: "cards_opened",
      occurredAtMs: attempt.recordedAtMs,
      related: createEmptySocketRelated({
        fadId: durable.draft.id,
      }),
      audienceKind: "league",
    });
    for (
      let index = 0;
      index < durableTeamIds.length;
      index += 1
    ) {
      const teamId = durableTeamIds[index];
      const card = cardsByTeamId.get(teamId);
      const notification =
        notificationByTeamId.get(teamId);
      const publicationIds =
        openingPublications
          .participantOutboxEventIds[index];
      const related = createEmptySocketRelated({
        fadId: durable.draft.id,
        teamId,
        cardId: card.id,
      });
      requireOpeningPublication({
        leagueId: durable.draft.leagueId,
        eventId: publicationIds.cardOutboxEventId,
        eventType: "candidate_card.changed",
        aggregateType: "candidate_card",
        aggregateId: card.id,
        version: card.version,
        reasonCode: "card_changed",
        occurredAtMs: attempt.recordedAtMs,
        related,
        audienceKind: "team",
        teamId,
      });
      requireOpeningPublication({
        leagueId: durable.draft.leagueId,
        eventId:
          publicationIds.notificationOutboxEventId,
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: notification.id,
        version: 1,
        reasonCode: "cards_opened",
        occurredAtMs: attempt.recordedAtMs,
        related,
        audienceKind: "user",
        userId: notification.user_id,
      });
    }
  }

  function requireTerminalReadinessExecution(
    command,
    {
      outcome,
      durable = null,
      readiness = null,
      allowGeneratedEvidence = false,
      enforceCommandEvidence = true,
    }
  ) {
    const attempt = allowGeneratedEvidence
      ? requireTerminalReadinessAttempt(readiness)
      : requireExactReadinessAttempt(command);
    const execution = readReadinessExecution(
      command,
      attempt.readinessOperationId
    );
    const terminalVersion =
      attempt.observedReadinessVersion + 1;
    const commonInvalid =
      !execution ||
      execution.readiness_id !==
        attempt.readinessOperationId ||
      execution.readiness_job_run_id !==
        attempt.jobRunId ||
      execution.job_id !== attempt.jobRunId ||
      execution.job_type !==
        FREE_AGENT_DRAFT_READINESS_JOB_TYPE ||
      execution.job_occurrence_key !==
        command.occurrenceKey ||
      execution.readiness_created_at_ms !==
        execution.job_scheduled_for_ms ||
      execution.job_created_at_ms !==
        execution.job_scheduled_for_ms ||
      execution.readiness_attempt_count !==
        attempt.attemptNumber ||
      execution.job_attempt_count !==
        attempt.attemptNumber ||
      execution.readiness_version !== terminalVersion ||
      execution.job_version !== terminalVersion ||
      execution.readiness_lease_owner !== null ||
      execution.readiness_lease_token !== null ||
      execution.readiness_lease_expires_at_ms !== null ||
      execution.job_lease_owner !== null ||
      execution.job_lease_token !== null ||
      execution.job_lease_expires_at_ms !== null ||
      execution.readiness_started_at_ms === null ||
      execution.readiness_started_at_ms !==
        execution.job_started_at_ms ||
      execution.readiness_started_at_ms >
        attempt.observedAtMs ||
      execution.readiness_terminal_at_ms !==
        attempt.recordedAtMs ||
      execution.readiness_updated_at_ms !==
        attempt.recordedAtMs ||
      execution.job_completed_at_ms !==
        attempt.recordedAtMs ||
      execution.job_updated_at_ms !==
        attempt.recordedAtMs;
    if (commonInvalid) {
      conflict(
        "The exact terminal FAD readiness execution is unavailable or changed."
      );
    }
    if (
      outcome === "blocked" &&
      (
        attempt.outcome !== "blocked" ||
        execution.readiness_status !== "blocked" ||
        execution.job_status !== "failed" ||
        execution.readiness_blockers_json !==
          command.blockersJson ||
        execution.readiness_schedule_version_before !==
          null ||
        execution.readiness_schedule_version_after !==
          null ||
        execution.readiness_schedule_recovery_id !==
          null ||
        execution.readiness_created_fad_id !== null ||
        execution.readiness_reminder_job_run_id !==
          null ||
        execution.readiness_deadline_job_run_id !==
          null ||
        execution.readiness_activity_id !== null ||
        execution.readiness_outbox_event_id !== null ||
        execution.readiness_next_retry_at_ms !==
          command.nextRetryAtMs ||
        execution.job_result_json !== null ||
        execution.job_last_error_code !==
          "FAD_READINESS_BLOCKED" ||
        execution.job_next_attempt_at_ms !==
          command.nextRetryAtMs
      )
    ) {
      conflict(
        "The blocked FAD readiness execution does not match its attempt."
      );
    }
    if (outcome === "blocked") {
      requireBlockedNotificationEvidence(
        command,
        attempt
      );
    }
    if (outcome === "succeeded") {
      const resultJson = durable
        ? serializeCanonicalJsonV1({
            fadId: durable.draft.id,
            readinessAttemptId: attempt.id,
            readinessOperationId:
              attempt.readinessOperationId,
          })
        : null;
      if (
        attempt.outcome !== "succeeded" ||
        !durable ||
        execution.readiness_status !== "succeeded" ||
        execution.job_status !== "succeeded" ||
        execution.readiness_blockers_json !== "[]" ||
        execution.readiness_created_fad_id !==
          durable.draft.id ||
        execution.readiness_next_retry_at_ms !== null ||
        execution.job_result_json !== resultJson ||
        execution.job_last_error_code !== null ||
        execution.job_next_attempt_at_ms !== null
      ) {
        conflict(
          "The succeeded FAD readiness execution does not match its attempt."
        );
      }
      requireSucceededOpeningEvidence({
        command,
        attempt,
        execution,
        durable,
        enforceCommandEvidence,
      });
    }
    return execution;
  }

  const ensureReadinessTransaction =
    database.transaction((plan) => {
      const identity = plan.readiness;
      const job = readinessJobParameters(plan);
      const existing = readReadiness(identity);
      if (existing) {
        if (
          existing.triggerKind !==
            identity.triggerKind ||
          existing.entryDraftId !==
            identity.entryDraftId ||
          existing.setupExemptionId !==
            identity.setupExemptionId ||
          existing.jobRunId !==
            identity.jobRunId ||
          existing.createdAtMs !==
            identity.createdAtMs ||
          !uniqueRow(
            readinessJobByIdentityStatement,
            job,
            "bound FAD readiness job"
          )
        ) {
          conflict(
            "The FAD readiness occurrence is already bound to different evidence."
          );
        }
        return Object.freeze({
          replayed: true,
          readiness: existing,
        });
      }
      const seasonExisting = readinessRecord(
        uniqueRow(
          readinessBySeasonStatement,
          identity,
          "league-season FAD readiness operation"
        )
      );
      if (seasonExisting) {
        conflict(
          "The league season already has a different FAD readiness occurrence."
        );
      }
      insertReadinessJobStatement.run(job);
      if (
        !uniqueRow(
          readinessJobStatement,
          job,
          "fresh pending FAD readiness job"
        )
      ) {
        incompatible(
          "The created FAD readiness job is unavailable or noncanonical."
        );
      }
      insertReadinessStatement.run(identity);
      const created = readReadiness(identity);
      if (!created) {
        incompatible(
          "The created FAD readiness operation is unavailable."
        );
      }
      return Object.freeze({
        replayed: false,
        readiness: created,
      });
    });

  function ensureReadinessOperation(input) {
    const plan =
      normalizeReadinessIdentity(input);
    try {
      return ensureReadinessTransaction.immediate(
        plan
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "ensureFadReadiness",
        tableName:
          "free_agent_draft_readiness_operations",
      });
    }
  }

  const blockReadinessTransaction =
    database.transaction((command) => {
      const existing = readReadiness(command);
      if (!existing) {
        notFound(
          "The scoped FAD readiness operation was not found."
        );
      }
      if (existing.status === "succeeded") {
        conflict(
          "A succeeded FAD readiness operation cannot be blocked."
        );
      }
      if (existing.status === "blocked") {
        requireTerminalReadinessExecution(
          command,
          { outcome: "blocked" }
        );
        return Object.freeze({
          replayed: true,
          readiness: existing,
        });
      }
      if (
        existing.version !==
        command.expectedVersion
      ) {
        conflict(
          "The FAD readiness version changed."
        );
      }
      const execution =
        requireRunningReadinessExecution(
          existing,
          command
        );
      const commissioner = uniqueRow(
        commissionerStatement,
        command,
        "current league commissioner"
      );
      if (!commissioner) {
        conflict(
          "A current commissioner is required to receive FAD blockers."
        );
      }
      insertExactReadinessAttempt(command);
      requireChanged(
        blockReadinessStatement.run({
          ...command,
          ...execution,
        }),
        "The running FAD readiness operation changed before blocker persistence."
      );
      const errorCodes = [
        ...new Set(
          command.blockers.map(
            (blocker) => blocker.code
          )
        ),
      ];
      const notificationContract =
        createFreeAgentDraftNotificationContract({
          type: "fad_readiness_blocked",
          recipientUserId:
            commissioner.user_id,
          messageData: {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            readinessOperationId: existing.id,
            errorCodes,
            destination: {
              kind: "commissioner_fad",
              leagueId: command.leagueId,
              seasonId: command.seasonId,
            },
          },
        });
      const messageDataJson = JSON.stringify(
        notificationContract.messageData
      );
      const deduplicationKey =
        notificationContract.deduplicationKey;
      const notificationLookup = {
        userId: commissioner.user_id,
        deduplicationKey,
      };
      let notification = uniqueRow(
        blockerNotificationStatement,
        notificationLookup,
        "FAD readiness blocker notification"
      );
      if (notification) {
        requireCanonicalBlockerNotification(
          notification,
          {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            readinessOperationId: existing.id,
            userId: commissioner.user_id,
            deduplicationKey,
          }
        );
      }
      if (!notification) {
        assertSynchronous(
          notifications.insert({
            id: command.notificationId,
            userId:
              notificationContract.recipientUserId,
            leagueId: command.leagueId,
            eventType:
              notificationContract.type,
            messageDataJson,
            relatedFeature: "free_agent_draft",
            relatedRecordId: existing.id,
            deliveryStatus: "pending",
            createdAtMs: command.blockedAtMs,
            deliveredAtMs: null,
            deduplicationKey,
          }),
          "FAD blocker notification insertion"
        );
        notification = uniqueRow(
          blockerNotificationStatement,
          notificationLookup,
          "persisted FAD readiness blocker notification"
        );
        if (
          !notification ||
          notification.id !==
            command.notificationId
        ) {
          incompatible(
            "The FAD readiness blocker notification was not persisted canonically."
          );
        }
        requireCanonicalBlockerNotification(
          notification,
          {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            readinessOperationId: existing.id,
            userId: commissioner.user_id,
            deduplicationKey,
          }
        );
      }
      ensureBlockerNotificationPublication(
        notification,
        { allowCreate: true }
      );
      requireChanged(
        failReadinessJobStatement.run({
          ...command,
          ...execution,
        }),
        "The running FAD readiness job changed before blocker completion."
      );
      const blocked = readReadiness(command);
      if (
        !blocked ||
        blocked.status !== "blocked"
      ) {
        incompatible(
          "The blocked FAD readiness operation is unavailable."
        );
      }
      requireTerminalReadinessExecution(
        command,
        { outcome: "blocked" }
      );
      if (beforeCommit) {
        assertSynchronous(
          beforeCommit(
            "blockReadinessOperation",
            blocked
          ),
          "FAD blocker beforeCommit"
        );
      }
      return Object.freeze({
        replayed: false,
        readiness: blocked,
      });
    });

  function blockReadinessOperation(input) {
    const command = normalizeBlockCommand(input);
    try {
      return blockReadinessTransaction.immediate(
        command
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "blockFadReadiness",
        tableName:
          "free_agent_draft_readiness_operations",
      });
    }
  }

  function requireCurrentSchedule(
    command,
    { afterWriter = false } = {}
  ) {
    const current = uniqueRow(
      currentScheduleStatement,
      command,
      "current matchup schedule generation"
    );
    const expected = command.schedule;
    if (
      !current ||
      current.schedule_operation_id !==
        expected.operationId ||
      current.schedule_version !==
        expected.version ||
      current.week_one_matchup_week_id !==
        expected.weekOneMatchupWeekId ||
      current.week_one_starts_at_ms !==
        expected.weekOneStartsAtMs
    ) {
      conflict(
        afterWriter
          ? "The current schedule generation changed during the FAD transaction."
          : "The FAD command is bound to a stale schedule generation."
      );
    }
    return Object.freeze({
      operationId:
        current.schedule_operation_id,
      version: current.schedule_version,
      weekOneMatchupWeekId:
        current.week_one_matchup_week_id,
      weekOneStartsAtMs:
        current.week_one_starts_at_ms,
    });
  }

  function revalidateOpeningReadiness(command) {
    const context =
      openingReader.readOpeningPreflightContext({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
      });
    assertSynchronous(
      context,
      "FAD transaction-bound opening context read"
    );
    const inspection =
      inspectFreeAgentDraftOpeningReadiness({
        context,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        occurrenceKey: command.occurrenceKey,
        observedAtMs:
          command.attempt.observedAtMs,
      });
    if (!inspection.readyForSchedulePlanning) {
      const blocked =
        finalizeFreeAgentDraftOpeningReadiness({
          inspection,
          openedAtMs: null,
          targetSchedule: null,
        });
      return Object.freeze({
        outcome: "blocked",
        observedAtMs:
          command.attempt.observedAtMs,
        internalBlockers:
          blocked.internalBlockers,
        attemptProjection:
          blocked.attemptProjection,
      });
    }
    requireCurrentSchedule(command);
    const finalized =
      finalizeFreeAgentDraftOpeningReadiness({
        inspection,
        openedAtMs: command.openedAtMs,
        targetSchedule: command.targetSchedule,
      });
    const opening = finalized.opening;
    const currentSchedule = opening
      ? Object.freeze({
          operationId:
            opening.currentSchedule.operationId,
          version:
            opening.currentSchedule.version,
          weekOneMatchupWeekId:
            opening.currentSchedule
              .weekOneMatchupWeekId,
          weekOneStartsAtMs:
            opening.currentSchedule
              .weekOneStartsAtMs,
        })
      : null;
    const expectedSetup = Object.freeze({
      setupPath: command.setupPath,
      entryDraftId: command.entryDraftId,
      setupExemptionId:
        command.setupExemptionId,
      priorSeasonRolloverId:
        command.priorSeasonRolloverId,
      noDraftReason: command.noDraftReason,
    });
    if (
      finalized.outcome !== "succeeded" ||
      opening === null ||
      !isDeepStrictEqual(
        finalized.attemptProjection,
        command.attempt.projection
      ) ||
      !isDeepStrictEqual(
        opening.setup,
        expectedSetup
      ) ||
      !isDeepStrictEqual(
        currentSchedule,
        command.schedule
      ) ||
      !isDeepStrictEqual(
        opening.targetSchedule,
        command.targetSchedule
      ) ||
      opening.scheduleRecoveryRequired !==
        (command.scheduleRecoveryPlan !== null) ||
      !isDeepStrictEqual(
        opening.clock,
        command.clock
      ) ||
      !isDeepStrictEqual(
        opening.carryoverProjection,
        command.carryoverProjection
      )
    ) {
      conflict(
        "The complete FAD readiness projection changed before opening."
      );
    }
    return Object.freeze({
      outcome: "succeeded",
    });
  }

  function requireExactCandidateCardOpening({
    leagueId,
    seasonId,
    fadId,
    openedAtMs,
    candidateDeadlineAtMs,
    expectedParticipants = null,
    expectedCarryoverProjection = null,
    writerResult = null,
    requireOpeningOnly = false,
  }) {
    const scope = {
      leagueId,
      seasonId,
      fadId,
    };
    const coverage =
      candidateCardCoverageStatement.all(scope);
    const cards = cardsStatement.all(scope);
    const entries =
      candidateCardOpeningEntryStatement.all(
        scope
      );
    const revisions =
      candidateCardOpeningRevisionStatement.all(
        scope
      );
    const ownerships =
      candidateCardOpeningOwnershipStatement.all(
        scope
      );
    if (
      coverage.length < 1 ||
      cards.length !== coverage.length ||
      coverage.some((row) => row.card_id === null)
    ) {
      incompatible(
        "Candidate Card opening did not create one exact card per frozen participant."
      );
    }

    const participantIds = new Set();
    const participantTeamIds = new Set();
    const cardIds = new Set();
    for (
      let index = 0;
      index < coverage.length;
      index += 1
    ) {
      const row = coverage[index];
      if (
        participantIds.has(row.participant_id) ||
        participantTeamIds.has(row.team_id) ||
        cardIds.has(row.card_id)
      ) {
        incompatible(
          "Candidate Card opening participant or card coverage is ambiguous."
        );
      }
      participantIds.add(row.participant_id);
      participantTeamIds.add(row.team_id);
      cardIds.add(row.card_id);
      if (
        requireOpeningOnly &&
        (
          row.card_status !== "open" ||
          row.card_version !== 1 ||
          row.card_created_at_ms !== openedAtMs ||
          row.card_updated_at_ms !== openedAtMs
        )
      ) {
        incompatible(
          "Candidate Card opening did not preserve the exact version-one card state."
        );
      }
      if (expectedParticipants !== null) {
        const expected =
          expectedParticipants[index];
        if (
          !expected ||
          row.team_id !== expected.teamId ||
          row.participant_id !==
            expected.participantId ||
          row.card_id !== expected.cardId
        ) {
          incompatible(
            "Candidate Card opening identifiers do not match the frozen participant plan."
          );
        }
      }
    }
    if (
      expectedParticipants !== null &&
      expectedParticipants.length !==
        coverage.length
    ) {
      incompatible(
        "Candidate Card opening did not cover the complete frozen participant plan."
      );
    }

    const openingRevisions = revisions.filter(
      (revision) =>
        revision.action === "card_opened" &&
        revision.resulting_card_version === 1
    );
    if (
      openingRevisions.length !==
        coverage.length ||
      (
        requireOpeningOnly &&
        revisions.length !== coverage.length
      )
    ) {
      incompatible(
        "Candidate Card opening requires one exact version-one opening revision per participant."
      );
    }
    const openingRevisionCards = new Set();
    const coverageByCardId = new Map(
      coverage.map((row) => [row.card_id, row])
    );
    const expectedByTeamId = new Map(
      (expectedParticipants ?? []).map(
        (participant) => [
          participant.teamId,
          participant,
        ]
      )
    );
    for (const revision of openingRevisions) {
      const covered = coverageByCardId.get(
        revision.card_id
      );
      const expected = expectedByTeamId.get(
        revision.team_id
      );
      let afterEvidence;
      try {
        afterEvidence = JSON.parse(
          revision.after_evidence_json
        );
      } catch {
        incompatible(
          "Candidate Card opening revision evidence is invalid."
        );
      }
      if (
        !covered ||
        openingRevisionCards.has(
          revision.card_id
        ) ||
        revision.team_id !== covered.team_id ||
        revision.version !== 1 ||
        revision.affected_entry_id !== null ||
        revision.player_id !== null ||
        revision.actor_user_id !== null ||
        revision.actor_membership_id !== null ||
        revision.actor_authority !== "system" ||
        revision.before_evidence_json !==
          '{"card":null}' ||
        revision.potential_illegality_acknowledged !==
          0 ||
        revision.warning_codes_json !== "[]" ||
        revision.occurred_at_ms !== openedAtMs ||
        revision.created_at_ms !== openedAtMs ||
        !isPlainObject(afterEvidence) ||
        !isPlainObject(afterEvidence.card) ||
        !isPlainObject(afterEvidence.opening) ||
        afterEvidence.card.cardId !==
          covered.card_id ||
        afterEvidence.card.teamId !==
          covered.team_id ||
        afterEvidence.card.version !== 1 ||
        afterEvidence.opening.leagueId !== leagueId ||
        afterEvidence.opening.seasonId !== seasonId ||
        afterEvidence.opening.fadId !== fadId ||
        afterEvidence.opening.participantId !==
          covered.participant_id ||
        (
          expectedParticipants !== null &&
          (
            !expected ||
            afterEvidence.opening.openedAtMs !==
              openedAtMs ||
            afterEvidence.opening
              .candidateDeadlineAtMs !==
              candidateDeadlineAtMs ||
            afterEvidence.opening.notificationId !==
              expected.notificationId ||
            afterEvidence.opening.managerUserId !==
              expected.managerUserId ||
            afterEvidence.opening
              .managerMembershipId !==
              expected.managerMembershipId ||
            afterEvidence.opening
              .managerAssignmentId !==
              expected.managerAssignmentId
          )
        )
      ) {
        incompatible(
          "Candidate Card opening revision does not match its card and frozen participant."
        );
      }
      openingRevisionCards.add(revision.card_id);
    }

    const carryoverEntries = entries.filter(
      (entry) => entry.entry_kind === "carryover"
    );
    if (
      carryoverEntries.length !==
        ownerships.length ||
      (
        requireOpeningOnly &&
        entries.length !== ownerships.length
      )
    ) {
      incompatible(
        "Candidate Card opening did not preserve exact authoritative carryover coverage."
      );
    }
    const entryByOwnershipId = new Map();
    for (const entry of carryoverEntries) {
      if (
        entry.carryover_ownership_id === null ||
        entryByOwnershipId.has(
          entry.carryover_ownership_id
        )
      ) {
        incompatible(
          "Candidate Card opening carryover coverage is ambiguous."
        );
      }
      entryByOwnershipId.set(
        entry.carryover_ownership_id,
        entry
      );
    }
    const cardByTeamId = new Map(
      coverage.map((row) => [row.team_id, row])
    );
    for (const ownership of ownerships) {
      const entry = entryByOwnershipId.get(
        ownership.ownership_id
      );
      const card = cardByTeamId.get(
        ownership.team_id
      );
      if (
        ownership.contract_id === null ||
        !entry ||
        !card ||
        entry.card_id !== card.card_id ||
        entry.team_id !== ownership.team_id ||
        entry.player_id !== ownership.player_id ||
        entry.carryover_contract_id !==
          ownership.contract_id ||
        entry.source_roster_category !==
          ownership.roster_category ||
        (
          requireOpeningOnly &&
          (
            entry.created_by_user_id !== null ||
            entry.created_by_membership_id !== null ||
            entry.created_by_authority !== "system" ||
            entry.last_edited_by_user_id !== null ||
            entry.last_edited_by_membership_id !== null ||
            entry.last_edited_by_authority !== "system" ||
            entry.created_at_ms !== openedAtMs ||
            entry.updated_at_ms !== openedAtMs ||
            entry.version !== 1
          )
        )
      ) {
        incompatible(
          "Candidate Card opening carryover entry does not match authoritative roster ownership."
        );
      }
    }
    if (expectedCarryoverProjection !== null) {
      const cardRowsByTeamId = new Map(
        cards.map((card) => [card.team_id, card])
      );
      for (const expectedTeam of
        expectedCarryoverProjection.teams) {
        const card = cardRowsByTeamId.get(
          expectedTeam.teamId
        );
        const expectedFilledMandatory =
          CANDIDATE_SLOT_COUNTS.F -
            expectedTeam.openForwardSlots +
          CANDIDATE_SLOT_COUNTS.D -
            expectedTeam.openDefenceSlots;
        const expectedFilledBench =
          CANDIDATE_SLOT_COUNTS.B -
          expectedTeam.openBenchSlots;
        const expectedCompleteness =
          expectedTeam.structuralConflictCount > 0
            ? "conflicted"
            : expectedFilledMandatory === 18
              ? "complete"
              : "incomplete";
        if (
          !card ||
          card.status !== "open" ||
          card.completeness_code !==
            expectedCompleteness ||
          card.filled_mandatory_count !==
            expectedFilledMandatory ||
          card.missing_mandatory_count !==
            expectedTeam.openForwardSlots +
              expectedTeam.openDefenceSlots ||
          card.filled_bench_count !==
            expectedFilledBench ||
          card.empty_bench_count !==
            expectedTeam.openBenchSlots ||
          card.structural_conflict_count !==
            expectedTeam.structuralConflictCount ||
          card
            .carried_roster_structural_conflict_count !==
            expectedTeam.structuralConflictCount
        ) {
          incompatible(
            "Candidate Card opening counts do not match the exact readiness carryover projection."
          );
        }
        const persistedEntries = carryoverEntries
          .filter(
            (entry) =>
              entry.team_id === expectedTeam.teamId
          )
          .sort((left, right) =>
            compareText(
              left.carryover_ownership_id,
              right.carryover_ownership_id
            )
          )
          .map((entry) => ({
            ownershipId:
              entry.carryover_ownership_id,
            playerId: entry.player_id,
            contractId:
              entry.carryover_contract_id,
            effectivePositionGroup:
              entry.effective_position_group,
            sourceRosterCategory:
              entry.source_roster_category,
            requestedSlotGroup:
              entry.requested_slot_group,
            requestedSlotNumber:
              entry.requested_slot_number,
            placementState:
              entry.placement_state,
            conflictCode: entry.conflict_code,
            originalTotalValueCents:
              entry
                .carryover_original_total_value_cents,
            originalTermYears:
              entry
                .carryover_original_term_years,
            aavCents:
              entry.carryover_aav_cents,
            remainingYears:
              entry.remaining_years,
          }));
        if (
          !isDeepStrictEqual(
            persistedEntries,
            expectedTeam.entries
          )
        ) {
          incompatible(
            "Candidate Card opening entries do not match the exact readiness carryover projection."
          );
        }
      }
    }
    if (writerResult !== null) {
      const revisionIdByCardId = new Map(
        openingRevisions.map((revision) => [
          revision.card_id,
          revision.id,
        ])
      );
      const persistedWriterResult = {
        replayed: false,
        carryoverProjection:
          expectedCarryoverProjection,
        cards: cards.map((card) => ({
          id: card.id,
          teamId: card.team_id,
          version: card.version,
          completenessCode:
            card.completeness_code,
          carryoverCount: carryoverEntries.filter(
            (entry) =>
              entry.card_id === card.id
          ).length,
          structuralConflictCount:
            card.structural_conflict_count,
          maximumPossibleCapCents:
            card.maximum_possible_cap_cents,
          openingRevisionId:
            revisionIdByCardId.get(card.id) ?? null,
        })),
      };
      if (
        !isDeepStrictEqual(
          writerResult,
          persistedWriterResult
        )
      ) {
        incompatible(
          "The Candidate Card opening writer result does not match its persisted state."
        );
      }
    }
  }

  function readDurableDraft(command) {
    const draft = draftRecord(
      uniqueRow(
        draftStatement,
        {
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          fadId:
            command.fadId ||
            command.evidence?.fadId,
        },
        "FAD aggregate"
      )
    );
    if (!draft) return null;
    const scope = {
      leagueId: draft.leagueId,
      seasonId: draft.seasonId,
      fadId: draft.id,
    };
    const rollovers = rolloverStatement
      .all(scope)
      .map(rolloverRecord);
    try {
      validateFreeAgentDraftRolloverSequence({
        candidateDeadlineAtMs:
          draft.candidateDeadlineAtMs,
        rollovers: rollovers.map(
          (rollover) => ({
            id: rollover.id,
            sequence: rollover.sequence,
            windowKind:
              rollover.windowKind,
            predecessorRolloverId:
              rollover
                .predecessorRolloverId,
            extensionReason:
              rollover.extensionReason,
            extensionSourceId:
              rollover.extensionSourceId,
            opensAtMs:
              rollover.opensAtMs,
            creationCutoffAtMs:
              rollover
                .creationCutoffAtMs,
            rollsOverAtMs:
              rollover.rollsOverAtMs,
            status: rollover.status,
          })
        ),
      });
    } catch (error) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES
          .schemaIncompatible,
        "The persisted FAD rollover sequence is invalid.",
        { cause: error }
      );
    }
    return Object.freeze({
      draft,
      participants: Object.freeze(
        participantsStatement
          .all(scope)
          .map((row) =>
            Object.freeze({
              id: row.id,
              teamId: row.team_id,
              createdAtMs:
                row.created_at_ms,
            })
          )
      ),
      cards: Object.freeze(
        cardsStatement
          .all(scope)
          .map((row) =>
            Object.freeze({
              id: row.id,
              teamId: row.team_id,
              status: row.status,
              version: row.version,
            })
          )
      ),
      rollovers: Object.freeze(rollovers),
    });
  }

  function requireTransitionClock(
    command,
    existing
  ) {
    if (
      command.occurredAtMs <
      existing.updatedAtMs
    ) {
      conflict(
        "The FAD transition timestamp precedes persisted state."
      );
    }
    if (
      command.toStatus ===
        "deadline_locked" &&
      command.occurredAtMs <
        existing.candidateDeadlineAtMs
    ) {
      conflict(
        "The Candidate Card deadline is not due."
      );
    }
    if (
      command.toStatus === "allocating" &&
      command.occurredAtMs <
        existing.deadlineLockedAtMs
    ) {
      conflict(
        "FAD allocation cannot precede deadline locking."
      );
    }
    if (
      command.toStatus === "rapid" &&
      command.occurredAtMs <
        existing.deadlineLockedAtMs
    ) {
      conflict(
        "FAD rapid processing cannot precede deadline locking."
      );
    }
    if (
      command.toStatus === "completed" &&
      command.occurredAtMs <
        existing.allocationCompletedAtMs
    ) {
      conflict(
        "FAD completion cannot precede allocation completion."
      );
    }
  }

  function requireRecoveryWriter(method) {
    if (
      !scheduleRecoveryWriter ||
      typeof scheduleRecoveryWriter[method] !==
        "function"
    ) {
      incompatible(
        "Atomic FAD schedule-recovery persistence is not composed."
      );
    }
  }

  function requireRecoveryWriterResult(
    result,
    plan,
    { sealed }
  ) {
    assertSynchronous(
      result,
      "FAD schedule-recovery write"
    );
    if (
      !result ||
      typeof result !== "object" ||
      result.staged !== true ||
      result.sealed !== sealed ||
      result.recoveryId !== plan.recovery.id
    ) {
      incompatible(
        "The FAD schedule-recovery writer returned inconsistent evidence."
      );
    }
    return result;
  }

  function requireDeadlineEvidence(
    command,
    {
      allocationMode,
      requireDeadlineLease,
    }
  ) {
    const evidence = uniqueRow(
      deadlineEvidenceStatement,
      command,
      "FAD deadline evidence"
    );
    if (!evidence) {
      conflict(
        "The FAD deadline evidence is unavailable."
      );
    }
    const teamCount =
      evidence.participating_team_count;
    if (
      evidence.participant_count !==
        teamCount ||
      evidence.card_count !== teamCount ||
      evidence.locked_card_count !==
        teamCount ||
      evidence.snapshot_count !==
        teamCount ||
      evidence.valid_snapshot_count !==
        teamCount ||
      evidence.slot_snapshot_count !==
        teamCount * 22 ||
      evidence.active_help_count !== 0 ||
      evidence.allocation_count !==
        evidence.candidate_player_count ||
      (
        allocationMode === "all_pending" &&
        evidence.pending_allocation_count !==
          evidence.allocation_count
      ) ||
      (
        allocationMode === "none_pending" &&
        evidence.pending_allocation_count !==
          0
      )
    ) {
      conflict(
        "The complete locked Candidate Card and allocation evidence is not ready."
      );
    }
    if (
      requireDeadlineLease &&
      evidence.leased_deadline_job_count !== 1
    ) {
      conflict(
        "The exact leased deadline occurrence is not active."
      );
    }
  }

  const openingTransaction =
    database.transaction((command) => {
      const readiness = readReadiness(command);
      if (!readiness) {
        notFound(
          "The scoped FAD readiness operation was not found."
        );
      }
      if (readiness.status === "succeeded") {
        const durable = readDurableDraft({
          ...command,
          fadId: readiness.createdFadId,
        });
        if (
          !durable ||
          durable.draft.readinessOperationId !==
            readiness.id ||
          durable.draft.readinessOccurrenceKey !==
            readiness.occurrenceKey ||
          durable.rollovers.length !==
            FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
        ) {
          incompatible(
            "The succeeded FAD readiness result is incomplete."
          );
        }
        requireTerminalReadinessExecution(
          command,
          {
            outcome: "succeeded",
            durable,
            readiness,
            allowGeneratedEvidence: true,
            enforceCommandEvidence: false,
          }
        );
        return Object.freeze({
          replayed: true,
          readiness,
          ...durable,
        });
      }
      if (
        readiness.id !==
          command.readinessOperationId ||
        readiness.version !==
          command.expectedReadinessVersion
      ) {
        conflict(
          "The FAD readiness operation changed."
        );
      }
      if (
        SETUP_PATH_BY_TRIGGER[
          readiness.triggerKind
        ] !== command.setupPath ||
        readiness.entryDraftId !==
          command.entryDraftId ||
        readiness.setupExemptionId !==
          command.setupExemptionId
      ) {
        conflict(
          "The FAD opening path does not match its readiness occurrence."
        );
      }
      const execution =
        requireRunningReadinessExecution(
          readiness,
          command
        );
      const revalidated =
        revalidateOpeningReadiness(command);
      if (revalidated.outcome === "blocked") {
        return Object.freeze({
          replayed: false,
          openingBlocked: true,
          readiness,
          observedAtMs:
            revalidated.observedAtMs,
          internalBlockers:
            revalidated.internalBlockers,
          attemptProjection:
            revalidated.attemptProjection,
        });
      }

      const activeRows =
        activeParticipantsStatement.all(
          command
        );
      if (activeRows.length < 1) {
        conflict(
          "FAD readiness requires active managed teams."
        );
      }
      const managerCountByTeam = new Map();
      for (const row of activeRows) {
        managerCountByTeam.set(
          row.team_id,
          (managerCountByTeam.get(
            row.team_id
          ) || 0) + 1
        );
      }
      if (
        [...managerCountByTeam.values()].some(
          (count) => count !== 1
        )
      ) {
        incompatible(
          "Each FAD participant must have exactly one current manager."
        );
      }
      const activeTeamIds = [
        ...managerCountByTeam.keys(),
      ].sort();
      const plannedTeamIds =
        command.evidence.participants.map(
          (participant) =>
            participant.teamId
        );
      if (
        activeTeamIds.length !==
          plannedTeamIds.length ||
        activeTeamIds.some(
          (teamId, index) =>
            teamId !==
            plannedTeamIds[index]
        )
      ) {
        conflict(
          "The FAD participating-team set changed."
        );
      }
      const readinessTeamById = new Map(
        command.attempt.projection.teamProjections.map(
          (team) => [team.teamId, team]
        )
      );
      if (
        activeRows.some((row) => {
          const projected = readinessTeamById.get(
            row.team_id
          );
          return (
            !projected ||
            projected.managerReady !== true ||
            projected.managerAssignmentId !==
              row.assignment_id
          );
        })
      ) {
        conflict(
          "A FAD participant manager assignment changed after readiness inspection."
        );
      }

      insertExactReadinessAttempt(command);

      let effectiveSchedule = command.schedule;
      let scheduleRecoveryId = null;
      if (command.scheduleRecoveryPlan !== null) {
        requireRecoveryWriter("stage");
        requireRecoveryWriterResult(
          scheduleRecoveryWriter.stage({
            plan: command.scheduleRecoveryPlan,
          }),
          command.scheduleRecoveryPlan,
          { sealed: false }
        );
        effectiveSchedule = requireCurrentSchedule(
          {
            ...command,
            schedule: command.targetSchedule,
          },
          { afterWriter: true }
        );
      }

      insertDraftStatement.run({
        fadId: command.evidence.fadId,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        readinessOperationId:
          readiness.id,
        occurrenceKey:
          command.occurrenceKey,
        weekOneMatchupWeekId:
          effectiveSchedule
            .weekOneMatchupWeekId,
        participatingTeamCount:
          activeTeamIds.length,
        setupPath: command.setupPath,
        entryDraftId: command.entryDraftId,
        setupExemptionId:
          command.setupExemptionId,
        priorSeasonRolloverId:
          command.priorSeasonRolloverId,
        noDraftReason:
          command.noDraftReason,
        openedAtMs: command.openedAtMs,
        helpOpensAtMs:
          command.clock.helpOpensAtMs,
        candidateDeadlineAtMs:
          command.clock
            .candidateDeadlineAtMs,
        firstMatchupStartsAtMs:
          command.clock
            .firstMatchupStartsAtMs,
      });

      if (command.scheduleRecoveryPlan !== null) {
        requireRecoveryWriter("seal");
        const sealed = requireRecoveryWriterResult(
          scheduleRecoveryWriter.seal({
            plan: command.scheduleRecoveryPlan,
          }),
          command.scheduleRecoveryPlan,
          { sealed: true }
        );
        scheduleRecoveryId = sealed.recoveryId;
      }

      const activeByTeam = new Map(
        activeRows.map((row) => [
          row.team_id,
          row,
        ])
      );
      const writerParticipants =
        command.evidence.participants.map(
          (participant) => {
            const active =
              activeByTeam.get(
                participant.teamId
              );
            insertParticipantStatement.run({
              participantId:
                participant.participantId,
              leagueId: command.leagueId,
              seasonId: command.seasonId,
              fadId: command.evidence.fadId,
              teamId: participant.teamId,
              openedAtMs:
                command.openedAtMs,
            });
            return Object.freeze({
              ...participant,
              managerAssignmentId:
                active.assignment_id,
              managerUserId:
                active.user_id,
              managerMembershipId:
                active.membership_id,
            });
          }
        );

      if (
        !candidateCardWriter ||
        typeof candidateCardWriter.openAll !==
          "function"
      ) {
        incompatible(
          "Atomic Candidate Card opening is not composed."
        );
      }
      const candidateCardOpeningResult =
        candidateCardWriter.openAll({
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          fadId: command.evidence.fadId,
          openedAtMs: command.openedAtMs,
          candidateDeadlineAtMs:
            command.clock
              .candidateDeadlineAtMs,
          carryoverProjection:
            command.carryoverProjection,
          participants: Object.freeze(
            writerParticipants
          ),
        });
      assertSynchronous(
        candidateCardOpeningResult,
        "FAD Candidate Card opening"
      );
      if (
        !isPlainObject(
          candidateCardOpeningResult
        ) ||
        candidateCardOpeningResult.replayed !== false ||
        !Array.isArray(
          candidateCardOpeningResult.cards
        ) ||
        candidateCardOpeningResult.cards.length !==
          writerParticipants.length ||
        !isDeepStrictEqual(
          candidateCardOpeningResult
            .carryoverProjection,
          command.carryoverProjection
        )
      ) {
        incompatible(
          "The Candidate Card opening writer returned inconsistent carryover evidence."
        );
      }
      requireExactCandidateCardOpening({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.evidence.fadId,
        openedAtMs: command.openedAtMs,
        candidateDeadlineAtMs:
          command.clock
            .candidateDeadlineAtMs,
        expectedParticipants:
          writerParticipants,
        expectedCarryoverProjection:
          command.carryoverProjection,
        writerResult:
          candidateCardOpeningResult,
        requireOpeningOnly: true,
      });

      const reminderAtMs =
        command.clock.reminderAtMs;
      insertJobStatement.run({
        id:
          command.evidence
            .reminderJobRunId,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        jobType: "fad_deadline_reminder",
        occurrenceKey:
          buildFreeAgentDraftReminderOccurrenceKey({
            fadId: command.evidence.fadId,
            reminderAtMs,
          }),
        scheduledForMs: reminderAtMs,
        createdAtMs: command.openedAtMs,
      });
      insertJobStatement.run({
        id:
          command.evidence
            .deadlineJobRunId,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        jobType: "fad_deadline",
        occurrenceKey:
          buildFreeAgentDraftDeadlineOccurrenceKey({
            fadId: command.evidence.fadId,
            deadlineAtMs:
              command.clock
                .candidateDeadlineAtMs,
          }),
        scheduledForMs:
          command.clock
            .candidateDeadlineAtMs,
        createdAtMs: command.openedAtMs,
      });

      for (
        let index = 0;
        index <
        FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT;
        index += 1
      ) {
        const clock =
          command.clock.initialRollovers[
            index
          ];
        const rolloverId =
          command.evidence.rolloverIds[
            index
          ];
        insertRolloverStatement.run({
          id: rolloverId,
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          fadId: command.evidence.fadId,
          sequence: clock.sequence,
          predecessorRolloverId:
            index === 0
              ? null
              : command.evidence
                  .rolloverIds[index - 1],
          opensAtMs: clock.opensAtMs,
          creationCutoffAtMs:
            clock.creationCutoffAtMs,
          rollsOverAtMs:
            clock.rollsOverAtMs,
          createdAtMs: command.openedAtMs,
        });
        insertJobStatement.run({
          id:
            command.evidence
              .rolloverJobRunIds[index],
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          jobType: "fad_rollover",
          occurrenceKey:
            buildFreeAgentDraftRolloverOccurrenceKey({
              fadId: command.evidence.fadId,
              sequence: clock.sequence,
              rolloverAtMs:
                clock.rollsOverAtMs,
            }),
          scheduledForMs:
            clock.rollsOverAtMs,
          createdAtMs:
            command.openedAtMs,
        });
      }

      insertActivityStatement.run({
        id: command.evidence.activityId,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.evidence.fadId,
        openedAtMs: command.openedAtMs,
        metadataJson: JSON.stringify({
          fadId: command.evidence.fadId,
          candidateDeadlineAtMs:
            command.clock
              .candidateDeadlineAtMs,
          firstMatchupStartsAtMs:
            command.clock
              .firstMatchupStartsAtMs,
          participatingTeamCount:
            writerParticipants.length,
        }),
      });

      const openingPublications =
        openingPublicationIds({
          rootOutboxEventId:
            command.evidence.outboxEventId,
          activityId:
            command.evidence.activityId,
          participants: writerParticipants,
        });

      for (
        let index = 0;
        index < writerParticipants.length;
        index += 1
      ) {
        const participant =
          writerParticipants[index];
        const participantPublications =
          openingPublications
            .participantOutboxEventIds[index];
        notifications.insert({
          id: participant.notificationId,
          userId:
            participant.managerUserId,
          leagueId: command.leagueId,
          eventType: "fad_cards_opened",
          messageDataJson: JSON.stringify({
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            fadId: command.evidence.fadId,
            teamId: participant.teamId,
            cardId: participant.cardId,
            candidateDeadlineAtMs:
              command.clock
                .candidateDeadlineAtMs,
            destination: {
              kind: "private_card",
              leagueId: command.leagueId,
              fadId:
                command.evidence.fadId,
              teamId: participant.teamId,
              cardId: participant.cardId,
            },
          }),
          relatedFeature: "free_agent_draft",
          relatedRecordId:
            command.evidence.fadId,
          deliveryStatus: "pending",
          createdAtMs: command.openedAtMs,
          deliveredAtMs: null,
          deduplicationKey:
            `fad:${command.evidence.fadId}:` +
            `cards-opened:${participant.teamId}:` +
            participant.managerUserId,
        });

        insertOutboxStatement.run({
          id: participantPublications
            .cardOutboxEventId,
          leagueId: command.leagueId,
          eventType: "candidate_card.changed",
          aggregateType: "candidate_card",
          aggregateId: participant.cardId,
          payloadJson: JSON.stringify(
            createSocketEventEnvelope({
              eventId:
                participantPublications
                  .cardOutboxEventId,
              type: "candidate_card.changed",
              leagueId: command.leagueId,
              resourceId: participant.cardId,
              version: 1,
              reasonCode: "card_changed",
              occurredAt: command.openedAtMs,
              related: createEmptySocketRelated({
                fadId: command.evidence.fadId,
                teamId: participant.teamId,
                cardId: participant.cardId,
              }),
            })
          ),
          openedAtMs: command.openedAtMs,
        });
        insertOutboxAudienceStatement.run({
          id: participantPublications
            .cardOutboxEventId,
          leagueId: command.leagueId,
          outboxEventId:
            participantPublications
              .cardOutboxEventId,
          audienceKind: "team",
          teamId: participant.teamId,
          userId: null,
          openedAtMs: command.openedAtMs,
        });

        insertOutboxStatement.run({
          id: participantPublications
            .notificationOutboxEventId,
          leagueId: command.leagueId,
          eventType: "notification.created",
          aggregateType: "notification",
          aggregateId: participant.notificationId,
          payloadJson: JSON.stringify(
            createSocketEventEnvelope({
              eventId:
                participantPublications
                  .notificationOutboxEventId,
              type: "notification.created",
              leagueId: command.leagueId,
              resourceId:
                participant.notificationId,
              version: 1,
              reasonCode: "cards_opened",
              occurredAt: command.openedAtMs,
              related: createEmptySocketRelated({
                fadId: command.evidence.fadId,
                teamId: participant.teamId,
                cardId: participant.cardId,
              }),
            })
          ),
          openedAtMs: command.openedAtMs,
        });
        insertOutboxAudienceStatement.run({
          id: participantPublications
            .notificationOutboxEventId,
          leagueId: command.leagueId,
          outboxEventId:
            participantPublications
              .notificationOutboxEventId,
          audienceKind: "user",
          teamId: null,
          userId: participant.managerUserId,
          openedAtMs: command.openedAtMs,
        });
      }

      insertOutboxStatement.run({
        id: command.evidence.outboxEventId,
        leagueId: command.leagueId,
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: command.evidence.fadId,
        openedAtMs: command.openedAtMs,
        payloadJson: JSON.stringify(
          createSocketEventEnvelope({
            eventId:
              command.evidence.outboxEventId,
            type: "free_agent_draft.changed",
            leagueId: command.leagueId,
            resourceId: command.evidence.fadId,
            version: 1,
            reasonCode: "cards_opened",
            occurredAt: command.openedAtMs,
            related: createEmptySocketRelated({
              fadId: command.evidence.fadId,
            }),
          })
        ),
      });
      insertOutboxAudienceStatement.run({
        id:
          command.evidence
            .outboxAudienceId,
        leagueId: command.leagueId,
        outboxEventId:
          command.evidence.outboxEventId,
        audienceKind: "league",
        teamId: null,
        userId: null,
        openedAtMs: command.openedAtMs,
      });

      insertOutboxStatement.run({
        id: openingPublications
          .activityOutboxEventId,
        leagueId: command.leagueId,
        eventType: "activity.created",
        aggregateType: "league_activity",
        aggregateId: command.evidence.activityId,
        payloadJson: JSON.stringify(
          createSocketEventEnvelope({
            eventId:
              openingPublications
                .activityOutboxEventId,
            type: "activity.created",
            leagueId: command.leagueId,
            resourceId: command.evidence.activityId,
            version: 1,
            reasonCode: "cards_opened",
            occurredAt: command.openedAtMs,
            related: createEmptySocketRelated({
              fadId: command.evidence.fadId,
            }),
          })
        ),
        openedAtMs: command.openedAtMs,
      });
      insertOutboxAudienceStatement.run({
        id: openingPublications
          .activityOutboxEventId,
        leagueId: command.leagueId,
        outboxEventId:
          openingPublications
            .activityOutboxEventId,
        audienceKind: "league",
        teamId: null,
        userId: null,
        openedAtMs: command.openedAtMs,
      });

      requireCurrentSchedule(
        {
          ...command,
          schedule: effectiveSchedule,
        },
        { afterWriter: true }
      );
      requireChanged(
        succeedReadinessStatement.run({
          ...command,
          ...execution,
          readinessOperationId:
            readiness.id,
          scheduleVersionBefore:
            command.schedule.version,
          scheduleVersionAfter:
            effectiveSchedule.version,
          scheduleRecoveryId,
          fadId: command.evidence.fadId,
          reminderJobRunId:
            command.evidence
              .reminderJobRunId,
          deadlineJobRunId:
            command.evidence
              .deadlineJobRunId,
          activityId:
            command.evidence.activityId,
          outboxEventId:
            command.evidence.outboxEventId,
        }),
        "The FAD readiness operation changed before opening completed."
      );

      const durable = readDurableDraft(command);
      const succeeded = readReadiness(command);
      if (
        !durable ||
        !succeeded ||
        succeeded.status !== "succeeded" ||
        durable.rollovers.length !==
          FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
      ) {
        incompatible(
          "The committed FAD opening result is incomplete."
        );
      }
      const resultJson = serializeCanonicalJsonV1({
        fadId: durable.draft.id,
        readinessAttemptId: command.attempt.id,
        readinessOperationId: readiness.id,
      });
      requireChanged(
        succeedReadinessJobStatement.run({
          ...command,
          ...execution,
          fadId: durable.draft.id,
          resultJson,
        }),
        "The running FAD readiness job changed before opening completion."
      );
      requireTerminalReadinessExecution(
        command,
        { outcome: "succeeded", durable }
      );
      if (beforeCommit) {
        assertSynchronous(
          beforeCommit(
            "commitOpening",
            durable
          ),
          "FAD opening beforeCommit"
        );
      }
      return Object.freeze({
        replayed: false,
        readiness: succeeded,
        ...durable,
      });
    });

  function commitOpening(input) {
    const command =
      normalizeOpeningCommand(input);
    try {
      return openingTransaction.immediate(
        command
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "commitFadOpening",
        tableName: "free_agent_drafts",
      });
    }
  }

  function findDraft(input) {
    const lookup = normalizeDraftLookup(input);
    return readDurableDraft(lookup);
  }

  function listRollovers(input) {
    const lookup = normalizeDraftLookup(input);
    return Object.freeze(
      rolloverStatement
        .all(lookup)
        .map(rolloverRecord)
    );
  }

  const transitionTransaction =
    database.transaction((command) => {
      const existing = draftRecord(
        uniqueRow(
          draftStatement,
          command,
          "FAD aggregate"
        )
      );
      if (!existing) {
        notFound(
          "The scoped FAD aggregate was not found."
        );
      }
      if (existing.status === command.toStatus) {
        return Object.freeze({
          replayed: true,
          draft: existing,
        });
      }
      if (
        existing.status !==
          command.fromStatus ||
        existing.version !==
          command.expectedVersion
      ) {
        conflict(
          "The FAD aggregate changed before its lifecycle transition."
        );
      }
      if (
        command.schedule.weekOneMatchupWeekId !==
        existing.currentCompetitionFirstMatchupWeekId
      ) {
        invalid(
          "The FAD transition is not bound to its current competition Week 1."
        );
      }
      requireTransitionClock(
        command,
        existing
      );
      requireCurrentSchedule(command);

      let effectiveSchedule = command.schedule;
      let scheduleRecoveryId =
        command.toStatus === "completed"
          ? existing.scheduleRecoveryId
          : null;
      if (command.scheduleRecoveryPlan !== null) {
        requireRecoveryWriter("applyAndSeal");
        const sealed = requireRecoveryWriterResult(
          scheduleRecoveryWriter.applyAndSeal({
            plan: command.scheduleRecoveryPlan,
          }),
          command.scheduleRecoveryPlan,
          { sealed: true }
        );
        scheduleRecoveryId = sealed.recoveryId;
        effectiveSchedule = requireCurrentSchedule(
          {
            ...command,
            schedule: command.targetSchedule,
          },
          { afterWriter: true }
        );
      }
      const effectiveCommand = Object.freeze({
        ...command,
        schedule: effectiveSchedule,
        scheduleRecoveryId,
      });

      if (
        !transitionWriter ||
        typeof transitionWriter.beforeTransition !==
          "function"
      ) {
        incompatible(
          "Atomic FAD dependent transition persistence is not composed."
        );
      }
      assertSynchronous(
        transitionWriter.beforeTransition({
          ...effectiveCommand,
          existing,
        }),
        "FAD dependent transition write"
      );
      if (
        command.toStatus ===
        "deadline_locked"
      ) {
        requireDeadlineEvidence(command, {
          allocationMode: "all_pending",
          requireDeadlineLease: true,
        });
      } else if (
        command.toStatus === "allocating"
      ) {
        requireDeadlineEvidence(command, {
          allocationMode: "any",
          requireDeadlineLease: false,
        });
      } else if (
        command.toStatus === "rapid"
      ) {
        requireDeadlineEvidence(command, {
          allocationMode: "none_pending",
          requireDeadlineLease: false,
        });
      }
      requireCurrentSchedule(effectiveCommand, {
        afterWriter: true,
      });

      const statement = {
        deadline_locked:
          transitionDeadlineStatement,
        allocating:
          transitionAllocatingStatement,
        rapid: transitionRapidStatement,
        completed:
          transitionCompletedStatement,
      }[command.toStatus];
      if (!statement) {
        invalid(
          "The requested FAD transition has no persistence operation."
        );
      }
      requireChanged(
        statement.run({
          ...effectiveCommand,
          operationId:
            effectiveSchedule.operationId,
          scheduleVersion:
            effectiveSchedule.version,
          weekOneMatchupWeekId:
            effectiveSchedule
              .weekOneMatchupWeekId,
          weekOneStartsAtMs:
            effectiveSchedule
              .weekOneStartsAtMs,
        }),
        "The FAD aggregate changed before its lifecycle transition committed."
      );
      const updated = draftRecord(
        uniqueRow(
          draftStatement,
          command,
          "transitioned FAD aggregate"
        )
      );
      if (
        !updated ||
        updated.status !== command.toStatus
      ) {
        incompatible(
          "The transitioned FAD aggregate is unavailable."
        );
      }
      if (transitionWriter.afterTransition) {
        assertSynchronous(
          transitionWriter.afterTransition({
            effectiveCommand,
            existing,
            updated,
          }),
          "FAD dependent post-transition write"
        );
      }
      if (beforeCommit) {
        assertSynchronous(
          beforeCommit(
            "advanceStatus",
            updated
          ),
          "FAD transition beforeCommit"
        );
      }
      return Object.freeze({
        replayed: false,
        draft: updated,
      });
    });

  function advanceStatus(input) {
    const command = normalizeTransition(input);
    try {
      return transitionTransaction.immediate(
        command
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "advanceFadStatus",
        tableName: "free_agent_drafts",
      });
    }
  }

  const repository = {
    ensureReadinessOperation,
    findReadinessByOccurrence,
    blockReadinessOperation,
    commitOpening,
    findDraft,
    listRollovers,
    advanceStatus,
  };
  if (
    Object.keys(repository).length !==
      REPOSITORY_METHODS.length ||
    REPOSITORY_METHODS.some(
      (method) =>
        typeof repository[method] !==
        "function"
    )
  ) {
    throw new TypeError(
      "The FAD lifecycle repository surface is incomplete."
    );
  }
  return Object.freeze(repository);
}

module.exports = {
  REPOSITORY_METHODS,
  createSqliteFreeAgentDraftRepository,
};
