const {
  hashCanonicalJsonV1,
} = require(
  "../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
  hashSportsDataIoLiveCapabilityProbeManifest,
  normalizeSportsDataIoLiveCapabilityProbeManifest,
  readBoundedResponseBytes,
} = require("./createSportsDataIoLiveCapabilityCheck");

const SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_DOMAIN =
  "hundo-leago.sportsdataio-live-capability-discovery";
const SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_SCHEMA_VERSION = 1;
const SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES =
  Object.freeze({
    configurationInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_CONFIGURATION_INVALID",
    databaseInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_DATABASE_INVALID",
    providerFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_PROVIDER_FAILED",
    semanticFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_SEMANTIC_FAILED",
    internalFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_INTERNAL_FAILED",
  });

const PROVIDER_ORIGIN = "https://api.sportsdata.io";
const PLAYER_IDENTITY_PROVIDER = "sportsdataio-discovery-lab";
const CONFIGURED_NHL_SEASON_KEY = "20262027";
const PROBE_NHL_SEASON_KEY = "20252026";
const PROVIDER_PROBE_SEASON = 2026;
const PROVIDER_PROBE_API_SEASON = "2026REG";
const SUBSCRIPTION_HEADER = "Ocp-Apim-Subscription-Key";
const EASTERN_TIME_ZONE = "America/New_York";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MINIMUM_SEASON_TOTAL_ROWS = 700;
const MAXIMUM_ROWS = Object.freeze({
  players: 2_500,
  freeAgents: 2_500,
  seasonTotals: 2_500,
  games: 64,
  playerGames: 5_000,
});
const MAXIMUM_DATABASE_MAPPINGS = 5_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROVIDER_ID_PATTERN = /^[1-9]\d{0,15}$/u;
const IDENTITY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const PROVIDER_EASTERN_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u;
const FINAL_GAME_STATUSES = new Set([
  "Final",
  "F/SO",
  "F/OT",
  "Final/SO",
  "Final/OT",
]);
const NON_DUE_GAME_STATUSES = new Set([
  "Postponed",
  "Canceled",
  "Cancelled",
  "NotNecessary",
]);
const SUPPORTED_GAME_STATUSES = new Set([
  "Scheduled",
  "Pregame",
  "PreGame",
  "InProgress",
  "Intermission",
  ...FINAL_GAME_STATUSES,
  ...NON_DUE_GAME_STATUSES,
]);
const DATABASE_IDENTITY_KEYS = Object.freeze([
  "database_created_at",
  "database_id",
  "environment_id",
]);
const ENDPOINT_KEYS = Object.freeze([
  "players",
  "freeAgents",
  "seasonTotals",
  "historicalGames",
  "historicalPlayerGameStats",
  "currentGames",
  "currentPlayerGameStats",
]);

class SportsDataIoLiveCapabilityDiscoveryError extends Error {
  constructor(code) {
    super("The SportsDataIO live capability discovery failed safely.");
    this.name = "SportsDataIoLiveCapabilityDiscoveryError";
    this.code = code;
  }
}

function fail(code) {
  throw new SportsDataIoLiveCapabilityDiscoveryError(code);
}

function isPlainRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  return Object.getOwnPropertyNames(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(
      descriptor &&
      descriptor.enumerable === true &&
      Object.prototype.hasOwnProperty.call(descriptor, "value")
    );
  });
}

function requireRecordKeys(value, keys) {
  if (
    !isPlainRecord(value) ||
    keys.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key)
    )
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  return value;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareProviderIds(left, right) {
  const difference = Number(left) - Number(right);
  return difference || compareText(left, right);
}

function canonicalDate(value, code) {
  const match =
    typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  if (!match) fail(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail(code);
  }
  return value;
}

function providerId(value) {
  const normalized =
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
      ? String(value)
      : value;
  if (
    typeof normalized !== "string" ||
    !PROVIDER_ID_PATTERN.test(normalized) ||
    !Number.isSafeInteger(Number(normalized))
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  return normalized;
}

function nonNegativeInteger(
  value,
  { nullableZero = false } = {}
) {
  const normalized =
    nullableZero && (value === null || value === undefined)
      ? 0
      : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  return normalized;
}

function safeTimestamp(value, code) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    fail(code);
  }
  return value;
}

const easternDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: EASTERN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function easternCalendarDate(timestampMs) {
  safeTimestamp(
    timestampMs,
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
      .configurationInvalid
  );
  const parts = Object.fromEntries(
    easternDateFormatter
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function utcTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u.test(
      value
    )
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  const parsed = Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      ? value
      : `${value}Z`
  );
  return safeTimestamp(
    parsed,
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
      .semanticFailed
  );
}

function easternTimestampParts(timestampMs) {
  const values = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return Object.freeze({
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: Number(values.fractionalSecond),
  });
}

function sameTimestampParts(left, right) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second &&
    left.millisecond === right.millisecond
  );
}

function providerEasternTimestamp(value) {
  const match =
    typeof value === "string"
      ? PROVIDER_EASTERN_TIMESTAMP_PATTERN.exec(value)
      : null;
  if (!match) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  const expected = Object.freeze({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    millisecond: Number((match[7] || "").padEnd(3, "0") || "0"),
  });
  const wallClockAsUtcMs = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
    expected.second,
    expected.millisecond
  );
  const calendar = new Date(wallClockAsUtcMs);
  if (
    expected.year < 1970 ||
    calendar.getUTCFullYear() !== expected.year ||
    calendar.getUTCMonth() !== expected.month - 1 ||
    calendar.getUTCDate() !== expected.day ||
    calendar.getUTCHours() !== expected.hour ||
    calendar.getUTCMinutes() !== expected.minute ||
    calendar.getUTCSeconds() !== expected.second ||
    calendar.getUTCMilliseconds() !== expected.millisecond
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const possibleOffsets = new Set();
  for (const deltaMs of [-dayMs, 0, dayMs]) {
    const sampleMs = wallClockAsUtcMs + deltaMs;
    const sample = easternTimestampParts(sampleMs);
    possibleOffsets.add(
      Date.UTC(
        sample.year,
        sample.month - 1,
        sample.day,
        sample.hour,
        sample.minute,
        sample.second,
        sample.millisecond
      ) - sampleMs
    );
  }
  const candidates = [...possibleOffsets]
    .map((offsetMs) => wallClockAsUtcMs - offsetMs)
    .filter(
      (candidateMs) =>
        Number.isSafeInteger(candidateMs) &&
        candidateMs >= 0 &&
        sameTimestampParts(
          easternTimestampParts(candidateMs),
          expected
        )
    );
  if (candidates.length !== 1) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  return candidates[0];
}

function assertProbeDate(historicalDate, currentEasternDate) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
      .configurationInvalid;
  canonicalDate(historicalDate, code);
  canonicalDate(currentEasternDate, code);
  if (
    historicalDate < "2025-07-01" ||
    historicalDate > "2026-06-30" ||
    historicalDate >= currentEasternDate
  ) {
    fail(code);
  }
}

function endpointUrls(historicalDate, currentEasternDate) {
  assertProbeDate(historicalDate, currentEasternDate);
  return Object.freeze({
    players: `${PROVIDER_ORIGIN}/v3/nhl/scores/json/Players`,
    freeAgents:
      `${PROVIDER_ORIGIN}/v3/nhl/scores/json/FreeAgents`,
    seasonTotals:
      `${PROVIDER_ORIGIN}/v3/nhl/stats/json/PlayerSeasonStats/` +
      PROVIDER_PROBE_API_SEASON,
    historicalGames:
      `${PROVIDER_ORIGIN}/v3/nhl/scores/json/GamesByDate/` +
      historicalDate,
    historicalPlayerGameStats:
      `${PROVIDER_ORIGIN}/v3/nhl/stats/json/` +
      `PlayerGameStatsByDate/${historicalDate}`,
    currentGames:
      `${PROVIDER_ORIGIN}/v3/nhl/scores/json/GamesByDate/` +
      currentEasternDate,
    currentPlayerGameStats:
      `${PROVIDER_ORIGIN}/v3/nhl/stats/json/` +
      `PlayerGameStatsByDate/${currentEasternDate}`,
  });
}

async function readProviderRows(response, maximumRows) {
  const semanticCode =
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
      .semanticFailed;
  if (
    !response ||
    response.status !== 200 ||
    response.ok !== true ||
    response.redirected !== false ||
    typeof response.headers?.get !== "function" ||
    !/^application\/json(?:\s*;|$)/iu.test(
      response.headers.get("content-type") || ""
    )
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .providerFailed
    );
  }
  let raw;
  try {
    raw = await readBoundedResponseBytes(
      response,
      MAX_RESPONSE_BYTES
    );
    const rows = JSON.parse(raw.toString("utf8"));
    if (
      !Array.isArray(rows) ||
      rows.length > maximumRows ||
      Object.getOwnPropertyNames(rows).length !== rows.length + 1
    ) {
      fail(semanticCode);
    }
    return rows;
  } catch (error) {
    if (error instanceof SportsDataIoLiveCapabilityDiscoveryError) {
      throw error;
    }
    fail(semanticCode);
  } finally {
    if (raw) raw.fill(0);
    if (
      response.bodyUsed === false &&
      response.body &&
      typeof response.body.cancel === "function"
    ) {
      try {
        await response.body.cancel();
      } catch {
        // The bounded cloned read already supplied the authoritative result.
      }
    }
  }
}

function normalizeMembershipRows(rows, kind) {
  const normalized = [];
  const seen = new Set();
  for (const candidate of rows) {
    const row = requireRecordKeys(candidate, ["PlayerID", "TeamID"]);
    const providerPlayerId = providerId(row.PlayerID);
    if (seen.has(providerPlayerId)) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
          .semanticFailed
      );
    }
    seen.add(providerPlayerId);
    if (kind === "free_agent") {
      if (row.TeamID !== null) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .semanticFailed
        );
      }
      normalized.push({
        providerPlayerId,
        providerTeamId: null,
      });
    } else {
      if (row.TeamID === null) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .semanticFailed
        );
      }
      normalized.push({
        providerPlayerId,
        providerTeamId: providerId(row.TeamID),
      });
    }
  }
  normalized.sort((left, right) =>
    compareProviderIds(
      left.providerPlayerId,
      right.providerPlayerId
    )
  );
  return normalized;
}

function assertProbeSeason(row) {
  if (
    (
      row.Season !== null &&
      row.Season !== undefined &&
      Number(row.Season) !== PROVIDER_PROBE_SEASON
    ) ||
    (
      row.SeasonType !== null &&
      row.SeasonType !== undefined &&
      Number(row.SeasonType) !== 1
    )
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
}

function normalizeSeasonTotals(rows) {
  if (rows.length < MINIMUM_SEASON_TOTAL_ROWS) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  const totals = new Map();
  for (const candidate of rows) {
    const row = requireRecordKeys(candidate, ["PlayerID"]);
    assertProbeSeason(row);
    const providerPlayerId = providerId(row.PlayerID);
    if (totals.has(providerPlayerId)) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
          .semanticFailed
      );
    }
    totals.set(providerPlayerId, Object.freeze({
      games: nonNegativeInteger(row.Games, {
        nullableZero: true,
      }),
      goals: nonNegativeInteger(row.Goals, {
        nullableZero: true,
      }),
      assists: nonNegativeInteger(row.Assists, {
        nullableZero: true,
      }),
    }));
  }
  return totals;
}

function normalizeGames(rows, requestedDate) {
  const games = new Map();
  for (const candidate of rows) {
    const row = requireRecordKeys(candidate, [
      "GameID",
      "Status",
      "DateTimeUTC",
      "HomeTeamID",
      "AwayTeamID",
    ]);
    assertProbeSeason(row);
    if (!SUPPORTED_GAME_STATUSES.has(row.Status)) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
          .semanticFailed
      );
    }
    const nhlGameId = providerId(row.GameID);
    const homeTeamId = providerId(row.HomeTeamID);
    const awayTeamId = providerId(row.AwayTeamID);
    const startsAtMs = utcTimestamp(row.DateTimeUTC);
    if (
      homeTeamId === awayTeamId ||
      easternCalendarDate(startsAtMs) !== requestedDate ||
      games.has(nhlGameId)
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
          .semanticFailed
      );
    }
    games.set(nhlGameId, Object.freeze({
      nhlGameId,
      providerHomeTeamId: homeTeamId,
      providerAwayTeamId: awayTeamId,
      nhlGameScheduledStartsAtMs: startsAtMs,
      providerStatus: row.Status,
    }));
  }
  return games;
}

function normalizePlayerGames(rows, games, capturedAtMs) {
  const normalized = [];
  const seen = new Set();
  for (const candidate of rows) {
    const row = requireRecordKeys(candidate, [
      "PlayerID",
      "TeamID",
      "GameID",
      "Games",
      "Goals",
      "Assists",
      "Updated",
    ]);
    assertProbeSeason(row);
    const providerPlayerId = providerId(row.PlayerID);
    const providerTeamId =
      row.TeamID === null ? null : providerId(row.TeamID);
    const nhlGameId = providerId(row.GameID);
    const game = games.get(nhlGameId);
    const identity = `${providerPlayerId}\u0000${nhlGameId}`;
    const gamesValue = nonNegativeInteger(row.Games);
    const sourceUpdatedAtMs = providerEasternTimestamp(row.Updated);
    if (
      !game ||
      seen.has(identity) ||
      ![0, 1].includes(gamesValue) ||
      sourceUpdatedAtMs > capturedAtMs
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
          .semanticFailed
      );
    }
    seen.add(identity);
    normalized.push(Object.freeze({
      providerPlayerId,
      providerTeamId,
      nhlGameId,
      games: gamesValue,
      goals: nonNegativeInteger(row.Goals),
      assists: nonNegativeInteger(row.Assists),
      sourceUpdatedAtMs,
    }));
  }
  normalized.sort((left, right) =>
    compareProviderIds(
      left.providerPlayerId,
      right.providerPlayerId
    ) || compareProviderIds(left.nhlGameId, right.nhlGameId)
  );
  return normalized;
}

function readDatabaseScope(database, configuration) {
  const databaseCode =
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
      .databaseInvalid;
  if (
    !database ||
    typeof database.pragma !== "function" ||
    typeof database.prepare !== "function" ||
    database.pragma("query_only", { simple: true }) !== 1
  ) {
    fail(databaseCode);
  }
  let identityRows;
  let mappingRows;
  try {
    identityRows = database.prepare(`
      SELECT metadata_key AS key, metadata_value AS value
      FROM application_metadata
      WHERE metadata_key IN (?, ?, ?)
      ORDER BY metadata_key
    `).all(...DATABASE_IDENTITY_KEYS);
    mappingRows = database.prepare(`
      SELECT p.id AS playerId, x.external_value AS providerPlayerId
      FROM player_external_ids AS x
      JOIN players AS p ON p.id = x.player_id
      WHERE x.provider = ?
      ORDER BY x.external_value, p.id
    `).all(PLAYER_IDENTITY_PROVIDER);
  } catch {
    fail(databaseCode);
  }
  if (
    !Array.isArray(identityRows) ||
    identityRows.length !== 3 ||
    !Array.isArray(mappingRows) ||
    mappingRows.length < 3 ||
    mappingRows.length > MAXIMUM_DATABASE_MAPPINGS
  ) {
    fail(databaseCode);
  }
  const identity = new Map();
  for (const candidate of identityRows) {
    let row;
    try {
      row = requireRecordKeys(candidate, ["key", "value"]);
    } catch {
      fail(databaseCode);
    }
    if (
      !DATABASE_IDENTITY_KEYS.includes(row.key) ||
      typeof row.value !== "string" ||
      identity.has(row.key)
    ) {
      fail(databaseCode);
    }
    identity.set(row.key, row.value);
  }
  if (
    identity.get("environment_id") !== configuration.environmentId ||
    identity.get("database_id") !== configuration.databaseId ||
    typeof identity.get("database_created_at") !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      identity.get("database_created_at")
    ) ||
    !Number.isFinite(Date.parse(identity.get("database_created_at")))
  ) {
    fail(databaseCode);
  }
  const mappings = new Map();
  const playerIds = new Set();
  for (const candidate of mappingRows) {
    let row;
    try {
      row = requireRecordKeys(candidate, [
        "playerId",
        "providerPlayerId",
      ]);
    } catch {
      fail(databaseCode);
    }
    if (
      typeof row.playerId !== "string" ||
      !UUID_PATTERN.test(row.playerId)
    ) {
      fail(databaseCode);
    }
    let normalizedProviderId;
    try {
      normalizedProviderId = providerId(row.providerPlayerId);
    } catch {
      fail(databaseCode);
    }
    if (
      mappings.has(normalizedProviderId) ||
      playerIds.has(row.playerId)
    ) {
      fail(databaseCode);
    }
    mappings.set(normalizedProviderId, row.playerId);
    playerIds.add(row.playerId);
  }
  return mappings;
}

function selectedCandidateFacts({
  expected,
  noDue,
  noTeam,
  games,
}) {
  const game = games.get(expected.nhlGameId);
  return Object.freeze({
    expectedGame: Object.freeze({
      playerId: expected.playerId,
      providerPlayerId: expected.providerPlayerId,
      providerTeamId: expected.providerTeamId,
      nhlGameId: expected.nhlGameId,
      nhlGameScheduledStartsAtMs:
        game.nhlGameScheduledStartsAtMs,
      sourceUpdatedAtMs: expected.sourceUpdatedAtMs,
    }),
    noDueGame: Object.freeze({
      playerId: noDue.playerId,
      providerPlayerId: noDue.providerPlayerId,
      providerTeamId: noDue.providerTeamId,
    }),
    noTeam: Object.freeze({
      playerId: noTeam.playerId,
      providerPlayerId: noTeam.providerPlayerId,
    }),
  });
}

function createCandidateResult({
  configuration,
  historicalDate,
  currentEasternDate,
  endpointRows,
  mappings,
  capturedAtMs,
}) {
  const active = normalizeMembershipRows(
    endpointRows.players,
    "active"
  );
  const freeAgents = normalizeMembershipRows(
    endpointRows.freeAgents,
    "free_agent"
  );
  const activeById = new Map(
    active.map((entry) => [entry.providerPlayerId, entry])
  );
  const freeById = new Map(
    freeAgents.map((entry) => [entry.providerPlayerId, entry])
  );
  if (
    active.some((entry) => freeById.has(entry.providerPlayerId))
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }
  const totals = normalizeSeasonTotals(endpointRows.seasonTotals);
  const historicalGames = normalizeGames(
    endpointRows.historicalGames,
    historicalDate
  );
  const currentGames = normalizeGames(
    endpointRows.currentGames,
    currentEasternDate
  );
  const historicalPlayerGames = normalizePlayerGames(
    endpointRows.historicalPlayerGameStats,
    historicalGames,
    capturedAtMs
  );
  normalizePlayerGames(
    endpointRows.currentPlayerGameStats,
    currentGames,
    capturedAtMs
  );

  const dueTeamIds = new Set();
  for (const game of currentGames.values()) {
    if (
      game.nhlGameScheduledStartsAtMs <= capturedAtMs &&
      !NON_DUE_GAME_STATUSES.has(game.providerStatus)
    ) {
      dueTeamIds.add(game.providerHomeTeamId);
      dueTeamIds.add(game.providerAwayTeamId);
    }
  }

  const expectedCandidates = historicalPlayerGames
    .filter((row) => {
      const game = historicalGames.get(row.nhlGameId);
      const membership = activeById.get(
        row.providerPlayerId
      );
      return Boolean(
        mappings.has(row.providerPlayerId) &&
        membership &&
        totals.has(row.providerPlayerId) &&
        game &&
        row.providerTeamId !== null &&
        membership.providerTeamId === row.providerTeamId &&
        [
          game.providerHomeTeamId,
          game.providerAwayTeamId,
        ].includes(row.providerTeamId) &&
        !dueTeamIds.has(row.providerTeamId) &&
        FINAL_GAME_STATUSES.has(game.providerStatus) &&
        row.games === 0 &&
        row.goals === 0 &&
        row.assists === 0 &&
        row.sourceUpdatedAtMs >=
          game.nhlGameScheduledStartsAtMs
      );
    })
    .map((row) => Object.freeze({
      ...row,
      playerId: mappings.get(row.providerPlayerId),
    }));

  const noDueCandidates = active
    .filter(
      (row) =>
        mappings.has(row.providerPlayerId) &&
        totals.has(row.providerPlayerId) &&
        !dueTeamIds.has(row.providerTeamId)
    )
    .map((row) => Object.freeze({
      ...row,
      playerId: mappings.get(row.providerPlayerId),
    }));
  const noTeamCandidates = freeAgents
    .filter(
      (row) =>
        mappings.has(row.providerPlayerId) &&
        totals.has(row.providerPlayerId)
    )
    .map((row) => Object.freeze({
      ...row,
      playerId: mappings.get(row.providerPlayerId),
    }));

  expectedCandidates.sort((left, right) =>
    compareProviderIds(
      left.providerPlayerId,
      right.providerPlayerId
    ) || compareProviderIds(left.nhlGameId, right.nhlGameId)
  );
  noDueCandidates.sort((left, right) =>
    compareProviderIds(
      left.providerPlayerId,
      right.providerPlayerId
    )
  );
  noTeamCandidates.sort((left, right) =>
    compareProviderIds(
      left.providerPlayerId,
      right.providerPlayerId
    )
  );
  const expected = expectedCandidates[0];
  const noDue = noDueCandidates.find(
    (candidate) => candidate.playerId !== expected?.playerId
  );
  const noTeam = noTeamCandidates.find(
    (candidate) =>
      candidate.playerId !== expected?.playerId &&
      candidate.playerId !== noDue?.playerId
  );
  if (!expected || !noDue || !noTeam) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .semanticFailed
    );
  }

  const players = [
    {
      playerId: expected.playerId,
      providerPlayerId: expected.providerPlayerId,
      expectedDisposition: "expected_game",
    },
    {
      playerId: noDue.playerId,
      providerPlayerId: noDue.providerPlayerId,
      expectedDisposition: "no_due_game",
    },
    {
      playerId: noTeam.playerId,
      providerPlayerId: noTeam.providerPlayerId,
      expectedDisposition: "no_team",
    },
  ].sort((left, right) =>
    compareText(left.playerId, right.playerId) ||
    compareProviderIds(
      left.providerPlayerId,
      right.providerPlayerId
    )
  );
  const historicalGame = historicalGames.get(expected.nhlGameId);
  let manifest;
  try {
    manifest = normalizeSportsDataIoLiveCapabilityProbeManifest({
      domain:
        SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
      schemaVersion:
        SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
      probeKind: "historical_offseason",
      configuredNhlSeasonKey:
        configuration.configuredNhlSeasonKey,
      probeNhlSeasonKey: PROBE_NHL_SEASON_KEY,
      players,
      historicalZeroGame: {
        playerId: expected.playerId,
        providerPlayerId: expected.providerPlayerId,
        providerTeamId: expected.providerTeamId,
        nhlGameId: expected.nhlGameId,
        nhlGameScheduledStartsAtMs:
          historicalGame.nhlGameScheduledStartsAtMs,
      },
    });
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .internalFailed
    );
  }
  const selected = selectedCandidateFacts({
    expected,
    noDue,
    noTeam,
    games: historicalGames,
  });
  const candidateFacts = deepFreeze({
    configuredNhlSeasonKey: CONFIGURED_NHL_SEASON_KEY,
    probeNhlSeasonKey: PROBE_NHL_SEASON_KEY,
    historicalDate,
    currentEasternDate,
    exactRequestCount: ENDPOINT_KEYS.length,
    endpointRowCounts: Object.freeze({
      players: endpointRows.players.length,
      freeAgents: endpointRows.freeAgents.length,
      seasonTotals: endpointRows.seasonTotals.length,
      historicalGames: endpointRows.historicalGames.length,
      historicalPlayerGameStats:
        endpointRows.historicalPlayerGameStats.length,
      currentGames: endpointRows.currentGames.length,
      currentPlayerGameStats:
        endpointRows.currentPlayerGameStats.length,
    }),
    qualifyingCandidateCounts: Object.freeze({
      expectedGame: expectedCandidates.length,
      noDueGame: noDueCandidates.length,
      noTeam: noTeamCandidates.length,
    }),
    selected,
    manifestSha256:
      hashSportsDataIoLiveCapabilityProbeManifest(manifest),
  });
  const semanticHash = hashCanonicalJsonV1({
    domain: SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_DOMAIN,
    schemaVersion:
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_SCHEMA_VERSION,
    manifest,
    candidateFacts,
  });
  return deepFreeze({ manifest, candidateFacts, semanticHash });
}

function normalizeConfiguration(configuration) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
      .configurationInvalid;
  if (!isPlainRecord(configuration)) fail(code);
  const expectedKeys = [
    "appEnv",
    "environmentId",
    "databaseId",
    "configuredNhlSeasonKey",
    "liveMode",
    "dedicatedLiveApiKey",
  ];
  const actualKeys = Object.getOwnPropertyNames(configuration).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    [...expectedKeys].sort().some(
      (key, index) => key !== actualKeys[index]
    ) ||
    configuration.appEnv !== "staging" ||
    configuration.liveMode !== "probe" ||
    configuration.configuredNhlSeasonKey !==
      CONFIGURED_NHL_SEASON_KEY ||
    typeof configuration.environmentId !== "string" ||
    !IDENTITY_PATTERN.test(configuration.environmentId) ||
    typeof configuration.databaseId !== "string" ||
    !IDENTITY_PATTERN.test(configuration.databaseId) ||
    typeof configuration.dedicatedLiveApiKey !== "string" ||
    configuration.dedicatedLiveApiKey.length < 1 ||
    configuration.dedicatedLiveApiKey.length > 1024 ||
    configuration.dedicatedLiveApiKey.trim() !==
      configuration.dedicatedLiveApiKey ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(
      configuration.dedicatedLiveApiKey
    )
  ) {
    fail(code);
  }
  return configuration;
}

async function discoverSportsDataIoLiveCapability({
  historicalDate,
  configuration,
  database,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now,
  abortSignalFactory = () => AbortSignal.timeout(30_000),
} = {}) {
  const normalizedConfiguration =
    normalizeConfiguration(configuration);
  if (
    typeof fetchImpl !== "function" ||
    typeof nowMs !== "function" ||
    typeof abortSignalFactory !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .configurationInvalid
    );
  }
  const capturedAtMs = safeTimestamp(
    nowMs(),
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
      .configurationInvalid
  );
  const currentEasternDate = easternCalendarDate(capturedAtMs);
  const urls = endpointUrls(historicalDate, currentEasternDate);
  const mappings = readDatabaseScope(
    database,
    normalizedConfiguration
  );
  const endpointRows = {};
  const requestedUrls = new Set();
  for (const endpointKey of ENDPOINT_KEYS) {
    const url = urls[endpointKey];
    if (
      requestedUrls.has(url) ||
      !url.startsWith(`${PROVIDER_ORIGIN}/v3/nhl/`)
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
          .internalFailed
      );
    }
    requestedUrls.add(url);
    let response;
    try {
      const signal = abortSignalFactory();
      if (
        !signal ||
        typeof signal !== "object" ||
        typeof signal.aborted !== "boolean"
      ) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
            .configurationInvalid
        );
      }
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: {
          [SUBSCRIPTION_HEADER]:
            normalizedConfiguration.dedicatedLiveApiKey,
        },
        signal,
      });
    } catch (error) {
      if (error instanceof SportsDataIoLiveCapabilityDiscoveryError) {
        throw error;
      }
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
          .providerFailed
      );
    }
    const maximumRows =
      endpointKey === "players"
        ? MAXIMUM_ROWS.players
        : endpointKey === "freeAgents"
          ? MAXIMUM_ROWS.freeAgents
          : endpointKey === "seasonTotals"
            ? MAXIMUM_ROWS.seasonTotals
            : endpointKey.endsWith("Games")
              ? MAXIMUM_ROWS.games
              : MAXIMUM_ROWS.playerGames;
    endpointRows[endpointKey] = await readProviderRows(
      response,
      maximumRows
    );
  }
  if (requestedUrls.size !== ENDPOINT_KEYS.length) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
        .internalFailed
    );
  }
  return createCandidateResult({
    configuration: normalizedConfiguration,
    historicalDate,
    currentEasternDate,
    endpointRows,
    mappings,
    capturedAtMs,
  });
}

module.exports = {
  CONFIGURED_NHL_SEASON_KEY,
  ENDPOINT_KEYS,
  PLAYER_IDENTITY_PROVIDER,
  PROBE_NHL_SEASON_KEY,
  PROVIDER_ORIGIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES,
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_SCHEMA_VERSION,
  SportsDataIoLiveCapabilityDiscoveryError,
  discoverSportsDataIoLiveCapability,
  easternCalendarDate,
  endpointUrls,
  normalizeConfiguration,
  readDatabaseScope,
};
