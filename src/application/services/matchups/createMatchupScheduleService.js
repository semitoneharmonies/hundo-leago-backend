const { randomUUID } = require("node:crypto");

const {
  planMatchupSchedule,
} = require("../../../domain/matchups/matchupSchedulePolicy");
const {
  buildMatchupOccurrenceKey,
} = require("../../../domain/matchups/matchupJobPolicy");

const MATCHUP_SCHEDULE_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_SCHEDULE_CONTEXT_MISSING",
  commissionerRequired: "MATCHUP_SCHEDULE_COMMISSIONER_REQUIRED",
  alreadyExists: "MATCHUP_SCHEDULE_ALREADY_EXISTS",
  seasonStarted: "MATCHUP_SCHEDULE_SEASON_STARTED",
  seasonInvalid: "MATCHUP_SCHEDULE_SEASON_INVALID",
});

class MatchupScheduleServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupScheduleServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupScheduleServiceError(code, message);
}

function createMatchupScheduleService({ repository, createId = randomUUID } = {}) {
  if (
    !repository ||
    typeof repository.readContext !== "function" ||
    typeof repository.persistSchedule !== "function"
  ) {
    throw new TypeError("createMatchupScheduleService requires a schedule repository");
  }
  if (typeof createId !== "function") {
    throw new TypeError("createMatchupScheduleService requires an ID factory");
  }

  function preview({ leagueId, seasonId, actorUserId, nowMs }) {
    const context = repository.readContext({ leagueId, seasonId });
    if (!context) fail(MATCHUP_SCHEDULE_SERVICE_CODES.contextMissing, "The season was not found.");
    if (context.commissioner_user_id !== actorUserId) {
      fail(MATCHUP_SCHEDULE_SERVICE_CODES.commissionerRequired, "Commissioner authority is required.");
    }
    if (!["planned", "active"].includes(context.season_status)) {
      fail(MATCHUP_SCHEDULE_SERVICE_CODES.seasonInvalid, "The season cannot receive a schedule.");
    }
    if (context.existingWeekCount !== 0) {
      fail(MATCHUP_SCHEDULE_SERVICE_CODES.alreadyExists, "The season schedule already exists.");
    }
    const plan = planMatchupSchedule({
      teamIds: context.teams.map(({ id }) => id),
      nhlRegularSeasonStartsAtMs: context.regular_season_starts_at_ms,
      fantasyPlayoffsStartAtMs: context.fantasy_playoffs_start_at_ms,
      timeZone: context.timezone,
    });
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= plan.firstWeekStartsAtMs) {
      fail(MATCHUP_SCHEDULE_SERVICE_CODES.seasonStarted, "Week 1 has already started.");
    }
    return Object.freeze({ context, plan });
  }

  function generate(input) {
    const { context, plan } = preview(input);
    const teamById = new Map(context.teams.map((team) => [team.id, team]));
    const weeks = plan.weeks.map((week) => {
      const weekId = createId();
      const occurrence = (jobType, scheduledForMs) => Object.freeze({
        runId: createId(),
        leagueId: context.league_id,
        seasonId: context.season_id,
        jobType,
        occurrenceKey: buildMatchupOccurrenceKey({
          jobType,
          leagueId: context.league_id,
          seasonId: context.season_id,
          weekId,
          scheduledForMs,
        }),
        scheduledForMs,
        nowMs: input.nowMs,
      });
      return Object.freeze({
        id: weekId,
        leagueId: context.league_id,
        seasonId: context.season_id,
        weekKey: week.weekKey,
        sequence: week.sequence,
        startsAtMs: week.startsAtMs,
        baselineAtMs: week.baselineAtMs,
        locksAtMs: week.locksAtMs,
        endsAtMs: week.endsAtMs,
        rollsOverAtMs: week.rollsOverAtMs,
        nowMs: input.nowMs,
        occurrences: Object.freeze([
          occurrence("matchup:statistics_refresh", week.startsAtMs),
          occurrence("matchup:baseline", week.baselineAtMs),
          occurrence("matchup:lock", week.locksAtMs),
          occurrence("matchup:statistics_refresh", week.endsAtMs),
          occurrence("matchup:finalize", week.endsAtMs),
          occurrence("matchup:rollover", week.rollsOverAtMs),
        ]),
        matchups: Object.freeze(week.pairs.map((pair) => Object.freeze({
          id: createId(),
          leagueId: context.league_id,
          seasonId: context.season_id,
          weekId,
          homeTeamId: pair.homeTeamId,
          awayTeamId: pair.awayTeamId,
          homeTeamName: teamById.get(pair.homeTeamId).name,
          awayTeamName: teamById.get(pair.awayTeamId).name,
          nowMs: input.nowMs,
        }))),
        bye: week.byeTeamId === null ? null : Object.freeze({
          id: createId(),
          leagueId: context.league_id,
          seasonId: context.season_id,
          weekId,
          teamId: week.byeTeamId,
          teamDisplayName: teamById.get(week.byeTeamId).name,
          nowMs: input.nowMs,
        }),
      });
    });
    return repository.persistSchedule({
      leagueId: context.league_id,
      seasonId: context.season_id,
      actorUserId: input.actorUserId,
      expectedSeasonVersion: context.season_version,
      teamCount: plan.teamIds.length,
      weeks: Object.freeze(weeks),
      operationId: createId(),
      nowMs: input.nowMs,
    });
  }

  return Object.freeze({ preview, generate });
}

module.exports = {
  MATCHUP_SCHEDULE_SERVICE_CODES,
  MatchupScheduleServiceError,
  createMatchupScheduleService,
};
