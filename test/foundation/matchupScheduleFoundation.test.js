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
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
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

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function idFactory(start = 500) {
  let value = start;
  return () => uuid(value++);
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
    regular_season_ends_at_ms: Date.parse("2027-04-18T07:00:00.000Z"),
    fantasy_playoffs_start_at_ms: PLAYOFFS_MS,
    fantasy_playoffs_end_at_ms: Date.parse("2027-04-12T07:00:00.000Z"),
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
  return { commissionerId, leagueId, seasonId, teamIds };
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
  const service = createMatchupScheduleService({ repository, createId: idFactory() });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { context, database: connection.database, other, repository, scope, service };
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
    const runtime = createRuntime(t, { teamCount: 5 });
    const input = { ...runtime.scope, actorUserId: runtime.scope.commissionerId, nowMs: NOW_MS };
    const before = runtime.database.serialize();
    const preview = runtime.service.preview(input);
    assert.equal(preview.plan.weeks.length, 22);
    assert.equal(before.equals(runtime.database.serialize()), true);

    assert.deepEqual(runtime.service.generate(input), {
      participantCount: 5,
      weekCount: 22,
      matchupCount: 44,
      byeCount: 22,
      operationId: uuid(720),
    });
    const stored = runtime.repository.readSchedule(runtime.scope);
    assert.equal(stored.weeks.length, 22);
    assert.equal(stored.matchups.length, 44);
    assert.equal(stored.byes.length, 22);
    assert.equal(stored.matchups[0].home_team_name.startsWith("Team 10-"), true);
    assert.equal(stored.byes[0].team_display_name.startsWith("Team 10-"), true);
    const occurrences = runtime.database
      .prepare(
        "SELECT job_type, scheduled_for_ms, status, attempt_count " +
          "FROM job_runs ORDER BY scheduled_for_ms, job_type, id"
      )
      .all();
    assert.equal(occurrences.length, 132);
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
    assert.throws(() => runtime.service.generate(input), {
      code: MATCHUP_SCHEDULE_SERVICE_CODES.alreadyExists,
    });
  });

  test("denies noncommissioner and cross-league authority without writes", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    assert.throws(() => runtime.service.preview({
      ...runtime.scope,
      actorUserId: runtime.other.commissionerId,
      nowMs: NOW_MS,
    }), { code: MATCHUP_SCHEDULE_SERVICE_CODES.commissionerRequired });
    assert.throws(() => runtime.service.preview({
      leagueId: runtime.other.leagueId,
      seasonId: runtime.scope.seasonId,
      actorUserId: runtime.other.commissionerId,
      nowMs: NOW_MS,
    }), { code: MATCHUP_SCHEDULE_SERVICE_CODES.contextMissing });
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("allows a previously authorized platform administrator without impersonating the commissioner", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const input = {
      ...runtime.scope,
      actorUserId: runtime.other.commissionerId,
      authorizedAsPlatformAdministrator: true,
      nowMs: NOW_MS,
    };
    const preview = runtime.service.preview(input);

    assert.equal(preview.plan.teamIds.length, 4);
    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.equal(runtime.service.generate(input).weekCount, 22);
    assert.equal(
      runtime.database
        .prepare("SELECT actor_user_id FROM matchup_operations")
        .get().actor_user_id,
      runtime.other.commissionerId
    );
  });

  test("rejects generation at Week 1 and rolls every row back after a late failure", (t) => {
    const runtime = createRuntime(t, { beforeCommit() { throw new Error("late failure"); } });
    assert.throws(() => runtime.service.preview({
      ...runtime.scope,
      actorUserId: runtime.scope.commissionerId,
      nowMs: Date.parse("2026-10-12T07:00:00.000Z"),
    }), { code: MATCHUP_SCHEDULE_SERVICE_CODES.seasonStarted });
    assert.throws(() => runtime.service.generate({
      ...runtime.scope,
      actorUserId: runtime.scope.commissionerId,
      nowMs: NOW_MS,
    }));
    for (const table of [
      "matchup_weeks",
      "matchups",
      "matchup_byes",
      "matchup_operations",
      "job_runs",
    ]) {
      assert.equal(runtime.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
  });
});
