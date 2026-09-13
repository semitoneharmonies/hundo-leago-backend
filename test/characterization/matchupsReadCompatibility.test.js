const assert = require("node:assert/strict");
const fs = require("node:fs");
const { describe, test } = require("node:test");

const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");
const { hashTree } = require("../helpers/hashTree");
const { httpRequest } = require("../helpers/httpRequest");
const {
  startCompatibilityServer,
} = require("../helpers/startCompatibilityServer");
const {
  buildScheduleWeeks,
  generateRoundRobinPairs,
  getNextMondayStartMsPT,
  makeUtcMsForTZ,
} = require("../../src/domain/matchups/buildSchedule");
const {
  calculateStandings,
} = require("../../src/domain/standings/calculateStandings");
const {
  calculateWeeklyScore,
  getPlayerId,
} = require("../../src/domain/matchups/calculateWeeklyScore");
const {
  createMatchupReadService,
} = require(
  "../../src/application/services/matchups/readMatchups"
);

const MATCHUP_GET_PATHS = [
  "/api/matchups/standings",
  "/api/matchups/current",
  "/api/matchups/locks",
  "/api/matchups/locks/preview",
  "/api/matchups/baseline/preview",
  "/api/matchups/baseline/status",
  "/api/matchups/scoring/preview",
  "/api/matchups/rollover/status",
  "/api/matchups/debug/stateSummary",
];

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

async function requestJson(server, requestPath) {
  const response = await httpRequest(server.baseUrl, requestPath);
  assert.equal(response.status, 200, requestPath);
  assert.equal(response.json?.ok, true, requestPath);
  return response.json;
}

async function withServer(t, { prepare } = {}) {
  const runtime = await createFixtureRuntime();
  if (prepare) await prepare(runtime);
  const server = await startCompatibilityServer(runtime, {
    matchupsDebug: true,
  });

  t.after(async () => {
    await server.stop();
    await runtime.cleanup();
  });

  return { runtime, server };
}

describe(
  "current matchup read compatibility",
  { concurrency: false },
  () => {
    test("preserves current minimal-fixture responses and complete tree hashes", async (t) => {
      const { runtime, server } = await withServer(t);
      const before = await hashTree(runtime.root);
      const responses = {};

      for (const requestPath of MATCHUP_GET_PATHS) {
        responses[requestPath] = await requestJson(
          server,
          requestPath
        );
      }

      const standings = responses["/api/matchups/standings"];
      assert.equal(standings.weeksCounted, 0);
      assert.deepEqual(standings.countedWeekIds, []);
      assert.deepEqual(
        standings.standings.map((row) => row.teamName),
        ["Test Team Alpha", "Test Team Beta"]
      );
      assert.equal(
        standings.standings.every(
          (row) =>
            row.GP === 0 &&
            row.W === 0 &&
            row.L === 0 &&
            row.T === 0 &&
            row.PTS === 0 &&
            row.PF === 0 &&
            row.PA === 0 &&
            row.DIFF === 0
        ),
        true
      );
      assert.equal(Number.isFinite(standings.computedAtMs), true);

      const current = responses["/api/matchups/current"];
      assert.equal(current.seasonId, "test-season");
      assert.equal(current.currentWeekIndex, 0);
      assert.equal(current.currentWeekId, "test-week-1");
      assert.equal(current.week.weekId, "test-week-1");
      assert.equal(Number.isFinite(current.serverNowMs), true);

      const locks = responses["/api/matchups/locks"];
      assert.equal(locks.currentWeekIndex, 0);
      assert.equal(locks.currentWeekId, "test-week-1");
      assert.equal(locks.lockAtMs, 1700000002000);
      assert.deepEqual(locks.locksByTeam, {});

      const lockPreview =
        responses["/api/matchups/locks/preview"];
      assert.equal(lockPreview.reason, "afterLockTime");
      assert.deepEqual(lockPreview.alreadyLocked, []);
      assert.deepEqual(lockPreview.wouldLock, [
        "Test Team Alpha",
        "Test Team Beta",
      ]);

      const baselinePreview =
        responses["/api/matchups/baseline/preview"];
      assert.equal(baselinePreview.weekId, "test-week-1");
      assert.equal(baselinePreview.alreadyCaptured, false);
      assert.deepEqual(baselinePreview.statsMeta, {
        seasonId: "test-season",
        lastUpdatedAt: 1700000003000,
        playerCount: 2,
      });
      assert.deepEqual(baselinePreview.preview.sample, [
        {
          playerId: "1001",
          goals: 3,
          assists: 4,
          gamesPlayed: 10,
          fp: 7.75,
        },
        {
          playerId: "1002",
          goals: 1,
          assists: 5,
          gamesPlayed: 10,
          fp: 6.25,
        },
      ]);

      const baselineStatus =
        responses["/api/matchups/baseline/status"];
      assert.equal(baselineStatus.canCapture, true);
      assert.equal(baselineStatus.reason, "readyToCapture");
      assert.equal(baselineStatus.weekId, "test-week-1");
      assert.equal(
        baselineStatus.STATS_FILE,
        runtime.statsFile
      );

      const scoring =
        responses["/api/matchups/scoring/preview"];
      assert.equal(scoring.weekId, "test-week-1");
      assert.equal(scoring.baselineCaptured, false);
      assert.equal(scoring.statsReady, true);
      assert.equal(
        scoring.note,
        "Baseline not captured yet; locked teams return weeklyFP=null until captured."
      );
      assert.deepEqual(
        scoring.teams.map((team) => ({
          teamName: team.teamName,
          locked: team.locked,
          weeklyFP: team.weeklyFP,
          playersCount: team.playersCount,
        })),
        [
          {
            teamName: "Test Team Alpha",
            locked: false,
            weeklyFP: 0,
            playersCount: 1,
          },
          {
            teamName: "Test Team Beta",
            locked: false,
            weeklyFP: 0,
            playersCount: 1,
          },
        ]
      );

      const rollover =
        responses["/api/matchups/rollover/status"];
      assert.equal(rollover.currentWeekIndex, 0);
      assert.equal(rollover.currentWeekId, "test-week-1");
      assert.equal(rollover.resultsExists, false);
      assert.equal(rollover.canRollover, false);

      const debug =
        responses["/api/matchups/debug/stateSummary"];
      assert.equal(debug.currentWeekIndex, 0);
      assert.equal(debug.currentWeekId, "test-week-1");
      assert.deepEqual(debug.resultsKeys, []);
      assert.equal(debug.lastRolloverWeekId, null);

      assert.deepEqual(await hashTree(runtime.root), before);
    });

    test("preserves locked scoring, captured baseline, and standings tie behavior", async (t) => {
      const { runtime, server } = await withServer(t, {
        async prepare(runtime) {
          const state = await readJson(runtime.leagueFile);
          state.matchups.locksByTeam = {
            "Test Team Alpha": {
              lockedAtMs: 1700000002500,
              weekIndex: 0,
            },
            "Test Team Beta": {
              lockedAtMs: 1700000002500,
              weekIndex: 0,
            },
          };
          state.matchups.baselineByWeekId = {
            "test-week-1": {
              capturedAtMs: 1700000001000,
              statsLastUpdatedAt: 1700000000000,
              byPlayerId: {
                1001: {
                  goals: 2,
                  assists: 3,
                  fp: 5.5,
                },
                1002: {
                  goals: 1,
                  assists: 4,
                  fp: 5.25,
                },
              },
            },
          };
          state.matchups.resultsByWeek = {
            "test-week-1": {
              perTeam: {
                "Test Team Alpha": { weeklyFP: 8 },
                "Test Team Beta": { weeklyFP: 8 },
              },
            },
          };
          await fs.promises.writeFile(
            runtime.leagueFile,
            JSON.stringify(state, null, 2),
            "utf8"
          );
        },
      });
      const before = await hashTree(runtime.root);

      const scoring = await requestJson(
        server,
        "/api/matchups/scoring/preview"
      );
      const standings = await requestJson(
        server,
        "/api/matchups/standings"
      );
      const baselineStatus = await requestJson(
        server,
        "/api/matchups/baseline/status"
      );
      const lockPreview = await requestJson(
        server,
        "/api/matchups/locks/preview"
      );

      assert.equal(scoring.baselineCaptured, true);
      assert.equal(scoring.note, undefined);
      assert.deepEqual(scoring.sample, {
        playerId: "1001",
        fpBaseline: 5.5,
        fpNow: 7.75,
        delta: 2.25,
      });
      assert.deepEqual(
        scoring.teams.map((team) => ({
          teamName: team.teamName,
          locked: team.locked,
          weeklyFP: team.weeklyFP,
          countedPlayers: team.countedPlayers,
          missingIdCount: team.missingIdCount,
        })),
        [
          {
            teamName: "Test Team Alpha",
            locked: true,
            weeklyFP: 2.25,
            countedPlayers: 1,
            missingIdCount: 0,
          },
          {
            teamName: "Test Team Beta",
            locked: true,
            weeklyFP: 1,
            countedPlayers: 1,
            missingIdCount: 0,
          },
        ]
      );
      assert.deepEqual(scoring.baselineMeta, {
        baselineCapturedAtMs: 1700000001000,
        baselineStatsLastUpdatedAt: 1700000000000,
        currentStatsLastUpdatedAt: 1700000003000,
        statsChangedSinceBaseline: true,
      });

      assert.equal(standings.weeksCounted, 1);
      assert.deepEqual(standings.countedWeekIds, [
        "test-week-1",
      ]);
      assert.deepEqual(
        standings.standings.map((row) => ({
          teamName: row.teamName,
          GP: row.GP,
          T: row.T,
          PTS: row.PTS,
          PF: row.PF,
          PA: row.PA,
          DIFF: row.DIFF,
        })),
        [
          {
            teamName: "Test Team Alpha",
            GP: 1,
            T: 1,
            PTS: 1,
            PF: 8,
            PA: 8,
            DIFF: 0,
          },
          {
            teamName: "Test Team Beta",
            GP: 1,
            T: 1,
            PTS: 1,
            PF: 8,
            PA: 8,
            DIFF: 0,
          },
        ]
      );

      assert.equal(baselineStatus.canCapture, false);
      assert.equal(baselineStatus.reason, "alreadyCaptured");
      assert.equal(baselineStatus.playerCount, 2);
      assert.equal(lockPreview.reason, "afterLockTime");
      assert.deepEqual(lockPreview.alreadyLocked, [
        "Test Team Alpha",
        "Test Team Beta",
      ]);
      assert.deepEqual(lockPreview.wouldLock, []);

      assert.deepEqual(await hashTree(runtime.root), before);
    });
  }
);

describe("pure compatibility matchup schedule", () => {
  const timeZone = "America/Los_Angeles";

  test("preserves current round-robin rotation and odd-team bye omission", () => {
    assert.deepEqual(
      generateRoundRobinPairs(["A", "B", "C", "D"]),
      [
        [
          ["A", "D"],
          ["B", "C"],
        ],
        [
          ["A", "C"],
          ["D", "B"],
        ],
        [
          ["A", "B"],
          ["C", "D"],
        ],
      ]
    );
    assert.deepEqual(
      generateRoundRobinPairs(["A", "B", "C"]),
      [
        [["B", "C"]],
        [["A", "C"]],
        [["A", "B"]],
      ]
    );
  });

  test("preserves spring daylight-saving calendar windows", () => {
    const startWeekMsPT = makeUtcMsForTZ(
      {
        year: 2026,
        month: 3,
        day: 2,
        hour: 0,
        minute: 0,
      },
      timeZone
    );
    const weeks = buildScheduleWeeks({
      teamNames: ["A", "B"],
      startWeekMsPT,
      numWeeks: 2,
      seasonId: "spring",
      timeZone,
    });

    assert.equal(
      new Date(weeks[0].weekStartAtMs).toISOString(),
      "2026-03-02T08:00:00.000Z"
    );
    assert.equal(
      new Date(weeks[0].weekEndAtMs).toISOString(),
      "2026-03-09T06:59:00.000Z"
    );
    assert.equal(
      new Date(weeks[1].weekStartAtMs).toISOString(),
      "2026-03-09T07:00:00.000Z"
    );
    assert.equal(
      weeks[1].weekStartAtMs - weeks[0].weekStartAtMs,
      167 * 60 * 60 * 1000
    );
    assert.equal(
      weeks[0].baselineAtMs - weeks[0].weekStartAtMs,
      60 * 60 * 1000
    );
  });

  test("preserves fall daylight-saving calendar windows", () => {
    const startWeekMsPT = makeUtcMsForTZ(
      {
        year: 2026,
        month: 10,
        day: 26,
        hour: 0,
        minute: 0,
      },
      timeZone
    );
    const weeks = buildScheduleWeeks({
      teamNames: ["A", "B"],
      startWeekMsPT,
      numWeeks: 2,
      seasonId: "fall",
      timeZone,
    });

    assert.equal(
      new Date(weeks[0].weekStartAtMs).toISOString(),
      "2026-10-26T07:00:00.000Z"
    );
    assert.equal(
      new Date(weeks[1].weekStartAtMs).toISOString(),
      "2026-11-02T08:00:00.000Z"
    );
    assert.equal(
      weeks[1].weekStartAtMs - weeks[0].weekStartAtMs,
      169 * 60 * 60 * 1000
    );
  });

  test("uses explicit time and timezone for the next Monday", () => {
    const nowMs = Date.parse("2026-07-15T19:00:00.000Z");
    const nextMonday = getNextMondayStartMsPT({
      nowMs,
      timeZone,
    });

    assert.equal(
      new Date(nextMonday).toISOString(),
      "2026-07-20T07:00:00.000Z"
    );
  });
});

describe("pure compatibility standings", () => {
  test("preserves wins, ties, ignored unknown weeks, and deterministic sorting", () => {
    const payload = calculateStandings({
      nowMs: 123456,
      state: {
        teams: [
          { name: "Charlie" },
          { name: "Alpha" },
          { name: "Bravo" },
          { name: "Delta" },
        ],
        matchups: {
          scheduleWeeks: [
            {
              weekId: "week-1",
              pairs: [
                ["Alpha", "Bravo"],
                ["Charlie", "Delta"],
              ],
            },
            {
              weekId: "week-2",
              pairs: [
                ["Alpha", "Charlie"],
                ["Bravo", "Delta"],
              ],
            },
          ],
          resultsByWeek: {
            "week-1": {
              perTeam: {
                Alpha: { weeklyFP: 10 },
                Bravo: { weeklyFP: 8 },
                Charlie: { weeklyFP: 5 },
                Delta: { weeklyFP: 5 },
              },
            },
            "week-2": {
              perTeam: {
                Alpha: { weeklyFP: 7 },
                Charlie: { weeklyFP: 9 },
                Bravo: { weeklyFP: 6 },
                Delta: { weeklyFP: 6 },
              },
            },
            ignored: {
              perTeam: {
                Alpha: { weeklyFP: 100 },
              },
            },
          },
        },
      },
    });

    assert.equal(payload.computedAtMs, 123456);
    assert.equal(payload.weeksCounted, 2);
    assert.deepEqual(payload.countedWeekIds, [
      "week-1",
      "week-2",
    ]);
    assert.deepEqual(
      payload.standings.map((row) => ({
        teamName: row.teamName,
        GP: row.GP,
        W: row.W,
        L: row.L,
        T: row.T,
        PTS: row.PTS,
        PF: row.PF,
        PA: row.PA,
        DIFF: row.DIFF,
      })),
      [
        {
          teamName: "Charlie",
          GP: 2,
          W: 1,
          L: 0,
          T: 1,
          PTS: 3,
          PF: 14,
          PA: 12,
          DIFF: 2,
        },
        {
          teamName: "Alpha",
          GP: 2,
          W: 1,
          L: 1,
          T: 0,
          PTS: 2,
          PF: 17,
          PA: 17,
          DIFF: 0,
        },
        {
          teamName: "Bravo",
          GP: 2,
          W: 0,
          L: 1,
          T: 1,
          PTS: 1,
          PF: 14,
          PA: 16,
          DIFF: -2,
        },
        {
          teamName: "Delta",
          GP: 2,
          W: 0,
          L: 0,
          T: 2,
          PTS: 2,
          PF: 11,
          PA: 11,
          DIFF: 0,
        },
      ].sort((left, right) => {
        if (right.PTS !== left.PTS) {
          return right.PTS - left.PTS;
        }
        if (right.DIFF !== left.DIFF) {
          return right.DIFF - left.DIFF;
        }
        if (right.PF !== left.PF) {
          return right.PF - left.PF;
        }
        return left.teamName.localeCompare(right.teamName);
      })
    );
  });

  test("uses team name as the final compatibility tie breaker", () => {
    const payload = calculateStandings({
      nowMs: 1,
      state: {
        teams: [{ name: "Zulu" }, { name: "Alpha" }],
        matchups: {
          scheduleWeeks: [],
          resultsByWeek: {},
        },
      },
    });

    assert.deepEqual(
      payload.standings.map((row) => row.teamName),
      ["Alpha", "Zulu"]
    );
  });
});

describe("pure compatibility weekly scoring", () => {
  test("preserves current player ID fallbacks", () => {
    assert.equal(getPlayerId({ playerId: 1 }), "1");
    assert.equal(getPlayerId({ id: 2 }), "2");
    assert.equal(getPlayerId({ pid: 3 }), "3");
    assert.equal(
      getPlayerId({ player: { playerId: 4 } }),
      "4"
    );
    assert.equal(
      getPlayerId({ player: { id: 5 } }),
      "5"
    );
    assert.equal(
      getPlayerId({ auctionKey: "id:6" }),
      "6"
    );
    assert.equal(getPlayerId({ player: "id:7" }), "7");
    assert.equal(getPlayerId({ key: "id:8" }), "8");
    assert.equal(getPlayerId({ key: "name:missing" }), null);
  });

  test("preserves locks, baselines, clamping, rounding, diagnostics, and metadata", () => {
    const roster = [
      { playerId: 1 },
      { id: 2 },
      { pid: 3 },
      { player: { playerId: 4 } },
      { auctionKey: "id:5" },
      { key: "missing" },
    ];
    const payload = calculateWeeklyScore({
      nowMs: 9999,
      state: {
        teams: [
          { name: "Locked", roster },
          { name: "Unlocked", roster: [{ playerId: 1 }] },
        ],
        matchups: {
          currentWeekIndex: 0,
          scheduleWeeks: [
            {
              weekId: "week-1",
              weekStartAtMs: 1,
              baselineAtMs: 2,
              lockAtMs: 3,
              weekEndAtMs: 4,
              rolloverAtMs: 5,
            },
          ],
          locksByTeam: {
            Locked: {
              lockedAtMs: 10,
              weekIndex: 0,
            },
          },
          baselineByWeekId: {
            "week-1": {
              capturedAtMs: 100,
              statsLastUpdatedAt: 200,
              fpByPlayerId: {
                1: 3,
              },
              byPlayerId: {
                2: { fp: 10 },
                3: { goals: 1, assists: 1 },
                4: { fp: 0 },
                5: { fp: 0 },
              },
            },
          },
        },
      },
      statsJson: {
        ok: true,
        ready: true,
        lastUpdatedAt: 300,
        byPlayerId: {
          1: { goals: 4, assists: 1 },
          2: { goals: 1, assists: 1 },
          3: { goals: 2, assists: 1 },
          4: { goals: 0, assists: 0.333 },
          5: { goals: 0, assists: 0.338 },
        },
      },
    });

    assert.equal(payload.nowMs, 9999);
    assert.equal(payload.weekId, "week-1");
    assert.deepEqual(payload.weekWindow, {
      weekStartAtMs: 1,
      baselineAtMs: 2,
      lockAtMs: 3,
      weekEndAtMs: 4,
      rolloverAtMs: 5,
    });
    assert.deepEqual(payload.sample, {
      playerId: "1",
      fpBaseline: 3,
      fpNow: 6,
      delta: 3,
    });
    assert.deepEqual(payload.baselineMeta, {
      baselineCapturedAtMs: 100,
      baselineStatsLastUpdatedAt: 200,
      currentStatsLastUpdatedAt: 300,
      statsChangedSinceBaseline: true,
    });
    assert.deepEqual(payload.teams, [
      {
        teamName: "Locked",
        locked: true,
        lockedAtMs: 10,
        baselineCaptured: true,
        weeklyFP: 4.92,
        playersCount: 6,
        countedPlayers: 5,
        missingIdCount: 1,
      },
      {
        teamName: "Unlocked",
        locked: false,
        lockedAtMs: null,
        baselineCaptured: true,
        weeklyFP: 0,
        playersCount: 1,
      },
    ]);
    assert.equal(payload.note, undefined);
  });

  test("preserves no-week and locked-without-baseline responses", () => {
    const noWeek = calculateWeeklyScore({
      nowMs: 10,
      state: {
        teams: [],
        matchups: {
          currentWeekIndex: -1,
          scheduleWeeks: [],
        },
      },
      statsJson: null,
    });
    assert.deepEqual(noWeek, {
      ok: true,
      nowMs: 10,
      weekId: null,
      baselineCaptured: false,
      teams: [],
      note: "No current week configured.",
    });

    const noBaseline = calculateWeeklyScore({
      nowMs: 11,
      state: {
        teams: [
          { name: "Team", roster: [{ playerId: 1 }] },
        ],
        matchups: {
          currentWeekIndex: 0,
          scheduleWeeks: [{ weekId: "week-1" }],
          locksByTeam: {
            Team: { lockedAtMs: 5, weekIndex: 0 },
          },
          baselineByWeekId: {},
        },
      },
      statsJson: null,
    });

    assert.equal(noBaseline.teams[0].weeklyFP, null);
    assert.equal(noBaseline.teams[0].baselineCaptured, false);
    assert.equal(noBaseline.statsReady, false);
  });
});

describe("matchup read service", () => {
  test("owns all eight read use cases with an explicit fixed clock and no mutation", async () => {
    const state = {
      teams: [
        {
          name: "Alpha",
          roster: [{ playerId: 1 }],
        },
        {
          name: "Empty",
          roster: [],
        },
      ],
      matchups: {
        seasonId: "season",
        currentWeekIndex: 0,
        currentWeekId: "week-1",
        scheduleWeeks: [
          {
            weekId: "week-1",
            weekStartAtMs: 100,
            baselineAtMs: 200,
            lockAtMs: 300,
            weekEndAtMs: 400,
            rolloverAtMs: 500,
            pairs: [["Alpha", "Empty"]],
          },
        ],
        locksByTeam: {},
        baselineByWeekId: {},
        resultsByWeek: {},
        lastRolloverWeekId: null,
      },
    };
    const before = structuredClone(state);
    const statsJson = {
      ok: true,
      ready: true,
      seasonId: "season",
      lastUpdatedAt: 250,
      byPlayerId: {
        1: {
          gamesPlayed: 2,
          goals: 1,
          assists: 1,
        },
      },
    };
    const service = createMatchupReadService({
      leagueStore: {
        loadLeague: () => state,
      },
      statisticsRepository: {
        cacheExists: () => true,
        readCache: () => statsJson,
        readCacheAsync: async () => statsJson,
      },
      statsFile: "C:/temporary/stats.json",
      clock: {
        nowMs: () => 350,
      },
    });

    assert.equal(service.readStandings().computedAtMs, 350);
    assert.equal(service.readCurrent().serverNowMs, 350);
    assert.equal(service.readLocks().serverNowMs, 350);
    assert.deepEqual(service.readLocksPreview(), {
      ok: true,
      reason: "afterLockTime",
      serverNowMs: 350,
      lockAtMs: 300,
      currentWeekIndex: 0,
      currentWeekId: "week-1",
      alreadyLocked: [],
      wouldLock: ["Alpha"],
    });
    assert.equal(
      service.readBaselinePreview().preview.playerCount,
      1
    );
    assert.deepEqual(service.readBaselineStatus(), {
      ok: true,
      canCapture: true,
      reason: "readyToCapture",
      nowMs: 350,
      currentWeekIndex: 0,
      weekId: "week-1",
      baselineAtMs: 200,
      STATS_FILE: "C:/temporary/stats.json",
    });
    assert.equal(
      (await service.readScoringPreview()).nowMs,
      350
    );
    assert.deepEqual(service.readRolloverStatus(), {
      ok: true,
      nowMs: 350,
      currentWeekIndex: 0,
      currentWeekId: "week-1",
      rolloverAtMs: 500,
      lastRolloverWeekId: null,
      resultsExists: false,
      canRollover: false,
    });
    assert.deepEqual(state, before);
  });

  test("preserves missing cache and missing week status reasons", () => {
    const service = createMatchupReadService({
      leagueStore: {
        loadLeague: () => ({
          teams: [],
          matchups: {
            currentWeekIndex: 0,
            scheduleWeeks: [],
          },
        }),
      },
      statisticsRepository: {
        cacheExists: () => false,
        readCache() {
          throw new Error("must not read a missing cache");
        },
        async readCacheAsync() {
          throw new Error("missing cache");
        },
      },
      statsFile: "C:/temporary/missing.json",
      clock: {
        nowMs: () => 1000,
      },
    });

    assert.equal(
      service.readLocksPreview().reason,
      "missingWeekOrLockTime"
    );
    assert.equal(
      service.readBaselinePreview().reason,
      "missingWeekOrBaselineTime"
    );
    assert.equal(
      service.readBaselineStatus().reason,
      "noCurrentWeek"
    );
  });
});
