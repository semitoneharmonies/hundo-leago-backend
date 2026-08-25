"use strict";

const { createJobRunner } = require("../runJob");

const JOB_NAME =
  "free-agent-drafts:allocation-cycle:target";
const VALID_STATUSES = Object.freeze([
  "failed",
  "skipped",
  "succeeded",
]);

function requireRunner(value, description) {
  if (!value || typeof value.run !== "function") {
    throw new TypeError(
      `FAD allocation cycle requires ${description}`
    );
  }
  return value;
}

function requireResult(value, description) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !VALID_STATUSES.includes(value.status)
  ) {
    throw new TypeError(
      `FAD allocation cycle requires ${description}`
    );
  }
  return value;
}

function cycleStatus(results) {
  if (results.some(({ status }) => status === "failed")) {
    return "failed";
  }
  if (results.some(({ status }) => status === "skipped")) {
    return "skipped";
  }
  return "succeeded";
}

function createProcessFreeAgentDraftAllocationCycleJob({
  allocationLifecycleJob,
  candidateAllocationJob,
  logger = console,
} = {}) {
  const lifecycle = requireRunner(
    allocationLifecycleJob,
    "the allocation lifecycle runner"
  );
  const allocations = requireRunner(
    candidateAllocationJob,
    "the per-player allocation runner"
  );
  if (!logger || typeof logger.error !== "function") {
    throw new TypeError(
      "FAD allocation cycle requires an error logger"
    );
  }

  return createJobRunner({
    name: JOB_NAME,
    logger: Object.freeze({
      error(eventName) {
        logger.error(
          eventName,
          Object.freeze({
            job: JOB_NAME,
            classification: "transient",
          })
        );
      },
    }),
    async execute() {
      const before = requireResult(
        await lifecycle.run(),
        "a pre-allocation lifecycle result"
      );
      const allocation = requireResult(
        await allocations.run(),
        "a per-player allocation result"
      );
      const after = requireResult(
        await lifecycle.run(),
        "a post-allocation lifecycle result"
      );
      return Object.freeze({
        status: cycleStatus([
          before,
          allocation,
          after,
        ]),
        before,
        allocation,
        after,
      });
    },
  });
}

module.exports = {
  JOB_NAME,
  createProcessFreeAgentDraftAllocationCycleJob,
};
