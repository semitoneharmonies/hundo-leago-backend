"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  JOB_NAME,
  createCoordinateFreeAgentDraftAllocationsJob,
} = require(
  "../../src/jobs/definitions/coordinateFreeAgentDraftAllocations"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function candidate(index, overrides = {}) {
  return Object.freeze({
    leagueId: uuid(index * 10 + 1),
    seasonId: uuid(index * 10 + 2),
    fadId: uuid(index * 10 + 3),
    status: "deadline_locked",
    version: 2,
    updatedAtMs: 10_000,
    deadlineLockedAtMs: 10_000,
    allocationCount: 1,
    pendingAllocationCount: 1,
    schedule: Object.freeze({
      operationId: uuid(index * 10 + 4),
      version: 1,
      weekOneMatchupWeekId: uuid(index * 10 + 5),
      weekOneStartsAtMs: 100_000,
    }),
    ...overrides,
  });
}

function resultFor(root, overrides = {}) {
  const waiting = root.status === "allocating" &&
    root.pendingAllocationCount > 0;
  const toStatus = waiting
    ? null
    : root.status === "deadline_locked" &&
        root.allocationCount > 0
      ? "allocating"
      : "rapid";
  return Object.freeze({
    outcome: waiting ? "waiting" : "transitioned",
    fromStatus: root.status,
    toStatus,
    ...overrides,
  });
}

function runtime({
  candidates = [],
  coordinate,
  list,
  nowMs = 20_000,
  batchSize = 25,
} = {}) {
  const calls = {
    list: [],
    coordinate: [],
    errors: [],
  };
  const writer = {
    listCandidates(input) {
      calls.list.push(input);
      return list ? list(input) : candidates;
    },
  };
  const allocationLifecycleService = {
    coordinateRoot(root) {
      calls.coordinate.push(root);
      return coordinate
        ? coordinate(root)
        : resultFor(root);
    },
  };
  const logger = {
    error(...args) {
      calls.errors.push(args);
    },
  };
  const job =
    createCoordinateFreeAgentDraftAllocationsJob({
      writer,
      allocationLifecycleService,
      clock: { nowMs: () => nowMs },
      batchSize,
      logger,
    });
  return { calls, job };
}

describe("FAD allocation lifecycle root-scan job", () => {
  test("uses one bounded durable scan and accounts for start, wait, completion, and replay independently", async () => {
    const roots = [
      candidate(1),
      candidate(2, {
        status: "allocating",
        version: 3,
        allocationCount: 2,
        pendingAllocationCount: 1,
      }),
      candidate(3, {
        status: "allocating",
        version: 4,
        allocationCount: 2,
        pendingAllocationCount: 0,
      }),
      candidate(4, {
        allocationCount: 0,
        pendingAllocationCount: 0,
      }),
    ];
    const current = runtime({
      candidates: roots,
      batchSize: 4,
      coordinate(root) {
        if (root === roots[3]) {
          return resultFor(root, {
            outcome: "replayed",
            toStatus: "rapid",
          });
        }
        return resultFor(root);
      },
    });

    const result = await current.job.run();

    assert.deepEqual(current.calls.list, [
      { nowMs: 20_000, limit: 4 },
    ]);
    assert.deepEqual(current.calls.coordinate, roots);
    assert.deepEqual(result, {
      job: JOB_NAME,
      status: "succeeded",
      scanned: 4,
      startedAllocating: 1,
      enteredRapid: 1,
      waiting: 1,
      replayed: 1,
      skipped: 1,
      failed: 0,
    });
    assert.deepEqual(current.calls.errors, []);
  });

  test("continues across two independent FADs, treats stale CAS as a skip, and contains a malformed-row failure", async () => {
    const stale = candidate(5);
    const malformed = candidate(6);
    const succeeds = candidate(7, {
      status: "allocating",
      allocationCount: 1,
      pendingAllocationCount: 0,
    });
    const malformedError = new TypeError(
      "malformed persisted root"
    );
    const current = runtime({
      candidates: [stale, malformed, succeeds],
      coordinate(root) {
        if (root === stale) {
          throw {
            cause: {
              code: REPOSITORY_ERROR_CODES
                .versionConflict,
            },
          };
        }
        if (root === malformed) {
          throw malformedError;
        }
        return resultFor(root);
      },
    });

    const result = await current.job.run();

    assert.equal(result.status, "failed");
    assert.equal(result.scanned, 3);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.enteredRapid, 1);
    assert.equal(current.calls.coordinate.length, 3);
    assert.equal(current.calls.errors.length, 1);
    assert.deepEqual(current.calls.errors[0], [
      "free_agent_draft.allocation_lifecycle_root_failed",
      {
        job: JOB_NAME,
        leagueId: malformed.leagueId,
        seasonId: malformed.seasonId,
        fadId: malformed.fadId,
        classification: "transient",
      },
    ]);
  });

  test("contains top-level invalid clocks, list failures, oversized lists, and asynchronous services through the job runner", async () => {
    const listError = new Error("scan unavailable");
    for (const current of [
      runtime({ nowMs: -1 }),
      runtime({ list: () => { throw listError; } }),
      runtime({
        batchSize: 1,
        list: () => [candidate(8), candidate(9)],
      }),
    ]) {
      const result = await current.job.run();
      assert.equal(result.status, "failed");
      assert.equal(current.calls.errors.length, 1);
    }

    const asyncService = runtime({
      candidates: [candidate(10)],
      coordinate: async (root) => resultFor(root),
    });
    const asyncResult = await asyncService.job.run();
    assert.equal(asyncResult.status, "failed");
    assert.equal(asyncResult.failed, 1);
    assert.equal(asyncService.calls.errors.length, 1);
  });

  test("requires exact bounded dependencies and exposes overlap-safe runner state", async () => {
    assert.throws(
      () => createCoordinateFreeAgentDraftAllocationsJob(),
      TypeError
    );
    assert.throws(
      () =>
        createCoordinateFreeAgentDraftAllocationsJob({
          writer: { listCandidates() {} },
          allocationLifecycleService: {
            coordinateRoot() {},
          },
          clock: { nowMs() {} },
          logger: { error() {} },
          batchSize: 0,
        }),
      TypeError
    );
    assert.throws(
      () =>
        createCoordinateFreeAgentDraftAllocationsJob({
          writer: {},
          allocationLifecycleService: {
            coordinateRoot() {},
          },
          clock: { nowMs() {} },
          logger: { error() {} },
        }),
      TypeError
    );

    let release;
    const deferred = new Promise((resolve) => {
      release = resolve;
    });
    const current = runtime({
      list: async () => {
        await deferred;
        return [];
      },
    });
    const first = current.job.run();
    assert.equal(current.job.isRunning(), true);
    const overlap = await current.job.run();
    assert.deepEqual(overlap, {
      job: JOB_NAME,
      status: "skipped",
      reason: "overlap",
    });
    release();
    const terminal = await first;
    assert.equal(terminal.status, "failed");
    assert.equal(current.job.isRunning(), false);
  });
});
