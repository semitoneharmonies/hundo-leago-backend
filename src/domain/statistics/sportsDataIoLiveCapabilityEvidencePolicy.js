const {
  compareUnicodeScalarStrings,
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require("../leagues/seasonRolloverEvidencePolicy");
const {
  OBSERVED_GAME_STATES,
} = require("./playerGameStatisticsPolicy");

const SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN =
  "hundo-leago.sportsdataio-live-capability-evidence";
const SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_SCHEMA_VERSION = 1;
const SPORTS_DATA_IO_LIVE_CAPABILITY_PROVIDER =
  "sportsdataio-live";
const SPORTS_DATA_IO_LIVE_CAPABILITY_STATUS = "passed";
const SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS =
  24 * 60 * 60 * 1000;
const SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_KINDS = Object.freeze([
  "current",
  "historical_offseason",
]);
const SPORTS_DATA_IO_LIVE_CAPABILITY_ENDPOINT_KINDS = Object.freeze([
  "free_agents",
  "player_game",
  "players",
  "schedule",
  "season_totals",
]);
const SPORTS_DATA_IO_LIVE_CAPABILITY_ENDPOINT_SCOPE_KINDS =
  Object.freeze(["date", "season"]);
const SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS = Object.freeze([
  "controlled_omission_rejected",
  "current_free_agents_access",
  "current_players_access",
  "exact_coverage_observation_set",
  "exact_game_start_team_binding",
  "expected_game_disposition",
  "explicit_zero_observation",
  "historical_season_totals_access",
  "no_due_game_disposition",
  "no_team_disposition",
  "one_capture_source_version",
  "required_historical_game_set_exhaustive",
  "required_player_set_exhaustive",
  "targeted_historical_player_game_access",
  "targeted_historical_schedule_access",
]);
const SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND =
  "controlled_player_game_omission";
const SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE =
  "PLAYER_GAME_COVERAGE_RESPONSE_INCOMPLETE";
const SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_ERROR_CODE =
  "SPORTSDATAIO_LIVE_CAPABILITY_EVIDENCE_INVALID";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PROVIDER_ID_PATTERN = /^[1-9]\d{0,15}$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const PROBE_KIND_SET = new Set(
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_KINDS
);
const ENDPOINT_KIND_SET = new Set(
  SPORTS_DATA_IO_LIVE_CAPABILITY_ENDPOINT_KINDS
);
const ENDPOINT_SCOPE_KIND_SET = new Set(
  SPORTS_DATA_IO_LIVE_CAPABILITY_ENDPOINT_SCOPE_KINDS
);
const ASSERTION_KIND_SET = new Set(
  SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS
);
const OBSERVED_GAME_STATE_SET = new Set(OBSERVED_GAME_STATES);

const EVIDENCE_KEYS = Object.freeze([
  "domain",
  "schemaVersion",
  "evidenceId",
  "status",
  "provider",
  "appEnv",
  "environmentId",
  "backendBuildId",
  "origin",
  "configuredNhlSeasonKey",
  "probeNhlSeasonKey",
  "probeKind",
  "probeManifestSha256",
  "capabilityKeyVersion",
  "credentialBindingHmacSha256",
  "issuedAtMs",
  "expiresAtMs",
  "request",
  "capture",
  "endpointProofs",
  "explicitZeroPair",
  "omissionProof",
  "assertions",
]);
const REQUEST_KEYS = Object.freeze([
  "requiredPlayers",
  "requiredPlayerGames",
]);
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
const CAPTURE_KEYS = Object.freeze([
  "capturedAtMs",
  "sourceVersion",
  "coverage",
  "observations",
]);
const COVERAGE_KEYS = Object.freeze([
  "playerId",
  "providerPlayerId",
  "providerTeamId",
  "disposition",
  "nhlGameId",
  "nhlGameScheduledStartsAtMs",
  "observedGameState",
]);
const OBSERVATION_KEYS = Object.freeze([
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
const ENDPOINT_PROOF_KEYS = Object.freeze([
  "endpointKind",
  "scopeKind",
  "scopeValue",
  "httpStatus",
  "rowCount",
  "responseSha256",
]);
const EXPLICIT_ZERO_PAIR_KEYS = Object.freeze([
  "playerId",
  "providerPlayerId",
  "providerTeamId",
  "nhlGameId",
  "nhlGameScheduledStartsAtMs",
  "observedGameState",
  "goals",
  "assists",
  "nhlPoints",
  "fantasyPointsHundredths",
  "sourceUpdatedAtMs",
]);
const OMISSION_PROOF_KEYS = Object.freeze([
  "kind",
  "omittedPlayerId",
  "omittedNhlGameId",
  "resultCode",
]);
const ASSERTION_KEYS = Object.freeze(["kind", "passed"]);

class SportsDataIoLiveCapabilityEvidencePolicyError extends Error {
  constructor(reasonCode) {
    super("The SportsDataIO live capability evidence is invalid.");
    this.name = "SportsDataIoLiveCapabilityEvidencePolicyError";
    this.code = SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_ERROR_CODE;
    this.reasonCode = reasonCode;
  }
}

function invalid(reasonCode) {
  throw new SportsDataIoLiveCapabilityEvidencePolicyError(reasonCode);
}

function exactObject(value, keys, reasonCode) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    invalid(reasonCode);
  }
  const actual = Object.getOwnPropertyNames(value).sort(
    compareUnicodeScalarStrings
  );
  const expected = [...keys].sort(compareUnicodeScalarStrings);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(reasonCode);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      invalid(reasonCode);
    }
  }
  return value;
}

function exactArray(value, reasonCode) {
  if (!Array.isArray(value)) {
    invalid(reasonCode);
  }
  try {
    serializeCanonicalJsonV1(value);
  } catch {
    invalid(reasonCode);
  }
  return value;
}

function boundedText(value, maximum, reasonCode) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalid(reasonCode);
  }
  try {
    serializeCanonicalJsonV1(value);
  } catch {
    invalid(reasonCode);
  }
  return value;
}

function stableId(value, reasonCode) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid(reasonCode);
  }
  return value;
}

function providerId(value, reasonCode) {
  const normalized =
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
      ? String(value)
      : value;
  if (
    typeof normalized !== "string" ||
    !PROVIDER_ID_PATTERN.test(normalized) ||
    !Number.isSafeInteger(Number(normalized))
  ) {
    invalid(reasonCode);
  }
  return normalized;
}

function sha256(value, reasonCode) {
  if (typeof value !== "string" || !HEX_SHA256_PATTERN.test(value)) {
    invalid(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    invalid(reasonCode);
  }
  return value;
}

function nonNegativeInteger(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(reasonCode);
  }
  return value;
}

function seasonKey(value, reasonCode) {
  if (typeof value !== "string" || !/^\d{8}$/u.test(value)) {
    invalid(reasonCode);
  }
  const startYear = Number(value.slice(0, 4));
  const endYear = Number(value.slice(4));
  if (endYear !== startYear + 1) {
    invalid(reasonCode);
  }
  return value;
}

function canonicalDate(value, reasonCode) {
  if (typeof value !== "string") {
    invalid(reasonCode);
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    invalid(reasonCode);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    invalid(reasonCode);
  }
  return value;
}

function canonicalOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid("origin_invalid");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    invalid("origin_invalid");
  }
  return value;
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

function compareSafeIntegers(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNullableText(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareUnicodeScalarStrings(left, right);
}

function normalizeRequiredPlayers(value) {
  const players = exactArray(
    value,
    "required_players_shape_invalid"
  ).map((candidate) => {
    const player = exactObject(
      candidate,
      REQUIRED_PLAYER_KEYS,
      "required_player_shape_invalid"
    );
    return {
      playerId: stableId(
        player.playerId,
        "required_player_id_invalid"
      ),
      providerPlayerId: providerId(
        player.providerPlayerId,
        "required_provider_player_id_invalid"
      ),
    };
  });
  players.sort((left, right) =>
    compareUnicodeScalarStrings(left.playerId, right.playerId) ||
    compareUnicodeScalarStrings(
      left.providerPlayerId,
      right.providerPlayerId
    )
  );
  const playerIds = new Set();
  const providerPlayerIds = new Set();
  for (const player of players) {
    if (
      playerIds.has(player.playerId) ||
      providerPlayerIds.has(player.providerPlayerId)
    ) {
      invalid("required_player_duplicate");
    }
    playerIds.add(player.playerId);
    providerPlayerIds.add(player.providerPlayerId);
  }
  if (players.length < 3) {
    invalid("required_player_set_incomplete");
  }
  return players;
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

function normalizeRequiredPlayerGames(value, requiredPlayers) {
  const playersById = new Map(
    requiredPlayers.map((player) => [player.playerId, player])
  );
  const games = exactArray(
    value,
    "required_player_games_shape_invalid"
  ).map((candidate) => {
    const game = exactObject(
      candidate,
      REQUIRED_PLAYER_GAME_KEYS,
      "required_player_game_shape_invalid"
    );
    const normalized = {
      playerId: stableId(
        game.playerId,
        "required_player_game_player_id_invalid"
      ),
      providerPlayerId: providerId(
        game.providerPlayerId,
        "required_player_game_provider_player_id_invalid"
      ),
      providerTeamId: providerId(
        game.providerTeamId,
        "required_player_game_provider_team_id_invalid"
      ),
      nhlGameId: providerId(
        game.nhlGameId,
        "required_player_game_id_invalid"
      ),
      nhlGameScheduledStartsAtMs: safeTimestamp(
        game.nhlGameScheduledStartsAtMs,
        "required_player_game_start_invalid"
      ),
    };
    const parent = playersById.get(normalized.playerId);
    if (
      !parent ||
      parent.providerPlayerId !== normalized.providerPlayerId
    ) {
      invalid("required_player_game_parent_mismatch");
    }
    return normalized;
  });
  games.sort(compareRequiredPlayerGames);
  const identities = new Set();
  for (const game of games) {
    const identity = `${game.playerId}\u0000${game.nhlGameId}`;
    if (identities.has(identity)) {
      invalid("required_player_game_duplicate");
    }
    identities.add(identity);
  }
  if (games.length < 1) {
    invalid("required_player_game_set_incomplete");
  }
  return games;
}

function normalizeRequest(value) {
  const request = exactObject(
    value,
    REQUEST_KEYS,
    "request_shape_invalid"
  );
  const requiredPlayers = normalizeRequiredPlayers(
    request.requiredPlayers
  );
  return {
    requiredPlayers,
    requiredPlayerGames: normalizeRequiredPlayerGames(
      request.requiredPlayerGames,
      requiredPlayers
    ),
  };
}

function normalizeCoverageEntry(candidate, playersById) {
  const entry = exactObject(
    candidate,
    COVERAGE_KEYS,
    "coverage_entry_shape_invalid"
  );
  const playerId = stableId(
    entry.playerId,
    "coverage_player_id_invalid"
  );
  const providerPlayerId = providerId(
    entry.providerPlayerId,
    "coverage_provider_player_id_invalid"
  );
  const parent = playersById.get(playerId);
  if (!parent || parent.providerPlayerId !== providerPlayerId) {
    invalid("coverage_player_mismatch");
  }
  if (
    ![
      "expected_game",
      "no_due_game",
      "no_team",
    ].includes(entry.disposition)
  ) {
    invalid("coverage_disposition_invalid");
  }
  const providerTeamId =
    entry.providerTeamId === null
      ? null
      : providerId(
        entry.providerTeamId,
        "coverage_provider_team_id_invalid"
      );
  const nhlGameId =
    entry.nhlGameId === null
      ? null
      : providerId(
        entry.nhlGameId,
        "coverage_game_id_invalid"
      );
  const nhlGameScheduledStartsAtMs =
    entry.nhlGameScheduledStartsAtMs === null
      ? null
      : safeTimestamp(
        entry.nhlGameScheduledStartsAtMs,
        "coverage_game_start_invalid"
      );
  const observedGameState =
    entry.observedGameState === null
      ? null
      : entry.observedGameState;
  if (
    observedGameState !== null &&
    !OBSERVED_GAME_STATE_SET.has(observedGameState)
  ) {
    invalid("coverage_game_state_invalid");
  }
  if (
    entry.disposition === "expected_game" &&
    (
      providerTeamId === null ||
      nhlGameId === null ||
      nhlGameScheduledStartsAtMs === null ||
      observedGameState === null
    )
  ) {
    invalid("expected_game_shape_invalid");
  }
  if (
    entry.disposition === "no_due_game" &&
    (
      providerTeamId === null ||
      nhlGameId !== null ||
      nhlGameScheduledStartsAtMs !== null ||
      observedGameState !== null
    )
  ) {
    invalid("no_due_game_shape_invalid");
  }
  if (
    entry.disposition === "no_team" &&
    (
      providerTeamId !== null ||
      nhlGameId !== null ||
      nhlGameScheduledStartsAtMs !== null ||
      observedGameState !== null
    )
  ) {
    invalid("no_team_shape_invalid");
  }
  return {
    playerId,
    providerPlayerId,
    providerTeamId,
    disposition: entry.disposition,
    nhlGameId,
    nhlGameScheduledStartsAtMs,
    observedGameState,
  };
}

function compareCoverage(left, right) {
  return (
    compareUnicodeScalarStrings(left.playerId, right.playerId) ||
    compareUnicodeScalarStrings(left.disposition, right.disposition) ||
    compareNullableText(left.nhlGameId, right.nhlGameId) ||
    compareUnicodeScalarStrings(
      left.providerPlayerId,
      right.providerPlayerId
    )
  );
}

function normalizeCoverage(value, requiredPlayers) {
  const playersById = new Map(
    requiredPlayers.map((player) => [player.playerId, player])
  );
  const coverage = exactArray(
    value,
    "coverage_shape_invalid"
  ).map((entry) => normalizeCoverageEntry(entry, playersById));
  coverage.sort(compareCoverage);
  const playerDispositions = new Map();
  const identities = new Set();
  const providerPlayerIds = new Map();
  for (const entry of coverage) {
    const priorProviderPlayerId = providerPlayerIds.get(entry.playerId);
    if (
      priorProviderPlayerId !== undefined &&
      priorProviderPlayerId !== entry.providerPlayerId
    ) {
      invalid("coverage_provider_player_mismatch");
    }
    providerPlayerIds.set(entry.playerId, entry.providerPlayerId);
    const priorDisposition = playerDispositions.get(entry.playerId);
    if (
      priorDisposition !== undefined &&
      priorDisposition !== entry.disposition
    ) {
      invalid("coverage_disposition_mixed");
    }
    playerDispositions.set(entry.playerId, entry.disposition);
    const identity =
      entry.disposition === "expected_game"
        ? `${entry.playerId}\u0000${entry.nhlGameId}`
        : `${entry.playerId}\u0000${entry.disposition}`;
    if (identities.has(identity)) {
      invalid("coverage_duplicate");
    }
    identities.add(identity);
  }
  if (
    playerDispositions.size !== requiredPlayers.length ||
    requiredPlayers.some(
      (player) => !playerDispositions.has(player.playerId)
    )
  ) {
    invalid("coverage_player_set_mismatch");
  }
  const dispositionSet = new Set(coverage.map((entry) => entry.disposition));
  for (const disposition of [
    "expected_game",
    "no_due_game",
    "no_team",
  ]) {
    if (!dispositionSet.has(disposition)) {
      invalid("coverage_disposition_set_incomplete");
    }
  }
  return coverage;
}

function normalizeObservation(candidate, capturedAtMs) {
  const row = exactObject(
    candidate,
    OBSERVATION_KEYS,
    "observation_shape_invalid"
  );
  const goals = nonNegativeInteger(
    row.goals,
    "observation_goals_invalid"
  );
  const assists = nonNegativeInteger(
    row.assists,
    "observation_assists_invalid"
  );
  const nhlPoints = nonNegativeInteger(
    row.nhlPoints,
    "observation_points_invalid"
  );
  const fantasyPointsHundredths = nonNegativeInteger(
    row.fantasyPointsHundredths,
    "observation_fantasy_points_invalid"
  );
  if (
    nhlPoints !== goals + assists ||
    fantasyPointsHundredths !== goals * 125 + assists * 100
  ) {
    invalid("observation_scoring_invalid");
  }
  const sourceUpdatedAtMs = safeTimestamp(
    row.sourceUpdatedAtMs,
    "observation_source_time_invalid"
  );
  if (sourceUpdatedAtMs > capturedAtMs) {
    invalid("observation_source_time_invalid");
  }
  if (!OBSERVED_GAME_STATE_SET.has(row.observedGameState)) {
    invalid("observation_game_state_invalid");
  }
  return {
    externalPlayerId: providerId(
      row.externalPlayerId,
      "observation_provider_player_id_invalid"
    ),
    nhlGameId: providerId(
      row.nhlGameId,
      "observation_game_id_invalid"
    ),
    nhlGameScheduledStartsAtMs: safeTimestamp(
      row.nhlGameScheduledStartsAtMs,
      "observation_game_start_invalid"
    ),
    observedGameState: row.observedGameState,
    goals,
    assists,
    nhlPoints,
    fantasyPointsHundredths,
    sourceUpdatedAtMs,
  };
}

function normalizeObservations(value, capturedAtMs) {
  const observations = exactArray(
    value,
    "observations_shape_invalid"
  ).map((row) => normalizeObservation(row, capturedAtMs));
  observations.sort((left, right) =>
    compareUnicodeScalarStrings(
      left.externalPlayerId,
      right.externalPlayerId
    ) ||
    compareUnicodeScalarStrings(left.nhlGameId, right.nhlGameId)
  );
  const identities = new Set();
  for (const row of observations) {
    const identity = `${row.externalPlayerId}\u0000${row.nhlGameId}`;
    if (identities.has(identity)) {
      invalid("observation_duplicate");
    }
    identities.add(identity);
  }
  return observations;
}

function assertCaptureEquality(
  request,
  coverage,
  observations
) {
  const requiredGames = new Map(
    request.requiredPlayerGames.map((game) => [
      `${game.playerId}\u0000${game.nhlGameId}`,
      game,
    ])
  );
  const expectedCoverage = coverage.filter(
    (entry) => entry.disposition === "expected_game"
  );
  const expectedByPlayerAndGame = new Map(
    expectedCoverage.map((entry) => [
      `${entry.playerId}\u0000${entry.nhlGameId}`,
      entry,
    ])
  );
  for (const [identity, required] of requiredGames) {
    const entry = expectedByPlayerAndGame.get(identity);
    if (
      !entry ||
      entry.providerPlayerId !== required.providerPlayerId ||
      entry.providerTeamId !== required.providerTeamId ||
      entry.nhlGameScheduledStartsAtMs !==
        required.nhlGameScheduledStartsAtMs
    ) {
      invalid("required_player_game_coverage_mismatch");
    }
  }
  const observationsByProviderAndGame = new Map(
    observations.map((row) => [
      `${row.externalPlayerId}\u0000${row.nhlGameId}`,
      row,
    ])
  );
  if (expectedCoverage.length !== observations.length) {
    invalid("coverage_observation_set_mismatch");
  }
  for (const entry of expectedCoverage) {
    const row = observationsByProviderAndGame.get(
      `${entry.providerPlayerId}\u0000${entry.nhlGameId}`
    );
    if (
      !row ||
      row.nhlGameScheduledStartsAtMs !==
        entry.nhlGameScheduledStartsAtMs ||
      row.observedGameState !== entry.observedGameState
    ) {
      invalid("coverage_observation_set_mismatch");
    }
  }
}

function normalizeCapture(value, request, issuedAtMs) {
  const capture = exactObject(
    value,
    CAPTURE_KEYS,
    "capture_shape_invalid"
  );
  const capturedAtMs = safeTimestamp(
    capture.capturedAtMs,
    "capture_time_invalid"
  );
  if (capturedAtMs > issuedAtMs) {
    invalid("capture_time_invalid");
  }
  const coverage = normalizeCoverage(
    capture.coverage,
    request.requiredPlayers
  );
  const observations = normalizeObservations(
    capture.observations,
    capturedAtMs
  );
  assertCaptureEquality(request, coverage, observations);
  return {
    capturedAtMs,
    sourceVersion: boundedText(
      capture.sourceVersion,
      200,
      "capture_source_version_invalid"
    ),
    coverage,
    observations,
  };
}

function endpointExpectedScopeKind(endpointKind) {
  return ["schedule", "player_game"].includes(endpointKind)
    ? "date"
    : "season";
}

const easternDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function easternCalendarDate(timestampMs) {
  const parts = Object.fromEntries(
    easternDateFormatter
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeEndpointProof(candidate) {
  const proof = exactObject(
    candidate,
    ENDPOINT_PROOF_KEYS,
    "endpoint_proof_shape_invalid"
  );
  if (!ENDPOINT_KIND_SET.has(proof.endpointKind)) {
    invalid("endpoint_kind_invalid");
  }
  if (!ENDPOINT_SCOPE_KIND_SET.has(proof.scopeKind)) {
    invalid("endpoint_scope_kind_invalid");
  }
  if (
    proof.scopeKind !== endpointExpectedScopeKind(proof.endpointKind)
  ) {
    invalid("endpoint_scope_kind_invalid");
  }
  const scopeValue =
    proof.scopeKind === "season"
      ? seasonKey(proof.scopeValue, "endpoint_scope_invalid")
      : canonicalDate(proof.scopeValue, "endpoint_scope_invalid");
  const httpStatus = positiveInteger(
    proof.httpStatus,
    "endpoint_http_status_invalid"
  );
  if (httpStatus < 200 || httpStatus > 299) {
    invalid("endpoint_http_status_invalid");
  }
  const rowCount = nonNegativeInteger(
    proof.rowCount,
    "endpoint_row_count_invalid"
  );
  return {
    endpointKind: proof.endpointKind,
    scopeKind: proof.scopeKind,
    scopeValue,
    httpStatus,
    rowCount,
    responseSha256: sha256(
      proof.responseSha256,
      "endpoint_response_sha256_invalid"
    ),
  };
}

function normalizeEndpointProofs(
  value,
  configuredNhlSeasonKey,
  probeNhlSeasonKey,
  request,
  capture
) {
  const proofs = exactArray(
    value,
    "endpoint_proofs_shape_invalid"
  ).map(normalizeEndpointProof);
  proofs.sort((left, right) =>
    compareUnicodeScalarStrings(left.endpointKind, right.endpointKind) ||
    compareUnicodeScalarStrings(left.scopeKind, right.scopeKind) ||
    compareUnicodeScalarStrings(left.scopeValue, right.scopeValue)
  );
  const identities = new Set();
  for (const proof of proofs) {
    const identity =
      `${proof.endpointKind}\u0000${proof.scopeKind}` +
      `\u0000${proof.scopeValue}`;
    if (identities.has(identity)) {
      invalid("endpoint_proof_duplicate");
    }
    identities.add(identity);
    if (
      ["players", "free_agents"].includes(proof.endpointKind) &&
      proof.scopeValue !== configuredNhlSeasonKey
    ) {
      invalid("endpoint_current_season_mismatch");
    }
    if (
      proof.endpointKind === "season_totals" &&
      proof.scopeValue !== probeNhlSeasonKey
    ) {
      invalid("endpoint_probe_season_mismatch");
    }
  }
  const requiredGameDates = new Set(
    request.requiredPlayerGames.map((game) =>
      easternCalendarDate(game.nhlGameScheduledStartsAtMs)
    )
  );
  const requestedDates = new Set([
    easternCalendarDate(capture.capturedAtMs),
    ...requiredGameDates,
  ]);
  const expectedIdentities = new Set([
    `players\u0000season\u0000${configuredNhlSeasonKey}`,
    `free_agents\u0000season\u0000${configuredNhlSeasonKey}`,
    `season_totals\u0000season\u0000${probeNhlSeasonKey}`,
    ...[...requestedDates].flatMap((date) => [
      `schedule\u0000date\u0000${date}`,
      `player_game\u0000date\u0000${date}`,
    ]),
  ]);
  if (
    identities.size !== expectedIdentities.size ||
    [...identities].some(
      (identity) => !expectedIdentities.has(identity)
    )
  ) {
    invalid("endpoint_proof_set_incomplete");
  }
  for (const proof of proofs) {
    if (
      (["players", "free_agents", "season_totals"].includes(
        proof.endpointKind
      ) ||
        requiredGameDates.has(proof.scopeValue)) &&
      proof.rowCount < 1
    ) {
      invalid("endpoint_row_count_invalid");
    }
  }
  return proofs;
}

function normalizeExplicitZeroPair(value, request, capture) {
  const pair = exactObject(
    value,
    EXPLICIT_ZERO_PAIR_KEYS,
    "explicit_zero_pair_shape_invalid"
  );
  const normalized = {
    playerId: stableId(
      pair.playerId,
      "explicit_zero_player_id_invalid"
    ),
    providerPlayerId: providerId(
      pair.providerPlayerId,
      "explicit_zero_provider_player_id_invalid"
    ),
    providerTeamId: providerId(
      pair.providerTeamId,
      "explicit_zero_provider_team_id_invalid"
    ),
    nhlGameId: providerId(
      pair.nhlGameId,
      "explicit_zero_game_id_invalid"
    ),
    nhlGameScheduledStartsAtMs: safeTimestamp(
      pair.nhlGameScheduledStartsAtMs,
      "explicit_zero_game_start_invalid"
    ),
    observedGameState: pair.observedGameState,
    goals: nonNegativeInteger(
      pair.goals,
      "explicit_zero_scoring_invalid"
    ),
    assists: nonNegativeInteger(
      pair.assists,
      "explicit_zero_scoring_invalid"
    ),
    nhlPoints: nonNegativeInteger(
      pair.nhlPoints,
      "explicit_zero_scoring_invalid"
    ),
    fantasyPointsHundredths: nonNegativeInteger(
      pair.fantasyPointsHundredths,
      "explicit_zero_scoring_invalid"
    ),
    sourceUpdatedAtMs: safeTimestamp(
      pair.sourceUpdatedAtMs,
      "explicit_zero_source_time_invalid"
    ),
  };
  if (
    normalized.observedGameState !== "final" ||
    normalized.goals !== 0 ||
    normalized.assists !== 0 ||
    normalized.nhlPoints !== 0 ||
    normalized.fantasyPointsHundredths !== 0 ||
    normalized.sourceUpdatedAtMs > capture.capturedAtMs
  ) {
    invalid("explicit_zero_pair_invalid");
  }
  const required = request.requiredPlayerGames.find(
    (game) =>
      game.playerId === normalized.playerId &&
      game.nhlGameId === normalized.nhlGameId
  );
  const coverage = capture.coverage.find(
    (entry) =>
      entry.playerId === normalized.playerId &&
      entry.nhlGameId === normalized.nhlGameId
  );
  const observation = capture.observations.find(
    (row) =>
      row.externalPlayerId === normalized.providerPlayerId &&
      row.nhlGameId === normalized.nhlGameId
  );
  if (
    !required ||
    !coverage ||
    coverage.disposition !== "expected_game" ||
    !observation ||
    required.providerPlayerId !== normalized.providerPlayerId ||
    required.providerTeamId !== normalized.providerTeamId ||
    required.nhlGameScheduledStartsAtMs !==
      normalized.nhlGameScheduledStartsAtMs ||
    coverage.providerPlayerId !== normalized.providerPlayerId ||
    coverage.providerTeamId !== normalized.providerTeamId ||
    coverage.nhlGameScheduledStartsAtMs !==
      normalized.nhlGameScheduledStartsAtMs ||
    coverage.observedGameState !== normalized.observedGameState ||
    observation.nhlGameScheduledStartsAtMs !==
      normalized.nhlGameScheduledStartsAtMs ||
    observation.observedGameState !== normalized.observedGameState ||
    observation.goals !== normalized.goals ||
    observation.assists !== normalized.assists ||
    observation.nhlPoints !== normalized.nhlPoints ||
    observation.fantasyPointsHundredths !==
      normalized.fantasyPointsHundredths ||
    observation.sourceUpdatedAtMs !== normalized.sourceUpdatedAtMs
  ) {
    invalid("explicit_zero_pair_mismatch");
  }
  return normalized;
}

function normalizeOmissionProof(value, explicitZeroPair) {
  const proof = exactObject(
    value,
    OMISSION_PROOF_KEYS,
    "omission_proof_shape_invalid"
  );
  const omittedPlayerId = stableId(
    proof.omittedPlayerId,
    "omission_player_id_invalid"
  );
  const omittedNhlGameId = providerId(
    proof.omittedNhlGameId,
    "omission_game_id_invalid"
  );
  if (
    proof.kind !== SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND ||
    proof.resultCode !==
      SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE ||
    omittedPlayerId !== explicitZeroPair.playerId ||
    omittedNhlGameId !== explicitZeroPair.nhlGameId
  ) {
    invalid("omission_proof_invalid");
  }
  return {
    kind: proof.kind,
    omittedPlayerId,
    omittedNhlGameId,
    resultCode: proof.resultCode,
  };
}

function normalizeAssertions(value) {
  const assertions = exactArray(
    value,
    "assertions_shape_invalid"
  ).map((candidate) => {
    const assertion = exactObject(
      candidate,
      ASSERTION_KEYS,
      "assertion_shape_invalid"
    );
    if (
      !ASSERTION_KIND_SET.has(assertion.kind) ||
      assertion.passed !== true
    ) {
      invalid("assertion_invalid");
    }
    return {
      kind: assertion.kind,
      passed: true,
    };
  });
  assertions.sort((left, right) =>
    compareUnicodeScalarStrings(left.kind, right.kind)
  );
  const seen = new Set();
  for (const assertion of assertions) {
    if (seen.has(assertion.kind)) {
      invalid("assertion_duplicate");
    }
    seen.add(assertion.kind);
  }
  if (
    assertions.length !==
      SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS.length ||
    SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS.some(
      (kind) => !seen.has(kind)
    )
  ) {
    invalid("assertion_set_incomplete");
  }
  return assertions;
}

function assertProbeSeasonRelationship(
  configuredNhlSeasonKey,
  probeNhlSeasonKey,
  probeKind
) {
  if (probeKind === "current") {
    if (probeNhlSeasonKey !== configuredNhlSeasonKey) {
      invalid("probe_season_mismatch");
    }
    return;
  }
  const configuredStart = Number(
    configuredNhlSeasonKey.slice(0, 4)
  );
  const probeStart = Number(probeNhlSeasonKey.slice(0, 4));
  if (probeStart + 1 !== configuredStart) {
    invalid("probe_season_mismatch");
  }
}

function normalizeEvidence(input) {
  const candidate = exactObject(
    input,
    EVIDENCE_KEYS,
    "evidence_shape_invalid"
  );
  if (
    candidate.domain !==
      SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN ||
    candidate.schemaVersion !==
      SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_SCHEMA_VERSION ||
    candidate.status !== SPORTS_DATA_IO_LIVE_CAPABILITY_STATUS ||
    candidate.provider !== SPORTS_DATA_IO_LIVE_CAPABILITY_PROVIDER
  ) {
    invalid("evidence_envelope_invalid");
  }
  const configuredNhlSeasonKey = seasonKey(
    candidate.configuredNhlSeasonKey,
    "configured_season_invalid"
  );
  const probeNhlSeasonKey = seasonKey(
    candidate.probeNhlSeasonKey,
    "probe_season_invalid"
  );
  if (!PROBE_KIND_SET.has(candidate.probeKind)) {
    invalid("probe_kind_invalid");
  }
  assertProbeSeasonRelationship(
    configuredNhlSeasonKey,
    probeNhlSeasonKey,
    candidate.probeKind
  );
  const issuedAtMs = safeTimestamp(
    candidate.issuedAtMs,
    "issued_time_invalid"
  );
  const expiresAtMs = safeTimestamp(
    candidate.expiresAtMs,
    "expiry_time_invalid"
  );
  if (
    expiresAtMs - issuedAtMs !==
      SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS
  ) {
    invalid("validity_window_invalid");
  }
  const request = normalizeRequest(candidate.request);
  const capture = normalizeCapture(
    candidate.capture,
    request,
    issuedAtMs
  );
  const endpointProofs = normalizeEndpointProofs(
    candidate.endpointProofs,
    configuredNhlSeasonKey,
    probeNhlSeasonKey,
    request,
    capture
  );
  const explicitZeroPair = normalizeExplicitZeroPair(
    candidate.explicitZeroPair,
    request,
    capture
  );
  const omissionProof = normalizeOmissionProof(
    candidate.omissionProof,
    explicitZeroPair
  );
  const assertions = normalizeAssertions(candidate.assertions);

  return deepFreeze({
    domain: SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
    schemaVersion:
      SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    evidenceId: stableId(
      candidate.evidenceId,
      "evidence_id_invalid"
    ),
    status: SPORTS_DATA_IO_LIVE_CAPABILITY_STATUS,
    provider: SPORTS_DATA_IO_LIVE_CAPABILITY_PROVIDER,
    appEnv: boundedText(candidate.appEnv, 64, "app_env_invalid"),
    environmentId: boundedText(
      candidate.environmentId,
      200,
      "environment_id_invalid"
    ),
    backendBuildId: boundedText(
      candidate.backendBuildId,
      200,
      "backend_build_id_invalid"
    ),
    origin: canonicalOrigin(candidate.origin),
    configuredNhlSeasonKey,
    probeNhlSeasonKey,
    probeKind: candidate.probeKind,
    probeManifestSha256: sha256(
      candidate.probeManifestSha256,
      "probe_manifest_sha256_invalid"
    ),
    capabilityKeyVersion: positiveInteger(
      candidate.capabilityKeyVersion,
      "capability_key_version_invalid"
    ),
    credentialBindingHmacSha256: sha256(
      candidate.credentialBindingHmacSha256,
      "credential_binding_hmac_invalid"
    ),
    issuedAtMs,
    expiresAtMs,
    request,
    capture,
    endpointProofs,
    explicitZeroPair,
    omissionProof,
    assertions,
  });
}

function createSportsDataIoLiveCapabilityEvidence(input) {
  return normalizeEvidence(input);
}

function validateSportsDataIoLiveCapabilityEvidence(input) {
  const normalized = normalizeEvidence(input);
  let inputCanonical;
  let normalizedCanonical;
  try {
    inputCanonical = serializeCanonicalJsonV1(input);
    normalizedCanonical = serializeCanonicalJsonV1(normalized);
  } catch {
    invalid("evidence_serialization_invalid");
  }
  if (inputCanonical !== normalizedCanonical) {
    invalid("evidence_not_normalized");
  }
  return normalized;
}

function serializeSportsDataIoLiveCapabilityEvidence(evidence) {
  return serializeCanonicalJsonV1(
    validateSportsDataIoLiveCapabilityEvidence(evidence)
  );
}

function hashSportsDataIoLiveCapabilityEvidence(evidence) {
  return hashCanonicalJsonV1(
    validateSportsDataIoLiveCapabilityEvidence(evidence)
  );
}

module.exports = {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ENDPOINT_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ENDPOINT_SCOPE_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_ERROR_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROVIDER,
  SPORTS_DATA_IO_LIVE_CAPABILITY_STATUS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
  SportsDataIoLiveCapabilityEvidencePolicyError,
  createSportsDataIoLiveCapabilityEvidence,
  hashSportsDataIoLiveCapabilityEvidence,
  serializeSportsDataIoLiveCapabilityEvidence,
  validateSportsDataIoLiveCapabilityEvidence,
};
