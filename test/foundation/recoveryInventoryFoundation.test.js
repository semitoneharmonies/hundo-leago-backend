const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
const { inspectRecoveryInventory } = require("../../src/operations/backups/inspectRecoveryInventory");
const { createReleaseQaRuntime } = require("../../src/operations/release/createReleaseQaRuntime");
const {
  fixtureId, FIXTURE_DATABASE_ID, FIXTURE_ENVIRONMENT_ID,
} = require("../../src/operations/release/releaseQaFixtureContract");

const OBSERVED_AT = 100;
const PRIVATE_VALUE = "private-recovery-evidence-marker";
const PURPOSES = ["email_verification", "administrator_setup", "password_reset", "self_reactivation"];

function inspect(database, overrides = {}) {
  return inspectRecoveryInventory({
    database, expectedEnvironmentId: FIXTURE_ENVIRONMENT_ID,
    expectedDatabaseId: FIXTURE_DATABASE_ID, observedAtMs: OBSERVED_AT, ...overrides,
  });
}

async function runtime() {
  const started = await createReleaseQaRuntime({
    frontendOrigin: "http://127.0.0.1:5173", leagueWriteMode: "closed", port: 0,
    migrationsDirectory: path.resolve(__dirname, "../../database/migrations"),
    password: "Recovery Inventory Fixture Password 2026!",
  });
  return started;
}

function seedRecoveryStates(database) {
  const userId = fixtureId("recovery-inventory:user");
  database.prepare(
    "INSERT INTO users (id,email_normalized,email_display,display_name,display_name_normalized," +
    "status,created_at_ms,updated_at_ms,version) VALUES (?,?,?,?,?,'active',10,10,1)"
  ).run(userId, `${PRIVATE_VALUE}@example.test`, `${PRIVATE_VALUE}@example.test`, PRIVATE_VALUE, PRIVATE_VALUE);
  for (const [index, status] of ["active", "revoked", "expired"].entries()) {
    database.prepare(
      "INSERT INTO sessions (id,user_id,token_digest,csrf_secret_digest,status,created_at_ms," +
      "last_used_at_ms,idle_expires_at_ms,absolute_expires_at_ms,revoked_at_ms,client_metadata_json,version) " +
      "VALUES (?,?,?,?,?,10,10,500,1000,?,?,1)"
    ).run(fixtureId(`recovery-inventory:session:${status}`), userId,
      String(index + 1).repeat(64), "f".repeat(64), status, status === "active" ? null : 100,
      JSON.stringify({ private: PRIVATE_VALUE }));
  }
  for (const [index, purpose] of [...PURPOSES, "password_reset"].entries()) {
    database.prepare(
      "INSERT INTO account_action_tokens (id,user_id,token_digest,purpose,status,created_at_ms," +
      "expires_at_ms,consumed_at_ms,version) VALUES (?,?,?,?,?,10,500,?,1)"
    ).run(fixtureId(`recovery-inventory:token:${index}`), userId, String(index + 4).repeat(64), purpose,
      index === 4 ? "consumed" : "active", index === 4 ? 50 : null);
  }
  for (const [index, status] of ["pending", "leased", "running", "succeeded", "failed", "skipped"].entries()) {
    database.prepare(
      "INSERT INTO job_runs (id,league_id,job_type,occurrence_key,scheduled_for_ms,status," +
      "lease_owner,lease_token,lease_expires_at_ms,result_json,created_at_ms,updated_at_ms,version) " +
      "VALUES (?,?,?,?,90,?,?,?,?,?,10,10,1)"
    ).run(fixtureId(`recovery-inventory:job:${status}`), fixtureId(`league:league${index % 2 ? "A" : "B"}`),
      "recovery-inventory", `${PRIVATE_VALUE}:${status}`, status, PRIVATE_VALUE, PRIVATE_VALUE,
      status === "leased" ? 80 : status === "running" ? 200 : null, JSON.stringify({ private: PRIVATE_VALUE }));
  }
  for (const scope of ["account", "leagueA", "leagueB"]) {
    for (const status of ["pending", "publishing", "published", "failed", "discarded"]) {
      database.prepare(
        "INSERT INTO outbox_events (id,league_id,event_type,aggregate_type,aggregate_id,payload_json," +
        "status,available_at_ms,created_at_ms,updated_at_ms,version) VALUES (?,?,?,?,?,?,?,90,10,10,1)"
      ).run(fixtureId(`recovery-inventory:outbox:${scope}:${status}`), scope === "account" ? null : fixtureId(`league:${scope}`),
        "recovery.fixture", "user", userId, JSON.stringify({ envelope: PRIVATE_VALUE }), status);
    }
  }
  for (const status of ["started", "completed", "failed"]) {
    database.prepare(
      "INSERT INTO idempotency_requests (id,actor_user_id,operation,client_key,request_hash,status," +
      "created_at_ms,expires_at_ms) VALUES (?,?,'recovery.fixture',?,?,?,10,500)"
    ).run(fixtureId(`recovery-inventory:idempotency:${status}`), userId,
      `${PRIVATE_VALUE}:${status}`, "d".repeat(64), status);
  }
  return userId;
}

test("recovery inventory counts credentials and both delivery queues without writes or private data", async (t) => {
  const started = await runtime();
  const source = started.runtime.database;
  let readonly;
  t.after(async () => {
    if (readonly?.open) readonly.close();
    await started.close();
  });
  readonly = openReadonlyDatabase({ databasePath: started.databasePath });
  const baseline = inspect(readonly);
  const userId = seedRecoveryStates(source);
  const before = source.serialize();
  const report = inspect(readonly);

  for (const status of ["active", "revoked", "expired"]) {
    assert.equal(report.sessions[status], baseline.sessions[status] + 1);
  }
  for (const purpose of PURPOSES) {
    assert.equal(report.activeActionTokens[purpose], baseline.activeActionTokens[purpose] + 1);
  }
  for (const status of ["pending", "leased", "running", "succeeded", "failed", "skipped"]) {
    assert.equal(report.jobs[status], baseline.jobs[status] + 1);
  }
  assert.equal(report.leases.outstanding, baseline.leases.outstanding + 2);
  assert.equal(report.leases.expired, baseline.leases.expired + 1);
  for (const status of ["pending", "publishing", "published", "failed", "discarded"]) {
    assert.equal(report.accountEmailOutbox[status], baseline.accountEmailOutbox[status] + 1);
    assert.equal(report.leagueOutbox[status], baseline.leagueOutbox[status] + 2);
  }
  for (const status of ["started", "completed", "failed"]) {
    assert.equal(report.idempotency[status], baseline.idempotency[status] + 1);
  }
  assert.equal(report.activationReady, false);
  assert.equal(report.remainingRecoveryGates.includes("runtime-hold-and-controlled-reopening"), true);
  assert.deepEqual(inspect(readonly), report);
  assert.equal(Object.isFrozen(report.activeActionTokens), true);
  assert.equal(readonly.inTransaction, false);
  assert.equal(readonly.prepare("SELECT total_changes() AS count").get().count, 0);
  assert.deepEqual(source.serialize(), before);
  assert.deepEqual(source.pragma("foreign_key_check"), []);
  const serialized = JSON.stringify(report);
  for (const value of [PRIVATE_VALUE, userId, "f".repeat(64), "4".repeat(64)]) {
    assert.equal(serialized.includes(value), false);
  }

  await t.test("wrong identities, writable connections and unsafe timestamps fail without changes", () => {
    for (const overrides of [
      { expectedEnvironmentId: "different-environment" },
      { expectedDatabaseId: "different-database" },
    ]) {
      assert.throws(() => inspect(readonly, overrides), { code: "RECOVERY_INVENTORY_IDENTITY_MISMATCH" });
    }
    for (const overrides of [
      { database: source }, { observedAtMs: -1 }, { observedAtMs: NaN },
      { observedAtMs: Number.MAX_SAFE_INTEGER + 1 }, { expectedDatabaseId: " " },
    ]) {
      assert.throws(() => inspect(readonly, overrides), { code: "RECOVERY_INVENTORY_INPUT_INVALID" });
    }
    readonly.transaction(() => {
      assert.throws(() => inspect(readonly), { code: "RECOVERY_INVENTORY_INPUT_INVALID" });
    })();
    assert.equal(readonly.inTransaction, false);
    assert.deepEqual(source.serialize(), before);
  });

  await t.test("a concurrent commit cannot mix two database snapshots in one inventory", (child) => {
    const prepare = readonly.prepare.bind(readonly);
    let inserted = false;
    child.mock.method(readonly, "prepare", (sql) => {
      if (!inserted && sql.includes("FROM job_runs GROUP BY status")) {
        inserted = true;
        source.prepare(
          "INSERT INTO job_runs (id,job_type,occurrence_key,scheduled_for_ms,status," +
          "created_at_ms,updated_at_ms,version) VALUES (?,'recovery.fixture','concurrent',100,'pending',10,10,1)"
        ).run(fixtureId("recovery-inventory:concurrent-job"));
      }
      return prepare(sql);
    });
    const concurrent = inspect(readonly);
    assert.equal(inserted, true);
    assert.equal(concurrent.jobs.pending, report.jobs.pending);
    assert.equal(inspect(readonly).jobs.pending, report.jobs.pending + 1);
    assert.equal(readonly.prepare("SELECT total_changes() AS count").get().count, 0);
  });
});
