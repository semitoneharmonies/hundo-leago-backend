const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createNhlCompletedGameAdapter, PROVIDER_NAME, easternStart } = require("../../src/infrastructure/nhl/NhlCompletedGameAdapter");
const { normalizePlayerGameStatisticsRows } = require("../../src/domain/statistics/playerGameStatisticsPolicy");
const { normalizePlayerGameCoverageResponse } = require("../../src/domain/statistics/playerGameCoveragePolicy");
const { normalizeStatisticsRows } = require("../../src/domain/statistics/statisticsPolicy");
const NOW = Date.parse("2025-10-09T02:00:00Z");
const PLAYER = "20000000-0000-4000-8000-000000000001";
const expandedFixtures = require("../fixtures/nhlExpandedScoringGames.json");
const { normalizeExpandedSnapshot } = require("../../src/domain/statistics/expandedStatisticsSnapshotPolicy");

test("game refresh windows cover early games, midnight and prolonged live games with bounded schedule requests", async () => {
  let now = Date.parse("2026-10-10T07:00:00Z"), calls = 0;
  const games = [
    { id: 2026020001, season: 20262027, gameType: 2, startTimeUTC: "2026-10-10T02:00:00Z", gameState: "OFF" },
    { id: 2026020002, season: 20262027, gameType: 2, startTimeUTC: "2026-10-10T12:00:00Z", gameState: "FUT" },
  ];
  const adapter = createNhlCompletedGameAdapter({ nowMs: () => now, readCatalogPlayers: () => [], retryDelay: async () => {},
    fetchImpl: async url => { calls++; assert.match(url, /\/v1\/schedule\/2026-10-09$/);
      return { ok: true, json: async () => ({ gameWeek: [{ date: "2026-10-09", games: [] }, { date: "2026-10-10", games }] }) }; } });
  const check = () => adapter.isGameRefreshWindow({ nhlSeasonKey: "20262027", scheduledForMs: now });
  assert.equal(await check(), true); assert.equal(await check(), true); assert.equal(calls, 1);
  now = Date.parse("2026-10-10T10:00:00Z"); assert.equal(await check(), false);
  now = Date.parse("2026-10-10T11:30:00Z"); assert.equal(await check(), true);
  now = Date.parse("2026-10-10T22:00:00Z"); games[1].gameState = "LIVE"; assert.equal(await check(), true);
  games[1].gameState = "OFF"; now += 10 * 60_000; assert.equal(await check(), false);
});

test("enabled NHL collector carries all categories and the real penalty-shot exception through a sealed snapshot", async () => {
  // Move captured reports into the target season to exercise its explicit switch.
  const captured = structuredClone(expandedFixtures.games.find(game => game.gameId === 2025020477));
  const gameId = 2026020477;
  for (const report of ["summary", "realtime", "scoringpergame", "penalties", "penaltyShots"]) {
    for (const row of captured[report]) row.gameId = gameId;
  }
  const landing = captured.penaltyShotLandings[0];
  landing.id = gameId; landing.season = 20262027;
  const calls = [];
  const now = Date.parse("2026-12-20T12:00:00Z");
  const cacheEntries = new Map();
  let useCache = false;
  const chosen = captured.summary.find(row => row.playerId === 8480797);
  const teamId = chosen.homeRoad === "H" ? 13 : 16;
  let incomplete = false;
  const adapter = createNhlCompletedGameAdapter({ expandedScoringEnabled: true, nowMs: () => now, retryDelay: async () => {},
    completedGameCache: { read: () => useCache ? structuredClone(cacheEntries) : new Map(),
      save: entries => { for (const entry of entries) cacheEntries.set(entry.gameId, structuredClone(entry)); } },
    readCatalogPlayers: () => captured.summary.map(row => ({ providerPlayerId: String(row.playerId) })),
    fetchImpl: async uri => {
      const url = new URL(uri); calls.push(url.pathname);
      let data;
      if (url.pathname.endsWith("/game")) data = { total: 1, data: [{ id: gameId, season: 20262027, gameType: 2,
        easternStartTime: "2026-12-10T19:00:00", homeTeamId: 13, visitingTeamId: 16, gameStateId: 7 }] };
      else if (url.pathname.includes("/gamecenter/")) data = landing;
      else if (url.pathname.includes("/player/")) data = { playerId: chosen.playerId, position: "L", currentTeamId: teamId, isActive: true };
      else {
        const report = url.pathname.split("/").at(-1);
        const rows = incomplete && report === "penalties" ? captured[report].slice(1) : captured[report];
        assert.ok(rows, url.pathname);
        data = { total: rows.length, data: rows };
      }
      return { ok: true, json: async () => structuredClone(data) };
    },
  });
  const input = { nhlSeasonKey: "20262027", requiredPlayers: [{ playerId: PLAYER, providerPlayerId: String(chosen.playerId) }], requiredPlayerGames: [] };
  const snapshot = await adapter.fetchLiveSnapshot(input);
  const totals = normalizeStatisticsRows({ rows: snapshot.totalsRows, minimumPlayerCount: 30, sourceUpdatedAtMs: snapshot.totalsSourceUpdatedAtMs });
  const observations = normalizePlayerGameStatisticsRows({ rows: snapshot.playerGameRows, capturedAtMs: snapshot.capturedAtMs });
  const expanded = normalizeExpandedSnapshot(snapshot.expandedScoring, { nhlSeasonKey: input.nhlSeasonKey, totals, observations });
  const scored = expanded.playerGameRows[0];
  assert.equal(scored.playerId, "8480797");
  assert.equal(scored.gamesPlayed, 1);
  assert.equal(scored.scoringStats.evenStrengthGoals, 1);
  assert.equal(scored.scoringStats.shortHandedGoals, 0);
  assert.equal(Object.keys(scored.scoringStats).length, 13);
  assert.ok(calls.some(path => path.endsWith("/penaltyShots")));
  const initialCalls = calls.length;
  useCache = true;
  assert.deepEqual(await adapter.fetchLiveSnapshot(input), snapshot);
  assert.equal(calls.slice(initialCalls).some(path => path.includes("/skater/")), false);
  useCache = false;
  incomplete = true;
  await assert.rejects(adapter.fetchLiveSnapshot(input), { code: "NHL_EXPANDED_REPORT_INCOMPLETE" });
});

test("expanded NHL reports read every page when the provider caps responses at 100 rows", async () => {
  const captured = expandedFixtures.games.find(game => game.gameId === 2025020477);
  const gameIds = [2026020477, 2026020478, 2026020479];
  const reports = Object.fromEntries(["summary", "realtime", "scoringpergame", "penalties", "penaltyShots"].map(report =>
    [report, gameIds.flatMap(gameId => captured[report].map(row => ({ ...row, gameId })))]));
  const calls = [];
  let truncateSecondPage = false;
  let changeSecondPageTotal = false;
  const adapter = createNhlCompletedGameAdapter({ expandedScoringEnabled: true,
    nowMs: () => Date.parse("2026-12-20T12:00:00Z"), retryDelay: async () => {},
    readCatalogPlayers: () => captured.summary.map(row => ({ providerPlayerId: String(row.playerId) })),
    fetchImpl: async uri => {
      const url = new URL(uri);
      let data;
      if (url.pathname.endsWith("/game")) {
        const games = gameIds.map(id => ({ id, season: 20262027, gameType: 2,
          easternStartTime: "2026-12-10T19:00:00", homeTeamId: 13, visitingTeamId: 16, gameStateId: 7 }));
        data = { total: games.length, data: games };
      } else if (url.pathname.includes("/gamecenter/")) {
        data = { ...structuredClone(captured.penaltyShotLandings[0]), id: Number(url.pathname.split("/").at(-2)), season: 20262027 };
      } else {
        const report = url.pathname.split("/").at(-1);
        const rows = reports[report];
        assert.ok(rows, url.pathname);
        const start = Number(url.searchParams.get("start"));
        const limit = Number(url.searchParams.get("limit"));
        calls.push({ report, start, limit });
        const page = rows.slice(start, start + Math.min(limit, 100));
        if (report === "summary" && start === 100 && truncateSecondPage) page.pop();
        data = { total: rows.length + (report === "summary" && start === 100 && changeSecondPageTotal ? 1 : 0), data: page };
      }
      return { ok: true, json: async () => structuredClone(data) };
    },
  });
  const input = { nhlSeasonKey: "20262027", requiredPlayers: [], requiredPlayerGames: [] };
  const snapshot = await adapter.fetchLiveSnapshot(input);
  assert.equal(reports.summary.length, 108);
  assert.equal(snapshot.totalsRows.length, 36);
  assert(snapshot.totalsRows.every(row => row.gamesPlayed === 3));
  for (const report of ["summary", "realtime", "scoringpergame", "penalties"]) {
    assert.deepEqual(calls.filter(call => call.report === report).map(call => call.start), [0, 100]);
  }
  assert(calls.every(call => call.limit <= 100));
  truncateSecondPage = true;
  await assert.rejects(adapter.fetchLiveSnapshot(input), /response is incomplete/);
  truncateSecondPage = false;
  changeSecondPageTotal = true;
  await assert.rejects(adapter.fetchLiveSnapshot(input), /pagination changed/);
});

function fixture(overrides = {}) {
  let now = NOW;
  const calls = [];
  const games = [
    { id: 2025020001, season: 20252026, gameType: 2, easternStartTime: "2025-10-07T17:00:00", homeTeamId: 13, visitingTeamId: 16, gameStateId: 7 },
    { id: 2025020002, season: 20252026, gameType: 2, easternStartTime: "2025-10-08T21:00:00", homeTeamId: 13, visitingTeamId: 16, gameStateId: 3 },
  ];
  const rows = Array.from({ length: 36 }, (_, i) => ({ playerId: 8478000 + i, gameId: 2025020001, homeRoad: i < 18 ? "H" : "R", gamesPlayed: 1, goals: i === 0 ? 2 : 0, assists: i === 0 ? 1 : 0, points: i === 0 ? 3 : 0 }));
  const boxes = new Map(games.map((g) => [String(g.id), { id: g.id, season: g.season, gameType: 2, startTimeUTC: new Date(easternStart(g.easternStartTime)).toISOString(), homeTeam: { id: 13 }, awayTeam: { id: 16 }, gameState: g.gameStateId === 7 ? "OFF" : "LIVE", gameScheduleState: "OK", playerByGameStats: { homeTeam: { forwards: rows.slice(0, 18), defense: [] }, awayTeam: { forwards: rows.slice(18), defense: [] } } }]));
  const catalog = rows.map((r) => ({ providerPlayerId: String(r.playerId) }));
  catalog.push({ providerPlayerId: "8999999" });
  const requiredPlayers = [{ playerId: PLAYER, providerPlayerId: "8478000" }];
  const state = { games, rows, boxes, catalog, requiredPlayers };
  overrides.change?.(state);
  const fetchImpl = async (uri) => {
    calls.push(String(uri));
    const u = new URL(uri);
    let data;
    if (u.pathname.endsWith("/game")) data = { data: games, total: games.length };
    else if (u.pathname.endsWith("/summary")) data = { data: rows, total: rows.length };
    else if (u.pathname.endsWith("/landing")) data = { playerId: 8478000, position: "D", currentTeamId: 13, isActive: true };
    else data = boxes.get(u.pathname.split("/").at(-2));
    if (overrides.response) return overrides.response(u, data);
    return { ok: true, json: async () => structuredClone(data) };
  };
  const adapter = createNhlCompletedGameAdapter({ fetchImpl, nowMs: () => now, readCatalogPlayers: () => catalog, completedGameCache: overrides.completedGameCache || null, retryDelay: overrides.retryDelay || (async () => {}) });
  return { adapter, calls, state, setNow: (value) => { now = value; }, input: { nhlSeasonKey: "20252026", requiredPlayers, requiredPlayerGames: [] } };
}

test("NHL completed-game totals exclude live goals, include zero-game catalog players, and satisfy sealed coverage policies", async () => {
  const f = fixture();
  const result = await f.adapter.fetchLiveSnapshot(f.input);
  assert.equal(result.provider, PROVIDER_NAME);
  assert.deepEqual(result.totalsRows[0], { playerId: "8478000", gamesPlayed: 1, goals: 2, assists: 1 });
  assert.deepEqual(result.totalsRows.at(-1), { playerId: "8999999", gamesPlayed: 0, goals: 0, assists: 0 });
  assert.equal(result.playerGameRows.find((row) => row.nhlGameId === "2025020002").goals, 0);
  const observations = normalizePlayerGameStatisticsRows({ rows: result.playerGameRows, capturedAtMs: result.capturedAtMs });
  normalizePlayerGameCoverageResponse({ requiredPlayers: f.input.requiredPlayers, requiredPlayerGames: [], response: result.playerGameCoverage, observationRows: observations, capturedAtMs: result.capturedAtMs });
  const totals = normalizeStatisticsRows({ rows: result.totalsRows, minimumPlayerCount: 30, sourceUpdatedAtMs: result.totalsSourceUpdatedAtMs });
  assert.equal(totals[0].fantasyPointsHundredths, 350);
  const summaryRequest = new URL(f.calls.find((u) => u.includes("/summary")));
  assert.equal(summaryRequest.searchParams.get("cayenneExp"), "gameId in (2025020001)");
});

for (const pendingBoxState of ["FINAL", "OFF"]) test(`NHL ${pendingBoxState} games awaiting official reports do not block confirmed scores or publish provisional points`, async () => {
  const cached = [];
  const f = fixture({ completedGameCache: { read: () => new Map(), save: entries => cached.push(...entries) },
    change: ({ games, boxes }) => { games[1].gameStateId = 6; boxes.get(String(games[1].id)).gameState = pendingBoxState; } });
  const first = await f.adapter.fetchLiveSnapshot(f.input);
  assert.deepEqual(first.totalsRows[0], { playerId: "8478000", gamesPlayed: 1, goals: 2, assists: 1 });
  const pending = first.playerGameRows.find(row => row.nhlGameId === "2025020002");
  assert.equal(pending.observedGameState, "in_progress");
  assert.equal(pending.goals, 0); assert.equal(pending.assists, 0);
  assert.deepEqual(cached.map(entry => entry.gameId), ["2025020001"]);
  assert.equal(new URL(f.calls.find(url => url.includes("/summary"))).searchParams.get("cayenneExp"), "gameId in (2025020001)");
  const observations = normalizePlayerGameStatisticsRows({ rows: first.playerGameRows, capturedAtMs: first.capturedAtMs });
  normalizePlayerGameCoverageResponse({ requiredPlayers: f.input.requiredPlayers, requiredPlayerGames: [], response: first.playerGameCoverage, observationRows: observations, capturedAtMs: first.capturedAtMs });
  const gameStates = await f.adapter.fetchGameStates({ nhlSeasonKey: "20252026", requestedAtMs: NOW,
    games: [{ nhlGameId: pending.nhlGameId, nhlGameScheduledStartsAtMs: pending.nhlGameScheduledStartsAtMs }] });
  assert.equal(gameStates.games[0].observedGameState, "in_progress");
  // Once official reports arrive, the next capture includes that game exactly
  // once; repeated captures overwrite cumulative totals without doubling it.
  f.state.games[1].gameStateId = 7;
  f.state.boxes.get("2025020002").gameState = "OFF";
  f.state.rows.push(...f.state.rows.map(row => ({ ...row, gameId: 2025020002 })));
  const finalized = await f.adapter.fetchLiveSnapshot(f.input);
  assert.deepEqual(finalized.totalsRows[0], { playerId: "8478000", gamesPlayed: 2, goals: 4, assists: 2 });
  assert.equal(finalized.playerGameRows.find(row => row.nhlGameId === "2025020002").observedGameState, "final");
  assert.deepEqual((await f.adapter.fetchLiveSnapshot(f.input)).totalsRows, finalized.totalsRows);
});

test("completed-game captures overwrite the real SQLite cache without caching pending games", async t => {
  const database = new (require("better-sqlite3"))(":memory:");
  t.after(() => database.close());
  require("../../src/infrastructure/database/migrate").migrateDatabase({ database,
    migrationsDirectory: require("node:path").resolve(__dirname, "../../database/migrations"), applicationBuildId: "pending-game-cache-test", now: () => 1 });
  const cache = require("../../src/infrastructure/persistence/sqlite/SqliteCompletedGameCacheRepository").createSqliteCompletedGameCacheRepository({ database });
  const f = fixture({ completedGameCache: cache,
    change: ({ games, boxes }) => { games[1].gameStateId = 6; boxes.get("2025020002").gameState = "OFF"; } });
  const first = await f.adapter.fetchLiveSnapshot(f.input);
  f.setNow(NOW + 60_000);
  assert.deepEqual((await f.adapter.fetchLiveSnapshot(f.input)).totalsRows, first.totalsRows);
  const entries = cache.read({ season: "20252026", expanded: false });
  assert.deepEqual([...entries.keys()], ["2025020001"]);
  assert.equal(entries.get("2025020001").checkedAtMs, NOW + 60_000);
  assert.equal(entries.get("2025020001").data.rows.length, 36);
  assert.equal(database.prepare("SELECT count(*) n FROM nhl_completed_game_cache").get().n, 1);
});

test("NHL official games retain FINAL support and reject genuinely contradictory states", async () => {
  const official = fixture({ change: ({ boxes }) => { boxes.get("2025020001").gameState = "FINAL"; } });
  assert.equal((await official.adapter.fetchLiveSnapshot(official.input)).playerGameRows[0].observedGameState, "final");
  for (const [scheduleState, boxState] of [[7, "LIVE"], [3, "OFF"], [3, "FINAL"]]) {
    const f = fixture({ change: ({ games, boxes }) => {
      games[1].gameStateId = scheduleState; boxes.get("2025020002").gameState = boxState;
    } });
    await assert.rejects(f.adapter.fetchLiveSnapshot(f.input));
  }
});

test("NHL cached game-state lookup makes no external calls and rejects stale evidence", async () => {
  const f = fixture();
  const result = await f.adapter.fetchLiveSnapshot(f.input);
  const games = result.playerGameRows.map(({ nhlGameId, nhlGameScheduledStartsAtMs }) => ({ nhlGameId, nhlGameScheduledStartsAtMs }));
  const count = f.calls.length;
  assert.equal((await f.adapter.fetchGameStates({ nhlSeasonKey: "20252026", requestedAtMs: NOW, games })).games[1].observedGameState, "in_progress");
  assert.equal(f.calls.length, count);
  await assert.rejects(f.adapter.fetchGameStates({ nhlSeasonKey: "20252026", requestedAtMs: NOW + 300_001, games }), { code: "NHL_GAME_STATE_AWAITING_REFRESH" });
});

for (const [label, change] of [
  ["wrong season", ({ games }) => { games[0].season = 20242025; }],
  ["duplicate player game", ({ rows }) => { rows[1] = rows[0]; }],
  ["missing completed-game rows", ({ rows }) => { rows.splice(1); }],
  ["unrequested live-game points", ({ rows }) => { rows[0].gameId = 2025020002; }],
  ["inconsistent points", ({ rows }) => { rows[0].points = 9; }],
  ["missing required identity", ({ catalog }) => { catalog.shift(); }],
  ["incorrect boxscore season", ({ boxes }) => { boxes.get("2025020001").season = 20242025; }],
]) test(`NHL snapshot rejects ${label}`, async () => {
  const f = fixture({ change });
  await assert.rejects(f.adapter.fetchLiveSnapshot(f.input));
});

test("NHL request retries transient service failures with a fixed bound", async () => {
  let attempts = 0;
  const f = fixture({ response: () => { attempts += 1; return { ok: false, status: 503 }; } });
  await assert.rejects(f.adapter.fetchLiveSnapshot(f.input));
  assert.equal(attempts, 3);
});

test("NHL request retries connection resets and timeouts, but rejects malformed JSON immediately", async () => {
  for (const [error, expected] of [[Object.assign(new Error("connection reset"), { code: "ECONNRESET" }), 3], [new DOMException("request timeout", "TimeoutError"), 3], [new SyntaxError("invalid JSON"), 1]]) {
    let attempts = 0;
    const f = fixture({ response: () => { attempts += 1; throw error; } });
    await assert.rejects(f.adapter.fetchLiveSnapshot(f.input));
    assert.equal(attempts, expected);
  }
});

test("NHL rate limits honor seconds, HTTP dates and a conservative missing-header delay", async () => {
  for (const [header, expectedDelay] of [["12", 12_000], [new Date(NOW + 20_000).toUTCString(), 20_000], [null, 30_000]]) {
    const delays = [];
    let attempts = 0;
    const f = fixture({
      retryDelay: async (ms) => { delays.push(ms); },
      response: (url, data) => {
        if (url.pathname.endsWith("/game") && attempts++ === 0) return { ok: false, status: 429, headers: { get: () => header } };
        return { ok: true, json: async () => structuredClone(data) };
      },
    });
    await f.adapter.fetchLiveSnapshot(f.input);
    assert.equal(delays[0], expectedDelay);
    assert.equal(attempts, 2);
  }
});

test("NHL long rate limits reject the capture without an early retry", async () => {
  let attempts = 0;
  const delays = [];
  const f = fixture({ retryDelay: async (ms) => { delays.push(ms); }, response: () => {
    attempts += 1;
    return { ok: false, status: 429, headers: { get: () => "120" } };
  } });
  await assert.rejects(f.adapter.fetchLiveSnapshot(f.input), { code: "NHL_COMPLETED_REQUEST_RATE_LIMITED" });
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("NHL player and boxscore requests are paced without slowing the statistics origin", async () => {
  let elapsed = 0;
  const webStarts = [], statisticsStarts = [];
  const f = fixture({
    change: ({ requiredPlayers }) => {
      for (let i = 1; i < 4; i += 1) requiredPlayers.push({ playerId: `20000000-0000-4000-8000-00000000000${i + 1}`, providerPlayerId: String(8478000 + i) });
    },
    retryDelay: async (ms) => { await new Promise(setImmediate); elapsed += ms; f.setNow(NOW + elapsed); },
    response: (url, data) => {
      (url.origin === "https://api-web.nhle.com" ? webStarts : statisticsStarts).push(elapsed);
      if (url.pathname.endsWith("/landing")) return { ok: true, json: async () => ({ ...data, playerId: Number(url.pathname.split("/").at(-2)) }) };
      return { ok: true, json: async () => structuredClone(data) };
    },
  });
  await f.adapter.fetchLiveSnapshot(f.input);
  assert.deepEqual(statisticsStarts, [0, 0]);
  assert.equal(webStarts.length, 6);
  assert(webStarts.slice(1).every((start, index) => start - webStarts[index] >= 350));
});

test("NHL completed-game adapter respects Eastern daylight saving time", () => {
  assert.equal(easternStart("2025-10-07T17:00:00"), Date.parse("2025-10-07T21:00:00Z"));
  assert.equal(easternStart("2025-12-07T17:00:00"), Date.parse("2025-12-07T22:00:00Z"));
});

test("incremental collector reuses old games, rechecks recent games and weekly corrections, and preserves totals", async () => {
  const entries = new Map();
  const cache = { read: () => structuredClone(entries), save: rows => { for (const row of rows) entries.set(row.gameId, structuredClone(row)); } };
  const f = fixture({ completedGameCache: cache });
  const historicNow = NOW + 20 * 86_400_000;
  f.setNow(historicNow);
  const first = await f.adapter.fetchLiveSnapshot(f.input);
  const initialCalls = f.calls.length;
  const second = await f.adapter.fetchLiveSnapshot(f.input);
  assert.deepEqual(second, first);
  assert.equal(f.calls.slice(initialCalls).some(url => url.includes("/summary")), false);
  f.state.rows[0].goals = 3; f.state.rows[0].points = 4;
  f.setNow(historicNow + 7 * 86_400_000);
  const corrected = await f.adapter.fetchLiveSnapshot(f.input);
  assert.equal(corrected.totalsRows[0].goals, 3);
  assert.equal(entries.size, 1);
  const beforeRecent = f.calls.filter(url => url.includes("/summary")).length;
  entries.clear(); f.setNow(NOW);
  f.state.rows[0].goals = 2; f.state.rows[0].points = 3;
  await f.adapter.fetchLiveSnapshot(f.input);
  await f.adapter.fetchLiveSnapshot(f.input);
  assert.equal(f.calls.filter(url => url.includes("/summary")).length, beforeRecent + 2);
});

test("failed snapshot does not publish cache updates", async () => {
  let saves = 0;
  const f = fixture({ completedGameCache: { read: () => new Map(), save: () => { saves += 1; } },
    change: ({ boxes }) => { boxes.get("2025020001").season = 20242025; } });
  await assert.rejects(f.adapter.fetchLiveSnapshot(f.input));
  assert.equal(saves, 0);
});
