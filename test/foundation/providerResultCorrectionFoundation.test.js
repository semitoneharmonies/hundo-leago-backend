const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createProviderResultCorrectionService } = require("../../src/application/services/matchups/createProviderResultCorrectionService");
const { emptyScoringStats, EXPANDED_SCORING_VERSION } = require("../../src/domain/statistics/expandedScoringPolicy");

function fixture({ candidateCount = 1, onRead = () => {} } = {}) {
  const candidate = { league_id: "league", season_id: "season", matchup_week_id: "week", matchup_id: "match",
    source_refresh_id: "old", result_id: "result", result_version: 1, result_version_id: "version-1", version_number: 1 };
  const score = () => ({ source: { refreshId: "new", pendingGameCount: 0, freshnessStatus: "fresh" },
    home: { teamId: "home", legal: true, scoringRuleVersion: EXPANDED_SCORING_VERSION, scoreHundredths: 0,
      players: [{ playerId: "player", positionGroup: "F", slotNumber: 1, gamesPlayedDelta: 1, scoreHundredths: 0, scoringStats: emptyScoringStats() }] },
    away: { teamId: "away", legal: true, scoringRuleVersion: EXPANDED_SCORING_VERSION, scoreHundredths: 0, players: [] } });
  const state = { previous: score(), current: score(), committed: [], errors: [], status: "corrected" };
  const service = createProviderResultCorrectionService({ clock: { nowMs: () => 100 }, createId: () => "new-id", logger: { warn: (...args) => state.errors.push(args) },
    scoringService: { readForCorrection: () => { onRead(); return state.current; }, readAtRefresh: () => state.previous },
    repository: { listCandidates: () => Array(candidateCount).fill(candidate), commit: command => { state.committed.push(command); if (state.status === "corrected") state.previous = structuredClone(state.current); return { status: state.status }; } } });
  return { state, service };
}

test("provider corrections retain changed category counts even when the total is unchanged and replay without writes", async () => {
  const { state, service } = fixture();
  assert.equal((await service.reconcile()).unchanged, 1);
  state.current.home.players[0].scoringStats.hits = 1;
  state.current.home.players[0].scoringStats.penaltiesTaken = 1;
  assert.equal((await service.reconcile()).corrected, 1);
  assert.equal(state.committed[0].refreshId, "new");
  assert.equal(state.committed[0].homeScoreHundredths, 0);
  assert.equal((await service.reconcile()).unchanged, 1);
  assert.equal(state.committed.length, 1);
});

test("provider corrections wait for final fresh evidence and preserve finalized playoff review controls", async () => {
  const { state, service } = fixture();
  state.current.home.players[0].scoringStats.giveaways = 1;
  state.current.home.players[0].scoreHundredths = -10;
  state.current.home.scoreHundredths = -10;
  state.current.source.pendingGameCount = 1;
  assert.equal((await service.reconcile()).awaitingData, 1);
  state.current.source.pendingGameCount = 0;
  state.current.source.pendingWeekGameCount = 1;
  assert.equal((await service.reconcile()).awaitingData, 1);
  assert.equal(state.committed.length, 0);
  state.current.source.pendingWeekGameCount = 0;
  state.current.source.gameCollectionAvailable = false;
  assert.equal((await service.reconcile()).awaitingData, 1);
  state.current.source.gameCollectionAvailable = true;
  state.current.source.freshnessStatus = "stale";
  assert.equal((await service.reconcile()).awaitingData, 1);
  assert.equal(state.committed.length, 0);
  state.current.source.freshnessStatus = "fresh";
  state.status = "requires_playoff_review";
  assert.equal((await service.reconcile()).requiresPlayoffReview, 1);
  assert.equal(state.previous.home.scoreHundredths, 0);
});

test("provider rechecks let queued work run between matchups", async () => {
  const events = [];
  const { service } = fixture({ candidateCount: 2, onRead() {
    events.push("matchup");
    if (events.length === 1) setImmediate(() => events.push("queued work"));
  } });
  const result = await service.reconcile();
  assert.equal(result.unchanged, 2);
  assert.deepEqual(events, ["matchup", "queued work", "matchup"]);
});
