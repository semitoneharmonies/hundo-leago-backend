const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  M6_JOB_TYPES,
  MATCHUP_JOB_CODES,
  buildMatchupOccurrenceKey,
  parseMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  createRunMatchupOccurrencesJob,
} = require("../../src/jobs/definitions/runMatchupOccurrences");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupJobRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupJobRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const IDS = Object.freeze({ league: uuid(1), otherLeague: uuid(2), season: uuid(3), week: uuid(4) });

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seed(database) {
  const insertLeague = database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'active', 'America/Vancouver', 1, 1, 1)"
  );
  insertLeague.run(IDS.league, "Job League", "job league");
  insertLeague.run(IDS.otherLeague, "Other Job League", "other job league");
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
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

function occurrence(jobType = "matchup:lock", scheduledForMs = 100) {
  return {
    runId: uuid(100 + M6_JOB_TYPES.indexOf(jobType)),
    leagueId: IDS.league,
    seasonId: IDS.season,
    jobType,
    occurrenceKey: buildMatchupOccurrenceKey({
      jobType,
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      scheduledForMs,
    }),
    scheduledForMs,
    nowMs: 1,
  };
}

describe("M6-09 deterministic matchup occurrences", () => {
  test("builds stable scope-complete keys for only approved job types", () => {
    const first = occurrence();
    assert.equal(first.occurrenceKey, occurrence().occurrenceKey);
    assert.match(first.occurrenceKey, /^matchup:lock:/);
    assert.deepEqual(parseMatchupOccurrenceKey(first), {
      jobType: first.jobType,
      leagueId: first.leagueId,
      seasonId: first.seasonId,
      weekId: IDS.week,
      scheduledForMs: first.scheduledForMs,
    });
    assert.throws(
      () => parseMatchupOccurrenceKey({ ...first, occurrenceKey: `${first.occurrenceKey}0` }),
      { code: MATCHUP_JOB_CODES.inputInvalid }
    );
    assert.throws(
      () => buildMatchupOccurrenceKey({ ...first, jobType: "unknown", weekId: IDS.week }),
      { code: MATCHUP_JOB_CODES.inputInvalid }
    );
  });
});

describe("M6-09 durable claims, leases, and recovery", () => {
  test("schedules exactly, allows one claim, and permits takeover only at expiry", (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence();
    assert.equal(repository.schedule(scheduled).replayed, false);
    assert.equal(repository.schedule(scheduled).replayed, true);
    assert.equal(repository.listDue({ nowMs: 99 }).length, 0);
    assert.equal(repository.listDue({ nowMs: 100 }).length, 1);
    const first = repository.claim({
      ...scheduled,
      leaseOwner: "worker-1",
      leaseToken: "token-1",
      nowMs: 100,
      leaseExpiresAtMs: 200,
    });
    assert.equal(first.acquired, true);
    assert.equal(first.occurrence.attempt_count, 1);
    assert.equal(repository.claim({
      ...scheduled,
      leaseOwner: "worker-2",
      leaseToken: "token-2",
      nowMs: 199,
      leaseExpiresAtMs: 299,
    }).acquired, false);
    const takeover = repository.claim({
      ...scheduled,
      leaseOwner: "worker-2",
      leaseToken: "token-2",
      nowMs: 200,
      leaseExpiresAtMs: 300,
    });
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.occurrence.attempt_count, 2);
    assert.throws(() => repository.succeed({
      leagueId: IDS.league,
      runId: scheduled.runId,
      leaseOwner: "worker-1",
      leaseToken: "token-1",
      expectedVersion: first.occurrence.version,
      completedAtMs: 201,
      result: { duplicate: true },
    }), { code: "REPOSITORY_VERSION_CONFLICT" });
    const succeeded = repository.succeed({
      leagueId: IDS.league,
      runId: scheduled.runId,
      leaseOwner: "worker-2",
      leaseToken: "token-2",
      expectedVersion: takeover.occurrence.version,
      completedAtMs: 201,
      result: { ok: true },
    });
    assert.equal(succeeded.status, "succeeded");
    assert.equal(repository.claim({
      ...scheduled,
      leaseOwner: "worker-3",
      leaseToken: "token-3",
      nowMs: 400,
      leaseExpiresAtMs: 500,
    }).acquired, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM job_runs").get().count, 1);
  });

  test("runs failed work only at explicit retry time and never reruns success", async (t) => {
    const { database, repository } = createRuntime(t);
    const scheduled = occurrence("matchup:finalize", 100);
    repository.schedule(scheduled);
    let nowMs = 100;
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
    nowMs = 109;
    assert.equal((await job.run()).due, 0);
    nowMs = 110;
    const success = await job.run();
    assert.equal(success.status, "succeeded");
    assert.equal(success.succeeded, 1);
    assert.equal(effects, 1);
    nowMs = 500;
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
    assert.throws(() => repository.claim({
      ...scheduled,
      leaseOwner: "worker",
      leaseToken: "token",
      nowMs: 100,
      leaseExpiresAtMs: 200,
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
      nowMs: 100,
      leaseExpiresAtMs: 200,
    }).acquired, false);
    assert.equal(database.prepare("SELECT status FROM job_runs").get().status, "pending");
  });
});
