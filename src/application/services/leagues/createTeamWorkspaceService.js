const {
  CANONICAL_UUID_PATTERN,
} = require("../../../domain/players/playerIdentityPolicy");
const {
  evaluateStructuralRosterLegality,
} = require("../../../domain/rosters/rosterMovementPolicy");
const {
  DEFAULT_THREE_TEAM_PATTERN,
  DEFAULT_TWO_TEAM_PATTERN,
} = require("../../../domain/leagues/teamPatternPolicy");

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

function injuredReserveEligible(sourcePayloadJson) {
  if (typeof sourcePayloadJson !== "string") return false;
  try {
    const payload = JSON.parse(sourcePayloadJson);
    const status = String(payload?.Status || payload?.status || "")
      .trim()
      .toLowerCase();
    return status === "injured reserve";
  } catch {
    return false;
  }
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
    onTradeBlock: row.trade_blocked === 1,
    nhlTeamAbbreviation:
      typeof row.nhl_team_abbreviation === "string" &&
      row.nhl_team_abbreviation.length > 0
        ? row.nhl_team_abbreviation
        : null,
    injuredReserveEligible: injuredReserveEligible(row.source_payload_json),
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
            retainedAavCents: row.retained_aav_cents,
            remainingYears: row.remaining_contract_years,
          }),
    statistics: statistics(row),
  });
}

function evaluateTeamRosterLegality(record, categoryOverride = null) {
  const players = record.players.map((row) => ({
    ...row,
    roster_category:
      categoryOverride?.ownershipId === row.ownership_id
        ? categoryOverride.destinationCategory
        : row.roster_category,
  }));
  const structural = evaluateStructuralRosterLegality({
    leagueId: record.scope.league_id,
    seasonId: record.scope.season_id,
    teamId: record.scope.team_id,
    assignments: players.map((row) => ({
      leagueId: record.scope.league_id,
      seasonId: record.scope.season_id,
      teamId: record.scope.team_id,
      playerId: row.player_id,
      rosterCategory: row.roster_category,
      assignedPositionGroup: row.position_group,
    })),
    effectivePositions: players.map((row) => ({
      playerId: row.player_id,
      positionGroup: row.position_group,
    })),
  });
  let projectedUsageCents = record.cap.capUsageCents;
  if (categoryOverride) {
    const moved = record.players.find(
      (row) => row.ownership_id === categoryOverride.ownershipId
    );
    if (moved) {
      const netAavCents = Math.max(
        0,
        Number(
          categoryOverride.contractAavCents ?? moved.aav_cents ?? 0
        ) - Number(moved.retained_aav_cents || 0)
      );
      const wasActive = moved.roster_category === "Active";
      const becomesActive = categoryOverride.destinationCategory === "Active";
      if (wasActive && !becomesActive) projectedUsageCents -= netAavCents;
      if (!wasActive && becomesActive) projectedUsageCents += netAavCents;
    }
  }
  const reasons = [...structural.reasons];
  if (!record.cap.complete) {
    reasons.push({ code: "SALARY_CAP_CALCULATION_INCOMPLETE" });
  }
  if (projectedUsageCents > record.cap.capLimitCents) {
    reasons.push({ code: "SALARY_CAP_EXCEEDED" });
  }
  for (const row of players) {
    if (
      ["Active", "Bench", "Injured Reserve"].includes(row.roster_category) &&
      row.contract_id === null &&
      !(
        categoryOverride?.ownershipId === row.ownership_id &&
        categoryOverride.hasActiveContract === true
      )
    ) {
      reasons.push({
        code: "ACTIVE_CONTRACT_MISSING",
        playerId: row.player_id,
      });
    }
  }
  return Object.freeze({
    legal: reasons.length === 0,
    counts: structural.counts,
    limits: structural.limits,
    cap: Object.freeze({
      limitCents: record.cap.capLimitCents,
      usageCents: projectedUsageCents,
      spaceCents: record.cap.capLimitCents - projectedUsageCents,
      complete: record.cap.complete,
    }),
    reasons: Object.freeze(
      reasons.map((reason) => Object.freeze({ ...reason }))
    ),
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
      tertiaryColour: scope.tertiary_colour,
      patternTemplate:
        scope.pattern_template ||
        (scope.tertiary_colour
          ? DEFAULT_THREE_TEAM_PATTERN
          : DEFAULT_TWO_TEAM_PATTERN),
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
    legality: evaluateTeamRosterLegality(record),
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
            playerName: row.player_name,
            annualPenaltyCents: row.penalty_cents,
            remainingYears: row.remaining_years,
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
  function items(values) {
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
    forwardOwnerships: items(input.forwardOwnerships),
    defenceOwnerships: items(input.defenceOwnerships),
  });
}

function normalizeTradeBlockInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "blocked,expectedVersion" ||
    typeof input.blocked !== "boolean" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    failInput();
  }
  return Object.freeze({
    blocked: input.blocked,
    expectedVersion: input.expectedVersion,
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
  for (const method of ["read", "saveOrder", "setTradeBlock"]) {
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

  function setTradeBlock({
    authenticated,
    leagueId,
    teamId,
    ownershipId,
    input,
  } = {}) {
    const authority = managerAuthority(authenticated, leagueId, teamId);
    if (!CANONICAL_UUID_PATTERN.test(ownershipId || "")) failInput();
    const command = normalizeTradeBlockInput(input);
    const ownership = repository.setTradeBlock({
      leagueId,
      teamId,
      ownershipId,
      occurredAtMs: clock.nowMs(),
      actorUserId: authority.actorUserId,
      ...command,
    });
    return Object.freeze({
      code: command.blocked
        ? "PLAYER_ADDED_TO_TRADE_BLOCK"
        : "PLAYER_REMOVED_FROM_TRADE_BLOCK",
      ownership: Object.freeze({
        id: ownership.id,
        version: ownership.version,
        onTradeBlock: ownership.trade_blocked === 1,
      }),
    });
  }

  return Object.freeze({ read, saveOrder, setTradeBlock });
}

module.exports = {
  RETENTION_SLOT_LIMIT,
  TeamWorkspaceInputError,
  TeamWorkspaceNotFoundError,
  createTeamWorkspaceService,
  evaluateTeamRosterLegality,
  normalizeOrderInput,
  normalizeTradeBlockInput,
  safeWorkspace,
};
