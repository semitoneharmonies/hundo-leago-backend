const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const {
  serializeStagingDescriptor,
} = require("../../src/infrastructure/database/stagingEnvironment");
const {
  calculateRehearsalHash,
  rehearseStagingCutover,
  STAGING_REHEARSAL_ERROR_CODES,
} = require("../../src/infrastructure/migration/rehearseStagingCutover");
const {
  runStagingImport,
} = require("../../src/infrastructure/migration/runStagingImport");
const {
  inventorySourceBundle,
} = require("../../src/infrastructure/migration/sourceInventory");
const {
  parseArguments,
} = require("../../scripts/db-rehearse-staging-cutover");

const ROOT = path.resolve(__dirname, "..", "..");
const RESET_MANIFEST = path.join(
  ROOT,
  "database",
  "reset-manifests",
  "2026-season-1-reset.json"
);

function createImportedAttempt(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m2-14-staging-")
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
  fs.writeFileSync(leaguePath, JSON.stringify({
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
  }), "utf8");
  fs.writeFileSync(playersPath, JSON.stringify([{
    id: 9,
    fullName: "Rehearsal Player",
    firstName: "Rehearsal",
    lastName: "Player",
    position: "F",
    teamAbbrev: "AAA",
    birthDate: "2000-01-01",
    active: true,
  }]), "utf8");
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
    applicationBuildId: "m2-14-synthetic",
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
  const importReportDirectory = path.join(reportRoot, "import");
  runStagingImport({
    descriptorPath,
    sourceBundleDirectory,
    databasePath,
    resetManifestPath: RESET_MANIFEST,
    reportDirectory: importReportDirectory,
    operatingMode: "OFFSEASON_RESET",
  });
  return {
    root,
    descriptorPath,
    sourceBundleDirectory,
    databasePath,
    resetManifestPath: RESET_MANIFEST,
    importReportPath: path.join(
      importReportDirectory,
      "import-report.json"
    ),
    backupDirectory: path.join(backupRoot, "pre-cutover"),
    rehearsalDirectory: path.join(reportRoot, "rehearsal"),
    operatingMode: "OFFSEASON_RESET",
    rehearsedAtMs: 2_000,
  };
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function inputHashes(attempt) {
  return {
    descriptor: sha256(attempt.descriptorPath),
    sourceManifest: sha256(path.join(
      attempt.sourceBundleDirectory,
      "source-bundle.json"
    )),
    database: sha256(attempt.databasePath),
    reset: sha256(attempt.resetManifestPath),
    importReport: sha256(attempt.importReportPath),
  };
}

function rehearsalOptions(attempt) {
  return {
    descriptorPath: attempt.descriptorPath,
    sourceBundleDirectory: attempt.sourceBundleDirectory,
    databasePath: attempt.databasePath,
    resetManifestPath: attempt.resetManifestPath,
    importReportPath: attempt.importReportPath,
    backupDirectory: attempt.backupDirectory,
    rehearsalDirectory: attempt.rehearsalDirectory,
    operatingMode: attempt.operatingMode,
    rehearsedAtMs: attempt.rehearsedAtMs,
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}

describe("M2-14 staging cutover and rollback rehearsal", () => {
  test("backs up, restores two candidates, and preserves authority and inputs", async (t) => {
    const attempt = createImportedAttempt(t);
    const before = inputHashes(attempt);
    const result = await rehearseStagingCutover(attempt);
    const after = inputHashes(attempt);
    const report = JSON.parse(fs.readFileSync(
      path.join(
        attempt.rehearsalDirectory,
        "cutover-rehearsal-report.json"
      ),
      "utf8"
    ));

    assert.deepEqual(after, before);
    assert.equal(result.status, "passed");
    assert.equal(result.applicationAuthority, "json");
    assert.equal(
      result.sqliteApplicationAuthorityEnabled,
      false
    );
    assert.equal(result.productionAuthorityChanged, false);
    assert.equal(
      report.rehearsalHash,
      calculateRehearsalHash(report)
    );
    assert.equal(
      report.activationCandidate.sha256,
      report.rollbackCandidate.sha256
    );
    assert.equal(report.checks.backupVerified, true);
    assert.equal(
      report.checks.applicationAuthorityAfter,
      "json"
    );
    assert.equal(
      fs.existsSync(`${attempt.databasePath}-wal`),
      false
    );
    assert.equal(
      fs.existsSync(`${attempt.databasePath}-shm`),
      false
    );
  });

  test("a failed restore cleans only owned outputs", async (t) => {
    const attempt = createImportedAttempt(t);
    const before = inputHashes(attempt);
    await assert.rejects(
      () => rehearseStagingCutover({
        ...attempt,
        restoreBackup() {
          throw new Error("synthetic restore failure");
        },
      }),
      hasCode(
        STAGING_REHEARSAL_ERROR_CODES.publicationFailed
      )
    );
    assert.deepEqual(inputHashes(attempt), before);
    assert.equal(
      fs.existsSync(attempt.backupDirectory),
      false
    );
    assert.equal(
      fs.existsSync(attempt.rehearsalDirectory),
      false
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(
        attempt.rehearsalDirectory
      )).sort(),
      ["import"]
    );
  });

  test("rejects output substitution before creating a backup", async (t) => {
    const attempt = createImportedAttempt(t);
    await assert.rejects(
      () => rehearseStagingCutover({
        ...attempt,
        backupDirectory: path.join(
          attempt.root,
          "substituted-backup"
        ),
      }),
      hasCode(STAGING_REHEARSAL_ERROR_CODES.pathUnsafe)
    );
  });

  test("CLI completes the rehearsal and emits a safe summary", (t) => {
    const attempt = createImportedAttempt(t);
    const args = [
      "--descriptor", attempt.descriptorPath,
      "--source-bundle", attempt.sourceBundleDirectory,
      "--database", attempt.databasePath,
      "--reset-manifest", attempt.resetManifestPath,
      "--import-report", attempt.importReportPath,
      "--backup", attempt.backupDirectory,
      "--rehearsal", attempt.rehearsalDirectory,
      "--operating-mode", attempt.operatingMode,
      "--rehearsed-at-ms", String(attempt.rehearsedAtMs),
    ];
    assert.deepEqual(
      parseArguments(args),
      rehearsalOptions(attempt)
    );
    const result = spawnSync(process.execPath, [
      path.join(
        ROOT,
        "scripts",
        "db-rehearse-staging-cutover.js"
      ),
      ...args,
    ], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "passed");
    assert.equal(summary.applicationAuthority, "json");
    assert.equal(
      summary.sqliteApplicationAuthorityEnabled,
      false
    );
    assert.equal(summary.productionAuthorityChanged, false);
    assert.equal(Object.hasOwn(summary, "databasePath"), false);
  });
});
