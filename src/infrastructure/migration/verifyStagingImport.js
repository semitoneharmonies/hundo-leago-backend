const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  openReadonlyDatabase,
} = require("../database/connection");
const {
  loadAndValidateStagingDescriptor,
} = require("../database/stagingEnvironment");
const {
  REPOSITORY_CATALOG,
} = require("../persistence/sqlite/repositoryCatalog");
const {
  calculateSemanticReportHash,
} = require("./importReport");
const {
  buildNeverImportReport,
  buildProtectedReport,
  tableSemanticHash,
} = require("./runJsonImport");
const {
  buildMoneyAndOwnership,
  buildResetOmissions,
} = require("./runStagingImport");
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

const STAGING_VERIFICATION_VERSION = 1;
const STAGING_VERIFICATION_ERROR_CODES = Object.freeze({
  argumentInvalid: "STAGING_VERIFY_ARGUMENT_INVALID",
  pathUnsafe: "STAGING_VERIFY_PATH_UNSAFE",
  reportInvalid: "STAGING_VERIFY_REPORT_INVALID",
  sourceMismatch: "STAGING_VERIFY_SOURCE_MISMATCH",
  resetMismatch: "STAGING_VERIFY_RESET_MISMATCH",
  databaseMismatch: "STAGING_VERIFY_DATABASE_MISMATCH",
  semanticMismatch: "STAGING_VERIFY_SEMANTIC_MISMATCH",
});

class StagingImportVerificationError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StagingImportVerificationError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new StagingImportVerificationError(code, message, options);
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

function physicalDirectory(value, name, fsModule) {
  try {
    const physical = fsModule.realpathSync(value);
    if (!fsModule.statSync(physical).isDirectory()) {
      throw new Error(`${name} is not a directory.`);
    }
    return physical;
  } catch (error) {
    fail(
      STAGING_VERIFICATION_ERROR_CODES.pathUnsafe,
      `${name} must be an existing physical directory.`,
      { cause: error }
    );
  }
}

function physicalFile(value, name, fsModule) {
  try {
    const physical = fsModule.realpathSync(value);
    if (!fsModule.statSync(physical).isFile()) {
      throw new Error(`${name} is not a file.`);
    }
    return physical;
  } catch (error) {
    fail(
      STAGING_VERIFICATION_ERROR_CODES.pathUnsafe,
      `${name} must be an existing physical file.`,
      { cause: error }
    );
  }
}

function validateVerificationPaths({
  descriptor,
  sourceBundleDirectory,
  databasePath,
  importReportPath,
  repositoryRoot = path.resolve(__dirname, "..", "..", ".."),
  fsModule = fs,
} = {}) {
  if (
    !descriptor ||
    ![sourceBundleDirectory, databasePath, importReportPath].every(
      (value) => typeof value === "string" && path.isAbsolute(value)
    )
  ) {
    fail(
      STAGING_VERIFICATION_ERROR_CODES.argumentInvalid,
      "Verification paths must be explicit and absolute."
    );
  }
  const root = physicalDirectory(
    descriptor.paths.persistentRoot,
    "Staging persistent root",
    fsModule
  );
  const sourceRoot = physicalDirectory(
    descriptor.paths.sourceBundles,
    "Staging source root",
    fsModule
  );
  const reportRoot = physicalDirectory(
    descriptor.paths.reports,
    "Staging report root",
    fsModule
  );
  const backupRoot = physicalDirectory(
    descriptor.paths.backups,
    "Staging backup root",
    fsModule
  );
  const source = physicalDirectory(
    sourceBundleDirectory,
    "Source bundle",
    fsModule
  );
  const database = physicalFile(
    databasePath,
    "Staging database",
    fsModule
  );
  const report = physicalFile(
    importReportPath,
    "Import report",
    fsModule
  );
  const repository = fsModule.realpathSync(repositoryRoot);
  if (
    pathsOverlap(root, repository) ||
    !isPathInside(root, sourceRoot) ||
    !isPathInside(root, reportRoot) ||
    !isPathInside(root, backupRoot) ||
    !isPathInside(sourceRoot, source) ||
    !isPathInside(reportRoot, report) ||
    !isPathInside(root, database) ||
    path.resolve(databasePath) !==
      path.resolve(descriptor.paths.database)
  ) {
    fail(
      STAGING_VERIFICATION_ERROR_CODES.pathUnsafe,
      "Verification inputs are outside the isolated staging boundary."
    );
  }
  return Object.freeze({
    persistentRoot: root,
    sourceBundleDirectory: source,
    databasePath: database,
    importReportPath: report,
  });
}

function hashBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath, fsModule) {
  return hashBytes(fsModule.readFileSync(filePath));
}

function readCanonicalImportReport(reportPath, fsModule) {
  let raw;
  let report;
  try {
    raw = fsModule.readFileSync(reportPath, "utf8");
    report = JSON.parse(raw);
  } catch (error) {
    fail(
      STAGING_VERIFICATION_ERROR_CODES.reportInvalid,
      "The import report could not be read and parsed.",
      { cause: error }
    );
  }
  if (
    raw !== `${canonicalize(report)}\n` ||
    report?.reportVersion !== 1 ||
    report.status !== "valid" ||
    report.dryRun !== false ||
    report.importedRowsRetained !== true ||
    report.environment !== "staging" ||
    calculateSemanticReportHash(report) !==
      report.semanticReportHash
  ) {
    fail(
      STAGING_VERIFICATION_ERROR_CODES.reportInvalid,
      "The import report is not canonical and internally valid."
    );
  }
  return Object.freeze({ raw, report: Object.freeze(report) });
}

function assertCanonicalEqual(actual, expected, code, message) {
  if (canonicalize(actual) !== canonicalize(expected)) {
    fail(code, message);
  }
}

function expectedDescriptorEvidence(descriptor) {
  return {
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
  };
}

function expectedTargetEvidence(database, adapted) {
  return Object.freeze(
    Object.entries(adapted.rows).map(([table, rows]) =>
      Object.freeze({
        table,
        plannedRowCount: rows.length,
        validatedRowCount: database
          .prepare(
            `SELECT COUNT(*) AS count FROM "${table}"`
          )
          .get().count,
        postRollbackRowCount: null,
        semanticHash: tableSemanticHash(database, table),
      })
    )
  );
}

function verifyAllApplicationTableCounts(
  database,
  adapted
) {
  const expectedCounts = new Map(
    Object.entries(adapted.rows).map(([table, rows]) => [
      table,
      rows.length,
    ])
  );
  expectedCounts.set("application_metadata", 2);
  let emptyTableCount = 0;
  for (const definition of REPOSITORY_CATALOG) {
    const actual = database
      .prepare(
        `SELECT COUNT(*) AS count FROM "${definition.tableName}"`
      )
      .get().count;
    const expected = expectedCounts.get(definition.tableName) || 0;
    if (actual !== expected) {
      fail(
        STAGING_VERIFICATION_ERROR_CODES.databaseMismatch,
        "An application table row count does not match the import plan."
      );
    }
    if (expected === 0) emptyTableCount += 1;
  }
  const metadata = database.prepare(
    "SELECT metadata_key,metadata_value,created_at_ms,updated_at_ms " +
    "FROM application_metadata ORDER BY metadata_key"
  ).all();
  assertCanonicalEqual(
    metadata,
    [
      {
        metadata_key: "application_compatibility_version",
        metadata_value: "1",
        created_at_ms: 0,
        updated_at_ms: 0,
      },
      {
        metadata_key: "data_model_version",
        metadata_value: "18",
        created_at_ms: 0,
        updated_at_ms: 1,
      },
    ],
    STAGING_VERIFICATION_ERROR_CODES.databaseMismatch,
    "Seeded application metadata does not match the approved schema."
  );
  return emptyTableCount;
}

function stableExternalIds(database, adapted) {
  const expected = adapted.rows.player_external_ids
    .map((row) => row.external_value)
    .sort();
  const actual = database
    .prepare(
      "SELECT external_value FROM player_external_ids " +
      "WHERE provider = ? ORDER BY external_value"
    )
    .all(NHL_PROVIDER)
    .map((row) => row.external_value);
  return expected.length === actual.length &&
    expected.every((value, index) => value === actual[index]);
}

function verificationHash(evidence) {
  const payload = { ...evidence };
  delete payload.verificationHash;
  return hashBytes(canonicalize(payload));
}

function openVerificationCopy({
  databasePath,
  temporaryRoot,
  fsModule,
}) {
  const physicalTemporaryRoot =
    fsModule.realpathSync(temporaryRoot);
  const directory = fsModule.mkdtempSync(
    path.join(
      physicalTemporaryRoot,
      "hundo-m2-13-staging-verify-"
    )
  );
  const copyPath = path.join(directory, "database.sqlite3");
  try {
    fsModule.copyFileSync(
      databasePath,
      copyPath,
      fs.constants.COPYFILE_EXCL
    );
    if (
      hashFile(copyPath, fsModule) !==
      hashFile(databasePath, fsModule)
    ) {
      fail(
        STAGING_VERIFICATION_ERROR_CODES.databaseMismatch,
        "The isolated verification copy does not match the staging database."
      );
    }
    return Object.freeze({
      database: openReadonlyDatabase({
        databasePath: copyPath,
      }),
      directory,
    });
  } catch (error) {
    fsModule.rmSync(directory, {
      recursive: true,
      force: true,
    });
    throw error;
  }
}

function verifyStagingImport({
  descriptorPath,
  sourceBundleDirectory,
  databasePath,
  resetManifestPath,
  importReportPath,
  operatingMode,
  repositoryRoot = path.resolve(__dirname, "..", "..", ".."),
  temporaryRoot = os.tmpdir(),
  fsModule = fs,
  adaptSourceBundle = adaptVerifiedSourceBundle,
} = {}) {
  if (
    operatingMode !== "OFFSEASON_RESET" ||
    ![descriptorPath, resetManifestPath].every(
      (value) => typeof value === "string" && value.trim() !== ""
    )
  ) {
    fail(
      STAGING_VERIFICATION_ERROR_CODES.argumentInvalid,
      "Verification requires a descriptor, reset manifest, and OFFSEASON_RESET."
    );
  }
  const descriptor = loadAndValidateStagingDescriptor({
    descriptorPath,
    fsModule,
  });
  const paths = validateVerificationPaths({
    descriptor,
    sourceBundleDirectory,
    databasePath,
    importReportPath,
    repositoryRoot,
    fsModule,
  });
  const databaseHashBefore = hashFile(
    paths.databasePath,
    fsModule
  );
  const reportHashBefore = hashFile(
    paths.importReportPath,
    fsModule
  );
  const sourceManifestPath = path.join(
    paths.sourceBundleDirectory,
    "source-bundle.json"
  );
  const sourceManifestHashBefore = hashFile(
    sourceManifestPath,
    fsModule
  );
  const imported = readCanonicalImportReport(
    paths.importReportPath,
    fsModule
  );
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
  const expectedReset = {
    id: resetManifest.manifestId,
    version: resetManifest.manifestVersion,
    checksum: resetManifest.checksum,
  };
  assertCanonicalEqual(
    imported.report.sourceBundle,
    adapted.sourceBundle,
    STAGING_VERIFICATION_ERROR_CODES.sourceMismatch,
    "Import-report source identity does not match the copied bundle."
  );
  assertCanonicalEqual(
    imported.report.resetManifest,
    expectedReset,
    STAGING_VERIFICATION_ERROR_CODES.resetMismatch,
    "Import-report reset identity does not match the approved manifest."
  );
  assertCanonicalEqual(
    imported.report.stagingDescriptor,
    expectedDescriptorEvidence(descriptor),
    STAGING_VERIFICATION_ERROR_CODES.semanticMismatch,
    "Import-report staging isolation evidence does not match."
  );

  const expectedProtected = buildProtectedReport(
    adapted,
    resetManifest
  );
  const expectedNeverImport = buildNeverImportReport(
    adapted,
    resetManifest
  );
  const expectedReconciliation =
    buildMoneyAndOwnership(adapted);
  assertCanonicalEqual(
    imported.report.resetOmissions,
    buildResetOmissions(adapted, resetManifest),
    STAGING_VERIFICATION_ERROR_CODES.resetMismatch,
    "Reset omission evidence does not reconcile."
  );
  assertCanonicalEqual(
    imported.report.protectedFamilies,
    expectedProtected,
    STAGING_VERIFICATION_ERROR_CODES.semanticMismatch,
    "Protected-family evidence does not reconcile."
  );
  assertCanonicalEqual(
    imported.report.neverImportFamilies,
    expectedNeverImport,
    STAGING_VERIFICATION_ERROR_CODES.semanticMismatch,
    "Never-import evidence does not reconcile."
  );
  for (const [actual, expected, message] of [
    [
      imported.report.sourceShapes,
      adapted.sourceShapes,
      "Source-shape evidence does not reconcile.",
    ],
    [
      imported.report.sourceCollectionCounts,
      adapted.sourceCollectionCounts,
      "Source collection counts do not reconcile.",
    ],
    [
      imported.report.mappingEntries,
      adapted.mappings,
      "Stable mapping evidence does not reconcile.",
    ],
    [
      imported.report.money,
      expectedReconciliation.money,
      "Money evidence does not reconcile.",
    ],
    [
      imported.report.ownership,
      expectedReconciliation.ownership,
      "Ownership evidence does not reconcile.",
    ],
    [imported.report.rejects, adapted.rejects, "Reject evidence changed."],
    [
      imported.report.quarantine,
      adapted.quarantine,
      "Quarantine evidence changed.",
    ],
    [imported.report.repairs, adapted.repairs, "Repair evidence changed."],
    [imported.report.defaults, adapted.defaults, "Default evidence changed."],
    [imported.report.warnings, adapted.warnings, "Warning evidence changed."],
  ]) {
    assertCanonicalEqual(
      actual,
      expected,
      STAGING_VERIFICATION_ERROR_CODES.semanticMismatch,
      message
    );
  }

  let database;
  let verificationCopyDirectory;
  try {
    const verificationCopy = openVerificationCopy({
      databasePath: paths.databasePath,
      temporaryRoot,
      fsModule,
    });
    database = verificationCopy.database;
    verificationCopyDirectory = verificationCopy.directory;
    const integrity = database.pragma("integrity_check", {
      simple: true,
    });
    const foreignKeyViolations =
      database.pragma("foreign_key_check");
    if (integrity !== "ok" || foreignKeyViolations.length !== 0) {
      fail(
        STAGING_VERIFICATION_ERROR_CODES.databaseMismatch,
        "SQLite integrity or foreign-key verification failed."
      );
    }
    const targetTables = expectedTargetEvidence(
      database,
      adapted
    );
    assertCanonicalEqual(
      imported.report.targetTables,
      targetTables,
      STAGING_VERIFICATION_ERROR_CODES.databaseMismatch,
      "Target row counts or semantic hashes do not reconcile."
    );
    const emptyApplicationTableCount =
      verifyAllApplicationTableCounts(database, adapted);
    if (!stableExternalIds(database, adapted)) {
      fail(
        STAGING_VERIFICATION_ERROR_CODES.databaseMismatch,
        "Stable player provider identifiers do not reconcile."
      );
    }
    const migrations = database.prepare(
      "SELECT migration_id AS id,file_name AS fileName,checksum " +
      "FROM schema_migrations ORDER BY migration_id"
    ).all();
    const schema = {
      userVersion: database.pragma("user_version", {
        simple: true,
      }),
      migrationCount: migrations.length,
      migrationLedger: migrations,
    };
    assertCanonicalEqual(
      imported.report.schema,
      schema,
      STAGING_VERIFICATION_ERROR_CODES.databaseMismatch,
      "Schema or migration-ledger evidence does not reconcile."
    );
    assertCanonicalEqual(
      imported.report.checks,
      {
        integrity: "ok",
        foreignKeyViolationCount: 0,
        stablePlayerExternalIdsPreserved: true,
        importedRowsRolledBack: false,
        committedRowsVerified: true,
      },
      STAGING_VERIFICATION_ERROR_CODES.semanticMismatch,
      "Import checks do not match independently verified state."
    );

    const evidenceWithoutHash = {
      verificationVersion: STAGING_VERIFICATION_VERSION,
      status: "verified",
      environment: "staging",
      sourceBundle: adapted.sourceBundle,
      resetManifest: expectedReset,
      database: {
        sha256: databaseHashBefore,
        bytes: fsModule.statSync(paths.databasePath).size,
        userVersion: schema.userVersion,
        migrationLedger: schema.migrationLedger,
        targetTables,
        seededApplicationMetadataRowCount: 2,
        emptyApplicationTableCount,
      },
      importReport: {
        sha256: reportHashBefore,
        bytes: Buffer.byteLength(imported.raw),
        semanticReportHash:
          imported.report.semanticReportHash,
      },
      reconciliation: {
        omissionFamilyCount:
          imported.report.resetOmissions.length,
        protectedFamilyCount:
          imported.report.protectedFamilies.length,
        neverImportFamilyCount:
          imported.report.neverImportFamilies.length,
        mappingEntryCount:
          imported.report.mappingEntries.length,
        mappingSha256: hashBytes(
          canonicalize(imported.report.mappingEntries)
        ),
        money: expectedReconciliation.money,
        ownership: expectedReconciliation.ownership,
      },
      checks: {
        integrity: "ok",
        foreignKeyViolationCount: 0,
        stablePlayerExternalIdsPreserved: true,
        sourceBundleVerified: true,
        resetManifestVerified: true,
        canonicalImportReportVerified: true,
        allApplicationTableCountsVerified: true,
        semanticHashesVerified: true,
        applicationAuthority: descriptor.applicationAuthority,
        sqliteApplicationAuthorityEnabled:
          descriptor.sqliteApplicationAuthorityEnabled,
        productionStorageAccessible:
          descriptor.productionStorageAccessible,
        productionSecretsAccessible:
          descriptor.productionSecretsAccessible,
        inputsUnchanged: true,
      },
    };
    const evidence = {
      ...evidenceWithoutHash,
      verificationHash: verificationHash(evidenceWithoutHash),
    };
    const unchanged =
      hashFile(paths.databasePath, fsModule) === databaseHashBefore &&
      hashFile(paths.importReportPath, fsModule) === reportHashBefore &&
      hashFile(sourceManifestPath, fsModule) ===
        sourceManifestHashBefore;
    if (!unchanged) {
      fail(
        STAGING_VERIFICATION_ERROR_CODES.semanticMismatch,
        "A verification input changed during read-only verification."
      );
    }
    return Object.freeze(evidence);
  } finally {
    if (database?.open) database.close();
    if (verificationCopyDirectory) {
      fsModule.rmSync(verificationCopyDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}

module.exports = {
  STAGING_VERIFICATION_ERROR_CODES,
  STAGING_VERIFICATION_VERSION,
  StagingImportVerificationError,
  validateVerificationPaths,
  verificationHash,
  verifyStagingImport,
};
