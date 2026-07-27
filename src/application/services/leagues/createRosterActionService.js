const {
  CANONICAL_UUID_PATTERN,
} = require("../../../domain/players/playerIdentityPolicy");
const {
  evaluateTeamRosterLegality,
} = require("./createTeamWorkspaceService");

class RosterActionInputError extends Error {
  constructor() {
    super("The roster action request is invalid.");
    this.name = "RosterActionInputError";
    this.code = "ROSTER_ACTION_INPUT_INVALID";
  }
}

class RosterActionConflictError extends Error {
  constructor(code, details = null) {
    super("The roster action cannot be completed in its current state.");
    this.name = "RosterActionConflictError";
    this.code = code;
    this.details = details;
  }
}

function failInput() {
  throw new RosterActionInputError();
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`roster actions require ${description}`);
  }
}

function exactObject(input, keys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== [...keys].sort().join(",")
  ) {
    failInput();
  }
  return input;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) failInput();
  return value;
}

function createRosterActionService({
  leagueAuthorization,
  teamAuthorization,
  workspaceRepository,
  rosterMovementRepository,
  buyoutRepository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "commissioner authorization"
  );
  assertMethod(teamAuthorization, "requireManager", "manager authorization");
  assertMethod(workspaceRepository, "read", "a team-workspace repository");
  assertMethod(rosterMovementRepository, "move", "a roster-movement repository");
  assertMethod(buyoutRepository, "buyOut", "a buyout repository");
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function authority(authenticated, leagueId, teamId) {
    try {
      return teamAuthorization.requireManager(authenticated, leagueId, teamId);
    } catch (error) {
      if (error?.code !== "TEAM_MANAGER_REQUIRED") throw error;
      return leagueAuthorization.requireCommissioner(authenticated, leagueId);
    }
  }

  function actorAuthority(value) {
    return value.authority === "manager" ? "manager" : "commissioner";
  }

  function record(leagueId, teamId) {
    const result = workspaceRepository.read({ leagueId, teamId });
    if (!result) {
      const error = new Error("The team was not found.");
      error.code = "TEAM_NOT_FOUND";
      throw error;
    }
    return result;
  }

  function playerByOwnership(result, ownershipId) {
    if (!CANONICAL_UUID_PATTERN.test(ownershipId || "")) failInput();
    const player = result.players.find(
      (candidate) => candidate.ownership_id === ownershipId
    );
    if (!player) {
      throw new RosterActionConflictError("ROSTER_OWNERSHIP_NOT_FOUND");
    }
    return player;
  }

  function moveToInjuredReserve({
    authenticated,
    leagueId,
    teamId,
    ownershipId,
    input,
  } = {}) {
    const submitted = exactObject(input, ["expectedVersion"]);
    const result = moveRosterPlayer({
      authenticated,
      leagueId,
      teamId,
      ownershipId,
      input: {
        confirmedIllegal: false,
        destinationCategory: "Injured Reserve",
        expectedVersion: submitted.expectedVersion,
      },
    });
    return Object.freeze({
      ...result,
      code: "PLAYER_MOVED_TO_INJURED_RESERVE",
    });
  }

  function moveRosterPlayer({
    authenticated,
    leagueId,
    teamId,
    ownershipId,
    input,
  } = {}) {
    const submitted = exactObject(input, [
      "confirmedIllegal",
      "destinationCategory",
      "expectedVersion",
    ]);
    const expectedVersion = positiveVersion(submitted.expectedVersion);
    if (typeof submitted.confirmedIllegal !== "boolean") failInput();
    if (
      !["Active", "Bench", "Injured Reserve"].includes(
        submitted.destinationCategory
      )
    ) {
      failInput();
    }
    const actor = authority(authenticated, leagueId, teamId);
    const workspace = record(leagueId, teamId);
    const player = playerByOwnership(workspace, ownershipId);
    if (
      player.ownership_version !== expectedVersion ||
      player.roster_category === "Prospect" ||
      player.roster_category === submitted.destinationCategory ||
      (player.roster_category !== "Active" &&
        submitted.destinationCategory !== "Active")
    ) {
      throw new RosterActionConflictError("ROSTER_ACTION_STALE");
    }
    if (player.contract_id === null) {
      throw new RosterActionConflictError("ACTIVE_CONTRACT_MISSING");
    }
    if (
      submitted.destinationCategory === "Bench" &&
      Number(player.aav_cents) > 400
    ) {
      throw new RosterActionConflictError("BENCH_AAV_LIMIT_EXCEEDED");
    }
    let source = null;
    if (typeof player.source_payload_json === "string") {
      try {
        source = JSON.parse(player.source_payload_json);
      } catch {
        source = null;
      }
    }
    const sourceStatus = String(source?.Status || source?.status || "")
      .trim()
      .toLowerCase();
    if (
      submitted.destinationCategory === "Injured Reserve" &&
      sourceStatus !== "injured reserve"
    ) {
      throw new RosterActionConflictError("PLAYER_NOT_IR_ELIGIBLE");
    }
    const legality = evaluateTeamRosterLegality(workspace, {
      ownershipId,
      destinationCategory: submitted.destinationCategory,
    });
    if (!legality.legal && submitted.confirmedIllegal !== true) {
      throw new RosterActionConflictError(
        "ROSTER_ILLEGAL_CONFIRMATION_REQUIRED",
        { legality }
      );
    }
    const occupied = new Set(
      workspace.players
        .filter(
          (candidate) =>
            candidate.roster_category === submitted.destinationCategory &&
            (submitted.destinationCategory !== "Active" ||
              candidate.position_group === player.position_group)
        )
        .map((candidate) => candidate.slot_number)
    );
    const maximum =
      submitted.destinationCategory === "Active"
        ? player.position_group === "F"
          ? 12
          : 6
        : 4;
    const destinationSlotNumber =
      Array.from({ length: maximum }, (_, index) => index + 1).find(
        (slot) => !occupied.has(slot)
      ) || null;
    const moved = rosterMovementRepository.move({
      leagueId: workspace.scope.league_id,
      seasonId: workspace.scope.season_id,
      teamId: workspace.scope.team_id,
      playerId: player.player_id,
      expectedVersion,
      expectedSourceCategory: player.roster_category,
      destinationCategory: submitted.destinationCategory,
      destinationPositionGroup: player.position_group,
      destinationSlotNumber,
      actorUserId: actor.actorUserId,
      actorAuthority: actorAuthority(actor),
      ownershipEventId: secureRandom.id(),
      activityId: secureRandom.id(),
      reason: null,
      occurredAtMs: clock.nowMs(),
    });
    return Object.freeze({
      code: "ROSTER_PLAYER_MOVED",
      legality,
      ownership: Object.freeze({
        id: moved.ownership.id,
        version: moved.ownership.version,
        rosterCategory: moved.ownership.roster_category,
        slotNumber: moved.ownership.slot_number,
      }),
    });
  }

  function buyOutContract({
    authenticated,
    leagueId,
    teamId,
    contractId,
    input,
  } = {}) {
    if (!CANONICAL_UUID_PATTERN.test(contractId || "")) failInput();
    const submitted = exactObject(input, [
      "confirmed",
      "expectedContractVersion",
      "expectedOwnershipVersion",
    ]);
    if (submitted.confirmed !== true) failInput();
    const expectedContractVersion = positiveVersion(
      submitted.expectedContractVersion
    );
    const expectedOwnershipVersion = positiveVersion(
      submitted.expectedOwnershipVersion
    );
    const actor = authority(authenticated, leagueId, teamId);
    const workspace = record(leagueId, teamId);
    const player = workspace.players.find(
      (candidate) => candidate.contract_id === contractId
    );
    if (!player) {
      throw new RosterActionConflictError("BUYOUT_CONTRACT_NOT_OWNED");
    }
    if (
      player.contract_version !== expectedContractVersion ||
      player.ownership_version !== expectedOwnershipVersion
    ) {
      throw new RosterActionConflictError("ROSTER_ACTION_STALE");
    }
    const remainingYears = Number(player.remaining_contract_years);
    if (!Number.isSafeInteger(remainingYears) || remainingYears < 1) {
      throw new RosterActionConflictError("BUYOUT_CONTRACT_NOT_ELIGIBLE");
    }
    const boughtOut = buyoutRepository.buyOut({
      buyoutId: secureRandom.id(),
      buyoutYearIds: Array.from(
        { length: remainingYears },
        () => secureRandom.id()
      ),
      contractEventId: secureRandom.id(),
      ownershipEventId: secureRandom.id(),
      activityId: secureRandom.id(),
      leagueId: workspace.scope.league_id,
      seasonId: workspace.scope.season_id,
      teamId: workspace.scope.team_id,
      playerId: player.player_id,
      contractId,
      ownershipId: player.ownership_id,
      expectedContractVersion,
      expectedOwnershipVersion,
      actorUserId: actor.actorUserId,
      actorAuthority: actorAuthority(actor),
      confirmed: true,
      reason: null,
      occurredAtMs: clock.nowMs(),
    });
    return Object.freeze({
      code: "CONTRACT_BOUGHT_OUT",
      buyout: Object.freeze({
        id: boughtOut.obligation.id,
        annualPenaltyCents: boughtOut.annualPenaltyCents,
        remainingYears: boughtOut.years.length,
      }),
    });
  }

  return Object.freeze({
    buyOutContract,
    moveRosterPlayer,
    moveToInjuredReserve,
  });
}

module.exports = {
  RosterActionConflictError,
  RosterActionInputError,
  createRosterActionService,
};
