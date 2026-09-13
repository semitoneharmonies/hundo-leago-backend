const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const { openDatabase } = require("../../src/infrastructure/database/connection");
const { applyMigrations, discoverMigrations } = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");

describe("M6-05 matchup-lock legality migration", () => {
  test("adds nullable-baseline illegal evidence without creating rows", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-05-migration-"));
    const connection = openDatabase({
      databasePath: path.join(root, "migration.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      if (connection.database.open) connection.database.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const migrations = discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY });
    applyMigrations({
      database: connection.database,
      migrations: migrations.slice(0, 16),
      applicationBuildId: "m6-05-before",
      now: () => 1,
    });
    applyMigrations({
      database: connection.database,
      migrations: migrations.slice(0, 17),
      applicationBuildId: "m6-05-after",
      now: () => 2,
    });
    assert.equal(connection.database.pragma("user_version", { simple: true }), 17);
    const columns = connection.database.pragma("table_info(matchup_roster_locks)");
    assert.equal(columns.find(({ name }) => name === "baseline_snapshot_id").notnull, 0);
    assert.equal(columns.some(({ name }) => name === "legality_reason_code"), true);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_locks").get().count, 0);
    assert.deepEqual(connection.database.pragma("foreign_key_check"), []);
  });
});
