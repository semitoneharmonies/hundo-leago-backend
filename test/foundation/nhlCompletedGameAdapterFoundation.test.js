const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createNhlCompletedGameAdapter, PROVIDER_NAME, easternStart } = require("../../src/infrastructure/nhl/NhlCompletedGameAdapter");
const { normalizePlayerGameStatisticsRows } = require("../../src/domain/statistics/playerGameStatisticsPolicy");
const { normalizePlayerGameCoverageResponse } = require("../../src/domain/statistics/playerGameCoveragePolicy");
const { normalizeStatisticsRows } = require("../../src/domain/statistics/statisticsPolicy");
const NOW = Date.parse("2025-10-09T02:00:00Z");
const PLAYER = "20000000-0000-4000-8000-000000000001";

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
  const adapter = createNhlCompletedGameAdapter({ fetchImpl, nowMs: () => now, readCatalogPlayers: () => catalog, retryDelay: overrides.retryDelay || (async () => {}) });
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
