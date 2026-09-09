const Database = require("better-sqlite3");
const { inspectNhlStatisticsReadiness } = require("../src/operations/statistics/inspectNhlStatisticsReadiness");

const [databasePath, nhlSeasonKey, ...extra] = process.argv.slice(2);
if (!databasePath || !nhlSeasonKey || extra.length) {
  process.stderr.write("Usage: node scripts/inspect-nhl-statistics-readiness.js <database-copy-path> <NHL-season-key>\n");
  process.exitCode = 1;
} else {
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    database.pragma("query_only = ON");
    const result = inspectNhlStatisticsReadiness({ database, nhlSeasonKey });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.readyForStatistics ? 0 : 2;
  } catch {
    process.stderr.write("The read-only NHL readiness check could not inspect that database and season. No migration or initialization was attempted.\n");
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}
