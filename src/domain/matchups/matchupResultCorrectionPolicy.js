const {
  deriveMatchupOutcome,
  validateResultCorrection,
} = require("./matchupResultPolicy");

const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 128;
const MAXIMUM_CORRECTION_REASON_LENGTH = 500;
const DEFAULT_MATCHUP_RESULT_CORRECTION_REASON =
  "Official matchup result correction";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const MATCHUP_RESULT_CORRECTION_CODES = Object.freeze({
  inputInvalid: "MATCHUP_RESULT_CORRECTION_INPUT_INVALID",
});

class MatchupResultCorrectionPolicyError extends Error {
  constructor(reasonCode) {
    super("The matchup-result correction request is invalid.");
    this.name = "MatchupResultCorrectionPolicyError";
    this.code = MATCHUP_RESULT_CORRECTION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new MatchupResultCorrectionPolicyError(reasonCode);
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
  const actual = [...keys].sort();
  const expected = [...expectedKeys].sort();
  return actual.every(
    (key, index) => key === expected[index]
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

function validateMatchupResultCorrectionLeagueId(value) {
  return validateStableId(value, "league_id_invalid");
}

function validateMatchupResultCorrectionSeasonId(value) {
  return validateStableId(value, "season_id_invalid");
}

function validateMatchupResultCorrectionResultId(value) {
  return validateStableId(value, "result_id_invalid");
}

function validateMatchupResultCorrectionExpectedVersion(
  value
) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("expected_version_invalid");
  }
  return value;
}

function validateMatchupResultCorrectionIdempotencyKey(
  value
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAXIMUM_IDEMPOTENCY_KEY_LENGTH ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    fail("idempotency_key_invalid");
  }
  return value;
}

function validateMatchupResultCorrectionPreviewInput(value) {
  if (
    !hasExactKeys(value, ["confirmed"]) ||
    value.confirmed !== false
  ) {
    fail("preview_body_invalid");
  }
  return Object.freeze({ confirmed: false });
}

function validateMatchupResultCorrectionInput(value) {
  const hasWrittenReason =
    isPlainObject(value) &&
    Object.prototype.hasOwnProperty.call(
      value,
      "reason"
    );
  const expectedKeys = [
    "confirmed",
    "homeScoreHundredths",
    "awayScoreHundredths",
    ...(hasWrittenReason ? ["reason"] : []),
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.confirmed !== true
  ) {
    fail("body_invalid");
  }
  if (hasWrittenReason) {
    if (
      typeof value.reason !== "string" ||
      value.reason.length < 1 ||
      value.reason.length >
        MAXIMUM_CORRECTION_REASON_LENGTH ||
      value.reason !== value.reason.trim() ||
      FORBIDDEN_TEXT_PATTERN.test(value.reason)
    ) {
      fail("reason_invalid");
    }
  }

  let correction;
  const persistedReason = hasWrittenReason
    ? value.reason
    : DEFAULT_MATCHUP_RESULT_CORRECTION_REASON;
  try {
    correction = validateResultCorrection({
      ...value,
      reason: persistedReason,
    });
  } catch {
    if (
      !Number.isSafeInteger(
        value.homeScoreHundredths
      ) ||
      value.homeScoreHundredths < 0
    ) {
      fail("home_score_invalid");
    }
    if (
      !Number.isSafeInteger(
        value.awayScoreHundredths
      ) ||
      value.awayScoreHundredths < 0
    ) {
      fail("away_score_invalid");
    }
    fail("reason_invalid");
  }

  return Object.freeze({
    confirmed: true,
    homeScoreHundredths:
      correction.homeScoreHundredths,
    awayScoreHundredths:
      correction.awayScoreHundredths,
    outcome: deriveMatchupOutcome(
      correction.homeScoreHundredths,
      correction.awayScoreHundredths
    ),
    reason: correction.reason,
    writtenReason: hasWrittenReason
      ? value.reason
      : null,
  });
}

module.exports = {
  DEFAULT_MATCHUP_RESULT_CORRECTION_REASON,
  FORBIDDEN_TEXT_PATTERN,
  MATCHUP_RESULT_CORRECTION_CODES,
  MAXIMUM_CORRECTION_REASON_LENGTH,
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  MatchupResultCorrectionPolicyError,
  UUID_PATTERN,
  validateMatchupResultCorrectionExpectedVersion,
  validateMatchupResultCorrectionIdempotencyKey,
  validateMatchupResultCorrectionInput,
  validateMatchupResultCorrectionLeagueId,
  validateMatchupResultCorrectionPreviewInput,
  validateMatchupResultCorrectionResultId,
  validateMatchupResultCorrectionSeasonId,
};
