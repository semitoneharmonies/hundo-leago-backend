const ENTRY_DRAFT_ROLLOVER_JOB_TYPE =
  "league:entry_draft_rollover";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SEASON_ROLLOVER_JOB_CODES = Object.freeze({
  inputInvalid: "SEASON_ROLLOVER_JOB_INPUT_INVALID",
});

function invalid(reasonCode) {
  const error = new TypeError(
    "The scheduled season-rollover occurrence is invalid."
  );
  error.code =
    SEASON_ROLLOVER_JOB_CODES.inputInvalid;
  error.reasonCode = reasonCode;
  throw error;
}

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(reasonCode);
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid("scheduled_for_ms_invalid");
  }
  return value;
}

function buildSeasonRolloverOccurrenceKey({
  leagueId,
  entryDraftId,
  rolloverOccurrenceId,
  scheduledForMs,
} = {}) {
  const scope = {
    leagueId: stableId(
      leagueId,
      "league_id_invalid"
    ),
    entryDraftId: stableId(
      entryDraftId,
      "entry_draft_id_invalid"
    ),
    rolloverOccurrenceId: stableId(
      rolloverOccurrenceId,
      "rollover_occurrence_id_invalid"
    ),
    scheduledForMs: safeTimestamp(
      scheduledForMs
    ),
  };
  return [
    ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
    scope.leagueId,
    scope.entryDraftId,
    scope.rolloverOccurrenceId,
    scope.scheduledForMs,
  ].join(":");
}

function parseSeasonRolloverOccurrenceKey({
  leagueId,
  entryDraftId,
  rolloverOccurrenceId,
  occurrenceKey,
  scheduledForMs,
} = {}) {
  const canonicalLeagueId = stableId(
    leagueId,
    "league_id_invalid"
  );
  const canonicalEntryDraftId = stableId(
    entryDraftId,
    "entry_draft_id_invalid"
  );
  const canonicalRolloverOccurrenceId =
    stableId(
      rolloverOccurrenceId,
      "rollover_occurrence_id_invalid"
    );
  const canonicalScheduledForMs =
    safeTimestamp(scheduledForMs);
  if (
    typeof occurrenceKey !== "string" ||
    occurrenceKey.length < 1 ||
    occurrenceKey.length > 300
  ) {
    invalid("occurrence_key_invalid");
  }
  const prefix =
    `${ENTRY_DRAFT_ROLLOVER_JOB_TYPE}:` +
    `${canonicalLeagueId}:`;
  if (!occurrenceKey.startsWith(prefix)) {
    invalid("occurrence_key_scope_mismatch");
  }
  const remainder = occurrenceKey.slice(
    prefix.length
  );
  const parts = remainder.split(":");
  if (parts.length !== 3) {
    invalid("occurrence_key_invalid");
  }
  const parsedEntryDraftId = stableId(
    parts[0],
    "entry_draft_id_invalid"
  );
  const parsedRolloverOccurrenceId = stableId(
    parts[1],
    "rollover_occurrence_id_invalid"
  );
  if (
    parsedEntryDraftId !==
      canonicalEntryDraftId ||
    parsedRolloverOccurrenceId !==
      canonicalRolloverOccurrenceId
  ) {
    invalid("occurrence_key_scope_mismatch");
  }
  if (
    parts[2] !==
    String(canonicalScheduledForMs)
  ) {
    invalid("occurrence_key_time_mismatch");
  }
  const canonical = buildSeasonRolloverOccurrenceKey({
    leagueId: canonicalLeagueId,
    entryDraftId: canonicalEntryDraftId,
    rolloverOccurrenceId:
      canonicalRolloverOccurrenceId,
    scheduledForMs: canonicalScheduledForMs,
  });
  if (canonical !== occurrenceKey) {
    invalid("occurrence_key_noncanonical");
  }
  return Object.freeze({
    jobType: ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
    leagueId: canonicalLeagueId,
    entryDraftId: canonicalEntryDraftId,
    rolloverOccurrenceId:
      canonicalRolloverOccurrenceId,
    scheduledForMs: canonicalScheduledForMs,
  });
}

module.exports = {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
  SEASON_ROLLOVER_JOB_CODES,
  buildSeasonRolloverOccurrenceKey,
  parseSeasonRolloverOccurrenceKey,
};
