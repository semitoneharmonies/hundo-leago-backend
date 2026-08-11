const REQUIRED_HOLD_VALUES = Object.freeze({
  APP_ENV: "staging",
  NODE_ENV: "production",
  LEAGUE_WRITE_MODE: "closed",
  SCHEDULED_JOBS_ENABLED: "false",
  FREE_AGENT_DRAFT_ROUTES_ENABLED: "false",
  ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
  DEBUG_ROUTES_ENABLED: "false",
  EMAIL_DELIVERY_MODE: "capture",
  SPORTSDATAIO_NHL_LIVE_MODE: "probe",
  BACKUP_SCHEDULE_ENABLED: "false",
});

class StagingMaintenanceHoldConfigError extends Error {
  constructor(field, reason) {
    super(
      `Invalid staging maintenance-hold configuration for ${field}: ${reason}`
    );
    this.name = "StagingMaintenanceHoldConfigError";
    this.code = "STAGING_MAINTENANCE_HOLD_CONFIG_INVALID";
    this.field = field;
  }
}

function fail(field, reason) {
  throw new StagingMaintenanceHoldConfigError(field, reason);
}

function parsePort(env) {
  const value = env.PORT;
  if (typeof value !== "string" || !/^\d{1,5}$/u.test(value)) {
    fail("PORT", "a decimal TCP port is required");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail("PORT", "the TCP port is outside the approved range");
  }
  return port;
}

function loadStagingMaintenanceHoldConfig({ env = process.env } = {}) {
  if (!env || typeof env !== "object") {
    throw new TypeError("maintenance-hold environment must be an object");
  }

  const value = env.STAGING_MAINTENANCE_HOLD;
  if (value === undefined || value === "false") {
    return Object.freeze({ enabled: false });
  }
  if (value !== "true") {
    fail(
      "STAGING_MAINTENANCE_HOLD",
      "the value must be exactly true or false"
    );
  }

  for (const [field, required] of Object.entries(REQUIRED_HOLD_VALUES)) {
    if (env[field] !== required) {
      fail(field, `the value must be exactly ${required}`);
    }
  }

  return Object.freeze({
    enabled: true,
    port: parsePort(env),
  });
}

module.exports = {
  REQUIRED_HOLD_VALUES,
  StagingMaintenanceHoldConfigError,
  loadStagingMaintenanceHoldConfig,
};
