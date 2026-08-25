const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
  buildFreeAgentDraftEligibilityOccurrenceKey,
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
  "free-agent-drafts:candidate-eligibility:target";
const JOB_TYPE =
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
    .eligibility_revalidate;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const BINDING_FIELDS = Object.freeze([
  "effectivePositionGroupAfter",
  "effectivePositionGroupBefore",
  "eligibilityDeltaSha256",
  "fadId",
  "leaguePositionOverrideId",
  "occurrenceId",
  "playerId",
  "playerStatusAfter",
  "playerStatusBefore",
  "playerVersionAfter",
  "playerVersionBefore",
  "resourceId",
  "resourceType",
  "sourceOperationEventType",
  "sourceOperationId",
  "sourceOperationOccurredAtMs",
  "sourceProvider",
  "sourceResolvedPositionGroupAfter",
  "sourceResolvedPositionGroupBefore",
  "sourceStateAfterId",
  "sourceStateBeforeId",
  "type",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function requireMethod(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `Candidate eligibility runner requires ${description}`
    );
  }
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `Candidate eligibility runner requires ${description}`
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
      `Candidate eligibility runner requires ${description}`
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

function canonicalOptionalId(value) {
  return (
    value === null ||
    (
      typeof value === "string" &&
      UUID_PATTERN.test(value)
    )
  );
}

function canonicalPosition(value) {
  return (
    value === null ||
    value === "F" ||
    value === "D"
  );
}

function requireEligibilityDescriptor(value) {
  const binding = value?.binding;
  const parsed = value?.parsedOccurrence;
  let canonicalOccurrenceKey = null;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftEligibilityOccurrenceKey({
        fadId: value?.fadId,
        playerId: parsed?.playerId,
        sourceOperationId:
          parsed?.sourceOperationId,
      });
  } catch {
    canonicalOccurrenceKey = null;
  }
  const statusChanged =
    binding?.playerStatusBefore !==
    binding?.playerStatusAfter;
  const positionChanged =
    binding?.effectivePositionGroupBefore !==
    binding?.effectivePositionGroupAfter;
  const versionTransitionValid =
    binding?.playerVersionAfter ===
      binding?.playerVersionBefore ||
    binding?.playerVersionAfter ===
      binding?.playerVersionBefore + 1;
  const overrideProjectionValid =
    binding?.leaguePositionOverrideId === null
      ? (
          binding?.effectivePositionGroupBefore ===
            binding
              ?.sourceResolvedPositionGroupBefore &&
          binding?.effectivePositionGroupAfter ===
            binding
              ?.sourceResolvedPositionGroupAfter
        )
      : (
          binding?.effectivePositionGroupBefore !==
            null &&
          binding?.effectivePositionGroupBefore ===
            binding?.effectivePositionGroupAfter
        );
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
      canonicalOccurrenceKey ||
    !Number.isSafeInteger(value.scheduledForMs) ||
    value.scheduledForMs < 0 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    parsed?.type !== "eligibility_revalidate" ||
    parsed?.fadId !== value.fadId ||
    !exactObject(binding, BINDING_FIELDS) ||
    binding.type !== "eligibility_revalidate" ||
    binding.resourceType !==
      "eligibility_revalidation_occurrence" ||
    !UUID_PATTERN.test(binding.occurrenceId || "") ||
    binding.resourceId !== binding.occurrenceId ||
    binding.fadId !== value.fadId ||
    binding.playerId !== parsed.playerId ||
    binding.sourceOperationId !==
      parsed.sourceOperationId ||
    typeof binding.sourceProvider !== "string" ||
    binding.sourceProvider.length < 1 ||
    binding.sourceProvider.length > 80 ||
    binding.sourceProvider.trim() !==
      binding.sourceProvider ||
    CONTROL_PATTERN.test(binding.sourceProvider) ||
    binding.sourceOperationEventType !==
      "player_catalog_applied" ||
    binding.sourceOperationOccurredAtMs !==
      value.scheduledForMs ||
    !Number.isSafeInteger(
      binding.playerVersionBefore
    ) ||
    binding.playerVersionBefore < 1 ||
    !Number.isSafeInteger(
      binding.playerVersionAfter
    ) ||
    binding.playerVersionAfter < 1 ||
    !versionTransitionValid ||
    (
      statusChanged &&
      binding.playerVersionAfter !==
        binding.playerVersionBefore + 1
    ) ||
    !["active", "historical"].includes(
      binding.playerStatusBefore
    ) ||
    !["active", "historical"].includes(
      binding.playerStatusAfter
    ) ||
    !canonicalOptionalId(
      binding.sourceStateBeforeId
    ) ||
    !UUID_PATTERN.test(
      binding.sourceStateAfterId || ""
    ) ||
    !canonicalOptionalId(
      binding.leaguePositionOverrideId
    ) ||
    !canonicalPosition(
      binding.sourceResolvedPositionGroupBefore
    ) ||
    !canonicalPosition(
      binding.sourceResolvedPositionGroupAfter
    ) ||
    !canonicalPosition(
      binding.effectivePositionGroupBefore
    ) ||
    !canonicalPosition(
      binding.effectivePositionGroupAfter
    ) ||
    !overrideProjectionValid ||
    (!statusChanged && !positionChanged) ||
    !SHA256_PATTERN.test(
      binding.eligibilityDeltaSha256 || ""
    )
  ) {
    throw new TypeError(
      "Candidate eligibility runner received a noncanonical eligibility descriptor"
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
      "Candidate eligibility runner received an invalid acquired claim"
    );
  }
  const claimed = requireEligibilityDescriptor(
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
    claimed.leaseExpiresAtMs !==
      leaseExpiresAtMs ||
    !isDeepStrictEqual(
      claimed.binding,
      due.binding
    )
  ) {
    throw new TypeError(
      "Candidate eligibility runner received a mismatched acquired claim"
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
    result.runId !== claimed.runId ||
    result.occurrenceId !==
      claimed.binding.occurrenceId ||
    result.playerId !==
      claimed.binding.playerId
  ) {
    throw new TypeError(
      "Candidate eligibility runner requires a durable terminal result"
    );
  }
  return result;
}

function createRevalidateFreeAgentDraftCandidateEligibilityJob({
  repository,
  eligibilityService,
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
    eligibilityService,
    "executeClaimedEligibilityRevalidation",
    "the claimed eligibility service"
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
      "Candidate eligibility runner configuration is invalid"
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
          "Candidate eligibility runner requires a due-occurrence array"
        );
      }
      const eligibilityDue = due.filter(
        ({ jobType } = {}) =>
          jobType === JOB_TYPE
      );
      eligibilityDue.forEach(
        requireEligibilityDescriptor
      );
      const summary = {
        status: "succeeded",
        due: eligibilityDue.length,
        acquired: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      };

      for (const occurrence of eligibilityDue) {
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
          const claimed = requireClaimed(
            claim,
            occurrence,
            leaseExpiresAtMs
          );
          requireTerminal(
            await eligibilityService
              .executeClaimedEligibilityRevalidation({
                leagueId: claimed.leagueId,
                seasonId: claimed.seasonId,
                fadId: claimed.fadId,
                occurrenceId:
                  claimed.binding.occurrenceId,
                playerId:
                  claimed.binding.playerId,
                sourceOperationId:
                  claimed.binding
                    .sourceOperationId,
                sourceProvider:
                  claimed.binding.sourceProvider,
                occurrenceKey:
                  claimed.occurrenceKey,
                scheduledForMs:
                  claimed.scheduledForMs,
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
            claimed
          );
          summary.succeeded += 1;
        } catch {
          summary.failed += 1;
          summary.status = "failed";
          logger.error(
            "free_agent_draft.eligibility_revalidation_occurrence_failed",
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
  CANDIDATE_ELIGIBILITY_REVALIDATION_JOB_TYPE:
    JOB_TYPE,
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createRevalidateFreeAgentDraftCandidateEligibilityJob,
};
