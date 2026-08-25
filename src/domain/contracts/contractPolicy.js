const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;

const CONTRACT_POLICY_CODES = Object.freeze({
  inputInvalid: "CONTRACT_INPUT_INVALID",
  stableIdInvalid: "CONTRACT_STABLE_ID_INVALID",
  totalValueInvalid: "CONTRACT_TOTAL_VALUE_INVALID",
  termInvalid: "CONTRACT_TERM_INVALID",
  precisionInvalid: "CONTRACT_PRECISION_INVALID",
  seasonScheduleInvalid: "CONTRACT_SEASON_SCHEDULE_INVALID",
  sourceInvalid: "CONTRACT_SOURCE_INVALID",
  timestampInvalid: "CONTRACT_TIMESTAMP_INVALID",
});

class ContractPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted contract is invalid.");
    this.name = "ContractPolicyError";
    this.code = CONTRACT_POLICY_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new ContractPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(CONTRACT_POLICY_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(CONTRACT_POLICY_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(CONTRACT_POLICY_CODES.stableIdInvalid);
  }
  return value;
}

function optionalStableId(value) {
  return value === null ? null : stableId(value);
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(CONTRACT_POLICY_CODES.timestampInvalid);
  }
  return value;
}

function optionalTimestamp(value) {
  return value === null ? null : safeTimestamp(value);
}

function sourceType(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length > 100 ||
    !SAFE_TEXT_PATTERN.test(value)
  ) {
    fail(CONTRACT_POLICY_CODES.sourceInvalid);
  }
  return value;
}

function contractTerm(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3) {
    fail(CONTRACT_POLICY_CODES.termInvalid);
  }
  return value;
}

function calculateRoundedAavCents(
  originalTotalValueCents,
  termYears
) {
  const term = contractTerm(termYears);
  if (
    !Number.isSafeInteger(originalTotalValueCents) ||
    originalTotalValueCents <= 0
  ) {
    fail(CONTRACT_POLICY_CODES.totalValueInvalid);
  }
  const quotient = Math.floor(originalTotalValueCents / term);
  const remainder = originalTotalValueCents % term;
  return quotient + (remainder * 2 >= term ? 1 : 0);
}

function normalContractValue(originalTotalValueCents, termYears) {
  const term = contractTerm(termYears);
  if (
    !Number.isSafeInteger(originalTotalValueCents) ||
    originalTotalValueCents < term * 100
  ) {
    fail(CONTRACT_POLICY_CODES.totalValueInvalid);
  }
  if (term > 1 && originalTotalValueCents % 100 !== 0) {
    fail(CONTRACT_POLICY_CODES.precisionInvalid);
  }
  return Object.freeze({
    originalTotalValueCents,
    termYears: term,
    aavCents: calculateRoundedAavCents(
      originalTotalValueCents,
      term
    ),
  });
}

function validateSchedule(ids, termYears, startSeasonId) {
  if (!Array.isArray(ids) || ids.length !== termYears) {
    fail(CONTRACT_POLICY_CODES.seasonScheduleInvalid);
  }
  const seasonIds = ids.map(stableId);
  if (
    seasonIds[0] !== startSeasonId ||
    new Set(seasonIds).size !== seasonIds.length
  ) {
    fail(CONTRACT_POLICY_CODES.seasonScheduleInvalid);
  }
  return seasonIds;
}

function validateContractLookup(input) {
  assertExactObject(input, ["leagueId", "playerId"]);
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    playerId: stableId(input.playerId),
  });
}

function validateContractYearLookup(input) {
  assertExactObject(input, ["leagueId", "contractId"]);
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    contractId: stableId(input.contractId),
  });
}

function createNormalContractAggregate(input) {
  assertExactObject(input, [
    "contractId",
    "contractYearIds",
    "contractEventId",
    "leagueId",
    "playerId",
    "teamId",
    "originalTotalValueCents",
    "termYears",
    "startSeasonId",
    "seasonIds",
    "acquisitionSourceType",
    "acquisitionSourceId",
    "auctionBuyoutLockExpiresAtMs",
    "actorUserId",
    "occurredAtMs",
  ]);
  const contractId = stableId(input.contractId);
  const contractEventId = stableId(input.contractEventId);
  const leagueId = stableId(input.leagueId);
  const playerId = stableId(input.playerId);
  const teamId = stableId(input.teamId);
  const startSeasonId = stableId(input.startSeasonId);
  const value = normalContractValue(
    input.originalTotalValueCents,
    input.termYears
  );
  const seasonIds = validateSchedule(
    input.seasonIds,
    value.termYears,
    startSeasonId
  );
  if (
    !Array.isArray(input.contractYearIds) ||
    input.contractYearIds.length !== value.termYears
  ) {
    fail(CONTRACT_POLICY_CODES.seasonScheduleInvalid);
  }
  const contractYearIds = input.contractYearIds.map(stableId);
  if (new Set(contractYearIds).size !== contractYearIds.length) {
    fail(CONTRACT_POLICY_CODES.seasonScheduleInvalid);
  }
  const acquisitionSourceType = sourceType(
    input.acquisitionSourceType
  );
  const acquisitionSourceId = optionalStableId(
    input.acquisitionSourceId
  );
  const auctionBuyoutLockExpiresAtMs = optionalTimestamp(
    input.auctionBuyoutLockExpiresAtMs
  );
  const actorUserId = optionalStableId(input.actorUserId);
  const occurredAtMs = safeTimestamp(input.occurredAtMs);

  const contract = Object.freeze({
    id: contractId,
    league_id: leagueId,
    player_id: playerId,
    current_team_id: teamId,
    contract_type: "normal",
    original_total_value_cents: value.originalTotalValueCents,
    original_term_years: value.termYears,
    aav_cents: value.aavCents,
    start_season_id: startSeasonId,
    status: "active",
    acquisition_source_type: acquisitionSourceType,
    acquisition_source_id: acquisitionSourceId,
    auction_buyout_lock_expires_at_ms:
      auctionBuyoutLockExpiresAtMs,
    created_at_ms: occurredAtMs,
    updated_at_ms: occurredAtMs,
    version: 1,
  });
  const years = Object.freeze(
    seasonIds.map((seasonId, index) =>
      Object.freeze({
        id: contractYearIds[index],
        league_id: leagueId,
        contract_id: contractId,
        season_id: seasonId,
        year_number: index + 1,
        aav_cents: value.aavCents,
        status: index === 0 ? "current" : "future",
        rollover_at_ms: null,
        created_at_ms: occurredAtMs,
      })
    )
  );
  const event = Object.freeze({
    id: contractEventId,
    league_id: leagueId,
    contract_id: contractId,
    player_id: playerId,
    team_id: teamId,
    actor_user_id: actorUserId,
    event_type: "contract_created",
    source_type: acquisitionSourceType,
    source_id: acquisitionSourceId,
    metadata_json: JSON.stringify({
      contractType: "normal",
      originalTotalValueCents: value.originalTotalValueCents,
      originalTermYears: value.termYears,
      aavCents: value.aavCents,
      startSeasonId,
    }),
    reason: null,
    occurred_at_ms: occurredAtMs,
  });

  return Object.freeze({ contract, years, event });
}

function createFantasyElcAggregate(input) {
  assertExactObject(input, [
    "contractId",
    "contractYearIds",
    "contractEventId",
    "leagueId",
    "playerId",
    "teamId",
    "startSeasonId",
    "seasonIds",
    "acquisitionSourceId",
    "actorUserId",
    "occurredAtMs",
  ]);
  const contractId = stableId(input.contractId);
  const contractEventId = stableId(input.contractEventId);
  const leagueId = stableId(input.leagueId);
  const playerId = stableId(input.playerId);
  const teamId = stableId(input.teamId);
  const startSeasonId = stableId(input.startSeasonId);
  const seasonIds = validateSchedule(
    input.seasonIds,
    3,
    startSeasonId
  );
  if (
    !Array.isArray(input.contractYearIds) ||
    input.contractYearIds.length !== 3
  ) {
    fail(CONTRACT_POLICY_CODES.seasonScheduleInvalid);
  }
  const contractYearIds = input.contractYearIds.map(stableId);
  if (new Set(contractYearIds).size !== contractYearIds.length) {
    fail(CONTRACT_POLICY_CODES.seasonScheduleInvalid);
  }
  const acquisitionSourceId = stableId(input.acquisitionSourceId);
  const actorUserId = stableId(input.actorUserId);
  const occurredAtMs = safeTimestamp(input.occurredAtMs);
  const contract = Object.freeze({
    id: contractId,
    league_id: leagueId,
    player_id: playerId,
    current_team_id: teamId,
    contract_type: "fantasy_elc",
    original_total_value_cents: 300,
    original_term_years: 3,
    aav_cents: 100,
    start_season_id: startSeasonId,
    status: "active",
    acquisition_source_type: "fantasy_elc",
    acquisition_source_id: acquisitionSourceId,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: occurredAtMs,
    updated_at_ms: occurredAtMs,
    version: 1,
  });
  const years = Object.freeze(
    seasonIds.map((seasonId, index) =>
      Object.freeze({
        id: contractYearIds[index],
        league_id: leagueId,
        contract_id: contractId,
        season_id: seasonId,
        year_number: index + 1,
        aav_cents: 100,
        status: index === 0 ? "current" : "future",
        rollover_at_ms: null,
        created_at_ms: occurredAtMs,
      })
    )
  );
  const event = Object.freeze({
    id: contractEventId,
    league_id: leagueId,
    contract_id: contractId,
    player_id: playerId,
    team_id: teamId,
    actor_user_id: actorUserId,
    event_type: "fantasy_elc_created",
    source_type: "fantasy_elc",
    source_id: acquisitionSourceId,
    metadata_json: JSON.stringify({
      contractType: "fantasy_elc",
      originalTotalValueCents: 300,
      originalTermYears: 3,
      aavCents: 100,
      startSeasonId,
    }),
    reason: null,
    occurred_at_ms: occurredAtMs,
  });
  return Object.freeze({ contract, years, event });
}

module.exports = {
  CONTRACT_POLICY_CODES,
  ContractPolicyError,
  calculateRoundedAavCents,
  createFantasyElcAggregate,
  createNormalContractAggregate,
  normalContractValue,
  validateContractLookup,
  validateContractYearLookup,
};
