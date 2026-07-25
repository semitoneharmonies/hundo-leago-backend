const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ACTOR_AUTHORITIES = Object.freeze(["manager", "commissioner"]);
const RELEASE_DECISIONS = Object.freeze([
  "decline_elc",
  "release_unsigned_rights",
]);

const PROSPECT_DECISION_CODES = Object.freeze({
  inputInvalid: "PROSPECT_DECISION_INPUT_INVALID",
  stableIdInvalid: "PROSPECT_DECISION_STABLE_ID_INVALID",
  scheduleInvalid: "PROSPECT_DECISION_SCHEDULE_INVALID",
  versionInvalid: "PROSPECT_DECISION_VERSION_INVALID",
  authorityInvalid: "PROSPECT_DECISION_AUTHORITY_INVALID",
  decisionInvalid: "PROSPECT_DECISION_TYPE_INVALID",
  confirmationRequired: "PROSPECT_DECISION_CONFIRMATION_REQUIRED",
  reasonInvalid: "PROSPECT_DECISION_REASON_INVALID",
  timestampInvalid: "PROSPECT_DECISION_TIMESTAMP_INVALID",
  ownershipInvalid: "PROSPECT_DECISION_OWNERSHIP_INVALID",
  scopeMismatch: "PROSPECT_DECISION_SCOPE_MISMATCH",
  versionConflict: "PROSPECT_DECISION_VERSION_CONFLICT",
});

class ProspectDecisionPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted prospect decision is invalid.");
    this.name = "ProspectDecisionPolicyError";
    this.code = PROSPECT_DECISION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new ProspectDecisionPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(PROSPECT_DECISION_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(PROSPECT_DECISION_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(PROSPECT_DECISION_CODES.stableIdInvalid);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(PROSPECT_DECISION_CODES.versionInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(PROSPECT_DECISION_CODES.timestampInvalid);
  }
  return value;
}

function actorAuthority(value) {
  if (!ACTOR_AUTHORITIES.includes(value)) {
    fail(PROSPECT_DECISION_CODES.authorityInvalid);
  }
  return value;
}

function optionalReason(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length > 500 ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    fail(PROSPECT_DECISION_CODES.reasonInvalid);
  }
  return value;
}

function validateThreeYearIds(values, firstId) {
  if (!Array.isArray(values) || values.length !== 3) {
    fail(PROSPECT_DECISION_CODES.scheduleInvalid);
  }
  const ids = values.map(stableId);
  if (
    (firstId !== undefined && ids[0] !== firstId) ||
    new Set(ids).size !== ids.length
  ) {
    fail(PROSPECT_DECISION_CODES.scheduleInvalid);
  }
  return Object.freeze(ids);
}

function validateProspectElcSigning(input) {
  assertExactObject(input, [
    "leagueId",
    "seasonId",
    "teamId",
    "playerId",
    "ownershipId",
    "expectedOwnershipVersion",
    "contractId",
    "contractYearIds",
    "contractEventId",
    "seasonIds",
    "ownershipEventId",
    "activityId",
    "actorUserId",
    "actorAuthority",
    "occurredAtMs",
  ]);
  const seasonId = stableId(input.seasonId);
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    seasonId,
    teamId: stableId(input.teamId),
    playerId: stableId(input.playerId),
    ownershipId: stableId(input.ownershipId),
    expectedOwnershipVersion: positiveVersion(
      input.expectedOwnershipVersion
    ),
    contractId: stableId(input.contractId),
    contractYearIds: validateThreeYearIds(input.contractYearIds),
    contractEventId: stableId(input.contractEventId),
    seasonIds: validateThreeYearIds(input.seasonIds, seasonId),
    ownershipEventId: stableId(input.ownershipEventId),
    activityId: stableId(input.activityId),
    actorUserId: stableId(input.actorUserId),
    actorAuthority: actorAuthority(input.actorAuthority),
    occurredAtMs: safeTimestamp(input.occurredAtMs),
  });
}

function validateUnsignedProspectRelease(input) {
  assertExactObject(input, [
    "leagueId",
    "seasonId",
    "teamId",
    "playerId",
    "ownershipId",
    "expectedOwnershipVersion",
    "decision",
    "confirmed",
    "ownershipEventId",
    "activityId",
    "actorUserId",
    "actorAuthority",
    "reason",
    "occurredAtMs",
  ]);
  if (!RELEASE_DECISIONS.includes(input.decision)) {
    fail(PROSPECT_DECISION_CODES.decisionInvalid);
  }
  if (input.confirmed !== true) {
    fail(PROSPECT_DECISION_CODES.confirmationRequired);
  }
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    teamId: stableId(input.teamId),
    playerId: stableId(input.playerId),
    ownershipId: stableId(input.ownershipId),
    expectedOwnershipVersion: positiveVersion(
      input.expectedOwnershipVersion
    ),
    decision: input.decision,
    confirmed: true,
    ownershipEventId: stableId(input.ownershipEventId),
    activityId: stableId(input.activityId),
    actorUserId: stableId(input.actorUserId),
    actorAuthority: actorAuthority(input.actorAuthority),
    reason: optionalReason(input.reason),
    occurredAtMs: safeTimestamp(input.occurredAtMs),
  });
}

function assertUnsignedProspectOwnership(input) {
  assertExactObject(input, ["current", "decision"]);
  const { current, decision } = input;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    fail(PROSPECT_DECISION_CODES.ownershipInvalid);
  }
  if (
    current.id !== decision.ownershipId ||
    current.league_id !== decision.leagueId ||
    current.season_id !== decision.seasonId ||
    current.team_id !== decision.teamId ||
    current.player_id !== decision.playerId
  ) {
    fail(PROSPECT_DECISION_CODES.scopeMismatch);
  }
  if (
    current.ownership_kind !== "Prospect Right" ||
    current.roster_category !== "Prospect" ||
    current.slot_number !== null
  ) {
    fail(PROSPECT_DECISION_CODES.ownershipInvalid);
  }
  if (current.version !== decision.expectedOwnershipVersion) {
    fail(PROSPECT_DECISION_CODES.versionConflict);
  }
  return current;
}

module.exports = {
  ACTOR_AUTHORITIES,
  PROSPECT_DECISION_CODES,
  ProspectDecisionPolicyError,
  RELEASE_DECISIONS,
  assertUnsignedProspectOwnership,
  validateProspectElcSigning,
  validateUnsignedProspectRelease,
};
