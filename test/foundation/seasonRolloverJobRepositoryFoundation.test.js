const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
  buildSeasonRolloverOccurrenceKey,
} = require(
  "../../src/domain/leagues/seasonRolloverJobPolicy"
);
const {
  createSqliteSeasonRolloverJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSeasonRolloverJobRepository"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  sourceSeason: uuid(2),
  targetSeason: uuid(3),
  draft: uuid(4),
  binding: uuid(5),
  jobRun: uuid(6),
  leaseToken: uuid(7),
  rollover: uuid(8),
  occurrence: uuid(9),
  supersededOccurrence: uuid(10),
  supersededJobRun: uuid(11),
});
const SCHEDULED_FOR_MS =
  Date.parse("2027-07-15T16:00:00.000Z");
const OCCURRENCE_KEY =
  buildSeasonRolloverOccurrenceKey({
    leagueId: IDS.league,
    entryDraftId: IDS.draft,
    rolloverOccurrenceId: IDS.occurrence,
    scheduledForMs: SCHEDULED_FOR_MS,
  });

function runtime(t, beforeCommit) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-rollover-job-repository-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(root, "test.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  connection.database.exec(`
    CREATE TABLE entry_draft_rollover_bindings (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      entry_draft_id TEXT NOT NULL,
      from_season_id TEXT NOT NULL,
      to_season_id TEXT NOT NULL,
      current_rollover_occurrence_id TEXT NOT NULL,
      current_scheduled_job_run_id TEXT NOT NULL,
      scheduled_starts_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN (
          'scheduled',
          'blocked',
          'succeeded'
        )),
      UNIQUE (
        league_id,
        current_rollover_occurrence_id
      ),
      UNIQUE (
        league_id,
        current_scheduled_job_run_id
      )
    ) STRICT;

    CREATE TABLE season_rollover_occurrences (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      entry_draft_id TEXT NOT NULL,
      from_season_id TEXT NOT NULL,
      to_season_id TEXT NOT NULL,
      scheduled_job_run_id TEXT NOT NULL,
      scheduled_starts_at_ms INTEGER NOT NULL,
      occurrence_key TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN (
          'scheduled',
          'superseded',
          'blocked',
          'succeeded'
        )),
      UNIQUE (league_id, occurrence_key),
      UNIQUE (league_id, scheduled_job_run_id)
    ) STRICT;

    CREATE TABLE job_runs (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending',
        'leased',
        'running',
        'succeeded',
        'failed',
        'skipped'
      )),
      attempt_count INTEGER NOT NULL,
      lease_owner TEXT,
      lease_expires_at_ms INTEGER,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      result_json TEXT,
      last_error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      lease_token TEXT,
      next_attempt_at_ms INTEGER,
      UNIQUE (league_id, job_type, occurrence_key)
    ) STRICT;
  `);
  seed(connection.database);
  return {
    database: connection.database,
    repository:
      createSqliteSeasonRolloverJobRepository({
        database: connection.database,
        beforeCommit,
      }),
  };
}

function seed(database) {
  database
    .prepare(`
      INSERT INTO entry_draft_rollover_bindings (
        id,
        league_id,
        entry_draft_id,
        from_season_id,
        to_season_id,
        current_rollover_occurrence_id,
        current_scheduled_job_run_id,
        scheduled_starts_at_ms,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
    `)
    .run(
      IDS.binding,
      IDS.league,
      IDS.draft,
      IDS.sourceSeason,
      IDS.targetSeason,
      IDS.occurrence,
      IDS.jobRun,
      SCHEDULED_FOR_MS,
    );
  database
    .prepare(`
      INSERT INTO season_rollover_occurrences (
        id,
        league_id,
        binding_id,
        entry_draft_id,
        from_season_id,
        to_season_id,
        scheduled_job_run_id,
        scheduled_starts_at_ms,
        occurrence_key,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
    `)
    .run(
      IDS.occurrence,
      IDS.league,
      IDS.binding,
      IDS.draft,
      IDS.sourceSeason,
      IDS.targetSeason,
      IDS.jobRun,
      SCHEDULED_FOR_MS,
      OCCURRENCE_KEY
    );
  database
    .prepare(`
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
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'pending', 0,
        NULL, NULL, NULL, NULL, NULL, NULL,
        ?, ?, 1, NULL, ?
      )
    `)
    .run(
      IDS.jobRun,
      IDS.league,
      IDS.targetSeason,
      ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
      OCCURRENCE_KEY,
      SCHEDULED_FOR_MS,
      SCHEDULED_FOR_MS - 1_000,
      SCHEDULED_FOR_MS - 1_000,
      SCHEDULED_FOR_MS
    );
}

function claimInput(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.targetSeason,
    jobType: ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: SCHEDULED_FOR_MS,
    leaseOwner: "worker-1",
    leaseToken: IDS.leaseToken,
    nowMs: SCHEDULED_FOR_MS,
    leaseExpiresAtMs:
      SCHEDULED_FOR_MS + 60_000,
    ...overrides,
  };
}

function bindingResult() {
  return {
    leagueId: IDS.league,
    toSeasonId: IDS.targetSeason,
    entryDraftId: IDS.draft,
    rolloverOccurrenceId:
      IDS.occurrence,
    scheduledForMs: SCHEDULED_FOR_MS,
    occurrenceKey: OCCURRENCE_KEY,
  };
}

describe(
  "T-037 SQLite season-rollover job repository",
  () => {
    test("lists, claims, and succeeds the one persisted due occurrence", (t) => {
      const { database, repository } =
        runtime(t);
      assert.deepEqual(
        repository.listDueRolloverBindings({
          nowMs: SCHEDULED_FOR_MS,
        }),
        [
          {
            leagueId: IDS.league,
            toSeasonId: IDS.targetSeason,
            entryDraftId: IDS.draft,
            rolloverOccurrenceId:
              IDS.occurrence,
            scheduledForMs:
              SCHEDULED_FOR_MS,
            occurrenceKey: OCCURRENCE_KEY,
          },
        ]
      );
      const claim =
        repository.claimRun(claimInput());
      assert.deepEqual(claim, {
        acquired: true,
        runId: IDS.jobRun,
        version: 2,
      });
      assert.deepEqual(
        repository.listDueRolloverBindings({
          nowMs: SCHEDULED_FOR_MS + 1,
        }),
        []
      );
      const row = repository.succeedRun({
        leagueId: IDS.league,
        runId: IDS.jobRun,
        leaseOwner: "worker-1",
        leaseToken: IDS.leaseToken,
        expectedVersion: 2,
        completedAtMs:
          SCHEDULED_FOR_MS + 2,
        outcome: "succeeded",
        rolloverId: IDS.rollover,
      });
      assert.equal(row.status, "succeeded");
      assert.deepEqual(
        JSON.parse(row.result_json),
        {
          outcome: "succeeded",
          rolloverId: IDS.rollover,
        }
      );
      assert.deepEqual(
        database.pragma("integrity_check"),
        [{ integrity_check: "ok" }]
      );
    });

    test("does not steal a live lease and reclaims it only after expiry", (t) => {
      const { repository } = runtime(t);
      assert.equal(
        repository.claimRun(claimInput())
          .acquired,
        true
      );
      assert.equal(
        repository.claimRun(
          claimInput({
            leaseOwner: "worker-2",
            leaseToken: uuid(20),
            nowMs:
              SCHEDULED_FOR_MS + 59_999,
            leaseExpiresAtMs:
              SCHEDULED_FOR_MS + 120_000,
          })
        ).acquired,
        false
      );
      const reclaimed =
        repository.claimRun(
          claimInput({
            leaseOwner: "worker-2",
            leaseToken: uuid(20),
            nowMs:
              SCHEDULED_FOR_MS + 60_000,
            leaseExpiresAtMs:
              SCHEDULED_FOR_MS + 120_000,
          })
        );
      assert.deepEqual(reclaimed, {
        acquired: true,
        runId: IDS.jobRun,
        version: 3,
      });
    });

    test("persists retry timing and does not list the failure early", (t) => {
      const { repository } = runtime(t);
      repository.claimRun(claimInput());
      const failed = repository.failRun({
        leagueId: IDS.league,
        runId: IDS.jobRun,
        leaseOwner: "worker-1",
        leaseToken: IDS.leaseToken,
        expectedVersion: 2,
        completedAtMs:
          SCHEDULED_FOR_MS + 1,
        nextAttemptAtMs:
          SCHEDULED_FOR_MS + 10_000,
        errorCode: "REPOSITORY_BUSY",
      });
      assert.equal(failed.status, "failed");
      assert.deepEqual(
        repository.listDueRolloverBindings({
          nowMs:
            SCHEDULED_FOR_MS + 9_999,
        }),
        []
      );
      assert.equal(
        repository.listDueRolloverBindings({
          nowMs:
            SCHEDULED_FOR_MS + 10_000,
        }).length,
        1
      );
    });

    test("replays a committed binding after a worker crashes before completing the job row", (t) => {
      const { database, repository } =
        runtime(t);
      repository.claimRun(claimInput());
      database
        .prepare(`
          UPDATE season_rollover_occurrences
          SET status = 'succeeded'
          WHERE id = ?
        `)
        .run(IDS.occurrence);
      database
        .prepare(`
          UPDATE entry_draft_rollover_bindings
          SET status = 'succeeded'
          WHERE id = ?
        `)
        .run(IDS.binding);
      assert.equal(
        repository.listDueRolloverBindings({
          nowMs:
            SCHEDULED_FOR_MS + 60_000,
        }).length,
        1
      );
      assert.equal(
        repository.claimRun(
          claimInput({
            leaseOwner: "worker-2",
            leaseToken: uuid(20),
            nowMs:
              SCHEDULED_FOR_MS + 60_000,
            leaseExpiresAtMs:
              SCHEDULED_FOR_MS + 120_000,
          })
        ).acquired,
        true
      );
    });

    test("never lists or claims a superseded occurrence after reschedule", (t) => {
      const { database, repository } =
        runtime(t);
      const supersededKey =
        buildSeasonRolloverOccurrenceKey({
          leagueId: IDS.league,
          entryDraftId: IDS.draft,
          rolloverOccurrenceId:
            IDS.supersededOccurrence,
          scheduledForMs:
            SCHEDULED_FOR_MS - 86_400_000,
        });
      database
        .prepare(`
          INSERT INTO job_runs (
            id,
            league_id,
            season_id,
            job_type,
            occurrence_key,
            scheduled_for_ms,
            status,
            attempt_count,
            created_at_ms,
            updated_at_ms,
            version,
            next_attempt_at_ms
          ) VALUES (
            ?, ?, ?, ?, ?, ?, 'pending', 0,
            ?, ?, 1, ?
          )
        `)
        .run(
          IDS.supersededJobRun,
          IDS.league,
          IDS.targetSeason,
          ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
          supersededKey,
          SCHEDULED_FOR_MS - 86_400_000,
          SCHEDULED_FOR_MS - 86_401_000,
          SCHEDULED_FOR_MS - 86_401_000,
          SCHEDULED_FOR_MS - 86_400_000
        );
      database
        .prepare(`
          INSERT INTO season_rollover_occurrences (
            id,
            league_id,
            binding_id,
            entry_draft_id,
            from_season_id,
            to_season_id,
            scheduled_job_run_id,
            scheduled_starts_at_ms,
            occurrence_key,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'superseded')
        `)
        .run(
          IDS.supersededOccurrence,
          IDS.league,
          IDS.binding,
          IDS.draft,
          IDS.sourceSeason,
          IDS.targetSeason,
          IDS.supersededJobRun,
          SCHEDULED_FOR_MS - 86_400_000,
          supersededKey
        );

      assert.deepEqual(
        repository.listDueRolloverBindings({
          nowMs: SCHEDULED_FOR_MS,
        }),
        [bindingResult()]
      );
      assert.deepEqual(
        repository.claimRun(
          claimInput({
            occurrenceKey: supersededKey,
            scheduledForMs:
              SCHEDULED_FOR_MS - 86_400_000,
          })
        ),
        {
          acquired: false,
          runId: null,
          version: null,
        }
      );
      assert.equal(
        database
          .prepare(
            "SELECT status FROM job_runs WHERE id = ?"
          )
          .get(IDS.supersededJobRun).status,
        "pending"
      );
    });

    test("rolls back a lease mutation injected before commit", (t) => {
      const { database, repository } =
        runtime(t, (operation) => {
          if (operation === "claim") {
            throw new Error("injected");
          }
        });
      assert.throws(
        () => repository.claimRun(claimInput()),
        (error) =>
          error?.code ===
            "REPOSITORY_OPERATION_FAILED" &&
          error?.cause?.message === "injected"
      );
      const row = database
        .prepare(
          "SELECT * FROM job_runs WHERE id = ?"
        )
        .get(IDS.jobRun);
      assert.equal(row.status, "pending");
      assert.equal(row.attempt_count, 0);
      assert.equal(row.version, 1);
    });

    test("rejects a stale lease completion without mutation", (t) => {
      const { database, repository } =
        runtime(t);
      repository.claimRun(claimInput());
      assert.throws(
        () =>
          repository.succeedRun({
            leagueId: IDS.league,
            runId: IDS.jobRun,
            leaseOwner: "worker-1",
            leaseToken: IDS.leaseToken,
            expectedVersion: 1,
            completedAtMs:
              SCHEDULED_FOR_MS + 1,
            outcome: "succeeded",
            rolloverId: IDS.rollover,
          }),
        (error) =>
          error?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      assert.equal(
        database
          .prepare(
            "SELECT status FROM job_runs WHERE id = ?"
          )
          .get(IDS.jobRun).status,
        "running"
      );
    });
  }
);
