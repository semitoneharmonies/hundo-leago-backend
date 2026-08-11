"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
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
  "free-agent-drafts:restricted-activation:target";
const JOB_TYPE =
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
    .restricted_activate;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const DESCRIPTOR_FIELDS = Object.freeze([
  "attemptCount",
  "binding",
  "completedAtMs",
  "fadId",
  "jobType",
  "lastErrorCode",
  "leagueId",
  "leaseExpiresAtMs",
  "nextAttemptAtMs",
  "occurrenceKey",
  "parsedOccurrence",
  "resultJson",
  "runId",
  "scheduledForMs",
  "seasonId",
  "startedAtMs",
  "status",
  "version",
]);
const PARSED_FIELDS = Object.freeze([
  "activationAtMs",
  "allocationId",
  "fadId",
  "type",
]);
const BINDING_FIELDS = Object.freeze([
  "activationAtMs",
  "allocationId",
  "auctionId",
  "fadId",
  "playerId",
  "resourceId",
  "resourceType",
  "rolloverId",
  "type",
]);
const TERMINAL_FIELDS = Object.freeze([
  "activatedAtMs",
  "activationAtMs",
  "allocationId",
  "allocationVersion",
  "auctionId",
  "evidence",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "outcome",
  "playerId",
  "replayed",
  "rolloverId",
  "seasonId",
  "sourceRecoveryId",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "offerEventIds",
  "outboxEventIds",
  "stateEventId",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function requireMethod(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD restricted-activation runner requires ${description}`
    );
  }
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, fields) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (field, index) => field === expected[index]
    )
  );
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `FAD restricted-activation runner requires ${description}`
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
      `FAD restricted-activation runner requires ${description}`
    );
  }
  return timestamp + durationMs;
}

function boundedText(
  value,
  maximumLength,
  description
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new TypeError(
      `FAD restricted-activation runner requires ${description}`
    );
  }
  return value;
}

function canonicalOccurrence(value) {
  try {
    return buildFreeAgentDraftRestrictedActivationOccurrenceKey(
      {
        fadId: value?.fadId,
        allocationId:
          value?.parsedOccurrence?.allocationId,
        activationAtMs:
          value?.parsedOccurrence?.activationAtMs,
      }
    );
  } catch {
    return null;
  }
}

function requireActivationDescriptor(value) {
  const binding = value?.binding;
  const parsed = value?.parsedOccurrence;
  if (
    !exactObject(value, DESCRIPTOR_FIELDS) ||
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
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    !exactObject(parsed, PARSED_FIELDS) ||
    parsed.type !== "restricted_activate" ||
    parsed.fadId !== value.fadId ||
    !UUID_PATTERN.test(parsed.allocationId || "") ||
    !Number.isSafeInteger(parsed.activationAtMs) ||
    parsed.activationAtMs < 0 ||
    parsed.activationAtMs !== value.scheduledForMs ||
    !exactObject(binding, BINDING_FIELDS) ||
    binding.type !== "restricted_activate" ||
    binding.resourceType !== "allocation" ||
    binding.resourceId !== parsed.allocationId ||
    binding.fadId !== value.fadId ||
    binding.allocationId !== parsed.allocationId ||
    binding.activationAtMs !==
      parsed.activationAtMs ||
    !UUID_PATTERN.test(binding.playerId || "") ||
    !UUID_PATTERN.test(binding.auctionId || "") ||
    !UUID_PATTERN.test(binding.rolloverId || "")
  ) {
    throw new TypeError(
      "FAD restricted-activation runner received a noncanonical activation descriptor"
    );
  }
  return value;
}

function requireClaimed(
  claim,
  due,
  claimAtMs,
  leaseExpiresAtMs
) {
  if (
    !claim ||
    claim.acquired !== true ||
    !claim.occurrence
  ) {
    throw new TypeError(
      "FAD restricted-activation runner received an invalid acquired claim"
    );
  }
  const claimed = requireActivationDescriptor(
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
    claimed.attemptCount !==
      due.attemptCount + 1 ||
    claimed.status !== "running" ||
    claimed.startedAtMs !== claimAtMs ||
    claimed.startedAtMs <
      claimed.scheduledForMs ||
    claimed.leaseExpiresAtMs !==
      leaseExpiresAtMs ||
    claimed.nextAttemptAtMs !== null ||
    claimed.completedAtMs !== null ||
    claimed.resultJson !== null ||
    claimed.lastErrorCode !== null ||
    !isDeepStrictEqual(
      claimed.parsedOccurrence,
      due.parsedOccurrence
    ) ||
    !isDeepStrictEqual(
      claimed.binding,
      due.binding
    )
  ) {
    throw new TypeError(
      "FAD restricted-activation runner received a mismatched acquired claim"
    );
  }
  return claimed;
}

function canonicalIdArray(value, minimumLength = 0) {
  return (
    Array.isArray(value) &&
    value.length >= minimumLength &&
    value.every(
      (id) => UUID_PATTERN.test(id || "")
    ) &&
    new Set(value).size === value.length
  );
}

function requireTerminal(result, claimed) {
  const evidence = result?.evidence;
  if (
    !exactObject(result, TERMINAL_FIELDS) ||
    result.outcome !== "succeeded" ||
    result.leagueId !== claimed.leagueId ||
    result.seasonId !== claimed.seasonId ||
    result.fadId !== claimed.fadId ||
    result.allocationId !==
      claimed.binding.allocationId ||
    result.playerId !== claimed.binding.playerId ||
    result.auctionId !== claimed.binding.auctionId ||
    result.rolloverId !== claimed.binding.rolloverId ||
    result.activationAtMs !==
      claimed.binding.activationAtMs ||
    !Number.isSafeInteger(result.activatedAtMs) ||
    result.activatedAtMs <
      claimed.binding.activationAtMs ||
    result.activatedAtMs >=
      claimed.leaseExpiresAtMs ||
    !Number.isSafeInteger(result.allocationVersion) ||
    result.allocationVersion < 1 ||
    result.jobRunId !== claimed.runId ||
    result.jobRunVersion !== claimed.version + 1 ||
    typeof result.replayed !== "boolean" ||
    (
      result.sourceRecoveryId !== null &&
      !UUID_PATTERN.test(
        result.sourceRecoveryId || ""
      )
    ) ||
    !exactObject(evidence, EVIDENCE_FIELDS) ||
    !canonicalIdArray(evidence.offerEventIds, 2) ||
    !UUID_PATTERN.test(evidence.stateEventId || "") ||
    !canonicalIdArray(
      evidence.outboxEventIds,
      2
    ) ||
    evidence.outboxEventIds.length !== 2
  ) {
    throw new TypeError(
      "FAD restricted-activation runner requires a durable terminal result"
    );
  }
  return result;
}

function createActivateFreeAgentDraftRestrictedAuctionsJob({
  repository,
  activationService,
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
    activationService,
    "executeClaimedActivation",
    "the claimed activation service"
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
      "FAD restricted-activation runner configuration is invalid"
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
          "FAD restricted-activation runner requires a due-occurrence array"
        );
      }
      const activationDue = due.filter(
        ({ jobType } = {}) => jobType === JOB_TYPE
      );
      activationDue.forEach(
        requireActivationDescriptor
      );
      const summary = {
        status: "succeeded",
        due: activationDue.length,
        acquired: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      };

      for (const occurrence of activationDue) {
        try {
          const claimAtMs = safeTimestamp(
            clock.nowMs(),
            "a safe claim timestamp"
          );
          if (
            claimAtMs < occurrence.scheduledForMs
          ) {
            throw new TypeError(
              "FAD restricted-activation runner received work before its schedule"
            );
          }
          const leaseExpiresAtMs =
            safeFutureTimestamp(
              claimAtMs,
              leaseDurationMs,
              "a safe lease-expiry timestamp"
            );
          const leaseToken = boundedText(
            secureRandom.id(),
            200,
            "a secure lease identifier"
          );
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
            claimAtMs,
            leaseExpiresAtMs
          );
          requireTerminal(
            await activationService
              .executeClaimedActivation({
                leagueId: claimed.leagueId,
                seasonId: claimed.seasonId,
                fadId: claimed.fadId,
                allocationId:
                  claimed.binding.allocationId,
                playerId:
                  claimed.binding.playerId,
                auctionId:
                  claimed.binding.auctionId,
                rolloverId:
                  claimed.binding.rolloverId,
                activationAtMs:
                  claimed.binding.activationAtMs,
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
                  startedAtMs:
                    claimed.startedAtMs,
                  attemptCount:
                    claimed.attemptCount,
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
            "free_agent_draft.restricted_activation_occurrence_failed",
            {
              job: JOB_NAME,
              runId: occurrence.runId,
              fadId: occurrence.fadId,
              allocationId:
                occurrence.binding.allocationId,
              auctionId:
                occurrence.binding.auctionId,
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
  FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_JOB_TYPE:
    JOB_TYPE,
  JOB_NAME,
  createActivateFreeAgentDraftRestrictedAuctionsJob,
};
