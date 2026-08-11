"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS,
  FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES,
  classifyFreeAgentDraftCompletionFailure,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCompletionFailurePolicy"
);

describe("Free Agent Draft completion failure policy", () => {
  test("classifies only explicit deterministic schedule and immutable-evidence reasons", () => {
    const monday = new Error("private calendar detail");
    monday.reasonCode = "completion_monday_unavailable";
    assert.deepEqual(
      classifyFreeAgentDraftCompletionFailure(monday),
      {
        classification:
          FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS
            .deterministicTerminal,
        errorCode:
          FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES
            .mondayUnavailable,
        reasonCode: "completion_monday_unavailable",
      }
    );

    const wrapped = new Error("repository wrapper", {
      cause: Object.assign(new Error("private evidence detail"), {
        details: { reasonCode: "COMPLETION_RESULT_INVALID" },
      }),
    });
    assert.deepEqual(
      classifyFreeAgentDraftCompletionFailure(wrapped),
      {
        classification:
          FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS
            .deterministicTerminal,
        errorCode:
          FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES
            .evidenceInvalid,
        reasonCode: "COMPLETION_RESULT_INVALID",
      }
    );
  });

  test("keeps eligibility races, lease loss, unknown schema failures, SQLite locks, and unknown errors transient", () => {
    for (const error of [
      Object.assign(new Error("new queued path"), {
        details: { reasonCode: "COMPLETION_NOT_ELIGIBLE" },
      }),
      Object.assign(new Error("lease changed"), {
        details: { reasonCode: "JOB_LEASE_CHANGED" },
      }),
      Object.assign(new Error("unknown schema"), {
        code: "REPOSITORY_SCHEMA_INCOMPATIBLE",
      }),
      Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
      }),
      new Error("private unknown failure"),
    ]) {
      assert.deepEqual(
        classifyFreeAgentDraftCompletionFailure(error),
        {
          classification:
            FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS
              .transient,
          errorCode: null,
          reasonCode: null,
        }
      );
    }
  });
});
