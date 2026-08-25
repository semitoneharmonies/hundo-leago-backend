const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  ActionTokenDeliveryEnvelopeError,
  createActionTokenDeliveryEnvelope,
} = require(
  "../../src/infrastructure/security/createActionTokenDeliveryEnvelope"
);
const {
  createSecureRandom,
} = require(
  "../../src/infrastructure/security/createSecureRandom"
);

const ENCODED_KEY = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 1)
).toString("base64url");
const OTHER_KEY = Buffer.alloc(32, 0xa7).toString(
  "base64url"
);
const RAW_TOKEN = Buffer.alloc(32, 0xc3).toString(
  "base64url"
);
const BINDING = Object.freeze({
  outboxEventId:
    "071c6f4a-e538-4a93-bb92-7bb0855e4721",
  publicFrontendOrigin: "https://hundo.example",
  purpose: "email_verification",
  tokenId:
    "22e5ca09-d96b-4e34-91d1-161075a41d9f",
  userId:
    "76fbd6a0-b544-4f10-95a9-bfa2e7f411de",
});

function deterministicRandom() {
  let byte = 0;
  return createSecureRandom({
    randomBytes(byteLength) {
      byte += 1;
      return Buffer.alloc(byteLength, byte);
    },
    randomUUID() {
      return "018f4ca6-7f73-4d95-8b65-91f9a2cc4d8e";
    },
  });
}

function createAdapter(
  encodedKey = ENCODED_KEY,
  keyVersion = 1
) {
  return createActionTokenDeliveryEnvelope({
    encodedKey,
    keyVersion,
    secureRandom: deterministicRandom(),
  });
}

function assertInvalid(operation) {
  assert.throws(
    operation,
    (error) =>
      error instanceof ActionTokenDeliveryEnvelopeError &&
      error.code ===
        "ACTION_TOKEN_DELIVERY_ENVELOPE_INVALID" &&
      !error.message.includes(ENCODED_KEY) &&
      !error.message.includes(RAW_TOKEN)
  );
}

describe("M3-07 encrypted action-token delivery envelope", () => {
  test("round trips only through a non-enumerable internal plaintext result", () => {
    const adapter = createAdapter();
    const envelope = adapter.seal({
      rawToken: RAW_TOKEN,
      binding: BINDING,
    });
    const opened = adapter.open({
      envelope,
      binding: BINDING,
    });

    assert.equal(opened.rawToken, RAW_TOKEN);
    assert.deepEqual(Object.keys(opened), ["kind"]);
    assert.equal(
      JSON.stringify(opened).includes(RAW_TOKEN),
      false
    );
    assert.equal(Object.isFrozen(envelope), true);
    assert.deepEqual(Object.keys(envelope).sort(), [
      "algorithm",
      "authenticationTag",
      "ciphertext",
      "envelopeVersion",
      "keyVersion",
      "nonce",
    ]);
    const serialized = JSON.stringify(envelope);
    assert.equal(serialized.includes(RAW_TOKEN), false);
    assert.equal(serialized.includes(ENCODED_KEY), false);
  });

  test("uses a fresh 96-bit nonce for every envelope", () => {
    const adapter = createAdapter();
    const first = adapter.seal({
      rawToken: RAW_TOKEN,
      binding: BINDING,
    });
    const second = adapter.seal({
      rawToken: RAW_TOKEN,
      binding: BINDING,
    });

    assert.notEqual(first.nonce, second.nonce);
    assert.equal(
      Buffer.from(first.nonce, "base64url").length,
      12
    );
    assert.equal(
      Buffer.from(
        first.authenticationTag,
        "base64url"
      ).length,
      16
    );
  });

  test("rejects ciphertext, tag, nonce, and metadata tampering", () => {
    const adapter = createAdapter();
    const envelope = adapter.seal({
      rawToken: RAW_TOKEN,
      binding: BINDING,
    });
    const mutate = (field) => ({
      ...envelope,
      [field]:
        (envelope[field][0] === "A" ? "B" : "A") +
        envelope[field].slice(1),
    });

    for (const field of [
      "ciphertext",
      "authenticationTag",
      "nonce",
    ]) {
      assertInvalid(() =>
        adapter.open({
          envelope: mutate(field),
          binding: BINDING,
        })
      );
    }
    for (const [field, value] of [
      ["outboxEventId", "other-outbox"],
      ["userId", "other-user"],
      ["tokenId", "other-token"],
      ["purpose", "password_reset"],
      [
        "publicFrontendOrigin",
        "https://other.example",
      ],
    ]) {
      assertInvalid(() =>
        adapter.open({
          envelope,
          binding: { ...BINDING, [field]: value },
        })
      );
    }
  });

  test("rejects wrong keys, versions, extra fields, and noncanonical encodings", () => {
    const envelope = createAdapter().seal({
      rawToken: RAW_TOKEN,
      binding: BINDING,
    });

    assertInvalid(() =>
      createAdapter(OTHER_KEY).open({
        envelope,
        binding: BINDING,
      })
    );
    assertInvalid(() =>
      createAdapter(ENCODED_KEY, 2).open({
        envelope,
        binding: BINDING,
      })
    );
    assertInvalid(() =>
      createAdapter().open({
        envelope: { ...envelope, extra: true },
        binding: BINDING,
      })
    );
    assertInvalid(() =>
      createAdapter().open({
        envelope: {
          ...envelope,
          nonce: `${envelope.nonce}=`,
        },
        binding: BINDING,
      })
    );
  });

  test("rejects invalid construction and non-token plaintext without exposing input", () => {
    for (const encodedKey of [
      undefined,
      "short",
      `${ENCODED_KEY}=`,
    ]) {
      assert.throws(
        () =>
          createActionTokenDeliveryEnvelope({
            encodedKey,
            keyVersion: 1,
            secureRandom: deterministicRandom(),
          }),
        (error) =>
          error.code ===
          "ACTION_TOKEN_DELIVERY_ENVELOPE_INVALID"
      );
    }
    assertInvalid(() =>
      createAdapter().seal({
        rawToken: "not-a-token",
        binding: BINDING,
      })
    );
  });
});
