const { createMatchupScoringService } = require('./createMatchupScoringService');
const { calculateMatchupGameProgress } = require('../../../domain/matchups/matchupGameProgressPolicy');

function createMatchupGameProgressService({ leagueAuthorization, readRepository, scoringRepository, scheduleRepository, scheduleAdapter, statisticsProviders, clock, expandedScoringEnabled = false }) {
  return Object.freeze({
    async read(input) {
      leagueAuthorization.requireActiveMembership(input.authenticated, input.leagueId);
      const detail = readRepository.readMatchup(input);
      if (!detail) throw Object.assign(new Error('Matchup not found.'), { code: 'MATCHUP_INTEGRATION_MATCHUP_MISSING' });
      const matchup = detail.matchup;
      const scope = { leagueId: input.leagueId, seasonId: input.seasonId, weekId: input.weekId, matchupId: input.matchupId };
      const base = { code: 'MATCHUP_GAME_PROGRESS_FOUND', ...scope };
      const unavailable = status => ({ ...base, sourceRefreshId: null, home: { teamId: matchup.home_team_id, status, tallied: null, remaining: null, total: null }, away: { teamId: matchup.away_team_id, status, tallied: null, remaining: null, total: null } });
      if (!['live', 'awaiting_data', 'final'].includes(matchup.status)) return unavailable('not_started');
      const final = matchup.status === 'final';
      const refreshId = final ? detail.result?.result_source_refresh_id : undefined;
      if (final && !refreshId) return unavailable('scoring_unavailable');
      const scoreInput = { ...scope, providers: statisticsProviders, nowMs: clock.nowMs(), ...(final ? { refreshId } : {}) };
      let context, scoring;
      try {
        context = scoringRepository.readContext(scoreInput);
        // Reuse the canonical scorer and its sealed-evidence validation without rereading storage.
        const scorer = createMatchupScoringService({ repository: { readContext: () => context }, expandedScoringEnabled });
        scoring = final ? scorer.readAtRefresh(scoreInput) : scorer.readLive(scoreInput);
      } catch (error) {
        if (!String(error.code || '').startsWith('MATCHUP_SCORING_')) throw error;
        return unavailable('scoring_unavailable');
      }
      if (!expandedScoringEnabled || context.refresh.provider !== 'nhl-completed-games' || !context.expandedScoring) return unavailable('scoring_unavailable');
      let schedule = null;
      if (scoring.home.legal || scoring.away.legal) {
        try { schedule = await scheduleAdapter.readSchedule({ startsAtMs: context.matchup.week_starts_at_ms, endsAtMs: context.matchup.week_ends_at_ms, nhlSeasonKey: context.matchup.nhl_season_key }); }
        catch (error) { if (error.code !== 'NHL_SCHEDULE_UNAVAILABLE') throw error; }
      }
      const timeZone = scheduleRepository?.readWeek(scope)?.timezone;
      return { ...base, sourceRefreshId: context.refresh.id, ...calculateMatchupGameProgress({ context, scoring, schedule, timeZone, asOfMs: scoreInput.nowMs }) };
    },
  });
}

module.exports = { createMatchupGameProgressService };
