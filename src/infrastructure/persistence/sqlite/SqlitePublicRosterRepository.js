const {
  PublicRosterPolicyError,
  createPublicRosterProjection,
  validatePublicRosterLookup,
} = require("../../../domain/rosters/publicRosterPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");

function createSqlitePublicRosterRepository({ database } = {}) {
  const capRepository = createSqliteCapReadRepository({ database });
  let scopeStatement;
  let playersStatement;
  try {
    scopeStatement = database.prepare(`
      SELECT
        league.id AS league_id,
        league.name AS league_name,
        league.updated_at_ms AS league_updated_at_ms,
        season.id AS season_id,
        season.label AS season_label,
        season.nhl_season_key,
        season.updated_at_ms AS season_updated_at_ms,
        team.id AS team_id,
        team.name AS team_name,
        team.primary_colour,
        team.secondary_colour,
        team.updated_at_ms AS team_updated_at_ms,
        CASE WHEN logo.id IS NULL THEN 0 ELSE 1 END AS has_public_logo
      FROM leagues AS league
      INNER JOIN seasons AS season
        ON season.league_id = league.id
        AND season.id = league.current_season_id
      INNER JOIN teams AS team
        ON team.league_id = league.id
        AND team.id = @teamId
        AND team.status = 'active'
      LEFT JOIN team_logo_objects AS logo
        ON logo.league_id = team.league_id
        AND logo.team_id = team.id
        AND logo.id = team.logo_reference
      WHERE league.id = @leagueId
        AND league.status = 'active'
      LIMIT 2
    `);
    playersStatement = database.prepare(`
      WITH latest_stats AS (
        SELECT
          totals.*,
          ROW_NUMBER() OVER (
            PARTITION BY totals.player_id
            ORDER BY totals.source_updated_at_ms DESC,
              totals.created_at_ms DESC,
              totals.id DESC
          ) AS recency
        FROM player_stat_totals AS totals
        WHERE totals.nhl_season_key = @nhlSeasonKey
      )
      SELECT
        ownership.id AS ownership_id,
        ownership.player_id,
        ownership.position_group,
        ownership.roster_category,
        ownership.slot_number,
        ownership.updated_at_ms AS ownership_updated_at_ms,
        player.full_name,
        player.birth_date,
        contract.id AS contract_id,
        contract.aav_cents,
        contract.updated_at_ms AS contract_updated_at_ms,
        COALESCE((
          SELECT COUNT(*)
          FROM contract_years AS contract_year
          WHERE contract_year.league_id = ownership.league_id
            AND contract_year.contract_id = contract.id
            AND contract_year.status IN ('current', 'future')
        ), 0) AS remaining_contract_years,
        stats.games_played,
        stats.goals,
        stats.assists,
        stats.nhl_points,
        stats.fantasy_points_hundredths,
        stats.source_updated_at_ms
      FROM player_ownerships AS ownership
      INNER JOIN players AS player ON player.id = ownership.player_id
      LEFT JOIN contracts AS contract
        ON contract.league_id = ownership.league_id
        AND contract.player_id = ownership.player_id
        AND contract.current_team_id = ownership.team_id
        AND contract.status = 'active'
      LEFT JOIN latest_stats AS stats
        ON stats.player_id = ownership.player_id
        AND stats.recency = 1
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
      ORDER BY
        CASE ownership.roster_category
          WHEN 'Active' THEN 0
          WHEN 'Bench' THEN 1
          WHEN 'Injured Reserve' THEN 2
          ELSE 3
        END,
        ownership.position_group ASC,
        ownership.slot_number ASC,
        player.full_name ASC,
        ownership.player_id ASC
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "preparePublicRosterRepository",
      tableName: "player_ownerships",
    });
  }

  return Object.freeze({
    read(input) {
      const lookup = validatePublicRosterLookup(input);
      try {
        const scopeRows = scopeStatement.all(lookup);
        if (scopeRows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A public roster scope is not unique."
          );
        }
        if (!scopeRows[0]) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.recordNotFound,
            "The public roster is not available."
          );
        }
        const scope = scopeRows[0];
        const query = {
          leagueId: lookup.leagueId,
          seasonId: scope.season_id,
          teamId: lookup.teamId,
          nhlSeasonKey: scope.nhl_season_key,
        };
        const cap = capRepository.calculate({
          leagueId: query.leagueId,
          seasonId: query.seasonId,
          teamId: query.teamId,
        });
        if (!cap.complete) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "The public roster has an incomplete active-contract cap state."
          );
        }
        let updatedAt = Math.max(
          scope.league_updated_at_ms,
          scope.season_updated_at_ms,
          scope.team_updated_at_ms
        );
        const players = playersStatement.all(query).map((row) => {
          updatedAt = Math.max(
            updatedAt,
            row.ownership_updated_at_ms,
            row.contract_updated_at_ms ?? 0,
            row.source_updated_at_ms ?? 0
          );
          return {
            id: row.player_id,
            name: row.full_name,
            position: row.position_group,
            rosterCategory: row.roster_category,
            aavCents: row.aav_cents,
            remainingContractYears: row.remaining_contract_years,
            birthDate: row.birth_date,
            statistics:
              row.games_played === null
                ? null
                : {
                    gamesPlayed: row.games_played,
                    goals: row.goals,
                    assists: row.assists,
                    nhlPoints: row.nhl_points,
                    fantasyPointsHundredths:
                      row.fantasy_points_hundredths,
                  },
          };
        });
        return createPublicRosterProjection({
          asOfDate: lookup.asOfDate,
          league: { id: scope.league_id, name: scope.league_name },
          season: { id: scope.season_id, label: scope.season_label },
          team: {
            id: scope.team_id,
            name: scope.team_name,
            primaryColour: scope.primary_colour,
            secondaryColour: scope.secondary_colour,
            logoReference:
              scope.has_public_logo === 1
                ? `/api/v1/public/leagues/${scope.league_id}/teams/${scope.team_id}/logo`
                : null,
          },
          players,
          cap: {
            capLimitCents: cap.capLimitCents,
            capUsageCents: cap.capUsageCents,
            capSpaceCents: cap.capSpaceCents,
            retainedSalaryTotalCents: cap.breakdown.retentionCents,
            buyoutPenaltyTotalCents: cap.breakdown.buyoutCents,
          },
          updatedAt,
        });
      } catch (error) {
        if (error instanceof PublicRosterPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "readPublicRoster",
          tableName: "player_ownerships",
        });
      }
    },
  });
}

module.exports = { createSqlitePublicRosterRepository };
