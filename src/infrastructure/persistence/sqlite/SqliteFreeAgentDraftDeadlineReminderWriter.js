const crypto = require("node:crypto");

const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  UUID_PATTERN,
  buildFreeAgentDraftReminderOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");

const JOB_TYPE = "fad_deadline_reminder";
const REMINDER_LEAD_MS = 72 * 60 * 60 * 1000;
const COMMAND_FIELDS = Object.freeze([
  "executedAtMs",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "reminderAtMs",
  "scheduledForMs",
  "seasonId",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "expectedVersion",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function invalid(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    { details: { reasonCode } }
  );
}

function conflict(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    { details: { reasonCode } }
  );
}

function incompatible(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    { details: { reasonCode } }
  );
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

function exactObject(value, fields, description) {
  if (!isPlainObject(value)) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_INVALID"
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_FIELDS_INVALID"
    );
  }
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`,
      "IDENTIFIER_INVALID"
    );
  }
  return value;
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
    invalid(
      `A bounded ${description} is required.`,
      "TEXT_INVALID"
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(
      `A safe ${description} is required.`,
      "TIMESTAMP_INVALID"
    );
  }
  return value;
}

function positiveInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(
      `A positive ${description} is required.`,
      "VERSION_INVALID"
    );
  }
  return value;
}

function deterministicUuid(namespace) {
  const bytes = Buffer.from(
    crypto
      .createHash("sha256")
      .update(namespace, "utf8")
      .digest()
      .subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `${hex.slice(12, 16)}-${hex.slice(16, 20)}-` +
    hex.slice(20)
  );
}

function normalizeCommand(input) {
  exactObject(
    input,
    COMMAND_FIELDS,
    "FAD deadline-reminder execution command"
  );
  exactObject(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "FAD deadline-reminder job execution"
  );
  const leagueId = canonicalId(
    input.leagueId,
    "league identifier"
  );
  const seasonId = canonicalId(
    input.seasonId,
    "season identifier"
  );
  const fadId = canonicalId(
    input.fadId,
    "Free Agent Draft identifier"
  );
  const reminderAtMs = safeTimestamp(
    input.reminderAtMs,
    "deadline-reminder timestamp"
  );
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "deadline-reminder scheduled timestamp"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "deadline-reminder occurrence key"
  );
  let canonicalOccurrenceKey;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftReminderOccurrenceKey({
        fadId,
        reminderAtMs,
      });
  } catch {
    invalid(
      "The FAD deadline-reminder occurrence key is invalid.",
      "OCCURRENCE_KEY_INVALID"
    );
  }
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    scheduledForMs !== reminderAtMs
  ) {
    invalid(
      "The FAD deadline-reminder occurrence is not canonical for its scope.",
      "OCCURRENCE_SCOPE_INVALID"
    );
  }
  const executedAtMs = safeTimestamp(
    input.executedAtMs,
    "deadline-reminder execution timestamp"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.jobExecution.leaseExpiresAtMs,
    "deadline-reminder lease expiry"
  );
  if (executedAtMs < scheduledForMs) {
    conflict(
      "The FAD deadline reminder is not due.",
      "JOB_NOT_DUE"
    );
  }
  if (executedAtMs >= leaseExpiresAtMs) {
    conflict(
      "The FAD deadline-reminder execution lease has expired.",
      "JOB_LEASE_EXPIRED"
    );
  }
  return Object.freeze({
    leagueId,
    seasonId,
    fadId,
    reminderAtMs,
    occurrenceKey,
    scheduledForMs,
    executedAtMs,
    runId: canonicalId(
      input.jobExecution.runId,
      "job-run identifier"
    ),
    leaseOwner: boundedText(
      input.jobExecution.leaseOwner,
      128,
      "job lease owner"
    ),
    leaseToken: boundedText(
      input.jobExecution.leaseToken,
      200,
      "job lease token"
    ),
    leaseExpiresAtMs,
    expectedVersion: positiveInteger(
      input.jobExecution.expectedVersion,
      "job-run version"
    ),
  });
}

function uniqueRow(rows, description) {
  if (rows.length > 1) {
    incompatible(
      `${description} is ambiguous.`,
      "STORED_STATE_AMBIGUOUS"
    );
  }
  return rows[0] || null;
}

function canonicalParticipants(rows, root) {
  if (
    !Number.isSafeInteger(
      root.participating_team_count
    ) ||
    root.participating_team_count < 1 ||
    rows.length !== root.participating_team_count
  ) {
    incompatible(
      "The FAD deadline reminder lost its exact participant/card coverage.",
      "PARTICIPANT_COVERAGE_INVALID"
    );
  }
  const teamIds = new Set();
  const cardIds = new Set();
  for (const row of rows) {
    if (
      !UUID_PATTERN.test(row.team_id || "") ||
      !UUID_PATTERN.test(row.card_id || "") ||
      teamIds.has(row.team_id) ||
      cardIds.has(row.card_id) ||
      ![
        "open",
        "locked_complete",
        "locked_incomplete",
        "locked_conflicted",
      ].includes(row.card_status) ||
      ![
        "complete",
        "incomplete",
        "conflicted",
      ].includes(row.completeness_code) ||
      !Number.isSafeInteger(
        row.missing_mandatory_count
      ) ||
      row.missing_mandatory_count < 0 ||
      row.missing_mandatory_count > 18
    ) {
      incompatible(
        "The FAD deadline reminder found a noncanonical participant/card row.",
        "PARTICIPANT_STATE_INVALID"
      );
    }
    teamIds.add(row.team_id);
    cardIds.add(row.card_id);
  }
  return Object.freeze(
    rows.map((row) => Object.freeze({ ...row }))
  );
}

function obsoleteReason(command, root, participants) {
  if (
    command.executedAtMs >=
    root.candidate_deadline_at_ms
  ) {
    return "deadline_reached";
  }
  if (root.status === "completed") {
    return "fad_completed";
  }
  if (
    root.status !== "cards_open" ||
    participants.some(
      ({ card_status: status }) =>
        status !== "open"
    )
  ) {
    return "cards_locked";
  }
  return null;
}

function createSqliteFreeAgentDraftDeadlineReminderWriter({
  database,
  notificationWriter,
  leagueOutboxWriter,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftDeadlineReminderWriter requires an opened database"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "FAD deadline-reminder beforeCommit must be a function"
    );
  }

  let notifications;
  let outbox;
  let jobStatement;
  let rootStatement;
  let participantsStatement;
  let terminalStatement;
  try {
    notifications = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    jobStatement = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
      LIMIT 2
    `);
    rootStatement = database.prepare(`
      SELECT
        draft.*,
        readiness.reminder_job_run_id
          AS bound_reminder_job_run_id
      FROM free_agent_drafts AS draft
      JOIN free_agent_draft_readiness_operations
        AS readiness
        ON readiness.league_id = draft.league_id
       AND readiness.season_id = draft.season_id
       AND readiness.id = draft.readiness_operation_id
       AND readiness.readiness_occurrence_key =
           draft.readiness_occurrence_key
       AND readiness.status = 'succeeded'
       AND readiness.created_fad_id = draft.id
      WHERE draft.league_id = @leagueId
        AND draft.season_id = @seasonId
        AND draft.id = @fadId
      LIMIT 2
    `);
    participantsStatement = database.prepare(`
      SELECT
        participant.team_id,
        card.id AS card_id,
        card.status AS card_status,
        card.completeness_code,
        card.missing_mandatory_count,
        assignment.id AS manager_assignment_id,
        membership.id AS manager_membership_id,
        user.id AS manager_user_id
      FROM free_agent_draft_teams AS participant
      JOIN candidate_cards AS card
        ON card.league_id = participant.league_id
       AND card.season_id = participant.season_id
       AND card.fad_id = participant.fad_id
       AND card.team_id = participant.team_id
      LEFT JOIN team_manager_assignments
        AS assignment
       ON assignment.league_id = participant.league_id
       AND assignment.team_id = participant.team_id
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.ended_at_ms IS NULL
      LEFT JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
       AND membership.status = 'active'
       AND membership.ended_at_ms IS NULL
      LEFT JOIN users AS user
        ON user.id = membership.user_id
       AND user.status = 'active'
      WHERE participant.league_id = @leagueId
        AND participant.season_id = @seasonId
        AND participant.fad_id = @fadId
      ORDER BY participant.team_id
    `);
    terminalStatement = database.prepare(`
      UPDATE job_runs
      SET status = @terminalStatus,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @executedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @executedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
        AND status = 'running'
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms =
            @leaseExpiresAtMs
        AND lease_expires_at_ms >
            @executedAtMs
        AND version = @expectedVersion
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftDeadlineReminderWriter",
      tableName: "job_runs",
    });
  }

  const executeTransaction = database.transaction(
    (command) => {
      const job = uniqueRow(
        jobStatement.all(command),
        "The claimed FAD deadline-reminder job"
      );
      if (!job) {
        conflict(
          "The claimed FAD deadline-reminder job is unavailable.",
          "JOB_BINDING_CHANGED"
        );
      }
      if (
        job.status !== "running" ||
        job.lease_owner !== command.leaseOwner ||
        job.lease_token !== command.leaseToken ||
        job.lease_expires_at_ms !==
          command.leaseExpiresAtMs ||
        job.lease_expires_at_ms <=
          command.executedAtMs ||
        job.version !== command.expectedVersion ||
        !Number.isSafeInteger(job.started_at_ms) ||
        job.started_at_ms < 0 ||
        job.started_at_ms <
          command.scheduledForMs ||
        job.started_at_ms > command.executedAtMs ||
        job.updated_at_ms > command.executedAtMs ||
        job.completed_at_ms !== null ||
        job.result_json !== null ||
        job.last_error_code !== null ||
        job.next_attempt_at_ms !== null
      ) {
        conflict(
          "The FAD deadline-reminder job lease, version, or state changed.",
          "JOB_LEASE_CHANGED"
        );
      }

      const root = uniqueRow(
        rootStatement.all(command),
        "The FAD deadline-reminder root"
      );
      if (
        !root ||
        root.bound_reminder_job_run_id !==
          command.runId ||
        root.candidate_deadline_at_ms -
            REMINDER_LEAD_MS !==
          command.reminderAtMs
      ) {
        incompatible(
          "The FAD deadline-reminder job lost its sealed opening binding.",
          "FAD_BINDING_INVALID"
        );
      }
      const participants = canonicalParticipants(
        participantsStatement.all(command),
        root
      );
      const reasonCode = obsoleteReason(
        command,
        root,
        participants
      );
      const notificationIds = [];
      let sentCount = 0;
      let skippedCount = 0;
      let outboxEventId = null;

      if (reasonCode === null) {
        for (const participant of participants) {
          if (
            !UUID_PATTERN.test(
              participant.manager_user_id || ""
            ) ||
            !UUID_PATTERN.test(
              participant.manager_membership_id || ""
            ) ||
            !UUID_PATTERN.test(
              participant.manager_assignment_id || ""
            )
          ) {
            skippedCount += 1;
            continue;
          }
          const userId =
            participant.manager_user_id;
          const notificationId = deterministicUuid(
            `fad-deadline-reminder:notification:` +
              `${command.fadId}:` +
              `${participant.team_id}:${userId}`
          );
          const notificationContract =
            createFreeAgentDraftNotificationContract({
              type: "fad_deadline_approaching",
              recipientUserId: userId,
              messageData: {
                leagueId: command.leagueId,
                seasonId: command.seasonId,
                fadId: command.fadId,
                teamId: participant.team_id,
                cardId: participant.card_id,
                candidateDeadlineAtMs:
                  root.candidate_deadline_at_ms,
                completenessCode:
                  participant.completeness_code,
                missingMandatoryCount:
                  participant
                    .missing_mandatory_count,
                destination: {
                  kind: "private_card",
                  leagueId: command.leagueId,
                  fadId: command.fadId,
                  teamId: participant.team_id,
                  cardId: participant.card_id,
                },
              },
            });
          const notificationResult =
            notifications.insert({
              id: notificationId,
              userId:
                notificationContract.recipientUserId,
              leagueId: command.leagueId,
              eventType: notificationContract.type,
              messageDataJson: JSON.stringify(
                notificationContract.messageData
              ),
              relatedFeature: "free_agent_draft",
              relatedRecordId: command.fadId,
              deliveryStatus: "pending",
              createdAtMs: command.executedAtMs,
              deliveredAtMs: null,
              deduplicationKey:
                notificationContract.deduplicationKey,
            });
          if (
            notificationResult &&
            typeof notificationResult.then ===
              "function"
          ) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.transactionAsync,
              "FAD deadline-reminder notification writes must be synchronous."
            );
          }
          const persistedNotification =
            notificationResult?.notification;
          let persistedMessage;
          let persistedContract;
          try {
            persistedMessage = JSON.parse(
              persistedNotification?.message_data_json
            );
            persistedContract =
              createFreeAgentDraftNotificationContract({
                type:
                  persistedNotification?.event_type,
                recipientUserId:
                  persistedNotification?.user_id,
                messageData: persistedMessage,
              });
          } catch {
            incompatible(
              "The persisted FAD deadline reminder violates its notification contract.",
              "NOTIFICATION_EVIDENCE_INVALID"
            );
          }
          if (
            persistedNotification?.id !== notificationId ||
            persistedNotification.league_id !==
              command.leagueId ||
            persistedNotification.related_feature !==
              "free_agent_draft" ||
            persistedNotification.related_record_id !==
              command.fadId ||
            persistedNotification.delivery_status !==
              "pending" ||
            persistedNotification.created_at_ms !==
              command.executedAtMs ||
            persistedNotification.delivered_at_ms !== null ||
            persistedNotification.message_data_json !==
              JSON.stringify(
                persistedContract.messageData
              ) ||
            persistedContract.type !==
              notificationContract.type ||
            persistedContract.recipientUserId !==
              notificationContract.recipientUserId ||
            JSON.stringify(persistedContract.messageData) !==
              JSON.stringify(
                notificationContract.messageData
              ) ||
            persistedNotification.deduplication_key !==
              persistedContract.deduplicationKey ||
            persistedContract.deduplicationKey !==
              notificationContract.deduplicationKey
          ) {
            incompatible(
              "The persisted FAD deadline reminder is incomplete.",
              "NOTIFICATION_EVIDENCE_INVALID"
            );
          }
          notificationIds.push(notificationId);
          const notificationOutboxEventId = deterministicUuid(
            `fad-deadline-reminder:outbox:` +
              notificationId
          );
          const outboxResult = outbox.write({
            id: notificationOutboxEventId,
            leagueId: command.leagueId,
            eventType: "notification.created",
            aggregateType: "notification",
            aggregateId: notificationId,
            payload: createSocketEventMetadata({
              eventType: "notification.created",
              version: 1,
              reasonCode: "notification_created",
              occurredAtMs: command.executedAtMs,
              related: createEmptySocketRelated({
                fadId: command.fadId,
                teamId: participant.team_id,
                cardId: participant.card_id,
              }),
            }),
            occurredAtMs: command.executedAtMs,
            audiences: [{ kind: "user", userId }],
          });
          if (
            outboxResult &&
            typeof outboxResult.then === "function"
          ) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.transactionAsync,
              "FAD deadline-reminder outbox writes must be synchronous."
            );
          }
          outboxEventId ??= notificationOutboxEventId;
          sentCount += 1;
        }
      } else {
        skippedCount = participants.length;
      }

      const terminalStatus =
        reasonCode === null
          ? "succeeded"
          : "skipped";
      const result = Object.freeze({
        schemaVersion: 1,
        code:
          reasonCode === null
            ? "FAD_DEADLINE_REMINDERS_SENT"
            : "FAD_DEADLINE_REMINDER_SKIPPED",
        sentCount,
        skippedCount,
        reasonCode,
      });
      const resultJson =
        serializeCanonicalJsonV1(result);
      if (
        terminalStatement.run({
          ...command,
          terminalStatus,
          resultJson,
        }).changes !== 1
      ) {
        conflict(
          "The FAD deadline-reminder job lease or version changed before completion.",
          "JOB_TERMINAL_CAS_FAILED"
        );
      }
      if (beforeCommit) {
        const hookResult = beforeCommit({
          command,
          result,
          notificationIds: Object.freeze([
            ...notificationIds,
          ]),
          outboxEventId,
        });
        if (
          hookResult &&
          typeof hookResult.then === "function"
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.transactionAsync,
            "FAD deadline-reminder beforeCommit must be synchronous."
          );
        }
      }
      const terminal = uniqueRow(
        jobStatement.all(command),
        "The terminal FAD deadline-reminder job"
      );
      if (
        !terminal ||
        terminal.status !== terminalStatus ||
        terminal.attempt_count !==
          job.attempt_count ||
        terminal.lease_owner !== null ||
        terminal.lease_token !== null ||
        terminal.lease_expires_at_ms !== null ||
        terminal.started_at_ms !==
          job.started_at_ms ||
        terminal.completed_at_ms !==
          command.executedAtMs ||
        terminal.result_json !== resultJson ||
        terminal.last_error_code !== null ||
        terminal.next_attempt_at_ms !== null ||
        terminal.updated_at_ms !==
          command.executedAtMs ||
        terminal.version !==
          command.expectedVersion + 1
      ) {
        incompatible(
          "The completed FAD deadline-reminder job is noncanonical.",
          "JOB_TERMINAL_STATE_INVALID"
        );
      }
      return Object.freeze({
        outcome: terminalStatus,
        runId: command.runId,
        completedAtMs: command.executedAtMs,
        jobVersion: command.expectedVersion + 1,
        sentCount,
        skippedCount,
        reasonCode,
        notificationIds: Object.freeze([
          ...notificationIds,
        ]),
        outboxEventId,
      });
    }
  );

  return Object.freeze({
    executeClaimed(input = {}) {
      const command = normalizeCommand(input);
      try {
        return executeTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "executeClaimedFreeAgentDraftDeadlineReminder",
          tableName: "job_runs",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_DEADLINE_REMINDER_JOB_TYPE:
    JOB_TYPE,
  FREE_AGENT_DRAFT_REMINDER_LEAD_MS:
    REMINDER_LEAD_MS,
  createSqliteFreeAgentDraftDeadlineReminderWriter,
};
