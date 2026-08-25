const {
  MatchupSchedulePolicyError,
  planExplicitMatchupSchedule,
  planMatchupWeekOneShift,
} = require("../../../domain/matchups/matchupSchedulePolicy");
const {
  buildMatchupOccurrenceKey,
  parseMatchupOccurrenceKey,
} = require("../../../domain/matchups/matchupJobPolicy");
const {
  MATCHUP_SCHEDULE_COMMAND_CODE,
  MATCHUP_SCHEDULE_COMMAND_HTTP_STATUS,
  MATCHUP_SCHEDULE_COMMAND_OPERATION,
  MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE,
  MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
  MATCHUP_SCHEDULE_IDEMPOTENCY_LIFETIME_MS,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
  MatchupScheduleCommandPolicyError,
  UUID_PATTERN,
  hashMatchupScheduleCommandRequest,
  hashMatchupScheduleCommandResponse,
  hashMatchupScheduleShiftWeekOneRequest,
  hashMatchupScheduleShiftWeekOneResponse,
  validateMatchupScheduleCommandExpectedVersion,
  validateMatchupScheduleCommandIdempotencyKey,
  validateMatchupScheduleCommandLeagueId,
  validateMatchupScheduleCommandSeasonId,
  validateMatchupScheduleConfirmedInput,
  validateMatchupScheduleShiftExpectedWeekVersion,
  validateMatchupScheduleShiftWeekOneInput,
  validateMatchupScheduleShiftWeekOneResult,
  validateMatchupScheduleShiftWeekOneWeekId,
} = require(
  "../../../domain/matchups/matchupScheduleCommandPolicy"
);

const MATCHUP_SCHEDULE_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_SCHEDULE_CONTEXT_MISSING",
  commissionerRequired:
    "MATCHUP_SCHEDULE_COMMISSIONER_REQUIRED",
  alreadyExists: "MATCHUP_SCHEDULE_ALREADY_EXISTS",
  calendarConflict:
    "MATCHUP_SCHEDULE_CALENDAR_CONFLICT",
  seasonStarted: "MATCHUP_SCHEDULE_SEASON_STARTED",
  seasonInvalid: "MATCHUP_SCHEDULE_SEASON_INVALID",
  preconditionFailed:
    "MATCHUP_SCHEDULE_PRECONDITION_FAILED",
  resultUnavailable:
    "MATCHUP_SCHEDULE_RESULT_UNAVAILABLE",
  weekMissing: "MATCHUP_SCHEDULE_WEEK_MISSING",
  weekInvalid: "MATCHUP_SCHEDULE_WEEK_INVALID",
  fadWeekOneFrozen: "FAD_WEEK_ONE_FROZEN",
});

const REQUIRED_REPOSITORY_METHODS = Object.freeze([
  "applyConfirmedSchedulePlan",
  "applyWeekOneShiftPlan",
  "findCommandResult",
  "findIdempotency",
  "readContext",
  "readShiftContext",
]);

class MatchupScheduleServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupScheduleServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupScheduleServiceError(
    code,
    message
  );
}

function requireMethod(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `createMatchupScheduleService requires ${description}`
    );
  }
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function incrementableVersion(value) {
  return (
    safeVersion(value) &&
    value < Number.MAX_SAFE_INTEGER
  );
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!safeTimestamp(nowMs)) {
    throw new TypeError(
      "createMatchupScheduleService requires a safe clock"
    );
  }
  return nowMs;
}

function safeIdempotencyExpiry(nowMs) {
  if (
    nowMs >
    Number.MAX_SAFE_INTEGER -
      MATCHUP_SCHEDULE_IDEMPOTENCY_LIFETIME_MS
  ) {
    throw new TypeError(
      "The matchup schedule idempotency expiry is unsafe."
    );
  }
  return (
    nowMs +
    MATCHUP_SCHEDULE_IDEMPOTENCY_LIFETIME_MS
  );
}

function secureId(secureRandom) {
  const id = secureRandom.id();
  if (
    typeof id !== "string" ||
    !UUID_PATTERN.test(id)
  ) {
    throw new TypeError(
      "createMatchupScheduleService requires canonical secure identifiers"
    );
  }
  return id;
}

function safeAuthority(value, leagueId) {
  if (
    !value ||
    typeof value !== "object" ||
    value.leagueId !== leagueId ||
    typeof value.actorUserId !== "string" ||
    !UUID_PATTERN.test(value.actorUserId) ||
    typeof value.membershipId !== "string" ||
    !UUID_PATTERN.test(value.membershipId) ||
    ![
      "commissioner",
      "platform_administrator",
      "platform_administrator_as_commissioner",
    ].includes(value.authority)
  ) {
    throw new TypeError(
      "The matchup schedule command requires canonical league authority."
    );
  }
  return Object.freeze({
    actorUserId: value.actorUserId,
    membershipId: value.membershipId,
    authority:
      value.authority === "commissioner"
        ? "commissioner"
        : "platform_administrator_as_commissioner",
  });
}

function calendarState(context, plan) {
  const persisted = [
    context.regular_season_starts_at_ms,
    context.regular_season_ends_at_ms,
    context.fantasy_playoffs_start_at_ms,
    context.fantasy_playoffs_end_at_ms,
  ];
  const supplied = [
    plan.nhlRegularSeasonStartsAtMs,
    plan.nhlRegularSeasonEndsAtMs,
    plan.fantasyPlayoffsStartAtMs,
    plan.fantasyPlayoffsEndAtMs,
  ];
  const allNull = persisted.every(
    (value) => value === null
  );
  const exactEqual = persisted.every(
    (value, index) => value === supplied[index]
  );
  if (!allNull && !exactEqual) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES
        .calendarConflict,
      "The supplied calendar conflicts with the persisted season calendar."
    );
  }
  return Object.freeze({
    calendarWillBePersisted: allNull,
  });
}

function inspectContext({
  context,
  input,
  actorUserId,
  authorizedAsPlatformAdministrator,
  nowMs,
  requireDirectAuthority,
} = {}) {
  if (!context) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES
        .contextMissing,
      "The season was not found."
    );
  }
  if (
    requireDirectAuthority === true &&
    context.commissioner_user_id !==
      actorUserId &&
    authorizedAsPlatformAdministrator !== true
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES
        .commissionerRequired,
      "Commissioner authority is required."
    );
  }
  if (
    !["planned", "active"].includes(
      context.season_status
    )
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES
        .seasonInvalid,
      "The season cannot receive a schedule."
    );
  }
  if (
    context.existingWeekCount !== 0 ||
    (context.existingGenerationCount ?? 0) !== 0
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES
        .alreadyExists,
      "The season schedule already exists."
    );
  }
  const plan = planExplicitMatchupSchedule({
    teamIds: context.teams.map(({ id }) => id),
    nhlSeasonKey: context.nhl_season_key,
    nhlRegularSeasonStartsAtMs:
      input.nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs:
      input.nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs:
      input.fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs:
      input.fantasyPlayoffsEndAtMs,
    firstWeekStartsAtMs:
      input.firstWeekStartsAtMs,
    timeZone: context.timezone,
    nowMs,
  });
  return Object.freeze({
    ...calendarState(context, plan),
    context,
    plan,
  });
}

function commandResultFromRow(row) {
  if (
    !row ||
    typeof row !== "object" ||
    row.action !== "generate" ||
    row.idempotencyOperation !==
      MATCHUP_SCHEDULE_COMMAND_OPERATION ||
    row.newScheduleOperationId !==
      row.matchupOperationId ||
    row.newScheduleVersion !== 1 ||
    row.oldScheduleOperationId !== null ||
    row.oldScheduleVersion !== null ||
    row.weekVersionBefore !== null ||
    row.weekVersionAfter !== 1 ||
    row.previousFirstWeekStartsAtMs !==
      null ||
    row.responseHttpStatus !==
      MATCHUP_SCHEDULE_COMMAND_HTTP_STATUS ||
    row.responseCode !==
      MATCHUP_SCHEDULE_COMMAND_CODE ||
    row.resultSchemaVersion !==
      MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION ||
    row.version !== 1 ||
    !safeVersion(row.seasonVersionBefore) ||
    row.seasonVersionAfter !==
      row.seasonVersionBefore + 1 ||
    ![
      row.matchupOperationId,
      row.seasonId,
      row.weekOneMatchupWeekId,
    ].every(
      (id) =>
        typeof id === "string" &&
        UUID_PATTERN.test(id)
    ) ||
    ![
      row.nhlRegularSeasonStartsAtMs,
      row.nhlRegularSeasonEndsAtMs,
      row.fantasyPlayoffsStartAtMs,
      row.fantasyPlayoffsEndAtMs,
      row.firstWeekStartsAtMs,
      row.lastWeekEndsAtMs,
    ].every(safeTimestamp) ||
    ![0, 1].includes(row.calendarPersisted) ||
    !Number.isSafeInteger(row.participantCount) ||
    row.participantCount < 2 ||
    !Number.isSafeInteger(row.weekCount) ||
    row.weekCount < 1 ||
    !Number.isSafeInteger(row.matchupCount) ||
    row.matchupCount < 1 ||
    !Number.isSafeInteger(row.byeCount) ||
    row.byeCount < 0
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES
        .resultUnavailable,
      "The durable matchup schedule result is unavailable."
    );
  }
  return Object.freeze({
    operationId: row.matchupOperationId,
    seasonId: row.seasonId,
    seasonVersion: row.seasonVersionAfter,
    nhlRegularSeasonStartsAtMs:
      row.nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs:
      row.nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs:
      row.fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs:
      row.fantasyPlayoffsEndAtMs,
    calendarPersisted:
      row.calendarPersisted === 1,
    firstWeekId:
      row.weekOneMatchupWeekId,
    firstWeekStartsAtMs:
      row.firstWeekStartsAtMs,
    participantCount: row.participantCount,
    weekCount: row.weekCount,
    matchupCount: row.matchupCount,
    byeCount: row.byeCount,
    lastWeekEndsAtMs: row.lastWeekEndsAtMs,
  });
}

function shiftResultFromRow(row) {
  if (
    !row ||
    typeof row !== "object" ||
    row.action !== "shift_week_one" ||
    row.idempotencyOperation !==
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION ||
    row.newScheduleOperationId !==
      row.matchupOperationId ||
    row.oldScheduleOperationId ===
      row.newScheduleOperationId ||
    !incrementableVersion(
      row.oldScheduleVersion
    ) ||
    row.newScheduleVersion !==
      row.oldScheduleVersion + 1 ||
    !incrementableVersion(
      row.seasonVersionBefore
    ) ||
    row.seasonVersionAfter !==
      row.seasonVersionBefore + 1 ||
    !incrementableVersion(
      row.weekVersionBefore
    ) ||
    row.weekVersionAfter !==
      row.weekVersionBefore + 1 ||
    ![
      row.matchupOperationId,
      row.oldScheduleOperationId,
      row.seasonId,
      row.weekOneMatchupWeekId,
    ].every(
      (id) =>
        typeof id === "string" &&
        UUID_PATTERN.test(id)
    ) ||
    row.previousFirstWeekStartsAtMs ===
      null ||
    row.responseHttpStatus !== 200 ||
    row.responseCode !== null ||
    row.resultSchemaVersion !==
      MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION ||
    row.version !== 1 ||
    row.nhlRegularSeasonStartsAtMs !== null ||
    row.nhlRegularSeasonEndsAtMs !== null ||
    row.fantasyPlayoffsStartAtMs !== null ||
    row.fantasyPlayoffsEndAtMs !== null ||
    row.calendarPersisted !== null ||
    row.participantCount !== null ||
    row.weekCount !== null ||
    row.matchupCount !== null ||
    row.byeCount !== null
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES
        .resultUnavailable,
      "The durable Week 1 shift result is unavailable."
    );
  }
  try {
    return validateMatchupScheduleShiftWeekOneResult({
      operationId: row.matchupOperationId,
      seasonId: row.seasonId,
      seasonVersion: row.seasonVersionAfter,
      weekId: row.weekOneMatchupWeekId,
      weekVersion: row.weekVersionAfter,
      previousFirstWeekStartsAtMs:
        row.previousFirstWeekStartsAtMs,
      firstWeekStartsAtMs:
        row.firstWeekStartsAtMs,
      lastWeekEndsAtMs:
        row.lastWeekEndsAtMs,
      shiftedWeekCount:
        row.shiftedWeekCount,
      replacedJobOccurrenceCount:
        row.replacedJobOccurrenceCount,
    });
  } catch (error) {
    if (
      error instanceof
      MatchupScheduleCommandPolicyError
    ) {
      fail(
        MATCHUP_SCHEDULE_SERVICE_CODES
          .resultUnavailable,
        "The durable Week 1 shift result is unavailable."
      );
    }
    throw error;
  }
}

function inspectReplay({
  idempotency,
  actorUserId,
  clientKey,
  leagueId,
  operation = MATCHUP_SCHEDULE_COMMAND_OPERATION,
  requestHash,
} = {}) {
  if (
    !idempotency ||
    typeof idempotency !== "object" ||
    idempotency.leagueId !== leagueId ||
    idempotency.actorUserId !== actorUserId ||
    idempotency.operation !== operation ||
    idempotency.clientKey !== clientKey ||
    typeof idempotency.requestHash !==
      "string"
  ) {
    fail(
      "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      "The matchup schedule idempotency request is unavailable."
    );
  }
  if (idempotency.requestHash !== requestHash) {
    fail(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was reused with a different request."
    );
  }
  if (
    idempotency.status !== "completed" ||
    idempotency.resultType !==
      MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE ||
    typeof idempotency.resultId !== "string" ||
    !UUID_PATTERN.test(idempotency.resultId) ||
    !safeTimestamp(idempotency.completedAtMs)
  ) {
    fail(
      "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      "The matchup schedule idempotency result is unavailable."
    );
  }
  return idempotency.resultId;
}

function occurrenceSpecifications(week) {
  return Object.freeze([
    Object.freeze({
      slot: "statistics_refresh_start",
      jobType: "matchup:statistics_refresh",
      scheduledForMs: week.startsAtMs,
    }),
    Object.freeze({
      slot: "baseline",
      jobType: "matchup:baseline",
      scheduledForMs: week.baselineAtMs,
    }),
    Object.freeze({
      slot: "lock",
      jobType: "matchup:lock",
      scheduledForMs: week.locksAtMs,
    }),
    Object.freeze({
      slot: "statistics_refresh_end",
      jobType: "matchup:statistics_refresh",
      scheduledForMs: week.endsAtMs,
    }),
    Object.freeze({
      slot: "finalize",
      jobType: "matchup:finalize",
      scheduledForMs: week.endsAtMs,
    }),
    Object.freeze({
      slot: "rollover",
      jobType: "matchup:rollover",
      scheduledForMs: week.rollsOverAtMs,
    }),
  ]);
}

function sameStableIds(left, right) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every(
      (value, index) =>
        value === sortedRight[index]
    )
  );
}

function inspectShiftJobs({
  context,
  generation,
} = {}) {
  const expected = new Map();
  for (const week of context.weeks) {
    for (const occurrence of
      occurrenceSpecifications(week)) {
      expected.set(
        `${week.id}\u0000${occurrence.slot}`,
        occurrence
      );
    }
  }
  if (
    !Array.isArray(context.jobs) ||
    context.jobs.length !== expected.size
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
      "The current schedule generation has incomplete job bindings."
    );
  }

  const found = new Map();
  for (const job of context.jobs) {
    if (!job || typeof job !== "object") {
      fail(
        MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
        "A current schedule job is invalid."
      );
    }
    const week = context.weeks.find(
      ({ id }) => id === job.weekId
    );
    const candidates = week
      ? occurrenceSpecifications(week).filter(
          (occurrence) =>
            occurrence.jobType === job.jobType &&
            occurrence.scheduledForMs ===
              job.scheduledForMs
        )
      : [];
    if (candidates.length !== 1) {
      fail(
        MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
        "A current schedule job does not match one canonical occurrence."
      );
    }
    const occurrence = candidates[0];
    const key = `${job.weekId}\u0000${occurrence.slot}`;
    let parsedOccurrenceKey;
    try {
      parsedOccurrenceKey =
        parseMatchupOccurrenceKey({
          jobType: job.jobType,
          leagueId: context.leagueId,
          seasonId: context.seasonId,
          occurrenceKey: job.occurrenceKey,
          scheduledForMs:
            job.scheduledForMs,
        });
    } catch {
      fail(
        MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
        "A current schedule job occurrence key is invalid."
      );
    }
    const occurrenceGenerationMatches =
      parsedOccurrenceKey.weekId ===
        job.weekId &&
      (
        (
          parsedOccurrenceKey
            .scheduleOperationId === null &&
          parsedOccurrenceKey
            .scheduleVersion === null
        ) ||
        (
          parsedOccurrenceKey
            .scheduleOperationId ===
            generation.scheduleOperationId &&
          parsedOccurrenceKey
            .scheduleVersion ===
            generation.scheduleVersion
        )
      );
    if (
      found.has(key) ||
      !UUID_PATTERN.test(job.id || "") ||
      !UUID_PATTERN.test(job.bindingId || "") ||
      job.leagueId !== context.leagueId ||
      job.seasonId !== context.seasonId ||
      job.bindingJobType !== job.jobType ||
      job.bindingScheduleOperationId !==
        generation.scheduleOperationId ||
      job.bindingScheduleVersion !==
        generation.scheduleVersion ||
      job.bindingOwningMatchupWeekId !==
        job.weekId ||
      job.bindingOwningMatchupId !== null ||
      job.bindingCreatedAtMs !==
        job.createdAtMs ||
      job.bindingVersion !== 1 ||
      job.status !== "pending" ||
      job.attemptCount !== 0 ||
      job.leaseOwner !== null ||
      job.leaseToken !== null ||
      job.leaseExpiresAtMs !== null ||
      job.startedAtMs !== null ||
      job.completedAtMs !== null ||
      job.resultJson !== null ||
      job.lastErrorCode !== null ||
      job.nextAttemptAtMs !==
        job.scheduledForMs ||
      job.updatedAtMs !== job.createdAtMs ||
      !incrementableVersion(job.version) ||
      !occurrenceGenerationMatches
    ) {
      fail(
        MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
        "A current schedule job is not safely replaceable."
      );
    }
    found.set(
      key,
      Object.freeze({
        ...job,
        slot: occurrence.slot,
      })
    );
  }
  if (
    [...expected.keys()].some(
      (key) => !found.has(key)
    )
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
      "The current schedule generation has incomplete job occurrences."
    );
  }
  return found;
}

function inspectShiftContext({
  context,
  leagueId,
  seasonId,
  weekId,
  input,
  nowMs,
} = {}) {
  if (
    !context ||
    context.leagueId !== leagueId ||
    context.seasonId !== seasonId
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.contextMissing,
      "The matchup schedule shift context was not found."
    );
  }
  if (context.fadCount > 0) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES
        .fadWeekOneFrozen,
      "Week 1 is frozen after Candidate Card opening."
    );
  }
  if (context.unboundJobCount !== 0) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
      "The matchup schedule contains unbound job occurrences."
    );
  }
  if (
    !["planned", "active"].includes(
      context.seasonStatus
    ) ||
    !incrementableVersion(
      context.seasonVersion
    )
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.seasonInvalid,
      "The season cannot receive a Week 1 shift."
    );
  }
  const generation = context.currentGeneration;
  if (
    context.currentGenerationCount !== 1 ||
    !generation ||
    generation.leagueId !== leagueId ||
    generation.seasonId !== seasonId ||
    generation.status !== "current" ||
    generation.supersededAtMs !== null ||
    generation.version !== 1 ||
    !UUID_PATTERN.test(
      generation.scheduleOperationId || ""
    ) ||
    !incrementableVersion(
      generation.scheduleVersion
    ) ||
    !Array.isArray(context.weeks) ||
    context.weeks.length < 1
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
      "The current matchup schedule generation is invalid."
    );
  }
  const targetWeek = context.weeks.find(
    ({ id }) => id === weekId
  );
  if (!targetWeek) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekMissing,
      "The matchup week was not found."
    );
  }
  if (
    targetWeek.sequence !== 1 ||
    generation.weekOneMatchupWeekId !==
      targetWeek.id ||
    generation.weekOneStartsAtMs !==
      targetWeek.startsAtMs
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
      "Only the current Week 1 may be shifted."
    );
  }
  if (targetWeek.startsAtMs <= nowMs) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
      "The persisted Week 1 has already started."
    );
  }
  const persistedWeekIds = new Set();
  let persistedParticipantSignature = null;
  for (
    let weekIndex = 0;
    weekIndex < context.weeks.length;
    weekIndex += 1
  ) {
    const week = context.weeks[weekIndex];
    const matchupIds = new Set();
    const participantIds = new Set();
    const malformedMatchup =
      !Array.isArray(week.matchups) ||
      week.matchups.length < 1 ||
      week.matchups.some((matchup) => {
        const malformed =
          !UUID_PATTERN.test(matchup.id || "") ||
          !UUID_PATTERN.test(
            matchup.homeTeamId || ""
          ) ||
          !UUID_PATTERN.test(
            matchup.awayTeamId || ""
          ) ||
          matchup.status !== "scheduled" ||
          matchup.leagueId !== leagueId ||
          matchup.seasonId !== seasonId ||
          matchup.weekId !== week.id ||
          !incrementableVersion(
            matchup.version
          ) ||
          matchup.homeTeamId ===
            matchup.awayTeamId ||
          matchupIds.has(matchup.id) ||
          participantIds.has(
            matchup.homeTeamId
          ) ||
          participantIds.has(
            matchup.awayTeamId
          );
        matchupIds.add(matchup.id);
        participantIds.add(
          matchup.homeTeamId
        );
        participantIds.add(
          matchup.awayTeamId
        );
        return malformed;
      });
    const malformedBye =
      week.bye !== null &&
      (
        !UUID_PATTERN.test(week.bye.id || "") ||
        !UUID_PATTERN.test(
          week.bye.teamId || ""
        ) ||
        week.bye.leagueId !== leagueId ||
        week.bye.seasonId !== seasonId ||
        week.bye.weekId !== week.id ||
        participantIds.has(week.bye.teamId)
      );
    if (week.bye !== null) {
      participantIds.add(week.bye.teamId);
    }
    const participantSignature = [
      ...participantIds,
    ]
      .sort()
      .join("|");
    if (
      !UUID_PATTERN.test(week.id || "") ||
      persistedWeekIds.has(week.id) ||
      week.leagueId !== leagueId ||
      week.seasonId !== seasonId ||
      week.sequence !== weekIndex + 1 ||
      week.weekKey !==
        `regular-${String(
          weekIndex + 1
        ).padStart(2, "0")}` ||
      week.status !== "scheduled" ||
      !incrementableVersion(week.version) ||
      malformedMatchup ||
      malformedBye ||
      (
        persistedParticipantSignature !==
          null &&
        participantSignature !==
          persistedParticipantSignature
      )
    ) {
      fail(
        MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
        "Every shifted matchup week must remain editable."
      );
    }
    persistedWeekIds.add(week.id);
    persistedParticipantSignature =
      participantSignature;
  }

  let persistedSchedule;
  try {
    persistedSchedule =
      planExplicitMatchupSchedule({
        teamIds: [
          ...targetWeek.matchups.flatMap(
            ({ homeTeamId, awayTeamId }) => [
              homeTeamId,
              awayTeamId,
            ]
          ),
          ...(targetWeek.bye === null
            ? []
            : [targetWeek.bye.teamId]),
        ],
        nhlSeasonKey: context.nhlSeasonKey,
        nhlRegularSeasonStartsAtMs:
          context.nhlRegularSeasonStartsAtMs,
        nhlRegularSeasonEndsAtMs:
          context.nhlRegularSeasonEndsAtMs,
        fantasyPlayoffsStartAtMs:
          context.fantasyPlayoffsStartAtMs,
        fantasyPlayoffsEndAtMs:
          context.fantasyPlayoffsEndAtMs,
        firstWeekStartsAtMs:
          targetWeek.startsAtMs,
        timeZone: context.timeZone,
        nowMs: targetWeek.startsAtMs - 1,
      });
  } catch (error) {
    if (
      error instanceof MatchupSchedulePolicyError
    ) {
      fail(
        MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
        "The persisted matchup schedule calendar is invalid."
      );
    }
    throw error;
  }
  if (
    persistedSchedule.weeks.length <
      context.weeks.length ||
    persistedSchedule.weeks
      .slice(0, context.weeks.length)
      .some(
      (plannedWeek, index) => {
        const persistedWeek =
          context.weeks[index];
        return (
          !persistedWeek ||
          plannedWeek.weekKey !==
            persistedWeek.weekKey ||
          plannedWeek.sequence !==
            persistedWeek.sequence ||
          plannedWeek.startsAtMs !==
            persistedWeek.startsAtMs ||
          plannedWeek.baselineAtMs !==
            persistedWeek.baselineAtMs ||
          plannedWeek.locksAtMs !==
            persistedWeek.locksAtMs ||
          plannedWeek.endsAtMs !==
            persistedWeek.endsAtMs ||
          plannedWeek.rollsOverAtMs !==
            persistedWeek.rollsOverAtMs
        );
      }
    )
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
      "The persisted matchup schedule no longer matches its calendar."
    );
  }

  const schedulePlan = planMatchupWeekOneShift({
    weeks: context.weeks.map((week) => ({
      id: week.id,
      weekKey: week.weekKey,
      sequence: week.sequence,
      startsAtMs: week.startsAtMs,
      baselineAtMs: week.baselineAtMs,
      locksAtMs: week.locksAtMs,
      endsAtMs: week.endsAtMs,
      rollsOverAtMs: week.rollsOverAtMs,
      pairs: week.matchups.map((matchup) => ({
        homeTeamId: matchup.homeTeamId,
        awayTeamId: matchup.awayTeamId,
      })),
      byeTeamId:
        week.bye === null
          ? null
          : week.bye.teamId,
    })),
    nhlSeasonKey: context.nhlSeasonKey,
    nhlRegularSeasonStartsAtMs:
      context.nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs:
      context.nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs:
      context.fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs:
      context.fantasyPlayoffsEndAtMs,
    firstWeekStartsAtMs:
      input.firstWeekStartsAtMs,
    timeZone: context.timeZone,
    nowMs,
  });
  if (
    !Array.isArray(context.teams) ||
    !sameStableIds(
      schedulePlan.teamIds,
      context.teams.map(({ id }) => id)
    )
  ) {
    fail(
      MATCHUP_SCHEDULE_SERVICE_CODES.weekInvalid,
      "The active team set changed after schedule creation."
    );
  }
  const oldJobs = inspectShiftJobs({
    context,
    generation,
  });
  return Object.freeze({
    context,
    generation,
    oldJobs,
    schedulePlan,
    targetWeek,
  });
}

function buildShiftWeeks({
  inspected,
  leagueId,
  seasonId,
  operationId,
  scheduleVersion,
  nowMs,
  secureRandom,
} = {}) {
  const sourceWeeks = new Map(
    inspected.context.weeks.map((week) => [
      week.id,
      week,
    ])
  );
  return Object.freeze(
    inspected.schedulePlan.weeks.map(
      (plannedWeek) => {
        const sourceWeek = sourceWeeks.get(
          plannedWeek.id
        );
        const occurrences = Object.freeze(
          occurrenceSpecifications(
            plannedWeek
          ).map((occurrence) => {
            const oldJob = inspected.oldJobs.get(
              `${plannedWeek.id}\u0000${occurrence.slot}`
            );
            return Object.freeze({
              runId: secureId(secureRandom),
              leagueId,
              seasonId,
              weekId: plannedWeek.id,
              jobType: occurrence.jobType,
              occurrenceKey:
                buildMatchupOccurrenceKey({
                  jobType: occurrence.jobType,
                  leagueId,
                  seasonId,
                  weekId: plannedWeek.id,
                  scheduleOperationId:
                    operationId,
                  scheduleVersion,
                  scheduledForMs:
                    occurrence.scheduledForMs,
                }),
              scheduledForMs:
                occurrence.scheduledForMs,
              nowMs,
              replacedJobRunId: oldJob.id,
              replacedJobVersion:
                oldJob.version,
              replacedOccurrenceKey:
                oldJob.occurrenceKey,
              previousScheduledForMs:
                oldJob.scheduledForMs,
            });
          })
        );
        return Object.freeze({
          id: plannedWeek.id,
          leagueId,
          seasonId,
          weekKey: plannedWeek.weekKey,
          sequence: plannedWeek.sequence,
          previousStartsAtMs:
            sourceWeek.startsAtMs,
          previousBaselineAtMs:
            sourceWeek.baselineAtMs,
          previousLocksAtMs:
            sourceWeek.locksAtMs,
          previousEndsAtMs:
            sourceWeek.endsAtMs,
          previousRollsOverAtMs:
            sourceWeek.rollsOverAtMs,
          startsAtMs: plannedWeek.startsAtMs,
          baselineAtMs:
            plannedWeek.baselineAtMs,
          locksAtMs: plannedWeek.locksAtMs,
          endsAtMs: plannedWeek.endsAtMs,
          rollsOverAtMs:
            plannedWeek.rollsOverAtMs,
          expectedVersion: sourceWeek.version,
          version: sourceWeek.version + 1,
          nowMs,
          matchups: Object.freeze(
            sourceWeek.matchups.map(
              (matchup) =>
                Object.freeze({
                  ...matchup,
                })
            )
          ),
          bye:
            sourceWeek.bye === null
              ? null
              : Object.freeze({
                  ...sourceWeek.bye,
                }),
          occurrences,
        });
      }
    )
  );
}

function buildWeeks({
  context,
  plan,
  nowMs,
  secureRandom,
  scheduleOperationId,
  scheduleVersion,
} = {}) {
  const teamById = new Map(
    context.teams.map((team) => [team.id, team])
  );
  return Object.freeze(
    plan.weeks.map((week) => {
      const weekId = secureId(secureRandom);
      const occurrence = (
        jobType,
        scheduledForMs
      ) =>
        Object.freeze({
          runId: secureId(secureRandom),
          leagueId: context.league_id,
          seasonId: context.season_id,
          jobType,
          occurrenceKey:
            buildMatchupOccurrenceKey({
              jobType,
              leagueId: context.league_id,
              seasonId: context.season_id,
              weekId,
              scheduleOperationId,
              scheduleVersion,
              scheduledForMs,
            }),
          scheduledForMs,
          nowMs,
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
        nowMs,
        occurrences: Object.freeze([
          occurrence(
            "matchup:statistics_refresh",
            week.startsAtMs
          ),
          occurrence(
            "matchup:baseline",
            week.baselineAtMs
          ),
          occurrence(
            "matchup:lock",
            week.locksAtMs
          ),
          occurrence(
            "matchup:statistics_refresh",
            week.endsAtMs
          ),
          occurrence(
            "matchup:finalize",
            week.endsAtMs
          ),
          occurrence(
            "matchup:rollover",
            week.rollsOverAtMs
          ),
        ]),
        matchups: Object.freeze(
          week.pairs.map((pair) =>
            Object.freeze({
              id: secureId(secureRandom),
              leagueId: context.league_id,
              seasonId: context.season_id,
              weekId,
              homeTeamId: pair.homeTeamId,
              awayTeamId: pair.awayTeamId,
              homeTeamName:
                teamById.get(pair.homeTeamId)
                  .name,
              awayTeamName:
                teamById.get(pair.awayTeamId)
                  .name,
              nowMs,
            })
          )
        ),
        bye:
          week.byeTeamId === null
            ? null
            : Object.freeze({
                id: secureId(secureRandom),
                leagueId: context.league_id,
                seasonId: context.season_id,
                weekId,
                teamId: week.byeTeamId,
                teamDisplayName:
                  teamById.get(week.byeTeamId)
                    .name,
                nowMs,
              }),
      });
    })
  );
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function createMatchupScheduleService({
  repositoryContext,
  leagueAuthorization,
  repository,
  clock,
  secureRandom,
} = {}) {
  requireMethod(
    repositoryContext,
    "transaction",
    "a repository transaction boundary"
  );
  requireMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league commissioner authorization"
  );
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    requireMethod(
      repository,
      method,
      `a schedule repository with ${method}`
    );
  }
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );

  function preview({
    leagueId,
    seasonId,
    actorUserId,
    authorizedAsPlatformAdministrator = false,
    nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs,
    firstWeekStartsAtMs,
    nowMs,
  }) {
    return inspectContext({
      context: repository.readContext({
        leagueId,
        seasonId,
      }),
      input: {
        nhlRegularSeasonStartsAtMs,
        nhlRegularSeasonEndsAtMs,
        fantasyPlayoffsStartAtMs,
        fantasyPlayoffsEndAtMs,
        firstWeekStartsAtMs,
      },
      actorUserId,
      authorizedAsPlatformAdministrator,
      nowMs,
      requireDirectAuthority: true,
    });
  }

  function generate({
    leagueId,
    seasonId,
    input,
    expectedSeasonVersion,
    idempotencyKey,
    authenticated,
  } = {}) {
    const canonicalLeagueId =
      validateMatchupScheduleCommandLeagueId(
        leagueId
      );
    const canonicalSeasonId =
      validateMatchupScheduleCommandSeasonId(
        seasonId
      );
    const canonicalInput =
      validateMatchupScheduleConfirmedInput(input);
    const expectedVersion =
      validateMatchupScheduleCommandExpectedVersion(
        expectedSeasonVersion
      );
    const clientKey =
      validateMatchupScheduleCommandIdempotencyKey(
        idempotencyKey
      );
    const requestHash =
      hashMatchupScheduleCommandRequest({
        leagueId: canonicalLeagueId,
        seasonId: canonicalSeasonId,
        expectedSeasonVersion: expectedVersion,
        input: canonicalInput,
      });

    try {
      return repositoryContext.transaction(() => {
        const authority = safeAuthority(
          leagueAuthorization.requireCommissioner(
            authenticated,
            canonicalLeagueId
          ),
          canonicalLeagueId
        );
        const existing = repository.findIdempotency({
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation:
            MATCHUP_SCHEDULE_COMMAND_OPERATION,
          clientKey,
        });
        if (existing !== null) {
          const resultId = inspectReplay({
            idempotency: existing,
            actorUserId: authority.actorUserId,
            clientKey,
            leagueId: canonicalLeagueId,
            requestHash,
          });
          const row = repository.findCommandResult({
            leagueId: canonicalLeagueId,
            resultId,
          });
          if (
            row?.id !== resultId ||
            row?.leagueId !== canonicalLeagueId ||
            row?.seasonId !== canonicalSeasonId ||
            row?.idempotencyRequestId !==
              existing.id ||
            row?.requestSha256 !== requestHash ||
            row?.actorUserId !==
              authority.actorUserId
          ) {
            fail(
              MATCHUP_SCHEDULE_SERVICE_CODES
                .resultUnavailable,
              "The immutable matchup schedule replay result is inconsistent."
            );
          }
          return commandResultFromRow(row);
        }

        const nowMs = safeNow(clock);
        const inspected = inspectContext({
          context: repository.readContext({
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
          }),
          input: canonicalInput,
          nowMs,
          requireDirectAuthority: false,
        });
        if (
          inspected.context.season_version !==
          expectedVersion
        ) {
          fail(
            MATCHUP_SCHEDULE_SERVICE_CODES
              .preconditionFailed,
            "The matchup schedule season version changed."
          );
        }

        const operationId =
          secureId(secureRandom);
        const idempotencyRequestId =
          secureId(secureRandom);
        const commandResultId =
          secureId(secureRandom);
        const weeks = buildWeeks({
          context: inspected.context,
          plan: inspected.plan,
          nowMs,
          secureRandom,
          scheduleOperationId: operationId,
          scheduleVersion: 1,
        });
        const correctiveRequeueId =
          secureId(secureRandom);
        const matchupCount = weeks.reduce(
          (sum, week) =>
            sum + week.matchups.length,
          0
        );
        const byeCount = weeks.filter(
          (week) => week.bye !== null
        ).length;
        const result = Object.freeze({
          operationId,
          seasonId: canonicalSeasonId,
          seasonVersion: expectedVersion + 1,
          nhlRegularSeasonStartsAtMs:
            inspected.plan
              .nhlRegularSeasonStartsAtMs,
          nhlRegularSeasonEndsAtMs:
            inspected.plan
              .nhlRegularSeasonEndsAtMs,
          fantasyPlayoffsStartAtMs:
            inspected.plan
              .fantasyPlayoffsStartAtMs,
          fantasyPlayoffsEndAtMs:
            inspected.plan
              .fantasyPlayoffsEndAtMs,
          calendarPersisted:
            inspected.calendarWillBePersisted,
          firstWeekId: weeks[0].id,
          firstWeekStartsAtMs:
            weeks[0].startsAtMs,
          participantCount:
            inspected.plan.teamIds.length,
          weekCount: weeks.length,
          matchupCount,
          byeCount,
          lastWeekEndsAtMs:
            weeks.at(-1).endsAtMs,
        });
        const responseHash =
          hashMatchupScheduleCommandResponse(result);
        const plan = Object.freeze({
          actor: authority,
          calendarPersisted:
            inspected.calendarWillBePersisted,
          commandResultId,
          correctiveRequeueId,
          expectedSeasonVersion:
            expectedVersion,
          idempotency: Object.freeze({
            clientKey,
            expiresAtMs:
              safeIdempotencyExpiry(nowMs),
            id: idempotencyRequestId,
            operation:
              MATCHUP_SCHEDULE_COMMAND_OPERATION,
            requestHash,
            resultType:
              MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE,
          }),
          leagueId: canonicalLeagueId,
          nowMs,
          operationId,
          participantTeamIds:
            inspected.plan.teamIds,
          result,
          responseHash,
          seasonId: canonicalSeasonId,
          weeks,
        });
        const applied =
          repository.applyConfirmedSchedulePlan(
            plan
          );
        if (applied?.applied !== true) {
          fail(
            MATCHUP_SCHEDULE_SERVICE_CODES
              .resultUnavailable,
            "The matchup schedule command did not persist."
          );
        }
        const durableRow =
          repository.findCommandResult({
            leagueId: canonicalLeagueId,
            resultId: commandResultId,
          });
        const durable =
          commandResultFromRow(durableRow);
        if (
          hashMatchupScheduleCommandResponse(
            durable
          ) !== responseHash
        ) {
          fail(
            MATCHUP_SCHEDULE_SERVICE_CODES
              .resultUnavailable,
            "The durable matchup schedule result changed."
          );
        }
        return durable;
      });
    } catch (error) {
      const chain = errorChain(error);
      const applicationError = chain.find(
        (candidate) =>
          candidate instanceof
            MatchupScheduleServiceError ||
          candidate instanceof
            MatchupScheduleCommandPolicyError ||
          candidate?.code ===
            "MATCHUP_SCHEDULE_CALENDAR_INVALID" ||
          candidate?.code ===
            "MATCHUP_SCHEDULE_INPUT_INVALID" ||
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            "LEAGUE_NOT_FOUND",
          ].includes(candidate?.code)
      );
      if (applicationError) {
        throw applicationError;
      }
      if (
        chain.some(
          (candidate) =>
            candidate?.code ===
            "REPOSITORY_VERSION_CONFLICT"
        )
      ) {
        fail(
          MATCHUP_SCHEDULE_SERVICE_CODES
            .preconditionFailed,
          "The matchup schedule context changed."
        );
      }
      const constraint = chain.find(
        (candidate) =>
          candidate?.code ===
          "REPOSITORY_CONSTRAINT"
      );
      if (
        constraint ||
        chain.some(
          (candidate) =>
            candidate?.code ===
            "REPOSITORY_RECORD_NOT_FOUND"
        )
      ) {
        fail(
          MATCHUP_SCHEDULE_SERVICE_CODES
            .seasonInvalid,
          "The matchup schedule command is not allowed."
        );
      }
      throw error;
    }
  }

  function shiftWeekOne({
    leagueId,
    seasonId,
    weekId,
    input,
    expectedWeekVersion,
    idempotencyKey,
    authenticated,
  } = {}) {
    const canonicalLeagueId =
      validateMatchupScheduleCommandLeagueId(
        leagueId
      );
    const canonicalSeasonId =
      validateMatchupScheduleCommandSeasonId(
        seasonId
      );
    const canonicalWeekId =
      validateMatchupScheduleShiftWeekOneWeekId(
        weekId
      );
    const canonicalInput =
      validateMatchupScheduleShiftWeekOneInput(
        input
      );
    const expectedVersion =
      validateMatchupScheduleShiftExpectedWeekVersion(
        expectedWeekVersion
      );
    const clientKey =
      validateMatchupScheduleCommandIdempotencyKey(
        idempotencyKey
      );
    const requestHash =
      hashMatchupScheduleShiftWeekOneRequest({
        leagueId: canonicalLeagueId,
        seasonId: canonicalSeasonId,
        weekId: canonicalWeekId,
        expectedWeekVersion: expectedVersion,
        input: canonicalInput,
      });

    try {
      return repositoryContext.transaction(() => {
        const authority = safeAuthority(
          leagueAuthorization.requireCommissioner(
            authenticated,
            canonicalLeagueId
          ),
          canonicalLeagueId
        );
        const existing = repository.findIdempotency({
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation:
            MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
          clientKey,
        });
        if (existing !== null) {
          const resultId = inspectReplay({
            idempotency: existing,
            actorUserId: authority.actorUserId,
            clientKey,
            leagueId: canonicalLeagueId,
            operation:
              MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
            requestHash,
          });
          const row = repository.findCommandResult({
            leagueId: canonicalLeagueId,
            resultId,
          });
          if (
            row?.id !== resultId ||
            row?.leagueId !== canonicalLeagueId ||
            row?.seasonId !== canonicalSeasonId ||
            row?.weekOneMatchupWeekId !==
              canonicalWeekId ||
            row?.idempotencyRequestId !==
              existing.id ||
            row?.requestSha256 !== requestHash ||
            row?.actorUserId !==
              authority.actorUserId
          ) {
            fail(
              MATCHUP_SCHEDULE_SERVICE_CODES
                .resultUnavailable,
              "The immutable Week 1 shift replay result is inconsistent."
            );
          }
          return shiftResultFromRow(row);
        }

        const nowMs = safeNow(clock);
        const inspected = inspectShiftContext({
          context: repository.readShiftContext({
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            weekId: canonicalWeekId,
          }),
          leagueId: canonicalLeagueId,
          seasonId: canonicalSeasonId,
          weekId: canonicalWeekId,
          input: canonicalInput,
          nowMs,
        });
        if (
          inspected.targetWeek.version !==
          expectedVersion
        ) {
          fail(
            MATCHUP_SCHEDULE_SERVICE_CODES
              .preconditionFailed,
            "The Week 1 version changed."
          );
        }

        const operationId =
          secureId(secureRandom);
        const idempotencyRequestId =
          secureId(secureRandom);
        const commandResultId =
          secureId(secureRandom);
        const newScheduleVersion =
          inspected.generation.scheduleVersion +
          1;
        const weeks = buildShiftWeeks({
          inspected,
          leagueId: canonicalLeagueId,
          seasonId: canonicalSeasonId,
          operationId,
          scheduleVersion:
            newScheduleVersion,
          nowMs,
          secureRandom,
        });
        const replacedJobOccurrenceCount =
          weeks.reduce(
            (sum, week) =>
              sum + week.occurrences.length,
            0
          );
        const result =
          validateMatchupScheduleShiftWeekOneResult({
            operationId,
            seasonId: canonicalSeasonId,
            seasonVersion:
              inspected.context.seasonVersion +
              1,
            weekId: canonicalWeekId,
            weekVersion:
              inspected.targetWeek.version + 1,
            previousFirstWeekStartsAtMs:
              inspected.schedulePlan
                .previousFirstWeekStartsAtMs,
            firstWeekStartsAtMs:
              inspected.schedulePlan
                .firstWeekStartsAtMs,
            lastWeekEndsAtMs:
              inspected.schedulePlan
                .lastWeekEndsAtMs,
            shiftedWeekCount:
              inspected.schedulePlan
                .shiftedWeekCount,
            replacedJobOccurrenceCount,
          });
        const responseHash =
          hashMatchupScheduleShiftWeekOneResponse(
            result
          );
        const plan = Object.freeze({
          actor: authority,
          calendar: Object.freeze({
            nhlRegularSeasonStartsAtMs:
              inspected.context
                .nhlRegularSeasonStartsAtMs,
            nhlRegularSeasonEndsAtMs:
              inspected.context
                .nhlRegularSeasonEndsAtMs,
            fantasyPlayoffsStartAtMs:
              inspected.context
                .fantasyPlayoffsStartAtMs,
            fantasyPlayoffsEndAtMs:
              inspected.context
                .fantasyPlayoffsEndAtMs,
          }),
          commandResultId,
          currentGenerationVersion:
            inspected.generation.version,
          expectedSeasonVersion:
            inspected.context.seasonVersion,
          expectedWeekVersion: expectedVersion,
          idempotency: Object.freeze({
            clientKey,
            expiresAtMs:
              safeIdempotencyExpiry(nowMs),
            id: idempotencyRequestId,
            operation:
              MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
            requestHash,
            resultType:
              MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE,
          }),
          leagueId: canonicalLeagueId,
          newScheduleVersion,
          nowMs,
          oldScheduleOperationId:
            inspected.generation
              .scheduleOperationId,
          oldScheduleVersion:
            inspected.generation
              .scheduleVersion,
          operationId,
          participantTeamIds:
            inspected.schedulePlan.teamIds,
          responseHash,
          result,
          seasonId: canonicalSeasonId,
          weeks,
        });
        const applied =
          repository.applyWeekOneShiftPlan(
            plan
          );
        if (applied?.applied !== true) {
          fail(
            MATCHUP_SCHEDULE_SERVICE_CODES
              .resultUnavailable,
            "The Week 1 shift command did not persist."
          );
        }
        const durableRow =
          repository.findCommandResult({
            leagueId: canonicalLeagueId,
            resultId: commandResultId,
          });
        const durable =
          shiftResultFromRow(durableRow);
        if (
          durableRow?.id !== commandResultId ||
          durableRow?.leagueId !==
            canonicalLeagueId ||
          durableRow?.seasonId !==
            canonicalSeasonId ||
          durableRow?.weekOneMatchupWeekId !==
            canonicalWeekId ||
          durableRow?.idempotencyRequestId !==
            idempotencyRequestId ||
          durableRow?.requestSha256 !==
            requestHash ||
          durableRow?.actorUserId !==
            authority.actorUserId ||
          hashMatchupScheduleShiftWeekOneResponse(
            durable
          ) !== responseHash
        ) {
          fail(
            MATCHUP_SCHEDULE_SERVICE_CODES
              .resultUnavailable,
            "The durable Week 1 shift result changed."
          );
        }
        return durable;
      });
    } catch (error) {
      const chain = errorChain(error);
      const applicationError = chain.find(
        (candidate) =>
          candidate instanceof
            MatchupScheduleServiceError ||
          candidate instanceof
            MatchupScheduleCommandPolicyError ||
          candidate?.code ===
            "MATCHUP_SCHEDULE_CALENDAR_INVALID" ||
          candidate?.code ===
            "MATCHUP_SCHEDULE_INPUT_INVALID" ||
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            "LEAGUE_NOT_FOUND",
          ].includes(candidate?.code)
      );
      if (applicationError) {
        throw applicationError;
      }
      if (
        chain.some(
          (candidate) =>
            candidate?.code ===
            "REPOSITORY_VERSION_CONFLICT"
        )
      ) {
        fail(
          MATCHUP_SCHEDULE_SERVICE_CODES
            .preconditionFailed,
          "The Week 1 shift context changed."
        );
      }
      if (
        chain.some(
          (candidate) =>
            candidate?.code ===
              "REPOSITORY_CONSTRAINT" ||
            candidate?.code ===
              "REPOSITORY_RECORD_NOT_FOUND"
        )
      ) {
        fail(
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
          "The Week 1 shift command is not allowed."
        );
      }
      throw error;
    }
  }

  return Object.freeze({
    preview,
    generate,
    shiftWeekOne,
  });
}

module.exports = {
  MATCHUP_SCHEDULE_SERVICE_CODES,
  MatchupScheduleServiceError,
  createMatchupScheduleService,
};
