const {
  sha256Hex,
} = require("../shared/sha256");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INVALID_UNICODE_SCALAR_PATTERN =
  /[\ud800-\udfff]/u;

const ENTRY_DRAFT_SCHEDULE_OPERATION =
  "entry_draft.schedule.v1";
const ENTRY_DRAFT_SCHEDULE_ACTION =
  "schedule";
const ENTRY_DRAFT_RESCHEDULE_ACTION =
  "reschedule";
const ENTRY_DRAFT_SCHEDULE_CONFIRMATION =
  "SCHEDULE ENTRY DRAFT";
const ENTRY_DRAFT_RESCHEDULE_CONFIRMATION =
  "RESCHEDULE ENTRY DRAFT";

const CONFIRMATION_BY_ACTION = Object.freeze({
  [ENTRY_DRAFT_SCHEDULE_ACTION]:
    ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
  [ENTRY_DRAFT_RESCHEDULE_ACTION]:
    ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
});

class EntryDraftSchedulePolicyError extends Error {
  constructor(code, reasonCode) {
    super("The Entry Draft schedule request is invalid.");
    this.name = "EntryDraftSchedulePolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function failInput(reasonCode) {
  throw new EntryDraftSchedulePolicyError(
    "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
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

function validateStableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function validateSafeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput(reasonCode);
  }
  return value;
}

function validateEntryDraftScheduleLeagueId(value) {
  return validateStableId(value, "league_id_invalid");
}

function validateEntryDraftScheduleDraftId(value) {
  return validateStableId(
    value,
    "entry_draft_id_invalid"
  );
}

function validateEntryDraftScheduleExpectedVersion(
  value
) {
  if (!Number.isSafeInteger(value) || value < 1) {
    failInput("expected_version_invalid");
  }
  return value;
}

function validateEntryDraftScheduleIdempotencyKey(
  value
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value) ||
    INVALID_UNICODE_SCALAR_PATTERN.test(value)
  ) {
    failInput("idempotency_key_invalid");
  }
  return value;
}

function validateOptionalReason(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value) ||
    INVALID_UNICODE_SCALAR_PATTERN.test(value)
  ) {
    failInput("reason_invalid");
  }
  return value;
}

function validateEntryDraftScheduleInput(value) {
  if (!isPlainObject(value)) {
    failInput("body_invalid");
  }
  const keys = Object.keys(value).sort();
  const requiredKeys = [
    "action",
    "confirmation",
    "scheduledStartsAtMs",
  ];
  const acceptedKeys =
    value.reason === undefined
      ? requiredKeys
      : [...requiredKeys, "reason"].sort();
  if (
    keys.length !== acceptedKeys.length ||
    keys.some(
      (key, index) => key !== acceptedKeys[index]
    )
  ) {
    failInput("body_fields_invalid");
  }
  const confirmation =
    CONFIRMATION_BY_ACTION[value.action];
  if (!confirmation) {
    failInput("action_invalid");
  }
  if (value.confirmation !== confirmation) {
    failInput("confirmation_invalid");
  }
  return Object.freeze({
    action: value.action,
    scheduledStartsAtMs: validateSafeTimestamp(
      value.scheduledStartsAtMs,
      "scheduled_starts_at_ms_invalid"
    ),
    confirmation,
    reason: validateOptionalReason(value.reason),
  });
}

function validateEntryDraftScheduleFuture({
  scheduledStartsAtMs,
  nowMs,
} = {}) {
  const scheduled = validateSafeTimestamp(
    scheduledStartsAtMs,
    "scheduled_starts_at_ms_invalid"
  );
  const now = validateSafeTimestamp(
    nowMs,
    "now_ms_invalid"
  );
  if (scheduled <= now) {
    throw new EntryDraftSchedulePolicyError(
      "ENTRY_DRAFT_SCHEDULE_NOT_FUTURE",
      "scheduled_starts_at_ms_not_future"
    );
  }
  return scheduled;
}

function serializeEntryDraftScheduleRequest({
  leagueId,
  entryDraftId,
  input,
} = {}) {
  const canonicalLeagueId =
    validateEntryDraftScheduleLeagueId(leagueId);
  const canonicalDraftId =
    validateEntryDraftScheduleDraftId(entryDraftId);
  const canonicalInput =
    validateEntryDraftScheduleInput(input);
  return JSON.stringify({
    operation: ENTRY_DRAFT_SCHEDULE_OPERATION,
    leagueId: canonicalLeagueId,
    entryDraftId: canonicalDraftId,
    action: canonicalInput.action,
    scheduledStartsAtMs:
      canonicalInput.scheduledStartsAtMs,
    confirmation: canonicalInput.confirmation,
    reason: canonicalInput.reason,
  });
}

function entryDraftScheduleRequestHash(value) {
  return sha256Hex(
    serializeEntryDraftScheduleRequest(value)
  );
}

module.exports = {
  ENTRY_DRAFT_RESCHEDULE_ACTION,
  ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
  ENTRY_DRAFT_SCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
  ENTRY_DRAFT_SCHEDULE_OPERATION,
  EntryDraftSchedulePolicyError,
  UUID_PATTERN,
  entryDraftScheduleRequestHash,
  serializeEntryDraftScheduleRequest,
  validateEntryDraftScheduleDraftId,
  validateEntryDraftScheduleExpectedVersion,
  validateEntryDraftScheduleFuture,
  validateEntryDraftScheduleIdempotencyKey,
  validateEntryDraftScheduleInput,
  validateEntryDraftScheduleLeagueId,
};
