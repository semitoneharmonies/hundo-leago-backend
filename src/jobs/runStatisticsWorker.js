"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { randomUUID } = require("node:crypto");
const Database = require("better-sqlite3");
const { configureDatabase } = require("../infrastructure/database/connection");
const { createSqliteProviderResultCorrectionRepository } = require("../infrastructure/persistence/sqlite/SqliteProviderResultCorrectionRepository");
const { createSqliteMatchupScoringRepository } = require("../infrastructure/persistence/sqlite/SqliteMatchupScoringRepository");
const { createSqliteStatisticsRetentionRepository } = require("../infrastructure/persistence/sqlite/SqliteStatisticsRetentionRepository");
const { createMatchupScoringService } = require("../application/services/matchups/createMatchupScoringService");
const { createProviderResultCorrectionService } = require("../application/services/matchups/createProviderResultCorrectionService");

async function execute(task) {
  const database = new Database(task.databasePath, { fileMustExist: true });
  try {
    configureDatabase(database);
    if (task.operation === "maintenance") {
      const retention = createSqliteStatisticsRetentionRepository({ database });
      return {
        compactProjectionsPruned: task.prune ? retention.pruneCompactTotals() : 0,
        ...(task.retire ? retention.retire(task.nowMs) : {}),
      };
    }
    if (task.operation !== "corrections") throw new Error("Unknown statistics worker operation");
    const start = Date.now();
    const service = createProviderResultCorrectionService({
      repository: createSqliteProviderResultCorrectionRepository({ database, leagueIds: task.leagueIds }),
      scoringService: createMatchupScoringService({
        expandedScoringEnabled: true,
        repository: createSqliteMatchupScoringRepository({ database }),
      }),
      createId: randomUUID,
      clock: { nowMs: () => task.nowMs + Date.now() - start },
    });
    return await service.reconcile();
  } finally {
    database.close();
  }
}

function runStatisticsWorker(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: task });
    let report;
    worker.once("message", result => { report = result; });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code === 0 && report) resolve(report);
      else reject(new Error("Statistics worker exited without completing " + task.operation));
    });
  });
}

if (!isMainThread && require.main === module) {
  execute(workerData).then(report => parentPort.postMessage(report));
}
module.exports = { runStatisticsWorker };
