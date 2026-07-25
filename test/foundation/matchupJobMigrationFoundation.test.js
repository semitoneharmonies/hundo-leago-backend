const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const { openDatabase } = require("../../src/infrastructure/database/connection");
const { applyMigrations, discoverMigrations } = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");

describe("M6-09 job lease-token migration", () => {
  test("adds lease tokens and explicit retry time without creating runs", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-09-migration-"));
    const connection = openDatabase({
      databasePath: path.join(root, "migration.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      if (connection.database.open) connection.database.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const migrations = discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY });
    applyMigrations({ database: connection.database, migrations: migrations.slice(0, 17), applicationBuildId: "m6-09-before", now: () => 1 });
    applyMigrations({ database: connection.database, migrations, applicationBuildId: "m6-09-after", now: () => 2 });
    assert.equal(connection.database.pragma("user_version", { simple: true }), 18);
    const columns = connection.database.pragma("table_info(job_runs)").map(({ name }) => name);
    assert.equal(columns.includes("lease_token"), true);
    assert.equal(columns.includes("next_attempt_at_ms"), true);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM job_runs").get().count, 0);
  });
});
