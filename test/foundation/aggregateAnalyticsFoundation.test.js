"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const { createAggregateAnalyticsStore, validateAggregateInput, CATEGORIES } = require("../../src/analytics/createAggregateAnalyticsStore");
const { createAggregateAnalyticsRouter } = require("../../src/transport/http/createAggregateAnalyticsRouter");
const { createTargetRequestSecurity } = require("../../src/transport/http/createTargetRequestSecurity");
const { createPlatformAuthorizationService } = require("../../src/application/services/authorization/requirePlatformAdministrator");

const NOW = Date.parse("2026-11-27T08:00:00Z");
const ORIGIN = "https://hundo.example";
const USER = "00000000-0000-4000-8000-000000000001";
const INPUT = { product: "daily", category: "room", pageViews: 1, activeSeconds: 30 };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-aggregate-"));
  const filename = path.join(directory, "analytics.sqlite3");
  let now = NOW;
  const accountReads = [];
  const store = createAggregateAnalyticsStore({ filename, clock: () => now,
    readAccountTotals(range) { accountReads.push(range); return { total: 9, createdInPeriod: 2 }; }, ...options });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, filename, store, accountReads, setNow(value) { now = value; } };
}
function databaseAt(filename, operation) {
  const db = new DatabaseSync(filename);
  try { return operation(db); } finally { db.close(); }
}

test("new analytics reads report unmeasured without creating a file or directory entry", t => {
  const fixtureValue = fixture(t);
  assert.deepEqual(fs.readdirSync(fixtureValue.directory), []);
  const result = fixtureValue.store.read();
  assert.equal(result.measurement.startedOn, null);
  assert.equal(result.measurement.coverage, "not_started");
  assert.deepEqual(result.totals, { pageViews: 0, activeSeconds: 0 });
  assert.equal(result.daily.length, 28);
  assert.deepEqual(result.products.map(p => p.product), ["leago", "daily", "shared"]);
  assert.deepEqual(result.accounts, { total: 9, createdInPeriod: 2 });
  assert.deepEqual(fixtureValue.accountReads, [{
    startMs: Date.parse("2026-10-31T08:00:00Z"), endMs: Date.parse("2026-11-28T08:00:00Z"),
  }]);
  assert.deepEqual(fs.readdirSync(fixtureValue.directory), []);
});

test("strict aggregate allowlist rejects identifying extras, invalid category pairs and unbounded counts before opening storage", t => {
  const { store, filename } = fixture(t);
  const bad = [
    null, [], {}, { ...INPUT, userId: USER }, { ...INPUT, email: "private@example.test" },
    { ...INPUT, path: "/daily/rooms/private" }, { ...INPUT, timestamp: NOW },
    { ...INPUT, product: "unknown" }, { ...INPUT, product: "daily", category: "players" },
    { ...INPUT, category: "../private" }, { ...INPUT, pageViews: 2 }, { ...INPUT, pageViews: -1 },
    { ...INPUT, pageViews: "1" }, { ...INPUT, activeSeconds: 61 }, { ...INPUT, activeSeconds: -1 },
    { ...INPUT, activeSeconds: 0.5 }, { ...INPUT, activeSeconds: Infinity },
    { ...INPUT, pageViews: 0, activeSeconds: 0 },
  ];
  for (const input of bad) assert.throws(() => store.record(input), { code: "ANALYTICS_INPUT_INVALID" });
  assert.equal(fs.existsSync(filename), false);
  for (const [product, categories] of Object.entries(CATEGORIES)) {
    for (const category of categories) assert.deepEqual(validateAggregateInput({ product, category, pageViews: 0, activeSeconds: 60 }),
      { product, category, pageViews: 0, activeSeconds: 60 });
  }
  for (const days of [0, 1, 30, "28", NaN]) assert.throws(() => store.read(days), { code: "ANALYTICS_INPUT_INVALID" });
});

test("storage combines counters into fixed daily categories without event histories or identifiers", t => {
  const { store, filename } = fixture(t);
  store.record(INPUT);
  store.record(INPUT);
  store.record({ product: "leago", category: "players", pageViews: 1, activeSeconds: 12 });
  const before = fs.readFileSync(filename);
  const result = store.read(7);
  assert.deepEqual(result.totals, { pageViews: 3, activeSeconds: 72 });
  assert.deepEqual(result.previousTotals, { pageViews: 0, activeSeconds: 0 });
  assert.equal(result.measurement.startedOn, "2026-11-27");
  assert.equal(result.measurement.coverage, "partial");
  assert.deepEqual(result.pages[0], { product: "daily", category: "room", pageViews: 2, activeSeconds: 60 });
  assert.deepEqual(result.daily.at(-1), { date: "2026-11-27", pageViews: 3, activeSeconds: 72 });
  assert.deepEqual(fs.readFileSync(filename), before, "GET reads do not write aggregate storage");
  databaseAt(filename, db => {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r => r.name),
      ["analytics_daily", "analytics_expansion", "analytics_metadata", "analytics_metrics", "analytics_releases", "analytics_time_blocks"]);
    assert.deepEqual(db.prepare("PRAGMA table_info(analytics_daily)").all().map(r => r.name),
      ["day", "product", "category", "page_views", "active_seconds"]);
    assert.deepEqual(db.prepare("PRAGMA table_info(analytics_metadata)").all().map(r => r.name),
      ["id", "started_on"]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM analytics_daily").get().n, 2);
  });
});

test("UTC-8 midnight controls aggregation and preceding equal-period totals", t => {
  const value = fixture(t);
  value.setNow(Date.parse("2026-11-20T07:59:59Z"));
  value.store.record(INPUT); // November 19
  value.setNow(Date.parse("2026-11-20T08:00:00Z"));
  value.store.record(INPUT); // November 20
  value.setNow(NOW);
  value.store.record({ ...INPUT, activeSeconds: 0 });
  const report = value.store.read(7);
  assert.deepEqual(report.period, { days: 7, startDate: "2026-11-21", endDate: "2026-11-27",
    previousStartDate: "2026-11-14", previousEndDate: "2026-11-20" });
  assert.deepEqual(report.previousTotals, { pageViews: 2, activeSeconds: 60 });
  assert.deepEqual(report.totals, { pageViews: 1, activeSeconds: 0 });
  assert.equal(report.measurement.coverage, "full");
});

test("retention removes old aggregate rows only on a valid POST, never on read", t => {
  const value = fixture(t);
  value.setNow(Date.parse("2025-11-27T08:00:00Z"));
  value.store.record(INPUT);
  value.setNow(Date.parse("2025-11-28T08:00:00Z"));
  value.store.record(INPUT);
  value.setNow(NOW);
  const before = fs.readFileSync(value.filename);
  value.store.read(90);
  assert.deepEqual(fs.readFileSync(value.filename), before);
  value.store.record(INPUT);
  databaseAt(value.filename, db => {
    assert.deepEqual(db.prepare("SELECT day FROM analytics_daily ORDER BY day").all().map(r => r.day),
      ["2025-11-28", "2026-11-27"]);
  });
  assert.equal(value.store.read().measurement.startedOn, "2025-11-27");
});

test("empty, foreign, corrupt and incomplete storage are unavailable rather than fabricated zeros", t => {
  const value = fixture(t);
  fs.writeFileSync(value.filename, "");
  assert.throws(() => value.store.read());
  databaseAt(value.filename, db => db.exec("CREATE TABLE private_records(secret TEXT)"));
  const before = fs.readFileSync(value.filename);
  assert.throws(() => value.store.read());
  assert.throws(() => value.store.record(INPUT));
  assert.deepEqual(fs.readFileSync(value.filename), before);
  const other = fixture(t);
  other.store.record(INPUT);
  databaseAt(other.filename, db => db.exec("DELETE FROM analytics_metadata"));
  assert.throws(() => other.store.read());
  const corrupt = fixture(t);
  fs.writeFileSync(corrupt.filename, "not sqlite");
  assert.throws(() => corrupt.store.read());
});

test("in-memory isolated runtimes stay lazy and retain only aggregates until closed", t => {
  const { store } = fixture(t, { filename: ":memory:" });
  assert.equal(store.read().measurement.coverage, "not_started");
  store.record(INPUT);
  assert.equal(store.read().totals.pageViews, 1);
  store.close();
  assert.throws(() => store.read());
});

async function httpFixture(t, { maxRequestsPerMinute = 600, storeOverride } = {}) {
  const value = fixture(t);
  let sessionReads = 0;
  let adminActive = true;
  const user = { id: USER, status: "active" };
  const security = createTargetRequestSecurity({
    isAllowedOrigin: origin => origin === ORIGIN,
    sessionCookie: { read: cookie => cookie === "session=valid" ? "valid" : null },
    sessionService: { resolveWithCsrf() { assert.fail("Analytics must not resolve unsafe authentication."); }, bootstrap: token => {
      sessionReads += 1;
      return token === "valid" ? { valid: true, user: { id: USER }, session: { userId: USER } } : { valid: false };
    } },
  });
  const authorization = createPlatformAuthorizationService({
    userRepository: { findById: () => user },
    platformRoleRepository: { findActiveByUserId: () => adminActive ? {
      id: "role", user_id: USER, role: "platform_administrator", status: "active", ended_at_ms: null, version: 1,
    } : null },
  });
  const app = express();
  app.use(createAggregateAnalyticsRouter({ store: storeOverride || value.store, adminSecurity: security,
    platformAuthorization: authorization, isAllowedOrigin: origin => origin === ORIGIN,
    clock: () => NOW, maxRequestsPerMinute }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = "http://127.0.0.1:" + server.address().port;
  function send(input = INPUT, headers = {}, suffix = "") {
    return fetch(base + "/api/v1/analytics/aggregate" + suffix, { method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
      body: typeof input === "string" ? input : JSON.stringify(input) });
  }
  return { ...value, base, send, sessionReads: () => sessionReads, revokeAdmin() { adminActive = false; }, user };
}

test("collector accepts anonymous counts without resolving users or issuing cookies", async t => {
  const value = await httpFixture(t);
  const response = await value.send();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(value.sessionReads(), 0);
  assert.deepEqual(value.store.read().totals, { pageViews: 1, activeSeconds: 30 });
});

test("collector rejects identifiers, credentials, URL parameters, origins, malformed bodies and oversized payloads without storage", async t => {
  const value = await httpFixture(t);
  for (const headers of [{ Cookie: "session=valid" }, { Authorization: "Bearer private" }]) {
    assert.equal((await value.send(INPUT, headers)).status, 400);
  }
  assert.equal((await value.send(INPUT, {}, "?userId=private")).status, 400);
  assert.equal((await value.send(INPUT, { Origin: "https://other.example" })).status, 403);
  assert.equal((await value.send(INPUT, { Origin: "" })).status, 403);
  assert.equal((await value.send(INPUT, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await value.send({ ...INPUT, userId: "private" })).status, 400);
  assert.equal((await value.send("{")).status, 400);
  assert.equal((await value.send({ ...INPUT, data: "x".repeat(1024) })).status, 413);
  assert.equal(value.sessionReads(), 0);
  assert.equal(fs.existsSync(value.filename), false);
});

test("collector preflight allows only anonymous POST JSON and global rate limiting keeps no visitor keys", async t => {
  const value = await httpFixture(t, { maxRequestsPerMinute: 1 });
  const preflight = await fetch(value.base + "/api/v1/analytics/aggregate", { method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  const rejected = await fetch(value.base + "/api/v1/analytics/aggregate", { method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" } });
  assert.equal(rejected.status, 403);
  assert.equal((await value.send(INPUT, { "User-Agent": "first" })).status, 204);
  assert.equal((await value.send(INPUT, { "User-Agent": "second" })).status, 429);
  assert.equal(value.store.read().totals.pageViews, 1);
});

test("Admin reports enforce current authority and validated ranges, with no collector auth leakage", async t => {
  const value = await httpFixture(t);
  const url = value.base + "/api/v1/admin/analytics";
  assert.equal((await fetch(url, { headers: { Origin: ORIGIN } })).status, 401);
  const headers = { Origin: ORIGIN, Cookie: "session=valid" };
  for (const days of ["7", "28", "90"]) {
    const response = await fetch(url + "?days=" + days, { headers });
    assert.equal(response.status, 200);
    const { data, meta } = await response.json();
    assert.match(meta.requestId, /^[0-9a-f-]+$/);
    assert.equal(data.period.days, Number(days));
    assert.deepEqual(data.accounts, { total: 9, createdInPeriod: 2 });
    assert.equal(data.measurement.coverage, "not_started");
  }
  for (const query of ["days=30", "days=7&days=90", "userId=private"]) {
    assert.equal((await fetch(url + "?" + query, { headers })).status, 400);
  }
  value.revokeAdmin();
  assert.equal((await fetch(url, { headers })).status, 403);
  assert.equal(fs.existsSync(value.filename), false);
});

test("persistence failures return contained 503 responses without exposing error or request details", async t => {
  const value = await httpFixture(t, { storeOverride: {
    record() { throw new Error("private identifier"); }, read() { throw new Error("private identifier"); },
  } });
  const post = await value.send();
  assert.equal(post.status, 503);
  assert.equal((await post.text()).includes("private identifier"), false);
  const get = await fetch(value.base + "/api/v1/admin/analytics", { headers: { Origin: ORIGIN, Cookie: "session=valid" } });
  assert.equal(get.status, 503);
  const errorEnvelope = await get.json();
  assert.match(errorEnvelope.error.requestId, /^[0-9a-f-]+$/);
  assert.equal(JSON.stringify(errorEnvelope).includes("private identifier"), false);
});


test("expanded fixed metrics use their own measurement date and never accept public room events or arbitrary properties", t => {
  const value = fixture(t, { filename: ":memory:" });
  assert.equal(value.store.read().measurement.expandedStartedOn, null);
  for (const metric of require("../../src/analytics/createAggregateAnalyticsStore").BROWSER_METRICS) {
    value.store.record({ metric, value: 1 });
  }
  for (const input of [{ metric: "room.created.daily", value: 1 }, { metric: "room.created.scheduled", value: 1 },
    { metric: "feature.arbitrary", value: 1 }, { metric: "install.reported", value: 2 },
    { metric: "install.reported", value: 1, userId: "private" }]) assert.throws(() => value.store.record(input));
  const report = value.store.read();
  assert.equal(report.metrics.length, 39);
  assert.equal(report.measurement.expandedStartedOn, "2026-11-27");
  assert.equal(report.metrics.find(row => row.metric === "install.reported").count, 1);
  assert.deepEqual(report.totals, { pageViews: 0, activeSeconds: 0 });
  value.store.recordSystemMetrics([{ metric: "room.started.practice", value: 1 }, { metric: "room.seats_at_start.practice", value: 3 }]);
  assert.equal(value.store.read().metrics.find(row => row.metric === "room.seats_at_start.practice").count, 3);
});

test("version1 aggregate files remain read-only until an accepted submission adds the optional expansion", t => {
  const value = fixture(t);
  databaseAt(value.filename, db => {
    db.exec(`CREATE TABLE analytics_metadata(id INTEGER PRIMARY KEY,started_on TEXT);
      CREATE TABLE analytics_daily(day TEXT,product TEXT,category TEXT,page_views INTEGER,active_seconds INTEGER,PRIMARY KEY(day,product,category));
      PRAGMA application_id=1212239444; PRAGMA user_version=1;`);
    db.prepare("INSERT INTO analytics_metadata VALUES(1,?)").run("2026-11-01");
    db.prepare("INSERT INTO analytics_daily VALUES(?,?,?,?,?)").run("2026-11-26", "daily", "room", 8, 240);
  });
  const before = fs.readFileSync(value.filename);
  const legacy = value.store.read();
  assert.equal(legacy.measurement.startedOn, "2026-11-01");
  assert.equal(legacy.measurement.expandedStartedOn, null);
  assert.equal(legacy.totals.pageViews, 8);
  assert.deepEqual(fs.readFileSync(value.filename), before);
  value.store.record({ metric: "launch.browser", value: 1 });
  const upgraded = value.store.read();
  assert.equal(upgraded.measurement.startedOn, "2026-11-01");
  assert.equal(upgraded.measurement.expandedStartedOn, "2026-11-27");
  assert.equal(upgraded.totals.pageViews, 8);
});

test("peak buckets require14 days in the selected period and suppress small cells", t => {
  const value = fixture(t, { filename: ":memory:" });
  value.setNow(Date.parse("2026-11-10T20:00:00Z"));
  for (let index = 0; index < 20; index++) value.store.record(INPUT);
  value.setNow(NOW);
  for (let index = 0; index < 3; index++) value.store.record(INPUT);
  const report = value.store.read(28);
  assert.equal(report.peakUsage.status, "available");
  assert.equal(report.timeBlocks.length, 28);
  const sparse = report.timeBlocks.find(row => row.weekday === 5 && row.block === "00-05");
  assert.deepEqual(sparse, { weekday: 5, block: "00-05", pageViews: null, activeSeconds: null, suppressed: true });
  assert.equal(value.store.read(7).peakUsage.status, "insufficient_data");
  assert.ok(value.store.read(7).timeBlocks.every(row => row.pageViews === null && row.activeSeconds === null));
});

test("release markers retain one first-observed day per build, including different builds on the same day", t => {
  const value = fixture(t, { buildId: "build-a" });
  value.store.record(INPUT);
  const other = createAggregateAnalyticsStore({ filename: value.filename, clock: () => NOW,
    buildId: "build-b", readAccountTotals: () => ({ total: 0, createdInPeriod: 0 }) });
  t.after(() => other.close());
  other.record(INPUT);
  value.setNow(NOW + 86400000);
  value.store.record(INPUT);
  const releases = value.store.read().releases;
  assert.equal(releases.length, 2);
  assert.deepEqual(new Set(releases.map(row => row.buildId)), new Set(["build-a", "build-b"]));
  assert.ok(releases.every(row => row.date === "2026-11-27"));
});

test("operational-source failures remain unavailable while traffic remains readable", t => {
  const value = fixture(t, { readOperations() { throw new Error("internal source details"); } });
  value.store.record(INPUT);
  const report = value.store.read();
  assert.equal(report.totals.pageViews, 1);
  assert.equal(report.operations.dailyRooms.status, "unavailable");
  assert.equal(report.operations.freshness.statistics, null);
  assert.equal(JSON.stringify(report).includes("internal source details"), false);
});
