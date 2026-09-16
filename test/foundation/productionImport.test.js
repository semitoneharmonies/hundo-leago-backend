const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const { planProductionImport, runProductionImport } = require("../../src/infrastructure/migration/runProductionImport");
const { OPTIONS, parseArguments } = require("../../scripts/db-import-production");
const { inventorySourceBundle, SOURCE_BUNDLE_FILE_NAME } = require("../../src/infrastructure/migration/sourceInventory");
const { discoverMigrations } = require("../../src/infrastructure/database/migrate");
const { calculateSemanticReportHash } = require("../../src/infrastructure/migration/importReport");
const { publishImportReport } = require("../../src/infrastructure/migration/importReport");
const { readDatabaseIdentity } = require("../../src/infrastructure/database/databaseIdentity");
const ROOT = path.resolve(__dirname, "..", "..");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t, { extraLeagueFields = {}, copyBundleFrom } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-production-import-fixture-"));
  // This root is created exclusively by this test, outside the source checkout.
  assert(path.relative(os.tmpdir(), root).startsWith("hundo-production-import-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input"); fs.mkdirSync(input);
  const source = path.join(root, "source");
  const league = {
    schemaVersion: 1, meta: { createdAt: "synthetic" },
    teams: [{ name: "Synthetic team", roster: [{ name: "Synthetic player", playerId: 1, salary: 10, position: "F", onIR: false }], buyouts: [] }],
    freeAgents: [], leagueLog: [], tradeProposals: [], tradeBlock: [],
    matchups: { seasonId: "2025-2026", scheduleWeeks: [], currentWeekIndex: 0, currentWeekId: null,
      locksByTeam: {}, baselineByPlayerId: {}, baselineByWeekId: {}, resultsByWeek: {}, lastRolloverWeekId: null },
    settings: { frozen: false, managerLoginHistory: [], managerLastLogin: {} },
    nextAuctionDeadline: null, lastAutoWeeklySnapshotId: null, lastAutoAuctionRolloverId: null,
    ...extraLeagueFields,
  };
  const players = [{ id: 1, fullName: "Synthetic player", firstName: "Synthetic", lastName: "Player",
    position: "F", teamAbbrev: "AAA", birthDate: "2000-01-01", active: true },
  { id: 2, fullName: "Synthetic goalie", firstName: "Synthetic", lastName: "Goalie",
    position: "G", teamAbbrev: null, birthDate: "1999-02-03", active: false }];
  const leaguePath = path.join(input, "league-state.json"), playersPath = path.join(input, "players.json");
  fs.writeFileSync(leaguePath, JSON.stringify(league)); fs.writeFileSync(playersPath, JSON.stringify(players));
  if (copyBundleFrom) fs.cpSync(copyBundleFrom, source, { recursive: true });
  else inventorySourceBundle({ sources: [{ label: "league_state", path: leaguePath }, { label: "players", path: playersPath }],
    outputDirectory: source, capturedAtMs: 1000, applicationBuildId: "synthetic-fixture", sourceGitCommit: "0123456789abcdef" });
  const reset = path.join(root, "reset.json");
  fs.copyFileSync(path.join(ROOT, "database/reset-manifests/2026-season-1-reset.json"), reset);
  const options = { environment: "production", operatingMode: "OFFSEASON_RESET",
    applicationBuildId: "a".repeat(40), expectedSchemaVersion: discoverMigrations({ migrationsDirectory: path.join(ROOT, "database/migrations") }).at(-1).id,
    persistentRoot: root, targetDirectory: path.join(root, "attempt"), sourceBundleDirectory: source,
    sourceSha256: sha(fs.readFileSync(path.join(source, SOURCE_BUNDLE_FILE_NAME))),
    resetManifestPath: reset, resetSha256: sha(fs.readFileSync(reset)) };
  return { root, input, options };
}
function treeHashes(root) {
  const entries = {};
  function walk(directory) {
    for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, file.name), relative = path.relative(root, full);
      if (file.isDirectory()) { entries[relative] = "directory"; walk(full); }
      else entries[relative] = sha(fs.readFileSync(full));
    }
  }
  walk(root); return entries;
}
function confirmed(options) {
  return { ...options, productionConfirmation: planProductionImport(options).planSha256 };
}
function code(expected) { return (error) => error?.code === expected; }
function cliArgs(options) {
  return Object.entries(OPTIONS).filter(([, name]) => options[name] !== undefined).flatMap(([flag, name]) => [flag, String(options[name])]);
}

test("production import plan performs no writes and confirmation binds source, schema, build and destination", (t) => {
  const { root, options } = fixture(t), before = treeHashes(root);
  const plan = planProductionImport(options);
  assert.deepEqual(planProductionImport(options), plan);
  assert.equal(plan.plannedRowCount, 6); assert.equal(plan.activatesDatabase, false);
  assert.equal(plan.initializesEnvironmentIdentity, false);
  assert.deepEqual(treeHashes(root), before);
  assert.throws(() => runProductionImport(options), code("IMPORT_PRODUCTION_CONFIRMATION_REQUIRED"));
  const approval = { ...options, productionConfirmation: plan.planSha256 };
  assert.throws(() => runProductionImport({ ...approval, targetDirectory: path.join(root, "another") }), code("IMPORT_PRODUCTION_CONFIRMATION_REQUIRED"));
  assert.throws(() => runProductionImport({ ...approval, applicationBuildId: "b".repeat(40) }), code("IMPORT_PRODUCTION_CONFIRMATION_REQUIRED"));
  assert.throws(() => runProductionImport({ ...approval, expectedSchemaVersion: options.expectedSchemaVersion - 1 }), code("IMPORT_SCHEMA_MISMATCH"));
  assert.deepEqual(treeHashes(root), before);
});

test("production import commits deterministic player identities, reconciles reset records and leaves activation unavailable", (t) => {
  const first = fixture(t), second = fixture(t, { copyBundleFrom: first.options.sourceBundleDirectory });
  const original = treeHashes(first.input), copied = treeHashes(first.options.sourceBundleDirectory);
  const a = runProductionImport(confirmed(first.options)), b = runProductionImport(confirmed(second.options));
  assert.equal(a.status, "valid"); assert.equal(a.importedRowCount, 6);
  assert.equal(a.applicationAuthorityChanged, false); assert.equal(a.jobsStarted, false); assert.equal(a.messagesSent, false);
  const reports = [first, second].map(({ options }) => JSON.parse(fs.readFileSync(path.join(options.targetDirectory, "report/import-report.json"), "utf8")));
  assert.deepEqual(reports[0].targetTables, reports[1].targetTables);
  assert.deepEqual(reports[0].money, reports[1].money);
  assert.deepEqual(reports[0].mappingEntries, reports[1].mappingEntries);
  // Destination-specific execution receipts remain separate from deterministic reconciliation.
  assert.notEqual(a.planSha256, b.planSha256);
  assert.equal(a.semanticReportHash, b.semanticReportHash);
  assert.deepEqual(reports[0], reports[1]);
  for (const report of reports) {
    assert.equal(report.semanticReportHash, calculateSemanticReportHash(report));
    assert.equal(report.money.reconciled, true); assert.equal(report.ownership.reconciled, true);
    assert.equal(report.resetOmissions.find((row) => row.familyId === "season_1_rosters").sourceCount, 1);
    assert(report.protectedFamilies.every((row) => row.preserved));
  }
  const file = path.join(first.options.targetDirectory, "candidate.sqlite3");
  assert.equal(sha(fs.readFileSync(file)), a.databaseSha256);
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) count FROM players").get().count, 2);
    assert.deepEqual(database.prepare("SELECT external_value FROM player_external_ids ORDER BY external_value").all().map((row) => row.external_value), ["1", "2"]);
    for (const table of ["teams", "users", "user_credentials", "player_ownerships", "contracts", "buyout_obligations", "job_runs", "outbox_events"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0, table);
    }
    assert.throws(() => readDatabaseIdentity(database), code("DATABASE_IDENTITY_UNINITIALIZED"));
    assert.equal(database.pragma("user_version", { simple: true }), first.options.expectedSchemaVersion);
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
  assert.deepEqual(treeHashes(first.input), original); assert.deepEqual(treeHashes(first.options.sourceBundleDirectory), copied);
  const targetBefore = treeHashes(first.options.targetDirectory);
  assert.throws(() => runProductionImport({ ...first.options, productionConfirmation: a.planSha256 }), code("IMPORT_PATH_UNSAFE"));
  assert.deepEqual(treeHashes(first.options.targetDirectory), targetBefore);
});

test("source and reset changes after review fail before any destination is created", (t) => {
  for (const field of ["sourceSha256", "resetSha256"]) {
    const { root, options } = fixture(t), before = treeHashes(root);
    const approved = confirmed(options);
    assert.throws(() => runProductionImport({ ...approved, [field]: "f".repeat(64) }), code("IMPORT_INPUT_CHANGED"));
    assert.deepEqual(treeHashes(root), before);
  }
  const { options } = fixture(t), approved = confirmed(options);
  const manifest = JSON.parse(fs.readFileSync(path.join(options.sourceBundleDirectory, SOURCE_BUNDLE_FILE_NAME), "utf8"));
  const copiedFile = manifest.sources[0].files[0].copiedPath;
  fs.appendFileSync(path.join(options.sourceBundleDirectory, copiedFile), "changed");
  assert.throws(() => runProductionImport(approved));
  assert.equal(fs.existsSync(options.targetDirectory), false);
});

test("unknown protected account data stops the import without changing the source", (t) => {
  const { root, options } = fixture(t, { extraLeagueFields: { users: [{ id: "protected-account" }] } });
  const before = treeHashes(root);
  assert.throws(() => planProductionImport(options));
  assert.deepEqual(treeHashes(root), before);
  assert.equal(fs.existsSync(options.targetDirectory), false);
});

test("existing directories and targets outside the persistent root are preserved", (t) => {
  const { root, options } = fixture(t);
  fs.mkdirSync(options.targetDirectory); fs.writeFileSync(path.join(options.targetDirectory, "existing.sqlite3"), "preserve");
  const before = treeHashes(root);
  assert.throws(() => planProductionImport(options), code("IMPORT_PATH_UNSAFE"));
  assert.throws(() => planProductionImport({ ...options, targetDirectory: path.join(path.dirname(root), "outside-import-attempt") }), code("IMPORT_PATH_UNSAFE"));
  assert.throws(() => planProductionImport({ ...options, targetDirectory: options.sourceBundleDirectory }), code("IMPORT_PATH_UNSAFE"));
  assert.deepEqual(treeHashes(root), before);
});

test("a linked target parent cannot redirect a production import", (t) => {
  const { root, options } = fixture(t), actual = path.join(root, "actual"), linked = path.join(root, "linked");
  fs.mkdirSync(actual); fs.symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => planProductionImport({ ...options, targetDirectory: path.join(linked, "attempt") }), code("IMPORT_PATH_UNSAFE"));
  assert.deepEqual(fs.readdirSync(actual), []);
});

test("report failure retains only the new attempt and does not produce an activation receipt", (t) => {
  const { options, input } = fixture(t), before = treeHashes(input);
  const approved = confirmed(options);
  assert.throws(() => runProductionImport(approved, { publishReport() { throw new Error("synthetic publication failure"); } }));
  assert.equal(fs.existsSync(path.join(options.targetDirectory, "candidate.sqlite3")), true);
  assert.equal(fs.existsSync(path.join(options.targetDirectory, "import-result.json")), false);
  const failure = JSON.parse(fs.readFileSync(path.join(options.targetDirectory, "import-failed.json"), "utf8"));
  assert.equal(failure.status, "failed"); assert.equal(failure.applicationAuthorityChanged, false);
  assert.equal(failure.retainedForDiagnosis, true); assert.deepEqual(treeHashes(input), before);
  const retained = treeHashes(options.targetDirectory);
  assert.throws(() => runProductionImport(approved), code("IMPORT_PATH_UNSAFE"));
  assert.deepEqual(treeHashes(options.targetDirectory), retained);
});

test("production CLI plans read-only then executes only the exact plan and emits no source record values", (t) => {
  const { root, options } = fixture(t), before = treeHashes(root);
  const invoke = (args) => spawnSync(process.execPath, [path.join(ROOT, "scripts/db-import-production.js"), ...args], { cwd: ROOT, encoding: "utf8" });
  const planned = invoke([...cliArgs(options), "--plan"]);
  assert.equal(planned.status, 0, planned.stderr); assert.deepEqual(treeHashes(root), before);
  const plan = JSON.parse(planned.stdout);
  const executed = invoke(cliArgs({ ...options, productionConfirmation: plan.planSha256 }));
  assert.equal(executed.status, 0, executed.stderr);
  const result = JSON.parse(executed.stdout);
  assert.equal(result.status, "valid"); assert.equal(result.importedRowCount, 6);
  assert.equal(result.environmentIdentityInitialized, false);
  assert(!executed.stdout.includes("Synthetic player")); assert(!executed.stdout.includes(root));
  const repeated = invoke(cliArgs({ ...options, productionConfirmation: plan.planSha256 }));
  assert.equal(repeated.status, 1); assert(!repeated.stderr.includes(root));
});

test("an input change during report publication leaves a failed attempt instead of a success receipt", (t) => {
  const { options, input } = fixture(t), original = treeHashes(input);
  const approved = confirmed(options);
  assert.throws(() => runProductionImport(approved, {
    publishReport(arguments_) {
      const result = publishImportReport(arguments_);
      fs.appendFileSync(options.resetManifestPath, "\n");
      return result;
    },
  }), code("IMPORT_INPUT_CHANGED"));
  assert.equal(fs.existsSync(path.join(options.targetDirectory, "import-result.json")), false);
  assert.equal(fs.existsSync(path.join(options.targetDirectory, "import-failed.json")), true);
  assert.equal(fs.existsSync(path.join(options.targetDirectory, "candidate.sqlite3")), true);
  assert.deepEqual(treeHashes(input), original);
});

test("production CLI rejects ambiguous options and leaves the staging and dry-run interfaces restricted", (t) => {
  const { options } = fixture(t), argv = [...cliArgs(options), "--plan"];
  assert.equal(parseArguments(argv).planOnly, true);
  for (const args of [[], [...argv, "--plan"], [...argv, "--confirm-production", "a".repeat(64)],
    [...argv, "--environment", "production"], [...argv, "--unknown", "x"], [...argv, "__proto__", "x"]]) {
    assert.throws(() => parseArguments(args));
  }
  const { parseArguments: staging } = require("../../scripts/db-import-staging");
  const { parseArguments: dryRun } = require("../../scripts/db-import-json");
  assert.throws(() => staging(argv)); assert.throws(() => dryRun(argv));
  for (const environment of ["staging", "test", "development"]) {
    assert.throws(() => planProductionImport({ ...options, environment }), code("IMPORT_ARGUMENT_INVALID"));
  }
  assert.equal(fs.existsSync(options.targetDirectory), false);
});
