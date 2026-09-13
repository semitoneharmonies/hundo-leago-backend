const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class TeamAuthorizationInputError extends Error {
  constructor() {
    super("A canonical team identifier is required.");
    this.name = "TeamAuthorizationInputError";
    this.code = "TEAM_ID_INVALID";
  }
}

class TeamVisibilityError extends Error {
  constructor() {
    super("The team was not found.");
    this.name = "TeamVisibilityError";
    this.code = "TEAM_NOT_FOUND";
  }
}

class TeamManagerRequiredError extends Error {
  constructor() {
    super("Current team-manager authority is required.");
    this.name = "TeamManagerRequiredError";
    this.code = "TEAM_MANAGER_REQUIRED";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `team authorization requires ${description}`
    );
  }
}

function validateTeamId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TeamAuthorizationInputError();
  }
  return value;
}

function createTeamAuthorizationService({
  leagueAuthorization,
  teamAuthorityRepository,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireActiveMembership",
    "league membership authorization"
  );
  for (const method of [
    "findTeam",
    "findCurrentManagerAssignment",
  ]) {
    assertMethod(
      teamAuthorityRepository,
      method,
      "a team-authority repository"
    );
  }

  function requireTeamVisibility(
    authenticated,
    leagueId,
    teamId
  ) {
    const canonicalTeamId = validateTeamId(teamId);
    const league =
      leagueAuthorization.requireActiveMembership(
        authenticated,
        leagueId
      );
    const team = teamAuthorityRepository.findTeam({
      leagueId: league.leagueId,
      teamId: canonicalTeamId,
    });
    if (
      !team ||
      team.team_id !== canonicalTeamId ||
      team.league_id !== league.leagueId ||
      team.team_status === "erased"
    ) {
      throw new TeamVisibilityError();
    }
    return Object.freeze({
      ...league,
      code: "TEAM_VISIBLE",
      teamId: team.team_id,
      teamStatus: team.team_status,
      teamVersion: team.team_version,
    });
  }

  function requireManager(authenticated, leagueId, teamId) {
    const visible = requireTeamVisibility(
      authenticated,
      leagueId,
      teamId
    );
    const assignment =
      teamAuthorityRepository.findCurrentManagerAssignment({
        leagueId: visible.leagueId,
        teamId: visible.teamId,
        userId: visible.actorUserId,
        membershipId: visible.membershipId,
      });
    if (
      !assignment ||
      assignment.league_id !== visible.leagueId ||
      assignment.team_id !== visible.teamId ||
      assignment.user_id !== visible.actorUserId ||
      assignment.membership_id !== visible.membershipId ||
      assignment.assignment_status !== "accepted" ||
      assignment.accepted_at_ms === null ||
      assignment.ended_at_ms !== null ||
      assignment.membership_status !== "active" ||
      assignment.team_status === "erased" ||
      assignment.league_status === "deleted"
    ) {
      throw new TeamManagerRequiredError();
    }
    return Object.freeze({
      ...visible,
      assignmentId: assignment.assignment_id,
      assignmentVersion: assignment.assignment_version,
      authority: "manager",
      code: "TEAM_MANAGER_AUTHORIZED",
      membershipVersion: assignment.membership_version,
      teamVersion: assignment.team_version,
    });
  }

  return Object.freeze({
    requireManager,
    requireTeamVisibility,
  });
}

module.exports = {
  TeamAuthorizationInputError,
  TeamManagerRequiredError,
  TeamVisibilityError,
  createTeamAuthorizationService,
  validateTeamId,
};
