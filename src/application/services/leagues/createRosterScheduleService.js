function createRosterScheduleService({ leagueAuthorization, repository, scheduleAdapter }) {
  return Object.freeze({
    async readWeek(input) {
      leagueAuthorization.requireActiveMembership(input.authenticated, input.leagueId);
      const week = repository.readWeek(input);
      if (!week) throw Object.assign(new Error("The matchup week was not found."), { code: "ROSTER_SCHEDULE_WEEK_MISSING" });
      const schedule = await scheduleAdapter.readSchedule({
        startsAtMs: week.starts_at_ms, endsAtMs: week.ends_at_ms, nhlSeasonKey: week.nhl_season_key,
      });
      const points = repository.readPlayerPoints({ leagueId: input.leagueId, seasonId: input.seasonId, week, games: schedule.games });
      return Object.freeze({
        code: "ROSTER_SCHEDULE_FOUND", leagueId: input.leagueId, seasonId: input.seasonId, weekId: input.weekId,
        startsAtMs: week.starts_at_ms, endsAtMs: week.ends_at_ms, timeZone: week.timezone,
        ...schedule,
        games: schedule.games.map(game => game.status === "final"
          ? { ...game, playerPoints: points.get(game.id) || [] } : game),
      });
    },
  });
}

module.exports = { createRosterScheduleService };
