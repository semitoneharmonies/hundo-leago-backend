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
]);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-04-migration-"));
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

function seedLinkedAuction(database) {
  const ids = Object.freeze({
    user: uuid(1),
    league: uuid(2),
    season: uuid(3),
    team: uuid(4),
    player: uuid(5),
    ownership: uuid(6),
    ownershipEvent: uuid(7),
    auction: uuid(8),
    bid: uuid(9),
    auctionEvent: uuid(10),
    resolution: uuid(11),
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
    ) VALUES (?, 'League', 'league', 'active',
      'America/Vancouver', 10, 10)
  `).run(ids.league);
  database.prepare(`
    INSERT INTO seasons (
      id, league_id, label, nhl_season_key, status,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, '2026', '20262027', 'active', 10, 10)
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
    ) VALUES (?, ?, ?, ?, ?, 'Rostered', 'Active', 'F', 1,
      'migration', NULL, 20, 20, 2)
  `).run(ids.ownership, ids.league, ids.season, ids.player, ids.team);
  database.prepare(`
    INSERT INTO ownership_events (
      id, league_id, season_id, player_id, team_id, ownership_id,
      event_type, actor_user_id, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'seeded', ?, 20)
  `).run(
    ids.ownershipEvent,
    ids.league,
    ids.season,
    ids.player,
    ids.team,
    ids.ownership,
    ids.user
  );
  database.prepare(`
    INSERT INTO auctions (
      id, league_id, season_id, player_id, status,
      opened_at_ms, resolves_at_ms, opened_by_user_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'resolved', 20, 30, ?, 20, 30, 3)
  `).run(ids.auction, ids.league, ids.season, ids.player, ids.user);
  database.prepare(`
    INSERT INTO auction_bids (
      id, league_id, season_id, auction_id, team_id,
      submitted_by_user_id, total_value_cents, term_years,
      lowest_offered_aav_cents, first_submitted_at_ms,
      last_edited_at_ms, edit_count, status,
      idempotency_request_id, version
    ) VALUES (?, ?, ?, ?, ?, ?, 300, 1, 300, 20, 20, 0,
      'won', NULL, 2)
  `).run(ids.bid, ids.league, ids.season, ids.auction, ids.team, ids.user);
  database.prepare(`
    INSERT INTO auction_events (
      id, league_id, season_id, auction_id, bid_id, team_id,
      actor_user_id, event_type, metadata_json, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'auction_resolved', '{}', 30)
  `).run(
    ids.auctionEvent,
    ids.league,
    ids.season,
    ids.auction,
    ids.bid,
    ids.team,
    ids.user
  );
  database.prepare(`
    INSERT INTO auction_resolutions (
      id, league_id, season_id, auction_id, scheduled_occurrence_key,
      winning_team_id, winning_bid_id, highest_bid_cents,
      second_price_input_cents, final_contract_value_cents,
      contract_id, ownership_id, trigger_type, triggered_by_user_id,
      idempotency_key, status, resolved_at_ms
    ) VALUES (?, ?, ?, ?, 'auction:seed:30', ?, ?, 300, 0, 300,
      NULL, ?, 'commissioner', ?, 'seed-resolution', 'resolved', 30)
  `).run(
    ids.resolution,
    ids.league,
    ids.season,
    ids.auction,
    ids.team,
    ids.bid,
    ids.ownership,
    ids.user
  );
  return ids;
}

describe("M5-04 atomic auction-completion migration", () => {
  test("preserves linked rows and adds only the approved completion states", (t) => {
    const runtime = createRuntime(t);
    copyThrough(runtime, 10);
    migrate(runtime, "m5-04-before");
    const ids = seedLinkedAuction(runtime.database);
    const before = Object.fromEntries(
      [
        ["player_ownerships", ids.ownership],
        ["ownership_events", ids.ownershipEvent],
        ["auctions", ids.auction],
        ["auction_bids", ids.bid],
        ["auction_events", ids.auctionEvent],
      ].map(([table, id]) => [
        table,
        runtime.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id),
      ])
    );
    const oldResolution = runtime.database
      .prepare("SELECT * FROM auction_resolutions WHERE id = ?")
      .get(ids.resolution);

    copyThrough(runtime, 11);
    const result = migrate(runtime, "m5-04-upgrade");

    assert.equal(result.applied.length, 11);
    assert.equal(runtime.database.pragma("user_version", { simple: true }), 11);
    for (const [table, row] of Object.entries(before)) {
      assert.deepEqual(
        runtime.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id),
        row
      );
    }
    const resolution = runtime.database
      .prepare("SELECT * FROM auction_resolutions WHERE id = ?")
      .get(ids.resolution);
    for (const [key, value] of Object.entries(oldResolution)) {
      assert.equal(resolution[key], value);
    }
    assert.equal(resolution.outcome_code, "winner");
    assert.equal(resolution.winning_term_years, null);
    assert.equal(resolution.final_aav_cents, null);
    assert.equal(resolution.general_illegal, 0);
    assert.equal(resolution.warnings_json, "[]");
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "11"
    );

    runtime.database.prepare(`
      UPDATE auctions SET status = 'no_winner' WHERE id = ?
    `).run(ids.auction);
    runtime.database.prepare(`
      UPDATE auction_bids SET status = 'cancelled' WHERE id = ?
    `).run(ids.bid);
    assert.throws(
      () =>
        runtime.database.prepare(`
          UPDATE player_ownerships
          SET slot_number = NULL
          WHERE id = ?
        `).run(ids.ownership),
      /constraint/i
    );
    runtime.database.prepare(`
      UPDATE player_ownerships
      SET acquired_transaction_type = 'auction_resolution',
        slot_number = NULL
      WHERE id = ?
    `).run(ids.ownership);
    assert.equal(
      runtime.database
        .prepare("SELECT slot_number FROM player_ownerships WHERE id = ?")
        .get(ids.ownership).slot_number,
      null
    );
    assert.equal(
      runtime.database.pragma("integrity_check", { simple: true }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });
});
