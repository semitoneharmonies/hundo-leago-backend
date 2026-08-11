const {
  FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
  FREE_AGENT_DRAFT_DAY_MS,
  FREE_AGENT_DRAFT_EXTENSION_REASONS,
  FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
  UUID_PATTERN,
} = require("./freeAgentDraftPolicy");
const {
  MAXIMUM_UTC_TIMESTAMP_MS,
  addLocalDays,
  firstEligibleMonday,
} = require("../matchups/matchupSchedulePolicy");

const FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_SCHEDULE_RECOVERY_INPUT_INVALID",
    clockInvalid:
      "FAD_SCHEDULE_RECOVERY_CLOCK_INVALID",
    calendarInvalid:
      "FAD_SCHEDULE_RECOVERY_CALENDAR_INVALID",
    recoveryUnavailable:
      "FAD_SCHEDULE_RECOVERY_UNAVAILABLE",
    extensionInvalid:
      "FAD_SCHEDULE_EXTENSION_INVALID",
  });

class FreeAgentDraftScheduleRecoveryPolicyError
  extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft schedule recovery state is invalid."
    );
    this.name =
      "FreeAgentDraftScheduleRecoveryPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftScheduleRecoveryPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
      .inputInvalid,
    reasonCode
  );
}

function failClock(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
      .clockInvalid,
    reasonCode
  );
}

function failCalendar(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
      .calendarInvalid,
    reasonCode
  );
}

function failUnavailable(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
      .recoveryUnavailable,
    reasonCode
  );
}

function failExtension(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
      .extensionInvalid,
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

function requireExactObject(
  value,
  keys,
  reject,
  reasonCode
) {
  if (!isPlainObject(value)) {
    reject("input_invalid");
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some(
      (key, index) =>
        key !== expectedKeys[index]
    )
  ) {
    reject(reasonCode);
  }
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

function safeTimestamp(
  value,
  reasonCode,
  reject = failInput
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_UTC_TIMESTAMP_MS
  ) {
    reject(reasonCode);
  }
  return value;
}

function safePositiveInteger(
  value,
  reasonCode,
  reject = failInput
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    reject(reasonCode);
  }
  return value;
}

function safeTimestampAdd(
  timestampMs,
  deltaMs,
  reasonCode,
  reject
) {
  const result = timestampMs + deltaMs;
  if (
    !Number.isSafeInteger(result) ||
    result < 0 ||
    result > MAXIMUM_UTC_TIMESTAMP_MS
  ) {
    reject(reasonCode);
  }
  return result;
}

function stableUuid(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failExtension(reasonCode);
  }
  return value;
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateTimeZone(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100
  ) {
    failInput("time_zone_invalid");
  }
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).format(0);
  } catch {
    failInput("time_zone_invalid");
  }
  return value;
}

function isLocalMondayMidnight(
  timestampMs,
  timeZone
) {
  return (
    firstEligibleMonday(
      timestampMs,
      timeZone
    ) === timestampMs
  );
}

function requireLocalMonday(
  timestampMs,
  timeZone,
  reasonCode
) {
  if (
    !isLocalMondayMidnight(
      timestampMs,
      timeZone
    )
  ) {
    failCalendar(reasonCode);
  }
}

function nextLocalMonday(
  timestampMs,
  timeZone,
  reasonCode
) {
  let result;
  try {
    result = addLocalDays(
      timestampMs,
      7,
      timeZone
    );
  } catch {
    failCalendar(reasonCode);
  }
  if (
    !Number.isSafeInteger(result) ||
    result <= timestampMs ||
    result > MAXIMUM_UTC_TIMESTAMP_MS ||
    !isLocalMondayMidnight(result, timeZone)
  ) {
    failCalendar(reasonCode);
  }
  return result;
}

function requireWeekFitsBeforePlayoffs({
  firstWeekStartsAtMs,
  fantasyPlayoffsStartAtMs,
  timeZone,
  unavailableReasonCode,
}) {
  requireLocalMonday(
    firstWeekStartsAtMs,
    timeZone,
    "first_week_not_local_monday"
  );
  requireLocalMonday(
    fantasyPlayoffsStartAtMs,
    timeZone,
    "fantasy_playoffs_not_local_monday"
  );
  if (
    firstWeekStartsAtMs >=
    fantasyPlayoffsStartAtMs
  ) {
    failUnavailable(unavailableReasonCode);
  }
  const firstWeekEndsAtMs =
    nextLocalMonday(
      firstWeekStartsAtMs,
      timeZone,
      "week_boundary_invalid"
    );
  if (
    firstWeekEndsAtMs >
    fantasyPlayoffsStartAtMs
  ) {
    failUnavailable(unavailableReasonCode);
  }
}

function requireCandidateWindow(
  firstWeekStartsAtMs
) {
  const candidateDeadlineAtMs =
    safeTimestampAdd(
      firstWeekStartsAtMs,
      -FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
      "candidate_deadline_underflow",
      failClock
    );
  const initialPeriodEndsAtMs =
    safeTimestampAdd(
      candidateDeadlineAtMs,
      FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
      "initial_period_time_overflow",
      failClock
    );
  if (
    initialPeriodEndsAtMs !==
    firstWeekStartsAtMs
  ) {
    failClock(
      "initial_period_must_end_at_week_one"
    );
  }
  return {
    candidateDeadlineAtMs,
    initialPeriodEndsAtMs,
  };
}

function planFreeAgentDraftPreOpenScheduleRecovery(
  input = {}
) {
  requireExactObject(
    input,
    [
      "readinessAtMs",
      "firstWeekStartsAtMs",
      "fantasyPlayoffsStartAtMs",
      "timeZone",
    ],
    failInput,
    "pre_open_fields_invalid"
  );
  const readinessAtMs = safeTimestamp(
    input.readinessAtMs,
    "readiness_at_ms_invalid"
  );
  const previousFirstWeekStartsAtMs =
    safeTimestamp(
      input.firstWeekStartsAtMs,
      "first_week_starts_at_ms_invalid"
    );
  const fantasyPlayoffsStartAtMs =
    safeTimestamp(
      input.fantasyPlayoffsStartAtMs,
      "fantasy_playoffs_start_at_ms_invalid"
    );
  const timeZone = validateTimeZone(
    input.timeZone
  );

  requireWeekFitsBeforePlayoffs({
    firstWeekStartsAtMs:
      previousFirstWeekStartsAtMs,
    fantasyPlayoffsStartAtMs,
    timeZone,
    unavailableReasonCode:
      "pre_open_monday_unavailable",
  });

  let firstWeekStartsAtMs =
    previousFirstWeekStartsAtMs;
  let mondayAdvanceCount = 0;
  let candidateWindow =
    requireCandidateWindow(
      firstWeekStartsAtMs
    );

  while (
    candidateWindow.candidateDeadlineAtMs <=
    readinessAtMs
  ) {
    const nextFirstWeekStartsAtMs =
      nextLocalMonday(
        firstWeekStartsAtMs,
        timeZone,
        "pre_open_monday_advance_invalid"
      );
    requireWeekFitsBeforePlayoffs({
      firstWeekStartsAtMs:
        nextFirstWeekStartsAtMs,
      fantasyPlayoffsStartAtMs,
      timeZone,
      unavailableReasonCode:
        "pre_open_monday_unavailable",
    });
    firstWeekStartsAtMs =
      nextFirstWeekStartsAtMs;
    mondayAdvanceCount += 1;
    candidateWindow =
      requireCandidateWindow(
        firstWeekStartsAtMs
      );
  }

  return deepFreeze({
    recoveryKind: "pre_open",
    recoveryRequired:
      mondayAdvanceCount > 0,
    reasonCode:
      mondayAdvanceCount > 0
        ? "pre_open_week_one_advanced"
        : "pre_open_week_one_unchanged",
    readinessAtMs,
    timeZone,
    fantasyPlayoffsStartAtMs,
    previousFirstWeekStartsAtMs,
    firstWeekStartsAtMs,
    candidateDeadlineAtMs:
      candidateWindow.candidateDeadlineAtMs,
    initialPeriodEndsAtMs:
      candidateWindow.initialPeriodEndsAtMs,
    initialRolloverCount:
      FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
    mondayAdvanceCount,
    removedRegularSeasonWeekCount:
      mondayAdvanceCount,
  });
}

function planFreeAgentDraftCompletionScheduleRecovery(
  input = {}
) {
  requireExactObject(
    input,
    [
      "proposedCompletionAtMs",
      "frozenFadFirstMatchupStartsAtMs",
      "competitionFirstMatchupStartsAtMs",
      "fantasyPlayoffsStartAtMs",
      "timeZone",
    ],
    failInput,
    "completion_fields_invalid"
  );
  const proposedCompletionAtMs =
    safeTimestamp(
      input.proposedCompletionAtMs,
      "proposed_completion_at_ms_invalid"
    );
  const frozenFadFirstMatchupStartsAtMs =
    safeTimestamp(
      input.frozenFadFirstMatchupStartsAtMs,
      "frozen_fad_first_matchup_starts_at_ms_invalid"
    );
  const previousCompetitionFirstMatchupStartsAtMs =
    safeTimestamp(
      input.competitionFirstMatchupStartsAtMs,
      "competition_first_matchup_starts_at_ms_invalid"
    );
  const fantasyPlayoffsStartAtMs =
    safeTimestamp(
      input.fantasyPlayoffsStartAtMs,
      "fantasy_playoffs_start_at_ms_invalid"
    );
  const timeZone = validateTimeZone(
    input.timeZone
  );

  requireLocalMonday(
    frozenFadFirstMatchupStartsAtMs,
    timeZone,
    "frozen_fad_week_one_not_local_monday"
  );
  requireWeekFitsBeforePlayoffs({
    firstWeekStartsAtMs:
      previousCompetitionFirstMatchupStartsAtMs,
    fantasyPlayoffsStartAtMs,
    timeZone,
    unavailableReasonCode:
      "completion_monday_unavailable",
  });
  if (
    previousCompetitionFirstMatchupStartsAtMs <
    frozenFadFirstMatchupStartsAtMs
  ) {
    failCalendar(
      "competition_week_one_already_recovered"
    );
  }
  let competitionFirstMatchupStartsAtMs =
    previousCompetitionFirstMatchupStartsAtMs;
  let mondayAdvanceCount = 0;
  while (
    competitionFirstMatchupStartsAtMs <=
    proposedCompletionAtMs
  ) {
    const nextFirstWeekStartsAtMs =
      nextLocalMonday(
        competitionFirstMatchupStartsAtMs,
        timeZone,
        "completion_monday_advance_invalid"
      );
    requireWeekFitsBeforePlayoffs({
      firstWeekStartsAtMs:
        nextFirstWeekStartsAtMs,
      fantasyPlayoffsStartAtMs,
      timeZone,
      unavailableReasonCode:
        "completion_monday_unavailable",
    });
    competitionFirstMatchupStartsAtMs =
      nextFirstWeekStartsAtMs;
    mondayAdvanceCount += 1;
  }

  return deepFreeze({
    recoveryKind: "completion",
    recoveryRequired:
      mondayAdvanceCount > 0,
    reasonCode:
      mondayAdvanceCount > 0
        ? "completion_week_one_advanced"
        : "completion_before_week_one",
    proposedCompletionAtMs,
    timeZone,
    fantasyPlayoffsStartAtMs,
    frozenFadFirstMatchupStartsAtMs,
    previousCompetitionFirstMatchupStartsAtMs,
    competitionFirstMatchupStartsAtMs,
    historicalFadClockPreserved: true,
    mondayAdvanceCount,
    removedRegularSeasonWeekCount:
      mondayAdvanceCount,
  });
}

function validateExtensionRequirement(value) {
  requireExactObject(
    value,
    [
      "reason",
      "sourceId",
      "requiredRolloverAtMs",
    ],
    failExtension,
    "extension_requirement_fields_invalid"
  );
  if (
    typeof value.reason !== "string" ||
    !FREE_AGENT_DRAFT_EXTENSION_REASONS
      .includes(value.reason)
  ) {
    failExtension("extension_reason_invalid");
  }
  return {
    reason: value.reason,
    sourceId: stableUuid(
      value.sourceId,
      "extension_source_id_invalid"
    ),
    requiredRolloverAtMs: safeTimestamp(
      value.requiredRolloverAtMs,
      "required_rollover_at_ms_invalid",
      failExtension
    ),
  };
}

function planFreeAgentDraftRolloverExtensions(
  input = {}
) {
  requireExactObject(
    input,
    [
      "candidateDeadlineAtMs",
      "existingRolloverCount",
      "requirements",
    ],
    failInput,
    "extension_plan_fields_invalid"
  );
  const candidateDeadlineAtMs =
    safeTimestamp(
      input.candidateDeadlineAtMs,
      "candidate_deadline_at_ms_invalid"
    );
  const existingRolloverCount =
    safePositiveInteger(
      input.existingRolloverCount,
      "existing_rollover_count_invalid",
      failExtension
    );
  if (
    existingRolloverCount <
    FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
  ) {
    failExtension(
      "seven_initial_rollovers_required"
    );
  }
  if (!Array.isArray(input.requirements)) {
    failExtension(
      "extension_requirements_invalid"
    );
  }

  const seenSources = new Set();
  const requirements = input.requirements
    .map(validateExtensionRequirement)
    .map((requirement) => {
      if (seenSources.has(requirement.sourceId)) {
        failExtension(
          "extension_source_id_duplicate"
        );
      }
      seenSources.add(requirement.sourceId);
      const offsetMs =
        requirement.requiredRolloverAtMs -
        candidateDeadlineAtMs;
      if (
        offsetMs <= 0 ||
        offsetMs %
          FREE_AGENT_DRAFT_DAY_MS !==
          0
      ) {
        failExtension(
          "required_rollover_not_contiguous"
        );
      }
      const requiredSequence =
        offsetMs /
        FREE_AGENT_DRAFT_DAY_MS;
      if (
        !Number.isSafeInteger(
          requiredSequence
        ) ||
        requiredSequence < 1
      ) {
        failExtension(
          "required_rollover_sequence_invalid"
        );
      }
      return {
        ...requirement,
        requiredSequence,
      };
    })
    .sort((left, right) =>
      left.requiredSequence -
        right.requiredSequence ||
      compareStrings(left.reason, right.reason) ||
      compareStrings(
        left.sourceId,
        right.sourceId
      )
    );

  const previousLatestRolloverAtMs =
    safeTimestampAdd(
      candidateDeadlineAtMs,
      existingRolloverCount *
        FREE_AGENT_DRAFT_DAY_MS,
      "existing_rollover_time_overflow",
      failExtension
    );
  const latestRequiredRolloverSequence =
    requirements.reduce(
      (latest, requirement) =>
        Math.max(
          latest,
          requirement.requiredSequence
        ),
      existingRolloverCount
    );
  const latestRequiredRolloverAtMs =
    safeTimestampAdd(
      candidateDeadlineAtMs,
      latestRequiredRolloverSequence *
        FREE_AGENT_DRAFT_DAY_MS,
      "required_rollover_time_overflow",
      failExtension
    );

  const extensions = [];
  for (
    let sequence = existingRolloverCount + 1;
    sequence <= latestRequiredRolloverSequence;
    sequence += 1
  ) {
    const opensAtMs = safeTimestampAdd(
      candidateDeadlineAtMs,
      (sequence - 1) *
        FREE_AGENT_DRAFT_DAY_MS,
      "extension_open_time_overflow",
      failExtension
    );
    const rollsOverAtMs = safeTimestampAdd(
      candidateDeadlineAtMs,
      sequence *
        FREE_AGENT_DRAFT_DAY_MS,
      "extension_rollover_time_overflow",
      failExtension
    );
    extensions.push({
      sequence,
      windowKind: "extension",
      opensAtMs,
      creationCutoffAtMs:
        rollsOverAtMs -
        FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
      rollsOverAtMs,
      requiredBy: requirements
        .filter(
          (requirement) =>
            requirement.requiredSequence >=
            sequence
        )
        .map((requirement) => ({
          reason: requirement.reason,
          sourceId: requirement.sourceId,
          requiredRolloverAtMs:
            requirement.requiredRolloverAtMs,
          requiredSequence:
            requirement.requiredSequence,
        })),
    });
  }

  return deepFreeze({
    candidateDeadlineAtMs,
    existingRolloverCount,
    previousLatestRolloverAtMs,
    extensionRequired: extensions.length > 0,
    extensionCount: extensions.length,
    latestRequiredRolloverSequence,
    latestRequiredRolloverAtMs,
    requirements,
    extensions,
  });
}

module.exports = {
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES,
  FreeAgentDraftScheduleRecoveryPolicyError,
  planFreeAgentDraftCompletionScheduleRecovery,
  planFreeAgentDraftPreOpenScheduleRecovery,
  planFreeAgentDraftRolloverExtensions,
};
