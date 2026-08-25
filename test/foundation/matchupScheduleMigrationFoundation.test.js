const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");

describe("M6-02 matchup display-context migration", () => {
  test("adds strict pairing and bye display-context columns without creating rows", (t) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-02-migration-"));
    const connection = openDatabase({
      databasePath: path.join(temporaryRoot, "migration.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      if (connection.database.open) connection.database.close();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });
    const migrations = discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY });
    applyMigrations({
      database: connection.database,
      migrations: migrations.slice(0, 14),
      applicationBuildId: "m6-02-before",
    });
    applyMigrations({
      database: connection.database,
      migrations: migrations.slice(0, 15),
      applicationBuildId: "m6-02-after",
    });

    assert.equal(connection.database.pragma("user_version", { simple: true }), 15);
    assert.equal(
      connection.database.prepare(
        "SELECT strict FROM pragma_table_list WHERE name = 'matchups'"
      ).get().strict,
      1
    );
    assert.deepEqual(
      connection.database.pragma("table_info(matchups)")
        .map(({ name }) => name)
        .filter((name) => name.endsWith("_team_name")),
      ["home_team_name", "away_team_name"]
    );
    assert.equal(
      connection.database.pragma("table_info(matchup_byes)")
        .some(({ name }) => name === "team_display_name"),
      true
    );
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM matchups").get().count, 0);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM matchup_byes").get().count, 0);
    assert.deepEqual(connection.database.pragma("foreign_key_check"), []);
  });
});
