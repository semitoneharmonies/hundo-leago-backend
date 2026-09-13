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
    applicationBuildId: `fad-resolution-resume-${maximumMigrationId}`,
    now: () => 1_000,
  });
  return {
    database: connection.database,
    migrationsDirectory,
  };
}

function upgradeToSchema41(runtime) {
  const migration = discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  }).find(({ id }) => id === 41);
  assert.ok(migration);
  fs.copyFileSync(
    migration.filePath,
    path.join(runtime.migrationsDirectory, migration.fileName)
  );
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: "fad-resolution-resume-upgrade-41",
    now: () => 2_000,
  });
}

function upgradeToSchema43(runtime) {
  const migration = discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  }).find(({ id }) => id === 43);
  assert.ok(migration);
  fs.copyFileSync(
    migration.filePath,
    path.join(runtime.migrationsDirectory, migration.fileName)
  );
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: "fad-resolution-repeat-upgrade-43",
    now: () => 3_000,
  });
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

const FAILURE_CODE = "AUCTION_RESOLUTION_FAILED";

function retryTimeline(resolvesAtMs) {
  const failureAtMs = resolvesAtMs + 1_000;
  const retryAcceptedAtMs = failureAtMs + 1_000;
  const claimedAtMs = retryAcceptedAtMs + 1_000;
  return Object.freeze({
    failureAtMs,
    retryAcceptedAtMs,
    claimedAtMs,
    claimLeaseExpiresAtMs: claimedAtMs + 60_000,
  });
}

function retryIds(base) {
  return Object.freeze({
    membership: uuid(base + 30),
    recovery: uuid(base + 31),
    failureEvent: uuid(base + 32),
    idempotency: uuid(base + 33),
    receipt: uuid(base + 34),
    claimLeaseToken: uuid(base + 35),
  });
}

function requestEvidence(
  ids,
  retry,
  auctionId,
  jobId,
  timeline
) {
  const reason = "Retry the failed FAD auction resolution.";
  const occurrenceKey =
    `auction:${auctionId}:${auctionId === ids.sourceAuction
      ? SOURCE_RESOLVES_AT_MS
      : FALLBACK_RESOLVES_AT_MS}`;
  const requestJson = JSON.stringify({
    body: {
      action: "retry_auction_resolution",
      reason,
      resourceId: auctionId,
    },
    domain:
      "hundo-leago.free-agent-draft-recovery-action-request",
    fadId: ids.fad,
    leagueId: ids.league,
    schemaVersion: 1,
  });
  const responseJson = JSON.stringify({
    acceptedAtMs: timeline.retryAcceptedAtMs,
    action: "retry_auction_resolution",
    occurrenceKey,
    operationId: jobId,
    pollDescriptor: {
      fadId: ids.fad,
      kind: "fad_recovery",
      leagueId: ids.league,
    },
    resourceId: auctionId,
    status: "pending",
  });
  return Object.freeze({
    occurrenceKey,
    reason,
    requestJson,
    requestSha256: sha256(requestJson),
    responseJson,
    responseSha256: sha256(responseJson),
  });
}

function installRetryEvidence(
  database,
  ids,
  retry,
  {
    contextKind,
    corrupt = null,
  }
) {
  const fallback = contextKind === "fallback";
  const auctionId = fallback
    ? ids.fallbackAuction
    : ids.sourceAuction;
  const drawId = fallback
    ? ids.fallbackDraw
    : ids.sourceDraw;
  const jobId = fallback
    ? ids.fallbackJob
    : ids.sourceJob;
  const rolloverId = fallback
    ? ids.targetRollover
    : ids.sourceRollover;
  const resolvesAtMs = fallback
    ? FALLBACK_RESOLVES_AT_MS
    : SOURCE_RESOLVES_AT_MS;
  const timeline = retryTimeline(resolvesAtMs);
  const targetStatus = fallback
    ? "restricted_fallback_open"
    : "restricted_active";
  const decisionCode = fallback
    ? "restricted_no_improvement_fallback"
    : "exact_total_and_term_tie";
  const evidence =
    requestEvidence(
      ids,
      retry,
      auctionId,
      jobId,
      timeline
    );
  const triggers = captureAndDropTriggers(database);
  insert(database, "league_memberships", {
    id: retry.membership,
    league_id: ids.league,
    user_id: ids.user,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?
    WHERE id = ?
  `).run(retry.membership, ids.league);

  if (fallback) {
    database.prepare(`
      UPDATE auctions
      SET status = 'no_winner',
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ? AND id = ?
    `).run(
      SOURCE_RESOLVES_AT_MS,
      ids.league,
      ids.sourceAuction
    );
    insert(database, "auctions", {
      ...fallbackAuctionRecord(ids),
      status: "failed",
      updated_at_ms: timeline.failureAtMs,
      version: 2,
    });
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
      created_at_ms: FALLBACK_OPENS_AT_MS,
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
      commitment_hex: sha256(
        `fallback-resume-${ids.fallbackAuction}`
      ),
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
      occurrence_key: evidence.occurrenceKey,
      scheduled_for_ms: FALLBACK_RESOLVES_AT_MS,
      status: "pending",
      attempt_count: 1,
      lease_owner: null,
      lease_expires_at_ms: null,
      started_at_ms: null,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      created_at_ms: FALLBACK_OPENS_AT_MS,
      updated_at_ms: timeline.retryAcceptedAtMs,
      version: 4,
      lease_token: null,
      next_attempt_at_ms: timeline.retryAcceptedAtMs,
    });
  } else {
    database.prepare(`
      UPDATE auctions
      SET status = 'failed',
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ?
    `).run(
      timeline.failureAtMs,
      ids.league,
      ids.sourceAuction
    );
    database.prepare(`
      UPDATE job_runs
      SET status = 'pending',
          attempt_count = 1,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          started_at_ms = NULL,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          next_attempt_at_ms = ?,
          updated_at_ms = ?,
          version = 4
      WHERE league_id = ? AND id = ?
    `).run(
      timeline.retryAcceptedAtMs,
      timeline.retryAcceptedAtMs,
      ids.league,
      ids.sourceJob
    );
  }

  database.prepare(`
    UPDATE free_agent_draft_player_allocations
    SET status = 'correction_required',
        decision_code = ?,
        fallback_open_auction_id = ?,
        accounted_at_ms = NULL,
        last_error_code = ?,
        updated_at_ms = ?,
        version = 3
    WHERE league_id = ? AND id = ?
  `).run(
    decisionCode,
    fallback ? ids.fallbackAuction : null,
    FAILURE_CODE,
    timeline.failureAtMs,
    ids.league,
    ids.allocation
  );
  insert(database, "free_agent_draft_recoveries", {
    id: retry.recovery,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    allocation_id: ids.allocation,
    rollover_id: rolloverId,
    auction_id: auctionId,
    job_run_id: jobId,
    kind: "auction_resolution",
    status: "running",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: resolvesAtMs,
    last_error_code: FAILURE_CODE,
    commissioner_reason: evidence.reason,
    created_by_operation_id: jobId,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: timeline.failureAtMs,
    updated_at_ms: timeline.retryAcceptedAtMs,
    resolved_at_ms: null,
    version: 2,
  });
  insert(database, "auction_events", {
    id: retry.failureEvent,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: auctionId,
    bid_id: null,
    team_id: null,
    actor_user_id: null,
    event_type: "fad_auction_resolution_failed",
    metadata_json: JSON.stringify({
      errorCode:
        corrupt === "failure_error"
          ? "WRONG_ERROR"
          : FAILURE_CODE,
      jobRunId: jobId,
      recoveryId: retry.recovery,
    }),
    occurred_at_ms: timeline.failureAtMs,
  });
  if (corrupt !== "missing_receipt") {
    insert(database, "idempotency_requests", {
      id: retry.idempotency,
      league_id: ids.league,
      actor_user_id: ids.user,
      operation: "free_agent_draft.recovery.action",
      client_key: `retry:${retry.recovery}`,
      request_hash: evidence.requestSha256,
      status: "completed",
      result_type:
        "free_agent_draft_recovery_action_command_result",
      result_id: retry.receipt,
      created_at_ms: timeline.retryAcceptedAtMs,
      completed_at_ms: timeline.retryAcceptedAtMs,
      expires_at_ms: timeline.retryAcceptedAtMs + DAY_MS,
    });
    insert(
      database,
      "free_agent_draft_recovery_action_command_results",
      {
        id: retry.receipt,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        recovery_id: retry.recovery,
        idempotency_request_id: retry.idempotency,
        action: "retry_auction_resolution",
        resource_kind: "auction",
        resource_id: auctionId,
        operation_id: jobId,
        job_run_id: jobId,
        occurrence_key: evidence.occurrenceKey,
        actor_user_id: ids.user,
        actor_membership_id: retry.membership,
        actor_authority: "commissioner",
        commissioner_reason: evidence.reason,
        request_json: evidence.requestJson,
        request_sha256: evidence.requestSha256,
        accepted_status: "pending",
        accepted_at_ms: timeline.retryAcceptedAtMs,
        response_http_status: 202,
        response_json: evidence.responseJson,
        response_sha256: evidence.responseSha256,
        version: 1,
      }
    );
  }
  if (corrupt === "revealed_draw") {
    database.prepare(`
      UPDATE free_agent_draft_draws
      SET ordered_tied_bid_ids_json = '[]',
          ordered_tied_team_ids_json = '[]',
          revealed_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ?
    `).run(
      timeline.failureAtMs,
      timeline.failureAtMs,
      ids.league,
      drawId
    );
  }
  restoreTriggers(database, triggers);
  return Object.freeze({
    auctionId,
    drawId,
    jobId,
    targetStatus,
    timeline,
  });
}

function claimAndResume(
  database,
  ids,
  retry,
  state,
  {
    mutateAllocation = false,
    leaseExpiresAtMs = state.timeline.claimLeaseExpiresAtMs,
  } = {}
) {
  let stage = "begin";
  database.exec("BEGIN IMMEDIATE");
  try {
    stage = "claim job";
    const claimed = database.prepare(`
      UPDATE job_runs
      SET status = 'running',
          attempt_count = attempt_count + 1,
          lease_owner = 'fad41-worker',
          lease_token = ?,
          lease_expires_at_ms = ?,
          started_at_ms = ?,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
        AND status = 'pending'
        AND next_attempt_at_ms <= ?
    `).run(
      retry.claimLeaseToken,
      leaseExpiresAtMs,
      state.timeline.claimedAtMs,
      state.timeline.claimedAtMs,
      ids.league,
      state.jobId,
      state.timeline.claimedAtMs
    );
    assert.equal(claimed.changes, 1);
    stage = "resume auction";
    const auction = database.prepare(`
      UPDATE auctions
      SET status = 'resolving',
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
        AND status = 'failed'
    `).run(
      state.timeline.claimedAtMs,
      ids.league,
      state.auctionId
    );
    assert.equal(auction.changes, 1);
    stage = "resume allocation";
    const allocation = database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = ?,
          restricted_minimum_total_cents =
            restricted_minimum_total_cents + ?,
          last_error_code = NULL,
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
        AND status = 'correction_required'
    `).run(
      state.targetStatus,
      mutateAllocation ? 100 : 0,
      state.timeline.claimedAtMs,
      ids.league,
      ids.allocation
    );
    assert.equal(allocation.changes, 1);
    stage = "commit";
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    const wrapped = new Error(`${stage}: ${error.message}`, {
      cause: error,
    });
    wrapped.code = error.code;
    throw wrapped;
  }
}

function allocationProjection(database, ids) {
  return database.prepare(`
    SELECT status, decision_code AS decisionCode,
           restricted_auction_id AS restrictedAuctionId,
           fallback_open_auction_id AS fallbackAuctionId,
           restricted_minimum_total_cents AS minimumTotal,
           restricted_minimum_term_years AS minimumTerm,
           restricted_minimum_aav_cents AS minimumAav,
           accounted_at_ms AS accountedAtMs,
           last_error_code AS lastErrorCode,
           updated_at_ms AS updatedAtMs,
           version
    FROM free_agent_draft_player_allocations
    WHERE league_id = ? AND id = ?
  `).get(ids.league, ids.allocation);
}

function schemaDefinitions(database) {
  return database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}

test(
  "schema 41 resumes only the exact failed allocation-linked FAD resolution retry",
  (t) => {
    const schema40Runtime = createRuntime(
      t,
      "fad-resolution-resume-schema40-",
      40
    );
    const { database: schema40 } = schema40Runtime;
    const beforeDefinitions =
      schemaDefinitions(schema40);
    const ids40 = seedRestrictedSource(
      schema40,
      610_000
    );
    const retry40 = retryIds(610_000);
    const state40 = installRetryEvidence(
      schema40,
      ids40,
      retry40,
      { contextKind: "restricted" }
    );
    assert.throws(
      () =>
        claimAndResume(
          schema40,
          ids40,
          retry40,
          state40
        ),
      /allocation may only follow/i
    );
    assert.equal(
      schema40.pragma("user_version", {
        simple: true,
      }),
      40
    );
    assert.equal(
      allocationProjection(schema40, ids40).status,
      "correction_required"
    );

    const upgrade = upgradeToSchema41(schema40Runtime);
    assert.equal(upgrade.status, "exact");
    assert.equal(
      schema40.pragma("user_version", {
        simple: true,
      }),
      41
    );
    claimAndResume(
      schema40,
      ids40,
      retry40,
      state40
    );
    assert.equal(
      allocationProjection(schema40, ids40).status,
      "restricted_active"
    );

    const { database } = createRuntime(
      t,
      "fad-resolution-resume-schema41-",
      41
    );
    assert.equal(
      database.pragma("user_version", {
        simple: true,
      }),
      41
    );
    assert.equal(
      database.prepare(`
        SELECT metadata_value
        FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).pluck().get(),
      "41"
    );
    assert.deepEqual(
      database.prepare(`
        SELECT migration_id, file_name
        FROM schema_migrations
        WHERE migration_id = 41
      `).get(),
      {
        migration_id: 41,
        file_name:
          "0041_allow_fad_auction_resolution_recovery_resume.sql",
      }
    );
    const afterDefinitions =
      schemaDefinitions(database);
    assert.deepEqual(
      afterDefinitions
        .filter(
          ({ name }) =>
            name !==
            "free_agent_draft_allocations_forward_update"
        ),
      beforeDefinitions.filter(
        ({ name }) =>
          name !==
          "free_agent_draft_allocations_forward_update"
      )
    );
    const triggerSql = afterDefinitions.find(
      ({ name }) =>
        name ===
        "free_agent_draft_allocations_forward_update"
    ).sql;
    assert.match(
      triggerSql,
      /OLD\.status = 'correction_required'/
    );
    assert.match(
      triggerSql,
      /receipt\.action =\s*'retry_auction_resolution'/
    );
    assert.match(
      triggerSql,
      /draw\.revealed_at_ms IS NULL/
    );
    assert.match(
      triggerSql,
      /job\.lease_token IS NOT NULL/
    );

    for (const [index, contextKind] of [
      [0, "restricted"],
      [1, "fallback"],
    ]) {
      const base = 620_000 + index * 1_000;
      const ids = seedRestrictedSource(database, base);
      const retry = retryIds(base);
      const state = installRetryEvidence(
        database,
        ids,
        retry,
        { contextKind }
      );
      claimAndResume(database, ids, retry, state);
      assert.deepEqual(
        allocationProjection(database, ids),
        {
          status: state.targetStatus,
          decisionCode:
            contextKind === "restricted"
              ? "exact_total_and_term_tie"
              : "restricted_no_improvement_fallback",
          restrictedAuctionId: ids.sourceAuction,
          fallbackAuctionId:
            contextKind === "fallback"
              ? ids.fallbackAuction
              : null,
          minimumTotal: 600,
          minimumTerm: 2,
          minimumAav: 300,
          accountedAtMs: null,
          lastErrorCode: null,
          updatedAtMs: state.timeline.claimedAtMs,
          version: 4,
        }
      );
      assert.deepEqual(
        database.prepare(`
          SELECT status, attempt_count AS attemptCount,
                 lease_owner AS leaseOwner,
                 lease_token AS leaseToken,
                 completed_at_ms AS completedAtMs,
                 result_json AS resultJson,
                 last_error_code AS lastErrorCode,
                 next_attempt_at_ms AS nextAttemptAtMs
          FROM job_runs
          WHERE league_id = ? AND id = ?
        `).get(ids.league, state.jobId),
        {
          status: "running",
          attemptCount: 2,
          leaseOwner: "fad41-worker",
          leaseToken: retry.claimLeaseToken,
          completedAtMs: null,
          resultJson: null,
          lastErrorCode: null,
          nextAttemptAtMs: null,
        }
      );
      assert.deepEqual(
        database.prepare(`
          SELECT status, version
          FROM auctions
          WHERE league_id = ? AND id = ?
        `).get(ids.league, state.auctionId),
        { status: "resolving", version: 3 }
      );
    }

    for (const [index, corrupt] of [
      [0, "missing_receipt"],
      [1, "failure_error"],
      [2, "revealed_draw"],
    ]) {
      const base = 630_000 + index * 1_000;
      const ids = seedRestrictedSource(database, base);
      const retry = retryIds(base);
      const state = installRetryEvidence(
        database,
        ids,
        retry,
        {
          contextKind:
            index === 1 ? "fallback" : "restricted",
          corrupt,
        }
      );
      assert.throws(
        () =>
          claimAndResume(
            database,
            ids,
            retry,
            state
          ),
        /allocation may only follow/i,
        corrupt
      );
      assert.equal(
        allocationProjection(database, ids).status,
        "correction_required",
        corrupt
      );
    }

    {
      const base = 640_000;
      const ids = seedRestrictedSource(database, base);
      const retry = retryIds(base);
      const state = installRetryEvidence(
        database,
        ids,
        retry,
        { contextKind: "restricted" }
      );
      assert.throws(
        () =>
          claimAndResume(
            database,
            ids,
            retry,
            state,
            { mutateAllocation: true }
          ),
        /allocation may only follow/i
      );
      assert.equal(
        allocationProjection(database, ids).minimumTotal,
        600
      );
    }

    assert.equal(
      database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      database.pragma("foreign_key_check"),
      []
    );
  }
);

function repeatedRetryIds(base, offset = 0) {
  return Object.freeze({
    membership: uuid(base + 30),
    recovery: uuid(base + 31),
    failureEvent: uuid(base + 40 + offset * 10),
    idempotency: uuid(base + 41 + offset * 10),
    receipt: uuid(base + 42 + offset * 10),
    claimLeaseToken: uuid(base + 43 + offset * 10),
    terminalEvent: uuid(base + 44 + offset * 10),
    resolution: uuid(base + 45 + offset * 10),
  });
}

function failureEventRecord(ids, retry, failureAtMs, overrides = {}) {
  return {
    id: retry.failureEvent,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.fallbackAuction,
    bid_id: null,
    team_id: null,
    actor_user_id: null,
    event_type: "fad_auction_resolution_failed",
    metadata_json: JSON.stringify({
      errorCode: FAILURE_CODE,
      jobRunId: ids.fallbackJob,
      recoveryId: retry.recovery,
      ...overrides,
    }),
    occurred_at_ms: failureAtMs,
  };
}

function installInitialFallbackFailure(database, ids, retry, timeline) {
  const triggers = captureAndDropTriggers(database);
  database.prepare(`
    UPDATE auctions
    SET status = 'no_winner',
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(SOURCE_RESOLVES_AT_MS, ids.league, ids.sourceAuction);
  insert(database, "auctions", {
    ...fallbackAuctionRecord(ids),
    status: "failed",
    updated_at_ms: timeline.failureAtMs,
    version: 2,
  });
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
    created_at_ms: FALLBACK_OPENS_AT_MS,
  });
  insert(database, "free_agent_draft_draws", {
    id: ids.fallbackDraw,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    auction_id: ids.fallbackAuction,
    algorithm_version: 1,
    nonce_bytes: Buffer.alloc(32, 43),
    commitment_hex: sha256(`repeat-${ids.fallbackAuction}`),
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
    occurrence_key:
      `auction:${ids.fallbackAuction}:${FALLBACK_RESOLVES_AT_MS}`,
    scheduled_for_ms: FALLBACK_RESOLVES_AT_MS,
    status: "failed",
    attempt_count: 1,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: FALLBACK_RESOLVES_AT_MS,
    completed_at_ms: timeline.failureAtMs,
    result_json: null,
    last_error_code: FAILURE_CODE,
    created_at_ms: FALLBACK_OPENS_AT_MS,
    updated_at_ms: timeline.failureAtMs,
    version: 3,
    lease_token: null,
    next_attempt_at_ms: null,
  });
  database.prepare(`
    UPDATE free_agent_draft_player_allocations
    SET status = 'correction_required',
        decision_code = 'restricted_no_improvement_fallback',
        fallback_open_auction_id = ?,
        last_error_code = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(
    ids.fallbackAuction,
    FAILURE_CODE,
    timeline.failureAtMs,
    ids.league,
    ids.allocation
  );
  insert(database, "free_agent_draft_recoveries", {
    id: retry.recovery,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    allocation_id: ids.allocation,
    rollover_id: ids.targetRollover,
    auction_id: ids.fallbackAuction,
    job_run_id: ids.fallbackJob,
    kind: "auction_resolution",
    status: "correction_required",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: FALLBACK_RESOLVES_AT_MS,
    last_error_code: FAILURE_CODE,
    commissioner_reason: null,
    created_by_operation_id: ids.fallbackJob,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: timeline.failureAtMs,
    updated_at_ms: timeline.failureAtMs,
    resolved_at_ms: null,
    version: 1,
  });
  restoreTriggers(database, triggers);
  insert(
    database,
    "auction_events",
    failureEventRecord(ids, retry, timeline.failureAtMs)
  );
  return Object.freeze({
    auctionId: ids.fallbackAuction,
    drawId: ids.fallbackDraw,
    jobId: ids.fallbackJob,
    targetStatus: "restricted_fallback_open",
    timeline,
  });
}

function installRetryAfterFailure(
  database,
  ids,
  retry,
  state,
  { omitReceipt = false, receiptOccurrenceKey = null } = {}
) {
  const evidence = requestEvidence(
    ids,
    retry,
    ids.fallbackAuction,
    ids.fallbackJob,
    state.timeline
  );
  const triggers = captureAndDropTriggers(database);
  const membershipExists = database.prepare(`
    SELECT 1
    FROM league_memberships
    WHERE league_id = ? AND id = ?
  `).get(ids.league, retry.membership);
  if (!membershipExists) {
    insert(database, "league_memberships", {
      id: retry.membership,
      league_id: ids.league,
      user_id: ids.user,
      permission_category: "commissioner",
      status: "active",
      joined_at_ms: 1,
      ended_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    database.prepare(`
      UPDATE leagues
      SET commissioner_membership_id = ?
      WHERE id = ?
    `).run(retry.membership, ids.league);
  }
  database.prepare(`
    UPDATE job_runs
    SET status = 'pending',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        started_at_ms = NULL,
        completed_at_ms = NULL,
        result_json = NULL,
        last_error_code = NULL,
        next_attempt_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ? AND status = 'failed'
  `).run(
    state.timeline.retryAcceptedAtMs,
    state.timeline.retryAcceptedAtMs,
    ids.league,
    ids.fallbackJob
  );
  database.prepare(`
    UPDATE free_agent_draft_recoveries
    SET status = 'running',
        commissioner_reason = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
      AND status = 'correction_required'
  `).run(
    evidence.reason,
    state.timeline.retryAcceptedAtMs,
    ids.league,
    retry.recovery
  );
  if (!omitReceipt) {
    insert(database, "idempotency_requests", {
      id: retry.idempotency,
      league_id: ids.league,
      actor_user_id: ids.user,
      operation: "free_agent_draft.recovery.action",
      client_key: `retry:${retry.receipt}`,
      request_hash: evidence.requestSha256,
      status: "completed",
      result_type:
        "free_agent_draft_recovery_action_command_result",
      result_id: retry.receipt,
      created_at_ms: state.timeline.retryAcceptedAtMs,
      completed_at_ms: state.timeline.retryAcceptedAtMs,
      expires_at_ms: state.timeline.retryAcceptedAtMs + DAY_MS,
    });
    insert(
      database,
      "free_agent_draft_recovery_action_command_results",
      {
        id: retry.receipt,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        recovery_id: retry.recovery,
        idempotency_request_id: retry.idempotency,
        action: "retry_auction_resolution",
        resource_kind: "auction",
        resource_id: ids.fallbackAuction,
        operation_id: ids.fallbackJob,
        job_run_id: ids.fallbackJob,
        occurrence_key:
          receiptOccurrenceKey || evidence.occurrenceKey,
        actor_user_id: ids.user,
        actor_membership_id: retry.membership,
        actor_authority: "commissioner",
        commissioner_reason: evidence.reason,
        request_json: evidence.requestJson,
        request_sha256: evidence.requestSha256,
        accepted_status: "pending",
        accepted_at_ms: state.timeline.retryAcceptedAtMs,
        response_http_status: 202,
        response_json: evidence.responseJson,
        response_sha256: evidence.responseSha256,
        version: 1,
      }
    );
  }
  restoreTriggers(database, triggers);
}

function repeatTerminalFailure(
  database,
  ids,
  retry,
  failureAtMs,
  { bypassEventGuard = false, eventOverrides = {} } = {}
) {
  let stage = "begin";
  database.exec("BEGIN IMMEDIATE");
  try {
    stage = "fail job";
    assert.equal(
      database.prepare(`
        UPDATE job_runs
        SET status = 'failed',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            completed_at_ms = ?,
            result_json = NULL,
            last_error_code = ?,
            next_attempt_at_ms = NULL,
            updated_at_ms = ?,
            version = version + 1
        WHERE league_id = ? AND id = ? AND status = 'running'
      `).run(
        failureAtMs,
        FAILURE_CODE,
        failureAtMs,
        ids.league,
        ids.fallbackJob
      ).changes,
      1
    );
    stage = "fail recovery";
    assert.equal(
      database.prepare(`
        UPDATE free_agent_draft_recoveries
        SET status = 'correction_required',
            last_error_code = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE league_id = ? AND id = ? AND status = 'running'
      `).run(
        FAILURE_CODE,
        failureAtMs,
        ids.league,
        retry.recovery
      ).changes,
      1
    );
    stage = "fail auction";
    assert.equal(
      database.prepare(`
        UPDATE auctions
        SET status = 'failed',
            updated_at_ms = ?,
            version = version + 1
        WHERE league_id = ? AND id = ? AND status = 'resolving'
      `).run(
        failureAtMs,
        ids.league,
        ids.fallbackAuction
      ).changes,
      1
    );
    stage = "fail allocation";
    assert.equal(
      database.prepare(`
        UPDATE free_agent_draft_player_allocations
        SET status = 'correction_required',
            last_error_code = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE league_id = ? AND id = ?
          AND status = 'restricted_fallback_open'
      `).run(
        FAILURE_CODE,
        failureAtMs,
        ids.league,
        ids.allocation
      ).changes,
      1
    );
    if (!bypassEventGuard) {
      stage = "insert latest failure";
      insert(
        database,
        "auction_events",
        failureEventRecord(ids, retry, failureAtMs, eventOverrides)
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    const wrapped = new Error(`${stage}: ${error.message}`, {
      cause: error,
    });
    wrapped.code = error.code;
    throw wrapped;
  }
  if (bypassEventGuard) {
    const triggers = captureAndDropTriggers(database);
    insert(
      database,
      "auction_events",
      failureEventRecord(ids, retry, failureAtMs, eventOverrides)
    );
    restoreTriggers(database, triggers);
  }
}

function settleFallbackNoWinner(
  database,
  ids,
  retry,
  resolvedAtMs
) {
  const triggers = captureAndDropTriggers(database);
  insert(database, "auction_events", {
    id: retry.terminalEvent,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.fallbackAuction,
    bid_id: null,
    team_id: null,
    actor_user_id: null,
    event_type: "auction_no_winner",
    metadata_json: JSON.stringify({
      outcome: "no_winner",
      resolutionId: retry.resolution,
    }),
    occurred_at_ms: resolvedAtMs,
  });
  insert(database, "auction_resolutions", {
    id: retry.resolution,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.fallbackAuction,
    scheduled_occurrence_key:
      `auction:${ids.fallbackAuction}:${FALLBACK_RESOLVES_AT_MS}`,
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
      `auction:${ids.fallbackAuction}:${FALLBACK_RESOLVES_AT_MS}`,
    status: "no_winner",
    resolved_at_ms: resolvedAtMs,
  });
  database.prepare(`
    UPDATE free_agent_draft_draws
    SET ordered_tied_bid_ids_json = '[]',
        ordered_tied_team_ids_json = '[]',
        rejection_counter = NULL,
        selected_index = NULL,
        selected_bid_id = NULL,
        selected_team_id = NULL,
        selected_digest_hex = NULL,
        revealed_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(
    resolvedAtMs,
    resolvedAtMs,
    ids.league,
    ids.fallbackDraw
  );
  database.prepare(`
    UPDATE free_agent_draft_player_allocations
    SET status = 'fallback_open_resolved',
        decision_code = 'fallback_open_no_winner',
        accounted_at_ms = ?,
        last_error_code = NULL,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(resolvedAtMs, resolvedAtMs, ids.league, ids.allocation);
  database.prepare(`
    UPDATE auctions
    SET status = 'no_winner',
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(resolvedAtMs, ids.league, ids.fallbackAuction);
  restoreTriggers(database, triggers);
  assert.equal(
    database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = NULL,
          resolved_by_membership_id = NULL,
          resolved_authority = 'system',
          updated_at_ms = ?,
          resolved_at_ms = ?,
          version = version + 1
      WHERE league_id = ? AND id = ? AND status = 'running'
    `).run(
      resolvedAtMs,
      resolvedAtMs,
      ids.league,
      retry.recovery
    ).changes,
    1
  );
}

function nextRetryState(state) {
  const failureAtMs = state.timeline.claimedAtMs + 1_000;
  const retryAcceptedAtMs = failureAtMs + 1_000;
  const claimedAtMs = retryAcceptedAtMs + 1_000;
  return Object.freeze({
    ...state,
    timeline: Object.freeze({
      failureAtMs,
      retryAcceptedAtMs,
      claimedAtMs,
      claimLeaseExpiresAtMs: claimedAtMs + 60_000,
    }),
  });
}

test(
  "schema 43 preserves one causal recovery across repeated FAD resolution failures and exact retries",
  (t) => {
    const schema42Runtime = createRuntime(
      t,
      "fad-resolution-repeat-schema42-",
      42
    );
    const { database: schema42 } = schema42Runtime;
    const beforeDefinitions = schemaDefinitions(schema42);
    const ids42 = seedRestrictedSource(schema42, 650_000);
    const first42 = repeatedRetryIds(650_000, 0);
    const firstState42 = installInitialFallbackFailure(
      schema42,
      ids42,
      first42,
      retryTimeline(FALLBACK_RESOLVES_AT_MS)
    );
    installRetryAfterFailure(
      schema42,
      ids42,
      first42,
      firstState42
    );
    claimAndResume(
      schema42,
      ids42,
      first42,
      firstState42
    );
    const second42 = repeatedRetryIds(650_000, 1);
    const secondState42 = nextRetryState(firstState42);
    assert.throws(
      () =>
        repeatTerminalFailure(
          schema42,
          ids42,
          second42,
          secondState42.timeline.failureAtMs
        ),
      /FAD operational failure requires|UNIQUE constraint failed/i
    );
    assert.equal(
      schema42.prepare(`
        SELECT COUNT(*)
        FROM auction_events
        WHERE league_id = ? AND auction_id = ?
          AND event_type = 'fad_auction_resolution_failed'
      `).pluck().get(ids42.league, ids42.fallbackAuction),
      1
    );
    assert.equal(
      schema42.prepare(`
        SELECT status FROM job_runs
        WHERE league_id = ? AND id = ?
      `).pluck().get(ids42.league, ids42.fallbackJob),
      "running"
    );

    const upgrade = upgradeToSchema43(schema42Runtime);
    assert.equal(upgrade.status, "exact");
    assert.equal(
      schema42.pragma("user_version", { simple: true }),
      43
    );
    repeatTerminalFailure(
      schema42,
      ids42,
      second42,
      secondState42.timeline.failureAtMs
    );
    assert.deepEqual(
      schema42.prepare(`
        SELECT occurred_at_ms AS occurredAtMs
        FROM auction_events
        WHERE league_id = ? AND auction_id = ?
          AND event_type = 'fad_auction_resolution_failed'
        ORDER BY occurred_at_ms
      `).all(ids42.league, ids42.fallbackAuction),
      [
        { occurredAtMs: firstState42.timeline.failureAtMs },
        { occurredAtMs: secondState42.timeline.failureAtMs },
      ]
    );

    const afterDefinitions = schemaDefinitions(schema42);
    const replacedObjects = new Set([
      "auction_events_one_fad_resolution_failure",
      "fad_auction_resolution_failure_events_insert",
      "fad_open_rapid_recovery_resolution_guard",
      "free_agent_draft_allocations_forward_update",
      "free_agent_draft_rollovers_valid_insert",
    ]);
    assert.deepEqual(
      afterDefinitions.filter(({ name }) => !replacedObjects.has(name)),
      beforeDefinitions.filter(({ name }) => !replacedObjects.has(name))
    );

    const { database } = createRuntime(
      t,
      "fad-resolution-repeat-schema43-",
      43
    );
    assert.equal(
      database.pragma("user_version", { simple: true }),
      43
    );
    assert.equal(
      database.prepare(`
        SELECT metadata_value
        FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).pluck().get(),
      "43"
    );
    assert.deepEqual(
      database.prepare(`
        SELECT migration_id, file_name
        FROM schema_migrations
        WHERE migration_id = 43
      `).get(),
      {
        migration_id: 43,
        file_name:
          "0043_allow_repeat_fad_auction_resolution_recovery.sql",
      }
    );
    const failureIndexSql = database.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'index'
        AND name = 'auction_events_one_fad_resolution_failure'
    `).pluck().get();
    assert.match(failureIndexSql, /occurred_at_ms/);
    const openRecoverySql = database.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'trigger'
        AND name = 'fad_open_rapid_recovery_resolution_guard'
    `).pluck().get();
    assert.match(openRecoverySql, /NEW\.resolved_authority = 'system'/);
    assert.match(openRecoverySql, /receipt\.action = 'retry_auction_resolution'/);
    assert.match(openRecoverySql, /allocation\.status = 'fallback_open_resolved'/);
    assert.match(openRecoverySql, /NEW\.last_error_code IS NULL/);

    const ids = seedRestrictedSource(database, 660_000);
    const first = repeatedRetryIds(660_000, 0);
    const firstState = installInitialFallbackFailure(
      database,
      ids,
      first,
      retryTimeline(FALLBACK_RESOLVES_AT_MS)
    );
    installRetryAfterFailure(database, ids, first, firstState);
    claimAndResume(database, ids, first, firstState);
    const second = repeatedRetryIds(660_000, 1);
    const secondState = nextRetryState(firstState);
    repeatTerminalFailure(
      database,
      ids,
      second,
      secondState.timeline.failureAtMs
    );
    installRetryAfterFailure(database, ids, second, secondState);
    claimAndResume(database, ids, second, secondState);
    settleFallbackNoWinner(
      database,
      ids,
      second,
      secondState.timeline.claimedAtMs + 1_000
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, last_error_code AS lastErrorCode,
               resolved_authority AS resolvedAuthority,
               resolved_by_user_id AS resolvedByUserId,
               version
        FROM free_agent_draft_recoveries
        WHERE league_id = ? AND id = ?
      `).get(ids.league, second.recovery),
      {
        status: "resolved",
        lastErrorCode: null,
        resolvedAuthority: "system",
        resolvedByUserId: null,
        version: 5,
      }
    );
    assert.deepEqual(
      allocationProjection(database, ids),
      {
        status: "fallback_open_resolved",
        decisionCode: "fallback_open_no_winner",
        restrictedAuctionId: ids.sourceAuction,
        fallbackAuctionId: ids.fallbackAuction,
        minimumTotal: 600,
        minimumTerm: 2,
        minimumAav: 300,
        accountedAtMs: secondState.timeline.claimedAtMs + 1_000,
        lastErrorCode: null,
        updatedAtMs: secondState.timeline.claimedAtMs + 1_000,
        version: 7,
      }
    );

    for (const [index, corruption] of [
      [0, "latest_event"],
      [1, "recovery_error"],
      [2, "job_occurrence"],
      [3, "missing_latest_receipt"],
    ]) {
      const base = 670_000 + index * 1_000;
      const badIds = seedRestrictedSource(database, base);
      const badFirst = repeatedRetryIds(base, 0);
      const badFirstState = installInitialFallbackFailure(
        database,
        badIds,
        badFirst,
        retryTimeline(FALLBACK_RESOLVES_AT_MS)
      );
      installRetryAfterFailure(
        database,
        badIds,
        badFirst,
        badFirstState
      );
      claimAndResume(
        database,
        badIds,
        badFirst,
        badFirstState
      );
      const badSecond = repeatedRetryIds(base, 1);
      const badSecondState = nextRetryState(badFirstState);
      repeatTerminalFailure(
        database,
        badIds,
        badSecond,
        badSecondState.timeline.failureAtMs,
        corruption === "latest_event"
          ? {
              bypassEventGuard: true,
              eventOverrides: { errorCode: "WRONG_ERROR" },
            }
          : {}
      );
      installRetryAfterFailure(
        database,
        badIds,
        badSecond,
        badSecondState,
        {
          omitReceipt: corruption === "missing_latest_receipt",
          receiptOccurrenceKey:
            corruption === "job_occurrence"
              ? "auction:wrong:0"
              : null,
        }
      );
      if (corruption === "recovery_error") {
        const triggers = captureAndDropTriggers(database);
        database.prepare(`
          UPDATE free_agent_draft_recoveries
          SET last_error_code = 'WRONG_ERROR'
          WHERE league_id = ? AND id = ?
        `).run(badIds.league, badSecond.recovery);
        restoreTriggers(database, triggers);
      }
      const before = database.serialize();
      assert.throws(
        () =>
          claimAndResume(
            database,
            badIds,
            badSecond,
            badSecondState
          ),
        /allocation may only follow/i,
        corruption
      );
      assert.deepEqual(database.serialize(), before, corruption);
    }

    assert.equal(
      database.pragma("integrity_check", { simple: true }),
      "ok"
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  }
);
