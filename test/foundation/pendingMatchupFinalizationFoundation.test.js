const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createMatchupResultService } = require("../../src/application/services/matchups/createMatchupResultService");
const { normalizeNhlGameCollection, readNhlGameCollection } = require("../../src/domain/statistics/nhlGameCollectionPolicy");

test("pending games outside a matchup's roster block its official winner and loser", () => {
  let writes = 0, pendingWeekGameCount = 1, gameCollectionAvailable = false;
  const service = createMatchupResultService({
    repository: {
      readOperation: () => null,
      readContext: () => ({ matchup: { status: "awaiting_data", week_status: "awaiting_data", ends_at_ms: 100 } }),
      finalize: () => { writes++; return {}; }, correct() {},
    },
    scoringService: { readLive: () => ({ source: { pendingGameCount: 0, pendingWeekGameCount, gameCollectionAvailable, completedAtMs: 110 },
      home: { scoreHundredths: 100 }, away: { scoreHundredths: 200 } }) },
  });
  assert.equal(service.finalize({ nowMs: 120 }).waiting.reasonCode, "NHL_GAME_COLLECTION_UNKNOWN");
  assert.equal(writes, 0);
  gameCollectionAvailable = true;
  assert.equal(service.finalize({ nowMs: 120 }).waiting.reasonCode, "NHL_GAMES_NOT_COMPLETE");
  assert.equal(writes, 0);
  pendingWeekGameCount = 0;
  assert.equal(service.finalize({ nowMs: 120 }).finalized, true);
  assert.equal(writes, 1);
});

test("invalid collection evidence cannot be interpreted as no pending games", () => {
  const game = { nhlGameId: "2026020001", startsAtMs: 100 };
  for (const value of [{}, { schemaVersion: 2, pendingGames: [] }, { schemaVersion: 1, pendingGames: [game, game] },
    { schemaVersion: 1, pendingGames: [{ ...game, startsAtMs: -1 }] }, { schemaVersion: 1, pendingGames: [{ ...game, nhlGameId: "bad" }] }]) {
    assert.throws(() => normalizeNhlGameCollection(value));
  }
  assert.throws(() => readNhlGameCollection("malformed"));
  assert.equal(readNhlGameCollection(null), null);
  assert.deepEqual(normalizeNhlGameCollection({schemaVersion:1,pendingGames:[]}).pendingGames, []);
});
