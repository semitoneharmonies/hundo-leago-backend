const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require("../leagues/seasonRolloverEvidencePolicy");

const MATCHUP_SCHEDULE_COMMAND_OPERATION =
  "matchup.schedule.generate.v1";
const MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE =
  "matchup_schedule_command";
const MATCHUP_SCHEDULE_COMMAND_REQUEST_DOMAIN =
  "hundo-leago.matchup-schedule-command-request";
const MATCHUP_SCHEDULE_COMMAND_RESPONSE_DOMAIN =
  "hundo-leago.matchup-schedule-command-response";
const MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION = 1;
const MATCHUP_SCHEDULE_COMMAND_HTTP_STATUS = 201;
const MATCHUP_SCHEDULE_COMMAND_CODE =
  "MATCHUP_SCHEDULE_GENERATED";
const MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION =
  "matchup.schedule.shift_week_one.v1";
const MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION =
  "shift_week_one";
const MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_CONFIRMATION =
  "CHANGE WEEK 1 START";
const MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_HTTP_STATUS =
  200;
const MATCHUP_SCHEDULE_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INVALID_UNICODE_SCALAR_PATTERN =
  /[\ud800-\udfff]/u;
const INPUT_FIELDS = Object.freeze([
  "confirmed",
  "fantasyPlayoffsEndAtMs",
  "fantasyPlayoffsStartAtMs",
  "firstWeekStartsAtMs",
  "nhlRegularSeasonEndsAtMs",
  "nhlRegularSeasonStartsAtMs",
]);
const MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_INPUT_FIELDS =
  Object.freeze([
    "action",
    "confirmation",
    "firstWeekStartsAtMs",
  ]);
const MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_RESULT_FIELDS =
  Object.freeze([
    "firstWeekStartsAtMs",
    "lastWeekEndsAtMs",
    "operationId",
    "previousFirstWeekStartsAtMs",
    "replacedJobOccurrenceCount",
    "seasonId",
    "seasonVersion",
    "shiftedWeekCount",
    "weekId",
    "weekVersion",
  ]);

class MatchupScheduleCommandPolicyError extends Error {
  constructor(code, reasonCode) {
    super("The matchup schedule command is invalid.");
    this.name = "MatchupScheduleCommandPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new MatchupScheduleCommandPolicyError(
    "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
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
    fail(reasonCode);
  }
  return value;
}

function validateSafeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(reasonCode);
  }
  return value;
}

function validateMatchupScheduleCommandLeagueId(value) {
  return validateStableId(value, "league_id_invalid");
}

function validateMatchupScheduleCommandSeasonId(value) {
  return validateStableId(value, "season_id_invalid");
}

function validateMatchupScheduleShiftWeekOneWeekId(
  value
) {
  return validateStableId(value, "week_id_invalid");
}

function validateMatchupScheduleCommandExpectedVersion(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    fail("expected_season_version_invalid");
  }
  return value;
}

function validateMatchupScheduleShiftExpectedWeekVersion(
  value
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    fail("expected_week_version_invalid");
  }
  return value;
}

function validateMatchupScheduleCommandIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value) ||
    INVALID_UNICODE_SCALAR_PATTERN.test(value)
  ) {
    fail("idempotency_key_invalid");
  }
  return value;
}

function validateMatchupScheduleConfirmedInput(value) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().length !==
      INPUT_FIELDS.length ||
    Object.keys(value)
      .sort()
      .some(
        (field, index) =>
          field !== INPUT_FIELDS[index]
      )
  ) {
    fail("body_fields_invalid");
  }
  if (value.confirmed !== true) {
    fail("confirmation_required");
  }
  return Object.freeze({
    nhlRegularSeasonStartsAtMs:
      validateSafeTimestamp(
        value.nhlRegularSeasonStartsAtMs,
        "nhl_regular_season_starts_at_ms_invalid"
      ),
    nhlRegularSeasonEndsAtMs:
      validateSafeTimestamp(
        value.nhlRegularSeasonEndsAtMs,
        "nhl_regular_season_ends_at_ms_invalid"
      ),
    fantasyPlayoffsStartAtMs:
      validateSafeTimestamp(
        value.fantasyPlayoffsStartAtMs,
        "fantasy_playoffs_start_at_ms_invalid"
      ),
    fantasyPlayoffsEndAtMs:
      validateSafeTimestamp(
        value.fantasyPlayoffsEndAtMs,
        "fantasy_playoffs_end_at_ms_invalid"
      ),
    firstWeekStartsAtMs:
      validateSafeTimestamp(
        value.firstWeekStartsAtMs,
        "first_week_starts_at_ms_invalid"
      ),
    confirmed: true,
  });
}

function validateMatchupScheduleShiftWeekOneInput(value) {
  const keys = isPlainObject(value)
    ? Object.keys(value).sort()
    : [];
  if (
    !isPlainObject(value) ||
    keys.length !==
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_INPUT_FIELDS
        .length ||
    keys.some(
      (field, index) =>
        field !==
        MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_INPUT_FIELDS[
          index
        ]
    )
  ) {
    fail("shift_body_fields_invalid");
  }
  if (
    value.action !==
    MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION
  ) {
    fail("shift_action_invalid");
  }
  if (
    value.confirmation !==
    MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_CONFIRMATION
  ) {
    fail("shift_confirmation_invalid");
  }
  return Object.freeze({
    action:
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION,
    firstWeekStartsAtMs:
      validateSafeTimestamp(
        value.firstWeekStartsAtMs,
        "first_week_starts_at_ms_invalid"
      ),
    confirmation:
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_CONFIRMATION,
  });
}

function validateMatchupScheduleShiftWeekOneResult(
  value
) {
  const keys = isPlainObject(value)
    ? Object.keys(value).sort()
    : [];
  if (
    !isPlainObject(value) ||
    keys.length !==
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_RESULT_FIELDS
        .length ||
    keys.some(
      (field, index) =>
        field !==
        MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_RESULT_FIELDS[
          index
        ]
    )
  ) {
    fail("shift_response_result_fields_invalid");
  }
  const seasonVersion = value.seasonVersion;
  const weekVersion = value.weekVersion;
  const shiftedWeekCount = value.shiftedWeekCount;
  const replacedJobOccurrenceCount =
    value.replacedJobOccurrenceCount;
  if (
    !Number.isSafeInteger(seasonVersion) ||
    seasonVersion < 1
  ) {
    fail("shift_response_season_version_invalid");
  }
  if (
    !Number.isSafeInteger(weekVersion) ||
    weekVersion < 1
  ) {
    fail("shift_response_week_version_invalid");
  }
  if (
    !Number.isSafeInteger(shiftedWeekCount) ||
    shiftedWeekCount < 1
  ) {
    fail("shift_response_shifted_week_count_invalid");
  }
  if (
    !Number.isSafeInteger(
      replacedJobOccurrenceCount
    ) ||
    replacedJobOccurrenceCount < 0
  ) {
    fail(
      "shift_response_replaced_job_occurrence_count_invalid"
    );
  }
  const previousFirstWeekStartsAtMs =
    validateSafeTimestamp(
      value.previousFirstWeekStartsAtMs,
      "shift_response_previous_first_week_starts_at_ms_invalid"
    );
  const firstWeekStartsAtMs =
    validateSafeTimestamp(
      value.firstWeekStartsAtMs,
      "shift_response_first_week_starts_at_ms_invalid"
    );
  const lastWeekEndsAtMs =
    validateSafeTimestamp(
      value.lastWeekEndsAtMs,
      "shift_response_last_week_ends_at_ms_invalid"
    );
  if (
    previousFirstWeekStartsAtMs ===
      firstWeekStartsAtMs ||
    lastWeekEndsAtMs <= firstWeekStartsAtMs
  ) {
    fail("shift_response_timing_invalid");
  }
  return Object.freeze({
    operationId: validateStableId(
      value.operationId,
      "shift_response_operation_id_invalid"
    ),
    seasonId: validateStableId(
      value.seasonId,
      "shift_response_season_id_invalid"
    ),
    seasonVersion,
    weekId: validateStableId(
      value.weekId,
      "shift_response_week_id_invalid"
    ),
    weekVersion,
    previousFirstWeekStartsAtMs,
    firstWeekStartsAtMs,
    lastWeekEndsAtMs,
    shiftedWeekCount,
    replacedJobOccurrenceCount,
  });
}

function matchupScheduleCommandRequestProjection({
  leagueId,
  seasonId,
  expectedSeasonVersion,
  input,
} = {}) {
  const canonicalInput =
    validateMatchupScheduleConfirmedInput(input);
  return Object.freeze({
    domain:
      MATCHUP_SCHEDULE_COMMAND_REQUEST_DOMAIN,
    schemaVersion:
      MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
    operation:
      MATCHUP_SCHEDULE_COMMAND_OPERATION,
    leagueId:
      validateMatchupScheduleCommandLeagueId(
        leagueId
      ),
    seasonId:
      validateMatchupScheduleCommandSeasonId(
        seasonId
      ),
    precondition: Object.freeze({
      kind: "season",
      version:
        validateMatchupScheduleCommandExpectedVersion(
          expectedSeasonVersion
        ),
    }),
    body: canonicalInput,
  });
}

function matchupScheduleShiftWeekOneRequestProjection({
  leagueId,
  seasonId,
  weekId,
  expectedWeekVersion,
  input,
} = {}) {
  const canonicalInput =
    validateMatchupScheduleShiftWeekOneInput(input);
  return Object.freeze({
    domain:
      MATCHUP_SCHEDULE_COMMAND_REQUEST_DOMAIN,
    schemaVersion:
      MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
    operation:
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
    leagueId:
      validateMatchupScheduleCommandLeagueId(
        leagueId
      ),
    seasonId:
      validateMatchupScheduleCommandSeasonId(
        seasonId
      ),
    weekId:
      validateMatchupScheduleShiftWeekOneWeekId(
        weekId
      ),
    precondition: Object.freeze({
      kind: "week",
      version:
        validateMatchupScheduleShiftExpectedWeekVersion(
          expectedWeekVersion
        ),
    }),
    body: canonicalInput,
  });
}

function serializeMatchupScheduleCommandRequest(value) {
  return serializeCanonicalJsonV1(
    matchupScheduleCommandRequestProjection(value)
  );
}

function serializeMatchupScheduleShiftWeekOneRequest(
  value
) {
  return serializeCanonicalJsonV1(
    matchupScheduleShiftWeekOneRequestProjection(
      value
    )
  );
}

function hashMatchupScheduleCommandRequest(value) {
  return hashCanonicalJsonV1(
    matchupScheduleCommandRequestProjection(value)
  );
}

function hashMatchupScheduleShiftWeekOneRequest(value) {
  return hashCanonicalJsonV1(
    matchupScheduleShiftWeekOneRequestProjection(
      value
    )
  );
}

function matchupScheduleCommandResponseProjection(result) {
  if (!isPlainObject(result)) {
    fail("response_result_invalid");
  }
  return Object.freeze({
    domain:
      MATCHUP_SCHEDULE_COMMAND_RESPONSE_DOMAIN,
    schemaVersion:
      MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
    httpStatus:
      MATCHUP_SCHEDULE_COMMAND_HTTP_STATUS,
    data: Object.freeze({
      code: MATCHUP_SCHEDULE_COMMAND_CODE,
      result,
    }),
  });
}

function matchupScheduleShiftWeekOneResponseProjection(
  result
) {
  const canonicalResult =
    validateMatchupScheduleShiftWeekOneResult(result);
  return Object.freeze({
    domain:
      MATCHUP_SCHEDULE_COMMAND_RESPONSE_DOMAIN,
    schemaVersion:
      MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
    httpStatus:
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_HTTP_STATUS,
    data: canonicalResult,
  });
}

function serializeMatchupScheduleCommandResponse(result) {
  return serializeCanonicalJsonV1(
    matchupScheduleCommandResponseProjection(result)
  );
}

function serializeMatchupScheduleShiftWeekOneResponse(
  result
) {
  return serializeCanonicalJsonV1(
    matchupScheduleShiftWeekOneResponseProjection(
      result
    )
  );
}

function hashMatchupScheduleCommandResponse(result) {
  return hashCanonicalJsonV1(
    matchupScheduleCommandResponseProjection(result)
  );
}

function hashMatchupScheduleShiftWeekOneResponse(
  result
) {
  return hashCanonicalJsonV1(
    matchupScheduleShiftWeekOneResponseProjection(
      result
    )
  );
}

module.exports = {
  INPUT_FIELDS,
  MATCHUP_SCHEDULE_COMMAND_CODE,
  MATCHUP_SCHEDULE_COMMAND_HTTP_STATUS,
  MATCHUP_SCHEDULE_COMMAND_OPERATION,
  MATCHUP_SCHEDULE_COMMAND_REQUEST_DOMAIN,
  MATCHUP_SCHEDULE_COMMAND_RESPONSE_DOMAIN,
  MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE,
  MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
  MATCHUP_SCHEDULE_IDEMPOTENCY_LIFETIME_MS,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_CONFIRMATION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_HTTP_STATUS,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_INPUT_FIELDS,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_RESULT_FIELDS,
  MatchupScheduleCommandPolicyError,
  UUID_PATTERN,
  hashMatchupScheduleCommandRequest,
  hashMatchupScheduleCommandResponse,
  hashMatchupScheduleShiftWeekOneRequest,
  hashMatchupScheduleShiftWeekOneResponse,
  matchupScheduleCommandRequestProjection,
  matchupScheduleCommandResponseProjection,
  matchupScheduleShiftWeekOneRequestProjection,
  matchupScheduleShiftWeekOneResponseProjection,
  serializeMatchupScheduleCommandRequest,
  serializeMatchupScheduleCommandResponse,
  serializeMatchupScheduleShiftWeekOneRequest,
  serializeMatchupScheduleShiftWeekOneResponse,
  validateMatchupScheduleCommandExpectedVersion,
  validateMatchupScheduleCommandIdempotencyKey,
  validateMatchupScheduleCommandLeagueId,
  validateMatchupScheduleCommandSeasonId,
  validateMatchupScheduleConfirmedInput,
  validateMatchupScheduleShiftExpectedWeekVersion,
  validateMatchupScheduleShiftWeekOneInput,
  validateMatchupScheduleShiftWeekOneResult,
  validateMatchupScheduleShiftWeekOneWeekId,
};
