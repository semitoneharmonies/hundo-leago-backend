const assert = require("node:assert/strict");
const test = require("node:test");
const { createDeployedDailyBackupJob } = require("../../src/bootstrap/createDeployedDailyBackupJob");

function configuration() {
  const identity = { appEnv: "production", environmentId: "production-environment", databaseId: "production-database", persistentRoot: "E:/daily-test" };
  return { ...identity, scheduledJobsEnabled: true, leagueWriteMode: "open", backupScheduleEnabled: true,
    databasePath: "E:/daily-test/main.sqlite3", buildId: "production-candidate",
    backup: { ...identity, scheduleEnabled: true, objectStorage: {
      endpoint: "https://backup.invalid", region: "auto", bucket: "fixture",
      accessKeyId: { value: "fixture" }, secretAccessKey: { value: "fixture-secret" },
    } },
  };
}

test("deployed Daily companion receives the verified main path and new hourly cadence without external work", () => {
  const config = configuration();
  let captured;
  const job = { start() {}, close() {} };
  const actual = createDeployedDailyBackupJob({ config, logger: { error() { assert.fail("Unexpected failure"); } },
    fetchImplementation() { assert.fail("Construction must not contact storage"); },
    createJobFunction(options) { captured = options; return job; },
  });
  assert.equal(actual, job);
  assert.equal(captured.databasePath, config.databasePath);
  assert.equal(captured.config, config.backup);
  assert.equal(captured.backendBuildId, config.buildId);
  assert.equal(captured.cadence(), "hourly");
  assert.equal(typeof captured.objectStorage.putPrivateObject, "function");
});

test("disabled or maintenance Daily companions never construct or touch storage", () => {
  for (const override of [{ scheduledJobsEnabled: false }, { leagueWriteMode: "closed" }, { backupScheduleEnabled: false }]) {
    assert.equal(createDeployedDailyBackupJob({ config: { ...configuration(), ...override },
      createJobFunction() { assert.fail("Disabled job must not construct"); }, logger: { error() { assert.fail(); } },
    }), null);
  }
});

test("Daily backup configuration and construction failures are isolated with sanitized diagnostics", () => {
  for (const mismatch of [true, false]) {
    const config = configuration(), errors = [];
    if (mismatch) config.backup.databaseId = "other-database";
    assert.equal(createDeployedDailyBackupJob({ config, logger: { error: (...args) => errors.push(args) },
      createJobFunction() { throw new Error("fixture-secret"); },
    }), null);
    assert.deepEqual(errors, [["daily_backup.failed", { code: "DAILY_BACKUP_CONFIGURATION_FAILED" }]]);
  }
});
