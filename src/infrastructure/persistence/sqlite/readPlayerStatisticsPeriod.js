const { assertPeriodSeason } = require('../../../domain/statistics/playerStatisticsPeriodPolicy');
const { emptyScoringStats, addScoringStats, normalizeScoringStats, CATEGORY_KEYS } = require('../../../domain/statistics/expandedScoringPolicy');
const { vancouverDate } = require('../../../daily/vancouverDate');

function unavailable() {
  throw Object.assign(new Error('Statistics for this period are unavailable until complete game data is collected.'), {
    code: 'PLAYER_PERIOD_UNAVAILABLE',
  });
}

function createPlayerStatisticsPeriodReader({ database, season, expanded }) {
  const cacheColumns = database.pragma('table_info(nhl_completed_game_cache)').map(column => column.name);
  const supported = season && ['nhl_season_key', 'nhl_game_id', 'expanded', 'checked_at_ms', 'entry_json'].every(column => cacheColumns.includes(column));
  if (!supported) return () => unavailable();
  // Older staging branches do not have the cache helper or table. Default
  // season reads still work there; only requested history is unavailable.
  const { matchesCompletedGame } = require('../../../domain/statistics/completedGameCachePolicy');
  const context = database.prepare(`SELECT l.timezone, s.nhl_season_key FROM leagues l
    JOIN seasons s ON s.id=l.current_season_id AND s.league_id=l.id WHERE l.id=?`);
  const latest = database.prepare(`SELECT r.id, r.player_count FROM stat_refreshes r JOIN stat_sources s ON s.id=r.stat_source_id
    WHERE s.provider='nhl-completed-games' AND r.nhl_season_key=? AND r.status='succeeded'
    ORDER BY r.completed_at_ms DESC,r.started_at_ms DESC,r.id DESC LIMIT 1`);
  const totals = database.prepare(`SELECT t.*, i.external_value AS external_id, e.stats_json
    FROM player_stat_totals t
    LEFT JOIN player_external_ids i ON i.player_id=t.player_id AND i.provider='nhl'
    LEFT JOIN expanded_stat_totals e ON e.total_id=t.id WHERE t.refresh_id=?`);
  const games = database.prepare(`SELECT nhl_game_id, checked_at_ms, entry_json FROM nhl_completed_game_cache
    WHERE nhl_season_key=? AND expanded=? ORDER BY nhl_game_id`);
  // Normal cache updates replace a game at a new provider capture timestamp.
  // A narrow revision avoids reparsing the season after unrelated league writes.
  const cacheRevision = database.prepare(`SELECT count(*) AS count, max(checked_at_ms) AS newest,
    coalesce(sum(checked_at_ms),0) AS checked_sum FROM nhl_completed_game_cache WHERE nhl_season_key=? AND expanded=?`);
  let revision = null, accepted = null;
  const projections = new Map();

  function readAccepted(refresh) {
    const official = totals.all(refresh.id);
    if (!official.length || official.length !== refresh.player_count) unavailable();
    const sourceAt = official[0].source_updated_at_ms;
    if (!Number.isSafeInteger(sourceAt) || official.some(row => row.source_updated_at_ms !== sourceAt)) unavailable();
    const byExternal = new Map();
    for (const row of official) {
      if (!row.external_id || byExternal.has(row.external_id)) unavailable();
      byExternal.set(row.external_id, { row, appearances: [], aggregate: { gamesPlayed: 0, goals: 0, assists: 0,
        scoringStats: emptyScoringStats() } });
    }
    for (const stored of games.all(season, Number(expanded))) {
      let entry, identity;
      try { entry = JSON.parse(stored.entry_json); identity = JSON.parse(entry.identity); } catch { unavailable(); }
      if (!Array.isArray(identity) || identity.length !== 4 || identity[0] !== stored.nhl_game_id ||
          !new RegExp(`^${season.slice(0, 4)}02\\d{4}$`).test(stored.nhl_game_id) ||
          !Number.isSafeInteger(identity[1]) || identity[1] > sourceAt ||
          entry.checkedAtMs !== stored.checked_at_ms || stored.checked_at_ms > sourceAt) unavailable();
      const game = { id: identity[0], startsAtMs: identity[1], homeTeamId: identity[2], awayTeamId: identity[3] };
      if (!matchesCompletedGame({ entry, game, season, expanded })) unavailable();
      const rows = entry.data.rows, categories = new Map(entry.data.categories), seen = new Set();
      if (rows.length < 30 || rows.length > 40 ||
          (expanded && (categories.size !== rows.length || entry.data.categories.length !== rows.length))) unavailable();
      for (const value of rows) {
        const externalId = String(value.playerId), categoryKey = `${game.id}:${externalId}`;
        if (seen.has(externalId) || String(value.gameId) !== game.id || value.gamesPlayed !== 1 ||
            !Number.isSafeInteger(value.goals) || value.goals < 0 || !Number.isSafeInteger(value.assists) || value.assists < 0 ||
            value.points !== value.goals + value.assists) unavailable();
        seen.add(externalId);
        let scoringStats;
        try { scoringStats = expanded ? normalizeScoringStats(categories.get(categoryKey)) : emptyScoringStats(); }
        catch { unavailable(); }
        if (expanded && (scoringStats.evenStrengthGoals + scoringStats.powerPlayGoals + scoringStats.shortHandedGoals !== value.goals ||
            scoringStats.primaryAssists + scoringStats.secondaryAssists !== value.assists)) unavailable();
        const player = byExternal.get(externalId);
        // Provider games can contain skaters not yet in the Hundo catalogue.
        if (!player) continue;
        player.appearances.push({ gameId: game.id, startsAtMs: game.startsAtMs, goals: value.goals, assists: value.assists, scoringStats });
        player.aggregate.gamesPlayed++;
        player.aggregate.goals += value.goals;
        player.aggregate.assists += value.assists;
        addScoringStats(player.aggregate.scoringStats, scoringStats);
      }
    }
    for (const { row, aggregate, appearances } of byExternal.values()) {
      if (row.games_played !== aggregate.gamesPlayed || row.goals !== aggregate.goals || row.assists !== aggregate.assists) unavailable();
      if (expanded) {
        let stats;
        try { stats = normalizeScoringStats(JSON.parse(row.stats_json)); } catch { unavailable(); }
        if (CATEGORY_KEYS.some(key => stats[key] !== aggregate.scoringStats[key])) unavailable();
      }
      appearances.sort((a, b) => b.startsAtMs - a.startsAtMs || b.gameId.localeCompare(a.gameId));
    }
    return { sourceAt, byExternal };
  }

  return ({ leagueId, period }) => {
    assertPeriodSeason(period, season);
    const league = context.get(leagueId);
    if (!league || league.nhl_season_key !== season) unavailable();
    const refresh = latest.get(season);
    if (!refresh) unavailable();
    const key = JSON.stringify([refresh.id, refresh.player_count, cacheRevision.get(season, Number(expanded))]);
    if (key !== revision) {
      accepted = readAccepted(refresh);
      revision = key;
      projections.clear();
    }
    const projectionKey = JSON.stringify([league.timezone, period]);
    if (projections.has(projectionKey)) return projections.get(projectionKey);
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: league.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dateOf = time => league.timezone === 'America/Vancouver' ? vancouverDate(time) : formatter.format(time);
    const records = {};
    for (const { row, appearances } of accepted.byExternal.values()) {
      const selected = period.mode === 'lastGames' ? appearances.slice(0, period.lastGames) :
        appearances.filter(game => { const date = dateOf(game.startsAtMs); return date >= period.startDate && date <= period.endDate; });
      const stats = { nhl_season_key: season, games_played: selected.length, goals: 0, assists: 0,
        nhl_points: 0, source_updated_at_ms: accepted.sourceAt, scoring_stats: expanded ? emptyScoringStats() : null };
      for (const game of selected) {
        stats.goals += game.goals;
        stats.assists += game.assists;
        if (expanded) addScoringStats(stats.scoring_stats, game.scoringStats);
      }
      stats.nhl_points = stats.goals + stats.assists;
      stats.fantasy_points_hundredths = stats.goals * 125 + stats.assists * 100;
      records[row.player_id] = stats;
    }
    const result = { json: JSON.stringify(records), metadata: Object.freeze({ ...period, timeZone: league.timezone }) };
    if (projections.size >= 8) projections.delete(projections.keys().next().value);
    projections.set(projectionKey, result);
    return result;
  };
}

module.exports = { createPlayerStatisticsPeriodReader };
