const crypto = require("node:crypto");

const {
  ACTION_TOKEN_PURPOSES,
} = require("../../domain/accounts/accountActionTokenPolicy");

const ALGORITHM = "A256GCM";
const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const RAW_TOKEN_BYTES = 32;
const ENVELOPE_KEYS = Object.freeze([
  "algorithm",
  "authenticationTag",
  "ciphertext",
  "envelopeVersion",
  "keyVersion",
  "nonce",
]);
const BINDING_KEYS = Object.freeze([
  "outboxEventId",
  "publicFrontendOrigin",
  "purpose",
  "tokenId",
  "userId",
]);

class ActionTokenDeliveryEnvelopeError extends Error {
  constructor() {
    super("The action-token delivery envelope is invalid.");
    this.name = "ActionTokenDeliveryEnvelopeError";
    this.code = "ACTION_TOKEN_DELIVERY_ENVELOPE_INVALID";
  }
}

function invalidEnvelope() {
  return new ActionTokenDeliveryEnvelopeError();
}

function decodeCanonicalBase64Url(
  value,
  byteLength
) {
  if (
    typeof value !== "string" ||
    value === "" ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw invalidEnvelope();
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw invalidEnvelope();
  }
  if (
    decoded.length !== byteLength ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    throw invalidEnvelope();
  }
  return decoded;
}

function assertPositiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidEnvelope();
  }
  return value;
}

function assertExactKeys(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw invalidEnvelope();
  }
  const actual = Object.keys(value).sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw invalidEnvelope();
  }
  return value;
}

function assertCanonicalOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidEnvelope();
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw invalidEnvelope();
  }
  return value;
}

function canonicalBinding(binding, keyVersion) {
  assertExactKeys(binding, BINDING_KEYS);
  for (const field of [
    "outboxEventId",
    "userId",
    "tokenId",
  ]) {
    if (
      typeof binding[field] !== "string" ||
      binding[field].trim() === ""
    ) {
      throw invalidEnvelope();
    }
  }
  if (!ACTION_TOKEN_PURPOSES.includes(binding.purpose)) {
    throw invalidEnvelope();
  }
  assertCanonicalOrigin(binding.publicFrontendOrigin);

  return Buffer.from(
    JSON.stringify({
      algorithm: ALGORITHM,
      envelopeVersion: ENVELOPE_VERSION,
      keyVersion,
      outboxEventId: binding.outboxEventId,
      userId: binding.userId,
      tokenId: binding.tokenId,
      purpose: binding.purpose,
      publicFrontendOrigin:
        binding.publicFrontendOrigin,
    }),
    "utf8"
  );
}

function assertRawToken(rawToken) {
  const decoded = decodeCanonicalBase64Url(
    rawToken,
    RAW_TOKEN_BYTES
  );
  decoded.fill(0);
  return rawToken;
}

function freezeEnvelope(value) {
  return Object.freeze({ ...value });
}

function createOpenResult(rawToken) {
  const result = {
    kind: "internal_action_token_delivery_plaintext",
  };
  Object.defineProperty(result, "rawToken", {
    configurable: false,
    enumerable: false,
    value: rawToken,
    writable: false,
  });
  return Object.freeze(result);
}

function createActionTokenDeliveryEnvelope({
  encodedKey,
  keyVersion,
  secureRandom,
  createCipheriv = crypto.createCipheriv,
  createDecipheriv = crypto.createDecipheriv,
} = {}) {
  const key = decodeCanonicalBase64Url(
    encodedKey,
    KEY_BYTES
  );
  const activeKeyVersion = assertPositiveVersion(
    keyVersion
  );
  if (
    !secureRandom ||
    typeof secureRandom.bytes !== "function"
  ) {
    key.fill(0);
    throw new TypeError(
      "action-token delivery encryption requires secure randomness"
    );
  }
  if (
    typeof createCipheriv !== "function" ||
    typeof createDecipheriv !== "function"
  ) {
    key.fill(0);
    throw new TypeError(
      "action-token delivery encryption requires AES-GCM providers"
    );
  }

  function seal({ rawToken, binding } = {}) {
    assertRawToken(rawToken);
    const associatedData = canonicalBinding(
      binding,
      activeKeyVersion
    );
    const nonce = secureRandom.bytes(NONCE_BYTES);
    if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
      associatedData.fill(0);
      throw invalidEnvelope();
    }
    const plaintext = Buffer.from(rawToken, "utf8");
    try {
      const cipher = createCipheriv(
        "aes-256-gcm",
        key,
        nonce,
        { authTagLength: AUTHENTICATION_TAG_BYTES }
      );
      cipher.setAAD(associatedData, {
        plaintextLength: plaintext.length,
      });
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();
      return freezeEnvelope({
        algorithm: ALGORITHM,
        authenticationTag:
          authenticationTag.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        envelopeVersion: ENVELOPE_VERSION,
        keyVersion: activeKeyVersion,
        nonce: nonce.toString("base64url"),
      });
    } catch (error) {
      if (
        error instanceof ActionTokenDeliveryEnvelopeError
      ) {
        throw error;
      }
      throw invalidEnvelope();
    } finally {
      plaintext.fill(0);
      associatedData.fill(0);
      nonce.fill(0);
    }
  }

  function open({ envelope, binding } = {}) {
    assertExactKeys(envelope, ENVELOPE_KEYS);
    if (
      envelope.algorithm !== ALGORITHM ||
      envelope.envelopeVersion !== ENVELOPE_VERSION ||
      envelope.keyVersion !== activeKeyVersion
    ) {
      throw invalidEnvelope();
    }

    const associatedData = canonicalBinding(
      binding,
      activeKeyVersion
    );
    let nonce;
    let ciphertext;
    let authenticationTag;
    let plaintext;
    try {
      nonce = decodeCanonicalBase64Url(
        envelope.nonce,
        NONCE_BYTES
      );
      ciphertext = decodeCanonicalBase64Url(
        envelope.ciphertext,
        43
      );
      authenticationTag = decodeCanonicalBase64Url(
        envelope.authenticationTag,
        AUTHENTICATION_TAG_BYTES
      );
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        nonce,
        { authTagLength: AUTHENTICATION_TAG_BYTES }
      );
      decipher.setAAD(associatedData, {
        plaintextLength: ciphertext.length,
      });
      decipher.setAuthTag(authenticationTag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      const rawToken = plaintext.toString("utf8");
      assertRawToken(rawToken);
      return createOpenResult(rawToken);
    } catch {
      throw invalidEnvelope();
    } finally {
      associatedData.fill(0);
      nonce?.fill(0);
      ciphertext?.fill(0);
      authenticationTag?.fill(0);
      plaintext?.fill(0);
    }
  }

  return Object.freeze({ open, seal });
}

module.exports = {
  ACTION_TOKEN_DELIVERY_ALGORITHM: ALGORITHM,
  ACTION_TOKEN_DELIVERY_ENVELOPE_VERSION:
    ENVELOPE_VERSION,
  ActionTokenDeliveryEnvelopeError,
  createActionTokenDeliveryEnvelope,
};
