const { emptyScoringStats, normalizeScoringStats } = require("../../domain/statistics/expandedScoringPolicy");

const LIVE_STATES = new Set(["LIVE", "CRIT"]);
const FINAL_STATES = new Set(["FINAL", "OFF"]);
const PENALTY_TYPES = new Set(["MIN", "MAJ", "MIS", "GAM", "MAT", "PS", "BEN"]);
const PHYSICAL_FIELDS = Object.freeze({ shotsOnGoal: "sog", hits: "hits", blockedShots: "blockedShots", takeaways: "takeaways", giveaways: "giveaways" });

function fail(message) {
  throw Object.assign(new TypeError(message), { code: "NHL_LIVE_GAME_INCOMPLETE" });
}
function identity(value, label) {
  if (!/^[1-9][0-9]{0,19}$/.test(String(value))) fail(`NHL live ${label} is invalid.`);
  return String(value);
}
function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`NHL live ${label} is missing or invalid.`);
  return value;
}
function gameState(value) {
  if (LIVE_STATES.has(value)) return "live";
  if (FINAL_STATES.has(value)) return "final";
  fail("NHL live statistics require an in-progress or completed game.");
}
function period(value) {
  if (!value || !Number.isSafeInteger(value.number) || value.number < 1 || !["REG", "OT", "SO"].includes(value.periodType)) fail("An NHL live period is invalid.");
  return value;
}
function position(value) {
  if (value === "D") return "D";
  if (["C", "L", "R", "LW", "RW", "F"].includes(value)) return "F";
  if (value === "G") return "G";
  fail("An NHL live player position is invalid.");
}

// A pure replacement snapshot, not an event accumulator. Replaying corrected
// provider responses must remove withdrawn goals/assists as well as add events.
// Boxscore supplies physical counts, landing supplies official goal strength,
// and play-by-play supplies assist order and attributed penalty infractions.
function normalizeNhlLiveGame({ playByPlay, boxscore, landing } = {}) {
  const gameId = identity(playByPlay?.id, "game identity");
  const nhlSeasonKey = String(playByPlay?.season);
  if (!/^\d{8}$/.test(nhlSeasonKey) || Number(nhlSeasonKey.slice(4)) !== Number(nhlSeasonKey.slice(0, 4)) + 1 || playByPlay.gameType !== 2) fail("NHL live statistics require a regular-season game.");
  const startsAtMs = Date.parse(playByPlay.startTimeUTC);
  if (!Number.isSafeInteger(startsAtMs) || startsAtMs < 0) fail("An NHL live game start is invalid.");
  const state = gameState(playByPlay.gameState);
  const sides = ["awayTeam", "homeTeam"];
  const teamIds = sides.map(side => identity(playByPlay[side]?.id, "team identity"));
  if (new Set(teamIds).size !== 2) fail("An NHL live game repeats a team.");
  const scores = sides.map(side => count(playByPlay[side]?.score, "team score"));
  for (const source of [playByPlay, boxscore, landing]) {
    if (!source || identity(source.id, "source game") !== gameId || String(source.season) !== nhlSeasonKey || source.gameType !== 2 ||
        Date.parse(source.startTimeUTC) !== startsAtMs || gameState(source.gameState) !== state || source.gameScheduleState === "PPD" || source.limitedScoring === true) fail("NHL live source identities or game states disagree.");
    for (let index = 0; index < sides.length; index += 1) {
      const side = sides[index];
      if (identity(source[side]?.id, "source team") !== teamIds[index] || count(source[side]?.score, "source score") !== scores[index]) fail("NHL live source teams or scores disagree.");
    }
  }
  if (!Array.isArray(playByPlay.rosterSpots) || !Array.isArray(playByPlay.plays) || !Array.isArray(landing.summary?.scoring)) fail("NHL live roster, events or goal classifications are incomplete.");

  const roster = new Map();
  for (const row of playByPlay.rosterSpots) {
    const id = identity(row.playerId, "roster player");
    const teamId = identity(row.teamId, "roster team");
    if (roster.has(id) || !teamIds.includes(teamId)) fail("NHL live roster identities are inconsistent.");
    roster.set(id, { teamId, positionGroup: position(row.positionCode) });
  }
  const players = new Map();
  const boxRows = new Map();
  for (let index = 0; index < sides.length; index += 1) {
    const team = boxscore.playerByGameStats?.[sides[index]];
    if (!Array.isArray(team?.forwards) || !Array.isArray(team?.defense)) fail("An NHL live team boxscore is incomplete.");
    const rows = [...team.forwards, ...team.defense];
    if (rows.length < 15 || rows.length > 20) fail("An NHL live boxscore has incomplete skater coverage.");
    for (const row of rows) {
      const id = identity(row.playerId, "boxscore player");
      const registered = roster.get(id);
      if (players.has(id) || !registered || registered.teamId !== teamIds[index] || registered.positionGroup === "G" || position(row.position) !== registered.positionGroup) fail("NHL live roster and boxscore disagree.");
      const scoringStats = emptyScoringStats();
      for (const [category, field] of Object.entries(PHYSICAL_FIELDS)) scoringStats[category] = count(row[field], field);
      const goals = count(row.goals, "boxscore goals"), assists = count(row.assists, "boxscore assists");
      if (count(row.points, "boxscore points") !== goals + assists || typeof row.toi !== "string" || !/^\d{1,3}:[0-5]\d$/.test(row.toi)) fail("NHL live boxscore totals or participation are invalid.");
      const played = row.toi.split(":").some(part => Number(part) > 0) || goals + assists > 0 || Object.values(scoringStats).some(value => value > 0);
      players.set(id, { providerPlayerId: id, providerTeamId: registered.teamId, positionGroup: registered.positionGroup, gamesPlayed: Number(played), scoringStats });
      boxRows.set(id, { goals, assists });
    }
  }

  function actor(value, category, expectedTeam = null) {
    const id = identity(value, "event player");
    const registered = roster.get(id);
    if (!registered || (expectedTeam !== null && registered.teamId !== expectedTeam)) fail("An NHL live event has an unknown or mismatched player.");
    if (registered.positionGroup === "G") return null;
    const player = players.get(id);
    if (!player) fail("An NHL live event player is absent from the complete boxscore.");
    player.scoringStats[category] += 1;
    player.gamesPlayed = 1;
    return player;
  }

  const goals = new Map();
  for (const section of landing.summary.scoring) {
    const descriptor = period(section.periodDescriptor);
    if (!Array.isArray(section.goals)) fail("NHL live goal classifications are missing.");
    if (descriptor.periodType === "SO") continue;
    for (const goal of section.goals) {
      const eventId = identity(goal.eventId, "goal event");
      if (goals.has(eventId) || !["ev", "pp", "sh"].includes(goal.strength) || typeof goal.goalModifier !== "string" || !Array.isArray(goal.assists) || goal.assists.length > 2) fail("NHL live goal classification is invalid or duplicated.");
      goals.set(eventId, { ...goal, periodNumber: descriptor.number, periodType: descriptor.periodType });
    }
  }
  const seenEvents = new Set(), seenGoals = new Set(), scoringEvents = [];
  const goalCounts = new Map(teamIds.map(id => [id, 0]));
  for (const event of playByPlay.plays) {
    const eventId = identity(event.eventId, "event identity");
    if (seenEvents.has(eventId)) fail("NHL live play-by-play repeats an event.");
    seenEvents.add(eventId);
    const descriptor = period(event.periodDescriptor);
    if (descriptor.periodType === "SO") continue;
    if (!["goal", "penalty"].includes(event.typeDescKey)) continue;
    const details = event.details;
    const owner = identity(details?.eventOwnerTeamId, "event team");
    if (!teamIds.includes(owner)) fail("An NHL live event belongs to an unknown team.");
    if (event.typeDescKey === "penalty") {
      if (!PENALTY_TYPES.has(details.typeCode)) fail("An NHL live penalty type is unsupported.");
      count(details.duration, "penalty duration");
      // A penalty shot draws an infraction but NHL's skater penalties count
      // excludes its zero-minute offender entry. Never charge the serving player.
      if (details.committedByPlayerId != null) {
        if (details.typeCode !== "PS") actor(details.committedByPlayerId, "penaltiesTaken", owner);
        else if (roster.get(identity(details.committedByPlayerId, "penalty-shot offender"))?.teamId !== owner) fail("An NHL penalty-shot offender is invalid.");
      } else if (details.servedByPlayerId != null) {
        if (roster.get(identity(details.servedByPlayerId, "serving player"))?.teamId !== owner) fail("An NHL bench-penalty serving player is invalid.");
      } else if (!/bench|too-many/i.test(details.descKey || "")) fail("An NHL live penalty has no attributed offender or bench disposition.");
      if (details.drawnByPlayerId != null) actor(details.drawnByPlayerId, "penaltiesDrawn", teamIds.find(id => id !== owner));
      continue;
    }

    const goal = goals.get(eventId);
    if (!goal || goal.periodNumber !== descriptor.number || goal.periodType !== descriptor.periodType || goal.timeInPeriod !== event.timeInPeriod || identity(goal.playerId, "goal scorer") !== identity(details.scoringPlayerId, "event scorer")) fail("NHL live goal classifications and play-by-play disagree.");
    const ownerSide = sides[teamIds.indexOf(owner)];
    if (goal.teamAbbrev?.default !== playByPlay[ownerSide].abbrev) fail("An NHL live goal has an inconsistent team.");
    const assists = [details.assist1PlayerId, details.assist2PlayerId].filter(value => value != null).map(value => identity(value, "assist player"));
    if ((details.assist2PlayerId != null && details.assist1PlayerId == null) || new Set(assists).size !== assists.length || assists.includes(String(details.scoringPlayerId)) ||
        JSON.stringify(assists) !== JSON.stringify(goal.assists.map(row => identity(row.playerId, "classified assist player")))) fail("NHL live assist order or attribution is inconsistent.");
    const category = ["ps", "penalty-shot"].includes(goal.goalModifier) ? "evenStrengthGoals" : { ev: "evenStrengthGoals", pp: "powerPlayGoals", sh: "shortHandedGoals" }[goal.strength];
    actor(details.scoringPlayerId, category, owner);
    assists.forEach((id, index) => actor(id, index === 0 ? "primaryAssists" : "secondaryAssists", owner));
    seenGoals.add(eventId);
    goalCounts.set(owner, goalCounts.get(owner) + 1);
    scoringEvents.push({ owner, scorer: details.scoringPlayerId, ownerScore: count(details[ownerSide === "homeTeam" ? "homeScore" : "awayScore"], "goal score") });
  }
  if (seenGoals.size !== goals.size) fail("NHL live goal coverage is incomplete.");
  const shootout = playByPlay.gameOutcome?.lastPeriodType === "SO" || playByPlay.periodDescriptor?.periodType === "SO";
  const shootoutWinner = state === "final" && shootout ? (scores[0] > scores[1] ? 0 : 1) : -1;
  for (let index = 0; index < teamIds.length; index += 1) {
    if (goalCounts.get(teamIds[index]) !== scores[index] - Number(index === shootoutWinner)) fail("NHL live goal events and scoreboard totals disagree.");
  }
  if (state === "final") {
    if (scores[0] === scores[1]) fail("A completed NHL game has tied scores.");
    if (!shootout) {
      const winner = scores[0] > scores[1] ? 0 : 1;
      const winningGoals = scoringEvents.filter(goal => goal.owner === teamIds[winner] && goal.ownerScore === scores[1 - winner] + 1);
      if (winningGoals.length !== 1) fail("An NHL game-winning goal cannot be identified uniquely.");
      actor(winningGoals[0].scorer, "gameWinningGoals", teamIds[winner]);
    }
  }
  for (const player of players.values()) {
    const stats = player.scoringStats, box = boxRows.get(player.providerPlayerId);
    if (stats.evenStrengthGoals + stats.powerPlayGoals + stats.shortHandedGoals !== box.goals || stats.primaryAssists + stats.secondaryAssists !== box.assists) fail("NHL live player goals or assists disagree with the boxscore.");
    player.scoringStats = normalizeScoringStats(stats);
    Object.freeze(player);
  }
  return Object.freeze({ gameId, nhlSeasonKey, startsAtMs, state,
    playerGames: Object.freeze([...players.values()].sort((a, b) => a.providerPlayerId.localeCompare(b.providerPlayerId))),
    pendingReasons: Object.freeze(state === "live" ? ["game_winning_goal_pending"] : []) });
}

module.exports = { normalizeNhlLiveGame };
