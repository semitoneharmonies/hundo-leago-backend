const { buildCapOutlook } = require("../../../domain/contracts/capOutlookPolicy");

function createSqliteCapOutlookReader({ database }) {
  const seasons = database.prepare("SELECT id, label, nhl_season_key FROM seasons WHERE league_id = @leagueId ORDER BY nhl_season_key, id");
  const contracts = database.prepare(`
    SELECT year.* FROM contract_years AS year
    JOIN contracts AS contract ON contract.league_id = year.league_id AND contract.id = year.contract_id
    WHERE contract.league_id = @leagueId AND contract.current_team_id = @teamId
      AND contract.status = 'active' AND year.status IN ('current', 'future')
  `);
  const retentions = database.prepare(`
    SELECT obligation.id AS obligation_id, obligation.contract_id, obligation.player_id,
      obligation.responsible_team_id, player.full_name AS player_name,
      year.season_id, year.status, year.retained_aav_cents AS amount_cents
    FROM retention_obligations AS obligation
    JOIN retention_years AS year ON year.league_id = obligation.league_id AND year.retention_obligation_id = obligation.id
    JOIN contracts AS contract ON contract.league_id = obligation.league_id AND contract.id = obligation.contract_id
    JOIN players AS player ON player.id = obligation.player_id
    WHERE obligation.league_id = @leagueId AND obligation.status = 'active'
      AND (obligation.responsible_team_id = @teamId OR (contract.current_team_id = @teamId AND contract.status = 'active'))
      AND year.status IN ('current', 'future')
    ORDER BY player.full_name, obligation.id, year.season_id
  `);
  const buyouts = database.prepare(`
    SELECT obligation.id AS obligation_id, obligation.contract_id, obligation.player_id,
      player.full_name AS player_name, year.season_id, year.status, year.penalty_cents AS amount_cents
    FROM buyout_obligations AS obligation
    JOIN buyout_years AS year ON year.league_id = obligation.league_id AND year.buyout_obligation_id = obligation.id
    JOIN players AS player ON player.id = obligation.player_id
    WHERE obligation.league_id = @leagueId AND obligation.responsible_team_id = @teamId
      AND obligation.status = 'active' AND year.status IN ('current', 'future')
    ORDER BY player.full_name, obligation.id, year.season_id
  `);
  return (record) => {
    const lookup = { leagueId: record.scope.league_id, teamId: record.scope.team_id };
    return buildCapOutlook({
      ...record,
      seasons: seasons.all({ leagueId: lookup.leagueId }),
      contractYears: contracts.all(lookup),
      retentionYears: retentions.all(lookup),
      buyoutYears: buyouts.all(lookup),
    });
  };
}

module.exports = { createSqliteCapOutlookReader };
