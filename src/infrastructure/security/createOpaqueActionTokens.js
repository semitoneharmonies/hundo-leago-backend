const crypto = require("node:crypto");

const ACTION_TOKEN_BYTES = 32;
const ACTION_TOKEN_LENGTH = 43;
const RAW_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

class OpaqueActionTokenError extends Error {
  constructor(reasonCode) {
    super("The account action token is invalid.");
    this.name = "OpaqueActionTokenError";
    this.code = "ACTION_TOKEN_INVALID";
    this.reasonCode = reasonCode;
  }
}

function tokenError(reasonCode) {
  throw new OpaqueActionTokenError(reasonCode);
}

function decodeRawToken(rawToken) {
  if (
    typeof rawToken !== "string" ||
    rawToken.length !== ACTION_TOKEN_LENGTH ||
    !RAW_TOKEN_PATTERN.test(rawToken)
  ) {
    tokenError("ACTION_TOKEN_MALFORMED");
  }
  const bytes = Buffer.from(
    rawToken,
    "base64url"
  );
  if (
    bytes.byteLength !== ACTION_TOKEN_BYTES ||
    bytes.toString("base64url") !== rawToken
  ) {
    bytes.fill(0);
    tokenError("ACTION_TOKEN_MALFORMED");
  }
  return bytes;
}

function createOpaqueActionTokens({
  secureRandom,
  createHash = crypto.createHash,
  timingSafeEqual = crypto.timingSafeEqual,
} = {}) {
  if (
    !secureRandom ||
    typeof secureRandom.bytes !== "function"
  ) {
    throw new TypeError(
      "opaque action tokens require secure randomness"
    );
  }
  if (
    typeof createHash !== "function" ||
    typeof timingSafeEqual !== "function"
  ) {
    throw new TypeError(
      "opaque action tokens require SHA-256 and constant-time comparison"
    );
  }

  function digestBytes(bytes) {
    let value;
    try {
      value = createHash("sha256")
        .update(bytes)
        .digest("hex");
    } catch {
      tokenError("ACTION_TOKEN_DIGEST_FAILED");
    }
    if (
      typeof value !== "string" ||
      !DIGEST_PATTERN.test(value)
    ) {
      tokenError("ACTION_TOKEN_DIGEST_FAILED");
    }
    return value;
  }

  function digest(rawToken) {
    const bytes = decodeRawToken(rawToken);
    try {
      return digestBytes(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  function matches(rawToken, storedDigest) {
    if (
      typeof storedDigest !== "string" ||
      !DIGEST_PATTERN.test(storedDigest)
    ) {
      return false;
    }
    let candidate;
    try {
      candidate = digest(rawToken);
    } catch (error) {
      if (error instanceof OpaqueActionTokenError) {
        return false;
      }
      throw error;
    }
    const candidateBytes = Buffer.from(
      candidate,
      "hex"
    );
    const storedBytes = Buffer.from(
      storedDigest,
      "hex"
    );
    try {
      return timingSafeEqual(
        candidateBytes,
        storedBytes
      );
    } finally {
      candidateBytes.fill(0);
      storedBytes.fill(0);
    }
  }

  function generate() {
    const bytes = secureRandom.bytes(
      ACTION_TOKEN_BYTES
    );
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.byteLength !== ACTION_TOKEN_BYTES
    ) {
      tokenError("ACTION_TOKEN_RANDOMNESS_INVALID");
    }
    try {
      const result = {
        tokenDigest: digestBytes(bytes),
      };
      Object.defineProperty(result, "rawToken", {
        configurable: false,
        enumerable: false,
        value: bytes.toString("base64url"),
        writable: false,
      });
      return Object.freeze(result);
    } finally {
      bytes.fill(0);
    }
  }

  return Object.freeze({
    digest,
    generate,
    matches,
  });
}

module.exports = {
  ACTION_TOKEN_BYTES,
  ACTION_TOKEN_LENGTH,
  DIGEST_PATTERN,
  OpaqueActionTokenError,
  RAW_TOKEN_PATTERN,
  createOpaqueActionTokens,
};
