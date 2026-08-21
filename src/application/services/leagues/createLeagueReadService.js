class LeagueReadStateError extends Error {
  constructor() {
    super("The league read model is unavailable.");
    this.name = "LeagueReadStateError";
    this.code = "LEAGUE_READ_STATE_INVALID";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league reads require ${description}`);
  }
}

function safeSeason(row) {
  if (!row.current_season_id) return null;
  return Object.freeze({
    id: row.current_season_id,
    label: row.season_label,
    nhlSeasonKey: row.nhl_season_key,
    status: row.season_status,
    regularSeasonStartsAtMs:
      row.regular_season_starts_at_ms ?? null,
    regularSeasonEndsAtMs:
      row.regular_season_ends_at_ms ?? null,
    fantasyPlayoffsStartAtMs:
      row.fantasy_playoffs_start_at_ms ?? null,
    fantasyPlayoffsEndAtMs:
      row.fantasy_playoffs_end_at_ms ?? null,
    version: row.season_version,
  });
}

function safeListedSeason(row) {
  return Object.freeze({
    id: row.id,
    label: row.label,
    nhlSeasonKey: row.nhl_season_key,
    status: row.status,
    regularSeasonStartsAtMs: row.regular_season_starts_at_ms ?? null,
    regularSeasonEndsAtMs: row.regular_season_ends_at_ms ?? null,
    fantasyPlayoffsStartAtMs:
      row.fantasy_playoffs_start_at_ms ?? null,
    fantasyPlayoffsEndAtMs:
      row.fantasy_playoffs_end_at_ms ?? null,
    version: row.version,
  });
}

function safeVisibleLeague(
  row,
  effectiveAuthority = row.permission_category
) {
  return Object.freeze({
    id: row.league_id,
    name: row.league_name,
    status: row.league_status,
    timezone: row.league_timezone,
    currentSeason:
      row.current_season_id === null
        ? null
        : Object.freeze({
            id: row.current_season_id,
            label: row.season_label,
            nhlSeasonKey: row.nhl_season_key,
            status: row.season_status,
            version: row.season_version,
          }),
    membership: Object.freeze({
      id: row.membership_id,
      effectiveAuthority,
      permissionCategory: row.permission_category,
      status: row.membership_status,
      version: row.membership_version,
    }),
    version: row.league_version,
  });
}

function safeLeague(
  row,
  membership,
  effectiveAuthority = membership?.permission_category
) {
  if (!row || !membership) throw new LeagueReadStateError();
  return Object.freeze({
    id: row.league_id,
    name: row.league_name,
    status: row.league_status,
    timezone: row.league_timezone,
    currentSeason: safeSeason(row),
    membership: Object.freeze({
      id: membership.id,
      effectiveAuthority,
      permissionCategory: membership.permission_category,
      status: membership.status,
      version: membership.version,
    }),
    version: row.league_version,
  });
}

function safeSettings(row) {
  if (!row) throw new LeagueReadStateError();
  return Object.freeze({
    leagueId: row.league_id,
    salaryCapCents: row.salary_cap_cents,
    tradeDeadlineAtMs: row.trade_deadline_at_ms,
    maximumTeams: row.maximum_teams,
    activeForwardSlots: row.active_forward_slots,
    activeDefenceSlots: row.active_defence_slots,
    benchSlots: row.bench_slots,
    maximumBenchAavCents: row.maximum_bench_aav_cents,
    injuredReserveSlots: row.injured_reserve_slots,
    prospectSlotsUnlimited: row.prospect_slots_unlimited === 1,
    scoringRuleVersion: row.scoring_rule_version,
    standingsRuleVersion: row.standings_rule_version,
    version: row.version,
  });
}

function safeMembership(row) {
  return Object.freeze({
    id: row.membership_id,
    leagueId: row.league_id,
    user: Object.freeze({
      id: row.user_id,
      displayName: row.display_name,
    }),
    permissionCategory: row.permission_category,
    isProtectedPlatformAdministrator:
      row.is_platform_administrator === 1,
    status: row.membership_status,
    joinedAtMs: row.joined_at_ms,
    endedAtMs: row.ended_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.membership_version,
  });
}

function createLeagueReadService({
  leagueAuthorization,
  leagueAccessRepository,
  platformAuthorization,
} = {}) {
  for (const method of [
    "requireActiveMembership",
    "requireActiveUser",
    "requireCommissioner",
  ]) {
    assertMethod(
      leagueAuthorization,
      method,
      "league authorization"
    );
  }
  if (platformAuthorization !== undefined) {
    assertMethod(
      platformAuthorization,
      "requireAdministrator",
      "platform-administrator authorization"
    );
  }
  for (const method of [
    "findActiveMembership",
    "findLeagueSettings",
    "findLeagueSummary",
    "listLeagueMemberships",
    "listInvitableUsers",
    "listLeagueSeasons",
    "listVisibleLeagues",
  ]) {
    assertMethod(
      leagueAccessRepository,
      method,
      "a league-access repository"
    );
  }

  function effectiveAuthority(authenticated) {
    if (!platformAuthorization) return null;
    try {
      return platformAuthorization
        .requireAdministrator(authenticated)
        .authority;
    } catch (error) {
      if (error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED") return null;
      throw error;
    }
  }

  function list({ authenticated } = {}) {
    const authority =
      leagueAuthorization.requireActiveUser(authenticated);
    const platformAuthority = effectiveAuthority(authenticated);
    const leagues = leagueAccessRepository
      .listVisibleLeagues(authority.actorUserId)
      .map((row) =>
        safeVisibleLeague(
          row,
          platformAuthority || row.permission_category
        )
      );
    return Object.freeze({
      code: "LEAGUES_FOUND",
      leagues: Object.freeze(leagues),
    });
  }

  function readLeague({ leagueId, authenticated } = {}) {
    const authority =
      leagueAuthorization.requireActiveMembership(
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
    const platformAuthority = effectiveAuthority(authenticated);
    return Object.freeze({
      code: "LEAGUE_FOUND",
      league: safeLeague(
        league,
        membership,
        platformAuthority || membership.permission_category
      ),
    });
  }

  function readSettings({ leagueId, authenticated } = {}) {
    const authority =
      leagueAuthorization.requireActiveMembership(
        authenticated,
        leagueId
      );
    const settings = leagueAccessRepository.findLeagueSettings(
      authority.leagueId
    );
    return Object.freeze({
      code: "LEAGUE_SETTINGS_FOUND",
      settings: safeSettings(settings),
    });
  }

  function listMemberships({ leagueId, authenticated } = {}) {
    const authority = leagueAuthorization.requireCommissioner(
      authenticated,
      leagueId
    );
    const memberships = leagueAccessRepository
      .listLeagueMemberships(authority.leagueId)
      .map(safeMembership);
    return Object.freeze({
      code: "LEAGUE_MEMBERSHIPS_FOUND",
      memberships: Object.freeze(memberships),
    });
  }

  function listSeasons({ leagueId, authenticated } = {}) {
    const authority =
      leagueAuthorization.requireActiveMembership(
        authenticated,
        leagueId
      );
    const seasons = leagueAccessRepository
      .listLeagueSeasons(authority.leagueId)
      .map(safeListedSeason);
    return Object.freeze({
      code: "LEAGUE_SEASONS_FOUND",
      leagueId: authority.leagueId,
      seasons: Object.freeze(seasons),
    });
  }

  function listInvitableUsers({ leagueId, authenticated } = {}) {
    const authority = leagueAuthorization.requireCommissioner(
      authenticated,
      leagueId
    );
    return Object.freeze({
      code: "INVITABLE_LEAGUE_USERS_FOUND",
      users: Object.freeze(
        leagueAccessRepository
          .listInvitableUsers(authority.leagueId)
          .map((row) =>
            Object.freeze({
              id: row.user_id,
              displayName: row.display_name,
              email: row.email_display,
            })
          )
      ),
    });
  }

  return Object.freeze({
    list,
    listMemberships,
    listInvitableUsers,
    listSeasons,
    readLeague,
    readSettings,
  });
}

module.exports = {
  LeagueReadStateError,
  createLeagueReadService,
  safeLeague,
  safeListedSeason,
  safeMembership,
  safeSettings,
  safeVisibleLeague,
};
