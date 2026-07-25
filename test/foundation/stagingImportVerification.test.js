const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");
const Database = require("better-sqlite3");

const {
  serializeStagingDescriptor,
} = require("../../src/infrastructure/database/stagingEnvironment");
const {
  calculateSemanticReportHash,
} = require("../../src/infrastructure/migration/importReport");
const {
  runStagingImport,
} = require("../../src/infrastructure/migration/runStagingImport");
const {
  canonicalize,
  inventorySourceBundle,
} = require("../../src/infrastructure/migration/sourceInventory");
const {
  STAGING_VERIFICATION_ERROR_CODES,
  verificationHash,
  verifyStagingImport,
} = require("../../src/infrastructure/migration/verifyStagingImport");
const {
  parseArguments,
} = require("../../scripts/db-verify-staging-import");
const {
  hashTree,
} = require("../helpers/hashTree");

const ROOT = path.resolve(__dirname, "..", "..");
const RESET_MANIFEST = path.join(
  ROOT,
  "database",
  "reset-manifests",
  "2026-season-1-reset.json"
);

function league() {
  return {
    schemaVersion: 1,
    meta: { createdAt: "synthetic" },
    teams: [],
    freeAgents: [],
    leagueLog: [],
    tradeProposals: [],
    tradeBlock: [],
    matchups: {
      seasonId: "2025-2026",
      scheduleWeeks: [],
      currentWeekIndex: 0,
      currentWeekId: null,
      locksByTeam: {},
      baselineByPlayerId: {},
      baselineByWeekId: {},
      resultsByWeek: {},
      lastRolloverWeekId: null,
    },
    settings: {
      frozen: false,
      managerLoginHistory: [],
      managerLastLogin: {},
    },
    nextAuctionDeadline: null,
    lastAutoWeeklySnapshotId: null,
    lastAutoAuctionRolloverId: null,
  };
}

function players() {
  return [{
    id: 7,
    fullName: "Verified Player",
    firstName: "Verified",
    lastName: "Player",
    position: "D",
    teamAbbrev: "AAA",
    birthDate: "2000-01-01",
    active: true,
  }];
}

function createImportedAttempt(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m2-13-staging-")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  const sourceRoot = path.join(root, "migration-sources");
  const databaseRoot = path.join(root, "database");
  const reportRoot = path.join(root, "migration-reports");
  const backupRoot = path.join(root, "backups");
  for (const directory of [
    input,
    sourceRoot,
    databaseRoot,
    reportRoot,
    backupRoot,
  ]) {
    fs.mkdirSync(directory);
  }
  const leaguePath = path.join(input, "league-state.json");
  const playersPath = path.join(input, "players.json");
  fs.writeFileSync(leaguePath, JSON.stringify(league()), "utf8");
  fs.writeFileSync(playersPath, JSON.stringify(players()), "utf8");
  const sourceBundleDirectory = path.join(
    sourceRoot,
    "verified-bundle"
  );
  inventorySourceBundle({
    sources: [
      { label: "league_state", path: leaguePath },
      { label: "players", path: playersPath },
    ],
    outputDirectory: sourceBundleDirectory,
    capturedAtMs: 1_000,
    applicationBuildId: "m2-13-synthetic",
    sourceGitCommit: "0123456789abcdef",
  });
  const databasePath = path.join(
    databaseRoot,
    "hundo-leago.sqlite3"
  );
  const descriptor = {
    descriptorVersion: 1,
    environment: "staging",
    resourceIds: {
      service: "hundo-leago-backend-staging-v1",
      disk: "hundo-leago-staging-disk-v1",
      database: "hundo-leago-staging-database-v1",
      sourceBundle: "hundo-leago-staging-source-v1",
      reports: "hundo-leago-staging-reports-v1",
      backups: "hundo-leago-staging-backups-v1",
    },
    paths: {
      persistentRoot: root,
      database: databasePath,
      sourceBundles: sourceRoot,
      reports: reportRoot,
      backups: backupRoot,
    },
    backupNamespace: "hundo-leago/staging",
    secretScope: "staging",
    secretReferences: [
      "AUDIT_METADATA_SECRET",
      "BACKUP_ENCRYPTION_KEY",
      "RATE_LIMIT_KEY_SECRET",
    ],
    applicationAuthority: "json",
    sqliteApplicationAuthorityEnabled: false,
    productionStorageAccessible: false,
    productionSecretsAccessible: false,
  };
  const descriptorPath = path.join(root, "staging-descriptor.json");
  fs.writeFileSync(
    descriptorPath,
    serializeStagingDescriptor(descriptor),
    "utf8"
  );
  const reportDirectory = path.join(reportRoot, "import");
  runStagingImport({
    descriptorPath,
    sourceBundleDirectory,
    databasePath,
    resetManifestPath: RESET_MANIFEST,
    reportDirectory,
    operatingMode: "OFFSEASON_RESET",
  });
  return {
    root,
    descriptorPath,
    sourceBundleDirectory,
    databasePath,
    importReportPath: path.join(
      reportDirectory,
      "import-report.json"
    ),
  };
}

function options(attempt) {
  return {
    descriptorPath: attempt.descriptorPath,
    sourceBundleDirectory: attempt.sourceBundleDirectory,
    databasePath: attempt.databasePath,
    resetManifestPath: RESET_MANIFEST,
    importReportPath: attempt.importReportPath,
    operatingMode: "OFFSEASON_RESET",
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}

describe("M2-13 independent staging import verification", () => {
  test("recomputes every gate without changing any staging input", async (t) => {
    const attempt = createImportedAttempt(t);
    const before = await hashTree(attempt.root);
    const evidence = verifyStagingImport(options(attempt));
    const after = await hashTree(attempt.root);

    assert.deepEqual(after, before);
    assert.equal(evidence.status, "verified");
    assert.equal(evidence.database.targetTables.length, 3);
    assert.equal(
      evidence.database.seededApplicationMetadataRowCount,
      2
    );
    assert.equal(evidence.database.emptyApplicationTableCount, 73);
    assert.equal(evidence.checks.integrity, "ok");
    assert.equal(evidence.checks.foreignKeyViolationCount, 0);
    assert.equal(evidence.checks.inputsUnchanged, true);
    assert.equal(
      evidence.verificationHash,
      verificationHash(evidence)
    );
  });

  test("rejects canonical report tampering and changed database semantics", (t) => {
    const reportAttempt = createImportedAttempt(t);
    const report = JSON.parse(
      fs.readFileSync(reportAttempt.importReportPath, "utf8")
    );
    report.sourceCollectionCounts.players += 1;
    report.semanticReportHash =
      calculateSemanticReportHash(report);
    fs.writeFileSync(
      reportAttempt.importReportPath,
      `${canonicalize(report)}\n`,
      "utf8"
    );
    assert.throws(
      () => verifyStagingImport(options(reportAttempt)),
      hasCode(STAGING_VERIFICATION_ERROR_CODES.semanticMismatch)
    );

    const databaseAttempt = createImportedAttempt(t);
    const database = new Database(databaseAttempt.databasePath);
    database.prepare(
      "UPDATE players SET full_name = ?, version = version + 1"
    ).run("Changed Player");
    database.close();
    assert.throws(
      () => verifyStagingImport(options(databaseAttempt)),
      hasCode(STAGING_VERIFICATION_ERROR_CODES.databaseMismatch)
    );
  });

  test("rejects substituted paths before reading unrelated files", (t) => {
    const attempt = createImportedAttempt(t);
    const substitute = path.join(attempt.root, "substitute.sqlite3");
    fs.copyFileSync(attempt.databasePath, substitute);
    assert.throws(
      () => verifyStagingImport({
        ...options(attempt),
        databasePath: substitute,
      }),
      hasCode(STAGING_VERIFICATION_ERROR_CODES.pathUnsafe)
    );
  });

  test("CLI verifies an import and emits only safe summary evidence", (t) => {
    const attempt = createImportedAttempt(t);
    const args = [
      "--descriptor", attempt.descriptorPath,
      "--source-bundle", attempt.sourceBundleDirectory,
      "--database", attempt.databasePath,
      "--reset-manifest", RESET_MANIFEST,
      "--import-report", attempt.importReportPath,
      "--operating-mode", "OFFSEASON_RESET",
    ];
    assert.deepEqual(parseArguments(args), options(attempt));
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "db-verify-staging-import.js"),
      ...args,
    ], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "verified");
    assert.equal(summary.importedRowCount, 3);
    assert.equal(summary.integrity, "ok");
    assert.equal(summary.foreignKeyViolationCount, 0);
    assert.equal(Object.hasOwn(summary, "databasePath"), false);
  });
});
