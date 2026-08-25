const {
  buildTradeExpiryOccurrenceKey,
} = require("../../domain/trades/tradeLifecyclePolicy");
const { createJobRunner } = require("../runJob");

const JOB_NAME = "trades:expire:target";
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`target trade expiry requires ${description}`);
  }
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("target trade expiry requires a safe UTC timestamp");
  }
  return value;
}

function safeErrorCode(error) {
  const code = error?.reasonCode || error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
    ? code
    : "TRADE_EXPIRY_FAILED";
}

function createExpireTradeProposalsJob({
  repository,
  clock,
  secureRandom,
  leaseOwner,
  leaseDurationMs = DEFAULT_LEASE_MS,
  batchSize = 25,
  logger = console,
} = {}) {
  for (const method of [
    "claimRun",
    "expireProposal",
    "failRun",
    "listDue",
    "succeedRun",
  ]) {
    assertMethod(repository, method, "a durable trade-expiry repository");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");
  if (
    typeof leaseOwner !== "string" ||
    leaseOwner.length < 1 ||
    leaseOwner.length > 128 ||
    leaseOwner.trim() !== leaseOwner
  ) {
    throw new TypeError("target trade expiry requires a lease owner");
  }
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100
  ) {
    throw new TypeError("target trade expiry configuration is invalid");
  }

  return createJobRunner({
    name: JOB_NAME,
    logger,
    async execute() {
      const nowMs = safeTimestamp(clock.nowMs());
      const due = repository.listDue({ nowMs, limit: batchSize });
      let acquired = 0;
      let expired = 0;
      let terminal = 0;
      let failed = 0;
      let skipped = 0;

      for (const proposal of due) {
        const occurrenceKey = buildTradeExpiryOccurrenceKey({
          tradeId: proposal.tradeId,
          effectiveDeadlineAtMs: proposal.effectiveDeadlineAtMs,
        });
        const claim = repository.claimRun({
          jobRunId: secureRandom.id(),
          leagueId: proposal.leagueId,
          seasonId: proposal.seasonId,
          occurrenceKey,
          scheduledForMs: proposal.effectiveDeadlineAtMs,
          leaseOwner,
          nowMs,
          leaseExpiresAtMs: nowMs + leaseDurationMs,
        });
        if (!claim.acquired) {
          skipped += 1;
          continue;
        }
        acquired += 1;
        try {
          const result = repository.expireProposal({
            tradeId: proposal.tradeId,
            eventId: secureRandom.id(),
            leagueId: proposal.leagueId,
            seasonId: proposal.seasonId,
            expectedVersion: proposal.tradeVersion,
            effectiveDeadlineAtMs: proposal.effectiveDeadlineAtMs,
            occurredAtMs: nowMs,
            occurrenceKey,
          });
          const outcome = result.completed ? "expired" : "terminal";
          if (result.completed) expired += 1;
          else terminal += 1;
          repository.succeedRun({
            leagueId: proposal.leagueId,
            runId: claim.runId,
            leaseOwner,
            expectedVersion: claim.version,
            completedAtMs: safeTimestamp(clock.nowMs()),
            tradeId: proposal.tradeId,
            outcome,
          });
        } catch (error) {
          repository.failRun({
            leagueId: proposal.leagueId,
            runId: claim.runId,
            leaseOwner,
            expectedVersion: claim.version,
            completedAtMs: safeTimestamp(clock.nowMs()),
            errorCode: safeErrorCode(error),
          });
          failed += 1;
        }
      }

      return {
        status: failed > 0 ? "failed" : "succeeded",
        due: due.length,
        acquired,
        expired,
        terminal,
        failed,
        skipped,
      };
    },
  });
}

module.exports = {
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createExpireTradeProposalsJob,
  safeErrorCode,
};
