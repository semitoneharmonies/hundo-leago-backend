const {
  DATABASE_IDENTITY_KEYS,
} = require("../../infrastructure/database/databaseIdentity");

const TOKEN_PURPOSES = Object.freeze([
  "email_verification", "administrator_setup", "password_reset", "self_reactivation",
]);
const SESSION_STATUSES = Object.freeze(["active", "revoked", "expired"]);
const JOB_STATUSES = Object.freeze([
  "pending", "leased", "running", "succeeded", "failed", "skipped",
]);
const OUTBOX_STATUSES = Object.freeze([
  "pending", "publishing", "published", "failed", "discarded",
]);
const IDEMPOTENCY_STATUSES = Object.freeze(["started", "completed", "failed"]);

class RecoveryInventoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "RecoveryInventoryError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new RecoveryInventoryError(code, message, cause ? { cause } : {});
}

function canonicalIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function count(database, sql, ...parameters) {
  const result = database.prepare(sql).get(...parameters).count;
  if (!Number.isSafeInteger(result) || result < 0) {
    fail("RECOVERY_INVENTORY_INVALID", "The recovery inventory contains invalid counts.");
  }
  return result;
}

function groupedCounts(database, sql, allowedValues) {
  const result = Object.fromEntries(allowedValues.map((value) => [value, 0]));
  for (const { category, count: total } of database.prepare(sql).all()) {
    if (!allowedValues.includes(category) || !Number.isSafeInteger(total) || total < 0) {
      fail("RECOVERY_INVENTORY_INVALID", "The recovery inventory contains an unsupported state.");
    }
    result[category] = total;
  }
  return Object.freeze(result);
}

// Operational evidence only. No credentials, payloads, lease owners or record IDs
// are selected. Worker holds and recovery preparation must be proved separately.
function inspectRecoveryInventory({
  database,
  expectedEnvironmentId,
  expectedDatabaseId,
  observedAtMs,
} = {}) {
  if (
    !database?.open || database.readonly !== true || database.inTransaction ||
    !canonicalIdentity(expectedEnvironmentId) || !canonicalIdentity(expectedDatabaseId) ||
    !Number.isSafeInteger(observedAtMs) || observedAtMs < 0
  ) {
    fail("RECOVERY_INVENTORY_INPUT_INVALID",
      "A fresh read-only database, exact identity and safe observation time are required.");
  }
  try {
    return database.transaction(() => {
      const identityRows = database.prepare(
        "SELECT metadata_key, metadata_value FROM application_metadata " +
        "WHERE metadata_key IN (?, ?)"
      ).all(DATABASE_IDENTITY_KEYS.environmentId, DATABASE_IDENTITY_KEYS.databaseId);
      const identity = Object.fromEntries(identityRows.map((row) => [
        row.metadata_key, row.metadata_value,
      ]));
      if (
        identity[DATABASE_IDENTITY_KEYS.environmentId] !== expectedEnvironmentId ||
        identity[DATABASE_IDENTITY_KEYS.databaseId] !== expectedDatabaseId
      ) {
        fail("RECOVERY_INVENTORY_IDENTITY_MISMATCH",
          "The recovery candidate does not match the requested database identity.");
      }

      const sessions = groupedCounts(database,
        "SELECT status AS category, COUNT(*) AS count FROM sessions GROUP BY status",
        SESSION_STATUSES);
      const activeActionTokens = groupedCounts(database,
        "SELECT purpose AS category, COUNT(*) AS count FROM account_action_tokens " +
        "WHERE status = 'active' GROUP BY purpose", TOKEN_PURPOSES);
      const jobs = groupedCounts(database,
        "SELECT status AS category, COUNT(*) AS count FROM job_runs GROUP BY status",
        JOB_STATUSES);
      const leases = Object.freeze({
        outstanding: jobs.leased + jobs.running,
        expired: count(database,
          "SELECT COUNT(*) AS count FROM job_runs WHERE status IN ('leased', 'running') " +
          "AND lease_expires_at_ms <= ?", observedAtMs),
      });
      // These partitions match the actual account and league outbox consumers.
      const accountEmailOutbox = groupedCounts(database,
        "SELECT status AS category, COUNT(*) AS count FROM outbox_events " +
        "WHERE league_id IS NULL GROUP BY status", OUTBOX_STATUSES);
      const leagueOutbox = groupedCounts(database,
        "SELECT status AS category, COUNT(*) AS count FROM outbox_events " +
        "WHERE league_id IS NOT NULL GROUP BY status", OUTBOX_STATUSES);
      const idempotency = groupedCounts(database,
        "SELECT status AS category, COUNT(*) AS count FROM idempotency_requests GROUP BY status",
        IDEMPOTENCY_STATUSES);

      return Object.freeze({
        inventoryVersion: 1,
        observedAtMs,
        schemaVersion: database.pragma("user_version", { simple: true }),
        databaseIdentity: Object.freeze({
          environmentId: expectedEnvironmentId, databaseId: expectedDatabaseId,
        }),
        sessions, activeActionTokens, jobs, leases,
        accountEmailOutbox, leagueOutbox, idempotency,
        activationReady: false,
        verificationScope: "read-only-inventory",
        remainingRecoveryGates: Object.freeze([
          "session-and-action-token-invalidation",
          "recovery-epoch-and-idempotency-boundary",
          "job-lease-and-occurrence-reconciliation",
          "email-and-league-outbox-reconciliation",
          "financial-and-league-state-reconciliation",
          "runtime-hold-and-controlled-reopening",
        ]),
      });
    }).deferred();
  } catch (error) {
    if (error instanceof RecoveryInventoryError) throw error;
    fail("RECOVERY_INVENTORY_FAILED", "The recovery candidate inventory failed safely.", error);
  }
}

module.exports = { RecoveryInventoryError, inspectRecoveryInventory };
