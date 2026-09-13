const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  PLAYER_GAME_OBSERVATION_SET_DOMAIN,
  PLAYER_GAME_STATISTICS_CODES,
  createPlayerGameObservationSetEvidence,
  normalizePlayerGameStatisticsRows,
} = require("../../src/domain/statistics/playerGameStatisticsPolicy");

const CAPTURED_AT_MS = Date.parse("2026-10-12T08:00:00.000Z");
const SCHEDULED_AT_MS = Date.parse("2026-10-13T02:00:00.000Z");
const UPDATED_AT_MS = Date.parse("2026-10-12T07:59:45.000Z");
const IDS = Object.freeze({
  set: "10000000-0000-4000-8000-000000000001",
  source: "10000000-0000-4000-8000-000000000002",
  refresh: "10000000-0000-4000-8000-000000000003",
  playerA: "10000000-0000-4000-8000-000000000004",
  playerB: "10000000-0000-4000-8000-000000000005",
  observationA: "10000000-0000-4000-8000-000000000006",
  observationB: "10000000-0000-4000-8000-000000000007",
});

function providerRow(overrides = {}) {
  return {
    playerId: 8478402,
    nhlGameId: 2026020001,
    nhlGameScheduledStartsAtMs: SCHEDULED_AT_MS,
    observedGameState: "scheduled",
    goals: 0,
    assists: 0,
    sourceUpdatedAtMs: UPDATED_AT_MS,
    ...overrides,
  };
}

function evidenceObservation(overrides = {}) {
  return {
    observationId: IDS.observationA,
    playerId: IDS.playerA,
    nhlGameId: "2026020001",
    nhlGameScheduledStartsAtMs: SCHEDULED_AT_MS,
    observedGameState: "scheduled",
    goals: 0,
    assists: 0,
    nhlPoints: 0,
    fantasyPointsHundredths: 0,
    sourceUpdatedAtMs: UPDATED_AT_MS,
    ...overrides,
  };
}

function evidenceInput(observations) {
  return {
    setId: IDS.set,
    statSourceId: IDS.source,
    refreshId: IDS.refresh,
    nhlSeasonKey: "20262027",
    provider: "sportsdataio-live",
    sourceVersion: "2026-10-12T07:59:45.000Z",
    capturedAtMs: CAPTURED_AT_MS,
    observations,
  };
}

describe("FAD-05 player-game statistics policy", () => {
  test("normalizes explicit zero observations and integer scoring categories", () => {
    const rows = normalizePlayerGameStatisticsRows({
      rows: [
        providerRow(),
        providerRow({
          playerId: "8478403",
          nhlGameId: "2026020002",
          observedGameState: "final",
          goals: 2,
          assists: 3,
        }),
      ],
      capturedAtMs: CAPTURED_AT_MS,
      minimumObservationCount: 2,
    });

    assert.deepEqual(rows[0], {
      externalPlayerId: "8478402",
      nhlGameId: "2026020001",
      nhlGameScheduledStartsAtMs: SCHEDULED_AT_MS,
      observedGameState: "scheduled",
      goals: 0,
      assists: 0,
      nhlPoints: 0,
      fantasyPointsHundredths: 0,
      sourceUpdatedAtMs: UPDATED_AT_MS,
    });
    assert.equal(rows[1].nhlPoints, 5);
    assert.equal(rows[1].fantasyPointsHundredths, 550);
    assert.equal(Object.isFrozen(rows), true);
    assert.equal(Object.isFrozen(rows[0]), true);
  });

  test("sorts provider rows deterministically and rejects duplicate pairs", () => {
    const rows = normalizePlayerGameStatisticsRows({
      rows: [
        providerRow({ playerId: 9, nhlGameId: "2" }),
        providerRow({ playerId: 8, nhlGameId: "9" }),
        providerRow({ playerId: 8, nhlGameId: "1" }),
      ],
      capturedAtMs: CAPTURED_AT_MS,
    });
    assert.deepEqual(
      rows.map((row) => [row.externalPlayerId, row.nhlGameId]),
      [["8", "1"], ["8", "9"], ["9", "2"]]
    );
    assert.throws(
      () => normalizePlayerGameStatisticsRows({
        rows: [providerRow(), providerRow({ playerId: "8478402" })],
        capturedAtMs: CAPTURED_AT_MS,
      }),
      { code: PLAYER_GAME_STATISTICS_CODES.inputInvalid }
    );
  });

  test("rejects unsupported states, malformed shapes, future updates, and partial feeds", () => {
    for (const row of [
      providerRow({ observedGameState: "unknown" }),
      providerRow({ goals: -1 }),
      providerRow({ sourceUpdatedAtMs: CAPTURED_AT_MS + 1 }),
      { ...providerRow(), unexpected: true },
    ]) {
      assert.throws(
        () => normalizePlayerGameStatisticsRows({
          rows: [row],
          capturedAtMs: CAPTURED_AT_MS,
        }),
        { code: PLAYER_GAME_STATISTICS_CODES.inputInvalid }
      );
    }
    assert.throws(
      () => normalizePlayerGameStatisticsRows({
        rows: [providerRow()],
        capturedAtMs: CAPTURED_AT_MS,
        minimumObservationCount: 2,
      }),
      { code: PLAYER_GAME_STATISTICS_CODES.responseIncomplete }
    );
  });

  test("builds the exact canonical observation-set preimage in stable order", () => {
    const evidence = createPlayerGameObservationSetEvidence(
      evidenceInput([
        evidenceObservation({
          observationId: IDS.observationB,
          playerId: IDS.playerB,
          nhlGameId: "2026020002",
          goals: 1,
          assists: 2,
          nhlPoints: 3,
          fantasyPointsHundredths: 325,
        }),
        evidenceObservation(),
      ])
    );

    assert.equal(
      evidence.preimage.domain,
      PLAYER_GAME_OBSERVATION_SET_DOMAIN
    );
    assert.equal(evidence.preimage.schemaVersion, 1);
    assert.equal(evidence.observationCount, 2);
    assert.deepEqual(
      evidence.preimage.observations.map((row) => row.playerId),
      [IDS.playerA, IDS.playerB]
    );
    assert.match(evidence.evidenceSha256, /^[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.preimage), true);
    assert.equal(Object.isFrozen(evidence.preimage.observations), true);
  });

  test("produces one stable digest independent of input order", () => {
    const first = evidenceObservation();
    const second = evidenceObservation({
      observationId: IDS.observationB,
      playerId: IDS.playerB,
      nhlGameId: "2026020002",
      observedGameState: "in_progress",
      goals: 1,
      assists: 0,
      nhlPoints: 1,
      fantasyPointsHundredths: 125,
    });
    const forward = createPlayerGameObservationSetEvidence(
      evidenceInput([first, second])
    );
    const reverse = createPlayerGameObservationSetEvidence(
      evidenceInput([second, first])
    );
    assert.equal(forward.evidenceSha256, reverse.evidenceSha256);
    assert.equal(
      forward.evidenceSha256,
      "e4066b8f5fe3ee7686ba80ab778fef5a5803900cc167ec9bc287e28979e04d8e"
    );
  });

  test("rejects duplicate identities, extra keys, and inconsistent scoring evidence", () => {
    assert.throws(
      () => createPlayerGameObservationSetEvidence(
        evidenceInput([
          evidenceObservation(),
          evidenceObservation({ observationId: IDS.observationB }),
        ])
      ),
      { code: PLAYER_GAME_STATISTICS_CODES.inputInvalid }
    );
    for (const observation of [
      { ...evidenceObservation(), unexpected: true },
      evidenceObservation({ nhlPoints: 1 }),
      evidenceObservation({ fantasyPointsHundredths: 1 }),
    ]) {
      assert.throws(
        () => createPlayerGameObservationSetEvidence(
          evidenceInput([observation])
        ),
        { code: PLAYER_GAME_STATISTICS_CODES.inputInvalid }
      );
    }
  });

  test("permits a canonical zero-observation sealed set", () => {
    const evidence = createPlayerGameObservationSetEvidence(
      evidenceInput([])
    );
    assert.equal(evidence.observationCount, 0);
    assert.deepEqual(evidence.preimage.observations, []);
    assert.match(evidence.evidenceSha256, /^[0-9a-f]{64}$/);
  });
});
