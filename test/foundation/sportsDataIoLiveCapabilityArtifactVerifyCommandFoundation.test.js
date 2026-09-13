const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES,
  createReadOnlyFsModule,
  main,
  parseArguments,
  runSportsDataIoLiveCapabilityArtifactVerifyCommand,
} = require(
  "../../scripts/verify-sportsdataio-live-capability-artifact"
);
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
  createSportsDataIoLiveCapabilityEvidence,
} = require(
  "../../src/domain/statistics/sportsDataIoLiveCapabilityEvidencePolicy"
);
const {
  createSportsDataIoLiveCapabilityAuthenticator,
} = require(
  "../../src/infrastructure/security/createSportsDataIoLiveCapabilityAuthenticator"
);
const {
  createSportsDataIoLiveCapabilityArtifact,
} = require(
  "../../src/infrastructure/statistics/SportsDataIoLiveCapabilityArtifact"
);
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
  hashSportsDataIoLiveCapabilityProbeManifest,
} = require(
  "../../src/operations/statistics/createSportsDataIoLiveCapabilityCheck"
);
const {
  resolveSportsDataIoLiveProbeManifestPath,
} = require("../../src/config/loadTargetRuntimeConfig");

const ROOT = path.resolve(__dirname, "..", "..");
const CANONICAL_MANIFEST_PATH =
  resolveSportsDataIoLiveProbeManifestPath(ROOT);
const CAPABILITY_SECRET =
  "verify-command-capability-secret-0123456789abcdef";
const DEDICATED_LIVE_API_KEY =
  "verify-command-dedicated-live-api-key-123456";
const RAW_ARTIFACT_MARKER =
  "raw-artifact-must-never-be-printed";
const ISSUED_AT_MS = 1_750_000_000_000;
const NOW_MS = ISSUED_AT_MS + 1_000;
const CAPTURED_AT_MS = ISSUED_AT_MS - 10_000;
const GAME_START_MS = ISSUED_AT_MS - 86_400_000;
const SOURCE_UPDATED_AT_MS = CAPTURED_AT_MS - 1_000;
const PLAYER_ONE =
  "00000000-0000-4000-8000-000000000001";
const PLAYER_TWO =
  "00000000-0000-4000-8000-000000000002";
const PLAYER_THREE =
  "00000000-0000-4000-8000-000000000003";

function probeManifest() {
  return {
    domain:
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
    schemaVersion:
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
    probeKind: "historical_offseason",
    configuredNhlSeasonKey: "20252026",
    probeNhlSeasonKey: "20242025",
    players: [
      {
        playerId: PLAYER_ONE,
        providerPlayerId: "101",
        expectedDisposition: "expected_game",
      },
      {
        playerId: PLAYER_TWO,
        providerPlayerId: "102",
        expectedDisposition: "no_due_game",
      },
      {
        playerId: PLAYER_THREE,
        providerPlayerId: "103",
        expectedDisposition: "no_team",
      },
    ],
    historicalZeroGame: {
      playerId: PLAYER_ONE,
      providerPlayerId: "101",
      providerTeamId: "10",
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_START_MS,
    },
  };
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

function evidenceInput({
  credentialBindingHmacSha256,
  probeManifestSha256,
}) {
  const sourceHash = crypto
    .createHash("sha256")
    .update(RAW_ARTIFACT_MARKER, "utf8")
    .digest("hex");
  return {
    domain: SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
    schemaVersion: 1,
    evidenceId:
      "00000000-0000-4000-8000-000000000101",
    status: "passed",
    provider: "sportsdataio-live",
    appEnv: "staging",
    environmentId: "render-staging-service",
    backendBuildId: "build-0123456789abcdef",
    origin: "https://api.sportsdata.io",
    configuredNhlSeasonKey: "20252026",
    probeNhlSeasonKey: "20242025",
    probeKind: "historical_offseason",
    probeManifestSha256,
    capabilityKeyVersion: 7,
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
        `sportsdataio-live-sha256-${sourceHash}`,
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

function environment(fixture, overrides = {}) {
  return {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_BUILD_ID: "build-0123456789abcdef",
    APP_ENVIRONMENT_ID: "render-staging-service",
    DATABASE_ID: "render-staging-database",
    FRONTEND_BUILD_ID: "frontend-0123456789abcdef",
    PORT: "4000",
    DATABASE_PATH: fixture.databasePath,
    PERSISTENT_DATA_ROOT: fixture.persistentRoot,
    CURRENT_SEASON_LABEL: "2025",
    CURRENT_NHL_SEASON_KEY: "20252026",
    SPORTSDATAIO_NHL_LIVE_MODE: "required",
    SPORTSDATAIO_NHL_LIVE_API_KEY:
      DEDICATED_LIVE_API_KEY,
    SPORTSDATAIO_NHL_LIVE_API_ORIGIN:
      "https://api.sportsdata.io",
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET:
      CAPABILITY_SECRET,
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION: "7",
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT:
      fixture.artifactPath,
    STAGING_MAINTENANCE_HOLD: "false",
    PUBLIC_FRONTEND_ORIGIN:
      "https://staging.hundoleago.com",
    FRONTEND_ORIGINS:
      "https://staging.hundoleago.com",
    LOG_LEVEL: "info",
    SESSION_COOKIE_SAME_SITE: "lax",
    ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
    SCHEDULED_JOBS_ENABLED: "false",
    FREE_AGENT_DRAFT_ROUTES_ENABLED: "false",
    LEAGUE_WRITE_MODE: "closed",
    DEBUG_ROUTES_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "capture",
    BACKUP_SCHEDULE_ENABLED: "false",
    RATE_LIMIT_KEY_SECRET:
      "verify-command-rate-limit-secret-0123456789",
    AUDIT_METADATA_SECRET:
      "verify-command-audit-secret-9876543210",
    ACTION_TOKEN_DELIVERY_KEY:
      Buffer.alloc(32, 0x47).toString("base64url"),
    ...overrides,
  };
}

function fixture(t) {
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-live-verify-command-")
  );
  t.after(() => {
    fs.rmSync(persistentRoot, {
      recursive: true,
      force: true,
    });
  });
  const artifactPath = path.join(
    persistentRoot,
    "provider-capability",
    "sportsdataio-live-v1.json"
  );
  const databasePath = path.join(
    persistentRoot,
    "sqlite",
    "must-not-be-opened.sqlite3"
  );
  const manifest = probeManifest();
  const authenticator =
    createSportsDataIoLiveCapabilityAuthenticator({
      capabilitySecret: CAPABILITY_SECRET,
      dedicatedLiveApiKey: DEDICATED_LIVE_API_KEY,
      capabilityKeyVersion: 7,
    });
  const evidence = createSportsDataIoLiveCapabilityEvidence(
    evidenceInput({
      credentialBindingHmacSha256:
        authenticator.credentialBindingHmacSha256(),
      probeManifestSha256:
        hashSportsDataIoLiveCapabilityProbeManifest(
          manifest
        ),
    })
  );
  const artifact = authenticator.createArtifact(evidence);
  const store = createSportsDataIoLiveCapabilityArtifact({
    persistentRoot,
    artifactPath,
    authenticator,
  });
  store.publish({
    artifact,
    expectedBindings: expectedBindings(evidence),
    nowMs: NOW_MS,
  });
  return {
    persistentRoot,
    artifactPath,
    databasePath,
    manifest,
    evidence,
  };
}

function instrumentedFs(manifest) {
  const fsModule = Object.create(fs);
  const state = {
    manifestReads: 0,
    delegatedWrites: 0,
  };
  Object.defineProperty(fsModule, "readFileSync", {
    configurable: true,
    enumerable: true,
    value(filePath, ...args) {
      if (filePath === CANONICAL_MANIFEST_PATH) {
        state.manifestReads += 1;
        return Buffer.from(JSON.stringify(manifest), "utf8");
      }
      return fs.readFileSync(filePath, ...args);
    },
    writable: true,
  });
  for (const method of [
    "fsyncSync",
    "linkSync",
    "mkdirSync",
    "renameSync",
    "unlinkSync",
    "writeFileSync",
  ]) {
    Object.defineProperty(fsModule, method, {
      configurable: true,
      enumerable: true,
      value() {
        state.delegatedWrites += 1;
        throw new Error("write reached delegated filesystem");
      },
      writable: true,
    });
  }
  return { fsModule, state };
}

function capturedOutput() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    output: {
      log(value) {
        stdout.push(value);
      },
      error(value) {
        stderr.push(value);
      },
    },
  };
}

function assertCommandError(operation, field) {
  assert.throws(operation, {
    code:
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES[
        field
      ],
    message:
      "The SportsDataIO live capability verification command failed safely.",
  });
}

describe("SportsDataIO live capability read-only verifier CLI", () => {
  test("verifies the exact deployed bindings, emits one sanitized receipt, and leaves artifact and database bytes untouched", (t) => {
    const runtime = fixture(t);
    const harness = instrumentedFs(runtime.manifest);
    const captured = capturedOutput();
    const before = fs.readFileSync(runtime.artifactPath);
    const beforeStat = fs.statSync(runtime.artifactPath);
    let networkCalls = 0;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = () => {
      networkCalls += 1;
      throw new Error("network access is forbidden");
    };
    t.after(() => {
      globalThis.fetch = priorFetch;
    });

    const receipt =
      runSportsDataIoLiveCapabilityArtifactVerifyCommand({
        argv: [],
        env: environment(runtime),
        output: captured.output,
        fsModule: harness.fsModule,
        now: () => NOW_MS,
      });

    assert.equal(receipt.status, "verified");
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(receipt.appEnv, "staging");
    assert.equal(
      receipt.environmentId,
      "render-staging-service"
    );
    assert.equal(
      receipt.backendBuildId,
      "build-0123456789abcdef"
    );
    assert.equal(receipt.capabilityKeyVersion, 7);
    assert.equal(receipt.evidenceId, runtime.evidence.evidenceId);
    assert.equal(captured.stdout.length, 1);
    assert.deepEqual(JSON.parse(captured.stdout[0]), receipt);
    assert.deepEqual(captured.stderr, []);
    assert.equal(harness.state.manifestReads, 1);
    assert.equal(harness.state.delegatedWrites, 0);
    assert.equal(networkCalls, 0);
    assert.equal(fs.existsSync(runtime.databasePath), false);
    assert.deepEqual(fs.readFileSync(runtime.artifactPath), before);
    const afterStat = fs.statSync(runtime.artifactPath);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    for (const forbidden of [
      CAPABILITY_SECRET,
      DEDICATED_LIVE_API_KEY,
      RAW_ARTIFACT_MARKER,
      runtime.artifactPath,
      "artifactPath",
      "artifact",
    ]) {
      assert.equal(captured.stdout[0].includes(forbidden), false);
    }
  });

  test("fails closed for expiry and exact key, secret, key-version, and build mismatches without output", (t) => {
    const runtime = fixture(t);
    const cases = [
      {
        label: "expired",
        overrides: {},
        now:
          ISSUED_AT_MS +
          SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
      },
      {
        label: "provider-key",
        overrides: {
          SPORTSDATAIO_NHL_LIVE_API_KEY:
            "different-dedicated-live-provider-key-987654",
        },
        now: NOW_MS,
      },
      {
        label: "capability-secret",
        overrides: {
          SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET:
            "different-capability-secret-9876543210abcdef",
        },
        now: NOW_MS,
      },
      {
        label: "key-version",
        overrides: {
          SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION: "8",
        },
        now: NOW_MS,
      },
      {
        label: "build",
        overrides: {
          APP_BUILD_ID: "different-build-abcdef0123456789",
        },
        now: NOW_MS,
      },
    ];
    for (const scenario of cases) {
      const harness = instrumentedFs(runtime.manifest);
      const captured = capturedOutput();
      assertCommandError(
        () =>
          runSportsDataIoLiveCapabilityArtifactVerifyCommand({
            argv: [],
            env: environment(runtime, scenario.overrides),
            output: captured.output,
            fsModule: harness.fsModule,
            now: () => scenario.now,
          }),
        "verificationFailed"
      );
      assert.deepEqual(
        captured.stdout,
        [],
        scenario.label
      );
      assert.equal(
        harness.state.delegatedWrites,
        0,
        scenario.label
      );
    }
  });

  test("fails closed for tampered and missing artifacts and reports no secret or raw bytes", (t) => {
    const runtime = fixture(t);
    const original = fs.readFileSync(runtime.artifactPath);
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0] === 0x7b ? 0x5b : 0x7b;
    fs.writeFileSync(runtime.artifactPath, tampered);
    const captured = capturedOutput();
    main({
      command: ({ output }) =>
        runSportsDataIoLiveCapabilityArtifactVerifyCommand({
          argv: [],
          env: environment(runtime),
          output,
          fsModule: instrumentedFs(runtime.manifest).fsModule,
          now: () => NOW_MS,
        }),
      output: captured.output,
      processObject: {},
    });
    assert.deepEqual(captured.stdout, []);
    assert.equal(captured.stderr.length, 1);
    assert.deepEqual(JSON.parse(captured.stderr[0]), {
      error: {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
            .verificationFailed,
        message:
          "The SportsDataIO live capability verification command failed safely.",
      },
    });
    for (const forbidden of [
      CAPABILITY_SECRET,
      DEDICATED_LIVE_API_KEY,
      RAW_ARTIFACT_MARKER,
      original.toString("utf8"),
    ]) {
      assert.equal(captured.stderr[0].includes(forbidden), false);
    }

    fs.writeFileSync(runtime.artifactPath, original);
    const missingPath = `${runtime.artifactPath}.held`;
    fs.renameSync(runtime.artifactPath, missingPath);
    try {
      assertCommandError(
        () =>
          runSportsDataIoLiveCapabilityArtifactVerifyCommand({
            argv: [],
            env: environment(runtime),
            output: capturedOutput().output,
            fsModule: instrumentedFs(runtime.manifest).fsModule,
            now: () => NOW_MS,
          }),
        "verificationFailed"
      );
    } finally {
      fs.renameSync(missingPath, runtime.artifactPath);
    }
  });

  test("requires the exact quiesced transition boundary before reading the artifact", (t) => {
    const runtime = fixture(t);
    const cases = [
      { APP_ENV: "production" },
      { NODE_ENV: "development" },
      { STAGING_MAINTENANCE_HOLD: "true" },
      { LEAGUE_WRITE_MODE: "open" },
      { SCHEDULED_JOBS_ENABLED: "true" },
      { FREE_AGENT_DRAFT_ROUTES_ENABLED: "true" },
      { ACCOUNT_EMAIL_DELIVERY_ENABLED: "true" },
      { DEBUG_ROUTES_ENABLED: "true" },
      { EMAIL_DELIVERY_MODE: "allowlist" },
      { BACKUP_SCHEDULE_ENABLED: "true" },
    ];
    for (const overrides of cases) {
      const harness = instrumentedFs(runtime.manifest);
      const captured = capturedOutput();
      assertCommandError(
        () =>
          runSportsDataIoLiveCapabilityArtifactVerifyCommand({
            argv: [],
            env: environment(runtime, overrides),
            output: captured.output,
            fsModule: harness.fsModule,
            now: () => NOW_MS,
          }),
        "configurationInvalid"
      );
      assert.equal(harness.state.manifestReads, 0);
      assert.equal(harness.state.delegatedWrites, 0);
      assert.deepEqual(captured.stdout, []);
      assert.deepEqual(captured.stderr, []);
    }
  });

  test("rejects symlink or reparse artifact paths and unsafe or operator-overridden locations", (t) => {
    const runtime = fixture(t);
    const heldPath = `${runtime.artifactPath}.held`;
    fs.renameSync(runtime.artifactPath, heldPath);
    let symlinkCreated = false;
    try {
      fs.symlinkSync(heldPath, runtime.artifactPath, "file");
      symlinkCreated = true;
      assertCommandError(
        () =>
          runSportsDataIoLiveCapabilityArtifactVerifyCommand({
            argv: [],
            env: environment(runtime),
            output: capturedOutput().output,
            fsModule: instrumentedFs(runtime.manifest).fsModule,
            now: () => NOW_MS,
          }),
        "verificationFailed"
      );
    } catch (error) {
      if (!symlinkCreated && error?.code === "EPERM") {
        t.diagnostic(
          "file-symlink assertion unavailable without Windows symlink privilege"
        );
      } else {
        throw error;
      }
    } finally {
      if (symlinkCreated) fs.unlinkSync(runtime.artifactPath);
      fs.renameSync(heldPath, runtime.artifactPath);
    }

    const junctionHost = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-live-verify-reparse-")
    );
    t.after(() => {
      fs.rmSync(junctionHost, {
        recursive: true,
        force: true,
      });
    });
    const junctionRoot = path.join(
      junctionHost,
      "persistent-link"
    );
    let junctionCreated = false;
    try {
      fs.symlinkSync(
        runtime.persistentRoot,
        junctionRoot,
        process.platform === "win32" ? "junction" : "dir"
      );
      junctionCreated = true;
      const junctionRuntime = {
        ...runtime,
        persistentRoot: junctionRoot,
        artifactPath: path.join(
          junctionRoot,
          path.relative(
            runtime.persistentRoot,
            runtime.artifactPath
          )
        ),
        databasePath: path.join(
          junctionRoot,
          "sqlite",
          "must-not-be-opened.sqlite3"
        ),
      };
      assertCommandError(
        () =>
          runSportsDataIoLiveCapabilityArtifactVerifyCommand({
            argv: [],
            env: environment(junctionRuntime),
            output: capturedOutput().output,
            fsModule: instrumentedFs(runtime.manifest).fsModule,
            now: () => NOW_MS,
          }),
        "verificationFailed"
      );
    } catch (error) {
      if (!junctionCreated && error?.code === "EPERM") {
        t.diagnostic(
          "directory-reparse assertion unavailable without link privilege"
        );
      } else {
        throw error;
      }
    } finally {
      if (junctionCreated) fs.unlinkSync(junctionRoot);
    }

    for (const overrides of [
      {
        SPORTSDATAIO_NHL_LIVE_MODE: "probe",
      },
      {
        SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT:
          path.join(
            path.dirname(runtime.persistentRoot),
            "escaped-capability-artifact.json"
          ),
      },
      {
        SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST:
          path.join(runtime.persistentRoot, "operator.json"),
      },
    ]) {
      assertCommandError(
        () =>
          runSportsDataIoLiveCapabilityArtifactVerifyCommand({
            argv: [],
            env: environment(runtime, overrides),
            output: capturedOutput().output,
            fsModule: instrumentedFs(runtime.manifest).fsModule,
            now: () => NOW_MS,
          }),
        "configurationInvalid"
      );
    }
  });

  test("accepts no arguments and a read-only filesystem cannot delegate writes", (t) => {
    const runtime = fixture(t);
    let reads = 0;
    let writes = 0;
    const fsModule = Object.create(fs);
    Object.defineProperty(fsModule, "readFileSync", {
      configurable: true,
      value(...args) {
        reads += 1;
        return fs.readFileSync(...args);
      },
    });
    Object.defineProperty(fsModule, "writeFileSync", {
      configurable: true,
      value() {
        writes += 1;
      },
    });
    const readOnly = createReadOnlyFsModule(fsModule);
    assert.deepEqual(parseArguments([]), {});
    assert.equal(Object.isFrozen(parseArguments([])), true);
    assertCommandError(
      () => parseArguments(["--artifact", runtime.artifactPath]),
      "argumentInvalid"
    );
    const harness = instrumentedFs(runtime.manifest);
    assertCommandError(
      () =>
        runSportsDataIoLiveCapabilityArtifactVerifyCommand({
          argv: ["--artifact", runtime.artifactPath],
          env: environment(runtime),
          output: capturedOutput().output,
          fsModule: harness.fsModule,
          now: () => NOW_MS,
        }),
      "argumentInvalid"
    );
    assert.equal(harness.state.manifestReads, 0);
    assertCommandError(
      () => readOnly.writeFileSync(runtime.artifactPath, "changed"),
      "verificationFailed"
    );
    assertCommandError(
      () =>
        readOnly.openSync(
          runtime.artifactPath,
          fs.constants.O_WRONLY
        ),
      "verificationFailed"
    );
    assert.deepEqual(
      readOnly.readFileSync(runtime.artifactPath),
      fs.readFileSync(runtime.artifactPath)
    );
    assert.equal(reads, 1);
    assert.equal(writes, 0);
  });
});
