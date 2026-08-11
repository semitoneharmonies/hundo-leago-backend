"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
  buildFreeAgentDraftNominationOpenOccurrenceKey,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  isFreeAgentDraftQueuedNominationActivationTerminalFailure,
} = require(
  "../../application/services/freeAgentDraft/createFreeAgentDraftQueuedNominationActivationService"
);
const {
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteFreeAgentDraftQueuedNominationActivationWriter"
);
const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "free-agent-drafts:queued-nomination-activation";
const JOB_TYPE =
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
    .nomination_open;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/u;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
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
  "queueId",
  "rolloverAtMs",
  "type",
]);
const BINDING_FIELDS = Object.freeze([
  "fadId",
  "playerId",
  "queueId",
  "resourceId",
  "resourceType",
  "rolloverAtMs",
  "rolloverId",
  "type",
]);
const TERMINAL_FIELDS = Object.freeze([
  "activatedAtMs",
  "auctionId",
  "drawId",
  "evidence",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "openingAtMs",
  "openingRolloverId",
  "outcome",
  "queueId",
  "queueVersion",
  "replayed",
  "resolutionJobRunId",
  "resolutionRolloverId",
  "resolvesAtMs",
  "seasonId",
  "sourceRecoveryId",
  "starterBidId",
  "validationCode",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "auctionEventId",
  "extensionRolloverId",
]);
const FAILURE_FIELDS = Object.freeze([
  "errorCode",
  "fadId",
  "failedAtMs",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "openingRolloverId",
  "queueId",
  "recorded",
  "recoveryId",
  "recoveryVersion",
  "replayed",
  "seasonId",
]);

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD queued-nomination activation runner requires ${description}`
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
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `FAD queued-nomination activation runner requires ${description}`
    );
  }
  return value;
}

function safeFutureTimestamp(timestamp, durationMs) {
  if (
    timestamp > Number.MAX_SAFE_INTEGER - durationMs
  ) {
    throw new TypeError(
      "FAD queued-nomination activation runner requires a safe lease expiry"
    );
  }
  return timestamp + durationMs;
}

function boundedText(value, maximumLength, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new TypeError(
      `FAD queued-nomination activation runner requires ${description}`
    );
  }
  return value;
}

function nullableTimestamp(value) {
  return (
    value === null ||
    (Number.isSafeInteger(value) && value >= 0)
  );
}

function nullableText(value) {
  return value === null || typeof value === "string";
}

function canonicalOccurrence(value) {
  try {
    return buildFreeAgentDraftNominationOpenOccurrenceKey({
      fadId: value?.fadId,
      queueId: value?.parsedOccurrence?.queueId,
      rolloverAtMs:
        value?.parsedOccurrence?.rolloverAtMs,
    });
  } catch {
    return null;
  }
}

function requireActivationDescriptor(value) {
  const parsed = value?.parsedOccurrence;
  const binding = value?.binding;
  if (
    !exactObject(value, DESCRIPTOR_FIELDS) ||
    value.jobType !== JOB_TYPE ||
    !UUID_PATTERN.test(value.runId || "") ||
    !UUID_PATTERN.test(value.leagueId || "") ||
    !UUID_PATTERN.test(value.seasonId || "") ||
    !UUID_PATTERN.test(value.fadId || "") ||
    value.occurrenceKey !== canonicalOccurrence(value) ||
    !Number.isSafeInteger(value.scheduledForMs) ||
    value.scheduledForMs < 0 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    !nullableTimestamp(value.nextAttemptAtMs) ||
    !nullableTimestamp(value.leaseExpiresAtMs) ||
    !nullableTimestamp(value.startedAtMs) ||
    !nullableTimestamp(value.completedAtMs) ||
    !nullableText(value.resultJson) ||
    !nullableText(value.lastErrorCode) ||
    !exactObject(parsed, PARSED_FIELDS) ||
    parsed.type !== "nomination_open" ||
    parsed.fadId !== value.fadId ||
    !UUID_PATTERN.test(parsed.queueId || "") ||
    !Number.isSafeInteger(parsed.rolloverAtMs) ||
    parsed.rolloverAtMs < 0 ||
    parsed.rolloverAtMs !== value.scheduledForMs ||
    !exactObject(binding, BINDING_FIELDS) ||
    binding.type !== "nomination_open" ||
    binding.resourceType !== "nomination_queue" ||
    binding.resourceId !== parsed.queueId ||
    binding.fadId !== value.fadId ||
    binding.queueId !== parsed.queueId ||
    binding.rolloverAtMs !== parsed.rolloverAtMs ||
    !UUID_PATTERN.test(binding.playerId || "") ||
    !UUID_PATTERN.test(binding.rolloverId || "")
  ) {
    throw new TypeError(
      "FAD queued-nomination activation runner received a noncanonical activation descriptor"
    );
  }
  return value;
}

function isAwaitingRecovery(value) {
  return ["failed", "correction_required"].includes(
    value.status
  );
}

function isTerminal(value) {
  return ["succeeded", "skipped"].includes(value.status);
}

function requireDueLifecycle(value) {
  if (value.status === "pending") {
    if (
      value.leaseExpiresAtMs !== null ||
      value.startedAtMs !== null ||
      value.completedAtMs !== null ||
      value.resultJson !== null ||
      value.lastErrorCode !== null
    ) {
      throw new TypeError(
        "FAD queued-nomination activation runner received a malformed pending occurrence"
      );
    }
    return value;
  }
  if (["leased", "running"].includes(value.status)) {
    if (
      value.attemptCount < 1 ||
      !Number.isSafeInteger(value.leaseExpiresAtMs) ||
      (
        value.status === "leased"
          ? value.startedAtMs !== null
          : !Number.isSafeInteger(value.startedAtMs)
      ) ||
      value.completedAtMs !== null ||
      value.resultJson !== null ||
      value.lastErrorCode !== null ||
      value.nextAttemptAtMs !== null
    ) {
      throw new TypeError(
        "FAD queued-nomination activation runner received a malformed leased occurrence"
      );
    }
    return value;
  }
  if (isAwaitingRecovery(value)) {
    if (
      value.attemptCount < 1 ||
      !Number.isSafeInteger(value.startedAtMs) ||
      !Number.isSafeInteger(value.completedAtMs) ||
      value.completedAtMs < value.startedAtMs ||
      value.leaseExpiresAtMs !== null ||
      value.resultJson !== null ||
      !ERROR_CODE_PATTERN.test(value.lastErrorCode || "")
    ) {
      throw new TypeError(
        "FAD queued-nomination activation runner received a malformed correction-required occurrence"
      );
    }
    return value;
  }
  if (isTerminal(value)) return value;
  throw new TypeError(
    "FAD queued-nomination activation runner received an unsupported occurrence state"
  );
}

function requireClaimed(claim, due, claimAtMs, leaseExpiresAtMs) {
  if (
    !exactObject(claim, ["acquired", "occurrence"]) ||
    claim.acquired !== true ||
    !claim.occurrence
  ) {
    throw new TypeError(
      "FAD queued-nomination activation runner received an invalid acquired claim"
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
    claimed.attemptCount !== due.attemptCount + 1 ||
    claimed.status !== "running" ||
    claimed.startedAtMs !== claimAtMs ||
    claimed.startedAtMs < claimed.scheduledForMs ||
    claimed.leaseExpiresAtMs !== leaseExpiresAtMs ||
    claimed.nextAttemptAtMs !== null ||
    claimed.completedAtMs !== null ||
    claimed.resultJson !== null ||
    claimed.lastErrorCode !== null ||
    !isDeepStrictEqual(
      claimed.parsedOccurrence,
      due.parsedOccurrence
    ) ||
    !isDeepStrictEqual(claimed.binding, due.binding)
  ) {
    throw new TypeError(
      "FAD queued-nomination activation runner received a mismatched acquired claim"
    );
  }
  return claimed;
}

function requireNonAcquired(claim, due) {
  if (
    !exactObject(claim, ["acquired", "occurrence"]) ||
    claim.acquired !== false
  ) {
    throw new TypeError(
      "FAD queued-nomination activation runner received an invalid claim result"
    );
  }
  if (claim.occurrence === null) return;
  const current = requireActivationDescriptor(
    claim.occurrence
  );
  if (
    current.runId !== due.runId ||
    current.leagueId !== due.leagueId ||
    current.seasonId !== due.seasonId ||
    current.fadId !== due.fadId ||
    current.occurrenceKey !== due.occurrenceKey ||
    current.scheduledForMs !== due.scheduledForMs ||
    !isDeepStrictEqual(
      current.parsedOccurrence,
      due.parsedOccurrence
    ) ||
    !isDeepStrictEqual(current.binding, due.binding)
  ) {
    throw new TypeError(
      "FAD queued-nomination activation runner received a mismatched skipped claim"
    );
  }
}

function executionFor(claimed, leaseOwner, leaseToken) {
  return Object.freeze({
    leagueId: claimed.leagueId,
    seasonId: claimed.seasonId,
    fadId: claimed.fadId,
    queueId: claimed.binding.queueId,
    playerId: claimed.binding.playerId,
    openingRolloverId: claimed.binding.rolloverId,
    openingAtMs: claimed.binding.rolloverAtMs,
    occurrenceKey: claimed.occurrenceKey,
    scheduledForMs: claimed.scheduledForMs,
    jobExecution: Object.freeze({
      runId: claimed.runId,
      expectedVersion: claimed.version,
      leaseOwner,
      leaseToken,
      leaseExpiresAtMs: claimed.leaseExpiresAtMs,
      startedAtMs: claimed.startedAtMs,
      attemptCount: claimed.attemptCount,
    }),
  });
}

function requireTerminal(result, claimed) {
  const opened = result?.outcome === "opened";
  const invalid = result?.outcome === "invalid";
  const evidence = result?.evidence;
  if (
    !exactObject(result, TERMINAL_FIELDS) ||
    (!opened && !invalid) ||
    result.leagueId !== claimed.leagueId ||
    result.seasonId !== claimed.seasonId ||
    result.fadId !== claimed.fadId ||
    result.queueId !== claimed.binding.queueId ||
    result.openingRolloverId !== claimed.binding.rolloverId ||
    result.openingAtMs !== claimed.binding.rolloverAtMs ||
    !Number.isSafeInteger(result.activatedAtMs) ||
    result.activatedAtMs < claimed.startedAtMs ||
    result.activatedAtMs >= claimed.leaseExpiresAtMs ||
    !Number.isSafeInteger(result.queueVersion) ||
    result.queueVersion < 2 ||
    result.jobRunId !== claimed.runId ||
    result.jobRunVersion !== claimed.version + 1 ||
    result.replayed !== false ||
    (
      result.sourceRecoveryId !== null &&
      !UUID_PATTERN.test(result.sourceRecoveryId || "")
    ) ||
    !exactObject(evidence, EVIDENCE_FIELDS) ||
    (
      opened
        ? (
            !UUID_PATTERN.test(result.resolutionRolloverId || "") ||
            result.resolvesAtMs !==
              claimed.binding.rolloverAtMs + DAY_MS ||
            !UUID_PATTERN.test(result.auctionId || "") ||
            !UUID_PATTERN.test(result.starterBidId || "") ||
            !UUID_PATTERN.test(result.drawId || "") ||
            !UUID_PATTERN.test(result.resolutionJobRunId || "") ||
            result.validationCode !== null ||
            !UUID_PATTERN.test(evidence.auctionEventId || "") ||
            (
              evidence.extensionRolloverId !== null &&
              !UUID_PATTERN.test(evidence.extensionRolloverId || "")
            )
          )
        : (
            result.resolutionRolloverId !== null ||
            result.resolvesAtMs !== null ||
            result.auctionId !== null ||
            result.starterBidId !== null ||
            result.drawId !== null ||
            result.resolutionJobRunId !== null ||
            result.validationCode !== "PLAYER_UNAVAILABLE" ||
            evidence.auctionEventId !== null ||
            evidence.extensionRolloverId !== null
          )
    )
  ) {
    throw new TypeError(
      "FAD queued-nomination activation runner requires a durable terminal result"
    );
  }
  return result;
}

function requireRecordedFailure(result, claimed) {
  if (
    !exactObject(result, FAILURE_FIELDS) ||
    result.recorded !== true ||
    result.replayed !== false ||
    result.leagueId !== claimed.leagueId ||
    result.seasonId !== claimed.seasonId ||
    result.fadId !== claimed.fadId ||
    result.queueId !== claimed.binding.queueId ||
    result.openingRolloverId !== claimed.binding.rolloverId ||
    !Number.isSafeInteger(result.failedAtMs) ||
    result.failedAtMs < claimed.startedAtMs ||
    result.failedAtMs >= claimed.leaseExpiresAtMs ||
    result.errorCode !==
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE ||
    !UUID_PATTERN.test(result.recoveryId || "") ||
    !Number.isSafeInteger(result.recoveryVersion) ||
    result.recoveryVersion < 1 ||
    result.jobRunId !== claimed.runId ||
    result.jobRunVersion !== claimed.version + 1
  ) {
    throw new TypeError(
      "FAD queued-nomination activation runner requires a durable recorded failure"
    );
  }
  return result;
}

function safeIdentifier(value) {
  return UUID_PATTERN.test(value || "") ? value : null;
}

function safeLog(logger, occurrence, classification, failureRecorded) {
  try {
    logger.error(
      "free_agent_draft.queued_nomination_activation_occurrence_failed",
      Object.freeze({
        job: JOB_NAME,
        leagueId: safeIdentifier(occurrence?.leagueId),
        fadId: safeIdentifier(occurrence?.fadId),
        queueId: safeIdentifier(
          occurrence?.binding?.queueId ||
            occurrence?.parsedOccurrence?.queueId
        ),
        jobRunId: safeIdentifier(occurrence?.runId),
        classification,
        failureRecorded,
      })
    );
  } catch {
    // Observability is deliberately non-authoritative.
  }
}

function emptySummary() {
  return {
    status: "succeeded",
    due: 0,
    acquired: 0,
    succeeded: 0,
    failed: 0,
    terminalFailed: 0,
    transientFailed: 0,
    skipped: 0,
  };
}

function createActivateFreeAgentDraftQueuedNominationsJob({
  repository,
  activationService,
  clock,
  secureRandom,
  leaseOwner,
  leaseDurationMs = DEFAULT_LEASE_MS,
  batchSize = 25,
  logger = console,
} = {}) {
  requireMethod(repository, "listDue", "a durable repository with listDue");
  requireMethod(repository, "claim", "a durable repository with claim");
  requireMethod(
    activationService,
    "executeClaimedActivation",
    "the claimed activation service"
  );
  requireMethod(
    activationService,
    "recordClaimedFailure",
    "the claimed failure service"
  );
  requireMethod(clock, "nowMs", "a UTC clock");
  requireMethod(secureRandom, "id", "secure lease identifiers");
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
      "FAD queued-nomination activation runner configuration is invalid"
    );
  }

  const runnerLogger = Object.freeze({
    error() {
      safeLog(logger, null, "transient_execution", false);
    },
  });

  return createJobRunner({
    name: JOB_NAME,
    logger: runnerLogger,
    async execute() {
      const summary = emptySummary();
      let due;
      try {
        const listedAtMs = safeTimestamp(
          clock.nowMs(),
          "a safe due-query timestamp"
        );
        const listed = await repository.listDue({
          nowMs: listedAtMs,
          limit: batchSize,
        });
        if (!Array.isArray(listed)) {
          throw new TypeError(
            "FAD queued-nomination activation runner requires a due-occurrence array"
          );
        }
        due = listed.filter(
          ({ jobType } = {}) => jobType === JOB_TYPE
        );
        summary.due = due.length;
      } catch {
        summary.status = "failed";
        summary.failed = 1;
        summary.transientFailed = 1;
        safeLog(logger, null, "transient_execution", false);
        return summary;
      }

      for (const candidate of due) {
        let occurrence;
        try {
          occurrence = requireDueLifecycle(
            requireActivationDescriptor(candidate)
          );
          if (
            isAwaitingRecovery(occurrence) ||
            isTerminal(occurrence)
          ) {
            summary.skipped += 1;
            continue;
          }
        } catch {
          summary.failed += 1;
          summary.transientFailed += 1;
          summary.status = "failed";
          safeLog(logger, candidate, "transient_claim", false);
          continue;
        }

        let claimed;
        let leaseToken;
        try {
          const claimAtMs = safeTimestamp(
            clock.nowMs(),
            "a safe claim timestamp"
          );
          if (claimAtMs < occurrence.scheduledForMs) {
            throw new TypeError(
              "FAD queued-nomination activation runner received work before its schedule"
            );
          }
          const leaseExpiresAtMs = safeFutureTimestamp(
            claimAtMs,
            leaseDurationMs
          );
          leaseToken = boundedText(
            secureRandom.id(),
            200,
            "a secure lease identifier"
          );
          const claim = await repository.claim({
            leagueId: occurrence.leagueId,
            seasonId: occurrence.seasonId,
            fadId: occurrence.fadId,
            runId: occurrence.runId,
            jobType: JOB_TYPE,
            occurrenceKey: occurrence.occurrenceKey,
            scheduledForMs: occurrence.scheduledForMs,
            expectedVersion: occurrence.version,
            leaseOwner,
            leaseToken,
            nowMs: claimAtMs,
            leaseExpiresAtMs,
          });
          if (claim?.acquired === false) {
            requireNonAcquired(claim, occurrence);
            summary.skipped += 1;
            continue;
          }
          if (claim?.acquired === true) summary.acquired += 1;
          claimed = requireClaimed(
            claim,
            occurrence,
            claimAtMs,
            leaseExpiresAtMs
          );
        } catch {
          summary.failed += 1;
          summary.transientFailed += 1;
          summary.status = "failed";
          safeLog(logger, occurrence, "transient_claim", false);
          continue;
        }

        const execution = executionFor(
          claimed,
          leaseOwner,
          leaseToken
        );
        try {
          requireTerminal(
            await activationService.executeClaimedActivation(
              execution
            ),
            claimed
          );
          summary.succeeded += 1;
        } catch (error) {
          if (
            !isFreeAgentDraftQueuedNominationActivationTerminalFailure(
              error
            )
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
            requireRecordedFailure(
              await activationService.recordClaimedFailure(
                execution
              ),
              claimed
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
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE:
    JOB_TYPE,
  JOB_NAME,
  createActivateFreeAgentDraftQueuedNominationsJob,
};
