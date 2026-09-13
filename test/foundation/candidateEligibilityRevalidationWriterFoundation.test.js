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
  buildFreeAgentDraftEligibilityOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createSqliteCandidateEligibilityRevalidationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateEligibilityRevalidationWriter"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  player: uuid(4),
  sourceOperation: uuid(5),
  occurrence: uuid(6),
  job: uuid(7),
  leaseToken: uuid(8),
  staleLeaseToken: uuid(9),
});
const SCHEDULED_FOR_MS = Date.parse(
  "2026-08-09T16:00:00.000Z"
);
const CLAIMED_AT_MS = SCHEDULED_FOR_MS + 100;
const EXECUTED_AT_MS = CLAIMED_AT_MS + 100;
const LEASE_EXPIRES_AT_MS =
  CLAIMED_AT_MS + 60_000;
const LEASE_OWNER = "fad-eligibility-worker";
const OCCURRENCE_KEY =
  buildFreeAgentDraftEligibilityOccurrenceKey({
    fadId: IDS.fad,
    playerId: IDS.player,
    sourceOperationId: IDS.sourceOperation,
  });

function createSchema(database) {
  database.exec(`
    CREATE TABLE operational_events (
      id TEXT PRIMARY KEY,
      league_id TEXT,
      season_id TEXT,
      event_type TEXT NOT NULL,
      feature TEXT NOT NULL,
      outcome TEXT NOT NULL,
      actor_user_id TEXT,
      reason_code TEXT,
      details_json TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE job_runs (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at_ms INTEGER,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      result_json TEXT,
      last_error_code TEXT,
      next_attempt_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE free_agent_draft_eligibility_revalidation_occurrences (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      source_operation_id TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      job_run_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE candidate_test_mutations (
      id INTEGER PRIMARY KEY,
      mutation_count INTEGER NOT NULL
    ) STRICT;
  `);
}

function seed(database) {
  database
    .prepare(`
      INSERT INTO operational_events (
        id, league_id, season_id, event_type,
        feature, outcome, actor_user_id,
        reason_code, details_json, occurred_at_ms
      ) VALUES (
        ?, NULL, NULL, 'player_catalog_applied',
        'player_data_provider', 'succeeded', NULL,
        'provider_catalog_import', ?, ?
      )
    `)
    .run(
      IDS.sourceOperation,
      JSON.stringify({
        schemaVersion: 1,
        code: "PLAYER_CATALOG_APPLIED",
        sourceOperationId: IDS.sourceOperation,
        provider: "sportsdataio-live",
        capturedAtMs: SCHEDULED_FOR_MS - 1,
        appliedAtMs: SCHEDULED_FOR_MS,
        requestSha256: "a".repeat(64),
        rowCount: 1,
        createdPlayerCount: 0,
        updatedPlayerCount: 1,
        sourceStateChangeCount: 1,
        eligibilityChangedPlayerCount: 1,
        eligibilityRevalidationOccurrenceCount: 1,
      }),
      SCHEDULED_FOR_MS
    );
  database
    .prepare(`
      INSERT INTO free_agent_draft_eligibility_revalidation_occurrences (
        id, league_id, season_id, fad_id,
        player_id, source_operation_id,
        source_provider, job_run_id,
        occurrence_key, scheduled_for_ms,
        created_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, ?, 'sportsdataio-live', ?, ?, ?, ?, 1)
    `)
    .run(
      IDS.occurrence,
      IDS.league,
      IDS.season,
      IDS.fad,
      IDS.player,
      IDS.sourceOperation,
      IDS.job,
      OCCURRENCE_KEY,
      SCHEDULED_FOR_MS,
      SCHEDULED_FOR_MS
    );
  database
    .prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type,
        occurrence_key, scheduled_for_ms,
        status, attempt_count, lease_owner,
        lease_token, lease_expires_at_ms,
        started_at_ms, completed_at_ms,
        result_json, last_error_code,
        next_attempt_at_ms, created_at_ms,
        updated_at_ms, version
      ) VALUES (
        ?, ?, ?, 'fad_eligibility_revalidation',
        ?, ?, 'running', 1, ?, ?, ?, ?,
        NULL, NULL, NULL, NULL, ?, ?, 2
      )
    `)
    .run(
      IDS.job,
      IDS.league,
      IDS.season,
      OCCURRENCE_KEY,
      SCHEDULED_FOR_MS,
      LEASE_OWNER,
      IDS.leaseToken,
      LEASE_EXPIRES_AT_MS,
      CLAIMED_AT_MS,
      SCHEDULED_FOR_MS,
      CLAIMED_AT_MS
    );
  database
    .prepare(`
      INSERT INTO candidate_test_mutations (
        id, mutation_count
      ) VALUES (1, 0)
    `)
    .run();
}

function command(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    occurrenceId: IDS.occurrence,
    playerId: IDS.player,
    sourceOperationId: IDS.sourceOperation,
    sourceProvider: "sportsdataio-live",
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: SCHEDULED_FOR_MS,
    executedAtMs: EXECUTED_AT_MS,
    jobExecution: {
      runId: IDS.job,
      leaseOwner: LEASE_OWNER,
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function fixture(
  t,
  {
    changed = true,
    failSynchronization = false,
    beforeCommit,
  } = {}
) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad-eligibility-writer-"
    )
  );
  const { database } = openDatabase({
    databasePath: path.join(root, "test.sqlite3"),
    environment: "test",
  });
  createSchema(database);
  seed(database);
  const calls = [];
  const candidateCardSummerSynchronizer = {
    synchronize(input) {
      calls.push({
        input,
        inTransaction: database.inTransaction,
      });
      database
        .prepare(`
          UPDATE candidate_test_mutations
          SET mutation_count = mutation_count + 1
          WHERE id = 1
        `)
        .run();
      if (failSynchronization) {
        throw new Error("forced-synchronizer-failure");
      }
      return Object.freeze({
        leagueId: IDS.league,
        sourceOperationId: IDS.occurrence,
        sourceKind: "player_catalog_import",
        affectedCardCount: changed ? 1 : 0,
        changedCardCount: changed ? 1 : 0,
        cards: Object.freeze(changed ? [{}] : []),
      });
    },
  };
  const writer =
    createSqliteCandidateEligibilityRevalidationWriter({
      database,
      candidateCardSummerSynchronizer,
      beforeCommit,
    });
  t.after(() => {
    database.close();
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return { database, writer, calls };
}

function jobRow(database) {
  return database
    .prepare("SELECT * FROM job_runs WHERE id = ?")
    .get(IDS.job);
}

function mutationCount(database) {
  return database
    .prepare(`
      SELECT mutation_count
      FROM candidate_test_mutations
      WHERE id = 1
    `)
    .get().mutation_count;
}

describe(
  "FAD Candidate eligibility revalidation writer",
  () => {
    test("synchronizes one player inside the claimed transaction and stores canonical minimal success", (t) => {
      const { database, writer, calls } = fixture(t);
      assert.deepEqual(writer.executeClaimed(command()), {
        outcome: "succeeded",
        runId: IDS.job,
        occurrenceId: IDS.occurrence,
        playerId: IDS.player,
        affectedCardCount: 1,
        changedCardCount: 1,
        completedAtMs: EXECUTED_AT_MS,
        jobVersion: 3,
      });
      assert.deepEqual(calls, [
        {
          inTransaction: true,
          input: {
            leagueId: IDS.league,
            affectedTeamIds: [],
            affectedPlayerIds: [IDS.player],
            sourceOperationId: IDS.occurrence,
            sourceKind: "player_catalog_import",
            nowMs: EXECUTED_AT_MS,
          },
        },
      ]);
      const row = jobRow(database);
      assert.equal(row.status, "succeeded");
      assert.equal(row.version, 3);
      assert.equal(row.lease_owner, null);
      assert.equal(row.lease_token, null);
      assert.equal(row.lease_expires_at_ms, null);
      assert.equal(
        row.result_json,
        serializeCanonicalJsonV1({
          schemaVersion: 1,
          code: "FAD_ELIGIBILITY_REVALIDATED",
          occurrenceId: IDS.occurrence,
          playerId: IDS.player,
          affectedCardCount: 1,
          changedCardCount: 1,
        })
      );
      assert.equal(mutationCount(database), 1);
    });

    test("marks a no-op Candidate reconciliation succeeded", (t) => {
      const { database, writer } = fixture(t, {
        changed: false,
      });
      const result = writer.executeClaimed(command());
      assert.equal(result.affectedCardCount, 0);
      assert.equal(result.changedCardCount, 0);
      assert.equal(jobRow(database).status, "succeeded");
    });

    test("rejects exact replay, stale lease, and late execution without another Candidate write", (t) => {
      const { database, writer, calls } = fixture(t);
      writer.executeClaimed(command());
      const terminalBefore = { ...jobRow(database) };
      assert.throws(
        () => writer.executeClaimed(command()),
        (error) =>
          error?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      assert.deepEqual(jobRow(database), terminalBefore);
      assert.equal(calls.length, 1);
      assert.equal(mutationCount(database), 1);

      const stale = fixture(t);
      assert.throws(
        () =>
          stale.writer.executeClaimed(
            command({
              jobExecution: {
                ...command().jobExecution,
                leaseToken: IDS.staleLeaseToken,
              },
            })
          ),
        (error) =>
          error?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      assert.equal(stale.calls.length, 0);
      assert.equal(mutationCount(stale.database), 0);

      const late = fixture(t);
      assert.throws(
        () =>
          late.writer.executeClaimed(
            command({
              executedAtMs: LEASE_EXPIRES_AT_MS,
            })
          ),
        (error) =>
          error?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      assert.equal(late.calls.length, 0);
      assert.equal(mutationCount(late.database), 0);
    });

    test("rolls Candidate writes and terminal state back when synchronization fails", (t) => {
      const { database, writer } = fixture(t, {
        failSynchronization: true,
      });
      const before = { ...jobRow(database) };
      assert.throws(
        () => writer.executeClaimed(command()),
        (error) =>
          error?.code ===
            "REPOSITORY_OPERATION_FAILED" &&
          error?.cause?.message ===
            "forced-synchronizer-failure"
      );
      assert.deepEqual(jobRow(database), before);
      assert.equal(mutationCount(database), 0);
    });

    test("rejects a missing or mismatched sealed occurrence before synchronization", (t) => {
      const missing = fixture(t);
      missing.database
        .prepare(`
          DELETE FROM free_agent_draft_eligibility_revalidation_occurrences
          WHERE id = ?
        `)
        .run(IDS.occurrence);
      assert.throws(
        () => missing.writer.executeClaimed(command()),
        (error) =>
          error?.code ===
          "REPOSITORY_SCHEMA_INCOMPATIBLE"
      );
      assert.equal(missing.calls.length, 0);

      const mismatched = fixture(t);
      mismatched.database
        .prepare(`
          UPDATE operational_events
          SET details_json = json_set(
            details_json,
            '$.provider',
            'tampered-provider'
          )
          WHERE id = ?
        `)
        .run(IDS.sourceOperation);
      assert.throws(
        () => mismatched.writer.executeClaimed(command()),
        (error) =>
          error?.code ===
          "REPOSITORY_SCHEMA_INCOMPATIBLE"
      );
      assert.equal(mismatched.calls.length, 0);
    });
  }
);
