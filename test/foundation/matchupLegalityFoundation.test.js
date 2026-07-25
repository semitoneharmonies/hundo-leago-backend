const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  MATCHUP_LEGALITY_CODES,
  evaluateMatchupLineupLegality,
} = require("../../src/domain/matchups/matchupLegalityPolicy");
const {
  MATCHUP_LEGALITY_SERVICE_CODES,
  createMatchupLegalityService,
} = require("../../src/application/services/matchups/createMatchupLegalityService");
const {
  createMatchupLockService,
} = require("../../src/application/services/matchups/createMatchupLockService");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupLockRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupLockRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const HOUR_MS = 60 * 60 * 1000;
const START_MS = 100 * HOUR_MS;
const BASELINE_MS = START_MS + HOUR_MS;
const LOCK_MS = START_MS + 16 * HOUR_MS;
const LATE_MS = LOCK_MS + HOUR_MS;
const END_MS = START_MS + 7 * 24 * HOUR_MS;
const IDS = Object.freeze({
  league: uuid(1), season: uuid(2), week: uuid(3), home: uuid(4), away: uuid(5),
  matchup: uuid(6), source: uuid(7), refresh: uuid(8), opponentSnapshot: uuid(9),
  opponentLock: uuid(10), homeLock: uuid(11),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function lineup(forwardCount = 12, defenceCount = 6) {
  const players = [];
  for (let slot = 1; slot <= forwardCount; slot += 1) {
    players.push({ player_id: uuid(100 + slot), position_group: "F", slot_number: slot });
  }
  for (let slot = 1; slot <= defenceCount; slot += 1) {
    players.push({ player_id: uuid(200 + slot), position_group: "D", slot_number: slot });
  }
  return players;
}

function seed(database, refreshCompletedAtMs) {
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Legality League', 'legality league', 'active', 'America/Vancouver', 1, 1, 1)"
  ).run(IDS.league);
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  );
  insertTeam.run(IDS.home, IDS.league, "Home", "home");
  insertTeam.run(IDS.away, IDS.league, "Away", "away");
  database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, ?, ?, ?, ?, ?, 'live', 1, 1, 2)"
  ).run(IDS.week, IDS.league, IDS.season, START_MS, BASELINE_MS, LOCK_MS, END_MS, END_MS);
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'live', 1, 1, 2)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.home, IDS.away);

  const allPlayers = lineup();
  const insertPlayer = database.prepare(
    "INSERT INTO players (id, first_name, last_name, full_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, 'Player', ?, 'active', 1, 1, 1)"
  );
  const insertOwnership = database.prepare(
    "INSERT INTO player_ownerships (id, league_id, season_id, player_id, team_id, ownership_kind, " +
      "roster_category, position_group, slot_number, acquired_transaction_type, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'Rostered', ?, ?, ?, 'test', 1, 1, 1)"
  );
  allPlayers.forEach((player, index) => {
    insertPlayer.run(player.player_id, `P${index}`, `P${index} Player`);
    const missingForward = player.position_group === "F" && player.slot_number === 12;
    insertOwnership.run(
      uuid(300 + index), IDS.league, IDS.season, player.player_id, IDS.home,
      missingForward ? "Bench" : "Active", player.position_group,
      missingForward ? 1 : player.slot_number
    );
  });
  database.prepare(
    "INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'nhl', 'active', 1, 1, 1)"
  ).run(IDS.source);
  database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, version) VALUES (?, ?, '20262027', 'late-v1', 'succeeded', ?, ?, 18, 1)"
  ).run(IDS.refresh, IDS.source, refreshCompletedAtMs - 1, refreshCompletedAtMs);
  const insertTotal = database.prepare(
    "INSERT INTO player_stat_totals (id, stat_source_id, refresh_id, nhl_season_key, player_id, " +
      "games_played, goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (?, ?, ?, '20262027', ?, 10, ?, 2, ?, ?, ?, ?)"
  );
  allPlayers.forEach((player, index) => {
    const goals = index % 3;
    insertTotal.run(
      uuid(400 + index), IDS.source, IDS.refresh, player.player_id, goals,
      goals + 2, goals * 125 + 200, refreshCompletedAtMs, refreshCompletedAtMs
    );
  });
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_baseline', 'complete', 'fresh', ?, 1, ?)"
  ).run(IDS.opponentSnapshot, IDS.source, IDS.refresh, IDS.league, IDS.season, IDS.week, BASELINE_MS, BASELINE_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 1, NULL, ?, ?, 'fresh', ?, 1)"
  ).run(IDS.opponentLock, IDS.league, IDS.season, IDS.week, IDS.away, LOCK_MS, IDS.opponentSnapshot, LOCK_MS);
}

function createRuntime(t, { refreshCompletedAtMs = LATE_MS, failure = () => false } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-05-"));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "legality.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-05-test",
    now: () => 1,
  });
  seed(connection.database, refreshCompletedAtMs);
  const repository = createSqliteMatchupLockRepository({
    database: connection.database,
    beforeCommit() {
      if (failure()) throw new Error("late legality failure");
    },
  });
  let nextId = 600;
  const createId = () => uuid(nextId++);
  const normalLockService = createMatchupLockService({ repository, createId });
  const service = createMatchupLegalityService({ repository, normalLockService, createId });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { database: connection.database, service };
}

function input(nowMs = LOCK_MS) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    teamId: IDS.home,
    provider: "nhl",
    lockId: IDS.homeLock,
    nowMs,
  };
}

function makeLegal(database) {
  database.prepare(
    "UPDATE player_ownerships SET roster_category = 'Active', slot_number = 12, " +
      "updated_at_ms = 2, version = version + 1 WHERE player_id = ?"
  ).run(uuid(112));
}

describe("M6-05 matchup lineup legality", () => {
  test("requires every exact forward and defence slot", () => {
    assert.equal(evaluateMatchupLineupLegality(lineup()).legal, true);
    const missingForward = evaluateMatchupLineupLegality(lineup(11, 6));
    assert.equal(missingForward.legal, false);
    assert.equal(missingForward.primaryReasonCode, MATCHUP_LEGALITY_CODES.forwardSlotsIncomplete);
    const missingDefence = evaluateMatchupLineupLegality(lineup(12, 5));
    assert.deepEqual(missingDefence.reasonCodes, [MATCHUP_LEGALITY_CODES.defenceSlotsIncomplete]);
  });
});

describe("M6-05 illegal-at-lock and late legality", () => {
  test("records zero state, then creates one late team baseline without touching the opponent", (t) => {
    const { database, service } = createRuntime(t);
    const opponentBefore = database.prepare("SELECT * FROM matchup_roster_locks WHERE id = ?").get(IDS.opponentLock);
    const illegal = service.lockAtBoundary(input());
    assert.equal(illegal.lock.legal, 0);
    assert.equal(illegal.playerCount, 0);
    const illegalRow = database.prepare("SELECT * FROM matchup_roster_locks WHERE id = ?").get(IDS.homeLock);
    assert.equal(illegalRow.baseline_snapshot_id, null);
    assert.equal(illegalRow.legality_reason_code, MATCHUP_LEGALITY_CODES.forwardSlotsIncomplete);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_players WHERE matchup_roster_lock_id = ?").get(IDS.homeLock).count,
      0
    );

    makeLegal(database);
    assert.equal(service.lockAtBoundary(input()).replayed, true);
    const late = service.lockLate(input(LATE_MS));
    assert.equal(late.lock.lock_type, "late");
    assert.equal(late.lock.legal, 1);
    assert.equal(late.playerCount, 18);
    const promoted = database.prepare("SELECT * FROM matchup_roster_locks WHERE id = ?").get(IDS.homeLock);
    assert.equal(promoted.locked_at_ms, LATE_MS);
    assert.equal(promoted.legality_reason_code, null);
    assert.equal(
      database.prepare("SELECT captured_at_ms FROM stat_snapshots WHERE id = ?").get(promoted.baseline_snapshot_id).captured_at_ms,
      LATE_MS
    );
    assert.deepEqual(
      database.prepare("SELECT * FROM matchup_roster_locks WHERE id = ?").get(IDS.opponentLock),
      opponentBefore
    );
    assert.equal(service.lockLate(input(LATE_MS)).replayed, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_locks").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("rejects early or still-illegal late locks without changing zero state", (t) => {
    const { database, service } = createRuntime(t);
    service.lockAtBoundary(input());
    assert.throws(() => service.lockLate(input(LOCK_MS)), {
      code: MATCHUP_LEGALITY_SERVICE_CODES.tooEarly,
    });
    assert.throws(() => service.lockLate(input(LATE_MS)), {
      code: MATCHUP_LEGALITY_SERVICE_CODES.stillIllegal,
    });
    const row = database.prepare("SELECT legal, lock_type, baseline_snapshot_id, version FROM matchup_roster_locks WHERE id = ?").get(IDS.homeLock);
    assert.deepEqual(row, { legal: 0, lock_type: "normal", baseline_snapshot_id: null, version: 1 });
  });

  test("rolls a failed late conversion back to the original illegal evidence", (t) => {
    let fail = false;
    const { database, service } = createRuntime(t, { failure: () => fail });
    service.lockAtBoundary(input());
    makeLegal(database);
    fail = true;
    assert.throws(() => service.lockLate(input(LATE_MS)));
    const home = database.prepare("SELECT legal, lock_type, baseline_snapshot_id, version FROM matchup_roster_locks WHERE id = ?").get(IDS.homeLock);
    assert.deepEqual(home, { legal: 0, lock_type: "normal", baseline_snapshot_id: null, version: 1 });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM stat_snapshots").get().count,
      1
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_players WHERE matchup_roster_lock_id = ?").get(IDS.homeLock).count,
      0
    );
  });
});
