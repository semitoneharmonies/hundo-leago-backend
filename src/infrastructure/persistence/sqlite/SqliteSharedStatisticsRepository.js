const { createHash } = require("node:crypto");
const { buildSharedLiveCapture } = require("../../../domain/statistics/sharedLiveCapturePolicy");
const { createSqliteStatisticsRepository } = require("./SqliteStatisticsRepository");
const { createSqliteSharedGameEvidenceRepository } = require("./SqliteSharedGameEvidenceRepository");
const { createCompactStatisticsStorage } = require("./compactStatisticsEvidence");

// Runtime selects compact mode only behind the explicit efficiency flag. The
// default dual writer remains available for compatibility comparisons in tests.
function createSqliteSharedStatisticsRepository(options) {
  const { database } = options;
  const compact = options.compact === true ? createCompactStatisticsStorage(options) : null;
  const legacy = createSqliteStatisticsRepository({ ...options, liveEvidenceStorage: compact });
  const shared = createSqliteSharedGameEvidenceRepository(options);
  const preparations = new WeakMap();
  const fingerprint = command => createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const complete = database.transaction((command, plan) => {
    // Both repositories use this exact connection. A failed mapping, lease,
    // coverage check or legacy write rolls back the shared capture as well.
    shared.commit(plan.shared);
    return legacy.completeLiveRefresh(command);
  });
  return Object.freeze({
    ...legacy,
    async prepareLiveRefresh(command) {
      const commandSha256 = fingerprint(command);
      const capture = buildSharedLiveCapture(command);
      const prepared = await shared.prepare(capture);
      if (compact) await compact.prepare(command);
      const token = Object.freeze({});
      preparations.set(token, { commandSha256, shared: prepared });
      return token;
    },
    completeLiveRefresh(command, token) {
      const plan = preparations.get(token);
      if (!plan || plan.commandSha256 !== fingerprint(command)) throw new TypeError("An unchanged prepared statistics capture is required.");
      try {
        const result = complete.immediate(command, plan);
        // Warming a derived read cache must not change the outcome of an
        // already committed capture. A cold reader independently verifies it.
        try { compact?.prime(command.refreshId); } catch {}
        return result;
      }
      finally { compact?.release(command.refreshId); preparations.delete(token); }
    },
  });
}

module.exports = { createSqliteSharedStatisticsRepository };
