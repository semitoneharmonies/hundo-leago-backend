const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { startBackendProcess } = require("../../src/bootstrap/startBackendProcess");
const { startProductionMaintenanceProcess } = require("../../src/bootstrap/startProductionMaintenanceProcess");
const { REQUIRED_VALUES, loadProductionMaintenanceConfig } = require("../../src/config/loadProductionMaintenanceConfig");
const { runProductionMaintenanceCommand } = require("../../scripts/start-production-maintenance");
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts/start-production-maintenance.js");
const BUILD = "a".repeat(40), SERVICE = "srv-syntheticfixture1234";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function environment(overrides = {}) {
  return { ...REQUIRED_VALUES, APP_BUILD_ID: BUILD, RENDER_GIT_COMMIT: BUILD,
    RENDER_SERVICE_ID: SERVICE, PRODUCTION_MAINTENANCE_CONFIRMATION: `${SERVICE}:${BUILD}`,
    PORT: "10000", ...overrides };
}
function request(port, requestPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const connection = http.request({ host: "127.0.0.1", port, path: requestPath, method, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    connection.on("error", reject); connection.end();
  });
}
async function localProcess(t, overrides = {}) {
  const processObject = new EventEmitter();
  const result = await startProductionMaintenanceProcess({ env: environment(overrides), processObject,
    createServer(handler) {
      const server = http.createServer(handler), listen = server.listen.bind(server);
      server.listen = (options) => {
        assert.deepEqual(options, { host: "0.0.0.0", port: Number(overrides.PORT || "10000") });
        return listen({ port: 0, host: "127.0.0.1" });
      };
      return server;
    } });
  t.after(() => result.shutdown());
  return { ...result, processObject };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-production-maintenance-fixture-"));
  assert(path.relative(os.tmpdir(), root).startsWith("hundo-production-maintenance-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("production maintenance requires the exact release, service and every writer to be held", () => {
  const valid = environment();
  assert.deepEqual(loadProductionMaintenanceConfig({ env: valid }), { enabled: true, port: 10000, buildId: BUILD, serviceId: SERVICE });
  for (const field of Object.keys(REQUIRED_VALUES)) {
    for (const value of [undefined, "drift"]) {
      assert.throws(() => loadProductionMaintenanceConfig({ env: environment({ [field]: value }) }), { code: "PRODUCTION_MAINTENANCE_CONFIG_INVALID", field });
    }
  }
  for (const [field, value] of [["APP_BUILD_ID", "bad"], ["RENDER_GIT_COMMIT", "b".repeat(40)],
    ["RENDER_SERVICE_ID", "srv-otherfixture1234"], ["PRODUCTION_MAINTENANCE_CONFIRMATION", `${SERVICE}:${"b".repeat(40)}`],
    ["PORT", "0"], ["PORT", "65536"], ["PORT", "1.5"], ["PORT", 10000],
    ["STAGING_MAINTENANCE_HOLD", "true"], ["STAGING_DAILY_AUCTIONS_ENABLED", "true"]]) {
    assert.throws(() => loadProductionMaintenanceConfig({ env: environment({ [field]: value }) }), { code: "PRODUCTION_MAINTENANCE_CONFIG_INVALID" });
  }
  for (const field of ["DATABASE_PATH", "PERSISTENT_DATA_ROOT", "RESEND_API_KEY", "BACKUP_ENCRYPTION_KEY"]) {
    Object.defineProperty(valid, field, { get() { throw new Error("maintenance must not inspect " + field); } });
  }
  assert.equal(loadProductionMaintenanceConfig({ env: valid }).enabled, true);
});

test("invalid production maintenance never creates a listener or registers signal handlers", async () => {
  const processObject = new EventEmitter(); let servers = 0;
  for (const overrides of [{ APP_ENV: "staging" }, { LEAGUE_WRITE_MODE: "open" },
    { PRODUCTION_MAINTENANCE_HOLD: "false" }, { SCHEDULED_JOBS_ENABLED: "true" }, { AUCTIONS_ENABLED: "true" }]) {
    await assert.rejects(startProductionMaintenanceProcess({ env: environment(overrides), processObject,
      createServer() { servers++; throw new Error("must not listen"); } }), { code: "PRODUCTION_MAINTENANCE_CONFIG_INVALID" });
  }
  assert.equal(servers, 0); assert.equal(processObject.eventNames().length, 0);
});

test("normal startup cannot bypass a production hold and retains its old behavior when the flag is absent or false", async () => {
  for (const value of ["true", "TRUE", "", null, 0]) {
    let loaded = 0;
    await assert.rejects(startBackendProcess({ env: { PRODUCTION_MAINTENANCE_HOLD: value },
      loadHoldConfig() { loaded++; }, loadTargetStarter() { loaded++; }, loadHoldStarter() { loaded++; } }),
    { code: "PRODUCTION_MAINTENANCE_ENTRYPOINT_REQUIRED" });
    assert.equal(loaded, 0);
  }
  for (const value of [undefined, "false"]) {
    let loaded = 0;
    const env = value === undefined ? {} : { PRODUCTION_MAINTENANCE_HOLD: value };
    const result = await startBackendProcess({ env, loadHoldConfig() { return { enabled: false }; },
      loadTargetStarter() { loaded++; return async (options) => { assert.equal(options.env, env); return "normal"; }; } });
    assert.equal(loaded, 1); assert.equal(result, "normal");
  }
});

test("production hold serves only exact health reads and rejects application, legacy job and socket requests", async (t) => {
  const result = await localProcess(t), port = result.address.port;
  for (const endpoint of ["/api/v1/health/live", "/api/v1/health/ready"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(port, endpoint, method);
      assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.body, method === "HEAD" ? "" : '{"status":"ok"}');
    }
  }
  for (const [endpoint, method] of [["/", "GET"], ["/api/v1/health/ready?details=true", "GET"],
    ["/api/v1/health/ready", "POST"], ["/api/v1/auth/session", "GET"], ["/api/v1/auth/sign-in", "POST"],
    ["/api/v1/leagues/fixture/teams", "POST"], ["/api/stats/refresh", "POST"],
    ["/socket.io/?EIO=4&transport=polling", "GET"], ["/api/v1/health/live", "OPTIONS"], ["/api/v1/teams", "DELETE"]]) {
    const response = await request(port, endpoint, method);
    assert.equal(response.status, 503); assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(response.body), { error: { code: "SERVICE_MAINTENANCE", message: "Service is temporarily unavailable." } });
    assert.equal(response.headers["set-cookie"], undefined);
    assert(!response.body.includes(BUILD)); assert(!response.body.includes(SERVICE));
  }
  assert.equal(result.mode, "production-maintenance");
  assert.equal(result.server.requestTimeout, 10000);
});

test("shutdown closes incomplete clients and is idempotent for both release signals", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const result = await localProcess(t), socket = net.connect({ host: "127.0.0.1", port: result.address.port });
    await once(socket, "connect"); socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
    const clientErrors = [];
    socket.on("error", (error) => clientErrors.push(error.code));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    result.processObject.emit(signal);
    const first = result.shutdown(); assert.equal(result.shutdown(), first);
    await first; await closed;
    assert(clientErrors.every((code) => code === "ECONNRESET"));
    assert.equal(result.server.listening, false);
    assert.equal(result.processObject.listenerCount("SIGTERM"), 0); assert.equal(result.processObject.listenerCount("SIGINT"), 0);
  }
});

test("an occupied port rejects startup and leaves the existing listener and signal state intact", async (t) => {
  const existing = http.createServer(); existing.listen({ port: 0, host: "127.0.0.1" }); await once(existing, "listening");
  t.after(() => new Promise((resolve) => existing.close(resolve)));
  const processObject = new EventEmitter();
  await assert.rejects(startProductionMaintenanceProcess({ env: environment({ PORT: String(existing.address().port) }), processObject,
    createServer(handler) {
      const server = http.createServer(handler), listen = server.listen.bind(server);
      server.listen = ({ port }) => listen({ port, host: "127.0.0.1" }); return server;
    } }), { code: "EADDRINUSE" });
  assert.equal(existing.listening, true); assert.equal(processObject.eventNames().length, 0);
});

test("the CLI rejects arguments and reports configuration failures without echoing values", async () => {
  await assert.rejects(runProductionMaintenanceCommand({ argv: ["--resume"], env: environment() }), { code: "PRODUCTION_MAINTENANCE_ARGUMENT_INVALID" });
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8",
    env: { ...process.env, ...environment({ PRODUCTION_MAINTENANCE_CONFIRMATION: "synthetic-private-value-never-echo" }) } });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr);
  assert.equal(error.event, "production_maintenance.start_failed"); assert.equal(error.field, "PRODUCTION_MAINTENANCE_CONFIRMATION");
  assert(!result.stderr.includes("synthetic-private-value-never-echo")); assert(!result.stderr.includes(ROOT));
});

test("both real application entrypoints reject a production hold before loading their runtime", (t) => {
  const root = temporary(t), databasePath = path.join(root, "must-not-create.sqlite3");
  for (const entry of ["server.js", "server-compatibility.js"]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, entry)], { cwd: root, encoding: "utf8",
      env: { ...process.env, PRODUCTION_MAINTENANCE_HOLD: "true", DATABASE_PATH: databasePath }, timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "PRODUCTION_MAINTENANCE_ENTRYPOINT_REQUIRED");
    assert(!result.stderr.includes(root)); assert(!result.stderr.includes(ROOT));
    assert.equal(fs.existsSync(databasePath), false);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test("a fresh maintenance process does not load database, application or legacy runtimes and preserves disk inputs", async (t) => {
  const root = temporary(t), sourceFile = path.join(root, "legacy.json"), databasePath = path.join(root, "absent.sqlite3");
  fs.writeFileSync(sourceFile, '{"synthetic":"preserve"}'); const before = sha(fs.readFileSync(sourceFile));
  const reservation = net.createServer(); reservation.listen({ port: 0, host: "127.0.0.1" }); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const program = `const {runProductionMaintenanceCommand}=require(${JSON.stringify(SCRIPT)});
    runProductionMaintenanceCommand({argv:[]}).then(runtime=>{
      process.send({kind:'ready',port:runtime.address.port,modules:Object.keys(require.cache)});
      process.on('message',async message=>{if(message==='stop'){await runtime.shutdown();process.send({kind:'closed'});process.disconnect();}});
    }).catch(()=>{process.exitCode=1;process.disconnect();});`;
  const child = spawn(process.execPath, ["-e", program], { cwd: root, windowsHide: true,
    env: { ...process.env, ...environment({ PORT: String(port), DATABASE_PATH: databasePath, PERSISTENT_DATA_ROOT: path.join(root, "not-created") }) },
    stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
  assert.equal(ready.kind, "ready");
  const loaded = ready.modules.map((file) => path.relative(ROOT, file).replaceAll("\\", "/")).sort();
  assert.deepEqual(loaded, ["scripts/start-production-maintenance.js", "src/bootstrap/startProductionMaintenanceProcess.js",
    "src/bootstrap/startStagingMaintenanceHoldProcess.js", "src/config/loadProductionMaintenanceConfig.js"]);
  assert.equal((await request(ready.port, "/api/stats/refresh", "POST")).status, 503);
  assert.equal((await request(ready.port, "/api/v1/health/ready")).status, 200);
  const closed = once(child, "message", { signal: AbortSignal.timeout(15000) }), exited = once(child, "exit");
  child.send("stop"); assert.equal((await closed)[0].kind, "closed"); assert.equal((await exited)[0], 0);
  assert.equal(stderr, "");
  const log = JSON.parse(stdout); assert.equal(log.databaseOpened, false); assert.equal(log.jobsStarted, false);
  assert.equal(log.deliveryStarted, false); assert.equal(sha(fs.readFileSync(sourceFile)), before);
  assert.equal(fs.existsSync(databasePath), false); assert.equal(fs.existsSync(path.join(root, "not-created")), false);
});

test("an exact synthetic import can complete while the maintenance listener keeps every application route closed", async (t) => {
  const root = temporary(t), input = path.join(root, "inputs"); fs.mkdirSync(input);
  const league = { schemaVersion: 1, meta: { createdAt: "synthetic" }, teams: [], freeAgents: [], leagueLog: [], tradeProposals: [], tradeBlock: [],
    matchups: { seasonId: "2025-2026", scheduleWeeks: [], currentWeekIndex: 0, currentWeekId: null, locksByTeam: {},
      baselineByPlayerId: {}, baselineByWeekId: {}, resultsByWeek: {}, lastRolloverWeekId: null },
    settings: { frozen: false, managerLoginHistory: [], managerLastLogin: {} }, nextAuctionDeadline: null,
    lastAutoWeeklySnapshotId: null, lastAutoAuctionRolloverId: null };
  const player = { id: 1, fullName: "Synthetic Player", firstName: "Synthetic", lastName: "Player", position: "F",
    teamAbbrev: "AAA", birthDate: "2000-01-01", active: true };
  const leagueFile = path.join(input, "league-state.json"), playerFile = path.join(input, "players.json");
  fs.writeFileSync(leagueFile, JSON.stringify(league)); fs.writeFileSync(playerFile, JSON.stringify([player]));
  const originals = [sha(fs.readFileSync(leagueFile)), sha(fs.readFileSync(playerFile))];
  const { inventorySourceBundle } = require("../../src/infrastructure/migration/sourceInventory");
  const { planProductionImport, runProductionImport } = require("../../src/infrastructure/migration/runProductionImport");
  const { discoverMigrations } = require("../../src/infrastructure/database/migrate");
  const bundle = path.join(root, "source-bundle"), manifest = path.join(ROOT, "database/reset-manifests/2026-season-1-reset.json");
  inventorySourceBundle({ sources: [{ label: "league_state", path: leagueFile }, { label: "players", path: playerFile }],
    outputDirectory: bundle, capturedAtMs: 1000, applicationBuildId: "synthetic", sourceGitCommit: BUILD });
  const options = { environment: "production", operatingMode: "OFFSEASON_RESET", applicationBuildId: BUILD,
    expectedSchemaVersion: discoverMigrations({ migrationsDirectory: path.join(ROOT, "database/migrations") }).at(-1).id,
    persistentRoot: root, targetDirectory: path.join(root, "attempt"), sourceBundleDirectory: bundle,
    sourceSha256: sha(fs.readFileSync(path.join(bundle, "source-bundle.json"))), resetManifestPath: manifest, resetSha256: sha(fs.readFileSync(manifest)) };
  const runtime = await localProcess(t);
  const plan = planProductionImport(options), imported = runProductionImport({ ...options, productionConfirmation: plan.planSha256 });
  assert.equal(imported.status, "valid"); assert.equal(imported.importedRowCount, 3);
  assert.equal(imported.applicationAuthorityChanged, false); assert.equal(imported.environmentIdentityInitialized, false);
  assert.equal((await request(runtime.address.port, "/api/v1/auth/session")).status, 503);
  assert.equal((await request(runtime.address.port, "/api/stats/refresh", "POST")).status, 503);
  assert.equal((await request(runtime.address.port, "/api/v1/health/ready")).status, 200);
  assert.deepEqual([sha(fs.readFileSync(leagueFile)), sha(fs.readFileSync(playerFile))], originals);
  let loaded = 0;
  await assert.rejects(startBackendProcess({ env: environment(), loadTargetStarter() { loaded++; } }), { code: "PRODUCTION_MAINTENANCE_ENTRYPOINT_REQUIRED" });
  assert.equal(loaded, 0); assert.equal(runtime.server.listening, true);
});
