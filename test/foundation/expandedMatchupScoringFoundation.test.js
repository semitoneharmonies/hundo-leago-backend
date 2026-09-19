const assert = require("node:assert/strict");
const { test } = require("node:test");
const { calculateExpandedTeamScore } = require("../../src/domain/matchups/expandedMatchupScoringPolicy");
const { emptyScoringStats } = require("../../src/domain/statistics/expandedScoringPolicy");
const { deriveMatchupOutcome, evaluateFinalSource } = require("../../src/domain/matchups/matchupResultPolicy");
const { calculateStandings } = require("../../src/domain/matchups/matchupStandingsPolicy");

function fixture() {
  const input = { lock: { legal: 1, team_id: "home", lock_type: "normal", locked_at_ms: 110 },
    lockedPlayers: [{ player_id: "d", player_full_name: "Defender", position_group: "D", slot_number: 1 }],
    currentPlayerGames: new Map(), expandedPlayerGames: [], excludedPlayerGames: [], weekStartsAtMs: 100, weekEndsAtMs: 200 };
  function game(id, start, stats, { player = "d", state = "final", played = 1 } = {}) {
    input.currentPlayerGames.set(`${player}\u0000${id}`, { playerId: player, nhlGameId: id, observedGameState: state, nhlGameScheduledStartsAtMs: start });
    input.expandedPlayerGames.push({ playerId: player, nhlGameId: id, gamesPlayed: played, scoringStats: { ...emptyScoringStats(), ...stats } });
  }
  return { input, game };
}

test("expanded matchup uses the locked position and counts only eligible final games in its week", () => {
  const { input, game } = fixture();
  game("before", 99, { evenStrengthGoals: 9 });
  game("start", 100, { hits: 2, blockedShots: 1, penaltiesTaken: 1 });
  game("last", 199, { giveaways: 1 });
  game("next", 200, { evenStrengthGoals: 9 });
  game("live", 150, { evenStrengthGoals: 9 }, { state: "in_progress" });
  game("bench", 150, { evenStrengthGoals: 9 }, { player: "bench" });
  game("scratch", 160, {}, { played: 0 });
  const result = calculateExpandedTeamScore(input);
  assert.equal(result.scoreHundredths, 75);
  assert.equal(result.players[0].gamesPlayedDelta, 2);
  assert.equal(result.players[0].scoringStats.hits, 2);
  assert.equal(result.players[0].scoringBreakdown.find(row => row.key === "hits").pointsHundredths, 70);
});

test("late locks and whole-game exclusions preserve the original eligibility boundary", () => {
  const { input, game } = fixture();
  input.lock.lock_type = "late";
  input.lock.locked_at_ms = 150;
  game("early", 149, { evenStrengthGoals: 1 });
  game("excluded", 160, { evenStrengthGoals: 1 });
  game("eligible", 170, { penaltiesTaken: 2, giveaways: 1 });
  input.excludedPlayerGames.push({ player_id: "d", nhl_game_id: "excluded" });
  const result = calculateExpandedTeamScore(input);
  assert.equal(result.scoreHundredths, -50);
  assert.equal(result.players[0].gamesPlayedDelta, 1);
  assert.equal(result.players[0].goalDelta, 0);
  input.lock.legal = 0;
  assert.equal(calculateExpandedTeamScore(input).scoreHundredths, 0);
});

test("eligible games without complete category evidence cannot silently score zero", () => {
  const { input, game } = fixture();
  game("eligible", 150, { hits: 1 });
  input.expandedPlayerGames.length = 0;
  assert.throws(() => calculateExpandedTeamScore(input), /missing expanded/);
});

test("negative scores determine winners and signed standings totals without relaxing timestamps", () => {
  assert.equal(deriveMatchupOutcome(-20, -50), "home_win");
  assert.equal(deriveMatchupOutcome(-20, 0), "away_win");
  assert.equal(deriveMatchupOutcome(-20, -20), "tie");
  assert.throws(() => evaluateFinalSource({ weekEndsAtMs: -1, refreshCompletedAtMs: 1, nowMs: 2 }));
  const rows = calculateStandings({ participants: [
    { team_id: "home", team_display_name: "Home" }, { team_id: "away", team_display_name: "Away" },
  ], results: [{ home_team_id: "home", away_team_id: "away", home_score_hundredths: -20, away_score_hundredths: -50 }] });
  assert.equal(rows[0].teamId, "home");
  assert.equal(rows[0].wins, 1);
  assert.equal(rows[0].fantasyPointsForHundredths, -20);
  assert.equal(rows[0].fantasyPointsAgainstHundredths, -50);
  assert.equal(rows[0].fantasyPointsDifferentialHundredths, 30);
});
