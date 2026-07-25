const { randomUUID } = require("node:crypto");

const {
  STATISTICS_CODES,
  StatisticsPolicyError,
  assertNhlSeasonKey,
  normalizeStatisticsRows,
} = require("../../../domain/statistics/statisticsPolicy");

const TARGET_STATISTICS_CODES = Object.freeze({
  providerFailed: "STATISTICS_PROVIDER_FAILED",
  persistenceFailed: "STATISTICS_PERSISTENCE_FAILED",
});

class TargetStatisticsError extends Error {
  constructor(code, message, { cause, refreshId } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TargetStatisticsError";
    this.code = code;
    if (refreshId !== undefined) this.refreshId = refreshId;
  }
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`target statistics requires ${description}`);
  }
}

function createTargetStatisticsService({
  repository,
  provider,
  nhlSeasonKey,
  providerName = "nhl",
  minimumPlayerCount = 200,
  nowMs = Date.now,
  createId = randomUUID,
} = {}) {
  for (const method of [
    "ensureSource",
    "startRefresh",
    "completeRefresh",
    "rejectRefresh",
    "readLatestSeason",
  ]) {
    requireMethod(repository, method, "a complete statistics repository");
  }
  requireMethod(provider, "fetchRows", "a statistics provider");
  const seasonKey = assertNhlSeasonKey(nhlSeasonKey);
  if (typeof nowMs !== "function" || typeof createId !== "function") {
    throw new TypeError("target statistics requires clock and ID factories");
  }

  async function refresh({ authorizePersist = null } = {}) {
    if (
      authorizePersist !== null &&
      typeof authorizePersist !== "function"
    ) {
      throw new TypeError(
        "target statistics persistence authorization must be callable"
      );
    }
    if (authorizePersist) await authorizePersist();
    const startedAtMs = nowMs();
    const source = repository.ensureSource({
      id: createId(),
      provider: providerName,
      nowMs: startedAtMs,
    });
    const refreshId = createId();
    repository.startRefresh({
      id: refreshId,
      statSourceId: source.id,
      nhlSeasonKey: seasonKey,
      startedAtMs,
    });

    let providerResult;
    try {
      providerResult = await provider.fetchRows();
    } catch (error) {
      repository.rejectRefresh({
        refreshId,
        status: "failed",
        errorCode: TARGET_STATISTICS_CODES.providerFailed,
        completedAtMs: nowMs(),
      });
      throw new TargetStatisticsError(
        TARGET_STATISTICS_CODES.providerFailed,
        "The statistics provider refresh failed.",
        { cause: error, refreshId }
      );
    }

    const rows = Array.isArray(providerResult)
      ? providerResult
      : providerResult?.rows;
    const sourceVersion = Array.isArray(providerResult)
      ? null
      : providerResult?.sourceVersion ?? null;
    const sourceUpdatedAtMs = Array.isArray(providerResult)
      ? nowMs()
      : providerResult?.sourceUpdatedAtMs ?? nowMs();

    let normalized;
    try {
      normalized = normalizeStatisticsRows({
        rows,
        minimumPlayerCount,
        sourceUpdatedAtMs,
      });
    } catch (error) {
      const code =
        error instanceof StatisticsPolicyError
          ? error.code
          : STATISTICS_CODES.inputInvalid;
      repository.rejectRefresh({
        refreshId,
        status: "rejected",
        errorCode: code,
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
          errorCode: TARGET_STATISTICS_CODES.persistenceFailed,
          completedAtMs: nowMs(),
        });
        throw error;
      }
    }

    try {
      const refresh = repository.completeRefresh({
        refreshId,
        statSourceId: source.id,
        provider: providerName,
        nhlSeasonKey: seasonKey,
        sourceVersion,
        completedAtMs: nowMs(),
        rows: normalized,
      });
      return Object.freeze({
        refreshId: refresh.id,
        status: refresh.status,
        playerCount: refresh.player_count,
        sourceVersion: refresh.source_version,
      });
    } catch (error) {
      repository.rejectRefresh({
        refreshId,
        status: "rejected",
        errorCode: TARGET_STATISTICS_CODES.persistenceFailed,
        completedAtMs: nowMs(),
      });
      throw new TargetStatisticsError(
        TARGET_STATISTICS_CODES.persistenceFailed,
        "The statistics refresh could not be persisted.",
        { cause: error, refreshId }
      );
    }
  }

  return Object.freeze({
    refresh,
    readLatest() {
      return repository.readLatestSeason({
        provider: providerName,
        nhlSeasonKey: seasonKey,
      });
    },
  });
}

module.exports = {
  TARGET_STATISTICS_CODES,
  TargetStatisticsError,
  createTargetStatisticsService,
};
