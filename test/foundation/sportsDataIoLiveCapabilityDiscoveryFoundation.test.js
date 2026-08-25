const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const Database = require("better-sqlite3");

const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES,
  main,
  openDiscoveryDatabase,
  parseArguments,
  readConfiguration,
  runSportsDataIoLiveCapabilityDiscoveryCommand,
} = require(
  "../../scripts/discover-sportsdataio-live-capability"
);
const {
  ENDPOINT_KEYS,
  PROVIDER_ORIGIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES,
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_SCHEMA_VERSION,
  discoverSportsDataIoLiveCapability,
  endpointUrls,
  readDatabaseScope,
} = require(
  "../../src/operations/statistics/createSportsDataIoLiveCapabilityDiscovery"
);
const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  hashSportsDataIoLiveCapabilityProbeManifest,
  normalizeSportsDataIoLiveCapabilityProbeManifest,
} = require(
  "../../src/operations/statistics/createSportsDataIoLiveCapabilityCheck"
);

const NOW_MS = Date.parse("2026-08-01T12:00:00.000Z");
const HISTORICAL_DATE = "2026-03-15";
const CURRENT_DATE = "2026-08-01";
const LIVE_KEY = "dedicated-live-key-do-not-disclose";
const LEGACY_KEY = "legacy-key-must-never-be-used";
const RAW_MARKER = "raw-provider-payload-must-not-escape";
const ENVIRONMENT_ID = "hundo-staging-environment-v1";
const DATABASE_ID = "hundo-staging-database-v1";

function id(value) {
  return (
    "70000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function createDatabaseFixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-live-discovery-")
  );
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const databasePath = path.join(root, "staging.sqlite");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE application_metadata (
      metadata_key TEXT PRIMARY KEY,
      metadata_value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE players (
      id TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE player_external_ids (
      player_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_value TEXT NOT NULL,
      FOREIGN KEY (player_id) REFERENCES players(id)
    ) STRICT;
  `);
  const insertMetadata = database.prepare(
    "INSERT INTO application_metadata VALUES (?, ?)"
  );
  insertMetadata.run(
    "database_created_at",
    "2026-07-01T00:00:00.000Z"
  );
  insertMetadata.run("database_id", DATABASE_ID);
  insertMetadata.run("environment_id", ENVIRONMENT_ID);
  const insertMapping = database.prepare(
    "INSERT INTO player_external_ids VALUES (?, ?, ?)"
  );
  const insertPlayer = database.prepare(
    "INSERT INTO players VALUES (?)"
  );
  for (const providerPlayerId of ["101", "102", "103", "104"]) {
    insertPlayer.run(id(providerPlayerId));
    insertMapping.run(
      id(providerPlayerId),
      "sportsdataio-discovery-lab",
      providerPlayerId
    );
  }
  insertPlayer.run(id(999));
  insertMapping.run(id(999), "another-provider", "101");
  database.close();
  return { root, databasePath };
}

function environment(databasePath, overrides = {}) {
  return {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_ENVIRONMENT_ID: ENVIRONMENT_ID,
    DATABASE_ID,
    DATABASE_PATH: databasePath,
    PERSISTENT_DATA_ROOT: path.dirname(databasePath),
    CURRENT_NHL_SEASON_KEY: "20262027",
    SPORTSDATAIO_NHL_LIVE_MODE: "probe",
    SPORTSDATAIO_NHL_LIVE_API_KEY: LIVE_KEY,
    SPORTSDATAIO_NHL_API_KEY: LEGACY_KEY,
    STAGING_MAINTENANCE_HOLD: "true",
    LEAGUE_WRITE_MODE: "closed",
    SCHEDULED_JOBS_ENABLED: "false",
    FREE_AGENT_DRAFT_ROUTES_ENABLED: "false",
    ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
    DEBUG_ROUTES_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "capture",
    BACKUP_SCHEDULE_ENABLED: "false",
    ...overrides,
  };
}

function payloadFixture() {
  const seasonTotals = Array.from({ length: 700 }, (_, index) => ({
    PlayerID: index + 1,
    Season: 2026,
    SeasonType: 1,
    Games: index % 82,
    Goals: index % 31,
    Assists: index % 47,
    RawPayloadMarker: RAW_MARKER,
  }));
  return {
    players: [
      { PlayerID: 101, TeamID: 10, RawPayloadMarker: RAW_MARKER },
      { PlayerID: 102, TeamID: 20, RawPayloadMarker: RAW_MARKER },
      { PlayerID: 104, TeamID: 40, RawPayloadMarker: RAW_MARKER },
    ],
    freeAgents: [
      { PlayerID: 103, TeamID: null, RawPayloadMarker: RAW_MARKER },
    ],
    seasonTotals,
    historicalGames: [{
      GameID: 8001,
      Season: 2026,
      SeasonType: 1,
      Status: "Final",
      DateTimeUTC: "2026-03-15T23:00:00",
      HomeTeamID: 10,
      AwayTeamID: 30,
      RawPayloadMarker: RAW_MARKER,
    }],
    historicalPlayerGameStats: [
      {
        PlayerID: 101,
        TeamID: 10,
        GameID: 8001,
        Season: 2026,
        SeasonType: 1,
        Games: 0,
        Goals: 0,
        Assists: 0,
        Updated: "2026-03-15T19:30:00",
        RawPayloadMarker: RAW_MARKER,
      },
      {
        PlayerID: 104,
        TeamID: 30,
        GameID: 8001,
        Season: 2026,
        SeasonType: 1,
        Games: 1,
        Goals: 0,
        Assists: 1,
        Updated: "2026-03-15T19:45:00",
        RawPayloadMarker: RAW_MARKER,
      },
    ],
    currentGames: [{
      GameID: 9001,
      Season: 2026,
      SeasonType: 1,
      Status: "Final",
      DateTimeUTC: "2026-08-01T10:00:00",
      HomeTeamID: 40,
      AwayTeamID: 50,
      RawPayloadMarker: RAW_MARKER,
    }],
    currentPlayerGameStats: [{
      PlayerID: 104,
      TeamID: 40,
      GameID: 9001,
      Season: 2026,
      SeasonType: 1,
      Games: 1,
      Goals: 1,
      Assists: 0,
      Updated: "2026-08-01T07:00:00",
      RawPayloadMarker: RAW_MARKER,
    }],
  };
}

function providerFixture({
  mutate,
  statusByEndpoint = {},
} = {}) {
  const payloads = payloadFixture();
  if (mutate) mutate(payloads);
  const urls = endpointUrls(HISTORICAL_DATE, CURRENT_DATE);
  const endpointByUrl = new Map(
    ENDPOINT_KEYS.map((key) => [urls[key], key])
  );
  const requests = [];
  async function fetchImpl(url, options) {
    const endpoint = endpointByUrl.get(url);
    assert.ok(endpoint, `unexpected request URL: ${url}`);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.deepEqual(Object.keys(options.headers), [
      "Ocp-Apim-Subscription-Key",
    ]);
    assert.equal(
      options.headers["Ocp-Apim-Subscription-Key"],
      LIVE_KEY
    );
    assert.equal(typeof options.signal.aborted, "boolean");
    requests.push({ endpoint, url });
    const status = statusByEndpoint[endpoint] ?? 200;
    return new Response(JSON.stringify(payloads[endpoint]), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return { fetchImpl, payloads, requests, urls };
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

function discoveryConfiguration() {
  return {
    appEnv: "staging",
    environmentId: ENVIRONMENT_ID,
    databaseId: DATABASE_ID,
    configuredNhlSeasonKey: "20262027",
    liveMode: "probe",
    dedicatedLiveApiKey: LIVE_KEY,
  };
}

async function runDiscovery(databasePath, provider) {
  const database = openDiscoveryDatabase({ databasePath });
  try {
    return await discoverSportsDataIoLiveCapability({
      historicalDate: HISTORICAL_DATE,
      configuration: discoveryConfiguration(),
      database,
      fetchImpl: provider.fetchImpl,
      nowMs: () => NOW_MS,
      abortSignalFactory: () => new AbortController().signal,
    });
  } finally {
    database.close();
  }
}

describe("FAD-18 read-only SportsDataIO live capability discovery", () => {
  test("accepts only one explicit historical date and exact staging probe configuration", (t) => {
    const { databasePath } = createDatabaseFixture(t);
    assert.deepEqual(
      parseArguments(["--historical-date", HISTORICAL_DATE]),
      { historicalDate: HISTORICAL_DATE }
    );
    for (const argv of [
      [],
      [HISTORICAL_DATE],
      ["--historical-date"],
      ["--historical-date", "2026-02-30"],
      ["--historical-date", "2026-07-01"],
      ["--historical-date", HISTORICAL_DATE, "extra"],
      ["--date", HISTORICAL_DATE],
    ]) {
      assert.throws(() => parseArguments(argv), {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
            .argumentInvalid,
      });
    }

    const configured = readConfiguration(environment(databasePath));
    assert.equal(configured.databasePath, databasePath);
    assert.equal(
      configured.discoveryConfiguration.dedicatedLiveApiKey,
      LIVE_KEY
    );
    assert.deepEqual(
      Object.keys(configured.discoveryConfiguration).sort(),
      [
        "appEnv",
        "configuredNhlSeasonKey",
        "databaseId",
        "dedicatedLiveApiKey",
        "environmentId",
        "liveMode",
      ]
    );
    assert.equal(
      Object.hasOwn(
        configured.discoveryConfiguration,
        "SPORTSDATAIO_NHL_API_KEY"
      ),
      false
    );
    for (const overrides of [
      { APP_ENV: "production" },
      { SPORTSDATAIO_NHL_LIVE_MODE: "required" },
      { CURRENT_NHL_SEASON_KEY: "20252026" },
      { SPORTSDATAIO_NHL_LIVE_API_KEY: undefined },
      {
        SPORTSDATAIO_NHL_LIVE_API_KEY: undefined,
        SPORTSDATAIO_NHL_API_KEY: LIVE_KEY,
      },
      {
        SPORTSDATAIO_NHL_LIVE_API_ORIGIN:
          "https://example.invalid",
      },
      { DATABASE_PATH: path.join(path.dirname(databasePath), "missing.sqlite") },
    ]) {
      assert.throws(
        () => readConfiguration(environment(databasePath, overrides)),
        {
          code:
            SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
              .configurationInvalid,
        }
      );
    }
  });

  test("opens exactly readonly/fileMustExist/query_only and closes on setup failure", () => {
    const databasePath = path.resolve("synthetic-staging.sqlite");
    let constructed;
    let closed = false;
    function DatabaseConstructor(receivedPath, options) {
      constructed = { receivedPath, options };
      return {
        open: true,
        pragma(statement, pragmaOptions) {
          if (statement === "query_only = ON") return [];
          if (
            statement === "query_only" &&
            pragmaOptions?.simple === true
          ) {
            return 1;
          }
          return 0;
        },
        close() {
          closed = true;
        },
      };
    }
    const database = openDiscoveryDatabase({
      databasePath,
      DatabaseConstructor,
    });
    assert.deepEqual(constructed, {
      receivedPath: databasePath,
      options: {
        readonly: true,
        fileMustExist: true,
        timeout: 5_000,
      },
    });
    database.close();
    assert.equal(closed, true);

    assert.throws(
      () => openDiscoveryDatabase({
        databasePath,
        DatabaseConstructor() {
          return {
            open: true,
            pragma(statement) {
              if (statement === "query_only = ON") return [];
              return 0;
            },
            close() {
              closed = true;
            },
          };
        },
      }),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
            .databaseInvalid,
      }
    );
    assert.equal(closed, true);
  });

  test("binds discovery to the physical persistent-root database and rejects path aliases before provider access", async (t) => {
    const { root, databasePath } = createDatabaseFixture(t);
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-live-discovery-outside-")
    );
    t.after(() => {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    });
    const outsideDatabase = path.join(outsideRoot, "staging.sqlite");
    fs.copyFileSync(databasePath, outsideDatabase);

    let databaseOpenCount = 0;
    let fetchCount = 0;
    const capture = capturedOutput();
    await assert.rejects(
      () => runSportsDataIoLiveCapabilityDiscoveryCommand({
        argv: ["--historical-date", HISTORICAL_DATE],
        env: environment(databasePath, {
          DATABASE_PATH: outsideDatabase,
          PERSISTENT_DATA_ROOT: root,
        }),
        output: capture.output,
        openDatabase() {
          databaseOpenCount += 1;
          throw new Error("database must not open");
        },
        fetchImpl: async () => {
          fetchCount += 1;
          throw new Error("provider must not be called");
        },
      }),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
            .configurationInvalid,
      }
    );
    assert.equal(databaseOpenCount, 0);
    assert.equal(fetchCount, 0);
    assert.deepEqual(capture.stdout, []);

    const aliasHost = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-live-discovery-alias-")
    );
    t.after(() => {
      fs.rmSync(aliasHost, { recursive: true, force: true });
    });
    const aliasRoot = path.join(aliasHost, "persistent-link");
    let aliasCreated = false;
    try {
      fs.symlinkSync(
        root,
        aliasRoot,
        process.platform === "win32" ? "junction" : "dir"
      );
      aliasCreated = true;
      assert.throws(
        () => readConfiguration(environment(
          path.join(aliasRoot, path.basename(databasePath))
        )),
        {
          code:
            SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
              .configurationInvalid,
        }
      );
    } catch (error) {
      if (!aliasCreated && error?.code === "EPERM") {
        t.diagnostic(
          "directory-reparse assertion unavailable without link privilege"
        );
      } else {
        throw error;
      }
    } finally {
      if (aliasCreated) fs.unlinkSync(aliasRoot);
    }
  });

  test("rechecks database identity around open and emits nothing when close fails", async (t) => {
    const { databasePath } = createDatabaseFixture(t);
    const configured = readConfiguration(environment(databasePath));
    let closed = false;
    const staleGuard = Object.freeze({
      ...configured.databaseGuard,
      identity: Object.freeze({
        ...configured.databaseGuard.identity,
        size: configured.databaseGuard.identity.size + 1n,
      }),
    });
    function StaleIdentityDatabaseConstructor(receivedPath) {
      return {
        open: true,
        pragma(statement, options) {
          if (statement === "query_only = ON") return [];
          if (statement === "query_only" && options?.simple) {
            return 1;
          }
          if (statement === "database_list") {
            return [{ name: "main", file: receivedPath }];
          }
          return [];
        },
        close() {
          closed = true;
        },
      };
    }
    assert.throws(
      () => openDiscoveryDatabase({
        databasePath,
        databaseGuard: staleGuard,
        DatabaseConstructor: StaleIdentityDatabaseConstructor,
      }),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
            .databaseInvalid,
      }
    );
    assert.equal(closed, true);

    const capture = capturedOutput();
    await assert.rejects(
      () => runSportsDataIoLiveCapabilityDiscoveryCommand({
        argv: ["--historical-date", HISTORICAL_DATE],
        env: environment(databasePath),
        output: capture.output,
        openDatabase() {
          return {
            open: true,
            close() {
              throw new Error("synthetic close failure");
            },
          };
        },
        discover: async () => ({ status: "candidate" }),
      }),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
            .databaseInvalid,
      }
    );
    assert.deepEqual(capture.stdout, []);
    assert.deepEqual(capture.stderr, []);
  });

  test("uses exact BigInt inode identity and nanosecond zero-inode fallback", async (t) => {
    const collidingBefore = 9_007_199_254_740_992n;
    const collidingAfter = collidingBefore + 1n;
    assert.equal(
      Number(collidingBefore),
      Number(collidingAfter),
      "the regression requires two distinct BigInts that collide as Numbers"
    );

    const cases = [
      {
        name: "inode precision collision",
        beforeIdentity: { ino: collidingBefore },
        openedIdentity: { ino: collidingAfter },
      },
      {
        name: "zero-inode birthtime precision collision",
        beforeIdentity: {
          ino: 0n,
          birthtimeNs: collidingBefore,
        },
        openedIdentity: {
          ino: 0n,
          birthtimeNs: collidingAfter,
        },
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async (t) => {
        const { databasePath } = createDatabaseFixture(t);
        const descriptors = new Map();
        const sourceLstatOptions = [];
        const sourceFstatOptions = [];
        const fsModule = Object.create(fs);

        function withIdentity(stat, identity) {
          const bigint = typeof stat.ino === "bigint";
          const overrides = {
            ino: bigint ? identity.ino : Number(identity.ino),
          };
          if (identity.birthtimeNs !== undefined) {
            if (bigint) {
              overrides.birthtimeNs = identity.birthtimeNs;
            } else {
              overrides.birthtimeMs = Number(identity.birthtimeNs);
            }
          }
          return Object.assign(
            Object.create(Object.getPrototypeOf(stat)),
            stat,
            overrides
          );
        }

        fsModule.lstatSync = (candidate, ...arguments_) => {
          const stat = fs.lstatSync(candidate, ...arguments_);
          if (candidate !== databasePath) return stat;
          sourceLstatOptions.push(arguments_[0]);
          return withIdentity(stat, scenario.beforeIdentity);
        };
        fsModule.openSync = (candidate, ...arguments_) => {
          const descriptor = fs.openSync(candidate, ...arguments_);
          descriptors.set(descriptor, candidate);
          return descriptor;
        };
        fsModule.fstatSync = (descriptor, ...arguments_) => {
          const stat = fs.fstatSync(descriptor, ...arguments_);
          if (descriptors.get(descriptor) !== databasePath) return stat;
          sourceFstatOptions.push(arguments_[0]);
          return withIdentity(stat, scenario.openedIdentity);
        };
        fsModule.closeSync = (descriptor, ...arguments_) => {
          try {
            return fs.closeSync(descriptor, ...arguments_);
          } finally {
            descriptors.delete(descriptor);
          }
        };

        const capture = capturedOutput();
        let databaseOpenCount = 0;
        let discoveryCount = 0;
        await assert.rejects(
          () => runSportsDataIoLiveCapabilityDiscoveryCommand({
            argv: ["--historical-date", HISTORICAL_DATE],
            env: environment(databasePath),
            output: capture.output,
            fsModule,
            openDatabase() {
              databaseOpenCount += 1;
              throw new Error("database must not open");
            },
            discover: async () => {
              discoveryCount += 1;
              throw new Error("discovery must not run");
            },
          }),
          {
            code:
              SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
                .databaseInvalid,
          }
        );
        assert.equal(
          sourceLstatOptions.filter(
            (options) => options?.bigint === true
          ).length,
          2
        );
        assert.deepEqual(sourceFstatOptions, [{ bigint: true }]);
        assert.equal(databaseOpenCount, 0);
        assert.equal(discoveryCount, 0);
        assert.deepEqual(capture.stdout, []);
        assert.deepEqual(capture.stderr, []);
      });
    }
  });

  test("rejects every quiescence drift before database open, provider fetch, or output", async (t) => {
    const { databasePath } = createDatabaseFixture(t);
    const drifts = [
      { NODE_ENV: "development" },
      { STAGING_MAINTENANCE_HOLD: "false" },
      { LEAGUE_WRITE_MODE: "open" },
      { SCHEDULED_JOBS_ENABLED: "true" },
      { FREE_AGENT_DRAFT_ROUTES_ENABLED: "true" },
      { ACCOUNT_EMAIL_DELIVERY_ENABLED: "true" },
      { DEBUG_ROUTES_ENABLED: "true" },
      { EMAIL_DELIVERY_MODE: "resend" },
      { BACKUP_SCHEDULE_ENABLED: "true" },
    ];
    for (const drift of drifts) {
      let databaseOpenCount = 0;
      let fetchCount = 0;
      const capture = capturedOutput();
      await assert.rejects(
        () => runSportsDataIoLiveCapabilityDiscoveryCommand({
          argv: ["--historical-date", HISTORICAL_DATE],
          env: environment(databasePath, drift),
          output: capture.output,
          openDatabase() {
            databaseOpenCount += 1;
            throw new Error("database must not open");
          },
          fetchImpl: async () => {
            fetchCount += 1;
            throw new Error("provider must not be called");
          },
          nowMs: () => NOW_MS,
        }),
        {
          code:
            SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
              .configurationInvalid,
        }
      );
      assert.equal(databaseOpenCount, 0);
      assert.equal(fetchCount, 0);
      assert.deepEqual(capture.stdout, []);
      assert.deepEqual(capture.stderr, []);
    }
  });

  test("discovers from a private WAL-mode snapshot and leaves the persistent source bytes, metadata, and entries unchanged", async (t) => {
    const { root, databasePath } = createDatabaseFixture(t);
    const walDatabase = new Database(databasePath);
    assert.equal(walDatabase.pragma("journal_mode = WAL", {
      simple: true,
    }), "wal");
    walDatabase.exec(`
      BEGIN IMMEDIATE;
      UPDATE application_metadata
      SET metadata_value = metadata_value
      WHERE metadata_key = 'database_id';
      COMMIT;
    `);
    walDatabase.pragma("wal_checkpoint(TRUNCATE)");
    walDatabase.close();
    for (const suffix of ["-journal", "-shm", "-wal"]) {
      assert.equal(fs.existsSync(`${databasePath}${suffix}`), false);
    }

    const beforeBytes = fs.readFileSync(databasePath);
    const beforeHash = sha256File(databasePath);
    const beforeStat = fs.statSync(databasePath);
    const beforeMetadata = {
      birthtimeMs: beforeStat.birthtimeMs,
      ctimeMs: beforeStat.ctimeMs,
      dev: beforeStat.dev,
      ino: beforeStat.ino,
      mode: beforeStat.mode,
      mtimeMs: beforeStat.mtimeMs,
      nlink: beforeStat.nlink,
      size: beforeStat.size,
    };
    const beforeEntries = fs.readdirSync(root).sort();
    const provider = providerFixture();
    const capture = capturedOutput();
    let openedDatabasePath;

    const result =
      await runSportsDataIoLiveCapabilityDiscoveryCommand({
        argv: ["--historical-date", HISTORICAL_DATE],
        env: environment(databasePath),
        output: capture.output,
        fetchImpl: provider.fetchImpl,
        openDatabase(options) {
          openedDatabasePath = options.databasePath;
          return openDiscoveryDatabase(options);
        },
        nowMs: () => NOW_MS,
        abortSignalFactory: () => new AbortController().signal,
      });

    assert.deepEqual(Object.keys(result).sort(), [
      "candidateFacts",
      "manifest",
      "semanticHash",
    ]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.manifest), true);
    assert.deepEqual(
      result.manifest,
      normalizeSportsDataIoLiveCapabilityProbeManifest(result.manifest)
    );
    assert.equal(
      result.candidateFacts.manifestSha256,
      hashSportsDataIoLiveCapabilityProbeManifest(result.manifest)
    );
    assert.equal(
      result.semanticHash,
      hashCanonicalJsonV1({
        domain:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_DOMAIN,
        schemaVersion:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_SCHEMA_VERSION,
        manifest: result.manifest,
        candidateFacts: result.candidateFacts,
      })
    );
    assert.deepEqual(result.candidateFacts.selected, {
      expectedGame: {
        playerId: id(101),
        providerPlayerId: "101",
        providerTeamId: "10",
        nhlGameId: "8001",
        nhlGameScheduledStartsAtMs:
          Date.parse("2026-03-15T23:00:00.000Z"),
        sourceUpdatedAtMs:
          Date.parse("2026-03-15T23:30:00.000Z"),
      },
      noDueGame: {
        playerId: id(102),
        providerPlayerId: "102",
        providerTeamId: "20",
      },
      noTeam: {
        playerId: id(103),
        providerPlayerId: "103",
      },
    });
    assert.equal(result.candidateFacts.exactRequestCount, 7);
    assert.deepEqual(
      provider.requests.map((request) => request.endpoint),
      ENDPOINT_KEYS
    );
    assert.deepEqual(
      provider.requests.map((request) => request.url),
      Object.values(provider.urls)
    );
    assert.equal(provider.requests.length, 7);
    assert.equal(capture.stdout.length, 1);
    assert.equal(capture.stderr.length, 0);
    assert.equal(
      capture.stdout[0],
      serializeCanonicalJsonV1(result)
    );
    const serialized = capture.stdout[0];
    for (const forbidden of [
      LIVE_KEY,
      LEGACY_KEY,
      RAW_MARKER,
      databasePath,
      ENVIRONMENT_ID,
      DATABASE_ID,
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.deepEqual(fs.readFileSync(databasePath), beforeBytes);
    assert.equal(sha256File(databasePath), beforeHash);
    const afterStat = fs.statSync(databasePath);
    assert.deepEqual({
      birthtimeMs: afterStat.birthtimeMs,
      ctimeMs: afterStat.ctimeMs,
      dev: afterStat.dev,
      ino: afterStat.ino,
      mode: afterStat.mode,
      mtimeMs: afterStat.mtimeMs,
      nlink: afterStat.nlink,
      size: afterStat.size,
    }, beforeMetadata);
    assert.deepEqual(fs.readdirSync(root).sort(), beforeEntries);
    assert.notEqual(openedDatabasePath, databasePath);
    assert.equal(path.dirname(openedDatabasePath) === root, false);
    assert.equal(
      path.relative(os.tmpdir(), openedDatabasePath).startsWith(".."),
      false
    );
    assert.equal(fs.existsSync(openedDatabasePath), false);
    assert.equal(fs.existsSync(path.dirname(openedDatabasePath)), false);
  });

  test("fails without output when source guards drift or private snapshot cleanup fails", async (t) => {
    {
      const { databasePath } = createDatabaseFixture(t);
      fs.writeFileSync(`${databasePath}-wal`, "forbidden-sidecar");
      const capture = capturedOutput();
      let databaseOpenCount = 0;
      let fetchCount = 0;
      await assert.rejects(
        () => runSportsDataIoLiveCapabilityDiscoveryCommand({
          argv: ["--historical-date", HISTORICAL_DATE],
          env: environment(databasePath),
          output: capture.output,
          openDatabase() {
            databaseOpenCount += 1;
          },
          fetchImpl: async () => {
            fetchCount += 1;
          },
        }),
        {
          code:
            SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
              .databaseInvalid,
        }
      );
      assert.equal(databaseOpenCount, 0);
      assert.equal(fetchCount, 0);
      assert.deepEqual(capture.stdout, []);
      assert.deepEqual(capture.stderr, []);
    }

    {
      const { databasePath } = createDatabaseFixture(t);
      const capture = capturedOutput();
      await assert.rejects(
        () => runSportsDataIoLiveCapabilityDiscoveryCommand({
          argv: ["--historical-date", HISTORICAL_DATE],
          env: environment(databasePath),
          output: capture.output,
          discover: async () => {
            fs.appendFileSync(databasePath, Buffer.from([0]));
            return { status: "candidate" };
          },
        }),
        {
          code:
            SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
              .databaseInvalid,
        }
      );
      assert.deepEqual(capture.stdout, []);
      assert.deepEqual(capture.stderr, []);
    }

    {
      const { databasePath } = createDatabaseFixture(t);
      const capture = capturedOutput();
      let snapshotPath;
      const fsModule = Object.create(fs);
      fsModule.copyFileSync = (...arguments_) => {
        snapshotPath = arguments_[1];
        return fs.copyFileSync(...arguments_);
      };
      fsModule.unlinkSync = (candidate) => {
        if (candidate === snapshotPath) {
          throw new Error("synthetic private cleanup failure");
        }
        return fs.unlinkSync(candidate);
      };
      try {
        await assert.rejects(
          () => runSportsDataIoLiveCapabilityDiscoveryCommand({
            argv: ["--historical-date", HISTORICAL_DATE],
            env: environment(databasePath),
            output: capture.output,
            fsModule,
            discover: async () => ({ status: "candidate" }),
          }),
          {
            code:
              SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
                .databaseInvalid,
          }
        );
        assert.equal(fs.existsSync(snapshotPath), true);
        assert.deepEqual(capture.stdout, []);
        assert.deepEqual(capture.stderr, []);
      } finally {
        if (snapshotPath) {
          fs.rmSync(path.dirname(snapshotPath), {
            recursive: true,
            force: true,
          });
        }
      }
    }
  });

  test("uses exact provider-ID intersections and deterministic selection without consulting names", async (t) => {
    const { databasePath } = createDatabaseFixture(t);
    const provider = providerFixture({
      mutate(payloads) {
        payloads.players.unshift({
          PlayerID: 100,
          TeamID: 9,
          FirstName: "Same",
          LastName: "Name",
        });
        payloads.freeAgents.push({
          PlayerID: 105,
          TeamID: null,
          FirstName: "Same",
          LastName: "Name",
        });
        payloads.historicalPlayerGameStats.unshift({
          ...payloads.historicalPlayerGameStats[0],
          PlayerID: 100,
        });
      },
    });
    const first = await runDiscovery(databasePath, provider);
    const second = await runDiscovery(
      databasePath,
      providerFixture({
        mutate(payloads) {
          payloads.players.unshift({
            PlayerID: 100,
            TeamID: 9,
            FirstName: "Same",
            LastName: "Name",
          });
          payloads.freeAgents.push({
            PlayerID: 105,
            TeamID: null,
            FirstName: "Same",
            LastName: "Name",
          });
          payloads.historicalPlayerGameStats.unshift({
            ...payloads.historicalPlayerGameStats[0],
            PlayerID: 100,
          });
          payloads.players.reverse();
          payloads.freeAgents.reverse();
          payloads.seasonTotals.reverse();
          payloads.historicalPlayerGameStats.reverse();
        },
      })
    );
    assert.equal(first.semanticHash, second.semanticHash);
    assert.deepEqual(first.manifest, second.manifest);
    assert.equal(
      first.manifest.players.some(
        (player) => player.providerPlayerId === "100"
      ),
      false
    );
    assert.equal(
      serializeCanonicalJsonV1(first).includes("Same"),
      false
    );
  });

  test("excludes currently due teams before deterministic expected-game selection", async (t) => {
    const { databasePath } = createDatabaseFixture(t);
    const withAlternative = providerFixture({
      mutate(payloads) {
        payloads.currentGames[0].HomeTeamID = 10;
        payloads.currentGames[0].AwayTeamID = 50;
        payloads.currentPlayerGameStats[0] = {
          ...payloads.currentPlayerGameStats[0],
          PlayerID: 101,
          TeamID: 10,
        };
        payloads.historicalGames.push({
          ...payloads.historicalGames[0],
          GameID: 8002,
          HomeTeamID: 20,
          AwayTeamID: 30,
        });
        payloads.historicalPlayerGameStats.push({
          ...payloads.historicalPlayerGameStats[0],
          PlayerID: 102,
          TeamID: 20,
          GameID: 8002,
          Updated: "2026-03-15T19:40:00",
        });
      },
    });
    const result = await runDiscovery(databasePath, withAlternative);
    assert.equal(
      result.candidateFacts.selected.expectedGame.providerPlayerId,
      "102"
    );
    assert.equal(
      result.candidateFacts.selected.expectedGame.providerTeamId,
      "20"
    );

    const withoutAlternative = providerFixture({
      mutate(payloads) {
        payloads.currentGames[0].HomeTeamID = 10;
        payloads.currentGames[0].AwayTeamID = 50;
        payloads.currentPlayerGameStats[0] = {
          ...payloads.currentPlayerGameStats[0],
          PlayerID: 101,
          TeamID: 10,
        };
      },
    });
    await assert.rejects(
      () => runDiscovery(databasePath, withoutAlternative),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .semanticFailed,
      }
    );
  });

  test("accepts the same nullable totals and optional numeric season fields as the canonical live adapter", async (t) => {
    const { databasePath } = createDatabaseFixture(t);
    const provider = providerFixture({
      mutate(payloads) {
        payloads.seasonTotals[0].Season = null;
        payloads.seasonTotals[0].SeasonType = undefined;
        payloads.seasonTotals[0].Games = null;
        delete payloads.seasonTotals[0].Goals;
        payloads.seasonTotals[0].Assists = undefined;
        payloads.seasonTotals[1].Season = "2026";
        payloads.seasonTotals[1].SeasonType = "1";
        delete payloads.historicalGames[0].Season;
        payloads.historicalGames[0].SeasonType = null;
        payloads.currentGames[0].Season = "2026";
        payloads.currentGames[0].SeasonType = "1";
        delete payloads.historicalPlayerGameStats[0].Season;
        payloads.historicalPlayerGameStats[0].SeasonType = "1";
        payloads.historicalPlayerGameStats[1].TeamID = null;
        payloads.historicalPlayerGameStats[1].Season = null;
        delete payloads.historicalPlayerGameStats[1].SeasonType;
        payloads.currentPlayerGameStats[0].Season = "2026";
        payloads.currentPlayerGameStats[0].SeasonType = null;
      },
    });
    const result = await runDiscovery(databasePath, provider);
    assert.equal(result.manifest.players.length, 3);
    assert.equal(provider.requests.length, 7);
  });

  test("fails closed on response duplicates, conflicts, season/status/time/team/zero semantics, extras, and entitlement", async (t) => {
    const { databasePath } = createDatabaseFixture(t);
    const semanticMutations = [
      (payloads) => {
        payloads.players.push({ ...payloads.players[0] });
      },
      (payloads) => {
        payloads.freeAgents.push({ PlayerID: 101, TeamID: null });
      },
      (payloads) => {
        payloads.seasonTotals[0].Season = 2025;
      },
      (payloads) => {
        payloads.historicalGames[0].Status = "Scheduled";
      },
      (payloads) => {
        payloads.historicalGames[0].DateTimeUTC =
          "2026-03-16T23:00:00";
      },
      (payloads) => {
        payloads.historicalPlayerGameStats[0].TeamID = 99;
      },
      (payloads) => {
        payloads.historicalPlayerGameStats[0].Games = 1;
      },
      (payloads) => {
        payloads.historicalPlayerGameStats[0].Goals = 1;
      },
      (payloads) => {
        payloads.historicalPlayerGameStats[0].Updated =
          "2026-03-15T18:00:00";
      },
      (payloads) => {
        payloads.freeAgents[0].TeamID = 31;
      },
      (payloads) => {
        payloads.players = Array.from(
          { length: 2_501 },
          (_, index) => ({ PlayerID: index + 1, TeamID: 1 })
        );
      },
      (payloads) => {
        payloads.currentPlayerGameStats = {
          error: RAW_MARKER,
          rows: [],
        };
      },
      (payloads) => {
        payloads.currentGames.push({
          ...payloads.currentGames[0],
          GameID: 9002,
          HomeTeamID: 10,
          AwayTeamID: 20,
        });
      },
    ];
    for (const mutate of semanticMutations) {
      const provider = providerFixture({ mutate });
      await assert.rejects(
        () => runDiscovery(databasePath, provider),
        {
          code:
            SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
              .semanticFailed,
        }
      );
      assert.ok(provider.requests.length <= 7);
    }

    const denied = providerFixture({
      statusByEndpoint: { seasonTotals: 401 },
    });
    await assert.rejects(
      () => runDiscovery(databasePath, denied),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .providerFailed,
      }
    );
    assert.equal(denied.requests.length, 3);
  });

  test("fails before provider access when query-only identity mappings are ambiguous or target identity differs", async () => {
    function fakeDatabase({
      duplicateProvider = false,
      duplicatePlayer = false,
    } = {}) {
      return {
        pragma(statement, options) {
          return statement === "query_only" && options?.simple
            ? 1
            : [];
        },
        prepare(sql) {
          if (sql.includes("application_metadata")) {
            return {
              all() {
                return [
                  {
                    key: "database_created_at",
                    value: "2026-07-01T00:00:00.000Z",
                  },
                  { key: "database_id", value: DATABASE_ID },
                  { key: "environment_id", value: ENVIRONMENT_ID },
                ];
              },
            };
          }
          assert.equal(sql.includes("JOIN players AS p"), true);
          assert.equal(
            sql.includes("p.id = x.player_id"),
            true
          );
          return {
            all(provider) {
              assert.equal(provider, "sportsdataio-discovery-lab");
              const mappings = [
                { playerId: id(101), providerPlayerId: "101" },
                { playerId: id(102), providerPlayerId: "102" },
                { playerId: id(103), providerPlayerId: "103" },
              ];
              if (duplicateProvider) {
                mappings.push({
                  playerId: id(104),
                  providerPlayerId: "101",
                });
              }
              if (duplicatePlayer) {
                mappings.push({
                  playerId: id(101),
                  providerPlayerId: "104",
                });
              }
              return mappings;
            },
          };
        },
      };
    }
    assert.equal(
      readDatabaseScope(
        fakeDatabase(),
        discoveryConfiguration()
      ).size,
      3
    );
    assert.throws(
      () => readDatabaseScope(
        fakeDatabase({ duplicateProvider: true }),
        discoveryConfiguration()
      ),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .databaseInvalid,
      }
    );
    assert.throws(
      () => readDatabaseScope(
        fakeDatabase({ duplicatePlayer: true }),
        discoveryConfiguration()
      ),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .databaseInvalid,
      }
    );
    assert.throws(
      () => readDatabaseScope(fakeDatabase(), {
        ...discoveryConfiguration(),
        databaseId: "different-staging-database-v1",
      }),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .databaseInvalid,
      }
    );

    let fetchCount = 0;
    await assert.rejects(
      () => discoverSportsDataIoLiveCapability({
        historicalDate: HISTORICAL_DATE,
        configuration: discoveryConfiguration(),
        database: fakeDatabase({ duplicateProvider: true }),
        fetchImpl: async () => {
          fetchCount += 1;
          throw new Error("must not be called");
        },
        nowMs: () => NOW_MS,
      }),
      {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .databaseInvalid,
      }
    );
    assert.equal(fetchCount, 0);
  });

  test("maps success to zero and provider or semantic failures to sanitized exit two", async () => {
    const successOutput = capturedOutput();
    const successProcess = { exitCode: undefined };
    const success = Object.freeze({ status: "candidate" });
    assert.equal(
      await main({
        command: async () => success,
        output: successOutput.output,
        processObject: successProcess,
      }),
      success
    );
    assert.equal(successProcess.exitCode, 0);
    assert.deepEqual(successOutput.stderr, []);

    for (const code of [
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .providerFailed,
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed,
    ]) {
      const capture = capturedOutput();
      const processObject = { exitCode: undefined };
      const result = await main({
        command: async () => {
          const error = new Error(
            `${LIVE_KEY}:${RAW_MARKER}:C:\\private\\staging.sqlite`
          );
          error.code = code;
          throw error;
        },
        output: capture.output,
        processObject,
      });
      assert.equal(result, null);
      assert.equal(processObject.exitCode, 2);
      assert.deepEqual(capture.stdout, []);
      assert.deepEqual(JSON.parse(capture.stderr[0]), {
        error: {
          code,
          message:
            "The SportsDataIO live capability discovery command failed safely.",
        },
      });
      assert.equal(capture.stderr[0].includes(LIVE_KEY), false);
      assert.equal(capture.stderr[0].includes(RAW_MARKER), false);
      assert.equal(capture.stderr[0].includes("staging.sqlite"), false);
    }
  });

  test("redacts unknown failures, provider payload, key material, and database paths", async () => {
    const capture = capturedOutput();
    const processObject = { exitCode: undefined };
    const secretFailure = new Error(
      `${LIVE_KEY}:${RAW_MARKER}:C:\\private\\staging.sqlite`
    );
    secretFailure.code = "UNSAFE_UNKNOWN_ERROR";
    const result = await main({
      command: async () => {
        throw secretFailure;
      },
      output: capture.output,
      processObject,
    });
    assert.equal(result, null);
    assert.equal(processObject.exitCode, 1);
    assert.equal(capture.stdout.length, 0);
    assert.equal(capture.stderr.length, 1);
    assert.deepEqual(JSON.parse(capture.stderr[0]), {
      error: {
        code:
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
            .internalFailed,
        message:
          "The SportsDataIO live capability discovery command failed safely.",
      },
    });
    assert.equal(capture.stderr[0].includes(LIVE_KEY), false);
    assert.equal(capture.stderr[0].includes(RAW_MARKER), false);
    assert.equal(capture.stderr[0].includes("staging.sqlite"), false);
  });
});
