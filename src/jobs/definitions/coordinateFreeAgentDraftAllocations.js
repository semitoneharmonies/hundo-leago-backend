"use strict";

const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "free-agent-drafts:allocation-lifecycle:target";

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD allocation lifecycle runner requires ${description}`
    );
  }
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `FAD allocation lifecycle runner requires ${description}`
    );
  }
  return value;
}

function isVersionConflict(error) {
  const seen = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !seen.has(current)
  ) {
    seen.add(current);
    if (
      current.code ===
      REPOSITORY_ERROR_CODES.versionConflict
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function requireResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    ![
      "replayed",
      "transitioned",
      "waiting",
    ].includes(result.outcome) ||
    !["deadline_locked", "allocating"].includes(
      result.fromStatus
    ) ||
    (result.outcome === "waiting"
      ? result.toStatus !== null
      : !["allocating", "rapid"].includes(
          result.toStatus
        ))
  ) {
    throw new TypeError(
      "FAD allocation lifecycle runner received an invalid coordination result"
    );
  }
  return result;
}

function createCoordinateFreeAgentDraftAllocationsJob({
  writer,
  allocationLifecycleService,
  clock,
  batchSize = 25,
  logger = console,
} = {}) {
  requireMethod(
    writer,
    "listCandidates",
    "a durable writer with listCandidates"
  );
  requireMethod(
    allocationLifecycleService,
    "coordinateRoot",
    "the allocation lifecycle service"
  );
  requireMethod(clock, "nowMs", "a UTC clock");
  requireMethod(logger, "error", "an error logger");
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100
  ) {
    throw new TypeError(
      "FAD allocation lifecycle runner configuration is invalid"
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
      const nowMs = safeTimestamp(
        clock.nowMs(),
        "a safe root-scan timestamp"
      );
      const candidates = writer.listCandidates({
        nowMs,
        limit: batchSize,
      });
      if (
        !Array.isArray(candidates) ||
        candidates.length > batchSize
      ) {
        throw new TypeError(
          "FAD allocation lifecycle runner requires a bounded root array"
        );
      }
      const summary = {
        status: "succeeded",
        scanned: candidates.length,
        startedAllocating: 0,
        enteredRapid: 0,
        waiting: 0,
        replayed: 0,
        skipped: 0,
        failed: 0,
      };
      for (const candidate of candidates) {
        try {
          const raw =
            allocationLifecycleService.coordinateRoot(
              candidate
            );
          if (raw && typeof raw.then === "function") {
            throw new TypeError(
              "FAD allocation lifecycle coordination must be synchronous"
            );
          }
          const result = requireResult(raw);
          if (result.outcome === "waiting") {
            summary.waiting += 1;
          } else if (result.outcome === "replayed") {
            summary.replayed += 1;
            summary.skipped += 1;
          } else if (
            result.toStatus === "allocating"
          ) {
            summary.startedAllocating += 1;
          } else {
            summary.enteredRapid += 1;
          }
        } catch (error) {
          if (isVersionConflict(error)) {
            summary.skipped += 1;
            continue;
          }
          summary.failed += 1;
          summary.status = "failed";
          logger.error(
            "free_agent_draft.allocation_lifecycle_root_failed",
            {
              job: JOB_NAME,
              leagueId: candidate?.leagueId,
              seasonId: candidate?.seasonId,
              fadId: candidate?.fadId,
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
  JOB_NAME,
  createCoordinateFreeAgentDraftAllocationsJob,
};
