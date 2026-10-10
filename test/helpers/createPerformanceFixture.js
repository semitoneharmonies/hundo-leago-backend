const fs = require("node:fs");
const path = require("node:path");
const { createReleaseQaFixture } = require("../../src/operations/release/createReleaseQaFixture");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");

// The release-QA seed verifier supports schema 55. Verify that seed first,
// then apply the current migrations to the isolated performance-test database.
async function createPerformanceFixture(options) {
  const seedMigrations = fs.mkdtempSync(path.join(options.temporaryRoot, "seed-migrations-"));
  try {
    for (const file of fs.readdirSync(options.migrationsDirectory)) {
      if (/^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 55) {
        fs.copyFileSync(path.join(options.migrationsDirectory, file), path.join(seedMigrations, file));
      }
    }
    const fixture = await createReleaseQaFixture({ ...options, migrationsDirectory: seedMigrations });
    const { database } = openDatabase({ databasePath: options.databasePath, environment: "test" });
    try {
      migrateDatabase({ database, migrationsDirectory: options.migrationsDirectory, applicationBuildId: "dashboard-performance-test" });
    } finally {
      database.close();
    }
    return fixture;
  } finally {
    fs.rmSync(seedMigrations, { recursive: true, force: true });
  }
}

module.exports = { createPerformanceFixture };
