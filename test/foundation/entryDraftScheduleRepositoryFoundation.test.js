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
  ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
  ENTRY_DRAFT_RESCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
  ENTRY_DRAFT_SCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_OPERATION,
} = require(
  "../../src/domain/drafts/entryDraftSchedulePolicy"
);
const {
  calculateStandings,
} = require(
  "../../src/domain/matchups/matchupStandingsPolicy"
);
const {
  calculateStandingsResultSetHash,
} = require(
  "../../src/domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
  buildSeasonRolloverOccurrenceKey,
} = require(
  "../../src/domain/leagues/seasonRolloverJobPolicy"
);
const {
  createEntryDraftScheduleService,
} = require(
  "../../src/application/services/drafts/createEntryDraftScheduleService"
);
const {
  createSqliteEntryDraftScheduleRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteEntryDraftScheduleRepository"
);
const {
  STANDINGS_FINALIZATION_OPERATION,
  createSqliteMatchupStandingsFinalizationRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteMatchupStandingsFinalizationRepository"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse(
  "2026-07-29T16:00:00.000Z"
);
const SOURCE_ENDS_AT_MS =
  NOW_MS - 60 * DAY_MS;
const TARGET_STARTS_AT_MS =
  NOW_MS + 60 * DAY_MS;
const TARGET_PLAYOFFS_AT_MS =
  NOW_MS + 200 * DAY_MS;
const TARGET_ENDS_AT_MS =
  NOW_MS + 228 * DAY_MS;
const INITIAL_STARTS_AT_MS =
  NOW_MS + 7 * DAY_MS;
const SOURCE_WEEK_STARTS_AT_MS =
  SOURCE_ENDS_AT_MS - 7 * DAY_MS;
const SOURCE_FINALIZED_AT_MS =
  SOURCE_ENDS_AT_MS + 1_000;

const IDS = Object.freeze({
  league: uuid(1),
  commissionerUser: uuid(2),
  otherUser: uuid(3),
  commissionerMembership: uuid(4),
  otherMembership: uuid(5),
  sourceSeason: uuid(6),
  targetSeason: uuid(7),
  draft: uuid(8),
  standingsSnapshot: uuid(9),
  finalization: uuid(10),
  targetSchedule: uuid(11),
  weekOne: uuid(12),
  lottery: uuid(13),
  teamOne: uuid(14),
  teamTwo: uuid(15),
  eligibility: uuid(16),
  eligiblePlayer: uuid(17),
});
const FULL_IDS = Object.freeze({
  sourceWeek: uuid(700),
  sourceMatchup: uuid(701),
  sourceScheduleOperation: uuid(702),
  statSource: uuid(703),
  statRefresh: uuid(704),
  statSnapshot: uuid(705),
  matchupResult: uuid(706),
  resultVersion: uuid(707),
  currentStandingsSnapshot: uuid(708),
  finalizationIdempotency: uuid(709),
  finalStandingsRowOne: uuid(710),
  finalStandingsRowTwo: uuid(711),
  finalResultLink: uuid(712),
  finalTeamIdentityOne: uuid(713),
  finalTeamIdentityTwo: uuid(714),
  finalStandingsOperation: uuid(715),
  finalizationNotificationOne: uuid(716),
  finalizationNotificationTwo: uuid(717),
  finalizationOutbox: uuid(718),
  lotteryResultOne: uuid(719),
  lotteryResultTwo: uuid(720),
  player: uuid(721),
  eligiblePlayerRow: uuid(722),
});
const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function createSchema(database) {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TABLE leagues (
      id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL,
      current_season_id TEXT,
      commissioner_membership_id TEXT,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE seasons (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      status TEXT NOT NULL,
      regular_season_starts_at_ms INTEGER,
      regular_season_ends_at_ms INTEGER,
      fantasy_playoffs_start_at_ms INTEGER,
      fantasy_playoffs_end_at_ms INTEGER,
      version INTEGER NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE league_memberships (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      permission_category TEXT NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE platform_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE entry_drafts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      status TEXT NOT NULL,
      rounds INTEGER NOT NULL,
      pick_clock_seconds INTEGER NOT NULL,
      starts_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE standings_snapshots (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      snapshot_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE standings_snapshot_finalizations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      standings_snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL,
      finalized_at_ms INTEGER NOT NULL,
      expected_matchup_count INTEGER NOT NULL,
      finalized_matchup_count INTEGER NOT NULL,
      participant_count INTEGER NOT NULL,
      result_set_hash TEXT NOT NULL,
      standings_rule_version INTEGER NOT NULL,
      season_version_after INTEGER NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE matchup_operations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at_ms INTEGER,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE matchup_weeks (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      starts_at_ms INTEGER NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE season_matchup_schedule_generations (
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      schedule_version INTEGER NOT NULL,
      schedule_operation_id TEXT NOT NULL,
      week_one_matchup_week_id TEXT NOT NULL,
      week_one_starts_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (
        league_id,
        season_id,
        schedule_version
      )
    ) STRICT;

    CREATE TABLE draft_lottery_runs (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      participant_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE draft_lottery_results (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      lottery_run_id TEXT NOT NULL,
      original_team_id TEXT NOT NULL,
      final_draft_position INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE draft_eligibility_snapshots (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE draft_eligible_players (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      eligibility_snapshot_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE draft_picks (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      target_season_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      position_number INTEGER NOT NULL,
      original_team_id TEXT NOT NULL,
      current_owner_team_id TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (
        draft_id,
        round_number,
        position_number
      )
    ) STRICT;

    CREATE TABLE idempotency_requests (
      id TEXT PRIMARY KEY,
      league_id TEXT,
      actor_user_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      client_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      result_type TEXT,
      result_id TEXT,
      created_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL,
      UNIQUE (
        league_id,
        actor_user_id,
        operation,
        client_key
      ),
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE job_runs (
      id TEXT PRIMARY KEY,
      league_id TEXT,
      season_id TEXT,
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
      UNIQUE (league_id, id),
      UNIQUE (
        league_id,
        job_type,
        occurrence_key
      )
    ) STRICT;

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
      version INTEGER NOT NULL,
      UNIQUE (league_id, id),
      UNIQUE (league_id, entry_draft_id),
      UNIQUE (
        league_id,
        current_rollover_occurrence_id
      ),
      UNIQUE (
        league_id,
        current_scheduled_job_run_id
      ),
      UNIQUE (
        league_id,
        current_schedule_operation_id
      )
    ) STRICT;

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
      version INTEGER NOT NULL,
      UNIQUE (league_id, id),
      UNIQUE (league_id, occurrence_key),
      UNIQUE (league_id, scheduled_job_run_id)
    ) STRICT;

    CREATE UNIQUE INDEX
      season_rollover_occurrences_one_live_binding
      ON season_rollover_occurrences (
        league_id,
        binding_id
      )
      WHERE status IN (
        'scheduled',
        'blocked',
        'succeeded'
      );

    CREATE TABLE season_rollover_attempts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      rollover_occurrence_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE entry_draft_schedule_operations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      entry_draft_id TEXT NOT NULL,
      action TEXT NOT NULL,
      idempotency_request_id TEXT NOT NULL,
      rollover_binding_id TEXT NOT NULL,
      rollover_occurrence_id TEXT NOT NULL,
      scheduled_job_run_id TEXT NOT NULL,
      superseded_rollover_occurrence_id TEXT,
      superseded_job_run_id TEXT,
      scheduled_starts_at_ms INTEGER NOT NULL,
      entry_draft_version_before INTEGER NOT NULL,
      entry_draft_version_after INTEGER NOT NULL,
      rollover_binding_version_before INTEGER NOT NULL,
      rollover_binding_version_after INTEGER NOT NULL,
      scheduled_job_version INTEGER NOT NULL,
      superseded_job_version_before INTEGER,
      superseded_job_version_after INTEGER,
      scheduled_by_user_id TEXT NOT NULL,
      scheduled_by_membership_id TEXT NOT NULL,
      scheduled_by_authority TEXT NOT NULL,
      reason TEXT,
      result_schema_version INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (league_id, id),
      UNIQUE (league_id, idempotency_request_id),
      UNIQUE (league_id, rollover_occurrence_id),
      UNIQUE (league_id, scheduled_job_run_id)
    ) STRICT;

    CREATE TABLE draft_events (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      actor_user_id TEXT,
      event_type TEXT NOT NULL,
      metadata_json TEXT,
      occurred_at_ms INTEGER NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

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
    ) STRICT;

    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      league_id TEXT,
      event_type TEXT NOT NULL,
      message_data_json TEXT NOT NULL,
      related_feature TEXT,
      related_record_id TEXT,
      delivery_status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      read_at_ms INTEGER,
      delivered_at_ms INTEGER,
      version INTEGER NOT NULL,
      deduplication_key TEXT,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE UNIQUE INDEX
      notifications_user_event_deduplication
      ON notifications (
        user_id,
        event_type,
        deduplication_key
      )
      WHERE deduplication_key IS NOT NULL;

    CREATE TABLE outbox_events (
      id TEXT PRIMARY KEY,
      league_id TEXT,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      available_at_ms INTEGER NOT NULL,
      published_at_ms INTEGER,
      last_error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE TABLE outbox_event_audiences (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      outbox_event_id TEXT NOT NULL,
      audience_kind TEXT NOT NULL,
      team_id TEXT,
      user_id TEXT,
      created_at_ms INTEGER NOT NULL,
      UNIQUE (league_id, id)
    ) STRICT;

    CREATE UNIQUE INDEX
      outbox_event_audiences_one_league
      ON outbox_event_audiences (
        league_id,
        outbox_event_id
      )
      WHERE audience_kind = 'league';
  `);
}

function seed(database) {
  const insertUser = database.prepare(
    "INSERT INTO users (id) VALUES (?)"
  );
  insertUser.run(IDS.commissionerUser);
  insertUser.run(IDS.otherUser);
  database
    .prepare(
      "INSERT INTO leagues " +
        "(id, timezone, current_season_id, " +
        "commissioner_membership_id, version) " +
        "VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      IDS.league,
      "America/Vancouver",
      IDS.sourceSeason,
      IDS.commissionerMembership,
      1
    );
  const insertSeason = database.prepare(`
    INSERT INTO seasons (
      id,
      league_id,
      status,
      regular_season_starts_at_ms,
      regular_season_ends_at_ms,
      fantasy_playoffs_start_at_ms,
      fantasy_playoffs_end_at_ms,
      version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSeason.run(
    IDS.sourceSeason,
    IDS.league,
    "active",
    SOURCE_ENDS_AT_MS - 200 * DAY_MS,
    SOURCE_ENDS_AT_MS,
    SOURCE_ENDS_AT_MS - 28 * DAY_MS,
    SOURCE_ENDS_AT_MS,
    11
  );
  insertSeason.run(
    IDS.targetSeason,
    IDS.league,
    "planned",
    TARGET_STARTS_AT_MS,
    TARGET_ENDS_AT_MS,
    TARGET_PLAYOFFS_AT_MS,
    TARGET_ENDS_AT_MS,
    3
  );
  const insertMembership = database.prepare(`
    INSERT INTO league_memberships (
      id,
      league_id,
      user_id,
      status,
      permission_category
    ) VALUES (?, ?, ?, 'active', ?)
  `);
  insertMembership.run(
    IDS.commissionerMembership,
    IDS.league,
    IDS.commissionerUser,
    "commissioner"
  );
  insertMembership.run(
    IDS.otherMembership,
    IDS.league,
    IDS.otherUser,
    "member"
  );
  const insertTeam = database.prepare(`
    INSERT INTO teams (
      id,
      league_id,
      status
    ) VALUES (?, ?, 'active')
  `);
  insertTeam.run(IDS.teamOne, IDS.league);
  insertTeam.run(IDS.teamTwo, IDS.league);
  database
    .prepare(`
      INSERT INTO entry_drafts (
        id,
        league_id,
        season_id,
        status,
        rounds,
        pick_clock_seconds,
        starts_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?, ?, ?, 'lottery_ready',
        4, 300, NULL, ?, 4
      )
    `)
    .run(
      IDS.draft,
      IDS.league,
      IDS.targetSeason,
      NOW_MS - DAY_MS
    );
  database
    .prepare(`
      INSERT INTO standings_snapshots (
        id,
        league_id,
        season_id,
        snapshot_version,
        status
      ) VALUES (?, ?, ?, 1, 'final')
    `)
    .run(
      IDS.standingsSnapshot,
      IDS.league,
      IDS.sourceSeason
    );
  database
    .prepare(`
      INSERT INTO standings_snapshot_finalizations (
        id,
        league_id,
        season_id,
        standings_snapshot_id,
        status,
        finalized_at_ms,
        expected_matchup_count,
        finalized_matchup_count,
        participant_count,
        result_set_hash,
        standings_rule_version,
        season_version_after
      ) VALUES (
        ?, ?, ?, ?, 'final', ?,
        72, 72, 2, ?, 1, 11
      )
    `)
    .run(
      IDS.finalization,
      IDS.league,
      IDS.sourceSeason,
      IDS.standingsSnapshot,
      SOURCE_ENDS_AT_MS + DAY_MS,
      "a".repeat(64)
    );
  database
    .prepare(`
      INSERT INTO matchup_operations (
        id,
        league_id,
        season_id,
        operation_type,
        status,
        completed_at_ms
      ) VALUES (
        ?, ?, ?, 'schedule_generate',
        'succeeded', ?
      )
    `)
    .run(
      IDS.targetSchedule,
      IDS.league,
      IDS.targetSeason,
      NOW_MS - DAY_MS
    );
  database
    .prepare(`
      INSERT INTO matchup_weeks (
        id,
        league_id,
        season_id,
        sequence,
        starts_at_ms
      ) VALUES (?, ?, ?, 1, ?)
    `)
    .run(
      IDS.weekOne,
      IDS.league,
      IDS.targetSeason,
      TARGET_STARTS_AT_MS
    );
  database
    .prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id,
        season_id,
        schedule_version,
        schedule_operation_id,
        week_one_matchup_week_id,
        week_one_starts_at_ms,
        status
      ) VALUES (?, ?, 5, ?, ?, ?, 'current')
    `)
    .run(
      IDS.league,
      IDS.targetSeason,
      IDS.targetSchedule,
      IDS.weekOne,
      TARGET_STARTS_AT_MS
    );
  database
    .prepare(`
      INSERT INTO draft_lottery_runs (
        id,
        league_id,
        season_id,
        draft_id,
        participant_count,
        status
      ) VALUES (?, ?, ?, ?, 2, 'committed')
    `)
    .run(
      IDS.lottery,
      IDS.league,
      IDS.targetSeason,
      IDS.draft
    );
  const insertLotteryResult =
    database.prepare(`
      INSERT INTO draft_lottery_results (
        id,
        league_id,
        lottery_run_id,
        original_team_id,
        final_draft_position
      ) VALUES (?, ?, ?, ?, ?)
    `);
  insertLotteryResult.run(
    uuid(18),
    IDS.league,
    IDS.lottery,
    IDS.teamOne,
    1
  );
  insertLotteryResult.run(
    uuid(19),
    IDS.league,
    IDS.lottery,
    IDS.teamTwo,
    2
  );
  database
    .prepare(`
      INSERT INTO draft_eligibility_snapshots (
        id,
        league_id,
        draft_id,
        status
      ) VALUES (?, ?, ?, 'confirmed')
    `)
    .run(
      IDS.eligibility,
      IDS.league,
      IDS.draft
    );
  database
    .prepare(`
      INSERT INTO draft_eligible_players (
        id,
        league_id,
        eligibility_snapshot_id
      ) VALUES (?, ?, ?)
    `)
    .run(
      IDS.eligiblePlayer,
      IDS.league,
      IDS.eligibility
    );
  const insertPick = database.prepare(`
    INSERT INTO draft_picks (
      id,
      league_id,
      draft_id,
      target_season_id,
      round_number,
      position_number,
      original_team_id,
      current_owner_team_id,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unused')
  `);
  let pickId = 20;
  for (let round = 1; round <= 4; round += 1) {
    insertPick.run(
      uuid(pickId),
      IDS.league,
      IDS.draft,
      IDS.targetSeason,
      round,
      1,
      IDS.teamOne,
      IDS.teamOne
    );
    pickId += 1;
    insertPick.run(
      uuid(pickId),
      IDS.league,
      IDS.draft,
      IDS.targetSeason,
      round,
      2,
      IDS.teamTwo,
      IDS.teamTwo
    );
    pickId += 1;
  }
}

function runtime(t, { beforeCommit } = {}) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-entry-draft-schedule-repository-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(
      root,
      "test.sqlite3"
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
  createSchema(connection.database);
  seed(connection.database);
  return {
    database: connection.database,
    repository:
      createSqliteEntryDraftScheduleRepository({
        database: connection.database,
        beforeCommit,
      }),
  };
}

function insertFullRecord(
  database,
  tableName,
  record
) {
  const columns = Object.keys(record);
  const placeholders = columns.map(
    (column) => `@${column}`
  );
  database
    .prepare(
      `INSERT INTO ${tableName} (` +
        `${columns.join(", ")}) VALUES (` +
        `${placeholders.join(", ")})`
    )
    .run(record);
}

function seedFullSchemaSource(database) {
  for (const [
    id,
    email,
    displayName,
  ] of [
    [
      IDS.commissionerUser,
      "commissioner@example.test",
      "Commissioner",
    ],
    [
      IDS.otherUser,
      "member@example.test",
      "Member",
    ],
  ]) {
    insertFullRecord(database, "users", {
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
  insertFullRecord(database, "leagues", {
    id: IDS.league,
    name: "Full Schema Schedule League",
    name_normalized:
      "full schema schedule league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insertFullRecord(
    database,
    "league_settings",
    {
      league_id: IDS.league,
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
    }
  );
  insertFullRecord(database, "seasons", {
    id: IDS.sourceSeason,
    league_id: IDS.league,
    label: "2025-26",
    nhl_season_key: "20252026",
    status: "active",
    regular_season_starts_at_ms:
      SOURCE_WEEK_STARTS_AT_MS -
      2 * DAY_MS,
    regular_season_ends_at_ms:
      SOURCE_ENDS_AT_MS,
    fantasy_playoffs_start_at_ms:
      SOURCE_ENDS_AT_MS,
    fantasy_playoffs_end_at_ms:
      SOURCE_ENDS_AT_MS + 14 * DAY_MS,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insertFullRecord(database, "seasons", {
    id: IDS.targetSeason,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "planned",
    regular_season_starts_at_ms:
      TARGET_STARTS_AT_MS,
    regular_season_ends_at_ms:
      TARGET_ENDS_AT_MS,
    fantasy_playoffs_start_at_ms:
      TARGET_PLAYOFFS_AT_MS,
    fantasy_playoffs_end_at_ms:
      TARGET_ENDS_AT_MS,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 3,
  });
  for (const membership of [
    {
      id: IDS.commissionerMembership,
      userId: IDS.commissionerUser,
      permissionCategory: "commissioner",
    },
    {
      id: IDS.otherMembership,
      userId: IDS.otherUser,
      permissionCategory: "member",
    },
  ]) {
    insertFullRecord(
      database,
      "league_memberships",
      {
        id: membership.id,
        league_id: IDS.league,
        user_id: membership.userId,
        permission_category:
          membership.permissionCategory,
        status: "active",
        joined_at_ms: 1,
        ended_at_ms: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      }
    );
  }
  database
    .prepare(`
      UPDATE leagues
      SET commissioner_membership_id = ?,
        current_season_id = ?,
        updated_at_ms = ?,
        version = version + 1
      WHERE id = ?
    `)
    .run(
      IDS.commissionerMembership,
      IDS.sourceSeason,
      1,
      IDS.league
    );
  for (const [
    id,
    name,
    primaryColour,
    secondaryColour,
  ] of [
    [
      IDS.teamOne,
      "Alpha",
      "#112233",
      "#abcdef",
    ],
    [
      IDS.teamTwo,
      "Bravo",
      "#445566",
      "#fedcba",
    ],
  ]) {
    insertFullRecord(database, "teams", {
      id,
      league_id: IDS.league,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      primary_colour: primaryColour,
      secondary_colour: secondaryColour,
      logo_reference: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
      tertiary_colour: null,
      pattern_template: "even-two",
    });
  }
  insertFullRecord(
    database,
    "matchup_weeks",
    {
      id: FULL_IDS.sourceWeek,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      week_key: "regular-01",
      sequence: 1,
      starts_at_ms:
        SOURCE_WEEK_STARTS_AT_MS,
      baseline_at_ms:
        SOURCE_WEEK_STARTS_AT_MS +
        60 * 60 * 1000,
      locks_at_ms:
        SOURCE_WEEK_STARTS_AT_MS +
        16 * 60 * 60 * 1000,
      ends_at_ms: SOURCE_ENDS_AT_MS,
      rolls_over_at_ms:
        SOURCE_ENDS_AT_MS,
      status: "final",
      created_at_ms: 1,
      updated_at_ms:
        SOURCE_ENDS_AT_MS,
      version: 1,
    }
  );
  insertFullRecord(database, "matchups", {
    id: FULL_IDS.sourceMatchup,
    league_id: IDS.league,
    season_id: IDS.sourceSeason,
    matchup_week_id: FULL_IDS.sourceWeek,
    home_team_id: IDS.teamOne,
    away_team_id: IDS.teamTwo,
    home_team_name: "Alpha",
    away_team_name: "Bravo",
    status: "final",
    created_at_ms: 1,
    updated_at_ms: SOURCE_ENDS_AT_MS,
    version: 1,
  });
  insertFullRecord(
    database,
    "matchup_operations",
    {
      id: FULL_IDS.sourceScheduleOperation,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      matchup_week_id: null,
      matchup_id: null,
      actor_user_id:
        IDS.commissionerUser,
      operation_type: "schedule_generate",
      status: "succeeded",
      reason: null,
      metadata_json: JSON.stringify({
        participantCount: 2,
        participantTeamIds: [
          IDS.teamOne,
          IDS.teamTwo,
        ].sort(),
        weekCount: 1,
        matchupCount: 1,
        jobOccurrenceCount: 0,
      }),
      started_at_ms: 1,
      completed_at_ms: 1,
    }
  );
  insertFullRecord(
    database,
    "season_matchup_schedule_generations",
    {
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      schedule_version: 1,
      schedule_operation_id:
        FULL_IDS.sourceScheduleOperation,
      week_one_matchup_week_id:
        FULL_IDS.sourceWeek,
      week_one_starts_at_ms:
        SOURCE_WEEK_STARTS_AT_MS,
      status: "current",
      created_at_ms: 1,
      superseded_at_ms: null,
      version: 1,
    }
  );
  insertFullRecord(database, "stat_sources", {
    id: FULL_IDS.statSource,
    provider: "nhl",
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insertFullRecord(database, "stat_refreshes", {
    id: FULL_IDS.statRefresh,
    stat_source_id: FULL_IDS.statSource,
    nhl_season_key: "20252026",
    source_version: "final",
    status: "succeeded",
    started_at_ms:
      SOURCE_ENDS_AT_MS - 10_000,
    completed_at_ms:
      SOURCE_ENDS_AT_MS,
    player_count: 0,
    error_code: null,
    metadata_json: null,
    version: 1,
  });
  insertFullRecord(database, "stat_snapshots", {
    id: FULL_IDS.statSnapshot,
    stat_source_id: FULL_IDS.statSource,
    source_refresh_id: FULL_IDS.statRefresh,
    league_id: IDS.league,
    season_id: IDS.sourceSeason,
    matchup_week_id: FULL_IDS.sourceWeek,
    intended_use: "matchup_final",
    completeness_status: "complete",
    freshness_status: "fresh",
    captured_at_ms: SOURCE_ENDS_AT_MS,
    committed: 1,
    created_at_ms: SOURCE_ENDS_AT_MS,
  });
  insertFullRecord(
    database,
    "matchup_results",
    {
      id: FULL_IDS.matchupResult,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      matchup_id: FULL_IDS.sourceMatchup,
      current_version_id: null,
      status: "pending",
      finalized_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    }
  );
  insertFullRecord(
    database,
    "matchup_result_versions",
    {
      id: FULL_IDS.resultVersion,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      matchup_result_id:
        FULL_IDS.matchupResult,
      version_number: 1,
      home_team_id: IDS.teamOne,
      away_team_id: IDS.teamTwo,
      home_score_hundredths: 500,
      away_score_hundredths: 300,
      outcome: "home_win",
      source_snapshot_id:
        FULL_IDS.statSnapshot,
      source_type: "calculated",
      actor_user_id: null,
      reason: null,
      supersedes_version_id: null,
      created_at_ms: SOURCE_ENDS_AT_MS,
    }
  );
  database
    .prepare(`
      UPDATE matchup_results
      SET current_version_id = ?,
        status = 'official',
        finalized_at_ms = ?,
        updated_at_ms = ?
      WHERE id = ?
    `)
    .run(
      FULL_IDS.resultVersion,
      SOURCE_ENDS_AT_MS,
      SOURCE_ENDS_AT_MS,
      FULL_IDS.matchupResult
    );
  insertFullRecord(
    database,
    "standings_snapshots",
    {
      id:
        FULL_IDS.currentStandingsSnapshot,
      league_id: IDS.league,
      season_id: IDS.sourceSeason,
      snapshot_version: 1,
      source_result_version: 1,
      status: "current",
      calculated_at_ms:
        SOURCE_ENDS_AT_MS,
      created_at_ms: SOURCE_ENDS_AT_MS,
    }
  );
}

function fullSchemaResultSetHash() {
  return calculateStandingsResultSetHash({
    leagueId: IDS.league,
    seasonId: IDS.sourceSeason,
    standingsRuleVersion: "1",
    results: [
      {
        matchupId:
          FULL_IDS.sourceMatchup,
        matchupResultId:
          FULL_IDS.matchupResult,
        resultVersionId:
          FULL_IDS.resultVersion,
        resultVersion: 1,
      },
    ],
  });
}

function commitFullSchemaSourceFinalization(
  database
) {
  const repository =
    createSqliteMatchupStandingsFinalizationRepository({
      database,
    });
  const context =
    repository.readFinalizationContext({
      leagueId: IDS.league,
      seasonId: IDS.sourceSeason,
    });
  const rows = calculateStandings({
    participants: [
      {
        team_id: IDS.teamOne,
        team_display_name: "Alpha",
      },
      {
        team_id: IDS.teamTwo,
        team_display_name: "Bravo",
      },
    ],
    results: [
      {
        home_team_id: IDS.teamOne,
        away_team_id: IDS.teamTwo,
        home_score_hundredths: 500,
        away_score_hundredths: 300,
      },
    ],
  });
  const rowsByTeam = new Map(
    rows.map((row) => [
      row.teamId,
      row,
    ])
  );
  const finalizationTransaction =
    database.transaction(() => {
      repository.insertStartedIdempotency({
        id:
          FULL_IDS.finalizationIdempotency,
        leagueId: IDS.league,
        actorUserId:
          IDS.commissionerUser,
        operation:
          STANDINGS_FINALIZATION_OPERATION,
        clientKey:
          "full-schema-finalization",
        requestHash: "a".repeat(64),
        createdAtMs:
          SOURCE_FINALIZED_AT_MS,
        expiresAtMs:
          SOURCE_FINALIZED_AT_MS +
          DAY_MS,
      });
      repository
        .supersedeCurrentDerivedSnapshot({
          leagueId: IDS.league,
          seasonId: IDS.sourceSeason,
          snapshotId:
            FULL_IDS
              .currentStandingsSnapshot,
        });
      repository.insertFinalSnapshot({
        id: IDS.standingsSnapshot,
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        snapshotVersion: 2,
        sourceResultVersion: 1,
        nowMs: SOURCE_FINALIZED_AT_MS,
      });
      repository.insertStandingsRows({
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        snapshotId:
          IDS.standingsSnapshot,
        rows: [
          {
            id:
              FULL_IDS
                .finalStandingsRowOne,
            ...rowsByTeam.get(
              IDS.teamOne
            ),
          },
          {
            id:
              FULL_IDS
                .finalStandingsRowTwo,
            ...rowsByTeam.get(
              IDS.teamTwo
            ),
          },
        ].map((row) => ({
          id: row.id,
          teamId: row.teamId,
          rank: row.rank,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          standingsPoints:
            row.standingsPoints,
          fantasyPointsForHundredths:
            row
              .fantasyPointsForHundredths,
          fantasyPointsAgainstHundredths:
            row
              .fantasyPointsAgainstHundredths,
          fantasyPointsDifferentialHundredths:
            row
              .fantasyPointsDifferentialHundredths,
        })),
      });
      repository.insertResultVersionLinks({
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        snapshotId:
          IDS.standingsSnapshot,
        links: [
          {
            id:
              FULL_IDS.finalResultLink,
            matchupWeekId:
              FULL_IDS.sourceWeek,
            matchupId:
              FULL_IDS.sourceMatchup,
            matchupResultId:
              FULL_IDS.matchupResult,
            resultVersionId:
              FULL_IDS.resultVersion,
            resultVersionNumber: 1,
          },
        ],
        nowMs: SOURCE_FINALIZED_AT_MS,
      });
      repository.insertTeamIdentities({
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        snapshotId:
          IDS.standingsSnapshot,
        identities:
          context.participants.map(
            (participant) => ({
              id:
                participant.team_id ===
                IDS.teamOne
                  ? FULL_IDS
                      .finalTeamIdentityOne
                  : FULL_IDS
                      .finalTeamIdentityTwo,
              teamId:
                participant.team_id,
              teamDisplayName:
                participant
                  .team_display_name,
              primaryColour:
                participant
                  .primary_colour,
              secondaryColour:
                participant
                  .secondary_colour,
              tertiaryColour:
                participant
                  .tertiary_colour,
              patternTemplate:
                participant
                  .pattern_template,
              sourceLogoObjectId:
                participant
                  .source_logo_object_id,
              logoMediaType:
                participant
                  .logo_media_type,
              logoByteLength:
                participant
                  .logo_byte_length,
              logoWidth:
                participant.logo_width,
              logoHeight:
                participant.logo_height,
              logoContentSha256:
                participant
                  .logo_content_sha256,
              logoContentBytes:
                participant
                  .logo_content_bytes,
            })
          ),
        nowMs: SOURCE_FINALIZED_AT_MS,
      });
      repository.insertSucceededOperation({
        id:
          FULL_IDS.finalStandingsOperation,
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        snapshotId:
          IDS.standingsSnapshot,
        actorUserId:
          IDS.commissionerUser,
        actorMembershipId:
          IDS.commissionerMembership,
        actorAuthority: "commissioner",
        idempotencyRequestId:
          FULL_IDS
            .finalizationIdempotency,
        metadataJson: JSON.stringify({
          resultSetHash:
            fullSchemaResultSetHash(),
          standingsRuleVersion: 1,
        }),
        nowMs: SOURCE_FINALIZED_AT_MS,
      });
      repository.insertFinalizationEvidence({
        id: IDS.finalization,
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        snapshotId:
          IDS.standingsSnapshot,
        finalizationVersion: 2,
        standingsRuleVersion: 1,
        resultSetHash:
          fullSchemaResultSetHash(),
        expectedMatchupCount: 1,
        expectedWeekCount: 1,
        participantCount: 2,
        seasonVersionBefore: 1,
        actorUserId:
          IDS.commissionerUser,
        actorMembershipId:
          IDS.commissionerMembership,
        actorAuthority: "commissioner",
        operationId:
          FULL_IDS.finalStandingsOperation,
        idempotencyRequestId:
          FULL_IDS
            .finalizationIdempotency,
        nowMs: SOURCE_FINALIZED_AT_MS,
      });
      const notificationIds = new Map([
        [
          IDS.commissionerUser,
          FULL_IDS
            .finalizationNotificationOne,
        ],
        [
          IDS.otherUser,
          FULL_IDS
            .finalizationNotificationTwo,
        ],
      ]);
      for (const userId of
        context.activeMemberUserIds) {
        repository.writeFinalizedNotification({
          id: notificationIds.get(userId),
          leagueId: IDS.league,
          seasonId: IDS.sourceSeason,
          finalizationId:
            IDS.finalization,
          snapshotId:
            IDS.standingsSnapshot,
          userId,
          nowMs:
            SOURCE_FINALIZED_AT_MS,
        });
      }
      repository.writeFinalizedOutbox({
        id: FULL_IDS.finalizationOutbox,
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        snapshotId:
          IDS.standingsSnapshot,
        seasonVersion: 2,
        nowMs: SOURCE_FINALIZED_AT_MS,
      });
      repository.advanceSeasonVersion({
        leagueId: IDS.league,
        seasonId: IDS.sourceSeason,
        expectedVersion: 1,
        nowMs: SOURCE_FINALIZED_AT_MS,
      });
      repository.completeIdempotency({
        id:
          FULL_IDS.finalizationIdempotency,
        leagueId: IDS.league,
        finalizationId:
          IDS.finalization,
        completedAtMs:
          SOURCE_FINALIZED_AT_MS,
      });
    });
  finalizationTransaction.immediate();
}

function seedFullSchemaTarget(database) {
  const targetScheduleCreatedAtMs =
    NOW_MS - DAY_MS;
  insertFullRecord(
    database,
    "matchup_operations",
    {
      id: IDS.targetSchedule,
      league_id: IDS.league,
      season_id: IDS.targetSeason,
      matchup_week_id: null,
      matchup_id: null,
      actor_user_id:
        IDS.commissionerUser,
      operation_type: "schedule_generate",
      status: "succeeded",
      reason: null,
      metadata_json: JSON.stringify({
        participantCount: 2,
        participantTeamIds: [
          IDS.teamOne,
          IDS.teamTwo,
        ].sort(),
        weekCount: 1,
        matchupCount: 0,
        jobOccurrenceCount: 0,
      }),
      started_at_ms:
        targetScheduleCreatedAtMs,
      completed_at_ms:
        targetScheduleCreatedAtMs,
    }
  );
  insertFullRecord(
    database,
    "matchup_weeks",
    {
      id: IDS.weekOne,
      league_id: IDS.league,
      season_id: IDS.targetSeason,
      week_key: "regular-01",
      sequence: 1,
      starts_at_ms:
        TARGET_STARTS_AT_MS,
      baseline_at_ms:
        TARGET_STARTS_AT_MS +
        60 * 60 * 1000,
      locks_at_ms:
        TARGET_STARTS_AT_MS +
        16 * 60 * 60 * 1000,
      ends_at_ms:
        TARGET_STARTS_AT_MS +
        7 * DAY_MS,
      rolls_over_at_ms:
        TARGET_STARTS_AT_MS +
        7 * DAY_MS,
      status: "scheduled",
      created_at_ms:
        targetScheduleCreatedAtMs,
      updated_at_ms:
        targetScheduleCreatedAtMs,
      version: 1,
    }
  );
  insertFullRecord(
    database,
    "season_matchup_schedule_generations",
    {
      league_id: IDS.league,
      season_id: IDS.targetSeason,
      schedule_version: 1,
      schedule_operation_id:
        IDS.targetSchedule,
      week_one_matchup_week_id:
        IDS.weekOne,
      week_one_starts_at_ms:
        TARGET_STARTS_AT_MS,
      status: "current",
      created_at_ms:
        targetScheduleCreatedAtMs,
      superseded_at_ms: null,
      version: 1,
    }
  );
  insertFullRecord(database, "entry_drafts", {
    id: IDS.draft,
    league_id: IDS.league,
    season_id: IDS.targetSeason,
    status: "lottery_ready",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: null,
    completed_at_ms: null,
    created_by_user_id:
      IDS.commissionerUser,
    created_at_ms: NOW_MS - DAY_MS,
    updated_at_ms: NOW_MS - DAY_MS,
    version: 4,
  });
  insertFullRecord(
    database,
    "draft_lottery_runs",
    {
      id: IDS.lottery,
      league_id: IDS.league,
      season_id: IDS.targetSeason,
      draft_id: IDS.draft,
      standings_snapshot_id:
        IDS.standingsSnapshot,
      algorithm_version: 1,
      participant_count: 2,
      confirmed_by_user_id:
        IDS.commissionerUser,
      random_audit_json: "{}",
      status: "committed",
      committed_at_ms:
        NOW_MS - DAY_MS,
    }
  );
  for (const lotteryResult of [
    {
      id: FULL_IDS.lotteryResultOne,
      teamId: IDS.teamOne,
      position: 1,
    },
    {
      id: FULL_IDS.lotteryResultTwo,
      teamId: IDS.teamTwo,
      position: 2,
    },
  ]) {
    insertFullRecord(
      database,
      "draft_lottery_results",
      {
        id: lotteryResult.id,
        league_id: IDS.league,
        lottery_run_id: IDS.lottery,
        original_team_id:
          lotteryResult.teamId,
        current_pick_owner_team_id:
          lotteryResult.teamId,
        reverse_standings_position:
          lotteryResult.position,
        weight: 1,
        draw_order: null,
        final_draft_position:
          lotteryResult.position,
        finalist_role: null,
        created_at_ms: NOW_MS - DAY_MS,
      }
    );
  }
  insertFullRecord(database, "players", {
    id: FULL_IDS.player,
    first_name: "Eligible",
    last_name: "Player",
    full_name: "Eligible Player",
    birth_date: "2008-01-01",
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insertFullRecord(
    database,
    "draft_eligibility_snapshots",
    {
      id: IDS.eligibility,
      league_id: IDS.league,
      draft_id: IDS.draft,
      nhl_entry_draft_key: "2026",
      source_version: "full-schema",
      snapshot_version: 1,
      status: "confirmed",
      confirmed_by_user_id:
        IDS.commissionerUser,
      confirmed_at_ms: NOW_MS - DAY_MS,
      created_at_ms: NOW_MS - DAY_MS,
    }
  );
  insertFullRecord(
    database,
    "draft_eligible_players",
    {
      id: FULL_IDS.eligiblePlayerRow,
      league_id: IDS.league,
      eligibility_snapshot_id:
        IDS.eligibility,
      player_id: FULL_IDS.player,
      position_group: "F",
      eligibility_reason:
        "nhl_entry_draft",
      nhl_draft_year: 2026,
      nhl_round: 1,
      nhl_overall_selection: 1,
      rights_release_event_id: null,
      created_at_ms: NOW_MS - DAY_MS,
    }
  );
  let pickId = 730;
  for (
    let round = 1;
    round <= 4;
    round += 1
  ) {
    for (const [
      position,
      teamId,
    ] of [
      [1, IDS.teamOne],
      [2, IDS.teamTwo],
    ]) {
      insertFullRecord(
        database,
        "draft_picks",
        {
          id: uuid(pickId),
          league_id: IDS.league,
          draft_id: IDS.draft,
          target_season_id:
            IDS.targetSeason,
          round_number: round,
          position_number: position,
          original_team_id: teamId,
          current_owner_team_id: teamId,
          status: "unused",
          selection_id: null,
          created_at_ms: NOW_MS - DAY_MS,
          updated_at_ms: NOW_MS - DAY_MS,
          version: 1,
        }
      );
      pickId += 1;
    }
  }
}

function fullSchemaRuntime(t) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-entry-draft-schedule-full-schema-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(
      root,
      "full-schema.sqlite3"
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
    migrationsDirectory:
      MIGRATIONS_DIRECTORY,
    applicationBuildId:
      "entry-draft-schedule-full-schema-test",
    now: () => 1,
  });
  seedFullSchemaSource(connection.database);
  commitFullSchemaSourceFinalization(
    connection.database
  );
  seedFullSchemaTarget(connection.database);

  const repository =
    createSqliteEntryDraftScheduleRepository({
      database: connection.database,
    });
  let nowMs = NOW_MS;
  let nextId = 800;
  const service =
    createEntryDraftScheduleService({
      repositoryContext: Object.freeze({
        transaction(callback) {
          return connection.database
            .transaction(callback)
            .immediate();
        },
      }),
      leagueAuthorization: Object.freeze({
        requireCommissioner(
          _authenticated,
          leagueId
        ) {
          assert.equal(
            leagueId,
            IDS.league
          );
          return Object.freeze({
            actorUserId:
              IDS.commissionerUser,
            authority: "commissioner",
            leagueId: IDS.league,
            membershipId:
              IDS.commissionerMembership,
          });
        },
      }),
      entryDraftScheduleRepository:
        repository,
      clock: Object.freeze({
        nowMs() {
          return nowMs;
        },
      }),
      secureRandom: Object.freeze({
        id() {
          nextId += 1;
          return uuid(nextId);
        },
      }),
    });
  return {
    database: connection.database,
    repository,
    service,
    setNowMs(value) {
      nowMs = value;
    },
  };
}

function planFor(
  repository,
  {
    action,
    sequence,
    nowMs,
    scheduledStartsAtMs,
  }
) {
  const context = repository.readScheduleContext({
    leagueId: IDS.league,
    entryDraftId: IDS.draft,
  });
  const base = 100 + sequence * 20;
  const operationId = uuid(base);
  const rolloverBindingId =
    context.scheduledBinding?.id ||
    uuid(base + 1);
  const rolloverOccurrenceId =
    uuid(base + 2);
  const jobRunId = uuid(base + 3);
  const occurrenceKey =
    buildSeasonRolloverOccurrenceKey({
      leagueId: IDS.league,
      entryDraftId: IDS.draft,
      rolloverOccurrenceId,
      scheduledForMs: scheduledStartsAtMs,
    });
  const notificationIds =
    context.notificationRecipientUserIds.map(
      (userId, index) =>
        Object.freeze({
          id: uuid(base + 7 + index),
          userId,
        })
    );
  const result = Object.freeze({
    operationId,
    entryDraftId: IDS.draft,
    entryDraftVersion:
      context.entryDraftVersion + 1,
    rolloverBindingId,
    rolloverBindingVersion:
      (context.scheduledBinding?.version ||
        0) + 1,
    rolloverOccurrenceId,
    scheduledStartsAtMs,
    jobRunId,
    action,
  });
  return Object.freeze({
    action,
    actor: Object.freeze({
      actorUserId: IDS.commissionerUser,
      authority: "commissioner",
      leagueId: IDS.league,
      membershipId:
        IDS.commissionerMembership,
    }),
    auditContext: Object.freeze({
      requestCorrelationId: uuid(base + 10),
      networkKeyVersion: 1,
      networkMetadataDigest: "b".repeat(64),
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "unknown",
      }),
    }),
    entryDraft: Object.freeze({
      id: IDS.draft,
      status: context.entryDraftStatus,
      expectedVersion:
        context.entryDraftVersion,
    }),
    idempotency: Object.freeze({
      clientKey:
        `entry-draft-schedule-${sequence}`,
      expiresAtMs: nowMs + DAY_MS,
      operation:
        ENTRY_DRAFT_SCHEDULE_OPERATION,
      operationId,
      requestHash: String(sequence).repeat(
        64
      ).slice(0, 64),
      resultType: "entry_draft_schedule",
    }),
    ids: Object.freeze({
      auditEventId: uuid(base + 4),
      draftEventId: uuid(base + 5),
      jobRunId,
      notificationIds:
        Object.freeze(notificationIds),
      outboxEventId: uuid(base + 6),
      rolloverBindingId,
      rolloverOccurrenceId,
    }),
    job: Object.freeze({
      jobType:
        ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
      occurrenceKey,
      scheduledForMs: scheduledStartsAtMs,
    }),
    leagueId: IDS.league,
    nowMs,
    reason:
      action ===
      ENTRY_DRAFT_RESCHEDULE_ACTION
        ? "Move for league timing"
        : null,
    replacement: context.scheduledBinding,
    result,
    serverBinding: Object.freeze({
      sourceSeason: context.sourceSeason,
      targetSeason: context.targetSeason,
      targetSchedule: context.targetSchedule,
    }),
  });
}

function count(database, tableName) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName}`
    )
    .get().count;
}

describe(
  "SQLite Entry Draft schedule repository foundation",
  () => {
    test(
      "reads strict context and atomically schedules, reschedules, and replays immutable results",
      (t) => {
        const { database, repository } =
          runtime(t);
        const context =
          repository.readScheduleContext({
            leagueId: IDS.league,
            entryDraftId: IDS.draft,
          });
        assert.equal(
          Object.isFrozen(context),
          true
        );
        assert.equal(
          Object.isFrozen(
            context.sourceSeason
              .completionEvidence
          ),
          true
        );
        assert.deepEqual(context.readiness, {
          setupConfirmed: true,
          orderConfirmed: true,
          eligibilityConfirmed: true,
          pickOwnersConfirmed: true,
        });
        assert.equal(
          context.sourceSeason
            .completionEvidence
            .competitionCompletedAtMs,
          SOURCE_ENDS_AT_MS
        );
        assert.equal(
          context.targetSchedule
            .weekOneStartsAtMs,
          TARGET_STARTS_AT_MS
        );
        assert.deepEqual(
          context.notificationRecipientUserIds,
          [
            IDS.commissionerUser,
            IDS.otherUser,
          ]
        );
        assert.equal(
          context.scheduledBinding,
          null
        );

        const initialPlan = planFor(
          repository,
          {
            action:
              ENTRY_DRAFT_SCHEDULE_ACTION,
            sequence: 1,
            nowMs: NOW_MS,
            scheduledStartsAtMs:
              INITIAL_STARTS_AT_MS,
          }
        );
        assert.deepEqual(
          repository.applySchedulePlan(
            initialPlan
          ),
          { applied: true }
        );
        const initialResult =
          repository.findScheduleResult({
            leagueId: IDS.league,
            operationId:
              initialPlan.result.operationId,
          });
        assert.equal(
          Object.isFrozen(initialResult),
          true
        );
        assert.deepEqual(
          initialResult,
          initialPlan.result
        );
        assert.deepEqual(
          repository.findIdempotency({
            leagueId: IDS.league,
            actorUserId:
              IDS.commissionerUser,
            operation:
              ENTRY_DRAFT_SCHEDULE_OPERATION,
            clientKey:
              initialPlan.idempotency
                .clientKey,
          }),
          {
            leagueId: IDS.league,
            actorUserId:
              IDS.commissionerUser,
            operation:
              ENTRY_DRAFT_SCHEDULE_OPERATION,
            clientKey:
              initialPlan.idempotency
                .clientKey,
            requestHash:
              initialPlan.idempotency
                .requestHash,
            status: "completed",
            resultType:
              "entry_draft_schedule",
            resultId:
              initialPlan.result.operationId,
            completedAtMs: NOW_MS,
          }
        );
        assert.deepEqual(
          database
            .prepare(`
              SELECT
                status,
                starts_at_ms,
                version
              FROM entry_drafts
              WHERE id = ?
            `)
            .get(IDS.draft),
          {
            status: "ready",
            starts_at_ms:
              INITIAL_STARTS_AT_MS,
            version: 5,
          }
        );
        const initialBinding = database
          .prepare(`
            SELECT *
            FROM entry_draft_rollover_bindings
            WHERE id = ?
          `)
          .get(
            initialPlan.result
              .rolloverBindingId
          );
        assert.equal(
          initialBinding
            .current_schedule_operation_id,
          initialPlan.result.operationId
        );
        assert.equal(
          initialBinding
            .week_one_matchup_week_id,
          IDS.weekOne
        );
        assert.equal(
          initialBinding
            .week_one_starts_at_ms,
          TARGET_STARTS_AT_MS
        );
        assert.equal(
          initialBinding
            .scheduled_by_authority,
          "commissioner"
        );
        assert.equal(
          count(database, "draft_events"),
          1
        );
        assert.equal(
          count(
            database,
            "security_audit_events"
          ),
          1
        );
        assert.equal(
          count(database, "notifications"),
          2
        );
        assert.equal(
          count(database, "outbox_events"),
          1
        );
        assert.equal(
          count(
            database,
            "outbox_event_audiences"
          ),
          1
        );
        const draftMetadata = JSON.parse(
          database
            .prepare(
              "SELECT metadata_json " +
                "FROM draft_events"
            )
            .get().metadata_json
        );
        assert.equal(
          draftMetadata.actorAuthority,
          "commissioner"
        );
        assert.equal(
          draftMetadata.targetScheduleId,
          IDS.targetSchedule
        );
        assert.equal(
          draftMetadata.weekOneMatchupWeekId,
          IDS.weekOne
        );
        assert.deepEqual(
          database
            .prepare(`
              SELECT
                audience_kind,
                league_id,
                outbox_event_id
              FROM outbox_event_audiences
            `)
            .get(),
          {
            audience_kind: "league",
            league_id: IDS.league,
            outbox_event_id:
              initialPlan.ids.outboxEventId,
          }
        );

        const rescheduleNowMs =
          NOW_MS + 60 * 60 * 1000;
        const rescheduledStartsAtMs =
          INITIAL_STARTS_AT_MS + DAY_MS;
        const replacementBefore =
          repository.readScheduleContext({
            leagueId: IDS.league,
            entryDraftId: IDS.draft,
          }).scheduledBinding;
        const reschedulePlan = planFor(
          repository,
          {
            action:
              ENTRY_DRAFT_RESCHEDULE_ACTION,
            sequence: 2,
            nowMs: rescheduleNowMs,
            scheduledStartsAtMs:
              rescheduledStartsAtMs,
          }
        );
        repository.applySchedulePlan(
          reschedulePlan
        );

        const oldJob = database
          .prepare(
            "SELECT * FROM job_runs WHERE id = ?"
          )
          .get(replacementBefore.job.id);
        assert.equal(oldJob.status, "skipped");
        assert.equal(oldJob.version, 2);
        assert.equal(oldJob.attempt_count, 0);
        assert.equal(oldJob.lease_owner, null);
        assert.equal(oldJob.lease_token, null);
        assert.equal(
          oldJob.lease_expires_at_ms,
          null
        );
        assert.equal(oldJob.started_at_ms, null);
        assert.equal(
          oldJob.completed_at_ms,
          null
        );
        assert.equal(oldJob.result_json, null);
        assert.equal(
          oldJob.last_error_code,
          null
        );
        assert.equal(
          oldJob.next_attempt_at_ms,
          null
        );
        const oldOccurrence = database
          .prepare(`
            SELECT *
            FROM season_rollover_occurrences
            WHERE id = ?
          `)
          .get(
            replacementBefore.occurrenceId
          );
        assert.equal(
          oldOccurrence.status,
          "superseded"
        );
        assert.equal(
          oldOccurrence
            .superseded_by_occurrence_id,
          reschedulePlan.result
            .rolloverOccurrenceId
        );
        assert.equal(
          oldOccurrence.terminal_at_ms,
          rescheduleNowMs
        );
        assert.notEqual(
          replacementBefore.occurrenceId,
          reschedulePlan.result
            .rolloverOccurrenceId
        );
        assert.notEqual(
          replacementBefore.job.id,
          reschedulePlan.result.jobRunId
        );
        const current =
          repository.readScheduleContext({
            leagueId: IDS.league,
            entryDraftId: IDS.draft,
          });
        assert.equal(
          current.entryDraftVersion,
          6
        );
        assert.equal(
          current.scheduledBinding.version,
          2
        );
        assert.equal(
          current.scheduledBinding
            .occurrenceId,
          reschedulePlan.result
            .rolloverOccurrenceId
        );
        assert.equal(
          current.scheduledBinding
            .scheduledStartsAtMs,
          rescheduledStartsAtMs
        );
        const rescheduleOperation = database
          .prepare(`
            SELECT *
            FROM entry_draft_schedule_operations
            WHERE id = ?
          `)
          .get(
            reschedulePlan.result.operationId
          );
        assert.equal(
          rescheduleOperation.action,
          "reschedule"
        );
        assert.equal(
          rescheduleOperation.reason,
          "Move for league timing"
        );
        assert.equal(
          rescheduleOperation
            .superseded_rollover_occurrence_id,
          replacementBefore.occurrenceId
        );
        assert.equal(
          rescheduleOperation
            .superseded_job_run_id,
          replacementBefore.job.id
        );
        assert.equal(
          rescheduleOperation
            .superseded_job_version_before,
          1
        );
        assert.equal(
          rescheduleOperation
            .superseded_job_version_after,
          2
        );
        assert.equal(
          count(
            database,
            "entry_draft_schedule_operations"
          ),
          2
        );
        assert.deepEqual(
          repository.findScheduleResult({
            leagueId: IDS.league,
            operationId:
              initialPlan.result.operationId,
          }),
          initialResult
        );
      }
    );

    test(
      "a late injected failure rolls back every scheduling effect",
      (t) => {
        const { database, repository } =
          runtime(t, {
            beforeCommit() {
              throw new Error(
                "injected late failure"
              );
            },
          });
        const plan = planFor(repository, {
          action:
            ENTRY_DRAFT_SCHEDULE_ACTION,
          sequence: 3,
          nowMs: NOW_MS,
          scheduledStartsAtMs:
            INITIAL_STARTS_AT_MS,
        });
        assert.throws(
          () =>
            repository.applySchedulePlan(
              plan
            ),
          (error) => {
            assert.equal(
              error.code,
              "REPOSITORY_OPERATION_FAILED"
            );
            return true;
          }
        );
        assert.deepEqual(
          database
            .prepare(`
              SELECT
                status,
                starts_at_ms,
                version
              FROM entry_drafts
              WHERE id = ?
            `)
            .get(IDS.draft),
          {
            status: "lottery_ready",
            starts_at_ms: null,
            version: 4,
          }
        );
        for (const tableName of [
          "idempotency_requests",
          "job_runs",
          "entry_draft_rollover_bindings",
          "season_rollover_occurrences",
          "entry_draft_schedule_operations",
          "draft_events",
          "security_audit_events",
          "notifications",
          "outbox_events",
          "outbox_event_audiences",
        ]) {
          assert.equal(
            count(database, tableName),
            0,
            tableName
          );
        }
      }
    );

    test(
      "stale Entry Draft CAS rejects without partial evidence",
      (t) => {
        const { database, repository } =
          runtime(t);
        const plan = planFor(repository, {
          action:
            ENTRY_DRAFT_SCHEDULE_ACTION,
          sequence: 4,
          nowMs: NOW_MS,
          scheduledStartsAtMs:
            INITIAL_STARTS_AT_MS,
        });
        database
          .prepare(`
            UPDATE entry_drafts
            SET version = version + 1
            WHERE id = ?
          `)
          .run(IDS.draft);
        assert.throws(
          () =>
            repository.applySchedulePlan(
              plan
            ),
          (error) => {
            assert.equal(
              error.code,
              "REPOSITORY_VERSION_CONFLICT"
            );
            return true;
          }
        );
        assert.equal(
          count(
            database,
            "idempotency_requests"
          ),
          0
        );
        assert.equal(
          count(
            database,
            "entry_draft_schedule_operations"
          ),
          0
        );
      }
    );

    test(
      "rejects a pick set whose frozen original owner breaks the lottery order",
      (t) => {
        const { database, repository } =
          runtime(t);
        database
          .prepare(`
            UPDATE draft_picks
            SET original_team_id = ?
            WHERE draft_id = ?
              AND round_number = 1
              AND position_number = 1
          `)
          .run(IDS.teamTwo, IDS.draft);
        const context =
          repository.readScheduleContext({
            leagueId: IDS.league,
            entryDraftId: IDS.draft,
          });
        assert.equal(
          context.readiness.orderConfirmed,
          true
        );
        assert.equal(
          context.readiness
            .pickOwnersConfirmed,
          false
        );
      }
    );

    test(
      "rejects lottery evidence that omits or includes a non-current team",
      (t) => {
        const omitted = runtime(t);
        omitted.database
          .prepare(`
            INSERT INTO teams (
              id,
              league_id,
              status
            ) VALUES (?, ?, 'active')
          `)
          .run(uuid(900), IDS.league);
        assert.equal(
          omitted.repository
            .readScheduleContext({
              leagueId: IDS.league,
              entryDraftId: IDS.draft,
            })
            .readiness.orderConfirmed,
          false
        );

        const extra = runtime(t);
        extra.database
          .prepare(`
            UPDATE teams
            SET status = 'inactive'
            WHERE id = ?
          `)
          .run(IDS.teamTwo);
        assert.equal(
          extra.repository
            .readScheduleContext({
              leagueId: IDS.league,
              entryDraftId: IDS.draft,
            })
            .readiness.orderConfirmed,
          false
        );
      }
    );

    test(
      "lost commissioner authority rolls back before any scheduling evidence",
      (t) => {
        const { database, repository } =
          runtime(t);
        const plan = planFor(repository, {
          action:
            ENTRY_DRAFT_SCHEDULE_ACTION,
          sequence: 5,
          nowMs: NOW_MS,
          scheduledStartsAtMs:
            INITIAL_STARTS_AT_MS,
        });
        database
          .prepare(`
            UPDATE leagues
            SET commissioner_membership_id = ?
            WHERE id = ?
          `)
          .run(
            IDS.otherMembership,
            IDS.league
          );
        assert.throws(
          () =>
            repository.applySchedulePlan(
              plan
            ),
          (error) => {
            assert.equal(
              error.code,
              "REPOSITORY_VERSION_CONFLICT"
            );
            return true;
          }
        );
        assert.equal(
          count(
            database,
            "idempotency_requests"
          ),
          0
        );
        assert.equal(
          count(
            database,
            "entry_draft_schedule_operations"
          ),
          0
        );
      }
    );

    test(
      "schedules and reschedules through the real service and repository against the complete frozen schema",
      (t) => {
        const {
          database,
          repository,
          service,
          setNowMs,
        } = fullSchemaRuntime(t);
        assert.equal(
          database.pragma("user_version", {
            simple: true,
          }),
          49
        );
        assert.equal(
          database
            .prepare(`
              SELECT metadata_value
              FROM application_metadata
              WHERE metadata_key =
                'data_model_version'
            `)
            .get().metadata_value,
          "49"
        );
        assert.deepEqual(
          repository
            .readScheduleContext({
              leagueId: IDS.league,
              entryDraftId: IDS.draft,
            })
            .readiness,
          {
            setupConfirmed: true,
            orderConfirmed: true,
            eligibilityConfirmed: true,
            pickOwnersConfirmed: true,
          }
        );

        const initialCommand = {
          leagueId: IDS.league,
          entryDraftId: IDS.draft,
          input: {
            action:
              ENTRY_DRAFT_SCHEDULE_ACTION,
            scheduledStartsAtMs:
              INITIAL_STARTS_AT_MS,
            confirmation:
              ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
          },
          expectedEntryDraftVersion: 4,
          idempotencyKey:
            "full-schema-initial-schedule",
          authenticated: {
            valid: true,
          },
          auditContext: {
            requestCorrelationId:
              uuid(900),
            networkKeyVersion: 1,
            networkMetadataDigest:
              "c".repeat(64),
          },
        };
        const initial =
          service.schedule(initialCommand);
        assert.equal(
          initial.action,
          ENTRY_DRAFT_SCHEDULE_ACTION
        );
        assert.equal(
          initial.entryDraftVersion,
          5
        );
        assert.equal(
          initial.rolloverBindingVersion,
          1
        );
        assert.equal(initial.replayed, false);

        const replay =
          service.schedule(initialCommand);
        assert.equal(replay.replayed, true);
        assert.deepEqual(
          Object.fromEntries(
            Object.entries(replay)
          ),
          Object.fromEntries(
            Object.entries(initial)
          )
        );

        const initialDurable =
          repository.findScheduleResult({
            leagueId: IDS.league,
            operationId:
              initial.operationId,
          });
        const initialOccurrenceId =
          initial.rolloverOccurrenceId;
        const initialJobRunId =
          initial.jobRunId;

        const rescheduleNowMs =
          NOW_MS + 60 * 60 * 1000;
        const rescheduledStartsAtMs =
          INITIAL_STARTS_AT_MS + DAY_MS;
        setNowMs(rescheduleNowMs);
        const rescheduled =
          service.schedule({
            leagueId: IDS.league,
            entryDraftId: IDS.draft,
            input: {
              action:
                ENTRY_DRAFT_RESCHEDULE_ACTION,
              scheduledStartsAtMs:
                rescheduledStartsAtMs,
              confirmation:
                ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
              reason:
                "Move to the confirmed league date.",
            },
            expectedEntryDraftVersion:
              initial.entryDraftVersion,
            idempotencyKey:
              "full-schema-reschedule",
            authenticated: {
              valid: true,
            },
            auditContext: {
              requestCorrelationId:
                uuid(901),
              networkKeyVersion: 1,
              networkMetadataDigest:
                "d".repeat(64),
            },
          });
        assert.equal(
          rescheduled.action,
          ENTRY_DRAFT_RESCHEDULE_ACTION
        );
        assert.equal(
          rescheduled.entryDraftVersion,
          6
        );
        assert.equal(
          rescheduled.rolloverBindingVersion,
          2
        );
        assert.notEqual(
          rescheduled.rolloverOccurrenceId,
          initialOccurrenceId
        );
        assert.notEqual(
          rescheduled.jobRunId,
          initialJobRunId
        );
        assert.deepEqual(
          repository.findScheduleResult({
            leagueId: IDS.league,
            operationId:
              initial.operationId,
          }),
          initialDurable
        );

        assert.deepEqual(
          database
            .prepare(`
              SELECT
                status,
                attempt_count,
                lease_owner,
                lease_token,
                lease_expires_at_ms,
                started_at_ms,
                completed_at_ms,
                result_json,
                last_error_code,
                next_attempt_at_ms,
                version
              FROM job_runs
              WHERE id = ?
            `)
            .get(initialJobRunId),
          {
            status: "skipped",
            attempt_count: 0,
            lease_owner: null,
            lease_token: null,
            lease_expires_at_ms: null,
            started_at_ms: null,
            completed_at_ms: null,
            result_json: null,
            last_error_code: null,
            next_attempt_at_ms: null,
            version: 2,
          }
        );
        assert.deepEqual(
          database
            .prepare(`
              SELECT
                status,
                superseded_by_occurrence_id,
                terminal_at_ms,
                version
              FROM season_rollover_occurrences
              WHERE id = ?
            `)
            .get(initialOccurrenceId),
          {
            status: "superseded",
            superseded_by_occurrence_id:
              rescheduled
                .rolloverOccurrenceId,
            terminal_at_ms:
              rescheduleNowMs,
            version: 2,
          }
        );
        assert.deepEqual(
          database
            .prepare(`
              SELECT
                current_rollover_occurrence_id,
                current_scheduled_job_run_id,
                current_schedule_operation_id,
                scheduled_starts_at_ms,
                scheduled_by_user_id,
                scheduled_by_membership_id,
                scheduled_by_authority,
                version
              FROM entry_draft_rollover_bindings
              WHERE id = ?
            `)
            .get(
              rescheduled.rolloverBindingId
            ),
          {
            current_rollover_occurrence_id:
              rescheduled
                .rolloverOccurrenceId,
            current_scheduled_job_run_id:
              rescheduled.jobRunId,
            current_schedule_operation_id:
              rescheduled.operationId,
            scheduled_starts_at_ms:
              rescheduledStartsAtMs,
            scheduled_by_user_id:
              IDS.commissionerUser,
            scheduled_by_membership_id:
              IDS.commissionerMembership,
            scheduled_by_authority:
              "commissioner",
            version: 2,
          }
        );
        assert.equal(
          database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM entry_draft_schedule_operations
            `)
            .get().count,
          2
        );
        assert.equal(
          database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM idempotency_requests
              WHERE operation = ?
                AND status = 'completed'
                AND result_type =
                  'entry_draft_schedule'
            `)
            .get(
              ENTRY_DRAFT_SCHEDULE_OPERATION
            ).count,
          2
        );
        assert.equal(
          database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM draft_events
              WHERE event_type IN (
                'entry_draft_scheduled',
                'entry_draft_rescheduled'
              )
            `)
            .get().count,
          2
        );
        assert.equal(
          database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM security_audit_events
              WHERE event_type IN (
                'entry_draft.scheduled',
                'entry_draft.rescheduled'
              )
                AND outcome = 'success'
            `)
            .get().count,
          2
        );
        assert.equal(
          database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM notifications
              WHERE event_type IN (
                'entry_draft_scheduled',
                'entry_draft_rescheduled'
              )
            `)
            .get().count,
          4
        );
        assert.equal(
          database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM outbox_events AS event
              JOIN outbox_event_audiences AS audience
                ON audience.league_id =
                  event.league_id
               AND audience.outbox_event_id =
                  event.id
              WHERE event.event_type =
                  'league.changed'
                AND event.aggregate_type =
                  'league'
                AND event.aggregate_id = ?
                AND audience.audience_kind =
                  'league'
            `)
            .get(IDS.league).count,
          2
        );
        assert.throws(
          () =>
            database
              .prepare(`
                UPDATE entry_draft_schedule_operations
                SET reason = 'tampered'
                WHERE id = ?
              `)
              .run(initial.operationId),
          /immutable/i
        );
        assert.throws(
          () =>
            database
              .prepare(`
                DELETE FROM entry_draft_schedule_operations
                WHERE id = ?
              `)
              .run(initial.operationId),
          /immutable/i
        );
        assert.deepEqual(
          database.pragma(
            "foreign_key_check"
          ),
          []
        );
        assert.equal(
          database.pragma(
            "integrity_check",
            { simple: true }
          ),
          "ok"
        );
      }
    );

    test(
      "prepares against the complete current migration schema",
      (t) => {
        const root = fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "hundo-entry-draft-schedule-schema-"
          )
        );
        const connection = openDatabase({
          databasePath: path.join(
            root,
            "schema.sqlite3"
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
          migrationsDirectory:
            MIGRATIONS_DIRECTORY,
          applicationBuildId:
            "entry-draft-schedule-repository-test",
        });
        const repository =
          createSqliteEntryDraftScheduleRepository({
            database: connection.database,
          });
        assert.equal(
          repository.readScheduleContext({
            leagueId: IDS.league,
            entryDraftId: IDS.draft,
          }),
          null
        );
      }
    );
  }
);
