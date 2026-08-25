const {
  UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  planFreeAgentDraftCompletionScheduleRecovery,
  planFreeAgentDraftPreOpenScheduleRecovery,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftScheduleRecoveryPolicy"
);
const {
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  createFreeAgentDraftScheduleRecoveryEvidence,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftScheduleRecoveryEvidencePolicy"
);
const {
  MAXIMUM_UTC_TIMESTAMP_MS,
  MatchupSchedulePolicyError,
  planExplicitMatchupSchedule,
} = require(
  "../../../domain/matchups/matchupSchedulePolicy"
);
const {
  buildMatchupOccurrenceKey,
  parseQualifiedMatchupOccurrenceKey,
} = require(
  "../../../domain/matchups/matchupJobPolicy"
);

const FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES =
  Object.freeze({
    contextInvalid:
      "FAD_SCHEDULE_RECOVERY_CONTEXT_INVALID",
    stateInvalid:
      "FAD_SCHEDULE_RECOVERY_STATE_INVALID",
    secureIdentifierInvalid:
      "FAD_SCHEDULE_RECOVERY_SECURE_IDENTIFIER_INVALID",
  });

const CONTEXT_KEYS = Object.freeze([
  "leagueId",
  "seasonId",
  "fadId",
  "recovery",
  "calendar",
  "currentGeneration",
  "weeks",
  "jobs",
]);
const RECOVERY_KEYS = Object.freeze([
  "kind",
  "atMs",
  "frozenFadFirstMatchupStartsAtMs",
]);
const CALENDAR_KEYS = Object.freeze([
  "nhlSeasonKey",
  "nhlRegularSeasonStartsAtMs",
  "nhlRegularSeasonEndsAtMs",
  "fantasyPlayoffsStartAtMs",
  "fantasyPlayoffsEndAtMs",
  "timeZone",
]);
const GENERATION_KEYS = Object.freeze([
  "leagueId",
  "seasonId",
  "scheduleVersion",
  "scheduleOperationId",
  "weekOneMatchupWeekId",
  "weekOneStartsAtMs",
  "status",
  "supersededAtMs",
  "version",
]);
const WEEK_KEYS = Object.freeze([
  "id",
  "leagueId",
  "seasonId",
  "weekKey",
  "sequence",
  "startsAtMs",
  "baselineAtMs",
  "locksAtMs",
  "endsAtMs",
  "rollsOverAtMs",
  "status",
  "version",
  "matchups",
  "bye",
]);
const MATCHUP_KEYS = Object.freeze([
  "id",
  "leagueId",
  "seasonId",
  "weekId",
  "homeTeamId",
  "awayTeamId",
  "status",
  "version",
]);
const BYE_KEYS = Object.freeze([
  "id",
  "leagueId",
  "seasonId",
  "weekId",
  "teamId",
]);
const JOB_KEYS = Object.freeze([
  "id",
  "leagueId",
  "seasonId",
  "weekId",
  "jobType",
  "occurrenceKey",
  "scheduledForMs",
  "status",
  "attemptCount",
  "leaseOwner",
  "leaseToken",
  "leaseExpiresAtMs",
  "startedAtMs",
  "completedAtMs",
  "resultJson",
  "lastErrorCode",
  "createdAtMs",
  "updatedAtMs",
  "version",
  "nextAttemptAtMs",
  "bindingId",
  "bindingJobType",
  "bindingScheduleOperationId",
  "bindingScheduleVersion",
  "bindingOwningMatchupWeekId",
  "bindingOwningMatchupId",
  "bindingCreatedAtMs",
  "bindingVersion",
]);

const OCCURRENCE_SLOTS = Object.freeze([
  Object.freeze({
    slot: "statistics_refresh_start",
    jobType: "matchup:statistics_refresh",
    timeField: "startsAtMs",
  }),
  Object.freeze({
    slot: "baseline",
    jobType: "matchup:baseline",
    timeField: "baselineAtMs",
  }),
  Object.freeze({
    slot: "lock",
    jobType: "matchup:lock",
    timeField: "locksAtMs",
  }),
  Object.freeze({
    slot: "statistics_refresh_end",
    jobType: "matchup:statistics_refresh",
    timeField: "endsAtMs",
  }),
  Object.freeze({
    slot: "finalize",
    jobType: "matchup:finalize",
    timeField: "endsAtMs",
  }),
  Object.freeze({
    slot: "rollover",
    jobType: "matchup:rollover",
    timeField: "rollsOverAtMs",
  }),
]);

class FreeAgentDraftScheduleRecoveryServiceError
  extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft schedule recovery context is invalid."
    );
    this.name =
      "FreeAgentDraftScheduleRecoveryServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftScheduleRecoveryServiceError(
    code,
    reasonCode
  );
}

function failContext(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
      .contextInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
      .stateInvalid,
    reasonCode
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireExactObject(
  value,
  expectedKeys,
  reasonCode
) {
  if (!isPlainObject(value)) {
    failContext(reasonCode);
  }
  const actualKeys = Object.keys(value).sort(
    compareStrings
  );
  const canonicalExpectedKeys = [
    ...expectedKeys,
  ].sort(compareStrings);
  if (
    actualKeys.length !==
      canonicalExpectedKeys.length ||
    actualKeys.some(
      (key, index) =>
        key !== canonicalExpectedKeys[index]
    )
  ) {
    failContext(reasonCode);
  }
  return value;
}

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failContext(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_UTC_TIMESTAMP_MS
  ) {
    failContext(reasonCode);
  }
  return value;
}

function safePositiveInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    failContext(reasonCode);
  }
  return value;
}

function incrementableVersion(value, reasonCode) {
  const version = safePositiveInteger(
    value,
    reasonCode
  );
  if (version >= Number.MAX_SAFE_INTEGER) {
    failState(reasonCode);
  }
  return version;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function cloneRecovery(value) {
  requireExactObject(
    value,
    RECOVERY_KEYS,
    "recovery_fields_invalid"
  );
  if (
    value.kind !== "pre_open" &&
    value.kind !== "completion"
  ) {
    failContext("recovery_kind_invalid");
  }
  const atMs = safeTimestamp(
    value.atMs,
    "recovery_time_invalid"
  );
  let frozenFadFirstMatchupStartsAtMs = null;
  if (value.kind === "pre_open") {
    if (
      value.frozenFadFirstMatchupStartsAtMs !==
      null
    ) {
      failContext(
        "pre_open_frozen_week_one_must_be_null"
      );
    }
  } else {
    frozenFadFirstMatchupStartsAtMs =
      safeTimestamp(
        value.frozenFadFirstMatchupStartsAtMs,
        "completion_frozen_week_one_invalid"
      );
  }
  return Object.freeze({
    kind: value.kind,
    atMs,
    frozenFadFirstMatchupStartsAtMs,
  });
}

function cloneCalendar(value) {
  requireExactObject(
    value,
    CALENDAR_KEYS,
    "calendar_fields_invalid"
  );
  return Object.freeze({
    nhlSeasonKey: value.nhlSeasonKey,
    nhlRegularSeasonStartsAtMs:
      value.nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs:
      value.nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs:
      value.fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs:
      value.fantasyPlayoffsEndAtMs,
    timeZone: value.timeZone,
  });
}

function cloneGeneration(
  value,
  { leagueId, seasonId }
) {
  requireExactObject(
    value,
    GENERATION_KEYS,
    "generation_fields_invalid"
  );
  const scheduleVersion =
    incrementableVersion(
      value.scheduleVersion,
      "schedule_version_invalid"
    );
  if (
    value.leagueId !== leagueId ||
    value.seasonId !== seasonId ||
    value.status !== "current" ||
    value.supersededAtMs !== null ||
    value.version !== 1
  ) {
    failState("generation_not_current");
  }
  return Object.freeze({
    leagueId,
    seasonId,
    scheduleVersion,
    scheduleOperationId: stableId(
      value.scheduleOperationId,
      "schedule_operation_id_invalid"
    ),
    weekOneMatchupWeekId: stableId(
      value.weekOneMatchupWeekId,
      "generation_week_one_id_invalid"
    ),
    weekOneStartsAtMs: safeTimestamp(
      value.weekOneStartsAtMs,
      "generation_week_one_start_invalid"
    ),
    status: "current",
    supersededAtMs: null,
    version: 1,
  });
}

function cloneMatchup(
  value,
  { leagueId, seasonId, weekId }
) {
  requireExactObject(
    value,
    MATCHUP_KEYS,
    "matchup_fields_invalid"
  );
  if (
    value.leagueId !== leagueId ||
    value.seasonId !== seasonId ||
    value.weekId !== weekId ||
    value.status !== "scheduled"
  ) {
    failState("matchup_scope_or_status_invalid");
  }
  const id = stableId(
    value.id,
    "matchup_id_invalid"
  );
  const homeTeamId = stableId(
    value.homeTeamId,
    "matchup_home_team_id_invalid"
  );
  const awayTeamId = stableId(
    value.awayTeamId,
    "matchup_away_team_id_invalid"
  );
  if (homeTeamId === awayTeamId) {
    failState("matchup_self_pair_invalid");
  }
  return Object.freeze({
    id,
    leagueId,
    seasonId,
    weekId,
    homeTeamId,
    awayTeamId,
    status: "scheduled",
    version: incrementableVersion(
      value.version,
      "matchup_version_invalid"
    ),
  });
}

function cloneBye(
  value,
  { leagueId, seasonId, weekId }
) {
  if (value === null) return null;
  requireExactObject(
    value,
    BYE_KEYS,
    "bye_fields_invalid"
  );
  if (
    value.leagueId !== leagueId ||
    value.seasonId !== seasonId ||
    value.weekId !== weekId
  ) {
    failState("bye_scope_invalid");
  }
  return Object.freeze({
    id: stableId(value.id, "bye_id_invalid"),
    leagueId,
    seasonId,
    weekId,
    teamId: stableId(
      value.teamId,
      "bye_team_id_invalid"
    ),
  });
}

function cloneWeek(
  value,
  { leagueId, seasonId }
) {
  requireExactObject(
    value,
    WEEK_KEYS,
    "week_fields_invalid"
  );
  const id = stableId(
    value.id,
    "week_id_invalid"
  );
  if (
    value.leagueId !== leagueId ||
    value.seasonId !== seasonId ||
    value.status !== "scheduled" ||
    !Array.isArray(value.matchups) ||
    value.matchups.length < 1
  ) {
    failState("week_scope_or_status_invalid");
  }
  return Object.freeze({
    id,
    leagueId,
    seasonId,
    weekKey: value.weekKey,
    sequence: safePositiveInteger(
      value.sequence,
      "week_sequence_invalid"
    ),
    startsAtMs: safeTimestamp(
      value.startsAtMs,
      "week_start_invalid"
    ),
    baselineAtMs: safeTimestamp(
      value.baselineAtMs,
      "week_baseline_invalid"
    ),
    locksAtMs: safeTimestamp(
      value.locksAtMs,
      "week_lock_invalid"
    ),
    endsAtMs: safeTimestamp(
      value.endsAtMs,
      "week_end_invalid"
    ),
    rollsOverAtMs: safeTimestamp(
      value.rollsOverAtMs,
      "week_rollover_invalid"
    ),
    status: "scheduled",
    version: incrementableVersion(
      value.version,
      "week_version_invalid"
    ),
    matchups: Object.freeze(
      value.matchups.map((matchup) =>
        cloneMatchup(matchup, {
          leagueId,
          seasonId,
          weekId: id,
        })
      )
    ),
    bye: cloneBye(value.bye, {
      leagueId,
      seasonId,
      weekId: id,
    }),
  });
}

function cloneJob(
  value,
  { leagueId, seasonId }
) {
  requireExactObject(
    value,
    JOB_KEYS,
    "job_fields_invalid"
  );
  const id = stableId(value.id, "job_id_invalid");
  const bindingId = stableId(
    value.bindingId,
    "job_binding_id_invalid"
  );
  const weekId = stableId(
    value.weekId,
    "job_week_id_invalid"
  );
  const scheduledForMs = safeTimestamp(
    value.scheduledForMs,
    "job_scheduled_time_invalid"
  );
  const createdAtMs = safeTimestamp(
    value.createdAtMs,
    "job_created_time_invalid"
  );
  if (
    value.leagueId !== leagueId ||
    value.seasonId !== seasonId ||
    value.status !== "pending" ||
    value.attemptCount !== 0 ||
    value.leaseOwner !== null ||
    value.leaseToken !== null ||
    value.leaseExpiresAtMs !== null ||
    value.startedAtMs !== null ||
    value.completedAtMs !== null ||
    value.resultJson !== null ||
    value.lastErrorCode !== null ||
    value.updatedAtMs !== createdAtMs ||
    value.nextAttemptAtMs !== scheduledForMs ||
    value.version !== 1 ||
    value.bindingJobType !== value.jobType ||
    value.bindingOwningMatchupWeekId !==
      weekId ||
    value.bindingOwningMatchupId !== null ||
    value.bindingCreatedAtMs !== createdAtMs ||
    value.bindingVersion !== 1 ||
    createdAtMs > scheduledForMs
  ) {
    failState("job_not_untouched_pending");
  }
  if (
    typeof value.jobType !== "string" ||
    typeof value.occurrenceKey !== "string"
  ) {
    failContext("job_text_invalid");
  }
  return Object.freeze({
    id,
    leagueId,
    seasonId,
    weekId,
    jobType: value.jobType,
    occurrenceKey: value.occurrenceKey,
    scheduledForMs,
    status: "pending",
    attemptCount: 0,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtMs: null,
    startedAtMs: null,
    completedAtMs: null,
    resultJson: null,
    lastErrorCode: null,
    createdAtMs,
    updatedAtMs: createdAtMs,
    version: 1,
    nextAttemptAtMs: scheduledForMs,
    bindingId,
    bindingJobType: value.jobType,
    bindingScheduleOperationId: stableId(
      value.bindingScheduleOperationId,
      "job_binding_operation_id_invalid"
    ),
    bindingScheduleVersion:
      safePositiveInteger(
        value.bindingScheduleVersion,
        "job_binding_schedule_version_invalid"
      ),
    bindingOwningMatchupWeekId: weekId,
    bindingOwningMatchupId: null,
    bindingCreatedAtMs: createdAtMs,
    bindingVersion: 1,
  });
}

function occurrenceSpecifications(week) {
  return OCCURRENCE_SLOTS.map(
    ({ slot, jobType, timeField }) =>
      Object.freeze({
        slot,
        jobType,
        scheduledForMs: week[timeField],
      })
  );
}

function slotKey(weekId, slot) {
  return `${weekId}\u0000${slot}`;
}

function pairKey({ homeTeamId, awayTeamId }) {
  return `${homeTeamId}\u0000${awayTeamId}`;
}

function sortedPairKeys(pairs) {
  return pairs.map(pairKey).sort(compareStrings);
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => value === right[index]
    )
  );
}

function participantIdsForWeek(week) {
  return [
    ...week.matchups.flatMap(
      ({ homeTeamId, awayTeamId }) => [
        homeTeamId,
        awayTeamId,
      ]
    ),
    ...(week.bye === null
      ? []
      : [week.bye.teamId]),
  ];
}

function inspectCanonicalSchedule({
  calendar,
  generation,
  leagueId,
  seasonId,
  weeks,
}) {
  if (!Array.isArray(weeks) || weeks.length < 1) {
    failContext("weeks_invalid");
  }
  const canonicalWeeks = Object.freeze(
    weeks.map((week) =>
      cloneWeek(week, { leagueId, seasonId })
    )
  );
  const weekIds = new Set();
  const matchupIds = new Set();
  const byeIds = new Set();
  let participantTeamIds = null;

  for (
    let index = 0;
    index < canonicalWeeks.length;
    index += 1
  ) {
    const week = canonicalWeeks[index];
    const expectedSequence = index + 1;
    const expectedWeekKey =
      `regular-${String(expectedSequence).padStart(
        2,
        "0"
      )}`;
    if (
      weekIds.has(week.id) ||
      week.sequence !== expectedSequence ||
      week.weekKey !== expectedWeekKey
    ) {
      failState("week_sequence_or_identity_invalid");
    }
    weekIds.add(week.id);

    const participants = participantIdsForWeek(
      week
    );
    if (
      new Set(participants).size !==
      participants.length
    ) {
      failState("weekly_participant_duplicate");
    }
    const currentParticipantTeamIds = [
      ...participants,
    ].sort(compareStrings);
    if (
      participantTeamIds !== null &&
      !sameStrings(
        currentParticipantTeamIds,
        participantTeamIds
      )
    ) {
      failState("participant_set_changed");
    }
    participantTeamIds = currentParticipantTeamIds;

    for (const matchup of week.matchups) {
      if (matchupIds.has(matchup.id)) {
        failState("matchup_id_duplicate");
      }
      matchupIds.add(matchup.id);
    }
    if (week.bye !== null) {
      if (byeIds.has(week.bye.id)) {
        failState("bye_id_duplicate");
      }
      byeIds.add(week.bye.id);
    }
  }

  if (
    generation.weekOneMatchupWeekId !==
      canonicalWeeks[0].id ||
    generation.weekOneStartsAtMs !==
      canonicalWeeks[0].startsAtMs
  ) {
    failState("generation_week_one_mismatch");
  }
  if (canonicalWeeks[0].startsAtMs < 1) {
    failState("week_one_start_invalid");
  }

  let planned;
  try {
    planned = planExplicitMatchupSchedule({
      teamIds: participantTeamIds,
      ...calendar,
      firstWeekStartsAtMs:
        canonicalWeeks[0].startsAtMs,
      nowMs: canonicalWeeks[0].startsAtMs - 1,
    });
  } catch (error) {
    if (error instanceof MatchupSchedulePolicyError) {
      failState("calendar_or_schedule_invalid");
    }
    throw error;
  }
  if (planned.weeks.length !== canonicalWeeks.length) {
    failState("schedule_does_not_reach_playoffs");
  }
  for (
    let index = 0;
    index < planned.weeks.length;
    index += 1
  ) {
    const expected = planned.weeks[index];
    const current = canonicalWeeks[index];
    if (
      current.weekKey !== expected.weekKey ||
      current.sequence !== expected.sequence ||
      current.startsAtMs !== expected.startsAtMs ||
      current.baselineAtMs !== expected.baselineAtMs ||
      current.locksAtMs !== expected.locksAtMs ||
      current.endsAtMs !== expected.endsAtMs ||
      current.rollsOverAtMs !==
        expected.rollsOverAtMs ||
      !sameStrings(
        sortedPairKeys(current.matchups),
        sortedPairKeys(expected.pairs)
      ) ||
      (current.bye === null
        ? null
        : current.bye.teamId) !==
        expected.byeTeamId
    ) {
      failState("schedule_week_not_canonical");
    }
  }

  return Object.freeze({
    weeks: canonicalWeeks,
    participantTeamIds:
      Object.freeze(participantTeamIds),
    persistedPlan: planned,
  });
}

function inspectJobs({
  generation,
  jobs,
  leagueId,
  seasonId,
  weeks,
}) {
  if (
    !Array.isArray(jobs) ||
    jobs.length !== weeks.length * 6
  ) {
    failState("job_count_invalid");
  }
  const weeksById = new Map(
    weeks.map((week) => [week.id, week])
  );
  const jobsBySlot = new Map();
  const jobIds = new Set();
  const bindingIds = new Set();
  const occurrenceKeys = new Set();

  for (const candidate of jobs) {
    const job = cloneJob(candidate, {
      leagueId,
      seasonId,
    });
    const week = weeksById.get(job.weekId);
    const matchingSlots = week
      ? occurrenceSpecifications(week).filter(
          (occurrence) =>
            occurrence.jobType === job.jobType &&
            occurrence.scheduledForMs ===
              job.scheduledForMs
        )
      : [];
    if (matchingSlots.length !== 1) {
      failState("job_slot_invalid");
    }
    let parsed;
    try {
      parsed = parseQualifiedMatchupOccurrenceKey({
        jobType: job.jobType,
        leagueId,
        seasonId,
        occurrenceKey: job.occurrenceKey,
        scheduledForMs: job.scheduledForMs,
      });
    } catch {
      failState("job_occurrence_key_invalid");
    }
    if (
      parsed.weekId !== job.weekId ||
      parsed.scheduleOperationId !==
        generation.scheduleOperationId ||
      parsed.scheduleVersion !==
        generation.scheduleVersion ||
      job.bindingScheduleOperationId !==
        generation.scheduleOperationId ||
      job.bindingScheduleVersion !==
        generation.scheduleVersion
    ) {
      failState("job_generation_mismatch");
    }
    const key = slotKey(
      job.weekId,
      matchingSlots[0].slot
    );
    if (
      jobsBySlot.has(key) ||
      jobIds.has(job.id) ||
      bindingIds.has(job.bindingId) ||
      occurrenceKeys.has(job.occurrenceKey)
    ) {
      failState("job_identity_duplicate");
    }
    jobsBySlot.set(key, job);
    jobIds.add(job.id);
    bindingIds.add(job.bindingId);
    occurrenceKeys.add(job.occurrenceKey);
  }
  for (const week of weeks) {
    for (const occurrence of
      occurrenceSpecifications(week)) {
      if (
        !jobsBySlot.has(
          slotKey(week.id, occurrence.slot)
        )
      ) {
        failState("job_slot_missing");
      }
    }
  }
  return Object.freeze({
    jobsBySlot,
    jobIds,
    bindingIds,
    occurrenceKeys,
  });
}

function inspectContext(context) {
  requireExactObject(
    context,
    CONTEXT_KEYS,
    "context_fields_invalid"
  );
  const leagueId = stableId(
    context.leagueId,
    "league_id_invalid"
  );
  const seasonId = stableId(
    context.seasonId,
    "season_id_invalid"
  );
  const fadId = stableId(
    context.fadId,
    "fad_id_invalid"
  );
  const recovery = cloneRecovery(context.recovery);
  const calendar = cloneCalendar(context.calendar);
  const generation = cloneGeneration(
    context.currentGeneration,
    { leagueId, seasonId }
  );
  const schedule = inspectCanonicalSchedule({
    calendar,
    generation,
    leagueId,
    seasonId,
    weeks: context.weeks,
  });
  const jobs = inspectJobs({
    generation,
    jobs: context.jobs,
    leagueId,
    seasonId,
    weeks: schedule.weeks,
  });
  return Object.freeze({
    leagueId,
    seasonId,
    fadId,
    recovery,
    calendar,
    generation,
    ...schedule,
    ...jobs,
  });
}

function recoveryDecision(inspected) {
  const shared = {
    fantasyPlayoffsStartAtMs:
      inspected.calendar
        .fantasyPlayoffsStartAtMs,
    timeZone: inspected.calendar.timeZone,
  };
  if (inspected.recovery.kind === "pre_open") {
    return planFreeAgentDraftPreOpenScheduleRecovery({
      readinessAtMs: inspected.recovery.atMs,
      firstWeekStartsAtMs:
        inspected.generation.weekOneStartsAtMs,
      ...shared,
    });
  }
  return planFreeAgentDraftCompletionScheduleRecovery({
    proposedCompletionAtMs:
      inspected.recovery.atMs,
    frozenFadFirstMatchupStartsAtMs:
      inspected.recovery
        .frozenFadFirstMatchupStartsAtMs,
    competitionFirstMatchupStartsAtMs:
      inspected.generation.weekOneStartsAtMs,
    ...shared,
  });
}

function recoveredWeekOneStartsAtMs(decision) {
  return decision.recoveryKind === "pre_open"
    ? decision.firstWeekStartsAtMs
    : decision.competitionFirstMatchupStartsAtMs;
}

function existingIds(inspected) {
  const result = new Set([
    inspected.leagueId,
    inspected.seasonId,
    inspected.fadId,
    inspected.generation.scheduleOperationId,
  ]);
  for (const week of inspected.weeks) {
    result.add(week.id);
    for (const matchup of week.matchups) {
      result.add(matchup.id);
    }
    if (week.bye !== null) result.add(week.bye.id);
  }
  for (const job of inspected.jobsBySlot.values()) {
    result.add(job.id);
    result.add(job.bindingId);
  }
  return result;
}

function createIdAllocator(secureRandom, unavailableIds) {
  const allocated = new Set(unavailableIds);
  return function allocateId() {
    const value = secureRandom.id();
    if (
      typeof value !== "string" ||
      !UUID_PATTERN.test(value) ||
      allocated.has(value)
    ) {
      fail(
        FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
          .secureIdentifierInvalid,
        allocated.has(value)
          ? "secure_identifier_duplicate"
          : "secure_identifier_invalid"
      );
    }
    allocated.add(value);
    return value;
  };
}

function sortPairs(left, right) {
  return (
    compareStrings(
      left.homeTeamId,
      right.homeTeamId
    ) ||
    compareStrings(
      left.awayTeamId,
      right.awayTeamId
    )
  );
}

function mapRetainedWeeks({
  inspected,
  regenerated,
  removedWeekCount,
}) {
  const retained = inspected.weeks.slice(
    removedWeekCount
  );
  if (retained.length !== regenerated.weeks.length) {
    failState("recovered_week_count_invalid");
  }
  return Object.freeze(
    regenerated.weeks.map((plannedWeek, index) => {
      const sourceWeek = retained[index];
      const sourceMatchups = [
        ...sourceWeek.matchups,
      ].sort((left, right) =>
        compareStrings(left.id, right.id)
      );
      const plannedPairs = [
        ...plannedWeek.pairs,
      ].sort(sortPairs);
      if (
        sourceWeek.startsAtMs !==
          plannedWeek.startsAtMs ||
        sourceMatchups.length !==
          plannedPairs.length ||
        (sourceWeek.bye === null) !==
          (plannedWeek.byeTeamId === null)
      ) {
        failState("retained_week_mapping_invalid");
      }
      return Object.freeze({
        id: sourceWeek.id,
        leagueId: inspected.leagueId,
        seasonId: inspected.seasonId,
        previousWeekKey: sourceWeek.weekKey,
        previousSequence: sourceWeek.sequence,
        previousStartsAtMs: sourceWeek.startsAtMs,
        previousBaselineAtMs:
          sourceWeek.baselineAtMs,
        previousLocksAtMs: sourceWeek.locksAtMs,
        previousEndsAtMs: sourceWeek.endsAtMs,
        previousRollsOverAtMs:
          sourceWeek.rollsOverAtMs,
        expectedVersion: sourceWeek.version,
        weekKey: plannedWeek.weekKey,
        sequence: plannedWeek.sequence,
        startsAtMs: plannedWeek.startsAtMs,
        baselineAtMs: plannedWeek.baselineAtMs,
        locksAtMs: plannedWeek.locksAtMs,
        endsAtMs: plannedWeek.endsAtMs,
        rollsOverAtMs: plannedWeek.rollsOverAtMs,
        status: "scheduled",
        version: sourceWeek.version + 1,
        updatedAtMs: inspected.recovery.atMs,
        matchups: Object.freeze(
          sourceMatchups.map((matchup, pairIndex) =>
            Object.freeze({
              id: matchup.id,
              leagueId: inspected.leagueId,
              seasonId: inspected.seasonId,
              weekId: sourceWeek.id,
              previousHomeTeamId:
                matchup.homeTeamId,
              previousAwayTeamId:
                matchup.awayTeamId,
              expectedVersion: matchup.version,
              homeTeamId:
                plannedPairs[pairIndex].homeTeamId,
              awayTeamId:
                plannedPairs[pairIndex].awayTeamId,
              status: "scheduled",
              version: matchup.version + 1,
              updatedAtMs:
                inspected.recovery.atMs,
            })
          )
        ),
        bye:
          sourceWeek.bye === null
            ? null
            : Object.freeze({
                id: sourceWeek.bye.id,
                leagueId: inspected.leagueId,
                seasonId: inspected.seasonId,
                weekId: sourceWeek.id,
                previousTeamId:
                  sourceWeek.bye.teamId,
                teamId: plannedWeek.byeTeamId,
              }),
      });
    })
  );
}

function deletionPlan(
  inspected,
  removedWeekCount
) {
  const weeks = inspected.weeks.slice(
    0,
    removedWeekCount
  );
  return Object.freeze({
    weeks: Object.freeze(
      weeks.map((week) =>
        Object.freeze({
          id: week.id,
          leagueId: inspected.leagueId,
          seasonId: inspected.seasonId,
          weekKey: week.weekKey,
          sequence: week.sequence,
          startsAtMs: week.startsAtMs,
          baselineAtMs: week.baselineAtMs,
          locksAtMs: week.locksAtMs,
          endsAtMs: week.endsAtMs,
          rollsOverAtMs: week.rollsOverAtMs,
          expectedStatus: "scheduled",
          expectedVersion: week.version,
        })
      )
    ),
    matchups: Object.freeze(
      weeks.flatMap((week) =>
        [...week.matchups]
          .sort((left, right) =>
            compareStrings(left.id, right.id)
          )
          .map((matchup) =>
            Object.freeze({
              id: matchup.id,
              leagueId: inspected.leagueId,
              seasonId: inspected.seasonId,
              weekId: week.id,
              homeTeamId: matchup.homeTeamId,
              awayTeamId: matchup.awayTeamId,
              expectedStatus: "scheduled",
              expectedVersion: matchup.version,
            })
          )
      )
    ),
    byes: Object.freeze(
      weeks
        .filter((week) => week.bye !== null)
        .map((week) =>
          Object.freeze({
            id: week.bye.id,
            leagueId: inspected.leagueId,
            seasonId: inspected.seasonId,
            weekId: week.id,
            teamId: week.bye.teamId,
          })
        )
    ),
  });
}

function buildJobPlan({
  allocateId,
  inspected,
  mappedWeeks,
  newScheduleOperationId,
  newScheduleVersion,
  recoveryAtMs,
  recoveryId,
  removedWeekCount,
}) {
  const mappedById = new Map(
    mappedWeeks.map((week) => [week.id, week])
  );
  const oldJobCas = [];
  const replacementJobs = [];
  const replacementBindings = [];
  const recoveryChildren = [];
  const evidenceEffects = [];

  for (
    let weekIndex = 0;
    weekIndex < inspected.weeks.length;
    weekIndex += 1
  ) {
    const sourceWeek = inspected.weeks[weekIndex];
    const replacementWeek = mappedById.get(
      sourceWeek.id
    );
    for (const oldOccurrence of
      occurrenceSpecifications(sourceWeek)) {
      const oldJob = inspected.jobsBySlot.get(
        slotKey(
          sourceWeek.id,
          oldOccurrence.slot
        )
      );
      const disposition =
        weekIndex < removedWeekCount
          ? "cancelled"
          : "replaced";
      const resultingOldJobVersion =
        oldJob.version + 1;
      oldJobCas.push(
        Object.freeze({
          jobRunId: oldJob.id,
          bindingId: oldJob.bindingId,
          leagueId: inspected.leagueId,
          seasonId: inspected.seasonId,
          weekId: sourceWeek.id,
          jobType: oldJob.jobType,
          disposition,
          expectedStatus: "pending",
          expectedAttemptCount: 0,
          expectedScheduledForMs:
            oldJob.scheduledForMs,
          expectedLeaseOwner: null,
          expectedLeaseToken: null,
          expectedLeaseExpiresAtMs: null,
          expectedStartedAtMs: null,
          expectedCompletedAtMs: null,
          expectedResultJson: null,
          expectedLastErrorCode: null,
          expectedCreatedAtMs: oldJob.createdAtMs,
          expectedUpdatedAtMs: oldJob.updatedAtMs,
          expectedNextAttemptAtMs:
            oldJob.nextAttemptAtMs,
          expectedOccurrenceKey:
            oldJob.occurrenceKey,
          expectedScheduleOperationId:
            inspected.generation
              .scheduleOperationId,
          expectedScheduleVersion:
            inspected.generation.scheduleVersion,
          expectedJobVersion: oldJob.version,
          expectedBindingVersion:
            oldJob.bindingVersion,
          expectedBindingJobType:
            oldJob.bindingJobType,
          expectedBindingScheduleOperationId:
            oldJob.bindingScheduleOperationId,
          expectedBindingScheduleVersion:
            oldJob.bindingScheduleVersion,
          expectedBindingOwningMatchupWeekId:
            oldJob.bindingOwningMatchupWeekId,
          expectedBindingOwningMatchupId: null,
          expectedBindingCreatedAtMs:
            oldJob.bindingCreatedAtMs,
          resultingStatus: "skipped",
          resultingNextAttemptAtMs: null,
          resultingUpdatedAtMs: recoveryAtMs,
          resultingJobVersion:
            resultingOldJobVersion,
        })
      );

      let replacementJob = null;
      let replacementBinding = null;
      if (disposition === "replaced") {
        const replacementOccurrence =
          occurrenceSpecifications(
            replacementWeek
          ).find(
            ({ slot }) =>
              slot === oldOccurrence.slot
          );
        const runId = allocateId();
        const bindingId = allocateId();
        const occurrenceKey =
          buildMatchupOccurrenceKey({
            jobType:
              replacementOccurrence.jobType,
            leagueId: inspected.leagueId,
            seasonId: inspected.seasonId,
            weekId: replacementWeek.id,
            scheduleOperationId:
              newScheduleOperationId,
            scheduleVersion: newScheduleVersion,
            scheduledForMs:
              replacementOccurrence.scheduledForMs,
          });
        replacementJob = Object.freeze({
          id: runId,
          leagueId: inspected.leagueId,
          seasonId: inspected.seasonId,
          weekId: replacementWeek.id,
          jobType:
            replacementOccurrence.jobType,
          occurrenceKey,
          scheduledForMs:
            replacementOccurrence.scheduledForMs,
          status: "pending",
          attemptCount: 0,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAtMs: null,
          startedAtMs: null,
          completedAtMs: null,
          resultJson: null,
          lastErrorCode: null,
          createdAtMs: recoveryAtMs,
          updatedAtMs: recoveryAtMs,
          version: 1,
          nextAttemptAtMs:
            replacementOccurrence.scheduledForMs,
        });
        replacementBinding = Object.freeze({
          id: bindingId,
          leagueId: inspected.leagueId,
          seasonId: inspected.seasonId,
          jobRunId: runId,
          jobType:
            replacementOccurrence.jobType,
          scheduleOperationId:
            newScheduleOperationId,
          scheduleVersion: newScheduleVersion,
          owningMatchupWeekId:
            replacementWeek.id,
          owningMatchupId: null,
          createdAtMs: recoveryAtMs,
          version: 1,
        });
        replacementJobs.push(replacementJob);
        replacementBindings.push(
          replacementBinding
        );
      }

      const recoveryChild = Object.freeze({
        id: allocateId(),
        leagueId: inspected.leagueId,
        seasonId: inspected.seasonId,
        scheduleRecoveryId: recoveryId,
        disposition,
        jobType: oldJob.jobType,
        replacedJobRunId: oldJob.id,
        replacementJobRunId:
          replacementJob?.id ?? null,
        replacedOccurrenceKey:
          oldJob.occurrenceKey,
        replacementOccurrenceKey:
          replacementJob?.occurrenceKey ?? null,
        replacedScheduleOperationId:
          inspected.generation
            .scheduleOperationId,
        replacedScheduleVersion:
          inspected.generation.scheduleVersion,
        replacementScheduleOperationId:
          replacementJob === null
            ? null
            : newScheduleOperationId,
        replacementScheduleVersion:
          replacementJob === null
            ? null
            : newScheduleVersion,
        replacedJobVersion:
          resultingOldJobVersion,
        replacementJobVersion:
          replacementJob?.version ?? null,
        createdAtMs: recoveryAtMs,
        version: 1,
      });
      recoveryChildren.push(recoveryChild);
      evidenceEffects.push(
        Object.freeze({
          disposition,
          jobType: oldJob.jobType,
          oldJobRunId: oldJob.id,
          oldOccurrenceKey:
            oldJob.occurrenceKey,
          oldScheduleOperationId:
            inspected.generation
              .scheduleOperationId,
          oldScheduleVersion:
            inspected.generation.scheduleVersion,
          newJobRunId:
            replacementJob?.id ?? null,
          newOccurrenceKey:
            replacementJob?.occurrenceKey ?? null,
          newScheduleOperationId:
            replacementJob === null
              ? null
              : newScheduleOperationId,
          newScheduleVersion:
            replacementJob === null
              ? null
              : newScheduleVersion,
        })
      );
    }
  }

  return deepFreeze({
    oldJobCas,
    replacementJobs,
    replacementBindings,
    recoveryChildren,
    evidenceEffects,
  });
}

function createFreeAgentDraftScheduleRecoveryService({
  secureRandom,
} = {}) {
  if (
    !secureRandom ||
    typeof secureRandom.id !== "function"
  ) {
    throw new TypeError(
      "createFreeAgentDraftScheduleRecoveryService requires secure identifier generation"
    );
  }

  function planRecovery(context = {}) {
    const inspected = inspectContext(context);
    const decision = recoveryDecision(inspected);

    if (!decision.recoveryRequired) {
      return deepFreeze({
        action: "no_op",
        recoveryRequired: false,
        recoveryKind: decision.recoveryKind,
        decision,
      });
    }

    const removedWeekCount =
      decision.mondayAdvanceCount;
    const firstWeekStartsAtMs =
      recoveredWeekOneStartsAtMs(decision);
    if (
      removedWeekCount < 1 ||
      removedWeekCount >= inspected.weeks.length ||
      inspected.weeks[removedWeekCount]
        .startsAtMs !== firstWeekStartsAtMs
    ) {
      failState("removed_week_prefix_invalid");
    }

    let regenerated;
    try {
      regenerated = planExplicitMatchupSchedule({
        teamIds: inspected.participantTeamIds,
        ...inspected.calendar,
        firstWeekStartsAtMs,
        nowMs: inspected.recovery.atMs,
      });
    } catch (error) {
      if (error instanceof MatchupSchedulePolicyError) {
        failState("recovered_schedule_invalid");
      }
      throw error;
    }
    if (
      regenerated.weeks.length !==
        inspected.weeks.length -
          removedWeekCount ||
      regenerated.weeks.at(-1).endsAtMs !==
        inspected.calendar
          .fantasyPlayoffsStartAtMs
    ) {
      failState("recovered_schedule_length_invalid");
    }

    const allocateId = createIdAllocator(
      secureRandom,
      existingIds(inspected)
    );
    const recoveryId = allocateId();
    const operationId = allocateId();
    const newScheduleVersion =
      inspected.generation.scheduleVersion + 1;
    const mappedWeeks = mapRetainedWeeks({
      inspected,
      regenerated,
      removedWeekCount,
    });
    const removals = deletionPlan(
      inspected,
      removedWeekCount
    );

    const recoveryWeekChildren = Object.freeze(
      removals.weeks.map((week) =>
        Object.freeze({
          id: allocateId(),
          leagueId: inspected.leagueId,
          seasonId: inspected.seasonId,
          scheduleRecoveryId: recoveryId,
          removedMatchupWeekId: week.id,
          removedSequence: week.sequence,
          removedStartsAtMs: week.startsAtMs,
          createdAtMs: inspected.recovery.atMs,
        })
      )
    );
    const recoveryMatchupChildren =
      Object.freeze(
        removals.matchups.map((matchup) =>
          Object.freeze({
            id: allocateId(),
            leagueId: inspected.leagueId,
            seasonId: inspected.seasonId,
            scheduleRecoveryId: recoveryId,
            removedMatchupId: matchup.id,
            removedMatchupWeekId:
              matchup.weekId,
            createdAtMs:
              inspected.recovery.atMs,
            version: 1,
          })
        )
      );
    const jobs = buildJobPlan({
      allocateId,
      inspected,
      mappedWeeks,
      newScheduleOperationId: operationId,
      newScheduleVersion,
      recoveryAtMs: inspected.recovery.atMs,
      recoveryId,
      removedWeekCount,
    });

    const evidenceInput = deepFreeze({
      recoveryId,
      leagueId: inspected.leagueId,
      seasonId: inspected.seasonId,
      fadId: inspected.fadId,
      recoveryKind: inspected.recovery.kind,
      operationId,
      oldScheduleOperationId:
        inspected.generation.scheduleOperationId,
      newScheduleOperationId: operationId,
      oldScheduleVersion:
        inspected.generation.scheduleVersion,
      newScheduleVersion,
      oldFirstMatchupWeekId:
        inspected.weeks[0].id,
      newFirstMatchupWeekId:
        mappedWeeks[0].id,
      oldWeek1StartsAtMs:
        inspected.weeks[0].startsAtMs,
      newWeek1StartsAtMs:
        mappedWeeks[0].startsAtMs,
      completedAtMs: inspected.recovery.atMs,
      removedWeeks: recoveryWeekChildren.map(
        (week) =>
          Object.freeze({
            matchupWeekId:
              week.removedMatchupWeekId,
            sequence: week.removedSequence,
            startsAtMs: week.removedStartsAtMs,
          })
      ),
      removedMatchups:
        recoveryMatchupChildren.map((matchup) =>
          Object.freeze({
            matchupId: matchup.removedMatchupId,
            matchupWeekId:
              matchup.removedMatchupWeekId,
          })
        ),
      jobEffects: jobs.evidenceEffects,
    });
    const sealedEvidence =
      createFreeAgentDraftScheduleRecoveryEvidence(
        evidenceInput
      );
    const replacedJobCount =
      jobs.recoveryChildren.filter(
        ({ disposition }) =>
          disposition === "replaced"
      ).length;
    const cancelledJobCount =
      jobs.recoveryChildren.length -
      replacedJobCount;

    const plan = {
      action: "stage_recovery",
      recoveryRequired: true,
      recoveryKind: inspected.recovery.kind,
      decision,
      scope: Object.freeze({
        leagueId: inspected.leagueId,
        seasonId: inspected.seasonId,
        fadId: inspected.fadId,
      }),
      participantTeamIds:
        inspected.participantTeamIds,
      calendar: inspected.calendar,
      operation: Object.freeze({
        id: operationId,
        leagueId: inspected.leagueId,
        seasonId: inspected.seasonId,
        matchupWeekId: null,
        matchupId: null,
        actorUserId: null,
        operationType: "schedule_generate",
        status: "succeeded",
        reason:
          `fad_${inspected.recovery.kind}_schedule_recovery`,
        metadata: Object.freeze({
          fadId: inspected.fadId,
          recoveryId,
          recoveryKind:
            inspected.recovery.kind,
          oldScheduleOperationId:
            inspected.generation
              .scheduleOperationId,
          oldScheduleVersion:
            inspected.generation.scheduleVersion,
          newScheduleVersion,
        }),
        startedAtMs: inspected.recovery.atMs,
        completedAtMs: inspected.recovery.atMs,
      }),
      generation: Object.freeze({
        expectedCurrent:
          inspected.generation,
        superseded: Object.freeze({
          ...inspected.generation,
          status: "superseded",
          supersededAtMs:
            inspected.recovery.atMs,
          version:
            inspected.generation.version + 1,
        }),
        replacement: Object.freeze({
          leagueId: inspected.leagueId,
          seasonId: inspected.seasonId,
          scheduleVersion: newScheduleVersion,
          scheduleOperationId: operationId,
          weekOneMatchupWeekId:
            mappedWeeks[0].id,
          weekOneStartsAtMs:
            mappedWeeks[0].startsAtMs,
          status: "current",
          createdAtMs: inspected.recovery.atMs,
          supersededAtMs: null,
          version: 1,
        }),
      }),
      recovery: Object.freeze({
        id: recoveryId,
        leagueId: inspected.leagueId,
        seasonId: inspected.seasonId,
        fadId: inspected.fadId,
        recoveryKind: inspected.recovery.kind,
        matchupOperationId: operationId,
        oldScheduleOperationId:
          inspected.generation.scheduleOperationId,
        newScheduleOperationId: operationId,
        oldFirstMatchupWeekId:
          inspected.weeks[0].id,
        newFirstMatchupWeekId:
          mappedWeeks[0].id,
        oldScheduleVersion:
          inspected.generation.scheduleVersion,
        newScheduleVersion,
        oldWeekOneStartsAtMs:
          inspected.weeks[0].startsAtMs,
        newWeekOneStartsAtMs:
          mappedWeeks[0].startsAtMs,
        removedWeekCount:
          recoveryWeekChildren.length,
        removedMatchupCount:
          recoveryMatchupChildren.length,
        replacedJobCount,
        cancelledJobCount,
        completedAtMs: inspected.recovery.atMs,
        evidenceSchemaVersion:
          FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
        evidenceSha256:
          sealedEvidence.evidenceSha256,
        createdAtMs: inspected.recovery.atMs,
        version: 1,
      }),
      removals,
      mappedWeeks,
      oldJobCas: jobs.oldJobCas,
      replacementJobs: jobs.replacementJobs,
      replacementBindings:
        jobs.replacementBindings,
      recoveryChildren: Object.freeze({
        weeks: recoveryWeekChildren,
        matchups: recoveryMatchupChildren,
        jobs: jobs.recoveryChildren,
      }),
      evidence: Object.freeze({
        input: evidenceInput,
        preimage: sealedEvidence.preimage,
        evidenceSha256:
          sealedEvidence.evidenceSha256,
      }),
    };
    return deepFreeze(plan);
  }

  return Object.freeze({ planRecovery });
}

module.exports = {
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES,
  FreeAgentDraftScheduleRecoveryServiceError,
  createFreeAgentDraftScheduleRecoveryService,
};
