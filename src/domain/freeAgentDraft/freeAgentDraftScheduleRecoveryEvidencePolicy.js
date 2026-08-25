const {
  compareUnicodeScalarStrings,
  hashCanonicalJsonV1,
} = require("../leagues/seasonRolloverEvidencePolicy");

const FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_DOMAIN =
  "hundo-leago.fad-schedule-recovery";
const FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_SCHEMA_VERSION = 1;
const FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_SCHEDULE_RECOVERY_EVIDENCE_INPUT_INVALID",
  });
const RECOVERY_KINDS = new Set([
  "pre_open",
  "completion",
]);
const JOB_DISPOSITIONS = new Set([
  "replaced",
  "cancelled",
]);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const INPUT_KEYS = Object.freeze([
  "recoveryId",
  "leagueId",
  "seasonId",
  "fadId",
  "recoveryKind",
  "operationId",
  "oldScheduleOperationId",
  "newScheduleOperationId",
  "oldScheduleVersion",
  "newScheduleVersion",
  "oldFirstMatchupWeekId",
  "newFirstMatchupWeekId",
  "oldWeek1StartsAtMs",
  "newWeek1StartsAtMs",
  "completedAtMs",
  "removedWeeks",
  "removedMatchups",
  "jobEffects",
]);
const REMOVED_WEEK_KEYS = Object.freeze([
  "matchupWeekId",
  "sequence",
  "startsAtMs",
]);
const REMOVED_MATCHUP_KEYS = Object.freeze([
  "matchupId",
  "matchupWeekId",
]);
const JOB_EFFECT_KEYS = Object.freeze([
  "disposition",
  "jobType",
  "oldJobRunId",
  "oldOccurrenceKey",
  "oldScheduleOperationId",
  "oldScheduleVersion",
  "newJobRunId",
  "newOccurrenceKey",
  "newScheduleOperationId",
  "newScheduleVersion",
]);

class FreeAgentDraftScheduleRecoveryEvidencePolicyError
  extends Error {
  constructor(reasonCode) {
    super(
      "The Free Agent Draft schedule-recovery evidence is invalid."
    );
    this.name =
      "FreeAgentDraftScheduleRecoveryEvidencePolicyError";
    this.code =
      FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_CODES
        .inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new FreeAgentDraftScheduleRecoveryEvidencePolicyError(
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

function requireExactObject(value, keys, reasonCode) {
  if (!isPlainObject(value)) fail(reasonCode);
  const actual = Object.keys(value).sort(
    compareUnicodeScalarStrings
  );
  const expected = [...keys].sort(
    compareUnicodeScalarStrings
  );
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    fail(reasonCode);
  }
  return value;
}

function stableUuid(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    fail(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    fail(reasonCode);
  }
  return value;
}

function boundedText(value, maximum, reasonCode) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function normalizeRemovedWeeks(value) {
  if (!Array.isArray(value) || value.length < 1) {
    fail("removed_weeks_invalid");
  }
  const weeks = value.map((candidate) => {
    const week = requireExactObject(
      candidate,
      REMOVED_WEEK_KEYS,
      "removed_week_fields_invalid"
    );
    return {
      matchupWeekId: stableUuid(
        week.matchupWeekId,
        "removed_week_id_invalid"
      ),
      sequence: positiveInteger(
        week.sequence,
        "removed_week_sequence_invalid"
      ),
      startsAtMs: safeTimestamp(
        week.startsAtMs,
        "removed_week_start_invalid"
      ),
    };
  });
  weeks.sort((left, right) =>
    left.sequence - right.sequence ||
    compareUnicodeScalarStrings(
      left.matchupWeekId,
      right.matchupWeekId
    )
  );
  const weekIds = new Set();
  let previousStart = null;
  for (let index = 0; index < weeks.length; index += 1) {
    const week = weeks[index];
    if (
      week.sequence !== index + 1 ||
      weekIds.has(week.matchupWeekId) ||
      (
        previousStart !== null &&
        week.startsAtMs <= previousStart
      )
    ) {
      fail("removed_weeks_not_contiguous");
    }
    weekIds.add(week.matchupWeekId);
    previousStart = week.startsAtMs;
  }
  return weeks;
}

function normalizeRemovedMatchups(value, removedWeekSequence) {
  if (!Array.isArray(value)) {
    fail("removed_matchups_invalid");
  }
  const matchups = value.map((candidate) => {
    const matchup = requireExactObject(
      candidate,
      REMOVED_MATCHUP_KEYS,
      "removed_matchup_fields_invalid"
    );
    const normalized = {
      matchupId: stableUuid(
        matchup.matchupId,
        "removed_matchup_id_invalid"
      ),
      matchupWeekId: stableUuid(
        matchup.matchupWeekId,
        "removed_matchup_week_id_invalid"
      ),
    };
    if (!removedWeekSequence.has(normalized.matchupWeekId)) {
      fail("removed_matchup_week_unknown");
    }
    return normalized;
  });
  matchups.sort((left, right) =>
    removedWeekSequence.get(left.matchupWeekId) -
      removedWeekSequence.get(right.matchupWeekId) ||
    compareUnicodeScalarStrings(
      left.matchupId,
      right.matchupId
    )
  );
  const matchupIds = new Set();
  for (const matchup of matchups) {
    if (matchupIds.has(matchup.matchupId)) {
      fail("removed_matchup_id_duplicate");
    }
    matchupIds.add(matchup.matchupId);
  }
  return matchups;
}

function normalizeReplacementFields(effect) {
  const values = [
    effect.newJobRunId,
    effect.newOccurrenceKey,
    effect.newScheduleOperationId,
    effect.newScheduleVersion,
  ];
  if (effect.disposition === "cancelled") {
    if (values.some((value) => value !== null)) {
      fail("cancelled_job_replacement_not_null");
    }
    return {
      newJobRunId: null,
      newOccurrenceKey: null,
      newScheduleOperationId: null,
      newScheduleVersion: null,
    };
  }
  if (values.some((value) => value === null)) {
    fail("replaced_job_replacement_incomplete");
  }
  return {
    newJobRunId: stableUuid(
      effect.newJobRunId,
      "new_job_run_id_invalid"
    ),
    newOccurrenceKey: boundedText(
      effect.newOccurrenceKey,
      1_000,
      "new_occurrence_key_invalid"
    ),
    newScheduleOperationId: stableUuid(
      effect.newScheduleOperationId,
      "new_job_schedule_operation_id_invalid"
    ),
    newScheduleVersion: positiveInteger(
      effect.newScheduleVersion,
      "new_job_schedule_version_invalid"
    ),
  };
}

function normalizeJobEffects(
  value,
  {
    oldScheduleOperationId,
    newScheduleOperationId,
    oldScheduleVersion,
    newScheduleVersion,
  }
) {
  if (!Array.isArray(value)) {
    fail("job_effects_invalid");
  }
  const effects = value.map((candidate) => {
    const effect = requireExactObject(
      candidate,
      JOB_EFFECT_KEYS,
      "job_effect_fields_invalid"
    );
    if (!JOB_DISPOSITIONS.has(effect.disposition)) {
      fail("job_effect_disposition_invalid");
    }
    const normalized = {
      disposition: effect.disposition,
      jobType: boundedText(
        effect.jobType,
        100,
        "job_type_invalid"
      ),
      oldJobRunId: stableUuid(
        effect.oldJobRunId,
        "old_job_run_id_invalid"
      ),
      oldOccurrenceKey: boundedText(
        effect.oldOccurrenceKey,
        1_000,
        "old_occurrence_key_invalid"
      ),
      oldScheduleOperationId: stableUuid(
        effect.oldScheduleOperationId,
        "old_job_schedule_operation_id_invalid"
      ),
      oldScheduleVersion: positiveInteger(
        effect.oldScheduleVersion,
        "old_job_schedule_version_invalid"
      ),
      ...normalizeReplacementFields(effect),
    };
    if (
      normalized.oldScheduleOperationId !==
        oldScheduleOperationId ||
      normalized.oldScheduleVersion !==
        oldScheduleVersion ||
      (
        normalized.disposition === "replaced" &&
        (
          normalized.newScheduleOperationId !==
            newScheduleOperationId ||
          normalized.newScheduleVersion !==
            newScheduleVersion ||
          normalized.newJobRunId ===
            normalized.oldJobRunId ||
          normalized.newOccurrenceKey ===
            normalized.oldOccurrenceKey
        )
      )
    ) {
      fail("job_effect_generation_invalid");
    }
    return normalized;
  });
  effects.sort((left, right) =>
    compareUnicodeScalarStrings(
      left.oldOccurrenceKey,
      right.oldOccurrenceKey
    ) ||
    compareUnicodeScalarStrings(
      left.oldJobRunId,
      right.oldJobRunId
    )
  );
  const oldJobIds = new Set();
  const oldOccurrenceKeys = new Set();
  const newJobIds = new Set();
  const newOccurrenceKeys = new Set();
  for (const effect of effects) {
    if (
      oldJobIds.has(effect.oldJobRunId) ||
      oldOccurrenceKeys.has(effect.oldOccurrenceKey)
    ) {
      fail("old_job_effect_duplicate");
    }
    oldJobIds.add(effect.oldJobRunId);
    oldOccurrenceKeys.add(effect.oldOccurrenceKey);
    if (effect.disposition === "replaced") {
      if (
        newJobIds.has(effect.newJobRunId) ||
        newOccurrenceKeys.has(effect.newOccurrenceKey)
      ) {
        fail("new_job_effect_duplicate");
      }
      newJobIds.add(effect.newJobRunId);
      newOccurrenceKeys.add(effect.newOccurrenceKey);
    }
  }
  return effects;
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

function createFreeAgentDraftScheduleRecoveryEvidence(input = {}) {
  requireExactObject(
    input,
    INPUT_KEYS,
    "recovery_evidence_fields_invalid"
  );
  if (!RECOVERY_KINDS.has(input.recoveryKind)) {
    fail("recovery_kind_invalid");
  }
  const oldScheduleVersion = positiveInteger(
    input.oldScheduleVersion,
    "old_schedule_version_invalid"
  );
  const newScheduleVersion = positiveInteger(
    input.newScheduleVersion,
    "new_schedule_version_invalid"
  );
  if (
    oldScheduleVersion >= Number.MAX_SAFE_INTEGER ||
    newScheduleVersion !== oldScheduleVersion + 1
  ) {
    fail("schedule_version_transition_invalid");
  }
  const operationId = stableUuid(
    input.operationId,
    "operation_id_invalid"
  );
  const oldScheduleOperationId = stableUuid(
    input.oldScheduleOperationId,
    "old_schedule_operation_id_invalid"
  );
  const newScheduleOperationId = stableUuid(
    input.newScheduleOperationId,
    "new_schedule_operation_id_invalid"
  );
  if (
    operationId !== newScheduleOperationId ||
    oldScheduleOperationId === newScheduleOperationId
  ) {
    fail("schedule_operation_transition_invalid");
  }
  const oldFirstMatchupWeekId = stableUuid(
    input.oldFirstMatchupWeekId,
    "old_first_matchup_week_id_invalid"
  );
  const newFirstMatchupWeekId = stableUuid(
    input.newFirstMatchupWeekId,
    "new_first_matchup_week_id_invalid"
  );
  if (oldFirstMatchupWeekId === newFirstMatchupWeekId) {
    fail("first_matchup_week_transition_invalid");
  }
  const oldWeek1StartsAtMs = safeTimestamp(
    input.oldWeek1StartsAtMs,
    "old_week_one_start_invalid"
  );
  const newWeek1StartsAtMs = safeTimestamp(
    input.newWeek1StartsAtMs,
    "new_week_one_start_invalid"
  );
  if (newWeek1StartsAtMs <= oldWeek1StartsAtMs) {
    fail("week_one_start_transition_invalid");
  }

  const removedWeeks = normalizeRemovedWeeks(
    input.removedWeeks
  );
  if (
    removedWeeks[0].matchupWeekId !==
      oldFirstMatchupWeekId ||
    removedWeeks[0].startsAtMs !==
      oldWeek1StartsAtMs ||
    removedWeeks.some(
      (week) =>
        week.matchupWeekId === newFirstMatchupWeekId ||
        week.startsAtMs >= newWeek1StartsAtMs
    )
  ) {
    fail("removed_week_transition_invalid");
  }
  const removedWeekSequence = new Map(
    removedWeeks.map((week) => [
      week.matchupWeekId,
      week.sequence,
    ])
  );
  const removedMatchups = normalizeRemovedMatchups(
    input.removedMatchups,
    removedWeekSequence
  );
  const jobEffects = normalizeJobEffects(
    input.jobEffects,
    {
      oldScheduleOperationId,
      newScheduleOperationId,
      oldScheduleVersion,
      newScheduleVersion,
    }
  );

  const preimage = deepFreeze({
    domain:
      FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_DOMAIN,
    schemaVersion:
      FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
    recoveryId: stableUuid(
      input.recoveryId,
      "recovery_id_invalid"
    ),
    leagueId: stableUuid(
      input.leagueId,
      "league_id_invalid"
    ),
    seasonId: stableUuid(
      input.seasonId,
      "season_id_invalid"
    ),
    fadId: stableUuid(input.fadId, "fad_id_invalid"),
    recoveryKind: input.recoveryKind,
    operationId,
    oldScheduleOperationId,
    newScheduleOperationId,
    oldScheduleVersion,
    newScheduleVersion,
    oldFirstMatchupWeekId,
    newFirstMatchupWeekId,
    oldWeek1StartsAtMs,
    newWeek1StartsAtMs,
    completedAtMs: safeTimestamp(
      input.completedAtMs,
      "completed_at_ms_invalid"
    ),
    removedWeeks,
    removedMatchups,
    jobEffects,
  });
  return Object.freeze({
    preimage,
    evidenceSha256: hashCanonicalJsonV1(preimage),
  });
}

module.exports = {
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_CODES,
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_DOMAIN,
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  FreeAgentDraftScheduleRecoveryEvidencePolicyError,
  createFreeAgentDraftScheduleRecoveryEvidence,
};
