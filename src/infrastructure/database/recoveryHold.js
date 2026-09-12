const RECOVERY_HOLD_KEY = "recovery_hold_v1";

class RecoveryHoldError extends Error {
  constructor() {
    super("This database is held for recovery reconciliation and cannot start the normal application.");
    this.name = "RecoveryHoldError";
    this.code = "DATABASE_RECOVERY_HELD";
  }
}

// Presence is authoritative, even if the value is damaged or says "false".
// Configuration flags cannot clear a durable recovery hold. A later recovery
// command must reconcile effects and record explicit release evidence first.
function assertRecoveryRuntimeAllowed(database) {
  if (database.prepare(
    "SELECT 1 FROM application_metadata WHERE metadata_key = ?"
  ).get(RECOVERY_HOLD_KEY)) {
    throw new RecoveryHoldError();
  }
}

module.exports = { RECOVERY_HOLD_KEY, RecoveryHoldError, assertRecoveryRuntimeAllowed };
