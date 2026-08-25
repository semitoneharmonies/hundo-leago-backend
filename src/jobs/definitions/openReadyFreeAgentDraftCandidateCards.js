const {
  FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  buildFreeAgentDraftReadinessOccurrenceKey,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "free-agent-drafts:readiness:target";
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function requireMethod(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD readiness runner requires ${description}`
    );
  }
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `FAD readiness runner requires ${description}`
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
      `FAD readiness runner requires ${description}`
    );
  }
  return timestamp + durationMs;
}

function requireReadinessDescriptor(value) {
  let canonicalOccurrenceKey = null;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: value?.leagueId,
        seasonId: value?.seasonId,
        triggerResourceId:
          value?.parsedOccurrence
            ?.triggerResourceId,
      });
  } catch {
    canonicalOccurrenceKey = null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.jobType !==
      FREE_AGENT_DRAFT_READINESS_JOB_TYPE ||
    value.fadId !== null ||
    value.parsedOccurrence?.type !==
      "readiness" ||
    value.parsedOccurrence.leagueId !==
      value.leagueId ||
    value.parsedOccurrence.seasonId !==
      value.seasonId ||
    value.occurrenceKey !==
      canonicalOccurrenceKey ||
    value.binding?.type !== "readiness" ||
    value.binding.resourceType !==
      "readiness_operation" ||
    value.binding.fadId !== null ||
    value.binding.triggerResourceId !==
      value.parsedOccurrence.triggerResourceId ||
    typeof value.binding.resourceId !== "string" ||
    value.binding.resourceId.length < 1 ||
    typeof value.runId !== "string" ||
    value.runId.length < 1 ||
    typeof value.leagueId !== "string" ||
    value.leagueId.length < 1 ||
    typeof value.seasonId !== "string" ||
    value.seasonId.length < 1 ||
    typeof value.occurrenceKey !== "string" ||
    value.occurrenceKey.length < 1 ||
    !Number.isSafeInteger(value.scheduledForMs) ||
    value.scheduledForMs < 0 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    throw new TypeError(
      "FAD readiness runner received a noncanonical readiness descriptor"
    );
  }
  return value;
}

function requireClaimedReadiness(
  claim,
  due,
  leaseExpiresAtMs
) {
  if (
    !claim ||
    claim.acquired !== true ||
    !claim.occurrence
  ) {
    throw new TypeError(
      "FAD readiness runner received an invalid acquired claim"
    );
  }
  const claimed = requireReadinessDescriptor(
    claim.occurrence
  );
  if (
    claimed.runId !== due.runId ||
    claimed.leagueId !== due.leagueId ||
    claimed.seasonId !== due.seasonId ||
    claimed.occurrenceKey !== due.occurrenceKey ||
    claimed.scheduledForMs !== due.scheduledForMs ||
    claimed.version !== due.version + 1 ||
    claimed.binding.resourceId !==
      due.binding.resourceId ||
    claimed.status !== "running" ||
    claimed.leaseExpiresAtMs !==
      leaseExpiresAtMs
  ) {
    throw new TypeError(
      "FAD readiness runner received a mismatched acquired claim"
    );
  }
  return claimed;
}

function requireTerminalResult(
  result,
  readinessOperationId
) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !["blocked", "succeeded"].includes(
      result.outcome
    ) ||
    result.readinessOperationId !==
      readinessOperationId
  ) {
    throw new TypeError(
      "FAD readiness runner requires a durable terminal result"
    );
  }
  return result;
}

function createOpenReadyFreeAgentDraftCandidateCardsJob({
  repository,
  readinessService,
  clock,
  secureRandom,
  leaseOwner,
  leaseDurationMs = DEFAULT_LEASE_MS,
  batchSize = 25,
  logger = console,
} = {}) {
  requireMethod(
    repository,
    "listDue",
    "a durable repository with listDue"
  );
  requireMethod(
    repository,
    "claim",
    "a durable repository with claim"
  );
  requireMethod(
    readinessService,
    "executeClaimedReadiness",
    "the claimed-readiness service"
  );
  requireMethod(clock, "nowMs", "a UTC clock");
  requireMethod(
    secureRandom,
    "id",
    "secure lease identifiers"
  );
  requireMethod(logger, "error", "an error logger");
  if (
    typeof leaseOwner !== "string" ||
    leaseOwner.length < 1 ||
    leaseOwner.length > 128 ||
    leaseOwner.trim() !== leaseOwner ||
    CONTROL_PATTERN.test(leaseOwner) ||
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100
  ) {
    throw new TypeError(
      "FAD readiness runner configuration is invalid"
    );
  }

  return createJobRunner({
    name: JOB_NAME,
    logger: Object.freeze({
      error(eventName) {
        logger.error(eventName, {
          job: JOB_NAME,
          classification: "transient",
        });
      },
    }),
    async execute() {
      const listedAtMs = safeTimestamp(
        clock.nowMs(),
        "a safe due-query timestamp"
      );
      const due = repository.listDue({
        nowMs: listedAtMs,
        limit: batchSize,
      });
      if (!Array.isArray(due)) {
        throw new TypeError(
          "FAD readiness runner requires a due-occurrence array"
        );
      }
      const readinessDue = due.filter(
        ({ jobType } = {}) =>
          jobType ===
          FREE_AGENT_DRAFT_READINESS_JOB_TYPE
      );
      readinessDue.forEach(
        requireReadinessDescriptor
      );
      const summary = {
        status: "succeeded",
        due: readinessDue.length,
        acquired: 0,
        succeeded: 0,
        blocked: 0,
        failed: 0,
        skipped: 0,
      };

      for (const occurrence of readinessDue) {
        try {
          const claimAtMs = safeTimestamp(
            clock.nowMs(),
            "a safe claim timestamp"
          );
          const leaseExpiresAtMs =
            safeFutureTimestamp(
              claimAtMs,
              leaseDurationMs,
              "a safe lease-expiry timestamp"
            );
          const leaseToken = secureRandom.id();
          const claim = repository.claim({
            leagueId: occurrence.leagueId,
            seasonId: occurrence.seasonId,
            fadId: null,
            runId: occurrence.runId,
            jobType:
              FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
            occurrenceKey:
              occurrence.occurrenceKey,
            scheduledForMs:
              occurrence.scheduledForMs,
            expectedVersion: occurrence.version,
            leaseOwner,
            leaseToken,
            nowMs: claimAtMs,
            leaseExpiresAtMs,
          });
          if (claim?.acquired === false) {
            summary.skipped += 1;
            continue;
          }
          if (claim?.acquired === true) {
            summary.acquired += 1;
          }
          const claimed = requireClaimedReadiness(
            claim,
            occurrence,
            leaseExpiresAtMs
          );
          const terminal = requireTerminalResult(
            await readinessService
              .executeClaimedReadiness({
                leagueId: claimed.leagueId,
                seasonId: claimed.seasonId,
                occurrenceKey:
                  claimed.occurrenceKey,
                readinessOperationId:
                  claimed.binding.resourceId,
                jobExecution: {
                  runId: claimed.runId,
                  leaseOwner,
                  leaseToken,
                  leaseExpiresAtMs:
                    claimed.leaseExpiresAtMs,
                  expectedVersion:
                    claimed.version,
                },
              }),
            claimed.binding.resourceId
          );
          if (terminal.outcome === "blocked") {
            summary.blocked += 1;
          } else {
            summary.succeeded += 1;
          }
        } catch {
          summary.failed += 1;
          summary.status = "failed";
          logger.error(
            "free_agent_draft.readiness_occurrence_failed",
            {
              job: JOB_NAME,
              runId: occurrence.runId,
              fadId: occurrence.fadId,
              classification: "transient",
            }
          );
        }
      }
      return summary;
    },
  });
}

module.exports = {
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createOpenReadyFreeAgentDraftCandidateCardsJob,
};
