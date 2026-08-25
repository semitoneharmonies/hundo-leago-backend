const {
  compareUnicodeScalarStrings,
  hashCanonicalJsonV1,
} = require("../leagues/seasonRolloverEvidencePolicy");
const {
  OBSERVED_GAME_STATES,
} = require("./playerGameStatisticsPolicy");

const PLAYER_GAME_COVERAGE_SET_DOMAIN =
  "hundo-leago.player-game-stat-coverage-set";
const PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION = 1;
const PLAYER_GAME_COVERAGE_REQUIREMENTS_DOMAIN =
  "hundo-leago.player-game-coverage-requirements";
const PLAYER_GAME_COVERAGE_REQUIREMENTS_SCHEMA_VERSION = 1;
const PLAYER_GAME_COVERAGE_DISPOSITIONS = Object.freeze([
  "expected_game",
  "no_due_game",
  "no_team",
]);
const PLAYER_GAME_COVERAGE_CODES = Object.freeze({
  inputInvalid: "PLAYER_GAME_COVERAGE_INPUT_INVALID",
  responseInvalid: "PLAYER_GAME_COVERAGE_RESPONSE_INVALID",
  responseIncomplete: "PLAYER_GAME_COVERAGE_RESPONSE_INCOMPLETE",
});

const DISPOSITION_SET = new Set(
  PLAYER_GAME_COVERAGE_DISPOSITIONS
);
const OBSERVED_GAME_STATE_SET = new Set(OBSERVED_GAME_STATES);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const REQUIRED_PLAYER_KEYS = Object.freeze([
  "playerId",
  "providerPlayerId",
]);
const REQUIRED_PLAYER_GAME_KEYS = Object.freeze([
  "playerId",
  "providerPlayerId",
  "providerTeamId",
  "nhlGameId",
  "nhlGameScheduledStartsAtMs",
]);
const PROVIDER_RESPONSE_KEYS = Object.freeze([
  "schemaVersion",
  "throughAtMs",
  "players",
]);
const PROVIDER_PLAYER_KEYS = Object.freeze([
  "playerId",
  "providerPlayerId",
  "providerTeamId",
  "disposition",
  "games",
]);
const PROVIDER_GAME_KEYS = Object.freeze([
  "providerTeamId",
  "nhlGameId",
  "nhlGameScheduledStartsAtMs",
  "observedGameState",
]);
const NORMALIZED_OBSERVATION_KEYS = Object.freeze([
  "externalPlayerId",
  "nhlGameId",
  "nhlGameScheduledStartsAtMs",
  "observedGameState",
  "goals",
  "assists",
  "nhlPoints",
  "fantasyPointsHundredths",
  "sourceUpdatedAtMs",
]);
const COVERAGE_EVIDENCE_KEYS = Object.freeze([
  "coverageEntryId",
  "playerId",
  "providerPlayerId",
  "providerTeamId",
  "disposition",
  "nhlGameId",
  "nhlGameScheduledStartsAtMs",
]);
const RESPONSE_INPUT_KEYS = Object.freeze([
  "requiredPlayers",
  "requiredPlayerGames",
  "response",
  "observationRows",
  "capturedAtMs",
]);
const EVIDENCE_INPUT_KEYS = Object.freeze([
  "setId",
  "statSourceId",
  "refreshId",
  "nhlSeasonKey",
  "provider",
  "sourceVersion",
  "capturedAtMs",
  "requiredPlayers",
  "coverage",
]);
const REQUIREMENTS_INPUT_KEYS = Object.freeze([
  "nhlSeasonKey",
  "playerIdentityProvider",
  "requiredPlayers",
  "requiredPlayerGames",
]);

class PlayerGameCoveragePolicyError extends Error {
  constructor(code, message, { reasonCode, details } = {}) {
    super(message);
    this.name = "PlayerGameCoveragePolicyError";
    this.code = code;
    if (reasonCode !== undefined) {
      this.reasonCode = reasonCode;
    }
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function fail(code, reasonCode, message, details) {
  throw new PlayerGameCoveragePolicyError(code, message, {
    reasonCode,
    details,
  });
}

function exactObject(value, keys, description, code) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(
      code,
      "shape_invalid",
      `${description} must be an object.`
    );
  }
  const actual = Object.keys(value).sort(
    compareUnicodeScalarStrings
  );
  const expected = [...keys].sort(compareUnicodeScalarStrings);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      code,
      "shape_invalid",
      `${description} has an invalid shape.`
    );
  }
  return value;
}

function requireArray(value, description, code) {
  if (!Array.isArray(value)) {
    fail(
      code,
      "shape_invalid",
      `${description} must be an array.`
    );
  }
  return value;
}

function stableId(value, description, code) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(
      code,
      "stable_id_invalid",
      `${description} must be a canonical stable identifier.`
    );
  }
  return value;
}

function boundedText(value, maximum, description, code) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(
      code,
      "bounded_text_invalid",
      `${description} must be a bounded canonical string.`
    );
  }
  return value;
}

function providerIdentity(value, maximum, description, code) {
  const normalized =
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1
      ? String(value)
      : value;
  return boundedText(normalized, maximum, description, code);
}

function safeTimestamp(value, description, code) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    fail(
      code,
      "timestamp_invalid",
      `${description} must be a safe UTC timestamp.`
    );
  }
  return value;
}

function nonNegativeInteger(value, description, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      code,
      "integer_invalid",
      `${description} must be a non-negative integer.`
    );
  }
  return value;
}

function seasonKey(value, code) {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) {
    fail(
      code,
      "nhl_season_key_invalid",
      "An NHL season key is required."
    );
  }
  const startYear = Number(value.slice(0, 4));
  const endYear = Number(value.slice(4));
  if (endYear !== startYear + 1) {
    fail(
      code,
      "nhl_season_key_invalid",
      "The NHL season key must contain consecutive years."
    );
  }
  return value;
}

function disposition(value, code) {
  if (!DISPOSITION_SET.has(value)) {
    fail(
      code,
      "disposition_invalid",
      "A supported player-game coverage disposition is required."
    );
  }
  return value;
}

function observedGameState(value, code) {
  if (!OBSERVED_GAME_STATE_SET.has(value)) {
    fail(
      code,
      "observed_game_state_invalid",
      "A supported observed NHL game state is required."
    );
  }
  return value;
}

function nhlGameId(value, code) {
  return providerIdentity(
    value,
    200,
    "NHL game identifier",
    code
  );
}

function compareNullableText(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareUnicodeScalarStrings(left, right);
}

function compareRequiredPlayers(left, right) {
  return (
    compareUnicodeScalarStrings(left.playerId, right.playerId) ||
    compareUnicodeScalarStrings(
      left.providerPlayerId,
      right.providerPlayerId
    )
  );
}

function compareSafeIntegers(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareRequiredPlayerGames(left, right) {
  return (
    compareUnicodeScalarStrings(left.playerId, right.playerId) ||
    compareUnicodeScalarStrings(left.nhlGameId, right.nhlGameId) ||
    compareSafeIntegers(
      left.nhlGameScheduledStartsAtMs,
      right.nhlGameScheduledStartsAtMs
    ) ||
    compareUnicodeScalarStrings(
      left.providerPlayerId,
      right.providerPlayerId
    ) ||
    compareUnicodeScalarStrings(
      left.providerTeamId,
      right.providerTeamId
    )
  );
}

function compareFlatCoverage(left, right) {
  return (
    compareUnicodeScalarStrings(left.playerId, right.playerId) ||
    compareUnicodeScalarStrings(
      left.disposition,
      right.disposition
    ) ||
    compareNullableText(left.nhlGameId, right.nhlGameId) ||
    compareUnicodeScalarStrings(
      left.providerPlayerId,
      right.providerPlayerId
    )
  );
}

function compareEvidenceCoverage(left, right) {
  return (
    compareUnicodeScalarStrings(left.playerId, right.playerId) ||
    compareUnicodeScalarStrings(
      left.disposition,
      right.disposition
    ) ||
    compareNullableText(left.nhlGameId, right.nhlGameId) ||
    compareUnicodeScalarStrings(
      left.coverageEntryId,
      right.coverageEntryId
    )
  );
}

function compareObservationRows(left, right) {
  return (
    compareUnicodeScalarStrings(
      left.externalPlayerId,
      right.externalPlayerId
    ) ||
    compareUnicodeScalarStrings(left.nhlGameId, right.nhlGameId)
  );
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function normalizeRequiredPlayerSet(requiredPlayers) {
  const players = requireArray(
    requiredPlayers,
    "Required players",
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  ).map((candidate) => {
    const player = exactObject(
      candidate,
      REQUIRED_PLAYER_KEYS,
      "Required player",
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    );
    return {
      playerId: stableId(
        player.playerId,
        "Required player identifier",
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      ),
      providerPlayerId: providerIdentity(
        player.providerPlayerId,
        100,
        "Required provider-player identifier",
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      ),
    };
  });
  players.sort(compareRequiredPlayers);

  const playerIds = new Set();
  const providerPlayerIds = new Set();
  for (const player of players) {
    if (
      playerIds.has(player.playerId) ||
      providerPlayerIds.has(player.providerPlayerId)
    ) {
      fail(
        PLAYER_GAME_COVERAGE_CODES.inputInvalid,
        "required_player_identity_duplicate",
        "Required players contain a duplicate identity."
      );
    }
    playerIds.add(player.playerId);
    providerPlayerIds.add(player.providerPlayerId);
  }
  return deepFreeze(players);
}

function normalizeRequiredPlayerGameSet(
  requiredPlayerGames,
  requiredPlayers
) {
  const players = normalizeRequiredPlayerSet(requiredPlayers);
  const requiredByPlayerId = new Map(
    players.map((player) => [player.playerId, player])
  );
  const games = requireArray(
    requiredPlayerGames,
    "Required player games",
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  ).map((candidate) => {
    const game = exactObject(
      candidate,
      REQUIRED_PLAYER_GAME_KEYS,
      "Required player game",
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    );
    const normalized = {
      playerId: stableId(
        game.playerId,
        "Required player-game player identifier",
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      ),
      providerPlayerId: providerIdentity(
        game.providerPlayerId,
        100,
        "Required player-game provider-player identifier",
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      ),
      providerTeamId: providerIdentity(
        game.providerTeamId,
        100,
        "Required player-game provider-team identifier",
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      ),
      nhlGameId: nhlGameId(
        game.nhlGameId,
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      ),
      nhlGameScheduledStartsAtMs: safeTimestamp(
        game.nhlGameScheduledStartsAtMs,
        "Required scheduled NHL game start",
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      ),
    };
    const requiredPlayer = requiredByPlayerId.get(
      normalized.playerId
    );
    if (
      !requiredPlayer ||
      requiredPlayer.providerPlayerId !==
        normalized.providerPlayerId
    ) {
      fail(
        PLAYER_GAME_COVERAGE_CODES.inputInvalid,
        "required_player_game_player_mismatch",
        "A required player game must reference an exact required player identity."
      );
    }
    return normalized;
  });
  games.sort(compareRequiredPlayerGames);
  const identities = new Set();
  for (const game of games) {
    const identity = `${game.playerId}\u0000${game.nhlGameId}`;
    if (identities.has(identity)) {
      fail(
        PLAYER_GAME_COVERAGE_CODES.inputInvalid,
        "required_player_game_identity_duplicate",
        "Required player games contain a duplicate player and game identity."
      );
    }
    identities.add(identity);
  }
  return deepFreeze(games);
}

function createPlayerGameCoverageRequirements(input = {}) {
  const requirements = exactObject(
    input,
    REQUIREMENTS_INPUT_KEYS,
    "Player-game coverage requirements input",
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  );
  const nhlSeasonKey = seasonKey(
    requirements.nhlSeasonKey,
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  );
  const playerIdentityProvider = boundedText(
    requirements.playerIdentityProvider,
    80,
    "Player identity provider",
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  );
  const requiredPlayers = normalizeRequiredPlayerSet(
    requirements.requiredPlayers
  );
  const requiredPlayerGames = normalizeRequiredPlayerGameSet(
    requirements.requiredPlayerGames,
    requiredPlayers
  );
  const preimage = deepFreeze({
    domain: PLAYER_GAME_COVERAGE_REQUIREMENTS_DOMAIN,
    schemaVersion:
      PLAYER_GAME_COVERAGE_REQUIREMENTS_SCHEMA_VERSION,
    nhlSeasonKey,
    playerIdentityProvider,
    requiredPlayers,
    requiredPlayerGames,
  });

  return deepFreeze({
    schemaVersion:
      PLAYER_GAME_COVERAGE_REQUIREMENTS_SCHEMA_VERSION,
    nhlSeasonKey,
    playerIdentityProvider,
    requiredPlayers,
    requiredPlayerGames,
    requirementsSha256: hashCanonicalJsonV1(preimage),
  });
}

function normalizeProviderGame(candidate) {
  const code = PLAYER_GAME_COVERAGE_CODES.responseInvalid;
  const game = exactObject(
    candidate,
    PROVIDER_GAME_KEYS,
    "Provider expected game",
    code
  );
  return {
    providerTeamId: providerIdentity(
      game.providerTeamId,
      100,
      "Expected-game provider-team identifier",
      code
    ),
    nhlGameId: nhlGameId(game.nhlGameId, code),
    nhlGameScheduledStartsAtMs: safeTimestamp(
      game.nhlGameScheduledStartsAtMs,
      "Scheduled NHL game start",
      code
    ),
    observedGameState: observedGameState(
      game.observedGameState,
      code
    ),
  };
}

function normalizeProviderPlayer(candidate) {
  const code = PLAYER_GAME_COVERAGE_CODES.responseInvalid;
  const player = exactObject(
    candidate,
    PROVIDER_PLAYER_KEYS,
    "Provider coverage player",
    code
  );
  const normalizedDisposition = disposition(
    player.disposition,
    code
  );
  const normalizedTeamId =
    player.providerTeamId === null
      ? null
      : providerIdentity(
        player.providerTeamId,
        100,
        "Provider-team identifier",
        code
      );
  const games = requireArray(
    player.games,
    "Provider player games",
    code
  ).map(normalizeProviderGame);
  games.sort((left, right) =>
    compareUnicodeScalarStrings(left.nhlGameId, right.nhlGameId) ||
    compareSafeIntegers(
      left.nhlGameScheduledStartsAtMs,
      right.nhlGameScheduledStartsAtMs
    ) ||
    compareUnicodeScalarStrings(
      left.providerTeamId,
      right.providerTeamId
    )
  );
  const gameIds = new Set();
  for (const game of games) {
    if (gameIds.has(game.nhlGameId)) {
      fail(
        code,
        "expected_game_identity_duplicate",
        "Provider coverage contains a duplicate expected game."
      );
    }
    gameIds.add(game.nhlGameId);
  }

  if (
    normalizedDisposition === "expected_game" &&
    games.length === 0
  ) {
    fail(
      code,
      "expected_game_shape_invalid",
      "Expected-game coverage requires at least one team-bound game."
    );
  }
  if (
    normalizedDisposition === "no_due_game" &&
    (normalizedTeamId === null || games.length !== 0)
  ) {
    fail(
      code,
      "no_due_game_shape_invalid",
      "No-due-game coverage requires a team and no games."
    );
  }
  if (
    normalizedDisposition === "no_team" &&
    (normalizedTeamId !== null || games.length !== 0)
  ) {
    fail(
      code,
      "no_team_shape_invalid",
      "No-team coverage requires null team identity and no games."
    );
  }

  return {
    playerId: stableId(
      player.playerId,
      "Provider coverage player identifier",
      code
    ),
    providerPlayerId: providerIdentity(
      player.providerPlayerId,
      100,
      "Provider-player identifier",
      code
    ),
    providerTeamId: normalizedTeamId,
    disposition: normalizedDisposition,
    games,
  };
}

function sameRequiredPlayer(left, right) {
  return (
    left.playerId === right.playerId &&
    left.providerPlayerId === right.providerPlayerId
  );
}

function assertExactRequiredPlayers(requiredPlayers, providerPlayers) {
  const orderedProviderPlayers = [...providerPlayers].sort(
    compareRequiredPlayers
  );
  if (
    requiredPlayers.length !== orderedProviderPlayers.length ||
    requiredPlayers.some(
      (player, index) =>
        !sameRequiredPlayer(player, orderedProviderPlayers[index])
    )
  ) {
    fail(
      PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
      "required_player_set_mismatch",
      "Provider coverage does not equal the required player set.",
      {
        requiredPlayerCount: requiredPlayers.length,
        coveredPlayerCount: orderedProviderPlayers.length,
      }
    );
  }
}

function normalizeObservationRows(observationRows, capturedAtMs) {
  const code = PLAYER_GAME_COVERAGE_CODES.responseInvalid;
  const rows = requireArray(
    observationRows,
    "Normalized player-game observations",
    code
  ).map((candidate) => {
    const row = exactObject(
      candidate,
      NORMALIZED_OBSERVATION_KEYS,
      "Normalized player-game observation",
      code
    );
    const goals = nonNegativeInteger(row.goals, "Goals", code);
    const assists = nonNegativeInteger(
      row.assists,
      "Assists",
      code
    );
    const nhlPoints = nonNegativeInteger(
      row.nhlPoints,
      "NHL points",
      code
    );
    const fantasyPointsHundredths = nonNegativeInteger(
      row.fantasyPointsHundredths,
      "Fantasy points",
      code
    );
    const calculatedFantasyPoints = goals * 125 + assists * 100;
    if (
      nhlPoints !== goals + assists ||
      !Number.isSafeInteger(calculatedFantasyPoints) ||
      fantasyPointsHundredths !== calculatedFantasyPoints
    ) {
      fail(
        code,
        "observation_scoring_invalid",
        "Normalized player-game observation scoring does not reconcile."
      );
    }
    const sourceUpdatedAtMs = safeTimestamp(
      row.sourceUpdatedAtMs,
      "Source update time",
      code
    );
    if (sourceUpdatedAtMs > capturedAtMs) {
      fail(
        code,
        "observation_source_time_invalid",
        "A source update cannot follow the coverage capture."
      );
    }
    return {
      externalPlayerId: providerIdentity(
        row.externalPlayerId,
        100,
        "Observation provider-player identifier",
        code
      ),
      nhlGameId: nhlGameId(row.nhlGameId, code),
      nhlGameScheduledStartsAtMs: safeTimestamp(
        row.nhlGameScheduledStartsAtMs,
        "Scheduled NHL game start",
        code
      ),
      observedGameState: observedGameState(
        row.observedGameState,
        code
      ),
      goals,
      assists,
      nhlPoints,
      fantasyPointsHundredths,
      sourceUpdatedAtMs,
    };
  });
  rows.sort(compareObservationRows);
  const identities = new Set();
  for (const row of rows) {
    const identity =
      `${row.externalPlayerId}\u0000${row.nhlGameId}`;
    if (identities.has(identity)) {
      fail(
        code,
        "observation_identity_duplicate",
        "Normalized observations contain a duplicate player and game."
      );
    }
    identities.add(identity);
  }
  return rows;
}

function flattenProviderCoverage(providerPlayers) {
  const coverage = [];
  for (const player of providerPlayers) {
    if (player.disposition === "expected_game") {
      for (const game of player.games) {
        coverage.push({
          playerId: player.playerId,
          providerPlayerId: player.providerPlayerId,
          providerTeamId: game.providerTeamId,
          disposition: player.disposition,
          nhlGameId: game.nhlGameId,
          nhlGameScheduledStartsAtMs:
            game.nhlGameScheduledStartsAtMs,
          observedGameState: game.observedGameState,
        });
      }
    } else {
      coverage.push({
        playerId: player.playerId,
        providerPlayerId: player.providerPlayerId,
        providerTeamId: player.providerTeamId,
        disposition: player.disposition,
        nhlGameId: null,
        nhlGameScheduledStartsAtMs: null,
        observedGameState: null,
      });
    }
  }
  coverage.sort(compareFlatCoverage);
  return coverage;
}

function sameRequiredPlayerGameBinding(required, coverage) {
  return (
    required.playerId === coverage.playerId &&
    required.providerPlayerId === coverage.providerPlayerId &&
    required.providerTeamId === coverage.providerTeamId &&
    required.nhlGameId === coverage.nhlGameId &&
    required.nhlGameScheduledStartsAtMs ===
      coverage.nhlGameScheduledStartsAtMs
  );
}

function assertRequiredPlayerGameCoverage(
  requiredPlayerGames,
  coverage,
  providerPlayers
) {
  const expectedByIdentity = new Map(
    coverage
      .filter((entry) => entry.disposition === "expected_game")
      .map((entry) => [
        `${entry.playerId}\u0000${entry.nhlGameId}`,
        entry,
      ])
  );
  const exactHistoricalIdentities = new Set();
  for (const required of requiredPlayerGames) {
    const identity = `${required.playerId}\u0000${required.nhlGameId}`;
    const expected = expectedByIdentity.get(identity);
    if (!expected) {
      fail(
        PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
        "required_player_game_set_mismatch",
        "Provider coverage omitted a required historical player game.",
        {
          playerId: required.playerId,
          nhlGameId: required.nhlGameId,
        }
      );
    }
    if (!sameRequiredPlayerGameBinding(required, expected)) {
      fail(
        PLAYER_GAME_COVERAGE_CODES.responseInvalid,
        "required_player_game_binding_mismatch",
        "Provider coverage changed a required historical player-game binding.",
        {
          playerId: required.playerId,
          nhlGameId: required.nhlGameId,
        }
      );
    }
    exactHistoricalIdentities.add(identity);
  }

  for (const player of providerPlayers) {
    if (player.disposition !== "expected_game") continue;
    for (const game of player.games) {
      const identity = `${player.playerId}\u0000${game.nhlGameId}`;
      if (exactHistoricalIdentities.has(identity)) continue;
      if (
        player.providerTeamId === null ||
        game.providerTeamId !== player.providerTeamId
      ) {
        fail(
          PLAYER_GAME_COVERAGE_CODES.responseInvalid,
          "expected_game_current_team_binding_mismatch",
          "A non-historical expected game must bind the player's current provider team."
        );
      }
    }
  }
}

function assertExpectedObservationEquality(coverage, observations) {
  const expected = coverage.filter(
    (entry) => entry.disposition === "expected_game"
  );
  if (expected.length !== observations.length) {
    fail(
      PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
      "expected_observation_set_mismatch",
      "Expected-game coverage does not equal the observation set.",
      {
        expectedPlayerGameCount: expected.length,
        observationCount: observations.length,
      }
    );
  }

  const observationsByIdentity = new Map(
    observations.map((row) => [
      `${row.externalPlayerId}\u0000${row.nhlGameId}`,
      row,
    ])
  );
  for (const entry of expected) {
    const identity =
      `${entry.providerPlayerId}\u0000${entry.nhlGameId}`;
    const observation = observationsByIdentity.get(identity);
    if (!observation) {
      fail(
        PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
        "expected_observation_set_mismatch",
        "An expected player-game observation is missing.",
        {
          providerPlayerId: entry.providerPlayerId,
          nhlGameId: entry.nhlGameId,
        }
      );
    }
    if (
      observation.nhlGameScheduledStartsAtMs !==
        entry.nhlGameScheduledStartsAtMs ||
      observation.observedGameState !== entry.observedGameState
    ) {
      fail(
        PLAYER_GAME_COVERAGE_CODES.responseInvalid,
        "expected_observation_binding_mismatch",
        "Expected coverage and observation game bindings differ.",
        {
          providerPlayerId: entry.providerPlayerId,
          nhlGameId: entry.nhlGameId,
        }
      );
    }
  }
}

function normalizePlayerGameCoverageResponse(input = {}) {
  const request = exactObject(
    input,
    RESPONSE_INPUT_KEYS,
    "Player-game coverage response input",
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  );
  const capturedAtMs = safeTimestamp(
    request.capturedAtMs,
    "Coverage capture time",
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  );
  const requiredPlayers = normalizeRequiredPlayerSet(
    request.requiredPlayers
  );
  const requiredPlayerGames = normalizeRequiredPlayerGameSet(
    request.requiredPlayerGames,
    requiredPlayers
  );
  const response = exactObject(
    request.response,
    PROVIDER_RESPONSE_KEYS,
    "Provider coverage response",
    PLAYER_GAME_COVERAGE_CODES.responseInvalid
  );
  if (
    response.schemaVersion !==
      PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION
  ) {
    fail(
      PLAYER_GAME_COVERAGE_CODES.responseInvalid,
      "coverage_schema_version_unsupported",
      "Provider coverage uses an unsupported schema version."
    );
  }
  const throughAtMs = safeTimestamp(
    response.throughAtMs,
    "Provider coverage through time",
    PLAYER_GAME_COVERAGE_CODES.responseInvalid
  );
  if (throughAtMs !== capturedAtMs) {
    fail(
      PLAYER_GAME_COVERAGE_CODES.responseInvalid,
      "coverage_capture_mismatch",
      "Provider coverage must bind the exact refresh capture time."
    );
  }

  const providerPlayers = requireArray(
    response.players,
    "Provider coverage players",
    PLAYER_GAME_COVERAGE_CODES.responseInvalid
  ).map(normalizeProviderPlayer);
  const playerIds = new Map();
  const providerPlayerIds = new Map();
  for (const player of providerPlayers) {
    const byPlayerId = playerIds.get(player.playerId);
    const byProviderId = providerPlayerIds.get(
      player.providerPlayerId
    );
    if (byPlayerId || byProviderId) {
      const previous = byPlayerId || byProviderId;
      fail(
        PLAYER_GAME_COVERAGE_CODES.responseInvalid,
        previous.disposition !== player.disposition
          ? "player_disposition_mixed"
          : "provider_player_identity_duplicate",
        "Provider coverage repeats or mixes a player identity."
      );
    }
    playerIds.set(player.playerId, player);
    providerPlayerIds.set(player.providerPlayerId, player);
  }
  assertExactRequiredPlayers(requiredPlayers, providerPlayers);

  const coverage = flattenProviderCoverage(providerPlayers);
  assertRequiredPlayerGameCoverage(
    requiredPlayerGames,
    coverage,
    providerPlayers
  );
  const observations = normalizeObservationRows(
    request.observationRows,
    capturedAtMs
  );
  assertExpectedObservationEquality(coverage, observations);
  const expectedPlayerGameCount = coverage.filter(
    (entry) => entry.disposition === "expected_game"
  ).length;

  return deepFreeze({
    schemaVersion: PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION,
    throughAtMs,
    requiredPlayers,
    requiredPlayerGames,
    coverage,
    observationRows: observations,
    requiredPlayerCount: requiredPlayers.length,
    coverageEntryCount: coverage.length,
    expectedPlayerGameCount,
    observationCount: observations.length,
  });
}

function normalizeEvidenceCoverageEntry(candidate) {
  const code = PLAYER_GAME_COVERAGE_CODES.inputInvalid;
  const entry = exactObject(
    candidate,
    COVERAGE_EVIDENCE_KEYS,
    "Player-game coverage evidence entry",
    code
  );
  const normalizedDisposition = disposition(
    entry.disposition,
    code
  );
  const normalizedTeamId =
    entry.providerTeamId === null
      ? null
      : providerIdentity(
        entry.providerTeamId,
        100,
        "Provider-team identifier",
        code
      );
  const normalizedGameId =
    entry.nhlGameId === null
      ? null
      : nhlGameId(entry.nhlGameId, code);
  const normalizedStart =
    entry.nhlGameScheduledStartsAtMs === null
      ? null
      : safeTimestamp(
        entry.nhlGameScheduledStartsAtMs,
        "Scheduled NHL game start",
        code
      );

  if (
    normalizedDisposition === "expected_game" &&
    (
      normalizedTeamId === null ||
      normalizedGameId === null ||
      normalizedStart === null
    )
  ) {
    fail(
      code,
      "expected_game_shape_invalid",
      "Expected-game evidence requires non-null team, game, and start."
    );
  }
  if (
    normalizedDisposition === "no_due_game" &&
    (
      normalizedTeamId === null ||
      normalizedGameId !== null ||
      normalizedStart !== null
    )
  ) {
    fail(
      code,
      "no_due_game_shape_invalid",
      "No-due-game evidence requires a team and null game fields."
    );
  }
  if (
    normalizedDisposition === "no_team" &&
    (
      normalizedTeamId !== null ||
      normalizedGameId !== null ||
      normalizedStart !== null
    )
  ) {
    fail(
      code,
      "no_team_shape_invalid",
      "No-team evidence requires null team and game fields."
    );
  }

  return {
    coverageEntryId: stableId(
      entry.coverageEntryId,
      "Coverage-entry identifier",
      code
    ),
    playerId: stableId(
      entry.playerId,
      "Coverage player identifier",
      code
    ),
    providerPlayerId: providerIdentity(
      entry.providerPlayerId,
      100,
      "Provider-player identifier",
      code
    ),
    providerTeamId: normalizedTeamId,
    disposition: normalizedDisposition,
    nhlGameId: normalizedGameId,
    nhlGameScheduledStartsAtMs: normalizedStart,
  };
}

function assertEvidenceCoverageSet(requiredPlayers, coverage) {
  const code = PLAYER_GAME_COVERAGE_CODES.inputInvalid;
  const requiredByPlayerId = new Map(
    requiredPlayers.map((player) => [player.playerId, player])
  );
  const coveredPlayers = new Map();
  const coverageEntryIds = new Set();
  const expectedIdentities = new Set();

  for (const entry of coverage) {
    if (coverageEntryIds.has(entry.coverageEntryId)) {
      fail(
        code,
        "coverage_entry_identity_duplicate",
        "Coverage evidence contains a duplicate entry identifier."
      );
    }
    coverageEntryIds.add(entry.coverageEntryId);

    const required = requiredByPlayerId.get(entry.playerId);
    if (
      !required ||
      required.providerPlayerId !== entry.providerPlayerId
    ) {
      fail(
        code,
        "required_player_set_mismatch",
        "Coverage evidence does not equal the required player set."
      );
    }

    const previous = coveredPlayers.get(entry.playerId);
    if (previous) {
      if (
        previous.disposition !== "expected_game" ||
        entry.disposition !== "expected_game"
      ) {
        fail(
          code,
          "player_disposition_mixed",
          "A covered player cannot mix or repeat terminal dispositions."
        );
      }
    } else {
      coveredPlayers.set(entry.playerId, entry);
    }

    if (entry.disposition === "expected_game") {
      const identity = `${entry.playerId}\u0000${entry.nhlGameId}`;
      if (expectedIdentities.has(identity)) {
        fail(
          code,
          "expected_game_identity_duplicate",
          "Coverage evidence contains a duplicate expected player and game."
        );
      }
      expectedIdentities.add(identity);
    }
  }

  if (
    coveredPlayers.size !== requiredPlayers.length ||
    requiredPlayers.some(
      (player) => !coveredPlayers.has(player.playerId)
    )
  ) {
    fail(
      code,
      "required_player_set_mismatch",
      "Coverage evidence does not equal the required player set.",
      {
        requiredPlayerCount: requiredPlayers.length,
        coveredPlayerCount: coveredPlayers.size,
      }
    );
  }
}

function createPlayerGameCoverageSetEvidence(input = {}) {
  const evidence = exactObject(
    input,
    EVIDENCE_INPUT_KEYS,
    "Player-game coverage evidence input",
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  );
  const requiredPlayers = normalizeRequiredPlayerSet(
    evidence.requiredPlayers
  );
  const coverage = requireArray(
    evidence.coverage,
    "Player-game coverage evidence",
    PLAYER_GAME_COVERAGE_CODES.inputInvalid
  ).map(normalizeEvidenceCoverageEntry);
  coverage.sort(compareEvidenceCoverage);
  assertEvidenceCoverageSet(requiredPlayers, coverage);
  const frozenCoverage = deepFreeze(coverage);
  const expectedPlayerGameCount = frozenCoverage.filter(
    (entry) => entry.disposition === "expected_game"
  ).length;
  const preimage = deepFreeze({
    domain: PLAYER_GAME_COVERAGE_SET_DOMAIN,
    schemaVersion: PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION,
    setId: stableId(
      evidence.setId,
      "Coverage-set identifier",
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    ),
    statSourceId: stableId(
      evidence.statSourceId,
      "Statistics-source identifier",
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    ),
    refreshId: stableId(
      evidence.refreshId,
      "Refresh identifier",
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    ),
    nhlSeasonKey: seasonKey(
      evidence.nhlSeasonKey,
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    ),
    provider: boundedText(
      evidence.provider,
      100,
      "Provider",
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    ),
    sourceVersion: boundedText(
      evidence.sourceVersion,
      200,
      "Source version",
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    ),
    capturedAtMs: safeTimestamp(
      evidence.capturedAtMs,
      "Coverage capture time",
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    ),
    requiredPlayerCount: requiredPlayers.length,
    coverageEntryCount: frozenCoverage.length,
    expectedPlayerGameCount,
    coverage: frozenCoverage,
  });
  return Object.freeze({
    preimage,
    requiredPlayerCount: preimage.requiredPlayerCount,
    coverageEntryCount: preimage.coverageEntryCount,
    expectedPlayerGameCount: preimage.expectedPlayerGameCount,
    coverageSha256: hashCanonicalJsonV1(preimage),
  });
}

module.exports = {
  PLAYER_GAME_COVERAGE_CODES,
  PLAYER_GAME_COVERAGE_DISPOSITIONS,
  PLAYER_GAME_COVERAGE_REQUIREMENTS_DOMAIN,
  PLAYER_GAME_COVERAGE_REQUIREMENTS_SCHEMA_VERSION,
  PLAYER_GAME_COVERAGE_SET_DOMAIN,
  PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION,
  PlayerGameCoveragePolicyError,
  createPlayerGameCoverageRequirements,
  createPlayerGameCoverageSetEvidence,
  normalizePlayerGameCoverageResponse,
  normalizeRequiredPlayerGameSet,
  normalizeRequiredPlayerSet,
};
