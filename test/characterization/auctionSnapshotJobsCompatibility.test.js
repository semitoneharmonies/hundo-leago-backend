const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createResolveCompatibilityAuctionsService,
} = require(
  "../../src/application/services/auctions/resolveCompatibilityAuctions"
);
const {
  createResolveAuctionsJob,
} = require(
  "../../src/jobs/definitions/resolveAuctions"
);
const {
  createWeeklySnapshotJob,
} = require(
  "../../src/jobs/definitions/createWeeklySnapshot"
);
const {
  BUYOUT_LOCK_MS,
  resolveCompatibilityAuctions,
} = require(
  "../../src/domain/auctions/resolveCompatibilityAuctions"
);
const {
  createFakePublisher,
} = require("../helpers/fakePublisher");

function makeState({ freeAgents = [] } = {}) {
  return {
    teams: [
      {
        name: "Alpha",
        roster: [
          {
            name: "Existing Defense",
            salary: 9,
            position: "D",
          },
          {
            name: "Existing Forward",
            salary: 1,
            position: "F",
          },
        ],
        buyouts: [{ name: "Old Buyout" }],
      },
      {
        name: "Beta",
        roster: [],
        buyouts: [],
      },
    ],
    freeAgents,
    leagueLog: [{ type: "existing", id: 1 }],
  };
}

function createMemoryStore(initialState, order = []) {
  let state = structuredClone(initialState);
  const saves = [];
  let saveFailure = null;

  return {
    loadLeague() {
      return structuredClone(state);
    },
    async saveLeague(nextState, meta) {
      order.push("save");
      if (saveFailure) throw saveFailure;
      state = structuredClone(nextState);
      saves.push({
        state: structuredClone(nextState),
        meta: structuredClone(meta),
      });
    },
    failSave(error) {
      saveFailure = error;
    },
    saves,
    state() {
      return structuredClone(state);
    },
  };
}

function silentLogger() {
  return {
    error() {},
    log() {},
  };
}

describe(
  "current compatibility auction calculation",
  () => {
    test("no active bids preserve current state values", () => {
      const state = makeState({
        freeAgents: [
          {
            id: "resolved",
            resolved: true,
          },
        ],
      });
      const before = structuredClone(state);

      const result = resolveCompatibilityAuctions({
        state,
        nowMs: 1000,
        createLogId: () => "unused",
      });

      assert.deepEqual(result, {
        nextTeams: state.teams,
        nextFreeAgents: state.freeAgents,
        nextLeagueLog: state.leagueLog,
        newLogs: [],
      });
      assert.deepEqual(state, before);
    });

    test("single bid creates the current roster record, buyout lock, and leading activity", () => {
      const nowMs = 10_000;
      const state = makeState({
        freeAgents: [
          {
            id: "bid-1",
            auctionKey: "id:1001",
            player: "Signed Player",
            team: "Alpha",
            amount: "5",
            position: "F",
            timestamp: 100,
          },
        ],
      });
      const before = structuredClone(state);

      const result = resolveCompatibilityAuctions({
        state,
        nowMs,
        createLogId: () => "log-1",
      });

      assert.deepEqual(
        result.nextTeams[0].roster,
        [
          {
            name: "Signed Player",
            salary: 5,
            position: "F",
            buyoutLockedUntil:
              nowMs + BUYOUT_LOCK_MS,
          },
          {
            name: "Existing Forward",
            salary: 1,
            position: "F",
          },
          {
            name: "Existing Defense",
            salary: 9,
            position: "D",
          },
        ]
      );
      assert.deepEqual(result.nextFreeAgents, []);
      assert.deepEqual(result.newLogs, [
        {
          type: "faSigned",
          id: "log-1",
          team: "Alpha",
          player: "Signed Player",
          amount: 5,
          position: "F",
          timestamp: nowMs,
        },
      ]);
      assert.deepEqual(result.nextLeagueLog, [
        result.newLogs[0],
        state.leagueLog[0],
      ]);
      assert.deepEqual(state, before);
    });

    test("multiple bids use highest amount and earliest timestamp for a tie", () => {
      const state = makeState({
        freeAgents: [
          {
            id: "lower",
            auctionKey: "ID:1001",
            player: "Tie Player",
            team: "Beta",
            amount: 6,
            timestamp: 1,
          },
          {
            id: "later",
            auctionKey: "id:1001",
            player: "Tie Player",
            team: "Beta",
            amount: 7,
            timestamp: 30,
          },
          {
            id: "earlier",
            auctionKey: "id:1001",
            player: "Tie Player",
            team: "Alpha",
            amount: 7,
            timestamp: 20,
          },
        ],
      });

      const result = resolveCompatibilityAuctions({
        state,
        nowMs: 2000,
        createLogId: () => "tie-log",
      });

      assert.equal(result.newLogs.length, 1);
      assert.equal(result.newLogs[0].team, "Alpha");
      assert.equal(result.newLogs[0].amount, 7);
      assert.deepEqual(result.nextFreeAgents, []);
      assert.equal(
        result.nextTeams[0].roster[0].name,
        "Tie Player"
      );
    });

    test("missing winning team removes grouped bids without signing or activity", () => {
      const ungrouped = {
        id: "blank",
        player: "   ",
        team: "Alpha",
        amount: 2,
      };
      const state = makeState({
        freeAgents: [
          {
            id: "missing-team",
            auctionKey: "id:9999",
            player: "Missing Team Player",
            team: "Does Not Exist",
            amount: 8,
          },
          ungrouped,
        ],
      });
      const before = structuredClone(state);

      const result = resolveCompatibilityAuctions({
        state,
        nowMs: 3000,
        createLogId: () => "unused",
      });

      assert.deepEqual(result.nextFreeAgents, [
        ungrouped,
      ]);
      assert.deepEqual(result.newLogs, []);
      assert.deepEqual(
        result.nextLeagueLog,
        state.leagueLog
      );
      assert.deepEqual(state, before);
    });
  }
);

describe(
  "compatibility auction resolution service",
  () => {
    test("saves one resolved projection and marker before publishing", async () => {
      const order = [];
      const store = createMemoryStore(
        makeState({
          freeAgents: [
            {
              id: "bid-1",
              auctionKey: "id:1001",
              player: "Service Player",
              team: "Beta",
              amount: 4,
              timestamp: 100,
            },
          ],
        }),
        order
      );
      const publisher = {
        calls: [],
        async publish(eventName, payload) {
          order.push("publish");
          this.calls.push({ eventName, payload });
        },
      };
      const service =
        createResolveCompatibilityAuctionsService({
          leagueStore: store,
          publisher,
          createLogId: () => "service-log",
        });

      const result = await service.resolve({
        nowMs: 5000,
        rolloverId: "auction-2026-01-04-1600PT",
      });

      assert.equal(result.status, "succeeded");
      assert.equal(result.signings, 1);
      assert.equal(result.newLogs[0].id, "service-log");
      assert.deepEqual(order, ["save", "publish"]);
      assert.equal(store.saves.length, 1);
      assert.deepEqual(store.saves[0].meta, {
        savedBy: "system:autoAuctionRollover",
      });
      assert.equal(
        store.state().lastAutoAuctionRolloverId,
        "auction-2026-01-04-1600PT"
      );
      assert.deepEqual(publisher.calls, [
        {
          eventName: "league:updated",
          payload: {
            reason: "autoAuctionRollover",
            rolloverId:
              "auction-2026-01-04-1600PT",
          },
        },
      ]);
    });

    test("no bids still commit one occurrence while duplicate and restart runs skip", async () => {
      const store = createMemoryStore(makeState());
      const publisher = createFakePublisher();
      const firstService =
        createResolveCompatibilityAuctionsService({
          leagueStore: store,
          publisher,
        });
      const restartedService =
        createResolveCompatibilityAuctionsService({
          leagueStore: store,
          publisher,
        });
      const input = {
        nowMs: 6000,
        rolloverId: "auction-2026-01-11-1600PT",
      };

      const first = await firstService.resolve(input);
      const duplicate =
        await firstService.resolve(input);
      const restarted =
        await restartedService.resolve(input);

      assert.equal(first.status, "succeeded");
      assert.equal(first.signings, 0);
      assert.equal(duplicate.status, "skipped");
      assert.equal(duplicate.reason, "alreadyResolved");
      assert.equal(restarted.status, "skipped");
      assert.equal(store.saves.length, 1);
      assert.equal(publisher.calls.length, 1);
    });

    test("save failure prevents publishing and event failure follows committed state", async () => {
      const state = makeState({
        freeAgents: [
          {
            id: "bid-1",
            auctionKey: "id:1001",
            player: "Failure Player",
            team: "Alpha",
            amount: 3,
          },
        ],
      });
      const saveStore = createMemoryStore(state);
      saveStore.failSave(new Error("save failed"));
      const savePublisher = createFakePublisher();
      const saveService =
        createResolveCompatibilityAuctionsService({
          leagueStore: saveStore,
          publisher: savePublisher,
        });

      await assert.rejects(
        saveService.resolve({
          nowMs: 7000,
          rolloverId:
            "auction-2026-01-18-1600PT",
        }),
        /save failed/
      );
      assert.equal(saveStore.saves.length, 0);
      assert.equal(savePublisher.calls.length, 0);

      const eventStore = createMemoryStore(state);
      const eventPublisher = createFakePublisher();
      eventPublisher.failNext(
        new Error("event failed")
      );
      const eventService =
        createResolveCompatibilityAuctionsService({
          leagueStore: eventStore,
          publisher: eventPublisher,
        });

      await assert.rejects(
        eventService.resolve({
          nowMs: 7000,
          rolloverId:
            "auction-2026-01-18-1600PT",
        }),
        /event failed/
      );
      assert.equal(eventStore.saves.length, 1);
      assert.equal(
        eventStore.state().lastAutoAuctionRolloverId,
        "auction-2026-01-18-1600PT"
      );
    });
  }
);

describe(
  "automatic compatibility auction job",
  { concurrency: false },
  () => {
    test("skips before Sunday deadline and runs exactly at the boundary", async () => {
      const calls = [];
      const resolutionService = {
        async resolve(input) {
          calls.push(input);
          return {
            status: "succeeded",
            rolloverId: input.rolloverId,
            signings: 2,
          };
        },
      };
      const saturdayJob = createResolveAuctionsJob({
        resolutionService,
        clock: {
          nowMs: () =>
            Date.parse("2026-01-04T07:59:00Z"),
        },
        logger: silentLogger(),
      });
      const beforeJob = createResolveAuctionsJob({
        resolutionService,
        clock: {
          nowMs: () =>
            Date.parse("2026-01-04T23:59:00Z"),
        },
        logger: silentLogger(),
      });
      const atMs = Date.parse(
        "2026-01-05T00:00:00Z"
      );
      const atJob = createResolveAuctionsJob({
        resolutionService,
        clock: { nowMs: () => atMs },
        logger: silentLogger(),
      });

      assert.equal(
        (await saturdayJob.run()).reason,
        "notSunday"
      );
      assert.equal(
        (await beforeJob.run()).reason,
        "beforeDeadline"
      );
      assert.deepEqual(await atJob.run(), {
        job: "auctions:resolve",
        status: "succeeded",
        rolloverId:
          "auction-2026-01-04-1600PT",
        signings: 2,
      });
      assert.deepEqual(calls, [
        {
          nowMs: atMs,
          rolloverId:
            "auction-2026-01-04-1600PT",
        },
      ]);
    });

    test("after-deadline runs use the same Sunday occurrence marker", async () => {
      const calls = [];
      const job = createResolveAuctionsJob({
        resolutionService: {
          async resolve(input) {
            calls.push(input);
            return {
              status: "skipped",
              reason: "alreadyResolved",
              rolloverId: input.rolloverId,
              signings: 0,
            };
          },
        },
        clock: {
          nowMs: () =>
            Date.parse("2026-01-05T05:30:00Z"),
        },
        logger: silentLogger(),
      });

      const result = await job.run();
      assert.equal(result.status, "skipped");
      assert.equal(result.reason, "alreadyResolved");
      assert.equal(
        calls[0].rolloverId,
        "auction-2026-01-04-1600PT"
      );
    });

    test("overlap is skipped and service failures permit retry", async () => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let attempts = 0;
      const job = createResolveAuctionsJob({
        resolutionService: {
          async resolve(input) {
            attempts += 1;
            if (attempts === 1) {
              await gate;
              throw new Error("resolution failed");
            }
            return {
              status: "succeeded",
              rolloverId: input.rolloverId,
              signings: 0,
            };
          },
        },
        clock: {
          nowMs: () =>
            Date.parse("2026-01-05T00:00:00Z"),
        },
        logger: silentLogger(),
      });

      const firstRun = job.run();
      assert.equal(
        (await job.run()).reason,
        "overlap"
      );
      release();
      const failed = await firstRun;
      assert.equal(failed.status, "failed");
      assert.equal(
        failed.error.message,
        "resolution failed"
      );
      assert.equal((await job.run()).status, "succeeded");
      assert.equal(attempts, 2);
    });
  }
);

describe(
  "automatic weekly snapshot job",
  { concurrency: false },
  () => {
    test("skips before Sunday deadline and commits artifact, marker, then event exactly at it", async () => {
      const beforeStore = createMemoryStore(
        makeState()
      );
      const beforeJob = createWeeklySnapshotJob({
        leagueStore: beforeStore,
        snapshotRepository: {
          writeSnapshot() {
            throw new Error(
              "should not write before deadline"
            );
          },
        },
        clock: {
          nowMs: () =>
            Date.parse("2026-01-04T23:59:00Z"),
        },
        logger: silentLogger(),
      });
      assert.equal(
        (await beforeJob.run()).reason,
        "beforeDeadline"
      );

      const order = [];
      const store = createMemoryStore(
        makeState(),
        order
      );
      const snapshots = [];
      const publisher = {
        calls: [],
        async publish(eventName, payload) {
          order.push("publish");
          this.calls.push({ eventName, payload });
        },
      };
      const atJob = createWeeklySnapshotJob({
        leagueStore: store,
        snapshotRepository: {
          async writeSnapshot(snapshotId, state) {
            order.push("writeSnapshot");
            snapshots.push({
              snapshotId,
              state: structuredClone(state),
            });
          },
        },
        publisher,
        clock: {
          nowMs: () =>
            Date.parse("2026-01-05T00:00:00Z"),
        },
        logger: silentLogger(),
      });

      assert.deepEqual(await atJob.run(), {
        job: "snapshots:createWeekly",
        status: "succeeded",
        snapshotId:
          "auto-2026-01-04-1600PT",
      });
      assert.deepEqual(order, [
        "writeSnapshot",
        "save",
        "publish",
      ]);
      assert.equal(
        snapshots[0].state.lastAutoWeeklySnapshotId,
        undefined
      );
      assert.equal(
        store.state().lastAutoWeeklySnapshotId,
        "auto-2026-01-04-1600PT"
      );
      assert.deepEqual(store.saves[0].meta, {
        savedBy: "system:autoWeeklySnapshot",
      });
      assert.deepEqual(publisher.calls, [
        {
          eventName: "league:updated",
          payload: {
            reason: "autoWeeklySnapshot",
            snapshotId:
              "auto-2026-01-04-1600PT",
          },
        },
      ]);
    });

    test("after-deadline duplicate and recreated jobs run only once for one occurrence", async () => {
      const store = createMemoryStore(makeState());
      const writes = [];
      const snapshotRepository = {
        writeSnapshot(snapshotId) {
          writes.push(snapshotId);
        },
      };
      const publisher = createFakePublisher();
      const dependencies = {
        leagueStore: store,
        snapshotRepository,
        publisher,
        clock: {
          nowMs: () =>
            Date.parse("2026-01-05T05:30:00Z"),
        },
        logger: silentLogger(),
      };
      const firstJob =
        createWeeklySnapshotJob(dependencies);
      const restartedJob =
        createWeeklySnapshotJob(dependencies);

      assert.equal(
        (await firstJob.run()).status,
        "succeeded"
      );
      assert.equal(
        (await firstJob.run()).reason,
        "alreadyCreated"
      );
      assert.equal(
        (await restartedJob.run()).reason,
        "alreadyCreated"
      );
      assert.deepEqual(writes, [
        "auto-2026-01-04-1600PT",
      ]);
      assert.equal(store.saves.length, 1);
      assert.equal(publisher.calls.length, 1);
    });

    test("snapshot, save, and event failures report the committed boundary", async () => {
      const snapshotStore = createMemoryStore(
        makeState()
      );
      const snapshotPublisher =
        createFakePublisher();
      const snapshotJob = createWeeklySnapshotJob({
        leagueStore: snapshotStore,
        snapshotRepository: {
          writeSnapshot() {
            throw new Error("snapshot failed");
          },
        },
        publisher: snapshotPublisher,
        clock: {
          nowMs: () =>
            Date.parse("2026-01-05T00:00:00Z"),
        },
        logger: silentLogger(),
      });
      const snapshotResult = await snapshotJob.run();
      assert.equal(snapshotResult.status, "failed");
      assert.equal(snapshotStore.saves.length, 0);
      assert.equal(snapshotPublisher.calls.length, 0);

      const saveStore = createMemoryStore(makeState());
      saveStore.failSave(new Error("save failed"));
      const savePublisher = createFakePublisher();
      let saveArtifactWrites = 0;
      const saveJob = createWeeklySnapshotJob({
        leagueStore: saveStore,
        snapshotRepository: {
          writeSnapshot() {
            saveArtifactWrites += 1;
          },
        },
        publisher: savePublisher,
        clock: {
          nowMs: () =>
            Date.parse("2026-01-05T00:00:00Z"),
        },
        logger: silentLogger(),
      });
      const saveResult = await saveJob.run();
      assert.equal(saveResult.status, "failed");
      assert.equal(saveArtifactWrites, 1);
      assert.equal(saveStore.saves.length, 0);
      assert.equal(savePublisher.calls.length, 0);

      const eventStore = createMemoryStore(makeState());
      const eventPublisher = createFakePublisher();
      eventPublisher.failNext(
        new Error("event failed")
      );
      const eventJob = createWeeklySnapshotJob({
        leagueStore: eventStore,
        snapshotRepository: {
          writeSnapshot() {},
        },
        publisher: eventPublisher,
        clock: {
          nowMs: () =>
            Date.parse("2026-01-05T00:00:00Z"),
        },
        logger: silentLogger(),
      });
      const eventResult = await eventJob.run();
      assert.equal(eventResult.status, "failed");
      assert.equal(eventStore.saves.length, 1);
      assert.equal(
        eventStore.state().lastAutoWeeklySnapshotId,
        "auto-2026-01-04-1600PT"
      );
    });

    test("snapshot overlap is skipped and a later retry can run", async () => {
      const store = createMemoryStore(makeState());
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let attempts = 0;
      const job = createWeeklySnapshotJob({
        leagueStore: store,
        snapshotRepository: {
          async writeSnapshot() {
            attempts += 1;
            if (attempts === 1) {
              await gate;
              throw new Error("snapshot failed");
            }
          },
        },
        clock: {
          nowMs: () =>
            Date.parse("2026-01-05T00:00:00Z"),
        },
        logger: silentLogger(),
      });

      const firstRun = job.run();
      assert.equal(
        (await job.run()).reason,
        "overlap"
      );
      release();
      assert.equal((await firstRun).status, "failed");
      assert.equal((await job.run()).status, "succeeded");
      assert.equal(attempts, 2);
    });
  }
);
