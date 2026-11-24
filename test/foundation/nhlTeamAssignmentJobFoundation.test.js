const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createSqliteStatisticsScheduleRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsScheduleRepository");
const { JOB_TYPE, createRefreshNhlTeamAssignmentsJob } = require("../../src/jobs/definitions/refreshNhlTeamAssignments");

function fixture(t) {
  const database = new Database(":memory:");
  t.after(() => database.close());
  database.exec(`CREATE TABLE job_runs (id TEXT PRIMARY KEY, league_id TEXT, job_type TEXT, occurrence_key TEXT,
    scheduled_for_ms INTEGER, status TEXT, attempt_count INTEGER, lease_owner TEXT, lease_expires_at_ms INTEGER,
    started_at_ms INTEGER, completed_at_ms INTEGER, result_json TEXT, last_error_code TEXT, created_at_ms INTEGER,
    updated_at_ms INTEGER, version INTEGER);
    CREATE UNIQUE INDEX global_occurrence ON job_runs(job_type, occurrence_key) WHERE league_id IS NULL;`);
  const state = { now: Date.parse("2026-11-24T16:01:00Z"), fetches: 0, writes: 0, fail: false, expire: false };
  const repository = createSqliteStatisticsScheduleRepository({ database, jobType: JOB_TYPE });
  const players = [{ playerId: "80000000-0000-4000-8000-000000000001", providerPlayerId: "8477946", nhlTeamAbbreviation: "DET" }];
  const options = { repository, nhlSeasonKey: "20262027", clock: { nowMs: () => state.now }, logger: { error() {} },
    teamRepository: { readPlayers: () => players, applyAssignments(command) {
      command.authorizePersist(); state.writes++;
      assert.equal(command.assignments[0].nhlTeamAbbreviation, "MTL");
      return { changedPlayers: 1, unchangedPlayers: 0, skippedPlayers: 0, operationId: "operation" };
    } },
    provider: { async fetchAssignments(input) {
      assert.deepEqual(input.players, players); state.fetches++;
      if (state.fail) throw Object.assign(new Error("invalid feed"), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
      if (state.expire) state.now += 600_001;
      return { observedAtMs: state.now, sourceVersion: "a".repeat(64), assignments: [{ ...players[0], nhlTeamAbbreviation: "MTL" }],
        counts: { cataloguePlayers: 1, indexPlayers: 1, matchedPlayers: 1, unchangedPlayers: 0, omittedPlayers: 0, confirmedChanges: 1 } };
    } } };
  return { database, state, options };
}

test("daily NHL teams run once at eight Pacific across restart with a separate statistics namespace", async t => {
  const { database, state, options } = fixture(t);
  const result = await createRefreshNhlTeamAssignmentsJob(options).run();
  assert.equal(result.status, "succeeded"); assert.equal(result.scheduledForMs, Date.parse("2026-11-24T16:00:00Z"));
  assert.equal(result.changedPlayers, 1);
  assert.equal((await createRefreshNhlTeamAssignmentsJob(options).run()).status, "skipped");
  assert.equal(state.fetches, 1); assert.equal(state.writes, 1);
  const row = database.prepare("SELECT * FROM job_runs").get();
  assert.equal(row.job_type, JOB_TYPE); assert.equal(row.status, "succeeded");
  assert.equal(JSON.parse(row.result_json).counts.confirmedChanges, 1);
  const stats = createSqliteStatisticsScheduleRepository({ database });
  assert.ok(stats.claim({ occurrenceKey: row.occurrence_key, scheduledForMs: row.scheduled_for_ms, nowMs: state.now, owner: "statistics" }));
  state.now = Date.parse("2026-11-25T16:01:00Z");
  assert.equal((await createRefreshNhlTeamAssignmentsJob(options).run()).status, "succeeded");
  assert.equal(state.writes, 2);
});

test("invalid team feed writes no assignments and retries after fifteen minutes", async t => {
  const { database, state, options } = fixture(t);
  state.fail = true;
  const job = createRefreshNhlTeamAssignmentsJob(options);
  assert.equal((await job.run()).status, "failed"); assert.equal(state.writes, 0);
  assert.equal(database.prepare("SELECT last_error_code FROM job_runs").get().last_error_code, "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE");
  state.now += 14 * 60_000; state.fail = false;
  assert.equal((await job.run()).status, "skipped"); assert.equal(state.fetches, 1);
  state.now += 60_000;
  assert.equal((await job.run()).status, "succeeded"); assert.equal(state.writes, 1);
});

test("expired daily lease prevents assignment writes and returns a contained failure", async t => {
  const { state, options } = fixture(t);
  state.expire = true;
  const result = await createRefreshNhlTeamAssignmentsJob(options).run();
  assert.equal(result.status, "failed"); assert.equal(result.code, "NHL_STATISTICS_LEASE_LOST");
  assert.equal(state.writes, 0);
});

test("daily team refresh uses the correct eight-Pacific occurrence across daylight saving", async t => {
  for (const [instant, expected] of [["2026-10-31T15:01:00Z", "2026-10-31T15:00:00Z"],
    ["2026-11-01T16:01:00Z", "2026-11-01T16:00:00Z"], ["2027-03-14T15:01:00Z", "2027-03-14T15:00:00Z"]]) {
    const { state, options } = fixture(t); state.now = Date.parse(instant);
    assert.equal((await createRefreshNhlTeamAssignmentsJob(options).run()).scheduledForMs, Date.parse(expected));
  }
});
