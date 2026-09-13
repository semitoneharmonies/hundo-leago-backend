const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  MATCHUP_LEGALITY_CODES,
  evaluateMatchupLineupLegality,
} = require("../../src/domain/matchups/matchupLegalityPolicy");
const {
  buildMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  buildLockedPlayerBaselines,
} = require("../../src/domain/matchups/matchupLockPolicy");
const {
  MATCHUP_LATE_LOCK_EVIDENCE_CODES,
} = require("../../src/domain/matchups/matchupLateLockEvidencePolicy");
const {
  createPlayerGameCoverageSetEvidence,
} = require("../../src/domain/statistics/playerGameCoveragePolicy");
const {
  createPlayerGameObservationSetEvidence,
} = require("../../src/domain/statistics/playerGameStatisticsPolicy");
const {
  MATCHUP_LEGALITY_SERVICE_CODES,
  createMatchupLegalityService,
} = require("../../src/application/services/matchups/createMatchupLegalityService");
const {
  createMatchupLockService,
} = require("../../src/application/services/matchups/createMatchupLockService");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupLockRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupLockRepository");
const {
  REPOSITORY_ERROR_CODES,
} = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");
const {
  MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS,
  classifyMatchupOccurrenceExecutionGuardError,
  createSqliteMatchupOccurrenceExecutionGuard,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupOccurrenceExecutionGuard");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const HOUR_MS = 60 * 60 * 1000;
const START_MS = 2_000_000_000;
const BASELINE_MS = START_MS + HOUR_MS;
const LOCK_MS = START_MS + 16 * HOUR_MS;
const LATE_MS = LOCK_MS + HOUR_MS;
const END_MS = START_MS + 7 * 24 * HOUR_MS;
const IDS = Object.freeze({
  league: uuid(1), season: uuid(2), week: uuid(3), home: uuid(4), away: uuid(5),
  matchup: uuid(6), source: uuid(7), refresh: uuid(8), opponentSnapshot: uuid(9),
  opponentLock: uuid(10), homeLock: uuid(11), playerGameSet: uuid(12),
  homeUser: uuid(13), awayUser: uuid(14), homeMembership: uuid(15),
  awayMembership: uuid(16), homeAssignment: uuid(17), awayAssignment: uuid(18),
  readiness: uuid(19), fad: uuid(20), scheduleA: uuid(21), scheduleB: uuid(22),
  runA: uuid(23), bindingA: uuid(24),
});

const LEASE_OWNER = "matchup-lock-generation-test";
const LEASE_TOKEN = "matchup-lock-generation-lease-token";
const LEASE_EXPIRES_AT_MS = END_MS + 1_000_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function lineup(forwardCount = 12, defenceCount = 6) {
  const players = [];
  for (let slot = 1; slot <= forwardCount; slot += 1) {
    players.push({ player_id: uuid(100 + slot), position_group: "F", slot_number: slot });
  }
  for (let slot = 1; slot <= defenceCount; slot += 1) {
    players.push({ player_id: uuid(200 + slot), position_group: "D", slot_number: slot });
  }
  return players;
}

function seed(
  database,
  refreshCompletedAtMs,
  {
    includePlayerGameEvidence = true,
    playerGameStartsAtMs = LOCK_MS + 30 * 60 * 1000,
    playerGameDisposition = "expected_game",
    omitCoveragePlayerId = null,
  } = {}
) {
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Legality League', 'legality league', 'active', 'America/Vancouver', 1, 1, 1)"
  ).run(IDS.league);
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  );
  insertTeam.run(IDS.home, IDS.league, "Home", "home");
  insertTeam.run(IDS.away, IDS.league, "Away", "away");
  database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, ?, ?, ?, ?, ?, 'live', 1, 1, 2)"
  ).run(IDS.week, IDS.league, IDS.season, START_MS, BASELINE_MS, LOCK_MS, END_MS, END_MS);
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'live', 1, 1, 2)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.home, IDS.away);

  const allPlayers = lineup();
  const insertPlayer = database.prepare(
    "INSERT INTO players (id, first_name, last_name, full_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, 'Player', ?, 'active', 1, 1, 1)"
  );
  const insertOwnership = database.prepare(
    "INSERT INTO player_ownerships (id, league_id, season_id, player_id, team_id, ownership_kind, " +
      "roster_category, position_group, slot_number, acquired_transaction_type, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'Rostered', ?, ?, ?, 'test', 1, 1, 1)"
  );
  allPlayers.forEach((player, index) => {
    insertPlayer.run(player.player_id, `P${index}`, `P${index} Player`);
    const missingForward = player.position_group === "F" && player.slot_number === 12;
    insertOwnership.run(
      uuid(300 + index), IDS.league, IDS.season, player.player_id, IDS.home,
      missingForward ? "Bench" : "Active", player.position_group,
      missingForward ? 1 : player.slot_number
    );
  });
  database.prepare(
    "INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'nhl', 'active', 1, 1, 1)"
  ).run(IDS.source);
  database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, version) VALUES (?, ?, '20262027', 'late-v1', 'succeeded', ?, ?, 18, 1)"
  ).run(IDS.refresh, IDS.source, refreshCompletedAtMs - 1, refreshCompletedAtMs);
  const insertTotal = database.prepare(
    "INSERT INTO player_stat_totals (id, stat_source_id, refresh_id, nhl_season_key, player_id, " +
      "games_played, goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (?, ?, ?, '20262027', ?, 10, ?, 2, ?, ?, ?, ?)"
  );
  allPlayers.forEach((player, index) => {
    const goals = index % 3;
    insertTotal.run(
      uuid(400 + index), IDS.source, IDS.refresh, player.player_id, goals,
      goals + 2, goals * 125 + 200, refreshCompletedAtMs, refreshCompletedAtMs
    );
  });
  if (includePlayerGameEvidence) {
    const coveredPlayers = allPlayers
      .map((player, index) => ({ player, index }))
      .filter(({ player }) => player.player_id !== omitCoveragePlayerId);
    const coverage = coveredPlayers.map(({ player, index }) => ({
      coverageEntryId: uuid(1200 + index),
      playerId: player.player_id,
      providerPlayerId: `provider-player-${index}`,
      providerTeamId:
        playerGameDisposition === "no_team" ? null : "TEST",
      disposition: playerGameDisposition,
      nhlGameId:
        playerGameDisposition === "expected_game"
          ? "2026020001"
          : null,
      nhlGameScheduledStartsAtMs:
        playerGameDisposition === "expected_game"
          ? playerGameStartsAtMs
          : null,
    }));
    const observations = playerGameDisposition === "expected_game"
      ? coveredPlayers.map(({ player, index }) => ({
          observationId: uuid(900 + index),
          playerId: player.player_id,
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: playerGameStartsAtMs,
          observedGameState: "scheduled",
          goals: 0,
          assists: 0,
          nhlPoints: 0,
          fantasyPointsHundredths: 0,
          sourceUpdatedAtMs: refreshCompletedAtMs,
        }))
      : [];
    const coverageEvidence = createPlayerGameCoverageSetEvidence({
      setId: IDS.playerGameSet,
      statSourceId: IDS.source,
      refreshId: IDS.refresh,
      nhlSeasonKey: "20262027",
      provider: "nhl",
      sourceVersion: "late-v1",
      capturedAtMs: refreshCompletedAtMs,
      requiredPlayers: coverage.map((row) => ({
        playerId: row.playerId,
        providerPlayerId: row.providerPlayerId,
      })),
      coverage,
    });
    const observationEvidence =
      createPlayerGameObservationSetEvidence({
        setId: IDS.playerGameSet,
        statSourceId: IDS.source,
        refreshId: IDS.refresh,
        nhlSeasonKey: "20262027",
        provider: "nhl",
        sourceVersion: "late-v1",
        capturedAtMs: refreshCompletedAtMs,
        observations,
      });
    const insertEvidence = database.transaction(() => {
      const insertCoverage = database.prepare(
        "INSERT INTO stat_refresh_player_game_coverage_entries " +
          "(id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, " +
          "player_id, provider_player_id, provider_team_id, disposition, " +
          "nhl_game_id, nhl_game_scheduled_starts_at_ms, created_at_ms, version) " +
          "VALUES (?, ?, ?, ?, '20262027', ?, ?, ?, ?, ?, ?, ?, 1)"
      );
      const insertObservation = database.prepare(
        "INSERT INTO player_game_stat_observations " +
          "(id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, " +
          "player_id, nhl_game_id, nhl_game_scheduled_starts_at_ms, " +
          "observed_game_state, goals, assists, nhl_points, " +
          "fantasy_points_hundredths, source_updated_at_ms, created_at_ms, version) " +
          "VALUES (?, ?, ?, ?, '20262027', ?, '2026020001', ?, 'scheduled', " +
          "0, 0, 0, 0, ?, ?, 1)"
      );
      coverage.forEach((row) => {
        insertCoverage.run(
          row.coverageEntryId,
          IDS.source,
          IDS.refresh,
          IDS.playerGameSet,
          row.playerId,
          row.providerPlayerId,
          row.providerTeamId,
          row.disposition,
          row.nhlGameId,
          row.nhlGameScheduledStartsAtMs,
          refreshCompletedAtMs
        );
      });
      observations.forEach((row) => {
        insertObservation.run(
          row.observationId,
          IDS.source,
          IDS.refresh,
          IDS.playerGameSet,
          row.playerId,
          playerGameStartsAtMs,
          refreshCompletedAtMs,
          refreshCompletedAtMs
        );
      });
      database.prepare(
        "INSERT INTO stat_refresh_player_game_sets " +
          "(id, stat_source_id, refresh_id, nhl_season_key, provider, source_version, " +
          "captured_at_ms, required_player_count, coverage_entry_count, " +
          "expected_player_game_count, coverage_schema_version, coverage_sha256, " +
          "observation_count, evidence_schema_version, evidence_sha256, created_at_ms, " +
          "version) VALUES (?, ?, ?, '20262027', 'nhl', 'late-v1', " +
          "?, ?, ?, ?, 1, ?, ?, 1, ?, ?, 1)"
      ).run(
        IDS.playerGameSet,
        IDS.source,
        IDS.refresh,
        refreshCompletedAtMs,
        coverageEvidence.requiredPlayerCount,
        coverageEvidence.coverageEntryCount,
        coverageEvidence.expectedPlayerGameCount,
        coverageEvidence.coverageSha256,
        observationEvidence.observationCount,
        observationEvidence.evidenceSha256,
        refreshCompletedAtMs
      );
    });
    insertEvidence.immediate();
  }
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_baseline', 'complete', 'fresh', ?, 1, ?)"
  ).run(IDS.opponentSnapshot, IDS.source, IDS.refresh, IDS.league, IDS.season, IDS.week, BASELINE_MS, BASELINE_MS);
  database.prepare(
    "INSERT INTO matchup_roster_locks (id, league_id, season_id, matchup_week_id, team_id, lock_type, legal, " +
      "legality_reason_code, locked_at_ms, baseline_snapshot_id, source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'normal', 1, NULL, ?, ?, 'fresh', ?, 1)"
  ).run(IDS.opponentLock, IDS.league, IDS.season, IDS.week, IDS.away, LOCK_MS, IDS.opponentSnapshot, LOCK_MS);
}

function insertScheduleOperation(
  database,
  operationId,
  startedAtMs,
  completedAtMs
) {
  database.prepare(`
    INSERT INTO matchup_operations (
      id, league_id, season_id, matchup_week_id, matchup_id,
      actor_user_id, operation_type, status, reason, metadata_json,
      started_at_ms, completed_at_ms
    ) VALUES (?, ?, ?, NULL, NULL, ?, 'schedule_generate',
      'succeeded', NULL, NULL, ?, ?)
  `).run(
    operationId,
    IDS.league,
    IDS.season,
    IDS.homeUser,
    startedAtMs,
    completedAtMs
  );
}

function seedOccurrenceAuthority(database) {
  const insertUser = database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms, updated_at_ms,
      version
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 1)
  `);
  insertUser.run(
    IDS.homeUser,
    "home-lock@example.test",
    "home-lock@example.test",
    "Home Lock Manager",
    "home lock manager"
  );
  insertUser.run(
    IDS.awayUser,
    "away-lock@example.test",
    "away-lock@example.test",
    "Away Lock Manager",
    "away lock manager"
  );

  const insertMembership = database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'active', 1, NULL, 1, 1, 1)
  `);
  insertMembership.run(
    IDS.homeMembership,
    IDS.league,
    IDS.homeUser,
    "commissioner"
  );
  insertMembership.run(
    IDS.awayMembership,
    IDS.league,
    IDS.awayUser,
    "manager"
  );

  const insertAssignment = database.prepare(`
    INSERT INTO team_manager_assignments (
      id, league_id, team_id, user_id, membership_id,
      assigned_by_user_id, replaces_assignment_id, status,
      assigned_at_ms, accepted_at_ms, ended_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'accepted', 1, 1, NULL, 1)
  `);
  insertAssignment.run(
    IDS.homeAssignment,
    IDS.league,
    IDS.home,
    IDS.homeUser,
    IDS.homeMembership,
    IDS.homeUser
  );
  insertAssignment.run(
    IDS.awayAssignment,
    IDS.league,
    IDS.away,
    IDS.awayUser,
    IDS.awayMembership,
    IDS.homeUser
  );

  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?, current_season_id = ?,
        updated_at_ms = 2, version = version + 1
    WHERE id = ?
  `).run(IDS.homeMembership, IDS.season, IDS.league);
}

function seedCompletedFadGate(database) {
  const candidateDeadlineAtMs = START_MS - 604_800_000;
  const openedAtMs = candidateDeadlineAtMs - 200_000_000;
  const completedAtMs = START_MS - 1;
  database.prepare(`
    INSERT INTO free_agent_draft_readiness_operations (
      id, league_id, season_id, readiness_occurrence_key, trigger_kind,
      entry_draft_id, setup_exemption_id, job_run_id, status,
      attempt_count, lease_owner, lease_token, lease_expires_at_ms,
      blockers_json, matchup_schedule_version_before,
      matchup_schedule_version_after, schedule_recovery_id,
      created_fad_id, reminder_job_run_id, deadline_job_run_id,
      cards_opened_activity_id, cards_opened_outbox_event_id,
      started_at_ms, next_retry_at_ms, terminal_at_ms, created_at_ms,
      updated_at_ms, version
    ) VALUES (?, ?, ?, 'fad-readiness:matchup-lock',
      'no_draft_inaugural', NULL, NULL, NULL, 'running', 1,
      NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, ?, NULL, NULL, ?, ?, 1)
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
      id, league_id, season_id, readiness_operation_id,
      readiness_occurrence_key, first_matchup_week_id,
      current_competition_first_matchup_week_id, schedule_recovery_id,
      participating_team_count, status, setup_path, entry_draft_id,
      setup_exemption_id, prior_season_rollover_id, no_draft_reason,
      opening_authority, opened_at_ms, help_opens_at_ms,
      candidate_deadline_at_ms, first_matchup_starts_at_ms,
      deadline_locked_at_ms, allocation_completed_at_ms, completed_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'fad-readiness:matchup-lock', ?, ?, NULL,
      2, 'cards_open', 'no_draft_inaugural', NULL, NULL, NULL,
      'inaugural matchup-lock fixture', 'system', ?, ?, ?, ?, NULL,
      NULL, NULL, ?, ?, 1)
  `).run(
    IDS.fad,
    IDS.league,
    IDS.season,
    IDS.readiness,
    IDS.week,
    IDS.week,
    openedAtMs,
    candidateDeadlineAtMs - 172_800_000,
    candidateDeadlineAtMs,
    START_MS,
    openedAtMs,
    openedAtMs
  );

  database.exec("DROP TRIGGER free_agent_drafts_forward_update");
  database.prepare(`
    UPDATE free_agent_drafts
    SET status = 'completed', deadline_locked_at_ms = ?,
        allocation_completed_at_ms = ?, completed_at_ms = ?,
        updated_at_ms = ?, version = version + 1
    WHERE league_id = ? AND id = ?
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
    SET free_agent_draft_completed_at_ms = ?, updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(
    completedAtMs,
    completedAtMs,
    IDS.league,
    IDS.season
  );
}

function seedClaimedLockOccurrence(database) {
  const jobType = "matchup:lock";
  const occurrenceKey = buildMatchupOccurrenceKey({
    jobType,
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    scheduleOperationId: IDS.scheduleA,
    scheduleVersion: 1,
    scheduledForMs: LOCK_MS,
  });
  database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type, occurrence_key,
      scheduled_for_ms, status, attempt_count, lease_owner,
      lease_expires_at_ms, started_at_ms, completed_at_ms, result_json,
      last_error_code, created_at_ms, updated_at_ms, version,
      lease_token, next_attempt_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, ?,
      NULL, NULL, NULL, ?, ?, 2, ?, NULL)
  `).run(
    IDS.runA,
    IDS.league,
    IDS.season,
    jobType,
    occurrenceKey,
    LOCK_MS,
    LEASE_OWNER,
    LEASE_EXPIRES_AT_MS,
    LOCK_MS,
    LOCK_MS - 1,
    LOCK_MS,
    LEASE_TOKEN
  );
  database.prepare(`
    INSERT INTO matchup_schedule_job_bindings (
      id, league_id, season_id, job_run_id, job_type,
      schedule_operation_id, schedule_version, owning_matchup_week_id,
      owning_matchup_id, created_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, 1)
  `).run(
    IDS.bindingA,
    IDS.league,
    IDS.season,
    IDS.runA,
    jobType,
    IDS.scheduleA,
    IDS.week,
    LOCK_MS - 1
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
    scheduledForMs: LOCK_MS,
    seasonId: IDS.season,
    weekId: IDS.week,
  });
}

function seedOccurrenceGuardState(database) {
  seedOccurrenceAuthority(database);
  insertScheduleOperation(
    database,
    IDS.scheduleA,
    START_MS - 2,
    START_MS - 1
  );
  database.prepare(`
    INSERT INTO season_matchup_schedule_generations (
      league_id, season_id, schedule_version, schedule_operation_id,
      week_one_matchup_week_id, week_one_starts_at_ms, status,
      created_at_ms, superseded_at_ms, version
    ) VALUES (?, ?, 1, ?, ?, ?, 'current', ?, NULL, 1)
  `).run(
    IDS.league,
    IDS.season,
    IDS.scheduleA,
    IDS.week,
    START_MS,
    START_MS - 1
  );
  seedCompletedFadGate(database);
  return seedClaimedLockOccurrence(database);
}

function createRuntime(
  t,
  {
    refreshCompletedAtMs = LATE_MS,
    failure = () => false,
    includePlayerGameEvidence = true,
    playerGameStartsAtMs = LOCK_MS + 30 * 60 * 1000,
    playerGameDisposition = "expected_game",
    omitCoveragePlayerId = null,
    guardOccurrence = false,
    gameStateProvider = {
      async fetchGameStates({ requestedAtMs, games }) {
        return {
          provider: "nhl",
          sourceVersion: `games-${requestedAtMs}`,
          observedAtMs: requestedAtMs,
          games: games.map((row) => ({
            ...row,
            observedGameState: "in_progress",
          })),
        };
      },
    },
    nowMs = () => LATE_MS,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-05-"));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "legality.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-05-test",
    now: () => 1,
  });
  seed(connection.database, refreshCompletedAtMs, {
    includePlayerGameEvidence,
    playerGameStartsAtMs,
    playerGameDisposition,
    omitCoveragePlayerId,
  });
  const execution = guardOccurrence
    ? seedOccurrenceGuardState(connection.database)
    : null;
  const guardCalls = [];
  const realOccurrenceExecutionGuard = guardOccurrence
    ? createSqliteMatchupOccurrenceExecutionGuard({
        database: connection.database,
      })
    : null;
  const occurrenceExecutionGuard = guardOccurrence
    ? Object.freeze({
        assertCurrent(context) {
          guardCalls.push(context);
          return realOccurrenceExecutionGuard.assertCurrent(context);
        },
      })
    : undefined;
  const repository = createSqliteMatchupLockRepository({
    database: connection.database,
    occurrenceExecutionGuard,
    beforeCommit() {
      if (failure()) throw new Error("late legality failure");
    },
  });
  let nextId = 600;
  const createId = () => uuid(nextId++);
  const normalLockService = createMatchupLockService({ repository, createId });
  const service = createMatchupLegalityService({
    repository,
    normalLockService,
    gameStateProvider,
    createId,
    nowMs,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return {
    database: connection.database,
    execution,
    guardCalls,
    repository,
    service,
  };
}

function input(nowMs = LOCK_MS) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    teamId: IDS.home,
    provider: "nhl",
    lockId: IDS.homeLock,
    nowMs,
  };
}

function makeLegal(database) {
  database.prepare(
    "UPDATE player_ownerships SET roster_category = 'Active', slot_number = 12, " +
      "updated_at_ms = 2, version = version + 1 WHERE player_id = ?"
  ).run(uuid(112));
}

function insertTotalsOnlyRefresh(
  database,
  {
    refreshId = uuid(3000),
    completedAtMs = LATE_MS,
    sourceVersion = "late-v2-totals-only",
  } = {}
) {
  const insertRefresh = database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, " +
      "status, started_at_ms, completed_at_ms, player_count, version) " +
      "VALUES (?, ?, '20262027', ?, 'succeeded', ?, ?, 18, 1)"
  );
  const insertTotal = database.prepare(
    "INSERT INTO player_stat_totals (id, stat_source_id, refresh_id, nhl_season_key, " +
      "player_id, games_played, goals, assists, nhl_points, " +
      "fantasy_points_hundredths, source_updated_at_ms, created_at_ms) " +
      "VALUES (?, ?, ?, '20262027', ?, 11, 4, 3, 7, 999, ?, ?)"
  );
  const transaction = database.transaction(() => {
    insertRefresh.run(
      refreshId,
      IDS.source,
      sourceVersion,
      completedAtMs - 1,
      completedAtMs
    );
    lineup().forEach((player, index) => {
      insertTotal.run(
        uuid(3100 + index),
        IDS.source,
        refreshId,
        player.player_id,
        completedAtMs,
        completedAtMs
      );
    });
  });
  transaction.immediate();
  return refreshId;
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the guarded matchup-lock operation to fail.");
}

async function captureRejected(callback) {
  try {
    await callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the guarded matchup-lock operation to reject.");
}

function lockEffectState(database) {
  return Object.freeze({
    exclusions: database.prepare(`
      SELECT * FROM matchup_roster_game_exclusions ORDER BY id
    `).all(),
    exclusionSets: database.prepare(`
      SELECT * FROM matchup_roster_game_exclusion_sets ORDER BY id
    `).all(),
    gameObservations: database.prepare(`
      SELECT * FROM nhl_game_state_observations ORDER BY id
    `).all(),
    gameObservationSnapshots: database.prepare(`
      SELECT * FROM nhl_game_state_observation_snapshots ORDER BY id
    `).all(),
    lockedPlayers: database.prepare(`
      SELECT * FROM matchup_roster_players ORDER BY id
    `).all(),
    locks: database.prepare(`
      SELECT * FROM matchup_roster_locks ORDER BY id
    `).all(),
    snapshotPlayers: database.prepare(`
      SELECT * FROM stat_snapshot_players ORDER BY id
    `).all(),
    snapshots: database.prepare(`
      SELECT * FROM stat_snapshots ORDER BY id
    `).all(),
  });
}

function supersedeGeneration(database) {
  const changedAtMs = START_MS + 1;
  const transaction = database.transaction(() => {
    assert.equal(database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET status = 'superseded', superseded_at_ms = ?,
          version = version + 1
      WHERE league_id = ? AND season_id = ?
        AND schedule_operation_id = ? AND status = 'current'
    `).run(
      changedAtMs,
      IDS.league,
      IDS.season,
      IDS.scheduleA
    ).changes, 1);
    insertScheduleOperation(
      database,
      IDS.scheduleB,
      changedAtMs - 1,
      changedAtMs
    );
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id, season_id, schedule_version, schedule_operation_id,
        week_one_matchup_week_id, week_one_starts_at_ms, status,
        created_at_ms, superseded_at_ms, version
      ) VALUES (?, ?, 2, ?, ?, ?, 'current', ?, NULL, 1)
    `).run(
      IDS.league,
      IDS.season,
      IDS.scheduleB,
      IDS.week,
      START_MS,
      changedAtMs
    );
  });
  transaction.immediate();
}

describe("M6-05 matchup lineup legality", () => {
  test("requires every exact forward and defence slot", () => {
    assert.equal(evaluateMatchupLineupLegality(lineup()).legal, true);
    const missingForward = evaluateMatchupLineupLegality(lineup(11, 6));
    assert.equal(missingForward.legal, false);
    assert.equal(missingForward.primaryReasonCode, MATCHUP_LEGALITY_CODES.forwardSlotsIncomplete);
    const missingDefence = evaluateMatchupLineupLegality(lineup(12, 5));
    assert.deepEqual(missingDefence.reasonCodes, [MATCHUP_LEGALITY_CODES.defenceSlotsIncomplete]);
  });
});

describe("M6-05 illegal-at-lock and late legality", () => {
  test("reads the exact matchup and fails closed when a refresh has no sealed player-game root", (t) => {
    const { database, repository } = createRuntime(t, {
      includePlayerGameEvidence: false,
    });
    const before = database.serialize();
    const context = repository.readContext(input());
    assert.equal(context.week.matchup_id, IDS.matchup);
    assert.equal(context.playerGameSet, null);
    assert.deepEqual(context.playerGameObservations, []);
    assert.equal(Object.isFrozen(context.playerGameObservations), true);
    assert.equal(before.equals(database.serialize()), true);
  });

  test("late locks ignore a newer totals-only refresh and use the latest sealed refresh", async (t) => {
    const runtime = createRuntime(t, {
      refreshCompletedAtMs: LATE_MS - 1,
    });
    const totalsOnlyRefreshId = insertTotalsOnlyRefresh(
      runtime.database
    );
    const cumulativeContext = runtime.repository.readContext({
      ...input(LATE_MS),
      baselineCutoffAtMs: LATE_MS,
    });
    const sealedContext = runtime.repository.readContext({
      ...input(LATE_MS),
      baselineCutoffAtMs: LATE_MS,
      requireSealedPlayerGameEvidence: true,
    });
    assert.equal(cumulativeContext.refresh.id, totalsOnlyRefreshId);
    assert.equal(cumulativeContext.playerGameSet, null);
    assert.equal(sealedContext.refresh.id, IDS.refresh);
    assert.equal(sealedContext.playerGameSet.id, IDS.playerGameSet);

    runtime.service.lockAtBoundary(input());
    makeLegal(runtime.database);
    const result = await runtime.service.lockLate(input(LATE_MS));

    assert.equal(result.replayed, false);
    assert.equal(
      runtime.database.prepare(
        "SELECT source_refresh_id FROM stat_snapshots " +
          "WHERE id = (SELECT baseline_snapshot_id " +
          "FROM matchup_roster_locks WHERE id = ?)"
      ).get(IDS.homeLock).source_refresh_id,
      IDS.refresh
    );
  });

  test("terminal affirmative coverage seals zero-child evidence without calling a provider", async (t) => {
    let providerCalls = 0;
    const runtime = createRuntime(t, {
      playerGameDisposition: "no_due_game",
      gameStateProvider: {
        async fetchGameStates() {
          providerCalls += 1;
          throw new Error("terminal coverage must not call the provider");
        },
      },
    });
    runtime.service.lockAtBoundary(input());
    makeLegal(runtime.database);

    const result = await runtime.service.lockLate(input(LATE_MS));

    assert.equal(result.replayed, false);
    assert.equal(result.exclusionSet.exclusion_count, 0);
    assert.equal(providerCalls, 0);
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT source_version, observation_count " +
          "FROM nhl_game_state_observation_snapshots"
      ).get(),
      {
        source_version: `server-empty-game-state:${LATE_MS}`,
        observation_count: 0,
      }
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM nhl_game_state_observations"
      ).get().count,
      0
    );
  });

  test("missing selected coverage fails before the game-state provider", async (t) => {
    let providerCalls = 0;
    const runtime = createRuntime(t, {
      omitCoveragePlayerId: uuid(112),
      gameStateProvider: {
        async fetchGameStates() {
          providerCalls += 1;
          return null;
        },
      },
    });
    runtime.service.lockAtBoundary(input());
    makeLegal(runtime.database);

    await assert.rejects(
      () => runtime.service.lockLate(input(LATE_MS)),
      {
        code:
          MATCHUP_LEGALITY_SERVICE_CODES
            .playerGameStatisticsMissing,
      }
    );
    assert.equal(providerCalls, 0);
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count " +
          "FROM nhl_game_state_observation_snapshots"
      ).get().count,
      0
    );
  });

  test("mixed sealed coverage corruption fails before the game-state provider", async (t) => {
    let providerCalls = 0;
    const runtime = createRuntime(t, {
      gameStateProvider: {
        async fetchGameStates() {
          providerCalls += 1;
          return null;
        },
      },
    });
    runtime.service.lockAtBoundary(input());
    makeLegal(runtime.database);
    runtime.database.prepare(
      "DROP TRIGGER stat_refresh_player_game_coverage_stage_before_set"
    ).run();
    runtime.database.prepare(
      "INSERT INTO stat_refresh_player_game_coverage_entries " +
        "(id, stat_source_id, refresh_id, observation_set_id, nhl_season_key, " +
        "player_id, provider_player_id, provider_team_id, disposition, " +
        "nhl_game_id, nhl_game_scheduled_starts_at_ms, created_at_ms, version) " +
        "VALUES (?, ?, ?, ?, '20262027', ?, 'provider-player-0', 'TEST', " +
        "'no_due_game', NULL, NULL, ?, 1)"
    ).run(
      uuid(3500),
      IDS.source,
      IDS.refresh,
      IDS.playerGameSet,
      uuid(101),
      LATE_MS
    );

    await assert.rejects(
      () => runtime.service.lockLate(input(LATE_MS))
    );
    assert.equal(providerCalls, 0);
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count " +
          "FROM nhl_game_state_observation_snapshots"
      ).get().count,
      0
    );
  });

  test("requires exact provider identity but permits independent source versions", async (t) => {
    await t.test("provider mismatch", async (subtest) => {
      const runtime = createRuntime(subtest, {
        gameStateProvider: {
          async fetchGameStates({ requestedAtMs, games }) {
            return {
              provider: "other-provider",
              sourceVersion: "other-provider-v1",
              observedAtMs: requestedAtMs,
              games: games.map((row) => ({
                ...row,
                observedGameState: "in_progress",
              })),
            };
          },
        },
      });
      runtime.service.lockAtBoundary(input());
      makeLegal(runtime.database);

      await assert.rejects(
        () => runtime.service.lockLate(input(LATE_MS)),
        {
          code:
            MATCHUP_LEGALITY_SERVICE_CODES
              .gameStateProviderMismatch,
        }
      );
      assert.equal(
        runtime.database.prepare(
          "SELECT COUNT(*) AS count " +
            "FROM nhl_game_state_observation_snapshots"
        ).get().count,
        0
      );
    });

    await t.test("independent source versions", async (subtest) => {
      const runtime = createRuntime(subtest, {
        gameStateProvider: {
          async fetchGameStates({ requestedAtMs, games }) {
            return {
              provider: "nhl",
              sourceVersion: "independent-game-state-v99",
              observedAtMs: requestedAtMs,
              games: games.map((row) => ({
                ...row,
                observedGameState: "in_progress",
              })),
            };
          },
        },
      });
      runtime.service.lockAtBoundary(input());
      makeLegal(runtime.database);

      assert.equal(
        (await runtime.service.lockLate(input(LATE_MS))).replayed,
        false
      );
      assert.equal(
        runtime.database.prepare(
          "SELECT source_version " +
            "FROM stat_refresh_player_game_sets"
        ).get().source_version,
        "late-v1"
      );
      assert.equal(
        runtime.database.prepare(
          "SELECT source_version " +
            "FROM nhl_game_state_observation_snapshots"
        ).get().source_version,
        "independent-game-state-v99"
      );
    });
  });

  test("atomically seals an evidence-aware late lock and exact whole-game exclusions", (t) => {
    const { database, repository, service } = createRuntime(t);
    service.lockAtBoundary(input());
    makeLegal(database);
    const context = repository.readContext({
      ...input(LATE_MS),
      baselineCutoffAtMs: LATE_MS,
      requireSealedPlayerGameEvidence: true,
    });
    const baselines = buildLockedPlayerBaselines({
      activePlayers: context.activePlayers,
      totals: context.totals,
    });
    const players = baselines.map((player, index) => ({
      ...player,
      snapshotPlayerId: uuid(1000 + index * 2),
      lockPlayerId: uuid(1001 + index * 2),
    }));
    const gameObservation = {
      observationId: uuid(1100),
      nhlGameId: "2026020001",
      nhlGameScheduledStartsAtMs: LOCK_MS + 30 * 60 * 1000,
      observedGameState: "in_progress",
    };
    const baselineByPlayer = new Map(
      context.playerGameObservations.map((row) => [row.player_id, row])
    );
    const lockPlayerByPlayer = new Map(
      players.map((row) => [row.playerId, row.lockPlayerId])
    );
    const command = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      matchupId: IDS.matchup,
      teamId: IDS.home,
      provider: "nhl",
      baselineCutoffAtMs: LATE_MS,
      lockId: IDS.homeLock,
      expectedLockVersion: context.existingLocks[0].version,
      expectedWeekVersion: context.week.version,
      activePlayerFingerprint: JSON.stringify(context.activePlayers),
      expectedPlayerGameSetId: context.playerGameSet.id,
      expectedPlayerGameCoverageSha256:
        context.playerGameSet.coverage_sha256,
      expectedPlayerGameEvidenceSha256:
        context.playerGameSet.evidence_sha256,
      playerGameRootFingerprint: JSON.stringify(
        context.playerGameSet
      ),
      playerGameCoverageFingerprint: JSON.stringify(
        context.playerGameCoverage
      ),
      playerGameFingerprint: JSON.stringify(
        context.playerGameObservations
      ),
      snapshotId: uuid(1200),
      statSourceId: context.refresh.stat_source_id,
      refreshId: context.refresh.id,
      baselineAtMs: LATE_MS,
      nowMs: LATE_MS,
      players,
      observationSnapshotId: uuid(1201),
      observationProvider: "nhl",
      observationSourceVersion: "games-live-v1",
      observationObservedAtMs: LATE_MS,
      gameObservations: [gameObservation],
      exclusionSetId: uuid(1202),
      exclusions: players.map((player, index) => ({
        exclusionId: uuid(1300 + index),
        matchupRosterPlayerId: lockPlayerByPlayer.get(player.playerId),
        playerId: player.playerId,
        observationId: gameObservation.observationId,
        baselinePlayerGameStatObservationId:
          baselineByPlayer.get(player.playerId).id,
        nhlGameId: gameObservation.nhlGameId,
        nhlGameScheduledStartsAtMs:
          gameObservation.nhlGameScheduledStartsAtMs,
        observedGameState: gameObservation.observedGameState,
      })),
    };
    const result = repository.persistLateLockWithEvidence(command);

    assert.equal(result.replayed, false);
    assert.equal(result.exclusionSet.exclusion_count, 18);
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM matchup_roster_game_exclusions"
      ).get().count,
      18
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM nhl_game_state_observation_snapshots"
      ).get().count,
      1
    );
    assert.equal(database.pragma("foreign_key_check").length, 0);
    const replayPlayers = command.players.map((player, index) => ({
      ...player,
      snapshotPlayerId: uuid(1500 + index * 2),
      lockPlayerId: uuid(1501 + index * 2),
    }));
    const replayLockPlayerByPlayer = new Map(
      replayPlayers.map((row) => [row.playerId, row.lockPlayerId])
    );
    const replayObservationId = uuid(1600);
    const replayCommand = {
      ...command,
      snapshotId: uuid(1601),
      players: replayPlayers,
      observationSnapshotId: uuid(1602),
      gameObservations: [{
        ...gameObservation,
        observationId: replayObservationId,
      }],
      exclusionSetId: uuid(1603),
      exclusions: command.exclusions.map((row, index) => ({
        ...row,
        exclusionId: uuid(1700 + index),
        matchupRosterPlayerId:
          replayLockPlayerByPlayer.get(row.playerId),
        observationId: replayObservationId,
      })),
    };
    const replay = repository.persistLateLockWithEvidence(
      replayCommand
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.exclusionSet.id, result.exclusionSet.id);

    const committedState = lockEffectState(database);
    const semanticConflicts = [
      {
        name: "coverage digest compare-and-set",
        value: {
          ...replayCommand,
          expectedPlayerGameCoverageSha256: "0".repeat(64),
        },
      },
      {
        name: "coverage child compare-and-set",
        value: {
          ...replayCommand,
          playerGameCoverageFingerprint: "[]",
        },
      },
      {
        name: "observation child compare-and-set",
        value: {
          ...replayCommand,
          playerGameFingerprint: "[]",
        },
      },
      {
        name: "game-state source version",
        value: {
          ...replayCommand,
          observationSourceVersion: "games-live-v2",
        },
      },
      {
        name: "late snapshot timestamp",
        value: {
          ...replayCommand,
          baselineCutoffAtMs: LATE_MS + 1,
          baselineAtMs: LATE_MS + 1,
          nowMs: LATE_MS + 1,
          observationObservedAtMs: LATE_MS + 1,
        },
      },
      {
        name: "roster baseline",
        value: {
          ...replayCommand,
          players: replayCommand.players.map((row, index) =>
            index === 0
              ? {
                  ...row,
                  baselineFantasyPointsHundredths:
                    row.baselineFantasyPointsHundredths + 1,
                }
              : row
          ),
        },
      },
      {
        name: "exclusion meaning",
        value: {
          ...replayCommand,
          gameObservations: replayCommand.gameObservations.map(
            (row) => ({ ...row, observedGameState: "final" })
          ),
          exclusions: replayCommand.exclusions.map((row) => ({
            ...row,
            observedGameState: "final",
          })),
        },
      },
    ];
    for (const candidate of semanticConflicts) {
      assert.throws(
        () => repository.persistLateLockWithEvidence(candidate.value),
        { code: REPOSITORY_ERROR_CODES.versionConflict },
        candidate.name
      );
      assert.deepEqual(
        lockEffectState(database),
        committedState,
        candidate.name
      );
    }
  });

  test("records zero state, then creates one late team baseline without touching the opponent", async (t) => {
    const { database, service } = createRuntime(t);
    const opponentBefore = database.prepare("SELECT * FROM matchup_roster_locks WHERE id = ?").get(IDS.opponentLock);
    const illegal = service.lockAtBoundary(input());
    assert.equal(illegal.lock.legal, 0);
    assert.equal(illegal.playerCount, 0);
    const illegalRow = database.prepare("SELECT * FROM matchup_roster_locks WHERE id = ?").get(IDS.homeLock);
    assert.equal(illegalRow.baseline_snapshot_id, null);
    assert.equal(illegalRow.legality_reason_code, MATCHUP_LEGALITY_CODES.forwardSlotsIncomplete);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_players WHERE matchup_roster_lock_id = ?").get(IDS.homeLock).count,
      0
    );

    makeLegal(database);
    assert.equal(service.lockAtBoundary(input()).replayed, true);
    const late = await service.lockLate(input(LATE_MS));
    assert.equal(late.lock.lock_type, "late");
    assert.equal(late.lock.legal, 1);
    assert.equal(late.playerCount, 18);
    const promoted = database.prepare("SELECT * FROM matchup_roster_locks WHERE id = ?").get(IDS.homeLock);
    assert.equal(promoted.locked_at_ms, LATE_MS);
    assert.equal(promoted.legality_reason_code, null);
    assert.equal(
      database.prepare("SELECT captured_at_ms FROM stat_snapshots WHERE id = ?").get(promoted.baseline_snapshot_id).captured_at_ms,
      LATE_MS
    );
    assert.deepEqual(
      database.prepare("SELECT * FROM matchup_roster_locks WHERE id = ?").get(IDS.opponentLock),
      opponentBefore
    );
    assert.equal((await service.lockLate(input(LATE_MS))).replayed, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_locks").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("uses the post-fetch server clock and includes a game that begins during the fetch", async (t) => {
    let serverNowMs = LATE_MS;
    let requestedGames = null;
    const gameStartsAtMs = LATE_MS + 30 * 1000;
    const { database, service } = createRuntime(t, {
      nowMs: () => serverNowMs,
      playerGameStartsAtMs: gameStartsAtMs,
      gameStateProvider: {
        async fetchGameStates({ games }) {
          requestedGames = games;
          serverNowMs = LATE_MS + 60 * 1000;
          return {
            provider: "nhl",
            sourceVersion: "games-after-fetch",
            observedAtMs: serverNowMs,
            games: games.map((row) => ({
              ...row,
              observedGameState: "in_progress",
            })),
          };
        },
      },
    });
    service.lockAtBoundary(input());
    makeLegal(database);

    const result = await service.lockLate(input(LATE_MS));

    assert.deepEqual(requestedGames, [{
      nhlGameId: "2026020001",
      nhlGameScheduledStartsAtMs: gameStartsAtMs,
    }]);
    assert.equal(result.lock.locked_at_ms, serverNowMs);
    assert.equal(result.exclusionSet.exclusion_count, 18);
    assert.deepEqual(
      database.prepare(
        "SELECT observed_at_ms, freshness_status " +
          "FROM nhl_game_state_observation_snapshots"
      ).get(),
      {
        observed_at_ms: serverNowMs,
        freshness_status: "fresh",
      }
    );
    assert.deepEqual(
      database.prepare(
        "SELECT DISTINCT nhl_game_scheduled_starts_at_ms, " +
          "late_snapshot_at_ms FROM matchup_roster_game_exclusions"
      ).get(),
      {
        nhl_game_scheduled_starts_at_ms: gameStartsAtMs,
        late_snapshot_at_ms: serverNowMs,
      }
    );
  });

  test("accepts an NHL game observation at the exact five-minute freshness boundary", async (t) => {
    const { database, service } = createRuntime(t, {
      nowMs: () => LATE_MS,
      gameStateProvider: {
        async fetchGameStates({ games }) {
          return {
            provider: "nhl",
            sourceVersion: "games-five-minute-boundary",
            observedAtMs: LATE_MS - 5 * 60 * 1000,
            games: games.map((row) => ({
              ...row,
              observedGameState: "in_progress",
            })),
          };
        },
      },
    });
    service.lockAtBoundary(input());
    makeLegal(database);

    const result = await service.lockLate(input(LATE_MS));

    assert.equal(result.replayed, false);
    assert.equal(result.lock.locked_at_ms, LATE_MS);
    assert.equal(
      database.prepare(
        "SELECT observed_at_ms " +
          "FROM nhl_game_state_observation_snapshots"
      ).get().observed_at_ms,
      LATE_MS - 5 * 60 * 1000
    );
  });

  test("rejects early or still-illegal late locks without changing zero state", async (t) => {
    const { database, service } = createRuntime(t);
    service.lockAtBoundary(input());
    await assert.rejects(() => service.lockLate(input(LOCK_MS)), {
      code: MATCHUP_LEGALITY_SERVICE_CODES.tooEarly,
    });
    await assert.rejects(() => service.lockLate(input(LATE_MS)), {
      code: MATCHUP_LEGALITY_SERVICE_CODES.stillIllegal,
    });
    const row = database.prepare("SELECT legal, lock_type, baseline_snapshot_id, version FROM matchup_roster_locks WHERE id = ?").get(IDS.homeLock);
    assert.deepEqual(row, { legal: 0, lock_type: "normal", baseline_snapshot_id: null, version: 1 });
  });

  test("keeps the illegal lock awaiting data without sealed player-game statistics", async (t) => {
    const { database, service } = createRuntime(t, {
      includePlayerGameEvidence: false,
    });
    service.lockAtBoundary(input());
    makeLegal(database);

    await assert.rejects(() => service.lockLate(input(LATE_MS)), {
      code:
        MATCHUP_LEGALITY_SERVICE_CODES.statisticsMissing,
    });
    assert.deepEqual(
      database.prepare(
        "SELECT legal, lock_type, baseline_snapshot_id, version " +
          "FROM matchup_roster_locks WHERE id = ?"
      ).get(IDS.homeLock),
      {
        legal: 0,
        lock_type: "normal",
        baseline_snapshot_id: null,
        version: 1,
      }
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM nhl_game_state_observation_snapshots"
      ).get().count,
      0
    );
  });

  test("keeps the illegal lock awaiting data when a selected player lacks cumulative totals", async (t) => {
    const { database, service } = createRuntime(t);
    service.lockAtBoundary(input());
    makeLegal(database);
    database.prepare(
      "DELETE FROM player_stat_totals WHERE refresh_id = ? AND player_id = ?"
    ).run(IDS.refresh, uuid(112));
    const before = lockEffectState(database);

    await assert.rejects(
      () => service.lockLate(input(LATE_MS)),
      { code: MATCHUP_LEGALITY_SERVICE_CODES.statisticsMissing }
    );

    assert.deepEqual(lockEffectState(database), before);
    assert.deepEqual(
      database.prepare(
        "SELECT legal, lock_type, baseline_snapshot_id, version " +
          "FROM matchup_roster_locks WHERE id = ?"
      ).get(IDS.homeLock),
      {
        legal: 0,
        lock_type: "normal",
        baseline_snapshot_id: null,
        version: 1,
      }
    );
  });

  test("rejects stale or incomplete game-state evidence without partial writes", async (t) => {
    for (const [suffix, gameStateProvider, expectedCode] of [
      [
        "stale",
        {
          async fetchGameStates({ requestedAtMs, games }) {
            return {
              provider: "nhl",
              sourceVersion: "stale-games",
              observedAtMs: requestedAtMs - 5 * 60 * 1000 - 1,
              games: games.map((row) => ({
                ...row,
                observedGameState: "in_progress",
              })),
            };
          },
        },
        MATCHUP_LATE_LOCK_EVIDENCE_CODES.observationStale,
      ],
      [
        "incomplete",
        {
          async fetchGameStates({ requestedAtMs }) {
            return {
              provider: "nhl",
              sourceVersion: "incomplete-games",
              observedAtMs: requestedAtMs,
              games: [],
            };
          },
        },
        MATCHUP_LEGALITY_SERVICE_CODES.gameStateIncomplete,
      ],
    ]) {
      await t.test(suffix, async (subtest) => {
        const runtime = createRuntime(subtest, { gameStateProvider });
        runtime.service.lockAtBoundary(input());
        makeLegal(runtime.database);
        const before = runtime.database.serialize();
        await assert.rejects(
          () => runtime.service.lockLate(input(LATE_MS)),
          { code: expectedCode }
        );
        assert.equal(before.equals(runtime.database.serialize()), true);
        assert.deepEqual(
          runtime.database.prepare(
            "SELECT legal, lock_type, baseline_snapshot_id, version " +
              "FROM matchup_roster_locks WHERE id = ?"
          ).get(IDS.homeLock),
          {
            legal: 0,
            lock_type: "normal",
            baseline_snapshot_id: null,
            version: 1,
          }
        );
        for (const table of [
          "nhl_game_state_observation_snapshots",
          "matchup_roster_game_exclusion_sets",
        ]) {
          assert.equal(
            runtime.database.prepare(
              `SELECT COUNT(*) AS count FROM ${table}`
            ).get().count,
            0
          );
        }
      });
    }
  });

  test("rejects post-fetch timing failures without writing late-lock evidence", async (t) => {
    for (const candidate of [
      {
        name: "provider fetch crosses the exclusive week end",
        expectedCode: MATCHUP_LEGALITY_SERVICE_CODES.weekEnded,
        postFetchNowMs: END_MS,
        observedAtMs: END_MS,
      },
      {
        name: "provider observation is in the server clock's future",
        expectedCode:
          MATCHUP_LATE_LOCK_EVIDENCE_CODES.observationFuture,
        postFetchNowMs: LATE_MS,
        observedAtMs: LATE_MS + 1,
      },
      {
        name: "server clock regresses during the provider fetch",
        expectedCode: MATCHUP_LEGALITY_SERVICE_CODES.clockRegressed,
        postFetchNowMs: LATE_MS - 1,
        observedAtMs: LATE_MS - 1,
      },
    ]) {
      await t.test(candidate.name, async (subtest) => {
        let serverNowMs = LATE_MS;
        const runtime = createRuntime(subtest, {
          nowMs: () => serverNowMs,
          gameStateProvider: {
            async fetchGameStates({ games }) {
              serverNowMs = candidate.postFetchNowMs;
              return {
                provider: "nhl",
                sourceVersion: `games-${candidate.name}`,
                observedAtMs: candidate.observedAtMs,
                games: games.map((row) => ({
                  ...row,
                  observedGameState: "in_progress",
                })),
              };
            },
          },
        });
        runtime.service.lockAtBoundary(input());
        makeLegal(runtime.database);
        const before = runtime.database.serialize();

        await assert.rejects(
          () => runtime.service.lockLate(input(LATE_MS)),
          { code: candidate.expectedCode }
        );

        assert.equal(before.equals(runtime.database.serialize()), true);
      });
    }
  });

  test("rejects an underway state for a game scheduled after the actual snapshot", async (t) => {
    const { database, service } = createRuntime(t, {
      nowMs: () => LATE_MS,
      playerGameStartsAtMs: LATE_MS + 1,
    });
    service.lockAtBoundary(input());
    makeLegal(database);
    const before = database.serialize();

    await assert.rejects(
      () => service.lockLate(input(LATE_MS)),
      { code: MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid }
    );

    assert.equal(before.equals(database.serialize()), true);
  });

  test("preserves original compare-and-set inputs across the provider wait", async (t) => {
    let runtime;
    const gameStateProvider = {
      async fetchGameStates({ requestedAtMs, games }) {
        runtime.database.prepare(
          "UPDATE player_ownerships SET updated_at_ms = ?, " +
            "version = version + 1 WHERE player_id = ?"
        ).run(requestedAtMs + 1, uuid(101));
        return {
          provider: "nhl",
          sourceVersion: "games-concurrent-roster-write",
          observedAtMs: requestedAtMs,
          games: games.map((row) => ({
            ...row,
            observedGameState: "in_progress",
          })),
        };
      },
    };
    runtime = createRuntime(t, {
      gameStateProvider,
      nowMs: () => LATE_MS,
    });
    runtime.service.lockAtBoundary(input());
    makeLegal(runtime.database);

    await assert.rejects(
      () => runtime.service.lockLate(input(LATE_MS)),
      { code: REPOSITORY_ERROR_CODES.versionConflict }
    );

    assert.deepEqual(
      runtime.database.prepare(
        "SELECT legal, lock_type, baseline_snapshot_id, version " +
          "FROM matchup_roster_locks WHERE id = ?"
      ).get(IDS.homeLock),
      {
        legal: 0,
        lock_type: "normal",
        baseline_snapshot_id: null,
        version: 1,
      }
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count " +
          "FROM nhl_game_state_observation_snapshots"
      ).get().count,
      0
    );
  });

  test("rolls a failed late conversion back to the original illegal evidence", async (t) => {
    let fail = false;
    const { database, service } = createRuntime(t, { failure: () => fail });
    service.lockAtBoundary(input());
    makeLegal(database);
    fail = true;
    await assert.rejects(() => service.lockLate(input(LATE_MS)));
    const home = database.prepare("SELECT legal, lock_type, baseline_snapshot_id, version FROM matchup_roster_locks WHERE id = ?").get(IDS.homeLock);
    assert.deepEqual(home, { legal: 0, lock_type: "normal", baseline_snapshot_id: null, version: 1 });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM stat_snapshots").get().count,
      1
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_players WHERE matchup_roster_lock_id = ?").get(IDS.homeLock).count,
      0
    );
  });
});

describe("FAD-05 generation-safe matchup-lock effects", () => {
  test("preserves the exact execution through new and replayed legal, illegal, and evidence-aware locks", async (t) => {
    await t.test("normal legal", (subtest) => {
      const runtime = createRuntime(subtest, {
        guardOccurrence: true,
        refreshCompletedAtMs: BASELINE_MS,
      });
      makeLegal(runtime.database);
      const command = {
        ...input(),
        occurrenceExecution: runtime.execution,
      };

      assert.equal(runtime.service.lockAtBoundary(command).replayed, false);
      assert.equal(runtime.service.lockAtBoundary(command).replayed, true);
      assert.equal(runtime.guardCalls.length, 2);
      for (const context of runtime.guardCalls) {
        assert.strictEqual(context, runtime.execution);
      }
    });

    await t.test("illegal", (subtest) => {
      const runtime = createRuntime(subtest, {
        guardOccurrence: true,
      });
      const command = {
        ...input(),
        occurrenceExecution: runtime.execution,
      };

      assert.equal(runtime.service.lockAtBoundary(command).replayed, false);
      assert.equal(runtime.service.lockAtBoundary(command).replayed, true);
      assert.equal(runtime.guardCalls.length, 2);
      for (const context of runtime.guardCalls) {
        assert.strictEqual(context, runtime.execution);
      }
    });

    await t.test("evidence-aware late", async (subtest) => {
      const runtime = createRuntime(subtest, {
        guardOccurrence: true,
      });
      const boundary = {
        ...input(),
        occurrenceExecution: runtime.execution,
      };
      runtime.service.lockAtBoundary(boundary);
      makeLegal(runtime.database);
      const late = {
        ...input(LATE_MS),
        occurrenceExecution: runtime.execution,
      };

      assert.equal((await runtime.service.lockLate(late)).replayed, false);
      assert.equal((await runtime.service.lockLate(late)).replayed, true);
      assert.equal(runtime.guardCalls.length, 3);
      for (const context of runtime.guardCalls) {
        assert.strictEqual(context, runtime.execution);
      }
    });
  });

  test("rejects superseded and lost executions without a partial lock effect", async (t) => {
    await t.test("superseded generation", (subtest) => {
      const runtime = createRuntime(subtest, {
        guardOccurrence: true,
        refreshCompletedAtMs: BASELINE_MS,
      });
      makeLegal(runtime.database);
      supersedeGeneration(runtime.database);
      const before = lockEffectState(runtime.database);

      const error = captureError(() =>
        runtime.service.lockAtBoundary({
          ...input(),
          occurrenceExecution: runtime.execution,
        })
      );

      assert.equal(error.code, REPOSITORY_ERROR_CODES.versionConflict);
      assert.equal(
        classifyMatchupOccurrenceExecutionGuardError(error),
        MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.generationSuperseded
      );
      assert.deepEqual(lockEffectState(runtime.database), before);
    });

    await t.test("lost lease", (subtest) => {
      const runtime = createRuntime(subtest, {
        guardOccurrence: true,
        refreshCompletedAtMs: BASELINE_MS,
      });
      makeLegal(runtime.database);
      runtime.database.prepare(`
        UPDATE job_runs
        SET lease_token = 'replacement-new-lock-token'
        WHERE id = ?
      `).run(IDS.runA);
      const before = lockEffectState(runtime.database);

      const error = captureError(() =>
        runtime.service.lockAtBoundary({
          ...input(),
          occurrenceExecution: runtime.execution,
        })
      );

      assert.equal(error.code, REPOSITORY_ERROR_CODES.versionConflict);
      assert.equal(
        classifyMatchupOccurrenceExecutionGuardError(error),
        MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
      );
      assert.deepEqual(lockEffectState(runtime.database), before);
    });
  });

  test("guards a replay before returning it after the lease is lost", (t) => {
    const runtime = createRuntime(t, {
      guardOccurrence: true,
      refreshCompletedAtMs: BASELINE_MS,
    });
    makeLegal(runtime.database);
    const command = {
      ...input(),
      occurrenceExecution: runtime.execution,
    };
    assert.equal(runtime.service.lockAtBoundary(command).replayed, false);
    runtime.database.prepare(`
      UPDATE job_runs
      SET lease_token = 'replacement-replay-lock-token'
      WHERE id = ?
    `).run(IDS.runA);
    const before = lockEffectState(runtime.database);

    const error = captureError(() =>
      runtime.service.lockAtBoundary(command)
    );

    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
    );
    assert.equal(runtime.guardCalls.length, 2);
    assert.strictEqual(runtime.guardCalls[1], runtime.execution);
    assert.deepEqual(lockEffectState(runtime.database), before);
  });

  test("closes the async provider race before any late-lock evidence write", async (t) => {
    let runtime;
    const gameStateProvider = {
      async fetchGameStates({ requestedAtMs, games }) {
        assert.equal(runtime.database.inTransaction, false);
        runtime.database.prepare(`
          UPDATE job_runs
          SET lease_token = 'replacement-provider-race-token'
          WHERE id = ?
        `).run(IDS.runA);
        return {
          provider: "nhl",
          sourceVersion: "provider-race",
          observedAtMs: requestedAtMs,
          games: games.map((row) => ({
            ...row,
            observedGameState: "in_progress",
          })),
        };
      },
    };
    runtime = createRuntime(t, {
      gameStateProvider,
      guardOccurrence: true,
      nowMs: () => LATE_MS,
    });
    const boundary = {
      ...input(),
      occurrenceExecution: runtime.execution,
    };
    runtime.service.lockAtBoundary(boundary);
    makeLegal(runtime.database);
    const before = lockEffectState(runtime.database);

    const error = await captureRejected(() =>
      runtime.service.lockLate({
        ...input(LATE_MS),
        occurrenceExecution: runtime.execution,
      })
    );

    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
    );
    assert.equal(runtime.guardCalls.length, 2);
    assert.strictEqual(runtime.guardCalls[1], runtime.execution);
    assert.deepEqual(lockEffectState(runtime.database), before);
  });

  test("guards all three immediate callbacks before a read and binds the execution scope", (t) => {
    const runtime = createRuntime(t);
    const database = runtime.database;
    const transactionEvents = [];
    const instrumentedDatabase = {
      prepare(sql) {
        const statement = database.prepare(sql);
        const record = (operation) => {
          if (database.inTransaction) {
            transactionEvents.push(`${operation}:${sql}`);
          }
        };
        return {
          all(...args) {
            record("all");
            return statement.all(...args);
          },
          get(...args) {
            record("get");
            return statement.get(...args);
          },
          run(...args) {
            record("run");
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
    const sentinel = new Error("guard-first-sentinel");
    const guardedRepository = createSqliteMatchupLockRepository({
      database: instrumentedDatabase,
      occurrenceExecutionGuard: {
        assertCurrent(context) {
          transactionEvents.push("guard");
          assert.equal(database.inTransaction, true);
          assert.strictEqual(context, occurrenceExecution);
          throw sentinel;
        },
      },
    });
    const scope = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      teamId: IDS.home,
      occurrenceExecution,
    };

    for (const method of [
      "persistNormalLock",
      "persistIllegalLock",
      "persistLateLockWithEvidence",
    ]) {
      transactionEvents.length = 0;
      const error = captureError(() =>
        guardedRepository[method](scope)
      );
      assert.strictEqual(error.cause, sentinel, method);
      assert.deepEqual(transactionEvents, ["guard"], method);
    }

    const reached = [];
    const validationRepository = createSqliteMatchupLockRepository({
      database,
      occurrenceExecutionGuard: {
        assertCurrent(context) {
          reached.push(context);
          if (context === null || Object.keys(context).length === 0) {
            throw sentinel;
          }
          return context;
        },
      },
    });
    for (const malformed of [null, Object.freeze({})]) {
      const error = captureError(() =>
        validationRepository.persistNormalLock({
          ...scope,
          occurrenceExecution: malformed,
        })
      );
      assert.strictEqual(error.cause, sentinel);
    }
    assert.strictEqual(reached[0], null);
    assert.deepEqual(reached[1], Object.freeze({}));

    const mismatchedExecution = Object.freeze({
      ...occurrenceExecution,
      leagueId: uuid(9999),
    });
    const mismatch = captureError(() =>
      validationRepository.persistNormalLock({
        ...scope,
        occurrenceExecution: mismatchedExecution,
      })
    );
    assert.equal(mismatch.code, REPOSITORY_ERROR_CODES.argumentInvalid);
    assert.strictEqual(reached[2], mismatchedExecution);
  });

  test("fails guarded commands closed without a guard and preserves manual behavior", (t) => {
    const runtime = createRuntime(t);
    assert.throws(
      () => createSqliteMatchupLockRepository({
        database: runtime.database,
        occurrenceExecutionGuard: {},
      }),
      TypeError
    );
    const before = lockEffectState(runtime.database);
    const error = captureError(() =>
      runtime.service.lockAtBoundary({
        ...input(),
        occurrenceExecution: Object.freeze({}),
      })
    );
    assert.equal(error.code, REPOSITORY_ERROR_CODES.argumentInvalid);
    assert.deepEqual(lockEffectState(runtime.database), before);

    assert.equal(runtime.service.lockAtBoundary(input()).replayed, false);
  });

  test("removes the legacy evidence-bypassing late-lock API", (t) => {
    const runtime = createRuntime(t);
    assert.equal(runtime.repository.persistLateLock, undefined);
  });
});
