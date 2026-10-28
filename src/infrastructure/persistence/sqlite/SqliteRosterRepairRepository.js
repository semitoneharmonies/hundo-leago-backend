function createSqliteRosterRepairRepository({ database }) {
  return Object.freeze({
    readEvidence({ leagueId, seasonId, teamId, nowMs }) {
      const scope = { leagueId, seasonId, teamId, nowMs };
      const all = (sql) => database.prepare(sql).all(scope);
      return {
        weeks: all("SELECT * FROM matchup_weeks WHERE league_id=@leagueId AND season_id=@seasonId AND ends_at_ms>@nowMs AND status NOT IN ('cancelled','final') ORDER BY starts_at_ms,id"),
        locks: all('SELECT r.* FROM matchup_roster_locks r JOIN matchup_weeks w ON w.id=r.matchup_week_id AND w.league_id=r.league_id WHERE r.league_id=@leagueId AND r.season_id=@seasonId AND r.team_id=@teamId AND w.ends_at_ms>@nowMs ORDER BY r.id'),
        ownerships: all('SELECT * FROM player_ownerships WHERE league_id=@leagueId AND season_id=@seasonId AND team_id=@teamId ORDER BY id'),
        injuries: all('SELECT i.* FROM player_injury_status i JOIN player_ownerships o ON o.player_id=i.id WHERE o.league_id=@leagueId AND o.season_id=@seasonId AND o.team_id=@teamId ORDER BY i.id'),
        contracts: all("SELECT * FROM contracts WHERE league_id=@leagueId AND current_team_id=@teamId AND status='active' ORDER BY id"),
        contractYears: all("SELECT y.* FROM contract_years y JOIN contracts c ON c.id=y.contract_id AND c.league_id=y.league_id WHERE c.league_id=@leagueId AND c.current_team_id=@teamId AND c.status='active' ORDER BY y.id"),
      };
    },
    commit(operation) {
      return database.transaction(() => {
        const result = operation();
        if (result && typeof result.then === 'function') throw new TypeError('Roster repair transactions must be synchronous.');
        return result;
      }).immediate();
    },
  });
}

module.exports = { createSqliteRosterRepairRepository };
