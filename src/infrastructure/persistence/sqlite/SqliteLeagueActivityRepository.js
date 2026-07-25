const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical activity identifier is required."
    );
  }
  return value;
}

function safeLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An activity page size from one through 100 is required."
    );
  }
  return value;
}

function createSqliteLeagueActivityRepository({ database } = {}) {
  let listFirstStatement;
  let listAfterStatement;
  try {
    const columns = `
      id, league_id, season_id, event_type, actor_user_id,
      actor_authority, team_id, player_id, related_type, related_id,
      display_summary, reason, metadata_json, occurred_at_ms
    `;
    listFirstStatement = database.prepare(`
      SELECT ${columns}
      FROM league_activity
      WHERE league_id = @leagueId
      ORDER BY occurred_at_ms DESC, id DESC
      LIMIT @fetchLimit
    `);
    listAfterStatement = database.prepare(`
      SELECT ${columns}
      FROM league_activity
      WHERE league_id = @leagueId
        AND (
          occurred_at_ms < @cursorOccurredAtMs
          OR (
            occurred_at_ms = @cursorOccurredAtMs
            AND id < @cursorId
          )
        )
      ORDER BY occurred_at_ms DESC, id DESC
      LIMIT @fetchLimit
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeagueActivityRepository",
      tableName: "league_activity",
    });
  }

  return Object.freeze({
    listPage({ leagueId, limit, cursor } = {}) {
      const parameters = {
        leagueId: stableId(leagueId),
        fetchLimit: safeLimit(limit) + 1,
        ...(cursor
          ? {
              cursorOccurredAtMs: cursor.occurredAtMs,
              cursorId: stableId(cursor.id),
            }
          : {}),
      };
      if (
        cursor &&
        (!Number.isSafeInteger(cursor.occurredAtMs) ||
          cursor.occurredAtMs < 0)
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A canonical activity cursor is required."
        );
      }
      try {
        const rows = (cursor ? listAfterStatement : listFirstStatement).all(
          parameters
        );
        return Object.freeze({
          hasMore: rows.length > limit,
          rows: Object.freeze(
            rows.slice(0, limit).map((row) => Object.freeze({ ...row }))
          ),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listLeagueActivity",
          tableName: "league_activity",
        });
      }
    },
  });
}

module.exports = { createSqliteLeagueActivityRepository };
