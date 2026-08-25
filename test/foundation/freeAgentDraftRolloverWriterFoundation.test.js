"use strict";

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
const {
  FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
  FREE_AGENT_DRAFT_ROLLOVER_JOB_TYPE,
  FREE_AGENT_DRAFT_ROLLOVER_WRITER_METHODS,
  createSqliteFreeAgentDraftRolloverWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRolloverWriter"
);
const {
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  buildFreeAgentDraftDeadlineOccurrenceKey,
  buildFreeAgentDraftReadinessOccurrenceKey,
  buildFreeAgentDraftReminderOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
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
const ROLLOVER_AT_MS = 2_000_000_000_000;
const FAD_OPENED_AT_MS = ROLLOVER_AT_MS - 37 * DAY_MS;
const CANDIDATE_DEADLINE_AT_MS = ROLLOVER_AT_MS - 7 * DAY_MS;
const REMINDER_AT_MS = CANDIDATE_DEADLINE_AT_MS - 3 * DAY_MS;
const CLAIMED_AT_MS = ROLLOVER_AT_MS + 100;
const FINALIZED_AT_MS = ROLLOVER_AT_MS + 200;
const RETRY_ACCEPTED_AT_MS = ROLLOVER_AT_MS + 300;
const RETRY_STARTED_AT_MS = ROLLOVER_AT_MS + 400;
const RETRY_TERMINAL_AT_MS = ROLLOVER_AT_MS + 500;
const LEASE_EXPIRES_AT_MS = ROLLOVER_AT_MS + HOUR_MS;
const LEASE_OWNER = "fad-rollover-worker";
const LEASE_TOKEN = "fad-rollover-lease-token";

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  week: uuid(3),
  readiness: uuid(4),
  fad: uuid(5),
  readinessJob: uuid(6),
  reminderJob: uuid(7),
  deadlineJob: uuid(8),
  cardsOpenedActivity: uuid(9),
  cardsOpenedOutbox: uuid(10),
  cardsOpenedAudience: uuid(11),
  rollovers: Object.freeze(
    Array.from({ length: 7 }, (_, index) => uuid(100 + index))
  ),
  rollover: uuid(106),
  job: uuid(10_000),
  actorUser: uuid(20_001),
  actorMembership: uuid(20_002),
  retryRequest: uuid(20_003),
  retryReceipt: uuid(20_004),
  player: uuid(30_001),
  auction: uuid(30_002),
});

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  try {
    database.prepare(`
      INSERT INTO ${tableName} (${fields.join(", ")})
      VALUES (${fields.map((field) => `@${field}`).join(", ")})
    `).run(values);
  } catch (error) {
    throw new Error(`${tableName}: ${error.message}`, { cause: error });
  }
}

function withoutTriggers(database, mutate) {
  const triggers = database.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' ORDER BY name
  `).all();
  try {
    for (const { name } of triggers) {
      database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
    mutate();
  } finally {
    for (const { sql } of triggers) database.exec(sql);
  }
}

function seed(database) {
  insert(database, "leagues", {
    id: IDS.league,
    name: "Rollover League",
    name_normalized: "rollover league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: IDS.season,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: ROLLOVER_AT_MS,
    regular_season_ends_at_ms: ROLLOVER_AT_MS + 200 * DAY_MS,
    fantasy_playoffs_start_at_ms: ROLLOVER_AT_MS + 150 * DAY_MS,
    fantasy_playoffs_end_at_ms: ROLLOVER_AT_MS + 190 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "users", {
    id: IDS.actorUser,
    email_normalized: "rollover-commissioner@example.test",
    email_display: "rollover-commissioner@example.test",
    display_name: "Rollover Commissioner",
    display_name_normalized: "rollover commissioner",
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: IDS.actorMembership,
    league_id: IDS.league,
    user_id: IDS.actorUser,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: IDS.week,
    league_id: IDS.league,
    season_id: IDS.season,
    week_key: "2026-W01",
    sequence: 1,
    starts_at_ms: ROLLOVER_AT_MS,
    baseline_at_ms: ROLLOVER_AT_MS + HOUR_MS,
    locks_at_ms: ROLLOVER_AT_MS + 2 * HOUR_MS,
    ends_at_ms: ROLLOVER_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms: ROLLOVER_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  for (const [
    id,
    jobType,
    occurrenceKey,
    scheduledForMs,
    status,
  ] of [
    [
      IDS.readinessJob,
      "fad_readiness",
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: IDS.league,
        seasonId: IDS.season,
        triggerResourceId: IDS.season,
      }),
      FAD_OPENED_AT_MS,
      "succeeded",
    ],
    [
      IDS.reminderJob,
      "fad_deadline_reminder",
      buildFreeAgentDraftReminderOccurrenceKey({
        fadId: IDS.fad,
        reminderAtMs: REMINDER_AT_MS,
      }),
      REMINDER_AT_MS,
      "pending",
    ],
    [
      IDS.deadlineJob,
      "fad_deadline",
      buildFreeAgentDraftDeadlineOccurrenceKey({
        fadId: IDS.fad,
        deadlineAtMs: CANDIDATE_DEADLINE_AT_MS,
      }),
      CANDIDATE_DEADLINE_AT_MS,
      "pending",
    ],
  ]) {
    const succeeded = status === "succeeded";
    insert(database, "job_runs", {
      id,
      league_id: IDS.league,
      season_id: IDS.season,
      job_type: jobType,
      occurrence_key: occurrenceKey,
      scheduled_for_ms: scheduledForMs,
      status,
      attempt_count: succeeded ? 1 : 0,
      lease_owner: null,
      lease_expires_at_ms: null,
      started_at_ms: succeeded ? FAD_OPENED_AT_MS : null,
      completed_at_ms: succeeded ? FAD_OPENED_AT_MS : null,
      result_json: succeeded
        ? serializeCanonicalJsonV1({ outcome: "opened" })
        : null,
      last_error_code: null,
      created_at_ms: FAD_OPENED_AT_MS,
      updated_at_ms: FAD_OPENED_AT_MS,
      version: succeeded ? 2 : 1,
      lease_token: null,
      next_attempt_at_ms: null,
    });
  }
  insert(database, "league_activity", {
    id: IDS.cardsOpenedActivity,
    league_id: IDS.league,
    season_id: IDS.season,
    event_type: "free_agent_draft_started",
    actor_user_id: null,
    actor_authority: "system",
    team_id: null,
    player_id: null,
    related_type: "free_agent_draft",
    related_id: IDS.fad,
    display_summary: "Candidate Cards opened.",
    reason: null,
    metadata_json: serializeCanonicalJsonV1({
      fadId: IDS.fad,
      candidateDeadlineAtMs: CANDIDATE_DEADLINE_AT_MS,
      firstMatchupStartsAtMs: ROLLOVER_AT_MS,
      participatingTeamCount: 1,
    }),
    occurred_at_ms: FAD_OPENED_AT_MS,
  });
  insert(database, "outbox_events", {
    id: IDS.cardsOpenedOutbox,
    league_id: IDS.league,
    event_type: "fad_cards_opened",
    aggregate_type: "free_agent_draft",
    aggregate_id: IDS.fad,
    payload_json: serializeCanonicalJsonV1({
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      occurredAtMs: FAD_OPENED_AT_MS,
    }),
    status: "pending",
    attempt_count: 0,
    available_at_ms: FAD_OPENED_AT_MS,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: FAD_OPENED_AT_MS,
    updated_at_ms: FAD_OPENED_AT_MS,
    version: 1,
  });
  insert(database, "outbox_event_audiences", {
    id: IDS.cardsOpenedAudience,
    league_id: IDS.league,
    outbox_event_id: IDS.cardsOpenedOutbox,
    audience_kind: "league",
    team_id: null,
    user_id: null,
    created_at_ms: FAD_OPENED_AT_MS,
  });
  insert(database, "free_agent_draft_readiness_operations", {
    id: IDS.readiness,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_occurrence_key:
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: IDS.league,
        seasonId: IDS.season,
        triggerResourceId: IDS.season,
      }),
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: IDS.readinessJob,
    status: "succeeded",
    attempt_count: 1,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    blockers_json: "[]",
    matchup_schedule_version_before: null,
    matchup_schedule_version_after: null,
    schedule_recovery_id: null,
    created_fad_id: IDS.fad,
    reminder_job_run_id: IDS.reminderJob,
    deadline_job_run_id: IDS.deadlineJob,
    cards_opened_activity_id: IDS.cardsOpenedActivity,
    cards_opened_outbox_event_id: IDS.cardsOpenedOutbox,
    started_at_ms: FAD_OPENED_AT_MS,
    next_retry_at_ms: null,
    terminal_at_ms: FAD_OPENED_AT_MS,
    created_at_ms: FAD_OPENED_AT_MS,
    updated_at_ms: FAD_OPENED_AT_MS,
    version: 2,
  });
  insert(database, "free_agent_drafts", {
    id: IDS.fad,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    readiness_occurrence_key:
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: IDS.league,
        seasonId: IDS.season,
        triggerResourceId: IDS.season,
      }),
    first_matchup_week_id: IDS.week,
    current_competition_first_matchup_week_id: IDS.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "rapid",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Inaugural league has no Entry Draft.",
    opening_authority: "system",
    opened_at_ms: FAD_OPENED_AT_MS,
    help_opens_at_ms: ROLLOVER_AT_MS - 9 * DAY_MS,
    candidate_deadline_at_ms: CANDIDATE_DEADLINE_AT_MS,
    first_matchup_starts_at_ms: ROLLOVER_AT_MS,
    deadline_locked_at_ms: CANDIDATE_DEADLINE_AT_MS,
    allocation_completed_at_ms: CANDIDATE_DEADLINE_AT_MS,
    completed_at_ms: null,
    created_at_ms: FAD_OPENED_AT_MS,
    updated_at_ms: CANDIDATE_DEADLINE_AT_MS,
    version: 4,
  });
  for (let sequence = 1; sequence < 7; sequence += 1) {
    const rollsOverAtMs =
      ROLLOVER_AT_MS - (7 - sequence) * DAY_MS;
    insert(database, "job_runs", {
      id: uuid(1_000 + sequence),
      league_id: IDS.league,
      season_id: IDS.season,
      job_type: "fad_rollover",
      occurrence_key:
        `fad:${IDS.fad}:rollover:${sequence}:${rollsOverAtMs}`,
      scheduled_for_ms: rollsOverAtMs,
      status: "succeeded",
      attempt_count: 1,
      lease_owner: null,
      lease_expires_at_ms: null,
      started_at_ms: rollsOverAtMs,
      completed_at_ms: rollsOverAtMs,
      result_json: "{}",
      last_error_code: null,
      created_at_ms: 1,
      updated_at_ms: rollsOverAtMs,
      version: 2,
      lease_token: null,
      next_attempt_at_ms: null,
    });
  }
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    const rollsOverAtMs =
      ROLLOVER_AT_MS - (7 - sequence) * DAY_MS;
    const terminal = sequence < 7;
    insert(database, "free_agent_draft_rollovers", {
      id: IDS.rollovers[sequence - 1],
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      sequence,
      window_kind: "initial",
      predecessor_rollover_id:
        sequence === 1 ? null : IDS.rollovers[sequence - 2],
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: rollsOverAtMs - DAY_MS,
      creation_cutoff_at_ms: rollsOverAtMs - HOUR_MS,
      rolls_over_at_ms: rollsOverAtMs,
      status: terminal ? "completed" : "scheduled",
      processing_job_run_id: terminal ? uuid(1_000 + sequence) : null,
      processing_started_at_ms: terminal ? rollsOverAtMs : null,
      completed_at_ms: terminal ? rollsOverAtMs : null,
      last_error_code: null,
      created_at_ms: 1,
      updated_at_ms: terminal ? rollsOverAtMs : 1,
      version: terminal ? 3 : 1,
    });
  }
}

function createFixture(t, { beforeCommit } = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fad-rollover-writer-")
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
    applicationBuildId: "fad-rollover-writer-foundation",
    now: () => 47,
  });
  withoutTriggers(connection.database, () => {
    connection.database.transaction(() => seed(connection.database))();
  });
  let nextId = 10_000;
  const writer = createSqliteFreeAgentDraftRolloverWriter({
    database: connection.database,
    createId() {
      const id = uuid(nextId);
      nextId += 1;
      return id;
    },
    beforeCommit,
  });
  return { database: connection.database, writer };
}

function occurrenceKey() {
  return `fad:${IDS.fad}:rollover:7:${ROLLOVER_AT_MS}`;
}

function claim(database, overrides = {}) {
  const values = {
    runId: IDS.job,
    leaseOwner: LEASE_OWNER,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    startedAtMs: CLAIMED_AT_MS,
    ...overrides,
  };
  database.prepare(`
    UPDATE job_runs
    SET status = 'running', attempt_count = 1,
        lease_owner = @leaseOwner, lease_token = @leaseToken,
        lease_expires_at_ms = @leaseExpiresAtMs,
        started_at_ms = @startedAtMs, updated_at_ms = @startedAtMs,
        version = version + 1
    WHERE id = @runId AND status = 'pending'
  `).run(values);
}

function command() {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    rolloverId: IDS.rollover,
    sequence: 7,
    rolloverAtMs: ROLLOVER_AT_MS,
    occurrenceKey: occurrenceKey(),
    finalizedAtMs: FINALIZED_AT_MS,
    expectedRolloverVersion: 1,
    jobExecution: {
      runId: IDS.job,
      expectedVersion: 2,
      leaseOwner: LEASE_OWNER,
      leaseToken: LEASE_TOKEN,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: CLAIMED_AT_MS,
      attemptCount: 1,
    },
  };
}

function failureCommand(overrides = {}) {
  const execute = command();
  const {
    finalizedAtMs: _finalizedAtMs,
    ...shared
  } = execute;
  return {
    ...shared,
    failedAtMs: FINALIZED_AT_MS,
    reasonCode: "boundary_recovery_required",
    ...overrides,
  };
}

function resumeAfterT142(database) {
  insert(database, "idempotency_requests", {
    id: IDS.retryRequest,
    league_id: IDS.league,
    actor_user_id: IDS.actorUser,
    operation: "free_agent_draft.recovery.action",
    client_key: "rollover-finalization-retry",
    request_hash: "a".repeat(64),
    status: "completed",
    result_type:
      "free_agent_draft_recovery_action_command_result",
    result_id: IDS.retryReceipt,
    created_at_ms: RETRY_ACCEPTED_AT_MS,
    completed_at_ms: RETRY_ACCEPTED_AT_MS,
    expires_at_ms: RETRY_ACCEPTED_AT_MS + DAY_MS,
  });
  withoutTriggers(database, () => {
    insert(
      database,
      "free_agent_draft_recovery_action_command_results",
      {
      id: IDS.retryReceipt,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      recovery_id: uuid(10_001),
      idempotency_request_id: IDS.retryRequest,
      action: "finalize_rollover",
      resource_kind: "rollover",
      resource_id: IDS.rollover,
      operation_id: IDS.job,
      job_run_id: IDS.job,
      occurrence_key: occurrenceKey(),
      actor_user_id: IDS.actorUser,
      actor_membership_id: IDS.actorMembership,
      actor_authority: "commissioner",
      commissioner_reason: "Retry rollover finalization.",
      request_json: "{}",
      request_sha256: "a".repeat(64),
      accepted_status: "pending",
      accepted_at_ms: RETRY_ACCEPTED_AT_MS,
      response_http_status: 202,
      response_json: "{}",
      response_sha256: "b".repeat(64),
      version: 1,
      }
    );
    database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'running',
          commissioner_reason = 'Retry rollover finalization.',
          updated_at_ms = @acceptedAtMs,
          version = version + 1
      WHERE id = @recoveryId
    `).run({
      recoveryId: uuid(10_001),
      acceptedAtMs: RETRY_ACCEPTED_AT_MS,
    });
    database.prepare(`
      UPDATE job_runs
      SET status = 'running', attempt_count = 2,
          lease_owner = @leaseOwner, lease_token = @leaseToken,
          lease_expires_at_ms = @leaseExpiresAtMs,
          started_at_ms = @startedAtMs, completed_at_ms = NULL,
          result_json = NULL, last_error_code = NULL,
          next_attempt_at_ms = NULL, updated_at_ms = @startedAtMs,
          version = 5
      WHERE id = @jobRunId
    `).run({
      jobRunId: IDS.job,
      leaseOwner: LEASE_OWNER,
      leaseToken: LEASE_TOKEN,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: RETRY_STARTED_AT_MS,
    });
  });
}

function retryExecuteCommand() {
  return {
    ...command(),
    finalizedAtMs: RETRY_TERMINAL_AT_MS,
    expectedRolloverVersion: 3,
    jobExecution: {
      runId: IDS.job,
      expectedVersion: 5,
      leaseOwner: LEASE_OWNER,
      leaseToken: LEASE_TOKEN,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: RETRY_STARTED_AT_MS,
      attemptCount: 2,
    },
  };
}

function retryFailureCommand() {
  const execute = retryExecuteCommand();
  const {
    finalizedAtMs: _finalizedAtMs,
    ...shared
  } = execute;
  return {
    ...shared,
    failedAtMs: RETRY_TERMINAL_AT_MS,
    reasonCode: "boundary_recovery_required",
  };
}

function seedOpenAuction(database) {
  withoutTriggers(database, () => {
    insert(database, "players", {
      id: IDS.player,
      first_name: "Open",
      last_name: "Boundary",
      full_name: "Open Boundary",
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "auctions", {
      id: IDS.auction,
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.player,
      status: "open",
      opened_at_ms: ROLLOVER_AT_MS - HOUR_MS,
      resolves_at_ms: ROLLOVER_AT_MS + HOUR_MS,
      opened_by_user_id: IDS.actorUser,
      created_at_ms: ROLLOVER_AT_MS - HOUR_MS,
      updated_at_ms: ROLLOVER_AT_MS - HOUR_MS,
      version: 1,
    });
    insert(database, "auction_contexts", {
      id: IDS.auction,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.auction,
      source_kind: "fad_open_rapid",
      fad_id: IDS.fad,
      fad_rollover_id: IDS.rollover,
      fad_allocation_id: null,
      fad_origin: "manager_nomination",
      created_at_ms: ROLLOVER_AT_MS - HOUR_MS,
    });
  });
}

function seedBoundaryRecovery(database) {
  withoutTriggers(database, () => {
    insert(database, "players", {
      id: IDS.player,
      first_name: "Recovery",
      last_name: "Boundary",
      full_name: "Recovery Boundary",
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "free_agent_draft_recoveries", {
      id: uuid(30_003),
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      player_id: IDS.player,
      allocation_id: null,
      rollover_id: IDS.rollover,
      auction_id: null,
      job_run_id: IDS.job,
      kind: "restricted_activation",
      status: "correction_required",
      earliest_activation_at_ms: null,
      target_resolution_at_ms: null,
      last_error_code: "RESTRICTED_ACTIVATION_FAILED",
      commissioner_reason: null,
      created_by_operation_id: IDS.job,
      resolved_by_user_id: null,
      resolved_by_membership_id: null,
      resolved_authority: null,
      created_at_ms: FINALIZED_AT_MS - 1,
      updated_at_ms: FINALIZED_AT_MS - 1,
      resolved_at_ms: null,
      version: 1,
      nomination_queue_id: null,
    });
  });
}

function resolveBoundaryRecovery(database) {
  withoutTriggers(database, () => {
    database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved', last_error_code = NULL,
          resolved_authority = 'system',
          resolved_at_ms = @resolvedAtMs,
          updated_at_ms = @resolvedAtMs,
          version = version + 1
      WHERE id = @recoveryId
    `).run({
      recoveryId: uuid(30_003),
      resolvedAtMs: RETRY_TERMINAL_AT_MS - 1,
    });
  });
}

function seedExistingSuccessor(
  database,
  {
    includeJob = true,
    sourceRecoveryId = uuid(40_003),
  } = {}
) {
  const successorId = uuid(40_001);
  const successorJobId = uuid(40_002);
  const successorAtMs = ROLLOVER_AT_MS + DAY_MS;
  withoutTriggers(database, () => {
    insert(database, "free_agent_draft_rollovers", {
      id: successorId,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      sequence: 8,
      window_kind: "extension",
      predecessor_rollover_id: IDS.rollover,
      extension_reason: "recovery",
      extension_source_id: sourceRecoveryId,
      opens_at_ms: ROLLOVER_AT_MS,
      creation_cutoff_at_ms: successorAtMs - HOUR_MS,
      rolls_over_at_ms: successorAtMs,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: ROLLOVER_AT_MS - 1,
      updated_at_ms: ROLLOVER_AT_MS - 1,
      version: 1,
    });
    if (includeJob) {
      insert(database, "job_runs", {
        id: successorJobId,
        league_id: IDS.league,
        season_id: IDS.season,
        job_type: "fad_rollover",
        occurrence_key:
          `fad:${IDS.fad}:rollover:8:${successorAtMs}`,
        scheduled_for_ms: successorAtMs,
        status: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at_ms: null,
        started_at_ms: null,
        completed_at_ms: null,
        result_json: null,
        last_error_code: null,
        created_at_ms: ROLLOVER_AT_MS - 1,
        updated_at_ms: ROLLOVER_AT_MS - 1,
        version: 1,
        lease_token: null,
        next_attempt_at_ms: null,
      });
    }
  });
  return { successorId, successorJobId };
}

describe("SQLite FAD rollover writer", () => {
  test("exports the frozen surface and ensures only missing canonical jobs", (t) => {
    const { database, writer } = createFixture(t);
    assert.deepEqual(FREE_AGENT_DRAFT_ROLLOVER_WRITER_METHODS, [
      "ensurePendingJobs",
      "findFinalization",
      "executeClaimed",
      "recordFailure",
    ]);
    assert.equal(FREE_AGENT_DRAFT_ROLLOVER_JOB_TYPE, "fad_rollover");
    assert.equal(
      FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
      "FAD_ROLLOVER_FINALIZATION_FAILED"
    );

    const created = writer.ensurePendingJobs({
      ensuredAtMs: ROLLOVER_AT_MS - 1,
      limit: 10,
    });
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      rolloverId: IDS.rollover,
      sequence: 7,
      rolloverAtMs: ROLLOVER_AT_MS,
      occurrenceKey: occurrenceKey(),
      jobRunId: uuid(10_000),
      createdAtMs: ROLLOVER_AT_MS - 1,
    });
    assert.deepEqual(
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS,
        limit: 10,
      }),
      []
    );
    const row = database.prepare(`
      SELECT * FROM job_runs WHERE id = ?
    `).get(uuid(10_000));
    assert.equal(row.job_type, "fad_rollover");
    assert.equal(row.occurrence_key, occurrenceKey());
    assert.equal(row.status, "pending");
    assert.equal(row.version, 1);
  });

  test("completes an empty boundary in causal order and replays the immutable result", (t) => {
    const { database, writer } = createFixture(t);
    writer.ensurePendingJobs({
      ensuredAtMs: ROLLOVER_AT_MS - 1,
      limit: 10,
    });
    claim(database);
    const completed = writer.executeClaimed(command());
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.rolloverVersion, 3);
    assert.equal(completed.jobRunVersion, 3);
    assert.equal(completed.replayed, false);
    assert.deepEqual(
      writer.executeClaimed(command()),
      { ...completed, replayed: true }
    );
    assert.deepEqual(
      writer.findFinalization({
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        rolloverId: IDS.rollover,
        sequence: 7,
        rolloverAtMs: ROLLOVER_AT_MS,
        occurrenceKey: occurrenceKey(),
      }),
      { ...completed, replayed: true }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, version FROM free_agent_draft_rollovers
        WHERE id = ?
      `).get(IDS.rollover),
      { status: "completed", version: 3 }
    );
  });

  test("records first terminal failure with one recovery extension and pending successor job", (t) => {
    const { database, writer } = createFixture(t);
    writer.ensurePendingJobs({
      ensuredAtMs: ROLLOVER_AT_MS - 1,
      limit: 10,
    });
    seedBoundaryRecovery(database);
    claim(database);
    const recorded = writer.recordFailure(failureCommand());
    assert.deepEqual(recorded, {
      outcome: "failure_recorded",
      replayed: false,
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      rolloverId: IDS.rollover,
      sequence: 7,
      rolloverAtMs: ROLLOVER_AT_MS,
      failedAtMs: FINALIZED_AT_MS,
      rolloverVersion: 3,
      jobRunId: IDS.job,
      jobRunVersion: 3,
      recoveryId: uuid(10_001),
      extensionRolloverId: uuid(10_002),
      extensionJobRunId: uuid(10_003),
      failureCode: "FAD_ROLLOVER_FINALIZATION_FAILED",
    });
    assert.deepEqual(
      writer.recordFailure(failureCommand()),
      { ...recorded, replayed: true }
    );
    assert.deepEqual(
      writer.findFinalization({
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        rolloverId: IDS.rollover,
        sequence: 7,
        rolloverAtMs: ROLLOVER_AT_MS,
        occurrenceKey: occurrenceKey(),
      }),
      { ...recorded, replayed: true }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, completed_at_ms, last_error_code, version
        FROM free_agent_draft_rollovers WHERE id = ?
      `).get(IDS.rollover),
      {
        status: "recovery_required",
        completed_at_ms: FINALIZED_AT_MS,
        last_error_code: "FAD_ROLLOVER_FINALIZATION_FAILED",
        version: 3,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT sequence, window_kind, predecessor_rollover_id,
               extension_reason, extension_source_id, opens_at_ms,
               creation_cutoff_at_ms, rolls_over_at_ms, status, version
        FROM free_agent_draft_rollovers WHERE id = ?
      `).get(uuid(10_002)),
      {
        sequence: 8,
        window_kind: "extension",
        predecessor_rollover_id: IDS.rollover,
        extension_reason: "recovery",
        extension_source_id: uuid(10_001),
        opens_at_ms: ROLLOVER_AT_MS,
        creation_cutoff_at_ms:
          ROLLOVER_AT_MS + DAY_MS - HOUR_MS,
        rolls_over_at_ms: ROLLOVER_AT_MS + DAY_MS,
        status: "scheduled",
        version: 1,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT job_type, occurrence_key, scheduled_for_ms, status,
               attempt_count, result_json, last_error_code, version
        FROM job_runs WHERE id = ?
      `).get(uuid(10_003)),
      {
        job_type: "fad_rollover",
        occurrence_key:
          `fad:${IDS.fad}:rollover:8:${ROLLOVER_AT_MS + DAY_MS}`,
        scheduled_for_ms: ROLLOVER_AT_MS + DAY_MS,
        status: "pending",
        attempt_count: 0,
        result_json: null,
        last_error_code: null,
        version: 1,
      }
    );
  });

  test("completes an exact T142 retry and resolves the same recovery", (t) => {
    const { database, writer } = createFixture(t);
    writer.ensurePendingJobs({
      ensuredAtMs: ROLLOVER_AT_MS - 1,
      limit: 10,
    });
    seedBoundaryRecovery(database);
    claim(database);
    writer.recordFailure(failureCommand());
    resumeAfterT142(database);
    resolveBoundaryRecovery(database);

    const completed = writer.executeClaimed(retryExecuteCommand());
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.replayed, false);
    assert.equal(completed.rolloverVersion, 4);
    assert.equal(completed.jobRunVersion, 6);
    assert.equal(completed.sourceRecoveryId, uuid(10_001));
    assert.deepEqual(
      writer.executeClaimed(retryExecuteCommand()),
      { ...completed, replayed: true }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, completed_at_ms, last_error_code, version
        FROM free_agent_draft_rollovers WHERE id = ?
      `).get(IDS.rollover),
      {
        status: "completed",
        completed_at_ms: RETRY_TERMINAL_AT_MS,
        last_error_code: null,
        version: 4,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, resolved_authority, resolved_at_ms, version
        FROM free_agent_draft_recoveries WHERE id = ?
      `).get(uuid(10_001)),
      {
        status: "resolved",
        resolved_authority: "system",
        resolved_at_ms: RETRY_TERMINAL_AT_MS,
        version: 3,
      }
    );
  });

  test("records a repeated T142 terminal failure without duplicating recovery or extension", (t) => {
    const { database, writer } = createFixture(t);
    writer.ensurePendingJobs({
      ensuredAtMs: ROLLOVER_AT_MS - 1,
      limit: 10,
    });
    seedBoundaryRecovery(database);
    claim(database);
    writer.recordFailure(failureCommand());
    resumeAfterT142(database);

    const recorded = writer.recordFailure(retryFailureCommand());
    assert.equal(recorded.outcome, "failure_recorded");
    assert.equal(recorded.replayed, false);
    assert.equal(recorded.rolloverVersion, 4);
    assert.equal(recorded.jobRunVersion, 6);
    assert.equal(recorded.recoveryId, uuid(10_001));
    assert.equal(recorded.extensionRolloverId, null);
    assert.equal(recorded.extensionJobRunId, null);
    assert.deepEqual(
      writer.recordFailure(retryFailureCommand()),
      { ...recorded, replayed: true }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_recoveries
        WHERE rollover_id = ? AND kind = 'rollover_finalize'
      `).get(IDS.rollover).count,
      1
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_rollovers
        WHERE predecessor_rollover_id = ?
      `).get(IDS.rollover).count,
      1
    );
  });

  test("returns awaiting and recovery-required decisions without mutating the claim", (t) => {
    for (const [label, seedBlocker, expectedOutcome] of [
      ["awaiting", seedOpenAuction, "awaiting_data"],
      ["recovery", seedBoundaryRecovery, "recovery_required"],
    ]) {
      const { database, writer } = createFixture(t);
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS - 1,
        limit: 10,
      });
      claim(database);
      seedBlocker(database);
      const before = {
        rollover: database.prepare(`
          SELECT status, version FROM free_agent_draft_rollovers
          WHERE id = ?
        `).get(IDS.rollover),
        job: database.prepare(`
          SELECT status, version FROM job_runs WHERE id = ?
        `).get(IDS.job),
      };
      const decision = writer.executeClaimed(command());
      assert.equal(decision.outcome, expectedOutcome, label);
      assert.deepEqual({
        rollover: database.prepare(`
          SELECT status, version FROM free_agent_draft_rollovers
          WHERE id = ?
        `).get(IDS.rollover),
        job: database.prepare(`
          SELECT status, version FROM job_runs WHERE id = ?
        `).get(IDS.job),
      }, before, label);
    }
  });

  test("reuses an exact existing successor and fails closed when its job is missing", (t) => {
    {
      const { database, writer } = createFixture(t);
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS - 1,
        limit: 10,
      });
      seedBoundaryRecovery(database);
      const existing = seedExistingSuccessor(database, {
        sourceRecoveryId: uuid(30_003),
      });
      claim(database);
      const recorded = writer.recordFailure(failureCommand());
      assert.equal(recorded.extensionRolloverId, null);
      assert.equal(recorded.extensionJobRunId, null);
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count FROM free_agent_draft_rollovers
          WHERE predecessor_rollover_id = ?
        `).get(IDS.rollover).count,
        1
      );
      assert.ok(
        database.prepare(`SELECT id FROM job_runs WHERE id = ?`)
          .get(existing.successorJobId)
      );
    }
    {
      const { database, writer } = createFixture(t);
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS - 1,
        limit: 10,
      });
      seedBoundaryRecovery(database);
      seedExistingSuccessor(database, {
        includeJob: false,
        sourceRecoveryId: uuid(30_003),
      });
      claim(database);
      assert.throws(
        () => writer.recordFailure(failureCommand()),
        (error) =>
          error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
      );
      assert.deepEqual(
        database.prepare(`
          SELECT status, version FROM free_agent_draft_rollovers
          WHERE id = ?
        `).get(IDS.rollover),
        { status: "scheduled", version: 1 }
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count FROM free_agent_draft_recoveries
          WHERE rollover_id = ? AND kind = 'rollover_finalize'
        `).get(IDS.rollover).count,
        0
      );
    }
  });

  test("records a scheduled first failure after exact lease reclaim with the fresh two-version delta", (t) => {
    const { database, writer } = createFixture(t);
    writer.ensurePendingJobs({
      ensuredAtMs: ROLLOVER_AT_MS - 1,
      limit: 10,
    });
    seedBoundaryRecovery(database);
    const repository = createSqliteFreeAgentDraftJobRepository({
      database,
    });
    const shared = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      runId: IDS.job,
      jobType: "fad_rollover",
      occurrenceKey: occurrenceKey(),
      scheduledForMs: ROLLOVER_AT_MS,
    };
    const due = repository.listDue({
      nowMs: CLAIMED_AT_MS,
      limit: 100,
    });
    assert.equal(
      due.find(({ runId }) => runId === IDS.job)?.binding.rolloverId,
      IDS.rollover
    );
    const first = repository.claim({
      ...shared,
      expectedVersion: 1,
      leaseOwner: "first-rollover-worker",
      leaseToken: "first-rollover-token",
      nowMs: CLAIMED_AT_MS,
      leaseExpiresAtMs: ROLLOVER_AT_MS + 150,
    });
    assert.equal(first.acquired, true);
    const reclaimed = repository.claim({
      ...shared,
      expectedVersion: 2,
      leaseOwner: LEASE_OWNER,
      leaseToken: LEASE_TOKEN,
      nowMs: ROLLOVER_AT_MS + 150,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    });
    assert.equal(reclaimed.acquired, true);
    assert.equal(reclaimed.occurrence.attemptCount, 2);
    assert.equal(reclaimed.occurrence.version, 3);
    assert.equal(
      database.prepare(`
        SELECT status, attempt_count, started_at_ms, version
        FROM job_runs WHERE id = ?
      `).get(IDS.job).started_at_ms,
      ROLLOVER_AT_MS + 150
    );

    const reclaimedFailure = failureCommand({
      jobExecution: {
        runId: IDS.job,
        expectedVersion: 3,
        leaseOwner: LEASE_OWNER,
        leaseToken: LEASE_TOKEN,
        leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
        startedAtMs: ROLLOVER_AT_MS + 150,
        attemptCount: 2,
      },
    });
    const recorded = writer.recordFailure(reclaimedFailure);
    assert.equal(recorded.rolloverVersion, 3);
    assert.equal(recorded.jobRunVersion, 4);
    assert.deepEqual(
      writer.recordFailure(reclaimedFailure),
      { ...recorded, replayed: true }
    );
  });

  test("isolates an exact rollover from same-millisecond jobs and rejects the lease-expiry boundary", (t) => {
    {
      const { database, writer } = createFixture(t);
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS - 1,
        limit: 10,
      });
      insert(database, "job_runs", {
        id: uuid(50_001),
        league_id: IDS.league,
        season_id: IDS.season,
        job_type: "fad_rollover",
        occurrence_key:
          `fad:${uuid(50_002)}:rollover:7:${ROLLOVER_AT_MS}`,
        scheduled_for_ms: ROLLOVER_AT_MS,
        status: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at_ms: null,
        started_at_ms: null,
        completed_at_ms: null,
        result_json: null,
        last_error_code: null,
        created_at_ms: ROLLOVER_AT_MS - 1,
        updated_at_ms: ROLLOVER_AT_MS - 1,
        version: 1,
        lease_token: null,
        next_attempt_at_ms: null,
      });
      claim(database);
      assert.equal(writer.executeClaimed(command()).outcome, "completed");
      assert.equal(
        database.prepare(`SELECT status FROM job_runs WHERE id = ?`)
          .get(uuid(50_001)).status,
        "pending"
      );
    }
    {
      const { database, writer } = createFixture(t);
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS - 1,
        limit: 10,
      });
      claim(database);
      assert.throws(
        () => writer.executeClaimed({
          ...command(),
          finalizedAtMs: LEASE_EXPIRES_AT_MS,
        }),
        (error) =>
          error.code === "REPOSITORY_ARGUMENT_INVALID"
      );
      assert.deepEqual(
        database.prepare(`
          SELECT status, version FROM free_agent_draft_rollovers
          WHERE id = ?
        `).get(IDS.rollover),
        { status: "scheduled", version: 1 }
      );
    }
  });

  test("fails closed when immutable completed or failure replay evidence is corrupted", (t) => {
    {
      const { database, writer } = createFixture(t);
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS - 1,
        limit: 10,
      });
      claim(database);
      writer.executeClaimed(command());
      withoutTriggers(database, () => {
        const row = database.prepare(`
          SELECT result_json FROM job_runs WHERE id = ?
        `).get(IDS.job);
        const stored = JSON.parse(row.result_json);
        stored.response.evidence.reasonCode = "boundary_work_pending";
        database.prepare(`
          UPDATE job_runs SET result_json = ? WHERE id = ?
        `).run(serializeCanonicalJsonV1(stored), IDS.job);
      });
      assert.throws(
        () => writer.findFinalization({
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          rolloverId: IDS.rollover,
          sequence: 7,
          rolloverAtMs: ROLLOVER_AT_MS,
          occurrenceKey: occurrenceKey(),
        }),
        (error) =>
          error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
      );
    }
    {
      const { database, writer } = createFixture(t);
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS - 1,
        limit: 10,
      });
      seedBoundaryRecovery(database);
      claim(database);
      writer.recordFailure(failureCommand());
      withoutTriggers(database, () => {
        database.prepare(`
          UPDATE free_agent_draft_recoveries
          SET version = 2
          WHERE id = ?
        `).run(uuid(10_001));
      });
      assert.throws(
        () => writer.findFinalization({
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          rolloverId: IDS.rollover,
          sequence: 7,
          rolloverAtMs: ROLLOVER_AT_MS,
          occurrenceKey: occurrenceKey(),
        }),
        (error) =>
          error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
      );
    }
  });

  test("rejects completed and awaiting-data failure recording without writes", (t) => {
    for (const [label, seedBlocker] of [
      ["completed", null],
      ["awaiting", seedOpenAuction],
    ]) {
      const { database, writer } = createFixture(t);
      writer.ensurePendingJobs({
        ensuredAtMs: ROLLOVER_AT_MS - 1,
        limit: 10,
      });
      claim(database);
      if (seedBlocker) seedBlocker(database);
      assert.throws(
        () => writer.recordFailure(failureCommand()),
        (error) =>
          error.code === "REPOSITORY_VERSION_CONFLICT" &&
          error.details?.reasonCode === "FAILURE_DECISION_CHANGED",
        label
      );
      assert.deepEqual(
        database.prepare(`
          SELECT status, version FROM free_agent_draft_rollovers
          WHERE id = ?
        `).get(IDS.rollover),
        { status: "scheduled", version: 1 },
        label
      );
      assert.deepEqual(
        database.prepare(`
          SELECT status, version FROM job_runs WHERE id = ?
        `).get(IDS.job),
        { status: "running", version: 2 },
        label
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count FROM free_agent_draft_recoveries
          WHERE rollover_id = ? AND kind = 'rollover_finalize'
        `).get(IDS.rollover).count,
        0,
        label
      );
    }
  });

  test("rolls back recovery, extension, job, and rollover writes when the commit hook fails", (t) => {
    const { database, writer } = createFixture(t, {
      beforeCommit({ operation }) {
        if (operation === "recordFailure") {
          throw new Error("stop-before-rollover-failure-commit");
        }
      },
    });
    writer.ensurePendingJobs({
      ensuredAtMs: ROLLOVER_AT_MS - 1,
      limit: 10,
    });
    seedBoundaryRecovery(database);
    claim(database);
    assert.throws(
      () => writer.recordFailure(failureCommand()),
      (error) =>
        error.cause?.message ===
          "stop-before-rollover-failure-commit"
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, version FROM free_agent_draft_rollovers
        WHERE id = ?
      `).get(IDS.rollover),
      { status: "scheduled", version: 1 }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, version FROM job_runs WHERE id = ?
      `).get(IDS.job),
      { status: "running", version: 2 }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM free_agent_draft_recoveries
        WHERE rollover_id = ? AND kind = 'rollover_finalize'
      `).get(IDS.rollover).count,
      0
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM free_agent_draft_rollovers
        WHERE predecessor_rollover_id = ?
      `).get(IDS.rollover).count,
      0
    );
  });

  test("rejects stale rollover and job fences without writes", (t) => {
    const { database, writer } = createFixture(t);
    writer.ensurePendingJobs({
      ensuredAtMs: ROLLOVER_AT_MS - 1,
      limit: 10,
    });
    claim(database);
    for (const stale of [
      { expectedRolloverVersion: 2 },
      {
        jobExecution: {
          ...command().jobExecution,
          expectedVersion: 3,
        },
      },
    ]) {
      assert.throws(
        () => writer.executeClaimed({ ...command(), ...stale }),
        (error) =>
          error.code === "REPOSITORY_VERSION_CONFLICT"
      );
    }
    assert.deepEqual(
      database.prepare(`
        SELECT status, version FROM free_agent_draft_rollovers
        WHERE id = ?
      `).get(IDS.rollover),
      { status: "scheduled", version: 1 }
    );
  });
});
