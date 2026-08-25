const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  MATCHUP_LATE_LOCK_EVIDENCE_CODES,
  NHL_GAME_OBSERVATION_FRESHNESS_WINDOW_MS,
  assertFreshNhlGameObservation,
  createMatchupLateLockExclusionSetEvidence,
  createNhlGameObservationSnapshotEvidence,
  isWholeGameExcluded,
} = require("../../src/domain/matchups/matchupLateLockEvidencePolicy");

const NOW_MS = Date.parse("2026-10-12T08:00:00.000Z");
const IDS = Object.freeze({
  observationSnapshot: "30000000-0000-4000-8000-000000000001",
  exclusionSet: "30000000-0000-4000-8000-000000000002",
  league: "30000000-0000-4000-8000-000000000003",
  season: "30000000-0000-4000-8000-000000000004",
  week: "30000000-0000-4000-8000-000000000005",
  matchup: "30000000-0000-4000-8000-000000000006",
  team: "30000000-0000-4000-8000-000000000007",
  lock: "30000000-0000-4000-8000-000000000008",
  exclusionA: "30000000-0000-4000-8000-000000000009",
  exclusionB: "30000000-0000-4000-8000-000000000010",
  rosterPlayerA: "30000000-0000-4000-8000-000000000011",
  rosterPlayerB: "30000000-0000-4000-8000-000000000012",
  playerA: "30000000-0000-4000-8000-000000000013",
  playerB: "30000000-0000-4000-8000-000000000014",
  baselineA: "30000000-0000-4000-8000-000000000015",
  baselineB: "30000000-0000-4000-8000-000000000016",
});

function game(overrides = {}) {
  return {
    nhlGameId: "2026020001",
    nhlGameScheduledStartsAtMs: NOW_MS - 60_000,
    observedGameState: "in_progress",
    ...overrides,
  };
}

function snapshotEvidence(games) {
  return createNhlGameObservationSnapshotEvidence({
    observationSnapshotId: IDS.observationSnapshot,
    provider: "sportsdataio-live",
    sourceVersion: "games-2026-10-12T08:00:00.000Z",
    observedAtMs: NOW_MS,
    freshnessStatus: "fresh",
    games,
  });
}

function exclusion(overrides = {}) {
  return {
    exclusionId: IDS.exclusionA,
    matchupRosterPlayerId: IDS.rosterPlayerA,
    playerId: IDS.playerA,
    nhlGameId: "2026020001",
    nhlGameScheduledStartsAtMs: NOW_MS - 60_000,
    observedGameState: "in_progress",
    baselinePlayerGameStatObservationId: IDS.baselineA,
    ...overrides,
  };
}

function exclusionEvidence(observation, exclusions) {
  return createMatchupLateLockExclusionSetEvidence({
    exclusionSetId: IDS.exclusionSet,
    leagueId: IDS.league,
    seasonId: IDS.season,
    matchupWeekId: IDS.week,
    matchupId: IDS.matchup,
    teamId: IDS.team,
    matchupRosterLockId: IDS.lock,
    lateSnapshotAtMs: NOW_MS,
    observationSnapshotId: IDS.observationSnapshot,
    observationSha256: observation.observationSha256,
    exclusions,
  });
}

describe("FAD-05 matchup late-lock evidence policy", () => {
  test("accepts the exact five-minute game-state freshness boundary", () => {
    assert.deepEqual(
      assertFreshNhlGameObservation({
        observedAtMs:
          NOW_MS - NHL_GAME_OBSERVATION_FRESHNESS_WINDOW_MS,
        lateSnapshotAtMs: NOW_MS,
      }),
      {
        freshnessStatus: "fresh",
        ageMs: NHL_GAME_OBSERVATION_FRESHNESS_WINDOW_MS,
      }
    );
    assert.throws(
      () => assertFreshNhlGameObservation({
        observedAtMs:
          NOW_MS - NHL_GAME_OBSERVATION_FRESHNESS_WINDOW_MS - 1,
        lateSnapshotAtMs: NOW_MS,
      }),
      { code: MATCHUP_LATE_LOCK_EVIDENCE_CODES.observationStale }
    );
    assert.throws(
      () => assertFreshNhlGameObservation({
        observedAtMs: NOW_MS + 1,
        lateSnapshotAtMs: NOW_MS,
      }),
      { code: MATCHUP_LATE_LOCK_EVIDENCE_CODES.observationFuture }
    );
  });

  test("seals a deterministic fresh game-state observation snapshot", () => {
    const forward = snapshotEvidence([
      game({ nhlGameId: "2026020002", observedGameState: "scheduled" }),
      game(),
    ]);
    const reverse = snapshotEvidence([
      game(),
      game({ nhlGameId: "2026020002", observedGameState: "scheduled" }),
    ]);

    assert.equal(forward.observationCount, 2);
    assert.equal(forward.observationSha256, reverse.observationSha256);
    assert.deepEqual(
      forward.preimage.games.map((row) => row.nhlGameId),
      ["2026020001", "2026020002"]
    );
    assert.equal(
      forward.observationSha256,
      "69f423eb15f792965ca2a0f237f2dbc4eff9bab6cd0be659b7b063bcdb3d9935"
    );
    assert.equal(Object.isFrozen(forward.preimage.games), true);
  });

  test("rejects stale, duplicate, malformed, and unsupported game observations", () => {
    for (const input of [
      {
        observationSnapshotId: IDS.observationSnapshot,
        provider: "sportsdataio-live",
        sourceVersion: "source",
        observedAtMs: NOW_MS,
        freshnessStatus: "stale",
        games: [],
      },
      {
        observationSnapshotId: IDS.observationSnapshot,
        provider: "sportsdataio-live",
        sourceVersion: "source",
        observedAtMs: NOW_MS,
        freshnessStatus: "fresh",
        games: [game(), game()],
      },
      {
        observationSnapshotId: IDS.observationSnapshot,
        provider: "sportsdataio-live",
        sourceVersion: "source",
        observedAtMs: NOW_MS,
        freshnessStatus: "fresh",
        games: [game({ unexpected: true })],
      },
      {
        observationSnapshotId: IDS.observationSnapshot,
        provider: "sportsdataio-live",
        sourceVersion: "source",
        observedAtMs: NOW_MS,
        freshnessStatus: "fresh",
        games: [game({ observedGameState: "unknown" })],
      },
    ]) {
      assert.throws(
        () => createNhlGameObservationSnapshotEvidence(input),
        { code: MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid }
      );
    }
  });

  test("classifies only already-started, intermission, or final games for exclusion", () => {
    for (const state of ["in_progress", "intermission", "final"]) {
      assert.equal(
        isWholeGameExcluded({
          nhlGameScheduledStartsAtMs: NOW_MS - 1,
          observedGameState: state,
          lateSnapshotAtMs: NOW_MS,
        }),
        true
      );
    }
    for (const state of [
      "scheduled",
      "pre_game",
      "postponed",
      "cancelled",
    ]) {
      assert.equal(
        isWholeGameExcluded({
          nhlGameScheduledStartsAtMs: NOW_MS - 1,
          observedGameState: state,
          lateSnapshotAtMs: NOW_MS,
        }),
        false
      );
    }
    assert.throws(
      () => isWholeGameExcluded({
        nhlGameScheduledStartsAtMs: NOW_MS + 1,
        observedGameState: "in_progress",
        lateSnapshotAtMs: NOW_MS,
      }),
      { code: MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid }
    );
  });

  test("seals exact whole-game exclusions in canonical identity order", () => {
    const observation = snapshotEvidence([
      game(),
      game({
        nhlGameId: "2026020002",
        observedGameState: "final",
      }),
    ]);
    const first = exclusion();
    const second = exclusion({
      exclusionId: IDS.exclusionB,
      matchupRosterPlayerId: IDS.rosterPlayerB,
      playerId: IDS.playerB,
      nhlGameId: "2026020002",
      observedGameState: "final",
      baselinePlayerGameStatObservationId: IDS.baselineB,
    });
    const forward = exclusionEvidence(observation, [second, first]);
    const reverse = exclusionEvidence(observation, [first, second]);

    assert.equal(forward.exclusionCount, 2);
    assert.equal(forward.evidenceSha256, reverse.evidenceSha256);
    assert.deepEqual(
      forward.preimage.exclusions.map((row) => row.playerId),
      [IDS.playerA, IDS.playerB]
    );
    assert.equal(
      forward.evidenceSha256,
      "d59c62800d5537de2c8866a36f35973ea253d5880b2db33badcdb05cc87639bb"
    );
  });

  test("rejects non-underway and duplicate whole-game exclusions", () => {
    const observation = snapshotEvidence([game()]);
    assert.throws(
      () => exclusionEvidence(observation, [
        exclusion({ observedGameState: "scheduled" }),
      ]),
      { code: MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid }
    );
    assert.throws(
      () => exclusionEvidence(observation, [
        exclusion(),
        exclusion({ exclusionId: IDS.exclusionB }),
      ]),
      { code: MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid }
    );
  });

  test("permits sealed zero-game and zero-exclusion evidence", () => {
    const observation = snapshotEvidence([]);
    const exclusions = exclusionEvidence(observation, []);
    assert.equal(observation.observationCount, 0);
    assert.equal(exclusions.exclusionCount, 0);
    assert.match(observation.observationSha256, /^[0-9a-f]{64}$/);
    assert.match(exclusions.evidenceSha256, /^[0-9a-f]{64}$/);
  });
});
