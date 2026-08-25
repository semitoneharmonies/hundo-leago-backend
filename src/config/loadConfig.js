const fs = require("node:fs");
const path = require("node:path");

const COMPATIBILITY_ORIGINS = Object.freeze([
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "https://hundoleago.netlify.app",
]);

const DEFAULT_PLAYERS_FILE = "/opt/render/project/data/hundo/players.json";
const DEFAULT_STATS_FILE = "/opt/render/project/data/hundo/stats-cache.json";
const DEFAULT_STATISTICS_DATA_DIR = "/opt/render/project/data/hundo";
const JOB_INTERVAL_MS = 60 * 1000;
const STATISTICS_GAME_TYPE_ID = 2;
const STATISTICS_LOCK_MAX_AGE_MS = 15 * 60 * 1000;
const STATISTICS_PAGE_SIZE = 100;

function guessStatisticsSeasonId(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month <= 6 ? year - 1 : year;
  return `${startYear}${startYear + 1}`;
}

function loadStatisticsRefreshConfig({
  env = process.env,
  now = () => new Date(),
} = {}) {
  const dataDir = env.DATA_DIR || DEFAULT_STATISTICS_DATA_DIR;

  return {
    dataDir,
    statsFile:
      env.STATS_FILE || path.join(dataDir, "stats-cache.json"),
    lockFile:
      env.STATS_LOCK_FILE ||
      path.join(dataDir, "stats-refresh.lock"),
    seasonId:
      env.STATS_SEASON_ID || guessStatisticsSeasonId(now()),
    gameTypeId: STATISTICS_GAME_TYPE_ID,
    pageSize: STATISTICS_PAGE_SIZE,
    lockMaxAgeMs: STATISTICS_LOCK_MAX_AGE_MS,
  };
}

function createIsAllowedOrigin(allowlist = COMPATIBILITY_ORIGINS) {
  const allowed = new Set(allowlist);

  return function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (allowed.has(origin)) return true;

    try {
      const url = new URL(origin);
      return url.hostname.endsWith(".netlify.app");
    } catch {
      return false;
    }
  };
}

function loadConfig({
  env = process.env,
  backendRoot = path.resolve(__dirname, "..", ".."),
  existsSync = fs.existsSync,
} = {}) {
  const nodeEnv = env.NODE_ENV;
  const dataFile =
    env.LEAGUE_FILE || path.join(backendRoot, "league-state.json");
  const snapshotsDir =
    env.SNAPSHOT_DIR || path.join(backendRoot, "snapshots");

  const playersFile =
    env.PLAYERS_FILE ||
    (String(env.LEAGUE_FILE || "").includes("/opt/render/project/data/")
      ? path.join(path.dirname(env.LEAGUE_FILE), "players.json")
      : DEFAULT_PLAYERS_FILE);

  const localStatsFile = path.join(backendRoot, "stats-cache.json");
  const isLocalDev = nodeEnv !== "production";
  const statsFile =
    env.STATS_FILE ||
    (isLocalDev && existsSync(localStatsFile)
      ? localStatsFile
      : String(env.LEAGUE_FILE || "").includes(
            "/opt/render/project/data/"
          )
        ? path.join(path.dirname(env.LEAGUE_FILE), "stats-cache.json")
        : DEFAULT_STATS_FILE);

  const backupsDir =
    env.BACKUPS_DIR || path.join(path.dirname(dataFile), "backups");
  const compatibilityOrigins = [...COMPATIBILITY_ORIGINS];
  const statisticsRefresh = loadStatisticsRefreshConfig({ env });

  return {
    nodeEnv,
    port: env.PORT || 4000,
    dataFile,
    snapshotsDir,
    playersFile,
    statsFile,
    backupsDir,
    maxBackups: Number(env.MAX_BACKUPS || 200) || 200,
    debugMatchups: env.MATCHUPS_DEBUG === "true",
    matchupsEnabled: env.MATCHUPS_ENABLED === "true",
    snapshotsEnabled: env.SNAPSHOTS_ENABLED !== "false",
    auctionsEnabled: env.AUCTIONS_ENABLED !== "false",
    statsRefreshToken: env.STATS_REFRESH_TOKEN || "",
    compatibilityOrigins,
    isAllowedOrigin: createIsAllowedOrigin(compatibilityOrigins),
    bodyLimit: "10mb",
    jobIntervalMs: JOB_INTERVAL_MS,
    statisticsRefresh,
  };
}

module.exports = {
  COMPATIBILITY_ORIGINS,
  DEFAULT_PLAYERS_FILE,
  DEFAULT_STATISTICS_DATA_DIR,
  DEFAULT_STATS_FILE,
  JOB_INTERVAL_MS,
  STATISTICS_GAME_TYPE_ID,
  STATISTICS_LOCK_MAX_AGE_MS,
  STATISTICS_PAGE_SIZE,
  createIsAllowedOrigin,
  guessStatisticsSeasonId,
  loadConfig,
  loadStatisticsRefreshConfig,
};
