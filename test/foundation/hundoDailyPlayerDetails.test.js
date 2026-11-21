const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createDailyPlayerDetails } = require("../../src/daily/createDailyPlayerDetails");
const { createSqlitePlayerRepository } = require("../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository");
const { createSqliteRepositoryContext } = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { persistExpandedStatistics } = require("../../src/infrastructure/persistence/sqlite/expandedStatisticsPersistence");
const { emptyScoringStats, calculateExpandedScore } = require("../../src/domain/statistics/expandedScoringPolicy");

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const season = "20262027";
const injured = { status: "injured", source: "admin", observedAtMs: 1234, needsReview: false, stale: false,
  details: { timeline: "Week to week", designation: "Out", reason: "Upper body" } };
const player = { id: "88", name: "Daily name", team: "VAN", opponent: "EDM", position: "F" };
const unknown = { status: "unknown", source: null, observedAtMs: null, needsReview: false, stale: false };
function room() { return { id: "room", availablePlayers: [{ ...player }, { ...player, id: "99", name: "Other" }],
  auctions: [{ ...player, bidCount: 2, ownBid: 9 }],
  members: [{ id: "manager", roster: [{ ...player, price: 9, points: 3.25 }], points: 3.25 }],
  winners: [{ id: "manager", points: 3.25 }] }; }
function row(extra = {}) { return { id: uuid(1), injury: structuredClone(injured), statistics_nhl_season_key: season,
  statistics_provider: "nhl-completed-games", statistics_games_played: 8, statistics_goals: 2,
  statistics_assists: 4, statistics_fantasy_points_hundredths: 1850, ...extra }; }
function harness(value = row()) {
  const calls = [];
  const repository = { findByExternalIdentifier(input) {
    calls.push(input); return input.externalValue === "88" ? { id: uuid(1) } : null;
  }, findDetailById(...args) { assert.deepEqual(args, [uuid(1)], "no league context is read"); return value; } };
  return { calls, value, project: createDailyPlayerDetails({ playerRepository: repository, currentNhlSeason: season }).project };
}

test("Daily enriches every panel with only public fields, deduplicates reads and preserves room ordering/state", () => {
  const fixture = harness(row({ contracts: "private", tradeHistory: "private" })), original = room(), before = structuredClone(original);
  const result = fixture.project(original);
  assert.deepEqual(result.availablePlayers.map(p => p.id), ["88", "99"]);
  assert.deepEqual(fixture.calls, [{ provider: "nhl", externalValue: "88" }, { provider: "nhl", externalValue: "99" }]);
  for (const p of [result.availablePlayers[0], result.auctions[0], result.members[0].roster[0]]) {
    assert.deepEqual(p.injury, injured);
    assert.deepEqual(p.seasonStatistics, { gamesPlayed: 8, goals: 2, assists: 4, fantasyPointsHundredths: 1850 });
    assert.equal(p.contracts, undefined); assert.equal(p.tradeHistory, undefined);
  }
  assert.deepEqual(result.availablePlayers[1].injury, unknown);
  assert.equal(result.availablePlayers[1].seasonStatistics, null);
  assert.deepEqual(original, before);
  assert.deepEqual(result.winners, before.winners);
  assert.equal(result.members[0].roster[0].price, 9);
});

test("Daily rereads changed injury status on the same existing room and does not retain a recovery timeline", () => {
  const fixture = harness(), original = room();
  assert.equal(fixture.project(original).auctions[0].injury.status, "injured");
  fixture.value.injury = { status: "healthy", source: "admin", observedAtMs: 2345, needsReview: false, stale: false,
    details: { timeline: "obsolete" } };
  const result = fixture.project(original);
  for (const p of [result.availablePlayers[0], result.auctions[0], result.members[0].roster[0]]) {
    assert.equal(p.injury.status, "healthy"); assert.equal(p.injury.details, undefined);
  }
  assert.equal(fixture.calls.length, 4, "each response performs fresh identity lookups");
});

test("Daily never guesses malformed, unknown, ambiguous, or failed NHL identities by name", () => {
  const fixture = harness(), original = room();
  original.availablePlayers = [null, undefined, 88, "088", "-1", "88 OR 1=1", "9999999999999999", "Same Name"]
    .map(id => ({ ...player, id }));
  original.auctions = []; original.members = [];
  fixture.project(original).availablePlayers.forEach(p => { assert.deepEqual(p.injury, unknown); assert.equal(p.seasonStatistics, null); });
  assert.equal(fixture.calls.length, 0);
  for (const repository of [
    { findByExternalIdentifier() { throw new Error("Ambiguous identity"); }, findDetailById() { assert.fail(); } },
    { findByExternalIdentifier() { return { id: uuid(1) }; }, findDetailById() { throw new Error("Unavailable"); } },
    { findByExternalIdentifier() { return { id: uuid(1) }; }, findDetailById() { return row({ id: uuid(2) }); } },
  ]) assert.deepEqual(createDailyPlayerDetails({ playerRepository: repository, currentNhlSeason: season }).project(room()).auctions[0].injury, unknown);
});

test("Daily requires current complete safe season values while keeping known injuries", () => {
  for (const change of [
    { statistics_nhl_season_key: "20252026" }, { statistics_games_played: null }, { statistics_goals: -1 },
    { statistics_assists: "4" }, { statistics_fantasy_points_hundredths: null }, { statistics_fantasy_points_hundredths: NaN },
    { statistics_expanded_required: 1 }, { statistics_scoring_stats_json: "broken" },
  ]) {
    const result = harness(row(change)).project(room()).availablePlayers[0];
    assert.equal(result.seasonStatistics, null); assert.deepEqual(result.injury, injured);
  }
  assert.deepEqual(harness(row({ statistics_games_played: 0, statistics_goals: 0, statistics_assists: 0,
    statistics_fantasy_points_hundredths: 0 })).project(room()).auctions[0].seasonStatistics,
  { gamesPlayed: 0, goals: 0, assists: 0, fantasyPointsHundredths: 0 });
  assert.equal(harness(row({ statistics_fantasy_points_hundredths: -10 })).project(room()).auctions[0].seasonStatistics.fantasyPointsHundredths, -10);
});

test("Daily uses the existing SQLite NHL mapping, current Leago expanded totals and dynamic injury reader without database writes", t => {
  const database = new Database(":memory:"); database.pragma("foreign_keys=ON"); t.after(() => database.close());
  const now = Date.now();
  migrateDatabase({ database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "daily-player-details", now: () => now });
  createSqliteRepositoryContext({ database });
  const repository = createSqlitePlayerRepository({ database, currentNhlStatisticsSeason: season, expandedScoringEnabled: true });
  repository.insertPlayer({ id: uuid(1), firstName: "Global", lastName: "Identity", fullName: "Global Identity", birthDate: null,
    status: "active", createdAtMs: now, updatedAtMs: now });
  repository.insertExternalId({ id: uuid(2), playerId: uuid(1), provider: "nhl", externalValue: "88", createdAtMs: now });
  database.prepare("INSERT INTO player_source_state(id,player_id,provider,source_position,normalized_position,nhl_team_abbreviation,active,source_version,effective_at_ms,created_at_ms) VALUES (?,?,'nhl','D','D','VAN',1,'test',?,?)").run(uuid(3), uuid(1), now, now);
  database.prepare("INSERT INTO stat_sources(id,provider,status,created_at_ms,updated_at_ms,version) VALUES (?,'nhl-completed-games','active',?,?,1)").run(uuid(4), now, now);
  database.prepare("INSERT INTO stat_refreshes(id,stat_source_id,nhl_season_key,source_version,status,started_at_ms,completed_at_ms,player_count,version) VALUES (?,?,'20262027','test','succeeded',?,?,1,1)").run(uuid(5), uuid(4), now, now);
  database.prepare("INSERT INTO player_stat_totals(id,stat_source_id,refresh_id,nhl_season_key,player_id,games_played,goals,assists,nhl_points,fantasy_points_hundredths,source_updated_at_ms,created_at_ms) VALUES (?,?,?,'20262027',?,8,2,4,6,99999,?,?)").run(uuid(6), uuid(4), uuid(5), uuid(1), now, now);
  const scoringStats = { ...emptyScoringStats(), evenStrengthGoals: 2, primaryAssists: 3, secondaryAssists: 1, hits: 4, blockedShots: 3 };
  persistExpandedStatistics(database, { refreshId: uuid(5), nhlSeasonKey: season, playerIdentityProvider: "nhl",
    rows: [{ externalPlayerId: "88", gamesPlayed: 8, goals: 2, assists: 4 }], playerGameRows: [],
    expandedScoring: { scoringRuleVersion: "expanded-2026-v1", totalsRows: [{ playerId: "88", scoringStats }], playerGameRows: [] } });
  database.prepare("INSERT INTO player_injury_status(id,status,source,evidence_at_ms,observed_at_ms,review_reason,updated_at_ms,version,timeline,designation,injury_reason) VALUES (?,'injured','espn',?,?,'possible_return',?,1,'Week to week','Out','Upper body')")
    .run(uuid(1), now, now - 7 * 60 * 60_000, now);
  const project = createDailyPlayerDetails({ playerRepository: repository, currentNhlSeason: season }).project;
  const original = room(), before = database.serialize(), changes = database.prepare("SELECT total_changes() n").get().n;
  database.pragma("query_only=ON");
  const first = project(original);
  assert.deepEqual(database.serialize(), before);
  assert.equal(database.prepare("SELECT total_changes() n").get().n, changes);
  assert.equal(first.availablePlayers[0].injury.needsReview, true);
  assert.equal(first.availablePlayers[0].injury.stale, true);
  assert.equal(first.availablePlayers[0].injury.details.timeline, "Week to week");
  assert.deepEqual(first.availablePlayers[0].seasonStatistics, { gamesPlayed: 8, goals: 2, assists: 4,
    fantasyPointsHundredths: calculateExpandedScore(scoringStats, "D").fantasyPointsHundredths });
  database.pragma("query_only=OFF");
  database.prepare("UPDATE player_injury_status SET status='healthy',source='admin',review_reason=NULL,observed_at_ms=?,timeline=NULL,designation=NULL,injury_reason=NULL WHERE id=?").run(now, uuid(1));
  const updated = database.serialize(); database.pragma("query_only=ON");
  const second = project(original);
  assert.equal(second.members[0].roster[0].injury.status, "healthy");
  assert.equal(second.members[0].roster[0].injury.stale, false);
  assert.equal(second.members[0].roster[0].injury.details, undefined);
  assert.deepEqual(second.availablePlayers.map(p => p.id), first.availablePlayers.map(p => p.id));
  assert.deepEqual(database.serialize(), updated);
  assert.equal(original.availablePlayers[0].injury, undefined);
});
