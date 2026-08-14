"use strict";

const {
  CANONICAL_UUID_PATTERN,
  CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS,
  CANDIDATE_CARD_POLICY_CODES,
  CANDIDATE_CARD_SLOT_KEYS,
  CandidateCardPolicyError,
  createCandidateCardOfferContract,
  createCandidateCardPartialOfferContract,
  parseCandidateCardSlotKey,
} = require("./candidateCardPolicy");

const CANDIDATE_CARD_IDEMPOTENCY_KEY_MAXIMUM_CODE_POINTS =
  128;
const MAXIMUM_CANDIDATE_CARD_EXPECTED_VERSION =
  Number.MAX_SAFE_INTEGER - 1;
const CANDIDATE_CARD_MUTATION_ACTION_TYPES =
  Object.freeze([
    "add",
    "edit",
    "move",
    "remove",
  ]);
const IDEMPOTENCY_KEY_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

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
    ![
      Object.prototype,
      null,
    ].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    failInput(reasonCode);
  }
  const actual =
    Object.getOwnPropertyNames(value).sort();
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
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function normalizeOffer(action, fields) {
  exactObject(
    action,
    fields,
    "action_fields_invalid"
  );
  return createCandidateCardOfferContract({
    totalValueCents: action.totalValueCents,
    termYears: action.termYears,
  });
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

function normalizeCandidateCardMutationAction(
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

function normalizeCandidateCardWholeSave(
  input
) {
  exactObject(
    input,
    ["slots"],
    "whole_card_fields_invalid"
  );
  if (
    !Array.isArray(input.slots) ||
    input.slots.length !==
      CANDIDATE_CARD_SLOT_KEYS.length
  ) {
    failInput("whole_card_slots_invalid");
  }
  const playerIds = new Set();
  const slots = input.slots.map(
    (item, index) => {
      exactObject(
        item,
        ["slotKey", "candidate"],
        "whole_card_slot_fields_invalid"
      );
      const slot = parseCandidateCardSlotKey(
        item.slotKey
      );
      if (
        slot.slotKey !==
        CANDIDATE_CARD_SLOT_KEYS[index]
      ) {
        failInput(
          "whole_card_slot_order_invalid"
        );
      }
      if (item.candidate === null) {
        return Object.freeze({
          slotKey: slot.slotKey,
          candidate: null,
        });
      }
      exactObject(
        item.candidate,
        [
          "playerId",
          "totalValueCents",
          "termYears",
        ],
        "whole_card_candidate_fields_invalid"
      );
      const playerId = stableId(
        item.candidate.playerId,
        "player_id_invalid"
      );
      if (playerIds.has(playerId)) {
        throw new CandidateCardPolicyError(
          CANDIDATE_CARD_POLICY_CODES
            .playerDuplicate,
          "candidate_player_duplicate"
        );
      }
      playerIds.add(playerId);
      const contract =
        createCandidateCardPartialOfferContract({
          totalValueCents:
            item.candidate.totalValueCents,
          termYears:
            item.candidate.termYears,
        });
      assertBenchAav(slot, contract);
      return Object.freeze({
        slotKey: slot.slotKey,
        candidate: Object.freeze({
          playerId,
          totalValueCents:
            contract.totalValueCents,
          termYears: contract.termYears,
        }),
      });
    }
  );
  return Object.freeze({
    slots: Object.freeze(slots),
  });
}

function normalizeCandidateCardExpectedVersion(
  value
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >
      MAXIMUM_CANDIDATE_CARD_EXPECTED_VERSION
  ) {
    failInput("expected_card_version_invalid");
  }
  return value;
}

function normalizeCandidateCardIdempotencyKey(
  value
) {
  if (
    typeof value !== "string" ||
    IDEMPOTENCY_KEY_CONTROL_PATTERN.test(value)
  ) {
    failInput("idempotency_key_invalid");
  }
  const normalized = value.trim();
  const codePointCount = [...normalized].length;
  if (
    codePointCount < 1 ||
    codePointCount >
      CANDIDATE_CARD_IDEMPOTENCY_KEY_MAXIMUM_CODE_POINTS
  ) {
    failInput("idempotency_key_invalid");
  }
  return normalized;
}

module.exports = {
  CANDIDATE_CARD_IDEMPOTENCY_KEY_MAXIMUM_CODE_POINTS,
  CANDIDATE_CARD_MUTATION_ACTION_TYPES,
  MAXIMUM_CANDIDATE_CARD_EXPECTED_VERSION,
  normalizeCandidateCardExpectedVersion,
  normalizeCandidateCardIdempotencyKey,
  normalizeCandidateCardMutationAction,
  normalizeCandidateCardWholeSave,
};
