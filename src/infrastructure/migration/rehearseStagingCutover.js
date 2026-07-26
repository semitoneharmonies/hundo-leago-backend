const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  openReadonlyDatabase,
} = require("../database/connection");
const {
  loadAndValidateStagingDescriptor,
} = require("../database/stagingEnvironment");
const {
  createVerifiedBackup,
  inspectDatabase,
  restoreBackupToCleanPath,
} = require("../database/sqliteBackup");
const {
  REPOSITORY_CATALOG,
} = require("../persistence/sqlite/repositoryCatalog");
const {
  tableSemanticHash,
} = require("./runJsonImport");
const {
  canonicalize,
} = require("./sourceInventory");
const {
  verifyStagingImport,
} = require("./verifyStagingImport");

const STAGING_REHEARSAL_VERSION = 1;
const REHEARSAL_REPORT_FILE = "cutover-rehearsal-report.json";
const REHEARSAL_MARKDOWN_FILE = "cutover-rehearsal-report.md";
const ACTIVATION_CANDIDATE_FILE =
  "activation-candidate.sqlite3";
const ROLLBACK_CANDIDATE_FILE =
  "rollback-candidate.sqlite3";
const STAGING_REHEARSAL_ERROR_CODES = Object.freeze({
  argumentInvalid: "STAGING_REHEARSAL_ARGUMENT_INVALID",
  pathUnsafe: "STAGING_REHEARSAL_PATH_UNSAFE",
  backupFailed: "STAGING_REHEARSAL_BACKUP_FAILED",
  candidateMismatch: "STAGING_REHEARSAL_CANDIDATE_MISMATCH",
  authorityUnsafe: "STAGING_REHEARSAL_AUTHORITY_UNSAFE",
  publicationFailed: "STAGING_REHEARSAL_PUBLICATION_FAILED",
});

class StagingCutoverRehearsalError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StagingCutoverRehearsalError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new StagingCutoverRehearsalError(
    code,
    message,
    options
  );
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

function resolveNewOutput({
  value,
  root,
  name,
  fsModule,
}) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    fsModule.existsSync(value)
  ) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.pathUnsafe,
      `${name} must be a new absolute path.`
    );
  }
  let physicalRoot;
  let physicalParent;
  try {
    physicalRoot = fsModule.realpathSync(root);
    physicalParent = fsModule.realpathSync(path.dirname(value));
  } catch (error) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.pathUnsafe,
      `${name} root and parent must exist.`,
      { cause: error }
    );
  }
  const output = path.join(
    physicalParent,
    path.basename(value)
  );
  if (!isPathInside(physicalRoot, output)) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.pathUnsafe,
      `${name} must be below its staging root.`
    );
  }
  return output;
}

function validateRehearsalOutputs({
  descriptor,
  backupDirectory,
  rehearsalDirectory,
  sourcePaths,
  fsModule = fs,
} = {}) {
  const backup = resolveNewOutput({
    value: backupDirectory,
    root: descriptor.paths.backups,
    name: "backupDirectory",
    fsModule,
  });
  const rehearsal = resolveNewOutput({
    value: rehearsalDirectory,
    root: descriptor.paths.reports,
    name: "rehearsalDirectory",
    fsModule,
  });
  const protectedPaths = [
    sourcePaths.descriptorPath,
    sourcePaths.sourceBundleDirectory,
    sourcePaths.databasePath,
    sourcePaths.resetManifestPath,
    sourcePaths.importReportPath,
  ].map((value) => path.resolve(value));
  if (
    pathsOverlap(backup, rehearsal) ||
    protectedPaths.some(
      (protectedPath) =>
        pathsOverlap(backup, protectedPath) ||
        pathsOverlap(rehearsal, protectedPath)
    )
  ) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.pathUnsafe,
      "Rehearsal outputs must not overlap any input or each other."
    );
  }
  return Object.freeze({
    backupDirectory: backup,
    rehearsalDirectory: rehearsal,
  });
}

function hashFile(filePath, fsModule) {
  return crypto
    .createHash("sha256")
    .update(fsModule.readFileSync(filePath))
    .digest("hex");
}

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalize(value))
    .digest("hex");
}

function captureInputHashes(paths, fsModule) {
  return Object.freeze({
    descriptor: hashFile(paths.descriptorPath, fsModule),
    sourceManifest: hashFile(
      path.join(
        paths.sourceBundleDirectory,
        "source-bundle.json"
      ),
      fsModule
    ),
    database: hashFile(paths.databasePath, fsModule),
    resetManifest: hashFile(
      paths.resetManifestPath,
      fsModule
    ),
    importReport: hashFile(
      paths.importReportPath,
      fsModule
    ),
  });
}

function removeCandidateSidecars(databasePath, fsModule) {
  const wal = `${databasePath}-wal`;
  const shm = `${databasePath}-shm`;
  if (
    fsModule.existsSync(wal) &&
    fsModule.statSync(wal).size !== 0
  ) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.candidateMismatch,
      "Candidate verification unexpectedly produced a nonempty WAL."
    );
  }
  if (fsModule.existsSync(shm)) {
    fsModule.rmSync(shm, { force: true });
  }
  if (fsModule.existsSync(wal)) {
    fsModule.rmSync(wal, { force: true });
  }
}

function expectedRowCounts(sourceEvidence) {
  const counts = Object.fromEntries(
    REPOSITORY_CATALOG.map((definition) => [
      definition.tableName,
      0,
    ])
  );
  counts.application_metadata = 2;
  for (const target of sourceEvidence.database.targetTables) {
    counts[target.table] = target.validatedRowCount;
  }
  return {
    ...counts,
    schema_migrations:
      sourceEvidence.database.migrationLedger.length,
  };
}

function inspectCandidate({
  databasePath,
  sourceEvidence,
  fsModule,
}) {
  const inspection = inspectDatabase(databasePath);
  if (
    canonicalize(inspection.rowCounts) !==
      canonicalize(expectedRowCounts(sourceEvidence)) ||
    inspection.userVersion !==
      sourceEvidence.database.userVersion ||
    canonicalize(inspection.migrations) !==
      canonicalize(
        sourceEvidence.database.migrationLedger
      )
  ) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.candidateMismatch,
      "A restored candidate does not match source counts or migrations."
    );
  }

  let database;
  let targetTables;
  let metadata;
  try {
    database = openReadonlyDatabase({ databasePath });
    targetTables =
      sourceEvidence.database.targetTables.map((target) => ({
        table: target.table,
        validatedRowCount: database
          .prepare(
            `SELECT COUNT(*) AS count FROM "${target.table}"`
          )
          .get().count,
        semanticHash: tableSemanticHash(
          database,
          target.table
        ),
      }));
    metadata = database.prepare(
      "SELECT metadata_key,metadata_value,created_at_ms,updated_at_ms " +
      "FROM application_metadata ORDER BY metadata_key"
    ).all();
  } finally {
    if (database?.open) database.close();
    removeCandidateSidecars(databasePath, fsModule);
  }
  const expectedTargets =
    sourceEvidence.database.targetTables.map((target) => ({
      table: target.table,
      validatedRowCount: target.validatedRowCount,
      semanticHash: target.semanticHash,
    }));
  const expectedMetadata = [
    {
      metadata_key: "application_compatibility_version",
      metadata_value: "1",
      created_at_ms: 0,
      updated_at_ms: 0,
    },
    {
      metadata_key: "data_model_version",
      metadata_value: "20",
      created_at_ms: 0,
      updated_at_ms: 1,
    },
  ];
  if (
    canonicalize(targetTables) !==
      canonicalize(expectedTargets) ||
    canonicalize(metadata) !==
      canonicalize(expectedMetadata)
  ) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.candidateMismatch,
      "A restored candidate does not match source semantics."
    );
  }
  return Object.freeze({
    sha256: hashFile(databasePath, fsModule),
    bytes: fsModule.statSync(databasePath).size,
    inspectionHash: hashValue(inspection),
    targetTables: Object.freeze(
      targetTables.map(Object.freeze)
    ),
  });
}

function calculateRehearsalHash(report) {
  const payload = { ...report };
  delete payload.rehearsalHash;
  return hashValue(payload);
}

function renderMarkdown(report) {
  return [
    "# Hundo Leago Staging Cutover Rehearsal",
    "",
    `Status: \`${report.status}\``,
    "",
    `Rehearsal hash: \`${report.rehearsalHash}\``,
    "",
    `Source verification: \`${report.source.verificationHash}\``,
    "",
    `Backup: \`${report.backup.backupId}\``,
    "",
    `Activation candidate verified: \`${report.checks.activationCandidateVerified}\``,
    "",
    `Rollback candidate verified: \`${report.checks.rollbackCandidateVerified}\``,
    "",
    `Application authority after rehearsal: \`${report.checks.applicationAuthorityAfter}\``,
    "",
    `Production authority changed: \`${report.checks.productionAuthorityChanged}\``,
    "",
  ].join("\n");
}

function cleanupOwnedDirectory(
  directoryPath,
  expectedRoot,
  fsModule
) {
  if (!directoryPath || !fsModule.existsSync(directoryPath)) {
    return;
  }
  const root = fsModule.realpathSync(expectedRoot);
  const target = fsModule.realpathSync(directoryPath);
  if (!isPathInside(root, target)) {
    throw new Error(
      "Refusing rehearsal cleanup outside the expected root."
    );
  }
  fsModule.rmSync(target, {
    recursive: true,
    force: true,
  });
}

async function rehearseStagingCutover({
  descriptorPath,
  sourceBundleDirectory,
  databasePath,
  resetManifestPath,
  importReportPath,
  backupDirectory,
  rehearsalDirectory,
  operatingMode,
  rehearsedAtMs,
  fsModule = fs,
  verifyImport = verifyStagingImport,
  createBackup = createVerifiedBackup,
  restoreBackup = restoreBackupToCleanPath,
} = {}) {
  if (
    operatingMode !== "OFFSEASON_RESET" ||
    !Number.isSafeInteger(rehearsedAtMs) ||
    rehearsedAtMs < 0
  ) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.argumentInvalid,
      "Rehearsal requires OFFSEASON_RESET and an explicit safe timestamp."
    );
  }
  const descriptor = loadAndValidateStagingDescriptor({
    descriptorPath,
    fsModule,
  });
  if (
    descriptor.applicationAuthority !== "json" ||
    descriptor.sqliteApplicationAuthorityEnabled !== false ||
    descriptor.productionStorageAccessible !== false ||
    descriptor.productionSecretsAccessible !== false
  ) {
    fail(
      STAGING_REHEARSAL_ERROR_CODES.authorityUnsafe,
      "The rehearsal descriptor does not preserve the authority boundary."
    );
  }
  const sourcePaths = Object.freeze({
    descriptorPath: path.resolve(descriptorPath),
    sourceBundleDirectory: path.resolve(
      sourceBundleDirectory
    ),
    databasePath: path.resolve(databasePath),
    resetManifestPath: path.resolve(resetManifestPath),
    importReportPath: path.resolve(importReportPath),
  });
  const outputs = validateRehearsalOutputs({
    descriptor,
    backupDirectory,
    rehearsalDirectory,
    sourcePaths,
    fsModule,
  });
  const hashesBefore = captureInputHashes(
    sourcePaths,
    fsModule
  );
  const sourceEvidence = verifyImport({
    ...sourcePaths,
    operatingMode,
    fsModule,
  });
  const buildingDirectory = path.join(
    path.dirname(outputs.rehearsalDirectory),
    `.${path.basename(outputs.rehearsalDirectory)}.building-` +
      crypto.randomUUID()
  );
  let ownsBuilding = false;
  let ownsBackup = false;
  try {
    fsModule.mkdirSync(buildingDirectory);
    ownsBuilding = true;
    const backup = await createBackup({
      databasePath: sourcePaths.databasePath,
      outputDirectory: outputs.backupDirectory,
      environment: "staging",
      reason: "pre-cutover-rehearsal",
      capturedAtMs: rehearsedAtMs,
      temporaryRoot: descriptor.paths.persistentRoot,
    });
    ownsBackup = true;
    const activationPath = path.join(
      buildingDirectory,
      ACTIVATION_CANDIDATE_FILE
    );
    const rollbackPath = path.join(
      buildingDirectory,
      ROLLBACK_CANDIDATE_FILE
    );
    const activationRestore = restoreBackup({
      backupDirectory: outputs.backupDirectory,
      targetDatabasePath: activationPath,
      environment: "staging",
      temporaryRoot: descriptor.paths.persistentRoot,
    });
    const activation = inspectCandidate({
      databasePath: activationPath,
      sourceEvidence,
      fsModule,
    });
    const rollbackRestore = restoreBackup({
      backupDirectory: outputs.backupDirectory,
      targetDatabasePath: rollbackPath,
      environment: "staging",
      temporaryRoot: descriptor.paths.persistentRoot,
    });
    const rollback = inspectCandidate({
      databasePath: rollbackPath,
      sourceEvidence,
      fsModule,
    });
    if (
      backup.plaintextSha256 !== activation.sha256 ||
      activationRestore.plaintextSha256 !==
        activation.sha256 ||
      rollbackRestore.plaintextSha256 !==
        rollback.sha256 ||
      canonicalize(activation) !== canonicalize(rollback)
    ) {
      fail(
        STAGING_REHEARSAL_ERROR_CODES.candidateMismatch,
        "Activation and rollback candidates are not the same verified backup boundary."
      );
    }
    const hashesAfter = captureInputHashes(
      sourcePaths,
      fsModule
    );
    if (
      canonicalize(hashesAfter) !==
      canonicalize(hashesBefore)
    ) {
      fail(
        STAGING_REHEARSAL_ERROR_CODES.authorityUnsafe,
        "A protected rehearsal input changed."
      );
    }
    const reportWithoutHash = {
      rehearsalVersion: STAGING_REHEARSAL_VERSION,
      status: "passed",
      environment: "staging",
      rehearsedAtMs,
      stagingResources: descriptor.resourceIds,
      source: {
        verificationHash: sourceEvidence.verificationHash,
        sourceBundleId: sourceEvidence.sourceBundle.id,
        databaseSha256: sourceEvidence.database.sha256,
        importReportSha256:
          sourceEvidence.importReport.sha256,
        semanticReportHash:
          sourceEvidence.importReport.semanticReportHash,
      },
      backup: {
        backupId: backup.backupId,
        plaintextSha256: backup.plaintextSha256,
        manifestChecksum: backup.manifestChecksum,
      },
      activationCandidate: activation,
      rollbackCandidate: rollback,
      sequence: [
        "preflight_import_verified",
        "pre_cutover_backup_verified",
        "activation_candidate_restored_and_verified",
        "rollback_candidate_restored_and_verified",
        "json_authority_confirmed_unchanged",
      ],
      checks: {
        backupVerified: true,
        activationCandidateVerified: true,
        rollbackCandidateVerified: true,
        sourceInputsUnchanged: true,
        applicationAuthorityBefore: "json",
        applicationAuthorityAfter: "json",
        sqliteApplicationAuthorityEnabledBefore: false,
        sqliteApplicationAuthorityEnabledAfter: false,
        productionStorageAccessible: false,
        productionSecretsAccessible: false,
        productionAuthorityChanged: false,
      },
    };
    const report = Object.freeze({
      ...reportWithoutHash,
      rehearsalHash:
        calculateRehearsalHash(reportWithoutHash),
    });
    fsModule.writeFileSync(
      path.join(
        buildingDirectory,
        REHEARSAL_REPORT_FILE
      ),
      `${canonicalize(report)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      }
    );
    fsModule.writeFileSync(
      path.join(
        buildingDirectory,
        REHEARSAL_MARKDOWN_FILE
      ),
      renderMarkdown(report),
      {
        encoding: "utf8",
        flag: "wx",
      }
    );
    fsModule.renameSync(
      buildingDirectory,
      outputs.rehearsalDirectory
    );
    ownsBuilding = false;
    return Object.freeze({
      status: report.status,
      environment: report.environment,
      rehearsalHash: report.rehearsalHash,
      sourceVerificationHash:
        sourceEvidence.verificationHash,
      backupId: backup.backupId,
      backupSha256: backup.plaintextSha256,
      candidateSha256: activation.sha256,
      reportPath: path.join(
        outputs.rehearsalDirectory,
        REHEARSAL_REPORT_FILE
      ),
      rehearsalDirectory: outputs.rehearsalDirectory,
      backupDirectory: outputs.backupDirectory,
      applicationAuthority: "json",
      sqliteApplicationAuthorityEnabled: false,
      productionAuthorityChanged: false,
    });
  } catch (error) {
    if (ownsBuilding) {
      try {
        cleanupOwnedDirectory(
          buildingDirectory,
          descriptor.paths.reports,
          fsModule
        );
      } catch {
        // Preserve the rehearsal failure.
      }
    }
    if (ownsBackup) {
      try {
        cleanupOwnedDirectory(
          outputs.backupDirectory,
          descriptor.paths.backups,
          fsModule
        );
      } catch {
        // Preserve the rehearsal failure.
      }
    }
    if (error instanceof StagingCutoverRehearsalError) {
      throw error;
    }
    const code =
      typeof error?.code === "string" &&
      error.code.startsWith("BACKUP_")
        ? STAGING_REHEARSAL_ERROR_CODES.backupFailed
        : STAGING_REHEARSAL_ERROR_CODES.publicationFailed;
    fail(
      code,
      "The staging cutover rehearsal failed safely.",
      { cause: error }
    );
  }
}

module.exports = {
  ACTIVATION_CANDIDATE_FILE,
  REHEARSAL_MARKDOWN_FILE,
  REHEARSAL_REPORT_FILE,
  ROLLBACK_CANDIDATE_FILE,
  STAGING_REHEARSAL_ERROR_CODES,
  STAGING_REHEARSAL_VERSION,
  StagingCutoverRehearsalError,
  calculateRehearsalHash,
  rehearseStagingCutover,
  validateRehearsalOutputs,
};
