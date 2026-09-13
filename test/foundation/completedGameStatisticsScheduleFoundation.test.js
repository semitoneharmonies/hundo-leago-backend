const assert = require("node:assert/strict");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const { createSqliteStatisticsScheduleRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsScheduleRepository");
const { latestEveningOccurrence, createRunCompletedGameStatisticsJob } = require("../../src/jobs/definitions/runCompletedGameStatistics");

function repository(t) {
  const database = new Database(":memory:");
  t.after(() => database.close());
  database.exec(`CREATE TABLE job_runs (id TEXT PRIMARY KEY, league_id TEXT, job_type TEXT, occurrence_key TEXT, scheduled_for_ms INTEGER, status TEXT, attempt_count INTEGER, lease_owner TEXT, lease_expires_at_ms INTEGER, started_at_ms INTEGER, completed_at_ms INTEGER, result_json TEXT, last_error_code TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, version INTEGER); CREATE UNIQUE INDEX global_occurrence ON job_runs(job_type, occurrence_key) WHERE league_id IS NULL;`);
  return { database, repository: createSqliteStatisticsScheduleRepository({ database }) };
}

test("four Pacific evening refresh slots remain correct across daylight saving changes", () => {
  for (const [now, expected] of [
    ["2026-10-12T01:01:00Z", "2026-10-12T01:00:00Z"],
    ["2026-10-12T03:00:00Z", "2026-10-12T03:00:00Z"],
    ["2026-10-12T05:30:00Z", "2026-10-12T05:00:00Z"],
    ["2026-10-12T07:00:00Z", "2026-10-12T06:45:00Z"],
    ["2026-11-01T20:00:00Z", "2026-11-01T06:45:00Z"],
    ["2026-11-02T02:01:00Z", "2026-11-02T02:00:00Z"],
  ]) assert.equal(latestEveningOccurrence(Date.parse(now)), Date.parse(expected));
});

test("statistics refresh remains completed after scheduler restart and another worker cannot claim its lease", async (t) => {
  const { database, repository: store } = repository(t);
  let calls = 0;
  const now = Date.parse("2026-10-12T01:01:00Z");
  const options = { repository: store, statisticsService: { async refresh({ authorizePersist }) { authorizePersist(); calls += 1; return { refreshId: "verified-refresh" }; } }, nhlSeasonKey: "20262027", clock: { nowMs: () => now }, logger: { error() {} } };
  const first = createRunCompletedGameStatisticsJob(options);
  assert.equal((await first.run()).status, "succeeded");
  assert.equal((await createRunCompletedGameStatisticsJob(options).run()).status, "skipped");
  assert.equal(calls, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM job_runs").get().count, 1);
  const next = { occurrenceKey: `20262027:${now}`, scheduledForMs: now, nowMs: now, owner: "first" };
  const lease = store.claim(next);
  assert.ok(lease);
  assert.equal(store.claim({ ...next, owner: "second" }), null);
  assert.throws(() => store.assertLease(lease, now + 600_001), { code: "NHL_STATISTICS_LEASE_LOST" });
});

test("failed scheduled refresh is durably retried after fifteen minutes", async (t) => {
  const { repository: store } = repository(t);
  let now = Date.parse("2026-10-12T01:01:00Z"), calls = 0;
  const job = createRunCompletedGameStatisticsJob({ repository: store, statisticsService: { async refresh() { calls += 1; if (calls === 1) throw Object.assign(new Error("offline"), { code: "NHL_OFFLINE" }); return { refreshId: "recovered" }; } }, nhlSeasonKey: "20262027", clock: { nowMs: () => now }, logger: { error() {} } });
  assert.equal((await job.run()).status, "failed");
  now += 14 * 60_000;
  assert.equal((await job.run()).status, "skipped");
  now += 60_000;
  assert.equal((await job.run()).status, "succeeded");
  assert.equal(calls, 2);
});
