const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  STAGING_CONFIRMATION,
  SportsDataIoStagingImportError,
  assertSafeStagingImportConfig,
  importSportsDataIoStaging,
  parseArguments,
} = require("../../scripts/import-sportsdataio-staging");
const {
  DATABASE_IDENTITY_KEYS,
} = require("../../src/infrastructure/database/databaseIdentity");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");

const ROOT = path.resolve(__dirname, "..", "..");

test("SportsDataIO staging import requires one explicit staging-only confirmation", () => {
  assert.deepEqual(parseArguments([STAGING_CONFIRMATION]), { confirmed: true });
  assert.throws(
    () => parseArguments([]),
    (error) => error instanceof SportsDataIoStagingImportError &&
      error.code === "SPORTSDATAIO_STAGING_CONFIRMATION_REQUIRED"
  );
});

test("SportsDataIO staging import refuses production, missing keys, jobs, and open writes", () => {
  const base = {
    appEnv: "staging",
    sportsDataIoNhl: { enabled: true },
    scheduledJobsEnabled: false,
    leagueWriteMode: "closed",
  };
  assert.equal(assertSafeStagingImportConfig(base), base);
  for (const [override, code] of [
    [{ appEnv: "production" }, "SPORTSDATAIO_STAGING_ENVIRONMENT_REQUIRED"],
    [{ sportsDataIoNhl: { enabled: false } }, "SPORTSDATAIO_NHL_API_KEY_REQUIRED"],
    [{ scheduledJobsEnabled: true }, "SPORTSDATAIO_STAGING_MAINTENANCE_REQUIRED"],
    [{ leagueWriteMode: "open" }, "SPORTSDATAIO_STAGING_MAINTENANCE_REQUIRED"],
  ]) {
    assert.throws(
      () => assertSafeStagingImportConfig({ ...base, ...override }),
      (error) => error instanceof SportsDataIoStagingImportError && error.code === code
    );
  }
});

test("SportsDataIO staging import persists a complete synthetic catalog before its statistics", async (t) => {
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-sportsdataio-staging-")
  );
  const sqliteDirectory = path.join(persistentRoot, "sqlite");
  fs.mkdirSync(sqliteDirectory);
  const databasePath = path.join(sqliteDirectory, "league.sqlite3");
  const seed = openDatabase({ databasePath, environment: "test" });
  migrateDatabase({
    database: seed.database,
    migrationsDirectory: path.join(ROOT, "database", "migrations"),
    applicationBuildId: "sportsdataio-staging-test",
    now: () => 1_700_000_000_000,
  });
  const insertMetadata = seed.database.prepare(
    "INSERT INTO application_metadata (metadata_key, metadata_value, created_at_ms, updated_at_ms) VALUES (?, ?, 0, 0)"
  );
  insertMetadata.run(DATABASE_IDENTITY_KEYS.environmentId, "staging-test-environment");
  insertMetadata.run(DATABASE_IDENTITY_KEYS.databaseId, "staging-test-database");
  insertMetadata.run(DATABASE_IDENTITY_KEYS.createdAt, "2025-07-25T00:00:00.000Z");
  seed.database.close();
  t.after(() => fs.rmSync(persistentRoot, { recursive: true, force: true }));

  const playerRows = Array.from({ length: 800 }, (_, index) => ({
    PlayerID: index + 1,
    FirstName: "Synthetic",
    LastName: `Player ${String(index + 1).padStart(3, "0")}`,
    Status: "Active",
    Team: "TST",
    Position: index % 5 === 0 ? "D" : "C",
    BirthDate: "1998-02-03T00:00:00",
    Updated: "2025-04-18T12:00:00Z",
  }));
  const activeRows = playerRows.slice(0, 700);
  const freeAgentRows = playerRows.slice(700, 750).map((row) => ({
    ...row,
    Status: "Inactive",
    Team: null,
  }));
  const statisticsRows = playerRows.map(
    ({ PlayerID, FirstName, LastName, Team, Position }) => ({
    PlayerID,
    Name: `${FirstName} ${LastName}`,
    Team,
    Position,
    Games: 10,
    Goals: 2,
    Assists: 3,
    Season: 2026,
    SeasonType: 1,
    Updated: "2025-04-18T12:00:00Z",
  }));
  const calls = [];
  const result = await importSportsDataIoStaging({
    argv: [STAGING_CONFIRMATION],
    nowMs: () => 1_700_000_000_000,
    loadConfig: () => ({
      appEnv: "staging",
      databaseId: "staging-test-database",
      databasePath,
      environmentId: "staging-test-environment",
      leagueWriteMode: "closed",
      migrationsDirectory: path.join(ROOT, "database", "migrations"),
      persistentRoot,
      scheduledJobsEnabled: false,
      sportsDataIoNhl: {
        apiKey: "test-key",
        enabled: true,
        nhlSeasonKey: "20252026",
        origin: "https://api.sportsdata.io/api/nhl/fantasy",
        seasonStartYear: "2025",
      },
    }),
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          if (url.endsWith("/Players")) return activeRows;
          if (url.endsWith("/FreeAgents")) return freeAgentRows;
          return statisticsRows;
        },
      };
    },
  });

  assert.equal(result.catalog.createdPlayerCount, 800);
  assert.equal(result.statistics.status, "succeeded");
  assert.equal(result.statistics.playerCount, 800);
  assert.equal(calls.length, 4);
  assert.equal(calls.every(({ url }) => !url.includes("test-key")), true);
  assert.equal(
    calls.every(({ options }) => options.headers["Ocp-Apim-Subscription-Key"] === "test-key"),
    true
  );

  const inspect = openDatabase({ databasePath, environment: "test" });
  try {
    assert.equal(
      inspect.database.prepare("SELECT COUNT(*) AS count FROM players").get().count,
      800
    );
    assert.equal(
      inspect.database.prepare(
        "SELECT COUNT(*) AS count FROM players WHERE status='active'"
      ).get().count,
      750
    );
    assert.equal(
      inspect.database.prepare(
        "SELECT COUNT(*) AS count FROM players WHERE status='historical'"
      ).get().count,
      50
    );
    assert.equal(
      inspect.database.prepare("SELECT COUNT(*) AS count FROM player_stat_totals").get().count,
      800
    );
  } finally {
    inspect.database.close();
  }
});
