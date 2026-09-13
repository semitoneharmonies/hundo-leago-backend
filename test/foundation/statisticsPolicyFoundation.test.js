const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  STATISTICS_CODES,
  assertNhlSeasonKey,
  normalizeStatisticsRows,
} = require("../../src/domain/statistics/statisticsPolicy");

const UPDATED_AT_MS = Date.parse("2026-10-12T08:00:00.000Z");

describe("M6-01 statistics policy", () => {
  test("normalizes exact integer categories and fantasy-point hundredths", () => {
    const rows = normalizeStatisticsRows({
      rows: [
        { playerId: 8478402, gamesPlayed: 4, goals: 2, assists: 3 },
      ],
      minimumPlayerCount: 1,
      sourceUpdatedAtMs: UPDATED_AT_MS,
    });
    assert.deepEqual(rows[0], {
      externalPlayerId: "8478402",
      gamesPlayed: 4,
      goals: 2,
      assists: 3,
      nhlPoints: 5,
      fantasyPointsHundredths: 550,
      sourceUpdatedAtMs: UPDATED_AT_MS,
    });
    assert.equal(Object.isFrozen(rows), true);
    assert.equal(Object.isFrozen(rows[0]), true);
  });

  test("accepts only consecutive eight-digit NHL season keys", () => {
    assert.equal(assertNhlSeasonKey("20262027"), "20262027");
    for (const value of ["2026", "20262028", 20262027, " 20262027"]){
      assert.throws(() => assertNhlSeasonKey(value), {
        code: STATISTICS_CODES.inputInvalid,
      });
    }
  });

  test("rejects duplicate provider identities", () => {
    assert.throws(
      () => normalizeStatisticsRows({
        rows: [
          { playerId: 8478402, gamesPlayed: 1, goals: 0, assists: 1 },
          { playerId: "8478402", gamesPlayed: 1, goals: 1, assists: 0 },
        ],
        minimumPlayerCount: 1,
        sourceUpdatedAtMs: UPDATED_AT_MS,
      }),
      { code: STATISTICS_CODES.inputInvalid }
    );
  });

  test("rejects malformed identifiers, counters, and timestamps", () => {
    const valid = { playerId: 8478402, gamesPlayed: 1, goals: 0, assists: 1 };
    for (const rows of [
      [{ ...valid, playerId: "player-1" }],
      [{ ...valid, gamesPlayed: -1 }],
      [{ ...valid, goals: 0.5 }],
      [null],
    ]) {
      assert.throws(
        () => normalizeStatisticsRows({
          rows,
          minimumPlayerCount: 1,
          sourceUpdatedAtMs: UPDATED_AT_MS,
        }),
        { code: STATISTICS_CODES.inputInvalid }
      );
    }
  });

  test("rejects partial or undersized responses", () => {
    assert.throws(
      () => normalizeStatisticsRows({
        rows: [{ playerId: 8478402, gamesPlayed: 1, goals: 0, assists: 1 }],
        minimumPlayerCount: 2,
        sourceUpdatedAtMs: UPDATED_AT_MS,
      }),
      { code: STATISTICS_CODES.responseIncomplete }
    );
  });
});
