const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftReadinessOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createOpenReadyFreeAgentDraftCandidateCardsJob,
} = require(
  "../../src/jobs/definitions/openReadyFreeAgentDraftCandidateCards"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  trigger: uuid(3),
  readiness: uuid(4),
  job: uuid(5),
  leaseToken: uuid(6),
  attempt: uuid(7),
  fad: uuid(8),
});
const SCHEDULED_FOR_MS = Date.parse(
  "2026-08-08T16:00:00.000Z"
);
const NOW_MS = SCHEDULED_FOR_MS + 1_000;
const CLAIM_AT_MS = NOW_MS + 10;
const LEASE_OWNER = "fad-readiness-worker";
const OCCURRENCE_KEY =
  buildFreeAgentDraftReadinessOccurrenceKey({
    leagueId: IDS.league,
    seasonId: IDS.season,
    triggerResourceId: IDS.trigger,
  });

function readinessDescriptor(overrides = {}) {
  const base = {
    runId: IDS.job,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: null,
    jobType:
      FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
    occurrenceKey: OCCURRENCE_KEY,
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
      type: "readiness",
      leagueId: IDS.league,
      seasonId: IDS.season,
      triggerResourceId: IDS.trigger,
    },
    binding: {
      type: "readiness",
      resourceType: "readiness_operation",
      resourceId: IDS.readiness,
      fadId: null,
      triggerResourceId: IDS.trigger,
      createdFadId: null,
    },
  };
  return deepFreeze({
    ...base,
    ...overrides,
  });
}

function claimedDescriptor(command) {
  return readinessDescriptor({
    status: "running",
    attemptCount: 1,
    leaseExpiresAtMs:
      command.leaseExpiresAtMs,
    startedAtMs: command.nowMs,
    version: 2,
  });
}

function terminalResult(outcome) {
  return deepFreeze({
    outcome,
    replayed: false,
    readinessOperationId: IDS.readiness,
    readinessAttemptId: IDS.attempt,
    readinessVersion: 3,
    fadId:
      outcome === "succeeded" ? IDS.fad : null,
    nextRetryAtMs:
      outcome === "blocked" ? CLAIM_AT_MS + 1 : null,
    scheduleRecoveryRequired: false,
  });
}

function harness({
  due = [
    deepFreeze({
      jobType: "fad_deadline_reminder",
    }),
    readinessDescriptor(),
    deepFreeze({ jobType: "fad_deadline" }),
  ],
  claimImplementation = (command) => ({
    acquired: true,
    occurrence: claimedDescriptor(command),
  }),
  serviceImplementation = async () =>
    terminalResult("succeeded"),
  clockValues = [NOW_MS, CLAIM_AT_MS],
  leaseDurationMs,
  batchSize,
} = {}) {
  const calls = [];
  let clockIndex = 0;
  const repository = {
    listDue(command) {
      calls.push(["list", command]);
      return due;
    },
    claim(command) {
      calls.push(["claim", command]);
      return claimImplementation(command);
    },
  };
  const readinessService = {
    async executeClaimedReadiness(command) {
      calls.push(["execute", command]);
      return serviceImplementation(command);
    },
  };
  const job =
    createOpenReadyFreeAgentDraftCandidateCardsJob({
      repository,
      readinessService,
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
      ...(leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs }),
      ...(batchSize === undefined
        ? {}
        : { batchSize }),
      logger: {
        error(...input) {
          calls.push(["error", input]);
        },
      },
    });
  return { calls, job };
}

describe(
  "FAD-08 automatic readiness scheduled job",
  () => {
    test("filters non-readiness FAD work before token allocation or claim and executes the exact claimed pair", async () => {
      const { calls, job } = harness();

      assert.deepEqual(await job.run(), {
        job: JOB_NAME,
        status: "succeeded",
        due: 1,
        acquired: 1,
        succeeded: 1,
        blocked: 0,
        failed: 0,
        skipped: 0,
      });
      assert.deepEqual(calls, [
        [
          "list",
          { nowMs: NOW_MS, limit: 25 },
        ],
        ["id", IDS.leaseToken],
        [
          "claim",
          {
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: null,
            runId: IDS.job,
            jobType:
              FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
            occurrenceKey: OCCURRENCE_KEY,
            scheduledForMs: SCHEDULED_FOR_MS,
            expectedVersion: 1,
            leaseOwner: LEASE_OWNER,
            leaseToken: IDS.leaseToken,
            nowMs: CLAIM_AT_MS,
            leaseExpiresAtMs:
              CLAIM_AT_MS + DEFAULT_LEASE_MS,
          },
        ],
        [
          "execute",
          {
            leagueId: IDS.league,
            seasonId: IDS.season,
            occurrenceKey: OCCURRENCE_KEY,
            readinessOperationId: IDS.readiness,
            jobExecution: {
              runId: IDS.job,
              leaseOwner: LEASE_OWNER,
              leaseToken: IDS.leaseToken,
              leaseExpiresAtMs:
                CLAIM_AT_MS + DEFAULT_LEASE_MS,
              expectedVersion: 2,
            },
          },
        ],
      ]);
    });

    test("counts a durably blocked result without generic job completion or retry", async () => {
      const { calls, job } = harness({
        serviceImplementation: async () =>
          terminalResult("blocked"),
      });

      assert.deepEqual(await job.run(), {
        job: JOB_NAME,
        status: "succeeded",
        due: 1,
        acquired: 1,
        succeeded: 0,
        blocked: 1,
        failed: 0,
        skipped: 0,
      });
      assert.deepEqual(
        calls.map(([name]) => name),
        ["list", "id", "claim", "execute"]
      );
    });

    test("skips a readiness occurrence held by another worker without executing it", async () => {
      const { calls, job } = harness({
        claimImplementation: () => ({
          acquired: false,
          occurrence: readinessDescriptor(),
        }),
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
      assert.deepEqual(
        calls.map(([name]) => name),
        ["list", "id", "claim"]
      );
    });

    test("leaves an unexpected claimed failure untouched for paired lease reclaim", async () => {
      const failure = new Error("planner unavailable");
      const { calls, job } = harness({
        serviceImplementation: async () => {
          throw failure;
        },
      });

      assert.deepEqual(await job.run(), {
        job: JOB_NAME,
        status: "failed",
        due: 1,
        acquired: 1,
        succeeded: 0,
        blocked: 0,
        failed: 1,
        skipped: 0,
      });
      assert.deepEqual(
        calls.map(([name]) => name),
        ["list", "id", "claim", "execute", "error"]
      );
      assert.deepEqual(calls.at(-1)[1], [
        "free_agent_draft.readiness_occurrence_failed",
        {
          job: JOB_NAME,
          runId: IDS.job,
          fadId: null,
          classification: "transient",
        },
      ]);
    });

    test("does not inspect or claim reminder and deadline jobs before FAD-10", async () => {
      const { calls, job } = harness({
        due: [
          { jobType: "fad_deadline_reminder" },
          { jobType: "fad_deadline" },
        ],
        clockValues: [NOW_MS],
      });

      assert.deepEqual(await job.run(), {
        job: JOB_NAME,
        status: "succeeded",
        due: 0,
        acquired: 0,
        succeeded: 0,
        blocked: 0,
        failed: 0,
        skipped: 0,
      });
      assert.deepEqual(
        calls.map(([name]) => name),
        ["list"]
      );
    });

    test("fails closed before claim for malformed readiness identity or lease overflow", async () => {
      const malformed = harness({
        due: [
          readinessDescriptor({
            occurrenceKey: "tampered",
          }),
        ],
      });
      const malformedResult =
        await malformed.job.run();
      assert.equal(malformedResult.status, "failed");
      assert.deepEqual(
        malformed.calls.map(([name]) => name),
        ["list", "error"]
      );

      const overflow = harness({
        clockValues: [
          NOW_MS,
          Number.MAX_SAFE_INTEGER,
        ],
      });
      const overflowResult = await overflow.job.run();
      assert.equal(overflowResult.status, "failed");
      assert.equal(overflowResult.failed, 1);
      assert.deepEqual(
        overflow.calls.map(([name]) => name),
        ["list", "error"]
      );
    });
  }
);
