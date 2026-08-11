const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftDeadlineOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_DEADLINE_SERVICE_CODES,
  FreeAgentDraftDeadlineServiceError,
  createFreeAgentDraftDeadlineService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftDeadlineService"
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
  activity: uuid(6),
  notification: uuid(7),
  outboxOne: uuid(8),
  outboxTwo: uuid(9),
});
const DEADLINE_AT_MS = 10_000;
const STARTED_AT_MS = 10_100;
const EXECUTED_AT_MS = 10_200;
const LEASE_EXPIRES_AT_MS = 20_000;
const OCCURRENCE_KEY =
  buildFreeAgentDraftDeadlineOccurrenceKey({
    fadId: IDS.fad,
    deadlineAtMs: DEADLINE_AT_MS,
  });

function execution(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    deadlineAtMs: DEADLINE_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: DEADLINE_AT_MS,
    jobExecution: {
      runId: IDS.run,
      leaseOwner: "deadline-worker",
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: STARTED_AT_MS,
      attemptCount: 1,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function terminal(overrides = {}) {
  return {
    outcome: "succeeded",
    replayed: false,
    runId: IDS.run,
    completedAtMs: EXECUTED_AT_MS,
    jobVersion: 3,
    fadVersion: 2,
    cardCount: 2,
    allocationCount: 3,
    notificationIds: [IDS.notification],
    activityId: IDS.activity,
    outboxEventIds: [IDS.outboxOne, IDS.outboxTwo],
    ...overrides,
  };
}

describe("Free Agent Draft deadline service foundation", () => {
  test("uses one clock sample and passes the exact claimed witness to the atomic writer", () => {
    const calls = [];
    const lifecycleRepository = Object.freeze({
      advanceStatus() {},
    });
    const service = createFreeAgentDraftDeadlineService({
      writer: {
        executeClaimed(input, lifecycle) {
          calls.push({ input, lifecycle });
          return terminal();
        },
      },
      lifecycleRepository,
      clock: {
        nowMs() {
          calls.push("clock");
          return EXECUTED_AT_MS;
        },
      },
    });

    const result = service.executeClaimedDeadline(
      execution()
    );

    assert.equal(calls[0], "clock");
    assert.equal(calls[1].lifecycle, lifecycleRepository);
    assert.deepEqual(calls[1].input, {
      ...execution(),
      executedAtMs: EXECUTED_AT_MS,
    });
    assert.deepEqual(result, terminal());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(
      Object.isFrozen(result.notificationIds),
      true
    );
    assert.equal(
      Object.isFrozen(result.outboxEventIds),
      true
    );
  });

  test("preserves a canonical durable replay result", () => {
    const service = createFreeAgentDraftDeadlineService({
      writer: {
        executeClaimed() {
          return terminal({ replayed: true });
        },
      },
      lifecycleRepository: { advanceStatus() {} },
      clock: { nowMs: () => EXECUTED_AT_MS },
    });
    assert.equal(
      service.executeClaimedDeadline(execution()).replayed,
      true
    );
  });

  test("rejects malformed scope, early clocks, and expired claims before writing", () => {
    let writes = 0;
    const create = (nowMs) =>
      createFreeAgentDraftDeadlineService({
        writer: {
          executeClaimed() {
            writes += 1;
            return terminal();
          },
        },
        lifecycleRepository: { advanceStatus() {} },
        clock: { nowMs: () => nowMs },
      });
    assert.throws(
      () =>
        create(EXECUTED_AT_MS)
          .executeClaimedDeadline({
            ...execution(),
            extra: true,
          }),
      (error) =>
        error instanceof
          FreeAgentDraftDeadlineServiceError &&
        error.code ===
          FREE_AGENT_DRAFT_DEADLINE_SERVICE_CODES
            .inputInvalid
    );
    assert.throws(
      () =>
        create(DEADLINE_AT_MS - 1)
          .executeClaimedDeadline(execution()),
      (error) =>
        error.reasonCode === "deadline_not_due"
    );
    assert.throws(
      () =>
        create(LEASE_EXPIRES_AT_MS)
          .executeClaimedDeadline(execution()),
      (error) =>
        error.reasonCode === "claimed_lease_expired"
    );
    assert.equal(writes, 0);
  });

  test("rejects asynchronous writers and noncanonical terminal evidence", () => {
    const create = (result) =>
      createFreeAgentDraftDeadlineService({
        writer: {
          executeClaimed() {
            return result;
          },
        },
        lifecycleRepository: { advanceStatus() {} },
        clock: { nowMs: () => EXECUTED_AT_MS },
      });
    assert.throws(
      () =>
        create(Promise.resolve(terminal()))
          .executeClaimedDeadline(execution()),
      (error) =>
        error.reasonCode ===
        "writer_must_be_synchronous"
    );
    assert.throws(
      () =>
        create(
          terminal({
            allocationCount: -1,
          })
        ).executeClaimedDeadline(execution()),
      (error) =>
        error.reasonCode ===
        "terminal_result_invalid"
    );
  });

  test("requires all execution collaborators at construction", () => {
    assert.throws(
      () => createFreeAgentDraftDeadlineService(),
      /atomic writer/
    );
    assert.throws(
      () =>
        createFreeAgentDraftDeadlineService({
          writer: { executeClaimed() {} },
        }),
      /lifecycle repository/
    );
    assert.throws(
      () =>
        createFreeAgentDraftDeadlineService({
          writer: { executeClaimed() {} },
          lifecycleRepository: { advanceStatus() {} },
        }),
      /UTC clock/
    );
  });
});
