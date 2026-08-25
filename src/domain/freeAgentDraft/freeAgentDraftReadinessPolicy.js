const {
  compareUnicodeScalarStrings,
  hashCanonicalJsonV1,
  parseCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../leagues/seasonRolloverEvidencePolicy"
);
const {
  FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
  FREE_AGENT_DRAFT_DAY_MS,
  FREE_AGENT_DRAFT_HELP_WINDOW_MS,
  FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
  FREE_AGENT_DRAFT_REMINDER_LEAD_MS,
  UUID_PATTERN,
  buildFreeAgentDraftReadinessOccurrenceKey,
  parseFreeAgentDraftOccurrenceKey,
} = require("./freeAgentDraftPolicy");

const FREE_AGENT_DRAFT_READINESS_SCHEMA_VERSION = 1;
const FREE_AGENT_DRAFT_READINESS_RETRY_OPERATION =
  "free_agent_draft.readiness.retry.v1";
const FREE_AGENT_DRAFT_READINESS_REQUEST_DOMAIN =
  "hundo-leago.free-agent-draft-readiness-retry-request";
const FREE_AGENT_DRAFT_READINESS_JOB_TYPE =
  "fad_readiness";
const FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION =
  "RETRY FREE AGENT DRAFT READINESS";
const FREE_AGENT_DRAFT_READINESS_RETRY_HTTP_STATUS = 202;
const READINESS_FORWARD_SLOT_COUNT = 12;
const READINESS_DEFENCE_SLOT_COUNT = 6;
const READINESS_BENCH_SLOT_COUNT = 4;

const FREE_AGENT_DRAFT_READINESS_TRIGGER_KINDS =
  Object.freeze([
    "entry_draft_completed",
    "no_draft_inaugural",
    "no_draft_initial_season2",
  ]);

const FREE_AGENT_DRAFT_READINESS_AUTHORITIES =
  Object.freeze([
    "commissioner",
    "platform_administrator_as_commissioner",
  ]);

const FREE_AGENT_DRAFT_READINESS_POLICY_CODES =
  Object.freeze({
    inputInvalid: "FAD_READINESS_INPUT_INVALID",
    resultInvalid: "FAD_READINESS_RESULT_INVALID",
  });

const FREE_AGENT_DRAFT_READINESS_MISSING_SCHEDULE_BLOCKER =
  Object.freeze({
    code: "MATCHUP_SCHEDULE_MISSING",
    field: "firstMatchupStartsAtMs",
    message:
      "The first matchup schedule must be confirmed.",
    resourceType: "season",
  });

const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class FreeAgentDraftReadinessPolicyError extends Error {
  constructor(code, reasonCode) {
    super(`${code}: ${reasonCode}`);
    this.name = "FreeAgentDraftReadinessPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftReadinessPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_READINESS_POLICY_CODES
      .inputInvalid,
    reasonCode
  );
}

function failResult(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_READINESS_POLICY_CODES
      .resultInvalid,
    reasonCode
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

function requireExactObject(
  value,
  keys,
  reasonCode,
  failure = failInput
) {
  if (!isPlainObject(value)) {
    failure(reasonCode);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    failure(reasonCode);
  }
  return value;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function stableId(
  value,
  reasonCode,
  failure = failInput
) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failure(reasonCode);
  }
  return value;
}

function createFreeAgentDraftReadinessMissingScheduleBlocker(
  input = {}
) {
  requireExactObject(
    input,
    ["seasonId"],
    "missing_schedule_blocker_fields_invalid"
  );
  return deepFreeze({
    ...FREE_AGENT_DRAFT_READINESS_MISSING_SCHEDULE_BLOCKER,
    resourceId: stableId(
      input.seasonId,
      "season_id_invalid"
    ),
  });
}

function safePositiveInteger(
  value,
  reasonCode,
  failure = failInput
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    failure(reasonCode);
  }
  return value;
}

function safeNonnegativeInteger(
  value,
  reasonCode,
  failure = failInput
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failure(reasonCode);
  }
  return value;
}

function safeTimestamp(
  value,
  reasonCode,
  failure = failInput
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failure(reasonCode);
  }
  return value;
}

function boundedText(
  value,
  maximumLength,
  reasonCode,
  failure = failInput
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    CONTROL_PATTERN.test(value)
  ) {
    failure(reasonCode);
  }
  return value;
}

function sha256(
  value,
  reasonCode,
  failure = failResult
) {
  if (
    typeof value !== "string" ||
    !SHA256_PATTERN.test(value)
  ) {
    failure(reasonCode);
  }
  return value;
}

function triggerEvidence(input) {
  const triggerKind = input.triggerKind;
  if (
    !FREE_AGENT_DRAFT_READINESS_TRIGGER_KINDS
      .includes(triggerKind)
  ) {
    failInput("trigger_kind_invalid");
  }
  const triggerResourceId = stableId(
    input.triggerResourceId,
    "trigger_resource_id_invalid"
  );
  const entryDraftId =
    input.entryDraftId === null
      ? null
      : stableId(
          input.entryDraftId,
          "entry_draft_id_invalid"
        );
  const setupExemptionId =
    input.setupExemptionId === null
      ? null
      : stableId(
          input.setupExemptionId,
          "setup_exemption_id_invalid"
        );

  const accepted =
    (
      triggerKind === "entry_draft_completed" &&
      entryDraftId === triggerResourceId &&
      setupExemptionId === null
    ) ||
    (
      triggerKind === "no_draft_inaugural" &&
      triggerResourceId === input.seasonId &&
      entryDraftId === null &&
      setupExemptionId === null
    ) ||
    (
      triggerKind ===
        "no_draft_initial_season2" &&
      setupExemptionId === triggerResourceId &&
      entryDraftId === null
    );
  if (!accepted) {
    failInput("trigger_evidence_invalid");
  }
  return Object.freeze({
    triggerKind,
    triggerResourceId,
    entryDraftId,
    setupExemptionId,
  });
}

function createFreeAgentDraftReadinessTriggerPlan(
  input = {}
) {
  requireExactObject(
    input,
    [
      "createdAtMs",
      "entryDraftId",
      "jobRunId",
      "leagueId",
      "operationId",
      "seasonId",
      "setupExemptionId",
      "triggerKind",
      "triggerResourceId",
    ],
    "trigger_fields_invalid"
  );
  const leagueId = stableId(
    input.leagueId,
    "league_id_invalid"
  );
  const seasonId = stableId(
    input.seasonId,
    "season_id_invalid"
  );
  const operationId = stableId(
    input.operationId,
    "operation_id_invalid"
  );
  const jobRunId = stableId(
    input.jobRunId,
    "job_run_id_invalid"
  );
  const createdAtMs = safeTimestamp(
    input.createdAtMs,
    "created_at_ms_invalid"
  );
  const evidence = triggerEvidence({
    ...input,
    leagueId,
    seasonId,
  });
  const occurrenceKey =
    buildFreeAgentDraftReadinessOccurrenceKey({
      leagueId,
      seasonId,
      triggerResourceId:
        evidence.triggerResourceId,
    });

  return deepFreeze({
    readiness: {
      operationId,
      leagueId,
      seasonId,
      triggerKind: evidence.triggerKind,
      triggerResourceId:
        evidence.triggerResourceId,
      entryDraftId: evidence.entryDraftId,
      setupExemptionId:
        evidence.setupExemptionId,
      jobRunId,
      occurrenceKey,
      createdAtMs,
    },
    job: {
      id: jobRunId,
      leagueId,
      seasonId,
      jobType:
        FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
      occurrenceKey,
      scheduledForMs: createdAtMs,
      status: "pending",
      attemptCount: 0,
      version: 1,
    },
  });
}

function createFreeAgentDraftReadinessRetryRequest(
  input = {}
) {
  requireExactObject(
    input,
    [
      "actorUserId",
      "body",
      "clientKey",
      "expectedVersion",
      "leagueId",
    ],
    "retry_request_fields_invalid"
  );
  requireExactObject(
    input.body,
    [
      "confirmation",
      "readinessOperationId",
      "seasonId",
    ],
    "retry_body_fields_invalid"
  );
  const leagueId = stableId(
    input.leagueId,
    "league_id_invalid"
  );
  const actorUserId = stableId(
    input.actorUserId,
    "actor_user_id_invalid"
  );
  const seasonId = stableId(
    input.body.seasonId,
    "season_id_invalid"
  );
  const readinessOperationId = stableId(
    input.body.readinessOperationId,
    "readiness_operation_id_invalid"
  );
  const expectedVersion = safePositiveInteger(
    input.expectedVersion,
    "expected_version_invalid"
  );
  const clientKey = boundedText(
    input.clientKey,
    128,
    "idempotency_key_invalid"
  );
  if (
    input.body.confirmation !==
    FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION
  ) {
    failInput("confirmation_invalid");
  }
  const canonicalRequest = deepFreeze({
    actorUserId,
    body: {
      confirmation:
        FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
      readinessOperationId,
      seasonId,
    },
    domain:
      FREE_AGENT_DRAFT_READINESS_REQUEST_DOMAIN,
    expectedVersion,
    leagueId,
    operation:
      FREE_AGENT_DRAFT_READINESS_RETRY_OPERATION,
    schemaVersion:
      FREE_AGENT_DRAFT_READINESS_SCHEMA_VERSION,
  });
  return deepFreeze({
    actorUserId,
    clientKey,
    expectedVersion,
    leagueId,
    readinessOperationId,
    requestJson:
      serializeCanonicalJsonV1(canonicalRequest),
    requestSha256:
      hashCanonicalJsonV1(canonicalRequest),
    seasonId,
  });
}

const READINESS_ATTEMPT_INPUT_FIELDS = Object.freeze([
  "attemptNumber",
  "id",
  "jobRunId",
  "leagueId",
  "observedAtMs",
  "observedReadinessVersion",
  "outcome",
  "projection",
  "readinessOperationId",
  "recordedAtMs",
  "seasonId",
]);

const READINESS_ATTEMPT_PROJECTION_FIELDS =
  Object.freeze([
    "blockers",
    "candidateDeadlineAtMs",
    "firstMatchupWeekAfter",
    "firstMatchupWeekBefore",
    "helpOpensAtMs",
    "initialRollovers",
    "observedSeasonVersion",
    "participatingTeamCount",
    "priorSeasonRollover",
    "reminderAtMs",
    "teamProjections",
    "warnings",
  ]);

function requireArray(value, reasonCode) {
  if (!Array.isArray(value)) {
    failResult(reasonCode);
  }
  return value;
}

function nullableBoundedText(
  value,
  maximumLength,
  reasonCode
) {
  return value === null
    ? null
    : boundedText(
        value,
        maximumLength,
        reasonCode,
        failResult
      );
}

function readinessWeekProjection(value, reasonCode) {
  if (value === null) return null;
  requireExactObject(
    value,
    ["sequence", "startsAtMs", "version", "weekId"],
    reasonCode,
    failResult
  );
  const sequence = safePositiveInteger(
    value.sequence,
    reasonCode,
    failResult
  );
  if (sequence !== 1) {
    failResult(reasonCode);
  }
  return Object.freeze({
    sequence,
    startsAtMs: safeTimestamp(
      value.startsAtMs,
      reasonCode,
      failResult
    ),
    version: safePositiveInteger(
      value.version,
      reasonCode,
      failResult
    ),
    weekId: stableId(
      value.weekId,
      reasonCode,
      failResult
    ),
  });
}

function readinessInitialRollovers(
  value,
  candidateDeadlineAtMs
) {
  const source = requireArray(
    value,
    "initial_rollovers_invalid"
  );
  const clockPresent =
    candidateDeadlineAtMs !== null;
  if (
    (!clockPresent && source.length !== 0) ||
    (
      clockPresent &&
      source.length !==
        FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
    )
  ) {
    failResult("initial_rollovers_invalid");
  }
  let priorRollsOverAtMs = null;
  const rollovers = source.map((rollover, index) => {
    requireExactObject(
      rollover,
      [
        "creationCutoffAtMs",
        "opensAtMs",
        "rollsOverAtMs",
        "sequence",
      ],
      "initial_rollover_invalid",
      failResult
    );
    const sequence = safePositiveInteger(
      rollover.sequence,
      "initial_rollover_invalid",
      failResult
    );
    const opensAtMs = safeTimestamp(
      rollover.opensAtMs,
      "initial_rollover_invalid",
      failResult
    );
    const creationCutoffAtMs = safeTimestamp(
      rollover.creationCutoffAtMs,
      "initial_rollover_invalid",
      failResult
    );
    const rollsOverAtMs = safeTimestamp(
      rollover.rollsOverAtMs,
      "initial_rollover_invalid",
      failResult
    );
    if (
      sequence !== index + 1 ||
      opensAtMs !==
        (index === 0
          ? candidateDeadlineAtMs
          : priorRollsOverAtMs) ||
      rollsOverAtMs !==
        opensAtMs + FREE_AGENT_DRAFT_DAY_MS ||
      creationCutoffAtMs !==
        rollsOverAtMs -
          FREE_AGENT_DRAFT_CREATION_CUTOFF_MS
    ) {
      failResult("initial_rollover_invalid");
    }
    priorRollsOverAtMs = rollsOverAtMs;
    return Object.freeze({
      creationCutoffAtMs,
      opensAtMs,
      rollsOverAtMs,
      sequence,
    });
  });
  return Object.freeze(rollovers);
}

function readinessPriorSeasonRollover(
  value,
  seasonId
) {
  if (value === null) return null;
  requireExactObject(
    value,
    [
      "completedAtMs",
      "fromSeasonId",
      "manifestSha256",
      "rolloverId",
      "toSeasonId",
    ],
    "prior_season_rollover_invalid",
    failResult
  );
  const toSeasonId = stableId(
    value.toSeasonId,
    "prior_season_rollover_invalid",
    failResult
  );
  if (toSeasonId !== seasonId) {
    failResult("prior_season_rollover_invalid");
  }
  return Object.freeze({
    completedAtMs: safeTimestamp(
      value.completedAtMs,
      "prior_season_rollover_invalid",
      failResult
    ),
    fromSeasonId: stableId(
      value.fromSeasonId,
      "prior_season_rollover_invalid",
      failResult
    ),
    manifestSha256: sha256(
      value.manifestSha256,
      "prior_season_rollover_invalid",
      failResult
    ),
    rolloverId: stableId(
      value.rolloverId,
      "prior_season_rollover_invalid",
      failResult
    ),
    toSeasonId,
  });
}

function readinessSafeTeam(value) {
  requireExactObject(
    value,
    [
      "logoReference",
      "name",
      "patternTemplate",
      "primaryColour",
      "secondaryColour",
      "teamId",
      "tertiaryColour",
    ],
    "team_projection_team_invalid",
    failResult
  );
  return Object.freeze({
    logoReference: nullableBoundedText(
      value.logoReference,
      500,
      "team_projection_team_invalid"
    ),
    name: boundedText(
      value.name,
      200,
      "team_projection_team_invalid",
      failResult
    ),
    patternTemplate: boundedText(
      value.patternTemplate,
      200,
      "team_projection_team_invalid",
      failResult
    ),
    primaryColour: boundedText(
      value.primaryColour,
      100,
      "team_projection_team_invalid",
      failResult
    ),
    secondaryColour: boundedText(
      value.secondaryColour,
      100,
      "team_projection_team_invalid",
      failResult
    ),
    teamId: stableId(
      value.teamId,
      "team_projection_team_invalid",
      failResult
    ),
    tertiaryColour: nullableBoundedText(
      value.tertiaryColour,
      100,
      "team_projection_team_invalid"
    ),
  });
}

function readinessTeamProjections(
  value,
  participatingTeamCount
) {
  const source = requireArray(
    value,
    "team_projections_invalid"
  );
  if (source.length !== participatingTeamCount) {
    failResult("team_projections_invalid");
  }
  let priorTeamId = null;
  const projections = source.map((projection) => {
    requireExactObject(
      projection,
      [
        "carryoverCount",
        "managerAssignmentId",
        "managerReady",
        "openBenchSlots",
        "openDefenceSlots",
        "openForwardSlots",
        "structuralConflictCount",
        "team",
        "teamId",
      ],
      "team_projection_invalid",
      failResult
    );
    const teamId = stableId(
      projection.teamId,
      "team_projection_invalid",
      failResult
    );
    if (
      priorTeamId !== null &&
      compareUnicodeScalarStrings(
        teamId,
        priorTeamId
      ) <= 0
    ) {
      failResult("team_projections_order_invalid");
    }
    const team = readinessSafeTeam(projection.team);
    if (team.teamId !== teamId) {
      failResult("team_projection_invalid");
    }
    if (typeof projection.managerReady !== "boolean") {
      failResult("team_projection_invalid");
    }
    const managerAssignmentId =
      projection.managerReady
        ? stableId(
            projection.managerAssignmentId,
            "team_projection_invalid",
            failResult
          )
        : projection.managerAssignmentId;
    if (
      !projection.managerReady &&
      managerAssignmentId !== null
    ) {
      failResult("team_projection_invalid");
    }
    const carryoverCount = safeNonnegativeInteger(
      projection.carryoverCount,
      "team_projection_invalid",
      failResult
    );
    const openBenchSlots = safeNonnegativeInteger(
      projection.openBenchSlots,
      "team_projection_invalid",
      failResult
    );
    const openDefenceSlots = safeNonnegativeInteger(
      projection.openDefenceSlots,
      "team_projection_invalid",
      failResult
    );
    const openForwardSlots = safeNonnegativeInteger(
      projection.openForwardSlots,
      "team_projection_invalid",
      failResult
    );
    const structuralConflictCount =
      safeNonnegativeInteger(
        projection.structuralConflictCount,
        "team_projection_invalid",
        failResult
      );
    const placedCount =
      READINESS_FORWARD_SLOT_COUNT - openForwardSlots +
      READINESS_DEFENCE_SLOT_COUNT - openDefenceSlots +
      READINESS_BENCH_SLOT_COUNT - openBenchSlots;
    if (
      openForwardSlots > READINESS_FORWARD_SLOT_COUNT ||
      openDefenceSlots > READINESS_DEFENCE_SLOT_COUNT ||
      openBenchSlots > READINESS_BENCH_SLOT_COUNT ||
      structuralConflictCount > carryoverCount ||
      carryoverCount !==
        placedCount + structuralConflictCount
    ) {
      failResult("team_projection_invalid");
    }
    priorTeamId = teamId;
    return Object.freeze({
      carryoverCount,
      managerAssignmentId,
      managerReady: projection.managerReady,
      openBenchSlots,
      openDefenceSlots,
      openForwardSlots,
      structuralConflictCount,
      team,
      teamId,
    });
  });
  return Object.freeze(projections);
}

function readinessDiagnostics(value, reasonCode) {
  const source = requireArray(value, reasonCode);
  const identities = new Set();
  const diagnostics = source.map((diagnostic) => {
    requireExactObject(
      diagnostic,
      ["code", "message", "resourceId"],
      reasonCode,
      failResult
    );
    if (
      typeof diagnostic.code !== "string" ||
      !/^[A-Z0-9_]{1,100}$/.test(diagnostic.code)
    ) {
      failResult(reasonCode);
    }
    const normalized = Object.freeze({
      code: diagnostic.code,
      message: boundedText(
        diagnostic.message,
        500,
        reasonCode,
        failResult
      ),
      resourceId: nullableBoundedText(
        diagnostic.resourceId,
        500,
        reasonCode
      ),
    });
    const identity = serializeCanonicalJsonV1(normalized);
    if (identities.has(identity)) {
      failResult(`${reasonCode}_duplicate`);
    }
    identities.add(identity);
    return normalized;
  });
  return Object.freeze(diagnostics);
}

function normalizeFreeAgentDraftReadinessInternalDiagnostics(
  value
) {
  const source = requireArray(
    value,
    "readiness_internal_diagnostics_invalid"
  );
  if (source.length > 100) {
    failResult("readiness_internal_diagnostics_invalid");
  }
  const diagnostics = source.map((diagnostic) => {
    requireExactObject(
      diagnostic,
      [
        "code",
        "field",
        "message",
        "resourceId",
        "resourceType",
      ],
      "readiness_internal_diagnostics_invalid",
      failResult
    );
    if (
      typeof diagnostic.code !== "string" ||
      !/^[A-Z0-9_]{1,100}$/.test(diagnostic.code)
    ) {
      failResult(
        "readiness_internal_diagnostics_invalid"
      );
    }
    return Object.freeze({
      code: diagnostic.code,
      field: nullableBoundedText(
        diagnostic.field,
        100,
        "readiness_internal_diagnostics_invalid"
      ),
      resourceType: nullableBoundedText(
        diagnostic.resourceType,
        100,
        "readiness_internal_diagnostics_invalid"
      ),
      resourceId: nullableBoundedText(
        diagnostic.resourceId,
        500,
        "readiness_internal_diagnostics_invalid"
      ),
      message: boundedText(
        diagnostic.message,
        500,
        "readiness_internal_diagnostics_invalid",
        failResult
      ),
    });
  });
  diagnostics.sort(
    (left, right) =>
      compareUnicodeScalarStrings(
        left.code,
        right.code
      ) ||
      compareUnicodeScalarStrings(
        left.field ?? "",
        right.field ?? ""
      ) ||
      compareUnicodeScalarStrings(
        left.resourceType ?? "",
        right.resourceType ?? ""
      ) ||
      compareUnicodeScalarStrings(
        left.resourceId ?? "",
        right.resourceId ?? ""
      ) ||
      compareUnicodeScalarStrings(
        left.message,
        right.message
      )
  );
  const identities = diagnostics.map((diagnostic) =>
    serializeCanonicalJsonV1(diagnostic)
  );
  if (new Set(identities).size !== identities.length) {
    failResult(
      "readiness_internal_diagnostics_duplicate"
    );
  }
  return Object.freeze(diagnostics);
}

function projectFreeAgentDraftReadinessPublicDiagnostics(
  value
) {
  const publicDiagnostics =
    normalizeFreeAgentDraftReadinessInternalDiagnostics(
      value
    ).map((diagnostic) => {
      return {
        code: diagnostic.code,
        message: diagnostic.message,
        resourceId: diagnostic.resourceId,
      };
    });

  // Project only after canonical ordering so the public and internal
  // arrays have the same stable positional audit relationship.
  return readinessDiagnostics(
    publicDiagnostics,
    "readiness_public_diagnostics_invalid"
  );
}

function readinessAttemptProjection(
  value,
  { observedAtMs, outcome, seasonId }
) {
  requireExactObject(
    value,
    READINESS_ATTEMPT_PROJECTION_FIELDS,
    "readiness_attempt_projection_fields_invalid",
    failResult
  );
  const candidateDeadlineAtMs =
    value.candidateDeadlineAtMs === null
      ? null
      : safeTimestamp(
          value.candidateDeadlineAtMs,
          "readiness_clock_invalid",
          failResult
        );
  const reminderAtMs =
    value.reminderAtMs === null
      ? null
      : safeTimestamp(
          value.reminderAtMs,
          "readiness_clock_invalid",
          failResult
        );
  const helpOpensAtMs =
    value.helpOpensAtMs === null
      ? null
      : safeTimestamp(
          value.helpOpensAtMs,
          "readiness_clock_invalid",
          failResult
        );
  const clockValues = [
    candidateDeadlineAtMs,
    reminderAtMs,
    helpOpensAtMs,
  ];
  const presentClockValues = clockValues.filter(
    (item) => item !== null
  ).length;
  if (
    ![0, 3].includes(presentClockValues) ||
    (
      presentClockValues === 3 &&
      (
        reminderAtMs !==
          candidateDeadlineAtMs -
            FREE_AGENT_DRAFT_REMINDER_LEAD_MS ||
        helpOpensAtMs <
          candidateDeadlineAtMs -
            FREE_AGENT_DRAFT_HELP_WINDOW_MS ||
        helpOpensAtMs > candidateDeadlineAtMs
      )
    )
  ) {
    failResult("readiness_clock_invalid");
  }
  const participatingTeamCount =
    safeNonnegativeInteger(
      value.participatingTeamCount,
      "participating_team_count_invalid",
      failResult
    );
  const blockers = readinessDiagnostics(
    value.blockers,
    "readiness_blockers_invalid"
  );
  if (
    (outcome === "blocked" && blockers.length === 0) ||
    (outcome === "succeeded" && blockers.length !== 0)
  ) {
    failResult("readiness_attempt_outcome_invalid");
  }
  const firstMatchupWeekAfter =
    readinessWeekProjection(
      value.firstMatchupWeekAfter,
      "first_matchup_week_after_invalid"
    );
  const firstMatchupWeekBefore =
    readinessWeekProjection(
      value.firstMatchupWeekBefore,
      "first_matchup_week_before_invalid"
    );
  if (
    firstMatchupWeekBefore !== null &&
    firstMatchupWeekAfter !== null &&
    firstMatchupWeekAfter.startsAtMs <
      firstMatchupWeekBefore.startsAtMs
  ) {
    failResult("readiness_week_transition_invalid");
  }
  if (
    presentClockValues === 3 &&
    (
      firstMatchupWeekAfter === null ||
      candidateDeadlineAtMs !==
        firstMatchupWeekAfter.startsAtMs -
          FREE_AGENT_DRAFT_INITIAL_WINDOW_MS
    )
  ) {
    failResult("readiness_clock_invalid");
  }
  const initialRollovers = readinessInitialRollovers(
    value.initialRollovers,
    candidateDeadlineAtMs
  );
  const teamProjections = readinessTeamProjections(
    value.teamProjections,
    participatingTeamCount
  );
  if (
    outcome === "succeeded" &&
    (
      presentClockValues !== 3 ||
      firstMatchupWeekBefore === null ||
      firstMatchupWeekAfter === null ||
      candidateDeadlineAtMs <= observedAtMs ||
      participatingTeamCount === 0 ||
      teamProjections.some(
        (team) => !team.managerReady
      )
    )
  ) {
    failResult(
      "readiness_attempt_success_projection_incomplete"
    );
  }
  return deepFreeze({
    blockers,
    candidateDeadlineAtMs,
    firstMatchupWeekAfter,
    firstMatchupWeekBefore,
    helpOpensAtMs,
    initialRollovers,
    observedSeasonVersion: safePositiveInteger(
      value.observedSeasonVersion,
      "observed_season_version_invalid",
      failResult
    ),
    participatingTeamCount,
    priorSeasonRollover:
      readinessPriorSeasonRollover(
        value.priorSeasonRollover,
        seasonId
      ),
    reminderAtMs,
    teamProjections,
    warnings: readinessDiagnostics(
      value.warnings,
      "readiness_warnings_invalid"
    ),
  });
}

function createFreeAgentDraftReadinessAttemptEvidence(
  input = {}
) {
  requireExactObject(
    input,
    READINESS_ATTEMPT_INPUT_FIELDS,
    "readiness_attempt_fields_invalid",
    failResult
  );
  const id = stableId(
    input.id,
    "readiness_attempt_id_invalid",
    failResult
  );
  const leagueId = stableId(
    input.leagueId,
    "league_id_invalid",
    failResult
  );
  const seasonId = stableId(
    input.seasonId,
    "season_id_invalid",
    failResult
  );
  const readinessOperationId = stableId(
    input.readinessOperationId,
    "readiness_operation_id_invalid",
    failResult
  );
  const jobRunId = stableId(
    input.jobRunId,
    "job_run_id_invalid",
    failResult
  );
  const attemptNumber = safePositiveInteger(
    input.attemptNumber,
    "attempt_number_invalid",
    failResult
  );
  const observedReadinessVersion =
    safePositiveInteger(
      input.observedReadinessVersion,
      "observed_readiness_version_invalid",
      failResult
    );
  if (!["blocked", "succeeded"].includes(input.outcome)) {
    failResult("readiness_attempt_outcome_invalid");
  }
  const observedAtMs = safeTimestamp(
    input.observedAtMs,
    "observed_at_ms_invalid",
    failResult
  );
  const recordedAtMs = safeTimestamp(
    input.recordedAtMs,
    "recorded_at_ms_invalid",
    failResult
  );
  if (recordedAtMs < observedAtMs) {
    failResult("recorded_at_ms_invalid");
  }
  const projection = readinessAttemptProjection(
    input.projection,
    {
      observedAtMs,
      outcome: input.outcome,
      seasonId,
    }
  );
  let projectionJson;
  let projectionSha256;
  try {
    projectionJson = serializeCanonicalJsonV1(projection);
    projectionSha256 = hashCanonicalJsonV1(projection);
  } catch {
    failResult("readiness_attempt_projection_invalid");
  }
  return deepFreeze({
    attemptNumber,
    id,
    jobRunId,
    leagueId,
    observedAtMs,
    observedReadinessVersion,
    outcome: input.outcome,
    projection,
    projectionJson,
    projectionSha256,
    readinessOperationId,
    recordedAtMs,
    seasonId,
    version: 1,
  });
}

const READINESS_ATTEMPT_EVIDENCE_FIELDS =
  Object.freeze([
    ...READINESS_ATTEMPT_INPUT_FIELDS.filter(
      (key) => key !== "projection"
    ),
    "projectionJson",
    "projectionSha256",
    "version",
  ]);

function validateFreeAgentDraftReadinessAttemptEvidence(
  input = {}
) {
  requireExactObject(
    input,
    READINESS_ATTEMPT_EVIDENCE_FIELDS,
    "readiness_attempt_evidence_fields_invalid",
    failResult
  );
  let projection;
  try {
    projection = parseCanonicalJsonV1(
      input.projectionJson
    );
  } catch {
    failResult("readiness_attempt_projection_json_invalid");
  }
  const rebuilt =
    createFreeAgentDraftReadinessAttemptEvidence({
      ...Object.fromEntries(
        READINESS_ATTEMPT_INPUT_FIELDS
          .filter((key) => key !== "projection")
          .map((key) => [key, input[key]])
      ),
      projection,
    });
  if (
    input.version !== 1 ||
    input.projectionJson !== rebuilt.projectionJson ||
    sha256(
      input.projectionSha256,
      "projection_sha256_invalid",
      failResult
    ) !== rebuilt.projectionSha256
  ) {
    failResult("readiness_attempt_evidence_invalid");
  }
  return rebuilt;
}

const RETRY_RECEIPT_INPUT_FIELDS = Object.freeze([
  "acceptedAtMs",
  "acceptedFromVersion",
  "actorAuthority",
  "actorMembershipId",
  "actorUserId",
  "id",
  "idempotencyRequestId",
  "jobRunId",
  "leagueId",
  "occurrenceKey",
  "readinessOperationId",
  "requestSha256",
  "resultingReadinessVersion",
  "retryAttemptNumber",
  "seasonId",
]);

function createFreeAgentDraftReadinessRetryReceipt(
  input = {}
) {
  requireExactObject(
    input,
    RETRY_RECEIPT_INPUT_FIELDS,
    "retry_receipt_fields_invalid",
    failResult
  );
  const leagueId = stableId(
    input.leagueId,
    "league_id_invalid",
    failResult
  );
  const seasonId = stableId(
    input.seasonId,
    "season_id_invalid",
    failResult
  );
  const id = stableId(
    input.id,
    "receipt_id_invalid",
    failResult
  );
  const readinessOperationId = stableId(
    input.readinessOperationId,
    "readiness_operation_id_invalid",
    failResult
  );
  const idempotencyRequestId = stableId(
    input.idempotencyRequestId,
    "idempotency_request_id_invalid",
    failResult
  );
  const actorUserId = stableId(
    input.actorUserId,
    "actor_user_id_invalid",
    failResult
  );
  const actorMembershipId = stableId(
    input.actorMembershipId,
    "actor_membership_id_invalid",
    failResult
  );
  if (
    !FREE_AGENT_DRAFT_READINESS_AUTHORITIES.includes(
      input.actorAuthority
    )
  ) {
    failResult("actor_authority_invalid");
  }
  const acceptedFromVersion =
    safePositiveInteger(
      input.acceptedFromVersion,
      "accepted_from_version_invalid",
      failResult
    );
  const resultingReadinessVersion =
    safePositiveInteger(
      input.resultingReadinessVersion,
      "resulting_readiness_version_invalid",
      failResult
    );
  if (
    resultingReadinessVersion !==
      acceptedFromVersion + 1
  ) {
    failResult(
      "resulting_readiness_version_invalid"
    );
  }
  const retryAttemptNumber = safePositiveInteger(
    input.retryAttemptNumber,
    "retry_attempt_number_invalid",
    failResult
  );
  const jobRunId = stableId(
    input.jobRunId,
    "job_run_id_invalid",
    failResult
  );
  if (
    typeof input.occurrenceKey !== "string" ||
    input.occurrenceKey.length < 1 ||
    input.occurrenceKey.length > 500 ||
    input.occurrenceKey !== input.occurrenceKey.trim()
  ) {
    failResult("occurrence_key_invalid");
  }
  let parsed;
  try {
    parsed = parseFreeAgentDraftOccurrenceKey(
      input.occurrenceKey
    );
  } catch {
    failResult("occurrence_key_invalid");
  }
  if (
    parsed.type !== "readiness" ||
    parsed.leagueId !== leagueId ||
    parsed.seasonId !== seasonId
  ) {
    failResult("occurrence_key_invalid");
  }
  const acceptedAtMs = safeTimestamp(
    input.acceptedAtMs,
    "accepted_at_ms_invalid",
    failResult
  );
  const requestSha256 = sha256(
    input.requestSha256,
    "request_sha256_invalid",
    failResult
  );
  const expectedRequestSha256 = hashCanonicalJsonV1({
    actorUserId,
    body: {
      confirmation:
        FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
      readinessOperationId,
      seasonId,
    },
    domain:
      FREE_AGENT_DRAFT_READINESS_REQUEST_DOMAIN,
    expectedVersion: acceptedFromVersion,
    leagueId,
    operation:
      FREE_AGENT_DRAFT_READINESS_RETRY_OPERATION,
    schemaVersion:
      FREE_AGENT_DRAFT_READINESS_SCHEMA_VERSION,
  });
  if (requestSha256 !== expectedRequestSha256) {
    failResult("request_sha256_invalid");
  }
  const data = deepFreeze({
    acceptedAtMs,
    acceptedFromVersion,
    jobRunId,
    leagueId,
    occurrenceKey: input.occurrenceKey,
    readinessOperationId,
    resultingReadinessVersion,
    retryAttemptNumber,
    retryReceiptId: id,
    seasonId,
    status: "accepted",
  });
  const responseJson =
    serializeCanonicalJsonV1(data);
  const responseSha256 =
    hashCanonicalJsonV1(data);

  return deepFreeze({
    acceptedAtMs,
    acceptedFromVersion,
    actorAuthority: input.actorAuthority,
    actorMembershipId,
    actorUserId,
    data,
    id,
    idempotencyRequestId,
    jobRunId,
    leagueId,
    occurrenceKey: input.occurrenceKey,
    readinessOperationId,
    requestSha256,
    responseHttpStatus:
      FREE_AGENT_DRAFT_READINESS_RETRY_HTTP_STATUS,
    responseJson,
    responseSha256,
    resultingReadinessVersion,
    retryAttemptNumber,
    seasonId,
    version: 1,
  });
}

const RETRY_RECEIPT_EVIDENCE_FIELDS = Object.freeze([
  ...RETRY_RECEIPT_INPUT_FIELDS,
  "responseHttpStatus",
  "responseJson",
  "responseSha256",
  "version",
]);

function validateFreeAgentDraftReadinessRetryReceipt(
  input = {}
) {
  requireExactObject(
    input,
    RETRY_RECEIPT_EVIDENCE_FIELDS,
    "retry_receipt_evidence_fields_invalid",
    failResult
  );
  const rebuilt =
    createFreeAgentDraftReadinessRetryReceipt(
      Object.fromEntries(
        RETRY_RECEIPT_INPUT_FIELDS.map(
          (key) => [key, input[key]]
        )
      )
    );
  if (
    input.version !== 1 ||
    input.responseHttpStatus !==
      FREE_AGENT_DRAFT_READINESS_RETRY_HTTP_STATUS ||
    input.responseJson !== rebuilt.responseJson ||
    sha256(
      input.responseSha256,
      "response_sha256_invalid"
    ) !== rebuilt.responseSha256
  ) {
    failResult("retry_receipt_evidence_invalid");
  }
  return rebuilt;
}

module.exports = {
  FREE_AGENT_DRAFT_READINESS_AUTHORITIES,
  FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
  FREE_AGENT_DRAFT_READINESS_POLICY_CODES,
  FREE_AGENT_DRAFT_READINESS_REQUEST_DOMAIN,
  FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
  FREE_AGENT_DRAFT_READINESS_RETRY_HTTP_STATUS,
  FREE_AGENT_DRAFT_READINESS_RETRY_OPERATION,
  FREE_AGENT_DRAFT_READINESS_SCHEMA_VERSION,
  FREE_AGENT_DRAFT_READINESS_TRIGGER_KINDS,
  FreeAgentDraftReadinessPolicyError,
  createFreeAgentDraftReadinessMissingScheduleBlocker,
  createFreeAgentDraftReadinessAttemptEvidence,
  createFreeAgentDraftReadinessRetryReceipt,
  createFreeAgentDraftReadinessRetryRequest,
  createFreeAgentDraftReadinessTriggerPlan,
  normalizeFreeAgentDraftReadinessInternalDiagnostics,
  projectFreeAgentDraftReadinessPublicDiagnostics,
  validateFreeAgentDraftReadinessAttemptEvidence,
  validateFreeAgentDraftReadinessRetryReceipt,
};
