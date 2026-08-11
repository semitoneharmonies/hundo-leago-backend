const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  M6_JOB_TYPES,
  MATCHUP_JOB_CODES,
  buildMatchupOccurrenceKey,
  isMatchupJobWeekSlot,
  parseMatchupOccurrenceKey,
  parseQualifiedMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  createRunMatchupOccurrencesJob,
} = require("../../src/jobs/definitions/runMatchupOccurrences");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupJobRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupJobRepository");
const {
  MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS,
  classifyMatchupOccurrenceExecutionGuardError,
  createSqliteMatchupOccurrenceExecutionGuard,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupOccurrenceExecutionGuard");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const WEEK_START_MS = 2_000_000_000;
const BASELINE_MS = WEEK_START_MS + 3_600_000;
const LOCK_MS = WEEK_START_MS + 57_600_000;
const WEEK_END_MS = WEEK_START_MS + 604_800_000;
const ROLLOVER_MS = WEEK_END_MS;
const IDS = Object.freeze({
  league: uuid(1),
  otherLeague: uuid(2),
  season: uuid(3),
  week: uuid(4),
  scheduleOperation: uuid(5),
  user: uuid(6),
  membership: uuid(7),
  team: uuid(8),
  assignment: uuid(9),
  readiness: uuid(10),
  fad: uuid(11),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seed(database) {
  const insertLeague = database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, commissioner_membership_id, " +
      "current_season_id, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'active', 'America/Vancouver', NULL, NULL, 1, 1, 1)"
  );
  insertLeague.run(IDS.league, "Job League", "job league");
  insertLeague.run(IDS.otherLeague, "Other Job League", "other job league");
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
    ) VALUES (?, 'job@example.test', 'job@example.test',
      'Job Manager', 'job manager', 'active', 1, 1, 1)
  `).run(IDS.user);
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, " +
      "regular_season_starts_at_ms, regular_season_ends_at_ms, " +
      "fantasy_playoffs_start_at_ms, fantasy_playoffs_end_at_ms, " +
      "created_at_ms, updated_at_ms, version, free_agent_draft_completed_at_ms) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', ?, ?, ?, ?, 1, 1, 1, NULL)"
  ).run(
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
    ) VALUES (?, ?, ?, 'commissioner', 'active', 1, NULL, 1, 1, 1)
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
    ) VALUES (?, ?, 'Job Team', 'job team', 'active',
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
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'accepted', 1, 1, NULL, 1)
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
  `).run(
    IDS.membership,
    IDS.season,
    IDS.league
  );
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
    ROLLOVER_MS
  );
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
      'succeeded', NULL, NULL, 3, 4)
  `).run(
    IDS.scheduleOperation,
    IDS.league,
    IDS.season,
    IDS.user
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
    IDS.scheduleOperation,
    IDS.week,
    WEEK_START_MS
  );
  const candidateDeadlineAtMs =
    WEEK_START_MS - 604_800_000;
  const openedAtMs =
    candidateDeadlineAtMs - 200_000_000;
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
    ) VALUES (?, ?, ?, 'fad-readiness:test',
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
    ) VALUES (?, ?, ?, ?, 'fad-readiness:test', ?, ?, NULL,
      1, 'cards_open', 'no_draft_inaugural', NULL, NULL, NULL,
      'inaugural test path', 'system', ?, ?, ?, ?, NULL, NULL,
      NULL, ?, ?, 1)
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
}

function createRuntime(t, { beforeCommit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-09-"));
  const connection = openDatabase({
    databasePath: path.join(root, "jobs.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-09-test",
    now: () => 1,
  });
  seed(connection.database);
  const repository = createSqliteMatchupJobRepository({ database: connection.database, beforeCommit });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database: connection.database, repository };
}

function transactionalExecutionGuard(
  database,
  { beforeAssert } = {}
) {
  const guard =
    createSqliteMatchupOccurrenceExecutionGuard({
      database,
    });
  return Object.freeze({
    assertCurrent(occurrenceExecution) {
      if (beforeAssert) beforeAssert(occurrenceExecution);
      return database.transaction(() =>
        guard.assertCurrent(occurrenceExecution)
      ).immediate();
    },
  });
}

function completeFadGate(database) {
  const completedAtMs = WEEK_START_MS - 1;
  const deadlineAtMs =
    WEEK_START_MS - 604_800_000;
  // FAD lifecycle services land in later slices. This fixture bypasses only
  // that forward-transition trigger, then uses the real season marker guard
  // so these tests can isolate the matchup-job gate.
  database.exec(
    "DROP TRIGGER free_agent_drafts_forward_update"
  );
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
    deadlineAtMs,
    deadlineAtMs + 1,
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
  assert.equal(
    database.prepare(`
      SELECT free_agent_draft_completed_at_ms
      FROM seasons
      WHERE league_id = ?
        AND id = ?
    `).get(
      IDS.league,
      IDS.season
    ).free_agent_draft_completed_at_ms,
    completedAtMs
  );
}

function slotTime(jobType) {
  return {
    "matchup:statistics_refresh":
      WEEK_START_MS,
    "matchup:baseline": BASELINE_MS,
    "matchup:lock": LOCK_MS,
    "matchup:finalize": WEEK_END_MS,
    "matchup:rollover": ROLLOVER_MS,
  }[jobType];
}

function occurrence(
  jobType = "matchup:lock",
  scheduledForMs = slotTime(jobType),
  overrides = {}
) {
  const runId =
    overrides.runId ??
    uuid(
      100 +
      M6_JOB_TYPES.indexOf(jobType)
    );
  const bindingId =
    overrides.bindingId ?? uuid(500 + M6_JOB_TYPES.indexOf(jobType));
  const weekId = overrides.weekId ?? IDS.week;
  const scheduleOperationId =
    overrides.scheduleOperationId ??
    IDS.scheduleOperation;
  const scheduleVersion =
    overrides.scheduleVersion ?? 1;
  return {
    runId,
    bindingId,
    leagueId: IDS.league,
    seasonId: IDS.season,
    jobType,
    occurrenceKey: buildMatchupOccurrenceKey({
      jobType,
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId,
      scheduleOperationId,
      scheduleVersion,
      scheduledForMs,
    }),
    weekId,
    scheduleOperationId,
    scheduleVersion,
    owningMatchupId: null,
    scheduledForMs,
    nowMs: 1,
    ...overrides,
  };
}

function insertLegacyJob(
  database,
  {
    runId = uuid(700),
    bindingId = uuid(701),
    jobType = "matchup:lock",
    scheduledForMs = slotTime(jobType),
    occurrenceKey =
      `${jobType}:${IDS.league}:${IDS.season}:${IDS.week}:${scheduledForMs}`,
    bind = true,
  } = {}
) {
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
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL,
      NULL, NULL, NULL, NULL, 20, 20, 1, NULL, ?)
  `).run(
    runId,
    IDS.league,
    IDS.season,
    jobType,
    occurrenceKey,
    scheduledForMs,
    scheduledForMs
  );
  if (bind) {
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
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, 20, 1)
    `).run(
      bindingId,
      IDS.league,
      IDS.season,
      runId,
      jobType,
      IDS.scheduleOperation,
      IDS.week
    );
  }
  return {
    bindingId,
    jobType,
    occurrenceKey,
    runId,
    scheduledForMs,
  };
}

function replaceScheduleGeneration(
  database,
  {
    scheduleOperationId,
    scheduleVersion,
    startsAtMs,
  }
) {
  const baselineAtMs =
    startsAtMs + 3_600_000;
  const locksAtMs =
    startsAtMs + 57_600_000;
  const endsAtMs =
    startsAtMs + 604_800_000;
  const generationAtMs =
    30 + scheduleVersion;
  database.prepare(`
    UPDATE season_matchup_schedule_generations
    SET status = 'superseded',
        superseded_at_ms = ?,
        version = version + 1
    WHERE league_id = ?
      AND season_id = ?
      AND status = 'current'
  `).run(
    generationAtMs,
    IDS.league,
    IDS.season
  );
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
    startsAtMs,
    baselineAtMs,
    locksAtMs,
    endsAtMs,
    endsAtMs,
    generationAtMs,
    IDS.league,
    IDS.season,
    IDS.week
  );
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
    scheduleOperationId,
    IDS.league,
    IDS.season,
    IDS.user,
    generationAtMs - 1,
    generationAtMs
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
    scheduleVersion,
    scheduleOperationId,
    IDS.week,
    startsAtMs,
    generationAtMs
  );
  return {
    baselineAtMs,
    endsAtMs,
    locksAtMs,
    rollsOverAtMs: endsAtMs,
    startsAtMs,
  };
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the matchup job repository to fail closed.");
}

function jobRow(database, runId) {
  return database.prepare(`
    SELECT *
    FROM job_runs
    WHERE id = ?
  `).get(runId);
}

describe("M6-09 deterministic matchup occurrences", () => {
  test("builds stable scope-complete keys for only approved job types", () => {
    const first = occurrence();
    assert.equal(first.occurrenceKey, occurrence().occurrenceKey);
    assert.equal(
      first.occurrenceKey,
      `matchup:lock:${IDS.league}:${IDS.season}:${IDS.week}:${IDS.scheduleOperation}:1:${LOCK_MS}`
    );
    assert.deepEqual(parseMatchupOccurrenceKey(first), {
      jobType: first.jobType,
      leagueId: first.leagueId,
      seasonId: first.seasonId,
      weekId: IDS.week,
      scheduleOperationId:
        IDS.scheduleOperation,
      scheduleVersion: 1,
      scheduledForMs: first.scheduledForMs,
    });
  });

  test("rejects malformed generation keys and incomplete generation identity", () => {
    const first = occurrence();
    const qualified = {
      jobType: first.jobType,
      leagueId: first.leagueId,
      seasonId: first.seasonId,
      weekId: IDS.week,
      scheduleOperationId:
        IDS.scheduleOperation,
      scheduleVersion: 1,
      scheduledForMs: first.scheduledForMs,
    };
    for (const invalidInput of [
      {
        ...qualified,
        scheduleOperationId: undefined,
      },
      {
        ...qualified,
        scheduleVersion: undefined,
      },
      {
        ...qualified,
        scheduleOperationId: null,
        scheduleVersion: null,
      },
      {
        ...qualified,
        scheduleOperationId: "not-an-id",
      },
      { ...qualified, scheduleVersion: 0 },
      {
        ...qualified,
        scheduleVersion:
          Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      assert.throws(
        () =>
          buildMatchupOccurrenceKey(
            invalidInput
          ),
        { code: MATCHUP_JOB_CODES.inputInvalid }
      );
    }

    const prefix =
      `matchup:lock:${IDS.league}:${IDS.season}:${IDS.week}`;
    for (const occurrenceKey of [
      `${first.occurrenceKey}0`,
      `${prefix}:${IDS.scheduleOperation}:01:${LOCK_MS}`,
      `${prefix}:${IDS.scheduleOperation}:0:${LOCK_MS}`,
      `${prefix}:${IDS.scheduleOperation}:1`,
      `${prefix}:${IDS.scheduleOperation}:1:${LOCK_MS}:extra`,
      `${prefix}:not-an-id:1:${LOCK_MS}`,
    ]) {
      assert.throws(
        () =>
          parseMatchupOccurrenceKey({
            ...first,
            occurrenceKey,
          }),
        { code: MATCHUP_JOB_CODES.inputInvalid }
      );
    }
    assert.throws(
      () =>
        buildMatchupOccurrenceKey({
          ...qualified,
          jobType: "unknown",
        }),
      { code: MATCHUP_JOB_CODES.inputInvalid }
    );
  });

  test("parses only the exact legacy key with null generation identity", () => {
    const first = occurrence();
    const legacyKey =
      `matchup:lock:${IDS.league}:${IDS.season}:${IDS.week}:${LOCK_MS}`;
    assert.deepEqual(
      parseMatchupOccurrenceKey({
        ...first,
        occurrenceKey: legacyKey,
      }),
      {
        jobType: first.jobType,
        leagueId: first.leagueId,
        seasonId: first.seasonId,
        weekId: IDS.week,
        scheduleOperationId: null,
        scheduleVersion: null,
        scheduledForMs: first.scheduledForMs,
      }
    );
    assert.throws(
      () =>
        parseMatchupOccurrenceKey({
          ...first,
          occurrenceKey:
            `${legacyKey}:extra`,
        }),
      { code: MATCHUP_JOB_CODES.inputInvalid }
    );
    assert.throws(
      () =>
        parseQualifiedMatchupOccurrenceKey({
          ...first,
          occurrenceKey: legacyKey,
        }),
      { code: MATCHUP_JOB_CODES.inputInvalid }
    );
  });

  test("recognizes only the approved job type and owning-week time slots", () => {
    const week = {
      startsAtMs: WEEK_START_MS,
      baselineAtMs: BASELINE_MS,
      locksAtMs: LOCK_MS,
      endsAtMs: WEEK_END_MS,
      rollsOverAtMs: ROLLOVER_MS,
    };
    for (const [jobType, scheduledForMs] of [
      ["matchup:statistics_refresh", WEEK_START_MS],
      ["matchup:statistics_refresh", WEEK_END_MS],
      ["matchup:baseline", BASELINE_MS],
      ["matchup:lock", LOCK_MS],
      ["matchup:finalize", WEEK_END_MS],
      ["matchup:rollover", ROLLOVER_MS],
    ]) {
      assert.equal(
        isMatchupJobWeekSlot({
          jobType,
          scheduledForMs,
          ...week,
        }),
        true
      );
    }
    assert.equal(
      isMatchupJobWeekSlot({
        jobType: "matchup:lock",
        scheduledForMs: LOCK_MS + 1,
        ...week,
      }),
      false
    );
  });
});

describe("FAD-05 matchup occurrence registration", () => {
  test("requires a qualified current-generation week slot and exact durable binding replay", (t) => {
    const { database, repository } =
      createRuntime(t);
    const scheduled = occurrence();
    assert.equal(
      repository.schedule(scheduled).replayed,
      false
    );
    const replay = repository.schedule({
      ...scheduled,
      nowMs: scheduled.nowMs + 100,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      database.prepare(`
        SELECT id, job_run_id, owning_matchup_week_id,
          owning_matchup_id, schedule_operation_id,
          schedule_version, job_type, version
        FROM matchup_schedule_job_bindings
      `).get(),
      {
        id: scheduled.bindingId,
        job_run_id: scheduled.runId,
        owning_matchup_week_id:
          scheduled.weekId,
        owning_matchup_id: null,
        schedule_operation_id:
          scheduled.scheduleOperationId,
        schedule_version:
          scheduled.scheduleVersion,
        job_type: scheduled.jobType,
        version: 1,
      }
    );
  });

  test("rejects legacy registration, matchup ownership, wrong slots, and binding conflicts without partial writes", (t) => {
    const { database, repository } =
      createRuntime(t);
    const scheduled = occurrence();
    const legacyKey =
      `${scheduled.jobType}:${scheduled.leagueId}:${scheduled.seasonId}:${scheduled.weekId}:${scheduled.scheduledForMs}`;
    for (const invalidCommand of [
      {
        ...scheduled,
        occurrenceKey: legacyKey,
      },
      {
        ...scheduled,
        owningMatchupId: uuid(900),
      },
      occurrence(
        "matchup:lock",
        LOCK_MS + 1,
        {
          runId: uuid(901),
          bindingId: uuid(902),
        }
      ),
    ]) {
      assert.throws(
        () => repository.schedule(invalidCommand),
        { code: "REPOSITORY_ARGUMENT_INVALID" }
      );
    }
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM job_runs) AS jobs,
          (
            SELECT COUNT(*)
            FROM matchup_schedule_job_bindings
          ) AS bindings
      `).get(),
      { jobs: 0, bindings: 0 }
    );
    repository.schedule(scheduled);
    database.exec(`
      DROP TRIGGER
        matchup_schedule_job_bindings_immutable_delete;
      DELETE FROM matchup_schedule_job_bindings
      WHERE league_id =
        '${IDS.league}'
        AND job_run_id =
          '${scheduled.runId}';
    `);
    assert.throws(
      () => repository.schedule(scheduled),
      { code: "REPOSITORY_SCHEMA_INCOMPATIBLE" }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM job_runs) AS jobs,
          (
            SELECT COUNT(*)
            FROM matchup_schedule_job_bindings
          ) AS bindings
      `).get(),
      { jobs: 1, bindings: 0 }
    );
  });

  test("rolls back both job and binding at each registration seam", (t) => {
    let failingSeam =
      "schedule_after_job_insert";
    const { database, repository } =
      createRuntime(t, {
        beforeCommit(operation) {
          if (operation === failingSeam) {
            throw new Error(
              `forced ${operation}`
            );
          }
        },
      });
    const scheduled = occurrence();
    for (const seam of [
      "schedule_after_job_insert",
      "schedule_after_binding_insert",
    ]) {
      failingSeam = seam;
      assert.throws(
        () => repository.schedule(scheduled)
      );
      assert.deepEqual(
        database.prepare(`
          SELECT
            (SELECT COUNT(*) FROM job_runs) AS jobs,
            (
              SELECT COUNT(*)
              FROM matchup_schedule_job_bindings
            ) AS bindings
        `).get(),
        { jobs: 0, bindings: 0 }
      );
    }
    failingSeam = null;
    assert.equal(
      repository.schedule(scheduled).replayed,
      false
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM job_runs) AS jobs,
          (
            SELECT COUNT(*)
            FROM matchup_schedule_job_bindings
          ) AS bindings
      `).get(),
      { jobs: 1, bindings: 1 }
    );
  });
});

describe("FAD-05 completed-FAD schedule gate", () => {
  test("admits an exact migrated legacy occurrence only when its durable binding is valid", (t) => {
    const { database, repository } =
      createRuntime(t);
    const valid = insertLegacyJob(database);
    const unbound = insertLegacyJob(
      database,
      {
        runId: uuid(710),
        bindingId: uuid(711),
        jobType: "matchup:baseline",
        bind: false,
      }
    );
    insertLegacyJob(database, {
      runId: uuid(720),
      bindingId: uuid(721),
      jobType: "matchup:finalize",
      occurrenceKey: "malformed",
    });
    insertLegacyJob(database, {
      runId: uuid(730),
      bindingId: uuid(731),
      jobType: "matchup:finalize",
      scheduledForMs: LOCK_MS,
    });
    completeFadGate(database);
    const due = repository.listDue({
      nowMs: WEEK_END_MS + 1,
      limit: 100,
    });
    assert.deepEqual(
      due.map((row) => row.id),
      [valid.runId]
    );
    const claimed = repository.claim({
      leagueId: IDS.league,
      seasonId: IDS.season,
      jobType: valid.jobType,
      occurrenceKey: valid.occurrenceKey,
      leaseOwner: "legacy-worker",
      leaseToken: "legacy-token",
      nowMs: WEEK_END_MS + 1,
      leaseExpiresAtMs:
        WEEK_END_MS + 101,
    });
    assert.equal(claimed.acquired, true);
    assert.equal(
      Object.isFrozen(claimed.occurrenceExecution),
      true
    );
    assert.deepEqual(
      claimed.occurrenceExecution,
      {
        bindingId: valid.bindingId,
        claimedJobVersion:
          claimed.occurrence.version,
        jobType: valid.jobType,
        leagueId: IDS.league,
        leaseExpiresAtMs:
          WEEK_END_MS + 101,
        leaseOwner: "legacy-worker",
        leaseToken: "legacy-token",
        occurrenceKey: valid.occurrenceKey,
        runId: valid.runId,
        scheduleOperationId:
          IDS.scheduleOperation,
        scheduleVersion: 1,
        scheduledForMs: valid.scheduledForMs,
        seasonId: IDS.season,
        weekId: IDS.week,
      }
    );
    const unboundClaim = repository.claim({
      leagueId: IDS.league,
      seasonId: IDS.season,
      jobType: unbound.jobType,
      occurrenceKey: unbound.occurrenceKey,
      leaseOwner: "unbound-worker",
      leaseToken: "unbound-token",
      nowMs: WEEK_END_MS + 1,
      leaseExpiresAtMs:
        WEEK_END_MS + 101,
    });
    assert.equal(unboundClaim.acquired, false);
    assert.equal(
      unboundClaim.occurrence.status,
      "pending"
    );
  });

  test("fails closed for marker, FAD Week 1, and binding corruption without changing the job", (t) => {
    const { database, repository } =
      createRuntime(t);
    const scheduled = occurrence();
    repository.schedule(scheduled);
    completeFadGate(database);
    assert.equal(
      repository.listDue({
        nowMs: scheduled.scheduledForMs,
      }).length,
      1
    );

    database.exec(
      "DROP TRIGGER seasons_fad_completion_marker_guard"
    );
    database.prepare(`
      UPDATE seasons
      SET free_agent_draft_completed_at_ms =
        free_agent_draft_completed_at_ms + 1
      WHERE league_id = ?
        AND id = ?
    `).run(IDS.league, IDS.season);
    assert.equal(
      repository.listDue({
        nowMs: scheduled.scheduledForMs,
      }).length,
      0
    );
    assert.equal(repository.claim({
      ...scheduled,
      leaseOwner: "marker-worker",
      leaseToken: "marker-token",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    }).acquired, false);
    database.prepare(`
      UPDATE seasons
      SET free_agent_draft_completed_at_ms = ?
      WHERE league_id = ?
        AND id = ?
    `).run(
      WEEK_START_MS - 1,
      IDS.league,
      IDS.season
    );

    const otherWeekId = uuid(800);
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
      ) VALUES (?, ?, ?, '2026-W02', 2, ?, ?, ?, ?, ?,
        'scheduled', 40, 40, 1)
    `).run(
      otherWeekId,
      IDS.league,
      IDS.season,
      WEEK_START_MS + 604_800_000,
      BASELINE_MS + 604_800_000,
      LOCK_MS + 604_800_000,
      WEEK_END_MS + 604_800_000,
      ROLLOVER_MS + 604_800_000
    );
    database.exec(
      "PRAGMA ignore_check_constraints = ON"
    );
    database.prepare(`
      UPDATE free_agent_drafts
      SET current_competition_first_matchup_week_id = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
    `).run(
      otherWeekId,
      IDS.league,
      IDS.fad
    );
    database.exec(
      "PRAGMA ignore_check_constraints = OFF"
    );
    assert.equal(
      repository.listDue({
        nowMs: scheduled.scheduledForMs,
      }).length,
      0
    );
    database.prepare(`
      UPDATE free_agent_drafts
      SET current_competition_first_matchup_week_id = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
    `).run(
      IDS.week,
      IDS.league,
      IDS.fad
    );

    database.exec(`
      DROP TRIGGER
        matchup_schedule_job_bindings_immutable_update;
    `);
    database.prepare(`
      UPDATE matchup_schedule_job_bindings
      SET owning_matchup_id = ?
      WHERE league_id = ?
        AND job_run_id = ?
    `).run(
      uuid(801),
      IDS.league,
      scheduled.runId
    );
    assert.equal(
      repository.listDue({
        nowMs: scheduled.scheduledForMs,
      }).length,
      0
    );
    const stale = repository.claim({
      ...scheduled,
      leaseOwner: "corrupt-worker",
      leaseToken: "corrupt-token",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    });
    assert.equal(stale.acquired, false);
    assert.deepEqual(
      database.prepare(`
        SELECT status, attempt_count, version
        FROM job_runs
        WHERE id = ?
      `).get(scheduled.runId),
      {
        status: "pending",
        attempt_count: 0,
        version: 1,
      }
    );
  });

  test("keeps only the newest generation due across an A-B-A Week 1 sequence", (t) => {
    const { database, repository } =
      createRuntime(t);
    const first = occurrence(
      "matchup:lock",
      LOCK_MS,
      {
        runId: uuid(810),
        bindingId: uuid(811),
      }
    );
    repository.schedule(first);
    completeFadGate(database);

    const operationB = uuid(812);
    const b = replaceScheduleGeneration(
      database,
      {
        scheduleOperationId: operationB,
        scheduleVersion: 2,
        startsAtMs:
          WEEK_START_MS + 604_800_000,
      }
    );
    assert.throws(
      () =>
        repository.schedule({
          ...first,
          nowMs: 50,
        }),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    const second = occurrence(
      "matchup:lock",
      b.locksAtMs,
      {
        runId: uuid(813),
        bindingId: uuid(814),
        scheduleOperationId: operationB,
        scheduleVersion: 2,
      }
    );
    repository.schedule(second);
    assert.deepEqual(
      repository.listDue({
        nowMs: b.locksAtMs,
        limit: 100,
      }).map((row) => row.id),
      [second.runId]
    );
    const staleFirst = repository.claim({
      ...first,
      leaseOwner: "stale-a-worker",
      leaseToken: "stale-a-token",
      nowMs: b.locksAtMs,
      leaseExpiresAtMs:
        b.locksAtMs + 100,
    });
    assert.equal(staleFirst.acquired, false);
    assert.equal(
      staleFirst.occurrence.status,
      "pending"
    );

    const operationA2 = uuid(815);
    const a2 = replaceScheduleGeneration(
      database,
      {
        scheduleOperationId: operationA2,
        scheduleVersion: 3,
        startsAtMs: WEEK_START_MS,
      }
    );
    const third = occurrence(
      "matchup:lock",
      a2.locksAtMs,
      {
        runId: uuid(816),
        bindingId: uuid(817),
        scheduleOperationId: operationA2,
        scheduleVersion: 3,
      }
    );
    repository.schedule(third);
    assert.notEqual(
      third.occurrenceKey,
      first.occurrenceKey
    );
    assert.deepEqual(
      repository.listDue({
        nowMs: b.locksAtMs,
        limit: 100,
      }).map((row) => row.id),
      [third.runId]
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM job_runs
        WHERE league_id = ?
          AND season_id = ?
          AND job_type = 'matchup:lock'
      `).get(
        IDS.league,
        IDS.season
      ).count,
      3
    );
  });
});

describe("FAD-05 superseded claimed occurrence terminalization", () => {
  test("skips an exact superseded claim once and replays its deterministic terminal result", (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence(
      "matchup:lock",
      LOCK_MS,
      {
        runId: uuid(820),
        bindingId: uuid(821),
      }
    );
    repository.schedule(scheduled);
    completeFadGate(database);
    const claimed = repository.claim({
      ...scheduled,
      leaseOwner: "superseded-worker",
      leaseToken: "superseded-token",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    });
    assert.equal(claimed.acquired, true);
    replaceScheduleGeneration(database, {
      scheduleOperationId: uuid(822),
      scheduleVersion: 2,
      startsAtMs: WEEK_START_MS + 604_800_000,
    });

    const skipped = repository.skipSuperseded({
      occurrenceExecution:
        claimed.occurrenceExecution,
      completedAtMs: scheduled.scheduledForMs + 1,
    });
    assert.equal(Object.isFrozen(skipped), true);
    assert.equal(Object.isFrozen(skipped.occurrence), true);
    assert.equal(skipped.replayed, false);
    assert.deepEqual(
      {
        completedAtMs:
          skipped.occurrence.completed_at_ms,
        lastErrorCode:
          skipped.occurrence.last_error_code,
        leaseExpiresAtMs:
          skipped.occurrence.lease_expires_at_ms,
        leaseOwner: skipped.occurrence.lease_owner,
        leaseToken: skipped.occurrence.lease_token,
        nextAttemptAtMs:
          skipped.occurrence.next_attempt_at_ms,
        resultJson: skipped.occurrence.result_json,
        status: skipped.occurrence.status,
        version: skipped.occurrence.version,
      },
      {
        completedAtMs: scheduled.scheduledForMs + 1,
        lastErrorCode: null,
        leaseExpiresAtMs: null,
        leaseOwner: null,
        leaseToken: null,
        nextAttemptAtMs: null,
        resultJson:
          '{"outcome":"superseded_schedule_generation"}',
        status: "skipped",
        version:
          claimed.occurrenceExecution
            .claimedJobVersion + 1,
      }
    );

    const replayed = repository.skipSuperseded({
      occurrenceExecution:
        claimed.occurrenceExecution,
      completedAtMs: scheduled.scheduledForMs + 2,
    });
    assert.equal(replayed.replayed, true);
    assert.deepEqual(
      replayed.occurrence,
      skipped.occurrence
    );
    assert.deepEqual(
      jobRow(database, scheduled.runId),
      skipped.occurrence
    );
  });

  test("rejects changed lease tokens and claimed versions without terminalizing", (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence(
      "matchup:lock",
      LOCK_MS,
      {
        runId: uuid(823),
        bindingId: uuid(824),
      }
    );
    repository.schedule(scheduled);
    completeFadGate(database);
    const claimed = repository.claim({
      ...scheduled,
      leaseOwner: "lease-worker",
      leaseToken: "lease-token",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    });
    replaceScheduleGeneration(database, {
      scheduleOperationId: uuid(825),
      scheduleVersion: 2,
      startsAtMs: WEEK_START_MS + 604_800_000,
    });

    database.prepare(`
      UPDATE job_runs
      SET lease_token = 'replacement-token'
      WHERE id = ?
    `).run(scheduled.runId);
    const tokenError = captureError(() =>
      repository.skipSuperseded({
        occurrenceExecution:
          claimed.occurrenceExecution,
        completedAtMs:
          scheduled.scheduledForMs + 1,
      })
    );
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(
        tokenError
      ),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
        .leaseLost
    );
    assert.equal(
      jobRow(database, scheduled.runId).status,
      "running"
    );

    database.prepare(`
      UPDATE job_runs
      SET lease_token = ?,
          version = version + 1
      WHERE id = ?
    `).run("lease-token", scheduled.runId);
    const versionError = captureError(() =>
      repository.skipSuperseded({
        occurrenceExecution:
          claimed.occurrenceExecution,
        completedAtMs:
          scheduled.scheduledForMs + 1,
      })
    );
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(
        versionError
      ),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
        .leaseLost
    );
    assert.deepEqual(
      {
        completedAtMs:
          jobRow(database, scheduled.runId)
            .completed_at_ms,
        resultJson:
          jobRow(database, scheduled.runId).result_json,
        status: jobRow(database, scheduled.runId).status,
      },
      {
        completedAtMs: null,
        resultJson: null,
        status: "running",
      }
    );
  });

  test("rejects current or missing generations without changing the running claim", (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence(
      "matchup:lock",
      LOCK_MS,
      {
        runId: uuid(826),
        bindingId: uuid(827),
      }
    );
    repository.schedule(scheduled);
    completeFadGate(database);
    const claimed = repository.claim({
      ...scheduled,
      leaseOwner: "current-worker",
      leaseToken: "current-token",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    });
    const before = jobRow(database, scheduled.runId);

    const currentError = captureError(() =>
      repository.skipSuperseded({
        occurrenceExecution:
          claimed.occurrenceExecution,
        completedAtMs:
          scheduled.scheduledForMs + 1,
      })
    );
    assert.equal(
      currentError.code,
      "REPOSITORY_VERSION_CONFLICT"
    );
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(
        currentError
      ),
      null
    );
    assert.deepEqual(
      jobRow(database, scheduled.runId),
      before
    );

    const crossLeagueError = captureError(() =>
      repository.skipSuperseded({
        occurrenceExecution: Object.freeze({
          ...claimed.occurrenceExecution,
          leagueId: IDS.otherLeague,
        }),
        completedAtMs:
          scheduled.scheduledForMs + 1,
      })
    );
    assert.equal(
      crossLeagueError.code,
      "REPOSITORY_SCHEMA_INCOMPATIBLE"
    );
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(
        crossLeagueError
      ),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
        .evidenceInvariant
    );
    assert.deepEqual(
      jobRow(database, scheduled.runId),
      before
    );

    database.exec(
      "DROP TRIGGER season_matchup_schedule_generations_forward_update"
    );
    database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET week_one_starts_at_ms =
          week_one_starts_at_ms + 1
      WHERE schedule_operation_id = ?
    `).run(IDS.scheduleOperation);
    const corruptError = captureError(() =>
      repository.skipSuperseded({
        occurrenceExecution:
          claimed.occurrenceExecution,
        completedAtMs:
          scheduled.scheduledForMs + 1,
      })
    );
    assert.equal(
      corruptError.code,
      "REPOSITORY_SCHEMA_INCOMPATIBLE"
    );
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(
        corruptError
      ),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
        .evidenceInvariant
    );
    assert.deepEqual(
      jobRow(database, scheduled.runId),
      before
    );
    database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET week_one_starts_at_ms = ?
      WHERE schedule_operation_id = ?
    `).run(WEEK_START_MS, IDS.scheduleOperation);

    database.exec(
      "DROP TRIGGER season_matchup_schedule_generations_immutable_delete"
    );
    database.pragma("foreign_keys = OFF");
    database.prepare(`
      DELETE FROM season_matchup_schedule_generations
      WHERE schedule_operation_id = ?
    `).run(IDS.scheduleOperation);
    database.pragma("foreign_keys = ON");
    const missingError = captureError(() =>
      repository.skipSuperseded({
        occurrenceExecution:
          claimed.occurrenceExecution,
        completedAtMs:
          scheduled.scheduledForMs + 1,
      })
    );
    assert.equal(
      missingError.code,
      "REPOSITORY_SCHEMA_INCOMPATIBLE"
    );
    assert.equal(
      classifyMatchupOccurrenceExecutionGuardError(
        missingError
      ),
      MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
        .evidenceInvariant
    );
    assert.deepEqual(
      jobRow(database, scheduled.runId),
      before
    );
  });

  test("keeps old A stale and new A valid across an A-B-A replacement", (t) => {
    const { database, repository } = createRuntime(t);
    const oldA = occurrence(
      "matchup:lock",
      LOCK_MS,
      {
        runId: uuid(828),
        bindingId: uuid(829),
      }
    );
    repository.schedule(oldA);
    completeFadGate(database);
    const oldClaim = repository.claim({
      ...oldA,
      leaseOwner: "old-a-worker",
      leaseToken: "old-a-token",
      nowMs: oldA.scheduledForMs,
      leaseExpiresAtMs: oldA.scheduledForMs + 100,
    });
    replaceScheduleGeneration(database, {
      scheduleOperationId: uuid(830),
      scheduleVersion: 2,
      startsAtMs: WEEK_START_MS + 604_800_000,
    });
    const operationA2 = uuid(831);
    replaceScheduleGeneration(database, {
      scheduleOperationId: operationA2,
      scheduleVersion: 3,
      startsAtMs: WEEK_START_MS,
    });
    const newA = occurrence(
      "matchup:lock",
      LOCK_MS,
      {
        runId: uuid(832),
        bindingId: uuid(833),
        scheduleOperationId: operationA2,
        scheduleVersion: 3,
      }
    );
    repository.schedule(newA);
    const newClaim = repository.claim({
      ...newA,
      leaseOwner: "new-a-worker",
      leaseToken: "new-a-token",
      nowMs: newA.scheduledForMs,
      leaseExpiresAtMs: newA.scheduledForMs + 100,
    });
    assert.equal(newClaim.acquired, true);
    const newBefore = jobRow(database, newA.runId);

    const skippedOld = repository.skipSuperseded({
      occurrenceExecution:
        oldClaim.occurrenceExecution,
      completedAtMs: oldA.scheduledForMs + 1,
    });
    assert.equal(skippedOld.occurrence.status, "skipped");
    assert.equal(
      skippedOld.occurrence.result_json,
      '{"outcome":"superseded_schedule_generation"}'
    );
    assert.deepEqual(jobRow(database, newA.runId), newBefore);
    assert.equal(
      newClaim.occurrenceExecution
        .scheduleOperationId,
      operationA2
    );
    assert.equal(
      newClaim.occurrenceExecution.scheduleVersion,
      3
    );
    assert.notEqual(
      oldClaim.occurrenceExecution
        .scheduleOperationId,
      newClaim.occurrenceExecution
        .scheduleOperationId
    );
  });

  test("rolls back a late skip failure without unrelated writes", (t) => {
    let failSkip = true;
    const { database, repository } = createRuntime(t, {
      beforeCommit(operation) {
        if (
          operation === "skip_superseded" &&
          failSkip
        ) {
          throw new Error("late superseded skip failure");
        }
      },
    });
    const scheduled = occurrence(
      "matchup:lock",
      LOCK_MS,
      {
        runId: uuid(834),
        bindingId: uuid(835),
      }
    );
    repository.schedule(scheduled);
    completeFadGate(database);
    const claimed = repository.claim({
      ...scheduled,
      leaseOwner: "rollback-worker",
      leaseToken: "rollback-token",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    });
    replaceScheduleGeneration(database, {
      scheduleOperationId: uuid(836),
      scheduleVersion: 2,
      startsAtMs: WEEK_START_MS + 604_800_000,
    });
    const before = {
      activityCount: database.prepare(`
        SELECT COUNT(*) AS count
        FROM league_activity
      `).get().count,
      binding: database.prepare(`
        SELECT *
        FROM matchup_schedule_job_bindings
        WHERE id = ?
      `).get(scheduled.bindingId),
      generations: database.prepare(`
        SELECT *
        FROM season_matchup_schedule_generations
        ORDER BY schedule_version
      `).all(),
      job: jobRow(database, scheduled.runId),
    };

    assert.throws(
      () =>
        repository.skipSuperseded({
          occurrenceExecution:
            claimed.occurrenceExecution,
          completedAtMs:
            scheduled.scheduledForMs + 1,
        }),
      { code: "REPOSITORY_OPERATION_FAILED" }
    );
    assert.deepEqual(
      {
        activityCount: database.prepare(`
          SELECT COUNT(*) AS count
          FROM league_activity
        `).get().count,
        binding: database.prepare(`
          SELECT *
          FROM matchup_schedule_job_bindings
          WHERE id = ?
        `).get(scheduled.bindingId),
        generations: database.prepare(`
          SELECT *
          FROM season_matchup_schedule_generations
          ORDER BY schedule_version
        `).all(),
        job: jobRow(database, scheduled.runId),
      },
      before
    );

    failSkip = false;
    assert.equal(
      repository.skipSuperseded({
        occurrenceExecution:
          claimed.occurrenceExecution,
        completedAtMs:
          scheduled.scheduledForMs + 1,
      }).occurrence.status,
      "skipped"
    );
  });
});

describe("M6-09 durable claims, leases, and recovery", () => {
  test("schedules exactly, allows one claim, and permits takeover only at expiry", (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence();
    assert.equal(repository.schedule(scheduled).replayed, false);
    assert.equal(repository.schedule(scheduled).replayed, true);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM matchup_schedule_job_bindings
      `).get().count,
      1
    );
    assert.equal(
      repository.listDue({
        nowMs: scheduled.scheduledForMs,
      }).length,
      0
    );
    assert.equal(repository.claim({
      ...scheduled,
      leaseOwner: "worker-before-fad",
      leaseToken: "token-before-fad",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    }).acquired, false);
    completeFadGate(database);
    assert.equal(
      repository.listDue({
        nowMs: scheduled.scheduledForMs - 1,
      }).length,
      0
    );
    assert.equal(
      repository.listDue({
        nowMs: scheduled.scheduledForMs,
      }).length,
      1
    );
    const first = repository.claim({
      ...scheduled,
      leaseOwner: "worker-1",
      leaseToken: "token-1",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    });
    assert.equal(first.acquired, true);
    assert.equal(first.occurrence.attempt_count, 1);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(
      Object.isFrozen(first.occurrenceExecution),
      true
    );
    assert.deepEqual(first.occurrenceExecution, {
      bindingId: scheduled.bindingId,
      claimedJobVersion: first.occurrence.version,
      jobType: scheduled.jobType,
      leagueId: scheduled.leagueId,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
      leaseOwner: "worker-1",
      leaseToken: "token-1",
      occurrenceKey: scheduled.occurrenceKey,
      runId: scheduled.runId,
      scheduleOperationId:
        scheduled.scheduleOperationId,
      scheduleVersion: scheduled.scheduleVersion,
      scheduledForMs: scheduled.scheduledForMs,
      seasonId: scheduled.seasonId,
      weekId: scheduled.weekId,
    });
    assert.equal(repository.claim({
      ...scheduled,
      leaseOwner: "worker-2",
      leaseToken: "token-2",
      nowMs: scheduled.scheduledForMs + 99,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 199,
    }).acquired, false);
    const takeover = repository.claim({
      ...scheduled,
      leaseOwner: "worker-2",
      leaseToken: "token-2",
      nowMs: scheduled.scheduledForMs + 100,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 200,
    });
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.occurrence.attempt_count, 2);
    assert.throws(() => repository.succeed({
      leagueId: IDS.league,
      runId: scheduled.runId,
      leaseOwner: "worker-1",
      leaseToken: "token-1",
      expectedVersion: first.occurrence.version,
      completedAtMs:
        scheduled.scheduledForMs + 101,
      result: { duplicate: true },
    }), { code: "REPOSITORY_VERSION_CONFLICT" });
    const succeeded = repository.succeed({
      leagueId: IDS.league,
      runId: scheduled.runId,
      leaseOwner: "worker-2",
      leaseToken: "token-2",
      expectedVersion: takeover.occurrence.version,
      completedAtMs:
        scheduled.scheduledForMs + 101,
      result: { ok: true },
    });
    assert.equal(succeeded.status, "succeeded");
    assert.equal(repository.claim({
      ...scheduled,
      leaseOwner: "worker-3",
      leaseToken: "token-3",
      nowMs: scheduled.scheduledForMs + 300,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 400,
    }).acquired, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM job_runs").get().count, 1);
  });

  test("passes each exact frozen claimed execution object unchanged to every M6 handler", async (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = M6_JOB_TYPES.map((jobType) =>
      occurrence(jobType)
    );
    for (const command of scheduled) {
      repository.schedule(command);
    }
    completeFadGate(database);

    const claimedByRunId = new Map();
    const handledByRunId = new Map();
    const observedRepository = Object.freeze({
      ...repository,
      claim(command) {
        const claim = repository.claim(command);
        if (claim.acquired) {
          claimedByRunId.set(
            claim.occurrenceExecution.runId,
            claim.occurrenceExecution
          );
        }
        return claim;
      },
    });
    const handlers = Object.fromEntries(
      M6_JOB_TYPES.map((jobType) => [
        jobType,
        async (occurrenceExecution, observedAtMs) => {
          assert.equal(Object.isFrozen(occurrenceExecution), true);
          assert.equal(observedAtMs, ROLLOVER_MS);
          handledByRunId.set(
            occurrenceExecution.runId,
            occurrenceExecution
          );
          return { handled: jobType };
        },
      ])
    );
    let token = 0;
    const job = createRunMatchupOccurrencesJob({
      repository: observedRepository,
      executionGuard: transactionalExecutionGuard(database),
      handlers,
      clock: { nowMs: () => ROLLOVER_MS },
      secureRandom: { id: () => `all-types-${++token}` },
      leaseOwner: "all-types-worker",
      leaseDurationMs: 20,
      retryDelayMs: 10,
      logger: { error() {} },
    });

    const result = await job.run();
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "acquired",
        "due",
        "failed",
        "job",
        "skipped",
        "status",
        "succeeded",
      ]
    );
    assert.deepEqual(
      {
        acquired: result.acquired,
        due: result.due,
        failed: result.failed,
        skipped: result.skipped,
        status: result.status,
        succeeded: result.succeeded,
      },
      {
        acquired: 5,
        due: 5,
        failed: 0,
        skipped: 0,
        status: "succeeded",
        succeeded: 5,
      }
    );
    assert.equal(handledByRunId.size, M6_JOB_TYPES.length);
    for (const [runId, claimedExecution] of claimedByRunId) {
      assert.equal(
        handledByRunId.get(runId),
        claimedExecution
      );
    }
  });

  test("skips a superseded claimed generation once without handler execution or retry", async (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence("matchup:lock", LOCK_MS, {
      runId: uuid(900),
      bindingId: uuid(901),
    });
    repository.schedule(scheduled);
    completeFadGate(database);
    let replaced = false;
    let failCalls = 0;
    let skipCalls = 0;
    let handlerCalls = 0;
    const observedRepository = Object.freeze({
      ...repository,
      fail(command) {
        failCalls += 1;
        return repository.fail(command);
      },
      skipSuperseded(command) {
        skipCalls += 1;
        return repository.skipSuperseded(command);
      },
    });
    const handlers = Object.fromEntries(
      M6_JOB_TYPES.map((jobType) => [
        jobType,
        async () => {
          handlerCalls += 1;
          return { handled: true };
        },
      ])
    );
    const job = createRunMatchupOccurrencesJob({
      repository: observedRepository,
      executionGuard: transactionalExecutionGuard(database, {
        beforeAssert() {
          if (replaced) return;
          replaced = true;
          replaceScheduleGeneration(database, {
            scheduleOperationId: uuid(902),
            scheduleVersion: 2,
            startsAtMs: WEEK_START_MS + 604_800_000,
          });
        },
      }),
      handlers,
      clock: { nowMs: () => LOCK_MS },
      secureRandom: { id: () => "superseded-token" },
      leaseOwner: "superseded-worker",
      leaseDurationMs: 20,
      retryDelayMs: 10,
      logger: { error() {} },
    });

    const skipped = await job.run();
    assert.deepEqual(
      {
        acquired: skipped.acquired,
        due: skipped.due,
        failed: skipped.failed,
        skipped: skipped.skipped,
        status: skipped.status,
        succeeded: skipped.succeeded,
      },
      {
        acquired: 1,
        due: 1,
        failed: 0,
        skipped: 1,
        status: "succeeded",
        succeeded: 0,
      }
    );
    assert.equal(skipCalls, 1);
    assert.equal(failCalls, 0);
    assert.equal(handlerCalls, 0);
    assert.deepEqual(
      {
        lastErrorCode: jobRow(database, scheduled.runId).last_error_code,
        nextAttemptAtMs: jobRow(database, scheduled.runId).next_attempt_at_ms,
        resultJson: jobRow(database, scheduled.runId).result_json,
        status: jobRow(database, scheduled.runId).status,
      },
      {
        lastErrorCode: null,
        nextAttemptAtMs: null,
        resultJson: '{"outcome":"superseded_schedule_generation"}',
        status: "skipped",
      }
    );
    assert.equal((await job.run()).due, 0);
    assert.equal(skipCalls, 1);
    assert.equal(failCalls, 0);
  });

  test("does not fail or skip a claim whose lease is lost before preflight", async (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence("matchup:lock", LOCK_MS, {
      runId: uuid(903),
      bindingId: uuid(904),
    });
    repository.schedule(scheduled);
    completeFadGate(database);
    let changed = false;
    let failCalls = 0;
    let skipCalls = 0;
    let handlerCalls = 0;
    const observedRepository = Object.freeze({
      ...repository,
      fail(command) {
        failCalls += 1;
        return repository.fail(command);
      },
      skipSuperseded(command) {
        skipCalls += 1;
        return repository.skipSuperseded(command);
      },
    });
    const handlers = Object.fromEntries(
      M6_JOB_TYPES.map((jobType) => [
        jobType,
        async () => {
          handlerCalls += 1;
          return { handled: true };
        },
      ])
    );
    const job = createRunMatchupOccurrencesJob({
      repository: observedRepository,
      executionGuard: transactionalExecutionGuard(database, {
        beforeAssert(occurrenceExecution) {
          if (changed) return;
          changed = true;
          database.prepare(`
            UPDATE job_runs
            SET lease_owner = 'replacement-worker',
                lease_token = 'replacement-token',
                version = version + 1
            WHERE id = ?
          `).run(occurrenceExecution.runId);
        },
      }),
      handlers,
      clock: { nowMs: () => LOCK_MS },
      secureRandom: { id: () => "lost-token" },
      leaseOwner: "original-worker",
      leaseDurationMs: 20,
      retryDelayMs: 10,
      logger: { error() {} },
    });

    const result = await job.run();
    assert.equal(result.status, "succeeded");
    assert.equal(result.skipped, 1);
    assert.equal(failCalls, 0);
    assert.equal(skipCalls, 0);
    assert.equal(handlerCalls, 0);
    assert.deepEqual(
      {
        completedAtMs: jobRow(database, scheduled.runId).completed_at_ms,
        leaseOwner: jobRow(database, scheduled.runId).lease_owner,
        leaseToken: jobRow(database, scheduled.runId).lease_token,
        nextAttemptAtMs: jobRow(database, scheduled.runId).next_attempt_at_ms,
        resultJson: jobRow(database, scheduled.runId).result_json,
        status: jobRow(database, scheduled.runId).status,
      },
      {
        completedAtMs: null,
        leaseOwner: "replacement-worker",
        leaseToken: "replacement-token",
        nextAttemptAtMs: null,
        resultJson: null,
        status: "running",
      }
    );
  });

  test("does not terminalize a replacement owner when the lease changes after the handler", async (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence("matchup:lock", LOCK_MS, {
      runId: uuid(916),
      bindingId: uuid(917),
    });
    repository.schedule(scheduled);
    completeFadGate(database);
    let handlerCalls = 0;
    let succeedCalls = 0;
    let failCalls = 0;
    let skipCalls = 0;
    const observedRepository = Object.freeze({
      ...repository,
      succeed(command) {
        succeedCalls += 1;
        database.prepare(`
          UPDATE job_runs
          SET lease_owner = 'replacement-worker',
              lease_token = 'replacement-token',
              version = version + 1
          WHERE id = ?
        `).run(command.runId);
        return repository.succeed(command);
      },
      fail(command) {
        failCalls += 1;
        return repository.fail(command);
      },
      skipSuperseded(command) {
        skipCalls += 1;
        return repository.skipSuperseded(command);
      },
    });
    const handlers = Object.fromEntries(
      M6_JOB_TYPES.map((jobType) => [
        jobType,
        async () => {
          handlerCalls += 1;
          return { handled: true };
        },
      ])
    );
    const job = createRunMatchupOccurrencesJob({
      repository: observedRepository,
      executionGuard: transactionalExecutionGuard(database),
      handlers,
      clock: { nowMs: () => LOCK_MS },
      secureRandom: { id: () => "completion-race-token" },
      leaseOwner: "completion-race-worker",
      leaseDurationMs: 20,
      retryDelayMs: 10,
      logger: { error() {} },
    });

    const result = await job.run();
    assert.equal(result.status, "succeeded");
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(handlerCalls, 1);
    assert.equal(succeedCalls, 1);
    assert.equal(failCalls, 0);
    assert.equal(skipCalls, 0);
    assert.deepEqual(
      {
        completedAtMs: jobRow(database, scheduled.runId).completed_at_ms,
        leaseOwner: jobRow(database, scheduled.runId).lease_owner,
        leaseToken: jobRow(database, scheduled.runId).lease_token,
        nextAttemptAtMs: jobRow(database, scheduled.runId).next_attempt_at_ms,
        resultJson: jobRow(database, scheduled.runId).result_json,
        status: jobRow(database, scheduled.runId).status,
      },
      {
        completedAtMs: null,
        leaseOwner: "replacement-worker",
        leaseToken: "replacement-token",
        nextAttemptAtMs: null,
        resultJson: null,
        status: "running",
      }
    );
  });

  test("fails closed without effects when a claim omits or corrupts execution context", async (t) => {
    for (const variant of ["missing", "malformed"]) {
      await t.test(variant, async (child) => {
        const { database, repository } = createRuntime(child);
        const scheduled = occurrence("matchup:lock", LOCK_MS, {
          runId: uuid(variant === "missing" ? 905 : 907),
          bindingId: uuid(variant === "missing" ? 906 : 908),
        });
        repository.schedule(scheduled);
        completeFadGate(database);
        let handlerCalls = 0;
        let failCalls = 0;
        let skipCalls = 0;
        const observedRepository = Object.freeze({
          ...repository,
          claim(command) {
            const claim = repository.claim(command);
            return Object.freeze({
              ...claim,
              occurrenceExecution:
                variant === "missing"
                  ? undefined
                  : Object.freeze({
                      ...claim.occurrenceExecution,
                      unexpected: true,
                    }),
            });
          },
          fail(command) {
            failCalls += 1;
            return repository.fail(command);
          },
          skipSuperseded(command) {
            skipCalls += 1;
            return repository.skipSuperseded(command);
          },
        });
        const handlers = Object.fromEntries(
          M6_JOB_TYPES.map((jobType) => [
            jobType,
            async () => {
              handlerCalls += 1;
              return { handled: true };
            },
          ])
        );
        const job = createRunMatchupOccurrencesJob({
          repository: observedRepository,
          executionGuard: transactionalExecutionGuard(database),
          handlers,
          clock: { nowMs: () => LOCK_MS },
          secureRandom: { id: () => `${variant}-token` },
          leaseOwner: `${variant}-worker`,
          leaseDurationMs: 20,
          retryDelayMs: 10,
          logger: { error() {} },
        });

        const result = await job.run();
        assert.equal(result.status, "failed");
        assert.equal(result.failed, 1);
        assert.equal(handlerCalls, 0);
        assert.equal(failCalls, 1);
        assert.equal(skipCalls, 0);
        assert.deepEqual(
          {
            nextAttemptAtMs:
              jobRow(database, scheduled.runId).next_attempt_at_ms,
            status: jobRow(database, scheduled.runId).status,
          },
          {
            nextAttemptAtMs: LOCK_MS + 10,
            status: "failed",
          }
        );
      });
    }
  });

  test("never runs old A but runs the new A generation after an A-B-A replacement", async (t) => {
    const { database, repository } = createRuntime(t);
    const oldA = occurrence("matchup:lock", LOCK_MS, {
      runId: uuid(909),
      bindingId: uuid(910),
    });
    repository.schedule(oldA);
    completeFadGate(database);
    const newOperationId = uuid(913);
    const newA = occurrence("matchup:lock", LOCK_MS, {
      runId: uuid(914),
      bindingId: uuid(915),
      scheduleOperationId: newOperationId,
      scheduleVersion: 3,
    });
    let replaced = false;
    let skipCalls = 0;
    let failCalls = 0;
    const handled = [];
    const observedRepository = Object.freeze({
      ...repository,
      fail(command) {
        failCalls += 1;
        return repository.fail(command);
      },
      skipSuperseded(command) {
        skipCalls += 1;
        return repository.skipSuperseded(command);
      },
    });
    const handlers = Object.fromEntries(
      M6_JOB_TYPES.map((jobType) => [
        jobType,
        async (occurrenceExecution) => {
          handled.push(occurrenceExecution);
          return { handled: true };
        },
      ])
    );
    let token = 0;
    const job = createRunMatchupOccurrencesJob({
      repository: observedRepository,
      executionGuard: transactionalExecutionGuard(database, {
        beforeAssert() {
          if (replaced) return;
          replaced = true;
          replaceScheduleGeneration(database, {
            scheduleOperationId: uuid(911),
            scheduleVersion: 2,
            startsAtMs: WEEK_START_MS + 604_800_000,
          });
          replaceScheduleGeneration(database, {
            scheduleOperationId: newOperationId,
            scheduleVersion: 3,
            startsAtMs: WEEK_START_MS,
          });
          repository.schedule(newA);
        },
      }),
      handlers,
      clock: { nowMs: () => LOCK_MS },
      secureRandom: { id: () => `aba-token-${++token}` },
      leaseOwner: "aba-worker",
      leaseDurationMs: 20,
      retryDelayMs: 10,
      logger: { error() {} },
    });

    const oldResult = await job.run();
    assert.equal(oldResult.skipped, 1);
    assert.equal(handled.length, 0);
    assert.equal(jobRow(database, oldA.runId).status, "skipped");
    const newResult = await job.run();
    assert.equal(newResult.succeeded, 1);
    assert.equal(handled.length, 1);
    assert.equal(handled[0].runId, newA.runId);
    assert.equal(handled[0].scheduleOperationId, newOperationId);
    assert.equal(handled[0].scheduleVersion, 3);
    assert.equal(jobRow(database, newA.runId).status, "succeeded");
    assert.equal(skipCalls, 1);
    assert.equal(failCalls, 0);
  });

  test("runs failed work only at explicit retry time and never reruns success", async (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence("matchup:finalize");
    repository.schedule(scheduled);
    completeFadGate(database);
    let nowMs = scheduled.scheduledForMs;
    let calls = 0;
    let effects = 0;
    let tokens = 0;
    const handlers = Object.fromEntries(M6_JOB_TYPES.map((jobType) => [jobType, async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("temporary");
        error.code = "TEMPORARY_SOURCE_FAILURE";
        throw error;
      }
      effects += 1;
      return { handled: true };
    }]));
    const job = createRunMatchupOccurrencesJob({
      repository,
      executionGuard: transactionalExecutionGuard(database),
      handlers,
      clock: { nowMs: () => nowMs },
      secureRandom: { id: () => `lease-${++tokens}` },
      leaseOwner: "runner-1",
      leaseDurationMs: 20,
      retryDelayMs: 10,
      logger: { error() {} },
    });
    const failed = await job.run();
    assert.equal(failed.status, "failed");
    assert.equal(database.prepare("SELECT status FROM job_runs").get().status, "failed");
    nowMs = scheduled.scheduledForMs + 9;
    assert.equal((await job.run()).due, 0);
    nowMs = scheduled.scheduledForMs + 10;
    const success = await job.run();
    assert.equal(success.status, "succeeded");
    assert.equal(success.succeeded, 1);
    assert.equal(effects, 1);
    nowMs = scheduled.scheduledForMs + 500;
    assert.equal((await job.run()).due, 0);
    assert.equal(calls, 2);
    assert.equal(database.prepare("SELECT attempt_count FROM job_runs").get().attempt_count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("rolls back a late claim failure and fails cross-league claims closed", (t) => {
    let failClaim = true;
    const { database, repository } = createRuntime(t, {
      beforeCommit(operation) {
        if (operation === "claim" && failClaim) throw new Error("late claim failure");
      },
    });
    const scheduled = occurrence();
    repository.schedule(scheduled);
    completeFadGate(database);
    assert.throws(() => repository.claim({
      ...scheduled,
      leaseOwner: "worker",
      leaseToken: "token",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    }));
    assert.deepEqual(database.prepare("SELECT status, attempt_count, version FROM job_runs").get(), {
      status: "pending", attempt_count: 0, version: 1,
    });
    failClaim = false;
    assert.equal(repository.claim({
      ...scheduled,
      leagueId: IDS.otherLeague,
      leaseOwner: "worker",
      leaseToken: "token",
      nowMs: scheduled.scheduledForMs,
      leaseExpiresAtMs:
        scheduled.scheduledForMs + 100,
    }).acquired, false);
    assert.equal(database.prepare("SELECT status FROM job_runs").get().status, "pending");
  });
});
