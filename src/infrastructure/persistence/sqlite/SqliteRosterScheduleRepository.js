const { CANONICAL_UUID_PATTERN } = require("../../../domain/players/playerIdentityPolicy");
const { calculateExpandedScore, usesExpandedScoring } = require("../../../domain/statistics/expandedScoringPolicy");
const { matchesCompletedGame } = require("../../../domain/statistics/completedGameCachePolicy");
const { createLeagueScoringRuleReader } = require("./leagueScoringRules");
const { readObservedRosterGamePoints } = require("./readObservedRosterGamePoints");

function createSqliteRosterScheduleRepository({ database, expandedScoringEnabled = false }) {
  const read = database.prepare(`SELECT w.id, w.sequence, w.starts_at_ms, w.ends_at_ms,
    s.nhl_season_key, l.timezone FROM matchup_weeks w
    JOIN seasons s ON s.id = w.season_id AND s.league_id = w.league_id
    JOIN leagues l ON l.id = w.league_id
    WHERE w.league_id = @leagueId AND w.season_id = @seasonId AND w.id = @weekId
      AND w.status <> 'cancelled'`);
  const readRule = createLeagueScoringRuleReader(database);
  const schema = database.pragma("user_version", { simple: true });
  return Object.freeze({
    readWeek({ leagueId, seasonId, weekId }) {
      if (![leagueId, seasonId, weekId].every((id) => typeof id === "string" && CANONICAL_UUID_PATTERN.test(id))) {
        throw Object.assign(new Error("Invalid schedule scope."), { code: "ROSTER_SCHEDULE_INPUT_INVALID" });
      }
      return read.get({ leagueId, seasonId, weekId }) || null;
    },
    readPlayerPoints({ leagueId, seasonId, week, games }) {
      const points = new Map();
      const finals = games.filter(game => game.status === "final");
      if (!finals.length || schema < 30) return points;
      const season = week.nhl_season_key;
      const expandedSeason = usesExpandedScoring(season);
      const expandedRequired = expandedSeason && expandedScoringEnabled;
      const rule = expandedSeason ? readRule(leagueId, seasonId, week.sequence) : null;
      const owners = database.prepare(`SELECT o.player_id, o.position_group, i.external_value,
        (SELECT s.nhl_team_abbreviation FROM player_source_state s WHERE s.player_id=o.player_id AND s.ended_at_ms IS NULL
         ORDER BY (s.provider='sportsdataio-discovery-lab') DESC, s.effective_at_ms DESC, s.provider ASC, s.id DESC LIMIT 1) AS team
        FROM player_ownerships o JOIN player_external_ids i ON i.player_id=o.player_id AND i.provider='nhl'
        WHERE o.league_id=? AND o.season_id=?`).all(leagueId, seasonId);
      const byGameId = new Map(finals.map(game => [game.id, game]));
      const cache = schema >= 67 ? database.prepare(`SELECT nhl_game_id, expanded, entry_json FROM nhl_completed_game_cache
        WHERE nhl_season_key=? AND nhl_game_id IN (SELECT value FROM json_each(?))
          AND expanded BETWEEN ? AND ? ORDER BY expanded DESC`)
        .all(season, JSON.stringify([...byGameId.keys()]), Number(expandedRequired), Number(expandedSeason)) : [];
      for (const row of cache) {
        const game = byGameId.get(row.nhl_game_id);
        if (!game) continue;
        const expanded = Boolean(row.expanded);
        const entry = JSON.parse(row.entry_json);
        if (!matchesCompletedGame({ entry, game, season, expanded })) continue;
        const categories = new Map(entry.data.categories);
        const appearances = new Map(entry.data.rows.map(player => [String(player.playerId), player]));
        if (appearances.size !== entry.data.rows.length || appearances.size < 30 || appearances.size > 40 ||
            entry.data.rows.some(player => String(player.gameId) !== game.id || player.gamesPlayed !== 1 ||
              (expanded && !categories.has(`${game.id}:${player.playerId}`)))) continue;
        const scores = [];
        for (const owner of owners) {
          const appearance = appearances.get(owner.external_value);
          const team = { LA: "LAK", NJ: "NJD", SJ: "SJS", TB: "TBL", MON: "MTL" }[owner.team] || owner.team;
          if (!appearance && team !== game.homeTeam && team !== game.awayTeam) continue;
          let fantasyPointsHundredths = 0;
          if (appearance) {
            fantasyPointsHundredths = expanded
              ? calculateExpandedScore(categories.get(`${game.id}:${appearance.playerId}`), owner.position_group, rule).fantasyPointsHundredths
              : appearance.goals * 125 + appearance.assists * 100;
          }
          scores.push({ playerId: owner.player_id, fantasyPointsHundredths });
        }
        points.set(game.id, scores);
        byGameId.delete(game.id);
      }
      if (byGameId.size) {
        const observations = readObservedRosterGamePoints(database, { leagueId, seasonId, season, games: byGameId, rule,
          expandedRequired, schema });
        for (const { gameId, playerId, fantasyPointsHundredths } of observations) {
          if (!points.has(gameId)) points.set(gameId, []);
          points.get(gameId).push({ playerId, fantasyPointsHundredths });
        }
      }
      return points;
    },
  });
}

module.exports = { createSqliteRosterScheduleRepository };
