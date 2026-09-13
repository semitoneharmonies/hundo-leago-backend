const crypto = require("node:crypto");

const DEFAULT_TOKEN_BYTES = 32;
const MAXIMUM_RANDOM_BYTES = 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertByteLength(byteLength) {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > MAXIMUM_RANDOM_BYTES
  ) {
    throw new RangeError(
      `random byte length must be an integer from 1 to ${MAXIMUM_RANDOM_BYTES}`
    );
  }
}

function createSecureRandom({
  randomBytes = crypto.randomBytes,
  randomUUID = crypto.randomUUID,
} = {}) {
  if (typeof randomBytes !== "function") {
    throw new TypeError(
      "createSecureRandom requires a randomBytes function"
    );
  }
  if (typeof randomUUID !== "function") {
    throw new TypeError(
      "createSecureRandom requires a randomUUID function"
    );
  }

  function bytes(byteLength) {
    assertByteLength(byteLength);
    const value = randomBytes(byteLength);

    if (
      !Buffer.isBuffer(value) &&
      !(value instanceof Uint8Array)
    ) {
      throw new TypeError(
        "randomBytes provider must return bytes"
      );
    }
    if (value.byteLength !== byteLength) {
      throw new RangeError(
        "randomBytes provider returned the wrong byte length"
      );
    }

    return Buffer.from(value);
  }

  return Object.freeze({
    bytes,
    token(byteLength = DEFAULT_TOKEN_BYTES) {
      return bytes(byteLength).toString("base64url");
    },
    id() {
      const value = randomUUID();
      if (
        typeof value !== "string" ||
        !UUID_V4_PATTERN.test(value)
      ) {
        throw new TypeError(
          "randomUUID provider must return a canonical UUID v4"
        );
      }
      return value;
    },
  });
}

module.exports = {
  DEFAULT_TOKEN_BYTES,
  MAXIMUM_RANDOM_BYTES,
  UUID_V4_PATTERN,
  assertByteLength,
  createSecureRandom,
};
