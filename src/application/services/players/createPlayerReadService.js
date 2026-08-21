const {
  CANONICAL_UUID_PATTERN,
} = require("../../../domain/players/playerIdentityPolicy");

const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;
const MAXIMUM_QUERY_CODE_POINTS = 200;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const PLAYER_STATUSES = new Set(["active", "historical", "all"]);

class PlayerReadInputError extends Error {
  constructor() {
    super("The player request is invalid.");
    this.name = "PlayerReadInputError";
    this.code = "PLAYER_READ_INPUT_INVALID";
  }
}

class PlayerNotFoundError extends Error {
  constructor() {
    super("The player was not found.");
    this.name = "PlayerNotFoundError";
    this.code = "PLAYER_NOT_FOUND";
  }
}

function failInput() {
  throw new PlayerReadInputError();
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`player reads require ${description}`);
  }
}

function normalizeQuery(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || FORBIDDEN_TEXT_PATTERN.test(value)) {
    failInput();
  }
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (Array.from(normalized).length > MAXIMUM_QUERY_CODE_POINTS) {
    failInput();
  }
  return normalized;
}

function normalizeStatus(value) {
  const status = value === undefined ? "active" : value;
  if (typeof status !== "string" || !PLAYER_STATUSES.has(status)) {
    failInput();
  }
  return status;
}

function normalizeLimit(value) {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  const stringValue =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (
    typeof stringValue !== "string" ||
    !/^[1-9]\d*$/.test(stringValue)
  ) {
    failInput();
  }
  const limit = Number(stringValue);
  if (!Number.isSafeInteger(limit) || limit > MAXIMUM_PAGE_SIZE) {
    failInput();
  }
  return limit;
}

function normalizeCursor(value) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    failInput();
  }
  return value;
}

function normalizeAuctionEligibility({ auctionEligible, leagueId }) {
  if (auctionEligible === undefined && leagueId === undefined) {
    return Object.freeze({ auctionEligible: false, leagueId: null });
  }
  const enabled = auctionEligible === true || auctionEligible === "true";
  if (
    !enabled ||
    typeof leagueId !== "string" ||
    !CANONICAL_UUID_PATTERN.test(leagueId)
  ) {
    failInput();
  }
  return Object.freeze({ auctionEligible: true, leagueId });
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeProvider(row) {
  if (!row.source_provider) return null;
  return Object.freeze({
    provider: row.source_provider,
    sourcePosition: optionalString(row.source_position),
    normalizedPosition: optionalString(row.normalized_position),
    nhlTeamAbbreviation: optionalString(row.nhl_team_abbreviation),
    active: row.source_active === 1,
    sourceVersion: row.source_version,
    effectiveAtMs: row.source_effective_at_ms,
  });
}

function safeStatistics(row) {
  if (!row.statistics_nhl_season_key) return null;
  return Object.freeze({
    provider: row.statistics_provider,
    nhlSeasonKey: row.statistics_nhl_season_key,
    gamesPlayed: row.statistics_games_played,
    goals: row.statistics_goals,
    assists: row.statistics_assists,
    nhlPoints: row.statistics_nhl_points,
    fantasyPointsHundredths: row.statistics_fantasy_points_hundredths,
    sourceUpdatedAtMs: row.statistics_source_updated_at_ms,
  });
}

function safePlayer(row) {
  return Object.freeze({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name,
    birthDate: row.birth_date ?? null,
    status: row.status,
    provider: safeProvider(row),
    statistics: safeStatistics(row),
    version: row.version,
  });
}

function safeExternalId(row) {
  return Object.freeze({
    provider: row.provider,
    externalValue: row.external_value,
    createdAtMs: row.created_at_ms,
  });
}

function createPlayerReadService({
  activeUserAuthorization,
  repository,
} = {}) {
  assertMethod(
    activeUserAuthorization,
    "requireActiveUser",
    "active-user authorization"
  );
  assertMethod(
    activeUserAuthorization,
    "requireActiveMembership",
    "active league-membership authorization"
  );
  for (const method of [
    "findDetailById",
    "findPageCursor",
    "listExternalIds",
    "listPage",
  ]) {
    assertMethod(repository, method, "a player repository");
  }

  function authorize(authenticated) {
    return activeUserAuthorization.requireActiveUser(authenticated);
  }

  function list({
    authenticated,
    query,
    status,
    limit,
    cursor,
    leagueId,
    auctionEligible,
  } = {}) {
    const eligibility = normalizeAuctionEligibility({
      auctionEligible,
      leagueId,
    });
    if (eligibility.auctionEligible) {
      activeUserAuthorization.requireActiveMembership(
        authenticated,
        eligibility.leagueId
      );
    } else {
      authorize(authenticated);
    }
    const canonicalQuery = normalizeQuery(query);
    const canonicalStatus = normalizeStatus(status);
    const pageSize = normalizeLimit(limit);
    const cursorId = normalizeCursor(cursor);
    const cursorRow =
      cursorId === null ? null : repository.findPageCursor(cursorId);
    if (!cursorRow) {
      if (cursorId !== null) failInput();
    } else if (
      canonicalStatus !== "all" &&
      cursorRow.status !== canonicalStatus
    ) {
      failInput();
    }
    const rows = repository.listPage({
      query: canonicalQuery,
      status: canonicalStatus,
      limit: pageSize + 1,
      cursorName: cursorRow?.sort_name || null,
      cursorId: cursorRow?.id || null,
      cursorFantasyPoints: null,
      leagueId: eligibility.leagueId,
      ownershipTeamId: null,
      providerPosition: null,
      providerActive: null,
      nhlTeam: null,
      ownershipFilter: "all",
      minimumGames: 0,
      auctionEligible: eligibility.auctionEligible,
      sort: "name",
    });
    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    return Object.freeze({
      players: Object.freeze(pageRows.map(safePlayer)),
      page: Object.freeze({
        nextCursor:
          hasMore && pageRows.length > 0
            ? pageRows[pageRows.length - 1].id
            : null,
        hasMore,
      }),
    });
  }

  function read({ authenticated, playerId } = {}) {
    authorize(authenticated);
    if (
      typeof playerId !== "string" ||
      !CANONICAL_UUID_PATTERN.test(playerId)
    ) {
      failInput();
    }
    const row = repository.findDetailById(playerId);
    if (!row) throw new PlayerNotFoundError();
    return Object.freeze({
      ...safePlayer(row),
      externalIds: Object.freeze(
        repository.listExternalIds(playerId).map(safeExternalId)
      ),
    });
  }

  return Object.freeze({ list, read });
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAXIMUM_PAGE_SIZE,
  MAXIMUM_QUERY_CODE_POINTS,
  PlayerNotFoundError,
  PlayerReadInputError,
  createPlayerReadService,
  normalizeCursor,
  normalizeAuctionEligibility,
  normalizeLimit,
  normalizeQuery,
  normalizeStatus,
  safePlayer,
};
