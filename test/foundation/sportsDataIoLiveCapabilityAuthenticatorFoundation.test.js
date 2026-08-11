const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
  createSportsDataIoLiveCapabilityEvidence,
  serializeSportsDataIoLiveCapabilityEvidence,
} = require(
  "../../src/domain/statistics/sportsDataIoLiveCapabilityEvidencePolicy"
);
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_CREDENTIAL_HMAC_PREFIX,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_HMAC_PREFIX,
  SportsDataIoLiveCapabilityAuthenticationError,
  SportsDataIoLiveCapabilityAuthenticatorConfigurationError,
  createSportsDataIoLiveCapabilityAuthenticator,
} = require(
  "../../src/infrastructure/security/createSportsDataIoLiveCapabilityAuthenticator"
);

const CAPABILITY_SECRET =
  "capability-secret-0123456789abcdef-0123456789abcdef";
const DEDICATED_LIVE_API_KEY =
  "dedicated-live-api-key-123456";
const CAPABILITY_KEY_VERSION = 7;
const PLAYER_ONE =
  "00000000-0000-4000-8000-000000000001";
const PLAYER_TWO =
  "00000000-0000-4000-8000-000000000002";
const PLAYER_THREE =
  "00000000-0000-4000-8000-000000000003";
const ISSUED_AT_MS = 1_750_000_000_000;
const CAPTURED_AT_MS = ISSUED_AT_MS - 10_000;
const GAME_START_MS = ISSUED_AT_MS - 86_400_000;
const SOURCE_UPDATED_AT_MS = CAPTURED_AT_MS - 1_000;

function clone(value) {
  return structuredClone(value);
}

function endpointProof(
  endpointKind,
  scopeKind,
  scopeValue,
  fill
) {
  return {
    endpointKind,
    scopeKind,
    scopeValue,
    httpStatus: 200,
    rowCount: 1,
    responseSha256: fill.repeat(64),
  };
}

function createAuthenticator(overrides = {}) {
  return createSportsDataIoLiveCapabilityAuthenticator({
    capabilitySecret: CAPABILITY_SECRET,
    dedicatedLiveApiKey: DEDICATED_LIVE_API_KEY,
    capabilityKeyVersion: CAPABILITY_KEY_VERSION,
    ...overrides,
  });
}

function evidenceInput(credentialBindingHmacSha256) {
  return {
    domain: SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
    schemaVersion: 1,
    evidenceId:
      "00000000-0000-4000-8000-000000000010",
    status: "passed",
    provider: "sportsdataio-live",
    appEnv: "staging",
    environmentId: "render-staging-service",
    backendBuildId: "build-0123456789abcdef",
    origin: "https://hundo-stage.example",
    configuredNhlSeasonKey: "20252026",
    probeNhlSeasonKey: "20242025",
    probeKind: "historical_offseason",
    probeManifestSha256: "f".repeat(64),
    capabilityKeyVersion: CAPABILITY_KEY_VERSION,
    credentialBindingHmacSha256,
    issuedAtMs: ISSUED_AT_MS,
    expiresAtMs:
      ISSUED_AT_MS +
      SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
    request: {
      requiredPlayers: [
        {
          playerId: PLAYER_ONE,
          providerPlayerId: "101",
        },
        {
          playerId: PLAYER_TWO,
          providerPlayerId: "102",
        },
        {
          playerId: PLAYER_THREE,
          providerPlayerId: "103",
        },
      ],
      requiredPlayerGames: [
        {
          playerId: PLAYER_ONE,
          providerPlayerId: "101",
          providerTeamId: "10",
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_START_MS,
        },
      ],
    },
    capture: {
      capturedAtMs: CAPTURED_AT_MS,
      sourceVersion:
        `sportsdataio-live-sha256-${"9".repeat(64)}`,
      coverage: [
        {
          playerId: PLAYER_ONE,
          providerPlayerId: "101",
          providerTeamId: "10",
          disposition: "expected_game",
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_START_MS,
          observedGameState: "final",
        },
        {
          playerId: PLAYER_TWO,
          providerPlayerId: "102",
          providerTeamId: "20",
          disposition: "no_due_game",
          nhlGameId: null,
          nhlGameScheduledStartsAtMs: null,
          observedGameState: null,
        },
        {
          playerId: PLAYER_THREE,
          providerPlayerId: "103",
          providerTeamId: null,
          disposition: "no_team",
          nhlGameId: null,
          nhlGameScheduledStartsAtMs: null,
          observedGameState: null,
        },
      ],
      observations: [
        {
          externalPlayerId: "101",
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_START_MS,
          observedGameState: "final",
          goals: 0,
          assists: 0,
          nhlPoints: 0,
          fantasyPointsHundredths: 0,
          sourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
        },
      ],
    },
    endpointProofs: [
      endpointProof(
        "free_agents",
        "season",
        "20252026",
        "1"
      ),
      endpointProof(
        "player_game",
        "date",
        "2025-06-14",
        "2"
      ),
      endpointProof(
        "player_game",
        "date",
        "2025-06-15",
        "6"
      ),
      endpointProof(
        "players",
        "season",
        "20252026",
        "3"
      ),
      endpointProof(
        "schedule",
        "date",
        "2025-06-14",
        "4"
      ),
      endpointProof(
        "schedule",
        "date",
        "2025-06-15",
        "7"
      ),
      endpointProof(
        "season_totals",
        "season",
        "20242025",
        "5"
      ),
    ],
    explicitZeroPair: {
      playerId: PLAYER_ONE,
      providerPlayerId: "101",
      providerTeamId: "10",
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_START_MS,
      observedGameState: "final",
      goals: 0,
      assists: 0,
      nhlPoints: 0,
      fantasyPointsHundredths: 0,
      sourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
    },
    omissionProof: {
      kind: SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
      omittedPlayerId: PLAYER_ONE,
      omittedNhlGameId: "9001",
      resultCode:
        SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
    },
    assertions:
      SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS.map(
        (kind) => ({ kind, passed: true })
      ),
  };
}

function expectedBindings(evidence) {
  return {
    appEnv: evidence.appEnv,
    environmentId: evidence.environmentId,
    backendBuildId: evidence.backendBuildId,
    origin: evidence.origin,
    configuredNhlSeasonKey:
      evidence.configuredNhlSeasonKey,
    probeNhlSeasonKey: evidence.probeNhlSeasonKey,
    probeKind: evidence.probeKind,
    probeManifestSha256: evidence.probeManifestSha256,
  };
}

function signedSystem(overrides = {}) {
  const authenticator = createAuthenticator(overrides);
  const evidence = createSportsDataIoLiveCapabilityEvidence(
    evidenceInput(
      authenticator.credentialBindingHmacSha256()
    )
  );
  const artifact = authenticator.createArtifact(evidence);
  return {
    authenticator,
    evidence,
    artifact,
    bindings: expectedBindings(evidence),
  };
}

function assertAuthenticationError(operation) {
  assert.throws(
    operation,
    (error) =>
      error instanceof
        SportsDataIoLiveCapabilityAuthenticationError &&
      error.code ===
        "SPORTSDATAIO_LIVE_CAPABILITY_AUTHENTICATION_INVALID" &&
      error.message ===
        "The SportsDataIO live capability artifact is invalid."
  );
}

function hmac(secret, prefix, value) {
  return crypto
    .createHmac("sha256", secret)
    .update(prefix, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

test("locks independent credential, evidence SHA, and artifact HMAC vectors", () => {
  const { authenticator, artifact } = signedSystem();
  const credentialBinding = hmac(
    CAPABILITY_SECRET,
    SPORTS_DATA_IO_LIVE_CAPABILITY_CREDENTIAL_HMAC_PREFIX,
    DEDICATED_LIVE_API_KEY
  );
  assert.equal(
    authenticator.credentialBindingHmacSha256(),
    credentialBinding
  );
  assert.equal(
    credentialBinding,
    "81f2d1d710d2437a375b757f0047e782aaf7fca0a01210d492e188b334cfe106"
  );
  assert.equal(
    artifact.evidenceSha256,
    "83bb8a9633c0cee5bcb30ebc864eee851ef8722650972edda0f40b79e8a0f2f0"
  );
  assert.equal(
    artifact.evidenceHmacSha256,
    "9978fdb5daaa355d4be3806b96a713e21e4da1f9df754c1105d3261c31501752"
  );
  assert.equal(
    artifact.evidenceHmacSha256,
    hmac(
      CAPABILITY_SECRET,
      SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_HMAC_PREFIX,
      serializeSportsDataIoLiveCapabilityEvidence(
        artifact.evidence
      )
    )
  );
});

test("returns exact closed deeply immutable artifacts and verification receipts", () => {
  const { authenticator, artifact, bindings } = signedSystem();
  const verification = authenticator.verifyArtifact({
    artifact,
    expectedBindings: bindings,
    nowMs: ISSUED_AT_MS,
  });

  assert.deepEqual(Object.keys(artifact), [
    "evidence",
    "evidenceSha256",
    "evidenceHmacSha256",
  ]);
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(artifact.evidence), true);
  assert.deepEqual(Object.keys(verification), [
    "status",
    "evidenceId",
    "evidenceSha256",
    "issuedAtMs",
    "expiresAtMs",
    "verifiedAtMs",
  ]);
  assert.deepEqual(verification, {
    status: "verified",
    evidenceId: artifact.evidence.evidenceId,
    evidenceSha256: artifact.evidenceSha256,
    issuedAtMs: ISSUED_AT_MS,
    expiresAtMs:
      ISSUED_AT_MS +
      SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
    verifiedAtMs: ISSUED_AT_MS,
  });
  assert.equal(Object.isFrozen(verification), true);
});

test("uses an inclusive issue boundary and exclusive 24-hour expiry boundary", () => {
  const { authenticator, artifact, bindings } = signedSystem();
  for (const nowMs of [
    ISSUED_AT_MS,
    artifact.evidence.expiresAtMs - 1,
  ]) {
    assert.equal(
      authenticator.verifyArtifact({
        artifact,
        expectedBindings: bindings,
        nowMs,
      }).status,
      "verified"
    );
  }
  for (const nowMs of [
    ISSUED_AT_MS - 1,
    artifact.evidence.expiresAtMs,
    artifact.evidence.expiresAtMs + 1,
  ]) {
    assertAuthenticationError(() =>
      authenticator.verifyArtifact({
        artifact,
        expectedBindings: bindings,
        nowMs,
      })
    );
  }
});

test("rejects every cross-environment and release binding", () => {
  const { authenticator, artifact, bindings } = signedSystem();
  const mutations = {
    appEnv: "production",
    environmentId: "other-service",
    backendBuildId: "other-build",
    origin: "https://hundo.example",
    configuredNhlSeasonKey: "20262027",
    probeNhlSeasonKey: "20232024",
    probeKind: "current",
    probeManifestSha256: "e".repeat(64),
  };

  for (const [field, value] of Object.entries(mutations)) {
    assertAuthenticationError(() =>
      authenticator.verifyArtifact({
        artifact,
        expectedBindings: {
          ...bindings,
          [field]: value,
        },
        nowMs: ISSUED_AT_MS,
      })
    );
  }
});

test("rejects cross-secret, cross-credential, and cross-key-version artifacts", () => {
  const { artifact, bindings } = signedSystem();
  const authenticators = [
    createAuthenticator({
      capabilitySecret:
        "different-capability-secret-0123456789abcdef-abcdef",
    }),
    createAuthenticator({
      dedicatedLiveApiKey: "different-dedicated-live-key",
    }),
    createAuthenticator({ capabilityKeyVersion: 8 }),
  ];

  for (const authenticator of authenticators) {
    assertAuthenticationError(() =>
      authenticator.verifyArtifact({
        artifact,
        expectedBindings: bindings,
        nowMs: ISSUED_AT_MS,
      })
    );
  }
});

test("rejects payload, SHA, HMAC, and canonical-case tampering", () => {
  const { authenticator, artifact, bindings } = signedSystem();
  const mutations = [
    (value) => { value.evidence.backendBuildId = "tampered-build"; },
    (value) => { value.evidence.capture.sourceVersion += "-tampered"; },
    (value) => { value.evidenceSha256 = "0".repeat(64); },
    (value) => { value.evidenceHmacSha256 = "0".repeat(64); },
    (value) => {
      value.evidenceSha256 = value.evidenceSha256.toUpperCase();
    },
    (value) => { value.evidenceHmacSha256 = "not-a-digest"; },
  ];

  for (const mutate of mutations) {
    const tampered = clone(artifact);
    mutate(tampered);
    assertAuthenticationError(() =>
      authenticator.verifyArtifact({
        artifact: tampered,
        expectedBindings: bindings,
        nowMs: ISSUED_AT_MS,
      })
    );
  }
});

test("rejects open artifact, verification, binding, and nested evidence shapes", () => {
  const { authenticator, artifact, bindings } = signedSystem();
  const openArtifact = clone(artifact);
  openArtifact.rawProviderResponse = "private";
  assertAuthenticationError(() =>
    authenticator.verifyArtifact({
      artifact: openArtifact,
      expectedBindings: bindings,
      nowMs: ISSUED_AT_MS,
    })
  );

  const openEvidence = clone(artifact);
  openEvidence.evidence.request.extra = true;
  assertAuthenticationError(() =>
    authenticator.verifyArtifact({
      artifact: openEvidence,
      expectedBindings: bindings,
      nowMs: ISSUED_AT_MS,
    })
  );

  assertAuthenticationError(() =>
    authenticator.verifyArtifact({
      artifact,
      expectedBindings: { ...bindings, extra: true },
      nowMs: ISSUED_AT_MS,
    })
  );
  assertAuthenticationError(() =>
    authenticator.verifyArtifact({
      artifact,
      expectedBindings: bindings,
      nowMs: ISSUED_AT_MS,
      extra: true,
    })
  );
});

test("performs digest checks with constant-time equal-length decoded bytes", () => {
  let comparisons = 0;
  const timingSafeEqual = (left, right) => {
    comparisons += 1;
    assert.equal(Buffer.isBuffer(left), true);
    assert.equal(Buffer.isBuffer(right), true);
    assert.equal(left.length, 32);
    assert.equal(right.length, 32);
    return crypto.timingSafeEqual(left, right);
  };
  const { authenticator, artifact, bindings } = signedSystem({
    timingSafeEqual,
  });
  comparisons = 0;

  authenticator.verifyArtifact({
    artifact,
    expectedBindings: bindings,
    nowMs: ISSUED_AT_MS,
  });

  assert.equal(comparisons, 3);
});

test("requires an independent bounded secret and dedicated live credential", () => {
  const configurations = [
    {},
    {
      capabilitySecret: "short",
      dedicatedLiveApiKey: DEDICATED_LIVE_API_KEY,
      capabilityKeyVersion: CAPABILITY_KEY_VERSION,
    },
    {
      capabilitySecret: CAPABILITY_SECRET,
      dedicatedLiveApiKey: "",
      capabilityKeyVersion: CAPABILITY_KEY_VERSION,
    },
    {
      capabilitySecret: CAPABILITY_SECRET,
      dedicatedLiveApiKey: CAPABILITY_SECRET,
      capabilityKeyVersion: CAPABILITY_KEY_VERSION,
    },
    {
      capabilitySecret: CAPABILITY_SECRET,
      dedicatedLiveApiKey: DEDICATED_LIVE_API_KEY,
      capabilityKeyVersion: 0,
    },
    {
      capabilitySecret: CAPABILITY_SECRET,
      dedicatedLiveApiKey: DEDICATED_LIVE_API_KEY,
      capabilityKeyVersion: CAPABILITY_KEY_VERSION,
      legacyStagingImportApiKey: "must-not-be-accepted",
    },
  ];

  for (const configuration of configurations) {
    assert.throws(
      () =>
        createSportsDataIoLiveCapabilityAuthenticator(configuration),
      (error) =>
        error instanceof
          SportsDataIoLiveCapabilityAuthenticatorConfigurationError &&
        error.code ===
          "SPORTSDATAIO_LIVE_CAPABILITY_AUTHENTICATOR_CONFIGURATION_INVALID"
    );
  }
});

test("never serializes either secret or a raw provider payload", () => {
  const { authenticator, artifact, bindings } = signedSystem();
  const values = [
    JSON.stringify(authenticator),
    JSON.stringify(artifact),
    JSON.stringify(
      authenticator.verifyArtifact({
        artifact,
        expectedBindings: bindings,
        nowMs: ISSUED_AT_MS,
      })
    ),
  ];

  for (const serialized of values) {
    assert.equal(serialized.includes(CAPABILITY_SECRET), false);
    assert.equal(serialized.includes(DEDICATED_LIVE_API_KEY), false);
    assert.equal(serialized.includes("rawProviderResponse"), false);
    assert.equal(
      serialized.includes("Ocp-Apim-Subscription-Key"),
      false
    );
  }

  let message = "";
  try {
    createAuthenticator({ capabilitySecret: DEDICATED_LIVE_API_KEY });
  } catch (error) {
    message = `${error.name}:${error.code}:${error.message}`;
  }
  assert.equal(message.includes(CAPABILITY_SECRET), false);
  assert.equal(message.includes(DEDICATED_LIVE_API_KEY), false);
});
