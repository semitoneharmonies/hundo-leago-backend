"use strict";

const {
  createFreeAgentDraftAuctionDrawReveal,
  createFreeAgentDraftAuctionNoSelectionReveal,
} = require(
  "../freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);

const AUCTION_READ_PROJECTION_CODES = Object.freeze({
  projectionInvalid: "AUCTION_READ_PROJECTION_INVALID",
});

const AUCTION_READ_PROJECTION_REASON_CODES = Object.freeze({
  auctionFieldsInvalid: "auction_fields_invalid",
  auctionInvalid: "auction_invalid",
  playerInvalid: "player_invalid",
  teamInvalid: "team_invalid",
  capabilityInvalid: "capability_invalid",
  viewerTeamsInvalid: "viewer_teams_invalid",
  viewerBidInvalid: "viewer_bid_invalid",
  administrativeBidsInvalid: "administrative_bids_invalid",
  contextInvalid: "auction_context_invalid",
  minimumContractInvalid: "minimum_contract_invalid",
  resultInvalid: "auction_result_invalid",
  drawEvidenceInvalid: "draw_evidence_invalid",
  startTeamsInvalid: "start_teams_invalid",
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_UINT32 = 0xffff_ffff;
const AUCTION_CREATION_CUTOFF_LEAD_MS = 3_600_000;

const PUBLIC_STATUSES = Object.freeze([
  "active",
  "resolved",
  "no_winner",
  "cancelled",
  "correction_required",
]);
const SOURCE_KINDS = Object.freeze([
  "ordinary_weekly",
  "fad_open_rapid",
  "fad_restricted",
]);
const BID_STATUSES = Object.freeze([
  "active",
  "won",
  "lost",
  "withdrawn",
  "invalid",
]);
const PARTICIPANT_STATUSES = Object.freeze([
  "active",
  "removed",
]);
const CAPABILITY_REASON_CODES = Object.freeze([
  "NOT_AUTHORIZED",
  "HELP_NOT_GRANTED",
  "PHASE_CLOSED",
  "DEADLINE_PASSED",
  "LEAGUE_FROZEN",
  "SLOT_LOCKED",
  "SLOT_OCCUPIED",
  "ENTRY_NOT_EDITABLE",
  "PLAYER_INELIGIBLE",
  "TEAM_NOT_PARTICIPANT",
  "COOLDOWN_ACTIVE",
  "EDIT_LIMIT_REACHED",
  "PLAYER_QUARANTINED",
  "RECOVERY_NOT_AVAILABLE",
]);

const AUCTION_FIELDS = Object.freeze([
  "administrativeBids",
  "auctionId",
  "bidCount",
  "capabilities",
  "creationCutoffAtMs",
  "drawCommitment",
  "eligibleTeams",
  "fadId",
  "fadOrigin",
  "fadRolloverId",
  "leagueId",
  "minimumContract",
  "openedAtMs",
  "participatingTeamCount",
  "player",
  "resolvedAtMs",
  "resolvesAtMs",
  "result",
  "seasonId",
  "sourceKind",
  "status",
  "targetRolloverAtMs",
  "updatedAtMs",
  "version",
  "viewerTeams",
]);
const TEAM_FIELDS = Object.freeze([
  "logoReference",
  "name",
  "patternTemplate",
  "primaryColour",
  "secondaryColour",
  "teamId",
  "tertiaryColour",
]);
const PLAYER_FIELDS = Object.freeze([
  "fullName",
  "playerId",
  "positionGroup",
]);
const CAPABILITY_FIELDS = Object.freeze([
  "allowed",
  "reasonCode",
]);
const VIEWER_TEAM_FIELDS = Object.freeze([
  "bid",
  "edit",
  "eligible",
  "join",
  "participantStatus",
  "team",
  "teamId",
]);
const VIEWER_BID_FIELDS = Object.freeze([
  "aavCents",
  "bidId",
  "cooldownEndsAtMs",
  "editCount",
  "editLimit",
  "status",
  "termYears",
  "totalValueCents",
  "version",
]);
const FAD_VIEWER_BID_FIELDS = Object.freeze([
  ...VIEWER_BID_FIELDS,
  "bindingIllegalityConfirmedAtMs",
].sort());
const ADMINISTRATIVE_BID_FIELDS = Object.freeze([
  "bidId",
  "capabilities",
  "participantStatus",
  "status",
  "team",
  "teamId",
  "version",
]);
const RESULT_FIELDS = Object.freeze([
  "activityId",
  "contractId",
  "drawEvidence",
  "finalAavCents",
  "finalContractValueCents",
  "outcomeCode",
  "ownershipId",
  "recoveryId",
  "resolvedAtMs",
  "submittedAavCents",
  "submittedTermYears",
  "submittedTotalValueCents",
  "winningTeam",
]);
const DRAW_EVIDENCE_FIELDS = Object.freeze([
  "commitmentHex",
  "reveal",
]);
const DRAW_REVEAL_FIELDS = Object.freeze([
  "algorithmVersion",
  "counter",
  "digestHex",
  "nonceHex",
  "orderedBidIds",
  "selectedBidId",
  "selectedIndex",
  "selectedTeamId",
  "selectionUsed",
]);
const START_TEAM_FIELDS = Object.freeze([
  "creationCutoffAtMs",
  "fadId",
  "fadRolloverId",
  "sourceKind",
  "startAuction",
  "targetRolloverAtMs",
  "team",
  "teamId",
]);

class AuctionReadProjectionPolicyError extends Error {
  constructor(reasonCode) {
    super("The auction read projection is invalid.");
    this.name = "AuctionReadProjectionPolicyError";
    this.code =
      AUCTION_READ_PROJECTION_CODES.projectionInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new AuctionReadProjectionPolicyError(reasonCode);
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactDataFields(value, fields) {
  if (!isPlainObject(value)) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    return false;
  }
  const keys = [...ownKeys].sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      key
    );
    return Boolean(
      descriptor &&
      descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    );
  });
}

function isExactDataArray(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return false;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(
    value,
    "length"
  );
  if (
    !lengthDescriptor ||
    !Object.prototype.hasOwnProperty.call(
      lengthDescriptor,
      "value"
    ) ||
    lengthDescriptor.value !== value.length
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index)
    );
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      return false;
    }
  }
  return true;
}

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object"
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
  }
  return value;
}

function stableId(value, reasonCode) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(reasonCode);
  }
  return value;
}

function nullableStableId(value, reasonCode) {
  return value === null ? null : stableId(value, reasonCode);
}

function positiveVersion(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(reasonCode);
  }
  return value;
}

function nonnegativeInteger(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    fail(reasonCode);
  }
  return value;
}

function validateText(value, reasonCode) {
  if (typeof value !== "string" || value.length < 1) {
    fail(reasonCode);
  }
}

function validateTeam(value, reasonCode) {
  if (!hasExactDataFields(value, TEAM_FIELDS)) {
    fail(reasonCode);
  }
  stableId(value.teamId, reasonCode);
  for (const field of [
    "name",
    "patternTemplate",
    "primaryColour",
    "secondaryColour",
  ]) {
    validateText(value[field], reasonCode);
  }
  for (const field of [
    "logoReference",
    "tertiaryColour",
  ]) {
    if (
      value[field] !== null &&
      typeof value[field] !== "string"
    ) {
      fail(reasonCode);
    }
  }
}

function validatePlayer(value) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.playerInvalid;
  if (!hasExactDataFields(value, PLAYER_FIELDS)) {
    fail(reason);
  }
  stableId(value.playerId, reason);
  validateText(value.fullName, reason);
  if (!["F", "D"].includes(value.positionGroup)) {
    fail(reason);
  }
}

function validateCapability(value) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.capabilityInvalid;
  if (!hasExactDataFields(value, CAPABILITY_FIELDS)) {
    fail(reason);
  }
  if (
    typeof value.allowed !== "boolean" ||
    (value.allowed && value.reasonCode !== null) ||
    (!value.allowed &&
      !CAPABILITY_REASON_CODES.includes(value.reasonCode))
  ) {
    fail(reason);
  }
}

function roundedAavCents(totalValueCents, termYears) {
  const whole = Math.floor(totalValueCents / termYears);
  const remainder = totalValueCents % termYears;
  return whole + (remainder * 2 >= termYears ? 1 : 0);
}

function validateOffer(
  value,
  fields,
  reasonCode,
  { enforceBidMinimum = true } = {}
) {
  if (!hasExactDataFields(value, fields)) {
    fail(reasonCode);
  }
  const commonValid =
    !Number.isSafeInteger(value.termYears) ||
    value.termYears < 1 || value.termYears > 3 ||
    !Number.isSafeInteger(value.totalValueCents) || value.totalValueCents < 1 ||
    !Number.isSafeInteger(value.aavCents) || value.aavCents < 100;
  if (commonValid) {
    fail(reasonCode);
  }
  const aavFirstContract =
    value.aavCents % 25 === 0 &&
    value.totalValueCents === value.aavCents * value.termYears;
  const legacyContract =
    value.totalValueCents >= value.termYears * 100 &&
    (value.termYears === 1 || value.totalValueCents % 100 === 0) &&
    value.aavCents === roundedAavCents(
      value.totalValueCents,
      value.termYears
    );
  if ((!aavFirstContract && !legacyContract) ||
      (enforceBidMinimum && value.totalValueCents < value.termYears * 100)) {
    fail(reasonCode);
  }
}

function validateViewerBid(value, isFad) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.viewerBidInvalid;
  validateOffer(
    value,
    isFad ? FAD_VIEWER_BID_FIELDS : VIEWER_BID_FIELDS,
    reason
  );
  stableId(value.bidId, reason);
  positiveVersion(value.version, reason);
  if (!BID_STATUSES.includes(value.status)) {
    fail(reason);
  }
  nonnegativeInteger(value.editCount, reason);
  nonnegativeInteger(value.editLimit, reason);
  if (value.editCount > value.editLimit) {
    fail(reason);
  }
  safeTimestamp(value.cooldownEndsAtMs, reason);
  if (isFad) {
    safeTimestamp(
      value.bindingIllegalityConfirmedAtMs,
      reason
    );
  }
}

function assertUniqueId(set, id, reasonCode) {
  if (set.has(id)) {
    fail(reasonCode);
  }
  set.add(id);
}

function validateViewerTeams(value, sourceKind, eligibleIds) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.viewerTeamsInvalid;
  if (!isExactDataArray(value)) {
    fail(reason);
  }
  const isFad = sourceKind !== "ordinary_weekly";
  const restricted = sourceKind === "fad_restricted";
  const teamIds = new Set();
  const bidIds = new Set();
  for (const row of value) {
    if (!hasExactDataFields(row, VIEWER_TEAM_FIELDS)) {
      fail(reason);
    }
    const teamId = stableId(row.teamId, reason);
    assertUniqueId(teamIds, teamId, reason);
    validateTeam(
      row.team,
      AUCTION_READ_PROJECTION_REASON_CODES.teamInvalid
    );
    if (row.team.teamId !== teamId) {
      fail(reason);
    }
    if (typeof row.eligible !== "boolean") {
      fail(reason);
    }
    if (restricted) {
      if (
        row.participantStatus !== null &&
        !PARTICIPANT_STATUSES.includes(
          row.participantStatus
        )
      ) {
        fail(reason);
      }
      if (
        row.eligible !==
          (row.participantStatus === "active") ||
        (row.participantStatus !== null &&
          eligibleIds.size > 0 &&
          !eligibleIds.has(teamId))
      ) {
        fail(reason);
      }
    } else if (
      row.participantStatus !== null ||
      row.eligible !== true
    ) {
      fail(reason);
    }
    if (row.bid !== null) {
      validateViewerBid(row.bid, isFad);
      assertUniqueId(bidIds, row.bid.bidId, reason);
    }
    validateCapability(row.join);
    validateCapability(row.edit);
  }
  return Object.freeze({
    bidCount: bidIds.size,
    bidIds,
    teamIds,
  });
}

function validateAdministrativeBids(value, sourceKind) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES
      .administrativeBidsInvalid;
  if (!isExactDataArray(value)) {
    fail(reason);
  }
  const restricted = sourceKind === "fad_restricted";
  const bidIds = new Set();
  const activeTeamIds = new Set();
  for (const row of value) {
    if (!hasExactDataFields(row, ADMINISTRATIVE_BID_FIELDS)) {
      fail(reason);
    }
    const bidId = stableId(row.bidId, reason);
    const teamId = stableId(row.teamId, reason);
    assertUniqueId(bidIds, bidId, reason);
    if (row.status === "active") {
      assertUniqueId(activeTeamIds, teamId, reason);
    }
    validateTeam(
      row.team,
      AUCTION_READ_PROJECTION_REASON_CODES.teamInvalid
    );
    if (
      row.team.teamId !== teamId ||
      !BID_STATUSES.includes(row.status) ||
      (restricted
        ? !PARTICIPANT_STATUSES.includes(
            row.participantStatus
          )
        : row.participantStatus !== null) ||
      !hasExactDataFields(row.capabilities, [
        "adminEditBid",
        "adminRemoveBid",
      ])
    ) {
      fail(reason);
    }
    validateCapability(row.capabilities.adminEditBid);
    validateCapability(row.capabilities.adminRemoveBid);
  }
  return Object.freeze({
    bidCount: bidIds.size,
    bidIds,
  });
}

function validateMinimumContract(value) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES
      .minimumContractInvalid;
  validateOffer(
    value,
    ["aavCents", "termYears", "totalValueCents"],
    reason,
    { enforceBidMinimum: false }
  );
}

function validateEligibleTeams(value, restricted) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.contextInvalid;
  if (!isExactDataArray(value)) {
    fail(reason);
  }
  if (!restricted && value.length !== 0) {
    fail(reason);
  }
  const ids = new Set();
  for (const team of value) {
    validateTeam(
      team,
      AUCTION_READ_PROJECTION_REASON_CODES.teamInvalid
    );
    assertUniqueId(ids, team.teamId, reason);
  }
  return ids;
}

function validateAuctionContext(value) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.contextInvalid;
  if (!SOURCE_KINDS.includes(value.sourceKind)) {
    fail(reason);
  }
  const isFad = value.sourceKind !== "ordinary_weekly";
  const restricted = value.sourceKind === "fad_restricted";
  if (!isFad) {
    if (
      value.fadOrigin !== null ||
      value.fadId !== null ||
      value.fadRolloverId !== null ||
      value.targetRolloverAtMs !== null ||
      value.creationCutoffAtMs !== null ||
      value.minimumContract !== null ||
      value.drawCommitment !== null
    ) {
      fail(reason);
    }
  } else {
    stableId(value.fadId, reason);
    stableId(value.fadRolloverId, reason);
    const target = safeTimestamp(
      value.targetRolloverAtMs,
      reason
    );
    const cutoff = safeTimestamp(
      value.creationCutoffAtMs,
      reason
    );
    if (
      cutoff !== target - AUCTION_CREATION_CUTOFF_LEAD_MS
    ) {
      fail(reason);
    }
    const validOrigin = restricted
      ? value.fadOrigin === "candidate_tie_restricted"
      : [
          "manager_nomination",
          "queued_nomination",
          "restricted_no_improvement_fallback",
        ].includes(value.fadOrigin);
    if (!validOrigin) {
      fail(reason);
    }
    const floorRequired = restricted ||
      value.fadOrigin ===
        "restricted_no_improvement_fallback";
    if (
      floorRequired !== (value.minimumContract !== null)
    ) {
      fail(reason);
    }
    if (value.minimumContract !== null) {
      validateMinimumContract(value.minimumContract);
    }
    if (
      value.drawCommitment !== null &&
      !SHA256_PATTERN.test(value.drawCommitment)
    ) {
      fail(reason);
    }
    if (
      value.status === "active" &&
      value.drawCommitment === null
    ) {
      fail(reason);
    }
  }
  return Object.freeze({
    eligibleIds: validateEligibleTeams(
      value.eligibleTeams,
      restricted
    ),
    isFad,
    restricted,
  });
}

function nonceBytesFromHex(value, reasonCode) {
  if (!SHA256_PATTERN.test(value)) {
    fail(reasonCode);
  }
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(
      value.slice(index * 2, index * 2 + 2),
      16
    );
  }
  return result;
}

function validateDrawReveal(value, projection, result, commitmentHex) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.drawEvidenceInvalid;
  if (!hasExactDataFields(value, DRAW_REVEAL_FIELDS)) {
    fail(reason);
  }
  if (
    value.algorithmVersion !== 1 ||
    !SHA256_PATTERN.test(value.nonceHex) ||
    typeof value.selectionUsed !== "boolean" ||
    !isExactDataArray(value.orderedBidIds)
  ) {
    fail(reason);
  }
  if (!value.selectionUsed) {
    if (
      value.orderedBidIds.length !== 0 ||
      value.counter !== null ||
      value.digestHex !== null ||
      value.selectedIndex !== null ||
      value.selectedBidId !== null ||
      value.selectedTeamId !== null
    ) {
      fail(reason);
    }
    let canonical;
    try {
      canonical =
        createFreeAgentDraftAuctionNoSelectionReveal({
          auctionId: projection.auctionId,
          commitmentHex,
          nonceBytes: nonceBytesFromHex(
            value.nonceHex,
            reason
          ),
        });
    } catch {
      fail(reason);
    }
    if (
      canonical.algorithmVersion !== value.algorithmVersion ||
      canonical.nonceHex !== value.nonceHex
    ) {
      fail(reason);
    }
    return;
  }
  if (
    value.orderedBidIds.length < 2 ||
    !Number.isSafeInteger(value.counter) ||
    value.counter < 0 ||
    value.counter > MAX_UINT32 ||
    !SHA256_PATTERN.test(value.digestHex || "") ||
    !Number.isSafeInteger(value.selectedIndex) ||
    value.selectedIndex < 0 ||
    value.selectedIndex >= value.orderedBidIds.length
  ) {
    fail(reason);
  }
  const ids = new Set();
  for (const bidId of value.orderedBidIds) {
    stableId(bidId, reason);
    assertUniqueId(ids, bidId, reason);
  }
  const sorted = [...value.orderedBidIds].sort();
  if (
    sorted.some(
      (bidId, index) => bidId !== value.orderedBidIds[index]
    ) ||
    value.selectedBidId !==
      value.orderedBidIds[value.selectedIndex]
  ) {
    fail(reason);
  }
  stableId(value.selectedTeamId, reason);
  let canonical;
  try {
    canonical = createFreeAgentDraftAuctionDrawReveal({
      auctionId: projection.auctionId,
      commitmentHex,
      nonceBytes: nonceBytesFromHex(value.nonceHex, reason),
      rolloverAtMs: projection.targetRolloverAtMs,
      tiedBidIds: value.orderedBidIds,
    });
  } catch {
    fail(reason);
  }
  for (const field of [
    "algorithmVersion",
    "nonceHex",
    "selectionUsed",
    "counter",
    "digestHex",
    "selectedIndex",
    "selectedBidId",
  ]) {
    if (canonical[field] !== value[field]) {
      fail(reason);
    }
  }
  if (
    canonical.orderedBidIds.some(
      (bidId, index) => bidId !== value.orderedBidIds[index]
    )
  ) {
    fail(reason);
  }
  if (
    result.outcomeCode === "resolved" &&
    value.selectedTeamId !== result.winningTeam.teamId
  ) {
    fail(reason);
  }
}

function validateDrawEvidence(value, projection, result) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.drawEvidenceInvalid;
  if (!hasExactDataFields(value, DRAW_EVIDENCE_FIELDS)) {
    fail(reason);
  }
  if (!SHA256_PATTERN.test(value.commitmentHex)) {
    fail(reason);
  }
  if (
    projection.drawCommitment !== null &&
    projection.drawCommitment !== value.commitmentHex
  ) {
    fail(reason);
  }
  if (value.reveal === null) {
    if (
      projection.status !== "correction_required" ||
      projection.drawCommitment === null
    ) {
      fail(reason);
    }
    return;
  }
  validateDrawReveal(
    value.reveal,
    projection,
    result,
    value.commitmentHex
  );
  if (
    ["no_winner", "cancelled"].includes(
      projection.status
    ) &&
    value.reveal.selectionUsed
  ) {
    fail(reason);
  }
}

function nullablePositiveInteger(value, reasonCode) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(reasonCode);
  }
  return value;
}

function validateTerminalResult(value, projection, isFad) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.resultInvalid;
  if (!hasExactDataFields(value, RESULT_FIELDS)) {
    fail(reason);
  }
  if (
    value.outcomeCode !== projection.status ||
    safeTimestamp(value.resolvedAtMs, reason) !==
      projection.resolvedAtMs
  ) {
    fail(reason);
  }
  for (const field of [
    "activityId",
    "contractId",
    "ownershipId",
    "recoveryId",
  ]) {
    nullableStableId(value[field], reason);
  }
  for (const field of [
    "submittedTotalValueCents",
    "submittedTermYears",
    "submittedAavCents",
    "finalContractValueCents",
    "finalAavCents",
  ]) {
    nullablePositiveInteger(value[field], reason);
  }
  const winnerFields = [
    value.winningTeam,
    value.submittedTotalValueCents,
    value.submittedTermYears,
    value.submittedAavCents,
    value.finalContractValueCents,
    value.finalAavCents,
    value.contractId,
    value.ownershipId,
  ];
  if (projection.status === "resolved") {
    if (winnerFields.some((field) => field === null)) {
      fail(reason);
    }
    validateTeam(
      value.winningTeam,
      AUCTION_READ_PROJECTION_REASON_CODES.teamInvalid
    );
    if (
      value.submittedTermYears > 3 ||
      roundedAavCents(
        value.submittedTotalValueCents,
        value.submittedTermYears
      ) !== value.submittedAavCents ||
      roundedAavCents(
        value.finalContractValueCents,
        value.submittedTermYears
      ) !== value.finalAavCents
    ) {
      fail(reason);
    }
  } else if (winnerFields.some((field) => field !== null)) {
    fail(reason);
  }
  if (
    projection.status === "correction_required" &&
    value.recoveryId === null
  ) {
    fail(reason);
  }
  if (isFad) {
    if (value.drawEvidence === null) {
      fail(reason);
    }
    validateDrawEvidence(
      value.drawEvidence,
      projection,
      value
    );
  } else if (value.drawEvidence !== null) {
    fail(reason);
  }
}

function validateLifecycle(value, isFad) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid;
  const openedAtMs = safeTimestamp(value.openedAtMs, reason);
  const resolvesAtMs = safeTimestamp(
    value.resolvesAtMs,
    reason
  );
  const updatedAtMs = safeTimestamp(value.updatedAtMs, reason);
  if (
    resolvesAtMs <= openedAtMs ||
    updatedAtMs < openedAtMs
  ) {
    fail(reason);
  }
  if (value.status === "active") {
    if (value.resolvedAtMs !== null || value.result !== null) {
      fail(reason);
    }
  } else {
    safeTimestamp(value.resolvedAtMs, reason);
    if (value.result === null) {
      fail(reason);
    }
    validateTerminalResult(value.result, value, isFad);
  }
}

function validateAuctionReadProjection(value) {
  if (!hasExactDataFields(value, AUCTION_FIELDS)) {
    fail(
      AUCTION_READ_PROJECTION_REASON_CODES
        .auctionFieldsInvalid
    );
  }
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid;
  stableId(value.auctionId, reason);
  stableId(value.leagueId, reason);
  stableId(value.seasonId, reason);
  positiveVersion(value.version, reason);
  validatePlayer(value.player);
  if (!PUBLIC_STATUSES.includes(value.status)) {
    fail(reason);
  }
  const bidCount = nonnegativeInteger(
    value.bidCount,
    reason
  );
  const participatingTeamCount = nonnegativeInteger(
    value.participatingTeamCount,
    reason
  );
  if (participatingTeamCount > bidCount) {
    fail(reason);
  }
  const context = validateAuctionContext(value);
  validateLifecycle(value, context.isFad);
  validateViewerTeams(
    value.viewerTeams,
    value.sourceKind,
    context.eligibleIds
  );
  validateAdministrativeBids(
    value.administrativeBids,
    value.sourceKind
  );
  if (
    !hasExactDataFields(value.capabilities, [
      "adminCancel",
      "adminResolve",
      "view",
    ])
  ) {
    fail(
      AUCTION_READ_PROJECTION_REASON_CODES
        .capabilityInvalid
    );
  }
  validateCapability(value.capabilities.view);
  validateCapability(value.capabilities.adminCancel);
  validateCapability(value.capabilities.adminResolve);
  return deepFreeze(value);
}

function validateAuctionStartTeamsProjection(value) {
  const reason =
    AUCTION_READ_PROJECTION_REASON_CODES.startTeamsInvalid;
  if (!isExactDataArray(value)) {
    fail(reason);
  }
  const teamIds = new Set();
  for (const row of value) {
    if (!hasExactDataFields(row, START_TEAM_FIELDS)) {
      fail(reason);
    }
    const teamId = stableId(row.teamId, reason);
    assertUniqueId(teamIds, teamId, reason);
    validateTeam(
      row.team,
      AUCTION_READ_PROJECTION_REASON_CODES.teamInvalid
    );
    if (row.team.teamId !== teamId) {
      fail(reason);
    }
    validateCapability(row.startAuction);
    if (row.sourceKind === "ordinary_weekly") {
      if (
        row.fadId !== null ||
        row.fadRolloverId !== null ||
        row.targetRolloverAtMs !== null ||
        row.creationCutoffAtMs !== null
      ) {
        fail(reason);
      }
    } else if (row.sourceKind === "fad_open_rapid") {
      stableId(row.fadId, reason);
      const rolloverValues = [
        row.fadRolloverId,
        row.targetRolloverAtMs,
        row.creationCutoffAtMs,
      ];
      const allNull = rolloverValues.every(
        (item) => item === null
      );
      const allPresent = rolloverValues.every(
        (item) => item !== null
      );
      if (!allNull && !allPresent) {
        fail(reason);
      }
      if (allPresent) {
        stableId(row.fadRolloverId, reason);
        const target = safeTimestamp(
          row.targetRolloverAtMs,
          reason
        );
        const cutoff = safeTimestamp(
          row.creationCutoffAtMs,
          reason
        );
        if (
          cutoff !==
            target - AUCTION_CREATION_CUTOFF_LEAD_MS
        ) {
          fail(reason);
        }
      }
    } else {
      fail(reason);
    }
  }
  return deepFreeze(value);
}

module.exports = {
  AUCTION_READ_PROJECTION_CODES,
  AUCTION_READ_PROJECTION_REASON_CODES,
  AuctionReadProjectionPolicyError,
  validateAuctionReadProjection,
  validateAuctionStartTeamsProjection,
};
