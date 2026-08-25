const {
  sha256Hex,
} = require("../../domain/shared/sha256");

const DEFAULT_ORIGIN = "https://api.sportsdata.io";
const PROVIDER_NAME = "sportsdataio-live";
const SUBSCRIPTION_HEADER = "Ocp-Apim-Subscription-Key";
const EASTERN_TIME_ZONE = "America/New_York";
const DEFAULT_DATE_LOOKBACK_DAYS = 7;
const MAX_DATE_LOOKBACK_DAYS = 7;
const MINIMUM_CURRENT_SEASON_PLAYER_COUNT = 700;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROVIDER_EASTERN_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u;

const GAME_STATE_BY_PROVIDER_STATUS = Object.freeze({
  Scheduled: "scheduled",
  Pregame: "pre_game",
  PreGame: "pre_game",
  InProgress: "in_progress",
  Intermission: "intermission",
  Final: "final",
  "F/SO": "final",
  "F/OT": "final",
  "Final/SO": "final",
  "Final/OT": "final",
  Postponed: "postponed",
  Canceled: "cancelled",
  Cancelled: "cancelled",
  NotNecessary: "cancelled",
});
const NON_DUE_GAME_STATES = new Set([
  "postponed",
  "cancelled",
]);

class SportsDataIoLiveNhlAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SportsDataIoLiveNhlAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SportsDataIoLiveNhlAdapterError(code, message);
}

function apiKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(
      "SPORTSDATAIO_LIVE_API_KEY_REQUIRED",
      "SportsDataIO live NHL data requires a server-side API key."
    );
  }
  return value;
}

function canonicalOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "SPORTSDATAIO_LIVE_ORIGIN_INVALID",
      "SportsDataIO live NHL data requires the canonical HTTPS origin."
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== DEFAULT_ORIGIN ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(
      "SPORTSDATAIO_LIVE_ORIGIN_INVALID",
      "SportsDataIO live NHL data requires the canonical HTTPS origin."
    );
  }
  return parsed.origin;
}

function safeNow(nowMs) {
  const value = nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("SportsDataIO live NHL clock returned an invalid time.");
  }
  return value;
}

function canonicalSeason(value) {
  if (
    typeof value !== "string" ||
    !/^(\d{4})(\d{4})$/.test(value)
  ) {
    fail(
      "SPORTSDATAIO_LIVE_SEASON_INVALID",
      "SportsDataIO live NHL data requires a canonical NHL season key."
    );
  }
  const start = Number(value.slice(0, 4));
  const end = Number(value.slice(4));
  if (end !== start + 1) {
    fail(
      "SPORTSDATAIO_LIVE_SEASON_INVALID",
      "SportsDataIO live NHL data requires consecutive season years."
    );
  }
  return Object.freeze({
    nhlSeasonKey: value,
    providerSeason: end,
    apiSeason: `${end}REG`,
  });
}

function positiveExternalId(value, description) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    fail(
      "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      `SportsDataIO returned an invalid ${description}.`
    );
  }
  return String(normalized);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function canonicalRequirementsSha256(value) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value)
  ) {
    fail(
      "SPORTSDATAIO_LIVE_REQUIREMENTS_SHA256_INVALID",
      "SportsDataIO live NHL data requires a canonical requirements digest."
    );
  }
  return value;
}

function normalizeRequiredPlayers(requiredPlayers) {
  if (!Array.isArray(requiredPlayers)) {
    fail(
      "SPORTSDATAIO_LIVE_REQUIRED_PLAYERS_INVALID",
      "SportsDataIO live NHL data requires an exact player scope."
    );
  }
  const normalized = requiredPlayers.map((player) => {
    if (
      !player ||
      typeof player !== "object" ||
      Array.isArray(player) ||
      !exactKeys(player, ["playerId", "providerPlayerId"]) ||
      typeof player.playerId !== "string" ||
      !UUID_PATTERN.test(player.playerId) ||
      typeof player.providerPlayerId !== "string" ||
      !/^[1-9]\d{0,15}$/u.test(player.providerPlayerId) ||
      !Number.isSafeInteger(Number(player.providerPlayerId))
    ) {
      fail(
        "SPORTSDATAIO_LIVE_REQUIRED_PLAYERS_INVALID",
        "SportsDataIO live NHL data received an invalid player scope."
      );
    }
    return Object.freeze({
      playerId: player.playerId,
      providerPlayerId: player.providerPlayerId,
    });
  });
  const expectedOrder = [...normalized].sort((left, right) =>
    compareText(left.playerId, right.playerId) ||
    compareText(left.providerPlayerId, right.providerPlayerId)
  );
  const playerIds = new Set();
  const providerPlayerIds = new Set();
  for (let index = 0; index < normalized.length; index += 1) {
    const player = normalized[index];
    if (
      playerIds.has(player.playerId) ||
      providerPlayerIds.has(player.providerPlayerId) ||
      player.playerId !== expectedOrder[index].playerId ||
      player.providerPlayerId !==
        expectedOrder[index].providerPlayerId
    ) {
      fail(
        "SPORTSDATAIO_LIVE_REQUIRED_PLAYERS_INVALID",
        "SportsDataIO live NHL player scope must be unique and sorted."
      );
    }
    playerIds.add(player.playerId);
    providerPlayerIds.add(player.providerPlayerId);
  }
  return Object.freeze(normalized);
}

function compareRequiredPlayerGames(left, right) {
  return (
    compareText(left.playerId, right.playerId) ||
    compareText(left.nhlGameId, right.nhlGameId) ||
    (
      left.nhlGameScheduledStartsAtMs ===
        right.nhlGameScheduledStartsAtMs
        ? 0
        : left.nhlGameScheduledStartsAtMs <
            right.nhlGameScheduledStartsAtMs
          ? -1
          : 1
    ) ||
    compareText(
      left.providerPlayerId,
      right.providerPlayerId
    ) ||
    compareText(left.providerTeamId, right.providerTeamId)
  );
}

function canonicalRequiredExternalId(value) {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

function normalizeRequiredPlayerGames(
  requiredPlayerGames,
  requiredPlayers
) {
  const code =
    "SPORTSDATAIO_LIVE_REQUIRED_PLAYER_GAMES_INVALID";
  if (!Array.isArray(requiredPlayerGames)) {
    fail(
      code,
      "SportsDataIO live NHL data requires an exact historical player-game scope."
    );
  }
  const normalized = requiredPlayerGames.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      !exactKeys(candidate, [
        "playerId",
        "providerPlayerId",
        "providerTeamId",
        "nhlGameId",
        "nhlGameScheduledStartsAtMs",
      ]) ||
      typeof candidate.playerId !== "string" ||
      !UUID_PATTERN.test(candidate.playerId) ||
      !canonicalRequiredExternalId(
        candidate.providerPlayerId
      ) ||
      !canonicalRequiredExternalId(candidate.providerTeamId) ||
      !canonicalRequiredExternalId(candidate.nhlGameId) ||
      !Number.isSafeInteger(
        candidate.nhlGameScheduledStartsAtMs
      ) ||
      candidate.nhlGameScheduledStartsAtMs < 0 ||
      candidate.nhlGameScheduledStartsAtMs > MAX_TIMESTAMP_MS
    ) {
      fail(
        code,
        "SportsDataIO live NHL data received an invalid historical player-game scope."
      );
    }
    return Object.freeze({
      playerId: candidate.playerId,
      providerPlayerId: candidate.providerPlayerId,
      providerTeamId: candidate.providerTeamId,
      nhlGameId: candidate.nhlGameId,
      nhlGameScheduledStartsAtMs:
        candidate.nhlGameScheduledStartsAtMs,
    });
  });
  const expectedOrder = [...normalized].sort(
    compareRequiredPlayerGames
  );
  const requiredByPlayerId = new Map(
    requiredPlayers.map((player) => [player.playerId, player])
  );
  const identities = new Set();
  for (let index = 0; index < normalized.length; index += 1) {
    const game = normalized[index];
    const parent = requiredByPlayerId.get(game.playerId);
    const identity = `${game.playerId}\u0000${game.nhlGameId}`;
    if (
      compareRequiredPlayerGames(
        game,
        expectedOrder[index]
      ) !== 0 ||
      !parent ||
      parent.providerPlayerId !== game.providerPlayerId ||
      identities.has(identity)
    ) {
      fail(
        code,
        "SportsDataIO live NHL historical player-game scope must be sorted, unique, and parent-bound."
      );
    }
    identities.add(identity);
  }
  return Object.freeze(normalized);
}

function nonnegativeInteger(value, description, { nullableZero = false } = {}) {
  const normalized =
    nullableZero && (value === null || value === undefined)
      ? 0
      : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail(
      "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      `SportsDataIO returned invalid ${description}.`
    );
  }
  return normalized;
}

function utcTimestamp(value, description) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u.test(value)
  ) {
    fail(
      "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      `SportsDataIO returned an invalid ${description}.`
    );
  }
  const parsed = Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      ? value
      : `${value}Z`
  );
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(
      "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      `SportsDataIO returned an invalid ${description}.`
    );
  }
  return parsed;
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

function providerEasternTimestamp(value, description) {
  const match =
    typeof value === "string"
      ? PROVIDER_EASTERN_TIMESTAMP_PATTERN.exec(value)
      : null;
  if (!match) {
    fail(
      "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      `SportsDataIO returned an invalid ${description}.`
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
  const easternWallClockAsUtcMs = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
    expected.second,
    expected.millisecond
  );
  const calendar = new Date(easternWallClockAsUtcMs);
  if (
    expected.year < 1970 ||
    !Number.isSafeInteger(easternWallClockAsUtcMs) ||
    calendar.getUTCFullYear() !== expected.year ||
    calendar.getUTCMonth() !== expected.month - 1 ||
    calendar.getUTCDate() !== expected.day ||
    calendar.getUTCHours() !== expected.hour ||
    calendar.getUTCMinutes() !== expected.minute ||
    calendar.getUTCSeconds() !== expected.second ||
    calendar.getUTCMilliseconds() !== expected.millisecond
  ) {
    fail(
      "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      `SportsDataIO returned an invalid ${description}.`
    );
  }

  const possibleOffsets = new Set();
  for (const sampleDeltaMs of [-DAY_MS, 0, DAY_MS]) {
    const sampleMs = easternWallClockAsUtcMs + sampleDeltaMs;
    const sampleParts = easternTimestampParts(sampleMs);
    possibleOffsets.add(
      Date.UTC(
        sampleParts.year,
        sampleParts.month - 1,
        sampleParts.day,
        sampleParts.hour,
        sampleParts.minute,
        sampleParts.second,
        sampleParts.millisecond
      ) - sampleMs
    );
  }
  const candidates = [...possibleOffsets]
    .map((offsetMs) => easternWallClockAsUtcMs - offsetMs)
    .filter((candidateMs) =>
      Number.isSafeInteger(candidateMs) &&
      candidateMs >= 0 &&
      sameTimestampParts(
        easternTimestampParts(candidateMs),
        expected
      )
    );
  if (candidates.length !== 1) {
    fail(
      "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      `SportsDataIO returned an invalid ${description}.`
    );
  }
  return candidates[0];
}

function providerGameState(value) {
  const state = GAME_STATE_BY_PROVIDER_STATUS[value];
  if (!state) {
    fail(
      "SPORTSDATAIO_LIVE_GAME_STATE_UNSUPPORTED",
      "SportsDataIO returned an unsupported NHL game state."
    );
  }
  return state;
}

function assertSeason(row, season) {
  if (
    row.Season !== null &&
    row.Season !== undefined &&
    Number(row.Season) !== season.providerSeason
  ) {
    fail(
      "SPORTSDATAIO_LIVE_SEASON_MISMATCH",
      "SportsDataIO returned data for a different NHL season."
    );
  }
  if (
    row.SeasonType !== null &&
    row.SeasonType !== undefined &&
    Number(row.SeasonType) !== 1
  ) {
    fail(
      "SPORTSDATAIO_LIVE_SEASON_MISMATCH",
      "SportsDataIO returned non-regular-season NHL data."
    );
  }
}

function easternCalendarDate(timestampMs) {
  const values = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarDatesEndingAt(timestampMs, lookbackDays) {
  const current = easternCalendarDate(timestampMs);
  const [year, month, day] = current.split("-").map(Number);
  const anchor = Date.UTC(year, month - 1, day);
  return Object.freeze(
    Array.from(
      { length: lookbackDays + 1 },
      (_, index) => {
        const date = new Date(
          anchor - (lookbackDays - index) * DAY_MS
        );
        return [
          date.getUTCFullYear(),
          String(date.getUTCMonth() + 1).padStart(2, "0"),
          String(date.getUTCDate()).padStart(2, "0"),
        ].join("-");
      }
    )
  );
}

function stableSourceVersion(payload) {
  return `sportsdataio-live-sha256-${sha256Hex(JSON.stringify(payload))}`;
}

function createSportsDataIoLiveNhlAdapter({
  apiKey: configuredApiKey,
  fetchImpl = fetch,
  origin = DEFAULT_ORIGIN,
  nowMs = () => Date.now(),
  dateLookbackDays = DEFAULT_DATE_LOOKBACK_DAYS,
} = {}) {
  const key = apiKey(configuredApiKey);
  const apiOrigin = canonicalOrigin(origin);
  if (typeof fetchImpl !== "function" || typeof nowMs !== "function") {
    throw new TypeError(
      "SportsDataIO live NHL data requires fetch and clock boundaries."
    );
  }
  if (
    !Number.isSafeInteger(dateLookbackDays) ||
    dateLookbackDays < 0 ||
    dateLookbackDays > MAX_DATE_LOOKBACK_DAYS
  ) {
    throw new TypeError(
      "SportsDataIO live NHL date lookback must be between zero and seven days."
    );
  }

  function seasonTotalsUrl(apiSeason) {
    return `${apiOrigin}/v3/nhl/stats/json/PlayerSeasonStats/${apiSeason}`;
  }

  function gamesByDateUrl(date) {
    return `${apiOrigin}/v3/nhl/scores/json/GamesByDate/${date}`;
  }

  function playerGamesByDateUrl(date) {
    return `${apiOrigin}/v3/nhl/stats/json/PlayerGameStatsByDate/${date}`;
  }

  function playersUrl() {
    return `${apiOrigin}/v3/nhl/scores/json/Players`;
  }

  function freeAgentsUrl() {
    return `${apiOrigin}/v3/nhl/scores/json/FreeAgents`;
  }

  async function fetchRows(url) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: Object.freeze({
          [SUBSCRIPTION_HEADER]: key,
        }),
      });
    } catch {
      fail(
        "SPORTSDATAIO_LIVE_REQUEST_FAILED",
        "SportsDataIO live NHL data could not reach the provider."
      );
    }
    if (!response?.ok) {
      fail(
        "SPORTSDATAIO_LIVE_REQUEST_FAILED",
        "SportsDataIO live NHL data was rejected by the provider."
      );
    }
    let body;
    try {
      body = await response.json();
    } catch {
      fail(
        "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
        "SportsDataIO live NHL data returned invalid JSON."
      );
    }
    if (!Array.isArray(body)) {
      fail(
        "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
        "SportsDataIO live NHL data returned an unexpected response shape."
      );
    }
    return body;
  }

  function normalizeGame(row, season) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      fail(
        "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
        "SportsDataIO returned an invalid NHL game."
      );
    }
    assertSeason(row, season);
    const homeTeamId = positiveExternalId(
      row.HomeTeamID,
      "home-team identifier"
    );
    const awayTeamId = positiveExternalId(
      row.AwayTeamID,
      "away-team identifier"
    );
    if (homeTeamId === awayTeamId) {
      fail(
        "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
        "SportsDataIO returned an NHL game with duplicate teams."
      );
    }
    return Object.freeze({
      nhlGameId: positiveExternalId(row.GameID, "NHL game identifier"),
      nhlGameScheduledStartsAtMs: utcTimestamp(
        row.DateTimeUTC,
        "NHL game UTC start"
      ),
      observedGameState: providerGameState(row.Status),
      homeTeamId,
      awayTeamId,
    });
  }

  function publicGame(game) {
    return Object.freeze({
      nhlGameId: game.nhlGameId,
      nhlGameScheduledStartsAtMs:
        game.nhlGameScheduledStartsAtMs,
      observedGameState: game.observedGameState,
    });
  }

  function publicCoverageGame(game, providerTeamId) {
    return Object.freeze({
      providerTeamId,
      nhlGameId: game.nhlGameId,
      nhlGameScheduledStartsAtMs:
        game.nhlGameScheduledStartsAtMs,
      observedGameState: game.observedGameState,
    });
  }

  function normalizeGames(rowsByDate, season) {
    const games = new Map();
    for (const rows of rowsByDate) {
      for (const row of rows) {
        const game = normalizeGame(row, season);
        const existing = games.get(game.nhlGameId);
        if (
          existing &&
          (
            existing.nhlGameScheduledStartsAtMs !==
              game.nhlGameScheduledStartsAtMs ||
            existing.observedGameState !== game.observedGameState ||
            existing.homeTeamId !== game.homeTeamId ||
            existing.awayTeamId !== game.awayTeamId
          )
        ) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
            "SportsDataIO returned conflicting NHL game records."
          );
        }
        games.set(game.nhlGameId, game);
      }
    }
    return games;
  }

  function normalizeTotals(rows, season) {
    const seen = new Set();
    const totals = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
          "SportsDataIO returned an invalid player-season row."
        );
      }
      assertSeason(row, season);
      const playerId = positiveExternalId(
        row.PlayerID,
        "player identifier"
      );
      if (seen.has(playerId)) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
          "SportsDataIO returned duplicate player-season rows."
        );
      }
      seen.add(playerId);
      return Object.freeze({
        playerId,
        gamesPlayed: nonnegativeInteger(
          row.Games,
          "season games",
          { nullableZero: true }
        ),
        goals: nonnegativeInteger(
          row.Goals,
          "season goals",
          { nullableZero: true }
        ),
        assists: nonnegativeInteger(
          row.Assists,
          "season assists",
          { nullableZero: true }
        ),
      });
    });
    totals.sort((left, right) =>
      compareText(left.playerId, right.playerId)
    );
    return Object.freeze(totals);
  }

  function normalizeMembershipRows(rows, membershipKind) {
    const memberships = rows.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        !Object.hasOwn(row, "PlayerID") ||
        !Object.hasOwn(row, "TeamID")
      ) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
          "SportsDataIO returned invalid player membership."
        );
      }
      const providerPlayerId = positiveExternalId(
        row.PlayerID,
        "membership player identifier"
      );
      if (membershipKind === "free_agent") {
        if (row.TeamID !== null) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
            "SportsDataIO returned a free agent with team membership."
          );
        }
        return Object.freeze({
          providerPlayerId,
          providerTeamId: null,
          membershipKind,
        });
      }
      if (row.TeamID === null) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
          "SportsDataIO returned an active player without a team."
        );
      }
      return Object.freeze({
        providerPlayerId,
        providerTeamId: positiveExternalId(
          row.TeamID,
          "membership team identifier"
        ),
        membershipKind,
      });
    });
    memberships.sort((left, right) =>
      compareText(
        left.providerPlayerId,
        right.providerPlayerId
      )
    );
    const seen = new Set();
    for (const membership of memberships) {
      if (seen.has(membership.providerPlayerId)) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
          "SportsDataIO returned duplicate player membership."
        );
      }
      seen.add(membership.providerPlayerId);
    }
    return Object.freeze(memberships);
  }

  function normalizeMembership(activeRows, freeAgentRows) {
    const active = normalizeMembershipRows(
      activeRows,
      "active"
    );
    const freeAgents = normalizeMembershipRows(
      freeAgentRows,
      "free_agent"
    );
    const byProviderPlayerId = new Map();
    for (const membership of [...active, ...freeAgents]) {
      if (byProviderPlayerId.has(membership.providerPlayerId)) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
          "SportsDataIO returned conflicting player membership."
        );
      }
      byProviderPlayerId.set(
        membership.providerPlayerId,
        membership
      );
    }
    return Object.freeze({
      active,
      freeAgents,
      byProviderPlayerId,
    });
  }

  function normalizePlayerGames(
    rowsByDate,
    games,
    season,
    capturedAtMs
  ) {
    const seen = new Set();
    const observations = [];
    for (const rows of rowsByDate) {
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
            "SportsDataIO returned an invalid player-game row."
          );
        }
        assertSeason(row, season);
        const playerId = positiveExternalId(
          row.PlayerID,
          "player identifier"
        );
        const nhlGameId = positiveExternalId(
          row.GameID,
          "NHL game identifier"
        );
        const game = games.get(nhlGameId);
        if (!game) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
            "A SportsDataIO player-game row has no matching game-state record."
          );
        }
        const providerTeamId =
          row.TeamID === null
            ? null
            : positiveExternalId(
              row.TeamID,
              "player-game team identifier"
            );
        const providerGames = nonnegativeInteger(
          row.Games,
          "player-game games"
        );
        if (providerGames !== 0 && providerGames !== 1) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
            "SportsDataIO returned a player-game Games value outside zero or one."
          );
        }
        const identity = `${playerId}\u0000${nhlGameId}`;
        if (seen.has(identity)) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
            "SportsDataIO returned duplicate player-game rows."
          );
        }
        seen.add(identity);
        const sourceUpdatedAtMs = providerEasternTimestamp(
          row.Updated,
          "player-game source update"
        );
        if (sourceUpdatedAtMs > capturedAtMs) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
            "SportsDataIO returned a player-game source update after snapshot capture."
          );
        }
        observations.push(Object.freeze({
          playerId,
          providerTeamId,
          nhlGameId,
          nhlGameScheduledStartsAtMs:
            game.nhlGameScheduledStartsAtMs,
          observedGameState: game.observedGameState,
          providerGames,
          goals: nonnegativeInteger(
            row.Goals,
            "player-game goals"
          ),
          assists: nonnegativeInteger(
            row.Assists,
            "player-game assists"
          ),
          sourceUpdatedAtMs,
        }));
      }
    }
    observations.sort((left, right) =>
      compareText(left.playerId, right.playerId) ||
      compareText(left.nhlGameId, right.nhlGameId)
    );
    return Object.freeze(observations);
  }

  function publicPlayerGame(row) {
    return Object.freeze({
      playerId: row.playerId,
      nhlGameId: row.nhlGameId,
      nhlGameScheduledStartsAtMs:
        row.nhlGameScheduledStartsAtMs,
      observedGameState: row.observedGameState,
      goals: row.goals,
      assists: row.assists,
      sourceUpdatedAtMs: row.sourceUpdatedAtMs,
    });
  }

  function buildPlayerGameCoverage({
    requiredPlayers,
    requiredPlayerGames,
    membership,
    games,
    gamesByDate,
    currentGames,
    playerGames,
    playerGamesByDate,
    throughAtMs,
  }) {
    const observationsByIdentity = new Map(
      playerGames.map((row) => [
        `${row.playerId}\u0000${row.nhlGameId}`,
        row,
      ])
    );
    const schedule = [...games.values()].sort((left, right) =>
      compareText(left.nhlGameId, right.nhlGameId)
    );
    const currentSchedule = [...currentGames.values()].sort(
      (left, right) =>
        compareText(left.nhlGameId, right.nhlGameId)
    );
    const historicalGamesByPlayerId = new Map();
    for (const binding of requiredPlayerGames) {
      const targetDate = easternCalendarDate(
        binding.nhlGameScheduledStartsAtMs
      );
      const game = gamesByDate
        .get(targetDate)
        ?.get(binding.nhlGameId);
      if (!game) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
          "SportsDataIO omitted a required historical NHL game."
        );
      }
      if (
        game.nhlGameScheduledStartsAtMs !==
          binding.nhlGameScheduledStartsAtMs ||
        (
          game.homeTeamId !== binding.providerTeamId &&
          game.awayTeamId !== binding.providerTeamId
        )
      ) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
          "SportsDataIO historical schedule evidence conflicts with the required game binding."
        );
      }
      const observation = playerGamesByDate
        .get(targetDate)
        ?.get(
          `${binding.providerPlayerId}\u0000${binding.nhlGameId}`
        );
      if (!observation) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
          "SportsDataIO omitted a required historical player-game row."
        );
      }
      if (observation.providerTeamId !== binding.providerTeamId) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
          "SportsDataIO historical player-game team conflicts with the required binding."
        );
      }
      const bindings =
        historicalGamesByPlayerId.get(binding.playerId) || [];
      bindings.push(
        publicCoverageGame(game, binding.providerTeamId)
      );
      historicalGamesByPlayerId.set(binding.playerId, bindings);
    }
    const selectedPlayerGames = [];
    const coveragePlayers = requiredPlayers.map((required) => {
      const providerMembership =
        membership.byProviderPlayerId.get(
          required.providerPlayerId
        );
      if (!providerMembership) {
        fail(
          "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
          "SportsDataIO did not affirm every required player membership."
        );
      }
      const historicalGames =
        historicalGamesByPlayerId.get(required.playerId) || [];
      const currentDueGames =
        providerMembership.membershipKind === "free_agent"
          ? []
          : currentSchedule
            .filter((game) =>
              game.nhlGameScheduledStartsAtMs <= throughAtMs &&
              !NON_DUE_GAME_STATES.has(
                game.observedGameState
              ) &&
              (
                game.homeTeamId ===
                  providerMembership.providerTeamId ||
                game.awayTeamId ===
                  providerMembership.providerTeamId
              )
            )
            .map((game) =>
              publicCoverageGame(
                game,
                providerMembership.providerTeamId
              )
            );
      const mergedByGameId = new Map();
      for (const game of [
        ...historicalGames,
        ...currentDueGames,
      ]) {
        const existing = mergedByGameId.get(game.nhlGameId);
        if (
          existing &&
          (
            existing.providerTeamId !== game.providerTeamId ||
            existing.nhlGameScheduledStartsAtMs !==
              game.nhlGameScheduledStartsAtMs
          )
        ) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
            "SportsDataIO current and historical game requirements conflict."
          );
        }
        mergedByGameId.set(game.nhlGameId, game);
      }
      const dueGames = [...mergedByGameId.values()].sort(
        (left, right) =>
          compareText(left.nhlGameId, right.nhlGameId)
      );
      if (dueGames.length === 0) {
        return Object.freeze({
          playerId: required.playerId,
          providerPlayerId: required.providerPlayerId,
          providerTeamId: providerMembership.providerTeamId,
          disposition:
            providerMembership.membershipKind === "free_agent"
              ? "no_team"
              : "no_due_game",
          games: Object.freeze([]),
        });
      }

      for (const game of dueGames) {
        const observation = observationsByIdentity.get(
          `${required.providerPlayerId}\u0000${game.nhlGameId}`
        );
        if (!observation) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
            "SportsDataIO omitted a required due player-game row."
          );
        }
        if (
          observation.providerTeamId !== game.providerTeamId
        ) {
          fail(
            "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
            "SportsDataIO player-game membership does not match the expected game."
          );
        }
        selectedPlayerGames.push(publicPlayerGame(observation));
      }
      return Object.freeze({
        playerId: required.playerId,
        providerPlayerId: required.providerPlayerId,
        providerTeamId: providerMembership.providerTeamId,
        disposition: "expected_game",
        games: Object.freeze(dueGames),
      });
    });

    selectedPlayerGames.sort((left, right) =>
      compareText(left.playerId, right.playerId) ||
      compareText(left.nhlGameId, right.nhlGameId)
    );
    return Object.freeze({
      playerGameCoverage: Object.freeze({
        schemaVersion: 1,
        throughAtMs,
        players: Object.freeze(coveragePlayers),
      }),
      playerGameRows: Object.freeze(selectedPlayerGames),
      schedule: Object.freeze(schedule),
    });
  }

  async function fetchLiveSnapshot({
    nhlSeasonKey,
    requiredPlayers,
    requiredPlayerGames,
    requirementsSha256,
  } = {}) {
    const season = canonicalSeason(nhlSeasonKey);
    const requirementsDigest = canonicalRequirementsSha256(
      requirementsSha256
    );
    const required = normalizeRequiredPlayers(requiredPlayers);
    const requiredGames = normalizeRequiredPlayerGames(
      requiredPlayerGames,
      required
    );
    const requestedAtMs = safeNow(nowMs);
    const rollingDates = calendarDatesEndingAt(
      requestedAtMs,
      dateLookbackDays
    );
    const dates = Object.freeze(
      [...new Set([
        ...rollingDates,
        ...requiredGames.map((game) =>
          easternCalendarDate(
            game.nhlGameScheduledStartsAtMs
          )
        ),
      ])].sort(compareText)
    );
    const [
      totalsRows,
      activePlayerRows,
      freeAgentRows,
      gamesRowsByDate,
      playerGameRowsByDate,
    ] = await Promise.all([
      fetchRows(seasonTotalsUrl(season.apiSeason)),
      fetchRows(playersUrl()),
      fetchRows(freeAgentsUrl()),
      Promise.all(
        dates.map((date) =>
          fetchRows(gamesByDateUrl(date))
        )
      ),
      Promise.all(
        dates.map((date) =>
          fetchRows(playerGamesByDateUrl(date))
        )
      ),
    ]);
    const capturedAtMs = safeNow(nowMs);
    const games = normalizeGames(gamesRowsByDate, season);
    const gamesByDate = new Map(
      dates.map((date, index) => [
        date,
        normalizeGames([gamesRowsByDate[index]], season),
      ])
    );
    const rollingDateSet = new Set(rollingDates);
    const currentGames = normalizeGames(
      gamesRowsByDate.filter((rows, index) =>
        rollingDateSet.has(dates[index])
      ),
      season
    );
    const totals = normalizeTotals(totalsRows, season);
    const membership = normalizeMembership(
      activePlayerRows,
      freeAgentRows
    );
    const playerGameSourceRows = normalizePlayerGames(
      playerGameRowsByDate,
      games,
      season,
      capturedAtMs
    );
    const playerGamesByDate = new Map(
      dates.map((date, index) => {
        const rows = normalizePlayerGames(
          [playerGameRowsByDate[index]],
          games,
          season,
          capturedAtMs
        );
        return [
          date,
          new Map(rows.map((row) => [
            `${row.playerId}\u0000${row.nhlGameId}`,
            row,
          ])),
        ];
      })
    );
    const coverage = buildPlayerGameCoverage({
      requiredPlayers: required,
      requiredPlayerGames: requiredGames,
      membership,
      games,
      gamesByDate,
      currentGames,
      playerGames: playerGameSourceRows,
      playerGamesByDate,
      throughAtMs: capturedAtMs,
    });
    const sourceVersion = stableSourceVersion({
      apiSeason: season.apiSeason,
      requirementsSha256: requirementsDigest,
      dates,
      requiredPlayers: required,
      requiredPlayerGames: requiredGames,
      totals,
      membership: {
        active: membership.active,
        freeAgents: membership.freeAgents,
      },
      playerGameCoverage: coverage.playerGameCoverage,
      schedule: coverage.schedule,
      scheduleByDate: dates.map((date) => ({
        date,
        games: [...gamesByDate.get(date).values()].sort(
          (left, right) =>
            compareText(left.nhlGameId, right.nhlGameId)
        ),
      })),
      playerGames: playerGameSourceRows,
      playerGamesByDate: dates.map((date) => ({
        date,
        playerGames: [
          ...playerGamesByDate.get(date).values(),
        ],
      })),
    });
    return Object.freeze({
      provider: PROVIDER_NAME,
      sourceVersion,
      capturedAtMs,
      totalsSourceUpdatedAtMs: capturedAtMs,
      totalsRows: totals,
      playerGameCoverage: coverage.playerGameCoverage,
      playerGameRows: coverage.playerGameRows,
    });
  }

  async function fetchGameStates({
    nhlSeasonKey,
    requestedAtMs,
    games: requestedGames,
  } = {}) {
    const season = canonicalSeason(nhlSeasonKey);
    if (
      !Number.isSafeInteger(requestedAtMs) ||
      requestedAtMs < 0 ||
      !Array.isArray(requestedGames)
    ) {
      throw new TypeError(
        "SportsDataIO game-state lookup requires a time and exact game list."
      );
    }
    const expected = new Map();
    const dates = new Set();
    for (const game of requestedGames) {
      if (
        !game ||
        typeof game.nhlGameId !== "string" ||
        game.nhlGameId.length < 1 ||
        !Number.isSafeInteger(
          game.nhlGameScheduledStartsAtMs
        ) ||
        game.nhlGameScheduledStartsAtMs < 0 ||
        expected.has(game.nhlGameId)
      ) {
        throw new TypeError(
          "SportsDataIO game-state lookup received an invalid game identity."
        );
      }
      expected.set(
        game.nhlGameId,
        game.nhlGameScheduledStartsAtMs
      );
      dates.add(
        easternCalendarDate(
          game.nhlGameScheduledStartsAtMs
        )
      );
    }
    const orderedDates = [...dates].sort();
    const rowsByDate = await Promise.all(
      orderedDates.map((date) =>
        fetchRows(gamesByDateUrl(date))
      )
    );
    const observedAtMs = safeNow(nowMs);
    const available = normalizeGames(rowsByDate, season);
    const observed = [...expected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([nhlGameId, scheduledAtMs]) => {
        const game = available.get(nhlGameId);
        if (
          !game ||
          game.nhlGameScheduledStartsAtMs !== scheduledAtMs
        ) {
          fail(
            "SPORTSDATAIO_LIVE_GAME_STATE_INCOMPLETE",
            "SportsDataIO did not return the exact requested NHL game."
          );
        }
        return publicGame(game);
      });
    const sourceVersion = stableSourceVersion({
      apiSeason: season.apiSeason,
      dates: orderedDates,
      games: observed,
    });
    return Object.freeze({
      provider: PROVIDER_NAME,
      sourceVersion,
      observedAtMs,
      games: Object.freeze(observed),
    });
  }

  return Object.freeze({
    fetchGameStates,
    fetchLiveSnapshot,
    freeAgentsUrl,
    gamesByDateUrl,
    playerGamesByDateUrl,
    playersUrl,
    seasonTotalsUrl,
  });
}

module.exports = {
  DEFAULT_DATE_LOOKBACK_DAYS,
  DEFAULT_ORIGIN,
  EASTERN_TIME_ZONE,
  GAME_STATE_BY_PROVIDER_STATUS,
  MAX_DATE_LOOKBACK_DAYS,
  MINIMUM_CURRENT_SEASON_PLAYER_COUNT,
  PROVIDER_NAME,
  SportsDataIoLiveNhlAdapterError,
  createSportsDataIoLiveNhlAdapter,
};
