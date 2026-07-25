const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_ORIGIN,
  MINIMUM_CATALOG_PLAYER_COUNT,
  PROVIDER_NAME,
  SUBSCRIPTION_HEADER,
  SportsDataIoNhlAdapterError,
  createSportsDataIoNhlAdapter,
  createSportsDataIoLastSeasonStatisticsProvider,
  sportsDataIoImportStatus,
} = require("../../src/infrastructure/sportsdataio/SportsDataIoNhlAdapter");

function response(body, { ok = true } = {}) {
  return { ok, async json() { return body; } };
}

test("SportsDataIO NHL adapter imports current, free-agent, and statistics-only players without exposing its key", async () => {
  const calls = [];
  const adapter = createSportsDataIoNhlAdapter({
    apiKey: "test-key",
    minimumCatalogPlayerCount: 3,
    minimumLastSeasonStatisticsPlayerCount: 2,
    nowMs: () => 1_700_000_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/scores/json/Players")) {
        return response([{
          PlayerID: 11,
          FirstName: "Ada",
          LastName: "Skater",
          Status: "Injured Reserve",
          Team: "VAN",
          Position: "LW",
          BirthDate: "1998-02-03T00:00:00",
          Updated: "2025-04-18T12:00:00",
        }]);
      }
      if (url.endsWith("/scores/json/FreeAgents")) {
        return response([{
          PlayerID: 12,
          FirstName: "Bea",
          LastName: "Defender",
          Status: "Inactive",
          Position: "D",
        }]);
      }
      return response([
        {
          PlayerID: 11,
          Name: "Ada Skater",
          Team: "VAN",
          Position: "LW",
          Games: 82,
          Goals: 40,
          Assists: 50,
          Season: 2024,
        },
        {
          PlayerID: 13,
          Name: "Cara Historical",
          Team: "SEA",
          Position: "C",
          Games: 40,
          Goals: 10,
          Assists: 20,
          Season: 2024,
        },
      ]);
    },
  });

  const catalog = await adapter.fetchCatalog("2024");

  assert.equal(calls[0].url, `${DEFAULT_ORIGIN}/scores/json/Players`);
  assert.equal(calls[1].url, `${DEFAULT_ORIGIN}/scores/json/FreeAgents`);
  assert.equal(
    calls[2].url,
    `${DEFAULT_ORIGIN}/stats/json/PlayerSeasonStats/2024`
  );
  for (const call of calls) {
    assert.deepEqual(call.options, {
      method: "GET",
      headers: { [SUBSCRIPTION_HEADER]: "test-key" },
    });
    assert.equal(call.url.includes("test-key"), false);
  }
  assert.equal(catalog.provider, PROVIDER_NAME);
  assert.deepEqual(catalog.rows[0], {
    providerPlayerId: "11",
    firstName: "Ada",
    lastName: "Skater",
    fullName: "Ada Skater",
    birthDate: "1998-02-03",
    status: "active",
    sourcePosition: "LW",
    normalizedPosition: "F",
    nhlTeamAbbreviation: "VAN",
    active: true,
    sourceVersion: "2025-04-18T12:00:00",
    sourceUpdatedAtMs: Date.parse("2025-04-18T12:00:00"),
  });
  assert.equal(catalog.rows[1].providerPlayerId, "12");
  assert.equal(catalog.rows[1].status, "active");
  assert.equal(catalog.rows[1].active, true);
  assert.equal(catalog.rows[2].providerPlayerId, "13");
  assert.equal(catalog.rows[2].status, "historical");
  assert.equal(catalog.rows[2].active, false);
});

test("SportsDataIO NHL adapter normalizes last-season totals without a live request", async () => {
  const adapter = createSportsDataIoNhlAdapter({
    apiKey: "test-key",
    minimumLastSeasonStatisticsPlayerCount: 1,
    nowMs: () => 1_700_000_000_000,
    fetchImpl: async () => response([{
      PlayerID: 11,
      Games: 82,
      Goals: 40,
      Assists: 50,
      Season: 2024,
      Updated: "2025-04-18T12:00:00",
    }]),
  });

  const statistics = await adapter.fetchLastSeasonStatistics(2024);

  assert.equal(adapter.buildSeasonStatisticsUrl("2024"), `${DEFAULT_ORIGIN}/stats/json/PlayerSeasonStats/2024`);
  assert.deepEqual(statistics, {
    provider: PROVIDER_NAME,
    seasonStart: "2024",
    capturedAtMs: 1_700_000_000_000,
    rows: [{
      providerPlayerId: "11",
      gamesPlayed: 82,
      goals: 40,
      assists: 50,
      sourceUpdatedAtMs: Date.parse("2025-04-18T12:00:00"),
    }],
  });
});

test("SportsDataIO last-season statistics provider exposes rows for persisted refreshes", async () => {
  const adapter = createSportsDataIoNhlAdapter({
    apiKey: "test-key",
    minimumLastSeasonStatisticsPlayerCount: 1,
    nowMs: () => 1_700_000_000_000,
    fetchImpl: async () => response([{
      PlayerID: 11,
      Games: 82,
      Goals: 40,
      Assists: 50,
    }]),
  });
  const provider = createSportsDataIoLastSeasonStatisticsProvider({
    adapter,
    seasonStart: "2024",
  });

  assert.deepEqual(await provider.fetchRows(), {
    rows: [{ playerId: "11", gamesPlayed: 82, goals: 40, assists: 50 }],
    sourceUpdatedAtMs: 1_700_000_000_000,
    sourceVersion: "last-season-2024",
  });
});

test("SportsDataIO NHL adapter fails closed without a key or for unsafe responses", async () => {
  assert.throws(
    () => createSportsDataIoNhlAdapter(),
    (error) => error instanceof SportsDataIoNhlAdapterError &&
      error.code === "SPORTSDATAIO_NHL_API_KEY_REQUIRED"
  );
  const adapter = createSportsDataIoNhlAdapter({
    apiKey: "test-key",
    fetchImpl: async () => response({ error: "not an array" }),
  });
  await assert.rejects(
    adapter.fetchCatalog("2024"),
    (error) => error instanceof SportsDataIoNhlAdapterError &&
      error.code === "SPORTSDATAIO_NHL_CATALOG_REQUEST_FAILED"
  );
  assert.deepEqual(sportsDataIoImportStatus({}), {
    provider: PROVIDER_NAME,
    enabled: false,
    dataScope: "last-season-only",
  });
});

test("SportsDataIO NHL adapter never sends its key to a non-provider host", () => {
  assert.throws(
    () => createSportsDataIoNhlAdapter({
      apiKey: "test-key",
      origin: "https://credential-capture.example/v3/nhl",
    }),
    (error) => error instanceof SportsDataIoNhlAdapterError &&
      error.code === "SPORTSDATAIO_NHL_ORIGIN_INVALID"
  );
});

test("SportsDataIO NHL adapter rejects exposed statistics for another season", async () => {
  const adapter = createSportsDataIoNhlAdapter({
    apiKey: "test-key",
    minimumLastSeasonStatisticsPlayerCount: 1,
    fetchImpl: async () => response([{
      PlayerID: 11,
      Games: 82,
      Goals: 40,
      Assists: 50,
      Season: 2023,
    }]),
  });

  await assert.rejects(
    adapter.fetchLastSeasonStatistics("2024"),
    (error) => error instanceof SportsDataIoNhlAdapterError &&
      error.code === "SPORTSDATAIO_NHL_STATISTICS_INVALID"
  );
});

test("SportsDataIO NHL adapter refuses a truncated catalog before persistence", async () => {
  const adapter = createSportsDataIoNhlAdapter({
    apiKey: "test-key",
    minimumLastSeasonStatisticsPlayerCount: 1,
    fetchImpl: async (url) => {
      if (url.endsWith("/scores/json/Players")) {
        return response([{
          PlayerID: 11,
          FirstName: "Ada",
          LastName: "Skater",
          Status: "Active",
        }]);
      }
      if (url.endsWith("/scores/json/FreeAgents")) return response([]);
      return response([{
        PlayerID: 11,
        Name: "Ada Skater",
        Games: 82,
        Goals: 40,
        Assists: 50,
        Season: 2024,
      }]);
    },
  });
  await assert.rejects(
    adapter.fetchCatalog("2024"),
    (error) => error instanceof SportsDataIoNhlAdapterError &&
      error.code === "SPORTSDATAIO_NHL_CATALOG_INCOMPLETE"
  );
  assert.equal(MINIMUM_CATALOG_PLAYER_COUNT, 800);
});

test("SportsDataIO NHL adapter refuses truncated last-season statistics", async () => {
  const adapter = createSportsDataIoNhlAdapter({
    apiKey: "test-key",
    fetchImpl: async () => response([{
      PlayerID: 11,
      Games: 82,
      Goals: 40,
      Assists: 50,
      Season: 2024,
    }]),
  });

  await assert.rejects(
    adapter.fetchLastSeasonStatistics("2024"),
    (error) => error instanceof SportsDataIoNhlAdapterError &&
      error.code === "SPORTSDATAIO_NHL_STATISTICS_INCOMPLETE"
  );
});
