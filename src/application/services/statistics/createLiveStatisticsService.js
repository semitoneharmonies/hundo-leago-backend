const { randomUUID } = require("node:crypto");

const {
  STATISTICS_CODES,
  StatisticsPolicyError,
  assertNhlSeasonKey,
  normalizeStatisticsRows,
} = require("../../../domain/statistics/statisticsPolicy");
const {
  PLAYER_GAME_STATISTICS_CODES,
  PlayerGameStatisticsPolicyError,
  normalizePlayerGameStatisticsRows,
} = require("../../../domain/statistics/playerGameStatisticsPolicy");
const {
  PLAYER_GAME_COVERAGE_CODES,
  PlayerGameCoveragePolicyError,
  createPlayerGameCoverageRequirements,
  normalizePlayerGameCoverageResponse,
} = require("../../../domain/statistics/playerGameCoveragePolicy");

const LIVE_STATISTICS_CODES = Object.freeze({
  providerFailed: "LIVE_STATISTICS_PROVIDER_FAILED",
  snapshotInvalid: "LIVE_STATISTICS_SNAPSHOT_INVALID",
  persistenceFailed: "LIVE_STATISTICS_PERSISTENCE_FAILED",
});
const REQUIREMENT_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "nhlSeasonKey",
  "playerIdentityProvider",
  "requiredPlayers",
  "requiredPlayerGames",
  "requirementsSha256",
]);

class LiveStatisticsError extends Error {
  constructor(code, message, { cause, refreshId } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LiveStatisticsError";
    this.code = code;
    if (refreshId !== undefined) this.refreshId = refreshId;
  }
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`live statistics requires ${description}`);
  }
}

function canonicalSourceVersion(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new LiveStatisticsError(
      LIVE_STATISTICS_CODES.snapshotInvalid,
      "The live statistics snapshot has no canonical source version."
    );
  }
  return value;
}

function canonicalProviderName(value, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 80 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new TypeError(`live statistics requires ${description}`);
  }
  return value;
}

function normalizeRequirementSnapshot(
  value,
  { nhlSeasonKey, playerIdentityProvider }
) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== REQUIREMENT_SNAPSHOT_KEYS.length ||
    REQUIREMENT_SNAPSHOT_KEYS.some(
      (key) => !Object.hasOwn(value, key)
    ) ||
    value.schemaVersion !== 1 ||
    value.nhlSeasonKey !== nhlSeasonKey ||
    value.playerIdentityProvider !== playerIdentityProvider ||
    typeof value.requirementsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.requirementsSha256)
  ) {
    throw new TypeError(
      "live statistics requires a canonical player requirement snapshot"
    );
  }
  const canonical = createPlayerGameCoverageRequirements({
    nhlSeasonKey: value.nhlSeasonKey,
    playerIdentityProvider: value.playerIdentityProvider,
    requiredPlayers: value.requiredPlayers,
    requiredPlayerGames: value.requiredPlayerGames,
  });
  if (canonical.requirementsSha256 !== value.requirementsSha256) {
    throw new TypeError(
      "live statistics requires a canonical player requirement snapshot"
    );
  }
  return canonical;
}

function createLiveStatisticsService({
  repository,
  provider,
  nhlSeasonKey,
  providerName,
  playerIdentityProvider,
  minimumPlayerCount = 200,
  nowMs = Date.now,
  createId = randomUUID,
} = {}) {
  for (const method of [
    "ensureSource",
    "startRefresh",
    "readPlayerGameCoverageRequirements",
    "completeLiveRefresh",
    "rejectRefresh",
  ]) {
    requireMethod(repository, method, "a complete live statistics repository");
  }
  requireMethod(provider, "fetchLiveSnapshot", "a live statistics provider");
  const seasonKey = assertNhlSeasonKey(nhlSeasonKey);
  const sourceProviderName = canonicalProviderName(
    providerName,
    "a canonical provider name"
  );
  const identityProviderName = canonicalProviderName(
    playerIdentityProvider,
    "a canonical player identity provider"
  );
  if (!Number.isSafeInteger(minimumPlayerCount) || minimumPlayerCount < 1) {
    throw new TypeError("live statistics requires a positive player count");
  }
  if (typeof nowMs !== "function" || typeof createId !== "function") {
    throw new TypeError("live statistics requires clock and ID factories");
  }

  async function refresh({
    authorizePersist = null,
    occurrenceExecution,
  } = {}) {
    if (
      authorizePersist !== null &&
      typeof authorizePersist !== "function"
    ) {
      throw new TypeError(
        "live statistics persistence authorization must be callable"
      );
    }
    if (authorizePersist) await authorizePersist();
    const startedAtMs = nowMs();
    const source = repository.ensureSource({
      id: createId(),
      provider: sourceProviderName,
      nowMs: startedAtMs,
    });
    const refreshId = createId();
    repository.startRefresh({
      id: refreshId,
      statSourceId: source.id,
      nhlSeasonKey: seasonKey,
      startedAtMs,
    });

    let requirementSnapshot;
    let requiredPlayers;
    let requiredPlayerGames;
    try {
      requirementSnapshot = normalizeRequirementSnapshot(
        repository.readPlayerGameCoverageRequirements({
          nhlSeasonKey: seasonKey,
          playerIdentityProvider: identityProviderName,
        }),
        {
          nhlSeasonKey: seasonKey,
          playerIdentityProvider: identityProviderName,
        }
      );
      requiredPlayers = requirementSnapshot.requiredPlayers;
      requiredPlayerGames =
        requirementSnapshot.requiredPlayerGames;
    } catch (error) {
      const isCoveragePolicyError =
        error instanceof PlayerGameCoveragePolicyError;
      const errorCode = isCoveragePolicyError
        ? error.code
        : LIVE_STATISTICS_CODES.persistenceFailed;
      repository.rejectRefresh({
        refreshId,
        status: "rejected",
        errorCode,
        completedAtMs: nowMs(),
      });
      if (isCoveragePolicyError) throw error;
      throw new LiveStatisticsError(
        LIVE_STATISTICS_CODES.persistenceFailed,
        "The live statistics player requirements are unavailable.",
        { cause: error, refreshId }
      );
    }

    let providerResult;
    try {
      providerResult = await provider.fetchLiveSnapshot({
        nhlSeasonKey: seasonKey,
        requiredPlayers,
        requiredPlayerGames,
        requirementsSha256:
          requirementSnapshot.requirementsSha256,
      });
    } catch (error) {
      repository.rejectRefresh({
        refreshId,
        status: "failed",
        errorCode: LIVE_STATISTICS_CODES.providerFailed,
        completedAtMs: nowMs(),
      });
      throw new LiveStatisticsError(
        LIVE_STATISTICS_CODES.providerFailed,
        "The live statistics provider refresh failed.",
        { cause: error, refreshId }
      );
    }

    let normalizedTotals;
    let normalizedPlayerGames;
    let normalizedCoverage;
    let sourceVersion;
    let capturedAtMs;
    try {
      if (
        providerResult === null ||
        typeof providerResult !== "object" ||
        Array.isArray(providerResult)
      ) {
        throw new LiveStatisticsError(
          LIVE_STATISTICS_CODES.snapshotInvalid,
          "The live statistics provider returned an invalid snapshot."
        );
      }
      if (providerResult.provider !== sourceProviderName) {
        throw new LiveStatisticsError(
          LIVE_STATISTICS_CODES.snapshotInvalid,
          "The live statistics snapshot provider does not match its configured authority."
        );
      }
      sourceVersion = canonicalSourceVersion(providerResult.sourceVersion);
      capturedAtMs = providerResult.capturedAtMs;
      normalizedPlayerGames = normalizePlayerGameStatisticsRows({
        rows: providerResult.playerGameRows,
        capturedAtMs,
      });
      normalizedCoverage = normalizePlayerGameCoverageResponse({
        requiredPlayers,
        requiredPlayerGames,
        response: providerResult.playerGameCoverage,
        observationRows: normalizedPlayerGames,
        capturedAtMs,
      });
      const totalsSourceUpdatedAtMs =
        providerResult.totalsSourceUpdatedAtMs ?? capturedAtMs;
      if (totalsSourceUpdatedAtMs > capturedAtMs) {
        throw new LiveStatisticsError(
          LIVE_STATISTICS_CODES.snapshotInvalid,
          "Live statistics totals cannot be newer than their snapshot."
        );
      }
      normalizedTotals = normalizeStatisticsRows({
        rows: providerResult.totalsRows,
        minimumPlayerCount,
        sourceUpdatedAtMs: totalsSourceUpdatedAtMs,
      });
    } catch (error) {
      const errorCode =
        error instanceof StatisticsPolicyError ||
        error instanceof PlayerGameStatisticsPolicyError ||
        error instanceof PlayerGameCoveragePolicyError
          ? error.code
          : LIVE_STATISTICS_CODES.snapshotInvalid;
      repository.rejectRefresh({
        refreshId,
        status: "rejected",
        errorCode,
        completedAtMs: nowMs(),
      });
      throw error;
    }

    if (capturedAtMs < startedAtMs) {
      const error = new LiveStatisticsError(
        LIVE_STATISTICS_CODES.snapshotInvalid,
        "The live statistics snapshot predates its refresh."
      );
      repository.rejectRefresh({
        refreshId,
        status: "rejected",
        errorCode: error.code,
        completedAtMs: nowMs(),
      });
      throw error;
    }

    if (authorizePersist) {
      try {
        await authorizePersist();
      } catch (error) {
        repository.rejectRefresh({
          refreshId,
          status: "rejected",
          errorCode: LIVE_STATISTICS_CODES.persistenceFailed,
          completedAtMs: nowMs(),
        });
        throw error;
      }
    }

    try {
      const result = repository.completeLiveRefresh({
        refreshId,
        statSourceId: source.id,
        provider: sourceProviderName,
        playerIdentityProvider: identityProviderName,
        nhlSeasonKey: seasonKey,
        sourceVersion,
        completedAtMs: capturedAtMs,
        rows: normalizedTotals,
        playerGameRows: normalizedPlayerGames,
        requiredPlayers,
        requiredPlayerGames,
        requirementsSha256:
          requirementSnapshot.requirementsSha256,
        playerGameCoverage: normalizedCoverage.coverage,
        ...(occurrenceExecution === undefined
          ? {}
          : { occurrenceExecution }),
      });
      return Object.freeze({
        refreshId: result.refresh.id,
        status: result.refresh.status,
        playerCount: result.refresh.player_count,
        playerGameObservationCount:
          result.playerGameSet.observation_count,
        playerGameEvidenceSha256:
          result.playerGameSet.evidence_sha256,
        playerGameRequiredPlayerCount:
          result.playerGameSet.required_player_count,
        playerGameCoverageEntryCount:
          result.playerGameSet.coverage_entry_count,
        playerGameExpectedPlayerGameCount:
          result.playerGameSet.expected_player_game_count,
        playerGameCoverageSha256:
          result.playerGameSet.coverage_sha256,
        sourceVersion: result.refresh.source_version,
        capturedAtMs: result.playerGameSet.captured_at_ms,
      });
    } catch (error) {
      repository.rejectRefresh({
        refreshId,
        status: "rejected",
        errorCode: LIVE_STATISTICS_CODES.persistenceFailed,
        completedAtMs: nowMs(),
      });
      throw new LiveStatisticsError(
        LIVE_STATISTICS_CODES.persistenceFailed,
        "The live statistics snapshot could not be persisted.",
        { cause: error, refreshId }
      );
    }
  }

  return Object.freeze({ refresh });
}

module.exports = {
  LIVE_STATISTICS_CODES,
  LiveStatisticsError,
  createLiveStatisticsService,
  STATISTICS_CODES,
  PLAYER_GAME_STATISTICS_CODES,
  PLAYER_GAME_COVERAGE_CODES,
};
