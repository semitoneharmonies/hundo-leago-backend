const {
  createResolveCompatibilityAuctionsService,
} = require(
  "../application/services/auctions/resolveCompatibilityAuctions"
);
const {
  createSaveCompatibilityLeagueService,
} = require(
  "../application/services/league/saveCompatibilityLeague"
);
const {
  createGenerateScheduleService,
} = require(
  "../application/services/matchups/generateSchedule"
);
const {
  createMatchupReadService,
} = require(
  "../application/services/matchups/readMatchups"
);
const {
  createShiftScheduleService,
} = require(
  "../application/services/matchups/shiftSchedule"
);
const {
  createUpdateWeekService,
} = require(
  "../application/services/matchups/updateWeek"
);
const {
  createPlayerService,
} = require(
  "../application/services/players/createPlayerService"
);
const {
  createStatisticsService,
} = require(
  "../application/services/statistics/createStatisticsService"
);
const {
  createNhlStatisticsAdapter,
} = require(
  "../infrastructure/nhl/NhlStatisticsAdapter"
);
const {
  createJsonPlayerRepository,
} = require(
  "../infrastructure/persistence/json/JsonPlayerRepository"
);
const {
  createJsonSnapshotRepository,
} = require(
  "../infrastructure/persistence/json/JsonSnapshotRepository"
);
const {
  createJsonStatisticsRepository,
} = require(
  "../infrastructure/persistence/json/JsonStatisticsRepository"
);
const {
  createSocketIoCompatibilityPublisher,
} = require(
  "../infrastructure/realtime/SocketIoCompatibilityPublisher"
);
const {
  createApplyRosterLocksJob,
} = require(
  "../jobs/definitions/applyRosterLocks"
);
const {
  createCaptureMatchupBaselineJob,
} = require(
  "../jobs/definitions/captureMatchupBaseline"
);
const {
  createWeeklySnapshotJob,
} = require(
  "../jobs/definitions/createWeeklySnapshot"
);
const {
  createFinalizeMatchupResultsJob,
} = require(
  "../jobs/definitions/finalizeMatchupResults"
);
const {
  createResolveAuctionsJob,
} = require(
  "../jobs/definitions/resolveAuctions"
);
const {
  createRolloverMatchupWeekJob,
} = require(
  "../jobs/definitions/rolloverMatchupWeek"
);
const {
  startMatchupScheduler,
} = require("../jobs/startScheduler");
const {
  createBackupOperations,
} = require(
  "../operations/backups/restoreBackup"
);
const {
  createSnapshotOperations,
} = require(
  "../operations/snapshots/createSnapshot"
);
const {
  createRestoreSnapshotOperation,
} = require(
  "../operations/snapshots/restoreSnapshot"
);
const {
  createLeagueWriteCompatibilityRouter,
} = require(
  "../transport/http/routes/leagueWriteCompatibilityRouter"
);
const {
  createMatchupsDebugCompatibilityRouter,
} = require(
  "../transport/http/routes/matchupsDebugCompatibilityRouter"
);
const {
  createMatchupsReadCompatibilityRouter,
} = require(
  "../transport/http/routes/matchupsReadCompatibilityRouter"
);
const {
  createMatchupsScheduleCompatibilityRouter,
} = require(
  "../transport/http/routes/matchupsScheduleCompatibilityRouter"
);
const {
  createPlayersCompatibilityRouter,
} = require(
  "../transport/http/routes/playersCompatibilityRouter"
);
const {
  createRecoveryCompatibilityRouter,
} = require(
  "../transport/http/routes/recoveryCompatibilityRouter"
);
const {
  createStatisticsCompatibilityRouter,
} = require(
  "../transport/http/routes/statisticsCompatibilityRouter"
);
const {
  registerHealthRoutes,
} = require("../../routes/healthRoutes");
const {
  registerLeagueReadRoutes,
} = require("../../routes/leagueReadRoutes");
const {
  createApplication,
} = require("./createApplication");
const {
  createDependencies,
} = require("./createDependencies");
const {
  createHttpServer,
} = require("./createHttpServer");
const { createShutdown } = require("./shutdown");

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

function createCompatibilityBackgroundStarter({
  config,
  weeklySnapshotJob,
  resolveAuctionsJob,
  matchupJobs,
  trackInterval,
  startScheduler = startMatchupScheduler,
  setIntervalFn = setInterval,
  logger = console,
} = {}) {
  let started = false;

  function start() {
    if (started) {
      return {
        started: false,
        reason: "alreadyStarted",
      };
    }
    started = true;

    if (config.snapshotsEnabled) {
      logger.log(
        "[SNAPSHOTS] enabled: auto-weekly snapshots ON"
      );
      weeklySnapshotJob.run();
      trackInterval(
        setIntervalFn(
          () => weeklySnapshotJob.run(),
          config.jobIntervalMs
        )
      );
    } else {
      logger.log("[SNAPSHOTS] disabled");
    }

    if (config.auctionsEnabled) {
      logger.log(
        "[AUCTIONS] enabled: auto auction rollover ON"
      );
      resolveAuctionsJob.run();
      trackInterval(
        setIntervalFn(
          () => resolveAuctionsJob.run(),
          config.jobIntervalMs
        )
      );
    } else {
      logger.log("[AUCTIONS] disabled");
    }

    if (config.matchupsEnabled) {
      logger.log(
        "[MATCHUPS] enabled: matchup auto-jobs ON"
      );
      startScheduler({
        jobs: matchupJobs,
        intervalMs: config.jobIntervalMs,
        trackInterval,
        setIntervalFn,
        logger,
      });
    } else {
      logger.log(
        "[MATCHUPS] disabled: matchup auto-jobs OFF"
      );
    }

    return { started: true };
  }

  return { start };
}

function createCompatibilityRuntime({
  config,
  backendRoot,
  logger = console,
  setIntervalFn = setInterval,
} = {}) {
  if (!config) {
    throw new TypeError(
      "createCompatibilityRuntime requires parsed configuration"
    );
  }
  if (!backendRoot) {
    throw new TypeError(
      "createCompatibilityRuntime requires backendRoot"
    );
  }

  const app = createApplication(config);
  const { server, io, listen } = createHttpServer({
    app,
    isAllowedOrigin: config.isAllowedOrigin,
  });
  const {
    path,
    leagueStore,
  } = createDependencies({
    config,
    backendRoot,
  });

  const snapshotRepository =
    createJsonSnapshotRepository({
      snapshotsDir: config.snapshotsDir,
    });
  const compatibilityPublisher =
    createSocketIoCompatibilityPublisher({ app });
  const snapshotOperations =
    createSnapshotOperations({
      snapshotRepository,
      leagueStore,
      publisher: compatibilityPublisher,
    });
  const restoreSnapshotOperation =
    createRestoreSnapshotOperation({
      snapshotRepository,
      leagueStore,
      publisher: compatibilityPublisher,
    });
  const backupOperations =
    createBackupOperations({
      leagueStore,
      publisher: compatibilityPublisher,
    });
  const saveCompatibilityLeagueService =
    createSaveCompatibilityLeagueService({
      leagueStore,
      publisher: compatibilityPublisher,
    });
  const resolveCompatibilityAuctionsService =
    createResolveCompatibilityAuctionsService({
      leagueStore,
      publisher: compatibilityPublisher,
    });
  const resolveAuctionsJob =
    createResolveAuctionsJob({
      resolutionService:
        resolveCompatibilityAuctionsService,
    });
  const weeklySnapshotJob =
    createWeeklySnapshotJob({
      leagueStore,
      snapshotRepository,
      publisher: compatibilityPublisher,
    });

  registerHealthRoutes({
    app,
    leagueStore,
    DATA_FILE: config.dataFile,
    BACKUPS_DIR: config.backupsDir,
  });
  registerLeagueReadRoutes({ app, leagueStore });

  const playerRepository =
    createJsonPlayerRepository({
      playerFile: config.playersFile,
      repositoryPlayerFile: path.join(
        backendRoot,
        "players.json"
      ),
    });
  const playerService = createPlayerService({
    repository: playerRepository,
  });
  app.use(
    createPlayersCompatibilityRouter({
      playerService,
    })
  );

  const playersLoad = playerService.reload();
  logger.log(
    "[PLAYERS] PLAYERS_FILE =",
    config.playersFile
  );
  logger.log(
    `[PLAYERS] loaded: ok=${playersLoad.ok} count=${playersLoad.count} source=${playersLoad.source || "?"}`
  );

  const statisticsRefreshConfig =
    config.statisticsRefresh;
  const statisticsRepository =
    createJsonStatisticsRepository({
      statsFile: config.statsFile,
      lockFile: statisticsRefreshConfig.lockFile,
      dataDir: statisticsRefreshConfig.dataDir,
    });
  const statisticsRefreshRepository =
    statisticsRefreshConfig.statsFile ===
    config.statsFile
      ? statisticsRepository
      : createJsonStatisticsRepository({
          statsFile:
            statisticsRefreshConfig.statsFile,
          lockFile:
            statisticsRefreshConfig.lockFile,
          dataDir:
            statisticsRefreshConfig.dataDir,
        });
  const nhlStatisticsAdapter =
    createNhlStatisticsAdapter({
      seasonId:
        statisticsRefreshConfig.seasonId,
      gameTypeId:
        statisticsRefreshConfig.gameTypeId,
      pageSize: statisticsRefreshConfig.pageSize,
    });
  const statisticsService =
    createStatisticsService({
      repository: statisticsRepository,
      refreshRepository:
        statisticsRefreshRepository,
      provider: nhlStatisticsAdapter,
      lockMaxAgeMs:
        statisticsRefreshConfig.lockMaxAgeMs,
      seasonId:
        statisticsRefreshConfig.seasonId,
      gameTypeId:
        statisticsRefreshConfig.gameTypeId,
    });
  app.use(
    createStatisticsCompatibilityRouter({
      statisticsService,
      statisticsRepository,
      statsRefreshToken:
        config.statsRefreshToken,
      backendRoot,
    })
  );

  const matchupReadService =
    createMatchupReadService({
      leagueStore,
      statisticsRepository,
      statsFile: config.statsFile,
    });
  const applyRosterLocksJob =
    createApplyRosterLocksJob({
      leagueStore,
      publisher: compatibilityPublisher,
    });
  const captureMatchupBaselineJob =
    createCaptureMatchupBaselineJob({
      leagueStore,
      statisticsRepository,
      publisher: compatibilityPublisher,
    });
  const finalizeMatchupResultsJob =
    createFinalizeMatchupResultsJob({
      leagueStore,
      statisticsRepository,
      publisher: compatibilityPublisher,
    });
  const rolloverMatchupWeekJob =
    createRolloverMatchupWeekJob({
      leagueStore,
      statisticsRepository,
      publisher: compatibilityPublisher,
    });

  app.use(
    createMatchupsReadCompatibilityRouter({
      matchupReadService,
    })
  );

  if (config.debugMatchups) {
    logger.log("REGISTERING MATCHUPS DEBUG ROUTES");
    app.use(
      createMatchupsDebugCompatibilityRouter({
        leagueStore,
        captureMatchupBaselineJob,
        applyRosterLocksJob,
        publisher: compatibilityPublisher,
        logger,
      })
    );
  }

  const generateScheduleService =
    createGenerateScheduleService({
      leagueStore,
      timeZone: PACIFIC_TIME_ZONE,
      publisher: compatibilityPublisher,
    });
  const updateWeekService =
    createUpdateWeekService({
      leagueStore,
      nodeEnv: config.nodeEnv,
      publisher: compatibilityPublisher,
    });
  const shiftScheduleService =
    createShiftScheduleService({
      leagueStore,
      timeZone: PACIFIC_TIME_ZONE,
      publisher: compatibilityPublisher,
    });
  app.use(
    createMatchupsScheduleCompatibilityRouter({
      generateScheduleService,
      updateWeekService,
      shiftScheduleService,
    })
  );
  app.use(
    createLeagueWriteCompatibilityRouter({
      saveCompatibilityLeagueService,
    })
  );
  app.use(
    createRecoveryCompatibilityRouter({
      snapshotOperations,
      restoreSnapshotOperation,
      backupOperations,
    })
  );

  const shutdown = createShutdown({
    server,
    io,
    logger,
  });
  const backgroundStarter =
    createCompatibilityBackgroundStarter({
      config,
      weeklySnapshotJob,
      resolveAuctionsJob,
      matchupJobs: {
        applyRosterLocks: applyRosterLocksJob,
        captureMatchupBaseline:
          captureMatchupBaselineJob,
        finalizeMatchupResults:
          finalizeMatchupResultsJob,
        rolloverMatchupWeek:
          rolloverMatchupWeekJob,
      },
      trackInterval: shutdown.trackInterval,
      setIntervalFn,
      logger,
    });

  return {
    app,
    io,
    listen,
    server,
    shutdown,
    startBackgroundJobs: backgroundStarter.start,
  };
}

module.exports = {
  PACIFIC_TIME_ZONE,
  createCompatibilityBackgroundStarter,
  createCompatibilityRuntime,
};
