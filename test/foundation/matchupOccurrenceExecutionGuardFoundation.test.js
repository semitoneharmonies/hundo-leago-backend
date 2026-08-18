const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

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
  REPOSITORY_ERROR_CODES,
} = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");
const {
  MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS,
  classifyMatchupOccurrenceExecutionGuardError,
  createSqliteMatchupOccurrenceExecutionGuard,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupOccurrenceExecutionGuard");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const WEEK_START_MS = 2_000_000_000;
const BASELINE_MS = WEEK_START_MS + 3_600_000;
const LOCK_MS = WEEK_START_MS + 57_600_000;
const WEEK_END_MS = WEEK_START_MS + 604_800_000;
const LEASE_EXPIRES_AT_MS = WEEK_END_MS + 1_000_000;
const LEASE_OWNER = "matchup-occurrence-guard-test";
const LEASE_TOKEN = "matchup-occurrence-guard-lease-token";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  week: uuid(3),
  scheduleA: uuid(4),
  user: uuid(5),
  membership: uuid(6),
  team: uuid(7),
  assignment: uuid(8),
  readiness: uuid(9),
  fad: uuid(10),
  runA: uuid(11),
  bindingA: uuid(12),
  scheduleB: uuid(13),
  scheduleA2: uuid(14),
  runA2: uuid(15),
  bindingA2: uuid(16),
});

function seedLeague(database) {
  database.prepare(`
    INSERT INTO leagues (
      id,
      name,
      name_normalized,
      status,
      timezone,
      commissioner_membership_id,
      current_season_id,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (?, 'Guard League', 'guard league', 'active',
      'America/Vancouver', NULL, NULL, 1, 1, 1)
  `).run(IDS.league);
  database.prepare(`
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
    ) VALUES (?, 'guard@example.test', 'guard@example.test',
      'Guard Manager', 'guard manager', 'active', 1, 1, 1)
  `).run(IDS.user);
  database.prepare(`
    INSERT INTO seasons (
      id,
      league_id,
      label,
      nhl_season_key,
      status,
      regular_season_starts_at_ms,
      regular_season_ends_at_ms,
      fantasy_playoffs_start_at_ms,
      fantasy_playoffs_end_at_ms,
      created_at_ms,
      updated_at_ms,
      version,
      free_agent_draft_completed_at_ms
    ) VALUES (?, ?, '2026-27', '20262027', 'active', ?, ?,
      ?, ?, 1, 1, 1, NULL)
  `).run(
    IDS.season,
    IDS.league,
    WEEK_START_MS,
    WEEK_END_MS + 20 * 604_800_000,
    WEEK_END_MS + 16 * 604_800_000,
    WEEK_END_MS + 20 * 604_800_000
  );
  database.prepare(`
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
    ) VALUES (?, ?, ?, 'commissioner', 'active', 1, NULL,
      1, 1, 1)
  `).run(IDS.membership, IDS.league, IDS.user);
  database.prepare(`
    INSERT INTO teams (
      id,
      league_id,
      name,
      name_normalized,
      status,
      primary_colour,
      secondary_colour,
      logo_reference,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (?, ?, 'Guard Team', 'guard team', 'active',
      NULL, NULL, NULL, 1, 1, 1)
  `).run(IDS.team, IDS.league);
  database.prepare(`
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
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'accepted', 1, 1,
      NULL, 1)
  `).run(
    IDS.assignment,
    IDS.league,
    IDS.team,
    IDS.user,
    IDS.membership,
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
  database.prepare(`
    INSERT INTO matchup_weeks (
      id,
      league_id,
      season_id,
      week_key,
      sequence,
      starts_at_ms,
      baseline_at_ms,
      locks_at_ms,
      ends_at_ms,
      rolls_over_at_ms,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (?, ?, ?, '2026-W01', 1, ?, ?, ?, ?, ?,
      'scheduled', 3, 3, 1)
  `).run(
    IDS.week,
    IDS.league,
    IDS.season,
    WEEK_START_MS,
    BASELINE_MS,
    LOCK_MS,
    WEEK_END_MS,
    WEEK_END_MS
  );
  insertScheduleOperation(
    database,
    IDS.scheduleA,
    3,
    4
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
    ) VALUES (?, ?, 1, ?, ?, ?, 'current', 4, NULL, 1)
  `).run(
    IDS.league,
    IDS.season,
    IDS.scheduleA,
    IDS.week,
    WEEK_START_MS
  );
}

function insertScheduleOperation(
  database,
  operationId,
  startedAtMs,
  completedAtMs
) {
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
    IDS.user,
    startedAtMs,
    completedAtMs
  );
}

function seedCompletedFad(database) {
  const candidateDeadlineAtMs =
    WEEK_START_MS - 604_800_000;
  const openedAtMs = candidateDeadlineAtMs - 200_000_000;
  const completedAtMs = WEEK_START_MS - 1;
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
    ) VALUES (?, ?, ?, 'fad-readiness:guard',
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
    ) VALUES (?, ?, ?, ?, 'fad-readiness:guard', ?, ?, NULL,
      1, 'cards_open', 'no_draft_inaugural', NULL, NULL, NULL,
      'inaugural guard fixture', 'system', ?, ?, ?, ?, NULL,
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
    WEEK_START_MS,
    openedAtMs,
    openedAtMs
  );

  // Later lifecycle slices own the normal forward transitions. This fixture
  // bypasses only that transition trigger, then exercises the real schema-30
  // FAD/season completion relationship read by the execution guard.
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

function insertClaimedOccurrence(
  database,
  {
    bindingId,
    runId,
    scheduleOperationId,
    scheduleVersion,
    scheduledForMs = LOCK_MS,
  }
) {
  const jobType = "matchup:lock";
  const occurrenceKey = buildMatchupOccurrenceKey({
    jobType,
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId: IDS.week,
    scheduleOperationId,
    scheduleVersion,
    scheduledForMs,
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
    runId,
    IDS.league,
    IDS.season,
    jobType,
    occurrenceKey,
    scheduledForMs,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 10, 1)
  `).run(
    bindingId,
    IDS.league,
    IDS.season,
    runId,
    jobType,
    scheduleOperationId,
    scheduleVersion,
    IDS.week
  );
  return Object.freeze({
    bindingId,
    claimedJobVersion: 2,
    jobType,
    leagueId: IDS.league,
    leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    leaseOwner: LEASE_OWNER,
    leaseToken: LEASE_TOKEN,
    occurrenceKey,
    runId,
    scheduleOperationId,
    scheduleVersion,
    scheduledForMs,
    seasonId: IDS.season,
    weekId: IDS.week,
  });
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-matchup-execution-guard-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "guard.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId:
      "matchup-occurrence-execution-guard-foundation",
    now: () => 1,
  });
  assert.equal(
    connection.database.prepare(`
      SELECT MAX(migration_id) AS migration_id
      FROM schema_migrations
    `).get().migration_id,
    52
  );
  seedLeague(connection.database);
  seedSchedule(connection.database);
  seedCompletedFad(connection.database);
  const execution = insertClaimedOccurrence(
    connection.database,
    {
      bindingId: IDS.bindingA,
      runId: IDS.runA,
      scheduleOperationId: IDS.scheduleA,
      scheduleVersion: 1,
    }
  );
  const guard =
    createSqliteMatchupOccurrenceExecutionGuard({
      database: connection.database,
    });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  return {
    database: connection.database,
    execution,
    guard,
  };
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the execution guard to fail closed.");
}

function assertCurrentInImmediate(
  database,
  guard,
  execution
) {
  return database.transaction(() =>
    guard.assertCurrent(execution)
  ).immediate();
}

function assertGuardReason(
  error,
  { repositoryCode, reasonCode }
) {
  assert.equal(error.code, repositoryCode);
  assert.equal(
    classifyMatchupOccurrenceExecutionGuardError(error),
    reasonCode
  );
  assert.equal(error.details.reasonCode, reasonCode);
}

function supersedeAndReplaceGeneration(
  database,
  {
    completedAtMs,
    newScheduleOperationId,
    newScheduleVersion,
    newWeekStartsAtMs,
  }
) {
  const transaction = database.transaction(() => {
    assert.equal(
      database.prepare(`
        UPDATE season_matchup_schedule_generations
        SET status = 'superseded',
            superseded_at_ms = ?,
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND status = 'current'
      `).run(
        completedAtMs,
        IDS.league,
        IDS.season
      ).changes,
      1
    );
    const baselineAtMs =
      newWeekStartsAtMs + 3_600_000;
    const locksAtMs =
      newWeekStartsAtMs + 57_600_000;
    const endsAtMs =
      newWeekStartsAtMs + 604_800_000;
    assert.equal(
      database.prepare(`
        UPDATE matchup_weeks
        SET starts_at_ms = ?,
            baseline_at_ms = ?,
            locks_at_ms = ?,
            ends_at_ms = ?,
            rolls_over_at_ms = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND id = ?
      `).run(
        newWeekStartsAtMs,
        baselineAtMs,
        locksAtMs,
        endsAtMs,
        endsAtMs,
        completedAtMs,
        IDS.league,
        IDS.season,
        IDS.week
      ).changes,
      1
    );
    insertScheduleOperation(
      database,
      newScheduleOperationId,
      completedAtMs - 1,
      completedAtMs
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
      ) VALUES (?, ?, ?, ?, ?, ?, 'current', ?, NULL, 1)
    `).run(
      IDS.league,
      IDS.season,
      newScheduleVersion,
      newScheduleOperationId,
      IDS.week,
      newWeekStartsAtMs,
      completedAtMs
    );
  });
  transaction.immediate();
}

function guardedState(database) {
  return Object.freeze({
    binding: database.prepare(`
      SELECT *
      FROM matchup_schedule_job_bindings
      WHERE id = ?
    `).get(IDS.bindingA),
    fad: database.prepare(`
      SELECT *
      FROM free_agent_drafts
      WHERE id = ?
    `).get(IDS.fad),
    generation: database.prepare(`
      SELECT *
      FROM season_matchup_schedule_generations
      WHERE schedule_operation_id = ?
    `).get(IDS.scheduleA),
    job: database.prepare(`
      SELECT *
      FROM job_runs
      WHERE id = ?
    `).get(IDS.runA),
    season: database.prepare(`
      SELECT *
      FROM seasons
      WHERE id = ?
    `).get(IDS.season),
    week: database.prepare(`
      SELECT *
      FROM matchup_weeks
      WHERE id = ?
    `).get(IDS.week),
  });
}

describe(
  "current-schema matchup occurrence execution guard",
  () => {
    test("requires the caller's immediate effect transaction", (t) => {
      const { execution, guard } = createRuntime(t);
      const error = captureError(() =>
        guard.assertCurrent(execution)
      );
      assertGuardReason(error, {
        repositoryCode:
          REPOSITORY_ERROR_CODES.scopeRequired,
        reasonCode:
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .evidenceInvariant,
      });
    });

    test("accepts exact current claimed evidence without mutating state", (t) => {
      const { database, execution, guard } =
        createRuntime(t);
      assert.equal(
        Object.isFrozen(
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
        ),
        true
      );
      const before = guardedState(database);
      const totalChangesBefore = database.prepare(`
        SELECT total_changes() AS total_changes
      `).get().total_changes;

      const verified = assertCurrentInImmediate(
        database,
        guard,
        execution
      );

      assert.deepEqual(verified, execution);
      assert.equal(Object.isFrozen(verified), true);
      assert.deepEqual(guardedState(database), before);
      assert.equal(
        database.prepare(`
          SELECT total_changes() AS total_changes
        `).get().total_changes,
        totalChangesBefore
      );
    });

    test("accepts an exact migrated legacy key through its immutable binding", (t) => {
      const { database, execution, guard } =
        createRuntime(t);
      const legacyKey =
        `${execution.jobType}:${execution.leagueId}:` +
        `${execution.seasonId}:${execution.weekId}:` +
        execution.scheduledForMs;
      database.prepare(`
        UPDATE job_runs
        SET occurrence_key = ?
        WHERE id = ?
      `).run(legacyKey, execution.runId);
      const legacyExecution = Object.freeze({
        ...execution,
        occurrenceKey: legacyKey,
      });

      assert.deepEqual(
        assertCurrentInImmediate(
          database,
          guard,
          legacyExecution
        ),
        legacyExecution
      );
      assert.deepEqual(
        database.prepare(`
          SELECT schedule_operation_id, schedule_version,
                 owning_matchup_week_id, version
          FROM matchup_schedule_job_bindings
          WHERE id = ?
        `).get(execution.bindingId),
        {
          owning_matchup_week_id: execution.weekId,
          schedule_operation_id:
            execution.scheduleOperationId,
          schedule_version: execution.scheduleVersion,
          version: 1,
        }
      );
    });

    test("rejects malformed and mismatched identifiers with a closed input contract", (t) => {
      const { database, execution, guard } =
        createRuntime(t);
      const malformed = captureError(() =>
        assertCurrentInImmediate(database, guard, {
          ...execution,
          runId: "not-a-stable-id",
        })
      );
      assertGuardReason(malformed, {
        repositoryCode:
          REPOSITORY_ERROR_CODES.argumentInvalid,
        reasonCode:
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .evidenceInvariant,
      });

      const extraField = captureError(() =>
        assertCurrentInImmediate(database, guard, {
          ...execution,
          unexpected: true,
        })
      );
      assertGuardReason(extraField, {
        repositoryCode:
          REPOSITORY_ERROR_CODES.argumentInvalid,
        reasonCode:
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .evidenceInvariant,
      });

      const mismatched = captureError(() =>
        assertCurrentInImmediate(database, guard, {
          ...execution,
          bindingId: uuid(999),
        })
      );
      assertGuardReason(mismatched, {
        repositoryCode:
          REPOSITORY_ERROR_CODES.schemaIncompatible,
        reasonCode:
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .evidenceInvariant,
      });
    });

    test("classifies changed lease tokens and versions only as lease loss", async (t) => {
      await t.test("changed lease token", (child) => {
        const { database, execution, guard } =
          createRuntime(child);
        database.prepare(`
          UPDATE job_runs
          SET lease_token = 'replacement-lease-token'
          WHERE id = ?
        `).run(IDS.runA);
        const error = captureError(() =>
          assertCurrentInImmediate(
            database,
            guard,
            execution
          )
        );
        assertGuardReason(error, {
          repositoryCode:
            REPOSITORY_ERROR_CODES.versionConflict,
          reasonCode:
            MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
              .leaseLost,
        });
      });

      await t.test("changed claimed version", (child) => {
        const { database, execution, guard } =
          createRuntime(child);
        database.prepare(`
          UPDATE job_runs
          SET version = version + 1
          WHERE id = ?
        `).run(IDS.runA);
        const error = captureError(() =>
          assertCurrentInImmediate(
            database,
            guard,
            execution
          )
        );
        assertGuardReason(error, {
          repositoryCode:
            REPOSITORY_ERROR_CODES.versionConflict,
          reasonCode:
            MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
              .leaseLost,
        });
      });
    });

    test("requires the complete running lease shape", (t) => {
      const { database, execution, guard } =
        createRuntime(t);
      const original = database.prepare(`
        SELECT *
        FROM job_runs
        WHERE id = ?
      `).get(IDS.runA);
      const restore = database.prepare(`
        UPDATE job_runs
        SET attempt_count = @attemptCount,
            started_at_ms = @startedAtMs,
            completed_at_ms = @completedAtMs,
            result_json = @resultJson,
            last_error_code = @lastErrorCode,
            next_attempt_at_ms = @nextAttemptAtMs
        WHERE id = @runId
      `);
      const corruptions = [
        "attempt_count = 0",
        "started_at_ms = NULL",
        "completed_at_ms = 21",
        "result_json = '{}'",
        "last_error_code = 'CORRUPT'",
        "next_attempt_at_ms = 21",
      ];
      for (const setClause of corruptions) {
        database.prepare(`
          UPDATE job_runs
          SET ${setClause}
          WHERE id = ?
        `).run(IDS.runA);
        const error = captureError(() =>
          assertCurrentInImmediate(
            database,
            guard,
            execution
          )
        );
        assertGuardReason(error, {
          repositoryCode:
            REPOSITORY_ERROR_CODES.versionConflict,
          reasonCode:
            MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
              .leaseLost,
        });
        restore.run({
          attemptCount: original.attempt_count,
          completedAtMs: original.completed_at_ms,
          lastErrorCode: original.last_error_code,
          nextAttemptAtMs:
            original.next_attempt_at_ms,
          resultJson: original.result_json,
          runId: IDS.runA,
          startedAtMs: original.started_at_ms,
        });
      }
      assert.deepEqual(
        assertCurrentInImmediate(
          database,
          guard,
          execution
        ),
        execution
      );
    });

    test("treats missing binding, generation, and FAD evidence as invariants", async (t) => {
      await t.test("missing binding", (child) => {
        const { database, execution, guard } =
          createRuntime(child);
        database.exec(
          "DROP TRIGGER matchup_schedule_job_bindings_immutable_delete"
        );
        database.prepare(`
          DELETE FROM matchup_schedule_job_bindings
          WHERE id = ?
        `).run(IDS.bindingA);
        const error = captureError(() =>
          assertCurrentInImmediate(
            database,
            guard,
            execution
          )
        );
        assertGuardReason(error, {
          repositoryCode:
            REPOSITORY_ERROR_CODES.schemaIncompatible,
          reasonCode:
            MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
              .evidenceInvariant,
        });
      });

      await t.test("missing generation", (child) => {
        const { database, execution, guard } =
          createRuntime(child);
        database.exec(
          "DROP TRIGGER season_matchup_schedule_generations_immutable_delete"
        );
        database.pragma("foreign_keys = OFF");
        database.prepare(`
          DELETE FROM season_matchup_schedule_generations
          WHERE schedule_operation_id = ?
        `).run(IDS.scheduleA);
        database.pragma("foreign_keys = ON");
        const error = captureError(() =>
          assertCurrentInImmediate(
            database,
            guard,
            execution
          )
        );
        assertGuardReason(error, {
          repositoryCode:
            REPOSITORY_ERROR_CODES.schemaIncompatible,
          reasonCode:
            MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
              .evidenceInvariant,
        });
      });

      await t.test("missing completed FAD", (child) => {
        const { database, execution, guard } =
          createRuntime(child);
        database.prepare(`
          UPDATE season_matchup_schedule_generations
          SET status = 'superseded',
              superseded_at_ms = 100,
              version = version + 1
          WHERE schedule_operation_id = ?
        `).run(IDS.scheduleA);
        database.exec(
          "DROP TRIGGER free_agent_drafts_immutable_delete"
        );
        database.prepare(`
          DELETE FROM free_agent_drafts
          WHERE id = ?
        `).run(IDS.fad);
        const error = captureError(() =>
          assertCurrentInImmediate(
            database,
            guard,
            execution
          )
        );
        assertGuardReason(error, {
          repositoryCode:
            REPOSITORY_ERROR_CODES.schemaIncompatible,
          reasonCode:
            MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
              .evidenceInvariant,
        });
      });
    });

    test("classifies an exact superseded generation for safe terminal skipping", (t) => {
      const { database, execution, guard } =
        createRuntime(t);
      supersedeAndReplaceGeneration(database, {
        completedAtMs: 100,
        newScheduleOperationId: IDS.scheduleB,
        newScheduleVersion: 2,
        newWeekStartsAtMs:
          WEEK_START_MS + 604_800_000,
      });

      const error = captureError(() =>
        assertCurrentInImmediate(
          database,
          guard,
          execution
        )
      );
      assertGuardReason(error, {
        repositoryCode:
          REPOSITORY_ERROR_CODES.versionConflict,
        reasonCode:
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .generationSuperseded,
      });
    });

    test("treats a lone superseded generation as an invariant", (t) => {
      const { database, execution, guard } =
        createRuntime(t);
      database.prepare(`
        UPDATE season_matchup_schedule_generations
        SET status = 'superseded',
            superseded_at_ms = 100,
            version = version + 1
        WHERE schedule_operation_id = ?
      `).run(IDS.scheduleA);

      const error = captureError(() =>
        assertCurrentInImmediate(
          database,
          guard,
          execution
        )
      );
      assertGuardReason(error, {
        repositoryCode:
          REPOSITORY_ERROR_CODES.schemaIncompatible,
        reasonCode:
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .evidenceInvariant,
      });
    });

    test("does not revive old A when a new A follows A to B", (t) => {
      const { database, execution: oldA, guard } =
        createRuntime(t);
      supersedeAndReplaceGeneration(database, {
        completedAtMs: 100,
        newScheduleOperationId: IDS.scheduleB,
        newScheduleVersion: 2,
        newWeekStartsAtMs:
          WEEK_START_MS + 604_800_000,
      });
      supersedeAndReplaceGeneration(database, {
        completedAtMs: 200,
        newScheduleOperationId: IDS.scheduleA2,
        newScheduleVersion: 3,
        newWeekStartsAtMs: WEEK_START_MS,
      });
      const newA = insertClaimedOccurrence(database, {
        bindingId: IDS.bindingA2,
        runId: IDS.runA2,
        scheduleOperationId: IDS.scheduleA2,
        scheduleVersion: 3,
      });

      const oldError = captureError(() =>
        assertCurrentInImmediate(
          database,
          guard,
          oldA
        )
      );
      assertGuardReason(oldError, {
        repositoryCode:
          REPOSITORY_ERROR_CODES.versionConflict,
        reasonCode:
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .generationSuperseded,
      });
      assert.deepEqual(
        assertCurrentInImmediate(
          database,
          guard,
          newA
        ),
        newA
      );
      assert.notEqual(
        oldA.scheduleOperationId,
        newA.scheduleOperationId
      );
      assert.notEqual(
        oldA.scheduleVersion,
        newA.scheduleVersion
      );
      assert.equal(oldA.scheduledForMs, newA.scheduledForMs);
    });
  }
);
