"use strict";

const FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS =
  Object.freeze({
    deterministicTerminal: "deterministic_terminal",
    transient: "transient",
  });

const FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES = Object.freeze({
  evidenceInvalid: "FAD_COMPLETION_EVIDENCE_INVALID",
  mondayUnavailable: "FAD_COMPLETION_MONDAY_UNAVAILABLE",
  scheduleRecoveryInvalid:
    "FAD_COMPLETION_SCHEDULE_RECOVERY_INVALID",
});

const DETERMINISTIC_REASON_TO_ERROR_CODE = new Map([
  [
    "completion_monday_unavailable",
    FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES.mondayUnavailable,
  ],
  [
    "SCHEDULE_RECOVERY_PLAN_INVALID",
    FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES
      .scheduleRecoveryInvalid,
  ],
  [
    "RECOVERY_PLAN_INVALID",
    FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES
      .scheduleRecoveryInvalid,
  ],
  [
    "RECOVERY_PLAN_INCOMPLETE",
    FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES
      .scheduleRecoveryInvalid,
  ],
]);

for (const reasonCode of [
  "COMPLETION_EVIDENCE_INVALID",
  "COMPLETION_MARKERS_INVALID",
  "COMPLETION_RECOVERY_AMBIGUOUS",
  "COMPLETION_REPLAY_INVALID",
  "COMPLETION_RESULT_INVALID",
  "JOB_TERMINAL_STATE_INVALID",
  "LIFECYCLE_RESULT_INVALID",
  "PERSISTED_COUNT_INVALID",
  "POST_TRANSITION_ROOT_INVALID",
  "PUBLICATION_ACTIVITY_INVALID",
  "PUBLICATION_NOTIFICATION_INVALID",
  "PUBLICATION_OUTBOX_INVALID",
  "RECOVERY_EVIDENCE_DIGEST_MISMATCH",
  "RECOVERY_EVIDENCE_INVALID",
  "RECOVERY_REMOVED_MATCHUP_EVIDENCE_INVALID",
  "RECOVERY_REMOVED_MATCHUP_EVIDENCE_MISMATCH",
  "RECOVERY_REMOVED_WEEK_EVIDENCE_INVALID",
  "RECOVERY_REMOVED_WEEK_EVIDENCE_MISMATCH",
  "RECOVERY_SEAL_REPLAY_MISMATCH",
  "SCHEDULE_BYE_AMBIGUOUS",
  "STORED_STATE_AMBIGUOUS",
]) {
  DETERMINISTIC_REASON_TO_ERROR_CODE.set(
    reasonCode,
    FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES.evidenceInvalid
  );
}

function reasonFrom(value) {
  const visited = new Set();
  let current = value;
  while (
    current !== null &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !visited.has(current)
  ) {
    visited.add(current);
    for (const reasonCode of [
      current.reasonCode,
      current.details?.reasonCode,
    ]) {
      if (
        typeof reasonCode === "string" &&
        DETERMINISTIC_REASON_TO_ERROR_CODE.has(reasonCode)
      ) {
        return reasonCode;
      }
    }
    current = current.cause;
  }
  return null;
}

function classifyFreeAgentDraftCompletionFailure(error) {
  const reasonCode = reasonFrom(error);
  if (reasonCode !== null) {
    return Object.freeze({
      classification:
        FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS
          .deterministicTerminal,
      errorCode:
        DETERMINISTIC_REASON_TO_ERROR_CODE.get(reasonCode),
      reasonCode,
    });
  }
  return Object.freeze({
    classification:
      FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS
        .transient,
    errorCode: null,
    reasonCode: null,
  });
}

module.exports = {
  FREE_AGENT_DRAFT_COMPLETION_FAILURE_CLASSIFICATIONS,
  FREE_AGENT_DRAFT_COMPLETION_FAILURE_CODES,
  classifyFreeAgentDraftCompletionFailure,
};
