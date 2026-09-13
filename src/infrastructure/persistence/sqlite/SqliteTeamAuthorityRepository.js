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

function createSqliteTeamAuthorityRepository({
  database,
} = {}) {
  let findTeamStatement;
  let findCurrentManagerAssignmentStatement;
  let listCurrentManagedTeamsStatement;
  try {
    findTeamStatement = database.prepare(`
      SELECT
        teams.id AS team_id,
        teams.league_id AS league_id,
        teams.name AS team_name,
        teams.status AS team_status,
        teams.version AS team_version
      FROM teams
      WHERE teams.league_id = @leagueId
        AND teams.id = @teamId
    `);
    findCurrentManagerAssignmentStatement = database.prepare(`
      SELECT
        team_manager_assignments.id AS assignment_id,
        team_manager_assignments.league_id AS league_id,
        team_manager_assignments.team_id AS team_id,
        team_manager_assignments.user_id AS user_id,
        team_manager_assignments.membership_id AS membership_id,
        team_manager_assignments.status AS assignment_status,
        team_manager_assignments.assigned_at_ms AS assigned_at_ms,
        team_manager_assignments.accepted_at_ms AS accepted_at_ms,
        team_manager_assignments.ended_at_ms AS ended_at_ms,
        team_manager_assignments.version AS assignment_version,
        teams.status AS team_status,
        teams.version AS team_version,
        league_memberships.status AS membership_status,
        league_memberships.version AS membership_version,
        leagues.status AS league_status,
        leagues.version AS league_version
      FROM team_manager_assignments
      JOIN teams
        ON teams.league_id = team_manager_assignments.league_id
       AND teams.id = team_manager_assignments.team_id
      JOIN league_memberships
        ON league_memberships.league_id = team_manager_assignments.league_id
       AND league_memberships.id = team_manager_assignments.membership_id
      JOIN leagues
        ON leagues.id = team_manager_assignments.league_id
      WHERE team_manager_assignments.league_id = @leagueId
        AND team_manager_assignments.team_id = @teamId
        AND team_manager_assignments.user_id = @userId
        AND team_manager_assignments.membership_id = @membershipId
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.accepted_at_ms IS NOT NULL
        AND team_manager_assignments.ended_at_ms IS NULL
        AND league_memberships.user_id = @userId
        AND league_memberships.status = 'active'
        AND teams.status <> 'erased'
        AND leagues.status <> 'deleted'
      ORDER BY team_manager_assignments.assigned_at_ms ASC,
        team_manager_assignments.id ASC
      LIMIT 2
    `);
    listCurrentManagedTeamsStatement = database.prepare(`
      SELECT
        team_manager_assignments.id AS assignment_id,
        team_manager_assignments.league_id AS league_id,
        team_manager_assignments.team_id AS team_id,
        team_manager_assignments.user_id AS user_id,
        team_manager_assignments.membership_id AS membership_id,
        team_manager_assignments.status AS assignment_status,
        team_manager_assignments.accepted_at_ms AS accepted_at_ms,
        team_manager_assignments.ended_at_ms AS ended_at_ms,
        team_manager_assignments.version AS assignment_version,
        teams.status AS team_status,
        teams.version AS team_version,
        league_memberships.status AS membership_status,
        league_memberships.version AS membership_version,
        leagues.status AS league_status
      FROM team_manager_assignments
      JOIN teams
        ON teams.league_id = team_manager_assignments.league_id
       AND teams.id = team_manager_assignments.team_id
      JOIN league_memberships
        ON league_memberships.league_id = team_manager_assignments.league_id
       AND league_memberships.id = team_manager_assignments.membership_id
      JOIN leagues
        ON leagues.id = team_manager_assignments.league_id
      WHERE team_manager_assignments.user_id = @userId
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.accepted_at_ms IS NOT NULL
        AND team_manager_assignments.ended_at_ms IS NULL
        AND league_memberships.user_id = @userId
        AND league_memberships.status = 'active'
        AND teams.status <> 'erased'
        AND leagues.status <> 'deleted'
      ORDER BY team_manager_assignments.league_id ASC,
        team_manager_assignments.team_id ASC,
        team_manager_assignments.id ASC
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTeamAuthorityRepository",
    });
  }

  return Object.freeze({
    findTeam({ leagueId, teamId } = {}) {
      try {
        return freezeRow(
          findTeamStatement.get({
            leagueId: stableId(leagueId),
            teamId: stableId(teamId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findTeamAuthority",
          tableName: "teams",
        });
      }
    },
    findCurrentManagerAssignment({
      leagueId,
      teamId,
      userId,
      membershipId,
    } = {}) {
      try {
        const rows =
          findCurrentManagerAssignmentStatement.all({
            leagueId: stableId(leagueId),
            teamId: stableId(teamId),
            userId: stableId(userId),
            membershipId: stableId(membershipId),
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
          operation: "findCurrentManagerAssignment",
          tableName: "team_manager_assignments",
        });
      }
    },
    listCurrentManagedTeams(userId) {
      try {
        return freezeRows(
          listCurrentManagedTeamsStatement.all({
            userId: stableId(userId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listCurrentManagedTeams",
          tableName: "team_manager_assignments",
        });
      }
    },
  });
}

module.exports = {
  createSqliteTeamAuthorityRepository,
};
