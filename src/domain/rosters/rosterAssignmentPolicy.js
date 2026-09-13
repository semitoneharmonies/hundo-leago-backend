const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAXIMUM_ACQUISITION_TYPE_CODE_POINTS = 100;

const OWNERSHIP_KINDS = Object.freeze([
  "Rostered",
  "Prospect Right",
]);
const ROSTER_CATEGORIES = Object.freeze([
  "Active",
  "Bench",
  "Injured Reserve",
  "Prospect",
]);
const POSITION_GROUPS = Object.freeze(["F", "D"]);
const SOURCE_POSITION_GROUPS = Object.freeze({
  C: "F",
  LW: "F",
  RW: "F",
  F: "F",
  LD: "D",
  RD: "D",
  D: "D",
});

const ROSTER_ASSIGNMENT_CODES = Object.freeze({
  inputInvalid: "ROSTER_ASSIGNMENT_INPUT_INVALID",
  stableIdInvalid: "ROSTER_ASSIGNMENT_STABLE_ID_INVALID",
  ownershipKindInvalid: "ROSTER_ASSIGNMENT_OWNERSHIP_KIND_INVALID",
  categoryInvalid: "ROSTER_ASSIGNMENT_CATEGORY_INVALID",
  positionInvalid: "ROSTER_ASSIGNMENT_POSITION_INVALID",
  slotInvalid: "ROSTER_ASSIGNMENT_SLOT_INVALID",
  acquisitionInvalid: "ROSTER_ASSIGNMENT_ACQUISITION_INVALID",
  timestampInvalid: "ROSTER_ASSIGNMENT_TIMESTAMP_INVALID",
  scopeMismatch: "ROSTER_ASSIGNMENT_SCOPE_MISMATCH",
  playerDuplicate: "ROSTER_ASSIGNMENT_PLAYER_DUPLICATE",
  slotDuplicate: "ROSTER_ASSIGNMENT_SLOT_DUPLICATE",
});

class RosterAssignmentPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted roster assignment is invalid.");
    this.name = "RosterAssignmentPolicyError";
    this.code = ROSTER_ASSIGNMENT_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new RosterAssignmentPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(ROSTER_ASSIGNMENT_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(ROSTER_ASSIGNMENT_CODES.inputInvalid);
  }
}

function assertStableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(ROSTER_ASSIGNMENT_CODES.stableIdInvalid);
  }
  return value;
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(ROSTER_ASSIGNMENT_CODES.timestampInvalid);
  }
  return value;
}

function assertOneOf(value, approved, reasonCode) {
  if (!approved.includes(value)) fail(reasonCode);
  return value;
}

function assertOptionalStableId(value) {
  return value === null ? null : assertStableId(value);
}

function assertAcquisitionType(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length >
      MAXIMUM_ACQUISITION_TYPE_CODE_POINTS ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    fail(ROSTER_ASSIGNMENT_CODES.acquisitionInvalid);
  }
  return value;
}

function normalizeSourcePosition(sourcePosition) {
  if (
    typeof sourcePosition !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      SOURCE_POSITION_GROUPS,
      sourcePosition
    )
  ) {
    fail(ROSTER_ASSIGNMENT_CODES.positionInvalid);
  }
  return SOURCE_POSITION_GROUPS[sourcePosition];
}

function assertSlot({
  rosterCategory,
  positionGroup,
  slotNumber,
  acquiredTransactionType,
}) {
  if (rosterCategory === "Prospect") {
    if (slotNumber !== null) {
      fail(ROSTER_ASSIGNMENT_CODES.slotInvalid);
    }
    return null;
  }
  if (
    rosterCategory === "Active" &&
    slotNumber === null &&
    acquiredTransactionType === "auction_resolution"
  ) {
    return null;
  }
  if (!Number.isSafeInteger(slotNumber)) {
    fail(ROSTER_ASSIGNMENT_CODES.slotInvalid);
  }
  const maximum =
    rosterCategory === "Active"
      ? positionGroup === "F"
        ? 12
        : 6
      : 4;
  if (slotNumber < 1 || slotNumber > maximum) {
    fail(ROSTER_ASSIGNMENT_CODES.slotInvalid);
  }
  return slotNumber;
}

function assertOwnershipCategory(ownershipKind, rosterCategory) {
  if (
    rosterCategory !== "Prospect" &&
    ownershipKind !== "Rostered"
  ) {
    fail(ROSTER_ASSIGNMENT_CODES.ownershipKindInvalid);
  }
}

function createRosterAssignmentRecord(input) {
  assertExactObject(input, [
    "id",
    "leagueId",
    "seasonId",
    "playerId",
    "teamId",
    "ownershipKind",
    "rosterCategory",
    "positionGroup",
    "slotNumber",
    "acquiredTransactionType",
    "acquiredTransactionId",
    "createdAtMs",
    "updatedAtMs",
  ]);

  const ownershipKind = assertOneOf(
    input.ownershipKind,
    OWNERSHIP_KINDS,
    ROSTER_ASSIGNMENT_CODES.ownershipKindInvalid
  );
  const rosterCategory = assertOneOf(
    input.rosterCategory,
    ROSTER_CATEGORIES,
    ROSTER_ASSIGNMENT_CODES.categoryInvalid
  );
  const positionGroup = assertOneOf(
    input.positionGroup,
    POSITION_GROUPS,
    ROSTER_ASSIGNMENT_CODES.positionInvalid
  );
  assertOwnershipCategory(ownershipKind, rosterCategory);
  const createdAtMs = assertTimestamp(input.createdAtMs);
  const updatedAtMs = assertTimestamp(input.updatedAtMs);
  const acquiredTransactionType = assertAcquisitionType(
    input.acquiredTransactionType
  );
  if (updatedAtMs < createdAtMs) {
    fail(ROSTER_ASSIGNMENT_CODES.timestampInvalid);
  }

  return Object.freeze({
    id: assertStableId(input.id),
    league_id: assertStableId(input.leagueId),
    season_id: assertStableId(input.seasonId),
    player_id: assertStableId(input.playerId),
    team_id: assertStableId(input.teamId),
    ownership_kind: ownershipKind,
    roster_category: rosterCategory,
    position_group: positionGroup,
    slot_number: assertSlot({
      rosterCategory,
      positionGroup,
      slotNumber: input.slotNumber,
      acquiredTransactionType,
    }),
    acquired_transaction_type: acquiredTransactionType,
    acquired_transaction_id: assertOptionalStableId(
      input.acquiredTransactionId
    ),
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    version: 1,
  });
}

function revalidateRecord(record) {
  assertExactObject(record, [
    "id",
    "league_id",
    "season_id",
    "player_id",
    "team_id",
    "ownership_kind",
    "roster_category",
    "position_group",
    "slot_number",
    "acquired_transaction_type",
    "acquired_transaction_id",
    "created_at_ms",
    "updated_at_ms",
    "version",
  ]);
  if (record.version !== 1) {
    if (!Number.isSafeInteger(record.version) || record.version < 1) {
      fail(ROSTER_ASSIGNMENT_CODES.inputInvalid);
    }
  }
  const validated = createRosterAssignmentRecord({
    id: record.id,
    leagueId: record.league_id,
    seasonId: record.season_id,
    playerId: record.player_id,
    teamId: record.team_id,
    ownershipKind: record.ownership_kind,
    rosterCategory: record.roster_category,
    positionGroup: record.position_group,
    slotNumber: record.slot_number,
    acquiredTransactionType: record.acquired_transaction_type,
    acquiredTransactionId: record.acquired_transaction_id,
    createdAtMs: record.created_at_ms,
    updatedAtMs: record.updated_at_ms,
  });
  return Object.freeze({ ...validated, version: record.version });
}

function slotKey(record) {
  if (record.roster_category === "Prospect") return null;
  if (record.slot_number === null) return null;
  if (record.roster_category === "Active") {
    return `Active:${record.position_group}:${record.slot_number}`;
  }
  return `${record.roster_category}:${record.slot_number}`;
}

function buildSlots(maximum, records) {
  const bySlot = new Map(
    records.map((record) => [record.slot_number, record])
  );
  return Object.freeze(
    Array.from({ length: maximum }, (_, index) => {
      return Object.freeze({
        slotNumber: index + 1,
        assignment: bySlot.get(index + 1) ?? null,
      });
    })
  );
}

function buildRosterCategoryProjection(input) {
  assertExactObject(input, [
    "leagueId",
    "seasonId",
    "teamId",
    "assignments",
  ]);
  const leagueId = assertStableId(input.leagueId);
  const seasonId = assertStableId(input.seasonId);
  const teamId = assertStableId(input.teamId);
  if (!Array.isArray(input.assignments)) {
    fail(ROSTER_ASSIGNMENT_CODES.inputInvalid);
  }

  const assignments = input.assignments.map(revalidateRecord);
  const players = new Set();
  const slots = new Set();
  for (const assignment of assignments) {
    if (
      assignment.league_id !== leagueId ||
      assignment.season_id !== seasonId ||
      assignment.team_id !== teamId
    ) {
      fail(ROSTER_ASSIGNMENT_CODES.scopeMismatch);
    }
    if (players.has(assignment.player_id)) {
      fail(ROSTER_ASSIGNMENT_CODES.playerDuplicate);
    }
    players.add(assignment.player_id);
    const key = slotKey(assignment);
    if (key !== null && slots.has(key)) {
      fail(ROSTER_ASSIGNMENT_CODES.slotDuplicate);
    }
    if (key !== null) slots.add(key);
  }

  const activeForwards = assignments.filter(
    (record) =>
      record.roster_category === "Active" &&
      record.position_group === "F"
  );
  const activeDefence = assignments.filter(
    (record) =>
      record.roster_category === "Active" &&
      record.position_group === "D"
  );
  const bench = assignments.filter(
    (record) => record.roster_category === "Bench"
  );
  const injuredReserve = assignments.filter(
    (record) => record.roster_category === "Injured Reserve"
  );
  const prospects = assignments
    .filter((record) => record.roster_category === "Prospect")
    .sort((left, right) =>
      left.player_id.localeCompare(right.player_id)
    );
  const unplaced = assignments
    .filter(
      (record) =>
        record.roster_category === "Active" &&
        record.slot_number === null
    )
    .sort((left, right) =>
      left.player_id.localeCompare(right.player_id)
    );

  return Object.freeze({
    leagueId,
    seasonId,
    teamId,
    active: Object.freeze({
      forwards: buildSlots(12, activeForwards),
      defence: buildSlots(6, activeDefence),
      unplaced: Object.freeze(unplaced),
    }),
    bench: buildSlots(4, bench),
    injuredReserve: buildSlots(4, injuredReserve),
    prospects: Object.freeze(prospects),
    counts: Object.freeze({
      activeForwards: activeForwards.length,
      activeDefence: activeDefence.length,
      active: activeForwards.length + activeDefence.length,
      bench: bench.length,
      injuredReserve: injuredReserve.length,
      prospects: prospects.length,
      total: assignments.length,
    }),
  });
}

module.exports = {
  MAXIMUM_ACQUISITION_TYPE_CODE_POINTS,
  OWNERSHIP_KINDS,
  POSITION_GROUPS,
  ROSTER_ASSIGNMENT_CODES,
  ROSTER_CATEGORIES,
  SOURCE_POSITION_GROUPS,
  RosterAssignmentPolicyError,
  buildRosterCategoryProjection,
  createRosterAssignmentRecord,
  normalizeSourcePosition,
};
