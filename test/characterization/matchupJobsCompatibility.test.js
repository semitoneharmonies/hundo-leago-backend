const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createApplyRosterLocksJob,
} = require(
  "../../src/jobs/definitions/applyRosterLocks"
);
const {
  createCaptureMatchupBaselineJob,
} = require(
  "../../src/jobs/definitions/captureMatchupBaseline"
);
const {
  createFinalizeMatchupResultsJob,
} = require(
  "../../src/jobs/definitions/finalizeMatchupResults"
);
const {
  createRolloverMatchupWeekJob,
} = require(
  "../../src/jobs/definitions/rolloverMatchupWeek"
);
const {
  startMatchupScheduler,
} = require("../../src/jobs/startScheduler");
const {
  createJobRunner,
} = require("../../src/jobs/runJob");
const {
  createFakePublisher,
} = require("../helpers/fakePublisher");

function makeState({
  weekStartAtMs = 1000,
  lockAtMs = 2000,
  currentWeekIndex = 0,
  locksByTeam = {},
} = {}) {
  return {
    teams: [
      {
        name: "Legal Team",
        roster: [{ playerId: "1001" }],
      },
      {
        name: "Illegal Team",
        roster: [],
      },
    ],
    matchups: {
      currentWeekIndex,
      scheduleWeeks: [
        {
          weekId: "week-1",
          weekStartAtMs,
          lockAtMs,
        },
      ],
      locksByTeam,
    },
  };
}

function createMemoryStore(initialState) {
  let state = structuredClone(initialState);
  const saves = [];
  let saveImplementation = null;

  return {
    loadLeague() {
      return structuredClone(state);
    },
    async saveLeague(nextState, meta) {
      if (saveImplementation) {
        await saveImplementation(nextState, meta);
      }
      state = structuredClone(nextState);
      saves.push({
        state: structuredClone(nextState),
        meta: structuredClone(meta),
      });
    },
    saves,
    setSaveImplementation(implementation) {
      saveImplementation = implementation;
    },
    state() {
      return structuredClone(state);
    },
  };
}

function silentLogger() {
  return { error() {} };
}

function createStatisticsRepository({
  exists = true,
  stats = {
    seasonId: "season-1",
    lastUpdatedAt: 1800,
    byPlayerId: {
      1001: {
        goals: 3,
        assists: 4,
        gamesPlayed: 10,
      },
      1002: {
        goals: "invalid",
        assists: 2,
        gamesPlayed: null,
      },
    },
  },
} = {}) {
  return {
    cacheExists() {
      return exists;
    },
    readCache() {
      return structuredClone(stats);
    },
  };
}

function makeFinalizationState() {
  const state = makeState();
  state.matchups.scheduleWeeks[0].baselineAtMs = 1500;
  state.matchups.scheduleWeeks[0].weekEndAtMs = 3000;
  state.matchups.locksByTeam = {
    "Legal Team": {
      lockedAtMs: 2000,
      weekIndex: 0,
    },
  };
  state.matchups.baselineByWeekId = {
    "week-1": {
      weekId: "week-1",
      capturedAtMs: 1500,
      statsLastUpdatedAt: 1500,
      byPlayerId: {
        1001: {
          goals: 1,
          assists: 1,
          gamesPlayed: 8,
          fp: 2.25,
        },
      },
    },
  };
  state.matchups.resultsByWeek = {};
  return state;
}

function makeRolloverState() {
  const state = makeFinalizationState();
  state.matchups.scheduleWeeks[0].rolloverAtMs = 4000;
  state.matchups.scheduleWeeks.push({
    weekId: "week-2",
    weekStartAtMs: 4000,
    baselineAtMs: 4500,
    lockAtMs: 5000,
    weekEndAtMs: 6000,
    rolloverAtMs: 7000,
  });
  state.matchups.resultsByWeek["week-1"] = {
    weekId: "week-1",
    finalizedAtMs: 3000,
    perTeam: {},
  };
  state.matchups.currentWeekId = "week-1";
  state.matchups.lastRolloverWeekId = null;
  return state;
}

describe(
  "matchup job compatibility",
  { concurrency: false },
  () => {
    test("shared job runner reports failure and permits a later retry", async () => {
      let attempts = 0;
      const logged = [];
      const runner = createJobRunner({
        name: "test:retry",
        async execute() {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("first attempt failed");
          }
          return {
            status: "succeeded",
            attempts,
          };
        },
        logger: {
          error(...input) {
            logged.push(input);
          },
        },
      });

      const failed = await runner.run();
      assert.equal(failed.status, "failed");
      assert.equal(
        failed.error.message,
        "first attempt failed"
      );
      assert.deepEqual(logged, [
        [
          "job_runner.failed",
          {
            job: "test:retry",
            error: failed.error,
          },
        ],
      ]);
      assert.equal(runner.isRunning(), false);
      assert.deepEqual(await runner.run(), {
        job: "test:retry",
        status: "succeeded",
        attempts: 2,
      });
    });

    test("roster locks skip before the boundary and apply exactly at it", async () => {
      const beforeStore = createMemoryStore(makeState());
      const beforeJob = createApplyRosterLocksJob({
        leagueStore: beforeStore,
        clock: { nowMs: () => 1999 },
        logger: silentLogger(),
      });

      assert.deepEqual(await beforeJob.run(), {
        job: "matchups:applyRosterLocks",
        status: "skipped",
        reason: "beforeLockTime",
      });
      assert.equal(beforeStore.saves.length, 0);

      const atStore = createMemoryStore(makeState());
      const publisher = createFakePublisher();
      const atJob = createApplyRosterLocksJob({
        leagueStore: atStore,
        publisher,
        clock: { nowMs: () => 2000 },
        logger: silentLogger(),
      });

      assert.deepEqual(await atJob.run(), {
        job: "matchups:applyRosterLocks",
        status: "succeeded",
        currentWeekIndex: 0,
        lockedTeams: ["Legal Team"],
      });
      assert.deepEqual(
        atStore.state().matchups.locksByTeam,
        {
          "Legal Team": {
            lockedAtMs: 2000,
            weekIndex: 0,
          },
        }
      );
      assert.deepEqual(atStore.saves[0].meta, {
        savedBy: "system:rosterLock",
      });
      assert.deepEqual(publisher.calls, [
        {
          eventName: "league:updated",
          payload: {
            reason: "matchups:rosterLocked",
          },
        },
      ]);
    });

    test("roster locks preserve duplicate and new-week idempotency markers", async () => {
      const store = createMemoryStore(
        makeState({
          locksByTeam: {
            "Legal Team": {
              lockedAtMs: 1500,
              weekIndex: 0,
            },
          },
        })
      );
      const duplicateJob = createApplyRosterLocksJob({
        leagueStore: store,
        clock: { nowMs: () => 2500 },
        logger: silentLogger(),
      });

      assert.equal(
        (await duplicateJob.run()).reason,
        "noEligibleTeams"
      );
      assert.equal(store.saves.length, 0);

      const nextState = makeState({
        currentWeekIndex: 1,
        locksByTeam: {
          "Legal Team": {
            lockedAtMs: 1500,
            weekIndex: 0,
          },
        },
      });
      nextState.matchups.scheduleWeeks.push({
        weekId: "week-2",
        weekStartAtMs: 3000,
        lockAtMs: 4000,
      });
      const restartStore = createMemoryStore(nextState);
      const restartJob = createApplyRosterLocksJob({
        leagueStore: restartStore,
        clock: { nowMs: () => 4000 },
        logger: silentLogger(),
      });

      assert.equal(
        (await restartJob.run()).status,
        "succeeded"
      );
      assert.deepEqual(
        restartStore.state().matchups.locksByTeam[
          "Legal Team"
        ],
        {
          lockedAtMs: 4000,
          weekIndex: 1,
        }
      );
    });

    test("roster locks report invalid state, save failure, and event failure", async () => {
      const invalidStore = createMemoryStore({
        teams: [],
        matchups: {},
      });
      const invalidJob = createApplyRosterLocksJob({
        leagueStore: invalidStore,
        clock: { nowMs: () => 2000 },
        logger: silentLogger(),
      });
      assert.equal((await invalidJob.run()).reason, "noWeek");

      const saveStore = createMemoryStore(makeState());
      saveStore.setSaveImplementation(async () => {
        throw new Error("save failed");
      });
      const savePublisher = createFakePublisher();
      const saveJob = createApplyRosterLocksJob({
        leagueStore: saveStore,
        publisher: savePublisher,
        clock: { nowMs: () => 2000 },
        logger: silentLogger(),
      });
      const saveResult = await saveJob.run();
      assert.equal(saveResult.status, "failed");
      assert.equal(saveResult.error.message, "save failed");
      assert.equal(saveStore.saves.length, 0);
      assert.equal(savePublisher.calls.length, 0);

      const eventStore = createMemoryStore(makeState());
      const eventPublisher = createFakePublisher();
      eventPublisher.failNext(new Error("event failed"));
      const eventJob = createApplyRosterLocksJob({
        leagueStore: eventStore,
        publisher: eventPublisher,
        clock: { nowMs: () => 2000 },
        logger: silentLogger(),
      });
      const eventResult = await eventJob.run();
      assert.equal(eventResult.status, "failed");
      assert.equal(eventResult.error.message, "event failed");
      assert.equal(eventStore.saves.length, 1);
    });

    test("roster lock overlap is skipped and a later retry can run", async () => {
      const store = createMemoryStore(makeState());
      let releaseSave;
      const saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
      store.setSaveImplementation(async () => {
        await saveGate;
      });
      const job = createApplyRosterLocksJob({
        leagueStore: store,
        clock: { nowMs: () => 2000 },
        logger: silentLogger(),
      });

      const firstRun = job.run();
      assert.equal(job.isRunning(), true);
      assert.deepEqual(await job.run(), {
        job: "matchups:applyRosterLocks",
        status: "skipped",
        reason: "overlap",
      });

      releaseSave();
      assert.equal((await firstRun).status, "succeeded");
      assert.equal(job.isRunning(), false);
      assert.equal(
        (await job.run()).reason,
        "noEligibleTeams"
      );
    });

    test("baseline capture skips before the boundary and snapshots statistics exactly at it", async () => {
      const beforeState = makeState();
      beforeState.matchups.scheduleWeeks[0].baselineAtMs =
        1500;
      const beforeStore = createMemoryStore(beforeState);
      const beforeJob = createCaptureMatchupBaselineJob({
        leagueStore: beforeStore,
        statisticsRepository:
          createStatisticsRepository(),
        clock: { nowMs: () => 1499 },
        logger: silentLogger(),
      });

      assert.equal(
        (await beforeJob.run()).reason,
        "beforeBaselineTime"
      );
      assert.equal(beforeStore.saves.length, 0);

      const atStore = createMemoryStore(beforeState);
      const publisher = createFakePublisher();
      const atJob = createCaptureMatchupBaselineJob({
        leagueStore: atStore,
        statisticsRepository:
          createStatisticsRepository(),
        publisher,
        clock: { nowMs: () => 1500 },
        logger: silentLogger(),
      });

      assert.deepEqual(await atJob.run(), {
        job: "matchups:captureBaseline",
        status: "succeeded",
        weekId: "week-1",
        playerCount: 2,
      });
      assert.deepEqual(
        atStore.state().matchups.baselineByWeekId[
          "week-1"
        ],
        {
          weekId: "week-1",
          capturedAtMs: 1500,
          statsSeasonId: "season-1",
          statsLastUpdatedAt: 1800,
          byPlayerId: {
            1001: {
              goals: 3,
              assists: 4,
              gamesPlayed: 10,
              fp: 7.75,
            },
            1002: {
              goals: 0,
              assists: 2,
              gamesPlayed: 0,
              fp: 2,
            },
          },
        }
      );
      assert.deepEqual(atStore.saves[0].meta, {
        savedBy: "system:baselineCapture",
      });
      assert.deepEqual(publisher.calls, [
        {
          eventName: "league:updated",
          payload: {
            reason: "matchups:baselineCaptured",
            weekId: "week-1",
          },
        },
      ]);
    });

    test("baseline capture preserves its per-week marker across duplicate and restart runs", async () => {
      const state = makeState();
      state.matchups.scheduleWeeks[0].baselineAtMs = 1500;
      state.matchups.baselineByWeekId = {
        "week-1": {
          weekId: "week-1",
          capturedAtMs: 1500,
          byPlayerId: {},
        },
      };
      const store = createMemoryStore(state);

      const firstProcessJob =
        createCaptureMatchupBaselineJob({
          leagueStore: store,
          statisticsRepository:
            createStatisticsRepository(),
          clock: { nowMs: () => 1600 },
          logger: silentLogger(),
        });
      const restartedJob =
        createCaptureMatchupBaselineJob({
          leagueStore: store,
          statisticsRepository:
            createStatisticsRepository(),
          clock: { nowMs: () => 1700 },
          logger: silentLogger(),
        });

      assert.equal(
        (await firstProcessJob.run()).reason,
        "alreadyCaptured"
      );
      assert.equal(
        (await restartedJob.run()).reason,
        "alreadyCaptured"
      );
      assert.equal(store.saves.length, 0);
      assert.equal(
        store.state().matchups.baselineByWeekId[
          "week-1"
        ].capturedAtMs,
        1500
      );
    });

    test("baseline capture reports missing statistics and preserves state", async () => {
      const state = makeState();
      state.matchups.scheduleWeeks[0].baselineAtMs = 1500;

      const missingStore = createMemoryStore(state);
      const missingJob =
        createCaptureMatchupBaselineJob({
          leagueStore: missingStore,
          statisticsRepository:
            createStatisticsRepository({
              exists: false,
            }),
          clock: { nowMs: () => 1500 },
          logger: silentLogger(),
        });
      assert.equal(
        (await missingJob.run()).reason,
        "statsCacheMissing"
      );
      assert.equal(missingStore.saves.length, 0);

      const malformedStore = createMemoryStore(state);
      const malformedJob =
        createCaptureMatchupBaselineJob({
          leagueStore: malformedStore,
          statisticsRepository:
            createStatisticsRepository({
              stats: { byPlayerId: null },
            }),
          clock: { nowMs: () => 1500 },
          logger: silentLogger(),
        });
      assert.equal(
        (await malformedJob.run()).reason,
        "statsByPlayerMissing"
      );
      assert.equal(malformedStore.saves.length, 0);
    });

    test("baseline capture awaits saves, guards overlap, and reports event failure", async () => {
      const state = makeState();
      state.matchups.scheduleWeeks[0].baselineAtMs = 1500;
      const store = createMemoryStore(state);
      let releaseSave;
      const saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
      store.setSaveImplementation(async () => {
        await saveGate;
      });
      const job = createCaptureMatchupBaselineJob({
        leagueStore: store,
        statisticsRepository:
          createStatisticsRepository(),
        clock: { nowMs: () => 1500 },
        logger: silentLogger(),
      });

      const firstRun = job.run();
      assert.equal(
        (await job.run()).reason,
        "overlap"
      );
      releaseSave();
      assert.equal((await firstRun).status, "succeeded");

      const eventStore = createMemoryStore(state);
      const publisher = createFakePublisher();
      publisher.failNext(new Error("event failed"));
      const eventJob =
        createCaptureMatchupBaselineJob({
          leagueStore: eventStore,
          statisticsRepository:
            createStatisticsRepository(),
          publisher,
          clock: { nowMs: () => 1500 },
          logger: silentLogger(),
        });
      const eventResult = await eventJob.run();
      assert.equal(eventResult.status, "failed");
      assert.equal(eventResult.error.message, "event failed");
      assert.equal(eventStore.saves.length, 1);
    });

    test("finalization skips before week end and stores compatible scores exactly at it", async () => {
      const state = makeFinalizationState();
      const beforeStore = createMemoryStore(state);
      const beforeJob =
        createFinalizeMatchupResultsJob({
          leagueStore: beforeStore,
          statisticsRepository:
            createStatisticsRepository(),
          clock: { nowMs: () => 2999 },
          logger: silentLogger(),
        });
      assert.equal(
        (await beforeJob.run()).reason,
        "beforeWeekEnd"
      );
      assert.equal(beforeStore.saves.length, 0);

      const atStore = createMemoryStore(state);
      const publisher = createFakePublisher();
      const atJob = createFinalizeMatchupResultsJob({
        leagueStore: atStore,
        statisticsRepository:
          createStatisticsRepository(),
        publisher,
        clock: { nowMs: () => 3000 },
        logger: silentLogger(),
      });

      assert.deepEqual(await atJob.run(), {
        job: "matchups:finalizeResults",
        status: "succeeded",
        weekId: "week-1",
        teamCount: 2,
      });
      assert.deepEqual(
        atStore.state().matchups.resultsByWeek[
          "week-1"
        ],
        {
          weekId: "week-1",
          finalizedAtMs: 3000,
          weekIndex: 0,
          weekEndAtMs: 3000,
          baselineCapturedAtMs: 1500,
          baselineStatsLastUpdatedAt: 1500,
          statsLastUpdatedAt: 1800,
          perTeam: {
            "Legal Team": {
              weeklyFP: 5.5,
              locked: true,
              lockedAtMs: 2000,
            },
            "Illegal Team": {
              weeklyFP: 0,
              locked: false,
              lockedAtMs: null,
            },
          },
        }
      );
      assert.deepEqual(atStore.saves[0].meta, {
        savedBy: "system:finalizeWeeklyResults",
      });
      assert.deepEqual(publisher.calls, [
        {
          eventName: "league:updated",
          payload: {
            reason: "matchups:weekFinalized",
            weekId: "week-1",
          },
        },
      ]);
    });

    test("finalization preserves its result across duplicate and restarted runs", async () => {
      const state = makeFinalizationState();
      state.matchups.resultsByWeek["week-1"] = {
        weekId: "week-1",
        finalizedAtMs: 3000,
        perTeam: {},
      };
      const store = createMemoryStore(state);
      const firstJob = createFinalizeMatchupResultsJob({
        leagueStore: store,
        statisticsRepository:
          createStatisticsRepository(),
        clock: { nowMs: () => 3100 },
        logger: silentLogger(),
      });
      const restartedJob =
        createFinalizeMatchupResultsJob({
          leagueStore: store,
          statisticsRepository:
            createStatisticsRepository(),
          clock: { nowMs: () => 3200 },
          logger: silentLogger(),
        });

      assert.equal(
        (await firstJob.run()).reason,
        "alreadyFinalized"
      );
      assert.equal(
        (await restartedJob.run()).reason,
        "alreadyFinalized"
      );
      assert.equal(store.saves.length, 0);
      assert.equal(
        store.state().matchups.resultsByWeek[
          "week-1"
        ].finalizedAtMs,
        3000
      );
    });

    test("finalization requires baseline and current statistics without changing state", async () => {
      const missingBaseline = makeFinalizationState();
      missingBaseline.matchups.baselineByWeekId = {};
      const baselineStore =
        createMemoryStore(missingBaseline);
      const baselineJob =
        createFinalizeMatchupResultsJob({
          leagueStore: baselineStore,
          statisticsRepository:
            createStatisticsRepository(),
          clock: { nowMs: () => 3000 },
          logger: silentLogger(),
        });
      assert.equal(
        (await baselineJob.run()).reason,
        "baselineMissing"
      );
      assert.equal(baselineStore.saves.length, 0);

      const statsStore = createMemoryStore(
        makeFinalizationState()
      );
      const statsJob =
        createFinalizeMatchupResultsJob({
          leagueStore: statsStore,
          statisticsRepository:
            createStatisticsRepository({
              exists: false,
            }),
          clock: { nowMs: () => 3000 },
          logger: silentLogger(),
        });
      assert.equal(
        (await statsJob.run()).reason,
        "statsCacheMissing"
      );
      assert.equal(statsStore.saves.length, 0);
    });

    test("finalization awaits saves, guards overlap, and reports event failure", async () => {
      const state = makeFinalizationState();
      const store = createMemoryStore(state);
      let releaseSave;
      const saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
      store.setSaveImplementation(async () => {
        await saveGate;
      });
      const job = createFinalizeMatchupResultsJob({
        leagueStore: store,
        statisticsRepository:
          createStatisticsRepository(),
        clock: { nowMs: () => 3000 },
        logger: silentLogger(),
      });

      const firstRun = job.run();
      assert.equal(
        (await job.run()).reason,
        "overlap"
      );
      releaseSave();
      assert.equal((await firstRun).status, "succeeded");

      const eventStore = createMemoryStore(state);
      const publisher = createFakePublisher();
      publisher.failNext(new Error("event failed"));
      const eventJob =
        createFinalizeMatchupResultsJob({
          leagueStore: eventStore,
          statisticsRepository:
            createStatisticsRepository(),
          publisher,
          clock: { nowMs: () => 3000 },
          logger: silentLogger(),
        });
      const eventResult = await eventJob.run();
      assert.equal(eventResult.status, "failed");
      assert.equal(eventResult.error.message, "event failed");
      assert.equal(eventStore.saves.length, 1);
    });

    test("rollover skips before its boundary and advances exactly at it", async () => {
      const state = makeRolloverState();
      const beforeStore = createMemoryStore(state);
      const beforeJob =
        createRolloverMatchupWeekJob({
          leagueStore: beforeStore,
          statisticsRepository:
            createStatisticsRepository(),
          clock: { nowMs: () => 3999 },
          logger: silentLogger(),
        });
      assert.equal(
        (await beforeJob.run()).reason,
        "beforeRolloverTime"
      );
      assert.equal(beforeStore.saves.length, 0);

      const atStore = createMemoryStore(state);
      const publisher = createFakePublisher();
      const atJob = createRolloverMatchupWeekJob({
        leagueStore: atStore,
        statisticsRepository:
          createStatisticsRepository(),
        publisher,
        clock: { nowMs: () => 4000 },
        logger: silentLogger(),
      });

      assert.deepEqual(await atJob.run(), {
        job: "matchups:rolloverWeek",
        status: "succeeded",
        fromWeekId: "week-1",
        toWeekId: "week-2",
        fromWeekIndex: 0,
        toWeekIndex: 1,
        baselineCaptured: false,
        endOfSchedule: false,
      });
      assert.equal(
        atStore.state().matchups.currentWeekIndex,
        1
      );
      assert.equal(
        atStore.state().matchups.currentWeekId,
        "week-2"
      );
      assert.equal(
        atStore.state().matchups.lastRolloverWeekId,
        "week-1"
      );
      assert.deepEqual(atStore.saves[0].meta, {
        savedBy: "system:matchupRollover",
      });
      assert.deepEqual(publisher.calls, [
        {
          eventName: "league:updated",
          payload: {
            reason: "matchups:rollover",
            fromWeekId: "week-1",
            toWeekId: "week-2",
            fromWeekIndex: 0,
            toWeekIndex: 1,
          },
        },
      ]);
    });

    test("rollover optionally captures the next baseline in the same save", async () => {
      const store = createMemoryStore(
        makeRolloverState()
      );
      const job = createRolloverMatchupWeekJob({
        leagueStore: store,
        statisticsRepository:
          createStatisticsRepository(),
        clock: { nowMs: () => 4500 },
        logger: silentLogger(),
      });

      const result = await job.run();
      assert.equal(result.status, "succeeded");
      assert.equal(result.baselineCaptured, true);
      assert.deepEqual(
        store.state().matchups.baselineByWeekId[
          "week-2"
        ],
        {
          weekId: "week-2",
          capturedAtMs: 4500,
          statsSeasonId: "season-1",
          statsLastUpdatedAt: 1800,
          byPlayerId: {
            1001: {
              goals: 3,
              assists: 4,
              gamesPlayed: 10,
              fp: 7.75,
            },
            1002: {
              goals: 0,
              assists: 2,
              gamesPlayed: 0,
              fp: 2,
            },
          },
        }
      );
      assert.equal(store.saves.length, 1);
    });

    test("rollover requires finalized results and preserves restart idempotency", async () => {
      const missingResults = makeRolloverState();
      missingResults.matchups.resultsByWeek = {};
      const missingStore =
        createMemoryStore(missingResults);
      const missingJob =
        createRolloverMatchupWeekJob({
          leagueStore: missingStore,
          statisticsRepository:
            createStatisticsRepository(),
          clock: { nowMs: () => 4000 },
          logger: silentLogger(),
        });
      assert.equal(
        (await missingJob.run()).reason,
        "resultsMissing"
      );
      assert.equal(missingStore.saves.length, 0);

      const completedState = makeRolloverState();
      completedState.matchups.lastRolloverWeekId =
        "week-1";
      const completedStore =
        createMemoryStore(completedState);
      const firstJob = createRolloverMatchupWeekJob({
        leagueStore: completedStore,
        statisticsRepository:
          createStatisticsRepository(),
        clock: { nowMs: () => 4000 },
        logger: silentLogger(),
      });
      const restartedJob =
        createRolloverMatchupWeekJob({
          leagueStore: completedStore,
          statisticsRepository:
            createStatisticsRepository(),
          clock: { nowMs: () => 4000 },
          logger: silentLogger(),
        });
      assert.equal(
        (await firstJob.run()).reason,
        "alreadyRolledOver"
      );
      assert.equal(
        (await restartedJob.run()).reason,
        "alreadyRolledOver"
      );
      assert.equal(completedStore.saves.length, 0);
    });

    test("rollover marks the end of schedule without advancing", async () => {
      const state = makeRolloverState();
      state.matchups.scheduleWeeks.splice(1);
      const store = createMemoryStore(state);
      const publisher = createFakePublisher();
      const job = createRolloverMatchupWeekJob({
        leagueStore: store,
        statisticsRepository:
          createStatisticsRepository(),
        publisher,
        clock: { nowMs: () => 4000 },
        logger: silentLogger(),
      });

      assert.deepEqual(await job.run(), {
        job: "matchups:rolloverWeek",
        status: "succeeded",
        weekId: "week-1",
        endOfSchedule: true,
      });
      assert.equal(
        store.state().matchups.currentWeekIndex,
        0
      );
      assert.equal(
        store.state().matchups.lastRolloverWeekId,
        "week-1"
      );
      assert.deepEqual(store.saves[0].meta, {
        savedBy:
          "system:matchupRollover:endOfSchedule",
      });
      assert.deepEqual(publisher.calls[0].payload, {
        reason:
          "matchups:rollover:endOfSchedule",
        weekId: "week-1",
      });
    });

    test("rollover awaits saves, guards overlap, and reports event failure", async () => {
      const state = makeRolloverState();
      const store = createMemoryStore(state);
      let releaseSave;
      const saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
      store.setSaveImplementation(async () => {
        await saveGate;
      });
      const job = createRolloverMatchupWeekJob({
        leagueStore: store,
        statisticsRepository:
          createStatisticsRepository(),
        clock: { nowMs: () => 4000 },
        logger: silentLogger(),
      });

      const firstRun = job.run();
      assert.equal(
        (await job.run()).reason,
        "overlap"
      );
      releaseSave();
      assert.equal((await firstRun).status, "succeeded");

      const eventStore = createMemoryStore(state);
      const publisher = createFakePublisher();
      publisher.failNext(new Error("event failed"));
      const eventJob =
        createRolloverMatchupWeekJob({
          leagueStore: eventStore,
          statisticsRepository:
            createStatisticsRepository(),
          publisher,
          clock: { nowMs: () => 4000 },
          logger: silentLogger(),
        });
      const eventResult = await eventJob.run();
      assert.equal(eventResult.status, "failed");
      assert.equal(eventResult.error.message, "event failed");
      assert.equal(eventStore.saves.length, 1);
    });

    test("scheduler awaits matchup jobs in order and tracks one interval", async () => {
      const calls = [];
      const tracked = [];
      let intervalCallback;
      const jobs = Object.fromEntries(
        [
          "applyRosterLocks",
          "captureMatchupBaseline",
          "finalizeMatchupResults",
          "rolloverMatchupWeek",
        ].map((name) => [
          name,
          {
            async run() {
              calls.push(name);
              return {
                job: name,
                status: "succeeded",
              };
            },
          },
        ])
      );

      const scheduler = startMatchupScheduler({
        jobs,
        intervalMs: 5000,
        setIntervalFn(callback, intervalMs) {
          assert.equal(intervalMs, 5000);
          intervalCallback = callback;
          return "matchup-interval";
        },
        trackInterval(handle) {
          tracked.push(handle);
          return handle;
        },
        logger: silentLogger(),
      });

      assert.equal(
        (await scheduler.initialRun).status,
        "succeeded"
      );
      assert.deepEqual(calls, [
        "applyRosterLocks",
        "captureMatchupBaseline",
        "finalizeMatchupResults",
        "rolloverMatchupWeek",
      ]);
      assert.deepEqual(tracked, ["matchup-interval"]);

      intervalCallback();
      await new Promise(setImmediate);
      assert.deepEqual(calls.slice(4), calls.slice(0, 4));
    });

    test("scheduler prevents cycle overlap and failed finalization prevents rollover", async () => {
      let releaseLock;
      const lockGate = new Promise((resolve) => {
        releaseLock = resolve;
      });
      let rolloverCalls = 0;
      const jobs = {
        applyRosterLocks: {
          async run() {
            await lockGate;
            return { status: "succeeded" };
          },
        },
        captureMatchupBaseline: {
          async run() {
            return { status: "succeeded" };
          },
        },
        finalizeMatchupResults: {
          async run() {
            return {
              status: "failed",
              error: new Error("finalization failed"),
            };
          },
        },
        rolloverMatchupWeek: {
          async run() {
            rolloverCalls += 1;
            return { status: "succeeded" };
          },
        },
      };
      const scheduler = startMatchupScheduler({
        jobs,
        intervalMs: 5000,
        setIntervalFn() {
          return "matchup-interval";
        },
        logger: silentLogger(),
      });

      assert.deepEqual(await scheduler.runCycle(), {
        status: "skipped",
        reason: "overlap",
        outcomes: {},
      });
      releaseLock();
      const result = await scheduler.initialRun;
      assert.equal(result.status, "failed");
      assert.equal(result.reason, "finalizationFailed");
      assert.equal(
        result.outcomes.rolloverMatchupWeek.reason,
        "finalizationFailed"
      );
      assert.equal(rolloverCalls, 0);
    });

    test("accelerated scheduler cycle finalizes and advances exactly one week", async () => {
      const state = makeRolloverState();
      state.matchups.resultsByWeek = {};
      state.matchups.locksByTeam = {};
      state.matchups.baselineByWeekId = {};
      const store = createMemoryStore(state);
      const statisticsRepository =
        createStatisticsRepository();
      const clock = { nowMs: () => 4000 };
      const publisher = createFakePublisher();
      const jobs = {
        applyRosterLocks:
          createApplyRosterLocksJob({
            leagueStore: store,
            publisher,
            clock,
            logger: silentLogger(),
          }),
        captureMatchupBaseline:
          createCaptureMatchupBaselineJob({
            leagueStore: store,
            statisticsRepository,
            publisher,
            clock,
            logger: silentLogger(),
          }),
        finalizeMatchupResults:
          createFinalizeMatchupResultsJob({
            leagueStore: store,
            statisticsRepository,
            publisher,
            clock,
            logger: silentLogger(),
          }),
        rolloverMatchupWeek:
          createRolloverMatchupWeekJob({
            leagueStore: store,
            statisticsRepository,
            publisher,
            clock,
            logger: silentLogger(),
          }),
      };
      const scheduler = startMatchupScheduler({
        jobs,
        intervalMs: 5000,
        setIntervalFn() {
          return "matchup-interval";
        },
        logger: silentLogger(),
      });

      const firstCycle = await scheduler.initialRun;
      assert.equal(firstCycle.status, "succeeded");
      assert.equal(
        store.state().matchups.currentWeekIndex,
        1
      );
      assert.equal(
        store.state().matchups.lastRolloverWeekId,
        "week-1"
      );
      assert.ok(
        store.state().matchups.resultsByWeek[
          "week-1"
        ]
      );

      const secondCycle = await scheduler.runCycle();
      assert.equal(secondCycle.status, "succeeded");
      assert.equal(
        store.state().matchups.currentWeekIndex,
        1
      );
      assert.equal(
        store.state().matchups.lastRolloverWeekId,
        "week-1"
      );
    });
  }
);
