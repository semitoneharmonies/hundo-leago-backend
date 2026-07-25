const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createSqlitePlayerCatalogRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");

const ROOT = path.resolve(__dirname, "..", "..");

function nextIdFactory() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function catalogRow(overrides = {}) {
  return {
    providerPlayerId: "101",
    firstName: "Ada",
    lastName: "Skater",
    fullName: "Ada Skater",
    birthDate: "1998-02-03",
    status: "active",
    sourcePosition: "LW",
    normalizedPosition: "F",
    nhlTeamAbbreviation: "VAN",
    active: true,
    sourceVersion: "2025-04-18T12:00:00Z",
    sourceUpdatedAtMs: Date.parse("2025-04-18T12:00:00Z"),
    ...overrides,
  };
}

test("SQLite player catalog persistence is transactional, idempotent, and keeps provider state history", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-player-catalog-"));
  const databasePath = path.join(root, "catalog.sqlite3");
  const connection = openDatabase({ databasePath, environment: "test" });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: path.join(ROOT, "database", "migrations"),
    applicationBuildId: "player-catalog-test",
    now: () => 1_700_000_000_000,
  });
  const repository = createSqlitePlayerCatalogRepository({
    database: connection.database,
    createId: nextIdFactory(),
  });
  const command = {
    provider: "sportsdataio-discovery-lab",
    capturedAtMs: 1_700_000_000_000,
    rows: [catalogRow(), catalogRow({
      providerPlayerId: "102",
      firstName: "Bea",
      lastName: "Defender",
      fullName: "Bea Defender",
      sourcePosition: "D",
      normalizedPosition: "D",
      nhlTeamAbbreviation: "EDM",
    })],
  };

  assert.deepEqual(repository.applyCatalog(command), {
    createdPlayerCount: 2,
    sourceStateChangeCount: 2,
    updatedPlayerCount: 0,
  });
  assert.deepEqual(repository.applyCatalog(command), {
    createdPlayerCount: 0,
    sourceStateChangeCount: 0,
    updatedPlayerCount: 0,
  });
  assert.deepEqual(repository.applyCatalog({
    ...command,
    capturedAtMs: command.capturedAtMs + 1,
    rows: [catalogRow({
      nhlTeamAbbreviation: "SEA",
      sourceVersion: "2025-04-19T12:00:00Z",
    }), command.rows[1]],
  }), {
    createdPlayerCount: 0,
    sourceStateChangeCount: 1,
    updatedPlayerCount: 0,
  });

  assert.equal(
    connection.database.prepare("SELECT COUNT(*) AS count FROM players").get().count,
    2
  );
  assert.equal(
    connection.database.prepare("SELECT COUNT(*) AS count FROM player_external_ids").get().count,
    2
  );
  assert.equal(
    connection.database.prepare("SELECT COUNT(*) AS count FROM player_source_state").get().count,
    3
  );
  assert.deepEqual(
    connection.database.prepare(
      "SELECT nhl_team_abbreviation AS team FROM player_source_state WHERE ended_at_ms IS NULL ORDER BY player_id"
    ).all().map(({ team }) => team),
    ["SEA", "EDM"]
  );
});
