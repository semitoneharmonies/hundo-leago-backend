"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
  buildFreeAgentDraftAllocationOccurrenceKey,
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
  "free-agent-drafts:allocations:target";
const JOB_TYPE =
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
    .allocate;
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
  "fadId",
  "playerId",
  "type",
]);
const BINDING_FIELDS = Object.freeze([
  "allocationId",
  "fadId",
  "playerId",
  "resourceId",
  "resourceType",
  "type",
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
      `FAD allocation runner requires ${description}`
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
      `FAD allocation runner requires ${description}`
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
      `FAD allocation runner requires ${description}`
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
      `FAD allocation runner requires ${description}`
    );
  }
  return value;
}

function requireAllocationDescriptor(value) {
  const binding = value?.binding;
  const parsed = value?.parsedOccurrence;
  let canonicalOccurrenceKey = null;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftAllocationOccurrenceKey({
        fadId: value?.fadId,
        playerId: parsed?.playerId,
      });
  } catch {
    canonicalOccurrenceKey = null;
  }
  if (
    !exactObject(value, DESCRIPTOR_FIELDS) ||
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
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    !exactObject(parsed, PARSED_FIELDS) ||
    parsed.type !== "allocate" ||
    parsed.fadId !== value.fadId ||
    !UUID_PATTERN.test(parsed.playerId || "") ||
    !exactObject(binding, BINDING_FIELDS) ||
    binding.type !== "allocate" ||
    binding.resourceType !== "allocation" ||
    !UUID_PATTERN.test(
      binding.allocationId || ""
    ) ||
    binding.resourceId !==
      binding.allocationId ||
    binding.fadId !== value.fadId ||
    binding.playerId !== parsed.playerId
  ) {
    throw new TypeError(
      "FAD allocation runner received a noncanonical allocation descriptor"
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
      "FAD allocation runner received an invalid acquired claim"
    );
  }
  const claimed = requireAllocationDescriptor(
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
      "FAD allocation runner received a mismatched acquired claim"
    );
  }
  return claimed;
}

function requireTerminal(result, claimed) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    ![
      "automatic_award",
      "correction_required",
      "no_valid_offer",
      "restricted_active",
      "restricted_scheduled",
    ].includes(result.status) ||
    result.leagueId !== claimed.leagueId ||
    result.seasonId !== claimed.seasonId ||
    result.fadId !== claimed.fadId ||
    result.allocationId !==
      claimed.binding.allocationId ||
    result.playerId !==
      claimed.binding.playerId ||
    result.occurrenceKey !==
      claimed.occurrenceKey ||
    result.jobRunId !== claimed.runId ||
    result.jobRunVersion !==
      claimed.version + 1
  ) {
    throw new TypeError(
      "FAD allocation runner requires a durable terminal result"
    );
  }
  return result;
}

function createProcessFreeAgentDraftAllocationsJob({
  repository,
  allocationService,
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
    allocationService,
    "executeClaimedAllocation",
    "the claimed allocation service"
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
      "FAD allocation runner configuration is invalid"
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
          "FAD allocation runner requires a due-occurrence array"
        );
      }
      const allocationDue = due.filter(
        ({ jobType } = {}) => jobType === JOB_TYPE
      );
      allocationDue.forEach(
        requireAllocationDescriptor
      );
      const summary = {
        status: "succeeded",
        due: allocationDue.length,
        acquired: 0,
        succeeded: 0,
        correctionRequired: 0,
        failed: 0,
        skipped: 0,
      };

      for (const occurrence of allocationDue) {
        try {
          const claimAtMs = safeTimestamp(
            clock.nowMs(),
            "a safe claim timestamp"
          );
          if (
            claimAtMs < occurrence.scheduledForMs
          ) {
            throw new TypeError(
              "FAD allocation runner received work before its schedule"
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
          const terminal = requireTerminal(
            await allocationService
              .executeClaimedAllocation({
                leagueId: claimed.leagueId,
                seasonId: claimed.seasonId,
                fadId: claimed.fadId,
                allocationId:
                  claimed.binding.allocationId,
                playerId:
                  claimed.binding.playerId,
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
          if (
            terminal.status ===
            "correction_required"
          ) {
            summary.correctionRequired += 1;
          } else {
            summary.succeeded += 1;
          }
        } catch {
          summary.failed += 1;
          summary.status = "failed";
          logger.error(
            "free_agent_draft.allocation_occurrence_failed",
            {
              job: JOB_NAME,
              runId: occurrence.runId,
              fadId: occurrence.fadId,
              allocationId:
                occurrence.binding.allocationId,
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
  FREE_AGENT_DRAFT_ALLOCATION_JOB_TYPE:
    JOB_TYPE,
  JOB_NAME,
  createProcessFreeAgentDraftAllocationsJob,
};
