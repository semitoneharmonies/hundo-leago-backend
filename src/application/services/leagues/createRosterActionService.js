const {
  CANONICAL_UUID_PATTERN,
} = require("../../../domain/players/playerIdentityPolicy");
const {
  evaluateTeamRosterLegality,
} = require("./createTeamWorkspaceService");

const LATE_LOCK_STATUSES = new Set([
  "awaiting_data",
  "completed",
  "not_applicable",
  "still_illegal",
]);
const AWAITING_DATA_LATE_LOCK = Object.freeze({ status: "awaiting_data" });

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

function safeLateLockProjection(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("late-lock coordination returned an unsafe result");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "status" && keys !== "lockId,status") {
    throw new TypeError("late-lock coordination returned an unsafe result");
  }
  if (!LATE_LOCK_STATUSES.has(value.status)) {
    throw new TypeError("late-lock coordination returned an unsafe result");
  }
  if (
    Object.hasOwn(value, "lockId") &&
    (value.status !== "completed" ||
      !CANONICAL_UUID_PATTERN.test(value.lockId || ""))
  ) {
    throw new TypeError("late-lock coordination returned an unsafe result");
  }
  return Object.freeze({
    status: value.status,
    ...(Object.hasOwn(value, "lockId") ? { lockId: value.lockId } : {}),
  });
}

function ownershipWitness(row, state) {
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    !CANONICAL_UUID_PATTERN.test(row.id || "") ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !["present", "deleted"].includes(state)
  ) {
    throw new TypeError(
      "roster actions require an exact committed ownership witness"
    );
  }
  return Object.freeze({
    ownershipId: row.id,
    ownershipVersion: row.version,
    state,
  });
}

function movementOwnershipWitnesses(result) {
  if (
    !result ||
    !Array.isArray(result.affectedOwnerships) ||
    result.affectedOwnerships.length < 1 ||
    !result.ownership
  ) {
    throw new TypeError(
      "roster actions require every committed movement ownership"
    );
  }
  let previousId = null;
  let includesPrimary = false;
  const witnesses = result.affectedOwnerships.map((row) => {
    const witness = ownershipWitness(row, "present");
    if (
      previousId !== null &&
      witness.ownershipId <= previousId
    ) {
      throw new TypeError(
        "roster movement ownerships must be unique and ordered"
      );
    }
    previousId = witness.ownershipId;
    includesPrimary ||= witness.ownershipId === result.ownership.id;
    return witness;
  });
  if (!includesPrimary) {
    throw new TypeError(
      "roster movement ownerships must include the moved player"
    );
  }
  return Object.freeze(witnesses);
}

function createRosterActionService({
  leagueAuthorization,
  teamAuthorization,
  workspaceRepository,
  rosterMovementRepository,
  buyoutRepository,
  lateLockCoordinator,
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
  assertMethod(
    lateLockCoordinator,
    "coordinateCommittedRoster",
    "a late-lock coordinator"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  async function coordinateCommittedRoster(batch) {
    try {
      return safeLateLockProjection(
        await lateLockCoordinator.coordinateCommittedRoster(batch)
      );
    } catch {
      return AWAITING_DATA_LATE_LOCK;
    }
  }

  async function coordinateMovementAfterCommit({
    mutationKind,
    workspace,
    moved,
  }) {
    try {
      return await coordinateCommittedRoster(
        Object.freeze({
          mutationKind,
          teams: Object.freeze([
            Object.freeze({
              leagueId: workspace.scope.league_id,
              seasonId: workspace.scope.season_id,
              teamId: workspace.scope.team_id,
              ownershipWitnesses:
                movementOwnershipWitnesses(moved),
            }),
          ]),
        })
      );
    } catch {
      return AWAITING_DATA_LATE_LOCK;
    }
  }

  async function coordinateDeletionAfterCommit({
    mutationKind,
    workspace,
    releasedOwnership,
  }) {
    try {
      return await coordinateCommittedRoster(
        Object.freeze({
          mutationKind,
          teams: Object.freeze([
            Object.freeze({
              leagueId: workspace.scope.league_id,
              seasonId: workspace.scope.season_id,
              teamId: workspace.scope.team_id,
              ownershipWitnesses: Object.freeze([
                ownershipWitness(releasedOwnership, "deleted"),
              ]),
            }),
          ]),
        })
      );
    } catch {
      return AWAITING_DATA_LATE_LOCK;
    }
  }

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

  async function moveToInjuredReserve({
    authenticated,
    leagueId,
    teamId,
    ownershipId,
    input,
  } = {}) {
    const submitted = exactObject(input, ["expectedVersion"]);
    const result = await moveRosterPlayer({
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

  async function moveRosterPlayer({
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
    const lateLock = await coordinateMovementAfterCommit({
      mutationKind:
        submitted.destinationCategory === "Injured Reserve"
          ? "injured_reserve_move"
          : "roster_move",
      workspace,
      moved,
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
      lateLock,
    });
  }

  async function buyOutContract({
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
    const lateLock = await coordinateDeletionAfterCommit({
      mutationKind: "buyout",
      workspace,
      releasedOwnership: boughtOut.releasedOwnership,
    });
    return Object.freeze({
      code: "CONTRACT_BOUGHT_OUT",
      buyout: Object.freeze({
        id: boughtOut.obligation.id,
        annualPenaltyCents: boughtOut.annualPenaltyCents,
        remainingYears: boughtOut.years.length,
      }),
      lateLock,
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
