const { addScoringStats, emptyScoringStats, normalizeScoringStats, calculateExpandedScore } = require("../domain/statistics/expandedScoringPolicy");
const { teamScoringDetails } = require("./dailyScoring");
const { vancouverDate } = require("./vancouverDate");
const { dailyTeamScore } = require("./dailyTeamScore");

// Presentation only: never calls the provider, writes a score, awards winners,
// changes a bid, or supplies input to settlement. It joins the latest replacement
// game snapshots to this room's saved slate and signed roster.
function createDailyLiveDisplay({ liveStatistics } = {}) {
  if (!liveStatistics || typeof liveStatistics.readSnapshot !== "function") throw new TypeError("Daily live display requires a read-only live cache.");
  function project({ room, slate }) {
    if (room.phase !== "locked") return room;
    try {
      const snapshot = liveStatistics.readSnapshot();
      if (!snapshot?.enabled) return room;
      const status = snapshot.status === "available" ? "fresh" : snapshot.status === "stale" ? "stale" : "unavailable";
      const live = { status, updatedAtMs: snapshot.updatedAtMs ?? null, lastAttemptAtMs: snapshot.lastAttemptAtMs ?? null,
        provisional: true, provisionalGameCount: 0, gameIds: [] };
      if (status === "unavailable") return { ...room, live };
      if (slate.date !== room.date || !Array.isArray(slate.games)) throw new TypeError("Daily live slate is incomplete.");
      const savedGames = new Map(slate.games.map(game => [String(game.id), game]));
      if (savedGames.size !== slate.games.length) throw new TypeError("Daily slate repeats a game.");
      const candidates = new Map();
      for (const game of snapshot.games || []) {
        const saved = savedGames.get(game.gameId);
        if (!saved || saved.excluded || saved.gameType !== 2 || !["live", "final"].includes(game.state)) continue;
        if (game.nhlSeasonKey !== saved.season || game.startsAtMs !== saved.startsAtMs || vancouverDate(game.startsAtMs) !== room.date) continue;
        if (candidates.has(game.gameId) || !Array.isArray(game.playerGames)) throw new TypeError("Daily live game coverage is ambiguous.");
        const players = new Map();
        for (const player of game.playerGames) {
          if (typeof player.providerPlayerId !== "string" || players.has(player.providerPlayerId)) throw new TypeError("Daily live player identity is ambiguous.");
          players.set(player.providerPlayerId, player);
        }
        candidates.set(game.gameId, { saved, players });
      }
      const usedGames = new Set();
      let missingOfficialCoverage = false;
      const members = room.members.map(member => {
        let changed = false;
        const roster = member.roster.map(player => {
          // Persisted partial totals from before this feature do not identify their
          // constituent games. Wait for the ordinary final-data refresh to add IDs.
          if (player.statsStatus === "unavailable" || (player.gamesCollected > 0 && !Array.isArray(player.collectedGameIds))) {
            missingOfficialCoverage = true;
            return player;
          }
          // This includes a confirmed zero-game day after a cancellation or move;
          // an older cache snapshot cannot reopen official player-day collection.
          if (player.statsStatus === "collected") return player;
          const accepted = new Set(player.collectedGameIds || []);
          if (accepted.size !== (player.collectedGameIds?.length || 0) ||
              (Array.isArray(player.collectedGameIds) && accepted.size !== player.gamesCollected)) throw new TypeError("Daily official game coverage is invalid.");
          const extra = emptyScoringStats(), gameIds = [];
          for (const [gameId, { saved, players }] of candidates) {
            if (accepted.has(gameId)) continue;
            const teamId = player.team === saved.homeTeam ? saved.homeTeamId : player.team === saved.awayTeam ? saved.awayTeamId : null;
            if (teamId === null) continue;
            const row = players.get(player.id);
            if (!row) continue; // A confirmed scratch contributes no live category events.
            if (row.providerTeamId !== String(teamId) || ![0, 1].includes(row.gamesPlayed)) throw new TypeError("Daily live player-game binding is invalid.");
            const stats = normalizeScoringStats(row.scoringStats);
            if (!row.gamesPlayed && Object.values(stats).some(value => value !== 0)) throw new TypeError("Daily live nonparticipant has statistics.");
            if (!row.gamesPlayed) continue;
            addScoringStats(extra, stats);
            gameIds.push(gameId);
          }
          if (!gameIds.length) return player;
          const officialStats = player.scoringStats ? normalizeScoringStats(player.scoringStats) : emptyScoringStats();
          const position = player.position === "D" ? "D" : "F";
          const officialPoints = calculateExpandedScore(officialStats, position).fantasyPointsHundredths / 100;
          if (officialPoints !== player.points) throw new TypeError("Daily official points and categories disagree.");
          const stats = { ...officialStats }; addScoringStats(stats, extra);
          const calculation = calculateExpandedScore(stats, position);
          changed = true;
          for (const id of gameIds) usedGames.add(id);
          return { ...player, points: calculation.fantasyPointsHundredths / 100, scoringStats: calculation.scoringStats,
            live: { provisional: true, officialPoints: player.points, gameIds: gameIds.sort() } };
        });
        if (!changed) return member;
        const pointsHundredths = roster.reduce((total, player) => total + Math.round(player.points * 100), 0);
        return { ...member, roster, ...dailyTeamScore(room, pointsHundredths, member.spent),
          ...teamScoringDetails(roster), live: { provisional: true, officialPoints: member.points } };
      });
      live.gameIds = [...usedGames].sort();
      live.provisionalGameCount = usedGames.size;
      if (missingOfficialCoverage) live.pendingReasons = ["official_game_coverage_pending"];
      return { ...room, members, live };
    } catch {
      return { ...room, live: { status: "unavailable", updatedAtMs: null, lastAttemptAtMs: null,
        provisional: true, provisionalGameCount: 0, gameIds: [] } };
    }
  }
  return Object.freeze({ project });
}

module.exports = { createDailyLiveDisplay };
