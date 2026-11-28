"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const { createAggregateAnalyticsStore, validateAggregateInput, resolveAnalyticsPeriod, CATEGORIES } = require("../../src/analytics/createAggregateAnalyticsStore");
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


test("calendar periods resolve full Monday weeks and variable preceding months across year and leap boundaries", () => {
  const october=resolveAnalyticsPeriod({month:"2026-10"},NOW).period;
  assert.deepEqual(october,{days:31,startDate:"2026-10-01",endDate:"2026-10-31",previousStartDate:"2026-09-01",previousEndDate:"2026-09-30",kind:"month",value:"2026-10",calendarEndDate:"2026-10-31",today:"2026-11-27"});
  const leap=resolveAnalyticsPeriod({month:"2024-02"},NOW).period;assert.equal(leap.days,29);assert.equal(leap.calendarEndDate,"2024-02-29");assert.equal(leap.previousStartDate,"2024-01-01");assert.equal(leap.previousEndDate,"2024-01-31");
  assert.equal(resolveAnalyticsPeriod({month:"2025-02"},NOW).period.days,28);
  const january=resolveAnalyticsPeriod({month:"2026-01"},NOW).period;assert.equal(january.previousStartDate,"2025-12-01");assert.equal(january.previousEndDate,"2025-12-31");
  const week=resolveAnalyticsPeriod({week:"2025-12-29"},NOW).period;assert.equal(week.days,7);assert.equal(week.endDate,"2026-01-04");assert.equal(week.previousStartDate,"2025-12-22");assert.equal(week.previousEndDate,"2025-12-28");
});

test("current calendar periods clip to the fixed UTC-8 day and preserve full prior calendar comparisons", () => {
  const month=resolveAnalyticsPeriod({month:"2026-11"},NOW).period;assert.equal(month.days,27);assert.equal(month.endDate,"2026-11-27");assert.equal(month.calendarEndDate,"2026-11-30");assert.equal(month.previousStartDate,"2026-10-01");assert.equal(month.previousEndDate,"2026-10-31");
  const week=resolveAnalyticsPeriod({week:"2026-11-23"},NOW).period;assert.equal(week.days,5);assert.equal(week.calendarEndDate,"2026-11-29");assert.equal(week.previousEndDate,"2026-11-22");
  assert.throws(()=>resolveAnalyticsPeriod({week:"2026-11-23"},Date.parse("2026-11-23T07:59:59Z")),{code:"ANALYTICS_INPUT_INVALID"});
  const boundary=resolveAnalyticsPeriod({week:"2026-11-23"},Date.parse("2026-11-23T08:00:00Z")).period;assert.equal(boundary.days,1);assert.equal(boundary.today,"2026-11-23");
});

test("invalid calendar selectors reject before storage is opened", t => {
  const f=fixture(t);
  for(const selection of [null,[],{},"2026-10",{week:"2026-11-24"},{week:"2026-11-30"},{week:"2026-02-30"},{week:"2026-1-05"},
    {month:"2026-13"},{month:"2026-00"},{month:"2026-12"},{month:"2026-1"},{month:"1969-12"},{week:"1969-12-29"},
    {week:"2026-11-23",month:"2026-11"},{month:"2026-10",days:28},{days:28}]) assert.throws(()=>f.store.read(selection),{code:"ANALYTICS_INPUT_INVALID"});
  assert.equal(fs.existsSync(f.filename),false);
});

test("historical periods before collection remain readable and still query historical accounts and operations", t => {
  const operations=[];const f=fixture(t,{readOperations(input){operations.push(input);return{historical:true};}});
  f.store.record(INPUT);const before=fs.readFileSync(f.filename);const result=f.store.read({month:"2026-10"});
  assert.equal(result.measurement.startedOn,"2026-11-27");assert.equal(result.measurement.expandedStartedOn,"2026-11-27");
  assert.equal(result.measurement.coverage,"not_started");assert.equal(result.measurement.expandedCoverage,"not_started");
  assert.equal(result.measurement.retainedFrom,"2025-11-28");assert.equal(result.measurement.availableFrom,"2026-11-27");assert.equal(result.measurement.expandedAvailableFrom,"2026-11-27");
  assert.deepEqual(result.totals,{pageViews:0,activeSeconds:0});assert.equal(result.daily.length,31);assert.equal(result.peakUsage.status,"not_measured");
  assert.deepEqual(f.accountReads.at(-1),{startMs:Date.parse("2026-10-01T08:00:00Z"),endMs:Date.parse("2026-11-01T08:00:00Z")});
  assert.equal(operations[0].days,31);assert.equal(operations[0].startDate,"2026-10-01");assert.equal(operations[0].endDate,"2026-10-31");
  assert.deepEqual(result.accounts,{total:9,createdInPeriod:2});assert.deepEqual(fs.readFileSync(f.filename),before);
});

test("calendar totals and metric comparisons use the full preceding month rather than an equal-day lookback", t => {
  const f=fixture(t,{filename:":memory:"});
  for(const date of ["2026-08-31","2026-09-01","2026-09-30","2026-10-01","2026-10-31"]){f.setNow(Date.parse(date+"T08:00:00Z"));f.store.record(INPUT);f.store.record({metric:"launch.browser",value:1});}
  f.setNow(NOW);const report=f.store.read({month:"2026-10"});
  assert.deepEqual(report.totals,{pageViews:2,activeSeconds:60});assert.deepEqual(report.previousTotals,{pageViews:2,activeSeconds:60});
  assert.deepEqual(report.metrics.find(row=>row.metric==="launch.browser"),{metric:"launch.browser",count:2,previousCount:2});
  assert.equal(report.measurement.coverage,"full");assert.equal(report.measurement.expandedCoverage,"full");
});

test("historical reads mask all expired aggregate rows using today's cutoff without pruning storage", t => {
  const f=fixture(t,{buildId:"expired-build"});
  for(const date of ["2025-10-15","2025-11-14","2025-11-15"]){f.setNow(Date.parse(date+"T08:00:00Z"));f.store.record(INPUT);f.store.record({metric:"launch.browser",value:1});}
  databaseAt(f.filename,db=>db.exec("UPDATE analytics_daily SET page_views=100 WHERE day='2025-11-14'; UPDATE analytics_metrics SET count=100 WHERE day='2025-11-14'; UPDATE analytics_time_blocks SET page_views=100 WHERE day='2025-11-14';"));
  const later=createAggregateAnalyticsStore({filename:f.filename,clock:()=>Date.parse("2025-11-15T08:00:00Z"),buildId:"retained-build",readAccountTotals:()=>({total:0,createdInPeriod:0})});
  later.record({metric:"install.reported",value:1});later.close();
  f.setNow(Date.parse("2026-11-14T08:00:00Z"));const before=fs.readFileSync(f.filename);const report=f.store.read({month:"2025-11"});
  assert.equal(report.measurement.retainedFrom,"2025-11-15");assert.equal(report.measurement.startedOn,"2025-10-15");assert.equal(report.measurement.availableFrom,"2025-11-15");
  assert.equal(report.measurement.coverage,"partial");assert.equal(report.measurement.expandedCoverage,"partial");assert.equal(report.measurement.expandedAvailableFrom,"2025-11-15");
  assert.deepEqual(report.totals,{pageViews:1,activeSeconds:30});assert.deepEqual(report.previousTotals,{pageViews:0,activeSeconds:0});
  assert.deepEqual(report.metrics.find(row=>row.metric==="launch.browser"),{metric:"launch.browser",count:1,previousCount:0});
  assert.deepEqual(report.releases,[{date:"2025-11-15",buildId:"retained-build"}]);
  assert.equal(report.peakUsage.status,"insufficient_data","expired views cannot meet the heatmap's20-view threshold");
  const older=f.store.read({month:"2025-10"});assert.equal(older.measurement.coverage,"not_started");assert.equal(older.measurement.expandedCoverage,"not_started");assert.equal(older.peakUsage.status,"not_measured");
  assert.equal(older.totals.pageViews,0);assert.deepEqual(fs.readFileSync(f.filename),before);
  databaseAt(f.filename,db=>assert.equal(db.prepare("SELECT COUNT(*) n FROM analytics_daily WHERE day<'2025-11-15'").get().n,2));
});

test("calendar coverage keeps initial collection days partial and expanded measurement dates independent", t => {
  const f=fixture(t);
  databaseAt(f.filename,db=>db.exec("CREATE TABLE analytics_metadata(id INTEGER PRIMARY KEY,started_on TEXT); CREATE TABLE analytics_daily(day TEXT,product TEXT,category TEXT,page_views INTEGER,active_seconds INTEGER,PRIMARY KEY(day,product,category)); PRAGMA application_id=1212239444; PRAGMA user_version=1; INSERT INTO analytics_metadata VALUES(1,'2026-09-01'); INSERT INTO analytics_daily VALUES('2026-10-01','daily','room',8,60);"));
  const before=fs.readFileSync(f.filename);const legacy=f.store.read({month:"2026-10"});assert.equal(legacy.measurement.coverage,"full");assert.equal(legacy.measurement.expandedAvailableFrom,null);assert.deepEqual(fs.readFileSync(f.filename),before);
  f.store.record({metric:"launch.browser",value:1});const historical=f.store.read({month:"2026-10"});assert.equal(historical.measurement.coverage,"full");assert.equal(historical.measurement.expandedStartedOn,"2026-11-27");assert.equal(historical.measurement.expandedCoverage,"not_started");assert.equal(historical.totals.pageViews,8);
  const initial=fixture(t,{filename:":memory:"});initial.setNow(Date.parse("2026-10-01T08:00:00Z"));initial.store.record(INPUT);initial.setNow(NOW);assert.equal(initial.store.read({month:"2026-10"}).measurement.coverage,"partial");
});

test("heatmap counts a completed historical last day but excludes today's and the initial collection day's partial coverage", t => {
  const f=fixture(t,{filename:":memory:"});f.setNow(Date.parse("2026-10-17T08:00:00Z"));for(let i=0;i<20;i++)f.store.record(INPUT);
  f.setNow(Date.parse("2026-10-31T20:00:00Z"));assert.equal(f.store.read({month:"2026-10"}).peakUsage.status,"insufficient_data");
  f.setNow(Date.parse("2026-11-01T08:00:00Z"));assert.equal(f.store.read({month:"2026-10"}).peakUsage.status,"available");
  assert.equal(f.store.read({week:"2026-10-19"}).peakUsage.status,"insufficient_data");
});

test("calendar support preserves exact legacy response keys and rejects metadata dated after today", t => {
  const f=fixture(t);f.store.record(INPUT);
  for(const selection of [undefined,7,28,90]){const result=f.store.read(selection);assert.deepEqual(Object.keys(result.period).sort(),["days","endDate","previousEndDate","previousStartDate","startDate"]);assert.deepEqual(Object.keys(result.measurement).sort(),["coverage","expandedCoverage","expandedStartedOn","retentionDays","startedOn"]);}
  databaseAt(f.filename,db=>db.exec("UPDATE analytics_metadata SET started_on='2026-11-28'"));assert.throws(()=>f.store.read({month:"2026-10"}));
  databaseAt(f.filename,db=>db.exec("UPDATE analytics_metadata SET started_on='2026-11-27'; UPDATE analytics_expansion SET started_on='2026-11-28'"));assert.throws(()=>f.store.read({month:"2026-10"}));
});

test("Admin calendar selectors require current authority and reject mixed, duplicate, future and invalid ranges",async t=>{
  const f=await httpFixture(t);const url=f.base+"/api/v1/admin/analytics";const headers={Origin:ORIGIN,Cookie:"session=valid"};
  assert.equal((await fetch(url+"?month=2026-10",{headers:{Origin:ORIGIN}})).status,401);
  for(const [query,kind,value]of [["week=2026-11-23","week","2026-11-23"],["month=2026-10","month","2026-10"]]){const response=await fetch(url+"?"+query,{headers});assert.equal(response.status,200);const envelope=await response.json();assert.equal(envelope.data.period.kind,kind);assert.equal(envelope.data.period.value,value);assert.equal(envelope.data.measurement.availableFrom,null);assert.match(envelope.meta.requestId,/^[0-9a-f-]+$/);}
  for(const query of ["month=2026-10&days=28","week=2026-11-23&month=2026-11","month=2026-10&month=2026-11","week=2026-11-24","week=2026-11-30","month=2026-12","month=2026-02-30","month=1969-12","week[x]=2026-11-23","year=2026"]){const response=await fetch(url+"?"+query,{headers});assert.equal(response.status,400,query);assert.equal((await response.json()).error.code,"ANALYTICS_INPUT_INVALID");}
  f.revokeAdmin();assert.equal((await fetch(url+"?month=invalid",{headers})).status,403);assert.equal(fs.existsSync(f.filename),false);
});


test("detailed page reports are opt-in, zero-fill the bounded catalog and never initialize missing storage", t => {
  const f = fixture(t);
  const legacy = f.store.read(28);
  const report = f.store.read(28, { detail: "pages" });
  assert.deepEqual(Object.keys(report).sort(), [...Object.keys(legacy), "pageDetail"].sort());
  assert.equal(report.pageDetail.startedOn, null);
  assert.equal(report.pageDetail.availableFrom, null);
  assert.equal(report.pageDetail.coverage, "not_started");
  assert.equal(report.pageDetail.rows.length, 55);
  assert.equal(report.pageDetail.dailyProducts.length, 28);
  assert.equal(new Set(report.pageDetail.rows.map(row => row.product + "/" + row.category)).size, 55);
  for (const day of report.pageDetail.dailyProducts) {
    assert.deepEqual(day.products, ["leago", "daily", "shared"].map(product => ({ product, pageViews: 0, activeSeconds: 0 })));
  }
  for (const options of [null, [], { detail: "all" }, { detail: "pages", userId: USER }, { detail: undefined }]) {
    assert.throws(() => f.store.read(28, options), { code: "ANALYTICS_INPUT_INVALID" });
  }
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test("refined page counts preserve legacy combined history and default clients receive only original categories", t => {
  const { LEGACY_CATEGORIES, REFINED_CATEGORY_PARENTS } = require("../../src/analytics/pageCatalog");
  const f = fixture(t);
  f.setNow(Date.parse("2026-11-25T08:00:00Z"));
  f.store.record({ product: "shared", category: "games", pageViews: 1, activeSeconds: 20 });
  f.store.record({ product: "leago", category: "players", pageViews: 1, activeSeconds: 10 });
  const beforeDetail = fs.readFileSync(f.filename);
  assert.equal(f.store.read(7, { detail: "pages" }).pageDetail.startedOn, null);
  assert.deepEqual(fs.readFileSync(f.filename), beforeDetail);
  f.setNow(NOW);
  for (const [product, parents] of Object.entries(REFINED_CATEGORY_PARENTS)) {
    for (const category of Object.keys(parents)) f.store.record({ product, category, pageViews: 1, activeSeconds: 3 });
  }
  f.store.record(INPUT);
  const beforeRead = fs.readFileSync(f.filename);
  const plain = f.store.read(7);
  const report = f.store.read(7, { detail: "pages" });
  const row = (product, category) => report.pageDetail.rows.find(item => item.product === product && item.category === category);
  assert.equal(report.pageDetail.startedOn, "2026-11-27");
  assert.equal(report.pageDetail.coverage, "partial");
  assert.equal(report.pageDetail.availableFrom, "2026-11-27");
  assert.equal(plain.pageDetail, undefined);
  assert.deepEqual(report.pages, plain.pages);
  assert.ok(plain.pages.every(item => LEGACY_CATEGORIES[item.product].includes(item.category)));
  assert.equal(plain.pages.find(item => item.category === "games").pageViews, 3);
  assert.equal(row("shared", "games").pageViews, 1);
  assert.equal(row("shared", "tip_jar").pageViews, 1);
  assert.equal(row("shared", "mr_boni").pageViews, 1);
  assert.equal(row("leago", "players").pageViews, 1);
  assert.equal(row("leago", "players_list").pageViews, 1);
  assert.equal(row("leago", "player_detail").pageViews, 1);
  assert.equal(report.pageDetail.rows.reduce((sum,item) => sum + item.pageViews, 0), report.totals.pageViews);
  assert.deepEqual(report.pageDetail.rows.map(item=>item.pageViews), report.pageDetail.rows.map(item=>item.pageViews).sort((a,b)=>b-a));
  for (const day of report.pageDetail.dailyProducts) {
    const combined = report.daily.find(item => item.date === day.date);
    assert.equal(day.products.reduce((sum,item)=>sum+item.pageViews,0), combined.pageViews);
    assert.equal(day.products.reduce((sum,item)=>sum+item.activeSeconds,0), combined.activeSeconds);
  }
  for (const product of report.products) {
    assert.equal(report.pageDetail.dailyProducts.reduce((sum,day)=>sum+day.products.find(item=>item.product===product.product).pageViews,0),product.pageViews);
  }
  databaseAt(f.filename, db => {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.deepEqual(db.prepare("PRAGMA table_info(analytics_page_detail)").all().map(item=>item.name), ["id","started_on"]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM analytics_page_detail").get().n,1);
  });
  assert.deepEqual(fs.readFileSync(f.filename), beforeRead);
});

test("detailed pages preserve historical pre-collection periods and use current retention without read-time cleanup", t => {
  const f = fixture(t);
  f.setNow(Date.parse("2025-11-10T08:00:00Z"));
  f.store.record({ product:"shared",category:"games",pageViews:1,activeSeconds:10 });
  f.setNow(Date.parse("2025-11-14T08:00:00Z"));
  f.store.record({ product:"shared",category:"tip_jar",pageViews:1,activeSeconds:20 });
  f.setNow(Date.parse("2025-11-15T08:00:00Z"));
  f.store.record({ product:"shared",category:"mr_boni",pageViews:1,activeSeconds:30 });
  f.setNow(Date.parse("2026-11-14T08:00:00Z"));
  const before = fs.readFileSync(f.filename);
  const report = f.store.read({ month:"2025-11" },{detail:"pages"});
  assert.equal(report.pageDetail.startedOn,"2025-11-14");
  assert.equal(report.pageDetail.availableFrom,"2025-11-15");
  assert.equal(report.pageDetail.coverage,"partial");
  assert.equal(report.pageDetail.rows.find(row=>row.category==="games").pageViews,0);
  assert.equal(report.pageDetail.rows.find(row=>row.category==="tip_jar").pageViews,0);
  assert.equal(report.pageDetail.rows.find(row=>row.category==="mr_boni").pageViews,1);
  assert.equal(report.pageDetail.dailyProducts.find(day=>day.date==="2025-11-14").products.find(row=>row.product==="shared").pageViews,0);
  const earlier = f.store.read({month:"2025-10"},{detail:"pages"});
  assert.equal(earlier.pageDetail.startedOn,"2025-11-14");
  assert.equal(earlier.pageDetail.coverage,"not_started");
  assert.equal(earlier.totals.pageViews,0);
  assert.deepEqual(fs.readFileSync(f.filename),before);
  databaseAt(f.filename,db=>assert.equal(db.prepare("SELECT COUNT(*) n FROM analytics_daily").get().n,3));
});

test("old schema reads do not add detailed metadata and first accepted refined event sets its independent start", t => {
  const f = fixture(t);
  databaseAt(f.filename,db=>db.exec("CREATE TABLE analytics_metadata(id INTEGER PRIMARY KEY,started_on TEXT); CREATE TABLE analytics_daily(day TEXT,product TEXT,category TEXT,page_views INTEGER,active_seconds INTEGER,PRIMARY KEY(day,product,category)); PRAGMA application_id=1212239444; PRAGMA user_version=1; INSERT INTO analytics_metadata VALUES(1,'2026-10-01'); INSERT INTO analytics_daily VALUES('2026-10-02','shared','games',4,60);"));
  const before = fs.readFileSync(f.filename);
  const old = f.store.read({month:"2026-10"},{detail:"pages"});
  assert.equal(old.pageDetail.startedOn,null);
  assert.equal(old.pageDetail.rows.find(row=>row.category==="games").pageViews,4);
  assert.deepEqual(fs.readFileSync(f.filename),before);
  f.store.record({metric:"launch.browser",value:1});
  assert.equal(f.store.read(28,{detail:"pages"}).pageDetail.startedOn,null);
  f.store.record({product:"shared",category:"tip_jar",pageViews:1,activeSeconds:0});
  assert.equal(f.store.read({month:"2026-10"},{detail:"pages"}).pageDetail.coverage,"not_started");
  assert.equal(f.store.read(28,{detail:"pages"}).pageDetail.startedOn,"2026-11-27");
  f.setNow(Date.parse("2026-12-05T08:00:00Z"));
  assert.equal(f.store.read(7,{detail:"pages"}).pageDetail.coverage,"full");
  databaseAt(f.filename,db=>db.exec("UPDATE analytics_page_detail SET started_on='2026-12-06'"));
  assert.throws(()=>f.store.read(7,{detail:"pages"}));
  assert.doesNotThrow(()=>f.store.read(7),"optional detail failure does not alter legacy reports");
});

test("detailed HTTP reports enforce authority, strict option parsing and anonymous collection of fixed new categories", async t => {
  const f=await httpFixture(t);const url=f.base+"/api/v1/admin/analytics";const headers={Origin:ORIGIN,Cookie:"session=valid"};
  assert.equal((await fetch(url+"?detail=pages",{headers:{Origin:ORIGIN}})).status,401);
  for(const query of ["detail=pages","days=7&detail=pages","month=2026-10&detail=pages","week=2026-11-23&detail=pages"]){
    const response=await fetch(url+"?"+query,{headers});assert.equal(response.status,200,query);
    const envelope=await response.json();assert.equal(envelope.data.pageDetail.rows.length,55);assert.match(envelope.meta.requestId,/^[0-9a-f-]+$/);
    assert.equal(response.headers.get("cache-control"),"no-store");
  }
  assert.equal(fs.existsSync(f.filename),false);
  for(const query of ["detail=", "detail=all", "detail=pages&detail=pages", "detail[x]=pages", "detail=pages&month=2026-10&days=28", "detail=pages&userId=private"]){assert.equal((await fetch(url+"?"+query,{headers})).status,400,query);}
  for(const category of ["tip_jar","mr_boni"]){assert.equal((await f.send({product:"shared",category,pageViews:1,activeSeconds:0})).status,204);}
  assert.equal((await f.send({product:"shared",category:"/games/private",pageViews:1,activeSeconds:0})).status,400);
  const plain=await (await fetch(url,{headers})).json();assert.equal(plain.data.pageDetail,undefined);assert.equal(plain.data.pages[0].category,"games");assert.equal(plain.data.pages[0].pageViews,2);
  const before=fs.readFileSync(f.filename);f.revokeAdmin();assert.equal((await fetch(url+"?detail=invalid",{headers})).status,403);assert.deepEqual(fs.readFileSync(f.filename),before);
});
