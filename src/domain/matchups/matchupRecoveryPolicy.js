const MATCHUP_RECOVERY_CODES = Object.freeze({
  confirmationRequired: "MATCHUP_RECOVERY_CONFIRMATION_REQUIRED",
  reasonInvalid: "MATCHUP_RECOVERY_REASON_INVALID",
  versionInvalid: "MATCHUP_RECOVERY_VERSION_INVALID",
});

function validateRecoveryCommand({ confirmed, reason, expectedVersion } = {}) {
  if (confirmed !== true) {
    const error = new TypeError("Explicit recovery confirmation is required.");
    error.code = MATCHUP_RECOVERY_CODES.confirmationRequired;
    throw error;
  }
  if (
    typeof reason !== "string" || reason.trim() !== reason || reason.length < 1 ||
    reason.length > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(reason)
  ) {
    const error = new TypeError("A bounded recovery reason is required.");
    error.code = MATCHUP_RECOVERY_CODES.reasonInvalid;
    throw error;
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    const error = new TypeError("An expected recovery version is required.");
    error.code = MATCHUP_RECOVERY_CODES.versionInvalid;
    throw error;
  }
  return Object.freeze({ reason, expectedVersion });
}

module.exports = { MATCHUP_RECOVERY_CODES, validateRecoveryCommand };
