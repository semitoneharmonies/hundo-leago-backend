const {
  PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION,
  createPlayerGameCoverageSetEvidence,
} = require("../statistics/playerGameCoveragePolicy");
const {
  PLAYER_GAME_OBSERVATION_SET_SCHEMA_VERSION,
  createPlayerGameObservationSetEvidence,
} = require("../statistics/playerGameStatisticsPolicy");
const {
  MATCHUP_LATE_LOCK_EVIDENCE_SCHEMA_VERSION,
  WHOLE_GAME_EXCLUSION_STATES,
  assertFreshNhlGameObservation,
  createMatchupLateLockExclusionSetEvidence,
  createNhlGameObservationSnapshotEvidence,
} = require("./matchupLateLockEvidencePolicy");

const MATCHUP_SEALED_EVIDENCE_CODES = Object.freeze({
  inputInvalid: "MATCHUP_SEALED_EVIDENCE_INPUT_INVALID",
  countMismatch: "MATCHUP_SEALED_EVIDENCE_COUNT_MISMATCH",
  digestMismatch: "MATCHUP_SEALED_EVIDENCE_DIGEST_MISMATCH",
  exactSetMismatch: "MATCHUP_SEALED_EVIDENCE_EXACT_SET_MISMATCH",
  providerMismatch: "MATCHUP_SEALED_EVIDENCE_PROVIDER_MISMATCH",
  freshnessInvalid: "MATCHUP_SEALED_EVIDENCE_FRESHNESS_INVALID",
});

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PLAYER_GAME_ROOT_KEYS = Object.freeze([
  "setId",
  "statSourceId",
  "refreshId",
  "nhlSeasonKey",
  "provider",
  "sourceVersion",
  "capturedAtMs",
  "requiredPlayerCount",
  "coverageEntryCount",
  "expectedPlayerGameCount",
  "coverageSchemaVersion",
  "coverageSha256",
  "observationCount",
  "evidenceSchemaVersion",
  "evidenceSha256",
]);
const GAME_STATE_ROOT_KEYS = Object.freeze([
  "observationSnapshotId",
  "provider",
  "sourceVersion",
  "observedAtMs",
  "freshnessStatus",
  "observationCount",
  "evidenceSchemaVersion",
  "observationSha256",
]);
const EXCLUSION_ROOT_KEYS = Object.freeze([
  "exclusionSetId",
  "leagueId",
  "seasonId",
  "matchupWeekId",
  "matchupId",
  "teamId",
  "matchupRosterLockId",
  "lateSnapshotAtMs",
  "observationSnapshotId",
  "observationSha256",
  "exclusionCount",
  "evidenceSchemaVersion",
  "evidenceSha256",
]);
const SELECTED_ROSTER_PLAYER_KEYS = Object.freeze([
  "playerId",
  "matchupRosterPlayerId",
]);
const BUNDLE_KEYS = Object.freeze([
  "playerGameRoot",
  "coverage",
  "playerGameObservations",
  "selectedRosterPlayers",
  "weekStartsAtMs",
  "weekEndsAtMs",
  "gameStateRoot",
  "gameStates",
  "exclusionRoot",
  "exclusions",
]);
const EXCLUDED_STATE_SET = new Set(WHOLE_GAME_EXCLUSION_STATES);

class MatchupSealedEvidenceVerificationError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MatchupSealedEvidenceVerificationError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function fail(code, message, details, cause) {
  throw new MatchupSealedEvidenceVerificationError(code, message, {
    cause,
    details,
  });
}

function exactObject(value, keys, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      `${description} must be an object.`
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      `${description} has an invalid shape.`
    );
  }
  return value;
}

function array(value, description) {
  if (!Array.isArray(value)) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      `${description} must be an array.`
    );
  }
  return value;
}

function stableId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      `${description} must be a canonical stable identifier.`
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      `${description} must be a safe timestamp.`
    );
  }
  return value;
}

function nonnegativeInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      `${description} must be a nonnegative integer.`
    );
  }
  return value;
}

function digest(value, description) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      `${description} must be a lowercase SHA-256 digest.`
    );
  }
  return value;
}

function assertEqual(actual, expected, code, message, details) {
  if (actual !== expected) fail(code, message, details);
}

function deriveRequiredPlayers(coverage) {
  const byPlayer = new Map();
  for (const entry of coverage) {
    const existing = byPlayer.get(entry.playerId);
    if (
      existing !== undefined &&
      existing !== entry.providerPlayerId
    ) {
      fail(
        MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
        "Coverage binds one selected player to multiple provider players.",
        { playerId: entry.playerId }
      );
    }
    byPlayer.set(entry.playerId, entry.providerPlayerId);
  }
  return [...byPlayer.entries()].map(
    ([playerId, providerPlayerId]) => ({
      playerId,
      providerPlayerId,
    })
  );
}

function verifySealedPlayerGameSet({
  root,
  coverage,
  observations,
} = {}) {
  const normalizedRoot = exactObject(
    root,
    PLAYER_GAME_ROOT_KEYS,
    "Player-game root"
  );
  const coverageRows = array(coverage, "Coverage rows");
  const observationRows = array(
    observations,
    "Player-game observations"
  );
  const requiredPlayers = deriveRequiredPlayers(coverageRows);
  let coverageEvidence;
  let observationEvidence;
  try {
    coverageEvidence = createPlayerGameCoverageSetEvidence({
      setId: normalizedRoot.setId,
      statSourceId: normalizedRoot.statSourceId,
      refreshId: normalizedRoot.refreshId,
      nhlSeasonKey: normalizedRoot.nhlSeasonKey,
      provider: normalizedRoot.provider,
      sourceVersion: normalizedRoot.sourceVersion,
      capturedAtMs: normalizedRoot.capturedAtMs,
      requiredPlayers,
      coverage: coverageRows,
    });
    observationEvidence = createPlayerGameObservationSetEvidence({
      setId: normalizedRoot.setId,
      statSourceId: normalizedRoot.statSourceId,
      refreshId: normalizedRoot.refreshId,
      nhlSeasonKey: normalizedRoot.nhlSeasonKey,
      provider: normalizedRoot.provider,
      sourceVersion: normalizedRoot.sourceVersion,
      capturedAtMs: normalizedRoot.capturedAtMs,
      observations: observationRows,
    });
  } catch (error) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      "Player-game evidence is not canonical.",
      undefined,
      error
    );
  }

  assertEqual(
    normalizedRoot.coverageSchemaVersion,
    PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION,
    MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
    "The coverage schema version is invalid."
  );
  assertEqual(
    normalizedRoot.evidenceSchemaVersion,
    PLAYER_GAME_OBSERVATION_SET_SCHEMA_VERSION,
    MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
    "The observation schema version is invalid."
  );
  for (const [actual, expected, description] of [
    [normalizedRoot.requiredPlayerCount, coverageEvidence.requiredPlayerCount, "required-player"],
    [normalizedRoot.coverageEntryCount, coverageEvidence.coverageEntryCount, "coverage-entry"],
    [normalizedRoot.expectedPlayerGameCount, coverageEvidence.expectedPlayerGameCount, "expected-game"],
    [normalizedRoot.observationCount, observationEvidence.observationCount, "observation"],
  ]) {
    nonnegativeInteger(actual, `${description} count`);
    assertEqual(
      actual,
      expected,
      MATCHUP_SEALED_EVIDENCE_CODES.countMismatch,
      `The sealed ${description} count does not match its children.`
    );
  }
  assertEqual(
    digest(normalizedRoot.coverageSha256, "Coverage digest"),
    coverageEvidence.coverageSha256,
    MATCHUP_SEALED_EVIDENCE_CODES.digestMismatch,
    "The sealed coverage digest does not match its children."
  );
  assertEqual(
    digest(normalizedRoot.evidenceSha256, "Observation digest"),
    observationEvidence.evidenceSha256,
    MATCHUP_SEALED_EVIDENCE_CODES.digestMismatch,
    "The sealed observation digest does not match its children."
  );

  const expectedCoverage = new Map();
  for (const entry of coverageEvidence.preimage.coverage) {
    if (entry.disposition !== "expected_game") continue;
    expectedCoverage.set(
      `${entry.playerId}\u0000${entry.nhlGameId}`,
      entry
    );
  }
  const observed = new Map(
    observationEvidence.preimage.observations.map((entry) => [
      `${entry.playerId}\u0000${entry.nhlGameId}`,
      entry,
    ])
  );
  if (expectedCoverage.size !== observed.size) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
      "Expected-game coverage and player-game observations differ."
    );
  }
  for (const [identity, entry] of expectedCoverage) {
    const observation = observed.get(identity);
    if (
      !observation ||
      observation.nhlGameScheduledStartsAtMs !==
        entry.nhlGameScheduledStartsAtMs
    ) {
      fail(
        MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
        "Expected-game coverage is not bound to one exact observation."
      );
    }
  }
  return Object.freeze({
    root: Object.freeze({ ...normalizedRoot }),
    coverageEvidence,
    observationEvidence,
  });
}

function verifySealedGameState({ root, games, lateSnapshotAtMs } = {}) {
  const normalizedRoot = exactObject(
    root,
    GAME_STATE_ROOT_KEYS,
    "Game-state root"
  );
  let evidence;
  try {
    assertFreshNhlGameObservation({
      observedAtMs: normalizedRoot.observedAtMs,
      lateSnapshotAtMs,
    });
    evidence = createNhlGameObservationSnapshotEvidence({
      observationSnapshotId:
        normalizedRoot.observationSnapshotId,
      provider: normalizedRoot.provider,
      sourceVersion: normalizedRoot.sourceVersion,
      observedAtMs: normalizedRoot.observedAtMs,
      freshnessStatus: normalizedRoot.freshnessStatus,
      games: array(games, "Game-state observations"),
    });
  } catch (error) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.freshnessInvalid,
      "Game-state evidence is invalid or stale.",
      undefined,
      error
    );
  }
  assertEqual(
    normalizedRoot.evidenceSchemaVersion,
    MATCHUP_LATE_LOCK_EVIDENCE_SCHEMA_VERSION,
    MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
    "The game-state schema version is invalid."
  );
  nonnegativeInteger(
    normalizedRoot.observationCount,
    "Game-state observation count"
  );
  assertEqual(
    normalizedRoot.observationCount,
    evidence.observationCount,
    MATCHUP_SEALED_EVIDENCE_CODES.countMismatch,
    "The game-state count does not match its children."
  );
  assertEqual(
    digest(normalizedRoot.observationSha256, "Game-state digest"),
    evidence.observationSha256,
    MATCHUP_SEALED_EVIDENCE_CODES.digestMismatch,
    "The game-state digest does not match its children."
  );
  return evidence;
}

function verifySealedExclusions({ root, exclusions } = {}) {
  const normalizedRoot = exactObject(
    root,
    EXCLUSION_ROOT_KEYS,
    "Exclusion root"
  );
  let evidence;
  try {
    evidence = createMatchupLateLockExclusionSetEvidence({
      exclusionSetId: normalizedRoot.exclusionSetId,
      leagueId: normalizedRoot.leagueId,
      seasonId: normalizedRoot.seasonId,
      matchupWeekId: normalizedRoot.matchupWeekId,
      matchupId: normalizedRoot.matchupId,
      teamId: normalizedRoot.teamId,
      matchupRosterLockId:
        normalizedRoot.matchupRosterLockId,
      lateSnapshotAtMs: normalizedRoot.lateSnapshotAtMs,
      observationSnapshotId:
        normalizedRoot.observationSnapshotId,
      observationSha256: normalizedRoot.observationSha256,
      exclusions: array(exclusions, "Late-lock exclusions"),
    });
  } catch (error) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      "Late-lock exclusion evidence is not canonical.",
      undefined,
      error
    );
  }
  assertEqual(
    normalizedRoot.evidenceSchemaVersion,
    MATCHUP_LATE_LOCK_EVIDENCE_SCHEMA_VERSION,
    MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
    "The exclusion schema version is invalid."
  );
  nonnegativeInteger(normalizedRoot.exclusionCount, "Exclusion count");
  assertEqual(
    normalizedRoot.exclusionCount,
    evidence.exclusionCount,
    MATCHUP_SEALED_EVIDENCE_CODES.countMismatch,
    "The exclusion count does not match its children."
  );
  assertEqual(
    digest(normalizedRoot.evidenceSha256, "Exclusion digest"),
    evidence.evidenceSha256,
    MATCHUP_SEALED_EVIDENCE_CODES.digestMismatch,
    "The exclusion digest does not match its children."
  );
  return evidence;
}

function normalizeSelectedRosterPlayers(value) {
  const players = array(value, "Selected roster players").map(
    (candidate) => {
      const row = exactObject(
        candidate,
        SELECTED_ROSTER_PLAYER_KEYS,
        "Selected roster player"
      );
      return Object.freeze({
        playerId: stableId(row.playerId, "Player identifier"),
        matchupRosterPlayerId: stableId(
          row.matchupRosterPlayerId,
          "Matchup roster-player identifier"
        ),
      });
    }
  );
  const playerIds = new Set();
  const rosterPlayerIds = new Set();
  for (const row of players) {
    if (
      playerIds.has(row.playerId) ||
      rosterPlayerIds.has(row.matchupRosterPlayerId)
    ) {
      fail(
        MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
        "Selected roster players contain a duplicate identity."
      );
    }
    playerIds.add(row.playerId);
    rosterPlayerIds.add(row.matchupRosterPlayerId);
  }
  return Object.freeze(players);
}

function verifySealedLateLockEvidence(input = {}) {
  const bundle = exactObject(
    input,
    BUNDLE_KEYS,
    "Late-lock evidence bundle"
  );
  const weekStartsAtMs = safeTimestamp(
    bundle.weekStartsAtMs,
    "Matchup-week start"
  );
  const weekEndsAtMs = safeTimestamp(
    bundle.weekEndsAtMs,
    "Matchup-week end"
  );
  if (weekEndsAtMs <= weekStartsAtMs) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.inputInvalid,
      "The matchup-week window is invalid."
    );
  }
  const selected = normalizeSelectedRosterPlayers(
    bundle.selectedRosterPlayers
  );
  const playerGame = verifySealedPlayerGameSet({
    root: bundle.playerGameRoot,
    coverage: bundle.coverage,
    observations: bundle.playerGameObservations,
  });
  const gameState = verifySealedGameState({
    root: bundle.gameStateRoot,
    games: bundle.gameStates,
    lateSnapshotAtMs: bundle.exclusionRoot?.lateSnapshotAtMs,
  });
  const exclusions = verifySealedExclusions({
    root: bundle.exclusionRoot,
    exclusions: bundle.exclusions,
  });

  if (
    bundle.playerGameRoot.provider !==
      bundle.gameStateRoot.provider
  ) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.providerMismatch,
      "Statistics and game-state evidence use incompatible providers."
    );
  }
  if (
    bundle.exclusionRoot.observationSnapshotId !==
      bundle.gameStateRoot.observationSnapshotId ||
    bundle.exclusionRoot.observationSha256 !==
      bundle.gameStateRoot.observationSha256
  ) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
      "The exclusion root does not bind the verified game-state snapshot."
    );
  }

  const selectedByPlayer = new Map(
    selected.map((row) => [row.playerId, row])
  );
  const coverageByPlayer = new Map();
  for (const entry of playerGame.coverageEvidence.preimage.coverage) {
    const rows = coverageByPlayer.get(entry.playerId) || [];
    rows.push(entry);
    coverageByPlayer.set(entry.playerId, rows);
  }
  for (const player of selected) {
    if (!coverageByPlayer.has(player.playerId)) {
      fail(
        MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
        "A selected roster player lacks affirmative coverage.",
        { playerId: player.playerId }
      );
    }
  }

  const requiredGames = new Map();
  const expectedPairs = new Map();
  for (const player of selected) {
    for (const entry of coverageByPlayer.get(player.playerId)) {
      if (
        entry.disposition !== "expected_game" ||
        entry.nhlGameScheduledStartsAtMs < weekStartsAtMs ||
        entry.nhlGameScheduledStartsAtMs >= weekEndsAtMs
      ) {
        continue;
      }
      const previousStart = requiredGames.get(entry.nhlGameId);
      if (
        previousStart !== undefined &&
        previousStart !== entry.nhlGameScheduledStartsAtMs
      ) {
        fail(
          MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
          "Selected coverage contains conflicting game starts."
        );
      }
      requiredGames.set(
        entry.nhlGameId,
        entry.nhlGameScheduledStartsAtMs
      );
      expectedPairs.set(
        `${entry.playerId}\u0000${entry.nhlGameId}`,
        entry
      );
    }
  }
  const statesByGame = new Map(
    gameState.preimage.games.map((row) => [row.nhlGameId, row])
  );
  if (statesByGame.size !== requiredGames.size) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
      "The game-state snapshot does not equal the selected due-game set."
    );
  }
  for (const [gameId, startsAtMs] of requiredGames) {
    if (
      statesByGame.get(gameId)?.nhlGameScheduledStartsAtMs !==
      startsAtMs
    ) {
      fail(
        MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
        "The game-state snapshot is not bound to one selected due game."
      );
    }
  }

  const observationsByPair = new Map(
    playerGame.observationEvidence.preimage.observations.map((row) => [
      `${row.playerId}\u0000${row.nhlGameId}`,
      row,
    ])
  );
  const requiredExclusions = new Map();
  for (const [identity, entry] of expectedPairs) {
    const state = statesByGame.get(entry.nhlGameId);
    if (!EXCLUDED_STATE_SET.has(state.observedGameState)) continue;
    const baselineObservation = observationsByPair.get(identity);
    if (!baselineObservation) {
      fail(
        MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
        "An excluded selected pair lacks its baseline observation."
      );
    }
    requiredExclusions.set(identity, {
      entry,
      state,
      baselineObservation,
      selected: selectedByPlayer.get(entry.playerId),
    });
  }
  const actualExclusions = new Map(
    exclusions.preimage.exclusions.map((row) => [
      `${row.playerId}\u0000${row.nhlGameId}`,
      row,
    ])
  );
  if (actualExclusions.size !== requiredExclusions.size) {
    fail(
      MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
      "Late-lock exclusions do not equal the underway selected pairs."
    );
  }
  for (const [identity, expected] of requiredExclusions) {
    const actual = actualExclusions.get(identity);
    if (
      !actual ||
      actual.matchupRosterPlayerId !==
        expected.selected.matchupRosterPlayerId ||
      actual.baselinePlayerGameStatObservationId !==
        expected.baselineObservation.observationId ||
      actual.nhlGameScheduledStartsAtMs !==
        expected.entry.nhlGameScheduledStartsAtMs ||
      actual.observedGameState !== expected.state.observedGameState
    ) {
      fail(
        MATCHUP_SEALED_EVIDENCE_CODES.exactSetMismatch,
        "A late-lock exclusion is not bound to its exact selected pair."
      );
    }
  }

  return Object.freeze({
    playerGame,
    gameState,
    exclusions,
    selectedRosterPlayers: selected,
  });
}

module.exports = {
  MATCHUP_SEALED_EVIDENCE_CODES,
  MatchupSealedEvidenceVerificationError,
  verifySealedGameState,
  verifySealedExclusions,
  verifySealedLateLockEvidence,
  verifySealedPlayerGameSet,
};
