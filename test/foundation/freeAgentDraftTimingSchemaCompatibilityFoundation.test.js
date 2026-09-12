const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const { discoverMigrations, applyMigrations } = require("../../src/infrastructure/database/migrate");
const { createSqliteFreeAgentDraftReadRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadRepository");

test("timing reads support pinned older schemas but reject missing columns in declared schema56", () => {
  const database = new Database(":memory:");
  try {
    const migrations = discoverMigrations({ migrationsDirectory: path.resolve(__dirname, "../../database/migrations") });
    applyMigrations({ database, migrations: migrations.slice(0, 55), applicationBuildId: "timing-legacy-compatibility" });
    const before = database.prepare("SELECT total_changes() AS count").get().count;
    assert.doesNotThrow(() => createSqliteFreeAgentDraftReadRepository({ database }));
    assert.equal(database.prepare("SELECT total_changes() AS count").get().count, before);
    database.pragma("user_version = 56");
    assert.throws(() => createSqliteFreeAgentDraftReadRepository({ database }), error => error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE");
    assert.equal(database.prepare("SELECT total_changes() AS count").get().count, before);
    database.pragma("user_version = 55");
    applyMigrations({ database, migrations, applicationBuildId: "timing-current-compatibility" });
    const after = database.prepare("SELECT total_changes() AS count").get().count;
    assert.doesNotThrow(() => createSqliteFreeAgentDraftReadRepository({ database }));
    assert.equal(database.prepare("SELECT total_changes() AS count").get().count, after);
  } finally { database.close(); }
});
