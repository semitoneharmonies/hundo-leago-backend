const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  finalizeFreeAgentDraftOpeningReadiness,
  inspectFreeAgentDraftOpeningReadiness,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftOpeningReadinessPolicy"
);
const {
  FREE_AGENT_DRAFT_READINESS_MINIMUM_RETRY_DELAY_MS,
  FREE_AGENT_DRAFT_READINESS_SERVICE_CODES,
  FreeAgentDraftReadinessServiceError,
  createFreeAgentDraftReadinessService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftReadinessService"
);

function uuid(number, prefix = "10000000") {
  return (
    `${prefix}-0000-4000-8000-` +
    String(number).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  commissionerMembership: uuid(3),
  readiness: uuid(4),
  readinessJob: uuid(5),
  team: uuid(10),
  manager: uuid(11),
  membership: uuid(12),
  assignment: uuid(13),
  scheduleOperation: uuid(20),
  weekOne: uuid(21),
  replacementScheduleOperation: uuid(22),
  replacementWeekOne: uuid(23),
});

const OBSERVED_AT_MS = Date.parse(
  "2026-08-08T16:00:00.000Z"
);
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-12T07:00:00.000Z"
);
const STALE_WEEK_ONE_AT_MS = Date.parse(
  "2026-08-10T07:00:00.000Z"
);
const RECOVERED_WEEK_ONE_AT_MS = Date.parse(
  "2026-08-17T07:00:00.000Z"
);
const PLAYOFFS_AT_MS = Date.parse(
  "2027-03-15T07:00:00.000Z"
);
const SEASON_END_AT_MS = Date.parse(
  "2027-04-12T07:00:00.000Z"
);
const OCCURRENCE_KEY =
  `fad-readiness:${IDS.league}:` +
  `${IDS.season}:${IDS.season}`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeSecureRandom({ duplicate = false } = {}) {
  let next = 1;
  return {
    id() {
      const id = uuid(
        duplicate ? 1 : next,
        "90000000"
      );
      next += 1;
      return id;
    },
  };
}

function team() {
  return {
    teamId: IDS.team,
    name: "Alpha Ravens",
    status: "active",
    primaryColour: "#102030",
    secondaryColour: "#f0a020",
    tertiaryColour: null,
    patternTemplate: "equal-two",
    logoReference: null,
    version: 1,
  };
}

function manager() {
  return {
    managerAssignmentId: IDS.assignment,
    teamId: IDS.team,
    userId: IDS.manager,
    membershipId: IDS.membership,
    assignmentStatus: "accepted",
    acceptedAtMs: OBSERVED_AT_MS - 20_000,
    endedAtMs: null,
    version: 1,
    membershipStatus: "active",
    userStatus: "active",
  };
}

function openingContext({
  weekOneStartsAtMs = WEEK_ONE_AT_MS,
} = {}) {
  const startedAtMs = OBSERVED_AT_MS - 100;
  const createdAtMs = OBSERVED_AT_MS - 10_000;
  return {
    activeContracts: [],
    allContracts: [],
    allContractYears: [],
    buyoutObligations: [],
    buyoutYears: [],
    currentPlayerSources: [],
    currentSchedule: {
      operationId: IDS.scheduleOperation,
      version: 1,
      generationVersion: 1,
      weekId: IDS.weekOne,
      startsAtMs: weekOneStartsAtMs,
      createdAtMs: 4,
    },
    currentScheduleJobBindings: [],
    currentScheduleOperation: {
      operationId: IDS.scheduleOperation,
      seasonId: IDS.season,
      operationType: "schedule_generate",
      status: "succeeded",
      startedAtMs: 3,
      completedAtMs: 4,
    },
    entryDraft: null,
    existingFad: null,
    firstMatchupWeek: {
      weekId: IDS.weekOne,
      sequence: 1,
      startsAtMs: weekOneStartsAtMs,
      version: 1,
    },
    league: {
      leagueId: IDS.league,
      status: "active",
      timeZone: "America/Vancouver",
      currentSeasonId: IDS.season,
      commissionerMembershipId:
        IDS.commissionerMembership,
      version: 1,
    },
    leaguePositionOverrides: [],
    leagueSettings: {
      leagueId: IDS.league,
      salaryCapCents: 100_000,
      maximumTeams: 20,
      activeForwardSlots: 12,
      activeDefenceSlots: 6,
      benchSlots: 4,
      maximumBenchAavCents: 400,
      injuredReserveSlots: 4,
      prospectSlotsUnlimited: 1,
      version: 1,
    },
    managerAssignments: [manager()],
    ownerships: [],
    participatingTeams: [team()],
    priorSeason: null,
    priorSeasonBuyoutYears: [],
    priorSeasonContractYears: [],
    priorSeasonRollovers: [],
    priorSeasonRolloverItems: [],
    priorSeasonRolloverOwnershipReceipt: null,
    priorSeasonRolloverReceipt: null,
    priorSeasonRetentionYears: [],
    readinessJob: {
      jobRunId: IDS.readinessJob,
      leagueId: IDS.league,
      seasonId: IDS.season,
      jobType: "fad_readiness",
      occurrenceKey: OCCURRENCE_KEY,
      scheduledForMs: createdAtMs,
      status: "running",
      attemptCount: 1,
      leaseOwner: "fad-readiness-worker",
      leaseToken: "lease-token",
      leaseExpiresAtMs: OBSERVED_AT_MS + 60_000,
      startedAtMs,
      completedAtMs: null,
      resultJson: null,
      lastErrorCode: null,
      nextAttemptAtMs: null,
      createdAtMs,
      updatedAtMs: startedAtMs,
      version: 2,
    },
    readinessOperation: {
      operationId: IDS.readiness,
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey: OCCURRENCE_KEY,
      triggerKind: "no_draft_inaugural",
      entryDraftId: null,
      setupExemptionId: null,
      jobRunId: IDS.readinessJob,
      status: "running",
      attemptCount: 1,
      leaseOwner: "fad-readiness-worker",
      leaseToken: "lease-token",
      leaseExpiresAtMs: OBSERVED_AT_MS + 60_000,
      blockersJson: "[]",
      matchupScheduleVersionBefore: null,
      matchupScheduleVersionAfter: null,
      scheduleRecoveryId: null,
      createdFadId: null,
      reminderJobRunId: null,
      deadlineJobRunId: null,
      cardsOpenedActivityId: null,
      cardsOpenedOutboxEventId: null,
      startedAtMs,
      nextRetryAtMs: null,
      terminalAtMs: null,
      createdAtMs,
      updatedAtMs: startedAtMs,
      version: 2,
    },
    retentionObligations: [],
    retentionYears: [],
    rosterOrderEntries: [],
    rosterOrderSets: [],
    season: {
      seasonId: IDS.season,
      label: "2026-27",
      nhlSeasonKey: "20262027",
      status: "active",
      regularSeasonStartsAtMs: Date.parse(
        "2026-10-01T07:00:00.000Z"
      ),
      regularSeasonEndsAtMs: SEASON_END_AT_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_AT_MS,
      fantasyPlayoffsEndAtMs: SEASON_END_AT_MS,
      freeAgentDraftCompletedAtMs: null,
      version: 1,
    },
    setupExemptions: [],
    targetContractYears: [],
  };
}

function shiftContext({
  weekOneStartsAtMs = WEEK_ONE_AT_MS,
} = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    timeZone: "America/Vancouver",
    seasonStatus: "active",
    seasonVersion: 1,
    nhlSeasonKey: "20262027",
    nhlRegularSeasonStartsAtMs: Date.parse(
      "2026-10-01T07:00:00.000Z"
    ),
    nhlRegularSeasonEndsAtMs: SEASON_END_AT_MS,
    fantasyPlayoffsStartAtMs: PLAYOFFS_AT_MS,
    fantasyPlayoffsEndAtMs: SEASON_END_AT_MS,
    fadCount: 0,
    teams: [{ id: IDS.team }],
    currentGenerationCount: 1,
    currentGeneration: {
      leagueId: IDS.league,
      seasonId: IDS.season,
      scheduleVersion: 1,
      scheduleOperationId: IDS.scheduleOperation,
      weekOneMatchupWeekId: IDS.weekOne,
      weekOneStartsAtMs,
      status: "current",
      supersededAtMs: null,
      version: 1,
    },
    weeks: [],
    jobs: [],
    unboundJobCount: 0,
  };
}

function executionInput(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    occurrenceKey: OCCURRENCE_KEY,
    readinessOperationId: IDS.readiness,
    jobExecution: {
      runId: IDS.readinessJob,
      leaseOwner: "fad-readiness-worker",
      leaseToken: "lease-token",
      leaseExpiresAtMs: OBSERVED_AT_MS + 60_000,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function fixture({
  clock = { nowMs: () => OBSERVED_AT_MS },
  context = openingContext(),
  scheduleContext = shiftContext(),
  planner,
  secureRandom = makeSecureRandom(),
} = {}) {
  const calls = {
    block: [],
    commit: [],
    openingRead: [],
    plan: [],
    scheduleRead: [],
  };
  const effectivePlanner = planner || (() => ({
    action: "no_op",
    recoveryRequired: false,
    recoveryKind: "pre_open",
    decision: {},
  }));
  const repository = {
    blockReadinessOperation(command) {
      calls.block.push(command);
      return {
        replayed: false,
        readiness: {
          id: IDS.readiness,
          status: "blocked",
          version: 3,
        },
      };
    },
    commitOpening(command) {
      calls.commit.push(command);
      return {
        replayed: false,
        readiness: {
          id: IDS.readiness,
          status: "succeeded",
          version: 3,
        },
        draft: {
          id: command.evidence.fadId,
        },
      };
    },
  };
  const service = createFreeAgentDraftReadinessService({
    clock,
    readRepository: {
      readOpeningPreflightContext(input) {
        calls.openingRead.push(input);
        return context;
      },
    },
    repository,
    scheduleRepository: {
      readShiftContext(input) {
        calls.scheduleRead.push(input);
        return scheduleContext;
      },
    },
    scheduleRecoveryServiceFactory({
      secureRandom: plannerSecureRandom,
    }) {
      return {
        planRecovery(input) {
          calls.plan.push({
            context: input,
            secureRandom: plannerSecureRandom,
          });
          return effectivePlanner(
            input,
            plannerSecureRandom
          );
        },
      };
    },
    secureRandom,
  });
  return { calls, repository, service };
}

function assertServiceError(
  callback,
  code,
  reasonCode
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftReadinessServiceError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("Free Agent Draft readiness execution service", () => {
  test("commits one complete no-recovery opening from the exact claimed lease", () => {
    const { calls, service } = fixture();

    const result =
      service.executeClaimedReadiness(
        executionInput()
      );

    assert.deepEqual(result, {
      outcome: "succeeded",
      replayed: false,
      readinessOperationId: IDS.readiness,
      readinessAttemptId: uuid(2, "90000000"),
      readinessVersion: 3,
      fadId: uuid(1, "90000000"),
      nextRetryAtMs: null,
      scheduleRecoveryRequired: false,
    });
    assert.equal(calls.openingRead.length, 1);
    assert.equal(calls.scheduleRead.length, 1);
    assert.equal(calls.plan.length, 1);
    assert.equal(calls.block.length, 0);
    assert.equal(calls.commit.length, 1);

    const command = calls.commit[0];
    assert.equal(command.setupPath, "no_draft_inaugural");
    assert.equal(
      command.noDraftReason,
      "Inaugural league season."
    );
    assert.equal(command.scheduleRecoveryPlan, null);
    assert.equal(
      command.openedAtMs,
      OBSERVED_AT_MS
    );
    assert.equal(
      command.attempt.projection.candidateDeadlineAtMs,
      WEEK_ONE_AT_MS -
        FREE_AGENT_DRAFT_INITIAL_WINDOW_MS
    );
    assert.deepEqual(command.carryoverProjection, {
      teams: [
        {
          teamId: IDS.team,
          entries: [],
          carryoverCount: 0,
          openForwardSlots: 12,
          openDefenceSlots: 6,
          openBenchSlots: 4,
          structuralConflictCount: 0,
        },
      ],
      stateBlockers: [],
      structuralWarnings: [],
    });
    assert.equal(command.evidence.participants.length, 1);
    const generatedIds = [
      command.attempt.id,
      command.evidence.fadId,
      command.evidence.reminderJobRunId,
      command.evidence.deadlineJobRunId,
      ...command.evidence.rolloverIds,
      ...command.evidence.rolloverJobRunIds,
      command.evidence.activityId,
      command.evidence.outboxEventId,
      command.evidence.outboxAudienceId,
      ...command.evidence.participants.flatMap(
        ({ participantId, cardId, notificationId }) => [
          participantId,
          cardId,
          notificationId,
        ]
      ),
    ];
    assert.equal(
      new Set(generatedIds).size,
      generatedIds.length
    );
    assert.equal(Object.isFrozen(result), true);
  });

  test("threads the late-Week-1 recovery plan into the same opening command", () => {
    const context = openingContext({
      weekOneStartsAtMs: STALE_WEEK_ONE_AT_MS,
    });
    const scheduleContext = shiftContext({
      weekOneStartsAtMs: STALE_WEEK_ONE_AT_MS,
    });
    let stagedPlan;
    const { calls, service } = fixture({
      context,
      scheduleContext,
      planner(recoveryContext, plannerSecureRandom) {
        assert.equal(
          recoveryContext.recovery.atMs,
          OBSERVED_AT_MS
        );
        assert.equal(
          recoveryContext.fadId,
          uuid(1, "90000000")
        );
        stagedPlan = {
          action: "stage_recovery",
          recoveryRequired: true,
          recoveryKind: "pre_open",
          generation: {
            replacement: {
              scheduleOperationId:
                IDS.replacementScheduleOperation,
              scheduleVersion: 2,
              weekOneMatchupWeekId:
                IDS.replacementWeekOne,
              weekOneStartsAtMs:
                RECOVERED_WEEK_ONE_AT_MS,
            },
          },
          plannerEvidenceId:
            plannerSecureRandom.id(),
        };
        return stagedPlan;
      },
    });

    const result =
      service.executeClaimedReadiness(
        executionInput()
      );

    assert.equal(result.outcome, "succeeded");
    assert.equal(
      result.scheduleRecoveryRequired,
      true
    );
    assert.equal(calls.commit.length, 1);
    assert.equal(
      calls.commit[0].scheduleRecoveryPlan,
      stagedPlan
    );
    assert.equal(
      calls.commit[0].attempt.projection
        .firstMatchupWeekAfter.startsAtMs,
      RECOVERED_WEEK_ONE_AT_MS
    );
    assert.equal(
      calls.commit[0].attempt.projection
        .candidateDeadlineAtMs,
      RECOVERED_WEEK_ONE_AT_MS -
        FREE_AGENT_DRAFT_INITIAL_WINDOW_MS
    );
    assert.equal(
      calls.commit[0].attempt.projection.warnings[0]
        .code,
      "FAD_WEEK_ONE_MOVED"
    );
  });

  test("records only the immutable blocked attempt when preflight has blockers", () => {
    const context = openingContext();
    context.managerAssignments = [];
    const { calls, service } = fixture({ context });

    const result =
      service.executeClaimedReadiness(
        executionInput()
      );

    assert.deepEqual(result, {
      outcome: "blocked",
      replayed: false,
      readinessOperationId: IDS.readiness,
      readinessAttemptId: uuid(1, "90000000"),
      readinessVersion: 3,
      fadId: null,
      nextRetryAtMs:
        OBSERVED_AT_MS +
        FREE_AGENT_DRAFT_READINESS_MINIMUM_RETRY_DELAY_MS,
      scheduleRecoveryRequired: false,
    });
    assert.equal(calls.scheduleRead.length, 0);
    assert.equal(calls.plan.length, 0);
    assert.equal(calls.commit.length, 0);
    assert.equal(calls.block.length, 1);
    const command = calls.block[0];
    assert.equal(
      command.nextRetryAtMs,
      OBSERVED_AT_MS +
        FREE_AGENT_DRAFT_READINESS_MINIMUM_RETRY_DELAY_MS
    );
    assert.deepEqual(
      command.blockers.map(({ code }) => code),
      ["FAD_MANAGER_MISSING"]
    );
    assert.deepEqual(command.attempt.projection.blockers, [
      {
        code: "FAD_MANAGER_MISSING",
        message:
          "Every participating team needs a current manager.",
        resourceId: IDS.team,
      },
    ]);
    assert.equal(
      Object.hasOwn(
        command.attempt.projection.blockers[0],
        "field"
      ),
      false
    );
  });

  test("persists the missing-schedule blocker without touching recovery planning", () => {
    const context = openingContext();
    context.currentSchedule = null;
    context.currentScheduleOperation = null;
    context.firstMatchupWeek = null;
    const { calls, service } = fixture({ context });

    const result =
      service.executeClaimedReadiness(
        executionInput()
      );

    assert.equal(result.outcome, "blocked");
    assert.deepEqual(
      calls.block[0].blockers.map(({ code }) => code),
      ["MATCHUP_SCHEDULE_MISSING"]
    );
    assert.equal(calls.scheduleRead.length, 0);
    assert.equal(calls.plan.length, 0);
    assert.equal(calls.commit.length, 0);
  });

  test("records a blocked attempt at a fresh terminal timestamp", () => {
    const context = openingContext();
    context.managerAssignments = [];
    let clockReadCount = 0;
    const { calls, service } = fixture({
      context,
      clock: {
        nowMs() {
          clockReadCount += 1;
          return clockReadCount === 1
            ? OBSERVED_AT_MS
            : OBSERVED_AT_MS + 17;
        },
      },
    });

    const result =
      service.executeClaimedReadiness(
        executionInput()
      );

    assert.equal(result.outcome, "blocked");
    assert.equal(
      calls.block[0].attempt.observedAtMs,
      OBSERVED_AT_MS
    );
    assert.equal(
      calls.block[0].attempt.recordedAtMs,
      OBSERVED_AT_MS + 17
    );
    assert.equal(
      calls.block[0].blockedAtMs,
      OBSERVED_AT_MS + 17
    );
    assert.equal(
      calls.block[0].nextRetryAtMs,
      OBSERVED_AT_MS + 18
    );
  });

  test("rejects a claimed lease that no longer matches the authoritative pair", () => {
    const context = openingContext();
    context.readinessOperation.leaseToken =
      "replacement-token";
    context.readinessJob.leaseToken =
      "replacement-token";
    const { calls, service } = fixture({ context });

    assertServiceError(
      () =>
        service.executeClaimedReadiness(
          executionInput()
        ),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.stateInvalid,
      "claimed_execution_changed"
    );
    assert.equal(calls.scheduleRead.length, 0);
    assert.equal(calls.block.length, 0);
    assert.equal(calls.commit.length, 0);
  });

  test("fails closed when the schedule recovery read has unbound occurrence state", () => {
    const scheduleContext = shiftContext();
    scheduleContext.unboundJobCount = 1;
    const { calls, service } = fixture({
      scheduleContext,
    });

    assertServiceError(
      () =>
        service.executeClaimedReadiness(
          executionInput()
        ),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.stateInvalid,
      "schedule_recovery_context_changed"
    );
    assert.equal(calls.plan.length, 0);
    assert.equal(calls.block.length, 0);
    assert.equal(calls.commit.length, 0);
  });

  test("fails closed when schedule participants or planner action drift", () => {
    const participantDrift = shiftContext();
    participantDrift.teams = [{ id: uuid(99) }];
    const first = fixture({
      scheduleContext: participantDrift,
    });
    assertServiceError(
      () =>
        first.service.executeClaimedReadiness(
          executionInput()
        ),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.stateInvalid,
      "schedule_participant_set_changed"
    );
    assert.equal(first.calls.plan.length, 0);
    assert.equal(first.calls.commit.length, 0);

    const second = fixture({
      planner() {
        return {
          action: "stage_recovery",
          recoveryRequired: true,
          recoveryKind: "pre_open",
          generation: {
            replacement: {
              scheduleOperationId:
                IDS.replacementScheduleOperation,
              scheduleVersion: 2,
              weekOneMatchupWeekId:
                IDS.replacementWeekOne,
              weekOneStartsAtMs:
                RECOVERED_WEEK_ONE_AT_MS,
            },
          },
        };
      },
    });
    assertServiceError(
      () =>
        second.service.executeClaimedReadiness(
          executionInput()
        ),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.stateInvalid,
      "schedule_recovery_plan_mismatch"
    );
    assert.equal(second.calls.commit.length, 0);
    assert.equal(second.calls.block.length, 0);
  });

  test("rejects duplicate evidence identifiers before an opening write", () => {
    const { calls, service } = fixture({
      secureRandom: makeSecureRandom({
        duplicate: true,
      }),
    });

    assert.throws(
      () =>
        service.executeClaimedReadiness(
          executionInput()
        ),
      /unique canonical secure identifiers/
    );
    assert.equal(calls.block.length, 0);
    assert.equal(calls.commit.length, 0);
  });

  test("propagates an opening transaction conflict without inventing a blocked result", () => {
    const { calls, repository, service } = fixture();
    const conflict = new Error("opening conflict");
    conflict.code = "REPOSITORY_VERSION_CONFLICT";
    repository.commitOpening = () => {
      throw conflict;
    };

    assert.throws(
      () =>
        service.executeClaimedReadiness(
          executionInput()
        ),
      (error) => error === conflict
    );
    assert.equal(calls.block.length, 0);
  });

  test("persists a blocker discovered by the transaction-bound opening preflight", () => {
    const blockedContext = openingContext();
    blockedContext.managerAssignments = [];
    const blockedInspection =
      inspectFreeAgentDraftOpeningReadiness({
        context: blockedContext,
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey: OCCURRENCE_KEY,
        observedAtMs: OBSERVED_AT_MS,
      });
    const blocked =
      finalizeFreeAgentDraftOpeningReadiness({
        inspection: blockedInspection,
        openedAtMs: null,
        targetSchedule: null,
      });
    const { calls, repository, service } = fixture();
    repository.commitOpening = (command) => {
      calls.commit.push(command);
      return {
        replayed: false,
        openingBlocked: true,
        readiness: {
          id: IDS.readiness,
          status: "running",
          version: 2,
        },
        observedAtMs: OBSERVED_AT_MS,
        internalBlockers: blocked.internalBlockers,
        attemptProjection: blocked.attemptProjection,
      };
    };

    const result =
      service.executeClaimedReadiness(
        executionInput()
      );

    assert.equal(result.outcome, "blocked");
    assert.equal(calls.commit.length, 1);
    assert.equal(calls.block.length, 1);
    assert.deepEqual(
      calls.block[0].blockers.map(({ code }) => code),
      ["FAD_MANAGER_MISSING"]
    );
    assert.equal(
      calls.block[0].attempt.id,
      result.readinessAttemptId
    );
    assert.equal(
      calls.block[0].attempt.id,
      calls.commit[0].attempt.id
    );
    assert.equal(
      calls.block[0].attempt.observedAtMs,
      OBSERVED_AT_MS
    );
    assert.equal(
      calls.block[0].attempt.recordedAtMs,
      OBSERVED_AT_MS
    );
  });

  test("leaves a semantic blocker uncommitted if the lease expires after the opening probe", () => {
    const blockedContext = openingContext();
    blockedContext.managerAssignments = [];
    const blockedInspection =
      inspectFreeAgentDraftOpeningReadiness({
        context: blockedContext,
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey: OCCURRENCE_KEY,
        observedAtMs: OBSERVED_AT_MS,
      });
    const blocked =
      finalizeFreeAgentDraftOpeningReadiness({
        inspection: blockedInspection,
        openedAtMs: null,
        targetSchedule: null,
      });
    let clockReadCount = 0;
    const { calls, repository, service } = fixture({
      clock: {
        nowMs() {
          clockReadCount += 1;
          return clockReadCount < 3
            ? OBSERVED_AT_MS
            : OBSERVED_AT_MS + 60_000;
        },
      },
    });
    repository.commitOpening = (command) => {
      calls.commit.push(command);
      return {
        replayed: false,
        openingBlocked: true,
        readiness: {
          id: IDS.readiness,
          status: "running",
          version: 2,
        },
        observedAtMs: OBSERVED_AT_MS,
        internalBlockers: blocked.internalBlockers,
        attemptProjection: blocked.attemptProjection,
      };
    };

    assertServiceError(
      () =>
        service.executeClaimedReadiness(
          executionInput()
        ),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.stateInvalid,
      "claimed_lease_expired_before_terminal"
    );
    assert.equal(calls.commit.length, 1);
    assert.equal(calls.block.length, 0);
  });

  test("rejects malformed transaction-bound blocker results without a terminal write", () => {
    const { calls, repository, service } = fixture();
    repository.commitOpening = (command) => {
      calls.commit.push(command);
      return {
        replayed: false,
        openingBlocked: true,
        readiness: {
          id: IDS.readiness,
          status: "running",
          version: 3,
        },
        observedAtMs: OBSERVED_AT_MS,
        internalBlockers: [],
        attemptProjection: {},
      };
    };

    assertServiceError(
      () =>
        service.executeClaimedReadiness(
          executionInput()
        ),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.stateInvalid,
      "transactional_blocker_result_invalid"
    );
    assert.equal(calls.commit.length, 1);
    assert.equal(calls.block.length, 0);
  });

  test("leaves the claimed pair running when its lease expires during planning", () => {
    let clockReadCount = 0;
    const { calls, service } = fixture({
      clock: {
        nowMs() {
          clockReadCount += 1;
          return clockReadCount === 1
            ? OBSERVED_AT_MS
            : OBSERVED_AT_MS + 60_000;
        },
      },
    });

    assertServiceError(
      () =>
        service.executeClaimedReadiness(
          executionInput()
        ),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.stateInvalid,
      "claimed_lease_expired_before_terminal"
    );
    assert.equal(calls.plan.length, 1);
    assert.equal(calls.commit.length, 0);
    assert.equal(calls.block.length, 0);
  });

  test("re-reads and re-plans when the Candidate Card deadline passes during planning", () => {
    const candidateDeadlineAtMs =
      WEEK_ONE_AT_MS -
      FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
    const recoveredWeekOneAtMs =
      WEEK_ONE_AT_MS + 7 * 24 * 60 * 60 * 1000;
    const leaseExpiresAtMs =
      recoveredWeekOneAtMs + 60_000;
    const context = openingContext();
    context.readinessOperation.leaseExpiresAtMs =
      leaseExpiresAtMs;
    context.readinessJob.leaseExpiresAtMs =
      leaseExpiresAtMs;
    let clockReadCount = 0;
    let planCount = 0;
    const { calls, service } = fixture({
      context,
      clock: {
        nowMs() {
          clockReadCount += 1;
          return clockReadCount === 1
            ? candidateDeadlineAtMs - 1
            : candidateDeadlineAtMs;
        },
      },
      planner() {
        planCount += 1;
        if (planCount === 1) {
          return {
            action: "no_op",
            recoveryRequired: false,
            recoveryKind: "pre_open",
          };
        }
        return {
          action: "stage_recovery",
          recoveryRequired: true,
          recoveryKind: "pre_open",
          generation: {
            replacement: {
              scheduleOperationId:
                IDS.replacementScheduleOperation,
              scheduleVersion: 2,
              weekOneMatchupWeekId:
                IDS.replacementWeekOne,
              weekOneStartsAtMs:
                recoveredWeekOneAtMs,
            },
          },
        };
      },
    });

    const result =
      service.executeClaimedReadiness(
        executionInput({
          jobExecution: {
            ...executionInput().jobExecution,
            leaseExpiresAtMs,
          },
        })
      );

    assert.equal(result.outcome, "succeeded");
    assert.equal(result.scheduleRecoveryRequired, true);
    assert.equal(calls.openingRead.length, 2);
    assert.equal(calls.scheduleRead.length, 2);
    assert.equal(calls.plan.length, 2);
    assert.equal(calls.commit.length, 1);
    assert.equal(calls.block.length, 0);
    assert.equal(
      calls.commit[0].openedAtMs,
      candidateDeadlineAtMs
    );
    assert.equal(
      calls.commit[0].attempt.projection
        .candidateDeadlineAtMs,
      recoveredWeekOneAtMs -
        FREE_AGENT_DRAFT_INITIAL_WINDOW_MS
    );
  });

  test("rejects expired or structurally mixed execution input without writes", () => {
    const context = openingContext();
    context.readinessOperation.leaseExpiresAtMs =
      OBSERVED_AT_MS;
    context.readinessJob.leaseExpiresAtMs =
      OBSERVED_AT_MS;
    const { calls, service } = fixture({ context });

    assertServiceError(
      () =>
        service.executeClaimedReadiness(
          executionInput({
            jobExecution: {
              ...executionInput().jobExecution,
              leaseExpiresAtMs: OBSERVED_AT_MS,
            },
          })
        ),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.inputInvalid,
      "claimed_lease_expired"
    );
    assertServiceError(
      () =>
        service.executeClaimedReadiness({
          ...executionInput(),
          extra: true,
        }),
      FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.inputInvalid,
      "execution_fields_invalid"
    );
    assert.equal(calls.openingRead.length, 1);
  });
});
