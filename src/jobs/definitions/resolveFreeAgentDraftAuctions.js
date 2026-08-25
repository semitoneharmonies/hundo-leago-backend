"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

const {
  buildAuctionResolutionOccurrenceKey,
} = require("../../domain/auctions/auctionResolutionPolicy");
const {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE,
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE,
  isFreeAgentDraftAuctionResolutionTerminalFailure,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteFreeAgentDraftAuctionResolutionWriter"
);
const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "free-agent-drafts:auction-resolution:target";
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const DESCRIPTOR_FIELDS = Object.freeze([
  "allocationId",
  "allocationVersion",
  "attemptCount",
  "auctionId",
  "auctionStatus",
  "auctionVersion",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "jobStatus",
  "leagueId",
  "occurrenceKey",
  "playerId",
  "resolvesAtMs",
  "rolloverId",
  "seasonId",
]);
const CLAIMED_FIELDS = Object.freeze([
  "acquired",
  "allocationId",
  "allocationVersion",
  "attemptCount",
  "auctionId",
  "auctionVersion",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "occurrenceKey",
  "playerId",
  "recoveryId",
  "recoveryResumeEvidence",
  "recoveryResumed",
  "recoveryVersion",
  "resolvesAtMs",
  "rolloverId",
  "seasonId",
]);
const NOT_ACQUIRED_FIELDS = Object.freeze([
  "acquired",
  "reason",
  "resolution",
]);
const RECOVERY_EVIDENCE_FIELDS = Object.freeze([
  "clonedOfferEventIds",
  "stateEventId",
]);
const RESULT_FIELDS = Object.freeze([
  "allocationId",
  "allocationVersion",
  "auctionId",
  "auctionVersion",
  "completed",
  "drawReveal",
  "evidence",
  "fadId",
  "fallbackAuctionId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "occurrenceKey",
  "outcome",
  "replayed",
  "resolutionId",
  "resolvedAtMs",
  "rolloverId",
  "seasonId",
]);
const WINNER_RESULT_FIELDS = Object.freeze([
  ...RESULT_FIELDS,
  "lateLock",
  "winner",
]);
const REPLAY_FIELDS = Object.freeze([
  ...RESULT_FIELDS,
  "committedRoster",
]);
const WINNER_REPLAY_FIELDS = Object.freeze([
  ...REPLAY_FIELDS,
  "winner",
]);
const FAILURE_FIELDS = Object.freeze([
  "allocationId",
  "allocationVersion",
  "auctionId",
  "auctionVersion",
  "errorCode",
  "evidence",
  "fadId",
  "failedAtMs",
  "failureEventId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "occurrenceKey",
  "playerId",
  "recorded",
  "recoveryId",
  "recoveryVersion",
  "replayed",
  "rolloverId",
  "seasonId",
]);
const FAILURE_EVIDENCE_FIELDS = Object.freeze([
  "clonedOfferEventIds",
  "stateEventId",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const OUTCOMES = new Set([
  "winner",
  "no_winner",
  "restricted_fallback",
]);
const LATE_LOCK_STATUSES = new Set([
  "awaiting_data",
  "completed",
  "not_applicable",
  "still_illegal",
]);

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD auction-resolution runner requires ${description}`
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

function exactOwnProperties(value, fields) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    return false;
  }
  const actual = [...keys].sort();
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
      `FAD auction-resolution runner requires ${description}`
    );
  }
  return value;
}

function safeFutureTimestamp(
  value,
  durationMs,
  description
) {
  if (
    value > Number.MAX_SAFE_INTEGER - durationMs
  ) {
    throw new TypeError(
      `FAD auction-resolution runner requires ${description}`
    );
  }
  return value + durationMs;
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
      `FAD auction-resolution runner requires ${description}`
    );
  }
  return value;
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw new TypeError(
      `FAD auction-resolution runner requires ${description}`
    );
  }
  return value;
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validAllocationBinding(allocationId, allocationVersion) {
  return allocationId === null
    ? allocationVersion === 0
    : UUID_PATTERN.test(allocationId || "") &&
        positiveVersion(allocationVersion);
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalIdArray(value, minimumLength = 0) {
  return (
    Array.isArray(value) &&
    value.length >= minimumLength &&
    value.every(
      (item) =>
        typeof item === "string" &&
        UUID_PATTERN.test(item)
    ) &&
    new Set(value).size === value.length
  );
}

function canonicalOccurrenceKey(auctionId, resolvesAtMs) {
  try {
    return buildAuctionResolutionOccurrenceKey({
      auctionId,
      dueAtMs: resolvesAtMs,
    });
  } catch {
    return null;
  }
}

function requireDueDescriptor(value, listedAtMs) {
  const missingJob =
    value?.jobRunId === null &&
    value?.jobRunVersion === null &&
    value?.jobStatus === null &&
    value?.attemptCount === null;
  const existingJob =
    UUID_PATTERN.test(value?.jobRunId || "") &&
    positiveVersion(value?.jobRunVersion) &&
    ["pending", "leased", "running"].includes(
      value?.jobStatus
    ) &&
    nonnegativeInteger(value?.attemptCount);
  if (
    !exactOwnProperties(value, DESCRIPTOR_FIELDS) ||
    !UUID_PATTERN.test(value.leagueId || "") ||
    !UUID_PATTERN.test(value.seasonId || "") ||
    !UUID_PATTERN.test(value.fadId || "") ||
    !validAllocationBinding(
      value.allocationId,
      value.allocationVersion
    ) ||
    !UUID_PATTERN.test(value.playerId || "") ||
    !UUID_PATTERN.test(value.rolloverId || "") ||
    !UUID_PATTERN.test(value.auctionId || "") ||
    !positiveVersion(value.auctionVersion) ||
    !["open", "resolving", "failed"].includes(
      value.auctionStatus
    ) ||
    !Number.isSafeInteger(value.resolvesAtMs) ||
    value.resolvesAtMs < 0 ||
    value.resolvesAtMs > listedAtMs ||
    value.occurrenceKey !==
      canonicalOccurrenceKey(
        value.auctionId,
        value.resolvesAtMs
      ) ||
    (!missingJob && !existingJob) ||
    (missingJob && value.auctionStatus !== "open") ||
    (
      value.auctionStatus === "open" &&
      existingJob &&
      (
        value.jobStatus !== "pending" ||
        value.attemptCount !== 0
      )
    ) ||
    (
      value.auctionStatus === "resolving" &&
      (
        !existingJob ||
        !["leased", "running"].includes(
          value.jobStatus
        ) ||
        value.attemptCount < 1
      )
    ) ||
    (
      value.auctionStatus === "failed" &&
      (
        !existingJob ||
        value.jobStatus !== "pending" ||
        value.attemptCount < 1
      )
    )
  ) {
    throw new TypeError(
      "FAD auction-resolution runner received a noncanonical due descriptor"
    );
  }
  return value;
}

function requireRecoveryEvidence(value, allocationId) {
  const standaloneOpen = allocationId === null;
  return (
    exactOwnProperties(
      value,
      RECOVERY_EVIDENCE_FIELDS
    ) &&
    canonicalIdArray(
      value.clonedOfferEventIds,
      standaloneOpen ? 0 : 1
    ) &&
    (standaloneOpen
      ? value.clonedOfferEventIds.length === 0 &&
        value.stateEventId === null
      : UUID_PATTERN.test(value.stateEventId || ""))
  );
}

function requireClaimed(
  value,
  due,
  { runId, leaseToken, leaseExpiresAtMs }
) {
  const missingJob = due.jobRunId === null;
  const expectedJobVersion = missingJob
    ? 2
    : due.jobRunVersion + 1;
  const expectedAttemptCount = missingJob
    ? 1
    : due.attemptCount + 1;
  const expectedAuctionVersion =
    due.auctionStatus === "resolving"
      ? due.auctionVersion
      : due.auctionVersion + 1;
  const expectedAllocationVersion =
    due.allocationId === null
      ? 0
      : due.auctionStatus === "failed"
      ? due.allocationVersion + 1
      : due.allocationVersion;
  const expectedRecovery = due.auctionStatus === "failed";
  if (
    !exactOwnProperties(value, CLAIMED_FIELDS) ||
    value.acquired !== true ||
    value.leagueId !== due.leagueId ||
    value.seasonId !== due.seasonId ||
    value.fadId !== due.fadId ||
    value.allocationId !== due.allocationId ||
    value.playerId !== due.playerId ||
    value.rolloverId !== due.rolloverId ||
    value.auctionId !== due.auctionId ||
    value.resolvesAtMs !== due.resolvesAtMs ||
    value.occurrenceKey !== due.occurrenceKey ||
    value.allocationVersion !==
      expectedAllocationVersion ||
    value.auctionVersion !== expectedAuctionVersion ||
    value.jobRunId !== runId ||
    value.jobRunVersion !== expectedJobVersion ||
    value.attemptCount !== expectedAttemptCount ||
    value.leaseOwner === undefined ||
    value.leaseToken !== leaseToken ||
    value.leaseExpiresAtMs !== leaseExpiresAtMs ||
    value.recoveryResumed !== expectedRecovery ||
    (
      expectedRecovery
        ? !UUID_PATTERN.test(value.recoveryId || "") ||
          !positiveVersion(value.recoveryVersion) ||
          !requireRecoveryEvidence(
            value.recoveryResumeEvidence,
            due.allocationId
          )
        : value.recoveryId !== null ||
          value.recoveryVersion !== null ||
          value.recoveryResumeEvidence !== null
    )
  ) {
    throw new TypeError(
      "FAD auction-resolution runner received a mismatched acquired claim"
    );
  }
  return value;
}

function requireImmutableReplay(value, due, claimAtMs) {
  const winner = value?.outcome === "winner";
  const expectedFields = winner
    ? WINNER_REPLAY_FIELDS
    : REPLAY_FIELDS;
  const rosterDescriptor = Object.getOwnPropertyDescriptor(
    value || {},
    "committedRoster"
  );
  if (
    !exactOwnProperties(value, expectedFields) ||
    value.completed !== true ||
    value.replayed !== true ||
    !OUTCOMES.has(value.outcome) ||
    value.leagueId !== due.leagueId ||
    value.seasonId !== due.seasonId ||
    value.fadId !== due.fadId ||
    value.allocationId !== due.allocationId ||
    value.auctionId !== due.auctionId ||
    value.rolloverId !== due.rolloverId ||
    value.occurrenceKey !== due.occurrenceKey ||
    !validAllocationBinding(
      value.allocationId,
      value.allocationVersion
    ) ||
    !positiveVersion(value.auctionVersion) ||
    !positiveVersion(value.jobRunVersion) ||
    !UUID_PATTERN.test(value.jobRunId || "") ||
    !UUID_PATTERN.test(value.resolutionId || "") ||
    !Number.isSafeInteger(value.resolvedAtMs) ||
    value.resolvedAtMs < due.resolvesAtMs ||
    value.resolvedAtMs > claimAtMs ||
    !isPlainObject(value.drawReveal) ||
    !isPlainObject(value.evidence) ||
    !rosterDescriptor ||
    rosterDescriptor.enumerable !== false ||
    rosterDescriptor.configurable !== false ||
    rosterDescriptor.writable !== false ||
    (
      winner
        ? !isPlainObject(value.winner) ||
          !isPlainObject(rosterDescriptor.value)
        : rosterDescriptor.value !== null
    ) ||
    (
      value.outcome === "restricted_fallback"
        ? !UUID_PATTERN.test(
            value.fallbackAuctionId || ""
          )
        : value.fallbackAuctionId !== null
    )
  ) {
    throw new TypeError(
      "FAD auction-resolution runner received an invalid immutable replay"
    );
  }
  return value;
}

function requireNotAcquired(value, due, claimAtMs) {
  if (
    !exactOwnProperties(value, NOT_ACQUIRED_FIELDS) ||
    value.acquired !== false ||
    value.reason !== "succeeded"
  ) {
    throw new TypeError(
      "FAD auction-resolution runner received an invalid non-acquired claim"
    );
  }
  requireImmutableReplay(
    value.resolution,
    due,
    claimAtMs
  );
  return value;
}

function requireLateLock(value) {
  const fields = Object.hasOwn(value || {}, "lockId")
    ? ["lockId", "status"]
    : ["status"];
  return (
    exactOwnProperties(value, fields) &&
    LATE_LOCK_STATUSES.has(value.status) &&
    (
      !Object.hasOwn(value, "lockId") ||
      (
        value.status === "completed" &&
        UUID_PATTERN.test(value.lockId || "")
      )
    )
  );
}

function requireCompletedResult(value, claimed, claimAtMs) {
  const winner = value?.outcome === "winner";
  const expectedFields = winner
    ? WINNER_RESULT_FIELDS
    : RESULT_FIELDS;
  if (
    !exactOwnProperties(value, expectedFields) ||
    value.completed !== true ||
    typeof value.replayed !== "boolean" ||
    !OUTCOMES.has(value.outcome) ||
    value.leagueId !== claimed.leagueId ||
    value.seasonId !== claimed.seasonId ||
    value.fadId !== claimed.fadId ||
    value.allocationId !== claimed.allocationId ||
    value.auctionId !== claimed.auctionId ||
    value.rolloverId !== claimed.rolloverId ||
    value.occurrenceKey !== claimed.occurrenceKey ||
    value.allocationVersion !==
      (claimed.allocationId === null
        ? 0
        : claimed.allocationVersion + 1) ||
    value.auctionVersion !==
      claimed.auctionVersion + 1 ||
    value.jobRunId !== claimed.jobRunId ||
    value.jobRunVersion !==
      claimed.jobRunVersion + 1 ||
    !UUID_PATTERN.test(value.resolutionId || "") ||
    !Number.isSafeInteger(value.resolvedAtMs) ||
    value.resolvedAtMs < claimed.resolvesAtMs ||
    value.resolvedAtMs < claimAtMs ||
    value.resolvedAtMs >= claimed.leaseExpiresAtMs ||
    !isPlainObject(value.drawReveal) ||
    !isPlainObject(value.evidence) ||
    (
      winner
        ? !isPlainObject(value.winner) ||
          !requireLateLock(value.lateLock)
        : false
    ) ||
    (
      value.outcome === "restricted_fallback"
        ? !UUID_PATTERN.test(
            value.fallbackAuctionId || ""
          )
        : value.fallbackAuctionId !== null
    )
  ) {
    throw new TypeError(
      "FAD auction-resolution runner requires a durable terminal result"
    );
  }
  return value;
}

function requireCoordinatedReplay(value, replay) {
  const winner = value?.outcome === "winner";
  const expectedFields = winner
    ? WINNER_RESULT_FIELDS
    : RESULT_FIELDS;
  if (
    !exactOwnProperties(value, expectedFields) ||
    value.completed !== true ||
    value.replayed !== true ||
    !OUTCOMES.has(value.outcome) ||
    value.outcome !== replay.outcome ||
    value.leagueId !== replay.leagueId ||
    value.seasonId !== replay.seasonId ||
    value.fadId !== replay.fadId ||
    value.allocationId !== replay.allocationId ||
    value.allocationVersion !==
      replay.allocationVersion ||
    value.auctionId !== replay.auctionId ||
    value.auctionVersion !== replay.auctionVersion ||
    value.rolloverId !== replay.rolloverId ||
    value.occurrenceKey !== replay.occurrenceKey ||
    value.resolvedAtMs !== replay.resolvedAtMs ||
    value.resolutionId !== replay.resolutionId ||
    value.fallbackAuctionId !==
      replay.fallbackAuctionId ||
    value.jobRunId !== replay.jobRunId ||
    value.jobRunVersion !== replay.jobRunVersion ||
    !isDeepStrictEqual(
      value.drawReveal,
      replay.drawReveal
    ) ||
    !isDeepStrictEqual(value.evidence, replay.evidence) ||
    (
      winner
        ? !isDeepStrictEqual(
            value.winner,
            replay.winner
          ) ||
          !requireLateLock(value.lateLock)
        : false
    )
  ) {
    throw new TypeError(
      "FAD auction-resolution runner received an invalid coordinated replay"
    );
  }
  return value;
}

function requireFailureResult(
  value,
  claimed,
  failedAtMs
) {
  const evidence = value?.evidence;
  if (
    !exactOwnProperties(value, FAILURE_FIELDS) ||
    value.recorded !== true ||
    typeof value.replayed !== "boolean" ||
    value.errorCode !==
      FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE ||
    value.leagueId !== claimed.leagueId ||
    value.seasonId !== claimed.seasonId ||
    value.fadId !== claimed.fadId ||
    value.allocationId !== claimed.allocationId ||
    value.playerId !== claimed.playerId ||
    value.rolloverId !== claimed.rolloverId ||
    value.auctionId !== claimed.auctionId ||
    value.occurrenceKey !== claimed.occurrenceKey ||
    value.allocationVersion !==
      (claimed.allocationId === null
        ? 0
        : claimed.allocationVersion + 1) ||
    value.auctionVersion !==
      claimed.auctionVersion + 1 ||
    value.jobRunId !== claimed.jobRunId ||
    value.jobRunVersion !==
      claimed.jobRunVersion + 1 ||
    value.failedAtMs !== failedAtMs ||
    !UUID_PATTERN.test(value.recoveryId || "") ||
    !positiveVersion(value.recoveryVersion) ||
    !UUID_PATTERN.test(value.failureEventId || "") ||
    !exactOwnProperties(
      evidence,
      FAILURE_EVIDENCE_FIELDS
    ) ||
    !canonicalIdArray(
      evidence.clonedOfferEventIds,
      claimed.allocationId === null ? 0 : 1
    ) ||
    (claimed.allocationId === null
      ? evidence.clonedOfferEventIds.length !== 0 ||
        evidence.stateEventId !== null
      : !UUID_PATTERN.test(evidence.stateEventId || ""))
  ) {
    throw new TypeError(
      "FAD auction-resolution runner requires durable terminal-failure evidence"
    );
  }
  return value;
}

function logOccurrenceFailure(
  logger,
  occurrence,
  classification,
  failureRecorded
) {
  try {
    logger.error(
      "free_agent_draft.auction_resolution_occurrence_failed",
      {
        job: JOB_NAME,
        leagueId: occurrence.leagueId,
        fadId: occurrence.fadId,
        allocationId: occurrence.allocationId,
        auctionId: occurrence.auctionId,
        jobRunId: occurrence.jobRunId,
        classification,
        failureRecorded,
      }
    );
  } catch {
    // Logging cannot change durable failure or retry classification.
  }
}

function createResolveFreeAgentDraftAuctionsJob({
  repository,
  resolutionService,
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
    "claimDue",
    "a durable repository with claimDue"
  );
  requireMethod(
    repository,
    "recordFailure",
    "a durable repository with recordFailure"
  );
  requireMethod(
    resolutionService,
    "executeClaimedResolution",
    "the claimed resolution service"
  );
  requireMethod(
    resolutionService,
    "coordinateCommittedResolution",
    "the committed resolution replay coordinator"
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
      "FAD auction-resolution runner configuration is invalid"
    );
  }

  return createJobRunner({
    name: JOB_NAME,
    logger,
    async execute() {
      const listedAtMs = safeTimestamp(
        clock.nowMs(),
        "a safe due-query timestamp"
      );
      const due = repository.listDue({
        nowMs: listedAtMs,
        limit: batchSize,
      });
      if (
        !Array.isArray(due) ||
        (due && typeof due.then === "function")
      ) {
        throw new TypeError(
          "FAD auction-resolution runner requires a synchronous due array"
        );
      }
      due.forEach((item) =>
        requireDueDescriptor(item, listedAtMs)
      );
      const identities = new Set(
        due.map(
          (item) =>
            `${item.leagueId}:${item.auctionId}:${item.occurrenceKey}`
        )
      );
      if (identities.size !== due.length) {
        throw new TypeError(
          "FAD auction-resolution runner received duplicate due work"
        );
      }
      const summary = {
        status: "succeeded",
        due: due.length,
        acquired: 0,
        succeeded: 0,
        failed: 0,
        terminalFailed: 0,
        transientFailed: 0,
        skipped: 0,
      };

      for (const occurrence of due) {
        let claimed;
        let claimAtMs;
        let leaseToken;
        try {
          claimAtMs = safeTimestamp(
            clock.nowMs(),
            "a safe claim timestamp"
          );
          if (claimAtMs < occurrence.resolvesAtMs) {
            throw new TypeError(
              "FAD auction-resolution runner received work before it was due"
            );
          }
          const leaseExpiresAtMs = safeFutureTimestamp(
            claimAtMs,
            leaseDurationMs,
            "a safe lease-expiry timestamp"
          );
          const runId = occurrence.jobRunId === null
            ? canonicalId(
                secureRandom.id(),
                "a secure job-run identifier"
              )
            : occurrence.jobRunId;
          leaseToken = canonicalId(
            secureRandom.id(),
            "a secure lease-token identifier"
          );
          const claim = repository.claimDue({
            leagueId: occurrence.leagueId,
            seasonId: occurrence.seasonId,
            auctionId: occurrence.auctionId,
            occurrenceKey: occurrence.occurrenceKey,
            expectedAuctionVersion:
              occurrence.auctionVersion,
            expectedJobVersion:
              occurrence.jobRunVersion ?? 0,
            nowMs: claimAtMs,
            jobExecution: {
              runId,
              leaseOwner,
              leaseToken,
              leaseExpiresAtMs,
            },
          });
          if (claim && typeof claim.then === "function") {
            throw new TypeError(
              "FAD auction-resolution claim must be synchronous"
            );
          }
          if (claim?.acquired === false) {
            const replay = requireNotAcquired(
              claim,
              occurrence,
              claimAtMs
            );
            requireCoordinatedReplay(
              await resolutionService
                .coordinateCommittedResolution({
                  leagueId: occurrence.leagueId,
                  seasonId: occurrence.seasonId,
                  fadId: occurrence.fadId,
                  allocationId:
                    occurrence.allocationId,
                  rolloverId: occurrence.rolloverId,
                  auctionId: occurrence.auctionId,
                  resolvesAtMs:
                    occurrence.resolvesAtMs,
                  occurrenceKey:
                    occurrence.occurrenceKey,
                  resolution: replay.resolution,
                }),
              replay.resolution
            );
            summary.skipped += 1;
            continue;
          }
          claimed = requireClaimed(
            claim,
            occurrence,
            {
              runId,
              leaseToken,
              leaseExpiresAtMs,
            }
          );
          if (claimed.leaseOwner !== leaseOwner) {
            throw new TypeError(
              "FAD auction-resolution runner received a mismatched lease owner"
            );
          }
          summary.acquired += 1;
        } catch {
          summary.failed += 1;
          summary.transientFailed += 1;
          summary.status = "failed";
          logOccurrenceFailure(
            logger,
            occurrence,
            "transient_claim",
            false
          );
          continue;
        }

        try {
          const result =
            await resolutionService
              .executeClaimedResolution({
                leagueId: claimed.leagueId,
                seasonId: claimed.seasonId,
                fadId: claimed.fadId,
                allocationId: claimed.allocationId,
                playerId: claimed.playerId,
                rolloverId: claimed.rolloverId,
                auctionId: claimed.auctionId,
                resolvesAtMs: claimed.resolvesAtMs,
                occurrenceKey: claimed.occurrenceKey,
                expectedAuctionVersion:
                  claimed.auctionVersion,
                expectedAllocationVersion:
                  claimed.allocationVersion,
                jobExecution: {
                  runId: claimed.jobRunId,
                  expectedVersion:
                    claimed.jobRunVersion,
                  leaseOwner: claimed.leaseOwner,
                  leaseToken: claimed.leaseToken,
                  leaseExpiresAtMs:
                    claimed.leaseExpiresAtMs,
                  startedAtMs: claimAtMs,
                  attemptCount:
                    claimed.attemptCount,
                },
              });
          requireCompletedResult(
            result,
            claimed,
            claimAtMs
          );
          summary.succeeded += 1;
        } catch (error) {
          if (
            !isFreeAgentDraftAuctionResolutionTerminalFailure(
              error
            )
          ) {
            summary.failed += 1;
            summary.transientFailed += 1;
            summary.status = "failed";
            logOccurrenceFailure(
              logger,
              occurrence,
              "transient_execution",
              false
            );
            continue;
          }

          try {
            const failedAtMs = safeTimestamp(
              clock.nowMs(),
              "a safe failure timestamp"
            );
            if (
              failedAtMs < claimAtMs ||
              failedAtMs >= claimed.leaseExpiresAtMs
            ) {
              throw new TypeError(
                "FAD auction-resolution runner lost its failure-recording lease"
              );
            }
            const failure = repository.recordFailure({
              leagueId: claimed.leagueId,
              seasonId: claimed.seasonId,
              fadId: claimed.fadId,
              allocationId: claimed.allocationId,
              playerId: claimed.playerId,
              rolloverId: claimed.rolloverId,
              auctionId: claimed.auctionId,
              occurrenceKey: claimed.occurrenceKey,
              expectedAuctionVersion:
                claimed.auctionVersion,
              expectedAllocationVersion:
                claimed.allocationVersion,
              expectedJobVersion:
                claimed.jobRunVersion,
              failedAtMs,
              jobExecution: {
                runId: claimed.jobRunId,
                leaseOwner: claimed.leaseOwner,
                leaseToken: claimed.leaseToken,
                leaseExpiresAtMs:
                  claimed.leaseExpiresAtMs,
              },
            });
            if (
              failure &&
              typeof failure.then === "function"
            ) {
              throw new TypeError(
                "FAD auction-resolution failure recording must be synchronous"
              );
            }
            requireFailureResult(
              failure,
              claimed,
              failedAtMs
            );
            summary.failed += 1;
            summary.terminalFailed += 1;
            summary.status = "failed";
            logOccurrenceFailure(
              logger,
              occurrence,
              "terminal_recorded",
              true
            );
          } catch {
            summary.failed += 1;
            summary.transientFailed += 1;
            summary.status = "failed";
            logOccurrenceFailure(
              logger,
              occurrence,
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
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE,
  JOB_NAME,
  createResolveFreeAgentDraftAuctionsJob,
};
