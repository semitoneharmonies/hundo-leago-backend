"use strict";

const crypto = require("node:crypto");

const {
  buildFreeAgentDraftCompletionOccurrenceKey,
  evaluateFreeAgentDraftCompletionEligibility,
  UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftActivityContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftActivityContracts"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  parseCanonicalJsonV1,
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

const JOB_TYPE = "fad_completion";
const WRITER_METHODS = Object.freeze([
  "afterTransition",
  "beforeTransition",
  "executeClaimed",
  "listCandidates",
  "recordFailure",
]);
const SCAN_FIELDS = Object.freeze([
  "limit",
  "nowMs",
]);
const COMMAND_FIELDS = Object.freeze([
  "completedAtMs",
  "fadId",
  "initialWindowEndsAtMs",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "scheduledForMs",
  "seasonId",
]);
const FAILURE_COMMAND_FIELDS = Object.freeze([
  "errorCode",
  "fadId",
  "failedAtMs",
  "initialWindowEndsAtMs",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "scheduledForMs",
  "seasonId",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "attemptCount",
  "expectedVersion",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
  "startedAtMs",
]);
const RESULT_FIELDS = Object.freeze([
  "activityIds",
  "code",
  "completedAtMs",
  "competitionFirstMatchupStartsAtMs",
  "fadId",
  "fadVersion",
  "notificationIds",
  "outboxEventIds",
  "scheduleRecoveryId",
  "scheduleRecoveryOperationId",
  "schemaVersion",
]);
const TERMINAL_CARD_STATUSES = Object.freeze([
  "locked_complete",
  "locked_conflicted",
  "locked_incomplete",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/u;

function invalid(message, reasonCode = "INPUT_INVALID") {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    { details: { reasonCode } }
  );
}

function conflict(message, reasonCode, details = {}) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    {
      details: {
        reasonCode,
        ...details,
      },
    }
  );
}

function incompatible(message, reasonCode, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    {
      details: { reasonCode },
      ...(cause === undefined ? {} : { cause }),
    }
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
    invalid(`An exact ${description} is required.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    invalid(`An exact ${description} is required.`);
  }
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function boundedText(value, maximumLength, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    invalid(`A bounded ${description} is required.`);
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function positiveInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(`A positive ${description} is required.`);
  }
  return value;
}

function nonnegativeInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    incompatible(
      `Persisted ${description} must be nonnegative.`,
      "PERSISTED_COUNT_INVALID"
    );
  }
  return value;
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

function assertSynchronous(value, description) {
  if (value && typeof value.then === "function") {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      `${description} must be synchronous.`
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

function normalizeScan(input) {
  exactObject(
    input,
    SCAN_FIELDS,
    "FAD completion candidate scan"
  );
  const limit = positiveInteger(
    input.limit,
    "FAD completion scan limit"
  );
  if (limit > 100) {
    invalid(
      "The FAD completion scan limit cannot exceed 100."
    );
  }
  return Object.freeze({
    limit,
    nowMs: safeTimestamp(
      input.nowMs,
      "FAD completion scan timestamp"
    ),
    scanLimit: Math.min(400, limit * 4),
  });
}

function normalizeCommand(input) {
  exactObject(
    input,
    COMMAND_FIELDS,
    "FAD completion execution command"
  );
  exactObject(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "FAD completion job execution"
  );
  const fadId = canonicalId(
    input.fadId,
    "Free Agent Draft identifier"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "FAD completion occurrence key"
  );
  let canonicalOccurrenceKey;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftCompletionOccurrenceKey({
        fadId,
      });
  } catch {
    invalid(
      "The FAD completion occurrence key is invalid.",
      "OCCURRENCE_KEY_INVALID"
    );
  }
  const initialWindowEndsAtMs = safeTimestamp(
    input.initialWindowEndsAtMs,
    "initial FAD window end"
  );
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "completion scheduled timestamp"
  );
  const completedAtMs = safeTimestamp(
    input.completedAtMs,
    "FAD completion timestamp"
  );
  const startedAtMs = safeTimestamp(
    input.jobExecution.startedAtMs,
    "completion job start timestamp"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.jobExecution.leaseExpiresAtMs,
    "completion job lease expiry"
  );
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    scheduledForMs !== initialWindowEndsAtMs
  ) {
    invalid(
      "The FAD completion occurrence is not canonical for its scope.",
      "OCCURRENCE_SCOPE_INVALID"
    );
  }
  if (
    completedAtMs < initialWindowEndsAtMs ||
    startedAtMs < scheduledForMs ||
    startedAtMs > completedAtMs ||
    leaseExpiresAtMs <= completedAtMs
  ) {
    conflict(
      "The FAD completion clock or lease is invalid.",
      "COMPLETION_EXECUTION_TIME_INVALID"
    );
  }
  return Object.freeze({
    leagueId: canonicalId(
      input.leagueId,
      "league identifier"
    ),
    seasonId: canonicalId(
      input.seasonId,
      "season identifier"
    ),
    fadId,
    occurrenceKey,
    scheduledForMs,
    initialWindowEndsAtMs,
    completedAtMs,
    runId: canonicalId(
      input.jobExecution.runId,
      "completion job-run identifier"
    ),
    leaseOwner: boundedText(
      input.jobExecution.leaseOwner,
      128,
      "completion lease owner"
    ),
    leaseToken: boundedText(
      input.jobExecution.leaseToken,
      200,
      "completion lease token"
    ),
    leaseExpiresAtMs,
    startedAtMs,
    attemptCount: positiveInteger(
      input.jobExecution.attemptCount,
      "completion job attempt count"
    ),
    expectedJobVersion: positiveInteger(
      input.jobExecution.expectedVersion,
      "completion job version"
    ),
  });
}

function normalizeFailureCommand(input) {
  exactObject(
    input,
    FAILURE_COMMAND_FIELDS,
    "FAD completion failure command"
  );
  const {
    errorCode,
    failedAtMs,
    ...execution
  } = input;
  if (
    typeof errorCode !== "string" ||
    !ERROR_CODE_PATTERN.test(errorCode)
  ) {
    invalid(
      "A canonical FAD completion failure code is required.",
      "FAILURE_ERROR_CODE_INVALID"
    );
  }
  return Object.freeze({
    ...normalizeCommand({
      ...execution,
      completedAtMs: failedAtMs,
    }),
    errorCode,
    failedAtMs,
  });
}

function requireCompletionResult(value) {
  const actual = isPlainObject(value)
    ? Object.keys(value).sort()
    : [];
  const expected = [...RESULT_FIELDS].sort();
  const scheduleRecovered =
    value?.scheduleRecoveryId !== null;
  if (
    !isPlainObject(value) ||
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    ) ||
    value.schemaVersion !== 1 ||
    value.code !== "FAD_COMPLETED" ||
    !UUID_PATTERN.test(value.fadId || "") ||
    !Number.isSafeInteger(value.completedAtMs) ||
    value.completedAtMs < 0 ||
    !Number.isSafeInteger(
      value.competitionFirstMatchupStartsAtMs
    ) ||
    value.competitionFirstMatchupStartsAtMs < 0 ||
    !Number.isSafeInteger(value.fadVersion) ||
    value.fadVersion < 1 ||
    (
      scheduleRecovered
        ? !UUID_PATTERN.test(
            value.scheduleRecoveryId || ""
          ) ||
          !UUID_PATTERN.test(
            value.scheduleRecoveryOperationId || ""
          ) ||
          value.activityIds?.length !== 2
        : value.scheduleRecoveryOperationId !== null ||
          value.activityIds?.length !== 1
    ) ||
    !Array.isArray(value.activityIds) ||
    value.activityIds.some(
      (id) => !UUID_PATTERN.test(id || "")
    ) ||
    new Set(value.activityIds).size !==
      value.activityIds.length ||
    !Array.isArray(value.notificationIds) ||
    value.notificationIds.some(
      (id) => !UUID_PATTERN.test(id || "")
    ) ||
    new Set(value.notificationIds).size !==
      value.notificationIds.length ||
    !Array.isArray(value.outboxEventIds) ||
    value.outboxEventIds.length < 2 ||
    value.outboxEventIds.some(
      (id) => !UUID_PATTERN.test(id || "")
    ) ||
    new Set(value.outboxEventIds).size !==
      value.outboxEventIds.length
  ) {
    incompatible(
      "The persisted FAD completion result is noncanonical.",
      "COMPLETION_RESULT_INVALID"
    );
  }
  return Object.freeze({
    ...value,
    activityIds: Object.freeze([
      ...value.activityIds,
    ]),
    notificationIds: Object.freeze([
      ...value.notificationIds,
    ]),
    outboxEventIds: Object.freeze([
      ...value.outboxEventIds,
    ]),
  });
}

function terminalProjection({
  command,
  result,
  replayed,
}) {
  return Object.freeze({
    outcome: "succeeded",
    replayed,
    runId: command.runId,
    completedAtMs: result.completedAtMs,
    jobVersion: command.expectedJobVersion + 1,
    fadVersion: result.fadVersion,
    scheduleRecoveryId:
      result.scheduleRecoveryId,
    competitionFirstMatchupStartsAtMs:
      result.competitionFirstMatchupStartsAtMs,
    activityIds: result.activityIds,
    notificationIds: result.notificationIds,
    outboxEventIds: result.outboxEventIds,
  });
}

function createSqliteFreeAgentDraftCompletionWriter({
  database,
  scheduleRecoveryService,
  notificationWriter,
  leagueOutboxWriter,
  beforeCommit,
  afterStep,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftCompletionWriter requires an opened database"
    );
  }
  if (
    !scheduleRecoveryService ||
    typeof scheduleRecoveryService.planRecovery !==
      "function"
  ) {
    throw new TypeError(
      "FAD completion requires the schedule-recovery service"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "FAD completion beforeCommit must be a function"
    );
  }
  if (
    afterStep !== undefined &&
    typeof afterStep !== "function"
  ) {
    throw new TypeError(
      "FAD completion afterStep must be a function"
    );
  }

  let notifications;
  let outbox;
  let candidateStatement;
  let rootStatement;
  let jobStatement;
  let cardsStatement;
  let allocationsStatement;
  let rolloversStatement;
  let nominationsStatement;
  let auctionsStatement;
  let recoveriesStatement;
  let unaccountedStatement;
  let quarantineStatement;
  let membersStatement;
  let scheduleWeeksStatement;
  let scheduleMatchupsStatement;
  let scheduleByesStatement;
  let scheduleJobsStatement;
  let resolveCompletionRecoveryStatement;
  let insertActivityStatement;
  let terminalJobStatement;
  let failJobStatement;
  let insertFailureRecoveryStatement;
  let updateFailureRecoveryStatement;
  let activityEvidenceStatement;
  let notificationEvidenceStatement;
  let outboxEvidenceStatement;
  let scheduleRecoveryEvidenceStatement;

  try {
    notifications = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    for (const triggerName of [
      "free_agent_drafts_final_completion_barrier",
      "free_agent_drafts_auction_completion_barrier",
      "free_agent_drafts_resolution_job_completion_barrier",
      "free_agent_drafts_sync_season_completion",
    ]) {
      const trigger = uniqueRow(
        database
          .prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE type = 'trigger'
              AND name = ?
            LIMIT 2
          `)
          .all(triggerName),
        `The ${triggerName} trigger`
      );
      if (!trigger) {
        incompatible(
          "The SQLite schema is missing a FAD completion barrier.",
          "COMPLETION_SCHEMA_BARRIER_MISSING"
        );
      }
    }

    candidateStatement = database.prepare(`
      SELECT
        job.id AS run_id,
        job.league_id,
        job.season_id,
        draft.id AS fad_id,
        job.job_type,
        job.occurrence_key,
        job.scheduled_for_ms,
        job.status,
        job.attempt_count,
        job.next_attempt_at_ms,
        job.lease_expires_at_ms,
        job.version
      FROM job_runs AS job
      JOIN free_agent_drafts AS draft
        ON draft.league_id = job.league_id
       AND draft.season_id = job.season_id
       AND job.occurrence_key =
         'fad:' || draft.id || ':complete'
      JOIN free_agent_draft_rollovers AS seventh
        ON seventh.league_id = draft.league_id
       AND seventh.season_id = draft.season_id
       AND seventh.fad_id = draft.id
       AND seventh.sequence = 7
       AND seventh.window_kind = 'initial'
       AND seventh.rolls_over_at_ms =
         job.scheduled_for_ms
      WHERE job.job_type = '${JOB_TYPE}'
        AND draft.status = 'rapid'
        AND draft.completed_at_ms IS NULL
        AND job.scheduled_for_ms <= @nowMs
        AND (
          (
            job.status = 'pending'
            AND COALESCE(
              job.next_attempt_at_ms,
              job.scheduled_for_ms
            ) <= @nowMs
          )
          OR (
            job.status = 'failed'
            AND job.next_attempt_at_ms IS NOT NULL
            AND job.next_attempt_at_ms <= @nowMs
          )
          OR (
            job.status IN ('leased', 'running')
            AND job.lease_expires_at_ms <= @nowMs
          )
        )
      ORDER BY
        job.scheduled_for_ms,
        job.league_id,
        job.season_id,
        job.id
      LIMIT @scanLimit
    `);
    rootStatement = database.prepare(`
      SELECT
        draft.*,
        season.status AS season_status,
        season.free_agent_draft_completed_at_ms
          AS season_fad_completed_at_ms,
        season.version AS season_version,
        season.nhl_season_key,
        season.regular_season_starts_at_ms,
        season.regular_season_ends_at_ms,
        season.fantasy_playoffs_start_at_ms,
        season.fantasy_playoffs_end_at_ms,
        league.timezone,
        generation.schedule_operation_id,
        generation.schedule_version,
        generation.week_one_matchup_week_id,
        generation.week_one_starts_at_ms,
        generation.status AS generation_status,
        generation.superseded_at_ms,
        generation.version AS generation_version
      FROM free_agent_drafts AS draft
      JOIN seasons AS season
        ON season.league_id = draft.league_id
       AND season.id = draft.season_id
      JOIN leagues AS league
        ON league.id = draft.league_id
      JOIN season_matchup_schedule_generations
        AS generation
        ON generation.league_id = draft.league_id
       AND generation.season_id = draft.season_id
       AND generation.status = 'current'
      WHERE draft.league_id = @leagueId
        AND draft.season_id = @seasonId
        AND draft.id = @fadId
      LIMIT 2
    `);
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
    cardsStatement = database.prepare(`
      SELECT status
      FROM candidate_cards
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY team_id, id
    `);
    allocationsStatement = database.prepare(`
      SELECT status
      FROM free_agent_draft_player_allocations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY player_id, id
    `);
    rolloversStatement = database.prepare(`
      SELECT
        id,
        sequence,
        window_kind,
        predecessor_rollover_id,
        extension_reason,
        extension_source_id,
        opens_at_ms,
        creation_cutoff_at_ms,
        rolls_over_at_ms,
        status
      FROM free_agent_draft_rollovers
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY sequence, id
    `);
    nominationsStatement = database.prepare(`
      SELECT status
      FROM free_agent_draft_nomination_queue
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY id
    `);
    auctionsStatement = database.prepare(`
      SELECT auction.status
      FROM auction_contexts AS context
      JOIN auctions AS auction
        ON auction.league_id = context.league_id
       AND auction.season_id = context.season_id
       AND auction.id = context.auction_id
      WHERE context.league_id = @leagueId
        AND context.season_id = @seasonId
        AND context.fad_id = @fadId
        AND context.source_kind IN (
          'fad_open_rapid',
          'fad_restricted'
        )
      ORDER BY auction.id
    `);
    recoveriesStatement = database.prepare(`
      SELECT id, kind, status, job_run_id,
             created_by_operation_id, last_error_code,
             resolved_at_ms, version
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY created_at_ms, id
    `);
    unaccountedStatement = database.prepare(`
      SELECT
        (
          ABS(
            draft.participating_team_count -
            (
              SELECT COUNT(*)
              FROM candidate_cards AS card
              WHERE card.league_id = draft.league_id
                AND card.season_id = draft.season_id
                AND card.fad_id = draft.id
            )
          )
          + (
              SELECT COUNT(*)
              FROM candidate_cards AS card
              WHERE card.league_id = draft.league_id
                AND card.season_id = draft.season_id
                AND card.fad_id = draft.id
                AND (
                  card.status NOT IN (
                    'locked_complete',
                    'locked_incomplete',
                    'locked_conflicted'
                  )
                  OR (
                    SELECT COUNT(*)
                    FROM candidate_card_snapshots AS snapshot
                    WHERE snapshot.league_id = card.league_id
                      AND snapshot.season_id = card.season_id
                      AND snapshot.fad_id = card.fad_id
                      AND snapshot.card_id = card.id
                  ) <> 1
                )
            )
          + (
              SELECT COUNT(*)
              FROM free_agent_draft_player_allocations AS allocation
              WHERE allocation.league_id = draft.league_id
                AND allocation.season_id = draft.season_id
                AND allocation.fad_id = draft.id
                AND (
                  (
                    SELECT COUNT(*)
                    FROM free_agent_draft_allocation_events AS event
                    WHERE event.league_id = allocation.league_id
                      AND event.season_id = allocation.season_id
                      AND event.fad_id = allocation.fad_id
                      AND event.allocation_id = allocation.id
                      AND event.player_id = allocation.player_id
                      AND event.allocation_version = allocation.version
                      AND event.resulting_allocation_status = allocation.status
                      AND event.decision_code IS allocation.decision_code
                      AND event.contract_id IS allocation.contract_id
                      AND event.ownership_id IS allocation.ownership_id
                      AND event.occurred_at_ms = allocation.updated_at_ms
                      AND event.event_kind IN (
                        'decision_recorded',
                        'restricted_state_changed',
                        'fallback_state_changed',
                        'correction_applied'
                      )
                  ) <> 1
                  OR NOT EXISTS (
                    SELECT 1
                    FROM job_runs AS allocation_job
                    WHERE allocation_job.league_id = allocation.league_id
                      AND allocation_job.season_id = allocation.season_id
                      AND allocation_job.job_type = 'fad_allocation'
                      AND allocation_job.occurrence_key =
                        'fad:' || allocation.fad_id || ':allocate:' ||
                        allocation.player_id
                      AND allocation_job.scheduled_for_ms =
                        draft.candidate_deadline_at_ms
                      AND allocation_job.attempt_count >= 1
                      AND allocation_job.completed_at_ms <= @completedAtMs
                      AND allocation_job.completed_at_ms =
                        allocation_job.updated_at_ms
                      AND allocation_job.lease_owner IS NULL
                      AND allocation_job.lease_token IS NULL
                      AND allocation_job.lease_expires_at_ms IS NULL
                      AND (
                        (
                          allocation_job.status IN ('succeeded', 'skipped')
                          AND allocation_job.last_error_code IS NULL
                        )
                        OR (
                          allocation_job.status = 'failed'
                          AND allocation_job.last_error_code IS NOT NULL
                          AND EXISTS (
                            SELECT 1
                            FROM free_agent_draft_recoveries AS recovery
                            WHERE recovery.league_id = allocation.league_id
                              AND recovery.season_id = allocation.season_id
                              AND recovery.fad_id = allocation.fad_id
                              AND recovery.allocation_id = allocation.id
                              AND recovery.player_id = allocation.player_id
                              AND recovery.job_run_id = allocation_job.id
                              AND recovery.kind = 'allocation_retry'
                              AND recovery.status = 'resolved'
                              AND recovery.resolved_at_ms <= @completedAtMs
                          )
                        )
                      )
                  )
                )
            )
          + (
              SELECT COUNT(*)
              FROM free_agent_draft_rollovers AS rollover
              WHERE rollover.league_id = draft.league_id
                AND rollover.season_id = draft.season_id
                AND rollover.fad_id = draft.id
                AND NOT EXISTS (
                  SELECT 1
                  FROM job_runs AS rollover_job
                  WHERE rollover_job.league_id = rollover.league_id
                    AND rollover_job.season_id = rollover.season_id
                    AND rollover_job.job_type = 'fad_rollover'
                    AND rollover_job.occurrence_key =
                      'fad:' || rollover.fad_id || ':rollover:' ||
                      rollover.sequence || ':' || rollover.rolls_over_at_ms
                    AND rollover_job.scheduled_for_ms =
                      rollover.rolls_over_at_ms
                    AND rollover_job.attempt_count >= 1
                    AND rollover_job.completed_at_ms <= @completedAtMs
                    AND rollover_job.completed_at_ms =
                      rollover_job.updated_at_ms
                    AND rollover_job.lease_owner IS NULL
                    AND rollover_job.lease_token IS NULL
                    AND rollover_job.lease_expires_at_ms IS NULL
                    AND (
                      (
                        rollover_job.status IN ('succeeded', 'skipped')
                        AND rollover_job.last_error_code IS NULL
                      )
                      OR (
                        rollover_job.status = 'failed'
                        AND rollover_job.last_error_code IS NOT NULL
                        AND EXISTS (
                          SELECT 1
                          FROM free_agent_draft_recoveries AS recovery
                          WHERE recovery.league_id = rollover.league_id
                            AND recovery.season_id = rollover.season_id
                            AND recovery.fad_id = rollover.fad_id
                            AND recovery.rollover_id = rollover.id
                            AND recovery.job_run_id = rollover_job.id
                            AND recovery.kind = 'rollover_finalize'
                            AND recovery.status = 'resolved'
                            AND recovery.resolved_at_ms <= @completedAtMs
                        )
                      )
                    )
                )
            )
          + (
              SELECT COUNT(*)
              FROM free_agent_draft_nomination_queue AS nomination
              WHERE nomination.league_id = draft.league_id
                AND nomination.season_id = draft.season_id
                AND nomination.fad_id = draft.id
                AND (
                  nomination.status = 'queued'
                  OR nomination.terminal_at_ms IS NULL
                  OR nomination.terminal_at_ms > @completedAtMs
                  OR (
                    nomination.status = 'invalid'
                    AND (
                      nomination.validation_code IS NULL
                      OR nomination.opened_auction_id IS NOT NULL
                    )
                  )
                  OR (
                    nomination.status = 'opened'
                    AND NOT EXISTS (
                      SELECT 1
                      FROM auction_contexts AS opened_context
                      JOIN auctions AS opened_auction
                        ON opened_auction.league_id = opened_context.league_id
                       AND opened_auction.season_id = opened_context.season_id
                       AND opened_auction.id = opened_context.auction_id
                      WHERE opened_context.league_id = nomination.league_id
                        AND opened_context.season_id = nomination.season_id
                        AND opened_context.fad_id = nomination.fad_id
                        AND opened_context.auction_id =
                          nomination.opened_auction_id
                        AND opened_auction.player_id = nomination.player_id
                        AND opened_auction.status IN (
                          'resolved', 'no_winner', 'cancelled'
                        )
                    )
                  )
                )
            )
          + (
              SELECT COUNT(*)
              FROM auction_contexts AS context
              JOIN auctions AS auction
                ON auction.league_id = context.league_id
               AND auction.season_id = context.season_id
               AND auction.id = context.auction_id
              WHERE context.league_id = draft.league_id
                AND context.season_id = draft.season_id
                AND context.fad_id = draft.id
                AND context.source_kind IN (
                  'fad_open_rapid', 'fad_restricted'
                )
                AND (
                  auction.status NOT IN (
                    'resolved', 'no_winner', 'cancelled'
                  )
                  OR (
                    SELECT COUNT(*)
                    FROM auction_resolutions AS resolution
                    WHERE resolution.league_id = context.league_id
                      AND resolution.season_id = context.season_id
                      AND resolution.auction_id = context.auction_id
                      AND resolution.resolved_at_ms <= @completedAtMs
                      AND (
                        (
                          auction.status = 'resolved'
                          AND resolution.status = 'resolved'
                          AND resolution.outcome_code = 'winner'
                        )
                        OR (
                          auction.status = 'no_winner'
                          AND resolution.status IN ('no_bids', 'no_winner')
                          AND resolution.outcome_code = 'no_winner'
                        )
                        OR (
                          auction.status = 'cancelled'
                          AND resolution.status = 'cancelled'
                          AND resolution.outcome_code IN (
                            'failed', 'recovered',
                            'player_unavailable', 'season_closed'
                          )
                        )
                      )
                  ) <> 1
                  OR NOT (
                    EXISTS (
                      SELECT 1
                      FROM auction_resolutions AS resolution
                      JOIN free_agent_draft_draws AS draw
                        ON draw.league_id = resolution.league_id
                       AND draw.season_id = resolution.season_id
                       AND draw.fad_id = context.fad_id
                       AND draw.allocation_id IS context.fad_allocation_id
                       AND draw.auction_id = resolution.auction_id
                       AND draw.revealed_at_ms = resolution.resolved_at_ms
                       AND draw.version = 2
                      WHERE resolution.league_id = context.league_id
                        AND resolution.season_id = context.season_id
                        AND resolution.auction_id = context.auction_id
                        AND resolution.resolved_at_ms <= @completedAtMs
                    )
                    OR (
                      context.source_kind = 'fad_restricted'
                      AND auction.status = 'cancelled'
                      AND EXISTS (
                        SELECT 1
                        FROM auction_resolutions AS resolution
                        JOIN free_agent_draft_draws AS draw
                          ON draw.league_id = resolution.league_id
                         AND draw.season_id = resolution.season_id
                         AND draw.fad_id = context.fad_id
                         AND draw.allocation_id = context.fad_allocation_id
                         AND draw.auction_id = resolution.auction_id
                         AND draw.revealed_at_ms IS NULL
                         AND draw.version = 1
                        WHERE resolution.league_id = context.league_id
                          AND resolution.season_id = context.season_id
                          AND resolution.auction_id = context.auction_id
                          AND resolution.status = 'cancelled'
                          AND resolution.outcome_code = 'failed'
                      )
                      AND EXISTS (
                        SELECT 1
                        FROM free_agent_draft_recoveries AS recovery
                        WHERE recovery.league_id = context.league_id
                          AND recovery.season_id = context.season_id
                          AND recovery.fad_id = context.fad_id
                          AND recovery.allocation_id =
                            context.fad_allocation_id
                          AND recovery.auction_id = context.auction_id
                          AND recovery.kind = 'auction_resolution'
                          AND recovery.status = 'resolved'
                          AND recovery.resolved_at_ms <= @completedAtMs
                      )
                    )
                  )
                  OR (
                    auction.status IN ('resolved', 'no_winner')
                    AND NOT EXISTS (
                      SELECT 1
                      FROM auction_resolutions AS resolution
                      JOIN job_runs AS resolution_job
                        ON resolution_job.league_id = resolution.league_id
                       AND resolution_job.season_id = resolution.season_id
                       AND resolution_job.job_type = 'auction.resolve.target'
                       AND resolution_job.occurrence_key =
                         resolution.scheduled_occurrence_key
                       AND resolution_job.occurrence_key =
                         'auction:' || auction.id || ':' ||
                         auction.resolves_at_ms
                       AND resolution_job.scheduled_for_ms =
                         auction.resolves_at_ms
                      WHERE resolution.league_id = context.league_id
                        AND resolution.season_id = context.season_id
                        AND resolution.auction_id = context.auction_id
                        AND resolution.outcome_code IN ('winner', 'no_winner')
                        AND resolution_job.status = 'succeeded'
                        AND resolution_job.attempt_count >= 1
                        AND resolution_job.completed_at_ms >=
                          resolution.resolved_at_ms
                        AND resolution_job.completed_at_ms <= @completedAtMs
                        AND resolution_job.lease_owner IS NULL
                        AND resolution_job.lease_token IS NULL
                        AND resolution_job.lease_expires_at_ms IS NULL
                        AND resolution_job.last_error_code IS NULL
                        AND resolution_job.next_attempt_at_ms IS NULL
                        AND resolution_job.updated_at_ms =
                          resolution_job.completed_at_ms
                        AND json_valid(resolution_job.result_json) = 1
                        AND json_extract(
                          resolution_job.result_json, '$.auctionId'
                        ) = auction.id
                        AND json_extract(
                          resolution_job.result_json, '$.outcome'
                        ) = CASE auction.status
                              WHEN 'resolved' THEN 'resolved'
                              WHEN 'no_winner' THEN 'no_winner'
                            END
                    )
                  )
                )
            )
          + CASE WHEN NOT EXISTS (
              SELECT 1
              FROM job_runs AS deadline_job
              WHERE deadline_job.league_id = draft.league_id
                AND deadline_job.season_id = draft.season_id
                AND deadline_job.job_type = 'fad_deadline'
                AND deadline_job.occurrence_key =
                  'fad:' || draft.id || ':deadline:' ||
                  draft.candidate_deadline_at_ms
                AND deadline_job.scheduled_for_ms =
                  draft.candidate_deadline_at_ms
                AND deadline_job.status IN ('succeeded', 'skipped')
                AND deadline_job.attempt_count >= 1
                AND deadline_job.completed_at_ms <= @completedAtMs
                AND deadline_job.completed_at_ms =
                  deadline_job.updated_at_ms
                AND deadline_job.lease_owner IS NULL
                AND deadline_job.lease_token IS NULL
                AND deadline_job.lease_expires_at_ms IS NULL
                AND deadline_job.last_error_code IS NULL
            ) THEN 1 ELSE 0 END
        ) AS unaccounted_path_count
      FROM free_agent_drafts AS draft
      WHERE draft.league_id = @leagueId
        AND draft.season_id = @seasonId
        AND draft.id = @fadId
    `);
    quarantineStatement = database.prepare(`
      SELECT COUNT(DISTINCT player_id) AS quarantined_player_count
      FROM (
        SELECT allocation.player_id
        FROM free_agent_draft_player_allocations AS allocation
        WHERE allocation.league_id = @leagueId
          AND allocation.season_id = @seasonId
          AND allocation.fad_id = @fadId
          AND allocation.status IN (
            'pending', 'restricted_scheduled',
            'restricted_active', 'restricted_fallback_open',
            'correction_required'
          )
        UNION ALL
        SELECT recovery.player_id
        FROM free_agent_draft_recoveries AS recovery
        WHERE recovery.league_id = @leagueId
          AND recovery.season_id = @seasonId
          AND recovery.fad_id = @fadId
          AND recovery.player_id IS NOT NULL
          AND recovery.status IN (
            'pending', 'ready', 'running',
            'correction_required'
          )
        UNION ALL
        SELECT nomination.player_id
        FROM free_agent_draft_nomination_queue AS nomination
        WHERE nomination.league_id = @leagueId
          AND nomination.season_id = @seasonId
          AND nomination.fad_id = @fadId
          AND nomination.status = 'queued'
        UNION ALL
        SELECT auction.player_id
        FROM auctions AS auction
        JOIN auction_contexts AS context
          ON context.league_id = auction.league_id
         AND context.season_id = auction.season_id
         AND context.auction_id = auction.id
         AND context.fad_id = @fadId
         AND context.source_kind IN (
           'fad_open_rapid', 'fad_restricted'
         )
        WHERE auction.league_id = @leagueId
          AND auction.season_id = @seasonId
          AND (
            auction.status IN ('open', 'resolving', 'failed')
            OR EXISTS (
              SELECT 1
              FROM free_agent_draft_recoveries AS recovery
              WHERE recovery.league_id = auction.league_id
                AND recovery.season_id = auction.season_id
                AND recovery.fad_id = context.fad_id
                AND recovery.auction_id = auction.id
                AND recovery.status IN (
                  'pending', 'ready', 'running',
                  'correction_required'
                )
            )
            OR EXISTS (
              SELECT 1
              FROM free_agent_draft_rollovers AS rollover
              WHERE rollover.league_id = context.league_id
                AND rollover.season_id = context.season_id
                AND rollover.fad_id = context.fad_id
                AND rollover.id = context.fad_rollover_id
                AND rollover.status = 'recovery_required'
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_recoveries AS recovery
                  WHERE recovery.league_id = rollover.league_id
                    AND recovery.season_id = rollover.season_id
                    AND recovery.fad_id = rollover.fad_id
                    AND recovery.rollover_id = rollover.id
                    AND recovery.status = 'resolved'
                )
            )
          )
      ) AS quarantined
    `);
    membersStatement = database.prepare(`
      SELECT DISTINCT user.id AS user_id
      FROM league_memberships AS membership
      JOIN users AS user
        ON user.id = membership.user_id
       AND user.status = 'active'
      WHERE membership.league_id = @leagueId
        AND membership.status = 'active'
        AND membership.ended_at_ms IS NULL
      ORDER BY user.id
    `);
    scheduleWeeksStatement = database.prepare(`
      SELECT *
      FROM matchup_weeks
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND week_key LIKE 'regular-%'
      ORDER BY sequence, id
    `);
    scheduleMatchupsStatement = database.prepare(`
      SELECT *
      FROM matchups
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY matchup_week_id, id
    `);
    scheduleByesStatement = database.prepare(`
      SELECT *
      FROM matchup_byes
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY matchup_week_id, id
    `);
    scheduleJobsStatement = database.prepare(`
      SELECT
        job.*,
        binding.id AS binding_id,
        binding.job_type AS binding_job_type,
        binding.schedule_operation_id
          AS binding_schedule_operation_id,
        binding.schedule_version
          AS binding_schedule_version,
        binding.owning_matchup_week_id
          AS binding_owning_matchup_week_id,
        binding.owning_matchup_id
          AS binding_owning_matchup_id,
        binding.created_at_ms
          AS binding_created_at_ms,
        binding.version AS binding_version
      FROM matchup_schedule_job_bindings AS binding
      JOIN job_runs AS job
        ON job.league_id = binding.league_id
       AND job.season_id = binding.season_id
       AND job.id = binding.job_run_id
      WHERE binding.league_id = @leagueId
        AND binding.season_id = @seasonId
        AND binding.schedule_operation_id = @scheduleOperationId
        AND binding.schedule_version = @scheduleVersion
      ORDER BY binding.owning_matchup_week_id,
        job.job_type, job.scheduled_for_ms, job.id
    `);
    resolveCompletionRecoveryStatement = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = NULL,
          resolved_by_membership_id = NULL,
          resolved_authority = 'system',
          updated_at_ms = @completedAtMs,
          resolved_at_ms = @completedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @recoveryId
        AND job_run_id = @runId
        AND created_by_operation_id = @runId
        AND kind = 'completion'
        AND status = 'running'
        AND resolved_at_ms IS NULL
        AND version = @recoveryVersion
    `);
    insertActivityStatement = database.prepare(`
      INSERT INTO league_activity (
        id, league_id, season_id, event_type,
        actor_user_id, actor_authority, team_id,
        player_id, related_type, related_id,
        display_summary, reason, metadata_json,
        occurred_at_ms
      ) VALUES (
        @activityId, @leagueId, @seasonId,
        @eventType, NULL, 'system', NULL, NULL,
        'free_agent_draft', @fadId,
        @displaySummary, NULL, @metadataJson,
        @completedAtMs
      )
    `);
    terminalJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @completedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @completedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
        AND status = 'running'
        AND attempt_count = @attemptCount
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms = @leaseExpiresAtMs
        AND lease_expires_at_ms > @completedAtMs
        AND started_at_ms = @startedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedJobVersion
    `);
    failJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @completedAtMs,
          result_json = NULL,
          last_error_code = @errorCode,
          next_attempt_at_ms = @nextAttemptAtMs,
          updated_at_ms = @completedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
        AND status = 'running'
        AND attempt_count = @attemptCount
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms = @leaseExpiresAtMs
        AND lease_expires_at_ms > @completedAtMs
        AND started_at_ms = @startedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedJobVersion
    `);
    insertFailureRecoveryStatement = database.prepare(`
      INSERT INTO free_agent_draft_recoveries (
        id, league_id, season_id, fad_id,
        player_id, allocation_id, rollover_id,
        auction_id, job_run_id, kind, status,
        earliest_activation_at_ms,
        target_resolution_at_ms, last_error_code,
        commissioner_reason, created_by_operation_id,
        resolved_by_user_id, resolved_by_membership_id,
        resolved_authority, created_at_ms, updated_at_ms,
        resolved_at_ms, version, nomination_queue_id
      ) VALUES (
        @recoveryId, @leagueId, @seasonId, @fadId,
        NULL, NULL, NULL, NULL, @runId,
        'completion', 'correction_required', NULL, NULL,
        @errorCode, NULL, @runId, NULL, NULL, NULL,
        @completedAtMs, @completedAtMs, NULL, 1, NULL
      )
    `);
    updateFailureRecoveryStatement = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'correction_required',
          last_error_code = @errorCode,
          updated_at_ms = @completedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @recoveryId
        AND job_run_id = @runId
        AND created_by_operation_id = @runId
        AND kind = 'completion'
        AND status = 'running'
        AND resolved_at_ms IS NULL
        AND version = @recoveryVersion
    `);
    activityEvidenceStatement = database.prepare(`
      SELECT *
      FROM league_activity
      WHERE id = @activityId
      LIMIT 2
    `);
    notificationEvidenceStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE id = @notificationId
      LIMIT 2
    `);
    outboxEvidenceStatement = database.prepare(`
      SELECT
        event.*,
        (
          SELECT COUNT(*)
          FROM outbox_event_audiences AS audience
          WHERE audience.league_id = event.league_id
            AND audience.outbox_event_id = event.id
        ) AS audience_count,
        (
          SELECT COUNT(*)
          FROM outbox_event_audiences AS audience
          WHERE audience.league_id = event.league_id
            AND audience.outbox_event_id = event.id
            AND audience.audience_kind = 'league'
            AND audience.team_id IS NULL
            AND audience.user_id IS NULL
        ) AS league_audience_count
        ,(
          SELECT audience.user_id
          FROM outbox_event_audiences AS audience
          WHERE audience.league_id = event.league_id
            AND audience.outbox_event_id = event.id
            AND audience.audience_kind = 'user'
            AND audience.team_id IS NULL
          LIMIT 1
        ) AS audience_user_id
      FROM outbox_events AS event
      WHERE event.id = @outboxEventId
      LIMIT 2
    `);
    scheduleRecoveryEvidenceStatement = database.prepare(`
      SELECT
        id,
        recovery_kind,
        new_first_matchup_week_id,
        new_week_one_starts_at_ms,
        completed_at_ms
      FROM free_agent_draft_schedule_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @scheduleRecoveryId
      LIMIT 2
    `);
  } catch (error) {
    if (
      error instanceof Error &&
      error.code?.startsWith?.("REPOSITORY_")
    ) {
      throw error;
    }
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftCompletionWriter",
      tableName: "free_agent_drafts",
    });
  }

  function after(step, details) {
    if (afterStep) {
      assertSynchronous(
        afterStep(step, details),
        `FAD completion ${step} injection`
      );
    }
  }

  function candidateFromRow(row) {
    if (
      !UUID_PATTERN.test(row.run_id || "") ||
      !UUID_PATTERN.test(row.league_id || "") ||
      !UUID_PATTERN.test(row.season_id || "") ||
      !UUID_PATTERN.test(row.fad_id || "") ||
      row.job_type !== JOB_TYPE ||
      row.occurrence_key !==
        buildFreeAgentDraftCompletionOccurrenceKey({
          fadId: row.fad_id,
        }) ||
      !Number.isSafeInteger(row.scheduled_for_ms) ||
      row.scheduled_for_ms < 0 ||
      !["pending", "failed", "leased", "running"].includes(
        row.status
      ) ||
      (
        row.status === "failed" &&
        !Number.isSafeInteger(row.next_attempt_at_ms)
      ) ||
      !Number.isSafeInteger(row.attempt_count) ||
      row.attempt_count < 0 ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1
    ) {
      incompatible(
        "A durable FAD completion candidate is noncanonical.",
        "COMPLETION_CANDIDATE_INVALID"
      );
    }
    return Object.freeze({
      runId: row.run_id,
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      jobType: JOB_TYPE,
      occurrenceKey: row.occurrence_key,
      scheduledForMs: row.scheduled_for_ms,
      initialWindowEndsAtMs:
        row.scheduled_for_ms,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAtMs: row.next_attempt_at_ms,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      version: row.version,
    });
  }

  function requireRoot(
    command,
    {
      allowCompleted = false,
      pendingScheduleRecoveryPlan = null,
    } = {}
  ) {
    const root = uniqueRow(
      rootStatement.all(command),
      "The FAD completion root"
    );
    const normalScheduleBinding =
      pendingScheduleRecoveryPlan === null &&
      root?.current_competition_first_matchup_week_id ===
        root?.week_one_matchup_week_id;
    const pendingRecoveryBinding =
      isPlainObject(pendingScheduleRecoveryPlan) &&
      pendingScheduleRecoveryPlan.action ===
        "stage_recovery" &&
      isPlainObject(
        pendingScheduleRecoveryPlan.recovery
      ) &&
      root?.current_competition_first_matchup_week_id ===
        pendingScheduleRecoveryPlan.recovery
          .oldFirstMatchupWeekId &&
      root?.first_matchup_week_id ===
        pendingScheduleRecoveryPlan.recovery
          .oldFirstMatchupWeekId &&
      root?.first_matchup_starts_at_ms ===
        pendingScheduleRecoveryPlan.recovery
          .oldWeekOneStartsAtMs &&
      root?.week_one_matchup_week_id ===
        pendingScheduleRecoveryPlan.recovery
          .newFirstMatchupWeekId &&
      root?.week_one_starts_at_ms ===
        pendingScheduleRecoveryPlan.recovery
          .newWeekOneStartsAtMs &&
      root?.schedule_operation_id ===
        pendingScheduleRecoveryPlan.recovery
          .newScheduleOperationId &&
      root?.schedule_version ===
        pendingScheduleRecoveryPlan.recovery
          .newScheduleVersion;
    if (
      !root ||
      root.season_status !== "active" ||
      root.generation_status !== "current" ||
      root.superseded_at_ms !== null ||
      (!normalScheduleBinding &&
        !pendingRecoveryBinding) ||
      root.first_matchup_starts_at_ms >
        root.week_one_starts_at_ms ||
      (
        allowCompleted
          ? !["rapid", "completed"].includes(root.status)
          : root.status !== "rapid"
      )
    ) {
      conflict(
        "The FAD completion job lost its aggregate or schedule binding.",
        "FAD_BINDING_CHANGED"
      );
    }
    return root;
  }

  function requireLiveJob(command) {
    const job = uniqueRow(
      jobStatement.all(command),
      "The claimed FAD completion job"
    );
    if (
      !job ||
      job.status !== "running" ||
      job.attempt_count !== command.attemptCount ||
      job.lease_owner !== command.leaseOwner ||
      job.lease_token !== command.leaseToken ||
      job.lease_expires_at_ms !==
        command.leaseExpiresAtMs ||
      job.lease_expires_at_ms <= command.completedAtMs ||
      job.started_at_ms !== command.startedAtMs ||
      job.completed_at_ms !== null ||
      job.result_json !== null ||
      job.last_error_code !== null ||
      job.next_attempt_at_ms !== null ||
      job.version !== command.expectedJobVersion
    ) {
      conflict(
        "The FAD completion job lease, attempt, or version changed.",
        "JOB_LEASE_CHANGED"
      );
    }
    return job;
  }

  function mapRollover(row) {
    return Object.freeze({
      id: row.id,
      sequence: row.sequence,
      windowKind: row.window_kind,
      predecessorRolloverId:
        row.predecessor_rollover_id,
      extensionReason: row.extension_reason,
      extensionSourceId: row.extension_source_id,
      opensAtMs: row.opens_at_ms,
      creationCutoffAtMs:
        row.creation_cutoff_at_ms,
      rollsOverAtMs: row.rolls_over_at_ms,
      status: row.status,
    });
  }

  function loadEligibility(
    command,
    {
      projectCompletionRecovery = false,
      pendingScheduleRecoveryPlan = null,
    } = {}
  ) {
    const root = requireRoot(command, {
      pendingScheduleRecoveryPlan,
    });
    const recoveryRows = recoveriesStatement.all(command);
    const unresolvedRecoveries = recoveryRows.filter(
      ({ status }) => status !== "resolved"
    );
    const projectable =
      projectCompletionRecovery &&
      unresolvedRecoveries.length === 1 &&
      unresolvedRecoveries[0].kind === "completion" &&
      unresolvedRecoveries[0].status === "running" &&
      unresolvedRecoveries[0].job_run_id === command.runId;
    const unaccounted = unaccountedStatement.get({
      ...command,
      completedAtMs: command.completedAtMs,
    });
    const quarantine = quarantineStatement.get(command);
    let evaluation;
    try {
      evaluation =
        evaluateFreeAgentDraftCompletionEligibility({
          status: root.status,
          nowMs: command.completedAtMs,
          candidateDeadlineAtMs:
            root.candidate_deadline_at_ms,
          rollovers: rolloversStatement
            .all(command)
            .map(mapRollover),
          cardStatuses: cardsStatement
            .all(command)
            .map(({ status }) => status),
          allocationStatuses: allocationsStatement
            .all(command)
            .map(({ status }) => status),
          nominationStatuses: nominationsStatement
            .all(command)
            .map(({ status }) => status),
          auctionStatuses: auctionsStatement
            .all(command)
            .map(({ status }) => status),
          recoveryStatuses: recoveryRows.map(
            (recovery) =>
              projectable &&
              recovery.id === unresolvedRecoveries[0].id
                ? "resolved"
                : recovery.status
          ),
          unaccountedPathCount: nonnegativeInteger(
            unaccounted?.unaccounted_path_count,
            "FAD unaccounted-path count"
          ),
          quarantinedPlayerCount: nonnegativeInteger(
            quarantine?.quarantined_player_count,
            "FAD quarantined-player count"
          ),
        });
    } catch (error) {
      incompatible(
        "Persisted FAD completion evidence cannot be evaluated.",
        "COMPLETION_EVIDENCE_INVALID",
        error
      );
    }
    return Object.freeze({
      root,
      recoveryRows: Object.freeze(recoveryRows),
      projectableRecovery: projectable
        ? Object.freeze({ ...unresolvedRecoveries[0] })
        : null,
      evaluation,
    });
  }

  function requireEligible(
    command,
    { pendingScheduleRecoveryPlan = null } = {}
  ) {
    const projected = loadEligibility(command, {
      projectCompletionRecovery: true,
      pendingScheduleRecoveryPlan,
    });
    if (!projected.evaluation.eligible) {
      conflict(
        "The FAD still has nonterminal or unaccounted work.",
        "COMPLETION_NOT_ELIGIBLE",
        {
          reasonCodes:
            projected.evaluation.reasonCodes,
        }
      );
    }
    if (projected.projectableRecovery) {
      const recovery = projected.projectableRecovery;
      if (
        resolveCompletionRecoveryStatement.run({
          ...command,
          recoveryId: recovery.id,
          recoveryVersion: recovery.version,
        }).changes !== 1
      ) {
        conflict(
          "The active FAD completion recovery changed.",
          "COMPLETION_RECOVERY_CHANGED"
        );
      }
    }
    const strict = loadEligibility(command, {
      pendingScheduleRecoveryPlan,
    });
    if (!strict.evaluation.eligible) {
      conflict(
        "The FAD completion evidence changed before commit.",
        "COMPLETION_NOT_ELIGIBLE",
        {
          reasonCodes: strict.evaluation.reasonCodes,
        }
      );
    }
    return strict;
  }

  function scheduleContext(command, root) {
    const weekRows = scheduleWeeksStatement.all(command);
    const matchupRows = scheduleMatchupsStatement.all(
      command
    );
    const byeRows = scheduleByesStatement.all(command);
    const matchupsByWeek = new Map();
    for (const matchup of matchupRows) {
      const rows =
        matchupsByWeek.get(matchup.matchup_week_id) || [];
      rows.push(
        Object.freeze({
          id: matchup.id,
          leagueId: matchup.league_id,
          seasonId: matchup.season_id,
          weekId: matchup.matchup_week_id,
          homeTeamId: matchup.home_team_id,
          awayTeamId: matchup.away_team_id,
          status: matchup.status,
          version: matchup.version,
        })
      );
      matchupsByWeek.set(matchup.matchup_week_id, rows);
    }
    const byesByWeek = new Map();
    for (const bye of byeRows) {
      if (byesByWeek.has(bye.matchup_week_id)) {
        incompatible(
          "A matchup week has ambiguous bye evidence.",
          "SCHEDULE_BYE_AMBIGUOUS"
        );
      }
      byesByWeek.set(
        bye.matchup_week_id,
        Object.freeze({
          id: bye.id,
          leagueId: bye.league_id,
          seasonId: bye.season_id,
          weekId: bye.matchup_week_id,
          teamId: bye.team_id,
        })
      );
    }
    const weeks = weekRows.map((week) =>
      Object.freeze({
        id: week.id,
        leagueId: week.league_id,
        seasonId: week.season_id,
        weekKey: week.week_key,
        sequence: week.sequence,
        startsAtMs: week.starts_at_ms,
        baselineAtMs: week.baseline_at_ms,
        locksAtMs: week.locks_at_ms,
        endsAtMs: week.ends_at_ms,
        rollsOverAtMs: week.rolls_over_at_ms,
        status: week.status,
        version: week.version,
        matchups: Object.freeze(
          matchupsByWeek.get(week.id) || []
        ),
        bye: byesByWeek.get(week.id) || null,
      })
    );
    const jobs = scheduleJobsStatement
      .all({
        ...command,
        scheduleOperationId:
          root.schedule_operation_id,
        scheduleVersion: root.schedule_version,
      })
      .map((job) =>
        Object.freeze({
          id: job.id,
          leagueId: job.league_id,
          seasonId: job.season_id,
          weekId:
            job.binding_owning_matchup_week_id,
          jobType: job.job_type,
          occurrenceKey: job.occurrence_key,
          scheduledForMs: job.scheduled_for_ms,
          status: job.status,
          attemptCount: job.attempt_count,
          leaseOwner: job.lease_owner,
          leaseToken: job.lease_token,
          leaseExpiresAtMs: job.lease_expires_at_ms,
          startedAtMs: job.started_at_ms,
          completedAtMs: job.completed_at_ms,
          resultJson: job.result_json,
          lastErrorCode: job.last_error_code,
          createdAtMs: job.created_at_ms,
          updatedAtMs: job.updated_at_ms,
          version: job.version,
          nextAttemptAtMs: job.next_attempt_at_ms,
          bindingId: job.binding_id,
          bindingJobType: job.binding_job_type,
          bindingScheduleOperationId:
            job.binding_schedule_operation_id,
          bindingScheduleVersion:
            job.binding_schedule_version,
          bindingOwningMatchupWeekId:
            job.binding_owning_matchup_week_id,
          bindingOwningMatchupId:
            job.binding_owning_matchup_id,
          bindingCreatedAtMs:
            job.binding_created_at_ms,
          bindingVersion: job.binding_version,
        })
      );
    return Object.freeze({
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      recovery: Object.freeze({
        kind: "completion",
        atMs: command.completedAtMs,
        frozenFadFirstMatchupStartsAtMs:
          root.first_matchup_starts_at_ms,
      }),
      calendar: Object.freeze({
        nhlSeasonKey: root.nhl_season_key,
        nhlRegularSeasonStartsAtMs:
          root.regular_season_starts_at_ms,
        nhlRegularSeasonEndsAtMs:
          root.regular_season_ends_at_ms,
        fantasyPlayoffsStartAtMs:
          root.fantasy_playoffs_start_at_ms,
        fantasyPlayoffsEndAtMs:
          root.fantasy_playoffs_end_at_ms,
        timeZone: root.timezone,
      }),
      currentGeneration: Object.freeze({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        scheduleVersion: root.schedule_version,
        scheduleOperationId:
          root.schedule_operation_id,
        weekOneMatchupWeekId:
          root.week_one_matchup_week_id,
        weekOneStartsAtMs:
          root.week_one_starts_at_ms,
        status: root.generation_status,
        supersededAtMs: root.superseded_at_ms,
        version: root.generation_version,
      }),
      weeks: Object.freeze(weeks),
      jobs: Object.freeze(jobs),
    });
  }

  function transitionCommand(
    command,
    root,
    scheduleRecoveryPlan
  ) {
    return Object.freeze({
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      expectedVersion: root.version,
      fromStatus: "rapid",
      toStatus: "completed",
      occurredAtMs: command.completedAtMs,
      schedule: Object.freeze({
        operationId: root.schedule_operation_id,
        version: root.schedule_version,
        weekOneMatchupWeekId:
          root.week_one_matchup_week_id,
        weekOneStartsAtMs:
          root.week_one_starts_at_ms,
      }),
      scheduleRecoveryPlan,
      jobExecution: Object.freeze({
        runId: command.runId,
        jobType: JOB_TYPE,
        occurrenceKey: command.occurrenceKey,
        scheduledForMs: command.scheduledForMs,
        leaseOwner: command.leaseOwner,
        leaseToken: command.leaseToken,
        leaseExpiresAtMs:
          command.leaseExpiresAtMs,
        startedAtMs: command.startedAtMs,
        attemptCount: command.attemptCount,
        expectedVersion:
          command.expectedJobVersion,
      }),
    });
  }

  function requireHookCommand(input) {
    if (
      !isPlainObject(input) ||
      input.fromStatus !== "rapid" ||
      input.toStatus !== "completed" ||
      !isPlainObject(input.existing) ||
      !isPlainObject(input.jobExecution) ||
      input.jobExecution.jobType !== JOB_TYPE
    ) {
      invalid(
        "The completion writer requires a rapid-to-completed lifecycle command.",
        "TRANSITION_COMMAND_INVALID"
      );
    }
    const command = normalizeCommand({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      fadId: input.fadId,
      initialWindowEndsAtMs:
        input.jobExecution.scheduledForMs,
      occurrenceKey:
        input.jobExecution.occurrenceKey,
      scheduledForMs:
        input.jobExecution.scheduledForMs,
      completedAtMs: input.occurredAtMs,
      jobExecution: {
        runId: input.jobExecution.runId,
        leaseOwner:
          input.jobExecution.leaseOwner,
        leaseToken:
          input.jobExecution.leaseToken,
        leaseExpiresAtMs:
          input.jobExecution.leaseExpiresAtMs,
        startedAtMs:
          input.jobExecution.startedAtMs,
        attemptCount:
          input.jobExecution.attemptCount,
        expectedVersion:
          input.jobExecution.expectedVersion,
      },
    });
    if (
      input.expectedVersion !== input.existing.version ||
      input.existing.status !== "rapid" ||
      input.existing.id !== command.fadId ||
      input.existing.leagueId !== command.leagueId ||
      input.existing.seasonId !== command.seasonId
    ) {
      conflict(
        "The completion lifecycle witness changed.",
        "TRANSITION_WITNESS_CHANGED"
      );
    }
    return command;
  }

  function beforeTransition(input = {}) {
    if (database.inTransaction !== true) {
      invalid(
        "FAD completion evidence requires the lifecycle transaction.",
        "TRANSACTION_REQUIRED"
      );
    }
    const command = requireHookCommand(input);
    requireLiveJob(command);
    const root = requireEligible(command, {
      pendingScheduleRecoveryPlan:
        input.scheduleRecoveryPlan,
    }).root;
    if (
      root.version !== input.expectedVersion ||
      root.updated_at_ms > command.completedAtMs
    ) {
      conflict(
        "The FAD completion root changed before transition.",
        "FAD_VERSION_CHANGED"
      );
    }
    return Object.freeze({
      evaluatedAtMs: command.completedAtMs,
      fadVersion: root.version,
    });
  }

  function writeActivities(command, updated, plan) {
    const activityIds = [];
    if (plan !== null) {
      const activityId = deterministicUuid(
        `fad-completion:activity:week1:${command.runId}`
      );
      const activityContract =
        createFreeAgentDraftActivityContract({
          eventType:
            "free_agent_draft_week1_recovered",
          metadata: {
            competitionFirstMatchupStartsAtMs:
              plan.recovery.newWeekOneStartsAtMs,
            fadId: command.fadId,
            scheduleRecoveryOperationId:
              plan.operation.id,
          },
        });
      insertActivityStatement.run({
        ...command,
        activityId,
        eventType:
          "free_agent_draft_week1_recovered",
        displaySummary:
          "Week 1 moved to complete the Free Agent Draft fairly.",
        metadataJson: serializeCanonicalJsonV1(
          activityContract.metadata
        ),
      });
      activityIds.push(activityId);
    }
    const completedActivityId = deterministicUuid(
      `fad-completion:activity:completed:${command.runId}`
    );
    const completedActivityContract =
      createFreeAgentDraftActivityContract({
        eventType: "free_agent_draft_completed",
        metadata: {
          completedAtMs: command.completedAtMs,
          fadId: command.fadId,
        },
      });
    insertActivityStatement.run({
      ...command,
      activityId: completedActivityId,
      eventType: "free_agent_draft_completed",
      displaySummary:
        "The Free Agent Draft is complete.",
      metadataJson: serializeCanonicalJsonV1(
        completedActivityContract.metadata
      ),
    });
    activityIds.push(completedActivityId);
    return Object.freeze(activityIds);
  }

  function writeNotifications(command, plan) {
    const userIds = membersStatement
      .all(command)
      .map(({ user_id: userId }) => userId);
    if (
      userIds.some(
        (userId) => !UUID_PATTERN.test(userId || "")
      ) ||
      new Set(userIds).size !== userIds.length
    ) {
      incompatible(
        "The FAD completion notification audience is noncanonical.",
        "NOTIFICATION_AUDIENCE_INVALID"
      );
    }
    const notificationIds = [];
    const publications = [];
    for (const userId of userIds) {
      if (plan !== null) {
        const recoveryKey =
          `fad:${command.fadId}:week1-recovered:` +
          `${plan.operation.id}:${userId}`;
        const notificationId = deterministicUuid(
          `fad-completion:notification:${recoveryKey}`
        );
        const notificationContract =
          createFreeAgentDraftNotificationContract({
            type: "fad_week1_recovered",
            recipientUserId: userId,
            messageData: {
              leagueId: command.leagueId,
              seasonId: command.seasonId,
              fadId: command.fadId,
              scheduleRecoveryOperationId:
                plan.operation.id,
              competitionFirstMatchupStartsAtMs:
                plan.recovery.newWeekOneStartsAtMs,
              destination: {
                kind: "fad_overview",
                leagueId: command.leagueId,
                fadId: command.fadId,
              },
            },
          });
        const inserted = assertSynchronous(
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
            createdAtMs: command.completedAtMs,
            deliveredAtMs: null,
            deduplicationKey:
              notificationContract.deduplicationKey,
          }),
          "FAD Week 1 recovery notification write"
        );
        if (
          inserted?.notification?.id !== notificationId
        ) {
          incompatible(
            "The FAD Week 1 notification writer returned inconsistent evidence.",
            "NOTIFICATION_WRITE_INVALID"
          );
        }
        notificationIds.push(notificationId);
        publications.push(Object.freeze({
          notificationId,
          userId,
          reasonCode: "week1_recovered",
          scheduleRecoveryOperationId:
            plan.operation.id,
        }));
      }
      const completionKey =
        `fad:${command.fadId}:completed:${userId}`;
      const notificationId = deterministicUuid(
        `fad-completion:notification:${completionKey}`
      );
      const notificationContract =
        createFreeAgentDraftNotificationContract({
          type: "fad_completed",
          recipientUserId: userId,
          messageData: {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            fadId: command.fadId,
            completedAtMs: command.completedAtMs,
            destination: {
              kind: "fad_overview",
              leagueId: command.leagueId,
              fadId: command.fadId,
            },
          },
        });
      const inserted = assertSynchronous(
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
          createdAtMs: command.completedAtMs,
          deliveredAtMs: null,
          deduplicationKey:
            notificationContract.deduplicationKey,
        }),
        "FAD completion notification write"
      );
      if (
        inserted?.notification?.id !== notificationId
      ) {
        incompatible(
          "The FAD completion notification writer returned inconsistent evidence.",
          "NOTIFICATION_WRITE_INVALID"
        );
      }
      notificationIds.push(notificationId);
      publications.push(Object.freeze({
        notificationId,
        userId,
        reasonCode: "completed",
        scheduleRecoveryOperationId: null,
      }));
    }
    return Object.freeze({
      notificationIds: Object.freeze(notificationIds),
      publications: Object.freeze(publications),
    });
  }

  function writeOutbox(
    command,
    updated,
    plan,
    activityIds,
    notificationPublications
  ) {
    const recoveredActivityId =
      plan === null ? null : activityIds[0];
    const completedActivityId =
      activityIds.at(-1);
    const publications = [
      ...(plan === null
        ? []
        : [
            Object.freeze({
              label: "draft:week1-recovered",
              eventType: "free_agent_draft.changed",
              aggregateType: "free_agent_draft",
              aggregateId: command.fadId,
              version: updated.version,
              reasonCode: "week1_recovered",
              scheduleRecoveryOperationId:
                plan.operation.id,
              audiences: [{ kind: "league" }],
            }),
            Object.freeze({
              label: "activity:week1-recovered",
              eventType: "activity.created",
              aggregateType: "league_activity",
              aggregateId: recoveredActivityId,
              version: 1,
              reasonCode: "week1_recovered",
              scheduleRecoveryOperationId:
                plan.operation.id,
              audiences: [{ kind: "league" }],
            }),
          ]),
      Object.freeze({
        label: "draft:completed",
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: command.fadId,
        version: updated.version,
        reasonCode: "completed",
        scheduleRecoveryOperationId: null,
        audiences: [{ kind: "league" }],
      }),
      Object.freeze({
        label: "activity:completed",
        eventType: "activity.created",
        aggregateType: "league_activity",
        aggregateId: completedActivityId,
        version: 1,
        reasonCode: "completed",
        scheduleRecoveryOperationId: null,
        audiences: [{ kind: "league" }],
      }),
      ...notificationPublications.map((publication) =>
        Object.freeze({
          label: `notification:${publication.notificationId}`,
          eventType: "notification.created",
          aggregateType: "notification",
          aggregateId: publication.notificationId,
          version: 1,
          reasonCode: publication.reasonCode,
          scheduleRecoveryOperationId:
            publication.scheduleRecoveryOperationId,
          audiences: [{
            kind: "user",
            userId: publication.userId,
          }],
        })
      ),
    ];
    const outboxEventIds = [];
    for (const publication of publications) {
      const outboxEventId = deterministicUuid(
        `fad-completion:outbox:${publication.label}:` +
          command.runId
      );
      const written = assertSynchronous(
        outbox.write({
          id: outboxEventId,
          leagueId: command.leagueId,
          eventType: publication.eventType,
          aggregateType: publication.aggregateType,
          aggregateId: publication.aggregateId,
          payload: createSocketEventMetadata({
            eventType: publication.eventType,
            version: publication.version,
            reasonCode: publication.reasonCode,
            occurredAtMs: command.completedAtMs,
            related: createEmptySocketRelated({
              fadId: command.fadId,
              scheduleRecoveryOperationId:
                publication.scheduleRecoveryOperationId,
            }),
          }),
          occurredAtMs: command.completedAtMs,
          audiences: publication.audiences,
        }),
        "FAD completion outbox write"
      );
      if (written?.event?.id !== outboxEventId) {
        incompatible(
          "The FAD completion outbox writer returned inconsistent evidence.",
          "OUTBOX_WRITE_INVALID"
        );
      }
      outboxEventIds.push(outboxEventId);
    }
    return Object.freeze(outboxEventIds);
  }

  function requirePersistedPublications(command, result) {
    const activityPublications = new Map();
    for (const activityId of result.activityIds) {
      const activity = uniqueRow(
        activityEvidenceStatement.all({ activityId }),
        "The FAD completion activity"
      );
      let activityContract;
      let expectedActivityContract;
      try {
        const metadata = activity
          ? parseCanonicalJsonV1(
              activity.metadata_json
            )
          : null;
        activityContract =
          createFreeAgentDraftActivityContract({
            eventType: activity?.event_type,
            metadata,
          });
        expectedActivityContract =
          createFreeAgentDraftActivityContract(
            activity?.event_type ===
              "free_agent_draft_week1_recovered"
              ? {
                  eventType:
                    "free_agent_draft_week1_recovered",
                  metadata: {
                    competitionFirstMatchupStartsAtMs:
                      result.competitionFirstMatchupStartsAtMs,
                    fadId: command.fadId,
                    scheduleRecoveryOperationId:
                      result.scheduleRecoveryOperationId,
                  },
                }
              : {
                  eventType:
                    "free_agent_draft_completed",
                  metadata: {
                    completedAtMs: result.completedAtMs,
                    fadId: command.fadId,
                  },
                }
          );
      } catch (error) {
        incompatible(
          "The FAD completion activity metadata violates its contract.",
          "PUBLICATION_ACTIVITY_INVALID",
          error
        );
      }
      if (
        !activity ||
        activity.league_id !== command.leagueId ||
        activity.season_id !== command.seasonId ||
        ![
          "free_agent_draft_week1_recovered",
          "free_agent_draft_completed",
        ].includes(activity.event_type) ||
        activity.actor_user_id !== null ||
        activity.actor_authority !== "system" ||
        activity.related_type !== "free_agent_draft" ||
        activity.related_id !== command.fadId ||
        activity.occurred_at_ms !== result.completedAtMs ||
        activity.metadata_json !==
          serializeCanonicalJsonV1(
            activityContract.metadata
          ) ||
        JSON.stringify(activityContract.metadata) !==
          JSON.stringify(
            expectedActivityContract.metadata
          )
      ) {
        incompatible(
          "The FAD completion activity is unavailable or noncanonical.",
          "PUBLICATION_ACTIVITY_INVALID"
        );
      }
      const reasonCode =
        activity.event_type ===
        "free_agent_draft_week1_recovered"
          ? "week1_recovered"
          : "completed";
      activityPublications.set(activityId, {
        reasonCode,
        scheduleRecoveryOperationId:
          reasonCode === "week1_recovered"
            ? result.scheduleRecoveryOperationId
            : null,
      });
    }
    const notificationPublications = new Map();
    for (const notificationId of result.notificationIds) {
      const notification = uniqueRow(
        notificationEvidenceStatement.all({
          notificationId,
        }),
        "The FAD completion notification"
      );
      let message;
      let notificationContract;
      let expectedNotificationContract;
      try {
        message = notification
          ? JSON.parse(notification.message_data_json)
          : null;
        notificationContract =
          createFreeAgentDraftNotificationContract({
            type: notification?.event_type,
            recipientUserId:
              notification?.user_id,
            messageData: message,
          });
        expectedNotificationContract =
          createFreeAgentDraftNotificationContract(
            notification?.event_type ===
              "fad_week1_recovered"
              ? {
                  type: "fad_week1_recovered",
                  recipientUserId:
                    notification?.user_id,
                  messageData: {
                    leagueId: command.leagueId,
                    seasonId: command.seasonId,
                    fadId: command.fadId,
                    scheduleRecoveryOperationId:
                      result.scheduleRecoveryOperationId,
                    competitionFirstMatchupStartsAtMs:
                      result.competitionFirstMatchupStartsAtMs,
                    destination: {
                      kind: "fad_overview",
                      leagueId: command.leagueId,
                      fadId: command.fadId,
                    },
                  },
                }
              : {
                  type: "fad_completed",
                  recipientUserId:
                    notification?.user_id,
                  messageData: {
                    leagueId: command.leagueId,
                    seasonId: command.seasonId,
                    fadId: command.fadId,
                    completedAtMs: result.completedAtMs,
                    destination: {
                      kind: "fad_overview",
                      leagueId: command.leagueId,
                      fadId: command.fadId,
                    },
                  },
                }
          );
      } catch (error) {
        incompatible(
          "The FAD completion notification violates its contract.",
          "PUBLICATION_NOTIFICATION_INVALID",
          error
        );
      }
      if (
        !notification ||
        ![
          "fad_week1_recovered",
          "fad_completed",
        ].includes(notification.event_type) ||
        notification.league_id !== command.leagueId ||
        notification.related_feature !==
          "free_agent_draft" ||
        notification.related_record_id !== command.fadId ||
        notification.created_at_ms !== result.completedAtMs ||
        notification.message_data_json !==
          JSON.stringify(
            notificationContract.messageData
          ) ||
        JSON.stringify(notificationContract.messageData) !==
          JSON.stringify(
            expectedNotificationContract.messageData
          ) ||
        notification.deduplication_key !==
          notificationContract.deduplicationKey ||
        notificationContract.deduplicationKey !==
          expectedNotificationContract.deduplicationKey
      ) {
        incompatible(
          "A FAD completion notification is unavailable or noncanonical.",
          "PUBLICATION_NOTIFICATION_INVALID"
        );
      }
      const reasonCode =
        notification.event_type ===
        "fad_week1_recovered"
          ? "week1_recovered"
          : "completed";
      notificationPublications.set(notificationId, {
        reasonCode,
        scheduleRecoveryOperationId:
          reasonCode === "week1_recovered"
            ? result.scheduleRecoveryOperationId
            : null,
        userId: notification.user_id,
      });
    }
    const eventCounts = new Map();
    for (const outboxEventId of result.outboxEventIds) {
      const event = uniqueRow(
        outboxEvidenceStatement.all({ outboxEventId }),
        "The FAD completion outbox event"
      );
      let payload;
      try {
        payload = event
          ? JSON.parse(event.payload_json)
          : null;
      } catch {
        payload = null;
      }
      const isDraft =
        event?.event_type ===
        "free_agent_draft.changed";
      const isActivity =
        event?.event_type === "activity.created";
      const isNotification =
        event?.event_type === "notification.created";
      const publication = isActivity
        ? activityPublications.get(event?.aggregate_id)
        : isNotification
          ? notificationPublications.get(event?.aggregate_id)
          : isDraft &&
              ["completed", "week1_recovered"].includes(
                payload?.reasonCode
              )
            ? {
                reasonCode: payload.reasonCode,
                scheduleRecoveryOperationId:
                  payload.reasonCode === "week1_recovered"
                    ? result.scheduleRecoveryOperationId
                    : null,
                userId: null,
              }
            : null;
      const expectedAggregateType = isDraft
        ? "free_agent_draft"
        : isActivity
          ? "league_activity"
          : "notification";
      const expectedVersion = isDraft
        ? result.fadVersion
        : 1;
      if (
        !event ||
        event.league_id !== command.leagueId ||
        (!isDraft && !isActivity && !isNotification) ||
        !publication ||
        event.aggregate_type !== expectedAggregateType ||
        (isDraft
          ? event.aggregate_id !== command.fadId
          : false) ||
        event.created_at_ms !== result.completedAtMs ||
        event.audience_count !== 1 ||
        (isNotification
          ? event.league_audience_count !== 0 ||
            event.audience_user_id !== publication.userId
          : event.league_audience_count !== 1 ||
            event.audience_user_id !== null) ||
        !isPlainObject(payload) ||
        Object.keys(payload).length !== 8 ||
        payload.eventId !== event.id ||
        payload.type !== event.event_type ||
        payload.leagueId !== command.leagueId ||
        payload.resourceId !== event.aggregate_id ||
        payload.version !== expectedVersion ||
        payload.reasonCode !== publication.reasonCode ||
        payload.occurredAt !== result.completedAtMs ||
        !isPlainObject(payload.related) ||
        Object.keys(payload.related).length !== 8 ||
        payload.related.fadId !== command.fadId ||
        payload.related.scheduleRecoveryOperationId !==
          publication.scheduleRecoveryOperationId ||
        Object.entries(payload.related).some(
          ([key, value]) =>
            ![
              "fadId",
              "scheduleRecoveryOperationId",
            ].includes(key) && value !== null
        )
      ) {
        incompatible(
          "A FAD completion outbox event is unavailable or noncanonical.",
          "PUBLICATION_OUTBOX_INVALID"
        );
      }
      const countKey =
        `${event.event_type}:${publication.reasonCode}`;
      eventCounts.set(
        countKey,
        (eventCounts.get(countKey) || 0) + 1
      );
    }
    const completedNotifications = [
      ...notificationPublications.values(),
    ].filter(({ reasonCode }) => reasonCode === "completed").length;
    const recoveryNotifications = [
      ...notificationPublications.values(),
    ].filter(
      ({ reasonCode }) => reasonCode === "week1_recovered"
    ).length;
    const hasRecovery =
      result.scheduleRecoveryOperationId !== null;
    if (
      eventCounts.get("free_agent_draft.changed:completed") !== 1 ||
      eventCounts.get("activity.created:completed") !== 1 ||
      (eventCounts.get("notification.created:completed") || 0) !==
        completedNotifications ||
      (eventCounts.get(
        "free_agent_draft.changed:week1_recovered"
      ) || 0) !== (hasRecovery ? 1 : 0) ||
      (eventCounts.get("activity.created:week1_recovered") || 0) !==
        (hasRecovery ? 1 : 0) ||
      (eventCounts.get(
        "notification.created:week1_recovered"
      ) || 0) !== recoveryNotifications
    ) {
      incompatible(
        "The exact FAD completion outbox set is incomplete.",
        "PUBLICATION_OUTBOX_INVALID"
      );
    }
  }

  function afterTransition(input = {}) {
    if (database.inTransaction !== true) {
      invalid(
        "FAD completion publication requires the lifecycle transaction.",
        "TRANSACTION_REQUIRED"
      );
    }
    if (
      !isPlainObject(input) ||
      !isPlainObject(input.effectiveCommand) ||
      !isPlainObject(input.existing) ||
      !isPlainObject(input.updated)
    ) {
      invalid(
        "An exact FAD completion post-transition witness is required.",
        "POST_TRANSITION_INPUT_INVALID"
      );
    }
    const command = requireHookCommand({
      ...input.effectiveCommand,
      existing: input.existing,
    });
    const updated = input.updated;
    const plan =
      input.effectiveCommand.scheduleRecoveryPlan;
    const completionScheduleRecoveryId =
      plan?.recovery?.id ?? null;
    const persistedScheduleRecoveryId =
      completionScheduleRecoveryId ??
      input.existing.scheduleRecoveryId;
    if (
      updated.id !== command.fadId ||
      updated.status !== "completed" ||
      updated.version !== input.existing.version + 1 ||
      updated.completedAtMs !== command.completedAtMs ||
      updated.scheduleRecoveryId !==
        persistedScheduleRecoveryId
    ) {
      incompatible(
        "The transitioned FAD completion root is noncanonical.",
        "POST_TRANSITION_ROOT_INVALID"
      );
    }
    requireLiveJob(command);
    const persistedRoot = requireRoot(command, {
      allowCompleted: true,
    });
    if (
      persistedRoot.status !== "completed" ||
      persistedRoot.completed_at_ms !==
        command.completedAtMs ||
      persistedRoot.season_fad_completed_at_ms !==
        command.completedAtMs ||
      persistedRoot.schedule_recovery_id !==
        updated.scheduleRecoveryId ||
      persistedRoot.week_one_matchup_week_id !==
        updated.currentCompetitionFirstMatchupWeekId
    ) {
      incompatible(
        "The FAD and season completion markers are not atomic.",
        "COMPLETION_MARKERS_INVALID"
      );
    }
    after("after_root_update", {
      command,
      updated,
    });
    const activityIds = writeActivities(
      command,
      updated,
      plan
    );
    const notificationWrites = writeNotifications(
      command,
      plan
    );
    const outboxEventIds = writeOutbox(
      command,
      updated,
      plan,
      activityIds,
      notificationWrites.publications
    );
    const result = requireCompletionResult({
      schemaVersion: 1,
      code: "FAD_COMPLETED",
      fadId: command.fadId,
      completedAtMs: command.completedAtMs,
      fadVersion: updated.version,
      scheduleRecoveryId:
        completionScheduleRecoveryId,
      scheduleRecoveryOperationId:
        plan?.operation?.id ?? null,
      competitionFirstMatchupStartsAtMs:
        persistedRoot.week_one_starts_at_ms,
      activityIds,
      notificationIds:
        notificationWrites.notificationIds,
      outboxEventIds,
    });
    requirePersistedPublications(command, result);
    after("after_publication", { command, result });
    if (
      terminalJobStatement.run({
        ...command,
        resultJson: serializeCanonicalJsonV1(result),
      }).changes !== 1
    ) {
      conflict(
        "The FAD completion job lease changed before terminalization.",
        "JOB_TERMINAL_CAS_FAILED"
      );
    }
    after("after_job_terminal", { command, result });
    const terminal = uniqueRow(
      jobStatement.all(command),
      "The completed FAD job"
    );
    if (
      !terminal ||
      terminal.status !== "succeeded" ||
      terminal.version !==
        command.expectedJobVersion + 1 ||
      terminal.completed_at_ms !==
        command.completedAtMs ||
      terminal.updated_at_ms !==
        command.completedAtMs ||
      terminal.lease_owner !== null ||
      terminal.lease_token !== null ||
      terminal.lease_expires_at_ms !== null ||
      terminal.last_error_code !== null ||
      terminal.next_attempt_at_ms !== null
    ) {
      incompatible(
        "The terminal FAD completion job is noncanonical.",
        "JOB_TERMINAL_STATE_INVALID"
      );
    }
    if (beforeCommit) {
      assertSynchronous(
        beforeCommit(
          Object.freeze({
            command,
            existing: input.existing,
            updated,
            result,
          })
        ),
        "FAD completion beforeCommit"
      );
    }
    return result;
  }

  const executeTransaction = database.transaction(
    (command, lifecycleRepository) => {
      if (
        !lifecycleRepository ||
        typeof lifecycleRepository.advanceStatus !==
          "function"
      ) {
        throw new TypeError(
          "FAD completion requires the lifecycle repository"
        );
      }
      const root = requireRoot(command, {
        allowCompleted: true,
      });
      const job = uniqueRow(
        jobStatement.all(command),
        "The FAD completion job"
      );
      if (
        root.status === "completed" &&
        job?.status === "succeeded" &&
        job.version ===
          command.expectedJobVersion + 1 &&
        job.completed_at_ms !== null &&
        job.result_json !== null
      ) {
        let persisted;
        try {
          persisted = parseCanonicalJsonV1(
            job.result_json
          );
        } catch (error) {
          incompatible(
            "The succeeded FAD completion result is unreadable.",
            "COMPLETION_RESULT_INVALID",
            error
          );
        }
        const result = requireCompletionResult(persisted);
        if (
          result.fadId !== command.fadId ||
          result.completedAtMs !== job.completed_at_ms ||
          result.completedAtMs !== root.completed_at_ms ||
          result.fadVersion !== root.version ||
          (
            result.scheduleRecoveryId !== null &&
            result.scheduleRecoveryId !==
              root.schedule_recovery_id
          ) ||
          result.competitionFirstMatchupStartsAtMs !==
            root.week_one_starts_at_ms
        ) {
          incompatible(
            "The succeeded FAD completion result lost its root binding.",
            "COMPLETION_REPLAY_INVALID"
          );
        }
        if (
          result.scheduleRecoveryId === null &&
          root.schedule_recovery_id !== null
        ) {
          const priorRecovery = uniqueRow(
            scheduleRecoveryEvidenceStatement.all({
              ...command,
              scheduleRecoveryId:
                root.schedule_recovery_id,
            }),
            "The prior FAD schedule recovery"
          );
          if (
            !priorRecovery ||
            priorRecovery.completed_at_ms >=
              result.completedAtMs ||
            priorRecovery.new_first_matchup_week_id !==
              root.current_competition_first_matchup_week_id ||
            priorRecovery.new_week_one_starts_at_ms !==
              root.week_one_starts_at_ms
          ) {
            incompatible(
              "The no-op FAD completion lost its prior schedule recovery binding.",
              "COMPLETION_REPLAY_INVALID"
            );
          }
        }
        requirePersistedPublications(command, result);
        return terminalProjection({
          command,
          result,
          replayed: true,
        });
      }
      requireLiveJob(command);
      if (root.status !== "rapid") {
        conflict(
          "The FAD is no longer in the rapid phase.",
          "FAD_NOT_RAPID"
        );
      }
      const projected = loadEligibility(command, {
        projectCompletionRecovery: true,
      });
      if (!projected.evaluation.eligible) {
        conflict(
          "The FAD still has nonterminal or unaccounted work.",
          "COMPLETION_NOT_ELIGIBLE",
          {
            reasonCodes:
              projected.evaluation.reasonCodes,
          }
        );
      }
      const planned = assertSynchronous(
        scheduleRecoveryService.planRecovery(
          scheduleContext(command, root)
        ),
        "FAD completion schedule-recovery planning"
      );
      if (
        !isPlainObject(planned) ||
        !["no_op", "stage_recovery"].includes(
          planned.action
        ) ||
        (
          planned.action === "no_op"
            ? command.completedAtMs >=
              root.week_one_starts_at_ms
            : command.completedAtMs <
              root.week_one_starts_at_ms
        )
      ) {
        incompatible(
          "The FAD completion schedule-recovery plan is noncanonical.",
          "SCHEDULE_RECOVERY_PLAN_INVALID"
        );
      }
      after("after_schedule_plan", {
        command,
        plan: planned,
      });
      const scheduleRecoveryPlan =
        planned.action === "stage_recovery"
          ? planned
          : null;
      const transitioned = assertSynchronous(
        lifecycleRepository.advanceStatus(
          transitionCommand(
            command,
            root,
            scheduleRecoveryPlan
          )
        ),
        "FAD completion lifecycle transition"
      );
      if (
        !isPlainObject(transitioned) ||
        transitioned.replayed !== false ||
        !isPlainObject(transitioned.draft) ||
        transitioned.draft.id !== command.fadId ||
        transitioned.draft.status !== "completed" ||
        transitioned.draft.version !== root.version + 1
      ) {
        incompatible(
          "The lifecycle repository returned a noncanonical completion.",
          "LIFECYCLE_RESULT_INVALID"
        );
      }
      const terminal = uniqueRow(
        jobStatement.all(command),
        "The terminal FAD completion job"
      );
      if (
        !terminal ||
        terminal.status !== "succeeded" ||
        terminal.version !==
          command.expectedJobVersion + 1 ||
        terminal.result_json === null
      ) {
        incompatible(
          "The lifecycle completion did not terminalize its exact job.",
          "JOB_TERMINAL_STATE_INVALID"
        );
      }
      let result;
      try {
        result = requireCompletionResult(
          parseCanonicalJsonV1(
            terminal.result_json
          )
        );
      } catch (error) {
        if (
          error?.code?.startsWith?.("REPOSITORY_")
        ) {
          throw error;
        }
        incompatible(
          "The terminal FAD completion result is unreadable.",
          "COMPLETION_RESULT_INVALID",
          error
        );
      }
      return terminalProjection({
        command,
        result,
        replayed: false,
      });
    }
  );

  const recordFailureTransaction = database.transaction(
    (command) => {
      const root = uniqueRow(
        rootStatement.all(command),
        "The failed FAD completion root"
      );
      const job = uniqueRow(
        jobStatement.all(command),
        "The failed FAD completion job"
      );
      const notRecorded = () => Object.freeze({
        recorded: false,
        replayed: false,
        runId: command.runId,
        failedAtMs: command.failedAtMs,
        errorCode: command.errorCode,
        jobVersion: null,
        recoveryId: null,
        recoveryVersion: null,
      });
      if (!root || root.status !== "rapid" || !job) {
        return notRecorded();
      }
      const recoveryId = deterministicUuid(
        `fad-completion:recovery:${command.runId}`
      );
      const existingRecoveries =
        recoveriesStatement
          .all(command)
          .filter(
            (recovery) =>
              recovery.kind === "completion" &&
              recovery.job_run_id === command.runId &&
              recovery.status !== "resolved"
           );
      if (existingRecoveries.length > 1) {
        incompatible(
          "The FAD completion job has ambiguous recovery evidence.",
          "COMPLETION_RECOVERY_AMBIGUOUS"
        );
      }
      const recovery = existingRecoveries[0] || null;

      const exactFailedReplay =
        job.status === "failed" &&
        job.version === command.expectedJobVersion + 1 &&
        job.attempt_count === command.attemptCount &&
        job.lease_owner === null &&
        job.lease_token === null &&
        job.lease_expires_at_ms === null &&
        job.started_at_ms === command.startedAtMs &&
        job.completed_at_ms === command.failedAtMs &&
        job.result_json === null &&
        job.last_error_code === command.errorCode &&
        job.next_attempt_at_ms === null &&
        recovery !== null &&
        recovery.id === recoveryId &&
        recovery.status === "correction_required" &&
        recovery.job_run_id === command.runId &&
        recovery.created_by_operation_id === command.runId &&
        recovery.last_error_code === command.errorCode &&
        recovery.resolved_at_ms === null;
      if (exactFailedReplay) {
        return Object.freeze({
          recorded: true,
          replayed: true,
          runId: command.runId,
          failedAtMs: command.failedAtMs,
          errorCode: command.errorCode,
          jobVersion: job.version,
          recoveryId: recovery.id,
          recoveryVersion: recovery.version,
        });
      }

      if (
        recovery !== null &&
        (
          recovery.id !== recoveryId ||
          recovery.created_by_operation_id !==
            command.runId ||
          recovery.resolved_at_ms !== null ||
          recovery.status !== "running"
        )
      ) {
        return notRecorded();
      }

      if (
        job.status !== "running" ||
        job.version !== command.expectedJobVersion ||
        job.attempt_count !== command.attemptCount ||
        job.lease_owner !== command.leaseOwner ||
        job.lease_token !== command.leaseToken ||
        job.lease_expires_at_ms !==
          command.leaseExpiresAtMs ||
        job.lease_expires_at_ms <= command.failedAtMs ||
        job.started_at_ms !== command.startedAtMs ||
        job.completed_at_ms !== null ||
        job.result_json !== null ||
        job.last_error_code !== null ||
        job.next_attempt_at_ms !== null
      ) {
        return notRecorded();
      }
      if (
        failJobStatement.run({
          ...command,
          nextAttemptAtMs: null,
        }).changes !== 1
      ) {
        conflict(
          "The failed FAD completion job changed before recovery recording.",
          "FAILURE_JOB_CAS_FAILED"
        );
      }
      after("after_failure_job", {
        command,
        errorCode: command.errorCode,
      });
      if (recovery === null) {
        insertFailureRecoveryStatement.run({
          ...command,
          recoveryId,
        });
      } else if (recovery.status === "running") {
        if (
          updateFailureRecoveryStatement.run({
            ...command,
            recoveryId: recovery.id,
            recoveryVersion: recovery.version,
          }).changes !== 1
        ) {
          conflict(
            "The active FAD completion recovery changed.",
            "FAILURE_RECOVERY_CAS_FAILED"
          );
        }
      } else if (
        recovery.status !== "correction_required"
      ) {
        incompatible(
          "The failed FAD completion recovery has an invalid state.",
          "FAILURE_RECOVERY_STATE_INVALID"
        );
      }
      const persisted = recoveriesStatement
        .all(command)
        .find(
          (candidate) =>
            candidate.id === recoveryId &&
            candidate.kind === "completion" &&
            candidate.job_run_id === command.runId &&
            candidate.created_by_operation_id ===
              command.runId &&
            candidate.status === "correction_required" &&
            candidate.last_error_code ===
              command.errorCode &&
            candidate.resolved_at_ms === null
        );
      if (!persisted) {
        incompatible(
          "The failed FAD completion recovery was not persisted.",
          "FAILURE_RECOVERY_MISSING"
        );
      }
      after("after_failure_recovery", {
        command,
        recoveryId: persisted.id,
      });
      return Object.freeze({
        recorded: true,
        replayed: false,
        runId: command.runId,
        failedAtMs: command.failedAtMs,
        errorCode: command.errorCode,
        jobVersion: command.expectedJobVersion + 1,
        recoveryId: persisted.id,
        recoveryVersion: persisted.version,
      });
    }
  );

  const writer = Object.freeze({
    beforeTransition,
    afterTransition,
    executeClaimed(input = {}, lifecycleRepository) {
      const command = normalizeCommand(input);
      try {
        return executeTransaction.immediate(
          command,
          lifecycleRepository
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "executeClaimedFreeAgentDraftCompletion",
          tableName: "free_agent_drafts",
        });
      }
    },
    listCandidates(input = {}) {
      const scan = normalizeScan(input);
      try {
        const result = [];
        for (const row of candidateStatement.all(scan)) {
          const candidate = candidateFromRow(row);
          const command = {
            ...candidate,
            completedAtMs: scan.nowMs,
          };
          const root = requireRoot(command);
          const recoveryRows = recoveriesStatement.all(
            command
          );
          const unresolved = recoveryRows.filter(
            ({ status }) => status !== "resolved"
          );
          const retryReady =
            unresolved.length === 0 ||
            (
              unresolved.length === 1 &&
              unresolved[0].kind === "completion" &&
              unresolved[0].status === "running" &&
              unresolved[0].job_run_id === candidate.runId
            );
          if (!retryReady) continue;
          const eligibility = loadEligibility(command, {
            projectCompletionRecovery: true,
          }).evaluation;
          if (!eligibility.eligible) continue;
          if (
            root.candidate_deadline_at_ms >
            candidate.scheduledForMs
          ) {
            incompatible(
              "The completion job precedes its Candidate deadline.",
              "COMPLETION_JOB_CLOCK_INVALID"
            );
          }
          result.push(candidate);
          if (result.length === scan.limit) break;
        }
        return Object.freeze(result);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "listFreeAgentDraftCompletionCandidates",
          tableName: "job_runs",
        });
      }
    },
    recordFailure(input = {}) {
      const command = normalizeFailureCommand(input);
      try {
        return recordFailureTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "recordFailedFreeAgentDraftCompletion",
          tableName: "free_agent_draft_recoveries",
        });
      }
    },
  });
  if (
    Object.keys(writer).length !== WRITER_METHODS.length ||
    WRITER_METHODS.some(
      (method) => typeof writer[method] !== "function"
    )
  ) {
    throw new TypeError(
      "The FAD completion writer surface is incomplete."
    );
  }
  return writer;
}

module.exports = {
  FREE_AGENT_DRAFT_COMPLETION_JOB_TYPE: JOB_TYPE,
  FREE_AGENT_DRAFT_COMPLETION_WRITER_METHODS:
    WRITER_METHODS,
  createSqliteFreeAgentDraftCompletionWriter,
};
