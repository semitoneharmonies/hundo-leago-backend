const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  openDatabase,
} = require("../database/connection");
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
  loadAndValidateResetManifest,
} = require("./resetManifest");
const {
  canonicalize,
} = require("./sourceInventory");
const {
  NHL_PROVIDER,
  adaptVerifiedSourceBundle,
} = require("./sourceShapeAdapters");

const JSON_IMPORTER_VERSION = 1;
const JSON_IMPORT_BUILD_ID = "m2-09-dry-run-v1";

const JSON_IMPORT_ERROR_CODES = Object.freeze({
  argumentInvalid: "IMPORT_ARGUMENT_INVALID",
  pathUnsafe: "IMPORT_PATH_UNSAFE",
  sourceInvalid: "IMPORT_SOURCE_INVALID",
  manifestInvalid: "IMPORT_MANIFEST_INVALID",
  protectedDataAtRisk: "IMPORT_PROTECTED_DATA_AT_RISK",
  constraintFailed: "IMPORT_CONSTRAINT_FAILED",
  reconciliationFailed: "IMPORT_RECONCILIATION_FAILED",
  reportFailed: "IMPORT_REPORT_FAILED",
});

class JsonImportError extends Error {
  constructor(code, message, { cause } = {}) {
    super(
      message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "JsonImportError";
    this.code = code;
  }
}

function importError(code, message, options) {
  return new JsonImportError(code, message, options);
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsOverlap(firstPath, secondPath) {
  const first = path.resolve(firstPath);
  const second = path.resolve(secondPath);
  return (
    first === second ||
    isPathInside(first, second) ||
    isPathInside(second, first)
  );
}

function resolveNewTemporaryPath(
  value,
  {
    name,
    temporaryRoot,
    fsModule,
  }
) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    !path.isAbsolute(value)
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.argumentInvalid,
      `${name} must be an explicit absolute path.`
    );
  }
  const resolved = path.resolve(value);
  if (fsModule.existsSync(resolved)) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      `${name} must not already exist.`
    );
  }
  let physicalParent;
  try {
    physicalParent = fsModule.realpathSync(
      path.dirname(resolved)
    );
  } catch (error) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      `${name} parent must already exist.`,
      { cause: error }
    );
  }
  const physicalCandidate = path.join(
    physicalParent,
    path.basename(resolved)
  );
  if (!isPathInside(temporaryRoot, physicalCandidate)) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      `${name} must be inside the approved temporary root.`
    );
  }
  return physicalCandidate;
}

function validateImportPaths({
  sourceBundleDirectory,
  databasePath,
  reportDirectory,
  temporaryRoot = os.tmpdir(),
  fsModule = fs,
}) {
  if (
    typeof sourceBundleDirectory !== "string" ||
    sourceBundleDirectory.trim() === "" ||
    !path.isAbsolute(sourceBundleDirectory)
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.argumentInvalid,
      "The source bundle must be an explicit absolute path."
    );
  }

  let physicalTemporaryRoot;
  let physicalSourceBundle;
  try {
    physicalTemporaryRoot =
      fsModule.realpathSync(temporaryRoot);
    physicalSourceBundle = fsModule.realpathSync(
      sourceBundleDirectory
    );
  } catch (error) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      "The temporary root and source bundle must exist.",
      { cause: error }
    );
  }
  if (
    !fsModule.statSync(physicalSourceBundle).isDirectory() ||
    !isPathInside(
      physicalTemporaryRoot,
      physicalSourceBundle
    )
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      "The source bundle must be a directory inside the approved temporary root."
    );
  }

  const resolvedDatabasePath = resolveNewTemporaryPath(
    databasePath,
    {
      name: "databasePath",
      temporaryRoot: physicalTemporaryRoot,
      fsModule,
    }
  );
  const resolvedReportDirectory = resolveNewTemporaryPath(
    reportDirectory,
    {
      name: "reportDirectory",
      temporaryRoot: physicalTemporaryRoot,
      fsModule,
    }
  );

  if (
    pathsOverlap(
      physicalSourceBundle,
      resolvedDatabasePath
    ) ||
    pathsOverlap(
      physicalSourceBundle,
      resolvedReportDirectory
    ) ||
    pathsOverlap(
      resolvedDatabasePath,
      resolvedReportDirectory
    )
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.pathUnsafe,
      "Source, database, and report paths must not overlap."
    );
  }

  return Object.freeze({
    sourceBundleDirectory: physicalSourceBundle,
    databasePath: resolvedDatabasePath,
    reportDirectory: resolvedReportDirectory,
    temporaryRoot: physicalTemporaryRoot,
  });
}

function tableSemanticHash(database, tableName) {
  const rows = database
    .prepare(
      `SELECT * FROM "${tableName}" ORDER BY "id" ASC`
    )
    .all();
  return crypto
    .createHash("sha256")
    .update(canonicalize(rows))
    .digest("hex");
}

function assertResetReconciliation(adapted, manifest) {
  const expectedIds = manifest.omissionFamilies.map(
    (family) => family.familyId
  );
  const actualIds = Object.keys(
    adapted.omissionCounts
  );
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((familyId) => {
      return (
        !Object.hasOwn(
          adapted.omissionCounts,
          familyId
        ) ||
        !Number.isSafeInteger(
          adapted.omissionCounts[familyId]
        ) ||
        adapted.omissionCounts[familyId] < 0
      );
    }) ||
    actualIds.some(
      (familyId) => !expectedIds.includes(familyId)
    )
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.reconciliationFailed,
      "Reset omission families did not reconcile exactly."
    );
  }
}

function buildProtectedReport(adapted, manifest) {
  return manifest.protectedFamilies.map((family) => {
    const evidence =
      adapted.protectedEvidence[family.familyId] || {
        observedSourceCount: 0,
        plannedTargetRowCount: 0,
        treatment: family.treatment,
        preserved: true,
      };
    if (
      evidence.treatment !== family.treatment ||
      evidence.preserved !== true
    ) {
      throw importError(
        JSON_IMPORT_ERROR_CODES.protectedDataAtRisk,
        "A protected source family was not preserved."
      );
    }
    return Object.freeze({
      familyId: family.familyId,
      observedSourceCount: evidence.observedSourceCount,
      plannedTargetRowCount:
        evidence.plannedTargetRowCount,
      treatment: evidence.treatment,
      externalEvidencePreserved:
        evidence.externalEvidencePreserved === true,
      preserved: true,
    });
  });
}

function buildNeverImportReport(adapted, manifest) {
  return manifest.neverImportFamilies.map((family) => {
    const evidence =
      adapted.neverImportEvidence[family.familyId];
    if (
      !evidence ||
      evidence.treatment !== family.treatment ||
      evidence.importedTargetRowCount !== 0
    ) {
      throw importError(
        JSON_IMPORT_ERROR_CODES.protectedDataAtRisk,
        "Never-import source material was not excluded."
      );
    }
    return Object.freeze({
      familyId: family.familyId,
      observedSourceCount: evidence.observedSourceCount,
      importedTargetRowCount:
        evidence.importedTargetRowCount,
      treatment: evidence.treatment,
      excluded: true,
    });
  });
}

function normalizeImportFailure(error) {
  if (
    error instanceof JsonImportError ||
    (typeof error?.code === "string" &&
      error.code.startsWith("IMPORT_"))
  ) {
    return error;
  }
  if (
    typeof error?.code === "string" &&
    error.code.startsWith("RESET_MANIFEST_")
  ) {
    return importError(
      JSON_IMPORT_ERROR_CODES.manifestInvalid,
      "The reset manifest failed import validation.",
      { cause: error }
    );
  }
  if (
    typeof error?.code === "string" &&
    error.code.startsWith("INVENTORY_")
  ) {
    return importError(
      JSON_IMPORT_ERROR_CODES.sourceInvalid,
      "The source bundle failed import verification.",
      { cause: error }
    );
  }
  if (
    typeof error?.code === "string" &&
    (error.code.startsWith("REPOSITORY_") ||
      error.code.startsWith("MIGRATION_") ||
      error.code.startsWith("DATABASE_"))
  ) {
    return importError(
      JSON_IMPORT_ERROR_CODES.constraintFailed,
      "The dry-run database rejected the import plan.",
      { cause: error }
    );
  }
  return importError(
    JSON_IMPORT_ERROR_CODES.reconciliationFailed,
    "The JSON dry-run import failed safely.",
    { cause: error }
  );
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

function runJsonImportDryRun({
  sourceBundleDirectory,
  databasePath,
  resetManifestPath,
  reportDirectory,
  environment,
  operatingMode,
  dryRun,
  repositoryRoot = path.resolve(
    __dirname,
    "..",
    "..",
    ".."
  ),
  temporaryRoot = os.tmpdir(),
  fsModule = fs,
  adaptSourceBundle = adaptVerifiedSourceBundle,
} = {}) {
  if (
    environment !== "test" ||
    operatingMode !== "OFFSEASON_RESET" ||
    dryRun !== true ||
    typeof resetManifestPath !== "string" ||
    resetManifestPath.trim() === ""
  ) {
    throw importError(
      JSON_IMPORT_ERROR_CODES.argumentInvalid,
      "M2-09 requires test, OFFSEASON_RESET, an explicit manifest, and dry-run mode."
    );
  }

  const paths = validateImportPaths({
    sourceBundleDirectory,
    databasePath,
    reportDirectory,
    temporaryRoot,
    fsModule,
  });
  let database;
  let ownsDatabase = false;

  try {
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

    const connection = openDatabase({
      databasePath: paths.databasePath,
      environment,
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
      applicationBuildId: JSON_IMPORT_BUILD_ID,
      now: () => adapted.sourceBundle.capturedAtMs,
    });
    const repositories =
      createSqliteRepositoryContext({ database });

    const targetTables = [];
    let integrity;
    let foreignKeyViolations;
    let externalIdsPreserved = false;
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const [tableName, rows] of Object.entries(
        adapted.rows
      )) {
        const repository =
          repositories.getRepository(tableName);
        for (const row of rows) {
          repository.insert(row);
        }
        const validatedRowCount = database
          .prepare(
            `SELECT COUNT(*) AS count FROM "${tableName}"`
          )
          .get().count;
        if (validatedRowCount !== rows.length) {
          throw importError(
            JSON_IMPORT_ERROR_CODES.reconciliationFailed,
            "A target table row count did not reconcile."
          );
        }
        targetTables.push({
          table: tableName,
          plannedRowCount: rows.length,
          validatedRowCount,
          postRollbackRowCount: null,
          semanticHash: tableSemanticHash(
            database,
            tableName
          ),
        });
      }

      const plannedExternalIds =
        adapted.rows.player_external_ids
          .map((row) => row.external_value)
          .sort();
      const validatedExternalIds = database
        .prepare(
          "SELECT external_value FROM player_external_ids " +
            "WHERE provider = ? ORDER BY external_value ASC"
        )
        .all(NHL_PROVIDER)
        .map((row) => row.external_value);
      externalIdsPreserved =
        plannedExternalIds.length ===
          validatedExternalIds.length &&
        plannedExternalIds.every(
          (value, index) =>
            value === validatedExternalIds[index]
        );
      if (!externalIdsPreserved) {
        throw importError(
          JSON_IMPORT_ERROR_CODES.reconciliationFailed,
          "Stable player provider IDs did not reconcile."
        );
      }

      integrity = database.pragma("integrity_check", {
        simple: true,
      });
      foreignKeyViolations = database.pragma(
        "foreign_key_check"
      );
      if (
        integrity !== "ok" ||
        foreignKeyViolations.length !== 0
      ) {
        throw importError(
          JSON_IMPORT_ERROR_CODES.reconciliationFailed,
          "SQLite integrity or foreign-key verification failed."
        );
      }
    } finally {
      if (database.inTransaction) {
        database.exec("ROLLBACK;");
      }
    }

    for (const target of targetTables) {
      target.postRollbackRowCount = database
        .prepare(
          `SELECT COUNT(*) AS count FROM "${target.table}"`
        )
        .get().count;
      if (target.postRollbackRowCount !== 0) {
        throw importError(
          JSON_IMPORT_ERROR_CODES.reconciliationFailed,
          "Dry-run imported rows remained after rollback."
        );
      }
      Object.freeze(target);
    }

    const resetOmissions =
      resetManifest.omissionFamilies.map((family) =>
        Object.freeze({
          familyId: family.familyId,
          sourceCount:
            adapted.omissionCounts[family.familyId],
          countTreatment: family.countTreatment,
          targetTreatment: family.targetTreatment,
          validatedTargetRowCount: 0,
          reconciled: true,
        })
      );
    const totalMoney = adapted.moneyEvidence.reduce(
      (summary, family) => {
        summary.sourceCount += family.sourceCount;
        summary.sourceSumCents += family.sourceSumCents;
        summary.importedCount += family.importedCount;
        summary.importedSumCents +=
          family.importedSumCents;
        summary.omittedCount += family.omittedCount;
        summary.omittedSumCents +=
          family.omittedSumCents;
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
      sourceCount:
        adapted.sourceCollectionCounts.roster_entries,
      importedCount: 0,
      omittedCount:
        adapted.omissionCounts.season_1_rosters,
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

    const migrationLedger = readAppliedMigrations(database).map(
      (entry) =>
        Object.freeze({
          id: entry.id,
          fileName: entry.fileName,
          checksum: entry.checksum,
        })
    );
    const report = finalizeImportReport({
      importerVersion: JSON_IMPORTER_VERSION,
      status: "valid",
      dryRun: true,
      importedRowsRetained: false,
      sourceBundle: adapted.sourceBundle,
      resetManifest: Object.freeze({
        id: resetManifest.manifestId,
        version: resetManifest.manifestVersion,
        checksum: resetManifest.checksum,
      }),
      schema: Object.freeze({
        userVersion: database.pragma("user_version", {
          simple: true,
        }),
        migrationCount: migration.migrations.length,
        migrationLedger: Object.freeze(migrationLedger),
      }),
      sourceShapes: adapted.sourceShapes,
      sourceCollectionCounts:
        adapted.sourceCollectionCounts,
      targetTables: Object.freeze(targetTables),
      resetOmissions: Object.freeze(resetOmissions),
      protectedFamilies: Object.freeze(protectedFamilies),
      neverImportFamilies: Object.freeze(
        neverImportFamilies
      ),
      mappingEntries: adapted.mappings,
      money: Object.freeze({
        ...totalMoney,
        families: adapted.moneyEvidence,
      }),
      ownership,
      checks: Object.freeze({
        integrity,
        foreignKeyViolationCount:
          foreignKeyViolations.length,
        stablePlayerExternalIdsPreserved:
          externalIdsPreserved,
        importedRowsRolledBack: true,
      }),
      rejects: adapted.rejects,
      quarantine: adapted.quarantine,
      repairs: adapted.repairs,
      defaults: adapted.defaults,
      warnings: adapted.warnings,
    });

    database.close();
    database = null;
    const published = publishImportReport({
      report,
      reportDirectory: paths.reportDirectory,
      fsModule,
    });
    return Object.freeze({
      status: report.status,
      dryRun: true,
      sourceBundleId: adapted.sourceBundle.id,
      resetManifestId: resetManifest.manifestId,
      databasePath: paths.databasePath,
      reportDirectory: published.reportDirectory,
      semanticReportHash: report.semanticReportHash,
      plannedRowCount: targetTables.reduce(
        (total, target) =>
          total + target.plannedRowCount,
        0
      ),
      blockingRejectCount: report.rejects.length,
      quarantineCount: report.quarantine.length,
    });
  } catch (error) {
    if (database?.open) {
      try {
        if (database.inTransaction) {
          database.exec("ROLLBACK;");
        }
        database.close();
      } catch {
        // Preserve the original failure.
      }
    }
    if (ownsDatabase) {
      removeOwnedDatabaseFiles(
        paths.databasePath,
        fsModule
      );
    }
    throw normalizeImportFailure(error);
  }
}

module.exports = {
  JSON_IMPORT_BUILD_ID,
  JSON_IMPORT_ERROR_CODES,
  JSON_IMPORTER_VERSION,
  JsonImportError,
  assertResetReconciliation,
  buildNeverImportReport,
  buildProtectedReport,
  runJsonImportDryRun,
  tableSemanticHash,
  validateImportPaths,
};
