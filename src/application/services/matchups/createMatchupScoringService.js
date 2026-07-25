const {
  calculateTeamLiveScore,
  describeLiveSource,
} = require("../../../domain/matchups/matchupScoringPolicy");

const MATCHUP_SCORING_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_SCORING_CONTEXT_MISSING",
  stateInvalid: "MATCHUP_SCORING_STATE_INVALID",
  locksIncomplete: "MATCHUP_SCORING_LOCKS_INCOMPLETE",
  statisticsMissing: "MATCHUP_SCORING_STATISTICS_MISSING",
});

class MatchupScoringServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupScoringServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupScoringServiceError(code, message);
}

function createMatchupScoringService({ repository } = {}) {
  if (!repository || typeof repository.readContext !== "function") {
    throw new TypeError("createMatchupScoringService requires a scoring repository");
  }

  function readScore(input, allowedStatuses) {
    const context = repository.readContext(input);
    if (!context) fail(MATCHUP_SCORING_SERVICE_CODES.contextMissing, "The matchup was not found.");
    if (!allowedStatuses.has(context.matchup.status)) {
      fail(MATCHUP_SCORING_SERVICE_CODES.stateInvalid, "The matchup is not score-readable.");
    }
    if (context.locks.length !== 2) {
      fail(MATCHUP_SCORING_SERVICE_CODES.locksIncomplete, "Both team lock decisions are required.");
    }
    if (!context.refresh) {
      fail(MATCHUP_SCORING_SERVICE_CODES.statisticsMissing, "No successful live statistics are available.");
    }
    const source = describeLiveSource({
      nowMs: input.nowMs,
      completedAtMs: context.refresh.completed_at_ms,
    });
    const lockByTeam = new Map(context.locks.map((lock) => [lock.team_id, lock]));
    const playersByLock = new Map();
    for (const player of context.lockedPlayers) {
      const list = playersByLock.get(player.matchup_roster_lock_id) || [];
      list.push(player);
      playersByLock.set(player.matchup_roster_lock_id, list);
    }
    const score = (teamId) => {
      const lock = lockByTeam.get(teamId);
      if (!lock) fail(MATCHUP_SCORING_SERVICE_CODES.locksIncomplete, "A team lock is missing.");
      return calculateTeamLiveScore({
        lock,
        lockedPlayers: playersByLock.get(lock.id) || [],
        currentTotals: context.totals,
      });
    };
    return Object.freeze({
      matchupId: context.matchup.id,
      status: context.matchup.status,
      source: Object.freeze({
        refreshId: context.refresh.id,
        completedAtMs: context.refresh.completed_at_ms,
        ...source,
      }),
      home: score(context.matchup.home_team_id),
      away: score(context.matchup.away_team_id),
    });
  }

  function readLive(input) {
    return readScore(input, new Set(["live", "awaiting_data"]));
  }

  function readAtRefresh(input) {
    if (input?.refreshId === undefined) {
      fail(
        MATCHUP_SCORING_SERVICE_CODES.statisticsMissing,
        "A finalized statistics refresh is required."
      );
    }
    return readScore(input, new Set(["final"]));
  }

  return Object.freeze({ readAtRefresh, readLive });
}

module.exports = {
  MATCHUP_SCORING_SERVICE_CODES,
  MatchupScoringServiceError,
  createMatchupScoringService,
};
