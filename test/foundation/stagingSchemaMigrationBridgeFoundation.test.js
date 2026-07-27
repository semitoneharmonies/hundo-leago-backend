const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  CONFIRMATION,
  runStagingSchemaMigrationBridge,
} = require(
  "../../src/bootstrap/runStagingSchemaMigrationBridge"
);

function config(overrides = {}) {
  return {
    appEnv: "staging",
    buildId: "candidate-build",
    databaseId: "m7-release-qa-fixture",
    databasePath: "C:\\staging\\database.sqlite3",
    environmentId: "test:release-qa",
    migrationsDirectory: "C:\\candidate\\database\\migrations",
    persistentRoot: "C:\\staging",
    ...overrides,
  };
}

function database(version) {
  return {
    open: true,
    close() {
      this.open = false;
    },
    pragma(statement) {
      assert.equal(statement, "user_version");
      return version;
    },
  };
}

test("staging migration bridge is absent without its exact confirmation", async () => {
  const result = await runStagingSchemaMigrationBridge({
    env: {},
    loadConfig() {
      throw new Error("must not load");
    },
  });
  assert.deepEqual(result, { ran: false, replayed: false });
});

test("staging migration bridge rejects every non-fixture target", async () => {
  await assert.rejects(
    runStagingSchemaMigrationBridge({
      env: { STAGING_SCHEMA_MIGRATION_CONFIRMATION: CONFIRMATION },
      loadConfig: () => config({ appEnv: "production" }),
    }),
    { code: "STAGING_SCHEMA_MIGRATION_BRIDGE_FORBIDDEN" }
  );
});

test("staging migration bridge backs up, migrates once, and replays schema 21", async () => {
  const calls = [];
  let version = 20;
  const dependencies = {
    env: { STAGING_SCHEMA_MIGRATION_CONFIRMATION: CONFIRMATION },
    loadConfig: () => config(),
    openDatabaseFunction() {
      calls.push(`open-${version}`);
      return { database: database(version) };
    },
    assertDatabaseIdentityFunction(_database, expected) {
      assert.deepEqual(expected, {
        databaseId: "m7-release-qa-fixture",
        environmentId: "test:release-qa",
      });
    },
    async createBackup({ argv }) {
      calls.push("backup");
      assert.equal(argv.includes("pre-migration"), true);
      return {
        backupId: "backup-v1-safe",
        manifestChecksum: "manifest-safe",
      };
    },
    migrate({ argv, output }) {
      calls.push("migrate");
      assert.equal(argv.includes("candidate-build"), true);
      output.log("ignored");
      version = 21;
      return { latestMigrationId: 21 };
    },
  };

  assert.deepEqual(await runStagingSchemaMigrationBridge(dependencies), {
    backupId: "backup-v1-safe",
    manifestChecksum: "manifest-safe",
    ran: true,
    replayed: false,
    schemaVersion: 21,
  });
  assert.deepEqual(calls, ["open-20", "backup", "migrate", "open-21"]);

  calls.length = 0;
  assert.deepEqual(await runStagingSchemaMigrationBridge(dependencies), {
    ran: false,
    replayed: true,
    schemaVersion: 21,
  });
  assert.deepEqual(calls, ["open-21"]);
});
