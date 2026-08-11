"use strict";

const { randomUUID } = require("node:crypto");

const {
  FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
  FREE_AGENT_DRAFT_DAY_MS,
  UUID_PATTERN,
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
  FreeAgentDraftRolloverFinalizationPolicyError,
  evaluateFreeAgentDraftRolloverFinalization,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftRolloverFinalizationPolicy"
);
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

const JOB_TYPE = "fad_rollover";
const OPERATION = "free_agent_draft_rollover_finalization";
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const METHODS = Object.freeze([
  "ensurePendingJobs",
  "findFinalization",
  "executeClaimed",
  "recordFailure",
]);
const IDENTITY_FIELDS = Object.freeze([
  "fadId",
  "leagueId",
  "occurrenceKey",
  "rolloverAtMs",
  "rolloverId",
  "seasonId",
  "sequence",
]);
const EXECUTE_FIELDS = Object.freeze([
  ...IDENTITY_FIELDS,
  "expectedRolloverVersion",
  "finalizedAtMs",
  "jobExecution",
]);
const FAILURE_FIELDS = Object.freeze([
  ...IDENTITY_FIELDS,
  "expectedRolloverVersion",
  "failedAtMs",
  "jobExecution",
  "reasonCode",
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
const STORED_FIELDS = Object.freeze([
  "identity",
  "operation",
  "request",
  "response",
  "schemaVersion",
]);
const STORED_IDENTITY_FIELDS = Object.freeze([
  ...IDENTITY_FIELDS,
  "jobRunId",
]);
const STORED_REQUEST_FIELDS = Object.freeze([
  "expectedJobVersion",
  "expectedRolloverVersion",
  "finalizedAtMs",
]);
const RESPONSE_FIELDS = Object.freeze([
  "evidence",
  "fadId",
  "finalizedAtMs",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "outcome",
  "rolloverAtMs",
  "rolloverId",
  "rolloverVersion",
  "seasonId",
  "sequence",
  "sourceRecoveryId",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "auctionCount",
  "createdFallbackCount",
  "nominationCount",
  "normalAuctionCount",
  "reasonCode",
  "recoverableAuctionCount",
  "recoverableUnresolvedCount",
  "requiredFallbackCount",
  "terminalNominationCount",
  "unresolvedCount",
]);

function invalid(message, reasonCode = "INPUT_INVALID") {
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

function notFound(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
    message,
    { details: { reasonCode } }
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
  ) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, description) {
  if (!isPlainObject(value)) {
    invalid(`An exact ${description} is required.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_FIELDS_INVALID"
    );
  }
  return value;
}

function assertPersistedObject(value, fields, description) {
  if (!isPlainObject(value)) {
    incompatible(
      `The persisted ${description} is not an object.`,
      "PERSISTED_JSON_INVALID"
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    incompatible(
      `The persisted ${description} has unexpected fields.`,
      "PERSISTED_JSON_INVALID"
    );
  }
  return value;
}

function canonicalId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid(
      `A canonical ${description} identifier is required.`,
      "IDENTIFIER_INVALID"
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    invalid(
      `A safe ${description} is required.`,
      "TIMESTAMP_INVALID"
    );
  }
  return value;
}

function positiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(
      `A positive ${description} is required.`,
      "INTEGER_INVALID"
    );
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
    invalid(
      `A bounded ${description} is required.`,
      "TEXT_INVALID"
    );
  }
  return value;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function uniqueRow(rows, description) {
  if (rows.length > 1) {
    incompatible(
      `${description} is ambiguous.`,
      "PERSISTED_IDENTITY_AMBIGUOUS"
    );
  }
  return rows[0] || null;
}

function normalizeIdentity(input) {
  exactObject(input, IDENTITY_FIELDS, "rollover identity");
  const identity = {
    leagueId: canonicalId(input.leagueId, "league"),
    seasonId: canonicalId(input.seasonId, "season"),
    fadId: canonicalId(input.fadId, "FAD"),
    rolloverId: canonicalId(input.rolloverId, "rollover"),
    sequence: positiveInteger(input.sequence, "rollover sequence"),
    rolloverAtMs: safeTimestamp(
      input.rolloverAtMs,
      "rollover timestamp"
    ),
    occurrenceKey: boundedText(
      input.occurrenceKey,
      500,
      "rollover occurrence key"
    ),
  };
  let canonicalOccurrence;
  try {
    canonicalOccurrence = buildFreeAgentDraftRolloverOccurrenceKey({
      fadId: identity.fadId,
      sequence: identity.sequence,
      rolloverAtMs: identity.rolloverAtMs,
    });
  } catch (error) {
    invalid(
      "The rollover occurrence key is invalid.",
      error?.reasonCode || "OCCURRENCE_INVALID"
    );
  }
  if (identity.occurrenceKey !== canonicalOccurrence) {
    invalid(
      "The rollover occurrence key is not canonical.",
      "OCCURRENCE_MISMATCH"
    );
  }
  return identity;
}

function normalizeJobExecution(value) {
  exactObject(value, JOB_EXECUTION_FIELDS, "job execution fence");
  const startedAtMs = safeTimestamp(
    value.startedAtMs,
    "job start timestamp"
  );
  const leaseExpiresAtMs = safeTimestamp(
    value.leaseExpiresAtMs,
    "job lease expiry"
  );
  if (leaseExpiresAtMs <= startedAtMs) {
    invalid(
      "The rollover job lease must extend beyond its start.",
      "JOB_LEASE_INVALID"
    );
  }
  return {
    runId: canonicalId(value.runId, "job run"),
    expectedVersion: positiveInteger(
      value.expectedVersion,
      "job version"
    ),
    leaseOwner: boundedText(value.leaseOwner, 200, "lease owner"),
    leaseToken: boundedText(value.leaseToken, 500, "lease token"),
    leaseExpiresAtMs,
    startedAtMs,
    attemptCount: positiveInteger(
      value.attemptCount,
      "job attempt count"
    ),
  };
}

function normalizeCommand(input, { failure }) {
  exactObject(
    input,
    failure ? FAILURE_FIELDS : EXECUTE_FIELDS,
    failure ? "rollover failure command" : "rollover command"
  );
  const identity = normalizeIdentity(
    Object.fromEntries(
      IDENTITY_FIELDS.map((field) => [field, input[field]])
    )
  );
  const command = {
    ...identity,
    expectedRolloverVersion: positiveInteger(
      input.expectedRolloverVersion,
      "rollover version"
    ),
    jobExecution: normalizeJobExecution(input.jobExecution),
  };
  Object.assign(command, command.jobExecution);
  if (failure) {
    command.failedAtMs = safeTimestamp(
      input.failedAtMs,
      "failure timestamp"
    );
    if (input.reasonCode !== "boundary_recovery_required") {
      invalid(
        "Only the exact rollover recovery decision may be recorded.",
        "FAILURE_REASON_INVALID"
      );
    }
    command.reasonCode = input.reasonCode;
  } else {
    command.finalizedAtMs = safeTimestamp(
      input.finalizedAtMs,
      "finalization timestamp"
    );
  }
  const terminalAtMs = failure
    ? command.failedAtMs
    : command.finalizedAtMs;
  if (
    terminalAtMs < command.rolloverAtMs ||
    terminalAtMs < command.startedAtMs ||
    terminalAtMs >= command.leaseExpiresAtMs
  ) {
    invalid(
      "The rollover terminal timestamp is outside the live claim.",
      "TERMINAL_TIMESTAMP_INVALID"
    );
  }
  return command;
}

function normalizeEnsure(input) {
  exactObject(input, ["ensuredAtMs", "limit"], "job ensure query");
  const limit = input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    invalid(
      "The rollover ensure limit must be between one and 100.",
      "LIMIT_INVALID"
    );
  }
  return {
    ensuredAtMs: safeTimestamp(input.ensuredAtMs, "ensure timestamp"),
    limit,
  };
}

function createSqliteFreeAgentDraftRolloverWriter({
  database,
  createId = () => randomUUID(),
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftRolloverWriter requires an opened database"
    );
  }
  if (typeof createId !== "function") {
    throw new TypeError("FAD rollover identifier creation must be a function");
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError("FAD rollover beforeCommit must be a function");
  }

  let missingJobsStatement;
  let insertJobStatement;
  let finalizationStatement;
  let successorStatement;
  let successorJobStatement;
  let recoveriesStatement;
  let auctionsStatement;
  let nominationsStatement;
  let fallbacksStatement;
  let startProcessingStatement;
  let completeRolloverStatement;
  let resolveRecoveryStatement;
  let succeedJobStatement;
  let insertRecoveryStatement;
  let failRecoveryStatement;
  let insertExtensionStatement;
  let failJobStatement;
  let failRolloverStatement;

  try {
    missingJobsStatement = database.prepare(`
      SELECT rollover.*
      FROM free_agent_draft_rollovers AS rollover
      JOIN free_agent_drafts AS fad
        ON fad.league_id = rollover.league_id
       AND fad.season_id = rollover.season_id
       AND fad.id = rollover.fad_id
      WHERE rollover.status = 'scheduled'
        AND fad.status = 'rapid'
        AND NOT EXISTS (
          SELECT 1 FROM job_runs AS job
          WHERE job.league_id = rollover.league_id
            AND job.season_id = rollover.season_id
            AND job.job_type = '${JOB_TYPE}'
            AND job.occurrence_key =
              'fad:' || rollover.fad_id || ':rollover:' ||
              rollover.sequence || ':' || rollover.rolls_over_at_ms
            AND job.scheduled_for_ms = rollover.rolls_over_at_ms
        )
      ORDER BY rollover.rolls_over_at_ms, rollover.sequence, rollover.id
      LIMIT @limit
    `);
    insertJobStatement = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type, occurrence_key,
        scheduled_for_ms, status, attempt_count, lease_owner,
        lease_expires_at_ms, started_at_ms, completed_at_ms,
        result_json, last_error_code, created_at_ms, updated_at_ms,
        version, lease_token, next_attempt_at_ms
      ) VALUES (
        @jobRunId, @leagueId, @seasonId, '${JOB_TYPE}',
        @occurrenceKey, @rolloverAtMs, 'pending', 0, NULL,
        NULL, NULL, NULL, NULL, NULL, @createdAtMs, @createdAtMs,
        1, NULL, NULL
      )
    `);
    finalizationStatement = database.prepare(`
      SELECT
        rollover.*,
        job.id AS job_run_id,
        job.job_type,
        job.occurrence_key,
        job.scheduled_for_ms,
        job.status AS job_status,
        job.attempt_count AS job_attempt_count,
        job.lease_owner AS job_lease_owner,
        job.lease_token AS job_lease_token,
        job.lease_expires_at_ms AS job_lease_expires_at_ms,
        job.started_at_ms AS job_started_at_ms,
        job.completed_at_ms AS job_completed_at_ms,
        job.result_json AS job_result_json,
        job.last_error_code AS job_last_error_code,
        job.next_attempt_at_ms AS job_next_attempt_at_ms,
        job.created_at_ms AS job_created_at_ms,
        job.updated_at_ms AS job_updated_at_ms,
        job.version AS job_version
      FROM free_agent_draft_rollovers AS rollover
      LEFT JOIN job_runs AS job
        ON job.league_id = rollover.league_id
       AND job.season_id = rollover.season_id
       AND job.job_type = '${JOB_TYPE}'
       AND job.occurrence_key = @occurrenceKey
       AND job.scheduled_for_ms = rollover.rolls_over_at_ms
      WHERE rollover.league_id = @leagueId
        AND rollover.season_id = @seasonId
        AND rollover.fad_id = @fadId
        AND rollover.id = @rolloverId
        AND rollover.sequence = @sequence
        AND rollover.rolls_over_at_ms = @rolloverAtMs
      LIMIT 2
    `);
    successorStatement = database.prepare(`
      SELECT * FROM free_agent_draft_rollovers
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND predecessor_rollover_id = @rolloverId
      ORDER BY id
      LIMIT 2
    `);
    successorJobStatement = database.prepare(`
      SELECT * FROM job_runs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @successorOccurrenceKey
        AND scheduled_for_ms = @successorRolloverAtMs
      ORDER BY id
      LIMIT 2
    `);
    recoveriesStatement = database.prepare(`
      SELECT * FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND rollover_id = @rolloverId
      ORDER BY created_at_ms, id
    `);
    auctionsStatement = database.prepare(`
      SELECT
        auction.id,
        auction.player_id,
        auction.status,
        resolution.status AS resolution_status,
        resolution.outcome_code AS resolution_outcome_code,
        job.status AS job_status,
        recovery.id AS recovery_id,
        recovery.status AS recovery_status,
        recovery.player_id AS recovery_player_id,
        recovery.auction_id AS recovery_auction_id,
        recovery.job_run_id AS recovery_job_run_id,
        recovery.rollover_id AS recovery_rollover_id
      FROM auction_contexts AS context
      JOIN auctions AS auction
        ON auction.league_id = context.league_id
       AND auction.season_id = context.season_id
       AND auction.id = context.auction_id
      LEFT JOIN auction_resolutions AS resolution
        ON resolution.league_id = auction.league_id
       AND resolution.season_id = auction.season_id
       AND resolution.auction_id = auction.id
      LEFT JOIN job_runs AS job
        ON job.league_id = auction.league_id
       AND job.season_id = auction.season_id
       AND job.job_type = 'auction.resolve.target'
       AND job.occurrence_key =
         'auction:' || auction.id || ':' || auction.resolves_at_ms
       AND job.scheduled_for_ms = auction.resolves_at_ms
      LEFT JOIN free_agent_draft_recoveries AS recovery
        ON recovery.league_id = context.league_id
       AND recovery.season_id = context.season_id
       AND recovery.fad_id = context.fad_id
       AND recovery.rollover_id = context.fad_rollover_id
       AND recovery.auction_id = auction.id
       AND recovery.player_id = auction.player_id
       AND recovery.job_run_id = job.id
       AND recovery.kind = 'auction_resolution'
      WHERE context.league_id = @leagueId
        AND context.season_id = @seasonId
        AND context.fad_id = @fadId
        AND context.fad_rollover_id = @rolloverId
      ORDER BY auction.id, recovery.id
    `);
    nominationsStatement = database.prepare(`
      SELECT
        queue.id,
        queue.player_id,
        queue.status,
        queue.opened_auction_id,
        queue.validation_code,
        job.id AS job_run_id,
        job.status AS job_status,
        recovery.id AS recovery_id,
        recovery.status AS recovery_status
      FROM free_agent_draft_nomination_queue AS queue
      LEFT JOIN job_runs AS job
        ON job.league_id = queue.league_id
       AND job.season_id = queue.season_id
       AND job.job_type = 'fad_queued_nomination_activation'
       AND job.occurrence_key =
         'fad:' || queue.fad_id || ':nomination-open:' ||
         queue.id || ':' || (
           SELECT rolls_over_at_ms
           FROM free_agent_draft_rollovers
           WHERE id = queue.target_opening_rollover_id
         )
      LEFT JOIN free_agent_draft_recoveries AS recovery
        ON recovery.league_id = queue.league_id
       AND recovery.season_id = queue.season_id
       AND recovery.fad_id = queue.fad_id
       AND recovery.nomination_queue_id = queue.id
       AND recovery.player_id = queue.player_id
       AND recovery.rollover_id = queue.target_opening_rollover_id
       AND recovery.job_run_id = job.id
       AND recovery.kind = 'queued_nomination_activation'
      WHERE queue.league_id = @leagueId
        AND queue.season_id = @seasonId
        AND queue.fad_id = @fadId
        AND queue.target_opening_rollover_id = @rolloverId
      ORDER BY queue.id, recovery.id
    `);
    fallbacksStatement = database.prepare(`
      SELECT
        source.id AS source_auction_id,
        allocation.id AS allocation_id,
        allocation.fallback_open_auction_id AS created_auction_id,
        fallback_context.fad_rollover_id AS successor_rollover_id
      FROM auction_contexts AS source_context
      JOIN auctions AS source
        ON source.league_id = source_context.league_id
       AND source.season_id = source_context.season_id
       AND source.id = source_context.auction_id
      JOIN auction_resolutions AS source_resolution
        ON source_resolution.league_id = source.league_id
       AND source_resolution.season_id = source.season_id
       AND source_resolution.auction_id = source.id
       AND source_resolution.outcome_code = 'no_winner'
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = source_context.league_id
       AND allocation.season_id = source_context.season_id
       AND allocation.fad_id = source_context.fad_id
       AND allocation.id = source_context.fad_allocation_id
      LEFT JOIN auction_contexts AS fallback_context
        ON fallback_context.league_id = allocation.league_id
       AND fallback_context.season_id = allocation.season_id
       AND fallback_context.auction_id =
         allocation.fallback_open_auction_id
       AND fallback_context.fad_id = allocation.fad_id
       AND fallback_context.fad_allocation_id = allocation.id
       AND fallback_context.fad_origin =
         'restricted_no_improvement_fallback'
      WHERE source_context.league_id = @leagueId
        AND source_context.season_id = @seasonId
        AND source_context.fad_id = @fadId
        AND source_context.fad_rollover_id = @rolloverId
        AND source_context.source_kind = 'fad_restricted'
      ORDER BY source.id, allocation.id
    `);
    startProcessingStatement = database.prepare(`
      UPDATE free_agent_draft_rollovers
      SET status = 'processing',
          processing_job_run_id = @runId,
          processing_started_at_ms = @terminalAtMs,
          updated_at_ms = @terminalAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @rolloverId
        AND sequence = @sequence
        AND rolls_over_at_ms = @rolloverAtMs
        AND status = 'scheduled'
        AND processing_job_run_id IS NULL
        AND processing_started_at_ms IS NULL
        AND completed_at_ms IS NULL
        AND last_error_code IS NULL
        AND version = @expectedRolloverVersion
    `);
    completeRolloverStatement = database.prepare(`
      UPDATE free_agent_draft_rollovers
      SET status = 'completed',
          completed_at_ms = @finalizedAtMs,
          last_error_code = NULL,
          updated_at_ms = @finalizedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @rolloverId
        AND processing_job_run_id = @runId
        AND status = @sourceStatus
        AND version = @sourceRolloverVersion
    `);
    resolveRecoveryStatement = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = NULL,
          resolved_by_membership_id = NULL,
          resolved_authority = 'system',
          updated_at_ms = @finalizedAtMs,
          resolved_at_ms = @finalizedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @sourceRecoveryId
        AND rollover_id = @rolloverId
        AND job_run_id = @runId
        AND kind = 'rollover_finalize'
        AND status = 'running'
        AND resolved_at_ms IS NULL
        AND updated_at_ms <= @finalizedAtMs
        AND version = @sourceRecoveryVersion
    `);
    succeedJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @finalizedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @finalizedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @rolloverAtMs
        AND status = 'running'
        AND attempt_count = @attemptCount
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms = @leaseExpiresAtMs
        AND lease_expires_at_ms > @finalizedAtMs
        AND started_at_ms = @startedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedVersion
    `);
    insertRecoveryStatement = database.prepare(`
      INSERT INTO free_agent_draft_recoveries (
        id, league_id, season_id, fad_id, player_id,
        allocation_id, rollover_id, auction_id, job_run_id,
        kind, status, earliest_activation_at_ms,
        target_resolution_at_ms, last_error_code,
        commissioner_reason, created_by_operation_id,
        resolved_by_user_id, resolved_by_membership_id,
        resolved_authority, created_at_ms, updated_at_ms,
        resolved_at_ms, version, nomination_queue_id
      ) VALUES (
        @recoveryId, @leagueId, @seasonId, @fadId, NULL,
        NULL, @rolloverId, NULL, @runId,
        'rollover_finalize', 'correction_required', NULL,
        NULL, '${FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE}', NULL, @runId,
        NULL, NULL, NULL, @failedAtMs, @failedAtMs,
        NULL, 1, NULL
      )
    `);
    failRecoveryStatement = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'correction_required',
          last_error_code = '${FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE}',
          updated_at_ms = @failedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @recoveryId
        AND player_id IS NULL
        AND allocation_id IS NULL
        AND rollover_id = @rolloverId
        AND auction_id IS NULL
        AND job_run_id = @runId
        AND nomination_queue_id IS NULL
        AND kind = 'rollover_finalize'
        AND status = 'running'
        AND created_by_operation_id = @runId
        AND resolved_by_user_id IS NULL
        AND resolved_by_membership_id IS NULL
        AND resolved_authority IS NULL
        AND resolved_at_ms IS NULL
        AND updated_at_ms <= @failedAtMs
        AND version = @expectedRecoveryVersion
    `);
    insertExtensionStatement = database.prepare(`
      INSERT INTO free_agent_draft_rollovers (
        id, league_id, season_id, fad_id, sequence,
        window_kind, predecessor_rollover_id,
        extension_reason, extension_source_id,
        opens_at_ms, creation_cutoff_at_ms,
        rolls_over_at_ms, status, processing_job_run_id,
        processing_started_at_ms, completed_at_ms,
        last_error_code, created_at_ms, updated_at_ms, version
      ) VALUES (
        @extensionRolloverId, @leagueId, @seasonId, @fadId,
        @extensionSequence, 'extension', @rolloverId,
        'recovery', @recoveryId, @rolloverAtMs,
        @extensionCreationCutoffAtMs, @extensionRolloverAtMs,
        'scheduled', NULL, NULL, NULL, NULL,
        @failedAtMs, @failedAtMs, 1
      )
    `);
    failJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @failedAtMs,
          result_json = NULL,
          last_error_code = '${FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE}',
          next_attempt_at_ms = NULL,
          updated_at_ms = @failedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @rolloverAtMs
        AND status = 'running'
        AND attempt_count = @attemptCount
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms = @leaseExpiresAtMs
        AND lease_expires_at_ms > @failedAtMs
        AND started_at_ms = @startedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedVersion
    `);
    failRolloverStatement = database.prepare(`
      UPDATE free_agent_draft_rollovers
      SET status = 'recovery_required',
          completed_at_ms = @failedAtMs,
          last_error_code = '${FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE}',
          updated_at_ms = @failedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @rolloverId
        AND processing_job_run_id = @runId
        AND status = @sourceStatus
        AND version = @sourceRolloverVersion
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareFreeAgentDraftRolloverWriter",
      tableName: "free_agent_draft_rollovers",
    });
  }

  function createIdentity(description, issued) {
    const id = createId(description);
    canonicalId(id, description);
    if (issued.has(id)) {
      invalid(
        "FAD rollover identifier factories must return unique identifiers.",
        "IDENTIFIER_COLLISION"
      );
    }
    issued.add(id);
    return id;
  }

  function readFinalization(scope) {
    return uniqueRow(
      finalizationStatement.all(scope),
      "The rollover finalization binding"
    );
  }

  function validateBinding(row, identity) {
    if (!row) return null;
    if (
      row.league_id !== identity.leagueId ||
      row.season_id !== identity.seasonId ||
      row.fad_id !== identity.fadId ||
      row.id !== identity.rolloverId ||
      row.sequence !== identity.sequence ||
      row.rolls_over_at_ms !== identity.rolloverAtMs ||
      row.job_type !== JOB_TYPE ||
      row.occurrence_key !== identity.occurrenceKey ||
      row.scheduled_for_ms !== identity.rolloverAtMs ||
      row.job_run_id === null
    ) {
      incompatible(
        "The rollover finalization binding is split.",
        "FINALIZATION_BINDING_INVALID"
      );
    }
    return row;
  }

  function validateLiveFence(row, command, terminalAtMs) {
    if (
      !["scheduled", "recovery_required"].includes(row.status) ||
      row.version !== command.expectedRolloverVersion ||
      row.job_run_id !== command.runId ||
      row.job_status !== "running" ||
      row.job_version !== command.expectedVersion ||
      row.job_attempt_count !== command.attemptCount ||
      row.job_lease_owner !== command.leaseOwner ||
      row.job_lease_token !== command.leaseToken ||
      row.job_lease_expires_at_ms !== command.leaseExpiresAtMs ||
      row.job_started_at_ms !== command.startedAtMs ||
      row.job_completed_at_ms !== null ||
      row.job_result_json !== null ||
      row.job_last_error_code !== null ||
      row.job_next_attempt_at_ms !== null ||
      command.leaseExpiresAtMs <= terminalAtMs
    ) {
      conflict(
        "The rollover or claimed job changed before execution.",
        "FINALIZATION_FENCE_CHANGED"
      );
    }
    if (
      row.status === "scheduled" &&
      (
        row.processing_job_run_id !== null ||
        row.processing_started_at_ms !== null ||
        row.completed_at_ms !== null ||
        row.last_error_code !== null
      )
    ) {
      incompatible(
        "The scheduled rollover contains premature processing evidence.",
        "ROLLOVER_STATE_INVALID"
      );
    }
  }

  function mapResolutionStatus(value) {
    if (value === null) return null;
    if (["resolved", "no_bids", "no_winner", "recovered"].includes(value)) {
      return "succeeded";
    }
    if (value === "cancelled") return "cancelled";
    if (value === "failed") return "failed";
    return null;
  }

  function policyInput(row, command) {
    const successor = uniqueRow(
      successorStatement.all(command),
      "The rollover successor"
    );
    const recoveries = recoveriesStatement.all(command).map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      rolloverId: item.rollover_id,
      allocationId: item.allocation_id,
      auctionId: item.auction_id,
      nominationQueueId: item.nomination_queue_id,
      playerId: item.player_id,
      jobRunId: item.job_run_id,
    }));
    const auctions = auctionsStatement.all(command).map((item) => ({
      id: item.id,
      playerId: item.player_id,
      status: item.status,
      resolutionStatus: mapResolutionStatus(item.resolution_status),
      resolutionOutcomeCode: item.resolution_outcome_code,
      jobStatus: item.job_status,
      recoveryId: item.recovery_id,
      recoveryStatus: item.recovery_status,
      recoveryPlayerId: item.recovery_player_id,
      recoveryAuctionId: item.recovery_auction_id,
      recoveryJobRunId: item.recovery_job_run_id,
      recoveryRolloverId: item.recovery_rollover_id,
    }));
    const nominations = nominationsStatement.all(command).map((item) => ({
      id: item.id,
      playerId: item.player_id,
      jobRunId: item.job_run_id,
      status: item.status,
      openedAuctionId: item.opened_auction_id,
      validationCode: item.validation_code,
      jobStatus: item.job_status,
      recoveryId: item.recovery_id,
      recoveryStatus: item.recovery_status,
    }));
    const fallbacks = fallbacksStatement.all(command).map((item) => ({
      sourceAuctionId: item.source_auction_id,
      allocationId: item.allocation_id,
      required: true,
      createdAuctionId: item.created_auction_id,
      successorRolloverId: item.successor_rollover_id,
    }));
    try {
      return evaluateFreeAgentDraftRolloverFinalization({
        rollover: {
          id: row.id,
          leagueId: row.league_id,
          seasonId: row.season_id,
          fadId: row.fad_id,
          sequence: row.sequence,
          rollsOverAtMs: row.rolls_over_at_ms,
          status: row.status,
          nowMs: command.finalizedAtMs,
        },
        auctions,
        nominations,
        fallbacks,
        recoveries,
        successor: successor === null ? null : {
          id: successor.id,
          sequence: successor.sequence,
          predecessorRolloverId: successor.predecessor_rollover_id,
          opensAtMs: successor.opens_at_ms,
          rollsOverAtMs: successor.rolls_over_at_ms,
          status: successor.status,
        },
      });
    } catch (error) {
      if (error instanceof FreeAgentDraftRolloverFinalizationPolicyError) {
        incompatible(
          "The persisted rollover boundary evidence is malformed.",
          error.reasonCode,
          error
        );
      }
      throw error;
    }
  }

  function sourceRecovery(row, command) {
    const wrappers = recoveriesStatement.all(command).filter(
      (item) => item.kind === "rollover_finalize"
    );
    if (
      wrappers.length > 1 ||
      (
        wrappers.length === 1 &&
        wrappers[0].job_run_id !== row.job_run_id
      )
    ) {
      incompatible(
        "The rollover has ambiguous finalization recovery evidence.",
        "ROLLOVER_RECOVERY_AMBIGUOUS"
      );
    }
    return wrappers[0] || null;
  }

  function readSuccessor(scope) {
    return uniqueRow(
      successorStatement.all(scope),
      "The rollover successor"
    );
  }

  function successorOccurrence(successor, fadId) {
    return buildFreeAgentDraftRolloverOccurrenceKey({
      fadId,
      sequence: successor.sequence,
      rolloverAtMs: successor.rolls_over_at_ms,
    });
  }

  function readSuccessorJob(scope, successor) {
    return uniqueRow(
      successorJobStatement.all({
        ...scope,
        successorOccurrenceKey: successorOccurrence(
          successor,
          scope.fadId
        ),
        successorRolloverAtMs: successor.rolls_over_at_ms,
      }),
      "The rollover successor job"
    );
  }

  function validateSuccessor(scope, successor) {
    if (!successor) return null;
    if (
      scope.rolloverAtMs > MAX_TIMESTAMP_MS - FREE_AGENT_DRAFT_DAY_MS ||
      successor.sequence !== scope.sequence + 1 ||
      successor.window_kind !== "extension" ||
      successor.predecessor_rollover_id !== scope.rolloverId ||
      !["queued_nomination", "restricted_auction", "fallback_auction", "recovery"]
        .includes(successor.extension_reason) ||
      !UUID_PATTERN.test(successor.extension_source_id || "") ||
      successor.opens_at_ms !== scope.rolloverAtMs ||
      successor.rolls_over_at_ms !==
        scope.rolloverAtMs + FREE_AGENT_DRAFT_DAY_MS ||
      successor.creation_cutoff_at_ms !==
        successor.rolls_over_at_ms -
          FREE_AGENT_DRAFT_CREATION_CUTOFF_MS
    ) {
      incompatible(
        "The rollover successor is not a contiguous canonical window.",
        "SUCCESSOR_INVALID"
      );
    }
    const job = readSuccessorJob(scope, successor);
    if (!job) {
      incompatible(
        "The rollover successor lacks its canonical job.",
        "SUCCESSOR_JOB_MISSING"
      );
    }
    return { successor, job };
  }

  function responseEvidence(decision) {
    return deepFreeze({
      reasonCode: decision.reasonCode,
      ...decision.evidence,
    });
  }

  function completedResponse(command, decision, {
    rolloverVersion,
    sourceRecoveryId,
  }) {
    return deepFreeze({
      outcome: "completed",
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      rolloverId: command.rolloverId,
      sequence: command.sequence,
      rolloverAtMs: command.rolloverAtMs,
      finalizedAtMs: command.finalizedAtMs,
      rolloverVersion,
      jobRunId: command.runId,
      jobRunVersion: command.expectedVersion + 1,
      sourceRecoveryId,
      evidence: responseEvidence(decision),
    });
  }

  function failureProjection(command, row, recovery, {
    extensionRolloverId,
    extensionJobRunId,
    replayed,
  }) {
    return deepFreeze({
      outcome: "failure_recorded",
      replayed,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      rolloverId: command.rolloverId,
      sequence: command.sequence,
      rolloverAtMs: command.rolloverAtMs,
      failedAtMs: row.completed_at_ms,
      rolloverVersion: row.version,
      jobRunId: row.job_run_id,
      jobRunVersion: row.job_version,
      recoveryId: recovery.id,
      extensionRolloverId,
      extensionJobRunId,
      failureCode:
        FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
    });
  }

  function validateFailureReplay(row, identity, command) {
    if (
      row.status !== "recovery_required" ||
      row.job_status !== "failed" ||
      row.processing_job_run_id !== row.job_run_id ||
      row.completed_at_ms === null ||
      row.completed_at_ms !== row.updated_at_ms ||
      row.completed_at_ms !== row.job_completed_at_ms ||
      row.last_error_code !==
        FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE ||
      row.job_last_error_code !==
        FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE ||
      row.job_result_json !== null ||
      row.job_lease_owner !== null ||
      row.job_lease_token !== null ||
      row.job_lease_expires_at_ms !== null ||
      row.job_next_attempt_at_ms !== null
    ) {
      incompatible(
        "The rollover failure replay is split.",
        "FAILURE_REPLAY_INVALID"
      );
    }
    const recovery = sourceRecovery(row, identity);
    if (
      !recovery ||
      recovery.status !== "correction_required" ||
      recovery.last_error_code !==
        FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE ||
      recovery.created_by_operation_id !== row.job_run_id ||
      recovery.updated_at_ms !== row.completed_at_ms ||
      recovery.resolved_at_ms !== null ||
      recovery.resolved_authority !== null
    ) {
      incompatible(
        "The rollover failure lacks its exact causal recovery.",
        "FAILURE_RECOVERY_INVALID"
      );
    }
    const initialFailure =
      recovery.version === 1 &&
      recovery.created_at_ms === row.completed_at_ms;
    const repeatedFailure =
      recovery.version >= 3 &&
      recovery.created_at_ms <= row.completed_at_ms;
    if (!initialFailure && !repeatedFailure) {
      incompatible(
        "The rollover failure recovery lost its source-state witness.",
        "FAILURE_RECOVERY_VERSION_INVALID"
      );
    }
    const successor = readSuccessor(identity);
    let extensionRolloverId = null;
    let extensionJobRunId = null;
    if (
      successor &&
      successor.extension_reason === "recovery" &&
      successor.extension_source_id === recovery.id &&
      successor.created_at_ms === row.completed_at_ms
    ) {
      const validated = validateSuccessor(identity, successor);
      extensionRolloverId = successor.id;
      extensionJobRunId = validated.job.id;
    }
    if (command) {
      const rolloverDelta =
        row.version - command.expectedRolloverVersion;
      if (
        row.job_run_id !== command.runId ||
        row.completed_at_ms !== command.failedAtMs ||
        row.job_version !== command.expectedVersion + 1 ||
        (!initialFailure && !repeatedFailure) ||
        rolloverDelta !== (initialFailure ? 2 : 1)
      ) {
        conflict(
          "The rollover failure command differs from terminal replay.",
          "FAILURE_REPLAY_MISMATCH"
        );
      }
    }
    const projectionCommand = command || {
      ...identity,
      runId: row.job_run_id,
    };
    return failureProjection(
      projectionCommand,
      row,
      recovery,
      {
        extensionRolloverId,
        extensionJobRunId,
        replayed: true,
      }
    );
  }

  function storedResult(command, response) {
    return serializeCanonicalJsonV1({
      schemaVersion: 1,
      operation: OPERATION,
      identity: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        rolloverId: command.rolloverId,
        sequence: command.sequence,
        rolloverAtMs: command.rolloverAtMs,
        occurrenceKey: command.occurrenceKey,
        jobRunId: command.runId,
      },
      request: {
        expectedRolloverVersion: command.expectedRolloverVersion,
        expectedJobVersion: command.expectedVersion,
        finalizedAtMs: command.finalizedAtMs,
      },
      response,
    });
  }

  function validateCompletedReplay(row, identity, command) {
    let stored;
    try {
      stored = parseCanonicalJsonV1(row.job_result_json);
    } catch (error) {
      incompatible(
        "The persisted rollover result is not canonical JSON.",
        "REPLAY_RESULT_INVALID",
        error
      );
    }
    assertPersistedObject(stored, STORED_FIELDS, "rollover result");
    assertPersistedObject(
      stored.identity,
      STORED_IDENTITY_FIELDS,
      "rollover identity"
    );
    assertPersistedObject(
      stored.request,
      STORED_REQUEST_FIELDS,
      "rollover request"
    );
    assertPersistedObject(
      stored.response,
      RESPONSE_FIELDS,
      "rollover response"
    );
    assertPersistedObject(
      stored.response.evidence,
      EVIDENCE_FIELDS,
      "rollover evidence"
    );
    const expectedIdentity = {
      leagueId: identity.leagueId,
      seasonId: identity.seasonId,
      fadId: identity.fadId,
      rolloverId: identity.rolloverId,
      sequence: identity.sequence,
      rolloverAtMs: identity.rolloverAtMs,
      occurrenceKey: identity.occurrenceKey,
      jobRunId: row.job_run_id,
    };
    if (
      stored.schemaVersion !== 1 ||
      stored.operation !== OPERATION ||
      serializeCanonicalJsonV1(stored.identity) !==
        serializeCanonicalJsonV1(expectedIdentity) ||
      stored.response.outcome !== "completed" ||
      stored.response.rolloverVersion !== row.version ||
      stored.response.jobRunVersion !== row.job_version ||
      stored.response.finalizedAtMs !== row.completed_at_ms ||
      stored.response.finalizedAtMs !== row.job_completed_at_ms ||
      row.status !== "completed" ||
      row.job_status !== "succeeded" ||
      row.last_error_code !== null ||
      row.job_last_error_code !== null
    ) {
      incompatible(
        "The persisted rollover result is split from terminal state.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    const response = stored.response;
    const recovery = sourceRecovery(row, identity);
    if (
      response.leagueId !== identity.leagueId ||
      response.seasonId !== identity.seasonId ||
      response.fadId !== identity.fadId ||
      response.rolloverId !== identity.rolloverId ||
      response.sequence !== identity.sequence ||
      response.rolloverAtMs !== identity.rolloverAtMs ||
      response.jobRunId !== row.job_run_id ||
      !Number.isSafeInteger(response.finalizedAtMs) ||
      !Number.isSafeInteger(response.rolloverVersion) ||
      !Number.isSafeInteger(response.jobRunVersion) ||
      (
        response.sourceRecoveryId !== null &&
        !UUID_PATTERN.test(response.sourceRecoveryId)
      ) ||
      response.evidence.reasonCode !== "boundary_accounted" ||
      Object.entries(response.evidence).some(([field, value]) =>
        field !== "reasonCode" &&
        (!Number.isSafeInteger(value) || value < 0)
      ) ||
      (
        response.sourceRecoveryId === null &&
        recovery !== null
      ) ||
      (
        response.sourceRecoveryId !== null &&
        (
          !recovery ||
          recovery.id !== response.sourceRecoveryId ||
          recovery.status !== "resolved" ||
          recovery.resolved_authority !== "system" ||
          recovery.resolved_at_ms !== response.finalizedAtMs
        )
      )
    ) {
      incompatible(
        "The persisted rollover response is malformed.",
        "REPLAY_RESPONSE_INVALID"
      );
    }
    if (command) {
      const expectedRequest = {
        expectedRolloverVersion: command.expectedRolloverVersion,
        expectedJobVersion: command.expectedVersion,
        finalizedAtMs: command.finalizedAtMs,
      };
      if (
        serializeCanonicalJsonV1(stored.request) !==
          serializeCanonicalJsonV1(expectedRequest) ||
        row.job_run_id !== command.runId
      ) {
        conflict(
          "The rollover command differs from its completed replay.",
          "FINALIZATION_REPLAY_MISMATCH"
        );
      }
    }
    return deepFreeze({ ...stored.response, replayed: true });
  }

  function invokeBeforeCommit(operation, command, result) {
    if (!beforeCommit) return;
    const returned = beforeCommit({ operation, command, result });
    if (returned && typeof returned.then === "function") {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.transactionAsync,
        "FAD rollover beforeCommit must be synchronous."
      );
    }
  }

  const ensureTransaction = database.transaction((command) => {
    const rows = missingJobsStatement.all(command);
    const issued = new Set();
    const created = [];
    for (const row of rows) {
      const occurrenceKey = buildFreeAgentDraftRolloverOccurrenceKey({
        fadId: row.fad_id,
        sequence: row.sequence,
        rolloverAtMs: row.rolls_over_at_ms,
      });
      const jobRunId = createIdentity("rollover job", issued);
      const entry = {
        leagueId: row.league_id,
        seasonId: row.season_id,
        fadId: row.fad_id,
        rolloverId: row.id,
        sequence: row.sequence,
        rolloverAtMs: row.rolls_over_at_ms,
        occurrenceKey,
        jobRunId,
        createdAtMs: command.ensuredAtMs,
      };
      insertJobStatement.run(entry);
      created.push(entry);
    }
    const result = deepFreeze(created);
    invokeBeforeCommit("ensurePendingJobs", command, result);
    return result;
  });

  const executeTransaction = database.transaction((command) => {
    let row = validateBinding(readFinalization(command), command);
    if (!row) {
      notFound(
        "The exact rollover finalization binding was not found.",
        "FINALIZATION_NOT_FOUND"
      );
    }
    if (row.job_status === "succeeded") {
      return validateCompletedReplay(row, command, command);
    }
    validateLiveFence(row, command, command.finalizedAtMs);
    const decision = policyInput(row, command);
    if (decision.outcome !== "completed") {
      return deepFreeze({ ...decision, replayed: false });
    }
    const recovery = sourceRecovery(row, command);
    if (row.status === "scheduled") {
      if (
        startProcessingStatement.run({
          ...command,
          terminalAtMs: command.finalizedAtMs,
        }).changes !== 1
      ) {
        conflict(
          "The rollover changed before processing began.",
          "ROLLOVER_PROCESSING_CAS_FAILED"
        );
      }
      row = validateBinding(readFinalization(command), command);
    } else if (
      !recovery ||
      recovery.status !== "running" ||
      command.attemptCount < 2
    ) {
      conflict(
        "The recovery-required rollover lacks an exact running T142 recovery.",
        "ROLLOVER_RECOVERY_NOT_RUNNING"
      );
    }
    const sourceStatus = row.status;
    const sourceRolloverVersion = row.version;
    const terminalRolloverVersion = sourceRolloverVersion + 1;
    const response = completedResponse(command, decision, {
      rolloverVersion: terminalRolloverVersion,
      sourceRecoveryId: recovery?.id || null,
    });
    if (
      completeRolloverStatement.run({
        ...command,
        sourceStatus,
        sourceRolloverVersion,
      }).changes !== 1
    ) {
      conflict(
        "The rollover changed before completion.",
        "ROLLOVER_COMPLETION_CAS_FAILED"
      );
    }
    if (
      recovery &&
      resolveRecoveryStatement.run({
        ...command,
        sourceRecoveryId: recovery.id,
        sourceRecoveryVersion: recovery.version,
      }).changes !== 1
    ) {
      conflict(
        "The rollover recovery changed before resolution.",
        "RECOVERY_RESOLUTION_CAS_FAILED"
      );
    }
    if (
      succeedJobStatement.run({
        ...command,
        resultJson: storedResult(command, response),
      }).changes !== 1
    ) {
      conflict(
        "The rollover job changed before completion.",
        "JOB_COMPLETION_CAS_FAILED"
      );
    }
    invokeBeforeCommit("executeClaimed", command, response);
    const terminal = validateBinding(readFinalization(command), command);
    const replay = validateCompletedReplay(terminal, command);
    return deepFreeze({ ...replay, replayed: false });
  });

  const failureTransaction = database.transaction((command) => {
    let row = validateBinding(readFinalization(command), command);
    if (!row) {
      notFound(
        "The exact rollover finalization binding was not found.",
        "FINALIZATION_NOT_FOUND"
      );
    }
    if (row.job_status === "failed") {
      return validateFailureReplay(row, command, command);
    }
    if (row.job_status === "succeeded") {
      conflict(
        "The rollover already completed successfully.",
        "FINALIZATION_ALREADY_SUCCEEDED"
      );
    }
    validateLiveFence(row, command, command.failedAtMs);
    const decision = policyInput(row, {
      ...command,
      finalizedAtMs: command.failedAtMs,
    });
    if (
      decision.outcome !== "recovery_required" ||
      decision.reasonCode !== "boundary_recovery_required"
    ) {
      conflict(
        "The rollover boundary does not require terminal recovery.",
        "FAILURE_DECISION_CHANGED"
      );
    }
    let recovery = sourceRecovery(row, command);
    const issued = new Set();
    if (row.status === "scheduled") {
      if (recovery) {
        incompatible(
          "A scheduled rollover has premature recovery evidence.",
          "RECOVERY_PREMATURE"
        );
      }
      if (
        startProcessingStatement.run({
          ...command,
          terminalAtMs: command.failedAtMs,
        }).changes !== 1
      ) {
        conflict(
          "The rollover changed before failure processing began.",
          "ROLLOVER_PROCESSING_CAS_FAILED"
        );
      }
      row = validateBinding(readFinalization(command), command);
      const recoveryId = createIdentity(
        "rollover finalization recovery",
        issued
      );
      insertRecoveryStatement.run({ ...command, recoveryId });
      recovery = sourceRecovery(row, command);
      if (!recovery || recovery.id !== recoveryId) {
        incompatible(
          "The rollover recovery was not persisted exactly.",
          "RECOVERY_POSTCONDITION_FAILED"
        );
      }
    } else {
      if (
        !recovery ||
        recovery.status !== "running" ||
        command.attemptCount < 2
      ) {
        conflict(
          "The recovery-required rollover lacks an exact running T142 recovery.",
          "ROLLOVER_RECOVERY_NOT_RUNNING"
        );
      }
      if (
        failRecoveryStatement.run({
          ...command,
          recoveryId: recovery.id,
          expectedRecoveryVersion: recovery.version,
        }).changes !== 1
      ) {
        conflict(
          "The rollover recovery changed before repeated failure.",
          "RECOVERY_FAILURE_CAS_FAILED"
        );
      }
      recovery = sourceRecovery(row, command);
    }

    let successor = readSuccessor(command);
    let extensionRolloverId = null;
    let extensionJobRunId = null;
    if (!successor) {
      if (
        command.rolloverAtMs >
        MAX_TIMESTAMP_MS - FREE_AGENT_DRAFT_DAY_MS
      ) {
        invalid(
          "The recovery extension timestamp overflows.",
          "EXTENSION_TIMESTAMP_INVALID"
        );
      }
      extensionRolloverId = createIdentity(
        "rollover recovery extension",
        issued
      );
      extensionJobRunId = createIdentity(
        "rollover recovery extension job",
        issued
      );
      const extensionRolloverAtMs =
        command.rolloverAtMs + FREE_AGENT_DRAFT_DAY_MS;
      const extension = {
        ...command,
        recoveryId: recovery.id,
        extensionRolloverId,
        extensionJobRunId,
        extensionSequence: command.sequence + 1,
        extensionRolloverAtMs,
        extensionCreationCutoffAtMs:
          extensionRolloverAtMs -
          FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
        occurrenceKey: buildFreeAgentDraftRolloverOccurrenceKey({
          fadId: command.fadId,
          sequence: command.sequence + 1,
          rolloverAtMs: extensionRolloverAtMs,
        }),
        rolloverAtMs: extensionRolloverAtMs,
        jobRunId: extensionJobRunId,
        createdAtMs: command.failedAtMs,
      };
      insertExtensionStatement.run({
        ...extension,
        rolloverAtMs: command.rolloverAtMs,
      });
      insertJobStatement.run(extension);
      successor = readSuccessor(command);
      if (
        !successor ||
        successor.id !== extensionRolloverId
      ) {
        incompatible(
          "The recovery extension was not persisted exactly.",
          "EXTENSION_POSTCONDITION_FAILED"
        );
      }
    }
    const validatedSuccessor = validateSuccessor(command, successor);
    if (
      extensionRolloverId !== null &&
      (
        successor.extension_reason !== "recovery" ||
        successor.extension_source_id !== recovery.id ||
        validatedSuccessor.job.id !== extensionJobRunId
      )
    ) {
      incompatible(
        "The recovery extension causality is split.",
        "EXTENSION_CAUSALITY_INVALID"
      );
    }

    if (failJobStatement.run(command).changes !== 1) {
      conflict(
        "The rollover job changed before failure was recorded.",
        "JOB_FAILURE_CAS_FAILED"
      );
    }
    const sourceStatus = row.status;
    const sourceRolloverVersion = row.version;
    if (
      failRolloverStatement.run({
        ...command,
        sourceStatus,
        sourceRolloverVersion,
      }).changes !== 1
    ) {
      conflict(
        "The rollover changed before failure was recorded.",
        "ROLLOVER_FAILURE_CAS_FAILED"
      );
    }
    const terminal = validateBinding(readFinalization(command), command);
    const replay = validateFailureReplay(terminal, command, command);
    const result = deepFreeze({
      ...replay,
      replayed: false,
      extensionRolloverId,
      extensionJobRunId,
    });
    invokeBeforeCommit("recordFailure", command, result);
    return result;
  });

  return Object.freeze({
    ensurePendingJobs(input = {}) {
      const command = normalizeEnsure(input);
      if (database.inTransaction) {
        conflict(
          "Rollover job ensuring owns its immediate transaction boundary.",
          "TRANSACTION_ALREADY_ACTIVE"
        );
      }
      try {
        return ensureTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "ensurePendingFreeAgentDraftRolloverJobs",
          tableName: "job_runs",
        });
      }
    },

    findFinalization(input = {}) {
      const identity = normalizeIdentity(input);
      try {
        const row = validateBinding(readFinalization(identity), identity);
        if (!row) return null;
        if (row.job_status === "succeeded") {
          return validateCompletedReplay(row, identity);
        }
        if (row.job_status === "failed") {
          return validateFailureReplay(row, identity);
        }
        const recovery = sourceRecovery(row, identity);
        return deepFreeze({
          leagueId: row.league_id,
          seasonId: row.season_id,
          fadId: row.fad_id,
          rolloverId: row.id,
          sequence: row.sequence,
          rolloverAtMs: row.rolls_over_at_ms,
          status: row.status,
          rolloverVersion: row.version,
          occurrenceKey: row.occurrence_key,
          jobRunId: row.job_run_id,
          jobStatus: row.job_status,
          jobRunVersion: row.job_version,
          sourceRecoveryId: recovery?.id || null,
          sourceRecoveryStatus: recovery?.status || null,
          sourceRecoveryVersion: recovery?.version || null,
          replayed: false,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findFreeAgentDraftRolloverFinalization",
          tableName: "free_agent_draft_rollovers",
        });
      }
    },

    executeClaimed(input = {}) {
      const command = normalizeCommand(input, { failure: false });
      if (database.inTransaction) {
        conflict(
          "Rollover finalization owns its immediate transaction boundary.",
          "TRANSACTION_ALREADY_ACTIVE"
        );
      }
      try {
        return executeTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "executeClaimedFreeAgentDraftRolloverFinalization",
          tableName: "free_agent_draft_rollovers",
        });
      }
    },

    recordFailure(input = {}) {
      const command = normalizeCommand(input, { failure: true });
      if (database.inTransaction) {
        conflict(
          "Rollover failure recording owns its immediate transaction boundary.",
          "TRANSACTION_ALREADY_ACTIVE"
        );
      }
      try {
        return failureTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "recordFailedFreeAgentDraftRolloverFinalization",
          tableName: "free_agent_draft_rollovers",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_ROLLOVER_FAILURE_CODE,
  FREE_AGENT_DRAFT_ROLLOVER_JOB_TYPE: JOB_TYPE,
  FREE_AGENT_DRAFT_ROLLOVER_WRITER_METHODS: METHODS,
  createSqliteFreeAgentDraftRolloverWriter,
};
