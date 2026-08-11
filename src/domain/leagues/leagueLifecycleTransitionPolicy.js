const {
  sha256Hex,
} = require("../shared/sha256");
const {
  addLocalDays,
  firstEligibleMonday,
} = require("../matchups/matchupSchedulePolicy");

const LEAGUE_LIFECYCLE_TRANSITION_OPERATION =
  "league.lifecycle.transition.v2";
const EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER =
  "execute_scheduled_entry_draft_rollover";
const RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER =
  "retry_scheduled_entry_draft_rollover";
const INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE =
  "authorize_initial_season2_no_draft";
const INITIAL_SEASON2_NO_DRAFT_CONFIRMATION =
  "AUTHORIZE INITIAL SEASON 2 WITHOUT ENTRY DRAFT";
const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 128;
const MAXIMUM_EXEMPTION_REASON_LENGTH = 500;
const MAXIMUM_UTC_TIMESTAMP_MS =
  8_640_000_000_000_000;
const FANTASY_PLAYOFF_DURATION_MS =
  28 * 24 * 60 * 60 * 1000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INVALID_UNICODE_SCALAR_PATTERN =
  /[\uD800-\uDFFF]/u;

const ROLLOVER_IDENTITY_KEYS = Object.freeze([
  "transitionType",
  "entryDraftId",
  "rolloverOccurrenceId",
]);
const EXEMPTION_INPUT_KEYS = Object.freeze([
  "transitionType",
  "seasonId",
  "reason",
  "confirmation",
]);
const REQUEST_BINDING_KEYS = Object.freeze([
  "actorUserId",
  "leagueId",
  "input",
  "expectedDraftVersion",
]);
const SEASON_CALENDAR_KEYS = Object.freeze([
  "nhlSeasonKey",
  "nhlRegularSeasonStartsAtMs",
  "nhlRegularSeasonEndsAtMs",
  "fantasyPlayoffsStartAtMs",
  "fantasyPlayoffsEndAtMs",
]);
const ROLLOVER_CALENDAR_KEYS = Object.freeze([
  "leagueTimeZone",
  "source",
  "target",
  "entryDraftStartsAtMs",
  "attemptedAtMs",
  "weekOneStartsAtMs",
]);

const LEAGUE_LIFECYCLE_TRANSITION_CODES =
  Object.freeze({
    inputInvalid:
      "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID",
    rolloverNotReady: "SEASON_ROLLOVER_NOT_READY",
  });

class LeagueLifecycleTransitionPolicyError
  extends Error {
  constructor(code, reasonCode) {
    super(
      code ===
        LEAGUE_LIFECYCLE_TRANSITION_CODES
          .rolloverNotReady
        ? "The scheduled season rollover is not ready."
        : "The league lifecycle-transition request is invalid."
    );
    this.name =
      "LeagueLifecycleTransitionPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new LeagueLifecycleTransitionPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    LEAGUE_LIFECYCLE_TRANSITION_CODES.inputInvalid,
    reasonCode
  );
}

function failRolloverNotReady(reasonCode) {
  fail(
    LEAGUE_LIFECYCLE_TRANSITION_CODES
      .rolloverNotReady,
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

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string")
  ) {
    return false;
  }
  const expected = new Set(expectedKeys);
  return keys.every((key) => expected.has(key));
}

function canonicalUuid(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function validateRolloverIdentity(
  value,
  transitionType
) {
  if (!hasExactKeys(value, ROLLOVER_IDENTITY_KEYS)) {
    failInput("body_invalid");
  }
  if (value.transitionType !== transitionType) {
    failInput("transition_type_invalid");
  }
  return Object.freeze({
    transitionType,
    entryDraftId: canonicalUuid(
      value.entryDraftId,
      "entry_draft_id_invalid"
    ),
    rolloverOccurrenceId: canonicalUuid(
      value.rolloverOccurrenceId,
      "rollover_occurrence_id_invalid"
    ),
  });
}

function validateScheduledEntryDraftRolloverInput(
  value
) {
  return validateRolloverIdentity(
    value,
    EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER
  );
}

function validateRetryInput(value) {
  return validateRolloverIdentity(
    value,
    RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
  );
}

function validateExemptionInput(value) {
  if (!hasExactKeys(value, EXEMPTION_INPUT_KEYS)) {
    failInput("body_invalid");
  }
  if (
    value.transitionType !==
    INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE
  ) {
    failInput("transition_type_invalid");
  }
  const seasonId = canonicalUuid(
    value.seasonId,
    "season_id_invalid"
  );
  if (
    typeof value.reason !== "string" ||
    Array.from(value.reason).length < 1 ||
    Array.from(value.reason).length >
      MAXIMUM_EXEMPTION_REASON_LENGTH ||
    value.reason !== value.reason.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value.reason) ||
    INVALID_UNICODE_SCALAR_PATTERN.test(value.reason)
  ) {
    failInput("reason_invalid");
  }
  if (
    value.confirmation !==
    INITIAL_SEASON2_NO_DRAFT_CONFIRMATION
  ) {
    failInput("confirmation_invalid");
  }
  return Object.freeze({
    transitionType:
      INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
    seasonId,
    reason: value.reason,
    confirmation:
      INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
  });
}

function validateLeagueLifecycleTransitionInput(value) {
  if (!isPlainObject(value)) {
    failInput("body_invalid");
  }
  if (
    value.transitionType ===
    RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
  ) {
    return validateRetryInput(value);
  }
  if (
    value.transitionType ===
    INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE
  ) {
    return validateExemptionInput(value);
  }
  failInput("transition_type_invalid");
}

function validateLeagueLifecycleTransitionLeagueId(
  value
) {
  return canonicalUuid(value, "league_id_invalid");
}

function validateLeagueLifecycleTransitionActorUserId(
  value
) {
  return canonicalUuid(
    value,
    "actor_user_id_invalid"
  );
}

function validateLeagueLifecycleTransitionExpectedVersion(
  value,
  transitionType
) {
  if (
    transitionType ===
    RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
  ) {
    if (!Number.isSafeInteger(value) || value < 1) {
      failInput("expected_draft_version_invalid");
    }
    return value;
  }
  if (
    transitionType ===
    INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE
  ) {
    if (value !== null) {
      failInput("if_match_forbidden");
    }
    return null;
  }
  failInput("transition_type_invalid");
}

function validateLeagueLifecycleTransitionIdempotencyKey(
  value
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAXIMUM_IDEMPOTENCY_KEY_LENGTH ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    failInput("idempotency_key_invalid");
  }
  return value;
}

function canonicalNhlSeasonStartYear(
  value,
  onInvalid
) {
  if (
    typeof value !== "string" ||
    !/^\d{8}$/.test(value)
  ) {
    onInvalid();
  }
  const startYear = Number(value.slice(0, 4));
  const endYear = Number(value.slice(4));
  if (endYear !== startYear + 1) {
    onInvalid();
  }
  return startYear;
}

function deriveCanonicalNextNhlSeason(
  sourceNhlSeasonKey
) {
  const sourceStartYear =
    canonicalNhlSeasonStartYear(
      sourceNhlSeasonKey,
      () =>
        failRolloverNotReady(
          "source_nhl_season_key_invalid"
        )
    );
  const targetStartYear = sourceStartYear + 1;
  const targetEndYear = targetStartYear + 1;
  if (
    targetStartYear > 9_999 ||
    targetEndYear > 9_999
  ) {
    failRolloverNotReady(
      "source_nhl_season_key_exhausted"
    );
  }
  return Object.freeze({
    nhlSeasonKey:
      String(targetStartYear).padStart(4, "0") +
      String(targetEndYear).padStart(4, "0"),
    label:
      `${String(targetStartYear).padStart(4, "0")}-` +
      String(targetEndYear % 100).padStart(2, "0"),
  });
}

function validateCanonicalConsecutiveNhlSeason({
  sourceNhlSeasonKey,
  targetNhlSeasonKey,
} = {}) {
  const expected = deriveCanonicalNextNhlSeason(
    sourceNhlSeasonKey
  );
  canonicalNhlSeasonStartYear(
    targetNhlSeasonKey,
    () =>
      failRolloverNotReady(
        "target_nhl_season_key_invalid"
      )
  );
  if (targetNhlSeasonKey !== expected.nhlSeasonKey) {
    failRolloverNotReady(
      "target_nhl_season_key_not_consecutive"
    );
  }
  return expected;
}

function safeUtcTimestamp(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAXIMUM_UTC_TIMESTAMP_MS
  );
}

function utcYear(value) {
  return new Date(value).getUTCFullYear();
}

function calendarHasCanonicalShape(value) {
  return (
    hasExactKeys(value, SEASON_CALENDAR_KEYS) &&
    [
      value.nhlRegularSeasonStartsAtMs,
      value.nhlRegularSeasonEndsAtMs,
      value.fantasyPlayoffsStartAtMs,
      value.fantasyPlayoffsEndAtMs,
    ].every(safeUtcTimestamp) &&
    value.nhlRegularSeasonStartsAtMs <
      value.fantasyPlayoffsStartAtMs &&
    value.fantasyPlayoffsStartAtMs <
      value.fantasyPlayoffsEndAtMs &&
    value.fantasyPlayoffsEndAtMs ===
      value.nhlRegularSeasonEndsAtMs &&
    value.fantasyPlayoffsEndAtMs -
        value.fantasyPlayoffsStartAtMs ===
      FANTASY_PLAYOFF_DURATION_MS
  );
}

function calendarMatchesNhlSeasonKey(
  value,
  startYear
) {
  const endYear = startYear + 1;
  return (
    utcYear(value.nhlRegularSeasonStartsAtMs) ===
      startYear &&
    utcYear(value.fantasyPlayoffsStartAtMs) ===
      endYear &&
    utcYear(value.fantasyPlayoffsEndAtMs) ===
      endYear &&
    utcYear(value.nhlRegularSeasonEndsAtMs) ===
      endYear
  );
}

function normalizeRolloverCalendarSeason(
  value,
  role
) {
  if (!calendarHasCanonicalShape(value)) {
    failRolloverNotReady(
      `${role}_calendar_invalid`
    );
  }
  const startYear = canonicalNhlSeasonStartYear(
    value.nhlSeasonKey,
    () =>
      failRolloverNotReady(
        `${role}_nhl_season_key_invalid`
      )
  );
  if (
    !calendarMatchesNhlSeasonKey(value, startYear)
  ) {
    failRolloverNotReady(
      `${role}_calendar_identity_invalid`
    );
  }
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
  });
}

function canonicalLeagueTimeZone(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    value !== value.trim()
  ) {
    failRolloverNotReady(
      "league_timezone_invalid"
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).format(0);
  } catch {
    failRolloverNotReady(
      "league_timezone_invalid"
    );
  }
  return value;
}

function validateSeasonRolloverCalendar(value) {
  if (!hasExactKeys(value, ROLLOVER_CALENDAR_KEYS)) {
    failRolloverNotReady(
      "rollover_calendar_invalid"
    );
  }
  const source = normalizeRolloverCalendarSeason(
    value.source,
    "source"
  );
  const target = normalizeRolloverCalendarSeason(
    value.target,
    "target"
  );
  const targetIdentity =
    validateCanonicalConsecutiveNhlSeason({
      sourceNhlSeasonKey: source.nhlSeasonKey,
      targetNhlSeasonKey: target.nhlSeasonKey,
    });
  const timestamps = [
    value.entryDraftStartsAtMs,
    value.attemptedAtMs,
    value.weekOneStartsAtMs,
  ];
  if (!timestamps.every(safeUtcTimestamp)) {
    failRolloverNotReady("rollover_time_invalid");
  }
  const leagueTimeZone =
    canonicalLeagueTimeZone(
      value.leagueTimeZone
    );
  if (
    value.entryDraftStartsAtMs <
    source.nhlRegularSeasonEndsAtMs
  ) {
    failRolloverNotReady(
      "entry_draft_precedes_source_end"
    );
  }
  if (
    value.attemptedAtMs <
    value.entryDraftStartsAtMs
  ) {
    failRolloverNotReady(
      "scheduled_occurrence_not_due"
    );
  }
  if (
    target.nhlRegularSeasonStartsAtMs <=
      source.nhlRegularSeasonEndsAtMs ||
    value.entryDraftStartsAtMs >=
      target.nhlRegularSeasonStartsAtMs
  ) {
    failRolloverNotReady(
      "target_calendar_overlaps_transition"
    );
  }
  if (
    firstEligibleMonday(
      value.weekOneStartsAtMs,
      leagueTimeZone
    ) !== value.weekOneStartsAtMs
  ) {
    failRolloverNotReady(
      "target_week_one_boundary_invalid"
    );
  }
  const weekOneEndsAtMs = addLocalDays(
    value.weekOneStartsAtMs,
    7,
    leagueTimeZone
  );
  if (
    value.weekOneStartsAtMs <
      target.nhlRegularSeasonStartsAtMs ||
    weekOneEndsAtMs >
      target.fantasyPlayoffsStartAtMs
  ) {
    failRolloverNotReady(
      "target_week_one_not_feasible"
    );
  }
  return Object.freeze({
    leagueTimeZone,
    source,
    target,
    targetIdentity,
    entryDraftStartsAtMs:
      value.entryDraftStartsAtMs,
    attemptedAtMs: value.attemptedAtMs,
    weekOneStartsAtMs:
      value.weekOneStartsAtMs,
  });
}

function serializeLeagueLifecycleTransitionRequest(
  value
) {
  if (!hasExactKeys(value, REQUEST_BINDING_KEYS)) {
    failInput("request_binding_invalid");
  }
  const actorUserId =
    validateLeagueLifecycleTransitionActorUserId(
      value.actorUserId
    );
  const leagueId =
    validateLeagueLifecycleTransitionLeagueId(
      value.leagueId
    );
  const input =
    validateLeagueLifecycleTransitionInput(
      value.input
    );
  const expectedDraftVersion =
    validateLeagueLifecycleTransitionExpectedVersion(
      value.expectedDraftVersion,
      input.transitionType
    );
  return JSON.stringify({
    actorUserId,
    expectedDraftVersion,
    input,
    leagueId,
    operation:
      LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
  });
}

function leagueLifecycleTransitionRequestHash(value) {
  return sha256Hex(
    serializeLeagueLifecycleTransitionRequest(value)
  );
}

module.exports = {
  EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  EXEMPTION_INPUT_KEYS,
  FANTASY_PLAYOFF_DURATION_MS,
  FORBIDDEN_TEXT_PATTERN,
  INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
  INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
  INVALID_UNICODE_SCALAR_PATTERN,
  LEAGUE_LIFECYCLE_TRANSITION_CODES,
  LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
  LeagueLifecycleTransitionPolicyError,
  MAXIMUM_EXEMPTION_REASON_LENGTH,
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  MAXIMUM_UTC_TIMESTAMP_MS,
  REQUEST_BINDING_KEYS,
  RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  ROLLOVER_CALENDAR_KEYS,
  ROLLOVER_IDENTITY_KEYS,
  SEASON_CALENDAR_KEYS,
  UUID_PATTERN,
  deriveCanonicalNextNhlSeason,
  leagueLifecycleTransitionRequestHash,
  serializeLeagueLifecycleTransitionRequest,
  validateCanonicalConsecutiveNhlSeason,
  validateLeagueLifecycleTransitionActorUserId,
  validateLeagueLifecycleTransitionExpectedVersion,
  validateLeagueLifecycleTransitionIdempotencyKey,
  validateLeagueLifecycleTransitionInput,
  validateLeagueLifecycleTransitionLeagueId,
  validateScheduledEntryDraftRolloverInput,
  validateSeasonRolloverCalendar,
};
