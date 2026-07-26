const {
  validateStableId,
} = require("../../../domain/leagues/teamPolicy");

class LeagueMembershipInputError extends Error {
  constructor() {
    super("The league-membership request is invalid.");
    this.name = "LeagueMembershipInputError";
    this.code = "LEAGUE_MEMBERSHIP_INPUT_INVALID";
  }
}

class LeagueMembershipConflictError extends Error {
  constructor(code) {
    super("The league membership cannot be removed in its current state.");
    this.name = "LeagueMembershipConflictError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league membership requires ${description}`);
  }
}

function createLeagueMembershipService({
  leagueAuthorization,
  leagueAccessRepository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "commissioner authorization"
  );
  for (const method of ["endMembership", "listLeagueMemberships"]) {
    assertMethod(
      leagueAccessRepository,
      method,
      "a league-access repository"
    );
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function remove({
    authenticated,
    leagueId,
    membershipId,
    input,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const canonicalMembershipId = validateStableId(membershipId);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "confirmed,expectedVersion" ||
      input.confirmed !== true ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw new LeagueMembershipInputError();
    }
    const authority = leagueAuthorization.requireCommissioner(
      authenticated,
      canonicalLeagueId
    );
    const membership = leagueAccessRepository
      .listLeagueMemberships(canonicalLeagueId)
      .find((candidate) => candidate.membership_id === canonicalMembershipId);
    if (!membership) {
      throw new LeagueMembershipConflictError(
        "LEAGUE_MEMBERSHIP_NOT_FOUND"
      );
    }
    if (
      membership.permission_category === "commissioner" ||
      membership.membership_id === authority.membershipId
    ) {
      throw new LeagueMembershipConflictError(
        "COMMISSIONER_MEMBERSHIP_PROTECTED"
      );
    }
    if (
      !["active", "invited"].includes(membership.membership_status) ||
      membership.membership_version !== input.expectedVersion
    ) {
      throw new LeagueMembershipConflictError(
        "LEAGUE_MEMBERSHIP_STALE"
      );
    }
    const ended = leagueAccessRepository.endMembership({
      leagueId: canonicalLeagueId,
      membershipId: canonicalMembershipId,
      actorUserId: authority.actorUserId,
      activityId: secureRandom.id(),
      expectedVersion: input.expectedVersion,
      occurredAtMs: clock.nowMs(),
    });
    return Object.freeze({
      code: "LEAGUE_MEMBERSHIP_REMOVED",
      membership: Object.freeze({
        id: ended.id,
        status: ended.status,
        endedAtMs: ended.ended_at_ms,
        version: ended.version,
      }),
    });
  }

  return Object.freeze({ remove });
}

module.exports = {
  LeagueMembershipConflictError,
  LeagueMembershipInputError,
  createLeagueMembershipService,
};
