#!/usr/bin/env node
const { randomUUID } = require("node:crypto");

const {
  createSportsDataIoCatalogImportService,
} = require("../src/application/services/players/createSportsDataIoCatalogImportService");
const {
  createTargetStatisticsService,
} = require("../src/application/services/statistics/createTargetStatisticsService");
const {
  loadTargetRuntimeConfig,
} = require("../src/config/loadTargetRuntimeConfig");
const {
  assertDatabaseIdentity,
} = require("../src/infrastructure/database/databaseIdentity");
const {
  openDatabase,
} = require("../src/infrastructure/database/connection");
const {
  assertMigrationCompatibility,
  discoverMigrations,
} = require("../src/infrastructure/database/migrate");
const {
  createSqlitePlayerCatalogRepository,
} = require("../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository");
const {
  createSqliteStatisticsRepository,
} = require("../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");
const {
  PROVIDER_NAME,
  MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT,
  createSportsDataIoLastSeasonStatisticsProvider,
  createSportsDataIoNhlAdapter,
} = require("../src/infrastructure/sportsdataio/SportsDataIoNhlAdapter");

const STAGING_CONFIRMATION = "--confirm-staging-sportsdataio-import";

class SportsDataIoStagingImportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.code = code;
  }
}

function fail(code, message) {
  throw new SportsDataIoStagingImportError(code, message);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== STAGING_CONFIRMATION) {
    fail(
      "SPORTSDATAIO_STAGING_CONFIRMATION_REQUIRED",
      `This staging-only import requires ${STAGING_CONFIRMATION}.`
    );
  }
  return Object.freeze({ confirmed: true });
}

function assertSafeStagingImportConfig(config) {
  if (!config || config.appEnv !== "staging") {
    fail(
      "SPORTSDATAIO_STAGING_ENVIRONMENT_REQUIRED",
      "SportsDataIO import is authorized only for staging."
    );
  }
  if (!config.sportsDataIoNhl?.enabled) {
    fail(
      "SPORTSDATAIO_NHL_API_KEY_REQUIRED",
      "SportsDataIO import is disabled until the staging server secret is configured."
    );
  }
  if (config.scheduledJobsEnabled || config.leagueWriteMode !== "closed") {
    fail(
      "SPORTSDATAIO_STAGING_MAINTENANCE_REQUIRED",
      "Staging imports require scheduled jobs disabled and league writes closed."
    );
  }
  return config;
}

async function importSportsDataIoStaging({
  argv,
  env = process.env,
  fetchImplementation = fetch,
  nowMs = Date.now,
  createId = randomUUID,
  loadConfig = loadTargetRuntimeConfig,
  openDatabaseFunction = openDatabase,
} = {}) {
  parseArguments(argv);
  const config = assertSafeStagingImportConfig(loadConfig({ env }));
  if (typeof fetchImplementation !== "function" || typeof nowMs !== "function" || typeof createId !== "function") {
    throw new TypeError("SportsDataIO staging import requires runtime adapters.");
  }

  const connection = openDatabaseFunction({
    databasePath: config.databasePath,
    environment: "staging",
    persistentRoot: config.persistentRoot,
    requirePersistentRoot: true,
  });
  try {
    assertMigrationCompatibility(
      connection.database,
      discoverMigrations({ migrationsDirectory: config.migrationsDirectory })
    );
    assertDatabaseIdentity(connection.database, config);
    const providerAdapter = createSportsDataIoNhlAdapter({
      apiKey: config.sportsDataIoNhl.apiKey,
      fetchImpl: fetchImplementation,
      origin: config.sportsDataIoNhl.origin,
      nowMs,
    });
    const statistics = createTargetStatisticsService({
      repository: createSqliteStatisticsRepository({
        database: connection.database,
        createId,
      }),
      provider: createSportsDataIoLastSeasonStatisticsProvider({
        adapter: providerAdapter,
        seasonStart: config.sportsDataIoNhl.seasonStartYear,
      }),
      nhlSeasonKey: config.sportsDataIoNhl.nhlSeasonKey,
      providerName: PROVIDER_NAME,
      minimumPlayerCount: MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT,
      createId,
      nowMs,
    });
    const service = createSportsDataIoCatalogImportService({
      catalogRepository: createSqlitePlayerCatalogRepository({
        database: connection.database,
        createId,
      }),
      provider: providerAdapter,
      statisticsService: statistics,
      seasonStart: config.sportsDataIoNhl.seasonStartYear,
    });
    return await service.importLastSeason();
  } finally {
    if (connection.database?.open) connection.database.close();
  }
}

async function main() {
  try {
    const result = await importSportsDataIoStaging({
      argv: process.argv.slice(2),
    });
    console.log(JSON.stringify({
      status: "succeeded",
      provider: result.provider,
      catalog: result.catalog,
      statistics: result.statistics,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || "SPORTSDATAIO_STAGING_IMPORT_FAILED",
        message: "SportsDataIO staging import failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  STAGING_CONFIRMATION,
  SportsDataIoStagingImportError,
  assertSafeStagingImportConfig,
  importSportsDataIoStaging,
  parseArguments,
};
