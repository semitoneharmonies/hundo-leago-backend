const { INITIAL_RECOVERY_EPOCH, RecoveryEpochError, validateRecoveryEpoch } = require("../../domain/recovery/recoveryEpochPolicy");
const { canonicalize } = require("../migration/sourceInventory");
const RECOVERY_EPOCH_KEY = "recovery_epoch_v1";

function readRecoveryEpoch(database) {
  try {
    const row = database.prepare("SELECT metadata_value FROM application_metadata WHERE metadata_key=?").get(RECOVERY_EPOCH_KEY);
    if (!row) return INITIAL_RECOVERY_EPOCH;
    const epoch = validateRecoveryEpoch(JSON.parse(row.metadata_value));
    if (epoch.generation === 0 || canonicalize(epoch) !== row.metadata_value) throw new RecoveryEpochError();
    return epoch;
  } catch { throw new RecoveryEpochError(); }
}

module.exports = { RECOVERY_EPOCH_KEY, readRecoveryEpoch };
