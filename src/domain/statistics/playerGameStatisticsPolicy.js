const {
  compareUnicodeScalarStrings,
  hashCanonicalJsonV1,
} = require("../leagues/seasonRolloverEvidencePolicy");
const {
  assertNhlSeasonKey,
} = require("./statisticsPolicy");

const PLAYER_GAME_OBSERVATION_SET_DOMAIN =
  "hundo-leago.player-game-stat-observation-set";
const PLAYER_GAME_OBSERVATION_SET_SCHEMA_VERSION = 1;
const PLAYER_GAME_STATISTICS_CODES = Object.freeze({
  inputInvalid: "PLAYER_GAME_STATISTICS_INPUT_INVALID",
  responseIncomplete: "PLAYER_GAME_STATISTICS_RESPONSE_INCOMPLETE",
});
const OBSERVED_GAME_STATES = Object.freeze([
  "scheduled",
  "pre_game",
  "in_progress",
  "intermission",
  "final",
  "postponed",
  "cancelled",
]);

const OBSERVED_GAME_STATE_SET = new Set(OBSERVED_GAME_STATES);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

class PlayerGameStatisticsPolicyError extends Error {
  constructor(code, message, { details } = {}) {
    super(message);
    this.name = "PlayerGameStatisticsPolicyError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function fail(code, message, details) {
  throw new PlayerGameStatisticsPolicyError(code, message, { details });
}

function exactKeys(value, keys, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
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
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      `${description} has an invalid shape.`
    );
  }
  return value;
}

function stableId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
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
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
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
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      `${description} must be a safe UTC timestamp.`
    );
  }
  return value;
}

function nonNegativeInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      `${description} must be a non-negative integer.`
    );
  }
  return value;
}

function externalPlayerId(value) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (
    typeof normalized !== "string" ||
    !/^\d{1,20}$/.test(normalized) ||
    normalized === "0"
  ) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      "A stable provider player identifier is required."
    );
  }
  return normalized;
}

function nhlGameId(value) {
  const normalized = typeof value === "number" ? String(value) : value;
  return boundedText(normalized, 200, "NHL game identifier");
}

function observedGameState(value) {
  if (!OBSERVED_GAME_STATE_SET.has(value)) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      "A supported observed NHL game state is required."
    );
  }
  return value;
}

function compareObservationIdentity(left, right) {
  return (
    compareUnicodeScalarStrings(left.playerId, right.playerId) ||
    compareUnicodeScalarStrings(left.nhlGameId, right.nhlGameId) ||
    compareUnicodeScalarStrings(left.observationId, right.observationId)
  );
}

function freezeArray(values) {
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}

function normalizePlayerGameStatisticsRows({
  rows,
  capturedAtMs,
  minimumObservationCount = 0,
} = {}) {
  if (!Array.isArray(rows)) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      "Player-game statistics rows must be an array."
    );
  }
  if (
    !Number.isSafeInteger(minimumObservationCount) ||
    minimumObservationCount < 0
  ) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      "The minimum player-game observation count is invalid."
    );
  }
  const capturedAt = safeTimestamp(capturedAtMs, "Capture time");
  const seen = new Set();
  const normalized = rows.map((candidate) => {
    const row = exactKeys(
      candidate,
      [
        "playerId",
        "nhlGameId",
        "nhlGameScheduledStartsAtMs",
        "observedGameState",
        "goals",
        "assists",
        "sourceUpdatedAtMs",
      ],
      "Player-game statistics row"
    );
    const providerPlayerId = externalPlayerId(row.playerId);
    const gameId = nhlGameId(row.nhlGameId);
    const identity = `${providerPlayerId}\u0000${gameId}`;
    if (seen.has(identity)) {
      fail(
        PLAYER_GAME_STATISTICS_CODES.inputInvalid,
        "Player-game statistics rows contain a duplicate player and game.",
        { externalPlayerId: providerPlayerId, nhlGameId: gameId }
      );
    }
    seen.add(identity);
    const goals = nonNegativeInteger(row.goals, "Goals");
    const assists = nonNegativeInteger(row.assists, "Assists");
    const updatedAt = safeTimestamp(
      row.sourceUpdatedAtMs,
      "Source update time"
    );
    if (updatedAt > capturedAt) {
      fail(
        PLAYER_GAME_STATISTICS_CODES.inputInvalid,
        "A player-game source update cannot follow its capture time."
      );
    }
    return {
      externalPlayerId: providerPlayerId,
      nhlGameId: gameId,
      nhlGameScheduledStartsAtMs: safeTimestamp(
        row.nhlGameScheduledStartsAtMs,
        "Scheduled NHL game start"
      ),
      observedGameState: observedGameState(row.observedGameState),
      goals,
      assists,
      nhlPoints: goals + assists,
      fantasyPointsHundredths: goals * 125 + assists * 100,
      sourceUpdatedAtMs: updatedAt,
    };
  });
  if (normalized.length < minimumObservationCount) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.responseIncomplete,
      "The player-game statistics response is incomplete.",
      {
        actualObservationCount: normalized.length,
        minimumObservationCount,
      }
    );
  }
  normalized.sort((left, right) => (
    compareUnicodeScalarStrings(
      left.externalPlayerId,
      right.externalPlayerId
    ) ||
    compareUnicodeScalarStrings(left.nhlGameId, right.nhlGameId)
  ));
  return freezeArray(normalized);
}

function normalizeEvidenceObservation(candidate, capturedAtMs) {
  const row = exactKeys(
    candidate,
    [
      "observationId",
      "playerId",
      "nhlGameId",
      "nhlGameScheduledStartsAtMs",
      "observedGameState",
      "goals",
      "assists",
      "nhlPoints",
      "fantasyPointsHundredths",
      "sourceUpdatedAtMs",
    ],
    "Player-game evidence observation"
  );
  const goals = nonNegativeInteger(row.goals, "Goals");
  const assists = nonNegativeInteger(row.assists, "Assists");
  const points = nonNegativeInteger(row.nhlPoints, "NHL points");
  const fantasyPoints = nonNegativeInteger(
    row.fantasyPointsHundredths,
    "Fantasy points"
  );
  if (
    points !== goals + assists ||
    fantasyPoints !== goals * 125 + assists * 100
  ) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      "Player-game evidence scoring values do not reconcile."
    );
  }
  const updatedAt = safeTimestamp(
    row.sourceUpdatedAtMs,
    "Source update time"
  );
  if (updatedAt > capturedAtMs) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      "A player-game source update cannot follow its capture time."
    );
  }
  return {
    observationId: stableId(row.observationId, "Observation identifier"),
    playerId: stableId(row.playerId, "Player identifier"),
    nhlGameId: nhlGameId(row.nhlGameId),
    nhlGameScheduledStartsAtMs: safeTimestamp(
      row.nhlGameScheduledStartsAtMs,
      "Scheduled NHL game start"
    ),
    observedGameState: observedGameState(row.observedGameState),
    goals,
    assists,
    nhlPoints: points,
    fantasyPointsHundredths: fantasyPoints,
    sourceUpdatedAtMs: updatedAt,
  };
}

function createPlayerGameObservationSetEvidence({
  setId,
  statSourceId,
  refreshId,
  nhlSeasonKey,
  provider,
  sourceVersion,
  capturedAtMs,
  observations,
} = {}) {
  const capturedAt = safeTimestamp(capturedAtMs, "Capture time");
  if (!Array.isArray(observations)) {
    fail(
      PLAYER_GAME_STATISTICS_CODES.inputInvalid,
      "Player-game evidence observations must be an array."
    );
  }
  const normalized = observations.map((row) =>
    normalizeEvidenceObservation(row, capturedAt)
  );
  normalized.sort(compareObservationIdentity);
  const identities = new Set();
  const observationIds = new Set();
  for (const row of normalized) {
    const identity = `${row.playerId}\u0000${row.nhlGameId}`;
    if (identities.has(identity) || observationIds.has(row.observationId)) {
      fail(
        PLAYER_GAME_STATISTICS_CODES.inputInvalid,
        "Player-game evidence observations contain a duplicate identity."
      );
    }
    identities.add(identity);
    observationIds.add(row.observationId);
  }
  const frozenObservations = freezeArray(normalized);
  const preimage = Object.freeze({
    domain: PLAYER_GAME_OBSERVATION_SET_DOMAIN,
    schemaVersion: PLAYER_GAME_OBSERVATION_SET_SCHEMA_VERSION,
    setId: stableId(setId, "Observation-set identifier"),
    statSourceId: stableId(statSourceId, "Statistics-source identifier"),
    refreshId: stableId(refreshId, "Refresh identifier"),
    nhlSeasonKey: assertNhlSeasonKey(nhlSeasonKey),
    provider: boundedText(provider, 100, "Provider"),
    sourceVersion: boundedText(sourceVersion, 200, "Source version"),
    capturedAtMs: capturedAt,
    observations: frozenObservations,
  });
  return Object.freeze({
    preimage,
    observationCount: frozenObservations.length,
    evidenceSha256: hashCanonicalJsonV1(preimage),
  });
}

module.exports = {
  OBSERVED_GAME_STATES,
  PLAYER_GAME_OBSERVATION_SET_DOMAIN,
  PLAYER_GAME_OBSERVATION_SET_SCHEMA_VERSION,
  PLAYER_GAME_STATISTICS_CODES,
  PlayerGameStatisticsPolicyError,
  createPlayerGameObservationSetEvidence,
  normalizePlayerGameStatisticsRows,
};
