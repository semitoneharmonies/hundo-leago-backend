const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../leagues/seasonRolloverEvidencePolicy"
);

const FREE_AGENT_DRAFT_CORRECTION_MODE =
  "recompute_locked_snapshot";
const FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION =
  "APPLY FAD CORRECTION";
const FREE_AGENT_DRAFT_CORRECTION_PREVIEW_DOMAIN =
  "hundo-leago.fad-allocation-correction-preview";
const FREE_AGENT_DRAFT_CORRECTION_REQUEST_DOMAIN =
  "hundo-leago.fad-allocation-correction-request";
const FREE_AGENT_DRAFT_CORRECTION_SCHEMA_VERSION = 1;

const FREE_AGENT_DRAFT_CORRECTION_CODES = Object.freeze({
  inputInvalid:
    "FAD_ALLOCATION_CORRECTION_INPUT_INVALID",
  previewInvalid:
    "FAD_ALLOCATION_CORRECTION_PREVIEW_INVALID",
  resultInvalid:
    "FAD_ALLOCATION_CORRECTION_RESULT_INVALID",
  fingerprintDrift: "FAD_CORRECTION_NOT_APPLICABLE",
});

const ALLOCATION_STATUSES = Object.freeze([
  "pending",
  "automatic_award",
  "restricted_scheduled",
  "restricted_active",
  "restricted_fallback_open",
  "restricted_resolved",
  "fallback_open_resolved",
  "no_valid_offer",
  "invalid",
  "correction_required",
]);
const ALLOCATION_DECISION_CODES = Object.freeze([
  "sole_valid_offer",
  "highest_total",
  "highest_equal_total_aav",
  "exact_total_and_term_tie",
  "no_valid_offer",
  "invalid_snapshot",
  "candidate_card_structural_conflict",
  "candidate_card_over_cap",
  "restricted_auction_result",
  "restricted_no_improvement_fallback",
  "fallback_open_result",
  "fallback_open_no_winner",
  "corrected",
]);
const RANKED_OFFER_OUTCOME_CODES = Object.freeze([
  "pending",
  "winner",
  "lost_lower_total",
  "lost_lower_aav",
  "restricted_tied",
  "invalid",
]);
const RESTRICTED_RESULT_STATUSES = Object.freeze([
  "scheduled",
  "open",
  "resolving",
  "fallback_open",
  "resolved",
  "no_winner",
  "cancelled",
  "failed",
]);
const FALLBACK_RESULT_STATUSES = Object.freeze([
  "open",
  "resolving",
  "resolved",
  "no_winner",
  "cancelled",
  "failed",
]);
const RECOVERY_STATUSES = Object.freeze([
  "pending",
  "ready",
  "running",
  "resolved",
  "correction_required",
]);
const DELTA_RESOURCE_TYPES = Object.freeze([
  "allocation",
  "auction",
  "contract",
  "ownership",
  "roster_entry",
  "activity",
  "recovery",
]);
const DELTA_ACTIONS = Object.freeze([
  "create",
  "update",
  "cancel",
  "remove",
  "assign",
  "release",
  "append",
  "resolve",
]);
const ROSTER_CATEGORIES = Object.freeze([
  "Active",
  "Bench",
  "Injured Reserve",
]);
const AFTER_SUMMARY_STATUSES = Object.freeze({
  allocation: ALLOCATION_STATUSES,
  auction: Object.freeze([
    "active",
    "resolved",
    "no_winner",
    "cancelled",
    "correction_required",
  ]),
  contract: Object.freeze([
    "Active",
    "Expired",
    "Bought Out",
  ]),
  ownership: Object.freeze([
    "rostered",
    "released",
  ]),
  roster_entry: Object.freeze([
    "assigned",
    "removed",
  ]),
  activity: Object.freeze(["appended"]),
  recovery: RECOVERY_STATUSES,
});

const PREVIEW_BODY_FIELDS = Object.freeze(["mode"]);
const APPLY_BODY_FIELDS = Object.freeze([
  "confirmation",
  "mode",
  "previewFingerprint",
  "reason",
]);
const APPLY_COMMAND_FIELDS = Object.freeze([
  "allocationId",
  "body",
  "expectedAllocationVersion",
  "fadId",
  "idempotencyKey",
  "leagueId",
]);
const PREVIEW_COMMAND_FIELDS = Object.freeze([
  "allocationId",
  "body",
  "fadId",
  "leagueId",
]);
const DECISION_FIELDS = Object.freeze([
  "decisionCode",
  "rankedOffers",
  "recoveryStatus",
  "restricted",
  "status",
  "winner",
]);
const RANKED_OFFER_FIELDS = Object.freeze([
  "aavCents",
  "outcomeCode",
  "rank",
  "slotKey",
  "snapshotEntryId",
  "team",
  "teamId",
  "termYears",
  "totalValueCents",
  "valid",
  "validationCode",
]);
const WINNER_FIELDS = Object.freeze([
  "aavCents",
  "contractId",
  "ownershipId",
  "slotKey",
  "snapshotEntryId",
  "teamId",
  "termYears",
  "totalValueCents",
]);
const RESTRICTED_FIELDS = Object.freeze([
  "auctionId",
  "minimumAavCents",
  "minimumTermYears",
  "minimumTotalValueCents",
  "participantTeamIds",
  "status",
]);
const DELTA_FIELDS = Object.freeze([
  "action",
  "afterSummary",
  "beforeVersion",
  "resourceId",
  "resourceType",
]);
const AFTER_SUMMARY_FIELDS = Object.freeze([
  "aavCents",
  "auctionId",
  "contractId",
  "ownershipId",
  "player",
  "rosterCategory",
  "status",
  "team",
  "termYears",
  "totalValueCents",
]);
const DIAGNOSTIC_FIELDS = Object.freeze([
  "code",
  "message",
  "resourceId",
]);
const PREVIEW_FIELDS = Object.freeze([
  "allocationId",
  "allocationVersion",
  "blockers",
  "confirmationText",
  "currentDecision",
  "deltas",
  "previewFingerprint",
  "recomputedDecision",
  "reversible",
  "warnings",
]);
const PREVIEW_CREATE_FIELDS = Object.freeze([
  "allocationId",
  "allocationVersion",
  "blockers",
  "currentDecision",
  "deltas",
  "fadId",
  "leagueId",
  "recomputedDecision",
  "reversible",
  "warnings",
]);
const PREVIEW_FINGERPRINT_INPUT_FIELDS = Object.freeze([
  "fadId",
  "leagueId",
  "preview",
]);
const ALLOCATION_RESULT_FIELDS = Object.freeze([
  "allocationId",
  "allocationVersion",
  "decisionCode",
  "draws",
  "fallback",
  "player",
  "rankedOffers",
  "recoveryStatus",
  "resolvedAtMs",
  "restricted",
  "status",
  "winner",
]);
const FALLBACK_FIELDS = Object.freeze([
  "auctionId",
  "contractId",
  "minimumTotalValueCents",
  "noWinnerReason",
  "ownershipId",
  "status",
  "winningBidId",
]);
const DRAW_FIELDS = Object.freeze([
  "auctionId",
  "auctionType",
  "drawCommitment",
  "drawReveal",
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
const APPLY_RESULT_FIELDS = Object.freeze([
  "activityId",
  "allocation",
  "appliedDeltas",
  "completedAtMs",
  "correctionId",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/;
const SLOT_KEY_PATTERN = /^(?:F(?:0[1-9]|1[0-2])|D0[1-6]|B0[1-4])$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INVALID_UNICODE_SCALAR_PATTERN = /[\ud800-\udfff]/u;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_COLLECTION_SIZE = 100;
const MAX_DELTA_COUNT = 500;

class FreeAgentDraftCorrectionPolicyError extends Error {
  constructor(code, reasonCode) {
    super("The Free Agent Draft allocation correction value is invalid.");
    this.name = "FreeAgentDraftCorrectionPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftCorrectionPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
    reasonCode
  );
}

function failPreview(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
    reasonCode
  );
}

function failResult(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
    reasonCode
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype || prototype === null
  );
}

function exactObject(value, fields, failWith, reasonCode) {
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    failWith(reasonCode);
  }
  const names = Object.getOwnPropertyNames(value).sort();
  if (
    names.length !== fields.length ||
    names.some((name, index) => name !== fields[index])
  ) {
    failWith(reasonCode);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      name
    );
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      failWith(reasonCode);
    }
  }
}

function exactArray(value, failWith, reasonCode, maximum) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    failWith(reasonCode);
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    !names.includes("length")
  ) {
    failWith(reasonCode);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index)
    );
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      failWith(reasonCode);
    }
  }
  return value;
}

function stableId(value, failWith, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failWith(reasonCode);
  }
  return value;
}

function nullableStableId(value, failWith, reasonCode) {
  if (value === null) return null;
  return stableId(value, failWith, reasonCode);
}

function positiveVersion(value, failWith, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    failWith(reasonCode);
  }
  return value;
}

function nullablePositiveVersion(value, failWith, reasonCode) {
  if (value === null) return null;
  return positiveVersion(value, failWith, reasonCode);
}

function safeTimestamp(value, failWith, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    failWith(reasonCode);
  }
  return value;
}

function nullableTimestamp(value, failWith, reasonCode) {
  if (value === null) return null;
  return safeTimestamp(value, failWith, reasonCode);
}

function boundedText(
  value,
  maximum,
  failWith,
  reasonCode
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value) ||
    INVALID_UNICODE_SCALAR_PATTERN.test(value)
  ) {
    failWith(reasonCode);
  }
  return value;
}

function nullableBoundedText(
  value,
  maximum,
  failWith,
  reasonCode
) {
  if (value === null) return null;
  return boundedText(value, maximum, failWith, reasonCode);
}

function sha256Hex(value, failWith, reasonCode) {
  if (
    typeof value !== "string" ||
    !SHA256_PATTERN.test(value)
  ) {
    failWith(reasonCode);
  }
  return value;
}

function integer(value, minimum, failWith, reasonCode) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    failWith(reasonCode);
  }
  return value;
}

function nullableInteger(
  value,
  minimum,
  failWith,
  reasonCode
) {
  if (value === null) return null;
  return integer(value, minimum, failWith, reasonCode);
}

function canonicalContract(
  totalValueCents,
  termYears,
  aavCents,
  failWith,
  reasonCode
) {
  if (
    !Number.isSafeInteger(termYears) ||
    termYears < 1 ||
    termYears > 3 ||
    !Number.isSafeInteger(totalValueCents) ||
    totalValueCents < termYears * 100
  ) {
    failWith(reasonCode);
  }
  const expectedAavCents =
    Math.floor(totalValueCents / termYears) +
    ((totalValueCents % termYears) * 2 >= termYears
      ? 1
      : 0);
  if (aavCents !== expectedAavCents) {
    failWith(reasonCode);
  }
  const aavFirstContract =
    aavCents % 25 === 0 &&
    totalValueCents === aavCents * termYears;
  const legacyContract =
    termYears === 1 || totalValueCents % 100 === 0;
  if (!aavFirstContract && !legacyContract) {
    failWith(reasonCode);
  }
  return Object.freeze({
    totalValueCents,
    termYears,
    aavCents,
  });
}

function validateTeam(value, failWith, reasonCode) {
  exactObject(value, TEAM_FIELDS, failWith, reasonCode);
  return Object.freeze({
    teamId: stableId(
      value.teamId,
      failWith,
      reasonCode
    ),
    name: boundedText(value.name, 500, failWith, reasonCode),
    primaryColour: boundedText(
      value.primaryColour,
      100,
      failWith,
      reasonCode
    ),
    secondaryColour: boundedText(
      value.secondaryColour,
      100,
      failWith,
      reasonCode
    ),
    tertiaryColour: nullableBoundedText(
      value.tertiaryColour,
      100,
      failWith,
      reasonCode
    ),
    patternTemplate: boundedText(
      value.patternTemplate,
      500,
      failWith,
      reasonCode
    ),
    logoReference: nullableBoundedText(
      value.logoReference,
      2_048,
      failWith,
      reasonCode
    ),
  });
}

function validatePlayer(value, failWith, reasonCode) {
  exactObject(value, PLAYER_FIELDS, failWith, reasonCode);
  if (!["F", "D"].includes(value.positionGroup)) {
    failWith(reasonCode);
  }
  return Object.freeze({
    playerId: stableId(
      value.playerId,
      failWith,
      reasonCode
    ),
    fullName: boundedText(
      value.fullName,
      500,
      failWith,
      reasonCode
    ),
    positionGroup: value.positionGroup,
  });
}

function validateFreeAgentDraftCorrectionPreviewBody(
  value
) {
  exactObject(
    value,
    PREVIEW_BODY_FIELDS,
    failInput,
    "preview_body_fields_invalid"
  );
  if (value.mode !== FREE_AGENT_DRAFT_CORRECTION_MODE) {
    failInput("correction_mode_invalid");
  }
  return Object.freeze({
    mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
  });
}

function validateFreeAgentDraftCorrectionApplyBody(value) {
  exactObject(
    value,
    APPLY_BODY_FIELDS,
    failInput,
    "apply_body_fields_invalid"
  );
  if (value.mode !== FREE_AGENT_DRAFT_CORRECTION_MODE) {
    failInput("correction_mode_invalid");
  }
  if (
    value.confirmation !==
    FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION
  ) {
    failInput("confirmation_invalid");
  }
  return Object.freeze({
    mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
    previewFingerprint: sha256Hex(
      value.previewFingerprint,
      failInput,
      "preview_fingerprint_invalid"
    ),
    reason: boundedText(
      value.reason,
      500,
      failInput,
      "reason_invalid"
    ),
    confirmation:
      FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
  });
}

function validateFreeAgentDraftCorrectionExpectedAllocationVersion(
  value
) {
  return positiveVersion(
    value,
    failInput,
    "expected_allocation_version_invalid"
  );
}

function validateFreeAgentDraftCorrectionIdempotencyKey(
  value
) {
  return boundedText(
    value,
    128,
    failInput,
    "idempotency_key_invalid"
  );
}

function validateFreeAgentDraftCorrectionPreviewCommand(
  input = {}
) {
  exactObject(
    input,
    PREVIEW_COMMAND_FIELDS,
    failInput,
    "preview_command_fields_invalid"
  );
  return Object.freeze({
    leagueId: stableId(
      input.leagueId,
      failInput,
      "league_id_invalid"
    ),
    fadId: stableId(
      input.fadId,
      failInput,
      "fad_id_invalid"
    ),
    allocationId: stableId(
      input.allocationId,
      failInput,
      "allocation_id_invalid"
    ),
    body: validateFreeAgentDraftCorrectionPreviewBody(
      input.body
    ),
  });
}

function validateFreeAgentDraftCorrectionApplyCommand(
  input = {}
) {
  exactObject(
    input,
    APPLY_COMMAND_FIELDS,
    failInput,
    "apply_command_fields_invalid"
  );
  return Object.freeze({
    leagueId: stableId(
      input.leagueId,
      failInput,
      "league_id_invalid"
    ),
    fadId: stableId(
      input.fadId,
      failInput,
      "fad_id_invalid"
    ),
    allocationId: stableId(
      input.allocationId,
      failInput,
      "allocation_id_invalid"
    ),
    expectedAllocationVersion:
      validateFreeAgentDraftCorrectionExpectedAllocationVersion(
        input.expectedAllocationVersion
      ),
    idempotencyKey:
      validateFreeAgentDraftCorrectionIdempotencyKey(
        input.idempotencyKey
      ),
    body: validateFreeAgentDraftCorrectionApplyBody(
      input.body
    ),
  });
}

function freeAgentDraftCorrectionApplyRequestProjection(
  input = {}
) {
  const command =
    validateFreeAgentDraftCorrectionApplyCommand(input);
  return Object.freeze({
    domain: FREE_AGENT_DRAFT_CORRECTION_REQUEST_DOMAIN,
    schemaVersion:
      FREE_AGENT_DRAFT_CORRECTION_SCHEMA_VERSION,
    leagueId: command.leagueId,
    fadId: command.fadId,
    allocationId: command.allocationId,
    mode: command.body.mode,
    previewFingerprint:
      command.body.previewFingerprint,
    reason: command.body.reason,
    confirmation: command.body.confirmation,
  });
}

function serializeFreeAgentDraftCorrectionApplyRequest(input) {
  return serializeCanonicalJsonV1(
    freeAgentDraftCorrectionApplyRequestProjection(input)
  );
}

function hashFreeAgentDraftCorrectionApplyRequest(input) {
  return hashCanonicalJsonV1(
    freeAgentDraftCorrectionApplyRequestProjection(input)
  );
}

function validateRankedOffer(value, failWith, reasonCode) {
  exactObject(
    value,
    RANKED_OFFER_FIELDS,
    failWith,
    reasonCode
  );
  const teamId = stableId(
    value.teamId,
    failWith,
    reasonCode
  );
  const team = validateTeam(value.team, failWith, reasonCode);
  if (
    team.teamId !== teamId ||
    !SLOT_KEY_PATTERN.test(value.slotKey || "") ||
    typeof value.valid !== "boolean" ||
    !RANKED_OFFER_OUTCOME_CODES.includes(
      value.outcomeCode
    )
  ) {
    failWith(reasonCode);
  }
  const contract = canonicalContract(
    value.totalValueCents,
    value.termYears,
    value.aavCents,
    failWith,
    reasonCode
  );
  return Object.freeze({
    snapshotEntryId: stableId(
      value.snapshotEntryId,
      failWith,
      reasonCode
    ),
    teamId,
    team,
    slotKey: value.slotKey,
    ...contract,
    valid: value.valid,
    validationCode: nullableBoundedText(
      value.validationCode,
      100,
      failWith,
      reasonCode
    ),
    rank: nullableInteger(
      value.rank,
      1,
      failWith,
      reasonCode
    ),
    outcomeCode: value.outcomeCode,
  });
}

function validateWinner(value, status, failWith, reasonCode) {
  if (value === null) return null;
  exactObject(value, WINNER_FIELDS, failWith, reasonCode);
  if (!SLOT_KEY_PATTERN.test(value.slotKey || "")) {
    failWith(reasonCode);
  }
  const snapshotEntryId = nullableStableId(
    value.snapshotEntryId,
    failWith,
    reasonCode
  );
  if (
    snapshotEntryId === null &&
    status !== "fallback_open_resolved"
  ) {
    failWith(reasonCode);
  }
  return Object.freeze({
    teamId: stableId(
      value.teamId,
      failWith,
      reasonCode
    ),
    snapshotEntryId,
    contractId: stableId(
      value.contractId,
      failWith,
      reasonCode
    ),
    ownershipId: stableId(
      value.ownershipId,
      failWith,
      reasonCode
    ),
    slotKey: value.slotKey,
    ...canonicalContract(
      value.totalValueCents,
      value.termYears,
      value.aavCents,
      failWith,
      reasonCode
    ),
  });
}

function validateRestricted(value, failWith, reasonCode) {
  if (value === null) return null;
  exactObject(
    value,
    RESTRICTED_FIELDS,
    failWith,
    reasonCode
  );
  if (!RESTRICTED_RESULT_STATUSES.includes(value.status)) {
    failWith(reasonCode);
  }
  const auctionId = nullableStableId(
    value.auctionId,
    failWith,
    reasonCode
  );
  if (
    (value.status === "scheduled") !==
    (auctionId === null)
  ) {
    failWith(reasonCode);
  }
  const participants = exactArray(
    value.participantTeamIds,
    failWith,
    reasonCode,
    MAX_COLLECTION_SIZE
  ).map((teamId) =>
    stableId(teamId, failWith, reasonCode)
  );
  if (
    new Set(participants).size !== participants.length ||
    (value.status === "scheduled"
      ? participants.length !== 0
      : participants.length < 2)
  ) {
    failWith(reasonCode);
  }
  const minimum = canonicalContract(
    value.minimumTotalValueCents,
    value.minimumTermYears,
    value.minimumAavCents,
    failWith,
    reasonCode
  );
  return Object.freeze({
    auctionId,
    status: value.status,
    participantTeamIds: Object.freeze(participants),
    minimumTotalValueCents:
      minimum.totalValueCents,
    minimumTermYears: minimum.termYears,
    minimumAavCents: minimum.aavCents,
  });
}

function normalizeDecision(value, failWith, reasonCode) {
  exactObject(value, DECISION_FIELDS, failWith, reasonCode);
  if (!ALLOCATION_STATUSES.includes(value.status)) {
    failWith(reasonCode);
  }
  if (
    value.decisionCode !== null &&
    !ALLOCATION_DECISION_CODES.includes(value.decisionCode)
  ) {
    failWith(reasonCode);
  }
  const rankedOffers = exactArray(
    value.rankedOffers,
    failWith,
    reasonCode,
    MAX_COLLECTION_SIZE
  ).map((offer) =>
    validateRankedOffer(offer, failWith, reasonCode)
  );
  if (rankedOffers.length < 1) {
    failWith(reasonCode);
  }
  const offerIds = rankedOffers.map(
    ({ snapshotEntryId }) => snapshotEntryId
  );
  const offerTeamIds = rankedOffers.map(({ teamId }) => teamId);
  if (
    new Set(offerIds).size !== offerIds.length ||
    new Set(offerTeamIds).size !== offerTeamIds.length
  ) {
    failWith(reasonCode);
  }
  const winner = validateWinner(
    value.winner,
    value.status,
    failWith,
    reasonCode
  );
  const restricted = validateRestricted(
    value.restricted,
    failWith,
    reasonCode
  );
  const recoveryStatus =
    value.recoveryStatus === null
      ? null
      : RECOVERY_STATUSES.includes(value.recoveryStatus)
        ? value.recoveryStatus
        : failWith(reasonCode);

  if (value.status === "pending") {
    if (
      value.decisionCode !== null ||
      winner !== null ||
      restricted !== null ||
      recoveryStatus !== null ||
      rankedOffers.some(
        (offer) =>
          offer.rank !== null ||
          offer.outcomeCode !== "pending"
      )
    ) {
      failWith(reasonCode);
    }
  } else {
    if (
      (
        value.decisionCode === null &&
        value.status !== "correction_required"
      ) ||
      rankedOffers.some(
        (offer) =>
          offer.outcomeCode === "pending" ||
          (offer.valid && offer.rank === null) ||
          (!offer.valid && offer.rank !== null) ||
          (offer.valid && offer.outcomeCode === "invalid") ||
          (!offer.valid && offer.outcomeCode !== "invalid")
      )
    ) {
      failWith(reasonCode);
    }
  }

  const winnerExpected = [
    "automatic_award",
    "restricted_resolved",
    "fallback_open_resolved",
  ].includes(value.status);
  if (winnerExpected !== (winner !== null)) {
    failWith(reasonCode);
  }
  const restrictedExpected = [
    "restricted_scheduled",
    "restricted_active",
    "restricted_fallback_open",
    "restricted_resolved",
    "fallback_open_resolved",
  ].includes(value.status);
  if (restrictedExpected && restricted === null) {
    failWith(reasonCode);
  }
  if (
    winner?.snapshotEntryId !== null &&
    winner !== null
  ) {
    const winningOffer = rankedOffers.find(
      (offer) =>
        offer.snapshotEntryId === winner.snapshotEntryId
    );
    if (
      !winningOffer ||
      winningOffer.teamId !== winner.teamId ||
      winningOffer.slotKey !== winner.slotKey ||
      (
        value.status === "automatic_award" &&
        (
          winningOffer.totalValueCents !==
            winner.totalValueCents ||
          winningOffer.termYears !== winner.termYears ||
          winningOffer.aavCents !== winner.aavCents
        )
      )
    ) {
      failWith(reasonCode);
    }
  }

  return Object.freeze({
    status: value.status,
    decisionCode: value.decisionCode,
    rankedOffers: Object.freeze(rankedOffers),
    winner,
    restricted,
    recoveryStatus,
  });
}

function validateFreeAgentDraftCorrectionDecision(value) {
  return normalizeDecision(
    value,
    failPreview,
    "decision_invalid"
  );
}

function normalizeDiagnostic(value, failWith, reasonCode) {
  exactObject(
    value,
    DIAGNOSTIC_FIELDS,
    failWith,
    reasonCode
  );
  if (
    typeof value.code !== "string" ||
    !DIAGNOSTIC_CODE_PATTERN.test(value.code)
  ) {
    failWith(reasonCode);
  }
  return Object.freeze({
    code: value.code,
    message: boundedText(
      value.message,
      500,
      failWith,
      reasonCode
    ),
    resourceId: nullableBoundedText(
      value.resourceId,
      500,
      failWith,
      reasonCode
    ),
  });
}

function validateFreeAgentDraftCorrectionDiagnostic(value) {
  return normalizeDiagnostic(
    value,
    failPreview,
    "diagnostic_invalid"
  );
}

function normalizeDiagnostics(
  value,
  failWith,
  reasonCode
) {
  const diagnostics = exactArray(
    value,
    failWith,
    reasonCode,
    MAX_COLLECTION_SIZE
  ).map((diagnostic) =>
    normalizeDiagnostic(diagnostic, failWith, reasonCode)
  );
  const identities = diagnostics.map((diagnostic) =>
    serializeCanonicalJsonV1(diagnostic)
  );
  if (new Set(identities).size !== identities.length) {
    failWith(reasonCode);
  }
  return Object.freeze(diagnostics);
}

function normalizeAfterSummary(
  value,
  resourceType,
  failWith,
  reasonCode
) {
  exactObject(
    value,
    AFTER_SUMMARY_FIELDS,
    failWith,
    reasonCode
  );
  if (!DELTA_RESOURCE_TYPES.includes(resourceType)) {
    failWith(reasonCode);
  }
  const status =
    value.status === null
      ? null
      : AFTER_SUMMARY_STATUSES[resourceType].includes(
            value.status
          )
        ? value.status
        : failWith(reasonCode);
  const moneyFields = [
    value.totalValueCents,
    value.termYears,
    value.aavCents,
  ];
  const hasMoney = moneyFields.some((item) => item !== null);
  if (
    hasMoney && moneyFields.some((item) => item === null)
  ) {
    failWith(reasonCode);
  }
  const contract = hasMoney
    ? canonicalContract(
        value.totalValueCents,
        value.termYears,
        value.aavCents,
        failWith,
        reasonCode
      )
    : Object.freeze({
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      });
  if (
    value.rosterCategory !== null &&
    !ROSTER_CATEGORIES.includes(value.rosterCategory)
  ) {
    failWith(reasonCode);
  }
  return Object.freeze({
    status,
    team:
      value.team === null
        ? null
        : validateTeam(value.team, failWith, reasonCode),
    player:
      value.player === null
        ? null
        : validatePlayer(value.player, failWith, reasonCode),
    contractId: nullableStableId(
      value.contractId,
      failWith,
      reasonCode
    ),
    ownershipId: nullableStableId(
      value.ownershipId,
      failWith,
      reasonCode
    ),
    auctionId: nullableStableId(
      value.auctionId,
      failWith,
      reasonCode
    ),
    ...contract,
    rosterCategory: value.rosterCategory,
  });
}

function validateFreeAgentDraftCorrectionAfterSummary(
  value,
  resourceType
) {
  return normalizeAfterSummary(
    value,
    resourceType,
    failPreview,
    "after_summary_invalid"
  );
}

function normalizeDelta(
  value,
  failWith,
  reasonCode,
  { applied = false } = {}
) {
  exactObject(value, DELTA_FIELDS, failWith, reasonCode);
  if (
    !DELTA_RESOURCE_TYPES.includes(value.resourceType) ||
    !DELTA_ACTIONS.includes(value.action)
  ) {
    failWith(reasonCode);
  }
  const resourceId = nullableStableId(
    value.resourceId,
    failWith,
    reasonCode
  );
  const createsResource = ["create", "append"].includes(
    value.action
  );
  if (
    (resourceId === null && !createsResource) ||
    (applied && resourceId === null)
  ) {
    failWith(reasonCode);
  }
  const beforeVersion = nullablePositiveVersion(
    value.beforeVersion,
    failWith,
    reasonCode
  );
  if (createsResource !== (beforeVersion === null)) {
    failWith(reasonCode);
  }
  return Object.freeze({
    resourceType: value.resourceType,
    resourceId,
    action: value.action,
    beforeVersion,
    afterSummary: normalizeAfterSummary(
      value.afterSummary,
      value.resourceType,
      failWith,
      reasonCode
    ),
  });
}

function validateFreeAgentDraftCorrectionDelta(
  value,
  { applied = false } = {}
) {
  return normalizeDelta(
    value,
    failPreview,
    "delta_invalid",
    { applied }
  );
}

function normalizePreview(
  value,
  failWith,
  reasonCode
) {
  exactObject(value, PREVIEW_FIELDS, failWith, reasonCode);
  if (typeof value.reversible !== "boolean") {
    failWith(reasonCode);
  }
  if (
    value.confirmationText !==
    FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION
  ) {
    failWith(reasonCode);
  }
  const deltas = exactArray(
    value.deltas,
    failWith,
    reasonCode,
    MAX_DELTA_COUNT
  ).map((delta) =>
    normalizeDelta(delta, failWith, reasonCode)
  );
  const warnings = normalizeDiagnostics(
    value.warnings,
    failWith,
    reasonCode
  );
  const blockers = normalizeDiagnostics(
    value.blockers,
    failWith,
    reasonCode
  );
  if (value.reversible !== (blockers.length === 0)) {
    failWith(reasonCode);
  }
  return Object.freeze({
    allocationId: stableId(
      value.allocationId,
      failWith,
      reasonCode
    ),
    allocationVersion: positiveVersion(
      value.allocationVersion,
      failWith,
      reasonCode
    ),
    previewFingerprint: sha256Hex(
      value.previewFingerprint,
      failWith,
      reasonCode
    ),
    reversible: value.reversible,
    currentDecision: normalizeDecision(
      value.currentDecision,
      failWith,
      reasonCode
    ),
    recomputedDecision: normalizeDecision(
      value.recomputedDecision,
      failWith,
      reasonCode
    ),
    deltas: Object.freeze(deltas),
    warnings,
    blockers,
    confirmationText:
      FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
  });
}

function fingerprintProjection(leagueId, fadId, preview) {
  return Object.freeze({
    domain: FREE_AGENT_DRAFT_CORRECTION_PREVIEW_DOMAIN,
    schemaVersion:
      FREE_AGENT_DRAFT_CORRECTION_SCHEMA_VERSION,
    leagueId,
    fadId,
    allocationId: preview.allocationId,
    allocationVersion: preview.allocationVersion,
    currentDecision: preview.currentDecision,
    recomputedDecision: preview.recomputedDecision,
    deltas: preview.deltas,
    warnings: preview.warnings,
    blockers: preview.blockers,
    confirmationText: preview.confirmationText,
  });
}

function freeAgentDraftCorrectionPreviewFingerprintProjection(
  input = {}
) {
  exactObject(
    input,
    PREVIEW_FINGERPRINT_INPUT_FIELDS,
    failPreview,
    "fingerprint_input_fields_invalid"
  );
  const leagueId = stableId(
    input.leagueId,
    failPreview,
    "league_id_invalid"
  );
  const fadId = stableId(
    input.fadId,
    failPreview,
    "fad_id_invalid"
  );
  const preview = normalizePreview(
    input.preview,
    failPreview,
    "preview_invalid"
  );
  return fingerprintProjection(leagueId, fadId, preview);
}

function serializeFreeAgentDraftCorrectionPreviewFingerprint(
  input
) {
  return serializeCanonicalJsonV1(
    freeAgentDraftCorrectionPreviewFingerprintProjection(
      input
    )
  );
}

function hashFreeAgentDraftCorrectionPreview(input) {
  return hashCanonicalJsonV1(
    freeAgentDraftCorrectionPreviewFingerprintProjection(
      input
    )
  );
}

function createFreeAgentDraftCorrectionPreview(input = {}) {
  exactObject(
    input,
    PREVIEW_CREATE_FIELDS,
    failPreview,
    "preview_create_fields_invalid"
  );
  const leagueId = stableId(
    input.leagueId,
    failPreview,
    "league_id_invalid"
  );
  const fadId = stableId(
    input.fadId,
    failPreview,
    "fad_id_invalid"
  );
  const provisional = normalizePreview(
    {
      allocationId: input.allocationId,
      allocationVersion: input.allocationVersion,
      previewFingerprint: "0".repeat(64),
      reversible: input.reversible,
      currentDecision: input.currentDecision,
      recomputedDecision: input.recomputedDecision,
      deltas: input.deltas,
      warnings: input.warnings,
      blockers: input.blockers,
      confirmationText:
        FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
    },
    failPreview,
    "preview_invalid"
  );
  const previewFingerprint = hashCanonicalJsonV1(
    fingerprintProjection(leagueId, fadId, provisional)
  );
  return Object.freeze({
    ...provisional,
    previewFingerprint,
  });
}

function validateFreeAgentDraftCorrectionPreview(input = {}) {
  exactObject(
    input,
    PREVIEW_FINGERPRINT_INPUT_FIELDS,
    failPreview,
    "preview_validation_fields_invalid"
  );
  const preview = normalizePreview(
    input.preview,
    failPreview,
    "preview_invalid"
  );
  const leagueId = stableId(
    input.leagueId,
    failPreview,
    "league_id_invalid"
  );
  const fadId = stableId(
    input.fadId,
    failPreview,
    "fad_id_invalid"
  );
  const expectedFingerprint = hashCanonicalJsonV1(
    fingerprintProjection(leagueId, fadId, preview)
  );
  if (preview.previewFingerprint !== expectedFingerprint) {
    failPreview("preview_fingerprint_invalid");
  }
  return preview;
}

function compareFreeAgentDraftCorrectionPreviewFingerprints(
  left,
  right
) {
  const canonicalLeft = sha256Hex(
    left,
    failInput,
    "preview_fingerprint_invalid"
  );
  const canonicalRight = sha256Hex(
    right,
    failInput,
    "preview_fingerprint_invalid"
  );
  return canonicalLeft === canonicalRight;
}

function hasFreeAgentDraftCorrectionPreviewFingerprintDrift(
  input = {}
) {
  exactObject(
    input,
    ["currentFingerprint", "previewFingerprint"],
    failInput,
    "fingerprint_comparison_fields_invalid"
  );
  return !compareFreeAgentDraftCorrectionPreviewFingerprints(
    input.previewFingerprint,
    input.currentFingerprint
  );
}

function assertFreeAgentDraftCorrectionPreviewFingerprintCurrent(
  input = {}
) {
  if (
    hasFreeAgentDraftCorrectionPreviewFingerprintDrift(input)
  ) {
    fail(
      FREE_AGENT_DRAFT_CORRECTION_CODES.fingerprintDrift,
      "preview_fingerprint_drift"
    );
  }
  return input.currentFingerprint;
}

function compareFreeAgentDraftCorrectionDecisions(left, right) {
  const canonicalLeft = normalizeDecision(
    left,
    failPreview,
    "decision_invalid"
  );
  const canonicalRight = normalizeDecision(
    right,
    failPreview,
    "decision_invalid"
  );
  return (
    serializeCanonicalJsonV1(canonicalLeft) ===
    serializeCanonicalJsonV1(canonicalRight)
  );
}

function validateFallback(value, failWith, reasonCode) {
  if (value === null) return null;
  exactObject(value, FALLBACK_FIELDS, failWith, reasonCode);
  if (!FALLBACK_RESULT_STATUSES.includes(value.status)) {
    failWith(reasonCode);
  }
  const winningBidId = nullableStableId(
    value.winningBidId,
    failWith,
    reasonCode
  );
  const contractId = nullableStableId(
    value.contractId,
    failWith,
    reasonCode
  );
  const ownershipId = nullableStableId(
    value.ownershipId,
    failWith,
    reasonCode
  );
  const winnerLinks = [
    winningBidId,
    contractId,
    ownershipId,
  ];
  if (
    winnerLinks.some((item) => item === null) !==
      winnerLinks.every((item) => item === null) ||
    (value.status === "resolved") !==
      winnerLinks.every((item) => item !== null)
  ) {
    failWith(reasonCode);
  }
  return Object.freeze({
    auctionId: stableId(
      value.auctionId,
      failWith,
      reasonCode
    ),
    status: value.status,
    minimumTotalValueCents: integer(
      value.minimumTotalValueCents,
      1,
      failWith,
      reasonCode
    ),
    winningBidId,
    contractId,
    ownershipId,
    noWinnerReason: nullableBoundedText(
      value.noWinnerReason,
      100,
      failWith,
      reasonCode
    ),
  });
}

function validateDrawReveal(value, failWith, reasonCode) {
  if (value === null) return null;
  exactObject(
    value,
    DRAW_REVEAL_FIELDS,
    failWith,
    reasonCode
  );
  if (
    value.algorithmVersion !== 1 ||
    typeof value.selectionUsed !== "boolean"
  ) {
    failWith(reasonCode);
  }
  const orderedBidIds = exactArray(
    value.orderedBidIds,
    failWith,
    reasonCode,
    MAX_COLLECTION_SIZE
  ).map((bidId) =>
    stableId(bidId, failWith, reasonCode)
  );
  if (
    new Set(orderedBidIds).size !== orderedBidIds.length
  ) {
    failWith(reasonCode);
  }
  const counter = nullableInteger(
    value.counter,
    0,
    failWith,
    reasonCode
  );
  const digestHex =
    value.digestHex === null
      ? null
      : sha256Hex(value.digestHex, failWith, reasonCode);
  const selectedIndex = nullableInteger(
    value.selectedIndex,
    0,
    failWith,
    reasonCode
  );
  const selectedBidId = nullableStableId(
    value.selectedBidId,
    failWith,
    reasonCode
  );
  const selectedTeamId = nullableStableId(
    value.selectedTeamId,
    failWith,
    reasonCode
  );
  if (value.selectionUsed) {
    if (
      orderedBidIds.length < 2 ||
      counter === null ||
      digestHex === null ||
      selectedIndex === null ||
      selectedIndex >= orderedBidIds.length ||
      selectedBidId !== orderedBidIds[selectedIndex] ||
      selectedTeamId === null
    ) {
      failWith(reasonCode);
    }
  } else if (
    orderedBidIds.length !== 0 ||
    [
      counter,
      digestHex,
      selectedIndex,
      selectedBidId,
      selectedTeamId,
    ].some((item) => item !== null)
  ) {
    failWith(reasonCode);
  }
  return Object.freeze({
    algorithmVersion: 1,
    nonceHex: sha256Hex(
      value.nonceHex,
      failWith,
      reasonCode
    ),
    selectionUsed: value.selectionUsed,
    orderedBidIds: Object.freeze(orderedBidIds),
    counter,
    digestHex,
    selectedIndex,
    selectedBidId,
    selectedTeamId,
  });
}

function validateDraw(value, failWith, reasonCode) {
  exactObject(value, DRAW_FIELDS, failWith, reasonCode);
  if (
    !["fad_restricted", "fad_open_rapid"].includes(
      value.auctionType
    )
  ) {
    failWith(reasonCode);
  }
  return Object.freeze({
    auctionId: stableId(
      value.auctionId,
      failWith,
      reasonCode
    ),
    auctionType: value.auctionType,
    drawCommitment: sha256Hex(
      value.drawCommitment,
      failWith,
      reasonCode
    ),
    drawReveal: validateDrawReveal(
      value.drawReveal,
      failWith,
      reasonCode
    ),
  });
}

function validateFreeAgentDraftAllocationResultProjection(
  value
) {
  exactObject(
    value,
    ALLOCATION_RESULT_FIELDS,
    failResult,
    "allocation_result_invalid"
  );
  const decision = normalizeDecision(
    {
      status: value.status,
      decisionCode: value.decisionCode,
      rankedOffers: value.rankedOffers,
      winner: value.winner,
      restricted: value.restricted,
      recoveryStatus: value.recoveryStatus,
    },
    failResult,
    "allocation_result_invalid"
  );
  const fallback = validateFallback(
    value.fallback,
    failResult,
    "allocation_result_invalid"
  );
  const draws = exactArray(
    value.draws,
    failResult,
    "allocation_result_invalid",
    MAX_COLLECTION_SIZE
  ).map((draw) =>
    validateDraw(
      draw,
      failResult,
      "allocation_result_invalid"
    )
  );
  const drawAuctionIds = draws.map(({ auctionId }) => auctionId);
  if (
    new Set(drawAuctionIds).size !== drawAuctionIds.length ||
    draws.some(
      (draw) =>
        draw.drawReveal === null &&
        decision.status !== "correction_required"
    )
  ) {
    failResult("allocation_result_invalid");
  }
  const resolvedAtMs = nullableTimestamp(
    value.resolvedAtMs,
    failResult,
    "allocation_result_invalid"
  );
  if (
    decision.status === "pending" &&
    (fallback !== null ||
      draws.length !== 0 ||
      resolvedAtMs !== null)
  ) {
    failResult("allocation_result_invalid");
  }
  if (
    [
      "automatic_award",
      "restricted_resolved",
      "fallback_open_resolved",
      "no_valid_offer",
      "invalid",
    ].includes(decision.status) &&
    resolvedAtMs === null
  ) {
    failResult("allocation_result_invalid");
  }
  const fallbackRequired = [
    "restricted_fallback_open",
    "fallback_open_resolved",
  ].includes(decision.status);
  const fallbackAllowed =
    fallbackRequired ||
    decision.status === "correction_required";
  if (
    (fallbackRequired && fallback === null) ||
    (!fallbackAllowed && fallback !== null)
  ) {
    failResult("allocation_result_invalid");
  }
  return Object.freeze({
    allocationId: stableId(
      value.allocationId,
      failResult,
      "allocation_result_invalid"
    ),
    allocationVersion: positiveVersion(
      value.allocationVersion,
      failResult,
      "allocation_result_invalid"
    ),
    player: validatePlayer(
      value.player,
      failResult,
      "allocation_result_invalid"
    ),
    ...decision,
    fallback,
    draws: Object.freeze(draws),
    resolvedAtMs,
  });
}

function validateFreeAgentDraftCorrectionApplyResult(value) {
  exactObject(
    value,
    APPLY_RESULT_FIELDS,
    failResult,
    "apply_result_fields_invalid"
  );
  const appliedDeltas = exactArray(
    value.appliedDeltas,
    failResult,
    "applied_deltas_invalid",
    MAX_DELTA_COUNT
  ).map((delta) =>
    normalizeDelta(
      delta,
      failResult,
      "applied_deltas_invalid",
      { applied: true }
    )
  );
  if (appliedDeltas.length < 1) {
    failResult("applied_deltas_invalid");
  }
  const activityId = stableId(
    value.activityId,
    failResult,
    "activity_id_invalid"
  );
  if (
    !appliedDeltas.some(
      (delta) =>
        delta.resourceType === "activity" &&
        delta.resourceId === activityId &&
        delta.action === "append"
    )
  ) {
    failResult("activity_delta_missing");
  }
  return Object.freeze({
    correctionId: stableId(
      value.correctionId,
      failResult,
      "correction_id_invalid"
    ),
    allocation:
      validateFreeAgentDraftAllocationResultProjection(
        value.allocation
      ),
    appliedDeltas: Object.freeze(appliedDeltas),
    activityId,
    completedAtMs: safeTimestamp(
      value.completedAtMs,
      failResult,
      "completed_at_ms_invalid"
    ),
  });
}

module.exports = {
  AFTER_SUMMARY_STATUSES,
  ALLOCATION_DECISION_CODES,
  ALLOCATION_STATUSES,
  APPLY_BODY_FIELDS,
  DELTA_ACTIONS,
  DELTA_RESOURCE_TYPES,
  FREE_AGENT_DRAFT_CORRECTION_CODES,
  FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
  FREE_AGENT_DRAFT_CORRECTION_MODE,
  FREE_AGENT_DRAFT_CORRECTION_PREVIEW_DOMAIN,
  FREE_AGENT_DRAFT_CORRECTION_REQUEST_DOMAIN,
  FREE_AGENT_DRAFT_CORRECTION_SCHEMA_VERSION,
  PREVIEW_BODY_FIELDS,
  RECOVERY_STATUSES,
  ROSTER_CATEGORIES,
  FreeAgentDraftCorrectionPolicyError,
  assertFreeAgentDraftCorrectionPreviewFingerprintCurrent,
  compareFreeAgentDraftCorrectionDecisions,
  compareFreeAgentDraftCorrectionPreviewFingerprints,
  createFreeAgentDraftCorrectionPreview,
  freeAgentDraftCorrectionApplyRequestProjection,
  freeAgentDraftCorrectionPreviewFingerprintProjection,
  hasFreeAgentDraftCorrectionPreviewFingerprintDrift,
  hashFreeAgentDraftCorrectionApplyRequest,
  hashFreeAgentDraftCorrectionPreview,
  serializeFreeAgentDraftCorrectionApplyRequest,
  serializeFreeAgentDraftCorrectionPreviewFingerprint,
  validateFreeAgentDraftAllocationResultProjection,
  validateFreeAgentDraftCorrectionAfterSummary,
  validateFreeAgentDraftCorrectionApplyBody,
  validateFreeAgentDraftCorrectionApplyCommand,
  validateFreeAgentDraftCorrectionApplyResult,
  validateFreeAgentDraftCorrectionDecision,
  validateFreeAgentDraftCorrectionDelta,
  validateFreeAgentDraftCorrectionDiagnostic,
  validateFreeAgentDraftCorrectionExpectedAllocationVersion,
  validateFreeAgentDraftCorrectionIdempotencyKey,
  validateFreeAgentDraftCorrectionPreview,
  validateFreeAgentDraftCorrectionPreviewBody,
  validateFreeAgentDraftCorrectionPreviewCommand,
};
