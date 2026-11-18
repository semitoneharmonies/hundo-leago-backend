"use strict";

const { SCORING_CATEGORIES, emptyScoringStats, normalizeScoringStats, calculateExpandedScore, addScoringStats } = require("../domain/statistics/expandedScoringPolicy");

const scoringCategories = Object.freeze(SCORING_CATEGORIES.map(({ key, abbreviation, label }) => Object.freeze({ key, abbreviation, label })));
const STATUSES = new Set(["pending", "partial", "collected", "unavailable"]);

function playerScoringDetails(room, playerId) {
  if (!room.void && room.scoringDetails?.[playerId]) return room.scoringDetails[playerId];
  return { scoringStats: null, statsStatus: room.finished || room.void || Object.hasOwn(room.scores, playerId) ? "unavailable" : "pending",
    gamesCollected: null, gamesExpected: null };
}

function teamScoringDetails(roster) {
  const statsCollection = { collected: 0, partial: 0, pending: 0, unavailable: 0, total: roster.length };
  let scoringStats = null;
  for (const player of roster) {
    statsCollection[player.statsStatus]++;
    if (player.scoringStats) {
      if (!scoringStats) scoringStats = emptyScoringStats();
      addScoringStats(scoringStats, player.scoringStats);
    }
  }
  const statsStatus = roster.length && statsCollection.collected === roster.length ? "collected"
    : scoringStats ? "partial" : statsCollection.unavailable ? "unavailable" : "pending";
  return { scoringStats, statsStatus, statsCollection };
}

function validatedScoringDetails(room, slate, playerStatsById, pointsByPlayerId, final) {
  if (playerStatsById === undefined) return null;
  if (!playerStatsById || typeof playerStatsById !== "object" || Array.isArray(playerStatsById)) {
    throw new TypeError("Daily player scoring details must be a map.");
  }
  const players = new Map(slate.players.map(player => [player.id, player]));
  const result = {};
  for (const { playerId } of room.lots) {
    const entry = playerStatsById[playerId];
    if (!entry || !STATUSES.has(entry.statsStatus) || !Number.isSafeInteger(entry.gamesCollected) ||
        !Number.isSafeInteger(entry.gamesExpected) || entry.gamesCollected < 0 || entry.gamesExpected < entry.gamesCollected ||
        (entry.statsStatus === "collected" && entry.gamesCollected !== entry.gamesExpected) ||
        (entry.statsStatus === "partial" && (!entry.gamesCollected || entry.gamesCollected === entry.gamesExpected)) ||
        (entry.statsStatus === "pending" && (entry.gamesCollected !== 0 || entry.scoringStats !== null)) ||
        (final && entry.statsStatus !== "collected")) {
      throw new TypeError("Daily player collection evidence is incomplete.");
    }
    const scoringStats = entry.scoringStats === null ? null : normalizeScoringStats(entry.scoringStats);
    if (["partial", "collected"].includes(entry.statsStatus) && !scoringStats) {
      throw new TypeError("Collected Daily statistics require every category.");
    }
    const player = players.get(playerId);
    const points = scoringStats ? calculateExpandedScore(scoringStats, player.position === "D" ? "D" : "F").fantasyPointsHundredths : 0;
    if (!Number.isSafeInteger(pointsByPlayerId?.[playerId]) || points !== pointsByPlayerId[playerId] ||
        (room.finished && points !== room.scores[playerId])) {
      throw new TypeError("Daily category totals do not match the authoritative player points.");
    }
    result[playerId] = { scoringStats, statsStatus: entry.statsStatus,
      gamesCollected: entry.gamesCollected, gamesExpected: entry.gamesExpected };
  }
  return result;
}

module.exports = { scoringCategories, playerScoringDetails, teamScoringDetails, validatedScoringDetails };
