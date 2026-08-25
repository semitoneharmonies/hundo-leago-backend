"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftAllocationOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createProcessFreeAgentDraftAllocationsJob,
} = require(
  "../../src/jobs/definitions/processFreeAgentDraftAllocations"
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
  leaseOne: uuid(90),
  leaseTwo: uuid(91),
});
const SCHEDULED_FOR_MS = 10_000;
const LISTED_AT_MS = 10_100;
const CLAIMED_AT_MS = 10_200;
const LEASE_OWNER = "fad-allocation-runner";

function descriptor(index = 1, overrides = {}) {
  const runId = uuid(10 + index);
  const allocationId = uuid(20 + index);
  const playerId = uuid(30 + index);
  const occurrenceKey =
    buildFreeAgentDraftAllocationOccurrenceKey({
      fadId: IDS.fad,
      playerId,
    });
  const base = {
    runId,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    jobType: "fad_allocation",
    occurrenceKey,
    scheduledForMs: SCHEDULED_FOR_MS,
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
      type: "allocate",
      fadId: IDS.fad,
      playerId,
    },
    binding: {
      type: "allocate",
      resourceType: "allocation",
      resourceId: allocationId,
      fadId: IDS.fad,
      playerId,
      allocationId,
    },
  };
  return {
    ...base,
    ...overrides,
  };
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

function terminal(command, overrides = {}) {
  return {
    leagueId: command.leagueId,
    seasonId: command.seasonId,
    fadId: command.fadId,
    allocationId: command.allocationId,
    playerId: command.playerId,
    occurrenceKey: command.occurrenceKey,
    status: "no_valid_offer",
    jobRunId: command.jobExecution.runId,
    jobRunVersion:
      command.jobExecution.expectedVersion + 1,
    ...overrides,
  };
}

function harness({
  due = [descriptor()],
  claimImplementation,
  serviceImplementation,
  clockValues = [LISTED_AT_MS, CLAIMED_AT_MS],
  leaseTokens = [IDS.leaseOne, IDS.leaseTwo],
} = {}) {
  const calls = [];
  let clockIndex = 0;
  let tokenIndex = 0;
  const repository = {
    listDue(command) {
      calls.push(["list", command]);
      return due;
    },
    claim(command) {
      calls.push(["claim", command]);
      if (claimImplementation) {
        return claimImplementation(command, due);
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
  const allocationService = {
    async executeClaimedAllocation(command) {
      calls.push(["execute", command]);
      if (serviceImplementation) {
        return serviceImplementation(command);
      }
      return terminal(command);
    },
  };
  const job = createProcessFreeAgentDraftAllocationsJob({
    repository,
    allocationService,
    clock: {
      nowMs() {
        const value =
          clockValues[
            Math.min(
              clockIndex,
              clockValues.length - 1
            )
          ];
        clockIndex += 1;
        return value;
      },
    },
    secureRandom: {
      id() {
        const value =
          leaseTokens[
            Math.min(
              tokenIndex,
              leaseTokens.length - 1
            )
          ];
        tokenIndex += 1;
        calls.push(["id", value]);
        return value;
      },
    },
    leaseOwner: LEASE_OWNER,
    logger: {
      error(...input) {
        calls.push(["error", input]);
      },
    },
  });
  return { calls, job };
}

function expectedSummary(overrides = {}) {
  return {
    job: JOB_NAME,
    status: "succeeded",
    due: 1,
    acquired: 1,
    succeeded: 1,
    correctionRequired: 0,
    failed: 0,
    skipped: 0,
    ...overrides,
  };
}

describe("FAD Candidate allocation scheduled job", () => {
  test("filters other work and forwards the exact claimed allocation witness", async () => {
    const other = {
      jobType: "fad_rollover",
      malformedForAllocation: true,
    };
    const allocationDue = descriptor();
    const { calls, job } = harness({
      due: [other, allocationDue],
    });

    assert.deepEqual(
      await job.run(),
      expectedSummary()
    );
    const claim = calls.find(
      ([name]) => name === "claim"
    )[1];
    assert.deepEqual(claim, {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      runId: allocationDue.runId,
      jobType: "fad_allocation",
      occurrenceKey:
        allocationDue.occurrenceKey,
      scheduledForMs: SCHEDULED_FOR_MS,
      expectedVersion: 1,
      leaseOwner: LEASE_OWNER,
      leaseToken: IDS.leaseOne,
      nowMs: CLAIMED_AT_MS,
      leaseExpiresAtMs:
        CLAIMED_AT_MS + DEFAULT_LEASE_MS,
    });
    const execution = calls.find(
      ([name]) => name === "execute"
    )[1];
    assert.deepEqual(execution, {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      allocationId:
        allocationDue.binding.allocationId,
      playerId: allocationDue.binding.playerId,
      occurrenceKey:
        allocationDue.occurrenceKey,
      scheduledForMs: SCHEDULED_FOR_MS,
      jobExecution: {
        runId: allocationDue.runId,
        leaseOwner: LEASE_OWNER,
        leaseToken: IDS.leaseOne,
        leaseExpiresAtMs:
          CLAIMED_AT_MS + DEFAULT_LEASE_MS,
        startedAtMs: CLAIMED_AT_MS,
        attemptCount: 1,
        expectedVersion: 2,
      },
    });
  });

  test("skips a stale compare-and-set claim without executing", async () => {
    const only = descriptor();
    const { calls, job } = harness({
      due: [only],
      claimImplementation() {
        return {
          acquired: false,
          occurrence: only,
        };
      },
    });

    assert.deepEqual(
      await job.run(),
      expectedSummary({
        acquired: 0,
        succeeded: 0,
        skipped: 1,
      })
    );
    assert.equal(
      calls.some(([name]) => name === "execute"),
      false
    );
  });

  test("continues with a second player when the first claimed execution fails", async () => {
    const first = descriptor(1);
    const second = descriptor(2);
    const failure = new Error("allocation storage failed");
    let executions = 0;
    const { calls, job } = harness({
      due: [first, second],
      clockValues: [
        LISTED_AT_MS,
        CLAIMED_AT_MS,
        CLAIMED_AT_MS + 1,
      ],
      serviceImplementation(command) {
        executions += 1;
        if (executions === 1) throw failure;
        return terminal(command);
      },
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "failed",
      due: 2,
      acquired: 2,
      succeeded: 1,
      correctionRequired: 0,
      failed: 1,
      skipped: 0,
    });
    assert.equal(
      calls.filter(([name]) => name === "execute")
        .length,
      2
    );
    const logged = calls.find(
      ([name]) => name === "error"
    );
    assert.equal(
      logged[1][0],
      "free_agent_draft.allocation_occurrence_failed"
    );
    assert.deepEqual(logged[1][1], {
      job: JOB_NAME,
      runId: first.runId,
      fadId: first.fadId,
      allocationId: first.binding.allocationId,
      classification: "transient",
    });
    assert.equal(
      calls.some(([name]) => name === "fail"),
      false
    );
  });

  test("counts a durable correction-required result without failing the runner", async () => {
    const { job } = harness({
      serviceImplementation(command) {
        return terminal(command, {
          status: "correction_required",
        });
      },
    });

    assert.deepEqual(
      await job.run(),
      expectedSummary({
        succeeded: 0,
        correctionRequired: 1,
      })
    );
  });

  test("fails closed on malformed allocation binding before any claim", async () => {
    const canonical = descriptor();
    const malformed = {
      ...canonical,
      binding: {
        ...canonical.binding,
        allocationId: uuid(999),
      },
    };
    const { calls, job } = harness({
      due: [malformed],
      clockValues: [LISTED_AT_MS],
    });

    const result = await job.run();
    assert.equal(result.status, "failed");
    assert.deepEqual(
      calls.map(([name]) => name),
      ["list", "error"]
    );
  });

  test("leaves an expired claimed execution for lease reclaim and continues", async () => {
    const first = descriptor(1);
    const second = descriptor(2);
    const expired = new Error("claimed_lease_expired");
    let executions = 0;
    const { calls, job } = harness({
      due: [first, second],
      clockValues: [
        LISTED_AT_MS,
        CLAIMED_AT_MS,
        CLAIMED_AT_MS + 1,
      ],
      serviceImplementation(command) {
        executions += 1;
        if (executions === 1) throw expired;
        return terminal(command);
      },
    });

    const result = await job.run();
    assert.equal(result.status, "failed");
    assert.equal(result.failed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(
      calls.filter(([name]) => name === "claim")
        .length,
      2
    );
    assert.equal(
      calls.some(([name]) => name === "fail"),
      false
    );
  });

  test("rejects an invalid claimed lease witness and an unsafe token", async () => {
    const mismatched = harness({
      claimImplementation(command, due) {
        return {
          acquired: true,
          occurrence: {
            ...claimed(due[0], command),
            leaseExpiresAtMs: command.nowMs,
          },
        };
      },
    });
    const mismatchResult =
      await mismatched.job.run();
    assert.equal(mismatchResult.status, "failed");
    assert.equal(mismatchResult.acquired, 1);
    assert.equal(
      mismatched.calls.some(
        ([name]) => name === "execute"
      ),
      false
    );

    const unsafeToken = harness({
      leaseTokens: [" unsafe "],
    });
    const unsafeResult =
      await unsafeToken.job.run();
    assert.equal(unsafeResult.status, "failed");
    assert.equal(unsafeResult.acquired, 0);
    assert.equal(
      unsafeToken.calls.some(
        ([name]) => name === "claim"
      ),
      false
    );
  });

  test("validates dependencies and bounded runner configuration", () => {
    assert.throws(
      () => createProcessFreeAgentDraftAllocationsJob(),
      /listDue/
    );
    assert.throws(
      () =>
        createProcessFreeAgentDraftAllocationsJob({
          repository: { listDue() {}, claim() {} },
          allocationService: {
            executeClaimedAllocation() {},
          },
          clock: { nowMs() {} },
          secureRandom: { id() {} },
          leaseOwner: "",
          logger: { error() {} },
        }),
      /configuration/
    );
    assert.throws(
      () =>
        createProcessFreeAgentDraftAllocationsJob({
          repository: { listDue() {}, claim() {} },
          allocationService: {
            executeClaimedAllocation() {},
          },
          clock: { nowMs() {} },
          secureRandom: { id() {} },
          leaseOwner: LEASE_OWNER,
          batchSize: 101,
          logger: { error() {} },
        }),
      /configuration/
    );
  });
});
