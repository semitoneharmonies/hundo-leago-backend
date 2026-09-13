"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftCompletionOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_COMPLETION_SERVICE_CODES,
  FreeAgentDraftCompletionServiceError,
  createFreeAgentDraftCompletionService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftCompletionService"
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
  recovery: uuid(10),
  recoveryActivity: uuid(11),
});
const INITIAL_WINDOW_ENDS_AT_MS = 10_000;
const STARTED_AT_MS = 10_100;
const COMPLETED_AT_MS = 10_200;
const LEASE_EXPIRES_AT_MS = 20_000;
const OCCURRENCE_KEY =
  buildFreeAgentDraftCompletionOccurrenceKey({
    fadId: IDS.fad,
  });

function execution(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    initialWindowEndsAtMs:
      INITIAL_WINDOW_ENDS_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: INITIAL_WINDOW_ENDS_AT_MS,
    jobExecution: {
      runId: IDS.run,
      leaseOwner: "completion-worker",
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
    completedAtMs: COMPLETED_AT_MS,
    jobVersion: 3,
    fadVersion: 8,
    scheduleRecoveryId: null,
    competitionFirstMatchupStartsAtMs: 30_000,
    activityIds: [IDS.activity],
    notificationIds: [IDS.notification],
    outboxEventIds: [IDS.outboxOne, IDS.outboxTwo],
    ...overrides,
  };
}

function recordedFailure(overrides = {}) {
  return {
    recorded: true,
    replayed: false,
    runId: IDS.run,
    failedAtMs: COMPLETED_AT_MS,
    errorCode: "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
    jobVersion: 3,
    recoveryId: IDS.recovery,
    recoveryVersion: 1,
    ...overrides,
  };
}

describe("Free Agent Draft completion service foundation", () => {
  test("uses one clock sample and passes the exact claimed witness to the atomic writer", () => {
    const calls = [];
    const lifecycleRepository = Object.freeze({
      advanceStatus() {},
    });
    const service = createFreeAgentDraftCompletionService({
      writer: {
        executeClaimed(input, lifecycle) {
          calls.push({ input, lifecycle });
          return terminal();
        },
        recordFailure() {},
      },
      lifecycleRepository,
      clock: {
        nowMs() {
          calls.push("clock");
          return COMPLETED_AT_MS;
        },
      },
    });

    const result =
      service.executeClaimedCompletion(execution());

    assert.equal(calls[0], "clock");
    assert.equal(calls[1].lifecycle, lifecycleRepository);
    assert.deepEqual(calls[1].input, {
      ...execution(),
      completedAtMs: COMPLETED_AT_MS,
    });
    assert.deepEqual(result, terminal());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(
      Object.isFrozen(result.activityIds),
      true
    );
    assert.equal(
      Object.isFrozen(result.notificationIds),
      true
    );
    assert.equal(
      Object.isFrozen(result.outboxEventIds),
      true
    );
  });

  test("accepts exact replay and Week 1 recovery receipts", () => {
    const recovered = terminal({
      replayed: true,
      scheduleRecoveryId: IDS.recovery,
      activityIds: [
        IDS.recoveryActivity,
        IDS.activity,
      ],
    });
    const service = createFreeAgentDraftCompletionService({
      writer: {
        executeClaimed() {
          return recovered;
        },
        recordFailure() {},
      },
      lifecycleRepository: { advanceStatus() {} },
      clock: { nowMs: () => COMPLETED_AT_MS },
    });

    assert.deepEqual(
      service.executeClaimedCompletion(execution()),
      recovered
    );
  });

  test("rejects malformed scope, early clocks, and expired claims before writing", () => {
    let writes = 0;
    const create = (nowMs) =>
      createFreeAgentDraftCompletionService({
        writer: {
          executeClaimed() {
            writes += 1;
            return terminal();
          },
          recordFailure() {},
        },
        lifecycleRepository: { advanceStatus() {} },
        clock: { nowMs: () => nowMs },
      });
    assert.throws(
      () =>
        create(COMPLETED_AT_MS)
          .executeClaimedCompletion({
            ...execution(),
            extra: true,
          }),
      (error) =>
        error instanceof
          FreeAgentDraftCompletionServiceError &&
        error.code ===
          FREE_AGENT_DRAFT_COMPLETION_SERVICE_CODES
            .inputInvalid
    );
    assert.throws(
      () =>
        create(INITIAL_WINDOW_ENDS_AT_MS - 1)
          .executeClaimedCompletion(execution()),
      (error) =>
        error.reasonCode === "completion_not_due"
    );
    assert.throws(
      () =>
        create(LEASE_EXPIRES_AT_MS)
          .executeClaimedCompletion(execution()),
      (error) =>
        error.reasonCode === "claimed_lease_expired"
    );
    assert.equal(writes, 0);
  });

  test("rejects asynchronous writers and noncanonical terminal evidence", () => {
    const create = (result) =>
      createFreeAgentDraftCompletionService({
        writer: {
          executeClaimed() {
            return result;
          },
          recordFailure() {},
        },
        lifecycleRepository: { advanceStatus() {} },
        clock: { nowMs: () => COMPLETED_AT_MS },
      });
    assert.throws(
      () =>
        create(Promise.resolve(terminal()))
          .executeClaimedCompletion(execution()),
      (error) =>
        error.reasonCode ===
        "writer_must_be_synchronous"
    );
    assert.throws(
      () =>
        create(
          terminal({
            scheduleRecoveryId: IDS.recovery,
          })
        ).executeClaimedCompletion(execution()),
      (error) =>
        error.reasonCode ===
        "terminal_result_invalid"
    );
  });

  test("records only an explicitly requested claimed failure and accepts its exact replay", () => {
    const calls = [];
    const replayed = recordedFailure({
      replayed: true,
      recoveryVersion: 2,
    });
    const service = createFreeAgentDraftCompletionService({
      writer: {
        executeClaimed() {},
        recordFailure(input) {
          calls.push(input);
          return replayed;
        },
      },
      lifecycleRepository: { advanceStatus() {} },
      clock: {
        nowMs() {
          calls.push("clock");
          return COMPLETED_AT_MS;
        },
      },
    });

    assert.deepEqual(
      service.recordClaimedFailure({
        ...execution(),
        errorCode:
          "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
      }),
      replayed
    );
    assert.equal(calls[0], "clock");
    assert.deepEqual(calls[1], {
      ...execution(),
      failedAtMs: COMPLETED_AT_MS,
      errorCode:
        "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
    });
  });

  test("refuses stale failure leases and noncanonical failure receipts", () => {
    let writes = 0;
    const create = (nowMs, result = recordedFailure()) =>
      createFreeAgentDraftCompletionService({
        writer: {
          executeClaimed() {},
          recordFailure() {
            writes += 1;
            return result;
          },
        },
        lifecycleRepository: { advanceStatus() {} },
        clock: { nowMs: () => nowMs },
      });
    assert.throws(
      () =>
        create(LEASE_EXPIRES_AT_MS)
          .recordClaimedFailure({
            ...execution(),
            errorCode:
              "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
          }),
      (error) =>
        error.reasonCode === "claimed_lease_expired"
    );
    assert.equal(writes, 0);
    assert.throws(
      () =>
        create(
          COMPLETED_AT_MS,
          recordedFailure({ recoveryId: null })
        ).recordClaimedFailure({
          ...execution(),
          errorCode:
            "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
        }),
      (error) =>
        error.reasonCode === "failure_result_invalid"
    );
  });

  test("requires all execution collaborators at construction", () => {
    assert.throws(
      () => createFreeAgentDraftCompletionService(),
      /atomic writer/
    );
    assert.throws(
      () =>
        createFreeAgentDraftCompletionService({
          writer: {
            executeClaimed() {},
            recordFailure() {},
          },
        }),
      /lifecycle repository/
    );
    assert.throws(
      () =>
        createFreeAgentDraftCompletionService({
          writer: {
            executeClaimed() {},
            recordFailure() {},
          },
          lifecycleRepository: { advanceStatus() {} },
        }),
      /UTC clock/
    );
  });
});
