const {
  CapPolicyError,
  calculateTeamCap,
  validateCapLookup,
} = require("../../../domain/contracts/capPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

function createSqliteCapReadRepository({ database } = {}) {
  let settingsStatement;
  let teamStatement;
  let seasonStatement;
  let activePlayersStatement;
  let retentionStatement;
  let buyoutStatement;
  try {
    settingsStatement = database.prepare(
      "SELECT salary_cap_cents FROM league_settings " +
        "WHERE league_id = @leagueId LIMIT 2"
    );
    teamStatement = database.prepare(
      "SELECT id FROM teams WHERE league_id = @leagueId " +
        "AND id = @teamId LIMIT 2"
    );
    seasonStatement = database.prepare(
      "SELECT id FROM seasons WHERE league_id = @leagueId " +
        "AND id = @seasonId LIMIT 2"
    );
    activePlayersStatement = database.prepare(`
      SELECT
        ownership.id AS ownership_id,
        ownership.player_id,
        contract.id AS contract_id,
        contract.current_team_id,
        contract.aav_cents,
        COALESCE((
          SELECT SUM(retention_year.retained_aav_cents)
          FROM retention_obligations AS retention
          INNER JOIN retention_years AS retention_year
            ON retention_year.league_id = retention.league_id
            AND retention_year.retention_obligation_id = retention.id
          WHERE retention.league_id = ownership.league_id
            AND retention.contract_id = contract.id
            AND retention.status = 'active'
            AND retention_year.season_id = @seasonId
            AND retention_year.status = 'current'
        ), 0) AS retained_aav_cents
      FROM player_ownerships AS ownership
      LEFT JOIN contracts AS contract
        ON contract.league_id = ownership.league_id
        AND contract.player_id = ownership.player_id
        AND contract.status = 'active'
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
        AND ownership.ownership_kind = 'Rostered'
        AND ownership.roster_category = 'Active'
      ORDER BY ownership.player_id ASC
    `);
    retentionStatement = database.prepare(`
      SELECT
        retention.id AS retention_id,
        retention.contract_id,
        retention.player_id,
        retention_year.retained_aav_cents AS amount_cents
      FROM retention_obligations AS retention
      INNER JOIN retention_years AS retention_year
        ON retention_year.league_id = retention.league_id
        AND retention_year.retention_obligation_id = retention.id
      WHERE retention.league_id = @leagueId
        AND retention.responsible_team_id = @teamId
        AND retention.status = 'active'
        AND retention_year.season_id = @seasonId
        AND retention_year.status = 'current'
      ORDER BY retention.id ASC
    `);
    buyoutStatement = database.prepare(`
      SELECT
        buyout.id AS buyout_id,
        buyout.contract_id,
        buyout.player_id,
        buyout_year.penalty_cents AS amount_cents
      FROM buyout_obligations AS buyout
      INNER JOIN buyout_years AS buyout_year
        ON buyout_year.league_id = buyout.league_id
        AND buyout_year.buyout_obligation_id = buyout.id
      WHERE buyout.league_id = @leagueId
        AND buyout.responsible_team_id = @teamId
        AND buyout.status = 'active'
        AND buyout_year.season_id = @seasonId
        AND buyout_year.status = 'current'
      ORDER BY buyout.id ASC
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareCapReadRepository",
      tableName: "league_settings",
    });
  }

  return Object.freeze({
    calculate(input) {
      const lookup = validateCapLookup(input);
      try {
        const settingsRows = settingsStatement.all(lookup);
        const teamRows = teamStatement.all(lookup);
        const seasonRows = seasonStatement.all(lookup);
        if (
          settingsRows.length > 1 ||
          teamRows.length > 1 ||
          seasonRows.length > 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A cap calculation scope is not unique."
          );
        }
        if (!settingsRows[0] || !teamRows[0] || !seasonRows[0]) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.recordNotFound,
            "The cap calculation league, season, team, or settings do not exist."
          );
        }
        const activePlayers = [];
        const issues = [];
        for (const row of activePlayersStatement.all(lookup)) {
          if (row.contract_id === null) {
            issues.push({
              code: "ACTIVE_CONTRACT_MISSING",
              playerId: row.player_id,
              ownershipId: row.ownership_id,
            });
          } else if (row.current_team_id !== lookup.teamId) {
            issues.push({
              code: "ACTIVE_CONTRACT_TEAM_MISMATCH",
              playerId: row.player_id,
              ownershipId: row.ownership_id,
            });
          } else {
            activePlayers.push({
              playerId: row.player_id,
              ownershipId: row.ownership_id,
              contractId: row.contract_id,
              aavCents: row.aav_cents,
              retainedAavCents: row.retained_aav_cents,
            });
          }
        }
        return calculateTeamCap({
          ...lookup,
          salaryCapCents: settingsRows[0].salary_cap_cents,
          activePlayers,
          retentionObligations: retentionStatement.all(lookup).map((row) => ({
            retentionId: row.retention_id,
            contractId: row.contract_id,
            playerId: row.player_id,
            amountCents: row.amount_cents,
          })),
          buyoutObligations: buyoutStatement.all(lookup).map((row) => ({
            buyoutId: row.buyout_id,
            contractId: row.contract_id,
            playerId: row.player_id,
            amountCents: row.amount_cents,
          })),
          issues,
        });
      } catch (error) {
        if (error instanceof CapPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "calculateTeamCap",
          tableName: "league_settings",
        });
      }
    },
  });
}

module.exports = { createSqliteCapReadRepository };
