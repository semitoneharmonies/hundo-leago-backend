const crypto = require("node:crypto");

function assertDatabase(database) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.pragma !== "function"
  ) {
    throw new TypeError("runtime health requires an open SQLite database");
  }
}

function migrationChecksumSetId(migrationState) {
  if (
    migrationState?.status !== "exact" ||
    !Array.isArray(migrationState.applied)
  ) {
    throw new TypeError("runtime health requires an exact migration state");
  }
  const canonical = migrationState.applied
    .map(({ id, fileName, checksum }) => `${id}:${fileName}:${checksum}`)
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function identitySuffix(databaseId) {
  if (typeof databaseId !== "string" || databaseId.length < 8) {
    throw new TypeError("runtime health requires a database identity");
  }
  return databaseId.slice(-8);
}

function createRuntimeHealthService({
  database,
  migrationState,
  databaseIdentity,
  runtimeConfig,
} = {}) {
  assertDatabase(database);
  if (
    !runtimeConfig ||
    !["staging", "production"].includes(runtimeConfig.appEnv) ||
    typeof runtimeConfig.buildId !== "string" ||
    typeof runtimeConfig.frontendBuildId !== "string" ||
    !["closed", "open"].includes(runtimeConfig.leagueWriteMode) ||
    typeof runtimeConfig.scheduledJobsEnabled !== "boolean"
  ) {
    throw new TypeError(
      "runtime health requires validated deployment configuration"
    );
  }
  const checksumSetId = migrationChecksumSetId(migrationState);
  const databaseIdSuffix = identitySuffix(databaseIdentity?.databaseId);
  let lifecycle = "starting";
  let schedulerState = runtimeConfig.scheduledJobsEnabled
    ? runtimeConfig.leagueWriteMode === "closed"
      ? "paused_maintenance"
      : "not_started"
    : "disabled";

  const readinessQuery = database.prepare("SELECT 1 AS ready");
  const latestBackupQuery = database.prepare(`
    SELECT id, created_at_ms AS createdAtMs, verified_at_ms AS verifiedAtMs
    FROM backup_catalog
    WHERE status = 'verified'
    ORDER BY verified_at_ms DESC, created_at_ms DESC, id DESC
    LIMIT 1
  `);
  const latestStatisticsQuery = database.prepare(`
    SELECT id, nhl_season_key AS nhlSeasonKey,
      started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs
    FROM stat_refreshes
    WHERE status = 'succeeded'
    ORDER BY completed_at_ms DESC, started_at_ms DESC, id DESC
    LIMIT 1
  `);
  const outboxQuery = database.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'publishing' THEN 1 ELSE 0 END) AS publishing,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM outbox_events
  `);

  function isDatabaseReady() {
    if (!database.open) return false;
    try {
      return readinessQuery.get()?.ready === 1;
    } catch {
      return false;
    }
  }

  function markReady() {
    if (lifecycle !== "starting") {
      throw new Error("runtime readiness may be established only once");
    }
    if (!isDatabaseReady()) {
      throw new Error("runtime database is not ready");
    }
    lifecycle = "ready";
  }

  function markStopping() {
    if (lifecycle === "closed") return;
    lifecycle = "stopping";
    if (["starting", "running"].includes(schedulerState)) {
      schedulerState = "stopping";
    }
  }

  function markClosed() {
    lifecycle = "closed";
    if (schedulerState !== "disabled") schedulerState = "stopped";
  }

  function setSchedulerState(value) {
    const allowed = runtimeConfig.scheduledJobsEnabled
      ? [
          "not_started",
          "paused_maintenance",
          "starting",
          "running",
          "stopping",
          "stopped",
          "failed",
        ]
      : ["disabled"];
    if (!allowed.includes(value)) {
      throw new TypeError("runtime scheduler state is invalid");
    }
    schedulerState = value;
  }

  function readLiveness() {
    return Object.freeze({
      status: lifecycle === "closed" ? "not_live" : "live",
    });
  }

  function readReadiness() {
    const ready = lifecycle === "ready" && isDatabaseReady();
    return Object.freeze({ status: ready ? "ready" : "not_ready" });
  }

  function readOperations() {
    if (readReadiness().status !== "ready") {
      throw new Error("runtime operations health is not ready");
    }
    const backup = latestBackupQuery.get() || null;
    const statistics = latestStatisticsQuery.get() || null;
    const outbox = outboxQuery.get();
    return Object.freeze({
      environment: runtimeConfig.appEnv,
      environmentId: runtimeConfig.environmentId,
      backendBuildId: runtimeConfig.buildId,
      frontendBuildId: runtimeConfig.frontendBuildId,
      schemaVersion: migrationState.userVersion,
      migrationChecksumSetId: checksumSetId,
      databaseIdSuffix,
      lifecycle,
      scheduler: Object.freeze({
        enabled: runtimeConfig.scheduledJobsEnabled,
        state: schedulerState,
      }),
      maintenance: Object.freeze({ state: runtimeConfig.leagueWriteMode }),
      lastVerifiedBackup: backup ? Object.freeze({ ...backup }) : null,
      lastValidStatisticsRefresh: statistics
        ? Object.freeze({ ...statistics })
        : null,
      outbox: Object.freeze({
        pending: outbox?.pending || 0,
        publishing: outbox?.publishing || 0,
        failed: outbox?.failed || 0,
      }),
    });
  }

  return Object.freeze({
    markClosed,
    markReady,
    markStopping,
    readLiveness,
    readOperations,
    readReadiness,
    setSchedulerState,
  });
}

module.exports = {
  createRuntimeHealthService,
  identitySuffix,
  migrationChecksumSetId,
};
