const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  MATCHUP_SCHEDULE_CODES,
  planMatchupSchedule,
} = require("../../src/domain/matchups/matchupSchedulePolicy");
const {
  MATCHUP_SCHEDULE_SERVICE_CODES,
  createMatchupScheduleService,
} = require("../../src/application/services/matchups/createMatchupScheduleService");
const {
  parseMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  tableSemanticHash,
} = require("../../src/infrastructure/migration/runJsonImport");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  createSqliteMatchupScheduleRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupScheduleRepository");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const NOW_MS = Date.parse("2026-07-22T08:00:00.000Z");
const OPENING_MS = Date.parse("2026-10-06T07:00:00.000Z");
const PLAYOFFS_MS = Date.parse("2027-03-15T07:00:00.000Z");
const SEASON_END_MS = Date.parse("2027-04-12T07:00:00.000Z");
const FIRST_WEEK_MS = Date.parse("2026-10-12T07:00:00.000Z");
const SECOND_WEEK_MS = Date.parse("2026-10-19T07:00:00.000Z");
const PREVIEW_HASH_TABLES = Object.freeze([
  "seasons",
  "teams",
  "idempotency_requests",
  "matchup_schedule_command_results",
  "matchup_operations",
  "matchup_weeks",
  "matchups",
  "matchup_byes",
  "job_runs",
  "matchup_schedule_job_bindings",
  "league_activity",
  "security_audit_events",
  "notifications",
  "outbox_events",
]);
const PREVIEW_ZERO_TABLES = Object.freeze([
  "idempotency_requests",
  "matchup_schedule_command_results",
  "matchup_operations",
  "season_matchup_schedule_generations",
  "matchup_weeks",
  "matchups",
  "matchup_byes",
  "job_runs",
  "matchup_schedule_job_bindings",
  "league_activity",
  "security_audit_events",
  "notifications",
  "outbox_events",
  "outbox_event_audiences",
]);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function idFactory(start = 500) {
  let value = start;
  return () => uuid(value++);
}

function explicitScheduleInput(overrides = {}) {
  return {
    nhlRegularSeasonStartsAtMs: OPENING_MS,
    nhlRegularSeasonEndsAtMs: SEASON_END_MS,
    fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
    fantasyPlayoffsEndAtMs: SEASON_END_MS,
    firstWeekStartsAtMs: FIRST_WEEK_MS,
    ...overrides,
  };
}

function previewTableEvidence(database) {
  return Object.fromEntries(
    PREVIEW_HASH_TABLES.map((tableName) => [
      tableName,
      {
        rowCount: database
          .prepare(
            `SELECT COUNT(*) AS count FROM "${tableName}"`
          )
          .get().count,
        semanticHash: tableSemanticHash(
          database,
          tableName
        ),
      },
    ])
  );
}

function assertPreviewTablesRemainEmpty(database) {
  for (const tableName of PREVIEW_ZERO_TABLES) {
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM "${tableName}"`
        )
        .get().count,
      0,
      tableName
    );
  }
}

function insertUser(repositories, id, name) {
  repositories.users.insert({
    id,
    email_normalized: `${name.toLowerCase()}@example.test`,
    email_display: `${name.toLowerCase()}@example.test`,
    display_name: name,
    display_name_normalized: name.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertLeague(repositories, { offset, teamCount = 4 }) {
  const leagueId = uuid(offset);
  const seasonId = uuid(offset + 1);
  const commissionerId = uuid(offset + 2);
  const membershipId = uuid(offset + 3);
  insertUser(repositories, commissionerId, `Commissioner${offset}`);
  repositories.leagues.insert({
    id: leagueId,
    name: `League ${offset}`,
    name_normalized: `league ${offset}`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: leagueId,
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
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.seasons.insert({
    id: seasonId,
    league_id: leagueId,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "planned",
    regular_season_starts_at_ms: OPENING_MS,
    regular_season_ends_at_ms: SEASON_END_MS,
    fantasy_playoffs_start_at_ms: PLAYOFFS_MS,
    fantasy_playoffs_end_at_ms: SEASON_END_MS,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  repositories.league_memberships.insert({
    id: membershipId,
    league_id: leagueId,
    user_id: commissionerId,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: leagueId,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: membershipId,
      current_season_id: seasonId,
      updated_at_ms: NOW_MS + 1,
    },
  });
  const teamIds = [];
  for (let index = 0; index < teamCount; index += 1) {
    const teamId = uuid(offset + 10 + index);
    teamIds.push(teamId);
    repositories.teams.insert({
      id: teamId,
      league_id: leagueId,
      name: `Team ${offset}-${index + 1}`,
      name_normalized: `team ${offset}-${index + 1}`,
      status: "active",
      primary_colour: index === 0 ? "#112233" : null,
      secondary_colour: index === 0 ? "#ddeeff" : null,
      logo_reference: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  return {
    commissionerId,
    leagueId,
    membershipId,
    seasonId,
    teamIds,
  };
}

function createRuntime(t, { beforeCommit, teamCount = 4 } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-02-"));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "schedule.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-02-test",
    now: () => NOW_MS,
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  const scope = insertLeague(context.repositories, { offset: 10, teamCount });
  const other = insertLeague(context.repositories, { offset: 100, teamCount: 2 });
  const repository = createSqliteMatchupScheduleRepository({
    database: connection.database,
    beforeCommit,
  });
  const generatedIds = idFactory();
  const leagueAuthorization = Object.freeze({
    requireCommissioner(authenticated, leagueId) {
      if (
        authenticated?.leagueId !== leagueId ||
        authenticated?.authorized !== true
      ) {
        const error = new Error(
          "Current league commissioner authority is required."
        );
        error.code = "LEAGUE_COMMISSIONER_REQUIRED";
        throw error;
      }
      return Object.freeze({
        actorUserId: authenticated.actorUserId,
        authority: authenticated.authority,
        leagueId,
        membershipId:
          authenticated.membershipId,
      });
    },
  });
  const service = createMatchupScheduleService({
    repositoryContext: context,
    leagueAuthorization,
    repository,
    clock: Object.freeze({
      nowMs() {
        return NOW_MS;
      },
    }),
    secureRandom: Object.freeze({
      id() {
        return generatedIds();
      },
    }),
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { context, database: connection.database, other, repository, scope, service };
}

function createShiftService(
  runtime,
  {
    readShiftContext,
    nowMs = NOW_MS,
    idStart = 9_000,
  } = {}
) {
  const generatedIds = idFactory(idStart);
  return createMatchupScheduleService({
    repositoryContext: runtime.context,
    leagueAuthorization: Object.freeze({
      requireCommissioner(
        authenticatedValue,
        leagueId
      ) {
        if (
          authenticatedValue?.leagueId !==
            leagueId ||
          authenticatedValue?.authorized !==
            true
        ) {
          const error = new Error(
            "Current league commissioner authority is required."
          );
          error.code =
            "LEAGUE_COMMISSIONER_REQUIRED";
          throw error;
        }
        return Object.freeze({
          actorUserId:
            authenticatedValue.actorUserId,
          authority:
            authenticatedValue.authority,
          leagueId,
          membershipId:
            authenticatedValue.membershipId,
        });
      },
    }),
    repository: Object.freeze({
      ...runtime.repository,
      ...(readShiftContext
        ? { readShiftContext }
        : {}),
    }),
    clock: Object.freeze({
      nowMs() {
        return nowMs;
      },
    }),
    secureRandom: Object.freeze({
      id() {
        return generatedIds();
      },
    }),
  });
}

function authenticated(
  scope,
  authority = "commissioner"
) {
  return Object.freeze({
    actorUserId: scope.commissionerId,
    authority,
    authorized: true,
    leagueId: scope.leagueId,
    membershipId: scope.membershipId,
  });
}

function confirmedScheduleCommand(
  scope,
  overrides = {}
) {
  return {
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    input: {
      ...explicitScheduleInput(),
      confirmed: true,
    },
    expectedSeasonVersion: 1,
    idempotencyKey:
      "matchup-schedule-foundation",
    authenticated: authenticated(scope),
    ...overrides,
  };
}

function shiftWeekOneCommand(
  scope,
  {
    weekId,
    expectedWeekVersion,
    firstWeekStartsAtMs,
    idempotencyKey,
  }
) {
  return {
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    weekId,
    input: {
      action: "shift_week_one",
      confirmation: "CHANGE WEEK 1 START",
      firstWeekStartsAtMs,
    },
    expectedWeekVersion,
    idempotencyKey,
    authenticated: authenticated(scope),
  };
}

function pairCounts(plan) {
  const counts = new Map();
  for (const week of plan.weeks) {
    for (const pair of week.pairs) {
      const key = [pair.homeTeamId, pair.awayTeamId].sort().join("|");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.values()];
}

describe("M6-02 matchup schedule policy", () => {
  test("selects the first eligible Monday and preserves Pacific DST boundaries", () => {
    const plan = planMatchupSchedule({
      teamIds: [uuid(1), uuid(2), uuid(3), uuid(4)],
      nhlRegularSeasonStartsAtMs: OPENING_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
      timeZone: "America/Vancouver",
    });
    assert.equal(plan.weeks[0].startsAtMs, Date.parse("2026-10-12T07:00:00.000Z"));
    assert.equal(plan.weeks[0].baselineAtMs, Date.parse("2026-10-12T08:00:00.000Z"));
    assert.equal(plan.weeks[0].locksAtMs, Date.parse("2026-10-12T23:00:00.000Z"));
    const fall = plan.weeks.find(({ startsAtMs }) =>
      startsAtMs === Date.parse("2026-10-26T07:00:00.000Z"));
    assert.equal(fall.endsAtMs, Date.parse("2026-11-02T08:00:00.000Z"));
    const spring = plan.weeks.find(({ startsAtMs }) =>
      startsAtMs === Date.parse("2027-03-08T08:00:00.000Z"));
    assert.equal(spring.endsAtMs, PLAYOFFS_MS);
  });

  test("balances repeated pairings for an even team count", () => {
    const plan = planMatchupSchedule({
      teamIds: [uuid(1), uuid(2), uuid(3), uuid(4)],
      nhlRegularSeasonStartsAtMs: OPENING_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
      timeZone: "America/Vancouver",
    });
    assert.equal(plan.weeks.length, 22);
    assert.equal(plan.weeks.every(({ pairs, byeTeamId }) => pairs.length === 2 && byeTeamId === null), true);
    const counts = pairCounts(plan);
    assert.equal(Math.max(...counts) - Math.min(...counts), 1);
  });

  test("rotates explicit byes and balances pairs for an odd team count", () => {
    const ids = [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)];
    const plan = planMatchupSchedule({
      teamIds: ids,
      nhlRegularSeasonStartsAtMs: OPENING_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
      timeZone: "America/Vancouver",
    });
    assert.equal(plan.weeks.every(({ pairs, byeTeamId }) => pairs.length === 2 && ids.includes(byeTeamId)), true);
    const byeCounts = new Map(ids.map((id) => [id, 0]));
    for (const week of plan.weeks) byeCounts.set(week.byeTeamId, byeCounts.get(week.byeTeamId) + 1);
    assert.equal(Math.max(...byeCounts.values()) - Math.min(...byeCounts.values()), 1);
    const counts = pairCounts(plan);
    assert.equal(Math.max(...counts) - Math.min(...counts), 1);
  });

  test("rejects duplicate teams and non-Monday playoff boundaries", () => {
    assert.throws(() => planMatchupSchedule({
      teamIds: [uuid(1), uuid(1)],
      nhlRegularSeasonStartsAtMs: OPENING_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
      timeZone: "America/Vancouver",
    }), { code: MATCHUP_SCHEDULE_CODES.inputInvalid });
    assert.throws(() => planMatchupSchedule({
      teamIds: [uuid(1), uuid(2)],
      nhlRegularSeasonStartsAtMs: OPENING_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_MS + 1,
      timeZone: "America/Vancouver",
    }), { code: MATCHUP_SCHEDULE_CODES.calendarInvalid });
  });
});

describe("M6-02 atomic matchup schedule persistence", () => {
  test("keeps preview read-only and persists participants, weeks, pairs, byes, and operation once", (t) => {
    const observedSeams = [];
    const runtime = createRuntime(t, {
      beforeCommit(seam) {
        observedSeams.push(seam);
      },
      teamCount: 5,
    });
    const input = {
      ...runtime.scope,
      ...explicitScheduleInput(),
      actorUserId: runtime.scope.commissionerId,
      nowMs: NOW_MS,
    };
    const before = runtime.database.serialize();
    const beforeTables =
      previewTableEvidence(runtime.database);
    const preview = runtime.service.preview(input);
    assert.equal(preview.plan.weeks.length, 22);
    assert.equal(
      preview.calendarWillBePersisted,
      false
    );
    assert.equal(
      preview.plan.firstWeekStartsAtMs,
      FIRST_WEEK_MS
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.deepEqual(
      previewTableEvidence(runtime.database),
      beforeTables
    );
    assertPreviewTablesRemainEmpty(runtime.database);

    const command = confirmedScheduleCommand(
      runtime.scope
    );
    const generated =
      runtime.service.generate(command);
    assert.deepEqual(generated, {
      operationId: uuid(500),
      seasonId: runtime.scope.seasonId,
      seasonVersion: 2,
      nhlRegularSeasonStartsAtMs: OPENING_MS,
      nhlRegularSeasonEndsAtMs: SEASON_END_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
      fantasyPlayoffsEndAtMs: SEASON_END_MS,
      calendarPersisted: false,
      firstWeekId: uuid(503),
      firstWeekStartsAtMs: FIRST_WEEK_MS,
      participantCount: 5,
      weekCount: 22,
      matchupCount: 44,
      byeCount: 22,
      lastWeekEndsAtMs: PLAYOFFS_MS,
    });
    assert.deepEqual(observedSeams, [
      "after_season_cas",
      "after_schedule_children",
      "after_jobs_and_bindings",
      "after_command_result",
      "after_idempotency_completion",
    ]);
    const stored = runtime.repository.readSchedule(runtime.scope);
    assert.equal(stored.weeks.length, 22);
    assert.equal(stored.matchups.length, 44);
    assert.equal(stored.byes.length, 22);
    assert.equal(stored.matchups[0].home_team_name.startsWith("Team 10-"), true);
    assert.equal(stored.byes[0].team_display_name.startsWith("Team 10-"), true);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            schedule_version,
            schedule_operation_id,
            week_one_matchup_week_id,
            week_one_starts_at_ms,
            status,
            version
          FROM season_matchup_schedule_generations
          WHERE league_id = ?
            AND season_id = ?
        `)
        .get(
          runtime.scope.leagueId,
          runtime.scope.seasonId
        ),
      {
        schedule_version: 1,
        schedule_operation_id:
          generated.operationId,
        week_one_matchup_week_id:
          stored.weeks[0].id,
        week_one_starts_at_ms:
          stored.weeks[0].starts_at_ms,
        status: "current",
        version: 1,
      }
    );
    assert.deepEqual(
      JSON.parse(
        runtime.database
          .prepare(`
            SELECT metadata_json
            FROM matchup_operations
            WHERE operation_type = 'schedule_generate'
          `)
          .get().metadata_json
      ),
      {
        participantCount: 5,
        participantTeamIds:
          [...runtime.scope.teamIds].sort(),
        weekCount: 22,
        matchupCount: 44,
        jobOccurrenceCount: 132,
      }
    );
    const occurrences = runtime.database
      .prepare(
        "SELECT league_id, season_id, job_type, occurrence_key, " +
          "scheduled_for_ms, status, attempt_count " +
          "FROM job_runs ORDER BY scheduled_for_ms, job_type, id"
      )
      .all();
    assert.equal(occurrences.length, 132);
    const parsedOccurrences = occurrences.map(
      (occurrence) =>
        parseMatchupOccurrenceKey({
          jobType: occurrence.job_type,
          leagueId: occurrence.league_id,
          seasonId: occurrence.season_id,
          occurrenceKey:
            occurrence.occurrence_key,
          scheduledForMs:
            occurrence.scheduled_for_ms,
        })
    );
    assert.equal(
      parsedOccurrences.every(
        (occurrence) =>
          occurrence.scheduleOperationId ===
            generated.operationId &&
          occurrence.scheduleVersion === 1
      ),
      true
    );
    assert.equal(
      runtime.database
        .prepare(
          "SELECT COUNT(*) AS count " +
            "FROM matchup_schedule_job_bindings"
        )
        .get().count,
      occurrences.length
    );
    assert.deepEqual(
      [...new Set(occurrences.map(({ job_type: jobType }) => jobType))].sort(),
      [
        "matchup:baseline",
        "matchup:finalize",
        "matchup:lock",
        "matchup:rollover",
        "matchup:statistics_refresh",
      ]
    );
    assert.equal(
      occurrences.every(
        ({ status, attempt_count: attemptCount }) =>
          status === "pending" && attemptCount === 0
      ),
      true
    );
    assert.equal(runtime.database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
    assert.deepEqual(
      runtime.database
        .prepare(
          "SELECT version, status, " +
            "regular_season_starts_at_ms, " +
            "regular_season_ends_at_ms, " +
            "fantasy_playoffs_start_at_ms, " +
            "fantasy_playoffs_end_at_ms " +
            "FROM seasons WHERE id = ?"
        )
        .get(runtime.scope.seasonId),
      {
        version: 2,
        status: "planned",
        regular_season_starts_at_ms:
          OPENING_MS,
        regular_season_ends_at_ms:
          SEASON_END_MS,
        fantasy_playoffs_start_at_ms:
          PLAYOFFS_MS,
        fantasy_playoffs_end_at_ms:
          SEASON_END_MS,
      }
    );
    const idempotency = runtime.database
      .prepare(
        "SELECT status, result_type, result_id, " +
          "completed_at_ms FROM idempotency_requests"
      )
      .get();
    const commandResult = runtime.database
      .prepare(
        "SELECT id, matchup_operation_id, " +
          "season_version_before, season_version_after " +
          "FROM matchup_schedule_command_results"
      )
      .get();
    assert.deepEqual(idempotency, {
      status: "completed",
      result_type: "matchup_schedule_command",
      result_id: commandResult.id,
      completed_at_ms: NOW_MS,
    });
    assert.equal(
      commandResult.matchup_operation_id,
      generated.operationId
    );
    assert.equal(
      commandResult.season_version_before,
      1
    );
    assert.equal(
      commandResult.season_version_after,
      2
    );
    assert.deepEqual(
      runtime.service.generate(command),
      generated
    );
    assert.deepEqual(observedSeams, [
      "after_season_cas",
      "after_schedule_children",
      "after_jobs_and_bindings",
      "after_command_result",
      "after_idempotency_completion",
    ]);
    assert.throws(
      () =>
        runtime.service.generate(
          confirmedScheduleCommand(
            runtime.scope,
            {
              expectedSeasonVersion: 2,
            }
          )
        ),
      { code: "IDEMPOTENCY_KEY_REUSED" }
    );
  });

  test("previews all-null calendars and rejects partial or conflicting persisted calendars without writes", (t) => {
    const runtime = createRuntime(t);
    const input = {
      ...runtime.scope,
      ...explicitScheduleInput(),
      actorUserId: runtime.scope.commissionerId,
      nowMs: NOW_MS,
    };
    const updateCalendar = runtime.database.prepare(`
      UPDATE seasons
      SET regular_season_starts_at_ms = ?,
          regular_season_ends_at_ms = ?,
          fantasy_playoffs_start_at_ms = ?,
          fantasy_playoffs_end_at_ms = ?
      WHERE league_id = ?
        AND id = ?
    `);

    updateCalendar.run(
      null,
      null,
      null,
      null,
      runtime.scope.leagueId,
      runtime.scope.seasonId
    );
    const allNullDatabase =
      runtime.database.serialize();
    const allNullTables =
      previewTableEvidence(runtime.database);
    const preview = runtime.service.preview(input);
    assert.equal(
      preview.calendarWillBePersisted,
      true
    );
    assert.equal(
      allNullDatabase.equals(
        runtime.database.serialize()
      ),
      true
    );
    assert.deepEqual(
      previewTableEvidence(runtime.database),
      allNullTables
    );
    assertPreviewTablesRemainEmpty(runtime.database);

    updateCalendar.run(
      OPENING_MS,
      null,
      null,
      null,
      runtime.scope.leagueId,
      runtime.scope.seasonId
    );
    const partialDatabase =
      runtime.database.serialize();
    const partialTables =
      previewTableEvidence(runtime.database);
    assert.throws(
      () => runtime.service.preview(input),
      {
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .calendarConflict,
      }
    );
    assert.equal(
      partialDatabase.equals(
        runtime.database.serialize()
      ),
      true
    );
    assert.deepEqual(
      previewTableEvidence(runtime.database),
      partialTables
    );
    assertPreviewTablesRemainEmpty(runtime.database);

    updateCalendar.run(
      OPENING_MS,
      SEASON_END_MS,
      PLAYOFFS_MS,
      SEASON_END_MS,
      runtime.scope.leagueId,
      runtime.scope.seasonId
    );
    const conflictingDatabase =
      runtime.database.serialize();
    const conflictingTables =
      previewTableEvidence(runtime.database);
    assert.throws(
      () => runtime.service.preview({
        ...input,
        nhlRegularSeasonStartsAtMs:
          OPENING_MS + 1,
      }),
      {
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .calendarConflict,
      }
    );
    assert.equal(
      conflictingDatabase.equals(
        runtime.database.serialize()
      ),
      true
    );
    assert.deepEqual(
      previewTableEvidence(runtime.database),
      conflictingTables
    );
    assertPreviewTablesRemainEmpty(runtime.database);
  });

  test("confirms an all-null calendar, preserves an alternate Week 1, and rejects a mismatched persisted tuple atomically", (t) => {
    const allNull = createRuntime(t);
    allNull.database
      .prepare(`
        UPDATE seasons
        SET regular_season_starts_at_ms = NULL,
            regular_season_ends_at_ms = NULL,
            fantasy_playoffs_start_at_ms = NULL,
            fantasy_playoffs_end_at_ms = NULL
        WHERE league_id = ?
          AND id = ?
      `)
      .run(
        allNull.scope.leagueId,
        allNull.scope.seasonId
      );
    const first = allNull.service.generate(
      confirmedScheduleCommand(allNull.scope)
    );
    assert.equal(first.calendarPersisted, true);
    assert.equal(
      first.firstWeekStartsAtMs,
      FIRST_WEEK_MS
    );
    assert.deepEqual(
      allNull.database
        .prepare(`
          SELECT
            regular_season_starts_at_ms,
            regular_season_ends_at_ms,
            fantasy_playoffs_start_at_ms,
            fantasy_playoffs_end_at_ms,
            version
          FROM seasons
          WHERE league_id = ?
            AND id = ?
        `)
        .get(
          allNull.scope.leagueId,
          allNull.scope.seasonId
        ),
      {
        regular_season_starts_at_ms:
          OPENING_MS,
        regular_season_ends_at_ms:
          SEASON_END_MS,
        fantasy_playoffs_start_at_ms:
          PLAYOFFS_MS,
        fantasy_playoffs_end_at_ms:
          SEASON_END_MS,
        version: 2,
      }
    );

    const alternate = createRuntime(t);
    const second = alternate.service.generate(
      confirmedScheduleCommand(
        alternate.scope,
        {
          idempotencyKey:
            "matchup-schedule-alternate-week-one",
          input: {
            ...explicitScheduleInput({
              firstWeekStartsAtMs:
                SECOND_WEEK_MS,
            }),
            confirmed: true,
          },
        }
      )
    );
    assert.equal(
      second.firstWeekStartsAtMs,
      SECOND_WEEK_MS
    );
    assert.equal(second.weekCount, 21);
    assert.notEqual(
      first.firstWeekStartsAtMs,
      second.firstWeekStartsAtMs
    );
    assert.notEqual(
      first.weekCount,
      second.weekCount
    );

    const mismatch = createRuntime(t);
    const before = mismatch.database.serialize();
    assert.throws(
      () =>
        mismatch.service.generate(
          confirmedScheduleCommand(
            mismatch.scope,
            {
              idempotencyKey:
                "matchup-schedule-calendar-mismatch",
              input: {
                ...explicitScheduleInput({
                  nhlRegularSeasonStartsAtMs:
                    OPENING_MS + 1,
                }),
                confirmed: true,
              },
            }
          )
        ),
      {
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .calendarConflict,
      }
    );
    assert.equal(
      before.equals(mismatch.database.serialize()),
      true
    );
    assertPreviewTablesRemainEmpty(
      mismatch.database
    );
  });

  test("uses the selected Week 1 rather than substituting an inferred date", (t) => {
    const runtime = createRuntime(t);
    const base = {
      ...runtime.scope,
      ...explicitScheduleInput(),
      actorUserId: runtime.scope.commissionerId,
      nowMs: NOW_MS,
    };
    const before = runtime.database.serialize();
    const first = runtime.service.preview(base);
    const second = runtime.service.preview({
      ...base,
      firstWeekStartsAtMs: SECOND_WEEK_MS,
    });

    assert.equal(
      first.plan.firstWeekStartsAtMs,
      FIRST_WEEK_MS
    );
    assert.equal(
      second.plan.firstWeekStartsAtMs,
      SECOND_WEEK_MS
    );
    assert.notEqual(
      first.plan.weeks.length,
      second.plan.weeks.length
    );
    assert.notDeepEqual(
      first.plan.weeks,
      second.plan.weeks
    );
    assert.equal(
      first.plan.weeks.at(-1).endsAtMs,
      PLAYOFFS_MS
    );
    assert.equal(
      second.plan.weeks.at(-1).endsAtMs,
      PLAYOFFS_MS
    );
    assert.equal(
      before.equals(runtime.database.serialize()),
      true
    );
    assertPreviewTablesRemainEmpty(runtime.database);
  });

  test("denies noncommissioner and cross-league authority without writes", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    assert.throws(() => runtime.service.preview({
      ...runtime.scope,
      ...explicitScheduleInput(),
      actorUserId: runtime.other.commissionerId,
      nowMs: NOW_MS,
    }), { code: MATCHUP_SCHEDULE_SERVICE_CODES.commissionerRequired });
    assert.throws(() => runtime.service.preview({
      leagueId: runtime.other.leagueId,
      seasonId: runtime.scope.seasonId,
      ...explicitScheduleInput(),
      actorUserId: runtime.other.commissionerId,
      nowMs: NOW_MS,
    }), { code: MATCHUP_SCHEDULE_SERVICE_CODES.contextMissing });
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("allows a member platform administrator without impersonating the commissioner", (t) => {
    const runtime = createRuntime(t);
    const platformMembershipId = uuid(900);
    runtime.context.repositories
      .league_memberships.insert({
        id: platformMembershipId,
        league_id: runtime.scope.leagueId,
        user_id: runtime.other.commissionerId,
        permission_category: "member",
        status: "active",
        joined_at_ms: NOW_MS,
        ended_at_ms: null,
        created_at_ms: NOW_MS,
        updated_at_ms: NOW_MS,
        version: 1,
      });
    runtime.context.repositories
      .platform_roles.insert({
        id: uuid(901),
        user_id: runtime.other.commissionerId,
        role: "platform_administrator",
        status: "active",
        granted_by_user_id: null,
        granted_at_ms: NOW_MS,
        ended_at_ms: null,
        version: 1,
      });
    const beforePreview =
      runtime.database.serialize();
    const input = {
      ...runtime.scope,
      ...explicitScheduleInput(),
      actorUserId: runtime.other.commissionerId,
      authorizedAsPlatformAdministrator: true,
      nowMs: NOW_MS,
    };
    const preview = runtime.service.preview(input);

    assert.equal(preview.plan.teamIds.length, 4);
    assert.equal(
      beforePreview.equals(
        runtime.database.serialize()
      ),
      true
    );
    const generated = runtime.service.generate(
      confirmedScheduleCommand(
        runtime.scope,
        {
          idempotencyKey:
            "matchup-schedule-platform-admin",
          authenticated: {
            actorUserId:
              runtime.other.commissionerId,
            authority:
              "platform_administrator",
            authorized: true,
            leagueId: runtime.scope.leagueId,
            membershipId: platformMembershipId,
          },
        }
      )
    );
    assert.equal(generated.weekCount, 22);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT actor_user_id, actor_membership_id,
                 actor_authority
          FROM matchup_schedule_command_results
        `)
        .get(),
      {
        actor_user_id:
          runtime.other.commissionerId,
        actor_membership_id:
          platformMembershipId,
        actor_authority:
          "platform_administrator_as_commissioner",
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT actor_user_id
          FROM matchup_operations
        `)
        .get().actor_user_id,
      runtime.other.commissionerId
    );
  });

  test("rejects generation at Week 1 and rolls every row back at each confirmed-command seam", (t) => {
    const runtime = createRuntime(t);
    assert.throws(() => runtime.service.preview({
      ...runtime.scope,
      ...explicitScheduleInput(),
      actorUserId: runtime.scope.commissionerId,
      nowMs: FIRST_WEEK_MS,
    }), { code: MATCHUP_SCHEDULE_CODES.calendarInvalid });

    for (const seam of [
      "after_season_cas",
      "after_schedule_children",
      "after_jobs_and_bindings",
      "after_command_result",
      "after_idempotency_completion",
    ]) {
      const failing = createRuntime(t, {
        beforeCommit(currentSeam) {
          if (currentSeam === seam) {
            throw new Error(`injected ${seam}`);
          }
        },
      });
      const before =
        failing.database.serialize();
      assert.throws(
        () =>
          failing.service.generate(
            confirmedScheduleCommand(
              failing.scope
            )
          ),
        (error) =>
          error.cause?.message ===
          `injected ${seam}`
      );
      assert.equal(
        before.equals(
          failing.database.serialize()
        ),
        true,
        seam
      );
      assertPreviewTablesRemainEmpty(
        failing.database
      );
    }
  });
});

describe("T-096 atomic Week 1 shift persistence", () => {
  test("shifts A to B to A with immutable generations, replacement jobs, and replay", (t) => {
    const observedSeams = [];
    const runtime = createRuntime(t, {
      beforeCommit(seam) {
        observedSeams.push(seam);
      },
    });
    const generateCommand =
      confirmedScheduleCommand(runtime.scope, {
        input: {
          ...explicitScheduleInput({
            firstWeekStartsAtMs:
              SECOND_WEEK_MS,
          }),
          confirmed: true,
        },
      });
    const generated =
      runtime.service.generate(
        generateCommand
      );
    const beforeShift =
      runtime.repository.readSchedule(
        runtime.scope
      );
    assert.equal(
      beforeShift.weeks.length,
      21
    );
    observedSeams.length = 0;

    const firstShiftCommand =
      shiftWeekOneCommand(runtime.scope, {
        weekId: generated.firstWeekId,
        expectedWeekVersion: 1,
        firstWeekStartsAtMs:
          FIRST_WEEK_MS,
        idempotencyKey:
          "matchup-week-one-shift-a-to-b",
      });
    const firstShift =
      runtime.service.shiftWeekOne(
        firstShiftCommand
      );
    assert.deepEqual(firstShift, {
      operationId: uuid(693),
      seasonId: runtime.scope.seasonId,
      seasonVersion: 3,
      weekId: generated.firstWeekId,
      weekVersion: 2,
      previousFirstWeekStartsAtMs:
        SECOND_WEEK_MS,
      firstWeekStartsAtMs:
        FIRST_WEEK_MS,
      lastWeekEndsAtMs:
        Date.parse(
          "2027-03-08T08:00:00.000Z"
        ),
      shiftedWeekCount: 21,
      replacedJobOccurrenceCount: 126,
    });
    assert.deepEqual(observedSeams, [
      "after_idempotency_started",
      "after_season_cas",
      "after_week_updates",
      "after_old_jobs_skipped",
      "after_old_generation_superseded",
      "after_new_generation",
      "after_jobs_and_bindings",
      "after_command_result",
      "after_idempotency_completion",
    ]);

    const afterFirstShift =
      runtime.repository.readSchedule(
        runtime.scope
      );
    assert.deepEqual(
      afterFirstShift.weeks.map(
        ({
          id,
          week_key: weekKey,
          sequence,
          version,
        }) => ({
          id,
          weekKey,
          sequence,
          version,
        })
      ),
      beforeShift.weeks.map(
        ({
          id,
          week_key: weekKey,
          sequence,
          version,
        }) => ({
          id,
          weekKey,
          sequence,
          version: version + 1,
        })
      )
    );
    assert.deepEqual(
      afterFirstShift.matchups,
      beforeShift.matchups
    );
    assert.deepEqual(
      afterFirstShift.byes,
      beforeShift.byes
    );
    assert.equal(
      afterFirstShift.weeks[0].starts_at_ms,
      FIRST_WEEK_MS
    );
    assert.equal(
      afterFirstShift.weeks.at(-1)
        .ends_at_ms,
      firstShift.lastWeekEndsAtMs
    );

    const generations =
      runtime.database
        .prepare(`
          SELECT
            schedule_version,
            schedule_operation_id,
            week_one_matchup_week_id,
            week_one_starts_at_ms,
            status,
            superseded_at_ms,
            version
          FROM season_matchup_schedule_generations
          WHERE league_id = ?
            AND season_id = ?
          ORDER BY schedule_version
        `)
        .all(
          runtime.scope.leagueId,
          runtime.scope.seasonId
        );
    assert.deepEqual(generations, [
      {
        schedule_version: 1,
        schedule_operation_id:
          generated.operationId,
        week_one_matchup_week_id:
          generated.firstWeekId,
        week_one_starts_at_ms:
          SECOND_WEEK_MS,
        status: "superseded",
        superseded_at_ms: NOW_MS,
        version: 2,
      },
      {
        schedule_version: 2,
        schedule_operation_id:
          firstShift.operationId,
        week_one_matchup_week_id:
          generated.firstWeekId,
        week_one_starts_at_ms:
          FIRST_WEEK_MS,
        status: "current",
        superseded_at_ms: null,
        version: 1,
      },
    ]);
    const generationJobs =
      runtime.database
        .prepare(`
          SELECT
            binding.schedule_version,
            binding.schedule_operation_id,
            job.job_type,
            job.status,
            job.attempt_count,
            job.next_attempt_at_ms,
            job.scheduled_for_ms,
            job.occurrence_key
          FROM matchup_schedule_job_bindings
            AS binding
          JOIN job_runs AS job
            ON job.league_id =
                binding.league_id
           AND job.id = binding.job_run_id
          WHERE binding.league_id = ?
            AND binding.season_id = ?
          ORDER BY
            binding.schedule_version,
            job.scheduled_for_ms,
            job.job_type,
            job.id
        `)
        .all(
          runtime.scope.leagueId,
          runtime.scope.seasonId
        );
    assert.equal(
      generationJobs.length,
      252
    );
    assert.equal(
      generationJobs
        .filter(
          ({ schedule_version: version }) =>
            version === 1
        )
        .every(
          ({
            status,
            attempt_count: attemptCount,
            next_attempt_at_ms:
              nextAttemptAtMs,
          }) =>
            status === "skipped" &&
            attemptCount === 0 &&
            nextAttemptAtMs === null
        ),
      true
    );
    assert.equal(
      generationJobs
        .filter(
          ({ schedule_version: version }) =>
            version === 2
        )
        .every((row) => {
          const parsed =
            parseMatchupOccurrenceKey({
              jobType: row.job_type,
              leagueId:
                runtime.scope.leagueId,
              seasonId:
                runtime.scope.seasonId,
              occurrenceKey:
                row.occurrence_key,
              scheduledForMs:
                row.scheduled_for_ms,
            });
          return (
            row.status === "pending" &&
            row.attempt_count === 0 &&
            row.next_attempt_at_ms ===
              row.scheduled_for_ms &&
            parsed.scheduleOperationId ===
              firstShift.operationId &&
            parsed.scheduleVersion === 2
          );
        }),
      true
    );

    const beforeReplays =
      runtime.database.serialize();
    assert.deepEqual(
      runtime.service.shiftWeekOne(
        firstShiftCommand
      ),
      firstShift
    );
    assert.deepEqual(
      runtime.service.generate(
        generateCommand
      ),
      generated
    );
    assert.equal(
      beforeReplays.equals(
        runtime.database.serialize()
      ),
      true
    );

    const secondShift =
      runtime.service.shiftWeekOne(
        shiftWeekOneCommand(
          runtime.scope,
          {
            weekId: generated.firstWeekId,
            expectedWeekVersion: 2,
            firstWeekStartsAtMs:
              SECOND_WEEK_MS,
            idempotencyKey:
              "matchup-week-one-shift-b-to-a",
          }
        )
      );
    assert.deepEqual(secondShift, {
      operationId: uuid(822),
      seasonId: runtime.scope.seasonId,
      seasonVersion: 4,
      weekId: generated.firstWeekId,
      weekVersion: 3,
      previousFirstWeekStartsAtMs:
        FIRST_WEEK_MS,
      firstWeekStartsAtMs:
        SECOND_WEEK_MS,
      lastWeekEndsAtMs: PLAYOFFS_MS,
      shiftedWeekCount: 21,
      replacedJobOccurrenceCount: 126,
    });
    assert.deepEqual(
      runtime.service.shiftWeekOne(
        firstShiftCommand
      ),
      firstShift
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            schedule_version,
            schedule_operation_id,
            week_one_starts_at_ms,
            status,
            version
          FROM season_matchup_schedule_generations
          WHERE league_id = ?
            AND season_id = ?
          ORDER BY schedule_version
        `)
        .all(
          runtime.scope.leagueId,
          runtime.scope.seasonId
        ),
      [
        {
          schedule_version: 1,
          schedule_operation_id:
            generated.operationId,
          week_one_starts_at_ms:
            SECOND_WEEK_MS,
          status: "superseded",
          version: 2,
        },
        {
          schedule_version: 2,
          schedule_operation_id:
            firstShift.operationId,
          week_one_starts_at_ms:
            FIRST_WEEK_MS,
          status: "superseded",
          version: 2,
        },
        {
          schedule_version: 3,
          schedule_operation_id:
            secondShift.operationId,
          week_one_starts_at_ms:
            SECOND_WEEK_MS,
          status: "current",
          version: 1,
        },
      ]
    );
    const jobsAfterSecondShift =
      runtime.database
        .prepare(`
          SELECT
            binding.schedule_version,
            binding.schedule_operation_id,
            job.job_type,
            job.occurrence_key,
            job.scheduled_for_ms,
            job.status,
            job.next_attempt_at_ms
          FROM matchup_schedule_job_bindings
            AS binding
          JOIN job_runs AS job
            ON job.league_id =
                binding.league_id
           AND job.id = binding.job_run_id
          WHERE binding.league_id = ?
            AND binding.season_id = ?
          ORDER BY
            binding.schedule_version,
            job.id
        `)
        .all(
          runtime.scope.leagueId,
          runtime.scope.seasonId
        );
    for (const scheduleVersion of [1, 2]) {
      const oldJobs =
        jobsAfterSecondShift.filter(
          (row) =>
            row.schedule_version ===
            scheduleVersion
        );
      assert.equal(oldJobs.length, 126);
      assert.equal(
        oldJobs.every(
          (row) =>
            row.status === "skipped" &&
            row.next_attempt_at_ms === null
        ),
        true
      );
    }
    const currentJobs =
      jobsAfterSecondShift.filter(
        (row) => row.schedule_version === 3
      );
    assert.equal(currentJobs.length, 126);
    assert.equal(
      currentJobs.every((row) => {
        const parsed =
          parseMatchupOccurrenceKey({
            jobType: row.job_type,
            leagueId:
              runtime.scope.leagueId,
            seasonId:
              runtime.scope.seasonId,
            occurrenceKey:
              row.occurrence_key,
            scheduledForMs:
              row.scheduled_for_ms,
          });
        return (
          row.status === "pending" &&
          row.next_attempt_at_ms ===
            row.scheduled_for_ms &&
          row.schedule_operation_id ===
            secondShift.operationId &&
          parsed.scheduleOperationId ===
            secondShift.operationId &&
          parsed.scheduleVersion === 3
        );
      }),
      true
    );
  });

  test("rejects frozen, stale, non-Week-1, and corrupt persisted contexts without writes", (t) => {
    const runtime = createRuntime(t);
    const generated =
      runtime.service.generate(
        confirmedScheduleCommand(
          runtime.scope,
          {
            input: {
              ...explicitScheduleInput({
                firstWeekStartsAtMs:
                  SECOND_WEEK_MS,
              }),
              confirmed: true,
            },
          }
        )
      );
    const stored =
      runtime.repository.readSchedule(
        runtime.scope
      );
    const baseCommand =
      shiftWeekOneCommand(runtime.scope, {
        weekId: generated.firstWeekId,
        expectedWeekVersion: 1,
        firstWeekStartsAtMs:
          FIRST_WEEK_MS,
        idempotencyKey:
          "invalid-shift-context",
      });

    const cases = [
      {
        name: "FAD freeze",
        mutate(context) {
          context.fadCount = 1;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .fadWeekOneFrozen,
      },
      {
        name: "unbound matchup job",
        mutate(context) {
          context.unboundJobCount = 1;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "season status",
        mutate(context) {
          context.seasonStatus = "completed";
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .seasonInvalid,
      },
      {
        name: "season version",
        mutate(context) {
          context.seasonVersion =
            Number.MAX_SAFE_INTEGER;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .seasonInvalid,
      },
      {
        name: "missing current generation",
        mutate(context) {
          context.currentGenerationCount = 0;
          context.currentGeneration = null;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "generation version",
        mutate(context) {
          context.currentGeneration.scheduleVersion =
            Number.MAX_SAFE_INTEGER;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "week status",
        mutate(context) {
          context.weeks[0].status = "active";
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "Week 1 sequence",
        mutate(context) {
          context.weeks[0].sequence = 2;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "noncontiguous week sequence",
        mutate(context) {
          context.weeks[1].sequence = 3;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "week version",
        mutate(context) {
          context.weeks[0].version =
            Number.MAX_SAFE_INTEGER;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "persisted week identity",
        mutate(context) {
          context.weeks[1].id =
            "not-a-canonical-week-id";
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "persisted matchup identity",
        mutate(context) {
          context.weeks[0].matchups[0].id =
            "not-a-canonical-matchup-id";
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "persisted matchup version",
        mutate(context) {
          context.weeks[0].matchups[0].version =
            Number.MAX_SAFE_INTEGER;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "persisted bye identity",
        mutate(context) {
          context.weeks[0].bye = {
            id: "not-a-canonical-bye-id",
            leagueId: context.leagueId,
            seasonId: context.seasonId,
            weekId: context.weeks[0].id,
            teamId: uuid(8_887),
          };
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "duplicate weekly participant",
        mutate(context) {
          context.weeks[0].matchups[1]
            .homeTeamId =
            context.weeks[0].matchups[0]
              .homeTeamId;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "active team set",
        mutate(context) {
          context.teams.pop();
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "job lifecycle",
        mutate(context) {
          context.jobs[0].status = "running";
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "missing generation job",
        mutate(context) {
          context.jobs.pop();
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "extra duplicate generation job",
        mutate(context) {
          context.jobs.push({
            ...context.jobs[0],
          });
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "attempted generation job",
        mutate(context) {
          context.jobs[0].attemptCount = 1;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "leased generation job",
        mutate(context) {
          context.jobs[0].leaseOwner =
            "worker-1";
          context.jobs[0].leaseToken =
            uuid(7_777);
          context.jobs[0].leaseExpiresAtMs =
            NOW_MS + 60_000;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "job version",
        mutate(context) {
          context.jobs[0].version =
            Number.MAX_SAFE_INTEGER;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "binding generation",
        mutate(context) {
          context.jobs[0]
            .bindingScheduleVersion = 2;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "binding creation time",
        mutate(context) {
          context.jobs[0]
            .bindingCreatedAtMs += 1;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "persisted calendar",
        mutate(context) {
          context.fantasyPlayoffsEndAtMs =
            null;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
      {
        name: "persisted week boundary",
        mutate(context) {
          context.weeks[1].baselineAtMs +=
            1;
        },
        code:
          MATCHUP_SCHEDULE_SERVICE_CODES
            .weekInvalid,
      },
    ];
    for (const entry of cases) {
      const before =
        runtime.database.serialize();
      const service = createShiftService(
        runtime,
        {
          readShiftContext(scope) {
            const context =
              structuredClone(
                runtime.repository
                  .readShiftContext(scope)
              );
            entry.mutate(context);
            return context;
          },
        }
      );
      assert.throws(
        () =>
          service.shiftWeekOne(
            baseCommand
          ),
        { code: entry.code },
        entry.name
      );
      assert.equal(
        before.equals(
          runtime.database.serialize()
        ),
        true,
        entry.name
      );
    }

    for (const [
      command,
      expectedCode,
      name,
    ] of [
      [
        {
          ...baseCommand,
          weekId: uuid(8_888),
        },
        MATCHUP_SCHEDULE_SERVICE_CODES
          .weekMissing,
        "missing week",
      ],
      [
        {
          ...baseCommand,
          weekId: stored.weeks[1].id,
        },
        MATCHUP_SCHEDULE_SERVICE_CODES
          .weekInvalid,
        "non-Week-1",
      ],
      [
        {
          ...baseCommand,
          expectedWeekVersion: 2,
        },
        MATCHUP_SCHEDULE_SERVICE_CODES
          .preconditionFailed,
        "stale Week 1 version",
      ],
    ]) {
      const before =
        runtime.database.serialize();
      assert.throws(
        () =>
          createShiftService(
            runtime
          ).shiftWeekOne(command),
        { code: expectedCode },
        name
      );
      assert.equal(
        before.equals(
          runtime.database.serialize()
        ),
        true,
        name
      );
    }

    {
      const before =
        runtime.database.serialize();
      assert.throws(
        () =>
          createShiftService(runtime, {
            nowMs: SECOND_WEEK_MS,
          }).shiftWeekOne(baseCommand),
        {
          code:
            MATCHUP_SCHEDULE_SERVICE_CODES
              .weekInvalid,
        },
        "persisted Week 1 already started"
      );
      assert.equal(
        before.equals(
          runtime.database.serialize()
        ),
        true
      );
    }
    {
      const before =
        runtime.database.serialize();
      assert.throws(
        () =>
          createShiftService(
            runtime
          ).shiftWeekOne({
            ...baseCommand,
            input: {
              ...baseCommand.input,
              firstWeekStartsAtMs: NOW_MS,
            },
          }),
        {
          code:
            MATCHUP_SCHEDULE_CODES
              .calendarInvalid,
        },
        "proposed replacement timing remains a policy error"
      );
      assert.equal(
        before.equals(
          runtime.database.serialize()
        ),
        true
      );
    }
  });

  test("persists a member platform administrator as acting commissioner", (t) => {
    const runtime = createRuntime(t);
    const generated =
      runtime.service.generate(
        confirmedScheduleCommand(
          runtime.scope,
          {
            input: {
              ...explicitScheduleInput({
                firstWeekStartsAtMs:
                  SECOND_WEEK_MS,
              }),
              confirmed: true,
            },
          }
        )
      );
    const platformMembershipId =
      uuid(9_700);
    runtime.context.repositories
      .league_memberships.insert({
        id: platformMembershipId,
        league_id: runtime.scope.leagueId,
        user_id:
          runtime.other.commissionerId,
        permission_category: "member",
        status: "active",
        joined_at_ms: NOW_MS,
        ended_at_ms: null,
        created_at_ms: NOW_MS,
        updated_at_ms: NOW_MS,
        version: 1,
      });
    runtime.context.repositories
      .platform_roles.insert({
        id: uuid(9_701),
        user_id:
          runtime.other.commissionerId,
        role: "platform_administrator",
        status: "active",
        granted_by_user_id: null,
        granted_at_ms: NOW_MS,
        ended_at_ms: null,
        version: 1,
      });

    const shifted =
      runtime.service.shiftWeekOne({
        ...shiftWeekOneCommand(
          runtime.scope,
          {
            weekId:
              generated.firstWeekId,
            expectedWeekVersion: 1,
            firstWeekStartsAtMs:
              FIRST_WEEK_MS,
            idempotencyKey:
              "platform-admin-week-one-shift",
          }
        ),
        authenticated: {
          actorUserId:
            runtime.other.commissionerId,
          authority:
            "platform_administrator",
          authorized: true,
          leagueId:
            runtime.scope.leagueId,
          membershipId:
            platformMembershipId,
        },
      });
    assert.equal(
      shifted.firstWeekStartsAtMs,
      FIRST_WEEK_MS
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            actor_user_id,
            actor_membership_id,
            actor_authority
          FROM matchup_schedule_command_results
          WHERE action = 'shift_week_one'
        `)
        .get(),
      {
        actor_user_id:
          runtime.other.commissionerId,
        actor_membership_id:
          platformMembershipId,
        actor_authority:
          "platform_administrator_as_commissioner",
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT actor_user_id
          FROM matchup_operations
          WHERE id = ?
        `)
        .get(shifted.operationId)
        .actor_user_id,
      runtime.other.commissionerId
    );
  });

  test("preserves approved pairings and explicit byes for an odd team count", (t) => {
    const runtime = createRuntime(t, {
      teamCount: 5,
    });
    const generated =
      runtime.service.generate(
        confirmedScheduleCommand(
          runtime.scope,
          {
            input: {
              ...explicitScheduleInput({
                firstWeekStartsAtMs:
                  SECOND_WEEK_MS,
              }),
              confirmed: true,
            },
          }
        )
      );
    const before =
      runtime.repository.readSchedule(
        runtime.scope
      );
    assert.equal(before.byes.length, 21);
    runtime.service.shiftWeekOne(
      shiftWeekOneCommand(
        runtime.scope,
        {
          weekId: generated.firstWeekId,
          expectedWeekVersion: 1,
          firstWeekStartsAtMs:
            FIRST_WEEK_MS,
          idempotencyKey:
            "odd-team-week-one-shift",
        }
      )
    );
    const after =
      runtime.repository.readSchedule(
        runtime.scope
      );
    assert.deepEqual(
      after.matchups,
      before.matchups
    );
    assert.deepEqual(after.byes, before.byes);
    assert.equal(after.byes.length, 21);
  });

  test("replaces migration-shaped legacy occurrence keys with generation-qualified keys", (t) => {
    const runtime = createRuntime(t);
    const generated =
      runtime.service.generate(
        confirmedScheduleCommand(
          runtime.scope,
          {
            input: {
              ...explicitScheduleInput({
                firstWeekStartsAtMs:
                  SECOND_WEEK_MS,
              }),
              confirmed: true,
            },
          }
        )
      );
    runtime.database
      .prepare(`
        UPDATE job_runs
        SET occurrence_key =
          job_type || ':' ||
          league_id || ':' ||
          season_id || ':' ||
          (
            SELECT owning_matchup_week_id
            FROM matchup_schedule_job_bindings
            WHERE matchup_schedule_job_bindings
                .league_id = job_runs.league_id
              AND matchup_schedule_job_bindings
                .job_run_id = job_runs.id
          ) || ':' ||
          scheduled_for_ms
        WHERE league_id = ?
          AND season_id = ?
      `)
      .run(
        runtime.scope.leagueId,
        runtime.scope.seasonId
      );
    const legacyRows =
      runtime.database
        .prepare(`
          SELECT
            job.job_type,
            job.occurrence_key,
            job.scheduled_for_ms,
            binding.owning_matchup_week_id
          FROM job_runs AS job
          JOIN matchup_schedule_job_bindings
            AS binding
            ON binding.league_id =
                job.league_id
           AND binding.job_run_id = job.id
          WHERE binding.schedule_version = 1
        `)
        .all();
    assert.equal(
      legacyRows.length,
      126
    );
    assert.equal(
      legacyRows.every((row) => {
        const parsed =
          parseMatchupOccurrenceKey({
            jobType: row.job_type,
            leagueId:
              runtime.scope.leagueId,
            seasonId:
              runtime.scope.seasonId,
            occurrenceKey:
              row.occurrence_key,
            scheduledForMs:
              row.scheduled_for_ms,
          });
        return (
          parsed.weekId ===
            row.owning_matchup_week_id &&
          parsed.scheduleOperationId ===
            null &&
          parsed.scheduleVersion === null
        );
      }),
      true
    );

    const shifted =
      runtime.service.shiftWeekOne(
        shiftWeekOneCommand(
          runtime.scope,
          {
            weekId:
              generated.firstWeekId,
            expectedWeekVersion: 1,
            firstWeekStartsAtMs:
              FIRST_WEEK_MS,
            idempotencyKey:
              "legacy-key-week-one-shift",
          }
        )
      );
    const replacements =
      runtime.database
        .prepare(`
          SELECT
            job.job_type,
            job.occurrence_key,
            job.scheduled_for_ms,
            job.status
          FROM job_runs AS job
          JOIN matchup_schedule_job_bindings
            AS binding
            ON binding.league_id =
                job.league_id
           AND binding.job_run_id = job.id
          WHERE binding.schedule_version = 2
        `)
        .all();
    assert.equal(replacements.length, 126);
    assert.equal(
      replacements.every((row) => {
        const parsed =
          parseMatchupOccurrenceKey({
            jobType: row.job_type,
            leagueId:
              runtime.scope.leagueId,
            seasonId:
              runtime.scope.seasonId,
            occurrenceKey:
              row.occurrence_key,
            scheduledForMs:
              row.scheduled_for_ms,
          });
        return (
          row.status === "pending" &&
          parsed.scheduleOperationId ===
            shifted.operationId &&
          parsed.scheduleVersion === 2
        );
      }),
      true
    );
  });

  test("rolls the complete database back at every Week 1 shift transaction seam", (t) => {
    for (const seam of [
      "after_idempotency_started",
      "after_season_cas",
      "after_week_updates",
      "after_old_jobs_skipped",
      "after_old_generation_superseded",
      "after_new_generation",
      "after_jobs_and_bindings",
      "after_command_result",
      "after_idempotency_completion",
    ]) {
      let armed = false;
      const runtime = createRuntime(t, {
        beforeCommit(currentSeam) {
          if (
            armed &&
            currentSeam === seam
          ) {
            throw new Error(
              `injected ${seam}`
            );
          }
        },
      });
      const generated =
        runtime.service.generate(
          confirmedScheduleCommand(
            runtime.scope,
            {
              input: {
                ...explicitScheduleInput({
                  firstWeekStartsAtMs:
                    SECOND_WEEK_MS,
                }),
                confirmed: true,
              },
            }
          )
        );
      const before =
        runtime.database.serialize();
      armed = true;
      assert.throws(
        () =>
          runtime.service.shiftWeekOne(
            shiftWeekOneCommand(
              runtime.scope,
              {
                weekId:
                  generated.firstWeekId,
                expectedWeekVersion: 1,
                firstWeekStartsAtMs:
                  FIRST_WEEK_MS,
                idempotencyKey:
                  `rollback-${seam}`,
              }
            )
          ),
        (error) =>
          error.cause?.message ===
          `injected ${seam}`,
        seam
      );
      assert.equal(
        before.equals(
          runtime.database.serialize()
        ),
        true,
        seam
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              schedule_version,
              status,
              version
            FROM season_matchup_schedule_generations
            WHERE league_id = ?
              AND season_id = ?
          `)
          .get(
            runtime.scope.leagueId,
            runtime.scope.seasonId
          ),
        {
          schedule_version: 1,
          status: "current",
          version: 1,
        },
        seam
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM matchup_schedule_command_results
            WHERE league_id = ?
              AND season_id = ?
              AND action = 'shift_week_one'
          `)
          .get(
            runtime.scope.leagueId,
            runtime.scope.seasonId
          ).count,
        0,
        seam
      );
    }
  });
});
