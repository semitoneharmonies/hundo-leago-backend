const { randomUUID } = require("node:crypto");

const {
  assertNhlSeasonKey,
} = require("../../../domain/statistics/statisticsPolicy");
const {
  createPlayerGameObservationSetEvidence,
  OBSERVED_GAME_STATES,
} = require("../../../domain/statistics/playerGameStatisticsPolicy");
const {
  PLAYER_GAME_COVERAGE_DISPOSITIONS,
  createPlayerGameCoverageRequirements,
  createPlayerGameCoverageSetEvidence,
  normalizeRequiredPlayerGameSet,
  normalizeRequiredPlayerSet,
} = require("../../../domain/statistics/playerGameCoveragePolicy");
const {
  compareUnicodeScalarStrings,
} = require("../../../domain/leagues/seasonRolloverEvidencePolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED =
  "PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COVERAGE_DISPOSITION_SET = new Set(
  PLAYER_GAME_COVERAGE_DISPOSITIONS
);
const OBSERVED_GAME_STATE_SET = new Set(OBSERVED_GAME_STATES);
const FLAT_COVERAGE_KEYS = Object.freeze([
  "playerId",
  "providerPlayerId",
  "providerTeamId",
  "disposition",
  "nhlGameId",
  "nhlGameScheduledStartsAtMs",
  "observedGameState",
]);

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A safe UTC timestamp is required."
    );
  }
  return value;
}

function boundedText(value, maximum = 200) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A bounded canonical string is required."
    );
  }
  return value;
}

function nullableBoundedText(value, maximum = 200) {
  return value === null ? null : boundedText(value, maximum);
}

function lowercaseSha256(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A lowercase SHA-256 digest is required."
    );
  }
  return value;
}

function exactObject(value, keys, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      `${description} must be an object.`
    );
  }
  const actual = Object.keys(value).sort(
    compareUnicodeScalarStrings
  );
  const expected = [...keys].sort(compareUnicodeScalarStrings);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      `${description} has an invalid shape.`
    );
  }
  return value;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function normalizeRepositoryRequiredPlayers(requiredPlayers) {
  try {
    return normalizeRequiredPlayerSet(requiredPlayers);
  } catch (error) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An exact player-game coverage requirement set is required.",
      { cause: error }
    );
  }
}

function normalizeRepositoryRequiredPlayerGames(
  requiredPlayerGames,
  requiredPlayers
) {
  try {
    return normalizeRequiredPlayerGameSet(
      requiredPlayerGames,
      requiredPlayers
    );
  } catch (error) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An exact historical player-game requirement set is required.",
      { cause: error }
    );
  }
}

function sameRequiredPlayers(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (player, index) =>
        player.playerId === right[index].playerId &&
        player.providerPlayerId ===
          right[index].providerPlayerId
    )
  );
}

function sameRequiredPlayerGames(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (game, index) =>
        game.playerId === right[index].playerId &&
        game.providerPlayerId ===
          right[index].providerPlayerId &&
        game.providerTeamId === right[index].providerTeamId &&
        game.nhlGameId === right[index].nhlGameId &&
        game.nhlGameScheduledStartsAtMs ===
          right[index].nhlGameScheduledStartsAtMs
    )
  );
}

function sameRequiredPlayerGameCoverage(required, coverage) {
  return (
    coverage?.disposition === "expected_game" &&
    required.playerId === coverage.playerId &&
    required.providerPlayerId === coverage.providerPlayerId &&
    required.providerTeamId === coverage.providerTeamId &&
    required.nhlGameId === coverage.nhlGameId &&
    required.nhlGameScheduledStartsAtMs ===
      coverage.nhlGameScheduledStartsAtMs
  );
}

function normalizeFlatCoverage(entries) {
  if (!Array.isArray(entries)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Normalized player-game coverage is required."
    );
  }
  return entries.map((candidate) => {
    const entry = exactObject(
      candidate,
      FLAT_COVERAGE_KEYS,
      "Player-game coverage entry"
    );
    const disposition = entry.disposition;
    if (!COVERAGE_DISPOSITION_SET.has(disposition)) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A supported player-game coverage disposition is required."
      );
    }
    const providerTeamId = nullableBoundedText(
      entry.providerTeamId,
      100
    );
    const nhlGameId = nullableBoundedText(entry.nhlGameId, 200);
    const nhlGameScheduledStartsAtMs =
      entry.nhlGameScheduledStartsAtMs === null
        ? null
        : safeTimestamp(entry.nhlGameScheduledStartsAtMs);
    const observedGameState =
      entry.observedGameState === null
        ? null
        : boundedText(entry.observedGameState, 40);
    if (
      (observedGameState !== null &&
        !OBSERVED_GAME_STATE_SET.has(observedGameState)) ||
      (disposition === "expected_game" &&
        (
          providerTeamId === null ||
          nhlGameId === null ||
          nhlGameScheduledStartsAtMs === null ||
          observedGameState === null
        )) ||
      (disposition === "no_due_game" &&
        (
          providerTeamId === null ||
          nhlGameId !== null ||
          nhlGameScheduledStartsAtMs !== null ||
          observedGameState !== null
        )) ||
      (disposition === "no_team" &&
        (
          providerTeamId !== null ||
          nhlGameId !== null ||
          nhlGameScheduledStartsAtMs !== null ||
          observedGameState !== null
        ))
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "Player-game coverage has an invalid disposition shape."
      );
    }
    return Object.freeze({
      playerId: stableId(entry.playerId),
      providerPlayerId: boundedText(
        entry.providerPlayerId,
        100
      ),
      providerTeamId,
      disposition,
      nhlGameId,
      nhlGameScheduledStartsAtMs,
      observedGameState,
    });
  });
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteStatisticsRepository({
  database,
  createId = randomUUID,
  occurrenceExecutionGuard,
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteStatisticsRepository requires a database");
  }
  if (typeof createId !== "function") {
    throw new TypeError("createSqliteStatisticsRepository requires an ID factory");
  }
  if (
    occurrenceExecutionGuard !== undefined &&
    (
      !occurrenceExecutionGuard ||
      typeof occurrenceExecutionGuard.assertCurrent !== "function"
    )
  ) {
    throw new TypeError(
      "statistics occurrenceExecutionGuard must assert current execution"
    );
  }

  const findSource = database.prepare(
    "SELECT * FROM stat_sources WHERE provider = @provider LIMIT 2"
  );
  const insertSource = database.prepare(
    "INSERT INTO stat_sources " +
      "(id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (@id, @provider, 'active', @nowMs, @nowMs, 1)"
  );
  const insertRefresh = database.prepare(
    "INSERT INTO stat_refreshes " +
      "(id, stat_source_id, nhl_season_key, source_version, status, " +
      "started_at_ms, completed_at_ms, player_count, error_code, metadata_json, version) " +
      "VALUES (@id, @statSourceId, @nhlSeasonKey, NULL, 'started', " +
      "@startedAtMs, NULL, NULL, NULL, NULL, 1)"
  );
  const findRefresh = database.prepare(
    "SELECT * FROM stat_refreshes WHERE id = @refreshId LIMIT 2"
  );
  const findOccurrenceSeason = database.prepare(
    "SELECT id, league_id, nhl_season_key FROM seasons " +
      "WHERE id = @seasonId LIMIT 2"
  );
  const resolvePlayer = database.prepare(
    "SELECT player_id FROM player_external_ids " +
      "WHERE provider = @playerIdentityProvider " +
      "AND external_value = @externalPlayerId LIMIT 2"
  );
  const readCoverageRequirementRows = database.prepare(`
    WITH relevant_seasons AS MATERIALIZED (
      SELECT league_id, id AS season_id
      FROM seasons INDEXED BY seasons_player_game_coverage_nhl
      WHERE nhl_season_key = @nhlSeasonKey
    ),
    required_player_ids AS (
      SELECT ownership.player_id
      FROM relevant_seasons AS relevant
      JOIN matchup_weeks AS current_week
        INDEXED BY matchup_weeks_player_game_coverage_live
        ON current_week.league_id = relevant.league_id
       AND current_week.season_id = relevant.season_id
      JOIN player_ownerships AS ownership
        INDEXED BY player_ownerships_player_game_coverage_active
        ON ownership.league_id = relevant.league_id
       AND ownership.season_id = relevant.season_id
      WHERE current_week.status IN ('live', 'awaiting_data')
        AND ownership.ownership_kind = 'Rostered'
        AND ownership.roster_category = 'Active'

      UNION

      SELECT locked_player.player_id
      FROM relevant_seasons AS relevant
      CROSS JOIN matchup_roster_players AS locked_player
        INDEXED BY matchup_roster_players_player_game_coverage_season
      JOIN matchup_roster_locks AS lock
        ON lock.league_id = locked_player.league_id
       AND lock.season_id = locked_player.season_id
       AND lock.id = locked_player.matchup_roster_lock_id
      WHERE locked_player.league_id = relevant.league_id
        AND locked_player.season_id = relevant.season_id

      UNION

      SELECT exclusion.player_id
      FROM relevant_seasons AS relevant
      CROSS JOIN matchup_roster_game_exclusions AS exclusion
        INDEXED BY matchup_roster_game_exclusions_player_game_coverage_season
      JOIN matchup_roster_game_exclusion_sets AS root
        ON root.league_id = exclusion.league_id
       AND root.season_id = exclusion.season_id
       AND root.id = exclusion.exclusion_set_id
      WHERE exclusion.league_id = relevant.league_id
        AND exclusion.season_id = relevant.season_id
    )
    SELECT
      required_player_ids.player_id AS playerId,
      identity.external_value AS providerPlayerId
    FROM required_player_ids
    LEFT JOIN player_external_ids AS identity
      ON identity.player_id = required_player_ids.player_id
     AND identity.provider = @playerIdentityProvider
    ORDER BY required_player_ids.player_id ASC
  `);
  const readHistoricalCoverageRequirementRows = database.prepare(`
    WITH relevant_seasons AS MATERIALIZED (
      SELECT league_id, id AS season_id
      FROM seasons INDEXED BY seasons_player_game_coverage_nhl
      WHERE nhl_season_key = @nhlSeasonKey
    )
    SELECT
      exclusion.id AS exclusionId,
      exclusion.player_id AS playerId,
      current_identity.external_value AS providerPlayerId,
      baseline_coverage.provider_player_id AS sealedProviderPlayerId,
      baseline_coverage.provider_team_id AS providerTeamId,
      exclusion.nhl_game_id AS nhlGameId,
      exclusion.nhl_game_scheduled_starts_at_ms AS
        nhlGameScheduledStartsAtMs,
      root.id AS exclusionSetId,
      late_lock.id AS lateLockId,
      locked_player.id AS lockedPlayerId,
      baseline_snapshot.id AS baselineSnapshotId,
      baseline_refresh.id AS baselineRefreshId,
      baseline_observation.id AS baselineObservationId,
      baseline_set.id AS baselineSetId,
      baseline_coverage.id AS baselineCoverageEntryId
    FROM relevant_seasons AS relevant
    JOIN matchup_weeks AS matchup_week
      ON matchup_week.league_id = relevant.league_id
     AND matchup_week.season_id = relevant.season_id
    JOIN matchup_roster_game_exclusions AS exclusion
      INDEXED BY matchup_roster_game_exclusions_player_game_coverage_season
      ON exclusion.league_id = relevant.league_id
     AND exclusion.season_id = relevant.season_id
    LEFT JOIN matchup_roster_game_exclusion_sets AS root
      ON root.league_id = exclusion.league_id
     AND root.season_id = exclusion.season_id
     AND root.matchup_week_id = exclusion.matchup_week_id
     AND root.matchup_id = exclusion.matchup_id
     AND root.team_id = exclusion.team_id
     AND root.matchup_roster_lock_id =
       exclusion.matchup_roster_lock_id
     AND root.observation_snapshot_id =
       exclusion.observation_snapshot_id
     AND root.late_snapshot_at_ms = exclusion.late_snapshot_at_ms
     AND root.id = exclusion.exclusion_set_id
    LEFT JOIN matchup_roster_locks AS late_lock
      ON late_lock.league_id = root.league_id
     AND late_lock.season_id = root.season_id
     AND late_lock.matchup_week_id = root.matchup_week_id
     AND late_lock.team_id = root.team_id
     AND late_lock.id = root.matchup_roster_lock_id
     AND late_lock.version = root.matchup_roster_lock_version
     AND late_lock.lock_type = 'late'
     AND late_lock.legal = 1
     AND late_lock.legality_reason_code IS NULL
     AND late_lock.locked_at_ms = root.late_snapshot_at_ms
     AND late_lock.baseline_snapshot_id = root.baseline_snapshot_id
     AND late_lock.source_freshness_status = 'fresh'
    LEFT JOIN matchup_roster_players AS locked_player
      ON locked_player.league_id = exclusion.league_id
     AND locked_player.season_id = exclusion.season_id
     AND locked_player.matchup_roster_lock_id = late_lock.id
     AND locked_player.player_id = exclusion.player_id
     AND locked_player.id = exclusion.matchup_roster_player_id
    LEFT JOIN stat_snapshots AS baseline_snapshot
      ON baseline_snapshot.league_id = root.league_id
     AND baseline_snapshot.season_id = root.season_id
     AND baseline_snapshot.matchup_week_id = root.matchup_week_id
     AND baseline_snapshot.id = root.baseline_snapshot_id
     AND baseline_snapshot.intended_use = 'matchup_baseline'
     AND baseline_snapshot.completeness_status = 'complete'
     AND baseline_snapshot.freshness_status = 'fresh'
     AND baseline_snapshot.committed = 1
     AND baseline_snapshot.captured_at_ms <= root.late_snapshot_at_ms
    LEFT JOIN stat_refreshes AS baseline_refresh
      ON baseline_refresh.stat_source_id =
        baseline_snapshot.stat_source_id
     AND baseline_refresh.id = baseline_snapshot.source_refresh_id
     AND baseline_refresh.nhl_season_key = @nhlSeasonKey
     AND baseline_refresh.status = 'succeeded'
     AND baseline_refresh.completed_at_ms IS NOT NULL
     AND baseline_refresh.source_version IS NOT NULL
    LEFT JOIN player_game_stat_observations AS baseline_observation
      ON baseline_observation.id =
        exclusion.baseline_player_game_stat_observation_id
     AND baseline_observation.stat_source_id =
       baseline_snapshot.stat_source_id
     AND baseline_observation.refresh_id =
       baseline_snapshot.source_refresh_id
     AND baseline_observation.nhl_season_key = @nhlSeasonKey
     AND baseline_observation.player_id = exclusion.player_id
     AND baseline_observation.nhl_game_id = exclusion.nhl_game_id
     AND baseline_observation.nhl_game_scheduled_starts_at_ms =
       exclusion.nhl_game_scheduled_starts_at_ms
     AND baseline_observation.created_at_ms <=
       baseline_snapshot.captured_at_ms
    LEFT JOIN stat_refresh_player_game_sets AS baseline_set
      ON baseline_set.stat_source_id =
        baseline_observation.stat_source_id
     AND baseline_set.refresh_id = baseline_observation.refresh_id
     AND baseline_set.id = baseline_observation.observation_set_id
     AND baseline_set.nhl_season_key = @nhlSeasonKey
     AND baseline_set.source_version = baseline_refresh.source_version
    LEFT JOIN stat_refresh_player_game_coverage_entries AS baseline_coverage
      ON baseline_coverage.stat_source_id =
        baseline_observation.stat_source_id
     AND baseline_coverage.refresh_id = baseline_observation.refresh_id
     AND baseline_coverage.observation_set_id =
       baseline_observation.observation_set_id
     AND baseline_coverage.nhl_season_key = @nhlSeasonKey
     AND baseline_coverage.player_id = exclusion.player_id
     AND baseline_coverage.nhl_game_id = exclusion.nhl_game_id
     AND baseline_coverage.nhl_game_scheduled_starts_at_ms =
       exclusion.nhl_game_scheduled_starts_at_ms
     AND baseline_coverage.disposition = 'expected_game'
    LEFT JOIN player_external_ids AS current_identity
      ON current_identity.player_id = exclusion.player_id
     AND current_identity.provider = @playerIdentityProvider
    WHERE matchup_week.id = exclusion.matchup_week_id
      AND matchup_week.status IN (
        'live',
        'awaiting_data',
        'correction_required'
      )
    ORDER BY
      exclusion.player_id ASC,
      exclusion.nhl_game_id ASC,
      exclusion.nhl_game_scheduled_starts_at_ms ASC,
      current_identity.external_value ASC,
      baseline_coverage.provider_team_id ASC,
      exclusion.id ASC
  `);
  const insertTotal = database.prepare(
    "INSERT INTO player_stat_totals " +
      "(id, stat_source_id, refresh_id, nhl_season_key, player_id, games_played, " +
      "goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (@id, @statSourceId, @refreshId, @nhlSeasonKey, @playerId, @gamesPlayed, " +
      "@goals, @assists, @nhlPoints, @fantasyPointsHundredths, @sourceUpdatedAtMs, @createdAtMs)"
  );
  const insertPlayerGameObservation = database.prepare(
    "INSERT INTO player_game_stat_observations " +
      "(id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, " +
      "player_id, nhl_game_id, nhl_game_scheduled_starts_at_ms, observed_game_state, " +
      "goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, " +
      "created_at_ms, version) VALUES (@observationId, @statSourceId, @refreshId, " +
      "@observationSetId, @nhlSeasonKey, @playerId, @nhlGameId, " +
      "@nhlGameScheduledStartsAtMs, @observedGameState, @goals, @assists, @nhlPoints, " +
      "@fantasyPointsHundredths, @sourceUpdatedAtMs, @createdAtMs, 1)"
  );
  const insertPlayerGameCoverage = database.prepare(
    "INSERT INTO stat_refresh_player_game_coverage_entries " +
      "(id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, " +
      "player_id, provider_player_id, provider_team_id, disposition, " +
      "nhl_game_id, nhl_game_scheduled_starts_at_ms, created_at_ms, version) " +
      "VALUES (@coverageEntryId, @statSourceId, @refreshId, @observationSetId, " +
      "@nhlSeasonKey, @playerId, @providerPlayerId, @providerTeamId, " +
      "@disposition, @nhlGameId, @nhlGameScheduledStartsAtMs, @createdAtMs, 1)"
  );
  const insertPlayerGameSet = database.prepare(
    "INSERT INTO stat_refresh_player_game_sets " +
      "(id, stat_source_id, refresh_id, nhl_season_key, provider, source_version, " +
      "captured_at_ms, required_player_count, coverage_entry_count, " +
      "expected_player_game_count, coverage_schema_version, coverage_sha256, " +
      "observation_count, evidence_schema_version, evidence_sha256, created_at_ms, " +
      "version) VALUES (@id, @statSourceId, @refreshId, @nhlSeasonKey, @provider, " +
      "@sourceVersion, @capturedAtMs, @requiredPlayerCount, @coverageEntryCount, " +
      "@expectedPlayerGameCount, 1, @coverageSha256, @observationCount, 1, " +
      "@evidenceSha256, @capturedAtMs, 1)"
  );
  const findPlayerGameSet = database.prepare(
    "SELECT * FROM stat_refresh_player_game_sets WHERE refresh_id = @refreshId LIMIT 2"
  );
  const succeedRefresh = database.prepare(
    "UPDATE stat_refreshes SET source_version = @sourceVersion, status = 'succeeded', " +
      "completed_at_ms = @completedAtMs, player_count = @playerCount, error_code = NULL, " +
      "metadata_json = NULL, version = version + 1 " +
      "WHERE id = @refreshId AND status = 'started'"
  );
  const rejectRefresh = database.prepare(
    "UPDATE stat_refreshes SET status = @status, completed_at_ms = @completedAtMs, " +
      "player_count = NULL, error_code = @errorCode, metadata_json = NULL, " +
      "version = version + 1 WHERE id = @refreshId AND status = 'started'"
  );
  const latestRefresh = database.prepare(
    "SELECT stat_refreshes.* FROM stat_refreshes " +
      "JOIN stat_sources ON stat_sources.id = stat_refreshes.stat_source_id " +
      "WHERE stat_sources.provider = @provider " +
      "AND stat_refreshes.nhl_season_key = @nhlSeasonKey " +
      "AND stat_refreshes.status = 'succeeded' " +
      "ORDER BY stat_refreshes.completed_at_ms DESC, stat_refreshes.started_at_ms DESC, " +
      "stat_refreshes.id DESC LIMIT 1"
  );
  const totalsForRefresh = database.prepare(
    "SELECT player_id, games_played, goals, assists, nhl_points, " +
      "fantasy_points_hundredths, source_updated_at_ms " +
      "FROM player_stat_totals WHERE refresh_id = @refreshId ORDER BY player_id"
  );

  function readCoverageRequirementsSnapshot({
    nhlSeasonKey,
    playerIdentityProvider,
    missingMappingCode = REPOSITORY_ERROR_CODES.recordNotFound,
  }) {
    const rows = readCoverageRequirementRows.all({
      nhlSeasonKey,
      playerIdentityProvider,
    });
    const missing = rows.find(
      ({ providerPlayerId }) => providerPlayerId === null
    );
    if (missing) {
      throw repositoryError(
        missingMappingCode,
        missingMappingCode ===
          PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED
          ? "Player-game coverage requirements changed before completion."
          : "A required player identity mapping is missing.",
        {
          details: {
            playerId: missing.playerId,
            playerIdentityProvider,
          },
        }
      );
    }
    const historicalRows =
      readHistoricalCoverageRequirementRows.all({
        nhlSeasonKey,
        playerIdentityProvider,
      });
    const requiredPlayerGames = [];
    const gamesByIdentity = new Map();
    for (const row of historicalRows) {
      const evidenceComplete = [
        row.exclusionSetId,
        row.lateLockId,
        row.lockedPlayerId,
        row.baselineSnapshotId,
        row.baselineRefreshId,
        row.baselineObservationId,
        row.baselineSetId,
        row.baselineCoverageEntryId,
      ].every((value) => value !== null);
      if (
        !evidenceComplete ||
        row.providerPlayerId === null ||
        row.sealedProviderPlayerId === null ||
        row.providerTeamId === null ||
        row.providerPlayerId !== row.sealedProviderPlayerId
      ) {
        throw repositoryError(
          missingMappingCode,
          missingMappingCode ===
            PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED
            ? "Player-game coverage requirements changed before completion."
            : "Historical player-game coverage evidence is incomplete or no longer matches its player identity.",
          {
            details: {
              playerId: row.playerId,
              nhlGameId: row.nhlGameId,
              playerIdentityProvider,
            },
          }
        );
      }
      const game = {
        playerId: row.playerId,
        providerPlayerId: row.providerPlayerId,
        providerTeamId: row.providerTeamId,
        nhlGameId: row.nhlGameId,
        nhlGameScheduledStartsAtMs:
          row.nhlGameScheduledStartsAtMs,
      };
      const identity = `${game.playerId}\u0000${game.nhlGameId}`;
      const previous = gamesByIdentity.get(identity);
      if (previous) {
        if (!sameRequiredPlayerGames([previous], [game])) {
          throw repositoryError(
            missingMappingCode,
            missingMappingCode ===
              PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED
              ? "Player-game coverage requirements changed before completion."
              : "Historical player-game coverage evidence contains conflicting bindings.",
            {
              details: {
                playerId: row.playerId,
                nhlGameId: row.nhlGameId,
              },
            }
          );
        }
        continue;
      }
      gamesByIdentity.set(identity, game);
      requiredPlayerGames.push(game);
    }
    return createPlayerGameCoverageRequirements({
      nhlSeasonKey,
      playerIdentityProvider,
      requiredPlayers: rows,
      requiredPlayerGames,
    });
  }

  function resolveMappedPlayerId({
    playerIdentityProvider,
    externalPlayerId,
    description,
  }) {
    const mappings = resolvePlayer.all({
      playerIdentityProvider,
      externalPlayerId,
    });
    if (mappings.length !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        description,
        { details: { externalPlayerId, playerIdentityProvider } }
      );
    }
    return mappings[0].player_id;
  }

  const ensureSourceTransaction = database.transaction(({ id, provider, nowMs }) => {
    const existing = findSource.all({ provider });
    if (existing.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "A statistics provider resolves to multiple sources."
      );
    }
    if (existing.length === 1) {
      if (existing[0].status !== "active") {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The statistics source is disabled."
        );
      }
      return existing[0];
    }
    insertSource.run({ id, provider, nowMs });
    return findSource.get({ provider });
  });

  const completeTransaction = database.transaction((command) => {
    const refresh = findRefresh.get({ refreshId: command.refreshId });
    if (
      !refresh ||
      refresh.status !== "started" ||
      refresh.stat_source_id !== command.statSourceId ||
      refresh.nhl_season_key !== command.nhlSeasonKey
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The statistics refresh is not available for completion."
      );
    }
    for (const row of command.rows) {
      const mappings = resolvePlayer.all({
        playerIdentityProvider: command.provider,
        externalPlayerId: row.externalPlayerId,
      });
      if (mappings.length !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.recordNotFound,
          "A statistics player mapping is missing.",
          { details: { externalPlayerId: row.externalPlayerId } }
        );
      }
      insertTotal.run({
        id: stableId(createId()),
        statSourceId: command.statSourceId,
        refreshId: command.refreshId,
        nhlSeasonKey: command.nhlSeasonKey,
        playerId: mappings[0].player_id,
        gamesPlayed: row.gamesPlayed,
        goals: row.goals,
        assists: row.assists,
        nhlPoints: row.nhlPoints,
        fantasyPointsHundredths: row.fantasyPointsHundredths,
        sourceUpdatedAtMs: row.sourceUpdatedAtMs,
        createdAtMs: command.completedAtMs,
      });
    }
    const update = succeedRefresh.run({
      refreshId: command.refreshId,
      sourceVersion: command.sourceVersion,
      completedAtMs: command.completedAtMs,
      playerCount: command.rows.length,
    });
    if (update.changes !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The statistics refresh completion conflicted."
      );
    }
    return findRefresh.get({ refreshId: command.refreshId });
  });

  const completeLiveTransaction = database.transaction((command) => {
    if (command.occurrenceExecution !== undefined) {
      if (!occurrenceExecutionGuard) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.scopeRequired,
          "Scheduled live statistics completion requires an occurrence execution guard."
        );
      }
      occurrenceExecutionGuard.assertCurrent(
        command.occurrenceExecution
      );
      if (
        command.occurrenceExecution.jobType !==
        "matchup:statistics_refresh"
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.scopeRequired,
          "The occurrence execution is not authorized for live statistics completion."
        );
      }
      const occurrenceSeasons = findOccurrenceSeason.all({
        seasonId: command.occurrenceExecution.seasonId,
      });
      if (
        occurrenceSeasons.length !== 1 ||
        occurrenceSeasons[0].id !==
          command.occurrenceExecution.seasonId ||
        occurrenceSeasons[0].league_id !==
          command.occurrenceExecution.leagueId ||
        occurrenceSeasons[0].nhl_season_key !==
          command.nhlSeasonKey
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.scopeRequired,
          "The occurrence execution does not match the live statistics NHL season."
        );
      }
    }
    const refresh = findRefresh.get({ refreshId: command.refreshId });
    if (
      !refresh ||
      refresh.status !== "started" ||
      refresh.stat_source_id !== command.statSourceId ||
      refresh.nhl_season_key !== command.nhlSeasonKey
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The live statistics refresh is not available for completion."
      );
    }

    const currentRequirements = readCoverageRequirementsSnapshot({
      nhlSeasonKey: command.nhlSeasonKey,
      playerIdentityProvider: command.playerIdentityProvider,
      missingMappingCode:
        PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED,
    });
    if (
      currentRequirements.requirementsSha256 !==
        command.requirementsSha256 ||
      !sameRequiredPlayers(
        currentRequirements.requiredPlayers,
        command.requiredPlayers
      ) ||
      !sameRequiredPlayerGames(
        currentRequirements.requiredPlayerGames,
        command.requiredPlayerGames
      )
    ) {
      throw repositoryError(
        PLAYER_GAME_COVERAGE_REQUIREMENTS_CHANGED,
        "Player-game coverage requirements changed before completion."
      );
    }

    const requiredByPlayerId = new Map(
      command.requiredPlayers.map((player) => [
        player.playerId,
        player,
      ])
    );
    const requiredByProviderPlayerId = new Map(
      command.requiredPlayers.map((player) => [
        player.providerPlayerId,
        player,
      ])
    );
    const expectedCoverageByIdentity = new Map(
      command.playerGameCoverage
        .filter(
          (entry) => entry.disposition === "expected_game"
        )
        .map((entry) => [
          `${entry.playerId}\u0000${entry.nhlGameId}`,
          entry,
        ])
    );
    for (const requiredGame of command.requiredPlayerGames) {
      const coverage = expectedCoverageByIdentity.get(
        `${requiredGame.playerId}\u0000${requiredGame.nhlGameId}`
      );
      if (
        !sameRequiredPlayerGameCoverage(
          requiredGame,
          coverage
        )
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "Player-game coverage omitted or changed a required historical binding."
        );
      }
    }

    for (const row of command.rows) {
      const playerId = resolveMappedPlayerId({
        playerIdentityProvider: command.playerIdentityProvider,
        externalPlayerId: row.externalPlayerId,
        description: "A live statistics player mapping is missing.",
      });
      insertTotal.run({
        id: stableId(createId()),
        statSourceId: command.statSourceId,
        refreshId: command.refreshId,
        nhlSeasonKey: command.nhlSeasonKey,
        playerId,
        gamesPlayed: row.gamesPlayed,
        goals: row.goals,
        assists: row.assists,
        nhlPoints: row.nhlPoints,
        fantasyPointsHundredths: row.fantasyPointsHundredths,
        sourceUpdatedAtMs: row.sourceUpdatedAtMs,
        createdAtMs: command.completedAtMs,
      });
    }

    const observationSetId = stableId(createId());
    const coverage = command.playerGameCoverage.map((entry) => {
      const required = requiredByPlayerId.get(entry.playerId);
      const mappedPlayerId = resolveMappedPlayerId({
        playerIdentityProvider: command.playerIdentityProvider,
        externalPlayerId: entry.providerPlayerId,
        description: "A player-game coverage mapping is missing.",
      });
      if (
        !required ||
        required.providerPlayerId !== entry.providerPlayerId ||
        mappedPlayerId !== entry.playerId
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "Player-game coverage does not match the required identity snapshot."
        );
      }
      return {
        coverageEntryId: stableId(createId()),
        playerId: entry.playerId,
        providerPlayerId: entry.providerPlayerId,
        providerTeamId: entry.providerTeamId,
        disposition: entry.disposition,
        nhlGameId: entry.nhlGameId,
        nhlGameScheduledStartsAtMs:
          entry.nhlGameScheduledStartsAtMs,
      };
    });
    const coverageEvidence = createPlayerGameCoverageSetEvidence({
      setId: observationSetId,
      statSourceId: command.statSourceId,
      refreshId: command.refreshId,
      nhlSeasonKey: command.nhlSeasonKey,
      provider: command.provider,
      sourceVersion: command.sourceVersion,
      capturedAtMs: command.completedAtMs,
      requiredPlayers: command.requiredPlayers,
      coverage,
    });

    const observations = command.playerGameRows.map((row) => {
      const playerId = resolveMappedPlayerId({
        playerIdentityProvider: command.playerIdentityProvider,
        externalPlayerId: row.externalPlayerId,
        description:
          "A player-game statistics player mapping is missing.",
      });
      const required = requiredByProviderPlayerId.get(
        row.externalPlayerId
      );
      if (!required || required.playerId !== playerId) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "Player-game observations do not match the required identity snapshot."
        );
      }
      return {
        observationId: stableId(createId()),
        playerId,
        nhlGameId: row.nhlGameId,
        nhlGameScheduledStartsAtMs: row.nhlGameScheduledStartsAtMs,
        observedGameState: row.observedGameState,
        goals: row.goals,
        assists: row.assists,
        nhlPoints: row.nhlPoints,
        fantasyPointsHundredths: row.fantasyPointsHundredths,
        sourceUpdatedAtMs: row.sourceUpdatedAtMs,
      };
    });
    if (
      expectedCoverageByIdentity.size !== observations.length ||
      observations.some((observation) => {
        const expected = expectedCoverageByIdentity.get(
          `${observation.playerId}\u0000${observation.nhlGameId}`
        );
        return (
          !expected ||
          expected.nhlGameScheduledStartsAtMs !==
            observation.nhlGameScheduledStartsAtMs ||
          expected.observedGameState !==
            observation.observedGameState
        );
      })
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "Expected coverage does not equal player-game observations."
      );
    }
    const observationEvidence =
      createPlayerGameObservationSetEvidence({
        setId: observationSetId,
        statSourceId: command.statSourceId,
        refreshId: command.refreshId,
        nhlSeasonKey: command.nhlSeasonKey,
        provider: command.provider,
        sourceVersion: command.sourceVersion,
        capturedAtMs: command.completedAtMs,
        observations,
      });

    for (const row of coverageEvidence.preimage.coverage) {
      insertPlayerGameCoverage.run({
        ...row,
        observationSetId,
        statSourceId: command.statSourceId,
        refreshId: command.refreshId,
        nhlSeasonKey: command.nhlSeasonKey,
        createdAtMs: command.completedAtMs,
      });
    }
    for (const row of observationEvidence.preimage.observations) {
      insertPlayerGameObservation.run({
        ...row,
        observationSetId,
        statSourceId: command.statSourceId,
        refreshId: command.refreshId,
        nhlSeasonKey: command.nhlSeasonKey,
        createdAtMs: command.completedAtMs,
      });
    }
    const update = succeedRefresh.run({
      refreshId: command.refreshId,
      sourceVersion: command.sourceVersion,
      completedAtMs: command.completedAtMs,
      playerCount: command.rows.length,
    });
    if (update.changes !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The live statistics refresh completion conflicted."
      );
    }
    insertPlayerGameSet.run({
      id: observationSetId,
      statSourceId: command.statSourceId,
      refreshId: command.refreshId,
      nhlSeasonKey: command.nhlSeasonKey,
      provider: command.provider,
      sourceVersion: command.sourceVersion,
      capturedAtMs: command.completedAtMs,
      requiredPlayerCount:
        coverageEvidence.requiredPlayerCount,
      coverageEntryCount:
        coverageEvidence.coverageEntryCount,
      expectedPlayerGameCount:
        coverageEvidence.expectedPlayerGameCount,
      coverageSha256: coverageEvidence.coverageSha256,
      observationCount: observationEvidence.observationCount,
      evidenceSha256: observationEvidence.evidenceSha256,
    });
    return {
      refresh: findRefresh.get({ refreshId: command.refreshId }),
      playerGameSet: findPlayerGameSet.get({
        refreshId: command.refreshId,
      }),
      requiredPlayers: currentRequirements.requiredPlayers,
      requiredPlayerGames:
        currentRequirements.requiredPlayerGames,
      requirementsSha256:
        currentRequirements.requirementsSha256,
      requiredPlayerCount:
        coverageEvidence.requiredPlayerCount,
      coverageEntryCount:
        coverageEvidence.coverageEntryCount,
      expectedPlayerGameCount:
        coverageEvidence.expectedPlayerGameCount,
      observationCount: observationEvidence.observationCount,
      coverageSha256: coverageEvidence.coverageSha256,
      evidenceSha256: observationEvidence.evidenceSha256,
    };
  });

  return Object.freeze({
    ensureSource({ id, provider, nowMs }) {
      try {
        return freezeRow(
          ensureSourceTransaction.immediate({
            id: stableId(id),
            provider: boundedText(provider, 80),
            nowMs: safeTimestamp(nowMs),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "ensureStatisticsSource",
          tableName: "stat_sources",
        });
      }
    },
    startRefresh({ id, statSourceId, nhlSeasonKey, startedAtMs }) {
      try {
        insertRefresh.run({
          id: stableId(id),
          statSourceId: stableId(statSourceId),
          nhlSeasonKey: assertNhlSeasonKey(nhlSeasonKey),
          startedAtMs: safeTimestamp(startedAtMs),
        });
        return freezeRow(findRefresh.get({ refreshId: id }));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "startStatisticsRefresh",
          tableName: "stat_refreshes",
        });
      }
    },
    completeRefresh(command) {
      try {
        const normalized = {
          refreshId: stableId(command?.refreshId),
          statSourceId: stableId(command?.statSourceId),
          provider: boundedText(command?.provider, 80),
          nhlSeasonKey: assertNhlSeasonKey(command?.nhlSeasonKey),
          sourceVersion:
            command?.sourceVersion === null
              ? null
              : boundedText(command?.sourceVersion, 200),
          completedAtMs: safeTimestamp(command?.completedAtMs),
          rows: command?.rows,
        };
        if (!Array.isArray(normalized.rows) || normalized.rows.length < 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "Normalized statistics rows are required."
          );
        }
        return freezeRow(completeTransaction.immediate(normalized));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeStatisticsRefresh",
          tableName: "player_stat_totals",
        });
      }
    },
    readPlayerGameCoverageRequirements({
      nhlSeasonKey,
      playerIdentityProvider,
    }) {
      try {
        return readCoverageRequirementsSnapshot({
          nhlSeasonKey: assertNhlSeasonKey(nhlSeasonKey),
          playerIdentityProvider: boundedText(
            playerIdentityProvider,
            80
          ),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "readPlayerGameCoverageRequirements",
          tableName: "player_external_ids",
        });
      }
    },
    completeLiveRefresh(command) {
      try {
        const nhlSeasonKey = assertNhlSeasonKey(
          command?.nhlSeasonKey
        );
        const playerIdentityProvider = boundedText(
          command?.playerIdentityProvider,
          80
        );
        const requiredPlayers =
          normalizeRepositoryRequiredPlayers(
            command?.requiredPlayers
          );
        const requiredPlayerGames =
          normalizeRepositoryRequiredPlayerGames(
            command?.requiredPlayerGames,
            requiredPlayers
          );
        const requirementsSha256 = lowercaseSha256(
          command?.requirementsSha256
        );
        const declaredRequirements =
          createPlayerGameCoverageRequirements({
            nhlSeasonKey,
            playerIdentityProvider,
            requiredPlayers,
            requiredPlayerGames,
          });
        if (
          declaredRequirements.requirementsSha256 !==
          requirementsSha256
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "Player-game coverage requirements are not canonical."
          );
        }
        const normalized = {
          refreshId: stableId(command?.refreshId),
          statSourceId: stableId(command?.statSourceId),
          provider: boundedText(command?.provider, 80),
          playerIdentityProvider,
          nhlSeasonKey,
          sourceVersion: boundedText(command?.sourceVersion, 200),
          completedAtMs: safeTimestamp(command?.completedAtMs),
          rows: command?.rows,
          playerGameRows: command?.playerGameRows,
          requiredPlayers:
            declaredRequirements.requiredPlayers,
          requiredPlayerGames:
            declaredRequirements.requiredPlayerGames,
          requirementsSha256,
          playerGameCoverage: normalizeFlatCoverage(
            command?.playerGameCoverage
          ),
          ...(command?.occurrenceExecution === undefined
            ? {}
            : {
                occurrenceExecution:
                  command.occurrenceExecution,
              }),
        };
        if (!Array.isArray(normalized.rows) || normalized.rows.length < 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "Normalized live statistics totals are required."
          );
        }
        if (!Array.isArray(normalized.playerGameRows)) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "Normalized player-game statistics rows are required."
          );
        }
        const result = completeLiveTransaction.immediate(normalized);
        return deepFreeze({
          refresh: freezeRow(result.refresh),
          playerGameSet: freezeRow(result.playerGameSet),
          requiredPlayers: result.requiredPlayers,
          requiredPlayerGames: result.requiredPlayerGames,
          requirementsSha256: result.requirementsSha256,
          requiredPlayerCount: result.requiredPlayerCount,
          coverageEntryCount: result.coverageEntryCount,
          expectedPlayerGameCount:
            result.expectedPlayerGameCount,
          observationCount: result.observationCount,
          coverageSha256: result.coverageSha256,
          evidenceSha256: result.evidenceSha256,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeLiveStatisticsRefresh",
          tableName: "stat_refresh_player_game_sets",
        });
      }
    },
    rejectRefresh({ refreshId, status, errorCode, completedAtMs }) {
      if (!new Set(["failed", "rejected"]).has(status)) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A safe terminal refresh status is required."
        );
      }
      try {
        const result = rejectRefresh.run({
          refreshId: stableId(refreshId),
          status,
          errorCode: boundedText(errorCode, 100),
          completedAtMs: safeTimestamp(completedAtMs),
        });
        if (result.changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The statistics refresh terminal state conflicted."
          );
        }
        return freezeRow(findRefresh.get({ refreshId }));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "rejectStatisticsRefresh",
          tableName: "stat_refreshes",
        });
      }
    },
    readRefresh(refreshId) {
      return freezeRow(findRefresh.get({ refreshId: stableId(refreshId) }));
    },
    readLatestSeason({ provider, nhlSeasonKey }) {
      try {
        const refresh = latestRefresh.get({
          provider: boundedText(provider, 80),
          nhlSeasonKey: assertNhlSeasonKey(nhlSeasonKey),
        });
        if (!refresh) return null;
        return Object.freeze({
          refresh: freezeRow(refresh),
          totals: Object.freeze(
            totalsForRefresh
              .all({ refreshId: refresh.id })
              .map((row) => freezeRow(row))
          ),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "readLatestStatisticsSeason",
          tableName: "player_stat_totals",
        });
      }
    },
  });
}

module.exports = { createSqliteStatisticsRepository };
