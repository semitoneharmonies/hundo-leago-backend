"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  UUID_V4_PATTERN,
  createCandidateCardAddPreviewEntryId,
  normalizeCandidateCardRevisionPreviewAction,
} = require(
  "../../src/domain/freeAgentDraft/candidateCardRevisionPreviewPolicy"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

function assertPolicyError(callback, code, reasonCode) {
  assert.throws(callback, (error) => (
    error?.name === "CandidateCardPolicyError" &&
    error?.code === code &&
    error?.reasonCode === reasonCode
  ));
}

describe("Candidate Card revision-preview policy", () => {
  test("normalizes the four exact public action variants", () => {
    assert.deepEqual(
      normalizeCandidateCardRevisionPreviewAction({
        type: "add",
        slotKey: "F01",
        playerId: uuid(1),
        aavCents: 300,
        termYears: 3,
      }),
      {
        type: "add",
        slotKey: "F01",
        playerId: uuid(1),
        totalValueCents: 900,
        aavCents: 300,
        termYears: 3,
      }
    );
    assert.deepEqual(
      normalizeCandidateCardRevisionPreviewAction({
        type: "edit",
        entryId: uuid(2),
        aavCents: 200,
        termYears: 2,
      }),
      {
        type: "edit",
        entryId: uuid(2),
        totalValueCents: 400,
        aavCents: 200,
        termYears: 2,
      }
    );
    assert.deepEqual(
      normalizeCandidateCardRevisionPreviewAction({
        type: "move",
        entryId: uuid(2),
        slotKey: "B04",
      }),
      {
        type: "move",
        entryId: uuid(2),
        slotKey: "B04",
      }
    );
    assert.deepEqual(
      normalizeCandidateCardRevisionPreviewAction({
        type: "remove",
        entryId: uuid(2),
      }),
      {
        type: "remove",
        entryId: uuid(2),
      }
    );
  });

  test("rejects malformed, symbolic, unknown, and mixed action shapes", () => {
    const cases = [
      [null, "action_invalid"],
      [{}, "action_invalid"],
      [{ type: "unknown" }, "action_invalid"],
      [
        {
          type: "remove",
          entryId: uuid(2),
          slotKey: "F01",
        },
        "action_fields_invalid",
      ],
      [
        Object.assign(
          { type: "remove", entryId: uuid(2) },
          { [Symbol("hidden")]: true }
        ),
        "action_fields_invalid",
      ],
      [
        {
          type: "add",
          entryId: uuid(3),
          slotKey: "F01",
          playerId: uuid(1),
          aavCents: 300,
          termYears: 3,
        },
        "action_fields_invalid",
      ],
    ];
    for (const [action, reasonCode] of cases) {
      assertPolicyError(
        () =>
          normalizeCandidateCardRevisionPreviewAction(
            action
          ),
        "CANDIDATE_CARD_INPUT_INVALID",
        reasonCode
      );
    }
  });

  test("preserves canonical slot, identifier, contract, and Bench failures", () => {
    const cases = [
      [
        {
          type: "move",
          entryId: uuid(2),
          slotKey: "F1",
        },
        "CANDIDATE_SLOT_INVALID",
        "slot_key_invalid",
      ],
      [
        {
          type: "edit",
          entryId: "not-a-uuid",
          aavCents: 300,
          termYears: 1,
        },
        "CANDIDATE_CARD_INPUT_INVALID",
        "entry_id_invalid",
      ],
      [
        {
          type: "edit",
          entryId: uuid(2),
          aavCents: 99,
          termYears: 2,
        },
        "CANDIDATE_CONTRACT_INVALID",
        "minimum_aav_not_met",
      ],
      [
        {
          type: "add",
          slotKey: "B01",
          playerId: uuid(1),
          aavCents: 425,
          termYears: 1,
        },
        "CANDIDATE_BENCH_AAV_EXCEEDED",
        "bench_aav_exceeded",
      ],
    ];
    for (const [action, code, reasonCode] of cases) {
      assertPolicyError(
        () =>
          normalizeCandidateCardRevisionPreviewAction(
            action
          ),
        code,
        reasonCode
      );
    }
  });

  test("derives a deterministic non-colliding preview-only UUIDv4", () => {
    const input = {
      cardId: uuid(10),
      baseCardVersion: 7,
      action: {
        type: "add",
        slotKey: "D03",
        playerId: uuid(11),
        aavCents: 300,
        termYears: 2,
      },
      existingEntryIds: [uuid(12)],
    };
    const first =
      createCandidateCardAddPreviewEntryId(input);
    assert.match(first, UUID_V4_PATTERN);
    assert.equal(
      createCandidateCardAddPreviewEntryId(input),
      first
    );
    assert.notEqual(
      createCandidateCardAddPreviewEntryId({
        ...input,
        baseCardVersion: 8,
      }),
      first
    );
    assert.notEqual(
      createCandidateCardAddPreviewEntryId({
        ...input,
        existingEntryIds: [first],
      }),
      first
    );
  });

  test("rejects malformed preview identity inputs and non-add actions", () => {
    const add = {
      type: "add",
      slotKey: "F01",
      playerId: uuid(1),
      aavCents: 300,
      termYears: 1,
    };
    const cases = [
      [
        { cardId: "bad", baseCardVersion: 1, action: add, existingEntryIds: [] },
        "card_id_invalid",
      ],
      [
        { cardId: uuid(2), baseCardVersion: 0, action: add, existingEntryIds: [] },
        "base_card_version_invalid",
      ],
      [
        { cardId: uuid(2), baseCardVersion: 1, action: { type: "remove", entryId: uuid(3) }, existingEntryIds: [] },
        "add_action_required",
      ],
      [
        { cardId: uuid(2), baseCardVersion: 1, action: add, existingEntryIds: [uuid(3), uuid(3)] },
        "existing_entry_ids_invalid",
      ],
    ];
    for (const [input, reasonCode] of cases) {
      assertPolicyError(
        () =>
          createCandidateCardAddPreviewEntryId(
            input
          ),
        "CANDIDATE_CARD_INPUT_INVALID",
        reasonCode
      );
    }
  });
});
