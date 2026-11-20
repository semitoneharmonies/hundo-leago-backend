#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadTargetRuntimeConfig } = require("../src/config/loadTargetRuntimeConfig");
const { loadBackupConfig } = require("../src/config/loadBackupConfig");
const { createS3CompatibleClient } = require("../src/infrastructure/backups/createS3CompatibleClient");
const { createObjectStorageAdapter } = require("../src/infrastructure/backups/createObjectStorageAdapter");
const { restoreDailyCompanionBackupToCleanPath } = require("../src/operations/backups/createDailyCompanionBackup");

async function verifyDailyBackup({ env = process.env, manifestObjectKey, temporaryRoot = os.tmpdir() } = {}) {
  const runtime = loadTargetRuntimeConfig({ env });
  const config = loadBackupConfig({ env, runtimeConfig: runtime });
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(temporaryRoot), "hundo-daily-recovery-"));
  fs.chmodSync(directory, 0o700);
  const storage = config.objectStorage;
  const objectStorage = createObjectStorageAdapter({ client: createS3CompatibleClient({ endpoint: storage.endpoint, region: storage.region, bucket: storage.bucket, accessKeyId: storage.accessKeyId.value, secretAccessKey: storage.secretAccessKey.value, requestTimeoutMs: 60_000 }) });
  return restoreDailyCompanionBackupToCleanPath({ config, objectStorage, manifestObjectKey, temporaryRoot: directory, targetDatabasePath: path.join(directory, "verified.sqlite3") });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--manifest") { console.error("Usage: node scripts/db-verify-daily-backup.js --manifest PRIVATE_MANIFEST_KEY"); process.exitCode = 1; }
  else verifyDailyBackup({ manifestObjectKey: args[1] }).then(result => console.log(JSON.stringify(result))).catch(() => { console.error(JSON.stringify({ status: "failed", code: "DAILY_BACKUP_RECOVERY_FAILED" })); process.exitCode = 1; });
}
module.exports = { verifyDailyBackup };
