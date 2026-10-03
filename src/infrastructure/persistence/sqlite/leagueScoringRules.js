const {calculateExpandedScore, normalizeScoringWeights, EXPANDED_SCORING_VERSION} = require('../../../domain/statistics/expandedScoringPolicy');

function createLeagueScoringRuleReader(database, nowMs = Date.now) {
  const exists = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='league_scoring_rules'").get();
  const statement = exists ? database.prepare(`SELECT id,weights_json FROM league_scoring_rules
    WHERE league_id=@leagueId AND season_id=@seasonId AND effective_week_sequence<=@sequence
    ORDER BY effective_week_sequence DESC,revision DESC LIMIT 1`) : null;
  const current = exists ? database.prepare(`SELECT s.id AS seasonId,
    coalesce((SELECT max(w.sequence) FROM matchup_weeks w WHERE w.league_id=l.id AND w.season_id=s.id AND w.starts_at_ms<=@nowMs),1) AS sequence
    FROM leagues l JOIN seasons s ON s.league_id=l.id AND s.id=l.current_season_id
    WHERE l.id=@leagueId AND s.nhl_season_key='20262027'`) : null;
  return (leagueId, seasonId, sequence) => {
    if (!statement || !leagueId) return null;
    if (seasonId === undefined) {
      const context = current.get({leagueId, nowMs: nowMs()});
      if (!context) return null;
      ({seasonId, sequence} = context);
    }
    const row = statement.get({leagueId, seasonId, sequence});
    return row ? {version:'league-scoring-'+row.id, weights:normalizeScoringWeights(JSON.parse(row.weights_json))} : null;
  };
}

function withLeagueScoring(row, rule, prefix = '') {
  if (!rule || !row[`${prefix}scoring_stats_json`]) return row;
  const score = calculateExpandedScore(JSON.parse(row[`${prefix}scoring_stats_json`]), row.position_group || row.normalized_position, rule);
  return {...row, [`${prefix}fantasy_points_hundredths`]:score.fantasyPointsHundredths,
    [`${prefix}scoring_rule_version`]:score.scoringRuleVersion, [`${prefix}scoring_weights`]:score.scoringWeights};
}

function assertCurrentScoringRule(database, {leagueId, seasonId, weekId, scoringRuleVersion}) {
  if (scoringRuleVersion === undefined) {
    // Historical/non-expanded callers may omit the version only when no custom rule applies.
    scoringRuleVersion = EXPANDED_SCORING_VERSION;
  }
  const week = database.prepare('SELECT sequence FROM matchup_weeks WHERE league_id=? AND season_id=? AND id=?').get(leagueId,seasonId,weekId);
  const rule = week && createLeagueScoringRuleReader(database)(leagueId,seasonId,week.sequence);
  if ((rule?.version || EXPANDED_SCORING_VERSION) !== scoringRuleVersion) {
    const error = new Error('Scoring rules changed before the result could be saved. Retry with current scoring.');
    error.code = 'MATCHUP_SCORING_RULE_CHANGED'; throw error;
  }
}
module.exports = {createLeagueScoringRuleReader,withLeagueScoring,assertCurrentScoringRule};
