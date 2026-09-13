#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const {
  createResetOriginalLeagueBootstrapService,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES,
} = require("../src/application/services/leagues/createResetOriginalLeagueBootstrapService");
const {
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION,
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
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID,
  createSqliteResetOriginalLeagueBootstrapRepository,
} = require("../src/infrastructure/persistence/sqlite/SqliteResetOriginalLeagueBootstrapRepository");
const {
  createSqliteLeagueCreationRepository,
} = require("../src/infrastructure/persistence/sqlite/SqliteLeagueCreationRepository");
const {
  createSqliteRepositoryContext,
} = require("../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  createSqliteSecurityAuditRepository,
} = require("../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const {
  createActionTokenDeliveryEnvelope,
} = require("../src/infrastructure/security/createActionTokenDeliveryEnvelope");
const {
  createOpaqueActionTokens,
} = require("../src/infrastructure/security/createOpaqueActionTokens");
const {
  createSecureRandom,
} = require("../src/infrastructure/security/createSecureRandom");
const {
  createSystemClock,
} = require("../src/infrastructure/security/createSystemClock");

const RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES =
  Object.freeze({
    argumentInvalid:
      "RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ARGUMENT_INVALID",
    commandFailed:
      "RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_FAILED",
  });
const SAFE_ERROR_CODES = new Set([
  ...Object.values(
    RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES
  ),
  ...Object.values(
    RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
  ),
  ...Object.values(
    RESET_IMPORT_ARTIFACT_ERROR_CODES
  ),
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID,
]);

class ResetOriginalLeagueBootstrapCommandArgumentError
  extends Error {
  constructor(options = {}) {
    super(
      "The reset original-league bootstrap command arguments are invalid.",
      options
    );
    this.name =
      "ResetOriginalLeagueBootstrapCommandArgumentError";
    this.code =
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES
        .argumentInvalid;
  }
}

function argumentInvalid(options) {
  throw new ResetOriginalLeagueBootstrapCommandArgumentError(
    options
  );
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
    ["--confirmation", "confirmation"],
  ]);
  if (
    !Array.isArray(argv) ||
    argv.length !== optionNames.size * 2
  ) {
    argumentInvalid();
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
      argumentInvalid();
    }
    options[name] = value;
  }
  if (
    options.appEnv !== "staging" ||
    options.confirmedAppEnv !== "staging" ||
    options.operatingMode !== "OFFSEASON_RESET" ||
    options.confirmation !==
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION
  ) {
    argumentInvalid();
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
      argumentInvalid();
    }
  }
  return Object.freeze({ ...options });
}

function protectedConfiguration(env) {
  if (
    !env ||
    typeof env.BOOTSTRAP_RESET_LEAGUE_NAME !==
      "string" ||
    env.BOOTSTRAP_RESET_LEAGUE_NAME.length < 1 ||
    typeof env.BOOTSTRAP_ADMIN_EMAIL !==
      "string" ||
    env.BOOTSTRAP_ADMIN_EMAIL.length < 1 ||
    typeof env.BOOTSTRAP_ADMIN_DISPLAY_NAME !==
      "string" ||
    env.BOOTSTRAP_ADMIN_DISPLAY_NAME.length < 1 ||
    typeof env.ACTION_TOKEN_DELIVERY_KEY !==
      "string" ||
    env.ACTION_TOKEN_DELIVERY_KEY.length < 1 ||
    typeof env.PUBLIC_FRONTEND_ORIGIN !==
      "string"
  ) {
    argumentInvalid();
  }
  let origin;
  try {
    origin = new URL(env.PUBLIC_FRONTEND_ORIGIN);
  } catch (error) {
    argumentInvalid({ cause: error });
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !==
      env.PUBLIC_FRONTEND_ORIGIN ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    argumentInvalid();
  }
  return Object.freeze({
    administratorIdentity: Object.freeze({
      displayName:
        env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
      email: env.BOOTSTRAP_ADMIN_EMAIL,
    }),
    encodedDeliveryKey:
      env.ACTION_TOKEN_DELIVERY_KEY,
    leagueName:
      env.BOOTSTRAP_RESET_LEAGUE_NAME,
    publicFrontendOrigin:
      env.PUBLIC_FRONTEND_ORIGIN,
  });
}

function verifiedPersistentRoot({
  descriptor,
  suppliedRoot,
  fsModule = fs,
}) {
  try {
    const suppliedPath = path.resolve(suppliedRoot);
    const suppliedStat =
      fsModule.lstatSync(suppliedPath);
    const suppliedPhysical =
      fsModule.realpathSync.native(suppliedPath);
    const descriptorPhysical =
      fsModule.realpathSync.native(
        descriptor.paths.persistentRoot
      );
    if (
      !suppliedStat.isDirectory() ||
      suppliedStat.isSymbolicLink() ||
      path.relative(
        suppliedPath,
        suppliedPhysical
      ) !== "" ||
      path.relative(
        suppliedPhysical,
        descriptorPhysical
      ) !== ""
    ) {
      argumentInvalid();
    }
    return suppliedPhysical;
  } catch (error) {
    if (
      error instanceof
      ResetOriginalLeagueBootstrapCommandArgumentError
    ) {
      throw error;
    }
    argumentInvalid({ cause: error });
  }
}

function createDeliveryAuthenticator({
  encodedDeliveryKey,
  publicFrontendOrigin,
  secureRandom,
}) {
  const delivery =
    createActionTokenDeliveryEnvelope({
      encodedKey: encodedDeliveryKey,
      keyVersion: 1,
      secureRandom,
    });
  const opaqueTokens = createOpaqueActionTokens({
    secureRandom,
  });
  return function authenticateDelivery({
    outbox,
    payload,
    token,
    user,
  }) {
    const opened = delivery.open({
      envelope: payload.envelope,
      binding: {
        outboxEventId: outbox.id,
        publicFrontendOrigin,
        purpose: payload.purpose,
        tokenId: token.id,
        userId: user.id,
      },
    });
    return opaqueTokens.matches(
      opened.rawToken,
      token.token_digest
    );
  };
}

function runResetOriginalLeagueBootstrapCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  const protectedValues =
    protectedConfiguration(env);
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
  const connection = openDatabase({
    databasePath: options.databasePath,
    environment: "staging",
    persistentRoot,
    requirePersistentRoot: true,
  });
  let summary;
  try {
    assertMigrationCompatibility(
      connection.database,
      discoverMigrations({
        migrationsDirectory:
          options.migrationsDirectory,
      })
    );
    const secureRandom = createSecureRandom();
    const service =
      createResetOriginalLeagueBootstrapService({
        repositoryContext:
          createSqliteRepositoryContext({
            database: connection.database,
          }),
        bootstrapRepository:
          createSqliteResetOriginalLeagueBootstrapRepository({
            database: connection.database,
          }),
        leagueCreationRepository:
          createSqliteLeagueCreationRepository({
            database: connection.database,
          }),
        auditRepository:
          createSqliteSecurityAuditRepository({
            database: connection.database,
          }),
        authenticateDelivery:
          createDeliveryAuthenticator({
            encodedDeliveryKey:
              protectedValues
                .encodedDeliveryKey,
            publicFrontendOrigin:
              protectedValues
                .publicFrontendOrigin,
            secureRandom,
          }),
        clock: createSystemClock(),
        secureRandom,
      });
    const result = service.bootstrap({
      appEnvironment: options.appEnv,
      artifact,
      bootstrapAdministratorIdentity:
        protectedValues
          .administratorIdentity,
      bootstrapUserId:
        options.bootstrapUserId,
      confirmation: options.confirmation,
      databaseResourceId:
        options.databaseResourceId,
      leagueName: protectedValues.leagueName,
      operatingMode: options.operatingMode,
      sourceBundleId: options.sourceBundleId,
      verificationHash:
        options.verificationHash,
    });
    summary = Object.freeze({
      status: "completed",
      replayed: result.replayed,
      code: result.code,
      actorUserId: result.actorUserId,
      leagueId: result.leagueId,
      seasonId: result.seasonId,
      schemaVersion: result.schemaVersion,
      stateHash: result.stateHash,
      verificationHash:
        artifact.binding.verificationHash,
      stagingDescriptorSha256:
        artifact.binding
          .stagingDescriptorSha256,
      databaseResourceId:
        artifact.binding.databaseResourceId,
      sourceBundleId:
        artifact.binding.sourceBundleId,
    });
  } finally {
    connection.database.close();
  }
  output.log(JSON.stringify(summary));
  return summary;
}

function main() {
  try {
    runResetOriginalLeagueBootstrapCommand();
  } catch (error) {
    const code = SAFE_ERROR_CODES.has(error?.code)
      ? error.code
      : RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES
          .commandFailed;
    console.error(JSON.stringify({
      error: {
        code,
        message:
          "Reset original-league bootstrap failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES,
  ResetOriginalLeagueBootstrapCommandArgumentError,
  createDeliveryAuthenticator,
  parseArguments,
  protectedConfiguration,
  runResetOriginalLeagueBootstrapCommand,
  verifiedPersistentRoot,
};
