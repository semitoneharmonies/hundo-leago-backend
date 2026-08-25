const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  STATISTICS_CODES,
  normalizeStatisticsRows,
} = require("../../src/domain/statistics/statisticsPolicy");
const {
  createPlayerGameObservationSetEvidence,
  normalizePlayerGameStatisticsRows,
} = require("../../src/domain/statistics/playerGameStatisticsPolicy");
const {
  createPlayerGameCoverageSetEvidence,
  normalizePlayerGameCoverageResponse,
} = require("../../src/domain/statistics/playerGameCoveragePolicy");
const {
  TARGET_STATISTICS_CODES,
  createTargetStatisticsService,
} = require("../../src/application/services/statistics/createTargetStatisticsService");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqlitePlayerRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository");
const {
  createSqliteStatisticsRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const NOW_MS = Date.parse("2026-10-12T08:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function idFactory(start = 100) {
  let value = start;
  return () => uuid(value++);
}

function clock(start = NOW_MS) {
  let value = start;
  return () => value++;
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-leago-m6-01-statistics-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "statistics.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-01-test",
    now: () => NOW_MS,
  });
  const players = createSqlitePlayerRepository({ database: connection.database });
  const repository = createSqliteStatisticsRepository({
    database: connection.database,
    createId: idFactory(800),
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { database: connection.database, players, repository };
}

function insertPlayer(players, value, externalValue) {
  players.create({
    player: {
      id: uuid(value),
      firstName: "Player",
      lastName: String(value),
      fullName: `Player ${value}`,
      birthDate: "2000-01-01",
      status: "active",
      createdAtMs: NOW_MS - 1000,
      updatedAtMs: NOW_MS - 1000,
    },
    externalId: {
      id: uuid(value + 100),
      playerId: uuid(value),
      provider: "nhl",
      externalValue,
      createdAtMs: NOW_MS - 1000,
    },
  });
}

function insertBarePlayer(database, value) {
  database.prepare(
    "INSERT INTO players " +
      "(id, first_name, last_name, full_name, birth_date, status, " +
      "created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Player', ?, ?, '2000-01-01', 'active', ?, ?, 1)"
  ).run(
    uuid(value),
    String(value),
    `Player ${value}`,
    NOW_MS - 1000,
    NOW_MS - 1000
  );
}

function insertProviderIdentity(
  database,
  { idValue, playerValue, provider, externalValue }
) {
  database.prepare(
    "INSERT INTO player_external_ids " +
      "(id, player_id, provider, external_value, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?)"
  ).run(
    uuid(idValue),
    uuid(playerValue),
    provider,
    externalValue,
    NOW_MS - 1000
  );
}

function seedCoverageScope(
  database,
  {
    base,
    nhlSeasonKey = "20262027",
    weekStatus = null,
    ownerships = [],
  }
) {
  const scope = Object.freeze({
    leagueId: uuid(base),
    seasonId: uuid(base + 1),
    teamId: uuid(base + 2),
    weekId: uuid(base + 3),
  });
  database.prepare(
    "INSERT INTO leagues " +
      "(id, name, name_normalized, status, timezone, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, ?, 'active', " +
      "'America/Vancouver', 1, 1, 1)"
  ).run(
    scope.leagueId,
    `Coverage ${base}`,
    `coverage ${base}`
  );
  database.prepare(
    "INSERT INTO seasons " +
      "(id, league_id, label, nhl_season_key, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  ).run(
    scope.seasonId,
    scope.leagueId,
    `Season ${base}`,
    nhlSeasonKey
  );
  database.prepare(
    "INSERT INTO teams " +
      "(id, league_id, name, name_normalized, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, 'Coverage Team', " +
      "'coverage team', 'active', 1, 1, 1)"
  ).run(scope.teamId, scope.leagueId);
  if (weekStatus !== null) {
    database.prepare(
      "INSERT INTO matchup_weeks " +
        "(id, league_id, season_id, week_key, sequence, starts_at_ms, " +
        "baseline_at_ms, locks_at_ms, ends_at_ms, rolls_over_at_ms, " +
        "status, created_at_ms, updated_at_ms, version) " +
        "VALUES (?, ?, ?, 'regular-01', 1, 100, 101, 102, 200, 201, " +
        "?, 1, 1, 1)"
    ).run(
      scope.weekId,
      scope.leagueId,
      scope.seasonId,
      weekStatus
    );
  }
  const insertOwnership = database.prepare(
    "INSERT INTO player_ownerships " +
      "(id, league_id, season_id, player_id, team_id, ownership_kind, " +
      "roster_category, position_group, slot_number, " +
      "acquired_transaction_type, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'coverage_test', 1, 1, 1)"
  );
  ownerships.forEach((ownership, index) => {
    insertOwnership.run(
      uuid(base + 100 + index),
      scope.leagueId,
      scope.seasonId,
      uuid(ownership.playerValue),
      scope.teamId,
      ownership.ownershipKind ?? "Rostered",
      ownership.rosterCategory ?? "Active",
      ownership.positionGroup ?? "F"
    );
  });
  return scope;
}

function insertCoverageOwnership(
  database,
  scope,
  {
    idValue,
    playerValue,
    ownershipKind = "Rostered",
    rosterCategory = "Active",
    positionGroup = "F",
  }
) {
  database.prepare(
    "INSERT INTO player_ownerships " +
      "(id, league_id, season_id, player_id, team_id, ownership_kind, " +
      "roster_category, position_group, slot_number, " +
      "acquired_transaction_type, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'coverage_test', 1, 1, 1)"
  ).run(
    uuid(idValue),
    scope.leagueId,
    scope.seasonId,
    uuid(playerValue),
    scope.teamId,
    ownershipKind,
    rosterCategory,
    positionGroup
  );
}

function insertLockedPlayers(
  database,
  scope,
  { base, playerValues }
) {
  const lockId = uuid(base);
  database.prepare(
    "INSERT INTO matchup_roster_locks " +
      "(id, league_id, season_id, matchup_week_id, team_id, lock_type, " +
      "legal, legality_reason_code, locked_at_ms, baseline_snapshot_id, " +
      "source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 0, " +
      "'ACTIVE_FORWARD_SLOTS_INCOMPLETE', 102, NULL, 'unknown', 102, 1)"
  ).run(
    lockId,
    scope.leagueId,
    scope.seasonId,
    scope.weekId,
    scope.teamId
  );
  const insertLockedPlayer = database.prepare(
    "INSERT INTO matchup_roster_players " +
      "(id, league_id, season_id, matchup_roster_lock_id, player_id, " +
      "position_group, slot_number, baseline_games_played, baseline_goals, " +
      "baseline_assists, baseline_fantasy_points_hundredths, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, 'F', ?, 0, 0, 0, 0, 102)"
  );
  playerValues.forEach((playerValue, index) => {
    insertLockedPlayer.run(
      uuid(base + 1 + index),
      scope.leagueId,
      scope.seasonId,
      lockId,
      uuid(playerValue),
      index + 1
    );
  });
  return lockId;
}

function insertSyntheticExclusion(
  database,
  scope,
  { base, playerValue }
) {
  database.exec(
    "DROP TRIGGER IF EXISTS matchup_roster_game_exclusions_stage_before_set; " +
      "DROP TRIGGER IF EXISTS matchup_roster_game_exclusion_sets_valid_insert; " +
      "DROP TRIGGER IF EXISTS matchup_roster_game_exclusion_sets_immutable_delete; " +
      "DROP TRIGGER IF EXISTS matchup_roster_game_exclusions_immutable_delete;"
  );
  database.pragma("foreign_keys = OFF");
  try {
    database.prepare(
      "INSERT INTO matchup_roster_game_exclusions " +
        "(id, league_id, season_id, exclusion_set_id, matchup_week_id, " +
        "matchup_id, team_id, matchup_roster_lock_id, " +
        "matchup_roster_player_id, player_id, observation_snapshot_id, " +
        "observation_id, baseline_player_game_stat_observation_id, " +
        "nhl_game_id, nhl_game_scheduled_starts_at_ms, " +
        "observed_game_state, late_snapshot_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'game-1', " +
        "100, 'final', 200, 200, 1)"
    ).run(
      uuid(base),
      scope.leagueId,
      scope.seasonId,
      uuid(base + 1),
      scope.weekId,
      uuid(base + 2),
      scope.teamId,
      uuid(base + 3),
      uuid(base + 4),
      uuid(playerValue),
      uuid(base + 5),
      uuid(base + 6),
      uuid(base + 7)
    );
    database.prepare(
      "INSERT INTO matchup_roster_game_exclusion_sets " +
        "(id, league_id, season_id, matchup_week_id, matchup_id, team_id, " +
        "matchup_roster_lock_id, matchup_roster_lock_version, " +
        "baseline_snapshot_id, observation_snapshot_id, late_snapshot_at_ms, " +
        "exclusion_count, evidence_schema_version, evidence_sha256, " +
        "sealed_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 200, 1, 1, ?, 200, 200, 1)"
    ).run(
      uuid(base + 1),
      scope.leagueId,
      scope.seasonId,
      scope.weekId,
      uuid(base + 2),
      scope.teamId,
      uuid(base + 3),
      uuid(base + 8),
      uuid(base + 5),
      "a".repeat(64)
    );
  } finally {
    database.pragma("foreign_keys = ON");
  }
  return uuid(base);
}

function insertHistoricalExclusionEvidence(
  database,
  scope,
  {
    base,
    playerValue,
    providerTeamId,
    nhlGameId = `game-${base}`,
    nhlGameScheduledStartsAtMs = 110,
  }
) {
  const season = database.prepare(
    "SELECT nhl_season_key AS nhlSeasonKey FROM seasons " +
      "WHERE league_id = ? AND id = ?"
  ).get(scope.leagueId, scope.seasonId);
  const identity = database.prepare(
    "SELECT external_value AS providerPlayerId " +
      "FROM player_external_ids " +
      "WHERE player_id = ? AND provider = 'nhl'"
  ).get(uuid(playerValue));
  if (!season || !identity) {
    throw new Error(
      "Historical exclusion evidence requires an exact season and NHL identity."
    );
  }
  const ids = Object.freeze({
    sourceId: uuid(base),
    refreshId: uuid(base + 1),
    setId: uuid(base + 2),
    coverageEntryId: uuid(base + 3),
    baselineObservationId: uuid(base + 4),
    baselineSnapshotId: uuid(base + 5),
    lockId: uuid(base + 6),
    lockedPlayerId: uuid(base + 7),
    awayTeamId: uuid(base + 8),
    matchupId: uuid(base + 9),
    observationSnapshotId: uuid(base + 10),
    observationId: uuid(base + 11),
    exclusionSetId: uuid(base + 12),
    exclusionId: uuid(base + 13),
  });
  const sourceProvider = `history-${base}`;
  const sourceVersion = `history-v1-${base}`;
  const capturedAtMs = 120;
  const lateSnapshotAtMs = 150;

  database.prepare(
    "INSERT INTO teams " +
      "(id, league_id, name, name_normalized, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  ).run(
    ids.awayTeamId,
    scope.leagueId,
    `Historical Away ${base}`,
    `historical away ${base}`
  );
  database.prepare(
    "INSERT INTO matchups " +
      "(id, league_id, season_id, matchup_week_id, home_team_id, " +
      "away_team_id, home_team_name, away_team_name, status, " +
      "created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Coverage Team', ?, 'live', 1, 1, 1)"
  ).run(
    ids.matchupId,
    scope.leagueId,
    scope.seasonId,
    scope.weekId,
    scope.teamId,
    ids.awayTeamId,
    `Historical Away ${base}`
  );
  database.prepare(
    "INSERT INTO stat_sources " +
      "(id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, 'active', 1, 1, 1)"
  ).run(ids.sourceId, sourceProvider);
  database.prepare(
    "INSERT INTO stat_refreshes " +
      "(id, stat_source_id, nhl_season_key, source_version, status, " +
      "started_at_ms, completed_at_ms, player_count, error_code, " +
      "metadata_json, version) " +
      "VALUES (?, ?, ?, ?, 'succeeded', 100, ?, 1, NULL, NULL, 1)"
  ).run(
    ids.refreshId,
    ids.sourceId,
    season.nhlSeasonKey,
    sourceVersion,
    capturedAtMs
  );

  database.transaction(() => {
    database.prepare(
      "INSERT INTO stat_refresh_player_game_coverage_entries " +
        "(id, stat_source_id, refresh_id, observation_set_id, " +
        "nhl_season_key, player_id, provider_player_id, " +
        "provider_team_id, disposition, nhl_game_id, " +
        "nhl_game_scheduled_starts_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'expected_game', ?, ?, ?, 1)"
    ).run(
      ids.coverageEntryId,
      ids.sourceId,
      ids.refreshId,
      ids.setId,
      season.nhlSeasonKey,
      uuid(playerValue),
      identity.providerPlayerId,
      providerTeamId,
      nhlGameId,
      nhlGameScheduledStartsAtMs,
      capturedAtMs
    );
    database.prepare(
      "INSERT INTO player_game_stat_observations " +
        "(id, stat_source_id, refresh_id, observation_set_id, " +
        "nhl_season_key, player_id, nhl_game_id, " +
        "nhl_game_scheduled_starts_at_ms, observed_game_state, goals, " +
        "assists, nhl_points, fantasy_points_hundredths, " +
        "source_updated_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, 0, 0, 0, ?, ?, 1)"
    ).run(
      ids.baselineObservationId,
      ids.sourceId,
      ids.refreshId,
      ids.setId,
      season.nhlSeasonKey,
      uuid(playerValue),
      nhlGameId,
      nhlGameScheduledStartsAtMs,
      capturedAtMs,
      capturedAtMs
    );
    database.prepare(
      "INSERT INTO stat_refresh_player_game_sets " +
        "(id, stat_source_id, refresh_id, nhl_season_key, provider, " +
        "source_version, captured_at_ms, required_player_count, " +
        "coverage_entry_count, expected_player_game_count, " +
        "coverage_schema_version, coverage_sha256, observation_count, " +
        "evidence_schema_version, evidence_sha256, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, 1, 1, ?, ?, 1)"
    ).run(
      ids.setId,
      ids.sourceId,
      ids.refreshId,
      season.nhlSeasonKey,
      sourceProvider,
      sourceVersion,
      capturedAtMs,
      "a".repeat(64),
      "b".repeat(64),
      capturedAtMs
    );
  })();

  database.prepare(
    "INSERT INTO stat_snapshots " +
      "(id, stat_source_id, source_refresh_id, league_id, season_id, " +
      "matchup_week_id, intended_use, completeness_status, " +
      "freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_baseline', 'complete', " +
      "'fresh', ?, 1, ?)"
  ).run(
    ids.baselineSnapshotId,
    ids.sourceId,
    ids.refreshId,
    scope.leagueId,
    scope.seasonId,
    scope.weekId,
    capturedAtMs,
    capturedAtMs
  );
  database.prepare(
    "INSERT INTO matchup_roster_locks " +
      "(id, league_id, season_id, matchup_week_id, team_id, lock_type, " +
      "legal, legality_reason_code, locked_at_ms, baseline_snapshot_id, " +
      "source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'late', 1, NULL, ?, ?, 'fresh', ?, 1)"
  ).run(
    ids.lockId,
    scope.leagueId,
    scope.seasonId,
    scope.weekId,
    scope.teamId,
    lateSnapshotAtMs,
    ids.baselineSnapshotId,
    lateSnapshotAtMs
  );
  database.prepare(
    "INSERT INTO matchup_roster_players " +
      "(id, league_id, season_id, matchup_roster_lock_id, player_id, " +
      "position_group, slot_number, baseline_games_played, " +
      "baseline_goals, baseline_assists, " +
      "baseline_fantasy_points_hundredths, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, 'F', 1, 0, 0, 0, 0, ?)"
  ).run(
    ids.lockedPlayerId,
    scope.leagueId,
    scope.seasonId,
    ids.lockId,
    uuid(playerValue),
    lateSnapshotAtMs
  );

  database.transaction(() => {
    database.prepare(
      "INSERT INTO nhl_game_state_observations " +
        "(id, league_id, season_id, observation_snapshot_id, " +
        "nhl_game_id, nhl_game_scheduled_starts_at_ms, " +
        "observed_game_state, observed_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'final', ?, ?, 1)"
    ).run(
      ids.observationId,
      scope.leagueId,
      scope.seasonId,
      ids.observationSnapshotId,
      nhlGameId,
      nhlGameScheduledStartsAtMs,
      lateSnapshotAtMs,
      lateSnapshotAtMs
    );
    database.prepare(
      "INSERT INTO nhl_game_state_observation_snapshots " +
        "(id, league_id, season_id, matchup_week_id, team_id, provider, " +
        "source_version, observed_at_ms, freshness_status, " +
        "observation_count, evidence_schema_version, observation_sha256, " +
        "created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fresh', 1, 1, ?, ?, 1)"
    ).run(
      ids.observationSnapshotId,
      scope.leagueId,
      scope.seasonId,
      scope.weekId,
      scope.teamId,
      sourceProvider,
      sourceVersion,
      lateSnapshotAtMs,
      "c".repeat(64),
      lateSnapshotAtMs
    );
    database.prepare(
      "INSERT INTO matchup_roster_game_exclusions " +
        "(id, league_id, season_id, exclusion_set_id, matchup_week_id, " +
        "matchup_id, team_id, matchup_roster_lock_id, " +
        "matchup_roster_player_id, player_id, observation_snapshot_id, " +
        "observation_id, baseline_player_game_stat_observation_id, " +
        "nhl_game_id, nhl_game_scheduled_starts_at_ms, " +
        "observed_game_state, late_snapshot_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
        "'final', ?, ?, 1)"
    ).run(
      ids.exclusionId,
      scope.leagueId,
      scope.seasonId,
      ids.exclusionSetId,
      scope.weekId,
      ids.matchupId,
      scope.teamId,
      ids.lockId,
      ids.lockedPlayerId,
      uuid(playerValue),
      ids.observationSnapshotId,
      ids.observationId,
      ids.baselineObservationId,
      nhlGameId,
      nhlGameScheduledStartsAtMs,
      lateSnapshotAtMs,
      lateSnapshotAtMs
    );
    database.prepare(
      "INSERT INTO matchup_roster_game_exclusion_sets " +
        "(id, league_id, season_id, matchup_week_id, matchup_id, team_id, " +
        "matchup_roster_lock_id, matchup_roster_lock_version, " +
        "baseline_snapshot_id, observation_snapshot_id, late_snapshot_at_ms, " +
        "exclusion_count, evidence_schema_version, evidence_sha256, " +
        "sealed_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 1, ?, ?, ?, 1)"
    ).run(
      ids.exclusionSetId,
      scope.leagueId,
      scope.seasonId,
      scope.weekId,
      ids.matchupId,
      scope.teamId,
      ids.lockId,
      ids.baselineSnapshotId,
      ids.observationSnapshotId,
      lateSnapshotAtMs,
      "d".repeat(64),
      lateSnapshotAtMs,
      lateSnapshotAtMs
    );
  })();

  return Object.freeze({
    ...ids,
    playerId: uuid(playerValue),
    providerPlayerId: identity.providerPlayerId,
    providerTeamId,
    nhlGameId,
    nhlGameScheduledStartsAtMs,
  });
}

function terminalCoverage(requiredPlayers) {
  return requiredPlayers.map((player) => ({
    playerId: player.playerId,
    providerPlayerId: player.providerPlayerId,
    providerTeamId: null,
    disposition: "no_team",
    nhlGameId: null,
    nhlGameScheduledStartsAtMs: null,
    observedGameState: null,
  }));
}

function coverageForRequirements(snapshot) {
  const gamesByPlayerId = new Map();
  for (const game of snapshot.requiredPlayerGames) {
    const games = gamesByPlayerId.get(game.playerId) ?? [];
    games.push(game);
    gamesByPlayerId.set(game.playerId, games);
  }
  return snapshot.requiredPlayers.flatMap((player) => {
    const games = gamesByPlayerId.get(player.playerId) ?? [];
    if (games.length === 0) {
      return terminalCoverage([player]);
    }
    return games.map((game) => ({
      playerId: game.playerId,
      providerPlayerId: game.providerPlayerId,
      providerTeamId: game.providerTeamId,
      disposition: "expected_game",
      nhlGameId: game.nhlGameId,
      nhlGameScheduledStartsAtMs:
        game.nhlGameScheduledStartsAtMs,
      observedGameState: "final",
    }));
  });
}

function playerGameRowsForRequirements(
  snapshot,
  capturedAtMs = NOW_MS + 100
) {
  if (snapshot.requiredPlayerGames.length === 0) return [];
  return normalizePlayerGameStatisticsRows({
    rows: snapshot.requiredPlayerGames.map((game) => ({
      playerId: game.providerPlayerId,
      nhlGameId: game.nhlGameId,
      nhlGameScheduledStartsAtMs:
        game.nhlGameScheduledStartsAtMs,
      observedGameState: "final",
      goals: 0,
      assists: 0,
      sourceUpdatedAtMs: NOW_MS,
    })),
    capturedAtMs,
    minimumObservationCount:
      snapshot.requiredPlayerGames.length,
  });
}

function assertRefreshHasNoPartialWrites(
  database,
  refreshId,
  label
) {
  assert.deepEqual(
    database.prepare(
      "SELECT status, source_version FROM stat_refreshes WHERE id = ?"
    ).get(refreshId),
    { status: "started", source_version: null }
  );
  for (const table of [
    "player_stat_totals",
    "stat_refresh_player_game_coverage_entries",
    "player_game_stat_observations",
    "stat_refresh_player_game_sets",
  ]) {
    assert.equal(
      database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE refresh_id = ?`
      ).get(refreshId).count,
      0,
      `${label} left partial rows in ${table}`
    );
  }
}

function normalizedTotal(externalPlayerId) {
  return normalizeStatisticsRows({
    rows: [{
      playerId: externalPlayerId,
      gamesPlayed: 1,
      goals: 0,
      assists: 0,
    }],
    minimumPlayerCount: 1,
    sourceUpdatedAtMs: NOW_MS,
  });
}

function startLiveRefresh(runtime, { base, nhlSeasonKey }) {
  const source = runtime.repository.ensureSource({
    id: uuid(base),
    provider: "nhl",
    nowMs: NOW_MS,
  });
  const refresh = runtime.repository.startRefresh({
    id: uuid(base + 1),
    statSourceId: source.id,
    nhlSeasonKey,
    startedAtMs: NOW_MS,
  });
  return { source, refresh };
}

function completeTerminalLiveRefresh(
  runtime,
  { base, nhlSeasonKey, snapshot, totalExternalPlayerId }
) {
  const { source, refresh } = startLiveRefresh(runtime, {
    base,
    nhlSeasonKey,
  });
  return runtime.repository.completeLiveRefresh({
    refreshId: refresh.id,
    statSourceId: source.id,
    provider: "nhl",
    playerIdentityProvider: "nhl",
    nhlSeasonKey,
    sourceVersion: `coverage-${base}`,
    completedAtMs: NOW_MS + 100,
    rows: normalizedTotal(totalExternalPlayerId),
    playerGameRows: [],
    requiredPlayers: snapshot.requiredPlayers,
    requiredPlayerGames: snapshot.requiredPlayerGames,
    requirementsSha256: snapshot.requirementsSha256,
    playerGameCoverage: terminalCoverage(
      snapshot.requiredPlayers
    ),
  });
}

function service(repository, provider, options = {}) {
  return createTargetStatisticsService({
    repository,
    provider,
    nhlSeasonKey: "20262027",
    minimumPlayerCount: 2,
    createId: options.createId || idFactory(300),
    nowMs: options.nowMs || clock(),
  });
}

const validRows = Object.freeze([
  Object.freeze({ playerId: 8478402, gamesPlayed: 3, goals: 2, assists: 1 }),
  Object.freeze({ playerId: 8478403, gamesPlayed: 4, goals: 0, assists: 4 }),
]);

describe("M6-01 SQLite target statistics refresh", () => {
  test("atomically seals live totals and mapped player-game evidence", (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    insertPlayer(runtime.players, 2, "8478403");
    seedCoverageScope(runtime.database, {
      base: 10_000,
      weekStatus: "live",
      ownerships: [
        { playerValue: 2 },
        { playerValue: 1 },
      ],
    });
    const requirements =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "nhl",
      });
    const source = runtime.repository.ensureSource({
      id: uuid(500),
      provider: "nhl",
      nowMs: NOW_MS,
    });
    const refresh = runtime.repository.startRefresh({
      id: uuid(501),
      statSourceId: source.id,
      nhlSeasonKey: "20262027",
      startedAtMs: NOW_MS,
    });
    const completedAtMs = NOW_MS + 100;
    const rows = normalizeStatisticsRows({
      rows: validRows,
      minimumPlayerCount: 2,
      sourceUpdatedAtMs: NOW_MS,
    });
    const playerGameRows = normalizePlayerGameStatisticsRows({
      rows: [
        {
          playerId: "8478403",
          nhlGameId: "2026020002",
          nhlGameScheduledStartsAtMs: NOW_MS + 10_000,
          observedGameState: "in_progress",
          goals: 1,
          assists: 2,
          sourceUpdatedAtMs: NOW_MS + 50,
        },
        {
          playerId: "8478402",
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: NOW_MS + 20_000,
          observedGameState: "scheduled",
          goals: 0,
          assists: 0,
          sourceUpdatedAtMs: NOW_MS + 50,
        },
      ],
      capturedAtMs: completedAtMs,
      minimumObservationCount: 2,
    });
    const normalizedCoverage =
      normalizePlayerGameCoverageResponse({
        requiredPlayers: requirements.requiredPlayers,
        requiredPlayerGames:
          requirements.requiredPlayerGames,
        response: {
          schemaVersion: 1,
          throughAtMs: completedAtMs,
          players: [
            {
              playerId: uuid(2),
              providerPlayerId: "8478403",
              providerTeamId: "VAN",
              disposition: "expected_game",
              games: [{
                providerTeamId: "VAN",
                nhlGameId: "2026020002",
                nhlGameScheduledStartsAtMs: NOW_MS + 10_000,
                observedGameState: "in_progress",
              }],
            },
            {
              playerId: uuid(1),
              providerPlayerId: "8478402",
              providerTeamId: "EDM",
              disposition: "expected_game",
              games: [{
                providerTeamId: "EDM",
                nhlGameId: "2026020001",
                nhlGameScheduledStartsAtMs: NOW_MS + 20_000,
                observedGameState: "scheduled",
              }],
            },
          ],
        },
        observationRows: playerGameRows,
        capturedAtMs: completedAtMs,
      });

    const result = runtime.repository.completeLiveRefresh({
      refreshId: refresh.id,
      statSourceId: source.id,
      provider: "nhl",
      playerIdentityProvider: "nhl",
      nhlSeasonKey: "20262027",
      sourceVersion: "nhl-live-2026-10-12T08:00:00.100Z",
      completedAtMs,
      rows,
      playerGameRows,
      requiredPlayers: requirements.requiredPlayers,
      requiredPlayerGames: requirements.requiredPlayerGames,
      requirementsSha256: requirements.requirementsSha256,
      playerGameCoverage: normalizedCoverage.coverage,
    });

    assert.equal(result.refresh.status, "succeeded");
    assert.equal(result.playerGameSet.observation_count, 2);
    assert.equal(result.playerGameSet.required_player_count, 2);
    assert.equal(result.playerGameSet.coverage_entry_count, 2);
    assert.equal(result.playerGameSet.expected_player_game_count, 2);
    assert.deepEqual(result.requiredPlayers, requirements.requiredPlayers);
    assert.equal(
      result.requirementsSha256,
      requirements.requirementsSha256
    );
    assert.deepEqual(
      {
        requiredPlayerCount: result.requiredPlayerCount,
        coverageEntryCount: result.coverageEntryCount,
        expectedPlayerGameCount: result.expectedPlayerGameCount,
        observationCount: result.observationCount,
        coverageSha256: result.coverageSha256,
        evidenceSha256: result.evidenceSha256,
      },
      {
        requiredPlayerCount: 2,
        coverageEntryCount: 2,
        expectedPlayerGameCount: 2,
        observationCount: 2,
        coverageSha256: result.playerGameSet.coverage_sha256,
        evidenceSha256: result.playerGameSet.evidence_sha256,
      }
    );
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.requiredPlayers), true);
    assert.equal(Object.isFrozen(result.requiredPlayers[0]), true);
    assert.equal(Object.isFrozen(result.requiredPlayerGames), true);
    const coverage = runtime.database.prepare(
      "SELECT id AS coverageEntryId, player_id AS playerId, " +
        "provider_player_id AS providerPlayerId, " +
        "provider_team_id AS providerTeamId, disposition, " +
        "nhl_game_id AS nhlGameId, " +
        "nhl_game_scheduled_starts_at_ms AS nhlGameScheduledStartsAtMs " +
        "FROM stat_refresh_player_game_coverage_entries " +
        "WHERE refresh_id = ? ORDER BY player_id, disposition, nhl_game_id, id"
    ).all(refresh.id);
    const recalculatedCoverage =
      createPlayerGameCoverageSetEvidence({
        setId: result.playerGameSet.id,
        statSourceId: source.id,
        refreshId: refresh.id,
        nhlSeasonKey: "20262027",
        provider: "nhl",
        sourceVersion:
          "nhl-live-2026-10-12T08:00:00.100Z",
        capturedAtMs: completedAtMs,
        requiredPlayers: requirements.requiredPlayers,
        coverage,
      });
    assert.equal(
      result.playerGameSet.coverage_sha256,
      recalculatedCoverage.coverageSha256
    );
    const observations = runtime.database.prepare(
      "SELECT id AS observationId, player_id AS playerId, " +
        "nhl_game_id AS nhlGameId, " +
        "nhl_game_scheduled_starts_at_ms AS nhlGameScheduledStartsAtMs, " +
        "observed_game_state AS observedGameState, goals, assists, " +
        "nhl_points AS nhlPoints, " +
        "fantasy_points_hundredths AS fantasyPointsHundredths, " +
        "source_updated_at_ms AS sourceUpdatedAtMs " +
        "FROM player_game_stat_observations WHERE refresh_id = ? " +
        "ORDER BY player_id, nhl_game_id, id"
    ).all(refresh.id);
    const recalculated = createPlayerGameObservationSetEvidence({
      setId: result.playerGameSet.id,
      statSourceId: source.id,
      refreshId: refresh.id,
      nhlSeasonKey: "20262027",
      provider: "nhl",
      sourceVersion: "nhl-live-2026-10-12T08:00:00.100Z",
      capturedAtMs: completedAtMs,
      observations,
    });
    assert.equal(
      result.playerGameSet.evidence_sha256,
      recalculated.evidenceSha256
    );
    assert.deepEqual(
      observations.map((row) => ({
        playerId: row.playerId,
        nhlGameId: row.nhlGameId,
        fantasyPointsHundredths: row.fantasyPointsHundredths,
      })),
      [
        {
          playerId: uuid(1),
          nhlGameId: "2026020001",
          fantasyPointsHundredths: 0,
        },
        {
          playerId: uuid(2),
          nhlGameId: "2026020002",
          fantasyPointsHundredths: 325,
        },
      ]
    );
    assert.equal(
      runtime.database.pragma("foreign_key_check").length,
      0
    );
  });

  test("requires the explicitly requested provider mapping", (t) => {
    const runtime = createRuntime(t);
    insertBarePlayer(runtime.database, 20);
    seedCoverageScope(runtime.database, {
      base: 10_100,
      weekStatus: "awaiting_data",
      ownerships: [{ playerValue: 20 }],
    });

    assert.throws(
      () =>
        runtime.repository.readPlayerGameCoverageRequirements({
          nhlSeasonKey: "20262027",
          playerIdentityProvider: "nhl",
        }),
      { code: "REPOSITORY_RECORD_NOT_FOUND" }
    );

    insertProviderIdentity(runtime.database, {
      idValue: 20_020,
      playerValue: 20,
      provider: "alternate",
      externalValue: "alternate-20",
    });
    const alternate =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "alternate",
      });
    assert.deepEqual(alternate.requiredPlayers, [{
      playerId: uuid(20),
      providerPlayerId: "alternate-20",
    }]);
    assert.deepEqual(Object.keys(alternate), [
      "schemaVersion",
      "nhlSeasonKey",
      "playerIdentityProvider",
      "requiredPlayers",
      "requiredPlayerGames",
      "requirementsSha256",
    ]);
    assert.equal(Object.isFrozen(alternate), true);

    insertProviderIdentity(runtime.database, {
      idValue: 20_021,
      playerValue: 20,
      provider: "nhl",
      externalValue: "nhl-20",
    });
    const nhl =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "nhl",
      });
    assert.deepEqual(nhl.requiredPlayers, [{
      playerId: uuid(20),
      providerPlayerId: "nhl-20",
    }]);
    assert.notEqual(
      nhl.requirementsSha256,
      alternate.requirementsSha256
    );
  });

  test("selects the exact season-scoped coverage union and audits parents", (t) => {
    const runtime = createRuntime(t);
    for (let value = 30; value <= 44; value += 1) {
      insertPlayer(
        runtime.players,
        value,
        String(9_000_000 + value)
      );
    }
    const live = seedCoverageScope(runtime.database, {
      base: 11_000,
      weekStatus: "live",
      ownerships: [
        { playerValue: 30 },
        { playerValue: 31, rosterCategory: "Bench" },
        {
          playerValue: 32,
          rosterCategory: "Injured Reserve",
        },
        {
          playerValue: 33,
          ownershipKind: "Prospect Right",
          rosterCategory: "Prospect",
        },
      ],
    });
    seedCoverageScope(runtime.database, {
      base: 11_100,
      weekStatus: "awaiting_data",
      ownerships: [{ playerValue: 34 }],
    });
    const excludedStatuses = [
      "scheduled",
      "baseline_ready",
      "final",
      "correction_required",
      "cancelled",
    ];
    const historical = excludedStatuses.map((weekStatus, index) =>
      seedCoverageScope(runtime.database, {
        base: 11_200 + index * 100,
        weekStatus,
        ownerships: [{ playerValue: 35 + index }],
      })
    );
    insertLockedPlayers(runtime.database, historical[2], {
      base: 12_000,
      playerValues: [40, 30],
    });
    insertSyntheticExclusion(runtime.database, historical[2], {
      base: 12_100,
      playerValue: 42,
    });

    const orphanLockId = uuid(12_200);
    runtime.database.pragma("foreign_keys = OFF");
    try {
      runtime.database.prepare(
        "INSERT INTO matchup_roster_players " +
          "(id, league_id, season_id, matchup_roster_lock_id, player_id, " +
          "position_group, slot_number, baseline_games_played, " +
          "baseline_goals, baseline_assists, " +
          "baseline_fantasy_points_hundredths, created_at_ms) " +
          "VALUES (?, ?, ?, ?, ?, 'F', 1, 0, 0, 0, 0, 102)"
      ).run(
        uuid(12_201),
        live.leagueId,
        live.seasonId,
        orphanLockId,
        uuid(41)
      );
    } finally {
      runtime.database.pragma("foreign_keys = ON");
    }

    insertSyntheticExclusion(runtime.database, historical[2], {
      base: 12_300,
      playerValue: 44,
    });
    runtime.database.pragma("foreign_keys = OFF");
    try {
      runtime.database.prepare(
        "DELETE FROM matchup_roster_game_exclusion_sets WHERE id = ?"
      ).run(uuid(12_301));
    } finally {
      runtime.database.pragma("foreign_keys = ON");
    }

    seedCoverageScope(runtime.database, {
      base: 12_400,
      nhlSeasonKey: "20272028",
      weekStatus: "live",
      ownerships: [{ playerValue: 43 }],
    });

    const before = runtime.database.serialize();
    const first =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "nhl",
      });
    const second =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "nhl",
      });
    assert.deepEqual(first, second);
    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.deepEqual(
      first.requiredPlayers.map((player) => player.playerId),
      [uuid(30), uuid(34), uuid(40), uuid(42)]
    );
    assert.deepEqual(
      first.requiredPlayers.map(
        (player) => player.providerPlayerId
      ),
      [
        "9000030",
        "9000034",
        "9000040",
        "9000042",
      ]
    );
  });

  test("derives ordered deduplicated historical games from exact scoped evidence and week status", (t) => {
    const runtime = createRuntime(t);
    for (let value = 2_000; value <= 2_006; value += 1) {
      insertPlayer(
        runtime.players,
        value,
        String(7_000_000 + value)
      );
    }
    const included = [
      {
        scopeBase: 30_000,
        evidenceBase: 40_000,
        weekStatus: "live",
        playerValue: 2_002,
        providerTeamId: "VAN",
        nhlGameId: "game-z",
        startsAtMs: 113,
      },
      {
        scopeBase: 30_100,
        evidenceBase: 40_100,
        weekStatus: "awaiting_data",
        playerValue: 2_000,
        providerTeamId: "EDM",
        nhlGameId: "game-b",
        startsAtMs: 112,
      },
      {
        scopeBase: 30_200,
        evidenceBase: 40_200,
        weekStatus: "correction_required",
        playerValue: 2_000,
        providerTeamId: "CGY",
        nhlGameId: "game-a",
        startsAtMs: 111,
      },
      {
        scopeBase: 30_300,
        evidenceBase: 40_300,
        weekStatus: "live",
        playerValue: 2_000,
        providerTeamId: "CGY",
        nhlGameId: "game-a",
        startsAtMs: 111,
      },
    ];
    for (const candidate of included) {
      const scope = seedCoverageScope(runtime.database, {
        base: candidate.scopeBase,
        nhlSeasonKey: "20502051",
        weekStatus: candidate.weekStatus,
      });
      insertHistoricalExclusionEvidence(
        runtime.database,
        scope,
        {
          base: candidate.evidenceBase,
          playerValue: candidate.playerValue,
          providerTeamId: candidate.providerTeamId,
          nhlGameId: candidate.nhlGameId,
          nhlGameScheduledStartsAtMs:
            candidate.startsAtMs,
        }
      );
    }
    for (const [index, weekStatus] of [
      "scheduled",
      "final",
      "cancelled",
    ].entries()) {
      const scope = seedCoverageScope(runtime.database, {
        base: 30_400 + index * 100,
        nhlSeasonKey: "20502051",
        weekStatus,
      });
      insertHistoricalExclusionEvidence(
        runtime.database,
        scope,
        {
          base: 40_400 + index * 100,
          playerValue: 2_003 + index,
          providerTeamId: `EXCLUDED-${index}`,
          nhlGameId: `excluded-${weekStatus}`,
        }
      );
    }
    const adjacentScope = seedCoverageScope(runtime.database, {
      base: 30_700,
      nhlSeasonKey: "20512052",
      weekStatus: "live",
    });
    insertHistoricalExclusionEvidence(
      runtime.database,
      adjacentScope,
      {
        base: 40_700,
        playerValue: 2_006,
        providerTeamId: "ADJACENT",
        nhlGameId: "adjacent-season-game",
      }
    );

    const before = runtime.database.serialize();
    const requirements =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20502051",
        playerIdentityProvider: "nhl",
      });

    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.deepEqual(requirements.requiredPlayerGames, [
      {
        playerId: uuid(2_000),
        providerPlayerId: "7002000",
        providerTeamId: "CGY",
        nhlGameId: "game-a",
        nhlGameScheduledStartsAtMs: 111,
      },
      {
        playerId: uuid(2_000),
        providerPlayerId: "7002000",
        providerTeamId: "EDM",
        nhlGameId: "game-b",
        nhlGameScheduledStartsAtMs: 112,
      },
      {
        playerId: uuid(2_002),
        providerPlayerId: "7002002",
        providerTeamId: "VAN",
        nhlGameId: "game-z",
        nhlGameScheduledStartsAtMs: 113,
      },
    ]);
    assert.equal(
      Object.isFrozen(requirements.requiredPlayerGames),
      true
    );
    assert.equal(
      Object.isFrozen(requirements.requiredPlayerGames[0]),
      true
    );
  });

  test("retains the sealed historical team binding when current ownership changes", (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 2_100, "7002100");
    const scope = seedCoverageScope(runtime.database, {
      base: 31_000,
      nhlSeasonKey: "20522053",
      weekStatus: "live",
      ownerships: [{ playerValue: 2_100 }],
    });
    insertHistoricalExclusionEvidence(
      runtime.database,
      scope,
      {
        base: 41_000,
        playerValue: 2_100,
        providerTeamId: "OLD-TEAM",
        nhlGameId: "old-team-game",
      }
    );
    const before =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20522053",
        playerIdentityProvider: "nhl",
      });
    const newTeamId = uuid(31_050);
    runtime.database.prepare(
      "INSERT INTO teams " +
        "(id, league_id, name, name_normalized, status, created_at_ms, " +
        "updated_at_ms, version) VALUES (?, ?, 'New Team', " +
        "'new team', 'active', 1, 1, 1)"
    ).run(newTeamId, scope.leagueId);
    runtime.database.prepare(
      "UPDATE player_ownerships SET team_id = ?, version = version + 1 " +
        "WHERE league_id = ? AND season_id = ? AND player_id = ?"
    ).run(
      newTeamId,
      scope.leagueId,
      scope.seasonId,
      uuid(2_100)
    );

    const after =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20522053",
        playerIdentityProvider: "nhl",
      });
    assert.deepEqual(after, before);
    assert.equal(
      after.requiredPlayerGames[0].providerTeamId,
      "OLD-TEAM"
    );
  });

  test("fails closed when sealed historical coverage or its current identity mapping is unavailable", async (t) => {
    await t.test("missing sealed coverage", (nested) => {
      const runtime = createRuntime(nested);
      insertPlayer(runtime.players, 2_200, "7002200");
      const scope = seedCoverageScope(runtime.database, {
        base: 32_000,
        nhlSeasonKey: "20532054",
        weekStatus: "live",
      });
      const evidence = insertHistoricalExclusionEvidence(
        runtime.database,
        scope,
        {
          base: 42_000,
          playerValue: 2_200,
          providerTeamId: "SEA",
        }
      );
      runtime.database.exec(
        "DROP TRIGGER IF EXISTS " +
          "stat_refresh_player_game_coverage_immutable_delete"
      );
      runtime.database.prepare(
        "DELETE FROM stat_refresh_player_game_coverage_entries " +
          "WHERE id = ?"
      ).run(evidence.coverageEntryId);

      assert.throws(
        () =>
          runtime.repository.readPlayerGameCoverageRequirements({
            nhlSeasonKey: "20532054",
            playerIdentityProvider: "nhl",
          }),
        { code: "REPOSITORY_RECORD_NOT_FOUND" }
      );
    });

    await t.test("mismatched current identity", (nested) => {
      const runtime = createRuntime(nested);
      insertPlayer(runtime.players, 2_201, "7002201");
      const scope = seedCoverageScope(runtime.database, {
        base: 32_100,
        nhlSeasonKey: "20542055",
        weekStatus: "live",
      });
      insertHistoricalExclusionEvidence(
        runtime.database,
        scope,
        {
          base: 42_100,
          playerValue: 2_201,
          providerTeamId: "SEA",
        }
      );
      runtime.database.prepare(
        "UPDATE player_external_ids SET external_value = 'changed-2201' " +
          "WHERE player_id = ? AND provider = 'nhl'"
      ).run(uuid(2_201));

      assert.throws(
        () =>
          runtime.repository.readPlayerGameCoverageRequirements({
            nhlSeasonKey: "20542055",
            playerIdentityProvider: "nhl",
          }),
        { code: "REPOSITORY_RECORD_NOT_FOUND" }
      );
    });
  });

  test("returns a deterministic deeply frozen empty requirement set", (t) => {
    const runtime = createRuntime(t);
    const first =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "nhl",
      });
    const second =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "nhl",
      });
    assert.deepEqual(first, second);
    assert.deepEqual(first.requiredPlayers, []);
    assert.deepEqual(first.requiredPlayerGames, []);
    assert.match(first.requirementsSha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.requiredPlayers), true);

    insertPlayer(runtime.players, 45, "9000045");
    const result = completeTerminalLiveRefresh(runtime, {
      base: 12_500,
      nhlSeasonKey: "20262027",
      snapshot: first,
      totalExternalPlayerId: "9000045",
    });
    assert.deepEqual(
      {
        requiredPlayerCount:
          result.playerGameSet.required_player_count,
        coverageEntryCount:
          result.playerGameSet.coverage_entry_count,
        expectedPlayerGameCount:
          result.playerGameSet.expected_player_game_count,
        observationCount:
          result.playerGameSet.observation_count,
      },
      {
        requiredPlayerCount: 0,
        coverageEntryCount: 0,
        expectedPlayerGameCount: 0,
        observationCount: 0,
      }
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM " +
          "stat_refresh_player_game_coverage_entries"
      ).get().count,
      0
    );
  });

  test("requires and persists every exact historical binding at live completion", (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 2_300, "7002300");
    const scope = seedCoverageScope(runtime.database, {
      base: 33_000,
      nhlSeasonKey: "20552056",
      weekStatus: "live",
    });
    insertHistoricalExclusionEvidence(
      runtime.database,
      scope,
      {
        base: 43_000,
        playerValue: 2_300,
        providerTeamId: "SEA-SEALED",
        nhlGameId: "required-history-game",
      }
    );
    const snapshot =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20552056",
        playerIdentityProvider: "nhl",
      });
    const { source, refresh } = startLiveRefresh(runtime, {
      base: 43_100,
      nhlSeasonKey: "20552056",
    });
    const command = {
      refreshId: refresh.id,
      statSourceId: source.id,
      provider: "nhl",
      playerIdentityProvider: "nhl",
      nhlSeasonKey: "20552056",
      sourceVersion: "historical-completion",
      completedAtMs: NOW_MS + 100,
      rows: normalizedTotal("7002300"),
      playerGameRows: [],
      requiredPlayers: snapshot.requiredPlayers,
      requiredPlayerGames: snapshot.requiredPlayerGames,
      requirementsSha256: snapshot.requirementsSha256,
      playerGameCoverage: terminalCoverage(
        snapshot.requiredPlayers
      ),
    };

    assert.throws(
      () => runtime.repository.completeLiveRefresh(command),
      { code: "REPOSITORY_ARGUMENT_INVALID" }
    );
    assertRefreshHasNoPartialWrites(
      runtime.database,
      refresh.id,
      "missing historical binding"
    );

    const result = runtime.repository.completeLiveRefresh({
      ...command,
      playerGameRows:
        playerGameRowsForRequirements(snapshot),
      playerGameCoverage: coverageForRequirements(snapshot),
    });
    assert.equal(result.refresh.status, "succeeded");
    assert.deepEqual(
      result.requiredPlayerGames,
      snapshot.requiredPlayerGames
    );
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT provider_player_id AS providerPlayerId, " +
          "provider_team_id AS providerTeamId, " +
          "nhl_game_id AS nhlGameId FROM " +
          "stat_refresh_player_game_coverage_entries " +
          "WHERE refresh_id = ?"
      ).get(refresh.id),
      {
        providerPlayerId: "7002300",
        providerTeamId: "SEA-SEALED",
        nhlGameId: "required-history-game",
      }
    );
  });

  test("CAS rejects every relevant requirement mutation without partial writes", async (t) => {
    const runtime = createRuntime(t);
    const cases = [
      "add_active",
      "remove_active",
      "add_locked",
      "remove_locked",
      "add_exclusion",
      "remove_exclusion",
      "update_mapping",
      "delete_mapping",
    ];

    for (const [index, mutation] of cases.entries()) {
      await t.test(mutation, () => {
        const playerOne = 1_000 + index * 2;
        const playerTwo = playerOne + 1;
        const externalOne = String(8_000_000 + playerOne);
        const externalTwo = String(8_000_000 + playerTwo);
        insertPlayer(runtime.players, playerOne, externalOne);
        insertPlayer(runtime.players, playerTwo, externalTwo);
        const startYear = 2030 + index;
        const nhlSeasonKey =
          `${startYear}${startYear + 1}`;
        const base = 20_000 + index * 500;
        const ownerships = [{ playerValue: playerOne }];
        if (mutation === "remove_active") {
          ownerships.push({ playerValue: playerTwo });
        }
        const scope = seedCoverageScope(runtime.database, {
          base,
          nhlSeasonKey,
          weekStatus: "live",
          ownerships,
        });
        let removableExclusion = null;
        if (mutation === "remove_locked") {
          insertLockedPlayers(runtime.database, scope, {
            base: base + 300,
            playerValues: [playerTwo],
          });
        }
        if (mutation === "remove_exclusion") {
          removableExclusion =
            insertHistoricalExclusionEvidence(
              runtime.database,
              scope,
              {
            base: base + 350,
            playerValue: playerTwo,
                providerTeamId: "SEA",
              }
            );
        }

        const { source, refresh } = startLiveRefresh(runtime, {
          base: base + 400,
          nhlSeasonKey,
        });
        const snapshot =
          runtime.repository.readPlayerGameCoverageRequirements({
            nhlSeasonKey,
            playerIdentityProvider: "nhl",
          });

        if (mutation === "add_active") {
          insertCoverageOwnership(runtime.database, scope, {
            idValue: base + 450,
            playerValue: playerTwo,
          });
        } else if (mutation === "remove_active") {
          runtime.database.prepare(
            "DELETE FROM player_ownerships " +
              "WHERE league_id = ? AND player_id = ?"
          ).run(scope.leagueId, uuid(playerTwo));
        } else if (mutation === "add_locked") {
          insertLockedPlayers(runtime.database, scope, {
            base: base + 300,
            playerValues: [playerTwo],
          });
        } else if (mutation === "remove_locked") {
          runtime.database.prepare(
            "DELETE FROM matchup_roster_players WHERE id = ?"
          ).run(uuid(base + 301));
        } else if (mutation === "add_exclusion") {
          insertSyntheticExclusion(runtime.database, scope, {
            base: base + 350,
            playerValue: playerTwo,
          });
        } else if (mutation === "remove_exclusion") {
          runtime.database.exec(
            "DROP TRIGGER IF EXISTS " +
              "matchup_roster_game_exclusions_immutable_delete"
          );
          runtime.database.prepare(
            "DELETE FROM matchup_roster_game_exclusions WHERE id = ?"
          ).run(removableExclusion.exclusionId);
        } else if (mutation === "update_mapping") {
          runtime.database.prepare(
            "UPDATE player_external_ids SET external_value = ? " +
              "WHERE player_id = ? AND provider = 'nhl'"
          ).run(String(8_500_000 + playerOne), uuid(playerOne));
        } else if (mutation === "delete_mapping") {
          runtime.database.prepare(
            "DELETE FROM player_external_ids " +
              "WHERE player_id = ? AND provider = 'nhl'"
          ).run(uuid(playerOne));
        }

        assert.throws(
          () => runtime.repository.completeLiveRefresh({
            refreshId: refresh.id,
            statSourceId: source.id,
            provider: "nhl",
            playerIdentityProvider: "nhl",
            nhlSeasonKey,
            sourceVersion: `cas-${mutation}`,
            completedAtMs: NOW_MS + 100,
            rows: normalizedTotal(
              snapshot.requiredPlayers[0].providerPlayerId
            ),
            playerGameRows: [],
            requiredPlayers: snapshot.requiredPlayers,
            requiredPlayerGames:
              snapshot.requiredPlayerGames,
            requirementsSha256:
              snapshot.requirementsSha256,
            playerGameCoverage: terminalCoverage(
              snapshot.requiredPlayers
            ),
          }),
          { code: "PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED" }
        );
        assert.deepEqual(
          runtime.database.prepare(
            "SELECT status, source_version FROM stat_refreshes " +
              "WHERE id = ?"
          ).get(refresh.id),
          { status: "started", source_version: null }
        );
        for (const table of [
          "player_stat_totals",
          "stat_refresh_player_game_coverage_entries",
          "player_game_stat_observations",
          "stat_refresh_player_game_sets",
        ]) {
          assert.equal(
            runtime.database.prepare(
              `SELECT COUNT(*) AS count FROM ${table} ` +
                "WHERE refresh_id = ?"
            ).get(refresh.id).count,
            0,
            `${mutation} left partial rows in ${table}`
          );
        }
      });
    }
  });

  test("historical game CAS rejects exclusion, status, binding, and mapping races", async (t) => {
    const runtime = createRuntime(t);
    const cases = [
      "add_exclusion",
      "remove_exclusion",
      "status_enters",
      "status_leaves",
      "binding_mutation",
      "mapping_mutation",
    ];

    for (const [index, mutation] of cases.entries()) {
      await t.test(mutation, () => {
        const playerValue = 2_400 + index;
        const providerPlayerId = String(7_002_400 + index);
        insertPlayer(
          runtime.players,
          playerValue,
          providerPlayerId
        );
        const startYear = 2060 + index;
        const nhlSeasonKey = `${startYear}${startYear + 1}`;
        const scopeBase = 34_000 + index * 100;
        const evidenceBase = 50_000 + index * 100;
        const initialStatus =
          mutation === "status_enters" ? "final" : "live";
        const scope = seedCoverageScope(runtime.database, {
          base: scopeBase,
          nhlSeasonKey,
          weekStatus: initialStatus,
          ownerships: [{ playerValue }],
        });
        let evidence = null;
        if (mutation !== "add_exclusion") {
          evidence = insertHistoricalExclusionEvidence(
            runtime.database,
            scope,
            {
              base: evidenceBase,
              playerValue,
              providerTeamId: "SEA-SEALED",
              nhlGameId: `cas-game-${index}`,
            }
          );
        }
        const snapshot =
          runtime.repository.readPlayerGameCoverageRequirements({
            nhlSeasonKey,
            playerIdentityProvider: "nhl",
          });
        const { source, refresh } = startLiveRefresh(runtime, {
          base: 60_000 + index * 100,
          nhlSeasonKey,
        });

        if (mutation === "add_exclusion") {
          insertHistoricalExclusionEvidence(
            runtime.database,
            scope,
            {
              base: evidenceBase,
              playerValue,
              providerTeamId: "SEA-SEALED",
              nhlGameId: `cas-game-${index}`,
            }
          );
        } else if (mutation === "remove_exclusion") {
          runtime.database.exec(
            "DROP TRIGGER IF EXISTS " +
              "matchup_roster_game_exclusions_immutable_delete"
          );
          runtime.database.prepare(
            "DELETE FROM matchup_roster_game_exclusions WHERE id = ?"
          ).run(evidence.exclusionId);
        } else if (mutation === "status_enters") {
          runtime.database.prepare(
            "UPDATE matchup_weeks SET status = 'correction_required', " +
              "updated_at_ms = updated_at_ms + 1, version = version + 1 " +
              "WHERE league_id = ? AND season_id = ? AND id = ?"
          ).run(scope.leagueId, scope.seasonId, scope.weekId);
        } else if (mutation === "status_leaves") {
          runtime.database.prepare(
            "UPDATE matchup_weeks SET status = 'final', " +
              "updated_at_ms = updated_at_ms + 1, version = version + 1 " +
              "WHERE league_id = ? AND season_id = ? AND id = ?"
          ).run(scope.leagueId, scope.seasonId, scope.weekId);
        } else if (mutation === "binding_mutation") {
          runtime.database.exec(
            "DROP TRIGGER IF EXISTS " +
              "stat_refresh_player_game_coverage_immutable_update"
          );
          runtime.database.prepare(
            "UPDATE stat_refresh_player_game_coverage_entries " +
              "SET provider_team_id = 'CHANGED-TEAM' WHERE id = ?"
          ).run(evidence.coverageEntryId);
        } else if (mutation === "mapping_mutation") {
          runtime.database.prepare(
            "UPDATE player_external_ids SET external_value = ? " +
              "WHERE player_id = ? AND provider = 'nhl'"
          ).run(
            `changed-${providerPlayerId}`,
            uuid(playerValue)
          );
        }

        assert.throws(
          () =>
            runtime.repository.completeLiveRefresh({
              refreshId: refresh.id,
              statSourceId: source.id,
              provider: "nhl",
              playerIdentityProvider: "nhl",
              nhlSeasonKey,
              sourceVersion: `historical-cas-${mutation}`,
              completedAtMs: NOW_MS + 100,
              rows: normalizedTotal(providerPlayerId),
              playerGameRows:
                playerGameRowsForRequirements(snapshot),
              requiredPlayers: snapshot.requiredPlayers,
              requiredPlayerGames:
                snapshot.requiredPlayerGames,
              requirementsSha256:
                snapshot.requirementsSha256,
              playerGameCoverage:
                coverageForRequirements(snapshot),
            }),
          {
            code:
              "PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED",
          }
        );
        assertRefreshHasNoPartialWrites(
          runtime.database,
          refresh.id,
          mutation
        );

        if (mutation === "status_enters") {
          assert.equal(
            runtime.repository.readPlayerGameCoverageRequirements({
              nhlSeasonKey,
              playerIdentityProvider: "nhl",
            }).requiredPlayerGames.length,
            1
          );
        } else if (mutation === "status_leaves") {
          assert.deepEqual(
            runtime.repository.readPlayerGameCoverageRequirements({
              nhlSeasonKey,
              playerIdentityProvider: "nhl",
            }).requiredPlayerGames,
            []
          );
        }
      });
    }
  });

  test("historical CAS ignores a sealed binding mutation in a final week", (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 2_500, "7002500");
    const liveScope = seedCoverageScope(runtime.database, {
      base: 35_000,
      nhlSeasonKey: "20702071",
      weekStatus: "live",
      ownerships: [{ playerValue: 2_500 }],
    });
    insertHistoricalExclusionEvidence(
      runtime.database,
      liveScope,
      {
        base: 51_000,
        playerValue: 2_500,
        providerTeamId: "LIVE-SEALED",
        nhlGameId: "live-required-game",
      }
    );
    const finalScope = seedCoverageScope(runtime.database, {
      base: 35_100,
      nhlSeasonKey: "20702071",
      weekStatus: "final",
    });
    const finalEvidence = insertHistoricalExclusionEvidence(
      runtime.database,
      finalScope,
      {
        base: 51_100,
        playerValue: 2_500,
        providerTeamId: "FINAL-SEALED",
        nhlGameId: "final-ignored-game",
      }
    );
    const snapshot =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20702071",
        playerIdentityProvider: "nhl",
      });
    assert.deepEqual(
      snapshot.requiredPlayerGames.map((game) => game.nhlGameId),
      ["live-required-game"]
    );
    runtime.database.exec(
      "DROP TRIGGER IF EXISTS " +
        "stat_refresh_player_game_coverage_immutable_update"
    );
    runtime.database.prepare(
      "UPDATE stat_refresh_player_game_coverage_entries " +
        "SET provider_team_id = 'FINAL-CHANGED' WHERE id = ?"
    ).run(finalEvidence.coverageEntryId);

    const { source, refresh } = startLiveRefresh(runtime, {
      base: 61_000,
      nhlSeasonKey: "20702071",
    });
    const result = runtime.repository.completeLiveRefresh({
      refreshId: refresh.id,
      statSourceId: source.id,
      provider: "nhl",
      playerIdentityProvider: "nhl",
      nhlSeasonKey: "20702071",
      sourceVersion: "final-mutation-ignored",
      completedAtMs: NOW_MS + 100,
      rows: normalizedTotal("7002500"),
      playerGameRows:
        playerGameRowsForRequirements(snapshot),
      requiredPlayers: snapshot.requiredPlayers,
      requiredPlayerGames: snapshot.requiredPlayerGames,
      requirementsSha256: snapshot.requirementsSha256,
      playerGameCoverage: coverageForRequirements(snapshot),
    });
    assert.equal(result.refresh.status, "succeeded");
    assert.deepEqual(
      result.requiredPlayerGames,
      snapshot.requiredPlayerGames
    );
  });

  test("CAS permits mutations outside the required player union", (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1_100, "8001100");
    insertPlayer(runtime.players, 1_101, "8001101");
    insertPlayer(runtime.players, 1_102, "8001102");
    const scope = seedCoverageScope(runtime.database, {
      base: 25_000,
      nhlSeasonKey: "20402041",
      weekStatus: "live",
      ownerships: [{ playerValue: 1_100 }],
    });
    const scheduled = seedCoverageScope(runtime.database, {
      base: 25_100,
      nhlSeasonKey: "20402041",
      weekStatus: "scheduled",
    });
    const snapshot =
      runtime.repository.readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20402041",
        playerIdentityProvider: "nhl",
      });
    insertCoverageOwnership(runtime.database, scope, {
      idValue: 25_200,
      playerValue: 1_101,
      rosterCategory: "Bench",
    });
    insertCoverageOwnership(runtime.database, scheduled, {
      idValue: 25_201,
      playerValue: 1_102,
    });

    const result = completeTerminalLiveRefresh(runtime, {
      base: 25_300,
      nhlSeasonKey: "20402041",
      snapshot,
      totalExternalPlayerId: "8001100",
    });
    assert.equal(result.refresh.status, "succeeded");
    assert.equal(result.playerGameSet.required_player_count, 1);
    assert.equal(result.playerGameSet.coverage_entry_count, 1);
    assert.equal(result.playerGameSet.observation_count, 0);
    assert.deepEqual(result.requiredPlayers, [{
      playerId: uuid(1_100),
      providerPlayerId: "8001100",
    }]);
  });

  test("atomically persists a complete normalized refresh as the latest season set", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    insertPlayer(runtime.players, 2, "8478403");
    const target = service(runtime.repository, {
      async fetchRows() {
        return {
          rows: validRows,
          sourceVersion: "nhl-2026-10-12",
          sourceUpdatedAtMs: NOW_MS,
        };
      },
    });

    assert.deepEqual(await target.refresh(), {
      refreshId: uuid(301),
      status: "succeeded",
      playerCount: 2,
      sourceVersion: "nhl-2026-10-12",
    });
    const latest = target.readLatest();
    assert.equal(latest.refresh.status, "succeeded");
    assert.deepEqual(latest.totals, [
      {
        player_id: uuid(1),
        games_played: 3,
        goals: 2,
        assists: 1,
        nhl_points: 3,
        fantasy_points_hundredths: 350,
        source_updated_at_ms: NOW_MS,
      },
      {
        player_id: uuid(2),
        games_played: 4,
        goals: 0,
        assists: 4,
        nhl_points: 4,
        fantasy_points_hundredths: 400,
        source_updated_at_ms: NOW_MS,
      },
    ]);
  });

  test("records provider failure without replacing last-valid totals", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    insertPlayer(runtime.players, 2, "8478403");
    const ids = idFactory(300);
    await service(runtime.repository, { fetchRows: async () => validRows }, {
      createId: ids,
    }).refresh();
    const before = service(runtime.repository, { fetchRows: async () => validRows }).readLatest();
    const failing = service(runtime.repository, {
      async fetchRows() { throw new Error("secret provider response"); },
    }, { createId: ids, nowMs: clock(NOW_MS + 100) });

    await assert.rejects(() => failing.refresh(), {
      code: TARGET_STATISTICS_CODES.providerFailed,
    });
    assert.deepEqual(failing.readLatest(), before);
    const failed = runtime.database.prepare(
      "SELECT status, error_code, metadata_json FROM stat_refreshes ORDER BY started_at_ms DESC LIMIT 1"
    ).get();
    assert.deepEqual(failed, {
      status: "failed",
      error_code: TARGET_STATISTICS_CODES.providerFailed,
      metadata_json: null,
    });
  });

  test("rejects an undersized provider response and preserves an empty last-valid state", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    const target = service(runtime.repository, {
      fetchRows: async () => [validRows[0]],
    });
    await assert.rejects(() => target.refresh(), {
      code: STATISTICS_CODES.responseIncomplete,
    });
    assert.equal(target.readLatest(), null);
    assert.deepEqual(
      runtime.database.prepare("SELECT status, error_code FROM stat_refreshes").get(),
      { status: "rejected", error_code: STATISTICS_CODES.responseIncomplete }
    );
  });

  test("rolls back every candidate total when one provider identity is unmapped", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    const target = service(runtime.repository, { fetchRows: async () => validRows });
    await assert.rejects(() => target.refresh(), {
      code: TARGET_STATISTICS_CODES.persistenceFailed,
    });
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM player_stat_totals").get().count,
      0
    );
    assert.deepEqual(
      runtime.database.prepare("SELECT status, error_code FROM stat_refreshes").get(),
      { status: "rejected", error_code: TARGET_STATISTICS_CODES.persistenceFailed }
    );
  });

  test("keeps latest-season reads byte-for-byte read-only and ignores later rejected attempts", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    insertPlayer(runtime.players, 2, "8478403");
    const ids = idFactory(300);
    const successful = service(runtime.repository, { fetchRows: async () => validRows }, {
      createId: ids,
    });
    await successful.refresh();
    const rejected = service(runtime.repository, {
      fetchRows: async () => [{ ...validRows[0], goals: -1 }],
    }, { createId: ids, nowMs: clock(NOW_MS + 100) });
    await assert.rejects(() => rejected.refresh(), {
      code: STATISTICS_CODES.inputInvalid,
    });
    const before = runtime.database.serialize();
    const latest = rejected.readLatest();
    assert.equal(latest.refresh.id, uuid(301));
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("authorizes every statistics write and terminal bookkeeping path", async (t) => {
    const cases = [
      {
        name: "success",
        providerResult: validRows,
        expectedCode: null,
        expectedTrace: [
          "authorize",
          "ensureSource",
          "authorize",
          "startRefresh",
          "fetchRows",
          "authorize",
          "completeRefresh",
        ],
      },
      {
        name: "provider failure",
        providerError: new Error("provider unavailable"),
        expectedCode: TARGET_STATISTICS_CODES.providerFailed,
        expectedTrace: [
          "authorize",
          "ensureSource",
          "authorize",
          "startRefresh",
          "fetchRows",
          "authorize",
          "rejectRefresh",
        ],
      },
      {
        name: "invalid provider response",
        providerResult: [validRows[0]],
        expectedCode: STATISTICS_CODES.responseIncomplete,
        expectedTrace: [
          "authorize",
          "ensureSource",
          "authorize",
          "startRefresh",
          "fetchRows",
          "authorize",
          "rejectRefresh",
        ],
      },
      {
        name: "persistence failure",
        providerResult: validRows,
        persistenceError: new Error("persistence unavailable"),
        expectedCode: TARGET_STATISTICS_CODES.persistenceFailed,
        expectedTrace: [
          "authorize",
          "ensureSource",
          "authorize",
          "startRefresh",
          "fetchRows",
          "authorize",
          "completeRefresh",
          "authorize",
          "rejectRefresh",
        ],
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const trace = [];
        const repository = {
          ensureSource(command) {
            trace.push("ensureSource");
            return { id: command.id };
          },
          startRefresh() {
            trace.push("startRefresh");
          },
          completeRefresh(command) {
            trace.push("completeRefresh");
            if (scenario.persistenceError) {
              throw scenario.persistenceError;
            }
            return {
              id: command.refreshId,
              status: "succeeded",
              player_count: command.rows.length,
              source_version: command.sourceVersion,
            };
          },
          rejectRefresh() {
            trace.push("rejectRefresh");
          },
          readLatestSeason() {
            return null;
          },
        };
        const target = service(repository, {
          async fetchRows() {
            trace.push("fetchRows");
            if (scenario.providerError) throw scenario.providerError;
            return scenario.providerResult;
          },
        });
        const refresh = target.refresh({
          authorizePersist: async () => {
            trace.push("authorize");
          },
        });

        if (scenario.expectedCode === null) {
          assert.equal((await refresh).status, "succeeded");
        } else {
          await assert.rejects(refresh, { code: scenario.expectedCode });
        }
        assert.deepEqual(trace, scenario.expectedTrace);
      });
    }
  });

  test("revalidates persistence authority before every persisted phase", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    insertPlayer(runtime.players, 2, "8478403");
    const target = service(runtime.repository, {
      fetchRows: async () => validRows,
    });
    let authorizationChecks = 0;
    const authorityError = Object.assign(
      new Error("authority changed"),
      { code: "STAGING_SPORTSDATAIO_IMPORT_AUTHORITY_CHANGED" }
    );

    await assert.rejects(
      target.refresh({
        authorizePersist: async () => {
          authorizationChecks += 1;
          if (authorizationChecks === 2) throw authorityError;
        },
      }),
      authorityError
    );
    assert.equal(authorizationChecks, 2);
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM player_stat_totals"
      ).get().count,
      0
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT status, error_code FROM stat_refreshes"
      ).get(),
      undefined
    );

    authorizationChecks = 0;
    const providerFailed = service(runtime.repository, {
      async fetchRows() {
        throw new Error("provider failed after the refresh started");
      },
    });
    await assert.rejects(
      providerFailed.refresh({
        authorizePersist: async () => {
          authorizationChecks += 1;
          if (authorizationChecks === 3) throw authorityError;
        },
      }),
      authorityError
    );
    assert.equal(authorizationChecks, 3);
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT status, error_code FROM stat_refreshes"
      ).get(),
      { status: "started", error_code: null }
    );

    const before = runtime.database.serialize();
    await assert.rejects(
      target.refresh({
        authorizePersist: async () => {
          throw authorityError;
        },
      }),
      authorityError
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
  });
});
