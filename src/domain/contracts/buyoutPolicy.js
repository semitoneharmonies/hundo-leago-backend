const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ACTOR_AUTHORITIES = Object.freeze(["manager", "commissioner"]);

const BUYOUT_POLICY_CODES = Object.freeze({
  inputInvalid: "BUYOUT_INPUT_INVALID",
  stableIdInvalid: "BUYOUT_STABLE_ID_INVALID",
  versionInvalid: "BUYOUT_VERSION_INVALID",
  authorityInvalid: "BUYOUT_AUTHORITY_INVALID",
  confirmationRequired: "BUYOUT_CONFIRMATION_REQUIRED",
  reasonInvalid: "BUYOUT_REASON_INVALID",
  timestampInvalid: "BUYOUT_TIMESTAMP_INVALID",
  contractInvalid: "BUYOUT_CONTRACT_INVALID",
  ownershipInvalid: "BUYOUT_OWNERSHIP_INVALID",
  scopeMismatch: "BUYOUT_SCOPE_MISMATCH",
  versionConflict: "BUYOUT_VERSION_CONFLICT",
  lockActive: "BUYOUT_LOCK_ACTIVE",
  scheduleInvalid: "BUYOUT_SCHEDULE_INVALID",
  pendingTradeExists: "BUYOUT_PENDING_TRADE_EXISTS",
});

class BuyoutPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted contract buyout is invalid.");
    this.name = "BuyoutPolicyError";
    this.code = BUYOUT_POLICY_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new BuyoutPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(BUYOUT_POLICY_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(BUYOUT_POLICY_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    fail(BUYOUT_POLICY_CODES.stableIdInvalid);
  }
  return value;
}

function safeNonnegative(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 0) fail(reasonCode);
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(BUYOUT_POLICY_CODES.versionInvalid);
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
    fail(BUYOUT_POLICY_CODES.reasonInvalid);
  }
  return value;
}

function calculateBuyoutPenaltyCents(contractAavCents) {
  if (!Number.isSafeInteger(contractAavCents) || contractAavCents < 1) {
    fail(BUYOUT_POLICY_CODES.contractInvalid);
  }
  const quotient = Math.floor(contractAavCents / 4);
  const remainder = contractAavCents % 4;
  return quotient + (remainder >= 2 ? 1 : 0);
}

function validateBuyoutCommand(input) {
  assertExactObject(input, [
    "buyoutId",
    "buyoutYearIds",
    "contractEventId",
    "ownershipEventId",
    "activityId",
    "leagueId",
    "seasonId",
    "teamId",
    "playerId",
    "contractId",
    "ownershipId",
    "expectedContractVersion",
    "expectedOwnershipVersion",
    "actorUserId",
    "actorAuthority",
    "confirmed",
    "reason",
    "occurredAtMs",
  ]);
  if (!Array.isArray(input.buyoutYearIds)) {
    fail(BUYOUT_POLICY_CODES.scheduleInvalid);
  }
  const buyoutYearIds = input.buyoutYearIds.map(stableId);
  if (new Set(buyoutYearIds).size !== buyoutYearIds.length) {
    fail(BUYOUT_POLICY_CODES.scheduleInvalid);
  }
  if (!ACTOR_AUTHORITIES.includes(input.actorAuthority)) {
    fail(BUYOUT_POLICY_CODES.authorityInvalid);
  }
  if (input.confirmed !== true) {
    fail(BUYOUT_POLICY_CODES.confirmationRequired);
  }
  return Object.freeze({
    buyoutId: stableId(input.buyoutId),
    buyoutYearIds: Object.freeze(buyoutYearIds),
    contractEventId: stableId(input.contractEventId),
    ownershipEventId: stableId(input.ownershipEventId),
    activityId: stableId(input.activityId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    teamId: stableId(input.teamId),
    playerId: stableId(input.playerId),
    contractId: stableId(input.contractId),
    ownershipId: stableId(input.ownershipId),
    expectedContractVersion: positiveVersion(input.expectedContractVersion),
    expectedOwnershipVersion: positiveVersion(input.expectedOwnershipVersion),
    actorUserId: stableId(input.actorUserId),
    actorAuthority: input.actorAuthority,
    confirmed: true,
    reason: optionalReason(input.reason),
    occurredAtMs: safeNonnegative(
      input.occurredAtMs,
      BUYOUT_POLICY_CODES.timestampInvalid
    ),
  });
}

function buyoutYear(value) {
  assertExactObject(value, ["contractYearId", "seasonId", "status"]);
  if (!["current", "future"].includes(value.status)) {
    fail(BUYOUT_POLICY_CODES.scheduleInvalid);
  }
  return Object.freeze({
    contractYearId: stableId(value.contractYearId),
    seasonId: stableId(value.seasonId),
    status: value.status,
  });
}

function createBuyoutAggregate(input) {
  assertExactObject(input, [
    "command",
    "contract",
    "ownership",
    "remainingContractYears",
    "pendingTradeCount",
  ]);
  const command = validateBuyoutCommand(input.command);
  const { contract, ownership } = input;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail(BUYOUT_POLICY_CODES.contractInvalid);
  }
  if (
    contract.id !== command.contractId ||
    contract.league_id !== command.leagueId ||
    contract.player_id !== command.playerId ||
    contract.current_team_id !== command.teamId
  ) {
    fail(BUYOUT_POLICY_CODES.scopeMismatch);
  }
  if (contract.status !== "active") {
    fail(BUYOUT_POLICY_CODES.contractInvalid);
  }
  if (contract.version !== command.expectedContractVersion) {
    fail(BUYOUT_POLICY_CODES.versionConflict);
  }
  if (
    contract.auction_buyout_lock_expires_at_ms !== null &&
    command.occurredAtMs < contract.auction_buyout_lock_expires_at_ms
  ) {
    fail(BUYOUT_POLICY_CODES.lockActive);
  }
  if (!ownership || typeof ownership !== "object" || Array.isArray(ownership)) {
    fail(BUYOUT_POLICY_CODES.ownershipInvalid);
  }
  if (
    ownership.id !== command.ownershipId ||
    ownership.league_id !== command.leagueId ||
    ownership.season_id !== command.seasonId ||
    ownership.team_id !== command.teamId ||
    ownership.player_id !== command.playerId
  ) {
    fail(BUYOUT_POLICY_CODES.scopeMismatch);
  }
  if (
    ownership.ownership_kind !== "Rostered" ||
    !["Active", "Bench", "Injured Reserve", "Prospect"].includes(
      ownership.roster_category
    )
  ) {
    fail(BUYOUT_POLICY_CODES.ownershipInvalid);
  }
  if (ownership.version !== command.expectedOwnershipVersion) {
    fail(BUYOUT_POLICY_CODES.versionConflict);
  }
  if (!Array.isArray(input.remainingContractYears)) {
    fail(BUYOUT_POLICY_CODES.scheduleInvalid);
  }
  const remainingYears = input.remainingContractYears.map(buyoutYear);
  if (
    remainingYears.length < 1 ||
    remainingYears.length > 3 ||
    command.buyoutYearIds.length !== remainingYears.length ||
    remainingYears[0].status !== "current" ||
    remainingYears.slice(1).some((year) => year.status !== "future") ||
    new Set(remainingYears.map((year) => year.seasonId)).size !==
      remainingYears.length
  ) {
    fail(BUYOUT_POLICY_CODES.scheduleInvalid);
  }
  const pendingTradeCount = safeNonnegative(
    input.pendingTradeCount,
    BUYOUT_POLICY_CODES.pendingTradeExists
  );
  if (pendingTradeCount !== 0) {
    fail(BUYOUT_POLICY_CODES.pendingTradeExists);
  }
  const annualPenaltyCents = calculateBuyoutPenaltyCents(
    contract.aav_cents
  );
  if (annualPenaltyCents < 1) {
    fail(BUYOUT_POLICY_CODES.contractInvalid);
  }
  const obligation = Object.freeze({
    id: command.buyoutId,
    league_id: command.leagueId,
    contract_id: command.contractId,
    player_id: command.playerId,
    originating_team_id: command.teamId,
    responsible_team_id: command.teamId,
    annual_penalty_basis_cents: annualPenaltyCents,
    buyout_transaction_id: command.activityId,
    status: "active",
    created_at_ms: command.occurredAtMs,
    updated_at_ms: command.occurredAtMs,
    version: 1,
  });
  const years = Object.freeze(
    remainingYears.map((year, index) =>
      Object.freeze({
        id: command.buyoutYearIds[index],
        league_id: command.leagueId,
        buyout_obligation_id: command.buyoutId,
        season_id: year.seasonId,
        penalty_cents: annualPenaltyCents,
        status: year.status,
        created_at_ms: command.occurredAtMs,
      })
    )
  );
  return Object.freeze({
    obligation,
    years,
    annualPenaltyCents,
    totalScheduledPenaltyCents: annualPenaltyCents * years.length,
    remainingYears: Object.freeze(remainingYears),
  });
}

module.exports = {
  BUYOUT_POLICY_CODES,
  BuyoutPolicyError,
  calculateBuyoutPenaltyCents,
  createBuyoutAggregate,
  validateBuyoutCommand,
};
