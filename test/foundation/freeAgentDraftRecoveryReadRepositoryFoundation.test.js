"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const Database = require("better-sqlite3");

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
  FREE_AGENT_DRAFT_DAY_MS,
  FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
  buildFreeAgentDraftDeadlineOccurrenceKey,
  buildFreeAgentDraftNominationOpenOccurrenceKey,
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftScheduleRecoveryEvidence,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftScheduleRecoveryEvidencePolicy"
);
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  FREE_AGENT_DRAFT_RECOVERY_READ_REPOSITORY_CODES,
  createSqliteFreeAgentDraftRecoveryReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRecoveryReadRepository"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const DEADLINE_AT_MS = Date.parse(
  "2026-09-28T07:00:00.000Z"
);
const WEEK_ONE_AT_MS =
  DEADLINE_AT_MS + 7 * FREE_AGENT_DRAFT_DAY_MS;
const OPENED_AT_MS =
  DEADLINE_AT_MS - 30 * FREE_AGENT_DRAFT_DAY_MS;
const HELP_OPENS_AT_MS =
  DEADLINE_AT_MS - 2 * FREE_AGENT_DRAFT_DAY_MS;
const NOW_MS = OPENED_AT_MS + FREE_AGENT_DRAFT_DAY_MS;
const PRIVATE_SENTINEL =
  "private-candidate-help-bid-draw-nonce-payload";
const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

const PRIMARY = Object.freeze({
  leagueId: uuid(1),
  seasonId: uuid(2),
  commissionerUserId: uuid(3),
  commissionerMembershipId: uuid(4),
  administratorUserId: uuid(5),
  administratorMembershipId: uuid(6),
  administratorRoleId: uuid(7),
  administratorReplacementRoleId: uuid(20),
  memberUserId: uuid(8),
  memberMembershipId: uuid(9),
  fadId: uuid(10),
  weekId: uuid(11),
  scheduleOperationId: uuid(12),
  teamId: uuid(13),
  deadlineJobId: uuid(14),
  playerId: uuid(15),
  queueId: uuid(16),
  queueJobId: uuid(17),
  recoveryId: uuid(18),
  historicalRecoveryId: uuid(19),
});
const SECONDARY = Object.freeze({
  leagueId: uuid(101),
  seasonId: uuid(102),
  fadId: uuid(103),
});

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE leagues (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      commissioner_membership_id TEXT
    );
    CREATE TABLE league_memberships (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      permission_category TEXT NOT NULL,
      ended_at_ms INTEGER
    );
    CREATE TABLE platform_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      ended_at_ms INTEGER
    );
    CREATE TABLE seasons (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      free_agent_draft_completed_at_ms INTEGER
    );
    CREATE TABLE free_agent_drafts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      status TEXT NOT NULL,
      participating_team_count INTEGER NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      help_opens_at_ms INTEGER NOT NULL,
      candidate_deadline_at_ms INTEGER NOT NULL,
      deadline_locked_at_ms INTEGER,
      allocation_completed_at_ms INTEGER,
      first_matchup_starts_at_ms INTEGER NOT NULL,
      first_matchup_week_id TEXT NOT NULL,
      current_competition_first_matchup_week_id TEXT NOT NULL,
      schedule_recovery_id TEXT,
      completed_at_ms INTEGER,
      version INTEGER NOT NULL
    );
    CREATE TABLE matchup_weeks (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      starts_at_ms INTEGER NOT NULL
    );
    CREATE TABLE season_matchup_schedule_generations (
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      week_one_matchup_week_id TEXT NOT NULL,
      week_one_starts_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      schedule_operation_id TEXT NOT NULL,
      schedule_version INTEGER NOT NULL
    );
    CREATE TABLE free_agent_draft_teams (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      fad_id TEXT NOT NULL
    );
    CREATE TABLE candidate_cards (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      status TEXT NOT NULL,
      private_payload TEXT
    );
    CREATE TABLE free_agent_draft_player_allocations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE auctions (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      status TEXT NOT NULL,
      resolves_at_ms INTEGER NOT NULL
    );
    CREATE TABLE auction_contexts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      auction_id TEXT NOT NULL,
      fad_id TEXT,
      source_kind TEXT NOT NULL
    );
    CREATE TABLE free_agent_draft_nomination_queue (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      target_opening_rollover_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE free_agent_draft_rollovers (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      opens_at_ms INTEGER NOT NULL,
      creation_cutoff_at_ms INTEGER NOT NULL,
      rolls_over_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      processing_job_run_id TEXT,
      processing_started_at_ms INTEGER,
      completed_at_ms INTEGER,
      last_error_code TEXT,
      version INTEGER NOT NULL
    );
    CREATE TABLE free_agent_draft_recoveries (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      player_id TEXT,
      allocation_id TEXT,
      rollover_id TEXT,
      auction_id TEXT,
      job_run_id TEXT,
      nomination_queue_id TEXT,
      earliest_activation_at_ms INTEGER,
      target_resolution_at_ms INTEGER,
      last_error_code TEXT,
      commissioner_reason TEXT,
      created_by_operation_id TEXT,
      resolved_by_user_id TEXT,
      resolved_by_membership_id TEXT,
      resolved_authority TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      resolved_at_ms INTEGER,
      version INTEGER NOT NULL
    );
    CREATE TABLE job_runs (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at_ms INTEGER,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      result_json TEXT,
      last_error_code TEXT,
      next_attempt_at_ms INTEGER,
      version INTEGER NOT NULL
    );
    CREATE TABLE free_agent_draft_schedule_recoveries (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      recovery_kind TEXT NOT NULL,
      matchup_operation_id TEXT NOT NULL,
      old_schedule_operation_id TEXT NOT NULL,
      new_schedule_operation_id TEXT NOT NULL,
      old_first_matchup_week_id TEXT NOT NULL,
      new_first_matchup_week_id TEXT NOT NULL,
      old_schedule_version INTEGER NOT NULL,
      new_schedule_version INTEGER NOT NULL,
      old_week_one_starts_at_ms INTEGER NOT NULL,
      new_week_one_starts_at_ms INTEGER NOT NULL,
      removed_week_count INTEGER NOT NULL,
      removed_matchup_count INTEGER NOT NULL,
      replaced_job_count INTEGER NOT NULL,
      cancelled_job_count INTEGER NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      evidence_schema_version INTEGER NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE free_agent_draft_schedule_recovery_weeks (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      schedule_recovery_id TEXT NOT NULL,
      removed_matchup_week_id TEXT NOT NULL,
      removed_sequence INTEGER NOT NULL,
      removed_starts_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE free_agent_draft_schedule_recovery_matchups (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      schedule_recovery_id TEXT NOT NULL,
      removed_matchup_id TEXT NOT NULL,
      removed_matchup_week_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE free_agent_draft_schedule_recovery_jobs (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      schedule_recovery_id TEXT NOT NULL,
      disposition TEXT NOT NULL,
      job_type TEXT NOT NULL,
      replaced_job_run_id TEXT NOT NULL,
      replacement_job_run_id TEXT,
      replaced_occurrence_key TEXT NOT NULL,
      replacement_occurrence_key TEXT,
      replaced_schedule_operation_id TEXT NOT NULL,
      replaced_schedule_version INTEGER NOT NULL,
      replacement_schedule_operation_id TEXT,
      replacement_schedule_version INTEGER,
      replaced_job_version INTEGER NOT NULL,
      replacement_job_version INTEGER,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE candidate_card_entries (
      id TEXT PRIMARY KEY,
      private_payload TEXT NOT NULL
    );
    CREATE TABLE candidate_card_help_requests (
      id TEXT PRIMARY KEY,
      private_payload TEXT NOT NULL
    );
    CREATE TABLE auction_bids (
      id TEXT PRIMARY KEY,
      private_payload TEXT NOT NULL
    );
    CREATE TABLE free_agent_draft_auction_draws (
      id TEXT PRIMARY KEY,
      nonce BLOB NOT NULL
    );
  `);
}

function pendingJob({
  id,
  jobType,
  occurrenceKey,
  scheduledForMs,
}) {
  return {
    id,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    job_type: jobType,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: scheduledForMs,
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
    version: 1,
  };
}

function seedBase(database) {
  for (const [id, status] of [
    [PRIMARY.commissionerUserId, "active"],
    [PRIMARY.administratorUserId, "active"],
    [PRIMARY.memberUserId, "active"],
  ]) {
    insert(database, "users", { id, status });
  }
  insert(database, "leagues", {
    id: PRIMARY.leagueId,
    status: "active",
    commissioner_membership_id:
      PRIMARY.commissionerMembershipId,
  });
  for (const membership of [
    {
      id: PRIMARY.commissionerMembershipId,
      user_id: PRIMARY.commissionerUserId,
      permission_category: "commissioner",
    },
    {
      id: PRIMARY.administratorMembershipId,
      user_id: PRIMARY.administratorUserId,
      permission_category: "member",
    },
    {
      id: PRIMARY.memberMembershipId,
      user_id: PRIMARY.memberUserId,
      permission_category: "member",
    },
  ]) {
    insert(database, "league_memberships", {
      ...membership,
      league_id: PRIMARY.leagueId,
      status: "active",
      ended_at_ms: null,
    });
  }
  insert(database, "platform_roles", {
    id: PRIMARY.administratorRoleId,
    user_id: PRIMARY.administratorUserId,
    role: "platform_administrator",
    status: "active",
    ended_at_ms: null,
  });
  insert(database, "seasons", {
    id: PRIMARY.seasonId,
    league_id: PRIMARY.leagueId,
    free_agent_draft_completed_at_ms: null,
  });
  insert(database, "matchup_weeks", {
    id: PRIMARY.weekId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    sequence: 1,
    starts_at_ms: WEEK_ONE_AT_MS,
  });
  insert(database, "season_matchup_schedule_generations", {
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    week_one_matchup_week_id: PRIMARY.weekId,
    week_one_starts_at_ms: WEEK_ONE_AT_MS,
    status: "current",
    schedule_operation_id: PRIMARY.scheduleOperationId,
    schedule_version: 1,
  });
  insert(database, "free_agent_drafts", {
    id: PRIMARY.fadId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    status: "cards_open",
    participating_team_count: 1,
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: HELP_OPENS_AT_MS,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    deadline_locked_at_ms: null,
    allocation_completed_at_ms: null,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    first_matchup_week_id: PRIMARY.weekId,
    current_competition_first_matchup_week_id:
      PRIMARY.weekId,
    schedule_recovery_id: null,
    completed_at_ms: null,
    version: 1,
  });
  insert(database, "free_agent_draft_teams", {
    id: PRIMARY.teamId,
    league_id: PRIMARY.leagueId,
    fad_id: PRIMARY.fadId,
  });
  insert(database, "candidate_cards", {
    id: uuid(50),
    league_id: PRIMARY.leagueId,
    fad_id: PRIMARY.fadId,
    status: "open",
    private_payload: PRIVATE_SENTINEL,
  });
  insert(database, "job_runs", pendingJob({
    id: PRIMARY.deadlineJobId,
    jobType: "fad_deadline",
    occurrenceKey:
      buildFreeAgentDraftDeadlineOccurrenceKey({
        fadId: PRIMARY.fadId,
        deadlineAtMs: DEADLINE_AT_MS,
      }),
    scheduledForMs: DEADLINE_AT_MS,
  }));
  for (let index = 1; index <= 7; index += 1) {
    const rolloverId = uuid(60 + index);
    const jobId = uuid(70 + index);
    const opensAtMs =
      DEADLINE_AT_MS +
      (index - 1) * FREE_AGENT_DRAFT_DAY_MS;
    const rollsOverAtMs =
      DEADLINE_AT_MS +
      index * FREE_AGENT_DRAFT_DAY_MS;
    insert(database, "free_agent_draft_rollovers", {
      id: rolloverId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      fad_id: PRIMARY.fadId,
      sequence: index,
      opens_at_ms: opensAtMs,
      creation_cutoff_at_ms:
        rollsOverAtMs -
        FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
      rolls_over_at_ms: rollsOverAtMs,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      version: 1,
    });
    insert(database, "job_runs", pendingJob({
      id: jobId,
      jobType: "fad_rollover",
      occurrenceKey:
        buildFreeAgentDraftRolloverOccurrenceKey({
          fadId: PRIMARY.fadId,
          sequence: index,
          rolloverAtMs: rollsOverAtMs,
        }),
      scheduledForMs: rollsOverAtMs,
    }));
  }
  insert(database, "leagues", {
    id: SECONDARY.leagueId,
    status: "active",
    commissioner_membership_id: null,
  });
  insert(database, "seasons", {
    id: SECONDARY.seasonId,
    league_id: SECONDARY.leagueId,
    free_agent_draft_completed_at_ms: null,
  });
  insert(database, "free_agent_drafts", {
    id: SECONDARY.fadId,
    league_id: SECONDARY.leagueId,
    season_id: SECONDARY.seasonId,
    status: "cards_open",
    participating_team_count: 0,
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: HELP_OPENS_AT_MS,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    deadline_locked_at_ms: null,
    allocation_completed_at_ms: null,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    first_matchup_week_id: uuid(104),
    current_competition_first_matchup_week_id: uuid(104),
    schedule_recovery_id: null,
    completed_at_ms: null,
    version: 1,
  });
  for (const [tableName, id] of [
    ["candidate_card_entries", uuid(201)],
    ["candidate_card_help_requests", uuid(202)],
    ["auction_bids", uuid(203)],
  ]) {
    insert(database, tableName, {
      id,
      private_payload: PRIVATE_SENTINEL,
    });
  }
  insert(database, "free_agent_draft_auction_draws", {
    id: uuid(204),
    nonce: Buffer.from(PRIVATE_SENTINEL),
  });
}

function seedQueuedRecovery(
  database,
  { historicalResolved = false } = {}
) {
  const firstRolloverId = uuid(61);
  const rolloverAtMs =
    DEADLINE_AT_MS + FREE_AGENT_DRAFT_DAY_MS;
  insert(database, "free_agent_draft_nomination_queue", {
    id: PRIMARY.queueId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    fad_id: PRIMARY.fadId,
    player_id: PRIMARY.playerId,
    target_opening_rollover_id: firstRolloverId,
    status: "queued",
  });
  insert(database, "job_runs", {
    ...pendingJob({
      id: PRIMARY.queueJobId,
      jobType: "fad_queued_nomination_activation",
      occurrenceKey:
        buildFreeAgentDraftNominationOpenOccurrenceKey({
          fadId: PRIMARY.fadId,
          queueId: PRIMARY.queueId,
          rolloverAtMs,
        }),
      scheduledForMs: rolloverAtMs,
    }),
    status: "failed",
    attempt_count: 1,
    started_at_ms: rolloverAtMs,
    completed_at_ms: rolloverAtMs + 1,
    last_error_code: "QUEUE_ACTIVATION_FAILED",
  });
  if (historicalResolved) {
    insertRecovery(database, {
      id: PRIMARY.historicalRecoveryId,
      status: "resolved",
      createdAtMs: rolloverAtMs + 2,
      resolvedAtMs: rolloverAtMs + 3,
    });
  }
  insertRecovery(database, {
    id: PRIMARY.recoveryId,
    status: "pending",
    createdAtMs: rolloverAtMs + 4,
    resolvedAtMs: null,
  });
}

function insertRecovery(database, {
  id,
  status,
  createdAtMs,
  resolvedAtMs,
}) {
  insert(database, "free_agent_draft_recoveries", {
    id,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    fad_id: PRIMARY.fadId,
    kind: "queued_nomination_activation",
    status,
    player_id: PRIMARY.playerId,
    allocation_id: null,
    rollover_id: uuid(61),
    auction_id: null,
    job_run_id: PRIMARY.queueJobId,
    nomination_queue_id: PRIMARY.queueId,
    earliest_activation_at_ms:
      DEADLINE_AT_MS + FREE_AGENT_DRAFT_DAY_MS,
    target_resolution_at_ms: null,
    last_error_code: "QUEUE_ACTIVATION_FAILED",
    commissioner_reason: null,
    created_by_operation_id: PRIMARY.queueJobId,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority:
      status === "resolved" ? "system" : null,
    created_at_ms: createdAtMs,
    updated_at_ms: resolvedAtMs ?? createdAtMs,
    resolved_at_ms: resolvedAtMs,
    version: status === "resolved" ? 2 : 1,
  });
}

function seedScheduleRecovery(database) {
  const recoveryId = uuid(300);
  const newWeekId = uuid(301);
  const newScheduleOperationId = uuid(302);
  const removedWeekChildId = uuid(303);
  const replacedEffectId = uuid(304);
  const cancelledEffectId = uuid(305);
  const oldReplacedJobId = uuid(306);
  const newReplacedJobId = uuid(307);
  const oldCancelledJobId = uuid(308);
  const newWeekOneAtMs =
    WEEK_ONE_AT_MS + 7 * FREE_AGENT_DRAFT_DAY_MS;
  const completedAtMs = WEEK_ONE_AT_MS + 1_000;
  const replacedEffect = {
    disposition: "replaced",
    jobType: "matchup.lock",
    oldJobRunId: oldReplacedJobId,
    oldOccurrenceKey: "matchup:old-lock:1",
    oldScheduleOperationId: PRIMARY.scheduleOperationId,
    oldScheduleVersion: 1,
    newJobRunId: newReplacedJobId,
    newOccurrenceKey: "matchup:new-lock:1",
    newScheduleOperationId,
    newScheduleVersion: 2,
  };
  const cancelledEffect = {
    disposition: "cancelled",
    jobType: "matchup.publish",
    oldJobRunId: oldCancelledJobId,
    oldOccurrenceKey: "matchup:old-publish:1",
    oldScheduleOperationId: PRIMARY.scheduleOperationId,
    oldScheduleVersion: 1,
    newJobRunId: null,
    newOccurrenceKey: null,
    newScheduleOperationId: null,
    newScheduleVersion: null,
  };
  const sealed =
    createFreeAgentDraftScheduleRecoveryEvidence({
      recoveryId,
      leagueId: PRIMARY.leagueId,
      seasonId: PRIMARY.seasonId,
      fadId: PRIMARY.fadId,
      recoveryKind: "completion",
      operationId: newScheduleOperationId,
      oldScheduleOperationId:
        PRIMARY.scheduleOperationId,
      newScheduleOperationId,
      oldScheduleVersion: 1,
      newScheduleVersion: 2,
      oldFirstMatchupWeekId: PRIMARY.weekId,
      newFirstMatchupWeekId: newWeekId,
      oldWeek1StartsAtMs: WEEK_ONE_AT_MS,
      newWeek1StartsAtMs: newWeekOneAtMs,
      completedAtMs,
      removedWeeks: [
        {
          matchupWeekId: PRIMARY.weekId,
          sequence: 1,
          startsAtMs: WEEK_ONE_AT_MS,
        },
      ],
      removedMatchups: [],
      jobEffects: [replacedEffect, cancelledEffect],
    });
  stateUpdate(
    database,
    `UPDATE season_matchup_schedule_generations
       SET status='superseded'
     WHERE league_id=@leagueId AND season_id=@seasonId`,
    {
      leagueId: PRIMARY.leagueId,
      seasonId: PRIMARY.seasonId,
    }
  );
  insert(database, "matchup_weeks", {
    id: newWeekId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    sequence: 1,
    starts_at_ms: newWeekOneAtMs,
  });
  insert(database, "season_matchup_schedule_generations", {
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    week_one_matchup_week_id: newWeekId,
    week_one_starts_at_ms: newWeekOneAtMs,
    status: "current",
    schedule_operation_id: newScheduleOperationId,
    schedule_version: 2,
  });
  insert(database, "free_agent_draft_schedule_recoveries", {
    id: recoveryId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    fad_id: PRIMARY.fadId,
    recovery_kind: "completion",
    matchup_operation_id: newScheduleOperationId,
    old_schedule_operation_id:
      PRIMARY.scheduleOperationId,
    new_schedule_operation_id: newScheduleOperationId,
    old_first_matchup_week_id: PRIMARY.weekId,
    new_first_matchup_week_id: newWeekId,
    old_schedule_version: 1,
    new_schedule_version: 2,
    old_week_one_starts_at_ms: WEEK_ONE_AT_MS,
    new_week_one_starts_at_ms: newWeekOneAtMs,
    removed_week_count: 1,
    removed_matchup_count: 0,
    replaced_job_count: 1,
    cancelled_job_count: 1,
    completed_at_ms: completedAtMs,
    evidence_schema_version: 1,
    evidence_sha256: sealed.evidenceSha256,
    created_at_ms: completedAtMs,
    version: 1,
  });
  insert(
    database,
    "free_agent_draft_schedule_recovery_weeks",
    {
      id: removedWeekChildId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      schedule_recovery_id: recoveryId,
      removed_matchup_week_id: PRIMARY.weekId,
      removed_sequence: 1,
      removed_starts_at_ms: WEEK_ONE_AT_MS,
      created_at_ms: completedAtMs,
    }
  );
  for (const [id, effect] of [
    [replacedEffectId, replacedEffect],
    [cancelledEffectId, cancelledEffect],
  ]) {
    insert(database, "free_agent_draft_schedule_recovery_jobs", {
      id,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      schedule_recovery_id: recoveryId,
      disposition: effect.disposition,
      job_type: effect.jobType,
      replaced_job_run_id: effect.oldJobRunId,
      replacement_job_run_id: effect.newJobRunId,
      replaced_occurrence_key: effect.oldOccurrenceKey,
      replacement_occurrence_key: effect.newOccurrenceKey,
      replaced_schedule_operation_id:
        effect.oldScheduleOperationId,
      replaced_schedule_version:
        effect.oldScheduleVersion,
      replacement_schedule_operation_id:
        effect.newScheduleOperationId,
      replacement_schedule_version:
        effect.newScheduleVersion,
      replaced_job_version: 1,
      replacement_job_version:
        effect.disposition === "replaced" ? 1 : null,
      created_at_ms: completedAtMs,
      version: 1,
    });
  }
  stateUpdate(
    database,
    `UPDATE free_agent_drafts
        SET status='completed',
            current_competition_first_matchup_week_id=@newWeekId,
            schedule_recovery_id=@recoveryId,
            completed_at_ms=@completedAtMs,
            version=2
      WHERE id=@fadId`,
    {
      newWeekId,
      recoveryId,
      completedAtMs,
      fadId: PRIMARY.fadId,
    }
  );
  stateUpdate(
    database,
    `UPDATE seasons
        SET free_agent_draft_completed_at_ms=@completedAtMs
      WHERE id=@seasonId`,
    {
      completedAtMs,
      seasonId: PRIMARY.seasonId,
    }
  );
  return {
    recoveryId,
    newScheduleOperationId,
    newWeekOneAtMs,
    completedAtMs,
    oldReplacedJobId,
    newReplacedJobId,
  };
}

function stateUpdate(database, sql, parameters) {
  const result = database.prepare(sql).run(parameters);
  assert.equal(result.changes, 1);
}

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-recovery-read-")
  );
  const databasePath = path.join(directory, "fixture.sqlite");
  const database = new Database(databasePath);
  database.pragma("journal_mode = DELETE");
  createSchema(database);
  seedBase(database);
  return {
    database,
    databasePath,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function commissionerInput(overrides = {}) {
  return {
    leagueId: PRIMARY.leagueId,
    fadId: PRIMARY.fadId,
    viewerUserId: PRIMARY.commissionerUserId,
    viewerMembershipId:
      PRIMARY.commissionerMembershipId,
    viewerAuthority: "commissioner",
    nowMs: NOW_MS,
    ...overrides,
  };
}

function sha256File(filePath) {
  return createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function semanticHash(database) {
  const tables = database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()
    .map(({ name }) => name);
  const state = tables.map((tableName) => ({
    tableName,
    rows: database
      .prepare(
        `SELECT * FROM "${tableName.replaceAll('"', '""')}"`
      )
      .all()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            Buffer.isBuffer(value)
              ? { base64: value.toString("base64") }
              : value,
          ])
        )
      ),
  }));
  return createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");
}

describe("FAD-11 SQLite recovery-read repository", () => {
  test("prepares every read against the real schema migrated through 50", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-fad-recovery-schema-")
    );
    const connection = openDatabase({
      databasePath: path.join(directory, "schema.sqlite"),
    });
    try {
      const state = migrateDatabase({
        database: connection.database,
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        applicationBuildId:
          "fad-11-recovery-read-schema-foundation",
      });
      assert.equal(state.userVersion, 50);
      assert.doesNotThrow(() =>
        createSqliteFreeAgentDraftRecoveryReadRepository({
          database: connection.database,
        })
      );
    } finally {
      connection.database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("projects actual durable resources with exact disabled capabilities and zero writes", () => {
    const state = fixture();
    try {
      const beforeBytes = sha256File(state.databasePath);
      const beforeSemantic = semanticHash(state.database);
      const repository =
        createSqliteFreeAgentDraftRecoveryReadRepository({
          database: state.database,
        });

      const result = repository.readRecovery(
        commissionerInput()
      );

      assert.deepEqual(Object.keys(result), [
        "fad",
        "deadlineOperation",
        "allocationOperations",
        "rapidOperations",
        "completionOperation",
        "rollovers",
        "recoveries",
        "availableActions",
      ]);
      assert.equal(result.rollovers.length, 7);
      assert.equal(result.deadlineOperation.operationId,
        PRIMARY.deadlineJobId);
      assert.equal(result.completionOperation, null);
      assert.deepEqual(
        result.availableActions.map((action) => [
          action.action,
          action.resourceId,
          action.enabled,
          action.reasonCode,
        ]),
        [
          [
            "retry_deadline",
            null,
            false,
            "RECOVERY_NOT_AVAILABLE",
          ],
          ...Array.from({ length: 7 }, (_, index) => [
            "finalize_rollover",
            uuid(61 + index),
            false,
            "RECOVERY_NOT_AVAILABLE",
          ]),
        ]
      );
      assert.equal(
        sha256File(state.databasePath),
        beforeBytes,
        "a recovery read must preserve exact database bytes"
      );
      assert.equal(
        semanticHash(state.database),
        beforeSemantic,
        "a recovery read must preserve semantic database state"
      );
    } finally {
      state.close();
    }
  });

  test("revalidates active commissioner and inherited member-admin authority from current DB state", () => {
    const state = fixture();
    try {
      const repository =
        createSqliteFreeAgentDraftRecoveryReadRepository({
          database: state.database,
        });
      const administratorResult = repository.readRecovery(
        commissionerInput({
          viewerUserId: PRIMARY.administratorUserId,
          viewerMembershipId:
            PRIMARY.administratorMembershipId,
          viewerAuthority:
            "platform_administrator_as_commissioner",
        })
      );
      assert.equal(
        administratorResult.fad.fadId,
        PRIMARY.fadId
      );

      assert.throws(
        () =>
          repository.readRecovery(
            commissionerInput({
              viewerUserId: PRIMARY.memberUserId,
              viewerMembershipId:
                PRIMARY.memberMembershipId,
            })
          ),
        {
          code:
            FREE_AGENT_DRAFT_RECOVERY_READ_REPOSITORY_CODES
              .authorizationDenied,
        }
      );
      state.database
        .prepare(`
          UPDATE league_memberships
          SET ended_at_ms = @endedAtMs
          WHERE id = @membershipId
            AND status = 'active'
        `)
        .run({
          endedAtMs: NOW_MS,
          membershipId: PRIMARY.commissionerMembershipId,
        });
      const endedMembershipBytes = sha256File(
        state.databasePath
      );
      const endedMembershipSemantic = semanticHash(
        state.database
      );
      assert.throws(
        () => repository.readRecovery(commissionerInput()),
        {
          code:
            FREE_AGENT_DRAFT_RECOVERY_READ_REPOSITORY_CODES
              .authorizationDenied,
        }
      );
      assert.equal(
        sha256File(state.databasePath),
        endedMembershipBytes
      );
      assert.equal(
        semanticHash(state.database),
        endedMembershipSemantic
      );

      state.database
        .prepare(`
          UPDATE league_memberships
          SET ended_at_ms = NULL
          WHERE id = @membershipId
            AND status = 'active'
        `)
        .run({
          membershipId: PRIMARY.commissionerMembershipId,
        });
      assert.equal(
        repository.readRecovery(commissionerInput()).fad.fadId,
        PRIMARY.fadId
      );

      state.database
        .prepare(`
          UPDATE platform_roles
          SET ended_at_ms = @endedAtMs
          WHERE id = @roleId
            AND status = 'active'
        `)
        .run({
          endedAtMs: NOW_MS,
          roleId: PRIMARY.administratorRoleId,
        });
      const endedRoleBytes = sha256File(state.databasePath);
      const endedRoleSemantic = semanticHash(state.database);
      assert.throws(
        () =>
          repository.readRecovery(
            commissionerInput({
              viewerUserId: PRIMARY.administratorUserId,
              viewerMembershipId:
                PRIMARY.administratorMembershipId,
              viewerAuthority:
                "platform_administrator_as_commissioner",
            })
          ),
        {
          code:
            FREE_AGENT_DRAFT_RECOVERY_READ_REPOSITORY_CODES
              .authorizationDenied,
        }
      );
      assert.equal(
        sha256File(state.databasePath),
        endedRoleBytes
      );
      assert.equal(
        semanticHash(state.database),
        endedRoleSemantic
      );

      state.database
        .prepare(`
          UPDATE platform_roles
          SET status = 'ended'
          WHERE id = @roleId
        `)
        .run({ roleId: PRIMARY.administratorRoleId });
      insert(state.database, "platform_roles", {
        id: PRIMARY.administratorReplacementRoleId,
        user_id: PRIMARY.administratorUserId,
        role: "platform_administrator",
        status: "active",
        ended_at_ms: null,
      });
      const replacementBeforeBytes = sha256File(
        state.databasePath
      );
      const replacementBeforeSemantic = semanticHash(
        state.database
      );
      const replacement = repository.readRecovery(
        commissionerInput({
          viewerUserId: PRIMARY.administratorUserId,
          viewerMembershipId:
            PRIMARY.administratorMembershipId,
          viewerAuthority:
            "platform_administrator_as_commissioner",
        })
      );
      assert.equal(replacement.fad.fadId, PRIMARY.fadId);
      assert.equal(
        JSON.stringify(replacement).includes(PRIVATE_SENTINEL),
        false
      );
      assert.equal(
        sha256File(state.databasePath),
        replacementBeforeBytes
      );
      assert.equal(
        semanticHash(state.database),
        replacementBeforeSemantic
      );
    } finally {
      state.close();
    }
  });

  test("does not disclose a FAD that belongs to another league", () => {
    const state = fixture();
    try {
      const repository =
        createSqliteFreeAgentDraftRecoveryReadRepository({
          database: state.database,
        });
      assert.throws(
        () =>
          repository.readRecovery(
            commissionerInput({ fadId: SECONDARY.fadId })
          ),
        { code: REPOSITORY_ERROR_CODES.recordNotFound }
      );
    } finally {
      state.close();
    }
  });

  test("redacts a queued nomination player while exposing only its queue action, and reveals it after objective invalidation", () => {
    const state = fixture();
    try {
      seedQueuedRecovery(state.database);
      const repository =
        createSqliteFreeAgentDraftRecoveryReadRepository({
          database: state.database,
        });
      const queued = repository.readRecovery(
        commissionerInput()
      );
      const recovery = queued.recoveries[0];
      assert.equal(recovery.playerId, null);
      assert.equal(
        recovery.nominationQueueId,
        PRIMARY.queueId
      );
      assert.deepEqual(
        queued.availableActions.find(
          ({ action }) =>
            action === "activate_queued_nomination"
        ),
        {
          action: "activate_queued_nomination",
          resourceId: PRIMARY.queueId,
          enabled: true,
          reasonCode: null,
        }
      );
      const serialized = JSON.stringify(queued);
      assert.equal(serialized.includes(PRIMARY.playerId), false);
      assert.equal(serialized.includes(PRIVATE_SENTINEL), false);

      state.database
        .prepare(
          "UPDATE free_agent_draft_nomination_queue SET status='invalid' WHERE id=?"
        )
        .run(PRIMARY.queueId);
      const invalidated = repository.readRecovery(
        commissionerInput()
      );
      assert.equal(
        invalidated.recoveries[0].playerId,
        PRIMARY.playerId
      );
    } finally {
      state.close();
    }
  });

  test("keeps resolved retry history and binds each capability to the latest recovery", () => {
    const state = fixture();
    try {
      seedQueuedRecovery(state.database, {
        historicalResolved: true,
      });
      const result =
        createSqliteFreeAgentDraftRecoveryReadRepository({
          database: state.database,
        }).readRecovery(commissionerInput());

      assert.deepEqual(
        result.recoveries.map(({ recoveryId, status }) => [
          recoveryId,
          status,
        ]),
        [
          [PRIMARY.historicalRecoveryId, "resolved"],
          [PRIMARY.recoveryId, "pending"],
        ]
      );
      assert.equal(
        result.rapidOperations[0].recoveryId,
        PRIMARY.recoveryId
      );
    } finally {
      state.close();
    }
  });

  test("verifies sealed completion schedule evidence and projects only durable replacement pairs", () => {
    const state = fixture();
    try {
      const evidence = seedScheduleRecovery(state.database);
      const repository =
        createSqliteFreeAgentDraftRecoveryReadRepository({
          database: state.database,
        });
      const result = repository.readRecovery(
        commissionerInput({
          nowMs: evidence.completedAtMs + 1,
        })
      );
      assert.deepEqual(result.scheduleRecoveryEvidence, {
        operationId: evidence.newScheduleOperationId,
        status: "succeeded",
        oldWeek1StartsAtMs: WEEK_ONE_AT_MS,
        newWeek1StartsAtMs: evidence.newWeekOneAtMs,
        oldScheduleVersion: 1,
        newScheduleVersion: 2,
        removedWeekIds: [PRIMARY.weekId],
        removedMatchupIds: [],
        replacedJobs: [
          {
            oldJobId: evidence.oldReplacedJobId,
            oldOccurrenceKey: "matchup:old-lock:1",
            newJobId: evidence.newReplacedJobId,
            newOccurrenceKey: "matchup:new-lock:1",
          },
        ],
        completedAtMs: evidence.completedAtMs,
        version: 1,
      });
      assert.equal(
        JSON.stringify(result).includes(
          "matchup:old-publish:1"
        ),
        false
      );

      stateUpdate(
        state.database,
        `UPDATE free_agent_draft_schedule_recoveries
            SET evidence_sha256=@digest
          WHERE id=@recoveryId`,
        {
          digest: "0".repeat(64),
          recoveryId: evidence.recoveryId,
        }
      );
      assert.throws(
        () =>
          repository.readRecovery(
            commissionerInput({
              nowMs: evidence.completedAtMs + 1,
            })
          ),
        { code: REPOSITORY_ERROR_CODES.schemaIncompatible }
      );
    } finally {
      state.close();
    }
  });

  test("fails closed on duplicate active recoveries and corrupt occurrence evidence", () => {
    for (const corruption of [
      "duplicate_active_recovery",
      "occurrence_key",
    ]) {
      const state = fixture();
      try {
        seedQueuedRecovery(state.database);
        if (corruption === "duplicate_active_recovery") {
          insertRecovery(state.database, {
            id: uuid(220),
            status: "ready",
            createdAtMs:
              DEADLINE_AT_MS +
              FREE_AGENT_DRAFT_DAY_MS +
              10,
            resolvedAtMs: null,
          });
        } else {
          state.database
            .prepare(
              "UPDATE job_runs SET occurrence_key=? WHERE id=?"
            )
            .run(
              `fad:${PRIMARY.fadId}:complete`,
              PRIMARY.queueJobId
            );
        }
        const repository =
          createSqliteFreeAgentDraftRecoveryReadRepository({
            database: state.database,
          });
        assert.throws(
          () => repository.readRecovery(commissionerInput()),
          { code: REPOSITORY_ERROR_CODES.schemaIncompatible }
        );
      } finally {
        state.close();
      }
    }
  });
});
