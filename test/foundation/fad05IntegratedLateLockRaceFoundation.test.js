const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createLiveStatisticsService,
} = require("../../src/application/services/statistics/createLiveStatisticsService");
const {
  createLateLockCoordinator,
} = require("../../src/application/services/matchups/createLateLockCoordinator");
const {
  createMatchupLegalityService,
} = require("../../src/application/services/matchups/createMatchupLegalityService");
const {
  createMatchupLockService,
} = require("../../src/application/services/matchups/createMatchupLockService");
const {
  createMatchupOccurrenceHandlers,
} = require("../../src/application/services/matchups/createMatchupOccurrenceHandlers");
const {
  buildMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLateLockCoordinatorRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteLateLockCoordinatorRepository");
const {
  createSqliteMatchupLockRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupLockRepository");
const {
  MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS,
  classifyMatchupOccurrenceExecutionGuardError,
  createSqliteMatchupOccurrenceExecutionGuard,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupOccurrenceExecutionGuard");
const {
  createSqliteRosterMovementRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteRosterMovementRepository");
const {
  createSqliteStatisticsRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const HOUR_MS = 60 * 60 * 1000;
const START_MS = 2_000_000_000;
const BASELINE_MS = START_MS + HOUR_MS;
const LOCK_MS = START_MS + 16 * HOUR_MS;
const LATE_MS = LOCK_MS + HOUR_MS;
const END_MS = START_MS + 7 * 24 * HOUR_MS;
const GAME_START_MS = LOCK_MS + 30 * 60 * 1000;
const LIVE_PROVIDER = "nhl-live";
const IDENTITY_PROVIDER = "nhl-catalog";
const LEASE_OWNER = "fad05-integrated-worker";
const LEASE_TOKEN = "fad05-integrated-lease-token";

function uuid(value) {
  return `30000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  week: uuid(3),
  home: uuid(4),
  away: uuid(5),
  matchup: uuid(6),
  user: uuid(7),
  readiness: uuid(8),
  fad: uuid(9),
  scheduleA: uuid(10),
  scheduleB: uuid(11),
  run: uuid(12),
  binding: uuid(13),
  lock: uuid(14),
  moveEvent: uuid(15),
  moveActivity: uuid(16),
  awayUser: uuid(17),
  homeMembership: uuid(18),
  awayMembership: uuid(19),
  homeAssignment: uuid(20),
  awayAssignment: uuid(21),
});

function playerId(index) {
  return uuid(100 + index);
}

function ownershipId(index) {
  return uuid(200 + index);
}

function generatedIdFactory(start) {
  let next = start;
  return () => uuid(next++);
}

function rosterPlayers() {
  return Array.from({ length: 18 }, (_, index) => {
    const isForward = index < 12;
    return Object.freeze({
      playerId: playerId(index),
      ownershipId: ownershipId(index),
      providerPlayerId: String(10_000 + index),
      positionGroup: isForward ? "F" : "D",
      slotNumber: isForward ? index + 1 : index - 11,
      startsOnBench: index === 11,
    });
  });
}

const PLAYERS = Object.freeze(rosterPlayers());

function seedCompletedFad(database) {
  const deadlineAtMs = START_MS - 604_800_000;
  const openedAtMs = deadlineAtMs - 200_000_000;
  const completedAtMs = START_MS - 1;
  database.prepare(`
    INSERT INTO free_agent_draft_readiness_operations (
      id, league_id, season_id, readiness_occurrence_key,
      trigger_kind, entry_draft_id, setup_exemption_id, job_run_id,
      status, attempt_count, lease_owner, lease_token,
      lease_expires_at_ms, blockers_json,
      matchup_schedule_version_before,
      matchup_schedule_version_after, schedule_recovery_id,
      created_fad_id, reminder_job_run_id, deadline_job_run_id,
      cards_opened_activity_id, cards_opened_outbox_event_id,
      started_at_ms, next_retry_at_ms, terminal_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, 'fad-readiness:integrated-late-lock',
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
      current_competition_first_matchup_week_id,
      schedule_recovery_id, participating_team_count, status,
      setup_path, entry_draft_id, setup_exemption_id,
      prior_season_rollover_id, no_draft_reason, opening_authority,
      opened_at_ms, help_opens_at_ms, candidate_deadline_at_ms,
      first_matchup_starts_at_ms, deadline_locked_at_ms,
      allocation_completed_at_ms, completed_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'fad-readiness:integrated-late-lock',
      ?, ?, NULL, 2, 'cards_open', 'no_draft_inaugural', NULL,
      NULL, NULL, 'integrated late-lock fixture', 'system', ?, ?, ?, ?,
      NULL, NULL, NULL, ?, ?, 1)
  `).run(
    IDS.fad,
    IDS.league,
    IDS.season,
    IDS.readiness,
    IDS.week,
    IDS.week,
    openedAtMs,
    deadlineAtMs - 172_800_000,
    deadlineAtMs,
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
    deadlineAtMs,
    deadlineAtMs + 1,
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

function seedOccurrence(database) {
  database.prepare(`
    INSERT INTO matchup_operations (
      id, league_id, season_id, matchup_week_id, matchup_id,
      actor_user_id, operation_type, status, reason, metadata_json,
      started_at_ms, completed_at_ms
    ) VALUES (?, ?, ?, NULL, NULL, ?, 'schedule_generate',
      'succeeded', NULL, NULL, ?, ?)
  `).run(
    IDS.scheduleA,
    IDS.league,
    IDS.season,
    IDS.user,
    START_MS - 3,
    START_MS - 2
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
    START_MS - 2
  );
  const jobType = "matchup:statistics_refresh";
  const occurrenceKey = buildMatchupOccurrenceKey({
    jobType,
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    scheduleOperationId: IDS.scheduleA,
    scheduleVersion: 1,
    scheduledForMs: START_MS,
  });
  database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type, occurrence_key,
      scheduled_for_ms, status, attempt_count, lease_owner,
      lease_expires_at_ms, started_at_ms, completed_at_ms,
      result_json, last_error_code, created_at_ms, updated_at_ms,
      version, lease_token, next_attempt_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, NULL,
      NULL, NULL, ?, ?, 2, ?, NULL)
  `).run(
    IDS.run,
    IDS.league,
    IDS.season,
    jobType,
    occurrenceKey,
    START_MS,
    LEASE_OWNER,
    END_MS + HOUR_MS,
    START_MS,
    START_MS - 1,
    START_MS,
    LEASE_TOKEN
  );
  database.prepare(`
    INSERT INTO matchup_schedule_job_bindings (
      id, league_id, season_id, job_run_id, job_type,
      schedule_operation_id, schedule_version,
      owning_matchup_week_id, owning_matchup_id, created_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, 1)
  `).run(
    IDS.binding,
    IDS.league,
    IDS.season,
    IDS.run,
    jobType,
    IDS.scheduleA,
    IDS.week,
    START_MS - 1
  );
  return Object.freeze({
    bindingId: IDS.binding,
    claimedJobVersion: 2,
    jobType,
    leagueId: IDS.league,
    leaseExpiresAtMs: END_MS + HOUR_MS,
    leaseOwner: LEASE_OWNER,
    leaseToken: LEASE_TOKEN,
    occurrenceKey,
    runId: IDS.run,
    scheduleOperationId: IDS.scheduleA,
    scheduleVersion: 1,
    scheduledForMs: START_MS,
    seasonId: IDS.season,
    weekId: IDS.week,
  });
}

function seedLeague(database) {
  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, 'Integrated Late Lock', 'integrated late lock',
      'active', 'America/Vancouver', 1, 1, 1)
  `).run(IDS.league);
  database.prepare(`
    INSERT INTO seasons (
      id, league_id, label, nhl_season_key, status,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)
  `).run(IDS.season, IDS.league);
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms,
      updated_at_ms, version
    ) VALUES (?, 'integrated@example.test', 'integrated@example.test',
      'Integrated Manager', 'integrated manager', 'active', 1, 1, 1)
  `).run(IDS.user);
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms,
      updated_at_ms, version
    ) VALUES (?, 'away@example.test', 'away@example.test',
      'Away Manager', 'away manager', 'active', 1, 1, 1)
  `).run(IDS.awayUser);
  const insertTeam = database.prepare(`
    INSERT INTO teams (
      id, league_id, name, name_normalized, status,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)
  `);
  insertTeam.run(IDS.home, IDS.league, "Home", "home");
  insertTeam.run(IDS.away, IDS.league, "Away", "away");
  const insertMembership = database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'active', 1, NULL, 1, 1, 1)
  `);
  insertMembership.run(
    IDS.homeMembership,
    IDS.league,
    IDS.user,
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
    IDS.user,
    IDS.homeMembership,
    IDS.user
  );
  insertAssignment.run(
    IDS.awayAssignment,
    IDS.league,
    IDS.away,
    IDS.awayUser,
    IDS.awayMembership,
    IDS.user
  );
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?, current_season_id = ?,
        updated_at_ms = 2, version = version + 1
    WHERE id = ?
  `).run(
    IDS.homeMembership,
    IDS.season,
    IDS.league
  );
  database.prepare(`
    INSERT INTO matchup_weeks (
      id, league_id, season_id, week_key, sequence, starts_at_ms,
      baseline_at_ms, locks_at_ms, ends_at_ms, rolls_over_at_ms,
      status, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, 'regular-01', 1, ?, ?, ?, ?, ?,
      'live', 1, 1, 2)
  `).run(
    IDS.week,
    IDS.league,
    IDS.season,
    START_MS,
    BASELINE_MS,
    LOCK_MS,
    END_MS,
    END_MS
  );
  database.prepare(`
    INSERT INTO matchups (
      id, league_id, season_id, matchup_week_id,
      home_team_id, away_team_id, home_team_name, away_team_name,
      status, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'live', 1, 1, 2)
  `).run(
    IDS.matchup,
    IDS.league,
    IDS.season,
    IDS.week,
    IDS.home,
    IDS.away
  );
  const insertPlayer = database.prepare(`
    INSERT INTO players (
      id, first_name, last_name, full_name, birth_date, status,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, 'Player', ?, ?, '2000-01-01', 'active', 1, 1, 1)
  `);
  const insertIdentity = database.prepare(`
    INSERT INTO player_external_ids (
      id, player_id, provider, external_value, created_at_ms
    ) VALUES (?, ?, ?, ?, 1)
  `);
  const insertOwnership = database.prepare(`
    INSERT INTO player_ownerships (
      id, league_id, season_id, player_id, team_id, ownership_kind,
      roster_category, position_group, slot_number,
      acquired_transaction_type, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, 'Rostered', ?, ?, ?,
      'integrated_test', 1, 1, 1)
  `);
  for (let index = 0; index < PLAYERS.length; index += 1) {
    const player = PLAYERS[index];
    insertPlayer.run(
      player.playerId,
      String(index + 1),
      `Player ${index + 1}`
    );
    insertIdentity.run(
      uuid(300 + index),
      player.playerId,
      IDENTITY_PROVIDER,
      player.providerPlayerId
    );
    insertOwnership.run(
      player.ownershipId,
      IDS.league,
      IDS.season,
      player.playerId,
      IDS.home,
      player.startsOnBench ? "Bench" : "Active",
      player.positionGroup,
      player.startsOnBench ? 1 : player.slotNumber
    );
  }
  database.prepare(`
    INSERT INTO matchup_roster_locks (
      id, league_id, season_id, matchup_week_id, team_id,
      lock_type, legal, legality_reason_code, locked_at_ms,
      baseline_snapshot_id, source_freshness_status,
      created_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, 'normal', 0, 'ACTIVE_FORWARD_COUNT', ?,
      NULL, 'unknown', ?, 1)
  `).run(
    IDS.lock,
    IDS.league,
    IDS.season,
    IDS.week,
    IDS.home,
    LOCK_MS,
    LOCK_MS
  );
  seedCompletedFad(database);
  return seedOccurrence(database);
}

function createFixture(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad05-integrated-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "late-lock.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad05-integrated-late-lock-race",
    now: () => 1,
  });
  const execution = seedLeague(connection.database);
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return Object.freeze({
    database: connection.database,
    execution,
  });
}

function moveRosterToLegal(database) {
  const player = PLAYERS.find((candidate) => candidate.startsOnBench);
  const repository = createSqliteRosterMovementRepository({
    database,
    candidateCardSummerSynchronizer: {
      synchronize(input) {
        assert.equal(database.inTransaction, true);
        assert.equal(input.leagueId, IDS.league);
        assert.deepEqual(input.affectedTeamIds, [IDS.home]);
        assert.deepEqual(input.affectedPlayerIds, [player.playerId]);
        assert.equal(input.sourceOperationId, IDS.moveEvent);
        assert.equal(input.sourceKind, "roster_movement");
        assert.equal(input.nowMs, LATE_MS - 1);
      },
    },
  });
  try {
    return repository.move({
      leagueId: IDS.league,
      seasonId: IDS.season,
      teamId: IDS.home,
      playerId: player.playerId,
      expectedVersion: 1,
      expectedSourceCategory: "Bench",
      destinationCategory: "Active",
      destinationPositionGroup: "F",
      destinationSlotNumber: 12,
      actorUserId: IDS.user,
      actorAuthority: "manager",
      ownershipEventId: IDS.moveEvent,
      activityId: IDS.moveActivity,
      reason: null,
      occurredAtMs: LATE_MS - 1,
    });
  } catch (error) {
    throw new Error(
      `Integrated roster move failed: ${error.message}`,
      { cause: error }
    );
  }
}

function providerSnapshot(requiredPlayers, coverageMode) {
  const expectedGame = coverageMode === "expected_game";
  return Object.freeze({
    provider: LIVE_PROVIDER,
    sourceVersion: `integrated-${coverageMode}-v1`,
    capturedAtMs: LATE_MS,
    totalsSourceUpdatedAtMs: LATE_MS,
    totalsRows: requiredPlayers.map((player, index) => ({
      playerId: player.providerPlayerId,
      gamesPlayed: 1,
      goals: index % 3,
      assists: index % 2,
    })),
    playerGameRows: expectedGame
      ? requiredPlayers.map((player) => ({
          playerId: player.providerPlayerId,
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: GAME_START_MS,
          observedGameState: "scheduled",
          goals: 0,
          assists: 0,
          sourceUpdatedAtMs: LATE_MS,
        }))
      : [],
    playerGameCoverage: {
      schemaVersion: 1,
      throughAtMs: LATE_MS,
      players: requiredPlayers.map((player) => ({
        playerId: player.playerId,
        providerPlayerId: player.providerPlayerId,
        providerTeamId: "10",
        disposition: expectedGame ? "expected_game" : "no_due_game",
        games: expectedGame
          ? [{
              providerTeamId: "10",
              nhlGameId: "2026020001",
              nhlGameScheduledStartsAtMs: GAME_START_MS,
              observedGameState: "scheduled",
            }]
          : [],
      })),
    },
  });
}

function createIntegratedServices(
  database,
  {
    coverageMode = "no_due_game",
    onProviderFetch = async () => {},
    gameStateProvider = null,
    lateAttemptObservations = [],
  } = {}
) {
  const occurrenceExecutionGuard =
    createSqliteMatchupOccurrenceExecutionGuard({ database });
  const statisticsRepository = createSqliteStatisticsRepository({
    database,
    createId: generatedIdFactory(5_000),
    occurrenceExecutionGuard,
  });
  const statistics = createLiveStatisticsService({
    repository: statisticsRepository,
    provider: {
      async fetchLiveSnapshot({ requiredPlayers }) {
        await onProviderFetch();
        return providerSnapshot(requiredPlayers, coverageMode);
      },
    },
    nhlSeasonKey: "20262027",
    providerName: LIVE_PROVIDER,
    playerIdentityProvider: IDENTITY_PROVIDER,
    minimumPlayerCount: 18,
    nowMs: () => LATE_MS,
    createId: generatedIdFactory(6_000),
  });
  const lockRepository = createSqliteMatchupLockRepository({
    database,
    occurrenceExecutionGuard,
  });
  const lockIds = generatedIdFactory(7_000);
  const matchupLock = createMatchupLockService({
    repository: lockRepository,
    createId: lockIds,
  });
  const realLegality = createMatchupLegalityService({
    repository: lockRepository,
    normalLockService: matchupLock,
    gameStateProvider,
    createId: lockIds,
    nowMs: () => LATE_MS,
  });
  const observedLegality = Object.freeze({
    lockAtBoundary: realLegality.lockAtBoundary,
    async lockLate(command) {
      lateAttemptObservations.push(
        Object.freeze({
          refresh: database.prepare(`
            SELECT id, status
            FROM stat_refreshes
            WHERE status = 'succeeded'
            ORDER BY completed_at_ms DESC, id DESC
            LIMIT 1
          `).get() || null,
          sealedSetCount: database.prepare(`
            SELECT COUNT(*) AS count
            FROM stat_refresh_player_game_sets
          `).get().count,
        })
      );
      return realLegality.lockLate(command);
    },
  });
  const coordinator = createLateLockCoordinator({
    targetRepository:
      createSqliteLateLockCoordinatorRepository({ database }),
    legalityService: observedLegality,
    statisticsService: statistics,
    provider: LIVE_PROVIDER,
    clock: { nowMs: () => LATE_MS },
    logger: { error() {} },
  });
  const handlers = createMatchupOccurrenceHandlers({
    statisticsService: statistics,
    lateLockCoordinator: coordinator,
    readRepository: { readWeek() {}, readMatchup() {} },
    weekService: { advance() {} },
    legalityService: observedLegality,
    resultService: { finalize() {} },
    provider: LIVE_PROVIDER,
  });
  return Object.freeze({
    coordinator,
    handlers,
    legality: realLegality,
    statistics,
  });
}

function supersedeGeneration(database) {
  database.transaction(() => {
    database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET status = 'superseded', superseded_at_ms = ?,
          version = version + 1
      WHERE league_id = ? AND season_id = ?
        AND schedule_operation_id = ? AND status = 'current'
    `).run(LATE_MS, IDS.league, IDS.season, IDS.scheduleA);
    database.prepare(`
      INSERT INTO matchup_operations (
        id, league_id, season_id, matchup_week_id, matchup_id,
        actor_user_id, operation_type, status, reason, metadata_json,
        started_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, NULL, NULL, ?, 'schedule_generate',
        'succeeded', NULL, NULL, ?, ?)
    `).run(
      IDS.scheduleB,
      IDS.league,
      IDS.season,
      IDS.user,
      LATE_MS - 1,
      LATE_MS
    );
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id, season_id, schedule_version,
        schedule_operation_id, week_one_matchup_week_id,
        week_one_starts_at_ms, status, created_at_ms,
        superseded_at_ms, version
      ) VALUES (?, ?, 2, ?, ?, ?, 'current', ?, NULL, 1)
    `).run(
      IDS.league,
      IDS.season,
      IDS.scheduleB,
      IDS.week,
      START_MS,
      LATE_MS
    );
  }).immediate();
}

function rosterMutationState(database) {
  const moved = PLAYERS.find((player) => player.startsOnBench);
  return Object.freeze({
    ownership: database.prepare(`
      SELECT roster_category, slot_number, version
      FROM player_ownerships WHERE id = ?
    `).get(moved.ownershipId),
    ownershipEvents: database.prepare(`
      SELECT COUNT(*) AS count FROM ownership_events
    `).get().count,
    activities: database.prepare(`
      SELECT COUNT(*) AS count FROM league_activity
    `).get().count,
  });
}

function statisticsEvidenceCounts(database) {
  return Object.freeze({
    succeededRefreshes: database.prepare(`
      SELECT COUNT(*) AS count FROM stat_refreshes
      WHERE status = 'succeeded'
    `).get().count,
    totals: database.prepare(`
      SELECT COUNT(*) AS count FROM player_stat_totals
    `).get().count,
    coverage: database.prepare(`
      SELECT COUNT(*) AS count
      FROM stat_refresh_player_game_coverage_entries
    `).get().count,
    observations: database.prepare(`
      SELECT COUNT(*) AS count FROM player_game_stat_observations
    `).get().count,
    sealedSets: database.prepare(`
      SELECT COUNT(*) AS count FROM stat_refresh_player_game_sets
    `).get().count,
  });
}

function lateLockEvidenceCounts(database) {
  return Object.freeze({
    lateLocks: database.prepare(`
      SELECT COUNT(*) AS count FROM matchup_roster_locks
      WHERE lock_type = 'late' AND legal = 1
    `).get().count,
    snapshots: database.prepare(`
      SELECT COUNT(*) AS count FROM stat_snapshots
    `).get().count,
    snapshotPlayers: database.prepare(`
      SELECT COUNT(*) AS count FROM stat_snapshot_players
    `).get().count,
    lockedPlayers: database.prepare(`
      SELECT COUNT(*) AS count FROM matchup_roster_players
    `).get().count,
    gameStateRoots: database.prepare(`
      SELECT COUNT(*) AS count
      FROM nhl_game_state_observation_snapshots
    `).get().count,
    gameStates: database.prepare(`
      SELECT COUNT(*) AS count FROM nhl_game_state_observations
    `).get().count,
    exclusionRoots: database.prepare(`
      SELECT COUNT(*) AS count
      FROM matchup_roster_game_exclusion_sets
    `).get().count,
    exclusions: database.prepare(`
      SELECT COUNT(*) AS count FROM matchup_roster_game_exclusions
    `).get().count,
  });
}

function assertSingleRosterMutation(database) {
  assert.deepEqual(rosterMutationState(database), {
    ownership: {
      roster_category: "Active",
      slot_number: 12,
      version: 2,
    },
    ownershipEvents: 1,
    activities: 1,
  });
}

describe("FAD-05 composed SQLite statistics-to-late-lock races", () => {
  test("persists a current scheduled refresh before one real eligible late-lock attempt", async (t) => {
    let fixture;
    try {
      fixture = createFixture(t);
    } catch (error) {
      assert.fail(
        `Integrated fixture setup failed: ${error.message}; ` +
          `cause=${error.cause?.message || "none"}`
      );
    }
    const moved = moveRosterToLegal(fixture.database);
    assert.equal(moved.ownership.version, 2);
    const observations = [];
    const services = createIntegratedServices(fixture.database, {
      lateAttemptObservations: observations,
    });

    const result = await services.handlers["matchup:statistics_refresh"](
      fixture.execution,
      LATE_MS
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.playerCount, 18);
    assert.deepEqual(observations, [{
      refresh: { id: result.refreshId, status: "succeeded" },
      sealedSetCount: 1,
    }]);
    assert.deepEqual(statisticsEvidenceCounts(fixture.database), {
      succeededRefreshes: 1,
      totals: 18,
      coverage: 18,
      observations: 0,
      sealedSets: 1,
    });
    assert.deepEqual(lateLockEvidenceCounts(fixture.database), {
      lateLocks: 1,
      snapshots: 1,
      snapshotPlayers: 18,
      lockedPlayers: 18,
      gameStateRoots: 1,
      gameStates: 0,
      exclusionRoots: 1,
      exclusions: 0,
    });
    assertSingleRosterMutation(fixture.database);
  });

  test("superseded and lost scheduled executions seal no statistics or late-lock evidence", async (t) => {
    for (const disposition of ["superseded", "lease_lost"]) {
      await t.test(disposition, async (subtest) => {
        const fixture = createFixture(subtest);
        moveRosterToLegal(fixture.database);
        const observations = [];
        const services = createIntegratedServices(fixture.database, {
          lateAttemptObservations: observations,
          onProviderFetch: async () => {
            if (disposition === "superseded") {
              supersedeGeneration(fixture.database);
            } else {
              fixture.database.prepare(`
                UPDATE job_runs SET lease_token = 'replacement-token'
                WHERE id = ?
              `).run(IDS.run);
            }
          },
        });

        let failure;
        await assert.rejects(
          services.handlers["matchup:statistics_refresh"](
            fixture.execution,
            LATE_MS
          ),
          (error) => {
            failure = error;
            return true;
          }
        );
        assert.equal(
          classifyMatchupOccurrenceExecutionGuardError(failure),
          disposition === "superseded"
            ? MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
                .generationSuperseded
            : MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
        );

        assert.deepEqual(observations, []);
        assert.deepEqual(statisticsEvidenceCounts(fixture.database), {
          succeededRefreshes: 0,
          totals: 0,
          coverage: 0,
          observations: 0,
          sealedSets: 0,
        });
        assert.deepEqual(lateLockEvidenceCounts(fixture.database), {
          lateLocks: 0,
          snapshots: 0,
          snapshotPlayers: 0,
          lockedPlayers: 0,
          gameStateRoots: 0,
          gameStates: 0,
          exclusionRoots: 0,
          exclusions: 0,
        });
        assertSingleRosterMutation(fixture.database);
      });
    }
  });

  test("racing and replayed late-lock attempts converge on one evidence set without repeating the roster mutation", async (t) => {
    const fixture = createFixture(t);
    moveRosterToLegal(fixture.database);
    const pendingGameReads = [];
    const gameStateProvider = {
      async fetchGameStates({ games }) {
        const result = () => ({
          provider: LIVE_PROVIDER,
          sourceVersion: "integrated-game-state-v1",
          observedAtMs: LATE_MS,
          games: games.map((game) => ({
            ...game,
            observedGameState: "in_progress",
          })),
        });
        if (pendingGameReads.length >= 2) return result();
        return new Promise((resolve) => {
          pendingGameReads.push({ resolve, result });
          if (pendingGameReads.length === 2) {
            queueMicrotask(() => {
              for (const pending of pendingGameReads) {
                pending.resolve(pending.result());
              }
            });
          }
        });
      },
    };
    const services = createIntegratedServices(fixture.database, {
      coverageMode: "expected_game",
      gameStateProvider,
    });
    await services.statistics.refresh();
    const command = Object.freeze({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      teamId: IDS.home,
      provider: LIVE_PROVIDER,
      lockId: IDS.lock,
      nowMs: LATE_MS,
    });

    const results = await Promise.all([
      services.legality.lockLate(command),
      services.legality.lockLate(command),
    ]);

    assert.deepEqual(
      results.map((result) => result.replayed).sort(),
      [false, true]
    );
    assert.equal(pendingGameReads.length, 2);
    assert.deepEqual(lateLockEvidenceCounts(fixture.database), {
      lateLocks: 1,
      snapshots: 1,
      snapshotPlayers: 18,
      lockedPlayers: 18,
      gameStateRoots: 1,
      gameStates: 1,
      exclusionRoots: 1,
      exclusions: 18,
    });
    assertSingleRosterMutation(fixture.database);

    const replay = await services.legality.lockLate(command);
    assert.equal(replay.replayed, true);
    assert.deepEqual(lateLockEvidenceCounts(fixture.database), {
      lateLocks: 1,
      snapshots: 1,
      snapshotPlayers: 18,
      lockedPlayers: 18,
      gameStateRoots: 1,
      gameStates: 1,
      exclusionRoots: 1,
      exclusions: 18,
    });
    assertSingleRosterMutation(fixture.database);
    assert.deepEqual(fixture.database.pragma("foreign_key_check"), []);
  });
});
