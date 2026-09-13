const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  openDatabase,
} = require("../database/connection");
const {
  descriptorSha256,
  loadAndValidateStagingDescriptor,
} = require("../database/stagingEnvironment");
const {
  migrateDatabase,
  readAppliedMigrations,
} = require("../database/migrate");
const {
  createSqliteRepositoryContext,
} = require("../persistence/sqlite/createSqliteRepositoryContext");
const {
  finalizeImportReport,
  publishImportReport,
} = require("./importReport");
const {
  JSON_IMPORT_ERROR_CODES,
  JSON_IMPORTER_VERSION,
  JsonImportError,
  assertResetReconciliation,
  buildNeverImportReport,
  buildProtectedReport,
  tableSemanticHash,
} = require("./runJsonImport");
const {
  loadAndValidateResetManifest,
} = require("./resetManifest");
const {
  NHL_PROVIDER,
  adaptVerifiedSourceBundle,
} = require("./sourceShapeAdapters");

const STAGING_IMPORT_BUILD_ID = "m2-12-staging-import-v1";

function importError(code, message, options) {
  return new JsonImportError(code, message, options);
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function pathsOverlap(firstPath, secondPath) {
  const first = path.resolve(firstPath);
  const second = path.resolve(secondPath);
  return first === second ||
    isPathInside(first, second) ||
    isPathInside(second, first);
}

function realDirectory(value, name, fsModule) {
  try {
    const physical = fsModule.realpathSync(value);
    if (!fsModule.statSync(physical).isDirectory()) {
      throw new Error(`${name} is not a directory.`);
    }
    return physical;
  } catch (error) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      `${name} must be an existing physical directory.`,
      { cause: error }
    );
  }
}

function physicalNewPath(value, name, fsModule) {
  const resolved = path.resolve(value);
  if (fsModule.existsSync(resolved)) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      `${name} must not already exist.`
    );
  }
  const parent = realDirectory(
    path.dirname(resolved),
    `${name} parent`,
    fsModule
  );
  return path.join(parent, path.basename(resolved));
}

function validateStagingImportPaths({
  descriptor,
  sourceBundleDirectory,
  databasePath,
  reportDirectory,
  repositoryRoot = path.resolve(__dirname, "..", "..", ".."),
  fsModule = fs,
} = {}) {
  if (
    !descriptor ||
    typeof sourceBundleDirectory !== "string" ||
    !path.isAbsolute(sourceBundleDirectory) ||
    typeof databasePath !== "string" ||
    !path.isAbsolute(databasePath) ||
    typeof reportDirectory !== "string" ||
    !path.isAbsolute(reportDirectory)
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.argumentInvalid,
      "Staging import paths must be explicit and absolute."
    );
  }

  const persistentRoot = realDirectory(
    descriptor.paths.persistentRoot,
    "Staging persistent root",
    fsModule
  );
  const sourceRoot = realDirectory(
    descriptor.paths.sourceBundles,
    "Staging source-bundle root",
    fsModule
  );
  const reportRoot = realDirectory(
    descriptor.paths.reports,
    "Staging report root",
    fsModule
  );
  const backupRoot = realDirectory(
    descriptor.paths.backups,
    "Staging backup root",
    fsModule
  );
  const databaseParent = realDirectory(
    path.dirname(descriptor.paths.database),
    "Staging database directory",
    fsModule
  );
  const physicalSource = realDirectory(
    sourceBundleDirectory,
    "Source bundle",
    fsModule
  );
  const physicalDatabase = physicalNewPath(
    databasePath,
    "Staging database",
    fsModule
  );
  const physicalReport = physicalNewPath(
    reportDirectory,
    "Staging report directory",
    fsModule
  );
  const physicalRepository = fsModule.realpathSync(repositoryRoot);

  if (
    pathsOverlap(persistentRoot, physicalRepository) ||
    !isPathInside(persistentRoot, sourceRoot) ||
    !isPathInside(persistentRoot, reportRoot) ||
    !isPathInside(persistentRoot, backupRoot) ||
    !isPathInside(persistentRoot, databaseParent) ||
    !isPathInside(sourceRoot, physicalSource) ||
    !isPathInside(reportRoot, physicalReport) ||
    !isPathInside(persistentRoot, physicalDatabase) ||
    path.resolve(databasePath) !==
      path.resolve(descriptor.paths.database) ||
    pathsOverlap(physicalSource, physicalDatabase) ||
    pathsOverlap(physicalSource, physicalReport) ||
    pathsOverlap(physicalDatabase, physicalReport)
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      "Staging source, database, report, backup, and repository boundaries are not isolated."
    );
  }

  return Object.freeze({
    persistentRoot,
    sourceBundleDirectory: physicalSource,
    databasePath: physicalDatabase,
    reportDirectory: physicalReport,
  });
}

function buildResetOmissions(adapted, manifest) {
  return Object.freeze(
    manifest.omissionFamilies.map((family) =>
      Object.freeze({
        familyId: family.familyId,
        sourceCount: adapted.omissionCounts[family.familyId],
        countTreatment: family.countTreatment,
        targetTreatment: family.targetTreatment,
        validatedTargetRowCount: 0,
        reconciled: true,
      })
    )
  );
}

function buildMoneyAndOwnership(adapted) {
  const totalMoney = adapted.moneyEvidence.reduce(
    (summary, family) => {
      summary.sourceCount += family.sourceCount;
      summary.sourceSumCents += family.sourceSumCents;
      summary.importedCount += family.importedCount;
      summary.importedSumCents += family.importedSumCents;
      summary.omittedCount += family.omittedCount;
      summary.omittedSumCents += family.omittedSumCents;
      summary.reconciled =
        summary.reconciled && family.reconciled;
      return summary;
    },
    {
      sourceCount: 0,
      sourceSumCents: 0,
      importedCount: 0,
      importedSumCents: 0,
      omittedCount: 0,
      omittedSumCents: 0,
      reconciled: true,
    }
  );
  const ownership = Object.freeze({
    sourceCount: adapted.sourceCollectionCounts.roster_entries,
    importedCount: 0,
    omittedCount: adapted.omissionCounts.season_1_rosters,
    duplicateTargetPlayerCount: 0,
    reconciled:
      adapted.sourceCollectionCounts.roster_entries ===
      adapted.omissionCounts.season_1_rosters,
  });
  if (!ownership.reconciled || !totalMoney.reconciled) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.reconciliationFailed,
      "Ownership or money evidence did not reconcile."
    );
  }
  return Object.freeze({
    money: Object.freeze({
      ...totalMoney,
      families: adapted.moneyEvidence,
    }),
    ownership,
  });
}

function stableExternalIdsPreserved(database, adapted) {
  const expected = adapted.rows.player_external_ids
    .map((row) => row.external_value)
    .sort();
  const actual = database
    .prepare(
      "SELECT external_value FROM player_external_ids " +
      "WHERE provider = ? ORDER BY external_value ASC"
    )
    .all(NHL_PROVIDER)
    .map((row) => row.external_value);
  return expected.length === actual.length &&
    expected.every((value, index) => value === actual[index]);
}

function hashFile(filePath, fsModule) {
  return crypto
    .createHash("sha256")
    .update(fsModule.readFileSync(filePath))
    .digest("hex");
}

function removeOwnedDatabaseFiles(databasePath, fsModule) {
  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    try {
      fsModule.rmSync(candidate, { force: true });
    } catch {
      // Preserve the import failure.
    }
  }
}

function normalizeFailure(error) {
  if (
    error instanceof JsonImportError ||
    (typeof error?.code === "string" &&
      error.code.startsWith("IMPORT_"))
  ) {
    return error;
  }
  if (
    typeof error?.code === "string" &&
    error.code.startsWith("STAGING_DESCRIPTOR_")
  ) {
    return importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      "The staging descriptor failed isolation validation.",
      { cause: error }
    );
  }
  if (
    typeof error?.code === "string" &&
    error.code.startsWith("RESET_MANIFEST_")
  ) {
    return importError(
      JSON_IMPORT_ERROR_CODES.manifestInvalid,
      "The reset manifest failed staging-import validation.",
      { cause: error }
    );
  }
  if (
    typeof error?.code === "string" &&
    (error.code.startsWith("INVENTORY_") ||
      error.code.startsWith("IMPORT_ADAPTER_"))
  ) {
    return importError(
      JSON_IMPORT_ERROR_CODES.sourceInvalid,
      "The copied source bundle failed staging-import verification.",
      { cause: error }
    );
  }
  if (
    typeof error?.code === "string" &&
    (error.code.startsWith("REPOSITORY_") ||
      error.code.startsWith("MIGRATION_") ||
      error.code.startsWith("DATABASE_") ||
      error.code.startsWith("SQLITE_"))
  ) {
    return importError(
      JSON_IMPORT_ERROR_CODES.constraintFailed,
      "The staging database rejected the import.",
      { cause: error }
    );
  }
  return importError(
    JSON_IMPORT_ERROR_CODES.reconciliationFailed,
    "The staging import failed safely.",
    { cause: error }
  );
}

function runStagingImport({
  descriptorPath,
  sourceBundleDirectory,
  databasePath,
  resetManifestPath,
  reportDirectory,
  operatingMode,
  repositoryRoot = path.resolve(__dirname, "..", "..", ".."),
  fsModule = fs,
  adaptSourceBundle = adaptVerifiedSourceBundle,
  publishReport = publishImportReport,
} = {}) {
  if (
    operatingMode !== "OFFSEASON_RESET" ||
    typeof descriptorPath !== "string" ||
    descriptorPath.trim() === "" ||
    typeof resetManifestPath !== "string" ||
    resetManifestPath.trim() === ""
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.argumentInvalid,
      "Staging import requires a descriptor, reset manifest, and OFFSEASON_RESET."
    );
  }

  let paths;
  let database;
  let ownsDatabase = false;
  try {
    const descriptor = loadAndValidateStagingDescriptor({
      descriptorPath,
      fsModule,
    });
    paths = validateStagingImportPaths({
      descriptor,
      sourceBundleDirectory,
      databasePath,
      reportDirectory,
      repositoryRoot,
      fsModule,
    });
    const adapted = adaptSourceBundle({
      bundleDirectory: paths.sourceBundleDirectory,
      fsModule,
    });
    const resetManifest = loadAndValidateResetManifest({
      manifestPath: resetManifestPath,
      operatingMode,
      sourceBundleManifestVersion:
        adapted.sourceBundle.manifestVersion,
      fsModule,
    });
    assertResetReconciliation(adapted, resetManifest);
    const protectedFamilies = buildProtectedReport(
      adapted,
      resetManifest
    );
    const neverImportFamilies = buildNeverImportReport(
      adapted,
      resetManifest
    );
    const reconciliation = buildMoneyAndOwnership(adapted);

    const connection = openDatabase({
      databasePath: paths.databasePath,
      environment: "staging",
    });
    database = connection.database;
    ownsDatabase = true;
    const migration = migrateDatabase({
      database,
      migrationsDirectory: path.join(
        repositoryRoot,
        "database",
        "migrations"
      ),
      applicationBuildId: STAGING_IMPORT_BUILD_ID,
      now: () => adapted.sourceBundle.capturedAtMs,
    });
    const repositories =
      createSqliteRepositoryContext({ database });

    const targetTables = [];
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const [tableName, rows] of Object.entries(adapted.rows)) {
        const repository = repositories.getRepository(tableName);
        for (const row of rows) repository.insert(row);
        const validatedRowCount = database
          .prepare(
            `SELECT COUNT(*) AS count FROM "${tableName}"`
          )
          .get().count;
        if (validatedRowCount !== rows.length) {
          throw importError(
            JSON_IMPORT_ERROR_CODES.reconciliationFailed,
            "A staging target table count did not reconcile."
          );
        }
        targetTables.push({
          table: tableName,
          plannedRowCount: rows.length,
          validatedRowCount,
          postRollbackRowCount: null,
          semanticHash: tableSemanticHash(database, tableName),
        });
      }
      if (!stableExternalIdsPreserved(database, adapted)) {
        throw importError(
          JSON_IMPORT_ERROR_CODES.reconciliationFailed,
          "Stable player provider IDs did not reconcile."
        );
      }
      const integrity = database.pragma("integrity_check", {
        simple: true,
      });
      const foreignKeys = database.pragma("foreign_key_check");
      if (integrity !== "ok" || foreignKeys.length !== 0) {
        throw importError(
          JSON_IMPORT_ERROR_CODES.reconciliationFailed,
          "Pre-commit staging integrity validation failed."
        );
      }
      database.exec("COMMIT;");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK;");
      throw error;
    }

    const committedIntegrity = database.pragma("integrity_check", {
      simple: true,
    });
    const committedForeignKeys =
      database.pragma("foreign_key_check");
    for (const target of targetTables) {
      const committedCount = database
        .prepare(
          `SELECT COUNT(*) AS count FROM "${target.table}"`
        )
        .get().count;
      if (
        committedCount !== target.validatedRowCount ||
        tableSemanticHash(database, target.table) !==
          target.semanticHash
      ) {
        throw importError(
          JSON_IMPORT_ERROR_CODES.reconciliationFailed,
          "Committed staging rows changed after the transaction."
        );
      }
      Object.freeze(target);
    }
    if (
      committedIntegrity !== "ok" ||
      committedForeignKeys.length !== 0 ||
      !stableExternalIdsPreserved(database, adapted)
    ) {
      throw importError(
        JSON_IMPORT_ERROR_CODES.reconciliationFailed,
        "Committed staging database verification failed."
      );
    }

    const migrationLedger = readAppliedMigrations(database).map(
      (entry) => Object.freeze({
        id: entry.id,
        fileName: entry.fileName,
        checksum: entry.checksum,
      })
    );
    const userVersion = database.pragma("user_version", {
      simple: true,
    });
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.close();
    database = null;

    const databaseArtifact = Object.freeze({
      sha256: hashFile(paths.databasePath, fsModule),
      bytes: fsModule.statSync(paths.databasePath).size,
    });
    const report = finalizeImportReport({
      importerVersion: JSON_IMPORTER_VERSION,
      status: "valid",
      dryRun: false,
      importedRowsRetained: true,
      environment: "staging",
      stagingDescriptor: Object.freeze({
        descriptorVersion: descriptor.descriptorVersion,
        environment: descriptor.environment,
        resourceIds: descriptor.resourceIds,
        applicationAuthority: descriptor.applicationAuthority,
        sqliteApplicationAuthorityEnabled:
          descriptor.sqliteApplicationAuthorityEnabled,
        productionStorageAccessible:
          descriptor.productionStorageAccessible,
        productionSecretsAccessible:
          descriptor.productionSecretsAccessible,
      }),
      sourceBundle: adapted.sourceBundle,
      resetManifest: Object.freeze({
        id: resetManifest.manifestId,
        version: resetManifest.manifestVersion,
        checksum: resetManifest.checksum,
      }),
      schema: Object.freeze({
        userVersion,
        migrationCount: migration.migrations.length,
        migrationLedger: Object.freeze(migrationLedger),
      }),
      sourceShapes: adapted.sourceShapes,
      sourceCollectionCounts: adapted.sourceCollectionCounts,
      targetTables: Object.freeze(targetTables),
      resetOmissions: buildResetOmissions(
        adapted,
        resetManifest
      ),
      protectedFamilies: Object.freeze(protectedFamilies),
      neverImportFamilies: Object.freeze(neverImportFamilies),
      mappingEntries: adapted.mappings,
      money: reconciliation.money,
      ownership: reconciliation.ownership,
      checks: Object.freeze({
        integrity: committedIntegrity,
        foreignKeyViolationCount: committedForeignKeys.length,
        stablePlayerExternalIdsPreserved: true,
        importedRowsRolledBack: false,
        committedRowsVerified: true,
      }),
      rejects: adapted.rejects,
      quarantine: adapted.quarantine,
      repairs: adapted.repairs,
      defaults: adapted.defaults,
      warnings: adapted.warnings,
    });
    const published = publishReport({
      report,
      reportDirectory: paths.reportDirectory,
      fsModule,
    });

    return Object.freeze({
      status: report.status,
      environment: "staging",
      sourceBundleId: adapted.sourceBundle.id,
      resetManifestId: resetManifest.manifestId,
      stagingDescriptorSha256: descriptorSha256(descriptor),
      databasePath: paths.databasePath,
      databaseSha256: databaseArtifact.sha256,
      databaseBytes: databaseArtifact.bytes,
      reportDirectory: published.reportDirectory,
      semanticReportHash: report.semanticReportHash,
      importedRowCount: targetTables.reduce(
        (total, target) => total + target.validatedRowCount,
        0
      ),
      blockingRejectCount: report.rejects.length,
      quarantineCount: report.quarantine.length,
    });
  } catch (error) {
    if (database?.open) {
      try {
        if (database.inTransaction) database.exec("ROLLBACK;");
        database.close();
      } catch {
        // Preserve the original failure.
      }
    }
    if (ownsDatabase && paths) {
      removeOwnedDatabaseFiles(paths.databasePath, fsModule);
    }
    throw normalizeFailure(error);
  }
}

module.exports = {
  STAGING_IMPORT_BUILD_ID,
  buildMoneyAndOwnership,
  buildResetOmissions,
  runStagingImport,
  validateStagingImportPaths,
};
