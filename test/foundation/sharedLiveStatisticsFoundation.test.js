const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const Database = require("better-sqlite3");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { createSqliteSharedStatisticsRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSharedStatisticsRepository");
const { createSqliteSharedGameEvidenceRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteSharedGameEvidenceRepository");
const { createSqliteStatisticsRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");
const { readExpandedStatistics } = require("../../src/infrastructure/persistence/sqlite/expandedStatisticsPersistence");
const { createLiveStatisticsService } = require("../../src/application/services/statistics/createLiveStatisticsService");
const { buildSharedLiveCapture } = require("../../src/domain/statistics/sharedLiveCapturePolicy");
const { createPlayerGameCoverageRequirements } = require("../../src/domain/statistics/playerGameCoveragePolicy");
const { readCompactStatistics, pruneCompactTotalProjections } = require("../../src/infrastructure/persistence/sqlite/compactStatisticsEvidence");
const { createSqliteMatchupLockRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupLockRepository");
const { createMatchupLockService } = require("../../src/application/services/matchups/createMatchupLockService");
const { createMatchupLegalityService } = require("../../src/application/services/matchups/createMatchupLegalityService");
const { emptyScoringStats, EXPANDED_SCORING_VERSION, calculateExpandedScore } = require("../../src/domain/statistics/expandedScoringPolicy");
const { createSqlitePlayerRepository } = require("../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository");
const NOW = Date.parse("2026-12-20T12:00:00Z"), DAY = 86400000;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function command(n = 100, hits = 2) {
  const observedAtMs = NOW + n;
  const requirements = createPlayerGameCoverageRequirements({ nhlSeasonKey: "20262027", playerIdentityProvider: "nhl",
    requiredPlayers: [{ playerId: uuid(2), providerPlayerId: "101" }], requiredPlayerGames: [] });
  const stats = { ...emptyScoringStats(), evenStrengthGoals: 1, primaryAssists: 1, hits };
  return { refreshId: uuid(n), statSourceId: uuid(1), provider: "nhl-completed-games", playerIdentityProvider: "nhl",
    nhlSeasonKey: "20262027", sourceVersion: `shared-test-${n}`, completedAtMs: observedAtMs + 1,
    rows: [{ externalPlayerId: "101", gamesPlayed: 1, goals: 1, assists: 1, nhlPoints: 2, fantasyPointsHundredths: 225, sourceUpdatedAtMs: observedAtMs }],
    playerGameRows: [{ externalPlayerId: "101", nhlGameId: "2026020001", nhlGameScheduledStartsAtMs: NOW - DAY,
      observedGameState: "final", goals: 1, assists: 1, nhlPoints: 2, fantasyPointsHundredths: 225, sourceUpdatedAtMs: observedAtMs }],
    requiredPlayers: requirements.requiredPlayers, requiredPlayerGames: requirements.requiredPlayerGames, requirementsSha256: requirements.requirementsSha256,
    playerGameCoverage: [{ playerId: uuid(2), providerPlayerId: "101", providerTeamId: "22", disposition: "expected_game",
      nhlGameId: "2026020001", nhlGameScheduledStartsAtMs: NOW - DAY, observedGameState: "final" }],
    expandedScoring: { scoringRuleVersion: EXPANDED_SCORING_VERSION, totalsRows: [{ playerId: "101", scoringStats: stats }],
      playerGameRows: [{ playerId: "101", nhlGameId: "2026020001", gamesPlayed: 1, scoringStats: stats }] } };
}

function fixture(t, { compact = false } = {}) {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON"); t.after(() => db.close());
  migrateDatabase({ database: db, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "shared-live-test", now: () => NOW });
  db.prepare("INSERT INTO stat_sources (id,provider,status,created_at_ms,updated_at_ms) VALUES (?,'nhl-completed-games','active',1,1)").run(uuid(1));
  db.prepare("INSERT INTO players (id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms) VALUES (?,'Test','Player','Test Player','2000-01-01','active',1,1)").run(uuid(2));
  db.prepare("INSERT INTO player_external_ids (id,player_id,provider,external_value,created_at_ms) VALUES (?,?,'nhl','101',1)").run(uuid(3), uuid(2));
  db.prepare("INSERT INTO leagues (id,name,name_normalized,status,timezone,created_at_ms,updated_at_ms) VALUES (?,'Test','test','active','America/Vancouver',1,1)").run(uuid(4));
  db.prepare("INSERT INTO seasons (id,league_id,label,nhl_season_key,status,created_at_ms,updated_at_ms) VALUES (?,?,'2026-27','20262027','active',1,1)").run(uuid(5), uuid(4));
  db.prepare("INSERT INTO teams (id,league_id,name,name_normalized,status,created_at_ms,updated_at_ms) VALUES (?,?,'Test','test','active',1,1)").run(uuid(6), uuid(4));
  db.prepare(`INSERT INTO matchup_weeks (id,league_id,season_id,week_key,sequence,starts_at_ms,baseline_at_ms,locks_at_ms,ends_at_ms,rolls_over_at_ms,status,created_at_ms,updated_at_ms)
    VALUES (?,?,?,'week1',1,1,2,3,?,?,'live',1,1)`).run(uuid(7), uuid(4), uuid(5), NOW + 14 * DAY, NOW + 14 * DAY);
  db.prepare(`INSERT INTO player_ownerships (id,league_id,season_id,player_id,team_id,ownership_kind,roster_category,position_group,slot_number,acquired_transaction_type,created_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,'Rostered','Active','F',1,'test',1,1)`).run(uuid(8), uuid(4), uuid(5), uuid(2), uuid(6));
  const repo = createSqliteSharedStatisticsRepository({ database: db, compact });
  const shared = createSqliteSharedGameEvidenceRepository({ database: db });
  function start(c) { repo.startRefresh({ id: c.refreshId, statSourceId: c.statSourceId, nhlSeasonKey: c.nhlSeasonKey, startedAtMs: c.rows[0].sourceUpdatedAtMs }); return c; }
  const counts = () => ({ captures: db.prepare("SELECT COUNT(*) n FROM shared_game_evidence_captures").get().n,
    changes: db.prepare("SELECT COUNT(*) n FROM shared_game_evidence_changes").get().n });
  return { db, repo, shared, start, counts };
}

function assertEmptyRefresh(db, id) {
  assert.equal(db.prepare("SELECT status FROM stat_refreshes WHERE id=?").get(id).status, "started");
  for (const table of ["shared_game_evidence_captures", "player_stat_totals", "player_game_stat_observations",
    "stat_refresh_player_game_coverage_entries", "stat_refresh_player_game_sets", "expanded_stat_refreshes"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE refresh_id=?`).get(id).n, 0, table);
  }
  assert.equal(db.pragma("foreign_key_check").length, 0);
}

test("NHL capture conversion preserves identities, participation, observation time and scoring categories", () => {
  const c = command(), shared = buildSharedLiveCapture(c), game = shared.records[0];
  assert.equal(shared.observedAtMs, c.rows[0].sourceUpdatedAtMs); assert.equal(shared.capturedAtMs, c.completedAtMs);
  assert.equal(game.playerId, uuid(2)); assert.equal(game.providerPlayerId, "101"); assert.equal(game.providerTeamId, "22");
  assert.equal(game.gamesPlayed, 1); assert.equal(game.scoringStats.hits, 2);
  c.expandedScoring.playerGameRows[0].scoringStats.hits = 99;
  assert.equal(game.scoringStats.hits, 2);
});

for (const [name, change] of [
  ["mixed observation times", c => c.playerGameRows[0].sourceUpdatedAtMs++],
  ["missing coverage", c => c.playerGameCoverage.pop()],
  ["duplicate coverage", c => c.playerGameCoverage.push({ ...c.playerGameCoverage[0] })],
  ["changed identity", c => c.playerGameCoverage[0].playerId = uuid(9)],
  ["changed scheduled start", c => c.playerGameCoverage[0].nhlGameScheduledStartsAtMs++],
  ["changed state", c => c.playerGameCoverage[0].observedGameState = "in_progress"],
  ["missing categories", c => c.expandedScoring.playerGameRows.pop()],
  ["different source", c => c.provider = "other"],
]) test(`shared conversion refuses ${name}`, () => { const c = command(); change(c); assert.throws(() => buildSharedLiveCapture(c)); });

test("real refresh completion shares unchanged games and keeps both earlier score formats intact", async t => {
  const { db, repo, shared, start, counts } = fixture(t);
  const original = start(command(100));
  createSqliteStatisticsRepository({ database: db }).completeLiveRefresh(original);
  const old = readExpandedStatistics(db, original.refreshId);
  const protectedTables = ["leagues", "teams", "seasons", "matchup_weeks", "player_ownerships"];
  const before = protectedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  let first;
  for (const [n, hits] of [[101, 2], [102, 2], [103, 4]]) {
    const c = start(command(n, hits));
    const writes = db.prepare("SELECT total_changes() n").get().n;
    const prepared = await repo.prepareLiveRefresh(c);
    assert.equal(db.prepare("SELECT total_changes() n").get().n, writes);
    assert.equal(db.inTransaction, false);
    const result = repo.completeLiveRefresh(c, prepared);
    assert.equal(result.refresh.status, "succeeded");
    const capture = shared.read({ refreshId: c.refreshId });
    const legacy = readExpandedStatistics(db, c.refreshId);
    assert.deepEqual(capture.records[0].scoringStats, legacy.playerGames[0].scoringStats);
    for (const position of ["F", "D"]) assert.deepEqual(calculateExpandedScore(capture.records[0].scoringStats, position), calculateExpandedScore(legacy.playerGames[0].scoringStats, position));
    if (!first) first = capture;
  }
  assert.deepEqual(counts(), { captures: 3, changes: 2 });
  assert.deepEqual(shared.read({ refreshId: uuid(101) }), first);
  assert.deepEqual(readExpandedStatistics(db, original.refreshId), old);
  assert.deepEqual(protectedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()), before);
  assert.equal(db.pragma("foreign_key_check").length, 0);
});

test("compact refreshes reconstruct sealed evidence after obsolete total projections are removed", async t => {
  const { db, repo, start } = fixture(t, { compact: true });
  let first;
  for (const [n, hits] of [[100, 2], [101, 2], [102, 4]]) {
    const c = start(command(n, hits));
    repo.completeLiveRefresh(c, await repo.prepareLiveRefresh(c));
    const result = readCompactStatistics(db, c.refreshId);
    assert.equal(result.observations.length, 1);
    assert.equal(result.coverage.length, 1);
    assert.equal(result.expandedScoring.playerGames[0].scoringStats.hits, hits);
    assert.deepEqual(readExpandedStatistics(db, c.refreshId), result.expandedScoring);
    if (!first) first = result;
    assert.equal(pruneCompactTotalProjections(db), 0);
  }
  assert.deepEqual(readCompactStatistics(db, uuid(100)), first);
  for (const table of ["player_game_stat_observations", "stat_refresh_player_game_coverage_entries", "expanded_player_game_stats"]) {
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM player_stat_totals").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM shared_stat_total_changes").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM shared_game_evidence_changes").get().n, 2);
  const cold = new Database(db.serialize());
  try {
    cold.pragma("query_only=ON");
    assert.deepEqual(readCompactStatistics(cold, uuid(100)), first);
    assert.equal(cold.prepare("SELECT total_changes() n").get().n, 0);
  } finally { cold.close(); }
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("a real compact late lock retains exact exclusions and rolls materialization back on failure", async t => {
  const { db, repo, start } = fixture(t, { compact: true });
  db.prepare("INSERT INTO teams (id,league_id,name,name_normalized,status,created_at_ms,updated_at_ms) VALUES (?,?,'Away','away','active',1,1)").run(uuid(9), uuid(4));
  db.prepare(`INSERT INTO matchups (id,league_id,season_id,matchup_week_id,home_team_id,away_team_id,home_team_name,away_team_name,status,created_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,?,'Test','Away','live',1,1)`).run(uuid(10), uuid(4), uuid(5), uuid(7), uuid(6), uuid(9));
  db.prepare(`INSERT INTO matchup_roster_locks (id,league_id,season_id,matchup_week_id,team_id,lock_type,legal,legality_reason_code,locked_at_ms,source_freshness_status,created_at_ms)
    VALUES (?,?,?,?,?,'normal',0,'ACTIVE_FORWARD_SLOTS_INCOMPLETE',3,'unknown',3)`).run(uuid(11), uuid(4), uuid(5), uuid(7), uuid(6));
  const c = start(command(100));
  repo.completeLiveRefresh(c, await repo.prepareLiveRefresh(c));
  let failBeforeCommit = true, nextId = 1000;
  const locks = createSqliteMatchupLockRepository({ database: db, beforeCommit: () => { if (failBeforeCommit) throw new Error("injected compact lock failure"); } });
  const legality = createMatchupLegalityService({ repository: locks, normalLockService: createMatchupLockService({ repository: locks }),
    createId: () => uuid(nextId++), nowMs: () => NOW + 200, gameStateProvider: {
      async fetchGameStates({ games }) { return { provider: c.provider, sourceVersion: "game-state", observedAtMs: NOW + 200,
        games: games.map(game => ({ ...game, observedGameState: "final" })) }; },
    } });
  const scope = { leagueId: uuid(4), seasonId: uuid(5), weekId: uuid(7), teamId: uuid(6), lockId: uuid(11), provider: c.provider, nowMs: NOW + 200 };
  await assert.rejects(legality.lockLate(scope), error => error.cause?.message === "injected compact lock failure");
  assert.equal(db.prepare("SELECT legal FROM matchup_roster_locks WHERE id=?").get(uuid(11)).legal, 0);
  for (const table of ["player_game_stat_observations", "stat_refresh_player_game_coverage_entries", "matchup_roster_game_exclusions", "stat_snapshots"]) {
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  failBeforeCommit = false;
  await legality.lockLate(scope);
  assert.equal(db.prepare("SELECT legal FROM matchup_roster_locks WHERE id=?").get(uuid(11)).legal, 1);
  const exclusion = db.prepare("SELECT * FROM matchup_roster_game_exclusions").get();
  const baseline = readCompactStatistics(db, c.refreshId);
  assert.equal(exclusion.baseline_player_game_stat_observation_id, baseline.observations[0].id);
  assert.equal(db.prepare("SELECT count(*) n FROM player_game_stat_observations").get().n, 1);
  const next = command(300, 4);
  Object.assign(next, repo.readPlayerGameCoverageRequirements({ nhlSeasonKey: next.nhlSeasonKey, playerIdentityProvider: "nhl" }));
  assert.equal(next.requiredPlayerGames.length, 1);
  start(next); repo.completeLiveRefresh(next, await repo.prepareLiveRefresh(next));
  assert.equal(pruneCompactTotalProjections(db), 0);
  assert.deepEqual(readCompactStatistics(db, c.refreshId), baseline);
  assert.deepEqual(db.prepare("SELECT * FROM matchup_roster_game_exclusions").get(), exclusion);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

for (const compact of [false, true]) for (const disposition of ["no_due_game", "no_team"]) test(`a complete ${disposition} capture retains known-zero totals without inventing game evidence (compact=${compact})`, async t => {
  const { db, repo, shared, start, counts } = fixture(t, { compact });
  const c = command();
  c.rows = [{ ...c.rows[0], gamesPlayed: 0, goals: 0, assists: 0, nhlPoints: 0, fantasyPointsHundredths: 0 }];
  c.playerGameRows = [];
  c.playerGameCoverage = [{ ...c.requiredPlayers[0], providerTeamId: disposition === "no_team" ? null : "22", disposition,
    nhlGameId: null, nhlGameScheduledStartsAtMs: null, observedGameState: null }];
  c.expandedScoring = { scoringRuleVersion: EXPANDED_SCORING_VERSION,
    totalsRows: [{ playerId: "101", scoringStats: emptyScoringStats() }], playerGameRows: [] };
  start(c);
  assert.equal(repo.completeLiveRefresh(c, await repo.prepareLiveRefresh(c)).refresh.status, "succeeded");
  assert.deepEqual(counts(), { captures: 1, changes: 0 });
  assert.deepEqual(shared.read({ refreshId: c.refreshId }).records, []);
  assert.deepEqual(readExpandedStatistics(db, c.refreshId).totals[0].scoringStats, emptyScoringStats());
  const coverage = compact ? readCompactStatistics(db, c.refreshId).coverage[0] : db.prepare("SELECT disposition FROM stat_refresh_player_game_coverage_entries WHERE refresh_id=?").get(c.refreshId);
  assert.equal(coverage.disposition, disposition);
  if (compact) {
    const next = { ...c, refreshId: uuid(101), sourceVersion: "zero-next", completedAtMs: c.completedAtMs + 1 };
    start(next); repo.completeLiveRefresh(next, await repo.prepareLiveRefresh(next));
    assert.equal(db.prepare("SELECT count(*) n FROM shared_empty_coverage_sets").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM shared_stat_total_changes").get().n, 1);
    const cold = new Database(db.serialize());
    try { assert.deepEqual(readCompactStatistics(cold, c.refreshId).coverage, [coverage]); } finally { cold.close(); }
  }
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("changed commands and another repository's preparation cannot publish", async t => {
  const { db, repo, start, counts } = fixture(t); const c = start(command());
  const prepared = await repo.prepareLiveRefresh(c);
  assert.throws(() => repo.completeLiveRefresh({ ...c, sourceVersion: "changed" }, prepared), /unchanged prepared/);
  assert.throws(() => createSqliteSharedStatisticsRepository({ database: db }).completeLiveRefresh(c, prepared), /unchanged prepared/);
  assert.throws(() => repo.completeLiveRefresh(c), /unchanged prepared/);
  assert.deepEqual(counts(), { captures: 0, changes: 0 }); assertEmptyRefresh(db, c.refreshId);
});

test("a concurrent capture invalidates an older prepared history head without partial rows", async t => {
  const { db, repo, start, counts } = fixture(t); const a = start(command(100)); const pa = await repo.prepareLiveRefresh(a);
  const b = start(command(101)); repo.completeLiveRefresh(b, await repo.prepareLiveRefresh(b));
  assert.throws(() => repo.completeLiveRefresh(a, pa), /stale/);
  assert.deepEqual(counts(), { captures: 1, changes: 1 }); assertEmptyRefresh(db, a.refreshId);
});

for (const compact of [false, true]) for (const failure of ["requirements", "identity", "late-write", "suppressed-shared-write"]) test(`shared and legacy publication roll back together on ${failure} (compact=${compact})`, async t => {
  const { db, repo, start, counts } = fixture(t, { compact }); const c = start(command()); const prepared = await repo.prepareLiveRefresh(c);
  if (failure === "requirements") db.prepare("UPDATE player_ownerships SET roster_category='Bench' WHERE id=?").run(uuid(8));
  if (failure === "identity") db.prepare("UPDATE player_external_ids SET external_value='102' WHERE id=?").run(uuid(3));
  if (failure === "late-write") db.exec("CREATE TRIGGER test_late_failure BEFORE INSERT ON expanded_stat_refreshes BEGIN SELECT RAISE(ABORT,'late test failure'); END");
  if (failure === "suppressed-shared-write") db.exec("CREATE TRIGGER test_suppressed BEFORE INSERT ON shared_game_evidence_changes BEGIN SELECT RAISE(IGNORE); END");
  assert.throws(() => repo.completeLiveRefresh(c, prepared));
  assert.deepEqual(counts(), { captures: 0, changes: 0 }); assertEmptyRefresh(db, c.refreshId);
});

test("failed compact overwrite restores the prior current totals and immutable history", async t => {
  const { db, repo, start } = fixture(t, { compact: true });
  const first = start(command(100)); repo.completeLiveRefresh(first, await repo.prepareLiveRefresh(first));
  const prior = readCompactStatistics(db, first.refreshId);
  const tables = ["player_stat_totals", "expanded_stat_totals", "shared_game_evidence_changes", "shared_stat_total_changes", "compact_stat_refreshes"];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const next = start(command(101, 9)), prepared = await repo.prepareLiveRefresh(next);
  db.exec("CREATE TRIGGER test_overwrite_failure BEFORE UPDATE ON expanded_stat_totals BEGIN SELECT RAISE(ABORT,'injected overwrite failure'); END");
  assert.throws(() => repo.completeLiveRefresh(next, prepared));
  assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
  assert.deepEqual(readCompactStatistics(db, first.refreshId), prior);
  assertEmptyRefresh(db, next.refreshId);
});

test("compact and legacy modes can alternate while player lists and historical scores remain readable", async t => {
  const { db, repo, start } = fixture(t, { compact: true });
  db.prepare("INSERT INTO player_source_state (id,player_id,provider,source_position,normalized_position,nhl_team_abbreviation,active,source_version,effective_at_ms,created_at_ms) VALUES (?,?,'nhl','C','F','EDM',1,'test',1,1)").run(uuid(12), uuid(2));
  const players = createSqlitePlayerRepository({ database: db, currentNhlStatisticsSeason: "20262027", expandedScoringEnabled: true });
  const history = [];
  for (const [n, hits, compact] of [[100, 2, false], [101, 3, true], [102, 4, false], [103, 5, true]]) {
    const c = start(command(n, hits));
    if (compact) repo.completeLiveRefresh(c, await repo.prepareLiveRefresh(c));
    else createSqliteStatisticsRepository({ database: db }).completeLiveRefresh(c);
    history.push([c.refreshId, readExpandedStatistics(db, c.refreshId)]);
    const player = players.findDetailById(uuid(2));
    assert.equal(player.statistics_source_updated_at_ms, c.rows[0].sourceUpdatedAtMs);
    assert.equal(player.statistics_fantasy_points_hundredths, calculateExpandedScore(c.expandedScoring.totalsRows[0].scoringStats, "F").fantasyPointsHundredths);
  }
  const cold = new Database(db.serialize());
  try {
    cold.pragma("query_only=ON");
    for (const [id, expected] of history) assert.deepEqual(readExpandedStatistics(cold, id), expected);
    assert.equal(cold.prepare("SELECT total_changes() n").get().n, 0);
  } finally { cold.close(); }
});

test("removing an immutability guard invalidates warm evidence before corrupt totals can be trusted", async t => {
  const { db, repo, start } = fixture(t, { compact: true });
  const c = start(command()); repo.completeLiveRefresh(c, await repo.prepareLiveRefresh(c));
  assert.ok(readCompactStatistics(db, c.refreshId));
  db.exec("DROP TRIGGER shared_stat_total_changes_immutable_update; UPDATE shared_stat_total_changes SET payload_sha256=printf('%064d',0)");
  assert.throws(() => readCompactStatistics(db, c.refreshId), /corrupt/);
});

test("native statistics hashes preserve canonical evidence bytes including Unicode and nested values", () => {
  const original = require("../../src/domain/leagues/seasonRolloverEvidencePolicy").hashCanonicalJsonV1;
  const native = require("../../src/domain/statistics/statisticsEvidenceHash").hashCanonicalJsonV1;
  for (const value of [{}, { z: 0, a: [null, true, false, -1, 125, "é🏒\\\"\n"], nested: { b: 2, a: 1 } },
    { rows: Array.from({ length: 100 }, (_, id) => ({ id, stats: emptyScoringStats() })) }]) assert.equal(native(value), original(value));
  for (const value of [{ value: 1.25 }, { value: undefined }]) {
    assert.throws(() => native(value), { code: "CANONICAL_JSON_V1_INVALID" });
    assert.throws(() => original(value), { code: "CANONICAL_JSON_V1_INVALID" });
  }
});

function serviceFor(repo, events = []) {
  const c = command();
  const provider = { async fetchLiveSnapshot() {
    events.push("fetch");
    return { provider: c.provider, sourceVersion: c.sourceVersion, capturedAtMs: c.completedAtMs,
      totalsSourceUpdatedAtMs: c.rows[0].sourceUpdatedAtMs,
      totalsRows: c.rows.map(row => ({ playerId: row.externalPlayerId, gamesPlayed: row.gamesPlayed, goals: row.goals, assists: row.assists })),
      playerGameRows: c.playerGameRows.map(row => ({ playerId: row.externalPlayerId, nhlGameId: row.nhlGameId,
        nhlGameScheduledStartsAtMs: row.nhlGameScheduledStartsAtMs, observedGameState: row.observedGameState,
        goals: row.goals, assists: row.assists, sourceUpdatedAtMs: row.sourceUpdatedAtMs })),
      playerGameCoverage: { schemaVersion: 1, throughAtMs: c.completedAtMs, players: [{ ...c.requiredPlayers[0], providerTeamId: "22", disposition: "expected_game",
        games: c.playerGameCoverage.map(({ providerTeamId, nhlGameId, nhlGameScheduledStartsAtMs, observedGameState }) => ({ providerTeamId, nhlGameId, nhlGameScheduledStartsAtMs, observedGameState })) }] },
      expandedScoring: c.expandedScoring };
  } };
  return createLiveStatisticsService({ repository: repo, provider, nhlSeasonKey: c.nhlSeasonKey, providerName: c.provider,
    playerIdentityProvider: "nhl", minimumPlayerCount: 1, expandedScoringEnabled: true, nowMs: () => NOW });
}

test("the refresh service awaits preparation and rechecks its lease before the atomic write", async t => {
  const { db, repo, counts } = fixture(t); const events = [];
  const wrapped = { ...repo, async prepareLiveRefresh(c) { events.push("prepare-start"); await new Promise(setImmediate); const p = await repo.prepareLiveRefresh(c); events.push("prepare-end"); return p; },
    completeLiveRefresh(c, p) { events.push("complete"); return repo.completeLiveRefresh(c, p); } };
  const result = await serviceFor(wrapped, events).refresh({ authorizePersist: () => { events.push("authorize"); assert.equal(db.inTransaction, false); } });
  assert.equal(result.status, "succeeded"); assert.deepEqual(events, ["authorize", "fetch", "prepare-start", "prepare-end", "authorize", "complete"]);
  assert.deepEqual(counts(), { captures: 1, changes: 1 });
});

for (const failure of ["preparation", "expired-lease"]) test(`refresh ${failure} rejection keeps all scoring payloads unpublished`, async t => {
  const { db, repo, counts } = fixture(t); let calls = 0;
  const wrapped = failure === "preparation" ? { ...repo, async prepareLiveRefresh() { throw new Error("preparation unavailable"); } } : repo;
  await assert.rejects(serviceFor(wrapped).refresh({ authorizePersist: () => { if (++calls === 2) throw new Error("expired lease"); } }));
  assert.deepEqual(counts(), { captures: 0, changes: 0 });
  const rows = db.prepare("SELECT status,error_code FROM stat_refreshes").all();
  assert.deepEqual(rows, [{ status: "rejected", error_code: "LIVE_STATISTICS_PERSISTENCE_FAILED" }]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM player_stat_totals").get().n, 0);
});
