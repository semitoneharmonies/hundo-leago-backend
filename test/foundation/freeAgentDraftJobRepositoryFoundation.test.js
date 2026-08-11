const assert = require("node:assert/strict");
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
  buildFreeAgentDraftEligibilityOccurrenceKey,
  buildFreeAgentDraftFallbackActivationOccurrenceKey,
  buildFreeAgentDraftNominationOpenOccurrenceKey,
  buildFreeAgentDraftReadinessOccurrenceKey,
  buildFreeAgentDraftReminderOccurrenceKey,
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftReadinessRetryReceipt,
  createFreeAgentDraftReadinessRetryRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE,
  FREE_AGENT_DRAFT_JOB_TYPES,
  FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES,
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const DAY_MS = 86_400_000;
const DEADLINE_AT_MS = Date.parse(
  "2027-09-01T07:00:00.000Z"
);
const OPENED_AT_MS =
  DEADLINE_AT_MS - 5 * DAY_MS;
const ELIGIBILITY_APPLIED_AT_MS =
  OPENED_AT_MS + 1;
const NOW_MS = DEADLINE_AT_MS + 7 * DAY_MS;
const READINESS_STARTED_AT_MS =
  OPENED_AT_MS + 1_000;
const READINESS_LEASE_EXPIRES_AT_MS =
  READINESS_STARTED_AT_MS + 60_000;
const READINESS_BLOCKED_AT_MS =
  READINESS_LEASE_EXPIRES_AT_MS + 1;
const READINESS_RETRY_AT_MS =
  READINESS_BLOCKED_AT_MS + 1_000;

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  readinessOperation: uuid(4),
  rootReadinessOperation: uuid(23),
  readinessTrigger: uuid(5),
  sourceOperation: uuid(6),
  readinessJob: uuid(10),
  eligibilityJob: uuid(11),
  reminderJob: uuid(12),
  deadlineJob: uuid(13),
  allocationJob: uuid(14),
  restrictedJob: uuid(15),
  fallbackJob: uuid(16),
  nominationJob: uuid(17),
  rolloverJob: uuid(18),
  completionJob: uuid(19),
  malformedJob: uuid(20),
  malformedTrigger: uuid(21),
  eligibilityOccurrence: uuid(24),
  eligibilitySourceBefore: uuid(25),
  eligibilitySourceAfter: uuid(26),
  eligibilityPlayer: uuid(30),
  allocationPlayer: uuid(31),
  restrictedPlayer: uuid(32),
  fallbackPlayer: uuid(33),
  nominationPlayer: uuid(34),
  otherPlayer: uuid(35),
  allocation: uuid(40),
  restrictedAllocation: uuid(41),
  fallbackAllocation: uuid(42),
  restrictedAuction: uuid(50),
  fallbackAuction: uuid(51),
  nominationQueue: uuid(60),
  otherLeague: uuid(90),
  otherSeason: uuid(91),
  otherFad: uuid(92),
  leaseOne: uuid(93),
  leaseTwo: uuid(94),
  commissionerUser: uuid(101),
  commissionerMembership: uuid(102),
  administratorUser: uuid(103),
  administratorMembership: uuid(104),
  administratorRole: uuid(105),
  administratorOtherMembership: uuid(106),
  memberUser: uuid(107),
  memberMembership: uuid(108),
  outsiderAdministratorUser: uuid(109),
  outsiderAdministratorRole: uuid(110),
  administratorReplacementMembership:
    uuid(112),
  retryIdempotency: uuid(120),
  retryReceipt: uuid(121),
});

const ROLLOVER_IDS = Object.freeze(
  Array.from(
    { length: 7 },
    (_, index) => uuid(70 + index)
  )
);

const READINESS_OCCURRENCE_KEY =
  buildFreeAgentDraftReadinessOccurrenceKey({
    leagueId: IDS.league,
    seasonId: IDS.season,
    triggerResourceId: IDS.season,
  });
const READINESS_BLOCKER = Object.freeze({
  code: "TEAM_MANAGER_MISSING",
  field: null,
  resourceType: "team",
  resourceId: uuid(100),
  message:
    "A participating team needs an active manager.",
});
const READINESS_BLOCKERS_JSON =
  serializeCanonicalJsonV1([READINESS_BLOCKER]);
const ELIGIBILITY_DELTA_SHA256 = "a".repeat(64);
const CATALOG_REQUEST_SHA256 = "b".repeat(64);

function catalogEventDetails(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    code: "PLAYER_CATALOG_APPLIED",
    sourceOperationId: IDS.sourceOperation,
    provider: "sportsdataio-discovery-lab",
    capturedAtMs:
      ELIGIBILITY_APPLIED_AT_MS - 1,
    appliedAtMs: ELIGIBILITY_APPLIED_AT_MS,
    requestSha256: CATALOG_REQUEST_SHA256,
    rowCount: 1,
    createdPlayerCount: 0,
    updatedPlayerCount: 0,
    sourceStateChangeCount: 1,
    eligibilityChangedPlayerCount: 1,
    eligibilityRevalidationOccurrenceCount: 1,
    ...overrides,
  });
}

function rolloverAt(sequence) {
  return (
    DEADLINE_AT_MS + sequence * DAY_MS
  );
}

const JOBS = Object.freeze([
  Object.freeze({
    id: IDS.readinessJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .readiness,
    occurrenceKey:
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: IDS.league,
        seasonId: IDS.season,
        triggerResourceId:
          IDS.readinessTrigger,
      }),
    scheduledForMs: OPENED_AT_MS,
  }),
  Object.freeze({
    id: IDS.eligibilityJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .eligibility_revalidate,
    occurrenceKey:
      buildFreeAgentDraftEligibilityOccurrenceKey({
        fadId: IDS.fad,
        playerId: IDS.eligibilityPlayer,
        sourceOperationId:
          IDS.sourceOperation,
      }),
    scheduledForMs:
      ELIGIBILITY_APPLIED_AT_MS,
  }),
  Object.freeze({
    id: IDS.reminderJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .reminder,
    occurrenceKey:
      buildFreeAgentDraftReminderOccurrenceKey({
        fadId: IDS.fad,
        reminderAtMs:
          DEADLINE_AT_MS - 3 * DAY_MS,
      }),
    scheduledForMs:
      DEADLINE_AT_MS - 3 * DAY_MS,
  }),
  Object.freeze({
    id: IDS.deadlineJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .deadline,
    occurrenceKey:
      buildFreeAgentDraftDeadlineOccurrenceKey({
        fadId: IDS.fad,
        deadlineAtMs: DEADLINE_AT_MS,
      }),
    scheduledForMs: DEADLINE_AT_MS,
  }),
  Object.freeze({
    id: IDS.allocationJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .allocate,
    occurrenceKey:
      buildFreeAgentDraftAllocationOccurrenceKey({
        fadId: IDS.fad,
        playerId: IDS.allocationPlayer,
      }),
    scheduledForMs: DEADLINE_AT_MS,
  }),
  Object.freeze({
    id: IDS.restrictedJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .restricted_activate,
    occurrenceKey:
      buildFreeAgentDraftRestrictedActivationOccurrenceKey({
        fadId: IDS.fad,
        allocationId:
          IDS.restrictedAllocation,
        activationAtMs: rolloverAt(1),
      }),
    scheduledForMs: rolloverAt(1),
  }),
  Object.freeze({
    id: IDS.fallbackJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .fallback_activate,
    occurrenceKey:
      buildFreeAgentDraftFallbackActivationOccurrenceKey({
        fadId: IDS.fad,
        allocationId:
          IDS.fallbackAllocation,
        activationAtMs: rolloverAt(2),
      }),
    scheduledForMs: rolloverAt(2),
  }),
  Object.freeze({
    id: IDS.nominationJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .nomination_open,
    occurrenceKey:
      buildFreeAgentDraftNominationOpenOccurrenceKey({
        fadId: IDS.fad,
        queueId: IDS.nominationQueue,
        rolloverAtMs: rolloverAt(4),
      }),
    scheduledForMs: rolloverAt(4),
  }),
  Object.freeze({
    id: IDS.rolloverJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .rollover,
    occurrenceKey:
      buildFreeAgentDraftRolloverOccurrenceKey({
        fadId: IDS.fad,
        sequence: 5,
        rolloverAtMs: rolloverAt(5),
      }),
    scheduledForMs: rolloverAt(5),
  }),
  Object.freeze({
    id: IDS.completionJob,
    type:
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
        .complete,
    occurrenceKey:
      buildFreeAgentDraftCompletionOccurrenceKey({
        fadId: IDS.fad,
      }),
    scheduledForMs: rolloverAt(7),
  }),
]);

function createSchema(database) {
  database.exec(`
    CREATE TABLE leagues (
      id TEXT PRIMARY KEY,
      current_season_id TEXT
    ) STRICT;

    CREATE TABLE seasons (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE players (
      id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TABLE operational_events (
      id TEXT PRIMARY KEY,
      league_id TEXT,
      season_id TEXT,
      event_type TEXT NOT NULL,
      feature TEXT NOT NULL,
      outcome TEXT NOT NULL,
      actor_user_id TEXT,
      reason_code TEXT,
      details_json TEXT,
      occurred_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE idempotency_requests (
      id TEXT PRIMARY KEY,
      league_id TEXT,
      actor_user_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      result_type TEXT,
      result_id TEXT,
      created_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER
    ) STRICT;

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
      lease_expires_at_ms INTEGER,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      result_json TEXT,
      last_error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      lease_token TEXT,
      next_attempt_at_ms INTEGER,
      UNIQUE (league_id, job_type, occurrence_key)
    ) STRICT;

    CREATE TABLE free_agent_draft_readiness_operations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      readiness_occurrence_key TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      entry_draft_id TEXT,
      setup_exemption_id TEXT,
      job_run_id TEXT,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at_ms INTEGER,
      blockers_json TEXT NOT NULL DEFAULT '[]',
      matchup_schedule_version_before INTEGER,
      matchup_schedule_version_after INTEGER,
      schedule_recovery_id TEXT,
      created_fad_id TEXT,
      reminder_job_run_id TEXT,
      deadline_job_run_id TEXT,
      cards_opened_activity_id TEXT,
      cards_opened_outbox_event_id TEXT,
      started_at_ms INTEGER,
      next_retry_at_ms INTEGER,
      terminal_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE TABLE free_agent_drafts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      readiness_operation_id TEXT NOT NULL,
      readiness_occurrence_key TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      candidate_deadline_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE free_agent_draft_eligibility_revalidation_occurrences (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      source_operation_id TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      player_version_before INTEGER NOT NULL,
      player_version_after INTEGER NOT NULL,
      player_status_before TEXT NOT NULL,
      player_status_after TEXT NOT NULL,
      source_state_before_id TEXT,
      source_state_after_id TEXT NOT NULL,
      source_resolved_position_group_before TEXT,
      source_resolved_position_group_after TEXT,
      league_position_override_id TEXT,
      effective_position_group_before TEXT,
      effective_position_group_after TEXT,
      eligibility_delta_sha256 TEXT NOT NULL,
      job_run_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE free_agent_draft_rollovers (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      window_kind TEXT NOT NULL,
      predecessor_rollover_id TEXT,
      opens_at_ms INTEGER NOT NULL,
      creation_cutoff_at_ms INTEGER NOT NULL,
      rolls_over_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      processing_job_run_id TEXT
    ) STRICT;

    CREATE TABLE free_agent_draft_player_allocations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      status TEXT NOT NULL,
      restricted_auction_id TEXT,
      fallback_open_auction_id TEXT,
      UNIQUE (league_id, season_id, fad_id, player_id)
    ) STRICT;

    CREATE TABLE auctions (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      resolves_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE auction_contexts (
      auction_id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      fad_id TEXT,
      fad_rollover_id TEXT,
      fad_allocation_id TEXT,
      fad_origin TEXT
    ) STRICT;

    CREATE TABLE free_agent_draft_nomination_queue (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      source_rollover_id TEXT NOT NULL,
      target_opening_rollover_id TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE free_agent_draft_recoveries (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT,
      allocation_id TEXT,
      rollover_id TEXT,
      auction_id TEXT,
      job_run_id TEXT,
      kind TEXT NOT NULL,
      earliest_activation_at_ms INTEGER
    ) STRICT;
  `);
}

function seed(database) {
  database
    .prepare(`
      INSERT INTO leagues (
        id,
        current_season_id
      ) VALUES (?, ?)
    `)
    .run(IDS.league, IDS.season);
  database
    .prepare(`
      INSERT INTO seasons (
        id,
        league_id
      ) VALUES (?, ?)
    `)
    .run(IDS.season, IDS.league);

  const insertPlayer = database.prepare(
    "INSERT INTO players (id) VALUES (?)"
  );
  for (const playerId of [
    IDS.eligibilityPlayer,
    IDS.allocationPlayer,
    IDS.restrictedPlayer,
    IDS.fallbackPlayer,
    IDS.nominationPlayer,
    IDS.otherPlayer,
  ]) {
    insertPlayer.run(playerId);
  }

  database
    .prepare(`
      INSERT INTO operational_events (
        id,
        league_id,
        season_id,
        event_type,
        feature,
        outcome,
        actor_user_id,
        reason_code,
        details_json,
        occurred_at_ms
      ) VALUES (
        ?, NULL, NULL,
        'player_catalog_applied',
        'player_data_provider',
        'succeeded', NULL,
        'provider_catalog_import', ?, ?
      )
    `)
    .run(
      IDS.sourceOperation,
      catalogEventDetails(),
      ELIGIBILITY_APPLIED_AT_MS
    );

  const readinessOccurrence =
    JOBS[0].occurrenceKey;
  database
    .prepare(`
      INSERT INTO free_agent_draft_readiness_operations (
        id,
        league_id,
        season_id,
        readiness_occurrence_key,
        trigger_kind,
        entry_draft_id,
        setup_exemption_id,
        job_run_id,
        status,
        attempt_count,
        lease_owner,
        lease_token,
        lease_expires_at_ms,
        blockers_json,
        matchup_schedule_version_before,
        matchup_schedule_version_after,
        schedule_recovery_id,
        created_fad_id,
        reminder_job_run_id,
        deadline_job_run_id,
        cards_opened_activity_id,
        cards_opened_outbox_event_id,
        started_at_ms,
        next_retry_at_ms,
        terminal_at_ms,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?, ?, ?, ?,
        'entry_draft_completed',
        ?, NULL, ?, 'pending', 0,
        NULL, NULL, NULL, '[]',
        NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL,
        ?, ?, 1
      )
    `)
    .run(
      IDS.readinessOperation,
      IDS.league,
      IDS.season,
      readinessOccurrence,
      IDS.readinessTrigger,
      IDS.readinessJob,
      OPENED_AT_MS,
      OPENED_AT_MS
    );
  database
    .prepare(`
      INSERT INTO free_agent_draft_readiness_operations (
        id,
        league_id,
        season_id,
        readiness_occurrence_key,
        trigger_kind,
        entry_draft_id,
        setup_exemption_id,
        job_run_id,
        status,
        attempt_count,
        lease_owner,
        lease_token,
        lease_expires_at_ms,
        blockers_json,
        matchup_schedule_version_before,
        matchup_schedule_version_after,
        schedule_recovery_id,
        created_fad_id,
        reminder_job_run_id,
        deadline_job_run_id,
        cards_opened_activity_id,
        cards_opened_outbox_event_id,
        started_at_ms,
        next_retry_at_ms,
        terminal_at_ms,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?, ?, ?, ?,
        'entry_draft_completed',
        ?, NULL, NULL, 'succeeded', 1,
        NULL, NULL, NULL, '[]',
        NULL, NULL, NULL, ?, ?, ?,
        NULL, NULL, ?, NULL, ?, ?, ?, 3
      )
    `)
    .run(
      IDS.rootReadinessOperation,
      IDS.league,
      IDS.season,
      readinessOccurrence,
      IDS.readinessTrigger,
      IDS.fad,
      IDS.reminderJob,
      IDS.deadlineJob,
      OPENED_AT_MS,
      OPENED_AT_MS,
      OPENED_AT_MS,
      OPENED_AT_MS
    );
  database
    .prepare(`
      INSERT INTO free_agent_drafts (
        id,
        league_id,
        season_id,
        readiness_operation_id,
        readiness_occurrence_key,
        opened_at_ms,
        candidate_deadline_at_ms,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'rapid')
    `)
    .run(
      IDS.fad,
      IDS.league,
      IDS.season,
      IDS.rootReadinessOperation,
      readinessOccurrence,
      OPENED_AT_MS,
      DEADLINE_AT_MS
    );

  const insertRollover = database.prepare(`
    INSERT INTO free_agent_draft_rollovers (
      id,
      league_id,
      season_id,
      fad_id,
      sequence,
      window_kind,
      predecessor_rollover_id,
      opens_at_ms,
      creation_cutoff_at_ms,
      rolls_over_at_ms,
      status,
      processing_job_run_id
    ) VALUES (
      ?, ?, ?, ?, ?, 'initial', ?, ?, ?, ?,
      'scheduled', NULL
    )
  `);
  for (
    let sequence = 1;
    sequence <= 7;
    sequence += 1
  ) {
    const rollsOverAtMs =
      rolloverAt(sequence);
    insertRollover.run(
      ROLLOVER_IDS[sequence - 1],
      IDS.league,
      IDS.season,
      IDS.fad,
      sequence,
      sequence === 1
        ? null
        : ROLLOVER_IDS[sequence - 2],
      rollsOverAtMs - DAY_MS,
      rollsOverAtMs - 3_600_000,
      rollsOverAtMs
    );
  }

  const insertAllocation =
    database.prepare(`
      INSERT INTO free_agent_draft_player_allocations (
        id,
        league_id,
        season_id,
        fad_id,
        player_id,
        status,
        restricted_auction_id,
        fallback_open_auction_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  insertAllocation.run(
    IDS.allocation,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.allocationPlayer,
    "pending",
    null,
    null
  );
  insertAllocation.run(
    IDS.restrictedAllocation,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.restrictedPlayer,
    "restricted_scheduled",
    IDS.restrictedAuction,
    null
  );
  insertAllocation.run(
    IDS.fallbackAllocation,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.fallbackPlayer,
    "restricted_fallback_open",
    null,
    IDS.fallbackAuction
  );

  const insertAuction = database.prepare(`
    INSERT INTO auctions (
      id,
      league_id,
      season_id,
      player_id,
      opened_at_ms,
      resolves_at_ms,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, 'open')
  `);
  insertAuction.run(
    IDS.restrictedAuction,
    IDS.league,
    IDS.season,
    IDS.restrictedPlayer,
    rolloverAt(1),
    rolloverAt(2)
  );
  insertAuction.run(
    IDS.fallbackAuction,
    IDS.league,
    IDS.season,
    IDS.fallbackPlayer,
    rolloverAt(2),
    rolloverAt(3)
  );

  const insertContext = database.prepare(`
    INSERT INTO auction_contexts (
      auction_id,
      league_id,
      season_id,
      source_kind,
      fad_id,
      fad_rollover_id,
      fad_allocation_id,
      fad_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertContext.run(
    IDS.restrictedAuction,
    IDS.league,
    IDS.season,
    "fad_restricted",
    IDS.fad,
    ROLLOVER_IDS[1],
    IDS.restrictedAllocation,
    "candidate_tie_restricted"
  );
  insertContext.run(
    IDS.fallbackAuction,
    IDS.league,
    IDS.season,
    "fad_open_rapid",
    IDS.fad,
    ROLLOVER_IDS[2],
    IDS.fallbackAllocation,
    "restricted_no_improvement_fallback"
  );

  database
    .prepare(`
      INSERT INTO free_agent_draft_nomination_queue (
        id,
        league_id,
        season_id,
        fad_id,
        player_id,
        source_rollover_id,
        target_opening_rollover_id,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
    `)
    .run(
      IDS.nominationQueue,
      IDS.league,
      IDS.season,
      IDS.fad,
      IDS.nominationPlayer,
      ROLLOVER_IDS[3],
      ROLLOVER_IDS[3]
    );

  const insertJob = database.prepare(`
    INSERT INTO job_runs (
      id,
      league_id,
      season_id,
      job_type,
      occurrence_key,
      scheduled_for_ms,
      status,
      attempt_count,
      lease_owner,
      lease_expires_at_ms,
      started_at_ms,
      completed_at_ms,
      result_json,
      last_error_code,
      created_at_ms,
      updated_at_ms,
      version,
      lease_token,
      next_attempt_at_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 'pending', 0,
      NULL, NULL, NULL, NULL, NULL, NULL,
      ?, ?, 1, NULL, NULL
    )
  `);
  for (const job of JOBS) {
    const createdAtMs =
      job.id === IDS.eligibilityJob
        ? ELIGIBILITY_APPLIED_AT_MS
        : OPENED_AT_MS;
    insertJob.run(
      job.id,
      IDS.league,
      IDS.season,
      job.type,
      job.occurrenceKey,
      job.scheduledForMs,
      createdAtMs,
      createdAtMs
    );
  }
  database
    .prepare(`
      INSERT INTO free_agent_draft_eligibility_revalidation_occurrences (
        id,
        league_id,
        season_id,
        fad_id,
        player_id,
        source_operation_id,
        source_provider,
        player_version_before,
        player_version_after,
        player_status_before,
        player_status_after,
        source_state_before_id,
        source_state_after_id,
        source_resolved_position_group_before,
        source_resolved_position_group_after,
        league_position_override_id,
        effective_position_group_before,
        effective_position_group_after,
        eligibility_delta_sha256,
        job_run_id,
        occurrence_key,
        scheduled_for_ms,
        created_at_ms,
        version
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        'sportsdataio-discovery-lab',
        1, 1, 'active', 'active',
        ?, ?, 'F', 'D', NULL,
        'F', 'D', ?, ?, ?, ?, ?, 1
      )
    `)
    .run(
      IDS.eligibilityOccurrence,
      IDS.league,
      IDS.season,
      IDS.fad,
      IDS.eligibilityPlayer,
      IDS.sourceOperation,
      IDS.eligibilitySourceBefore,
      IDS.eligibilitySourceAfter,
      ELIGIBILITY_DELTA_SHA256,
      IDS.eligibilityJob,
      JOBS[1].occurrenceKey,
      ELIGIBILITY_APPLIED_AT_MS,
      ELIGIBILITY_APPLIED_AT_MS
    );
}

function fixture(t, beforeCommit) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad-job-repository-"
    )
  );
  const databasePath = path.join(
    root,
    "test.sqlite3"
  );
  let connection = openDatabase({
    databasePath,
    environment: "test",
  });
  createSchema(connection.database);
  seed(connection.database);
  let repository =
    createSqliteFreeAgentDraftJobRepository({
      database: connection.database,
      beforeCommit,
    });

  const state = {
    get database() {
      return connection.database;
    },
    get repository() {
      return repository;
    },
    reopen() {
      connection.database.close();
      connection = openDatabase({
        databasePath,
        environment: "test",
      });
      repository =
        createSqliteFreeAgentDraftJobRepository({
          database: connection.database,
          beforeCommit,
        });
    },
  };
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return state;
}

function insertRow(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns
          .map((column) => `@${column}`)
          .join(", ")}
      )
    `)
    .run(values);
}

function seedMigratedReadinessIdentity(
  database
) {
  insertRow(database, "leagues", {
    id: IDS.league,
    name: "Readiness Claim League",
    name_normalized:
      "readiness claim league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insertRow(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  insertRow(database, "leagues", {
    id: IDS.otherLeague,
    name: "Other Readiness Claim League",
    name_normalized:
      "other readiness claim league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insertRow(database, "seasons", {
    id: IDS.otherSeason,
    league_id: IDS.otherLeague,
    label: "2026-27 Other",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  for (const [id, email, displayName] of [
    [
      IDS.commissionerUser,
      "readiness-commissioner@example.test",
      "Readiness Commissioner",
    ],
    [
      IDS.administratorUser,
      "readiness-administrator@example.test",
      "Readiness Administrator",
    ],
    [
      IDS.memberUser,
      "readiness-member@example.test",
      "Readiness Member",
    ],
    [
      IDS.outsiderAdministratorUser,
      "readiness-outsider@example.test",
      "Readiness Outsider",
    ],
  ]) {
    insertRow(database, "users", {
      id,
      email_normalized: email,
      email_display: email,
      display_name: displayName,
      display_name_normalized:
        displayName.toLowerCase(),
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }
  for (const membership of [
    {
      id: IDS.commissionerMembership,
      league_id: IDS.league,
      user_id: IDS.commissionerUser,
      permission_category: "commissioner",
    },
    {
      id: IDS.administratorMembership,
      league_id: IDS.league,
      user_id: IDS.administratorUser,
      permission_category: "member",
    },
    {
      id: IDS.administratorOtherMembership,
      league_id: IDS.otherLeague,
      user_id: IDS.administratorUser,
      permission_category: "member",
    },
    {
      id: IDS.memberMembership,
      league_id: IDS.league,
      user_id: IDS.memberUser,
      permission_category: "member",
    },
  ]) {
    insertRow(database, "league_memberships", {
      ...membership,
      status: "active",
      joined_at_ms: 1,
      ended_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }
  for (const role of [
    {
      id: IDS.administratorRole,
      user_id: IDS.administratorUser,
    },
    {
      id: IDS.outsiderAdministratorRole,
      user_id: IDS.outsiderAdministratorUser,
    },
  ]) {
    insertRow(database, "platform_roles", {
      ...role,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: null,
      granted_at_ms: 1,
      ended_at_ms: null,
      version: 1,
    });
  }
  database
    .prepare(`
      UPDATE leagues
      SET current_season_id = ?,
          commissioner_membership_id = ?
      WHERE id = ?
    `)
    .run(
      IDS.season,
      IDS.commissionerMembership,
      IDS.league
    );
  database
    .prepare(`
      UPDATE leagues
      SET current_season_id = ?
      WHERE id = ?
    `)
    .run(
      IDS.otherSeason,
      IDS.otherLeague
    );
}

function migratedReadinessRows(
  state,
  {
    jobOverrides = {},
    readinessOverrides = {},
  } = {}
) {
  const pendingJob = {
    id: IDS.readinessJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: "fad_readiness",
    occurrence_key:
      READINESS_OCCURRENCE_KEY,
    scheduled_for_ms: OPENED_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: null,
  };
  const pendingReadiness = {
    id: IDS.readinessOperation,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_occurrence_key:
      READINESS_OCCURRENCE_KEY,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: IDS.readinessJob,
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
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  };

  let job = pendingJob;
  let readiness = pendingReadiness;
  if (state === "blocked_retry") {
    job = {
      ...pendingJob,
      attempt_count: 1,
      next_attempt_at_ms:
        READINESS_RETRY_AT_MS,
      updated_at_ms: READINESS_RETRY_AT_MS,
      version: 4,
    };
    readiness = {
      ...pendingReadiness,
      status: "blocked",
      attempt_count: 1,
      blockers_json: READINESS_BLOCKERS_JSON,
      matchup_schedule_version_before: null,
      matchup_schedule_version_after: null,
      started_at_ms: READINESS_STARTED_AT_MS,
      next_retry_at_ms:
        READINESS_RETRY_AT_MS,
      terminal_at_ms: READINESS_BLOCKED_AT_MS,
      updated_at_ms: READINESS_RETRY_AT_MS,
      version: 4,
    };
  } else if (state === "failed") {
    job = {
      ...pendingJob,
      status: "failed",
      attempt_count: 1,
      started_at_ms: READINESS_STARTED_AT_MS,
      completed_at_ms: READINESS_BLOCKED_AT_MS,
      last_error_code: "FAD_READINESS_BLOCKED",
      next_attempt_at_ms:
        READINESS_RETRY_AT_MS,
      updated_at_ms: READINESS_BLOCKED_AT_MS,
      version: 3,
    };
    readiness = {
      ...pendingReadiness,
      status: "blocked",
      attempt_count: 1,
      blockers_json: READINESS_BLOCKERS_JSON,
      matchup_schedule_version_before: null,
      matchup_schedule_version_after: null,
      started_at_ms: READINESS_STARTED_AT_MS,
      next_retry_at_ms:
        READINESS_RETRY_AT_MS,
      terminal_at_ms: READINESS_BLOCKED_AT_MS,
      updated_at_ms: READINESS_BLOCKED_AT_MS,
      version: 3,
    };
  } else if (
    state === "running" ||
    state === "live_running"
  ) {
    const leaseExpiresAtMs =
      state === "live_running"
        ? READINESS_LEASE_EXPIRES_AT_MS +
          1_000
        : READINESS_LEASE_EXPIRES_AT_MS;
    job = {
      ...pendingJob,
      status: "running",
      attempt_count: 1,
      lease_owner: "readiness-worker-old",
      lease_token: IDS.leaseOne,
      lease_expires_at_ms: leaseExpiresAtMs,
      started_at_ms: READINESS_STARTED_AT_MS,
      updated_at_ms: READINESS_STARTED_AT_MS,
      version: 2,
    };
    readiness = {
      ...pendingReadiness,
      status: "running",
      attempt_count: 1,
      lease_owner: "readiness-worker-old",
      lease_token: IDS.leaseOne,
      lease_expires_at_ms: leaseExpiresAtMs,
      matchup_schedule_version_before: 2,
      matchup_schedule_version_after: 2,
      started_at_ms: READINESS_STARTED_AT_MS,
      updated_at_ms: READINESS_STARTED_AT_MS,
      version: 2,
    };
  } else if (state !== "pending") {
    throw new Error(
      `Unknown migrated readiness state: ${state}`
    );
  }

  return {
    job: {
      ...job,
      ...jobOverrides,
    },
    readiness: {
      ...readiness,
      ...readinessOverrides,
    },
  };
}

function migratedReadinessFixture(
  t,
  {
    state = "pending",
    jobOverrides,
    readinessOverrides,
    beforeCommit,
  } = {}
) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad-readiness-claim-"
    )
  );
  const databasePath = path.join(
    root,
    "test.sqlite3"
  );
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: path.resolve(
      "database/migrations"
    ),
    applicationBuildId:
      "fad-readiness-claim-foundation",
    now: () => 1,
  });
  seedMigratedReadinessIdentity(
    connection.database
  );
  const rows = migratedReadinessRows(
    state,
    {
      jobOverrides,
      readinessOverrides,
    }
  );
  insertRow(
    connection.database,
    "job_runs",
    rows.job
  );
  insertRow(
    connection.database,
    "free_agent_draft_readiness_operations",
    rows.readiness
  );
  return {
    database: connection.database,
    repository:
      createSqliteFreeAgentDraftJobRepository({
        database: connection.database,
        beforeCommit,
      }),
  };
}

function readMigratedReadinessPair(database) {
  return {
    job: database
      .prepare(`
        SELECT *
        FROM job_runs
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.readinessJob),
    readiness: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `)
      .get(
        IDS.league,
        IDS.readinessOperation
      ),
  };
}

function readinessClaimCommand(
  overrides = {}
) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: null,
    runId: IDS.readinessJob,
    jobType: "fad_readiness",
    occurrenceKey:
      READINESS_OCCURRENCE_KEY,
    scheduledForMs: OPENED_AT_MS,
    expectedVersion: 1,
    leaseOwner: "readiness-worker-new",
    leaseToken: IDS.leaseTwo,
    nowMs: READINESS_STARTED_AT_MS,
    leaseExpiresAtMs:
      READINESS_STARTED_AT_MS + 120_000,
    ...overrides,
  };
}

function readinessRetryPublicCommand(
  overrides = {}
) {
  const {
    body: bodyOverrides = {},
    ...commandOverrides
  } = overrides;
  return {
    leagueId: IDS.league,
    actorUserId: IDS.commissionerUser,
    actorMembershipId:
      IDS.commissionerMembership,
    expectedVersion: 3,
    clientKey: "fad-readiness-retry",
    body: {
      seasonId: IDS.season,
      readinessOperationId:
        IDS.readinessOperation,
      confirmation:
        "RETRY FREE AGENT DRAFT READINESS",
      ...bodyOverrides,
    },
    ...commandOverrides,
  };
}

function readinessRetryCommand(
  overrides = {}
) {
  const {
    body: bodyOverrides = {},
    ...commandOverrides
  } = overrides;
  return {
    ...readinessRetryPublicCommand({
      ...commandOverrides,
      body: bodyOverrides,
    }),
    acceptedAtMs: READINESS_RETRY_AT_MS,
    idempotencyExpiresAtMs:
      READINESS_RETRY_AT_MS + DAY_MS,
    idempotencyRequestId:
      IDS.retryIdempotency,
    retryReceiptId: IDS.retryReceipt,
    ...commandOverrides,
    body: {
      seasonId: IDS.season,
      readinessOperationId:
        IDS.readinessOperation,
      confirmation:
        "RETRY FREE AGENT DRAFT READINESS",
      ...bodyOverrides,
    },
  };
}

function expectedReadinessRetryReceipt(
  command,
  actorAuthority = "commissioner"
) {
  const request =
    createFreeAgentDraftReadinessRetryRequest({
      actorUserId: command.actorUserId,
      body: command.body,
      clientKey: command.clientKey,
      expectedVersion:
        command.expectedVersion,
      leagueId: command.leagueId,
    });
  return createFreeAgentDraftReadinessRetryReceipt({
    acceptedAtMs: command.acceptedAtMs,
    acceptedFromVersion:
      command.expectedVersion,
    actorAuthority,
    actorMembershipId:
      command.actorMembershipId,
    actorUserId: command.actorUserId,
    id: command.retryReceiptId,
    idempotencyRequestId:
      command.idempotencyRequestId,
    jobRunId: IDS.readinessJob,
    leagueId: command.leagueId,
    occurrenceKey:
      READINESS_OCCURRENCE_KEY,
    readinessOperationId:
      command.body.readinessOperationId,
    requestSha256: request.requestSha256,
    resultingReadinessVersion:
      command.expectedVersion + 1,
    retryAttemptNumber: 2,
    seasonId: command.body.seasonId,
  });
}

function readinessRetryReceiptRow(receipt) {
  return {
    id: receipt.id,
    league_id: receipt.leagueId,
    season_id: receipt.seasonId,
    readiness_operation_id:
      receipt.readinessOperationId,
    idempotency_request_id:
      receipt.idempotencyRequestId,
    actor_user_id: receipt.actorUserId,
    actor_membership_id:
      receipt.actorMembershipId,
    actor_authority:
      receipt.actorAuthority,
    request_sha256: receipt.requestSha256,
    accepted_from_version:
      receipt.acceptedFromVersion,
    resulting_readiness_version:
      receipt.resultingReadinessVersion,
    retry_attempt_number:
      receipt.retryAttemptNumber,
    job_run_id: receipt.jobRunId,
    occurrence_key: receipt.occurrenceKey,
    accepted_at_ms: receipt.acceptedAtMs,
    response_http_status:
      receipt.responseHttpStatus,
    response_json: receipt.responseJson,
    response_sha256: receipt.responseSha256,
    version: receipt.version,
  };
}

function assertReadinessRetryResult(
  result,
  receipt,
  replayed
) {
  assert.deepEqual(result, {
    replayed,
    httpStatus: 202,
    data: receipt.data,
    evidence: receipt,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    Object.isFrozen(result.data),
    true
  );
  assert.equal(
    Object.isFrozen(result.evidence),
    true
  );
}

function readReadinessRetryState(database) {
  return {
    pair: readMigratedReadinessPair(database),
    attempts: database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_attempts
      WHERE league_id = ?
        AND readiness_operation_id = ?
      ORDER BY attempt_number, id
    `).all(
      IDS.league,
      IDS.readinessOperation
    ),
    receipts: database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_retry_receipts
      WHERE league_id = ?
      ORDER BY id
    `).all(IDS.league),
    idempotency: database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE operation =
        'free_agent_draft.readiness.retry.v1'
      ORDER BY id
    `).all(),
  };
}

function assertRetryRepositoryError(
  callback,
  {
    code,
    details,
  }
) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    if (details === undefined) {
      assert.equal(error.details, undefined);
    } else {
      assert.deepEqual(
        error.details,
        details
      );
      assert.equal(
        Object.isFrozen(error.details),
        true
      );
    }
    return true;
  });
}

function assertReadinessRetryAuthorizationDeniedWithoutWrites({
  database,
  repository,
  publicCommand,
  writeCommand,
}) {
  const before = readReadinessRetryState(database);
  const changesBefore = totalChanges(database);
  for (const action of [
    () =>
      repository.findReadinessRetryReplay(publicCommand),
    () => repository.requeueReadiness(writeCommand),
  ]) {
    assertRetryRepositoryError(action, {
      code:
        FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES
          .authorizationDenied,
    });
  }
  assert.deepEqual(readReadinessRetryState(database), before);
  assert.equal(totalChanges(database), changesBefore);
}

function installReadinessRetryAbort(
  database,
  seam
) {
  const definitions = {
    idempotencyStarted: `
      BEFORE INSERT ON idempotency_requests
    `,
    jobPending: `
      BEFORE UPDATE ON job_runs
    `,
    receiptInserted: `
      BEFORE INSERT ON
        free_agent_draft_readiness_retry_receipts
    `,
    operationAdvanced: `
      BEFORE UPDATE ON
        free_agent_draft_readiness_operations
    `,
    idempotencyCompleted: `
      BEFORE UPDATE ON idempotency_requests
    `,
  };
  assert.ok(definitions[seam]);
  database.exec(`
    CREATE TEMP TRIGGER
      test_readiness_retry_${seam}
    ${definitions[seam]}
    BEGIN
      SELECT RAISE(
        ABORT,
        'injected readiness retry ${seam}'
      );
    END
  `);
}

function totalChanges(database) {
  return database
    .prepare(
      "SELECT total_changes() AS changes"
    )
    .get().changes;
}

function claimCommand(
  occurrence,
  overrides = {}
) {
  return {
    leagueId: occurrence.leagueId,
    seasonId: occurrence.seasonId,
    fadId: occurrence.fadId,
    runId: occurrence.runId,
    jobType: occurrence.jobType,
    occurrenceKey:
      occurrence.occurrenceKey,
    scheduledForMs:
      occurrence.scheduledForMs,
    expectedVersion:
      occurrence.version,
    leaseOwner: "fad-worker-1",
    leaseToken: IDS.leaseOne,
    nowMs: NOW_MS,
    leaseExpiresAtMs: NOW_MS + 60_000,
    ...overrides,
  };
}

function mutationCommand(
  occurrence,
  overrides = {}
) {
  return {
    leagueId: occurrence.leagueId,
    seasonId: occurrence.seasonId,
    fadId: occurrence.fadId,
    runId: occurrence.runId,
    jobType: occurrence.jobType,
    occurrenceKey:
      occurrence.occurrenceKey,
    scheduledForMs:
      occurrence.scheduledForMs,
    expectedVersion:
      occurrence.version,
    leaseOwner: "fad-worker-1",
    leaseToken: IDS.leaseOne,
    completedAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function byType(occurrences, type) {
  return occurrences.find(
    (occurrence) =>
      occurrence.parsedOccurrence.type ===
      type
  );
}

describe(
  "SQLite Free Agent Draft job repository",
  () => {
    test("prepares read-only against the complete current migration", (t) => {
      const root = fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "hundo-fad-job-current-schema-"
        )
      );
      const connection = openDatabase({
        databasePath: path.join(
          root,
          "current.sqlite3"
        ),
        environment: "test",
      });
      t.after(() => {
        if (connection.database.open) {
          connection.database.close();
        }
        fs.rmSync(root, {
          recursive: true,
          force: true,
        });
      });
      migrateDatabase({
        database: connection.database,
        migrationsDirectory: path.resolve(
          "database/migrations"
        ),
        applicationBuildId:
          "fad-job-repository-foundation",
        now: () => 1,
      });
      const repository =
        createSqliteFreeAgentDraftJobRepository({
          database: connection.database,
        });
      const before = totalChanges(
        connection.database
      );
      assert.deepEqual(
        repository.listDue({
          nowMs: NOW_MS,
        }),
        []
      );
      assert.equal(
        totalChanges(connection.database),
        before
      );
    });

    test("discovers every approved occurrence binding in scheduler order without writes", (t) => {
      const { database, repository } =
        fixture(t);
      const before = totalChanges(database);
      const due = repository.listDue({
        nowMs: NOW_MS,
        limit: 100,
      });
      assert.equal(due.length, 10);
      assert.deepEqual(
        due.map(
          (occurrence) =>
            occurrence.jobType
        ),
        FREE_AGENT_DRAFT_JOB_TYPES
      );
      assert.deepEqual(
        due.map(
          (occurrence) =>
            occurrence.parsedOccurrence.type
        ),
        [
          "readiness",
          "eligibility_revalidate",
          "reminder",
          "deadline",
          "allocate",
          "restricted_activate",
          "fallback_activate",
          "nomination_open",
          "rollover",
          "complete",
        ]
      );
      assert.equal(due[0].fadId, null);
      assert.equal(
        due[0].binding.resourceId,
        IDS.readinessOperation
      );
      assert.equal(
        byType(due, "allocate").binding
          .allocationId,
        IDS.allocation
      );
      assert.deepEqual(
        byType(
          due,
          "eligibility_revalidate"
        ).binding,
        {
          type: "eligibility_revalidate",
          resourceType:
            "eligibility_revalidation_occurrence",
          resourceId:
            IDS.eligibilityOccurrence,
          fadId: IDS.fad,
          occurrenceId:
            IDS.eligibilityOccurrence,
          playerId: IDS.eligibilityPlayer,
          sourceOperationId:
            IDS.sourceOperation,
          sourceOperationEventType:
            "player_catalog_applied",
          sourceOperationOccurredAtMs:
            ELIGIBILITY_APPLIED_AT_MS,
          sourceProvider:
            "sportsdataio-discovery-lab",
          playerVersionBefore: 1,
          playerVersionAfter: 1,
          playerStatusBefore: "active",
          playerStatusAfter: "active",
          sourceStateBeforeId:
            IDS.eligibilitySourceBefore,
          sourceStateAfterId:
            IDS.eligibilitySourceAfter,
          sourceResolvedPositionGroupBefore:
            "F",
          sourceResolvedPositionGroupAfter:
            "D",
          leaguePositionOverrideId: null,
          effectivePositionGroupBefore: "F",
          effectivePositionGroupAfter: "D",
          eligibilityDeltaSha256:
            ELIGIBILITY_DELTA_SHA256,
        }
      );
      assert.equal(
        byType(due, "restricted_activate")
          .binding.auctionId,
        IDS.restrictedAuction
      );
      assert.equal(
        byType(due, "fallback_activate")
          .binding.auctionId,
        IDS.fallbackAuction
      );
      assert.equal(
        byType(due, "nomination_open")
          .binding.queueId,
        IDS.nominationQueue
      );
      assert.equal(
        byType(due, "rollover").binding
          .rolloverId,
        ROLLOVER_IDS[4]
      );
      assert.equal(
        byType(due, "complete").binding
          .initialWindowEndsAtMs,
        rolloverAt(7)
      );
      assert.equal(
        repository.listDue({
          nowMs: NOW_MS,
          limit: 3,
        }).length,
        3
      );
      assert.equal(totalChanges(database), before);
      assert.equal(Object.isFrozen(due), true);
      assert.equal(
        Object.isFrozen(due[0].binding),
        true
      );
    });

    test("excludes correction-required failed work until an exact pending retry is scheduled", (t) => {
      const { database, repository } = fixture(t);
      const nomination = byType(
        repository.listDue({
          nowMs: NOW_MS,
          limit: 100,
        }),
        "nomination_open"
      );
      const claimed = repository.claim(
        claimCommand(nomination)
      ).occurrence;
      const failedAtMs = NOW_MS + 1;
      assert.equal(
        database.prepare(`
          UPDATE job_runs
          SET status = 'failed',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at_ms = NULL,
              completed_at_ms = @failedAtMs,
              result_json = NULL,
              last_error_code =
                'FAD_QUEUED_NOMINATION_ACTIVATION_FAILED',
              next_attempt_at_ms = NULL,
              updated_at_ms = @failedAtMs,
              version = version + 1
          WHERE league_id = @leagueId
            AND id = @runId
            AND status = 'running'
            AND version = @expectedVersion
        `).run({
          failedAtMs,
          leagueId: IDS.league,
          runId: IDS.nominationJob,
          expectedVersion: claimed.version,
        }).changes,
        1
      );

      const blocked = repository.listDue({
        nowMs: failedAtMs + DAY_MS,
        limit: 100,
      });
      assert.equal(blocked.length, 9);
      assert.equal(
        byType(blocked, "nomination_open"),
        undefined
      );

      const retryAtMs = failedAtMs + 1;
      assert.equal(
        database.prepare(`
          UPDATE job_runs
          SET status = 'pending',
              started_at_ms = NULL,
              completed_at_ms = NULL,
              last_error_code = NULL,
              next_attempt_at_ms = @retryAtMs,
              updated_at_ms = @retryAtMs,
              version = version + 1
          WHERE league_id = @leagueId
            AND id = @runId
            AND status = 'failed'
            AND next_attempt_at_ms IS NULL
        `).run({
          retryAtMs,
          leagueId: IDS.league,
          runId: IDS.nominationJob,
        }).changes,
        1
      );
      const retried = byType(
        repository.listDue({
          nowMs: retryAtMs,
          limit: 100,
        }),
        "nomination_open"
      );
      assert.equal(retried.status, "pending");
      assert.equal(retried.attemptCount, 1);
      assert.equal(retried.nextAttemptAtMs, retryAtMs);
      const reclaimed = repository.claim(
        claimCommand(retried, {
          nowMs: retryAtMs,
          leaseExpiresAtMs: retryAtMs + 60_000,
        })
      );
      assert.equal(reclaimed.acquired, true);
      assert.equal(reclaimed.occurrence.status, "running");
      assert.equal(reclaimed.occurrence.attemptCount, 2);
    });

    test("fails visibly and blocks later valid work when an earlier ordered row is malformed", (t) => {
      const { database, repository } =
        fixture(t);
      const malformedOccurrence =
        buildFreeAgentDraftReadinessOccurrenceKey({
          leagueId: IDS.league,
          seasonId: IDS.season,
          triggerResourceId:
            IDS.malformedTrigger,
        });
      database
        .prepare(`
          INSERT INTO job_runs (
            id,
            league_id,
            season_id,
            job_type,
            occurrence_key,
            scheduled_for_ms,
            status,
            attempt_count,
            lease_owner,
            lease_expires_at_ms,
            started_at_ms,
            completed_at_ms,
            result_json,
            last_error_code,
            created_at_ms,
            updated_at_ms,
            version,
            lease_token,
            next_attempt_at_ms
          ) VALUES (
            ?, ?, ?, ?, ?, ?, 'pending', 0,
            NULL, NULL, NULL, NULL, NULL, NULL,
            ?, ?, 1, NULL, NULL
          )
        `)
        .run(
          IDS.malformedJob,
          IDS.league,
          IDS.season,
          FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
            .readiness,
          malformedOccurrence,
          OPENED_AT_MS - 1,
          OPENED_AT_MS,
          OPENED_AT_MS
        );
      const before = totalChanges(database);
      assert.throws(
        () =>
          repository.listDue({
            nowMs: NOW_MS,
            limit: 1,
          }),
        (error) =>
          error?.code ===
            "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
          error.message ===
            "A due FAD job has invalid persisted lifecycle or source binding." &&
          error.details?.runId ===
            IDS.malformedJob &&
          error.details?.jobType ===
            FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
              .readiness &&
          error.details?.occurrenceKey ===
            malformedOccurrence &&
          error.details?.schedulerBlocked ===
            true &&
          JSON.stringify(
            error.details
              ?.blockedValidRunIds
          ) ===
            JSON.stringify([
              IDS.readinessJob,
            ])
      );
      assert.equal(totalChanges(database), before);

      database
        .prepare(
          "DELETE FROM job_runs WHERE id = ?"
        )
        .run(IDS.malformedJob);
      const due = repository.listDue({
        nowMs: NOW_MS,
        limit: 1,
      });
      assert.equal(due.length, 1);
      assert.equal(
        due[0].runId,
        IDS.readinessJob
      );
    });

    test("accepts and restart-replays eligibility only with the exact durable migration-0036 occurrence", (t) => {
      const state = fixture(t);
      const first = byType(
        state.repository.listDue({
          nowMs: NOW_MS,
          limit: 100,
        }),
        "eligibility_revalidate"
      );
      assert.equal(
        first.binding.sourceOperationId,
        IDS.sourceOperation
      );
      assert.equal(
        first.binding.occurrenceId,
        IDS.eligibilityOccurrence
      );

      state.reopen();
      const replayed = byType(
        state.repository.listDue({
          nowMs: NOW_MS,
          limit: 100,
        }),
        "eligibility_revalidate"
      );
      assert.deepEqual(replayed, first);
    });

    test("claims eligibility with the exact sealed occurrence binding and shared lease CAS", (t) => {
      const { repository } = fixture(t);
      const due = byType(
        repository.listDue({
          nowMs: NOW_MS,
          limit: 100,
        }),
        "eligibility_revalidate"
      );
      const claimed = repository.claim(
        claimCommand(due)
      );
      assert.equal(claimed.acquired, true);
      assert.equal(
        claimed.occurrence.status,
        "running"
      );
      assert.equal(claimed.occurrence.version, 2);
      assert.equal(
        claimed.occurrence.attemptCount,
        1
      );
      assert.deepEqual(
        claimed.occurrence.binding,
        due.binding
      );
    });

    test("accepts an exact sealed catalog provider without staging-specific provider literals", (t) => {
      const { database, repository } =
        fixture(t);
      const productionProvider =
        "sportsdataio-live";
      database
        .prepare(`
          UPDATE free_agent_draft_eligibility_revalidation_occurrences
          SET source_provider = ?
          WHERE id = ?
        `)
        .run(
          productionProvider,
          IDS.eligibilityOccurrence
        );
      database
        .prepare(`
          UPDATE operational_events
          SET details_json = ?
          WHERE id = ?
        `)
        .run(
          catalogEventDetails({
            provider: productionProvider,
          }),
          IDS.sourceOperation
        );

      const eligibility = byType(
        repository.listDue({
          nowMs: NOW_MS,
          limit: 100,
        }),
        "eligibility_revalidate"
      );
      assert.equal(
        eligibility.binding
          .sourceOperationEventType,
        "player_catalog_applied"
      );
      assert.equal(
        eligibility.binding.sourceProvider,
        productionProvider
      );
    });

    test("rejects missing, mismatched, or tampered occurrence and sealed catalog evidence", (t) => {
      function assertBlocked(state) {
        assert.throws(
          () =>
            state.repository.listDue({
              nowMs: NOW_MS,
              limit: 100,
            }),
          (error) =>
            error?.code ===
              "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
            error.details?.runId ===
              IDS.eligibilityJob
        );
      }

      const missing = fixture(t);
      missing.database
        .prepare(`
          DELETE FROM free_agent_draft_eligibility_revalidation_occurrences
          WHERE id = ?
        `)
        .run(IDS.eligibilityOccurrence);
      assertBlocked(missing);

      const mismatched = fixture(t);
      mismatched.database
        .prepare(`
          UPDATE free_agent_draft_eligibility_revalidation_occurrences
          SET player_id = ?
          WHERE id = ?
        `)
        .run(
          IDS.otherPlayer,
          IDS.eligibilityOccurrence
        );
      assertBlocked(mismatched);

      const tamperedOccurrence = fixture(t);
      tamperedOccurrence.database
        .prepare(`
          UPDATE free_agent_draft_eligibility_revalidation_occurrences
          SET effective_position_group_after = 'F'
          WHERE id = ?
        `)
        .run(IDS.eligibilityOccurrence);
      assertBlocked(tamperedOccurrence);

      const failed = fixture(t);
      failed.database
        .prepare(`
          UPDATE operational_events
          SET outcome = 'failed'
          WHERE id = ?
        `)
        .run(IDS.sourceOperation);
      assertBlocked(failed);

      const crossScoped = fixture(t);
      crossScoped.database
        .prepare(`
          UPDATE operational_events
          SET league_id = ?,
              season_id = ?
          WHERE id = ?
        `)
        .run(
          IDS.otherLeague,
          IDS.otherSeason,
          IDS.sourceOperation
        );
      assertBlocked(crossScoped);

      const later = fixture(t);
      later.database
        .prepare(`
          UPDATE operational_events
          SET occurred_at_ms = ?
          WHERE id = ?
        `)
        .run(
          ELIGIBILITY_APPLIED_AT_MS + 1,
          IDS.sourceOperation
        );
      assertBlocked(later);

      const malformed = fixture(t);
      malformed.database
        .prepare(`
          UPDATE operational_events
          SET details_json = '{'
          WHERE id = ?
        `)
        .run(IDS.sourceOperation);
      assertBlocked(malformed);

      const wrongProvider = fixture(t);
      wrongProvider.database
        .prepare(`
          UPDATE operational_events
          SET details_json = ?
          WHERE id = ?
        `)
        .run(
          catalogEventDetails({
            provider: "wrong-provider",
          }),
          IDS.sourceOperation
        );
      assertBlocked(wrongProvider);
    });

    test("claims exactly, protects a live lease, reclaims only at expiry, and stores canonical success", (t) => {
      const { database, repository } =
        fixture(t);
      const allocation = byType(
        repository.listDue({
          nowMs: NOW_MS,
          limit: 100,
        }),
        "allocate"
      );
      const first = repository.claim(
        claimCommand(allocation)
      );
      assert.equal(first.acquired, true);
      assert.equal(
        first.occurrence.status,
        "running"
      );
      assert.equal(first.occurrence.version, 2);
      assert.equal(
        first.occurrence.attemptCount,
        1
      );

      const live = repository.claim(
        claimCommand(first.occurrence, {
          expectedVersion: 2,
          leaseOwner: "fad-worker-2",
          leaseToken: IDS.leaseTwo,
          nowMs: NOW_MS + 59_999,
          leaseExpiresAtMs:
            NOW_MS + 120_000,
        })
      );
      assert.equal(live.acquired, false);

      assert.throws(
        () =>
          repository.succeed(
            mutationCommand(
              first.occurrence,
              {
                leaseToken: IDS.leaseTwo,
                result: { outcome: "wrong" },
              }
            )
          ),
        (error) =>
          error?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      assert.throws(
        () =>
          repository.succeed(
            mutationCommand(
              first.occurrence,
              {
                completedAtMs:
                  NOW_MS + 60_000,
                result: { outcome: "late" },
              }
            )
          ),
        (error) =>
          error?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );

      const reclaimed = repository.claim(
        claimCommand(first.occurrence, {
          expectedVersion: 2,
          leaseOwner: "fad-worker-2",
          leaseToken: IDS.leaseTwo,
          nowMs: NOW_MS + 60_000,
          leaseExpiresAtMs:
            NOW_MS + 120_000,
        })
      );
      assert.equal(reclaimed.acquired, true);
      assert.equal(reclaimed.occurrence.version, 3);
      assert.equal(
        reclaimed.occurrence.attemptCount,
        2
      );
      assert.equal(
        reclaimed.occurrence.startedAtMs,
        NOW_MS + 60_000
      );

      assert.throws(
        () =>
          repository.succeed(
            mutationCommand(
              reclaimed.occurrence,
              {
                expectedVersion: 2,
                leaseOwner: "fad-worker-2",
                leaseToken: IDS.leaseTwo,
                completedAtMs:
                  NOW_MS + 60_001,
                result: { outcome: "stale" },
              }
            )
          ),
        (error) =>
          error?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      const succeeded = repository.succeed(
        mutationCommand(
          reclaimed.occurrence,
          {
            leaseOwner: "fad-worker-2",
            leaseToken: IDS.leaseTwo,
            completedAtMs:
              NOW_MS + 60_001,
            result: {
              zeta: 2,
              alpha: "complete",
            },
          }
        )
      );
      assert.equal(succeeded.status, "succeeded");
      assert.equal(succeeded.version, 4);
      assert.equal(
        succeeded.resultJson,
        '{"alpha":"complete","zeta":2}'
      );
      assert.equal(
        repository
          .listDue({
            nowMs: NOW_MS + 120_000,
            limit: 100,
          })
          .some(
            (occurrence) =>
              occurrence.runId ===
              IDS.allocationJob
          ),
        false
      );
      const terminal = repository.claim(
        claimCommand(succeeded, {
          expectedVersion: 4,
          leaseOwner: "fad-worker-3",
          leaseToken: uuid(95),
          nowMs: NOW_MS + 120_000,
          leaseExpiresAtMs:
            NOW_MS + 180_000,
        })
      );
      assert.equal(terminal.acquired, false);
      assert.equal(
        terminal.occurrence.status,
        "succeeded"
      );
      assert.deepEqual(
        database.pragma("integrity_check"),
        [{ integrity_check: "ok" }]
      );
    });

    test("atomically claims one pending readiness job and operation with an exact execution binding", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t);
      const claim = readinessClaimCommand();
      const result = repository.claim(claim);

      assert.equal(result.acquired, true);
      assert.equal(
        result.occurrence.status,
        "running"
      );
      assert.equal(
        result.occurrence.attemptCount,
        1
      );
      assert.equal(result.occurrence.version, 2);
      assert.deepEqual(
        result.occurrence.binding
          .readinessExecution,
        {
          operationId:
            IDS.readinessOperation,
          status: "running",
          attemptCount: 1,
          leaseExpiresAtMs:
            claim.leaseExpiresAtMs,
          startedAtMs: claim.nowMs,
          updatedAtMs: claim.nowMs,
          version: 2,
        }
      );

      const pair =
        readMigratedReadinessPair(database);
      assert.deepEqual(
        {
          status: pair.job.status,
          attemptCount:
            pair.job.attempt_count,
          leaseOwner: pair.job.lease_owner,
          leaseToken: pair.job.lease_token,
          leaseExpiresAtMs:
            pair.job.lease_expires_at_ms,
          startedAtMs: pair.job.started_at_ms,
          updatedAtMs: pair.job.updated_at_ms,
          version: pair.job.version,
        },
        {
          status: "running",
          attemptCount: 1,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
          leaseExpiresAtMs:
            claim.leaseExpiresAtMs,
          startedAtMs: claim.nowMs,
          updatedAtMs: claim.nowMs,
          version: 2,
        }
      );
      assert.deepEqual(
        {
          status: pair.readiness.status,
          attemptCount:
            pair.readiness.attempt_count,
          leaseOwner:
            pair.readiness.lease_owner,
          leaseToken:
            pair.readiness.lease_token,
          leaseExpiresAtMs:
            pair.readiness
              .lease_expires_at_ms,
          blockersJson:
            pair.readiness.blockers_json,
          startedAtMs:
            pair.readiness.started_at_ms,
          updatedAtMs:
            pair.readiness.updated_at_ms,
          version: pair.readiness.version,
        },
        {
          status: "running",
          attemptCount: 1,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
          leaseExpiresAtMs:
            claim.leaseExpiresAtMs,
          blockersJson: "[]",
          startedAtMs: claim.nowMs,
          updatedAtMs: claim.nowMs,
          version: 2,
        }
      );
      assert.equal(
        pair.job.version,
        pair.readiness.version
      );
      assert.equal(
        database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_readiness_attempts
            WHERE league_id = ?
              AND readiness_operation_id = ?
          `)
          .get(
            IDS.league,
            IDS.readinessOperation
          ).count,
        0
      );
    });

    test("claims a clean blocked readiness retry only at its accepted instant", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t, {
          state: "blocked_retry",
        });
      const before =
        readMigratedReadinessPair(database);
      const early = repository.claim(
        readinessClaimCommand({
          expectedVersion: 4,
          nowMs: READINESS_RETRY_AT_MS - 1,
          leaseExpiresAtMs:
            READINESS_RETRY_AT_MS + 60_000,
        })
      );
      assert.equal(early.acquired, false);
      assert.deepEqual(
        readMigratedReadinessPair(database),
        before
      );

      const claim = readinessClaimCommand({
        expectedVersion: 4,
        nowMs: READINESS_RETRY_AT_MS,
        leaseExpiresAtMs:
          READINESS_RETRY_AT_MS + 60_000,
      });
      const result = repository.claim(claim);
      assert.equal(result.acquired, true);
      assert.equal(
        result.occurrence.attemptCount,
        2
      );
      assert.equal(result.occurrence.version, 5);
      assert.deepEqual(
        result.occurrence.binding
          .readinessExecution,
        {
          operationId:
            IDS.readinessOperation,
          status: "running",
          attemptCount: 2,
          leaseExpiresAtMs:
            claim.leaseExpiresAtMs,
          startedAtMs: claim.nowMs,
          updatedAtMs: claim.nowMs,
          version: 5,
        }
      );

      const pair =
        readMigratedReadinessPair(database);
      assert.equal(pair.job.status, "running");
      assert.equal(
        pair.readiness.status,
        "running"
      );
      assert.equal(pair.job.attempt_count, 2);
      assert.equal(
        pair.readiness.attempt_count,
        2
      );
      assert.equal(
        pair.job.started_at_ms,
        READINESS_RETRY_AT_MS
      );
      assert.equal(
        pair.readiness.started_at_ms,
        READINESS_RETRY_AT_MS
      );
      assert.equal(
        pair.job.lease_owner,
        claim.leaseOwner
      );
      assert.equal(
        pair.readiness.lease_owner,
        claim.leaseOwner
      );
      assert.equal(
        pair.job.lease_token,
        claim.leaseToken
      );
      assert.equal(
        pair.readiness.lease_token,
        claim.leaseToken
      );
      assert.equal(
        pair.readiness.blockers_json,
        "[]"
      );
      assert.equal(
        pair.job.next_attempt_at_ms,
        null
      );
      assert.equal(
        pair.readiness.next_retry_at_ms,
        null
      );
      assert.equal(
        pair.readiness.terminal_at_ms,
        null
      );
      assert.equal(pair.job.version, 5);
      assert.equal(pair.readiness.version, 5);
    });

    test("excludes a failed readiness job and refuses a direct claim without a write", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t, {
          state: "failed",
        });
      const before =
        readMigratedReadinessPair(database);
      assert.deepEqual(
        repository.listDue({
          nowMs: READINESS_RETRY_AT_MS,
          limit: 100,
        }),
        []
      );
      const result = repository.claim(
        readinessClaimCommand({
          expectedVersion: 3,
          nowMs: READINESS_RETRY_AT_MS,
          leaseExpiresAtMs:
            READINESS_RETRY_AT_MS + 60_000,
        })
      );
      assert.equal(result.acquired, false);
      assert.deepEqual(
        readMigratedReadinessPair(database),
        before
      );
    });

    test("protects a live readiness lease and reclaims exactly at expiry with one retained attempt", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t, {
          state: "running",
        });
      const original =
        readMigratedReadinessPair(database);
      const live = repository.claim(
        readinessClaimCommand({
          expectedVersion: 2,
          nowMs:
            READINESS_LEASE_EXPIRES_AT_MS -
            1,
          leaseExpiresAtMs:
            READINESS_LEASE_EXPIRES_AT_MS +
            60_000,
        })
      );
      assert.equal(live.acquired, false);
      assert.deepEqual(
        readMigratedReadinessPair(database),
        original
      );

      const reused = repository.claim(
        readinessClaimCommand({
          expectedVersion: 2,
          leaseToken: IDS.leaseOne,
          nowMs:
            READINESS_LEASE_EXPIRES_AT_MS,
          leaseExpiresAtMs:
            READINESS_LEASE_EXPIRES_AT_MS +
            60_000,
        })
      );
      assert.equal(reused.acquired, false);
      assert.deepEqual(
        readMigratedReadinessPair(database),
        original
      );

      const claim = readinessClaimCommand({
        expectedVersion: 2,
        nowMs: READINESS_LEASE_EXPIRES_AT_MS,
        leaseExpiresAtMs:
          READINESS_LEASE_EXPIRES_AT_MS +
          60_000,
      });
      const result = repository.claim(claim);
      assert.equal(result.acquired, true);
      assert.equal(
        result.occurrence.attemptCount,
        1
      );
      assert.equal(result.occurrence.version, 3);
      assert.equal(
        result.occurrence.startedAtMs,
        READINESS_STARTED_AT_MS
      );
      assert.deepEqual(
        result.occurrence.binding
          .readinessExecution,
        {
          operationId:
            IDS.readinessOperation,
          status: "running",
          attemptCount: 1,
          leaseExpiresAtMs:
            claim.leaseExpiresAtMs,
          startedAtMs:
            READINESS_STARTED_AT_MS,
          updatedAtMs: claim.nowMs,
          version: 3,
        }
      );

      const reclaimed =
        readMigratedReadinessPair(database);
      assert.equal(
        reclaimed.job.attempt_count,
        original.job.attempt_count
      );
      assert.equal(
        reclaimed.readiness.attempt_count,
        original.readiness.attempt_count
      );
      assert.equal(
        reclaimed.job.started_at_ms,
        original.job.started_at_ms
      );
      assert.equal(
        reclaimed.readiness.started_at_ms,
        original.readiness.started_at_ms
      );
      assert.equal(
        reclaimed.job.lease_owner,
        claim.leaseOwner
      );
      assert.equal(
        reclaimed.readiness.lease_owner,
        claim.leaseOwner
      );
      assert.equal(
        reclaimed.job.lease_token,
        claim.leaseToken
      );
      assert.equal(
        reclaimed.readiness.lease_token,
        claim.leaseToken
      );
      assert.equal(
        reclaimed.job.version,
        original.job.version + 1
      );
      assert.equal(
        reclaimed.readiness.version,
        original.readiness.version + 1
      );
      assert.equal(
        reclaimed.job.version,
        reclaimed.readiness.version
      );
      for (const field of [
        "blockers_json",
        "matchup_schedule_version_before",
        "matchup_schedule_version_after",
        "schedule_recovery_id",
        "created_fad_id",
        "reminder_job_run_id",
        "deadline_job_run_id",
        "cards_opened_activity_id",
        "cards_opened_outbox_event_id",
        "next_retry_at_ms",
        "terminal_at_ms",
      ]) {
        assert.equal(
          reclaimed.readiness[field],
          original.readiness[field],
          field
        );
      }
      assert.equal(
        database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_readiness_attempts
            WHERE league_id = ?
              AND readiness_operation_id = ?
          `)
          .get(
            IDS.league,
            IDS.readinessOperation
          ).count,
        0
      );

      const beforeStaleCompletion =
        readMigratedReadinessPair(database);
      assert.throws(
        () =>
          repository.fail({
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: null,
            runId: IDS.readinessJob,
            jobType: "fad_readiness",
            occurrenceKey:
              READINESS_OCCURRENCE_KEY,
            scheduledForMs: OPENED_AT_MS,
            expectedVersion: 3,
            leaseOwner:
              "readiness-worker-old",
            leaseToken: IDS.leaseOne,
            completedAtMs:
              READINESS_LEASE_EXPIRES_AT_MS +
              1,
            errorCode: "STALE_READINESS_WORKER",
            nextAttemptAtMs:
              READINESS_LEASE_EXPIRES_AT_MS +
              2,
          }),
        (error) =>
          error?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      assert.deepEqual(
        readMigratedReadinessPair(database),
        beforeStaleCompletion
      );
    });

    test("rejects every persisted readiness count, version, lease, and start split without a write", (t) => {
      const splitCases = [
        {
          name: "attempt count",
          readinessOverrides: {
            attempt_count: 2,
          },
        },
        {
          name: "version",
          readinessOverrides: { version: 3 },
        },
        {
          name: "lease token",
          readinessOverrides: {
            lease_token: uuid(96),
          },
        },
        {
          name: "start timestamp",
          readinessOverrides: {
            started_at_ms:
              READINESS_STARTED_AT_MS + 1,
          },
        },
      ];

      for (const splitCase of splitCases) {
        const { database, repository } =
          migratedReadinessFixture(t, {
            state: "running",
            readinessOverrides:
              splitCase.readinessOverrides,
          });
        const before =
          readMigratedReadinessPair(database);
        const result = repository.claim(
          readinessClaimCommand({
            expectedVersion: 2,
            nowMs:
              READINESS_LEASE_EXPIRES_AT_MS,
            leaseExpiresAtMs:
              READINESS_LEASE_EXPIRES_AT_MS +
              60_000,
          })
        );
        assert.equal(
          result.acquired,
          false,
          splitCase.name
        );
        assert.deepEqual(
          readMigratedReadinessPair(database),
          before,
          splitCase.name
        );
      }
    });

    test("rolls back readiness claim injection after the job CAS and after both writes", (t) => {
      for (const injectedOperation of [
        "claimReadinessJob",
        "claim",
      ]) {
        let database;
        const fixtureState =
          migratedReadinessFixture(t, {
            beforeCommit(operation) {
              if (
                operation === injectedOperation
              ) {
                throw new Error(
                  `injected-${operation}`
                );
              }
            },
          });
        database = fixtureState.database;
        const before =
          readMigratedReadinessPair(database);
        assert.throws(
          () =>
            fixtureState.repository.claim(
              readinessClaimCommand()
            ),
          (error) =>
            error?.code ===
              "REPOSITORY_OPERATION_FAILED" &&
            error?.cause?.message ===
              `injected-${injectedOperation}`
        );
        assert.deepEqual(
          readMigratedReadinessPair(database),
          before,
          injectedOperation
        );
      }
    });

    test("accepts readiness retry atomically for commissioner and member-platform-administrator authority", (t) => {
      const actorCases = [
        {
          name: "commissioner",
          actorUserId:
            IDS.commissionerUser,
          actorMembershipId:
            IDS.commissionerMembership,
          actorAuthority: "commissioner",
        },
        {
          name: "member platform administrator",
          actorUserId:
            IDS.administratorUser,
          actorMembershipId:
            IDS.administratorMembership,
          actorAuthority:
            "platform_administrator_as_commissioner",
        },
      ];

      for (const actorCase of actorCases) {
        const { database, repository } =
          migratedReadinessFixture(t, {
            state: "failed",
          });
        const command =
          readinessRetryCommand({
            actorUserId:
              actorCase.actorUserId,
            actorMembershipId:
              actorCase.actorMembershipId,
          });
        const before =
          readReadinessRetryState(database);
        const receipt =
          expectedReadinessRetryReceipt(
            command,
            actorCase.actorAuthority
          );
        const result =
          repository.requeueReadiness(
            command
          );
        assertReadinessRetryResult(
          result,
          receipt,
          false
        );

        const after =
          readReadinessRetryState(database);
        assert.deepEqual(after.pair.job, {
          ...before.pair.job,
          status: "pending",
          lease_owner: null,
          lease_token: null,
          lease_expires_at_ms: null,
          started_at_ms: null,
          completed_at_ms: null,
          result_json: null,
          last_error_code: null,
          next_attempt_at_ms:
            command.acceptedAtMs,
          updated_at_ms:
            command.acceptedAtMs,
          version:
            before.pair.job.version + 1,
        });
        assert.deepEqual(
          after.pair.readiness,
          {
            ...before.pair.readiness,
            next_retry_at_ms:
              command.acceptedAtMs,
            updated_at_ms:
              command.acceptedAtMs,
            version:
              before.pair.readiness
                .version + 1,
          }
        );
        assert.equal(
          after.pair.job.attempt_count,
          before.pair.job.attempt_count,
          actorCase.name
        );
        assert.equal(
          after.pair.readiness.attempt_count,
          before.pair.readiness
            .attempt_count,
          actorCase.name
        );
        assert.deepEqual(
          after.attempts,
          before.attempts
        );
        assert.deepEqual(after.receipts, [
          readinessRetryReceiptRow(receipt),
        ]);

        const request =
          createFreeAgentDraftReadinessRetryRequest({
            actorUserId:
              command.actorUserId,
            body: command.body,
            clientKey: command.clientKey,
            expectedVersion:
              command.expectedVersion,
            leagueId: command.leagueId,
          });
        assert.deepEqual(
          after.idempotency,
          [
            {
              id:
                command
                  .idempotencyRequestId,
              league_id:
                command.leagueId,
              actor_user_id:
                command.actorUserId,
              operation:
                "free_agent_draft.readiness.retry.v1",
              client_key:
                command.clientKey,
              request_hash:
                request.requestSha256,
              status: "completed",
              result_type:
                "free_agent_draft_readiness_retry_receipt",
              result_id:
                command.retryReceiptId,
              created_at_ms:
                command.acceptedAtMs,
              completed_at_ms:
                command.acceptedAtMs,
              expires_at_ms:
                command
                  .idempotencyExpiresAtMs,
            },
          ]
        );
        assert.equal(
          receipt.responseJson,
          JSON.stringify(receipt.data)
        );
        assert.match(
          receipt.responseSha256,
          /^[a-f0-9]{64}$/
        );

        if (
          actorCase.actorAuthority ===
          "commissioner"
        ) {
          const claim =
            readinessClaimCommand({
              expectedVersion: 4,
              nowMs:
                command.acceptedAtMs,
              leaseExpiresAtMs:
                command.acceptedAtMs +
                120_000,
            });
          const claimed =
            repository.claim(claim);
          assert.equal(
            claimed.acquired,
            true
          );
          const claimedPair =
            readMigratedReadinessPair(
              database
            );
          assert.equal(
            claimedPair.job.attempt_count,
            receipt.retryAttemptNumber
          );
          assert.equal(
            claimedPair.readiness
              .attempt_count,
            receipt.retryAttemptNumber
          );
          assert.equal(
            claimedPair.job.version,
            5
          );
          assert.equal(
            claimedPair.readiness.version,
            5
          );
        }
      }
    });

    test("denies unauthorized actors and hides missing or cross-scope readiness without writes", (t) => {
      const deniedActors = [
        {
          actorUserId: IDS.memberUser,
          actorMembershipId:
            IDS.memberMembership,
        },
        {
          actorUserId:
            IDS.outsiderAdministratorUser,
          actorMembershipId: uuid(111),
        },
      ];
      for (const actor of deniedActors) {
        const { database, repository } =
          migratedReadinessFixture(t, {
            state: "failed",
          });
        const before =
          readReadinessRetryState(database);
        assertRetryRepositoryError(
          () =>
            repository.requeueReadiness(
              readinessRetryCommand(actor)
            ),
          { code: "NOT_AUTHORIZED" }
        );
        assert.deepEqual(
          readReadinessRetryState(database),
          before
        );
      }

      const hiddenCases = [
        {
          body: {
            readinessOperationId:
              uuid(130),
          },
        },
        {
          leagueId: IDS.otherLeague,
          actorUserId:
            IDS.administratorUser,
          actorMembershipId:
            IDS.administratorOtherMembership,
          body: {
            seasonId: IDS.otherSeason,
            readinessOperationId:
              IDS.readinessOperation,
          },
        },
      ];
      for (const hiddenCase of hiddenCases) {
        const { database, repository } =
          migratedReadinessFixture(t, {
            state: "failed",
          });
        const before =
          readReadinessRetryState(database);
        assertRetryRepositoryError(
          () =>
            repository.requeueReadiness(
              readinessRetryCommand(
                hiddenCase
              )
            ),
          {
            code:
              "FREE_AGENT_DRAFT_NOT_FOUND",
          }
        );
        assert.deepEqual(
          readReadinessRetryState(database),
          before
        );
      }
    });

    test("gives stale readiness preconditions deterministic precedence over state and job conflicts", (t) => {
      const staleCases = [
        {
          state: "failed",
          expectedVersion: 2,
          currentVersion: 3,
        },
        {
          state: "pending",
          expectedVersion: 2,
          currentVersion: 1,
        },
        {
          state: "failed",
          jobOverrides: {
            last_error_code:
              "WRONG_BLOCKER_CODE",
          },
          expectedVersion: 2,
          currentVersion: 3,
        },
      ];
      for (const staleCase of staleCases) {
        const { database, repository } =
          migratedReadinessFixture(t, {
            state: staleCase.state,
            jobOverrides:
              staleCase.jobOverrides,
          });
        const before =
          readReadinessRetryState(database);
        assertRetryRepositoryError(
          () =>
            repository.requeueReadiness(
              readinessRetryCommand({
                expectedVersion:
                  staleCase
                    .expectedVersion,
              })
            ),
          {
            code:
              "FAD_READINESS_PRECONDITION_FAILED",
            details: {
              currentVersion:
                staleCase.currentVersion,
              refetch: true,
            },
          }
        );
        assert.deepEqual(
          readReadinessRetryState(database),
          before
        );
      }
    });

    test("rejects every nonblocked operation and unavailable canonical readiness job with one 409 semantic", (t) => {
      const unavailableCases = [
        {
          name: "pending operation",
          state: "pending",
          expectedVersion: 1,
        },
        {
          name: "running operation",
          state: "running",
          expectedVersion: 2,
        },
        {
          name: "already requeued job",
          state: "blocked_retry",
          expectedVersion: 4,
        },
        {
          name: "job without season binding",
          state: "failed",
          jobOverrides: {
            season_id: null,
          },
          expectedVersion: 3,
        },
        {
          name: "wrong job type",
          state: "failed",
          jobOverrides: {
            job_type: "fad_deadline",
          },
          expectedVersion: 3,
        },
        {
          name: "wrong job occurrence",
          state: "failed",
          jobOverrides: {
            occurrence_key:
              buildFreeAgentDraftReadinessOccurrenceKey({
                leagueId: IDS.league,
                seasonId: IDS.season,
                triggerResourceId:
                  uuid(131),
              }),
          },
          expectedVersion: 3,
        },
        {
          name: "wrong job schedule",
          state: "failed",
          jobOverrides: {
            scheduled_for_ms:
              OPENED_AT_MS + 1,
          },
          expectedVersion: 3,
        },
        {
          name: "wrong job creation time",
          state: "failed",
          jobOverrides: {
            created_at_ms: OPENED_AT_MS - 1,
          },
          expectedVersion: 3,
        },
        {
          name: "succeeded job",
          state: "failed",
          jobOverrides: {
            status: "succeeded",
          },
          expectedVersion: 3,
        },
        {
          name: "skipped job",
          state: "failed",
          jobOverrides: {
            status: "skipped",
          },
          expectedVersion: 3,
        },
        {
          name: "attempt split",
          state: "failed",
          jobOverrides: {
            attempt_count: 2,
          },
          expectedVersion: 3,
        },
        {
          name: "dirty lease owner",
          state: "failed",
          jobOverrides: {
            lease_owner: "stale-worker",
          },
          expectedVersion: 3,
        },
        {
          name: "dirty lease token",
          state: "failed",
          jobOverrides: {
            lease_token: IDS.leaseOne,
          },
          expectedVersion: 3,
        },
        {
          name: "dirty lease expiry",
          state: "failed",
          jobOverrides: {
            lease_expires_at_ms:
              READINESS_RETRY_AT_MS,
          },
          expectedVersion: 3,
        },
        {
          name: "start split",
          state: "failed",
          jobOverrides: {
            started_at_ms:
              READINESS_STARTED_AT_MS + 1,
          },
          expectedVersion: 3,
        },
        {
          name: "missing completion",
          state: "failed",
          jobOverrides: {
            completed_at_ms: null,
          },
          expectedVersion: 3,
        },
        {
          name: "late completion",
          state: "failed",
          jobOverrides: {
            completed_at_ms:
              READINESS_RETRY_AT_MS,
          },
          expectedVersion: 3,
        },
        {
          name: "completion split",
          state: "failed",
          jobOverrides: {
            completed_at_ms:
              READINESS_BLOCKED_AT_MS + 1,
          },
          expectedVersion: 3,
        },
        {
          name: "unexpected result",
          state: "failed",
          jobOverrides: {
            result_json: "{}",
          },
          expectedVersion: 3,
        },
        {
          name: "wrong error",
          state: "failed",
          jobOverrides: {
            last_error_code:
              "WRONG_BLOCKER_CODE",
          },
          expectedVersion: 3,
        },
        {
          name: "missing retry time",
          state: "failed",
          jobOverrides: {
            next_attempt_at_ms: null,
          },
          expectedVersion: 3,
        },
        {
          name: "invalid retry time",
          state: "failed",
          jobOverrides: {
            next_attempt_at_ms:
              READINESS_BLOCKED_AT_MS,
          },
          expectedVersion: 3,
        },
        {
          name: "retry time split",
          state: "failed",
          jobOverrides: {
            next_attempt_at_ms:
              READINESS_RETRY_AT_MS + 1,
          },
          expectedVersion: 3,
        },
        {
          name: "update time split",
          state: "failed",
          jobOverrides: {
            updated_at_ms:
              READINESS_BLOCKED_AT_MS - 1,
          },
          expectedVersion: 3,
        },
        {
          name: "future update",
          state: "failed",
          jobOverrides: {
            updated_at_ms:
              READINESS_RETRY_AT_MS + 1,
          },
          expectedVersion: 3,
        },
        {
          name: "job version split",
          state: "failed",
          jobOverrides: {
            version: 4,
          },
          expectedVersion: 3,
        },
      ];

      for (const unavailableCase of unavailableCases) {
        let fixtureState;
        try {
          fixtureState = migratedReadinessFixture(
            t,
            {
              state: unavailableCase.state,
              jobOverrides:
                unavailableCase
                  .jobOverrides,
              readinessOverrides:
                unavailableCase
                  .readinessOverrides,
            }
          );
        } catch (error) {
          throw new Error(
            `${unavailableCase.name}: ` +
              error.message,
            { cause: error }
          );
        }
        const { database, repository } =
          fixtureState;
        const before =
          readReadinessRetryState(database);
        assert.throws(
          () =>
            repository.requeueReadiness(
              readinessRetryCommand({
                expectedVersion:
                  unavailableCase
                    .expectedVersion,
              })
            ),
          (error) => {
            assert.equal(
              error.code,
              "FAD_READINESS_NOT_READY",
              unavailableCase.name
            );
            assert.equal(
              error.details,
              undefined,
              unavailableCase.name
            );
            return true;
          }
        );
        assert.deepEqual(
          readReadinessRetryState(database),
          before,
          unavailableCase.name
        );
      }
    });

    test("replays the immutable retry receipt after later job changes while revalidating current same-user authority", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t, {
          state: "failed",
        });
      const acceptedCommand =
        readinessRetryCommand({
          actorUserId:
            IDS.administratorUser,
          actorMembershipId:
            IDS.administratorMembership,
        });
      const historicalReceipt =
        expectedReadinessRetryReceipt(
          acceptedCommand,
          "platform_administrator_as_commissioner"
        );
      assertReadinessRetryResult(
        repository.requeueReadiness(
          acceptedCommand
        ),
        historicalReceipt,
        false
      );

      database
        .prepare(`
          UPDATE league_memberships
          SET status = 'ended',
              ended_at_ms = ?,
              updated_at_ms = ?,
              version = version + 1
          WHERE league_id = ? AND id = ?
        `)
        .run(
          READINESS_RETRY_AT_MS + 1,
          READINESS_RETRY_AT_MS + 1,
          IDS.league,
          IDS.administratorMembership
        );
      insertRow(database, "league_memberships", {
        id:
          IDS.administratorReplacementMembership,
        league_id: IDS.league,
        user_id: IDS.administratorUser,
        permission_category: "commissioner",
        status: "active",
        joined_at_ms:
          READINESS_RETRY_AT_MS + 1,
        ended_at_ms: null,
        created_at_ms:
          READINESS_RETRY_AT_MS + 1,
        updated_at_ms:
          READINESS_RETRY_AT_MS + 1,
        version: 1,
      });
      database
        .prepare(`
          UPDATE leagues
          SET commissioner_membership_id = ?,
              updated_at_ms = ?,
              version = version + 1
          WHERE id = ?
        `)
        .run(
          IDS.administratorReplacementMembership,
          READINESS_RETRY_AT_MS + 1,
          IDS.league
        );
      database
        .prepare(`
          UPDATE platform_roles
          SET status = 'ended',
              ended_at_ms = ?,
              version = version + 1
          WHERE id = ?
        `)
        .run(
          READINESS_RETRY_AT_MS + 1,
          IDS.administratorRole
        );

      const claimed = repository.claim(
        readinessClaimCommand({
          expectedVersion: 4,
          nowMs: READINESS_RETRY_AT_MS,
          leaseExpiresAtMs:
            READINESS_RETRY_AT_MS + 60_000,
        })
      );
      assert.equal(claimed.acquired, true);
      const replayPublicCommand =
        readinessRetryPublicCommand({
          actorUserId:
            IDS.administratorUser,
          actorMembershipId:
            IDS.administratorReplacementMembership,
        });
      const replayWriteCommand =
        readinessRetryCommand({
          actorUserId:
            IDS.administratorUser,
          actorMembershipId:
            IDS.administratorReplacementMembership,
        });
      const before =
        readReadinessRetryState(database);
      const changesBefore = totalChanges(database);

      assertReadinessRetryResult(
        repository.findReadinessRetryReplay(
          replayPublicCommand
        ),
        historicalReceipt,
        true
      );
      assertReadinessRetryResult(
        repository.requeueReadiness(
          replayWriteCommand
        ),
        historicalReceipt,
        true
      );
      assert.deepEqual(
        readReadinessRetryState(database),
        before
      );
      assert.equal(
        totalChanges(database),
        changesBefore
      );
      assert.equal(
        historicalReceipt.actorMembershipId,
        IDS.administratorMembership
      );
      assert.equal(
        historicalReceipt.actorAuthority,
        "platform_administrator_as_commissioner"
      );
    });

    test("denies stale active retry authority rows before replay with no state change", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t, {
          state: "failed",
        });
      const writeCommand = readinessRetryCommand({
        actorUserId: IDS.administratorUser,
        actorMembershipId:
          IDS.administratorMembership,
      });
      const publicCommand = readinessRetryPublicCommand({
        actorUserId: IDS.administratorUser,
        actorMembershipId:
          IDS.administratorMembership,
      });
      assert.equal(
        repository.requeueReadiness(writeCommand).replayed,
        false
      );

      assert.equal(
        database.prepare(`
          UPDATE platform_roles
          SET ended_at_ms = ?
          WHERE id = ? AND status = 'active'
        `).run(
          READINESS_RETRY_AT_MS + 1,
          IDS.administratorRole
        ).changes,
        1
      );
      assertReadinessRetryAuthorizationDeniedWithoutWrites({
        database,
        repository,
        publicCommand,
        writeCommand,
      });

      assert.equal(
        database.prepare(`
          UPDATE platform_roles
          SET ended_at_ms = NULL
          WHERE id = ?
        `).run(IDS.administratorRole).changes,
        1
      );
      assert.equal(
        database.prepare(`
          UPDATE league_memberships
          SET ended_at_ms = ?
          WHERE id = ? AND status = 'active'
        `).run(
          READINESS_RETRY_AT_MS + 2,
          IDS.administratorMembership
        ).changes,
        1
      );
      assertReadinessRetryAuthorizationDeniedWithoutWrites({
        database,
        repository,
        publicCommand,
        writeCommand,
      });

      assert.equal(
        database.prepare(`
          UPDATE league_memberships
          SET joined_at_ms = NULL,
              ended_at_ms = NULL
          WHERE id = ? AND status = 'active'
        `).run(IDS.administratorMembership).changes,
        1
      );
      assertReadinessRetryAuthorizationDeniedWithoutWrites({
        database,
        repository,
        publicCommand,
        writeCommand,
      });

      assert.equal(
        database.prepare(`
          UPDATE league_memberships
          SET joined_at_ms = 1
          WHERE id = ?
        `).run(IDS.administratorMembership).changes,
        1
      );
      assert.equal(
        database.prepare(`
          UPDATE users
          SET status = 'disabled'
          WHERE id = ? AND status = 'active'
        `).run(IDS.administratorUser).changes,
        1
      );
      assertReadinessRetryAuthorizationDeniedWithoutWrites({
        database,
        repository,
        publicCommand,
        writeCommand,
      });
    });

    test("rejects changed same-actor retry input as idempotency-key reuse without writes", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t, {
          state: "failed",
        });
      repository.requeueReadiness(
        readinessRetryCommand()
      );
      const changedCases = [
        {
          name: "If-Match",
          overrides: {
            expectedVersion: 2,
          },
        },
        {
          name: "body",
          overrides: {
            body: {
              readinessOperationId:
                uuid(140),
            },
          },
        },
      ];

      for (const changedCase of changedCases) {
        const publicCommand =
          readinessRetryPublicCommand(
            changedCase.overrides
          );
        const writeCommand =
          readinessRetryCommand({
            ...changedCase.overrides,
            idempotencyRequestId:
              uuid(
                changedCase.name ===
                  "If-Match"
                  ? 141
                  : 142
              ),
            retryReceiptId:
              uuid(
                changedCase.name ===
                  "If-Match"
                  ? 143
                  : 144
              ),
          });
        const before =
          readReadinessRetryState(database);
        const changesBefore =
          totalChanges(database);
        for (const callback of [
          () =>
            repository.findReadinessRetryReplay(
              publicCommand
            ),
          () =>
            repository.requeueReadiness(
              writeCommand
            ),
        ]) {
          assertRetryRepositoryError(callback, {
            code: "IDEMPOTENCY_KEY_REUSED",
          });
        }
        assert.deepEqual(
          readReadinessRetryState(database),
          before,
          changedCase.name
        );
        assert.equal(
          totalChanges(database),
          changesBefore,
          changedCase.name
        );
      }
    });

    test("treats the same client key from a different authorized actor as a fresh actor-scoped request", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t, {
          state: "failed",
        });
      repository.requeueReadiness(
        readinessRetryCommand()
      );
      const otherActorPublic =
        readinessRetryPublicCommand({
          actorUserId:
            IDS.administratorUser,
          actorMembershipId:
            IDS.administratorMembership,
        });
      const otherActorWrite =
        readinessRetryCommand({
          actorUserId:
            IDS.administratorUser,
          actorMembershipId:
            IDS.administratorMembership,
          idempotencyRequestId: uuid(145),
          retryReceiptId: uuid(146),
        });
      const before =
        readReadinessRetryState(database);
      const changesBefore = totalChanges(database);

      assert.equal(
        repository.findReadinessRetryReplay(
          otherActorPublic
        ),
        null
      );
      assertRetryRepositoryError(
        () =>
          repository.requeueReadiness(
            otherActorWrite
          ),
        {
          code:
            "FAD_READINESS_PRECONDITION_FAILED",
          details: {
            currentVersion: 4,
            refetch: true,
          },
        }
      );
      assert.deepEqual(
        readReadinessRetryState(database),
        before
      );
      assert.equal(
        totalChanges(database),
        changesBefore
      );
    });

    test("fails closed when a matching retry idempotency request has no available immutable receipt", (t) => {
      const unavailableCases = [
        {
          name: "started request",
          status: "started",
          resultType: null,
          resultId: null,
          completedAtMs: null,
        },
        {
          name: "completed request without receipt",
          status: "completed",
          resultType:
            "free_agent_draft_readiness_retry_receipt",
          resultId: uuid(147),
          completedAtMs:
            READINESS_RETRY_AT_MS,
        },
        {
          name: "completed request with wrong result type",
          status: "completed",
          resultType: "wrong_result_type",
          resultId: uuid(148),
          completedAtMs:
            READINESS_RETRY_AT_MS,
        },
      ];

      for (const unavailableCase of unavailableCases) {
        const { database, repository } =
          migratedReadinessFixture(t, {
            state: "failed",
          });
        const command = readinessRetryCommand();
        const request =
          createFreeAgentDraftReadinessRetryRequest(
            {
              actorUserId:
                command.actorUserId,
              body: command.body,
              clientKey: command.clientKey,
              expectedVersion:
                command.expectedVersion,
              leagueId: command.leagueId,
            }
          );
        insertRow(database, "idempotency_requests", {
          id: command.idempotencyRequestId,
          league_id: command.leagueId,
          actor_user_id: command.actorUserId,
          operation:
            "free_agent_draft.readiness.retry.v1",
          client_key: command.clientKey,
          request_hash: request.requestSha256,
          status: unavailableCase.status,
          result_type:
            unavailableCase.resultType,
          result_id: unavailableCase.resultId,
          created_at_ms: command.acceptedAtMs,
          completed_at_ms:
            unavailableCase.completedAtMs,
          expires_at_ms:
            command.idempotencyExpiresAtMs,
        });
        const before =
          readReadinessRetryState(database);
        const changesBefore =
          totalChanges(database);

        for (const callback of [
          () =>
            repository.findReadinessRetryReplay(
              readinessRetryPublicCommand()
            ),
          () =>
            repository.requeueReadiness(
              command
            ),
        ]) {
          assertRetryRepositoryError(callback, {
            code:
              "IDEMPOTENCY_REQUEST_UNAVAILABLE",
          });
        }
        assert.deepEqual(
          readReadinessRetryState(database),
          before,
          unavailableCase.name
        );
        assert.equal(
          totalChanges(database),
          changesBefore,
          unavailableCase.name
        );
      }
    });

    test("rolls back readiness retry after failure at each of its five write seams", (t) => {
      for (const seam of [
        "idempotencyStarted",
        "jobPending",
        "receiptInserted",
        "operationAdvanced",
        "idempotencyCompleted",
      ]) {
        const { database, repository } =
          migratedReadinessFixture(t, {
            state: "failed",
          });
        installReadinessRetryAbort(
          database,
          seam
        );
        const before =
          readReadinessRetryState(database);
        assert.throws(
          () =>
            repository.requeueReadiness(
              readinessRetryCommand()
            ),
          (error) => {
            assert.equal(
              error.code,
              REPOSITORY_ERROR_CODES.constraint,
              seam
            );
            assert.deepEqual(
              error.details,
              {
                operation:
                  "requeueFadReadinessJob",
                tableName: "job_runs",
              },
              seam
            );
            assert.equal(
              Object.isFrozen(error.details),
              true,
              seam
            );
            assert.match(
              error.cause?.message || "",
              new RegExp(
                `injected readiness retry ${seam}`
              ),
              seam
            );
            return true;
          }
        );
        assert.deepEqual(
          readReadinessRetryState(database),
          before,
          seam
        );
        assert.equal(
          database.inTransaction,
          false,
          seam
        );
      }
    });

    test("rolls back all readiness retry writes when the final commit hook rejects", (t) => {
      const { database, repository } =
        migratedReadinessFixture(t, {
          state: "failed",
          beforeCommit(operation) {
            if (operation === "requeueReadiness") {
              throw new Error(
                "injected-requeueReadiness"
              );
            }
          },
        });
      const before =
        readReadinessRetryState(database);
      assert.throws(
        () =>
          repository.requeueReadiness(
            readinessRetryCommand()
          ),
        (error) => {
          assert.equal(
            error.code,
            REPOSITORY_ERROR_CODES.operationFailed
          );
          assert.equal(
            error.cause?.message,
            "injected-requeueReadiness"
          );
          return true;
        }
      );
      assert.deepEqual(
        readReadinessRetryState(database),
        before
      );
      assert.equal(database.inTransaction, false);
    });

    test("persists retry timing and resumes the exact failed occurrence after restart", (t) => {
      const state = fixture(t);
      const deadline = byType(
        state.repository.listDue({
          nowMs: NOW_MS,
          limit: 100,
        }),
        "deadline"
      );
      const claimed = state.repository.claim(
        claimCommand(deadline)
      ).occurrence;
      const retryAtMs = NOW_MS + 10_000;
      const failed = state.repository.fail({
        ...mutationCommand(claimed),
        completedAtMs: NOW_MS + 1,
        nextAttemptAtMs: retryAtMs,
        errorCode: "TRANSIENT_DATABASE_BUSY",
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.version, 3);
      assert.equal(
        failed.nextAttemptAtMs,
        retryAtMs
      );

      state.reopen();
      assert.equal(
        state.repository
          .listDue({
            nowMs: retryAtMs - 1,
            limit: 100,
          })
          .some(
            (occurrence) =>
              occurrence.runId ===
              IDS.deadlineJob
          ),
        false
      );
      const replay = state.repository
        .listDue({
          nowMs: retryAtMs,
          limit: 100,
        })
        .find(
          (occurrence) =>
            occurrence.runId ===
            IDS.deadlineJob
        );
      assert.equal(replay.status, "failed");
      assert.equal(replay.version, 3);
      const reclaimed = state.repository.claim(
        claimCommand(replay, {
          expectedVersion: 3,
          nowMs: retryAtMs,
          leaseExpiresAtMs:
            retryAtMs + 60_000,
        })
      );
      assert.equal(reclaimed.acquired, true);
      assert.equal(reclaimed.occurrence.version, 4);
      assert.equal(
        reclaimed.occurrence.attemptCount,
        2
      );
      assert.equal(
        reclaimed.occurrence.startedAtMs,
        retryAtMs
      );
    });

    test("fails closed for cross-scope, type/key mismatch, terminal work, and wrong child evidence", (t) => {
      const { database, repository } =
        fixture(t);
      const due = repository.listDue({
        nowMs: NOW_MS,
        limit: 100,
      });
      const allocation = byType(
        due,
        "allocate"
      );

      assert.deepEqual(
        repository.claim(
          claimCommand(allocation, {
            leagueId: IDS.otherLeague,
          })
        ),
        {
          acquired: false,
          occurrence: null,
        }
      );
      assert.deepEqual(
        repository.claim(
          claimCommand(allocation, {
            seasonId: IDS.otherSeason,
          })
        ),
        {
          acquired: false,
          occurrence: null,
        }
      );
      assert.throws(
        () =>
          repository.claim(
            claimCommand(allocation, {
              fadId: IDS.otherFad,
            })
          ),
        (error) =>
          error?.code ===
          "REPOSITORY_ARGUMENT_INVALID"
      );
      assert.throws(
        () =>
          repository.claim(
            claimCommand(allocation, {
              jobType:
                FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
                  .deadline,
            })
          ),
        (error) =>
          error?.code ===
          "REPOSITORY_ARGUMENT_INVALID"
      );
      assert.throws(
        () =>
          repository.claim(
            claimCommand(allocation, {
              jobType: "fad_unknown",
            })
          ),
        (error) =>
          error?.code ===
          "REPOSITORY_ARGUMENT_INVALID"
      );

      database
        .prepare(`
          UPDATE free_agent_draft_player_allocations
          SET player_id = ?
          WHERE id = ?
        `)
        .run(
          IDS.otherPlayer,
          IDS.allocation
        );
      assert.throws(
        () =>
          repository.listDue({
            nowMs: NOW_MS,
            limit: 100,
          }),
        (error) =>
          error?.code ===
            "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
          error.details?.runId ===
            IDS.allocationJob
      );
      assert.deepEqual(
        repository.claim(
          claimCommand(allocation)
        ),
        {
          acquired: false,
          occurrence: null,
        }
      );

      database
        .prepare(`
          UPDATE free_agent_draft_readiness_operations
          SET job_run_id = NULL
          WHERE id = ?
        `)
        .run(IDS.readinessOperation);
      assert.throws(
        () =>
          repository.listDue({
            nowMs: NOW_MS,
            limit: 100,
          }),
        (error) =>
          error?.code ===
            "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
          error.details?.runId ===
            IDS.readinessJob
      );
    });

    test("rolls back injected claim, success, and retry-failure mutations", (t) => {
      let injectedOperation = "claim";
      const { database, repository } =
        fixture(t, (operation) => {
          if (operation === injectedOperation) {
            throw new Error(
              `injected-${operation}`
            );
          }
        });
      const allocation = byType(
        repository.listDue({
          nowMs: NOW_MS,
          limit: 100,
        }),
        "allocate"
      );
      assert.throws(
        () =>
          repository.claim(
            claimCommand(allocation)
          ),
        (error) =>
          error?.code ===
            "REPOSITORY_OPERATION_FAILED" &&
          error?.cause?.message ===
            "injected-claim"
      );
      let row = database
        .prepare(
          "SELECT * FROM job_runs WHERE id = ?"
        )
        .get(IDS.allocationJob);
      assert.equal(row.status, "pending");
      assert.equal(row.attempt_count, 0);
      assert.equal(row.version, 1);

      injectedOperation = null;
      const claimed = repository.claim(
        claimCommand(allocation)
      ).occurrence;
      injectedOperation = "succeed";
      assert.throws(
        () =>
          repository.succeed({
            ...mutationCommand(claimed),
            result: { outcome: "complete" },
          }),
        (error) =>
          error?.code ===
            "REPOSITORY_OPERATION_FAILED" &&
          error?.cause?.message ===
            "injected-succeed"
      );
      row = database
        .prepare(
          "SELECT * FROM job_runs WHERE id = ?"
        )
        .get(IDS.allocationJob);
      assert.equal(row.status, "running");
      assert.equal(row.version, 2);
      assert.equal(row.result_json, null);
      assert.equal(
        row.lease_token,
        IDS.leaseOne
      );

      injectedOperation = "fail";
      assert.throws(
        () =>
          repository.fail({
            ...mutationCommand(claimed),
            errorCode: "TRANSIENT_FAILURE",
            nextAttemptAtMs: NOW_MS + 10_000,
          }),
        (error) =>
          error?.code ===
            "REPOSITORY_OPERATION_FAILED" &&
          error?.cause?.message ===
            "injected-fail"
      );
      row = database
        .prepare(
          "SELECT * FROM job_runs WHERE id = ?"
        )
        .get(IDS.allocationJob);
      assert.equal(row.status, "running");
      assert.equal(row.version, 2);
      assert.equal(row.last_error_code, null);
      assert.equal(row.next_attempt_at_ms, null);
    });
  }
);
