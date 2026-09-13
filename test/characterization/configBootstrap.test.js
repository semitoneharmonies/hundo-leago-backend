const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createApplication,
} = require("../../src/bootstrap/createApplication");
const {
  createDependencies,
} = require("../../src/bootstrap/createDependencies");
const {
  COMPATIBILITY_ORIGINS,
  DEFAULT_PLAYERS_FILE,
  DEFAULT_STATISTICS_DATA_DIR,
  DEFAULT_STATS_FILE,
  JOB_INTERVAL_MS,
  STATISTICS_LOCK_MAX_AGE_MS,
  guessStatisticsSeasonId,
  loadConfig,
  loadStatisticsRefreshConfig,
} = require("../../src/config/loadConfig");

const TEST_ROOT = path.resolve("C:/synthetic-hundo-backend");

describe("current compatibility configuration", () => {
  test("preserves current defaults without filesystem side effects", () => {
    const existenceChecks = [];
    const config = loadConfig({
      env: {},
      backendRoot: TEST_ROOT,
      existsSync(targetPath) {
        existenceChecks.push(targetPath);
        return false;
      },
    });

    assert.equal(config.nodeEnv, undefined);
    assert.equal(config.port, 4000);
    assert.equal(
      config.dataFile,
      path.join(TEST_ROOT, "league-state.json")
    );
    assert.equal(config.snapshotsDir, path.join(TEST_ROOT, "snapshots"));
    assert.equal(config.playersFile, DEFAULT_PLAYERS_FILE);
    assert.equal(config.statsFile, DEFAULT_STATS_FILE);
    assert.equal(
      config.backupsDir,
      path.join(TEST_ROOT, "backups")
    );
    assert.equal(config.maxBackups, 200);
    assert.equal(config.debugMatchups, false);
    assert.equal(config.matchupsEnabled, false);
    assert.equal(config.snapshotsEnabled, true);
    assert.equal(config.auctionsEnabled, true);
    assert.equal(config.statsRefreshToken, "");
    assert.equal(config.bodyLimit, "10mb");
    assert.equal(config.jobIntervalMs, JOB_INTERVAL_MS);
    assert.deepEqual(config.compatibilityOrigins, COMPATIBILITY_ORIGINS);
    assert.deepEqual(existenceChecks, [
      path.join(TEST_ROOT, "stats-cache.json"),
    ]);
  });

  test("preserves explicit paths and current flag coercion", () => {
    const config = loadConfig({
      env: {
        NODE_ENV: "test",
        PORT: "4321",
        LEAGUE_FILE: "C:/fixtures/league.json",
        SNAPSHOT_DIR: "C:/fixtures/snapshots",
        PLAYERS_FILE: "C:/fixtures/players.json",
        STATS_FILE: "C:/fixtures/stats.json",
        BACKUPS_DIR: "C:/fixtures/backups",
        MAX_BACKUPS: "17",
        MATCHUPS_DEBUG: "true",
        MATCHUPS_ENABLED: "true",
        SNAPSHOTS_ENABLED: "false",
        AUCTIONS_ENABLED: "false",
        STATS_REFRESH_TOKEN: "test-only-secret",
      },
      backendRoot: TEST_ROOT,
      existsSync() {
        throw new Error("explicit STATS_FILE must skip existence checks");
      },
    });

    assert.equal(config.nodeEnv, "test");
    assert.equal(config.port, "4321");
    assert.equal(config.dataFile, "C:/fixtures/league.json");
    assert.equal(config.snapshotsDir, "C:/fixtures/snapshots");
    assert.equal(config.playersFile, "C:/fixtures/players.json");
    assert.equal(config.statsFile, "C:/fixtures/stats.json");
    assert.equal(config.backupsDir, "C:/fixtures/backups");
    assert.equal(config.maxBackups, 17);
    assert.equal(config.debugMatchups, true);
    assert.equal(config.matchupsEnabled, true);
    assert.equal(config.snapshotsEnabled, false);
    assert.equal(config.auctionsEnabled, false);
    assert.equal(config.statsRefreshToken, "test-only-secret");
  });

  test("retains exact lowercase flag and maximum-backup behavior", () => {
    const config = loadConfig({
      env: {
        MATCHUPS_DEBUG: "TRUE",
        MATCHUPS_ENABLED: "1",
        SNAPSHOTS_ENABLED: "FALSE",
        AUCTIONS_ENABLED: "0",
        MAX_BACKUPS: "not-a-number",
      },
      backendRoot: TEST_ROOT,
      existsSync: () => false,
    });

    assert.equal(config.debugMatchups, false);
    assert.equal(config.matchupsEnabled, false);
    assert.equal(config.snapshotsEnabled, true);
    assert.equal(config.auctionsEnabled, true);
    assert.equal(config.maxBackups, 200);
  });

  test("derives current Render sibling paths from LEAGUE_FILE", () => {
    const leagueFile =
      "/opt/render/project/data/hundo-test/league-state.json";
    const config = loadConfig({
      env: {
        NODE_ENV: "production",
        LEAGUE_FILE: leagueFile,
      },
      backendRoot: TEST_ROOT,
      existsSync: () => false,
    });

    assert.equal(
      config.playersFile,
      path.join(path.dirname(leagueFile), "players.json")
    );
    assert.equal(
      config.statsFile,
      path.join(path.dirname(leagueFile), "stats-cache.json")
    );
    assert.equal(
      config.backupsDir,
      path.join(path.dirname(leagueFile), "backups")
    );
  });

  test("selects the current local statistics file only outside production", () => {
    const localStatsFile = path.join(TEST_ROOT, "stats-cache.json");
    const local = loadConfig({
      env: { NODE_ENV: "development" },
      backendRoot: TEST_ROOT,
      existsSync: (targetPath) => targetPath === localStatsFile,
    });
    const production = loadConfig({
      env: { NODE_ENV: "production" },
      backendRoot: TEST_ROOT,
      existsSync: () => true,
    });

    assert.equal(local.statsFile, localStatsFile);
    assert.equal(production.statsFile, DEFAULT_STATS_FILE);
  });

  test("preserves the current origin decisions", () => {
    const { isAllowedOrigin } = loadConfig({
      env: {},
      backendRoot: TEST_ROOT,
      existsSync: () => false,
    });

    for (const origin of COMPATIBILITY_ORIGINS) {
      assert.equal(isAllowedOrigin(origin), true, origin);
    }

    assert.equal(isAllowedOrigin(undefined), true);
    assert.equal(
      isAllowedOrigin("https://deploy-preview-123--hundo.netlify.app"),
      true
    );
    assert.equal(isAllowedOrigin("https://example.com"), false);
    assert.equal(isAllowedOrigin("not a valid origin"), false);
  });

  test("creates independent applications without listening", () => {
    const config = loadConfig({
      env: {},
      backendRoot: TEST_ROOT,
      existsSync: () => false,
    });
    const first = createApplication(config);
    const second = createApplication(config);

    assert.notEqual(first, second);
    assert.equal(first.get("io"), undefined);
    assert.equal(second.get("io"), undefined);
    assert.equal(first.listening, undefined);
    assert.equal(second.listening, undefined);
  });

  test("composes current dependencies only inside an explicit temporary root", async (t) => {
    const runtimeRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hundo-leago-br01-deps-")
    );
    const backendRoot = path.join(runtimeRoot, "source");
    const dataRoot = path.join(runtimeRoot, "runtime");
    const sourcePlayers = path.join(backendRoot, "players.json");
    const targetPlayers = path.join(dataRoot, "players.json");
    let leagueRepositoryOptions = null;
    const syntheticLeagueRepository = {
      kind: "synthetic-league-repository",
    };

    t.after(async () => {
      await fs.promises.rm(runtimeRoot, {
        recursive: true,
        force: true,
      });
    });

    await fs.promises.mkdir(backendRoot, { recursive: true });
    await fs.promises.writeFile(
      sourcePlayers,
      '[{"id":1001,"fullName":"Synthetic Player"}]\n',
      "utf8"
    );

    const config = loadConfig({
      env: {
        NODE_ENV: "test",
        LEAGUE_FILE: path.join(dataRoot, "league-state.json"),
        SNAPSHOT_DIR: path.join(dataRoot, "snapshots"),
        PLAYERS_FILE: targetPlayers,
        STATS_FILE: path.join(dataRoot, "stats-cache.json"),
        BACKUPS_DIR: path.join(dataRoot, "backups"),
        MAX_BACKUPS: "11",
      },
      backendRoot,
      existsSync: fs.existsSync,
    });

    const dependencies = createDependencies({
      config,
      backendRoot,
      createJsonLeagueRepositoryFactory(options) {
        leagueRepositoryOptions = options;
        return syntheticLeagueRepository;
      },
      logger: {
        log() {},
        warn() {},
        error() {},
      },
    });

    assert.equal(
      path.relative(runtimeRoot, config.dataFile).startsWith(".."),
      false
    );
    assert.equal(
      config.dataFile
        .replaceAll("\\", "/")
        .includes("/opt/render/project/data"),
      false
    );
    assert.equal(fs.existsSync(config.snapshotsDir), true);
    assert.equal(fs.existsSync(config.backupsDir), true);
    assert.equal(fs.existsSync(path.dirname(config.statsFile)), true);
    assert.equal(
      await fs.promises.readFile(targetPlayers, "utf8"),
      await fs.promises.readFile(sourcePlayers, "utf8")
    );
    assert.deepEqual(leagueRepositoryOptions, {
      dataFilePath: config.dataFile,
      backupsDirPath: config.backupsDir,
      maxBackups: 11,
    });
    assert.equal(
      dependencies.leagueRepository,
      syntheticLeagueRepository
    );
    assert.equal(
      dependencies.leagueStore,
      syntheticLeagueRepository
    );
  });

  test("preserves current statistics refresh defaults and season guessing", () => {
    const january = new Date("2026-01-15T00:00:00.000Z");
    const july = new Date("2026-07-15T00:00:00.000Z");
    const januaryConfig = loadStatisticsRefreshConfig({
      env: {},
      now: () => january,
    });
    const julyConfig = loadStatisticsRefreshConfig({
      env: {},
      now: () => july,
    });

    assert.equal(guessStatisticsSeasonId(january), "20252026");
    assert.equal(guessStatisticsSeasonId(july), "20262027");
    assert.equal(januaryConfig.dataDir, DEFAULT_STATISTICS_DATA_DIR);
    assert.equal(
      januaryConfig.statsFile,
      path.join(DEFAULT_STATISTICS_DATA_DIR, "stats-cache.json")
    );
    assert.equal(
      januaryConfig.lockFile,
      path.join(DEFAULT_STATISTICS_DATA_DIR, "stats-refresh.lock")
    );
    assert.equal(januaryConfig.seasonId, "20252026");
    assert.equal(januaryConfig.gameTypeId, 2);
    assert.equal(januaryConfig.pageSize, 100);
    assert.equal(
      januaryConfig.lockMaxAgeMs,
      STATISTICS_LOCK_MAX_AGE_MS
    );
    assert.equal(julyConfig.seasonId, "20262027");
  });

  test("preserves explicit statistics refresh environment values", () => {
    const refresh = loadStatisticsRefreshConfig({
      env: {
        DATA_DIR: "C:/stats-data",
        STATS_FILE: "C:/stats-data/custom-cache.json",
        STATS_LOCK_FILE: "C:/stats-data/custom.lock",
        STATS_SEASON_ID: "20302031",
      },
      now() {
        throw new Error("explicit season must skip the clock");
      },
    });

    assert.equal(refresh.dataDir, "C:/stats-data");
    assert.equal(refresh.statsFile, "C:/stats-data/custom-cache.json");
    assert.equal(refresh.lockFile, "C:/stats-data/custom.lock");
    assert.equal(refresh.seasonId, "20302031");
  });
});
