const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createApplication,
} = require("../../src/bootstrap/createApplication");
const {
  createHttpServer,
} = require("../../src/bootstrap/createHttpServer");
const {
  createShutdown,
} = require("../../src/bootstrap/shutdown");
const { loadConfig } = require("../../src/config/loadConfig");
const {
  createStatisticsService,
} = require("../../src/application/services/statistics/createStatisticsService");
const {
  createNhlStatisticsAdapter,
} = require("../../src/infrastructure/nhl/NhlStatisticsAdapter");
const {
  createJsonStatisticsRepository,
} = require("../../src/infrastructure/persistence/json/JsonStatisticsRepository");
const {
  createStatisticsCompatibilityRouter,
} = require("../../src/transport/http/routes/statisticsCompatibilityRouter");
const { hashFile } = require("../helpers/hashTree");
const { httpRequest } = require("../helpers/httpRequest");
const {
  createRefreshStatsRuntime,
} = require("../../scripts/refreshStats");

async function createStatisticsRuntime(t, initialCache) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hundo-leago-br03-stats-")
  );
  const statsFile = path.join(root, "stats-cache.json");
  const lockFile = path.join(root, "stats-refresh.lock");
  const leagueFile = path.join(root, "league-state.json");

  t.after(async () => {
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
    });
  });

  if (initialCache !== undefined) {
    await fs.promises.writeFile(
      statsFile,
      typeof initialCache === "string"
        ? initialCache
        : JSON.stringify(initialCache),
      "utf8"
    );
  }
  await fs.promises.writeFile(
    leagueFile,
    '{"schemaVersion":1,"teams":[]}\n',
    "utf8"
  );

  const repository = createJsonStatisticsRepository({
    statsFile,
    lockFile,
    dataDir: root,
    pid: 12345,
  });

  return {
    leagueFile,
    lockFile,
    repository,
    root,
    statsFile,
  };
}

function createRows(count, startId = 1) {
  return Array.from({ length: count }, (_, index) => ({
    playerId: startId + index,
    goals: index % 10,
    assists: index % 20,
    points: index % 30,
    gamesPlayed: 10 + (index % 5),
  }));
}

async function startStatisticsServer(
  t,
  {
    repository,
    service,
    token = "statistics-test-token",
    backendRoot,
  }
) {
  const config = loadConfig({
    env: { NODE_ENV: "test" },
    existsSync: () => false,
  });
  const app = createApplication(config);
  app.use(
    createStatisticsCompatibilityRouter({
      statisticsService: service,
      statisticsRepository: repository,
      statsRefreshToken: token,
      backendRoot,
      logger: {
        error() {},
      },
    })
  );
  const runtime = createHttpServer({
    app,
    isAllowedOrigin: config.isAllowedOrigin,
  });
  const shutdown = createShutdown({
    server: runtime.server,
    io: runtime.io,
  });

  t.after(async () => {
    await shutdown.shutdown();
  });

  const address = await runtime.listen({
    port: 0,
    host: "127.0.0.1",
  });
  return `http://127.0.0.1:${address.port}`;
}

describe("JSON statistics repository", () => {
  test("preserves absent, full, one-player, and invalid-cache behavior", async (t) => {
    const missing = await createStatisticsRuntime(t, undefined);
    assert.equal(missing.repository.cacheExists(), false);
    assert.equal(missing.repository.tryReadCache(), null);
    assert.equal(fs.existsSync(missing.statsFile), false);

    const full = await createStatisticsRuntime(t, {
      ok: true,
      byPlayerId: {
        "1001": { goals: 3, assists: 4 },
      },
    });
    const before = await hashFile(full.statsFile);
    assert.deepEqual(full.repository.readCache(), {
      ok: true,
      byPlayerId: {
        "1001": { goals: 3, assists: 4 },
      },
    });
    assert.deepEqual(await full.repository.readCacheAsync(), {
      ok: true,
      byPlayerId: {
        "1001": { goals: 3, assists: 4 },
      },
    });
    assert.equal(await hashFile(full.statsFile), before);

    const invalid = await createStatisticsRuntime(t, "{ invalid");
    assert.throws(() => invalid.repository.readCache());
    assert.equal(invalid.repository.tryReadCache(), null);
  });

  test("preserves fresh, stale, and malformed refresh-lock behavior", async (t) => {
    const runtime = await createStatisticsRuntime(t, {});
    const nowMs = 2_000_000;
    const maxAgeMs = 900_000;

    await fs.promises.writeFile(
      runtime.lockFile,
      JSON.stringify({ ts: nowMs - 1, pid: 1 }),
      "utf8"
    );
    assert.equal(
      runtime.repository.acquireLock({ nowMs, maxAgeMs }),
      false
    );

    await fs.promises.writeFile(
      runtime.lockFile,
      JSON.stringify({ ts: nowMs - maxAgeMs, pid: 1 }),
      "utf8"
    );
    assert.equal(
      runtime.repository.acquireLock({ nowMs, maxAgeMs }),
      true
    );
    assert.deepEqual(
      JSON.parse(await fs.promises.readFile(runtime.lockFile, "utf8")),
      { ts: nowMs, pid: 12345 }
    );

    await fs.promises.writeFile(
      runtime.lockFile,
      "{ malformed",
      "utf8"
    );
    assert.equal(
      runtime.repository.acquireLock({ nowMs, maxAgeMs }),
      true
    );
    runtime.repository.releaseLock();
    assert.equal(fs.existsSync(runtime.lockFile), false);
  });
});

describe("NHL statistics adapter", () => {
  test("preserves URL inputs and sequential pagination", async () => {
    const calls = [];
    const adapter = createNhlStatisticsAdapter({
      seasonId: "20262027",
      gameTypeId: 2,
      pageSize: 100,
      async fetchImpl(url, options) {
        calls.push({ url, options });
        const start = Number(new URL(url).searchParams.get("start"));
        return {
          ok: true,
          async json() {
            return start === 0
              ? { total: 150, data: createRows(100) }
              : { total: 150, data: createRows(50, 101) };
          },
        };
      },
    });

    const rows = await adapter.fetchRows();

    assert.equal(rows.length, 150);
    assert.equal(calls.length, 2);
    assert.equal(
      new URL(calls[0].url).searchParams.get("start"),
      "0"
    );
    assert.equal(
      new URL(calls[1].url).searchParams.get("start"),
      "100"
    );
    assert.match(
      decodeURIComponent(
        new URL(calls[0].url).searchParams.get("cayenneExp")
      ),
      /gameTypeId=2.*seasonId>=20262027/
    );
    assert.equal(
      calls[0].options.headers["User-Agent"],
      "hundo-leago/1.0"
    );
  });

  test("reports provider HTTP and page-shape failures", async () => {
    const httpFailure = createNhlStatisticsAdapter({
      seasonId: "20262027",
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        statusText: "Unavailable",
      }),
    });
    await assert.rejects(
      httpFailure.fetchRows(),
      /503 Unavailable/
    );

    let call = 0;
    const shapeFailure = createNhlStatisticsAdapter({
      seasonId: "20262027",
      pageSize: 1,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          call += 1;
          return call === 1
            ? { total: 2, data: createRows(1) }
            : { total: 2, data: null };
        },
      }),
    });
    await assert.rejects(
      shapeFailure.fetchRows(),
      /Unexpected NHL page shape/
    );
  });
});

describe("statistics refresh service", () => {
  test("writes an authorized synthetic refresh atomically without changing league state", async (t) => {
    const runtime = await createStatisticsRuntime(t, {
      ok: true,
      byPlayerId: { old: { goals: 1 } },
    });
    const leagueBefore = await hashFile(runtime.leagueFile);
    let nowCall = 0;
    const service = createStatisticsService({
      repository: runtime.repository,
      provider: {
        async fetchRows() {
          return createRows(200, 5000);
        },
      },
      nowMs() {
        nowCall += 1;
        return nowCall === 1 ? 1_700_000_000_000 : 1_700_000_001_000;
      },
      seasonId: "20262027",
      gameTypeId: 2,
      logger: { log() {} },
    });

    const result = await service.refresh();
    const cache = runtime.repository.readCache();

    assert.equal(result, undefined);
    assert.equal(cache.ok, true);
    assert.equal(cache.seasonId, "20262027");
    assert.equal(cache.gameTypeId, 2);
    assert.equal(cache.lastUpdatedAt, 1_700_000_001_000);
    assert.equal(Object.keys(cache.byPlayerId).length, 200);
    assert.deepEqual(cache.byPlayerId["5000"], {
      goals: 0,
      assists: 0,
      points: 0,
      gamesPlayed: 10,
    });
    assert.equal(fs.existsSync(runtime.lockFile), false);
    assert.equal(fs.existsSync(`${runtime.statsFile}.tmp`), false);
    assert.equal(await hashFile(runtime.leagueFile), leagueBefore);
  });

  test("provider and minimum-count failures preserve the last valid cache", async (t) => {
    const original = {
      ok: true,
      byPlayerId: { "1001": { goals: 9 } },
    };
    const runtime = await createStatisticsRuntime(t, original);
    const cacheBefore = await hashFile(runtime.statsFile);

    const providerFailure = createStatisticsService({
      repository: runtime.repository,
      provider: {
        async fetchRows() {
          throw new Error("synthetic provider failure");
        },
      },
      nowMs: () => 2_000_000,
      seasonId: "20262027",
      logger: { log() {} },
    });
    await assert.rejects(
      providerFailure.refresh(),
      /synthetic provider failure/
    );
    assert.equal(await hashFile(runtime.statsFile), cacheBefore);
    assert.equal(fs.existsSync(runtime.lockFile), false);

    const tooSmall = createStatisticsService({
      repository: runtime.repository,
      provider: {
        async fetchRows() {
          return createRows(199);
        },
      },
      nowMs: () => 3_000_000,
      seasonId: "20262027",
      logger: { log() {} },
    });
    await assert.rejects(
      tooSmall.refresh(),
      /only 199 players/
    );
    assert.equal(await hashFile(runtime.statsFile), cacheBefore);
    assert.equal(fs.existsSync(runtime.lockFile), false);
  });

  test("fresh lock skips provider and preserves cache", async (t) => {
    const runtime = await createStatisticsRuntime(t, {
      ok: true,
      byPlayerId: {},
    });
    const before = await hashFile(runtime.statsFile);
    await fs.promises.writeFile(
      runtime.lockFile,
      JSON.stringify({ ts: 5_000_000, pid: 1 }),
      "utf8"
    );
    let providerCalled = false;
    const service = createStatisticsService({
      repository: runtime.repository,
      provider: {
        async fetchRows() {
          providerCalled = true;
          return createRows(200);
        },
      },
      nowMs: () => 5_000_001,
      seasonId: "20262027",
      logger: { log() {} },
    });

    assert.equal(await service.refresh(), undefined);
    assert.equal(providerCalled, false);
    assert.equal(await hashFile(runtime.statsFile), before);
    assert.equal(fs.existsSync(runtime.lockFile), true);
  });

  test("the CLI adapter composes the same service against explicit temporary paths", async (t) => {
    const runtime = await createStatisticsRuntime(t, {
      ok: true,
      byPlayerId: {},
    });
    let fetchCalls = 0;
    let clock = 30_000_000;
    const cli = createRefreshStatsRuntime({
      env: {
        DATA_DIR: runtime.root,
        STATS_FILE: runtime.statsFile,
        STATS_LOCK_FILE: runtime.lockFile,
        STATS_SEASON_ID: "20262027",
      },
      async fetchImpl(url) {
        fetchCalls += 1;
        const start = Number(
          new URL(url).searchParams.get("start")
        );
        return {
          ok: true,
          async json() {
            return {
              total: 200,
              data: createRows(100, 9000 + start),
            };
          },
        };
      },
      nowDate: () => new Date("2026-07-18T00:00:00.000Z"),
      nowMs: () => {
        clock += 1;
        return clock;
      },
      logger: { log() {} },
    });

    assert.equal(await cli.refreshStatsNow(), undefined);
    assert.equal(fetchCalls, 2);
    assert.equal(
      Object.keys(cli.repository.readCache().byPlayerId).length,
      200
    );
    assert.equal(typeof cli.service.refresh, "function");
    assert.equal(fs.existsSync(runtime.lockFile), false);
  });
});

describe("statistics compatibility HTTP routes", () => {
  test("preserves missing, full, one-player, debug, and read-only responses", async (t) => {
    const missing = await createStatisticsRuntime(t, undefined);
    const missingService = createStatisticsService({
      repository: missing.repository,
    });
    const missingUrl = await startStatisticsServer(t, {
      repository: missing.repository,
      service: missingService,
      backendRoot: missing.root,
    });
    const missingResponse = await httpRequest(
      missingUrl,
      "/api/stats"
    );
    assert.equal(missingResponse.status, 200);
    assert.deepEqual(missingResponse.json, {
      ok: true,
      ready: false,
      byPlayerId: {},
    });
    assert.equal(fs.existsSync(missing.statsFile), false);

    const payload = {
      ok: true,
      seasonId: "test-season",
      byPlayerId: {
        "1001": { goals: 3, assists: 4 },
      },
    };
    const full = await createStatisticsRuntime(t, payload);
    const fullService = createStatisticsService({
      repository: full.repository,
    });
    const fullUrl = await startStatisticsServer(t, {
      repository: full.repository,
      service: fullService,
      backendRoot: full.root,
    });
    const before = await hashFile(full.statsFile);

    const fullResponse = await httpRequest(fullUrl, "/api/stats");
    assert.deepEqual(fullResponse.json, payload);

    const known = await httpRequest(
      fullUrl,
      "/api/stats?playerId=1001"
    );
    assert.deepEqual(known.json, {
      ok: true,
      playerId: "1001",
      stats: { goals: 3, assists: 4 },
    });

    const unknown = await httpRequest(
      fullUrl,
      "/api/stats?playerId=9999"
    );
    assert.deepEqual(unknown.json, {
      ok: true,
      playerId: "9999",
      stats: null,
    });

    const debug = await httpRequest(
      fullUrl,
      "/api/stats/debug"
    );
    assert.equal(debug.status, 200);
    assert.equal(debug.json.STATS_FILE, full.statsFile);
    assert.equal(debug.json.disk.exists, true);

    const localDebug = await httpRequest(
      fullUrl,
      "/api/stats/debug-localpath"
    );
    assert.equal(localDebug.status, 200);
    assert.equal(localDebug.json.__dirname, full.root);
    assert.equal(
      localDebug.json.localPath,
      path.join(full.root, "stats-cache.json")
    );
    assert.equal(localDebug.json.localExists, true);
    assert.equal(localDebug.json.STATS_FILE, full.statsFile);
    assert.equal(await hashFile(full.statsFile), before);
  });

  test("preserves invalid-cache failure response", async (t) => {
    const runtime = await createStatisticsRuntime(t, "{ invalid");
    const service = createStatisticsService({
      repository: runtime.repository,
    });
    const baseUrl = await startStatisticsServer(t, {
      repository: runtime.repository,
      service,
      backendRoot: runtime.root,
    });
    const before = await hashFile(runtime.statsFile);
    const response = await httpRequest(baseUrl, "/api/stats");

    assert.equal(response.status, 500);
    assert.deepEqual(response.json, {
      ok: false,
      error: "Failed to load stats cache",
    });
    assert.equal(await hashFile(runtime.statsFile), before);
  });

  test("rejects unauthorized refresh and runs authorized refresh through the service", async (t) => {
    const runtime = await createStatisticsRuntime(t, {
      ok: true,
      byPlayerId: { old: { goals: 1 } },
    });
    const leagueBefore = await hashFile(runtime.leagueFile);
    let providerCalls = 0;
    let clock = 10_000_000;
    const service = createStatisticsService({
      repository: runtime.repository,
      provider: {
        async fetchRows() {
          providerCalls += 1;
          return createRows(200, 7000);
        },
      },
      nowMs: () => {
        clock += 1;
        return clock;
      },
      seasonId: "20262027",
      logger: { log() {} },
    });
    const baseUrl = await startStatisticsServer(t, {
      repository: runtime.repository,
      service,
      backendRoot: runtime.root,
    });

    for (const headers of [
      undefined,
      { "x-stats-token": "wrong-token" },
    ]) {
      const rejected = await httpRequest(
        baseUrl,
        "/api/stats/refresh",
        { method: "POST", headers }
      );
      assert.equal(rejected.status, 401);
      assert.deepEqual(rejected.json, {
        ok: false,
        error: "Unauthorized",
      });
    }
    assert.equal(providerCalls, 0);

    const accepted = await httpRequest(
      baseUrl,
      "/api/stats/refresh",
      {
        method: "POST",
        headers: {
          "x-stats-token": "statistics-test-token",
        },
      }
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.json, { ok: true });
    assert.equal(providerCalls, 1);
    assert.equal(
      Object.keys(runtime.repository.readCache().byPlayerId).length,
      200
    );
    assert.equal(await hashFile(runtime.leagueFile), leagueBefore);
  });

  test("provider failure returns 500 and preserves the last cache", async (t) => {
    const runtime = await createStatisticsRuntime(t, {
      ok: true,
      byPlayerId: { "1001": { goals: 7 } },
    });
    const before = await hashFile(runtime.statsFile);
    const service = createStatisticsService({
      repository: runtime.repository,
      provider: {
        async fetchRows() {
          throw new Error("synthetic HTTP provider failure");
        },
      },
      nowMs: () => 20_000_000,
      seasonId: "20262027",
      logger: { log() {} },
    });
    const baseUrl = await startStatisticsServer(t, {
      repository: runtime.repository,
      service,
      backendRoot: runtime.root,
    });
    const response = await httpRequest(
      baseUrl,
      "/api/stats/refresh",
      {
        method: "POST",
        headers: {
          "x-stats-token": "statistics-test-token",
        },
      }
    );

    assert.equal(response.status, 500);
    assert.match(
      response.json.error,
      /synthetic HTTP provider failure/
    );
    assert.equal(await hashFile(runtime.statsFile), before);
    assert.equal(fs.existsSync(runtime.lockFile), false);
  });
});
