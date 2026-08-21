"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
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
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE,
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_WRITER_METHODS,
  createSqliteFreeAgentDraftQueuedNominationActivationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftQueuedNominationActivationWriter"
);
const {
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const CANDIDATE_DEADLINE_AT_MS = Date.parse(
  "2026-09-21T07:00:00.000Z"
);
const OPENING_AT_MS = CANDIDATE_DEADLINE_AT_MS + 7 * DAY_MS;
const ACCEPTED_AT_MS = OPENING_AT_MS - 30 * 60 * 1000;
const CLAIMED_AT_MS = OPENING_AT_MS + 100;
const ACTIVATED_AT_MS = OPENING_AT_MS + 200;
const LEASE_EXPIRES_AT_MS = OPENING_AT_MS + HOUR_MS;
const LEASE_OWNER = "fad-queue-activation-worker";
const LEASE_TOKEN = "fad-queue-activation-lease-token";

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function deterministicUuid(value) {
  const hex = createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function identities(index = 1) {
  const base = index * 10_000;
  return Object.freeze({
    league: uuid(base + 1),
    season: uuid(base + 2),
    week: uuid(base + 3),
    readiness: uuid(base + 4),
    fad: uuid(base + 5),
    player: uuid(base + 6),
    playerSource: uuid(base + 7),
    user: uuid(base + 8),
    membership: uuid(base + 9),
    team: uuid(base + 10),
    assignment: uuid(base + 11),
    fadTeam: uuid(base + 12),
    request: uuid(base + 13),
    queue: uuid(base + 14),
    activationJob: uuid(base + 15),
    rollovers: Object.freeze(
      Array.from({ length: 7 }, (_, position) =>
        uuid(base + 100 + position)
      )
    ),
  });
}

const PRIMARY = identities(1);
const SECONDARY_SOURCE = identities(2);
const SECONDARY_QUEUE = Object.freeze({
  ...PRIMARY,
  player: SECONDARY_SOURCE.player,
  playerSource: SECONDARY_SOURCE.playerSource,
  request: SECONDARY_SOURCE.request,
  queue: SECONDARY_SOURCE.queue,
  activationJob: SECONDARY_SOURCE.activationJob,
});

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  try {
    database.prepare(`
      INSERT INTO ${tableName} (${fields.join(", ")})
      VALUES (${fields.map((field) => `@${field}`).join(", ")})
    `).run(values);
  } catch (error) {
    throw new Error(`${tableName}: ${error.message}`, {
      cause: error,
    });
  }
}

function captureAndDropTriggers(database) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  for (const trigger of triggers) {
    database.exec(
      `DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`
    );
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const trigger of triggers) database.exec(trigger.sql);
}

function withoutTriggers(database, mutate) {
  const triggers = captureAndDropTriggers(database);
  try {
    mutate();
  } finally {
    restoreTriggers(database, triggers);
  }
}

function seedQueuedNomination(database, ids, index = 1) {
  insert(database, "leagues", {
    id: ids.league,
    name: `Queue Activation League ${index}`,
    name_normalized: `queue activation league ${index}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: ids.season,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `2026-27-${index}`,
    nhl_season_key: `2026202${index}`,
    status: "active",
    regular_season_starts_at_ms: OPENING_AT_MS,
    regular_season_ends_at_ms: OPENING_AT_MS + 200 * DAY_MS,
    fantasy_playoffs_start_at_ms: OPENING_AT_MS + 150 * DAY_MS,
    fantasy_playoffs_end_at_ms: OPENING_AT_MS + 190 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
    week_key: `2026-W${String(index).padStart(2, "0")}`,
    sequence: 1,
    starts_at_ms: OPENING_AT_MS,
    baseline_at_ms: OPENING_AT_MS + HOUR_MS,
    locks_at_ms: OPENING_AT_MS + 2 * HOUR_MS,
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
    last_name: `Player ${index}`,
    full_name: `Queued Player ${index}`,
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: ids.playerSource,
    player_id: ids.player,
    provider: `queue-activation-${index}`,
    source_position: "F",
    normalized_position: "F",
    nhl_team_abbreviation: "VAN",
    active: 1,
    source_version: "1",
    source_payload_json: "{}",
    effective_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
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
    no_draft_reason: "Inaugural league has no Entry Draft.",
    opening_authority: "system",
    opened_at_ms: CANDIDATE_DEADLINE_AT_MS - 30 * DAY_MS,
    help_opens_at_ms: CANDIDATE_DEADLINE_AT_MS - 2 * DAY_MS,
    candidate_deadline_at_ms: CANDIDATE_DEADLINE_AT_MS,
    first_matchup_starts_at_ms: OPENING_AT_MS,
    deadline_locked_at_ms: CANDIDATE_DEADLINE_AT_MS,
    allocation_completed_at_ms: CANDIDATE_DEADLINE_AT_MS,
    completed_at_ms: null,
    created_at_ms: CANDIDATE_DEADLINE_AT_MS - 30 * DAY_MS,
    updated_at_ms: CANDIDATE_DEADLINE_AT_MS,
    version: 4,
  });
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    const rollsOverAtMs =
      CANDIDATE_DEADLINE_AT_MS + sequence * DAY_MS;
    insert(database, "free_agent_draft_rollovers", {
      id: ids.rollovers[sequence - 1],
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      sequence,
      window_kind: "initial",
      predecessor_rollover_id:
        sequence === 1 ? null : ids.rollovers[sequence - 2],
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: rollsOverAtMs - DAY_MS,
      creation_cutoff_at_ms: rollsOverAtMs - HOUR_MS,
      rolls_over_at_ms: rollsOverAtMs,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: CANDIDATE_DEADLINE_AT_MS - 30 * DAY_MS,
      updated_at_ms: CANDIDATE_DEADLINE_AT_MS - 30 * DAY_MS,
      version: 1,
    });
  }
  insert(database, "users", {
    id: ids.user,
    email_normalized: `queue-manager-${index}@example.test`,
    email_display: `queue-manager-${index}@example.test`,
    display_name: `Queue Manager ${index}`,
    display_name_normalized: `queue manager ${index}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: ids.membership,
    league_id: ids.league,
    user_id: ids.user,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `Queue Team ${index}`,
    name_normalized: `queue team ${index}`,
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
    user_id: ids.user,
    membership_id: ids.membership,
    assigned_by_user_id: ids.user,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: 1,
    accepted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "free_agent_draft_teams", {
    id: ids.fadTeam,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: CANDIDATE_DEADLINE_AT_MS - 30 * DAY_MS,
  });
  insert(database, "idempotency_requests", {
    id: ids.request,
    league_id: ids.league,
    actor_user_id: ids.user,
    operation: "auction.start",
    client_key: `queue-activation-${index}`,
    request_hash: "a".repeat(64),
    status: "completed",
    result_type: "fad_nomination_queue",
    result_id: ids.queue,
    created_at_ms: ACCEPTED_AT_MS,
    completed_at_ms: ACCEPTED_AT_MS,
    expires_at_ms: ACCEPTED_AT_MS + DAY_MS,
  });
  const occurrenceKey =
    `fad:${ids.fad}:nomination-open:${ids.queue}:${OPENING_AT_MS}`;
  insert(database, "job_runs", {
    id: ids.activationJob,
    league_id: ids.league,
    season_id: ids.season,
    job_type:
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: OPENING_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: ACCEPTED_AT_MS,
    updated_at_ms: ACCEPTED_AT_MS,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: null,
  });
  insert(database, "free_agent_draft_nomination_queue", {
    id: ids.queue,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    player_id: ids.player,
    source_rollover_id: ids.rollovers[6],
    target_opening_rollover_id: ids.rollovers[6],
    resolution_rollover_id: null,
    opening_total_value_cents: 700,
    opening_term_years: 3,
    opening_aav_cents: 233,
    binding_illegality_confirmed: 1,
    binding_confirmed_at_ms: ACCEPTED_AT_MS,
    submitted_by_user_id: ids.user,
    submitted_by_membership_id: ids.membership,
    accepted_at_ms: ACCEPTED_AT_MS,
    candidate_card_version_observed: 3,
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
}

function seedAdditionalQueuedNomination(
  database,
  ids,
  index = 2
) {
  insert(database, "players", {
    id: ids.player,
    first_name: "Shared",
    last_name: `Queue Player ${index}`,
    full_name: `Shared Queue Player ${index}`,
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: ids.playerSource,
    player_id: ids.player,
    provider: `queue-activation-shared-${index}`,
    source_position: "D",
    normalized_position: "D",
    nhl_team_abbreviation: "SEA",
    active: 1,
    source_version: "1",
    source_payload_json: "{}",
    effective_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
  });
  insert(database, "idempotency_requests", {
    id: ids.request,
    league_id: ids.league,
    actor_user_id: ids.user,
    operation: "auction.start",
    client_key: `queue-activation-shared-${index}`,
    request_hash: "b".repeat(64),
    status: "completed",
    result_type: "fad_nomination_queue",
    result_id: ids.queue,
    created_at_ms: ACCEPTED_AT_MS,
    completed_at_ms: ACCEPTED_AT_MS,
    expires_at_ms: ACCEPTED_AT_MS + DAY_MS,
  });
  const occurrenceKey =
    `fad:${ids.fad}:nomination-open:${ids.queue}:${OPENING_AT_MS}`;
  insert(database, "job_runs", {
    id: ids.activationJob,
    league_id: ids.league,
    season_id: ids.season,
    job_type:
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: OPENING_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: ACCEPTED_AT_MS,
    updated_at_ms: ACCEPTED_AT_MS,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: null,
  });
  insert(database, "free_agent_draft_nomination_queue", {
    id: ids.queue,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    player_id: ids.player,
    source_rollover_id: ids.rollovers[6],
    target_opening_rollover_id: ids.rollovers[6],
    resolution_rollover_id: null,
    opening_total_value_cents: 900,
    opening_term_years: 2,
    opening_aav_cents: 450,
    binding_illegality_confirmed: 1,
    binding_confirmed_at_ms: ACCEPTED_AT_MS,
    submitted_by_user_id: ids.user,
    submitted_by_membership_id: ids.membership,
    accepted_at_ms: ACCEPTED_AT_MS,
    candidate_card_version_observed: 3,
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
}

function createFixture(t, label, options = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `fad-queue-activation-${label}-`)
  );
  const connection = openDatabase({
    databasePath: path.join(directory, "foundation.sqlite"),
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }),
    applicationBuildId: `fad-queue-activation-${label}`,
    now: () => 45,
  });
  withoutTriggers(connection.database, () => {
    seedQueuedNomination(connection.database, PRIMARY, 1);
  });
  let nextId = options.idBase || 90_000;
  let nonceCalls = 0;
  const generated = [];
  const writer =
    createSqliteFreeAgentDraftQueuedNominationActivationWriter({
      database: connection.database,
      createId(description) {
        const id = uuid(nextId);
        nextId += 1;
        generated.push({ description, id });
        return id;
      },
      createDrawNonce() {
        nonceCalls += 1;
        return Buffer.alloc(32, 0x50 + nonceCalls);
      },
      beforeCommit: options.beforeCommit,
    });
  return {
    database: connection.database,
    generated,
    get nonceCalls() {
      return nonceCalls;
    },
    writer,
  };
}

function lookup(ids = PRIMARY) {
  return {
    leagueId: ids.league,
    seasonId: ids.season,
    fadId: ids.fad,
    queueId: ids.queue,
    rolloverAtMs: OPENING_AT_MS,
  };
}

function claim(database, ids = PRIMARY, nowMs = CLAIMED_AT_MS) {
  database.prepare(`
    UPDATE job_runs
    SET status = 'running',
        attempt_count = attempt_count + 1,
        lease_owner = @leaseOwner,
        lease_token = @leaseToken,
        lease_expires_at_ms = @leaseExpiresAtMs,
        started_at_ms = @nowMs,
        completed_at_ms = NULL,
        result_json = NULL,
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @nowMs,
        version = version + 1
    WHERE id = @runId
      AND status = 'pending'
  `).run({
    runId: ids.activationJob,
    leaseOwner: LEASE_OWNER,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    nowMs,
  });
}

function executeCommand(ids = PRIMARY, overrides = {}) {
  return {
    activatedAtMs: ACTIVATED_AT_MS,
    leagueId: ids.league,
    seasonId: ids.season,
    fadId: ids.fad,
    queueId: ids.queue,
    playerId: ids.player,
    openingRolloverId: ids.rollovers[6],
    openingAtMs: OPENING_AT_MS,
    occurrenceKey:
      `fad:${ids.fad}:nomination-open:${ids.queue}:${OPENING_AT_MS}`,
    expectedQueueVersion: 1,
    jobExecution: {
      runId: ids.activationJob,
      expectedVersion: 2,
      leaseOwner: LEASE_OWNER,
      leaseToken: LEASE_TOKEN,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    },
    ...overrides,
  };
}

function failureCommand(ids = PRIMARY, overrides = {}) {
  const execute = executeCommand(ids);
  return {
    failedAtMs: ACTIVATED_AT_MS,
    errorCode:
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
    leagueId: execute.leagueId,
    seasonId: execute.seasonId,
    fadId: execute.fadId,
    queueId: execute.queueId,
    playerId: execute.playerId,
    openingRolloverId: execute.openingRolloverId,
    openingAtMs: execute.openingAtMs,
    occurrenceKey: execute.occurrenceKey,
    expectedQueueVersion: execute.expectedQueueVersion,
    jobExecution: execute.jobExecution,
    ...overrides,
  };
}

function assertRepositoryReason(action, code, reasonCode) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.details?.reasonCode, reasonCode);
    return true;
  });
}

function count(database, tableName, where = "1 = 1", parameters = {}) {
  return database.prepare(`
    SELECT COUNT(*) AS count
    FROM ${tableName}
    WHERE ${where}
  `).get(parameters).count;
}

function requeueRecovery(database, ids, acceptedAtMs, reason) {
  const job = database.prepare(`
    SELECT version
    FROM job_runs
    WHERE id = @runId
  `).get({ runId: ids.activationJob });
  const recovery = database.prepare(`
    SELECT id, version
    FROM free_agent_draft_recoveries
    WHERE league_id = @leagueId
      AND nomination_queue_id = @queueId
      AND job_run_id = @runId
      AND kind = 'queued_nomination_activation'
  `).get({
    leagueId: ids.league,
    queueId: ids.queue,
    runId: ids.activationJob,
  });
  assert.equal(database.prepare(`
    UPDATE job_runs
    SET status = 'pending',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        started_at_ms = NULL,
        completed_at_ms = NULL,
        result_json = NULL,
        last_error_code = NULL,
        next_attempt_at_ms = @acceptedAtMs,
        updated_at_ms = @acceptedAtMs,
        version = version + 1
    WHERE id = @runId
      AND status = 'failed'
      AND version = @expectedVersion
  `).run({
    runId: ids.activationJob,
    expectedVersion: job.version,
    acceptedAtMs,
  }).changes, 1);
  assert.equal(database.prepare(`
    UPDATE free_agent_draft_recoveries
    SET status = 'running',
        commissioner_reason = @reason,
        updated_at_ms = @acceptedAtMs,
        version = version + 1
    WHERE id = @recoveryId
      AND status = 'correction_required'
      AND version = @expectedVersion
  `).run({
    recoveryId: recovery.id,
    expectedVersion: recovery.version,
    acceptedAtMs,
    reason,
  }).changes, 1);
  return recovery.id;
}

describe("FAD-13 queued-nomination activation writer", () => {
  test("exports the frozen surface and atomically opens a sequence-seven queue with exact private replay evidence", (t) => {
    const fixture = createFixture(t, "open");
    const commissionerUser = uuid(98_001);
    const commissionerMembership = uuid(98_002);
    const administratorUser = uuid(98_003);
    const administratorMembership = uuid(98_004);
    const administratorRole = uuid(98_005);
    const replacementCommissionerUser = uuid(98_006);
    const replacementCommissionerMembership = uuid(98_007);
    withoutTriggers(fixture.database, () => {
      for (const [userId, label] of [
        [commissionerUser, "commissioner"],
        [administratorUser, "administrator"],
        [replacementCommissionerUser, "replacement"],
      ]) {
        insert(fixture.database, "users", {
          id: userId,
          email_normalized: `queue-${label}@example.test`,
          email_display: `queue-${label}@example.test`,
          display_name: `Queue ${label}`,
          display_name_normalized: `queue ${label}`,
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
      }
      for (const [membershipId, userId, permissionCategory] of [
        [commissionerMembership, commissionerUser, "commissioner"],
        [administratorMembership, administratorUser, "member"],
        [
          replacementCommissionerMembership,
          replacementCommissionerUser,
          "member",
        ],
      ]) {
        insert(fixture.database, "league_memberships", {
          id: membershipId,
          league_id: PRIMARY.league,
          user_id: userId,
          permission_category: permissionCategory,
          status: "active",
          joined_at_ms: 1,
          ended_at_ms: null,
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
      }
      insert(fixture.database, "platform_roles", {
        id: administratorRole,
        user_id: administratorUser,
        role: "platform_administrator",
        status: "active",
        granted_by_user_id: null,
        granted_at_ms: 1,
        ended_at_ms: null,
        version: 1,
      });
      fixture.database.prepare(`
        UPDATE leagues
        SET commissioner_membership_id = @membershipId,
            version = version + 1
        WHERE id = @leagueId
      `).run({
        membershipId: commissionerMembership,
        leagueId: PRIMARY.league,
      });
    });
    assert.deepEqual(
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_WRITER_METHODS,
      ["findActivation", "executeClaimed", "recordFailure"]
    );
    assert.ok(
      Object.isFrozen(
        FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_WRITER_METHODS
      )
    );
    assert.deepEqual(Object.keys(fixture.writer), [
      "findActivation",
      "executeClaimed",
      "recordFailure",
    ]);
    assert.deepEqual(fixture.writer.findActivation(lookup()), {
      leagueId: PRIMARY.league,
      seasonId: PRIMARY.season,
      fadId: PRIMARY.fad,
      queueId: PRIMARY.queue,
      playerId: PRIMARY.player,
      openingRolloverId: PRIMARY.rollovers[6],
      openingAtMs: OPENING_AT_MS,
      status: "queued",
      queueVersion: 1,
      activationJobRunId: PRIMARY.activationJob,
      activationOccurrenceKey:
        `fad:${PRIMARY.fad}:nomination-open:${PRIMARY.queue}:${OPENING_AT_MS}`,
      jobStatus: "pending",
      jobRunVersion: 1,
      resolutionRolloverId: null,
      auctionId: null,
      starterBidId: null,
      recoveryId: null,
      recoveryStatus: null,
      recoveryVersion: null,
    });

    claim(fixture.database);
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE team_manager_assignments
        SET status = 'ended',
            ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @assignmentId
      `).run({
        assignmentId: PRIMARY.assignment,
        endedAtMs: ACCEPTED_AT_MS + 1,
      });
    });
    const result = fixture.writer.executeClaimed(executeCommand());
    assert.equal(result.outcome, "opened");
    assert.equal(result.replayed, false);
    assert.equal(result.queueVersion, 2);
    assert.equal(result.jobRunVersion, 3);
    assert.equal(result.openingAtMs, OPENING_AT_MS);
    assert.equal(result.activatedAtMs, ACTIVATED_AT_MS);
    assert.equal(result.resolvesAtMs, OPENING_AT_MS + DAY_MS);
    assert.equal(result.validationCode, null);
    assert.equal(result.sourceRecoveryId, null);
    assert.equal(
      result.evidence.extensionRolloverId,
      uuid(90_000)
    );
    assert.equal(result.auctionId, uuid(90_001));
    assert.equal(result.drawId, uuid(90_002));
    assert.equal(result.starterBidId, uuid(90_003));
    assert.equal(result.evidence.auctionEventId, uuid(90_004));
    assert.equal(result.resolutionJobRunId, uuid(90_005));
    assert.equal(fixture.nonceCalls, 1);

    const queue = fixture.database.prepare(`
      SELECT *
      FROM free_agent_draft_nomination_queue
      WHERE id = ?
    `).get(PRIMARY.queue);
    assert.equal(queue.status, "opened");
    assert.equal(queue.opened_at_ms, OPENING_AT_MS);
    assert.equal(queue.terminal_at_ms, ACTIVATED_AT_MS);
    assert.equal(queue.resolution_rollover_id, uuid(90_000));
    assert.equal(queue.opened_auction_id, uuid(90_001));
    assert.equal(queue.opened_starter_bid_id, uuid(90_003));
    assert.equal(queue.version, 2);

    const event = fixture.database.prepare(`
      SELECT * FROM auction_events WHERE id = ?
    `).get(uuid(90_004));
    assert.deepEqual(JSON.parse(event.metadata_json), {
      openingTeamId: PRIMARY.team,
      actorMembershipId: PRIMARY.membership,
      actorAuthority: "manager",
      playerPosition: "F",
      creationCutoffAtMs: OPENING_AT_MS - HOUR_MS,
      bidClosesAtMs: OPENING_AT_MS + DAY_MS,
      totalValueCents: 700,
      termYears: 3,
      aavCents: 233,
      bindingIllegalityConfirmed: true,
      fadId: PRIMARY.fad,
      fadRolloverId: uuid(90_000),
    });
    assert.equal(event.occurred_at_ms, OPENING_AT_MS);

    const storedJob = fixture.database.prepare(`
      SELECT * FROM job_runs WHERE id = ?
    `).get(PRIMARY.activationJob);
    assert.equal(storedJob.status, "succeeded");
    assert.equal(storedJob.completed_at_ms, ACTIVATED_AT_MS);
    assert.equal(storedJob.updated_at_ms, ACTIVATED_AT_MS);
    assert.equal(storedJob.version, 3);
    assert.ok(!storedJob.result_json.includes(PRIMARY.user));
    assert.ok(!storedJob.result_json.includes(PRIMARY.membership));
    assert.ok(!storedJob.result_json.includes(PRIMARY.team));
    assert.ok(!storedJob.result_json.includes(PRIMARY.player));
    assert.ok(!storedJob.result_json.includes("totalValue"));
    assert.ok(!storedJob.result_json.includes(LEASE_TOKEN));

    const publications = fixture.database.prepare(`
      SELECT id, event_type, aggregate_type, aggregate_id,
             payload_json, created_at_ms
      FROM outbox_events
      ORDER BY event_type
    `).all();
    assert.equal(publications.length, 2);
    const auctionPublication = publications.find(
      ({ event_type: eventType }) => eventType === "auction.changed"
    );
    const queuePublication = publications.find(
      ({ event_type: eventType }) =>
        eventType === "fad_nomination_queue.changed"
    );
    assert.deepEqual(JSON.parse(queuePublication.payload_json), {
      eventId: queuePublication.id,
      type: "fad_nomination_queue.changed",
      leagueId: PRIMARY.league,
      resourceId: PRIMARY.queue,
      version: 2,
      reasonCode: "nomination_opened",
      occurredAt: ACTIVATED_AT_MS,
      related: {
        fadId: PRIMARY.fad,
        teamId: PRIMARY.team,
        cardId: null,
        allocationId: null,
        auctionId: null,
        recoveryId: null,
        nominationQueueId: PRIMARY.queue,
        scheduleRecoveryOperationId: null,
      },
    });
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT audience_kind, team_id, user_id
        FROM outbox_event_audiences
        WHERE outbox_event_id = ?
        ORDER BY audience_kind, COALESCE(team_id, user_id)
      `).all(queuePublication.id),
      [
        {
          audience_kind: "team",
          team_id: PRIMARY.team,
          user_id: null,
        },
        {
          audience_kind: "user",
          team_id: null,
          user_id: commissionerUser,
        },
        {
          audience_kind: "user",
          team_id: null,
          user_id: administratorUser,
        },
      ].sort((left, right) =>
        `${left.audience_kind}:${left.team_id || left.user_id}`
          .localeCompare(
            `${right.audience_kind}:${right.team_id || right.user_id}`
          )
      )
    );
    assert.deepEqual(JSON.parse(auctionPublication.payload_json), {
      eventId: auctionPublication.id,
      type: "auction.changed",
      leagueId: PRIMARY.league,
      resourceId: result.auctionId,
      version: 1,
      reasonCode: "auction_changed",
      occurredAt: ACTIVATED_AT_MS,
      related: {
        fadId: PRIMARY.fad,
        teamId: PRIMARY.team,
        cardId: null,
        allocationId: null,
        auctionId: result.auctionId,
        recoveryId: null,
        nominationQueueId: PRIMARY.queue,
        scheduleRecoveryOperationId: null,
      },
    });
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT audience_kind, team_id, user_id
        FROM outbox_event_audiences
        WHERE outbox_event_id = ?
      `).all(auctionPublication.id),
      [
        {
          audience_kind: "league",
          team_id: null,
          user_id: null,
        },
      ]
    );
    for (const publication of publications) {
      assert.equal(publication.created_at_ms, ACTIVATED_AT_MS);
      assert.ok(!publication.payload_json.includes(PRIMARY.player));
      assert.ok(!publication.payload_json.includes(PRIMARY.user));
      assert.ok(!publication.payload_json.includes("totalValue"));
    }

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE platform_roles
        SET status = 'ended', ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @roleId
      `).run({
        endedAtMs: ACTIVATED_AT_MS + 1,
        roleId: administratorRole,
      });
      fixture.database.prepare(`
        UPDATE league_memberships
        SET permission_category = 'member',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `).run({
        membershipId: commissionerMembership,
        updatedAtMs: ACTIVATED_AT_MS + 1,
      });
      fixture.database.prepare(`
        UPDATE league_memberships
        SET permission_category = 'commissioner',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `).run({
        membershipId: replacementCommissionerMembership,
        updatedAtMs: ACTIVATED_AT_MS + 1,
      });
      fixture.database.prepare(`
        UPDATE leagues
        SET commissioner_membership_id = @membershipId,
            version = version + 1
        WHERE id = @leagueId
      `).run({
        membershipId: replacementCommissionerMembership,
        leagueId: PRIMARY.league,
      });
      fixture.database.prepare(`
        UPDATE outbox_events
        SET status = 'failed', attempt_count = 1,
            available_at_ms = @availableAtMs,
            last_error_code = 'TRANSIENT_PUBLICATION_FAILURE',
            updated_at_ms = @updatedAtMs, version = version + 1
        WHERE league_id = @leagueId
      `).run({
        availableAtMs: ACTIVATED_AT_MS + DAY_MS,
        updatedAtMs: ACTIVATED_AT_MS + 1,
        leagueId: PRIMARY.league,
      });
      fixture.database.prepare(`
        UPDATE players
        SET full_name = 'Renamed After Opening',
            version = version + 1
        WHERE id = @playerId
      `).run({ playerId: PRIMARY.player });
      fixture.database.prepare(`
        UPDATE teams
        SET name = 'Renamed Queue Team',
            name_normalized = 'renamed queue team',
            version = version + 1
        WHERE id = @teamId
      `).run({ teamId: PRIMARY.team });
      fixture.database.prepare(`
        UPDATE auctions
        SET status = 'resolved',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @auctionId
      `).run({
        auctionId: result.auctionId,
        updatedAtMs: ACTIVATED_AT_MS + 1_000,
      });
      fixture.database.prepare(`
        UPDATE auction_bids
        SET total_value_cents = 800,
            term_years = 1,
            lowest_offered_aav_cents = 800,
            last_edited_at_ms = @editedAtMs,
            edit_count = 1,
            version = version + 1
        WHERE id = @starterBidId
      `).run({
        starterBidId: result.starterBidId,
        editedAtMs: ACTIVATED_AT_MS + 500,
      });
    });
    const replay = fixture.writer.executeClaimed({
      ...executeCommand(),
      activatedAtMs: ACTIVATED_AT_MS + 5_000,
    });
    assert.deepEqual(replay, { ...result, replayed: true });
    assert.equal(fixture.nonceCalls, 1);
    assert.equal(fixture.generated.length, 6);
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE job_runs
        SET result_json = '{}'
        WHERE id = @runId
      `).run({ runId: PRIMARY.activationJob });
    });
    assertRepositoryReason(
      () => fixture.writer.findActivation(lookup()),
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "STORED_RESULT_INVALID"
    );
  });

  test("does not leak a terminal queue event to a category-drifted commissioner or a platform administrator whose league membership has not started", (t) => {
    const fixture = createFixture(t, "protected-authority-drift");
    const driftedCommissionerUser = uuid(99_001);
    const driftedCommissionerMembership = uuid(99_002);
    const futureAdministratorUser = uuid(99_003);
    const futureAdministratorMembership = uuid(99_004);
    const futureAdministratorRole = uuid(99_005);
    withoutTriggers(fixture.database, () => {
      for (const [userId, label] of [
        [driftedCommissionerUser, "drifted-commissioner"],
        [futureAdministratorUser, "future-administrator"],
      ]) {
        insert(fixture.database, "users", {
          id: userId,
          email_normalized: `queue-${label}@example.test`,
          email_display: `queue-${label}@example.test`,
          display_name: `Queue ${label}`,
          display_name_normalized: `queue ${label}`,
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
      }
      for (const membership of [
        {
          id: driftedCommissionerMembership,
          userId: driftedCommissionerUser,
          permissionCategory: "member",
          joinedAtMs: 1,
        },
        {
          id: futureAdministratorMembership,
          userId: futureAdministratorUser,
          permissionCategory: "member",
          joinedAtMs: ACTIVATED_AT_MS + 1,
        },
      ]) {
        insert(fixture.database, "league_memberships", {
          id: membership.id,
          league_id: PRIMARY.league,
          user_id: membership.userId,
          permission_category: membership.permissionCategory,
          status: "active",
          joined_at_ms: membership.joinedAtMs,
          ended_at_ms: null,
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
      }
      insert(fixture.database, "platform_roles", {
        id: futureAdministratorRole,
        user_id: futureAdministratorUser,
        role: "platform_administrator",
        status: "active",
        granted_by_user_id: null,
        granted_at_ms: 1,
        ended_at_ms: null,
        version: 1,
      });
      fixture.database.prepare(`
        UPDATE leagues
        SET commissioner_membership_id = @membershipId,
            version = version + 1
        WHERE id = @leagueId
      `).run({
        membershipId: driftedCommissionerMembership,
        leagueId: PRIMARY.league,
      });
    });
    claim(fixture.database);

    const result = fixture.writer.executeClaimed(executeCommand());
    const publication = fixture.database.prepare(`
      SELECT id
      FROM outbox_events
      WHERE league_id = @leagueId
        AND event_type = 'fad_nomination_queue.changed'
    `).get({ leagueId: PRIMARY.league });

    assert.deepEqual(
      fixture.database.prepare(`
        SELECT audience_kind, team_id, user_id
        FROM outbox_event_audiences
        WHERE outbox_event_id = @eventId
        ORDER BY audience_kind, COALESCE(team_id, user_id)
      `).all({ eventId: publication.id }),
      [
        {
          audience_kind: "team",
          team_id: PRIMARY.team,
          user_id: null,
        },
      ]
    );
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE league_memberships
        SET permission_category = 'commissioner',
            version = version + 1
        WHERE id = @membershipId
      `).run({ membershipId: driftedCommissionerMembership });
    });
    assert.deepEqual(
      fixture.writer.executeClaimed({
        ...executeCommand(),
        activatedAtMs: ACTIVATED_AT_MS + 10_000,
      }),
      { ...result, replayed: true }
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_event_audiences
        WHERE outbox_event_id = @eventId
          AND audience_kind = 'user'
      `).get({ eventId: publication.id }).count,
      0
    );
  });

  test("objectively unavailable players invalidate privately with no auction entropy or artifacts and replay immutably", (t) => {
    const fixture = createFixture(t, "invalid");
    claim(fixture.database);
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE players
        SET status = 'historical',
            version = version + 1
        WHERE id = @playerId
      `).run({ playerId: PRIMARY.player });
    });

    const result = fixture.writer.executeClaimed(executeCommand());
    assert.deepEqual(result, {
      outcome: "invalid",
      leagueId: PRIMARY.league,
      seasonId: PRIMARY.season,
      fadId: PRIMARY.fad,
      queueId: PRIMARY.queue,
      openingRolloverId: PRIMARY.rollovers[6],
      resolutionRolloverId: null,
      openingAtMs: OPENING_AT_MS,
      activatedAtMs: ACTIVATED_AT_MS,
      resolvesAtMs: null,
      queueVersion: 2,
      auctionId: null,
      starterBidId: null,
      drawId: null,
      resolutionJobRunId: null,
      validationCode: "PLAYER_UNAVAILABLE",
      jobRunId: PRIMARY.activationJob,
      jobRunVersion: 3,
      sourceRecoveryId: null,
      evidence: {
        auctionEventId: null,
        extensionRolloverId: null,
      },
      replayed: false,
    });
    assert.equal(fixture.generated.length, 0);
    assert.equal(fixture.nonceCalls, 0);
    assert.equal(count(fixture.database, "auctions"), 0);
    assert.equal(count(fixture.database, "auction_bids"), 0);
    assert.equal(count(fixture.database, "auction_events"), 0);
    assert.equal(count(fixture.database, "free_agent_draft_draws"), 0);
    assert.equal(
      count(
        fixture.database,
        "job_runs",
        "job_type = 'auction.resolve.target'"
      ),
      0
    );
    assert.equal(
      count(fixture.database, "free_agent_draft_rollovers"),
      7
    );
    assert.equal(
      count(fixture.database, "free_agent_draft_recoveries"),
      0
    );
    const publication = fixture.database.prepare(`
      SELECT id, event_type, aggregate_type, aggregate_id,
             payload_json, created_at_ms
      FROM outbox_events
    `).get();
    assert.equal(count(fixture.database, "outbox_events"), 1);
    assert.equal(
      publication.event_type,
      "fad_nomination_queue.changed"
    );
    assert.equal(publication.aggregate_type, "fad_nomination_queue");
    assert.equal(publication.aggregate_id, PRIMARY.queue);
    assert.equal(publication.created_at_ms, ACTIVATED_AT_MS);
    assert.deepEqual(JSON.parse(publication.payload_json), {
      eventId: publication.id,
      type: "fad_nomination_queue.changed",
      leagueId: PRIMARY.league,
      resourceId: PRIMARY.queue,
      version: 2,
      reasonCode: "nomination_opened",
      occurredAt: ACTIVATED_AT_MS,
      related: {
        fadId: PRIMARY.fad,
        teamId: PRIMARY.team,
        cardId: null,
        allocationId: null,
        auctionId: null,
        recoveryId: null,
        nominationQueueId: PRIMARY.queue,
        scheduleRecoveryOperationId: null,
      },
    });
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_events
        WHERE event_type = 'auction.changed'
      `).get().count,
      0
    );
    const queue = fixture.database.prepare(`
      SELECT *
      FROM free_agent_draft_nomination_queue
      WHERE id = ?
    `).get(PRIMARY.queue);
    assert.equal(queue.status, "invalid");
    assert.equal(queue.validation_code, "PLAYER_UNAVAILABLE");
    assert.equal(queue.terminal_at_ms, ACTIVATED_AT_MS);

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE players
        SET status = 'active',
            version = version + 1
        WHERE id = @playerId
      `).run({ playerId: PRIMARY.player });
    });
    assert.deepEqual(
      fixture.writer.executeClaimed({
        ...executeCommand(),
        activatedAtMs: ACTIVATED_AT_MS + 10_000,
      }),
      { ...result, replayed: true }
    );
    assert.equal(fixture.generated.length, 0);
    assert.equal(fixture.nonceCalls, 0);
  });

  test("a terminal private-publication identity collision rolls invalidation and job completion back", (t) => {
    const fixture = createFixture(t, "outbox-collision");
    claim(fixture.database);
    const collisionId = deterministicUuid(
      `fad-queued-nomination:${PRIMARY.queue}:nomination-opened`
    );
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE players
        SET status = 'historical', version = version + 1
        WHERE id = @playerId
      `).run({ playerId: PRIMARY.player });
      insert(fixture.database, "outbox_events", {
        id: collisionId,
        league_id: PRIMARY.league,
        event_type: "league.changed",
        aggregate_type: "league",
        aggregate_id: PRIMARY.league,
        payload_json: "{}",
        status: "pending",
        attempt_count: 0,
        available_at_ms: 1,
        published_at_ms: null,
        last_error_code: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
    });

    assertRepositoryReason(
      () => fixture.writer.executeClaimed(executeCommand()),
      REPOSITORY_ERROR_CODES.constraint,
      undefined
    );
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT status, terminal_at_ms, validation_code, version
        FROM free_agent_draft_nomination_queue
        WHERE id = ?
      `).get(PRIMARY.queue),
      {
        status: "queued",
        terminal_at_ms: null,
        validation_code: null,
        version: 1,
      }
    );
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT status, completed_at_ms, result_json, version
        FROM job_runs
        WHERE id = ?
      `).get(PRIMARY.activationJob),
      {
        status: "running",
        completed_at_ms: null,
        result_json: null,
        version: 2,
      }
    );
    assert.equal(count(fixture.database, "outbox_events"), 1);
    assert.equal(count(fixture.database, "outbox_event_audiences"), 0);
  });

  test("lease, version, expiry, and lifecycle drift fail closed without writes and remain retryable", (t) => {
    const fixture = createFixture(t, "fences");
    claim(fixture.database);
    assertRepositoryReason(
      () => fixture.writer.executeClaimed({
        ...executeCommand(),
        expectedQueueVersion: 2,
      }),
      REPOSITORY_ERROR_CODES.versionConflict,
      "ACTIVATION_FENCE_CHANGED"
    );
    assertRepositoryReason(
      () => fixture.writer.executeClaimed({
        ...executeCommand(),
        jobExecution: {
          ...executeCommand().jobExecution,
          leaseToken: "wrong-lease-token",
        },
      }),
      REPOSITORY_ERROR_CODES.versionConflict,
      "ACTIVATION_FENCE_CHANGED"
    );
    assertRepositoryReason(
      () => fixture.writer.executeClaimed({
        ...executeCommand(),
        activatedAtMs: LEASE_EXPIRES_AT_MS,
      }),
      REPOSITORY_ERROR_CODES.versionConflict,
      "ACTIVATION_FENCE_CHANGED"
    );
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE teams
        SET status = 'inactive',
            version = version + 1
        WHERE id = @teamId
      `).run({ teamId: PRIMARY.team });
    });
    assertRepositoryReason(
      () => fixture.writer.executeClaimed(executeCommand()),
      REPOSITORY_ERROR_CODES.versionConflict,
      "ACTIVATION_LIFECYCLE_CHANGED"
    );
    assert.equal(count(fixture.database, "auctions"), 0);
    assert.equal(
      count(fixture.database, "free_agent_draft_recoveries"),
      0
    );
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT status, version, result_json, last_error_code
        FROM job_runs
        WHERE id = ?
      `).get(PRIMARY.activationJob),
      {
        status: "running",
        version: 2,
        result_json: null,
        last_error_code: null,
      }
    );
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE teams
        SET status = 'active',
            version = version + 1
        WHERE id = @teamId
      `).run({ teamId: PRIMARY.team });
    });
    assert.equal(
      fixture.writer.executeClaimed(executeCommand()).outcome,
      "opened"
    );
  });

  test("recordFailure reuses one causal recovery across T142 retries before success resolves it", (t) => {
    const fixture = createFixture(t, "recovery");
    claim(fixture.database);
    const firstCommand = failureCommand();
    const first = fixture.writer.recordFailure(firstCommand);
    assert.equal(first.recorded, true);
    assert.equal(first.replayed, false);
    assert.equal(first.recoveryVersion, 1);
    assert.equal(first.jobRunVersion, 3);
    assert.equal(fixture.generated.length, 1);
    const recoveryId = first.recoveryId;
    assert.deepEqual(
      fixture.writer.recordFailure(firstCommand),
      { ...first, replayed: true }
    );
    assert.equal(fixture.generated.length, 1);
    assert.equal(count(fixture.database, "auctions"), 0);
    assert.equal(count(fixture.database, "auction_events"), 0);
    assert.equal(
      count(fixture.database, "free_agent_draft_recoveries"),
      1
    );
    const jobRepository =
      createSqliteFreeAgentDraftJobRepository({
        database: fixture.database,
      });
    assert.deepEqual(
      jobRepository.listDue({
        nowMs: LEASE_EXPIRES_AT_MS + DAY_MS,
        limit: 100,
      }),
      []
    );

    const firstRetryAtMs = ACTIVATED_AT_MS + 100;
    assert.equal(
      requeueRecovery(
        fixture.database,
        PRIMARY,
        firstRetryAtMs,
        "Commissioner approved the first retry."
      ),
      recoveryId
    );
    const secondClaimAtMs = ACTIVATED_AT_MS + 200;
    claim(fixture.database, PRIMARY, secondClaimAtMs);
    const secondFailedAtMs = ACTIVATED_AT_MS + 300;
    const secondCommand = failureCommand(PRIMARY, {
      failedAtMs: secondFailedAtMs,
      jobExecution: {
        ...failureCommand().jobExecution,
        expectedVersion: 5,
      },
    });
    const second = fixture.writer.recordFailure(secondCommand);
    assert.equal(second.recoveryId, recoveryId);
    assert.equal(second.recoveryVersion, 3);
    assert.equal(second.jobRunVersion, 6);
    assert.equal(fixture.generated.length, 1);
    assert.deepEqual(
      fixture.writer.recordFailure(secondCommand),
      { ...second, replayed: true }
    );

    const secondRetryAtMs = ACTIVATED_AT_MS + 400;
    requeueRecovery(
      fixture.database,
      PRIMARY,
      secondRetryAtMs,
      "Commissioner approved the final retry."
    );
    const thirdClaimAtMs = ACTIVATED_AT_MS + 500;
    claim(fixture.database, PRIMARY, thirdClaimAtMs);
    const succeededAtMs = ACTIVATED_AT_MS + 600;
    const success = fixture.writer.executeClaimed(
      executeCommand(PRIMARY, {
        activatedAtMs: succeededAtMs,
        jobExecution: {
          ...executeCommand().jobExecution,
          expectedVersion: 8,
        },
      })
    );
    assert.equal(success.outcome, "opened");
    assert.equal(success.sourceRecoveryId, recoveryId);
    assert.equal(success.jobRunVersion, 9);
    const recovery = fixture.database.prepare(`
      SELECT *
      FROM free_agent_draft_recoveries
      WHERE id = ?
    `).get(recoveryId);
    assert.equal(recovery.status, "resolved");
    assert.equal(recovery.version, 5);
    assert.equal(recovery.resolved_authority, "system");
    assert.equal(recovery.resolved_at_ms, succeededAtMs);
    assert.equal(
      recovery.commissioner_reason,
      "Commissioner approved the final retry."
    );
    assert.equal(recovery.last_error_code, null);
    assert.equal(
      count(fixture.database, "free_agent_draft_recoveries"),
      1
    );
    const resultJson = fixture.database.prepare(`
      SELECT result_json
      FROM job_runs
      WHERE id = ?
    `).get(PRIMARY.activationJob).result_json;
    assert.ok(!resultJson.includes(PRIMARY.user));
    assert.ok(!resultJson.includes(PRIMARY.team));
    assert.ok(!resultJson.includes(PRIMARY.player));
    assert.ok(!resultJson.includes(LEASE_TOKEN));
  });

  test("beforeCommit exceptions roll the extension, auction chain, queue terminal state, and job completion back together", (t) => {
    const fixture = createFixture(t, "rollback", {
      beforeCommit() {
        throw new Error("queued activation rollback checkpoint");
      },
    });
    claim(fixture.database);
    assert.throws(
      () => fixture.writer.executeClaimed(executeCommand()),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.operationFailed
        );
        return true;
      }
    );
    assert.equal(count(fixture.database, "auctions"), 0);
    assert.equal(count(fixture.database, "auction_bids"), 0);
    assert.equal(count(fixture.database, "auction_events"), 0);
    assert.equal(count(fixture.database, "free_agent_draft_draws"), 0);
    assert.equal(count(fixture.database, "outbox_events"), 0);
    assert.equal(count(fixture.database, "outbox_event_audiences"), 0);
    assert.equal(
      count(fixture.database, "free_agent_draft_rollovers"),
      7
    );
    assert.equal(
      count(
        fixture.database,
        "job_runs",
        "job_type = 'auction.resolve.target'"
      ),
      0
    );
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT status, version, terminal_at_ms,
               resolution_rollover_id, opened_auction_id
        FROM free_agent_draft_nomination_queue
        WHERE id = ?
      `).get(PRIMARY.queue),
      {
        status: "queued",
        version: 1,
        terminal_at_ms: null,
        resolution_rollover_id: null,
        opened_auction_id: null,
      }
    );
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT status, version, completed_at_ms, result_json
        FROM job_runs
        WHERE id = ?
      `).get(PRIMARY.activationJob),
      {
        status: "running",
        version: 2,
        completed_at_ms: null,
        result_json: null,
      }
    );
    assert.throws(
      () => fixture.writer.recordFailure(failureCommand()),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.operationFailed
        );
        return true;
      }
    );
    assert.equal(
      count(fixture.database, "free_agent_draft_recoveries"),
      0
    );
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT status, version, completed_at_ms,
               result_json, last_error_code
        FROM job_runs
        WHERE id = ?
      `).get(PRIMARY.activationJob),
      {
        status: "running",
        version: 2,
        completed_at_ms: null,
        result_json: null,
        last_error_code: null,
      }
    );
  });

  test("two queues at the same seventh-rollover boundary share one successor without cross-linking evidence", (t) => {
    const fixture = createFixture(t, "shared-rollover");
    withoutTriggers(fixture.database, () => {
      seedAdditionalQueuedNomination(
        fixture.database,
        SECONDARY_QUEUE,
        2
      );
    });
    claim(fixture.database, PRIMARY, CLAIMED_AT_MS);
    claim(
      fixture.database,
      SECONDARY_QUEUE,
      CLAIMED_AT_MS + 1
    );
    const first = fixture.writer.executeClaimed(executeCommand());
    const second = fixture.writer.executeClaimed(
      executeCommand(SECONDARY_QUEUE, {
        activatedAtMs: ACTIVATED_AT_MS + 1,
      })
    );
    assert.equal(first.outcome, "opened");
    assert.equal(second.outcome, "opened");
    assert.equal(
      first.resolutionRolloverId,
      second.resolutionRolloverId
    );
    assert.equal(
      first.evidence.extensionRolloverId,
      first.resolutionRolloverId
    );
    assert.equal(second.evidence.extensionRolloverId, null);
    assert.notEqual(first.auctionId, second.auctionId);
    assert.notEqual(first.starterBidId, second.starterBidId);
    assert.equal(
      count(fixture.database, "free_agent_draft_rollovers"),
      8
    );
    assert.equal(count(fixture.database, "outbox_events"), 4);
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(DISTINCT league_id) AS count
        FROM outbox_events
      `).get().count,
      1
    );
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT json_extract(
                 payload_json,
                 '$.related.nominationQueueId'
               ) AS queue_id,
               COUNT(*) AS count
        FROM outbox_events
        GROUP BY queue_id
        ORDER BY queue_id
      `).all(),
      [PRIMARY.queue, SECONDARY_QUEUE.queue]
        .sort()
        .map((queueId) => ({ queue_id: queueId, count: 2 }))
    );
    const successor = fixture.database.prepare(`
      SELECT *
      FROM free_agent_draft_rollovers
      WHERE id = ?
    `).get(first.resolutionRolloverId);
    assert.equal(successor.sequence, 8);
    assert.equal(successor.extension_reason, "queued_nomination");
    assert.equal(successor.extension_source_id, PRIMARY.queue);
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT id, resolution_rollover_id, opened_auction_id,
               opened_starter_bid_id, status
        FROM free_agent_draft_nomination_queue
        ORDER BY id
      `).all(),
      [PRIMARY.queue, SECONDARY_QUEUE.queue]
        .sort()
        .map((queueId) => {
          const result = queueId === PRIMARY.queue ? first : second;
          return {
            id: queueId,
            resolution_rollover_id: first.resolutionRolloverId,
            opened_auction_id: result.auctionId,
            opened_starter_bid_id: result.starterBidId,
            status: "opened",
          };
        })
    );
  });
});
