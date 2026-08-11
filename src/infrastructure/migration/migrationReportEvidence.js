const crypto = require("node:crypto");

const {
  calculateBundleChecksum,
  calculateSourceBundleId,
  canonicalize,
} = require("./sourceInventory");
const {
  calculateSemanticReportHash,
} = require("./importReport");
const {
  REQUIRED_OPERATING_MODE,
  RESET_MANIFEST_ID,
  RESET_OMISSION_POLICY,
  RESET_MANIFEST_VERSION,
  validateResetManifest,
} = require("./resetManifest");

const RESET_MIGRATION_REPORT_EVIDENCE_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_BUNDLE_ID_PATTERN =
  /^source-bundle-v1-[a-f0-9]{64}$/;
const SOURCE_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const STABLE_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RESET_TARGET_TABLES = Object.freeze([
  "player_external_ids",
  "player_source_state",
  "players",
]);
const SOURCE_COLLECTION_COUNT_KEYS = Object.freeze([
  "players",
  "teams",
  "roster_entries",
  "buyout_entries",
  "league_activity",
  "trade_proposals",
  "matchup_weeks",
  "recovery_evidence_files",
  "ignored_metadata_records",
  "never_import_credential_records",
]);

const RESET_MIGRATION_REPORT_EVIDENCE_CODES =
  Object.freeze({
    argumentInvalid:
      "RESET_MIGRATION_REPORT_EVIDENCE_ARGUMENT_INVALID",
    sourceManifestInvalid:
      "RESET_MIGRATION_REPORT_SOURCE_MANIFEST_INVALID",
    importReportInvalid:
      "RESET_MIGRATION_REPORT_IMPORT_REPORT_INVALID",
    resetManifestMismatch:
      "RESET_MIGRATION_REPORT_RESET_MANIFEST_MISMATCH",
    rowInvalid:
      "RESET_MIGRATION_REPORT_ROW_INVALID",
    candidateMissing:
      "RESET_MIGRATION_REPORT_CANDIDATE_MISSING",
    candidateAmbiguous:
      "RESET_MIGRATION_REPORT_CANDIDATE_AMBIGUOUS",
  });

class ResetMigrationReportEvidenceError extends Error {
  constructor(code) {
    super("The reset migration report evidence is invalid.");
    this.name = "ResetMigrationReportEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new ResetMigrationReportEvidenceError(code);
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

function exactObject(value, expectedKeys, code) {
  if (!isPlainObject(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
  return value;
}

function assertJsonValue(value, code, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail(code);
    return;
  }
  if (
    typeof value !== "object" ||
    ancestors.has(value)
  ) {
    fail(code);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      assertJsonValue(child, code, ancestors);
    }
  } else {
    if (!isPlainObject(value)) fail(code);
    for (const [key, child] of Object.entries(value)) {
      if (typeof key !== "string") fail(code);
      assertJsonValue(child, code, ancestors);
    }
  }
  ancestors.delete(value);
}

function nonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code);
  }
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(code);
  }
  return value;
}

function nonemptyString(value, code) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value !== value.trim()
  ) {
    fail(code);
  }
  return value;
}

function optionalBoundedString(value, maximum, code) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    fail(code);
  }
  return value;
}

function digest(value, code) {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    fail(code);
  }
  return value;
}

function stableId(value, code) {
  if (
    typeof value !== "string" ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    fail(code);
  }
  return value;
}

function assertDistinct(values, code) {
  if (new Set(values).size !== values.length) {
    fail(code);
  }
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validateSourceBundleManifest(sourceBundleManifest) {
  const code =
    RESET_MIGRATION_REPORT_EVIDENCE_CODES.sourceManifestInvalid;
  const manifest = exactObject(
    sourceBundleManifest,
    [
      "manifestVersion",
      "capturedAtMs",
      "applicationBuildId",
      "sourceGitCommit",
      "sources",
      "sourceBundleId",
      "bundleChecksum",
    ],
    code
  );
  assertJsonValue(manifest, code);
  if (manifest.manifestVersion !== 1) fail(code);
  nonnegativeInteger(manifest.capturedAtMs, code);
  optionalBoundedString(
    manifest.applicationBuildId,
    500,
    code
  );
  optionalBoundedString(
    manifest.sourceGitCommit,
    500,
    code
  );
  if (
    !SOURCE_BUNDLE_ID_PATTERN.test(
      manifest.sourceBundleId || ""
    )
  ) {
    fail(code);
  }
  digest(manifest.bundleChecksum, code);
  if (
    !Array.isArray(manifest.sources) ||
    manifest.sources.length < 1
  ) {
    fail(code);
  }

  const sourceLabels = [];
  const copiedPaths = [];
  const sourceFiles = [];
  let byteSize = 0;

  for (const source of manifest.sources) {
    exactObject(
      source,
      [
        "label",
        "absolutePath",
        "kind",
        "byteSize",
        "modifiedAtMs",
        "files",
      ],
      code
    );
    if (
      !SOURCE_LABEL_PATTERN.test(source.label || "") ||
      !["file", "directory"].includes(source.kind) ||
      typeof source.absolutePath !== "string" ||
      source.absolutePath.length < 1 ||
      !Array.isArray(source.files) ||
      source.files.length < 1
    ) {
      fail(code);
    }
    sourceLabels.push(source.label);
    nonnegativeInteger(source.byteSize, code);
    nonnegativeInteger(source.modifiedAtMs, code);

    let sourceByteSize = 0;
    for (const file of source.files) {
      exactObject(
        file,
        [
          "sourceRelativePath",
          "copiedPath",
          "byteSize",
          "modifiedAtMs",
          "sha256",
          "json",
        ],
        code
      );
      nonemptyString(file.sourceRelativePath, code);
      nonemptyString(file.copiedPath, code);
      const expectedPrefix = `files/${source.label}/`;
      if (
        !file.copiedPath.startsWith(expectedPrefix) ||
        file.copiedPath.includes("\\") ||
        file.copiedPath
          .split("/")
          .some(
            (segment) =>
              segment === "" ||
              segment === "." ||
              segment === ".."
          )
      ) {
        fail(code);
      }
      const fileByteSize =
        nonnegativeInteger(file.byteSize, code);
      nonnegativeInteger(file.modifiedAtMs, code);
      digest(file.sha256, code);
      assertJsonValue(file.json, code);
      sourceByteSize += fileByteSize;
      byteSize += fileByteSize;
      if (
        !Number.isSafeInteger(sourceByteSize) ||
        !Number.isSafeInteger(byteSize)
      ) {
        fail(code);
      }
      copiedPaths.push(file.copiedPath);
      sourceFiles.push(
        Object.freeze({
          sourceLabel: source.label,
          copiedPath: file.copiedPath,
          byteSize: fileByteSize,
          sha256: file.sha256,
        })
      );
    }
    if (source.byteSize !== sourceByteSize) fail(code);
  }

  assertDistinct(sourceLabels, code);
  assertDistinct(copiedPaths, code);
  if (
    calculateSourceBundleId(manifest) !==
      manifest.sourceBundleId ||
    calculateBundleChecksum(
      Object.fromEntries(
        Object.entries(manifest).filter(
          ([key]) => key !== "bundleChecksum"
        )
      )
    ) !== manifest.bundleChecksum
  ) {
    fail(code);
  }

  sourceFiles.sort(
    (left, right) =>
      compareText(left.sourceLabel, right.sourceLabel) ||
      compareText(left.copiedPath, right.copiedPath)
  );

  return Object.freeze({
    manifest,
    sourceFiles: Object.freeze(sourceFiles),
    sourceCount: manifest.sources.length,
    fileCount: sourceFiles.length,
    byteSize,
  });
}

function projectSanitizedSourceBundleEvidence(
  sourceBundleManifest
) {
  const source = validateSourceBundleManifest(
    sourceBundleManifest
  );
  return Object.freeze({
    id: source.manifest.sourceBundleId,
    checksum: source.manifest.bundleChecksum,
    manifestVersion: source.manifest.manifestVersion,
    capturedAtMs: source.manifest.capturedAtMs,
    sourceCount: source.sourceCount,
    fileCount: source.fileCount,
    byteSize: source.byteSize,
    sourceFiles: source.sourceFiles,
  });
}

function validateKeyedObject(value, valueValidator, code) {
  if (!isPlainObject(value)) fail(code);
  for (const [key, child] of Object.entries(value)) {
    nonemptyString(key, code);
    valueValidator(child, code);
  }
}

function validateStagingDescriptor(value, code) {
  exactObject(
    value,
    [
      "descriptorVersion",
      "environment",
      "resourceIds",
      "applicationAuthority",
      "sqliteApplicationAuthorityEnabled",
      "productionStorageAccessible",
      "productionSecretsAccessible",
    ],
    code
  );
  if (
    value.descriptorVersion !== 1 ||
    value.environment !== "staging" ||
    value.applicationAuthority !== "json" ||
    value.sqliteApplicationAuthorityEnabled !== false ||
    value.productionStorageAccessible !== false ||
    value.productionSecretsAccessible !== false
  ) {
    fail(code);
  }
  validateKeyedObject(
    value.resourceIds,
    nonemptyString,
    code
  );
}

function validateSchema(value, code) {
  exactObject(
    value,
    ["userVersion", "migrationCount", "migrationLedger"],
    code
  );
  const userVersion = positiveInteger(
    value.userVersion,
    code
  );
  const migrationCount = positiveInteger(
    value.migrationCount,
    code
  );
  if (
    !Array.isArray(value.migrationLedger) ||
    value.migrationLedger.length !== migrationCount ||
    userVersion !== migrationCount
  ) {
    fail(code);
  }
  const migrationIds = [];
  let priorId = null;
  for (const migration of value.migrationLedger) {
    exactObject(
      migration,
      ["id", "fileName", "checksum"],
      code
    );
    const id = positiveInteger(migration.id, code);
    nonemptyString(migration.fileName, code);
    digest(migration.checksum, code);
    if (priorId !== null && priorId >= id) {
      fail(code);
    }
    priorId = id;
    migrationIds.push(id);
  }
  assertDistinct(migrationIds, code);
}

function validateTargetTables(value, code) {
  if (
    !Array.isArray(value) ||
    value.length !== RESET_TARGET_TABLES.length
  ) {
    fail(code);
  }
  const names = [];
  for (const target of value) {
    exactObject(
      target,
      [
        "table",
        "plannedRowCount",
        "validatedRowCount",
        "postRollbackRowCount",
        "semanticHash",
      ],
      code
    );
    if (
      !TABLE_NAME_PATTERN.test(target.table || "") ||
      target.postRollbackRowCount !== null
    ) {
      fail(code);
    }
    const planned = nonnegativeInteger(
      target.plannedRowCount,
      code
    );
    if (
      nonnegativeInteger(
        target.validatedRowCount,
        code
      ) !== planned
    ) {
      fail(code);
    }
    digest(target.semanticHash, code);
    names.push(target.table);
  }
  assertDistinct(names, code);
  if (
    [...names].sort(compareText).some(
      (name, index) => name !== RESET_TARGET_TABLES[index]
    )
  ) {
    fail(code);
  }
}

function validateResetOmissions(value, code) {
  if (
    !Array.isArray(value) ||
    value.length !== RESET_OMISSION_POLICY.length
  ) {
    fail(code);
  }
  const familyIds = [];
  for (const omission of value) {
    exactObject(
      omission,
      [
        "familyId",
        "sourceCount",
        "countTreatment",
        "targetTreatment",
        "validatedTargetRowCount",
        "reconciled",
      ],
      code
    );
    const familyId = nonemptyString(
      omission.familyId,
      code
    );
    const policy = RESET_OMISSION_POLICY.find(
      (family) => family.familyId === familyId
    );
    if (
      !policy ||
      omission.countTreatment !==
        policy.countTreatment ||
      omission.targetTreatment !==
        policy.targetTreatment
    ) {
      fail(code);
    }
    familyIds.push(familyId);
    nonnegativeInteger(omission.sourceCount, code);
    nonemptyString(omission.countTreatment, code);
    nonemptyString(omission.targetTreatment, code);
    if (
      omission.validatedTargetRowCount !== 0 ||
      omission.reconciled !== true
    ) {
      fail(code);
    }
  }
  assertDistinct(familyIds, code);
}

function validateChecks(value, code) {
  exactObject(
    value,
    [
      "integrity",
      "foreignKeyViolationCount",
      "stablePlayerExternalIdsPreserved",
      "importedRowsRolledBack",
      "committedRowsVerified",
    ],
    code
  );
  if (
    value.integrity !== "ok" ||
    value.foreignKeyViolationCount !== 0 ||
    value.stablePlayerExternalIdsPreserved !== true ||
    value.importedRowsRolledBack !== false ||
    value.committedRowsVerified !== true
  ) {
    fail(code);
  }
}

function validateMoneyEvidence(value, code) {
  exactObject(
    value,
    [
      "sourceCount",
      "sourceSumCents",
      "importedCount",
      "importedSumCents",
      "omittedCount",
      "omittedSumCents",
      "reconciled",
      "families",
    ],
    code
  );
  const aggregateFields = [
    "sourceCount",
    "sourceSumCents",
    "importedCount",
    "importedSumCents",
    "omittedCount",
    "omittedSumCents",
  ];
  for (const field of aggregateFields) {
    nonnegativeInteger(value[field], code);
  }
  if (
    value.reconciled !== true ||
    !Array.isArray(value.families) ||
    value.families.length !== 4 ||
    value.sourceCount !==
      value.importedCount + value.omittedCount ||
    value.sourceSumCents !==
      value.importedSumCents + value.omittedSumCents
  ) {
    fail(code);
  }

  const expectedFamilies = [
    "season_1_buyouts",
    "season_1_contracts",
    "season_1_retention",
    "season_1_trades",
  ];
  const actualFamilies = [];
  const totals = Object.fromEntries(
    aggregateFields.map((field) => [field, 0])
  );
  for (const family of value.families) {
    exactObject(
      family,
      [
        "familyId",
        "sourceCount",
        "sourceSumCents",
        "importedCount",
        "importedSumCents",
        "omittedCount",
        "omittedSumCents",
        "reconciled",
      ],
      code
    );
    actualFamilies.push(
      nonemptyString(family.familyId, code)
    );
    for (const field of aggregateFields) {
      totals[field] += nonnegativeInteger(
        family[field],
        code
      );
      if (!Number.isSafeInteger(totals[field])) fail(code);
    }
    if (
      family.reconciled !== true ||
      family.sourceCount !==
        family.importedCount + family.omittedCount ||
      family.sourceSumCents !==
        family.importedSumCents +
          family.omittedSumCents
    ) {
      fail(code);
    }
  }
  if (
    [...actualFamilies].sort(compareText).some(
      (familyId, index) =>
        familyId !== expectedFamilies[index]
    ) ||
    aggregateFields.some(
      (field) => totals[field] !== value[field]
    )
  ) {
    fail(code);
  }
}

function validateOwnershipEvidence(value, code) {
  exactObject(
    value,
    [
      "sourceCount",
      "importedCount",
      "omittedCount",
      "duplicateTargetPlayerCount",
      "reconciled",
    ],
    code
  );
  for (const field of [
    "sourceCount",
    "importedCount",
    "omittedCount",
    "duplicateTargetPlayerCount",
  ]) {
    nonnegativeInteger(value[field], code);
  }
  if (
    value.reconciled !== true ||
    value.duplicateTargetPlayerCount !== 0 ||
    value.sourceCount !==
      value.importedCount + value.omittedCount
  ) {
    fail(code);
  }
}

function validateImportReport(importReport, source) {
  const code =
    RESET_MIGRATION_REPORT_EVIDENCE_CODES.importReportInvalid;
  const report = exactObject(
    importReport,
    [
      "reportVersion",
      "importerVersion",
      "status",
      "dryRun",
      "importedRowsRetained",
      "environment",
      "stagingDescriptor",
      "sourceBundle",
      "resetManifest",
      "schema",
      "sourceShapes",
      "sourceCollectionCounts",
      "targetTables",
      "resetOmissions",
      "protectedFamilies",
      "neverImportFamilies",
      "mappingEntries",
      "money",
      "ownership",
      "checks",
      "rejects",
      "quarantine",
      "repairs",
      "defaults",
      "warnings",
      "semanticReportHash",
    ],
    code
  );
  assertJsonValue(report, code);
  if (
    report.reportVersion !== 1 ||
    report.importerVersion !== 1 ||
    report.status !== "valid" ||
    report.dryRun !== false ||
    report.importedRowsRetained !== true ||
    report.environment !== "staging" ||
    calculateSemanticReportHash(report) !==
      report.semanticReportHash
  ) {
    fail(code);
  }
  digest(report.semanticReportHash, code);
  validateStagingDescriptor(report.stagingDescriptor, code);

  exactObject(
    report.sourceBundle,
    [
      "id",
      "checksum",
      "manifestVersion",
      "capturedAtMs",
      "sourceCount",
      "fileCount",
      "byteSize",
    ],
    code
  );
  if (
    report.sourceBundle.id !==
      source.manifest.sourceBundleId ||
    report.sourceBundle.checksum !==
      source.manifest.bundleChecksum ||
    report.sourceBundle.manifestVersion !==
      source.manifest.manifestVersion ||
    report.sourceBundle.capturedAtMs !==
      source.manifest.capturedAtMs ||
    report.sourceBundle.sourceCount !==
      source.sourceCount ||
    report.sourceBundle.fileCount !== source.fileCount ||
    report.sourceBundle.byteSize !== source.byteSize
  ) {
    fail(code);
  }

  exactObject(
    report.resetManifest,
    ["id", "version", "checksum"],
    code
  );
  if (
    report.resetManifest.id !== RESET_MANIFEST_ID ||
    report.resetManifest.version !==
      RESET_MANIFEST_VERSION
  ) {
    fail(
      RESET_MIGRATION_REPORT_EVIDENCE_CODES
        .resetManifestMismatch
    );
  }
  digest(report.resetManifest.checksum, code);

  validateSchema(report.schema, code);
  validateKeyedObject(
    report.sourceShapes,
    nonemptyString,
    code
  );
  validateKeyedObject(
    report.sourceCollectionCounts,
    nonnegativeInteger,
    code
  );
  const collectionKeys = Object.keys(
    report.sourceCollectionCounts
  ).sort(compareText);
  if (
    collectionKeys.length !==
      SOURCE_COLLECTION_COUNT_KEYS.length ||
    collectionKeys.some(
      (key, index) =>
        key !==
        [...SOURCE_COLLECTION_COUNT_KEYS].sort(compareText)[
          index
        ]
    )
  ) {
    fail(code);
  }
  validateTargetTables(report.targetTables, code);
  validateResetOmissions(report.resetOmissions, code);
  for (const field of [
    "protectedFamilies",
    "neverImportFamilies",
    "mappingEntries",
    "repairs",
    "defaults",
    "warnings",
  ]) {
    if (!Array.isArray(report[field])) fail(code);
  }
  if (
    !Array.isArray(report.rejects) ||
    report.rejects.length !== 0 ||
    !Array.isArray(report.quarantine) ||
    report.quarantine.length !== 0 ||
    report.warnings.length !== 0 ||
    !isPlainObject(report.money) ||
    !isPlainObject(report.ownership)
  ) {
    fail(code);
  }
  validateChecks(report.checks, code);
  validateMoneyEvidence(report.money, code);
  validateOwnershipEvidence(report.ownership, code);
  return report;
}

function sha256Bytes(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function canonicalEqual(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function calculateVerificationHash(evidence) {
  const payload = { ...evidence };
  delete payload.verificationHash;
  return sha256Bytes(canonicalize(payload));
}

function validateApprovedResetManifest(
  resetManifest,
  sourceManifestVersion
) {
  try {
    return validateResetManifest(resetManifest, {
      operatingMode: REQUIRED_OPERATING_MODE,
      sourceBundleManifestVersion:
        sourceManifestVersion,
    });
  } catch {
    fail(
      RESET_MIGRATION_REPORT_EVIDENCE_CODES
        .resetManifestMismatch
    );
  }
}

function validateVerificationChecks(value, code) {
  exactObject(
    value,
    [
      "integrity",
      "foreignKeyViolationCount",
      "stablePlayerExternalIdsPreserved",
      "sourceBundleVerified",
      "resetManifestVerified",
      "canonicalImportReportVerified",
      "allApplicationTableCountsVerified",
      "semanticHashesVerified",
      "applicationAuthority",
      "sqliteApplicationAuthorityEnabled",
      "productionStorageAccessible",
      "productionSecretsAccessible",
      "inputsUnchanged",
    ],
    code
  );
  if (
    value.integrity !== "ok" ||
    value.foreignKeyViolationCount !== 0 ||
    value.stablePlayerExternalIdsPreserved !== true ||
    value.sourceBundleVerified !== true ||
    value.resetManifestVerified !== true ||
    value.canonicalImportReportVerified !== true ||
    value.allApplicationTableCountsVerified !== true ||
    value.semanticHashesVerified !== true ||
    value.applicationAuthority !== "json" ||
    value.sqliteApplicationAuthorityEnabled !== false ||
    value.productionStorageAccessible !== false ||
    value.productionSecretsAccessible !== false ||
    value.inputsUnchanged !== true
  ) {
    fail(code);
  }
}

function validateVerificationEvidence({
  verificationEvidence,
  report,
  source,
  resetManifest,
}) {
  const code =
    RESET_MIGRATION_REPORT_EVIDENCE_CODES.importReportInvalid;
  const evidence = exactObject(
    verificationEvidence,
    [
      "verificationVersion",
      "status",
      "environment",
      "sourceBundle",
      "resetManifest",
      "database",
      "importReport",
      "reconciliation",
      "checks",
      "verificationHash",
    ],
    code
  );
  assertJsonValue(evidence, code);
  if (
    evidence.verificationVersion !== 1 ||
    evidence.status !== "verified" ||
    evidence.environment !== "staging" ||
    !DIGEST_PATTERN.test(evidence.verificationHash || "") ||
    calculateVerificationHash(evidence) !==
      evidence.verificationHash ||
    !canonicalEqual(
      evidence.sourceBundle,
      report.sourceBundle
    ) ||
    !canonicalEqual(
      evidence.resetManifest,
      report.resetManifest
    ) ||
    evidence.resetManifest.checksum !==
      resetManifest.checksum
  ) {
    fail(code);
  }

  exactObject(
    evidence.database,
    [
      "sha256",
      "bytes",
      "userVersion",
      "migrationLedger",
      "targetTables",
      "seededApplicationMetadataRowCount",
      "emptyApplicationTableCount",
    ],
    code
  );
  digest(evidence.database.sha256, code);
  positiveInteger(evidence.database.bytes, code);
  nonnegativeInteger(
    evidence.database.emptyApplicationTableCount,
    code
  );
  if (
    evidence.database.seededApplicationMetadataRowCount !==
      2 ||
    evidence.database.userVersion !==
      report.schema.userVersion ||
    !canonicalEqual(
      evidence.database.migrationLedger,
      report.schema.migrationLedger
    ) ||
    !canonicalEqual(
      evidence.database.targetTables,
      report.targetTables
    )
  ) {
    fail(code);
  }
  validateSchema(
    {
      userVersion: evidence.database.userVersion,
      migrationCount:
        evidence.database.migrationLedger.length,
      migrationLedger:
        evidence.database.migrationLedger,
    },
    code
  );
  validateTargetTables(
    evidence.database.targetTables,
    code
  );

  exactObject(
    evidence.importReport,
    ["sha256", "bytes", "semanticReportHash"],
    code
  );
  digest(evidence.importReport.sha256, code);
  positiveInteger(evidence.importReport.bytes, code);
  const canonicalReportBytes =
    `${canonicalize(report)}\n`;
  if (
    evidence.importReport.sha256 !==
      sha256Bytes(canonicalReportBytes) ||
    evidence.importReport.bytes !==
      Buffer.byteLength(canonicalReportBytes) ||
    evidence.importReport.semanticReportHash !==
      report.semanticReportHash
  ) {
    fail(code);
  }

  exactObject(
    evidence.reconciliation,
    [
      "omissionFamilyCount",
      "protectedFamilyCount",
      "neverImportFamilyCount",
      "mappingEntryCount",
      "mappingSha256",
      "money",
      "ownership",
    ],
    code
  );
  for (const field of [
    "omissionFamilyCount",
    "protectedFamilyCount",
    "neverImportFamilyCount",
    "mappingEntryCount",
  ]) {
    nonnegativeInteger(
      evidence.reconciliation[field],
      code
    );
  }
  digest(evidence.reconciliation.mappingSha256, code);
  if (
    evidence.reconciliation.omissionFamilyCount !==
      report.resetOmissions.length ||
    evidence.reconciliation.protectedFamilyCount !==
      report.protectedFamilies.length ||
    evidence.reconciliation.neverImportFamilyCount !==
      report.neverImportFamilies.length ||
    evidence.reconciliation.mappingEntryCount !==
      report.mappingEntries.length ||
    evidence.reconciliation.mappingSha256 !==
      sha256Bytes(canonicalize(report.mappingEntries)) ||
    !canonicalEqual(
      evidence.reconciliation.money,
      report.money
    ) ||
    !canonicalEqual(
      evidence.reconciliation.ownership,
      report.ownership
    )
  ) {
    fail(code);
  }
  validateMoneyEvidence(
    evidence.reconciliation.money,
    code
  );
  validateOwnershipEvidence(
    evidence.reconciliation.ownership,
    code
  );
  validateVerificationChecks(evidence.checks, code);
  return evidence;
}

function targetCountEvidence(target) {
  return Object.freeze({
    table: target.table,
    plannedRowCount: target.plannedRowCount,
    validatedRowCount: target.validatedRowCount,
    semanticHash: target.semanticHash,
  });
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function parseCanonicalJson(value, code) {
  if (typeof value !== "string" || value.length < 1) {
    fail(code);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(code);
  }
  assertJsonValue(parsed, code);
  if (canonicalize(parsed) !== value) fail(code);
  return deepFreeze(parsed);
}

function validatePersistedSourceHashes(value, code) {
  exactObject(
    value,
    [
      "evidenceVersion",
      "sourceBundle",
      "sourceFiles",
      "resetManifest",
      "importReport",
    ],
    code
  );
  if (
    value.evidenceVersion !==
    RESET_MIGRATION_REPORT_EVIDENCE_VERSION
  ) {
    fail(code);
  }

  exactObject(
    value.sourceBundle,
    ["id", "checksum", "manifestVersion"],
    code
  );
  if (
    !SOURCE_BUNDLE_ID_PATTERN.test(
      value.sourceBundle.id || ""
    ) ||
    value.sourceBundle.manifestVersion !== 1
  ) {
    fail(code);
  }
  digest(value.sourceBundle.checksum, code);

  if (
    !Array.isArray(value.sourceFiles) ||
    value.sourceFiles.length < 1
  ) {
    fail(code);
  }
  let priorKey = null;
  const copiedPaths = [];
  for (const file of value.sourceFiles) {
    exactObject(
      file,
      ["sourceLabel", "copiedPath", "byteSize", "sha256"],
      code
    );
    if (
      !SOURCE_LABEL_PATTERN.test(file.sourceLabel || "") ||
      typeof file.copiedPath !== "string" ||
      !file.copiedPath.startsWith(
        `files/${file.sourceLabel}/`
      ) ||
      file.copiedPath.includes("\\") ||
      file.copiedPath
        .split("/")
        .some(
          (segment) =>
            segment === "" ||
            segment === "." ||
            segment === ".."
        )
    ) {
      fail(code);
    }
    nonnegativeInteger(file.byteSize, code);
    digest(file.sha256, code);
    const sortKey =
      `${file.sourceLabel}\u0000${file.copiedPath}`;
    if (
      priorKey !== null &&
      compareText(priorKey, sortKey) >= 0
    ) {
      fail(code);
    }
    priorKey = sortKey;
    copiedPaths.push(file.copiedPath);
  }
  assertDistinct(copiedPaths, code);

  exactObject(
    value.resetManifest,
    ["id", "version", "checksum"],
    code
  );
  if (
    value.resetManifest.id !== RESET_MANIFEST_ID ||
    value.resetManifest.version !== RESET_MANIFEST_VERSION
  ) {
    fail(code);
  }
  digest(value.resetManifest.checksum, code);

  exactObject(
    value.importReport,
    ["reportVersion", "importerVersion", "semanticHash"],
    code
  );
  if (
    value.importReport.reportVersion !== 1 ||
    value.importReport.importerVersion !== 1
  ) {
    fail(code);
  }
  digest(value.importReport.semanticHash, code);
}

function validatePersistedTargetTables(value, code) {
  if (
    !Array.isArray(value) ||
    value.length !== RESET_TARGET_TABLES.length
  ) {
    fail(code);
  }
  const names = [];
  for (const target of value) {
    exactObject(
      target,
      [
        "table",
        "plannedRowCount",
        "validatedRowCount",
        "semanticHash",
      ],
      code
    );
    if (!TABLE_NAME_PATTERN.test(target.table || "")) {
      fail(code);
    }
    const planned = nonnegativeInteger(
      target.plannedRowCount,
      code
    );
    if (
      nonnegativeInteger(
        target.validatedRowCount,
        code
      ) !== planned
    ) {
      fail(code);
    }
    digest(target.semanticHash, code);
    names.push(target.table);
  }
  assertDistinct(names, code);
  if (
    [...names].sort(compareText).some(
      (name, index) => name !== RESET_TARGET_TABLES[index]
    )
  ) {
    fail(code);
  }
}

function validatePersistedCounts(value, code) {
  exactObject(
    value,
    [
      "evidenceVersion",
      "sourceCollections",
      "targetTables",
      "resetOmissions",
      "blockingRejectCount",
      "warningCount",
    ],
    code
  );
  if (
    value.evidenceVersion !==
      RESET_MIGRATION_REPORT_EVIDENCE_VERSION ||
    value.blockingRejectCount !== 0
  ) {
    fail(code);
  }
  validateKeyedObject(
    value.sourceCollections,
    nonnegativeInteger,
    code
  );
  const collectionKeys = Object.keys(
    value.sourceCollections
  ).sort(compareText);
  const expectedCollectionKeys = [
    ...SOURCE_COLLECTION_COUNT_KEYS,
  ].sort(compareText);
  if (
    collectionKeys.length !==
      expectedCollectionKeys.length ||
    collectionKeys.some(
      (key, index) =>
        key !== expectedCollectionKeys[index]
    )
  ) {
    fail(code);
  }
  validatePersistedTargetTables(
    value.targetTables,
    code
  );
  validateResetOmissions(value.resetOmissions, code);
  nonnegativeInteger(value.warningCount, code);
}

function validatePersistedTotals(value, code) {
  exactObject(
    value,
    ["evidenceVersion", "money", "ownership"],
    code
  );
  if (
    value.evidenceVersion !==
      RESET_MIGRATION_REPORT_EVIDENCE_VERSION ||
    !isPlainObject(value.money) ||
    !isPlainObject(value.ownership)
  ) {
    fail(code);
  }
  validateMoneyEvidence(value.money, code);
  validateOwnershipEvidence(value.ownership, code);
}

function validateSucceededResetMigrationReportRow(row) {
  const code =
    RESET_MIGRATION_REPORT_EVIDENCE_CODES.rowInvalid;
  exactObject(
    row,
    [
      "id",
      "league_id",
      "source_bundle_id",
      "reset_manifest_id",
      "database_schema_version",
      "status",
      "source_hashes_json",
      "counts_json",
      "totals_json",
      "warnings_json",
      "rejects_json",
      "started_at_ms",
      "completed_at_ms",
      "created_at_ms",
    ],
    code
  );
  const id = stableId(row.id, code);
  const leagueId = stableId(row.league_id, code);
  if (
    !SOURCE_BUNDLE_ID_PATTERN.test(
      row.source_bundle_id || ""
    ) ||
    row.reset_manifest_id !== RESET_MANIFEST_ID ||
    row.status !== "succeeded"
  ) {
    fail(code);
  }
  const databaseSchemaVersion = positiveInteger(
    row.database_schema_version,
    code
  );
  const startedAtMs = nonnegativeInteger(
    row.started_at_ms,
    code
  );
  const completedAtMs = nonnegativeInteger(
    row.completed_at_ms,
    code
  );
  const createdAtMs = nonnegativeInteger(
    row.created_at_ms,
    code
  );
  if (
    completedAtMs < startedAtMs ||
    createdAtMs < startedAtMs ||
    createdAtMs > completedAtMs
  ) {
    fail(code);
  }

  const sourceHashes = parseCanonicalJson(
    row.source_hashes_json,
    code
  );
  const counts = parseCanonicalJson(
    row.counts_json,
    code
  );
  const totals = parseCanonicalJson(
    row.totals_json,
    code
  );
  const warnings = parseCanonicalJson(
    row.warnings_json,
    code
  );
  const rejects = parseCanonicalJson(
    row.rejects_json,
    code
  );
  validatePersistedSourceHashes(sourceHashes, code);
  validatePersistedCounts(counts, code);
  validatePersistedTotals(totals, code);
  if (
    !Array.isArray(warnings) ||
    !Array.isArray(rejects) ||
    rejects.length !== 0 ||
    counts.warningCount !== 0 ||
    warnings.length !== 0 ||
    sourceHashes.sourceBundle.id !==
      row.source_bundle_id ||
    sourceHashes.resetManifest.id !==
      row.reset_manifest_id
  ) {
    fail(code);
  }

  return Object.freeze({
    id,
    leagueId,
    sourceBundleId: row.source_bundle_id,
    resetManifestId: row.reset_manifest_id,
    databaseSchemaVersion,
    status: row.status,
    sourceHashes,
    counts,
    totals,
    warnings,
    rejects,
    startedAtMs,
    completedAtMs,
    createdAtMs,
  });
}

function findExactResetEvidenceCandidate(input) {
  const argumentCode =
    RESET_MIGRATION_REPORT_EVIDENCE_CODES.argumentInvalid;
  exactObject(input, ["leagueId", "rows"], argumentCode);
  const leagueId = stableId(
    input.leagueId,
    argumentCode
  );
  if (!Array.isArray(input.rows)) fail(argumentCode);
  for (const row of input.rows) {
    if (!isPlainObject(row)) {
      fail(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES.rowInvalid
      );
    }
  }

  const candidates = input.rows.filter(
    (row) =>
      row.league_id === leagueId &&
      row.status === "succeeded" &&
      row.completed_at_ms !== null &&
      row.reset_manifest_id === RESET_MANIFEST_ID &&
      Number.isSafeInteger(
        row.database_schema_version
      ) &&
      row.database_schema_version >= 1
  );
  if (candidates.length === 0) {
    fail(
      RESET_MIGRATION_REPORT_EVIDENCE_CODES.candidateMissing
    );
  }
  if (candidates.length !== 1) {
    fail(
      RESET_MIGRATION_REPORT_EVIDENCE_CODES
        .candidateAmbiguous
    );
  }
  return validateSucceededResetMigrationReportRow(
    candidates[0]
  );
}

function projectSucceededResetMigrationReport(input) {
  const code =
    RESET_MIGRATION_REPORT_EVIDENCE_CODES.argumentInvalid;
  exactObject(
    input,
    [
      "sourceBundleManifest",
      "resetManifest",
      "importReport",
      "verificationEvidence",
    ],
    code
  );
  const source = validateSourceBundleManifest(
    input.sourceBundleManifest
  );
  const report = validateImportReport(
    input.importReport,
    source
  );
  const resetManifest = validateApprovedResetManifest(
    input.resetManifest,
    source.manifest.manifestVersion
  );
  if (
    report.resetManifest.id !==
      resetManifest.manifestId ||
    report.resetManifest.version !==
      resetManifest.manifestVersion ||
    report.resetManifest.checksum !==
      resetManifest.checksum
  ) {
    fail(
      RESET_MIGRATION_REPORT_EVIDENCE_CODES
        .resetManifestMismatch
    );
  }
  validateVerificationEvidence({
    verificationEvidence: input.verificationEvidence,
    report,
    source,
    resetManifest,
  });

  const sourceHashes = Object.freeze({
    evidenceVersion:
      RESET_MIGRATION_REPORT_EVIDENCE_VERSION,
    sourceBundle: Object.freeze({
      id: source.manifest.sourceBundleId,
      checksum: source.manifest.bundleChecksum,
      manifestVersion: source.manifest.manifestVersion,
    }),
    sourceFiles: source.sourceFiles,
    resetManifest: Object.freeze({
      id: report.resetManifest.id,
      version: report.resetManifest.version,
      checksum: report.resetManifest.checksum,
    }),
    importReport: Object.freeze({
      reportVersion: report.reportVersion,
      importerVersion: report.importerVersion,
      semanticHash: report.semanticReportHash,
    }),
  });
  const counts = Object.freeze({
    evidenceVersion:
      RESET_MIGRATION_REPORT_EVIDENCE_VERSION,
    sourceCollections: report.sourceCollectionCounts,
    targetTables: Object.freeze(
      report.targetTables.map(targetCountEvidence)
    ),
    resetOmissions: report.resetOmissions,
    blockingRejectCount: report.rejects.length,
    warningCount: report.warnings.length,
  });
  const totals = Object.freeze({
    evidenceVersion:
      RESET_MIGRATION_REPORT_EVIDENCE_VERSION,
    money: report.money,
    ownership: report.ownership,
  });

  return Object.freeze({
    sourceBundleId: source.manifest.sourceBundleId,
    resetManifestId: report.resetManifest.id,
    databaseSchemaVersion: report.schema.userVersion,
    status: "succeeded",
    sourceHashesJson: canonicalize(sourceHashes),
    countsJson: canonicalize(counts),
    totalsJson: canonicalize(totals),
    warningsJson: canonicalize(report.warnings),
    rejectsJson: canonicalize(report.rejects),
  });
}

module.exports = {
  RESET_MIGRATION_REPORT_EVIDENCE_CODES,
  RESET_MIGRATION_REPORT_EVIDENCE_VERSION,
  ResetMigrationReportEvidenceError,
  findExactResetEvidenceCandidate,
  projectSanitizedSourceBundleEvidence,
  projectSucceededResetMigrationReport,
  validateSucceededResetMigrationReportRow,
};
