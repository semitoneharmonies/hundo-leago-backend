const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  FINAL_FRESHNESS_WINDOW_MS,
  MATCHUP_RESULT_CODES,
  deriveMatchupOutcome,
  evaluateFinalSource,
  validateResultCorrection,
} = require("../../src/domain/matchups/matchupResultPolicy");
const {
  MATCHUP_RESULT_SERVICE_CODES,
  createMatchupResultService,
} = require("../../src/application/services/matchups/createMatchupResultService");
const {
  buildMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  createPlayerGameCoverageSetEvidence,
} = require("../../src/domain/statistics/playerGameCoveragePolicy");
const {
  createPlayerGameObservationSetEvidence,
} = require("../../src/domain/statistics/playerGameStatisticsPolicy");
const {
  createMatchupScoringService,
} = require("../../src/application/services/matchups/createMatchupScoringService");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupResultRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupResultRepository");
const {
  createSqliteMatchupScoringRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupScoringRepository");
const {
  MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS,
  classifyMatchupOccurrenceExecutionGuardError,
  createSqliteMatchupOccurrenceExecutionGuard,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupOccurrenceExecutionGuard");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const HOUR_MS = 60 * 60 * 1000;
const END_MS = 1000 * HOUR_MS;
const NOW_MS = END_MS + HOUR_MS;
const LEASE_OWNER = "matchup-result-generation-test";
const LEASE_TOKEN = "matchup-result-generation-lease-token";
const LEASE_EXPIRES_AT_MS = NOW_MS + HOUR_MS;
const IDS = Object.freeze({
  commissioner: uuid(1), outsider: uuid(2), membership: uuid(3), league: uuid(4),
  season: uuid(5), week: uuid(6), home: uuid(7), away: uuid(8), matchup: uuid(9),
  player: uuid(10), source: uuid(11), baselineRefresh: uuid(12), finalRefresh: uuid(13),
  baselineTotal: uuid(14), finalTotal: uuid(15), baselineSnapshot: uuid(16),
  snapshotPlayer: uuid(17), homeLock: uuid(18), homeLockPlayer: uuid(19), awayLock: uuid(20),
  readiness: uuid(21), fad: uuid(22), scheduleA: uuid(23), scheduleB: uuid(24),
  runA: uuid(25), bindingA: uuid(26), coverageEntry: uuid(27), playerGameSet: uuid(28),
  manager: uuid(29), managerMembership: uuid(30), homeAssignment: uuid(31),
  awayAssignment: uuid(32),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function insertUser(database, id, name) {
  database.prepare(
    "INSERT INTO users (id, email_normalized, email_display, display_name, display_name_normalized, " +
      "status, created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 1)"
  ).run(id, `${name}@example.test`, `${name}@example.test`, name, name);
}

function seed(database, finalCompletedAtMs) {
  insertUser(database, IDS.commissioner, "commissioner");
  insertUser(database, IDS.outsider, "outsider");
  insertUser(database, IDS.manager, "manager");
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Result League', 'result league', 'active', 'America/Vancouver', 1, 1, 1)"
  ).run(IDS.league);
  database.prepare(
    "INSERT INTO league_memberships (id, league_id, user_id, permission_category, status, joined_at_ms, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'commissioner', 'active', 1, 1, 1, 1)"
  ).run(IDS.membership, IDS.league, IDS.commissioner);
  database.prepare(
    "INSERT INTO league_memberships (id, league_id, user_id, permission_category, status, joined_at_ms, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'manager', 'active', 1, 1, 1, 1)"
  ).run(IDS.managerMembership, IDS.league, IDS.manager);
  database.prepare(
    "UPDATE leagues SET commissioner_membership_id = ?, updated_at_ms = 2, version = 2 WHERE id = ?"
  ).run(IDS.membership, IDS.league);
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
  database.prepare(
    "UPDATE leagues SET current_season_id = ?, updated_at_ms = 3, version = version + 1 WHERE id = ?"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  );
  insertTeam.run(IDS.home, IDS.league, "Home", "home");
  insertTeam.run(IDS.away, IDS.league, "Away", "away");
  const insertAssignment = database.prepare(
    "INSERT INTO team_manager_assignments (id, league_id, team_id, user_id, membership_id, " +
      "assigned_by_user_id, replaces_assignment_id, status, assigned_at_ms, accepted_at_ms, " +
      "ended_at_ms, version) VALUES (?, ?, ?, ?, ?, ?, NULL, 'accepted', 1, 1, NULL, 1)"
  );
  insertAssignment.run(
    IDS.homeAssignment,
    IDS.league,
    IDS.home,
    IDS.commissioner,
    IDS.membership,
    IDS.commissioner
  );
  insertAssignment.run(
    IDS.awayAssignment,
    IDS.league,
    IDS.away,
    IDS.manager,
    IDS.managerMembership,
    IDS.commissioner
  );
  database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, ?, ?, ?, ?, ?, 'awaiting_data', 1, 1, 4)"
  ).run(IDS.week, IDS.league, IDS.season, END_MS - 7 * 24 * HOUR_MS, END_MS - 7 * 24 * HOUR_MS + HOUR_MS, END_MS - 7 * 24 * HOUR_MS + 16 * HOUR_MS, END_MS, END_MS);
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'awaiting_data', 1, 1, 3)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.home, IDS.away);
  database.prepare(
    "INSERT INTO players (id, first_name, last_name, full_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Final', 'Player', 'Final Player', 'active', 1, 1, 1)"
  ).run(IDS.player);
  database.prepare(
    "INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'nhl', 'active', 1, 1, 1)"
  ).run(IDS.source);
  const insertRefresh = database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, version) VALUES (?, ?, '20262027', ?, 'succeeded', ?, ?, 1, 1)"
  );
  insertRefresh.run(IDS.baselineRefresh, IDS.source, "baseline", END_MS - 7 * 24 * HOUR_MS, END_MS - 7 * 24 * HOUR_MS + HOUR_MS);
  insertRefresh.run(IDS.finalRefresh, IDS.source, "final", finalCompletedAtMs - 1, finalCompletedAtMs);
  const insertTotal = database.prepare(
    "INSERT INTO player_stat_totals (id, stat_source_id, refresh_id, nhl_season_key, player_id, games_played, " +
      "goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (?, ?, ?, '20262027', ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertTotal.run(IDS.baselineTotal, IDS.source, IDS.baselineRefresh, IDS.player, 10, 1, 1, 2, 225, END_MS - 7 * 24 * HOUR_MS + HOUR_MS, END_MS - 7 * 24 * HOUR_MS + HOUR_MS);
  insertTotal.run(IDS.finalTotal, IDS.source, IDS.finalRefresh, IDS.player, 12, 2, 3, 5, 550, finalCompletedAtMs, finalCompletedAtMs);
  const requiredPlayers = Object.freeze([Object.freeze({
    playerId: IDS.player,
    providerPlayerId: "10010",
  })]);
  const coverage = Object.freeze([Object.freeze({
    coverageEntryId: IDS.coverageEntry,
    playerId: IDS.player,
    providerPlayerId: "10010",
    providerTeamId: null,
    disposition: "no_team",
    nhlGameId: null,
    nhlGameScheduledStartsAtMs: null,
  })]);
  const coverageEvidence = createPlayerGameCoverageSetEvidence({
    setId: IDS.playerGameSet,
    statSourceId: IDS.source,
    refreshId: IDS.finalRefresh,
    nhlSeasonKey: "20262027",
    provider: "nhl",
    sourceVersion: "final",
    capturedAtMs: finalCompletedAtMs,
    requiredPlayers,
    coverage,
  });
  const observationEvidence = createPlayerGameObservationSetEvidence({
    setId: IDS.playerGameSet,
    statSourceId: IDS.source,
    refreshId: IDS.finalRefresh,
    nhlSeasonKey: "20262027",
    provider: "nhl",
    sourceVersion: "final",
    capturedAtMs: finalCompletedAtMs,
    observations: [],
  });
  database.transaction(() => {
    database.prepare(
      "INSERT INTO stat_refresh_player_game_coverage_entries (id, stat_source_id, refresh_id, " +
        "observation_set_id, nhl_season_key, player_id, provider_player_id, provider_team_id, " +
        "disposition, nhl_game_id, nhl_game_scheduled_starts_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, '20262027', ?, '10010', NULL, 'no_team', NULL, NULL, ?, 1)"
    ).run(
      IDS.coverageEntry,
      IDS.source,
      IDS.finalRefresh,
      IDS.playerGameSet,
      IDS.player,
      finalCompletedAtMs
    );
    database.prepare(
      "INSERT INTO stat_refresh_player_game_sets (id, stat_source_id, refresh_id, nhl_season_key, " +
        "provider, source_version, captured_at_ms, required_player_count, coverage_entry_count, " +
        "expected_player_game_count, coverage_schema_version, coverage_sha256, observation_count, " +
        "evidence_schema_version, evidence_sha256, created_at_ms, version) " +
        "VALUES (?, ?, ?, '20262027', 'nhl', 'final', ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, 1)"
    ).run(
      IDS.playerGameSet,
      IDS.source,
      IDS.finalRefresh,
      finalCompletedAtMs,
      coverageEvidence.requiredPlayerCount,
      coverageEvidence.coverageEntryCount,
      coverageEvidence.expectedPlayerGameCount,
      coverageEvidence.coverageSha256,
      observationEvidence.observationCount,
      observationEvidence.evidenceSha256,
      finalCompletedAtMs
    );
  })();
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_baseline', 'complete', 'fresh', ?, 1, ?)"
  ).run(IDS.baselineSnapshot, IDS.source, IDS.baselineRefresh, IDS.league, IDS.season, IDS.week, END_MS - 7 * 24 * HOUR_MS + HOUR_MS, END_MS - 7 * 24 * HOUR_MS + HOUR_MS);
  database.prepare(
    "INSERT INTO stat_snapshot_players (id, league_id, stat_snapshot_id, player_id, games_played, goals, assists, " +
      "nhl_points, fantasy_points_hundredths, created_at_ms) VALUES (?, ?, ?, ?, 10, 1, 1, 2, 225, ?)"
  ).run(IDS.snapshotPlayer, IDS.league, IDS.baselineSnapshot, IDS.player, END_MS - 7 * 24 * HOUR_MS + HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 1, NULL, ?, ?, 'fresh', ?, 1)"
  ).run(IDS.homeLock, IDS.league, IDS.season, IDS.week, IDS.home, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS, IDS.baselineSnapshot, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_players (id, league_id, season_id, matchup_roster_lock_id, player_id, position_group, " +
      "slot_number, baseline_games_played, baseline_goals, baseline_assists, baseline_fantasy_points_hundredths, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, 'F', 1, 10, 1, 1, 225, ?)"
  ).run(IDS.homeLockPlayer, IDS.league, IDS.season, IDS.homeLock, IDS.player, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 0, 'ACTIVE_FORWARD_SLOTS_INCOMPLETE', ?, NULL, 'unknown', ?, 1)"
  ).run(IDS.awayLock, IDS.league, IDS.season, IDS.week, IDS.away, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS, END_MS - 6 * 24 * HOUR_MS - 8 * HOUR_MS);
}

function insertScheduleOperation(database, operationId, startedAtMs, completedAtMs) {
  database.prepare(`
    INSERT INTO matchup_operations (
      id,
      league_id,
      season_id,
      matchup_week_id,
      matchup_id,
      actor_user_id,
      operation_type,
      status,
      reason,
      metadata_json,
      started_at_ms,
      completed_at_ms
    ) VALUES (?, ?, ?, NULL, NULL, ?, 'schedule_generate',
      'succeeded', NULL, NULL, ?, ?)
  `).run(
    operationId,
    IDS.league,
    IDS.season,
    IDS.commissioner,
    startedAtMs,
    completedAtMs
  );
}

function seedCompletedFadGate(database) {
  const startsAtMs = END_MS - 7 * 24 * HOUR_MS;
  const candidateDeadlineAtMs = startsAtMs - 7 * 24 * HOUR_MS;
  const openedAtMs = candidateDeadlineAtMs - HOUR_MS;
  const completedAtMs = startsAtMs - 1;
  database.prepare(`
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
    ) VALUES (?, ?, ?, 'fad-readiness:matchup-result',
      'no_draft_inaugural', NULL, NULL, NULL, 'running', 1,
      NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, ?, NULL, NULL, ?, ?, 1)
  `).run(
    IDS.readiness,
    IDS.league,
    IDS.season,
    openedAtMs,
    openedAtMs,
    openedAtMs
  );
  database.prepare(`
    INSERT INTO free_agent_drafts (
      id,
      league_id,
      season_id,
      readiness_operation_id,
      readiness_occurrence_key,
      first_matchup_week_id,
      current_competition_first_matchup_week_id,
      schedule_recovery_id,
      participating_team_count,
      status,
      setup_path,
      entry_draft_id,
      setup_exemption_id,
      prior_season_rollover_id,
      no_draft_reason,
      opening_authority,
      opened_at_ms,
      help_opens_at_ms,
      candidate_deadline_at_ms,
      first_matchup_starts_at_ms,
      deadline_locked_at_ms,
      allocation_completed_at_ms,
      completed_at_ms,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (?, ?, ?, ?, 'fad-readiness:matchup-result', ?, ?, NULL,
      2, 'cards_open', 'no_draft_inaugural', NULL, NULL, NULL,
      'inaugural matchup-result fixture', 'system', ?, ?, ?, ?, NULL,
      NULL, NULL, ?, ?, 1)
  `).run(
    IDS.fad,
    IDS.league,
    IDS.season,
    IDS.readiness,
    IDS.week,
    IDS.week,
    openedAtMs,
    openedAtMs,
    candidateDeadlineAtMs,
    startsAtMs,
    openedAtMs,
    openedAtMs
  );
  database.exec("DROP TRIGGER free_agent_drafts_forward_update");
  database.prepare(`
    UPDATE free_agent_drafts
    SET status = 'completed',
        deadline_locked_at_ms = ?,
        allocation_completed_at_ms = ?,
        completed_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ?
      AND id = ?
  `).run(
    candidateDeadlineAtMs,
    candidateDeadlineAtMs + 1,
    completedAtMs,
    completedAtMs,
    IDS.league,
    IDS.fad
  );
  database.prepare(`
    UPDATE seasons
    SET free_agent_draft_completed_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ?
      AND id = ?
  `).run(
    completedAtMs,
    completedAtMs,
    IDS.league,
    IDS.season
  );
}

function seedGenerationSafetyState(database) {
  insertScheduleOperation(database, IDS.scheduleA, 3, 4);
  database.prepare(`
    INSERT INTO season_matchup_schedule_generations (
      league_id,
      season_id,
      schedule_version,
      schedule_operation_id,
      week_one_matchup_week_id,
      week_one_starts_at_ms,
      status,
      created_at_ms,
      superseded_at_ms,
      version
    ) VALUES (?, ?, 1, ?, ?, ?, 'current', 4, NULL, 1)
  `).run(
    IDS.league,
    IDS.season,
    IDS.scheduleA,
    IDS.week,
    END_MS - 7 * 24 * HOUR_MS
  );
  seedCompletedFadGate(database);
  const jobType = "matchup:finalize";
  const occurrenceKey = buildMatchupOccurrenceKey({
    jobType,
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    scheduleOperationId: IDS.scheduleA,
    scheduleVersion: 1,
    scheduledForMs: END_MS,
  });
  database.prepare(`
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
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, ?,
      NULL, NULL, NULL, ?, ?, 2, ?, NULL)
  `).run(
    IDS.runA,
    IDS.league,
    IDS.season,
    jobType,
    occurrenceKey,
    END_MS,
    LEASE_OWNER,
    LEASE_EXPIRES_AT_MS,
    END_MS,
    END_MS,
    END_MS,
    LEASE_TOKEN
  );
  database.prepare(`
    INSERT INTO matchup_schedule_job_bindings (
      id,
      league_id,
      season_id,
      job_run_id,
      job_type,
      schedule_operation_id,
      schedule_version,
      owning_matchup_week_id,
      owning_matchup_id,
      created_at_ms,
      version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, 1)
  `).run(
    IDS.bindingA,
    IDS.league,
    IDS.season,
    IDS.runA,
    jobType,
    IDS.scheduleA,
    IDS.week,
    END_MS
  );
  return Object.freeze({
    bindingId: IDS.bindingA,
    claimedJobVersion: 2,
    jobType,
    leagueId: IDS.league,
    leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    leaseOwner: LEASE_OWNER,
    leaseToken: LEASE_TOKEN,
    occurrenceKey,
    runId: IDS.runA,
    scheduleOperationId: IDS.scheduleA,
    scheduleVersion: 1,
    scheduledForMs: END_MS,
    seasonId: IDS.season,
    weekId: IDS.week,
  });
}

function supersedeGeneration(database) {
  const changedAtMs = END_MS + 1;
  const transaction = database.transaction(() => {
    assert.equal(database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET status = 'superseded',
          superseded_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND season_id = ?
        AND schedule_operation_id = ?
        AND status = 'current'
    `).run(
      changedAtMs,
      IDS.league,
      IDS.season,
      IDS.scheduleA
    ).changes, 1);
    insertScheduleOperation(
      database,
      IDS.scheduleB,
      changedAtMs,
      changedAtMs + 1
    );
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id,
        season_id,
        schedule_version,
        schedule_operation_id,
        week_one_matchup_week_id,
        week_one_starts_at_ms,
        status,
        created_at_ms,
        superseded_at_ms,
        version
      ) VALUES (?, ?, 2, ?, ?, ?, 'current', ?, NULL, 1)
    `).run(
      IDS.league,
      IDS.season,
      IDS.scheduleB,
      IDS.week,
      END_MS - 7 * 24 * HOUR_MS,
      changedAtMs + 1
    );
  });
  transaction.immediate();
}

function createRuntime(t, { finalCompletedAtMs = END_MS, fail = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-07-"));
  const connection = openDatabase({
    databasePath: path.join(root, "results.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-07-test",
    now: () => 1,
  });
  seed(connection.database, finalCompletedAtMs);
  const scoringService = createMatchupScoringService({
    repository: createSqliteMatchupScoringRepository({ database: connection.database }),
  });
  const repository = createSqliteMatchupResultRepository({
    database: connection.database,
    beforeCommit() {
      if (fail()) throw new Error("late result failure");
    },
  });
  let nextId = 500;
  const service = createMatchupResultService({ repository, scoringService, createId: () => uuid(nextId++) });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database: connection.database, service };
}

function createGenerationRuntime(
  t,
  { afterScore = () => {} } = {}
) {
  const base = createRuntime(t);
  const execution = seedGenerationSafetyState(base.database);
  const realGuard = createSqliteMatchupOccurrenceExecutionGuard({
    database: base.database,
  });
  const guardCalls = [];
  const occurrenceExecutionGuard = Object.freeze({
    assertCurrent(context) {
      guardCalls.push(context);
      return realGuard.assertCurrent(context);
    },
  });
  const realScoringService = createMatchupScoringService({
    repository: createSqliteMatchupScoringRepository({
      database: base.database,
    }),
  });
  const scoringService = Object.freeze({
    readLive(input) {
      const result = realScoringService.readLive(input);
      afterScore({
        database: base.database,
        execution,
        input,
      });
      return result;
    },
  });
  const repository = createSqliteMatchupResultRepository({
    database: base.database,
    occurrenceExecutionGuard,
  });
  let nextId = 900;
  const service = createMatchupResultService({
    repository,
    scoringService,
    createId: () => uuid(nextId++),
  });
  return {
    ...base,
    execution,
    guardCalls,
    repository,
    service,
  };
}

function resultState(database) {
  return Object.freeze({
    finalSnapshotCount: database.prepare(
      "SELECT COUNT(*) AS count FROM stat_snapshots WHERE intended_use = 'matchup_final'"
    ).get().count,
    finalizeOperationCount: database.prepare(
      "SELECT COUNT(*) AS count FROM matchup_operations WHERE operation_type = 'result_finalize'"
    ).get().count,
    matchup: database.prepare(
      "SELECT status, version FROM matchups WHERE id = ?"
    ).get(IDS.matchup),
    resultCount: database.prepare(
      "SELECT COUNT(*) AS count FROM matchup_results"
    ).get().count,
    resultVersionCount: database.prepare(
      "SELECT COUNT(*) AS count FROM matchup_result_versions"
    ).get().count,
    week: database.prepare(
      "SELECT status, version FROM matchup_weeks WHERE id = ?"
    ).get(IDS.week),
  });
}

function captureGuardError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the guarded matchup result to fail.");
}

function input(operationId = uuid(400), nowMs = NOW_MS) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    matchupId: IDS.matchup,
    provider: "nhl",
    operationId,
    nowMs,
  };
}

describe("M6-07 matchup result policy", () => {
  test("derives exact outcomes and post-end freshness readiness", () => {
    assert.equal(deriveMatchupOutcome(100, 100), "tie");
    assert.equal(deriveMatchupOutcome(101, 100), "home_win");
    assert.equal(deriveMatchupOutcome(100, 101), "away_win");
    assert.equal(evaluateFinalSource({ weekEndsAtMs: END_MS, refreshCompletedAtMs: END_MS - 1, nowMs: NOW_MS }).ready, false);
    assert.equal(evaluateFinalSource({ weekEndsAtMs: END_MS, refreshCompletedAtMs: END_MS, nowMs: END_MS + FINAL_FRESHNESS_WINDOW_MS }).ready, true);
    assert.equal(evaluateFinalSource({ weekEndsAtMs: END_MS, refreshCompletedAtMs: END_MS, nowMs: END_MS + FINAL_FRESHNESS_WINDOW_MS + 1 }).ready, false);
  });

  test("requires bounded explicit correction scores and reason", () => {
    assert.deepEqual(
      validateResultCorrection({ homeScoreHundredths: 0, awayScoreHundredths: 100, reason: "Official stat correction" }),
      { homeScoreHundredths: 0, awayScoreHundredths: 100, outcome: "away_win", reason: "Official stat correction" }
    );
    assert.throws(
      () => validateResultCorrection({ homeScoreHundredths: 0, awayScoreHundredths: 0, reason: "" }),
      { code: MATCHUP_RESULT_CODES.correctionInvalid }
    );
  });
});

describe("M6-07 atomic finalization and append-only correction", () => {
  test("waits without writes when the latest successful source predates week end", (t) => {
    const { database, service } = createRuntime(t, { finalCompletedAtMs: END_MS - 1 });
    const result = service.finalize(input());
    assert.equal(result.finalized, false);
    assert.equal(result.waiting.reasonCode, "SOURCE_BEFORE_WEEK_END");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_results").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_operations").get().count, 0);
  });

  test("finalizes once, versions a correction, and preserves prior evidence", (t) => {
    const { database, service } = createRuntime(t);
    const finalized = service.finalize(input());
    assert.equal(finalized.finalized, true);
    assert.equal(finalized.context.result.status, "official");
    assert.equal(finalized.context.versions[0].home_score_hundredths, 325);
    assert.equal(finalized.context.versions[0].away_score_hundredths, 0);
    assert.equal(finalized.context.versions[0].outcome, "home_win");
    assert.equal(database.prepare("SELECT status FROM matchups").get().status, "final");
    assert.equal(database.prepare("SELECT status FROM matchup_weeks").get().status, "final");
    assert.equal(service.finalize(input()).replayed, true);

    const corrected = service.correct({
      ...input(uuid(401), NOW_MS + 1),
      actorUserId: IDS.commissioner,
      expectedResultVersion: 1,
      homeScoreHundredths: 0,
      awayScoreHundredths: 100,
      reason: "Official scorer correction",
    });
    assert.equal(corrected.corrected, true);
    assert.equal(corrected.context.result.status, "corrected");
    assert.equal(corrected.context.result.version, 2);
    assert.equal(corrected.context.versions.length, 2);
    assert.equal(corrected.context.versions[0].source_type, "calculated");
    assert.equal(corrected.context.versions[1].source_type, "correction");
    assert.equal(corrected.context.versions[1].actor_user_id, IDS.commissioner);
    assert.equal(corrected.context.versions[1].supersedes_version_id, corrected.context.versions[0].id);
    assert.equal(corrected.context.versions[1].outcome, "away_win");
    assert.equal(service.correct({ ...input(uuid(401), NOW_MS + 1), actorUserId: IDS.commissioner }).replayed, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_result_versions").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("denies noncommissioner and stale corrections without appending", (t) => {
    const { database, service } = createRuntime(t);
    service.finalize(input());
    const correction = {
      ...input(uuid(402), NOW_MS + 1),
      expectedResultVersion: 1,
      homeScoreHundredths: 100,
      awayScoreHundredths: 100,
      reason: "Correction",
    };
    assert.throws(() => service.correct({ ...correction, actorUserId: IDS.outsider }), {
      code: MATCHUP_RESULT_SERVICE_CODES.commissionerRequired,
    });
    assert.throws(() => service.correct({ ...correction, actorUserId: IDS.commissioner, expectedResultVersion: 99 }), {
      code: "REPOSITORY_VERSION_CONFLICT",
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_result_versions").get().count, 1);
  });

  test("records a correction by a previously authorized platform administrator", (t) => {
    const { database, service } = createRuntime(t);
    service.finalize(input());

    const corrected = service.correct({
      ...input(uuid(403), NOW_MS + 1),
      actorUserId: IDS.outsider,
      authorizedAsPlatformAdministrator: true,
      expectedResultVersion: 1,
      homeScoreHundredths: 100,
      awayScoreHundredths: 200,
      reason: "Platform administrator correction",
    });

    assert.equal(corrected.corrected, true);
    assert.equal(corrected.context.versions[1].actor_user_id, IDS.outsider);
  });

  test("rolls every finalization effect back after a late failure", (t) => {
    let fail = true;
    const { database, service } = createRuntime(t, { fail: () => fail });
    assert.throws(() => service.finalize(input()));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_results").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM stat_snapshots WHERE intended_use = 'matchup_final'").get().count, 0);
    assert.equal(database.prepare("SELECT status FROM matchups").get().status, "awaiting_data");
    assert.equal(database.prepare("SELECT status FROM matchup_weeks").get().status, "awaiting_data");
    fail = false;
    assert.equal(service.finalize(input()).finalized, true);
  });
});

describe("FAD-05 generation-safe matchup result finalization", () => {
  test("forwards the exact occurrence execution and finalizes only the current generation", (t) => {
    const {
      database,
      execution,
      guardCalls,
      service,
    } = createGenerationRuntime(t);
    const result = service.finalize({
      ...input(uuid(910)),
      occurrenceExecution: execution,
    });

    assert.equal(result.finalized, true);
    assert.equal(result.replayed, false);
    assert.equal(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0], execution);
    assert.deepEqual(resultState(database), {
      finalSnapshotCount: 1,
      finalizeOperationCount: 1,
      matchup: { status: "final", version: 4 },
      resultCount: 1,
      resultVersionCount: 1,
      week: { status: "final", version: 5 },
    });
  });

  test("runs the occurrence guard before the transactional replay read", (t) => {
    const { database, execution, service } = createGenerationRuntime(t);
    const operationId = uuid(911);
    service.finalize({
      ...input(operationId),
      occurrenceExecution: execution,
    });

    const order = [];
    const instrumentedDatabase = {
      prepare(sql) {
        const statement = database.prepare(sql);
        const label = sql.includes("FROM matchup_operations")
          ? "operation_read"
          : sql.includes("FROM matchups")
            ? "context_read"
            : "other_statement";
        return {
          all(...args) {
            order.push(label);
            return statement.all(...args);
          },
          get(...args) {
            order.push(label);
            return statement.get(...args);
          },
          run(...args) {
            order.push(label);
            return statement.run(...args);
          },
        };
      },
      transaction: database.transaction.bind(database),
    };
    const occurrenceExecution = Object.freeze({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
    });
    const repository = createSqliteMatchupResultRepository({
      database: instrumentedDatabase,
      occurrenceExecutionGuard: {
        assertCurrent(context) {
          order.push("guard");
          assert.strictEqual(context, occurrenceExecution);
        },
      },
    });

    const replay = repository.finalize({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      matchupId: IDS.matchup,
      operationId,
      occurrenceExecution,
    });

    assert.equal(replay.result.status, "official");
    assert.deepEqual(order.slice(0, 3), [
      "guard",
      "operation_read",
      "context_read",
    ]);
  });

  test("rejects a superseded generation without an official-result write", (t) => {
    const { database, execution, service } = createGenerationRuntime(t);
    supersedeGeneration(database);
    const before = resultState(database);

    const error = captureGuardError(() => service.finalize({
      ...input(uuid(912)),
      occurrenceExecution: execution,
    }));

    assert.equal(error.code, "REPOSITORY_VERSION_CONFLICT");
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.generationSuperseded
    );
    assert.deepEqual(resultState(database), before);
    assert.equal(database.inTransaction, false);
  });

  test("rejects a lost lease without an official-result write", (t) => {
    const { database, execution, service } = createGenerationRuntime(t);
    database.prepare(`
      UPDATE job_runs
      SET lease_token = 'replacement-matchup-result-token'
      WHERE id = ?
    `).run(IDS.runA);
    const before = resultState(database);

    const error = captureGuardError(() => service.finalize({
      ...input(uuid(913)),
      occurrenceExecution: execution,
    }));

    assert.equal(error.code, "REPOSITORY_VERSION_CONFLICT");
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
    );
    assert.deepEqual(resultState(database), before);
  });

  test("guards an exact replay and leaves its official result untouched after lease loss", (t) => {
    const {
      database,
      execution,
      guardCalls,
      service,
    } = createGenerationRuntime(t);
    const command = {
      ...input(uuid(914)),
      occurrenceExecution: execution,
    };
    assert.equal(service.finalize(command).finalized, true);
    const before = resultState(database);
    database.prepare(`
      UPDATE job_runs
      SET lease_token = 'replacement-matchup-result-replay-token'
      WHERE id = ?
    `).run(IDS.runA);

    const error = captureGuardError(() => service.finalize(command));

    assert.equal(error.code, "REPOSITORY_VERSION_CONFLICT");
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
    );
    assert.equal(guardCalls.length, 2);
    assert.strictEqual(guardCalls[1], execution);
    assert.deepEqual(resultState(database), before);
  });

  test("revalidates ownership after scoring and before the result transaction", (t) => {
    let changed = false;
    const { database, execution, service } = createGenerationRuntime(t, {
      afterScore({ database: scoringDatabase }) {
        if (changed) return;
        changed = true;
        scoringDatabase.prepare(`
          UPDATE job_runs
          SET lease_token = 'replacement-after-result-score-token'
          WHERE id = ?
        `).run(IDS.runA);
      },
    });
    const before = resultState(database);

    const error = captureGuardError(() => service.finalize({
      ...input(uuid(915)),
      occurrenceExecution: execution,
    }));

    assert.equal(error.code, "REPOSITORY_VERSION_CONFLICT");
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
    );
    assert.deepEqual(resultState(database), before);
  });

  test("fails a disappeared guarded replay closed before any result write", (t) => {
    const { database } = createRuntime(t);
    const occurrenceExecution = Object.freeze({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
    });
    const guardedRepository = createSqliteMatchupResultRepository({
      database,
      occurrenceExecutionGuard: {
        assertCurrent(context) {
          assert.strictEqual(context, occurrenceExecution);
        },
      },
    });
    const repository = {
      readContext: guardedRepository.readContext,
      readOperation(command) {
        return Object.freeze({ id: command.operationId });
      },
      finalize: guardedRepository.finalize,
      correct: guardedRepository.correct,
    };
    const service = createMatchupResultService({
      repository,
      scoringService: {
        readLive() {
          assert.fail("A guarded replay must not score again.");
        },
      },
      createId: () => uuid(916),
    });
    const before = resultState(database);

    assert.throws(
      () => service.finalize({
        ...input(uuid(916)),
        occurrenceExecution,
      }),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    assert.deepEqual(resultState(database), before);
  });

  test("requires a valid guard for occurrence writes and rejects cross-generation scope", (t) => {
    const { database, execution, repository } = createGenerationRuntime(t);
    const before = resultState(database);

    assert.throws(
      () => createSqliteMatchupResultRepository({
        database,
        occurrenceExecutionGuard: {},
      }),
      TypeError
    );
    assert.throws(
      () => repository.finalize({
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekId: uuid(999),
        matchupId: IDS.matchup,
        operationId: uuid(917),
        occurrenceExecution: execution,
      }),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    assert.deepEqual(resultState(database), before);

    const noGuardRepository = createSqliteMatchupResultRepository({
      database,
    });
    assert.throws(
      () => noGuardRepository.finalize({
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekId: IDS.week,
        matchupId: IDS.matchup,
        operationId: uuid(918),
        occurrenceExecution: execution,
      }),
      { code: "REPOSITORY_ARGUMENT_INVALID" }
    );
    assert.deepEqual(resultState(database), before);
  });
});
