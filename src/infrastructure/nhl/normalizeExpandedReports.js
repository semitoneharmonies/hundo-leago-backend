const { normalizeScoringStats } = require("../../domain/statistics/expandedScoringPolicy");

function fail(message) {
  throw Object.assign(new Error(message), { code: "NHL_EXPANDED_REPORT_INCOMPLETE" });
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`NHL ${label} is missing or invalid.`);
  return value;
}
function pair(row) {
  if (!/^[1-9][0-9]+$/.test(String(row?.gameId)) || !/^[1-9][0-9]+$/.test(String(row?.playerId))) fail("NHL category identity is invalid.");
  return `${row.gameId}:${row.playerId}`;
}
function index(rows) {
  if (!Array.isArray(rows)) fail("An NHL category report is unavailable.");
  const result = new Map();
  for (const row of rows) {
    const key = pair(row);
    if (result.has(key)) fail("An NHL category report contains duplicate player-games.");
    result.set(key, row);
  }
  return result;
}

// All four reports are keyed by game and player; totals are never joined by
// display name or NHL team, both of which may change during a season.
function normalizeExpandedReports({ summary, realtime, scoring, penalties, penaltyShots = [], penaltyShotLandings = [] }) {
  const summaries = index(summary);
  const reports = [index(realtime), index(scoring), index(penalties)];
  const penaltyShotRows = index(penaltyShots);
  if ([...penaltyShotRows.keys()].some(key => !summaries.has(key))) fail("NHL penalty shots contain an unknown player-game.");
  if (reports.some((report) => report.size !== summaries.size)) fail("NHL category reports have different player-game coverage.");
  const result = new Map();
  for (const [key, row] of summaries) {
    const [physical, assists, infractions] = reports.map((report) => report.get(key));
    if (!physical || !assists || !infractions || [row, physical, assists, infractions].some((item) => item.gamesPlayed !== 1 || item.teamAbbrev !== row.teamAbbrev || item.opponentTeamAbbrev !== row.opponentTeamAbbrev || item.homeRoad !== row.homeRoad)) fail("NHL category reports disagree on a player-game.");
    const stats = {
      evenStrengthGoals: integer(row.evGoals, "even-strength goals"),
      powerPlayGoals: integer(row.ppGoals, "power-play goals"),
      shortHandedGoals: integer(row.shGoals, "shorthanded goals"),
      gameWinningGoals: integer(row.gameWinningGoals, "game-winning goals"),
      primaryAssists: integer(assists.totalPrimaryAssists, "primary assists"),
      secondaryAssists: integer(assists.totalSecondaryAssists, "secondary assists"),
      shotsOnGoal: integer(row.shots, "shots on goal"),
      hits: integer(physical.hits, "hits"),
      blockedShots: integer(physical.blockedShots, "blocked shots"),
      takeaways: integer(physical.takeaways, "takeaways"),
      giveaways: integer(physical.giveaways, "giveaways"),
      penaltiesDrawn: integer(infractions.penaltiesDrawn, "penalties drawn"),
      penaltiesTaken: integer(infractions.penalties, "penalties taken"),
    };
    if (stats.evenStrengthGoals + stats.powerPlayGoals + stats.shortHandedGoals !== row.goals ||
        stats.primaryAssists + stats.secondaryAssists !== row.assists ||
        assists.goals !== row.goals || assists.assists !== row.assists ||
        infractions.goals !== row.goals || infractions.assists !== row.assists ||
        stats.shotsOnGoal < row.goals || stats.gameWinningGoals > 1 || stats.gameWinningGoals > row.goals) fail("NHL category reports do not reconcile with goals and assists.");
    result.set(key, stats);
  }
  // NHL summary can label a successful penalty shot SH/PP. The approved
  // fantasy rule awards every penalty-shot goal the even-strength value.
  const landings = new Map(penaltyShotLandings.map((report) => [String(report.id), report]));
  if (landings.size !== penaltyShotLandings.length) fail("NHL penalty-shot goal reports are duplicated.");
  for (const row of penaltyShotRows.values()) {
    const goals = integer(row.penaltyShotsGoals, "penalty-shot goals");
    if (goals === 0) continue;
    const stats = result.get(pair(row));
    const landing = landings.get(String(row.gameId));
    if (!stats || !landing || !["OFF", "FINAL"].includes(landing.gameState) || !Array.isArray(landing.summary?.scoring)) fail("A scored penalty shot has no complete goal classification.");
    const shotGoals = landing.summary.scoring.filter((period) => period.periodDescriptor?.periodType !== "SO").flatMap((period) => period.goals || []).filter((goal) => goal.playerId === row.playerId && ["ps", "penalty-shot"].includes(goal.goalModifier));
    if (shotGoals.length !== goals) fail("NHL penalty-shot reports disagree.");
    for (const goal of shotGoals) {
      const key = { ev: "evenStrengthGoals", pp: "powerPlayGoals", sh: "shortHandedGoals" }[goal.strength];
      if (!key || stats[key] < 1) fail("A scored penalty shot has an invalid original goal category.");
      stats[key] -= 1;
      stats.evenStrengthGoals += 1;
    }
  }
  for (const [key, stats] of result) result.set(key, normalizeScoringStats(stats));
  return result;
}

module.exports = { normalizeExpandedReports };
