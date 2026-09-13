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

const CANONICAL_MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(
      `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (` +
        `${columns.map((column) => `@${column}`).join(", ")})`
    )
    .run(values);
}

function copyMigrations(directory, maximumId) {
  for (const entry of fs.readdirSync(CANONICAL_MIGRATIONS)) {
    const id = Number(entry.slice(0, 4));
    if (Number.isSafeInteger(id) && id <= maximumId) {
      fs.copyFileSync(
        path.join(CANONICAL_MIGRATIONS, entry),
        path.join(directory, entry)
      );
    }
  }
}

function migrate(database, migrationsDirectory, buildId) {
  return applyMigrations({
    database,
    migrations: discoverMigrations({ migrationsDirectory }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function seed(database) {
  const ids = Object.freeze({
    league: uuid(1),
    season: uuid(2),
    teamA: uuid(3),
    teamB: uuid(4),
    finitePlayer: uuid(5),
    unplacedPlayer: uuid(6),
    finiteOwnership: uuid(7),
    unplacedOwnership: uuid(8),
  });
  insert(database, "leagues", {
    id: ids.league,
    name: "League",
    name_normalized: "league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 100,
    updated_at_ms: 100,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: 100,
    updated_at_ms: 100,
    version: 1,
    free_agent_draft_completed_at_ms: 100,
  });
  database
    .prepare("UPDATE leagues SET current_season_id = ?, version = 2 WHERE id = ?")
    .run(ids.season, ids.league);
  for (const [teamId, name] of [
    [ids.teamA, "Alpha"],
    [ids.teamB, "Bravo"],
  ]) {
    insert(database, "teams", {
      id: teamId,
      league_id: ids.league,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: 100,
      updated_at_ms: 100,
      version: 1,
    });
  }
  for (const [playerId, name] of [
    [ids.finitePlayer, "Finite Player"],
    [ids.unplacedPlayer, "Unplaced Player"],
  ]) {
    const [firstName, lastName] = name.split(" ");
    insert(database, "players", {
      id: playerId,
      first_name: firstName,
      last_name: lastName,
      full_name: name,
      birth_date: null,
      status: "active",
      created_at_ms: 100,
      updated_at_ms: 100,
      version: 1,
    });
  }
  insert(database, "player_ownerships", {
    id: ids.finiteOwnership,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.finitePlayer,
    team_id: ids.teamA,
    ownership_kind: "Rostered",
    roster_category: "Bench",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "migration",
    acquired_transaction_id: null,
    created_at_ms: 100,
    updated_at_ms: 100,
    version: 1,
  });
  insert(database, "player_ownerships", {
    id: ids.unplacedOwnership,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.unplacedPlayer,
    team_id: ids.teamA,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "D",
    slot_number: null,
    acquired_transaction_type: "auction_resolution",
    acquired_transaction_id: null,
    created_at_ms: 100,
    updated_at_ms: 100,
    version: 1,
  });
  return ids;
}

describe("M5-08 atomic trade-execution migration", () => {
  test("preserves ownership and permits only explicit unplaced trade transfers", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-08-migration-"));
    const migrationsDirectory = path.join(root, "migrations");
    fs.mkdirSync(migrationsDirectory);
    const connection = openDatabase({
      databasePath: path.join(root, "league.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      if (connection.database.open) connection.database.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    copyMigrations(migrationsDirectory, 12);
    migrate(connection.database, migrationsDirectory, "m5-08-before");
    const ids = seed(connection.database);
    const before = connection.database
      .prepare("SELECT * FROM player_ownerships ORDER BY id")
      .all();

    copyMigrations(migrationsDirectory, 13);
    const result = migrate(
      connection.database,
      migrationsDirectory,
      "m5-08-upgrade"
    );

    assert.equal(result.status, "exact");
    assert.equal(connection.database.pragma("user_version", { simple: true }), 13);
    assert.deepEqual(
      connection.database.prepare("SELECT * FROM player_ownerships ORDER BY id").all(),
      before
    );
    assert.equal(
      connection.database.prepare(
        "SELECT metadata_value FROM application_metadata WHERE metadata_key = 'data_model_version'"
      ).get().metadata_value,
      "13"
    );
    connection.database.prepare(`
      UPDATE player_ownerships
      SET team_id = ?, slot_number = NULL,
        acquired_transaction_type = 'trade_execution',
        acquired_transaction_id = ?, updated_at_ms = 200, version = version + 1
      WHERE id = ?
    `).run(ids.teamB, uuid(20), ids.finiteOwnership);
    assert.equal(
      connection.database
        .prepare("SELECT roster_category FROM player_ownerships WHERE id = ?")
        .get(ids.finiteOwnership).roster_category,
      "Bench"
    );
    assert.throws(
      () =>
        connection.database.prepare(`
          UPDATE player_ownerships
          SET acquired_transaction_type = 'migration'
          WHERE id = ?
        `).run(ids.finiteOwnership),
      /constraint/i
    );
    assert.equal(connection.database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(connection.database.pragma("foreign_key_check"), []);
  });
});
