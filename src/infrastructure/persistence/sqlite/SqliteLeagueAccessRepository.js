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
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function createSqliteLeagueAccessRepository({ database } = {}) {
  let listVisibleLeaguesStatement;
  let findActiveMembershipStatement;
  let findLeagueSummaryStatement;
  let findLeagueSettingsStatement;
  let listLeagueMembershipsStatement;
  let listLeagueSeasonsStatement;
  try {
    listVisibleLeaguesStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.current_season_id AS current_season_id,
        leagues.version AS league_version,
        seasons.label AS season_label,
        seasons.nhl_season_key AS nhl_season_key,
        seasons.status AS season_status,
        seasons.version AS season_version,
        league_memberships.id AS membership_id,
        league_memberships.permission_category AS permission_category,
        league_memberships.status AS membership_status,
        league_memberships.version AS membership_version
      FROM league_memberships
      JOIN leagues
        ON leagues.id = league_memberships.league_id
      LEFT JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = leagues.current_season_id
      WHERE league_memberships.user_id = @userId
        AND league_memberships.status = 'active'
        AND leagues.status <> 'deleted'
      ORDER BY leagues.id ASC
    `);
    findActiveMembershipStatement = database.prepare(`
      SELECT *
      FROM league_memberships
      WHERE league_id = @leagueId
        AND user_id = @userId
        AND status = 'active'
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 2
    `);
    findLeagueSummaryStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.commissioner_membership_id AS commissioner_membership_id,
        leagues.current_season_id AS current_season_id,
        leagues.version AS league_version,
        seasons.label AS season_label,
        seasons.nhl_season_key AS nhl_season_key,
        seasons.status AS season_status,
        seasons.regular_season_starts_at_ms AS regular_season_starts_at_ms,
        seasons.regular_season_ends_at_ms AS regular_season_ends_at_ms,
        seasons.fantasy_playoffs_start_at_ms AS fantasy_playoffs_start_at_ms,
        seasons.fantasy_playoffs_end_at_ms AS fantasy_playoffs_end_at_ms,
        seasons.version AS season_version
      FROM leagues
      LEFT JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = leagues.current_season_id
      WHERE leagues.id = @leagueId
    `);
    findLeagueSettingsStatement = database.prepare(`
      SELECT *
      FROM league_settings
      WHERE league_id = @leagueId
    `);
    listLeagueMembershipsStatement = database.prepare(`
      SELECT
        league_memberships.id AS membership_id,
        league_memberships.league_id AS league_id,
        league_memberships.user_id AS user_id,
        users.display_name AS display_name,
        league_memberships.permission_category AS permission_category,
        league_memberships.status AS membership_status,
        league_memberships.joined_at_ms AS joined_at_ms,
        league_memberships.ended_at_ms AS ended_at_ms,
        league_memberships.created_at_ms AS created_at_ms,
        league_memberships.updated_at_ms AS updated_at_ms,
        league_memberships.version AS membership_version
      FROM league_memberships
      JOIN users
        ON users.id = league_memberships.user_id
      WHERE league_memberships.league_id = @leagueId
      ORDER BY league_memberships.created_at_ms ASC,
        league_memberships.id ASC
    `);
    listLeagueSeasonsStatement = database.prepare(`
      SELECT *
      FROM seasons
      WHERE league_id = @leagueId
      ORDER BY
        CASE status
          WHEN 'active' THEN 0
          WHEN 'planned' THEN 1
          WHEN 'completed' THEN 2
          ELSE 3
        END,
        regular_season_starts_at_ms DESC,
        created_at_ms DESC,
        id ASC
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeagueAccessRepository",
    });
  }

  return Object.freeze({
    listVisibleLeagues(userId) {
      try {
        return freezeRows(
          listVisibleLeaguesStatement.all({
            userId: stableId(userId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listVisibleLeagues",
          tableName: "league_memberships",
        });
      }
    },
    findActiveMembership({ leagueId, userId } = {}) {
      try {
        const rows = findActiveMembershipStatement.all({
          leagueId: stableId(leagueId),
          userId: stableId(userId),
        });
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A user has multiple active memberships in one league."
          );
        }
        return freezeRow(rows[0]);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActiveLeagueMembership",
          tableName: "league_memberships",
        });
      }
    },
    findLeagueSummary(leagueId) {
      try {
        return freezeRow(
          findLeagueSummaryStatement.get({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findLeagueSummary",
          tableName: "leagues",
        });
      }
    },
    findLeagueSettings(leagueId) {
      try {
        return freezeRow(
          findLeagueSettingsStatement.get({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findLeagueSettings",
          tableName: "league_settings",
        });
      }
    },
    listLeagueMemberships(leagueId) {
      try {
        return freezeRows(
          listLeagueMembershipsStatement.all({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listLeagueMemberships",
          tableName: "league_memberships",
        });
      }
    },
    listLeagueSeasons(leagueId) {
      try {
        return freezeRows(
          listLeagueSeasonsStatement.all({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listLeagueSeasons",
          tableName: "seasons",
        });
      }
    },
  });
}

module.exports = {
  UUID_PATTERN,
  createSqliteLeagueAccessRepository,
};
