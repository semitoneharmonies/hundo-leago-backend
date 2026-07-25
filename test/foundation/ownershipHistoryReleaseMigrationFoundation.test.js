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
const MIGRATION_NAMES = Object.freeze([
  "0001_initial.sql",
  "0002_add_pending_credential_setup_user_status.sql",
  "0003_add_league_invitation_team_workflow.sql",
  "0004_add_manager_transfer_intent.sql",
  "0005_add_team_logo_objects.sql",
  "0006_allow_rounded_contract_aav.sql",
  "0007_preserve_released_ownership_history.sql",
]);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-06-migration-"));
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

function copyThrough(runtime, count) {
  for (const fileName of MIGRATION_NAMES.slice(0, count)) {
    fs.copyFileSync(
      path.join(CANONICAL_MIGRATIONS, fileName),
      path.join(runtime.migrationsDirectory, fileName)
    );
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

function seedOwnershipHistory(database) {
  const ids = Object.freeze({
    user: uuid(1),
    league: uuid(2),
    season: uuid(3),
    team: uuid(4),
    player: uuid(5),
    ownership: uuid(6),
    event: uuid(7),
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
    INSERT INTO player_ownerships (
      id, league_id, season_id, player_id, team_id, ownership_kind,
      roster_category, position_group, slot_number,
      acquired_transaction_type, acquired_transaction_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, 'Prospect Right', 'Prospect', 'F', NULL,
      'entry_draft', NULL, 20, 20, 1)
  `).run(
    ids.ownership,
    ids.league,
    ids.season,
    ids.player,
    ids.team
  );
  database.prepare(`
    INSERT INTO ownership_events (
      id, league_id, season_id, player_id, team_id, ownership_id,
      event_type, actor_user_id, source_type, source_id,
      before_metadata_json, after_metadata_json, reason, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft_selected', ?, 'entry_draft', NULL,
      NULL, '{"ownershipKind":"Prospect Right"}', NULL, 20)
  `).run(
    ids.event,
    ids.league,
    ids.season,
    ids.player,
    ids.team,
    ids.ownership,
    ids.user
  );
  return ids;
}

describe("M4-06 released-ownership history migration", () => {
  test("preserves history and permits only the current ownership to be removed", (t) => {
    const runtime = createRuntime(t);
    copyThrough(runtime, 6);
    migrate(runtime, "m4-06-before");
    const ids = seedOwnershipHistory(runtime.database);
    const eventBefore = runtime.database
      .prepare("SELECT * FROM ownership_events WHERE id = ?")
      .get(ids.event);
    assert.throws(
      () =>
        runtime.database
          .prepare("DELETE FROM player_ownerships WHERE id = ?")
          .run(ids.ownership),
      /constraint/i
    );

    copyThrough(runtime, 7);
    migrate(runtime, "m4-06-upgrade");
    runtime.database
      .prepare("DELETE FROM player_ownerships WHERE id = ?")
      .run(ids.ownership);

    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM player_ownerships")
        .get().count,
      0
    );
    assert.deepEqual(
      runtime.database
        .prepare("SELECT * FROM ownership_events WHERE id = ?")
        .get(ids.event),
      eventBefore
    );
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      7
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "7"
    );
    assert.equal(
      runtime.database.pragma("integrity_check", { simple: true }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("retains season and team scope constraints after the rebuild", (t) => {
    const runtime = createRuntime(t);
    copyThrough(runtime, 7);
    migrate(runtime, "m4-06-scope");
    const ids = seedOwnershipHistory(runtime.database);
    assert.throws(
      () =>
        runtime.database.prepare(`
          INSERT INTO ownership_events (
            id, league_id, season_id, player_id, team_id,
            event_type, occurred_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'invalid_scope', 30)
        `).run(
          uuid(8),
          ids.league,
          uuid(999),
          ids.player,
          ids.team
        ),
      /constraint/i
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM ownership_events")
        .get().count,
      1
    );
  });
});
