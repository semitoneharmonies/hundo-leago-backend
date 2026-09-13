const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROVIDER,
  SPORTS_DATA_IO_LIVE_CAPABILITY_STATUS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
  SportsDataIoLiveCapabilityEvidencePolicyError,
  createSportsDataIoLiveCapabilityEvidence,
  hashSportsDataIoLiveCapabilityEvidence,
  serializeSportsDataIoLiveCapabilityEvidence,
  validateSportsDataIoLiveCapabilityEvidence,
} = require(
  "../../src/domain/statistics/sportsDataIoLiveCapabilityEvidencePolicy"
);

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

function evidenceInput() {
  return {
    domain: SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
    schemaVersion:
      SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    evidenceId:
      "00000000-0000-4000-8000-000000000010",
    status: SPORTS_DATA_IO_LIVE_CAPABILITY_STATUS,
    provider: SPORTS_DATA_IO_LIVE_CAPABILITY_PROVIDER,
    appEnv: "staging",
    environmentId: "render-staging-service",
    backendBuildId: "build-0123456789abcdef",
    origin: "https://hundo-stage.example",
    configuredNhlSeasonKey: "20252026",
    probeNhlSeasonKey: "20242025",
    probeKind: "historical_offseason",
    probeManifestSha256: "f".repeat(64),
    capabilityKeyVersion: 7,
    credentialBindingHmacSha256: "d".repeat(64),
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

function assertPolicyError(operation, reasonCode) {
  assert.throws(
    operation,
    (error) =>
      error instanceof
        SportsDataIoLiveCapabilityEvidencePolicyError &&
      error.code ===
        "SPORTSDATAIO_LIVE_CAPABILITY_EVIDENCE_INVALID" &&
      (
        reasonCode === undefined ||
        error.reasonCode === reasonCode
      )
  );
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

test("normalizes the exact closed evidence shape and deep-freezes every child", () => {
  const input = evidenceInput();
  input.request.requiredPlayers.reverse();
  input.endpointProofs.reverse();
  input.assertions.reverse();

  const evidence = createSportsDataIoLiveCapabilityEvidence(input);

  assert.deepEqual(
    evidence.request.requiredPlayers.map((row) => row.playerId),
    [PLAYER_ONE, PLAYER_TWO, PLAYER_THREE]
  );
  assert.deepEqual(
    evidence.endpointProofs.map((row) => row.endpointKind),
    [
      "free_agents",
      "player_game",
      "player_game",
      "players",
      "schedule",
      "schedule",
      "season_totals",
    ]
  );
  assert.deepEqual(
    evidence.assertions.map((row) => row.kind),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS
  );
  assertDeepFrozen(evidence);
  assert.deepEqual(
    Object.keys(evidence),
    [
      "domain",
      "schemaVersion",
      "evidenceId",
      "status",
      "provider",
      "appEnv",
      "environmentId",
      "backendBuildId",
      "origin",
      "configuredNhlSeasonKey",
      "probeNhlSeasonKey",
      "probeKind",
      "probeManifestSha256",
      "capabilityKeyVersion",
      "credentialBindingHmacSha256",
      "issuedAtMs",
      "expiresAtMs",
      "request",
      "capture",
      "endpointProofs",
      "explicitZeroPair",
      "omissionProof",
      "assertions",
    ]
  );
});

test("locks canonical-json-v1 serialization and an independent SHA-256 vector", () => {
  const evidence = createSportsDataIoLiveCapabilityEvidence(
    evidenceInput()
  );
  const serialized =
    serializeSportsDataIoLiveCapabilityEvidence(evidence);
  const expectedFromNode = crypto
    .createHash("sha256")
    .update(serialized, "utf8")
    .digest("hex");

  assert.equal(
    hashSportsDataIoLiveCapabilityEvidence(evidence),
    expectedFromNode
  );
  assert.equal(
    expectedFromNode,
    "eb8779f69e4caebc1b2002662d9dd42e01715a16301c011fe253c5b8e7ce0241"
  );
  assert.equal(serialized.endsWith("\n"), false);
});

test("accepts scalar Unicode exactly and rejects ill-formed Unicode", () => {
  const input = evidenceInput();
  input.environmentId = "render-🏒-\ue000-\u{10000}";
  const evidence = createSportsDataIoLiveCapabilityEvidence(input);
  assert.match(
    serializeSportsDataIoLiveCapabilityEvidence(evidence),
    /render-🏒-/u
  );

  const invalid = evidenceInput();
  invalid.backendBuildId = "build-\ud800";
  assertPolicyError(
    () => createSportsDataIoLiveCapabilityEvidence(invalid),
    "backend_build_id_invalid"
  );
});

test("rejects extra fields at every evidence layer", () => {
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.request.extra = true; },
    (value) => { value.request.requiredPlayers[0].extra = true; },
    (value) => { value.request.requiredPlayerGames[0].extra = true; },
    (value) => { value.capture.extra = true; },
    (value) => { value.capture.coverage[0].extra = true; },
    (value) => { value.capture.observations[0].extra = true; },
    (value) => { value.endpointProofs[0].extra = true; },
    (value) => { value.explicitZeroPair.extra = true; },
    (value) => { value.omissionProof.extra = true; },
    (value) => { value.assertions[0].extra = true; },
  ];

  for (const mutate of mutations) {
    const input = evidenceInput();
    mutate(input);
    assertPolicyError(
      () => createSportsDataIoLiveCapabilityEvidence(input)
    );
  }
});

test("rejects malformed fixed-envelope values and noncanonical origins", () => {
  const mutations = [
    (value) => { value.domain = "attacker.example"; },
    (value) => { value.schemaVersion = 2; },
    (value) => { value.status = "failed"; },
    (value) => { value.provider = "legacy"; },
    (value) => { value.probeKind = "offseason"; },
    (value) => {
      value.evidenceId =
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    },
    (value) => { value.origin = "https://hundo-stage.example/path"; },
    (value) => { value.origin = "https://user@example.com"; },
    (value) => { value.probeManifestSha256 = "F".repeat(64); },
    (value) => { value.capabilityKeyVersion = 0; },
  ];

  for (const mutate of mutations) {
    const input = evidenceInput();
    mutate(input);
    assertPolicyError(
      () => createSportsDataIoLiveCapabilityEvidence(input)
    );
  }
});

test("enforces the exact 24-hour interval and coherent capture times", () => {
  for (const expiresAtMs of [
    ISSUED_AT_MS,
    ISSUED_AT_MS + SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS - 1,
    ISSUED_AT_MS + SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS + 1,
  ]) {
    const input = evidenceInput();
    input.expiresAtMs = expiresAtMs;
    assertPolicyError(
      () => createSportsDataIoLiveCapabilityEvidence(input),
      "validity_window_invalid"
    );
  }

  const futureCapture = evidenceInput();
  futureCapture.capture.capturedAtMs = ISSUED_AT_MS + 1;
  assertPolicyError(
    () => createSportsDataIoLiveCapabilityEvidence(futureCapture),
    "capture_time_invalid"
  );

  const futureSource = evidenceInput();
  futureSource.capture.observations[0].sourceUpdatedAtMs =
    CAPTURED_AT_MS + 1;
  futureSource.explicitZeroPair.sourceUpdatedAtMs =
    CAPTURED_AT_MS + 1;
  assertPolicyError(
    () => createSportsDataIoLiveCapabilityEvidence(futureSource),
    "observation_source_time_invalid"
  );
});

test("rejects duplicate request, coverage, observation, endpoint, and assertion identities", () => {
  const mutations = [
    (value) => {
      value.request.requiredPlayers[1].playerId = PLAYER_ONE;
    },
    (value) => {
      value.request.requiredPlayers[1].providerPlayerId = "101";
    },
    (value) => {
      value.request.requiredPlayerGames.push(
        clone(value.request.requiredPlayerGames[0])
      );
    },
    (value) => {
      value.capture.coverage.push(clone(value.capture.coverage[0]));
    },
    (value) => {
      value.capture.observations.push(
        clone(value.capture.observations[0])
      );
    },
    (value) => {
      value.endpointProofs.push(clone(value.endpointProofs[0]));
    },
    (value) => {
      value.assertions[1] = clone(value.assertions[0]);
    },
  ];

  for (const mutate of mutations) {
    const input = evidenceInput();
    mutate(input);
    assertPolicyError(
      () => createSportsDataIoLiveCapabilityEvidence(input)
    );
  }
});

test("requires exact historical coverage and exact coverage-observation equality", () => {
  const mutations = [
    (value) => { value.capture.coverage[0].providerTeamId = "11"; },
    (value) => {
      value.capture.coverage[0].nhlGameScheduledStartsAtMs += 1;
    },
    (value) => { value.capture.observations = []; },
    (value) => { value.capture.observations[0].nhlGameId = "9002"; },
    (value) => { value.capture.observations[0].observedGameState = "scheduled"; },
    (value) => { value.capture.coverage[1].disposition = "no_team"; },
    (value) => { value.capture.coverage[2].disposition = "no_due_game"; },
  ];

  for (const mutate of mutations) {
    const input = evidenceInput();
    mutate(input);
    assertPolicyError(
      () => createSportsDataIoLiveCapabilityEvidence(input)
    );
  }
});

test("requires one exact final zero pair and its controlled incomplete replay", () => {
  const mutations = [
    (value) => { value.explicitZeroPair.goals = 1; },
    (value) => { value.explicitZeroPair.observedGameState = "scheduled"; },
    (value) => { value.explicitZeroPair.providerTeamId = "11"; },
    (value) => { value.omissionProof.kind = "different"; },
    (value) => { value.omissionProof.omittedNhlGameId = "9002"; },
    (value) => { value.omissionProof.resultCode = "RESPONSE_INVALID"; },
  ];

  for (const mutate of mutations) {
    const input = evidenceInput();
    mutate(input);
    assertPolicyError(
      () => createSportsDataIoLiveCapabilityEvidence(input)
    );
  }
});

test("requires the exact successful endpoint-proof set with coherent scopes", () => {
  const mutations = [
    (value) => { value.endpointProofs.pop(); },
    (value) => { value.endpointProofs[0].httpStatus = 500; },
    (value) => { value.endpointProofs[0].rowCount = 0; },
    (value) => { value.endpointProofs[0].scopeKind = "date"; },
    (value) => { value.endpointProofs[0].scopeValue = "20242025"; },
    (value) => { value.endpointProofs[1].scopeValue = "2025-04-02"; },
    (value) => { value.endpointProofs[2].responseSha256 = "A".repeat(64); },
  ];

  for (const mutate of mutations) {
    const input = evidenceInput();
    mutate(input);
    assertPolicyError(
      () => createSportsDataIoLiveCapabilityEvidence(input)
    );
  }
});

test("allows empty offseason current-date feeds but requires historical target rows", () => {
  const input = evidenceInput();
  for (const proof of input.endpointProofs) {
    if (
      ["schedule", "player_game"].includes(proof.endpointKind) &&
      proof.scopeValue === "2025-06-15"
    ) {
      proof.rowCount = 0;
    }
  }
  assert.doesNotThrow(() =>
    createSportsDataIoLiveCapabilityEvidence(input)
  );

  for (const endpointKind of ["schedule", "player_game"]) {
    const missingHistorical = evidenceInput();
    missingHistorical.endpointProofs.find(
      (proof) =>
        proof.endpointKind === endpointKind &&
        proof.scopeValue === "2025-06-14"
    ).rowCount = 0;
    assertPolicyError(
      () =>
        createSportsDataIoLiveCapabilityEvidence(
          missingHistorical
        ),
      "endpoint_row_count_invalid"
    );
  }
});

test("requires the complete true assertion set", () => {
  for (const mutate of [
    (value) => { value.assertions.pop(); },
    (value) => { value.assertions[0].kind = "unapproved"; },
    (value) => { value.assertions[0].passed = false; },
  ]) {
    const input = evidenceInput();
    mutate(input);
    assertPolicyError(
      () => createSportsDataIoLiveCapabilityEvidence(input)
    );
  }
});

test("enforces previous-season and current-probe season relationships", () => {
  const stale = evidenceInput();
  stale.probeNhlSeasonKey = "20232024";
  stale.endpointProofs.find(
    (proof) => proof.endpointKind === "season_totals"
  ).scopeValue = "20232024";
  assertPolicyError(
    () => createSportsDataIoLiveCapabilityEvidence(stale),
    "probe_season_mismatch"
  );

  const current = evidenceInput();
  current.probeKind = "current";
  current.probeNhlSeasonKey = "20252026";
  current.endpointProofs.find(
    (proof) => proof.endpointKind === "season_totals"
  ).scopeValue = "20252026";
  assert.equal(
    createSportsDataIoLiveCapabilityEvidence(current).probeKind,
    "current"
  );
});

test("validator rejects non-normalized array order and normalized type coercion", () => {
  const reversed = evidenceInput();
  reversed.endpointProofs.reverse();
  assertPolicyError(
    () => validateSportsDataIoLiveCapabilityEvidence(reversed),
    "evidence_not_normalized"
  );
  assert.doesNotThrow(() =>
    validateSportsDataIoLiveCapabilityEvidence(
      createSportsDataIoLiveCapabilityEvidence(reversed)
    )
  );

  const numericProviderId = evidenceInput();
  numericProviderId.request.requiredPlayers[0].providerPlayerId = 101;
  assertPolicyError(
    () =>
      validateSportsDataIoLiveCapabilityEvidence(numericProviderId),
    "evidence_not_normalized"
  );
});

test("serialized evidence contains only the sanitized closed contract", () => {
  const serialized = serializeSportsDataIoLiveCapabilityEvidence(
    createSportsDataIoLiveCapabilityEvidence(evidenceInput())
  );

  for (const forbidden of [
    "Ocp-Apim-Subscription-Key",
    "dedicated-live-api-key",
    "capability-secret",
    "rawResponse",
    "responseBody",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(
    Object.keys(JSON.parse(serialized)).sort(),
    Object.keys(evidenceInput()).sort()
  );
});
