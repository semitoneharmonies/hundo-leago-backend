"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 86_400_000;
const DEADLINE_AT_MS = Date.parse("2026-10-05T07:00:00.000Z");
const OPENING_AT_MS = DEADLINE_AT_MS + 7 * DAY_MS;
const RESOLUTION_AT_MS = OPENING_AT_MS + DAY_MS;
const ACCEPTED_AT_MS = OPENING_AT_MS - 30 * 60 * 1_000;
const ACTIVATED_AT_MS = OPENING_AT_MS + 1_000;
const MIGRATION_0045 = Object.freeze({
  byteLength: 74_289,
  fileName:
    "0045_allow_restart_safe_fad_queued_nomination_activation.sql",
  sha256:
    "cd2a7d3059b6ab0f484267b6999cbadd6db1a86114fcdb67e4220296dca9ae37",
});

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  try {
    database.prepare(`
      INSERT INTO ${tableName} (${columns.join(", ")})
      VALUES (${columns.map((column) => `@${column}`).join(", ")})
    `).run(values);
  } catch (error) {
    throw new Error(`${tableName}: ${error.message}`, { cause: error });
  }
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

function withoutTriggers(database, operation) {
  const triggers = captureAndDropTriggers(database);
  try {
    return operation();
  } finally {
    restoreTriggers(database, triggers);
  }
}

function createRuntime(t, schemaVersion, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const state = applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).filter(({ id }) => id <= schemaVersion),
    applicationBuildId: `${prefix}${schemaVersion}`,
    now: () => 1,
  });
  assert.equal(state.userVersion, schemaVersion);
  return { ...connection, state };
}

function upgradeTo45(runtime) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).filter(({ id }) => id <= 45),
    applicationBuildId: "fad-queued-activation-upgrade-45",
    now: () => 2,
  });
}

function fixtureIds(base) {
  const rolloverIds = Array.from(
    { length: 8 },
    (_, index) => uuid(base + 100 + index)
  );
  return Object.freeze({
    managerUser: uuid(base + 1),
    managerMembership: uuid(base + 2),
    assignment: uuid(base + 3),
    league: uuid(base + 10),
    season: uuid(base + 11),
    week: uuid(base + 12),
    readiness: uuid(base + 13),
    fad: uuid(base + 14),
    team: uuid(base + 15),
    player: uuid(base + 16),
    request: uuid(base + 17),
    queue: uuid(base + 18),
    activationJob: uuid(base + 19),
    auction: uuid(base + 20),
    draw: uuid(base + 21),
    starter: uuid(base + 22),
    startedEvent: uuid(base + 23),
    resolutionJob: uuid(base + 24),
    recovery: uuid(base + 25),
    otherRecovery: uuid(base + 26),
    leaseToken: uuid(base + 27),
    rolloverIds,
    openingRollover: rolloverIds[6],
    resolutionRollover: rolloverIds[7],
  });
}

function seedQueuedFixture(database, base, {
  activationStatus = "running",
  activationStartedAtMs = ACTIVATED_AT_MS,
  activationLeaseExpiresAtMs = ACTIVATED_AT_MS + 60_000,
} = {}) {
  const ids = fixtureIds(base);
  withoutTriggers(database, () => {
    insert(database, "users", {
      id: ids.managerUser,
      email_normalized: `manager-${base}@example.test`,
      email_display: `manager-${base}@example.test`,
      display_name: `Manager ${base}`,
      display_name_normalized: `manager ${base}`,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "leagues", {
      id: ids.league,
      name: `Queued activation ${base}`,
      name_normalized: `queued activation ${base}`,
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "league_settings", {
      league_id: ids.league,
      salary_cap_cents: 10_000,
      trade_deadline_at_ms: null,
      maximum_teams: 20,
      active_forward_slots: 12,
      active_defence_slots: 6,
      bench_slots: 4,
      maximum_bench_aav_cents: 400,
      injured_reserve_slots: 4,
      prospect_slots_unlimited: 1,
      scoring_rule_version: 1,
      standings_rule_version: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "league_memberships", {
      id: ids.managerMembership,
      league_id: ids.league,
      user_id: ids.managerUser,
      permission_category: "manager",
      status: "active",
      joined_at_ms: 1,
      ended_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "seasons", {
      id: ids.season,
      league_id: ids.league,
      label: `2026-27 ${base}`,
      nhl_season_key: `26${String(base).padStart(6, "0")}`,
      status: "active",
      regular_season_starts_at_ms: OPENING_AT_MS,
      regular_season_ends_at_ms: OPENING_AT_MS + 180 * DAY_MS,
      fantasy_playoffs_start_at_ms: OPENING_AT_MS + 150 * DAY_MS,
      fantasy_playoffs_end_at_ms: OPENING_AT_MS + 180 * DAY_MS,
      free_agent_draft_completed_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    database.prepare(`
      UPDATE leagues
      SET current_season_id = ?
      WHERE id = ?
    `).run(ids.season, ids.league);
    insert(database, "teams", {
      id: ids.team,
      league_id: ids.league,
      name: `Team ${base}`,
      name_normalized: `team ${base}`,
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
    insert(database, "team_manager_assignments", {
      id: ids.assignment,
      league_id: ids.league,
      team_id: ids.team,
      user_id: ids.managerUser,
      membership_id: ids.managerMembership,
      assigned_by_user_id: ids.managerUser,
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: 1,
      accepted_at_ms: 1,
      ended_at_ms: null,
      version: 1,
    });
    insert(database, "matchup_weeks", {
      id: ids.week,
      league_id: ids.league,
      season_id: ids.season,
      week_key: `week-${base}`,
      sequence: 1,
      starts_at_ms: OPENING_AT_MS,
      baseline_at_ms: OPENING_AT_MS + 1,
      locks_at_ms: OPENING_AT_MS + 2,
      ends_at_ms: OPENING_AT_MS + 7 * DAY_MS,
      rolls_over_at_ms: OPENING_AT_MS + 7 * DAY_MS,
      status: "scheduled",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "players", {
      id: ids.player,
      first_name: "Queued",
      last_name: `Player ${base}`,
      full_name: `Queued Player ${base}`,
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
      readiness_occurrence_key:
        `fad-readiness:${ids.league}:${ids.season}`,
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
      readiness_occurrence_key:
        `fad-readiness:${ids.league}:${ids.season}`,
      first_matchup_week_id: ids.week,
      current_competition_first_matchup_week_id: ids.week,
      schedule_recovery_id: null,
      participating_team_count: 1,
      status: "rapid",
      setup_path: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      prior_season_rollover_id: null,
      no_draft_reason: "Focused queued-activation fixture.",
      opening_authority: "system",
      opened_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
      help_opens_at_ms: DEADLINE_AT_MS - 2 * DAY_MS,
      candidate_deadline_at_ms: DEADLINE_AT_MS,
      first_matchup_starts_at_ms: OPENING_AT_MS,
      deadline_locked_at_ms: DEADLINE_AT_MS,
      allocation_completed_at_ms: DEADLINE_AT_MS + 1,
      completed_at_ms: null,
      created_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
      updated_at_ms: DEADLINE_AT_MS + 1,
      version: 4,
    });
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      const rollsOverAtMs = DEADLINE_AT_MS + sequence * DAY_MS;
      insert(database, "free_agent_draft_rollovers", {
        id: ids.rolloverIds[sequence - 1],
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        sequence,
        window_kind: "initial",
        predecessor_rollover_id:
          sequence === 1 ? null : ids.rolloverIds[sequence - 2],
        extension_reason: null,
        extension_source_id: null,
        opens_at_ms: rollsOverAtMs - DAY_MS,
        creation_cutoff_at_ms: rollsOverAtMs - 3_600_000,
        rolls_over_at_ms: rollsOverAtMs,
        status: "scheduled",
        processing_job_run_id: null,
        processing_started_at_ms: null,
        completed_at_ms: null,
        last_error_code: null,
        created_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
        updated_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
        version: 1,
      });
    }
    insert(database, "idempotency_requests", {
      id: ids.request,
      league_id: ids.league,
      actor_user_id: ids.managerUser,
      operation: "auction.start",
      client_key: `queued-start-${base}`,
      request_hash: sha256(`queued-start-${base}`),
      status: "completed",
      result_type: "fad_nomination_queue",
      result_id: ids.queue,
      created_at_ms: ACCEPTED_AT_MS,
      completed_at_ms: ACCEPTED_AT_MS,
      expires_at_ms: ACCEPTED_AT_MS + DAY_MS,
    });
    insert(database, "free_agent_draft_nomination_queue", {
      id: ids.queue,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      team_id: ids.team,
      player_id: ids.player,
      source_rollover_id: ids.openingRollover,
      target_opening_rollover_id: ids.openingRollover,
      resolution_rollover_id: null,
      opening_total_value_cents: 600,
      opening_term_years: 2,
      opening_aav_cents: 300,
      binding_illegality_confirmed: 1,
      binding_confirmed_at_ms: ACCEPTED_AT_MS,
      submitted_by_user_id: ids.managerUser,
      submitted_by_membership_id: ids.managerMembership,
      accepted_at_ms: ACCEPTED_AT_MS,
      candidate_card_version_observed: 1,
      team_version_observed: 1,
      status: "queued",
      opened_auction_id: null,
      opened_starter_bid_id: null,
      opened_at_ms: null,
      terminal_at_ms: null,
      validation_code: null,
      created_at_ms: ACCEPTED_AT_MS,
      updated_at_ms: ACCEPTED_AT_MS,
      version: 1,
      acceptance_idempotency_request_id: ids.request,
    });
    const active = ["leased", "running"].includes(activationStatus);
    insert(database, "job_runs", {
      id: ids.activationJob,
      league_id: ids.league,
      season_id: ids.season,
      job_type: "fad_queued_nomination_activation",
      occurrence_key:
        `fad:${ids.fad}:nomination-open:${ids.queue}:${OPENING_AT_MS}`,
      scheduled_for_ms: OPENING_AT_MS,
      status: activationStatus,
      attempt_count: active ? 1 : 0,
      lease_owner: active ? "queued-activation-worker" : null,
      lease_token: active ? ids.leaseToken : null,
      lease_expires_at_ms: active ? activationLeaseExpiresAtMs : null,
      started_at_ms: active ? activationStartedAtMs : null,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      next_attempt_at_ms: null,
      created_at_ms: ACCEPTED_AT_MS,
      updated_at_ms: active ? activationStartedAtMs : ACCEPTED_AT_MS,
      version: active ? 2 : 1,
    });
  });
  return ids;
}

function resolutionRolloverRecord(ids, overrides = {}) {
  return {
    id: ids.resolutionRollover,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    sequence: 8,
    window_kind: "extension",
    predecessor_rollover_id: ids.openingRollover,
    extension_reason: "queued_nomination",
    extension_source_id: ids.queue,
    opens_at_ms: OPENING_AT_MS,
    creation_cutoff_at_ms: RESOLUTION_AT_MS - 3_600_000,
    rolls_over_at_ms: RESOLUTION_AT_MS,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: ACTIVATED_AT_MS,
    updated_at_ms: ACTIVATED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function insertResolutionRollover(database, ids, overrides = {}) {
  insert(
    database,
    "free_agent_draft_rollovers",
    resolutionRolloverRecord(ids, overrides)
  );
}

function insertOpeningEvidence(database, ids, {
  includeStartedEvent = true,
  includeResolutionJob = true,
} = {}) {
  insert(database, "auctions", {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status: "open",
    opened_at_ms: OPENING_AT_MS,
    resolves_at_ms: RESOLUTION_AT_MS,
    opened_by_user_id: ids.managerUser,
    created_at_ms: OPENING_AT_MS,
    updated_at_ms: OPENING_AT_MS,
    version: 1,
  });
  insert(database, "auction_contexts", {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    source_kind: "fad_open_rapid",
    fad_id: ids.fad,
    fad_rollover_id: ids.resolutionRollover,
    fad_allocation_id: null,
    fad_origin: "queued_nomination",
    created_at_ms: OPENING_AT_MS,
  });
  const nonce = Buffer.alloc(32, 0x45);
  insert(database, "free_agent_draft_draws", {
    id: ids.draw,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: null,
    auction_id: ids.auction,
    algorithm_version: 1,
    nonce_bytes: nonce,
    commitment_hex: sha256(nonce),
    ordered_tied_bid_ids_json: null,
    ordered_tied_team_ids_json: null,
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: null,
    created_at_ms: OPENING_AT_MS,
    updated_at_ms: OPENING_AT_MS,
    version: 1,
  });
  insert(database, "auction_bids", {
    id: ids.starter,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    team_id: ids.team,
    submitted_by_user_id: ids.managerUser,
    total_value_cents: 600,
    term_years: 2,
    lowest_offered_aav_cents: 300,
    first_submitted_at_ms: ACCEPTED_AT_MS,
    last_edited_at_ms: ACCEPTED_AT_MS,
    edit_count: 0,
    status: "active",
    idempotency_request_id: ids.request,
    version: 1,
  });
  if (includeStartedEvent) {
    insert(database, "auction_events", {
      id: ids.startedEvent,
      league_id: ids.league,
      season_id: ids.season,
      auction_id: ids.auction,
      bid_id: ids.starter,
      team_id: ids.team,
      actor_user_id: ids.managerUser,
      event_type: "auction_started",
      metadata_json: JSON.stringify({
        openingTeamId: ids.team,
        actorMembershipId: ids.managerMembership,
        actorAuthority: "manager",
        playerPosition: "F",
        creationCutoffAtMs: OPENING_AT_MS - 3_600_000,
        bidClosesAtMs: RESOLUTION_AT_MS,
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
        bindingIllegalityConfirmed: true,
        fadId: ids.fad,
        fadRolloverId: ids.resolutionRollover,
      }),
      occurred_at_ms: OPENING_AT_MS,
    });
  }
  if (includeResolutionJob) {
    insert(database, "job_runs", {
      id: ids.resolutionJob,
      league_id: ids.league,
      season_id: ids.season,
      job_type: "auction.resolve.target",
      occurrence_key: `auction:${ids.auction}:${RESOLUTION_AT_MS}`,
      scheduled_for_ms: RESOLUTION_AT_MS,
      status: "pending",
      attempt_count: 0,
      lease_owner: null,
      lease_token: null,
      lease_expires_at_ms: null,
      started_at_ms: null,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      next_attempt_at_ms: null,
      created_at_ms: ACTIVATED_AT_MS,
      updated_at_ms: ACTIVATED_AT_MS,
      version: 1,
    });
  }
}

function terminalizeQueue(database, ids, {
  status = "opened",
  validationCode = null,
} = {}) {
  const opened = status === "opened";
  try {
    database.prepare(`
      UPDATE free_agent_draft_nomination_queue
      SET resolution_rollover_id = @resolutionRolloverId,
          status = @status,
          opened_auction_id = @auctionId,
          opened_starter_bid_id = @starterId,
          opened_at_ms = @openedAtMs,
          terminal_at_ms = @terminalAtMs,
          validation_code = @validationCode,
          updated_at_ms = @terminalAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @queueId
    `).run({
      resolutionRolloverId: opened ? ids.resolutionRollover : null,
      status,
      auctionId: opened ? ids.auction : null,
      starterId: opened ? ids.starter : null,
      openedAtMs: opened ? OPENING_AT_MS : null,
      terminalAtMs: ACTIVATED_AT_MS,
      validationCode,
      leagueId: ids.league,
      queueId: ids.queue,
    });
  } catch (error) {
    throw new Error(`nomination queue update: ${error.message}`, {
      cause: error,
    });
  }
}

function commitOpening(database, ids, options = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    insertOpeningEvidence(database, ids, options);
    terminalizeQueue(database, ids);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function recoveryRecord(ids, id) {
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    allocation_id: null,
    rollover_id: ids.openingRollover,
    auction_id: null,
    job_run_id: ids.activationJob,
    kind: "queued_nomination_activation",
    status: "correction_required",
    earliest_activation_at_ms: OPENING_AT_MS,
    target_resolution_at_ms: null,
    last_error_code: "FAD_QUEUED_NOMINATION_ACTIVATION_FAILED",
    commissioner_reason: null,
    created_by_operation_id: ids.activationJob,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: ACTIVATED_AT_MS,
    updated_at_ms: ACTIVATED_AT_MS,
    resolved_at_ms: null,
    version: 1,
    nomination_queue_id: ids.queue,
  };
}

function assertHealthy(database) {
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(database.pragma("foreign_key_check"), []);
}

describe("FAD queued-nomination activation migration 0045", () => {
  test("head 44 rejects delayed claimed starter evidence and 0045 upgrades the same activation", (t) => {
    const runtime = createRuntime(t, 44, "fad-queued-delayed-upgrade-");
    const ids = seedQueuedFixture(runtime.database, 450_000);
    withoutTriggers(runtime.database, () => {
      insertResolutionRollover(runtime.database, ids);
    });

    assert.throws(
      () => commitOpening(runtime.database, ids),
      /FAD opening bid requires a current actor or exact queued acceptance/
    );
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) FROM auctions").pluck().get(),
      0
    );

    const upgraded = upgradeTo45(runtime);
    assert.equal(upgraded.userVersion, 45);
    assert.equal(upgraded.applied.at(-1).id, 45);
    commitOpening(runtime.database, ids);

    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, opened_at_ms, terminal_at_ms, validation_code
        FROM free_agent_draft_nomination_queue
        WHERE id = ?
      `).get(ids.queue),
      {
        status: "opened",
        opened_at_ms: OPENING_AT_MS,
        terminal_at_ms: ACTIVATED_AT_MS,
        validation_code: null,
      }
    );
    assertHealthy(runtime.database);
  });

  test("head 44 rejects the sequence-8 extension from a scheduled sequence-7 opening, while fresh 0045 admits it", (t) => {
    const oldRuntime = createRuntime(t, 44, "fad-queued-extension-red-");
    const oldIds = seedQueuedFixture(oldRuntime.database, 451_000);
    assert.throws(
      () => insertResolutionRollover(oldRuntime.database, oldIds),
      /FAD rollover must be the next contiguous justified boundary/
    );

    const runtime = createRuntime(t, 45, "fad-queued-extension-green-");
    const ids = seedQueuedFixture(runtime.database, 451_100);
    insertResolutionRollover(runtime.database, ids);
    commitOpening(runtime.database, ids);
    assert.equal(
      runtime.database.prepare(`
        SELECT extension_reason
        FROM free_agent_draft_rollovers
        WHERE id = ?
      `).pluck().get(ids.resolutionRollover),
      "queued_nomination"
    );
    assertHealthy(runtime.database);
  });

  test("fresh 0045 requires a live exact claim for extension, opening, and objective invalidation", (t) => {
    for (const [index, options] of [
      [0, { activationStatus: "pending" }],
      [1, { activationLeaseExpiresAtMs: ACTIVATED_AT_MS }],
    ]) {
      const runtime = createRuntime(t, 45, `fad-queued-claim-${index}-`);
      const ids = seedQueuedFixture(runtime.database, 452_000 + index * 100, options);
      assert.throws(
        () => insertResolutionRollover(runtime.database, ids),
        /FAD rollover must be the next contiguous justified boundary/
      );
      assert.throws(
        () => terminalizeQueue(runtime.database, ids, {
          status: "invalid",
          validationCode: "PLAYER_UNAVAILABLE",
        }),
        /queued nomination may only open or invalidate under its exact live activation/
      );
    }

    const runtime = createRuntime(t, 45, "fad-queued-objective-invalid-");
    const ids = seedQueuedFixture(runtime.database, 452_300);
    assert.throws(
      () => terminalizeQueue(runtime.database, ids, {
        status: "invalid",
        validationCode: "TEAM_UNAVAILABLE",
      }),
      /queued nomination may only open or invalidate under its exact live activation/
    );
    terminalizeQueue(runtime.database, ids, {
      status: "invalid",
      validationCode: "PLAYER_UNAVAILABLE",
    });
    assert.equal(
      runtime.database.prepare(`
        SELECT status FROM free_agent_draft_nomination_queue WHERE id = ?
      `).pluck().get(ids.queue),
      "invalid"
    );
    assertHealthy(runtime.database);
  });

  test("fresh 0045 rolls back incomplete event or resolver-job terminal evidence", (t) => {
    for (const [index, option] of [
      [0, { includeStartedEvent: false }],
      [1, { includeResolutionJob: false }],
    ]) {
      const runtime = createRuntime(t, 45, `fad-queued-proof-${index}-`);
      const ids = seedQueuedFixture(runtime.database, 453_000 + index * 100);
      insertResolutionRollover(runtime.database, ids);
      assert.throws(
        () => commitOpening(runtime.database, ids, option),
        /queued nomination may only open or invalidate under its exact live activation/
      );
      assert.equal(
        runtime.database.prepare("SELECT COUNT(*) FROM auctions").pluck().get(),
        0
      );
      assert.equal(
        runtime.database.prepare("SELECT COUNT(*) FROM auction_bids").pluck().get(),
        0
      );
    }
  });

  test("fresh 0045 permits only one queued-activation recovery per queue and job", (t) => {
    const runtime = createRuntime(t, 45, "fad-queued-recovery-unique-");
    const ids = seedQueuedFixture(runtime.database, 454_000);
    withoutTriggers(runtime.database, () => {
      insert(runtime.database, "free_agent_draft_recoveries", recoveryRecord(
        ids,
        ids.recovery
      ));
      assert.throws(
        () => insert(
          runtime.database,
          "free_agent_draft_recoveries",
          recoveryRecord(ids, ids.otherRecovery)
        ),
        /UNIQUE constraint failed/
      );
    });
    assertHealthy(runtime.database);
  });

  test("0045 records its ledger identity and preserves direct, restricted, fallback, and queued trigger branches", (t) => {
    const runtime = createRuntime(t, 45, "fad-queued-preservation-");
    const migration = discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).find(({ id }) => id === 45);
    assert.ok(migration);
    assert.equal(migration.fileName, MIGRATION_0045.fileName);
    assert.equal(
      fs.statSync(migration.filePath).size,
      MIGRATION_0045.byteLength
    );
    assert.equal(migration.checksum, MIGRATION_0045.sha256);
    const ledger = runtime.database.prepare(`
      SELECT file_name, checksum
      FROM schema_migrations
      WHERE migration_id = 45
    `).get();
    assert.deepEqual(ledger, {
      file_name: migration.fileName,
      checksum: migration.checksum,
    });
    assert.equal(
      runtime.database.prepare(`
        SELECT metadata_value
        FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).pluck().get(),
      "45"
    );

    const bidTrigger = runtime.database.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'trigger'
        AND name = 'auction_bids_require_context_insert'
    `).pluck().get();
    for (const preserved of [
      "auction.bid.put",
      "manager_nomination",
      "fad_restricted",
      "restricted_no_improvement_fallback",
      "queued_nomination",
    ]) {
      assert.match(bidTrigger, new RegExp(preserved.replaceAll(".", "\\.")));
    }
    const rolloverTrigger = runtime.database.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'trigger'
        AND name = 'free_agent_draft_rollovers_valid_insert'
    `).pluck().get();
    for (const preserved of [
      "restricted_auction",
      "fallback_auction",
      "recovery",
      "queued_nomination",
    ]) {
      assert.match(
        rolloverTrigger,
        new RegExp(preserved.replaceAll(".", "\\."))
      );
    }
    assertHealthy(runtime.database);
  });
});
