"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

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
const DAY_MS = 86_400_000;
const WEEK_ONE_AT_MS = Date.parse("2026-10-05T07:00:00.000Z");
const DEADLINE_AT_MS = WEEK_ONE_AT_MS - 7 * DAY_MS;
const SOURCE_OPENS_AT_MS = DEADLINE_AT_MS;
const SOURCE_RESOLVES_AT_MS = DEADLINE_AT_MS + DAY_MS;
const FALLBACK_OPENS_AT_MS = SOURCE_RESOLVES_AT_MS;
const FALLBACK_RESOLVES_AT_MS = FALLBACK_OPENS_AT_MS + DAY_MS;
const LEASE_EXPIRES_AT_MS = SOURCE_RESOLVES_AT_MS + 60_000;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function createRuntime(t, prefix, maximumMigrationId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const migrationsDirectory = path.join(root, "migrations");
  fs.mkdirSync(migrationsDirectory);
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (migration.id > maximumMigrationId) continue;
    fs.copyFileSync(
      migration.filePath,
      path.join(migrationsDirectory, migration.fileName)
    );
  }
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({ migrationsDirectory }),
    applicationBuildId: `fad-fallback-overlap-${maximumMigrationId}`,
    now: () => 1_000,
  });
  return connection.database;
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database.prepare(`
    INSERT INTO ${tableName} (${columns.join(", ")})
    VALUES (${columns.map((column) => `@${column}`).join(", ")})
  `).run(values);
}

function captureAndDropTriggers(database) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  for (const { name } of triggers) {
    database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const { sql } of triggers) database.exec(sql);
}

function fixtureIds(base) {
  return Object.freeze({
    user: uuid(base + 1),
    league: uuid(base + 2),
    season: uuid(base + 3),
    week: uuid(base + 4),
    team: uuid(base + 5),
    player: uuid(base + 6),
    readiness: uuid(base + 7),
    fad: uuid(base + 8),
    sourceRollover: uuid(base + 9),
    targetRollover: uuid(base + 10),
    sourceAuction: uuid(base + 11),
    allocation: uuid(base + 12),
    sourceDraw: uuid(base + 13),
    sourceJob: uuid(base + 14),
    sourceLeaseToken: uuid(base + 15),
    sourceBid: uuid(base + 16),
    fallbackAuction: uuid(base + 17),
    fallbackDraw: uuid(base + 18),
    fallbackJob: uuid(base + 19),
    terminalEvent: uuid(base + 20),
    resolution: uuid(base + 21),
  });
}

function seedRestrictedSource(database, base) {
  const ids = fixtureIds(base);
  const triggers = captureAndDropTriggers(database);
  insert(database, "users", {
    id: ids.user,
    email_normalized: `fallback-${base}@example.test`,
    email_display: `fallback-${base}@example.test`,
    display_name: `Fallback ${base}`,
    display_name_normalized: `fallback ${base}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `Fallback ${base}`,
    name_normalized: `fallback ${base}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `2026-27 ${base}`,
    nhl_season_key: `fallback-${base}`,
    status: "active",
    regular_season_starts_at_ms: WEEK_ONE_AT_MS,
    regular_season_ends_at_ms: WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms: WEEK_ONE_AT_MS + 17 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms: WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  database.prepare(`
    UPDATE leagues SET current_season_id = ? WHERE id = ?
  `).run(ids.season, ids.league);
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `Fallback Team ${base}`,
    name_normalized: `fallback team ${base}`,
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    tertiary_colour: null,
    logo_reference: null,
    pattern_template: "even-two",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
    week_key: `fallback-${base}`,
    sequence: 1,
    starts_at_ms: WEEK_ONE_AT_MS,
    baseline_at_ms: WEEK_ONE_AT_MS + 1_000,
    locks_at_ms: WEEK_ONE_AT_MS + 2_000,
    ends_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "players", {
    id: ids.player,
    first_name: "Fallback",
    last_name: `Candidate ${base}`,
    full_name: `Fallback Candidate ${base}`,
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "free_agent_draft_readiness_operations", {
    id: ids.readiness,
    league_id: ids.league,
    season_id: ids.season,
    readiness_occurrence_key: `fad-readiness:${ids.league}:${ids.season}`,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: null,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    blockers_json: "[]",
    matchup_schedule_version_before: null,
    matchup_schedule_version_after: null,
    schedule_recovery_id: null,
    created_fad_id: null,
    reminder_job_run_id: null,
    deadline_job_run_id: null,
    cards_opened_activity_id: null,
    cards_opened_outbox_event_id: null,
    started_at_ms: null,
    next_retry_at_ms: null,
    terminal_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key: `fad-readiness:${ids.league}:${ids.season}`,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id: ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "rapid",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Focused schema-40 fixture.",
    opening_authority: "system",
    opened_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
    help_opens_at_ms: DEADLINE_AT_MS - 2 * DAY_MS,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: DEADLINE_AT_MS,
    allocation_completed_at_ms: DEADLINE_AT_MS + 1_000,
    completed_at_ms: null,
    created_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 4,
  });
  let predecessor = null;
  for (const rollover of [
    {
      id: ids.sourceRollover,
      sequence: 1,
      opensAtMs: SOURCE_OPENS_AT_MS,
      rollsOverAtMs: SOURCE_RESOLVES_AT_MS,
    },
    {
      id: ids.targetRollover,
      sequence: 2,
      opensAtMs: FALLBACK_OPENS_AT_MS,
      rollsOverAtMs: FALLBACK_RESOLVES_AT_MS,
    },
  ]) {
    insert(database, "free_agent_draft_rollovers", {
      id: rollover.id,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      sequence: rollover.sequence,
      window_kind: "initial",
      predecessor_rollover_id: predecessor,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: rollover.opensAtMs,
      creation_cutoff_at_ms: rollover.rollsOverAtMs - 3_600_000,
      rolls_over_at_ms: rollover.rollsOverAtMs,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
      updated_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
      version: 1,
    });
    predecessor = rollover.id;
  }
  insert(database, "auctions", {
    id: ids.sourceAuction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status: "open",
    opened_at_ms: SOURCE_OPENS_AT_MS,
    resolves_at_ms: SOURCE_RESOLVES_AT_MS,
    opened_by_user_id: null,
    created_at_ms: SOURCE_OPENS_AT_MS,
    updated_at_ms: SOURCE_OPENS_AT_MS,
    version: 1,
  });
  insert(database, "free_agent_draft_player_allocations", {
    id: ids.allocation,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    status: "restricted_active",
    decision_code: "exact_total_and_term_tie",
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: ids.sourceAuction,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: 600,
    restricted_minimum_term_years: 2,
    restricted_minimum_aav_cents: 300,
    accounted_at_ms: null,
    last_error_code: null,
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: SOURCE_OPENS_AT_MS,
    version: 2,
  });
  insert(database, "auction_contexts", {
    id: ids.sourceAuction,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.sourceAuction,
    source_kind: "fad_restricted",
    fad_id: ids.fad,
    fad_rollover_id: ids.sourceRollover,
    fad_allocation_id: ids.allocation,
    fad_origin: "candidate_tie_restricted",
    created_at_ms: SOURCE_OPENS_AT_MS,
  });
  insert(database, "free_agent_draft_draws", {
    id: ids.sourceDraw,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    auction_id: ids.sourceAuction,
    algorithm_version: 1,
    nonce_bytes: Buffer.alloc(32, 40),
    commitment_hex: sha256(`source-${base}`),
    ordered_tied_bid_ids_json: null,
    ordered_tied_team_ids_json: null,
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: null,
    created_at_ms: SOURCE_OPENS_AT_MS,
    updated_at_ms: SOURCE_OPENS_AT_MS,
    version: 1,
  });
  insert(database, "job_runs", {
    id: ids.sourceJob,
    league_id: ids.league,
    season_id: ids.season,
    job_type: "auction.resolve.target",
    occurrence_key: `auction:${ids.sourceAuction}:${SOURCE_RESOLVES_AT_MS}`,
    scheduled_for_ms: SOURCE_RESOLVES_AT_MS,
    status: "leased",
    attempt_count: 1,
    lease_owner: "schema40-worker",
    lease_expires_at_ms: LEASE_EXPIRES_AT_MS,
    started_at_ms: SOURCE_RESOLVES_AT_MS - 1,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: SOURCE_OPENS_AT_MS,
    updated_at_ms: SOURCE_RESOLVES_AT_MS - 1,
    version: 2,
    lease_token: ids.sourceLeaseToken,
    next_attempt_at_ms: null,
  });
  insert(database, "auction_bids", {
    id: ids.sourceBid,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.sourceAuction,
    team_id: ids.team,
    submitted_by_user_id: ids.user,
    total_value_cents: 700,
    term_years: 2,
    lowest_offered_aav_cents: 350,
    first_submitted_at_ms: SOURCE_OPENS_AT_MS + 1,
    last_edited_at_ms: SOURCE_OPENS_AT_MS + 1,
    edit_count: 0,
    status: "active",
    idempotency_request_id: null,
    version: 1,
  });
  restoreTriggers(database, triggers);
  return ids;
}

function fallbackAuctionRecord(ids, overrides = {}) {
  return {
    id: ids.fallbackAuction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status: "open",
    opened_at_ms: FALLBACK_OPENS_AT_MS,
    resolves_at_ms: FALLBACK_RESOLVES_AT_MS,
    opened_by_user_id: null,
    created_at_ms: SOURCE_RESOLVES_AT_MS,
    updated_at_ms: SOURCE_RESOLVES_AT_MS,
    version: 1,
    ...overrides,
  };
}

function prepareZeroImprovementSource(database, ids) {
  database.prepare(`
    UPDATE auctions
    SET status = 'resolving',
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ? AND status = 'open'
  `).run(SOURCE_RESOLVES_AT_MS, ids.league, ids.sourceAuction);
  database.prepare(`
    UPDATE auction_bids
    SET status = 'invalid', version = version + 1
    WHERE league_id = ? AND id = ? AND status = 'active'
  `).run(ids.league, ids.sourceBid);
}

function insertFallbackEvidence(database, ids) {
  insert(database, "auctions", fallbackAuctionRecord(ids));
  database.prepare(`
    UPDATE free_agent_draft_player_allocations
    SET status = 'restricted_fallback_open',
        decision_code = 'restricted_no_improvement_fallback',
        fallback_open_auction_id = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ? AND status = 'restricted_active'
  `).run(
    ids.fallbackAuction,
    SOURCE_RESOLVES_AT_MS,
    ids.league,
    ids.allocation
  );
  insert(database, "auction_contexts", {
    id: ids.fallbackAuction,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.fallbackAuction,
    source_kind: "fad_open_rapid",
    fad_id: ids.fad,
    fad_rollover_id: ids.targetRollover,
    fad_allocation_id: ids.allocation,
    fad_origin: "restricted_no_improvement_fallback",
    created_at_ms: SOURCE_RESOLVES_AT_MS,
  });
  insert(database, "free_agent_draft_draws", {
    id: ids.fallbackDraw,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    auction_id: ids.fallbackAuction,
    algorithm_version: 1,
    nonce_bytes: Buffer.alloc(32, 41),
    commitment_hex: sha256(`fallback-${ids.fallbackAuction}`),
    ordered_tied_bid_ids_json: null,
    ordered_tied_team_ids_json: null,
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: null,
    created_at_ms: FALLBACK_OPENS_AT_MS,
    updated_at_ms: FALLBACK_OPENS_AT_MS,
    version: 1,
  });
  insert(database, "job_runs", {
    id: ids.fallbackJob,
    league_id: ids.league,
    season_id: ids.season,
    job_type: "auction.resolve.target",
    occurrence_key: `auction:${ids.fallbackAuction}:${FALLBACK_RESOLVES_AT_MS}`,
    scheduled_for_ms: FALLBACK_RESOLVES_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: SOURCE_RESOLVES_AT_MS,
    updated_at_ms: SOURCE_RESOLVES_AT_MS,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: FALLBACK_RESOLVES_AT_MS,
  });
}

function terminalizeSource(database, ids) {
  insert(database, "auction_events", {
    id: ids.terminalEvent,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.sourceAuction,
    bid_id: null,
    team_id: null,
    actor_user_id: null,
    event_type: "auction_no_winner",
    metadata_json: JSON.stringify({
      outcome: "no_winner",
      resolutionId: ids.resolution,
    }),
    occurred_at_ms: SOURCE_RESOLVES_AT_MS,
  });
  insert(database, "auction_resolutions", {
    id: ids.resolution,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.sourceAuction,
    scheduled_occurrence_key:
      `auction:${ids.sourceAuction}:${SOURCE_RESOLVES_AT_MS}`,
    outcome_code: "no_winner",
    winning_team_id: null,
    winning_bid_id: null,
    highest_bid_cents: null,
    second_price_input_cents: null,
    final_contract_value_cents: null,
    winning_term_years: null,
    final_aav_cents: null,
    general_illegal: 0,
    warnings_json: "[]",
    contract_id: null,
    ownership_id: null,
    trigger_type: "automatic",
    triggered_by_user_id: null,
    idempotency_key:
      `auction:${ids.sourceAuction}:${SOURCE_RESOLVES_AT_MS}`,
    status: "no_winner",
    resolved_at_ms: SOURCE_RESOLVES_AT_MS,
  });
  database.prepare(`
    UPDATE free_agent_draft_draws
    SET ordered_tied_bid_ids_json = '[]',
        ordered_tied_team_ids_json = '[]',
        revealed_at_ms = ?,
        updated_at_ms = ?,
        version = 2
    WHERE league_id = ? AND id = ? AND version = 1
  `).run(
    SOURCE_RESOLVES_AT_MS,
    SOURCE_RESOLVES_AT_MS,
    ids.league,
    ids.sourceDraw
  );
  database.prepare(`
    UPDATE auctions
    SET status = 'no_winner',
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ? AND status = 'resolving'
  `).run(SOURCE_RESOLVES_AT_MS, ids.league, ids.sourceAuction);
  database.prepare(`
    UPDATE job_runs
    SET status = 'succeeded',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = ?,
        result_json = ?,
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ? AND status = 'leased'
  `).run(
    SOURCE_RESOLVES_AT_MS + 1,
    JSON.stringify({ auctionId: ids.sourceAuction, outcome: "no_winner" }),
    SOURCE_RESOLVES_AT_MS + 1,
    ids.league,
    ids.sourceJob
  );
}

test("schema 40 admits only the exact atomic restricted fallback overlap", (t) => {
  const schema39 = createRuntime(t, "fad-fallback-schema39-", 39);
  const schema39Ids = seedRestrictedSource(schema39, 500_000);
  prepareZeroImprovementSource(schema39, schema39Ids);
  assert.throws(
    () => insert(schema39, "auctions", fallbackAuctionRecord(schema39Ids)),
    /unique/i
  );

  const database = createRuntime(t, "fad-fallback-schema40-", 40);
  const ids = seedRestrictedSource(database, 510_000);
  assert.equal(
    database.prepare(`
      SELECT metadata_value
      FROM application_metadata
      WHERE metadata_key = 'data_model_version'
    `).pluck().get(),
    "40"
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*)
      FROM sqlite_schema
      WHERE type = 'index'
        AND name IN (
          'auctions_one_open_per_player',
          'auctions_one_resolving_per_player'
        )
    `).pluck().get(),
    2
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*)
      FROM sqlite_schema
      WHERE type = 'index'
        AND name = 'auctions_one_active_per_player'
    `).pluck().get(),
    0
  );
  assert.deepEqual(
    database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name IN (
          'auctions_restricted_fallback_overlap_insert',
          'auctions_active_overlap_update',
          'auction_contexts_restricted_fallback_full_window_insert'
        )
      ORDER BY name
    `).all(),
    [
      {
        name:
          "auction_contexts_restricted_fallback_full_window_insert",
      },
      { name: "auctions_active_overlap_update" },
      { name: "auctions_restricted_fallback_overlap_insert" },
    ]
  );

  database.prepare(`
    UPDATE auctions
    SET status = 'resolving', updated_at_ms = ?, version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(SOURCE_RESOLVES_AT_MS, ids.league, ids.sourceAuction);
  assert.throws(
    () => insert(database, "auctions", fallbackAuctionRecord(ids)),
    /exact restricted fallback handoff/i
  );
  database.prepare(`
    UPDATE auction_bids SET status = 'invalid', version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(ids.league, ids.sourceBid);
  assert.throws(
    () => insert(
      database,
      "auctions",
      fallbackAuctionRecord(ids, {
        resolves_at_ms: FALLBACK_RESOLVES_AT_MS - 1,
      })
    ),
    /exact restricted fallback handoff/i
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    insertFallbackEvidence(database, ids);
    terminalizeSource(database, ids);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  assert.deepEqual(
    database.prepare(`
      SELECT status, version
      FROM auctions
      WHERE league_id = ? AND id = ?
    `).get(ids.league, ids.sourceAuction),
    { status: "no_winner", version: 3 }
  );
  assert.deepEqual(
    database.prepare(`
      SELECT status, opened_at_ms AS openedAtMs,
             resolves_at_ms AS resolvesAtMs, version
      FROM auctions
      WHERE league_id = ? AND id = ?
    `).get(ids.league, ids.fallbackAuction),
    {
      status: "open",
      openedAtMs: FALLBACK_OPENS_AT_MS,
      resolvesAtMs: FALLBACK_RESOLVES_AT_MS,
      version: 1,
    }
  );
  assert.deepEqual(
    database.prepare(`
      SELECT status, decision_code AS decisionCode,
             fallback_open_auction_id AS fallbackAuctionId,
             version
      FROM free_agent_draft_player_allocations
      WHERE league_id = ? AND id = ?
    `).get(ids.league, ids.allocation),
    {
      status: "restricted_fallback_open",
      decisionCode: "restricted_no_improvement_fallback",
      fallbackAuctionId: ids.fallbackAuction,
      version: 3,
    }
  );
  assert.deepEqual(
    database.prepare(`
      SELECT version,
             ordered_tied_bid_ids_json AS bidIds,
             ordered_tied_team_ids_json AS teamIds,
             selected_bid_id AS selectedBidId,
             selected_team_id AS selectedTeamId
      FROM free_agent_draft_draws
      WHERE league_id = ? AND id = ?
    `).get(ids.league, ids.sourceDraw),
    {
      version: 2,
      bidIds: "[]",
      teamIds: "[]",
      selectedBidId: null,
      selectedTeamId: null,
    }
  );
  assert.deepEqual(
    database.prepare(`
      SELECT status, outcome_code AS outcomeCode
      FROM auction_resolutions
      WHERE league_id = ? AND id = ?
    `).get(ids.league, ids.resolution),
    { status: "no_winner", outcomeCode: "no_winner" }
  );
  assert.deepEqual(
    database.prepare(`
      SELECT status, attempt_count AS attemptCount,
             next_attempt_at_ms AS nextAttemptAtMs
      FROM job_runs
      WHERE league_id = ? AND id = ?
    `).get(ids.league, ids.fallbackJob),
    {
      status: "pending",
      attemptCount: 0,
      nextAttemptAtMs: FALLBACK_RESOLVES_AT_MS,
    }
  );
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(database.pragma("foreign_key_check"), []);
});
