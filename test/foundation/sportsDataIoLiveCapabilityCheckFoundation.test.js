const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES,
  exitCodeForError,
  main,
  parseArguments,
  readConfiguration,
  runSportsDataIoLiveCapabilityCheckCommand,
} = require(
  "../../scripts/check-sportsdataio-live-capability"
);
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
  createSportsDataIoLiveCapabilityCheck,
  hashSportsDataIoLiveCapabilityProbeManifest,
  normalizeSportsDataIoLiveCapabilityProbeManifest,
  readBoundedResponseBytes,
} = require(
  "../../src/operations/statistics/createSportsDataIoLiveCapabilityCheck"
);
const {
  resolveSportsDataIoLiveProbeManifestPath,
} = require("../../src/config/loadTargetRuntimeConfig");

const NOW_MS = Date.parse("2026-08-01T12:00:00.000Z");
const HISTORICAL_GAME_START_MS = Date.parse(
  "2026-03-15T23:00:00.000Z"
);
const CAPABILITY_SECRET =
  "capability-operation-secret-0123456789abcdef-0123456789";
const DEDICATED_LIVE_API_KEY =
  "dedicated-live-provider-key-do-not-disclose";
const RAW_PAYLOAD_MARKER =
  "raw-provider-payload-marker-do-not-retain";
const ORIGIN = "https://api.sportsdata.io";
const CONFIGURED_SEASON = "20262027";
const PROBE_SEASON = "20252026";
const CANONICAL_PROBE_MANIFEST_PATH =
  resolveSportsDataIoLiveProbeManifestPath(
    path.resolve(__dirname, "..", "..")
  );

function id(value) {
  return (
    "60000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function manifest() {
  return {
    domain:
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
    schemaVersion:
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
    probeKind: "historical_offseason",
    configuredNhlSeasonKey: CONFIGURED_SEASON,
    probeNhlSeasonKey: PROBE_SEASON,
    players: [
      {
        playerId: id(1),
        providerPlayerId: "101",
        expectedDisposition: "expected_game",
      },
      {
        playerId: id(2),
        providerPlayerId: "102",
        expectedDisposition: "no_due_game",
      },
      {
        playerId: id(3),
        providerPlayerId: "103",
        expectedDisposition: "no_team",
      },
    ],
    historicalZeroGame: {
      playerId: id(1),
      providerPlayerId: "101",
      providerTeamId: "10",
      nhlGameId: "8001",
      nhlGameScheduledStartsAtMs:
        HISTORICAL_GAME_START_MS,
    },
  };
}

function totalsRows() {
  return Array.from({ length: 700 }, (_, index) => ({
    PlayerID: index + 1,
    Season: 2026,
    SeasonType: 1,
    Games: 0,
    Goals: 0,
    Assists: 0,
    RawPayloadMarker: RAW_PAYLOAD_MARKER,
  }));
}

function historicalGameRow() {
  return {
    GameID: 8001,
    Season: 2026,
    SeasonType: 1,
    Status: "Final",
    DateTimeUTC: "2026-03-15T23:00:00",
    HomeTeamID: 10,
    AwayTeamID: 30,
    RawPayloadMarker: RAW_PAYLOAD_MARKER,
  };
}

function historicalZeroRow() {
  return {
    PlayerID: 101,
    TeamID: 10,
    GameID: 8001,
    Season: 2026,
    SeasonType: 1,
    Games: 0,
    Goals: 0,
    Assists: 0,
    Updated: "2026-03-15T19:30:00",
    RawPayloadMarker: RAW_PAYLOAD_MARKER,
  };
}

function providerFixture({
  omitHistoricalZero = false,
  providerStatus = 200,
} = {}) {
  const requests = [];
  const responseBytes = new Map();
  async function fetchImpl(url, options) {
    requests.push(url);
    assert.equal(
      options.headers["Ocp-Apim-Subscription-Key"],
      DEDICATED_LIVE_API_KEY
    );
    let rows;
    if (url.endsWith("/scores/json/Players")) {
      rows = [
        {
          PlayerID: 101,
          TeamID: 10,
          RawPayloadMarker: RAW_PAYLOAD_MARKER,
        },
        {
          PlayerID: 102,
          TeamID: 20,
          RawPayloadMarker: RAW_PAYLOAD_MARKER,
        },
        {
          PlayerID: 999,
          TeamID: 40,
          RawPayloadMarker: RAW_PAYLOAD_MARKER,
        },
      ];
    } else if (url.endsWith("/scores/json/FreeAgents")) {
      rows = [{
        PlayerID: 103,
        TeamID: null,
        RawPayloadMarker: RAW_PAYLOAD_MARKER,
      }];
    } else if (url.includes("/PlayerSeasonStats/")) {
      rows = totalsRows();
    } else if (url.includes("/GamesByDate/2026-03-15")) {
      rows = [historicalGameRow()];
    } else if (url.includes("/GamesByDate/2026-08-01")) {
      rows = [];
    } else if (
      url.includes("/PlayerGameStatsByDate/2026-03-15")
    ) {
      rows = omitHistoricalZero
        ? [{
            ...historicalZeroRow(),
            PlayerID: 998,
            TeamID: 30,
          }]
        : [historicalZeroRow()];
    } else if (
      url.includes("/PlayerGameStatsByDate/2026-08-01")
    ) {
      rows = [];
    } else {
      throw new Error(`Unexpected synthetic URL: ${url}`);
    }
    if (providerStatus !== 200) {
      rows = [{ RawPayloadMarker: RAW_PAYLOAD_MARKER }];
    }
    const raw = `${JSON.stringify(rows, null, 2)}\n`;
    responseBytes.set(url, Buffer.from(raw));
    return new Response(raw, {
      status: providerStatus,
      headers: { "content-type": "application/json" },
    });
  }
  return { fetchImpl, requests, responseBytes };
}

function uuidSequence() {
  let value = 0;
  return () => id(50_000 + value++);
}

function artifactFixture(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-capability-check-")
  );
  t.after(() => {
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  const persistentRoot = path.join(
    temporaryRoot,
    "persistent"
  );
  fs.mkdirSync(persistentRoot, { mode: 0o700 });
  return {
    temporaryRoot,
    persistentRoot,
    artifactPath: path.join(
      persistentRoot,
      "provider-capability",
      "sportsdataio-live-v1.json"
    ),
    manifestPath: path.join(
      temporaryRoot,
      "sportsdataio-live-probe-v1.json"
    ),
  };
}

function checkOptions(fixture, provider) {
  return {
    appEnv: "staging",
    environmentId: "hundo-staging-capability",
    backendBuildId: "build-fad05-capability",
    configuredNhlSeasonKey: CONFIGURED_SEASON,
    origin: ORIGIN,
    probeManifest: manifest(),
    dedicatedLiveApiKey: DEDICATED_LIVE_API_KEY,
    capabilitySecret: CAPABILITY_SECRET,
    capabilityKeyVersion: 7,
    persistentRoot: fixture.persistentRoot,
    artifactPath: fixture.artifactPath,
    fetchImpl: provider.fetchImpl,
    nowMs: () => NOW_MS,
    randomUUID: uuidSequence(),
  };
}

function commandEnvironment(persistentRoot) {
  return {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_ENVIRONMENT_ID: "hundo-staging-capability",
    APP_BUILD_ID: "build-fad05-capability",
    CURRENT_NHL_SEASON_KEY: CONFIGURED_SEASON,
    PERSISTENT_DATA_ROOT: persistentRoot,
    SPORTSDATAIO_NHL_LIVE_MODE: "probe",
    SPORTSDATAIO_NHL_LIVE_API_KEY:
      DEDICATED_LIVE_API_KEY,
    SPORTSDATAIO_NHL_LIVE_API_ORIGIN: ORIGIN,
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET:
      CAPABILITY_SECRET,
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION: "7",
    SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT: path.join(
      persistentRoot,
      "provider-capability",
      "sportsdataio-live-v1.json"
    ),
    STAGING_MAINTENANCE_HOLD: "false",
    LEAGUE_WRITE_MODE: "closed",
    SCHEDULED_JOBS_ENABLED: "false",
    FREE_AGENT_DRAFT_ROUTES_ENABLED: "false",
    ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
    DEBUG_ROUTES_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "capture",
    BACKUP_SCHEDULE_ENABLED: "false",
  };
}

function capturedOutput() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    output: {
      log(value) {
        stdout.push(String(value));
      },
      error(value) {
        stderr.push(String(value));
      },
    },
  };
}

describe("FAD-05 SportsDataIO live capability check", () => {
  test("bounds cloned provider responses while streaming", async () => {
    let index = 0;
    let cancelled = false;
    let released = false;
    const chunks = [
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([4, 5]),
    ];
    const response = {
      clone() {
        return {
          body: {
            getReader() {
              return {
                async read() {
                  if (index >= chunks.length) {
                    return { done: true, value: undefined };
                  }
                  return { done: false, value: chunks[index++] };
                },
                async cancel() {
                  cancelled = true;
                },
                releaseLock() {
                  released = true;
                },
              };
            },
          },
        };
      },
    };
    await assert.rejects(
      () => readBoundedResponseBytes(response, 4),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .semanticFailed,
      }
    );
    assert.equal(cancelled, true);
    assert.equal(released, true);
  });

  test("accepts only the exact canonical previous-season probe manifest and binds its SHA-256", () => {
    const probeManifest = manifest();
    const normalized =
      normalizeSportsDataIoLiveCapabilityProbeManifest(
        probeManifest
      );
    const digest =
      hashSportsDataIoLiveCapabilityProbeManifest(
        probeManifest
      );
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.players), true);
    assert.equal(
      digest,
      "350d54ea0620dab82743c9809c6526c8dc112d4e2f459b00e03e07b8ea31d014"
    );
    assert.equal(
      digest,
      hashSportsDataIoLiveCapabilityProbeManifest(normalized)
    );

    const mutations = [
      (value) => { value.extra = true; },
      (value) => { value.schemaVersion = 2; },
      (value) => { value.probeKind = "current"; },
      (value) => { value.probeNhlSeasonKey = "20242025"; },
      (value) => { value.players.reverse(); },
      (value) => {
        value.players[0].expectedDisposition = "no_due_game";
      },
      (value) => { value.players.pop(); },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(probeManifest);
      mutate(candidate);
      assert.throws(
        () =>
          normalizeSportsDataIoLiveCapabilityProbeManifest(
            candidate
          ),
        {
          code:
            SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
              .manifestInvalid,
        }
      );
    }
    const changedBinding = structuredClone(probeManifest);
    changedBinding.historicalZeroGame.providerTeamId = "11";
    assert.equal(
      hashSportsDataIoLiveCapabilityProbeManifest(
        changedBinding
      ),
      "a17fe1e2b41b1d49e8896cdef5f9479625be443e37b461f09135d36da5625096"
    );
  });

  test("publishes and exactly replays signed sanitized evidence from one real capture and controlled omission", async (t) => {
    const fixture = artifactFixture(t);
    const provider = providerFixture();
    const first = createSportsDataIoLiveCapabilityCheck(
      checkOptions(fixture, provider)
    );
    const receipt = await first.run();
    assert.equal(receipt.status, "published");
    assert.equal(receipt.capabilityStatus, "passed");
    assert.deepEqual(Object.keys(receipt).sort(), [
      "appEnv",
      "assertions",
      "backendBuildId",
      "capabilityStatus",
      "environmentId",
      "evidenceId",
      "evidenceSha256",
      "expiresAtMs",
      "issuedAtMs",
      "sourceVersion",
      "status",
    ]);
    assert.equal(receipt.expiresAtMs - receipt.issuedAtMs, 86_400_000);
    assert.equal(receipt.assertions.length, 15);
    assert.equal(provider.requests.length, 7);

    const artifactRaw = fs.readFileSync(
      fixture.artifactPath,
      "utf8"
    );
    const artifact = JSON.parse(artifactRaw);
    assert.equal(
      artifact.evidence.probeManifestSha256,
      first.probeManifestSha256
    );
    assert.deepEqual(
      artifact.evidence.capture.coverage.map(
        ({ playerId, disposition }) => ({
          playerId,
          disposition,
        })
      ),
      [
        { playerId: id(1), disposition: "expected_game" },
        { playerId: id(2), disposition: "no_due_game" },
        { playerId: id(3), disposition: "no_team" },
      ]
    );
    assert.deepEqual(
      artifact.evidence.capture.observations.map((row) => ({
        externalPlayerId: row.externalPlayerId,
        nhlGameId: row.nhlGameId,
        observedGameState: row.observedGameState,
        goals: row.goals,
        assists: row.assists,
      })),
      [{
        externalPlayerId: "101",
        nhlGameId: "8001",
        observedGameState: "final",
        goals: 0,
        assists: 0,
      }]
    );
    assert.equal(
      artifact.evidence.omissionProof.resultCode,
      "PLAYER_GAME_COVERAGE_RESPONSE_INCOMPLETE"
    );
    assert.equal(artifact.evidence.endpointProofs.length, 7);
    assert.deepEqual(
      artifact.evidence.endpointProofs
        .filter(
          (proof) =>
            proof.scopeKind === "date" &&
            proof.scopeValue === "2026-08-01"
        )
        .map((proof) => ({
          endpointKind: proof.endpointKind,
          rowCount: proof.rowCount,
        })),
      [
        { endpointKind: "player_game", rowCount: 0 },
        { endpointKind: "schedule", rowCount: 0 },
      ]
    );
    for (const proof of artifact.evidence.endpointProofs) {
      const requestUrl = provider.requests.find((url) => {
        if (proof.endpointKind === "players") {
          return url.endsWith("/scores/json/Players");
        }
        if (proof.endpointKind === "free_agents") {
          return url.endsWith("/scores/json/FreeAgents");
        }
        if (proof.endpointKind === "season_totals") {
          return url.includes("/PlayerSeasonStats/");
        }
        const suffix =
          proof.endpointKind === "schedule"
            ? "/GamesByDate/"
            : "/PlayerGameStatsByDate/";
        return url.includes(suffix) &&
          url.endsWith(`/${proof.scopeValue}`);
      });
      const expectedSha256 = crypto
        .createHash("sha256")
        .update(provider.responseBytes.get(requestUrl))
        .digest("hex");
      assert.equal(proof.responseSha256, expectedSha256);
    }
    const serializedReceipt = JSON.stringify(receipt);
    for (const forbidden of [
      DEDICATED_LIVE_API_KEY,
      CAPABILITY_SECRET,
      RAW_PAYLOAD_MARKER,
    ]) {
      assert.equal(artifactRaw.includes(forbidden), false);
      assert.equal(serializedReceipt.includes(forbidden), false);
    }

    const replayProvider = providerFixture();
    const replay = createSportsDataIoLiveCapabilityCheck(
      checkOptions(fixture, replayProvider)
    );
    const replayReceipt = await replay.run();
    assert.equal(replayReceipt.status, "replayed");
    assert.deepEqual(
      { ...replayReceipt, status: receipt.status },
      receipt
    );
  });

  test("writes no artifact for an omitted zero pair or provider failure", async (t) => {
    for (const [provider, expectedCode] of [
      [
        providerFixture({ omitHistoricalZero: true }),
        SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
          .semanticFailed,
      ],
      [
        providerFixture({ providerStatus: 503 }),
        SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
          .providerFailed,
      ],
    ]) {
      const fixture = artifactFixture(t);
      const check = createSportsDataIoLiveCapabilityCheck(
        checkOptions(fixture, provider)
      );
      let failure;
      try {
        await check.run();
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.code, expectedCode);
      assert.equal(fs.existsSync(fixture.artifactPath), false);
      assert.equal(
        JSON.stringify({
          code: failure.code,
          message: failure.message,
        }).includes(RAW_PAYLOAD_MARKER),
        false
      );
    }
  });

  test("does not publish evidence that expires before the publication check", async (t) => {
    const fixture = artifactFixture(t);
    const provider = providerFixture();
    const samples = [
      NOW_MS,
      NOW_MS,
      NOW_MS + 86_400_000,
    ];
    const options = checkOptions(fixture, provider);
    options.nowMs = () => samples.shift();
    const check = createSportsDataIoLiveCapabilityCheck(options);
    await assert.rejects(
      () => check.run(),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .artifactFailed,
      }
    );
    assert.equal(fs.existsSync(fixture.artifactPath), false);
    assert.deepEqual(samples, []);
  });

  test("runs the CLI with the dedicated key only and emits one sanitized receipt", async (t) => {
    const fixture = artifactFixture(t);
    const env = commandEnvironment(fixture.persistentRoot);
    const provider = providerFixture();
    const captured = capturedOutput();
    const manifestReads = [];
    const readFileSync = (filePath) => {
      manifestReads.push(filePath);
      return Buffer.from(
        `${JSON.stringify(manifest(), null, 2)}\n`,
        "utf8"
      );
    };
    const receipt =
      await runSportsDataIoLiveCapabilityCheckCommand({
        argv: [],
        env,
        output: captured.output,
        readFileSync,
        fetchImpl: provider.fetchImpl,
        nowMs: () => NOW_MS,
        randomUUID: uuidSequence(),
      });
    assert.equal(receipt.status, "published");
    assert.equal(captured.stdout.length, 1);
    assert.deepEqual(JSON.parse(captured.stdout[0]), receipt);
    assert.deepEqual(captured.stderr, []);
    for (const forbidden of [
      DEDICATED_LIVE_API_KEY,
      CAPABILITY_SECRET,
      RAW_PAYLOAD_MARKER,
    ]) {
      assert.equal(captured.stdout[0].includes(forbidden), false);
    }

    const rejectedOutput = capturedOutput();
    await assert.rejects(
      () => runSportsDataIoLiveCapabilityCheckCommand({
        argv: [],
        env,
        output: rejectedOutput.output,
        readFileSync,
        createCheck: () => ({
          async run() {
            return {
              ...receipt,
              leakedRawPayload: RAW_PAYLOAD_MARKER,
            };
          },
        }),
      }),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
            .internalFailed,
      }
    );
    assert.deepEqual(rejectedOutput.stdout, []);
    assert.deepEqual(rejectedOutput.stderr, []);
    assert.deepEqual(manifestReads, [
      CANONICAL_PROBE_MANIFEST_PATH,
      CANONICAL_PROBE_MANIFEST_PATH,
    ]);

    const legacyOnly = {
      ...env,
      SPORTSDATAIO_NHL_API_KEY: "legacy-key-must-not-enable",
    };
    delete legacyOnly.SPORTSDATAIO_NHL_LIVE_API_KEY;
    assert.throws(
      () => readConfiguration(legacyOnly),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
            .configurationInvalid,
      }
    );
    const escapedArtifact = {
      ...env,
      SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT:
        path.join(fixture.temporaryRoot, "escaped.json"),
    };
    assert.throws(
      () => readConfiguration(escapedArtifact),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
            .configurationInvalid,
      }
    );
    assert.deepEqual(parseArguments([]), {});
    assert.equal(Object.isFrozen(parseArguments([])), true);
  });

  test("rejects hold or normal-probe quiescence drift before manifest, provider, artifact, or output work", async (t) => {
    const fixture = artifactFixture(t);
    const baseEnvironment = commandEnvironment(fixture.persistentRoot);
    const cases = [
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
      let manifestReads = 0;
      let checkCreations = 0;
      let providerCalls = 0;
      const captured = capturedOutput();
      await assert.rejects(
        () =>
          runSportsDataIoLiveCapabilityCheckCommand({
            argv: [],
            env: { ...baseEnvironment, ...overrides },
            output: captured.output,
            readFileSync() {
              manifestReads += 1;
              throw new Error("manifest must not be read");
            },
            createCheck() {
              checkCreations += 1;
              throw new Error("check must not be created");
            },
            async fetchImpl() {
              providerCalls += 1;
              throw new Error("provider must not be called");
            },
          }),
        {
          code:
            SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
              .configurationInvalid,
        }
      );
      assert.equal(manifestReads, 0);
      assert.equal(checkCreations, 0);
      assert.equal(providerCalls, 0);
      assert.deepEqual(captured.stdout, []);
      assert.deepEqual(captured.stderr, []);
      assert.equal(fs.existsSync(fixture.artifactPath), false);
    }
  });

  test("rejects an operator-supplied probe manifest path before any read and reports only a sanitized error", async (t) => {
    const fixture = artifactFixture(t);
    const arbitraryPath = fixture.manifestPath;
    assert.throws(
      () => parseArguments([
        "--probe-manifest",
        arbitraryPath,
      ]),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
            .argumentInvalid,
      }
    );

    let manifestRead = false;
    const processObject = {};
    const captured = capturedOutput();
    await main({
      command: ({ output }) =>
        runSportsDataIoLiveCapabilityCheckCommand({
          argv: ["--probe-manifest", arbitraryPath],
          output,
          readFileSync() {
            manifestRead = true;
            throw new Error("unexpected manifest read");
          },
        }),
      output: captured.output,
      processObject,
    });

    assert.equal(manifestRead, false);
    assert.equal(processObject.exitCode, 1);
    assert.deepEqual(captured.stdout, []);
    assert.equal(captured.stderr.length, 1);
    assert.deepEqual(JSON.parse(captured.stderr[0]), {
      error: {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
            .argumentInvalid,
        message:
          "The SportsDataIO live capability command failed safely.",
      },
    });
    assert.equal(captured.stderr[0].includes(arbitraryPath), false);
  });

  test("maps CLI success to zero, provider or semantic failure to two, and sanitized internal failure to one", async () => {
    for (const status of [
      "passed",
      "published",
      "replaced",
      "replayed",
    ]) {
      const processObject = {};
      const captured = capturedOutput();
      await main({
        command: async () => ({ status }),
        output: captured.output,
        processObject,
      });
      assert.equal(processObject.exitCode, 0);
      assert.deepEqual(captured.stderr, []);
    }
    for (const code of [
      SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .providerFailed,
      SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .semanticFailed,
    ]) {
      const processObject = {};
      const captured = capturedOutput();
      await main({
        command: async () => {
          const error = new Error(
            `${DEDICATED_LIVE_API_KEY}:${RAW_PAYLOAD_MARKER}`
          );
          error.code = code;
          throw error;
        },
        output: captured.output,
        processObject,
      });
      assert.equal(processObject.exitCode, 2);
      assert.equal(exitCodeForError({ code }), 2);
      assert.equal(captured.stderr.length, 1);
      assert.equal(
        captured.stderr[0].includes(DEDICATED_LIVE_API_KEY),
        false
      );
      assert.equal(
        captured.stderr[0].includes(RAW_PAYLOAD_MARKER),
        false
      );
    }

    const processObject = {};
    const captured = capturedOutput();
    await main({
      command: async () => {
        throw new Error(
          `${CAPABILITY_SECRET}:${RAW_PAYLOAD_MARKER}`
        );
      },
      output: captured.output,
      processObject,
    });
    assert.equal(processObject.exitCode, 1);
    assert.equal(captured.stderr.length, 1);
    assert.deepEqual(JSON.parse(captured.stderr[0]), {
      error: {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
            .internalFailed,
        message:
          "The SportsDataIO live capability command failed safely.",
      },
    });
    assert.equal(captured.stderr[0].includes(CAPABILITY_SECRET), false);
    assert.equal(
      captured.stderr[0].includes(RAW_PAYLOAD_MARKER),
      false
    );
  });
});
