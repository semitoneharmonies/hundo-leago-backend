const { randomUUID } = require("node:crypto");

const {
  assertNhlSeasonKey,
} = require("../../../domain/statistics/statisticsPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

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

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteStatisticsRepository({ database, createId = randomUUID } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteStatisticsRepository requires a database");
  }
  if (typeof createId !== "function") {
    throw new TypeError("createSqliteStatisticsRepository requires an ID factory");
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
  const resolvePlayer = database.prepare(
    "SELECT player_id FROM player_external_ids " +
      "WHERE provider = @provider AND external_value = @externalPlayerId LIMIT 2"
  );
  const insertTotal = database.prepare(
    "INSERT INTO player_stat_totals " +
      "(id, stat_source_id, refresh_id, nhl_season_key, player_id, games_played, " +
      "goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (@id, @statSourceId, @refreshId, @nhlSeasonKey, @playerId, @gamesPlayed, " +
      "@goals, @assists, @nhlPoints, @fantasyPointsHundredths, @sourceUpdatedAtMs, @createdAtMs)"
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
        provider: command.provider,
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
