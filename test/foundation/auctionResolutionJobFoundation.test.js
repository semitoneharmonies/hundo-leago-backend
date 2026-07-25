const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  JOB_NAME,
  createResolveTargetAuctionsJob,
} = require("../../src/jobs/definitions/resolveTargetAuctions");

const NOW_MS = Date.parse("2026-07-26T23:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  auction: uuid(3),
  run: uuid(4),
});

function dueAuction() {
  return {
    auctionId: IDS.auction,
    leagueId: IDS.league,
    seasonId: IDS.season,
    auctionVersion: 7,
    resolvesAtMs: NOW_MS,
    playoffsStartAtMs: NOW_MS + 1,
    dueAtMs: NOW_MS,
  };
}

function createRepository(overrides = {}) {
  return {
    listDue() {
      return [dueAuction()];
    },
    claimRun() {
      return {
        acquired: true,
        runId: IDS.run,
        version: 1,
        attemptCount: 1,
      };
    },
    succeedRun() {},
    failRun() {},
    ...overrides,
  };
}

function createJob({ repository, resolutionService }) {
  return createResolveTargetAuctionsJob({
    repository,
    resolutionService,
    clock: { nowMs: () => NOW_MS },
    secureRandom: { id: () => IDS.run },
    leaseOwner: "m5-03-worker",
    leaseDurationMs: 60_000,
    batchSize: 10,
    logger: { error() {} },
  });
}

describe("M5-03 target auction resolution job foundation", () => {
  test("marks success only after injected atomic completion confirms it", async () => {
    const calls = [];
    const repository = createRepository({
      listDue(input) {
        calls.push(["listDue", input]);
        return [dueAuction()];
      },
      claimRun(input) {
        calls.push(["claimRun", input]);
        return {
          acquired: true,
          runId: IDS.run,
          version: 1,
          attemptCount: 1,
        };
      },
      succeedRun(input) {
        calls.push(["succeedRun", input]);
      },
    });
    const job = createJob({
      repository,
      resolutionService: {
        async resolveDue(input) {
          calls.push(["resolveDue", input]);
          return {
            completed: true,
            status: "resolved",
            privateWinningBidValue: 999_999,
          };
        },
      },
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "succeeded",
      due: 1,
      acquired: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
    });
    assert.deepEqual(calls, [
      ["listDue", { nowMs: NOW_MS, limit: 10 }],
      [
        "claimRun",
        {
          jobRunId: IDS.run,
          leagueId: IDS.league,
          seasonId: IDS.season,
          occurrenceKey: `auction:${IDS.auction}:${NOW_MS}`,
          scheduledForMs: NOW_MS,
          leaseOwner: "m5-03-worker",
          nowMs: NOW_MS,
          leaseExpiresAtMs: NOW_MS + 60_000,
        },
      ],
      [
        "resolveDue",
        {
          leagueId: IDS.league,
          auctionId: IDS.auction,
          occurrenceKey: `auction:${IDS.auction}:${NOW_MS}`,
          expectedAuctionVersion: 7,
          nowMs: NOW_MS,
        },
      ],
      [
        "succeedRun",
        {
          leagueId: IDS.league,
          runId: IDS.run,
          leaseOwner: "m5-03-worker",
          expectedVersion: 1,
          completedAtMs: NOW_MS,
          auctionId: IDS.auction,
          outcome: "resolved",
        },
      ],
    ]);
    assert.equal(JSON.stringify(calls).includes("privateWinningBidValue"), false);
    assert.equal(JSON.stringify(calls).includes("999999"), false);
  });

  test("records a sanitized failure when atomic completion fails late", async () => {
    const failures = [];
    const repository = createRepository({
      failRun(input) {
        failures.push(input);
      },
    });
    const job = createJob({
      repository,
      resolutionService: {
        async resolveDue() {
          const error = new Error(
            "private bid values and a database connection string"
          );
          error.code = "AUCTION_RESOLUTION_ATOMIC_FAILED";
          throw error;
        },
      },
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "failed",
      due: 1,
      acquired: 1,
      completed: 0,
      failed: 1,
      skipped: 0,
    });
    assert.deepEqual(failures, [
      {
        leagueId: IDS.league,
        runId: IDS.run,
        leaseOwner: "m5-03-worker",
        expectedVersion: 1,
        completedAtMs: NOW_MS,
        errorCode: "AUCTION_RESOLUTION_ATOMIC_FAILED",
      },
    ]);
    assert.equal(JSON.stringify(failures).includes("private bid"), false);
  });

  test("does not mark an incomplete result successful", async () => {
    const calls = [];
    const repository = createRepository({
      succeedRun() {
        calls.push("success");
      },
      failRun(input) {
        calls.push(input.errorCode);
      },
    });
    const job = createJob({
      repository,
      resolutionService: {
        async resolveDue() {
          return { completed: false, status: "resolved" };
        },
      },
    });

    assert.equal((await job.run()).status, "failed");
    assert.deepEqual(calls, ["AUCTION_RESOLUTION_INCOMPLETE"]);
  });

  test("skips local overlap while allowing the first run to finish", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const job = createJob({
      repository: createRepository(),
      resolutionService: {
        async resolveDue() {
          await gate;
          return { completed: true, status: "no_winner" };
        },
      },
    });

    const first = job.run();
    assert.equal(job.isRunning(), true);
    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "skipped",
      reason: "overlap",
    });
    release();
    assert.equal((await first).status, "succeeded");
    assert.equal(job.isRunning(), false);
  });
});
