const {
  sha256Hex,
} = require("../shared/sha256");

const STANDINGS_FINALIZATION_CONFIRMATION =
  "FINALIZE REGULAR SEASON STANDINGS";
const STANDINGS_RESULT_SET_SCHEMA_VERSION = 1;
const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 128;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESULT_SET_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RULE_VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const RESULT_SET_DESCRIPTOR_KEYS = Object.freeze([
  "leagueId",
  "seasonId",
  "standingsRuleVersion",
  "results",
]);
const RESULT_DESCRIPTOR_KEYS = Object.freeze([
  "matchupId",
  "matchupResultId",
  "resultVersionId",
  "resultVersion",
]);
const STANDINGS_ROW_KEYS = Object.freeze([
  "teamId",
  "teamDisplayName",
  "gamesPlayed",
  "wins",
  "losses",
  "ties",
  "standingsPoints",
  "pointsPercentageHundredths",
  "fantasyPointsForHundredths",
  "fantasyPointsAgainstHundredths",
  "fantasyPointsDifferentialHundredths",
  "rank",
]);
const COMPARABLE_STANDINGS_ROW_KEYS = Object.freeze([
  "teamId",
  "gamesPlayed",
  "wins",
  "losses",
  "ties",
  "standingsPoints",
  "pointsPercentageHundredths",
  "fantasyPointsForHundredths",
  "fantasyPointsAgainstHundredths",
  "fantasyPointsDifferentialHundredths",
  "rank",
]);

const STANDINGS_FINALIZATION_CODES = Object.freeze({
  inputInvalid: "STANDINGS_FINALIZATION_INPUT_INVALID",
  notReady: "STANDINGS_FINALIZATION_NOT_READY",
});

class StandingsFinalizationPolicyError extends Error {
  constructor(code, reasonCode) {
    super(
      code === STANDINGS_FINALIZATION_CODES.inputInvalid
        ? "The standings-finalization request is invalid."
        : "The standings-finalization source is not ready."
    );
    this.name = "StandingsFinalizationPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new StandingsFinalizationPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(STANDINGS_FINALIZATION_CODES.inputInvalid, reasonCode);
}

function failNotReady(reasonCode) {
  fail(STANDINGS_FINALIZATION_CODES.notReady, reasonCode);
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
  const sortedKeys = [...keys].sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return sortedKeys.every(
    (key, index) => key === sortedExpectedKeys[index]
  );
}

function validateStandingsFinalizationLeagueId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput("league_id_invalid");
  }
  return value;
}

function validateStandingsFinalizationSeasonId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput("season_id_invalid");
  }
  return value;
}

function validateStandingsFinalizationExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    failInput("expected_version_invalid");
  }
  return value;
}

function validateStandingsFinalizationIdempotencyKey(value) {
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

function validateStandingsFinalizationInput(value) {
  if (
    !hasExactKeys(value, [
      "resultSetHash",
      "confirmation",
    ])
  ) {
    failInput("body_invalid");
  }
  if (
    typeof value.resultSetHash !== "string" ||
    !RESULT_SET_HASH_PATTERN.test(value.resultSetHash)
  ) {
    failInput("result_set_hash_invalid");
  }
  if (
    value.confirmation !==
    STANDINGS_FINALIZATION_CONFIRMATION
  ) {
    failInput("confirmation_invalid");
  }
  return Object.freeze({
    resultSetHash: value.resultSetHash,
    confirmation: value.confirmation,
  });
}

function sourceStableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failNotReady(reasonCode);
  }
  return value;
}

function normalizeResultDescriptor(value) {
  if (!hasExactKeys(value, RESULT_DESCRIPTOR_KEYS)) {
    failNotReady("result_descriptor_invalid");
  }
  if (
    !Number.isSafeInteger(value.resultVersion) ||
    value.resultVersion < 1
  ) {
    failNotReady("result_version_invalid");
  }
  return Object.freeze({
    matchupId: sourceStableId(
      value.matchupId,
      "matchup_id_invalid"
    ),
    matchupResultId: sourceStableId(
      value.matchupResultId,
      "matchup_result_id_invalid"
    ),
    resultVersionId: sourceStableId(
      value.resultVersionId,
      "result_version_id_invalid"
    ),
    resultVersion: value.resultVersion,
  });
}

function compareResultDescriptors(left, right) {
  if (left.matchupId < right.matchupId) return -1;
  if (left.matchupId > right.matchupId) return 1;
  if (left.matchupResultId < right.matchupResultId) {
    return -1;
  }
  if (left.matchupResultId > right.matchupResultId) {
    return 1;
  }
  return 0;
}

function normalizeStandingsResultSetDescriptor(value) {
  if (!hasExactKeys(value, RESULT_SET_DESCRIPTOR_KEYS)) {
    failNotReady("result_set_descriptor_invalid");
  }
  if (
    typeof value.standingsRuleVersion !== "string" ||
    !RULE_VERSION_PATTERN.test(
      value.standingsRuleVersion
    )
  ) {
    failNotReady("standings_rule_version_invalid");
  }
  if (
    !Array.isArray(value.results) ||
    value.results.length < 1
  ) {
    failNotReady("result_set_empty");
  }

  const results = value.results.map(normalizeResultDescriptor);
  const matchupIds = new Set();
  const matchupResultIds = new Set();
  const resultVersionIds = new Set();
  for (const result of results) {
    if (matchupIds.has(result.matchupId)) {
      failNotReady("duplicate_matchup_id");
    }
    if (matchupResultIds.has(result.matchupResultId)) {
      failNotReady("duplicate_matchup_result_id");
    }
    if (resultVersionIds.has(result.resultVersionId)) {
      failNotReady("duplicate_result_version_id");
    }
    matchupIds.add(result.matchupId);
    matchupResultIds.add(result.matchupResultId);
    resultVersionIds.add(result.resultVersionId);
  }

  results.sort(compareResultDescriptors);
  return Object.freeze({
    leagueId: sourceStableId(
      value.leagueId,
      "league_id_invalid"
    ),
    seasonId: sourceStableId(
      value.seasonId,
      "season_id_invalid"
    ),
    standingsRuleVersion: value.standingsRuleVersion,
    results: Object.freeze(results),
  });
}

function serializeStandingsResultSetDescriptor(value) {
  return JSON.stringify(
    normalizeStandingsResultSetDescriptor(value)
  );
}

function calculateStandingsResultSetHash(value) {
  return sha256Hex(
    serializeStandingsResultSetDescriptor(value)
  );
}

function normalizeStandingsRow(value) {
  if (!hasExactKeys(value, STANDINGS_ROW_KEYS)) {
    failNotReady("standings_row_invalid");
  }
  const nonnegativeIntegerKeys = [
    "gamesPlayed",
    "wins",
    "losses",
    "ties",
    "standingsPoints",
    "pointsPercentageHundredths",
    "fantasyPointsForHundredths",
    "fantasyPointsAgainstHundredths",
  ];
  if (
    typeof value.teamDisplayName !== "string" ||
    value.teamDisplayName.length < 1 ||
    value.teamDisplayName !== value.teamDisplayName.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value.teamDisplayName) ||
    nonnegativeIntegerKeys.some(
      (key) =>
        !Number.isSafeInteger(value[key]) ||
        value[key] < 0
    ) ||
    !Number.isSafeInteger(
      value.fantasyPointsDifferentialHundredths
    ) ||
    !Number.isSafeInteger(value.rank) ||
    value.rank < 1 ||
    value.pointsPercentageHundredths > 10_000
  ) {
    failNotReady("standings_row_invalid");
  }
  const expectedPointsPercentageHundredths =
    value.gamesPlayed === 0
      ? 0
      : Math.round(
          (value.standingsPoints * 10_000) /
            (value.gamesPlayed * 2)
        );
  if (
    value.gamesPlayed !==
      value.wins + value.losses + value.ties ||
    value.standingsPoints !==
      value.wins * 2 + value.ties ||
    value.pointsPercentageHundredths !==
      expectedPointsPercentageHundredths ||
    value.fantasyPointsDifferentialHundredths !==
      value.fantasyPointsForHundredths -
        value.fantasyPointsAgainstHundredths
  ) {
    failNotReady("standings_row_invalid");
  }
  return Object.freeze(
    Object.fromEntries(
      COMPARABLE_STANDINGS_ROW_KEYS.map((key) => [
        key,
        key === "teamId"
          ? sourceStableId(
              value.teamId,
              "standings_team_id_invalid"
            )
          : value[key],
      ])
    )
  );
}

function normalizeStandingsRows(value) {
  if (!Array.isArray(value) || value.length < 1) {
    failNotReady("standings_rows_invalid");
  }
  const rows = value.map(normalizeStandingsRow);
  const teamIds = new Set();
  for (const row of rows) {
    if (teamIds.has(row.teamId)) {
      failNotReady("duplicate_standings_team_id");
    }
    teamIds.add(row.teamId);
  }
  rows.sort((left, right) => {
    if (left.teamId < right.teamId) return -1;
    if (left.teamId > right.teamId) return 1;
    return 0;
  });
  return rows;
}

function officialStandingsRowsChanged(
  previousRows,
  nextRows
) {
  const previous = normalizeStandingsRows(previousRows);
  const next = normalizeStandingsRows(nextRows);
  if (previous.length !== next.length) return true;
  return previous.some((row, index) =>
    COMPARABLE_STANDINGS_ROW_KEYS.some(
      (key) => row[key] !== next[index][key]
    )
  );
}

module.exports = {
  FORBIDDEN_TEXT_PATTERN,
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  RESULT_SET_HASH_PATTERN,
  STANDINGS_FINALIZATION_CODES,
  STANDINGS_FINALIZATION_CONFIRMATION,
  STANDINGS_RESULT_SET_SCHEMA_VERSION,
  StandingsFinalizationPolicyError,
  UUID_PATTERN,
  calculateStandingsResultSetHash,
  normalizeStandingsResultSetDescriptor,
  officialStandingsRowsChanged,
  serializeStandingsResultSetDescriptor,
  validateStandingsFinalizationExpectedVersion,
  validateStandingsFinalizationIdempotencyKey,
  validateStandingsFinalizationInput,
  validateStandingsFinalizationLeagueId,
  validateStandingsFinalizationSeasonId,
};
