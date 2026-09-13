const {
  resolveCompatibilityAuctions,
} = require("../../../domain/auctions/resolveCompatibilityAuctions");

function createResolveCompatibilityAuctionsService({
  leagueStore,
  publisher = { publish() {} },
  createLogId = ({ nowMs }) =>
    nowMs + Math.random(),
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createResolveCompatibilityAuctionsService requires a leagueStore"
    );
  }

  async function resolve({
    nowMs,
    rolloverId,
  } = {}) {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError(
        "auction resolution requires a finite nowMs"
      );
    }
    if (!rolloverId) {
      throw new TypeError(
        "auction resolution requires a rolloverId"
      );
    }

    const state = leagueStore.loadLeague();
    if (
      state.lastAutoAuctionRolloverId ===
      rolloverId
    ) {
      return {
        status: "skipped",
        reason: "alreadyResolved",
        rolloverId,
        signings: 0,
      };
    }

    const {
      nextTeams,
      nextFreeAgents,
      nextLeagueLog,
      newLogs,
    } = resolveCompatibilityAuctions({
      state,
      nowMs,
      createLogId,
    });
    const nextState = {
      ...state,
      teams: nextTeams,
      freeAgents: nextFreeAgents,
      leagueLog: nextLeagueLog,
      lastAutoAuctionRolloverId: rolloverId,
    };

    await leagueStore.saveLeague(nextState, {
      savedBy: "system:autoAuctionRollover",
    });
    await publisher.publish("league:updated", {
      reason: "autoAuctionRollover",
      rolloverId,
    });

    return {
      status: "succeeded",
      rolloverId,
      signings: newLogs.length,
      newLogs,
    };
  }

  return { resolve };
}

module.exports = {
  createResolveCompatibilityAuctionsService,
};
