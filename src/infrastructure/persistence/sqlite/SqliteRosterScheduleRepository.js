const { CANONICAL_UUID_PATTERN } = require("../../../domain/players/playerIdentityPolicy");

function createSqliteRosterScheduleRepository({ database }) {
  const read = database.prepare(`SELECT w.id, w.starts_at_ms, w.ends_at_ms,
    s.nhl_season_key, l.timezone FROM matchup_weeks w
    JOIN seasons s ON s.id = w.season_id AND s.league_id = w.league_id
    JOIN leagues l ON l.id = w.league_id
    WHERE w.league_id = @leagueId AND w.season_id = @seasonId AND w.id = @weekId
      AND w.status <> 'cancelled'`);
  return Object.freeze({
    readWeek({ leagueId, seasonId, weekId }) {
      if (![leagueId, seasonId, weekId].every((id) => typeof id === "string" && CANONICAL_UUID_PATTERN.test(id))) {
        throw Object.assign(new Error("Invalid schedule scope."), { code: "ROSTER_SCHEDULE_INPUT_INVALID" });
      }
      return read.get({ leagueId, seasonId, weekId }) || null;
    },
  });
}

module.exports = { createSqliteRosterScheduleRepository };
