const {
  M6_JOB_TYPES,
  parseMatchupOccurrenceKey,
} = require("../../domain/matchups/matchupJobPolicy");
const { createJobRunner } = require("../runJob");

const JOB_NAME = "matchups:occurrences:target";
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_MS = 15 * 60 * 1000;

function safeErrorCode(error) {
  const code = error?.reasonCode || error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
    ? code
    : "MATCHUP_OCCURRENCE_FAILED";
}

function createRunMatchupOccurrencesJob({
  repository,
  handlers,
  clock,
  secureRandom,
  leaseOwner,
  leaseDurationMs = DEFAULT_LEASE_MS,
  retryDelayMs = DEFAULT_RETRY_MS,
  batchSize = 25,
  logger = console,
} = {}) {
  for (const method of ["claim", "fail", "listDue", "succeed"]) {
    if (!repository || typeof repository[method] !== "function") {
      throw new TypeError("matchup occurrence runner requires a durable repository");
    }
  }
  if (!clock || typeof clock.nowMs !== "function" || !secureRandom || typeof secureRandom.id !== "function") {
    throw new TypeError("matchup occurrence runner requires a clock and secure IDs");
  }
  if (
    !handlers ||
    !M6_JOB_TYPES.every((jobType) => typeof handlers[jobType] === "function") ||
    Object.keys(handlers).some((jobType) => !M6_JOB_TYPES.includes(jobType))
  ) {
    throw new TypeError("matchup occurrence runner requires exactly the approved handlers");
  }
  if (
    typeof leaseOwner !== "string" || leaseOwner.trim() !== leaseOwner || leaseOwner.length < 1 ||
    !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 ||
    !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 ||
    !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100
  ) {
    throw new TypeError("matchup occurrence runner configuration is invalid");
  }

  return createJobRunner({
    name: JOB_NAME,
    logger,
    async execute() {
      const nowMs = clock.nowMs();
      const due = repository.listDue({ nowMs, limit: batchSize });
      const summary = { status: "succeeded", due: due.length, acquired: 0, succeeded: 0, failed: 0, skipped: 0 };
      for (const occurrence of due) {
        const leaseToken = secureRandom.id();
        const claim = repository.claim({
          leagueId: occurrence.league_id,
          seasonId: occurrence.season_id,
          jobType: occurrence.job_type,
          occurrenceKey: occurrence.occurrence_key,
          leaseOwner,
          leaseToken,
          nowMs,
          leaseExpiresAtMs: nowMs + leaseDurationMs,
        });
        if (!claim.acquired) {
          summary.skipped += 1;
          continue;
        }
        summary.acquired += 1;
        const leased = claim.occurrence;
        try {
          const scope = parseMatchupOccurrenceKey({
            jobType: leased.job_type,
            leagueId: leased.league_id,
            seasonId: leased.season_id,
            occurrenceKey: leased.occurrence_key,
            scheduledForMs: leased.scheduled_for_ms,
          });
          const result = await handlers[leased.job_type](Object.freeze({
            ...scope,
            runId: leased.id,
            leagueId: leased.league_id,
            seasonId: leased.season_id,
            occurrenceKey: leased.occurrence_key,
            scheduledForMs: leased.scheduled_for_ms,
            observedAtMs: nowMs,
          }));
          repository.succeed({
            leagueId: leased.league_id,
            runId: leased.id,
            leaseOwner,
            leaseToken,
            expectedVersion: leased.version,
            completedAtMs: clock.nowMs(),
            result,
          });
          summary.succeeded += 1;
        } catch (error) {
          const completedAtMs = clock.nowMs();
          repository.fail({
            leagueId: leased.league_id,
            runId: leased.id,
            leaseOwner,
            leaseToken,
            expectedVersion: leased.version,
            completedAtMs,
            nextAttemptAtMs: completedAtMs + retryDelayMs,
            errorCode: safeErrorCode(error),
          });
          summary.failed += 1;
          summary.status = "failed";
        }
      }
      return summary;
    },
  });
}

module.exports = {
  DEFAULT_LEASE_MS,
  DEFAULT_RETRY_MS,
  JOB_NAME,
  createRunMatchupOccurrencesJob,
  safeErrorCode,
};
