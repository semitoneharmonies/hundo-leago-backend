const {
  assertDatabaseIdentity,
} = require("../../../infrastructure/database/databaseIdentity");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require("../../../operations/release/releaseQaFixtureContract");

const STAGING_MAINTENANCE_EXCLUSION_NAMES = Object.freeze([
  "release_qa_fixture_reset",
  "staging_provider_catalog_import",
]);
const STAGING_MAINTENANCE_EXCLUSION_NAME_SET = new Set(
  STAGING_MAINTENANCE_EXCLUSION_NAMES
);
const BLOCKING_MATCHUP_STATUSES = Object.freeze([
  "live",
  "correction_required",
]);
const MATCHUP_STATUS_TABLES = Object.freeze([
  "matchup_weeks",
  "matchups",
]);
const SAFE_DESCRIPTORS = Object.freeze(
  Object.fromEntries(
    STAGING_MAINTENANCE_EXCLUSION_NAMES.map((exclusionName) => [
      exclusionName,
      Object.freeze({
        exclusionName,
        status: "excluded",
      }),
    ])
  )
);

class StagingMaintenanceExclusionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StagingMaintenanceExclusionError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new StagingMaintenanceExclusionError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function assertExactConfiguration({
  database,
  appEnv,
  environmentId,
  databaseId,
  leagueWriteMode,
  scheduledJobsEnabled,
}) {
  if (!database || typeof database.prepare !== "function") {
    fail(
      "STAGING_MAINTENANCE_EXCLUSION_CONFIG_INVALID",
      "A readable database boundary is required."
    );
  }
  if (
    appEnv !== "staging" ||
    environmentId !== FIXTURE_ENVIRONMENT_ID ||
    databaseId !== FIXTURE_DATABASE_ID ||
    leagueWriteMode !== "closed" ||
    scheduledJobsEnabled !== false
  ) {
    fail(
      "STAGING_MAINTENANCE_EXCLUSION_CONFIG_INVALID",
      "The exact closed staging release-QA maintenance configuration is required."
    );
  }
}

function assertExactExclusionName(exclusionName) {
  if (!STAGING_MAINTENANCE_EXCLUSION_NAME_SET.has(exclusionName)) {
    fail(
      "STAGING_MAINTENANCE_EXCLUSION_NAME_INVALID",
      "The maintenance operation is not an approved coordinator exclusion."
    );
  }
  return exclusionName;
}

function assertStoredFixtureIdentity(database) {
  try {
    const identity = assertDatabaseIdentity(database, {
      environmentId: FIXTURE_ENVIRONMENT_ID,
      databaseId: FIXTURE_DATABASE_ID,
    });
    if (
      identity.environmentId !== FIXTURE_ENVIRONMENT_ID ||
      identity.databaseId !== FIXTURE_DATABASE_ID
    ) {
      fail(
        "STAGING_MAINTENANCE_EXCLUSION_IDENTITY_INVALID",
        "The database is not the staging release-QA fixture."
      );
    }
  } catch (error) {
    if (error instanceof StagingMaintenanceExclusionError) {
      throw error;
    }
    fail(
      "STAGING_MAINTENANCE_EXCLUSION_IDENTITY_INVALID",
      "The database is not the staging release-QA fixture.",
      error
    );
  }
}

function blockingMatchupCounts(database) {
  const counts = [];
  const failures = [];

  for (const tableName of MATCHUP_STATUS_TABLES) {
    try {
      const row = database
        .prepare(
          `
            SELECT COUNT(*) AS blocking_count
            FROM ${tableName}
            WHERE status IN (?, ?)
          `
        )
        .get(...BLOCKING_MATCHUP_STATUSES);
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).length !== 1 ||
        !Number.isSafeInteger(row.blocking_count) ||
        row.blocking_count < 0
      ) {
        throw new TypeError(
          `${tableName} returned an invalid blocking-matchup count`
        );
      }
      counts.push(row.blocking_count);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0 || counts.length !== MATCHUP_STATUS_TABLES.length) {
    fail(
      "STAGING_MAINTENANCE_EXCLUSION_STATE_UNAVAILABLE",
      "Current matchup state could not be verified safely.",
      failures[0]
    );
  }
  return counts;
}

function createStagingMaintenanceExclusionGuard(options = {}) {
  assertExactConfiguration(options);
  const { database } = options;

  function assertExclusion(exclusionName) {
    const exactName = assertExactExclusionName(exclusionName);
    assertStoredFixtureIdentity(database);
    const counts = blockingMatchupCounts(database);
    if (counts.some((count) => count > 0)) {
      fail(
        "STAGING_MAINTENANCE_EXCLUSION_MATCHUP_ACTIVE",
        "Maintenance exclusion is unavailable while a matchup is live or requires correction."
      );
    }
    return SAFE_DESCRIPTORS[exactName];
  }

  return Object.freeze({ assertExclusion });
}

module.exports = {
  BLOCKING_MATCHUP_STATUSES,
  MATCHUP_STATUS_TABLES,
  STAGING_MAINTENANCE_EXCLUSION_NAMES,
  StagingMaintenanceExclusionError,
  createStagingMaintenanceExclusionGuard,
};
