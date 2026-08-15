"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_DAY_MS,
  buildFreeAgentDraftCompletionOccurrenceKey,
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  AUCTION_CREATION_CODES,
  AuctionCreationPolicyError,
} = require(
  "../../src/domain/auctions/auctionCreationPolicy"
);
const {
  planExplicitMatchupSchedule,
} = require(
  "../../src/domain/matchups/matchupSchedulePolicy"
);
const {
  buildMatchupOccurrenceKey,
} = require(
  "../../src/domain/matchups/matchupJobPolicy"
);
const {
  createFreeAgentDraftScheduleRecoveryService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftScheduleRecoveryService"
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
  createSqliteFreeAgentDraftCompletionWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftCompletionWriter"
);
const {
  createSqliteAuctionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuctionRepository"
);
const {
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  createSqliteFreeAgentDraftRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRepository"
);
const {
  createSqliteFreeAgentDraftRecoveryActionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRecoveryActionRepository"
);
const {
  hashFreeAgentDraftRecoveryActionRequest,
  serializeFreeAgentDraftRecoveryActionRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftRecoveryPolicy"
);
const {
  createSqliteFreeAgentDraftScheduleRecoveryWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftScheduleRecoveryWriter"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const DEADLINE_AT_MS =
  WEEK_ONE_AT_MS - 7 * FREE_AGENT_DRAFT_DAY_MS;
const OPENED_AT_MS =
  DEADLINE_AT_MS - 3 * FREE_AGENT_DRAFT_DAY_MS;
const COMPLETED_AT_MS = WEEK_ONE_AT_MS + 1_000;
const LEASE_EXPIRES_AT_MS =
  COMPLETED_AT_MS + FREE_AGENT_DRAFT_DAY_MS;
const EXTENSION_RESOLVES_AT_MS =
  WEEK_ONE_AT_MS + FREE_AGENT_DRAFT_DAY_MS;
const EXTENDED_COMPLETED_AT_MS =
  EXTENSION_RESOLVES_AT_MS + 1_000;
const EXTENDED_LEASE_EXPIRES_AT_MS =
  EXTENDED_COMPLETED_AT_MS + FREE_AGENT_DRAFT_DAY_MS;

function uuid(value) {
  return (
    "40000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function generatedUuid(value) {
  return (
    "80000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function makeSecureRandom(start = 1) {
  let next = start;
  return Object.freeze({
    id() {
      const result = generatedUuid(next);
      next += 1;
      return result;
    },
  });
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  user: uuid(3),
  membership: uuid(4),
  team: uuid(5),
  assignment: uuid(6),
  scheduleOperation: uuid(7),
  weekOne: uuid(8),
  readiness: uuid(9),
  fad: uuid(10),
  participant: uuid(11),
  card: uuid(12),
  snapshot: uuid(13),
  deadlineJob: uuid(14),
  completionJob: uuid(15),
  leaseToken: uuid(16),
  openingActivity: uuid(17),
  openingOutbox: uuid(18),
  secondUser: uuid(19),
  secondMembership: uuid(20),
  secondTeam: uuid(21),
  secondAssignment: uuid(22),
  secondParticipant: uuid(23),
  secondCard: uuid(24),
  secondSnapshot: uuid(25),
  directPlayer: uuid(26),
  directPlayerSource: uuid(27),
  directAuction: uuid(28),
  directDraw: uuid(29),
  directResolution: uuid(30),
  directResolutionJob: uuid(31),
  queuedPlayer: uuid(32),
  queuedPlayerSource: uuid(33),
  queuedNomination: uuid(34),
  queuedAuction: uuid(35),
  queuedDraw: uuid(36),
  queuedStarterBid: uuid(37),
  queuedAuctionEvent: uuid(38),
  queuedResolution: uuid(39),
  queuedResolutionJob: uuid(40),
  extensionRollover: uuid(41),
  extensionRolloverJob: uuid(42),
  ordinaryAuction: uuid(43),
  ordinaryBid: uuid(44),
  ordinaryAuctionEvent: uuid(45),
  ordinaryIdempotency: uuid(46),
});
const OCCURRENCE_KEY =
  buildFreeAgentDraftCompletionOccurrenceKey({
    fadId: IDS.fad,
  });

function insertFixtureRow(database, tableName, values) {
  const fields = Object.keys(values);
  database.prepare(`
    INSERT INTO ${tableName} (${fields.join(", ")})
    VALUES (${fields.map((field) => `@${field}`).join(", ")})
  `).run(values);
}

function withoutFixtureTriggers(database, callback) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  for (const trigger of triggers) {
    database.exec(
      `DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`
    );
  }
  try {
    return callback();
  } finally {
    for (const trigger of triggers) {
      database.exec(trigger.sql);
    }
  }
}

function createDatabase(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-completion-")
  );
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId:
      "fad-completion-writer-foundation",
    now: () => 1,
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
  return connection.database;
}

function seedLeague(database) {
  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      commissioner_membership_id, current_season_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      ?, 'Completion League', 'completion league',
      'active', 'America/Vancouver', NULL, NULL,
      1, 1, 1
    )
  `).run(IDS.league);
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      ?, 'completion@example.test',
      'completion@example.test', 'Completion Manager',
      'completion manager', 'active', 1, 1, 1
    )
  `).run(IDS.user);
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      ?, 'completion-two@example.test',
      'completion-two@example.test',
      'Second Completion Manager',
      'second completion manager', 'active', 1, 1, 1
    )
  `).run(IDS.secondUser);
  database.prepare(`
    INSERT INTO league_settings (
      league_id, salary_cap_cents, trade_deadline_at_ms,
      maximum_teams, active_forward_slots,
      active_defence_slots, bench_slots,
      maximum_bench_aav_cents, injured_reserve_slots,
      prospect_slots_unlimited, scoring_rule_version,
      standings_rule_version, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      ?, 10000, NULL, 20, 12, 6, 4,
      400, 4, 1, 1, 1, 1, 1, 1
    )
  `).run(IDS.league);
  database.prepare(`
    INSERT INTO seasons (
      id, league_id, label, nhl_season_key, status,
      regular_season_starts_at_ms,
      regular_season_ends_at_ms,
      fantasy_playoffs_start_at_ms,
      fantasy_playoffs_end_at_ms,
      created_at_ms, updated_at_ms, version,
      free_agent_draft_completed_at_ms
    ) VALUES (
      ?, ?, '2026-27', '20262027', 'active',
      ?, ?, ?, ?, 1, 1, 1, NULL
    )
  `).run(
    IDS.season,
    IDS.league,
    Date.parse("2026-10-01T07:00:00.000Z"),
    Date.parse("2027-02-15T08:00:00.000Z"),
    Date.parse("2027-01-18T08:00:00.000Z"),
    Date.parse("2027-02-15T08:00:00.000Z")
  );
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category,
      status, joined_at_ms, ended_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      ?, ?, ?, 'commissioner', 'active', 1, NULL,
      1, 1, 1
    )
  `).run(IDS.membership, IDS.league, IDS.user);
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category,
      status, joined_at_ms, ended_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      ?, ?, ?, 'manager', 'active', 1, NULL,
      1, 1, 1
    )
  `).run(
    IDS.secondMembership,
    IDS.league,
    IDS.secondUser
  );
  database.prepare(`
    INSERT INTO teams (
      id, league_id, name, name_normalized, status,
      primary_colour, secondary_colour, logo_reference,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      ?, ?, 'Completion Team', 'completion team',
      'active', '#102030', '#f0a020', NULL,
      1, 1, 1
    )
  `).run(IDS.team, IDS.league);
  database.prepare(`
    INSERT INTO teams (
      id, league_id, name, name_normalized, status,
      primary_colour, secondary_colour, logo_reference,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      ?, ?, 'Second Completion Team',
      'second completion team', 'active',
      '#203040', '#e0b030', NULL, 1, 1, 1
    )
  `).run(IDS.secondTeam, IDS.league);
  database.prepare(`
    INSERT INTO team_manager_assignments (
      id, league_id, team_id, user_id, membership_id,
      assigned_by_user_id, replaces_assignment_id,
      status, assigned_at_ms, accepted_at_ms,
      ended_at_ms, version
    ) VALUES (
      ?, ?, ?, ?, ?, ?, NULL, 'accepted',
      1, 1, NULL, 1
    )
  `).run(
    IDS.assignment,
    IDS.league,
    IDS.team,
    IDS.user,
    IDS.membership,
    IDS.user
  );
  database.prepare(`
    INSERT INTO team_manager_assignments (
      id, league_id, team_id, user_id, membership_id,
      assigned_by_user_id, replaces_assignment_id,
      status, assigned_at_ms, accepted_at_ms,
      ended_at_ms, version
    ) VALUES (
      ?, ?, ?, ?, ?, ?, NULL, 'accepted',
      1, 1, NULL, 1
    )
  `).run(
    IDS.secondAssignment,
    IDS.league,
    IDS.secondTeam,
    IDS.secondUser,
    IDS.secondMembership,
    IDS.user
  );
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?,
        current_season_id = ?,
        updated_at_ms = 2,
        version = 2
    WHERE id = ?
  `).run(IDS.membership, IDS.season, IDS.league);
}

function seedSchedule(database) {
  const calendar = {
    nhlSeasonKey: "20262027",
    nhlRegularSeasonStartsAtMs: Date.parse(
      "2026-10-01T07:00:00.000Z"
    ),
    nhlRegularSeasonEndsAtMs: Date.parse(
      "2027-02-15T08:00:00.000Z"
    ),
    fantasyPlayoffsStartAtMs: Date.parse(
      "2027-01-18T08:00:00.000Z"
    ),
    fantasyPlayoffsEndAtMs: Date.parse(
      "2027-02-15T08:00:00.000Z"
    ),
    timeZone: "America/Vancouver",
  };
  const planned = planExplicitMatchupSchedule({
    teamIds: [IDS.team, IDS.secondTeam],
    ...calendar,
    firstWeekStartsAtMs: WEEK_ONE_AT_MS,
    nowMs: WEEK_ONE_AT_MS - 1,
  });
  database.prepare(`
    INSERT INTO matchup_operations (
      id, league_id, season_id, matchup_week_id,
      matchup_id, actor_user_id, operation_type,
      status, reason, metadata_json, started_at_ms,
      completed_at_ms
    ) VALUES (
      ?, ?, ?, NULL, NULL, NULL, 'schedule_generate',
      'succeeded', NULL, NULL, 2, 3
    )
  `).run(
    IDS.scheduleOperation,
    IDS.league,
    IDS.season
  );
  const insertWeek = database.prepare(`
    INSERT INTO matchup_weeks (
      id, league_id, season_id, week_key, sequence,
      starts_at_ms, baseline_at_ms, locks_at_ms,
      ends_at_ms, rolls_over_at_ms, status,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      @id, @leagueId, @seasonId, @weekKey,
      @sequence, @startsAtMs, @baselineAtMs,
      @locksAtMs, @endsAtMs, @rollsOverAtMs,
      'scheduled', 3, 3, 1
    )
  `);
  const insertMatchup = database.prepare(`
    INSERT INTO matchups (
      id, league_id, season_id, matchup_week_id,
      home_team_id, away_team_id, home_team_name,
      away_team_name, status, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      @id, @leagueId, @seasonId, @weekId,
      @homeTeamId, @awayTeamId, @homeTeamName,
      @awayTeamName, 'scheduled', 3, 3, 1
    )
  `);
  const insertBinding = database.prepare(`
    INSERT INTO matchup_schedule_job_bindings (
      id, league_id, season_id, job_run_id, job_type,
      schedule_operation_id, schedule_version,
      owning_matchup_week_id, owning_matchup_id,
      created_at_ms, version
    ) VALUES (
      @bindingId, @leagueId, @seasonId, @jobRunId,
      @jobType, @scheduleOperationId, 1, @weekId,
      NULL, 3, 1
    )
  `);
  const slots = [
    [
      "matchup:statistics_refresh",
      "startsAtMs",
    ],
    ["matchup:baseline", "baselineAtMs"],
    ["matchup:lock", "locksAtMs"],
    [
      "matchup:statistics_refresh",
      "endsAtMs",
    ],
    ["matchup:finalize", "endsAtMs"],
    ["matchup:rollover", "rollsOverAtMs"],
  ];
  const weeks = planned.weeks.map(
    (week, weekIndex) => ({
      ...week,
      id:
        weekIndex === 0
          ? IDS.weekOne
          : uuid(1_000 + weekIndex),
    })
  );
  const serviceWeeks = [];
  weeks.forEach((week, weekIndex) => {
    const weekId = week.id;
    insertWeek.run({
      leagueId: IDS.league,
      seasonId: IDS.season,
      ...week,
    });
    const matchups = week.pairs.map(
      (pair, pairIndex) => {
        const id = uuid(
          2_000 + weekIndex * 10 + pairIndex
        );
        insertMatchup.run({
          id,
          leagueId: IDS.league,
          seasonId: IDS.season,
          weekId,
          ...pair,
          homeTeamName:
            pair.homeTeamId === IDS.team
              ? "Completion Team"
              : "Second Completion Team",
          awayTeamName:
            pair.awayTeamId === IDS.team
              ? "Completion Team"
              : "Second Completion Team",
        });
        return {
          id,
          leagueId: IDS.league,
          seasonId: IDS.season,
          weekId,
          homeTeamId: pair.homeTeamId,
          awayTeamId: pair.awayTeamId,
          status: "scheduled",
          version: 1,
        };
      }
    );
    serviceWeeks.push({
      id: weekId,
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekKey: week.weekKey,
      sequence: week.sequence,
      startsAtMs: week.startsAtMs,
      baselineAtMs: week.baselineAtMs,
      locksAtMs: week.locksAtMs,
      endsAtMs: week.endsAtMs,
      rollsOverAtMs: week.rollsOverAtMs,
      status: "scheduled",
      version: 1,
      matchups,
      bye: null,
    });
    assert.equal(week.byeTeamId, null);
  });
  database.prepare(`
    INSERT INTO season_matchup_schedule_generations (
      league_id, season_id, schedule_version,
      schedule_operation_id, week_one_matchup_week_id,
      week_one_starts_at_ms, status, created_at_ms,
      superseded_at_ms, version
    ) VALUES (
      ?, ?, 1, ?, ?, ?, 'current', 3, NULL, 1
    )
  `).run(
    IDS.league,
    IDS.season,
    IDS.scheduleOperation,
    IDS.weekOne,
    WEEK_ONE_AT_MS
  );
  const serviceJobs = [];
  weeks.forEach((week, weekIndex) => {
    const weekId = week.id;
    slots.forEach(
      ([jobType, timeField], slotIndex) => {
        const scheduledForMs = week[timeField];
        const jobRunId = uuid(
          3_000 + weekIndex * 10 + slotIndex
        );
        const bindingId = uuid(
          4_000 + weekIndex * 10 + slotIndex
        );
        const occurrenceKey =
          buildMatchupOccurrenceKey({
            jobType,
            leagueId: IDS.league,
            seasonId: IDS.season,
            weekId,
            scheduleOperationId:
              IDS.scheduleOperation,
            scheduleVersion: 1,
            scheduledForMs,
          });
        insertJob(database, {
          id: jobRunId,
          leagueId: IDS.league,
          seasonId: IDS.season,
          jobType,
          occurrenceKey,
          scheduledForMs,
          status: "pending",
          attemptCount: 0,
          leaseOwner: null,
          leaseExpiresAtMs: null,
          startedAtMs: null,
          completedAtMs: null,
          resultJson: null,
          lastErrorCode: null,
          createdAtMs: 3,
          updatedAtMs: 3,
          version: 1,
          leaseToken: null,
          nextAttemptAtMs: scheduledForMs,
        });
        insertBinding.run({
          bindingId,
          leagueId: IDS.league,
          seasonId: IDS.season,
          jobRunId,
          jobType,
          scheduleOperationId:
            IDS.scheduleOperation,
          weekId,
        });
        serviceJobs.push({
          id: jobRunId,
          leagueId: IDS.league,
          seasonId: IDS.season,
          weekId,
          jobType,
          occurrenceKey,
          scheduledForMs,
          status: "pending",
          attemptCount: 0,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAtMs: null,
          startedAtMs: null,
          completedAtMs: null,
          resultJson: null,
          lastErrorCode: null,
          createdAtMs: 3,
          updatedAtMs: 3,
          version: 1,
          nextAttemptAtMs: scheduledForMs,
          bindingId,
          bindingJobType: jobType,
          bindingScheduleOperationId:
            IDS.scheduleOperation,
          bindingScheduleVersion: 1,
          bindingOwningMatchupWeekId: weekId,
          bindingOwningMatchupId: null,
          bindingCreatedAtMs: 3,
          bindingVersion: 1,
        });
      }
    );
  });
  return {
    calendar,
    currentGeneration: {
      leagueId: IDS.league,
      seasonId: IDS.season,
      scheduleVersion: 1,
      scheduleOperationId: IDS.scheduleOperation,
      weekOneMatchupWeekId: IDS.weekOne,
      weekOneStartsAtMs: WEEK_ONE_AT_MS,
      status: "current",
      supersededAtMs: null,
      version: 1,
    },
    weeks: serviceWeeks,
    jobs: serviceJobs,
  };
}

function insertJob(database, values) {
  database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type,
      occurrence_key, scheduled_for_ms, status,
      attempt_count, lease_owner, lease_expires_at_ms,
      started_at_ms, completed_at_ms, result_json,
      last_error_code, created_at_ms, updated_at_ms,
      version, lease_token, next_attempt_at_ms
    ) VALUES (
      @id, @leagueId, @seasonId, @jobType,
      @occurrenceKey, @scheduledForMs, @status,
      @attemptCount, @leaseOwner, @leaseExpiresAtMs,
      @startedAtMs, @completedAtMs, @resultJson,
      @lastErrorCode, @createdAtMs, @updatedAtMs,
      @version, @leaseToken, @nextAttemptAtMs
    )
  `).run(values);
}

function seedTerminalFad(database) {
  database.exec(`
    DROP TRIGGER IF EXISTS free_agent_drafts_valid_insert;
    DROP TRIGGER IF EXISTS free_agent_draft_teams_participant_insert;
    DROP TRIGGER IF EXISTS candidate_cards_setup_insert;
    DROP TRIGGER IF EXISTS free_agent_draft_rollovers_valid_insert;
    DROP TRIGGER IF EXISTS free_agent_draft_readiness_operations_forward_update;
  `);
  database.prepare(`
    INSERT INTO free_agent_draft_readiness_operations (
      id, league_id, season_id, readiness_occurrence_key,
      trigger_kind, entry_draft_id, setup_exemption_id,
      job_run_id, status, attempt_count, lease_owner,
      lease_token, lease_expires_at_ms, blockers_json,
      matchup_schedule_version_before,
      matchup_schedule_version_after,
      schedule_recovery_id, created_fad_id,
      reminder_job_run_id, deadline_job_run_id,
      cards_opened_activity_id,
      cards_opened_outbox_event_id, started_at_ms,
      next_retry_at_ms, terminal_at_ms, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      ?, ?, ?, 'test-readiness', 'no_draft_inaugural',
      NULL, NULL, NULL, 'pending', 0, NULL, NULL,
      NULL, '[]', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 1
    )
  `).run(
    IDS.readiness,
    IDS.league,
    IDS.season,
    OPENED_AT_MS - 1,
    OPENED_AT_MS - 1
  );
  database.prepare(`
    INSERT INTO free_agent_drafts (
      id, league_id, season_id, readiness_operation_id,
      readiness_occurrence_key, first_matchup_week_id,
      current_competition_first_matchup_week_id,
      schedule_recovery_id, participating_team_count,
      status, setup_path, entry_draft_id,
      setup_exemption_id, prior_season_rollover_id,
      no_draft_reason, opening_authority, opened_at_ms,
      help_opens_at_ms, candidate_deadline_at_ms,
      first_matchup_starts_at_ms, deadline_locked_at_ms,
      allocation_completed_at_ms, completed_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      ?, ?, ?, ?, 'test-readiness', ?, ?, NULL, 2,
      'rapid', 'no_draft_inaugural', NULL, NULL, NULL,
      'completion fixture', 'system', ?, ?, ?, ?, ?, ?,
      NULL, ?, ?, 7
    )
  `).run(
    IDS.fad,
    IDS.league,
    IDS.season,
    IDS.readiness,
    IDS.weekOne,
    IDS.weekOne,
    OPENED_AT_MS,
    DEADLINE_AT_MS - 2 * FREE_AGENT_DRAFT_DAY_MS,
    DEADLINE_AT_MS,
    WEEK_ONE_AT_MS,
    DEADLINE_AT_MS,
    DEADLINE_AT_MS + 1,
    OPENED_AT_MS,
    DEADLINE_AT_MS + 1
  );
  database.prepare(`
    INSERT INTO free_agent_draft_teams (
      id, league_id, season_id, fad_id, team_id,
      team_status_at_setup, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(
    IDS.participant,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.team,
    OPENED_AT_MS
  );
  database.prepare(`
    INSERT INTO free_agent_draft_teams (
      id, league_id, season_id, fad_id, team_id,
      team_status_at_setup, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(
    IDS.secondParticipant,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.secondTeam,
    OPENED_AT_MS
  );
  database.prepare(`
    INSERT INTO candidate_cards (
      id, league_id, season_id, fad_id, team_id,
      status, completeness_code, filled_mandatory_count,
      missing_mandatory_count, filled_bench_count,
      empty_bench_count, blocking_validation_count,
      structural_conflict_count,
      maximum_possible_cap_cents, locked_at_ms,
      created_at_ms, updated_at_ms, version,
      carried_roster_structural_conflict_count,
      cap_status, allocation_eligibility,
      allocation_exclusion_reason
    ) VALUES (
      ?, ?, ?, ?, ?, 'locked_incomplete', 'incomplete',
      0, 18, 0, 4, 0, 0, 0, ?, ?, ?, 2,
      0, 'compliant', 'eligible', NULL
    )
  `).run(
    IDS.card,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.team,
    DEADLINE_AT_MS,
    OPENED_AT_MS,
    DEADLINE_AT_MS
  );
  database.prepare(`
    INSERT INTO candidate_cards (
      id, league_id, season_id, fad_id, team_id,
      status, completeness_code, filled_mandatory_count,
      missing_mandatory_count, filled_bench_count,
      empty_bench_count, blocking_validation_count,
      structural_conflict_count,
      maximum_possible_cap_cents, locked_at_ms,
      created_at_ms, updated_at_ms, version,
      carried_roster_structural_conflict_count,
      cap_status, allocation_eligibility,
      allocation_exclusion_reason
    ) VALUES (
      ?, ?, ?, ?, ?, 'locked_incomplete', 'incomplete',
      0, 18, 0, 4, 0, 0, 0, ?, ?, ?, 2,
      0, 'compliant', 'eligible', NULL
    )
  `).run(
    IDS.secondCard,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.secondTeam,
    DEADLINE_AT_MS,
    OPENED_AT_MS,
    DEADLINE_AT_MS
  );
  database.prepare(`
    INSERT INTO candidate_card_snapshots (
      id, league_id, season_id, fad_id, card_id, team_id,
      locked_card_version, locked_status, completeness_code,
      filled_mandatory_count, missing_mandatory_count,
      filled_bench_count, empty_bench_count,
      blocking_validation_count, structural_conflict_count,
      cap_limit_cents, carried_active_player_amount_cents,
      retention_obligation_cents, buyout_penalty_cents,
      carried_cap_usage_cents, proposed_candidate_aav_cents,
      maximum_possible_cap_cents, maximum_cap_space_cents,
      effective_deadline_at_ms, processed_at_ms,
      created_at_ms,
      carried_roster_structural_conflict_count,
      cap_status, allocation_eligibility,
      allocation_exclusion_reason
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 2, 'locked_incomplete',
      'incomplete', 0, 18, 0, 4, 0, 0, 10000,
      0, 0, 0, 0, 0, 0, 10000, ?, ?, ?, 0,
      'compliant', 'eligible', NULL
    )
  `).run(
    IDS.snapshot,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.card,
    IDS.team,
    DEADLINE_AT_MS,
    DEADLINE_AT_MS,
    DEADLINE_AT_MS
  );
  database.prepare(`
    INSERT INTO candidate_card_snapshots (
      id, league_id, season_id, fad_id, card_id, team_id,
      locked_card_version, locked_status, completeness_code,
      filled_mandatory_count, missing_mandatory_count,
      filled_bench_count, empty_bench_count,
      blocking_validation_count, structural_conflict_count,
      cap_limit_cents, carried_active_player_amount_cents,
      retention_obligation_cents, buyout_penalty_cents,
      carried_cap_usage_cents, proposed_candidate_aav_cents,
      maximum_possible_cap_cents, maximum_cap_space_cents,
      effective_deadline_at_ms, processed_at_ms,
      created_at_ms,
      carried_roster_structural_conflict_count,
      cap_status, allocation_eligibility,
      allocation_exclusion_reason
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 2, 'locked_incomplete',
      'incomplete', 0, 18, 0, 4, 0, 0, 10000,
      0, 0, 0, 0, 0, 0, 10000, ?, ?, ?, 0,
      'compliant', 'eligible', NULL
    )
  `).run(
    IDS.secondSnapshot,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.secondCard,
    IDS.secondTeam,
    DEADLINE_AT_MS,
    DEADLINE_AT_MS,
    DEADLINE_AT_MS
  );

  insertJob(database, {
    id: IDS.deadlineJob,
    leagueId: IDS.league,
    seasonId: IDS.season,
    jobType: "fad_deadline",
    occurrenceKey:
      `fad:${IDS.fad}:deadline:${DEADLINE_AT_MS}`,
    scheduledForMs: DEADLINE_AT_MS,
    status: "succeeded",
    attemptCount: 1,
    leaseOwner: null,
    leaseExpiresAtMs: null,
    startedAtMs: DEADLINE_AT_MS,
    completedAtMs: DEADLINE_AT_MS,
    resultJson: "{}",
    lastErrorCode: null,
    createdAtMs: OPENED_AT_MS,
    updatedAtMs: DEADLINE_AT_MS,
    version: 3,
    leaseToken: null,
    nextAttemptAtMs: null,
  });

  database.prepare(`
    INSERT INTO league_activity (
      id, league_id, season_id, event_type,
      actor_user_id, actor_authority, team_id,
      player_id, related_type, related_id,
      display_summary, reason, metadata_json,
      occurred_at_ms
    ) VALUES (
      ?, ?, ?, 'free_agent_draft_cards_opened',
      NULL, 'system', NULL, NULL, 'free_agent_draft',
      ?, 'Candidate Cards opened.', NULL, '{}', ?
    )
  `).run(
    IDS.openingActivity,
    IDS.league,
    IDS.season,
    IDS.fad,
    OPENED_AT_MS
  );
  database.prepare(`
    INSERT INTO outbox_events (
      id, league_id, event_type, aggregate_type,
      aggregate_id, payload_json, status,
      attempt_count, available_at_ms, published_at_ms,
      last_error_code, created_at_ms, updated_at_ms,
      version
    ) VALUES (
      ?, ?, 'free_agent_draft.changed',
      'free_agent_draft', ?, '{}', 'pending', 0,
      ?, NULL, NULL, ?, ?, 1
    )
  `).run(
    IDS.openingOutbox,
    IDS.league,
    IDS.fad,
    OPENED_AT_MS,
    OPENED_AT_MS,
    OPENED_AT_MS
  );
  database.prepare(`
    UPDATE free_agent_draft_readiness_operations
    SET status = 'succeeded',
        matchup_schedule_version_before = 1,
        matchup_schedule_version_after = 1,
        created_fad_id = ?,
        reminder_job_run_id = ?,
        deadline_job_run_id = ?,
        cards_opened_activity_id = ?,
        cards_opened_outbox_event_id = ?,
        started_at_ms = ?,
        terminal_at_ms = ?,
        updated_at_ms = ?,
        version = 2
    WHERE id = ?
  `).run(
    IDS.fad,
    IDS.deadlineJob,
    IDS.deadlineJob,
    IDS.openingActivity,
    IDS.openingOutbox,
    OPENED_AT_MS,
    OPENED_AT_MS,
    OPENED_AT_MS,
    IDS.readiness
  );

  let predecessorId = null;
  for (let index = 0; index < 7; index += 1) {
    const sequence = index + 1;
    const rolloverId = uuid(100 + sequence);
    const rolloverJobId = uuid(200 + sequence);
    const opensAtMs =
      DEADLINE_AT_MS + index * FREE_AGENT_DRAFT_DAY_MS;
    const rollsOverAtMs =
      opensAtMs + FREE_AGENT_DRAFT_DAY_MS;
    insertJob(database, {
      id: rolloverJobId,
      leagueId: IDS.league,
      seasonId: IDS.season,
      jobType: "fad_rollover",
      occurrenceKey:
        buildFreeAgentDraftRolloverOccurrenceKey({
          fadId: IDS.fad,
          sequence,
          rolloverAtMs: rollsOverAtMs,
        }),
      scheduledForMs: rollsOverAtMs,
      status: "succeeded",
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAtMs: null,
      startedAtMs: rollsOverAtMs,
      completedAtMs: rollsOverAtMs,
      resultJson: "{}",
      lastErrorCode: null,
      createdAtMs: OPENED_AT_MS,
      updatedAtMs: rollsOverAtMs,
      version: 3,
      leaseToken: null,
      nextAttemptAtMs: null,
    });
    database.prepare(`
      INSERT INTO free_agent_draft_rollovers (
        id, league_id, season_id, fad_id, sequence,
        window_kind, predecessor_rollover_id,
        extension_reason, extension_source_id, opens_at_ms,
        creation_cutoff_at_ms, rolls_over_at_ms, status,
        processing_job_run_id, processing_started_at_ms,
        completed_at_ms, last_error_code, created_at_ms,
        updated_at_ms, version
      ) VALUES (
        @id, @leagueId, @seasonId, @fadId, @sequence,
        'initial', @predecessorId, NULL, NULL, @opensAtMs,
        @creationCutoffAtMs, @rollsOverAtMs, 'completed',
        @jobRunId, @rollsOverAtMs, @rollsOverAtMs, NULL,
        @createdAtMs, @rollsOverAtMs, 3
      )
    `).run({
      id: rolloverId,
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      sequence,
      predecessorId,
      opensAtMs,
      creationCutoffAtMs:
        rollsOverAtMs - 60 * 60 * 1000,
      rollsOverAtMs,
      jobRunId: rolloverJobId,
      createdAtMs: OPENED_AT_MS,
    });
    predecessorId = rolloverId;
  }

  insertJob(database, {
    id: IDS.completionJob,
    leagueId: IDS.league,
    seasonId: IDS.season,
    jobType: "fad_completion",
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: WEEK_ONE_AT_MS,
    status: "pending",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAtMs: null,
    startedAtMs: null,
    completedAtMs: null,
    resultJson: null,
    lastErrorCode: null,
    createdAtMs: OPENED_AT_MS,
    updatedAtMs: OPENED_AT_MS,
    version: 1,
    leaseToken: null,
    nextAttemptAtMs: null,
  });
}

function seedOpenCompletionAuctionBlockers(database) {
  const directOpenedAtMs =
    WEEK_ONE_AT_MS - FREE_AGENT_DRAFT_DAY_MS;
  const queueAcceptedAtMs =
    WEEK_ONE_AT_MS - 2 * 60 * 60 * 1_000;
  const directNonce = Buffer.alloc(32, 0x51);
  const directCommitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.directAuction,
      nonceBytes: directNonce,
    });

  withoutFixtureTriggers(database, () => {
    for (const [playerId, sourceId, name] of [
      [IDS.directPlayer, IDS.directPlayerSource, "Direct"],
      [IDS.queuedPlayer, IDS.queuedPlayerSource, "Queued"],
    ]) {
      insertFixtureRow(database, "players", {
        id: playerId,
        first_name: name,
        last_name: "Completion",
        full_name: `${name} Completion`,
        birth_date: null,
        status: "active",
        created_at_ms: OPENED_AT_MS,
        updated_at_ms: OPENED_AT_MS,
        version: 1,
      });
      insertFixtureRow(database, "player_source_state", {
        id: sourceId,
        player_id: playerId,
        provider: "foundation",
        source_position: "C",
        normalized_position: "F",
        nhl_team_abbreviation: "TST",
        active: 1,
        source_version: "1",
        source_payload_json: "{}",
        effective_at_ms: OPENED_AT_MS,
        ended_at_ms: null,
        created_at_ms: OPENED_AT_MS,
      });
    }
    insertFixtureRow(database, "auctions", {
      id: IDS.directAuction,
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.directPlayer,
      status: "open",
      opened_at_ms: directOpenedAtMs,
      resolves_at_ms: WEEK_ONE_AT_MS,
      opened_by_user_id: IDS.user,
      created_at_ms: directOpenedAtMs,
      updated_at_ms: directOpenedAtMs,
      version: 1,
    });
    insertFixtureRow(database, "auction_contexts", {
      id: IDS.directAuction,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.directAuction,
      source_kind: "fad_open_rapid",
      fad_id: IDS.fad,
      fad_rollover_id: uuid(107),
      fad_allocation_id: null,
      fad_origin: "manager_nomination",
      created_at_ms: directOpenedAtMs,
    });
    insertFixtureRow(database, "free_agent_draft_draws", {
      id: IDS.directDraw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: null,
      auction_id: IDS.directAuction,
      algorithm_version: 1,
      nonce_bytes: directNonce,
      commitment_hex: directCommitment.commitmentHex,
      ordered_tied_bid_ids_json: null,
      ordered_tied_team_ids_json: null,
      rejection_counter: null,
      selected_index: null,
      selected_bid_id: null,
      selected_team_id: null,
      selected_digest_hex: null,
      revealed_at_ms: null,
      created_at_ms: directOpenedAtMs,
      updated_at_ms: directOpenedAtMs,
      version: 1,
    });
    insertJob(database, {
      id: IDS.directResolutionJob,
      leagueId: IDS.league,
      seasonId: IDS.season,
      jobType: "auction.resolve.target",
      occurrenceKey:
        `auction:${IDS.directAuction}:${WEEK_ONE_AT_MS}`,
      scheduledForMs: WEEK_ONE_AT_MS,
      status: "pending",
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAtMs: null,
      startedAtMs: null,
      completedAtMs: null,
      resultJson: null,
      lastErrorCode: null,
      createdAtMs: directOpenedAtMs,
      updatedAtMs: directOpenedAtMs,
      version: 1,
      leaseToken: null,
      nextAttemptAtMs: null,
    });
    insertFixtureRow(
      database,
      "free_agent_draft_nomination_queue",
      {
        id: IDS.queuedNomination,
        league_id: IDS.league,
        season_id: IDS.season,
        fad_id: IDS.fad,
        team_id: IDS.secondTeam,
        player_id: IDS.queuedPlayer,
        source_rollover_id: uuid(107),
        target_opening_rollover_id: uuid(107),
        resolution_rollover_id: null,
        opening_total_value_cents: 600,
        opening_term_years: 2,
        opening_aav_cents: 300,
        binding_illegality_confirmed: 1,
        binding_confirmed_at_ms: queueAcceptedAtMs,
        submitted_by_user_id: IDS.secondUser,
        submitted_by_membership_id: IDS.secondMembership,
        accepted_at_ms: queueAcceptedAtMs,
        candidate_card_version_observed: 2,
        team_version_observed: 1,
        status: "queued",
        opened_auction_id: null,
        opened_starter_bid_id: null,
        opened_at_ms: null,
        terminal_at_ms: null,
        validation_code: null,
        created_at_ms: queueAcceptedAtMs,
        updated_at_ms: queueAcceptedAtMs,
        version: 1,
        acceptance_idempotency_request_id: null,
      }
    );
  });
  assert.deepEqual(
    database.prepare("PRAGMA foreign_key_check").all(),
    []
  );
}

function finalizeCompletionAuctionEvidence(database) {
  const directOccurrenceKey =
    `auction:${IDS.directAuction}:${WEEK_ONE_AT_MS}`;
  const queuedOccurrenceKey =
    `auction:${IDS.queuedAuction}:${EXTENSION_RESOLVES_AT_MS}`;
  const queueAcceptedAtMs =
    WEEK_ONE_AT_MS - 2 * 60 * 60 * 1_000;
  const queuedNonce = Buffer.alloc(32, 0x52);
  const queuedCommitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.queuedAuction,
      nonceBytes: queuedNonce,
    });

  withoutFixtureTriggers(database, () => {
    database.prepare(`
      UPDATE auctions
      SET status = 'no_winner',
          updated_at_ms = @resolvedAtMs,
          version = 3
      WHERE id = @auctionId
    `).run({
      auctionId: IDS.directAuction,
      resolvedAtMs: WEEK_ONE_AT_MS,
    });
    database.prepare(`
      UPDATE free_agent_draft_draws
      SET ordered_tied_bid_ids_json = '[]',
          ordered_tied_team_ids_json = '[]',
          revealed_at_ms = @resolvedAtMs,
          updated_at_ms = @resolvedAtMs,
          version = 2
      WHERE id = @drawId
    `).run({
      drawId: IDS.directDraw,
      resolvedAtMs: WEEK_ONE_AT_MS,
    });
    database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          attempt_count = 1,
          started_at_ms = @resolvedAtMs,
          completed_at_ms = @resolvedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          updated_at_ms = @resolvedAtMs,
          version = 3,
          next_attempt_at_ms = NULL
      WHERE id = @runId
    `).run({
      runId: IDS.directResolutionJob,
      resolvedAtMs: WEEK_ONE_AT_MS,
      resultJson: JSON.stringify({
        auctionId: IDS.directAuction,
        outcome: "no_winner",
      }),
    });
    insertFixtureRow(database, "auction_resolutions", {
      id: IDS.directResolution,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.directAuction,
      scheduled_occurrence_key: directOccurrenceKey,
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
      idempotency_key: "completion-direct-no-winner",
      status: "no_bids",
      resolved_at_ms: WEEK_ONE_AT_MS,
    });

    insertJob(database, {
      id: IDS.extensionRolloverJob,
      leagueId: IDS.league,
      seasonId: IDS.season,
      jobType: "fad_rollover",
      occurrenceKey:
        buildFreeAgentDraftRolloverOccurrenceKey({
          fadId: IDS.fad,
          sequence: 8,
          rolloverAtMs: EXTENSION_RESOLVES_AT_MS,
        }),
      scheduledForMs: EXTENSION_RESOLVES_AT_MS,
      status: "succeeded",
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAtMs: null,
      startedAtMs: EXTENSION_RESOLVES_AT_MS,
      completedAtMs: EXTENSION_RESOLVES_AT_MS,
      resultJson: "{}",
      lastErrorCode: null,
      createdAtMs: WEEK_ONE_AT_MS,
      updatedAtMs: EXTENSION_RESOLVES_AT_MS,
      version: 3,
      leaseToken: null,
      nextAttemptAtMs: null,
    });
    insertFixtureRow(database, "free_agent_draft_rollovers", {
      id: IDS.extensionRollover,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      sequence: 8,
      window_kind: "extension",
      predecessor_rollover_id: uuid(107),
      extension_reason: "queued_nomination",
      extension_source_id: IDS.queuedNomination,
      opens_at_ms: WEEK_ONE_AT_MS,
      creation_cutoff_at_ms:
        EXTENSION_RESOLVES_AT_MS - 60 * 60 * 1_000,
      rolls_over_at_ms: EXTENSION_RESOLVES_AT_MS,
      status: "completed",
      processing_job_run_id: IDS.extensionRolloverJob,
      processing_started_at_ms: EXTENSION_RESOLVES_AT_MS,
      completed_at_ms: EXTENSION_RESOLVES_AT_MS,
      last_error_code: null,
      created_at_ms: WEEK_ONE_AT_MS,
      updated_at_ms: EXTENSION_RESOLVES_AT_MS,
      version: 3,
    });
    insertFixtureRow(database, "auctions", {
      id: IDS.queuedAuction,
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.queuedPlayer,
      status: "no_winner",
      opened_at_ms: WEEK_ONE_AT_MS,
      resolves_at_ms: EXTENSION_RESOLVES_AT_MS,
      opened_by_user_id: IDS.secondUser,
      created_at_ms: WEEK_ONE_AT_MS,
      updated_at_ms: EXTENSION_RESOLVES_AT_MS,
      version: 3,
    });
    insertFixtureRow(database, "auction_contexts", {
      id: IDS.queuedAuction,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.queuedAuction,
      source_kind: "fad_open_rapid",
      fad_id: IDS.fad,
      fad_rollover_id: IDS.extensionRollover,
      fad_allocation_id: null,
      fad_origin: "queued_nomination",
      created_at_ms: WEEK_ONE_AT_MS,
    });
    insertFixtureRow(database, "auction_bids", {
      id: IDS.queuedStarterBid,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.queuedAuction,
      team_id: IDS.secondTeam,
      submitted_by_user_id: IDS.secondUser,
      total_value_cents: 600,
      term_years: 2,
      lowest_offered_aav_cents: 300,
      first_submitted_at_ms: queueAcceptedAtMs,
      last_edited_at_ms: queueAcceptedAtMs,
      edit_count: 0,
      status: "invalid",
      idempotency_request_id: null,
      version: 2,
    });
    insertFixtureRow(database, "auction_events", {
      id: IDS.queuedAuctionEvent,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.queuedAuction,
      bid_id: IDS.queuedStarterBid,
      team_id: IDS.secondTeam,
      actor_user_id: IDS.secondUser,
      event_type: "auction_started",
      metadata_json: JSON.stringify({
        actorAuthority: "manager",
        actorMembershipId: IDS.secondMembership,
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
      }),
      occurred_at_ms: WEEK_ONE_AT_MS,
    });
    insertFixtureRow(database, "free_agent_draft_draws", {
      id: IDS.queuedDraw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: null,
      auction_id: IDS.queuedAuction,
      algorithm_version: 1,
      nonce_bytes: queuedNonce,
      commitment_hex: queuedCommitment.commitmentHex,
      ordered_tied_bid_ids_json: "[]",
      ordered_tied_team_ids_json: "[]",
      rejection_counter: null,
      selected_index: null,
      selected_bid_id: null,
      selected_team_id: null,
      selected_digest_hex: null,
      revealed_at_ms: EXTENSION_RESOLVES_AT_MS,
      created_at_ms: WEEK_ONE_AT_MS,
      updated_at_ms: EXTENSION_RESOLVES_AT_MS,
      version: 2,
    });
    insertJob(database, {
      id: IDS.queuedResolutionJob,
      leagueId: IDS.league,
      seasonId: IDS.season,
      jobType: "auction.resolve.target",
      occurrenceKey: queuedOccurrenceKey,
      scheduledForMs: EXTENSION_RESOLVES_AT_MS,
      status: "succeeded",
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAtMs: null,
      startedAtMs: EXTENSION_RESOLVES_AT_MS,
      completedAtMs: EXTENSION_RESOLVES_AT_MS,
      resultJson: JSON.stringify({
        auctionId: IDS.queuedAuction,
        outcome: "no_winner",
      }),
      lastErrorCode: null,
      createdAtMs: WEEK_ONE_AT_MS,
      updatedAtMs: EXTENSION_RESOLVES_AT_MS,
      version: 3,
      leaseToken: null,
      nextAttemptAtMs: null,
    });
    insertFixtureRow(database, "auction_resolutions", {
      id: IDS.queuedResolution,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.queuedAuction,
      scheduled_occurrence_key: queuedOccurrenceKey,
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
      idempotency_key: "completion-queued-no-winner",
      status: "no_winner",
      resolved_at_ms: EXTENSION_RESOLVES_AT_MS,
    });
    database.prepare(`
      UPDATE free_agent_draft_nomination_queue
      SET resolution_rollover_id = @resolutionRolloverId,
          status = 'opened',
          opened_auction_id = @auctionId,
          opened_starter_bid_id = @starterBidId,
          opened_at_ms = @openedAtMs,
          terminal_at_ms = @openedAtMs,
          validation_code = NULL,
          updated_at_ms = @openedAtMs,
          version = 2
      WHERE id = @queueId
    `).run({
      queueId: IDS.queuedNomination,
      resolutionRolloverId: IDS.extensionRollover,
      auctionId: IDS.queuedAuction,
      starterBidId: IDS.queuedStarterBid,
      openedAtMs: WEEK_ONE_AT_MS,
    });
  });
  assert.deepEqual(
    database.prepare("PRAGMA foreign_key_check").all(),
    []
  );
}

function ordinaryAuctionCommand() {
  return {
    auctionId: IDS.ordinaryAuction,
    bidId: IDS.ordinaryBid,
    eventId: IDS.ordinaryAuctionEvent,
    idempotencyRequestId: IDS.ordinaryIdempotency,
    leagueId: IDS.league,
    seasonId: IDS.season,
    teamId: IDS.team,
    playerId: IDS.directPlayer,
    actorUserId: IDS.user,
    actorMembershipId: IDS.membership,
    actorAuthority: "commissioner",
    aavCents: 300,
    termYears: 2,
    idempotencyKey: "ordinary-after-fad-completion",
    occurredAtMs: EXTENDED_COMPLETED_AT_MS,
    idempotencyExpiresAtMs:
      EXTENDED_COMPLETED_AT_MS + FREE_AGENT_DRAFT_DAY_MS,
  };
}

function fixture(t, options = {}) {
  const database = createDatabase(t);
  let schedule;
  for (const [name, seed] of [
    ["league", seedLeague],
    ["schedule", seedSchedule],
    ["terminal FAD", seedTerminalFad],
  ]) {
    try {
      const seeded = seed(database);
      if (name === "schedule") {
        schedule = seeded;
      }
    } catch (error) {
      throw new Error(
        `Failed to seed ${name}: ${error.message}`,
        { cause: error }
      );
    }
  }
  const scheduleRecoveryService =
    options.realRecovery === true
      ? createFreeAgentDraftScheduleRecoveryService({
          secureRandom: makeSecureRandom(10_000),
        })
      : options.scheduleRecoveryService || {
          planRecovery() {
            return Object.freeze({ action: "no_op" });
          },
        };
  const writer =
    createSqliteFreeAgentDraftCompletionWriter({
      database,
      scheduleRecoveryService,
      afterStep: options.afterStep,
    });
  const scheduleRecoveryWriter =
    createSqliteFreeAgentDraftScheduleRecoveryWriter({
      database,
      afterStep: options.scheduleAfterStep,
    });
  const lifecycleRepository =
    createSqliteFreeAgentDraftRepository({
      database,
      scheduleRecoveryWriter,
      transitionWriter: {
        beforeTransition(input) {
          return writer.beforeTransition(input);
        },
        afterTransition(input) {
          return writer.afterTransition(input);
        },
      },
      beforeCommit: options.lifecycleBeforeCommit,
    });
  return {
    database,
    lifecycleRepository,
    schedule,
    scheduleRecoveryWriter,
    writer,
  };
}

function claimCompletion(
  database,
  {
    nowMs = COMPLETED_AT_MS,
    leaseExpiresAtMs = LEASE_EXPIRES_AT_MS,
  } = {}
) {
  const repository =
    createSqliteFreeAgentDraftJobRepository({
      database,
    });
  return repository.claim({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    runId: IDS.completionJob,
    jobType: "fad_completion",
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: WEEK_ONE_AT_MS,
    expectedVersion: 1,
    leaseOwner: "completion-worker",
    leaseToken: IDS.leaseToken,
    nowMs,
    leaseExpiresAtMs,
  });
}

function completionCommand(
  claimed,
  completedAtMs = COMPLETED_AT_MS
) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    initialWindowEndsAtMs: WEEK_ONE_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: WEEK_ONE_AT_MS,
    completedAtMs,
    jobExecution: {
      runId: claimed.runId,
      leaseOwner: "completion-worker",
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: claimed.leaseExpiresAtMs,
      startedAtMs: claimed.startedAtMs,
      attemptCount: claimed.attemptCount,
      expectedVersion: claimed.version,
    },
  };
}

function failureCommand(
  claimed,
  errorCode =
    "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID"
) {
  const {
    completedAtMs: _completedAtMs,
    ...execution
  } = completionCommand(claimed);
  return {
    ...execution,
    failedAtMs: COMPLETED_AT_MS,
    errorCode,
  };
}

function acceptCompletionRecovery(database, acceptedAtMs) {
  const body = {
    action: "complete_fad",
    resourceId: null,
    reason: "Retry the deterministic completion failure.",
  };
  const request = {
    body,
    fadId: IDS.fad,
    leagueId: IDS.league,
  };
  return createSqliteFreeAgentDraftRecoveryActionRepository({
    database,
  }).acceptRecoveryAction({
    actorAuthority: "commissioner",
    actorMembershipId: IDS.membership,
    actorUserId: IDS.user,
    body,
    clientKey: "completion-recovery-requeue",
    fadId: IDS.fad,
    leagueId: IDS.league,
    requestJson:
      serializeFreeAgentDraftRecoveryActionRequest(request),
    requestSha256:
      hashFreeAgentDraftRecoveryActionRequest(request),
    acceptedAtMs,
    commandResultId: uuid(90_100),
    idempotencyExpiresAtMs:
      acceptedAtMs + FREE_AGENT_DRAFT_DAY_MS,
    idempotencyRequestId: uuid(90_101),
  });
}

function installPriorScheduleRecovery({
  database,
  schedule,
  scheduleRecoveryWriter,
}) {
  const plan =
    createFreeAgentDraftScheduleRecoveryService({
      secureRandom: makeSecureRandom(20_000),
    }).planRecovery({
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      recovery: {
        kind: "completion",
        atMs: WEEK_ONE_AT_MS,
        frozenFadFirstMatchupStartsAtMs:
          WEEK_ONE_AT_MS,
      },
      ...schedule,
    });
  assert.equal(plan.action, "stage_recovery");
  database.exec(
    "DROP TRIGGER IF EXISTS free_agent_drafts_forward_update"
  );
  const apply = database.transaction(() => {
    const sealed =
      scheduleRecoveryWriter.applyAndSeal({ plan });
    assert.equal(
      sealed.recoveryId,
      plan.recovery.id
    );
    assert.equal(
      database.prepare(`
        UPDATE free_agent_drafts
        SET current_competition_first_matchup_week_id = ?,
            schedule_recovery_id = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE id = ? AND status = 'rapid'
      `).run(
        plan.recovery.newFirstMatchupWeekId,
        plan.recovery.id,
        WEEK_ONE_AT_MS,
        IDS.fad
      ).changes,
      1
    );
    return sealed;
  });
  apply.immediate();
  return plan;
}

describe("SQLite Free Agent Draft completion writer", () => {
  test("prepares against the migrated completion schema and requires outer hook transactions", (t) => {
    const { writer } = fixture(t);
    assert.throws(
      () => writer.beforeTransition({}),
      (error) =>
        error.details?.reasonCode ===
        "TRANSACTION_REQUIRED"
    );
    assert.throws(
      () => writer.afterTransition({}),
      (error) =>
        error.details?.reasonCode ===
        "TRANSACTION_REQUIRED"
    );
  });

  test("lists only a fully terminal durable candidate without requiring a full roster", (t) => {
    const { database, writer } = fixture(t);

    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM player_ownerships
        WHERE league_id = ? AND season_id = ?
      `).get(IDS.league, IDS.season).count,
      0
    );
    assert.deepEqual(
      writer.listCandidates({
        nowMs: COMPLETED_AT_MS,
        limit: 10,
      }),
      [
        {
          runId: IDS.completionJob,
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          jobType: "fad_completion",
          occurrenceKey: OCCURRENCE_KEY,
          scheduledForMs: WEEK_ONE_AT_MS,
          initialWindowEndsAtMs: WEEK_ONE_AT_MS,
          status: "pending",
          attemptCount: 0,
          nextAttemptAtMs: null,
          leaseExpiresAtMs: null,
          version: 1,
        },
      ]
    );
    database.exec(
      "DROP TRIGGER IF EXISTS candidate_cards_open_update"
    );
    database.prepare(`
      UPDATE candidate_cards
      SET status = 'open',
          locked_at_ms = NULL,
          updated_at_ms = updated_at_ms + 1,
          version = version + 1
      WHERE id = ?
    `).run(IDS.secondCard);
    assert.deepEqual(
      writer.listCandidates({
        nowMs: COMPLETED_AT_MS,
        limit: 10,
      }),
      []
    );
  });

  test("rolls back a deterministic planning failure, then records and exactly replays one fenced correction", (t) => {
    const { database, writer } = fixture(t);
    const claim = claimCompletion(database);
    assert.equal(claim.acquired, true);
    const claimed = claim.occurrence;

    assert.throws(
      () =>
        writer.executeClaimed(
          completionCommand(claimed),
          { advanceStatus() {} }
        ),
      (error) =>
        error.details?.reasonCode ===
        "SCHEDULE_RECOVERY_PLAN_INVALID"
    );

    assert.deepEqual(
      database.prepare(`
        SELECT status, version, last_error_code
        FROM job_runs WHERE id = ?
      `).get(IDS.completionJob),
      {
        status: "running",
        version: 2,
        last_error_code: null,
      }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_recoveries
        WHERE fad_id = ?
      `).get(IDS.fad).count,
      0
    );

    const failure = writer.recordFailure(
      failureCommand(claimed)
    );
    assert.deepEqual(failure, {
      recorded: true,
      replayed: false,
      runId: IDS.completionJob,
      failedAtMs: COMPLETED_AT_MS,
      errorCode:
        "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
      jobVersion: 3,
      recoveryId: failure.recoveryId,
      recoveryVersion: 1,
    });
    assert.match(failure.recoveryId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(
      writer.recordFailure(failureCommand(claimed)),
      {
        ...failure,
        replayed: true,
      }
    );
    assert.deepEqual(
      writer.recordFailure(
        failureCommand(
          claimed,
          "FAD_COMPLETION_EVIDENCE_INVALID"
        )
      ),
      {
        recorded: false,
        replayed: false,
        runId: IDS.completionJob,
        failedAtMs: COMPLETED_AT_MS,
        errorCode: "FAD_COMPLETION_EVIDENCE_INVALID",
        jobVersion: null,
        recoveryId: null,
        recoveryVersion: null,
      }
    );

    const root = database.prepare(`
      SELECT status, completed_at_ms
      FROM free_agent_drafts
      WHERE id = ?
    `).get(IDS.fad);
    assert.deepEqual(root, {
      status: "rapid",
      completed_at_ms: null,
    });
    const job = database.prepare(`
      SELECT status, next_attempt_at_ms, last_error_code,
             lease_owner, lease_token, lease_expires_at_ms,
             completed_at_ms, result_json, version
      FROM job_runs
      WHERE id = ?
    `).get(IDS.completionJob);
    assert.deepEqual(job, {
      status: "failed",
      next_attempt_at_ms: null,
      last_error_code:
        "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
      lease_owner: null,
      lease_token: null,
      lease_expires_at_ms: null,
      completed_at_ms: COMPLETED_AT_MS,
      result_json: null,
      version: 3,
    });
    assert.deepEqual(
      database.prepare(`
        SELECT kind, status, job_run_id, last_error_code
        FROM free_agent_draft_recoveries
        WHERE fad_id = ?
      `).all(IDS.fad),
      [
        {
          kind: "completion",
          status: "correction_required",
          job_run_id: IDS.completionJob,
          last_error_code:
            "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
        },
      ]
    );
    assert.equal(
      database.prepare(`
        SELECT
          (
            SELECT COUNT(*) FROM league_activity
            WHERE event_type IN (
              'free_agent_draft_week1_recovered',
              'free_agent_draft_completed'
            )
          ) + (
            SELECT COUNT(*) FROM notifications
            WHERE event_type IN (
              'fad_week1_recovered', 'fad_completed'
            )
          ) + (
            SELECT COUNT(*) FROM outbox_events
            WHERE created_at_ms = ?
          ) AS count
      `).get(COMPLETED_AT_MS).count,
      0
    );
  });

  test("holds failed completion work out of candidates until exact T142 requeue", (t) => {
    const { database, writer } = fixture(t);
    const claim = claimCompletion(database);
    assert.equal(claim.acquired, true);
    const claimed = claim.occurrence;
    const command = failureCommand(claimed);

    assert.equal(writer.recordFailure(command).recorded, true);
    assert.deepEqual(
      writer.listCandidates({
        nowMs: COMPLETED_AT_MS + 1,
        limit: 10,
      }),
      []
    );
    const acceptedAtMs = COMPLETED_AT_MS + 1;
    const accepted = acceptCompletionRecovery(
      database,
      acceptedAtMs
    );
    assert.equal(accepted.data.action, "complete_fad");
    assert.equal(accepted.data.status, "pending");
    assert.deepEqual(
      database.prepare(`
        SELECT status, attempt_count, next_attempt_at_ms,
               started_at_ms, completed_at_ms,
               last_error_code, version
        FROM job_runs WHERE id = ?
      `).get(IDS.completionJob),
      {
        status: "pending",
        attempt_count: 1,
        next_attempt_at_ms: acceptedAtMs,
        started_at_ms: null,
        completed_at_ms: null,
        last_error_code: null,
        version: 4,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, last_error_code
        FROM free_agent_draft_recoveries
        WHERE fad_id = ? AND kind = 'completion'
      `).get(IDS.fad),
      {
        status: "running",
        last_error_code:
          "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
      }
    );
    assert.deepEqual(
      writer.recordFailure(command),
      {
        recorded: false,
        replayed: false,
        runId: IDS.completionJob,
        failedAtMs: COMPLETED_AT_MS,
        errorCode:
          "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
        jobVersion: null,
        recoveryId: null,
        recoveryVersion: null,
      }
    );
    const candidates = writer.listCandidates({
      nowMs: acceptedAtMs,
      limit: 10,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "pending");
    assert.equal(candidates[0].nextAttemptAtMs, acceptedAtMs);

    const retryClaim =
      createSqliteFreeAgentDraftJobRepository({
        database,
      }).claim({
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        runId: IDS.completionJob,
        jobType: "fad_completion",
        occurrenceKey: OCCURRENCE_KEY,
        scheduledForMs: WEEK_ONE_AT_MS,
        expectedVersion: 4,
        leaseOwner: "completion-worker",
        leaseToken: uuid(90_102),
        nowMs: acceptedAtMs,
        leaseExpiresAtMs:
          acceptedAtMs + FREE_AGENT_DRAFT_DAY_MS,
      });
    assert.equal(retryClaim.acquired, true);
    assert.equal(retryClaim.occurrence.attemptCount, 2);
  });

  test("rejects a stale lease witness without changing the live job or creating recovery", (t) => {
    const { database, writer } = fixture(t);
    const claim = claimCompletion(database);
    assert.equal(claim.acquired, true);
    const command = completionCommand(
      claim.occurrence
    );
    command.jobExecution = {
      ...command.jobExecution,
      leaseToken: uuid(90_000),
    };

    assert.throws(
      () =>
        writer.executeClaimed(command, {
          advanceStatus() {},
        }),
      (error) =>
        error.details?.reasonCode ===
        "JOB_LEASE_CHANGED"
    );
    assert.equal(
      writer.recordFailure({
        ...failureCommand(claim.occurrence),
        jobExecution: {
          ...failureCommand(claim.occurrence).jobExecution,
          leaseToken: uuid(90_000),
        },
      }).recorded,
      false
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, lease_token, version
        FROM job_runs WHERE id = ?
      `).get(IDS.completionJob),
      {
        status: "running",
        lease_token: IDS.leaseToken,
        version: 2,
      }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_recoveries
        WHERE fad_id = ?
      `).get(IDS.fad).count,
      0
    );
  });

  test("rolls back every transient schedule, root, publication, and job seam without terminalizing the lease", async (t) => {
    const seams = [
      {
        name: "after_schedule_plan",
        writerStep: "after_schedule_plan",
      },
      {
        name: "after_schedule_replaced",
        scheduleStep: "after_schedule_replaced",
      },
      {
        name: "after_root_update",
        writerStep: "after_root_update",
      },
      {
        name: "after_publication",
        writerStep: "after_publication",
      },
      {
        name: "after_job_terminal",
        writerStep: "after_job_terminal",
      },
    ];
    for (const seam of seams) {
      await t.test(seam.name, (subtest) => {
        const inject = (expected) => (step) => {
          if (step === expected) {
            throw new Error(`forced ${expected}`);
          }
        };
        const {
          database,
          lifecycleRepository,
          writer,
        } = fixture(subtest, {
          realRecovery: true,
          afterStep: seam.writerStep
            ? inject(seam.writerStep)
            : undefined,
          scheduleAfterStep: seam.scheduleStep
            ? inject(seam.scheduleStep)
            : undefined,
        });
        const claim = claimCompletion(database);
        assert.equal(claim.acquired, true);

        assert.throws(
          () =>
            writer.executeClaimed(
              completionCommand(claim.occurrence),
              lifecycleRepository
            ),
          (error) =>
            error.code === "REPOSITORY_OPERATION_FAILED"
        );
        assert.deepEqual(
          database.prepare(`
            SELECT status,
                   current_competition_first_matchup_week_id,
                   schedule_recovery_id, completed_at_ms
            FROM free_agent_drafts WHERE id = ?
          `).get(IDS.fad),
          {
            status: "rapid",
            current_competition_first_matchup_week_id:
              IDS.weekOne,
            schedule_recovery_id: null,
            completed_at_ms: null,
          }
        );
        assert.deepEqual(
          database.prepare(`
            SELECT schedule_version,
                   week_one_matchup_week_id,
                   week_one_starts_at_ms
            FROM season_matchup_schedule_generations
            WHERE league_id = ? AND season_id = ?
              AND status = 'current'
          `).get(IDS.league, IDS.season),
          {
            schedule_version: 1,
            week_one_matchup_week_id: IDS.weekOne,
            week_one_starts_at_ms: WEEK_ONE_AT_MS,
          }
        );
        assert.equal(
          database.prepare(`
            SELECT COUNT(*) AS count
            FROM league_activity
            WHERE event_type IN (
              'free_agent_draft_week1_recovered',
              'free_agent_draft_completed'
            )
          `).get().count,
          0
        );
        assert.equal(
          database.prepare(`
            SELECT COUNT(*) AS count
            FROM notifications
            WHERE event_type IN (
              'fad_week1_recovered', 'fad_completed'
            )
          `).get().count,
          0
        );
        assert.deepEqual(
          database.prepare(`
            SELECT status, last_error_code
            FROM job_runs WHERE id = ?
          `).get(IDS.completionJob),
          {
            status: "running",
            last_error_code: null,
          }
        );
        assert.equal(
          database.prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_recoveries
            WHERE fad_id = ?
              AND kind = 'completion'
          `).get(IDS.fad).count,
          0
        );
      });
    }
  });

  test("completes allocation-null direct and queued auction evidence through an extension before ordinary-auction handoff", (t) => {
    const {
      database,
      lifecycleRepository,
      writer,
    } = fixture(t, { realRecovery: true });
    seedOpenCompletionAuctionBlockers(database);
    const ordinaryRepository =
      createSqliteAuctionRepository({ database });

    assert.deepEqual(
      writer.listCandidates({
        nowMs: EXTENDED_COMPLETED_AT_MS,
        limit: 10,
      }),
      []
    );
    assert.throws(
      () =>
        ordinaryRepository.startAuction(
          ordinaryAuctionCommand()
        ),
      (error) =>
        error instanceof AuctionCreationPolicyError &&
        error.reasonCode ===
          AUCTION_CREATION_CODES.seasonUnavailable
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM auctions AS auction
        JOIN auction_contexts AS context
          ON context.league_id = auction.league_id
         AND context.season_id = auction.season_id
         AND context.auction_id = auction.id
        WHERE auction.player_id = ?
          AND auction.status = 'open'
          AND context.source_kind = 'fad_open_rapid'
          AND context.fad_allocation_id IS NULL
      `).get(IDS.directPlayer).count,
      1
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM idempotency_requests
        WHERE operation = 'auction.start'
      `).get().count,
      0
    );

    finalizeCompletionAuctionEvidence(database);
    const candidates = writer.listCandidates({
      nowMs: EXTENDED_COMPLETED_AT_MS,
      limit: 10,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].fadId, IDS.fad);
    assert.deepEqual(
      database.prepare(`
        SELECT context.fad_origin,
               context.fad_allocation_id,
               auction.status
        FROM auction_contexts AS context
        JOIN auctions AS auction
          ON auction.league_id = context.league_id
         AND auction.season_id = context.season_id
         AND auction.id = context.auction_id
        WHERE context.fad_id = ?
        ORDER BY context.fad_origin
      `).all(IDS.fad),
      [
        {
          fad_origin: "manager_nomination",
          fad_allocation_id: null,
          status: "no_winner",
        },
        {
          fad_origin: "queued_nomination",
          fad_allocation_id: null,
          status: "no_winner",
        },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT nomination.status,
               nomination.resolution_rollover_id,
               nomination.opened_auction_id,
               rollover.sequence,
               rollover.window_kind,
               rollover.status AS rollover_status,
               job.status AS job_status
        FROM free_agent_draft_nomination_queue AS nomination
        JOIN free_agent_draft_rollovers AS rollover
          ON rollover.league_id = nomination.league_id
         AND rollover.id = nomination.resolution_rollover_id
        JOIN job_runs AS job
          ON job.league_id = rollover.league_id
         AND job.id = rollover.processing_job_run_id
        WHERE nomination.id = ?
      `).get(IDS.queuedNomination),
      {
        status: "opened",
        resolution_rollover_id: IDS.extensionRollover,
        opened_auction_id: IDS.queuedAuction,
        sequence: 8,
        window_kind: "extension",
        rollover_status: "completed",
        job_status: "succeeded",
      }
    );

    const claim = claimCompletion(database, {
      nowMs: EXTENDED_COMPLETED_AT_MS,
      leaseExpiresAtMs: EXTENDED_LEASE_EXPIRES_AT_MS,
    });
    assert.equal(claim.acquired, true);
    const command = completionCommand(
      claim.occurrence,
      EXTENDED_COMPLETED_AT_MS
    );
    const completed = writer.executeClaimed(
      command,
      lifecycleRepository
    );
    assert.equal(completed.outcome, "succeeded");
    assert.equal(completed.replayed, false);
    assert.equal(
      completed.completedAtMs,
      EXTENDED_COMPLETED_AT_MS
    );
    assert.match(
      completed.scheduleRecoveryId,
      /^[0-9a-f-]{36}$/u
    );
    assert.deepEqual(
      writer.executeClaimed(command, lifecycleRepository),
      {
        ...completed,
        replayed: true,
      }
    );

    const ordinary = ordinaryRepository.startAuction(
      ordinaryAuctionCommand()
    );
    assert.equal(ordinary.replayed, false);
    assert.equal(ordinary.auction.id, IDS.ordinaryAuction);
    assert.deepEqual(
      database.prepare(`
        SELECT source_kind, fad_id, fad_rollover_id,
               fad_allocation_id, fad_origin
        FROM auction_contexts
        WHERE auction_id = ?
      `).get(IDS.ordinaryAuction),
      {
        source_kind: "ordinary_weekly",
        fad_id: null,
        fad_rollover_id: null,
        fad_allocation_id: null,
        fad_origin: null,
      }
    );
    assert.equal(
      database.prepare(`
        SELECT free_agent_draft_completed_at_ms AS value
        FROM seasons WHERE id = ?
      `).get(IDS.season).value,
      EXTENDED_COMPLETED_AT_MS
    );
  });

  test("atomically recovers Week 1, completes the FAD and season, publishes both notification types, and replays exactly", (t) => {
    const {
      database,
      lifecycleRepository,
      writer,
    } = fixture(t, { realRecovery: true });
    const claim = claimCompletion(database);
    assert.equal(claim.acquired, true);
    const command = completionCommand(
      claim.occurrence
    );

    const completed = writer.executeClaimed(
      command,
      lifecycleRepository
    );

    assert.equal(completed.outcome, "succeeded");
    assert.equal(completed.replayed, false);
    assert.equal(completed.runId, IDS.completionJob);
    assert.equal(completed.completedAtMs, COMPLETED_AT_MS);
    assert.match(completed.scheduleRecoveryId, /^[0-9a-f-]{36}$/);
    assert.equal(completed.activityIds.length, 2);
    assert.equal(completed.notificationIds.length, 4);
    assert.equal(completed.outboxEventIds.length, 8);
    assert.equal(
      completed.competitionFirstMatchupStartsAtMs,
      WEEK_ONE_AT_MS + 7 * FREE_AGENT_DRAFT_DAY_MS
    );

    assert.deepEqual(
      database.prepare(`
        SELECT status, first_matchup_week_id,
               current_competition_first_matchup_week_id,
               first_matchup_starts_at_ms,
               schedule_recovery_id, completed_at_ms
        FROM free_agent_drafts
        WHERE id = ?
      `).get(IDS.fad),
      {
        status: "completed",
        first_matchup_week_id: IDS.weekOne,
        current_competition_first_matchup_week_id:
          database.prepare(`
            SELECT week_one_matchup_week_id
            FROM season_matchup_schedule_generations
            WHERE league_id = ? AND season_id = ?
              AND status = 'current'
          `).get(IDS.league, IDS.season)
            .week_one_matchup_week_id,
        first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
        schedule_recovery_id:
          completed.scheduleRecoveryId,
        completed_at_ms: COMPLETED_AT_MS,
      }
    );
    assert.equal(
      database.prepare(`
        SELECT free_agent_draft_completed_at_ms AS value
        FROM seasons WHERE id = ?
      `).get(IDS.season).value,
      COMPLETED_AT_MS
    );
    assert.deepEqual(
      database.prepare(`
        SELECT event_type, COUNT(*) AS count
        FROM league_activity
        WHERE event_type IN (
          'free_agent_draft_week1_recovered',
          'free_agent_draft_completed'
        )
        GROUP BY event_type
        ORDER BY event_type
      `).all(),
      [
        {
          event_type: "free_agent_draft_completed",
          count: 1,
        },
        {
          event_type:
            "free_agent_draft_week1_recovered",
          count: 1,
        },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT event_type, user_id, COUNT(*) AS count
        FROM notifications
        WHERE event_type IN (
          'fad_week1_recovered', 'fad_completed'
        )
        GROUP BY event_type, user_id
        ORDER BY event_type, user_id
      `).all(),
      [
        {
          event_type: "fad_completed",
          user_id: IDS.user,
          count: 1,
        },
        {
          event_type: "fad_completed",
          user_id: IDS.secondUser,
          count: 1,
        },
        {
          event_type: "fad_week1_recovered",
          user_id: IDS.user,
          count: 1,
        },
        {
          event_type: "fad_week1_recovered",
          user_id: IDS.secondUser,
          count: 1,
        },
      ].sort(
        (left, right) =>
          left.event_type.localeCompare(
            right.event_type
          ) || left.user_id.localeCompare(right.user_id)
      )
    );
    const publications = database.prepare(`
      SELECT event.*, audience.audience_kind,
             audience.user_id
      FROM outbox_events AS event
      JOIN outbox_event_audiences AS audience
        ON audience.league_id = event.league_id
       AND audience.outbox_event_id = event.id
      WHERE event.id IN (${completed.outboxEventIds
        .map(() => "?")
        .join(", ")})
      ORDER BY event.id
    `).all(...completed.outboxEventIds);
    assert.equal(publications.length, 8);
    for (const publication of publications) {
      const payload = JSON.parse(publication.payload_json);
      assert.equal(payload.eventId, publication.id);
      assert.equal(payload.type, publication.event_type);
      assert.equal(payload.leagueId, IDS.league);
      assert.equal(payload.resourceId, publication.aggregate_id);
      assert.equal(payload.occurredAt, COMPLETED_AT_MS);
      assert.equal(payload.related.fadId, IDS.fad);
      assert.equal(Object.keys(payload.related).length, 8);
      assert.equal(
        ["completed", "week1_recovered"].includes(
          payload.reasonCode
        ),
        true
      );
      assert.equal(
        publication.audience_kind,
        publication.event_type === "notification.created"
          ? "user"
          : "league"
      );
    }
    const countsBeforeReplay = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM league_activity) AS activities,
        (SELECT COUNT(*) FROM notifications) AS notifications,
        (SELECT COUNT(*) FROM outbox_events) AS outbox
    `).get();
    const replayed = writer.executeClaimed(
      command,
      lifecycleRepository
    );
    assert.deepEqual(replayed, {
      ...completed,
      replayed: true,
    });
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM league_activity) AS activities,
          (SELECT COUNT(*) FROM notifications) AS notifications,
          (SELECT COUNT(*) FROM outbox_events) AS outbox
      `).get(),
      countsBeforeReplay
    );
  });

  test("leaves an already-future Week 1 and its prior recovery link untouched while publishing completion only", (t) => {
    const runtime = fixture(t, {
      realRecovery: true,
    });
    const priorPlan =
      installPriorScheduleRecovery(runtime);
    const claim = claimCompletion(runtime.database);
    assert.equal(claim.acquired, true);
    const command = completionCommand(
      claim.occurrence
    );

    const completed = runtime.writer.executeClaimed(
      command,
      runtime.lifecycleRepository
    );

    assert.equal(completed.outcome, "succeeded");
    assert.equal(completed.replayed, false);
    assert.equal(completed.scheduleRecoveryId, null);
    assert.equal(completed.activityIds.length, 1);
    assert.equal(completed.notificationIds.length, 2);
    assert.equal(completed.outboxEventIds.length, 4);
    assert.equal(
      completed.competitionFirstMatchupStartsAtMs,
      priorPlan.recovery.newWeekOneStartsAtMs
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, first_matchup_week_id,
               current_competition_first_matchup_week_id,
               first_matchup_starts_at_ms,
               schedule_recovery_id, completed_at_ms
        FROM free_agent_drafts WHERE id = ?
      `).get(IDS.fad),
      {
        status: "completed",
        first_matchup_week_id: IDS.weekOne,
        current_competition_first_matchup_week_id:
          priorPlan.recovery.newFirstMatchupWeekId,
        first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
        schedule_recovery_id:
          priorPlan.recovery.id,
        completed_at_ms: COMPLETED_AT_MS,
      }
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT event_type, COUNT(*) AS count
        FROM league_activity
        WHERE event_type IN (
          'free_agent_draft_week1_recovered',
          'free_agent_draft_completed'
        )
        GROUP BY event_type
      `).all(),
      [
        {
          event_type: "free_agent_draft_completed",
          count: 1,
        },
      ]
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT event_type, COUNT(*) AS count
        FROM notifications
        WHERE event_type IN (
          'fad_week1_recovered', 'fad_completed'
        )
        GROUP BY event_type
      `).all(),
      [
        {
          event_type: "fad_completed",
          count: 2,
        },
      ]
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_schedule_recoveries
        WHERE fad_id = ?
      `).get(IDS.fad).count,
      1
    );
    const replayed = runtime.writer.executeClaimed(
      command,
      runtime.lifecycleRepository
    );
    assert.deepEqual(replayed, {
      ...completed,
      replayed: true,
    });
  });
});
