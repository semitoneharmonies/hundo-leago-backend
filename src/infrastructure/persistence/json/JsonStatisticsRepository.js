const fs = require("node:fs");
const path = require("node:path");

function statSafe(fsModule, filePath) {
  try {
    if (!fsModule.existsSync(filePath)) return { exists: false };
    const stat = fsModule.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    return {
      exists: false,
      error: String(error?.message || error),
    };
  }
}

function createJsonStatisticsRepository({
  statsFile,
  lockFile,
  dataDir = path.dirname(statsFile || ""),
  fsModule = fs,
  pid = process.pid,
} = {}) {
  if (!statsFile) {
    throw new TypeError(
      "createJsonStatisticsRepository requires a statsFile"
    );
  }

  function cacheExists() {
    return fsModule.existsSync(statsFile);
  }

  function readCache() {
    const raw = fsModule.readFileSync(statsFile, "utf8");
    return JSON.parse(raw);
  }

  async function readCacheAsync() {
    const raw = await fsModule.promises.readFile(statsFile, "utf8");
    return JSON.parse(raw);
  }

  function tryReadCache() {
    try {
      return readCache();
    } catch {
      return null;
    }
  }

  function ensureRefreshDirectory() {
    if (!fsModule.existsSync(dataDir)) {
      fsModule.mkdirSync(dataDir, { recursive: true });
    }
  }

  function acquireLock({
    nowMs,
    maxAgeMs,
  }) {
    if (!lockFile) return true;

    if (fsModule.existsSync(lockFile)) {
      try {
        const raw = fsModule.readFileSync(lockFile, "utf8");
        const parsed = JSON.parse(raw);
        if (
          typeof parsed.ts === "number" &&
          nowMs - parsed.ts < maxAgeMs
        ) {
          return false;
        }
      } catch {
        // Current behavior replaces a malformed lock.
      }
    }

    fsModule.writeFileSync(
      lockFile,
      JSON.stringify({ ts: nowMs, pid }),
      "utf8"
    );
    return true;
  }

  function releaseLock() {
    if (!lockFile) return;
    try {
      if (fsModule.existsSync(lockFile)) {
        fsModule.unlinkSync(lockFile);
      }
    } catch {
      // Current compatibility behavior ignores lock cleanup failure.
    }
  }

  function writeCache(payload) {
    const temporaryFile = `${statsFile}.tmp`;
    fsModule.writeFileSync(
      temporaryFile,
      JSON.stringify(payload),
      "utf8"
    );
    fsModule.renameSync(temporaryFile, statsFile);
  }

  function getDebugInfo({ localStatsFile } = {}) {
    return {
      statsFile,
      disk: statSafe(fsModule, statsFile),
      localPath: localStatsFile,
      localExists: localStatsFile
        ? fsModule.existsSync(localStatsFile)
        : false,
    };
  }

  return {
    acquireLock,
    cacheExists,
    ensureRefreshDirectory,
    getDebugInfo,
    lockFile,
    readCache,
    readCacheAsync,
    releaseLock,
    statsFile,
    tryReadCache,
    writeCache,
  };
}

module.exports = {
  createJsonStatisticsRepository,
  statSafe,
};
