const BUYOUT_LOCK_MS =
  14 * 24 * 60 * 60 * 1000;

function compatibilityAuctionKey(bid) {
  return String(
    bid?.auctionKey ||
      String(bid?.player || "")
        .trim()
        .toLowerCase()
  )
    .trim()
    .toLowerCase();
}

function sortCompatibilityRoster(roster) {
  roster.sort((left, right) => {
    const leftIsDefense =
      (left?.position || "F") === "D";
    const rightIsDefense =
      (right?.position || "F") === "D";
    if (leftIsDefense !== rightIsDefense) {
      return leftIsDefense ? 1 : -1;
    }

    const leftSalary = Number(left?.salary) || 0;
    const rightSalary =
      Number(right?.salary) || 0;
    if (rightSalary !== leftSalary) {
      return rightSalary - leftSalary;
    }

    return String(left?.name || "").localeCompare(
      String(right?.name || "")
    );
  });
  return roster;
}

function resolveCompatibilityAuctions({
  state,
  nowMs,
  createLogId = () => nowMs + Math.random(),
} = {}) {
  const teams = Array.isArray(state?.teams)
    ? state.teams
    : [];
  const bids = Array.isArray(state?.freeAgents)
    ? state.freeAgents
    : [];
  const leagueLog = Array.isArray(state?.leagueLog)
    ? state.leagueLog
    : [];
  const activeBids = bids.filter(
    (bid) => !bid.resolved
  );

  if (activeBids.length === 0) {
    return {
      nextTeams: teams,
      nextFreeAgents: bids,
      nextLeagueLog: leagueLog,
      newLogs: [],
    };
  }

  const bidsByPlayer = new Map();
  for (const bid of activeBids) {
    const key = compatibilityAuctionKey(bid);
    if (!key) continue;
    if (!bidsByPlayer.has(key)) {
      bidsByPlayer.set(key, []);
    }
    bidsByPlayer.get(key).push(bid);
  }

  const nextTeams = teams.map((team) => ({
    ...team,
    roster: [...(team.roster || [])],
    buyouts: [...(team.buyouts || [])],
  }));
  const resolvedBidIds = new Set();
  const newLogs = [];

  for (const playerBids of bidsByPlayer.values()) {
    const sorted = [...playerBids].sort(
      (left, right) => {
        const leftAmount =
          Number(left.amount) || 0;
        const rightAmount =
          Number(right.amount) || 0;
        if (rightAmount !== leftAmount) {
          return rightAmount - leftAmount;
        }

        const leftTimestamp =
          left.timestamp || 0;
        const rightTimestamp =
          right.timestamp || 0;
        return leftTimestamp - rightTimestamp;
      }
    );
    const winner = sorted[0];
    if (!winner) continue;

    for (const bid of playerBids) {
      resolvedBidIds.add(bid.id);
    }

    const teamIndex = nextTeams.findIndex(
      (team) => team.name === winner.team
    );
    if (teamIndex === -1) continue;

    const playerName = winner.player;
    const winningTeamName = winner.team;
    const newSalary =
      Number(winner.amount) || 0;
    const position = winner.position || "F";

    nextTeams[teamIndex].roster.push({
      name: playerName,
      salary: newSalary,
      position,
      buyoutLockedUntil:
        nowMs + BUYOUT_LOCK_MS,
    });
    sortCompatibilityRoster(
      nextTeams[teamIndex].roster
    );

    newLogs.push({
      type: "faSigned",
      id: createLogId({
        nowMs,
        winner,
        signingIndex: newLogs.length,
      }),
      team: winningTeamName,
      player: playerName,
      amount: newSalary,
      position,
      timestamp: nowMs,
    });
  }

  return {
    nextTeams,
    nextFreeAgents: bids.filter(
      (bid) => !resolvedBidIds.has(bid.id)
    ),
    nextLeagueLog: [...newLogs, ...leagueLog],
    newLogs,
  };
}

module.exports = {
  BUYOUT_LOCK_MS,
  compatibilityAuctionKey,
  resolveCompatibilityAuctions,
  sortCompatibilityRoster,
};
