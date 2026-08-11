const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const {
  openReadonlyDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  serializeStagingDescriptor,
} = require("../../src/infrastructure/database/stagingEnvironment");
const {
  inspectDatabase,
} = require("../../src/infrastructure/database/sqliteBackup");
const {
  ACTIVATION_CANDIDATE_FILE,
  calculateRehearsalHash,
  rehearseStagingCutover,
  ROLLBACK_CANDIDATE_FILE,
  STAGING_REHEARSAL_ERROR_CODES,
} = require("../../src/infrastructure/migration/rehearseStagingCutover");
const {
  runStagingImport,
} = require("../../src/infrastructure/migration/runStagingImport");
const {
  canonicalize,
  inventorySourceBundle,
} = require("../../src/infrastructure/migration/sourceInventory");
const {
  REPOSITORY_CATALOG,
} = require("../../src/infrastructure/persistence/sqlite/repositoryCatalog");
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
const MIGRATIONS_DIRECTORY = path.join(
  ROOT,
  "database",
  "migrations"
);
const FAD_STATE_TABLES = Object.freeze([
  "auction_administration_command_results",
  "candidate_card_entries",
  "candidate_card_help_requests",
  "candidate_card_revisions",
  "candidate_card_snapshot_entries",
  "candidate_card_snapshots",
  "candidate_cards",
  "entry_draft_rollover_bindings",
  "free_agent_draft_allocation_correction_command_results",
  "free_agent_draft_allocation_events",
  "free_agent_draft_auction_participants",
  "free_agent_draft_draws",
  "free_agent_draft_nomination_queue",
  "free_agent_draft_player_allocations",
  "free_agent_draft_readiness_attempts",
  "free_agent_draft_readiness_corrective_requeues",
  "free_agent_draft_readiness_operations",
  "free_agent_draft_readiness_retry_receipts",
  "free_agent_draft_recoveries",
  "free_agent_draft_recovery_action_command_results",
  "free_agent_draft_rollovers",
  "free_agent_draft_schedule_recoveries",
  "free_agent_draft_schedule_recovery_jobs",
  "free_agent_draft_schedule_recovery_matchups",
  "free_agent_draft_schedule_recovery_weeks",
  "free_agent_draft_setup_exemptions",
  "free_agent_draft_teams",
  "free_agent_drafts",
  "season_rollover_attempts",
  "season_rollover_items",
  "season_rollover_occurrences",
  "season_rollovers",
]);

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

function valueSha256(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalize(value), "utf8")
    .digest("hex");
}

function databaseReconciliation(databasePath) {
  const inspection = inspectDatabase(databasePath);
  const definitions = new Map(
    REPOSITORY_CATALOG.map((definition) => [
      definition.tableName,
      definition,
    ])
  );
  let database;
  try {
    database = openReadonlyDatabase({ databasePath });
    const tableInventory = database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name);
    const tableState = Object.fromEntries(
      tableInventory.map((tableName) => {
        const keyColumn = tableName === "schema_migrations"
          ? "migration_id"
          : definitions.get(tableName)?.keyColumn;
        assert.ok(
          keyColumn,
          `missing reconciliation key for ${tableName}`
        );
        const rows = database.prepare(
          `SELECT * FROM "${tableName}" ` +
            `ORDER BY "${keyColumn}"`
        ).all();
        return [
          tableName,
          Object.freeze({
            rowCount: rows.length,
            semanticSha256: valueSha256(rows),
          }),
        ];
      })
    );
    const dataModelVersion = database.prepare(`
      SELECT metadata_value
      FROM application_metadata
      WHERE metadata_key = 'data_model_version'
    `).get()?.metadata_value;
    return Object.freeze({
      inspection,
      tableInventory: Object.freeze(tableInventory),
      tableState: Object.freeze(tableState),
      dataModelVersion,
    });
  } finally {
    if (database?.open) database.close();
  }
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

  test("reconciles the schema-49 activation and rollback copies", async (t) => {
    const attempt = createImportedAttempt(t);
    const source = databaseReconciliation(
      attempt.databasePath
    );
    await rehearseStagingCutover(attempt);
    const activation = databaseReconciliation(path.join(
      attempt.rehearsalDirectory,
      ACTIVATION_CANDIDATE_FILE
    ));
    const rollback = databaseReconciliation(path.join(
      attempt.rehearsalDirectory,
      ROLLBACK_CANDIDATE_FILE
    ));
    const expectedLedger = discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    })
      .filter(({ id }) => id <= 49)
      .map(({ id, fileName, checksum }) => ({
        id,
        fileName,
        checksum,
      }));
    const expectedTables = [
      ...REPOSITORY_CATALOG.map(
        ({ tableName }) => tableName
      ),
      "schema_migrations",
    ].sort();

    assert.equal(REPOSITORY_CATALOG.length, 131);
    assert.deepEqual(
      expectedLedger.map(({ id }) => id),
      Array.from({ length: 49 }, (_, index) => index + 1)
    );
    assert.equal(
      expectedLedger.at(-1).fileName,
      "0049_require_canonical_fad_setup_exemption_publications.sql"
    );
    for (const candidate of [source, activation, rollback]) {
      assert.equal(candidate.inspection.integrity, "ok");
      assert.equal(
        candidate.inspection.foreignKeyViolationCount,
        0
      );
      assert.equal(candidate.inspection.userVersion, 49);
      assert.equal(candidate.dataModelVersion, "49");
      assert.deepEqual(
        candidate.inspection.migrations,
        expectedLedger
      );
      assert.equal(candidate.tableInventory.length, 132);
      assert.deepEqual(
        candidate.tableInventory,
        expectedTables
      );
      assert.equal(
        candidate.tableState.schema_migrations.rowCount,
        49
      );
      for (const tableName of FAD_STATE_TABLES) {
        assert.equal(
          candidate.tableState[tableName].rowCount,
          0,
          `${tableName} must remain empty`
        );
      }
    }

    assert.equal(source.tableState.players.rowCount, 1);
    assert.deepEqual(activation.tableState, source.tableState);
    assert.deepEqual(rollback.tableState, source.tableState);
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
