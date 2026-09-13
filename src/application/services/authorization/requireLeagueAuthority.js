const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class LeagueAuthorizationInputError extends Error {
  constructor() {
    super("A canonical league identifier is required.");
    this.name = "LeagueAuthorizationInputError";
    this.code = "LEAGUE_ID_INVALID";
  }
}

class LeagueVisibilityError extends Error {
  constructor() {
    super("The league was not found.");
    this.name = "LeagueVisibilityError";
    this.code = "LEAGUE_NOT_FOUND";
  }
}

class LeagueCommissionerRequiredError extends Error {
  constructor() {
    super("Current league-commissioner authority is required.");
    this.name = "LeagueCommissionerRequiredError";
    this.code = "LEAGUE_COMMISSIONER_REQUIRED";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `league authorization requires ${description}`
    );
  }
}

function validateLeagueId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new LeagueAuthorizationInputError();
  }
  return value;
}

function createLeagueAuthorizationService({
  userRepository,
  leagueAccessRepository,
  platformAuthorization,
} = {}) {
  assertMethod(userRepository, "findById", "a user repository");
  for (const method of [
    "findActiveMembership",
    "findLeagueSummary",
  ]) {
    assertMethod(
      leagueAccessRepository,
      method,
      "a league-access repository"
    );
  }
  if (platformAuthorization !== undefined) {
    assertMethod(
      platformAuthorization,
      "requireAdministrator",
      "platform-administrator authorization"
    );
  }

  function currentPlatformAdministrator(authenticated) {
    if (!platformAuthorization) return null;
    try {
      return platformAuthorization.requireAdministrator(authenticated);
    } catch (error) {
      if (error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED") return null;
      throw error;
    }
  }

  function requireActiveUser(authenticated) {
    const userId = authenticated?.user?.id;
    if (
      authenticated?.valid !== true ||
      !UUID_PATTERN.test(userId || "") ||
      authenticated?.session?.userId !== userId
    ) {
      throw new LeagueVisibilityError();
    }
    const user = userRepository.findById(userId);
    if (!user || user.id !== userId || user.status !== "active") {
      throw new LeagueVisibilityError();
    }
    return Object.freeze({
      actorUserId: user.id,
      userVersion: user.version,
    });
  }

  function requireActiveMembership(authenticated, leagueId) {
    const canonicalLeagueId = validateLeagueId(leagueId);
    const user = requireActiveUser(authenticated);
    const league = leagueAccessRepository.findLeagueSummary(
      canonicalLeagueId
    );
    const membership = leagueAccessRepository.findActiveMembership({
      leagueId: canonicalLeagueId,
      userId: user.actorUserId,
    });
    if (
      !league ||
      league.league_id !== canonicalLeagueId ||
      league.league_status === "deleted" ||
      !membership ||
      membership.league_id !== canonicalLeagueId ||
      membership.user_id !== user.actorUserId ||
      membership.status !== "active"
    ) {
      throw new LeagueVisibilityError();
    }
    return Object.freeze({
      authorized: true,
      code: "LEAGUE_MEMBERSHIP_AUTHORIZED",
      actorUserId: user.actorUserId,
      leagueId: canonicalLeagueId,
      leagueVersion: league.league_version,
      membershipId: membership.id,
      membershipVersion: membership.version,
      permissionCategory: membership.permission_category,
      userVersion: user.userVersion,
    });
  }

  function requireCommissioner(authenticated, leagueId) {
    const authority = requireActiveMembership(
      authenticated,
      leagueId
    );
    const league = leagueAccessRepository.findLeagueSummary(
      authority.leagueId
    );
    const membership = leagueAccessRepository.findActiveMembership({
      leagueId: authority.leagueId,
      userId: authority.actorUserId,
    });
    const commissionerMismatch =
      !league ||
      !membership ||
      membership.id !== authority.membershipId ||
      membership.version !== authority.membershipVersion ||
      membership.permission_category !== "commissioner" ||
      league.commissioner_membership_id !== membership.id;
    if (!commissionerMismatch) {
      return Object.freeze({
        ...authority,
        code: "LEAGUE_COMMISSIONER_AUTHORIZED",
        authority: "commissioner",
        leagueVersion: league.league_version,
        membershipVersion: membership.version,
      });
    }

    const platform = currentPlatformAdministrator(authenticated);
    if (!platform) throw new LeagueCommissionerRequiredError();
    return Object.freeze({
      ...authority,
      code: "LEAGUE_PLATFORM_ADMINISTRATOR_AUTHORIZED",
      authority: platform.authority,
      leagueVersion: league.league_version,
      membershipVersion: membership.version,
      platformRoleId: platform.roleId,
      platformRoleVersion: platform.roleVersion,
    });
  }

  return Object.freeze({
    requireActiveMembership,
    requireActiveUser,
    requireCommissioner,
  });
}

module.exports = {
  LeagueAuthorizationInputError,
  LeagueCommissionerRequiredError,
  LeagueVisibilityError,
  createLeagueAuthorizationService,
  validateLeagueId,
};
