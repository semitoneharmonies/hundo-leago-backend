const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  MATCHUP_STATUSES,
  MATCHUP_WEEK_CODES,
  WEEK_STATUSES,
  deriveNextWeekTransition,
  isManagerRosterWriteOpen,
  validateWeekBoundaries,
} = require("../../src/domain/matchups/matchupWeekPolicy");
const {
  buildMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  createMatchupWeekService,
} = require("../../src/application/services/matchups/createMatchupWeekService");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupWeekRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupWeekRepository");
const {
  MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS,
  classifyMatchupOccurrenceExecutionGuardError,
  createSqliteMatchupOccurrenceExecutionGuard,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupOccurrenceExecutionGuard");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const DEFAULT_BOUNDARIES = Object.freeze({
  startsAtMs: 1000,
  baselineAtMs: 1100,
  locksAtMs: 1200,
  endsAtMs: 2000,
  rollsOverAtMs: 2100,
});
const GUARDED_BOUNDARIES = Object.freeze({
  startsAtMs: 2_000_000_000,
  baselineAtMs: 2_003_600_000,
  locksAtMs: 2_057_600_000,
  endsAtMs: 2_604_800_000,
  rollsOverAtMs: 2_604_800_000,
});
const LEASE_OWNER = "matchup-week-generation-test";
const LEASE_TOKEN = "matchup-week-generation-lease-token";
const LEASE_EXPIRES_AT_MS = GUARDED_BOUNDARIES.endsAtMs + 1_000_000;
const IDS = Object.freeze({
  league: uuid(1),
  otherLeague: uuid(2),
  season: uuid(3),
  week: uuid(4),
  home: uuid(5),
  away: uuid(6),
  matchup: uuid(7),
  homeUser: uuid(8),
  awayUser: uuid(9),
  homeMembership: uuid(10),
  awayMembership: uuid(11),
  homeAssignment: uuid(12),
  awayAssignment: uuid(13),
  readiness: uuid(14),
  fad: uuid(15),
  scheduleA: uuid(16),
  scheduleB: uuid(17),
  runA: uuid(18),
  bindingA: uuid(19),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seed(database, boundaries = DEFAULT_BOUNDARIES) {
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'active', ?, 1, 1, 1)"
  ).run(IDS.league, "Week League", "week league", "America/Vancouver");
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'active', ?, 1, 1, 1)"
  ).run(IDS.otherLeague, "Other League", "other league", "America/Vancouver");
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  );
  insertTeam.run(IDS.home, IDS.league, "Home", "home");
  insertTeam.run(IDS.away, IDS.league, "Away", "away");
  database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, " +
      "starts_at_ms, baseline_at_ms, locks_at_ms, ends_at_ms, rolls_over_at_ms, " +
      "status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, ?, ?, ?, ?, ?, 'scheduled', 1, 1, 1)"
  ).run(
    IDS.week,
    IDS.league,
    IDS.season,
    boundaries.startsAtMs,
    boundaries.baselineAtMs,
    boundaries.locksAtMs,
    boundaries.endsAtMs,
    boundaries.rollsOverAtMs
  );
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, " +
      "away_team_id, home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'scheduled', 1, 1, 1)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.home, IDS.away);
}

function createRuntime(
  t,
  {
    boundaries = DEFAULT_BOUNDARIES,
    failBeforeCommit = () => false,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-03-"));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "week.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-03-test",
    now: () => 1,
  });
  seed(connection.database, boundaries);
  const repository = createSqliteMatchupWeekRepository({
    database: connection.database,
    beforeCommit() {
      if (failBeforeCommit()) throw new Error("late failure");
    },
  });
  let nextId = 500;
  const service = createMatchupWeekService({ repository, createId: () => uuid(nextId++) });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { database: connection.database, repository, service };
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
    IDS.homeUser,
    startedAtMs,
    completedAtMs
  );
}

function seedGenerationAuthority(database) {
  const insertUser = database.prepare(`
    INSERT INTO users (
      id,
      email_normalized,
      email_display,
      display_name,
      display_name_normalized,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 1)
  `);
  insertUser.run(
    IDS.homeUser,
    "home-week@example.test",
    "home-week@example.test",
    "Home Week Manager",
    "home week manager"
  );
  insertUser.run(
    IDS.awayUser,
    "away-week@example.test",
    "away-week@example.test",
    "Away Week Manager",
    "away week manager"
  );

  const insertMembership = database.prepare(`
    INSERT INTO league_memberships (
      id,
      league_id,
      user_id,
      permission_category,
      status,
      joined_at_ms,
      ended_at_ms,
      created_at_ms,
      updated_at_ms,
      version
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
      id,
      league_id,
      team_id,
      user_id,
      membership_id,
      assigned_by_user_id,
      replaces_assignment_id,
      status,
      assigned_at_ms,
      accepted_at_ms,
      ended_at_ms,
      version
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
    SET commissioner_membership_id = ?,
        current_season_id = ?,
        updated_at_ms = 2,
        version = version + 1
    WHERE id = ?
  `).run(
    IDS.homeMembership,
    IDS.season,
    IDS.league
  );
}

function seedCompletedFadGate(database) {
  const candidateDeadlineAtMs =
    GUARDED_BOUNDARIES.startsAtMs - 604_800_000;
  const openedAtMs = candidateDeadlineAtMs - 200_000_000;
  const completedAtMs = GUARDED_BOUNDARIES.startsAtMs - 1;
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
    ) VALUES (?, ?, ?, 'fad-readiness:matchup-week',
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
    ) VALUES (?, ?, ?, ?, 'fad-readiness:matchup-week', ?, ?, NULL,
      2, 'cards_open', 'no_draft_inaugural', NULL, NULL, NULL,
      'inaugural matchup-week fixture', 'system', ?, ?, ?, ?, NULL,
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
    GUARDED_BOUNDARIES.startsAtMs,
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

function insertClaimedBaselineOccurrence(database) {
  const jobType = "matchup:baseline";
  const occurrenceKey = buildMatchupOccurrenceKey({
    jobType,
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    scheduleOperationId: IDS.scheduleA,
    scheduleVersion: 1,
    scheduledForMs: GUARDED_BOUNDARIES.baselineAtMs,
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
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, 20,
      NULL, NULL, NULL, 10, 20, 2, ?, NULL)
  `).run(
    IDS.runA,
    IDS.league,
    IDS.season,
    jobType,
    occurrenceKey,
    GUARDED_BOUNDARIES.baselineAtMs,
    LEASE_OWNER,
    LEASE_EXPIRES_AT_MS,
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
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, 10, 1)
  `).run(
    IDS.bindingA,
    IDS.league,
    IDS.season,
    IDS.runA,
    jobType,
    IDS.scheduleA,
    IDS.week
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
    scheduledForMs: GUARDED_BOUNDARIES.baselineAtMs,
    seasonId: IDS.season,
    weekId: IDS.week,
  });
}

function seedGenerationSafetyState(database) {
  seedGenerationAuthority(database);
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
    GUARDED_BOUNDARIES.startsAtMs
  );
  seedCompletedFadGate(database);
  return insertClaimedBaselineOccurrence(database);
}

function createGenerationRuntime(t) {
  const base = createRuntime(t, {
    boundaries: GUARDED_BOUNDARIES,
  });
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
  const repository = createSqliteMatchupWeekRepository({
    database: base.database,
    occurrenceExecutionGuard,
  });
  const service = createMatchupWeekService({
    repository,
    createId: () => uuid(900),
  });
  return {
    ...base,
    execution,
    guardCalls,
    repository,
    service,
  };
}

function transitionState(database) {
  return {
    matchup: database.prepare(`
      SELECT status, version
      FROM matchups
      WHERE id = ?
    `).get(IDS.matchup),
    transitionCount: database.prepare(`
      SELECT COUNT(*) AS count
      FROM matchup_operations
      WHERE operation_type = 'week_transition'
    `).get().count,
    week: database.prepare(`
      SELECT status, version
      FROM matchup_weeks
      WHERE id = ?
    `).get(IDS.week),
  };
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the guarded matchup-week transition to fail.");
}

function supersedeGeneration(database) {
  const changedAtMs = GUARDED_BOUNDARIES.startsAtMs - 10;
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
      changedAtMs - 1,
      changedAtMs
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
      GUARDED_BOUNDARIES.startsAtMs,
      changedAtMs
    );
  });
  transaction.immediate();
}

describe("M6-03 matchup-week policy", () => {
  test("publishes only the approved week and matchup states", () => {
    assert.deepEqual(WEEK_STATUSES, [
      "scheduled", "baseline_ready", "live", "awaiting_data", "final",
      "correction_required", "cancelled",
    ]);
    assert.deepEqual(MATCHUP_STATUSES, [
      "scheduled", "live", "awaiting_data", "final", "postponed", "cancelled",
      "correction_required",
    ]);
  });

  test("uses inclusive baseline, lock, and end boundaries", () => {
    const boundaries = {
      startsAtMs: 1000,
      baselineAtMs: 1100,
      locksAtMs: 1200,
      endsAtMs: 2000,
      rollsOverAtMs: 2100,
    };
    assert.deepEqual(validateWeekBoundaries(boundaries), boundaries);
    assert.equal(isManagerRosterWriteOpen({ nowMs: 1199, locksAtMs: 1200 }), true);
    assert.equal(isManagerRosterWriteOpen({ nowMs: 1200, locksAtMs: 1200 }), false);
    assert.equal(
      deriveNextWeekTransition({ status: "scheduled", nowMs: 1100, ...boundaries }).toStatus,
      "baseline_ready"
    );
    assert.equal(
      deriveNextWeekTransition({ status: "baseline_ready", nowMs: 1200, ...boundaries }).toStatus,
      "live"
    );
    assert.equal(
      deriveNextWeekTransition({ status: "live", nowMs: 2000, ...boundaries }).toStatus,
      "awaiting_data"
    );
  });

  test("rejects early, malformed, and terminal transitions", () => {
    const input = {
      startsAtMs: 1000,
      baselineAtMs: 1100,
      locksAtMs: 1200,
      endsAtMs: 2000,
      rollsOverAtMs: 2100,
    };
    assert.throws(
      () => deriveNextWeekTransition({ status: "scheduled", nowMs: 1099, ...input }),
      { code: MATCHUP_WEEK_CODES.transitionEarly }
    );
    assert.throws(
      () => deriveNextWeekTransition({ status: "final", nowMs: 3000, ...input }),
      { code: MATCHUP_WEEK_CODES.transitionTerminal }
    );
    assert.throws(
      () => validateWeekBoundaries({ ...input, locksAtMs: 1000 }),
      { code: MATCHUP_WEEK_CODES.inputInvalid }
    );
  });
});

describe("M6-03 atomic matchup-week transitions", () => {
  test("advances one boundary at a time and replays the same operation without writes", (t) => {
    const { database, service } = createRuntime(t);
    const scope = { leagueId: IDS.league, seasonId: IDS.season, weekId: IDS.week };
    assert.equal(service.rosterWriteState({ ...scope, nowMs: 1199 }).open, true);
    assert.equal(service.rosterWriteState({ ...scope, nowMs: 1200 }).open, false);
    assert.throws(() => service.advance({ ...scope, nowMs: 1099 }), {
      code: MATCHUP_WEEK_CODES.transitionEarly,
    });

    const first = service.advance({ ...scope, operationId: uuid(600), nowMs: 1100 });
    assert.equal(first.week.status, "baseline_ready");
    assert.equal(first.replayed, false);
    const replay = service.advance({ ...scope, operationId: uuid(600), nowMs: 1100 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.week.version, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_operations").get().count, 1);

    assert.equal(
      service.advance({ ...scope, operationId: uuid(601), nowMs: 1200 }).week.status,
      "live"
    );
    assert.equal(database.prepare("SELECT status FROM matchups").get().status, "live");
    assert.equal(
      service.advance({ ...scope, operationId: uuid(602), nowMs: 2000 }).week.status,
      "awaiting_data"
    );
    assert.equal(database.prepare("SELECT status FROM matchups").get().status, "awaiting_data");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("makes compare-and-set single-winner and fails cross-league scope closed", (t) => {
    const { database, repository, service } = createRuntime(t);
    const command = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      operationId: uuid(700),
      expectedVersion: 1,
      fromStatus: "scheduled",
      toStatus: "baseline_ready",
      matchupStatus: null,
      effectiveAtMs: 1100,
      nowMs: 1100,
    };
    assert.equal(repository.transitionWeek(command).replayed, false);
    assert.throws(
      () => repository.transitionWeek({ ...command, operationId: uuid(701) }),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    assert.throws(
      () => service.rosterWriteState({
        leagueId: IDS.otherLeague,
        seasonId: IDS.season,
        weekId: IDS.week,
        nowMs: 1,
      }),
      { code: "MATCHUP_WEEK_MISSING" }
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_operations").get().count, 1);
  });

  test("rolls the state, matchup, and operation back after a late failure", (t) => {
    let fail = true;
    const { database, service } = createRuntime(t, { failBeforeCommit: () => fail });
    const scope = { leagueId: IDS.league, seasonId: IDS.season, weekId: IDS.week };
    assert.throws(() => service.advance({ ...scope, operationId: uuid(800), nowMs: 1100 }));
    assert.deepEqual(database.prepare("SELECT status, version FROM matchup_weeks").get(), {
      status: "scheduled",
      version: 1,
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_operations").get().count, 0);
    fail = false;
    assert.equal(
      service.advance({ ...scope, operationId: uuid(800), nowMs: 1100 }).week.status,
      "baseline_ready"
    );
  });
});

describe("FAD-05 generation-safe matchup-week transitions", () => {
  test("forwards the exact occurrence execution identity and advances only the current generation", (t) => {
    const {
      database,
      execution,
      guardCalls,
      service,
    } = createGenerationRuntime(t);
    const result = service.advance({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      operationId: uuid(901),
      nowMs: GUARDED_BOUNDARIES.baselineAtMs,
      occurrenceExecution: execution,
    });

    assert.equal(result.replayed, false);
    assert.equal(result.week.status, "baseline_ready");
    assert.equal(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0], execution);
    assert.deepEqual(transitionState(database), {
      matchup: {
        status: "scheduled",
        version: 1,
      },
      transitionCount: 1,
      week: {
        status: "baseline_ready",
        version: 2,
      },
    });
  });

  test("runs the occurrence guard before the repository replay read", (t) => {
    const { database, service } = createRuntime(t);
    const operationId = uuid(902);
    service.advance({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      operationId,
      nowMs: DEFAULT_BOUNDARIES.baselineAtMs,
    });

    const order = [];
    const instrumentedDatabase = {
      prepare(sql) {
        const statement = database.prepare(sql);
        const label = sql.includes("FROM matchup_operations")
          ? "operation_read"
          : sql.includes("FROM matchup_weeks")
            ? "week_read"
            : "other_statement";
        return {
          all(...args) {
            order.push(label);
            return statement.all(...args);
          },
          run(...args) {
            order.push(label);
            return statement.run(...args);
          },
        };
      },
      transaction: database.transaction.bind(database),
    };
    const occurrenceExecution = Object.freeze({ marker: "same-object" });
    const guardedRepository = createSqliteMatchupWeekRepository({
      database: instrumentedDatabase,
      occurrenceExecutionGuard: {
        assertCurrent(context) {
          order.push("guard");
          assert.strictEqual(context, occurrenceExecution);
        },
      },
    });

    const replay = guardedRepository.transitionWeek({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      operationId,
      occurrenceExecution,
    });

    assert.equal(replay.replayed, true);
    assert.deepEqual(order, [
      "guard",
      "operation_read",
      "week_read",
    ]);
  });

  test("rejects a superseded schedule generation without a partial transition", (t) => {
    const {
      database,
      execution,
      service,
    } = createGenerationRuntime(t);
    supersedeGeneration(database);
    const before = transitionState(database);

    const error = captureError(() =>
      service.advance({
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekId: IDS.week,
        operationId: uuid(903),
        nowMs: GUARDED_BOUNDARIES.baselineAtMs,
        occurrenceExecution: execution,
      })
    );

    assert.equal(error.code, "REPOSITORY_VERSION_CONFLICT");
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.generationSuperseded
    );
    assert.deepEqual(transitionState(database), before);
    assert.equal(database.inTransaction, false);
  });

  test("rejects a lost lease without a partial transition", (t) => {
    const {
      database,
      execution,
      service,
    } = createGenerationRuntime(t);
    database.prepare(`
      UPDATE job_runs
      SET lease_token = 'replacement-matchup-week-token'
      WHERE id = ?
    `).run(IDS.runA);
    const before = transitionState(database);

    const error = captureError(() =>
      service.advance({
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekId: IDS.week,
        operationId: uuid(904),
        nowMs: GUARDED_BOUNDARIES.baselineAtMs,
        occurrenceExecution: execution,
      })
    );

    assert.equal(error.code, "REPOSITORY_VERSION_CONFLICT");
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
    );
    assert.deepEqual(transitionState(database), before);
    assert.equal(database.inTransaction, false);
  });

  test("guards an exact replay and rolls back when its lease was lost", (t) => {
    const {
      database,
      execution,
      guardCalls,
      service,
    } = createGenerationRuntime(t);
    const input = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      operationId: uuid(905),
      nowMs: GUARDED_BOUNDARIES.baselineAtMs,
      occurrenceExecution: execution,
    };
    assert.equal(service.advance(input).replayed, false);
    const before = transitionState(database);
    database.prepare(`
      UPDATE job_runs
      SET lease_token = 'replacement-replay-token'
      WHERE id = ?
    `).run(IDS.runA);

    const error = captureError(() => service.advance(input));

    assert.equal(error.code, "REPOSITORY_VERSION_CONFLICT");
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(error),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS.leaseLost
    );
    assert.equal(guardCalls.length, 2);
    assert.strictEqual(guardCalls[1], execution);
    assert.deepEqual(transitionState(database), before);
  });

  test("fails a disappeared guarded replay closed before any transition", (t) => {
    const { database, repository } = createRuntime(t);
    const occurrenceExecution = Object.freeze({ marker: "disappeared-replay" });
    const guardedRepository = createSqliteMatchupWeekRepository({
      database,
      occurrenceExecutionGuard: {
        assertCurrent(context) {
          assert.strictEqual(context, occurrenceExecution);
        },
      },
    });
    const service = createMatchupWeekService({
      repository: {
        readWeek: guardedRepository.readWeek,
        readTransitionOperation(input) {
          return Object.freeze({ id: input.operationId });
        },
        transitionWeek: guardedRepository.transitionWeek,
      },
      createId: () => uuid(906),
    });
    const before = transitionState(database);

    assert.throws(
      () => service.advance({
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekId: IDS.week,
        operationId: uuid(906),
        occurrenceExecution,
      }),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    assert.deepEqual(transitionState(database), before);
    assert.equal(repository.readTransitionOperation({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      operationId: uuid(906),
    }), null);
  });

  test("requires a valid guard only when an occurrence context is used", (t) => {
    const { database, service } = createRuntime(t);
    const before = transitionState(database);

    assert.throws(
      () => createSqliteMatchupWeekRepository({
        database,
        occurrenceExecutionGuard: {},
      }),
      TypeError
    );
    assert.throws(
      () => service.advance({
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekId: IDS.week,
        operationId: uuid(907),
        nowMs: DEFAULT_BOUNDARIES.baselineAtMs,
        occurrenceExecution: Object.freeze({}),
      }),
      { code: "REPOSITORY_ARGUMENT_INVALID" }
    );
    assert.deepEqual(transitionState(database), before);

    const manual = service.advance({
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      operationId: uuid(908),
      nowMs: DEFAULT_BOUNDARIES.baselineAtMs,
    });
    assert.equal(manual.replayed, false);
    assert.equal(manual.week.status, "baseline_ready");
  });
});
