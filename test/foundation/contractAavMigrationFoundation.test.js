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
const CANONICAL_MIGRATIONS = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-05-migration-"));
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
  return { ...connection, migrationsDirectory };
}

function copyMigration(fileName, directory) {
  fs.copyFileSync(
    path.join(CANONICAL_MIGRATIONS, fileName),
    path.join(directory, fileName)
  );
}

function copyThrough(runtime, lastId) {
  const names = [
    "0001_initial.sql",
    "0002_add_pending_credential_setup_user_status.sql",
    "0003_add_league_invitation_team_workflow.sql",
    "0004_add_manager_transfer_intent.sql",
    "0005_add_team_logo_objects.sql",
    "0006_allow_rounded_contract_aav.sql",
  ];
  for (let index = 0; index < lastId; index += 1) {
    copyMigration(names[index], runtime.migrationsDirectory);
  }
}

function migrate(runtime, buildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function seedLinkedContract(database) {
  const ids = Object.freeze({
    user: uuid(1),
    league: uuid(2),
    season: uuid(3),
    team: uuid(4),
    player: uuid(5),
    contract: uuid(6),
    year: uuid(7),
    event: uuid(8),
    retention: uuid(9),
    buyout: uuid(10),
  });
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms, updated_at_ms
    ) VALUES (?, 'user@example.test', 'user@example.test',
      'User', 'user', 'active', 10, 10)
  `).run(ids.user);
  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'League', 'league', 'setup',
      'America/Vancouver', 10, 10)
  `).run(ids.league);
  database.prepare(`
    INSERT INTO seasons (
      id, league_id, label, nhl_season_key, status,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'Season', '20262027', 'planned', 10, 10)
  `).run(ids.season, ids.league);
  database.prepare(`
    INSERT INTO teams (
      id, league_id, name, name_normalized, status,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'Team', 'team', 'active', 10, 10)
  `).run(ids.team, ids.league);
  database.prepare(`
    INSERT INTO players (
      id, first_name, last_name, full_name, status,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'Player', 'One', 'Player One', 'active', 10, 10)
  `).run(ids.player);
  database.prepare(`
    INSERT INTO contracts (
      id, league_id, player_id, current_team_id, contract_type,
      original_total_value_cents, original_term_years, aav_cents,
      start_season_id, status, acquisition_source_type,
      acquisition_source_id, auction_buyout_lock_expires_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'normal', 900, 3, 300, ?, 'active',
      'migration', NULL, NULL, 20, 20, 2)
  `).run(ids.contract, ids.league, ids.player, ids.team, ids.season);
  database.prepare(`
    INSERT INTO contract_years (
      id, league_id, contract_id, season_id, year_number,
      aav_cents, status, rollover_at_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, 1, 300, 'current', NULL, 20)
  `).run(ids.year, ids.league, ids.contract, ids.season);
  database.prepare(`
    INSERT INTO contract_events (
      id, league_id, contract_id, player_id, team_id,
      actor_user_id, event_type, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'seed', 20)
  `).run(
    ids.event,
    ids.league,
    ids.contract,
    ids.player,
    ids.team,
    ids.user
  );
  database.prepare(`
    INSERT INTO retention_obligations (
      id, league_id, contract_id, player_id, originating_team_id,
      responsible_team_id, retained_aav_cents, status,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 50, 'active', 20, 20)
  `).run(
    ids.retention,
    ids.league,
    ids.contract,
    ids.player,
    ids.team,
    ids.team
  );
  database.prepare(`
    INSERT INTO buyout_obligations (
      id, league_id, contract_id, player_id, originating_team_id,
      responsible_team_id, annual_penalty_basis_cents,
      buyout_transaction_id, status, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 75, 'seed-buyout', 'active', 20, 20)
  `).run(
    ids.buyout,
    ids.league,
    ids.contract,
    ids.player,
    ids.team,
    ids.team
  );
  return ids;
}

function insertContract(database, ids, {
  id,
  total,
  term,
  aav,
}) {
  database.prepare(`
    INSERT INTO contracts (
      id, league_id, player_id, current_team_id, contract_type,
      original_total_value_cents, original_term_years, aav_cents,
      start_season_id, status, acquisition_source_type,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'normal', ?, ?, ?, ?, 'active',
      'migration', 30, 30)
  `).run(
    id,
    ids.league,
    uuid(Number(id.slice(-12)) + 100),
    ids.team,
    total,
    term,
    aav,
    ids.season
  );
}

describe("M4-05 rounded-AAV contract migration", () => {
  test("preserves linked contract rows and every approved relationship", (t) => {
    const runtime = createRuntime(t);
    copyThrough(runtime, 5);
    migrate(runtime, "m4-05-before");
    const ids = seedLinkedContract(runtime.database);
    const before = runtime.database
      .prepare("SELECT * FROM contracts WHERE id = ?")
      .get(ids.contract);

    copyMigration(
      "0006_allow_rounded_contract_aav.sql",
      runtime.migrationsDirectory
    );
    const result = migrate(runtime, "m4-05-upgrade");

    assert.equal(result.applied.length, 6);
    assert.equal(runtime.database.pragma("user_version", { simple: true }), 6);
    assert.deepEqual(
      runtime.database
        .prepare("SELECT * FROM contracts WHERE id = ?")
        .get(ids.contract),
      before
    );
    for (const [tableName, id] of [
      ["contract_years", ids.year],
      ["contract_events", ids.event],
      ["retention_obligations", ids.retention],
      ["buyout_obligations", ids.buyout],
    ]) {
      assert.equal(
        runtime.database
          .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE id = ?`)
          .get(id).count,
        1
      );
    }
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "6"
    );
    assert.equal(
      runtime.database.pragma("integrity_check", { simple: true }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("accepts nearest-cent AAV and rejects any other value", (t) => {
    const runtime = createRuntime(t);
    copyThrough(runtime, 6);
    migrate(runtime, "m4-05-contract");
    const ids = seedLinkedContract(runtime.database);
    for (const playerValue of [105, 106]) {
      runtime.database.prepare(`
        INSERT INTO players (
          id, first_name, last_name, full_name, status,
          created_at_ms, updated_at_ms
        ) VALUES (?, 'Player', ?, ?, 'active', 10, 10)
      `).run(
        uuid(playerValue),
        String(playerValue),
        `Player ${playerValue}`
      );
    }
    insertContract(runtime.database, ids, {
      id: uuid(5),
      total: 1_000,
      term: 3,
      aav: 333,
    });
    assert.throws(
      () =>
        insertContract(runtime.database, ids, {
          id: uuid(6),
          total: 1_000,
          term: 3,
          aav: 334,
        }),
      /constraint/i
    );
  });
});
