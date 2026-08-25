const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SOCKET_AUTHORIZATION_CODES = Object.freeze({
  originNotAllowed: "SOCKET_ORIGIN_NOT_ALLOWED",
  sessionRequired: "SOCKET_SESSION_REQUIRED",
});

const SAFE_MESSAGES = Object.freeze({
  [SOCKET_AUTHORIZATION_CODES.originNotAllowed]:
    "The browser origin is not allowed.",
  [SOCKET_AUTHORIZATION_CODES.sessionRequired]:
    "A valid session is required.",
});

class SocketAuthorizationError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code]);
    this.name = "SocketAuthorizationError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `socket authorization requires ${description}`
    );
  }
}

function authorizationError(code) {
  throw new SocketAuthorizationError(code);
}

function createSocketAuthorizationService({
  isAllowedOrigin,
  sessionCookie,
  sessionService,
  leagueAuthorization,
  leagueAccessRepository,
  teamAuthorityRepository,
} = {}) {
  if (typeof isAllowedOrigin !== "function") {
    throw new TypeError(
      "socket authorization requires an exact origin predicate"
    );
  }
  assertMethod(
    sessionCookie,
    "read",
    "a session cookie"
  );
  assertMethod(
    sessionService,
    "resolveWithoutActivity",
    "a read-only session resolver"
  );
  assertMethod(
    leagueAuthorization,
    "requireActiveUser",
    "active-user authorization"
  );
  assertMethod(
    leagueAccessRepository,
    "listVisibleLeagues",
    "a league-access repository"
  );
  assertMethod(
    teamAuthorityRepository,
    "listCurrentManagedTeams",
    "a team-authority repository"
  );

  function authorizeHandshake(handshake) {
    const headers = handshake?.headers;
    const origin = headers?.origin;
    if (
      typeof origin !== "string" ||
      !isAllowedOrigin(origin)
    ) {
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.originNotAllowed
      );
    }

    let rawSessionToken;
    try {
      rawSessionToken = sessionCookie.read(
        headers.cookie
      );
    } catch {
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.sessionRequired
      );
    }
    if (!rawSessionToken) {
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.sessionRequired
      );
    }

    let authenticated;
    let activeUser;
    try {
      authenticated =
        sessionService.resolveWithoutActivity(
          rawSessionToken
        );
      if (!authenticated?.valid) {
        authorizationError(
          SOCKET_AUTHORIZATION_CODES.sessionRequired
        );
      }
      activeUser =
        leagueAuthorization.requireActiveUser(
          authenticated
        );
    } catch (error) {
      if (error instanceof SocketAuthorizationError) {
        throw error;
      }
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.sessionRequired
      );
    } finally {
      rawSessionToken = null;
    }

    const actorUserId = activeUser?.actorUserId;
    if (!UUID_PATTERN.test(actorUserId || "")) {
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.sessionRequired
      );
    }

    let visibleLeagues;
    try {
      visibleLeagues =
        leagueAccessRepository.listVisibleLeagues(
          actorUserId
        );
    } catch {
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.sessionRequired
      );
    }
    if (!Array.isArray(visibleLeagues)) {
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.sessionRequired
      );
    }

    const leagueIds = new Set();
    for (const league of visibleLeagues) {
      if (
        league?.membership_status !== "active" ||
        league?.league_status === "deleted"
      ) {
        continue;
      }
      if (!UUID_PATTERN.test(league?.league_id || "")) {
        authorizationError(
          SOCKET_AUTHORIZATION_CODES.sessionRequired
        );
      }
      leagueIds.add(league.league_id);
    }

    let managedTeams;
    try {
      managedTeams =
        teamAuthorityRepository.listCurrentManagedTeams(
          actorUserId
        );
    } catch {
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.sessionRequired
      );
    }
    if (!Array.isArray(managedTeams)) {
      authorizationError(
        SOCKET_AUTHORIZATION_CODES.sessionRequired
      );
    }

    const teamIds = new Set();
    for (const assignment of managedTeams) {
      if (
        !UUID_PATTERN.test(assignment?.team_id || "") ||
        !UUID_PATTERN.test(assignment?.league_id || "") ||
        !UUID_PATTERN.test(
          assignment?.membership_id || ""
        ) ||
        assignment?.user_id !== actorUserId
      ) {
        authorizationError(
          SOCKET_AUTHORIZATION_CODES.sessionRequired
        );
      }
      if (
        !leagueIds.has(assignment.league_id) ||
        assignment.assignment_status !== "accepted" ||
        assignment.accepted_at_ms === null ||
        assignment.ended_at_ms !== null ||
        assignment.membership_status !== "active" ||
        assignment.team_status === "erased" ||
        assignment.league_status === "deleted"
      ) {
        continue;
      }
      teamIds.add(assignment.team_id);
    }

    const rooms = [
      `user:${actorUserId}`,
      ...[...leagueIds]
        .sort()
        .map((leagueId) => `league:${leagueId}`),
      ...[...teamIds]
        .sort()
        .map((teamId) => `team:${teamId}`),
    ];

    return Object.freeze({
      userId: actorUserId,
      rooms: Object.freeze(rooms),
    });
  }

  return Object.freeze({
    authorizeHandshake,
  });
}

module.exports = {
  SOCKET_AUTHORIZATION_CODES,
  SocketAuthorizationError,
  createSocketAuthorizationService,
};
