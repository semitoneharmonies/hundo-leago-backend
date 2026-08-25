const {
  buildAuctionResolutionOccurrenceKey,
} = require("../../domain/auctions/auctionResolutionPolicy");
const { createJobRunner } = require("../runJob");

const JOB_NAME = "auctions:resolve:target";
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const COMPLETED_STATUSES = new Set([
  "resolved",
  "no_winner",
  "cancelled",
]);

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`target auction resolution job requires ${description}`);
  }
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      "target auction resolution job requires a safe UTC timestamp"
    );
  }
  return value;
}

function safeErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
    ? code
    : "AUCTION_RESOLUTION_FAILED";
}

function createResolveTargetAuctionsJob({
  repository,
  resolutionService,
  clock,
  secureRandom,
  leaseOwner,
  leaseDurationMs = DEFAULT_LEASE_MS,
  batchSize = 25,
  logger = console,
} = {}) {
  for (const method of ["claimRun", "failRun", "listDue", "succeedRun"]) {
    assertMethod(repository, method, "a durable resolution repository");
  }
  assertMethod(
    resolutionService,
    "resolveDue",
    "an atomic resolution completion service"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");
  if (
    typeof leaseOwner !== "string" ||
    leaseOwner.length < 1 ||
    leaseOwner.length > 128 ||
    leaseOwner.trim() !== leaseOwner
  ) {
    throw new TypeError("target auction resolution job requires a lease owner");
  }
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100
  ) {
    throw new TypeError("target auction resolution job configuration is invalid");
  }

  return createJobRunner({
    name: JOB_NAME,
    logger,
    async execute() {
      const nowMs = safeTimestamp(clock.nowMs());
      const due = repository.listDue({ nowMs, limit: batchSize });
      let acquired = 0;
      let completed = 0;
      let failed = 0;
      let skipped = 0;

      for (const auction of due) {
        const occurrenceKey = buildAuctionResolutionOccurrenceKey({
          auctionId: auction.auctionId,
          dueAtMs: auction.dueAtMs,
        });
        const claim = repository.claimRun({
          jobRunId: secureRandom.id(),
          leagueId: auction.leagueId,
          seasonId: auction.seasonId,
          occurrenceKey,
          scheduledForMs: auction.dueAtMs,
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
          const result = await resolutionService.resolveDue({
            leagueId: auction.leagueId,
            auctionId: auction.auctionId,
            occurrenceKey,
            expectedAuctionVersion: auction.auctionVersion,
            nowMs,
          });
          if (
            !result ||
            result.completed !== true ||
            !COMPLETED_STATUSES.has(result.status)
          ) {
            const error = new Error(
              "The atomic auction resolution did not confirm completion."
            );
            error.code = "AUCTION_RESOLUTION_INCOMPLETE";
            throw error;
          }
          repository.succeedRun({
            leagueId: auction.leagueId,
            runId: claim.runId,
            leaseOwner,
            expectedVersion: claim.version,
            completedAtMs: safeTimestamp(clock.nowMs()),
            auctionId: auction.auctionId,
            outcome: result.status,
          });
          completed += 1;
        } catch (error) {
          repository.failRun({
            leagueId: auction.leagueId,
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
        completed,
        failed,
        skipped,
      };
    },
  });
}

module.exports = {
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createResolveTargetAuctionsJob,
  safeErrorCode,
};
