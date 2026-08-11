const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftEligibilityOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  CANDIDATE_ELIGIBILITY_REVALIDATION_JOB_TYPE,
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createRevalidateFreeAgentDraftCandidateEligibilityJob,
} = require(
  "../../src/jobs/definitions/revalidateFreeAgentDraftCandidateEligibility"
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
  fad: uuid(3),
  playerOne: uuid(4),
  sourceOne: uuid(5),
  occurrenceOne: uuid(6),
  jobOne: uuid(7),
  sourceStateOneBefore: uuid(8),
  sourceStateOneAfter: uuid(9),
  playerTwo: uuid(10),
  sourceTwo: uuid(11),
  occurrenceTwo: uuid(12),
  jobTwo: uuid(13),
  sourceStateTwoBefore: uuid(14),
  sourceStateTwoAfter: uuid(15),
  leaseOne: uuid(16),
  leaseTwo: uuid(17),
});
const LISTED_AT_MS = 10_000;
const CLAIM_ONE_AT_MS = 10_100;
const CLAIM_TWO_AT_MS = 10_200;
const LEASE_OWNER = "fad-eligibility-worker";

function descriptor(number, overrides = {}) {
  const playerId = IDS[`player${number}`];
  const sourceOperationId = IDS[`source${number}`];
  const occurrenceId = IDS[`occurrence${number}`];
  const runId = IDS[`job${number}`];
  const sourceStateBeforeId =
    IDS[`sourceState${number}Before`];
  const sourceStateAfterId =
    IDS[`sourceState${number}After`];
  const scheduledForMs =
    number === "One" ? 9_000 : 9_100;
  const occurrenceKey =
    buildFreeAgentDraftEligibilityOccurrenceKey({
      fadId: IDS.fad,
      playerId,
      sourceOperationId,
    });
  return deepFreeze({
    runId,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    jobType:
      CANDIDATE_ELIGIBILITY_REVALIDATION_JOB_TYPE,
    occurrenceKey,
    scheduledForMs,
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
      type: "eligibility_revalidate",
      fadId: IDS.fad,
      playerId,
      sourceOperationId,
    },
    binding: {
      type: "eligibility_revalidate",
      resourceType:
        "eligibility_revalidation_occurrence",
      resourceId: occurrenceId,
      fadId: IDS.fad,
      occurrenceId,
      playerId,
      sourceOperationId,
      sourceProvider: "sportsdataio-live",
      sourceOperationEventType:
        "player_catalog_applied",
      sourceOperationOccurredAtMs:
        scheduledForMs,
      playerVersionBefore: 1,
      playerVersionAfter: 1,
      playerStatusBefore: "active",
      playerStatusAfter: "active",
      sourceStateBeforeId,
      sourceStateAfterId,
      sourceResolvedPositionGroupBefore: "F",
      sourceResolvedPositionGroupAfter: "D",
      leaguePositionOverrideId: null,
      effectivePositionGroupBefore: "F",
      effectivePositionGroupAfter: "D",
      eligibilityDeltaSha256: "a".repeat(64),
    },
    ...overrides,
  });
}

function claimedDescriptor(due, command) {
  return deepFreeze({
    ...due,
    status: "running",
    attemptCount: due.attemptCount + 1,
    leaseExpiresAtMs: command.leaseExpiresAtMs,
    startedAtMs: command.nowMs,
    version: due.version + 1,
  });
}

function terminal(command) {
  return deepFreeze({
    outcome: "succeeded",
    runId: command.jobExecution.runId,
    occurrenceId: command.occurrenceId,
    playerId: command.playerId,
    affectedCardCount: 1,
    changedCardCount: 1,
    completedAtMs: CLAIM_ONE_AT_MS + 1,
    jobVersion:
      command.jobExecution.expectedVersion + 1,
  });
}

function harness({
  due = [
    { jobType: "fad_readiness" },
    descriptor("Two"),
    { jobType: "fad_deadline" },
    descriptor("One"),
  ],
  claimImplementation,
  serviceImplementation,
  clockValues = [
    LISTED_AT_MS,
    CLAIM_ONE_AT_MS,
    CLAIM_TWO_AT_MS,
  ],
} = {}) {
  const calls = [];
  let clockIndex = 0;
  let tokenIndex = 0;
  const byRunId = new Map(
    due
      .filter(({ runId }) => runId)
      .map((value) => [value.runId, value])
  );
  const repository = {
    listDue(command) {
      calls.push(["list", command]);
      return due;
    },
    claim(command) {
      calls.push(["claim", command]);
      if (claimImplementation) {
        return claimImplementation(
          command,
          byRunId.get(command.runId)
        );
      }
      return {
        acquired: true,
        occurrence: claimedDescriptor(
          byRunId.get(command.runId),
          command
        ),
      };
    },
  };
  const eligibilityService = {
    async executeClaimedEligibilityRevalidation(
      command
    ) {
      calls.push(["execute", command]);
      return serviceImplementation
        ? serviceImplementation(command)
        : terminal(command);
    },
  };
  const job =
    createRevalidateFreeAgentDraftCandidateEligibilityJob({
      repository,
      eligibilityService,
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
            tokenIndex === 0
              ? IDS.leaseOne
              : IDS.leaseTwo;
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

describe(
  "FAD Candidate eligibility revalidation scheduled job",
  () => {
    test("filters other FAD work and preserves repository order for exact eligibility claims", async () => {
      const { calls, job } = harness();
      assert.deepEqual(await job.run(), {
        job: JOB_NAME,
        status: "succeeded",
        due: 2,
        acquired: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
      });
      assert.deepEqual(
        calls
          .filter(([name]) => name === "claim")
          .map(([, command]) => command.runId),
        [IDS.jobTwo, IDS.jobOne]
      );
      assert.deepEqual(
        calls
          .filter(([name]) => name === "execute")
          .map(([, command]) => ({
            runId: command.jobExecution.runId,
            occurrenceId: command.occurrenceId,
            playerId: command.playerId,
          })),
        [
          {
            runId: IDS.jobTwo,
            occurrenceId: IDS.occurrenceTwo,
            playerId: IDS.playerTwo,
          },
          {
            runId: IDS.jobOne,
            occurrenceId: IDS.occurrenceOne,
            playerId: IDS.playerOne,
          },
        ]
      );
      const firstClaim = calls.find(
        ([name]) => name === "claim"
      )[1];
      assert.equal(
        firstClaim.leaseExpiresAtMs,
        CLAIM_ONE_AT_MS + DEFAULT_LEASE_MS
      );
    });

    test("leaves thrown claimed work for lease reclaim and continues later work", async () => {
      const failure = new Error("synchronizer unavailable");
      const { calls, job } = harness({
        serviceImplementation(command) {
          if (
            command.jobExecution.runId ===
            IDS.jobTwo
          ) {
            throw failure;
          }
          return terminal(command);
        },
      });
      assert.deepEqual(await job.run(), {
        job: JOB_NAME,
        status: "failed",
        due: 2,
        acquired: 2,
        succeeded: 1,
        failed: 1,
        skipped: 0,
      });
      assert.deepEqual(
        calls.map(([name]) => name),
        [
          "list",
          "id",
          "claim",
          "execute",
          "error",
          "id",
          "claim",
          "execute",
        ]
      );
      assert.deepEqual(calls[4][1], [
        "free_agent_draft.eligibility_revalidation_occurrence_failed",
        {
          job: JOB_NAME,
          runId: IDS.jobTwo,
          fadId: IDS.fad,
          classification: "transient",
        },
      ]);
      assert.equal(
        calls.some(([name]) => name === "fail"),
        false
      );
    });

    test("does not execute an occurrence whose claim was not acquired", async () => {
      const only = descriptor("One");
      const { calls, job } = harness({
        due: [only],
        claimImplementation() {
          return {
            acquired: false,
            occurrence: only,
          };
        },
        clockValues: [
          LISTED_AT_MS,
          CLAIM_ONE_AT_MS,
        ],
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
      assert.deepEqual(
        calls.map(([name]) => name),
        ["list", "id", "claim"]
      );
    });

    test("fails closed before lease allocation for a tampered descriptor", async () => {
      const malformed = descriptor("One", {
        binding: {
          ...descriptor("One").binding,
          sourceOperationEventType: "tampered",
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
  }
);
