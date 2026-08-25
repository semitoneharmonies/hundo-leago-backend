const fs = require("node:fs");
const path = require("node:path");

function createJsonBackupRepository({
  backupsDir,
  dataFilePath,
  maxBackups = 200,
  fsModule = fs,
  pathModule = path,
  nowMs = Date.now,
  logger = console,
} = {}) {
  if (!backupsDir) {
    throw new TypeError(
      "createJsonBackupRepository requires a backupsDir"
    );
  }
  if (!dataFilePath) {
    throw new TypeError(
      "createJsonBackupRepository requires a dataFilePath"
    );
  }

  function ensureDirectory() {
    if (!fsModule.existsSync(backupsDir)) {
      fsModule.mkdirSync(backupsDir, { recursive: true });
    }
  }

  function resolveBackupPath(backupId) {
    return pathModule.join(backupsDir, String(backupId));
  }

  function isoSafe(timestamp = nowMs()) {
    return new Date(timestamp)
      .toISOString()
      .replace(/[:.]/g, "-");
  }

  function writeBackupSync(state, { savedBy = "system" } = {}) {
    try {
      ensureDirectory();
      const filename = `${isoSafe()}__by_${String(
        savedBy || "system"
      )
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .slice(0, 32)}.json`;
      const backupPath = resolveBackupPath(filename);
      const temporaryPath = `${backupPath}.tmp`;

      fsModule.writeFileSync(
        temporaryPath,
        JSON.stringify(state, null, 2),
        "utf8"
      );
      fsModule.renameSync(temporaryPath, backupPath);
      return backupPath;
    } catch (error) {
      logger.error("[BACKEND] Failed to write backup:", error);
      return null;
    }
  }

  function listBackups({ limit = 50 } = {}) {
    ensureDirectory();

    const files = fsModule
      .readdirSync(backupsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        const filePath = resolveBackupPath(file);
        const stat = fsModule.statSync(filePath);
        return {
          id: file,
          createdAt: stat.mtimeMs,
          size: stat.size,
        };
      })
      .sort((left, right) => right.createdAt - left.createdAt);

    return files.slice(
      0,
      Math.max(1, Number(limit) || 50)
    );
  }

  function pruneBackupsBestEffort() {
    try {
      if (!maxBackups || maxBackups <= 0) return;

      const files = listBackups({ limit: Number.MAX_SAFE_INTEGER });
      if (files.length <= maxBackups) return;

      for (const backup of files.slice(maxBackups)) {
        try {
          fsModule.unlinkSync(resolveBackupPath(backup.id));
        } catch {
          // Current behavior treats individual prune failures as best effort.
        }
      }
    } catch (error) {
      logger.error(
        "[BACKEND] Failed pruning backups:",
        error
      );
    }
  }

  function backupExists(backupId) {
    return fsModule.existsSync(resolveBackupPath(backupId));
  }

  function readBackup(backupId) {
    if (!backupExists(backupId)) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    const raw = fsModule.readFileSync(
      resolveBackupPath(backupId),
      "utf8"
    );
    return JSON.parse(raw);
  }

  function writeLiveStateAtomicSync(state) {
    const temporaryPath = `${dataFilePath}.tmp`;
    fsModule.writeFileSync(
      temporaryPath,
      JSON.stringify(state, null, 2),
      "utf8"
    );
    fsModule.renameSync(temporaryPath, dataFilePath);
  }

  return {
    backupsDir,
    backupExists,
    ensureDirectory,
    listBackups,
    pruneBackupsBestEffort,
    readBackup,
    resolveBackupPath,
    writeBackupSync,
    writeLiveStateAtomicSync,
  };
}

module.exports = { createJsonBackupRepository };
