const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createCompatibilityBackgroundStarter,
  createCompatibilityRuntime,
} = require(
  "../../src/bootstrap/createCompatibilityRuntime"
);
const {
  loadConfig,
} = require("../../src/config/loadConfig");
const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");

function quietLogger() {
  return {
    error() {},
    log() {},
    warn() {},
  };
}

describe(
  "compatibility runtime composition",
  { concurrency: false },
  () => {
    test("constructs all compatibility features without listening", async (t) => {
      const fixture = await createFixtureRuntime();
      const statisticsDataDir = path.join(
        fixture.root,
        "stats-refresh"
      );
      const config = loadConfig({
        env: {
          NODE_ENV: "test",
          PORT: "0",
          LEAGUE_FILE: fixture.leagueFile,
          PLAYERS_FILE: fixture.playersFile,
          STATS_FILE: fixture.statsFile,
          DATA_DIR: statisticsDataDir,
          STATS_LOCK_FILE: path.join(
            statisticsDataDir,
            "stats-refresh.lock"
          ),
          STATS_SEASON_ID: "20262027",
          SNAPSHOT_DIR: fixture.snapshotsDir,
          BACKUPS_DIR: fixture.backupsDir,
          SNAPSHOTS_ENABLED: "false",
          AUCTIONS_ENABLED: "false",
          MATCHUPS_ENABLED: "false",
          MATCHUPS_DEBUG: "false",
        },
        backendRoot: fixture.root,
        existsSync: fs.existsSync,
      });
      const runtime = createCompatibilityRuntime({
        config,
        backendRoot: fixture.root,
        logger: quietLogger(),
        setIntervalFn() {
          throw new Error(
            "disabled background work must not create intervals"
          );
        },
      });

      t.after(async () => {
        await runtime.shutdown.shutdown();
        await fixture.cleanup();
      });

      assert.equal(runtime.server.listening, false);
      assert.equal(runtime.app.get("io"), runtime.io);
      assert.deepEqual(
        runtime.startBackgroundJobs(),
        { started: true }
      );
      assert.deepEqual(
        runtime.startBackgroundJobs(),
        {
          started: false,
          reason: "alreadyStarted",
        }
      );
      assert.equal(runtime.server.listening, false);
    });

    test("starts enabled background work once in compatibility order", () => {
      const calls = [];
      const handles = [];
      const jobs = {
        weeklySnapshotJob: {
          run() {
            calls.push("snapshot");
          },
        },
        resolveAuctionsJob: {
          run() {
            calls.push("auction");
          },
        },
        matchupJobs: {
          applyRosterLocks: { run() {} },
          captureMatchupBaseline: { run() {} },
          finalizeMatchupResults: { run() {} },
          rolloverMatchupWeek: { run() {} },
        },
      };
      const starter =
        createCompatibilityBackgroundStarter({
          config: {
            snapshotsEnabled: true,
            auctionsEnabled: true,
            matchupsEnabled: true,
            jobIntervalMs: 321,
          },
          ...jobs,
          setIntervalFn(callback, intervalMs) {
            calls.push(`interval:${intervalMs}`);
            return { callback, intervalMs };
          },
          trackInterval(handle) {
            calls.push("track");
            handles.push(handle);
            return handle;
          },
          startScheduler(options) {
            calls.push("matchups");
            assert.equal(
              options.jobs,
              jobs.matchupJobs
            );
            assert.equal(options.intervalMs, 321);
          },
          logger: quietLogger(),
        });

      assert.deepEqual(starter.start(), {
        started: true,
      });
      assert.deepEqual(starter.start(), {
        started: false,
        reason: "alreadyStarted",
      });
      assert.deepEqual(calls, [
        "snapshot",
        "interval:321",
        "track",
        "auction",
        "interval:321",
        "track",
        "matchups",
      ]);
      assert.equal(handles.length, 2);
    });
  }
);

describe("root server boundary", () => {
  test("contains startup and shutdown wiring only", async () => {
    const source = await fs.promises.readFile(
      path.join(__dirname, "..", "..", "server.js"),
      "utf8"
    );
    const lines = source.split(/\r?\n/);

    assert.ok(
      lines.length <= 80,
      `server.js still has ${lines.length} lines`
    );
    assert.match(source, /createCompatibilityRuntime/);
    assert.match(source, /startBackgroundJobs/);
    assert.match(source, /installSignalHandlers/);
    assert.match(source, /listen\(/);
    assert.match(source, /shutdown\(\)/);
    assert.doesNotMatch(
      source,
      /\b(?:app|router)\.(?:get|post|put|patch|delete|use)\(/
    );
    assert.doesNotMatch(
      source,
      /application\/|infrastructure\/|transport\/|jobs\/|operations\/|routes\//
    );
    assert.doesNotMatch(
      source,
      /\b(?:fs|path)\./
    );
  });
});
