"use strict";

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const DAY_MS = 86400000;
const OFFSET_MS = 8 * 60 * 60 * 1000;
const ANALYTICS_DATABASE_ID = 1212239444;
const RETENTION_DAYS = 365;
const { CATEGORIES, isRefinedCategory, legacyCategory } = require("./pageCatalog");
const PRODUCTS = Object.freeze(Object.keys(CATEGORIES));
const BROWSER_METRICS = Object.freeze([
  "install.reported", "launch.installed", "launch.browser", "layout.small", "layout.large",
  "feature.players_filter", "feature.favourites", "feature.roster_schedule", "feature.daily_chat_open", "feature.daily_chat_send",
  ...["lcp", "inp", "cls"].flatMap(name => ["good", "needs_improvement", "poor"].map(rating => `vital.${name}.${rating}`)),
  ...["join", "bid", "trade", "page_load"].flatMap(name => ["success", "failure"].map(outcome => `action.${name}.${outcome}`)),
]);
const ROOM_METRICS = Object.freeze(["created", "started", "completed", "cancelled", "seats_at_start", "capacity_at_start"]
  .flatMap(name => ["practice", "scheduled"].map(mode => `room.${name}.${mode}`)));
const ALL_METRICS = Object.freeze([...BROWSER_METRICS, ...ROOM_METRICS]);
const TIME_BLOCKS = Object.freeze(["00-05", "06-11", "12-17", "18-23"]);
function unavailableOperations() {
  return {
    dailyRooms: { status: "unavailable", cohort: "play_date", modes: [], historicalStartFillAvailable: false },
    gameplay: { status: "unavailable", totals: null, weekly: [] },
    freshness: { status: "unavailable", statistics: null, injuries: null, jobs: null, dailyScoringPending: null, matchupsAwaitingData: null },
    calendar: { status: "unavailable", nhlCoverage: "recorded_only", days: [] },
  };
}

function invalid() {
  const error = new Error("The aggregate analytics input is invalid.");
  error.code = "ANALYTICS_INPUT_INVALID";
  return error;
}

function validateAggregateInput(input) {
  if (input && typeof input === "object" && !Array.isArray(input) &&
      Object.keys(input).sort().join(",") === "metric,value") {
    if (!BROWSER_METRICS.includes(input.metric) || input.value !== 1) throw invalid();
    return { metric: input.metric, value: 1 };
  }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "activeSeconds,category,pageViews,product" ||
      !PRODUCTS.includes(input.product) || !CATEGORIES[input.product].includes(input.category) ||
      !Number.isInteger(input.pageViews) || input.pageViews < 0 || input.pageViews > 1 ||
      !Number.isInteger(input.activeSeconds) || input.activeSeconds < 0 || input.activeSeconds > 60 ||
      input.pageViews + input.activeSeconds === 0) throw invalid();
  return { product: input.product, category: input.category, pageViews: input.pageViews, activeSeconds: input.activeSeconds };
}

function dateAt(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new TypeError("Analytics requires a valid clock.");
  return new Date(ms - OFFSET_MS).toISOString().slice(0, 10);
}
function dateShift(date, days) {
  return new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}
function dayStartMs(date) { return Date.parse(date + "T00:00:00Z") + OFFSET_MS; }
function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(Date.parse(value + "T00:00:00Z")).toISOString().slice(0, 10) === value;
}
function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Analytics aggregate is unavailable.");
  return value;
}

function laterDate(first, second) { return first > second ? first : second; }
function availableFrom(startedOn, retainedFrom) { return startedOn ? laterDate(startedOn, retainedFrom) : null; }
function coverageFor(startedOn, retainedFrom, startDate, endDate) {
  const available = availableFrom(startedOn, retainedFrom);
  if (!available || available > endDate) return "not_started";
  return startDate < available || startedOn === startDate ? "partial" : "full";
}
function resolveAnalyticsPeriod(selection = 28, nowMs = Date.now()) {
  const today = dateAt(nowMs);
  const retainedFrom = dateShift(today, 1 - RETENTION_DAYS);
  if (typeof selection === "number") {
    if (![7, 28, 90].includes(selection)) throw invalid();
    const startDate = dateShift(today, 1 - selection);
    return { today, retainedFrom, period: { days: selection, startDate, endDate: today,
      previousStartDate: dateShift(startDate, -selection), previousEndDate: dateShift(startDate, -1) } };
  }
  if (!selection || typeof selection !== "object" || Array.isArray(selection) || Object.keys(selection).length !== 1) throw invalid();
  const kind = Object.keys(selection)[0];
  const value = selection[kind];
  let startDate, calendarEndDate, previousStartDate, previousEndDate;
  if (kind === "week" && validDate(value) && new Date(value + "T00:00:00Z").getUTCDay() === 1) {
    startDate = value;
    calendarEndDate = dateShift(startDate, 6);
    previousStartDate = dateShift(startDate, -7);
    previousEndDate = dateShift(startDate, -1);
  } else if (kind === "month" && typeof value === "string" && /^\d{4}-\d{2}$/.test(value) && validDate(value + "-01")) {
    startDate = value + "-01";
    calendarEndDate = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5)), 0)).toISOString().slice(0, 10);
    previousEndDate = dateShift(startDate, -1);
    previousStartDate = previousEndDate.slice(0, 7) + "-01";
  } else throw invalid();
  if (Number(startDate.slice(0, 4)) < 1970 || startDate > today) throw invalid();
  const endDate = calendarEndDate < today ? calendarEndDate : today;
  const days = Math.floor((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS) + 1;
  return { today, retainedFrom, period: { days, startDate, endDate, previousStartDate, previousEndDate,
    kind, value, calendarEndDate, today } };
}

function createAggregateAnalyticsStore({ filename, clock = Date.now, readAccountTotals, readOperations = unavailableOperations, buildId = null } = {}) {
  if (typeof filename !== "string" || !filename || typeof clock !== "function" ||
      typeof readAccountTotals !== "function") throw new TypeError("Aggregate analytics requires isolated storage, clock and account-count reader.");
  const releaseBuild = typeof buildId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(buildId) ? buildId : null;
  let memory = null;
  let closed = false;

  function verify(db, allowInitialize, startedOn) {
    const appId = db.prepare("PRAGMA application_id").get().application_id;
    if (!appId && allowInitialize) {
      if (db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) throw new Error("Analytics requires a dedicated database.");
      db.exec(`
        CREATE TABLE analytics_metadata (
          id INTEGER PRIMARY KEY CHECK (id=1), started_on TEXT NOT NULL
        );
        CREATE TABLE analytics_daily (
          day TEXT NOT NULL, product TEXT NOT NULL, category TEXT NOT NULL,
          page_views INTEGER NOT NULL CHECK (page_views>=0),
          active_seconds INTEGER NOT NULL CHECK (active_seconds>=0),
          PRIMARY KEY(day,product,category)
        );
        PRAGMA application_id = ${ANALYTICS_DATABASE_ID};
        PRAGMA user_version = 1;
      `);
      db.prepare("INSERT INTO analytics_metadata(id,started_on) VALUES(1,?)").run(startedOn);
    } else if (appId !== ANALYTICS_DATABASE_ID ||
      ![1, 2].includes(db.prepare("PRAGMA user_version").get().user_version)) {
      throw new Error("The analytics database format is unavailable.");
    }
    const meta = db.prepare("SELECT started_on FROM analytics_metadata WHERE id=1").get();
    if (!validDate(meta?.started_on)) throw new Error("The analytics measurement date is unavailable.");
    return meta.started_on;
  }

  function ensureExpansion(db, today) {
    if (db.prepare("PRAGMA user_version").get().user_version === 2) return;
    db.exec(`
      CREATE TABLE analytics_expansion (id INTEGER PRIMARY KEY CHECK(id=1), started_on TEXT NOT NULL);
      CREATE TABLE analytics_metrics (day TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL CHECK(count>=0), PRIMARY KEY(day,metric));
      CREATE TABLE analytics_time_blocks (day TEXT NOT NULL, block TEXT NOT NULL,
        page_views INTEGER NOT NULL CHECK(page_views>=0), active_seconds INTEGER NOT NULL CHECK(active_seconds>=0), PRIMARY KEY(day,block));
      CREATE TABLE analytics_releases (day TEXT NOT NULL, build_id TEXT PRIMARY KEY);
      PRAGMA user_version=2;
    `);
    db.prepare("INSERT INTO analytics_expansion VALUES(1,?)").run(today);
  }

  function ensurePageDetail(db, today) {
    // Additive, lazy sidecar metadata only. Never initialize or migrate during a GET.
    db.exec("CREATE TABLE IF NOT EXISTS analytics_page_detail (id INTEGER PRIMARY KEY CHECK(id=1), started_on TEXT NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO analytics_page_detail VALUES(1,?)").run(today);
  }

  function readPageDetailStart(db, today) {
    if (!db || !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='analytics_page_detail'").get()) return null;
    const startedOn = db.prepare("SELECT started_on FROM analytics_page_detail WHERE id=1").get()?.started_on;
    if (!validDate(startedOn) || startedOn > today) throw new Error("Detailed page measurement date is unavailable.");
    return startedOn;
  }

  function readExpansion(db, startDate, endDate, previousStartDate, today, retainedFrom) {
    const expanded = db && db.prepare("PRAGMA user_version").get().user_version === 2;
    const startedOn = expanded ? db.prepare("SELECT started_on FROM analytics_expansion WHERE id=1").get()?.started_on : null;
    if (expanded && (!validDate(startedOn) || startedOn > today)) throw new Error("Analytics expansion date is unavailable.");
    const metrics = ALL_METRICS.map(metric => ({ metric, count: 0, previousCount: 0 }));
    const metricRows = expanded ? db.prepare("SELECT day,metric,count FROM analytics_metrics WHERE day>=? AND day<=?").all(laterDate(previousStartDate, retainedFrom), endDate) : [];
    for (const row of metricRows) {
      const target = metrics.find(item => item.metric === row.metric);
      if (!target || !validDate(row.day) || row.day < startedOn) throw new Error("Analytics metric is unavailable.");
      const key = row.day >= startDate ? "count" : "previousCount";
      target[key] = safeCount(target[key] + safeCount(row.count));
    }
    const timeBlocks = Array.from({ length: 7 }, (_, weekday) => TIME_BLOCKS.map(block => ({
      weekday, block, pageViews: 0, activeSeconds: 0, suppressed: false,
    }))).flat();
    const blockRows = expanded ? db.prepare("SELECT day,block,page_views,active_seconds FROM analytics_time_blocks WHERE day>=? AND day<=?")
      .all(laterDate(startDate, retainedFrom), endDate) : [];
    let measuredViews = 0;
    for (const row of blockRows) {
      if (!validDate(row.day) || row.day < startedOn || !TIME_BLOCKS.includes(row.block)) throw new Error("Analytics time block is unavailable.");
      const weekday = new Date(row.day + "T00:00:00Z").getUTCDay();
      const target = timeBlocks.find(item => item.weekday === weekday && item.block === row.block);
      target.pageViews = safeCount(target.pageViews + safeCount(row.page_views));
      target.activeSeconds = safeCount(target.activeSeconds + safeCount(row.active_seconds));
      measuredViews = safeCount(measuredViews + row.page_views);
    }
    const firstTrafficDay = expanded ? db.prepare("SELECT MIN(day) day FROM analytics_time_blocks WHERE day>=?").get(retainedFrom)?.day : null;
    const measurementStart = firstTrafficDay ? [startDate, retainedFrom, dateShift(startedOn, 1), dateShift(firstTrafficDay, 1)].sort().at(-1) : null;
    const completedEnd = endDate < today ? endDate : dateShift(today, -1);
    const measuredDays = measurementStart ? Math.max(0, Math.floor((Date.parse(completedEnd) - Date.parse(measurementStart)) / DAY_MS) + 1) : 0;
    const expandedCoverage = coverageFor(startedOn, retainedFrom, startDate, endDate);
    const peakStatus = expandedCoverage === "not_started" ? "not_measured" : measuredDays < 14 || measuredViews < 20 ? "insufficient_data" : "available";
    for (const cell of timeBlocks) {
      const sparse = cell.pageViews < 5 && (cell.pageViews > 0 || cell.activeSeconds > 0);
      cell.suppressed = peakStatus === "available" && sparse;
      if (peakStatus !== "available" || sparse) { cell.pageViews = null; cell.activeSeconds = null; }
    }
    const releases = expanded ? db.prepare("SELECT day,build_id FROM analytics_releases WHERE day>=? AND day<=? ORDER BY day DESC,build_id LIMIT 365")
      .all(laterDate(startDate, retainedFrom), endDate).map(row => {
        if (!validDate(row.day) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.build_id)) throw new Error("Analytics build marker is unavailable.");
        return { date: row.day, buildId: row.build_id };
      }).reverse() : [];
    return { expandedStartedOn: startedOn, expandedCoverage, expandedAvailableFrom: availableFrom(startedOn, retainedFrom),
      metrics, timeBlocks, releases,
      peakUsage: { status: peakStatus, minimumMeasuredDays: 14, minimumPageViews: 20, suppressionThreshold: 5 } };
  }

  function withDatabase(write, operation) {
    if (closed) throw new Error("Analytics storage is closed.");
    let db;
    if (filename === ":memory:") {
      if (!memory && !write) return operation(null);
      if (!memory) memory = new DatabaseSync(":memory:");
      db = memory;
    } else {
      if (!write) {
        try { fs.statSync(filename); }
        catch (error) { if (error.code === "ENOENT") return operation(null); throw error; }
      }
      db = new DatabaseSync(filename, { readOnly: !write });
    }
    try {
      if (write) {
        db.exec("PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;");
      }
      return operation(db);
    } finally {
      if (filename !== ":memory:") db.close();
    }
  }

  function record(input) { return write([validateAggregateInput(input)]); }

  function recordSystemMetrics(events) {
    if (!Array.isArray(events) || events.length < 1 || events.length > 12) throw invalid();
    const values = events.map(event => {
      if (!event || Object.keys(event).sort().join(",") !== "metric,value" || !ROOM_METRICS.includes(event.metric) ||
          !Number.isSafeInteger(event.value) || event.value < 0 || event.value > 1000000) throw invalid();
      return { metric: event.metric, value: event.value };
    });
    return write(values);
  }

  function write(values) {
    const now = clock();
    const today = dateAt(now);
    const block = TIME_BLOCKS[Math.floor(new Date(now - OFFSET_MS).getUTCHours() / 6)];
    return withDatabase(true, db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        verify(db, true, today);
        ensureExpansion(db, today);
        if (values.some(value => isRefinedCategory(value.product, value.category))) ensurePageDetail(db, today);
        for (const value of values) {
          if (value.metric) {
            db.prepare("INSERT INTO analytics_metrics VALUES(?,?,?) ON CONFLICT(day,metric) DO UPDATE SET count=count+excluded.count")
              .run(today, value.metric, value.value);
            continue;
          }
          db.prepare(`INSERT INTO analytics_daily(day,product,category,page_views,active_seconds)
          VALUES(?,?,?,?,?) ON CONFLICT(day,product,category) DO UPDATE SET
          page_views=page_views+excluded.page_views, active_seconds=active_seconds+excluded.active_seconds`)
          .run(today, value.product, value.category, value.pageViews, value.activeSeconds);
          db.prepare(`INSERT INTO analytics_time_blocks VALUES(?,?,?,?) ON CONFLICT(day,block) DO UPDATE SET
            page_views=page_views+excluded.page_views,active_seconds=active_seconds+excluded.active_seconds`)
            .run(today, block, value.pageViews, value.activeSeconds);
        }
        if (releaseBuild) db.prepare("INSERT OR IGNORE INTO analytics_releases VALUES(?,?)")
          .run(today, releaseBuild);
        for (const table of ["analytics_daily", "analytics_metrics", "analytics_time_blocks", "analytics_releases"]) {
          db.prepare("DELETE FROM " + table + " WHERE day<?").run(dateShift(today, 1 - RETENTION_DAYS));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  function read(selection = 28, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) ||
        Object.keys(options).some(key => key !== "detail") ||
        (Object.hasOwn(options, "detail") && options.detail !== "pages")) throw invalid();
    const detailed = options.detail === "pages";
    const { period, today, retainedFrom } = resolveAnalyticsPeriod(selection, clock());
    const { days, startDate, endDate, previousStartDate } = period;
    const report = withDatabase(false, db => {
      const startedOn = db ? verify(db, false) : null;
      if (startedOn && startedOn > today) throw new Error("The analytics measurement date is unavailable.");
      const rows = db ? db.prepare(`SELECT day,product,category,page_views,active_seconds FROM analytics_daily
        WHERE day>=? AND day<=? ORDER BY day,product,category`).all(laterDate(previousStartDate, retainedFrom), endDate) : [];
      const totals = { pageViews: 0, activeSeconds: 0 };
      const previousTotals = { pageViews: 0, activeSeconds: 0 };
      const products = PRODUCTS.map(product => ({ product, pageViews: 0, activeSeconds: 0 }));
      const daily = Array.from({ length: days }, (_, index) => ({
        date: dateShift(startDate, index), pageViews: 0, activeSeconds: 0,
      }));
      const pages = new Map();
      const detailedPages = detailed ? new Map(Object.entries(CATEGORIES).flatMap(([product, categories]) =>
        categories.map(category => [product + "/" + category, { product, category, pageViews: 0, activeSeconds: 0 }]))) : null;
      const dailyProducts = detailed ? daily.map(day => ({ date: day.date,
        products: PRODUCTS.map(product => ({ product, pageViews: 0, activeSeconds: 0 })) })) : null;
      const detailStartedOn = detailed ? readPageDetailStart(db, today) : null;
      if (detailStartedOn && detailStartedOn < startedOn) throw new Error("Detailed page measurement date is unavailable.");
      function add(target, row) {
        target.pageViews = safeCount(target.pageViews + safeCount(row.page_views));
        target.activeSeconds = safeCount(target.activeSeconds + safeCount(row.active_seconds));
      }
      for (const row of rows) {
        if (!validDate(row.day) || !PRODUCTS.includes(row.product) ||
            !CATEGORIES[row.product].includes(row.category) || row.day < startedOn) {
          throw new Error("The analytics aggregate format is unavailable.");
        }
        if (row.day < startDate) { add(previousTotals, row); continue; }
        add(totals, row);
        add(products.find(product => product.product === row.product), row);
        add(daily.find(day => day.date === row.day), row);
        const category = legacyCategory(row.product, row.category);
        const key = row.product + "/" + category;
        if (!pages.has(key)) pages.set(key, { product: row.product, category, pageViews: 0, activeSeconds: 0 });
        add(pages.get(key), row);
        if (detailed) {
          if (isRefinedCategory(row.product, row.category) && (!detailStartedOn || row.day < detailStartedOn)) {
            throw new Error("Detailed page measurement date is unavailable.");
          }
          add(detailedPages.get(row.product + "/" + row.category), row);
          add(dailyProducts.find(day => day.date === row.day).products.find(product => product.product === row.product), row);
        }
      }
      const expansion = readExpansion(db, startDate, endDate, previousStartDate, today, retainedFrom);
      return {
        code: "ADMIN_ANALYTICS_FOUND", timeZone: "Etc/GMT+8",
        period,
        measurement: {
          startedOn, coverage: coverageFor(startedOn, retainedFrom, startDate, endDate),
          retentionDays: RETENTION_DAYS, expandedStartedOn: expansion.expandedStartedOn, expandedCoverage: expansion.expandedCoverage,
          ...(period.kind ? { retainedFrom, availableFrom: availableFrom(startedOn, retainedFrom), expandedAvailableFrom: expansion.expandedAvailableFrom } : {}),
        },
        totals, previousTotals, products, metrics: expansion.metrics, timeBlocks: expansion.timeBlocks, peakUsage: expansion.peakUsage, releases: expansion.releases,
        pages: [...pages.values()].sort((a, b) => b.pageViews - a.pageViews || b.activeSeconds - a.activeSeconds ||
          a.product.localeCompare(b.product) || a.category.localeCompare(b.category)),
        daily,
        ...(detailed ? { pageDetail: { startedOn: detailStartedOn, availableFrom: availableFrom(detailStartedOn, retainedFrom),
          coverage: coverageFor(detailStartedOn, retainedFrom, startDate, endDate),
          rows: [...detailedPages.values()].sort((a, b) => b.pageViews - a.pageViews || b.activeSeconds - a.activeSeconds ||
            a.product.localeCompare(b.product) || a.category.localeCompare(b.category)),
          dailyProducts } } : {}),
      };
    });
    const counts = readAccountTotals({ startMs: dayStartMs(startDate), endMs: dayStartMs(dateShift(endDate, 1)) });
    let operations;
    try { operations = readOperations({ startMs: dayStartMs(startDate), endMs: dayStartMs(dateShift(endDate, 1)), days, startDate, endDate }); }
    catch { operations = unavailableOperations(); }
    return { ...report, operations, accounts: {
      total: safeCount(counts?.total), createdInPeriod: safeCount(counts?.createdInPeriod),
    } };
  }

  return Object.freeze({
    record, recordSystemMetrics, read,
    close() { closed = true; if (memory) { memory.close(); memory = null; } },
  });
}

module.exports = { createAggregateAnalyticsStore, validateAggregateInput, resolveAnalyticsPeriod, CATEGORIES, PRODUCTS, BROWSER_METRICS, ROOM_METRICS, ALL_METRICS, ANALYTICS_DATABASE_ID };
