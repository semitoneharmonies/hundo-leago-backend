const assert = require("node:assert/strict");
const { test } = require("node:test");
const { canReuseCompletedGame, completedGameEntry, HISTORICAL_RECHECK_MS, RECENT_GAME_WINDOW_MS } = require("../../src/domain/statistics/completedGameCachePolicy");
const NOW = Date.parse("2026-12-20T12:00:00Z");
const GAME = { id: "2026020001", startsAtMs: NOW - 20 * 86_400_000, homeTeamId: "1", awayTeamId: "2", final: true };
function fixture() {
  const input = { game: { ...GAME }, season: "20262027", expanded: true, nowMs: NOW };
  input.entry = completedGameEntry({ ...input, checkedAtMs: NOW - 60_000,
    data: { rows: [{ playerId: 1, goals: 2, assists: 1 }], categories: [] } });
  return input;
}

test("historical game reuse preserves its content and does not depend on matchup duration", () => {
  const input = fixture();
  const original = JSON.stringify(input);
  assert.equal(canReuseCompletedGame(input), true);
  assert.equal(JSON.stringify(input), original);
});

for (const [label, mutate] of [
  ["missing entry", input => { input.entry = null; }],
  ["different season", input => { input.season = "20272028"; }],
  ["changed scoring mode", input => { input.expanded = false; }],
  ["changed game time", input => { input.game.startsAtMs += 60_000; }],
  ["changed team", input => { input.game.homeTeamId = "3"; }],
  ["game no longer final", input => { input.game.final = false; }],
  ["recent game", input => { input.nowMs = GAME.startsAtMs + RECENT_GAME_WINDOW_MS; }],
  ["weekly correction check due", input => { input.nowMs = input.entry.checkedAtMs + HISTORICAL_RECHECK_MS; }],
  ["future check time", input => { input.entry.checkedAtMs = NOW + 1; }],
  ["corrupted content", input => { input.entry.data.rows[0].goals = 7; }],
  ["malformed cached shape", input => { input.entry.data = null; }],
  ["unsupported cache format", input => { input.entry.version = "unknown"; }],
]) test(`completed-game cache requires a fresh provider read for ${label}`, () => {
  const input = fixture(); mutate(input);
  assert.equal(canReuseCompletedGame(input), false);
});
