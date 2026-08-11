const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
  buildFreeAgentDraftReminderOccurrenceKey,
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
  "free-agent-drafts:deadline-reminders:target";
const JOB_TYPE =
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
    .reminder;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const BINDING_FIELDS = Object.freeze([
  "fadId",
  "reminderAtMs",
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
      `FAD deadline-reminder runner requires ${description}`
    );
  }
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `FAD deadline-reminder runner requires ${description}`
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
      `FAD deadline-reminder runner requires ${description}`
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

function requireReminderDescriptor(value) {
  const binding = value?.binding;
  const parsed = value?.parsedOccurrence;
  let canonicalOccurrenceKey = null;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftReminderOccurrenceKey({
        fadId: value?.fadId,
        reminderAtMs: parsed?.reminderAtMs,
      });
  } catch {
    canonicalOccurrenceKey = null;
  }
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
    value.scheduledForMs !==
      parsed?.reminderAtMs ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    parsed?.type !== "reminder" ||
    parsed?.fadId !== value.fadId ||
    !exactObject(binding, BINDING_FIELDS) ||
    binding.type !== "reminder" ||
    binding.resourceType !==
      "free_agent_draft" ||
    binding.resourceId !== value.fadId ||
    binding.fadId !== value.fadId ||
    binding.reminderAtMs !==
      value.scheduledForMs
  ) {
    throw new TypeError(
      "FAD deadline-reminder runner received a noncanonical reminder descriptor"
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
      "FAD deadline-reminder runner received an invalid acquired claim"
    );
  }
  const claimed = requireReminderDescriptor(
    claim.occurrence
  );
  if (
    claimed.runId !== due.runId ||
    claimed.leagueId !== due.leagueId ||
    claimed.seasonId !== due.seasonId ||
    claimed.fadId !== due.fadId ||
    claimed.occurrenceKey !==
      due.occurrenceKey ||
    claimed.scheduledForMs !==
      due.scheduledForMs ||
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
      "FAD deadline-reminder runner received a mismatched acquired claim"
    );
  }
  return claimed;
}

function requireTerminal(result, claimed) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !["succeeded", "skipped"].includes(
      result.outcome
    ) ||
    result.runId !== claimed.runId
  ) {
    throw new TypeError(
      "FAD deadline-reminder runner requires a durable terminal result"
    );
  }
  return result;
}

function createSendFreeAgentDraftDeadlineRemindersJob({
  repository,
  reminderService,
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
    reminderService,
    "executeClaimedReminder",
    "the claimed reminder service"
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
      "FAD deadline-reminder runner configuration is invalid"
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
          "FAD deadline-reminder runner requires a due-occurrence array"
        );
      }
      const reminderDue = due.filter(
        ({ jobType } = {}) =>
          jobType === JOB_TYPE
      );
      reminderDue.forEach(
        requireReminderDescriptor
      );
      const summary = {
        status: "succeeded",
        due: reminderDue.length,
        acquired: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      };

      for (const occurrence of reminderDue) {
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
            expectedVersion:
              occurrence.version,
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
          const terminal = requireTerminal(
            await reminderService
              .executeClaimedReminder({
                leagueId: claimed.leagueId,
                seasonId: claimed.seasonId,
                fadId: claimed.fadId,
                reminderAtMs:
                  claimed.binding.reminderAtMs,
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
          if (terminal.outcome === "skipped") {
            summary.skipped += 1;
          } else {
            summary.succeeded += 1;
          }
        } catch {
          summary.failed += 1;
          summary.status = "failed";
          logger.error(
            "free_agent_draft.deadline_reminder_occurrence_failed",
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
  DEFAULT_LEASE_MS,
  FREE_AGENT_DRAFT_DEADLINE_REMINDER_JOB_TYPE:
    JOB_TYPE,
  JOB_NAME,
  createSendFreeAgentDraftDeadlineRemindersJob,
};
