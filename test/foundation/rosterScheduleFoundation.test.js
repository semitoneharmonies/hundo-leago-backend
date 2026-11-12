const assert = require("node:assert/strict");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const express = require("express");
const { createNhlScheduleAdapter } = require("../../src/infrastructure/nhl/NhlScheduleAdapter");
const { createSqliteRosterScheduleRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteRosterScheduleRepository");
const { createRosterScheduleService } = require("../../src/application/services/leagues/createRosterScheduleService");
const { createMatchupRouter } = require("../../src/transport/http/createMatchupRouter");
const { selectTargetRouterKey } = require("../../src/bootstrap/createTargetRuntime");
const { completedGameEntry } = require("../../src/domain/statistics/completedGameCachePolicy");
const { emptyScoringStats, defaultScoringWeights, EXPANDED_SCORING_VERSION } = require("../../src/domain/statistics/expandedScoringPolicy");
const { prepareGameRecord } = require("../../src/domain/statistics/sharedGameEvidencePolicy");

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
    db.exec("CREATE TABLE leagues(id TEXT, timezone TEXT); CREATE TABLE seasons(id TEXT, league_id TEXT, nhl_season_key TEXT); CREATE TABLE matchup_weeks(id TEXT, league_id TEXT, season_id TEXT, starts_at_ms INTEGER, ends_at_ms INTEGER, status TEXT, sequence INTEGER)");
    for (const n of [1, 2]) {
      db.prepare("INSERT INTO leagues VALUES (?, ?)").run(id(n), "America/Vancouver");
      db.prepare("INSERT INTO seasons VALUES (?, ?, ?)").run(id(n + 10), id(n), "20262027");
      db.prepare("INSERT INTO matchup_weeks VALUES (?, ?, ?, ?, ?, ?, 1)").run(id(n + 20), id(n), id(n + 10), startsAtMs, endsAtMs, "scheduled");
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

function scoringFixture(t, expandedScoringEnabled = true) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`
    PRAGMA user_version=96;
    CREATE TABLE leagues(id, timezone, current_season_id);
    CREATE TABLE seasons(id, league_id, nhl_season_key);
    CREATE TABLE matchup_weeks(id, league_id, season_id, starts_at_ms, ends_at_ms, status, sequence);
    CREATE TABLE league_scoring_rules(id,league_id,season_id,effective_week_sequence,revision,weights_json);
    CREATE TABLE player_ownerships(league_id,season_id,player_id,position_group);
    CREATE TABLE player_external_ids(player_id,provider,external_value);
    CREATE TABLE player_source_state(id,player_id,provider,nhl_team_abbreviation,ended_at_ms,effective_at_ms);
    CREATE TABLE nhl_completed_game_cache(nhl_season_key,nhl_game_id,expanded,entry_json);
    CREATE TABLE stat_sources(id,provider);
    CREATE TABLE stat_refreshes(id,stat_source_id,nhl_season_key,status,completed_at_ms,started_at_ms);
    CREATE TABLE shared_game_evidence_captures(refresh_id,revision,sealed);
    CREATE TABLE shared_game_evidence_changes(stat_source_id,nhl_season_key,player_id,nhl_game_id,revision,payload_json,payload_sha256);
    CREATE TABLE player_game_stat_observations(id,player_id,refresh_id,nhl_game_id,nhl_game_scheduled_starts_at_ms,observed_game_state,fantasy_points_hundredths,stat_source_id);
    CREATE TABLE expanded_player_game_stats(observation_id,refresh_id,stats_json);
  `);
  db.prepare("INSERT INTO leagues VALUES (?, 'America/Vancouver', ?)").run(id(1), id(2));
  db.prepare("INSERT INTO seasons VALUES (?, ?, '20262027')").run(id(2), id(1));
  db.prepare("INSERT INTO matchup_weeks VALUES (?, ?, ?, ?, ?, 'live', 7)").run(id(3), id(1), id(2), startsAtMs, endsAtMs);
  for (const [n, league, position, team] of [[101,1,"D","VAN"],[102,1,"F","SEA"],[103,1,"F","SEA"],
    [104,2,"F","SEA"],[201,1,"F","VAN"],[202,1,"F","CBJ"],[203,1,"F","VAN"]]) {
    db.prepare("INSERT INTO player_ownerships VALUES (?, ?, ?, ?)").run(id(league), id(2), id(n), position);
    if (n !== 203) db.prepare("INSERT INTO player_external_ids VALUES (?, 'nhl', ?)").run(id(n), String(n));
    db.prepare("INSERT INTO player_source_state VALUES (?, ?, 'nhl', ?, NULL, 1)").run(n, id(n), team);
  }
  const weights = defaultScoringWeights();
  weights.D.hits = 75;
  const addRule = db.prepare("INSERT INTO league_scoring_rules VALUES (?, ?, ?, ?, 1, ?)");
  addRule.run(id(8), id(1), id(2), 7, JSON.stringify(weights));
  addRule.run(id(9), id(1), id(2), 8, JSON.stringify(defaultScoringWeights()));
  const games = ["final", "final", "live", "scheduled"].map((status, index) => ({
    id: String(501 + index), nhlSeasonKey: range.nhlSeasonKey, startsAtMs: startsAtMs + index * DAY,
    status, homeTeam: "VAN", awayTeam: "SEA", homeTeamId: "23", awayTeamId: "55", timeTbd: false,
  }));
  const service = createRosterScheduleService({
    repository: createSqliteRosterScheduleRepository({ database: db, expandedScoringEnabled }),
    leagueAuthorization: { requireActiveMembership() {} },
    scheduleAdapter: { async readSchedule() { return { fetchedAtMs: 1, games }; } },
  });
  async function read() {
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    const result = await service.readWeek({ leagueId: id(1), seasonId: id(2), weekId: id(3) });
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
    return result.games;
  }
  return { db, games, read };
}

test("each final shows the league's per-game FP for that week, including a minus, a true zero and a scratch", async t => {
  const { db, games, read } = scoringFixture(t);
  for (const [index, game] of games.entries()) {
    const rows = Array.from({ length: 34 }, (_, i) => ({ playerId: 101 + i, gameId: Number(game.id), gamesPlayed: 1, goals: 0, assists: 0 }));
    const categories = rows.map(row => {
      const stats = emptyScoringStats();
      if (row.playerId === 101) stats.hits = index + 1;
      if (row.playerId === 102) stats.giveaways = 1;
      return [`${game.id}:${row.playerId}`, stats];
    });
    const entry = completedGameEntry({ game, season: range.nhlSeasonKey, expanded: true, data: { rows, categories }, checkedAtMs: endsAtMs });
    db.prepare("INSERT INTO nhl_completed_game_cache VALUES (?, ?, 1, ?)").run(range.nhlSeasonKey, game.id, JSON.stringify(entry));
  }
  const actual = await read();
  for (const index of [0, 1]) {
    assert.deepEqual(Object.fromEntries(actual[index].playerPoints.map(row => [row.playerId, row.fantasyPointsHundredths])), {
      [id(101)]: 75 * (index + 1), [id(102)]: -10, [id(103)]: 0, [id(201)]: 0,
    });
  }
  assert.equal(actual[2].playerPoints, undefined);
  assert.equal(actual[3].playerPoints, undefined);
});

test("missing reports use only the latest successful game observations with the matching game start", async t => {
  const { db, games, read } = scoringFixture(t);
  db.exec(`INSERT INTO stat_sources VALUES ('source','nhl-completed-games');
    INSERT INTO stat_refreshes VALUES ('accepted','source','20262027','succeeded',100,90),('later','source','20262027','failed',120,110)`);
  const add = db.prepare("INSERT INTO player_game_stat_observations VALUES (?, ?, ?, ?, ?, ?, 125, 'source')");
  const addStats = db.prepare("INSERT INTO expanded_player_game_stats VALUES (?, ?, ?)");
  for (const [n, refresh, game, when, state] of [[101,"accepted","501",startsAtMs,"final"],[102,"later","501",startsAtMs,"final"],
    [103,"accepted","502",games[1].startsAtMs + 1,"final"],[201,"accepted","502",games[1].startsAtMs,"in_progress"]]) {
    add.run(n, id(n), refresh, game, when, state);
    addStats.run(n, refresh, JSON.stringify({ ...emptyScoringStats(), hits: 2 }));
  }
  const actual = await read();
  assert.deepEqual(actual[0].playerPoints, [{ playerId: id(101), fantasyPointsHundredths: 150 }]);
  assert.deepEqual(actual[1].playerPoints, []);
});

test("uncached finals resolve compact corrections and removal markers at the sealed revision", async t => {
  const { db, read } = scoringFixture(t);
  db.exec(`INSERT INTO stat_sources VALUES ('source','nhl-completed-games');
    INSERT INTO stat_refreshes VALUES ('accepted','source','20262027','succeeded',100,90);
    INSERT INTO shared_game_evidence_captures VALUES ('accepted',2,1)`);
  const insert = db.prepare("INSERT INTO shared_game_evidence_changes VALUES ('source','20262027',?, '501', ?, ?, ?)");
  for (const [n, revision, hits] of [[101,1,1],[101,2,2],[101,3,8],[102,1,1],[103,2,0]]) {
    const { payload, sha256 } = prepareGameRecord({ playerId: id(n), providerPlayerId: String(n), providerTeamId: "23",
      nhlGameId: "501", scheduledStartsAtMs: startsAtMs, gameState: "final", gamesPlayed: n === 103 ? 0 : 1,
      goals: 0, assists: 0, scoringRuleVersion: EXPANDED_SCORING_VERSION, scoringStats: { ...emptyScoringStats(), hits } });
    insert.run(id(n), revision, payload, sha256);
  }
  insert.run(id(102), 2, null, null);
  const actual = await read();
  assert.deepEqual(Object.fromEntries(actual[0].playerPoints.map(row => [row.playerId, row.fantasyPointsHundredths])), {
    [id(101)]: 150, [id(103)]: 0,
  });
  assert.deepEqual(actual[1].playerPoints, []);
});

test("base scoring uses a complete base report when expanded scoring is disabled; incomplete reports remain pending", async t => {
  const { db, games, read } = scoringFixture(t, false);
  for (const [index, game] of games.slice(0, 2).entries()) {
    const rows = Array.from({ length: index === 0 ? 34 : 12 }, (_, i) => ({
      playerId: 101 + i, gameId: Number(game.id), gamesPlayed: 1, goals: 2, assists: 3,
    }));
    const entry = completedGameEntry({ game, season: range.nhlSeasonKey, expanded: false, data: { rows, categories: [] }, checkedAtMs: endsAtMs });
    db.prepare("INSERT INTO nhl_completed_game_cache VALUES (?, ?, 0, ?)").run(range.nhlSeasonKey, game.id, JSON.stringify(entry));
  }
  const result = await read();
  assert.equal(result[0].playerPoints.find(row => row.playerId === id(101)).fantasyPointsHundredths, 550);
  assert.deepEqual(result[1].playerPoints, []);
});
