const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CAP_ISSUE_CODES = Object.freeze([
  "ACTIVE_CONTRACT_MISSING",
  "ACTIVE_CONTRACT_TEAM_MISMATCH",
]);

const CAP_POLICY_CODES = Object.freeze({
  inputInvalid: "CAP_INPUT_INVALID",
  stableIdInvalid: "CAP_STABLE_ID_INVALID",
  amountInvalid: "CAP_AMOUNT_INVALID",
  componentDuplicate: "CAP_COMPONENT_DUPLICATE",
  retentionInvalid: "CAP_RETENTION_INVALID",
  issueInvalid: "CAP_ISSUE_INVALID",
});

class CapPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted cap calculation material is invalid.");
    this.name = "CapPolicyError";
    this.code = CAP_POLICY_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new CapPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(CAP_POLICY_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(CAP_POLICY_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    fail(CAP_POLICY_CODES.stableIdInvalid);
  }
  return value;
}

function amount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(CAP_POLICY_CODES.amountInvalid);
  }
  return value;
}

function activePlayer(value) {
  assertExactObject(value, [
    "playerId",
    "ownershipId",
    "contractId",
    "aavCents",
    "retainedAavCents",
  ]);
  const aavCents = amount(value.aavCents);
  const retainedAavCents = amount(value.retainedAavCents);
  if (retainedAavCents > aavCents) {
    fail(CAP_POLICY_CODES.retentionInvalid);
  }
  return Object.freeze({
    playerId: stableId(value.playerId),
    ownershipId: stableId(value.ownershipId),
    contractId: stableId(value.contractId),
    aavCents,
    retainedAavCents,
    netAavCents: aavCents - retainedAavCents,
  });
}

function obligation(value, type) {
  const idKey = type === "retention" ? "retentionId" : "buyoutId";
  assertExactObject(value, [
    idKey,
    "contractId",
    "playerId",
    "amountCents",
  ]);
  return Object.freeze({
    [idKey]: stableId(value[idKey]),
    contractId: stableId(value.contractId),
    playerId: stableId(value.playerId),
    amountCents: amount(value.amountCents),
  });
}

function issue(value) {
  assertExactObject(value, ["code", "playerId", "ownershipId"]);
  if (!CAP_ISSUE_CODES.includes(value.code)) {
    fail(CAP_POLICY_CODES.issueInvalid);
  }
  return Object.freeze({
    code: value.code,
    playerId: stableId(value.playerId),
    ownershipId: stableId(value.ownershipId),
  });
}

function assertUnique(values, key) {
  const ids = values.map((value) => value[key]);
  if (new Set(ids).size !== ids.length) {
    fail(CAP_POLICY_CODES.componentDuplicate);
  }
}

function safeSum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) fail(CAP_POLICY_CODES.amountInvalid);
  }
  return total;
}

function calculateTeamCap(input) {
  assertExactObject(input, [
    "leagueId",
    "seasonId",
    "teamId",
    "salaryCapCents",
    "activePlayers",
    "retentionObligations",
    "buyoutObligations",
    "issues",
  ]);
  if (
    !Array.isArray(input.activePlayers) ||
    !Array.isArray(input.retentionObligations) ||
    !Array.isArray(input.buyoutObligations) ||
    !Array.isArray(input.issues)
  ) {
    fail(CAP_POLICY_CODES.inputInvalid);
  }
  const activePlayers = Object.freeze(input.activePlayers.map(activePlayer));
  const retentionObligations = Object.freeze(
    input.retentionObligations.map((value) => obligation(value, "retention"))
  );
  const buyoutObligations = Object.freeze(
    input.buyoutObligations.map((value) => obligation(value, "buyout"))
  );
  const issues = Object.freeze(input.issues.map(issue));
  assertUnique(activePlayers, "playerId");
  assertUnique(activePlayers, "contractId");
  assertUnique(retentionObligations, "retentionId");
  assertUnique(buyoutObligations, "buyoutId");
  const activePlayerCents = safeSum(
    activePlayers.map((player) => player.netAavCents)
  );
  const retentionCents = safeSum(
    retentionObligations.map((item) => item.amountCents)
  );
  const buyoutCents = safeSum(
    buyoutObligations.map((item) => item.amountCents)
  );
  const capUsageCents = safeSum([
    activePlayerCents,
    retentionCents,
    buyoutCents,
  ]);
  const capLimitCents = amount(input.salaryCapCents);
  const breakdown = Object.freeze({
    activePlayerCents,
    retentionCents,
    buyoutCents,
  });
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    teamId: stableId(input.teamId),
    capLimitCents,
    capUsageCents,
    capSpaceCents: capLimitCents - capUsageCents,
    overCap: capUsageCents > capLimitCents,
    complete: issues.length === 0,
    breakdown,
    activePlayers,
    retentionObligations,
    buyoutObligations,
    issues,
  });
}

function validateCapLookup(input) {
  assertExactObject(input, ["leagueId", "seasonId", "teamId"]);
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    teamId: stableId(input.teamId),
  });
}

module.exports = {
  CAP_ISSUE_CODES,
  CAP_POLICY_CODES,
  CapPolicyError,
  calculateTeamCap,
  validateCapLookup,
};
