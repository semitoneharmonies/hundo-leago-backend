const MAXIMUM_POSITION_REASON_CODE_POINTS = 500;
const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const POSITION_GROUPS = new Set(["F", "D"]);

const LEAGUE_PLAYER_OWNERSHIP_CODES = Object.freeze({
  inputInvalid: "LEAGUE_PLAYER_OWNERSHIP_INPUT_INVALID",
  stableIdInvalid: "LEAGUE_PLAYER_OWNERSHIP_STABLE_ID_INVALID",
  positionInvalid: "LEAGUE_PLAYER_POSITION_INVALID",
  reasonInvalid: "LEAGUE_PLAYER_POSITION_REASON_INVALID",
  timestampInvalid: "LEAGUE_PLAYER_POSITION_TIMESTAMP_INVALID",
});

class LeaguePlayerOwnershipPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted league player ownership input is invalid.");
    this.name = "LeaguePlayerOwnershipPolicyError";
    this.code = LEAGUE_PLAYER_OWNERSHIP_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new LeaguePlayerOwnershipPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(LEAGUE_PLAYER_OWNERSHIP_CODES.inputInvalid);
  }

  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(LEAGUE_PLAYER_OWNERSHIP_CODES.inputInvalid);
  }
}

function assertStableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(LEAGUE_PLAYER_OWNERSHIP_CODES.stableIdInvalid);
  }
  return value;
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(LEAGUE_PLAYER_OWNERSHIP_CODES.timestampInvalid);
  }
  return value;
}

function assertPositionGroup(value) {
  if (!POSITION_GROUPS.has(value)) {
    fail(LEAGUE_PLAYER_OWNERSHIP_CODES.positionInvalid);
  }
  return value;
}

function assertReason(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length >
      MAXIMUM_POSITION_REASON_CODE_POINTS ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    fail(LEAGUE_PLAYER_OWNERSHIP_CODES.reasonInvalid);
  }
  return value;
}

function validateLeaguePlayerLookup(input) {
  assertExactObject(input, ["leagueId", "playerId"]);
  return Object.freeze({
    leagueId: assertStableId(input.leagueId),
    playerId: assertStableId(input.playerId),
  });
}

function validateTeamOwnershipLookup(input) {
  assertExactObject(input, ["leagueId", "seasonId", "teamId"]);
  return Object.freeze({
    leagueId: assertStableId(input.leagueId),
    seasonId: assertStableId(input.seasonId),
    teamId: assertStableId(input.teamId),
  });
}

function createLeaguePositionCorrectionRecord(input) {
  assertExactObject(input, [
    "id",
    "leagueId",
    "playerId",
    "positionGroup",
    "reason",
    "correctedByUserId",
    "effectiveAtMs",
  ]);

  return Object.freeze({
    id: assertStableId(input.id),
    league_id: assertStableId(input.leagueId),
    player_id: assertStableId(input.playerId),
    position_group: assertPositionGroup(input.positionGroup),
    reason: assertReason(input.reason),
    corrected_by_user_id: assertStableId(
      input.correctedByUserId
    ),
    effective_at_ms: assertTimestamp(input.effectiveAtMs),
    ended_at_ms: null,
    version: 1,
  });
}

function validatePositionCorrectionReplacement(input) {
  assertExactObject(input, [
    "currentEffectiveAtMs",
    "replacementEffectiveAtMs",
  ]);
  const currentEffectiveAtMs = assertTimestamp(
    input.currentEffectiveAtMs
  );
  const replacementEffectiveAtMs = assertTimestamp(
    input.replacementEffectiveAtMs
  );
  if (replacementEffectiveAtMs <= currentEffectiveAtMs) {
    fail(LEAGUE_PLAYER_OWNERSHIP_CODES.timestampInvalid);
  }
  return Object.freeze({
    currentEffectiveAtMs,
    replacementEffectiveAtMs,
  });
}

module.exports = {
  LEAGUE_PLAYER_OWNERSHIP_CODES,
  MAXIMUM_POSITION_REASON_CODE_POINTS,
  POSITION_GROUPS,
  LeaguePlayerOwnershipPolicyError,
  createLeaguePositionCorrectionRecord,
  validateLeaguePlayerLookup,
  validatePositionCorrectionReplacement,
  validateTeamOwnershipLookup,
};
