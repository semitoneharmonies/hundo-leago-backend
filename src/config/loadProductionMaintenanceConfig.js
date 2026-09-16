const REQUIRED_VALUES = Object.freeze({
  PRODUCTION_MAINTENANCE_HOLD: "true",
  APP_ENV: "production",
  NODE_ENV: "production",
  RENDER: "true",
  RENDER_SERVICE_TYPE: "web",
  RENDER_GIT_BRANCH: "main",
  IS_PULL_REQUEST: "false",
  LEAGUE_WRITE_MODE: "closed",
  SCHEDULED_JOBS_ENABLED: "false",
  FREE_AGENT_DRAFT_ROUTES_ENABLED: "false",
  ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
  DEBUG_ROUTES_ENABLED: "false",
  EMAIL_DELIVERY_MODE: "send",
  BACKUP_SCHEDULE_ENABLED: "false",
  SPORTSDATAIO_NHL_LIVE_MODE: "disabled",
  NHL_COMPLETED_STATISTICS_ENABLED: "false",
  MATCHUP_PROCESSING_ENABLED: "false",
  AUCTIONS_ENABLED: "false",
  SNAPSHOTS_ENABLED: "false",
  MATCHUPS_ENABLED: "false",
});

class ProductionMaintenanceConfigError extends Error {
  constructor(field) {
    super("Production maintenance configuration is not confirmed.");
    this.name = "ProductionMaintenanceConfigError";
    this.code = "PRODUCTION_MAINTENANCE_CONFIG_INVALID";
    this.field = field;
  }
}
function fail(field) { throw new ProductionMaintenanceConfigError(field); }

function assertProductionMaintenanceInactive({ env = process.env } = {}) {
  if (env?.PRODUCTION_MAINTENANCE_HOLD !== undefined && env.PRODUCTION_MAINTENANCE_HOLD !== "false") {
    const error = new Error("Use the confirmed production maintenance entrypoint while the hold is set.");
    error.code = "PRODUCTION_MAINTENANCE_ENTRYPOINT_REQUIRED";
    error.field = "PRODUCTION_MAINTENANCE_HOLD";
    throw error;
  }
}

function loadProductionMaintenanceConfig({ env = process.env } = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("production maintenance environment must be an object");
  }
  for (const [field, required] of Object.entries(REQUIRED_VALUES)) {
    if (env[field] !== required) fail(field);
  }
  for (const field of ["STAGING_MAINTENANCE_HOLD", "STAGING_DAILY_AUCTIONS_ENABLED"]) {
    if (env[field] !== undefined && env[field] !== "false") fail(field);
  }
  if (!/^[a-f0-9]{40}$/.test(env.APP_BUILD_ID || "")) fail("APP_BUILD_ID");
  if (env.RENDER_GIT_COMMIT !== env.APP_BUILD_ID) fail("RENDER_GIT_COMMIT");
  if (!/^srv-[a-z0-9]{8,64}$/.test(env.RENDER_SERVICE_ID || "")) fail("RENDER_SERVICE_ID");
  const confirmation = `${env.RENDER_SERVICE_ID}:${env.APP_BUILD_ID}`;
  if (env.PRODUCTION_MAINTENANCE_CONFIRMATION !== confirmation) fail("PRODUCTION_MAINTENANCE_CONFIRMATION");
  if (typeof env.PORT !== "string" || !/^[0-9]{1,5}$/.test(env.PORT)) fail("PORT");
  const port = Number(env.PORT);
  if (port < 1 || port > 65535) fail("PORT");
  // No paths, database, credentials or provider clients are read by this loader.
  // The confirmation guards accidental deployment; release authorization is separate.
  return Object.freeze({ enabled: true, port, buildId: env.APP_BUILD_ID, serviceId: env.RENDER_SERVICE_ID });
}

module.exports = { REQUIRED_VALUES, ProductionMaintenanceConfigError, loadProductionMaintenanceConfig, assertProductionMaintenanceInactive };
