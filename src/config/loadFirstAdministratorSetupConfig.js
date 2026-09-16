const MAX_SETUP_WINDOW_MS = 72 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail() {
  const error = new Error("First-administrator setup requires a confirmed, closed production runtime and a bounded setup window.");
  error.code = "FIRST_ADMINISTRATOR_SETUP_CONFIG_INVALID";
  throw error;
}

function loadFirstAdministratorSetupConfig({ env, runtimeConfig, nowMs = Date.now() } = {}) {
  const enabled = env?.FIRST_ADMINISTRATOR_SETUP_ENABLED;
  if (enabled === undefined || enabled === "false") return null;
  if (enabled !== "true" || !runtimeConfig) fail();
  const config = runtimeConfig;
  const expiresAt = env.FIRST_ADMINISTRATOR_SETUP_EXPIRES_AT;
  const userId = env.FIRST_ADMINISTRATOR_SETUP_USER_ID;
  const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  if (
    config.appEnv !== "production" || config.leagueWriteMode !== "closed" ||
    config.scheduledJobsEnabled !== false || config.backupScheduleEnabled === true ||
    config.freeAgentDraftRoutesEnabled !== false || config.debugRoutesEnabled !== false ||
    config.nhlCompletedStatisticsEnabled !== false || config.matchupProcessingEnabled !== false ||
    config.sportsDataIoLiveNhl?.mode !== "disabled" ||
    !/^[a-f0-9]{40}$/.test(config.buildId || "") ||
    typeof userId !== "string" || !UUID.test(userId) ||
    typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) ||
    !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_SETUP_WINDOW_MS ||
    new Date(expiresAtMs).toISOString() !== expiresAt ||
    env.FIRST_ADMINISTRATOR_SETUP_CONFIRMATION !==
      `${config.environmentId}:${config.databaseId}:${config.buildId}:${userId}:${expiresAt}`
  ) fail();
  return Object.freeze({ userId, expiresAtMs, environmentId: config.environmentId,
    databaseId: config.databaseId, buildId: config.buildId });
}

module.exports = { MAX_SETUP_WINDOW_MS, loadFirstAdministratorSetupConfig };
