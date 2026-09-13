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
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  FAD_ELIGIBILITY_DEADLINE_RESULT_JSON,
  createSqliteFreeAgentDraftEligibilityDeadlineReconciler,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftEligibilityDeadlineReconciler"
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
  deadlineOperation: uuid(4),
  teamOne: uuid(5),
  teamTwo: uuid(6),
  cardOne: uuid(7),
  cardTwo: uuid(8),
});
const OPENED_AT_MS = 1_000;
const APPLIED_AT_MS = 2_000;
const CLAIMED_AT_MS = 3_000;
const COMPLETED_AT_MS = 4_000;
const NEXT_ATTEMPT_AT_MS = 5_000;
const NOW_MS = 10_000;
const LEASE_EXPIRES_AT_MS = 20_000;
const PROVIDER = "sportsdataio-live";
const JOB_TYPE = "fad_eligibility_revalidation";
const STATUS_FIXTURES = Object.freeze([
  "pending",
  "failed",
  "leased",
  "running",
  "succeeded",
  "skipped",
]);

function createSchema35(database) {
  database.exec(`
    CREATE TABLE application_metadata (
      metadata_key TEXT PRIMARY KEY,
      metadata_value TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;

    INSERT INTO application_metadata (
      metadata_key, metadata_value, updated_at_ms
    ) VALUES ('data_model_version', '35', 35);

    CREATE TABLE leagues (
      id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TABLE free_agent_drafts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      UNIQUE (league_id, season_id, id)
    ) STRICT;

    CREATE TABLE candidate_cards (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE candidate_card_entries (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      player_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE players (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE player_source_state (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_position TEXT,
      normalized_position TEXT,
      nhl_team_abbreviation TEXT,
      active INTEGER NOT NULL,
      source_version TEXT,
      source_payload_json TEXT,
      effective_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE league_player_positions (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      position_group TEXT NOT NULL,
      ended_at_ms INTEGER,
      UNIQUE (league_id, id)
    ) STRICT;

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
      version INTEGER NOT NULL,
      UNIQUE (league_id, id),
      UNIQUE (league_id, job_type, occurrence_key)
    ) STRICT;

    CREATE TABLE candidate_test_mutations (
      id INTEGER PRIMARY KEY,
      mutation_count INTEGER NOT NULL
    ) STRICT;

    INSERT INTO candidate_test_mutations (
      id, mutation_count
    ) VALUES (1, 0);
  `);
  database.exec(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "..",
        "..",
        "database",
        "migrations",
        "0036_add_fad_eligibility_revalidation_occurrences.sql"
      ),
      "utf8"
    )
  );
}

function seedOpenFad(database) {
  database
    .prepare("INSERT INTO leagues (id) VALUES (?)")
    .run(IDS.league);
  database
    .prepare(`
      INSERT INTO free_agent_drafts (
        id, league_id, season_id, status, opened_at_ms
      ) VALUES (?, ?, ?, 'cards_open', ?)
    `)
    .run(
      IDS.fad,
      IDS.league,
      IDS.season,
      OPENED_AT_MS
    );
  const insertCard = database.prepare(`
    INSERT INTO candidate_cards (
      id, league_id, season_id, fad_id, team_id, status
    ) VALUES (?, ?, ?, ?, ?, 'open')
  `);
  insertCard.run(
    IDS.cardTwo,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.teamTwo
  );
  insertCard.run(
    IDS.cardOne,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.teamOne
  );
}

function catalogDetails(sourceOperationId, appliedAtMs) {
  return JSON.stringify({
    schemaVersion: 1,
    code: "PLAYER_CATALOG_APPLIED",
    sourceOperationId,
    provider: PROVIDER,
    capturedAtMs: appliedAtMs - 1,
    appliedAtMs,
    requestSha256: "a".repeat(64),
    rowCount: 1,
    createdPlayerCount: 0,
    updatedPlayerCount: 0,
    sourceStateChangeCount: 1,
    eligibilityChangedPlayerCount: 1,
    eligibilityRevalidationOccurrenceCount: 1,
  });
}

function seedOccurrence(database, index, status) {
  const playerId = uuid(100 + index);
  const entryId = uuid(200 + index);
  const sourceBeforeId = uuid(300 + index);
  const sourceAfterId = uuid(400 + index);
  const sourceOperationId = uuid(500 + index);
  const occurrenceId = uuid(600 + index);
  const jobId = uuid(700 + index);
  const leaseToken = uuid(800 + index);
  const appliedAtMs = APPLIED_AT_MS + index;
  const occurrenceKey =
    `fad:${IDS.fad}:eligibility-revalidate:` +
    `${playerId}:${sourceOperationId}`;

  database
    .prepare(`
      INSERT INTO players (id, status, version)
      VALUES (?, 'active', 1)
    `)
    .run(playerId);
  database
    .prepare(`
      INSERT INTO player_source_state (
        id, player_id, provider, source_position,
        normalized_position, nhl_team_abbreviation,
        active, source_version, source_payload_json,
        effective_at_ms, ended_at_ms, created_at_ms
      ) VALUES (?, ?, ?, 'C', 'F', 'VAN', 1, 'before',
                NULL, ?, NULL, ?)
    `)
    .run(
      sourceBeforeId,
      playerId,
      PROVIDER,
      OPENED_AT_MS,
      OPENED_AT_MS
    );
  database
    .prepare(`
      INSERT INTO candidate_card_entries (
        id, league_id, season_id, fad_id,
        card_id, team_id, player_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      entryId,
      IDS.league,
      IDS.season,
      IDS.fad,
      IDS.cardOne,
      IDS.teamOne,
      playerId
    );

  database.transaction(() => {
    database
      .prepare(`
        UPDATE player_source_state
        SET ended_at_ms = ?
        WHERE id = ?
      `)
      .run(appliedAtMs, sourceBeforeId);
    database
      .prepare(`
        INSERT INTO player_source_state (
          id, player_id, provider, source_position,
          normalized_position, nhl_team_abbreviation,
          active, source_version, source_payload_json,
          effective_at_ms, ended_at_ms, created_at_ms
        ) VALUES (?, ?, ?, 'D', 'D', 'VAN', 1, 'after',
                  NULL, ?, NULL, ?)
      `)
      .run(
        sourceAfterId,
        playerId,
        PROVIDER,
        appliedAtMs,
        appliedAtMs
      );
    database
      .prepare(`
        INSERT INTO free_agent_draft_eligibility_revalidation_occurrences (
          id, league_id, season_id, fad_id, player_id,
          source_operation_id, source_provider,
          player_version_before, player_version_after,
          player_status_before, player_status_after,
          source_state_before_id, source_state_after_id,
          source_resolved_position_group_before,
          source_resolved_position_group_after,
          league_position_override_id,
          effective_position_group_before,
          effective_position_group_after,
          eligibility_delta_sha256, job_run_id,
          occurrence_key, scheduled_for_ms,
          created_at_ms, version
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, 1, 1, 'active', 'active',
          ?, ?, 'F', 'D', NULL, 'F', 'D', ?, ?, ?, ?, ?, 1
        )
      `)
      .run(
        occurrenceId,
        IDS.league,
        IDS.season,
        IDS.fad,
        playerId,
        sourceOperationId,
        PROVIDER,
        sourceBeforeId,
        sourceAfterId,
        "b".repeat(64),
        jobId,
        occurrenceKey,
        appliedAtMs,
        appliedAtMs
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
          ?, ?, ?, ?, ?, ?, 'pending', 0, NULL,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 1
        )
      `)
      .run(
        jobId,
        IDS.league,
        IDS.season,
        JOB_TYPE,
        occurrenceKey,
        appliedAtMs,
        appliedAtMs,
        appliedAtMs
      );
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
        sourceOperationId,
        catalogDetails(sourceOperationId, appliedAtMs),
        appliedAtMs
      );
  }).immediate();

  if (status !== "pending") {
    const claimedAtMs = CLAIMED_AT_MS + index;
    const completedAtMs = COMPLETED_AT_MS + index;
    const values = {
      failed: {
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        startedAtMs: claimedAtMs,
        completedAtMs,
        resultJson: null,
        lastErrorCode: "PROVIDER_REVALIDATION_FAILED",
        nextAttemptAtMs: NEXT_ATTEMPT_AT_MS + index,
      },
      leased: {
        leaseOwner: "eligibility-worker",
        leaseToken,
        leaseExpiresAtMs: LEASE_EXPIRES_AT_MS + index,
        startedAtMs: null,
        completedAtMs: null,
        resultJson: null,
        lastErrorCode: null,
        nextAttemptAtMs: null,
      },
      running: {
        leaseOwner: "eligibility-worker",
        leaseToken,
        leaseExpiresAtMs: LEASE_EXPIRES_AT_MS + index,
        startedAtMs: claimedAtMs,
        completedAtMs: null,
        resultJson: null,
        lastErrorCode: null,
        nextAttemptAtMs: null,
      },
      succeeded: {
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        startedAtMs: claimedAtMs,
        completedAtMs,
        resultJson: serializeCanonicalJsonV1({
          outcome: "worker_succeeded",
        }),
        lastErrorCode: null,
        nextAttemptAtMs: null,
      },
      skipped: {
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        startedAtMs: claimedAtMs,
        completedAtMs,
        resultJson: serializeCanonicalJsonV1({
          outcome: "already_skipped",
        }),
        lastErrorCode: null,
        nextAttemptAtMs: null,
      },
    }[status];
    database
      .prepare(`
        UPDATE job_runs
        SET status = @status,
            attempt_count = 1,
            lease_owner = @leaseOwner,
            lease_token = @leaseToken,
            lease_expires_at_ms = @leaseExpiresAtMs,
            started_at_ms = @startedAtMs,
            completed_at_ms = @completedAtMs,
            result_json = @resultJson,
            last_error_code = @lastErrorCode,
            next_attempt_at_ms = @nextAttemptAtMs,
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @jobId
      `)
      .run({
        status,
        ...values,
        updatedAtMs:
          values.completedAtMs ?? claimedAtMs,
        jobId,
      });
  }

  return Object.freeze({
    status,
    jobId,
    leaseToken,
  });
}

function fixture(
  t,
  {
    statuses = STATUS_FIXTURES,
    failSynchronization = false,
    beforeJobCas,
  } = {}
) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad-deadline-reconcile-"
    )
  );
  const { database } = openDatabase({
    databasePath: path.join(root, "test.sqlite3"),
    environment: "test",
  });
  createSchema35(database);
  seedOpenFad(database);
  const jobs = statuses.map((status, index) =>
    seedOccurrence(database, index, status)
  );
  const calls = [];
  const candidateCardSummerSynchronizer = {
    synchronizeInCurrentTransaction(input) {
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
        throw new Error("forced-deadline-sync-failure");
      }
      return Object.freeze({
        leagueId: IDS.league,
        sourceOperationId: IDS.deadlineOperation,
        sourceKind: "deadline_reconciliation",
        affectedCardCount: 2,
        changedCardCount: 2,
        cards: Object.freeze([{}, {}]),
      });
    },
  };
  const reconciler =
    createSqliteFreeAgentDraftEligibilityDeadlineReconciler({
      database,
      candidateCardSummerSynchronizer,
      beforeJobCas,
    });
  t.after(() => {
    database.close();
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return { database, reconciler, calls, jobs };
}

function command(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    deadlineOperationId: IDS.deadlineOperation,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function reconcile(state, overrides = {}) {
  return state.database.transaction(() =>
    state.reconciler.reconcileInCurrentTransaction(
      command(overrides)
    )
  ).immediate();
}

function jobRows(database) {
  return database
    .prepare("SELECT * FROM job_runs ORDER BY id")
    .all();
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

function lockFad(database) {
  return database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'deadline_locked'
      WHERE league_id = ?
        AND season_id = ?
        AND id = ?
    `)
    .run(IDS.league, IDS.season, IDS.fad);
}

describe(
  "FAD eligibility deadline reconciler",
  () => {
    test("requires the caller transaction and validates the exact canonical command", (t) => {
      const state = fixture(t, { statuses: [] });
      assert.throws(
        () =>
          state.reconciler
            .reconcileInCurrentTransaction(command()),
        (error) =>
          error?.code ===
            "REPOSITORY_ARGUMENT_INVALID" &&
          error.details?.reasonCode ===
            "TRANSACTION_REQUIRED"
      );
      assert.throws(
        () => reconcile(state, { leagueId: "not-a-uuid" }),
        (error) =>
          error?.code ===
          "REPOSITORY_ARGUMENT_INVALID"
      );
      assert.throws(
        () => reconcile(state, { nowMs: -1 }),
        (error) =>
          error?.code ===
          "REPOSITORY_ARGUMENT_INVALID"
      );
      assert.equal(state.calls.length, 0);
      assert.equal(mutationCount(state.database), 0);
    });

    test("authoritatively synchronizes every open card once and consumes all four nonterminal job states", (t) => {
      const state = fixture(t);
      const before = jobRows(state.database);
      const succeededBefore = before.find(
        (row) =>
          row.id === state.jobs[4].jobId
      );
      const skippedBefore = before.find(
        (row) =>
          row.id === state.jobs[5].jobId
      );
      assert.throws(
        () => lockFad(state.database),
        /must consume every eligibility revalidation occurrence/
      );

      const result = reconcile(state);
      assert.deepEqual(result, {
        outcome: "deadline_reconciled",
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        deadlineOperationId: IDS.deadlineOperation,
        affectedTeamIds: [IDS.teamOne, IDS.teamTwo],
        affectedCardCount: 2,
        changedCardCount: 2,
        occurrenceCount: 6,
        reconciledJobCount: 4,
        alreadySucceededJobCount: 1,
        alreadySkippedJobCount: 1,
        reconciledAtMs: NOW_MS,
      });
      assert.equal(Object.isFrozen(result), true);
      assert.equal(
        Object.isFrozen(result.affectedTeamIds),
        true
      );
      assert.deepEqual(state.calls, [
        {
          inTransaction: true,
          input: {
            leagueId: IDS.league,
            affectedTeamIds: [
              IDS.teamOne,
              IDS.teamTwo,
            ],
            affectedPlayerIds: [],
            sourceOperationId:
              IDS.deadlineOperation,
            sourceKind: "deadline_reconciliation",
            nowMs: NOW_MS,
          },
        },
      ]);
      assert.equal(mutationCount(state.database), 1);

      const after = jobRows(state.database);
      assert.deepEqual(
        after.find((row) => row.id === state.jobs[4].jobId),
        succeededBefore
      );
      assert.deepEqual(
        after.find((row) => row.id === state.jobs[5].jobId),
        skippedBefore
      );
      for (let index = 0; index < 4; index += 1) {
        const prior = before.find(
          (row) => row.id === state.jobs[index].jobId
        );
        const row = after.find(
          (candidate) =>
            candidate.id === state.jobs[index].jobId
        );
        assert.equal(row.status, "skipped");
        assert.equal(
          row.attempt_count,
          prior.attempt_count
        );
        assert.equal(row.lease_owner, null);
        assert.equal(row.lease_token, null);
        assert.equal(row.lease_expires_at_ms, null);
        assert.equal(
          row.started_at_ms,
          prior.started_at_ms ?? NOW_MS
        );
        assert.equal(row.completed_at_ms, NOW_MS);
        assert.equal(
          row.result_json,
          FAD_ELIGIBILITY_DEADLINE_RESULT_JSON
        );
        assert.equal(
          row.result_json,
          '{"outcome":"deadline_reconciled"}'
        );
        assert.equal(row.last_error_code, null);
        assert.equal(row.next_attempt_at_ms, null);
        assert.equal(row.updated_at_ms, NOW_MS);
        assert.equal(row.version, prior.version + 1);
      }
      assert.equal(lockFad(state.database).changes, 1);
    });

    test("still performs the one final all-card synchronization when no occurrence jobs exist", (t) => {
      const state = fixture(t, { statuses: [] });
      const result = reconcile(state);
      assert.equal(result.occurrenceCount, 0);
      assert.equal(result.reconciledJobCount, 0);
      assert.equal(result.alreadySucceededJobCount, 0);
      assert.equal(result.alreadySkippedJobCount, 0);
      assert.equal(state.calls.length, 1);
      assert.equal(mutationCount(state.database), 1);
      assert.equal(lockFad(state.database).changes, 1);
    });

    test("rolls the Candidate synchronization and every job back byte-for-byte when synchronization fails", (t) => {
      const state = fixture(t, {
        failSynchronization: true,
      });
      const before = jobRows(state.database);
      assert.throws(
        () => reconcile(state),
        (error) =>
          error?.code ===
            "REPOSITORY_OPERATION_FAILED" &&
          error.cause?.message ===
            "forced-deadline-sync-failure"
      );
      assert.deepEqual(jobRows(state.database), before);
      assert.equal(mutationCount(state.database), 0);
      assert.equal(state.calls.length, 1);
    });

    test("rolls the synchronization and prior job updates back when an exact observed-row CAS loses", (t) => {
      let state;
      state = fixture(t, {
        statuses: ["pending", "pending"],
        beforeJobCas({ index, job }) {
          if (index !== 1) return;
          state.database
            .prepare(`
              UPDATE job_runs
              SET updated_at_ms = updated_at_ms + 1,
                  version = version + 1
              WHERE id = ?
            `)
            .run(job.job_id);
        },
      });
      const before = jobRows(state.database);
      assert.throws(
        () => reconcile(state),
        (error) =>
          error?.code ===
            "REPOSITORY_VERSION_CONFLICT" &&
          error.details?.reasonCode ===
            "JOB_TERMINAL_CAS_FAILED"
      );
      assert.deepEqual(jobRows(state.database), before);
      assert.equal(mutationCount(state.database), 0);
    });

    test("makes a prior running worker lease and version stale after deadline reconciliation", (t) => {
      const state = fixture(t, {
        statuses: ["running"],
      });
      const before = jobRows(state.database)[0];
      reconcile(state);
      const terminalBefore = jobRows(state.database)[0];
      const staleTerminal = state.database
        .prepare(`
          UPDATE job_runs
          SET status = 'succeeded',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at_ms = NULL,
              completed_at_ms = @completedAtMs,
              result_json = @resultJson,
              last_error_code = NULL,
              next_attempt_at_ms = NULL,
              updated_at_ms = @completedAtMs,
              version = version + 1
          WHERE id = @id
            AND league_id = @leagueId
            AND season_id = @seasonId
            AND job_type = @jobType
            AND occurrence_key = @occurrenceKey
            AND scheduled_for_ms = @scheduledForMs
            AND status = 'running'
            AND lease_owner = @leaseOwner
            AND lease_token = @leaseToken
            AND lease_expires_at_ms = @leaseExpiresAtMs
            AND started_at_ms = @startedAtMs
            AND completed_at_ms IS NULL
            AND result_json IS NULL
            AND last_error_code IS NULL
            AND next_attempt_at_ms IS NULL
            AND updated_at_ms = @updatedAtMs
            AND version = @version
        `)
        .run({
          completedAtMs: NOW_MS + 1,
          resultJson: serializeCanonicalJsonV1({
            outcome: "worker_succeeded",
          }),
          id: before.id,
          leagueId: before.league_id,
          seasonId: before.season_id,
          jobType: before.job_type,
          occurrenceKey: before.occurrence_key,
          scheduledForMs: before.scheduled_for_ms,
          leaseOwner: before.lease_owner,
          leaseToken: before.lease_token,
          leaseExpiresAtMs: before.lease_expires_at_ms,
          startedAtMs: before.started_at_ms,
          updatedAtMs: before.updated_at_ms,
          version: before.version,
        });
      assert.equal(staleTerminal.changes, 0);
      assert.deepEqual(
        jobRows(state.database)[0],
        terminalBefore
      );
    });
  }
);
