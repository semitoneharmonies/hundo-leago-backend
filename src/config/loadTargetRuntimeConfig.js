const path = require("node:path");

const {
  loadSecurityConfig,
} = require("./loadSecurityConfig");

const DEPLOYED_ENVIRONMENTS = Object.freeze([
  "staging",
  "production",
]);
const IDENTITY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

class TargetRuntimeConfigError extends Error {
  constructor(field, reason) {
    super(`Invalid target runtime configuration for ${field}: ${reason}`);
    this.name = "TargetRuntimeConfigError";
    this.code = "TARGET_RUNTIME_CONFIG_INVALID";
    this.field = field;
  }
}

function fail(field, reason) {
  throw new TargetRuntimeConfigError(field, reason);
}

function requiredString(env, field) {
  const raw = env[field];
  if (
    typeof raw !== "string" ||
    raw === "" ||
    raw !== raw.trim()
  ) {
    fail(field, "a non-empty trimmed value is required");
  }
  return raw;
}

function exactBoolean(env, field) {
  const value = requiredString(env, field);
  if (value !== "true" && value !== "false") {
    fail(field, "the value must be exactly true or false");
  }
  return value === "true";
}

function exactEnum(env, field, allowed) {
  const value = requiredString(env, field);
  if (!allowed.includes(value)) {
    fail(field, "the value is not approved");
  }
  return value;
}

function parsePort(env) {
  const value = requiredString(env, "PORT");
  if (!/^\d{1,5}$/.test(value)) {
    fail("PORT", "a decimal TCP port is required");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail("PORT", "the TCP port is outside the approved range");
  }
  return port;
}

function absolutePath(env, field) {
  const value = requiredString(env, field);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(field, "a normalized absolute path is required");
  }
  return value;
}

function deployedIdentity(env, field) {
  const value = requiredString(env, field);
  if (!IDENTITY_PATTERN.test(value)) {
    fail(field, "an opaque deployed identity is required");
  }
  return value;
}

function currentSeason(env) {
  const label = requiredString(env, "CURRENT_SEASON_LABEL");
  const nhlSeasonKey = requiredString(env, "CURRENT_NHL_SEASON_KEY");
  if (!/^\d{4}$/.test(label)) {
    fail("CURRENT_SEASON_LABEL", "a four-digit start year is required");
  }
  const startYear = Number(label);
  if (nhlSeasonKey !== `${startYear}${startYear + 1}`) {
    fail(
      "CURRENT_NHL_SEASON_KEY",
      "the NHL season key must match the configured season label"
    );
  }
  return Object.freeze({ label, nhlSeasonKey });
}

function approvedSportsDataIoOrigin(env) {
  const value = env.SPORTSDATAIO_NHL_API_ORIGIN === undefined
    ? "https://api.sportsdata.io/api/nhl/fantasy"
    : requiredString(env, "SPORTSDATAIO_NHL_API_ORIGIN");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "SPORTSDATAIO_NHL_API_ORIGIN",
      "a canonical SportsDataIO NHL HTTPS origin is required"
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== "https://api.sportsdata.io" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/api/nhl/fantasy" ||
    parsed.search ||
    parsed.hash
  ) {
    fail(
      "SPORTSDATAIO_NHL_API_ORIGIN",
      "a canonical SportsDataIO NHL HTTPS origin is required"
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function sportsDataIoNhlImport(env, appEnv) {
  const apiKey = env.SPORTSDATAIO_NHL_API_KEY;
  if (apiKey === undefined || apiKey === null || apiKey === "") {
    return Object.freeze({ enabled: false });
  }
  if (appEnv !== "staging") {
    fail(
      "SPORTSDATAIO_NHL_API_KEY",
      "SportsDataIO NHL import is authorized only for staging"
    );
  }
  if (
    typeof apiKey !== "string" ||
    apiKey !== apiKey.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(apiKey)
  ) {
    fail(
      "SPORTSDATAIO_NHL_API_KEY",
      "a non-empty trimmed server-side secret is required"
    );
  }
  const seasonStartYear = requiredString(
    env,
    "SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR"
  );
  if (!/^\d{4}$/.test(seasonStartYear)) {
    fail(
      "SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR",
      "a four-digit last-season start year is required"
    );
  }
  const result = {
    enabled: true,
    origin: approvedSportsDataIoOrigin(env),
    seasonStartYear,
    nhlSeasonKey: `${seasonStartYear}${Number(seasonStartYear) + 1}`,
  };
  Object.defineProperty(result, "apiKey", {
    configurable: false,
    enumerable: false,
    value: apiKey,
    writable: false,
  });
  return Object.freeze(result);
}

function loadTargetRuntimeConfig({
  env,
  backendRoot = path.resolve(__dirname, "..", ".."),
  loadSecurity = loadSecurityConfig,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError(
      "loadTargetRuntimeConfig requires an explicit environment object"
    );
  }
  if (typeof loadSecurity !== "function") {
    throw new TypeError(
      "loadTargetRuntimeConfig requires a security configuration loader"
    );
  }

  const security = loadSecurity({ env });
  if (!DEPLOYED_ENVIRONMENTS.includes(security.appEnv)) {
    fail("APP_ENV", "the deployment entrypoint accepts only staging or production");
  }
  const databasePath = absolutePath(env, "DATABASE_PATH");
  const persistentRoot = absolutePath(env, "PERSISTENT_DATA_ROOT");
  const relativeDatabasePath = path.relative(
    persistentRoot,
    databasePath
  );
  if (
    relativeDatabasePath === "" ||
    relativeDatabasePath === ".." ||
    relativeDatabasePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDatabasePath)
  ) {
    fail(
      "DATABASE_PATH",
      "the database must be a child of PERSISTENT_DATA_ROOT"
    );
  }

  const sportsDataIoNhl = sportsDataIoNhlImport(env, security.appEnv);
  return Object.freeze({
    appEnv: security.appEnv,
    buildId: security.buildId,
    currentSeason: currentSeason(env),
    databaseId: deployedIdentity(env, "DATABASE_ID"),
    databasePath,
    debugRoutesEnabled: exactBoolean(env, "DEBUG_ROUTES_ENABLED"),
    environmentId: deployedIdentity(env, "APP_ENVIRONMENT_ID"),
    frontendBuildId: deployedIdentity(env, "FRONTEND_BUILD_ID"),
    leagueWriteMode: exactEnum(env, "LEAGUE_WRITE_MODE", ["closed", "open"]),
    migrationsDirectory: path.join(
      path.resolve(backendRoot),
      "database",
      "migrations"
    ),
    persistentRoot,
    port: parsePort(env),
    scheduledJobsEnabled: exactBoolean(
      env,
      "SCHEDULED_JOBS_ENABLED"
    ),
    security,
    sportsDataIoNhl,
  });
}

module.exports = {
  DEPLOYED_ENVIRONMENTS,
  IDENTITY_PATTERN,
  TargetRuntimeConfigError,
  loadTargetRuntimeConfig,
  sportsDataIoNhlImport,
};
