const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
} = require(
  "../../src/domain/leagues/leagueLifecycleTransitionPolicy"
);
const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
  buildSeasonRolloverOccurrenceKey,
} = require(
  "../../src/domain/leagues/seasonRolloverJobPolicy"
);
const {
  JOB_NAME,
  createExecuteScheduledEntryDraftRolloversJob,
  safeErrorCode,
} = require(
  "../../src/jobs/definitions/executeScheduledEntryDraftRollovers"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  targetSeason: uuid(2),
  entryDraft: uuid(3),
  occurrence: uuid(4),
  jobRun: uuid(5),
  leaseToken: uuid(6),
  rollover: uuid(7),
});
const SCHEDULED_FOR_MS =
  Date.parse("2027-07-15T16:00:00.000Z");
const NOW_MS = SCHEDULED_FOR_MS + 1_000;
const LEASE_OWNER = "rollover-worker-1";

function binding(overrides = {}) {
  const value = {
    leagueId: IDS.league,
    toSeasonId: IDS.targetSeason,
    entryDraftId: IDS.entryDraft,
    rolloverOccurrenceId:
      IDS.occurrence,
    scheduledForMs: SCHEDULED_FOR_MS,
    ...overrides,
  };
  return {
    ...value,
    occurrenceKey:
      value.occurrenceKey ??
      buildSeasonRolloverOccurrenceKey(
        value
      ),
  };
}

function harness({
  due = [binding()],
  claim = {
    acquired: true,
    runId: IDS.jobRun,
    version: 2,
  },
  serviceImplementation = async () => ({
    rolloverId: IDS.rollover,
    status: "succeeded",
  }),
  clockValues = [
    NOW_MS,
    NOW_MS + 10,
    NOW_MS + 20,
  ],
  leaseDurationMs,
  retryDelayMs,
} = {}) {
  const calls = [];
  let idIndex = 0;
  const generated = [IDS.leaseToken, uuid(20)];
  const repository = {
    listDueRolloverBindings(command) {
      calls.push(["list", command]);
      return due;
    },
    claimRun(command) {
      calls.push(["claim", command]);
      return claim;
    },
    succeedRun(command) {
      calls.push(["succeed", command]);
    },
    failRun(command) {
      calls.push(["fail", command]);
    },
  };
  const service = {
    async executeScheduledEntryDraftRollover(
      command
    ) {
      calls.push(["execute", command]);
      return serviceImplementation(command);
    },
  };
  let clockIndex = 0;
  const job =
    createExecuteScheduledEntryDraftRolloversJob({
      repository,
      leagueLifecycleTransitionService:
        service,
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
            generated[
              Math.min(
                idIndex,
                generated.length - 1
              )
            ];
          idIndex += 1;
          return value;
        },
      },
      leaseOwner: LEASE_OWNER,
      ...(leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs }),
      ...(retryDelayMs === undefined
        ? {}
        : { retryDelayMs }),
      logger: {
        error() {},
        info() {},
      },
    });
  return { calls, job };
}

describe(
  "T-037 scheduled Entry Draft rollover job",
  () => {
    test("claims and executes the persisted occurrence then completes its generic job run", async () => {
      const { calls, job } = harness();
      const result = await job.run();
      assert.deepEqual(result, {
        job: JOB_NAME,
        status: "succeeded",
        due: 1,
        acquired: 1,
        succeeded: 1,
        blocked: 0,
        failed: 0,
        skipped: 0,
      });
      const occurrenceKey =
        binding().occurrenceKey;
      assert.deepEqual(calls, [
        [
          "list",
          { nowMs: NOW_MS, limit: 25 },
        ],
        [
          "claim",
          {
            leagueId: IDS.league,
            seasonId: IDS.targetSeason,
            jobType:
              ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
            occurrenceKey,
            scheduledForMs:
              SCHEDULED_FOR_MS,
            leaseOwner: LEASE_OWNER,
            leaseToken: IDS.leaseToken,
            nowMs: NOW_MS,
            leaseExpiresAtMs:
              NOW_MS + 5 * 60 * 1000,
          },
        ],
        [
          "execute",
          {
            leagueId: IDS.league,
            input: {
              transitionType:
                EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
              entryDraftId:
                IDS.entryDraft,
              rolloverOccurrenceId:
                IDS.occurrence,
            },
            scheduledJob: {
              runId: IDS.jobRun,
              occurrenceKey,
              scheduledForMs:
                SCHEDULED_FOR_MS,
              leaseOwner: LEASE_OWNER,
              leaseToken: IDS.leaseToken,
              expectedVersion: 2,
            },
          },
        ],
        [
          "succeed",
          {
            leagueId: IDS.league,
            runId: IDS.jobRun,
            leaseOwner: LEASE_OWNER,
            leaseToken: IDS.leaseToken,
            expectedVersion: 2,
            completedAtMs: NOW_MS + 10,
            outcome: "succeeded",
            rolloverId: IDS.rollover,
          },
        ],
      ]);
    });

    test("completes a durably blocked occurrence without automatic retry", async () => {
      const { calls, job } = harness({
        serviceImplementation: async () => ({
          rolloverId: null,
          status: "blocked",
        }),
      });
      const result = await job.run();
      assert.deepEqual(result, {
        job: JOB_NAME,
        status: "succeeded",
        due: 1,
        acquired: 1,
        succeeded: 0,
        blocked: 1,
        failed: 0,
        skipped: 0,
      });
      assert.equal(
        calls.filter(
          ([name]) => name === "fail"
        ).length,
        0
      );
      assert.equal(
        calls.at(-1)[0],
        "succeed"
      );
      assert.equal(
        calls.at(-1)[1].outcome,
        "blocked"
      );
    });

    test("does not claim durable blockage when the service throws before returning terminal evidence", async () => {
      const { calls, job } = harness({
        serviceImplementation: async () => {
          throw Object.assign(
            new Error("not durably blocked"),
            {
              code:
                "SEASON_ROLLOVER_NOT_READY",
              reasonCode:
                "source_fad_not_terminal",
            }
          );
        },
      });
      const result = await job.run();
      assert.equal(result.status, "failed");
      assert.equal(result.blocked, 0);
      assert.equal(result.failed, 1);
      assert.equal(calls.at(-1)[0], "fail");
    });

    test("schedules a bounded retry for an unexpected failure", async () => {
      const { calls, job } = harness({
        serviceImplementation: async () => {
          throw Object.assign(
            new Error("temporary"),
            { code: "REPOSITORY_BUSY" }
          );
        },
      });
      const result = await job.run();
      assert.deepEqual(result, {
        job: JOB_NAME,
        status: "failed",
        due: 1,
        acquired: 1,
        succeeded: 0,
        blocked: 0,
        failed: 1,
        skipped: 0,
      });
      assert.equal(calls.at(-1)[0], "fail");
      assert.equal(
        calls.at(-1)[1].errorCode,
        "REPOSITORY_BUSY"
      );
      assert.equal(
        calls.at(-1)[1].nextAttemptAtMs,
        NOW_MS + 10 + 15 * 60 * 1000
      );
    });

    test("fails closed before a lease or retry timestamp can overflow", async () => {
      const leaseHarness = harness({
        clockValues: [
          Number.MAX_SAFE_INTEGER - 10,
        ],
        leaseDurationMs: 11,
      });
      const leaseResult =
        await leaseHarness.job.run();
      assert.equal(leaseResult.status, "failed");
      assert.deepEqual(
        leaseHarness.calls.map(([name]) => name),
        ["list"]
      );

      const retryHarness = harness({
        clockValues: [
          NOW_MS,
          Number.MAX_SAFE_INTEGER - 10,
        ],
        retryDelayMs: 11,
        serviceImplementation: async () => {
          throw new Error("temporary");
        },
      });
      const retryResult =
        await retryHarness.job.run();
      assert.equal(retryResult.status, "failed");
      assert.deepEqual(
        retryHarness.calls.map(([name]) => name),
        ["list", "claim", "execute"]
      );
    });

    test("skips an occurrence held by another lease and never calls the service", async () => {
      const { calls, job } = harness({
        claim: { acquired: false },
      });
      assert.deepEqual(await job.run(), {
        job: JOB_NAME,
        status: "succeeded",
        due: 1,
        acquired: 0,
        succeeded: 0,
        blocked: 0,
        failed: 0,
        skipped: 1,
      });
      assert.equal(
        calls.some(
          ([name]) => name === "execute"
        ),
        false
      );
    });

    test("fails closed before claim on a noncanonical persisted key", async () => {
      const { calls, job } = harness({
        due: [
          binding({
            occurrenceKey: "tampered",
          }),
        ],
      });
      const result = await job.run();
      assert.equal(result.job, JOB_NAME);
      assert.equal(result.status, "failed");
      assert.match(
        result.error?.message || "",
        /noncanonical occurrence key/
      );
      assert.deepEqual(
        calls.map(([name]) => name),
        ["list"]
      );
    });

    test("sanitizes unsafe error codes", () => {
      assert.equal(
        safeErrorCode({
          code: "repository failed privately",
        }),
        "SEASON_ROLLOVER_JOB_FAILED"
      );
      assert.equal(
        safeErrorCode({
          reasonCode: "SOURCE_FAD_NOT_TERMINAL",
        }),
        "SOURCE_FAD_NOT_TERMINAL"
      );
    });
  }
);
