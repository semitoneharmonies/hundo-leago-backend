const {
  EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
} = require(
  "../../domain/leagues/leagueLifecycleTransitionPolicy"
);
const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
  buildSeasonRolloverOccurrenceKey,
} = require(
  "../../domain/leagues/seasonRolloverJobPolicy"
);
const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "leagues:entry-draft-rollover:target";
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_MS = 15 * 60 * 1000;

function requireMethod(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `scheduled season rollover requires ${description}`
    );
  }
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `scheduled season rollover requires ${description}`
    );
  }
  return value;
}

function safeFutureTimestamp(
  timestamp,
  durationMs,
  description
) {
  if (
    timestamp >
    Number.MAX_SAFE_INTEGER - durationMs
  ) {
    throw new TypeError(
      `scheduled season rollover requires ${description}`
    );
  }
  return timestamp + durationMs;
}

function safeErrorCode(error) {
  const code = error?.reasonCode || error?.code;
  return (
    typeof code === "string" &&
    /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
  )
    ? code
    : "SEASON_ROLLOVER_JOB_FAILED";
}

function createExecuteScheduledEntryDraftRolloversJob({
  repository,
  leagueLifecycleTransitionService,
  clock,
  secureRandom,
  leaseOwner,
  leaseDurationMs = DEFAULT_LEASE_MS,
  retryDelayMs = DEFAULT_RETRY_MS,
  batchSize = 25,
  logger = console,
} = {}) {
  for (const method of [
    "claimRun",
    "failRun",
    "listDueRolloverBindings",
    "succeedRun",
  ]) {
    requireMethod(
      repository,
      method,
      `a durable repository with ${method}`
    );
  }
  requireMethod(
    leagueLifecycleTransitionService,
    "executeScheduledEntryDraftRollover",
    "the internal lifecycle-transition service"
  );
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );
  if (
    typeof leaseOwner !== "string" ||
    leaseOwner.length < 1 ||
    leaseOwner.length > 128 ||
    leaseOwner.trim() !== leaseOwner ||
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < 1 ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100
  ) {
    throw new TypeError(
      "scheduled season rollover configuration is invalid"
    );
  }

  return createJobRunner({
    name: JOB_NAME,
    logger,
    async execute() {
      const nowMs = safeTimestamp(
        clock.nowMs(),
        "a safe current timestamp"
      );
      const due =
        repository.listDueRolloverBindings({
          nowMs,
          limit: batchSize,
        });
      if (!Array.isArray(due)) {
        throw new TypeError(
          "scheduled season rollover requires a due-binding array"
        );
      }
      const summary = {
        status: "succeeded",
        due: due.length,
        acquired: 0,
        succeeded: 0,
        blocked: 0,
        failed: 0,
        skipped: 0,
      };

      for (const binding of due) {
        const occurrenceKey =
          buildSeasonRolloverOccurrenceKey({
            leagueId: binding.leagueId,
            entryDraftId:
              binding.entryDraftId,
            rolloverOccurrenceId:
              binding.rolloverOccurrenceId,
            scheduledForMs:
              binding.scheduledForMs,
          });
        if (
          binding.occurrenceKey !== occurrenceKey
        ) {
          throw new TypeError(
            "scheduled season rollover binding has a noncanonical occurrence key"
          );
        }
        const leaseToken = secureRandom.id();
        const claim = repository.claimRun({
          leagueId: binding.leagueId,
          seasonId: binding.toSeasonId,
          jobType:
            ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
          occurrenceKey,
          scheduledForMs:
            binding.scheduledForMs,
          leaseOwner,
          leaseToken,
          nowMs,
          leaseExpiresAtMs:
            safeFutureTimestamp(
              nowMs,
              leaseDurationMs,
              "a safe lease-expiry timestamp"
            ),
        });
        if (!claim?.acquired) {
          summary.skipped += 1;
          continue;
        }
        summary.acquired += 1;

        try {
          const result =
            await leagueLifecycleTransitionService
              .executeScheduledEntryDraftRollover({
                leagueId:
                  binding.leagueId,
                input: {
                  transitionType:
                    EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
                  entryDraftId:
                    binding.entryDraftId,
                  rolloverOccurrenceId:
                    binding.rolloverOccurrenceId,
                },
                scheduledJob: {
                  runId: claim.runId,
                  occurrenceKey,
                  scheduledForMs:
                    binding.scheduledForMs,
                  leaseOwner,
                  leaseToken,
                  expectedVersion:
                    claim.version,
                },
              });
          if (
            !result ||
            !["blocked", "succeeded"].includes(
              result.status
            )
          ) {
            throw new TypeError(
              "scheduled season rollover requires a durable terminal attempt"
            );
          }
          const blocked =
            result.status === "blocked";
          repository.succeedRun({
            leagueId: binding.leagueId,
            runId: claim.runId,
            leaseOwner,
            leaseToken,
            expectedVersion: claim.version,
            completedAtMs: safeTimestamp(
              clock.nowMs(),
              "a safe completion timestamp"
            ),
            outcome: blocked
              ? "blocked"
              : "succeeded",
            rolloverId:
              result?.rolloverId ?? null,
          });
          if (blocked) {
            summary.blocked += 1;
          } else {
            summary.succeeded += 1;
          }
        } catch (error) {
          const completedAtMs = safeTimestamp(
            clock.nowMs(),
            "a safe completion timestamp"
          );
          repository.failRun({
            leagueId: binding.leagueId,
            runId: claim.runId,
            leaseOwner,
            leaseToken,
            expectedVersion: claim.version,
            completedAtMs,
            nextAttemptAtMs:
              safeFutureTimestamp(
                completedAtMs,
                retryDelayMs,
                "a safe retry timestamp"
              ),
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
  createExecuteScheduledEntryDraftRolloversJob,
  safeErrorCode,
};
