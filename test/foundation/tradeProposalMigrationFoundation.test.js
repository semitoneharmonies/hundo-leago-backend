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
const MIGRATION_NAMES = Object.freeze([
  "0001_initial.sql",
  "0002_add_pending_credential_setup_user_status.sql",
  "0003_add_league_invitation_team_workflow.sql",
  "0004_add_manager_transfer_intent.sql",
  "0005_add_team_logo_objects.sql",
  "0006_allow_rounded_contract_aav.sql",
  "0007_preserve_released_ownership_history.sql",
  "0008_allow_optional_commissioner_correction_reason.sql",
  "0009_add_free_agent_draft_completion.sql",
  "0010_add_auction_bid_lowest_offered_aav.sql",
  "0011_add_atomic_auction_completion.sql",
  "0012_add_atomic_trade_proposal_assets.sql",
  "0013_add_atomic_trade_execution.sql",
]);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-06-migration-"));
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

function seedLegacyProposal(database) {
  const ids = Object.freeze({
    user: uuid(1),
    league: uuid(2),
    season: uuid(3),
    proposingTeam: uuid(4),
    receivingTeam: uuid(5),
    membership: uuid(6),
    legacyTrade: uuid(7),
    legacyAsset: uuid(8),
    targetTrade: uuid(9),
    targetAsset: uuid(10),
  });
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms, updated_at_ms
    ) VALUES (?, 'manager@example.test', 'manager@example.test',
      'Manager', 'manager', 'active', 10, 10)
  `).run(ids.user);
  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'League', 'league', 'active',
      'America/Vancouver', 10, 10)
  `).run(ids.league);
  database.prepare(`
    INSERT INTO seasons (
      id, league_id, label, nhl_season_key, status,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, '2026-27', '20262027', 'active', 10, 10)
  `).run(ids.season, ids.league);
  database.prepare(`
    INSERT INTO teams (
      id, league_id, name, name_normalized, status,
      created_at_ms, updated_at_ms
    ) VALUES
      (?, ?, 'Alpha', 'alpha', 'active', 10, 10),
      (?, ?, 'Bravo', 'bravo', 'active', 10, 10)
  `).run(
    ids.proposingTeam,
    ids.league,
    ids.receivingTeam,
    ids.league
  );
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 'manager', 'active', 10, 10, 10)
  `).run(ids.membership, ids.league, ids.user);
  database.prepare(`
    INSERT INTO trades (
      id, league_id, season_id, proposing_team_id, receiving_team_id,
      proposing_user_id, status, created_at_ms, expires_at_ms,
      updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', 100, 200, 100, 1)
  `).run(
    ids.legacyTrade,
    ids.league,
    ids.season,
    ids.proposingTeam,
    ids.receivingTeam,
    ids.user
  );
  database.prepare(`
    INSERT INTO trade_assets (
      id, league_id, trade_id, direction, source_team_id,
      destination_team_id, asset_type, requested_retention_cents,
      sequence, created_at_ms
    ) VALUES (?, ?, ?, 'proposing_to_receiving', ?, ?,
      'requested_retention', 25, 1, 100)
  `).run(
    ids.legacyAsset,
    ids.league,
    ids.legacyTrade,
    ids.proposingTeam,
    ids.receivingTeam
  );
  return ids;
}

describe("M5-06 atomic typed trade-proposal migration", () => {
  test("preserves legacy proposals and enforces complete target proposal evidence", (t) => {
    const runtime = createRuntime(t);
    copyThrough(runtime, 11);
    migrate(runtime, "m5-06-before");
    const ids = seedLegacyProposal(runtime.database);

    copyThrough(runtime, 12);
    const result = migrate(runtime, "m5-06-upgrade");

    assert.equal(result.applied.length, 12);
    assert.equal(runtime.database.pragma("user_version", { simple: true }), 12);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT creating_membership_id, creating_authority,
          effective_deadline_at_ms, proposal_model_version
        FROM trades WHERE id = ?
      `).get(ids.legacyTrade),
      {
        creating_membership_id: null,
        creating_authority: null,
        effective_deadline_at_ms: null,
        proposal_model_version: 1,
      }
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT requested_retention_contract_id,
          future_consideration_description, proposal_snapshot_json,
          asset_model_version
        FROM trade_assets WHERE id = ?
      `).get(ids.legacyAsset),
      {
        requested_retention_contract_id: null,
        future_consideration_description: null,
        proposal_snapshot_json: null,
        asset_model_version: 1,
      }
    );

    assert.throws(
      () => runtime.database.prepare(`
        INSERT INTO trades (
          id, league_id, season_id, proposing_team_id, receiving_team_id,
          proposing_user_id, status, created_at_ms, expires_at_ms,
          effective_deadline_at_ms, proposal_model_version,
          updated_at_ms, version
        ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', 200, 300, 250, 2, 200, 1)
      `).run(
        ids.targetTrade,
        ids.league,
        ids.season,
        ids.proposingTeam,
        ids.receivingTeam,
        ids.user
      ),
      /constraint/i
    );
    runtime.database.prepare(`
      INSERT INTO trades (
        id, league_id, season_id, proposing_team_id, receiving_team_id,
        proposing_user_id, creating_membership_id, creating_authority,
        status, created_at_ms, expires_at_ms, effective_deadline_at_ms,
        proposal_model_version, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manager', 'proposed',
        200, 300, 250, 2, 200, 1)
    `).run(
      ids.targetTrade,
      ids.league,
      ids.season,
      ids.proposingTeam,
      ids.receivingTeam,
      ids.user,
      ids.membership
    );
    assert.throws(
      () => runtime.database.prepare(`
        INSERT INTO trade_assets (
          id, league_id, trade_id, direction, source_team_id,
          destination_team_id, asset_type,
          future_consideration_description, asset_model_version,
          sequence, created_at_ms
        ) VALUES (?, ?, ?, 'proposing_to_receiving', ?, ?,
          'future_consideration', 'Future instruction', 2, 1, 200)
      `).run(
        ids.targetAsset,
        ids.league,
        ids.targetTrade,
        ids.proposingTeam,
        ids.receivingTeam
      ),
      /constraint/i
    );
    runtime.database.prepare(`
      INSERT INTO trade_assets (
        id, league_id, trade_id, direction, source_team_id,
        destination_team_id, asset_type,
        future_consideration_description, proposal_snapshot_json,
        asset_model_version, sequence, created_at_ms
      ) VALUES (?, ?, ?, 'proposing_to_receiving', ?, ?,
        'future_consideration', 'Future instruction',
        '{"schemaVersion":1,"type":"future_consideration_instruction"}',
        2, 1, 200)
    `).run(
      ids.targetAsset,
      ids.league,
      ids.targetTrade,
      ids.proposingTeam,
      ids.receivingTeam
    );

    assert.equal(
      runtime.database.prepare(`
        SELECT metadata_value FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).get().metadata_value,
      "12"
    );
    assert.equal(runtime.database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });
});
