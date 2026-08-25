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

function safeCategory(value) {
  if (
    ![
      "all",
      "auction",
      "buyout",
      "commissioner",
      "competition",
      "other",
      "team",
      "trade",
    ].includes(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A valid activity category is required."
    );
  }
  return value;
}

function createSqliteLeagueActivityRepository({ database } = {}) {
  let listFirstStatement;
  let listAfterStatement;
  try {
    const columns = `
      activity.id, activity.league_id, activity.season_id,
      activity.event_type, activity.actor_user_id,
      activity.actor_authority, activity.team_id, activity.player_id,
      activity.related_type, activity.related_id,
      activity.display_summary, activity.reason, activity.metadata_json,
      activity.occurred_at_ms,
      actor.display_name AS actor_display_name,
      team.name AS team_name,
      player.full_name AS player_full_name
    `;
    const category = `CASE
      WHEN lower(activity.event_type) LIKE '%trade%' THEN 'trade'
      WHEN lower(activity.event_type) LIKE '%auction%' THEN 'auction'
      WHEN lower(activity.event_type) LIKE '%buyout%' THEN 'buyout'
      WHEN lower(activity.event_type) LIKE '%commissioner%'
        OR lower(activity.event_type) LIKE '%correction%' THEN 'commissioner'
      WHEN lower(activity.event_type) LIKE '%team%'
        OR lower(activity.event_type) LIKE '%roster%'
        OR lower(activity.event_type) LIKE '%ownership%' THEN 'team'
      WHEN lower(activity.event_type) LIKE '%matchup%'
        OR lower(activity.event_type) LIKE '%standings%'
        OR lower(activity.event_type) LIKE '%draft%'
        OR substr(lower(activity.event_type), 1, 4) IN ('fad_', 'fad.')
        THEN 'competition'
      ELSE 'other'
    END`;
    listFirstStatement = database.prepare(`
      SELECT ${columns}
      FROM league_activity AS activity
      LEFT JOIN users AS actor
        ON actor.id = activity.actor_user_id
      LEFT JOIN teams AS team
        ON team.league_id = activity.league_id
       AND team.id = activity.team_id
      LEFT JOIN players AS player
        ON player.id = activity.player_id
      WHERE activity.league_id = @leagueId
        AND activity.event_type <> 'roster_moved'
        AND (@category = 'all' OR (${category}) = @category)
      ORDER BY activity.occurred_at_ms DESC, activity.id DESC
      LIMIT @fetchLimit
    `);
    listAfterStatement = database.prepare(`
      SELECT ${columns}
      FROM league_activity AS activity
      LEFT JOIN users AS actor
        ON actor.id = activity.actor_user_id
      LEFT JOIN teams AS team
        ON team.league_id = activity.league_id
       AND team.id = activity.team_id
      LEFT JOIN players AS player
        ON player.id = activity.player_id
      WHERE activity.league_id = @leagueId
        AND activity.event_type <> 'roster_moved'
        AND (@category = 'all' OR (${category}) = @category)
        AND (
          activity.occurred_at_ms < @cursorOccurredAtMs
          OR (
            activity.occurred_at_ms = @cursorOccurredAtMs
            AND activity.id < @cursorId
          )
        )
      ORDER BY activity.occurred_at_ms DESC, activity.id DESC
      LIMIT @fetchLimit
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeagueActivityRepository",
      tableName: "league_activity",
    });
  }

  return Object.freeze({
    listPage({ leagueId, limit, cursor, category = "all" } = {}) {
      const parameters = {
        leagueId: stableId(leagueId),
        fetchLimit: safeLimit(limit) + 1,
        category: safeCategory(category),
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
