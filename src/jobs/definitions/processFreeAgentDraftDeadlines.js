const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
  buildFreeAgentDraftDeadlineOccurrenceKey,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "free-agent-drafts:deadlines:target";
const JOB_TYPE =
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE.deadline;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const BINDING_FIELDS = Object.freeze([
  "deadlineAtMs",
  "fadId",
  "resourceId",
  "resourceType",
  "type",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD deadline runner requires ${description}`
    );
  }
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `FAD deadline runner requires ${description}`
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
      `FAD deadline runner requires ${description}`
    );
  }
  return timestamp + durationMs;
}

function exactObject(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") ===
      [...fields].sort().join("|")
  );
}

function requireDeadlineDescriptor(value) {
  const binding = value?.binding;
  const parsed = value?.parsedOccurrence;
  let canonicalOccurrenceKey = null;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftDeadlineOccurrenceKey({
        fadId: value?.fadId,
        deadlineAtMs: parsed?.deadlineAtMs,
      });
  } catch {
    canonicalOccurrenceKey = null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.jobType !== JOB_TYPE ||
    !UUID_PATTERN.test(value.runId || "") ||
    !UUID_PATTERN.test(value.leagueId || "") ||
    !UUID_PATTERN.test(value.seasonId || "") ||
    !UUID_PATTERN.test(value.fadId || "") ||
    value.occurrenceKey !== canonicalOccurrenceKey ||
    !Number.isSafeInteger(value.scheduledForMs) ||
    value.scheduledForMs < 0 ||
    value.scheduledForMs !== parsed?.deadlineAtMs ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    parsed?.type !== "deadline" ||
    parsed?.fadId !== value.fadId ||
    !exactObject(binding, BINDING_FIELDS) ||
    binding.type !== "deadline" ||
    binding.resourceType !== "free_agent_draft" ||
    binding.resourceId !== value.fadId ||
    binding.fadId !== value.fadId ||
    binding.deadlineAtMs !== value.scheduledForMs
  ) {
    throw new TypeError(
      "FAD deadline runner received a noncanonical deadline descriptor"
    );
  }
  return value;
}

function requireClaimed(
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
      "FAD deadline runner received an invalid acquired claim"
    );
  }
  const claimed = requireDeadlineDescriptor(
    claim.occurrence
  );
  if (
    claimed.runId !== due.runId ||
    claimed.leagueId !== due.leagueId ||
    claimed.seasonId !== due.seasonId ||
    claimed.fadId !== due.fadId ||
    claimed.occurrenceKey !== due.occurrenceKey ||
    claimed.scheduledForMs !== due.scheduledForMs ||
    claimed.version !== due.version + 1 ||
    claimed.status !== "running" ||
    claimed.attemptCount !== due.attemptCount + 1 ||
    claimed.leaseExpiresAtMs !== leaseExpiresAtMs ||
    !Number.isSafeInteger(claimed.startedAtMs) ||
    claimed.startedAtMs < claimed.scheduledForMs ||
    !isDeepStrictEqual(claimed.binding, due.binding)
  ) {
    throw new TypeError(
      "FAD deadline runner received a mismatched acquired claim"
    );
  }
  return claimed;
}

function requireTerminal(result, claimed) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.outcome !== "succeeded" ||
    result.runId !== claimed.runId
  ) {
    throw new TypeError(
      "FAD deadline runner requires a durable terminal result"
    );
  }
  return result;
}

function createProcessFreeAgentDraftDeadlinesJob({
  repository,
  deadlineService,
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
    deadlineService,
    "executeClaimedDeadline",
    "the claimed deadline service"
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
      "FAD deadline runner configuration is invalid"
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
          "FAD deadline runner requires a due-occurrence array"
        );
      }
      const deadlineDue = due.filter(
        ({ jobType } = {}) => jobType === JOB_TYPE
      );
      deadlineDue.forEach(requireDeadlineDescriptor);
      const summary = {
        status: "succeeded",
        due: deadlineDue.length,
        acquired: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      };

      for (const occurrence of deadlineDue) {
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
            fadId: occurrence.fadId,
            runId: occurrence.runId,
            jobType: JOB_TYPE,
            occurrenceKey: occurrence.occurrenceKey,
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
          const claimed = requireClaimed(
            claim,
            occurrence,
            leaseExpiresAtMs
          );
          requireTerminal(
            await deadlineService.executeClaimedDeadline({
              leagueId: claimed.leagueId,
              seasonId: claimed.seasonId,
              fadId: claimed.fadId,
              deadlineAtMs:
                claimed.binding.deadlineAtMs,
              occurrenceKey: claimed.occurrenceKey,
              scheduledForMs: claimed.scheduledForMs,
              jobExecution: {
                runId: claimed.runId,
                leaseOwner,
                leaseToken,
                leaseExpiresAtMs:
                  claimed.leaseExpiresAtMs,
                startedAtMs: claimed.startedAtMs,
                attemptCount: claimed.attemptCount,
                expectedVersion: claimed.version,
              },
            }),
            claimed
          );
          summary.succeeded += 1;
        } catch {
          summary.failed += 1;
          summary.status = "failed";
          logger.error(
            "free_agent_draft.deadline_occurrence_failed",
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
  FREE_AGENT_DRAFT_DEADLINE_JOB_TYPE: JOB_TYPE,
  JOB_NAME,
  createProcessFreeAgentDraftDeadlinesJob,
};
