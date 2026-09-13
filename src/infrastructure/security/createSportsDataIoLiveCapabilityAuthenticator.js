const crypto = require("node:crypto");

const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
  hashSportsDataIoLiveCapabilityEvidence,
  serializeSportsDataIoLiveCapabilityEvidence,
  validateSportsDataIoLiveCapabilityEvidence,
} = require(
  "../../domain/statistics/sportsDataIoLiveCapabilityEvidencePolicy"
);
const {
  serializeCanonicalJsonV1,
} = require("../../domain/leagues/seasonRolloverEvidencePolicy");

const SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_HMAC_PREFIX =
  "hundo-leago:sportsdataio-live-capability-evidence:v1\0";
const SPORTS_DATA_IO_LIVE_CAPABILITY_CREDENTIAL_HMAC_PREFIX =
  "hundo-leago:sportsdataio-live-capability-credential:v1\0";
const SPORTS_DATA_IO_LIVE_CAPABILITY_AUTHENTICATION_ERROR_CODE =
  "SPORTSDATAIO_LIVE_CAPABILITY_AUTHENTICATION_INVALID";
const SPORTS_DATA_IO_LIVE_CAPABILITY_CONFIGURATION_ERROR_CODE =
  "SPORTSDATAIO_LIVE_CAPABILITY_AUTHENTICATOR_CONFIGURATION_INVALID";
const ARTIFACT_KEYS = Object.freeze([
  "evidence",
  "evidenceSha256",
  "evidenceHmacSha256",
]);
const EXPECTED_BINDING_KEYS = Object.freeze([
  "appEnv",
  "environmentId",
  "backendBuildId",
  "origin",
  "configuredNhlSeasonKey",
  "probeNhlSeasonKey",
  "probeKind",
  "probeManifestSha256",
]);
const CONFIGURATION_KEYS = Object.freeze([
  "capabilitySecret",
  "dedicatedLiveApiKey",
  "capabilityKeyVersion",
  "createHmac",
  "timingSafeEqual",
]);
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

class SportsDataIoLiveCapabilityAuthenticationError extends Error {
  constructor() {
    super("The SportsDataIO live capability artifact is invalid.");
    this.name = "SportsDataIoLiveCapabilityAuthenticationError";
    this.code =
      SPORTS_DATA_IO_LIVE_CAPABILITY_AUTHENTICATION_ERROR_CODE;
  }
}

class SportsDataIoLiveCapabilityAuthenticatorConfigurationError
  extends TypeError {
  constructor() {
    super("SportsDataIO live capability authentication is not configured.");
    this.name =
      "SportsDataIoLiveCapabilityAuthenticatorConfigurationError";
    this.code =
      SPORTS_DATA_IO_LIVE_CAPABILITY_CONFIGURATION_ERROR_CODE;
  }
}

function invalidArtifact() {
  throw new SportsDataIoLiveCapabilityAuthenticationError();
}

function invalidConfiguration() {
  throw new SportsDataIoLiveCapabilityAuthenticatorConfigurationError();
}

function exactObject(value, keys, invalid) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    invalid();
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      invalid();
    }
  }
  return value;
}

function secretText(value, minimumBytes, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalidConfiguration();
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength < minimumBytes || byteLength > maximumBytes) {
    invalidConfiguration();
  }
  return value;
}

function canonicalDigest(value) {
  if (typeof value !== "string" || !HEX_SHA256_PATTERN.test(value)) {
    invalidArtifact();
  }
  return value;
}

function safeNow(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    invalidArtifact();
  }
  return value;
}

function createSportsDataIoLiveCapabilityAuthenticator(options = {}) {
  const configuration = exactObject(
    options,
    CONFIGURATION_KEYS.filter((key) =>
      Object.prototype.hasOwnProperty.call(options, key)
    ),
    invalidConfiguration
  );
  for (const key of [
    "capabilitySecret",
    "dedicatedLiveApiKey",
    "capabilityKeyVersion",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(configuration, key)) {
      invalidConfiguration();
    }
  }
  const capabilitySecret = secretText(
    configuration.capabilitySecret,
    32,
    4096
  );
  const dedicatedLiveApiKey = secretText(
    configuration.dedicatedLiveApiKey,
    1,
    1024
  );
  if (capabilitySecret === dedicatedLiveApiKey) {
    invalidConfiguration();
  }
  const capabilityKeyVersion = configuration.capabilityKeyVersion;
  if (
    !Number.isSafeInteger(capabilityKeyVersion) ||
    capabilityKeyVersion < 1
  ) {
    invalidConfiguration();
  }
  const createHmac = configuration.createHmac ?? crypto.createHmac;
  const timingSafeEqual =
    configuration.timingSafeEqual ?? crypto.timingSafeEqual;
  if (
    typeof createHmac !== "function" ||
    typeof timingSafeEqual !== "function"
  ) {
    invalidConfiguration();
  }

  function hmacSha256(prefix, value) {
    let digest;
    try {
      digest = createHmac("sha256", capabilitySecret)
        .update(prefix, "utf8")
        .update(value, "utf8")
        .digest("hex");
    } catch {
      invalidArtifact();
    }
    if (
      typeof digest !== "string" ||
      !HEX_SHA256_PATTERN.test(digest)
    ) {
      invalidArtifact();
    }
    return digest;
  }

  function equalDigest(left, right) {
    canonicalDigest(left);
    canonicalDigest(right);
    const leftBytes = Buffer.from(left, "hex");
    const rightBytes = Buffer.from(right, "hex");
    try {
      if (
        leftBytes.length !== 32 ||
        rightBytes.length !== 32 ||
        leftBytes.length !== rightBytes.length
      ) {
        invalidArtifact();
      }
      let equal;
      try {
        equal = timingSafeEqual(leftBytes, rightBytes);
      } catch {
        invalidArtifact();
      }
      if (equal !== true) {
        invalidArtifact();
      }
    } finally {
      leftBytes.fill(0);
      rightBytes.fill(0);
    }
  }

  const credentialBinding = hmacSha256(
    SPORTS_DATA_IO_LIVE_CAPABILITY_CREDENTIAL_HMAC_PREFIX,
    dedicatedLiveApiKey
  );

  function credentialBindingHmacSha256() {
    return credentialBinding;
  }

  function assertCurrentCredential(evidence) {
    if (evidence.capabilityKeyVersion !== capabilityKeyVersion) {
      invalidArtifact();
    }
    equalDigest(
      evidence.credentialBindingHmacSha256,
      credentialBinding
    );
  }

  function createArtifact(evidence) {
    let normalized;
    try {
      normalized = validateSportsDataIoLiveCapabilityEvidence(evidence);
    } catch {
      invalidArtifact();
    }
    assertCurrentCredential(normalized);
    const canonicalEvidence =
      serializeSportsDataIoLiveCapabilityEvidence(normalized);
    const evidenceSha256 =
      hashSportsDataIoLiveCapabilityEvidence(normalized);
    const evidenceHmacSha256 = hmacSha256(
      SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_HMAC_PREFIX,
      canonicalEvidence
    );
    return Object.freeze({
      evidence: normalized,
      evidenceSha256,
      evidenceHmacSha256,
    });
  }

  function validateExpectedBindings(value) {
    const bindings = exactObject(
      value,
      EXPECTED_BINDING_KEYS,
      invalidArtifact
    );
    try {
      serializeCanonicalJsonV1(bindings);
    } catch {
      invalidArtifact();
    }
    return bindings;
  }

  function verifyArtifact(input = {}) {
    const request = exactObject(
      input,
      ["artifact", "expectedBindings", "nowMs"],
      invalidArtifact
    );
    const artifact = exactObject(
      request.artifact,
      ARTIFACT_KEYS,
      invalidArtifact
    );
    canonicalDigest(artifact.evidenceSha256);
    canonicalDigest(artifact.evidenceHmacSha256);
    let evidence;
    try {
      evidence = validateSportsDataIoLiveCapabilityEvidence(
        artifact.evidence
      );
    } catch {
      invalidArtifact();
    }
    const bindings = validateExpectedBindings(
      request.expectedBindings
    );
    const verifiedAtMs = safeNow(request.nowMs);
    if (
      evidence.issuedAtMs > verifiedAtMs ||
      verifiedAtMs >= evidence.expiresAtMs ||
      evidence.expiresAtMs - evidence.issuedAtMs !==
        SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS
    ) {
      invalidArtifact();
    }
    for (const field of EXPECTED_BINDING_KEYS) {
      if (evidence[field] !== bindings[field]) {
        invalidArtifact();
      }
    }
    assertCurrentCredential(evidence);
    const canonicalEvidence =
      serializeSportsDataIoLiveCapabilityEvidence(evidence);
    const calculatedEvidenceSha256 =
      hashSportsDataIoLiveCapabilityEvidence(evidence);
    equalDigest(
      artifact.evidenceSha256,
      calculatedEvidenceSha256
    );
    const calculatedEvidenceHmacSha256 = hmacSha256(
      SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_HMAC_PREFIX,
      canonicalEvidence
    );
    equalDigest(
      artifact.evidenceHmacSha256,
      calculatedEvidenceHmacSha256
    );
    return Object.freeze({
      status: "verified",
      evidenceId: evidence.evidenceId,
      evidenceSha256: calculatedEvidenceSha256,
      issuedAtMs: evidence.issuedAtMs,
      expiresAtMs: evidence.expiresAtMs,
      verifiedAtMs,
    });
  }

  return Object.freeze({
    capabilityKeyVersion,
    createArtifact,
    credentialBindingHmacSha256,
    verifyArtifact,
  });
}

module.exports = {
  SPORTS_DATA_IO_LIVE_CAPABILITY_AUTHENTICATION_ERROR_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_CONFIGURATION_ERROR_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_CREDENTIAL_HMAC_PREFIX,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_HMAC_PREFIX,
  SportsDataIoLiveCapabilityAuthenticationError,
  SportsDataIoLiveCapabilityAuthenticatorConfigurationError,
  createSportsDataIoLiveCapabilityAuthenticator,
};
