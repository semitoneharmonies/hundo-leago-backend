const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeNhlLiveGame } = require("../../src/infrastructure/nhl/normalizeLiveGame");
const { normalizeExpandedReports } = require("../../src/infrastructure/nhl/normalizeExpandedReports");
const { CATEGORY_KEYS, calculateExpandedScore } = require("../../src/domain/statistics/expandedScoringPolicy");

function captured(id) {
  return structuredClone({
    playByPlay: require(`../fixtures/nhl-live/${id}-play-by-play.json`),
    boxscore: require(`../fixtures/nhl-live/${id}-boxscore.json`),
    landing: require(`../fixtures/nhl-live/${id}-landing.json`),
  });
}
function player(result, id) { return result.playerGames.find(row => row.providerPlayerId === String(id)); }
function boxPlayer(input, id) {
  return ["awayTeam", "homeTeam"].flatMap(side => [...input.boxscore.playerByGameStats[side].forwards, ...input.boxscore.playerByGameStats[side].defense]).find(row => row.playerId === id);
}
function blank() {
  const input = captured("2026020344");
  input.playByPlay.plays = [];
  input.landing.summary.scoring = [];
  for (const source of Object.values(input)) {
    source.gameState = "LIVE";
    source.awayTeam.score = 0;
    source.homeTeam.score = 0;
  }
  for (const side of ["awayTeam", "homeTeam"]) {
    for (const row of [...input.boxscore.playerByGameStats[side].forwards, ...input.boxscore.playerByGameStats[side].defense]) {
      for (const key of ["goals", "assists", "points", "sog", "hits", "blockedShots", "takeaways", "giveaways"]) row[key] = 0;
    }
  }
  return input;
}
function addGoal(input, { eventId = 1, scorer = 8482078, assists = [], strength = "ev", modifier = "none", owner = 17, goalShot = true } = {}) {
  const side = owner === input.playByPlay.homeTeam.id ? "homeTeam" : "awayTeam";
  for (const source of Object.values(input)) source[side].score += 1;
  const descriptor = { number: 1, periodType: "REG" };
  const details = { scoringPlayerId: scorer, eventOwnerTeamId: owner,
    awayScore: input.playByPlay.awayTeam.score, homeScore: input.playByPlay.homeTeam.score,
    ...(assists[0] ? { assist1PlayerId: assists[0] } : {}), ...(assists[1] ? { assist2PlayerId: assists[1] } : {}) };
  input.playByPlay.plays.push({ eventId, periodDescriptor: descriptor, timeInPeriod: "01:00", typeDescKey: "goal", details });
  input.landing.summary.scoring.push({ periodDescriptor: descriptor, goals: [{ eventId, playerId: scorer, teamAbbrev: { default: input.playByPlay[side].abbrev },
    strength, goalModifier: modifier, timeInPeriod: "01:00", assists: assists.map(playerId => ({ playerId })) }] });
  const row = boxPlayer(input, scorer); row.goals += 1; row.points += 1; if (goalShot) row.sog += 1;
  for (const id of assists) { const assist = boxPlayer(input, id); assist.assists += 1; assist.points += 1; }
}
function addPenalty(input, details, eventId = input.playByPlay.plays.length + 100) {
  input.playByPlay.plays.push({ eventId, periodDescriptor: { number: 1, periodType: "REG" }, typeDescKey: "penalty", details });
}
function invalid(input, pattern) {
  assert.throws(() => normalizeNhlLiveGame(input), error => error.code === "NHL_LIVE_GAME_INCOMPLETE" && pattern.test(error.message));
}

test("a captured in-progress NHL game provides all categories without a premature game-winning bonus", () => {
  const input = captured("2026020344"), before = JSON.stringify(input);
  const result = normalizeNhlLiveGame(input);
  assert.equal(result.gameId, "2026020344");
  assert.equal(result.nhlSeasonKey, "20262027");
  assert.equal(result.state, "live");
  assert.equal(result.playerGames.length, 36);
  assert.deepEqual(result.pendingReasons, ["game_winning_goal_pending"]);
  assert.equal(player(result, 8482078).scoringStats.evenStrengthGoals, 1);
  assert.equal(player(result, 8477429).scoringStats.primaryAssists, 1);
  assert.equal(player(result, 8478434).scoringStats.secondaryAssists, 1);
  for (const row of result.playerGames) {
    assert.deepEqual(Object.keys(row.scoringStats), CATEGORY_KEYS);
    assert.equal(row.scoringStats.gameWinningGoals, 0);
    assert.ok(Number.isSafeInteger(calculateExpandedScore(row.scoringStats, row.positionGroup).fantasyPointsHundredths));
  }
  assert.equal(JSON.stringify(input), before, "normalization must not mutate provider responses");
});

test("all 468 category values for a captured game match independent official completed-game reports", () => {
  const game = require("../fixtures/nhlExpandedScoringGames.json").games.find(row => row.gameId === 2025020477);
  const official = normalizeExpandedReports({ summary: game.summary, realtime: game.realtime, scoring: game.scoringpergame,
    penalties: game.penalties, penaltyShots: game.penaltyShots, penaltyShotLandings: game.penaltyShotLandings });
  const live = normalizeNhlLiveGame(captured("2025020477"));
  assert.equal(live.state, "final");
  assert.equal(live.playerGames.length, official.size);
  for (const row of live.playerGames) assert.deepEqual(row.scoringStats, official.get(`${live.gameId}:${row.providerPlayerId}`), row.providerPlayerId);
  const farabee = player(live, 8480797).scoringStats;
  assert.equal(farabee.evenStrengthGoals, 1);
  assert.equal(farabee.shortHandedGoals, 0);
  assert.equal(farabee.penaltiesDrawn, 1);
  assert.equal(player(live, 8484223).scoringStats.penaltiesTaken, 0, "a PS offender entry is excluded from the official penalty count");
  assert.equal(player(live, 8474141).scoringStats.penaltiesTaken, 0, "serving a goalie's penalty does not make it the skater's penalty");
});

test("an actual awarded empty-net goal keeps its zero SOG and official even-strength classification", () => {
  const result = normalizeNhlLiveGame(captured("2026020134"));
  const howden = player(result, 8479353).scoringStats;
  assert.equal(howden.evenStrengthGoals, 1);
  assert.equal(howden.shortHandedGoals, 0);
  assert.equal(howden.shotsOnGoal, 0);
  assert.equal(player(result, 8475913).scoringStats.gameWinningGoals, 1);
  assert.deepEqual(result.pendingReasons, []);
});

test("replaying a corrected snapshot removes a withdrawn goal and both assist credits", () => {
  const initial = blank();
  addGoal(initial, { assists: [8477429, 8478434], strength: "pp" });
  const first = normalizeNhlLiveGame(initial);
  assert.equal(player(first, 8482078).scoringStats.powerPlayGoals, 1);
  const corrected = normalizeNhlLiveGame(blank());
  for (const id of [8482078, 8477429, 8478434]) assert.ok(Object.values(player(corrected, id).scoringStats).every(value => value === 0));
  assert.equal(player(first, 8482078).scoringStats.powerPlayGoals, 1, "a later snapshot cannot mutate an earlier one");
});

test("double minors count once, misconducts separately, and bench/goalie service is not charged to a skater", () => {
  const input = blank(), goalie = input.playByPlay.rosterSpots.find(row => row.teamId === 17 && row.positionCode === "G").playerId;
  addPenalty(input, { typeCode: "MIN", duration: 4, committedByPlayerId: 8482078, drawnByPlayerId: 8482175, eventOwnerTeamId: 17 });
  addPenalty(input, { typeCode: "MIS", duration: 10, committedByPlayerId: 8482078, eventOwnerTeamId: 17 });
  addPenalty(input, { typeCode: "MIN", duration: 2, committedByPlayerId: goalie, servedByPlayerId: 8477429, drawnByPlayerId: 8482175, eventOwnerTeamId: 17 });
  addPenalty(input, { typeCode: "MIN", duration: 2, servedByPlayerId: 8477429, descKey: "too-many-men-on-the-ice", eventOwnerTeamId: 17 });
  const result = normalizeNhlLiveGame(input);
  assert.equal(player(result, 8482078).scoringStats.penaltiesTaken, 2);
  assert.equal(player(result, 8477429).scoringStats.penaltiesTaken, 0);
  assert.equal(player(result, 8482175).scoringStats.penaltiesDrawn, 2);
  assert.equal(result.playerGames.some(row => row.providerPlayerId === String(goalie)), false);
});

test("a completed shootout does not add skater goals, assists, shots or a game-winning goal", () => {
  const input = blank();
  addGoal(input);
  addGoal(input, { eventId: 2, scorer: 8482175, owner: 6 });
  const descriptor = { number: 5, periodType: "SO" };
  input.playByPlay.plays.push({ eventId: 3, periodDescriptor: descriptor, typeDescKey: "goal", details: { scoringPlayerId: 8482078, eventOwnerTeamId: 17 } });
  input.landing.summary.scoring.push({ periodDescriptor: descriptor, goals: [{ eventId: 3, playerId: 8482078 }] });
  input.playByPlay.gameOutcome = { lastPeriodType: "SO" };
  for (const source of Object.values(input)) { source.gameState = "OFF"; source.homeTeam.score = 2; source.periodDescriptor = descriptor; }
  const result = normalizeNhlLiveGame(input);
  assert.equal(player(result, 8482078).scoringStats.evenStrengthGoals, 1);
  assert.equal(player(result, 8482078).scoringStats.shotsOnGoal, 1);
  assert.ok(result.playerGames.every(row => row.scoringStats.gameWinningGoals === 0));
});

test("goals moving between source requests preserve the last valid snapshot by rejecting inconsistency", () => {
  const input = blank(); addGoal(input);
  input.boxscore.homeTeam.score = 0;
  invalid(input, /scores disagree/);
  const missing = blank(); addGoal(missing); missing.landing.summary.scoring = [];
  invalid(missing, /classifications and play-by-play disagree/);
  const reordered = blank(); addGoal(reordered, { assists: [8477429, 8478434] });
  reordered.landing.summary.scoring[0].goals[0].assists.reverse();
  invalid(reordered, /assist order/);
});

test("missing counts, incomplete rosters, duplicate events and unknown attribution never become zero", () => {
  const missing = blank(); delete missing.boxscore.playerByGameStats.homeTeam.forwards[0].takeaways;
  invalid(missing, /takeaways is missing/);
  const coverage = blank(); coverage.boxscore.playerByGameStats.homeTeam.forwards = [];
  invalid(coverage, /skater coverage/);
  const duplicate = blank(); addGoal(duplicate); duplicate.playByPlay.plays.push(structuredClone(duplicate.playByPlay.plays[0]));
  invalid(duplicate, /repeats an event/);
  const unknown = blank(); addPenalty(unknown, { typeCode: "MIN", duration: 2, committedByPlayerId: 9999999, eventOwnerTeamId: 17 });
  invalid(unknown, /unknown or mismatched player/);
  const noOffender = blank(); addPenalty(noOffender, { typeCode: "MIN", duration: 2, descKey: "tripping", eventOwnerTeamId: 17 });
  invalid(noOffender, /no attributed offender/);
  const unsupported = blank(); addPenalty(unsupported, { typeCode: "UNKNOWN", duration: 2, committedByPlayerId: 8482078, eventOwnerTeamId: 17 });
  invalid(unsupported, /type is unsupported/);
});

test("different games, seasons, teams, postponed games and incomplete scoring feeds are rejected", () => {
  for (const change of [input => { input.boxscore.id += 1; }, input => { input.landing.season = 20252026; },
    input => { input.boxscore.awayTeam.id = 999; }, input => { input.landing.gameScheduleState = "PPD"; },
    input => { input.playByPlay.limitedScoring = true; }, input => { input.boxscore.gameState = "FUT"; }]) {
    const input = blank(); change(input);
    assert.throws(() => normalizeNhlLiveGame(input), { code: "NHL_LIVE_GAME_INCOMPLETE" });
  }
});
