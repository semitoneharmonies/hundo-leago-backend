"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRolloverWriter"
);
const {
  DEFAULT_LEASE_MS,
  FREE_AGENT_DRAFT_ROLLOVER_JOB_TYPE,
  JOB_NAME,
  createFinalizeFreeAgentDraftRolloversJob,
} = require(
  "../../src/jobs/definitions/finalizeFreeAgentDraftRollovers"
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
  ensuredJob: uuid(10),
});
const SEQUENCE = 7;
const ROLLOVER_AT_MS = 10_000;
const ENSURED_AT_MS = 10_050;
const LISTED_AT_MS = 10_100;
const CLAIMED_AT_MS = 10_200;
const LEASE_OWNER = "fad-rollover-finalizer";
const OCCURRENCE_KEY =
  buildFreeAgentDraftRolloverOccurrenceKey({
    fadId: IDS.fad,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
  });

function descriptor(overrides = {}) {
  const base = {
    runId: IDS.run,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    jobType: FREE_AGENT_DRAFT_ROLLOVER_JOB_TYPE,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: ROLLOVER_AT_MS,
    status: "pending",
    attemptCount: 0,
    nextAttemptAtMs: null,
    leaseExpiresAtMs: null,
    startedAtMs: null,
    completedAtMs: null,
    resultJson: null,
    lastErrorCode: null,
    version: 1,
    parsedOccurrence: {
      type: "rollover",
      fadId: IDS.fad,
      sequence: SEQUENCE,
      rolloverAtMs: ROLLOVER_AT_MS,
    },
    binding: {
      type: "rollover",
      resourceType: "rollover",
      resourceId: IDS.rollover,
      fadId: IDS.fad,
      rolloverId: IDS.rollover,
      sequence: SEQUENCE,
      rolloverAtMs: ROLLOVER_AT_MS,
    },
  };
  return { ...base, ...overrides };
}

function claimed(due, command) {
  return {
    ...due,
    status: "running",
    attemptCount: due.attemptCount + 1,
    nextAttemptAtMs: null,
    leaseExpiresAtMs: command.leaseExpiresAtMs,
    startedAtMs: command.nowMs,
    completedAtMs: null,
    resultJson: null,
    lastErrorCode: null,
    version: due.version + 1,
  };
}

function ensured(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    rolloverId: IDS.rollover,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    jobRunId: IDS.ensuredJob,
    createdAtMs: ENSURED_AT_MS,
    ...overrides,
  };
}

function evidence(overrides = {}) {
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

function completed(command, overrides = {}) {
  return {
    outcome: "completed",
    replayed: false,
    leagueId: command.leagueId,
    seasonId: command.seasonId,
    fadId: command.fadId,
    rolloverId: command.rolloverId,
    sequence: command.sequence,
    rolloverAtMs: command.rolloverAtMs,
    finalizedAtMs: command.jobExecution.startedAtMs + 1,
    rolloverVersion: 7,
    jobRunId: command.jobExecution.runId,
    jobRunVersion: command.jobExecution.expectedVersion + 1,
    sourceRecoveryId: null,
    evidence: {
      reasonCode: "boundary_accounted",
      ...evidence(),
    },
    ...overrides,
  };
}

function decision(command, outcome) {
  const recovery = outcome === "recovery_required";
  return {
    rolloverId: command.rolloverId,
    fadId: command.fadId,
    sequence: command.sequence,
    rolloverAtMs: command.rolloverAtMs,
    outcome,
    reasonCode: recovery
      ? "boundary_recovery_required"
      : "boundary_work_pending",
    evidence: evidence({
      unresolvedCount: 2,
      recoverableUnresolvedCount: recovery ? 2 : 1,
    }),
    replayed: false,
  };
}

function failure(command, overrides = {}) {
  return {
    outcome: "failure_recorded",
    replayed: false,
    leagueId: command.leagueId,
    seasonId: command.seasonId,
    fadId: command.fadId,
    rolloverId: command.rolloverId,
    sequence: command.sequence,
    rolloverAtMs: command.rolloverAtMs,
    failedAtMs: command.jobExecution.startedAtMs + 2,
    rolloverVersion: 7,
    jobRunId: command.jobExecution.runId,
    jobRunVersion: command.jobExecution.expectedVersion + 1,
    recoveryId: IDS.recovery,
    extensionRolloverId: IDS.extension,
    extensionJobRunId: IDS.extensionJob,
    failureCode: FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
    ...overrides,
  };
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

function completedReplay(overrides = {}) {
  const command = {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    rolloverId: IDS.rollover,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
    jobExecution: {
      runId: IDS.run,
      expectedVersion: 2,
      startedAtMs: CLAIMED_AT_MS,
    },
  };
  return completed(command, {
    replayed: true,
    jobRunVersion: 3,
    ...overrides,
  });
}

function failureReplay(overrides = {}) {
  const command = {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    rolloverId: IDS.rollover,
    sequence: SEQUENCE,
    rolloverAtMs: ROLLOVER_AT_MS,
    jobExecution: {
      runId: IDS.run,
      expectedVersion: 2,
      startedAtMs: CLAIMED_AT_MS,
    },
  };
  return failure(command, {
    replayed: true,
    jobRunVersion: 3,
    ...overrides,
  });
}

function harness({
  due = [descriptor()],
  ensuredJobs = [],
  ensureImplementation,
  listImplementation,
  claimImplementation,
  executeImplementation,
  failureImplementation,
  findImplementation,
  clockValues = [
    ENSURED_AT_MS,
    LISTED_AT_MS,
    CLAIMED_AT_MS,
  ],
  leaseTokens = [IDS.lease],
  batchSize,
} = {}) {
  const calls = [];
  const logs = [];
  let clockIndex = 0;
  let leaseIndex = 0;
  const writer = {
    ensurePendingJobs(command) {
      calls.push(["ensure", command]);
      if (ensureImplementation) {
        return ensureImplementation(command, calls);
      }
      return ensuredJobs;
    },
    findFinalization(command) {
      calls.push(["find", command]);
      if (findImplementation) {
        return findImplementation(command, calls);
      }
      return liveProjection();
    },
  };
  const repository = {
    listDue(command) {
      calls.push(["list", command]);
      if (listImplementation) {
        return listImplementation(command, calls);
      }
      return due;
    },
    claim(command) {
      calls.push(["claim", command]);
      if (claimImplementation) {
        return claimImplementation(command, calls);
      }
      const source = due.find(
        ({ runId }) => runId === command.runId
      );
      return {
        acquired: true,
        occurrence: claimed(source, command),
      };
    },
  };
  const rolloverService = {
    async executeClaimedRollover(command) {
      calls.push(["execute", command]);
      if (executeImplementation) {
        return executeImplementation(command, calls);
      }
      return completed(command);
    },
    async recordClaimedFailure(command) {
      calls.push(["failure", command]);
      if (failureImplementation) {
        return failureImplementation(command, calls);
      }
      return failure(command);
    },
  };
  const job = createFinalizeFreeAgentDraftRolloversJob({
    writer,
    repository,
    rolloverService,
    clock: {
      nowMs() {
        const value = clockValues[clockIndex];
        clockIndex += 1;
        return value;
      },
    },
    secureRandom: {
      id() {
        const value = leaseTokens[leaseIndex];
        leaseIndex += 1;
        return value;
      },
    },
    leaseOwner: LEASE_OWNER,
    batchSize,
    logger: {
      error(event, metadata) {
        logs.push([event, metadata]);
      },
    },
  });
  return { calls, job, logs };
}

function summary(overrides = {}) {
  return {
    job: JOB_NAME,
    status: "succeeded",
    ensured: 0,
    due: 1,
    acquired: 1,
    succeeded: 1,
    recoveryRequired: 0,
    awaitingData: 0,
    transientFailed: 0,
    skipped: 0,
    ...overrides,
  };
}

describe("Free Agent Draft rollover finalization job foundation", () => {
  test("ensures rollover jobs before listing, filters the shared queue, claims, and completes", async () => {
    const ordinary = { jobType: "auction_resolution" };
    const { calls, job, logs } = harness({
      due: [ordinary, descriptor()],
      ensuredJobs: [ensured()],
      batchSize: 12,
    });

    assert.deepEqual(
      await job.run(),
      summary({ ensured: 1 })
    );
    assert.deepEqual(calls[0], [
      "ensure",
      { ensuredAtMs: ENSURED_AT_MS, limit: 12 },
    ]);
    assert.deepEqual(calls[1], [
      "list",
      { nowMs: LISTED_AT_MS, limit: 12 },
    ]);
    assert.equal(calls[2][0], "claim");
    assert.equal(calls[3][0], "execute");
    assert.deepEqual(calls[3][1], {
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
        leaseOwner: LEASE_OWNER,
        leaseToken: IDS.lease,
        leaseExpiresAtMs:
          CLAIMED_AT_MS + DEFAULT_LEASE_MS,
        startedAtMs: CLAIMED_AT_MS,
        attemptCount: 1,
      },
    });
    assert.deepEqual(logs, []);
  });

  test("reports awaiting data without manufacturing a durable failure", async () => {
    const { calls, job, logs } = harness({
      executeImplementation(command) {
        return decision(command, "awaiting_data");
      },
    });
    assert.deepEqual(
      await job.run(),
      summary({
        succeeded: 0,
        awaitingData: 1,
      })
    );
    assert.equal(
      calls.some(([method]) => method === "failure"),
      false
    );
    assert.deepEqual(logs, []);
  });

  test("records only an exact recovery-required policy result and returns the safe identifier log", async () => {
    const { calls, job, logs } = harness({
      executeImplementation(command) {
        return decision(command, "recovery_required");
      },
    });
    assert.deepEqual(
      await job.run(),
      summary({
        status: "failed",
        succeeded: 0,
        recoveryRequired: 1,
      })
    );
    const failureCall = calls.find(
      ([method]) => method === "failure"
    );
    assert.equal(
      failureCall[1].reasonCode,
      "boundary_recovery_required"
    );
    assert.deepEqual(logs, [[
      "free_agent_draft.rollover_finalization_occurrence_failed",
      {
        job: JOB_NAME,
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        rolloverId: IDS.rollover,
        jobRunId: IDS.run,
        classification: "recovery_recorded",
        failureRecorded: true,
      },
    ]]);
  });

  test("classifies thrown or malformed execution as transient and never records it", async () => {
    for (const executeImplementation of [
      () => {
        throw Object.assign(new Error("private detail"), {
          code: "PRIVATE_VALUE_999",
        });
      },
      (command) => ({
        ...decision(command, "recovery_required"),
        reasonCode: "boundary_work_pending",
      }),
    ]) {
      const { calls, job, logs } = harness({
        executeImplementation,
      });
      assert.deepEqual(
        await job.run(),
        summary({
          status: "failed",
          succeeded: 0,
          transientFailed: 1,
        })
      );
      assert.equal(
        calls.some(([method]) => method === "failure"),
        false
      );
      assert.equal(logs.length, 1);
      assert.equal(
        JSON.stringify(logs).includes("PRIVATE_VALUE_999"),
        false
      );
      assert.deepEqual(
        Object.keys(logs[0][1]).sort(),
        [
          "classification",
          "fadId",
          "failureRecorded",
          "job",
          "jobRunId",
          "leagueId",
          "rolloverId",
          "seasonId",
        ].sort()
      );
    }
  });

  test("validates acquired-false completion and failure replays through the writer", async () => {
    for (const [projection, expected] of [
      [
        completedReplay(),
        summary({ acquired: 0 }),
      ],
      [
        failureReplay(),
        summary({
          status: "failed",
          acquired: 0,
          succeeded: 0,
          recoveryRequired: 1,
        }),
      ],
    ]) {
      const { calls, job } = harness({
        claimImplementation: () => ({
          acquired: false,
          occurrence: null,
        }),
        findImplementation: () => projection,
      });
      assert.deepEqual(await job.run(), expected);
      assert.equal(
        calls.some(([method]) => method === "find"),
        true
      );
      assert.equal(
        calls.some(([method]) => method === "execute"),
        false
      );
    }
  });

  test("validates acquired-false live state before counting a skip", async () => {
    const { calls, job } = harness({
      claimImplementation: () => ({
        acquired: false,
        occurrence: null,
      }),
      findImplementation: () => liveProjection(),
    });
    assert.deepEqual(
      await job.run(),
      summary({
        acquired: 0,
        succeeded: 0,
        skipped: 1,
      })
    );
    assert.deepEqual(
      calls.find(([method]) => method === "find")[1],
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        rolloverId: IDS.rollover,
        sequence: SEQUENCE,
        rolloverAtMs: ROLLOVER_AT_MS,
        occurrenceKey: OCCURRENCE_KEY,
      }
    );
  });

  test("fails discovery safely when ensuring or listing cannot be proven", async () => {
    const ensureFailure = harness({
      ensureImplementation() {
        throw new Error("private ensure failure");
      },
    });
    assert.deepEqual(
      await ensureFailure.job.run(),
      summary({
        status: "failed",
        due: 0,
        acquired: 0,
        succeeded: 0,
        transientFailed: 1,
      })
    );
    assert.equal(
      ensureFailure.calls.some(([method]) => method === "list"),
      false
    );

    const malformedEnsure = harness({
      ensuredJobs: [ensured({ createdAtMs: ENSURED_AT_MS + 1 })],
    });
    assert.equal(
      (await malformedEnsure.job.run()).status,
      "failed"
    );

    const listFailure = harness({
      listImplementation: () => ({ not: "an array" }),
    });
    assert.equal((await listFailure.job.run()).status, "failed");
  });

  test("isolates malformed claims and recovery-recording failures as transient", async () => {
    const malformedClaim = harness({
      claimImplementation(command) {
        return {
          acquired: true,
          occurrence: claimed(descriptor(), {
            ...command,
            leaseExpiresAtMs: command.leaseExpiresAtMs + 1,
          }),
        };
      },
    });
    assert.deepEqual(
      await malformedClaim.job.run(),
      summary({
        status: "failed",
        acquired: 1,
        succeeded: 0,
        transientFailed: 1,
      })
    );

    const recordingFailure = harness({
      executeImplementation(command) {
        return decision(command, "recovery_required");
      },
      failureImplementation() {
        return { private: "malformed" };
      },
    });
    assert.deepEqual(
      await recordingFailure.job.run(),
      summary({
        status: "failed",
        succeeded: 0,
        transientFailed: 1,
      })
    );
  });

  test("requires every collaborator and bounded runner configuration", () => {
    assert.throws(
      () => createFinalizeFreeAgentDraftRolloversJob(),
      /ensurePendingJobs/
    );
    const base = {
      writer: {
        ensurePendingJobs() {},
        findFinalization() {},
      },
      repository: { listDue() {}, claim() {} },
      rolloverService: {
        executeClaimedRollover() {},
        recordClaimedFailure() {},
      },
      clock: { nowMs() {} },
      secureRandom: { id() {} },
      leaseOwner: LEASE_OWNER,
      logger: { error() {} },
    };
    assert.throws(
      () => createFinalizeFreeAgentDraftRolloversJob({
        ...base,
        batchSize: 101,
      }),
      /configuration is invalid/
    );
    assert.throws(
      () => createFinalizeFreeAgentDraftRolloversJob({
        ...base,
        leaseOwner: " bad ",
      }),
      /configuration is invalid/
    );
  });
});
