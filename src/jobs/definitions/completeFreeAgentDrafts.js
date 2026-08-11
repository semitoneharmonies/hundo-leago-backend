"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
  buildFreeAgentDraftCompletionOccurrenceKey,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS,
  classifyFreeAgentDraftCompletionFailure,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftCompletionFailurePolicy"
);
const {
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "free-agent-drafts:completion:target";
const JOB_TYPE =
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE.complete;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const CANDIDATE_FIELDS = Object.freeze([
  "attemptCount",
  "fadId",
  "initialWindowEndsAtMs",
  "jobType",
  "leagueId",
  "leaseExpiresAtMs",
  "nextAttemptAtMs",
  "occurrenceKey",
  "runId",
  "scheduledForMs",
  "seasonId",
  "status",
  "version",
]);
const BINDING_FIELDS = Object.freeze([
  "fadId",
  "initialWindowEndsAtMs",
  "resourceId",
  "resourceType",
  "type",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const FAILURE_RESULT_FIELDS = Object.freeze([
  "errorCode",
  "failedAtMs",
  "jobVersion",
  "recorded",
  "recoveryId",
  "recoveryVersion",
  "replayed",
  "runId",
]);

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD completion runner requires ${description}`
    );
  }
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `FAD completion runner requires ${description}`
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
      `FAD completion runner requires ${description}`
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

function canonicalOccurrence(value) {
  try {
    return buildFreeAgentDraftCompletionOccurrenceKey({
      fadId: value?.fadId,
    });
  } catch {
    return null;
  }
}

function requireCandidate(value, nowMs) {
  if (
    !exactObject(value, CANDIDATE_FIELDS) ||
    value.jobType !== JOB_TYPE ||
    !UUID_PATTERN.test(value.runId || "") ||
    !UUID_PATTERN.test(value.leagueId || "") ||
    !UUID_PATTERN.test(value.seasonId || "") ||
    !UUID_PATTERN.test(value.fadId || "") ||
    value.occurrenceKey !==
      canonicalOccurrence(value) ||
    !Number.isSafeInteger(value.scheduledForMs) ||
    value.scheduledForMs < 0 ||
    value.initialWindowEndsAtMs !==
      value.scheduledForMs ||
    value.scheduledForMs > nowMs ||
    !["pending", "failed", "leased", "running"].includes(
      value.status
    ) ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    (
      value.nextAttemptAtMs !== null &&
      (
        !Number.isSafeInteger(value.nextAttemptAtMs) ||
        value.nextAttemptAtMs < 0
      )
    ) ||
    (
      value.status === "failed" &&
      (
        !Number.isSafeInteger(value.nextAttemptAtMs) ||
        value.nextAttemptAtMs > nowMs
      )
    ) ||
    (
      value.leaseExpiresAtMs !== null &&
      (
        !Number.isSafeInteger(
          value.leaseExpiresAtMs
        ) ||
        value.leaseExpiresAtMs < 0
      )
    )
  ) {
    throw new TypeError(
      "FAD completion runner received a noncanonical completion candidate"
    );
  }
  return value;
}

function requireCompletionDescriptor(value) {
  const binding = value?.binding;
  const parsed = value?.parsedOccurrence;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.jobType !== JOB_TYPE ||
    !UUID_PATTERN.test(value.runId || "") ||
    !UUID_PATTERN.test(value.leagueId || "") ||
    !UUID_PATTERN.test(value.seasonId || "") ||
    !UUID_PATTERN.test(value.fadId || "") ||
    value.occurrenceKey !==
      canonicalOccurrence(value) ||
    !Number.isSafeInteger(value.scheduledForMs) ||
    value.scheduledForMs < 0 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    parsed?.type !== "complete" ||
    parsed?.fadId !== value.fadId ||
    !exactObject(binding, BINDING_FIELDS) ||
    binding.type !== "complete" ||
    binding.resourceType !== "free_agent_draft" ||
    binding.resourceId !== value.fadId ||
    binding.fadId !== value.fadId ||
    binding.initialWindowEndsAtMs !==
      value.scheduledForMs
  ) {
    throw new TypeError(
      "FAD completion runner received a noncanonical completion descriptor"
    );
  }
  return value;
}

function requireClaimed(
  claim,
  candidate,
  leaseExpiresAtMs
) {
  if (
    !claim ||
    claim.acquired !== true ||
    !claim.occurrence
  ) {
    throw new TypeError(
      "FAD completion runner received an invalid acquired claim"
    );
  }
  const claimed = requireCompletionDescriptor(
    claim.occurrence
  );
  if (
    claimed.runId !== candidate.runId ||
    claimed.leagueId !== candidate.leagueId ||
    claimed.seasonId !== candidate.seasonId ||
    claimed.fadId !== candidate.fadId ||
    claimed.occurrenceKey !==
      candidate.occurrenceKey ||
    claimed.scheduledForMs !==
      candidate.scheduledForMs ||
    claimed.version !== candidate.version + 1 ||
    claimed.status !== "running" ||
    claimed.attemptCount !==
      candidate.attemptCount + 1 ||
    claimed.leaseExpiresAtMs !==
      leaseExpiresAtMs ||
    !Number.isSafeInteger(claimed.startedAtMs) ||
    claimed.startedAtMs <
      claimed.scheduledForMs ||
    !isDeepStrictEqual(
      claimed.binding,
      {
        type: "complete",
        resourceType: "free_agent_draft",
        resourceId: candidate.fadId,
        fadId: candidate.fadId,
        initialWindowEndsAtMs:
          candidate.initialWindowEndsAtMs,
      }
    )
  ) {
    throw new TypeError(
      "FAD completion runner received a mismatched acquired claim"
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
      "FAD completion runner requires a durable terminal result"
    );
  }
  return result;
}

function executionFor(claimed, leaseOwner, leaseToken) {
  return Object.freeze({
    leagueId: claimed.leagueId,
    seasonId: claimed.seasonId,
    fadId: claimed.fadId,
    initialWindowEndsAtMs:
      claimed.binding.initialWindowEndsAtMs,
    occurrenceKey: claimed.occurrenceKey,
    scheduledForMs: claimed.scheduledForMs,
    jobExecution: Object.freeze({
      runId: claimed.runId,
      leaseOwner,
      leaseToken,
      leaseExpiresAtMs: claimed.leaseExpiresAtMs,
      startedAtMs: claimed.startedAtMs,
      attemptCount: claimed.attemptCount,
      expectedVersion: claimed.version,
    }),
  });
}

function requireFailureResult(
  result,
  claimed,
  errorCode
) {
  if (
    !exactObject(result, FAILURE_RESULT_FIELDS) ||
    result.recorded !== true ||
    typeof result.replayed !== "boolean" ||
    result.runId !== claimed.runId ||
    result.errorCode !== errorCode ||
    !Number.isSafeInteger(result.failedAtMs) ||
    result.failedAtMs < claimed.startedAtMs ||
    result.failedAtMs >= claimed.leaseExpiresAtMs ||
    result.jobVersion !== claimed.version + 1 ||
    !UUID_PATTERN.test(result.recoveryId || "") ||
    !Number.isSafeInteger(result.recoveryVersion) ||
    result.recoveryVersion < 1
  ) {
    throw new TypeError(
      "FAD completion runner requires a durable recorded failure"
    );
  }
  return result;
}

function safeIdentifier(value) {
  return UUID_PATTERN.test(value || "") ? value : null;
}

function safeLog(
  logger,
  occurrence,
  classification,
  failureRecorded
) {
  try {
    logger.error(
      "free_agent_draft.completion_occurrence_failed",
      Object.freeze({
        job: JOB_NAME,
        leagueId: safeIdentifier(occurrence?.leagueId),
        seasonId: safeIdentifier(occurrence?.seasonId),
        fadId: safeIdentifier(occurrence?.fadId),
        runId: safeIdentifier(occurrence?.runId),
        classification,
        failureRecorded,
      })
    );
  } catch {
    // Logging cannot change durable failure or retry classification.
  }
}

function createCompleteFreeAgentDraftsJob({
  writer,
  repository,
  completionService,
  clock,
  secureRandom,
  leaseOwner,
  leaseDurationMs = DEFAULT_LEASE_MS,
  batchSize = 25,
  logger = console,
} = {}) {
  requireMethod(
    writer,
    "listCandidates",
    "an eligibility writer with listCandidates"
  );
  requireMethod(
    repository,
    "claim",
    "a durable repository with claim"
  );
  requireMethod(
    completionService,
    "executeClaimedCompletion",
    "the claimed completion service"
  );
  requireMethod(
    completionService,
    "recordClaimedFailure",
    "the claimed completion failure service"
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
      "FAD completion runner configuration is invalid"
    );
  }

  const runnerLogger = Object.freeze({
    error() {
      safeLog(
        logger,
        null,
        "transient_execution",
        false
      );
    },
  });

  return createJobRunner({
    name: JOB_NAME,
    logger: runnerLogger,
    async execute() {
      const listedAtMs = safeTimestamp(
        clock.nowMs(),
        "a safe candidate-query timestamp"
      );
      const candidates = writer.listCandidates({
        nowMs: listedAtMs,
        limit: batchSize,
      });
      if (!Array.isArray(candidates)) {
        throw new TypeError(
          "FAD completion runner requires a candidate array"
        );
      }
      candidates.forEach((candidate) =>
        requireCandidate(candidate, listedAtMs)
      );
      const summary = {
        status: "succeeded",
        due: candidates.length,
        acquired: 0,
        succeeded: 0,
        failed: 0,
        terminalFailed: 0,
        transientFailed: 0,
        skipped: 0,
      };

      for (const candidate of candidates) {
        let claimed;
        let leaseToken;
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
          leaseToken = secureRandom.id();
          const claim = repository.claim({
            leagueId: candidate.leagueId,
            seasonId: candidate.seasonId,
            fadId: candidate.fadId,
            runId: candidate.runId,
            jobType: JOB_TYPE,
            occurrenceKey: candidate.occurrenceKey,
            scheduledForMs:
              candidate.scheduledForMs,
            expectedVersion: candidate.version,
            leaseOwner,
            leaseToken,
            nowMs: claimAtMs,
            leaseExpiresAtMs,
          });
          if (claim?.acquired === false) {
            summary.skipped += 1;
            continue;
          }
          claimed = requireClaimed(
            claim,
            candidate,
            leaseExpiresAtMs
          );
          summary.acquired += 1;
        } catch {
          summary.failed += 1;
          summary.transientFailed += 1;
          summary.status = "failed";
          safeLog(
            logger,
            candidate,
            "transient_claim",
            false
          );
          continue;
        }

        const execution = executionFor(
          claimed,
          leaseOwner,
          leaseToken
        );
        try {
          requireTerminal(
            await completionService
              .executeClaimedCompletion(execution),
            claimed
          );
          summary.succeeded += 1;
        } catch (error) {
          const failure =
            classifyFreeAgentDraftCompletionFailure(error);
          if (
            failure.classification ===
            FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS
              .transient
          ) {
            summary.failed += 1;
            summary.transientFailed += 1;
            summary.status = "failed";
            safeLog(
              logger,
              claimed,
              "transient_execution",
              false
            );
            continue;
          }

          try {
            requireFailureResult(
              await completionService.recordClaimedFailure({
                ...execution,
                errorCode: failure.errorCode,
              }),
              claimed,
              failure.errorCode
            );
            summary.failed += 1;
            summary.terminalFailed += 1;
            summary.status = "failed";
            safeLog(
              logger,
              claimed,
              "terminal_recorded",
              true
            );
          } catch {
            summary.failed += 1;
            summary.transientFailed += 1;
            summary.status = "failed";
            safeLog(
              logger,
              claimed,
              "terminal_recording_transient",
              false
            );
          }
        }
      }
      return summary;
    },
  });
}

module.exports = {
  DEFAULT_LEASE_MS,
  FREE_AGENT_DRAFT_COMPLETION_JOB_TYPE:
    JOB_TYPE,
  JOB_NAME,
  createCompleteFreeAgentDraftsJob,
};
