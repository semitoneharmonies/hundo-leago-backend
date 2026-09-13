const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTOR_AUTHORITIES = Object.freeze(["manager", "commissioner"]);

const RETENTION_POLICY_CODES = Object.freeze({
  inputInvalid: "RETENTION_INPUT_INVALID",
  stableIdInvalid: "RETENTION_STABLE_ID_INVALID",
  amountInvalid: "RETENTION_AMOUNT_INVALID",
  contractInvalid: "RETENTION_CONTRACT_INVALID",
  teamInvalid: "RETENTION_TEAM_INVALID",
  scheduleInvalid: "RETENTION_SCHEDULE_INVALID",
  ceilingExceeded: "RETENTION_CEILING_EXCEEDED",
  slotLimitExceeded: "RETENTION_SLOT_LIMIT_EXCEEDED",
  duplicateTeamContract: "RETENTION_TEAM_CONTRACT_DUPLICATE",
  authorityInvalid: "RETENTION_AUTHORITY_INVALID",
  timestampInvalid: "RETENTION_TIMESTAMP_INVALID",
});

class RetentionPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted retained-salary obligation is invalid.");
    this.name = "RetentionPolicyError";
    this.code = RETENTION_POLICY_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new RetentionPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(RETENTION_POLICY_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(RETENTION_POLICY_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(RETENTION_POLICY_CODES.stableIdInvalid);
  }
  return value;
}

function safeNonnegative(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 0) fail(reasonCode);
  return value;
}

function safePositive(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 1) fail(reasonCode);
  return value;
}

function calculateRetentionCeilingCents(contractAavCents) {
  return Math.floor(
    safePositive(
      contractAavCents,
      RETENTION_POLICY_CODES.contractInvalid
    ) / 2
  );
}

function validateRetentionCommand(input) {
  assertExactObject(input, [
    "retentionId",
    "retentionYearIds",
    "leagueId",
    "contractId",
    "playerId",
    "originatingTeamId",
    "responsibleTeamId",
    "retainedAavCents",
    "creationTradeId",
    "activityId",
    "actorUserId",
    "actorAuthority",
    "occurredAtMs",
  ]);
  if (!Array.isArray(input.retentionYearIds)) {
    fail(RETENTION_POLICY_CODES.scheduleInvalid);
  }
  const retentionYearIds = input.retentionYearIds.map(stableId);
  if (new Set(retentionYearIds).size !== retentionYearIds.length) {
    fail(RETENTION_POLICY_CODES.scheduleInvalid);
  }
  if (!ACTOR_AUTHORITIES.includes(input.actorAuthority)) {
    fail(RETENTION_POLICY_CODES.authorityInvalid);
  }
  return Object.freeze({
    retentionId: stableId(input.retentionId),
    retentionYearIds: Object.freeze(retentionYearIds),
    leagueId: stableId(input.leagueId),
    contractId: stableId(input.contractId),
    playerId: stableId(input.playerId),
    originatingTeamId: stableId(input.originatingTeamId),
    responsibleTeamId: stableId(input.responsibleTeamId),
    retainedAavCents: safePositive(
      input.retainedAavCents,
      RETENTION_POLICY_CODES.amountInvalid
    ),
    creationTradeId: stableId(input.creationTradeId),
    activityId: stableId(input.activityId),
    actorUserId: stableId(input.actorUserId),
    actorAuthority: input.actorAuthority,
    occurredAtMs: safeNonnegative(
      input.occurredAtMs,
      RETENTION_POLICY_CODES.timestampInvalid
    ),
  });
}

function validateRetentionTeamLookup(input) {
  assertExactObject(input, ["leagueId", "responsibleTeamId"]);
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    responsibleTeamId: stableId(input.responsibleTeamId),
  });
}

function validateRetentionYearLookup(input) {
  assertExactObject(input, ["leagueId", "retentionId"]);
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    retentionId: stableId(input.retentionId),
  });
}

function remainingYear(value) {
  assertExactObject(value, ["seasonId", "status"]);
  if (!['current', 'future'].includes(value.status)) {
    fail(RETENTION_POLICY_CODES.scheduleInvalid);
  }
  return Object.freeze({
    seasonId: stableId(value.seasonId),
    status: value.status,
  });
}

function createRetentionAggregate(input) {
  assertExactObject(input, [
    "command",
    "contractAavCents",
    "contractPlayerId",
    "contractCurrentTeamId",
    "contractStatus",
    "remainingContractYears",
    "existingRetainedAavCents",
    "responsibleTeamActiveRetentionCount",
    "responsibleTeamAlreadyRetainsContract",
  ]);
  const command = validateRetentionCommand(input.command);
  const contractAavCents = safePositive(
    input.contractAavCents,
    RETENTION_POLICY_CODES.contractInvalid
  );
  if (
    input.contractStatus !== "active" ||
    stableId(input.contractPlayerId) !== command.playerId ||
    stableId(input.contractCurrentTeamId) !== command.originatingTeamId ||
    command.originatingTeamId !== command.responsibleTeamId
  ) {
    fail(RETENTION_POLICY_CODES.teamInvalid);
  }
  if (!Array.isArray(input.remainingContractYears)) {
    fail(RETENTION_POLICY_CODES.scheduleInvalid);
  }
  const remainingYears = input.remainingContractYears.map(remainingYear);
  if (
    remainingYears.length < 1 ||
    remainingYears.length > 3 ||
    command.retentionYearIds.length !== remainingYears.length ||
    new Set(remainingYears.map((year) => year.seasonId)).size !==
      remainingYears.length ||
    remainingYears[0].status !== "current" ||
    remainingYears.slice(1).some((year) => year.status !== "future")
  ) {
    fail(RETENTION_POLICY_CODES.scheduleInvalid);
  }
  const existingRetainedAavCents = safeNonnegative(
    input.existingRetainedAavCents,
    RETENTION_POLICY_CODES.amountInvalid
  );
  const retentionCeilingCents = calculateRetentionCeilingCents(
    contractAavCents
  );
  if (
    existingRetainedAavCents + command.retainedAavCents >
    retentionCeilingCents
  ) {
    fail(RETENTION_POLICY_CODES.ceilingExceeded);
  }
  const activeSlots = safeNonnegative(
    input.responsibleTeamActiveRetentionCount,
    RETENTION_POLICY_CODES.slotLimitExceeded
  );
  if (activeSlots >= 3) {
    fail(RETENTION_POLICY_CODES.slotLimitExceeded);
  }
  if (input.responsibleTeamAlreadyRetainsContract !== false) {
    fail(RETENTION_POLICY_CODES.duplicateTeamContract);
  }

  const obligation = Object.freeze({
    id: command.retentionId,
    league_id: command.leagueId,
    contract_id: command.contractId,
    player_id: command.playerId,
    originating_team_id: command.originatingTeamId,
    responsible_team_id: command.responsibleTeamId,
    retained_aav_cents: command.retainedAavCents,
    creation_trade_id: command.creationTradeId,
    status: "active",
    created_at_ms: command.occurredAtMs,
    updated_at_ms: command.occurredAtMs,
    version: 1,
  });
  const years = Object.freeze(
    remainingYears.map((year, index) =>
      Object.freeze({
        id: command.retentionYearIds[index],
        league_id: command.leagueId,
        retention_obligation_id: command.retentionId,
        season_id: year.seasonId,
        retained_aav_cents: command.retainedAavCents,
        status: year.status,
        created_at_ms: command.occurredAtMs,
      })
    )
  );
  return Object.freeze({
    obligation,
    years,
    retentionCeilingCents,
    cumulativeRetainedAavCents:
      existingRetainedAavCents + command.retainedAavCents,
  });
}

module.exports = {
  RETENTION_POLICY_CODES,
  RetentionPolicyError,
  calculateRetentionCeilingCents,
  createRetentionAggregate,
  validateRetentionCommand,
  validateRetentionTeamLookup,
  validateRetentionYearLookup,
};
