"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const MIGRATION_0047 = Object.freeze({
  byteLength: 14_129,
  fileName:
    "0047_allow_restart_safe_fad_rollover_finalization.sql",
  sha256:
    "bdabbcff52cd87c932c3f2e067d825786fd6dac6354ea4a3a90396ec972b0b2b",
});
const ROLLOVER_AT_MS = 1_000;
const FIRST_FAILURE_AT_MS = 1_100;
const RETRY_ACCEPTED_AT_MS = 1_150;
const RETRY_STARTED_AT_MS = 1_200;
const TERMINAL_AT_MS = 1_300;
const LEASE_EXPIRES_AT_MS = 2_000;
const ERROR_CODE = "FAD_ROLLOVER_FINALIZATION_FAILED";

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database.prepare(`
    INSERT INTO ${tableName} (${columns.join(", ")})
    VALUES (${columns.map((column) => `@${column}`).join(", ")})
  `).run(values);
}

function withoutTriggers(database, operation) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  database.pragma("foreign_keys = OFF");
  database.pragma("ignore_check_constraints = ON");
  try {
    for (const { name } of triggers) {
      database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
    return operation();
  } finally {
    database.pragma("ignore_check_constraints = OFF");
    for (const { sql } of triggers) database.exec(sql);
    database.pragma("foreign_keys = ON");
  }
}

function createRuntime(t, schemaVersion, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).filter(({ id }) => id <= schemaVersion),
    applicationBuildId: `${prefix}${schemaVersion}`,
    now: () => 1,
  });
  assert.equal(state.userVersion, schemaVersion);
  return connection;
}

function upgradeTo47(database) {
  return applyMigrations({
    database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).filter(({ id }) => id <= 47),
    applicationBuildId: "fad-rollover-finalization-upgrade-47",
    now: () => 2,
  });
}

function fixtureIds(base) {
  return Object.freeze({
    league: uuid(base + 1),
    season: uuid(base + 2),
    fad: uuid(base + 3),
    rollover: uuid(base + 4),
    job: uuid(base + 5),
    recovery: uuid(base + 6),
    request: uuid(base + 7),
    receipt: uuid(base + 8),
    actorUser: uuid(base + 9),
    actorMembership: uuid(base + 10),
    leaseToken: uuid(base + 11),
  });
}

function occurrenceKey(ids) {
  return `fad:${ids.fad}:rollover:1:${ROLLOVER_AT_MS}`;
}

function seedRecoveryRetry(database, base, {
  receiptAction = "finalize_rollover",
  receiptResourceId,
  receiptAcceptedAtMs = RETRY_ACCEPTED_AT_MS,
} = {}) {
  const ids = fixtureIds(base);
  withoutTriggers(database, () => {
    insert(database, "free_agent_draft_rollovers", {
      id: ids.rollover,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      sequence: 1,
      window_kind: "initial",
      predecessor_rollover_id: null,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: 0,
      creation_cutoff_at_ms: 900,
      rolls_over_at_ms: ROLLOVER_AT_MS,
      status: "recovery_required",
      processing_job_run_id: ids.job,
      processing_started_at_ms: 1_050,
      completed_at_ms: FIRST_FAILURE_AT_MS,
      last_error_code: ERROR_CODE,
      created_at_ms: 1,
      updated_at_ms: FIRST_FAILURE_AT_MS,
      version: 3,
    });
    insert(database, "job_runs", {
      id: ids.job,
      league_id: ids.league,
      season_id: ids.season,
      job_type: "fad_rollover",
      occurrence_key: occurrenceKey(ids),
      scheduled_for_ms: ROLLOVER_AT_MS,
      status: "running",
      attempt_count: 2,
      lease_owner: "fad-rollover-worker",
      lease_token: ids.leaseToken,
      lease_expires_at_ms: LEASE_EXPIRES_AT_MS,
      started_at_ms: RETRY_STARTED_AT_MS,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      created_at_ms: 1,
      updated_at_ms: RETRY_STARTED_AT_MS,
      version: 4,
      next_attempt_at_ms: null,
    });
    insert(database, "free_agent_draft_recoveries", {
      id: ids.recovery,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      player_id: null,
      allocation_id: null,
      rollover_id: ids.rollover,
      auction_id: null,
      job_run_id: ids.job,
      kind: "rollover_finalize",
      status: "running",
      earliest_activation_at_ms: null,
      target_resolution_at_ms: null,
      last_error_code: ERROR_CODE,
      commissioner_reason: "Retry rollover finalization.",
      created_by_operation_id: ids.job,
      resolved_by_user_id: null,
      resolved_by_membership_id: null,
      resolved_authority: null,
      created_at_ms: FIRST_FAILURE_AT_MS,
      updated_at_ms: receiptAcceptedAtMs,
      resolved_at_ms: null,
      version: 2,
      nomination_queue_id: null,
    });
    insert(database, "idempotency_requests", {
      id: ids.request,
      league_id: ids.league,
      actor_user_id: ids.actorUser,
      operation: "free_agent_draft.recovery.action",
      client_key: `rollover-retry-${base}`,
      request_hash: "a".repeat(64),
      status: "completed",
      result_type:
        "free_agent_draft_recovery_action_command_result",
      result_id: ids.receipt,
      created_at_ms: receiptAcceptedAtMs,
      completed_at_ms: receiptAcceptedAtMs,
      expires_at_ms: receiptAcceptedAtMs + 86_400_000,
    });
    insert(
      database,
      "free_agent_draft_recovery_action_command_results",
      {
        id: ids.receipt,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        recovery_id: ids.recovery,
        idempotency_request_id: ids.request,
        action: receiptAction,
        resource_kind: "rollover",
        resource_id: receiptResourceId ?? ids.rollover,
        operation_id: ids.job,
        job_run_id: ids.job,
        occurrence_key: occurrenceKey(ids),
        actor_user_id: ids.actorUser,
        actor_membership_id: ids.actorMembership,
        actor_authority: "commissioner",
        commissioner_reason: "Retry rollover finalization.",
        request_json: "{}",
        request_sha256: "a".repeat(64),
        accepted_status: "pending",
        accepted_at_ms: receiptAcceptedAtMs,
        response_http_status: 202,
        response_json: "{}",
        response_sha256: "b".repeat(64),
        version: 1,
      }
    );
  });
  return ids;
}

function completeRetriedRollover(database, ids) {
  database.prepare(`
    UPDATE free_agent_draft_rollovers
    SET status = 'completed',
        completed_at_ms = @terminalAtMs,
        last_error_code = NULL,
        updated_at_ms = @terminalAtMs,
        version = version + 1
    WHERE id = @rolloverId
  `).run({
    rolloverId: ids.rollover,
    terminalAtMs: TERMINAL_AT_MS,
  });
}

function settleRetriedRecovery(database, ids) {
  database.prepare(`
    UPDATE free_agent_draft_recoveries
    SET status = 'resolved',
        last_error_code = NULL,
        resolved_authority = 'system',
        updated_at_ms = @terminalAtMs,
        resolved_at_ms = @terminalAtMs,
        version = version + 1
    WHERE id = @recoveryId
  `).run({ recoveryId: ids.recovery, terminalAtMs: TERMINAL_AT_MS });
  database.prepare(`
    UPDATE job_runs
    SET status = 'succeeded',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @terminalAtMs,
        result_json = '{"outcome":"completed"}',
        updated_at_ms = @terminalAtMs,
        version = version + 1
    WHERE id = @jobRunId
  `).run({ jobRunId: ids.job, terminalAtMs: TERMINAL_AT_MS });
}

function repeatFailure(database, ids) {
  return database.transaction(() => {
    database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'correction_required',
          last_error_code = @errorCode,
          updated_at_ms = @terminalAtMs,
          version = version + 1
      WHERE id = @recoveryId
    `).run({
      recoveryId: ids.recovery,
      errorCode: ERROR_CODE,
      terminalAtMs: TERMINAL_AT_MS,
    });
    database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @terminalAtMs,
          last_error_code = @errorCode,
          updated_at_ms = @terminalAtMs,
          version = version + 1
      WHERE id = @jobRunId
    `).run({
      jobRunId: ids.job,
      errorCode: ERROR_CODE,
      terminalAtMs: TERMINAL_AT_MS,
    });
    database.prepare(`
      UPDATE free_agent_draft_rollovers
      SET status = 'recovery_required',
          completed_at_ms = @terminalAtMs,
          last_error_code = @errorCode,
          updated_at_ms = @terminalAtMs,
          version = version + 1
      WHERE id = @rolloverId
    `).run({
      rolloverId: ids.rollover,
      errorCode: ERROR_CODE,
      terminalAtMs: TERMINAL_AT_MS,
    });
  }).immediate();
}

function readState(database, ids) {
  return Object.freeze({
    rollover: database.prepare(`
      SELECT status, completed_at_ms, last_error_code, version
      FROM free_agent_draft_rollovers WHERE id = ?
    `).get(ids.rollover),
    recovery: database.prepare(`
      SELECT status, updated_at_ms, resolved_at_ms, version
      FROM free_agent_draft_recoveries WHERE id = ?
    `).get(ids.recovery),
    job: database.prepare(`
      SELECT status, lease_owner, lease_token, completed_at_ms,
             result_json, last_error_code, version
      FROM job_runs WHERE id = ?
    `).get(ids.job),
  });
}

function seedNormal(database, base) {
  const ids = fixtureIds(base);
  withoutTriggers(database, () => {
    insert(database, "free_agent_draft_rollovers", {
      id: ids.rollover,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      sequence: 1,
      window_kind: "initial",
      predecessor_rollover_id: null,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: 0,
      creation_cutoff_at_ms: 900,
      rolls_over_at_ms: ROLLOVER_AT_MS,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "job_runs", {
      id: ids.job,
      league_id: ids.league,
      season_id: ids.season,
      job_type: "fad_rollover",
      occurrence_key: occurrenceKey(ids),
      scheduled_for_ms: ROLLOVER_AT_MS,
      status: "running",
      attempt_count: 1,
      lease_owner: "fad-rollover-worker",
      lease_token: ids.leaseToken,
      lease_expires_at_ms: LEASE_EXPIRES_AT_MS,
      started_at_ms: 1_050,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      created_at_ms: 1,
      updated_at_ms: 1_050,
      version: 2,
      next_attempt_at_ms: null,
    });
  });
  return ids;
}

test("head 46 rejects recovered rollover completion and upgrade 47 admits the exact T142 evidence", (t) => {
  const runtime = createRuntime(t, 46, "fad-rollover-retry-upgrade-");
  const ids = seedRecoveryRetry(runtime.database, 47_000);

  assert.throws(
    () => completeRetriedRollover(runtime.database, ids),
    /FAD rollover may only process and reach durable terminal evidence/
  );
  assert.equal(readState(runtime.database, ids).rollover.version, 3);

  const state = upgradeTo47(runtime.database);
  assert.equal(state.userVersion, 47);
  completeRetriedRollover(runtime.database, ids);
  settleRetriedRecovery(runtime.database, ids);

  const persisted = readState(runtime.database, ids);
  assert.deepEqual(persisted.rollover, {
    status: "completed",
    completed_at_ms: TERMINAL_AT_MS,
    last_error_code: null,
    version: 4,
  });
  assert.equal(persisted.recovery.status, "resolved");
  assert.equal(persisted.recovery.resolved_at_ms, TERMINAL_AT_MS);
  assert.equal(persisted.job.status, "succeeded");
  assert.equal(persisted.job.completed_at_ms, TERMINAL_AT_MS);
});

test("head 46 rejects repeat terminal failure and upgrade 47 reuses the exact recovery and job", (t) => {
  const runtime = createRuntime(t, 46, "fad-rollover-repeat-upgrade-");
  const ids = seedRecoveryRetry(runtime.database, 48_000);
  const before = readState(runtime.database, ids);

  assert.throws(
    () => repeatFailure(runtime.database, ids),
    /FAD rollover may only process and reach durable terminal evidence/
  );
  assert.deepEqual(readState(runtime.database, ids), before);

  upgradeTo47(runtime.database);
  repeatFailure(runtime.database, ids);
  const persisted = readState(runtime.database, ids);
  assert.deepEqual(persisted.rollover, {
    status: "recovery_required",
    completed_at_ms: TERMINAL_AT_MS,
    last_error_code: ERROR_CODE,
    version: 4,
  });
  assert.equal(persisted.recovery.status, "correction_required");
  assert.equal(persisted.recovery.updated_at_ms, TERMINAL_AT_MS);
  assert.equal(persisted.job.status, "failed");
  assert.equal(persisted.job.last_error_code, ERROR_CODE);
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_draft_recoveries
      WHERE rollover_id = ? AND kind = 'rollover_finalize'
    `).get(ids.rollover).count,
    1
  );
});

test("fresh head 47 preserves normal rollover transitions and rejects malformed retry evidence atomically", (t) => {
  const runtime = createRuntime(t, 47, "fad-rollover-fresh-47-");
  const normal = seedNormal(runtime.database, 49_000);
  runtime.database.prepare(`
    UPDATE free_agent_draft_rollovers
    SET status = 'processing',
        processing_job_run_id = @jobRunId,
        processing_started_at_ms = 1050,
        updated_at_ms = 1050,
        version = version + 1
    WHERE id = @rolloverId
  `).run({ jobRunId: normal.job, rolloverId: normal.rollover });
  runtime.database.prepare(`
    UPDATE free_agent_draft_rollovers
    SET status = 'completed', completed_at_ms = 1100,
        updated_at_ms = 1100, version = version + 1
    WHERE id = @rolloverId
  `).run({ rolloverId: normal.rollover });
  assert.deepEqual(
    runtime.database.prepare(`
      SELECT status, version FROM free_agent_draft_rollovers
      WHERE id = ?
    `).get(normal.rollover),
    { status: "completed", version: 3 }
  );

  const normalFailure = seedNormal(runtime.database, 49_100);
  runtime.database.prepare(`
    UPDATE free_agent_draft_rollovers
    SET status = 'processing',
        processing_job_run_id = @jobRunId,
        processing_started_at_ms = 1050,
        updated_at_ms = 1050,
        version = version + 1
    WHERE id = @rolloverId
  `).run({
    jobRunId: normalFailure.job,
    rolloverId: normalFailure.rollover,
  });
  withoutTriggers(runtime.database, () => {
    insert(runtime.database, "free_agent_draft_recoveries", {
      id: normalFailure.recovery,
      league_id: normalFailure.league,
      season_id: normalFailure.season,
      fad_id: normalFailure.fad,
      player_id: null,
      allocation_id: null,
      rollover_id: normalFailure.rollover,
      auction_id: null,
      job_run_id: normalFailure.job,
      kind: "rollover_finalize",
      status: "correction_required",
      earliest_activation_at_ms: null,
      target_resolution_at_ms: null,
      last_error_code: ERROR_CODE,
      commissioner_reason: "Review rollover finalization.",
      created_by_operation_id: normalFailure.job,
      resolved_by_user_id: null,
      resolved_by_membership_id: null,
      resolved_authority: null,
      created_at_ms: 1_100,
      updated_at_ms: 1_100,
      resolved_at_ms: null,
      version: 1,
      nomination_queue_id: null,
    });
  });
  runtime.database.prepare(`
    UPDATE free_agent_draft_rollovers
    SET status = 'recovery_required',
        completed_at_ms = 1100,
        last_error_code = @errorCode,
        updated_at_ms = 1100,
        version = version + 1
    WHERE id = @rolloverId
  `).run({
    errorCode: ERROR_CODE,
    rolloverId: normalFailure.rollover,
  });
  assert.deepEqual(
    runtime.database.prepare(`
      SELECT status, last_error_code, version
      FROM free_agent_draft_rollovers
      WHERE id = ?
    `).get(normalFailure.rollover),
    {
      status: "recovery_required",
      last_error_code: ERROR_CODE,
      version: 3,
    }
  );

  const malformed = seedRecoveryRetry(runtime.database, 50_000, {
    receiptAction: "complete_fad",
  });
  const before = readState(runtime.database, malformed);
  assert.throws(
    () => completeRetriedRollover(runtime.database, malformed),
    /FAD rollover may only process and reach durable terminal evidence/
  );
  assert.deepEqual(readState(runtime.database, malformed), before);
  assert.throws(
    () => repeatFailure(runtime.database, malformed),
    /FAD rollover may only process and reach durable terminal evidence/
  );
  assert.deepEqual(readState(runtime.database, malformed), before);
});

test("head 47 enforces one rollover-finalize recovery per causal job", (t) => {
  const runtime = createRuntime(t, 47, "fad-rollover-recovery-unique-");
  const ids = seedRecoveryRetry(runtime.database, 51_000);
  const original = runtime.database.prepare(`
    SELECT * FROM free_agent_draft_recoveries WHERE id = ?
  `).get(ids.recovery);

  assert.throws(
    () => withoutTriggers(runtime.database, () => {
      insert(runtime.database, "free_agent_draft_recoveries", {
        ...original,
        id: uuid(51_099),
      });
    }),
    /UNIQUE constraint failed/
  );
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_draft_recoveries
      WHERE rollover_id = ? AND job_run_id = ?
        AND kind = 'rollover_finalize'
    `).get(ids.rollover, ids.job).count,
    1
  );
});

test("migration 0047 has immutable identity and advances only schema metadata 46 to 47", (t) => {
  const migration = discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  }).find(({ id }) => id === 47);
  assert.ok(migration);
  assert.equal(migration.fileName, MIGRATION_0047.fileName);
  assert.equal(Buffer.byteLength(migration.sql), MIGRATION_0047.byteLength);
  assert.equal(sha256(migration.sql), MIGRATION_0047.sha256);

  const runtime = createRuntime(t, 47, "fad-rollover-identity-");
  assert.equal(
    runtime.database.prepare(`
      SELECT metadata_value AS value
      FROM application_metadata
      WHERE metadata_key = 'data_model_version'
    `).get().value,
    "47"
  );
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations
      WHERE migration_id = 47 AND file_name = ? AND checksum = ?
    `).get(MIGRATION_0047.fileName, MIGRATION_0047.sha256).count,
    1
  );
});
