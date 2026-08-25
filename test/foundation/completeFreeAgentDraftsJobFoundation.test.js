"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftCompletionOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createCompleteFreeAgentDraftsJob,
} = require(
  "../../src/jobs/definitions/completeFreeAgentDrafts"
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
  recovery: uuid(6),
});
const INITIAL_WINDOW_ENDS_AT_MS = 40_000;
const LISTED_AT_MS = 40_100;
const CLAIMED_AT_MS = 40_200;
const LEASE_OWNER = "fad-completion-runner";
const OCCURRENCE_KEY =
  buildFreeAgentDraftCompletionOccurrenceKey({
    fadId: IDS.fad,
  });

function candidate(overrides = {}) {
  return {
    runId: IDS.run,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    jobType: "fad_completion",
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: INITIAL_WINDOW_ENDS_AT_MS,
    initialWindowEndsAtMs:
      INITIAL_WINDOW_ENDS_AT_MS,
    status: "pending",
    attemptCount: 0,
    nextAttemptAtMs: null,
    leaseExpiresAtMs: null,
    version: 1,
    ...overrides,
  };
}

function claimed(due, command) {
  return {
    runId: due.runId,
    leagueId: due.leagueId,
    seasonId: due.seasonId,
    fadId: due.fadId,
    jobType: due.jobType,
    occurrenceKey: due.occurrenceKey,
    scheduledForMs: due.scheduledForMs,
    status: "running",
    attemptCount: due.attemptCount + 1,
    nextAttemptAtMs: null,
    leaseExpiresAtMs: command.leaseExpiresAtMs,
    startedAtMs: command.nowMs,
    completedAtMs: null,
    resultJson: null,
    lastErrorCode: null,
    version: due.version + 1,
    parsedOccurrence: {
      type: "complete",
      fadId: due.fadId,
    },
    binding: {
      type: "complete",
      resourceType: "free_agent_draft",
      resourceId: due.fadId,
      fadId: due.fadId,
      initialWindowEndsAtMs:
        due.initialWindowEndsAtMs,
    },
  };
}

function harness({
  candidates = [candidate()],
  claimImplementation,
  serviceImplementation,
  failureImplementation,
  clockValues = [LISTED_AT_MS, CLAIMED_AT_MS],
} = {}) {
  const calls = [];
  let clockIndex = 0;
  const writer = {
    listCandidates(input) {
      calls.push(["list", input]);
      return candidates;
    },
  };
  const repository = {
    claim(command) {
      calls.push(["claim", command]);
      if (claimImplementation) {
        return claimImplementation(command);
      }
      const source = candidates.find(
        ({ runId }) => runId === command.runId
      );
      return {
        acquired: true,
        occurrence: claimed(source, command),
      };
    },
  };
  const completionService = {
    async executeClaimedCompletion(command) {
      calls.push(["execute", command]);
      if (serviceImplementation) {
        return serviceImplementation(command);
      }
      return {
        outcome: "succeeded",
        runId: command.jobExecution.runId,
      };
    },
    async recordClaimedFailure(command) {
      calls.push(["fail", command]);
      if (failureImplementation) {
        return failureImplementation(command);
      }
      return {
        recorded: true,
        replayed: false,
        runId: command.jobExecution.runId,
        failedAtMs: command.jobExecution.startedAtMs,
        errorCode: command.errorCode,
        jobVersion:
          command.jobExecution.expectedVersion + 1,
        recoveryId: IDS.recovery,
        recoveryVersion: 1,
      };
    },
  };
  const job = createCompleteFreeAgentDraftsJob({
    writer,
    repository,
    completionService,
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

describe("FAD completion scheduled job", () => {
  test("scans terminal candidates and executes an exact claimed completion witness", async () => {
    const { calls, job } = harness();

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "succeeded",
      due: 1,
      acquired: 1,
      succeeded: 1,
      failed: 0,
      terminalFailed: 0,
      transientFailed: 0,
      skipped: 0,
    });
    assert.deepEqual(calls[0], [
      "list",
      { nowMs: LISTED_AT_MS, limit: 25 },
    ]);
    const claim = calls.find(
      ([name]) => name === "claim"
    )[1];
    assert.deepEqual(claim, {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      runId: IDS.run,
      jobType: "fad_completion",
      occurrenceKey: OCCURRENCE_KEY,
      scheduledForMs: INITIAL_WINDOW_ENDS_AT_MS,
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
      initialWindowEndsAtMs:
        INITIAL_WINDOW_ENDS_AT_MS,
      occurrenceKey: OCCURRENCE_KEY,
      scheduledForMs: INITIAL_WINDOW_ENDS_AT_MS,
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

  test("skips a candidate whose compare-and-set claim was not acquired", async () => {
    const only = candidate();
    const { calls, job } = harness({
      candidates: [only],
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
      terminalFailed: 0,
      transientFailed: 0,
      skipped: 1,
    });
    assert.equal(
      calls.some(([name]) => name === "execute"),
      false
    );
  });

  test("leaves an unknown claimed-completion failure for transient lease reclaim and logs identifiers only", async () => {
    const failure = new Error("completion storage failed");
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
      terminalFailed: 0,
      transientFailed: 1,
      skipped: 0,
    });
    const logged = calls.find(
      ([name]) => name === "error"
    );
    assert.deepEqual(logged[1], [
      "free_agent_draft.completion_occurrence_failed",
      {
         job: JOB_NAME,
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        runId: IDS.run,
        classification: "transient_execution",
        failureRecorded: false,
      },
    ]);
    assert.equal(
      calls.some(([name]) => name === "fail"),
      false
    );
    assert.equal(
      JSON.stringify(logged).includes(failure.message),
      false
    );
  });

  test("records only an explicitly classified deterministic failure", async () => {
    const deterministic = new Error("private schedule detail");
    deterministic.details = {
      reasonCode: "SCHEDULE_RECOVERY_PLAN_INVALID",
    };
    const { calls, job } = harness({
      serviceImplementation() {
        throw deterministic;
      },
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "failed",
      due: 1,
      acquired: 1,
      succeeded: 0,
      failed: 1,
      terminalFailed: 1,
      transientFailed: 0,
      skipped: 0,
    });
    const failure = calls.find(([name]) => name === "fail")[1];
    assert.equal(
      failure.errorCode,
      "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID"
    );
    assert.deepEqual(
      calls.find(([name]) => name === "error")[1][1],
      {
        job: JOB_NAME,
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        runId: IDS.run,
        classification: "terminal_recorded",
        failureRecorded: true,
      }
    );
    assert.equal(
      JSON.stringify(calls).includes(deterministic.message),
      false
    );
  });

  test("treats deterministic failure-recording lease loss as transient", async () => {
    const deterministic = Object.assign(new Error("deterministic"), {
      reasonCode: "completion_monday_unavailable",
    });
    const { calls, job } = harness({
      serviceImplementation() {
        throw deterministic;
      },
      failureImplementation() {
        throw new Error("stale lease");
      },
    });

    const result = await job.run();
    assert.equal(result.terminalFailed, 0);
    assert.equal(result.transientFailed, 1);
    assert.equal(
      calls.find(([name]) => name === "error")[1][1]
        .classification,
      "terminal_recording_transient"
    );
  });

  test("rejects failed correction-held candidates with a null retry timestamp before claim", async () => {
    const { calls, job } = harness({
      candidates: [
        candidate({
          status: "failed",
          attemptCount: 1,
          nextAttemptAtMs: null,
        }),
      ],
      clockValues: [LISTED_AT_MS],
    });

    const result = await job.run();
    assert.equal(result.status, "failed");
    assert.deepEqual(
      calls.map(([name]) => name),
      ["list", "error"]
    );
    assert.equal(
      Object.hasOwn(calls[1][1][1], "error"),
      false
    );
  });

  test("fails closed before lease allocation for a tampered candidate", async () => {
    const malformed = candidate({
      initialWindowEndsAtMs:
        INITIAL_WINDOW_ENDS_AT_MS + 1,
    });
    const { calls, job } = harness({
      candidates: [malformed],
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
      () => createCompleteFreeAgentDraftsJob(),
      /listCandidates/
    );
    assert.throws(
      () =>
        createCompleteFreeAgentDraftsJob({
          writer: { listCandidates() {} },
          repository: { claim() {} },
          completionService: {
            executeClaimedCompletion() {},
            recordClaimedFailure() {},
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
