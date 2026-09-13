"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  CANDIDATE_CARD_HELP_MESSAGE_MAXIMUM_CODE_POINTS,
  normalizeCandidateCardHelpBody,
  normalizeCandidateCardHelpIdempotencyKey,
  normalizeCandidateCardHelpMessage,
} = require(
  "../../src/domain/freeAgentDraft/candidateCardHelpPolicy"
);

function assertInputError(callback, reasonCode) {
  assert.throws(callback, (error) => (
    error?.name === "CandidateCardPolicyError" &&
    error?.code === "CANDIDATE_CARD_INPUT_INVALID" &&
    error?.reasonCode === reasonCode
  ));
}

describe("Candidate Card help policy", () => {
  test("normalizes every approved exact help body form", () => {
    for (const [input, expected] of [
      [{}, { message: null }],
      [{ message: null }, { message: null }],
      [{ message: "   " }, { message: null }],
      [
        { message: "  Please review my card.  " },
        { message: "Please review my card." },
      ],
    ]) {
      const result = normalizeCandidateCardHelpBody(input);
      assert.deepEqual(result, expected);
      assert.equal(Object.isFrozen(result), true);
    }
  });

  test("counts astral Unicode messages by code point at the exact boundary", () => {
    assert.equal(
      CANDIDATE_CARD_HELP_MESSAGE_MAXIMUM_CODE_POINTS,
      500
    );
    const maximum = "\u{1f3d2}".repeat(500);
    assert.equal([...maximum].length, 500);
    assert.equal(
      normalizeCandidateCardHelpMessage(maximum),
      maximum
    );
    assertInputError(
      () =>
        normalizeCandidateCardHelpMessage(
          `${maximum}\u{1f3d2}`
        ),
      "help_message_invalid"
    );
  });

  test("rejects controls and non-string message values", () => {
    for (const value of [
      "line one\nline two",
      "hidden\u0000value",
      "hidden\u0085value",
      1,
      false,
      [],
      {},
    ]) {
      assertInputError(
        () => normalizeCandidateCardHelpMessage(value),
        "help_message_invalid"
      );
    }
  });

  test("rejects missing, non-object, symbolic, nonenumerable, and unknown body shapes", () => {
    const symbolic = {
      [Symbol("message")]: "hidden",
    };
    const nonenumerable = {};
    Object.defineProperty(nonenumerable, "message", {
      value: "hidden",
    });
    for (const value of [
      undefined,
      null,
      "message",
      [],
      { extra: true },
      { message: null, extra: true },
      symbolic,
      nonenumerable,
    ]) {
      assertInputError(
        () => normalizeCandidateCardHelpBody(value),
        "help_body_invalid"
      );
    }
  });

  test("uses the exact shared Candidate idempotency-key boundary", () => {
    assert.equal(
      normalizeCandidateCardHelpIdempotencyKey(
        "  request-help  "
      ),
      "request-help"
    );
    const maximum = "\u{1f511}".repeat(128);
    assert.equal(
      normalizeCandidateCardHelpIdempotencyKey(maximum),
      maximum
    );
    for (const value of [
      " ",
      `${maximum}\u{1f511}`,
      "unsafe\nkey",
      "unsafe\u2028key",
      1,
    ]) {
      assertInputError(
        () =>
          normalizeCandidateCardHelpIdempotencyKey(value),
        "idempotency_key_invalid"
      );
    }
  });
});
