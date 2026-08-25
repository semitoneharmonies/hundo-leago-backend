const fs = require("node:fs");
const path = require("node:path");

const {
  createJsonLeagueRepository,
} = require(
  "../infrastructure/persistence/json/JsonLeagueRepository"
);

function ensureDirSync({
  dirPath,
  fsModule,
  logger,
}) {
  try {
    if (!dirPath) return;
    if (!fsModule.existsSync(dirPath)) {
      fsModule.mkdirSync(dirPath, { recursive: true });
    }
  } catch (error) {
    logger.error(
      "[BACKEND] Failed to ensure directory:",
      dirPath,
      error
    );
  }
}

function createDependencies({
  config,
  backendRoot = path.resolve(__dirname, "..", ".."),
  fsModule = fs,
  pathModule = path,
  createJsonLeagueRepositoryFactory =
    createJsonLeagueRepository,
  createLeagueStoreFactory,
  logger = console,
} = {}) {
  if (!config) {
    throw new TypeError("createDependencies requires parsed configuration");
  }

  ensureDirSync({
    dirPath: pathModule.dirname(config.dataFile),
    fsModule,
    logger,
  });
  ensureDirSync({
    dirPath: config.snapshotsDir,
    fsModule,
    logger,
  });
  ensureDirSync({
    dirPath: pathModule.dirname(config.playersFile),
    fsModule,
    logger,
  });
  ensureDirSync({
    dirPath: pathModule.dirname(config.statsFile),
    fsModule,
    logger,
  });

  try {
    if (!fsModule.existsSync(config.playersFile)) {
      const repoPlayers = pathModule.join(backendRoot, "players.json");
      if (fsModule.existsSync(repoPlayers)) {
        fsModule.copyFileSync(repoPlayers, config.playersFile);
        logger.log(
          "[PLAYERS] bootstrapped players.json to",
          config.playersFile
        );
      } else {
        logger.warn(
          "[PLAYERS] missing both disk and repo players.json; DB will be empty until synced"
        );
      }
    }
  } catch (error) {
    logger.error(
      "[PLAYERS] bootstrap copy failed:",
      error?.message || error
    );
  }

  ensureDirSync({
    dirPath: config.backupsDir,
    fsModule,
    logger,
  });

  const repositoryFactory =
    createLeagueStoreFactory ||
    createJsonLeagueRepositoryFactory;
  const leagueRepository = repositoryFactory({
    dataFilePath: config.dataFile,
    backupsDirPath: config.backupsDir,
    maxBackups: config.maxBackups,
  });

  return {
    config,
    fs: fsModule,
    path: pathModule,
    leagueRepository,
    leagueStore: leagueRepository,
  };
}

module.exports = {
  createDependencies,
  ensureDirSync,
};
