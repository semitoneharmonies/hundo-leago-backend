const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const NORMAL_CATEGORIES = Object.freeze([
  "Active",
  "Bench",
  "Injured Reserve",
]);
const ACTOR_AUTHORITIES = Object.freeze([
  "manager",
  "commissioner",
]);

const ROSTER_MOVEMENT_CODES = Object.freeze({
  inputInvalid: "ROSTER_MOVEMENT_INPUT_INVALID",
  stableIdInvalid: "ROSTER_MOVEMENT_STABLE_ID_INVALID",
  categoryInvalid: "ROSTER_MOVEMENT_CATEGORY_INVALID",
  transitionInvalid: "ROSTER_MOVEMENT_TRANSITION_INVALID",
  positionInvalid: "ROSTER_MOVEMENT_POSITION_INVALID",
  slotInvalid: "ROSTER_MOVEMENT_SLOT_INVALID",
  authorityInvalid: "ROSTER_MOVEMENT_AUTHORITY_INVALID",
  reasonInvalid: "ROSTER_MOVEMENT_REASON_INVALID",
  timestampInvalid: "ROSTER_MOVEMENT_TIMESTAMP_INVALID",
  versionInvalid: "ROSTER_MOVEMENT_VERSION_INVALID",
  scopeMismatch: "ROSTER_MOVEMENT_SCOPE_MISMATCH",
  sourceChanged: "ROSTER_MOVEMENT_SOURCE_CHANGED",
  versionConflict: "ROSTER_MOVEMENT_VERSION_CONFLICT",
  ownershipInvalid: "ROSTER_MOVEMENT_OWNERSHIP_INVALID",
  playerDuplicate: "ROSTER_MOVEMENT_PLAYER_DUPLICATE",
});

class RosterMovementPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted roster movement is invalid.");
    this.name = "RosterMovementPolicyError";
    this.code = ROSTER_MOVEMENT_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new RosterMovementPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(ROSTER_MOVEMENT_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(ROSTER_MOVEMENT_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(ROSTER_MOVEMENT_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(ROSTER_MOVEMENT_CODES.timestampInvalid);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(ROSTER_MOVEMENT_CODES.versionInvalid);
  }
  return value;
}

function oneOf(value, approved, reasonCode) {
  if (!approved.includes(value)) fail(reasonCode);
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
    fail(ROSTER_MOVEMENT_CODES.reasonInvalid);
  }
  return value;
}

function destinationSlot(category, positionGroup, slotNumber) {
  if (!Number.isSafeInteger(slotNumber)) {
    fail(ROSTER_MOVEMENT_CODES.slotInvalid);
  }
  const maximum =
    category === "Active"
      ? positionGroup === "F"
        ? 12
        : 6
      : 4;
  if (slotNumber < 1 || slotNumber > maximum) {
    fail(ROSTER_MOVEMENT_CODES.slotInvalid);
  }
  return slotNumber;
}

function validateRosterMove(input) {
  assertExactObject(input, [
    "leagueId",
    "seasonId",
    "teamId",
    "playerId",
    "expectedVersion",
    "expectedSourceCategory",
    "destinationCategory",
    "destinationPositionGroup",
    "destinationSlotNumber",
    "actorUserId",
    "actorAuthority",
    "ownershipEventId",
    "activityId",
    "reason",
    "occurredAtMs",
  ]);
  const expectedSourceCategory = oneOf(
    input.expectedSourceCategory,
    NORMAL_CATEGORIES,
    ROSTER_MOVEMENT_CODES.categoryInvalid
  );
  const destinationCategory = oneOf(
    input.destinationCategory,
    NORMAL_CATEGORIES,
    ROSTER_MOVEMENT_CODES.categoryInvalid
  );
  if (
    expectedSourceCategory === destinationCategory ||
    (expectedSourceCategory !== "Active" &&
      destinationCategory !== "Active")
  ) {
    fail(ROSTER_MOVEMENT_CODES.transitionInvalid);
  }
  const destinationPositionGroup = oneOf(
    input.destinationPositionGroup,
    ["F", "D"],
    ROSTER_MOVEMENT_CODES.positionInvalid
  );

  return Object.freeze({
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    teamId: stableId(input.teamId),
    playerId: stableId(input.playerId),
    expectedVersion: positiveVersion(input.expectedVersion),
    expectedSourceCategory,
    destinationCategory,
    destinationPositionGroup,
    destinationSlotNumber: destinationSlot(
      destinationCategory,
      destinationPositionGroup,
      input.destinationSlotNumber
    ),
    actorUserId: stableId(input.actorUserId),
    actorAuthority: oneOf(
      input.actorAuthority,
      ACTOR_AUTHORITIES,
      ROSTER_MOVEMENT_CODES.authorityInvalid
    ),
    ownershipEventId: stableId(input.ownershipEventId),
    activityId: stableId(input.activityId),
    reason: optionalReason(input.reason),
    occurredAtMs: safeTimestamp(input.occurredAtMs),
  });
}

function assertCurrentOwnershipForMove(input) {
  assertExactObject(input, ["current", "move"]);
  const { current, move } = input;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    fail(ROSTER_MOVEMENT_CODES.ownershipInvalid);
  }
  if (
    current.league_id !== move.leagueId ||
    current.season_id !== move.seasonId ||
    current.team_id !== move.teamId ||
    current.player_id !== move.playerId
  ) {
    fail(ROSTER_MOVEMENT_CODES.scopeMismatch);
  }
  if (
    current.ownership_kind !== "Rostered" ||
    current.roster_category === "Prospect"
  ) {
    fail(ROSTER_MOVEMENT_CODES.ownershipInvalid);
  }
  if (current.roster_category !== move.expectedSourceCategory) {
    fail(ROSTER_MOVEMENT_CODES.sourceChanged);
  }
  if (current.version !== move.expectedVersion) {
    fail(ROSTER_MOVEMENT_CODES.versionConflict);
  }
  return current;
}

function structuralAssignment(input) {
  assertExactObject(input, [
    "leagueId",
    "seasonId",
    "teamId",
    "playerId",
    "rosterCategory",
    "assignedPositionGroup",
  ]);
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    teamId: stableId(input.teamId),
    playerId: stableId(input.playerId),
    rosterCategory: oneOf(
      input.rosterCategory,
      [...NORMAL_CATEGORIES, "Prospect"],
      ROSTER_MOVEMENT_CODES.categoryInvalid
    ),
    assignedPositionGroup: oneOf(
      input.assignedPositionGroup,
      ["F", "D"],
      ROSTER_MOVEMENT_CODES.positionInvalid
    ),
  });
}

function effectivePosition(input) {
  assertExactObject(input, ["playerId", "positionGroup"]);
  return Object.freeze({
    playerId: stableId(input.playerId),
    positionGroup:
      input.positionGroup === null ||
      typeof input.positionGroup === "string"
        ? input.positionGroup
        : fail(ROSTER_MOVEMENT_CODES.positionInvalid),
  });
}

function freezeReasons(reasons) {
  return Object.freeze(
    reasons.map((reason) => Object.freeze({ ...reason }))
  );
}

function evaluateStructuralRosterLegality(input) {
  assertExactObject(input, [
    "leagueId",
    "seasonId",
    "teamId",
    "assignments",
    "effectivePositions",
  ]);
  const leagueId = stableId(input.leagueId);
  const seasonId = stableId(input.seasonId);
  const teamId = stableId(input.teamId);
  if (
    !Array.isArray(input.assignments) ||
    !Array.isArray(input.effectivePositions)
  ) {
    fail(ROSTER_MOVEMENT_CODES.inputInvalid);
  }
  const assignments = input.assignments.map(structuralAssignment);
  const effective = input.effectivePositions.map(effectivePosition);
  const effectiveByPlayer = new Map();
  for (const position of effective) {
    if (effectiveByPlayer.has(position.playerId)) {
      fail(ROSTER_MOVEMENT_CODES.playerDuplicate);
    }
    effectiveByPlayer.set(position.playerId, position.positionGroup);
  }

  const players = new Set();
  const counts = {
    activeForwards: 0,
    activeDefence: 0,
    activeUnsupported: 0,
    active: 0,
    bench: 0,
    injuredReserve: 0,
    prospects: 0,
    total: assignments.length,
  };
  const reasons = [];
  for (const assignment of assignments) {
    if (
      assignment.leagueId !== leagueId ||
      assignment.seasonId !== seasonId ||
      assignment.teamId !== teamId
    ) {
      fail(ROSTER_MOVEMENT_CODES.scopeMismatch);
    }
    if (players.has(assignment.playerId)) {
      fail(ROSTER_MOVEMENT_CODES.playerDuplicate);
    }
    players.add(assignment.playerId);
    const currentPosition = effectiveByPlayer.has(assignment.playerId)
      ? effectiveByPlayer.get(assignment.playerId)
      : null;
    if (currentPosition === null) {
      reasons.push({
        code: "PLAYER_POSITION_MISSING",
        playerId: assignment.playerId,
      });
    } else if (!["F", "D"].includes(currentPosition)) {
      reasons.push({
        code: "PLAYER_POSITION_UNSUPPORTED",
        playerId: assignment.playerId,
      });
    } else if (
      ["Active", "Bench"].includes(assignment.rosterCategory) &&
      currentPosition !== assignment.assignedPositionGroup
    ) {
      reasons.push({
        code: "PLAYER_POSITION_ASSIGNMENT_MISMATCH",
        playerId: assignment.playerId,
      });
    }

    if (assignment.rosterCategory === "Active") {
      counts.active += 1;
      if (currentPosition === "F") counts.activeForwards += 1;
      else if (currentPosition === "D") counts.activeDefence += 1;
      else counts.activeUnsupported += 1;
    } else if (assignment.rosterCategory === "Bench") {
      counts.bench += 1;
    } else if (assignment.rosterCategory === "Injured Reserve") {
      counts.injuredReserve += 1;
    } else {
      counts.prospects += 1;
    }
  }

  const limits = Object.freeze({
    activeForwards: 12,
    activeDefence: 6,
    active: 18,
    bench: 4,
    injuredReserve: 4,
    prospects: null,
  });
  for (const [field, code] of [
    ["activeForwards", "ACTIVE_FORWARD_LIMIT_EXCEEDED"],
    ["activeDefence", "ACTIVE_DEFENCE_LIMIT_EXCEEDED"],
    ["active", "ACTIVE_TOTAL_LIMIT_EXCEEDED"],
    ["bench", "BENCH_LIMIT_EXCEEDED"],
    ["injuredReserve", "INJURED_RESERVE_LIMIT_EXCEEDED"],
  ]) {
    if (counts[field] > limits[field]) reasons.push({ code });
  }

  const frozenReasons = freezeReasons(reasons);
  return Object.freeze({
    legal: frozenReasons.length === 0,
    counts: Object.freeze(counts),
    limits,
    reasons: frozenReasons,
  });
}

module.exports = {
  ACTOR_AUTHORITIES,
  NORMAL_CATEGORIES,
  ROSTER_MOVEMENT_CODES,
  RosterMovementPolicyError,
  assertCurrentOwnershipForMove,
  evaluateStructuralRosterLegality,
  validateRosterMove,
};
