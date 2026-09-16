const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { runBootstrapCommand, PRODUCTION_CONFIRMATION } = require("../../scripts/bootstrap-first-platform-administrator");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase, discoverMigrations } = require("../../src/infrastructure/database/migrate");
const { initializeDatabaseIdentity } = require("../../src/infrastructure/database/databaseIdentity");
const { planProductionImport, runProductionImport } = require("../../src/infrastructure/migration/runProductionImport");
const { inventorySourceBundle } = require("../../src/infrastructure/migration/sourceInventory");
const ROOT = path.resolve(__dirname, "../.."), MIGRATIONS = path.join(ROOT, "database/migrations");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const ENVIRONMENT_ID = "production-synthetic-environment", DATABASE_ID = "production-synthetic-database";

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-production-bootstrap-"));
  assert(!path.relative(ROOT, root).split(path.sep).every(part => part !== ".."));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function hashes(root) {
  const result = {};
  function walk(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name); if (item.isDirectory()) walk(file);
    else result[path.relative(root, file)] = sha(fs.readFileSync(file));
  } }
  walk(root); return result;
}
function rows(file) {
  const db = new Database(file, { fileMustExist: true });
  db.pragma("query_only = ON");
  try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()])); }
  finally { db.close(); }
}
function identity(root, file, environmentId = ENVIRONMENT_ID, databaseId = DATABASE_ID) {
  return initializeDatabaseIdentity({ databasePath: file, persistentRoot: root, applicationEnvironment: "production", environmentId, databaseId,
    databaseCreatedAt: "2026-01-01T00:00:00.000Z", migrationsDirectory: MIGRATIONS, productionConfirmation: databaseId });
}
function fixture(t, { initialize = true } = {}) {
  const root = temporary(t), file = path.join(root, "candidate.sqlite3");
  const opened = openDatabase({ databasePath: file, environment: "test" });
  try { migrateDatabase({ database: opened.database, migrationsDirectory: MIGRATIONS, applicationBuildId: "a".repeat(40), now: () => 1000 }); }
  finally { opened.database.close(); }
  if (initialize) identity(root, file);
  return { root, file };
}
function configuration(root, file, extra = {}) {
  return { argv: ["--app-env", "production", "--confirm-app-env", "production", "--database", file,
    "--migrations", MIGRATIONS, "--persistent-root", root, "--production-confirmation", PRODUCTION_CONFIRMATION],
    env: { APP_ENV: "production", APP_ENVIRONMENT_ID: ENVIRONMENT_ID, DATABASE_ID, BOOTSTRAP_ADMIN_EMAIL: "bootstrap@example.test",
      BOOTSTRAP_ADMIN_DISPLAY_NAME: "Synthetic Administrator", PUBLIC_FRONTEND_ORIGIN: "https://production.example.test",
      ACTION_TOKEN_DELIVERY_KEY: crypto.randomBytes(32).toString("base64url"), ...extra }, output: { log() {} } };
}

test("production bootstrap rejects a different configured database identity without creating an account", t => {
  const { root, file } = fixture(t), before = hashes(root);
  assert.throws(() => runBootstrapCommand(configuration(root, file, { DATABASE_ID: "different-production-database" })), { code: "DATABASE_IDENTITY_MISMATCH" });
  assert.deepEqual(hashes(root), before);
  assert.throws(() => runBootstrapCommand(configuration(root, file, { APP_ENVIRONMENT_ID: "different-production-environment" })), { code: "DATABASE_IDENTITY_MISMATCH" });
  assert.deepEqual(hashes(root), before);
});

test("production bootstrap requires explicit configured production identity before opening a destination", t => {
  const root = temporary(t), file = path.join(root, "must-not-be-created.sqlite3");
  for (const extra of [{ APP_ENV: "staging" }, { APP_ENV: undefined }, { APP_ENVIRONMENT_ID: undefined }, { DATABASE_ID: undefined },
    { APP_ENVIRONMENT_ID: "" }, { DATABASE_ID: "" }]) {
    assert.throws(() => runBootstrapCommand(configuration(root, file, extra)), { code: "FIRST_PLATFORM_ADMINISTRATOR_PRODUCTION_CONFIG_INVALID" });
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test("production bootstrap refuses missing and uninitialized databases without creating identity or account rows", t => {
  const { root, file } = fixture(t, { initialize: false }), before = hashes(root);
  assert.throws(() => runBootstrapCommand(configuration(root, file)), { code: "DATABASE_IDENTITY_UNINITIALIZED" });
  assert.deepEqual(hashes(root), before);
  assert.throws(() => runBootstrapCommand(configuration(root, path.join(root, "missing.sqlite3"))), { code: "DATABASE_PATH_REQUIRED" });
  assert.deepEqual(hashes(root), before);
});

test("production bootstrap rejects insecure or noncanonical setup-link origins before opening a database", t => {
  const root = temporary(t), file = path.join(root, "must-not-be-created.sqlite3");
  for (const origin of ["http://production.example.test", "https://production.example.test/path", "https://user:secret@production.example.test", "not-an-origin"]) {
    assert.throws(() => runBootstrapCommand(configuration(root, file, { PUBLIC_FRONTEND_ORIGIN: origin })), { code: "FIRST_PLATFORM_ADMINISTRATOR_PRODUCTION_CONFIG_INVALID" });
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test("production bootstrap cannot select a database outside the persistent root", t => {
  const inside = fixture(t), other = fixture(t), before = hashes(other.root);
  assert.throws(() => runBootstrapCommand(configuration(inside.root, other.file)), { code: "DATABASE_PATH_OUTSIDE_PERSISTENT_ROOT" });
  assert.deepEqual(hashes(other.root), before);
});

test("production bootstrap refuses existing WAL or journal state without changing any selected file", t => {
  const { root, file } = fixture(t);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = file + suffix; fs.writeFileSync(sidecar, "synthetic-preserved-state");
    const before = hashes(root);
    assert.throws(() => runBootstrapCommand(configuration(root, file)), { code: "FIRST_PLATFORM_ADMINISTRATOR_DATABASE_NOT_CLOSED" });
    assert.deepEqual(hashes(root), before);
    fs.unlinkSync(sidecar);
  }
});

test("a confirmed synthetic production import and identity lead to exactly one pending administrator and encrypted setup delivery", t => {
  const root = temporary(t), input = path.join(root, "input"); fs.mkdirSync(input);
  const league = { schemaVersion: 1, meta: { createdAt: "synthetic" }, teams: [], freeAgents: [], leagueLog: [], tradeProposals: [], tradeBlock: [],
    matchups: { seasonId: "2025-2026", scheduleWeeks: [], currentWeekIndex: 0, currentWeekId: null, locksByTeam: {},
      baselineByPlayerId: {}, baselineByWeekId: {}, resultsByWeek: {}, lastRolloverWeekId: null },
    settings: { frozen: false, managerLoginHistory: [], managerLastLogin: {} }, nextAuctionDeadline: null,
    lastAutoWeeklySnapshotId: null, lastAutoAuctionRolloverId: null };
  const leagueFile = path.join(input, "league-state.json"), playerFile = path.join(input, "players.json");
  fs.writeFileSync(leagueFile, JSON.stringify(league));
  fs.writeFileSync(playerFile, JSON.stringify([{ id: 1, fullName: "Synthetic Player", firstName: "Synthetic", lastName: "Player", position: "F", teamAbbrev: "AAA", birthDate: "2000-01-01", active: true }]));
  const bundle = path.join(root, "bundle");
  inventorySourceBundle({ sources: [{ label: "league_state", path: leagueFile }, { label: "players", path: playerFile }], outputDirectory: bundle,
    capturedAtMs: 1000, applicationBuildId: "synthetic", sourceGitCommit: "0123456789abcdef" });
  const manifest = path.join(root, "reset.json"); fs.copyFileSync(path.join(ROOT, "database/reset-manifests/2026-season-1-reset.json"), manifest);
  const original = hashes(input), originalBundle = hashes(bundle);
  const options = { environment: "production", operatingMode: "OFFSEASON_RESET", applicationBuildId: "a".repeat(40),
    expectedSchemaVersion: discoverMigrations({ migrationsDirectory: MIGRATIONS }).at(-1).id, persistentRoot: root,
    targetDirectory: path.join(root, "attempt"), sourceBundleDirectory: bundle, sourceSha256: sha(fs.readFileSync(path.join(bundle, "source-bundle.json"))),
    resetManifestPath: manifest, resetSha256: sha(fs.readFileSync(manifest)) };
  const plan = planProductionImport(options), imported = runProductionImport({ ...options, productionConfirmation: plan.planSha256 });
  assert.equal(imported.status, "valid"); assert.equal(imported.environmentIdentityInitialized, false); assert.equal(imported.applicationAuthorityChanged, false);
  const file = path.join(options.targetDirectory, "candidate.sqlite3"), importedHash = sha(fs.readFileSync(file));
  assert.equal(identity(root, file).initialized, true);
  const before = rows(file), output = [], config = configuration(root, file); config.output.log = value => output.push(value);
  const created = runBootstrapCommand(config), after = rows(file);
  assert.equal(created.code, "FIRST_PLATFORM_ADMINISTRATOR_CREATED"); assert.equal(created.deliveryQueued, true);
  assert.equal(output.length, 1); assert.equal(sha(fs.readFileSync(file)) === importedHash, false);
  const changed = Object.keys(after).filter(table => JSON.stringify(after[table]) !== JSON.stringify(before[table])).sort();
  assert.deepEqual(changed, ["account_action_tokens", "outbox_events", "platform_roles", "security_audit_events", "users"]);
  assert.equal(after.users.length, 1); assert.equal(JSON.parse(after.users[0]).status, "pending_credential_setup");
  assert.equal(after.user_credentials.length, 0); assert.equal(after.sessions.length, 0); assert.equal(after.job_runs.length, 0);
  assert.equal(after.outbox_events.length, 1); assert.equal(JSON.parse(after.outbox_events[0]).status, "pending");
  assert.equal(after.security_audit_events.length, 1); assert.equal(JSON.parse(after.security_audit_events[0]).event_type, "system_bootstrap.platform_administrator_created");
  const token = JSON.parse(after.account_action_tokens[0]); assert.equal(token.expires_at_ms - token.created_at_ms, 72 * 60 * 60 * 1000);
  for (const value of [config.env.BOOTSTRAP_ADMIN_EMAIL, config.env.BOOTSTRAP_ADMIN_DISPLAY_NAME, config.env.ACTION_TOKEN_DELIVERY_KEY]) assert.equal(output[0].includes(value), false);
  assert.throws(() => runBootstrapCommand(config), { code: "FIRST_PLATFORM_ADMINISTRATOR_EXISTS" }); assert.deepEqual(rows(file), after);
  assert.deepEqual(hashes(input), original); assert.deepEqual(hashes(bundle), originalBundle);
});

test("the actual production bootstrap CLI reports mismatched identity without printing protected configuration", t => {
  const { root, file } = fixture(t), config = configuration(root, file, { DATABASE_ID: "different-production-database" });
  const before = hashes(root), child = spawnSync(process.execPath, [path.join(ROOT, "scripts/bootstrap-first-platform-administrator.js"), ...config.argv],
    { cwd: ROOT, env: { ...process.env, ...config.env }, encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.equal(JSON.parse(child.stderr).error.code, "DATABASE_IDENTITY_MISMATCH");
  for (const value of [config.env.DATABASE_ID, ENVIRONMENT_ID, root, config.env.BOOTSTRAP_ADMIN_EMAIL, config.env.ACTION_TOKEN_DELIVERY_KEY]) assert.equal(child.stderr.includes(value), false);
  assert.deepEqual(hashes(root), before);
});
