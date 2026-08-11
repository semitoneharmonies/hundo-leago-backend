"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  CANDIDATE_CARD_IDEMPOTENCY_KEY_MAXIMUM_CODE_POINTS,
  CANDIDATE_CARD_MUTATION_ACTION_TYPES,
  MAXIMUM_CANDIDATE_CARD_EXPECTED_VERSION,
  normalizeCandidateCardExpectedVersion,
  normalizeCandidateCardIdempotencyKey,
  normalizeCandidateCardMutationAction,
} = require(
  "../../src/domain/freeAgentDraft/candidateCardMutationPolicy"
);

function uuid(value, version = "4") {
  return `00000000-0000-${version}000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => (
    error?.name === "CandidateCardPolicyError" &&
    error?.code ===
      "CANDIDATE_CARD_INPUT_INVALID" &&
    error?.reasonCode === reasonCode
  ));
}

describe("Candidate Card mutation policy", () => {
  test("normalizes and freezes the four exact public action variants", () => {
    const actions = [
      [
        {
          type: "add",
          slotKey: "F01",
          playerId: uuid(1, "1"),
          totalValueCents: 900,
          termYears: 3,
        },
        {
          type: "add",
          slotKey: "F01",
          playerId: uuid(1, "1"),
          totalValueCents: 900,
          termYears: 3,
        },
      ],
      [
        {
          type: "edit",
          entryId: uuid(2, "5"),
          totalValueCents: 400,
          termYears: 2,
        },
        {
          type: "edit",
          entryId: uuid(2, "5"),
          totalValueCents: 400,
          termYears: 2,
        },
      ],
      [
        {
          type: "move",
          entryId: uuid(2),
          slotKey: "B04",
        },
        {
          type: "move",
          entryId: uuid(2),
          slotKey: "B04",
        },
      ],
      [
        {
          type: "remove",
          entryId: uuid(2),
        },
        {
          type: "remove",
          entryId: uuid(2),
        },
      ],
    ];

    assert.deepEqual(
      CANDIDATE_CARD_MUTATION_ACTION_TYPES,
      ["add", "edit", "move", "remove"]
    );
    assert.equal(
      Object.isFrozen(
        CANDIDATE_CARD_MUTATION_ACTION_TYPES
      ),
      true
    );
    for (const [input, expected] of actions) {
      const normalized =
        normalizeCandidateCardMutationAction(
          input
        );
      assert.deepEqual(normalized, expected);
      assert.equal(
        Object.isFrozen(normalized),
        true
      );
    }
  });

  test("rejects malformed, symbolic, mixed, and noncanonical action fields", () => {
    const symbolic = {
      type: "remove",
      entryId: uuid(2),
      [Symbol("hidden")]: true,
    };
    const nonenumerable = {
      type: "remove",
      entryId: uuid(2),
    };
    Object.defineProperty(
      nonenumerable,
      "hidden",
      { value: true }
    );
    const cases = [
      [null, "action_invalid"],
      [[], "action_invalid"],
      [{}, "action_invalid"],
      [{ type: "unknown" }, "action_invalid"],
      [symbolic, "action_fields_invalid"],
      [nonenumerable, "action_fields_invalid"],
      [
        {
          type: "add",
          entryId: uuid(3),
          slotKey: "F01",
          playerId: uuid(1),
          totalValueCents: 900,
          termYears: 3,
        },
        "action_fields_invalid",
      ],
      [
        {
          type: "remove",
          entryId:
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        },
        "entry_id_invalid",
      ],
    ];
    for (const [action, reasonCode] of cases) {
      assertPolicyError(
        () =>
          normalizeCandidateCardMutationAction(
            action
          ),
        reasonCode
      );
    }
  });

  test("uses canonical slot, contract, and Bench offer validation", () => {
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
          entryId: uuid(2),
          totalValueCents: 199,
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
          totalValueCents: 401,
          termYears: 1,
        },
        "CANDIDATE_BENCH_AAV_EXCEEDED",
        "bench_aav_exceeded",
      ],
    ];
    for (const [action, code, reasonCode] of cases) {
      assert.throws(
        () =>
          normalizeCandidateCardMutationAction(
            action
          ),
        (error) => (
          error?.name ===
            "CandidateCardPolicyError" &&
          error?.code === code &&
          error?.reasonCode === reasonCode
        )
      );
    }
  });

  test("accepts only positive versions whose one-version advance remains safe", () => {
    assert.equal(
      MAXIMUM_CANDIDATE_CARD_EXPECTED_VERSION,
      Number.MAX_SAFE_INTEGER - 1
    );
    assert.equal(
      normalizeCandidateCardExpectedVersion(1),
      1
    );
    assert.equal(
      normalizeCandidateCardExpectedVersion(
        MAXIMUM_CANDIDATE_CARD_EXPECTED_VERSION
      ),
      MAXIMUM_CANDIDATE_CARD_EXPECTED_VERSION
    );
    for (const value of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
      "1",
    ]) {
      assertPolicyError(
        () =>
          normalizeCandidateCardExpectedVersion(
            value
          ),
        "expected_card_version_invalid"
      );
    }
  });

  test("trims idempotency keys and counts astral Unicode by code point", () => {
    assert.equal(
      CANDIDATE_CARD_IDEMPOTENCY_KEY_MAXIMUM_CODE_POINTS,
      128
    );
    assert.equal(
      normalizeCandidateCardIdempotencyKey(
        "  candidate-add  "
      ),
      "candidate-add"
    );
    const maximum = "🏒".repeat(128);
    assert.equal(
      [...maximum].length,
      CANDIDATE_CARD_IDEMPOTENCY_KEY_MAXIMUM_CODE_POINTS
    );
    assert.equal(
      normalizeCandidateCardIdempotencyKey(
        maximum
      ),
      maximum
    );
    assertPolicyError(
      () =>
        normalizeCandidateCardIdempotencyKey(
          `${maximum}🏒`
        ),
      "idempotency_key_invalid"
    );
  });

  test("rejects empty, non-string, and every prohibited idempotency control range", () => {
    const cases = [
      null,
      123,
      "",
      "   ",
      "key\u0000value",
      "key\u001fvalue",
      "key\u007fvalue",
      "key\u0085value",
      "key\u009fvalue",
      "key\u2028value",
      "key\u2029value",
      "\tkey",
    ];
    for (const value of cases) {
      assertPolicyError(
        () =>
          normalizeCandidateCardIdempotencyKey(
            value
          ),
        "idempotency_key_invalid"
      );
    }
  });
});
