const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftReminderOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  DEFAULT_LEASE_MS,
  FREE_AGENT_DRAFT_DEADLINE_REMINDER_JOB_TYPE,
  JOB_NAME,
  createSendFreeAgentDraftDeadlineRemindersJob,
} = require(
  "../../src/jobs/definitions/sendFreeAgentDraftDeadlineReminders"
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
  fadOne: uuid(3),
  fadTwo: uuid(4),
  runOne: uuid(5),
  runTwo: uuid(6),
  leaseOne: uuid(7),
  leaseTwo: uuid(8),
});
const LISTED_AT_MS = 50_000;
const CLAIM_ONE_AT_MS = 50_100;
const CLAIM_TWO_AT_MS = 50_200;
const LEASE_OWNER = "fad-reminder-worker";

function descriptor(number, overrides = {}) {
  const fadId = IDS[`fad${number}`];
  const runId = IDS[`run${number}`];
  const reminderAtMs =
    number === "One" ? 40_000 : 40_100;
  const occurrenceKey =
    buildFreeAgentDraftReminderOccurrenceKey({
      fadId,
      reminderAtMs,
    });
  return deepFreeze({
    runId,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId,
    jobType:
      FREE_AGENT_DRAFT_DEADLINE_REMINDER_JOB_TYPE,
    occurrenceKey,
    scheduledForMs: reminderAtMs,
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
      type: "reminder",
      fadId,
      reminderAtMs,
    },
    binding: {
      type: "reminder",
      resourceType: "free_agent_draft",
      resourceId: fadId,
      fadId,
      reminderAtMs,
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

function terminal(command, overrides = {}) {
  return deepFreeze({
    outcome: "succeeded",
    runId: command.jobExecution.runId,
    completedAtMs: CLAIM_ONE_AT_MS + 1,
    jobVersion:
      command.jobExecution.expectedVersion + 1,
    sentCount: 1,
    skippedCount: 0,
    reasonCode: null,
    notificationIds: [uuid(100)],
    outboxEventId: uuid(101),
    ...overrides,
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
  const reminderService = {
    async executeClaimedReminder(command) {
      calls.push(["execute", command]);
      return serviceImplementation
        ? serviceImplementation(command)
        : terminal(command);
    },
  };
  const job =
    createSendFreeAgentDraftDeadlineRemindersJob({
      repository,
      reminderService,
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
  "FAD deadline-reminder scheduled job",
  () => {
    test("filters other FAD work and executes already-due reminders in repository order with exact leases", async () => {
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
          .map(([, claim]) => claim.runId),
        [IDS.runTwo, IDS.runOne]
      );
      const firstClaim = calls.find(
        ([name]) => name === "claim"
      )[1];
      assert.equal(
        firstClaim.leaseExpiresAtMs,
        CLAIM_ONE_AT_MS + DEFAULT_LEASE_MS
      );
      assert.equal(
        firstClaim.nowMs,
        CLAIM_ONE_AT_MS
      );
      assert.deepEqual(
        calls
          .filter(([name]) => name === "execute")
          .map(([, command]) => ({
            runId: command.jobExecution.runId,
            reminderAtMs: command.reminderAtMs,
          })),
        [
          {
            runId: IDS.runTwo,
            reminderAtMs: 40_100,
          },
          {
            runId: IDS.runOne,
            reminderAtMs: 40_000,
          },
        ]
      );
    });

    test("counts an obsolete durable terminal result as skipped", async () => {
      const only = descriptor("One");
      const { job } = harness({
        due: [only],
        serviceImplementation(command) {
          return terminal(command, {
            outcome: "skipped",
            sentCount: 0,
            skippedCount: 1,
            reasonCode: "deadline_reached",
            notificationIds: [],
            outboxEventId: null,
          });
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
        acquired: 1,
        succeeded: 0,
        failed: 0,
        skipped: 1,
      });
    });

    test("leaves thrown claimed work for lease reclaim and continues later reminders", async () => {
      const failure = new Error(
        "notification storage unavailable"
      );
      const { calls, job } = harness({
        serviceImplementation(command) {
          if (
            command.jobExecution.runId ===
            IDS.runTwo
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
      assert.equal(
        calls.some(([name]) => name === "fail"),
        false
      );
      const errorCall = calls.find(
        ([name]) => name === "error"
      );
      assert.deepEqual(errorCall[1], [
        "free_agent_draft.deadline_reminder_occurrence_failed",
        {
          job: JOB_NAME,
          runId: IDS.runTwo,
          fadId: IDS.fadTwo,
          classification: "transient",
        },
      ]);
    });

    test("does not execute a reminder whose claim was not acquired", async () => {
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

    test("fails closed before lease allocation for a tampered reminder binding", async () => {
      const base = descriptor("One");
      const malformed = descriptor("One", {
        binding: {
          ...base.binding,
          reminderAtMs: 40_001,
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
