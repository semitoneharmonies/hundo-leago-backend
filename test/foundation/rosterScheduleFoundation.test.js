const assert = require("node:assert/strict");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const express = require("express");
const { createNhlScheduleAdapter } = require("../../src/infrastructure/nhl/NhlScheduleAdapter");
const { createSqliteRosterScheduleRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteRosterScheduleRepository");
const { createRosterScheduleService } = require("../../src/application/services/leagues/createRosterScheduleService");
const { createMatchupRouter } = require("../../src/transport/http/createMatchupRouter");
const { selectTargetRouterKey } = require("../../src/bootstrap/createTargetRuntime");

const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const DAY = 86_400_000;
const startsAtMs = Date.parse("2026-10-12T07:00:00Z");
const endsAtMs = Date.parse("2026-10-26T07:00:00Z");
const range = { startsAtMs, endsAtMs, nhlSeasonKey: "20262027" };
const rawGame = (n, time, extra = {}) => ({ id: n, season: 20262027, gameType: 2, startTimeUTC: new Date(time).toISOString(), homeTeam: { id: 23, abbrev: "VAN" }, awayTeam: { id: 55, abbrev: "SEA" }, gameState: "FUT", gameScheduleState: "OK", ...extra });
function responseFor(url, games = []) {
  const first = Date.parse(`${url.split("/").at(-1)}T00:00:00Z`);
  return { ok: true, json: async () => ({ gameWeek: Array.from({ length: 7 }, (_, i) => {
    const date = new Date(first + i * DAY).toISOString().slice(0, 10);
    return { date, games: games.filter((game) => game.startTimeUTC.slice(0, 10) === date) };
  }) }) };
}

test("schedule uses half-open matchup dates, covers long weeks, filters preseason/other seasons and preserves status", async () => {
  const games = [rawGame(1, startsAtMs - 1), rawGame(2, startsAtMs), rawGame(3, startsAtMs + 8 * DAY, { gameScheduleState: "PPD" }), rawGame(4, endsAtMs - 1, { gameState: "OFF" }), rawGame(5, endsAtMs), rawGame(6, startsAtMs + DAY, { gameType: 1 }), rawGame(7, startsAtMs + DAY, { season: 20252026 })];
  const adapter = createNhlScheduleAdapter({ fetchImpl: async (url) => responseFor(url, games), nowMs: () => 123 });
  const result = await adapter.readSchedule(range);
  assert.deepEqual(result.games.map((game) => game.id), ["2", "3", "4"]);
  assert.deepEqual(result.games.map((game) => game.status), ["scheduled", "postponed", "final"]);
  assert.equal(result.fetchedAtMs, 123);
  assert.equal(result.games[0].homeTeamId, "23");
  assert.equal(result.games[0].awayTeamId, "55");
});

test("cache shares concurrent reads, expires, and provider failure never becomes an empty schedule", async () => {
  let now = 10_000, calls = 0, fail = false;
  const adapter = createNhlScheduleAdapter({ nowMs: () => now, ttlMs: 1000, fetchImpl: async (url) => { calls += 1; if (fail) throw new Error("provider down"); return responseFor(url); } });
  const short = { ...range, endsAtMs: startsAtMs + DAY };
  await Promise.all([adapter.readSchedule(short), adapter.readSchedule(short)]);
  assert.equal(calls, 1);
  now += 1001; fail = true;
  await assert.rejects(adapter.readSchedule(short), { code: "NHL_SCHEDULE_UNAVAILABLE" });
  await assert.rejects(adapter.readSchedule(short), { code: "NHL_SCHEDULE_UNAVAILABLE" });
  assert.equal(calls, 2);
  now += 30_001; fail = false;
  assert.deepEqual((await adapter.readSchedule(short)).games, []);
  assert.equal(calls, 3);
});

test("partial, duplicate or malformed provider responses fail closed", async () => {
  for (const body of [{ gameWeek: [] }, { gameWeek: [{ date: "bad", games: [] }] }]) {
    const adapter = createNhlScheduleAdapter({ fetchImpl: async () => ({ ok: true, json: async () => body }) });
    await assert.rejects(adapter.readSchedule(range), { code: "NHL_SCHEDULE_UNAVAILABLE" });
  }
  const duplicate = rawGame(1, startsAtMs);
  const adapter = createNhlScheduleAdapter({ fetchImpl: async (url) => responseFor(url, [duplicate, duplicate]) });
  await assert.rejects(adapter.readSchedule(range), { code: "NHL_SCHEDULE_UNAVAILABLE" });
});

test("authorized reads honor league/season/week scope, custom dates and timezone with zero database writes", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE leagues(id TEXT, timezone TEXT); CREATE TABLE seasons(id TEXT, league_id TEXT, nhl_season_key TEXT); CREATE TABLE matchup_weeks(id TEXT, league_id TEXT, season_id TEXT, starts_at_ms INTEGER, ends_at_ms INTEGER, status TEXT)");
    for (const n of [1, 2]) {
      db.prepare("INSERT INTO leagues VALUES (?, ?)").run(id(n), "America/Vancouver");
      db.prepare("INSERT INTO seasons VALUES (?, ?, ?)").run(id(n + 10), id(n), "20262027");
      db.prepare("INSERT INTO matchup_weeks VALUES (?, ?, ?, ?, ?, ?)").run(id(n + 20), id(n), id(n + 10), startsAtMs, endsAtMs, "scheduled");
    }
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    let reads = 0;
    const service = createRosterScheduleService({ repository: createSqliteRosterScheduleRepository({ database: db }), leagueAuthorization: { requireActiveMembership(authenticated, leagueId) { if (authenticated !== leagueId) throw Object.assign(new Error("hidden"), { code: "LEAGUE_NOT_FOUND" }); } }, scheduleAdapter: { async readSchedule(input) { reads += 1; assert.deepEqual(input, range); return { games: [], fetchedAtMs: 1 }; } } });
    for (const n of [1, 2]) {
      const input = { leagueId: id(n), seasonId: id(n + 10), weekId: id(n + 20), authenticated: id(n) };
      assert.equal((await service.readWeek(input)).timeZone, "America/Vancouver");
      await assert.rejects(service.readWeek({ ...input, authenticated: "outsider" }), { code: "LEAGUE_NOT_FOUND" });
      await assert.rejects(service.readWeek({ ...input, weekId: id(99) }), { code: "ROSTER_SCHEDULE_WEEK_MISSING" });
      await assert.rejects(service.readWeek({ ...input, seasonId: id(99) }), { code: "ROSTER_SCHEDULE_WEEK_MISSING" });
    }
    assert.equal(reads, 2);
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
  } finally { db.close(); }
});

test("HTTP schedule route is registered, authenticated, private and reports provider failures", async () => {
  const pass = (_request, _response, next) => next();
  const security = Object.fromEntries(["assignRequestId", "authenticateUnsafe", "credentialedCors", "requireAllowedOrigin", "requireCompatibleFetchMetadata", "requireJson", "securityHeaders"].map((name) => [name, pass]));
  Object.assign(security, { authenticateBootstrap(req, res, next) { if (req.get("x-test-auth") !== "yes") return res.sendStatus(401); next(); }, getRequestId: () => "test", getSessionBootstrap: () => ({ user: "test" }), getAuthenticatedSession: () => ({}) });
  const matchupService = Object.fromEntries(["correctResult", "generateSchedule", "listWeeks", "readCurrentWeek", "readMatchup", "readStandings", "readWeek", "rebuildStandings", "transitionWeek"].map((key) => [key, () => ({})]));
  let failure = false;
  const app = express();
  app.use(createMatchupRouter({ requestSecurity: security, matchupService, auditPrivacyDigest: { digest() {} }, rosterScheduleService: { async readWeek(input) { assert.equal(input.weekId, id(21)); if (failure) throw Object.assign(new Error("private detail"), { code: "NHL_SCHEDULE_UNAVAILABLE" }); return { code: "ROSTER_SCHEDULE_FOUND", games: [] }; } } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const path = `/api/v1/leagues/${id(1)}/seasons/${id(11)}/matchup-weeks/${id(21)}/nhl-schedule`;
    assert.equal(selectTargetRouterKey("GET", path), "matchup");
    const url = `http://127.0.0.1:${server.address().port}${path}`;
    assert.equal((await fetch(url)).status, 401);
    const result = await fetch(url, { headers: { "x-test-auth": "yes" } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal((await result.json()).data.code, "ROSTER_SCHEDULE_FOUND");
    failure = true;
    const failed = await fetch(url, { headers: { "x-test-auth": "yes" } });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error.code, "NHL_SCHEDULE_UNAVAILABLE");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
