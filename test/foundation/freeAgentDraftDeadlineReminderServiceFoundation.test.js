const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftReminderOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES,
  FreeAgentDraftDeadlineReminderServiceError,
  createFreeAgentDraftDeadlineReminderService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftDeadlineReminderService"
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
  notification: uuid(6),
  outbox: uuid(7),
});
const REMINDER_AT_MS = Date.parse(
  "2027-08-29T07:00:00.000Z"
);
const EXECUTED_AT_MS = REMINDER_AT_MS + 1_000;
const LEASE_EXPIRES_AT_MS =
  EXECUTED_AT_MS + 60_000;
const OCCURRENCE_KEY =
  buildFreeAgentDraftReminderOccurrenceKey({
    fadId: IDS.fad,
    reminderAtMs: REMINDER_AT_MS,
  });

function input(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    reminderAtMs: REMINDER_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: REMINDER_AT_MS,
    jobExecution: {
      runId: IDS.run,
      leaseOwner: "fad-reminder-worker",
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function terminal(overrides = {}) {
  return {
    outcome: "succeeded",
    runId: IDS.run,
    completedAtMs: EXECUTED_AT_MS,
    jobVersion: 3,
    sentCount: 1,
    skippedCount: 0,
    reasonCode: null,
    notificationIds: [IDS.notification],
    outboxEventId: IDS.outbox,
    ...overrides,
  };
}

function expectServiceError(
  action,
  code,
  reasonCode
) {
  assert.throws(action, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftDeadlineReminderServiceError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe(
  "Free Agent Draft deadline-reminder service foundation",
  () => {
    test("passes the exact claimed occurrence and sampled UTC execution time to the synchronous writer", () => {
      const calls = [];
      const service =
        createFreeAgentDraftDeadlineReminderService({
          writer: {
            executeClaimed(command) {
              calls.push(command);
              return terminal();
            },
          },
          clock: {
            nowMs: () => EXECUTED_AT_MS,
          },
        });

      const result =
        service.executeClaimedReminder(input());

      assert.deepEqual(result, terminal());
      assert.equal(
        Object.isFrozen(result.notificationIds),
        true
      );
      assert.deepEqual(calls, [
        {
          ...input(),
          executedAtMs: EXECUTED_AT_MS,
        },
      ]);
    });

    test("accepts a durable terminal skip without notification or outbox evidence", () => {
      const service =
        createFreeAgentDraftDeadlineReminderService({
          writer: {
            executeClaimed() {
              return terminal({
                outcome: "skipped",
                sentCount: 0,
                skippedCount: 2,
                reasonCode: "cards_locked",
                notificationIds: [],
                outboxEventId: null,
              });
            },
          },
          clock: {
            nowMs: () => EXECUTED_AT_MS,
          },
        });

      assert.equal(
        service.executeClaimedReminder(input())
          .outcome,
        "skipped"
      );
    });

    test("rejects mismatched occurrence scope before sampling the clock or calling the writer", () => {
      let clockCalls = 0;
      let writerCalls = 0;
      const service =
        createFreeAgentDraftDeadlineReminderService({
          writer: {
            executeClaimed() {
              writerCalls += 1;
              return terminal();
            },
          },
          clock: {
            nowMs() {
              clockCalls += 1;
              return EXECUTED_AT_MS;
            },
          },
        });

      expectServiceError(
        () =>
          service.executeClaimedReminder(
            input({
              scheduledForMs: REMINDER_AT_MS + 1,
            })
          ),
        FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES
          .inputInvalid,
        "occurrence_scope_invalid"
      );
      assert.equal(clockCalls, 0);
      assert.equal(writerCalls, 0);
    });

    test("rejects an expired claimed lease before calling the writer", () => {
      let writerCalls = 0;
      const service =
        createFreeAgentDraftDeadlineReminderService({
          writer: {
            executeClaimed() {
              writerCalls += 1;
              return terminal();
            },
          },
          clock: {
            nowMs: () => LEASE_EXPIRES_AT_MS,
          },
        });

      expectServiceError(
        () =>
          service.executeClaimedReminder(input()),
        FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES
          .stateInvalid,
        "claimed_lease_expired"
      );
      assert.equal(writerCalls, 0);
    });

    test("rejects a reminder execution sampled before its scheduled instant", () => {
      let writerCalls = 0;
      const service =
        createFreeAgentDraftDeadlineReminderService({
          writer: {
            executeClaimed() {
              writerCalls += 1;
              return terminal();
            },
          },
          clock: {
            nowMs: () => REMINDER_AT_MS - 1,
          },
        });

      expectServiceError(
        () =>
          service.executeClaimedReminder(input()),
        FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES
          .stateInvalid,
        "reminder_not_due"
      );
      assert.equal(writerCalls, 0);
    });

    test("rejects asynchronous writers and malformed terminal evidence", () => {
      const asynchronous =
        createFreeAgentDraftDeadlineReminderService({
          writer: {
            executeClaimed: async () => terminal(),
          },
          clock: {
            nowMs: () => EXECUTED_AT_MS,
          },
        });
      expectServiceError(
        () =>
          asynchronous.executeClaimedReminder(
            input()
          ),
        FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES
          .stateInvalid,
        "writer_must_be_synchronous"
      );

      const malformed =
        createFreeAgentDraftDeadlineReminderService({
          writer: {
            executeClaimed: () =>
              terminal({ outboxEventId: null }),
          },
          clock: {
            nowMs: () => EXECUTED_AT_MS,
          },
        });
      expectServiceError(
        () =>
          malformed.executeClaimedReminder(input()),
        FREE_AGENT_DRAFT_DEADLINE_REMINDER_SERVICE_CODES
          .stateInvalid,
        "terminal_result_invalid"
      );
    });
  }
);
