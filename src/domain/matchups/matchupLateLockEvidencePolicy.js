const {
  compareUnicodeScalarStrings,
  hashCanonicalJsonV1,
} = require("../leagues/seasonRolloverEvidencePolicy");
const {
  OBSERVED_GAME_STATES,
} = require("../statistics/playerGameStatisticsPolicy");

const NHL_GAME_OBSERVATION_SNAPSHOT_DOMAIN =
  "hundo-leago.nhl-game-observation-snapshot";
const MATCHUP_LATE_LOCK_EXCLUSION_SET_DOMAIN =
  "hundo-leago.matchup-late-lock-exclusion-set";
const MATCHUP_LATE_LOCK_EVIDENCE_SCHEMA_VERSION = 1;
const NHL_GAME_OBSERVATION_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
const MATCHUP_LATE_LOCK_EVIDENCE_CODES = Object.freeze({
  inputInvalid: "MATCHUP_LATE_LOCK_EVIDENCE_INPUT_INVALID",
  observationIncomplete:
    "MATCHUP_LATE_LOCK_GAME_OBSERVATION_INCOMPLETE",
  observationFuture: "MATCHUP_LATE_LOCK_GAME_OBSERVATION_FUTURE",
  observationStale: "MATCHUP_LATE_LOCK_GAME_OBSERVATION_STALE",
});
const WHOLE_GAME_EXCLUSION_STATES = Object.freeze([
  "in_progress",
  "intermission",
  "final",
]);

const OBSERVED_GAME_STATE_SET = new Set(OBSERVED_GAME_STATES);
const WHOLE_GAME_EXCLUSION_STATE_SET = new Set(
  WHOLE_GAME_EXCLUSION_STATES
);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

class MatchupLateLockEvidencePolicyError extends Error {
  constructor(code, message, { details } = {}) {
    super(message);
    this.name = "MatchupLateLockEvidencePolicyError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function fail(code, message, details) {
  throw new MatchupLateLockEvidencePolicyError(code, message, {
    details,
  });
}

function exactKeys(value, keys, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      `${description} must be an object.`
    );
  }
  const actual = Object.keys(value).sort(compareUnicodeScalarStrings);
  const expected = [...keys].sort(compareUnicodeScalarStrings);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      `${description} has an invalid shape.`
    );
  }
  return value;
}

function stableId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      `${description} must be a canonical stable identifier.`
    );
  }
  return value;
}

function boundedText(value, maximum, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      `${description} must be a bounded canonical string.`
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      `${description} must be a safe UTC timestamp.`
    );
  }
  return value;
}

function observedGameState(value) {
  if (!OBSERVED_GAME_STATE_SET.has(value)) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      "A supported observed NHL game state is required."
    );
  }
  return value;
}

function nhlGameId(value) {
  const normalized = typeof value === "number" ? String(value) : value;
  return boundedText(normalized, 200, "NHL game identifier");
}

function canonicalSha256(value, description) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      `${description} must be a lowercase SHA-256 digest.`
    );
  }
  return value;
}

function freezeArray(values) {
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}

function createNhlGameObservationSnapshotEvidence({
  observationSnapshotId,
  provider,
  sourceVersion,
  observedAtMs,
  freshnessStatus,
  games,
} = {}) {
  if (!Array.isArray(games)) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      "NHL game observations must be an array."
    );
  }
  const normalized = games.map((candidate) => {
    const game = exactKeys(
      candidate,
      [
        "nhlGameId",
        "nhlGameScheduledStartsAtMs",
        "observedGameState",
      ],
      "NHL game observation"
    );
    return {
      nhlGameId: nhlGameId(game.nhlGameId),
      nhlGameScheduledStartsAtMs: safeTimestamp(
        game.nhlGameScheduledStartsAtMs,
        "Scheduled NHL game start"
      ),
      observedGameState: observedGameState(
        game.observedGameState
      ),
    };
  });
  normalized.sort((left, right) =>
    compareUnicodeScalarStrings(left.nhlGameId, right.nhlGameId)
  );
  const gameIds = new Set();
  for (const game of normalized) {
    if (gameIds.has(game.nhlGameId)) {
      fail(
        MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
        "NHL game observations contain a duplicate game."
      );
    }
    gameIds.add(game.nhlGameId);
  }
  if (freshnessStatus !== "fresh") {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      "Only a fresh NHL game observation snapshot may be sealed."
    );
  }
  const frozenGames = freezeArray(normalized);
  const preimage = Object.freeze({
    domain: NHL_GAME_OBSERVATION_SNAPSHOT_DOMAIN,
    schemaVersion: MATCHUP_LATE_LOCK_EVIDENCE_SCHEMA_VERSION,
    observationSnapshotId: stableId(
      observationSnapshotId,
      "Observation-snapshot identifier"
    ),
    provider: boundedText(provider, 100, "Provider"),
    sourceVersion: boundedText(
      sourceVersion,
      200,
      "Source version"
    ),
    observedAtMs: safeTimestamp(observedAtMs, "Observation time"),
    freshnessStatus,
    games: frozenGames,
  });
  return Object.freeze({
    preimage,
    observationCount: frozenGames.length,
    observationSha256: hashCanonicalJsonV1(preimage),
  });
}

function isWholeGameExcluded({
  nhlGameScheduledStartsAtMs,
  observedGameState: state,
  lateSnapshotAtMs,
} = {}) {
  const scheduledAt = safeTimestamp(
    nhlGameScheduledStartsAtMs,
    "Scheduled NHL game start"
  );
  const snapshotAt = safeTimestamp(
    lateSnapshotAtMs,
    "Late snapshot time"
  );
  const normalizedState = observedGameState(state);
  const excluded = WHOLE_GAME_EXCLUSION_STATE_SET.has(normalizedState);
  if (excluded && scheduledAt > snapshotAt) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      "An excluded NHL game cannot start after the late snapshot."
    );
  }
  return excluded;
}

function assertFreshNhlGameObservation({
  observedAtMs,
  lateSnapshotAtMs,
} = {}) {
  const observedAt = safeTimestamp(observedAtMs, "Observation time");
  const snapshotAt = safeTimestamp(
    lateSnapshotAtMs,
    "Late snapshot time"
  );
  if (observedAt > snapshotAt) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.observationFuture,
      "The NHL game observation follows the late snapshot."
    );
  }
  const ageMs = snapshotAt - observedAt;
  if (ageMs > NHL_GAME_OBSERVATION_FRESHNESS_WINDOW_MS) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.observationStale,
      "The NHL game observation is stale.",
      { ageMs, maximumAgeMs: NHL_GAME_OBSERVATION_FRESHNESS_WINDOW_MS }
    );
  }
  return Object.freeze({ freshnessStatus: "fresh", ageMs });
}

function normalizeExclusion(candidate, lateSnapshotAtMs) {
  const exclusion = exactKeys(
    candidate,
    [
      "exclusionId",
      "matchupRosterPlayerId",
      "playerId",
      "nhlGameId",
      "nhlGameScheduledStartsAtMs",
      "observedGameState",
      "baselinePlayerGameStatObservationId",
    ],
    "Late-lock exclusion"
  );
  const game = {
    nhlGameScheduledStartsAtMs: exclusion.nhlGameScheduledStartsAtMs,
    observedGameState: exclusion.observedGameState,
    lateSnapshotAtMs,
  };
  if (!isWholeGameExcluded(game)) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      "A late-lock exclusion must identify a game already underway."
    );
  }
  return {
    exclusionId: stableId(
      exclusion.exclusionId,
      "Exclusion identifier"
    ),
    matchupRosterPlayerId: stableId(
      exclusion.matchupRosterPlayerId,
      "Matchup roster-player identifier"
    ),
    playerId: stableId(
      exclusion.playerId,
      "Player identifier"
    ),
    nhlGameId: nhlGameId(exclusion.nhlGameId),
    nhlGameScheduledStartsAtMs: safeTimestamp(
      exclusion.nhlGameScheduledStartsAtMs,
      "Scheduled NHL game start"
    ),
    observedGameState: exclusion.observedGameState,
    baselinePlayerGameStatObservationId: stableId(
      exclusion.baselinePlayerGameStatObservationId,
      "Baseline player-game observation identifier"
    ),
  };
}

function createMatchupLateLockExclusionSetEvidence({
  exclusionSetId,
  leagueId,
  seasonId,
  matchupWeekId,
  matchupId,
  teamId,
  matchupRosterLockId,
  lateSnapshotAtMs,
  observationSnapshotId,
  observationSha256,
  exclusions,
} = {}) {
  if (!Array.isArray(exclusions)) {
    fail(
      MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
      "Late-lock exclusions must be an array."
    );
  }
  const snapshotAt = safeTimestamp(
    lateSnapshotAtMs,
    "Late snapshot time"
  );
  const normalized = exclusions.map((exclusion) =>
    normalizeExclusion(exclusion, snapshotAt)
  );
  normalized.sort((left, right) => (
    compareUnicodeScalarStrings(left.playerId, right.playerId) ||
    compareUnicodeScalarStrings(left.nhlGameId, right.nhlGameId) ||
    compareUnicodeScalarStrings(
      left.exclusionId,
      right.exclusionId
    )
  ));
  const identities = new Set();
  const exclusionIds = new Set();
  for (const exclusion of normalized) {
    const identity =
      `${exclusion.playerId}\u0000${exclusion.nhlGameId}`;
    if (
      identities.has(identity) ||
      exclusionIds.has(exclusion.exclusionId)
    ) {
      fail(
        MATCHUP_LATE_LOCK_EVIDENCE_CODES.inputInvalid,
        "Late-lock exclusions contain a duplicate identity."
      );
    }
    identities.add(identity);
    exclusionIds.add(exclusion.exclusionId);
  }
  const frozenExclusions = freezeArray(normalized);
  const preimage = Object.freeze({
    domain: MATCHUP_LATE_LOCK_EXCLUSION_SET_DOMAIN,
    schemaVersion: MATCHUP_LATE_LOCK_EVIDENCE_SCHEMA_VERSION,
    exclusionSetId: stableId(
      exclusionSetId,
      "Exclusion-set identifier"
    ),
    leagueId: stableId(leagueId, "League identifier"),
    seasonId: stableId(seasonId, "Season identifier"),
    matchupWeekId: stableId(
      matchupWeekId,
      "Matchup-week identifier"
    ),
    matchupId: stableId(matchupId, "Matchup identifier"),
    teamId: stableId(teamId, "Team identifier"),
    matchupRosterLockId: stableId(
      matchupRosterLockId,
      "Matchup roster-lock identifier"
    ),
    lateSnapshotAtMs: snapshotAt,
    observationSnapshotId: stableId(
      observationSnapshotId,
      "Observation-snapshot identifier"
    ),
    observationSha256: canonicalSha256(
      observationSha256,
      "Observation digest"
    ),
    exclusions: frozenExclusions,
  });
  return Object.freeze({
    preimage,
    exclusionCount: frozenExclusions.length,
    evidenceSha256: hashCanonicalJsonV1(preimage),
  });
}

module.exports = {
  MATCHUP_LATE_LOCK_EVIDENCE_CODES,
  MATCHUP_LATE_LOCK_EVIDENCE_SCHEMA_VERSION,
  MATCHUP_LATE_LOCK_EXCLUSION_SET_DOMAIN,
  MatchupLateLockEvidencePolicyError,
  NHL_GAME_OBSERVATION_SNAPSHOT_DOMAIN,
  NHL_GAME_OBSERVATION_FRESHNESS_WINDOW_MS,
  WHOLE_GAME_EXCLUSION_STATES,
  assertFreshNhlGameObservation,
  createMatchupLateLockExclusionSetEvidence,
  createNhlGameObservationSnapshotEvidence,
  isWholeGameExcluded,
};
