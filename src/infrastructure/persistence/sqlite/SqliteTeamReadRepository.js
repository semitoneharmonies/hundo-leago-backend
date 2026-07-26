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

const TEAM_SUMMARY_SELECT = `
  SELECT
    teams.id AS team_id,
    teams.league_id AS league_id,
    teams.name AS team_name,
    teams.status AS team_status,
    teams.primary_colour AS primary_colour,
    teams.secondary_colour AS secondary_colour,
    teams.tertiary_colour AS tertiary_colour,
    teams.logo_reference AS logo_reference,
    teams.created_at_ms AS created_at_ms,
    teams.updated_at_ms AS updated_at_ms,
    teams.version AS team_version,
    team_manager_assignments.id AS manager_assignment_id,
    team_manager_assignments.user_id AS manager_user_id,
    team_manager_assignments.accepted_at_ms AS manager_accepted_at_ms,
    team_manager_assignments.version AS manager_assignment_version,
    users.display_name AS manager_display_name
  FROM teams
  LEFT JOIN team_manager_assignments
    ON team_manager_assignments.league_id = teams.league_id
   AND team_manager_assignments.team_id = teams.id
   AND team_manager_assignments.status = 'accepted'
   AND team_manager_assignments.ended_at_ms IS NULL
  LEFT JOIN users ON users.id = team_manager_assignments.user_id
`;

function createSqliteTeamReadRepository({ database } = {}) {
  let listTeamsStatement;
  let findTeamStatement;
  try {
    listTeamsStatement = database.prepare(`
      ${TEAM_SUMMARY_SELECT}
      WHERE teams.league_id = @leagueId
        AND teams.status <> 'erased'
      ORDER BY teams.name_normalized ASC, teams.id ASC
    `);
    findTeamStatement = database.prepare(`
      ${TEAM_SUMMARY_SELECT}
      WHERE teams.league_id = @leagueId
        AND teams.id = @teamId
        AND teams.status <> 'erased'
      LIMIT 2
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTeamReadRepository",
    });
  }

  return Object.freeze({
    listTeams(leagueId) {
      try {
        return freezeRows(
          listTeamsStatement.all({ leagueId: stableId(leagueId) })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listTeamSummaries",
          tableName: "teams",
        });
      }
    },
    findTeam({ leagueId, teamId } = {}) {
      try {
        const rows = findTeamStatement.all({
          leagueId: stableId(leagueId),
          teamId: stableId(teamId),
        });
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A team has multiple current manager assignments."
          );
        }
        return freezeRow(rows[0]);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findTeamSummary",
          tableName: "teams",
        });
      }
    },
  });
}

module.exports = {
  TEAM_SUMMARY_SELECT,
  createSqliteTeamReadRepository,
};
