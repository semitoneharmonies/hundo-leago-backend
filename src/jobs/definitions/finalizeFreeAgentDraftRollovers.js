"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteFreeAgentDraftRolloverWriter"
);
const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "free-agent-drafts:rollover-finalization:target";
const JOB_TYPE =
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE.rollover;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
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
  "rolloverAtMs",
  "sequence",
  "type",
]);
const BINDING_FIELDS = Object.freeze([
  "fadId",
  "resourceId",
  "resourceType",
  "rolloverAtMs",
  "rolloverId",
  "sequence",
  "type",
]);
const ENSURED_FIELDS = Object.freeze([
  "createdAtMs",
  "fadId",
  "jobRunId",
  "leagueId",
  "occurrenceKey",
  "rolloverAtMs",
  "rolloverId",
  "seasonId",
  "sequence",
]);
const LIVE_FIELDS = Object.freeze([
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "jobStatus",
  "leagueId",
  "occurrenceKey",
  "replayed",
  "rolloverAtMs",
  "rolloverId",
  "rolloverVersion",
  "seasonId",
  "sequence",
  "sourceRecoveryId",
  "sourceRecoveryStatus",
  "sourceRecoveryVersion",
  "status",
]);
const DECISION_FIELDS = Object.freeze([
  "evidence",
  "fadId",
  "outcome",
  "reasonCode",
  "replayed",
  "rolloverAtMs",
  "rolloverId",
  "sequence",
]);
const POLICY_EVIDENCE_FIELDS = Object.freeze([
  "auctionCount",
  "createdFallbackCount",
  "nominationCount",
  "normalAuctionCount",
  "recoverableAuctionCount",
  "recoverableUnresolvedCount",
  "requiredFallbackCount",
  "terminalNominationCount",
  "unresolvedCount",
]);
const COMPLETED_FIELDS = Object.freeze([
  "evidence",
  "fadId",
  "finalizedAtMs",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "outcome",
  "replayed",
  "rolloverAtMs",
  "rolloverId",
  "rolloverVersion",
  "seasonId",
  "sequence",
  "sourceRecoveryId",
]);
const COMPLETED_EVIDENCE_FIELDS = Object.freeze([
  ...POLICY_EVIDENCE_FIELDS,
  "reasonCode",
]);
const FAILURE_FIELDS = Object.freeze([
  "extensionJobRunId",
  "extensionRolloverId",
  "fadId",
  "failedAtMs",
  "failureCode",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "outcome",
  "recoveryId",
  "replayed",
  "rolloverAtMs",
  "rolloverId",
  "rolloverVersion",
  "seasonId",
  "sequence",
]);

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD rollover finalization runner requires ${description}`
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
      `FAD rollover finalization runner requires ${description}`
    );
  }
  return value;
}

function safeFutureTimestamp(timestamp, durationMs) {
  if (
    timestamp > Number.MAX_SAFE_INTEGER - durationMs
  ) {
    throw new TypeError(
      "FAD rollover finalization runner requires a safe lease expiry"
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
      `FAD rollover finalization runner requires ${description}`
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

function nullableCanonicalId(value) {
  return value === null || UUID_PATTERN.test(value || "");
}

function canonicalOccurrence({ fadId, sequence, rolloverAtMs }) {
  try {
    return buildFreeAgentDraftRolloverOccurrenceKey({
      fadId,
      sequence,
      rolloverAtMs,
    });
  } catch {
    return null;
  }
}

function requireDescriptor(value) {
  const parsed = value?.parsedOccurrence;
  const binding = value?.binding;
  if (
    !exactObject(value, DESCRIPTOR_FIELDS) ||
    value.jobType !== JOB_TYPE ||
    !UUID_PATTERN.test(value.runId || "") ||
    !UUID_PATTERN.test(value.leagueId || "") ||
    !UUID_PATTERN.test(value.seasonId || "") ||
    !UUID_PATTERN.test(value.fadId || "") ||
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
    parsed.type !== "rollover" ||
    parsed.fadId !== value.fadId ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 1 ||
    !Number.isSafeInteger(parsed.rolloverAtMs) ||
    parsed.rolloverAtMs < 0 ||
    parsed.rolloverAtMs !== value.scheduledForMs ||
    value.occurrenceKey !== canonicalOccurrence(parsed) ||
    !exactObject(binding, BINDING_FIELDS) ||
    binding.type !== "rollover" ||
    binding.resourceType !== "rollover" ||
    binding.resourceId !== binding.rolloverId ||
    !UUID_PATTERN.test(binding.rolloverId || "") ||
    binding.fadId !== value.fadId ||
    binding.sequence !== parsed.sequence ||
    binding.rolloverAtMs !== parsed.rolloverAtMs
  ) {
    throw new TypeError(
      "FAD rollover finalization runner received a noncanonical rollover descriptor"
    );
  }
  return value;
}

function requireDueLifecycle(value, nowMs) {
  if (value.scheduledForMs > nowMs) {
    throw new TypeError(
      "FAD rollover finalization runner received work before its schedule"
    );
  }
  if (value.status === "pending") {
    if (
      value.leaseExpiresAtMs !== null ||
      value.startedAtMs !== null ||
      value.completedAtMs !== null ||
      value.resultJson !== null ||
      value.lastErrorCode !== null ||
      (
        value.nextAttemptAtMs !== null &&
        value.nextAttemptAtMs > nowMs
      )
    ) {
      throw new TypeError(
        "FAD rollover finalization runner received a malformed pending occurrence"
      );
    }
    return value;
  }
  if (["leased", "running"].includes(value.status)) {
    if (
      value.attemptCount < 1 ||
      !Number.isSafeInteger(value.leaseExpiresAtMs) ||
      value.leaseExpiresAtMs > nowMs ||
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
        "FAD rollover finalization runner received a malformed expired claim"
      );
    }
    return value;
  }
  if (value.status === "failed") {
    if (
      value.attemptCount < 1 ||
      !Number.isSafeInteger(value.startedAtMs) ||
      !Number.isSafeInteger(value.completedAtMs) ||
      value.completedAtMs < value.startedAtMs ||
      value.leaseExpiresAtMs !== null ||
      value.resultJson !== null ||
      typeof value.lastErrorCode !== "string" ||
      !Number.isSafeInteger(value.nextAttemptAtMs) ||
      value.nextAttemptAtMs > nowMs
    ) {
      throw new TypeError(
        "FAD rollover finalization runner received a malformed retry occurrence"
      );
    }
    return value;
  }
  throw new TypeError(
    "FAD rollover finalization runner received an unsupported occurrence state"
  );
}

function requireEnsured(value, ensuredAtMs) {
  if (
    !exactObject(value, ENSURED_FIELDS) ||
    !UUID_PATTERN.test(value.leagueId || "") ||
    !UUID_PATTERN.test(value.seasonId || "") ||
    !UUID_PATTERN.test(value.fadId || "") ||
    !UUID_PATTERN.test(value.rolloverId || "") ||
    !UUID_PATTERN.test(value.jobRunId || "") ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isSafeInteger(value.rolloverAtMs) ||
    value.rolloverAtMs < 0 ||
    value.occurrenceKey !== canonicalOccurrence(value) ||
    value.createdAtMs !== ensuredAtMs
  ) {
    throw new TypeError(
      "FAD rollover finalization runner received a noncanonical ensured job"
    );
  }
  return value;
}

function requireClaimed(claim, due, claimAtMs, leaseExpiresAtMs) {
  if (
    !exactObject(claim, ["acquired", "occurrence"]) ||
    claim.acquired !== true ||
    !claim.occurrence
  ) {
    throw new TypeError(
      "FAD rollover finalization runner received an invalid acquired claim"
    );
  }
  const claimed = requireDescriptor(claim.occurrence);
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
      "FAD rollover finalization runner received a mismatched acquired claim"
    );
  }
  return claimed;
}

function identityFor(value) {
  return Object.freeze({
    leagueId: value.leagueId,
    seasonId: value.seasonId,
    fadId: value.fadId,
    rolloverId: value.binding.rolloverId,
    sequence: value.binding.sequence,
    rolloverAtMs: value.binding.rolloverAtMs,
    occurrenceKey: value.occurrenceKey,
  });
}

function sameIdentity(value, occurrence) {
  return (
    value?.leagueId === occurrence.leagueId &&
    value?.seasonId === occurrence.seasonId &&
    value?.fadId === occurrence.fadId &&
    value?.rolloverId === occurrence.binding.rolloverId &&
    value?.sequence === occurrence.binding.sequence &&
    value?.rolloverAtMs === occurrence.binding.rolloverAtMs
  );
}

function sameBoundary(value, occurrence) {
  return (
    value?.fadId === occurrence.fadId &&
    value?.rolloverId === occurrence.binding.rolloverId &&
    value?.sequence === occurrence.binding.sequence &&
    value?.rolloverAtMs === occurrence.binding.rolloverAtMs
  );
}

function requireEvidence(value, fields) {
  return Boolean(
    exactObject(value, fields) &&
    fields.every((field) =>
      field === "reasonCode" ||
      (
        Number.isSafeInteger(value[field]) &&
        value[field] >= 0
      )
    ) &&
    value.normalAuctionCount <= value.auctionCount &&
    value.recoverableAuctionCount <= value.auctionCount &&
    value.normalAuctionCount + value.recoverableAuctionCount <=
      value.auctionCount &&
    value.terminalNominationCount <= value.nominationCount &&
    value.createdFallbackCount <= value.requiredFallbackCount &&
    value.recoverableUnresolvedCount <= value.unresolvedCount
  );
}

function requireDecision(result, claimed) {
  const expectedReason = {
    awaiting_data: "boundary_work_pending",
    recovery_required: "boundary_recovery_required",
  }[result?.outcome];
  if (
    !exactObject(result, DECISION_FIELDS) ||
    !expectedReason ||
    result.reasonCode !== expectedReason ||
    result.replayed !== false ||
    !sameBoundary(result, claimed) ||
    !requireEvidence(result.evidence, POLICY_EVIDENCE_FIELDS) ||
    result.evidence.unresolvedCount < 1 ||
    (
      result.outcome === "recovery_required"
        ? result.evidence.unresolvedCount !==
          result.evidence.recoverableUnresolvedCount
        : result.evidence.unresolvedCount <=
          result.evidence.recoverableUnresolvedCount
    )
  ) {
    throw new TypeError(
      "FAD rollover finalization runner requires a canonical policy decision"
    );
  }
  return result;
}

function requireCompleted(result, occurrence, { replayed }) {
  if (
    !exactObject(result, COMPLETED_FIELDS) ||
    result.outcome !== "completed" ||
    result.replayed !== replayed ||
    !sameIdentity(result, occurrence) ||
    !Number.isSafeInteger(result.finalizedAtMs) ||
    result.finalizedAtMs < occurrence.scheduledForMs ||
    !Number.isSafeInteger(result.rolloverVersion) ||
    result.rolloverVersion < 2 ||
    result.jobRunId !== occurrence.runId ||
    (
      replayed
        ? result.jobRunVersion <= occurrence.version
        : result.jobRunVersion !== occurrence.version + 1
    ) ||
    !nullableCanonicalId(result.sourceRecoveryId) ||
    !requireEvidence(
      result.evidence,
      COMPLETED_EVIDENCE_FIELDS
    ) ||
    result.evidence.reasonCode !== "boundary_accounted" ||
    result.evidence.unresolvedCount !== 0 ||
    result.evidence.recoverableUnresolvedCount !== 0
  ) {
    throw new TypeError(
      "FAD rollover finalization runner requires a durable completed result"
    );
  }
  return result;
}

function requireFailure(result, occurrence, { replayed }) {
  if (
    !exactObject(result, FAILURE_FIELDS) ||
    result.outcome !== "failure_recorded" ||
    result.replayed !== replayed ||
    !sameIdentity(result, occurrence) ||
    !Number.isSafeInteger(result.failedAtMs) ||
    result.failedAtMs < occurrence.scheduledForMs ||
    !Number.isSafeInteger(result.rolloverVersion) ||
    result.rolloverVersion < 2 ||
    result.jobRunId !== occurrence.runId ||
    (
      replayed
        ? result.jobRunVersion <= occurrence.version
        : result.jobRunVersion !== occurrence.version + 1
    ) ||
    !UUID_PATTERN.test(result.recoveryId || "") ||
    !nullableCanonicalId(result.extensionRolloverId) ||
    !nullableCanonicalId(result.extensionJobRunId) ||
    (
      (result.extensionRolloverId === null) !==
      (result.extensionJobRunId === null)
    ) ||
    result.failureCode !==
      FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE
  ) {
    throw new TypeError(
      "FAD rollover finalization runner requires a durable recorded recovery"
    );
  }
  return result;
}

function requireNonAcquired(claim, due, writer) {
  if (
    !exactObject(claim, ["acquired", "occurrence"]) ||
    claim.acquired !== false
  ) {
    throw new TypeError(
      "FAD rollover finalization runner received an invalid claim result"
    );
  }
  if (claim.occurrence !== null) {
    const current = requireDescriptor(claim.occurrence);
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
        "FAD rollover finalization runner received a mismatched skipped claim"
      );
    }
  }
  const projection = writer.findFinalization(identityFor(due));
  if (projection && typeof projection.then === "function") {
    throw new TypeError(
      "FAD rollover finalization runner requires a synchronous finalization projection"
    );
  }
  if (projection?.outcome === "completed") {
    requireCompleted(projection, due, { replayed: true });
    return "completed";
  }
  if (projection?.outcome === "failure_recorded") {
    requireFailure(projection, due, { replayed: true });
    return "recovery_required";
  }
  if (
    !exactObject(projection, LIVE_FIELDS) ||
    !sameIdentity(projection, due) ||
    projection.occurrenceKey !== due.occurrenceKey ||
    projection.jobRunId !== due.runId ||
    !Number.isSafeInteger(projection.jobRunVersion) ||
    projection.jobRunVersion < 1 ||
    !Number.isSafeInteger(projection.rolloverVersion) ||
    projection.rolloverVersion < 1 ||
    projection.replayed !== false ||
    !["scheduled", "processing", "recovery_required"].includes(
      projection.status
    ) ||
    !["pending", "leased", "running"].includes(
      projection.jobStatus
    ) ||
    !nullableCanonicalId(projection.sourceRecoveryId) ||
    (
      projection.sourceRecoveryId === null
        ? (
            projection.sourceRecoveryStatus !== null ||
            projection.sourceRecoveryVersion !== null
          )
        : (
            typeof projection.sourceRecoveryStatus !== "string" ||
            !Number.isSafeInteger(
              projection.sourceRecoveryVersion
            ) ||
            projection.sourceRecoveryVersion < 1
          )
    )
  ) {
    throw new TypeError(
      "FAD rollover finalization runner could not prove a skipped finalization"
    );
  }
  return "skipped";
}

function executionFor(claimed, leaseOwner, leaseToken) {
  return Object.freeze({
    leagueId: claimed.leagueId,
    seasonId: claimed.seasonId,
    fadId: claimed.fadId,
    rolloverId: claimed.binding.rolloverId,
    sequence: claimed.binding.sequence,
    rolloverAtMs: claimed.binding.rolloverAtMs,
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
      "free_agent_draft.rollover_finalization_occurrence_failed",
      Object.freeze({
        job: JOB_NAME,
        leagueId: safeIdentifier(occurrence?.leagueId),
        seasonId: safeIdentifier(occurrence?.seasonId),
        fadId: safeIdentifier(occurrence?.fadId),
        rolloverId: safeIdentifier(
          occurrence?.binding?.rolloverId ||
            occurrence?.rolloverId
        ),
        jobRunId: safeIdentifier(
          occurrence?.runId || occurrence?.jobRunId
        ),
        classification,
        failureRecorded,
      })
    );
  } catch {
    // Observability cannot change durable rollover state.
  }
}

function emptySummary() {
  return {
    status: "succeeded",
    ensured: 0,
    due: 0,
    acquired: 0,
    succeeded: 0,
    recoveryRequired: 0,
    awaitingData: 0,
    transientFailed: 0,
    skipped: 0,
  };
}

function createFinalizeFreeAgentDraftRolloversJob({
  writer,
  repository,
  rolloverService,
  clock,
  secureRandom,
  leaseOwner,
  leaseDurationMs = DEFAULT_LEASE_MS,
  batchSize = 25,
  logger = console,
} = {}) {
  requireMethod(
    writer,
    "ensurePendingJobs",
    "an atomic writer with ensurePendingJobs"
  );
  requireMethod(
    writer,
    "findFinalization",
    "an atomic writer with findFinalization"
  );
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
    rolloverService,
    "executeClaimedRollover",
    "the claimed rollover service"
  );
  requireMethod(
    rolloverService,
    "recordClaimedFailure",
    "the claimed rollover failure service"
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
      "FAD rollover finalization runner configuration is invalid"
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
      const summary = emptySummary();
      let due;
      try {
        const ensuredAtMs = safeTimestamp(
          clock.nowMs(),
          "a safe ensure timestamp"
        );
        const ensured = writer.ensurePendingJobs({
          ensuredAtMs,
          limit: batchSize,
        });
        if (
          ensured &&
          typeof ensured.then === "function"
        ) {
          throw new TypeError(
            "FAD rollover finalization runner requires synchronous job ensuring"
          );
        }
        if (!Array.isArray(ensured)) {
          throw new TypeError(
            "FAD rollover finalization runner requires an ensured-job array"
          );
        }
        ensured.forEach((entry) =>
          requireEnsured(entry, ensuredAtMs)
        );
        const ensuredIds = ensured.map(({ jobRunId }) => jobRunId);
        if (new Set(ensuredIds).size !== ensuredIds.length) {
          throw new TypeError(
            "FAD rollover finalization runner received duplicate ensured jobs"
          );
        }
        summary.ensured = ensured.length;

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
            "FAD rollover finalization runner requires a due-occurrence array"
          );
        }
        due = listed.filter(
          ({ jobType } = {}) => jobType === JOB_TYPE
        );
        due.forEach((entry) =>
          requireDueLifecycle(
            requireDescriptor(entry),
            listedAtMs
          )
        );
        summary.due = due.length;
      } catch {
        summary.status = "failed";
        summary.transientFailed = 1;
        safeLog(
          logger,
          null,
          "transient_discovery",
          false
        );
        return summary;
      }

      for (const occurrence of due) {
        let claimed;
        let leaseToken;
        try {
          const claimAtMs = safeTimestamp(
            clock.nowMs(),
            "a safe claim timestamp"
          );
          if (claimAtMs < occurrence.scheduledForMs) {
            throw new TypeError(
              "FAD rollover finalization runner received work before its schedule"
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
            const replay = requireNonAcquired(
              claim,
              occurrence,
              writer
            );
            if (replay === "completed") {
              summary.succeeded += 1;
            } else if (replay === "recovery_required") {
              summary.recoveryRequired += 1;
              summary.status = "failed";
            } else {
              summary.skipped += 1;
            }
            continue;
          }
          if (claim?.acquired === true) {
            summary.acquired += 1;
          }
          claimed = requireClaimed(
            claim,
            occurrence,
            claimAtMs,
            leaseExpiresAtMs
          );
        } catch {
          summary.transientFailed += 1;
          summary.status = "failed";
          safeLog(
            logger,
            occurrence,
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
        let decision;
        try {
          const result =
            await rolloverService.executeClaimedRollover(
              execution
            );
          if (result?.outcome === "completed") {
            requireCompleted(result, claimed, {
              replayed: false,
            });
            summary.succeeded += 1;
            continue;
          }
          decision = requireDecision(result, claimed);
          if (decision.outcome === "awaiting_data") {
            summary.awaitingData += 1;
            continue;
          }
        } catch {
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
          requireFailure(
            await rolloverService.recordClaimedFailure({
              ...execution,
              reasonCode: decision.reasonCode,
            }),
            claimed,
            { replayed: false }
          );
          summary.recoveryRequired += 1;
          summary.status = "failed";
          safeLog(
            logger,
            claimed,
            "recovery_recorded",
            true
          );
        } catch {
          summary.transientFailed += 1;
          summary.status = "failed";
          safeLog(
            logger,
            claimed,
            "recovery_recording_transient",
            false
          );
        }
      }
      return summary;
    },
  });
}

module.exports = {
  DEFAULT_LEASE_MS,
  FREE_AGENT_DRAFT_ROLLOVER_JOB_TYPE: JOB_TYPE,
  JOB_NAME,
  createFinalizeFreeAgentDraftRolloversJob,
};
