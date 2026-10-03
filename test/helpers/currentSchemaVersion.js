const path = require("node:path");
const { discoverMigrations } = require("../../src/infrastructure/database/migrate");

const CURRENT_SCHEMA_VERSION = discoverMigrations({
  migrationsDirectory: path.resolve(__dirname, "../../database/migrations"),
}).at(-1).id;

module.exports = { CURRENT_SCHEMA_VERSION };
