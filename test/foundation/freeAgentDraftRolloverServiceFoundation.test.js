"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_ROLLOVER_SERVICE_CODES,
  FreeAgentDraftRolloverServiceError,
  createFreeAgentDraftRolloverService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftRolloverService"
);
const {
  FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRolloverWriter"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  rollover: uuid(4),
  run: uuid(5),
  lease: uuid(6),
  recovery: uuid(7),
  extension: uuid(8),
  extensionJob: uuid(9),
});
const SEQUENCE = 7;
const ROLLOVER_AT_MS = 10_000;
const STARTED_AT_MS = 10_100;
const OBSERVED_AT_MS = 10_200;
const LEASE_EXPIRES_AT_MS = 20_000;
const OCCURRENCE_KEY =
  buildFreeAgentDraftRolloverOccurrenceKey({
    fadId: IDS.fad,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
  });

function execution(overrides = {}) {
  const base = {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    rolloverId: IDS.rollover,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: ROLLOVER_AT_MS,
    jobExecution: {
      runId: IDS.run,
      expectedVersion: 2,
      leaseOwner: "fad-rollover-worker",
      leaseToken: IDS.lease,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: STARTED_AT_MS,
      attemptCount: 1,
    },
  };
  return {
    ...base,
    ...overrides,
    jobExecution: {
      ...base.jobExecution,
      ...(overrides.jobExecution || {}),
    },
  };
}

function identity() {
  const {
    scheduledForMs: _scheduledForMs,
    jobExecution: _jobExecution,
    ...value
  } = execution();
  return value;
}

function liveProjection(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    rolloverId: IDS.rollover,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
    status: "scheduled",
    rolloverVersion: 5,
    occurrenceKey: OCCURRENCE_KEY,
    jobRunId: IDS.run,
    jobStatus: "running",
    jobRunVersion: 2,
    sourceRecoveryId: null,
    sourceRecoveryStatus: null,
    sourceRecoveryVersion: null,
    replayed: false,
    ...overrides,
  };
}

function policyEvidence(overrides = {}) {
  return {
    auctionCount: 0,
    normalAuctionCount: 0,
    recoverableAuctionCount: 0,
    nominationCount: 0,
    terminalNominationCount: 0,
    requiredFallbackCount: 0,
    createdFallbackCount: 0,
    unresolvedCount: 0,
    recoverableUnresolvedCount: 0,
    ...overrides,
  };
}

function completed(overrides = {}) {
  return {
    outcome: "completed",
    replayed: false,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    rolloverId: IDS.rollover,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
    finalizedAtMs: OBSERVED_AT_MS,
    rolloverVersion: 7,
    jobRunId: IDS.run,
    jobRunVersion: 3,
    sourceRecoveryId: null,
    evidence: {
      reasonCode: "boundary_accounted",
      ...policyEvidence(),
    },
    ...overrides,
  };
}

function decision(outcome, overrides = {}) {
  const recovery = outcome === "recovery_required";
  return {
    rolloverId: IDS.rollover,
    fadId: IDS.fad,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
    outcome,
    reasonCode: recovery
      ? "boundary_recovery_required"
      : "boundary_work_pending",
    evidence: policyEvidence({
      unresolvedCount: recovery ? 2 : 2,
      recoverableUnresolvedCount: recovery ? 2 : 1,
    }),
    replayed: false,
    ...overrides,
  };
}

function recordedFailure(overrides = {}) {
  return {
    outcome: "failure_recorded",
    replayed: false,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    rolloverId: IDS.rollover,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
    failedAtMs: OBSERVED_AT_MS,
    rolloverVersion: 7,
    jobRunId: IDS.run,
    jobRunVersion: 3,
    recoveryId: IDS.recovery,
    extensionRolloverId: IDS.extension,
    extensionJobRunId: IDS.extensionJob,
    failureCode: FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
    ...overrides,
  };
}

function create({
  projection = liveProjection(),
  executeResult = completed(),
  failureResult = recordedFailure(),
  nowMs = OBSERVED_AT_MS,
  calls = [],
} = {}) {
  return createFreeAgentDraftRolloverService({
    writer: {
      findFinalization(input) {
        calls.push(["find", input]);
        return projection;
      },
      executeClaimed(input) {
        calls.push(["execute", input]);
        return executeResult;
      },
      recordFailure(input) {
        calls.push(["failure", input]);
        return failureResult;
      },
    },
    clock: {
      nowMs() {
        calls.push(["clock"]);
        return nowMs;
      },
    },
  });
}

describe("Free Agent Draft rollover service foundation", () => {
  test("completes a scheduled rollover with the exact fresh +2 version fence", () => {
    const calls = [];
    const result = create({ calls })
      .executeClaimedRollover(execution());

    assert.deepEqual(result, completed());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.evidence), true);
    assert.deepEqual(calls, [
      ["find", identity()],
      ["clock"],
      [
        "execute",
        {
          ...identity(),
          expectedRolloverVersion: 5,
          finalizedAtMs: OBSERVED_AT_MS,
          jobExecution: execution().jobExecution,
        },
      ],
    ]);
  });

  test("completes a running T142 recovery with the exact +1 version and recovery witness", () => {
    const retryExecution = execution({
      jobExecution: {
        expectedVersion: 10,
        attemptCount: 2,
      },
    });
    const service = create({
      projection: liveProjection({
        status: "recovery_required",
        rolloverVersion: 8,
        jobRunVersion: 10,
        sourceRecoveryId: IDS.recovery,
        sourceRecoveryStatus: "running",
        sourceRecoveryVersion: 3,
      }),
      executeResult: completed({
        rolloverVersion: 9,
        jobRunVersion: 11,
        sourceRecoveryId: IDS.recovery,
      }),
    });

    assert.deepEqual(
      service.executeClaimedRollover(retryExecution),
      completed({
        rolloverVersion: 9,
        jobRunVersion: 11,
        sourceRecoveryId: IDS.recovery,
      })
    );
  });

  test("keeps the scheduled +2 fence after an awaiting-data lease reclaim", () => {
    const reclaimed = execution({
      jobExecution: {
        expectedVersion: 10,
        attemptCount: 2,
      },
    });
    const projection = liveProjection({
      jobRunVersion: 10,
    });
    const terminal = completed({
      rolloverVersion: 7,
      jobRunVersion: 11,
    });
    const service = create({
      projection,
      executeResult: terminal,
      failureResult: recordedFailure({
        rolloverVersion: 7,
        jobRunVersion: 11,
      }),
    });

    assert.deepEqual(
      service.executeClaimedRollover(reclaimed),
      terminal
    );
    assert.deepEqual(
      service.recordClaimedFailure({
        ...reclaimed,
        reasonCode: "boundary_recovery_required",
      }),
      recordedFailure({
        rolloverVersion: 7,
        jobRunVersion: 11,
      })
    );
  });

  test("returns exact awaiting-data and recovery-required policy decisions without terminalizing them", () => {
    for (const outcome of [
      "awaiting_data",
      "recovery_required",
    ]) {
      let failures = 0;
      const service = createFreeAgentDraftRolloverService({
        writer: {
          findFinalization: () => liveProjection(),
          executeClaimed: () => decision(outcome),
          recordFailure() {
            failures += 1;
          },
        },
        clock: { nowMs: () => OBSERVED_AT_MS },
      });
      const result =
        service.executeClaimedRollover(execution());
      assert.deepEqual(result, decision(outcome));
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.evidence), true);
      assert.equal(failures, 0);
    }
  });

  test("records only the exact deterministic recovery decision and validates scheduled +2 output", () => {
    const calls = [];
    const service = create({ calls });
    const result = service.recordClaimedFailure({
      ...execution(),
      reasonCode: "boundary_recovery_required",
    });

    assert.deepEqual(result, recordedFailure());
    assert.deepEqual(calls, [
      ["find", identity()],
      ["clock"],
      [
        "failure",
        {
          ...identity(),
          expectedRolloverVersion: 5,
          failedAtMs: OBSERVED_AT_MS,
          reasonCode: "boundary_recovery_required",
          jobExecution: execution().jobExecution,
        },
      ],
    ]);
    assert.throws(
      () => service.recordClaimedFailure({
        ...execution(),
        reasonCode: "boundary_work_pending",
      }),
      (error) =>
        error instanceof FreeAgentDraftRolloverServiceError &&
        error.code ===
          FREE_AGENT_DRAFT_ROLLOVER_SERVICE_CODES.inputInvalid &&
        error.reasonCode === "failure_reason_invalid"
    );
  });

  test("records a repeated T142 failure with +1 and no duplicate extension", () => {
    const retryExecution = execution({
      jobExecution: {
        expectedVersion: 10,
        attemptCount: 2,
      },
    });
    const result = create({
      projection: liveProjection({
        status: "recovery_required",
        rolloverVersion: 8,
        jobRunVersion: 10,
        sourceRecoveryId: IDS.recovery,
        sourceRecoveryStatus: "running",
        sourceRecoveryVersion: 4,
      }),
      failureResult: recordedFailure({
        rolloverVersion: 9,
        jobRunVersion: 11,
        extensionRolloverId: null,
        extensionJobRunId: null,
      }),
    }).recordClaimedFailure({
      ...retryExecution,
      reasonCode: "boundary_recovery_required",
    });

    assert.deepEqual(
      result,
      recordedFailure({
        rolloverVersion: 9,
        jobRunVersion: 11,
        extensionRolloverId: null,
        extensionJobRunId: null,
      })
    );
  });

  test("propagates the writer's transactional policy conflict instead of reporting a recovery", () => {
    const policyConflict = Object.assign(
      new Error("persisted boundary is not recovery-required"),
      {
        code: "SQLITE_REPOSITORY_VERSION_CONFLICT",
        details: Object.freeze({
          reasonCode: "FAILURE_DECISION_CHANGED",
        }),
      }
    );
    let failureWrites = 0;
    const service = createFreeAgentDraftRolloverService({
      writer: {
        findFinalization: () => liveProjection(),
        executeClaimed() {},
        recordFailure() {
          failureWrites += 1;
          throw policyConflict;
        },
      },
      clock: { nowMs: () => OBSERVED_AT_MS },
    });

    assert.throws(
      () => service.recordClaimedFailure({
        ...execution(),
        reasonCode: "boundary_recovery_required",
      }),
      (error) => error === policyConflict
    );
    assert.equal(failureWrites, 1);
  });

  test("returns validated completed and failure replays without a second mutation", () => {
    let writes = 0;
    const completedReplay = completed({ replayed: true });
    const completionService =
      createFreeAgentDraftRolloverService({
        writer: {
          findFinalization: () => completedReplay,
          executeClaimed() {
            writes += 1;
          },
          recordFailure() {},
        },
        clock: { nowMs: () => OBSERVED_AT_MS + 1 },
      });
    assert.deepEqual(
      completionService.executeClaimedRollover(execution()),
      completedReplay
    );

    const failureReplay = recordedFailure({ replayed: true });
    const failureService = createFreeAgentDraftRolloverService({
      writer: {
        findFinalization: () => failureReplay,
        executeClaimed() {},
        recordFailure() {
          writes += 1;
        },
      },
      clock: { nowMs: () => OBSERVED_AT_MS + 1 },
    });
    assert.deepEqual(
      failureService.recordClaimedFailure({
        ...execution(),
        reasonCode: "boundary_recovery_required",
      }),
      failureReplay
    );
    assert.equal(writes, 0);
  });

  test("rejects malformed scope, stale leases, wrong projections, and wrong version deltas", () => {
    assert.throws(
      () => create().executeClaimedRollover({
        ...execution(),
        extra: true,
      }),
      (error) =>
        error.code ===
        FREE_AGENT_DRAFT_ROLLOVER_SERVICE_CODES.inputInvalid
    );
    assert.throws(
      () => create({ nowMs: LEASE_EXPIRES_AT_MS })
        .executeClaimedRollover(execution()),
      (error) => error.reasonCode === "claimed_lease_expired"
    );
    assert.throws(
      () => create({
        projection: liveProjection({
          sourceRecoveryId: IDS.recovery,
        }),
      }).executeClaimedRollover(execution()),
      (error) => error.reasonCode === "finalization_state_invalid"
    );
    assert.throws(
      () => create({
        executeResult: completed({ rolloverVersion: 6 }),
      }).executeClaimedRollover(execution()),
      (error) => error.reasonCode === "terminal_result_invalid"
    );
    assert.throws(
      () => create({
        failureResult: recordedFailure({
          extensionJobRunId: null,
        }),
      }).recordClaimedFailure({
        ...execution(),
        reasonCode: "boundary_recovery_required",
      }),
      (error) => error.reasonCode === "failure_result_invalid"
    );
  });

  test("requires synchronous writer projections and all construction collaborators", () => {
    assert.throws(
      () => createFreeAgentDraftRolloverService(),
      /atomic writer/
    );
    assert.throws(
      () => createFreeAgentDraftRolloverService({
        writer: {
          findFinalization() {},
          executeClaimed() {},
          recordFailure() {},
        },
      }),
      /UTC clock/
    );
    const service = createFreeAgentDraftRolloverService({
      writer: {
        findFinalization: () =>
          Promise.resolve(liveProjection()),
        executeClaimed() {},
        recordFailure() {},
      },
      clock: { nowMs: () => OBSERVED_AT_MS },
    });
    assert.throws(
      () => service.executeClaimedRollover(execution()),
      (error) => error.reasonCode === "writer_must_be_synchronous"
    );
  });
});
