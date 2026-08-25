const crypto = require("node:crypto");

const SESSION_SECRET_BYTES = 32;
const SESSION_SECRET_ENCODED_LENGTH = 43;
const CSRF_DERIVATION_LABEL =
  "hundo-leago:csrf:v1";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN =
  /^[A-Za-z0-9_-]+$/;

class SessionSecretError extends Error {
  constructor(reasonCode) {
    super("The session secret is invalid.");
    this.name = "SessionSecretError";
    this.code = "SESSION_SECRET_INVALID";
    this.reasonCode = reasonCode;
  }
}

function secretError(reasonCode) {
  throw new SessionSecretError(reasonCode);
}

function assertRandomBytes(value) {
  if (
    !Buffer.isBuffer(value) ||
    value.byteLength !== SESSION_SECRET_BYTES
  ) {
    secretError("SESSION_RANDOMNESS_INVALID");
  }
  return value;
}

function decodeRawToken(rawToken) {
  if (
    typeof rawToken !== "string" ||
    rawToken.length !==
      SESSION_SECRET_ENCODED_LENGTH ||
    !BASE64URL_PATTERN.test(rawToken)
  ) {
    secretError("SESSION_TOKEN_MALFORMED");
  }

  let bytes;
  try {
    bytes = Buffer.from(rawToken, "base64url");
  } catch {
    secretError("SESSION_TOKEN_MALFORMED");
  }
  if (
    bytes.byteLength !== SESSION_SECRET_BYTES ||
    bytes.toString("base64url") !== rawToken
  ) {
    bytes.fill(0);
    secretError("SESSION_TOKEN_MALFORMED");
  }
  return bytes;
}

function digestBytes(bytes, createHash) {
  let digest;
  try {
    digest = createHash("sha256")
      .update(bytes)
      .digest("hex");
  } catch {
    secretError("SESSION_DIGEST_FAILED");
  }
  if (
    typeof digest !== "string" ||
    !SHA256_HEX_PATTERN.test(digest)
  ) {
    secretError("SESSION_DIGEST_FAILED");
  }
  return digest;
}

function deriveCsrfBytes(
  sessionBytes,
  createHmac
) {
  let csrfBytes;
  try {
    csrfBytes = createHmac(
      "sha256",
      sessionBytes
    )
      .update(CSRF_DERIVATION_LABEL, "utf8")
      .digest();
  } catch {
    secretError("SESSION_CSRF_DERIVATION_FAILED");
  }
  if (
    !Buffer.isBuffer(csrfBytes) ||
    csrfBytes.byteLength !== SESSION_SECRET_BYTES
  ) {
    secretError("SESSION_CSRF_DERIVATION_FAILED");
  }
  return Buffer.from(csrfBytes);
}

function decodeForVerification(rawToken) {
  try {
    return decodeRawToken(rawToken);
  } catch (error) {
    if (error instanceof SessionSecretError) {
      return null;
    }
    throw error;
  }
}

function createInternalSecretBundle(values) {
  const bundle = {};
  for (const [key, value] of Object.entries(
    values
  )) {
    Object.defineProperty(bundle, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  Object.defineProperty(bundle, "toJSON", {
    configurable: false,
    enumerable: false,
    value() {
      return {};
    },
    writable: false,
  });
  return Object.freeze(bundle);
}

function createSessionSecrets({
  secureRandom,
  createHash = crypto.createHash,
  createHmac = crypto.createHmac,
  timingSafeEqual = crypto.timingSafeEqual,
} = {}) {
  if (
    !secureRandom ||
    typeof secureRandom.bytes !== "function"
  ) {
    throw new TypeError(
      "createSessionSecrets requires secure randomness"
    );
  }
  if (typeof createHash !== "function") {
    throw new TypeError(
      "createSessionSecrets requires SHA-256"
    );
  }
  if (
    typeof createHmac !== "function" ||
    typeof timingSafeEqual !== "function"
  ) {
    throw new TypeError(
      "createSessionSecrets requires HMAC and constant-time comparison"
    );
  }

  function digest(rawToken) {
    const bytes = decodeRawToken(rawToken);
    try {
      return digestBytes(bytes, createHash);
    } finally {
      bytes.fill(0);
    }
  }

  function deriveCsrf(rawSessionToken) {
    const sessionBytes =
      decodeRawToken(rawSessionToken);
    let csrfBytes;
    try {
      csrfBytes = deriveCsrfBytes(
        sessionBytes,
        createHmac
      );
      return csrfBytes.toString("base64url");
    } finally {
      sessionBytes.fill(0);
      csrfBytes?.fill(0);
    }
  }

  function verifyCsrf({
    rawSessionToken,
    rawCsrfToken,
    storedDigest,
  } = {}) {
    if (
      typeof storedDigest !== "string" ||
      !SHA256_HEX_PATTERN.test(storedDigest)
    ) {
      return false;
    }

    const sessionBytes =
      decodeForVerification(rawSessionToken);
    const presentedCsrfBytes =
      decodeForVerification(rawCsrfToken);
    if (!sessionBytes || !presentedCsrfBytes) {
      sessionBytes?.fill(0);
      presentedCsrfBytes?.fill(0);
      return false;
    }

    let expectedCsrfBytes;
    let expectedDigestBytes;
    const storedDigestBytes = Buffer.from(
      storedDigest,
      "hex"
    );
    try {
      expectedCsrfBytes = deriveCsrfBytes(
        sessionBytes,
        createHmac
      );
      expectedDigestBytes = Buffer.from(
        digestBytes(
          expectedCsrfBytes,
          createHash
        ),
        "hex"
      );
      const tokenMatches = timingSafeEqual(
        expectedCsrfBytes,
        presentedCsrfBytes
      );
      const digestMatches = timingSafeEqual(
        expectedDigestBytes,
        storedDigestBytes
      );
      return tokenMatches && digestMatches;
    } finally {
      sessionBytes.fill(0);
      presentedCsrfBytes.fill(0);
      expectedCsrfBytes?.fill(0);
      expectedDigestBytes?.fill(0);
      storedDigestBytes.fill(0);
    }
  }

  function generate() {
    const sessionBytes = assertRandomBytes(
      secureRandom.bytes(SESSION_SECRET_BYTES)
    );
    let csrfBytes;

    try {
      csrfBytes = deriveCsrfBytes(
        sessionBytes,
        createHmac
      );

      return createInternalSecretBundle({
        rawSessionToken:
          sessionBytes.toString("base64url"),
        sessionTokenDigest: digestBytes(
          sessionBytes,
          createHash
        ),
        rawCsrfToken:
          csrfBytes.toString("base64url"),
        csrfTokenDigest: digestBytes(
          csrfBytes,
          createHash
        ),
      });
    } finally {
      sessionBytes.fill(0);
      csrfBytes.fill(0);
    }
  }

  return Object.freeze({
    deriveCsrf,
    digest,
    generate,
    verifyCsrf,
  });
}

module.exports = {
  BASE64URL_PATTERN,
  CSRF_DERIVATION_LABEL,
  SESSION_SECRET_BYTES,
  SESSION_SECRET_ENCODED_LENGTH,
  SHA256_HEX_PATTERN,
  SessionSecretError,
  createSessionSecrets,
};
