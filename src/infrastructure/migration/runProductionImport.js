const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase, openReadonlyDatabase } = require("../database/connection");
const { discoverMigrations, migrateDatabase, readAppliedMigrations } = require("../database/migrate");
const { createSqliteRepositoryContext } = require("../persistence/sqlite/createSqliteRepositoryContext");
const { finalizeImportReport, publishImportReport } = require("./importReport");
const { loadAndValidateResetManifest } = require("./resetManifest");
const { canonicalize, verifySourceBundle, SOURCE_BUNDLE_FILE_NAME } = require("./sourceInventory");
const { adaptVerifiedSourceBundle, NHL_PROVIDER } = require("./sourceShapeAdapters");
const {
  JSON_IMPORTER_VERSION, JsonImportError, assertResetReconciliation,
  buildProtectedReport, buildNeverImportReport, tableSemanticHash,
} = require("./runJsonImport");
const { buildMoneyAndOwnership, buildResetOmissions } = require("./runStagingImport");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const HASH = /^[a-f0-9]{64}$/;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(code, message, cause) {
  throw new JsonImportError(code, message, cause ? { cause } : undefined);
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function overlaps(a, b) { return a === b || inside(a, b) || inside(b, a); }
function flushFile(file) {
  physical(file, false);
  const descriptor = fs.openSync(file, "r+");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function flushDirectory(directory) {
  // Windows fixtures cannot establish Linux directory-fsync durability.
  if (process.platform === "win32") return false;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  return true;
}
function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value !== path.resolve(value)) {
    fail("IMPORT_PATH_UNSAFE", "Import paths must be explicit normalized absolute paths.");
  }
  return value;
}
function physical(value, directory) {
  absolute(value);
  // Reject links at every existing component, including Windows junctions.
  let cursor = value;
  while (true) {
    if (fs.lstatSync(cursor).isSymbolicLink()) fail("IMPORT_PATH_UNSAFE", "Import paths cannot traverse symbolic links.");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const stat = fs.statSync(value);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    fail("IMPORT_PATH_UNSAFE", "An import input has the wrong file type.");
  }
  return fs.realpathSync(value);
}
function assertPinnedInputs(options) {
  const manifest = path.join(options.sourceBundleDirectory, SOURCE_BUNDLE_FILE_NAME);
  if (sha(fs.readFileSync(manifest)) !== options.sourceSha256 ||
      sha(fs.readFileSync(options.resetManifestPath)) !== options.resetSha256) {
    fail("IMPORT_INPUT_CHANGED", "The source bundle or reset manifest differs from the reviewed checksum.");
  }
  verifySourceBundle({ bundleDirectory: options.sourceBundleDirectory });
  if (sha(fs.readFileSync(manifest)) !== options.sourceSha256 ||
      sha(fs.readFileSync(options.resetManifestPath)) !== options.resetSha256) {
    fail("IMPORT_INPUT_CHANGED", "An import input changed during verification.");
  }
}
function prepare(options = {}) {
  if (options.environment !== "production" || options.operatingMode !== "OFFSEASON_RESET" ||
      !HASH.test(options.sourceSha256) || !HASH.test(options.resetSha256) ||
      !/^[a-f0-9]{40}$/.test(options.applicationBuildId) ||
      !Number.isSafeInteger(options.expectedSchemaVersion) || options.expectedSchemaVersion < 1) {
    fail("IMPORT_ARGUMENT_INVALID", "Production import requires exact checksums, build, schema and OFFSEASON_RESET.");
  }
  const persistentRoot = physical(options.persistentRoot, true);
  const sourceBundleDirectory = physical(options.sourceBundleDirectory, true);
  const resetManifestPath = physical(options.resetManifestPath, false);
  const target = absolute(options.targetDirectory);
  const parent = physical(path.dirname(target), true);
  const targetDirectory = path.join(parent, path.basename(target));
  if (fs.existsSync(targetDirectory) || !inside(persistentRoot, targetDirectory) ||
      !inside(persistentRoot, sourceBundleDirectory) ||
      overlaps(persistentRoot, fs.realpathSync(REPOSITORY_ROOT)) ||
      overlaps(sourceBundleDirectory, targetDirectory) ||
      overlaps(resetManifestPath, targetDirectory)) {
    fail("IMPORT_PATH_UNSAFE", "Import needs an absent target isolated from its inputs and the repository.");
  }
  const pinned = { ...options, sourceBundleDirectory, resetManifestPath };
  assertPinnedInputs(pinned);
  const adapted = adaptVerifiedSourceBundle({ bundleDirectory: sourceBundleDirectory });
  const manifest = loadAndValidateResetManifest({
    manifestPath: resetManifestPath, operatingMode: options.operatingMode,
    sourceBundleManifestVersion: adapted.sourceBundle.manifestVersion,
  });
  assertResetReconciliation(adapted, manifest);
  const protectedFamilies = buildProtectedReport(adapted, manifest);
  const neverImportFamilies = buildNeverImportReport(adapted, manifest);
  const reconciliation = buildMoneyAndOwnership(adapted);
  if (adapted.rejects.length || adapted.quarantine.length) {
    fail("IMPORT_PROTECTED_DATA_AT_RISK", "Production import cannot proceed with unresolved source records.");
  }
  const migrationsDirectory = path.join(REPOSITORY_ROOT, "database", "migrations");
  const migrations = discoverMigrations({ migrationsDirectory });
  if (migrations.at(-1)?.id !== options.expectedSchemaVersion) {
    fail("IMPORT_SCHEMA_MISMATCH", "The reviewed schema differs from this release's migrations.");
  }
  const plan = {
    planVersion: 1, operation: "production-json-import", environment: "production",
    operatingMode: options.operatingMode, applicationBuildId: options.applicationBuildId,
    persistentRoot, targetDirectory, databasePath: path.join(targetDirectory, "candidate.sqlite3"),
    sourceBundleDirectory, sourceSha256: options.sourceSha256,
    sourceBundleId: adapted.sourceBundle.id, sourceBundleChecksum: adapted.sourceBundle.checksum,
    resetManifestPath, resetSha256: options.resetSha256, resetManifestId: manifest.manifestId,
    resetManifestChecksum: manifest.checksum, expectedSchemaVersion: options.expectedSchemaVersion,
    migrations: migrations.map(({ id, fileName, checksum }) => ({ id, fileName, checksum })),
    plannedRowCount: Object.values(adapted.rows).reduce((sum, rows) => sum + rows.length, 0),
    blockingRejectCount: adapted.rejects.length, quarantineCount: adapted.quarantine.length,
    activatesDatabase: false, initializesEnvironmentIdentity: false,
  };
  plan.planSha256 = sha(canonicalize(plan));
  return { plan: Object.freeze(plan), pinned, adapted, manifest, protectedFamilies,
    neverImportFamilies, reconciliation, migrationsDirectory };
}

function planProductionImport(options) {
  try { return prepare(options).plan; }
  catch (error) { throw safeFailure(error); }
}
function safeFailure(error) {
  if (error instanceof JsonImportError) return error;
  return new JsonImportError("IMPORT_RECONCILIATION_FAILED", "Production import stopped; retain the attempt for review.", { cause: error });
}
function verifyRows(database, adapted, expectedTables) {
  for (const target of expectedTables) {
    if (database.prepare(`SELECT COUNT(*) AS count FROM "${target.table}"`).get().count !== target.validatedRowCount ||
        tableSemanticHash(database, target.table) !== target.semanticHash) {
      fail("IMPORT_RECONCILIATION_FAILED", "Imported row counts or values differ from the validated plan.");
    }
  }
  const expectedIds = adapted.rows.player_external_ids.map((row) => row.external_value).sort();
  const ids = database.prepare("SELECT external_value FROM player_external_ids WHERE provider = ? ORDER BY external_value").all(NHL_PROVIDER).map((row) => row.external_value);
  if (canonicalize(expectedIds) !== canonicalize(ids) ||
      database.pragma("integrity_check", { simple: true }) !== "ok" ||
      database.pragma("foreign_key_check").length !== 0) {
    fail("IMPORT_RECONCILIATION_FAILED", "Production import failed integrity, relationship or player identity checks.");
  }
}
function runProductionImport(options, { publishReport = publishImportReport } = {}) {
  let database, plan, ownsTarget = false;
  try {
    const prepared = prepare(options);
    ({ plan } = prepared);
    if (options.productionConfirmation !== plan.planSha256) {
      fail("IMPORT_PRODUCTION_CONFIRMATION_REQUIRED", "Confirm the exact reviewed production import plan checksum.");
    }
    // This confirmation is an operator accident barrier, not production authorization.
    // The cutover procedure must independently prove the source write freeze and approval.
    fs.mkdirSync(plan.targetDirectory, { mode: 0o700 });
    ownsTarget = true;
    fs.writeFileSync(path.join(plan.targetDirectory, "import-plan.json"), canonicalize(plan) + "\n", { flag: "wx", mode: 0o600, flush: true });
    fs.closeSync(fs.openSync(plan.databasePath, "wx", 0o600));
    database = openDatabase({ databasePath: plan.databasePath, environment: "production",
      persistentRoot: plan.persistentRoot, requirePersistentRoot: true }).database;
    migrateDatabase({ database, migrationsDirectory: prepared.migrationsDirectory,
      applicationBuildId: plan.applicationBuildId, now: () => prepared.adapted.sourceBundle.capturedAtMs });
    if (database.pragma("user_version", { simple: true }) !== plan.expectedSchemaVersion) {
      fail("IMPORT_SCHEMA_MISMATCH", "The imported database does not have the reviewed schema.");
    }
    const ledger = readAppliedMigrations(database).map(({ id, fileName, checksum }) => ({ id, fileName, checksum }));
    if (canonicalize(ledger) !== canonicalize(plan.migrations)) {
      fail("IMPORT_SCHEMA_MISMATCH", "Applied migrations differ from the reviewed ledger.");
    }
    const repositories = createSqliteRepositoryContext({ database });
    const targetTables = [];
    database.exec("BEGIN IMMEDIATE;");
    for (const [table, rows] of Object.entries(prepared.adapted.rows)) {
      const repository = repositories.getRepository(table);
      for (const row of rows) repository.insert(row);
      const count = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count;
      if (count !== rows.length) fail("IMPORT_RECONCILIATION_FAILED", "An imported table count differs from the plan.");
      targetTables.push({ table, plannedRowCount: rows.length, validatedRowCount: count,
        postRollbackRowCount: null, semanticHash: tableSemanticHash(database, table) });
    }
    verifyRows(database, prepared.adapted, targetTables);
    assertPinnedInputs(prepared.pinned);
    database.exec("COMMIT;");
    verifyRows(database, prepared.adapted, targetTables);
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.close(); database = null;
    assertPinnedInputs(prepared.pinned);
    const report = finalizeImportReport({
      importerVersion: JSON_IMPORTER_VERSION, status: "valid", dryRun: false,
      importedRowsRetained: true, environment: "production",
      sourceBundle: prepared.adapted.sourceBundle,
      resetManifest: { id: prepared.manifest.manifestId, version: prepared.manifest.manifestVersion, checksum: prepared.manifest.checksum },
      schema: { userVersion: plan.expectedSchemaVersion, migrationCount: ledger.length, migrationLedger: ledger },
      sourceShapes: prepared.adapted.sourceShapes, sourceCollectionCounts: prepared.adapted.sourceCollectionCounts,
      targetTables, resetOmissions: buildResetOmissions(prepared.adapted, prepared.manifest),
      protectedFamilies: prepared.protectedFamilies, neverImportFamilies: prepared.neverImportFamilies,
      mappingEntries: prepared.adapted.mappings, ...prepared.reconciliation,
      checks: { integrity: "ok", foreignKeyViolationCount: 0, stablePlayerExternalIdsPreserved: true,
        importedRowsRolledBack: false, committedRowsVerified: true },
      rejects: prepared.adapted.rejects, quarantine: prepared.adapted.quarantine,
      repairs: prepared.adapted.repairs, defaults: prepared.adapted.defaults, warnings: prepared.adapted.warnings,
    });
    publishReport({ report, reportDirectory: path.join(plan.targetDirectory, "report") });
    assertPinnedInputs(prepared.pinned);
    database = openReadonlyDatabase({ databasePath: physical(plan.databasePath, false) });
    verifyRows(database, prepared.adapted, targetTables);
    if (database.pragma("user_version", { simple: true }) !== plan.expectedSchemaVersion ||
        canonicalize(readAppliedMigrations(database).map(({ id, fileName, checksum }) => ({ id, fileName, checksum }))) !== canonicalize(plan.migrations)) {
      fail("IMPORT_SCHEMA_MISMATCH", "The persisted database no longer matches the reviewed schema.");
    }
    database.close(); database = null;
    const reportFile = path.join(plan.targetDirectory, "report/import-report.json");
    if (fs.readFileSync(reportFile, "utf8") !== canonicalize(report) + "\n") {
      fail("IMPORT_REPORT_FAILED", "The persisted report differs from the reconciled import.");
    }
    for (const file of [plan.databasePath, reportFile, path.join(plan.targetDirectory, "report/import-report.md")]) flushFile(file);
    flushDirectory(path.join(plan.targetDirectory, "report"));
    flushDirectory(path.dirname(plan.targetDirectory));
    const result = Object.freeze({ status: "valid", environment: "production", planSha256: plan.planSha256,
      databaseSha256: sha(fs.readFileSync(plan.databasePath)), databaseBytes: fs.statSync(plan.databasePath).size,
      schemaVersion: plan.expectedSchemaVersion, semanticReportHash: report.semanticReportHash,
      importedRowCount: plan.plannedRowCount, sourceBundleId: plan.sourceBundleId,
      resetManifestId: plan.resetManifestId, applicationAuthorityChanged: false,
      environmentIdentityInitialized: false, jobsStarted: false, messagesSent: false,
      directoryEntriesSynced: process.platform !== "win32" });
    fs.writeFileSync(path.join(plan.targetDirectory, "import-result.json"), canonicalize(result) + "\n", { flag: "wx", mode: 0o600, flush: true });
    flushDirectory(plan.targetDirectory);
    return result;
  } catch (error) {
    if (database?.open) {
      try { if (database.inTransaction) database.exec("ROLLBACK;"); database.close(); } catch { /* Preserve initial error. */ }
    }
    const failure = safeFailure(error);
    if (ownsTarget) {
      try {
        fs.writeFileSync(path.join(plan.targetDirectory, "import-failed.json"), canonicalize({
          status: "failed", code: failure.code, planSha256: plan.planSha256,
          retainedForDiagnosis: true, applicationAuthorityChanged: false,
        }) + "\n", { flag: "wx", mode: 0o600, flush: true });
        flushDirectory(plan.targetDirectory);
      } catch { /* No cleanup or retry can make a failed attempt successful. */ }
    }
    throw failure;
  }
}

module.exports = { planProductionImport, runProductionImport };
