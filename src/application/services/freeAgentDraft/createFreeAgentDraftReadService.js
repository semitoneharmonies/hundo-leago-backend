"use strict";

const MAXIMUM_TIMESTAMP_MS =
  8_640_000_000_000_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAXIMUM_CURSOR_CODE_POINTS = 1_024;
const MAXIMUM_SEARCH_CODE_POINTS = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;
const ALLOCATION_STATUSES = Object.freeze([
  "pending",
  "automatic_award",
  "restricted_scheduled",
  "restricted_active",
  "restricted_fallback_open",
  "restricted_resolved",
  "fallback_open_resolved",
  "no_valid_offer",
  "invalid",
  "correction_required",
]);

function invalid(message) {
  const error = new TypeError(message);
  error.code = "FAD_READ_INPUT_INVALID";
  throw error;
}

function assertMethod(
  value,
  method,
  description
) {
  if (
    !value ||
    typeof value[method] !== "function"
  ) {
    throw new TypeError(
      `FAD reads require ${description}`
    );
  }
}

function exactInput(
  input,
  requiredFields,
  optionalFieldSets = []
) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getOwnPropertySymbols(input).length !== 0
  ) {
    invalid(
      "The FAD read request is invalid."
    );
  }
  const fields = Object.keys(input).sort().join("|");
  const allowed = [
    requiredFields,
    ...optionalFieldSets.map((set) => [
      ...requiredFields,
      ...set,
    ]),
  ].some(
    (candidate) =>
      [...candidate].sort().join("|") === fields
  );
  if (!allowed) {
    invalid(
      "The FAD read request is invalid."
    );
  }
  return input;
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_V4_PATTERN.test(value)
  ) {
    invalid(
      "A canonical FAD read identifier is required."
    );
  }
  return value;
}

function containsNonWhitespaceControl(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    const isControl =
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      codePoint === 8_232 ||
      codePoint === 8_233;
    return isControl && !/\s/u.test(character);
  });
}

function exactQueryFields(query, allowed) {
  if (
    query === null ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.getOwnPropertySymbols(query).length !== 0 ||
    Object.keys(query).some(
      (field) => !allowed.includes(field)
    )
  ) {
    invalid("The FAD read query is invalid.");
  }
}

function pageLimit(value) {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  const source =
    Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (
    typeof source !== "string" ||
    !/^[1-9]\d*$/u.test(source)
  ) {
    invalid("The FAD read limit is invalid.");
  }
  const result = Number(source);
  if (
    !Number.isSafeInteger(result) ||
    result > MAXIMUM_PAGE_SIZE
  ) {
    invalid("The FAD read limit is invalid.");
  }
  return result;
}

function cursor(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Array.from(value).length >
      MAXIMUM_CURSOR_CODE_POINTS ||
    !BASE64URL_PATTERN.test(value)
  ) {
    invalid("The FAD read cursor is invalid.");
  }
  return value;
}

function searchText(value) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    containsNonWhitespaceControl(value)
  ) {
    invalid("The FAD result search is invalid.");
  }
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (
    Array.from(normalized).length >
    MAXIMUM_SEARCH_CODE_POINTS
  ) {
    invalid("The FAD result search is invalid.");
  }
  return normalized;
}

function summaryQuery(value = {}) {
  exactQueryFields(value, ["cursor", "limit"]);
  return Object.freeze({
    cursor: cursor(value.cursor),
    limit: pageLimit(value.limit),
  });
}

function allocationQuery(value = {}) {
  exactQueryFields(value, [
    "cursor",
    "limit",
    "q",
    "status",
  ]);
  const status = value.status ?? null;
  if (
    status !== null &&
    !ALLOCATION_STATUSES.includes(status)
  ) {
    invalid("The FAD allocation status is invalid.");
  }
  return Object.freeze({
    cursor: cursor(value.cursor),
    limit: pageLimit(value.limit),
    q: searchText(value.q),
    status,
  });
}

function rosterScope(command) {
  if (
    !("rosterSeasonId" in command) &&
    !("rosterTeamId" in command)
  ) {
    return Object.freeze({
      rosterSeasonId: null,
      rosterTeamId: null,
    });
  }
  if (
    command.rosterSeasonId === null &&
    command.rosterTeamId === null
  ) {
    return Object.freeze({
      rosterSeasonId: null,
      rosterTeamId: null,
    });
  }
  return Object.freeze({
    rosterSeasonId: stableId(
      command.rosterSeasonId
    ),
    rosterTeamId: stableId(
      command.rosterTeamId
    ),
  });
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAXIMUM_TIMESTAMP_MS
  ) {
    throw new TypeError(
      "FAD reads require a safe UTC timestamp."
    );
  }
  return nowMs;
}

function viewer(authority) {
  if (
    !authority ||
    !UUID_V4_PATTERN.test(
      authority.actorUserId || ""
    ) ||
    !UUID_V4_PATTERN.test(
      authority.membershipId || ""
    )
  ) {
    throw new TypeError(
      "FAD reads require canonical viewer authority."
    );
  }
  return Object.freeze({
    viewerMembershipId:
      authority.membershipId,
    viewerUserId: authority.actorUserId,
  });
}

function canonicalResult(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.then === "function"
  ) {
    throw new TypeError(
      "The canonical FAD read projection is unavailable."
    );
  }
  return result;
}

function canonicalCollection(result, limit) {
  const canonical = canonicalResult(result);
  if (
    !Array.isArray(canonical.data) ||
    canonical.data.length > limit ||
    canonical.page === null ||
    typeof canonical.page !== "object" ||
    Array.isArray(canonical.page) ||
    Object.keys(canonical).sort().join("|") !==
      "data|page" ||
    Object.keys(canonical.page).sort().join("|") !==
      "hasMore|nextCursor" ||
    typeof canonical.page.hasMore !== "boolean" ||
    (
      canonical.page.hasMore
        ? (
            canonical.data.length !== limit ||
            typeof canonical.page.nextCursor !==
              "string" ||
            canonical.page.nextCursor.length < 1
          )
        : canonical.page.nextCursor !== null
    )
  ) {
    throw new TypeError(
      "The canonical FAD read collection is unavailable."
    );
  }
  return canonical;
}

function createFreeAgentDraftReadService({
  leagueAuthorization,
  repository,
  clock,
} = {}) {
  for (const method of [
    "requireActiveMembership",
    "requireCommissioner",
  ]) {
    assertMethod(
      leagueAuthorization,
      method,
      "league authorization"
    );
  }
  for (const method of [
    "readAllocationResults",
    "readNavigation",
    "readOverview",
    "readPublishedCardHistory",
    "readPublishedCardSummaries",
    "readReadiness",
  ]) {
    assertMethod(
      repository,
      method,
      "the canonical FAD read repository"
    );
  }
  assertMethod(clock, "nowMs", "a clock");

  function navigation(input = {}) {
    const command = exactInput(
      input,
      ["authenticated", "leagueId"],
      [["rosterSeasonId", "rosterTeamId"]]
    );
    const leagueId = stableId(command.leagueId);
    const roster = rosterScope(command);
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    return canonicalResult(
      repository.readNavigation({
        leagueId,
        ...authority,
        nowMs: safeNow(clock),
        ...roster,
      })
    );
  }

  function readiness(input = {}) {
    const command = exactInput(input, [
      "authenticated",
      "leagueId",
      "seasonId",
    ]);
    const leagueId = stableId(command.leagueId);
    const seasonId = stableId(command.seasonId);
    const authority = viewer(
      leagueAuthorization.requireCommissioner(
        command.authenticated,
        leagueId
      )
    );
    return canonicalResult(
      repository.readReadiness({
        leagueId,
        seasonId,
        ...authority,
        nowMs: safeNow(clock),
      })
    );
  }

  function overview(input = {}) {
    const command = exactInput(input, [
      "authenticated",
      "fadId",
      "leagueId",
    ]);
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    return canonicalResult(
      repository.readOverview({
        leagueId,
        fadId,
        ...authority,
        nowMs: safeNow(clock),
      })
    );
  }

  function publishedCardSummaries(input = {}) {
    const command = exactInput(
      input,
      ["authenticated", "fadId", "leagueId"],
      [["query"]]
    );
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const query = summaryQuery(
      command.query || {}
    );
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    return canonicalCollection(
      repository.readPublishedCardSummaries({
        leagueId,
        fadId,
        ...authority,
        nowMs: safeNow(clock),
        query,
      }),
      query.limit
    );
  }

  function publishedCardHistory(input = {}) {
    const command = exactInput(input, [
      "authenticated",
      "fadId",
      "leagueId",
      "teamId",
    ]);
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    return canonicalResult(
      repository.readPublishedCardHistory({
        leagueId,
        fadId,
        teamId,
        ...authority,
        nowMs: safeNow(clock),
      })
    );
  }

  function allocationResults(input = {}) {
    const command = exactInput(
      input,
      ["authenticated", "fadId", "leagueId"],
      [["query"]]
    );
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const query = allocationQuery(
      command.query || {}
    );
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    return canonicalCollection(
      repository.readAllocationResults({
        leagueId,
        fadId,
        ...authority,
        nowMs: safeNow(clock),
        query,
      }),
      query.limit
    );
  }

  return Object.freeze({
    allocationResults,
    navigation,
    overview,
    publishedCardHistory,
    publishedCardSummaries,
    readiness,
  });
}

module.exports = {
  createFreeAgentDraftReadService,
};
