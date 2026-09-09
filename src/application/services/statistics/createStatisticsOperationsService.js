function operationError(code) {
  return Object.assign(new Error(code), { code });
}

function createStatisticsOperationsService({ platformAuthorization, statisticsService, repository, enabled = false, afterRefresh = async () => {} } = {}) {
  if (!platformAuthorization?.requireAdministrator || !statisticsService?.refresh || !repository?.readRefresh || typeof enabled !== "boolean" || typeof afterRefresh !== "function") {
    throw new TypeError("Statistics operations require authorization, statistics and durable refresh records.");
  }
  let running = false;
  return Object.freeze({
    async refresh({ authenticated, input } = {}) {
      platformAuthorization.requireAdministrator(authenticated);
      if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw operationError("STATISTICS_OPERATION_INVALID");
      if (!enabled) throw operationError("STATISTICS_OPERATION_DISABLED");
      if (running) throw operationError("STATISTICS_OPERATION_IN_PROGRESS");
      running = true;
      try {
        const result = await statisticsService.refresh({ authorizePersist: () => platformAuthorization.requireAdministrator(authenticated) });
        let lateLocks;
        try { lateLocks = await afterRefresh(); }
        catch { lateLocks = { status: "awaiting_data" }; }
        return Object.freeze({ jobId: result.refreshId, status: result.status, playerCount: result.playerCount, capturedAtMs: result.capturedAtMs, ...(lateLocks === undefined ? {} : { lateLocks }) });
      } finally {
        running = false;
      }
    },
    read({ authenticated, jobId } = {}) {
      platformAuthorization.requireAdministrator(authenticated);
      if (typeof jobId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(jobId)) throw operationError("STATISTICS_OPERATION_INVALID");
      const row = repository.readRefresh(jobId);
      if (!row) throw operationError("STATISTICS_OPERATION_NOT_FOUND");
      return Object.freeze({ jobId: row.id, status: row.status, nhlSeasonKey: row.nhl_season_key, playerCount: row.player_count, startedAtMs: row.started_at_ms, completedAtMs: row.completed_at_ms });
    },
  });
}

module.exports = { createStatisticsOperationsService };
