// scripts/refreshStats.js
/* eslint-disable no-console */
const {
  loadStatisticsRefreshConfig,
} = require("../src/config/loadConfig");
const {
  createStatisticsService,
} = require("../src/application/services/statistics/createStatisticsService");
const {
  createNhlStatisticsAdapter,
} = require("../src/infrastructure/nhl/NhlStatisticsAdapter");
const {
  createJsonStatisticsRepository,
} = require("../src/infrastructure/persistence/json/JsonStatisticsRepository");

function createRefreshStatsRuntime({
  env = process.env,
  fetchImpl = fetch,
  nowDate = () => new Date(),
  nowMs = Date.now,
  logger = console,
} = {}) {
  const config = loadStatisticsRefreshConfig({
    env,
    now: nowDate,
  });
  const repository = createJsonStatisticsRepository({
    statsFile: config.statsFile,
    lockFile: config.lockFile,
    dataDir: config.dataDir,
  });
  const provider = createNhlStatisticsAdapter({
    fetchImpl,
    seasonId: config.seasonId,
    gameTypeId: config.gameTypeId,
    pageSize: config.pageSize,
  });
  const service = createStatisticsService({
    repository,
    provider,
    nowMs,
    lockMaxAgeMs: config.lockMaxAgeMs,
    seasonId: config.seasonId,
    gameTypeId: config.gameTypeId,
    logger,
  });

  return {
    config,
    provider,
    refreshStatsNow: () => service.refresh(),
    repository,
    service,
  };
}

function refreshStatsNow(options) {
  return createRefreshStatsRuntime(options).refreshStatsNow();
}

module.exports = {
  createRefreshStatsRuntime,
  refreshStatsNow,
};

if (require.main === module) {
  refreshStatsNow().catch((error) => {
    console.error(
      "Stats refresh failed:",
      error?.message || error
    );
    process.exitCode = 1;
  });
}
