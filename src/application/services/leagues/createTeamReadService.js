const {
  validateStableId,
} = require("../../../domain/leagues/teamPolicy");
const {
  DEFAULT_THREE_TEAM_PATTERN,
  DEFAULT_TWO_TEAM_PATTERN,
} = require("../../../domain/leagues/teamPatternPolicy");

class TeamNotFoundError extends Error {
  constructor() {
    super("The team was not found.");
    this.name = "TeamNotFoundError";
    this.code = "TEAM_NOT_FOUND";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`team read requires ${description}`);
  }
}

function safeTeam(row) {
  const hasTargetLogo =
    typeof row.logo_reference === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      row.logo_reference
    );
  return Object.freeze({
    id: row.team_id,
    leagueId: row.league_id,
    name: row.team_name,
    status: row.team_status,
    primaryColour: row.primary_colour,
    secondaryColour: row.secondary_colour,
    tertiaryColour: row.tertiary_colour,
    patternTemplate:
      row.pattern_template ||
      (row.tertiary_colour
        ? DEFAULT_THREE_TEAM_PATTERN
        : DEFAULT_TWO_TEAM_PATTERN),
    logoReference: hasTargetLogo
      ? `/api/v1/leagues/${row.league_id}/teams/${row.team_id}/logo`
      : null,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.team_version,
    currentManager:
      row.manager_assignment_id === null
        ? null
        : Object.freeze({
            assignmentId: row.manager_assignment_id,
            userId: row.manager_user_id,
            displayName: row.manager_display_name,
            isProtectedPlatformAdministrator:
              row.manager_is_platform_administrator === 1,
            acceptedAtMs: row.manager_accepted_at_ms,
            version: row.manager_assignment_version,
          }),
  });
}

function createTeamReadService({
  leagueAuthorization,
  teamReadRepository,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireActiveMembership",
    "league membership authorization"
  );
  for (const method of ["findTeam", "listTeams"]) {
    assertMethod(teamReadRepository, method, "a SELECT-only team repository");
  }

  function list({ leagueId, authenticated } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    leagueAuthorization.requireActiveMembership(
      authenticated,
      canonicalLeagueId
    );
    return Object.freeze({
      code: "TEAMS_FOUND",
      teams: Object.freeze(
        teamReadRepository.listTeams(canonicalLeagueId).map(safeTeam)
      ),
    });
  }

  function read({ leagueId, teamId, authenticated } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const canonicalTeamId = validateStableId(teamId);
    leagueAuthorization.requireActiveMembership(
      authenticated,
      canonicalLeagueId
    );
    const row = teamReadRepository.findTeam({
      leagueId: canonicalLeagueId,
      teamId: canonicalTeamId,
    });
    if (!row) throw new TeamNotFoundError();
    return Object.freeze({ code: "TEAM_FOUND", team: safeTeam(row) });
  }

  return Object.freeze({ list, read });
}

module.exports = {
  TeamNotFoundError,
  createTeamReadService,
  safeTeam,
};
