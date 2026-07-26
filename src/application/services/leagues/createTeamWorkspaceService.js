const {
  CANONICAL_UUID_PATTERN,
} = require("../../../domain/players/playerIdentityPolicy");

const RETENTION_SLOT_LIMIT = 3;

class TeamWorkspaceInputError extends Error {
  constructor() {
    super("The team-workspace request is invalid.");
    this.name = "TeamWorkspaceInputError";
    this.code = "TEAM_WORKSPACE_INPUT_INVALID";
  }
}

class TeamWorkspaceNotFoundError extends Error {
  constructor() {
    super("The team workspace was not found.");
    this.name = "TeamWorkspaceNotFoundError";
    this.code = "TEAM_NOT_FOUND";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`team workspace requires ${description}`);
  }
}

function failInput() {
  throw new TeamWorkspaceInputError();
}

function age(birthDate, nowMs) {
  if (
    birthDate === null ||
    typeof birthDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)
  ) {
    return null;
  }
  const birth = new Date(`${birthDate}T00:00:00.000Z`);
  const now = new Date(nowMs);
  let years = now.getUTCFullYear() - birth.getUTCFullYear();
  if (
    now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() &&
      now.getUTCDate() < birth.getUTCDate())
  ) {
    years -= 1;
  }
  return years >= 0 && years <= 150 ? years : null;
}

function statistics(row) {
  return row.games_played === null
    ? null
    : Object.freeze({
        gamesPlayed: row.games_played,
        goals: row.goals,
        assists: row.assists,
        nhlPoints: row.nhl_points,
        fantasyPointsHundredths: row.fantasy_points_hundredths,
      });
}

function player(row, nowMs) {
  return Object.freeze({
    ownershipId: row.ownership_id,
    ownershipVersion: row.ownership_version,
    playerId: row.player_id,
    name: row.full_name,
    normalizedPosition: row.position_group,
    rosterCategory: row.roster_category,
    ownershipKind: row.ownership_kind,
    slotNumber: row.slot_number,
    displayOrder: row.display_order,
    age: age(row.birth_date, nowMs),
    contract:
      row.contract_id === null
        ? null
        : Object.freeze({
            id: row.contract_id,
            version: row.contract_version,
            type: row.contract_type,
            originalTotalValueCents: row.original_total_value_cents,
            originalTermYears: row.original_term_years,
            aavCents: row.aav_cents,
            remainingYears: row.remaining_contract_years,
          }),
    statistics: statistics(row),
  });
}

function safeWorkspace(record, nowMs, canManage) {
  const { scope, cap } = record;
  const players = Object.freeze(
    record.players.map((row) => player(row, nowMs))
  );
  return Object.freeze({
    code: "TEAM_WORKSPACE_FOUND",
    canManage,
    orderVersion: record.orderVersion,
    league: Object.freeze({ id: scope.league_id, name: scope.league_name }),
    season: Object.freeze({ id: scope.season_id, label: scope.season_label }),
    team: Object.freeze({
      id: scope.team_id,
      name: scope.team_name,
      primaryColour: scope.primary_colour,
      secondaryColour: scope.secondary_colour,
      logoReference:
        scope.has_logo === 1
          ? `/api/v1/leagues/${scope.league_id}/teams/${scope.team_id}/logo`
          : null,
      version: scope.team_version,
    }),
    players,
    cap: Object.freeze({
      limitCents: cap.capLimitCents,
      usageCents: cap.capUsageCents,
      spaceCents: cap.capSpaceCents,
      activePlayerCents: cap.breakdown.activePlayerCents,
      retainedSalaryCents: cap.breakdown.retentionCents,
      buyoutPenaltyCents: cap.breakdown.buyoutCents,
      retentionSlotsUsed: record.retentions.length,
      retentionSlotLimit: RETENTION_SLOT_LIMIT,
      complete: cap.complete,
      issues: cap.issues,
    }),
    draftPicks: Object.freeze(
      record.draftPicks.map((row) =>
        Object.freeze({
          id: row.id,
          version: row.version,
          targetSeason: Object.freeze({
            id: row.target_season_id,
            label: row.target_season_label,
          }),
          round: row.round_number,
          position: row.position_number,
          originalTeam: Object.freeze({
            id: row.original_team_id,
            name: row.original_team_name,
          }),
        })
      )
    ),
    tradeAssets: Object.freeze({
      contracts: Object.freeze(
        players
          .filter(
            ({ contract, rosterCategory }) =>
              contract !== null &&
              ["Active", "Bench", "Injured Reserve"].includes(rosterCategory)
          )
          .map((item) =>
            Object.freeze({
              id: item.contract.id,
              label: `${item.name} · $${(item.contract.aavCents / 100).toFixed(2)} AAV · ${item.contract.remainingYears}y`,
              playerId: item.playerId,
              aavCents: item.contract.aavCents,
            })
          )
      ),
      prospects: Object.freeze(
        players
          .filter(({ ownershipKind }) => ownershipKind === "Prospect Right")
          .map((item) =>
            Object.freeze({
              id: item.playerId,
              label: `${item.name} · ${item.normalizedPosition} prospect`,
            })
          )
      ),
      draftPicks: Object.freeze(
        record.draftPicks.map((row) =>
          Object.freeze({
            id: row.id,
            label: `${row.target_season_label} Round ${row.round_number} · originally ${row.original_team_name}`,
          })
        )
      ),
      retentions: Object.freeze(
        record.retentions.map((row) =>
          Object.freeze({
            id: row.id,
            label: `${row.player_name} · $${(row.retained_aav_cents / 100).toFixed(2)} retained · ${row.remaining_years}y`,
            contractId: row.contract_id,
          })
        )
      ),
      buyouts: Object.freeze(
        record.buyouts.map((row) =>
          Object.freeze({
            id: row.id,
            label: `${row.player_name} · $${(row.penalty_cents / 100).toFixed(2)} penalty · ${row.remaining_years}y`,
          })
        )
      ),
      futureConsiderations: Object.freeze(
        record.futureConsiderations.map((row) =>
          Object.freeze({ id: row.id, label: row.description })
        )
      ),
    }),
  });
}

function normalizeOrderInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "defenceOwnerships,expectedVersion,forwardOwnerships"
  ) {
    failInput();
  }
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !Array.isArray(input.forwardOwnerships) ||
    !Array.isArray(input.defenceOwnerships)
  ) {
    failInput();
  }
  function items(values, maximum) {
    if (values.length > maximum) failInput();
    return Object.freeze(
      values.map((item) => {
        if (
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          Object.keys(item).sort().join(",") !== "id,version" ||
          !CANONICAL_UUID_PATTERN.test(item.id || "") ||
          !Number.isSafeInteger(item.version) ||
          item.version < 1
        ) {
          failInput();
        }
        return Object.freeze({ id: item.id, version: item.version });
      })
    );
  }
  return Object.freeze({
    expectedVersion: input.expectedVersion,
    forwardOwnerships: items(input.forwardOwnerships, 12),
    defenceOwnerships: items(input.defenceOwnerships, 6),
  });
}

function createTeamWorkspaceService({
  leagueAuthorization,
  teamAuthorization,
  repository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league commissioner authorization"
  );
  for (const method of ["requireManager", "requireTeamVisibility"]) {
    assertMethod(teamAuthorization, method, "team authorization");
  }
  for (const method of ["read", "saveOrder"]) {
    assertMethod(repository, method, "a team-workspace repository");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "a secure identifier source");

  function managerAuthority(authenticated, leagueId, teamId) {
    try {
      return teamAuthorization.requireManager(authenticated, leagueId, teamId);
    } catch (error) {
      if (error?.code !== "TEAM_MANAGER_REQUIRED") throw error;
      return leagueAuthorization.requireCommissioner(authenticated, leagueId);
    }
  }

  function read({ authenticated, leagueId, teamId } = {}) {
    teamAuthorization.requireTeamVisibility(authenticated, leagueId, teamId);
    let canManage = true;
    try {
      managerAuthority(authenticated, leagueId, teamId);
    } catch (error) {
      if (
        !["TEAM_MANAGER_REQUIRED", "LEAGUE_COMMISSIONER_REQUIRED"].includes(
          error?.code
        )
      ) {
        throw error;
      }
      canManage = false;
    }
    const record = repository.read({ leagueId, teamId });
    if (!record) throw new TeamWorkspaceNotFoundError();
    return safeWorkspace(record, clock.nowMs(), canManage);
  }

  function saveOrder({ authenticated, leagueId, teamId, input } = {}) {
    const authority = managerAuthority(authenticated, leagueId, teamId);
    const order = normalizeOrderInput(input);
    const record = repository.read({ leagueId, teamId });
    if (!record) throw new TeamWorkspaceNotFoundError();
    const result = repository.saveOrder({
      leagueId: record.scope.league_id,
      seasonId: record.scope.season_id,
      teamId: record.scope.team_id,
      actorUserId: authority.actorUserId,
      occurredAtMs: clock.nowMs(),
      createId: () => secureRandom.id(),
      ...order,
    });
    return Object.freeze({
      code: "ROSTER_DISPLAY_ORDER_SAVED",
      orderVersion: result.version,
    });
  }

  return Object.freeze({ read, saveOrder });
}

module.exports = {
  RETENTION_SLOT_LIMIT,
  TeamWorkspaceInputError,
  TeamWorkspaceNotFoundError,
  createTeamWorkspaceService,
  normalizeOrderInput,
  safeWorkspace,
};
