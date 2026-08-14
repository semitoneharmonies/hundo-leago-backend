const crypto = require("node:crypto");
const {
  isDeepStrictEqual,
} = require("node:util");

const {
  createFreeAgentDraftReadinessTriggerPlan,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  createFreeAgentDraftActivityContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftActivityContracts"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  FORBIDDEN_TEXT_PATTERN,
  INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
  INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
  LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
  LeagueLifecycleTransitionPolicyError,
  RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  UUID_PATTERN,
  leagueLifecycleTransitionRequestHash,
  validateLeagueLifecycleTransitionExpectedVersion,
  validateLeagueLifecycleTransitionIdempotencyKey,
  validateLeagueLifecycleTransitionInput,
  validateLeagueLifecycleTransitionLeagueId,
  validateScheduledEntryDraftRolloverInput,
  validateSeasonRolloverCalendar,
} = require(
  "../../../domain/leagues/leagueLifecycleTransitionPolicy"
);
const {
  parseSeasonRolloverOccurrenceKey,
} = require(
  "../../../domain/leagues/seasonRolloverJobPolicy"
);
const {
  hashSeasonRolloverSourceReadiness,
  parseCanonicalJsonV1,
  serializeSeasonRolloverSourceReadiness,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);

const IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1000;
const SEASON_ROLLOVER_RESULT_TYPE =
  "season_rollover";
const SEASON_ROLLOVER_ATTEMPT_RESULT_TYPE =
  "season_rollover_attempt";
const SETUP_EXEMPTION_RESULT_TYPE =
  "free_agent_draft_setup_exemption";
const SETUP_EXEMPTION_KIND =
  "initial_season2_transition";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const LATE_LOCK_STATUSES = new Set([
  "awaiting_data",
  "completed",
  "not_applicable",
  "still_illegal",
]);
const AWAITING_DATA_LATE_LOCK = Object.freeze({
  status: "awaiting_data",
});
const NOT_APPLICABLE_LATE_LOCK = Object.freeze({
  status: "not_applicable",
});

const SUMMARY_KEYS = Object.freeze([
  "contractsAdvanced",
  "contractsExpired",
  "ownershipsCarried",
  "ownershipsReleased",
  "retentionYearsAdvanced",
  "retentionObligationsCompleted",
  "buyoutYearsAdvanced",
  "buyoutObligationsCompleted",
  "tradesCancelled",
]);

const REPOSITORY_METHODS = Object.freeze([
  "findIdempotencyRequest",
  "findDurableSeasonRolloverAttempt",
  "findDurableSeasonRolloverResult",
  "findDurableSeasonRolloverOwnershipReceipt",
  "findDurableSetupExemptionResult",
  "findRolloverBindingByOccurrence",
  "findSeasonRolloverAttemptByIdempotencyRequest",
  "findLatestSeasonRolloverAttempt",
  "validateScheduledRolloverJobLease",
  "beginSeasonRolloverAttempt",
  "readSeasonRolloverContext",
  "blockSeasonRolloverAttempt",
  "commitSeasonRolloverAndOpenDraft",
  "readInitialSeason2ExemptionContext",
  "verifyInitialSeason2Evidence",
  "insertStartedIdempotencyRequest",
  "appendSetupExemptionEvidence",
  "insertSetupExemption",
  "verifySetupExemptionEvidence",
  "completeIdempotencyRequest",
]);

const ROLLOVER_CONTEXT_KEYS = Object.freeze([
  "aggregate",
  "sourceReadiness",
  "matrix",
  "entryDraft",
]);
const SCHEDULED_JOB_KEYS = Object.freeze([
  "runId",
  "occurrenceKey",
  "scheduledForMs",
  "leaseOwner",
  "leaseToken",
  "expectedVersion",
]);
const ROLLOVER_BINDING_KEYS = Object.freeze([
  "bindingId",
  "leagueId",
  "entryDraftId",
  "rolloverOccurrenceId",
  "fromSeasonId",
  "toSeasonId",
  "scheduledStartsAtMs",
  "occurrenceKey",
  "targetScheduleId",
  "targetScheduleVersion",
  "weekOneMatchupWeekId",
  "weekOneStartsAtMs",
  "status",
  "selectionGateStatus",
  "tradingGateStatus",
  "sourceSeasonVersion",
  "targetSeasonVersion",
  "entryDraftVersion",
  "version",
]);
const ROLLOVER_ATTEMPT_KEYS = Object.freeze([
  "attemptId",
  "bindingId",
  "leagueId",
  "entryDraftId",
  "rolloverOccurrenceId",
  "fromSeasonId",
  "toSeasonId",
  "attemptNumber",
  "triggerKind",
  "scheduledJobRunId",
  "retryIdempotencyRequestId",
  "retryActorUserId",
  "retryActorMembershipId",
  "retryAuthority",
  "status",
  "blockers",
  "rolloverId",
  "startedAtMs",
  "terminalAtMs",
  "observedSourceSeasonVersion",
  "observedTargetSeasonVersion",
  "observedEntryDraftVersion",
  "targetScheduleId",
  "targetScheduleVersion",
  "weekOneMatchupWeekId",
  "weekOneStartsAtMs",
  "version",
]);
const ROLLOVER_ATTEMPT_RESULT_KEYS =
  Object.freeze([
    "attemptId",
    "bindingId",
    "leagueId",
    "entryDraftId",
    "rolloverOccurrenceId",
    "fromSeasonId",
    "toSeasonId",
    "attemptNumber",
    "triggerKind",
    "status",
    "blockers",
    "rolloverId",
    "startedAtMs",
    "terminalAtMs",
    "targetScheduleId",
    "targetScheduleVersion",
    "weekOneMatchupWeekId",
    "weekOneStartsAtMs",
    "version",
  ]);
const ROLLOVER_COMMIT_RECEIPT_KEYS =
  Object.freeze([
    "rolloverId",
    "rolloverAttemptId",
    "leagueId",
    "fromSeasonId",
    "toSeasonId",
    "fromSeasonStatus",
    "toSeasonStatus",
    "targetNhlSeasonKey",
    "nhlRegularSeasonStartsAtMs",
    "nhlRegularSeasonEndsAtMs",
    "fantasyPlayoffsStartAtMs",
    "fantasyPlayoffsEndAtMs",
    "sourceFadId",
    "sourceFinalizationRootId",
    "sourceFinalizationId",
    "sourceStandingsSnapshotId",
    "sourceStandingsOperationId",
    "sourceReadinessSchemaVersion",
    "sourceReadinessSha256",
    "entryDraftId",
    "entryDraftRolloverBindingId",
    "rolloverOccurrenceId",
    "scheduledStartsAtMs",
    "occurrenceKey",
    "targetScheduleId",
    "targetScheduleVersion",
    "weekOneMatchupWeekId",
    "weekOneStartsAtMs",
    "trigger",
    "leagueVersion",
    "fromSeasonVersion",
    "toSeasonVersion",
    "entryDraftVersion",
    "firstPickClockId",
    "completedAtMs",
    "retryAuthorizedByUserId",
    "retryAuthorizedAuthority",
    "summary",
    "version",
  ]);
const ROLLOVER_OWNERSHIP_RECEIPT_KEYS =
  Object.freeze([
    "rolloverId",
    "leagueId",
    "fromSeasonId",
    "toSeasonId",
    "teams",
  ]);
const ROLLOVER_OWNERSHIP_TEAM_KEYS =
  Object.freeze([
    "leagueId",
    "seasonId",
    "teamId",
    "ownershipWitnesses",
  ]);
const ROLLOVER_OWNERSHIP_WITNESS_KEYS =
  Object.freeze([
    "ownershipId",
    "ownershipVersion",
    "state",
  ]);
const ROLLOVER_BLOCKER_KEYS = Object.freeze([
  "code",
  "field",
  "resourceType",
  "resourceId",
  "message",
]);
const ENTRY_DRAFT_CONTEXT_KEYS = Object.freeze([
  "id",
  "leagueId",
  "targetSeasonId",
  "status",
  "version",
  "startsAtMs",
  "pickClockSeconds",
  "selectionGateStatus",
  "tradingGateStatus",
  "scheduleAuthorizingUserId",
  "scheduleAuthorizingMembershipId",
  "scheduleAuthorizingAuthority",
  "targetScheduleId",
  "targetScheduleVersion",
  "weekOneMatchupWeekId",
  "weekOneStartsAtMs",
  "firstUnusedPick",
]);
const FIRST_UNUSED_PICK_KEYS = Object.freeze([
  "id",
  "owningTeamId",
  "roundNumber",
  "positionNumber",
  "version",
  "status",
]);
const SOURCE_READINESS_ENVELOPE_KEYS =
  Object.freeze([
    "schemaVersion",
    "projection",
    "projectionJson",
    "projectionSha256",
  ]);
const SOURCE_READINESS_PROJECTION_KEYS =
  Object.freeze([
    "leagueId",
    "fromSeasonId",
    "observedAtMs",
    "sourceFadId",
    "sourceFadCompletedAtMs",
    "sourceFinalizationRootId",
    "sourceFinalizationId",
    "sourceStandingsSnapshotId",
    "sourceStandingsOperationId",
    "recognizedSeasonOperationTables",
    "freeAgentDraft",
    "freeAgentDraftReadinessOperation",
    "freeAgentDraftTeams",
    "candidateCards",
    "candidateCardEntries",
    "candidateCardRevisions",
    "candidateCardHelpRequests",
    "candidateCardSnapshots",
    "candidateCardSnapshotEntries",
    "freeAgentDraftPlayerAllocations",
    "freeAgentDraftAllocationEvents",
    "freeAgentDraftRollovers",
    "freeAgentDraftNominationQueue",
    "freeAgentDraftRecoveries",
    "auctionContexts",
    "freeAgentDraftAuctionParticipants",
    "freeAgentDraftDraws",
    "auctions",
    "auctionBids",
    "auctionResolutions",
    "matchupWeeks",
    "matchups",
    "matchupResults",
    "matchupResultVersions",
    "matchupOperations",
    "standingsOperations",
    "jobRuns",
    "trades",
    "tradeAssets",
    "finalStandingsFinalizations",
    "standingsSnapshots",
    "standingsRows",
    "standingsSnapshotTeamIdentities",
    "standingsSnapshotResultVersions",
    "finalizationIdempotencyRequests",
  ]);
const SOURCE_READINESS_COLLECTION_KEYS =
  Object.freeze([
    "freeAgentDraftTeams",
    "candidateCards",
    "candidateCardEntries",
    "candidateCardRevisions",
    "candidateCardHelpRequests",
    "candidateCardSnapshots",
    "candidateCardSnapshotEntries",
    "freeAgentDraftPlayerAllocations",
    "freeAgentDraftAllocationEvents",
    "freeAgentDraftRollovers",
    "freeAgentDraftNominationQueue",
    "freeAgentDraftRecoveries",
    "auctionContexts",
    "freeAgentDraftAuctionParticipants",
    "freeAgentDraftDraws",
    "auctions",
    "auctionBids",
    "auctionResolutions",
    "matchupWeeks",
    "matchups",
    "matchupResults",
    "matchupResultVersions",
    "matchupOperations",
    "standingsOperations",
    "jobRuns",
    "trades",
    "tradeAssets",
    "finalStandingsFinalizations",
    "standingsSnapshots",
    "standingsRows",
    "standingsSnapshotTeamIdentities",
    "standingsSnapshotResultVersions",
    "finalizationIdempotencyRequests",
  ]);
const RECOGNIZED_SEASON_OPERATION_TABLES =
  Object.freeze([
    "matchup_operations",
    "standings_operations",
  ]);
const ROLLOVER_AGGREGATE_KEYS = Object.freeze([
  "leagueId",
  "leagueStatus",
  "leagueTimeZone",
  "leagueVersion",
  "currentSeasonId",
  "sourceSeasonId",
  "sourceSeasonStatus",
  "sourceSeasonVersion",
  "sourceSeasonLabel",
  "sourceNhlSeasonKey",
  "sourceNhlRegularSeasonStartsAtMs",
  "sourceNhlRegularSeasonEndsAtMs",
  "sourceFantasyPlayoffsStartAtMs",
  "sourceFantasyPlayoffsEndAtMs",
  "sourceFreeAgentDraftCompletedAtMs",
  "sourceRolloverCount",
  "targetRolloverCount",
  "targetIdentityCount",
  "targetIdentityConflict",
  "targetSeason",
]);
const TARGET_SEASON_KEYS = Object.freeze([
  "id",
  "leagueId",
  "label",
  "nhlSeasonKey",
  "status",
  "version",
  "nhlRegularSeasonStartsAtMs",
  "nhlRegularSeasonEndsAtMs",
  "fantasyPlayoffsStartAtMs",
  "fantasyPlayoffsEndAtMs",
  "freeAgentDraftCompletedAtMs",
  "targetScheduleId",
  "targetScheduleVersion",
  "weekOneMatchupWeekId",
  "weekOneStartsAtMs",
  "scheduleReady",
  "disallowedStateCount",
]);
const MATRIX_KEYS = Object.freeze([
  "violations",
  "totals",
  "contractEffects",
  "ownershipEffects",
  "retentionEffects",
  "buyoutEffects",
  "tradeEffects",
]);
const MATRIX_TOTAL_KEYS = Object.freeze([
  "activeContractIds",
  "liveOwnershipIds",
  "activeRetentionIds",
  "activeBuyoutIds",
  "qualifyingTradeIds",
]);
const CONTRACT_EFFECT_KEYS = Object.freeze([
  "entityId",
  "effectKind",
  "ownershipId",
  "before",
]);
const OWNERSHIP_EFFECT_KEYS = Object.freeze([
  "entityId",
  "effectKind",
  "contractId",
  "before",
]);
const OBLIGATION_EFFECT_KEYS = Object.freeze([
  "entityId",
  "effectKind",
  "before",
]);
const TRADE_EFFECT_KEYS = Object.freeze([
  "entityId",
  "effectKind",
  "causalEffects",
  "before",
]);
const CAUSAL_EFFECT_KEYS = Object.freeze([
  "tradeAssetSequence",
  "tradeAssetType",
  "effectKind",
  "entityId",
]);
const CONTRACT_PROJECTION_KEYS = Object.freeze([
  "id",
  "playerId",
  "currentTeamId",
  "contractType",
  "originalTotalValueCents",
  "originalTermYears",
  "aavCents",
  "startSeasonId",
  "status",
  "acquisitionSourceType",
  "acquisitionSourceId",
  "auctionBuyoutLockExpiresAtMs",
  "createdAtMs",
  "updatedAtMs",
  "version",
  "years",
]);
const CONTRACT_YEAR_KEYS = Object.freeze([
  "id",
  "seasonId",
  "yearNumber",
  "aavCents",
  "status",
  "rolloverAtMs",
  "createdAtMs",
]);
const OWNERSHIP_PROJECTION_KEYS = Object.freeze([
  "exists",
  "id",
  "seasonId",
  "playerId",
  "teamId",
  "ownershipKind",
  "rosterCategory",
  "positionGroup",
  "slotNumber",
  "acquiredTransactionType",
  "acquiredTransactionId",
  "tradeBlocked",
  "createdAtMs",
  "updatedAtMs",
  "version",
  "displayOrderEntries",
]);
const DISPLAY_ORDER_ENTRY_KEYS = Object.freeze([
  "id",
  "leagueId",
  "orderSetId",
  "ownershipId",
  "positionGroup",
  "displayOrder",
  "createdAtMs",
]);
const RETENTION_PROJECTION_KEYS = Object.freeze([
  "id",
  "contractId",
  "playerId",
  "originatingTeamId",
  "responsibleTeamId",
  "retainedAavCents",
  "creationTradeId",
  "status",
  "createdAtMs",
  "updatedAtMs",
  "version",
  "years",
]);
const BUYOUT_PROJECTION_KEYS = Object.freeze([
  "id",
  "contractId",
  "playerId",
  "originatingTeamId",
  "responsibleTeamId",
  "annualPenaltyBasisCents",
  "buyoutTransactionId",
  "status",
  "createdAtMs",
  "updatedAtMs",
  "version",
  "years",
]);
const OBLIGATION_YEAR_KEYS = Object.freeze([
  "id",
  "seasonId",
  "amountCents",
  "status",
  "createdAtMs",
]);
const TRADE_PROJECTION_KEYS = Object.freeze([
  "id",
  "seasonId",
  "proposingTeamId",
  "receivingTeamId",
  "proposingUserId",
  "creatingMembershipId",
  "creatingAuthority",
  "status",
  "createdAtMs",
  "expiresAtMs",
  "effectiveDeadlineAtMs",
  "respondedAtMs",
  "completedAtMs",
  "commissionerCompletionReference",
  "proposalModelVersion",
  "updatedAtMs",
  "version",
  "assets",
]);
const TRADE_ASSET_KEYS = Object.freeze([
  "id",
  "leagueId",
  "tradeId",
  "direction",
  "sourceTeamId",
  "destinationTeamId",
  "assetType",
  "contractId",
  "playerId",
  "draftPickId",
  "retentionObligationId",
  "buyoutObligationId",
  "futureConsiderationId",
  "requestedRetentionContractId",
  "requestedRetentionCents",
  "futureConsiderationDescription",
  "proposalSnapshotJson",
  "assetModelVersion",
  "sequence",
  "createdAtMs",
]);

const EXEMPTION_CONTEXT_KEYS = Object.freeze([
  "aggregate",
  "migrationReports",
  "bootstrap",
]);
const EXEMPTION_AGGREGATE_KEYS = Object.freeze([
  "leagueId",
  "leagueStatus",
  "currentSeasonId",
  "seasonCount",
  "seasonId",
  "seasonStatus",
  "seasonLabel",
  "nhlSeasonKey",
  "entryDraftCount",
  "fadCount",
  "exemptionCount",
  "fadSetupCount",
  "weekOneCount",
  "weekOneStartsAtMs",
  "commissionerMembershipCount",
  "commissionerMembershipId",
  "commissionerUserId",
  "commissionerPermissionCategory",
  "commissionerMembershipStatus",
  "commissionerJoinedAtMs",
  "commissionerEndedAtMs",
  "commissionerUserStatus",
  "commissionerNotificationEligible",
]);
const MIGRATION_REPORT_KEYS = Object.freeze([
  "id",
  "leagueId",
  "sourceBundleId",
  "resetManifestId",
  "databaseSchemaVersion",
  "status",
  "startedAtMs",
  "completedAtMs",
  "createdAtMs",
  "projectionSha256",
  "shapeValid",
]);
const BOOTSTRAP_KEYS = Object.freeze([
  "valid",
  "projectionSha256",
  "idempotencyRequestId",
  "activityId",
  "securityAuditEventId",
  "actorUserId",
]);

const IDEMPOTENCY_ROW_KEYS = Object.freeze([
  "id",
  "leagueId",
  "actorUserId",
  "operation",
  "clientKey",
  "requestHash",
  "status",
  "resultType",
  "resultId",
  "createdAtMs",
  "completedAtMs",
  "expiresAtMs",
]);

const EXEMPTION_RESULT_KEYS = Object.freeze([
  "exemptionId",
  "leagueId",
  "seasonId",
  "exemptionKind",
  "reason",
  "authorizedByUserId",
  "authorizedAuthority",
  "authorizedAtMs",
  "consumed",
  "migrationReportId",
  "version",
]);

class LeagueLifecycleTransitionServiceError
  extends Error {
  constructor(code, { details, reasonCode } = {}) {
    super(
      "The league lifecycle transition cannot be completed."
    );
    this.name =
      "LeagueLifecycleTransitionServiceError";
    this.code = code;
    if (reasonCode !== undefined) {
      this.reasonCode = reasonCode;
    }
    if (details !== undefined) {
      this.details = Object.freeze({
        ...details,
      });
    }
  }
}

function fail(code, options) {
  throw new LeagueLifecycleTransitionServiceError(
    code,
    options
  );
}

function failRollover(reasonCode) {
  fail("SEASON_ROLLOVER_NOT_READY", {
    reasonCode,
  });
}

function failExemption(reasonCode) {
  fail("INITIAL_SEASON2_NO_DRAFT_NOT_ELIGIBLE", {
    reasonCode,
  });
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `league lifecycle transition requires ${description}`
    );
  }
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

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string")
  ) {
    return false;
  }
  const expected = new Set(expectedKeys);
  return keys.every((key) => expected.has(key));
}

function safeTimestamp(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  );
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function stableId(value) {
  return (
    typeof value === "string" &&
    UUID_PATTERN.test(value)
  );
}

function safeText(value, maximum = 500) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    value === value.trim() &&
    !FORBIDDEN_TEXT_PATTERN.test(value)
  );
}

function safeNullableText(
  value,
  maximum = 500
) {
  return value === null || safeText(value, maximum);
}

function compareRolloverBlockers(left, right) {
  for (const key of [
    "code",
    "resourceType",
    "resourceId",
    "field",
    "message",
  ]) {
    const comparison = String(left[key] ?? "").localeCompare(
      String(right[key] ?? ""),
      "en",
      {
        sensitivity: "variant",
        usage: "sort",
      }
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function canonicalRolloverBlockers(
  value,
  { requireNonempty = false } = {}
) {
  if (
    !Array.isArray(value) ||
    (requireNonempty && value.length === 0) ||
    value.some(
      (blocker) =>
        !hasExactKeys(
          blocker,
          ROLLOVER_BLOCKER_KEYS
        ) ||
        typeof blocker.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,99}$/.test(
          blocker.code
        ) ||
        !safeNullableText(blocker.field, 100) ||
        !safeNullableText(
          blocker.resourceType,
          100
        ) ||
        !(
          blocker.resourceId === null ||
          stableId(blocker.resourceId)
        ) ||
        !safeText(blocker.message, 500)
    )
  ) {
    failRollover("blockers_invalid");
  }
  const blockers = value
    .map((blocker) => ({ ...blocker }))
    .sort(compareRolloverBlockers);
  if (
    new Set(
      blockers.map((blocker) =>
        JSON.stringify(blocker)
      )
    ).size !== blockers.length
  ) {
    failRollover("blockers_invalid");
  }
  return deepFreeze(blockers);
}

function blockerCodeFromReason(reasonCode) {
  const normalized =
    typeof reasonCode === "string"
      ? reasonCode
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9_]+/g, "_")
      : "";
  return /^[A-Z][A-Z0-9_]{0,99}$/.test(
    normalized
  )
    ? normalized
    : "SEASON_ROLLOVER_EXECUTION_FAILED";
}

function rolloverBlockersFromError(error) {
  const chain = errorChain(error);
  for (const candidate of chain) {
    const supplied =
      candidate?.blockers ??
      candidate?.details?.blockers;
    if (Array.isArray(supplied)) {
      return canonicalRolloverBlockers(
        supplied,
        { requireNonempty: true }
      );
    }
  }
  const reasonCode =
    chain.find(
      (candidate) =>
        typeof candidate?.reasonCode === "string"
    )?.reasonCode ??
    "season_rollover_execution_failed";
  return canonicalRolloverBlockers(
    [
      {
        code: blockerCodeFromReason(reasonCode),
        field: null,
        resourceType: "season_rollover",
        resourceId: null,
        message:
          "The scheduled season rollover prerequisite is not satisfied.",
      },
    ],
    { requireNonempty: true }
  );
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

function inspectScheduledJob({
  value,
  leagueId,
  input,
}) {
  if (
    !hasExactKeys(value, SCHEDULED_JOB_KEYS) ||
    !stableId(value.runId) ||
    !safeTimestamp(value.scheduledForMs) ||
    !safeText(value.occurrenceKey, 300) ||
    !safeText(value.leaseOwner, 200) ||
    !safeText(value.leaseToken, 500) ||
    !safePositiveInteger(value.expectedVersion)
  ) {
    throw new TypeError(
      "league lifecycle transition requires a canonical scheduled job lease"
    );
  }
  parseSeasonRolloverOccurrenceKey({
    leagueId,
    entryDraftId: input.entryDraftId,
    rolloverOccurrenceId:
      input.rolloverOccurrenceId,
    occurrenceKey: value.occurrenceKey,
    scheduledForMs: value.scheduledForMs,
  });
  return deepFreeze({ ...value });
}

function inspectRolloverBinding({
  value,
  leagueId,
  input,
}) {
  if (
    !hasExactKeys(value, ROLLOVER_BINDING_KEYS) ||
    ![
      value.bindingId,
      value.entryDraftId,
      value.rolloverOccurrenceId,
      value.fromSeasonId,
      value.toSeasonId,
      value.targetScheduleId,
      value.weekOneMatchupWeekId,
    ].every(stableId) ||
    value.leagueId !== leagueId ||
    value.entryDraftId !== input.entryDraftId ||
    value.rolloverOccurrenceId !==
      input.rolloverOccurrenceId ||
    value.fromSeasonId === value.toSeasonId ||
    !safeTimestamp(value.scheduledStartsAtMs) ||
    !safeText(value.occurrenceKey, 300) ||
    !safePositiveInteger(
      value.targetScheduleVersion
    ) ||
    !safeTimestamp(value.weekOneStartsAtMs) ||
    !safePositiveInteger(
      value.sourceSeasonVersion
    ) ||
    !safePositiveInteger(
      value.targetSeasonVersion
    ) ||
    !safePositiveInteger(value.entryDraftVersion) ||
    !safePositiveInteger(value.version) ||
    ![
      "scheduled",
      "superseded",
      "blocked",
      "succeeded",
    ].includes(
      value.status
    ) ||
    !["locked", "open"].includes(
      value.selectionGateStatus
    ) ||
    !["locked", "open"].includes(
      value.tradingGateStatus
    )
  ) {
    failRollover("rollover_binding_invalid");
  }
  const succeeded = value.status === "succeeded";
  if (
    value.selectionGateStatus !==
      (succeeded ? "open" : "locked") ||
    value.tradingGateStatus !==
      (succeeded ? "open" : "locked")
  ) {
    failRollover("rollover_binding_invalid");
  }
  return deepFreeze({ ...value });
}

function inspectRolloverAttempt({
  value,
  binding = null,
}) {
  if (
    !hasExactKeys(value, ROLLOVER_ATTEMPT_KEYS) ||
    ![
      value.attemptId,
      value.bindingId,
      value.leagueId,
      value.entryDraftId,
      value.rolloverOccurrenceId,
      value.fromSeasonId,
      value.toSeasonId,
      value.targetScheduleId,
      value.weekOneMatchupWeekId,
    ].every(stableId) ||
    (binding !== null &&
      (value.bindingId !== binding.bindingId ||
        value.leagueId !== binding.leagueId ||
        value.entryDraftId !==
          binding.entryDraftId ||
        value.rolloverOccurrenceId !==
          binding.rolloverOccurrenceId ||
        value.fromSeasonId !==
          binding.fromSeasonId ||
        value.toSeasonId !==
          binding.toSeasonId ||
        value.targetScheduleId !==
          binding.targetScheduleId ||
        value.targetScheduleVersion !==
          binding.targetScheduleVersion ||
        value.weekOneMatchupWeekId !==
          binding.weekOneMatchupWeekId ||
        value.weekOneStartsAtMs !==
          binding.weekOneStartsAtMs)) ||
    !safePositiveInteger(value.attemptNumber) ||
    !["scheduled_job", "commissioner_retry"].includes(
      value.triggerKind
    ) ||
    !["started", "blocked", "succeeded"].includes(
      value.status
    ) ||
    !safeTimestamp(value.startedAtMs) ||
    !safePositiveInteger(
      value.observedSourceSeasonVersion
    ) ||
    !safePositiveInteger(
      value.observedTargetSeasonVersion
    ) ||
    !safePositiveInteger(
      value.observedEntryDraftVersion
    ) ||
    !safePositiveInteger(value.targetScheduleVersion) ||
    !safeTimestamp(value.weekOneStartsAtMs) ||
    value.version !==
      (value.status === "started" ? 1 : 2)
  ) {
    failRollover("rollover_attempt_invalid");
  }
  if (value.triggerKind === "scheduled_job") {
    if (
      !stableId(value.scheduledJobRunId) ||
      value.retryIdempotencyRequestId !== null ||
      value.retryActorUserId !== null ||
      value.retryActorMembershipId !== null ||
      value.retryAuthority !== null
    ) {
      failRollover("rollover_attempt_invalid");
    }
  } else if (
    value.scheduledJobRunId !== null ||
    !stableId(value.retryIdempotencyRequestId) ||
    !stableId(value.retryActorUserId) ||
    !stableId(value.retryActorMembershipId) ||
    ![
      "commissioner",
      "platform_administrator_as_commissioner",
    ].includes(value.retryAuthority)
  ) {
    failRollover("rollover_attempt_invalid");
  }

  let blockers;
  if (value.status === "started") {
    blockers = canonicalRolloverBlockers(
      value.blockers
    );
    if (
      blockers.length !== 0 ||
      value.terminalAtMs !== null ||
      value.rolloverId !== null
    ) {
      failRollover("rollover_attempt_invalid");
    }
  } else if (value.status === "blocked") {
    blockers = canonicalRolloverBlockers(
      value.blockers,
      { requireNonempty: true }
    );
    if (
      !safeTimestamp(value.terminalAtMs) ||
      value.terminalAtMs < value.startedAtMs ||
      value.rolloverId !== null
    ) {
      failRollover("rollover_attempt_invalid");
    }
  } else {
    blockers = canonicalRolloverBlockers(
      value.blockers
    );
    if (
      blockers.length !== 0 ||
      !safeTimestamp(value.terminalAtMs) ||
      value.terminalAtMs < value.startedAtMs ||
      !stableId(value.rolloverId)
    ) {
      failRollover("rollover_attempt_invalid");
    }
  }
  return deepFreeze({
    ...value,
    blockers,
  });
}

function rolloverAttemptResult(attempt, replayed) {
  const value = Object.fromEntries(
    ROLLOVER_ATTEMPT_RESULT_KEYS.map((key) => [
      key,
      attempt[key],
    ])
  );
  return internalResult(value, replayed);
}

function sameValues(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sortedUniqueIds(value) {
  if (
    !Array.isArray(value) ||
    value.some((id) => !stableId(id))
  ) {
    return null;
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    return null;
  }
  return sorted;
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!safeTimestamp(nowMs)) {
    throw new TypeError(
      "league lifecycle transition requires a safe UTC timestamp"
    );
  }
  return nowMs;
}

function createSecureIdFactory(secureRandom) {
  const generated = new Set();
  return function nextId() {
    const id = secureRandom.id();
    if (!stableId(id) || generated.has(id)) {
      throw new TypeError(
        "league lifecycle transition requires unique canonical secure identifiers"
      );
    }
    generated.add(id);
    return id;
  };
}

function safeAuditContext(
  authenticated,
  auditContext
) {
  const value = auditContext || {};
  if (
    !isPlainObject(value) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        ![
          "requestCorrelationId",
          "networkKeyVersion",
          "networkMetadataDigest",
          "clientMetadataJson",
        ].includes(key)
    )
  ) {
    throw new TypeError(
      "league lifecycle transition requires safe audit context"
    );
  }
  const sessionId =
    authenticated?.session?.id ?? null;
  const requestCorrelationId =
    value.requestCorrelationId ?? null;
  const networkKeyVersion =
    value.networkKeyVersion ?? null;
  const networkMetadataDigest =
    value.networkMetadataDigest ?? null;
  const clientMetadataJson =
    value.clientMetadataJson ?? null;
  if (
    (sessionId !== null && !stableId(sessionId)) ||
    (requestCorrelationId !== null &&
      !safeText(requestCorrelationId, 128)) ||
    (networkKeyVersion !== null &&
      !safePositiveInteger(networkKeyVersion)) ||
    (networkMetadataDigest !== null &&
      !DIGEST_PATTERN.test(
        networkMetadataDigest || ""
      )) ||
    (clientMetadataJson !== null &&
      (typeof clientMetadataJson !== "string" ||
        clientMetadataJson.length < 2 ||
        clientMetadataJson.length > 2_048))
  ) {
    throw new TypeError(
      "league lifecycle transition requires safe audit context"
    );
  }
  if (clientMetadataJson !== null) {
    try {
      const parsed = JSON.parse(clientMetadataJson);
      if (!isPlainObject(parsed)) throw new Error();
    } catch {
      throw new TypeError(
        "league lifecycle transition requires safe audit context"
      );
    }
  }
  return Object.freeze({
    sessionId,
    requestCorrelationId,
    networkKeyVersion,
    networkMetadataDigest,
    clientMetadataJson,
  });
}

function canonicalRolloverAuthority(authority) {
  if (
    !authority ||
    !stableId(authority.actorUserId) ||
    !stableId(authority.membershipId)
  ) {
    throw new TypeError(
      "league lifecycle transition requires current league authority"
    );
  }
  let actorAuthority;
  if (authority.authority === "commissioner") {
    actorAuthority = "commissioner";
  } else if (
    [
      "platform_administrator",
      "platform_administrator_as_commissioner",
    ].includes(authority.authority)
  ) {
    actorAuthority =
      "platform_administrator_as_commissioner";
  } else {
    fail("LEAGUE_COMMISSIONER_REQUIRED");
  }
  return Object.freeze({
    actorUserId: authority.actorUserId,
    membershipId: authority.membershipId,
    actorAuthority,
  });
}

function requireExemptionAuthority({
  authenticated,
  leagueId,
  leagueAuthorization,
  platformAuthorization,
}) {
  const membership =
    leagueAuthorization.requireActiveMembership(
      authenticated,
      leagueId
    );
  const administrator =
    platformAuthorization.requireAdministrator(
      authenticated
    );
  if (
    !membership ||
    !administrator ||
    !stableId(membership.actorUserId) ||
    !stableId(membership.membershipId) ||
    administrator.actorUserId !==
      membership.actorUserId
  ) {
    fail("PLATFORM_ADMINISTRATOR_REQUIRED");
  }
  return Object.freeze({
    actorUserId: membership.actorUserId,
    membershipId: membership.membershipId,
    actorAuthority:
      "platform_administrator_as_commissioner",
  });
}

function expectedResultType(transitionType) {
  return transitionType ===
    RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
    ? SEASON_ROLLOVER_RESULT_TYPE
    : SETUP_EXEMPTION_RESULT_TYPE;
}

function inspectIdempotencyReplay({
  row,
  leagueId,
  actorUserId,
  clientKey,
  requestHash,
  resultType,
}) {
  if (!hasExactKeys(row, IDEMPOTENCY_ROW_KEYS)) {
    fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
  }
  if (
    row.leagueId !== leagueId ||
    row.actorUserId !== actorUserId ||
    row.operation !==
      LEAGUE_LIFECYCLE_TRANSITION_OPERATION ||
    row.clientKey !== clientKey ||
    row.requestHash !== requestHash
  ) {
    fail("IDEMPOTENCY_KEY_REUSED");
  }
  if (
    !stableId(row.id) ||
    row.status !== "completed" ||
    row.resultType !== resultType ||
    !stableId(row.resultId) ||
    !safeTimestamp(row.createdAtMs) ||
    !safeTimestamp(row.completedAtMs) ||
    !safeTimestamp(row.expiresAtMs) ||
    row.completedAtMs < row.createdAtMs ||
    row.expiresAtMs < row.createdAtMs
  ) {
    fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
  }
  return row;
}

function inspectRetryIdempotencyRequest({
  row,
  leagueId,
  actorUserId,
  clientKey,
  requestHash,
}) {
  if (!hasExactKeys(row, IDEMPOTENCY_ROW_KEYS)) {
    fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
  }
  if (
    row.leagueId !== leagueId ||
    row.actorUserId !== actorUserId ||
    row.operation !==
      LEAGUE_LIFECYCLE_TRANSITION_OPERATION ||
    row.clientKey !== clientKey ||
    row.requestHash !== requestHash
  ) {
    fail("IDEMPOTENCY_KEY_REUSED");
  }
  if (
    !stableId(row.id) ||
    !safeTimestamp(row.createdAtMs) ||
    !safeTimestamp(row.expiresAtMs) ||
    row.expiresAtMs < row.createdAtMs
  ) {
    fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
  }
  if (row.status === "started") {
    if (
      row.resultType !== null ||
      row.resultId !== null ||
      row.completedAtMs !== null
    ) {
      fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
    }
  } else if (row.status === "completed") {
    if (
      ![
        SEASON_ROLLOVER_ATTEMPT_RESULT_TYPE,
        SEASON_ROLLOVER_RESULT_TYPE,
      ].includes(row.resultType) ||
      !stableId(row.resultId) ||
      !safeTimestamp(row.completedAtMs) ||
      row.completedAtMs < row.createdAtMs
    ) {
      fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
    }
  } else {
    fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
  }
  return deepFreeze({ ...row });
}

function inspectSummary(value, unavailableCode) {
  if (
    !hasExactKeys(value, SUMMARY_KEYS) ||
    SUMMARY_KEYS.some(
      (key) =>
        !Number.isSafeInteger(value[key]) ||
        value[key] < 0
    )
  ) {
    fail(unavailableCode);
  }
  return Object.freeze(
    Object.fromEntries(
      SUMMARY_KEYS.map((key) => [key, value[key]])
    )
  );
}

function inspectRolloverCommitReceipt({
  value,
  plan = null,
}) {
  const code = "SEASON_ROLLOVER_RESULT_UNAVAILABLE";
  if (
    !hasExactKeys(
      value,
      ROLLOVER_COMMIT_RECEIPT_KEYS
    ) ||
    ![
      value.rolloverId,
      value.rolloverAttemptId,
      value.leagueId,
      value.fromSeasonId,
      value.toSeasonId,
      value.sourceFadId,
      value.sourceFinalizationRootId,
      value.sourceFinalizationId,
      value.sourceStandingsSnapshotId,
      value.sourceStandingsOperationId,
      value.entryDraftId,
      value.entryDraftRolloverBindingId,
      value.rolloverOccurrenceId,
      value.targetScheduleId,
      value.weekOneMatchupWeekId,
      value.firstPickClockId,
    ].every(stableId) ||
    value.fromSeasonId === value.toSeasonId ||
    value.fromSeasonStatus !== "completed" ||
    value.toSeasonStatus !== "active" ||
    !/^\d{8}$/.test(value.targetNhlSeasonKey || "") ||
    ![
      value.nhlRegularSeasonStartsAtMs,
      value.nhlRegularSeasonEndsAtMs,
      value.fantasyPlayoffsStartAtMs,
      value.fantasyPlayoffsEndAtMs,
      value.scheduledStartsAtMs,
      value.weekOneStartsAtMs,
      value.completedAtMs,
    ].every(safeTimestamp) ||
    !safeText(value.occurrenceKey, 300) ||
    !safePositiveInteger(value.targetScheduleVersion) ||
    !["scheduled_job", "commissioner_retry"].includes(
      value.trigger
    ) ||
    value.sourceReadinessSchemaVersion !== 1 ||
    !DIGEST_PATTERN.test(
      value.sourceReadinessSha256 || ""
    ) ||
    ![
      value.leagueVersion,
      value.fromSeasonVersion,
      value.toSeasonVersion,
      value.entryDraftVersion,
    ].every(safePositiveInteger) ||
    value.version !== 1
  ) {
    fail(code);
  }
  if (
    value.trigger === "scheduled_job"
      ? value.retryAuthorizedByUserId !== null ||
        value.retryAuthorizedAuthority !== null
      : !stableId(value.retryAuthorizedByUserId) ||
        ![
          "commissioner",
          "platform_administrator_as_commissioner",
        ].includes(value.retryAuthorizedAuthority)
  ) {
    fail(code);
  }
  const summary = inspectSummary(
    value.summary,
    code
  );
  if (plan !== null) {
    const sourceReadiness =
      plan.sourceReadiness.projection;
    if (
      value.rolloverId !== plan.rolloverId ||
      value.rolloverAttemptId !== plan.attemptId ||
      value.leagueId !== plan.leagueId ||
      value.fromSeasonId !== plan.source.id ||
      value.toSeasonId !== plan.target.id ||
      value.fromSeasonStatus !== "completed" ||
      value.toSeasonStatus !== "active" ||
      value.targetNhlSeasonKey !==
        plan.target.nhlSeasonKey ||
      value.nhlRegularSeasonStartsAtMs !==
        plan.target.nhlRegularSeasonStartsAtMs ||
      value.nhlRegularSeasonEndsAtMs !==
        plan.target.nhlRegularSeasonEndsAtMs ||
      value.fantasyPlayoffsStartAtMs !==
        plan.target.fantasyPlayoffsStartAtMs ||
      value.fantasyPlayoffsEndAtMs !==
        plan.target.fantasyPlayoffsEndAtMs ||
      value.sourceFadId !==
        sourceReadiness.sourceFadId ||
      value.sourceFinalizationRootId !==
        sourceReadiness.sourceFinalizationRootId ||
      value.sourceFinalizationId !==
        sourceReadiness.sourceFinalizationId ||
      value.sourceStandingsSnapshotId !==
        sourceReadiness.sourceStandingsSnapshotId ||
      value.sourceStandingsOperationId !==
        sourceReadiness.sourceStandingsOperationId ||
      value.sourceReadinessSchemaVersion !==
        plan.sourceReadiness.schemaVersion ||
      value.sourceReadinessSha256 !==
        plan.sourceReadiness.projectionSha256 ||
      value.entryDraftId !== plan.entryDraft.id ||
      value.entryDraftRolloverBindingId !==
        plan.bindingId ||
      value.rolloverOccurrenceId !==
        plan.rolloverOccurrenceId ||
      value.scheduledStartsAtMs !==
        plan.scheduledStartsAtMs ||
      value.occurrenceKey !== plan.occurrenceKey ||
      value.targetScheduleId !==
        plan.targetSchedule.id ||
      value.targetScheduleVersion !==
        plan.targetSchedule.version ||
      value.weekOneMatchupWeekId !==
        plan.targetSchedule.weekOneMatchupWeekId ||
      value.weekOneStartsAtMs !==
        plan.targetSchedule.weekOneStartsAtMs ||
      value.trigger !== plan.triggerKind ||
      value.leagueVersion !==
        plan.leagueVersionAfter ||
      value.fromSeasonVersion !==
        plan.source.versionAfter ||
      value.toSeasonVersion !==
        plan.target.versionAfter ||
      value.completedAtMs !==
        plan.completedAtMs ||
      value.entryDraftVersion !==
        plan.entryDraft.versionAfter ||
      value.firstPickClockId !==
        plan.firstPickClock.id ||
      value.retryAuthorizedByUserId !==
        (plan.triggerKind === "commissioner_retry"
          ? plan.authorizedByUserId
          : null) ||
      value.retryAuthorizedAuthority !==
        (plan.triggerKind === "commissioner_retry"
          ? plan.authorizedAuthority
          : null) ||
      JSON.stringify(summary) !==
        JSON.stringify(plan.summary)
    ) {
      fail(code);
    }
  }
  return deepFreeze({
    ...value,
    summary,
  });
}

function safeSeasonRolloverResult(value) {
  return inspectRolloverCommitReceipt({ value });
}

function safeSetupExemptionResult(value) {
  const code =
    "INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE";
  try {
    validateLeagueLifecycleTransitionInput({
      transitionType:
        INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
      seasonId: value.seasonId,
      reason: value.reason,
      confirmation:
        INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
    });
  } catch {
    fail(code);
  }
  if (
    !hasExactKeys(value, EXEMPTION_RESULT_KEYS) ||
    !stableId(value.exemptionId) ||
    !stableId(value.leagueId) ||
    !stableId(value.seasonId) ||
    value.exemptionKind !== SETUP_EXEMPTION_KIND ||
    !stableId(value.authorizedByUserId) ||
    value.authorizedAuthority !==
      "platform_administrator_as_commissioner" ||
    !safeTimestamp(value.authorizedAtMs) ||
    value.consumed !== false ||
    !stableId(value.migrationReportId) ||
    value.version !== 1
  ) {
    fail(code);
  }
  return deepFreeze(
    Object.fromEntries(
      EXEMPTION_RESULT_KEYS.map((key) => [
        key,
        value[key],
      ])
    )
  );
}

function internalResult(value, replayed) {
  const result = { ...value };
  Object.defineProperty(result, "replayed", {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false,
  });
  return deepFreeze(result);
}

function safeLateLockProjection(value) {
  if (!isPlainObject(value)) {
    throw new TypeError(
      "league lifecycle transition received an unsafe late-lock result"
    );
  }
  const keys = Object.keys(value)
    .sort()
    .join(",");
  if (
    (keys !== "status" &&
      keys !== "lockId,status") ||
    !LATE_LOCK_STATUSES.has(value.status) ||
    (Object.hasOwn(value, "lockId") &&
      (value.status !== "completed" ||
        !stableId(value.lockId)))
  ) {
    throw new TypeError(
      "league lifecycle transition received an unsafe late-lock result"
    );
  }
  return deepFreeze({
    status: value.status,
    ...(Object.hasOwn(value, "lockId")
      ? { lockId: value.lockId }
      : {}),
  });
}

function inspectRolloverOwnershipReceipt({
  value,
  leagueId,
  rolloverId,
  fromSeasonId,
  toSeasonId,
}) {
  if (
    !hasExactKeys(
      value,
      ROLLOVER_OWNERSHIP_RECEIPT_KEYS
    ) ||
    value.leagueId !== leagueId ||
    value.rolloverId !== rolloverId ||
    value.fromSeasonId !== fromSeasonId ||
    value.toSeasonId !== toSeasonId ||
    !Array.isArray(value.teams)
  ) {
    throw new TypeError(
      "league lifecycle transition requires an exact durable ownership receipt"
    );
  }
  const globalOwnershipIds = new Set();
  let previousTeamScope = null;
  const teams = value.teams.map((team) => {
    if (
      !hasExactKeys(
        team,
        ROLLOVER_OWNERSHIP_TEAM_KEYS
      ) ||
      team.leagueId !== leagueId ||
      !stableId(team.seasonId) ||
      !stableId(team.teamId) ||
      !Array.isArray(team.ownershipWitnesses)
    ) {
      throw new TypeError(
        "league lifecycle transition requires exact affected-team ownership evidence"
      );
    }
    const teamScope =
      `${team.leagueId}\u0000` +
      `${team.seasonId}\u0000${team.teamId}`;
    if (
      previousTeamScope !== null &&
      teamScope <= previousTeamScope
    ) {
      throw new TypeError(
        "league lifecycle transition ownership teams must be unique and stable-ID ordered"
      );
    }
    previousTeamScope = teamScope;
    let previousOwnershipId = null;
    const ownershipWitnesses =
      team.ownershipWitnesses.map((witness) => {
        if (
          !hasExactKeys(
            witness,
            ROLLOVER_OWNERSHIP_WITNESS_KEYS
          ) ||
          !stableId(witness.ownershipId) ||
          !safePositiveInteger(
            witness.ownershipVersion
          ) ||
          !["present", "deleted"].includes(
            witness.state
          ) ||
          (witness.state === "present" &&
            team.seasonId !== toSeasonId) ||
          (witness.state === "deleted" &&
            team.seasonId !== fromSeasonId) ||
          (previousOwnershipId !== null &&
            witness.ownershipId <=
              previousOwnershipId) ||
          globalOwnershipIds.has(
            witness.ownershipId
          )
        ) {
          throw new TypeError(
            "league lifecycle transition requires unique stable-ID ordered ownership witnesses"
          );
        }
        previousOwnershipId = witness.ownershipId;
        globalOwnershipIds.add(
          witness.ownershipId
        );
        return {
          ownershipId: witness.ownershipId,
          ownershipVersion:
            witness.ownershipVersion,
          state: witness.state,
        };
      });
    return {
      leagueId: team.leagueId,
      seasonId: team.seasonId,
      teamId: team.teamId,
      ownershipWitnesses,
    };
  });
  return deepFreeze({
    rolloverId,
    leagueId,
    fromSeasonId,
    toSeasonId,
    teams,
  });
}

function validateReplayResult({
  repository,
  row,
  input,
  leagueId,
  actorUserId,
}) {
  const durable = safeSetupExemptionResult(
    repository.findDurableSetupExemptionResult({
      leagueId,
      exemptionId: row.resultId,
    })
  );
  if (
    durable.exemptionId !== row.resultId ||
    durable.leagueId !== leagueId ||
    durable.seasonId !== input.seasonId ||
    durable.reason !== input.reason ||
    durable.authorizedByUserId !== actorUserId ||
    durable.authorizedAtMs !== row.completedAtMs
  ) {
    fail(
      "INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE"
    );
  }
  return internalResult(durable, true);
}

function safeVersionIncrement(value, reasonCode) {
  if (
    !safePositiveInteger(value) ||
    !Number.isSafeInteger(value + 1)
  ) {
    failRollover(reasonCode);
  }
  return value + 1;
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) =>
        sameJsonValue(item, right[index])
      )
    );
  }
  if (
    !isPlainObject(left) ||
    !isPlainObject(right)
  ) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(
          right,
          key
        ) ||
        !sameJsonValue(left[key], right[key])
    )
  ) {
    return false;
  }
  return true;
}

function inspectSourceReadiness({
  value,
  leagueId,
  fromSeasonId,
  completedAtMs,
}) {
  if (
    !hasExactKeys(
      value,
      SOURCE_READINESS_ENVELOPE_KEYS
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.projectionJson !== "string" ||
    value.projectionJson.length < 2 ||
    !DIGEST_PATTERN.test(
      value.projectionSha256 || ""
    ) ||
    !hasExactKeys(
      value.projection,
      SOURCE_READINESS_PROJECTION_KEYS
    )
  ) {
    failRollover("source_readiness_invalid");
  }
  let parsedProjection;
  try {
    parsedProjection = parseCanonicalJsonV1(
      value.projectionJson
    );
  } catch {
    failRollover("source_readiness_json_invalid");
  }
  if (
    !sameJsonValue(
      parsedProjection,
      value.projection
    ) ||
    serializeSeasonRolloverSourceReadiness(
      value.projection
    ) !== value.projectionJson ||
    hashSeasonRolloverSourceReadiness(
      value.projection
    ) !== value.projectionSha256
  ) {
    failRollover("source_readiness_json_mismatch");
  }

  const projection = value.projection;
  if (
    projection.leagueId !== leagueId ||
    projection.fromSeasonId !== fromSeasonId ||
    projection.observedAtMs !== completedAtMs ||
    !safeTimestamp(
      projection.sourceFadCompletedAtMs
    ) ||
    projection.sourceFadCompletedAtMs >
      completedAtMs ||
    ![
      projection.sourceFadId,
      projection.sourceFinalizationRootId,
      projection.sourceFinalizationId,
      projection.sourceStandingsSnapshotId,
      projection.sourceStandingsOperationId,
    ].every(stableId) ||
    !Array.isArray(
      projection.recognizedSeasonOperationTables
    ) ||
    !sameValues(
      projection.recognizedSeasonOperationTables,
      RECOGNIZED_SEASON_OPERATION_TABLES
    ) ||
    !isPlainObject(projection.freeAgentDraft) ||
    projection.freeAgentDraft.id !==
      projection.sourceFadId ||
    projection.freeAgentDraft.league_id !==
      leagueId ||
    projection.freeAgentDraft.season_id !==
      fromSeasonId ||
    projection.freeAgentDraft.status !==
      "completed" ||
    projection.freeAgentDraft.completed_at_ms !==
      projection.sourceFadCompletedAtMs ||
    !isPlainObject(
      projection.freeAgentDraftReadinessOperation
    ) ||
    projection.freeAgentDraftReadinessOperation
      .league_id !== leagueId ||
    projection.freeAgentDraftReadinessOperation
      .season_id !== fromSeasonId ||
    projection.freeAgentDraftReadinessOperation
      .status !== "succeeded" ||
    SOURCE_READINESS_COLLECTION_KEYS.some(
      (key) => !Array.isArray(projection[key])
    )
  ) {
    failRollover("source_readiness_identity_invalid");
  }
  return deepFreeze(value);
}

function inspectEffectVersion(value) {
  if (
    !safePositiveInteger(value) ||
    value === Number.MAX_SAFE_INTEGER
  ) {
    failRollover("matrix_effect_version_invalid");
  }
  return value;
}

function nullableStableId(value) {
  return value === null || stableId(value);
}

function nullableTimestamp(value) {
  return value === null || safeTimestamp(value);
}

function positiveMoney(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function roundedContractAav(totalCents, termYears) {
  const quotient = Math.floor(totalCents / termYears);
  const remainder = totalCents % termYears;
  return (
    quotient +
    (remainder * 2 >= termYears ? 1 : 0)
  );
}

function strictlyOrdered(value, compare) {
  return value.every(
    (item, index) =>
      index === 0 ||
      compare(value[index - 1], item) < 0
  );
}

function jsonClone(value) {
  if (Array.isArray(value)) {
    return value.map(jsonClone);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        jsonClone(child),
      ])
    );
  }
  return value;
}

function inspectContractBefore(
  before,
  entityId,
  effectKind,
  scope
) {
  if (
    !hasExactKeys(before, CONTRACT_PROJECTION_KEYS) ||
    before.id !== entityId ||
    !stableId(before.id) ||
    !stableId(before.playerId) ||
    !stableId(before.currentTeamId) ||
    !["normal", "fantasy_elc"].includes(
      before.contractType
    ) ||
    !positiveMoney(before.originalTotalValueCents) ||
    !Number.isSafeInteger(before.originalTermYears) ||
    before.originalTermYears < 1 ||
    before.originalTermYears > 3 ||
    !positiveMoney(before.aavCents) ||
    before.aavCents !==
      roundedContractAav(
        before.originalTotalValueCents,
        before.originalTermYears
      ) ||
    !stableId(before.startSeasonId) ||
    before.status !== "active" ||
    !safeText(before.acquisitionSourceType, 128) ||
    !nullableStableId(before.acquisitionSourceId) ||
    !nullableTimestamp(
      before.auctionBuyoutLockExpiresAtMs
    ) ||
    !safeTimestamp(before.createdAtMs) ||
    !safeTimestamp(before.updatedAtMs) ||
    before.updatedAtMs < before.createdAtMs ||
    !Array.isArray(before.years) ||
    before.years.length !==
      before.originalTermYears
  ) {
    failRollover("contract_projection_invalid");
  }
  const version = inspectEffectVersion(before.version);
  const years = before.years;
  for (const year of years) {
    if (
      !hasExactKeys(year, CONTRACT_YEAR_KEYS) ||
      !stableId(year.id) ||
      !stableId(year.seasonId) ||
      !Number.isSafeInteger(year.yearNumber) ||
      year.yearNumber < 1 ||
      year.yearNumber >
        before.originalTermYears ||
      year.aavCents !== before.aavCents ||
      ![
        "future",
        "current",
        "completed",
        "expired",
        "eliminated",
      ].includes(year.status) ||
      !nullableTimestamp(year.rolloverAtMs) ||
      !safeTimestamp(year.createdAtMs)
    ) {
      failRollover("contract_year_projection_invalid");
    }
  }
  if (
    !strictlyOrdered(
      years,
      (left, right) =>
        left.yearNumber - right.yearNumber ||
        left.id.localeCompare(right.id)
    ) ||
    new Set(years.map(({ id }) => id)).size !==
      years.length ||
    new Set(years.map(({ seasonId }) => seasonId))
      .size !== years.length ||
    new Set(years.map(({ yearNumber }) => yearNumber))
      .size !== years.length
  ) {
    failRollover("contract_year_projection_order_invalid");
  }
  const sourceYears = years.filter(
    ({ seasonId, status }) =>
      seasonId === scope.sourceSeasonId &&
      status === "current"
  );
  const targetYears =
    scope.targetSeasonId === null
      ? []
      : years.filter(
          ({ seasonId }) =>
            seasonId === scope.targetSeasonId
        );
  const targetYear =
    targetYears.length === 1
      ? targetYears[0]
      : null;
  if (
    sourceYears.length !== 1 ||
    sourceYears[0].rolloverAtMs !== null ||
    (effectKind === "contract_advanced"
      ? !targetYear ||
        targetYear.status !== "future" ||
        targetYear.rolloverAtMs !== null
      : targetYears.length !== 0)
  ) {
    failRollover("contract_year_transition_invalid");
  }
  return Object.freeze({
    before: deepFreeze(before),
    version,
    sourceYearId: sourceYears[0].id,
    targetYearId: targetYear?.id ?? null,
  });
}

function inspectContractEffects(value, scope) {
  if (!Array.isArray(value)) {
    failRollover("contract_matrix_invalid");
  }
  const effects = value.map((effect) => {
    if (
      !hasExactKeys(effect, CONTRACT_EFFECT_KEYS) ||
      !stableId(effect.entityId) ||
      !stableId(effect.ownershipId) ||
      ![
        "contract_advanced",
        "contract_expired",
      ].includes(effect.effectKind)
    ) {
      failRollover("contract_matrix_invalid");
    }
    const inspected = inspectContractBefore(
      effect.before,
      effect.entityId,
      effect.effectKind,
      scope
    );
    return Object.freeze({
      ...effect,
      ...inspected,
    });
  });
  effects.sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  );
  if (
    new Set(
      effects.map((effect) => effect.entityId)
    ).size !== effects.length
  ) {
    failRollover("contract_matrix_duplicate");
  }
  return effects;
}

function inspectOwnershipBefore(
  before,
  entityId,
  scope
) {
  if (
    !hasExactKeys(before, OWNERSHIP_PROJECTION_KEYS) ||
    before.exists !== true ||
    before.id !== entityId ||
    !stableId(before.id) ||
    before.seasonId !== scope.sourceSeasonId ||
    !stableId(before.playerId) ||
    !stableId(before.teamId) ||
    !["Rostered", "Prospect Right"].includes(
      before.ownershipKind
    ) ||
    ![
      "Active",
      "Bench",
      "Injured Reserve",
      "Prospect",
    ].includes(before.rosterCategory) ||
    (before.ownershipKind === "Rostered") !==
      ["Active", "Bench", "Injured Reserve"].includes(
        before.rosterCategory
      ) ||
    (before.ownershipKind === "Prospect Right") !==
      (before.rosterCategory === "Prospect") ||
    !["F", "D"].includes(before.positionGroup) ||
    !(
      before.slotNumber === null ||
      (Number.isSafeInteger(before.slotNumber) &&
        before.slotNumber >= 1)
    ) ||
    (before.rosterCategory === "Prospect" &&
      before.slotNumber !== null) ||
    !safeText(
      before.acquiredTransactionType,
      128
    ) ||
    !nullableStableId(before.acquiredTransactionId) ||
    typeof before.tradeBlocked !== "boolean" ||
    !safeTimestamp(before.createdAtMs) ||
    !safeTimestamp(before.updatedAtMs) ||
    before.updatedAtMs < before.createdAtMs ||
    !Array.isArray(before.displayOrderEntries)
  ) {
    failRollover("ownership_projection_invalid");
  }
  const version = inspectEffectVersion(before.version);
  for (const entry of before.displayOrderEntries) {
    if (
      !hasExactKeys(entry, DISPLAY_ORDER_ENTRY_KEYS) ||
      !stableId(entry.id) ||
      entry.leagueId !== scope.leagueId ||
      !stableId(entry.orderSetId) ||
      entry.ownershipId !== entityId ||
      entry.positionGroup !== before.positionGroup ||
      !safePositiveInteger(entry.displayOrder) ||
      !safeTimestamp(entry.createdAtMs)
    ) {
      failRollover(
        "ownership_display_order_projection_invalid"
      );
    }
  }
  if (
    !strictlyOrdered(
      before.displayOrderEntries,
      (left, right) =>
        left.orderSetId.localeCompare(
          right.orderSetId
        ) || left.id.localeCompare(right.id)
    ) ||
    new Set(
      before.displayOrderEntries.map(({ id }) => id)
    ).size !== before.displayOrderEntries.length ||
    new Set(
      before.displayOrderEntries.map(
        ({ orderSetId }) => orderSetId
      )
    ).size !== before.displayOrderEntries.length
  ) {
    failRollover(
      "ownership_display_order_projection_order_invalid"
    );
  }
  return Object.freeze({
    before: deepFreeze(before),
    version,
  });
}

function inspectOwnershipEffects(value, scope) {
  if (!Array.isArray(value)) {
    failRollover("ownership_matrix_invalid");
  }
  const effects = value.map((effect) => {
    if (
      !hasExactKeys(effect, OWNERSHIP_EFFECT_KEYS) ||
      !stableId(effect.entityId) ||
      ![
        "ownership_carried",
        "ownership_released",
      ].includes(effect.effectKind) ||
      !(
        effect.contractId === null ||
        stableId(effect.contractId)
      ) ||
      (effect.effectKind ===
        "ownership_released" &&
        effect.contractId === null)
    ) {
      failRollover("ownership_matrix_invalid");
    }
    const inspected = inspectOwnershipBefore(
      effect.before,
      effect.entityId,
      scope
    );
    return Object.freeze({
      ...effect,
      ...inspected,
    });
  });
  effects.sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  );
  if (
    new Set(
      effects.map((effect) => effect.entityId)
    ).size !== effects.length
  ) {
    failRollover("ownership_matrix_duplicate");
  }
  return effects;
}

function inspectObligationEffects(
  value,
  prefix,
  scope
) {
  if (!Array.isArray(value)) {
    failRollover(`${prefix}_matrix_invalid`);
  }
  const advanced = `${prefix}_year_advanced`;
  const completed =
    `${prefix}_obligation_completed`;
  const projectionKeys =
    prefix === "retention"
      ? RETENTION_PROJECTION_KEYS
      : BUYOUT_PROJECTION_KEYS;
  const effects = value.map((effect) => {
    if (
      !hasExactKeys(effect, OBLIGATION_EFFECT_KEYS) ||
      !stableId(effect.entityId) ||
      ![advanced, completed].includes(
        effect.effectKind
      )
    ) {
      failRollover(`${prefix}_matrix_invalid`);
    }
    const before = effect.before;
    const amountKey =
      prefix === "retention"
        ? "retainedAavCents"
        : "annualPenaltyBasisCents";
    const transactionKey =
      prefix === "retention"
        ? "creationTradeId"
        : "buyoutTransactionId";
    if (
      !hasExactKeys(before, projectionKeys) ||
      before.id !== effect.entityId ||
      !stableId(before.id) ||
      !stableId(before.contractId) ||
      !stableId(before.playerId) ||
      !stableId(before.originatingTeamId) ||
      !stableId(before.responsibleTeamId) ||
      !positiveMoney(before[amountKey]) ||
      !(prefix === "retention"
        ? nullableStableId(before[transactionKey])
        : stableId(before[transactionKey])) ||
      before.status !== "active" ||
      !safeTimestamp(before.createdAtMs) ||
      !safeTimestamp(before.updatedAtMs) ||
      before.updatedAtMs < before.createdAtMs ||
      !Array.isArray(before.years)
    ) {
      failRollover(
        `${prefix}_projection_invalid`
      );
    }
    const version = inspectEffectVersion(
      before.version
    );
    for (const year of before.years) {
      if (
        !hasExactKeys(year, OBLIGATION_YEAR_KEYS) ||
        !stableId(year.id) ||
        !stableId(year.seasonId) ||
        !positiveMoney(year.amountCents) ||
        ![
          "future",
          "current",
          "completed",
          "cancelled",
        ].includes(year.status) ||
        !safeTimestamp(year.createdAtMs)
      ) {
        failRollover(
          `${prefix}_year_projection_invalid`
        );
      }
    }
    if (
      !strictlyOrdered(
        before.years,
        (left, right) =>
          left.seasonId.localeCompare(
            right.seasonId
          ) || left.id.localeCompare(right.id)
      ) ||
      new Set(
        before.years.map(({ id }) => id)
      ).size !== before.years.length ||
      new Set(
        before.years.map(({ seasonId }) => seasonId)
      ).size !== before.years.length
    ) {
      failRollover(
        `${prefix}_year_projection_order_invalid`
      );
    }
    const sourceYears = before.years.filter(
      ({ seasonId, status }) =>
        seasonId === scope.sourceSeasonId &&
        status === "current"
    );
    const targetYears =
      scope.targetSeasonId === null
        ? []
        : before.years.filter(
            ({ seasonId }) =>
              seasonId === scope.targetSeasonId
          );
    const targetYear =
      targetYears.length === 1
        ? targetYears[0]
        : null;
    if (
      sourceYears.length !== 1 ||
      (effect.effectKind === advanced
        ? !targetYear ||
          targetYear.status !== "future"
        : targetYears.length !== 0)
    ) {
      failRollover(
        `${prefix}_year_transition_invalid`
      );
    }
    return Object.freeze({
      ...effect,
      before: deepFreeze(before),
      version,
      sourceYearId: sourceYears[0].id,
      targetYearId: targetYear?.id ?? null,
    });
  });
  effects.sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  );
  if (
    new Set(
      effects.map((effect) => effect.entityId)
    ).size !== effects.length
  ) {
    failRollover(`${prefix}_matrix_duplicate`);
  }
  return effects;
}

function inspectTradeBefore(
  before,
  entityId,
  scope
) {
  if (
    !hasExactKeys(before, TRADE_PROJECTION_KEYS) ||
    before.id !== entityId ||
    !stableId(before.id) ||
    before.seasonId !== scope.sourceSeasonId ||
    !stableId(before.proposingTeamId) ||
    !stableId(before.receivingTeamId) ||
    before.proposingTeamId === before.receivingTeamId ||
    !stableId(before.proposingUserId) ||
    !stableId(before.creatingMembershipId) ||
    !safeText(before.creatingAuthority, 128) ||
    before.status !== "proposed" ||
    !safeTimestamp(before.createdAtMs) ||
    !safeTimestamp(before.expiresAtMs) ||
    before.expiresAtMs <= before.createdAtMs ||
    !safeTimestamp(before.effectiveDeadlineAtMs) ||
    before.respondedAtMs !== null ||
    before.completedAtMs !== null ||
    before.commissionerCompletionReference !== null ||
    !safePositiveInteger(
      before.proposalModelVersion
    ) ||
    !safeTimestamp(before.updatedAtMs) ||
    before.updatedAtMs < before.createdAtMs ||
    !Array.isArray(before.assets) ||
    before.assets.length < 1
  ) {
    failRollover("trade_projection_invalid");
  }
  const version = inspectEffectVersion(before.version);
  for (const asset of before.assets) {
    const nullableIds = [
      "contractId",
      "playerId",
      "draftPickId",
      "retentionObligationId",
      "buyoutObligationId",
      "futureConsiderationId",
      "requestedRetentionContractId",
    ];
    if (
      !hasExactKeys(asset, TRADE_ASSET_KEYS) ||
      !stableId(asset.id) ||
      asset.leagueId !== scope.leagueId ||
      asset.tradeId !== entityId ||
      ![
        "proposing_to_receiving",
        "receiving_to_proposing",
      ].includes(asset.direction) ||
      !stableId(asset.sourceTeamId) ||
      !stableId(asset.destinationTeamId) ||
      asset.sourceTeamId === asset.destinationTeamId ||
      ![
        "contract",
        "prospect_right",
        "draft_pick",
        "retention_obligation",
        "buyout_obligation",
        "future_consideration",
        "requested_retention",
      ].includes(asset.assetType) ||
      nullableIds.some(
        (key) => !nullableStableId(asset[key])
      ) ||
      !(
        asset.requestedRetentionCents === null ||
        positiveMoney(
          asset.requestedRetentionCents
        )
      ) ||
      !(
        asset.futureConsiderationDescription ===
          null ||
        safeText(
          asset.futureConsiderationDescription,
          2_000
        )
      ) ||
      !(
        asset.proposalSnapshotJson === null ||
        typeof asset.proposalSnapshotJson ===
          "string"
      ) ||
      !safePositiveInteger(asset.assetModelVersion) ||
      !safePositiveInteger(asset.sequence) ||
      !safeTimestamp(asset.createdAtMs)
    ) {
      failRollover("trade_asset_projection_invalid");
    }
  }
  if (
    !strictlyOrdered(
      before.assets,
      (left, right) =>
        left.sequence - right.sequence ||
        left.id.localeCompare(right.id)
    ) ||
    new Set(before.assets.map(({ id }) => id)).size !==
      before.assets.length ||
    new Set(
      before.assets.map(({ sequence }) => sequence)
    ).size !== before.assets.length
  ) {
    failRollover("trade_asset_projection_order_invalid");
  }
  return Object.freeze({
    before: deepFreeze(before),
    version,
  });
}

function inspectTradeEffects(value, scope) {
  if (!Array.isArray(value)) {
    failRollover("trade_matrix_invalid");
  }
  const effects = value.map((effect) => {
    if (
      !hasExactKeys(effect, TRADE_EFFECT_KEYS) ||
      !stableId(effect.entityId) ||
      effect.effectKind !== "trade_cancelled" ||
      !Array.isArray(effect.causalEffects) ||
      effect.causalEffects.length < 1
    ) {
      failRollover("trade_matrix_invalid");
    }
    const causalEffects = effect.causalEffects.map(
      (cause) => {
        if (
          !hasExactKeys(cause, CAUSAL_EFFECT_KEYS) ||
          !safePositiveInteger(
            cause.tradeAssetSequence
          ) ||
          ![
            "contract",
            "prospect_right",
            "retention_obligation",
            "buyout_obligation",
            "requested_retention",
          ].includes(cause.tradeAssetType) ||
          !stableId(cause.entityId)
        ) {
          failRollover("trade_causal_matrix_invalid");
        }
        const expectedKinds = {
          contract: "contract_expired",
          prospect_right: "ownership_released",
          retention_obligation:
            "retention_obligation_completed",
          buyout_obligation:
            "buyout_obligation_completed",
          requested_retention:
            "contract_expired",
        };
        if (
          cause.effectKind !==
          expectedKinds[cause.tradeAssetType]
        ) {
          failRollover(
            "trade_causal_matrix_invalid"
          );
        }
        return Object.freeze({ ...cause });
      }
    );
    const causalKeys = causalEffects.map(
      (cause) => cause.tradeAssetSequence
    );
    if (
      new Set(causalKeys).size !==
      causalKeys.length
    ) {
      failRollover("trade_causal_matrix_duplicate");
    }
    const inspected = inspectTradeBefore(
      effect.before,
      effect.entityId,
      scope
    );
    for (const cause of causalEffects) {
      const asset = effect.before.assets.find(
        ({ sequence }) =>
          sequence === cause.tradeAssetSequence
      );
      if (
        !asset ||
        asset.assetType !== cause.tradeAssetType
      ) {
        failRollover(
          "trade_causal_asset_projection_invalid"
        );
      }
    }
    return Object.freeze({
      ...effect,
      ...inspected,
      causalEffects: Object.freeze(causalEffects),
    });
  });
  effects.sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  );
  if (
    new Set(
      effects.map((effect) => effect.entityId)
    ).size !== effects.length
  ) {
    failRollover("trade_matrix_duplicate");
  }
  return effects;
}

function assertEffectClosure(
  totalIds,
  effects,
  reasonCode
) {
  const expected = sortedUniqueIds(totalIds);
  const actual = sortedUniqueIds(
    effects.map((effect) => effect.entityId)
  );
  if (
    expected === null ||
    actual === null ||
    !sameValues(expected, actual)
  ) {
    failRollover(reasonCode);
  }
}

function inspectRolloverMatrix(value, scope) {
  if (
    !hasExactKeys(value, MATRIX_KEYS) ||
    !Array.isArray(value.violations) ||
    value.violations.length !== 0 ||
    !hasExactKeys(value.totals, MATRIX_TOTAL_KEYS)
  ) {
    failRollover("total_matrix_invalid");
  }
  const contracts = inspectContractEffects(
    value.contractEffects,
    scope
  );
  const ownerships = inspectOwnershipEffects(
    value.ownershipEffects,
    scope
  );
  const retentions = inspectObligationEffects(
    value.retentionEffects,
    "retention",
    scope
  );
  const buyouts = inspectObligationEffects(
    value.buyoutEffects,
    "buyout",
    scope
  );
  const trades = inspectTradeEffects(
    value.tradeEffects,
    scope
  );
  assertEffectClosure(
    value.totals.activeContractIds,
    contracts,
    "contract_matrix_not_total"
  );
  assertEffectClosure(
    value.totals.liveOwnershipIds,
    ownerships,
    "ownership_matrix_not_total"
  );
  assertEffectClosure(
    value.totals.activeRetentionIds,
    retentions,
    "retention_matrix_not_total"
  );
  assertEffectClosure(
    value.totals.activeBuyoutIds,
    buyouts,
    "buyout_matrix_not_total"
  );
  assertEffectClosure(
    value.totals.qualifyingTradeIds,
    trades,
    "trade_matrix_not_total"
  );

  const contractsById = new Map(
    contracts.map((effect) => [
      effect.entityId,
      effect,
    ])
  );
  const ownershipsById = new Map(
    ownerships.map((effect) => [
      effect.entityId,
      effect,
    ])
  );
  const releasedOwnershipsByPlayer = new Map();
  for (const ownership of ownerships) {
    if (
      ownership.effectKind !== "ownership_released"
    ) {
      continue;
    }
    if (
      releasedOwnershipsByPlayer.has(
        ownership.before.playerId
      )
    ) {
      failRollover(
        "ownership_player_matrix_duplicate"
      );
    }
    releasedOwnershipsByPlayer.set(
      ownership.before.playerId,
      ownership
    );
  }
  for (const contract of contracts) {
    const ownership = ownershipsById.get(
      contract.ownershipId
    );
    const expectedOwnershipKind =
      contract.effectKind === "contract_advanced"
        ? "ownership_carried"
        : "ownership_released";
    if (
      !ownership ||
      ownership.effectKind !==
        expectedOwnershipKind ||
      ownership.contractId !== contract.entityId ||
      ownership.before.playerId !==
        contract.before.playerId ||
      ownership.before.teamId !==
        contract.before.currentTeamId
    ) {
      failRollover(
        "contract_ownership_matrix_mismatch"
      );
    }
  }
  for (const ownership of ownerships) {
    if (ownership.contractId === null) {
      if (
        ownership.effectKind !==
          "ownership_carried" ||
        ownership.before.ownershipKind !==
          "Prospect Right" ||
        ownership.before.rosterCategory !==
          "Prospect"
      ) {
        failRollover(
          "unsigned_ownership_matrix_mismatch"
        );
      }
      continue;
    }
    const contract = contractsById.get(
      ownership.contractId
    );
    const expectedContractKind =
      ownership.effectKind ===
      "ownership_carried"
        ? "contract_advanced"
        : "contract_expired";
    if (
      !contract ||
      contract.effectKind !== expectedContractKind ||
      contract.ownershipId !== ownership.entityId ||
      contract.before.playerId !==
        ownership.before.playerId ||
      contract.before.currentTeamId !==
        ownership.before.teamId ||
      (ownership.before.ownershipKind ===
        "Prospect Right" &&
        contract.before.contractType !==
          "fantasy_elc")
    ) {
      failRollover(
        "ownership_contract_matrix_mismatch"
      );
    }
  }

  const effectKeys = new Set(
    [
      ...contracts,
      ...ownerships,
      ...retentions,
      ...buyouts,
    ].map(
      (effect) =>
        `${effect.effectKind}:${effect.entityId}`
    )
  );
  const retentionsById = new Map(
    retentions.map((effect) => [
      effect.entityId,
      effect,
    ])
  );
  const buyoutsById = new Map(
    buyouts.map((effect) => [
      effect.entityId,
      effect,
    ])
  );
  for (const trade of trades) {
    for (const cause of trade.causalEffects) {
      if (
        !effectKeys.has(
          `${cause.effectKind}:${cause.entityId}`
        )
      ) {
        failRollover(
          "trade_causal_effect_missing"
        );
      }
      const asset = trade.before.assets.find(
        ({ sequence }) =>
          sequence === cause.tradeAssetSequence
      );
      let identityMatches = false;
      if (cause.tradeAssetType === "contract") {
        identityMatches =
          asset.contractId === cause.entityId;
      } else if (
        cause.tradeAssetType === "prospect_right"
      ) {
        const ownership = ownershipsById.get(
          cause.entityId
        );
        identityMatches =
          ownership?.effectKind ===
            "ownership_released" &&
          ownership.before.playerId === asset.playerId;
      } else if (
        cause.tradeAssetType ===
        "retention_obligation"
      ) {
        identityMatches =
          asset.retentionObligationId ===
          cause.entityId;
      } else if (
        cause.tradeAssetType ===
        "buyout_obligation"
      ) {
        identityMatches =
          asset.buyoutObligationId ===
          cause.entityId;
      } else {
        identityMatches =
          asset.requestedRetentionContractId ===
          cause.entityId;
      }
      if (!identityMatches) {
        failRollover(
          "trade_causal_asset_identity_mismatch"
        );
      }
    }
    const expectedCauses = [];
    for (const asset of trade.before.assets) {
      let effect = null;
      if (
        asset.assetType === "contract" ||
        asset.assetType === "requested_retention"
      ) {
        const contractId =
          asset.assetType === "contract"
            ? asset.contractId
            : asset.requestedRetentionContractId;
        const candidate =
          contractsById.get(contractId);
        if (
          candidate?.effectKind ===
          "contract_expired"
        ) {
          effect = candidate;
        }
      } else if (
        asset.assetType === "prospect_right"
      ) {
        effect =
          releasedOwnershipsByPlayer.get(
            asset.playerId
          ) || null;
      } else if (
        asset.assetType ===
        "retention_obligation"
      ) {
        const candidate = retentionsById.get(
          asset.retentionObligationId
        );
        if (
          candidate?.effectKind ===
          "retention_obligation_completed"
        ) {
          effect = candidate;
        }
      } else if (
        asset.assetType === "buyout_obligation"
      ) {
        const candidate = buyoutsById.get(
          asset.buyoutObligationId
        );
        if (
          candidate?.effectKind ===
          "buyout_obligation_completed"
        ) {
          effect = candidate;
        }
      }
      if (effect !== null) {
        expectedCauses.push({
          tradeAssetSequence: asset.sequence,
          tradeAssetType: asset.assetType,
          effectKind: effect.effectKind,
          entityId: effect.entityId,
        });
      }
    }
    const causalKey = (cause) =>
      `${cause.tradeAssetSequence}:` +
      `${cause.tradeAssetType}:` +
      `${cause.effectKind}:${cause.entityId}`;
    const expectedKeys = expectedCauses
      .map(causalKey)
      .sort();
    const actualKeys = trade.causalEffects
      .map(causalKey)
      .sort();
    if (
      expectedKeys.length < 1 ||
      !sameValues(expectedKeys, actualKeys)
    ) {
      failRollover(
        "trade_causal_matrix_not_total"
      );
    }
  }

  return deepFreeze({
    contracts,
    ownerships,
    retentions,
    buyouts,
    trades,
  });
}

function deriveContractAfter(effect, nowMs) {
  const after = jsonClone(effect.before);
  after.status =
    effect.effectKind === "contract_advanced"
      ? "active"
      : "expired";
  after.updatedAtMs = nowMs;
  after.version = effect.version + 1;
  const sourceYear = after.years.find(
    ({ id }) => id === effect.sourceYearId
  );
  sourceYear.status =
    effect.effectKind === "contract_advanced"
      ? "completed"
      : "expired";
  sourceYear.rolloverAtMs = nowMs;
  if (effect.targetYearId !== null) {
    const targetYear = after.years.find(
      ({ id }) => id === effect.targetYearId
    );
    targetYear.status = "current";
    targetYear.rolloverAtMs = null;
  }
  return deepFreeze(after);
}

function deriveOwnershipAfter(
  effect,
  targetSeasonId,
  nowMs
) {
  const after = jsonClone(effect.before);
  after.displayOrderEntries = [];
  after.updatedAtMs = nowMs;
  if (effect.effectKind === "ownership_carried") {
    after.seasonId = targetSeasonId;
    after.version = effect.version + 1;
  } else {
    after.exists = false;
    after.seasonId = null;
    after.version = null;
  }
  return deepFreeze(after);
}

function deriveObligationAfter(
  effect,
  advancedKind,
  nowMs
) {
  const after = jsonClone(effect.before);
  const advanced =
    effect.effectKind === advancedKind;
  after.status = advanced ? "active" : "completed";
  after.updatedAtMs = nowMs;
  after.version = effect.version + 1;
  after.years.find(
    ({ id }) => id === effect.sourceYearId
  ).status = "completed";
  if (effect.targetYearId !== null) {
    after.years.find(
      ({ id }) => id === effect.targetYearId
    ).status = "current";
  }
  return deepFreeze(after);
}

function deriveTradeAfter(effect, nowMs) {
  const after = jsonClone(effect.before);
  after.status = "cancelled";
  after.respondedAtMs = nowMs;
  after.updatedAtMs = nowMs;
  after.version = effect.version + 1;
  return deepFreeze(after);
}

function planEffects(
  matrix,
  targetSeasonId,
  nowMs,
  nextId
) {
  const contracts = matrix.contracts.map(
    (effect) => ({
      ...effect,
      after: deriveContractAfter(effect, nowMs),
      itemId: nextId(),
      eventId: nextId(),
      leagueActivityId:
        effect.effectKind === "contract_expired"
          ? nextId()
          : null,
    })
  );
  const ownerships = matrix.ownerships.map(
    (effect) => ({
      ...effect,
      after: deriveOwnershipAfter(
        effect,
        targetSeasonId,
        nowMs
      ),
      itemId: nextId(),
      eventId: nextId(),
      leagueActivityId: null,
    })
  );
  const retentions = matrix.retentions.map(
    (effect) => ({
      ...effect,
      after: deriveObligationAfter(
        effect,
        "retention_year_advanced",
        nowMs
      ),
      itemId: nextId(),
      eventId: null,
      leagueActivityId: null,
    })
  );
  const buyouts = matrix.buyouts.map(
    (effect) => ({
      ...effect,
      after: deriveObligationAfter(
        effect,
        "buyout_year_advanced",
        nowMs
      ),
      itemId: nextId(),
      eventId: null,
      leagueActivityId: null,
    })
  );
  const byEffect = new Map(
    [
      ...contracts,
      ...ownerships,
      ...retentions,
      ...buyouts,
    ].map((effect) => [
      `${effect.effectKind}:${effect.entityId}`,
      effect,
    ])
  );
  const trades = matrix.trades.map((effect) => {
    const causalAssets = effect.causalEffects
      .map((cause) => ({
        tradeAssetSequence:
          cause.tradeAssetSequence,
        tradeAssetType: cause.tradeAssetType,
        rolloverItemId:
          byEffect.get(
            `${cause.effectKind}:${cause.entityId}`
          ).itemId,
      }))
      .sort(
        (left, right) =>
          left.tradeAssetSequence -
            right.tradeAssetSequence ||
          left.rolloverItemId.localeCompare(
            right.rolloverItemId
          )
      );
    return {
      entityId: effect.entityId,
      version: effect.version,
      effectKind: effect.effectKind,
      before: effect.before,
      after: deriveTradeAfter(effect, nowMs),
      causalAssets,
      itemId: nextId(),
      eventId: nextId(),
      leagueActivityId: nextId(),
    };
  });
  return deepFreeze({
    contracts,
    ownerships,
    retentions,
    buyouts,
    trades,
  });
}

function summaryFromEffects(effects) {
  return Object.freeze({
    contractsAdvanced: effects.contracts.filter(
      ({ effectKind }) =>
        effectKind === "contract_advanced"
    ).length,
    contractsExpired: effects.contracts.filter(
      ({ effectKind }) =>
        effectKind === "contract_expired"
    ).length,
    ownershipsCarried: effects.ownerships.filter(
      ({ effectKind }) =>
        effectKind === "ownership_carried"
    ).length,
    ownershipsReleased: effects.ownerships.filter(
      ({ effectKind }) =>
        effectKind === "ownership_released"
    ).length,
    retentionYearsAdvanced:
      effects.retentions.filter(
        ({ effectKind }) =>
          effectKind ===
          "retention_year_advanced"
      ).length,
    retentionObligationsCompleted:
      effects.retentions.filter(
        ({ effectKind }) =>
          effectKind ===
          "retention_obligation_completed"
      ).length,
    buyoutYearsAdvanced: effects.buyouts.filter(
      ({ effectKind }) =>
        effectKind === "buyout_year_advanced"
    ).length,
    buyoutObligationsCompleted:
      effects.buyouts.filter(
        ({ effectKind }) =>
          effectKind ===
          "buyout_obligation_completed"
      ).length,
    tradesCancelled: effects.trades.length,
  });
}

function buildAudit({
  id,
  eventType,
  reasonCode,
  leagueId,
  actorUserId,
  nowMs,
  audit,
}) {
  return Object.freeze({
    id,
    eventType,
    outcome: "success",
    actorUserId,
    targetUserId: null,
    leagueId,
    sessionId: audit.sessionId,
    requestCorrelationId:
      audit.requestCorrelationId,
    reasonCode,
    networkKeyVersion: audit.networkKeyVersion,
    networkMetadataDigest:
      audit.networkMetadataDigest,
    clientMetadataJson:
      audit.clientMetadataJson,
    unknownAccountDigest: null,
    occurredAtMs: nowMs,
  });
}

function inspectScheduledEntryDraftContext({
  value,
  binding,
  expectedDraftVersion,
}) {
  if (
    !hasExactKeys(value, ENTRY_DRAFT_CONTEXT_KEYS) ||
    !stableId(value.id) ||
    value.id !== binding.entryDraftId ||
    value.leagueId !== binding.leagueId ||
    value.targetSeasonId !== binding.toSeasonId ||
    value.status !== "ready" ||
    !safePositiveInteger(value.version) ||
    value.version !== binding.entryDraftVersion ||
    value.startsAtMs !==
      binding.scheduledStartsAtMs ||
    value.pickClockSeconds !== 300 ||
    value.selectionGateStatus !== "locked" ||
    value.tradingGateStatus !== "locked" ||
    !stableId(value.scheduleAuthorizingUserId) ||
    !stableId(
      value.scheduleAuthorizingMembershipId
    ) ||
    ![
      "commissioner",
      "platform_administrator_as_commissioner",
    ].includes(
      value.scheduleAuthorizingAuthority
    ) ||
    value.targetScheduleId !==
      binding.targetScheduleId ||
    value.targetScheduleVersion !==
      binding.targetScheduleVersion ||
    value.weekOneMatchupWeekId !==
      binding.weekOneMatchupWeekId ||
    value.weekOneStartsAtMs !==
      binding.weekOneStartsAtMs ||
    !hasExactKeys(
      value.firstUnusedPick,
      FIRST_UNUSED_PICK_KEYS
    ) ||
    !stableId(value.firstUnusedPick.id) ||
    !safePositiveInteger(
      value.firstUnusedPick.roundNumber
    ) ||
    value.firstUnusedPick.roundNumber > 4 ||
    !stableId(
      value.firstUnusedPick.owningTeamId
    ) ||
    !safePositiveInteger(
      value.firstUnusedPick.positionNumber
    ) ||
    !safePositiveInteger(
      value.firstUnusedPick.version
    ) ||
    value.firstUnusedPick.status !== "unused"
  ) {
    failRollover("entry_draft_not_ready");
  }
  if (
    expectedDraftVersion !== null &&
    value.version !== expectedDraftVersion
  ) {
    fail("SEASON_ROLLOVER_PRECONDITION_FAILED", {
      details: {
        currentVersion: value.version,
        refetch: true,
      },
    });
  }
  return deepFreeze({ ...value });
}

function inspectScheduledRolloverAggregate({
  value,
  binding,
  nowMs,
}) {
  if (!hasExactKeys(value, ROLLOVER_AGGREGATE_KEYS)) {
    failRollover("aggregate_invalid");
  }
  if (
    value.leagueId !== binding.leagueId ||
    value.sourceSeasonId !==
      binding.fromSeasonId ||
    value.currentSeasonId !==
      binding.fromSeasonId
  ) {
    fail("LEAGUE_NOT_FOUND");
  }
  if (
    !["active", "frozen"].includes(
      value.leagueStatus
    ) ||
    value.sourceSeasonStatus !== "active" ||
    !safePositiveInteger(value.leagueVersion) ||
    !safePositiveInteger(
      value.sourceSeasonVersion
    ) ||
    !safeText(value.sourceSeasonLabel, 100) ||
    !safeTimestamp(
      value.sourceFreeAgentDraftCompletedAtMs
    ) ||
    value.sourceRolloverCount !== 0 ||
    value.targetRolloverCount !== 0 ||
    value.targetIdentityCount !== 1 ||
    value.targetIdentityConflict !== false
  ) {
    failRollover("aggregate_not_ready");
  }
  const target = value.targetSeason;
  if (
    !hasExactKeys(target, TARGET_SEASON_KEYS) ||
    !stableId(target.id) ||
    target.id !== binding.toSeasonId ||
    target.leagueId !== binding.leagueId ||
    target.status !== "planned" ||
    !safePositiveInteger(target.version) ||
    target.freeAgentDraftCompletedAtMs !== null ||
    target.targetScheduleId !==
      binding.targetScheduleId ||
    target.targetScheduleVersion !==
      binding.targetScheduleVersion ||
    target.weekOneMatchupWeekId !==
      binding.weekOneMatchupWeekId ||
    target.weekOneStartsAtMs !==
      binding.weekOneStartsAtMs ||
    target.scheduleReady !== true ||
    target.disallowedStateCount !== 0
  ) {
    failRollover("planned_target_invalid");
  }
  const calendar = validateSeasonRolloverCalendar({
    leagueTimeZone: value.leagueTimeZone,
    source: {
      nhlSeasonKey: value.sourceNhlSeasonKey,
      nhlRegularSeasonStartsAtMs:
        value.sourceNhlRegularSeasonStartsAtMs,
      nhlRegularSeasonEndsAtMs:
        value.sourceNhlRegularSeasonEndsAtMs,
      fantasyPlayoffsStartAtMs:
        value.sourceFantasyPlayoffsStartAtMs,
      fantasyPlayoffsEndAtMs:
        value.sourceFantasyPlayoffsEndAtMs,
    },
    target: {
      nhlSeasonKey: target.nhlSeasonKey,
      nhlRegularSeasonStartsAtMs:
        target.nhlRegularSeasonStartsAtMs,
      nhlRegularSeasonEndsAtMs:
        target.nhlRegularSeasonEndsAtMs,
      fantasyPlayoffsStartAtMs:
        target.fantasyPlayoffsStartAtMs,
      fantasyPlayoffsEndAtMs:
        target.fantasyPlayoffsEndAtMs,
    },
    entryDraftStartsAtMs:
      binding.scheduledStartsAtMs,
    attemptedAtMs: nowMs,
    weekOneStartsAtMs:
      binding.weekOneStartsAtMs,
  });
  if (
    target.label !== calendar.targetIdentity.label ||
    target.nhlSeasonKey !==
      calendar.targetIdentity.nhlSeasonKey
  ) {
    failRollover("planned_target_invalid");
  }
  return deepFreeze({
    leagueVersionBefore: value.leagueVersion,
    leagueVersionAfter: safeVersionIncrement(
      value.leagueVersion,
      "league_version_exhausted"
    ),
    source: {
      id: value.sourceSeasonId,
      label: value.sourceSeasonLabel,
      nhlSeasonKey: value.sourceNhlSeasonKey,
      versionBefore: value.sourceSeasonVersion,
      versionAfter: safeVersionIncrement(
        value.sourceSeasonVersion,
        "source_version_exhausted"
      ),
      freeAgentDraftCompletedAtMs:
        value.sourceFreeAgentDraftCompletedAtMs,
    },
    target: {
      id: target.id,
      label: target.label,
      nhlSeasonKey: target.nhlSeasonKey,
      nhlRegularSeasonStartsAtMs:
        target.nhlRegularSeasonStartsAtMs,
      nhlRegularSeasonEndsAtMs:
        target.nhlRegularSeasonEndsAtMs,
      fantasyPlayoffsStartAtMs:
        target.fantasyPlayoffsStartAtMs,
      fantasyPlayoffsEndAtMs:
        target.fantasyPlayoffsEndAtMs,
      targetScheduleId: target.targetScheduleId,
      targetScheduleVersion:
        target.targetScheduleVersion,
      weekOneMatchupWeekId:
        target.weekOneMatchupWeekId,
      weekOneStartsAtMs:
        target.weekOneStartsAtMs,
      versionBefore: target.version,
      versionAfter: safeVersionIncrement(
        target.version,
        "target_version_exhausted"
      ),
      created: false,
    },
    calendar,
  });
}

function inspectScheduledRolloverContext({
  context,
  binding,
  expectedDraftVersion,
  nowMs,
}) {
  if (!hasExactKeys(context, ROLLOVER_CONTEXT_KEYS)) {
    failRollover("context_invalid");
  }
  const aggregate =
    inspectScheduledRolloverAggregate({
      value: context.aggregate,
      binding,
      nowMs,
    });
  const entryDraft =
    inspectScheduledEntryDraftContext({
      value: context.entryDraft,
      binding,
      expectedDraftVersion,
    });
  const sourceReadiness = inspectSourceReadiness({
    value: context.sourceReadiness,
    leagueId: binding.leagueId,
    fromSeasonId: binding.fromSeasonId,
    completedAtMs: nowMs,
  });
  if (
    sourceReadiness.projection
      .sourceFadCompletedAtMs !==
    aggregate.source.freeAgentDraftCompletedAtMs
  ) {
    failRollover(
      "source_fad_completion_marker_mismatch"
    );
  }
  const scope = Object.freeze({
    leagueId: binding.leagueId,
    sourceSeasonId: binding.fromSeasonId,
    targetSeasonId: binding.toSeasonId,
  });
  return deepFreeze({
    aggregate,
    entryDraft,
    sourceReadiness,
    matrix: inspectRolloverMatrix(
      context.matrix,
      scope
    ),
  });
}

function buildScheduledRolloverPlan({
  context,
  binding,
  attempt,
  authority,
  triggerKind,
  idempotencyRequestId,
  requestHash,
  scheduledJob,
  nowMs,
  audit,
  nextId,
}) {
  if (
    attempt.status !== "started" ||
    attempt.observedSourceSeasonVersion !==
      context.aggregate.source.versionBefore ||
    attempt.observedTargetSeasonVersion !==
      context.aggregate.target.versionBefore ||
    attempt.observedEntryDraftVersion !==
      context.entryDraft.version ||
    attempt.targetScheduleId !==
      binding.targetScheduleId ||
    attempt.targetScheduleVersion !==
      binding.targetScheduleVersion ||
    attempt.weekOneMatchupWeekId !==
      binding.weekOneMatchupWeekId ||
    attempt.weekOneStartsAtMs !==
      binding.weekOneStartsAtMs
  ) {
    failRollover(
      "rollover_attempt_observation_changed"
    );
  }
  const rolloverId = nextId();
  const aggregateActivityId = nextId();
  const securityAuditEventId = nextId();
  const outboxEventId = nextId();
  const firstPickClockId = nextId();
  const effects = planEffects(
    context.matrix,
    context.aggregate.target.id,
    nowMs,
    nextId
  );
  const summary = summaryFromEffects(effects);
  const pickClockDurationMs =
    context.entryDraft.pickClockSeconds * 1_000;
  const pickClockExpiresAtMs =
    nowMs + pickClockDurationMs;
  if (!safeTimestamp(pickClockExpiresAtMs)) {
    failRollover("first_pick_clock_invalid");
  }
  const firstPickVersionAfter =
    safeVersionIncrement(
      context.entryDraft.firstUnusedPick.version,
      "first_pick_version_exhausted"
    );
  const entryDraftVersionAfter =
    safeVersionIncrement(
      context.entryDraft.version,
      "entry_draft_version_exhausted"
    );
  const aggregateActivity = Object.freeze({
    id: aggregateActivityId,
    eventType: "season_rolled_over",
    leagueId: binding.leagueId,
    seasonId: binding.toSeasonId,
    actorUserId: authority.actorUserId,
    actorAuthority: authority.actorAuthority,
    teamId: null,
    playerId: null,
    relatedType: "season",
    relatedId: binding.toSeasonId,
    displaySummary:
      `Season ${context.aggregate.source.label} completed; ` +
      `${context.aggregate.target.label} is now active.`,
    reason: null,
    metadata: Object.freeze({
      rolloverId,
      rolloverAttemptId: attempt.attemptId,
      entryDraftId: binding.entryDraftId,
      rolloverOccurrenceId:
        binding.rolloverOccurrenceId,
      fromSeasonId: binding.fromSeasonId,
      toSeasonId: binding.toSeasonId,
      targetNhlSeasonKey:
        context.aggregate.target.nhlSeasonKey,
      triggerKind,
      summary,
    }),
    occurredAtMs: nowMs,
  });
  return deepFreeze({
    transitionType:
      triggerKind === "scheduled_job"
        ? EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER
        : RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
    triggerKind,
    rolloverId,
    attemptId: attempt.attemptId,
    bindingId: binding.bindingId,
    leagueId: binding.leagueId,
    entryDraftId: binding.entryDraftId,
    rolloverOccurrenceId:
      binding.rolloverOccurrenceId,
    occurrenceKey: binding.occurrenceKey,
    scheduledStartsAtMs:
      binding.scheduledStartsAtMs,
    scheduledJobRunId:
      scheduledJob?.runId ?? null,
    idempotencyRequestId,
    requestHash,
    authorizedByUserId: authority.actorUserId,
    authorizedByMembershipId:
      authority.membershipId,
    authorizedAuthority:
      authority.actorAuthority,
    scheduleAuthorizedByUserId:
      context.entryDraft
        .scheduleAuthorizingUserId,
    scheduleAuthorizedByMembershipId:
      context.entryDraft
        .scheduleAuthorizingMembershipId,
    scheduleAuthorizedAuthority:
      context.entryDraft
        .scheduleAuthorizingAuthority,
    completedAtMs: nowMs,
    leagueVersionBefore:
      context.aggregate.leagueVersionBefore,
    leagueVersionAfter:
      context.aggregate.leagueVersionAfter,
    source: context.aggregate.source,
    target: context.aggregate.target,
    targetSchedule: Object.freeze({
      id: binding.targetScheduleId,
      version: binding.targetScheduleVersion,
      weekOneMatchupWeekId:
        binding.weekOneMatchupWeekId,
      weekOneStartsAtMs:
        binding.weekOneStartsAtMs,
    }),
    entryDraft: Object.freeze({
      id: context.entryDraft.id,
      statusBefore: context.entryDraft.status,
      statusAfter: "active",
      versionBefore: context.entryDraft.version,
      versionAfter: entryDraftVersionAfter,
      selectionGateStatusBefore:
        context.entryDraft.selectionGateStatus,
      selectionGateStatusAfter: "open",
      tradingGateStatusBefore:
        context.entryDraft.tradingGateStatus,
      tradingGateStatusAfter: "open",
    }),
    firstPickClock: Object.freeze({
      id: firstPickClockId,
      draftPickId:
        context.entryDraft.firstUnusedPick.id,
      owningTeamId:
        context.entryDraft.firstUnusedPick
          .owningTeamId,
      draftPickVersionBefore:
        context.entryDraft.firstUnusedPick.version,
      draftPickVersionAfter:
        firstPickVersionAfter,
      roundNumber:
        context.entryDraft.firstUnusedPick
          .roundNumber,
      positionNumber:
        context.entryDraft.firstUnusedPick
          .positionNumber,
      startsAtMs: nowMs,
      expiresAtMs: pickClockExpiresAtMs,
      fullClockSeconds:
        context.entryDraft.pickClockSeconds,
    }),
    bindingVersionBefore: binding.version,
    bindingVersionAfter: safeVersionIncrement(
      binding.version,
      "rollover_binding_version_exhausted"
    ),
    sourceReadiness: context.sourceReadiness,
    summary,
    effects,
    aggregateActivity,
    securityAudit: buildAudit({
      id: securityAuditEventId,
      eventType: "league.season_rolled_over",
      reasonCode:
        triggerKind === "scheduled_job"
          ? "scheduled_entry_draft_rollover"
          : "season_rollover_retry_authorized",
      leagueId: binding.leagueId,
      actorUserId: authority.actorUserId,
      nowMs,
      audit,
    }),
    outbox: Object.freeze({
      id: outboxEventId,
      eventType: "league.changed",
      aggregateType: "league",
      aggregateId: binding.leagueId,
      scope: "league",
      leagueId: binding.leagueId,
      changedAtMs: nowMs,
    }),
  });
}

function inspectExemptionAggregate({
  value,
  leagueId,
  seasonId,
  nowMs,
}) {
  if (!hasExactKeys(value, EXEMPTION_AGGREGATE_KEYS)) {
    failExemption("aggregate_invalid");
  }
  if (
    value.leagueId !== leagueId ||
    value.seasonId !== seasonId ||
    value.currentSeasonId !== seasonId
  ) {
    fail("LEAGUE_NOT_FOUND");
  }
  if (
    !["active", "frozen"].includes(
      value.leagueStatus
    ) ||
    value.seasonCount !== 1 ||
    value.seasonStatus !== "active" ||
    value.seasonLabel !== "2026" ||
    value.nhlSeasonKey !== "20262027" ||
    value.entryDraftCount !== 0 ||
    value.fadCount !== 0 ||
    value.exemptionCount !== 0 ||
    value.fadSetupCount !== 0 ||
    ![0, 1].includes(value.weekOneCount) ||
    value.commissionerMembershipCount !== 1 ||
    !stableId(value.commissionerMembershipId) ||
    !stableId(value.commissionerUserId) ||
    value.commissionerPermissionCategory !==
      "commissioner" ||
    value.commissionerMembershipStatus !==
      "active" ||
    !safeTimestamp(value.commissionerJoinedAtMs) ||
    value.commissionerJoinedAtMs > nowMs ||
    value.commissionerEndedAtMs !== null ||
    value.commissionerUserStatus !== "active" ||
    value.commissionerNotificationEligible !== true
  ) {
    failExemption("lifecycle_not_eligible");
  }
  if (value.weekOneCount === 0) {
    if (value.weekOneStartsAtMs !== null) {
      failExemption("week_one_ambiguous");
    }
  } else {
    if (
      !safeTimestamp(value.weekOneStartsAtMs)
    ) {
      failExemption("week_one_invalid");
    }
  }
  return Object.freeze({ ...value });
}

function inspectMigrationReportCandidates(
  value,
  leagueId
) {
  if (
    !Array.isArray(value) ||
    value.some(
      (row) =>
        !hasExactKeys(row, MIGRATION_REPORT_KEYS) ||
        row.leagueId !== leagueId
    )
  ) {
    failExemption("migration_report_evidence_invalid");
  }
  const candidates = value.filter(
    (row) =>
      row.status === "succeeded" &&
      row.completedAtMs !== null &&
      row.resetManifestId ===
        "2026-season-1-reset-v1" &&
      row.shapeValid === true &&
      Number.isSafeInteger(
        row.databaseSchemaVersion
      ) &&
      row.databaseSchemaVersion >= 1
  );
  if (candidates.length !== 1) {
    failExemption(
      candidates.length === 0
        ? "migration_report_missing"
        : "migration_report_ambiguous"
    );
  }
  const report = candidates[0];
  if (
    !stableId(report.id) ||
    !safeText(report.sourceBundleId, 500) ||
    report.shapeValid !== true ||
    !safeTimestamp(report.startedAtMs) ||
    !safeTimestamp(report.completedAtMs) ||
    !safeTimestamp(report.createdAtMs) ||
    report.completedAtMs < report.startedAtMs ||
    report.createdAtMs < report.startedAtMs ||
    report.createdAtMs > report.completedAtMs ||
    !DIGEST_PATTERN.test(
      report.projectionSha256 || ""
    )
  ) {
    failExemption("migration_report_evidence_invalid");
  }
  return Object.freeze({ ...report });
}

function inspectBootstrap(value) {
  if (
    !hasExactKeys(value, BOOTSTRAP_KEYS) ||
    value.valid !== true ||
    !DIGEST_PATTERN.test(
      value.projectionSha256 || ""
    ) ||
    !stableId(value.idempotencyRequestId) ||
    !stableId(value.activityId) ||
    !stableId(value.securityAuditEventId) ||
    !stableId(value.actorUserId)
  ) {
    failExemption("bootstrap_identity_invalid");
  }
  return Object.freeze({ ...value });
}

function inspectExemptionContext({
  context,
  leagueId,
  seasonId,
  nowMs,
}) {
  if (!hasExactKeys(context, EXEMPTION_CONTEXT_KEYS)) {
    failExemption("context_invalid");
  }
  return Object.freeze({
    aggregate: inspectExemptionAggregate({
      value: context.aggregate,
      leagueId,
      seasonId,
      nowMs,
    }),
    migrationReport:
      inspectMigrationReportCandidates(
        context.migrationReports,
        leagueId
      ),
    bootstrap: inspectBootstrap(context.bootstrap),
  });
}

function inspectInitialEvidenceVerification(
  value,
  context
) {
  if (
    !hasExactKeys(value, [
      "migrationReportSha256",
      "bootstrapIdentitySha256",
    ]) ||
    value.migrationReportSha256 !==
      context.migrationReport.projectionSha256 ||
    value.bootstrapIdentitySha256 !==
      context.bootstrap.projectionSha256
  ) {
    failExemption("evidence_hash_mismatch");
  }
  return Object.freeze({ ...value });
}

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

function buildExemptionPlan({
  context,
  leagueId,
  input,
  authority,
  requestHash,
  clientKey,
  hashes,
  nowMs,
  audit,
  nextId,
}) {
  const exemptionId = nextId();
  const idempotencyRequestId = nextId();
  const activityId = nextId();
  const auditId = nextId();
  const notificationId = nextId();
  const outboxId = nextId();
  const activityOutboxId = deterministicUuid(
    `fad-setup-exemption:activity-publication:${activityId}`
  );
  const notificationOutboxId = deterministicUuid(
    `fad-setup-exemption:notification-publication:${notificationId}`
  );
  const readinessOperationId = nextId();
  const readinessJobRunId = nextId();
  const expiresAtMs =
    nowMs + IDEMPOTENCY_LIFETIME_MS;
  if (!safeTimestamp(expiresAtMs)) {
    throw new TypeError(
      "league lifecycle transition requires a safe idempotency expiry"
    );
  }
  const activityContract =
    createFreeAgentDraftActivityContract({
      eventType: "fad_setup_exemption_authorized",
      metadata: {
        exemptionId,
        seasonId: input.seasonId,
        migrationReportId:
          context.migrationReport.id,
      },
    });
  const notificationContract =
    createFreeAgentDraftNotificationContract({
      type: "fad_setup_exemption_authorized",
      recipientUserId:
        context.aggregate.commissionerUserId,
      messageData: {
        leagueId,
        seasonId: input.seasonId,
        exemptionId,
        destination: {
          kind: "commissioner_fad",
          leagueId,
          seasonId: input.seasonId,
        },
      },
    });
  const activity = Object.freeze({
    id: activityId,
    eventType: activityContract.eventType,
    leagueId,
    seasonId: input.seasonId,
    actorUserId: authority.actorUserId,
    actorAuthority: authority.actorAuthority,
    teamId: null,
    playerId: null,
    relatedType: "season",
    relatedId: input.seasonId,
    displaySummary:
      "Initial Season 2 Free Agent Draft exemption authorized.",
    reason: null,
    metadata: activityContract.metadata,
    occurredAtMs: nowMs,
  });
  return deepFreeze({
    transitionType:
      INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
    exemptionId,
    readinessOperationId,
    readinessJobRunId,
    idempotencyRequestId,
    leagueId,
    seasonId: input.seasonId,
    exemptionKind: SETUP_EXEMPTION_KIND,
    reason: input.reason,
    clientKey,
    requestHash,
    idempotencyExpiresAtMs: expiresAtMs,
    authorizedByUserId: authority.actorUserId,
    authorizedByMembershipId:
      authority.membershipId,
    authorizedAuthority:
      authority.actorAuthority,
    authorizedAtMs: nowMs,
    migrationReportId:
      context.migrationReport.id,
    migrationReportSha256:
      hashes.migrationReportSha256,
    bootstrapIdentitySha256:
      hashes.bootstrapIdentitySha256,
    bootstrapIdempotencyRequestId:
      context.bootstrap.idempotencyRequestId,
    bootstrapActivityId:
      context.bootstrap.activityId,
    bootstrapSecurityAuditEventId:
      context.bootstrap.securityAuditEventId,
    bootstrapActorUserId:
      context.bootstrap.actorUserId,
    activity,
    securityAudit: buildAudit({
      id: auditId,
      eventType: "fad.setup_exemption_authorized",
      reasonCode:
        "initial_season2_no_draft_authorized",
      leagueId,
      actorUserId: authority.actorUserId,
      nowMs,
      audit,
    }),
    notification: Object.freeze({
      id: notificationId,
      userId: notificationContract.recipientUserId,
      type: notificationContract.type,
      status: "pending",
      messageData: notificationContract.messageData,
      relatedFeature: "free_agent_draft_setup",
      relatedRecordId: exemptionId,
      deduplicationKey:
        notificationContract.deduplicationKey,
      createdAtMs: nowMs,
      version: 1,
    }),
    outbox: Object.freeze({
      id: outboxId,
      eventType: "league.changed",
      aggregateType: "league",
      aggregateId: leagueId,
      scope: "league",
      leagueId,
      changedAtMs: nowMs,
    }),
    activityOutbox: Object.freeze({
      id: activityOutboxId,
      eventType: "activity.created",
      aggregateType: "activity",
      aggregateId: activityId,
      scope: "league",
      leagueId,
      changedAtMs: nowMs,
      reasonCode: "setup_exemption_authorized",
      version: 1,
    }),
    notificationOutbox: Object.freeze({
      id: notificationOutboxId,
      eventType: "notification.created",
      aggregateType: "notification",
      aggregateId: notificationId,
      scope: "user",
      userId: notificationContract.recipientUserId,
      leagueId,
      changedAtMs: nowMs,
      reasonCode: "setup_exemption_authorized",
      version: 1,
    }),
  });
}

function exemptionResultFromPlan(plan) {
  return safeSetupExemptionResult({
    exemptionId: plan.exemptionId,
    leagueId: plan.leagueId,
    seasonId: plan.seasonId,
    exemptionKind: plan.exemptionKind,
    reason: plan.reason,
    authorizedByUserId:
      plan.authorizedByUserId,
    authorizedAuthority:
      plan.authorizedAuthority,
    authorizedAtMs: plan.authorizedAtMs,
    consumed: false,
    migrationReportId: plan.migrationReportId,
    version: 1,
  });
}

function idempotencyInsert(plan) {
  return Object.freeze({
    id: plan.idempotencyRequestId,
    leagueId: plan.leagueId,
    actorUserId: plan.authorizedByUserId,
    operation:
      LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
    clientKey: plan.clientKey,
    requestHash: plan.requestHash,
    createdAtMs:
      plan.completedAtMs ?? plan.authorizedAtMs,
    expiresAtMs: plan.idempotencyExpiresAtMs,
  });
}

function completeIdempotency(
  repository,
  plan,
  resultType,
  resultId
) {
  repository.completeIdempotencyRequest({
    id: plan.idempotencyRequestId,
    leagueId: plan.leagueId,
    resultType,
    resultId,
    completedAtMs:
      plan.completedAtMs ?? plan.authorizedAtMs,
  });
}

function requireFreshReadinessHandoff(
  result,
  plan
) {
  if (
    !hasExactKeys(result, [
      "replayed",
      "readiness",
    ]) ||
    result.replayed !== false ||
    !isDeepStrictEqual(result.readiness, {
      id: plan.readiness.operationId,
      leagueId: plan.readiness.leagueId,
      seasonId: plan.readiness.seasonId,
      occurrenceKey:
        plan.readiness.occurrenceKey,
      triggerKind:
        plan.readiness.triggerKind,
      entryDraftId:
        plan.readiness.entryDraftId,
      setupExemptionId:
        plan.readiness.setupExemptionId,
      jobRunId: plan.job.id,
      status: "pending",
      attemptCount: 0,
      blockers: [],
      matchupScheduleVersionBefore: null,
      matchupScheduleVersionAfter: null,
      scheduleRecoveryId: null,
      createdFadId: null,
      reminderJobRunId: null,
      deadlineJobRunId: null,
      cardsOpenedActivityId: null,
      cardsOpenedOutboxEventId: null,
      startedAtMs: null,
      nextRetryAtMs: null,
      terminalAtMs: null,
      createdAtMs:
        plan.readiness.createdAtMs,
      updatedAtMs:
        plan.readiness.createdAtMs,
      version: 1,
    })
  ) {
    fail(
      "INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE"
    );
  }
}

function executeExemption(
  repository,
  freeAgentDraftReadinessHandoffWriter,
  plan
) {
  repository.insertStartedIdempotencyRequest(
    idempotencyInsert(plan)
  );
  repository.appendSetupExemptionEvidence({
    plan,
  });
  repository.insertSetupExemption({
    plan,
  });
  const verified =
    repository.verifySetupExemptionEvidence({
      plan,
    });
  if (
    !hasExactKeys(verified, [
      "migrationReportSha256",
      "bootstrapIdentitySha256",
    ]) ||
    verified.migrationReportSha256 !==
      plan.migrationReportSha256 ||
    verified.bootstrapIdentitySha256 !==
      plan.bootstrapIdentitySha256
  ) {
    fail(
      "INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE"
    );
  }
  const readinessPlan =
    createFreeAgentDraftReadinessTriggerPlan({
      operationId: plan.readinessOperationId,
      jobRunId: plan.readinessJobRunId,
      leagueId: plan.leagueId,
      seasonId: plan.seasonId,
      triggerKind:
        "no_draft_initial_season2",
      triggerResourceId: plan.exemptionId,
      entryDraftId: null,
      setupExemptionId: plan.exemptionId,
      createdAtMs: plan.authorizedAtMs,
    });
  requireFreshReadinessHandoff(
    freeAgentDraftReadinessHandoffWriter.write({
      operationId:
        readinessPlan.readiness.operationId,
      jobRunId: readinessPlan.job.id,
      leagueId:
        readinessPlan.readiness.leagueId,
      seasonId:
        readinessPlan.readiness.seasonId,
      triggerKind:
        readinessPlan.readiness.triggerKind,
      triggerResourceId: plan.exemptionId,
      entryDraftId:
        readinessPlan.readiness.entryDraftId,
      setupExemptionId:
        readinessPlan.readiness.setupExemptionId,
      createdAtMs:
        readinessPlan.readiness.createdAtMs,
    }),
    readinessPlan
  );
  completeIdempotency(
    repository,
    plan,
    SETUP_EXEMPTION_RESULT_TYPE,
    plan.exemptionId
  );
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function createLeagueLifecycleTransitionService({
  repositoryContext,
  leagueAuthorization,
  platformAuthorization,
  leagueLifecycleTransitionRepository,
  freeAgentDraftReadinessHandoffWriter,
  lateLockCoordinator,
  clock,
  secureRandom,
} = {}) {
  requireMethod(
    repositoryContext,
    "transaction",
    "an immediate repository transaction boundary"
  );
  for (const method of [
    "requireActiveMembership",
    "requireCommissioner",
  ]) {
    requireMethod(
      leagueAuthorization,
      method,
      "league authorization"
    );
  }
  requireMethod(
    platformAuthorization,
    "requireAdministrator",
    "platform-administrator authorization"
  );
  for (const method of REPOSITORY_METHODS) {
    requireMethod(
      leagueLifecycleTransitionRepository,
      method,
      `a lifecycle-transition repository with ${method}`
    );
  }
  requireMethod(
    freeAgentDraftReadinessHandoffWriter,
    "write",
    "a FAD readiness handoff writer"
  );
  requireMethod(
    lateLockCoordinator,
    "coordinateCommittedRoster",
    "a late-lock coordinator"
  );
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );

  async function coordinateCommittedRollover(
    result
  ) {
    if (result.status !== "succeeded") {
      return result;
    }
    let lateLock;
    try {
      const receipt =
        inspectRolloverOwnershipReceipt({
          value:
            leagueLifecycleTransitionRepository
              .findDurableSeasonRolloverOwnershipReceipt(
                {
                  leagueId: result.leagueId,
                  rolloverId: result.rolloverId,
                }
              ),
          leagueId: result.leagueId,
          rolloverId: result.rolloverId,
          fromSeasonId: result.fromSeasonId,
          toSeasonId: result.toSeasonId,
        });
      lateLock =
        receipt.teams.length === 0
          ? NOT_APPLICABLE_LATE_LOCK
          : safeLateLockProjection(
              await lateLockCoordinator
                .coordinateCommittedRoster(
                  deepFreeze({
                    mutationKind:
                      "contract_rollover",
                    teams: receipt.teams,
                  })
                )
            );
    } catch {
      lateLock = AWAITING_DATA_LATE_LOCK;
    }
    return internalResult(
      { ...result, lateLock },
      result.replayed === true
    );
  }

  function loadBinding(leagueId, input) {
    const row =
      leagueLifecycleTransitionRepository
        .findRolloverBindingByOccurrence({
          leagueId,
          entryDraftId: input.entryDraftId,
          rolloverOccurrenceId:
            input.rolloverOccurrenceId,
        });
    if (row === null) {
      failRollover(
        "rollover_occurrence_not_found"
      );
    }
    return inspectRolloverBinding({
      value: row,
      leagueId,
      input,
    });
  }

  function loadLatestAttempt(binding) {
    const row =
      leagueLifecycleTransitionRepository
        .findLatestSeasonRolloverAttempt({
          leagueId: binding.leagueId,
          bindingId: binding.bindingId,
          rolloverOccurrenceId:
            binding.rolloverOccurrenceId,
        });
    if (row === null) return null;
    const attempt = inspectRolloverAttempt({
      value: row,
      binding,
    });
    return attempt;
  }

  function validateTerminalAttemptReplay({
    row,
    leagueId,
    input,
    actorUserId = null,
  }) {
    let attemptRow;
    let receipt = null;
    if (
      row.resultType ===
      SEASON_ROLLOVER_ATTEMPT_RESULT_TYPE
    ) {
      attemptRow =
        leagueLifecycleTransitionRepository
          .findDurableSeasonRolloverAttempt({
            leagueId,
            attemptId: row.resultId,
          });
    } else {
      receipt = inspectRolloverCommitReceipt({
        value:
          leagueLifecycleTransitionRepository
            .findDurableSeasonRolloverResult({
              leagueId,
              rolloverId: row.resultId,
            }),
      });
      attemptRow =
        leagueLifecycleTransitionRepository
          .findDurableSeasonRolloverAttempt({
            leagueId,
            attemptId:
              receipt.rolloverAttemptId,
          });
    }
    if (attemptRow === null) {
      fail("SEASON_ROLLOVER_RESULT_UNAVAILABLE");
    }
    const attempt = inspectRolloverAttempt({
      value: attemptRow,
    });
    if (
      attempt.leagueId !== leagueId ||
      attempt.entryDraftId !==
        input.entryDraftId ||
      attempt.rolloverOccurrenceId !==
        input.rolloverOccurrenceId ||
      attempt.triggerKind !==
        "commissioner_retry" ||
      attempt.retryActorUserId !==
        actorUserId ||
      attempt.retryIdempotencyRequestId !==
        row.id ||
      attempt.terminalAtMs !==
        row.completedAtMs ||
      (row.resultType ===
        SEASON_ROLLOVER_ATTEMPT_RESULT_TYPE
        ? attempt.status !== "blocked" ||
          attempt.attemptId !== row.resultId
        : attempt.status !== "succeeded" ||
          attempt.rolloverId !== row.resultId ||
          receipt.rolloverId !== row.resultId ||
          receipt.rolloverAttemptId !==
            attempt.attemptId)
    ) {
      fail("SEASON_ROLLOVER_RESULT_UNAVAILABLE");
    }
    return rolloverAttemptResult(attempt, true);
  }

  function retryIdempotencyInsert({
    id,
    leagueId,
    actorUserId,
    clientKey,
    requestHash,
    nowMs,
  }) {
    const expiresAtMs =
      nowMs + IDEMPOTENCY_LIFETIME_MS;
    if (!safeTimestamp(expiresAtMs)) {
      throw new TypeError(
        "league lifecycle transition requires a safe idempotency expiry"
      );
    }
    return Object.freeze({
      id,
      leagueId,
      actorUserId,
      operation:
        LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
      clientKey,
      requestHash,
      createdAtMs: nowMs,
      expiresAtMs,
    });
  }

  function beginAttempt({
    binding,
    priorAttempt,
    triggerKind,
    attemptId,
    startedAtMs,
    scheduledJob,
    idempotencyRequestId,
    authority,
  }) {
    const row =
      leagueLifecycleTransitionRepository
        .beginSeasonRolloverAttempt({
          attemptId,
          bindingId: binding.bindingId,
          leagueId: binding.leagueId,
          entryDraftId:
            binding.entryDraftId,
          rolloverOccurrenceId:
            binding.rolloverOccurrenceId,
          fromSeasonId:
            binding.fromSeasonId,
          toSeasonId: binding.toSeasonId,
          targetScheduleId:
            binding.targetScheduleId,
          targetScheduleVersion:
            binding.targetScheduleVersion,
          weekOneMatchupWeekId:
            binding.weekOneMatchupWeekId,
          weekOneStartsAtMs:
            binding.weekOneStartsAtMs,
          expectedBindingVersion:
            binding.version,
          expectedPriorAttemptId:
            priorAttempt?.attemptId ?? null,
          expectedPriorAttemptNumber:
            priorAttempt?.attemptNumber ?? 0,
          triggerKind,
          scheduledJob:
            scheduledJob ?? null,
          retryIdempotencyRequestId:
            idempotencyRequestId,
          retryActorUserId:
            triggerKind === "commissioner_retry"
              ? authority.actorUserId
              : null,
          retryActorMembershipId:
            triggerKind === "commissioner_retry"
              ? authority.membershipId
              : null,
          retryAuthority:
            triggerKind === "commissioner_retry"
              ? authority.actorAuthority
              : null,
          startedAtMs,
          observedSourceSeasonVersion:
            binding.sourceSeasonVersion,
          observedTargetSeasonVersion:
            binding.targetSeasonVersion,
          observedEntryDraftVersion:
            binding.entryDraftVersion,
        });
    const attempt = inspectRolloverAttempt({
      value: row,
      binding,
    });
    if (
      attempt.attemptId !== attemptId ||
      attempt.attemptNumber !==
        (priorAttempt?.attemptNumber ?? 0) + 1 ||
      attempt.triggerKind !== triggerKind ||
      attempt.status !== "started" ||
      attempt.startedAtMs !== startedAtMs ||
      attempt.scheduledJobRunId !==
        (scheduledJob?.runId ?? null) ||
      attempt.retryIdempotencyRequestId !==
        idempotencyRequestId ||
      attempt.retryActorUserId !==
        (triggerKind === "commissioner_retry"
          ? authority.actorUserId
          : null) ||
      attempt.retryActorMembershipId !==
        (triggerKind === "commissioner_retry"
          ? authority.membershipId
          : null) ||
      attempt.retryAuthority !==
        (triggerKind === "commissioner_retry"
          ? authority.actorAuthority
          : null)
    ) {
      fail("SEASON_ROLLOVER_RESULT_UNAVAILABLE");
    }
    return attempt;
  }

  function prepareRetry({
    leagueId,
    input,
    expectedDraftVersion,
    clientKey,
    authenticated,
    auditContext,
  }) {
    return repositoryContext.transaction(() => {
      const authority =
        canonicalRolloverAuthority(
          leagueAuthorization.requireCommissioner(
            authenticated,
            leagueId
          )
        );
      const requestHash =
        leagueLifecycleTransitionRequestHash({
          actorUserId: authority.actorUserId,
          leagueId,
          input,
          expectedDraftVersion,
        });
      const existing =
        leagueLifecycleTransitionRepository
          .findIdempotencyRequest({
            leagueId,
            operation:
              LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
            clientKey,
          });
      if (existing !== null) {
        const row =
          inspectRetryIdempotencyRequest({
            row: existing,
            leagueId,
            actorUserId:
              authority.actorUserId,
            clientKey,
            requestHash,
          });
        if (row.status === "completed") {
          return Object.freeze({
            result:
              validateTerminalAttemptReplay({
                row,
                leagueId,
                input,
                actorUserId:
                  authority.actorUserId,
              }),
          });
        }
        const binding = loadBinding(
          leagueId,
          input
        );
        if (binding.status === "superseded") {
          failRollover(
            "rollover_occurrence_superseded"
          );
        }
        const attemptRow =
          leagueLifecycleTransitionRepository
            .findSeasonRolloverAttemptByIdempotencyRequest(
              {
                leagueId,
                idempotencyRequestId: row.id,
              }
            );
        if (attemptRow === null) {
          fail(
            "IDEMPOTENCY_REQUEST_UNAVAILABLE"
          );
        }
        const attempt = inspectRolloverAttempt({
          value: attemptRow,
          binding,
        });
        const latestAttempt =
          loadLatestAttempt(binding);
        if (
          attempt.status !== "started" ||
          attempt.triggerKind !==
            "commissioner_retry" ||
          attempt.retryActorUserId !==
            authority.actorUserId ||
          attempt.retryIdempotencyRequestId !==
            row.id ||
          latestAttempt === null ||
          latestAttempt.attemptId !==
            attempt.attemptId
        ) {
          fail(
            "IDEMPOTENCY_REQUEST_UNAVAILABLE"
          );
        }
        return Object.freeze({
          result: null,
          binding,
          attempt,
          authority,
          requestHash,
          idempotencyRequestId: row.id,
          audit: safeAuditContext(
            authenticated,
            auditContext
          ),
          scheduledJob: null,
          triggerKind: "commissioner_retry",
        });
      }

      const binding = loadBinding(leagueId, input);
      if (binding.status === "superseded") {
        failRollover(
          "rollover_occurrence_superseded"
        );
      }
      const priorAttempt =
        loadLatestAttempt(binding);
      if (
        binding.status !== "blocked" ||
        priorAttempt === null ||
        priorAttempt.status !== "blocked"
      ) {
        failRollover(
          "blocked_occurrence_required"
        );
      }
      if (
        binding.entryDraftVersion !==
        expectedDraftVersion
      ) {
        fail(
          "SEASON_ROLLOVER_PRECONDITION_FAILED",
          {
            details: {
              currentVersion:
                binding.entryDraftVersion,
              refetch: true,
            },
          }
        );
      }
      const nowMs = safeNow(clock);
      const nextId =
        createSecureIdFactory(secureRandom);
      const idempotencyRequestId = nextId();
      leagueLifecycleTransitionRepository
        .insertStartedIdempotencyRequest(
          retryIdempotencyInsert({
            id: idempotencyRequestId,
            leagueId,
            actorUserId:
              authority.actorUserId,
            clientKey,
            requestHash,
            nowMs,
          })
        );
      const attempt = beginAttempt({
        binding,
        priorAttempt,
        triggerKind: "commissioner_retry",
        attemptId: nextId(),
        startedAtMs: nowMs,
        scheduledJob: null,
        idempotencyRequestId,
        authority,
      });
      return Object.freeze({
        result: null,
        binding,
        attempt,
        authority,
        requestHash,
        idempotencyRequestId,
        audit: safeAuditContext(
          authenticated,
          auditContext
        ),
        scheduledJob: null,
        triggerKind: "commissioner_retry",
      });
    });
  }

  function terminalScheduledReplay({
    binding,
    attempt,
  }) {
    if (
      (binding.status === "blocked" &&
        attempt.status !== "blocked") ||
      (binding.status === "succeeded" &&
        attempt.status !== "succeeded")
    ) {
      fail("SEASON_ROLLOVER_RESULT_UNAVAILABLE");
    }
    if (attempt.status === "succeeded") {
      const receipt = inspectRolloverCommitReceipt({
        value:
          leagueLifecycleTransitionRepository
            .findDurableSeasonRolloverResult({
              leagueId: binding.leagueId,
              rolloverId: attempt.rolloverId,
            }),
      });
      if (
        receipt.rolloverAttemptId !==
          attempt.attemptId ||
        receipt.entryDraftId !==
          binding.entryDraftId ||
        receipt.rolloverOccurrenceId !==
          binding.rolloverOccurrenceId ||
        receipt.entryDraftRolloverBindingId !==
          binding.bindingId ||
        receipt.weekOneMatchupWeekId !==
          binding.weekOneMatchupWeekId
      ) {
        fail("SEASON_ROLLOVER_RESULT_UNAVAILABLE");
      }
    }
    return rolloverAttemptResult(attempt, true);
  }

  function prepareScheduled({
    leagueId,
    input,
    scheduledJob,
  }) {
    return repositoryContext.transaction(() => {
      const binding = loadBinding(leagueId, input);
      if (binding.status === "superseded") {
        failRollover(
          "rollover_occurrence_superseded"
        );
      }
      if (
        binding.occurrenceKey !==
          scheduledJob.occurrenceKey ||
        binding.scheduledStartsAtMs !==
          scheduledJob.scheduledForMs
      ) {
        failRollover(
          "scheduled_job_binding_mismatch"
        );
      }
      const latestAttempt =
        loadLatestAttempt(binding);
      if (
        ["blocked", "succeeded"].includes(
          binding.status
        )
      ) {
        if (latestAttempt === null) {
          fail(
            "SEASON_ROLLOVER_RESULT_UNAVAILABLE"
          );
        }
        return Object.freeze({
          result: terminalScheduledReplay({
            binding,
            attempt: latestAttempt,
          }),
        });
      }
      leagueLifecycleTransitionRepository
        .validateScheduledRolloverJobLease({
          leagueId,
          bindingId: binding.bindingId,
          entryDraftId:
            binding.entryDraftId,
          rolloverOccurrenceId:
            binding.rolloverOccurrenceId,
          scheduledJob,
        });
      if (latestAttempt !== null) {
        if (
          latestAttempt.status !== "started" ||
          latestAttempt.triggerKind !==
            "scheduled_job" ||
          latestAttempt.scheduledJobRunId !==
            scheduledJob.runId
        ) {
          fail(
            "SEASON_ROLLOVER_RESULT_UNAVAILABLE"
          );
        }
        return Object.freeze({
          result: null,
          binding,
          attempt: latestAttempt,
          authority: Object.freeze({
            actorUserId: null,
            membershipId: null,
            actorAuthority: "system",
          }),
          requestHash: null,
          idempotencyRequestId: null,
          audit: safeAuditContext(null, null),
          scheduledJob,
          triggerKind: "scheduled_job",
        });
      }
      const nowMs = safeNow(clock);
      if (nowMs < binding.scheduledStartsAtMs) {
        failRollover(
          "scheduled_occurrence_not_due"
        );
      }
      const nextId =
        createSecureIdFactory(secureRandom);
      const authority = Object.freeze({
        actorUserId: null,
        membershipId: null,
        actorAuthority: "system",
      });
      const attempt = beginAttempt({
        binding,
        priorAttempt: null,
        triggerKind: "scheduled_job",
        attemptId: nextId(),
        startedAtMs: nowMs,
        scheduledJob,
        idempotencyRequestId: null,
        authority,
      });
      return Object.freeze({
        result: null,
        binding,
        attempt,
        authority,
        requestHash: null,
        idempotencyRequestId: null,
        audit: safeAuditContext(null, null),
        scheduledJob,
        triggerKind: "scheduled_job",
      });
    });
  }

  function persistBlockedAttempt(
    preparation,
    error
  ) {
    const blockers =
      rolloverBlockersFromError(error);
    return repositoryContext.transaction(() => {
      const binding = loadBinding(
        preparation.binding.leagueId,
        {
          entryDraftId:
            preparation.binding.entryDraftId,
          rolloverOccurrenceId:
            preparation.binding
              .rolloverOccurrenceId,
        }
      );
      const latestAttempt =
        loadLatestAttempt(binding);
      if (
        latestAttempt === null ||
        latestAttempt.attemptId !==
          preparation.attempt.attemptId ||
        latestAttempt.status !== "started" ||
        binding.selectionGateStatus !==
          "locked" ||
        binding.tradingGateStatus !== "locked"
      ) {
        fail(
          "SEASON_ROLLOVER_RESULT_UNAVAILABLE"
        );
      }
      if (
        preparation.triggerKind ===
        "scheduled_job"
      ) {
        leagueLifecycleTransitionRepository
          .validateScheduledRolloverJobLease({
            leagueId: binding.leagueId,
            bindingId: binding.bindingId,
            entryDraftId:
              binding.entryDraftId,
            rolloverOccurrenceId:
              binding.rolloverOccurrenceId,
            scheduledJob:
              preparation.scheduledJob,
          });
      }
      const blockedAtMs = safeNow(clock);
      const row =
        leagueLifecycleTransitionRepository
          .blockSeasonRolloverAttempt({
            attemptId:
              preparation.attempt.attemptId,
            bindingId: binding.bindingId,
            leagueId: binding.leagueId,
            entryDraftId:
              binding.entryDraftId,
            rolloverOccurrenceId:
              binding.rolloverOccurrenceId,
            expectedBindingVersion:
              binding.version,
            expectedSourceSeasonVersion:
              preparation.attempt
                .observedSourceSeasonVersion,
            expectedTargetSeasonVersion:
              preparation.attempt
                .observedTargetSeasonVersion,
            expectedEntryDraftVersion:
              preparation.attempt
                .observedEntryDraftVersion,
            triggerKind:
              preparation.triggerKind,
            scheduledJob:
              preparation.scheduledJob,
            retryIdempotencyRequestId:
              preparation.idempotencyRequestId,
            blockers,
            blockedAtMs,
          });
      const attempt = inspectRolloverAttempt({
        value: row,
        binding,
      });
      if (
        attempt.attemptId !==
          preparation.attempt.attemptId ||
        attempt.status !== "blocked" ||
        attempt.terminalAtMs !== blockedAtMs ||
        !isDeepStrictEqual(
          attempt.blockers,
          blockers
        )
      ) {
        fail("SEASON_ROLLOVER_RESULT_UNAVAILABLE");
      }
      const durable = inspectRolloverAttempt({
        value:
          leagueLifecycleTransitionRepository
            .findDurableSeasonRolloverAttempt({
              leagueId: binding.leagueId,
              attemptId: attempt.attemptId,
            }),
        binding,
      });
      if (
        !isDeepStrictEqual(durable, attempt)
      ) {
        fail(
          "SEASON_ROLLOVER_RESULT_UNAVAILABLE"
        );
      }
      if (
        preparation.triggerKind ===
        "commissioner_retry"
      ) {
        leagueLifecycleTransitionRepository
          .completeIdempotencyRequest({
            id:
              preparation.idempotencyRequestId,
            leagueId: binding.leagueId,
            resultType:
              SEASON_ROLLOVER_ATTEMPT_RESULT_TYPE,
            resultId: attempt.attemptId,
            completedAtMs: blockedAtMs,
          });
      }
      return rolloverAttemptResult(
        durable,
        false
      );
    });
  }

  function runPreparedAttempt(preparation) {
    try {
      return repositoryContext.transaction(() => {
        const binding = loadBinding(
          preparation.binding.leagueId,
          {
            entryDraftId:
              preparation.binding.entryDraftId,
            rolloverOccurrenceId:
              preparation.binding
                .rolloverOccurrenceId,
          }
        );
        const latestAttempt =
          loadLatestAttempt(binding);
        if (
          latestAttempt === null ||
          latestAttempt.attemptId !==
            preparation.attempt.attemptId ||
          latestAttempt.status !== "started" ||
          binding.sourceSeasonVersion !==
            preparation.attempt
              .observedSourceSeasonVersion ||
          binding.targetSeasonVersion !==
            preparation.attempt
              .observedTargetSeasonVersion ||
          binding.entryDraftVersion !==
            preparation.attempt
              .observedEntryDraftVersion ||
          binding.selectionGateStatus !==
            "locked" ||
          binding.tradingGateStatus !== "locked"
        ) {
          failRollover(
            "rollover_observation_changed"
          );
        }
        if (
          preparation.triggerKind ===
          "scheduled_job"
        ) {
          leagueLifecycleTransitionRepository
            .validateScheduledRolloverJobLease({
              leagueId: binding.leagueId,
              bindingId: binding.bindingId,
              entryDraftId:
                binding.entryDraftId,
              rolloverOccurrenceId:
                binding.rolloverOccurrenceId,
              scheduledJob:
                preparation.scheduledJob,
            });
        }
        const nowMs = safeNow(clock);
        const rawContext =
          leagueLifecycleTransitionRepository
            .readSeasonRolloverContext({
              leagueId: binding.leagueId,
              bindingId: binding.bindingId,
              entryDraftId:
                binding.entryDraftId,
              rolloverOccurrenceId:
                binding.rolloverOccurrenceId,
              fromSeasonId:
                binding.fromSeasonId,
              toSeasonId:
                binding.toSeasonId,
              targetScheduleId:
                binding.targetScheduleId,
              observedAtMs: nowMs,
            });
        if (rawContext === null) {
          failRollover(
            "rollover_context_unavailable"
          );
        }
        const context =
          inspectScheduledRolloverContext({
            context: rawContext,
            binding,
            expectedDraftVersion: null,
            nowMs,
          });
        const plan = buildScheduledRolloverPlan({
          context,
          binding,
          attempt: preparation.attempt,
          authority: preparation.authority,
          triggerKind:
            preparation.triggerKind,
          idempotencyRequestId:
            preparation.idempotencyRequestId,
          requestHash:
            preparation.requestHash,
          scheduledJob:
            preparation.scheduledJob,
          nowMs,
          audit: preparation.audit,
          nextId:
            createSecureIdFactory(secureRandom),
        });
        const receipt =
          inspectRolloverCommitReceipt({
            value:
              leagueLifecycleTransitionRepository
                .commitSeasonRolloverAndOpenDraft({
                  plan,
                  scheduledJob:
                    preparation.scheduledJob,
                }),
            plan,
          });
        const durableReceipt =
          inspectRolloverCommitReceipt({
            value:
              leagueLifecycleTransitionRepository
                .findDurableSeasonRolloverResult({
                  leagueId: binding.leagueId,
                  rolloverId: plan.rolloverId,
                }),
            plan,
          });
        if (
          JSON.stringify(durableReceipt) !==
          JSON.stringify(receipt)
        ) {
          fail("SEASON_ROLLOVER_RESULT_UNAVAILABLE");
        }
        const attempt = inspectRolloverAttempt({
          value:
            leagueLifecycleTransitionRepository
              .findDurableSeasonRolloverAttempt({
                leagueId: binding.leagueId,
                attemptId:
                  preparation.attempt.attemptId,
              }),
          binding,
        });
        if (
          attempt.status !== "succeeded" ||
          attempt.rolloverId !==
            receipt.rolloverId ||
          attempt.terminalAtMs !== nowMs
        ) {
          fail("SEASON_ROLLOVER_RESULT_UNAVAILABLE");
        }
        if (
          preparation.triggerKind ===
          "commissioner_retry"
        ) {
          leagueLifecycleTransitionRepository
            .completeIdempotencyRequest({
              id:
                preparation.idempotencyRequestId,
              leagueId: binding.leagueId,
              resultType:
                SEASON_ROLLOVER_RESULT_TYPE,
              resultId: receipt.rolloverId,
              completedAtMs: nowMs,
            });
        }
        return rolloverAttemptResult(
          attempt,
          false
        );
      });
    } catch (error) {
      if (
        errorChain(error).some(
          (candidate) =>
            candidate?.code ===
              "SEASON_ROLLOVER_NOT_READY" ||
            (candidate instanceof
              LeagueLifecycleTransitionPolicyError &&
              candidate.code ===
                "SEASON_ROLLOVER_NOT_READY")
        )
      ) {
        return persistBlockedAttempt(
          preparation,
          error
        );
      }
      throw error;
    }
  }

  function executeExemptionCommand({
    leagueId,
    input,
    clientKey,
    authenticated,
    auditContext,
  }) {
    return repositoryContext.transaction(() => {
      const authority = requireExemptionAuthority({
        authenticated,
        leagueId,
        leagueAuthorization,
        platformAuthorization,
      });
      const requestHash =
        leagueLifecycleTransitionRequestHash({
          actorUserId: authority.actorUserId,
          leagueId,
          input,
          expectedDraftVersion: null,
        });
      const existing =
        leagueLifecycleTransitionRepository
          .findIdempotencyRequest({
            leagueId,
            operation:
              LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
            clientKey,
          });
      if (existing !== null) {
        const replay = inspectIdempotencyReplay({
          row: existing,
          leagueId,
          actorUserId:
            authority.actorUserId,
          clientKey,
          requestHash,
          resultType:
            SETUP_EXEMPTION_RESULT_TYPE,
        });
        return validateReplayResult({
          repository:
            leagueLifecycleTransitionRepository,
          row: replay,
          input,
          leagueId,
          actorUserId:
            authority.actorUserId,
        });
      }
      const nowMs = safeNow(clock);
      const rawContext =
        leagueLifecycleTransitionRepository
          .readInitialSeason2ExemptionContext({
            leagueId,
            seasonId: input.seasonId,
            observedAtMs: nowMs,
          });
      if (rawContext === null) {
        fail("LEAGUE_NOT_FOUND");
      }
      const context = inspectExemptionContext({
        context: rawContext,
        leagueId,
        seasonId: input.seasonId,
        nowMs,
      });
      const hashes =
        inspectInitialEvidenceVerification(
          leagueLifecycleTransitionRepository
            .verifyInitialSeason2Evidence({
              leagueId,
              seasonId: input.seasonId,
              migrationReportId:
                context.migrationReport.id,
              bootstrapIdempotencyRequestId:
                context.bootstrap
                  .idempotencyRequestId,
            }),
          context
        );
      const plan = buildExemptionPlan({
        context,
        leagueId,
        input,
        authority,
        requestHash,
        clientKey,
        hashes,
        nowMs,
        audit: safeAuditContext(
          authenticated,
          auditContext
        ),
        nextId:
          createSecureIdFactory(secureRandom),
      });
      executeExemption(
        leagueLifecycleTransitionRepository,
        freeAgentDraftReadinessHandoffWriter,
        plan
      );
      const expected = exemptionResultFromPlan(
        plan
      );
      const durable = safeSetupExemptionResult(
        leagueLifecycleTransitionRepository
          .findDurableSetupExemptionResult({
            leagueId,
            exemptionId: plan.exemptionId,
          })
      );
      if (
        JSON.stringify(durable) !==
        JSON.stringify(expected)
      ) {
        fail(
          "INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE"
        );
      }
      return internalResult(durable, false);
    });
  }

  function mapPublicError(error, transitionType) {
    const chain = errorChain(error);
    const applicationError = chain.find(
      (candidate) =>
        candidate instanceof
          LeagueLifecycleTransitionServiceError ||
        candidate instanceof
          LeagueLifecycleTransitionPolicyError ||
        [
          "LEAGUE_COMMISSIONER_REQUIRED",
          "LEAGUE_NOT_FOUND",
          "PLATFORM_ADMINISTRATOR_REQUIRED",
        ].includes(candidate?.code)
    );
    if (applicationError) throw applicationError;
    if (
      chain.some(
        (candidate) =>
          candidate?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      ) &&
      transitionType ===
        RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
    ) {
      fail(
        "SEASON_ROLLOVER_PRECONDITION_FAILED",
        {
          details: {
            currentVersion: null,
            refetch: true,
          },
        }
      );
    }
    if (
      chain.some(
        (candidate) =>
          candidate?.code ===
            "REPOSITORY_CONSTRAINT" &&
          candidate?.details?.tableName ===
            "idempotency_requests"
      )
    ) {
      fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
    }
    if (
      chain.some(
        (candidate) =>
          candidate?.code ===
            "REPOSITORY_RECORD_NOT_FOUND" ||
          candidate?.code ===
            "REPOSITORY_CONSTRAINT"
      )
    ) {
      if (
        transitionType ===
        RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
      ) {
        failRollover("repository_state_changed");
      }
      failExemption("repository_state_changed");
    }
    throw error;
  }

  async function transition({
    leagueId,
    input,
    expectedDraftVersion,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId =
      validateLeagueLifecycleTransitionLeagueId(
        leagueId
      );
    const canonicalInput =
      validateLeagueLifecycleTransitionInput(input);
    const expectedVersion =
      validateLeagueLifecycleTransitionExpectedVersion(
        expectedDraftVersion,
        canonicalInput.transitionType
      );
    const clientKey =
      validateLeagueLifecycleTransitionIdempotencyKey(
        idempotencyKey
      );
    try {
      if (
        canonicalInput.transitionType ===
        INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE
      ) {
        return executeExemptionCommand({
          leagueId: canonicalLeagueId,
          input: canonicalInput,
          clientKey,
          authenticated,
          auditContext,
        });
      }
      const preparation = prepareRetry({
        leagueId: canonicalLeagueId,
        input: canonicalInput,
        expectedDraftVersion: expectedVersion,
        clientKey,
        authenticated,
        auditContext,
      });
      return await coordinateCommittedRollover(
        preparation.result ??
        runPreparedAttempt(preparation)
      );
    } catch (error) {
      return mapPublicError(
        error,
        canonicalInput.transitionType
      );
    }
  }

  async function executeScheduledEntryDraftRollover({
    leagueId,
    input,
    scheduledJob,
  } = {}) {
    const canonicalLeagueId =
      validateLeagueLifecycleTransitionLeagueId(
        leagueId
      );
    const canonicalInput =
      validateScheduledEntryDraftRolloverInput(
        input
      );
    const canonicalScheduledJob =
      inspectScheduledJob({
        value: scheduledJob,
        leagueId: canonicalLeagueId,
        input: canonicalInput,
      });
    const preparation = prepareScheduled({
      leagueId: canonicalLeagueId,
      input: canonicalInput,
      scheduledJob:
        canonicalScheduledJob,
    });
    return await coordinateCommittedRollover(
      preparation.result ??
      runPreparedAttempt(preparation)
    );
  }

  return Object.freeze({
    transition,
    executeScheduledEntryDraftRollover,
  });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  REPOSITORY_METHODS,
  SEASON_ROLLOVER_RESULT_TYPE,
  SETUP_EXEMPTION_KIND,
  SETUP_EXEMPTION_RESULT_TYPE,
  SOURCE_READINESS_ENVELOPE_KEYS,
  SOURCE_READINESS_PROJECTION_KEYS,
  SUMMARY_KEYS,
  LeagueLifecycleTransitionServiceError,
  createLeagueLifecycleTransitionService,
  safeSeasonRolloverResult,
  safeSetupExemptionResult,
};
