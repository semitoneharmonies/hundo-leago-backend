"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_ALLOCATION_LIFECYCLE_SERVICE_CODES,
  FreeAgentDraftAllocationLifecycleServiceError,
  createFreeAgentDraftAllocationLifecycleService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftAllocationLifecycleService"
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
  operation: uuid(4),
  week: uuid(5),
});
const NOW_MS = 20_000;

function root(overrides = {}) {
  return Object.freeze({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    status: "deadline_locked",
    version: 2,
    updatedAtMs: 10_000,
    deadlineLockedAtMs: 10_000,
    allocationCount: 2,
    pendingAllocationCount: 2,
    schedule: Object.freeze({
      operationId: IDS.operation,
      version: 7,
      weekOneMatchupWeekId: IDS.week,
      weekOneStartsAtMs: 100_000,
    }),
    ...overrides,
  });
}

function runtime({
  nowMs = NOW_MS,
  advance,
} = {}) {
  const calls = [];
  const lifecycleRepository = {
    advanceStatus(command) {
      calls.push(command);
      if (advance) return advance(command);
      return {
        replayed: false,
        draft: {
          id: command.fadId,
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          status: command.toStatus,
          version: command.expectedVersion + 1,
        },
      };
    },
  };
  const service =
    createFreeAgentDraftAllocationLifecycleService({
      lifecycleRepository,
      clock: { nowMs: () => nowMs },
    });
  return { calls, lifecycleRepository, service };
}

function assertServiceError(
  callback,
  code,
  reasonCode
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftAllocationLifecycleServiceError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("FAD allocation lifecycle service", () => {
  test("starts a nonempty deadline-locked FAD with one exact schedule-bound CAS", () => {
    const { calls, service } = runtime();
    const input = root();

    const result = service.coordinateRoot(input);

    assert.deepEqual(calls, [
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        expectedVersion: 2,
        fromStatus: "deadline_locked",
        toStatus: "allocating",
        occurredAtMs: NOW_MS,
        schedule: input.schedule,
        scheduleRecoveryPlan: null,
      },
    ]);
    assert.deepEqual(result, {
      outcome: "transitioned",
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      fromStatus: "deadline_locked",
      toStatus: "allocating",
      allocationCount: 2,
      pendingAllocationCount: 2,
      fadVersion: 3,
      occurredAtMs: NOW_MS,
    });
    assert.ok(Object.isFrozen(result));
  });

  test("moves a zero-allocation deadline-locked FAD directly to rapid", () => {
    const { calls, service } = runtime();

    const result = service.coordinateRoot(
      root({
        allocationCount: 0,
        pendingAllocationCount: 0,
      })
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].fromStatus, "deadline_locked");
    assert.equal(calls[0].toStatus, "rapid");
    assert.equal(result.toStatus, "rapid");
    assert.equal(result.fadVersion, 3);
  });

  test("leaves allocating per-player work alone while any allocation remains pending", () => {
    const { calls, service } = runtime();

    const result = service.coordinateRoot(
      root({
        status: "allocating",
        version: 3,
        allocationCount: 4,
        pendingAllocationCount: 1,
      })
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(result, {
      outcome: "waiting",
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      fromStatus: "allocating",
      toStatus: null,
      allocationCount: 4,
      pendingAllocationCount: 1,
      fadVersion: 3,
      occurredAtMs: NOW_MS,
    });
  });

  test("moves an allocating FAD to rapid only after every allocation is terminal", () => {
    const { calls, service } = runtime();

    const result = service.coordinateRoot(
      root({
        status: "allocating",
        version: 8,
        allocationCount: 5,
        pendingAllocationCount: 0,
      })
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].fromStatus, "allocating");
    assert.equal(calls[0].toStatus, "rapid");
    assert.equal(calls[0].expectedVersion, 8);
    assert.equal(result.fadVersion, 9);
  });

  test("accepts only an exact same-edge replay projection", () => {
    const replay = runtime({
      advance(command) {
        return {
          replayed: true,
          draft: {
            id: command.fadId,
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            status: command.toStatus,
            version: command.expectedVersion + 1,
          },
        };
      },
    });
    assert.equal(
      replay.service.coordinateRoot(root()).outcome,
      "replayed"
    );

    for (const bad of [
      null,
      Promise.resolve({}),
      { replayed: false, draft: null },
      {
        replayed: true,
        draft: {
          id: IDS.fad,
          leagueId: IDS.league,
          seasonId: IDS.season,
          status: "rapid",
          version: 3,
        },
      },
      {
        replayed: true,
        draft: {
          id: IDS.fad,
          leagueId: IDS.league,
          seasonId: IDS.season,
          status: "allocating",
          version: 99,
        },
      },
    ]) {
      const current = runtime({ advance: () => bad });
      assertServiceError(
        () => current.service.coordinateRoot(root()),
        FREE_AGENT_DRAFT_ALLOCATION_LIFECYCLE_SERVICE_CODES
          .stateInvalid,
        bad && typeof bad.then === "function"
          ? "repository_must_be_synchronous"
          : "transition_result_invalid"
      );
    }
  });

  test("rejects malformed roots, impossible lifecycle counts, and invalid clock state before mutation", () => {
    const malformed = [
      [{ ...root(), extra: true }, "root_fields_invalid"],
      [
        root({ leagueId: "bad" }),
        "league_id_invalid",
      ],
      [
        root({ status: "rapid" }),
        "root_status_invalid",
      ],
      [
        root({
          allocationCount: 1,
          pendingAllocationCount: 2,
        }),
        "allocation_counts_invalid",
      ],
      [
        root({
          schedule: {
            ...root().schedule,
            extra: true,
          },
        }),
        "schedule_fields_invalid",
      ],
    ];
    for (const [input, reason] of malformed) {
      const { calls, service } = runtime();
      assertServiceError(
        () => service.coordinateRoot(input),
        FREE_AGENT_DRAFT_ALLOCATION_LIFECYCLE_SERVICE_CODES
          .inputInvalid,
        reason
      );
      assert.deepEqual(calls, []);
    }

    for (const [input, reason] of [
      [
        root({
          allocationCount: 3,
          pendingAllocationCount: 2,
        }),
        "deadline_locked_allocations_noncanonical",
      ],
      [
        root({
          status: "allocating",
          allocationCount: 0,
          pendingAllocationCount: 0,
        }),
        "allocating_without_allocations",
      ],
    ]) {
      const { calls, service } = runtime();
      assertServiceError(
        () => service.coordinateRoot(input),
        FREE_AGENT_DRAFT_ALLOCATION_LIFECYCLE_SERVICE_CODES
          .stateInvalid,
        reason
      );
      assert.deepEqual(calls, []);
    }

    for (const nowMs of [-1, 9_999]) {
      const { calls, service } = runtime({ nowMs });
      assertServiceError(
        () => service.coordinateRoot(root()),
        FREE_AGENT_DRAFT_ALLOCATION_LIFECYCLE_SERVICE_CODES
          .stateInvalid,
        nowMs < 0
          ? "clock_timestamp_invalid"
          : "root_timestamp_in_future"
      );
      assert.deepEqual(calls, []);
    }
  });

  test("requires exact synchronous dependencies", () => {
    assert.throws(
      () =>
        createFreeAgentDraftAllocationLifecycleService(),
      TypeError
    );
    assert.throws(
      () =>
        createFreeAgentDraftAllocationLifecycleService({
          lifecycleRepository: {
            advanceStatus() {},
          },
        }),
      TypeError
    );
    assert.throws(
      () =>
        createFreeAgentDraftAllocationLifecycleService({
          lifecycleRepository: {},
          clock: { nowMs() {} },
        }),
      TypeError
    );
  });
});
