"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CANDIDATE_CARD_SLOT_KEYS,
  evaluateCandidateCard,
  validateCandidateCardCandidate,
} = require(
  "../../src/domain/freeAgentDraft/candidateCardPolicy"
);
const {
  normalizeCandidateCardWholeSave,
} = require(
  "../../src/domain/freeAgentDraft/candidateCardMutationPolicy"
);

const PLAYER_ID =
  "10000000-0000-4000-8000-000000000001";
const ENTRY_ID =
  "20000000-0000-4000-8000-000000000001";

function body(candidate = null) {
  return {
    slots: CANDIDATE_CARD_SLOT_KEYS.map(
      (slotKey, index) => ({
        slotKey,
        candidate: index === 0
          ? candidate
          : null,
      })
    ),
  };
}

test("whole-card input requires exactly 22 canonical ordered slots and accepts partial contracts", () => {
  const normalized =
    normalizeCandidateCardWholeSave(
      body({
        playerId: PLAYER_ID,
        totalValueCents: 1500,
        termYears: null,
      })
    );

  assert.equal(normalized.slots.length, 22);
  assert.deepEqual(
    normalized.slots[0],
    {
      slotKey: "F01",
      candidate: {
        playerId: PLAYER_ID,
        totalValueCents: 1500,
        termYears: null,
      },
    }
  );

  const outOfOrder = body();
  [outOfOrder.slots[0], outOfOrder.slots[1]] =
    [outOfOrder.slots[1], outOfOrder.slots[0]];
  assert.throws(
    () => normalizeCandidateCardWholeSave(outOfOrder),
    (error) =>
      error.code ===
        "CANDIDATE_CARD_INPUT_INVALID" &&
      error.reasonCode ===
        "whole_card_slot_order_invalid"
  );
});

test("partial candidate contracts are canonical invalid rows and never participate", () => {
  const candidateInput = {
    entryId: ENTRY_ID,
    entryKind: "candidate",
    playerId: PLAYER_ID,
    effectivePositionGroup: "F",
    slotKey: "F01",
    placementState: "placed",
    conflictCode: null,
    totalValueCents: null,
    termYears: 3,
    eligibilityStatus: "invalid",
    validationCode:
      "CANDIDATE_CONTRACT_INCOMPLETE",
  };
  const candidate =
    validateCandidateCardCandidate(
      candidateInput
    );
  assert.equal(candidate.aavCents, null);

  const evaluation = evaluateCandidateCard({
    capLimitCents: 10_000,
    carriedActivePlayerAmountCents: 0,
    retentionObligationCents: 0,
    buyoutPenaltyCents: 0,
    entries: [candidateInput],
  });
  assert.equal(
    evaluation.capProjection
      .proposedCandidateAavCents,
    0
  );
  assert.deepEqual(
    evaluation.candidateOfferDispositions[0],
    {
      entryId: ENTRY_ID,
      playerId: PLAYER_ID,
      participates: false,
      disposition: "excluded_invalid",
      reasonCode:
        "CANDIDATE_CONTRACT_INCOMPLETE",
    }
  );
});
