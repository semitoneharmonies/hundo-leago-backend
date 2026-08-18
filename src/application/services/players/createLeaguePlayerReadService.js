const {
  CANONICAL_UUID_PATTERN,
} = require("../../../domain/players/playerIdentityPolicy");
const {
  PlayerNotFoundError,
  PlayerReadInputError,
  normalizeCursor,
  normalizeLimit,
  normalizeQuery,
  normalizeStatus,
  safePlayer,
} = require("./createPlayerReadService");

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league player reads require ${description}`);
  }
}

function failInput() {
  throw new PlayerReadInputError();
}

function normalizeSort(value) {
  if (value === undefined || value === "name") return "name";
  if (value === "fantasyPoints") return value;
  failInput();
}

function normalizeTeamId(value) {
  if (value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    failInput();
  }
  return value;
}

function safeExternalId(row) {
  return Object.freeze({
    provider: row.provider,
    externalValue: row.external_value,
    createdAtMs: row.created_at_ms,
  });
}

function safeLeagueContext(row, leagueId) {
  if (!row || row.player_id === undefined) {
    throw new Error("The league-player projection is incomplete.");
  }
  return Object.freeze({
    id: leagueId,
    ownership:
      row.ownership_id === null
        ? null
        : Object.freeze({
          kind: row.ownership_kind,
          category: row.roster_category,
          team: Object.freeze({
            id: row.team_id,
            name: row.team_name,
          }),
        }),
    activeContract:
      row.contract_id === null
        ? null
        : Object.freeze({
          originalTotalValueCents: row.original_total_value_cents,
          originalTermYears: row.original_term_years,
          aavCents: row.aav_cents,
          remainingYears: row.remaining_years,
        }),
  });
}

function createLeaguePlayerReadService({
  leagueAuthorization,
  playerRepository,
  leaguePlayerRepository,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireActiveMembership",
    "active league-membership authorization"
  );
  for (const method of [
    "findDetailById",
    "findPageCursor",
    "listExternalIds",
    "listPage",
  ]) {
    assertMethod(playerRepository, method, "a global player repository");
  }
  for (const method of ["findByPlayerId", "listByPlayerIds"]) {
    assertMethod(
      leaguePlayerRepository,
      method,
      "a league-player read repository"
    );
  }

  function authorize(authenticated, leagueId) {
    return leagueAuthorization.requireActiveMembership(
      authenticated,
      leagueId
    );
  }

  function list({
    authenticated,
    leagueId,
    query,
    status,
    limit,
    cursor,
    sort,
    teamId,
  } = {}) {
    const authority = authorize(authenticated, leagueId);
    const canonicalQuery = normalizeQuery(query);
    const canonicalStatus = normalizeStatus(status);
    const canonicalSort = normalizeSort(sort);
    const canonicalTeamId = normalizeTeamId(teamId);
    const pageSize = normalizeLimit(limit);
    const cursorId = normalizeCursor(cursor);
    const cursorRow =
      cursorId === null ? null : playerRepository.findPageCursor(cursorId);
    if (!cursorRow) {
      if (cursorId !== null) failInput();
    } else if (
      canonicalStatus !== "all" &&
      cursorRow.status !== canonicalStatus
    ) {
      failInput();
    }
    const rows = playerRepository.listPage({
      query: canonicalQuery,
      status: canonicalStatus,
      limit: pageSize + 1,
      cursorName: cursorRow?.sort_name || null,
      cursorId: cursorRow?.id || null,
      cursorFantasyPoints:
        canonicalSort === "fantasyPoints" && cursorRow
          ? cursorRow.sort_fantasy_points_hundredths
          : null,
      leagueId: canonicalTeamId === null ? null : authority.leagueId,
      teamId: canonicalTeamId,
      auctionEligible: false,
      sort: canonicalSort,
    });
    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const leagueRows = leaguePlayerRepository.listByPlayerIds({
      leagueId: authority.leagueId,
      playerIds: pageRows.map(({ id }) => id),
    });
    const leagueByPlayerId = new Map(
      leagueRows.map((row) => [row.player_id, row])
    );
    return Object.freeze({
      players: Object.freeze(
        pageRows.map((row) =>
          Object.freeze({
            ...safePlayer(row),
            league: safeLeagueContext(
              leagueByPlayerId.get(row.id),
              authority.leagueId
            ),
          })
        )
      ),
      page: Object.freeze({
        nextCursor:
          hasMore && pageRows.length > 0
            ? pageRows[pageRows.length - 1].id
            : null,
        hasMore,
      }),
    });
  }

  function read({ authenticated, leagueId, playerId } = {}) {
    const authority = authorize(authenticated, leagueId);
    if (
      typeof playerId !== "string" ||
      !CANONICAL_UUID_PATTERN.test(playerId)
    ) {
      failInput();
    }
    const row = playerRepository.findDetailById(playerId);
    if (!row) throw new PlayerNotFoundError();
    const leagueRow = leaguePlayerRepository.findByPlayerId({
      leagueId: authority.leagueId,
      playerId,
    });
    return Object.freeze({
      ...safePlayer(row),
      externalIds: Object.freeze(
        playerRepository.listExternalIds(playerId).map(safeExternalId)
      ),
      league: safeLeagueContext(leagueRow, authority.leagueId),
    });
  }

  return Object.freeze({ list, read });
}

module.exports = {
  createLeaguePlayerReadService,
  normalizeSort,
  normalizeTeamId,
  safeLeagueContext,
};
