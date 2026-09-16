const { assertDatabaseIdentity } = require("../../../infrastructure/database/databaseIdentity");

function createFirstAdministratorSetupPolicy({ database, config, clock, appEnv, buildId, leagueWriteMode } = {}) {
  function unavailable() {
    const error = new Error("The confirmed first-administrator setup is unavailable.");
    error.code = "FIRST_ADMINISTRATOR_SETUP_UNAVAILABLE";
    throw error;
  }
  if (!config || appEnv !== "production" || buildId !== config.buildId || leagueWriteMode !== "closed" ||
      typeof database?.prepare !== "function" || typeof clock?.nowMs !== "function") unavailable();

  function allows(userId) {
    if (userId !== config.userId || !Number.isSafeInteger(clock.nowMs()) || clock.nowMs() >= config.expiresAtMs) return false;
    try {
      assertDatabaseIdentity(database, config);
      const user = database.prepare("SELECT status FROM users WHERE id = ?").get(userId);
      if (user?.status !== "pending_credential_setup") return false;
      const roles = database.prepare("SELECT user_id, status FROM platform_roles WHERE role = 'platform_administrator'").all();
      if (roles.length !== 1 || roles[0].user_id !== userId || roles[0].status !== "active") return false;
      if (database.prepare("SELECT COUNT(*) AS count FROM user_credentials WHERE user_id = ?").get(userId).count !== 0) return false;
      const audit = database.prepare("SELECT target_user_id, actor_user_id FROM security_audit_events WHERE event_type = 'system_bootstrap.platform_administrator_created'").all();
      return audit.length === 1 && audit[0].target_user_id === userId && audit[0].actor_user_id === null;
    } catch { return false; }
  }

  // A restart after completion requires the operator to turn this mode off.
  if (!allows(config.userId)) unavailable();
  return Object.freeze({ allows });
}

module.exports = { createFirstAdministratorSetupPolicy };
