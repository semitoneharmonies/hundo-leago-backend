const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");
const Database = require("better-sqlite3");

const {
  parseArguments,
} = require("../../scripts/db-import-staging");
const {
  serializeStagingDescriptor,
} = require("../../src/infrastructure/database/stagingEnvironment");
const {
  JSON_IMPORT_ERROR_CODES,
} = require("../../src/infrastructure/migration/runJsonImport");
const {
  runStagingImport,
} = require("../../src/infrastructure/migration/runStagingImport");
const {
  inventorySourceBundle,
} = require("../../src/infrastructure/migration/sourceInventory");

const ROOT = path.resolve(__dirname, "..", "..");
const RESET_MANIFEST = path.join(
  ROOT,
  "database",
  "reset-manifests",
  "2026-season-1-reset.json"
);

function syntheticLeague() {
  return {
    schemaVersion: 1,
    meta: { createdAt: "synthetic" },
    teams: [{
      name: "Team One",
      roster: [{
        name: "Player One",
        playerId: 1,
        salary: 10,
        position: "F",
        onIR: false,
      }],
      buyouts: [],
    }],
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

function syntheticPlayers() {
  return [{
    id: 1,
    fullName: "Player One",
    firstName: "Player",
    lastName: "One",
    position: "F",
    teamAbbrev: "AAA",
    birthDate: "2000-01-01",
    active: true,
  }, {
    id: 2,
    fullName: "Goalie Two",
    firstName: "Goalie",
    lastName: "Two",
    position: "G",
    teamAbbrev: null,
    birthDate: "1999-02-03",
    active: false,
  }];
}

function createAttempt(t, { copyBundleFrom } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m2-12-staging-")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, "inputs");
  const sourceRoot = path.join(root, "migration-sources");
  const databaseDirectory = path.join(root, "database");
  const reportRoot = path.join(root, "migration-reports");
  const backupRoot = path.join(root, "backups");
  for (const directory of [
    inputs,
    sourceRoot,
    databaseDirectory,
    reportRoot,
    backupRoot,
  ]) {
    fs.mkdirSync(directory);
  }
  const leaguePath = path.join(inputs, "league-state.json");
  const playersPath = path.join(inputs, "players.json");
  fs.writeFileSync(
    leaguePath,
    JSON.stringify(syntheticLeague()),
    "utf8"
  );
  fs.writeFileSync(
    playersPath,
    JSON.stringify(syntheticPlayers()),
    "utf8"
  );
  const sourceBundleDirectory = path.join(
    sourceRoot,
    "current-bundle"
  );
  if (copyBundleFrom) {
    fs.cpSync(copyBundleFrom, sourceBundleDirectory, {
      recursive: true,
    });
  } else {
    inventorySourceBundle({
      sources: [
        { label: "league_state", path: leaguePath },
        { label: "players", path: playersPath },
      ],
      outputDirectory: sourceBundleDirectory,
      capturedAtMs: 1_000,
      applicationBuildId: "m2-12-synthetic",
      sourceGitCommit: "0123456789abcdef",
    });
  }
  const databasePath = path.join(
    databaseDirectory,
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
  return {
    root,
    descriptorPath,
    sourceBundleDirectory,
    databasePath,
    reportDirectory: path.join(reportRoot, "attempt"),
  };
}

function options(attempt) {
  return {
    descriptorPath: attempt.descriptorPath,
    sourceBundleDirectory: attempt.sourceBundleDirectory,
    databasePath: attempt.databasePath,
    resetManifestPath: RESET_MANIFEST,
    reportDirectory: attempt.reportDirectory,
    operatingMode: "OFFSEASON_RESET",
  };
}

function report(attempt) {
  return JSON.parse(fs.readFileSync(
    path.join(attempt.reportDirectory, "import-report.json"),
    "utf8"
  ));
}

function hasCode(code) {
  return (error) => error?.code === code;
}

describe("M2-12 repeated persistent staging import", () => {
  test("two clean attempts retain identical rows and semantic reports", (t) => {
    const firstAttempt = createAttempt(t);
    const secondAttempt = createAttempt(t, {
      copyBundleFrom: firstAttempt.sourceBundleDirectory,
    });
    const first = runStagingImport(options(firstAttempt));
    const second = runStagingImport(options(secondAttempt));

    assert.equal(first.status, "valid");
    assert.equal(first.environment, "staging");
    assert.equal(first.importedRowCount, 6);
    assert.match(first.databaseSha256, /^[a-f0-9]{64}$/);
    assert.match(second.databaseSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      first.semanticReportHash,
      second.semanticReportHash
    );
    assert.deepEqual(report(firstAttempt), report(secondAttempt));

    const database = new Database(firstAttempt.databasePath, {
      readonly: true,
    });
    try {
      assert.equal(
        database.prepare("SELECT COUNT(*) count FROM players").get().count,
        2
      );
      assert.equal(
        database.prepare(
          "SELECT COUNT(*) count FROM player_external_ids"
        ).get().count,
        2
      );
      for (const tableName of [
        "candidate_card_entries",
        "candidate_card_help_requests",
        "candidate_card_revisions",
        "candidate_card_snapshot_entries",
        "candidate_card_snapshots",
        "candidate_cards",
        "auction_contexts",
        "free_agent_draft_auction_participants",
        "free_agent_draft_draws",
        "free_agent_draft_allocation_events",
        "free_agent_draft_player_allocations",
        "free_agent_draft_recoveries",
        "free_agent_draft_rollovers",
        "free_agent_draft_setup_exemptions",
        "free_agent_draft_teams",
        "free_agent_drafts",
        "outbox_event_audiences",
        "season_rollover_items",
        "season_rollovers",
      ]) {
        assert.equal(
          database
            .prepare(
              `SELECT COUNT(*) count FROM ${tableName}`
            )
            .get().count,
          0
        );
      }
      assert.equal(database.pragma("integrity_check", {
        simple: true,
      }), "ok");
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally {
      database.close();
    }
    const evidence = report(firstAttempt);
    assert.equal(evidence.importedRowsRetained, true);
    assert.equal(evidence.checks.committedRowsVerified, true);
    assert.equal(
      evidence.stagingDescriptor.applicationAuthority,
      "json"
    );
    assert.equal(
      evidence.stagingDescriptor.sqliteApplicationAuthorityEnabled,
      false
    );
  });

  test("rejects path substitution and preserves an existing target", (t) => {
    const attempt = createAttempt(t);
    const outside = path.join(attempt.root, "substitute.sqlite3");
    assert.throws(
      () => runStagingImport({
        ...options(attempt),
        databasePath: outside,
      }),
      hasCode(JSON_IMPORT_ERROR_CODES.pathUnsafe)
    );
    fs.writeFileSync(attempt.databasePath, "existing", "utf8");
    assert.throws(
      () => runStagingImport(options(attempt)),
      hasCode(JSON_IMPORT_ERROR_CODES.pathUnsafe)
    );
    assert.equal(
      fs.readFileSync(attempt.databasePath, "utf8"),
      "existing"
    );
  });

  test("removes only its new database when report publication fails", (t) => {
    const attempt = createAttempt(t);
    assert.throws(
      () => runStagingImport({
        ...options(attempt),
        publishReport() {
          throw new Error("synthetic report failure");
        },
      }),
      hasCode(JSON_IMPORT_ERROR_CODES.reconciliationFailed)
    );
    assert.equal(fs.existsSync(attempt.databasePath), false);
    assert.equal(fs.existsSync(attempt.reportDirectory), false);
    assert.equal(fs.existsSync(attempt.sourceBundleDirectory), true);
  });

  test("CLI persists a verified attempt and emits a content-free summary", (t) => {
    const attempt = createAttempt(t);
    const args = [
      "--descriptor", attempt.descriptorPath,
      "--source-bundle", attempt.sourceBundleDirectory,
      "--database", attempt.databasePath,
      "--reset-manifest", RESET_MANIFEST,
      "--report", attempt.reportDirectory,
      "--operating-mode", "OFFSEASON_RESET",
    ];
    assert.deepEqual(parseArguments(args), options(attempt));
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "db-import-staging.js"),
      ...args,
    ], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "valid");
    assert.equal(summary.importedRowCount, 6);
    assert.equal(Object.hasOwn(summary, "databasePath"), false);
    assert.equal(fs.existsSync(attempt.databasePath), true);
  });
});
