const {
  isPlainObject,
  validateCompatibilityLeaguePayload,
} = require("../../../validators/compatibilityLeaguePayload");

function projectCompatibilityLeague({
  storedState,
  body,
  role,
}) {
  const nextMatchups =
    role === "commissioner" &&
    isPlainObject(body.matchups)
      ? body.matchups
      : storedState.matchups;

  return {
    ...storedState,
    teams: body.teams,
    freeAgents: body.freeAgents,
    leagueLog: body.leagueLog,
    tradeProposals: body.tradeProposals,
    tradeBlock: body.tradeBlock,
    matchups: nextMatchups,
    settings:
      body.settings &&
      typeof body.settings === "object"
        ? body.settings
        : storedState.settings || {
            frozen: false,
          },
    nextAuctionDeadline:
      body.nextAuctionDeadline ||
      storedState.nextAuctionDeadline ||
      null,
    lastAutoWeeklySnapshotId:
      storedState.lastAutoWeeklySnapshotId,
    lastAutoAuctionRolloverId:
      storedState.lastAutoAuctionRolloverId,
  };
}

function createSaveCompatibilityLeagueService({
  leagueRepository,
  leagueStore,
  publisher = { publish() {} },
} = {}) {
  const repository =
    leagueRepository || leagueStore;
  if (
    !repository ||
    typeof repository.readLeagueState !== "function" ||
    typeof repository.replaceCompatibilityLeagueState !==
      "function"
  ) {
    throw new TypeError(
      "createSaveCompatibilityLeagueService requires a compatible leagueRepository"
    );
  }

  async function save(body = {}) {
    const storedState = repository.readLeagueState();
    const validation =
      validateCompatibilityLeaguePayload({
        storedState,
        body,
      });
    const nextState = projectCompatibilityLeague({
      storedState,
      body: validation.body,
      role: validation.role,
    });
    const savedBy =
      validation.role === "commissioner"
        ? "commissioner"
        : validation.meta?.actorTeam ||
          "manager";

    await repository.replaceCompatibilityLeagueState(
      nextState,
      {
        savedBy,
      }
    );
    await publisher.publish("league:updated", {
      reason: "saveLeague",
    });

    return { ok: true };
  }

  return { save };
}

module.exports = {
  createSaveCompatibilityLeagueService,
  projectCompatibilityLeague,
};
