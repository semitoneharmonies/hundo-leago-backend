#!/usr/bin/env node

const path = require("node:path");

const {
  createResetMigrationReportCommitService,
  RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES,
} = require("../src/application/services/migration/createResetMigrationReportCommitService");
const {
  RESET_ORIGINAL_LEAGUE_REPORT_COMMIT_CONFIRMATION,
} = require("../src/domain/leagues/resetOriginalLeagueBootstrapPolicy");
const {
  openDatabase,
} = require("../src/infrastructure/database/connection");
const {
  loadAndValidateStagingDescriptor,
} = require("../src/infrastructure/database/stagingEnvironment");
const {
  assertMigrationCompatibility,
  discoverMigrations,
} = require("../src/infrastructure/database/migrate");
const {
  RESET_IMPORT_ARTIFACT_ERROR_CODES,
  readResetImportVerificationArtifact,
} = require("../src/infrastructure/migration/resetImportVerificationArtifact");
const {
  RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES,
  verifyResetOriginalLeagueBootstrapContinuity,
} = require("../src/infrastructure/migration/verifyResetOriginalLeagueBootstrapContinuity");
const {
  RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES,
  verifyResetOriginalLeagueMigrationReportCommit,
} = require("../src/infrastructure/migration/verifyResetOriginalLeagueMigrationReportCommit");
const {
  createSqliteMigrationReportRepository,
} = require("../src/infrastructure/persistence/sqlite/SqliteMigrationReportRepository");
const {
  createSqliteRepositoryContext,
} = require("../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  createSecureRandom,
} = require("../src/infrastructure/security/createSecureRandom");
const {
  createSystemClock,
} = require("../src/infrastructure/security/createSystemClock");
const {
  protectedConfiguration,
  verifiedPersistentRoot,
} = require("./bootstrap-reset-original-league");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS = 60_000;
const RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES =
  Object.freeze({
    argumentInvalid:
      "RESET_MIGRATION_REPORT_COMMAND_ARGUMENT_INVALID",
    commandFailed:
      "RESET_MIGRATION_REPORT_COMMAND_FAILED",
    stateInvalid:
      "RESET_MIGRATION_REPORT_COMMAND_STATE_INVALID",
  });
const SAFE_ERROR_CODES = new Set([
  ...Object.values(
    RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
  ),
  ...Object.values(
    RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
  ),
  ...Object.values(
    RESET_IMPORT_ARTIFACT_ERROR_CODES
  ),
  ...Object.values(
    RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
  ),
  ...Object.values(
    RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
  ),
]);

class ResetMigrationReportCommandError
  extends Error {
  constructor(code, options = {}) {
    super(
      "The reset migration report command failed safely.",
      options
    );
    this.name =
      "ResetMigrationReportCommandError";
    this.code = code;
  }
}

function fail(code, options) {
  throw new ResetMigrationReportCommandError(
    code,
    options
  );
}

function configureResetMigrationReportBusyTimeout(database) {
  if (!database || typeof database.pragma !== "function") {
    fail(
      RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
        .stateInvalid
    );
  }
  try {
    database.pragma(
      `busy_timeout = ${RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS}`
    );
    const configured = database.pragma("busy_timeout", {
      simple: true,
    });
    if (
      configured !==
      RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS
    ) {
      fail(
        RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
          .stateInvalid
      );
    }
    return configured;
  } catch (error) {
    if (error instanceof ResetMigrationReportCommandError) {
      throw error;
    }
    fail(
      RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
        .stateInvalid,
      { cause: error }
    );
  }
}

function parseArguments(argv) {
  const optionNames = new Map([
    ["--app-env", "appEnv"],
    ["--confirm-app-env", "confirmedAppEnv"],
    ["--database", "databasePath"],
    ["--migrations", "migrationsDirectory"],
    ["--persistent-root", "persistentRoot"],
    ["--descriptor", "descriptorPath"],
    ["--source-bundle", "sourceBundleDirectory"],
    ["--reset-manifest", "resetManifestPath"],
    ["--import-report", "importReportPath"],
    ["--artifact", "artifactDirectory"],
    ["--operating-mode", "operatingMode"],
    ["--database-resource-id", "databaseResourceId"],
    ["--source-bundle-id", "sourceBundleId"],
    ["--verification-hash", "verificationHash"],
    ["--bootstrap-user-id", "bootstrapUserId"],
    ["--league-id", "leagueId"],
    ["--season-id", "seasonId"],
    ["--confirmation", "confirmation"],
  ]);
  if (
    !Array.isArray(argv) ||
    argv.length !== optionNames.size * 2
  ) {
    fail(
      RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
        .argumentInvalid
    );
  }
  const options = {};
  for (
    let index = 0;
    index < argv.length;
    index += 2
  ) {
    const name = optionNames.get(argv[index]);
    const value = argv[index + 1];
    if (
      !name ||
      Object.hasOwn(options, name) ||
      typeof value !== "string" ||
      value.length < 1 ||
      value !== value.trim() ||
      value.startsWith("--")
    ) {
      fail(
        RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
          .argumentInvalid
      );
    }
    options[name] = value;
  }
  if (
    options.appEnv !== "staging" ||
    options.confirmedAppEnv !== "staging" ||
    options.operatingMode !== "OFFSEASON_RESET" ||
    options.confirmation !==
      RESET_ORIGINAL_LEAGUE_REPORT_COMMIT_CONFIRMATION ||
    !UUID_PATTERN.test(options.bootstrapUserId) ||
    !UUID_PATTERN.test(options.leagueId) ||
    !UUID_PATTERN.test(options.seasonId) ||
    !DIGEST_PATTERN.test(options.verificationHash)
  ) {
    fail(
      RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
        .argumentInvalid
    );
  }
  for (const field of [
    "artifactDirectory",
    "databasePath",
    "descriptorPath",
    "importReportPath",
    "migrationsDirectory",
    "persistentRoot",
    "resetManifestPath",
    "sourceBundleDirectory",
  ]) {
    if (!path.isAbsolute(options[field])) {
      fail(
        RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
          .argumentInvalid
      );
    }
  }
  return Object.freeze({ ...options });
}

function continuityOptions({
  artifact,
  database,
  options,
  protectedValues,
}) {
  return {
    appEnvironment: options.appEnv,
    artifactDirectory:
      options.artifactDirectory,
    bootstrapAdministratorIdentity:
      protectedValues.administratorIdentity,
    bootstrapUserId: options.bootstrapUserId,
    database,
    databasePath: options.databasePath,
    databaseResourceId:
      options.databaseResourceId,
    descriptorPath: options.descriptorPath,
    encodedDeliveryKey:
      protectedValues.encodedDeliveryKey,
    importReportPath: options.importReportPath,
    leagueId: options.leagueId,
    leagueName: protectedValues.leagueName,
    migrationsDirectory:
      options.migrationsDirectory,
    operatingMode: options.operatingMode,
    publicFrontendOrigin:
      protectedValues.publicFrontendOrigin,
    resetManifestPath:
      options.resetManifestPath,
    seasonId: options.seasonId,
    sourceBundleDirectory:
      options.sourceBundleDirectory,
    sourceBundleId: options.sourceBundleId,
    verificationHash:
      options.verificationHash,
  };
}

function runResetMigrationReportCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  let protectedValues;
  try {
    protectedValues = protectedConfiguration(env);
  } catch (error) {
    fail(
      RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
        .argumentInvalid,
      { cause: error }
    );
  }
  const descriptor =
    loadAndValidateStagingDescriptor({
      descriptorPath: options.descriptorPath,
    });
  const persistentRoot =
    verifiedPersistentRoot({
      descriptor,
      suppliedRoot: options.persistentRoot,
    });
  const artifact =
    readResetImportVerificationArtifact({
      artifactDirectory:
        options.artifactDirectory,
      descriptorPath: options.descriptorPath,
      sourceBundleDirectory:
        options.sourceBundleDirectory,
      databasePath: options.databasePath,
      resetManifestPath:
        options.resetManifestPath,
      importReportPath:
        options.importReportPath,
      operatingMode: options.operatingMode,
    });
  if (
    artifact.binding.databaseResourceId !==
      options.databaseResourceId ||
    artifact.binding.sourceBundleId !==
      options.sourceBundleId ||
    artifact.binding.verificationHash !==
      options.verificationHash
  ) {
    fail(
      RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
        .argumentInvalid
    );
  }

  let connection = openDatabase({
    databasePath: options.databasePath,
    environment: "staging",
    persistentRoot,
    requirePersistentRoot: true,
  });
  let committed = null;
  let replayed;
  try {
    configureResetMigrationReportBusyTimeout(
      connection.database
    );
    assertMigrationCompatibility(
      connection.database,
      discoverMigrations({
        migrationsDirectory:
          options.migrationsDirectory,
      })
    );
    const verificationOptions =
      continuityOptions({
        artifact,
        database: connection.database,
        options,
        protectedValues,
      });
    const repositoryContext =
      createSqliteRepositoryContext({
        database: connection.database,
      });
    const commitService =
      createResetMigrationReportCommitService({
        database: connection.database,
        repositoryContext,
        migrationReportRepository:
          createSqliteMigrationReportRepository({
            database: connection.database,
          }),
        verifyContinuity: () =>
          verifyResetOriginalLeagueBootstrapContinuity(
            verificationOptions
          ),
        clock: createSystemClock(),
        secureRandom: createSecureRandom(),
      });
    repositoryContext.transaction(() => {
      const reportCount =
        connection.database.prepare(
          "SELECT COUNT(*) AS count " +
            "FROM migration_reports"
        ).get().count;
      if (reportCount === 1) {
        replayed = true;
        return;
      }
      if (reportCount !== 0) {
        fail(
          RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
            .stateInvalid
        );
      }
      committed = commitService.commit({});
      replayed = false;
    });
  } finally {
    if (connection.database.open) {
      connection.database.close();
    }
  }

  connection = openDatabase({
    databasePath: options.databasePath,
    environment: "staging",
    persistentRoot,
    requirePersistentRoot: true,
  });
  let verified;
  try {
    configureResetMigrationReportBusyTimeout(
      connection.database
    );
    verified =
      verifyResetOriginalLeagueMigrationReportCommit(
        continuityOptions({
          artifact,
          database: connection.database,
          options,
          protectedValues,
        })
      );
    if (
      committed &&
      (
        committed.migrationReportId !==
          verified.migrationReportId ||
        committed.bootstrapStateHash !==
          verified.bootstrapStateHash ||
        committed.reportRowHash !==
          verified.reportRowHash ||
        committed.startedAtMs !==
          verified.startedAtMs ||
        committed.completedAtMs !==
          verified.completedAtMs ||
        committed.createdAtMs !==
          verified.createdAtMs
      )
    ) {
      fail(
        RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
          .stateInvalid
      );
    }
  } finally {
    if (connection.database.open) {
      connection.database.close();
    }
  }

  const summary = Object.freeze({
    status: "completed",
    replayed,
    code:
      "RESET_ORIGINAL_LEAGUE_MIGRATION_REPORT_COMMITTED",
    migrationReportId:
      verified.migrationReportId,
    leagueId: verified.leagueId,
    seasonId: verified.seasonId,
    databaseSchemaVersion:
      verified.databaseSchemaVersion,
    sourceBundleId: verified.sourceBundleId,
    resetManifestId: verified.resetManifestId,
    startedAtMs: verified.startedAtMs,
    completedAtMs: verified.completedAtMs,
    createdAtMs: verified.createdAtMs,
    verificationHash:
      verified.verificationHash,
    stagingDescriptorSha256:
      verified.stagingDescriptorSha256,
    databaseResourceId:
      verified.databaseResourceId,
    bootstrapStateHash:
      verified.bootstrapStateHash,
    reportRowHash: verified.reportRowHash,
    postCommitHash: verified.postCommitHash,
  });
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runResetMigrationReportCommand();
  } catch (error) {
    const code = SAFE_ERROR_CODES.has(error?.code)
      ? error.code
      : RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
          .commandFailed;
    console.error(JSON.stringify({
      error: {
        code,
        message:
          "Reset migration report commit failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS,
  RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES,
  ResetMigrationReportCommandError,
  configureResetMigrationReportBusyTimeout,
  continuityOptions,
  parseArguments,
  runResetMigrationReportCommand,
};
