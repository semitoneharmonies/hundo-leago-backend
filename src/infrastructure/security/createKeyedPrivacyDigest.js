const crypto = require("node:crypto");

const PURPOSE_PATTERN =
  /^[a-z][a-z0-9_]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAXIMUM_VALUE_LENGTH = 512;

function createKeyedPrivacyDigest({
  secretSlot,
  purpose,
  createHmac = crypto.createHmac,
} = {}) {
  if (
    !secretSlot ||
    secretSlot.configured !== true ||
    typeof secretSlot.value !== "string" ||
    !Number.isSafeInteger(
      secretSlot.keyVersion
    ) ||
    secretSlot.keyVersion < 1
  ) {
    throw new TypeError(
      "a configured versioned privacy key is required"
    );
  }
  if (
    typeof purpose !== "string" ||
    !PURPOSE_PATTERN.test(purpose)
  ) {
    throw new TypeError(
      "a canonical privacy-digest purpose is required"
    );
  }
  if (typeof createHmac !== "function") {
    throw new TypeError(
      "privacy digests require HMAC-SHA-256"
    );
  }

  const keyVersion = secretSlot.keyVersion;
  const prefix =
    `hundo-leago:${purpose}:v${keyVersion}\0`;

  function digest(canonicalValue) {
    if (
      typeof canonicalValue !== "string" ||
      canonicalValue.length < 1 ||
      canonicalValue.length >
        MAXIMUM_VALUE_LENGTH ||
      canonicalValue !== canonicalValue.trim()
    ) {
      throw new TypeError(
        "a bounded canonical privacy value is required"
      );
    }
    let value;
    try {
      value = createHmac(
        "sha256",
        secretSlot.value
      )
        .update(prefix, "utf8")
        .update(canonicalValue, "utf8")
        .digest("hex");
    } catch {
      throw new Error(
        "The privacy digest could not be created."
      );
    }
    if (
      typeof value !== "string" ||
      !DIGEST_PATTERN.test(value)
    ) {
      throw new Error(
        "The privacy digest could not be created."
      );
    }
    return Object.freeze({
      digest: value,
      keyVersion,
    });
  }

  return Object.freeze({
    digest,
    keyVersion,
    purpose,
  });
}

module.exports = {
  DIGEST_PATTERN,
  MAXIMUM_VALUE_LENGTH,
  PURPOSE_PATTERN,
  createKeyedPrivacyDigest,
};
