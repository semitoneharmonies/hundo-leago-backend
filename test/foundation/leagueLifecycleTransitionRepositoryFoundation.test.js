const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  hashSeasonRolloverItem,
  hashSeasonRolloverSourceReadiness,
  parseCanonicalJsonV1,
  serializeCanonicalJsonV1,
  serializeSeasonRolloverSourceReadiness,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  calculateStandingsResultSetHash,
} = require(
  "../../src/domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require(
  "../../src/domain/leagues/socketInvalidation"
);
const {
  INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
  INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
  LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
} = require(
  "../../src/domain/leagues/leagueLifecycleTransitionPolicy"
);
const {
  createLeagueLifecycleTransitionService,
} = require(
  "../../src/application/services/leagues/createLeagueLifecycleTransitionService"
);
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
  REPOSITORY_METHODS,
  createSqliteLeagueLifecycleTransitionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueLifecycleTransitionRepository"
);
const {
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  createSqliteFreeAgentDraftReadinessHandoffWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadinessHandoffWriter"
);
const {
  createSqliteLeagueOutboxWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxWriter"
);
const {
  createSqliteNotificationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteNotificationWriter"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function latestMigrationVersion() {
  return Math.max(
    ...fs
      .readdirSync(MIGRATIONS_DIRECTORY)
      .map((name) => /^(\d{4})_/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
  );
}

function uuid(value) {
  const hex = value.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function deterministicUuid(value) {
  const hex = crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  otherLeague: uuid(2),
  commissioner: uuid(3),
  membership: uuid(4),
  sourceSeason: uuid(5),
  targetSeason: uuid(6),
  entryDraft: uuid(7),
  binding: uuid(8),
  occurrence: uuid(9),
  supersededOccurrence: uuid(10),
  scheduleOperation: uuid(11),
  oldScheduleOperation: uuid(12),
  targetSchedule: uuid(13),
  weekOne: uuid(14),
  jobRun: uuid(15),
  firstPick: uuid(16),
  firstPickOwner: uuid(17),
  scheduledAttempt: uuid(18),
  retryAttempt: uuid(19),
  retryIdempotency: uuid(20),
  rollover: uuid(21),
  firstClock: uuid(22),
  aggregateActivity: uuid(23),
  securityAudit: uuid(24),
  outbox: uuid(25),
  sourceFad: uuid(26),
  finalizationRoot: uuid(27),
  finalization: uuid(28),
  standingsSnapshot: uuid(29),
  standingsOperation: uuid(30),
});

const STARTS_AT_MS = Date.parse(
  "2027-07-15T17:00:00.000Z"
);
const WEEK_ONE_STARTS_AT_MS = Date.parse(
  "2027-10-04T07:00:00.000Z"
);
const COMPLETED_AT_MS = STARTS_AT_MS + 1_000;
const OCCURRENCE_KEY =
  `league:${IDS.league}:entry-draft:` +
  `${IDS.entryDraft}:rollover:` +
  `${IDS.occurrence}:${STARTS_AT_MS}`;

function schema(database) {
  database.exec(`
    CREATE TABLE leagues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      timezone TEXT NOT NULL,
      current_season_id TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE seasons (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      label TEXT NOT NULL,
      nhl_season_key TEXT NOT NULL,
      status TEXT NOT NULL,
      regular_season_starts_at_ms INTEGER,
      regular_season_ends_at_ms INTEGER,
      fantasy_playoffs_start_at_ms INTEGER,
      fantasy_playoffs_end_at_ms INTEGER,
      free_agent_draft_completed_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE entry_drafts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      status TEXT NOT NULL,
      pick_clock_seconds INTEGER NOT NULL,
      starts_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE draft_picks (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      target_season_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      position_number INTEGER NOT NULL,
      current_owner_team_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE entry_draft_rollover_bindings (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      entry_draft_id TEXT NOT NULL,
      from_season_id TEXT NOT NULL,
      to_season_id TEXT NOT NULL,
      current_rollover_occurrence_id TEXT NOT NULL,
      current_scheduled_job_run_id TEXT NOT NULL,
      current_schedule_operation_id TEXT NOT NULL,
      target_schedule_id TEXT NOT NULL,
      target_schedule_version INTEGER NOT NULL,
      week_one_matchup_week_id TEXT NOT NULL,
      week_one_starts_at_ms INTEGER NOT NULL,
      scheduled_starts_at_ms INTEGER NOT NULL,
      current_occurrence_key TEXT NOT NULL,
      status TEXT NOT NULL,
      successful_rollover_id TEXT,
      selection_gate_status TEXT NOT NULL,
      trading_gate_status TEXT NOT NULL,
      scheduled_by_user_id TEXT NOT NULL,
      scheduled_by_membership_id TEXT NOT NULL,
      scheduled_by_authority TEXT NOT NULL,
      source_season_version_at_schedule INTEGER NOT NULL,
      target_season_version_at_schedule INTEGER NOT NULL,
      entry_draft_version_at_schedule INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE season_rollover_occurrences (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      entry_draft_id TEXT NOT NULL,
      from_season_id TEXT NOT NULL,
      to_season_id TEXT NOT NULL,
      target_schedule_id TEXT NOT NULL,
      target_schedule_version INTEGER NOT NULL,
      week_one_matchup_week_id TEXT NOT NULL,
      week_one_starts_at_ms INTEGER NOT NULL,
      scheduled_starts_at_ms INTEGER NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_by_user_id TEXT NOT NULL,
      scheduled_by_membership_id TEXT NOT NULL,
      scheduled_by_authority TEXT NOT NULL,
      status TEXT NOT NULL,
      superseded_by_occurrence_id TEXT,
      scheduled_job_run_id TEXT NOT NULL,
      schedule_operation_id TEXT NOT NULL,
      successful_rollover_id TEXT,
      source_season_version_at_schedule INTEGER NOT NULL,
      target_season_version_at_schedule INTEGER NOT NULL,
      entry_draft_version_at_schedule INTEGER NOT NULL,
      terminal_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE season_rollover_attempts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      rollover_occurrence_id TEXT NOT NULL,
      entry_draft_id TEXT NOT NULL,
      from_season_id TEXT NOT NULL,
      to_season_id TEXT NOT NULL,
      target_schedule_id TEXT NOT NULL,
      target_schedule_version INTEGER NOT NULL,
      week_one_matchup_week_id TEXT NOT NULL,
      week_one_starts_at_ms INTEGER NOT NULL,
      scheduled_starts_at_ms INTEGER NOT NULL,
      occurrence_key TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      trigger_kind TEXT NOT NULL,
      scheduled_job_run_id TEXT,
      retry_idempotency_request_id TEXT,
      retry_by_user_id TEXT,
      retry_by_membership_id TEXT,
      retry_authority TEXT,
      status TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      season_rollover_id TEXT,
      source_season_version_observed INTEGER NOT NULL,
      target_season_version_observed INTEGER NOT NULL,
      entry_draft_version_observed INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      terminal_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
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
      version INTEGER NOT NULL
    );
    CREATE TABLE idempotency_requests (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      client_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      result_type TEXT,
      result_id TEXT,
      created_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE league_activity (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT,
      event_type TEXT NOT NULL,
      actor_user_id TEXT,
      actor_authority TEXT NOT NULL,
      team_id TEXT,
      player_id TEXT,
      related_type TEXT,
      related_id TEXT,
      display_summary TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE security_audit_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      actor_user_id TEXT,
      target_user_id TEXT,
      league_id TEXT,
      session_id TEXT,
      request_correlation_id TEXT,
      reason_code TEXT,
      network_key_version INTEGER,
      network_metadata_digest TEXT,
      client_metadata_json TEXT,
      unknown_account_digest TEXT,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE outbox_events (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE entry_draft_pick_clocks (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      rollover_occurrence_id TEXT NOT NULL,
      rollover_attempt_id TEXT NOT NULL,
      season_rollover_id TEXT NOT NULL,
      entry_draft_id TEXT NOT NULL,
      draft_pick_id TEXT NOT NULL,
      owning_team_id TEXT NOT NULL,
      clock_generation INTEGER NOT NULL,
      prior_clock_id TEXT,
      on_clock_trade_id TEXT,
      pick_sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      starts_at_ms INTEGER NOT NULL,
      deadline_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE season_rollover_items (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      rollover_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      rollover_occurrence_id TEXT NOT NULL,
      rollover_attempt_id TEXT NOT NULL,
      idempotency_request_id TEXT,
      from_season_id TEXT NOT NULL,
      to_season_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      contract_event_id TEXT,
      ownership_event_id TEXT,
      trade_event_id TEXT,
      league_activity_id TEXT,
      causal_assets_json TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE season_rollovers (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      rollover_occurrence_id TEXT NOT NULL,
      rollover_attempt_id TEXT NOT NULL,
      entry_draft_id TEXT NOT NULL,
      target_schedule_id TEXT NOT NULL,
      target_schedule_version INTEGER NOT NULL,
      week_one_matchup_week_id TEXT NOT NULL,
      week_one_starts_at_ms INTEGER NOT NULL,
      first_pick_clock_id TEXT NOT NULL,
      entry_draft_scheduled_starts_at_ms INTEGER NOT NULL,
      occurrence_key TEXT NOT NULL,
      from_season_id TEXT NOT NULL,
      to_season_id TEXT NOT NULL,
      status TEXT NOT NULL,
      execution_trigger TEXT NOT NULL,
      scheduled_job_run_id TEXT,
      idempotency_request_id TEXT,
      executed_by_user_id TEXT,
      executed_by_membership_id TEXT,
      executed_authority TEXT NOT NULL,
      entry_draft_scheduled_by_user_id TEXT NOT NULL,
      entry_draft_scheduled_by_membership_id TEXT NOT NULL,
      entry_draft_scheduled_by_authority TEXT NOT NULL,
      league_version_before INTEGER NOT NULL,
      league_version_after INTEGER NOT NULL,
      from_season_version_before INTEGER NOT NULL,
      from_season_version_after INTEGER NOT NULL,
      to_season_version_before INTEGER NOT NULL,
      to_season_version_after INTEGER NOT NULL,
      entry_draft_version_before INTEGER NOT NULL,
      entry_draft_version_after INTEGER NOT NULL,
      target_season_reused INTEGER NOT NULL,
      from_season_label TEXT NOT NULL,
      from_nhl_season_key TEXT NOT NULL,
      to_season_label TEXT NOT NULL,
      target_nhl_season_key TEXT NOT NULL,
      nhl_regular_season_starts_at_ms INTEGER NOT NULL,
      nhl_regular_season_ends_at_ms INTEGER NOT NULL,
      fantasy_playoffs_start_at_ms INTEGER NOT NULL,
      fantasy_playoffs_end_at_ms INTEGER NOT NULL,
      source_fad_id TEXT NOT NULL,
      source_finalization_root_id TEXT NOT NULL,
      source_finalization_id TEXT NOT NULL,
      source_standings_snapshot_id TEXT NOT NULL,
      source_standings_operation_id TEXT NOT NULL,
      source_readiness_json TEXT NOT NULL,
      source_readiness_schema_version INTEGER NOT NULL,
      source_readiness_sha256 TEXT NOT NULL,
      aggregate_activity_id TEXT NOT NULL,
      security_audit_event_id TEXT NOT NULL,
      outbox_event_id TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      contracts_advanced INTEGER NOT NULL,
      contracts_expired INTEGER NOT NULL,
      ownerships_carried INTEGER NOT NULL,
      ownerships_released INTEGER NOT NULL,
      retention_years_advanced INTEGER NOT NULL,
      retention_obligations_completed INTEGER NOT NULL,
      buyout_years_advanced INTEGER NOT NULL,
      buyout_obligations_completed INTEGER NOT NULL,
      trades_cancelled INTEGER NOT NULL,
      manifest_schema_version INTEGER NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
  `);
}

function seed(database) {
  database
    .prepare(
      `INSERT INTO leagues
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      IDS.league,
      "Foundation League",
      "active",
      "America/Vancouver",
      IDS.sourceSeason,
      1,
      8
    );
  const season = database.prepare(
    `INSERT INTO seasons
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  season.run(
    IDS.sourceSeason,
    IDS.league,
    "2026-27",
    "20262027",
    "active",
    Date.parse("2026-10-01T07:00:00.000Z"),
    Date.parse("2027-04-30T07:00:00.000Z"),
    Date.parse("2027-03-01T08:00:00.000Z"),
    Date.parse("2027-04-30T07:00:00.000Z"),
    Date.parse("2027-05-01T07:00:00.000Z"),
    1,
    4
  );
  season.run(
    IDS.targetSeason,
    IDS.league,
    "2027-28",
    "20272028",
    "planned",
    Date.parse("2027-10-01T07:00:00.000Z"),
    Date.parse("2028-04-30T07:00:00.000Z"),
    Date.parse("2028-03-01T08:00:00.000Z"),
    Date.parse("2028-04-30T07:00:00.000Z"),
    null,
    1,
    3
  );
  database.prepare(
    `INSERT INTO entry_drafts
     VALUES (?, ?, ?, 'ready', 300, ?, ?, 2)`
  ).run(
    IDS.entryDraft,
    IDS.league,
    IDS.targetSeason,
    STARTS_AT_MS,
    1
  );
  database.prepare(
    `INSERT INTO draft_picks
     VALUES (?, ?, ?, ?, 1, 1, ?, 'unused', ?, 1)`
  ).run(
    IDS.firstPick,
    IDS.league,
    IDS.entryDraft,
    IDS.targetSeason,
    IDS.firstPickOwner,
    1
  );
  database.prepare(
    `INSERT INTO entry_draft_rollover_bindings
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, 7, ?, ?, ?,
       ?, 'scheduled', NULL, 'locked', 'locked',
       ?, ?, 'commissioner', 4, 3, 2, 1, 1, 1
     )`
  ).run(
    IDS.binding,
    IDS.league,
    IDS.entryDraft,
    IDS.sourceSeason,
    IDS.targetSeason,
    IDS.occurrence,
    IDS.jobRun,
    IDS.scheduleOperation,
    IDS.targetSchedule,
    IDS.weekOne,
    WEEK_ONE_STARTS_AT_MS,
    STARTS_AT_MS,
    OCCURRENCE_KEY,
    IDS.commissioner,
    IDS.membership
  );
  const occurrence = database.prepare(
    `INSERT INTO season_rollover_occurrences
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, 7, ?, ?, ?, ?, ?, ?,
       'commissioner', ?, ?, ?, ?, ?, 4, 3, 2, ?, ?, ?, 1
     )`
  );
  occurrence.run(
    IDS.occurrence,
    IDS.league,
    IDS.binding,
    IDS.entryDraft,
    IDS.sourceSeason,
    IDS.targetSeason,
    IDS.targetSchedule,
    IDS.weekOne,
    WEEK_ONE_STARTS_AT_MS,
    STARTS_AT_MS,
    OCCURRENCE_KEY,
    IDS.commissioner,
    IDS.membership,
    "scheduled",
    null,
    IDS.jobRun,
    IDS.scheduleOperation,
    null,
    null,
    1,
    1
  );
  occurrence.run(
    IDS.supersededOccurrence,
    IDS.league,
    IDS.binding,
    IDS.entryDraft,
    IDS.sourceSeason,
    IDS.targetSeason,
    IDS.targetSchedule,
    IDS.weekOne,
    WEEK_ONE_STARTS_AT_MS,
    STARTS_AT_MS - 86_400_000,
    `${OCCURRENCE_KEY}:old`,
    IDS.commissioner,
    IDS.membership,
    "superseded",
    IDS.occurrence,
    uuid(90),
    IDS.oldScheduleOperation,
    null,
    STARTS_AT_MS - 100_000,
    2,
    2
  );
  database.prepare(
    `INSERT INTO job_runs
     VALUES (?, ?, ?, 'league:entry_draft_rollover', ?,
       ?, 'running', 1, 'worker-a', 'lease-a', 3)`
  ).run(
    IDS.jobRun,
    IDS.league,
    IDS.targetSeason,
    OCCURRENCE_KEY,
    STARTS_AT_MS
  );
}

function scheduledAttemptCommand() {
  return {
    attemptId: IDS.scheduledAttempt,
    bindingId: IDS.binding,
    leagueId: IDS.league,
    entryDraftId: IDS.entryDraft,
    rolloverOccurrenceId: IDS.occurrence,
    fromSeasonId: IDS.sourceSeason,
    toSeasonId: IDS.targetSeason,
    targetScheduleId: IDS.targetSchedule,
    targetScheduleVersion: 7,
    weekOneMatchupWeekId: IDS.weekOne,
    weekOneStartsAtMs: WEEK_ONE_STARTS_AT_MS,
    expectedBindingVersion: 1,
    expectedPriorAttemptId: null,
    expectedPriorAttemptNumber: 0,
    triggerKind: "scheduled_job",
    scheduledJob: {
      runId: IDS.jobRun,
      occurrenceKey: OCCURRENCE_KEY,
      scheduledForMs: STARTS_AT_MS,
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      expectedVersion: 3,
    },
    retryIdempotencyRequestId: null,
    retryActorUserId: null,
    retryActorMembershipId: null,
    retryAuthority: null,
    startedAtMs: STARTS_AT_MS,
    observedSourceSeasonVersion: 4,
    observedTargetSeasonVersion: 3,
    observedEntryDraftVersion: 2,
  };
}

function blockers() {
  return [
    {
      code: "FAD_READINESS_MISSING",
      field: "status",
      resourceType: "free_agent_draft",
      resourceId: IDS.sourceFad,
      message:
        "The source Free Agent Draft is not ready.",
    },
  ];
}

function emptySummary() {
  return {
    contractsAdvanced: 0,
    contractsExpired: 0,
    ownershipsCarried: 0,
    ownershipsReleased: 0,
    retentionYearsAdvanced: 0,
    retentionObligationsCompleted: 0,
    buyoutYearsAdvanced: 0,
    buyoutObligationsCompleted: 0,
    tradesCancelled: 0,
  };
}

function successPlan() {
  const projection = {
    leagueId: IDS.league,
    fromSeasonId: IDS.sourceSeason,
    observedAtMs: COMPLETED_AT_MS,
    sourceFadId: IDS.sourceFad,
    sourceFadCompletedAtMs:
      Date.parse("2027-05-01T07:00:00.000Z"),
    sourceFinalizationRootId:
      IDS.finalizationRoot,
    sourceFinalizationId: IDS.finalization,
    sourceStandingsSnapshotId:
      IDS.standingsSnapshot,
    sourceStandingsOperationId:
      IDS.standingsOperation,
  };
  const projectionJson =
    serializeSeasonRolloverSourceReadiness(
      projection
    );
  return {
    transitionType:
      "retry_scheduled_entry_draft_rollover",
    triggerKind: "commissioner_retry",
    rolloverId: IDS.rollover,
    attemptId: IDS.retryAttempt,
    bindingId: IDS.binding,
    leagueId: IDS.league,
    entryDraftId: IDS.entryDraft,
    rolloverOccurrenceId: IDS.occurrence,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledStartsAtMs: STARTS_AT_MS,
    scheduledJobRunId: null,
    idempotencyRequestId:
      IDS.retryIdempotency,
    requestHash: "a".repeat(64),
    authorizedByUserId: IDS.commissioner,
    authorizedByMembershipId: IDS.membership,
    authorizedAuthority: "commissioner",
    scheduleAuthorizedByUserId:
      IDS.commissioner,
    scheduleAuthorizedByMembershipId:
      IDS.membership,
    scheduleAuthorizedAuthority:
      "commissioner",
    completedAtMs: COMPLETED_AT_MS,
    leagueVersionBefore: 8,
    leagueVersionAfter: 9,
    source: {
      id: IDS.sourceSeason,
      label: "2026-27",
      nhlSeasonKey: "20262027",
      versionBefore: 4,
      versionAfter: 5,
      freeAgentDraftCompletedAtMs:
        projection.sourceFadCompletedAtMs,
    },
    target: {
      id: IDS.targetSeason,
      label: "2027-28",
      nhlSeasonKey: "20272028",
      nhlRegularSeasonStartsAtMs:
        Date.parse("2027-10-01T07:00:00.000Z"),
      nhlRegularSeasonEndsAtMs:
        Date.parse("2028-04-30T07:00:00.000Z"),
      fantasyPlayoffsStartAtMs:
        Date.parse("2028-03-01T08:00:00.000Z"),
      fantasyPlayoffsEndAtMs:
        Date.parse("2028-04-30T07:00:00.000Z"),
      targetScheduleId: IDS.targetSchedule,
      targetScheduleVersion: 7,
      weekOneMatchupWeekId: IDS.weekOne,
      weekOneStartsAtMs: WEEK_ONE_STARTS_AT_MS,
      versionBefore: 3,
      versionAfter: 4,
      created: false,
    },
    targetSchedule: {
      id: IDS.targetSchedule,
      version: 7,
      weekOneMatchupWeekId: IDS.weekOne,
      weekOneStartsAtMs: WEEK_ONE_STARTS_AT_MS,
    },
    entryDraft: {
      id: IDS.entryDraft,
      statusBefore: "ready",
      statusAfter: "active",
      versionBefore: 2,
      versionAfter: 3,
      selectionGateStatusBefore: "locked",
      selectionGateStatusAfter: "open",
      tradingGateStatusBefore: "locked",
      tradingGateStatusAfter: "open",
    },
    firstPickClock: {
      id: IDS.firstClock,
      draftPickId: IDS.firstPick,
      owningTeamId: IDS.firstPickOwner,
      draftPickVersionBefore: 1,
      draftPickVersionAfter: 2,
      roundNumber: 1,
      positionNumber: 1,
      startsAtMs: COMPLETED_AT_MS,
      expiresAtMs: COMPLETED_AT_MS + 300_000,
      fullClockSeconds: 300,
    },
    bindingVersionBefore: 2,
    bindingVersionAfter: 3,
    sourceReadiness: {
      schemaVersion: 1,
      projection,
      projectionJson,
      projectionSha256:
        hashSeasonRolloverSourceReadiness(
          projection
        ),
    },
    summary: emptySummary(),
    effects: {
      contracts: [],
      ownerships: [],
      retentions: [],
      buyouts: [],
      trades: [],
    },
    aggregateActivity: {
      id: IDS.aggregateActivity,
      eventType: "season_rolled_over",
      leagueId: IDS.league,
      seasonId: IDS.targetSeason,
      actorUserId: IDS.commissioner,
      actorAuthority: "commissioner",
      teamId: null,
      playerId: null,
      relatedType: "season",
      relatedId: IDS.targetSeason,
      displaySummary:
        "Season 2026-27 completed; 2027-28 is now active.",
      reason: null,
      metadata: {
        rolloverId: IDS.rollover,
      },
      occurredAtMs: COMPLETED_AT_MS,
    },
    securityAudit: {
      id: IDS.securityAudit,
      eventType: "league.season_rolled_over",
      outcome: "success",
      actorUserId: IDS.commissioner,
      targetUserId: null,
      leagueId: IDS.league,
      sessionId: null,
      requestCorrelationId: null,
      reasonCode:
        "season_rollover_retry_authorized",
      networkKeyVersion: null,
      networkMetadataDigest: null,
      clientMetadataJson: null,
      unknownAccountDigest: null,
      occurredAtMs: COMPLETED_AT_MS,
    },
    outbox: {
      id: IDS.outbox,
      eventType: "league.changed",
      aggregateType: "league",
      aggregateId: IDS.league,
      scope: "league",
      leagueId: IDS.league,
      changedAtMs: COMPLETED_AT_MS,
    },
  };
}

function rolloverContextCommand() {
  return {
    leagueId: IDS.league,
    bindingId: IDS.binding,
    entryDraftId: IDS.entryDraft,
    rolloverOccurrenceId: IDS.occurrence,
    fromSeasonId: IDS.sourceSeason,
    toSeasonId: IDS.targetSeason,
    targetScheduleId: IDS.targetSchedule,
    observedAtMs: COMPLETED_AT_MS,
  };
}

function closedSourceFixture() {
  const ids = {
    teamA: IDS.firstPickOwner,
    teamB: uuid(101),
    cardA: uuid(102),
    cardB: uuid(103),
    snapshotA: uuid(104),
    snapshotB: uuid(105),
    readinessOperation: uuid(106),
    rolloverBase: 110,
    auction: uuid(120),
    auctionResolution: uuid(121),
    matchupWeek: uuid(122),
    matchup: uuid(123),
    matchupResult: uuid(124),
    matchupResultVersion: uuid(125),
    standingsSnapshot: IDS.standingsSnapshot,
    standingsOperation: IDS.standingsOperation,
    standingsFinalization: IDS.finalizationRoot,
    standingsIdempotency: uuid(126),
    standingsRowA: uuid(127),
    standingsRowB: uuid(128),
    standingsIdentityA: uuid(129),
    standingsIdentityB: uuid(130),
    standingsResultLink: uuid(131),
    matchupJob: uuid(160),
    matchupJobBinding: uuid(161),
    supersededScheduleOperation: uuid(162),
    currentScheduleOperation: uuid(163),
  };
  const fadCompletedAtMs = Date.parse(
    "2027-05-01T07:00:00.000Z"
  );
  const finalizedAtMs = Date.parse(
    "2027-05-02T07:00:00.000Z"
  );
  const matchupJobCreatedAtMs = Date.parse(
    "2026-09-01T07:00:00.000Z"
  );
  const scheduleSupersededAtMs = Date.parse(
    "2026-09-02T07:00:00.000Z"
  );
  const matchupJobScheduledForMs = Date.parse(
    "2026-10-01T08:00:00.000Z"
  );
  const matchupJobType = "matchup:baseline";
  const matchupOccurrenceKey =
    `${matchupJobType}:${IDS.league}:` +
    `${IDS.sourceSeason}:${ids.matchupWeek}:` +
    `${ids.supersededScheduleOperation}:1:` +
    `${matchupJobScheduledForMs}`;
  const resultDescriptor = {
    matchupId: ids.matchup,
    matchupResultId: ids.matchupResult,
    resultVersionId: ids.matchupResultVersion,
    resultVersion: 1,
  };
  const resultSetHash =
    calculateStandingsResultSetHash({
      leagueId: IDS.league,
      seasonId: IDS.sourceSeason,
      standingsRuleVersion: "1",
      results: [resultDescriptor],
    });
  const fad = {
    id: IDS.sourceFad,
    league_id: IDS.league,
    season_id: IDS.sourceSeason,
    status: "completed",
    readiness_operation_id:
      ids.readinessOperation,
    participating_team_count: 2,
    deadline_locked_at_ms:
      fadCompletedAtMs - 8 * 86_400_000,
    allocation_completed_at_ms:
      fadCompletedAtMs - 7 * 86_400_000,
    completed_at_ms: fadCompletedAtMs,
  };
  const finalization = {
    id: ids.standingsFinalization,
    league_id: IDS.league,
    season_id: IDS.sourceSeason,
    standings_snapshot_id:
      ids.standingsSnapshot,
    standings_operation_id:
      ids.standingsOperation,
    idempotency_request_id:
      ids.standingsIdempotency,
    status: "final",
    cause: "regular_season_completion",
    finalization_version: 1,
    replaces_finalization_id: null,
    superseded_by_snapshot_id: null,
    superseded_by_operation_id: null,
    superseded_by_user_id: null,
    superseded_by_membership_id: null,
    superseded_by_authority: null,
    evidence_schema_version: 1,
    result_set_hash_version: 1,
    result_set_hash: resultSetHash,
    standings_rule_version: 1,
    completeness_status: "complete",
    finalized_matchup_count: 1,
    expected_matchup_count: 1,
    weeks_counted: 1,
    expected_week_count: 1,
    standings_row_count: 2,
    participant_count: 2,
    finalized_at_ms: finalizedAtMs,
    authorized_by_user_id: IDS.commissioner,
    authorized_by_membership_id: IDS.membership,
    authorized_authority: "commissioner",
  };
  const tables = {
    free_agent_drafts: [fad],
    free_agent_draft_readiness_operations: [
      {
        id: ids.readinessOperation,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        status: "succeeded",
        created_fad_id: IDS.sourceFad,
        terminal_at_ms:
          fadCompletedAtMs - 9 * 86_400_000,
      },
    ],
    free_agent_draft_teams: [
      {
        id: uuid(132),
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        fad_id: IDS.sourceFad,
        team_id: ids.teamA,
        team_status_at_setup: "active",
        created_at_ms:
          fadCompletedAtMs - 10 * 86_400_000,
      },
      {
        id: uuid(133),
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        fad_id: IDS.sourceFad,
        team_id: ids.teamB,
        team_status_at_setup: "active",
        created_at_ms:
          fadCompletedAtMs - 10 * 86_400_000,
      },
    ],
    candidate_cards: [
      {
        id: ids.cardA,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        fad_id: IDS.sourceFad,
        team_id: ids.teamA,
        status: "locked_complete",
        locked_at_ms:
          fadCompletedAtMs - 8 * 86_400_000,
      },
      {
        id: ids.cardB,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        fad_id: IDS.sourceFad,
        team_id: ids.teamB,
        status: "locked_complete",
        locked_at_ms:
          fadCompletedAtMs - 8 * 86_400_000,
      },
    ],
    candidate_card_snapshots: [
      {
        id: ids.snapshotA,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        fad_id: IDS.sourceFad,
        card_id: ids.cardA,
        team_id: ids.teamA,
        locked_status: "locked_complete",
      },
      {
        id: ids.snapshotB,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        fad_id: IDS.sourceFad,
        card_id: ids.cardB,
        team_id: ids.teamB,
        locked_status: "locked_complete",
      },
    ],
    free_agent_draft_rollovers: Array.from(
      { length: 7 },
      (_, index) => ({
        id: uuid(ids.rolloverBase + index),
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        fad_id: IDS.sourceFad,
        sequence: index + 1,
        status: "completed",
        completed_at_ms:
          fadCompletedAtMs -
          (6 - index) * 86_400_000,
      })
    ),
    auction_contexts: [
      {
        id: ids.auction,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        auction_id: ids.auction,
        source_kind: "ordinary_weekly",
        fad_id: null,
      },
    ],
    auctions: [
      {
        id: ids.auction,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        status: "resolved",
      },
    ],
    auction_resolutions: [
      {
        id: ids.auctionResolution,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        auction_id: ids.auction,
        status: "resolved",
      },
    ],
    matchup_weeks: [
      {
        id: ids.matchupWeek,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        sequence: 1,
        status: "final",
      },
    ],
    matchups: [
      {
        id: ids.matchup,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        matchup_week_id: ids.matchupWeek,
        home_team_id: ids.teamA,
        away_team_id: ids.teamB,
        status: "final",
      },
    ],
    matchup_results: [
      {
        id: ids.matchupResult,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        matchup_id: ids.matchup,
        current_version_id:
          ids.matchupResultVersion,
        status: "official",
        finalized_at_ms: finalizedAtMs,
      },
    ],
    matchup_result_versions: [
      {
        id: ids.matchupResultVersion,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        matchup_result_id: ids.matchupResult,
        version_number: 1,
        home_team_id: ids.teamA,
        away_team_id: ids.teamB,
      },
    ],
    job_runs: [
      {
        id: ids.matchupJob,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        job_type: matchupJobType,
        occurrence_key: matchupOccurrenceKey,
        scheduled_for_ms:
          matchupJobScheduledForMs,
        status: "skipped",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at_ms: null,
        started_at_ms: null,
        completed_at_ms: null,
        result_json: null,
        last_error_code: null,
        created_at_ms: matchupJobCreatedAtMs,
        updated_at_ms:
          scheduleSupersededAtMs,
        version: 2,
        lease_token: null,
        next_attempt_at_ms: null,
      },
    ],
    matchup_schedule_job_bindings: [
      {
        id: ids.matchupJobBinding,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        job_run_id: ids.matchupJob,
        job_type: matchupJobType,
        schedule_operation_id:
          ids.supersededScheduleOperation,
        schedule_version: 1,
        owning_matchup_week_id:
          ids.matchupWeek,
        owning_matchup_id: null,
        created_at_ms: matchupJobCreatedAtMs,
        version: 1,
      },
    ],
    season_matchup_schedule_generations: [
      {
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        schedule_version: 1,
        schedule_operation_id:
          ids.supersededScheduleOperation,
        week_one_matchup_week_id:
          ids.matchupWeek,
        week_one_starts_at_ms:
          matchupJobScheduledForMs,
        status: "superseded",
        created_at_ms:
          matchupJobCreatedAtMs - 1,
        superseded_at_ms:
          scheduleSupersededAtMs,
        version: 2,
      },
      {
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        schedule_version: 2,
        schedule_operation_id:
          ids.currentScheduleOperation,
        week_one_matchup_week_id:
          ids.matchupWeek,
        week_one_starts_at_ms:
          matchupJobScheduledForMs +
          7 * 86_400_000,
        status: "current",
        created_at_ms:
          scheduleSupersededAtMs,
        superseded_at_ms: null,
        version: 1,
      },
    ],
    standings_operations: [
      {
        id: ids.standingsOperation,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        operation_type:
          "finalize_regular_season",
        status: "succeeded",
        standings_snapshot_id:
          ids.standingsSnapshot,
        started_at_ms: finalizedAtMs - 1,
        completed_at_ms: finalizedAtMs,
      },
    ],
    standings_snapshot_finalizations: [
      finalization,
    ],
    standings_snapshots: [
      {
        id: ids.standingsSnapshot,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        snapshot_version: 1,
        source_result_version: 1,
        status: "final",
        calculated_at_ms: finalizedAtMs,
      },
    ],
    standings_rows: [
      {
        id: ids.standingsRowA,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        standings_snapshot_id:
          ids.standingsSnapshot,
        team_id: ids.teamA,
        rank: 1,
      },
      {
        id: ids.standingsRowB,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        standings_snapshot_id:
          ids.standingsSnapshot,
        team_id: ids.teamB,
        rank: 2,
      },
    ],
    standings_snapshot_team_identities: [
      {
        id: ids.standingsIdentityA,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        standings_snapshot_id:
          ids.standingsSnapshot,
        team_id: ids.teamA,
        logo_content_bytes: null,
        logo_byte_length: null,
        logo_content_sha256: null,
      },
      {
        id: ids.standingsIdentityB,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        standings_snapshot_id:
          ids.standingsSnapshot,
        team_id: ids.teamB,
        logo_content_bytes: null,
        logo_byte_length: null,
        logo_content_sha256: null,
      },
    ],
    standings_snapshot_result_versions: [
      {
        id: ids.standingsResultLink,
        league_id: IDS.league,
        season_id: IDS.sourceSeason,
        standings_snapshot_id:
          ids.standingsSnapshot,
        matchup_id: ids.matchup,
        matchup_result_id: ids.matchupResult,
        matchup_result_version_id:
          ids.matchupResultVersion,
        result_version_number: 1,
      },
    ],
    idempotency_requests: [
      {
        id: ids.standingsIdempotency,
        league_id: IDS.league,
        status: "completed",
        operation:
          "standings.finalize_regular_season.v1",
        result_type: "standings_finalization",
        result_id: ids.standingsFinalization,
      },
    ],
  };
  return {
    ids,
    tables,
    aggregateRow: {
      league_id: IDS.league,
      league_status: "active",
      league_timezone: "America/Vancouver",
      league_version: 8,
      current_season_id: IDS.sourceSeason,
      source_status: "active",
      source_version: 4,
      source_label: "2026-27",
      source_nhl_season_key: "20262027",
      source_regular_starts_at_ms:
        Date.parse("2026-10-01T07:00:00.000Z"),
      source_regular_ends_at_ms:
        Date.parse("2027-04-30T07:00:00.000Z"),
      source_playoffs_starts_at_ms:
        Date.parse("2027-03-01T08:00:00.000Z"),
      source_playoffs_ends_at_ms:
        Date.parse("2027-04-30T07:00:00.000Z"),
      source_fad_completed_at_ms: fadCompletedAtMs,
      target_id: IDS.targetSeason,
      target_status: "planned",
      target_version: 3,
      target_label: "2027-28",
      target_nhl_season_key: "20272028",
      target_regular_starts_at_ms:
        Date.parse("2027-10-01T07:00:00.000Z"),
      target_regular_ends_at_ms:
        Date.parse("2028-04-30T07:00:00.000Z"),
      target_playoffs_starts_at_ms:
        Date.parse("2028-03-01T08:00:00.000Z"),
      target_playoffs_ends_at_ms:
        Date.parse("2028-04-30T07:00:00.000Z"),
      target_fad_completed_at_ms: null,
      target_schedule_version: 7,
      week_one_matchup_week_id: IDS.weekOne,
      week_one_starts_at_ms:
        WEEK_ONE_STARTS_AT_MS,
      selection_gate_status: "locked",
      trading_gate_status: "locked",
      scheduled_by_user_id: IDS.commissioner,
      scheduled_by_membership_id: IDS.membership,
      scheduled_by_authority: "commissioner",
      draft_status: "ready",
      draft_version: 2,
      starts_at_ms: STARTS_AT_MS,
      pick_clock_seconds: 300,
    },
    firstPickRow: {
      id: IDS.firstPick,
      current_owner_team_id: ids.teamA,
      round_number: 1,
      position_number: 1,
      version: 1,
      status: "unused",
    },
    targetDisallowedCount: 0,
  };
}

function nonzeroRolloverSchema(database) {
  database.exec(`
    CREATE TABLE contracts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      current_team_id TEXT NOT NULL,
      contract_type TEXT NOT NULL,
      original_total_value_cents INTEGER NOT NULL,
      original_term_years INTEGER NOT NULL,
      aav_cents INTEGER NOT NULL,
      start_season_id TEXT NOT NULL,
      status TEXT NOT NULL,
      acquisition_source_type TEXT NOT NULL,
      acquisition_source_id TEXT,
      auction_buyout_lock_expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE contract_years (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      year_number INTEGER NOT NULL,
      aav_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      rollover_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE player_ownerships (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      ownership_kind TEXT NOT NULL,
      roster_category TEXT NOT NULL,
      position_group TEXT NOT NULL,
      slot_number INTEGER,
      acquired_transaction_type TEXT NOT NULL,
      acquired_transaction_id TEXT,
      trade_blocked INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE roster_display_order_sets (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      team_id TEXT NOT NULL
    );
    CREATE TABLE roster_display_order_entries (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      order_set_id TEXT NOT NULL,
      ownership_id TEXT NOT NULL,
      position_group TEXT NOT NULL,
      display_order INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE retention_obligations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      originating_team_id TEXT NOT NULL,
      responsible_team_id TEXT NOT NULL,
      retained_aav_cents INTEGER NOT NULL,
      creation_trade_id TEXT,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE retention_years (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      retention_obligation_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      retained_aav_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE buyout_obligations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      originating_team_id TEXT NOT NULL,
      responsible_team_id TEXT NOT NULL,
      annual_penalty_basis_cents INTEGER NOT NULL,
      buyout_transaction_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE buyout_years (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      buyout_obligation_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      penalty_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE trades (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      proposing_team_id TEXT NOT NULL,
      receiving_team_id TEXT NOT NULL,
      proposing_user_id TEXT NOT NULL,
      creating_membership_id TEXT NOT NULL,
      creating_authority TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      effective_deadline_at_ms INTEGER NOT NULL,
      responded_at_ms INTEGER,
      completed_at_ms INTEGER,
      commissioner_completion_reference TEXT,
      proposal_model_version INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE trade_assets (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      source_team_id TEXT NOT NULL,
      destination_team_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      contract_id TEXT,
      player_id TEXT,
      draft_pick_id TEXT,
      retention_obligation_id TEXT,
      buyout_obligation_id TEXT,
      future_consideration_id TEXT,
      requested_retention_contract_id TEXT,
      requested_retention_cents INTEGER,
      future_consideration_description TEXT,
      proposal_snapshot_json TEXT,
      asset_model_version INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE contract_events (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      actor_user_id TEXT,
      event_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      reason TEXT,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE ownership_events (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      ownership_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_user_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      before_metadata_json TEXT NOT NULL,
      after_metadata_json TEXT NOT NULL,
      reason TEXT,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE trade_events (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      actor_user_id TEXT,
      event_type TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL
    );
  `);
}

function nonzeroRolloverFixture() {
  const fixture = closedSourceFixture();
  const ids = {
    advancedContract: uuid(400),
    advancedPlayer: uuid(401),
    expiringContract: uuid(402),
    expiringPlayer: uuid(403),
    eliminatedAdvancedContract: uuid(404),
    eliminatedAdvancedPlayer: uuid(405),
    eliminatedCompletedContract: uuid(406),
    eliminatedCompletedPlayer: uuid(407),
    advancedOwnership: uuid(408),
    expiringOwnership: uuid(409),
    prospectOwnership: uuid(410),
    prospectPlayer: uuid(411),
    teamAOrderSet: uuid(412),
    teamBOrderSet: uuid(413),
    advancedDisplay: uuid(414),
    expiringDisplay: uuid(415),
    prospectDisplay: uuid(416),
    retentionAdvanced: uuid(417),
    retentionCompleted: uuid(418),
    buyoutAdvanced: uuid(419),
    buyoutCompleted: uuid(420),
    proposedTrade: uuid(421),
    tradeAsset: uuid(422),
  };
  Object.assign(fixture.ids, ids);
  const createdAtMs = 100;
  const updatedAtMs = 200;
  const contract = ({
    id,
    playerId,
    teamId,
    total,
    term,
    status,
  }) => ({
    id,
    league_id: IDS.league,
    player_id: playerId,
    current_team_id: teamId,
    contract_type: "standard",
    original_total_value_cents: total,
    original_term_years: term,
    aav_cents: total / term,
    start_season_id: IDS.sourceSeason,
    status,
    acquisition_source_type: "candidate_card",
    acquisition_source_id: uuid(423),
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    version: 1,
  });
  fixture.tables.contracts = [
    contract({
      id: ids.advancedContract,
      playerId: ids.advancedPlayer,
      teamId: fixture.ids.teamA,
      total: 12_000_000,
      term: 2,
      status: "active",
    }),
    contract({
      id: ids.expiringContract,
      playerId: ids.expiringPlayer,
      teamId: fixture.ids.teamB,
      total: 4_000_000,
      term: 1,
      status: "active",
    }),
    contract({
      id: ids.eliminatedAdvancedContract,
      playerId: ids.eliminatedAdvancedPlayer,
      teamId: fixture.ids.teamA,
      total: 4_000_000,
      term: 2,
      status: "eliminated",
    }),
    contract({
      id: ids.eliminatedCompletedContract,
      playerId: ids.eliminatedCompletedPlayer,
      teamId: fixture.ids.teamB,
      total: 1_000_000,
      term: 1,
      status: "eliminated",
    }),
  ];
  const contractYear = ({
    id,
    contractId,
    seasonId,
    number,
    aav,
    status,
  }) => ({
    id,
    league_id: IDS.league,
    contract_id: contractId,
    season_id: seasonId,
    year_number: number,
    aav_cents: aav,
    status,
    rollover_at_ms: null,
    created_at_ms: createdAtMs,
  });
  fixture.tables.contract_years = [
    contractYear({
      id: uuid(424),
      contractId: ids.advancedContract,
      seasonId: IDS.sourceSeason,
      number: 1,
      aav: 6_000_000,
      status: "current",
    }),
    contractYear({
      id: uuid(425),
      contractId: ids.advancedContract,
      seasonId: IDS.targetSeason,
      number: 2,
      aav: 6_000_000,
      status: "future",
    }),
    contractYear({
      id: uuid(426),
      contractId: ids.expiringContract,
      seasonId: IDS.sourceSeason,
      number: 1,
      aav: 4_000_000,
      status: "current",
    }),
    contractYear({
      id: uuid(427),
      contractId: ids.eliminatedAdvancedContract,
      seasonId: IDS.sourceSeason,
      number: 1,
      aav: 2_000_000,
      status: "eliminated",
    }),
    contractYear({
      id: uuid(428),
      contractId: ids.eliminatedAdvancedContract,
      seasonId: IDS.targetSeason,
      number: 2,
      aav: 2_000_000,
      status: "eliminated",
    }),
    contractYear({
      id: uuid(429),
      contractId: ids.eliminatedCompletedContract,
      seasonId: IDS.sourceSeason,
      number: 1,
      aav: 1_000_000,
      status: "eliminated",
    }),
  ];
  const ownership = ({
    id,
    playerId,
    teamId,
    kind,
    category,
    position,
    slot,
  }) => ({
    id,
    league_id: IDS.league,
    season_id: IDS.sourceSeason,
    player_id: playerId,
    team_id: teamId,
    ownership_kind: kind,
    roster_category: category,
    position_group: position,
    slot_number: slot,
    acquired_transaction_type: "candidate_card",
    acquired_transaction_id: uuid(430),
    trade_blocked: 0,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    version: 1,
  });
  fixture.tables.player_ownerships = [
    ownership({
      id: ids.advancedOwnership,
      playerId: ids.advancedPlayer,
      teamId: fixture.ids.teamA,
      kind: "Rostered",
      category: "Active",
      position: "F",
      slot: 1,
    }),
    ownership({
      id: ids.expiringOwnership,
      playerId: ids.expiringPlayer,
      teamId: fixture.ids.teamB,
      kind: "Rostered",
      category: "Active",
      position: "D",
      slot: 1,
    }),
    ownership({
      id: ids.prospectOwnership,
      playerId: ids.prospectPlayer,
      teamId: fixture.ids.teamA,
      kind: "Prospect Right",
      category: "Prospect",
      position: "F",
      slot: null,
    }),
  ];
  fixture.tables.roster_display_order_sets = [
    {
      id: ids.teamAOrderSet,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      team_id: fixture.ids.teamA,
    },
    {
      id: ids.teamBOrderSet,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      team_id: fixture.ids.teamB,
    },
  ];
  fixture.tables.roster_display_order_entries = [
    {
      id: ids.advancedDisplay,
      league_id: IDS.league,
      order_set_id: ids.teamAOrderSet,
      ownership_id: ids.advancedOwnership,
      position_group: "F",
      display_order: 1,
      created_at_ms: createdAtMs,
    },
    {
      id: ids.prospectDisplay,
      league_id: IDS.league,
      order_set_id: ids.teamAOrderSet,
      ownership_id: ids.prospectOwnership,
      position_group: "F",
      display_order: 2,
      created_at_ms: createdAtMs,
    },
    {
      id: ids.expiringDisplay,
      league_id: IDS.league,
      order_set_id: ids.teamBOrderSet,
      ownership_id: ids.expiringOwnership,
      position_group: "D",
      display_order: 1,
      created_at_ms: createdAtMs,
    },
  ];
  const retention = ({
    id,
    contractId,
    playerId,
    originatingTeamId,
    responsibleTeamId,
  }) => ({
    id,
    league_id: IDS.league,
    contract_id: contractId,
    player_id: playerId,
    originating_team_id: originatingTeamId,
    responsible_team_id: responsibleTeamId,
    retained_aav_cents: 500_000,
    creation_trade_id: null,
    status: "active",
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    version: 1,
  });
  fixture.tables.retention_obligations = [
    retention({
      id: ids.retentionAdvanced,
      contractId: ids.advancedContract,
      playerId: ids.advancedPlayer,
      originatingTeamId: fixture.ids.teamB,
      responsibleTeamId: fixture.ids.teamA,
    }),
    retention({
      id: ids.retentionCompleted,
      contractId: ids.expiringContract,
      playerId: ids.expiringPlayer,
      originatingTeamId: fixture.ids.teamA,
      responsibleTeamId: fixture.ids.teamB,
    }),
  ];
  const retentionYear = ({
    id,
    obligationId,
    seasonId,
    status,
  }) => ({
    id,
    league_id: IDS.league,
    retention_obligation_id: obligationId,
    season_id: seasonId,
    retained_aav_cents: 500_000,
    status,
    created_at_ms: createdAtMs,
  });
  fixture.tables.retention_years = [
    retentionYear({
      id: uuid(431),
      obligationId: ids.retentionAdvanced,
      seasonId: IDS.sourceSeason,
      status: "current",
    }),
    retentionYear({
      id: uuid(432),
      obligationId: ids.retentionAdvanced,
      seasonId: IDS.targetSeason,
      status: "future",
    }),
    retentionYear({
      id: uuid(433),
      obligationId: ids.retentionCompleted,
      seasonId: IDS.sourceSeason,
      status: "current",
    }),
  ];
  const buyout = ({
    id,
    contractId,
    playerId,
    originatingTeamId,
    responsibleTeamId,
  }) => ({
    id,
    league_id: IDS.league,
    contract_id: contractId,
    player_id: playerId,
    originating_team_id: originatingTeamId,
    responsible_team_id: responsibleTeamId,
    annual_penalty_basis_cents: 250_000,
    buyout_transaction_id: uuid(434),
    status: "active",
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    version: 1,
  });
  fixture.tables.buyout_obligations = [
    buyout({
      id: ids.buyoutAdvanced,
      contractId: ids.eliminatedAdvancedContract,
      playerId: ids.eliminatedAdvancedPlayer,
      originatingTeamId: fixture.ids.teamA,
      responsibleTeamId: fixture.ids.teamA,
    }),
    buyout({
      id: ids.buyoutCompleted,
      contractId: ids.eliminatedCompletedContract,
      playerId: ids.eliminatedCompletedPlayer,
      originatingTeamId: fixture.ids.teamB,
      responsibleTeamId: fixture.ids.teamB,
    }),
  ];
  const buyoutYear = ({
    id,
    obligationId,
    seasonId,
    status,
  }) => ({
    id,
    league_id: IDS.league,
    buyout_obligation_id: obligationId,
    season_id: seasonId,
    penalty_cents: 250_000,
    status,
    created_at_ms: createdAtMs,
  });
  fixture.tables.buyout_years = [
    buyoutYear({
      id: uuid(435),
      obligationId: ids.buyoutAdvanced,
      seasonId: IDS.sourceSeason,
      status: "current",
    }),
    buyoutYear({
      id: uuid(436),
      obligationId: ids.buyoutAdvanced,
      seasonId: IDS.targetSeason,
      status: "future",
    }),
    buyoutYear({
      id: uuid(437),
      obligationId: ids.buyoutCompleted,
      seasonId: IDS.sourceSeason,
      status: "current",
    }),
  ];
  fixture.tables.trades = [
    {
      id: ids.proposedTrade,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      proposing_team_id: fixture.ids.teamA,
      receiving_team_id: fixture.ids.teamB,
      proposing_user_id: IDS.commissioner,
      creating_membership_id: IDS.membership,
      creating_authority: "commissioner",
      status: "proposed",
      created_at_ms: createdAtMs,
      expires_at_ms: STARTS_AT_MS + 50_000,
      effective_deadline_at_ms: STARTS_AT_MS,
      responded_at_ms: null,
      completed_at_ms: null,
      commissioner_completion_reference: null,
      proposal_model_version: 1,
      updated_at_ms: updatedAtMs,
      version: 1,
    },
  ];
  fixture.tables.trade_assets = [
    {
      id: ids.tradeAsset,
      league_id: IDS.league,
      trade_id: ids.proposedTrade,
      direction: "proposing_to_receiving",
      source_team_id: fixture.ids.teamA,
      destination_team_id: fixture.ids.teamB,
      asset_type: "contract",
      contract_id: ids.expiringContract,
      player_id: null,
      draft_pick_id: null,
      retention_obligation_id: null,
      buyout_obligation_id: null,
      future_consideration_id: null,
      requested_retention_contract_id: null,
      requested_retention_cents: null,
      future_consideration_description: null,
      proposal_snapshot_json: null,
      asset_model_version: 1,
      sequence: 1,
      created_at_ms: createdAtMs,
    },
  ];
  return fixture;
}

function seedRolloverMatrixRows(database, fixture) {
  const tableNames = [
    "contracts",
    "contract_years",
    "player_ownerships",
    "roster_display_order_sets",
    "roster_display_order_entries",
    "retention_obligations",
    "retention_years",
    "buyout_obligations",
    "buyout_years",
    "trades",
    "trade_assets",
  ];
  for (const tableName of tableNames) {
    for (const row of fixture.tables[tableName]) {
      insertFullSchemaRow(
        database,
        tableName,
        row
      );
    }
  }
}

function nonzeroSuccessPlan(matrix, sourceReadiness) {
  const plan = successPlan();
  plan.sourceReadiness = sourceReadiness;
  let nextIdValue = 500;
  const nextId = () => uuid(nextIdValue++);
  const clone = (value) =>
    JSON.parse(JSON.stringify(value));
  const prepareYearEffect = (
    effect,
    advancedKind
  ) => {
    const before = effect.before;
    const sourceYear = before.years.find(
      ({ seasonId, status }) =>
        seasonId === IDS.sourceSeason &&
        status === "current"
    );
    const targetYear =
      before.years.find(
        ({ seasonId }) =>
          seasonId === IDS.targetSeason
      ) ?? null;
    const after = clone(before);
    after.status =
      effect.effectKind === advancedKind
        ? "active"
        : effect.effectKind.startsWith("contract_")
          ? "expired"
          : "completed";
    after.updatedAtMs = COMPLETED_AT_MS;
    after.version = before.version + 1;
    const afterSource = after.years.find(
      ({ id }) => id === sourceYear.id
    );
    afterSource.status =
      effect.effectKind === "contract_expired"
        ? "expired"
        : "completed";
    if (
      Object.prototype.hasOwnProperty.call(
        afterSource,
        "rolloverAtMs"
      )
    ) {
      afterSource.rolloverAtMs =
        COMPLETED_AT_MS;
    }
    if (targetYear) {
      const afterTarget = after.years.find(
        ({ id }) => id === targetYear.id
      );
      afterTarget.status = "current";
      if (
        Object.prototype.hasOwnProperty.call(
          afterTarget,
          "rolloverAtMs"
        )
      ) {
        afterTarget.rolloverAtMs = null;
      }
    }
    return {
      ...effect,
      version: before.version,
      sourceYearId: sourceYear.id,
      targetYearId: targetYear?.id ?? null,
      after,
      itemId: nextId(),
      eventId:
        effect.effectKind.startsWith("contract_")
          ? nextId()
          : null,
      leagueActivityId:
        effect.effectKind === "contract_expired"
          ? nextId()
          : null,
    };
  };
  const contracts = matrix.contractEffects.map(
    (effect) =>
      prepareYearEffect(
        effect,
        "contract_advanced"
      )
  );
  const ownerships = matrix.ownershipEffects.map(
    (effect) => {
      const after = clone(effect.before);
      after.displayOrderEntries = [];
      after.updatedAtMs = COMPLETED_AT_MS;
      if (
        effect.effectKind === "ownership_carried"
      ) {
        after.seasonId = IDS.targetSeason;
        after.version = effect.before.version + 1;
      } else {
        after.exists = false;
        after.seasonId = null;
        after.version = null;
      }
      return {
        ...effect,
        version: effect.before.version,
        after,
        itemId: nextId(),
        eventId: nextId(),
        leagueActivityId: null,
      };
    }
  );
  const retentions = matrix.retentionEffects.map(
    (effect) =>
      prepareYearEffect(
        effect,
        "retention_year_advanced"
      )
  );
  const buyouts = matrix.buyoutEffects.map(
    (effect) =>
      prepareYearEffect(
        effect,
        "buyout_year_advanced"
      )
  );
  const itemByCause = new Map(
    [
      ...contracts,
      ...ownerships,
      ...retentions,
      ...buyouts,
    ].map((effect) => [
      `${effect.effectKind}:${effect.entityId}`,
      effect.itemId,
    ])
  );
  const trades = matrix.tradeEffects.map(
    (effect) => {
      const after = clone(effect.before);
      after.status = "cancelled";
      after.respondedAtMs = COMPLETED_AT_MS;
      after.updatedAtMs = COMPLETED_AT_MS;
      after.version = effect.before.version + 1;
      return {
        entityId: effect.entityId,
        version: effect.before.version,
        effectKind: effect.effectKind,
        before: effect.before,
        after,
        causalAssets: effect.causalEffects.map(
          (cause) => ({
            tradeAssetSequence:
              cause.tradeAssetSequence,
            tradeAssetType:
              cause.tradeAssetType,
            rolloverItemId: itemByCause.get(
              `${cause.effectKind}:${cause.entityId}`
            ),
          })
        ),
        itemId: nextId(),
        eventId: nextId(),
        leagueActivityId: nextId(),
      };
    }
  );
  plan.effects = {
    contracts,
    ownerships,
    retentions,
    buyouts,
    trades,
  };
  plan.summary = {
    contractsAdvanced: contracts.filter(
      ({ effectKind }) =>
        effectKind === "contract_advanced"
    ).length,
    contractsExpired: contracts.filter(
      ({ effectKind }) =>
        effectKind === "contract_expired"
    ).length,
    ownershipsCarried: ownerships.filter(
      ({ effectKind }) =>
        effectKind === "ownership_carried"
    ).length,
    ownershipsReleased: ownerships.filter(
      ({ effectKind }) =>
        effectKind === "ownership_released"
    ).length,
    retentionYearsAdvanced: retentions.filter(
      ({ effectKind }) =>
        effectKind === "retention_year_advanced"
    ).length,
    retentionObligationsCompleted:
      retentions.filter(
        ({ effectKind }) =>
          effectKind ===
          "retention_obligation_completed"
      ).length,
    buyoutYearsAdvanced: buyouts.filter(
      ({ effectKind }) =>
        effectKind === "buyout_year_advanced"
    ).length,
    buyoutObligationsCompleted: buyouts.filter(
      ({ effectKind }) =>
        effectKind ===
        "buyout_obligation_completed"
    ).length,
    tradesCancelled: trades.length,
  };
  return plan;
}

function readFixtureContext(fixture) {
  const preparedSql = [];
  const cloneRows = (rows) =>
    rows.map((row) => ({ ...row }));
  const database = {
    prepare(sql) {
      preparedSql.push(sql);
      const tableMatch =
        /\bFROM\s+([a-z_]+)/i.exec(sql);
      const tableName = tableMatch?.[1] ?? null;
      return {
        all() {
          if (
            sql.includes(
              "FROM entry_draft_rollover_bindings AS binding"
            )
          ) {
            return [{ ...fixture.aggregateRow }];
          }
          if (sql.includes("FROM draft_picks")) {
            return [{ ...fixture.firstPickRow }];
          }
          return cloneRows(
            fixture.tables[tableName] ?? []
          );
        },
        get() {
          if (sql.includes("AS identity_count")) {
            return {
              identity_count: 1,
              distinct_count: 1,
            };
          }
          if (sql.includes("AS disallowed_count")) {
            return {
              disallowed_count:
                fixture.targetDisallowedCount,
            };
          }
          if (
            sql.includes(
              "FROM season_matchup_schedule_generations"
            )
          ) {
            return {
              count:
                fixture.scheduleGenerationCount ??
                1,
            };
          }
          return { count: 0 };
        },
      };
    },
  };
  const repository =
    createSqliteLeagueLifecycleTransitionRepository({
      database,
    });
  return {
    context: repository.readSeasonRolloverContext(
      rolloverContextCommand()
    ),
    preparedSql,
  };
}

function insertFullSchemaRow(
  database,
  tableName,
  values
) {
  const columns = Object.keys(values);
  database
    .prepare(
      `INSERT INTO ${tableName} (
         ${columns.join(", ")}
       ) VALUES (
         ${columns
           .map((column) => `@${column}`)
           .join(", ")}
       )`
    )
    .run(values);
}

function seedInitialSeason2ExemptionEvidence(
  database
) {
  const ids = {
    user: uuid(200),
    platformRole: uuid(201),
    league: uuid(202),
    season: uuid(203),
    membership: uuid(204),
    migrationReport: uuid(205),
    bootstrapIdempotency: uuid(206),
    bootstrapActivity: uuid(207),
    bootstrapAudit: uuid(208),
    commissionerUser: uuid(209),
    commissionerMembership: uuid(210),
  };
  const createdAtMs = 10_000;

  insertFullSchemaRow(database, "users", {
    id: ids.user,
    email_normalized:
      "lifecycle-v2-admin@example.test",
    email_display:
      "lifecycle-v2-admin@example.test",
    display_name: "Lifecycle V2 Administrator",
    display_name_normalized:
      "lifecycle v2 administrator",
    status: "active",
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  insertFullSchemaRow(database, "platform_roles", {
    id: ids.platformRole,
    user_id: ids.user,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: ids.user,
    granted_at_ms: createdAtMs,
    ended_at_ms: null,
    version: 1,
  });
  insertFullSchemaRow(database, "users", {
    id: ids.commissionerUser,
    email_normalized:
      "lifecycle-v2-commissioner@example.test",
    email_display:
      "lifecycle-v2-commissioner@example.test",
    display_name: "Lifecycle V2 Commissioner",
    display_name_normalized:
      "lifecycle v2 commissioner",
    status: "active",
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  insertFullSchemaRow(database, "leagues", {
    id: ids.league,
    name: "Lifecycle V2 League",
    name_normalized: "lifecycle v2 league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  insertFullSchemaRow(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: "2026",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  insertFullSchemaRow(
    database,
    "league_memberships",
    {
      id: ids.membership,
      league_id: ids.league,
      user_id: ids.user,
      permission_category: "manager",
      status: "active",
      joined_at_ms: createdAtMs,
      ended_at_ms: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    }
  );
  insertFullSchemaRow(
    database,
    "league_memberships",
    {
      id: ids.commissionerMembership,
      league_id: ids.league,
      user_id: ids.commissionerUser,
      permission_category: "commissioner",
      status: "active",
      joined_at_ms: createdAtMs,
      ended_at_ms: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    }
  );
  database
    .prepare(
      `UPDATE leagues
       SET commissioner_membership_id = ?,
           current_season_id = ?,
           updated_at_ms = ?,
           version = 2
       WHERE id = ?`
    )
    .run(
      ids.commissionerMembership,
      ids.season,
      createdAtMs,
      ids.league
    );
  insertFullSchemaRow(
    database,
    "idempotency_requests",
    {
      id: ids.bootstrapIdempotency,
      league_id: ids.league,
      actor_user_id: ids.user,
      operation:
        "admin.league.bootstrap_reset_original.v1",
      client_key: "reset-original-league-bootstrap",
      request_hash: "1".repeat(64),
      status: "completed",
      result_type: "league",
      result_id: ids.league,
      created_at_ms: createdAtMs,
      completed_at_ms: createdAtMs,
      expires_at_ms:
        createdAtMs + 24 * 60 * 60 * 1000,
    }
  );
  insertFullSchemaRow(database, "league_activity", {
    id: ids.bootstrapActivity,
    league_id: ids.league,
    season_id: ids.season,
    event_type: "league_created",
    actor_user_id: ids.user,
    actor_authority: "platform_administrator",
    team_id: null,
    player_id: null,
    related_type: "league",
    related_id: ids.league,
    display_summary:
      "Lifecycle V2 League was created in Setup.",
    reason: null,
    metadata_json:
      '{"leagueStatus":"setup","seasonStatus":"planned"}',
    occurred_at_ms: createdAtMs,
  });
  insertFullSchemaRow(
    database,
    "security_audit_events",
    {
      id: ids.bootstrapAudit,
      event_type:
        "system_bootstrap.reset_original_league_created",
      outcome: "success",
      actor_user_id: ids.user,
      target_user_id: null,
      league_id: ids.league,
      session_id: null,
      request_correlation_id: null,
      reason_code: "closed_write_reset_handoff",
      network_key_version: null,
      network_metadata_digest: null,
      client_metadata_json: null,
      unknown_account_digest: null,
      occurred_at_ms: createdAtMs,
    }
  );
  insertFullSchemaRow(database, "migration_reports", {
    id: ids.migrationReport,
    league_id: ids.league,
    source_bundle_id:
      "lifecycle-v2-full-schema-foundation",
    reset_manifest_id:
      "2026-season-1-reset-v1",
    database_schema_version: 30,
    status: "succeeded",
    source_hashes_json: JSON.stringify({
      source: "2".repeat(64),
    }),
    counts_json: JSON.stringify({
      teams: 1,
    }),
    totals_json: JSON.stringify({
      records: 1,
    }),
    warnings_json: "[]",
    rejects_json: "[]",
    started_at_ms: createdAtMs + 1,
    completed_at_ms: createdAtMs + 2,
    created_at_ms: createdAtMs + 1,
  });

  return Object.freeze({
    ...ids,
    createdAtMs,
  });
}

function lifecycleExemptionMutationCounts(database) {
  const count = (sql, ...params) =>
    database.prepare(sql).get(...params).count;
  return {
    lifecycleRequests: count(
      `SELECT COUNT(*) AS count
       FROM idempotency_requests
       WHERE operation = ?`,
      LEAGUE_LIFECYCLE_TRANSITION_OPERATION
    ),
    exemptions: count(
      `SELECT COUNT(*) AS count
       FROM free_agent_draft_setup_exemptions`
    ),
    activities: count(
      `SELECT COUNT(*) AS count
       FROM league_activity
       WHERE event_type =
         'fad_setup_exemption_authorized'`
    ),
    audits: count(
      `SELECT COUNT(*) AS count
       FROM security_audit_events
       WHERE event_type =
         'fad.setup_exemption_authorized'`
    ),
    notifications: count(
      `SELECT COUNT(*) AS count
       FROM notifications
       WHERE event_type =
         'fad_setup_exemption_authorized'`
    ),
    outboxEvents: count(
      `SELECT COUNT(*) AS count
       FROM outbox_events`
    ),
    outboxAudiences: count(
      `SELECT COUNT(*) AS count
       FROM outbox_event_audiences`
    ),
    readinessOperations: count(
      `SELECT COUNT(*) AS count
       FROM free_agent_draft_readiness_operations`
    ),
    readinessJobs: count(
      `SELECT COUNT(*) AS count
       FROM job_runs
       WHERE job_type = 'fad_readiness'`
    ),
  };
}

function fullSchemaExemptionHarness(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-lifecycle-v2-full-schema-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "full-schema.sqlite3"
    ),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId:
      "lifecycle-v2-full-schema-foundation",
    now: () => 1,
  });
  const ids =
    seedInitialSeason2ExemptionEvidence(
      connection.database
    );
  const faults = {
    operation: "insertSetupExemption",
  };
  const durableOutboxWriter =
    createSqliteLeagueOutboxWriter({
      database: connection.database,
    });
  const durableNotificationWriter =
    createSqliteNotificationWriter({
      database: connection.database,
    });
  const repository =
    createSqliteLeagueLifecycleTransitionRepository({
      database: connection.database,
      leagueOutboxWriter: Object.freeze({
        write(command) {
          const faultName =
            command.eventType ===
            "activity.created"
              ? "writeActivityOutbox"
              : command.eventType ===
                  "notification.created"
                ? "writeNotificationOutbox"
                : "writeLeagueOutbox";
          if (faults.operation === faultName) {
            throw new Error(
              `injected:${faultName}`
            );
          }
          if (
            faults.operation ===
              "dropActivityOutbox" &&
            command.eventType ===
              "activity.created"
          ) {
            return null;
          }
          if (
            faults.operation ===
              "corruptNotificationAudience" &&
            command.eventType ===
              "notification.created"
          ) {
            return durableOutboxWriter.write({
              ...command,
              audiences: [
                {
                  kind: "user",
                  userId: ids.user,
                },
              ],
            });
          }
          return durableOutboxWriter.write(command);
        },
      }),
      notificationWriter: Object.freeze({
        insert(command) {
          if (
            faults.operation ===
            "writeSetupNotification"
          ) {
            throw new Error(
              "injected:writeSetupNotification"
            );
          }
          return durableNotificationWriter.insert(
            command
          );
        },
      }),
      beforeCommit(operation) {
        if (faults.operation === operation) {
          throw new Error(
            `injected:${operation}`
          );
        }
      },
    });
  const handoffCalls = [];
  const readinessHandoffWriter =
    createSqliteFreeAgentDraftReadinessHandoffWriter({
      database: connection.database,
      afterStep(operation) {
        if (faults.operation === operation) {
          throw new Error(
            `injected:${operation}`
          );
        }
      },
    });
  const tracedReadinessHandoffWriter =
    Object.freeze({
      write(input) {
        handoffCalls.push(
          Object.freeze({ ...input })
        );
        return readinessHandoffWriter.write(input);
      },
    });
  let generatedIdCount = 0;
  const service =
    createLeagueLifecycleTransitionService({
      repositoryContext: Object.freeze({
        transaction(callback) {
          return connection.database
            .transaction(callback)
            .immediate();
        },
      }),
      leagueAuthorization: Object.freeze({
        requireActiveMembership(
          authenticated,
          leagueId
        ) {
          assert.equal(leagueId, ids.league);
          assert.equal(
            authenticated?.user?.id,
            ids.user
          );
          const current = connection.database
            .prepare(
              `SELECT membership.id
               FROM league_memberships AS membership
               JOIN users AS user
                 ON user.id = membership.user_id
               WHERE membership.id = ?
                 AND membership.league_id = ?
                 AND membership.user_id = ?
                 AND membership.status = 'active'
                 AND membership.joined_at_ms <= 20000
                 AND membership.ended_at_ms IS NULL
                 AND user.status = 'active'`
            )
            .get(ids.membership, ids.league, ids.user);
          if (!current) {
            const error = new Error(
              "current administrator membership is required"
            );
            error.code =
              "PLATFORM_ADMINISTRATOR_REQUIRED";
            throw error;
          }
          return Object.freeze({
            actorUserId: ids.user,
            membershipId: ids.membership,
          });
        },
        requireCommissioner() {
          throw new Error(
            "commissioner path is not expected"
          );
        },
      }),
      platformAuthorization: Object.freeze({
        requireAdministrator(authenticated) {
          assert.equal(
            authenticated?.user?.id,
            ids.user
          );
          const current = connection.database
            .prepare(
              `SELECT role.id
               FROM platform_roles AS role
               JOIN users AS user
                 ON user.id = role.user_id
               WHERE role.id = ?
                 AND role.user_id = ?
                 AND role.role = 'platform_administrator'
                 AND role.status = 'active'
                 AND role.ended_at_ms IS NULL
                 AND user.status = 'active'`
            )
            .get(ids.platformRole, ids.user);
          if (!current) {
            const error = new Error(
              "current platform administrator is required"
            );
            error.code =
              "PLATFORM_ADMINISTRATOR_REQUIRED";
            throw error;
          }
          return Object.freeze({
            actorUserId: ids.user,
          });
        },
      }),
      leagueLifecycleTransitionRepository:
        repository,
      freeAgentDraftReadinessHandoffWriter:
        tracedReadinessHandoffWriter,
      lateLockCoordinator: Object.freeze({
        async coordinateCommittedRoster() {
          throw new Error(
            "exemption must not coordinate roster late locks"
          );
        },
      }),
      clock: Object.freeze({
        nowMs() {
          return 20_000;
        },
      }),
      secureRandom: Object.freeze({
        id() {
          generatedIdCount += 1;
          return uuid(300 + generatedIdCount);
        },
      }),
    });
  const command = Object.freeze({
    leagueId: ids.league,
    input: Object.freeze({
      transitionType:
        INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
      seasonId: ids.season,
      reason:
        "Approved one-time imported Season 2 transition.",
      confirmation:
        INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
    }),
    expectedDraftVersion: null,
    idempotencyKey:
      "full-schema-lifecycle-v2-exemption",
    authenticated: Object.freeze({
      user: Object.freeze({ id: ids.user }),
    }),
  });
  return {
    database: connection.database,
    faults,
    ids,
    service,
    command,
    handoffCalls,
    generatedIdCount() {
      return generatedIdCount;
    },
  };
}

function consumeInitialSeason2Exemption(
  database,
  ids,
  exemptionId
) {
  const teamId = uuid(700);
  const assignmentId = uuid(701);
  const weekId = uuid(702);
  const fadId = uuid(704);
  const openedAtMs = 30_000;
  const firstMatchupStartsAtMs = 800_000_000;
  const candidateDeadlineAtMs =
    firstMatchupStartsAtMs - 604_800_000;
  const helpOpensAtMs =
    candidateDeadlineAtMs - 172_800_000;

  insertFullSchemaRow(database, "teams", {
    id: teamId,
    league_id: ids.league,
    name: "Lifecycle V2 Team",
    name_normalized: "lifecycle v2 team",
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: ids.createdAtMs,
    updated_at_ms: ids.createdAtMs,
    version: 1,
  });
  insertFullSchemaRow(
    database,
    "team_manager_assignments",
    {
      id: assignmentId,
      league_id: ids.league,
      team_id: teamId,
      user_id: ids.user,
      membership_id: ids.membership,
      assigned_by_user_id: ids.user,
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: ids.createdAtMs,
      accepted_at_ms: ids.createdAtMs,
      ended_at_ms: null,
      version: 1,
    }
  );
  insertFullSchemaRow(database, "matchup_weeks", {
    id: weekId,
    league_id: ids.league,
    season_id: ids.season,
    week_key: "2027-W01",
    sequence: 1,
    starts_at_ms: firstMatchupStartsAtMs,
    baseline_at_ms:
      firstMatchupStartsAtMs + 1_000,
    locks_at_ms:
      firstMatchupStartsAtMs + 2_000,
    ends_at_ms:
      firstMatchupStartsAtMs + 3_000,
    rolls_over_at_ms:
      firstMatchupStartsAtMs + 4_000,
    status: "scheduled",
    created_at_ms: ids.createdAtMs,
    updated_at_ms: ids.createdAtMs,
    version: 1,
  });
  const pendingReadiness = database
    .prepare(
      `SELECT *
       FROM free_agent_draft_readiness_operations
       WHERE league_id = ? AND season_id = ?
         AND setup_exemption_id = ?`
    )
    .get(ids.league, ids.season, exemptionId);
  assert.equal(pendingReadiness.status, "pending");
  assert.equal(pendingReadiness.attempt_count, 0);
  assert.notEqual(pendingReadiness.job_run_id, null);
  const pendingJob = database
    .prepare(
      `SELECT * FROM job_runs
       WHERE league_id = ? AND season_id = ?
         AND id = ? AND job_type = 'fad_readiness'`
    )
    .get(
      ids.league,
      ids.season,
      pendingReadiness.job_run_id
    );
  const claim =
    createSqliteFreeAgentDraftJobRepository({
      database,
    }).claim({
      leagueId: ids.league,
      seasonId: ids.season,
      fadId: null,
      runId: pendingJob.id,
      jobType: "fad_readiness",
      occurrenceKey: pendingJob.occurrence_key,
      scheduledForMs: pendingJob.scheduled_for_ms,
      expectedVersion: pendingJob.version,
      leaseOwner: "lifecycle-v2-consumption-worker",
      leaseToken: "lifecycle-v2-consumption-lease",
      nowMs: openedAtMs - 1,
      leaseExpiresAtMs: openedAtMs + 10_000,
    });
  assert.equal(claim.acquired, true);
  assert.equal(
    claim.occurrence.binding.readinessExecution
      .operationId,
    pendingReadiness.id
  );
  const runningReadiness = database
    .prepare(
      `SELECT *
       FROM free_agent_draft_readiness_operations
       WHERE id = ?`
    )
    .get(pendingReadiness.id);
  assert.equal(runningReadiness.status, "running");
  assert.equal(runningReadiness.attempt_count, 1);
  insertFullSchemaRow(
    database,
    "free_agent_drafts",
    {
      id: fadId,
      league_id: ids.league,
      season_id: ids.season,
      readiness_operation_id:
        runningReadiness.id,
      readiness_occurrence_key:
        runningReadiness
          .readiness_occurrence_key,
      first_matchup_week_id: weekId,
      current_competition_first_matchup_week_id:
        weekId,
      schedule_recovery_id: null,
      participating_team_count: 1,
      status: "cards_open",
      setup_path:
        "no_draft_initial_season2",
      entry_draft_id: null,
      setup_exemption_id: exemptionId,
      prior_season_rollover_id: null,
      no_draft_reason:
        "Approved one-time imported Season 2 transition.",
      opening_authority: "system",
      opened_at_ms: openedAtMs,
      help_opens_at_ms: helpOpensAtMs,
      candidate_deadline_at_ms:
        candidateDeadlineAtMs,
      first_matchup_starts_at_ms:
        firstMatchupStartsAtMs,
      deadline_locked_at_ms: null,
      allocation_completed_at_ms: null,
      completed_at_ms: null,
      created_at_ms: openedAtMs,
      updated_at_ms: openedAtMs,
      version: 1,
    }
  );
  return Object.freeze({
    fadId,
    readinessId: runningReadiness.id,
    readinessJobId: pendingJob.id,
    teamId,
    weekId,
    openedAtMs,
  });
}

function harness(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-lifecycle-repository-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "foundation.sqlite3"
    ),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  schema(connection.database);
  seed(connection.database);
  const faults = {
    operation: null,
  };
  const leagueOutboxWriter = {
    write(event) {
      connection.database
        .prepare(
          `INSERT INTO outbox_events
           VALUES (?, ?, ?, ?)`
        )
        .run(
          event.id,
          event.leagueId,
          JSON.stringify(event.payload),
          event.occurredAtMs
        );
      return { event };
    },
  };
  const repository =
    createSqliteLeagueLifecycleTransitionRepository(
      {
        database: connection.database,
        leagueOutboxWriter,
        beforeCommit(operation) {
          if (faults.operation === operation) {
            throw new Error(
              `injected:${operation}`
            );
          }
        },
      }
    );
  const transaction = (callback) =>
    connection.database
      .transaction(callback)
      .immediate();
  return {
    database: connection.database,
    faults,
    repository,
    transaction,
  };
}

describe(
  "SQLite league lifecycle transition repository foundation",
  () => {
    test("exposes exactly the service's twenty-method contract", (t) => {
      const { repository } = harness(t);
      assert.deepEqual(
        Object.keys(repository),
        REPOSITORY_METHODS
      );
      assert.equal(REPOSITORY_METHODS.length, 20);
    });

    test("binds reads to the requested league and occurrence while preserving superseded history", (t) => {
      const { repository } = harness(t);
      const current =
        repository.findRolloverBindingByOccurrence(
          {
            leagueId: IDS.league,
            entryDraftId: IDS.entryDraft,
            rolloverOccurrenceId:
              IDS.occurrence,
          }
        );
      assert.equal(current.status, "scheduled");
      assert.equal(
        current.rolloverOccurrenceId,
        IDS.occurrence
      );
      assert.equal(
        repository.findRolloverBindingByOccurrence({
          leagueId: IDS.otherLeague,
          entryDraftId: IDS.entryDraft,
          rolloverOccurrenceId:
            IDS.occurrence,
        }),
        null
      );
      const superseded =
        repository.findRolloverBindingByOccurrence(
          {
            leagueId: IDS.league,
            entryDraftId: IDS.entryDraft,
            rolloverOccurrenceId:
              IDS.supersededOccurrence,
          }
        );
      assert.equal(
        superseded.status,
        "superseded"
      );
      assert.equal(
        superseded.scheduledStartsAtMs,
        STARTS_AT_MS - 86_400_000
      );
    });

    test("accepts only a closed source projection and includes ordinary weekly auction evidence", () => {
      const fixture = closedSourceFixture();
      const { context, preparedSql } =
        readFixtureContext(fixture);

      assert.ok(context);
      assert.equal(
        context.sourceReadiness.projection
          .auctionContexts.length,
        1
      );
      assert.equal(
        context.sourceReadiness.projection
          .auctionContexts[0].source_kind,
        "ordinary_weekly"
      );
      assert.equal(
        context.sourceReadiness.projection
          .auctions[0].id,
        fixture.ids.auction
      );
      assert.equal(
        context.sourceReadiness.projection
          .jobRuns[0].id,
        fixture.ids.matchupJob
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          context.sourceReadiness.projection,
          "matchupScheduleJobBindings"
        ),
        false
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          context.sourceReadiness.projection,
          "seasonMatchupScheduleGenerations"
        ),
        false
      );
      assert.deepEqual(
        context.matrix.violations,
        []
      );
      assert.equal(
        context.aggregate.targetSeason
          .disallowedStateCount,
        0
      );
      assert.ok(
        preparedSql.some(
          (sql) =>
            sql.includes("FROM auctions") &&
            sql.includes(
              "season_id = @seasonId"
            )
        )
      );
      assert.ok(
        preparedSql.some(
          (sql) =>
            sql.includes(
              "FROM matchup_schedule_job_bindings"
            ) &&
            sql.includes(
              "WHERE league_id = @leagueId"
            ) &&
            sql.includes(
              "season_id = @seasonId"
            )
        )
      );
      assert.ok(
        preparedSql.some(
          (sql) =>
            sql.includes(
              "FROM season_matchup_schedule_generations"
            ) &&
            sql.includes(
              "WHERE league_id = @leagueId"
            ) &&
            sql.includes(
              "season_id = @seasonId"
            )
        )
      );
    });

    test("accepts an untouched matchup job bound to any superseded generation before the exact current generation", () => {
      const fixture = closedSourceFixture();
      const supersededAtMs =
        fixture.tables
          .season_matchup_schedule_generations[1]
          .created_at_ms;
      fixture.tables
        .season_matchup_schedule_generations.splice(
          1,
          1,
          {
            ...fixture.tables
              .season_matchup_schedule_generations[1],
            schedule_version: 2,
            schedule_operation_id: uuid(164),
            status: "superseded",
            superseded_at_ms:
              supersededAtMs + 1,
            version: 2,
          },
          {
            ...fixture.tables
              .season_matchup_schedule_generations[1],
            schedule_version: 3,
            schedule_operation_id:
              fixture.ids.currentScheduleOperation,
            created_at_ms:
              supersededAtMs + 1,
          }
        );

      const { context } =
        readFixtureContext(fixture);

      assert.ok(context);
      assert.equal(
        context.sourceReadiness.projection
          .jobRuns[0].status,
        "skipped"
      );
    });

    test("keeps supplemental matchup schedule evidence outside the exact source-readiness projection and hash", () => {
      const firstFixture = closedSourceFixture();
      const secondFixture = closedSourceFixture();
      secondFixture.tables
        .matchup_schedule_job_bindings[0].id =
        uuid(165);

      const first =
        readFixtureContext(firstFixture).context;
      const second =
        readFixtureContext(secondFixture).context;

      assert.ok(first);
      assert.ok(second);
      assert.deepEqual(
        second.sourceReadiness.projection,
        first.sourceReadiness.projection
      );
      assert.equal(
        second.sourceReadiness.projectionJson,
        first.sourceReadiness.projectionJson
      );
      assert.equal(
        second.sourceReadiness.projectionSha256,
        first.sourceReadiness.projectionSha256
      );
    });

    test("preserves succeeded and resolved-recovery failed job terminal evidence", () => {
      const succeededFixture =
        closedSourceFixture();
      const succeededJob =
        succeededFixture.tables.job_runs[0];
      succeededJob.status = "succeeded";
      succeededJob.attempt_count = 1;
      succeededJob.started_at_ms =
        succeededJob.created_at_ms + 1;
      succeededJob.completed_at_ms =
        succeededJob.created_at_ms + 2;
      succeededJob.result_json =
        '{"status":"succeeded"}';
      succeededJob.updated_at_ms =
        succeededJob.completed_at_ms;
      succeededJob.version = 3;

      assert.ok(
        readFixtureContext(succeededFixture)
          .context
      );

      const failedFixture = closedSourceFixture();
      const failedJob =
        failedFixture.tables.job_runs[0];
      failedJob.status = "failed";
      failedJob.attempt_count = 1;
      failedJob.started_at_ms =
        failedJob.created_at_ms + 1;
      failedJob.completed_at_ms =
        failedJob.created_at_ms + 2;
      failedJob.last_error_code =
        "MATCHUP_OCCURRENCE_FAILED";
      failedJob.next_attempt_at_ms =
        failedJob.created_at_ms + 3;
      failedJob.updated_at_ms =
        failedJob.completed_at_ms;
      failedJob.version = 3;
      failedFixture.tables
        .free_agent_draft_recoveries = [
        {
          id: uuid(169),
          league_id: IDS.league,
          season_id: IDS.sourceSeason,
          fad_id: IDS.sourceFad,
          job_run_id: failedJob.id,
          allocation_id: null,
          rollover_id: null,
          auction_id: null,
          status: "resolved",
          resolved_at_ms:
            failedJob.completed_at_ms + 1,
          created_at_ms:
            failedJob.completed_at_ms,
        },
      ];

      assert.ok(
        readFixtureContext(failedFixture).context
      );
    });

    test("rejects skipped jobs unless every untouched superseded-generation invariant is exact", () => {
      const cases = [
        {
          name: "attempted job",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .attempt_count = 1;
          },
        },
        {
          name: "lease owner",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .lease_owner = "worker-a";
          },
        },
        {
          name: "lease token",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .lease_token = "lease-a";
          },
        },
        {
          name: "lease expiry",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .lease_expires_at_ms = 1;
          },
        },
        {
          name: "completed skipped job",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .started_at_ms = 1;
            fixture.tables.job_runs[0]
              .completed_at_ms = 2;
          },
        },
        {
          name: "result payload",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .result_json = "{}";
          },
        },
        {
          name: "error code",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .last_error_code = "SKIPPED";
          },
        },
        {
          name: "retry time",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .next_attempt_at_ms = 1;
          },
        },
        {
          name: "non-matchup job family",
          mutate(fixture) {
            fixture.tables.job_runs[0]
              .job_type =
              "league:entry_draft_rollover";
            fixture.tables
              .matchup_schedule_job_bindings[0]
              .job_type =
              "league:entry_draft_rollover";
          },
        },
        {
          name: "missing binding",
          mutate(fixture) {
            fixture.tables
              .matchup_schedule_job_bindings =
              [];
          },
        },
        {
          name: "duplicate binding",
          mutate(fixture) {
            fixture.tables
              .matchup_schedule_job_bindings.push({
                ...fixture.tables
                  .matchup_schedule_job_bindings[0],
                id: uuid(166),
              });
          },
        },
        {
          name: "binding version",
          mutate(fixture) {
            fixture.tables
              .matchup_schedule_job_bindings[0]
              .version = 2;
          },
        },
        {
          name: "binding creation time",
          mutate(fixture) {
            fixture.tables
              .matchup_schedule_job_bindings[0]
              .created_at_ms += 1;
          },
        },
        {
          name: "binding job type",
          mutate(fixture) {
            fixture.tables
              .matchup_schedule_job_bindings[0]
              .job_type = "matchup:lock";
          },
        },
        {
          name: "binding job ID",
          mutate(fixture) {
            fixture.tables
              .matchup_schedule_job_bindings[0]
              .job_run_id = uuid(167);
          },
        },
        {
          name: "cross-league binding",
          mutate(fixture) {
            fixture.tables
              .matchup_schedule_job_bindings[0]
              .league_id = IDS.otherLeague;
          },
        },
        {
          name: "missing bound generation",
          mutate(fixture) {
            fixture.tables
              .season_matchup_schedule_generations
              .shift();
          },
        },
        {
          name: "bound generation not superseded",
          mutate(fixture) {
            fixture.tables
              .season_matchup_schedule_generations[0]
              .status = "invalid";
          },
        },
        {
          name: "bound generation has no supersession time",
          mutate(fixture) {
            fixture.tables
              .season_matchup_schedule_generations[0]
              .superseded_at_ms = null;
          },
        },
        {
          name: "missing current generation",
          mutate(fixture) {
            fixture.tables
              .season_matchup_schedule_generations
              .pop();
          },
        },
        {
          name: "duplicate current generation",
          mutate(fixture) {
            fixture.tables
              .season_matchup_schedule_generations.push({
                ...fixture.tables
                  .season_matchup_schedule_generations[1],
                schedule_version: 3,
                schedule_operation_id: uuid(168),
              });
          },
        },
        {
          name: "current generation is not later",
          mutate(fixture) {
            fixture.tables
              .season_matchup_schedule_generations[1]
              .schedule_version = 1;
          },
        },
        {
          name: "current generation from another season",
          mutate(fixture) {
            fixture.tables
              .season_matchup_schedule_generations[1]
              .season_id = IDS.targetSeason;
          },
        },
        {
          name: "current generation predates supersession",
          mutate(fixture) {
            fixture.tables
              .season_matchup_schedule_generations[1]
              .created_at_ms =
              fixture.tables
                .season_matchup_schedule_generations[0]
                .superseded_at_ms -
              1;
          },
        },
      ];

      for (const scenario of cases) {
        const fixture = closedSourceFixture();
        scenario.mutate(fixture);
        assert.equal(
          readFixtureContext(fixture).context,
          null,
          scenario.name
        );
      }
    });

    test("fails closed independently for every nonterminal source-readiness family", () => {
      const cases = [
        {
          name: "FAD readiness operation still running",
          mutate(fixture) {
            fixture.tables
              .free_agent_draft_readiness_operations[0]
              .status = "running";
          },
        },
        {
          name: "FAD lifecycle still rapid",
          mutate(fixture) {
            fixture.tables.free_agent_drafts[0]
              .status = "rapid";
            fixture.tables.free_agent_drafts[0]
              .completed_at_ms = null;
          },
        },
        {
          name: "FAD allocation not accounted",
          mutate(fixture) {
            fixture.tables
              .free_agent_draft_player_allocations = [
              {
                id: uuid(134),
                league_id: IDS.league,
                season_id: IDS.sourceSeason,
                fad_id: IDS.sourceFad,
                status: "automatic_award",
                accounted_at_ms: null,
              },
            ];
          },
        },
        {
          name: "FAD allocation lacks terminal event",
          mutate(fixture) {
            fixture.tables
              .free_agent_draft_player_allocations = [
              {
                id: uuid(135),
                league_id: IDS.league,
                season_id: IDS.sourceSeason,
                fad_id: IDS.sourceFad,
                status: "automatic_award",
                accounted_at_ms:
                  Date.parse(
                    "2027-04-25T07:00:00.000Z"
                  ),
              },
            ];
            fixture.tables
              .free_agent_draft_allocation_events =
              [];
          },
        },
        {
          name: "FAD recovery unresolved",
          mutate(fixture) {
            fixture.tables
              .free_agent_draft_recoveries = [
              {
                id: uuid(136),
                league_id: IDS.league,
                season_id: IDS.sourceSeason,
                fad_id: IDS.sourceFad,
                status: "pending",
                resolved_at_ms: null,
              },
            ];
          },
        },
        {
          name: "FAD nomination not terminal",
          mutate(fixture) {
            fixture.tables
              .free_agent_draft_nomination_queue = [
              {
                id: uuid(137),
                league_id: IDS.league,
                season_id: IDS.sourceSeason,
                fad_id: IDS.sourceFad,
                status: "pending",
                terminal_at_ms: null,
              },
            ];
          },
        },
        {
          name: "ordinary auction resolution missing",
          mutate(fixture) {
            fixture.tables.auction_resolutions =
              [];
          },
        },
        {
          name: "ordinary auction still open",
          mutate(fixture) {
            fixture.tables.auctions[0].status =
              "open";
          },
        },
        {
          name: "source job still scheduled",
          mutate(fixture) {
            fixture.tables.job_runs = [
              {
                id: uuid(140),
                league_id: IDS.league,
                season_id: IDS.sourceSeason,
                status: "scheduled",
                lease_owner: null,
                lease_token: null,
                lease_expires_at_ms: null,
                started_at_ms: null,
                completed_at_ms: null,
                next_attempt_at_ms: null,
                last_error_code: null,
                result_json: null,
              },
            ];
          },
        },
        {
          name: "source matchup operation running",
          mutate(fixture) {
            fixture.tables.matchup_operations = [
              {
                id: uuid(142),
                league_id: IDS.league,
                season_id: IDS.sourceSeason,
                operation_type:
                  "week_transition",
                status: "running",
                completed_at_ms: null,
              },
            ];
          },
        },
        {
          name: "initial rollover series incomplete",
          mutate(fixture) {
            fixture.tables
              .free_agent_draft_rollovers.pop();
          },
        },
        {
          name: "matchup week not final",
          mutate(fixture) {
            fixture.tables.matchup_weeks[0]
              .status = "live";
          },
        },
        {
          name: "matchup not final",
          mutate(fixture) {
            fixture.tables.matchups[0].status =
              "live";
          },
        },
        {
          name: "matchup result not official",
          mutate(fixture) {
            fixture.tables.matchup_results[0]
              .status = "pending";
          },
        },
        {
          name: "matchup result version missing",
          mutate(fixture) {
            fixture.tables
              .matchup_result_versions = [];
          },
        },
        {
          name: "finalization result-set hash corrupt",
          mutate(fixture) {
            fixture.tables
              .standings_snapshot_finalizations[0]
              .result_set_hash = "0".repeat(64);
          },
        },
      ];

      for (const scenario of cases) {
        const fixture = closedSourceFixture();
        scenario.mutate(fixture);
        assert.equal(
          readFixtureContext(fixture).context,
          null,
          scenario.name
        );
      }
    });

    test("projects each clean-target and schedule-readiness rejection independently", () => {
      const cases = [
        {
          name: "target season is not planned",
          mutate(fixture) {
            fixture.aggregateRow.target_status =
              "active";
          },
          assertContext(context) {
            assert.equal(
              context.aggregate.targetSeason.status,
              "active"
            );
          },
        },
        {
          name: "target contains disallowed state",
          mutate(fixture) {
            fixture.targetDisallowedCount = 1;
          },
          assertContext(context) {
            assert.equal(
              context.aggregate.targetSeason
                .disallowedStateCount,
              1
            );
          },
        },
        {
          name: "target schedule generation missing",
          mutate(fixture) {
            fixture.scheduleGenerationCount = 0;
          },
          assertContext(context) {
            assert.equal(
              context.aggregate.targetSeason
                .scheduleReady,
              false
            );
          },
        },
      ];

      for (const scenario of cases) {
        const fixture = closedSourceFixture();
        scenario.mutate(fixture);
        const { context } =
          readFixtureContext(fixture);
        assert.ok(context, scenario.name);
        scenario.assertContext(context);
      }
    });

    test("projects nonterminal source trades as rollover-matrix violations", () => {
      const fixture = closedSourceFixture();
      const tradeId = uuid(141);
      fixture.tables.trades = [
        {
          id: tradeId,
          league_id: IDS.league,
          season_id: IDS.sourceSeason,
          status: "accepted",
        },
      ];

      const { context } =
        readFixtureContext(fixture);

      assert.ok(context);
      assert.deepEqual(
        context.matrix.violations,
        [`trade:${tradeId}:terminal`]
      );
    });

    test("atomically persists a genuinely nonzero nine-kind rollover manifest and preserves replay after later summer descendants", (t) => {
      const {
        database,
        faults,
        repository,
        transaction,
      } = harness(t);
      nonzeroRolloverSchema(database);
      const fixture = nonzeroRolloverFixture();
      seedRolloverMatrixRows(database, fixture);
      const { context } =
        readFixtureContext(fixture);
      assert.ok(context);
      assert.deepEqual(
        context.matrix.violations,
        []
      );
      assert.deepEqual(
        Object.fromEntries(
          [
            [
              "contracts",
              context.matrix.contractEffects,
            ],
            [
              "ownerships",
              context.matrix.ownershipEffects,
            ],
            [
              "retentions",
              context.matrix.retentionEffects,
            ],
            [
              "buyouts",
              context.matrix.buyoutEffects,
            ],
            [
              "trades",
              context.matrix.tradeEffects,
            ],
          ].map(([key, effects]) => [
            key,
            effects.length,
          ])
        ),
        {
          contracts: 2,
          ownerships: 3,
          retentions: 2,
          buyouts: 2,
          trades: 1,
        }
      );

      transaction(() =>
        repository.beginSeasonRolloverAttempt(
          scheduledAttemptCommand()
        )
      );
      transaction(() =>
        repository.blockSeasonRolloverAttempt({
          attemptId: IDS.scheduledAttempt,
          bindingId: IDS.binding,
          leagueId: IDS.league,
          entryDraftId: IDS.entryDraft,
          rolloverOccurrenceId:
            IDS.occurrence,
          expectedBindingVersion: 1,
          expectedSourceSeasonVersion: 4,
          expectedTargetSeasonVersion: 3,
          expectedEntryDraftVersion: 2,
          triggerKind: "scheduled_job",
          scheduledJob:
            scheduledAttemptCommand().scheduledJob,
          retryIdempotencyRequestId: null,
          blockers: blockers(),
          blockedAtMs: STARTS_AT_MS + 10,
        })
      );
      transaction(() => {
        repository.insertStartedIdempotencyRequest({
          id: IDS.retryIdempotency,
          leagueId: IDS.league,
          actorUserId: IDS.commissioner,
          operation:
            "league.lifecycle.transition.v2",
          clientKey: "nonzero-rollover",
          requestHash: "a".repeat(64),
          createdAtMs: STARTS_AT_MS + 20,
          expiresAtMs:
            STARTS_AT_MS + 86_400_020,
        });
        return repository.beginSeasonRolloverAttempt({
          ...scheduledAttemptCommand(),
          attemptId: IDS.retryAttempt,
          expectedBindingVersion: 2,
          expectedPriorAttemptId:
            IDS.scheduledAttempt,
          expectedPriorAttemptNumber: 1,
          triggerKind: "commissioner_retry",
          scheduledJob: null,
          retryIdempotencyRequestId:
            IDS.retryIdempotency,
          retryActorUserId: IDS.commissioner,
          retryActorMembershipId:
            IDS.membership,
          retryAuthority: "commissioner",
          startedAtMs: STARTS_AT_MS + 20,
        });
      });

      const plan = nonzeroSuccessPlan(
        context.matrix,
        context.sourceReadiness
      );
      const expectedSummary = {
        contractsAdvanced: 1,
        contractsExpired: 1,
        ownershipsCarried: 2,
        ownershipsReleased: 1,
        retentionYearsAdvanced: 1,
        retentionObligationsCompleted: 1,
        buyoutYearsAdvanced: 1,
        buyoutObligationsCompleted: 1,
        tradesCancelled: 1,
      };
      assert.deepEqual(
        plan.summary,
        expectedSummary
      );
      const rollbackTables = [
        "leagues",
        "seasons",
        "entry_drafts",
        "draft_picks",
        "entry_draft_rollover_bindings",
        "season_rollover_occurrences",
        "season_rollover_attempts",
        "contracts",
        "contract_years",
        "player_ownerships",
        "roster_display_order_entries",
        "retention_obligations",
        "retention_years",
        "buyout_obligations",
        "buyout_years",
        "trades",
        "contract_events",
        "ownership_events",
        "trade_events",
        "league_activity",
        "security_audit_events",
        "outbox_events",
        "entry_draft_pick_clocks",
        "season_rollover_items",
        "season_rollovers",
      ];
      const captureState = () =>
        Object.fromEntries(
          rollbackTables.map((tableName) => [
            tableName,
            database
              .prepare(
                `SELECT * FROM ${tableName}
                 ORDER BY id`
              )
              .all(),
          ])
        );
      const beforeCommit = captureState();
      faults.operation =
        "commitSeasonRolloverAndOpenDraft";
      assert.throws(
        () =>
          transaction(() =>
            repository.commitSeasonRolloverAndOpenDraft(
              {
                plan,
                scheduledJob: null,
              }
            )
          ),
        (error) =>
          error.cause?.message ===
          "injected:commitSeasonRolloverAndOpenDraft"
      );
      assert.deepEqual(
        captureState(),
        beforeCommit
      );

      faults.operation = null;
      const receipt = transaction(() =>
        repository.commitSeasonRolloverAndOpenDraft({
          plan,
          scheduledJob: null,
        })
      );
      assert.deepEqual(
        receipt.summary,
        expectedSummary
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT id, status, version,
                    updated_at_ms
             FROM contracts
             WHERE id IN (?, ?)
             ORDER BY id`
          )
          .all(
            fixture.ids.advancedContract,
            fixture.ids.expiringContract
          ),
        [
          {
            id: fixture.ids.advancedContract,
            status: "active",
            version: 2,
            updated_at_ms: COMPLETED_AT_MS,
          },
          {
            id: fixture.ids.expiringContract,
            status: "expired",
            version: 2,
            updated_at_ms: COMPLETED_AT_MS,
          },
        ]
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT id, season_id, version
             FROM player_ownerships
             ORDER BY id`
          )
          .all(),
        [
          {
            id: fixture.ids.advancedOwnership,
            season_id: IDS.targetSeason,
            version: 2,
          },
          {
            id: fixture.ids.prospectOwnership,
            season_id: IDS.targetSeason,
            version: 2,
          },
        ]
      );
      const ownershipReceipt =
        repository
          .findDurableSeasonRolloverOwnershipReceipt(
            {
              leagueId: IDS.league,
              rolloverId: IDS.rollover,
            }
          );
      assert.deepEqual(ownershipReceipt, {
        rolloverId: IDS.rollover,
        leagueId: IDS.league,
        fromSeasonId: IDS.sourceSeason,
        toSeasonId: IDS.targetSeason,
        teams: [
          {
            leagueId: IDS.league,
            seasonId: IDS.sourceSeason,
            teamId: fixture.ids.teamB,
            ownershipWitnesses: [
              {
                ownershipId:
                  fixture.ids.expiringOwnership,
                ownershipVersion: 1,
                state: "deleted",
              },
            ],
          },
          {
            leagueId: IDS.league,
            seasonId: IDS.targetSeason,
            teamId: fixture.ids.teamA,
            ownershipWitnesses: [
              {
                ownershipId:
                  fixture.ids.advancedOwnership,
                ownershipVersion: 2,
                state: "present",
              },
              {
                ownershipId:
                  fixture.ids.prospectOwnership,
                ownershipVersion: 2,
                state: "present",
              },
            ],
          },
          {
            leagueId: IDS.league,
            seasonId: IDS.targetSeason,
            teamId: fixture.ids.teamB,
            ownershipWitnesses: [],
          },
        ],
      });
      assert.equal(
        ownershipReceipt.teams[1]
          .ownershipWitnesses[0].ownershipId,
        fixture.ids.advancedOwnership
      );
      assert.equal(Object.isFrozen(ownershipReceipt), true);
      assert.equal(
        Object.isFrozen(ownershipReceipt.teams),
        true
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM roster_display_order_entries`
          )
          .get().count,
        0
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT id, status, version
             FROM retention_obligations
             ORDER BY id`
          )
          .all(),
        [
          {
            id: fixture.ids.retentionAdvanced,
            status: "active",
            version: 2,
          },
          {
            id: fixture.ids.retentionCompleted,
            status: "completed",
            version: 2,
          },
        ]
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT id, status, version
             FROM buyout_obligations
             ORDER BY id`
          )
          .all(),
        [
          {
            id: fixture.ids.buyoutAdvanced,
            status: "active",
            version: 2,
          },
          {
            id: fixture.ids.buyoutCompleted,
            status: "completed",
            version: 2,
          },
        ]
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT status, responded_at_ms,
                    version
             FROM trades
             WHERE id = ?`
          )
          .get(fixture.ids.proposedTrade),
        {
          status: "cancelled",
          responded_at_ms: COMPLETED_AT_MS,
          version: 2,
        }
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM contract_events`
          )
          .get().count,
        2
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM ownership_events`
          )
          .get().count,
        3
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM trade_events`
          )
          .get().count,
        1
      );

      const items = database
        .prepare(
          `SELECT *
           FROM season_rollover_items
           WHERE rollover_id = ?
           ORDER BY effect_kind, entity_id`
        )
        .all(IDS.rollover);
      assert.equal(items.length, 10);
      assert.deepEqual(
        Object.fromEntries(
          items.map(({ effect_kind }) => [
            effect_kind,
            items.filter(
              (candidate) =>
                candidate.effect_kind ===
                effect_kind
            ).length,
          ])
        ),
        {
          buyout_obligation_completed: 1,
          buyout_year_advanced: 1,
          contract_advanced: 1,
          contract_expired: 1,
          ownership_carried: 2,
          ownership_released: 1,
          retention_obligation_completed: 1,
          retention_year_advanced: 1,
          trade_cancelled: 1,
        }
      );
      for (const row of items) {
        const projection = {
          itemId: row.id,
          leagueId: row.league_id,
          rolloverId: row.rollover_id,
          rolloverAttemptId:
            row.rollover_attempt_id,
          idempotencyRequestId:
            row.idempotency_request_id,
          fromSeasonId: row.from_season_id,
          toSeasonId: row.to_season_id,
          effectKind: row.effect_kind,
          entityType: row.entity_type,
          entityId: row.entity_id,
          before: parseCanonicalJsonV1(
            row.before_json
          ),
          after: parseCanonicalJsonV1(
            row.after_json
          ),
          contractEventId:
            row.contract_event_id,
          ownershipEventId:
            row.ownership_event_id,
          tradeEventId: row.trade_event_id,
          leagueActivityId:
            row.league_activity_id,
          causalAssets: parseCanonicalJsonV1(
            row.causal_assets_json
          ),
          occurredAtMs: row.occurred_at_ms,
        };
        assert.equal(
          row.payload_sha256,
          hashSeasonRolloverItem(projection)
        );
      }
      const root = database
        .prepare(
          `SELECT contracts_advanced,
                  contracts_expired,
                  ownerships_carried,
                  ownerships_released,
                  retention_years_advanced,
                  retention_obligations_completed,
                  buyout_years_advanced,
                  buyout_obligations_completed,
                  trades_cancelled,
                  manifest_schema_version,
                  manifest_sha256
           FROM season_rollovers
           WHERE id = ?`
        )
        .get(IDS.rollover);
      assert.deepEqual(root, {
        contracts_advanced: 1,
        contracts_expired: 1,
        ownerships_carried: 2,
        ownerships_released: 1,
        retention_years_advanced: 1,
        retention_obligations_completed: 1,
        buyout_years_advanced: 1,
        buyout_obligations_completed: 1,
        trades_cancelled: 1,
        manifest_schema_version: 1,
        manifest_sha256: root.manifest_sha256,
      });
      assert.match(
        root.manifest_sha256,
        /^[0-9a-f]{64}$/
      );
      assert.deepEqual(
        repository.findDurableSeasonRolloverResult({
          leagueId: IDS.league,
          rolloverId: IDS.rollover,
        }),
        receipt
      );
      assert.deepEqual(
        repository
          .findDurableSeasonRolloverOwnershipReceipt(
            {
              leagueId: IDS.league,
              rolloverId: IDS.rollover,
            }
          ),
        ownershipReceipt
      );

      const readOwnershipReceipt = () =>
        repository
          .findDurableSeasonRolloverOwnershipReceipt({
            leagueId: IDS.league,
            rolloverId: IDS.rollover,
          });
      const assertTamperRejected = (mutate) => {
        database.exec(
          "SAVEPOINT rollover_ownership_receipt_tamper"
        );
        try {
          mutate();
          assert.throws(
            readOwnershipReceipt,
            (error) =>
              error.code ===
              "REPOSITORY_SCHEMA_INCOMPATIBLE"
          );
        } finally {
          database.exec(
            "ROLLBACK TO rollover_ownership_receipt_tamper"
          );
          database.exec(
            "RELEASE rollover_ownership_receipt_tamper"
          );
        }
      };
      assertTamperRejected(() => {
        database.exec(
          "DROP TRIGGER IF EXISTS season_rollovers_immutable_update"
        );
        database
          .prepare(
            `UPDATE season_rollovers
             SET ownerships_carried = ownerships_carried + 1
             WHERE id = ?`
          )
          .run(IDS.rollover);
      });
      assertTamperRejected(() => {
        database.exec(
          "DROP TRIGGER IF EXISTS season_rollover_items_immutable_update"
        );
        database
          .prepare(
            `UPDATE season_rollover_items
             SET payload_sha256 = ?
             WHERE rollover_id = ?
               AND effect_kind = 'ownership_carried'`
          )
          .run("0".repeat(64), IDS.rollover);
      });
      const carriedOwnershipEventId = database
        .prepare(
          `SELECT ownership_event_id
           FROM season_rollover_items
           WHERE rollover_id = ?
             AND effect_kind = 'ownership_carried'
           ORDER BY id
           LIMIT 1`
        )
        .get(IDS.rollover).ownership_event_id;
      assertTamperRejected(() => {
        database
          .prepare(
            `UPDATE ownership_events
             SET reason = 'tampered'
             WHERE id = ?`
          )
          .run(carriedOwnershipEventId);
      });
      assert.deepEqual(
        readOwnershipReceipt(),
        ownershipReceipt
      );

      const frozenEvidence = {
        root: database
          .prepare(
            `SELECT * FROM season_rollovers
             WHERE id = ?`
          )
          .get(IDS.rollover),
        items: database
          .prepare(
            `SELECT * FROM season_rollover_items
             WHERE rollover_id = ?
             ORDER BY id`
          )
          .all(IDS.rollover),
      };
      database
        .prepare(
          `UPDATE contracts
           SET auction_buyout_lock_expires_at_ms = ?,
               updated_at_ms = ?,
               version = 3
           WHERE id = ?
             AND status = 'active'
             AND version = 2`
        )
        .run(
          COMPLETED_AT_MS + 86_400_000,
          COMPLETED_AT_MS + 1_000,
          fixture.ids.advancedContract
        );
      insertFullSchemaRow(
        database,
        "contract_events",
        {
          id: uuid(800),
          league_id: IDS.league,
          contract_id:
            fixture.ids.advancedContract,
          player_id: fixture.ids.advancedPlayer,
          team_id: fixture.ids.teamA,
          actor_user_id: IDS.commissioner,
          event_type:
            "summer_contract_descendant",
          source_type: "commissioner_correction",
          source_id: uuid(801),
          metadata_json: "{}",
          reason:
            "Post-rollover summer descendant.",
          occurred_at_ms:
            COMPLETED_AT_MS + 1_000,
        }
      );
      assert.deepEqual(
        repository.findDurableSeasonRolloverResult({
          leagueId: IDS.league,
          rolloverId: IDS.rollover,
        }),
        receipt
      );
      assert.deepEqual(
        repository
          .findDurableSeasonRolloverOwnershipReceipt(
            {
              leagueId: IDS.league,
              rolloverId: IDS.rollover,
            }
          ),
        ownershipReceipt
      );
      assert.deepEqual(
        {
          root: database
            .prepare(
              `SELECT * FROM season_rollovers
               WHERE id = ?`
            )
            .get(IDS.rollover),
          items: database
            .prepare(
              `SELECT * FROM season_rollover_items
               WHERE rollover_id = ?
               ORDER BY id`
            )
            .all(IDS.rollover),
        },
        frozenEvidence
      );
    });

    test("executes, rolls back, and replays the lifecycle-v2 exemption through the migrated production repository", async (t) => {
      const runtime =
        fullSchemaExemptionHarness(t);
      const emptyCounts = {
        lifecycleRequests: 0,
        exemptions: 0,
        activities: 0,
        audits: 0,
        notifications: 0,
        outboxEvents: 0,
        outboxAudiences: 0,
        readinessOperations: 0,
        readinessJobs: 0,
      };

      assert.equal(
        runtime.database.pragma("user_version", {
          simple: true,
        }),
        latestMigrationVersion()
      );
      assert.equal(
        runtime.database
          .prepare(
            `SELECT metadata_value
             FROM application_metadata
             WHERE metadata_key =
               'data_model_version'`
          )
          .get().metadata_value,
        String(latestMigrationVersion())
      );
      assert.deepEqual(
        lifecycleExemptionMutationCounts(
          runtime.database
        ),
        emptyCounts
      );

      await assert.rejects(() =>
        runtime.service.transition(runtime.command)
      );
      assert.equal(runtime.generatedIdCount(), 8);
      assert.equal(runtime.handoffCalls.length, 0);
      assert.deepEqual(
        lifecycleExemptionMutationCounts(
          runtime.database
        ),
        emptyCounts
      );
      assert.deepEqual(
        runtime.database
          .prepare("PRAGMA foreign_key_check")
          .all(),
        []
      );

      runtime.faults.operation = null;
      const first = await runtime.service.transition(
        runtime.command
      );
      assert.equal(first.replayed, false);
      assert.deepEqual({ ...first }, {
        exemptionId: uuid(309),
        leagueId: runtime.ids.league,
        seasonId: runtime.ids.season,
        exemptionKind:
          "initial_season2_transition",
        reason:
          "Approved one-time imported Season 2 transition.",
        authorizedByUserId: runtime.ids.user,
        authorizedAuthority:
          "platform_administrator_as_commissioner",
        authorizedAtMs: 20_000,
        consumed: false,
        migrationReportId:
          runtime.ids.migrationReport,
        version: 1,
      });
      assert.equal(runtime.generatedIdCount(), 16);
      assert.deepEqual(runtime.handoffCalls, [
        {
          operationId: uuid(315),
          jobRunId: uuid(316),
          leagueId: runtime.ids.league,
          seasonId: runtime.ids.season,
          triggerKind:
            "no_draft_initial_season2",
          triggerResourceId: first.exemptionId,
          entryDraftId: null,
          setupExemptionId: first.exemptionId,
          createdAtMs: 20_000,
        },
      ]);

      const completedRequest = runtime.database
        .prepare(
          `SELECT *
           FROM idempotency_requests
           WHERE league_id = ?
             AND operation = ?`
        )
        .get(
          runtime.ids.league,
          LEAGUE_LIFECYCLE_TRANSITION_OPERATION
        );
      assert.equal(
        completedRequest.status,
        "completed"
      );
      assert.equal(
        completedRequest.result_type,
        "free_agent_draft_setup_exemption"
      );
      assert.equal(
        completedRequest.result_id,
        first.exemptionId
      );
      assert.equal(
        completedRequest.completed_at_ms,
        first.authorizedAtMs
      );
      assert.deepEqual(
        lifecycleExemptionMutationCounts(
          runtime.database
        ),
        {
          lifecycleRequests: 1,
          exemptions: 1,
          activities: 1,
          audits: 1,
          notifications: 1,
          outboxEvents: 3,
          outboxAudiences: 3,
          readinessOperations: 1,
          readinessJobs: 1,
        }
      );
      const exemptionEvidence = runtime.database
        .prepare(
          `SELECT *
           FROM free_agent_draft_setup_exemptions
           WHERE league_id = ? AND id = ?`
        )
        .get(runtime.ids.league, first.exemptionId);
      assert.equal(
        exemptionEvidence.authorization_activity_id,
        uuid(311)
      );
      assert.equal(
        exemptionEvidence.commissioner_notification_id,
        uuid(313)
      );
      assert.equal(
        exemptionEvidence.outbox_event_id,
        uuid(314)
      );
      const notification = runtime.database
        .prepare(
          `SELECT * FROM notifications
           WHERE league_id = ? AND id = ?`
        )
        .get(
          runtime.ids.league,
          exemptionEvidence.commissioner_notification_id
        );
      assert.equal(
        notification.user_id,
        runtime.ids.commissionerUser
      );
      assert.notEqual(
        notification.user_id,
        runtime.ids.user
      );
      assert.equal(
        notification.deduplication_key,
        "fad_setup_exemption_authorized:" +
          `${runtime.ids.league}:` +
          `${runtime.ids.season}:` +
          `${first.exemptionId}:` +
          runtime.ids.commissionerUser
      );
      assert.deepEqual(
        parseCanonicalJsonV1(
          notification.message_data_json
        ),
        {
          destination: {
            kind: "commissioner_fad",
            leagueId: runtime.ids.league,
            seasonId: runtime.ids.season,
          },
          exemptionId: first.exemptionId,
          leagueId: runtime.ids.league,
          seasonId: runtime.ids.season,
        }
      );
      const expectedActivityOutboxId =
        deterministicUuid(
          `fad-setup-exemption:activity-publication:${uuid(311)}`
        );
      const expectedNotificationOutboxId =
        deterministicUuid(
          `fad-setup-exemption:notification-publication:${uuid(313)}`
        );
      const outboxRows = runtime.database
        .prepare(
          `SELECT * FROM outbox_events
           WHERE league_id = ? AND created_at_ms = ?
           ORDER BY event_type`
        )
        .all(runtime.ids.league, 20_000);
      assert.deepEqual(
        outboxRows.map((row) => ({
          id: row.id,
          eventType: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: JSON.parse(row.payload_json),
        })),
        [
          {
            id: expectedActivityOutboxId,
            eventType: "activity.created",
            aggregateType: "activity",
            aggregateId: uuid(311),
            payload: createSocketEventEnvelope({
              eventId: expectedActivityOutboxId,
              type: "activity.created",
              leagueId: runtime.ids.league,
              resourceId: uuid(311),
              version: 1,
              reasonCode:
                "setup_exemption_authorized",
              occurredAt: 20_000,
              related: createEmptySocketRelated(),
            }),
          },
          {
            id: uuid(314),
            eventType: "league.changed",
            aggregateType: "league",
            aggregateId: runtime.ids.league,
            payload: createSocketEventEnvelope({
              eventId: uuid(314),
              type: "league.changed",
              leagueId: runtime.ids.league,
              resourceId: runtime.ids.league,
              version: 2,
              reasonCode: "league_changed",
              occurredAt: 20_000,
              related: createEmptySocketRelated(),
            }),
          },
          {
            id: expectedNotificationOutboxId,
            eventType: "notification.created",
            aggregateType: "notification",
            aggregateId: uuid(313),
            payload: createSocketEventEnvelope({
              eventId: expectedNotificationOutboxId,
              type: "notification.created",
              leagueId: runtime.ids.league,
              resourceId: uuid(313),
              version: 1,
              reasonCode:
                "setup_exemption_authorized",
              occurredAt: 20_000,
              related: createEmptySocketRelated(),
            }),
          },
        ]
      );
      assert.deepEqual(
        runtime.database
          .prepare(
            `SELECT outbox_event_id, audience_kind,
                    team_id, user_id, created_at_ms
             FROM outbox_event_audiences
             WHERE league_id = ?
             ORDER BY outbox_event_id`
          )
          .all(runtime.ids.league),
        [
          {
            outbox_event_id:
              expectedActivityOutboxId,
            audience_kind: "league",
            team_id: null,
            user_id: null,
            created_at_ms: 20_000,
          },
          {
            outbox_event_id:
              expectedNotificationOutboxId,
            audience_kind: "user",
            team_id: null,
            user_id:
              runtime.ids.commissionerUser,
            created_at_ms: 20_000,
          },
          {
            outbox_event_id: uuid(314),
            audience_kind: "league",
            team_id: null,
            user_id: null,
            created_at_ms: 20_000,
          },
        ].sort((left, right) =>
          left.outbox_event_id.localeCompare(
            right.outbox_event_id
          )
        )
      );
      const readiness = runtime.database
        .prepare(
          `SELECT *
           FROM free_agent_draft_readiness_operations
           WHERE league_id = ? AND season_id = ?`
        )
        .get(runtime.ids.league, runtime.ids.season);
      assert.equal(readiness.id, uuid(315));
      assert.equal(
        readiness.trigger_kind,
        "no_draft_initial_season2"
      );
      assert.equal(readiness.entry_draft_id, null);
      assert.equal(
        readiness.setup_exemption_id,
        first.exemptionId
      );
      assert.equal(readiness.job_run_id, uuid(316));
      assert.equal(readiness.status, "pending");
      assert.equal(readiness.attempt_count, 0);
      assert.equal(readiness.blockers_json, "[]");
      assert.equal(readiness.created_at_ms, 20_000);
      assert.equal(readiness.updated_at_ms, 20_000);
      assert.equal(readiness.version, 1);
      const readinessJob = runtime.database
        .prepare(
          `SELECT * FROM job_runs
           WHERE league_id = ? AND season_id = ?
             AND job_type = 'fad_readiness'`
        )
        .get(runtime.ids.league, runtime.ids.season);
      assert.equal(readinessJob.id, uuid(316));
      assert.equal(
        readinessJob.occurrence_key,
        readiness.readiness_occurrence_key
      );
      assert.equal(readinessJob.status, "pending");
      assert.equal(readinessJob.attempt_count, 0);
      assert.equal(readinessJob.scheduled_for_ms, 20_000);
      assert.equal(readinessJob.created_at_ms, 20_000);
      assert.equal(readinessJob.updated_at_ms, 20_000);
      assert.equal(readinessJob.version, 1);

      const generatedBeforeReplay =
        runtime.generatedIdCount();
      const bytesBeforeReplay =
        runtime.database.serialize();
      const replay = await runtime.service.transition(
        runtime.command
      );
      assert.equal(replay.replayed, true);
      assert.deepEqual(
        { ...replay },
        { ...first }
      );
      assert.equal(
        runtime.generatedIdCount(),
        generatedBeforeReplay
      );
      assert.equal(runtime.handoffCalls.length, 1);
      assert.equal(
        bytesBeforeReplay.equals(
          runtime.database.serialize()
        ),
        true
      );
      assert.deepEqual(
        lifecycleExemptionMutationCounts(
          runtime.database
        ),
        {
          lifecycleRequests: 1,
          exemptions: 1,
          activities: 1,
          audits: 1,
          notifications: 1,
          outboxEvents: 3,
          outboxAudiences: 3,
          readinessOperations: 1,
          readinessJobs: 1,
        }
      );

      const consumption =
        consumeInitialSeason2Exemption(
          runtime.database,
          runtime.ids,
          first.exemptionId
        );
      assert.equal(consumption.readinessId, uuid(315));
      assert.equal(consumption.readinessJobId, uuid(316));
      assert.deepEqual(
        runtime.database
          .prepare(
            `SELECT consumed_fad_id,
                    consumed_at_ms,
                    version
             FROM free_agent_draft_setup_exemptions
             WHERE league_id = ?
               AND id = ?`
          )
          .get(
            runtime.ids.league,
            first.exemptionId
          ),
        {
          consumed_fad_id: consumption.fadId,
          consumed_at_ms:
            consumption.openedAtMs,
          version: 2,
        }
      );
      const generatedBeforeConsumedReplay =
        runtime.generatedIdCount();
      const bytesBeforeConsumedReplay =
        runtime.database.serialize();
      const consumedReplay =
        await runtime.service.transition(
          runtime.command
        );
      assert.equal(consumedReplay.replayed, true);
      assert.deepEqual(
        { ...consumedReplay },
        { ...first }
      );
      assert.equal(
        runtime.generatedIdCount(),
        generatedBeforeConsumedReplay
      );
      assert.equal(runtime.handoffCalls.length, 1);
      assert.equal(
        bytesBeforeConsumedReplay.equals(
          runtime.database.serialize()
        ),
        true
      );
      assert.deepEqual(
        lifecycleExemptionMutationCounts(
          runtime.database
        ),
        {
          lifecycleRequests: 1,
          exemptions: 1,
          activities: 1,
          audits: 1,
          notifications: 1,
          outboxEvents: 3,
          outboxAudiences: 3,
          readinessOperations: 1,
          readinessJobs: 1,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare("PRAGMA foreign_key_check")
          .all(),
        []
      );
      assert.deepEqual(
        runtime.database
          .prepare("PRAGMA integrity_check")
          .all(),
        [{ integrity_check: "ok" }]
      );
    });

    for (const recipientDrift of [
      {
        name: "commissioner permission drift",
        apply(database, ids) {
          database
            .prepare(
              `UPDATE league_memberships
               SET permission_category = 'manager'
               WHERE id = ?`
            )
            .run(ids.commissionerMembership);
        },
      },
      {
        name: "inactive commissioner membership",
        apply(database, ids) {
          database
            .prepare(
              `UPDATE league_memberships
               SET status = 'suspended'
               WHERE id = ?`
            )
            .run(ids.commissionerMembership);
        },
      },
      {
        name: "future commissioner join",
        apply(database, ids) {
          database
            .prepare(
              `UPDATE league_memberships
               SET joined_at_ms = 20001
               WHERE id = ?`
            )
            .run(ids.commissionerMembership);
        },
      },
      {
        name: "ended commissioner membership",
        apply(database, ids) {
          database
            .prepare(
              `UPDATE league_memberships
               SET ended_at_ms = 19999
               WHERE id = ?`
            )
            .run(ids.commissionerMembership);
        },
      },
      {
        name: "inactive commissioner user",
        apply(database, ids) {
          database
            .prepare(
              `UPDATE users
               SET status = 'deactivated'
               WHERE id = ?`
            )
            .run(ids.commissionerUser);
        },
      },
    ]) {
      test(`fails closed with zero writes after ${recipientDrift.name}`, async (t) => {
        const runtime =
          fullSchemaExemptionHarness(t);
        runtime.faults.operation = null;
        recipientDrift.apply(
          runtime.database,
          runtime.ids
        );

        await assert.rejects(
          () =>
            runtime.service.transition(
              runtime.command
            ),
          (error) => {
            assert.equal(
              error.code,
              "INITIAL_SEASON2_NO_DRAFT_NOT_ELIGIBLE"
            );
            assert.equal(
              error.reasonCode,
              "lifecycle_not_eligible"
            );
            return true;
          }
        );

        assert.equal(runtime.generatedIdCount(), 0);
        assert.deepEqual(runtime.handoffCalls, []);
        assert.deepEqual(
          lifecycleExemptionMutationCounts(
            runtime.database
          ),
          {
            lifecycleRequests: 0,
            exemptions: 0,
            activities: 0,
            audits: 0,
            notifications: 0,
            outboxEvents: 0,
            outboxAudiences: 0,
            readinessOperations: 0,
            readinessJobs: 0,
          }
        );
      });
    }

    test("reauthorizes the calling administrator before a zero-write durable replay", async (t) => {
      const runtime =
        fullSchemaExemptionHarness(t);
      runtime.faults.operation = null;
      const first = await runtime.service.transition(
        runtime.command
      );
      assert.equal(first.replayed, false);
      runtime.database
        .prepare(
          `UPDATE league_memberships
           SET status = 'ended',
               ended_at_ms = 21000,
               updated_at_ms = 21000,
               version = version + 1
           WHERE id = ?`
        )
        .run(runtime.ids.membership);
      const bytesBeforeReplay =
        runtime.database.serialize();
      const countsBeforeReplay =
        lifecycleExemptionMutationCounts(
          runtime.database
        );

      await assert.rejects(
        () =>
          runtime.service.transition(
            runtime.command
          ),
        (error) => {
          assert.equal(
            error.code,
            "PLATFORM_ADMINISTRATOR_REQUIRED"
          );
          return true;
        }
      );

      assert.equal(
        bytesBeforeReplay.equals(
          runtime.database.serialize()
        ),
        true
      );
      assert.deepEqual(
        lifecycleExemptionMutationCounts(
          runtime.database
        ),
        countsBeforeReplay
      );
      assert.equal(runtime.generatedIdCount(), 8);
      assert.equal(runtime.handoffCalls.length, 1);
    });

    for (const writerFailure of [
      "writeSetupNotification",
      "writeActivityOutbox",
      "writeNotificationOutbox",
      "dropActivityOutbox",
      "corruptNotificationAudience",
    ]) {
      test(`rolls every setup-exemption effect back after ${writerFailure}`, async (t) => {
        const runtime =
          fullSchemaExemptionHarness(t);
        runtime.faults.operation = writerFailure;

        await assert.rejects(
          () =>
            runtime.service.transition(
              runtime.command
            )
        );

        assert.equal(runtime.generatedIdCount(), 8);
        assert.deepEqual(runtime.handoffCalls, []);
        assert.deepEqual(
          lifecycleExemptionMutationCounts(
            runtime.database
          ),
          {
            lifecycleRequests: 0,
            exemptions: 0,
            activities: 0,
            audits: 0,
            notifications: 0,
            outboxEvents: 0,
            outboxAudiences: 0,
            readinessOperations: 0,
            readinessJobs: 0,
          }
        );
      });
    }

    test("fails closed and rolls back all new effects when the setup notification dedup tuple collides", async (t) => {
      const runtime =
        fullSchemaExemptionHarness(t);
      runtime.faults.operation = null;
      const collidingExemptionId = uuid(301);
      const collidingNotificationId = uuid(900);
      const messageData = {
        leagueId: runtime.ids.league,
        seasonId: runtime.ids.season,
        exemptionId: collidingExemptionId,
        destination: {
          kind: "commissioner_fad",
          leagueId: runtime.ids.league,
          seasonId: runtime.ids.season,
        },
      };
      const deduplicationKey =
        "fad_setup_exemption_authorized:" +
        `${runtime.ids.league}:` +
        `${runtime.ids.season}:` +
        `${collidingExemptionId}:` +
        runtime.ids.commissionerUser;
      insertFullSchemaRow(
        runtime.database,
        "notifications",
        {
          id: collidingNotificationId,
          user_id: runtime.ids.commissionerUser,
          league_id: runtime.ids.league,
          event_type:
            "fad_setup_exemption_authorized",
          message_data_json:
            serializeCanonicalJsonV1(messageData),
          related_feature:
            "free_agent_draft_setup",
          related_record_id:
            collidingExemptionId,
          delivery_status: "pending",
          created_at_ms: 20_000,
          read_at_ms: null,
          delivered_at_ms: null,
          version: 1,
          deduplication_key: deduplicationKey,
        }
      );

      await assert.rejects(
        () =>
          runtime.service.transition(
            runtime.command
          )
      );

      assert.equal(runtime.generatedIdCount(), 8);
      assert.deepEqual(runtime.handoffCalls, []);
      assert.deepEqual(
        lifecycleExemptionMutationCounts(
          runtime.database
        ),
        {
          lifecycleRequests: 0,
          exemptions: 0,
          activities: 0,
          audits: 0,
          notifications: 1,
          outboxEvents: 0,
          outboxAudiences: 0,
          readinessOperations: 0,
          readinessJobs: 0,
        }
      );
      assert.equal(
        runtime.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM notifications
             WHERE id = ?`
          )
          .get(collidingNotificationId).count,
        1
      );
    });

    for (const failingStep of [
      "after_readiness_job_insert",
      "after_readiness_operation_insert",
    ]) {
      test(`rolls the complete lifecycle-v2 exemption back at ${failingStep}`, async (t) => {
        const runtime =
          fullSchemaExemptionHarness(t);
        runtime.faults.operation = failingStep;

        await assert.rejects(
          () => runtime.service.transition(runtime.command),
          (error) =>
            error?.cause?.message ===
              `injected:${failingStep}` ||
            error?.message ===
              `injected:${failingStep}` ||
            error?.code ===
              "REPOSITORY_OPERATION_FAILED"
        );

        assert.equal(runtime.generatedIdCount(), 8);
        assert.equal(runtime.handoffCalls.length, 1);
        assert.deepEqual(
          lifecycleExemptionMutationCounts(
            runtime.database
          ),
          {
            lifecycleRequests: 0,
            exemptions: 0,
            activities: 0,
            audits: 0,
            notifications: 0,
            outboxEvents: 0,
            outboxAudiences: 0,
            readinessOperations: 0,
            readinessJobs: 0,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare("PRAGMA foreign_key_check")
            .all(),
          []
        );
      });
    }

    test("uses occurrence-local MAX(attempt_number), commits blockers only, and rolls a late injected failure back", (t) => {
      const {
        database,
        faults,
        repository,
        transaction,
      } = harness(t);
      const scheduled = transaction(() =>
        repository.beginSeasonRolloverAttempt(
          scheduledAttemptCommand()
        )
      );
      assert.equal(scheduled.attemptNumber, 1);
      assert.deepEqual(
        repository.validateScheduledRolloverJobLease({
          leagueId: IDS.league,
          bindingId: IDS.binding,
          entryDraftId: IDS.entryDraft,
          rolloverOccurrenceId:
            IDS.occurrence,
          scheduledJob:
            scheduledAttemptCommand()
              .scheduledJob,
        }),
        { valid: true }
      );

      faults.operation =
        "blockSeasonRolloverAttempt";
      assert.throws(
        () =>
          transaction(() =>
            repository.blockSeasonRolloverAttempt({
              attemptId: IDS.scheduledAttempt,
              bindingId: IDS.binding,
              leagueId: IDS.league,
              entryDraftId: IDS.entryDraft,
              rolloverOccurrenceId:
                IDS.occurrence,
              expectedBindingVersion: 1,
              expectedSourceSeasonVersion: 4,
              expectedTargetSeasonVersion: 3,
              expectedEntryDraftVersion: 2,
              triggerKind: "scheduled_job",
              scheduledJob:
                scheduledAttemptCommand()
                  .scheduledJob,
              retryIdempotencyRequestId: null,
              blockers: blockers(),
              blockedAtMs: STARTS_AT_MS + 10,
            })
          ),
        (error) =>
          error.cause?.message ===
          "injected:blockSeasonRolloverAttempt"
      );
      assert.equal(
        database
          .prepare(
            `SELECT status
             FROM season_rollover_attempts
             WHERE id = ?`
          )
          .get(IDS.scheduledAttempt).status,
        "started"
      );
      assert.equal(
        database
          .prepare(
            `SELECT status
             FROM entry_draft_rollover_bindings
             WHERE id = ?`
          )
          .get(IDS.binding).status,
        "scheduled"
      );

      faults.operation = null;
      const blocked = transaction(() =>
        repository.blockSeasonRolloverAttempt({
          attemptId: IDS.scheduledAttempt,
          bindingId: IDS.binding,
          leagueId: IDS.league,
          entryDraftId: IDS.entryDraft,
          rolloverOccurrenceId:
            IDS.occurrence,
          expectedBindingVersion: 1,
          expectedSourceSeasonVersion: 4,
          expectedTargetSeasonVersion: 3,
          expectedEntryDraftVersion: 2,
          triggerKind: "scheduled_job",
          scheduledJob:
            scheduledAttemptCommand().scheduledJob,
          retryIdempotencyRequestId: null,
          blockers: blockers(),
          blockedAtMs: STARTS_AT_MS + 10,
        })
      );
      assert.equal(blocked.status, "blocked");
      assert.deepEqual(blocked.blockers, blockers());
      assert.equal(
        database
          .prepare(
            `SELECT status
             FROM entry_drafts
             WHERE id = ?`
          )
          .get(IDS.entryDraft).status,
        "ready"
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM season_rollovers`
          )
          .get().count,
        0
      );

      transaction(() => {
        repository.insertStartedIdempotencyRequest({
          id: IDS.retryIdempotency,
          leagueId: IDS.league,
          actorUserId: IDS.commissioner,
          operation:
            "league.lifecycle.transition.v2",
          clientKey: "retry-once",
          requestHash: "a".repeat(64),
          createdAtMs: STARTS_AT_MS + 20,
          expiresAtMs:
            STARTS_AT_MS + 86_400_020,
        });
        return repository.beginSeasonRolloverAttempt({
          ...scheduledAttemptCommand(),
          attemptId: IDS.retryAttempt,
          expectedBindingVersion: 2,
          expectedPriorAttemptId:
            IDS.scheduledAttempt,
          expectedPriorAttemptNumber: 1,
          triggerKind: "commissioner_retry",
          scheduledJob: null,
          retryIdempotencyRequestId:
            IDS.retryIdempotency,
          retryActorUserId: IDS.commissioner,
          retryActorMembershipId:
            IDS.membership,
          retryAuthority: "commissioner",
          startedAtMs: STARTS_AT_MS + 20,
        });
      });
      database.prepare(
        `INSERT INTO season_rollover_attempts
         SELECT ?, league_id, binding_id, ?,
           entry_draft_id, from_season_id, to_season_id,
           target_schedule_id, target_schedule_version,
           week_one_matchup_week_id, week_one_starts_at_ms,
           scheduled_starts_at_ms, occurrence_key,
           99, trigger_kind, scheduled_job_run_id,
           retry_idempotency_request_id,
           retry_by_user_id, retry_by_membership_id,
           retry_authority, 'blocked', ?,
           NULL, source_season_version_observed,
           target_season_version_observed,
           entry_draft_version_observed,
           started_at_ms, started_at_ms,
           created_at_ms, updated_at_ms, 2
         FROM season_rollover_attempts
         WHERE id = ?`
      ).run(
        uuid(80),
        IDS.supersededOccurrence,
        JSON.stringify(blockers()),
        IDS.scheduledAttempt
      );
      const latest =
        repository.findLatestSeasonRolloverAttempt({
          leagueId: IDS.league,
          bindingId: IDS.binding,
          rolloverOccurrenceId:
            IDS.occurrence,
        });
      assert.equal(latest.attemptId, IDS.retryAttempt);
      assert.equal(latest.attemptNumber, 2);

      const plan = successPlan();
      faults.operation =
        "commitSeasonRolloverAndOpenDraft";
      assert.throws(
        () =>
          transaction(() =>
            repository.commitSeasonRolloverAndOpenDraft({
              plan,
              scheduledJob: null,
            })
          ),
        (error) =>
          error.cause?.message ===
          "injected:commitSeasonRolloverAndOpenDraft"
      );
      assert.equal(
        database
          .prepare(
            `SELECT current_season_id, version
             FROM leagues WHERE id = ?`
          )
          .get(IDS.league).current_season_id,
        IDS.sourceSeason
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM season_rollovers`
          )
          .get().count,
        0
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM entry_draft_pick_clocks`
          )
          .get().count,
        0
      );

      faults.operation = null;
      const receipt = transaction(() =>
        repository.commitSeasonRolloverAndOpenDraft({
          plan,
          scheduledJob: null,
        })
      );
      assert.equal(receipt.rolloverId, IDS.rollover);
      assert.equal(
        receipt.rolloverOccurrenceId,
        IDS.occurrence
      );
      assert.deepEqual(receipt.summary, emptySummary());
      assert.deepEqual(
        repository.findDurableSeasonRolloverResult({
          leagueId: IDS.league,
          rolloverId: IDS.rollover,
        }),
        receipt
      );
      assert.equal(
        repository.findDurableSeasonRolloverResult({
          leagueId: IDS.otherLeague,
          rolloverId: IDS.rollover,
        }),
        null
      );
      assert.deepEqual(
        repository
          .findDurableSeasonRolloverOwnershipReceipt(
            {
              leagueId: IDS.league,
              rolloverId: IDS.rollover,
            }
          ),
        {
          rolloverId: IDS.rollover,
          leagueId: IDS.league,
          fromSeasonId: IDS.sourceSeason,
          toSeasonId: IDS.targetSeason,
          teams: [],
        }
      );
      assert.equal(
        repository
          .findDurableSeasonRolloverOwnershipReceipt(
            {
              leagueId: IDS.otherLeague,
              rolloverId: IDS.rollover,
            }
          ),
        null
      );
      const clock = database
        .prepare(
          `SELECT *
           FROM entry_draft_pick_clocks
           WHERE id = ?`
        )
        .get(IDS.firstClock);
      assert.equal(
        clock.owning_team_id,
        IDS.firstPickOwner
      );
      assert.equal(clock.status, "prepared");
      assert.equal(
        database
          .prepare(
            `SELECT status
             FROM entry_drafts
             WHERE id = ?`
          )
          .get(IDS.entryDraft).status,
        "active"
      );
      assert.equal(
        database
          .prepare(
            `SELECT selection_gate_status,
                    trading_gate_status
             FROM entry_draft_rollover_bindings
             WHERE id = ?`
          )
          .get(IDS.binding)
          .selection_gate_status,
        "open"
      );
      transaction(() =>
        repository.completeIdempotencyRequest({
          id: IDS.retryIdempotency,
          leagueId: IDS.league,
          resultType: "season_rollover",
          resultId: IDS.rollover,
          completedAtMs: COMPLETED_AT_MS,
        })
      );
      assert.deepEqual(
        repository.findIdempotencyRequest({
          leagueId: IDS.league,
          operation:
            "league.lifecycle.transition.v2",
          clientKey: "retry-once",
        }),
        {
          id: IDS.retryIdempotency,
          leagueId: IDS.league,
          actorUserId: IDS.commissioner,
          operation:
            "league.lifecycle.transition.v2",
          clientKey: "retry-once",
          requestHash: "a".repeat(64),
          status: "completed",
          resultType: "season_rollover",
          resultId: IDS.rollover,
          createdAtMs: STARTS_AT_MS + 20,
          completedAtMs: COMPLETED_AT_MS,
          expiresAtMs:
            STARTS_AT_MS + 86_400_020,
        }
      );
    });
  }
);
