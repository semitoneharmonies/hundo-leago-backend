const {
  reportTargetStartupFailure,
  startTargetProcess,
} = require("./src/bootstrap/startTargetProcess");
const {
  runStagingSchemaMigrationBridge,
} = require("./src/bootstrap/runStagingSchemaMigrationBridge");

async function main() {
  const migration = await runStagingSchemaMigrationBridge();
  if (migration.ran) {
    process.stdout.write(
      `${JSON.stringify({
        event: "staging_schema_migration.completed",
        backupId: migration.backupId,
        manifestChecksum: migration.manifestChecksum,
        schemaVersion: migration.schemaVersion,
      })}\n`
    );
  }
  return startTargetProcess();
}

main().catch((error) => {
  reportTargetStartupFailure(error);
  process.exitCode = 1;
});
