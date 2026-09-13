const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  MATCHUP_SEALED_EVIDENCE_CODES,
  verifySealedLateLockEvidence,
} = require("../../src/domain/matchups/matchupSealedEvidenceVerifier");
const {
  createMatchupLateLockExclusionSetEvidence,
  createNhlGameObservationSnapshotEvidence,
} = require("../../src/domain/matchups/matchupLateLockEvidencePolicy");
const {
  createPlayerGameCoverageSetEvidence,
} = require("../../src/domain/statistics/playerGameCoveragePolicy");
const {
  createPlayerGameObservationSetEvidence,
} = require("../../src/domain/statistics/playerGameStatisticsPolicy");

const NOW_MS = Date.parse("2026-10-12T08:00:00.000Z");
const WEEK_START_MS = NOW_MS - 24 * 60 * 60 * 1000;
const WEEK_END_MS = WEEK_START_MS + 7 * 24 * 60 * 60 * 1000;
const id = (value) =>
  `40000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const IDS = Object.freeze({
  set: id(1),
  source: id(2),
  refresh: id(3),
  coverageA: id(4),
  coverageB: id(5),
  observationA: id(6),
  observationSnapshot: id(7),
  exclusionSet: id(8),
  league: id(9),
  season: id(10),
  week: id(11),
  matchup: id(12),
  team: id(13),
  lock: id(14),
  rosterPlayerA: id(15),
  rosterPlayerB: id(16),
  playerA: id(17),
  playerB: id(18),
  exclusionA: id(19),
});

function clone(value) {
  return structuredClone(value);
}

function playerGameEvidence({ terminal = false } = {}) {
  const coverage = terminal
    ? [
        {
          coverageEntryId: IDS.coverageA,
          playerId: IDS.playerA,
          providerPlayerId: "provider-player-a",
          providerTeamId: "VAN",
          disposition: "no_due_game",
          nhlGameId: null,
          nhlGameScheduledStartsAtMs: null,
        },
      ]
    : [
        {
          coverageEntryId: IDS.coverageA,
          playerId: IDS.playerA,
          providerPlayerId: "provider-player-a",
          providerTeamId: "VAN",
          disposition: "expected_game",
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: NOW_MS - 60_000,
        },
        {
          coverageEntryId: IDS.coverageB,
          playerId: IDS.playerB,
          providerPlayerId: "provider-player-b",
          providerTeamId: null,
          disposition: "no_team",
          nhlGameId: null,
          nhlGameScheduledStartsAtMs: null,
        },
      ];
  const observations = terminal
    ? []
    : [
        {
          observationId: IDS.observationA,
          playerId: IDS.playerA,
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: NOW_MS - 60_000,
          observedGameState: "in_progress",
          goals: 0,
          assists: 0,
          nhlPoints: 0,
          fantasyPointsHundredths: 0,
          sourceUpdatedAtMs: NOW_MS - 240_000,
        },
      ];
  const requiredPlayers = coverage.map((row) => ({
    playerId: row.playerId,
    providerPlayerId: row.providerPlayerId,
  }));
  const coverageEvidence = createPlayerGameCoverageSetEvidence({
    setId: IDS.set,
    statSourceId: IDS.source,
    refreshId: IDS.refresh,
    nhlSeasonKey: "20262027",
    provider: "sportsdataio-live",
    sourceVersion: "statistics-source-version",
    capturedAtMs: NOW_MS - 180_000,
    requiredPlayers,
    coverage,
  });
  const observationEvidence = createPlayerGameObservationSetEvidence({
    setId: IDS.set,
    statSourceId: IDS.source,
    refreshId: IDS.refresh,
    nhlSeasonKey: "20262027",
    provider: "sportsdataio-live",
    sourceVersion: "statistics-source-version",
    capturedAtMs: NOW_MS - 180_000,
    observations,
  });
  return {
    coverage,
    observations,
    root: {
      setId: IDS.set,
      statSourceId: IDS.source,
      refreshId: IDS.refresh,
      nhlSeasonKey: "20262027",
      provider: "sportsdataio-live",
      sourceVersion: "statistics-source-version",
      capturedAtMs: NOW_MS - 180_000,
      requiredPlayerCount: coverageEvidence.requiredPlayerCount,
      coverageEntryCount: coverageEvidence.coverageEntryCount,
      expectedPlayerGameCount:
        coverageEvidence.expectedPlayerGameCount,
      coverageSchemaVersion: 1,
      coverageSha256: coverageEvidence.coverageSha256,
      observationCount: observationEvidence.observationCount,
      evidenceSchemaVersion: 1,
      evidenceSha256: observationEvidence.evidenceSha256,
    },
  };
}

function bundle({ terminal = false } = {}) {
  const playerGame = playerGameEvidence({ terminal });
  const gameStates = terminal
    ? []
    : [
        {
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: NOW_MS - 60_000,
          observedGameState: "in_progress",
        },
      ];
  const gameEvidence = createNhlGameObservationSnapshotEvidence({
    observationSnapshotId: IDS.observationSnapshot,
    provider: "sportsdataio-live",
    sourceVersion: "independent-game-state-source-version",
    observedAtMs: NOW_MS,
    freshnessStatus: "fresh",
    games: gameStates,
  });
  const selectedRosterPlayers = terminal
    ? [
        {
          playerId: IDS.playerA,
          matchupRosterPlayerId: IDS.rosterPlayerA,
        },
      ]
    : [
        {
          playerId: IDS.playerA,
          matchupRosterPlayerId: IDS.rosterPlayerA,
        },
        {
          playerId: IDS.playerB,
          matchupRosterPlayerId: IDS.rosterPlayerB,
        },
      ];
  const exclusions = terminal
    ? []
    : [
        {
          exclusionId: IDS.exclusionA,
          matchupRosterPlayerId: IDS.rosterPlayerA,
          playerId: IDS.playerA,
          nhlGameId: "2026020001",
          nhlGameScheduledStartsAtMs: NOW_MS - 60_000,
          observedGameState: "in_progress",
          baselinePlayerGameStatObservationId: IDS.observationA,
        },
      ];
  const exclusionEvidence =
    createMatchupLateLockExclusionSetEvidence({
      exclusionSetId: IDS.exclusionSet,
      leagueId: IDS.league,
      seasonId: IDS.season,
      matchupWeekId: IDS.week,
      matchupId: IDS.matchup,
      teamId: IDS.team,
      matchupRosterLockId: IDS.lock,
      lateSnapshotAtMs: NOW_MS,
      observationSnapshotId: IDS.observationSnapshot,
      observationSha256: gameEvidence.observationSha256,
      exclusions,
    });
  return {
    playerGameRoot: playerGame.root,
    coverage: playerGame.coverage,
    playerGameObservations: playerGame.observations,
    selectedRosterPlayers,
    weekStartsAtMs: WEEK_START_MS,
    weekEndsAtMs: WEEK_END_MS,
    gameStateRoot: {
      observationSnapshotId: IDS.observationSnapshot,
      provider: "sportsdataio-live",
      sourceVersion: "independent-game-state-source-version",
      observedAtMs: NOW_MS,
      freshnessStatus: "fresh",
      observationCount: gameEvidence.observationCount,
      evidenceSchemaVersion: 1,
      observationSha256: gameEvidence.observationSha256,
    },
    gameStates,
    exclusionRoot: {
      exclusionSetId: IDS.exclusionSet,
      leagueId: IDS.league,
      seasonId: IDS.season,
      matchupWeekId: IDS.week,
      matchupId: IDS.matchup,
      teamId: IDS.team,
      matchupRosterLockId: IDS.lock,
      lateSnapshotAtMs: NOW_MS,
      observationSnapshotId: IDS.observationSnapshot,
      observationSha256: gameEvidence.observationSha256,
      exclusionCount: exclusionEvidence.exclusionCount,
      evidenceSchemaVersion: 1,
      evidenceSha256: exclusionEvidence.evidenceSha256,
    },
    exclusions,
  };
}

describe("FAD-05 shared sealed matchup evidence verifier", () => {
  test("verifies all four digests with independent statistics and game-state source versions", () => {
    const result = verifySealedLateLockEvidence(bundle());
    assert.equal(result.playerGame.coverageEvidence.coverageEntryCount, 2);
    assert.equal(result.playerGame.observationEvidence.observationCount, 1);
    assert.equal(result.gameState.observationCount, 1);
    assert.equal(result.exclusions.exclusionCount, 1);
    assert.equal(Object.isFrozen(result), true);
  });

  test("accepts terminal affirmative coverage with an exact zero-child game-state and exclusion set", () => {
    const result = verifySealedLateLockEvidence(bundle({ terminal: true }));
    assert.equal(result.gameState.observationCount, 0);
    assert.equal(result.exclusions.exclusionCount, 0);
  });

  test("accepts the exact five-minute game-state freshness boundary", () => {
    const value = bundle();
    value.gameStateRoot.observedAtMs = NOW_MS - 300_000;
    const gameEvidence = createNhlGameObservationSnapshotEvidence({
      observationSnapshotId: IDS.observationSnapshot,
      provider: value.gameStateRoot.provider,
      sourceVersion: value.gameStateRoot.sourceVersion,
      observedAtMs: value.gameStateRoot.observedAtMs,
      freshnessStatus: "fresh",
      games: value.gameStates,
    });
    value.gameStateRoot.observationSha256 = gameEvidence.observationSha256;
    value.exclusionRoot.observationSha256 = gameEvidence.observationSha256;
    const exclusionEvidence = createMatchupLateLockExclusionSetEvidence({
      exclusionSetId: IDS.exclusionSet,
      leagueId: IDS.league,
      seasonId: IDS.season,
      matchupWeekId: IDS.week,
      matchupId: IDS.matchup,
      teamId: IDS.team,
      matchupRosterLockId: IDS.lock,
      lateSnapshotAtMs: NOW_MS,
      observationSnapshotId: IDS.observationSnapshot,
      observationSha256: gameEvidence.observationSha256,
      exclusions: value.exclusions,
    });
    value.exclusionRoot.evidenceSha256 = exclusionEvidence.evidenceSha256;
    assert.doesNotThrow(() => verifySealedLateLockEvidence(value));
    value.gameStateRoot.observedAtMs -= 1;
    assert.throws(
      () => verifySealedLateLockEvidence(value),
      { code: MATCHUP_SEALED_EVIDENCE_CODES.freshnessInvalid }
    );
  });

  test("fails closed when any of the four roots or child sets is tampered", () => {
    const cases = [
      (value) => { value.playerGameRoot.coverageSha256 = "0".repeat(64); },
      (value) => { value.playerGameRoot.evidenceSha256 = "0".repeat(64); },
      (value) => { value.gameStateRoot.observationSha256 = "0".repeat(64); },
      (value) => { value.exclusionRoot.evidenceSha256 = "0".repeat(64); },
      (value) => { value.coverage[0].nhlGameScheduledStartsAtMs -= 1; },
      (value) => { value.playerGameObservations[0].goals = 1; },
      (value) => { value.gameStates[0].observedGameState = "final"; },
      (value) => { value.exclusions[0].baselinePlayerGameStatObservationId = id(99); },
    ];
    for (const mutate of cases) {
      const value = clone(bundle());
      mutate(value);
      assert.throws(
        () => verifySealedLateLockEvidence(value),
        (error) =>
          error?.code === MATCHUP_SEALED_EVIDENCE_CODES.digestMismatch ||
          error?.code === MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch ||
          error?.code === MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid
      );
    }
  });

  test("rejects missing selected coverage and missing or extra game-state rows", () => {
    const missingCoverage = clone(bundle());
    missingCoverage.selectedRosterPlayers.push({
      playerId: id(90),
      matchupRosterPlayerId: id(91),
    });
    assert.throws(
      () => verifySealedLateLockEvidence(missingCoverage),
      { code: MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch }
    );

    for (const gameStates of [[], [
      ...bundle().gameStates,
      {
        nhlGameId: "2026020099",
        nhlGameScheduledStartsAtMs: NOW_MS,
        observedGameState: "scheduled",
      },
    ]]) {
      const value = clone(bundle());
      value.gameStates = gameStates;
      assert.throws(() => verifySealedLateLockEvidence(value));
    }
  });

  test("rejects provider mismatch while allowing independent source versions", () => {
    const value = clone(bundle());
    value.gameStateRoot.provider = "other-provider";
    const gameEvidence = createNhlGameObservationSnapshotEvidence({
      observationSnapshotId: IDS.observationSnapshot,
      provider: value.gameStateRoot.provider,
      sourceVersion: value.gameStateRoot.sourceVersion,
      observedAtMs: value.gameStateRoot.observedAtMs,
      freshnessStatus: "fresh",
      games: value.gameStates,
    });
    value.gameStateRoot.observationSha256 =
      gameEvidence.observationSha256;
    value.exclusionRoot.observationSha256 =
      gameEvidence.observationSha256;
    value.exclusionRoot.evidenceSha256 =
      createMatchupLateLockExclusionSetEvidence({
        exclusionSetId: IDS.exclusionSet,
        leagueId: IDS.league,
        seasonId: IDS.season,
        matchupWeekId: IDS.week,
        matchupId: IDS.matchup,
        teamId: IDS.team,
        matchupRosterLockId: IDS.lock,
        lateSnapshotAtMs: NOW_MS,
        observationSnapshotId: IDS.observationSnapshot,
        observationSha256: gameEvidence.observationSha256,
        exclusions: value.exclusions,
      }).evidenceSha256;
    assert.throws(
      () => verifySealedLateLockEvidence(value),
      { code: MATCHUP_SEALED_EVIDENCE_CODES.providerMismatch }
    );
  });

  test("rejects missing, extra, or terminal-coverage exclusions", () => {
    const missing = clone(bundle());
    missing.exclusions = [];
    assert.throws(() => verifySealedLateLockEvidence(missing));

    const terminal = clone(bundle({ terminal: true }));
    terminal.exclusions.push(clone(bundle().exclusions[0]));
    assert.throws(() => verifySealedLateLockEvidence(terminal));
  });
});
