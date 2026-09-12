const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INITIAL_RECOVERY_EPOCH = Object.freeze({ generation: 0, recoveryId: null });
const RECOVERY_EPOCH_HEADER = "X-Hundo-Recovery-Epoch";

class RecoveryEpochError extends Error {
  constructor() {
    super("The database recovery boundary is unavailable or invalid.");
    this.name = "RecoveryEpochError";
    this.code = "DATABASE_RECOVERY_EPOCH_INVALID";
  }
}
function validateRecoveryEpoch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "generation,recoveryId" ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      (value.generation === 0 ? value.recoveryId !== null : !UUID.test(value.recoveryId || ""))) {
    throw new RecoveryEpochError();
  }
  return Object.freeze({ generation: value.generation, recoveryId: value.recoveryId });
}
function nextRecoveryEpoch(previous, recoveryId) {
  const current = validateRecoveryEpoch(previous);
  if (!UUID.test(recoveryId || "") || recoveryId === current.recoveryId || !Number.isSafeInteger(current.generation + 1)) {
    throw new RecoveryEpochError();
  }
  return validateRecoveryEpoch({ generation: current.generation + 1, recoveryId });
}
function recoveryEpochHeaderValue(epoch) {
  return validateRecoveryEpoch(epoch).recoveryId || "initial";
}
function recoveryRequestKeyIsCurrent(epoch, key) {
  const current = validateRecoveryEpoch(epoch);
  // Endpoints that do not use idempotency retain their own existing command
  // guards. This policy never manufactures a missing key or rewrites a retry.
  if (key === undefined) return true;
  if (typeof key !== "string") return false;
  if (current.generation === 0) return true;
  const prefix = `recovery:${current.recoveryId}:`;
  return key.startsWith(prefix) && key.length > prefix.length;
}

module.exports = { INITIAL_RECOVERY_EPOCH, RECOVERY_EPOCH_HEADER, RecoveryEpochError,
  validateRecoveryEpoch, nextRecoveryEpoch, recoveryEpochHeaderValue, recoveryRequestKeyIsCurrent };
