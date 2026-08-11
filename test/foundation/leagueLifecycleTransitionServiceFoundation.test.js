const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");

const {
  EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
  INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
  LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
  RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
} = require(
  "../../src/domain/leagues/leagueLifecycleTransitionPolicy"
);
const {
  buildSeasonRolloverOccurrenceKey,
} = require(
  "../../src/domain/leagues/seasonRolloverJobPolicy"
);
const {
  hashSeasonRolloverSourceReadiness,
  serializeSeasonRolloverSourceReadiness,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  REPOSITORY_METHODS,
  SETUP_EXEMPTION_KIND,
  SOURCE_READINESS_PROJECTION_KEYS,
  createLeagueLifecycleTransitionService,
} = require(
  "../../src/application/services/leagues/createLeagueLifecycleTransitionService"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
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

function clone(value) {
  return structuredClone(value);
}

const IDS = Object.freeze({
  league: uuid(1),
  sourceSeason: uuid(2),
  targetSeason: uuid(3),
  entryDraft: uuid(4),
  binding: uuid(5),
  occurrence: uuid(6),
  targetSchedule: uuid(7),
  weekOne: uuid(8),
  firstPick: uuid(9),
  scheduledJobRun: uuid(10),
  commissioner: uuid(11),
  commissionerMembership: uuid(12),
  commissionerSession: uuid(13),
  administrator: uuid(14),
  administratorMembership: uuid(15),
  administratorSession: uuid(16),
  sourceFad: uuid(17),
  fadReadinessOperation: uuid(18),
  finalizationRoot: uuid(19),
  finalization: uuid(20),
  standingsSnapshot: uuid(21),
  standingsOperation: uuid(22),
  migrationReport: uuid(23),
  bootstrapIdempotency: uuid(24),
  bootstrapActivity: uuid(25),
  bootstrapAudit: uuid(26),
  bootstrapActor: uuid(27),
  firstPickOwnerTeam: uuid(28),
  lateLock: uuid(29),
  carriedOwnership: uuid(30),
  releasedOwnership: uuid(31),
  releasedOwnershipTeam: uuid(32),
});

const SOURCE_PLAYOFFS_STARTS_AT_MS = Date.parse(
  "2027-03-08T08:00:00.000Z"
);
const SOURCE_ENDS_AT_MS =
  SOURCE_PLAYOFFS_STARTS_AT_MS +
  28 * 24 * 60 * 60 * 1000;
const TARGET_PLAYOFFS_STARTS_AT_MS = Date.parse(
  "2028-03-06T08:00:00.000Z"
);
const TARGET_ENDS_AT_MS =
  TARGET_PLAYOFFS_STARTS_AT_MS +
  28 * 24 * 60 * 60 * 1000;
const SCHEDULED_STARTS_AT_MS = Date.parse(
  "2027-07-15T17:00:00.000Z"
);
const WEEK_ONE_STARTS_AT_MS = Date.parse(
  "2027-10-04T07:00:00.000Z"
);
const SOURCE_FAD_COMPLETED_AT_MS = Date.parse(
  "2027-05-01T17:00:00.000Z"
);
const INITIAL_EXEMPTION_NOW_MS = Date.parse(
  "2026-09-30T17:00:00.000Z"
);
const INITIAL_WEEK_ONE_STARTS_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const EMPTY_SUMMARY = Object.freeze({
  contractsAdvanced: 0,
  contractsExpired: 0,
  ownershipsCarried: 0,
  ownershipsReleased: 0,
  retentionYearsAdvanced: 0,
  retentionObligationsCompleted: 0,
  buyoutYearsAdvanced: 0,
  buyoutObligationsCompleted: 0,
  tradesCancelled: 0,
});

const SCHEDULED_INPUT = Object.freeze({
  transitionType:
    EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  entryDraftId: IDS.entryDraft,
  rolloverOccurrenceId: IDS.occurrence,
});

const RETRY_INPUT = Object.freeze({
  transitionType:
    RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  entryDraftId: IDS.entryDraft,
  rolloverOccurrenceId: IDS.occurrence,
});

const OCCURRENCE_KEY =
  buildSeasonRolloverOccurrenceKey({
    leagueId: IDS.league,
    entryDraftId: IDS.entryDraft,
    rolloverOccurrenceId: IDS.occurrence,
    scheduledForMs: SCHEDULED_STARTS_AT_MS,
  });

const SCHEDULED_JOB = Object.freeze({
  runId: IDS.scheduledJobRun,
  occurrenceKey: OCCURRENCE_KEY,
  scheduledForMs: SCHEDULED_STARTS_AT_MS,
  leaseOwner: "foundation-worker",
  leaseToken: "lease-token-foundation",
  expectedVersion: 3,
});

const COMMISSIONER_AUTHENTICATED = Object.freeze({
  user: Object.freeze({ id: IDS.commissioner }),
  session: Object.freeze({ id: IDS.commissionerSession }),
});

const ADMIN_AUTHENTICATED = Object.freeze({
  user: Object.freeze({ id: IDS.administrator }),
  session: Object.freeze({ id: IDS.administratorSession }),
});

function bindingFixture(status = "scheduled") {
  return {
    bindingId: IDS.binding,
    leagueId: IDS.league,
    entryDraftId: IDS.entryDraft,
    rolloverOccurrenceId: IDS.occurrence,
    fromSeasonId: IDS.sourceSeason,
    toSeasonId: IDS.targetSeason,
    scheduledStartsAtMs: SCHEDULED_STARTS_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    targetScheduleId: IDS.targetSchedule,
    targetScheduleVersion: 7,
    weekOneMatchupWeekId: IDS.weekOne,
    weekOneStartsAtMs: WEEK_ONE_STARTS_AT_MS,
    status,
    selectionGateStatus:
      status === "succeeded" ? "open" : "locked",
    tradingGateStatus:
      status === "succeeded" ? "open" : "locked",
    sourceSeasonVersion: 4,
    targetSeasonVersion: 3,
    entryDraftVersion: 2,
    version: status === "scheduled" ? 1 : 2,
  };
}

function emptyRolloverMatrix() {
  return {
    violations: [],
    totals: {
      activeContractIds: [],
      liveOwnershipIds: [],
      activeRetentionIds: [],
      activeBuyoutIds: [],
      qualifyingTradeIds: [],
    },
    contractEffects: [],
    ownershipEffects: [],
    retentionEffects: [],
    buyoutEffects: [],
    tradeEffects: [],
  };
}

function ownershipReceiptFixture(
  rolloverId,
  teams = undefined
) {
  return {
    rolloverId,
    leagueId: IDS.league,
    fromSeasonId: IDS.sourceSeason,
    toSeasonId: IDS.targetSeason,
    teams:
      teams === undefined
        ? [
            {
              leagueId: IDS.league,
              seasonId: IDS.sourceSeason,
              teamId: IDS.releasedOwnershipTeam,
              ownershipWitnesses: [
                {
                  ownershipId:
                    IDS.releasedOwnership,
                  ownershipVersion: 1,
                  state: "deleted",
                },
              ],
            },
            {
              leagueId: IDS.league,
              seasonId: IDS.targetSeason,
              teamId: IDS.firstPickOwnerTeam,
              ownershipWitnesses: [
                {
                  ownershipId:
                    IDS.carriedOwnership,
                  ownershipVersion: 2,
                  state: "present",
                },
              ],
            },
            {
              leagueId: IDS.league,
              seasonId: IDS.targetSeason,
              teamId: IDS.releasedOwnershipTeam,
              ownershipWitnesses: [],
            },
          ]
        : clone(teams),
  };
}

function sourceReadinessProjection(observedAtMs) {
  const projection = Object.fromEntries(
    SOURCE_READINESS_PROJECTION_KEYS.map(
      (key) => [key, []]
    )
  );
  Object.assign(projection, {
    leagueId: IDS.league,
    fromSeasonId: IDS.sourceSeason,
    observedAtMs,
    sourceFadId: IDS.sourceFad,
    sourceFadCompletedAtMs:
      SOURCE_FAD_COMPLETED_AT_MS,
    sourceFinalizationRootId:
      IDS.finalizationRoot,
    sourceFinalizationId: IDS.finalization,
    sourceStandingsSnapshotId:
      IDS.standingsSnapshot,
    sourceStandingsOperationId:
      IDS.standingsOperation,
    recognizedSeasonOperationTables: [
      "matchup_operations",
      "standings_operations",
    ],
    freeAgentDraft: {
      id: IDS.sourceFad,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      status: "completed",
      completed_at_ms: SOURCE_FAD_COMPLETED_AT_MS,
    },
    freeAgentDraftReadinessOperation: {
      id: IDS.fadReadinessOperation,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      status: "succeeded",
    },
  });
  return projection;
}

function sourceReadinessEnvelope(observedAtMs) {
  const projection =
    sourceReadinessProjection(observedAtMs);
  return {
    schemaVersion: 1,
    projection,
    projectionJson:
      serializeSeasonRolloverSourceReadiness(
        projection
      ),
    projectionSha256:
      hashSeasonRolloverSourceReadiness(
        projection
      ),
  };
}

function rolloverContext(nowMs, state) {
  return {
    aggregate: {
      leagueId: IDS.league,
      leagueStatus: "active",
      leagueTimeZone: "America/Vancouver",
      leagueVersion: 8,
      currentSeasonId: IDS.sourceSeason,
      sourceSeasonId: IDS.sourceSeason,
      sourceSeasonStatus: "active",
      sourceSeasonVersion:
        state.binding.sourceSeasonVersion,
      sourceSeasonLabel: "2026-27",
      sourceNhlSeasonKey: "20262027",
      sourceNhlRegularSeasonStartsAtMs:
        Date.parse("2026-10-01T07:00:00.000Z"),
      sourceNhlRegularSeasonEndsAtMs:
        SOURCE_ENDS_AT_MS,
      sourceFantasyPlayoffsStartAtMs:
        SOURCE_PLAYOFFS_STARTS_AT_MS,
      sourceFantasyPlayoffsEndAtMs:
        SOURCE_ENDS_AT_MS,
      sourceFreeAgentDraftCompletedAtMs:
        SOURCE_FAD_COMPLETED_AT_MS,
      sourceRolloverCount: 0,
      targetRolloverCount: 0,
      targetIdentityCount: 1,
      targetIdentityConflict: false,
      targetSeason: {
        id: IDS.targetSeason,
        leagueId: IDS.league,
        label: "2027-28",
        nhlSeasonKey: "20272028",
        status: "planned",
        version:
          state.binding.targetSeasonVersion,
        nhlRegularSeasonStartsAtMs:
          Date.parse("2027-10-01T07:00:00.000Z"),
        nhlRegularSeasonEndsAtMs:
          TARGET_ENDS_AT_MS,
        fantasyPlayoffsStartAtMs:
          TARGET_PLAYOFFS_STARTS_AT_MS,
        fantasyPlayoffsEndAtMs:
          TARGET_ENDS_AT_MS,
        freeAgentDraftCompletedAtMs: null,
        targetScheduleId: IDS.targetSchedule,
        targetScheduleVersion: 7,
        weekOneMatchupWeekId: IDS.weekOne,
        weekOneStartsAtMs:
          WEEK_ONE_STARTS_AT_MS,
        scheduleReady: true,
        disallowedStateCount: 0,
      },
    },
    sourceReadiness:
      sourceReadinessEnvelope(nowMs),
    matrix: emptyRolloverMatrix(),
    entryDraft: {
      id: IDS.entryDraft,
      leagueId: IDS.league,
      targetSeasonId: IDS.targetSeason,
      status: state.entryDraft.status,
      version: state.entryDraft.version,
      startsAtMs: SCHEDULED_STARTS_AT_MS,
      pickClockSeconds: 300,
      selectionGateStatus:
        state.entryDraft.selectionGateStatus,
      tradingGateStatus:
        state.entryDraft.tradingGateStatus,
      scheduleAuthorizingUserId:
        IDS.commissioner,
      scheduleAuthorizingMembershipId:
        IDS.commissionerMembership,
      scheduleAuthorizingAuthority:
        "commissioner",
      targetScheduleId: IDS.targetSchedule,
      targetScheduleVersion: 7,
      weekOneMatchupWeekId: IDS.weekOne,
      weekOneStartsAtMs:
        WEEK_ONE_STARTS_AT_MS,
      firstUnusedPick: {
        id: IDS.firstPick,
        owningTeamId:
          IDS.firstPickOwnerTeam,
        roundNumber: 1,
        positionNumber: 1,
        version: 1,
        status: "unused",
      },
    },
  };
}

function initialExemptionContext() {
  return {
    aggregate: {
      leagueId: IDS.league,
      leagueStatus: "active",
      currentSeasonId: IDS.sourceSeason,
      seasonCount: 1,
      seasonId: IDS.sourceSeason,
      seasonStatus: "active",
      seasonLabel: "2026",
      nhlSeasonKey: "20262027",
      entryDraftCount: 0,
      fadCount: 0,
      exemptionCount: 0,
      fadSetupCount: 0,
      weekOneCount: 1,
      weekOneStartsAtMs:
        INITIAL_WEEK_ONE_STARTS_AT_MS,
      commissionerMembershipCount: 1,
      commissionerMembershipId:
        IDS.commissionerMembership,
      commissionerUserId: IDS.commissioner,
      commissionerPermissionCategory:
        "commissioner",
      commissionerMembershipStatus: "active",
      commissionerJoinedAtMs:
        INITIAL_EXEMPTION_NOW_MS - 1,
      commissionerEndedAtMs: null,
      commissionerUserStatus: "active",
      commissionerNotificationEligible: true,
    },
    migrationReports: [
      {
        id: IDS.migrationReport,
        leagueId: IDS.league,
        sourceBundleId: "season-1-import.json",
        resetManifestId:
          "2026-season-1-reset-v1",
        databaseSchemaVersion: 30,
        status: "succeeded",
        startedAtMs: Date.parse(
          "2026-07-01T00:00:00.000Z"
        ),
        completedAtMs: Date.parse(
          "2026-07-01T00:05:00.000Z"
        ),
        createdAtMs: Date.parse(
          "2026-07-01T00:01:00.000Z"
        ),
        projectionSha256: DIGEST_A,
        shapeValid: true,
      },
    ],
    bootstrap: {
      valid: true,
      projectionSha256: DIGEST_B,
      idempotencyRequestId:
        IDS.bootstrapIdempotency,
      activityId: IDS.bootstrapActivity,
      securityAuditEventId:
        IDS.bootstrapAudit,
      actorUserId: IDS.bootstrapActor,
    },
  };
}

function canonicalBlockers() {
  return [
    {
      code: "FAD_READINESS_MISSING",
      field: "status",
      resourceType: "free_agent_draft",
      resourceId: IDS.sourceFad,
      message:
        "The completed source FAD readiness evidence is missing.",
    },
    {
      code: "WEEK_ONE_RECOVERY_PENDING",
      field: null,
      resourceType: "matchup_week",
      resourceId: IDS.weekOne,
      message:
        "The persisted Week 1 recovery is not terminal.",
    },
  ];
}

function notReadyError() {
  const error = new Error(
    "canonical rollover prerequisites are not ready"
  );
  error.code = "SEASON_ROLLOVER_NOT_READY";
  error.details = {
    blockers: [...canonicalBlockers()].reverse(),
  };
  return error;
}

function callNames(calls) {
  return calls.map(({ name }) => name);
}

function freshReadinessHandoff(input) {
  return {
    replayed: false,
    readiness: {
      id: input.operationId,
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      occurrenceKey: [
        "fad-readiness",
        input.leagueId,
        input.seasonId,
        input.triggerResourceId,
      ].join(":"),
      triggerKind: input.triggerKind,
      entryDraftId: input.entryDraftId,
      setupExemptionId: input.setupExemptionId,
      jobRunId: input.jobRunId,
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
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
      version: 1,
    },
  };
}

function createHarness({
  nowMs = SCHEDULED_STARTS_AT_MS,
  bindingStatus = "scheduled",
  readinessFailure = false,
  technicalCommitFailure = false,
  lateLockFailure = false,
  lateLockResult = {
    status: "completed",
    lockId: IDS.lateLock,
  },
  ownershipReceiptFailure = false,
  ownershipTeams = undefined,
  invalidReadinessHandoffResult = false,
  readinessHandoffError = null,
} = {}) {
  let state = {
    binding: bindingFixture(bindingStatus),
    entryDraft: {
      status:
        bindingStatus === "succeeded"
          ? "active"
          : "ready",
      version:
        bindingStatus === "succeeded" ? 3 : 2,
      selectionGateStatus:
        bindingStatus === "succeeded"
          ? "open"
          : "locked",
      tradingGateStatus:
        bindingStatus === "succeeded"
          ? "open"
          : "locked",
    },
    attempts: [],
    receipts: {},
    ownershipReceipts: {},
    idempotencyRequests: [],
    exemptionResult: null,
    readinessPairs: [],
    effectsApplied: false,
  };
  const behavior = {
    nowMs,
    readinessFailure,
    technicalCommitFailure,
    lateLockFailure,
    lateLockResult,
    ownershipReceiptFailure,
    ownershipTeams,
    invalidReadinessHandoffResult,
    readinessHandoffError,
    forbidMutableChecks: false,
    exemptionAuthorityActive: true,
  };
  const calls = [];
  const preCommitStates = [];
  let secureIdSequence = 500;

  function record(name, value = null) {
    calls.push({
      name,
      value:
        value === null ? null : clone(value),
    });
  }

  function latestAttemptForOccurrence() {
    return (
      [...state.attempts]
        .filter(
          (attempt) =>
            attempt.rolloverOccurrenceId ===
            IDS.occurrence
        )
        .sort(
          (left, right) =>
            right.attemptNumber -
            left.attemptNumber
        )[0] ?? null
    );
  }

  function receiptFromPlan(plan) {
    const source = plan.sourceReadiness.projection;
    return {
      rolloverId: plan.rolloverId,
      rolloverAttemptId: plan.attemptId,
      leagueId: plan.leagueId,
      fromSeasonId: plan.source.id,
      toSeasonId: plan.target.id,
      fromSeasonStatus: "completed",
      toSeasonStatus: "active",
      targetNhlSeasonKey:
        plan.target.nhlSeasonKey,
      nhlRegularSeasonStartsAtMs:
        plan.target.nhlRegularSeasonStartsAtMs,
      nhlRegularSeasonEndsAtMs:
        plan.target.nhlRegularSeasonEndsAtMs,
      fantasyPlayoffsStartAtMs:
        plan.target.fantasyPlayoffsStartAtMs,
      fantasyPlayoffsEndAtMs:
        plan.target.fantasyPlayoffsEndAtMs,
      sourceFadId: source.sourceFadId,
      sourceFinalizationRootId:
        source.sourceFinalizationRootId,
      sourceFinalizationId:
        source.sourceFinalizationId,
      sourceStandingsSnapshotId:
        source.sourceStandingsSnapshotId,
      sourceStandingsOperationId:
        source.sourceStandingsOperationId,
      sourceReadinessSchemaVersion:
        plan.sourceReadiness.schemaVersion,
      sourceReadinessSha256:
        plan.sourceReadiness.projectionSha256,
      entryDraftId: plan.entryDraft.id,
      entryDraftRolloverBindingId:
        plan.bindingId,
      rolloverOccurrenceId:
        plan.rolloverOccurrenceId,
      scheduledStartsAtMs:
        plan.scheduledStartsAtMs,
      occurrenceKey: plan.occurrenceKey,
      targetScheduleId: plan.targetSchedule.id,
      targetScheduleVersion:
        plan.targetSchedule.version,
      weekOneMatchupWeekId:
        plan.targetSchedule.weekOneMatchupWeekId,
      weekOneStartsAtMs:
        plan.targetSchedule.weekOneStartsAtMs,
      trigger: plan.triggerKind,
      leagueVersion: plan.leagueVersionAfter,
      fromSeasonVersion: plan.source.versionAfter,
      toSeasonVersion: plan.target.versionAfter,
      entryDraftVersion:
        plan.entryDraft.versionAfter,
      firstPickClockId: plan.firstPickClock.id,
      completedAtMs: plan.completedAtMs,
      retryAuthorizedByUserId:
        plan.triggerKind === "commissioner_retry"
          ? plan.authorizedByUserId
          : null,
      retryAuthorizedAuthority:
        plan.triggerKind === "commissioner_retry"
          ? plan.authorizedAuthority
          : null,
      summary: clone(plan.summary),
      version: 1,
    };
  }

  const repositoryContext = {
    transaction(callback) {
      record("transaction.begin");
      const snapshot = clone(state);
      try {
        const result = callback();
        record("transaction.commit");
        return result;
      } catch (error) {
        state = snapshot;
        record("transaction.rollback");
        throw error;
      }
    },
  };

  const repository = {
    findIdempotencyRequest(query) {
      record("findIdempotencyRequest", query);
      assert.deepEqual(
        Object.keys(query).sort(),
        ["clientKey", "leagueId", "operation"]
      );
      return (
        clone(
          state.idempotencyRequests.find(
            (row) =>
              row.leagueId === query.leagueId &&
              row.operation === query.operation &&
              row.clientKey === query.clientKey
          ) ?? null
        )
      );
    },

    findDurableSeasonRolloverAttempt(query) {
      record(
        "findDurableSeasonRolloverAttempt",
        query
      );
      return clone(
        state.attempts.find(
          (attempt) =>
            attempt.attemptId === query.attemptId &&
            attempt.leagueId === query.leagueId
        ) ?? null
      );
    },

    findDurableSeasonRolloverResult(query) {
      record(
        "findDurableSeasonRolloverResult",
        query
      );
      return clone(
        state.receipts[query.rolloverId] ?? null
      );
    },

    findDurableSeasonRolloverOwnershipReceipt(
      query
    ) {
      record(
        "findDurableSeasonRolloverOwnershipReceipt",
        query
      );
      if (behavior.ownershipReceiptFailure) {
        throw new Error(
          "simulated ownership-receipt failure"
        );
      }
      return clone(
        state.ownershipReceipts[
          query.rolloverId
        ] ?? null
      );
    },

    findDurableSetupExemptionResult(query) {
      record(
        "findDurableSetupExemptionResult",
        query
      );
      if (
        state.exemptionResult?.exemptionId !==
        query.exemptionId
      ) {
        return null;
      }
      return clone(state.exemptionResult);
    },

    findRolloverBindingByOccurrence(query) {
      record(
        "findRolloverBindingByOccurrence",
        query
      );
      if (behavior.forbidMutableChecks) {
        throw new Error(
          "mutable rollover binding must not be read"
        );
      }
      if (
        query.leagueId !== IDS.league ||
        query.entryDraftId !== IDS.entryDraft ||
        query.rolloverOccurrenceId !==
          IDS.occurrence
      ) {
        return null;
      }
      return clone(state.binding);
    },

    findSeasonRolloverAttemptByIdempotencyRequest(
      query
    ) {
      record(
        "findSeasonRolloverAttemptByIdempotencyRequest",
        query
      );
      return clone(
        state.attempts.find(
          (attempt) =>
            attempt.retryIdempotencyRequestId ===
            query.idempotencyRequestId
        ) ?? null
      );
    },

    findLatestSeasonRolloverAttempt(query) {
      record(
        "findLatestSeasonRolloverAttempt",
        query
      );
      assert.equal(query.bindingId, IDS.binding);
      assert.equal(
        query.rolloverOccurrenceId,
        IDS.occurrence
      );
      return clone(latestAttemptForOccurrence());
    },

    validateScheduledRolloverJobLease(command) {
      record(
        "validateScheduledRolloverJobLease",
        command
      );
      if (behavior.forbidMutableChecks) {
        throw new Error(
          "scheduled lease must not be revalidated"
        );
      }
      assert.equal(command.bindingId, IDS.binding);
      assert.equal(
        command.rolloverOccurrenceId,
        IDS.occurrence
      );
      assert.deepEqual(
        command.scheduledJob,
        SCHEDULED_JOB
      );
      return { valid: true };
    },

    beginSeasonRolloverAttempt(command) {
      record("beginSeasonRolloverAttempt", command);
      assert.equal(
        command.expectedBindingVersion,
        state.binding.version
      );
      assert.equal(
        command.targetScheduleId,
        IDS.targetSchedule
      );
      assert.equal(command.targetScheduleVersion, 7);
      assert.equal(
        command.weekOneMatchupWeekId,
        IDS.weekOne
      );
      assert.equal(
        command.weekOneStartsAtMs,
        WEEK_ONE_STARTS_AT_MS
      );
      const prior = latestAttemptForOccurrence();
      assert.equal(
        command.expectedPriorAttemptId,
        prior?.attemptId ?? null
      );
      assert.equal(
        command.expectedPriorAttemptNumber,
        prior?.attemptNumber ?? 0
      );
      const scheduled =
        command.triggerKind === "scheduled_job";
      assert.deepEqual(
        command.scheduledJob,
        scheduled ? SCHEDULED_JOB : null
      );
      assert.equal(
        command.retryActorUserId,
        scheduled ? null : IDS.commissioner
      );
      assert.equal(
        command.retryActorMembershipId,
        scheduled
          ? null
          : IDS.commissionerMembership
      );
      assert.equal(
        command.retryAuthority,
        scheduled ? null : "commissioner"
      );
      const attempt = {
        attemptId: command.attemptId,
        bindingId: IDS.binding,
        leagueId: IDS.league,
        entryDraftId: IDS.entryDraft,
        rolloverOccurrenceId: IDS.occurrence,
        fromSeasonId: IDS.sourceSeason,
        toSeasonId: IDS.targetSeason,
        attemptNumber:
          command.expectedPriorAttemptNumber + 1,
        triggerKind: command.triggerKind,
        scheduledJobRunId: scheduled
          ? IDS.scheduledJobRun
          : null,
        retryIdempotencyRequestId:
          command.retryIdempotencyRequestId,
        retryActorUserId:
          command.retryActorUserId,
        retryActorMembershipId:
          command.retryActorMembershipId,
        retryAuthority: command.retryAuthority,
        status: "started",
        blockers: [],
        rolloverId: null,
        startedAtMs: command.startedAtMs,
        terminalAtMs: null,
        observedSourceSeasonVersion:
          command.observedSourceSeasonVersion,
        observedTargetSeasonVersion:
          command.observedTargetSeasonVersion,
        observedEntryDraftVersion:
          command.observedEntryDraftVersion,
        targetScheduleId: IDS.targetSchedule,
        targetScheduleVersion: 7,
        weekOneMatchupWeekId: IDS.weekOne,
        weekOneStartsAtMs:
          WEEK_ONE_STARTS_AT_MS,
        version: 1,
      };
      state.attempts.push(attempt);
      return clone(attempt);
    },

    readSeasonRolloverContext(command) {
      record("readSeasonRolloverContext", command);
      if (behavior.forbidMutableChecks) {
        throw new Error(
          "rollover context must not be recomputed"
        );
      }
      assert.equal(command.bindingId, IDS.binding);
      assert.equal(
        command.targetScheduleId,
        IDS.targetSchedule
      );
      if (behavior.readinessFailure) {
        throw notReadyError();
      }
      return rolloverContext(
        command.observedAtMs,
        state
      );
    },

    blockSeasonRolloverAttempt(command) {
      record(
        "blockSeasonRolloverAttempt",
        command
      );
      assert.equal(state.entryDraft.status, "ready");
      assert.equal(
        state.binding.selectionGateStatus,
        "locked"
      );
      assert.equal(
        state.binding.tradingGateStatus,
        "locked"
      );
      assert.deepEqual(
        command.blockers,
        canonicalBlockers()
      );
      const attempt = state.attempts.find(
        (row) => row.attemptId === command.attemptId
      );
      assert.equal(attempt.status, "started");
      attempt.status = "blocked";
      attempt.blockers = clone(command.blockers);
      attempt.terminalAtMs = command.blockedAtMs;
      state.binding.status = "blocked";
      state.binding.version += 1;
      return clone(attempt);
    },

    commitSeasonRolloverAndOpenDraft(command) {
      record(
        "commitSeasonRolloverAndOpenDraft",
        command
      );
      const { plan, scheduledJob } = command;
      preCommitStates.push({
        bindingStatus: state.binding.status,
        bindingSelectionGate:
          state.binding.selectionGateStatus,
        bindingTradingGate:
          state.binding.tradingGateStatus,
        entryDraftStatus: state.entryDraft.status,
        entryDraftSelectionGate:
          state.entryDraft.selectionGateStatus,
        entryDraftTradingGate:
          state.entryDraft.tradingGateStatus,
      });
      assert.notEqual(
        plan.bindingId,
        plan.rolloverOccurrenceId
      );
      assert.equal(plan.target.created, false);
      assert.equal(
        plan.target.id,
        IDS.targetSeason
      );
      assert.deepEqual(plan.targetSchedule, {
        id: IDS.targetSchedule,
        version: 7,
        weekOneMatchupWeekId: IDS.weekOne,
        weekOneStartsAtMs:
          WEEK_ONE_STARTS_AT_MS,
      });
      assert.deepEqual(
        {
          statusBefore:
            plan.entryDraft.statusBefore,
          statusAfter: plan.entryDraft.statusAfter,
          selectionGateStatusBefore:
            plan.entryDraft
              .selectionGateStatusBefore,
          selectionGateStatusAfter:
            plan.entryDraft
              .selectionGateStatusAfter,
          tradingGateStatusBefore:
            plan.entryDraft.tradingGateStatusBefore,
          tradingGateStatusAfter:
            plan.entryDraft.tradingGateStatusAfter,
        },
        {
          statusBefore: "ready",
          statusAfter: "active",
          selectionGateStatusBefore: "locked",
          selectionGateStatusAfter: "open",
          tradingGateStatusBefore: "locked",
          tradingGateStatusAfter: "open",
        }
      );
      assert.equal(
        plan.firstPickClock.fullClockSeconds,
        300
      );
      assert.equal(
        plan.firstPickClock.owningTeamId,
        IDS.firstPickOwnerTeam
      );
      assert.equal(
        plan.firstPickClock.expiresAtMs -
          plan.firstPickClock.startsAtMs,
        300_000
      );
      assert.deepEqual(plan.summary, EMPTY_SUMMARY);
      if (plan.triggerKind === "scheduled_job") {
        assert.deepEqual(scheduledJob, SCHEDULED_JOB);
        assert.equal(plan.authorizedByUserId, null);
        assert.equal(
          plan.authorizedByMembershipId,
          null
        );
        assert.equal(
          plan.authorizedAuthority,
          "system"
        );
        assert.equal(plan.idempotencyRequestId, null);
      } else {
        assert.equal(scheduledJob, null);
        assert.equal(
          plan.rolloverOccurrenceId,
          IDS.occurrence
        );
        assert.equal(
          plan.authorizedByUserId,
          IDS.commissioner
        );
      }
      const attempt = state.attempts.find(
        (row) => row.attemptId === plan.attemptId
      );
      assert.equal(attempt.status, "started");
      if (behavior.technicalCommitFailure) {
        state.binding.status = "succeeded";
        state.binding.selectionGateStatus = "open";
        state.binding.tradingGateStatus = "open";
        state.entryDraft.status = "active";
        state.effectsApplied = true;
        const error = new Error(
          "simulated durable write failure"
        );
        error.code = "SQLITE_IOERR";
        throw error;
      }
      state.binding.status = "succeeded";
      state.binding.selectionGateStatus = "open";
      state.binding.tradingGateStatus = "open";
      state.binding.version =
        plan.bindingVersionAfter;
      state.entryDraft.status = "active";
      state.entryDraft.version =
        plan.entryDraft.versionAfter;
      state.entryDraft.selectionGateStatus = "open";
      state.entryDraft.tradingGateStatus = "open";
      state.effectsApplied = true;
      attempt.status = "succeeded";
      attempt.rolloverId = plan.rolloverId;
      attempt.terminalAtMs = plan.completedAtMs;
      const receipt = receiptFromPlan(plan);
      state.receipts[plan.rolloverId] = receipt;
      state.ownershipReceipts[plan.rolloverId] =
        ownershipReceiptFixture(
          plan.rolloverId,
          behavior.ownershipTeams
        );
      return clone(receipt);
    },

    readInitialSeason2ExemptionContext(query) {
      record(
        "readInitialSeason2ExemptionContext",
        query
      );
      assert.deepEqual(query, {
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        observedAtMs: INITIAL_EXEMPTION_NOW_MS,
      });
      return initialExemptionContext();
    },

    verifyInitialSeason2Evidence(command) {
      record("verifyInitialSeason2Evidence", command);
      return {
        migrationReportSha256: DIGEST_A,
        bootstrapIdentitySha256: DIGEST_B,
      };
    },

    insertStartedIdempotencyRequest(command) {
      record(
        "insertStartedIdempotencyRequest",
        command
      );
      assert.equal(
        state.idempotencyRequests.some(
          (row) =>
            row.clientKey === command.clientKey
        ),
        false
      );
      state.idempotencyRequests.push({
        ...clone(command),
        status: "started",
        resultType: null,
        resultId: null,
        completedAtMs: null,
      });
    },

    appendSetupExemptionEvidence(command) {
      record(
        "appendSetupExemptionEvidence",
        command
      );
    },

    insertSetupExemption({ plan }) {
      record("insertSetupExemption", { plan });
      state.exemptionResult = {
        exemptionId: plan.exemptionId,
        leagueId: plan.leagueId,
        seasonId: plan.seasonId,
        exemptionKind: SETUP_EXEMPTION_KIND,
        reason: plan.reason,
        authorizedByUserId:
          plan.authorizedByUserId,
        authorizedAuthority:
          plan.authorizedAuthority,
        authorizedAtMs: plan.authorizedAtMs,
        consumed: false,
        migrationReportId:
          plan.migrationReportId,
        version: 1,
      };
    },

    verifySetupExemptionEvidence({ plan }) {
      record("verifySetupExemptionEvidence", {
        plan,
      });
      return {
        migrationReportSha256:
          plan.migrationReportSha256,
        bootstrapIdentitySha256:
          plan.bootstrapIdentitySha256,
      };
    },

    completeIdempotencyRequest(command) {
      record("completeIdempotencyRequest", command);
      const row = state.idempotencyRequests.find(
        (candidate) => candidate.id === command.id
      );
      assert.ok(row);
      assert.equal(row.status, "started");
      row.status = "completed";
      row.resultType = command.resultType;
      row.resultId = command.resultId;
      row.completedAtMs = command.completedAtMs;
    },
  };

  const clock = {
    nowMs() {
      record("clock.nowMs");
      if (behavior.forbidMutableChecks) {
        throw new Error(
          "clock must not be consulted on replay"
        );
      }
      return behavior.nowMs;
    },
  };

  const secureRandom = {
    id() {
      record("secureRandom.id");
      if (behavior.forbidMutableChecks) {
        throw new Error(
          "secure ID must not be generated on replay"
        );
      }
      secureIdSequence += 1;
      return uuid(secureIdSequence);
    },
  };

  const freeAgentDraftReadinessHandoffWriter = {
    write(command) {
      record(
        "freeAgentDraftReadinessHandoffWriter.write",
        command
      );
      assert.deepEqual(command, {
        operationId: uuid(507),
        jobRunId: uuid(508),
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        triggerKind:
          "no_draft_initial_season2",
        triggerResourceId: uuid(501),
        entryDraftId: null,
        setupExemptionId: uuid(501),
        createdAtMs: INITIAL_EXEMPTION_NOW_MS,
      });
      assert.equal(
        state.exemptionResult?.exemptionId,
        command.setupExemptionId
      );
      assert.equal(
        state.idempotencyRequests[0]?.status,
        "started"
      );
      const names = callNames(calls);
      assert.ok(
        names.lastIndexOf(
          "verifySetupExemptionEvidence"
        ) <
          names.lastIndexOf(
            "freeAgentDraftReadinessHandoffWriter.write"
          )
      );
      assert.equal(
        names.includes(
          "completeIdempotencyRequest"
        ),
        false
      );
      const result = freshReadinessHandoff(
        command
      );
      state.readinessPairs.push({
        readiness: clone(result.readiness),
        job: {
          id: command.jobRunId,
          occurrenceKey:
            result.readiness.occurrenceKey,
          status: "pending",
          scheduledForMs: command.createdAtMs,
        },
      });
      if (behavior.readinessHandoffError) {
        throw behavior.readinessHandoffError;
      }
      if (
        behavior.invalidReadinessHandoffResult
      ) {
        return {
          ...result,
          readiness: {
            ...result.readiness,
            status: "running",
          },
        };
      }
      return result;
    },
  };

  const leagueAuthorization = {
    requireActiveMembership(
      authenticated,
      leagueId
    ) {
      assert.equal(leagueId, IDS.league);
      assert.equal(
        authenticated,
        ADMIN_AUTHENTICATED
      );
      if (!behavior.exemptionAuthorityActive) {
        const error = new Error(
          "current exemption authority is required"
        );
        error.code =
          "PLATFORM_ADMINISTRATOR_REQUIRED";
        throw error;
      }
      return {
        actorUserId: IDS.administrator,
        membershipId:
          IDS.administratorMembership,
      };
    },
    requireCommissioner(
      authenticated,
      leagueId
    ) {
      assert.equal(leagueId, IDS.league);
      assert.equal(
        authenticated,
        COMMISSIONER_AUTHENTICATED
      );
      return {
        actorUserId: IDS.commissioner,
        membershipId:
          IDS.commissionerMembership,
        authority: "commissioner",
      };
    },
  };

  const platformAuthorization = {
    requireAdministrator(authenticated) {
      assert.equal(
        authenticated,
        ADMIN_AUTHENTICATED
      );
      if (!behavior.exemptionAuthorityActive) {
        const error = new Error(
          "current exemption authority is required"
        );
        error.code =
          "PLATFORM_ADMINISTRATOR_REQUIRED";
        throw error;
      }
      return {
        actorUserId: IDS.administrator,
      };
    },
  };

  const lateLockCoordinator = {
    async coordinateCommittedRoster(batch) {
      record("coordinateCommittedRoster", batch);
      assert.equal(state.binding.status, "succeeded");
      assert.equal(state.entryDraft.status, "active");
      if (behavior.lateLockFailure) {
        throw new Error(
          "simulated late-lock coordinator failure"
        );
      }
      return clone(behavior.lateLockResult);
    },
  };

  const service =
    createLeagueLifecycleTransitionService({
      repositoryContext,
      leagueAuthorization,
      platformAuthorization,
      leagueLifecycleTransitionRepository:
        repository,
      freeAgentDraftReadinessHandoffWriter,
      lateLockCoordinator,
      clock,
      secureRandom,
    });

  return {
    behavior,
    calls,
    preCommitStates,
    service,
    state: () => clone(state),
  };
}

function executeScheduled(service) {
  return service.executeScheduledEntryDraftRollover({
    leagueId: IDS.league,
    input: SCHEDULED_INPUT,
    scheduledJob: SCHEDULED_JOB,
  });
}

function retryRollover(
  service,
  idempotencyKey = "retry-occurrence-once"
) {
  return service.transition({
    leagueId: IDS.league,
    input: RETRY_INPUT,
    expectedDraftVersion: 2,
    idempotencyKey,
    authenticated: COMMISSIONER_AUTHENTICATED,
  });
}

function authorizeInitialSeason2Exemption(
  service,
  idempotencyKey =
    "initial-season-2-exemption"
) {
  return service.transition({
    leagueId: IDS.league,
    input: {
      transitionType:
        INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
      seasonId: IDS.sourceSeason,
      reason:
        "Approved one-time imported Season 2 transition.",
      confirmation:
        INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
    },
    expectedDraftVersion: null,
    idempotencyKey,
    authenticated: ADMIN_AUTHENTICATED,
  });
}

async function assertServiceError(
  callback,
  code,
  reasonCode = undefined
) {
  await assert.rejects(callback, (error) => {
    assert.equal(error.code, code);
    if (reasonCode !== undefined) {
      assert.equal(error.reasonCode, reasonCode);
    }
    return true;
  });
}

describe(
  "league lifecycle transition service foundation",
  () => {
    test("declares the provisional locked repository surface", () => {
      assert.deepEqual(REPOSITORY_METHODS, [
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
      assert.equal(
        REPOSITORY_METHODS.length,
        20
      );
    });

    test("executes a due scheduled occurrence and opens both gates only in the atomic success commit", async () => {
      const harness = createHarness();

      const result = await executeScheduled(
        harness.service
      );
      const state = harness.state();

      assert.equal(result.status, "succeeded");
      assert.equal(result.triggerKind, "scheduled_job");
      assert.equal(result.attemptNumber, 1);
      assert.equal(result.bindingId, IDS.binding);
      assert.equal(
        result.rolloverOccurrenceId,
        IDS.occurrence
      );
      assert.equal(
        result.weekOneMatchupWeekId,
        IDS.weekOne
      );
      assert.equal(result.replayed, false);
      assert.deepEqual(result.lateLock, {
        status: "completed",
        lockId: IDS.lateLock,
      });
      assert.deepEqual(harness.preCommitStates, [
        {
          bindingStatus: "scheduled",
          bindingSelectionGate: "locked",
          bindingTradingGate: "locked",
          entryDraftStatus: "ready",
          entryDraftSelectionGate: "locked",
          entryDraftTradingGate: "locked",
        },
      ]);
      assert.equal(state.binding.status, "succeeded");
      assert.equal(
        state.binding.selectionGateStatus,
        "open"
      );
      assert.equal(
        state.binding.tradingGateStatus,
        "open"
      );
      assert.equal(state.entryDraft.status, "active");
      assert.equal(
        state.entryDraft.selectionGateStatus,
        "open"
      );
      assert.equal(
        state.entryDraft.tradingGateStatus,
        "open"
      );
      assert.equal(state.effectsApplied, true);
      assert.equal(
        callNames(harness.calls).includes(
          "insertStartedIdempotencyRequest"
        ),
        false
      );
      assert.equal(
        callNames(harness.calls).includes(
          "freeAgentDraftReadinessHandoffWriter.write"
        ),
        false
      );
      assert.deepEqual(state.readinessPairs, []);
      const names = callNames(harness.calls);
      const transactionCommitIndex =
        names.lastIndexOf("transaction.commit");
      const receiptIndex = names.lastIndexOf(
        "findDurableSeasonRolloverOwnershipReceipt"
      );
      const coordinatorIndex = names.lastIndexOf(
        "coordinateCommittedRoster"
      );
      assert.ok(receiptIndex > transactionCommitIndex);
      assert.ok(coordinatorIndex > receiptIndex);
      assert.deepEqual(
        harness.calls[coordinatorIndex].value,
        {
          mutationKind: "contract_rollover",
          teams: ownershipReceiptFixture(
            result.rolloverId
          ).teams,
        }
      );
    });

    test("replays an already-succeeded exact occurrence without lease, clock, context, write, or ID work", async () => {
      const harness = createHarness();
      const first = await executeScheduled(
        harness.service
      );
      const boundary = harness.calls.length;

      const replay = await executeScheduled(
        harness.service
      );
      const replayCalls = callNames(
        harness.calls.slice(boundary)
      );

      assert.deepEqual(replay, first);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replayCalls, [
        "transaction.begin",
        "findRolloverBindingByOccurrence",
        "findLatestSeasonRolloverAttempt",
        "findDurableSeasonRolloverResult",
        "transaction.commit",
        "findDurableSeasonRolloverOwnershipReceipt",
        "coordinateCommittedRoster",
      ]);
      assert.equal(
        callNames(harness.calls).filter(
          (name) =>
            name === "coordinateCommittedRoster"
        ).length,
        2
      );
    });

    test("coordinates a durable successful commissioner idempotency replay exactly once without mutable rollover work", async () => {
      const harness = createHarness({
        readinessFailure: true,
      });
      await executeScheduled(harness.service);
      harness.behavior.readinessFailure = false;
      const first = await retryRollover(
        harness.service,
        "successful-retry-replay"
      );
      const boundary = harness.calls.length;
      harness.behavior.forbidMutableChecks = true;

      const replay = await retryRollover(
        harness.service,
        "successful-retry-replay"
      );
      const replayCalls = callNames(
        harness.calls.slice(boundary)
      );

      assert.deepEqual(replay, first);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replayCalls, [
        "transaction.begin",
        "findIdempotencyRequest",
        "findDurableSeasonRolloverResult",
        "findDurableSeasonRolloverAttempt",
        "transaction.commit",
        "findDurableSeasonRolloverOwnershipReceipt",
        "coordinateCommittedRoster",
      ]);
    });

    test("keeps a committed rollover successful when late-lock coordination fails or returns an unsafe projection", async () => {
      for (const options of [
        { lateLockFailure: true },
        {
          lateLockResult: {
            status: "completed",
            lockId: IDS.lateLock,
            internal: "must-not-leak",
          },
        },
        { ownershipReceiptFailure: true },
      ]) {
        const harness = createHarness(options);
        const result = await executeScheduled(
          harness.service
        );

        assert.equal(result.status, "succeeded");
        assert.deepEqual(result.lateLock, {
          status: "awaiting_data",
        });
        assert.deepEqual(
          Object.keys(result.lateLock),
          ["status"]
        );
        assert.equal(
          harness.state().binding.status,
          "succeeded"
        );
      }
    });

    test("returns not-applicable without invoking the coordinator when a durable rollover receipt has no team scopes", async () => {
      const harness = createHarness({
        ownershipTeams: [],
      });

      const result = await executeScheduled(
        harness.service
      );

      assert.deepEqual(result.lateLock, {
        status: "not_applicable",
      });
      assert.equal(
        callNames(harness.calls).includes(
          "coordinateCommittedRoster"
        ),
        false
      );
    });

    test("persists exact canonical blockers while the base draft remains ready and both gates stay locked", async () => {
      const harness = createHarness({
        readinessFailure: true,
      });

      const result = await executeScheduled(
        harness.service
      );
      const state = harness.state();

      assert.equal(result.status, "blocked");
      assert.deepEqual(
        result.blockers,
        canonicalBlockers()
      );
      assert.equal(state.binding.status, "blocked");
      assert.equal(state.entryDraft.status, "ready");
      assert.equal(
        state.binding.selectionGateStatus,
        "locked"
      );
      assert.equal(
        state.binding.tradingGateStatus,
        "locked"
      );
      assert.equal(
        state.entryDraft.selectionGateStatus,
        "locked"
      );
      assert.equal(
        state.entryDraft.tradingGateStatus,
        "locked"
      );
      assert.equal(state.effectsApplied, false);
      assert.equal(
        callNames(harness.calls).filter(
          (name) =>
            name ===
            "blockSeasonRolloverAttempt"
        ).length,
        1
      );
      assert.equal(
        callNames(harness.calls).includes(
          "commitSeasonRolloverAndOpenDraft"
        ),
        false
      );
      assert.equal(
        callNames(harness.calls).includes(
          "coordinateCommittedRoster"
        ),
        false
      );
      assert.equal(
        Object.hasOwn(result, "lateLock"),
        false
      );
    });

    test("retries only the same blocked occurrence and completes idempotency after atomic success", async () => {
      const harness = createHarness({
        readinessFailure: true,
      });
      await executeScheduled(harness.service);
      harness.behavior.readinessFailure = false;
      const callBoundary = harness.calls.length;

      const result = await retryRollover(
        harness.service
      );
      const retryCalls =
        harness.calls.slice(callBoundary);
      const state = harness.state();
      const idempotency =
        state.idempotencyRequests[0];

      assert.equal(result.status, "succeeded");
      assert.equal(
        result.triggerKind,
        "commissioner_retry"
      );
      assert.equal(result.attemptNumber, 2);
      assert.equal(
        result.rolloverOccurrenceId,
        IDS.occurrence
      );
      assert.equal(
        result.targetScheduleId,
        IDS.targetSchedule
      );
      assert.equal(
        result.weekOneMatchupWeekId,
        IDS.weekOne
      );
      assert.equal(idempotency.status, "completed");
      assert.equal(
        idempotency.resultType,
        "season_rollover"
      );
      assert.equal(
        idempotency.resultId,
        result.rolloverId
      );
      const commitIndex = callNames(retryCalls).indexOf(
        "commitSeasonRolloverAndOpenDraft"
      );
      const completeIndex =
        callNames(retryCalls).lastIndexOf(
          "completeIdempotencyRequest"
        );
      assert.ok(commitIndex >= 0);
      assert.ok(completeIndex > commitIndex);
      const transactionCommitIndex = callNames(
        retryCalls
      ).lastIndexOf("transaction.commit");
      const coordinatorIndex = callNames(
        retryCalls
      ).lastIndexOf(
        "coordinateCommittedRoster"
      );
      assert.ok(
        coordinatorIndex > transactionCommitIndex
      );
    });

    test("replays a completed blocked retry before binding, clock, context, lease, or ID checks", async () => {
      const harness = createHarness({
        readinessFailure: true,
      });
      await executeScheduled(harness.service);
      const first = await retryRollover(
        harness.service,
        "blocked-retry-replay"
      );
      assert.equal(first.status, "blocked");
      const boundary = harness.calls.length;
      harness.behavior.forbidMutableChecks = true;

      const replay = await retryRollover(
        harness.service,
        "blocked-retry-replay"
      );
      const replayCalls = callNames(
        harness.calls.slice(boundary)
      );

      assert.deepEqual(replay, first);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replayCalls, [
        "transaction.begin",
        "findIdempotencyRequest",
        "findDurableSeasonRolloverAttempt",
        "transaction.commit",
      ]);
      assert.equal(
        replayCalls.includes(
          "coordinateCommittedRoster"
        ),
        false
      );
    });

    test("rolls back a technical write failure without fabricating a domain blocker", async () => {
      const harness = createHarness({
        technicalCommitFailure: true,
      });

      await assertServiceError(
        () => executeScheduled(harness.service),
        "SQLITE_IOERR"
      );
      const state = harness.state();

      assert.equal(state.attempts.length, 1);
      assert.equal(
        state.attempts[0].status,
        "started"
      );
      assert.deepEqual(state.attempts[0].blockers, []);
      assert.equal(state.binding.status, "scheduled");
      assert.equal(state.entryDraft.status, "ready");
      assert.equal(
        state.binding.selectionGateStatus,
        "locked"
      );
      assert.equal(
        state.binding.tradingGateStatus,
        "locked"
      );
      assert.equal(state.effectsApplied, false);
      assert.equal(
        callNames(harness.calls).includes(
          "blockSeasonRolloverAttempt"
        ),
        false
      );
      assert.equal(
        callNames(harness.calls).includes(
          "coordinateCommittedRoster"
        ),
        false
      );
    });

    test("rejects a superseded occurrence for system execution and commissioner retry without an attempt or effect", async () => {
      const scheduledHarness = createHarness({
        bindingStatus: "superseded",
      });

      await assertServiceError(
        () =>
          executeScheduled(
            scheduledHarness.service
          ),
        "SEASON_ROLLOVER_NOT_READY",
        "rollover_occurrence_superseded"
      );
      assert.equal(
        scheduledHarness.state().attempts.length,
        0
      );
      assert.equal(
        callNames(scheduledHarness.calls).includes(
          "validateScheduledRolloverJobLease"
        ),
        false
      );

      const retryHarness = createHarness({
        bindingStatus: "superseded",
      });
      await assertServiceError(
        () =>
          retryRollover(
            retryHarness.service,
            "superseded-retry"
          ),
        "SEASON_ROLLOVER_NOT_READY",
        "rollover_occurrence_superseded"
      );
      assert.equal(
        retryHarness.state().attempts.length,
        0
      );
      assert.equal(
        retryHarness.state().effectsApplied,
        false
      );
    });

    test("does not expose a client-authored target or calendar path", async () => {
      const harness = createHarness();
      const browserTarget = {
        ...RETRY_INPUT,
        targetSeasonId: uuid(999),
        targetNhlSeasonKey: "20282029",
        nhlRegularSeasonStartsAtMs: 1,
      };

      await assertServiceError(
        () =>
          harness.service.transition({
            leagueId: IDS.league,
            input: browserTarget,
            expectedDraftVersion: 2,
            idempotencyKey:
              "client-target-is-forbidden",
            authenticated:
              COMMISSIONER_AUTHENTICATED,
          }),
        "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID",
        "body_invalid"
      );
      assert.equal(harness.calls.length, 0);

      await assertServiceError(
        () =>
          harness.service
            .executeScheduledEntryDraftRollover({
              leagueId: IDS.league,
              input: {
                ...SCHEDULED_INPUT,
                weekOneStartsAtMs:
                  WEEK_ONE_STARTS_AT_MS,
              },
              scheduledJob: SCHEDULED_JOB,
            }),
        "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID",
        "body_invalid"
      );
      assert.equal(harness.calls.length, 0);
    });

    test("does not start an attempt before the frozen scheduled occurrence is due", async () => {
      const harness = createHarness({
        nowMs: SCHEDULED_STARTS_AT_MS - 1,
      });

      await assertServiceError(
        () => executeScheduled(harness.service),
        "SEASON_ROLLOVER_NOT_READY",
        "scheduled_occurrence_not_due"
      );
      assert.equal(harness.state().attempts.length, 0);
      assert.equal(
        callNames(harness.calls).includes(
          "beginSeasonRolloverAttempt"
        ),
        false
      );
    });

    test("preserves the one-time Season-2 exemption without the obsolete nine-day help boundary", async () => {
      const harness = createHarness({
        nowMs: INITIAL_EXEMPTION_NOW_MS,
      });
      const leadMs =
        INITIAL_WEEK_ONE_STARTS_AT_MS -
        INITIAL_EXEMPTION_NOW_MS;
      assert.ok(
        leadMs < 9 * 24 * 60 * 60 * 1000
      );

      const result =
        await authorizeInitialSeason2Exemption(
          harness.service
        );

      assert.equal(result.replayed, false);
      assert.deepEqual(Object.keys(result), [
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
      assert.deepEqual(result, {
        exemptionId: uuid(501),
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        exemptionKind: SETUP_EXEMPTION_KIND,
        reason:
          "Approved one-time imported Season 2 transition.",
        authorizedByUserId: IDS.administrator,
        authorizedAuthority:
          "platform_administrator_as_commissioner",
        authorizedAtMs:
          INITIAL_EXEMPTION_NOW_MS,
        consumed: false,
        migrationReportId: IDS.migrationReport,
        version: 1,
      });
      const names = callNames(harness.calls);
      assert.equal(
        names.filter(
          (name) => name === "secureRandom.id"
        ).length,
        8
      );
      const insertIndex = names.indexOf(
        "insertSetupExemption"
      );
      const verifyIndex = names.indexOf(
        "verifySetupExemptionEvidence"
      );
      const handoffIndex = names.indexOf(
        "freeAgentDraftReadinessHandoffWriter.write"
      );
      const completeIndex = names.indexOf(
        "completeIdempotencyRequest"
      );
      assert.ok(
        names.indexOf("appendSetupExemptionEvidence") <
          insertIndex
      );
      assert.ok(insertIndex < verifyIndex);
      assert.ok(verifyIndex < handoffIndex);
      assert.ok(handoffIndex < completeIndex);
      const exemptionPlan =
        harness.calls[insertIndex].value.plan;
      assert.deepEqual(
        {
          exemptionId:
            exemptionPlan.exemptionId,
          idempotencyRequestId:
            exemptionPlan.idempotencyRequestId,
          activityId:
            exemptionPlan.activity.id,
          auditId:
            exemptionPlan.securityAudit.id,
          notificationId:
            exemptionPlan.notification.id,
          outboxId: exemptionPlan.outbox.id,
          activityOutboxId:
            exemptionPlan.activityOutbox.id,
          notificationOutboxId:
            exemptionPlan.notificationOutbox.id,
          readinessOperationId:
            exemptionPlan.readinessOperationId,
          readinessJobRunId:
            exemptionPlan.readinessJobRunId,
        },
        {
          exemptionId: uuid(501),
          idempotencyRequestId: uuid(502),
          activityId: uuid(503),
          auditId: uuid(504),
          notificationId: uuid(505),
          outboxId: uuid(506),
          activityOutboxId: deterministicUuid(
            `fad-setup-exemption:activity-publication:${uuid(503)}`
          ),
          notificationOutboxId: deterministicUuid(
            `fad-setup-exemption:notification-publication:${uuid(505)}`
          ),
          readinessOperationId: uuid(507),
          readinessJobRunId: uuid(508),
        }
      );
      assert.deepEqual(
        exemptionPlan.activity,
        {
          id: uuid(503),
          eventType:
            "fad_setup_exemption_authorized",
          leagueId: IDS.league,
          seasonId: IDS.sourceSeason,
          actorUserId: IDS.administrator,
          actorAuthority:
            "platform_administrator_as_commissioner",
          teamId: null,
          playerId: null,
          relatedType: "season",
          relatedId: IDS.sourceSeason,
          displaySummary:
            "Initial Season 2 Free Agent Draft exemption authorized.",
          reason: null,
          metadata: {
            exemptionId: uuid(501),
            seasonId: IDS.sourceSeason,
            migrationReportId:
              IDS.migrationReport,
          },
          occurredAtMs:
            INITIAL_EXEMPTION_NOW_MS,
        }
      );
      assert.deepEqual(
        exemptionPlan.notification,
        {
          id: uuid(505),
          userId: IDS.commissioner,
          type: "fad_setup_exemption_authorized",
          status: "pending",
          messageData: {
            leagueId: IDS.league,
            seasonId: IDS.sourceSeason,
            exemptionId: uuid(501),
            destination: {
              kind: "commissioner_fad",
              leagueId: IDS.league,
              seasonId: IDS.sourceSeason,
            },
          },
          relatedFeature: "free_agent_draft_setup",
          relatedRecordId: uuid(501),
          deduplicationKey:
            "fad_setup_exemption_authorized:" +
            `${IDS.league}:${IDS.sourceSeason}:` +
            `${uuid(501)}:${IDS.commissioner}`,
          createdAtMs:
            INITIAL_EXEMPTION_NOW_MS,
          version: 1,
        }
      );
      assert.deepEqual(
        [
          exemptionPlan.outbox,
          exemptionPlan.activityOutbox,
          exemptionPlan.notificationOutbox,
        ],
        [
          {
            id: uuid(506),
            eventType: "league.changed",
            aggregateType: "league",
            aggregateId: IDS.league,
            scope: "league",
            leagueId: IDS.league,
            changedAtMs:
              INITIAL_EXEMPTION_NOW_MS,
          },
          {
            id: deterministicUuid(
              `fad-setup-exemption:activity-publication:${uuid(503)}`
            ),
            eventType: "activity.created",
            aggregateType: "activity",
            aggregateId: uuid(503),
            scope: "league",
            leagueId: IDS.league,
            changedAtMs:
              INITIAL_EXEMPTION_NOW_MS,
            reasonCode:
              "setup_exemption_authorized",
            version: 1,
          },
          {
            id: deterministicUuid(
              `fad-setup-exemption:notification-publication:${uuid(505)}`
            ),
            eventType: "notification.created",
            aggregateType: "notification",
            aggregateId: uuid(505),
            scope: "user",
            userId: IDS.commissioner,
            leagueId: IDS.league,
            changedAtMs:
              INITIAL_EXEMPTION_NOW_MS,
            reasonCode:
              "setup_exemption_authorized",
            version: 1,
          },
        ]
      );
      assert.deepEqual(
        harness.state().readinessPairs,
        [
          {
            readiness: freshReadinessHandoff({
              operationId: uuid(507),
              jobRunId: uuid(508),
              leagueId: IDS.league,
              seasonId: IDS.sourceSeason,
              triggerKind:
                "no_draft_initial_season2",
              triggerResourceId: uuid(501),
              entryDraftId: null,
              setupExemptionId: uuid(501),
              createdAtMs:
                INITIAL_EXEMPTION_NOW_MS,
            }).readiness,
            job: {
              id: uuid(508),
              occurrenceKey: [
                "fad-readiness",
                IDS.league,
                IDS.sourceSeason,
                uuid(501),
              ].join(":"),
              status: "pending",
              scheduledForMs:
                INITIAL_EXEMPTION_NOW_MS,
            },
          },
        ]
      );
      assert.equal(
        harness.state().idempotencyRequests[0]
          .operation,
        LEAGUE_LIFECYCLE_TRANSITION_OPERATION
      );
      assert.equal(
        callNames(harness.calls).includes(
          "coordinateCommittedRoster"
        ),
        false
      );

      const replayBoundary = harness.calls.length;
      harness.behavior.forbidMutableChecks = true;
      const replay =
        await authorizeInitialSeason2Exemption(
          harness.service
        );
      assert.deepEqual(replay, result);
      assert.equal(replay.replayed, true);
      assert.deepEqual(
        callNames(
          harness.calls.slice(replayBoundary)
        ),
        [
          "transaction.begin",
          "findIdempotencyRequest",
          "findDurableSetupExemptionResult",
          "transaction.commit",
        ]
      );
      assert.equal(
        callNames(harness.calls).filter(
          (name) =>
            name ===
            "freeAgentDraftReadinessHandoffWriter.write"
        ).length,
        1
      );
      assert.equal(
        harness.state().readinessPairs.length,
        1
      );
    });

    test("rolls back the exemption and readiness pair when the handoff result is not exact", async () => {
      const harness = createHarness({
        nowMs: INITIAL_EXEMPTION_NOW_MS,
        invalidReadinessHandoffResult: true,
      });

      await assertServiceError(
        () =>
          authorizeInitialSeason2Exemption(
            harness.service,
            "invalid-readiness-handoff-result"
          ),
        "INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE"
      );

      const state = harness.state();
      assert.deepEqual(state.idempotencyRequests, []);
      assert.equal(state.exemptionResult, null);
      assert.deepEqual(state.readinessPairs, []);
      assert.equal(state.effectsApplied, false);
      const names = callNames(harness.calls);
      assert.equal(
        names.filter(
          (name) =>
            name ===
            "freeAgentDraftReadinessHandoffWriter.write"
        ).length,
        1
      );
      assert.equal(
        names.includes(
          "completeIdempotencyRequest"
        ),
        false
      );
      assert.equal(
        names.at(-1),
        "transaction.rollback"
      );
    });

    test("rechecks current setup-exemption authority before an immutable zero-write replay", async () => {
      const harness = createHarness({
        nowMs: INITIAL_EXEMPTION_NOW_MS,
      });
      const first =
        await authorizeInitialSeason2Exemption(
          harness.service,
          "current-authority-replay"
        );
      const stateBeforeReplay = harness.state();
      const replayBoundary = harness.calls.length;
      harness.behavior.exemptionAuthorityActive =
        false;
      harness.behavior.forbidMutableChecks = true;

      await assertServiceError(
        () =>
          authorizeInitialSeason2Exemption(
            harness.service,
            "current-authority-replay"
          ),
        "PLATFORM_ADMINISTRATOR_REQUIRED"
      );

      assert.equal(first.replayed, false);
      assert.deepEqual(
        harness.state(),
        stateBeforeReplay
      );
      assert.deepEqual(
        callNames(
          harness.calls.slice(replayBoundary)
        ),
        ["transaction.begin", "transaction.rollback"]
      );
    });

    test("rolls back and maps a readiness writer repository-state error", async () => {
      const handoffError = new Error(
        "simulated readiness pair constraint"
      );
      handoffError.code = "REPOSITORY_CONSTRAINT";
      handoffError.details = {
        tableName:
          "free_agent_draft_readiness_operations",
      };
      const harness = createHarness({
        nowMs: INITIAL_EXEMPTION_NOW_MS,
        readinessHandoffError: handoffError,
      });

      await assertServiceError(
        () =>
          authorizeInitialSeason2Exemption(
            harness.service,
            "readiness-handoff-constraint"
          ),
        "INITIAL_SEASON2_NO_DRAFT_NOT_ELIGIBLE",
        "repository_state_changed"
      );

      const state = harness.state();
      assert.deepEqual(state.idempotencyRequests, []);
      assert.equal(state.exemptionResult, null);
      assert.deepEqual(state.readinessPairs, []);
      assert.equal(
        callNames(harness.calls).at(-1),
        "transaction.rollback"
      );
    });

    test("rolls back and preserves a technical readiness writer error", async () => {
      const handoffError = new Error(
        "simulated readiness storage failure"
      );
      handoffError.code = "SQLITE_IOERR";
      const harness = createHarness({
        nowMs: INITIAL_EXEMPTION_NOW_MS,
        readinessHandoffError: handoffError,
      });

      await assertServiceError(
        () =>
          authorizeInitialSeason2Exemption(
            harness.service,
            "readiness-handoff-io-error"
          ),
        "SQLITE_IOERR"
      );

      const state = harness.state();
      assert.deepEqual(state.idempotencyRequests, []);
      assert.equal(state.exemptionResult, null);
      assert.deepEqual(state.readinessPairs, []);
      assert.equal(
        callNames(harness.calls).at(-1),
        "transaction.rollback"
      );
    });
  }
);
