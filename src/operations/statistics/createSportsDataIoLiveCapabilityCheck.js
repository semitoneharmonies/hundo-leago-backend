const crypto = require("node:crypto");

const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  PLAYER_GAME_COVERAGE_CODES,
  createPlayerGameCoverageRequirements,
  normalizePlayerGameCoverageResponse,
} = require(
  "../../domain/statistics/playerGameCoveragePolicy"
);
const {
  normalizePlayerGameStatisticsRows,
} = require(
  "../../domain/statistics/playerGameStatisticsPolicy"
);
const {
  normalizeStatisticsRows,
} = require("../../domain/statistics/statisticsPolicy");
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROVIDER,
  SPORTS_DATA_IO_LIVE_CAPABILITY_STATUS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
  createSportsDataIoLiveCapabilityEvidence,
} = require(
  "../../domain/statistics/sportsDataIoLiveCapabilityEvidencePolicy"
);
const {
  createSportsDataIoLiveCapabilityAuthenticator,
} = require(
  "../../infrastructure/security/createSportsDataIoLiveCapabilityAuthenticator"
);
const {
  DEFAULT_ORIGIN,
  MINIMUM_CURRENT_SEASON_PLAYER_COUNT,
  PROVIDER_NAME,
  createSportsDataIoLiveNhlAdapter,
} = require(
  "../../infrastructure/sportsdataio/SportsDataIoLiveNhlAdapter"
);
const {
  createSportsDataIoLiveCapabilityArtifact,
} = require(
  "../../infrastructure/statistics/SportsDataIoLiveCapabilityArtifact"
);

const SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN =
  "hundo-leago.sportsdataio-live-capability-probe-manifest";
const SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION =
  1;
const SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES =
  Object.freeze({
    configurationInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_CHECK_CONFIGURATION_INVALID",
    manifestInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_CHECK_MANIFEST_INVALID",
    providerFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_CHECK_PROVIDER_FAILED",
    semanticFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_CHECK_SEMANTIC_FAILED",
    artifactFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_CHECK_ARTIFACT_FAILED",
    internalFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_CHECK_INTERNAL_FAILED",
  });
const PROBE_KIND = "historical_offseason";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EXPECTED_DISPOSITIONS = Object.freeze([
  "expected_game",
  "no_due_game",
  "no_team",
]);
const MANIFEST_KEYS = Object.freeze([
  "domain",
  "schemaVersion",
  "probeKind",
  "configuredNhlSeasonKey",
  "probeNhlSeasonKey",
  "players",
  "historicalZeroGame",
]);
const MANIFEST_PLAYER_KEYS = Object.freeze([
  "playerId",
  "providerPlayerId",
  "expectedDisposition",
]);
const HISTORICAL_ZERO_GAME_KEYS = Object.freeze([
  "playerId",
  "providerPlayerId",
  "providerTeamId",
  "nhlGameId",
  "nhlGameScheduledStartsAtMs",
]);
const FACTORY_KEYS = Object.freeze([
  "appEnv",
  "environmentId",
  "backendBuildId",
  "configuredNhlSeasonKey",
  "origin",
  "probeManifest",
  "dedicatedLiveApiKey",
  "capabilitySecret",
  "capabilityKeyVersion",
  "persistentRoot",
  "artifactPath",
  "fetchImpl",
  "nowMs",
  "randomUUID",
]);
const REQUIRED_FACTORY_KEYS = Object.freeze([
  "appEnv",
  "environmentId",
  "backendBuildId",
  "configuredNhlSeasonKey",
  "probeManifest",
  "dedicatedLiveApiKey",
  "capabilitySecret",
  "capabilityKeyVersion",
  "persistentRoot",
  "artifactPath",
]);

class SportsDataIoLiveCapabilityCheckError extends Error {
  constructor(code) {
    super("The SportsDataIO live capability check failed safely.");
    this.name = "SportsDataIoLiveCapabilityCheckError";
    this.code = code;
  }
}

function fail(code) {
  throw new SportsDataIoLiveCapabilityCheckError(code);
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, code) {
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(code);
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(code);
    }
  }
  return value;
}

function boundedText(value, maximum, code) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function seasonKey(value, code) {
  if (typeof value !== "string" || !/^\d{8}$/u.test(value)) {
    fail(code);
  }
  const start = Number(value.slice(0, 4));
  const end = Number(value.slice(4));
  if (end !== start + 1) fail(code);
  return value;
}

function safeTimestamp(value, code) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    fail(code);
  }
  return value;
}

function canonicalOrigin(value, code) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    fail(code);
  }
  return parsed.origin;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertPreviousSeason(configured, probe) {
  if (
    Number(probe.slice(0, 4)) + 1 !==
      Number(configured.slice(0, 4))
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .manifestInvalid
    );
  }
}

function normalizeSportsDataIoLiveCapabilityProbeManifest(input) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
      .manifestInvalid;
  const candidate = exactObject(input, MANIFEST_KEYS, code);
  if (
    candidate.domain !==
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN ||
    candidate.schemaVersion !==
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION ||
    candidate.probeKind !== PROBE_KIND ||
    !Array.isArray(candidate.players) ||
    candidate.players.length < 3
  ) {
    fail(code);
  }
  const configuredNhlSeasonKey = seasonKey(
    candidate.configuredNhlSeasonKey,
    code
  );
  const probeNhlSeasonKey = seasonKey(
    candidate.probeNhlSeasonKey,
    code
  );
  assertPreviousSeason(
    configuredNhlSeasonKey,
    probeNhlSeasonKey
  );

  const players = candidate.players.map((value) => {
    const player = exactObject(
      value,
      MANIFEST_PLAYER_KEYS,
      code
    );
    if (!EXPECTED_DISPOSITIONS.includes(player.expectedDisposition)) {
      fail(code);
    }
    return {
      playerId: player.playerId,
      providerPlayerId: player.providerPlayerId,
      expectedDisposition: player.expectedDisposition,
    };
  });
  const zero = exactObject(
    candidate.historicalZeroGame,
    HISTORICAL_ZERO_GAME_KEYS,
    code
  );
  let requirements;
  try {
    requirements = createPlayerGameCoverageRequirements({
      nhlSeasonKey: probeNhlSeasonKey,
      playerIdentityProvider: PROVIDER_NAME,
      requiredPlayers: players.map((player) => ({
        playerId: player.playerId,
        providerPlayerId: player.providerPlayerId,
      })),
      requiredPlayerGames: [{
        playerId: zero.playerId,
        providerPlayerId: zero.providerPlayerId,
        providerTeamId: zero.providerTeamId,
        nhlGameId: zero.nhlGameId,
        nhlGameScheduledStartsAtMs:
          zero.nhlGameScheduledStartsAtMs,
      }],
    });
  } catch {
    fail(code);
  }
  const expectedByPlayerId = new Map(
    players.map((player) => [
      player.playerId,
      player.expectedDisposition,
    ])
  );
  const normalizedPlayers = requirements.requiredPlayers.map(
    (player) => ({
      ...player,
      expectedDisposition:
        expectedByPlayerId.get(player.playerId),
    })
  );
  const dispositionCounts = new Map(
    EXPECTED_DISPOSITIONS.map((value) => [value, 0])
  );
  for (const player of normalizedPlayers) {
    dispositionCounts.set(
      player.expectedDisposition,
      dispositionCounts.get(player.expectedDisposition) + 1
    );
  }
  const expectedGamePlayers = normalizedPlayers.filter(
    (player) => player.expectedDisposition === "expected_game"
  );
  if (
    expectedGamePlayers.length !== 1 ||
    EXPECTED_DISPOSITIONS.some(
      (value) => dispositionCounts.get(value) < 1
    ) ||
    expectedGamePlayers[0].playerId !== zero.playerId ||
    expectedGamePlayers[0].providerPlayerId !==
      zero.providerPlayerId
  ) {
    fail(code);
  }
  const historicalZeroGame = {
    ...requirements.requiredPlayerGames[0],
  };
  const normalized = {
    domain:
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
    schemaVersion:
      SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
    probeKind: PROBE_KIND,
    configuredNhlSeasonKey,
    probeNhlSeasonKey,
    players: normalizedPlayers,
    historicalZeroGame,
  };
  try {
    if (
      serializeCanonicalJsonV1(candidate) !==
        serializeCanonicalJsonV1(normalized)
    ) {
      fail(code);
    }
  } catch (error) {
    if (error instanceof SportsDataIoLiveCapabilityCheckError) {
      throw error;
    }
    fail(code);
  }
  return deepFreeze(normalized);
}

function hashSportsDataIoLiveCapabilityProbeManifest(manifest) {
  return hashCanonicalJsonV1(
    normalizeSportsDataIoLiveCapabilityProbeManifest(manifest)
  );
}

function endpointDescriptor(
  rawUrl,
  { origin, configuredNhlSeasonKey, probeNhlSeasonKey }
) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
      .semanticFailed;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail(code);
  }
  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(code);
  }
  const exact = new Map([
    [
      "/v3/nhl/scores/json/Players",
      ["players", "season", configuredNhlSeasonKey],
    ],
    [
      "/v3/nhl/scores/json/FreeAgents",
      ["free_agents", "season", configuredNhlSeasonKey],
    ],
    [
      "/v3/nhl/stats/json/PlayerSeasonStats/" +
        `${probeNhlSeasonKey.slice(4)}REG`,
      ["season_totals", "season", probeNhlSeasonKey],
    ],
  ]);
  const known = exact.get(parsed.pathname);
  if (known) {
    return Object.freeze({
      endpointKind: known[0],
      scopeKind: known[1],
      scopeValue: known[2],
    });
  }
  for (const [prefix, endpointKind] of [
    ["/v3/nhl/scores/json/GamesByDate/", "schedule"],
    [
      "/v3/nhl/stats/json/PlayerGameStatsByDate/",
      "player_game",
    ],
  ]) {
    if (parsed.pathname.startsWith(prefix)) {
      const date = parsed.pathname.slice(prefix.length);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) fail(code);
      return Object.freeze({
        endpointKind,
        scopeKind: "date",
        scopeValue: date,
      });
    }
  }
  fail(code);
}

function responseSha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function readBoundedResponseBytes(
  response,
  maximumBytes = MAX_RESPONSE_BYTES
) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
      .semanticFailed;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !response ||
    typeof response.clone !== "function"
  ) {
    fail(code);
  }
  let clone;
  let reader;
  try {
    clone = response.clone();
    if (!clone?.body || typeof clone.body.getReader !== "function") {
      fail(code);
    }
    reader = clone.body.getReader();
  } catch (error) {
    if (error instanceof SportsDataIoLiveCapabilityCheckError) {
      throw error;
    }
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .providerFailed
    );
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (
        !result ||
        typeof result.done !== "boolean" ||
        (!result.done && !(result.value instanceof Uint8Array))
      ) {
        fail(code);
      }
      if (result.done) break;
      if (
        result.value.byteLength < 1 ||
        totalBytes + result.value.byteLength > maximumBytes
      ) {
        try {
          await reader.cancel();
        } catch {
          // The semantic failure remains authoritative.
        }
        fail(code);
      }
      const chunk = Buffer.from(result.value);
      chunks.push(chunk);
      totalBytes += chunk.length;
    }
    if (totalBytes < 1) fail(code);
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error instanceof SportsDataIoLiveCapabilityCheckError) {
      throw error;
    }
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .providerFailed
    );
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or failed stream can already have released its lock.
    }
  }
}

function createResponseCapture({
  fetchImpl,
  origin,
  configuredNhlSeasonKey,
  probeNhlSeasonKey,
}) {
  const records = new Map();
  async function capturingFetch(url, options) {
    const descriptor = endpointDescriptor(url, {
      origin,
      configuredNhlSeasonKey,
      probeNhlSeasonKey,
    });
    if (records.has(url)) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
          .semanticFailed
      );
    }
    const response = await fetchImpl(url, options);
    if (
      !response ||
      typeof response.clone !== "function" ||
      typeof response.status !== "number"
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
          .providerFailed
      );
    }
    let raw;
    let rows;
    try {
      raw = await readBoundedResponseBytes(response);
      rows = JSON.parse(raw.toString("utf8"));
      if (!Array.isArray(rows)) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .semanticFailed
        );
      }
    } catch (error) {
      if (raw) raw.fill(0);
      if (error instanceof SportsDataIoLiveCapabilityCheckError) {
        throw error;
      }
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
          .providerFailed
      );
    }
    records.set(url, {
      url,
      descriptor,
      httpStatus: response.status,
      rowCount: rows.length,
      responseSha256: responseSha256(raw),
      raw,
    });
    rows = null;
    return response;
  }
  function clear() {
    for (const record of records.values()) record.raw.fill(0);
    records.clear();
  }
  function endpointProofs() {
    return [...records.values()].map((record) => ({
      ...record.descriptor,
      httpStatus: record.httpStatus,
      rowCount: record.rowCount,
      responseSha256: record.responseSha256,
    }));
  }
  return Object.freeze({
    clear,
    endpointProofs,
    fetchImpl: capturingFetch,
    records,
  });
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

function sameProviderId(left, right) {
  return String(left) === String(right);
}

function createControlledOmissionReplay(
  capture,
  historicalZeroGame
) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
      .semanticFailed;
  const targetDate = easternCalendarDate(
    historicalZeroGame.nhlGameScheduledStartsAtMs
  );
  const target = [...capture.records.values()].find(
    (record) =>
      record.descriptor.endpointKind === "player_game" &&
      record.descriptor.scopeValue === targetDate
  );
  if (!target) fail(code);
  let rows;
  try {
    rows = JSON.parse(target.raw.toString("utf8"));
  } catch {
    fail(code);
  }
  const matching = rows.filter(
    (row) =>
      isPlainObject(row) &&
      sameProviderId(
        row.PlayerID,
        historicalZeroGame.providerPlayerId
      ) &&
      sameProviderId(row.GameID, historicalZeroGame.nhlGameId)
  );
  if (
    matching.length !== 1 ||
    !sameProviderId(
      matching[0].TeamID,
      historicalZeroGame.providerTeamId
    ) ||
    matching[0].Games !== 0 ||
    matching[0].Goals !== 0 ||
    matching[0].Assists !== 0
  ) {
    fail(code);
  }
  const omittedRows = rows.filter((row) => row !== matching[0]);
  const omittedRaw = Buffer.from(
    JSON.stringify(omittedRows),
    "utf8"
  );
  rows = null;

  async function replayFetch(url) {
    const record = capture.records.get(url);
    if (!record || typeof globalThis.Response !== "function") {
      fail(code);
    }
    const body = record === target
      ? Buffer.from(omittedRaw)
      : Buffer.from(record.raw);
    return new Response(body, {
      status: record.httpStatus,
      headers: { "content-type": "application/json" },
    });
  }
  return Object.freeze({
    clear() {
      omittedRaw.fill(0);
    },
    fetchImpl: replayFetch,
  });
}

function assertExpectedDispositions(manifest, normalized) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
      .semanticFailed;
  if (normalized.coverage.length !== manifest.players.length) {
    fail(code);
  }
  const byPlayerId = new Map(
    normalized.coverage.map((entry) => [entry.playerId, entry])
  );
  for (const expected of manifest.players) {
    const observed = byPlayerId.get(expected.playerId);
    if (
      !observed ||
      observed.providerPlayerId !== expected.providerPlayerId ||
      observed.disposition !== expected.expectedDisposition
    ) {
      fail(code);
    }
  }
  const zeroCoverage = byPlayerId.get(
    manifest.historicalZeroGame.playerId
  );
  if (
    !zeroCoverage ||
    zeroCoverage.disposition !== "expected_game" ||
    zeroCoverage.providerTeamId !==
      manifest.historicalZeroGame.providerTeamId ||
    zeroCoverage.nhlGameId !==
      manifest.historicalZeroGame.nhlGameId ||
    zeroCoverage.nhlGameScheduledStartsAtMs !==
      manifest.historicalZeroGame.nhlGameScheduledStartsAtMs ||
    zeroCoverage.observedGameState !== "final"
  ) {
    fail(code);
  }
}

function explicitZeroPair(manifest, normalized) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
      .semanticFailed;
  const game = manifest.historicalZeroGame;
  const observation = normalized.observationRows.find(
    (row) =>
      row.externalPlayerId === game.providerPlayerId &&
      row.nhlGameId === game.nhlGameId
  );
  if (
    !observation ||
    observation.nhlGameScheduledStartsAtMs !==
      game.nhlGameScheduledStartsAtMs ||
    observation.observedGameState !== "final" ||
    observation.goals !== 0 ||
    observation.assists !== 0 ||
    observation.nhlPoints !== 0 ||
    observation.fantasyPointsHundredths !== 0
  ) {
    fail(code);
  }
  return Object.freeze({
    ...game,
    observedGameState: observation.observedGameState,
    goals: observation.goals,
    assists: observation.assists,
    nhlPoints: observation.nhlPoints,
    fantasyPointsHundredths:
      observation.fantasyPointsHundredths,
    sourceUpdatedAtMs: observation.sourceUpdatedAtMs,
  });
}

function providerFailureCode(error) {
  return error?.code === "SPORTSDATAIO_LIVE_REQUEST_FAILED"
    ? SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .providerFailed
    : SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .semanticFailed;
}

function exactFactoryConfiguration(options) {
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
      .configurationInvalid;
  if (!isPlainObject(options)) fail(code);
  const keys = Object.getOwnPropertyNames(options);
  if (
    Object.getOwnPropertySymbols(options).length !== 0 ||
    keys.some((key) => !FACTORY_KEYS.includes(key)) ||
    REQUIRED_FACTORY_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(options, key)
    )
  ) {
    fail(code);
  }
  exactObject(options, keys, code);
  return options;
}

function createSportsDataIoLiveCapabilityCheck(options = {}) {
  const configuration = exactFactoryConfiguration(options);
  const code =
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
      .configurationInvalid;
  const appEnv = boundedText(configuration.appEnv, 64, code);
  const environmentId = boundedText(
    configuration.environmentId,
    200,
    code
  );
  const backendBuildId = boundedText(
    configuration.backendBuildId,
    200,
    code
  );
  const configuredNhlSeasonKey = seasonKey(
    configuration.configuredNhlSeasonKey,
    code
  );
  const origin = canonicalOrigin(
    configuration.origin ?? DEFAULT_ORIGIN,
    code
  );
  const fetchImpl = configuration.fetchImpl ?? globalThis.fetch;
  const nowMs = configuration.nowMs ?? Date.now;
  const randomUUID = configuration.randomUUID ?? crypto.randomUUID;
  if (
    typeof fetchImpl !== "function" ||
    typeof nowMs !== "function" ||
    typeof randomUUID !== "function"
  ) {
    fail(code);
  }
  const probeManifest =
    normalizeSportsDataIoLiveCapabilityProbeManifest(
      configuration.probeManifest
    );
  if (
    probeManifest.configuredNhlSeasonKey !==
      configuredNhlSeasonKey
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .manifestInvalid
    );
  }
  const probeManifestSha256 =
    hashSportsDataIoLiveCapabilityProbeManifest(
      probeManifest
    );
  const requirements = createPlayerGameCoverageRequirements({
    nhlSeasonKey: probeManifest.probeNhlSeasonKey,
    playerIdentityProvider: PROVIDER_NAME,
    requiredPlayers: probeManifest.players.map((player) => ({
      playerId: player.playerId,
      providerPlayerId: player.providerPlayerId,
    })),
    requiredPlayerGames: [probeManifest.historicalZeroGame],
  });
  let authenticator;
  let artifactStore;
  try {
    authenticator =
      createSportsDataIoLiveCapabilityAuthenticator({
        capabilitySecret: configuration.capabilitySecret,
        dedicatedLiveApiKey:
          configuration.dedicatedLiveApiKey,
        capabilityKeyVersion:
          configuration.capabilityKeyVersion,
      });
    artifactStore = createSportsDataIoLiveCapabilityArtifact({
      persistentRoot: configuration.persistentRoot,
      artifactPath: configuration.artifactPath,
      authenticator,
      randomUUID,
    });
  } catch {
    fail(code);
  }
  const expectedBindings = deepFreeze({
    appEnv,
    environmentId,
    backendBuildId,
    origin,
    configuredNhlSeasonKey,
    probeNhlSeasonKey: probeManifest.probeNhlSeasonKey,
    probeKind: PROBE_KIND,
    probeManifestSha256,
  });

  async function run() {
    const requestedAtMs = safeTimestamp(
      nowMs(),
      SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
        .internalFailed
    );
    const capture = createResponseCapture({
      fetchImpl,
      origin,
      configuredNhlSeasonKey,
      probeNhlSeasonKey: probeManifest.probeNhlSeasonKey,
    });
    let omissionReplay = null;
    try {
      const adapter = createSportsDataIoLiveNhlAdapter({
        apiKey: configuration.dedicatedLiveApiKey,
        fetchImpl: capture.fetchImpl,
        origin,
        nowMs: () => requestedAtMs,
        dateLookbackDays: 0,
      });
      let providerResult;
      try {
        providerResult = await adapter.fetchLiveSnapshot({
          nhlSeasonKey: probeManifest.probeNhlSeasonKey,
          requiredPlayers: requirements.requiredPlayers,
          requiredPlayerGames: requirements.requiredPlayerGames,
          requirementsSha256: requirements.requirementsSha256,
        });
      } catch (error) {
        if (error instanceof SportsDataIoLiveCapabilityCheckError) {
          throw error;
        }
        fail(providerFailureCode(error));
      }
      let normalizedObservations;
      let normalizedCoverage;
      try {
        if (providerResult.provider !== PROVIDER_NAME) {
          fail(
            SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
              .semanticFailed
          );
        }
        normalizeStatisticsRows({
          rows: providerResult.totalsRows,
          minimumPlayerCount:
            MINIMUM_CURRENT_SEASON_PLAYER_COUNT,
          sourceUpdatedAtMs:
            providerResult.totalsSourceUpdatedAtMs,
        });
        normalizedObservations =
          normalizePlayerGameStatisticsRows({
            rows: providerResult.playerGameRows,
            capturedAtMs: providerResult.capturedAtMs,
            minimumObservationCount: 1,
          });
        normalizedCoverage =
          normalizePlayerGameCoverageResponse({
            requiredPlayers: requirements.requiredPlayers,
            requiredPlayerGames:
              requirements.requiredPlayerGames,
            response: providerResult.playerGameCoverage,
            observationRows: normalizedObservations,
            capturedAtMs: providerResult.capturedAtMs,
          });
        assertExpectedDispositions(
          probeManifest,
          normalizedCoverage
        );
      } catch (error) {
        if (error instanceof SportsDataIoLiveCapabilityCheckError) {
          throw error;
        }
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .semanticFailed
        );
      }
      const zeroPair = explicitZeroPair(
        probeManifest,
        normalizedCoverage
      );

      const issuedAtMs = safeTimestamp(
        nowMs(),
        SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
          .internalFailed
      );
      if (issuedAtMs < providerResult.capturedAtMs) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .internalFailed
        );
      }

      omissionReplay = createControlledOmissionReplay(
        capture,
        probeManifest.historicalZeroGame
      );
      const replayAdapter = createSportsDataIoLiveNhlAdapter({
        apiKey: configuration.dedicatedLiveApiKey,
        fetchImpl: omissionReplay.fetchImpl,
        origin,
        nowMs: () => requestedAtMs,
        dateLookbackDays: 0,
      });
      let omissionRejected = false;
      try {
        await replayAdapter.fetchLiveSnapshot({
          nhlSeasonKey: probeManifest.probeNhlSeasonKey,
          requiredPlayers: requirements.requiredPlayers,
          requiredPlayerGames: requirements.requiredPlayerGames,
          requirementsSha256: requirements.requirementsSha256,
        });
      } catch (error) {
        omissionRejected =
          error?.code ===
            "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE";
      }
      if (!omissionRejected) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .semanticFailed
        );
      }

      const evidenceId = randomUUID();
      if (
        typeof evidenceId !== "string" ||
        !UUID_V4_PATTERN.test(evidenceId)
      ) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .internalFailed
        );
      }
      let evidence;
      try {
        evidence = createSportsDataIoLiveCapabilityEvidence({
          domain:
            SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
          schemaVersion:
            SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
          evidenceId,
          status: SPORTS_DATA_IO_LIVE_CAPABILITY_STATUS,
          provider:
            SPORTS_DATA_IO_LIVE_CAPABILITY_PROVIDER,
          ...expectedBindings,
          capabilityKeyVersion:
            authenticator.capabilityKeyVersion,
          credentialBindingHmacSha256:
            authenticator
              .credentialBindingHmacSha256(),
          issuedAtMs,
          expiresAtMs:
            issuedAtMs +
            SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
          request: {
            requiredPlayers: requirements.requiredPlayers,
            requiredPlayerGames:
              requirements.requiredPlayerGames,
          },
          capture: {
            capturedAtMs: providerResult.capturedAtMs,
            sourceVersion: providerResult.sourceVersion,
            coverage: normalizedCoverage.coverage,
            observations: normalizedCoverage.observationRows,
          },
          endpointProofs: capture.endpointProofs(),
          explicitZeroPair: zeroPair,
          omissionProof: {
            kind:
              SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
            omittedPlayerId: zeroPair.playerId,
            omittedNhlGameId: zeroPair.nhlGameId,
            resultCode:
              SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
          },
          assertions:
            SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS.map(
              (kind) => ({ kind, passed: true })
            ),
        });
      } catch (error) {
        if (error instanceof SportsDataIoLiveCapabilityCheckError) {
          throw error;
        }
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .semanticFailed
        );
      }
      let artifact;
      let publication;
      try {
        const publicationAtMs = safeTimestamp(
          nowMs(),
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .internalFailed
        );
        if (publicationAtMs < issuedAtMs) {
          fail(
            SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
              .internalFailed
          );
        }
        artifact = authenticator.createArtifact(evidence);
        publication = artifactStore.publish({
          artifact,
          expectedBindings,
          nowMs: publicationAtMs,
        });
      } catch {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .artifactFailed
        );
      }
      return deepFreeze({
        status: publication.status,
        capabilityStatus: evidence.status,
        evidenceId: evidence.evidenceId,
        evidenceSha256: artifact.evidenceSha256,
        appEnv: evidence.appEnv,
        environmentId: evidence.environmentId,
        backendBuildId: evidence.backendBuildId,
        issuedAtMs: evidence.issuedAtMs,
        expiresAtMs: evidence.expiresAtMs,
        sourceVersion: evidence.capture.sourceVersion,
        assertions: evidence.assertions.map(
          (assertion) => assertion.kind
        ),
      });
    } catch (error) {
      if (error instanceof SportsDataIoLiveCapabilityCheckError) {
        throw error;
      }
      if (
        error?.code ===
        PLAYER_GAME_COVERAGE_CODES.responseIncomplete
      ) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
            .semanticFailed
        );
      }
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
          .internalFailed
      );
    } finally {
      if (omissionReplay) omissionReplay.clear();
      capture.clear();
    }
  }

  return Object.freeze({
    probeManifest,
    probeManifestSha256,
    run,
  });
}

module.exports = {
  SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_PROBE_MANIFEST_SCHEMA_VERSION,
  SportsDataIoLiveCapabilityCheckError,
  createSportsDataIoLiveCapabilityCheck,
  hashSportsDataIoLiveCapabilityProbeManifest,
  normalizeSportsDataIoLiveCapabilityProbeManifest,
  readBoundedResponseBytes,
};
