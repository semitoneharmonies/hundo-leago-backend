const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftDeadlineOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createProcessFreeAgentDraftDeadlinesJob,
} = require(
  "../../src/jobs/definitions/processFreeAgentDraftDeadlines"
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
  run: uuid(4),
  leaseToken: uuid(5),
});
const DEADLINE_AT_MS = 40_000;
const LISTED_AT_MS = 40_100;
const CLAIMED_AT_MS = 40_200;
const LEASE_OWNER = "fad-deadline-runner";
const OCCURRENCE_KEY =
  buildFreeAgentDraftDeadlineOccurrenceKey({
    fadId: IDS.fad,
    deadlineAtMs: DEADLINE_AT_MS,
  });

function descriptor(overrides = {}) {
  const base = {
    runId: IDS.run,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    jobType: "fad_deadline",
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: DEADLINE_AT_MS,
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
      type: "deadline",
      fadId: IDS.fad,
      deadlineAtMs: DEADLINE_AT_MS,
    },
    binding: {
      type: "deadline",
      resourceType: "free_agent_draft",
      resourceId: IDS.fad,
      fadId: IDS.fad,
      deadlineAtMs: DEADLINE_AT_MS,
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
    leaseExpiresAtMs: command.leaseExpiresAtMs,
    startedAtMs: command.nowMs,
    version: due.version + 1,
  };
}

function harness({
  due = [descriptor()],
  claimImplementation,
  serviceImplementation,
  clockValues = [LISTED_AT_MS, CLAIMED_AT_MS],
} = {}) {
  const calls = [];
  let clockIndex = 0;
  const repository = {
    listDue(input) {
      calls.push(["list", input]);
      return due;
    },
    claim(command) {
      calls.push(["claim", command]);
      if (claimImplementation) {
        return claimImplementation(command);
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
  const deadlineService = {
    async executeClaimedDeadline(command) {
      calls.push(["execute", command]);
      if (serviceImplementation) {
        return serviceImplementation(command);
      }
      return {
        outcome: "succeeded",
        runId: command.jobExecution.runId,
      };
    },
  };
  const job = createProcessFreeAgentDraftDeadlinesJob({
    repository,
    deadlineService,
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
        calls.push(["id", IDS.leaseToken]);
        return IDS.leaseToken;
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

describe("FAD deadline scheduled job", () => {
  test("filters other FAD work and executes an exact claimed deadline witness", async () => {
    const other = {
      ...descriptor({ runId: uuid(99) }),
      jobType: "fad_rollover",
    };
    const { calls, job } = harness({
      due: [other, descriptor()],
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "succeeded",
      due: 1,
      acquired: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    const claim = calls.find(
      ([name]) => name === "claim"
    )[1];
    assert.deepEqual(claim, {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      runId: IDS.run,
      jobType: "fad_deadline",
      occurrenceKey: OCCURRENCE_KEY,
      scheduledForMs: DEADLINE_AT_MS,
      expectedVersion: 1,
      leaseOwner: LEASE_OWNER,
      leaseToken: IDS.leaseToken,
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
      deadlineAtMs: DEADLINE_AT_MS,
      occurrenceKey: OCCURRENCE_KEY,
      scheduledForMs: DEADLINE_AT_MS,
      jobExecution: {
        runId: IDS.run,
        leaseOwner: LEASE_OWNER,
        leaseToken: IDS.leaseToken,
        leaseExpiresAtMs:
          CLAIMED_AT_MS + DEFAULT_LEASE_MS,
        startedAtMs: CLAIMED_AT_MS,
        attemptCount: 1,
        expectedVersion: 2,
      },
    });
  });

  test("skips a deadline whose compare-and-set claim was not acquired", async () => {
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

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "succeeded",
      due: 1,
      acquired: 0,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });
    assert.equal(
      calls.some(([name]) => name === "execute"),
      false
    );
  });

  test("leaves failed claimed work for lease reclaim", async () => {
    const failure = new Error("deadline storage failed");
    const { calls, job } = harness({
      serviceImplementation() {
        throw failure;
      },
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "failed",
      due: 1,
      acquired: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });
    const logged = calls.find(
      ([name]) => name === "error"
    );
    assert.deepEqual(logged[1], [
      "free_agent_draft.deadline_occurrence_failed",
      {
        job: JOB_NAME,
        runId: IDS.run,
        fadId: IDS.fad,
        classification: "transient",
      },
    ]);
    assert.equal(
      calls.some(([name]) => name === "fail"),
      false
    );
  });

  test("fails closed before lease allocation for a tampered binding", async () => {
    const malformed = descriptor({
      binding: {
        ...descriptor().binding,
        deadlineAtMs: DEADLINE_AT_MS + 1,
      },
    });
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

  test("validates required runner collaborators and lease configuration", () => {
    assert.throws(
      () => createProcessFreeAgentDraftDeadlinesJob(),
      /listDue/
    );
    assert.throws(
      () =>
        createProcessFreeAgentDraftDeadlinesJob({
          repository: { listDue() {}, claim() {} },
          deadlineService: {
            executeClaimedDeadline() {},
          },
          clock: { nowMs() {} },
          secureRandom: { id() {} },
          leaseOwner: "",
          logger: { error() {} },
        }),
      /configuration/
    );
  });
});
