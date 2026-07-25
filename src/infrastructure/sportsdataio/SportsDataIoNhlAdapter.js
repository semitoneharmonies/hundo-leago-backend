const DEFAULT_ORIGIN = "https://api.sportsdata.io/api/nhl/fantasy";
const MINIMUM_CATALOG_PLAYER_COUNT = 800;
const MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT = 800;
const PROVIDER_NAME = "sportsdataio-discovery-lab";
const SUBSCRIPTION_HEADER = "Ocp-Apim-Subscription-Key";
const CURRENT_PLAYER_STATUSES = new Set([
  "",
  "active",
  "inactive",
  "injured reserve",
  "minors",
  "suspended",
  "bereavement",
  "paternity",
]);

class SportsDataIoNhlAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new SportsDataIoNhlAdapterError(code, message);
}

function requiredApiKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(
      "SPORTSDATAIO_NHL_API_KEY_REQUIRED",
      "SportsDataIO NHL import is disabled until its server-side API key is configured."
    );
  }
  return value;
}

function httpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "SPORTSDATAIO_NHL_ORIGIN_INVALID",
      "SportsDataIO NHL import requires an HTTPS API origin."
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== "https://api.sportsdata.io" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/api/nhl/fantasy" ||
    parsed.search ||
    parsed.hash
  ) {
    fail(
      "SPORTSDATAIO_NHL_ORIGIN_INVALID",
      "SportsDataIO NHL import requires the canonical HTTPS API origin."
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function seasonStartYear(value) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (!/^\d{4}$/.test(normalized)) {
    fail(
      "SPORTSDATAIO_NHL_SEASON_INVALID",
      "SportsDataIO NHL import requires a four-digit season start year."
    );
  }
  return normalized;
}

function providerRegularSeason(seasonStart) {
  const start = seasonStartYear(seasonStart);
  const end = String(Number(start) + 1);
  if (!/^\d{4}$/.test(end)) {
    fail(
      "SPORTSDATAIO_NHL_SEASON_INVALID",
      "SportsDataIO NHL import requires a supported season start year."
    );
  }
  return Object.freeze({
    end,
    apiSeason: `${end}REG`,
  });
}

function apiPath(value, field) {
  if (
    typeof value !== "string" ||
    !/^[-A-Za-z0-9_/]+$/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    fail(
      "SPORTSDATAIO_NHL_PATH_INVALID",
      `SportsDataIO NHL ${field} path is invalid.`
    );
  }
  return value;
}

function positivePlayerCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    fail(
      "SPORTSDATAIO_NHL_MINIMUM_PLAYER_COUNT_INVALID",
      `SportsDataIO NHL ${field} player count is invalid.`
    );
  }
  return value;
}

function sourceUpdatedAtMs(value, fallbackNow) {
  if (typeof value !== "string" || value.length === 0) return fallbackNow;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallbackNow;
}

function sourceVersion(value, fallback) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value.trim().slice(0, 200);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function birthDate(value) {
  const candidate = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function nameParts(row) {
  const firstName = text(row.FirstName);
  const lastName = text(row.LastName);
  const fullName = text(row.Name || row.FullName);
  if (firstName && lastName) {
    return Object.freeze({ firstName, lastName, fullName: fullName || `${firstName} ${lastName}` });
  }
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return Object.freeze({
      firstName: parts[0],
      lastName: parts.slice(1).join(" "),
      fullName,
    });
  }
  fail(
    "SPORTSDATAIO_NHL_CATALOG_INVALID",
    "SportsDataIO NHL catalog response contains a player without a usable name."
  );
}

function normalizedPosition(value) {
  const sourcePosition = text(value).toUpperCase();
  if (["C", "LW", "RW", "F"].includes(sourcePosition)) return "F";
  if (sourcePosition === "D") return "D";
  return null;
}

function normalizedCatalogRow(row, index, nowMs, { currentFeed = false } = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail(
      "SPORTSDATAIO_NHL_CATALOG_INVALID",
      "SportsDataIO NHL catalog response contains an invalid row."
    );
  }
  const providerPlayerId = Number(row.PlayerID);
  if (!Number.isSafeInteger(providerPlayerId) || providerPlayerId <= 0) {
    fail(
      "SPORTSDATAIO_NHL_CATALOG_INVALID",
      "SportsDataIO NHL catalog response contains an invalid player identifier."
    );
  }
  const names = nameParts(row);
  const sourcePosition = text(row.Position).toUpperCase() || null;
  const team = text(row.Team).toUpperCase() || null;
  const providerStatus = text(row.Status).toLowerCase();
  const active =
    currentFeed && CURRENT_PLAYER_STATUSES.has(providerStatus);
  return Object.freeze({
    providerPlayerId: String(providerPlayerId),
    firstName: names.firstName,
    lastName: names.lastName,
    fullName: names.fullName,
    birthDate: birthDate(row.BirthDate),
    status: active ? "active" : "historical",
    sourcePosition,
    normalizedPosition: normalizedPosition(sourcePosition),
    nhlTeamAbbreviation: team,
    active,
    sourceVersion: sourceVersion(row.Updated, `catalog-${nowMs}-${index}`),
    sourceUpdatedAtMs: sourceUpdatedAtMs(row.Updated, nowMs),
  });
}

function normalizedStatisticsRow(row, nowMs, expectedProviderSeason) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail(
      "SPORTSDATAIO_NHL_STATISTICS_INVALID",
      "SportsDataIO NHL statistics response contains an invalid row."
    );
  }
  if (Object.prototype.hasOwnProperty.call(row, "Season")) {
    const exposedSeason =
      typeof row.Season === "number" ? String(row.Season) : row.Season;
    if (
      !/^\d{4}$/.test(exposedSeason) ||
      exposedSeason !== expectedProviderSeason
    ) {
      fail(
        "SPORTSDATAIO_NHL_STATISTICS_INVALID",
        "SportsDataIO NHL statistics response does not match the requested season."
      );
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "SeasonType") &&
    row.SeasonType !== null &&
    Number(row.SeasonType) !== 1
  ) {
    fail(
      "SPORTSDATAIO_NHL_STATISTICS_INVALID",
      "SportsDataIO NHL statistics response is not regular-season data."
    );
  }
  const providerPlayerId = Number(row.PlayerID);
  const gamesPlayed = Number(row.Games);
  const goals = Number(row.Goals);
  const assists = Number(row.Assists);
  if (
    !Number.isSafeInteger(providerPlayerId) || providerPlayerId <= 0 ||
    ![gamesPlayed, goals, assists].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  ) {
    fail(
      "SPORTSDATAIO_NHL_STATISTICS_INVALID",
      "SportsDataIO NHL statistics response contains invalid player totals."
    );
  }
  return Object.freeze({
    providerPlayerId: String(providerPlayerId),
    gamesPlayed,
    goals,
    assists,
    sourceUpdatedAtMs: sourceUpdatedAtMs(row.Updated, nowMs),
  });
}

function createSportsDataIoNhlAdapter({
  apiKey,
  fetchImpl = fetch,
  origin = DEFAULT_ORIGIN,
  catalogPath = "json/Players",
  freeAgentCatalogPath = "json/FreeAgents",
  seasonStatisticsPath = "json/PlayerSeasonStats",
  minimumCatalogPlayerCount = MINIMUM_CATALOG_PLAYER_COUNT,
  minimumLastSeasonStatisticsPlayerCount =
    MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT,
  nowMs = () => Date.now(),
} = {}) {
  const key = requiredApiKey(apiKey);
  if (typeof fetchImpl !== "function") {
    throw new TypeError("SportsDataIO NHL import requires fetch support.");
  }
  if (typeof nowMs !== "function") {
    throw new TypeError("SportsDataIO NHL import requires a clock.");
  }
  const apiOrigin = httpsOrigin(origin);
  const canonicalCatalogPath = apiPath(catalogPath, "catalog");
  const canonicalFreeAgentCatalogPath = apiPath(
    freeAgentCatalogPath,
    "free-agent catalog"
  );
  const canonicalSeasonStatisticsPath = apiPath(
    seasonStatisticsPath,
    "season-statistics"
  );
  const catalogMinimum = positivePlayerCount(
    minimumCatalogPlayerCount,
    "minimum catalog"
  );
  const statisticsMinimum = positivePlayerCount(
    minimumLastSeasonStatisticsPlayerCount,
    "minimum last-season statistics"
  );

  function buildCatalogUrl() {
    return `${apiOrigin}/${canonicalCatalogPath}`;
  }

  function buildFreeAgentCatalogUrl() {
    return `${apiOrigin}/${canonicalFreeAgentCatalogPath}`;
  }

  function buildSeasonStatisticsUrl(season) {
    const { apiSeason } = providerRegularSeason(season);
    return `${apiOrigin}/${canonicalSeasonStatisticsPath}/${apiSeason}`;
  }

  async function fetchRows(url, code) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: Object.freeze({ [SUBSCRIPTION_HEADER]: key }),
      });
    } catch {
      fail(code, "SportsDataIO NHL import could not reach the provider.");
    }
    if (!response?.ok) {
      fail(code, "SportsDataIO NHL import was rejected by the provider.");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      fail(code, "SportsDataIO NHL import returned invalid JSON.");
    }
    if (!Array.isArray(body)) {
      fail(code, "SportsDataIO NHL import returned an unexpected response shape.");
    }
    return body;
  }

  function capturedAtMs() {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("SportsDataIO NHL import clock returned an invalid time.");
    }
    return value;
  }

  function normalizedStatisticsRows(rows, capturedAt, seasonStart) {
    const { end: expectedProviderSeason } =
      providerRegularSeason(seasonStart);
    const statistics = rows.map((row) =>
      normalizedStatisticsRow(row, capturedAt, expectedProviderSeason)
    );
    if (statistics.length < statisticsMinimum) {
      fail(
        "SPORTSDATAIO_NHL_STATISTICS_INCOMPLETE",
        "SportsDataIO NHL import returned incomplete last-season statistics."
      );
    }
    const ids = new Set(
      statistics.map(({ providerPlayerId }) => providerPlayerId)
    );
    if (ids.size !== statistics.length) {
      fail(
        "SPORTSDATAIO_NHL_STATISTICS_INVALID",
        "SportsDataIO NHL statistics import returned duplicate player identifiers."
      );
    }
    return statistics;
  }

  async function fetchCatalog(season) {
    const capturedAt = capturedAtMs();
    const seasonStart = seasonStartYear(season);
    const activeRows = await fetchRows(
      buildCatalogUrl(),
      "SPORTSDATAIO_NHL_CATALOG_REQUEST_FAILED"
    );
    const freeAgentRows = await fetchRows(
      buildFreeAgentCatalogUrl(),
      "SPORTSDATAIO_NHL_CATALOG_REQUEST_FAILED"
    );
    const statisticsRows = await fetchRows(
      buildSeasonStatisticsUrl(seasonStart),
      "SPORTSDATAIO_NHL_STATISTICS_REQUEST_FAILED"
    );
    normalizedStatisticsRows(statisticsRows, capturedAt, seasonStart);

    const catalogByProviderId = new Map();
    for (const [rows, currentFeed, offset] of [
      [activeRows, true, 0],
      [freeAgentRows, true, activeRows.length],
      [statisticsRows, false, activeRows.length + freeAgentRows.length],
    ]) {
      rows.forEach((row, index) => {
        const normalized = normalizedCatalogRow(
          row,
          offset + index,
          capturedAt,
          { currentFeed }
        );
        if (!catalogByProviderId.has(normalized.providerPlayerId)) {
          catalogByProviderId.set(normalized.providerPlayerId, normalized);
        }
      });
    }
    const catalog = [...catalogByProviderId.values()];
    if (catalog.length < catalogMinimum) {
      fail(
        "SPORTSDATAIO_NHL_CATALOG_INCOMPLETE",
        "SportsDataIO NHL import returned an incomplete player catalog."
      );
    }
    return Object.freeze({
      provider: PROVIDER_NAME,
      capturedAtMs: capturedAt,
      rows: Object.freeze(catalog),
    });
  }

  async function fetchLastSeasonStatistics(season) {
    const capturedAt = capturedAtMs();
    const seasonStart = seasonStartYear(season);
    const rows = await fetchRows(
      buildSeasonStatisticsUrl(seasonStart),
      "SPORTSDATAIO_NHL_STATISTICS_REQUEST_FAILED"
    );
    const statistics = normalizedStatisticsRows(
      rows,
      capturedAt,
      seasonStart
    );
    return Object.freeze({
      provider: PROVIDER_NAME,
      seasonStart,
      capturedAtMs: capturedAt,
      rows: Object.freeze(statistics),
    });
  }

  return Object.freeze({
    buildCatalogUrl,
    buildFreeAgentCatalogUrl,
    buildSeasonStatisticsUrl,
    fetchCatalog,
    fetchLastSeasonStatistics,
  });
}

function createSportsDataIoLastSeasonStatisticsProvider({
  adapter,
  seasonStart,
} = {}) {
  if (!adapter || typeof adapter.fetchLastSeasonStatistics !== "function") {
    throw new TypeError(
      "SportsDataIO statistics requires a configured NHL adapter."
    );
  }
  const canonicalSeasonStart = seasonStartYear(seasonStart);

  return Object.freeze({
    async fetchRows() {
      const result = await adapter.fetchLastSeasonStatistics(
        canonicalSeasonStart
      );
      return Object.freeze({
        rows: Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              playerId: row.providerPlayerId,
              gamesPlayed: row.gamesPlayed,
              goals: row.goals,
              assists: row.assists,
            })
          )
        ),
        sourceUpdatedAtMs: result.capturedAtMs,
        sourceVersion: `last-season-${result.seasonStart}`,
      });
    },
  });
}

function sportsDataIoImportStatus(env = process.env) {
  return Object.freeze({
    provider: PROVIDER_NAME,
    enabled:
      typeof env?.SPORTSDATAIO_NHL_API_KEY === "string" &&
      env.SPORTSDATAIO_NHL_API_KEY.trim().length > 0,
    dataScope: "last-season-only",
  });
}

module.exports = {
  DEFAULT_ORIGIN,
  MINIMUM_CATALOG_PLAYER_COUNT,
  MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT,
  PROVIDER_NAME,
  SUBSCRIPTION_HEADER,
  SportsDataIoNhlAdapterError,
  createSportsDataIoNhlAdapter,
  createSportsDataIoLastSeasonStatisticsProvider,
  sportsDataIoImportStatus,
};
