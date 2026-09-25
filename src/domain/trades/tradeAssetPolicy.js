const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_ASSETS_PER_SIDE = 100;
const TRADE_PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const TRADE_ASSET_TYPES = Object.freeze([
  "contract",
  "prospect_right",
  "draft_pick",
  "retention_obligation",
  "buyout_obligation",
  "future_consideration",
  "future_consideration_instruction",
  "requested_retention",
]);

const TRADE_ASSET_CODES = Object.freeze({
  inputInvalid: "TRADE_ASSET_INPUT_INVALID",
  stableIdInvalid: "TRADE_ASSET_STABLE_ID_INVALID",
  typeUnsupported: "TRADE_ASSET_TYPE_UNSUPPORTED",
  assetCountInvalid: "TRADE_ASSET_COUNT_INVALID",
  minimumContributionRequired: "TRADE_ASSET_MINIMUM_CONTRIBUTION_REQUIRED",
  duplicate: "TRADE_ASSET_DUPLICATE",
  conflict: "TRADE_ASSET_CONFLICT",
  retentionInvalid: "TRADE_ASSET_RETENTION_INVALID",
  descriptionInvalid: "TRADE_ASSET_DESCRIPTION_INVALID",
  authorityInvalid: "TRADE_ASSET_AUTHORITY_INVALID",
  timestampInvalid: "TRADE_ASSET_TIMESTAMP_INVALID",
  idempotencyInvalid: "TRADE_ASSET_IDEMPOTENCY_INVALID",
  ineligible: "TRADE_ASSET_INELIGIBLE",
  staleOwnership: "TRADE_ASSET_STALE_OWNERSHIP",
  snapshotInvalid: "TRADE_ASSET_SNAPSHOT_INVALID",
  idempotencyConflict: "TRADE_ASSET_IDEMPOTENCY_CONFLICT",
});

class TradeAssetPolicyError extends Error {
  constructor(reasonCode) {
    super("The typed trade asset request is invalid.");
    this.name = "TradeAssetPolicyError";
    this.code = TRADE_ASSET_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new TradeAssetPolicyError(reasonCode);
}

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRADE_ASSET_CODES.inputInvalid);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(TRADE_ASSET_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(TRADE_ASSET_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    fail(TRADE_ASSET_CODES.timestampInvalid);
  }
  return value;
}

function description(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    fail(TRADE_ASSET_CODES.descriptionInvalid);
  }
  return value;
}

function boundedIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    fail(TRADE_ASSET_CODES.idempotencyInvalid);
  }
  return value;
}

function blankAsset(inputType) {
  return {
    inputType,
    assetType:
      inputType === "future_consideration_instruction"
        ? "future_consideration"
        : inputType,
    contractId: null,
    playerId: null,
    draftPickId: null,
    retentionObligationId: null,
    buyoutObligationId: null,
    futureConsiderationId: null,
    requestedRetentionContractId: null,
    requestedRetentionCents: null,
    futureConsiderationDescription: null,
  };
}

function validateTradeAssetInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(TRADE_ASSET_CODES.inputInvalid);
  }
  if (!TRADE_ASSET_TYPES.includes(input.type)) {
    fail(TRADE_ASSET_CODES.typeUnsupported);
  }
  const asset = blankAsset(input.type);
  switch (input.type) {
    case "contract":
      exactObject(input, ["type", "contractId"]);
      asset.contractId = stableId(input.contractId);
      break;
    case "prospect_right":
      exactObject(input, ["type", "playerId"]);
      asset.playerId = stableId(input.playerId);
      break;
    case "draft_pick":
      exactObject(input, ["type", "draftPickId"]);
      asset.draftPickId = stableId(input.draftPickId);
      break;
    case "retention_obligation":
      exactObject(input, ["type", "retentionObligationId"]);
      asset.retentionObligationId = stableId(input.retentionObligationId);
      break;
    case "buyout_obligation":
      exactObject(input, ["type", "buyoutObligationId"]);
      asset.buyoutObligationId = stableId(input.buyoutObligationId);
      break;
    case "future_consideration":
      exactObject(input, ["type", "futureConsiderationId"]);
      asset.futureConsiderationId = stableId(input.futureConsiderationId);
      break;
    case "future_consideration_instruction":
      exactObject(input, ["type", "description"]);
      asset.futureConsiderationDescription = description(input.description);
      break;
    case "requested_retention":
      exactObject(input, ["type", "contractId", "retainedAavCents"]);
      asset.requestedRetentionContractId = stableId(input.contractId);
      if (
        !Number.isSafeInteger(input.retainedAavCents) ||
        input.retainedAavCents <= 0
      ) {
        fail(TRADE_ASSET_CODES.retentionInvalid);
      }
      asset.requestedRetentionCents = input.retainedAavCents;
      break;
    default:
      fail(TRADE_ASSET_CODES.typeUnsupported);
  }
  return Object.freeze(asset);
}

function assetIdentity(asset, sourceTeamId, destinationTeamId = "") {
  if (asset.contractId) return `contract:${asset.contractId}`;
  if (asset.playerId) return `player:${asset.playerId}`;
  if (asset.draftPickId) return `draft_pick:${asset.draftPickId}`;
  if (asset.retentionObligationId) {
    return `retention_obligation:${asset.retentionObligationId}`;
  }
  if (asset.buyoutObligationId) {
    return `buyout_obligation:${asset.buyoutObligationId}`;
  }
  if (asset.futureConsiderationId) {
    return `future_consideration:${asset.futureConsiderationId}`;
  }
  if (asset.requestedRetentionContractId) {
    return `requested_retention:${asset.requestedRetentionContractId}`;
  }
  return `future_consideration_instruction:${sourceTeamId}:${destinationTeamId}:${asset.futureConsiderationDescription}`;
}

function validateSide(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_ASSETS_PER_SIDE
  ) {
    fail(TRADE_ASSET_CODES.assetCountInvalid);
  }
  return value.map(validateTradeAssetInput);
}

function validateTradeProposalCreationInput(input) {
  if (input && Object.hasOwn(input, "participants")) return validateThreeTeamInput(input);
  exactObject(input, [
    "proposingTeamId",
    "receivingTeamId",
    "proposingAssets",
    "receivingAssets",
  ]);
  const proposingTeamId = stableId(input.proposingTeamId);
  const receivingTeamId = stableId(input.receivingTeamId);
  if (proposingTeamId === receivingTeamId) {
    fail(TRADE_ASSET_CODES.conflict);
  }
  const proposingAssets = validateSide(input.proposingAssets);
  const receivingAssets = validateSide(input.receivingAssets);
  for (const side of [proposingAssets, receivingAssets]) {
    if (!side.some((asset) => asset.inputType !== "requested_retention")) {
      fail(TRADE_ASSET_CODES.minimumContributionRequired);
    }
    const contractIds = new Set(
      side.filter((asset) => asset.contractId).map((asset) => asset.contractId)
    );
    for (const asset of side) {
      if (
        asset.requestedRetentionContractId &&
        !contractIds.has(asset.requestedRetentionContractId)
      ) {
        fail(TRADE_ASSET_CODES.retentionInvalid);
      }
    }
  }
  const identities = new Set();
  for (const [sourceTeamId, assets] of [
    [proposingTeamId, proposingAssets],
    [receivingTeamId, receivingAssets],
  ]) {
    for (const asset of assets) {
      const identity = assetIdentity(asset, sourceTeamId);
      if (identities.has(identity)) fail(TRADE_ASSET_CODES.duplicate);
      identities.add(identity);
    }
  }
  return Object.freeze({
    proposingTeamId,
    receivingTeamId,
    proposingAssets: Object.freeze(proposingAssets),
    receivingAssets: Object.freeze(receivingAssets),
  });
}

function validateThreeTeamInput(input) {
  exactObject(input, ["proposingTeamId", "participants"]);
  const proposingTeamId = stableId(input.proposingTeamId);
  if (!Array.isArray(input.participants) || input.participants.length !== 3) fail(TRADE_ASSET_CODES.assetCountInvalid);
  const teamIds = input.participants.map((side) => {
    exactObject(side, ["teamId", "assets"]);
    return stableId(side.teamId);
  });
  if (new Set(teamIds).size !== 3 || teamIds[0] !== proposingTeamId) fail(TRADE_ASSET_CODES.conflict);
  const identities = new Set();
  const participants = input.participants.map((side) => {
    if (!Array.isArray(side.assets) || side.assets.length < 1 || side.assets.length > MAX_ASSETS_PER_SIDE) fail(TRADE_ASSET_CODES.assetCountInvalid);
    const assets = side.assets.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) fail(TRADE_ASSET_CODES.inputInvalid);
      const { destinationTeamId, ...assetInput } = item;
      if (!teamIds.includes(destinationTeamId) || destinationTeamId === side.teamId) fail(TRADE_ASSET_CODES.conflict);
      const asset = validateTradeAssetInput(assetInput);
      const identity = assetIdentity(asset, side.teamId, destinationTeamId);
      if (identities.has(identity)) fail(TRADE_ASSET_CODES.duplicate);
      identities.add(identity);
      return Object.freeze({ ...asset, destinationTeamId });
    });
    if (!assets.some(asset => asset.inputType !== "requested_retention")) fail(TRADE_ASSET_CODES.minimumContributionRequired);
    for (const asset of assets) {
      if (asset.requestedRetentionContractId && !assets.some(contract => contract.contractId === asset.requestedRetentionContractId && contract.destinationTeamId === asset.destinationTeamId)) fail(TRADE_ASSET_CODES.retentionInvalid);
    }
    return Object.freeze({ teamId: side.teamId, assets: Object.freeze(assets) });
  });
  return Object.freeze({ proposingTeamId, receivingTeamId: teamIds[1], participants: Object.freeze(participants) });
}

function assertNewTradeProposalAssetTypes(assets) {
  if (!Array.isArray(assets)) {
    fail(TRADE_ASSET_CODES.inputInvalid);
  }
  if (
    assets.some(
      (asset) =>
        asset?.inputType === "retention_obligation" ||
        asset?.assetType === "retention_obligation"
    )
  ) {
    fail(TRADE_ASSET_CODES.typeUnsupported);
  }
  return true;
}

function createTradeAssetCommands({
  input,
  assetIds,
  createdAtMs,
} = {}) {
  if (input.participants) {
    const transfers = input.participants.flatMap(side => side.assets.map(asset => ({ ...asset, sourceTeamId: side.teamId })));
    if (!Array.isArray(assetIds) || assetIds.length !== transfers.length) fail(TRADE_ASSET_CODES.inputInvalid);
    return Object.freeze(transfers.map((asset, index) => Object.freeze({
      ...asset, id: stableId(assetIds[index]),
      // Legacy direction is retained for old readers; source/destination are authoritative.
      direction: asset.sourceTeamId === input.proposingTeamId ? "proposing_to_receiving" : "receiving_to_proposing",
      sequence: index + 1, createdAtMs: safeTimestamp(createdAtMs),
    })));
  }
  if (
    !Array.isArray(assetIds) ||
    assetIds.length !==
      input.proposingAssets.length + input.receivingAssets.length
  ) {
    fail(TRADE_ASSET_CODES.inputInvalid);
  }
  const occurredAtMs = safeTimestamp(createdAtMs);
  let sequence = 0;
  return Object.freeze(
    [
      ...input.proposingAssets.map((asset) => ({
        asset,
        direction: "proposing_to_receiving",
        sourceTeamId: input.proposingTeamId,
        destinationTeamId: input.receivingTeamId,
      })),
      ...input.receivingAssets.map((asset) => ({
        asset,
        direction: "receiving_to_proposing",
        sourceTeamId: input.receivingTeamId,
        destinationTeamId: input.proposingTeamId,
      })),
    ].map(({ asset, direction, sourceTeamId, destinationTeamId }, index) => {
      sequence += 1;
      return Object.freeze({
        id: stableId(assetIds[index]),
        direction,
        sourceTeamId,
        destinationTeamId,
        ...asset,
        sequence,
        createdAtMs: occurredAtMs,
      });
    })
  );
}

function validateCreationFoundation(input) {
  if (!["manager", "commissioner"].includes(input.actorAuthority)) {
    fail(TRADE_ASSET_CODES.authorityInvalid);
  }
  const foundation = Object.freeze({
    proposalId: stableId(input.tradeId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    proposingTeamId: stableId(input.proposingTeamId),
    receivingTeamId: stableId(input.receivingTeamId),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    createdAtMs: safeTimestamp(input.createdAtMs),
  });
  if (foundation.proposingTeamId === foundation.receivingTeamId) {
    fail(TRADE_ASSET_CODES.conflict);
  }
  return foundation;
}

function validateTradeProposalCreationCommand(input) {
  exactObject(input, [
    ...(Object.hasOwn(input, "participantTeamIds") ? ["participantTeamIds"] : []),
    "tradeId",
    "eventId",
    "idempotencyRequestId",
    "leagueId",
    "seasonId",
    "proposingTeamId",
    "receivingTeamId",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "createdAtMs",
    "expiresAtMs",
    "effectiveDeadlineAtMs",
    "idempotencyKey",
    "idempotencyExpiresAtMs",
    "assets",
  ]);
  const foundation = validateCreationFoundation(input);
  const participantTeamIds = input.participantTeamIds;
  if (participantTeamIds && (!Array.isArray(participantTeamIds) || participantTeamIds.length !== 3 || new Set(participantTeamIds).size !== 3 || participantTeamIds[0] !== foundation.proposingTeamId || participantTeamIds[1] !== foundation.receivingTeamId)) fail(TRADE_ASSET_CODES.conflict);
  if (participantTeamIds) participantTeamIds.forEach(stableId);
  const expiresAtMs = safeTimestamp(input.expiresAtMs);
  const effectiveDeadlineAtMs = safeTimestamp(input.effectiveDeadlineAtMs);
  const idempotencyExpiresAtMs = safeTimestamp(input.idempotencyExpiresAtMs);
  if (
    expiresAtMs !== foundation.createdAtMs + TRADE_PROPOSAL_LIFETIME_MS ||
    effectiveDeadlineAtMs <= foundation.createdAtMs ||
    effectiveDeadlineAtMs > expiresAtMs ||
    idempotencyExpiresAtMs <= foundation.createdAtMs ||
    !Array.isArray(input.assets) ||
    input.assets.length < 2 ||
    input.assets.length > MAX_ASSETS_PER_SIDE * (participantTeamIds ? 3 : 2)
  ) {
    fail(TRADE_ASSET_CODES.timestampInvalid);
  }
  const seenIds = new Set();
  const assets = input.assets.map((asset, index) => {
    exactObject(asset, [
      "id",
      "direction",
      "sourceTeamId",
      "destinationTeamId",
      "inputType",
      "assetType",
      "contractId",
      "playerId",
      "draftPickId",
      "retentionObligationId",
      "buyoutObligationId",
      "futureConsiderationId",
      "requestedRetentionContractId",
      "requestedRetentionCents",
      "futureConsiderationDescription",
      "sequence",
      "createdAtMs",
    ]);
    const expectedDirection =
      asset.sourceTeamId === foundation.proposingTeamId
        ? "proposing_to_receiving"
        : "receiving_to_proposing";
    const expectedDestination =
      asset.sourceTeamId === foundation.proposingTeamId
        ? foundation.receivingTeamId
        : foundation.proposingTeamId;
    if (
      asset.direction !== expectedDirection ||
      (participantTeamIds ? !participantTeamIds.includes(asset.destinationTeamId) || asset.destinationTeamId === asset.sourceTeamId : asset.destinationTeamId !== expectedDestination) ||
      !(participantTeamIds || [foundation.proposingTeamId, foundation.receivingTeamId]).includes(
        asset.sourceTeamId
      ) ||
      asset.sequence !== index + 1 ||
      asset.createdAtMs !== foundation.createdAtMs ||
      seenIds.has(asset.id)
    ) {
      fail(TRADE_ASSET_CODES.conflict);
    }
    stableId(asset.id);
    seenIds.add(asset.id);
    return Object.freeze({ ...asset });
  });
  return Object.freeze({
    ...foundation,
    ...(participantTeamIds ? { participantTeamIds: Object.freeze([...participantTeamIds]) } : {}),
    tradeId: foundation.proposalId,
    eventId: stableId(input.eventId),
    idempotencyRequestId: stableId(input.idempotencyRequestId),
    expiresAtMs,
    effectiveDeadlineAtMs,
    idempotencyKey: boundedIdempotencyKey(input.idempotencyKey),
    idempotencyExpiresAtMs,
    assets: Object.freeze(assets),
  });
}

function assertSnapshot(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    fail(TRADE_ASSET_CODES.snapshotInvalid);
  }
  return Object.freeze({ ...value });
}

module.exports = {
  MAX_ASSETS_PER_SIDE,
  TRADE_ASSET_CODES,
  TRADE_ASSET_TYPES,
  TradeAssetPolicyError,
  assertNewTradeProposalAssetTypes,
  assertSnapshot,
  boundedIdempotencyKey,
  createTradeAssetCommands,
  validateTradeAssetInput,
  validateTradeProposalCreationCommand,
  validateTradeProposalCreationInput,
};
