const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SportsDataIoCatalogImportError,
  createSportsDataIoCatalogImportService,
} = require("../../src/application/services/players/createSportsDataIoCatalogImportService");
const {
  PROVIDER_NAME,
} = require("../../src/infrastructure/sportsdataio/SportsDataIoNhlAdapter");

test("SportsDataIO import persists the full catalog before last-season statistics", async () => {
  const calls = [];
  const service = createSportsDataIoCatalogImportService({
    createId: () => "10000000-0000-4000-8000-000000000001",
    seasonStart: "2025",
    provider: {
      async fetchCatalog(seasonStart) {
        assert.equal(seasonStart, "2025");
        calls.push("fetch-catalog");
        return {
          provider: PROVIDER_NAME,
          capturedAtMs: 1_700_000_000_000,
          rows: [{ player: "normalized-row" }],
        };
      },
    },
    catalogRepository: {
      applyCatalog(command) {
        calls.push("persist-catalog");
        assert.deepEqual(command, {
          sourceOperationId: "10000000-0000-4000-8000-000000000001",
          provider: PROVIDER_NAME,
          capturedAtMs: 1_700_000_000_000,
          rows: [{ player: "normalized-row" }],
        });
        return { createdPlayerCount: 1, updatedPlayerCount: 0, sourceStateChangeCount: 1 };
      },
    },
    statisticsService: {
      async refresh() {
        calls.push("persist-statistics");
        return { refreshId: "refresh-1", status: "succeeded", playerCount: 1, sourceVersion: "last-season-2025" };
      },
    },
  });

  assert.deepEqual(await service.importLastSeason(), {
    provider: PROVIDER_NAME,
    catalog: { createdPlayerCount: 1, updatedPlayerCount: 0, sourceStateChangeCount: 1 },
    statistics: { refreshId: "refresh-1", status: "succeeded", playerCount: 1, sourceVersion: "last-season-2025" },
  });
  assert.deepEqual(calls, ["fetch-catalog", "persist-catalog", "persist-statistics"]);
});

test("SportsDataIO import does not begin statistics when the catalog cannot be persisted", async () => {
  let statisticsCalled = false;
  const service = createSportsDataIoCatalogImportService({
    seasonStart: "2025",
    provider: {
      async fetchCatalog() {
        return { provider: PROVIDER_NAME, capturedAtMs: 1, rows: [{}] };
      },
    },
    catalogRepository: {
      applyCatalog() {
        throw new Error("database is unavailable");
      },
    },
    statisticsService: {
      async refresh() {
        statisticsCalled = true;
      },
    },
  });

  await assert.rejects(
    service.importLastSeason(),
    (error) => error instanceof SportsDataIoCatalogImportError &&
      error.code === "SPORTSDATAIO_CATALOG_PERSISTENCE_FAILED"
  );
  assert.equal(statisticsCalled, false);
});

test("SportsDataIO import revalidates authority after retrieval and before every persistence boundary", async () => {
  const calls = [];
  const authorizationError = Object.assign(
    new Error("authority changed"),
    { code: "STAGING_SPORTSDATAIO_IMPORT_AUTHORITY_CHANGED" }
  );
  const service = createSportsDataIoCatalogImportService({
    seasonStart: "2025",
    provider: {
      async fetchCatalog() {
        calls.push("fetch-catalog");
        return {
          provider: PROVIDER_NAME,
          capturedAtMs: 1_700_000_000_000,
          rows: [{ player: "normalized-row" }],
        };
      },
    },
    catalogRepository: {
      applyCatalog() {
        calls.push("persist-catalog");
      },
    },
    statisticsService: {
      async refresh() {
        calls.push("persist-statistics");
      },
    },
  });

  await assert.rejects(
    service.importLastSeason({
      authorizePersist: async () => {
        calls.push("authorize-persist");
        throw authorizationError;
      },
    }),
    authorizationError
  );
  assert.deepEqual(calls, ["fetch-catalog", "authorize-persist"]);
});
