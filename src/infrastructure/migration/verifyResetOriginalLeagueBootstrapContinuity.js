const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  validateAccountIdentity,
} = require("../../domain/accounts/accountRegistrationPolicy");
const {
  validateLeagueCreationInput,
} = require("../../domain/leagues/leagueCreationPolicy");
const {
  resetOriginalLeagueBootstrapRequestHash,
} = require("../../domain/leagues/resetOriginalLeagueBootstrapPolicy");
const {
  applyMigrations,
  discoverMigrations,
} = require("../database/migrate");
const {
  openDatabase,
} = require("../database/connection");
const {
  createSqliteRepositoryContext,
} = require("../persistence/sqlite/createSqliteRepositoryContext");
const {
  createSqliteResetOriginalLeagueBootstrapRepository,
} = require("../persistence/sqlite/SqliteResetOriginalLeagueBootstrapRepository");
const {
  createActionTokenDeliveryEnvelope,
} = require("../security/createActionTokenDeliveryEnvelope");
const {
  createOpaqueActionTokens,
} = require("../security/createOpaqueActionTokens");
const {
  createSecureRandom,
} = require("../security/createSecureRandom");
const {
  canonicalize,
} = require("./sourceInventory");
const {
  readResetImportVerificationArtifact,
} = require("./resetImportVerificationArtifact");

const RESET_ORIGINAL_LEAGUE_CONTINUITY_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const VERIFIED_CONTINUITIES = new WeakMap();
const RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES =
  Object.freeze({
    argumentInvalid:
      "RESET_ORIGINAL_LEAGUE_CONTINUITY_ARGUMENT_INVALID",
    artifactInvalid:
      "RESET_ORIGINAL_LEAGUE_CONTINUITY_ARTIFACT_INVALID",
    databaseIdentityMismatch:
      "RESET_ORIGINAL_LEAGUE_CONTINUITY_DATABASE_IDENTITY_MISMATCH",
    schemaMismatch:
      "RESET_ORIGINAL_LEAGUE_CONTINUITY_SCHEMA_MISMATCH",
    verificationFailed:
      "RESET_ORIGINAL_LEAGUE_CONTINUITY_VERIFICATION_FAILED",
  });

class ResetOriginalLeagueContinuityError
  extends Error {
  constructor(code, options = {}) {
    super(
      "The reset original-league bootstrap continuity verification failed.",
      options
    );
    this.name =
      "ResetOriginalLeagueContinuityError";
    this.code = code;
  }
}

function fail(code, options) {
  throw new ResetOriginalLeagueContinuityError(
    code,
    options
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, keys) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(
      (key) => !keys.includes(key)
    )
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .argumentInvalid
    );
  }
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function schemaProjection(database) {
  return database.prepare(
    "SELECT type, name, tbl_name AS tableName, sql " +
      "FROM sqlite_schema " +
      "ORDER BY type ASC, name ASC, tbl_name ASC"
  ).all();
}

function schemaFingerprint(database) {
  return sha256(
    canonicalize(schemaProjection(database))
  );
}

function trustedSchemaFingerprint({
  expectedMigrationLedger,
  expectedUserVersion,
  migrationsDirectory,
}) {
  if (
    !Array.isArray(expectedMigrationLedger) ||
    !Number.isSafeInteger(expectedUserVersion) ||
    expectedUserVersion < 1
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .schemaMismatch
    );
  }
  let canonicalMigrationsDirectory;
  let requestedMigrationsDirectory;
  let migrations;
  try {
    canonicalMigrationsDirectory =
      fs.realpathSync.native(
        path.resolve(
          __dirname,
          "..",
          "..",
          "..",
          "database",
          "migrations"
        )
      );
    requestedMigrationsDirectory =
      fs.realpathSync.native(
        migrationsDirectory
      );
    if (
      requestedMigrationsDirectory !==
      canonicalMigrationsDirectory
    ) {
      fail(
        RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
          .schemaMismatch
      );
    }
    migrations = discoverMigrations({
      migrationsDirectory:
        requestedMigrationsDirectory,
    });
  } catch (error) {
    if (
      error instanceof
      ResetOriginalLeagueContinuityError
    ) {
      throw error;
    }
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .schemaMismatch,
      { cause: error }
    );
  }
  const discoveredLedger = migrations.map(
    ({ id, fileName, checksum }) => ({
      id,
      fileName,
      checksum,
    })
  );
  if (
    canonicalize(discoveredLedger) !==
    canonicalize(expectedMigrationLedger)
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .schemaMismatch
    );
  }
  let expected;
  let reconstructionDirectory;
  try {
    reconstructionDirectory = fs.mkdtempSync(
      path.join(
        fs.realpathSync.native(os.tmpdir()),
        "hundo-fad04-schema-"
      )
    );
    expected = openDatabase({
      databasePath: path.join(
        reconstructionDirectory,
        "trusted-schema.sqlite3"
      ),
      environment: "test",
    }).database;
    applyMigrations({
      database: expected,
      migrations,
      applicationBuildId:
        "fad-04-continuity-schema-reconstruction",
      now: () => 0,
    });
    const reconstructedLedger =
      expected.prepare(
        "SELECT migration_id AS id, " +
          "file_name AS fileName, checksum " +
          "FROM schema_migrations " +
          "ORDER BY migration_id ASC"
      ).all();
    if (
      expected.pragma("user_version", {
        simple: true,
      }) !== expectedUserVersion ||
      canonicalize(reconstructedLedger) !==
        canonicalize(expectedMigrationLedger)
    ) {
      fail(
        RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
          .schemaMismatch
      );
    }
    return schemaFingerprint(expected);
  } finally {
    if (expected?.open) expected.close();
    if (reconstructionDirectory) {
      fs.rmSync(reconstructionDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}

function physicalDatabasePath({
  database,
  databasePath,
  fsModule = fs,
}) {
  try {
    if (
      !database ||
      typeof database.prepare !== "function" ||
      typeof database.pragma !== "function" ||
      typeof database.exec !== "function" ||
      typeof database.transaction !== "function" ||
      database.open !== true ||
      database.memory === true ||
      database.readonly !== false ||
      typeof database.name !== "string" ||
      !path.isAbsolute(database.name) ||
      !path.isAbsolute(databasePath)
    ) {
      fail(
        RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
          .databaseIdentityMismatch
      );
    }
    const opened = fsModule.realpathSync.native(
      database.name
    );
    const bound = fsModule.realpathSync.native(
      databasePath
    );
    if (path.relative(opened, bound) !== "") {
      fail(
        RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
          .databaseIdentityMismatch
      );
    }
    return opened;
  } catch (error) {
    if (
      error instanceof
      ResetOriginalLeagueContinuityError
    ) {
      throw error;
    }
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .databaseIdentityMismatch,
      { cause: error }
    );
  }
}

function createDeliveryAuthenticator({
  encodedDeliveryKey,
  publicFrontendOrigin,
}) {
  if (
    typeof encodedDeliveryKey !== "string" ||
    encodedDeliveryKey.length < 1 ||
    typeof publicFrontendOrigin !== "string"
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .argumentInvalid
    );
  }
  let origin;
  try {
    origin = new URL(publicFrontendOrigin);
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .argumentInvalid,
      { cause: error }
    );
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== publicFrontendOrigin ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .argumentInvalid
    );
  }
  let delivery;
  let opaqueTokens;
  try {
    const secureRandom = createSecureRandom();
    delivery = createActionTokenDeliveryEnvelope({
      encodedKey: encodedDeliveryKey,
      keyVersion: 1,
      secureRandom,
    });
    opaqueTokens = createOpaqueActionTokens({
      secureRandom,
    });
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .argumentInvalid,
      { cause: error }
    );
  }
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

function deepFreeze(value) {
  if (
    value &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function verifyResetOriginalLeagueBootstrapState(
  options,
  assertionMethod
) {
  if (
    ![
      "assertCompletedBootstrapState",
      "assertCompletedBootstrapStateAfterMigrationReport",
    ].includes(assertionMethod)
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .argumentInvalid
    );
  }
  exactObject(options, [
    "appEnvironment",
    "artifactDirectory",
    "bootstrapAdministratorIdentity",
    "bootstrapUserId",
    "database",
    "databasePath",
    "databaseResourceId",
    "descriptorPath",
    "encodedDeliveryKey",
    "importReportPath",
    "leagueId",
    "leagueName",
    "migrationsDirectory",
    "operatingMode",
    "publicFrontendOrigin",
    "resetManifestPath",
    "seasonId",
    "sourceBundleDirectory",
    "sourceBundleId",
    "verificationHash",
  ]);
  for (const field of [
    "artifactDirectory",
    "databasePath",
    "descriptorPath",
    "importReportPath",
    "migrationsDirectory",
    "resetManifestPath",
    "sourceBundleDirectory",
  ]) {
    if (
      typeof options[field] !== "string" ||
      !path.isAbsolute(options[field])
    ) {
      fail(
        RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
          .argumentInvalid
      );
    }
  }
  if (
    options.appEnvironment !== "staging" ||
    options.operatingMode !== "OFFSEASON_RESET" ||
    !UUID_PATTERN.test(
      options.bootstrapUserId || ""
    ) ||
    !UUID_PATTERN.test(options.leagueId || "") ||
    !UUID_PATTERN.test(options.seasonId || "") ||
    typeof options.databaseResourceId !==
      "string" ||
    typeof options.sourceBundleId !== "string" ||
    !DIGEST_PATTERN.test(
      options.verificationHash || ""
    )
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .argumentInvalid
    );
  }
  physicalDatabasePath({
    database: options.database,
    databasePath: options.databasePath,
  });

  let artifact;
  try {
    artifact =
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
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .artifactInvalid,
      { cause: error }
    );
  }
  if (
    artifact.binding.databaseResourceId !==
      options.databaseResourceId ||
    artifact.binding.sourceBundleId !==
      options.sourceBundleId ||
    artifact.binding.verificationHash !==
      options.verificationHash
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .artifactInvalid
    );
  }
  let league;
  let bootstrapAdministratorIdentity;
  let requestHash;
  try {
    bootstrapAdministratorIdentity =
      validateAccountIdentity(
        options.bootstrapAdministratorIdentity
      );
    league = validateLeagueCreationInput({
      name: options.leagueName,
    });
    requestHash =
      resetOriginalLeagueBootstrapRequestHash({
        bootstrapUserId:
          options.bootstrapUserId,
        databaseResourceId:
          options.databaseResourceId,
        leagueNameNormalized:
          league.nameNormalized,
        sourceBundleId: options.sourceBundleId,
        stagingDescriptorSha256:
          artifact.binding
            .stagingDescriptorSha256,
        verificationHash:
          options.verificationHash,
      });
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .argumentInvalid,
      { cause: error }
    );
  }

  let expectedSchemaHash;
  try {
    expectedSchemaHash = trustedSchemaFingerprint({
      expectedMigrationLedger:
        artifact.payload.verification.database
          .migrationLedger,
      expectedUserVersion:
        artifact.payload.verification.database
          .userVersion,
      migrationsDirectory:
        options.migrationsDirectory,
    });
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .schemaMismatch,
      { cause: error }
    );
  }

  let state;
  try {
    const repositoryContext =
      createSqliteRepositoryContext({
        database: options.database,
      });
    const bootstrapRepository =
      createSqliteResetOriginalLeagueBootstrapRepository({
        database: options.database,
      });
    const authenticateDelivery =
      createDeliveryAuthenticator({
        encodedDeliveryKey:
          options.encodedDeliveryKey,
        publicFrontendOrigin:
          options.publicFrontendOrigin,
      });
    state = repositoryContext.transaction(
      () => {
        if (
          options.database.inTransaction !== true ||
          schemaFingerprint(options.database) !==
            expectedSchemaHash
        ) {
          fail(
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .schemaMismatch
          );
        }
        return bootstrapRepository[
          assertionMethod
        ]({
            authenticateDelivery,
            binding: {
              leagueId: options.leagueId,
              leagueName: league.name,
              leagueNameNormalized:
                league.nameNormalized,
              requestHash,
              seasonId: options.seasonId,
              verificationHash:
                options.verificationHash,
            },
            expectedAdministratorIdentity:
              bootstrapAdministratorIdentity,
            expectedMigrationLedger:
              artifact.payload.verification.database
                .migrationLedger,
            expectedContinuityBaseline:
              artifact.payload
                .continuityBaseline,
            expectedTargetTables:
              artifact.payload.verification.database
                .targetTables,
            expectedUserId:
              options.bootstrapUserId,
            pristineState: null,
          });
      }
    );
  } catch (error) {
    if (
      error instanceof
      ResetOriginalLeagueContinuityError
    ) {
      throw error;
    }
    if (
      error?.cause instanceof
      ResetOriginalLeagueContinuityError
    ) {
      throw error.cause;
    }
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .verificationFailed,
      { cause: error }
    );
  }

  const safeEvidence = deepFreeze({
    actorUserId: state.actorUserId,
    databaseResourceId:
      artifact.binding.databaseResourceId,
    leagueId: state.leagueId,
    schemaFingerprint: expectedSchemaHash,
    schemaVersion: state.schemaVersion,
    seasonId: state.seasonId,
    sourceBundleId:
      artifact.binding.sourceBundleId,
    stagingDescriptorSha256:
      artifact.binding
        .stagingDescriptorSha256,
    stateHash: state.stateHash,
    verificationHash:
      artifact.binding.verificationHash,
    verificationVersion:
      RESET_ORIGINAL_LEAGUE_CONTINUITY_VERSION,
  });
  const result = {
    ...safeEvidence,
    continuityHash: sha256(
      canonicalize(safeEvidence)
    ),
    status: "verified",
  };
  Object.defineProperty(
    result,
    "migrationReportProjection",
    {
      configurable: false,
      enumerable: false,
      value:
        artifact.migrationReportProjection,
      writable: false,
    }
  );
  Object.freeze(result);
  return result;
}

function verifyResetOriginalLeagueBootstrapContinuity(
  options
) {
  const callerTransactionActive =
    options?.database?.inTransaction === true;
  const result =
    verifyResetOriginalLeagueBootstrapState(
      options,
      "assertCompletedBootstrapState"
    );
  let transactionSavepoint = null;
  if (callerTransactionActive) {
    transactionSavepoint =
      "fad04_continuity_" +
      crypto.randomBytes(16).toString("hex");
    try {
      options.database.exec(
        `SAVEPOINT ${transactionSavepoint}`
      );
    } catch (error) {
      fail(
        RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
          .verificationFailed,
        { cause: error }
      );
    }
  }
  VERIFIED_CONTINUITIES.set(
    result,
    {
      callerTransactionActive,
      consumed: false,
      dataVersion: options.database.pragma(
        "data_version",
        { simple: true }
      ),
      database: options.database,
      migrationReportProjection:
        result.migrationReportProjection,
      schemaVersion: options.database.pragma(
        "schema_version",
        { simple: true }
      ),
      totalChanges:
        options.database.prepare(
          "SELECT total_changes() AS count"
        ).get().count,
      transactionSavepoint,
    }
  );
  return result;
}

function verifyResetOriginalLeagueBootstrapStateAfterMigrationReport(
  options
) {
  return verifyResetOriginalLeagueBootstrapState(
    options,
    "assertCompletedBootstrapStateAfterMigrationReport"
  );
}

function isVerifiedResetOriginalLeagueContinuity(
  value
) {
  return (
    value !== null &&
    (typeof value === "object" ||
      typeof value === "function") &&
    VERIFIED_CONTINUITIES.has(value)
  );
}

function readResetOriginalLeagueContinuityCommitProjection(
  options
) {
  exactObject(options, [
    "continuity",
    "database",
  ]);
  const verified =
    VERIFIED_CONTINUITIES.get(
      options.continuity
    );
  if (
    !verified ||
    verified.database !== options.database ||
    verified.callerTransactionActive !== true ||
    verified.consumed === true ||
    options.database?.inTransaction !== true ||
    options.database.pragma(
      "data_version",
      { simple: true }
    ) !== verified.dataVersion ||
    options.database.pragma(
      "schema_version",
      { simple: true }
    ) !== verified.schemaVersion ||
    options.database.prepare(
      "SELECT total_changes() AS count"
    ).get().count !== verified.totalChanges
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
      .verificationFailed
    );
  }
  try {
    options.database.exec(
      `RELEASE SAVEPOINT ${verified.transactionSavepoint}`
    );
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
        .verificationFailed,
      { cause: error }
    );
  }
  verified.consumed = true;
  return verified.migrationReportProjection;
}

module.exports = {
  RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES,
  RESET_ORIGINAL_LEAGUE_CONTINUITY_VERSION,
  ResetOriginalLeagueContinuityError,
  isVerifiedResetOriginalLeagueContinuity,
  createDeliveryAuthenticator,
  readResetOriginalLeagueContinuityCommitProjection,
  schemaFingerprint,
  schemaProjection,
  trustedSchemaFingerprint,
  verifyResetOriginalLeagueBootstrapContinuity,
  verifyResetOriginalLeagueBootstrapStateAfterMigrationReport,
};
