const {
  describeLiveSource,
} = require("../../../domain/matchups/matchupScoringPolicy");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const MATCHUP_INTEGRATION_CODES = Object.freeze({
  inputInvalid: "MATCHUP_INTEGRATION_INPUT_INVALID",
  seasonMissing: "MATCHUP_INTEGRATION_SEASON_MISSING",
  weekMissing: "MATCHUP_INTEGRATION_WEEK_MISSING",
  matchupMissing: "MATCHUP_INTEGRATION_MATCHUP_MISSING",
  resultMissing: "MATCHUP_INTEGRATION_RESULT_MISSING",
  versionConflict: "MATCHUP_INTEGRATION_VERSION_CONFLICT",
});

class MatchupIntegrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupIntegrationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupIntegrationError(code, message);
}

function exactObject(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(MATCHUP_INTEGRATION_CODES.inputInvalid, "A JSON object is required.");
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    fail(MATCHUP_INTEGRATION_CODES.inputInvalid, "The request contains an unsupported field.");
  }
  return value;
}

function confirmation(value) {
  if (value !== true && value !== false) {
    fail(MATCHUP_INTEGRATION_CODES.inputInvalid, "An explicit confirmation choice is required.");
  }
  return value;
}

function expectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(MATCHUP_INTEGRATION_CODES.inputInvalid, "A positive expected version is required.");
  }
  return value;
}

function operationId(value, createId) {
  const id = value || createId();
  if (!UUID_PATTERN.test(id || "")) {
    fail(MATCHUP_INTEGRATION_CODES.inputInvalid, "A canonical idempotency key is required.");
  }
  return id;
}

function projectMatchup(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    weekId: row.matchup_week_id,
    homeTeam: Object.freeze({ id: row.home_team_id, name: row.home_team_name }),
    awayTeam: Object.freeze({ id: row.away_team_id, name: row.away_team_name }),
    status: row.status,
    version: row.version,
  });
}

function projectBye(row) {
  return Object.freeze({
    id: row.id,
    team: Object.freeze({ id: row.team_id, name: row.team_display_name }),
  });
}

function projectWeek(row, matchups, byes) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    weekKey: row.week_key,
    sequence: row.sequence,
    startsAtMs: row.starts_at_ms,
    baselineAtMs: row.baseline_at_ms,
    locksAtMs: row.locks_at_ms,
    endsAtMs: row.ends_at_ms,
    rollsOverAtMs: row.rolls_over_at_ms,
    status: row.status,
    version: row.version,
    matchups: Object.freeze(matchups.map(projectMatchup)),
    byes: Object.freeze(byes.map(projectBye)),
  });
}

function projectResult(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    status: row.status,
    version: row.version,
    finalizedAtMs: row.finalized_at_ms,
    currentVersion: Object.freeze({
      id: row.result_version_id,
      versionNumber: row.version_number,
      homeTeamId: row.home_team_id,
      awayTeamId: row.away_team_id,
      homeScoreHundredths: row.home_score_hundredths,
      awayScoreHundredths: row.away_score_hundredths,
      outcome: row.outcome,
      sourceType: row.source_type,
      reason: row.reason,
      createdAtMs: row.result_version_created_at_ms,
    }),
  });
}

function createMatchupIntegrationService({
  leagueAuthorization,
  readRepository,
  scheduleService,
  weekService,
  scoringService,
  resultService,
  standingsService,
  recoveryService,
  clock,
  createId,
} = {}) {
  for (const method of ["requireActiveMembership", "requireCommissioner"]) {
    if (!leagueAuthorization || typeof leagueAuthorization[method] !== "function") {
      throw new TypeError("matchup integration requires league authorization");
    }
  }
  for (const method of ["readSchedule", "readWeek", "readMatchup", "readResultScope"]) {
    if (!readRepository || typeof readRepository[method] !== "function") {
      throw new TypeError("matchup integration requires a read repository");
    }
  }
  for (const method of ["readAtRefresh", "readLive"]) {
    if (!scoringService || typeof scoringService[method] !== "function") {
      throw new TypeError("matchup integration requires a scoring service");
    }
  }
  const dependencies = [
    [scheduleService, ["preview", "generate"], "schedule service"],
    [weekService, ["advance"], "week service"],
    [resultService, ["correct"], "result service"],
    [standingsService, ["read"], "standings service"],
    [recoveryService, ["previewStandings", "rebuildStandings"], "recovery service"],
  ];
  for (const [dependency, methods, description] of dependencies) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== "function")) {
      throw new TypeError(`matchup integration requires a ${description}`);
    }
  }
  if (!clock || typeof clock.nowMs !== "function" || typeof createId !== "function") {
    throw new TypeError("matchup integration requires clock and ID boundaries");
  }

  function member(input) {
    return leagueAuthorization.requireActiveMembership(
      input.authenticated,
      input.leagueId
    );
  }

  function commissioner(input) {
    return leagueAuthorization.requireCommissioner(
      input.authenticated,
      input.leagueId
    );
  }

  function sourceHealth(health) {
    if (!health?.latestSuccessful) {
      return Object.freeze({ status: "unavailable", completedAtMs: null, ageMs: null });
    }
    const source = describeLiveSource({
      nowMs: clock.nowMs(),
      completedAtMs: health.latestSuccessful.completed_at_ms,
    });
    const latestFailed =
      health.latest?.status === "failed" &&
      health.latest.started_at_ms > health.latestSuccessful.completed_at_ms;
    return Object.freeze({
      status: latestFailed ? "degraded" : source.freshnessStatus,
      completedAtMs: health.latestSuccessful.completed_at_ms,
      ageMs: source.ageMs,
    });
  }

  function requireSchedule(input) {
    const schedule = readRepository.readSchedule(input);
    if (!schedule) {
      fail(MATCHUP_INTEGRATION_CODES.seasonMissing, "The season was not found.");
    }
    return schedule;
  }

  function scheduleProjection(schedule) {
    const matchupsByWeek = new Map();
    const byesByWeek = new Map();
    for (const matchup of schedule.matchups) {
      const rows = matchupsByWeek.get(matchup.matchup_week_id) || [];
      rows.push(matchup);
      matchupsByWeek.set(matchup.matchup_week_id, rows);
    }
    for (const bye of schedule.byes) {
      const rows = byesByWeek.get(bye.matchup_week_id) || [];
      rows.push(bye);
      byesByWeek.set(bye.matchup_week_id, rows);
    }
    return Object.freeze(
      schedule.weeks.map((week) =>
        projectWeek(
          week,
          matchupsByWeek.get(week.id) || [],
          byesByWeek.get(week.id) || []
        )
      )
    );
  }

  function listWeeks(input) {
    member(input);
    const schedule = requireSchedule(input);
    return Object.freeze({
      code: "MATCHUP_WEEKS_FOUND",
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      health: Object.freeze({ statistics: sourceHealth(schedule.health) }),
      weeks: scheduleProjection(schedule),
    });
  }

  function readCurrentWeek(input) {
    const result = listWeeks(input);
    const nowMs = clock.nowMs();
    const current =
      result.weeks.find(
        (week) => week.startsAtMs <= nowMs && nowMs < week.rollsOverAtMs && week.status !== "cancelled"
      ) ||
      result.weeks.find(
        (week) => !["final", "cancelled"].includes(week.status)
      ) ||
      null;
    return Object.freeze({
      code: "CURRENT_MATCHUP_WEEK_FOUND",
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      health: result.health,
      week: current,
    });
  }

  function readWeek(input) {
    member(input);
    const context = readRepository.readWeek(input);
    if (!context) fail(MATCHUP_INTEGRATION_CODES.weekMissing, "The week was not found.");
    return Object.freeze({
      code: "MATCHUP_WEEK_FOUND",
      week: projectWeek(context.week, context.matchups, context.byes),
    });
  }

  function readMatchup(input) {
    member(input);
    const context = readRepository.readMatchup(input);
    if (!context) fail(MATCHUP_INTEGRATION_CODES.matchupMissing, "The matchup was not found.");
    let liveScore = null;
    let scoring = null;
    let scoreHealth = Object.freeze({ status: "not_live" });
    if (["live", "awaiting_data"].includes(context.matchup.status)) {
      try {
        liveScore = scoringService.readLive({
          leagueId: input.leagueId,
          seasonId: input.seasonId,
          weekId: input.weekId,
          matchupId: input.matchupId,
          provider: "nhl",
          nowMs: clock.nowMs(),
        });
        scoreHealth = Object.freeze({
          status: liveScore.source.freshnessStatus,
          completedAtMs: liveScore.source.completedAtMs,
          ageMs: liveScore.source.ageMs,
        });
        scoring = Object.freeze({
          mode: "live",
          home: liveScore.home,
          away: liveScore.away,
        });
      } catch (error) {
        if (!String(error?.code || "").startsWith("MATCHUP_SCORING_")) throw error;
        scoreHealth = Object.freeze({ status: "unavailable" });
      }
    } else if (
      context.matchup.status === "final" &&
      context.result?.result_source_refresh_id
    ) {
      try {
        const finalScore = scoringService.readAtRefresh({
          leagueId: input.leagueId,
          seasonId: input.seasonId,
          weekId: input.weekId,
          matchupId: input.matchupId,
          provider: "nhl",
          refreshId: context.result.result_source_refresh_id,
          nowMs: clock.nowMs(),
        });
        scoring = Object.freeze({
          mode: "final",
          home: finalScore.home,
          away: finalScore.away,
        });
      } catch (error) {
        if (!String(error?.code || "").startsWith("MATCHUP_SCORING_")) throw error;
        scoreHealth = Object.freeze({ status: "unavailable" });
      }
    }
    return Object.freeze({
      code: "MATCHUP_FOUND",
      matchup: Object.freeze({
        ...projectMatchup(context.matchup),
        week: Object.freeze({
          id: context.matchup.matchup_week_id,
          weekKey: context.matchup.week_key,
          sequence: context.matchup.sequence,
          startsAtMs: context.matchup.starts_at_ms,
          locksAtMs: context.matchup.locks_at_ms,
          endsAtMs: context.matchup.ends_at_ms,
          status: context.matchup.week_status,
          version: context.matchup.week_version,
        }),
        liveScore,
        scoring,
        result: projectResult(context.result),
        health: Object.freeze({ scoring: scoreHealth }),
      }),
    });
  }

  function readStandings(input) {
    member(input);
    const schedule = requireSchedule(input);
    const standings = standingsService.read({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
    });
    return Object.freeze({
      code: "MATCHUP_STANDINGS_FOUND",
      ...standings,
      health: Object.freeze({ statistics: sourceHealth(schedule.health) }),
    });
  }

  function generateSchedule(input) {
    const authority = commissioner(input);
    const body = exactObject(input.input, ["confirmed"]);
    const confirmed = confirmation(body.confirmed);
    const command = {
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      actorUserId: authority.actorUserId,
      nowMs: clock.nowMs(),
    };
    const preview = scheduleService.preview(command);
    const summary = Object.freeze({
      expectedVersion: preview.context.season_version,
      participantCount: preview.plan.teamIds.length,
      weekCount: preview.plan.weeks.length,
      matchupCount: preview.plan.weeks.reduce((sum, week) => sum + week.pairs.length, 0),
      byeCount: preview.plan.weeks.filter((week) => week.byeTeamId !== null).length,
      firstWeekStartsAtMs: preview.plan.firstWeekStartsAtMs,
      lastWeekEndsAtMs: preview.plan.weeks.at(-1)?.endsAtMs ?? null,
    });
    if (!confirmed) {
      return Object.freeze({ code: "MATCHUP_SCHEDULE_PREVIEWED", preview: summary });
    }
    if (expectedVersion(input.expectedVersion) !== summary.expectedVersion) {
      fail(MATCHUP_INTEGRATION_CODES.versionConflict, "The schedule preview is stale.");
    }
    return Object.freeze({
      code: "MATCHUP_SCHEDULE_GENERATED",
      result: scheduleService.generate(command),
    });
  }

  function transitionWeek(input) {
    const authority = commissioner(input);
    const body = exactObject(input.input, ["confirmed"]);
    const confirmed = confirmation(body.confirmed);
    const context = readRepository.readWeek(input);
    if (!context) fail(MATCHUP_INTEGRATION_CODES.weekMissing, "The week was not found.");
    const preview = Object.freeze({
      weekId: context.week.id,
      currentStatus: context.week.status,
      expectedVersion: context.week.version,
      effectiveAtMs: clock.nowMs(),
    });
    if (!confirmed) {
      return Object.freeze({ code: "MATCHUP_WEEK_TRANSITION_PREVIEWED", preview });
    }
    if (expectedVersion(input.expectedVersion) !== preview.expectedVersion) {
      fail(MATCHUP_INTEGRATION_CODES.versionConflict, "The week preview is stale.");
    }
    return Object.freeze({
      code: "MATCHUP_WEEK_TRANSITIONED",
      result: weekService.advance({
        leagueId: input.leagueId,
        seasonId: input.seasonId,
        weekId: input.weekId,
        actorUserId: authority.actorUserId,
        operationId: operationId(input.idempotencyKey, createId),
        nowMs: clock.nowMs(),
      }),
    });
  }

  function correctResult(input) {
    const authority = commissioner(input);
    const body = exactObject(input.input, [
      "confirmed",
      "homeScoreHundredths",
      "awayScoreHundredths",
      "reason",
    ]);
    const confirmed = confirmation(body.confirmed);
    const scope = readRepository.readResultScope(input);
    if (!scope) fail(MATCHUP_INTEGRATION_CODES.resultMissing, "The result was not found.");
    const preview = Object.freeze({
      resultId: scope.result_id,
      expectedVersion: scope.result_version,
      weekId: scope.week_id,
      matchupId: scope.matchup_id,
    });
    if (!confirmed) {
      if (Object.keys(body).length !== 1) {
        fail(MATCHUP_INTEGRATION_CODES.inputInvalid, "A correction preview accepts confirmation only.");
      }
      return Object.freeze({ code: "MATCHUP_RESULT_CORRECTION_PREVIEWED", preview });
    }
    if (expectedVersion(input.expectedVersion) !== preview.expectedVersion) {
      fail(MATCHUP_INTEGRATION_CODES.versionConflict, "The result preview is stale.");
    }
    return Object.freeze({
      code: "MATCHUP_RESULT_CORRECTED",
      result: resultService.correct({
        leagueId: input.leagueId,
        seasonId: input.seasonId,
        weekId: scope.week_id,
        matchupId: scope.matchup_id,
        actorUserId: authority.actorUserId,
        operationId: operationId(input.idempotencyKey, createId),
        expectedResultVersion: input.expectedVersion,
        homeScoreHundredths: body.homeScoreHundredths,
        awayScoreHundredths: body.awayScoreHundredths,
        reason: body.reason,
        nowMs: clock.nowMs(),
      }),
    });
  }

  function rebuildStandings(input) {
    const authority = commissioner(input);
    const body = exactObject(input.input, [
      "confirmed",
      "expectedCurrentSnapshotId",
      "reason",
    ]);
    const confirmed = confirmation(body.confirmed);
    const command = {
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      actorUserId: authority.actorUserId,
    };
    const preview = recoveryService.previewStandings(command);
    if (!confirmed) {
      if (Object.keys(body).length !== 1) {
        fail(MATCHUP_INTEGRATION_CODES.inputInvalid, "A rebuild preview accepts confirmation only.");
      }
      return Object.freeze({ code: "MATCHUP_STANDINGS_REBUILD_PREVIEWED", preview });
    }
    if (expectedVersion(input.expectedVersion) !== preview.expectedVersion) {
      fail(MATCHUP_INTEGRATION_CODES.versionConflict, "The standings preview is stale.");
    }
    return Object.freeze({
      code: "MATCHUP_STANDINGS_REBUILT",
      result: recoveryService.rebuildStandings({
        ...command,
        operationId: operationId(input.idempotencyKey, createId),
        expectedVersion: input.expectedVersion,
        expectedCurrentSnapshotId: body.expectedCurrentSnapshotId ?? null,
        reason: body.reason,
        confirmed: true,
        nowMs: clock.nowMs(),
      }),
    });
  }

  return Object.freeze({
    correctResult,
    generateSchedule,
    listWeeks,
    readCurrentWeek,
    readMatchup,
    readStandings,
    readWeek,
    rebuildStandings,
    transitionWeek,
  });
}

module.exports = {
  MATCHUP_INTEGRATION_CODES,
  MatchupIntegrationError,
  createMatchupIntegrationService,
};
