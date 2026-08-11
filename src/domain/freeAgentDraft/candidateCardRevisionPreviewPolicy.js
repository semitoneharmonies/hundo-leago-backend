"use strict";

const {
  sha256Bytes,
} = require("../shared/sha256");

const {
  CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS,
  CANDIDATE_CARD_POLICY_CODES,
  CandidateCardPolicyError,
  createCandidateCardOfferContract,
  parseCandidateCardSlotKey,
} = require("./candidateCardPolicy");

const UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PREVIEW_ENTRY_ID_DOMAIN =
  "candidate_card_revision_preview_entry_v1";

function failInput(reasonCode) {
  throw new CandidateCardPolicyError(
    CANDIDATE_CARD_POLICY_CODES.inputInvalid,
    reasonCode
  );
}

function exactObject(value, fields, reasonCode) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    failInput(reasonCode);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    failInput(reasonCode);
  }
}

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_V4_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function normalizeOffer(action, fields) {
  exactObject(action, fields, "action_fields_invalid");
  const contract = createCandidateCardOfferContract({
    totalValueCents: action.totalValueCents,
    termYears: action.termYears,
  });
  return contract;
}

function assertBenchAav(slot, contract) {
  if (
    slot.slotGroup === "B" &&
    contract.aavCents >
      CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
  ) {
    throw new CandidateCardPolicyError(
      CANDIDATE_CARD_POLICY_CODES
        .benchAavExceeded,
      "bench_aav_exceeded"
    );
  }
}

function normalizeCandidateCardRevisionPreviewAction(
  action
) {
  if (
    action === null ||
    typeof action !== "object" ||
    Array.isArray(action)
  ) {
    failInput("action_invalid");
  }
  if (action.type === "add") {
    const contract = normalizeOffer(action, [
      "type",
      "slotKey",
      "playerId",
      "totalValueCents",
      "termYears",
    ]);
    const slot = parseCandidateCardSlotKey(
      action.slotKey
    );
    assertBenchAav(slot, contract);
    return Object.freeze({
      type: "add",
      slotKey: slot.slotKey,
      playerId: stableId(
        action.playerId,
        "player_id_invalid"
      ),
      totalValueCents:
        contract.totalValueCents,
      termYears: contract.termYears,
    });
  }
  if (action.type === "edit") {
    const contract = normalizeOffer(action, [
      "type",
      "entryId",
      "totalValueCents",
      "termYears",
    ]);
    return Object.freeze({
      type: "edit",
      entryId: stableId(
        action.entryId,
        "entry_id_invalid"
      ),
      totalValueCents:
        contract.totalValueCents,
      termYears: contract.termYears,
    });
  }
  if (action.type === "move") {
    exactObject(
      action,
      ["type", "entryId", "slotKey"],
      "action_fields_invalid"
    );
    return Object.freeze({
      type: "move",
      entryId: stableId(
        action.entryId,
        "entry_id_invalid"
      ),
      slotKey: parseCandidateCardSlotKey(
        action.slotKey
      ).slotKey,
    });
  }
  if (action.type === "remove") {
    exactObject(
      action,
      ["type", "entryId"],
      "action_fields_invalid"
    );
    return Object.freeze({
      type: "remove",
      entryId: stableId(
        action.entryId,
        "entry_id_invalid"
      ),
    });
  }
  failInput("action_invalid");
}

function digestToUuidV4(digest) {
  const bytes = Buffer.from(
    digest.subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function createCandidateCardAddPreviewEntryId({
  cardId,
  baseCardVersion,
  action,
  existingEntryIds,
} = {}) {
  const canonicalCardId = stableId(
    cardId,
    "card_id_invalid"
  );
  if (
    !Number.isSafeInteger(baseCardVersion) ||
    baseCardVersion < 1
  ) {
    failInput("base_card_version_invalid");
  }
  const canonicalAction =
    normalizeCandidateCardRevisionPreviewAction(
      action
    );
  if (canonicalAction.type !== "add") {
    failInput("add_action_required");
  }
  if (!Array.isArray(existingEntryIds)) {
    failInput("existing_entry_ids_invalid");
  }
  const existing = new Set();
  for (const entryId of existingEntryIds) {
    const canonicalEntryId = stableId(
      entryId,
      "existing_entry_ids_invalid"
    );
    if (existing.has(canonicalEntryId)) {
      failInput("existing_entry_ids_invalid");
    }
    existing.add(canonicalEntryId);
  }

  for (let nonce = 0; nonce < 1_000_000; nonce += 1) {
    const digest = sha256Bytes(
      new TextEncoder().encode(
        JSON.stringify([
          PREVIEW_ENTRY_ID_DOMAIN,
          canonicalCardId,
          baseCardVersion,
          canonicalAction.type,
          canonicalAction.slotKey,
          canonicalAction.playerId,
          canonicalAction.totalValueCents,
          canonicalAction.termYears,
          nonce,
        ])
      )
    );
    const candidate = digestToUuidV4(digest);
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  failInput("preview_entry_id_unavailable");
}

module.exports = {
  PREVIEW_ENTRY_ID_DOMAIN,
  UUID_V4_PATTERN,
  createCandidateCardAddPreviewEntryId,
  normalizeCandidateCardRevisionPreviewAction,
};
