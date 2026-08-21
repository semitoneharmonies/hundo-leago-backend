"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  migrateDatabase,
} = require(
  "../../src/infrastructure/database/migrate"
);
const {
  buildFreeAgentDraftAllocationOccurrenceKey,
  buildFreeAgentDraftCompletionOccurrenceKey,
  buildFreeAgentDraftDeadlineOccurrenceKey,
  buildFreeAgentDraftFallbackActivationOccurrenceKey,
  buildFreeAgentDraftNominationOpenOccurrenceKey,
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  hashFreeAgentDraftRecoveryActionRequest,
  serializeFreeAgentDraftRecoveryActionRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftRecoveryPolicy"
);
const {
  buildAuctionResolutionOccurrenceKey,
} = require(
  "../../src/domain/auctions/auctionResolutionPolicy"
);
const {
  FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES,
  createSqliteFreeAgentDraftRecoveryActionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRecoveryActionRepository"
);
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);

const DAY_MS = 86_400_000;
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const DEADLINE_AT_MS = WEEK_ONE_AT_MS - 7 * DAY_MS;
const OPENED_AT_MS = DEADLINE_AT_MS - 30 * DAY_MS;
const ROLLOVER_AT_MS = DEADLINE_AT_MS + DAY_MS;
const ACCEPTED_AT_MS = DEADLINE_AT_MS + 50_000;
const AUCTION_OPENED_AT_MS = DEADLINE_AT_MS + 10_000;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function ids(base) {
  return Object.freeze({
    commissionerUser: uuid(base + 1),
    commissionerMembership: uuid(base + 2),
    administratorUser: uuid(base + 3),
    administratorMembership: uuid(base + 4),
    administratorRole: uuid(base + 5),
    inactiveAdministratorUser: uuid(base + 6),
    inactiveAdministratorMembership: uuid(base + 7),
    inactiveAdministratorRole: uuid(base + 8),
    league: uuid(base + 10),
    season: uuid(base + 11),
    week: uuid(base + 12),
    readiness: uuid(base + 13),
    fad: uuid(base + 14),
    team: uuid(base + 15),
    allocationPlayer: uuid(base + 20),
    restrictedPlayer: uuid(base + 21),
    fallbackPlayer: uuid(base + 22),
    queuePlayer: uuid(base + 23),
    auctionPlayer: uuid(base + 24),
    allocation: uuid(base + 30),
    restrictedAllocation: uuid(base + 31),
    fallbackAllocation: uuid(base + 32),
    rollover: uuid(base + 40),
    queue: uuid(base + 41),
    auction: uuid(base + 42),
  });
}

function actionMatrix(fixtureIds) {
  return Object.freeze([
    Object.freeze({
      action: "retry_deadline",
      resourceId: null,
      recoveryKind: "deadline_retry",
      jobType: "fad_deadline",
      occurrenceKey:
        buildFreeAgentDraftDeadlineOccurrenceKey({
          fadId: fixtureIds.fad,
          deadlineAtMs: DEADLINE_AT_MS,
        }),
      scheduledForMs: DEADLINE_AT_MS,
    }),
    Object.freeze({
      action: "retry_allocation",
      resourceId: fixtureIds.allocation,
      recoveryKind: "allocation_retry",
      jobType: "fad_allocation",
      playerId: fixtureIds.allocationPlayer,
      allocationId: fixtureIds.allocation,
      occurrenceKey:
        buildFreeAgentDraftAllocationOccurrenceKey({
          fadId: fixtureIds.fad,
          playerId: fixtureIds.allocationPlayer,
        }),
      scheduledForMs: DEADLINE_AT_MS,
    }),
    Object.freeze({
      action: "activate_restricted",
      resourceId: fixtureIds.restrictedAllocation,
      recoveryKind: "restricted_activation",
      jobType: "fad_restricted_activation",
      playerId: fixtureIds.restrictedPlayer,
      allocationId: fixtureIds.restrictedAllocation,
      rolloverId: fixtureIds.rollover,
      earliestActivationAtMs: ROLLOVER_AT_MS,
      occurrenceKey:
        buildFreeAgentDraftRestrictedActivationOccurrenceKey({
          fadId: fixtureIds.fad,
          allocationId: fixtureIds.restrictedAllocation,
          activationAtMs: ROLLOVER_AT_MS,
        }),
      scheduledForMs: ROLLOVER_AT_MS,
    }),
    Object.freeze({
      action: "activate_queued_nomination",
      resourceId: fixtureIds.queue,
      recoveryKind: "queued_nomination_activation",
      jobType: "fad_queued_nomination_activation",
      playerId: fixtureIds.queuePlayer,
      rolloverId: fixtureIds.rollover,
      nominationQueueId: fixtureIds.queue,
      occurrenceKey:
        buildFreeAgentDraftNominationOpenOccurrenceKey({
          fadId: fixtureIds.fad,
          queueId: fixtureIds.queue,
          rolloverAtMs: ROLLOVER_AT_MS,
        }),
      scheduledForMs: ROLLOVER_AT_MS,
    }),
    Object.freeze({
      action: "activate_fallback",
      resourceId: fixtureIds.fallbackAllocation,
      recoveryKind: "fallback_activation",
      jobType: "fad_fallback_activation",
      playerId: fixtureIds.fallbackPlayer,
      allocationId: fixtureIds.fallbackAllocation,
      rolloverId: fixtureIds.rollover,
      earliestActivationAtMs: ROLLOVER_AT_MS,
      occurrenceKey:
        buildFreeAgentDraftFallbackActivationOccurrenceKey({
          fadId: fixtureIds.fad,
          allocationId: fixtureIds.fallbackAllocation,
          activationAtMs: ROLLOVER_AT_MS,
        }),
      scheduledForMs: ROLLOVER_AT_MS,
    }),
    Object.freeze({
      action: "retry_auction_resolution",
      resourceId: fixtureIds.auction,
      recoveryKind: "auction_resolution",
      jobType: "auction.resolve.target",
      playerId: fixtureIds.auctionPlayer,
      rolloverId: fixtureIds.rollover,
      auctionId: fixtureIds.auction,
      targetResolutionAtMs: ROLLOVER_AT_MS,
      occurrenceKey: buildAuctionResolutionOccurrenceKey({
        auctionId: fixtureIds.auction,
        dueAtMs: ROLLOVER_AT_MS,
      }),
      scheduledForMs: ROLLOVER_AT_MS,
    }),
    Object.freeze({
      action: "finalize_rollover",
      resourceId: fixtureIds.rollover,
      recoveryKind: "rollover_finalize",
      jobType: "fad_rollover",
      rolloverId: fixtureIds.rollover,
      occurrenceKey:
        buildFreeAgentDraftRolloverOccurrenceKey({
          fadId: fixtureIds.fad,
          sequence: 1,
          rolloverAtMs: ROLLOVER_AT_MS,
        }),
      scheduledForMs: ROLLOVER_AT_MS,
    }),
    Object.freeze({
      action: "complete_fad",
      resourceId: null,
      recoveryKind: "completion",
      jobType: "fad_completion",
      occurrenceKey:
        buildFreeAgentDraftCompletionOccurrenceKey({
          fadId: fixtureIds.fad,
        }),
      scheduledForMs: ROLLOVER_AT_MS,
    }),
  ]);
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database.prepare(`
    INSERT INTO ${tableName} (
      ${columns.join(", ")}
    ) VALUES (
      ${columns
        .map((column) => `@${column}`)
        .join(", ")}
    )
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
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const { sql } of triggers) {
    database.exec(sql);
  }
}

function mutateWithoutTriggers(database, operation) {
  const triggers = captureAndDropTriggers(database);
  try {
    operation();
  } finally {
    restoreTriggers(database, triggers);
  }
}

function seedUser(database, {
  id,
  label,
  base,
}) {
  insert(database, "users", {
    id,
    email_normalized: `${label}-${base}@example.test`,
    email_display: `${label}-${base}@example.test`,
    display_name: `${label} ${base}`,
    display_name_normalized: `${label} ${base}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
}

function seedMembership(database, fixtureIds, {
  id,
  userId,
  permission,
  status = "active",
}) {
  insert(database, "league_memberships", {
    id,
    league_id: fixtureIds.league,
    user_id: userId,
    permission_category: permission,
    status,
    joined_at_ms: 1,
    ended_at_ms: status === "active" ? null : 2,
    created_at_ms: 1,
    updated_at_ms: status === "active" ? 1 : 2,
    version: status === "active" ? 1 : 2,
  });
}

function seedCore(database, base, fixtureIds) {
  seedUser(database, {
    id: fixtureIds.commissionerUser,
    label: "commissioner",
    base,
  });
  seedUser(database, {
    id: fixtureIds.administratorUser,
    label: "administrator",
    base,
  });
  seedUser(database, {
    id: fixtureIds.inactiveAdministratorUser,
    label: "inactive-administrator",
    base,
  });
  insert(database, "leagues", {
    id: fixtureIds.league,
    name: `Recovery League ${base}`,
    name_normalized: `recovery league ${base}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  seedMembership(database, fixtureIds, {
    id: fixtureIds.commissionerMembership,
    userId: fixtureIds.commissionerUser,
    permission: "commissioner",
  });
  seedMembership(database, fixtureIds, {
    id: fixtureIds.administratorMembership,
    userId: fixtureIds.administratorUser,
    permission: "manager",
  });
  seedMembership(database, fixtureIds, {
    id: fixtureIds.inactiveAdministratorMembership,
    userId: fixtureIds.inactiveAdministratorUser,
    permission: "manager",
    status: "ended",
  });
  insert(database, "platform_roles", {
    id: fixtureIds.administratorRole,
    user_id: fixtureIds.administratorUser,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: fixtureIds.commissionerUser,
    granted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "platform_roles", {
    id: fixtureIds.inactiveAdministratorRole,
    user_id: fixtureIds.inactiveAdministratorUser,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: fixtureIds.commissionerUser,
    granted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "seasons", {
    id: fixtureIds.season,
    league_id: fixtureIds.league,
    label: `2026-27 ${base}`,
    nhl_season_key: `2026${String(base).slice(-4)}`,
    status: "active",
    regular_season_starts_at_ms: WEEK_ONE_AT_MS,
    regular_season_ends_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 17 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?,
        current_season_id = ?
    WHERE id = ?
  `).run(
    fixtureIds.commissionerMembership,
    fixtureIds.season,
    fixtureIds.league
  );
  insert(database, "teams", {
    id: fixtureIds.team,
    league_id: fixtureIds.league,
    name: `Recovery Team ${base}`,
    name_normalized: `recovery team ${base}`,
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
    id: fixtureIds.week,
    league_id: fixtureIds.league,
    season_id: fixtureIds.season,
    week_key: `2026-W${String(base).slice(-2)}`,
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
  for (const [id, label] of [
    [fixtureIds.allocationPlayer, "Allocation"],
    [fixtureIds.restrictedPlayer, "Restricted"],
    [fixtureIds.fallbackPlayer, "Fallback"],
    [fixtureIds.queuePlayer, "Queue"],
    [fixtureIds.auctionPlayer, "Auction"],
  ]) {
    insert(database, "players", {
      id,
      first_name: label,
      last_name: `Recovery ${base}`,
      full_name: `${label} Recovery ${base}`,
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }
  insert(
    database,
    "free_agent_draft_readiness_operations",
    {
      id: fixtureIds.readiness,
      league_id: fixtureIds.league,
      season_id: fixtureIds.season,
      readiness_occurrence_key:
        `fad-readiness:${fixtureIds.league}:${fixtureIds.season}`,
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
    }
  );
  insert(database, "free_agent_drafts", {
    id: fixtureIds.fad,
    league_id: fixtureIds.league,
    season_id: fixtureIds.season,
    readiness_operation_id: fixtureIds.readiness,
    readiness_occurrence_key:
      `fad-readiness:${fixtureIds.league}:${fixtureIds.season}`,
    first_matchup_week_id: fixtureIds.week,
    current_competition_first_matchup_week_id:
      fixtureIds.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "rapid",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Focused recovery-action fixture.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: DEADLINE_AT_MS - 2 * DAY_MS,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: DEADLINE_AT_MS,
    allocation_completed_at_ms: DEADLINE_AT_MS + 1_000,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 4,
  });
  insert(database, "free_agent_draft_rollovers", {
    id: fixtureIds.rollover,
    league_id: fixtureIds.league,
    season_id: fixtureIds.season,
    fad_id: fixtureIds.fad,
    sequence: 1,
    window_kind: "initial",
    predecessor_rollover_id: null,
    extension_reason: null,
    extension_source_id: null,
    opens_at_ms: DEADLINE_AT_MS,
    creation_cutoff_at_ms: ROLLOVER_AT_MS - 3_600_000,
    rolls_over_at_ms: ROLLOVER_AT_MS,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  for (const [id, playerId] of [
    [fixtureIds.allocation, fixtureIds.allocationPlayer],
    [fixtureIds.restrictedAllocation, fixtureIds.restrictedPlayer],
    [fixtureIds.fallbackAllocation, fixtureIds.fallbackPlayer],
  ]) {
    insert(
      database,
      "free_agent_draft_player_allocations",
      {
        id,
        league_id: fixtureIds.league,
        season_id: fixtureIds.season,
        fad_id: fixtureIds.fad,
        player_id: playerId,
        status: "invalid",
        decision_code: "invalid_snapshot",
        winning_snapshot_entry_id: null,
        winning_team_id: null,
        contract_id: null,
        ownership_id: null,
        restricted_auction_id: null,
        fallback_open_auction_id: null,
        restricted_minimum_total_cents: null,
        restricted_minimum_term_years: null,
        restricted_minimum_aav_cents: null,
        accounted_at_ms: DEADLINE_AT_MS + 1_000,
        last_error_code: null,
        created_at_ms: DEADLINE_AT_MS,
        updated_at_ms: DEADLINE_AT_MS + 1_000,
        version: 3,
      }
    );
  }
  insert(database, "free_agent_draft_nomination_queue", {
    id: fixtureIds.queue,
    league_id: fixtureIds.league,
    season_id: fixtureIds.season,
    fad_id: fixtureIds.fad,
    team_id: fixtureIds.team,
    player_id: fixtureIds.queuePlayer,
    source_rollover_id: fixtureIds.rollover,
    target_opening_rollover_id: fixtureIds.rollover,
    resolution_rollover_id: null,
    opening_total_value_cents: 600,
    opening_term_years: 2,
    opening_aav_cents: 300,
    binding_illegality_confirmed: 1,
    binding_confirmed_at_ms: DEADLINE_AT_MS + 10_000,
    submitted_by_user_id: fixtureIds.commissionerUser,
    submitted_by_membership_id:
      fixtureIds.commissionerMembership,
    accepted_at_ms: DEADLINE_AT_MS + 10_000,
    candidate_card_version_observed: 1,
    team_version_observed: 1,
    status: "queued",
    opened_auction_id: null,
    opened_starter_bid_id: null,
    opened_at_ms: null,
    terminal_at_ms: null,
    validation_code: null,
    created_at_ms: DEADLINE_AT_MS + 10_000,
    updated_at_ms: DEADLINE_AT_MS + 10_000,
    version: 1,
  });
  insert(database, "auctions", {
    id: fixtureIds.auction,
    league_id: fixtureIds.league,
    season_id: fixtureIds.season,
    player_id: fixtureIds.auctionPlayer,
    status: "failed",
    opened_at_ms: AUCTION_OPENED_AT_MS,
    resolves_at_ms: ROLLOVER_AT_MS,
    opened_by_user_id: fixtureIds.commissionerUser,
    created_at_ms: AUCTION_OPENED_AT_MS,
    updated_at_ms: ROLLOVER_AT_MS + 1,
    version: 2,
  });
  insert(database, "auction_contexts", {
    id: fixtureIds.auction,
    league_id: fixtureIds.league,
    season_id: fixtureIds.season,
    auction_id: fixtureIds.auction,
    source_kind: "fad_open_rapid",
    fad_id: fixtureIds.fad,
    fad_rollover_id: fixtureIds.rollover,
    fad_allocation_id: null,
    fad_origin: "manager_nomination",
    created_at_ms: AUCTION_OPENED_AT_MS,
  });
}

function jobRecord(fixtureIds, action, index, {
  status = "pending",
} = {}) {
  const jobId = uuid(Number(fixtureIds.fad.slice(-12)) + 100 + index);
  const active = ["leased", "running"].includes(status);
  const terminal = ["succeeded", "failed"].includes(status);
  const staleLease = status === "failed";
  return {
    id: jobId,
    league_id: fixtureIds.league,
    season_id: fixtureIds.season,
    job_type: action.jobType,
    occurrence_key: action.occurrenceKey,
    scheduled_for_ms: action.scheduledForMs,
    status,
    attempt_count: status === "pending" ? 0 : 1,
    lease_owner:
      active || staleLease ? `worker-${index}` : null,
    lease_expires_at_ms:
      active || staleLease
        ? ACCEPTED_AT_MS + 10_000
        : null,
    started_at_ms:
      active || terminal ? ACCEPTED_AT_MS - 10_000 : null,
    completed_at_ms: terminal
      ? ACCEPTED_AT_MS - 1_000
      : null,
    result_json: terminal
      ? `{"status":"${status}"}`
      : null,
    last_error_code:
      status === "failed" ? "RECOVERY_FAILED" : null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms:
      terminal ? ACCEPTED_AT_MS - 1_000 : OPENED_AT_MS,
    version: status === "pending" ? 1 : 2,
    lease_token: active || staleLease
      ? uuid(Number(fixtureIds.fad.slice(-12)) + 500 + index)
      : null,
    next_attempt_at_ms:
      status === "pending"
        ? action.scheduledForMs
        : status === "failed"
          ? ACCEPTED_AT_MS - 1_000
          : null,
  };
}

function recoveryRecord(
  fixtureIds,
  action,
  job,
  index,
  { status = "pending" } = {}
) {
  const resolved = status === "resolved";
  return {
    id: uuid(Number(fixtureIds.fad.slice(-12)) + 200 + index),
    league_id: fixtureIds.league,
    season_id: fixtureIds.season,
    fad_id: fixtureIds.fad,
    player_id: action.playerId ?? null,
    allocation_id: action.allocationId ?? null,
    rollover_id: action.rolloverId ?? null,
    auction_id: action.auctionId ?? null,
    job_run_id: job.id,
    kind: action.recoveryKind,
    status,
    earliest_activation_at_ms:
      action.earliestActivationAtMs ?? null,
    target_resolution_at_ms:
      action.targetResolutionAtMs ?? null,
    last_error_code:
      status === "correction_required"
        ? "RECOVERY_FAILED"
        : null,
    commissioner_reason: null,
    created_by_operation_id: job.id,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: resolved ? "system" : null,
    created_at_ms: OPENED_AT_MS + index,
    updated_at_ms: resolved
      ? ACCEPTED_AT_MS - 1_000
      : OPENED_AT_MS + index,
    resolved_at_ms: resolved
      ? ACCEPTED_AT_MS - 1_000
      : null,
    version: resolved ? 2 : 1,
    nomination_queue_id:
      action.nominationQueueId ?? null,
  };
}

function createFixture(t, prefix, base, {
  stateByAction = {},
} = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const connection = openDatabase({
    databasePath: path.join(root, "test.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: path.resolve("database/migrations"),
    applicationBuildId: `${prefix}schema54`,
    now: () => 1,
  });
  assert.equal(
    connection.database.pragma("user_version", {
      simple: true,
    }),
    54
  );
  const fixtureIds = ids(base);
  const actions = actionMatrix(fixtureIds);
  const triggers = captureAndDropTriggers(connection.database);
  seedCore(connection.database, base, fixtureIds);
  const records = new Map();
  for (const [index, action] of actions.entries()) {
    const state = stateByAction[action.action] || {};
    const job = jobRecord(
      fixtureIds,
      action,
      index,
      { status: state.jobStatus || "pending" }
    );
    const recovery = recoveryRecord(
      fixtureIds,
      action,
      job,
      index,
      {
        status:
          state.recoveryStatus ||
          (
            state.jobStatus === "succeeded"
              ? "resolved"
              : "pending"
          ),
      }
    );
    insert(connection.database, "job_runs", job);
    insert(
      connection.database,
      "free_agent_draft_recoveries",
      recovery
    );
    records.set(action.action, { action, job, recovery });
  }
  restoreTriggers(connection.database, triggers);
  assert.equal(
    connection.database.pragma("integrity_check", {
      simple: true,
    }),
    "ok"
  );
  assert.deepEqual(
    connection.database.pragma("foreign_key_check"),
    []
  );
  return {
    ...connection,
    actions,
    fixtureIds,
    records,
  };
}

function identityFor(runtime, action, index, {
  actor = "commissioner",
  clientKey = `recovery-${action.action}-${index}`,
  reason = `Retry ${action.action} through its canonical job.`,
} = {}) {
  const actorValues = actor === "administrator"
    ? {
        actorAuthority:
          "platform_administrator_as_commissioner",
        actorMembershipId:
          runtime.fixtureIds.administratorMembership,
        actorUserId:
          runtime.fixtureIds.administratorUser,
      }
    : actor === "inactive_administrator"
      ? {
          actorAuthority:
            "platform_administrator_as_commissioner",
          actorMembershipId:
            runtime.fixtureIds
              .inactiveAdministratorMembership,
          actorUserId:
            runtime.fixtureIds.inactiveAdministratorUser,
        }
      : {
          actorAuthority: "commissioner",
          actorMembershipId:
            runtime.fixtureIds.commissionerMembership,
          actorUserId:
            runtime.fixtureIds.commissionerUser,
        };
  const body = {
    action: action.action,
    resourceId: action.resourceId,
    reason,
  };
  const request = {
    body,
    fadId: runtime.fixtureIds.fad,
    leagueId: runtime.fixtureIds.league,
  };
  return {
    ...actorValues,
    body,
    clientKey,
    fadId: runtime.fixtureIds.fad,
    leagueId: runtime.fixtureIds.league,
    requestJson:
      serializeFreeAgentDraftRecoveryActionRequest(request),
    requestSha256:
      hashFreeAgentDraftRecoveryActionRequest(request),
  };
}

function writeFor(runtime, action, index, options = {}) {
  return {
    ...identityFor(runtime, action, index, options),
    acceptedAtMs: ACCEPTED_AT_MS + index,
    commandResultId: uuid(
      Number(runtime.fixtureIds.fad.slice(-12)) + 700 + index
    ),
    idempotencyExpiresAtMs:
      ACCEPTED_AT_MS + index + DAY_MS,
    idempotencyRequestId: uuid(
      Number(runtime.fixtureIds.fad.slice(-12)) + 800 + index
    ),
  };
}

function replayFrom(write) {
  const {
    acceptedAtMs: _acceptedAtMs,
    commandResultId: _commandResultId,
    idempotencyExpiresAtMs: _expiresAtMs,
    idempotencyRequestId: _requestId,
    ...identity
  } = write;
  return identity;
}

function writeCounts(database) {
  return {
    requests: database.prepare(`
      SELECT COUNT(*) AS count
      FROM idempotency_requests
      WHERE operation =
        'free_agent_draft.recovery.action'
    `).get().count,
    results: database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_draft_recovery_action_command_results
    `).get().count,
  };
}

function databaseFingerprint(database) {
  return {
    sha256: createHash("sha256")
      .update(database.serialize())
      .digest("hex"),
    totalChanges: database.prepare(`
      SELECT total_changes() AS count
    `).get().count,
  };
}

function assertAuthorizationDeniedWithoutWrites(
  database,
  action
) {
  const before = databaseFingerprint(database);
  assert.throws(
    action,
    (error) =>
      error.code ===
      FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
        .authorizationDenied
  );
  assert.deepEqual(databaseFingerprint(database), before);
}

function job(database, id) {
  return database.prepare(`
    SELECT * FROM job_runs WHERE id = ?
  `).get(id);
}

describe("SQLite FAD recovery-action persistence", () => {
  test("maps all eight actions to exact canonical jobs and preserves pending, leased, and running identity", (t) => {
    const runtime = createFixture(
      t,
      "fad-recovery-actions-",
      510_000,
      {
        stateByAction: {
          retry_allocation: { jobStatus: "leased" },
          activate_restricted: { jobStatus: "running" },
        },
      }
    );
    const repository =
      createSqliteFreeAgentDraftRecoveryActionRepository({
        database: runtime.database,
      });
    for (const [index, action] of
      runtime.actions.entries()) {
      const record = runtime.records.get(action.action);
      const beforeJob = job(runtime.database, record.job.id);
      const result = repository.acceptRecoveryAction(
        writeFor(runtime, action, index)
      );
      assert.deepEqual(result, {
        data: {
          operationId: record.job.id,
          occurrenceKey: action.occurrenceKey,
          action: action.action,
          resourceId: action.resourceId,
          status: "pending",
          acceptedAtMs: ACCEPTED_AT_MS + index,
          pollDescriptor: {
            kind: "fad_recovery",
            leagueId: runtime.fixtureIds.league,
            fadId: runtime.fixtureIds.fad,
          },
        },
        httpStatus: 202,
        replayed: false,
      });
      assert.deepEqual(
        job(runtime.database, record.job.id),
        beforeJob
      );
    }
    const rows = runtime.database.prepare(`
      SELECT action, resource_kind AS resourceKind,
             resource_id AS resourceId,
             operation_id AS operationId,
             job_run_id AS jobRunId,
             occurrence_key AS occurrenceKey,
             accepted_status AS acceptedStatus
      FROM free_agent_draft_recovery_action_command_results
      ORDER BY accepted_at_ms
    `).all();
    assert.deepEqual(
      rows.map((row, index) => ({
        action: row.action,
        resourceKind: row.resourceKind,
        resourceId: row.resourceId,
        operationIdentity:
          row.operationId === row.jobRunId,
        occurrenceKey: row.occurrenceKey,
        acceptedStatus: row.acceptedStatus,
      })),
      runtime.actions.map((action, index) => ({
        action: action.action,
        resourceKind: [
          "retry_deadline",
          "complete_fad",
        ].includes(action.action)
          ? "fad"
          : action.action ===
              "activate_queued_nomination"
            ? "nomination_queue"
            : action.action ===
                "retry_auction_resolution"
              ? "auction"
              : action.action === "finalize_rollover"
                ? "rollover"
                : "allocation",
        resourceId:
          action.resourceId ?? runtime.fixtureIds.fad,
        operationIdentity: true,
        occurrenceKey: action.occurrenceKey,
        acceptedStatus: "pending",
      }))
    );
    assert.deepEqual(writeCounts(runtime.database), {
      requests: 8,
      results: 8,
    });
  });

  test("requeues one failed job without changing identity or schedule and restarts correction-required recovery", (t) => {
    const runtime = createFixture(
      t,
      "fad-recovery-requeue-",
      511_000,
      {
        stateByAction: {
          retry_allocation: {
            jobStatus: "failed",
            recoveryStatus: "correction_required",
          },
        },
      }
    );
    const action = runtime.actions.find(
      ({ action: value }) => value === "retry_allocation"
    );
    const record = runtime.records.get(action.action);
    const beforeJob = job(runtime.database, record.job.id);
    const repository =
      createSqliteFreeAgentDraftRecoveryActionRepository({
        database: runtime.database,
      });
    const result = repository.acceptRecoveryAction(
      writeFor(runtime, action, 20)
    );
    assert.equal(result.data.status, "pending");
    const afterJob = job(runtime.database, record.job.id);
    assert.equal(afterJob.id, beforeJob.id);
    assert.equal(afterJob.job_type, beforeJob.job_type);
    assert.equal(
      afterJob.occurrence_key,
      beforeJob.occurrence_key
    );
    assert.equal(
      afterJob.scheduled_for_ms,
      beforeJob.scheduled_for_ms
    );
    assert.equal(afterJob.attempt_count, beforeJob.attempt_count);
    assert.equal(afterJob.status, "pending");
    assert.equal(afterJob.version, beforeJob.version + 1);
    assert.equal(
      afterJob.next_attempt_at_ms,
      ACCEPTED_AT_MS + 20
    );
    for (const field of [
      "lease_owner",
      "lease_token",
      "lease_expires_at_ms",
      "started_at_ms",
      "completed_at_ms",
      "result_json",
      "last_error_code",
    ]) {
      assert.equal(afterJob[field], null, field);
    }
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, commissioner_reason AS commissionerReason,
               version
        FROM free_agent_draft_recoveries
        WHERE id = ?
      `).get(record.recovery.id),
      {
        status: "running",
        commissionerReason:
          "Retry retry_allocation through its canonical job.",
        version: record.recovery.version + 1,
      }
    );
  });

  test("returns the immutable original already-succeeded result after mutable job, recovery, and FAD changes", (t) => {
    const runtime = createFixture(
      t,
      "fad-recovery-replay-",
      512_000,
      {
        stateByAction: {
          retry_deadline: {
            jobStatus: "succeeded",
            recoveryStatus: "resolved",
          },
        },
      }
    );
    const action = runtime.actions[0];
    const record = runtime.records.get(action.action);
    const repository =
      createSqliteFreeAgentDraftRecoveryActionRepository({
        database: runtime.database,
      });
    const write = writeFor(runtime, action, 30);
    const original = repository.acceptRecoveryAction(write);
    assert.equal(original.data.status, "already_succeeded");
    mutateWithoutTriggers(runtime.database, () => {
      runtime.database.prepare(`
        UPDATE job_runs
        SET status = 'failed',
            result_json = NULL,
            last_error_code = 'LATER_FAILURE',
            version = version + 1
        WHERE id = ?
      `).run(record.job.id);
      runtime.database.prepare(`
        UPDATE free_agent_draft_recoveries
        SET status = 'correction_required',
            resolved_at_ms = NULL,
            resolved_authority = NULL,
            last_error_code = 'LATER_FAILURE',
            version = version + 1
        WHERE id = ?
      `).run(record.recovery.id);
      runtime.database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'completed',
            completed_at_ms = ?,
            version = version + 1
        WHERE id = ?
      `).run(ACCEPTED_AT_MS + 100, runtime.fixtureIds.fad);
    });
    assert.deepEqual(
      repository.findRecoveryActionReplay(
        replayFrom(write)
      ),
      { ...original, replayed: true }
    );
    const changed = identityFor(runtime, action, 30, {
      clientKey: write.clientKey,
      reason: "A different recovery intent.",
    });
    assert.throws(
      () =>
        repository.findRecoveryActionReplay(changed),
      (error) =>
        error.code ===
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .idempotencyConflict
    );
    assert.deepEqual(writeCounts(runtime.database), {
      requests: 1,
      results: 1,
    });
  });

  test("reauthorizes active current recovery actors before replay and writes nothing for stale or malformed authority", (t) => {
    const runtime = createFixture(
      t,
      "fad-recovery-authority-",
      513_000
    );
    const repository =
      createSqliteFreeAgentDraftRecoveryActionRepository({
        database: runtime.database,
      });
    const commissionerAction = runtime.actions[0];
    const commissionerWrite = writeFor(
      runtime,
      commissionerAction,
      40
    );
    repository.acceptRecoveryAction(commissionerWrite);
    const adminAction = runtime.actions[1];
    const adminWrite = writeFor(runtime, adminAction, 41, {
      actor: "administrator",
    });
    repository.acceptRecoveryAction(adminWrite);
    assert.equal(
      runtime.database.prepare(`
        SELECT actor_authority
        FROM free_agent_draft_recovery_action_command_results
        WHERE action = 'retry_allocation'
      `).get().actor_authority,
      "platform_administrator_as_commissioner"
    );
    const counts = writeCounts(runtime.database);
    assertAuthorizationDeniedWithoutWrites(
      runtime.database,
      () =>
        repository.acceptRecoveryAction(
          writeFor(runtime, runtime.actions[2], 42, {
            actor: "inactive_administrator",
          })
        )
    );

    mutateWithoutTriggers(runtime.database, () => {
      runtime.database.prepare(`
        UPDATE platform_roles
        SET ended_at_ms = ?
        WHERE id = ?
      `).run(
        ACCEPTED_AT_MS + 100,
        runtime.fixtureIds.administratorRole
      );
    });
    assertAuthorizationDeniedWithoutWrites(
      runtime.database,
      () => repository.findRecoveryActionReplay(
        replayFrom(adminWrite)
      )
    );
    mutateWithoutTriggers(runtime.database, () => {
      runtime.database.prepare(`
        UPDATE platform_roles
        SET ended_at_ms = NULL
        WHERE id = ?
      `).run(runtime.fixtureIds.administratorRole);
      runtime.database.prepare(`
        UPDATE league_memberships
        SET ended_at_ms = ?
        WHERE id = ?
      `).run(
        ACCEPTED_AT_MS + 101,
        runtime.fixtureIds.administratorMembership
      );
    });
    assertAuthorizationDeniedWithoutWrites(
      runtime.database,
      () => repository.findRecoveryActionReplay(
        replayFrom(adminWrite)
      )
    );
    mutateWithoutTriggers(runtime.database, () => {
      runtime.database.prepare(`
        UPDATE league_memberships
        SET joined_at_ms = NULL,
            ended_at_ms = NULL
        WHERE id = ?
      `).run(runtime.fixtureIds.administratorMembership);
    });
    assertAuthorizationDeniedWithoutWrites(
      runtime.database,
      () => repository.findRecoveryActionReplay(
        replayFrom(adminWrite)
      )
    );
    mutateWithoutTriggers(runtime.database, () => {
      runtime.database.prepare(`
        UPDATE league_memberships
        SET joined_at_ms = 1
        WHERE id = ?
      `).run(runtime.fixtureIds.administratorMembership);
      runtime.database.prepare(`
        UPDATE users
        SET status = 'disabled'
        WHERE id = ?
      `).run(runtime.fixtureIds.administratorUser);
    });
    assertAuthorizationDeniedWithoutWrites(
      runtime.database,
      () => repository.findRecoveryActionReplay(
        replayFrom(adminWrite)
      )
    );
    mutateWithoutTriggers(runtime.database, () => {
      runtime.database.prepare(`
        UPDATE users
        SET status = 'active'
        WHERE id = ?
      `).run(runtime.fixtureIds.administratorUser);
    });
    mutateWithoutTriggers(runtime.database, () => {
      runtime.database.prepare(`
        UPDATE leagues
        SET commissioner_membership_id = ?
        WHERE id = ?
      `).run(
        runtime.fixtureIds.administratorMembership,
        runtime.fixtureIds.league
      );
    });
    assertAuthorizationDeniedWithoutWrites(
      runtime.database,
      () =>
        repository.findRecoveryActionReplay(
          replayFrom(commissionerWrite)
        )
    );
    assert.equal(
      repository.findRecoveryActionReplay(
        replayFrom(adminWrite)
      ).replayed,
      true
    );
    assert.deepEqual(writeCounts(runtime.database), counts);
  });

  test("rejects stale, cross-scope, malformed-resource, and duplicate active recovery evidence with zero writes", (t) => {
    const runtime = createFixture(
      t,
      "fad-recovery-reject-",
      514_000
    );
    const repository =
      createSqliteFreeAgentDraftRecoveryActionRepository({
        database: runtime.database,
      });
    const action = runtime.actions[1];
    const baseline = writeCounts(runtime.database);
    const missingFad = writeFor(runtime, action, 50);
    const otherFad = uuid(999_991);
    const crossScopeRequest = {
      body: missingFad.body,
      fadId: otherFad,
      leagueId: missingFad.leagueId,
    };
    assert.throws(
      () => repository.acceptRecoveryAction({
        ...missingFad,
        fadId: otherFad,
        requestJson:
          serializeFreeAgentDraftRecoveryActionRequest(
            crossScopeRequest
          ),
        requestSha256:
          hashFreeAgentDraftRecoveryActionRequest(
            crossScopeRequest
          ),
      }),
      (error) =>
        error.code ===
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .fadNotFound
    );
    const stale = writeFor(runtime, action, 51);
    const staleBody = {
      ...stale.body,
      resourceId: uuid(999_992),
    };
    const staleRequest = {
      body: staleBody,
      fadId: stale.fadId,
      leagueId: stale.leagueId,
    };
    assert.throws(
      () => repository.acceptRecoveryAction({
        ...stale,
        body: staleBody,
        requestJson:
          serializeFreeAgentDraftRecoveryActionRequest(
            staleRequest
          ),
        requestSha256:
          hashFreeAgentDraftRecoveryActionRequest(
            staleRequest
          ),
      }),
      (error) =>
        error.code ===
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .recoveryNotAvailable
    );
    for (const body of [
      {
        action: "retry_deadline",
        resourceId: runtime.fixtureIds.fad,
        reason: "Invalid whole-FAD resource.",
      },
      {
        action: "retry_allocation",
        resourceId: null,
        reason: "Missing allocation resource.",
      },
    ]) {
      const invalidRequest = {
        ...identityFor(runtime, action, 52),
        body,
      };
      assert.throws(
        () => repository.findRecoveryActionReplay(invalidRequest),
        (error) =>
          error.code ===
          REPOSITORY_ERROR_CODES.argumentInvalid
      );
    }
    const staleClock = writeFor(runtime, action, 54);
    assert.throws(
      () => repository.acceptRecoveryAction({
        ...staleClock,
        acceptedAtMs: OPENED_AT_MS - 1,
        idempotencyExpiresAtMs:
          OPENED_AT_MS - 1 + DAY_MS,
      }),
      (error) =>
        error.code ===
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .recoveryNotAvailable
    );
    const record = runtime.records.get(action.action);
    mutateWithoutTriggers(runtime.database, () => {
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        {
          ...record.recovery,
          id: uuid(999_993),
          created_at_ms:
            record.recovery.created_at_ms + 1,
          updated_at_ms:
            record.recovery.updated_at_ms + 1,
        }
      );
    });
    assert.throws(
      () =>
        repository.acceptRecoveryAction(
          writeFor(runtime, action, 53)
        ),
      (error) =>
        error.code ===
        REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assert.deepEqual(writeCounts(runtime.database), baseline);
  });

  test("rolls back the failed-job requeue and every receipt write when the immediate transaction cannot commit", (t) => {
    const runtime = createFixture(
      t,
      "fad-recovery-rollback-",
      515_000,
      {
        stateByAction: {
          retry_allocation: {
            jobStatus: "failed",
            recoveryStatus: "correction_required",
          },
        },
      }
    );
    const action = runtime.actions[1];
    const record = runtime.records.get(action.action);
    const beforeJob = job(runtime.database, record.job.id);
    const beforeRecovery = runtime.database.prepare(`
      SELECT * FROM free_agent_draft_recoveries WHERE id = ?
    `).get(record.recovery.id);
    let observedImmediate = false;
    const repository =
      createSqliteFreeAgentDraftRecoveryActionRepository({
        database: runtime.database,
        beforeCommit() {
          observedImmediate = runtime.database.inTransaction;
          throw new Error("forced rollback");
        },
      });
    assert.throws(
      () =>
        repository.acceptRecoveryAction(
          writeFor(runtime, action, 60)
        ),
      (error) =>
        error.code ===
        REPOSITORY_ERROR_CODES.operationFailed
    );
    assert.equal(observedImmediate, true);
    assert.deepEqual(
      job(runtime.database, record.job.id),
      beforeJob
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT * FROM free_agent_draft_recoveries WHERE id = ?
      `).get(record.recovery.id),
      beforeRecovery
    );
    assert.deepEqual(writeCounts(runtime.database), {
      requests: 0,
      results: 0,
    });
  });
});
