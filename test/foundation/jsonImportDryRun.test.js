const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");
const Database = require("better-sqlite3");

const {
  parseArguments,
  runJsonImportCommand,
} = require("../../scripts/db-import-json");
const {
  finalizeImportReport,
  renderImportReportMarkdown,
} = require("../../src/infrastructure/migration/importReport");
const {
  JSON_IMPORT_ERROR_CODES,
  runJsonImportDryRun,
  validateImportPaths,
} = require("../../src/infrastructure/migration/runJsonImport");
const {
  canonicalize,
  inventorySourceBundle,
} = require("../../src/infrastructure/migration/sourceInventory");
const {
  IMPORT_ADAPTER_ERROR_CODES,
  adaptVerifiedSourceBundle,
} = require("../../src/infrastructure/migration/sourceShapeAdapters");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const RESET_MANIFEST_PATH = path.join(
  ROOT_DIRECTORY,
  "database",
  "reset-manifests",
  "2026-season-1-reset.json"
);
const IMPORT_SCRIPT = path.join(
  ROOT_DIRECTORY,
  "scripts",
  "db-import-json.js"
);
const PROTECTED_JSON_FILES = [
  "league-state.json",
  "league.json",
  "league_dump.json",
  "league_with_meta.json",
  "players.json",
];
const REQUIRED_REPOSITORY_JSON_FILES = [
  "league.json",
  "league_with_meta.json",
  "players.json",
];

function createTemporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function syntheticLeague(overrides = {}) {
  return {
    schemaVersion: 1,
    meta: {
      createdAt: "synthetic",
    },
    teams: [
      {
        name: "Team One",
        roster: [
          {
            name: "Player One",
            playerId: 1,
            salary: 10,
            position: "F",
            onIR: false,
          },
        ],
        buyouts: [
          {
            player: "Historical Player",
            penalty: 1,
            retained: false,
          },
        ],
      },
    ],
    freeAgents: [],
    leagueLog: [
      {
        id: "activity-1",
        type: "synthetic",
        timestamp: 1,
      },
    ],
    tradeProposals: [
      {
        id: "trade-1",
        penaltyFrom: 0,
        penaltyTo: 0,
        retentionFrom: {
          retained: 1,
        },
        retentionTo: {},
      },
    ],
    tradeBlock: [],
    matchups: {
      seasonId: "2025-2026",
      scheduleWeeks: [
        {
          weekIndex: 0,
          weekId: "week-1",
          weekStartAtMs: 1,
          baselineAtMs: 2,
          weekEndAtMs: 3,
          lockAtMs: 2,
          rolloverAtMs: 4,
          pairs: [["Team One", "Team Two"]],
        },
      ],
      currentWeekIndex: 0,
      currentWeekId: "week-1",
      locksByTeam: {},
      baselineByPlayerId: {},
      baselineByWeekId: {},
      resultsByWeek: {},
      lastRolloverWeekId: null,
    },
    settings: {
      frozen: false,
      managerLoginHistory: [
        {
          identity: "never-import",
          password: "must-not-appear",
        },
      ],
      managerLastLogin: {},
    },
    nextAuctionDeadline: null,
    lastAutoWeeklySnapshotId: null,
    lastAutoAuctionRolloverId: null,
    ...overrides,
  };
}

function syntheticPlayers(overrides = []) {
  return [
    {
      id: 1,
      fullName: "Player One",
      firstName: "Player",
      lastName: "One",
      position: "F",
      teamAbbrev: "AAA",
      birthDate: "2000-01-01",
      active: true,
    },
    {
      id: 2,
      fullName: "Goalie Two",
      firstName: "Goalie",
      lastName: "Two",
      position: "G",
      teamAbbrev: null,
      birthDate: "1999-02-03",
      active: false,
    },
    ...overrides,
  ];
}

function createSyntheticBundle(
  t,
  {
    league = syntheticLeague(),
    players = syntheticPlayers(),
    extraSources = [],
  } = {}
) {
  const root = createTemporaryRoot(
    t,
    "hundo-leago-m2-09-"
  );
  const sourceDirectory = path.join(root, "source");
  fs.mkdirSync(sourceDirectory);
  const leaguePath = path.join(
    sourceDirectory,
    "league-state.json"
  );
  const playersPath = path.join(
    sourceDirectory,
    "players.json"
  );
  fs.writeFileSync(
    leaguePath,
    JSON.stringify(league),
    "utf8"
  );
  fs.writeFileSync(
    playersPath,
    JSON.stringify(players),
    "utf8"
  );
  const sources = [
    { label: "league_state", path: leaguePath },
    { label: "players", path: playersPath },
  ];
  for (const source of extraSources) {
    const sourcePath = path.join(
      sourceDirectory,
      source.fileName
    );
    fs.writeFileSync(sourcePath, source.content, "utf8");
    sources.push({
      label: source.label,
      path: sourcePath,
    });
  }
  const bundleDirectory = path.join(root, "bundle");
  inventorySourceBundle({
    sources,
    outputDirectory: bundleDirectory,
    capturedAtMs: 1_000,
    applicationBuildId: "m2-09-synthetic",
    sourceGitCommit: "0123456789abcdef",
  });
  return {
    root,
    bundleDirectory,
    leaguePath,
    playersPath,
  };
}

function runPaths(root, suffix) {
  return {
    databasePath: path.join(root, `${suffix}.sqlite3`),
    reportDirectory: path.join(root, `${suffix}-report`),
  };
}

function runOptions(bundle, paths) {
  return {
    sourceBundleDirectory: bundle.bundleDirectory,
    databasePath: paths.databasePath,
    resetManifestPath: RESET_MANIFEST_PATH,
    reportDirectory: paths.reportDirectory,
    environment: "test",
    operatingMode: "OFFSEASON_RESET",
    dryRun: true,
  };
}

function readReport(reportDirectory) {
  return JSON.parse(
    fs.readFileSync(
      path.join(reportDirectory, "import-report.json"),
      "utf8"
    )
  );
}

function assertCode(code) {
  return (error) => error?.code === code;
}

function sha256File(relativePath) {
  return crypto
    .createHash("sha256")
    .update(
      fs.readFileSync(path.join(ROOT_DIRECTORY, relativePath))
    )
    .digest("hex");
}

function protectedFingerprints() {
  for (const relativePath of REQUIRED_REPOSITORY_JSON_FILES) {
    assert.equal(
      fs.existsSync(path.join(ROOT_DIRECTORY, relativePath)),
      true,
      `${relativePath} must exist in every repository checkout`
    );
  }
  const presentFiles = PROTECTED_JSON_FILES.filter(
    (relativePath) =>
      fs.existsSync(path.join(ROOT_DIRECTORY, relativePath))
  );
  return Object.fromEntries(
    presentFiles.map((relativePath) => [
      relativePath,
      sha256File(relativePath),
    ])
  );
}

describe("M2-09 JSON import dry-run", () => {
  test("adapts exact supported shapes with deterministic protected rows and complete reset counts", (t) => {
    const bundle = createSyntheticBundle(t);
    const adapted = adaptVerifiedSourceBundle({
      bundleDirectory: bundle.bundleDirectory,
    });

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(adapted.rows).map(
          ([tableName, rows]) => [tableName, rows.length]
        )
      ),
      {
        players: 2,
        player_external_ids: 2,
        player_source_state: 2,
      }
    );
    assert.equal(adapted.mappings.length, 6);
    assert.equal(
      Object.keys(adapted.omissionCounts).length,
      12
    );
    assert.equal(adapted.omissionCounts.season_1_teams, 1);
    assert.equal(
      adapted.omissionCounts.season_1_rosters,
      1
    );
    assert.equal(
      adapted.omissionCounts.season_1_retention,
      1
    );
    assert.equal(
      adapted.protectedEvidence.player_identity.preserved,
      true
    );
    assert.equal(
      adapted.neverImportEvidence
        .hard_coded_frontend_credentials
        .importedTargetRowCount,
      0
    );
    assert.deepEqual(
      adapted.rows.player_external_ids.map(
        (row) => row.external_value
      ),
      ["1", "2"]
    );
  });

  test("validates prepared inserts then rolls every imported row back and publishes canonical reports", (t) => {
    const bundle = createSyntheticBundle(t);
    const paths = runPaths(bundle.root, "success");
    const result = runJsonImportDryRun(
      runOptions(bundle, paths)
    );
    const reportPath = path.join(
      paths.reportDirectory,
      "import-report.json"
    );
    const rawReport = fs.readFileSync(reportPath, "utf8");
    const report = JSON.parse(rawReport);

    assert.equal(result.status, "valid");
    assert.equal(result.plannedRowCount, 6);
    assert.equal(result.blockingRejectCount, 0);
    assert.equal(result.quarantineCount, 0);
    assert.equal(
      rawReport,
      `${canonicalize(report)}\n`
    );
    assert.equal(report.checks.integrity, "ok");
    assert.equal(
      report.checks.foreignKeyViolationCount,
      0
    );
    assert.equal(
      report.checks.stablePlayerExternalIdsPreserved,
      true
    );
    assert.equal(report.resetOmissions.length, 12);
    assert.equal(report.protectedFamilies.length, 9);
    assert.equal(report.neverImportFamilies.length, 1);
    assert.doesNotMatch(
      rawReport,
      /must-not-appear|first_name|last_name|full_name|password/
    );

    const database = new Database(paths.databasePath, {
      readonly: true,
    });
    try {
      for (const tableName of [
        "players",
        "player_external_ids",
        "player_source_state",
      ]) {
        assert.equal(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM ${tableName}`
            )
            .get().count,
          0
        );
      }
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations"
          )
          .get().count,
        19
      );
      assert.equal(
        database.pragma("integrity_check", {
          simple: true,
        }),
        "ok"
      );
      assert.deepEqual(
        database.pragma("foreign_key_check"),
        []
      );
    } finally {
      database.close();
    }
  });

  test("repeated imports of one bundle produce identical semantic reports", (t) => {
    const bundle = createSyntheticBundle(t);
    const firstPaths = runPaths(bundle.root, "first");
    const secondPaths = runPaths(bundle.root, "second");
    const first = runJsonImportDryRun(
      runOptions(bundle, firstPaths)
    );
    const second = runJsonImportDryRun(
      runOptions(bundle, secondPaths)
    );
    const firstReport = readReport(
      firstPaths.reportDirectory
    );
    const secondReport = readReport(
      secondPaths.reportDirectory
    );

    assert.equal(
      first.semanticReportHash,
      second.semanticReportHash
    );
    assert.deepEqual(firstReport, secondReport);
    assert.deepEqual(
      firstReport.targetTables.map(
        ({ table, semanticHash }) => ({
          table,
          semanticHash,
        })
      ),
      secondReport.targetTables.map(
        ({ table, semanticHash }) => ({
          table,
          semanticHash,
        })
      )
    );
  });

  test("fails closed for unsupported shapes, unlisted sources, and duplicate protected IDs", (t) => {
    const unsupported = createSyntheticBundle(t, {
      league: syntheticLeague({ schemaVersion: 2 }),
    });
    const unsupportedPaths = runPaths(
      unsupported.root,
      "unsupported"
    );
    assert.throws(
      () =>
        runJsonImportDryRun(
          runOptions(unsupported, unsupportedPaths)
        ),
      assertCode(
        IMPORT_ADAPTER_ERROR_CODES.sourceShapeUnsupported
      )
    );
    assert.equal(
      fs.existsSync(unsupportedPaths.databasePath),
      false
    );
    assert.equal(
      fs.existsSync(unsupportedPaths.reportDirectory),
      false
    );

    const unlisted = createSyntheticBundle(t, {
      extraSources: [
        {
          label: "surprise",
          fileName: "surprise.json",
          content: "{}",
        },
      ],
    });
    assert.throws(
      () =>
        adaptVerifiedSourceBundle({
          bundleDirectory: unlisted.bundleDirectory,
        }),
      assertCode(
        IMPORT_ADAPTER_ERROR_CODES.protectedDataAtRisk
      )
    );

    const duplicate = createSyntheticBundle(t, {
      players: [
        ...syntheticPlayers(),
        {
          ...syntheticPlayers()[0],
          fullName: "Duplicate",
        },
      ],
    });
    assert.throws(
      () =>
        adaptVerifiedSourceBundle({
          bundleDirectory: duplicate.bundleDirectory,
        }),
      assertCode(
        IMPORT_ADAPTER_ERROR_CODES.protectedDataAtRisk
      )
    );
  });

  test("a real SQLite constraint failure rolls back and removes only owned database files", (t) => {
    const bundle = createSyntheticBundle(t);
    const adapted = adaptVerifiedSourceBundle({
      bundleDirectory: bundle.bundleDirectory,
    });
    const invalidRows = {
      ...adapted.rows,
      players: Object.freeze([
        {
          ...adapted.rows.players[0],
          first_name: "",
        },
        ...adapted.rows.players.slice(1),
      ]),
    };
    const invalidAdapted = Object.freeze({
      ...adapted,
      rows: Object.freeze(invalidRows),
    });
    const paths = runPaths(bundle.root, "constraint");

    assert.throws(
      () =>
        runJsonImportDryRun({
          ...runOptions(bundle, paths),
          adaptSourceBundle() {
            return invalidAdapted;
          },
        }),
      assertCode(
        JSON_IMPORT_ERROR_CODES.constraintFailed
      )
    );
    assert.equal(fs.existsSync(paths.databasePath), false);
    assert.equal(
      fs.existsSync(`${paths.databasePath}-wal`),
      false
    );
    assert.equal(
      fs.existsSync(`${paths.databasePath}-shm`),
      false
    );
    assert.equal(
      fs.existsSync(paths.reportDirectory),
      false
    );
    assert.equal(fs.existsSync(bundle.bundleDirectory), true);
  });

  test("rejects existing, overlapping, and repository output paths", (t) => {
    const bundle = createSyntheticBundle(t);
    const existingDatabase = path.join(
      bundle.root,
      "existing.sqlite3"
    );
    fs.writeFileSync(existingDatabase, "protected", "utf8");

    assert.throws(
      () =>
        validateImportPaths({
          sourceBundleDirectory: bundle.bundleDirectory,
          databasePath: existingDatabase,
          reportDirectory: path.join(
            bundle.root,
            "report-existing"
          ),
        }),
      assertCode(JSON_IMPORT_ERROR_CODES.pathUnsafe)
    );
    assert.equal(
      fs.readFileSync(existingDatabase, "utf8"),
      "protected"
    );

    assert.throws(
      () =>
        validateImportPaths({
          sourceBundleDirectory: bundle.bundleDirectory,
          databasePath: path.join(
            bundle.root,
            "safe.sqlite3"
          ),
          reportDirectory: path.join(
            bundle.bundleDirectory,
            "nested-report"
          ),
        }),
      assertCode(JSON_IMPORT_ERROR_CODES.pathUnsafe)
    );

    assert.throws(
      () =>
        validateImportPaths({
          sourceBundleDirectory: bundle.bundleDirectory,
          databasePath: path.join(
            ROOT_DIRECTORY,
            "unsafe-import.sqlite3"
          ),
          reportDirectory: path.join(
            bundle.root,
            "safe-report"
          ),
        }),
      assertCode(JSON_IMPORT_ERROR_CODES.pathUnsafe)
    );
  });

  test("CLI requires every explicit argument and emits only a safe summary", (t) => {
    const bundle = createSyntheticBundle(t);
    const paths = runPaths(bundle.root, "cli");
    const argv = [
      "--source-bundle",
      bundle.bundleDirectory,
      "--database",
      paths.databasePath,
      "--reset-manifest",
      RESET_MANIFEST_PATH,
      "--report",
      paths.reportDirectory,
      "--environment",
      "test",
      "--operating-mode",
      "OFFSEASON_RESET",
      "--dry-run",
    ];

    assert.deepEqual(parseArguments(argv), {
      sourceBundleDirectory: bundle.bundleDirectory,
      databasePath: paths.databasePath,
      resetManifestPath: RESET_MANIFEST_PATH,
      reportDirectory: paths.reportDirectory,
      environment: "test",
      operatingMode: "OFFSEASON_RESET",
      dryRun: true,
    });
    assert.throws(
      () => parseArguments([]),
      assertCode(JSON_IMPORT_ERROR_CODES.argumentInvalid)
    );
    assert.throws(
      () => parseArguments([...argv, "--dry-run"]),
      assertCode(JSON_IMPORT_ERROR_CODES.argumentInvalid)
    );

    const spawned = spawnSync(
      process.execPath,
      [IMPORT_SCRIPT, ...argv],
      {
        cwd: ROOT_DIRECTORY,
        encoding: "utf8",
      }
    );
    assert.equal(spawned.status, 0, spawned.stderr);
    const summary = JSON.parse(spawned.stdout);
    assert.equal(summary.status, "valid");
    assert.equal(summary.plannedRowCount, 6);
    assert.equal(summary.blockingRejectCount, 0);
    assert.equal(
      Object.hasOwn(summary, "databasePath"),
      false
    );
    assert.doesNotMatch(
      spawned.stdout,
      /must-not-appear|Player One|Goalie Two/
    );

    const lines = [];
    const injected = runJsonImportCommand({
      argv,
      output: {
        log(line) {
          lines.push(line);
        },
      },
      runImport() {
        return {
          status: "valid",
          dryRun: true,
          sourceBundleId: "bundle",
          resetManifestId: "manifest",
          semanticReportHash: "hash",
          plannedRowCount: 6,
          blockingRejectCount: 0,
          quarantineCount: 0,
        };
      },
    });
    assert.deepEqual(JSON.parse(lines[0]), injected);
  });

  test("safe reject/quarantine rendering and dry-runs leave protected repository data unchanged", (t) => {
    const hashesBefore = protectedFingerprints();
    const bundle = createSyntheticBundle(t);
    const paths = runPaths(bundle.root, "safe-report");
    runJsonImportDryRun(runOptions(bundle, paths));
    const report = readReport(paths.reportDirectory);
    const failureReport = finalizeImportReport({
      ...report,
      status: "blocked",
      rejects: [
        {
          code: "IMPORT_SOURCE_INVALID",
          sourceLabel: "players",
          copiedRelativePath: "files/players/players.json",
          collection: "players",
          sourceReferenceSha256: "a".repeat(64),
          disposition: "blocking",
        },
      ],
      quarantine: [
        {
          code: "IMPORT_MAPPING_AMBIGUOUS",
          sourceLabel: "players",
          copiedRelativePath: "files/players/players.json",
          collection: "players",
          sourceReferenceSha256: "b".repeat(64),
          disposition: "quarantine",
        },
      ],
    });
    const markdown =
      renderImportReportMarkdown(failureReport);

    assert.match(markdown, /IMPORT_SOURCE_INVALID/);
    assert.match(markdown, /IMPORT_MAPPING_AMBIGUOUS/);
    assert.doesNotMatch(
      markdown,
      /must-not-appear|Player One|Goalie Two|password/
    );
    assert.deepEqual(
      protectedFingerprints(),
      hashesBefore
    );
  });
});
