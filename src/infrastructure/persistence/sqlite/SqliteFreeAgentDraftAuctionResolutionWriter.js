"use strict";

const { randomUUID } = require("node:crypto");

const {
  ContractSeasonPlannerError,
  planContractSeasons,
} = require("../../../domain/contracts/contractSeasonPlanner");
const {
  ContractPolicyError,
  createNormalContractAggregate,
} = require("../../../domain/contracts/contractPolicy");
const {
  RosterAssignmentPolicyError,
  createRosterAssignmentRecord,
} = require("../../../domain/rosters/rosterAssignmentPolicy");
const {
  RosterMovementPolicyError,
  evaluateStructuralRosterLegality,
} = require("../../../domain/rosters/rosterMovementPolicy");
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
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
  serializeCanonicalJsonV1,
} = require("../../../domain/leagues/seasonRolloverEvidencePolicy");
const {
  FreeAgentDraftAuctionResolutionPolicyError,
  evaluateFreeAgentDraftAuctionResolution,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionResolutionPolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE =
  "auction.resolve.target";
const FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE =
  "AUCTION_RESOLUTION_FAILED";
const FREE_AGENT_DRAFT_AUCTION_RESOLUTION_WRITER_METHODS =
  Object.freeze([
    "listDue",
    "claimDue",
    "findResolution",
    "executeClaimed",
    "recordFailure",
  ]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const AUCTION_BUYOUT_LOCK_MS = 14 * 24 * 60 * 60 * 1000;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const CLAIM_FIELDS = Object.freeze([
  "auctionId",
  "expectedAuctionVersion",
  "expectedJobVersion",
  "jobExecution",
  "leagueId",
  "nowMs",
  "occurrenceKey",
  "seasonId",
]);
const EXECUTE_FIELDS = Object.freeze([
  "allocationId",
  "auctionId",
  "expectedAllocationVersion",
  "expectedAuctionVersion",
  "expectedJobVersion",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "playerId",
  "resolvedAtMs",
  "rolloverId",
  "seasonId",
]);
const FAILURE_FIELDS = Object.freeze([
  "allocationId",
  "auctionId",
  "expectedAllocationVersion",
  "expectedAuctionVersion",
  "expectedJobVersion",
  "fadId",
  "failedAtMs",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "playerId",
  "rolloverId",
  "seasonId",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
]);

function invalid(message, reasonCode = "INPUT_INVALID") {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    { details: { reasonCode } }
  );
}

function conflict(message, reasonCode = "VERSION_CONFLICT") {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    { details: { reasonCode } }
  );
}

function notFound(message, reasonCode = "RECORD_NOT_FOUND") {
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
  ) {
    return false;
  }
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

function stableId(value, description) {
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

function positiveVersion(value, description) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(
      `A positive ${description} is required.`,
      "VERSION_INVALID"
    );
  }
  return value;
}

function nonnegativeVersion(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(
      `A nonnegative ${description} is required.`,
      "VERSION_INVALID"
    );
  }
  return value;
}

function normalizeAllocationBinding(allocationId, allocationVersion) {
  if (allocationId === null) {
    if (allocationVersion !== 0) {
      invalid(
        "An allocation-null FAD auction requires allocation version zero.",
        "ALLOCATION_BINDING_INVALID"
      );
    }
    return Object.freeze({ allocationId: null, allocationVersion: 0 });
  }
  if (
    !Number.isSafeInteger(allocationVersion) ||
    allocationVersion < 1
  ) {
    invalid(
      "An allocation-linked FAD auction requires a positive allocation version.",
      "ALLOCATION_BINDING_INVALID"
    );
  }
  return Object.freeze({
    allocationId: stableId(allocationId, "allocation"),
    allocationVersion,
  });
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
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function uniqueRow(statement, parameters, description) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(
      `${description} is ambiguous.`,
      "STORED_STATE_AMBIGUOUS"
    );
  }
  return rows[0] || null;
}

function occurrenceKey(auctionId, resolvesAtMs) {
  return `auction:${auctionId}:${resolvesAtMs}`;
}

function normalizeJobExecution(value) {
  exactObject(
    value,
    JOB_EXECUTION_FIELDS,
    "FAD auction-resolution job execution"
  );
  return Object.freeze({
    runId: stableId(value.runId, "job-run"),
    leaseOwner: boundedText(value.leaseOwner, 128, "lease owner"),
    leaseToken: stableId(value.leaseToken, "lease token"),
    leaseExpiresAtMs: safeTimestamp(
      value.leaseExpiresAtMs,
      "lease expiry"
    ),
  });
}

function normalizeClaim(input) {
  exactObject(input, CLAIM_FIELDS, "FAD auction-resolution claim");
  const jobExecution = normalizeJobExecution(input.jobExecution);
  const nowMs = safeTimestamp(input.nowMs, "claim timestamp");
  if (jobExecution.leaseExpiresAtMs <= nowMs) {
    invalid(
      "The FAD auction-resolution lease must expire after its claim.",
      "LEASE_EXPIRY_INVALID"
    );
  }
  return Object.freeze({
    leagueId: stableId(input.leagueId, "league"),
    seasonId: stableId(input.seasonId, "season"),
    auctionId: stableId(input.auctionId, "auction"),
    occurrenceKey: boundedText(
      input.occurrenceKey,
      500,
      "resolution occurrence key"
    ),
    expectedAuctionVersion: positiveVersion(
      input.expectedAuctionVersion,
      "auction version"
    ),
    expectedJobVersion: nonnegativeVersion(
      input.expectedJobVersion,
      "job version"
    ),
    nowMs,
    ...jobExecution,
  });
}

function normalizeExecute(input) {
  exactObject(
    input,
    EXECUTE_FIELDS,
    "FAD auction-resolution execution"
  );
  const jobExecution = normalizeJobExecution(input.jobExecution);
  const resolvedAtMs = safeTimestamp(
    input.resolvedAtMs,
    "resolution timestamp"
  );
  if (jobExecution.leaseExpiresAtMs <= resolvedAtMs) {
    invalid(
      "The FAD auction-resolution lease must outlive execution.",
      "LEASE_EXPIRY_INVALID"
    );
  }
  const allocation = normalizeAllocationBinding(
    input.allocationId,
    input.expectedAllocationVersion
  );
  return Object.freeze({
    leagueId: stableId(input.leagueId, "league"),
    seasonId: stableId(input.seasonId, "season"),
    fadId: stableId(input.fadId, "Free Agent Draft"),
    allocationId: allocation.allocationId,
    playerId: stableId(input.playerId, "player"),
    rolloverId: stableId(input.rolloverId, "rollover"),
    auctionId: stableId(input.auctionId, "auction"),
    occurrenceKey: boundedText(
      input.occurrenceKey,
      500,
      "resolution occurrence key"
    ),
    expectedAuctionVersion: positiveVersion(
      input.expectedAuctionVersion,
      "auction version"
    ),
    expectedAllocationVersion: allocation.allocationVersion,
    expectedJobVersion: positiveVersion(
      input.expectedJobVersion,
      "job version"
    ),
    resolvedAtMs,
    ...jobExecution,
  });
}

function normalizeFailure(input) {
  exactObject(
    input,
    FAILURE_FIELDS,
    "FAD auction-resolution failure"
  );
  const jobExecution = normalizeJobExecution(input.jobExecution);
  const failedAtMs = safeTimestamp(
    input.failedAtMs,
    "failure timestamp"
  );
  if (jobExecution.leaseExpiresAtMs <= failedAtMs) {
    invalid(
      "The FAD auction-resolution lease must outlive failure recording.",
      "LEASE_EXPIRY_INVALID"
    );
  }
  const allocation = normalizeAllocationBinding(
    input.allocationId,
    input.expectedAllocationVersion
  );
  return Object.freeze({
    leagueId: stableId(input.leagueId, "league"),
    seasonId: stableId(input.seasonId, "season"),
    fadId: stableId(input.fadId, "Free Agent Draft"),
    allocationId: allocation.allocationId,
    playerId: stableId(input.playerId, "player"),
    rolloverId: stableId(input.rolloverId, "rollover"),
    auctionId: stableId(input.auctionId, "auction"),
    occurrenceKey: boundedText(
      input.occurrenceKey,
      500,
      "resolution occurrence key"
    ),
    expectedAuctionVersion: positiveVersion(
      input.expectedAuctionVersion,
      "auction version"
    ),
    expectedAllocationVersion: allocation.allocationVersion,
    expectedJobVersion: positiveVersion(
      input.expectedJobVersion,
      "job version"
    ),
    failedAtMs,
    resolvedAtMs: failedAtMs,
    errorCode: FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE,
    ...jobExecution,
  });
}

function assertChanged(result, description, reasonCode) {
  if (result.changes !== 1) {
    conflict(`${description} changed concurrently.`, reasonCode);
  }
}

function roundedAav(totalValueCents, termYears) {
  const whole = Math.floor(totalValueCents / termYears);
  const remainder = totalValueCents % termYears;
  return whole + (remainder * 2 >= termYears ? 1 : 0);
}

function isFreeAgentDraftAuctionResolutionTerminalFailure(error) {
  return Boolean(
    error &&
    error.details?.terminalFailure === true &&
    typeof error.details?.reasonCode === "string" &&
    typeof error.details?.policyCode === "string"
  );
}

function mapExecutionError(error) {
  const terminalDomainError =
    error instanceof FreeAgentDraftAuctionResolutionPolicyError ||
    error instanceof ContractSeasonPlannerError ||
    error instanceof ContractPolicyError ||
    error instanceof RosterAssignmentPolicyError ||
    error instanceof RosterMovementPolicyError;
  const winnerResourceUnavailable =
    error?.details?.reasonCode === "WINNER_RESOURCE_UNAVAILABLE";
  if (terminalDomainError || winnerResourceUnavailable) {
    return repositoryError(
      REPOSITORY_ERROR_CODES.operationFailed,
      "The FAD auction reached a deterministic terminal resolution failure.",
      {
        cause: error,
        details: {
          terminalFailure: true,
          policyCode: terminalDomainError
            ? error.code
            : "FAD_AUCTION_RESOLUTION_RESOURCE_UNAVAILABLE",
          reasonCode: terminalDomainError
            ? error.reasonCode
            : "WINNER_RESOURCE_UNAVAILABLE",
        },
      }
    );
  }
  return mapRepositoryError(error, {
    operation: "executeClaimedFreeAgentDraftAuctionResolution",
    tableName: "auction_resolutions",
  });
}

function createSqliteFreeAgentDraftAuctionResolutionWriter({
  database,
  createId = () => randomUUID(),
  candidateCardSummerSynchronizer,
  leagueOutboxWriter,
  notificationWriter,
  restrictedFallbackWriter,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftAuctionResolutionWriter requires an opened database"
    );
  }
  if (typeof createId !== "function") {
    throw new TypeError(
      "FAD auction-resolution identifier creation must be a function"
    );
  }
  if (
    !candidateCardSummerSynchronizer ||
    typeof candidateCardSummerSynchronizer.synchronize !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftAuctionResolutionWriter requires a Candidate Card summer synchronizer"
    );
  }
  if (
    !restrictedFallbackWriter ||
    typeof restrictedFallbackWriter.openFallback !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftAuctionResolutionWriter requires the shared restricted fallback writer"
    );
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError(
      "FAD auction-resolution beforeCommit must be a function"
    );
  }

  let seasonsRepository;
  let contractsRepository;
  let contractYearsRepository;
  let contractEventsRepository;
  let ownershipsRepository;
  let ownershipEventsRepository;
  let auctionEventsRepository;
  let resolutionsRepository;
  let activityRepository;
  let capRepository;
  let outboxWriter;
  let notificationsWriter;

  let listDueStatement;
  let sourceStatement;
  let bidsStatement;
  let participantsStatement;
  let findResolutionStatement;
  let resolutionEvidenceStatement;
  let terminalAuctionEventStatement;
  let resolutionActivityStatement;
  let resolutionOutboxStatement;
  let resolutionNotificationStatement;
  let resolutionRecipientStatement;
  let commissionerRecipientStatement;
  let notificationByDeduplicationStatement;
  let correctionNotificationEvidenceStatement;
  let notificationOutboxStatement;
  let failurePublicationOutboxStatement;
  let failureReplayStatement;
  let recoveryResumeStatement;
  let listSeasonsStatement;
  let findPositionCorrectionStatement;
  let listSourcePositionsStatement;
  let listOccupiedSlotsStatement;
  let listRosterRowsStatement;
  let listBidHistoryStatement;
  let findHistoricalMembershipStatement;
  let findHistoricalManagerAssignmentStatement;
  let offerEventsStatement;
  let recoveryStatement;
  let targetRolloverStatement;
  let extensionPredecessorStatement;
  let fallbackRecipientCountStatement;
  let claimJobStatement;
  let insertPendingJobStatement;
  let claimAuctionStatement;
  let resumeFailedAuctionStatement;
  let resumeAllocationStatement;
  let updateBidStatusStatement;
  let updateAllocationWinnerStatement;
  let updateAllocationNoWinnerStatement;
  let insertAllocationEventStatement;
  let revealDrawStatement;
  let terminalizeAuctionStatement;
  let resolveRecoveryStatement;
  let succeedJobStatement;
  let updateAllocationFailureStatement;
  let insertFailureRecoveryStatement;
  let failRecoveryStatement;
  let failJobStatement;
  let failAuctionStatement;
  let claimTransaction;
  let executeTransaction;
  let recordFailureTransaction;

  try {
    seasonsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("seasons"),
    });
    contractsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("contracts"),
    });
    contractYearsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("contract_years"),
    });
    contractEventsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("contract_events"),
    });
    ownershipsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("player_ownerships"),
    });
    ownershipEventsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("ownership_events"),
    });
    auctionEventsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("auction_events"),
    });
    resolutionsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("auction_resolutions"),
    });
    activityRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("league_activity"),
    });
    capRepository = createSqliteCapReadRepository({ database });
    outboxWriter = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    notificationsWriter = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });

    listDueStatement = database.prepare(`
      SELECT
        auction.id AS auction_id,
        auction.league_id,
        auction.season_id,
        auction.player_id,
        auction.resolves_at_ms,
        auction.status AS auction_status,
        auction.version AS auction_version,
        context.fad_id,
        fad.version AS fad_version,
        context.fad_rollover_id AS rollover_id,
        context.fad_allocation_id AS allocation_id,
        context.source_kind,
        context.fad_origin,
        allocation.status AS allocation_status,
        allocation.updated_at_ms AS allocation_updated_at_ms,
        allocation.version AS allocation_version,
        job.id AS job_run_id,
        job.status AS job_status,
        job.version AS job_version,
        job.attempt_count,
        job.lease_expires_at_ms
      FROM auctions AS auction
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = context.league_id
       AND fad.season_id = context.season_id
       AND fad.id = context.fad_id
      LEFT JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = context.league_id
       AND allocation.season_id = context.season_id
       AND allocation.fad_id = context.fad_id
       AND allocation.id = context.fad_allocation_id
       AND allocation.player_id = auction.player_id
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = context.league_id
       AND draw.season_id = context.season_id
       AND draw.fad_id = context.fad_id
       AND draw.allocation_id IS context.fad_allocation_id
       AND draw.auction_id = context.auction_id
      LEFT JOIN job_runs AS job
        ON job.league_id = auction.league_id
       AND job.season_id = auction.season_id
       AND job.job_type = '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE}'
       AND job.occurrence_key =
            'auction:' || auction.id || ':' || auction.resolves_at_ms
       AND job.scheduled_for_ms = auction.resolves_at_ms
      WHERE auction.status IN ('open', 'resolving', 'failed')
        AND auction.resolves_at_ms <= @nowMs
        AND draw.revealed_at_ms IS NULL
        AND draw.version = 1
        AND (
          (
            context.source_kind = 'fad_restricted'
            AND context.fad_origin = 'candidate_tie_restricted'
            AND allocation.status = 'restricted_active'
            AND allocation.restricted_auction_id = auction.id
          )
          OR (
            context.source_kind = 'fad_open_rapid'
            AND context.fad_origin =
              'restricted_no_improvement_fallback'
            AND allocation.status = 'restricted_fallback_open'
            AND allocation.fallback_open_auction_id = auction.id
          )
          OR (
            context.source_kind = 'fad_open_rapid'
            AND context.fad_origin IN (
              'manager_nomination',
              'queued_nomination'
            )
            AND context.fad_allocation_id IS NULL
            AND allocation.id IS NULL
          )
          OR (
            auction.status = 'failed'
            AND allocation.status = 'correction_required'
            AND allocation.last_error_code =
              '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE}'
            AND (
              (
                context.source_kind = 'fad_restricted'
                AND context.fad_origin = 'candidate_tie_restricted'
                AND allocation.decision_code =
                  'exact_total_and_term_tie'
                AND allocation.restricted_auction_id = auction.id
                AND allocation.fallback_open_auction_id IS NULL
              )
              OR (
                context.source_kind = 'fad_open_rapid'
                AND context.fad_origin =
                  'restricted_no_improvement_fallback'
                AND allocation.decision_code =
                  'restricted_no_improvement_fallback'
                AND allocation.fallback_open_auction_id = auction.id
              )
            )
          )
        )
        AND (
          (
            auction.status = 'open'
            AND (
              job.id IS NULL
              OR (
                job.status = 'pending'
                AND job.attempt_count = 0
                AND (job.next_attempt_at_ms IS NULL OR job.next_attempt_at_ms <= @nowMs)
              )
            )
          )
          OR (
            auction.status = 'resolving'
            AND job.status IN ('leased', 'running')
            AND job.lease_expires_at_ms <= @nowMs
          )
          OR (
            auction.status = 'failed'
            AND (
              (
                context.source_kind = 'fad_open_rapid'
                AND context.fad_origin IN (
                  'manager_nomination',
                  'queued_nomination'
                )
                AND context.fad_allocation_id IS NULL
                AND allocation.id IS NULL
              )
              OR (
                allocation.status = 'correction_required'
                AND auction.updated_at_ms = allocation.updated_at_ms
              )
            )
            AND job.status = 'pending'
            AND job.attempt_count >= 1
            AND job.lease_owner IS NULL
            AND job.lease_token IS NULL
            AND job.lease_expires_at_ms IS NULL
            AND job.started_at_ms IS NULL
            AND job.completed_at_ms IS NULL
            AND job.result_json IS NULL
            AND job.last_error_code IS NULL
            AND job.next_attempt_at_ms <= @nowMs
            AND EXISTS (
              SELECT 1
              FROM free_agent_draft_recoveries AS recovery
              JOIN auction_events AS failure_event
                ON failure_event.league_id = recovery.league_id
               AND failure_event.season_id = recovery.season_id
               AND failure_event.auction_id = recovery.auction_id
               AND failure_event.event_type =
                 'fad_auction_resolution_failed'
              JOIN free_agent_draft_recovery_action_command_results
                AS receipt
                ON receipt.league_id = recovery.league_id
               AND receipt.season_id = recovery.season_id
               AND receipt.fad_id = recovery.fad_id
               AND receipt.recovery_id = recovery.id
               AND receipt.job_run_id = recovery.job_run_id
              JOIN idempotency_requests AS request
                ON request.league_id = receipt.league_id
               AND request.id = receipt.idempotency_request_id
              WHERE recovery.league_id = auction.league_id
                AND recovery.season_id = auction.season_id
                AND recovery.fad_id = context.fad_id
                AND recovery.player_id = auction.player_id
                AND recovery.allocation_id IS context.fad_allocation_id
                AND recovery.rollover_id = context.fad_rollover_id
                AND recovery.auction_id = auction.id
                AND recovery.job_run_id = job.id
                AND recovery.kind = 'auction_resolution'
                AND recovery.status = 'running'
                AND recovery.target_resolution_at_ms =
                  auction.resolves_at_ms
                AND recovery.last_error_code = CASE
                  WHEN context.fad_allocation_id IS NULL
                    THEN '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE}'
                  ELSE allocation.last_error_code
                END
                AND recovery.commissioner_reason IS NOT NULL
                AND recovery.created_by_operation_id = job.id
                AND recovery.created_at_ms <= auction.updated_at_ms
                AND recovery.updated_at_ms = receipt.accepted_at_ms
                AND recovery.version >= 2
                AND failure_event.occurred_at_ms =
                  auction.updated_at_ms
                AND json_extract(
                      failure_event.metadata_json,
                      '$.recoveryId'
                    ) = recovery.id
                AND json_extract(
                      failure_event.metadata_json,
                      '$.jobRunId'
                    ) = job.id
                AND json_extract(
                      failure_event.metadata_json,
                      '$.errorCode'
                    ) = recovery.last_error_code
                AND receipt.action = 'retry_auction_resolution'
                AND receipt.resource_kind = 'auction'
                AND receipt.resource_id = auction.id
                AND receipt.operation_id = job.id
                AND receipt.occurrence_key = job.occurrence_key
                AND receipt.commissioner_reason =
                  recovery.commissioner_reason
                AND receipt.accepted_status = 'pending'
                AND receipt.accepted_at_ms >=
                  failure_event.occurred_at_ms
                AND request.actor_user_id = receipt.actor_user_id
                AND request.operation =
                  'free_agent_draft.recovery.action'
                AND request.request_hash = receipt.request_sha256
                AND request.status = 'completed'
                AND request.result_type =
                  'free_agent_draft_recovery_action_command_result'
                AND request.result_id = receipt.id
                AND NOT EXISTS (
                  SELECT 1
                  FROM auction_events AS later_failure
                  WHERE later_failure.league_id =
                      failure_event.league_id
                    AND later_failure.season_id =
                      failure_event.season_id
                    AND later_failure.auction_id =
                      failure_event.auction_id
                    AND later_failure.event_type =
                      'fad_auction_resolution_failed'
                    AND json_extract(
                          later_failure.metadata_json,
                          '$.recoveryId'
                        ) = recovery.id
                    AND json_extract(
                          later_failure.metadata_json,
                          '$.jobRunId'
                        ) = job.id
                    AND later_failure.occurred_at_ms >
                      failure_event.occurred_at_ms
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM free_agent_draft_recovery_action_command_results
                    AS later_receipt
                  WHERE later_receipt.league_id = receipt.league_id
                    AND later_receipt.recovery_id = receipt.recovery_id
                    AND later_receipt.action =
                      'retry_auction_resolution'
                    AND (
                      later_receipt.accepted_at_ms >
                        receipt.accepted_at_ms
                      OR (
                        later_receipt.accepted_at_ms =
                          receipt.accepted_at_ms
                        AND later_receipt.id > receipt.id
                      )
                    )
                )
            )
          )
        )
      ORDER BY auction.resolves_at_ms, auction.league_id, auction.id
      LIMIT @limit
    `);

    sourceStatement = database.prepare(`
      SELECT
        auction.id AS auction_id,
        auction.league_id,
        auction.season_id,
        auction.player_id,
        auction.status AS auction_status,
        auction.opened_at_ms,
        auction.resolves_at_ms,
        auction.updated_at_ms AS auction_updated_at_ms,
        auction.version AS auction_version,
        context.fad_id,
        fad.version AS fad_version,
        context.fad_rollover_id AS rollover_id,
        context.fad_allocation_id AS allocation_id,
        context.source_kind,
        context.fad_origin,
        allocation.status AS allocation_status,
        allocation.updated_at_ms AS allocation_updated_at_ms,
        allocation.decision_code AS allocation_decision_code,
        allocation.winning_snapshot_entry_id,
        allocation.winning_team_id,
        allocation.contract_id AS allocation_contract_id,
        allocation.ownership_id AS allocation_ownership_id,
        allocation.restricted_auction_id,
        allocation.fallback_open_auction_id,
        allocation.restricted_minimum_total_cents,
        allocation.restricted_minimum_term_years,
        allocation.restricted_minimum_aav_cents,
        allocation.accounted_at_ms,
        allocation.last_error_code AS allocation_last_error_code,
        allocation.version AS allocation_version,
        rollover.status AS rollover_status,
        league.current_season_id,
        season.label AS season_label,
        season.nhl_season_key,
        season.status AS season_status,
        player.full_name AS player_full_name,
        player.status AS player_status,
        CASE WHEN EXISTS (
          SELECT 1
          FROM player_ownerships AS current_ownership
          WHERE current_ownership.league_id = auction.league_id
            AND current_ownership.player_id = auction.player_id
        ) THEN 1 ELSE 0 END AS player_owned,
        draw.id AS draw_id,
        draw.algorithm_version,
        draw.nonce_bytes,
        draw.commitment_hex,
        draw.revealed_at_ms,
        draw.version AS draw_version,
        job.id AS job_run_id,
        job.job_type,
        job.occurrence_key,
        job.scheduled_for_ms,
        job.status AS job_status,
        job.attempt_count AS job_attempt_count,
        job.lease_owner,
        job.lease_token,
        job.lease_expires_at_ms,
        job.started_at_ms,
        job.completed_at_ms,
        job.result_json,
        job.last_error_code AS job_last_error_code,
        job.next_attempt_at_ms,
        job.updated_at_ms AS job_updated_at_ms,
        job.version AS job_version
      FROM auctions AS auction
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = context.league_id
       AND fad.season_id = context.season_id
       AND fad.id = context.fad_id
      LEFT JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = context.league_id
       AND allocation.season_id = context.season_id
       AND allocation.fad_id = context.fad_id
       AND allocation.id = context.fad_allocation_id
       AND allocation.player_id = auction.player_id
      JOIN free_agent_draft_rollovers AS rollover
        ON rollover.league_id = context.league_id
       AND rollover.season_id = context.season_id
       AND rollover.fad_id = context.fad_id
       AND rollover.id = context.fad_rollover_id
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = context.league_id
       AND draw.season_id = context.season_id
       AND draw.fad_id = context.fad_id
       AND draw.allocation_id IS context.fad_allocation_id
       AND draw.auction_id = context.auction_id
      LEFT JOIN job_runs AS job
        ON job.league_id = auction.league_id
       AND job.season_id = auction.season_id
       AND job.job_type = '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE}'
       AND job.occurrence_key = @occurrenceKey
       AND job.scheduled_for_ms = auction.resolves_at_ms
      JOIN leagues AS league ON league.id = auction.league_id
      JOIN seasons AS season
        ON season.league_id = auction.league_id
       AND season.id = auction.season_id
      JOIN players AS player ON player.id = auction.player_id
      WHERE auction.league_id = @leagueId
        AND auction.season_id = @seasonId
        AND auction.id = @auctionId
      LIMIT 2
    `);

    bidsStatement = database.prepare(`
      SELECT
        bid.id AS bid_id,
        bid.league_id,
        bid.auction_id,
        bid.team_id,
        bid.submitted_by_user_id,
        bid.total_value_cents,
        bid.term_years,
        bid.lowest_offered_aav_cents,
        bid.lowest_offered_total_value_cents,
        bid.first_submitted_at_ms,
        bid.status AS bid_status,
        team.status AS team_status,
        submission.actor_user_id AS submission_actor_user_id,
        submission.event_type AS submission_event_type,
        submission.metadata_json AS submission_metadata_json,
        submission.occurred_at_ms AS submission_occurred_at_ms
      FROM auction_bids AS bid
      LEFT JOIN teams AS team
        ON team.league_id = bid.league_id
       AND team.id = bid.team_id
      LEFT JOIN auction_events AS submission
        ON submission.id = (
          SELECT event.id
          FROM auction_events AS event
          WHERE event.league_id = bid.league_id
            AND event.auction_id = bid.auction_id
            AND event.bid_id = bid.id
            AND event.event_type IN ('auction_started', 'bid_submitted')
          ORDER BY event.occurred_at_ms, event.id
          LIMIT 1
        )
      WHERE bid.league_id = @leagueId
        AND bid.auction_id = @auctionId
      ORDER BY bid.id
    `);

    participantsStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_auction_participants
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND auction_id = @auctionId
      ORDER BY team_id, id
    `);

    findResolutionStatement = database.prepare(`
      SELECT
        resolution.*,
        auction.status AS auction_status,
        auction.player_id,
        auction.version AS auction_version,
        context.fad_id,
        fad.version AS fad_version,
        context.fad_rollover_id AS rollover_id,
        context.fad_allocation_id AS allocation_id,
        context.source_kind,
        context.fad_origin,
        allocation.status AS current_allocation_status,
        allocation.decision_code AS current_allocation_decision_code,
        allocation.version AS current_allocation_version,
        allocation.fallback_open_auction_id,
        state_event.id AS resolution_state_event_id,
        state_event.allocation_version AS resolved_allocation_version,
        state_event.event_kind AS resolution_state_event_kind,
        state_event.decision_code AS resolved_allocation_decision_code,
        state_event.resulting_allocation_status AS resolved_allocation_status,
        state_event.contract_id AS state_contract_id,
        state_event.ownership_id AS state_ownership_id,
        state_event.auction_id AS state_auction_id,
        state_auction.version AS state_auction_version,
        state_auction.resolves_at_ms AS state_auction_resolves_at_ms,
        state_event.activity_id AS state_activity_id,
        draw.algorithm_version,
        draw.nonce_bytes,
        draw.commitment_hex,
        draw.ordered_tied_bid_ids_json,
        draw.ordered_tied_team_ids_json,
        draw.rejection_counter,
        draw.selected_index,
        draw.selected_bid_id,
        draw.selected_team_id,
        draw.selected_digest_hex,
        draw.revealed_at_ms,
        draw.version AS draw_version,
        bid.lowest_offered_aav_cents,
        bid.lowest_offered_total_value_cents,
        job.id AS job_run_id,
        job.status AS job_status,
        job.version AS job_version,
        job.completed_at_ms AS job_completed_at_ms,
        job.result_json AS job_result_json
      FROM auction_resolutions AS resolution
      JOIN auctions AS auction
        ON auction.league_id = resolution.league_id
       AND auction.season_id = resolution.season_id
       AND auction.id = resolution.auction_id
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = context.league_id
       AND fad.season_id = context.season_id
       AND fad.id = context.fad_id
      LEFT JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = context.league_id
       AND allocation.season_id = context.season_id
       AND allocation.fad_id = context.fad_id
       AND allocation.id = context.fad_allocation_id
      LEFT JOIN free_agent_draft_allocation_events AS state_event
        ON state_event.league_id = allocation.league_id
       AND state_event.season_id = allocation.season_id
       AND state_event.fad_id = allocation.fad_id
       AND state_event.allocation_id = allocation.id
       AND state_event.player_id = allocation.player_id
       AND state_event.occurred_at_ms = resolution.resolved_at_ms
       AND (
         (
           context.source_kind = 'fad_restricted'
           AND resolution.outcome_code = 'winner'
           AND state_event.event_kind = 'restricted_state_changed'
           AND state_event.decision_code = 'restricted_auction_result'
           AND state_event.resulting_allocation_status = 'restricted_resolved'
           AND state_event.auction_id = resolution.auction_id
           AND state_event.contract_id = resolution.contract_id
           AND state_event.ownership_id = resolution.ownership_id
         )
         OR (
           context.source_kind = 'fad_restricted'
           AND resolution.outcome_code = 'no_winner'
           AND state_event.event_kind = 'fallback_state_changed'
           AND state_event.decision_code =
             'restricted_no_improvement_fallback'
           AND state_event.resulting_allocation_status =
             'restricted_fallback_open'
           AND json_extract(
                 state_event.evidence_json,
                 '$.sourceAuctionId'
               ) = resolution.auction_id
         )
         OR (
           context.source_kind = 'fad_open_rapid'
           AND context.fad_origin =
             'restricted_no_improvement_fallback'
           AND state_event.event_kind = 'fallback_state_changed'
           AND state_event.decision_code = CASE
             WHEN resolution.outcome_code = 'winner'
               THEN 'fallback_open_result'
             ELSE 'fallback_open_no_winner'
           END
           AND state_event.resulting_allocation_status =
             'fallback_open_resolved'
           AND state_event.auction_id = resolution.auction_id
           AND state_event.contract_id IS resolution.contract_id
           AND state_event.ownership_id IS resolution.ownership_id
         )
       )
      LEFT JOIN auctions AS state_auction
        ON state_auction.league_id = state_event.league_id
       AND state_auction.season_id = state_event.season_id
       AND state_auction.id = state_event.auction_id
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = context.league_id
       AND draw.season_id = context.season_id
       AND draw.fad_id = context.fad_id
       AND draw.allocation_id IS context.fad_allocation_id
       AND draw.auction_id = context.auction_id
      JOIN job_runs AS job
        ON job.league_id = auction.league_id
       AND job.season_id = auction.season_id
       AND job.job_type = '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE}'
       AND job.occurrence_key = resolution.scheduled_occurrence_key
      LEFT JOIN auction_bids AS bid
        ON bid.league_id = resolution.league_id
       AND bid.auction_id = resolution.auction_id
       AND bid.id = resolution.winning_bid_id
      WHERE resolution.league_id = @leagueId
        AND (
          resolution.auction_id = @auctionId
          OR resolution.scheduled_occurrence_key = @occurrenceKey
        )
      ORDER BY resolution.id
      LIMIT 3
    `);

    resolutionEvidenceStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_allocation_events
      WHERE league_id = @leagueId
        AND allocation_id = @allocationId
        AND allocation_version = @allocationVersion
      ORDER BY
        CASE event_kind WHEN 'offer_considered' THEN 1 ELSE 2 END,
        rank_position,
        id
    `);
    terminalAuctionEventStatement = database.prepare(`
      SELECT *
      FROM auction_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @auctionId
        AND occurred_at_ms = @resolvedAtMs
        AND event_type = @eventType
      ORDER BY id
    `);
    resolutionActivityStatement = database.prepare(`
      SELECT *
      FROM league_activity
      WHERE league_id = @leagueId
        AND (
          (@activityId IS NOT NULL AND id = @activityId)
          OR (
            @activityId IS NULL
            AND related_type = 'auction_resolution'
            AND related_id = @resolutionId
          )
        )
      LIMIT 2
    `);
    resolutionOutboxStatement = database.prepare(`
      SELECT
        event.*,
        audience.id AS audience_id,
        audience.audience_kind,
        audience.team_id AS audience_team_id,
        audience.user_id AS audience_user_id
      FROM outbox_events AS event
      JOIN outbox_event_audiences AS audience
        ON audience.league_id = event.league_id
       AND audience.outbox_event_id = event.id
      WHERE event.league_id = @leagueId
        AND event.id = @outboxEventId
      ORDER BY audience.id
    `);
    resolutionNotificationStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE league_id = @leagueId
        AND event_type = @notificationType
        AND related_feature = 'auction'
        AND related_record_id = @notificationAuctionId
        AND created_at_ms = @resolvedAtMs
      ORDER BY
        json_extract(message_data_json, '$.teamId'),
        user_id,
        id
    `);
    resolutionRecipientStatement = database.prepare(`
      SELECT
        bid.id AS bid_id,
        bid.team_id,
        bid.status AS bid_status,
        assignment.user_id,
        participant.status AS participant_status
      FROM auction_bids AS bid
      JOIN teams AS team
        ON team.league_id = bid.league_id
       AND team.id = bid.team_id
       AND team.status = 'active'
      JOIN team_manager_assignments AS assignment
        ON assignment.league_id = bid.league_id
       AND assignment.team_id = bid.team_id
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.accepted_at_ms <= @resolvedAtMs
       AND assignment.ended_at_ms IS NULL
      JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
       AND membership.status = 'active'
       AND membership.joined_at_ms IS NOT NULL
       AND membership.joined_at_ms <= @resolvedAtMs
       AND membership.ended_at_ms IS NULL
      JOIN users AS user
        ON user.id = assignment.user_id
       AND user.status = 'active'
      LEFT JOIN free_agent_draft_auction_participants AS participant
        ON participant.league_id = bid.league_id
       AND participant.season_id = bid.season_id
       AND participant.fad_id = @fadId
       AND participant.allocation_id IS @allocationId
       AND participant.auction_id = bid.auction_id
       AND participant.team_id = bid.team_id
      WHERE bid.league_id = @leagueId
        AND bid.season_id = @seasonId
        AND bid.auction_id = @auctionId
      ORDER BY bid.team_id, assignment.user_id, bid.id
    `);
    commissionerRecipientStatement = database.prepare(`
      SELECT membership.user_id
      FROM leagues AS league
      JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = league.commissioner_membership_id
       AND membership.permission_category = 'commissioner'
       AND membership.status = 'active'
       AND membership.joined_at_ms IS NOT NULL
       AND membership.joined_at_ms <= @failedAtMs
       AND membership.ended_at_ms IS NULL
      JOIN users AS user
        ON user.id = membership.user_id
       AND user.status = 'active'
      WHERE league.id = @leagueId
      LIMIT 2
    `);
    notificationByDeduplicationStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE user_id = @userId
        AND event_type = @eventType
        AND deduplication_key = @deduplicationKey
      ORDER BY id
      LIMIT 2
    `);
    correctionNotificationEvidenceStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE league_id = @leagueId
        AND event_type = 'fad_correction_required'
        AND related_feature = 'free_agent_draft'
        AND related_record_id = @fadId
        AND json_extract(message_data_json, '$.recoveryId') = @recoveryId
        AND json_extract(message_data_json, '$.playerId') = @playerId
        AND json_extract(message_data_json, '$.auctionId') = @auctionId
        AND created_at_ms <= @failedAtMs
      ORDER BY created_at_ms, user_id, id
    `);
    notificationOutboxStatement = database.prepare(`
      SELECT
        event.*,
        audience.id AS audience_id,
        audience.audience_kind,
        audience.team_id AS audience_team_id,
        audience.user_id AS audience_user_id
      FROM outbox_events AS event
      JOIN outbox_event_audiences AS audience
        ON audience.league_id = event.league_id
       AND audience.outbox_event_id = event.id
      WHERE event.league_id = @leagueId
        AND event.event_type = 'notification.created'
        AND event.aggregate_type = 'notification'
        AND event.aggregate_id = @notificationId
      ORDER BY event.id, audience.id
    `);
    failurePublicationOutboxStatement = database.prepare(`
      SELECT
        event.*,
        audience.id AS audience_id,
        audience.audience_kind,
        audience.team_id AS audience_team_id,
        audience.user_id AS audience_user_id
      FROM outbox_events AS event
      JOIN outbox_event_audiences AS audience
        ON audience.league_id = event.league_id
       AND audience.outbox_event_id = event.id
      WHERE event.league_id = @leagueId
        AND event.event_type = @eventType
        AND event.aggregate_type = @aggregateType
        AND event.aggregate_id = @aggregateId
        AND event.created_at_ms = @failedAtMs
      ORDER BY event.id, audience.id
    `);
    failureReplayStatement = database.prepare(`
      SELECT
        recovery.*,
        fad.version AS fad_version,
        auction.status AS auction_status,
        auction.updated_at_ms AS auction_updated_at_ms,
        auction.version AS auction_version,
        context.source_kind,
        context.fad_origin,
        allocation.status AS allocation_status,
        allocation.decision_code AS allocation_decision_code,
        allocation.updated_at_ms AS allocation_updated_at_ms,
        allocation.version AS allocation_version,
        allocation.restricted_auction_id,
        allocation.fallback_open_auction_id,
        job.job_type,
        job.occurrence_key,
        job.scheduled_for_ms,
        job.status AS job_status,
        job.attempt_count AS job_attempt_count,
        job.lease_owner,
        job.lease_token,
        job.lease_expires_at_ms,
        job.started_at_ms,
        job.completed_at_ms,
        job.result_json,
        job.last_error_code AS job_last_error_code,
        job.next_attempt_at_ms,
        job.updated_at_ms AS job_updated_at_ms,
        job.version AS job_version,
        failure_event.id AS failure_event_id,
        failure_event.metadata_json AS failure_metadata_json,
        failure_event.occurred_at_ms AS failure_event_at_ms,
        draw.version AS draw_version,
        draw.revealed_at_ms
      FROM free_agent_draft_recoveries AS recovery
      JOIN free_agent_drafts AS fad
        ON fad.league_id = recovery.league_id
       AND fad.season_id = recovery.season_id
       AND fad.id = recovery.fad_id
      JOIN auctions AS auction
        ON auction.league_id = recovery.league_id
       AND auction.season_id = recovery.season_id
       AND auction.id = recovery.auction_id
       AND auction.player_id = recovery.player_id
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
       AND context.fad_id = recovery.fad_id
       AND context.fad_rollover_id = recovery.rollover_id
       AND context.fad_allocation_id IS recovery.allocation_id
      LEFT JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = recovery.league_id
       AND allocation.season_id = recovery.season_id
       AND allocation.fad_id = recovery.fad_id
       AND allocation.id = recovery.allocation_id
       AND allocation.player_id = recovery.player_id
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = recovery.league_id
       AND draw.season_id = recovery.season_id
       AND draw.fad_id = recovery.fad_id
       AND draw.allocation_id IS recovery.allocation_id
       AND draw.auction_id = recovery.auction_id
      JOIN job_runs AS job
        ON job.league_id = recovery.league_id
       AND job.season_id = recovery.season_id
       AND job.id = recovery.job_run_id
      JOIN auction_events AS failure_event
        ON failure_event.league_id = recovery.league_id
       AND failure_event.season_id = recovery.season_id
       AND failure_event.auction_id = recovery.auction_id
       AND failure_event.event_type =
         'fad_auction_resolution_failed'
      WHERE recovery.league_id = @leagueId
        AND recovery.season_id = @seasonId
        AND recovery.fad_id = @fadId
        AND recovery.player_id = @playerId
        AND recovery.allocation_id IS @allocationId
        AND recovery.rollover_id = @rolloverId
        AND recovery.auction_id = @auctionId
        AND recovery.job_run_id = @runId
        AND recovery.kind = 'auction_resolution'
        AND recovery.created_at_ms <= @failedAtMs
        AND failure_event.occurred_at_ms = @failedAtMs
        AND NOT EXISTS (
          SELECT 1
          FROM auction_events AS later_failure
          WHERE later_failure.league_id = failure_event.league_id
            AND later_failure.season_id = failure_event.season_id
            AND later_failure.auction_id = failure_event.auction_id
            AND later_failure.event_type =
              'fad_auction_resolution_failed'
            AND json_extract(
                  later_failure.metadata_json,
                  '$.recoveryId'
                ) = recovery.id
            AND json_extract(
                  later_failure.metadata_json,
                  '$.jobRunId'
                ) = recovery.job_run_id
            AND later_failure.occurred_at_ms >
              failure_event.occurred_at_ms
        )
      ORDER BY recovery.id
      LIMIT 3
    `);
    recoveryResumeStatement = database.prepare(`
      SELECT
        recovery.*,
        failure_event.id AS failure_event_id,
        failure_event.metadata_json AS failure_metadata_json,
        failure_event.occurred_at_ms AS failure_event_at_ms,
        receipt.id AS receipt_id,
        receipt.accepted_at_ms AS receipt_accepted_at_ms,
        receipt.commissioner_reason AS receipt_reason
      FROM free_agent_draft_recoveries AS recovery
      JOIN auction_events AS failure_event
        ON failure_event.league_id = recovery.league_id
       AND failure_event.season_id = recovery.season_id
       AND failure_event.auction_id = recovery.auction_id
       AND failure_event.event_type =
         'fad_auction_resolution_failed'
      JOIN free_agent_draft_recovery_action_command_results AS receipt
        ON receipt.league_id = recovery.league_id
       AND receipt.season_id = recovery.season_id
       AND receipt.fad_id = recovery.fad_id
       AND receipt.recovery_id = recovery.id
       AND receipt.job_run_id = recovery.job_run_id
      JOIN idempotency_requests AS request
        ON request.league_id = receipt.league_id
       AND request.id = receipt.idempotency_request_id
      WHERE recovery.league_id = @leagueId
        AND recovery.season_id = @seasonId
        AND recovery.fad_id = @fadId
        AND recovery.player_id = @playerId
        AND recovery.allocation_id IS @allocationId
        AND recovery.rollover_id = @rolloverId
        AND recovery.auction_id = @auctionId
        AND recovery.job_run_id = @runId
        AND recovery.kind = 'auction_resolution'
        AND recovery.status = 'running'
        AND recovery.target_resolution_at_ms = @resolvesAtMs
        AND recovery.last_error_code = @errorCode
        AND recovery.commissioner_reason IS NOT NULL
        AND recovery.created_by_operation_id = @runId
        AND recovery.resolved_at_ms IS NULL
        AND recovery.created_at_ms <= @failedAtMs
        AND recovery.updated_at_ms = receipt.accepted_at_ms
        AND recovery.version >= 2
        AND failure_event.actor_user_id IS NULL
        AND failure_event.bid_id IS NULL
        AND failure_event.team_id IS NULL
        AND failure_event.occurred_at_ms = @failedAtMs
        AND json_extract(
              failure_event.metadata_json,
              '$.recoveryId'
            ) = recovery.id
        AND json_extract(
              failure_event.metadata_json,
              '$.jobRunId'
            ) = @runId
        AND json_extract(
              failure_event.metadata_json,
              '$.errorCode'
            ) = @errorCode
        AND receipt.action = 'retry_auction_resolution'
        AND receipt.resource_kind = 'auction'
        AND receipt.resource_id = @auctionId
        AND receipt.operation_id = @runId
        AND receipt.occurrence_key = @occurrenceKey
        AND receipt.commissioner_reason = recovery.commissioner_reason
        AND receipt.accepted_status = 'pending'
        AND receipt.accepted_at_ms >= failure_event.occurred_at_ms
        AND request.actor_user_id = receipt.actor_user_id
        AND request.operation = 'free_agent_draft.recovery.action'
        AND request.request_hash = receipt.request_sha256
        AND request.status = 'completed'
        AND request.result_type =
          'free_agent_draft_recovery_action_command_result'
        AND request.result_id = receipt.id
        AND request.created_at_ms = receipt.accepted_at_ms
        AND request.completed_at_ms = receipt.accepted_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM auction_events AS later_failure
          WHERE later_failure.league_id = failure_event.league_id
            AND later_failure.season_id = failure_event.season_id
            AND later_failure.auction_id = failure_event.auction_id
            AND later_failure.event_type =
              'fad_auction_resolution_failed'
            AND json_extract(
                  later_failure.metadata_json,
                  '$.recoveryId'
                ) = recovery.id
            AND json_extract(
                  later_failure.metadata_json,
                  '$.jobRunId'
                ) = recovery.job_run_id
            AND later_failure.occurred_at_ms >
              failure_event.occurred_at_ms
        )
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_recovery_action_command_results
            AS later_receipt
          WHERE later_receipt.league_id = receipt.league_id
            AND later_receipt.recovery_id = receipt.recovery_id
            AND later_receipt.action = 'retry_auction_resolution'
            AND (
              later_receipt.accepted_at_ms > receipt.accepted_at_ms
              OR (
                later_receipt.accepted_at_ms = receipt.accepted_at_ms
                AND later_receipt.id > receipt.id
              )
            )
        )
      ORDER BY recovery.id
      LIMIT 3
    `);

    listSeasonsStatement = database.prepare(`
      SELECT id, league_id, label, nhl_season_key, status
      FROM seasons
      WHERE league_id = @leagueId
      ORDER BY nhl_season_key, id
    `);
    findPositionCorrectionStatement = database.prepare(`
      SELECT position_group
      FROM league_player_positions
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND ended_at_ms IS NULL
      LIMIT 2
    `);
    listSourcePositionsStatement = database.prepare(`
      SELECT DISTINCT normalized_position AS position_group
      FROM player_source_state
      WHERE player_id = @playerId
        AND ended_at_ms IS NULL
        AND active = 1
        AND normalized_position IN ('F', 'D')
      ORDER BY normalized_position
    `);
    listOccupiedSlotsStatement = database.prepare(`
      SELECT slot_number
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND team_id = @teamId
        AND ownership_kind = 'Rostered'
        AND roster_category = 'Active'
        AND position_group = @positionGroup
        AND slot_number IS NOT NULL
      ORDER BY slot_number
    `);
    listRosterRowsStatement = database.prepare(`
      SELECT
        ownership.league_id,
        ownership.season_id,
        ownership.team_id,
        ownership.player_id,
        ownership.roster_category,
        ownership.position_group,
        COALESCE(
          (
            SELECT correction.position_group
            FROM league_player_positions AS correction
            WHERE correction.league_id = ownership.league_id
              AND correction.player_id = ownership.player_id
              AND correction.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT CASE
              WHEN COUNT(DISTINCT source.normalized_position) = 1
              THEN MAX(source.normalized_position)
              ELSE NULL
            END
            FROM player_source_state AS source
            WHERE source.player_id = ownership.player_id
              AND source.ended_at_ms IS NULL
              AND source.active = 1
              AND source.normalized_position IN ('F', 'D')
          )
        ) AS effective_position
      FROM player_ownerships AS ownership
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
      ORDER BY ownership.player_id
    `);
    listBidHistoryStatement = database.prepare(`
      SELECT bid_id, team_id, event_type, metadata_json, occurred_at_ms
      FROM auction_events
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND bid_id IS NOT NULL
        AND event_type IN ('auction_started', 'bid_submitted', 'bid_edited')
      ORDER BY occurred_at_ms, id
    `);
    findHistoricalMembershipStatement = database.prepare(`
      SELECT id, permission_category
      FROM league_memberships
      WHERE league_id = @leagueId
        AND id = @actorMembershipId
        AND user_id = @actorUserId
        AND status IN ('active', 'ended', 'suspended')
        AND joined_at_ms IS NOT NULL
        AND joined_at_ms <= @occurredAtMs
        AND (ended_at_ms IS NULL OR ended_at_ms > @occurredAtMs)
      LIMIT 2
    `);
    findHistoricalManagerAssignmentStatement = database.prepare(`
      SELECT id
      FROM team_manager_assignments
      WHERE league_id = @leagueId
        AND team_id = @teamId
        AND user_id = @actorUserId
        AND membership_id = @actorMembershipId
        AND status IN ('accepted', 'ended')
        AND accepted_at_ms IS NOT NULL
        AND accepted_at_ms <= @occurredAtMs
        AND (ended_at_ms IS NULL OR ended_at_ms > @occurredAtMs)
      LIMIT 2
    `);
    offerEventsStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_allocation_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND allocation_version = @allocationVersion
        AND event_kind = 'offer_considered'
      ORDER BY snapshot_entry_id, id
    `);
    recoveryStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND player_id = @playerId
        AND allocation_id IS @allocationId
        AND rollover_id = @rolloverId
        AND auction_id = @auctionId
        AND job_run_id = @runId
        AND kind = 'auction_resolution'
        AND status = 'running'
      ORDER BY id
    `);
    targetRolloverStatement = database.prepare(`
      SELECT target.id, target.opens_at_ms, target.rolls_over_at_ms
      FROM free_agent_draft_rollovers AS target
      JOIN free_agent_draft_rollovers AS predecessor
        ON predecessor.league_id = target.league_id
       AND predecessor.season_id = target.season_id
       AND predecessor.fad_id = target.fad_id
       AND predecessor.id = target.predecessor_rollover_id
       AND predecessor.sequence = target.sequence - 1
       AND predecessor.rolls_over_at_ms = target.opens_at_ms
      WHERE target.league_id = @leagueId
        AND target.season_id = @seasonId
        AND target.fad_id = @fadId
        AND target.opens_at_ms >= @nowMs
        AND predecessor.opens_at_ms <= @nowMs
        AND @nowMs <= predecessor.rolls_over_at_ms
        AND target.rolls_over_at_ms = target.opens_at_ms + 86400000
        AND target.creation_cutoff_at_ms = target.rolls_over_at_ms - 3600000
        AND target.status IN ('scheduled', 'processing')
      ORDER BY target.opens_at_ms, target.id
    `);
    extensionPredecessorStatement = database.prepare(`
      SELECT rollover.id, rollover.rolls_over_at_ms
      FROM free_agent_draft_rollovers AS rollover
      WHERE rollover.league_id = @leagueId
        AND rollover.season_id = @seasonId
        AND rollover.fad_id = @fadId
        AND rollover.opens_at_ms <= @nowMs
        AND @nowMs <= rollover.rolls_over_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_draft_rollovers AS successor
          WHERE successor.league_id = rollover.league_id
            AND successor.season_id = rollover.season_id
            AND successor.fad_id = rollover.fad_id
            AND successor.predecessor_rollover_id = rollover.id
            AND successor.sequence = rollover.sequence + 1
        )
      ORDER BY
        CASE WHEN rollover.rolls_over_at_ms = @nowMs THEN 0 ELSE 1 END,
        rollover.sequence DESC,
        rollover.id
    `);
    fallbackRecipientCountStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT assignment.user_id, assignment.team_id
        FROM candidate_card_snapshots AS snapshot
        JOIN team_manager_assignments AS assignment
          ON assignment.league_id = snapshot.league_id
         AND assignment.team_id = snapshot.team_id
        JOIN league_memberships AS membership
          ON membership.league_id = assignment.league_id
         AND membership.id = assignment.membership_id
         AND membership.user_id = assignment.user_id
        JOIN users ON users.id = assignment.user_id
        WHERE snapshot.league_id = @leagueId
          AND snapshot.season_id = @seasonId
          AND snapshot.fad_id = @fadId
          AND assignment.status = 'accepted'
          AND assignment.accepted_at_ms IS NOT NULL
          AND assignment.accepted_at_ms <= @nowMs
          AND assignment.ended_at_ms IS NULL
          AND membership.status = 'active'
          AND membership.joined_at_ms IS NOT NULL
          AND membership.joined_at_ms <= @nowMs
          AND membership.ended_at_ms IS NULL
          AND users.status = 'active'
      )
    `);

    insertPendingJobStatement = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type, occurrence_key,
        scheduled_for_ms, status, attempt_count,
        lease_owner, lease_token, lease_expires_at_ms,
        started_at_ms, completed_at_ms, result_json,
        last_error_code, next_attempt_at_ms,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        @runId, @leagueId, @seasonId,
        '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE}',
        @occurrenceKey, @scheduledForMs, 'pending', 0,
        NULL, NULL, NULL,
        NULL, NULL, NULL,
        NULL, NULL,
        @nowMs, @nowMs, 1
      )
    `);

    claimJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'running',
          attempt_count = attempt_count + 1,
          lease_owner = @leaseOwner,
          lease_token = @leaseToken,
          lease_expires_at_ms = @leaseExpiresAtMs,
          started_at_ms = @nowMs,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms <= @nowMs
        AND version = @expectedJobVersion
        AND (
          (
            status = 'pending'
            AND attempt_count >= 0
            AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= @nowMs)
          )
          OR (
            status IN ('leased', 'running')
            AND lease_expires_at_ms <= @nowMs
          )
        )
    `);
    claimAuctionStatement = database.prepare(`
      UPDATE auctions
      SET status = 'resolving',
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @auctionId
        AND status = 'open'
        AND resolves_at_ms <= @nowMs
        AND version = @expectedAuctionVersion
    `);
    resumeFailedAuctionStatement = database.prepare(`
      UPDATE auctions
      SET status = 'resolving',
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @auctionId
        AND status = 'failed'
        AND resolves_at_ms <= @nowMs
        AND version = @expectedAuctionVersion
    `);
    resumeAllocationStatement = database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = CASE
            WHEN decision_code = 'exact_total_and_term_tie'
              AND restricted_auction_id = @auctionId
              AND fallback_open_auction_id IS NULL
              THEN 'restricted_active'
            WHEN decision_code =
                'restricted_no_improvement_fallback'
              AND fallback_open_auction_id = @auctionId
              THEN 'restricted_fallback_open'
            ELSE status
          END,
          last_error_code = NULL,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @allocationId
        AND player_id = @playerId
        AND status = 'correction_required'
        AND last_error_code = @errorCode
        AND version = @expectedAllocationVersion
        AND (
          (
            decision_code = 'exact_total_and_term_tie'
            AND restricted_auction_id = @auctionId
            AND fallback_open_auction_id IS NULL
          )
          OR (
            decision_code = 'restricted_no_improvement_fallback'
            AND fallback_open_auction_id = @auctionId
          )
        )
    `);
    updateBidStatusStatement = database.prepare(`
      UPDATE auction_bids
      SET status = @status,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @auctionId
        AND id = @bidId
        AND status = 'active'
    `);
    updateAllocationWinnerStatement = database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = @allocationTerminalStatus,
          decision_code = @allocationDecisionCode,
          winning_snapshot_entry_id = @winningSnapshotEntryId,
          winning_team_id = @winningTeamId,
          contract_id = @contractId,
          ownership_id = @ownershipId,
          accounted_at_ms = @resolvedAtMs,
          last_error_code = NULL,
          updated_at_ms = @resolvedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @allocationId
        AND player_id = @playerId
        AND status = @allocationSourceStatus
        AND version = @expectedAllocationVersion
        AND (
          (@sourceKind = 'fad_restricted'
            AND restricted_auction_id = @auctionId)
          OR (@sourceKind = 'fad_open_rapid'
            AND fallback_open_auction_id = @auctionId)
        )
    `);
    updateAllocationNoWinnerStatement = database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'fallback_open_resolved',
          decision_code = 'fallback_open_no_winner',
          winning_snapshot_entry_id = NULL,
          winning_team_id = NULL,
          contract_id = NULL,
          ownership_id = NULL,
          accounted_at_ms = @resolvedAtMs,
          last_error_code = NULL,
          updated_at_ms = @resolvedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @allocationId
        AND player_id = @playerId
        AND status = 'restricted_fallback_open'
        AND decision_code = 'restricted_no_improvement_fallback'
        AND fallback_open_auction_id = @auctionId
        AND version = @expectedAllocationVersion
    `);
    insertAllocationEventStatement = database.prepare(`
      INSERT INTO free_agent_draft_allocation_events (
        id, league_id, season_id, fad_id, allocation_id,
        allocation_version, player_id, event_kind,
        snapshot_entry_id, team_id, offer_valid, rank_position,
        offer_outcome_code, decision_code, resulting_allocation_status,
        contract_id, ownership_id, auction_id, activity_id,
        correction_id, actor_user_id, actor_membership_id,
        actor_authority, evidence_json, occurred_at_ms,
        created_at_ms, version
      ) VALUES (
        @eventId, @leagueId, @seasonId, @fadId, @allocationId,
        @allocationVersion, @playerId, @eventKind,
        @snapshotEntryId, @teamId, @offerValid, @rankPosition,
        @offerOutcomeCode, @decisionCode, @resultingAllocationStatus,
        @contractId, @ownershipId, @auctionId, @activityId,
        NULL, @actorUserId, @actorMembershipId,
        @actorAuthority, @evidenceJson, @resolvedAtMs,
        @resolvedAtMs, 1
      )
    `);
    revealDrawStatement = database.prepare(`
      UPDATE free_agent_draft_draws
      SET ordered_tied_bid_ids_json = @orderedBidIdsJson,
          ordered_tied_team_ids_json = @orderedTeamIdsJson,
          rejection_counter = @rejectionCounter,
          selected_index = @selectedIndex,
          selected_bid_id = @selectedBidId,
          selected_team_id = @selectedTeamId,
          selected_digest_hex = @selectedDigestHex,
          revealed_at_ms = @resolvedAtMs,
          updated_at_ms = @resolvedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id IS @allocationId
        AND auction_id = @auctionId
        AND id = @drawId
        AND revealed_at_ms IS NULL
        AND version = 1
    `);
    terminalizeAuctionStatement = database.prepare(`
      UPDATE auctions
      SET status = @auctionTerminalStatus,
          updated_at_ms = @resolvedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @auctionId
        AND status = 'resolving'
        AND version = @expectedAuctionVersion
    `);
    resolveRecoveryStatement = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = NULL,
          resolved_by_membership_id = NULL,
          resolved_authority = 'system',
          updated_at_ms = @resolvedAtMs,
          resolved_at_ms = @resolvedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @recoveryId
        AND player_id = @playerId
        AND allocation_id IS @allocationId
        AND rollover_id = @rolloverId
        AND auction_id = @auctionId
        AND job_run_id = @runId
        AND kind = 'auction_resolution'
        AND status = 'running'
        AND resolved_at_ms IS NULL
        AND updated_at_ms <= @resolvedAtMs
    `);
    succeedJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @resolvedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @resolvedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
        AND status = 'running'
        AND attempt_count >= 1
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms = @leaseExpiresAtMs
        AND lease_expires_at_ms > @resolvedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedJobVersion
    `);
    updateAllocationFailureStatement = database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'correction_required',
          last_error_code = @errorCode,
          updated_at_ms = @failedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @allocationId
        AND player_id = @playerId
        AND status = @allocationSourceStatus
        AND decision_code = @allocationDecisionCode
        AND version = @expectedAllocationVersion
        AND (
          (
            @sourceKind = 'fad_restricted'
            AND restricted_auction_id = @auctionId
            AND fallback_open_auction_id IS NULL
          )
          OR (
            @sourceKind = 'fad_open_rapid'
            AND fallback_open_auction_id = @auctionId
          )
        )
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
        @playerId, @allocationId, @rolloverId,
        @auctionId, @runId, 'auction_resolution',
        'correction_required', NULL,
        @resolvesAtMs, @errorCode, NULL,
        @runId, NULL, NULL, NULL,
        @failedAtMs, @failedAtMs, NULL, 1, NULL
      )
    `);
    failRecoveryStatement = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'correction_required',
          last_error_code = @errorCode,
          updated_at_ms = @failedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @recoveryId
        AND player_id = @playerId
        AND allocation_id IS @allocationId
        AND rollover_id = @rolloverId
        AND auction_id = @auctionId
        AND job_run_id = @runId
        AND kind = 'auction_resolution'
        AND status = 'running'
        AND created_by_operation_id = @runId
        AND target_resolution_at_ms = @resolvesAtMs
        AND last_error_code = @errorCode
        AND resolved_by_user_id IS NULL
        AND resolved_by_membership_id IS NULL
        AND resolved_authority IS NULL
        AND resolved_at_ms IS NULL
        AND created_at_ms < @failedAtMs
        AND updated_at_ms <= @failedAtMs
        AND version = @expectedRecoveryVersion
    `);
    failJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @failedAtMs,
          result_json = NULL,
          last_error_code = @errorCode,
          next_attempt_at_ms = NULL,
          updated_at_ms = @failedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type =
          '${FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @resolvesAtMs
        AND status = 'running'
        AND attempt_count >= 1
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms = @leaseExpiresAtMs
        AND lease_expires_at_ms > @failedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedJobVersion
    `);
    failAuctionStatement = database.prepare(`
      UPDATE auctions
      SET status = 'failed',
          updated_at_ms = @failedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @auctionId
        AND status = 'resolving'
        AND resolves_at_ms <= @failedAtMs
        AND version = @expectedAuctionVersion
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareFreeAgentDraftAuctionResolutionWriter",
      tableName: "auction_resolutions",
    });
  }

  function newIdentityFactory() {
    const issued = new Set();
    return (description) => {
      const id = createId(description);
      stableId(id, description);
      if (issued.has(id)) {
        invalid(
          "FAD auction-resolution identifier factories must return unique identifiers.",
          "IDENTIFIER_COLLISION"
        );
      }
      issued.add(id);
      return id;
    };
  }

  function historicalAuthority(row) {
    if (
      !row.submission_actor_user_id ||
      row.submission_actor_user_id !== row.submitted_by_user_id ||
      row.submission_occurred_at_ms !== row.first_submitted_at_ms ||
      typeof row.submission_metadata_json !== "string"
    ) {
      return false;
    }
    let metadata;
    try {
      metadata = JSON.parse(row.submission_metadata_json);
    } catch {
      return false;
    }
    if (
      !metadata ||
      !["manager", "commissioner"].includes(metadata.actorAuthority) ||
      !UUID_PATTERN.test(metadata.actorMembershipId || "")
    ) {
      return false;
    }
    const parameters = {
      leagueId: row.league_id,
      teamId: row.team_id,
      actorUserId: row.submission_actor_user_id,
      actorMembershipId: metadata.actorMembershipId,
      occurredAtMs: row.submission_occurred_at_ms,
    };
    const membership = uniqueRow(
      findHistoricalMembershipStatement,
      parameters,
      "The historical bid membership"
    );
    if (
      !membership ||
      membership.permission_category !== metadata.actorAuthority
    ) {
      return false;
    }
    if (metadata.actorAuthority === "commissioner") return true;
    return Boolean(
      uniqueRow(
        findHistoricalManagerAssignmentStatement,
        parameters,
        "The historical bid manager assignment"
      )
    );
  }

  function effectivePosition(row) {
    const parameters = {
      leagueId: row.league_id,
      playerId: row.player_id,
    };
    const correction = uniqueRow(
      findPositionCorrectionStatement,
      parameters,
      "The current league-player position"
    );
    const sourcePositions = listSourcePositionsStatement.all(parameters);
    const position = correction?.position_group ||
      (sourcePositions.length === 1
        ? sourcePositions[0].position_group
        : null);
    if (!["F", "D"].includes(position)) {
      incompatible(
        "The FAD auction player has no unambiguous roster position.",
        "PLAYER_POSITION_INVALID"
      );
    }
    return position;
  }

  function readSource(parameters) {
    return uniqueRow(
      sourceStatement,
      parameters,
      "The FAD auction-resolution source"
    );
  }

  function standaloneOpenBinding(row) {
    return Boolean(
      row &&
      row.source_kind === "fad_open_rapid" &&
      ["manager_nomination", "queued_nomination"].includes(
        row.fad_origin
      ) &&
      row.allocation_id === null
    );
  }

  function sourceAllocationVersion(row) {
    return standaloneOpenBinding(row) ? 0 : row.allocation_version;
  }

  function validateContext(
    row,
    {
      allowCorrectionRequired = false,
      requireJob = true,
    } = {}
  ) {
    if (!row) return null;
    const standaloneOpen = standaloneOpenBinding(row);
    const restrictedBinding =
      row.source_kind === "fad_restricted" &&
      row.fad_origin === "candidate_tie_restricted" &&
      row.allocation_decision_code === "exact_total_and_term_tie" &&
      row.restricted_auction_id === row.auction_id &&
      row.fallback_open_auction_id === null;
    const fallbackBinding =
      row.source_kind === "fad_open_rapid" &&
      row.fad_origin === "restricted_no_improvement_fallback" &&
      row.allocation_decision_code ===
        "restricted_no_improvement_fallback" &&
      row.fallback_open_auction_id === row.auction_id;
    const active =
      standaloneOpen ||
      (restrictedBinding &&
        row.allocation_status === "restricted_active") ||
      (fallbackBinding &&
        row.allocation_status === "restricted_fallback_open");
    const correctionRequired =
      allowCorrectionRequired &&
      (restrictedBinding || fallbackBinding) &&
      row.allocation_status === "correction_required" &&
      row.allocation_last_error_code ===
        FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE;
    const standaloneAllocationColumnsValid =
      !standaloneOpen ||
      (
        row.allocation_status === null &&
        row.allocation_decision_code === null &&
        row.winning_snapshot_entry_id === null &&
        row.winning_team_id === null &&
        row.allocation_contract_id === null &&
        row.allocation_ownership_id === null &&
        row.restricted_auction_id === null &&
        row.fallback_open_auction_id === null &&
        row.restricted_minimum_total_cents === null &&
        row.restricted_minimum_term_years === null &&
        row.restricted_minimum_aav_cents === null &&
        row.accounted_at_ms === null &&
        row.allocation_last_error_code === null &&
        row.allocation_version === null
      );
    const linkedAllocationColumnsValid =
      standaloneOpen ||
      (
        row.winning_snapshot_entry_id === null &&
        row.winning_team_id === null &&
        row.allocation_contract_id === null &&
        row.allocation_ownership_id === null &&
        row.accounted_at_ms === null &&
        (correctionRequired ||
          row.allocation_last_error_code === null) &&
        Number.isSafeInteger(row.restricted_minimum_total_cents) &&
        Number.isSafeInteger(row.restricted_minimum_term_years) &&
        row.restricted_minimum_aav_cents === roundedAav(
          row.restricted_minimum_total_cents,
          row.restricted_minimum_term_years
        )
      );
    if (
      (!active && !correctionRequired) ||
      !standaloneAllocationColumnsValid ||
      !linkedAllocationColumnsValid ||
      !Number.isSafeInteger(row.fad_version) ||
      row.fad_version < 1 ||
      (requireJob &&
        (row.job_type !== FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE ||
          row.occurrence_key !==
            occurrenceKey(row.auction_id, row.resolves_at_ms) ||
          row.scheduled_for_ms !== row.resolves_at_ms)) ||
      row.draw_version !== 1 ||
      row.revealed_at_ms !== null ||
      row.algorithm_version !== 1 ||
      !Buffer.isBuffer(row.nonce_bytes) ||
      row.nonce_bytes.byteLength !== 32 ||
      typeof row.commitment_hex !== "string" ||
      row.commitment_hex.length !== 64
    ) {
      incompatible(
        "The FAD auction-resolution source binding is malformed.",
        "RESOLUTION_SOURCE_INVALID"
      );
    }
    return row;
  }

  function loadDecisionCandidate(row, nowMs) {
    const bidRows = bidsStatement.all({
      leagueId: row.league_id,
      auctionId: row.auction_id,
    });
    const bids = bidRows.map((bid) =>
      Object.freeze({
        id: bid.bid_id,
        leagueId: bid.league_id,
        auctionId: bid.auction_id,
        teamId: bid.team_id,
        status: bid.bid_status,
        teamStatus: bid.team_status,
        totalValueCents: bid.total_value_cents,
        termYears: bid.term_years,
        lowestOfferedAavCents: bid.lowest_offered_aav_cents,
        lowestOfferedTotalValueCents:
          bid.lowest_offered_total_value_cents,
        firstSubmittedAtMs: bid.first_submitted_at_ms,
        isStartingBid:
          bid.submission_event_type === "auction_started",
        authorityValid: historicalAuthority(bid),
      })
    );
    const rawParticipants = row.source_kind === "fad_restricted"
      ? participantsStatement.all({
          leagueId: row.league_id,
          seasonId: row.season_id,
          fadId: row.fad_id,
          allocationId: row.allocation_id,
          auctionId: row.auction_id,
        })
      : [];
    const participants = rawParticipants.map((participant) =>
      Object.freeze({
        id: participant.id,
        leagueId: participant.league_id,
        allocationId: participant.allocation_id,
        auctionId: participant.auction_id,
        teamId: participant.team_id,
        status: participant.status,
        activeImprovementBidId:
          participant.active_improvement_bid_id,
        minimumTotalValueCents:
          participant.minimum_total_value_cents,
        minimumTermYears: participant.minimum_term_years,
        minimumAavCents: participant.minimum_aav_cents,
      })
    );
    return Object.freeze({
      rawBids: Object.freeze(bidRows),
      rawParticipants: Object.freeze(rawParticipants),
      bids: Object.freeze(bids),
      participants: Object.freeze(participants),
      decision: evaluateFreeAgentDraftAuctionResolution({
        context: {
          sourceKind: row.source_kind,
          origin: row.fad_origin,
          allocationId: row.allocation_id,
        },
        auction: {
          id: row.auction_id,
          leagueId: row.league_id,
          playerId: row.player_id,
          status: row.auction_status,
          resolvesAtMs: row.resolves_at_ms,
          playerOwned: row.player_owned === 1,
          nowMs,
        },
        bids,
        participants,
        floor: standaloneOpenBinding(row)
          ? null
          : {
              totalValueCents: row.restricted_minimum_total_cents,
              termYears: row.restricted_minimum_term_years,
              aavCents: row.restricted_minimum_aav_cents,
            },
        draw: {
          algorithmVersion: row.algorithm_version,
          commitmentHex: row.commitment_hex,
          nonceBytes: row.nonce_bytes,
        },
      }),
    });
  }

  function resolutionRows(parameters) {
    const rows = findResolutionStatement.all(parameters);
    if (rows.length > 1) {
      incompatible(
        "FAD auction-resolution replay identities conflict.",
        "RESOLUTION_REPLAY_AMBIGUOUS"
      );
    }
    return rows;
  }

  function projectResolution(row, replayed) {
    if (!row) return null;
    const standaloneOpen = standaloneOpenBinding(row);
    const expectedJobOutcome = row.outcome_code === "winner"
      ? "resolved"
      : "no_winner";
    const expectedResultJson = JSON.stringify({
      auctionId: row.auction_id,
      outcome: expectedJobOutcome,
    });
    if (
      row.job_status !== "succeeded" ||
      row.job_result_json !== expectedResultJson ||
      row.job_completed_at_ms !== row.resolved_at_ms ||
      row.draw_version !== 2 ||
      row.revealed_at_ms !== row.resolved_at_ms ||
      !["resolved", "no_winner"].includes(row.auction_status)
    ) {
      incompatible(
        "The persisted FAD auction resolution is not atomically terminal.",
        "RESOLUTION_REPLAY_INVALID"
      );
    }
    const evidenceRows = standaloneOpen
      ? []
      : resolutionEvidenceStatement.all({
          leagueId: row.league_id,
          allocationId: row.allocation_id,
          allocationVersion: row.resolved_allocation_version,
        });
    const state = evidenceRows.filter(
      (event) => event.event_kind !== "offer_considered"
    );
    if (
      standaloneOpen
        ? row.current_allocation_status !== null ||
          row.current_allocation_decision_code !== null ||
          row.current_allocation_version !== null ||
          row.resolution_state_event_id !== null ||
          row.resolved_allocation_version !== null ||
          row.state_activity_id !== null
        : state.length !== 1 ||
          state[0].id !== row.resolution_state_event_id ||
          state[0].activity_id !== row.state_activity_id ||
          state[0].occurred_at_ms !== row.resolved_at_ms
    ) {
      incompatible(
        "The persisted FAD resolution allocation evidence is incomplete.",
        "RESOLUTION_EVIDENCE_INVALID"
      );
    }
    const terminalEvents = terminalAuctionEventStatement.all({
      leagueId: row.league_id,
      seasonId: row.season_id,
      auctionId: row.auction_id,
      resolvedAtMs: row.resolved_at_ms,
      eventType: row.outcome_code === "winner"
        ? "auction_resolved"
        : "auction_no_winner",
    });
    let terminalMetadata = null;
    try {
      terminalMetadata = terminalEvents.length === 1
        ? JSON.parse(terminalEvents[0].metadata_json)
        : null;
    } catch {
      terminalMetadata = null;
    }
    if (
      terminalEvents.length !== 1 ||
      terminalEvents[0].bid_id !== row.winning_bid_id ||
      terminalEvents[0].team_id !== row.winning_team_id ||
      terminalMetadata?.resolutionId !== row.id
    ) {
      incompatible(
        "The persisted FAD resolution terminal auction event is not exact.",
        "RESOLUTION_TERMINAL_EVENT_INVALID"
      );
    }
    const activity = standaloneOpen || row.state_activity_id !== null
      ? uniqueRow(
          resolutionActivityStatement,
          {
            leagueId: row.league_id,
            activityId: row.state_activity_id,
            resolutionId: row.id,
          },
          "The FAD resolution activity"
        )
      : null;
    const activityId = activity?.id ?? null;
    const expectedActivityType = row.source_kind === "fad_restricted" &&
      row.outcome_code === "no_winner"
      ? "free_agent_draft_restricted_fallback_opened"
      : row.outcome_code === "winner"
        ? "free_agent_draft_player_awarded"
        : "free_agent_draft_auction_no_winner";
    if (
      (activityId !== null &&
        (!activity ||
          activity.event_type !== expectedActivityType ||
          activity.occurred_at_ms !== row.resolved_at_ms)) ||
      (activityId === null &&
        !(row.source_kind === "fad_restricted" &&
          row.outcome_code === "no_winner"))
    ) {
      incompatible(
        "The persisted FAD resolution activity is not exact.",
        "RESOLUTION_ACTIVITY_INVALID"
      );
    }
    let outcome = row.outcome_code;
    if (
      row.source_kind === "fad_restricted" &&
      row.outcome_code === "no_winner" &&
      row.resolved_allocation_status === "restricted_fallback_open"
    ) {
      outcome = "restricted_fallback";
    }
    const publishedAuctionId = outcome === "restricted_fallback"
      ? row.state_auction_id
      : row.auction_id;
    const restrictedFallback = outcome === "restricted_fallback";
    const delayedFallback = restrictedFallback && activityId === null;
    let stateEvidence = null;
    try {
      stateEvidence = JSON.parse(
        standaloneOpen
          ? activity.metadata_json
          : state[0].evidence_json
      );
    } catch {
      stateEvidence = null;
    }
    const outboxIds = isPlainObject(stateEvidence) &&
      Array.isArray(stateEvidence.outboxEventIds)
      ? stateEvidence.outboxEventIds
      : null;
    const notificationIds = isPlainObject(stateEvidence) &&
      Array.isArray(stateEvidence.notificationIds)
      ? stateEvidence.notificationIds
      : null;
    const expectedOutboxCount = restrictedFallback
      ? delayedFallback
        ? 1
        : 4 + (notificationIds?.length ?? 0)
      : 3 + (notificationIds?.length ?? 0);
    if (
      !outboxIds ||
      !notificationIds ||
      outboxIds.length !== expectedOutboxCount ||
      new Set(outboxIds).size !== outboxIds.length ||
      outboxIds.some((value) => !UUID_PATTERN.test(value)) ||
      new Set(notificationIds).size !== notificationIds.length ||
      notificationIds.some((value) => !UUID_PATTERN.test(value)) ||
      stateEvidence.activityId !== activityId ||
      (restrictedFallback &&
        (stateEvidence.schemaVersion !== 1 ||
          stateEvidence.sourceAuctionId !== row.auction_id ||
          stateEvidence.fallbackAuctionId !== publishedAuctionId ||
          !Number.isSafeInteger(row.state_auction_version) ||
          row.state_auction_version < 1 ||
          (delayedFallback && notificationIds.length !== 0))) ||
      (standaloneOpen &&
        (stateEvidence.schemaVersion !== 1 ||
          stateEvidence.fadId !== row.fad_id ||
          stateEvidence.allocationId !== null ||
          stateEvidence.auctionId !== row.auction_id ||
          stateEvidence.resolutionId !== row.id ||
          stateEvidence.playerId !== row.player_id))
    ) {
      incompatible(
        "The persisted FAD resolution state does not bind exact outboxes.",
        "RESOLUTION_OUTBOX_INVALID"
      );
    }
    const notificationRows = delayedFallback
      ? []
      : resolutionNotificationStatement.all({
          leagueId: row.league_id,
          notificationType: restrictedFallback
            ? "fad_restricted_fallback_opened"
            : "fad_rapid_auction_result",
          notificationAuctionId: publishedAuctionId,
          resolvedAtMs: row.resolved_at_ms,
        });
    const notificationEvidence = [];
    const expectedNotificationType = restrictedFallback
      ? "fad_restricted_fallback_opened"
      : "fad_rapid_auction_result";
    if (notificationRows.length !== notificationIds.length) {
      incompatible(
        "The persisted FAD auction notification set is not exact.",
        "RESOLUTION_NOTIFICATION_INVALID"
      );
    }
    for (let index = 0; index < notificationRows.length; index += 1) {
      const notification = notificationRows[index];
      let messageData = null;
      let contract = null;
      try {
        messageData = JSON.parse(notification.message_data_json);
        contract = createFreeAgentDraftNotificationContract({
          type: notification.event_type,
          recipientUserId: notification.user_id,
          messageData,
        });
      } catch {
        messageData = null;
        contract = null;
      }
      if (
        notification.id !== notificationIds[index] ||
        !contract ||
        notification.league_id !== row.league_id ||
        notification.event_type !== expectedNotificationType ||
        notification.related_feature !== "auction" ||
        notification.related_record_id !== publishedAuctionId ||
        notification.delivery_status !== "pending" ||
        notification.created_at_ms !== row.resolved_at_ms ||
        notification.read_at_ms !== null ||
        notification.delivered_at_ms !== null ||
        notification.version !== 1 ||
        notification.deduplication_key !==
          contract.deduplicationKey ||
        notification.message_data_json !==
          JSON.stringify(contract.messageData) ||
        messageData.leagueId !== row.league_id ||
        messageData.seasonId !== row.season_id ||
        messageData.fadId !== row.fad_id ||
        messageData.allocationId !== row.allocation_id ||
        messageData.auctionId !== publishedAuctionId ||
        messageData.playerId !== row.player_id ||
        (restrictedFallback &&
          messageData.resolvesAtMs !==
            row.state_auction_resolves_at_ms)
      ) {
        incompatible(
          "A persisted FAD auction notification is not exact.",
          "RESOLUTION_NOTIFICATION_INVALID"
        );
      }
      notificationEvidence.push(Object.freeze({
        notificationId: notification.id,
        teamId: messageData.teamId,
        userId: notification.user_id,
      }));
    }
    const expectedOutboxes = !restrictedFallback ? [
      {
        id: outboxIds[0],
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: row.fad_id,
        version: row.fad_version,
        reasonCode: "allocation_changed",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          allocationId: row.allocation_id,
          auctionId: row.auction_id,
        }),
        audienceKind: "league",
        audienceUserId: null,
      },
      {
        id: outboxIds[1],
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: publishedAuctionId,
        version: row.auction_version,
        reasonCode: "auction_changed",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          allocationId: row.allocation_id,
          auctionId: publishedAuctionId,
        }),
        audienceKind: "league",
        audienceUserId: null,
      },
      ...(activityId === null
        ? []
        : [{
            id: outboxIds[2],
            eventType: "activity.created",
            aggregateType: "league_activity",
            aggregateId: activityId,
            version: 1,
            reasonCode: "auction_changed",
            related: createEmptySocketRelated({
              fadId: row.fad_id,
              allocationId: row.allocation_id,
              auctionId: publishedAuctionId,
            }),
            audienceKind: "league",
            audienceUserId: null,
          }]),
      ...notificationEvidence.map((notification, index) => ({
        id: outboxIds[index + 3],
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: notification.notificationId,
        version: 1,
        reasonCode: "auction_changed",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          teamId: notification.teamId,
          allocationId: row.allocation_id,
          auctionId: publishedAuctionId,
        }),
        audienceKind: "user",
        audienceUserId: notification.userId,
      })),
    ] : delayedFallback ? [
      {
        id: outboxIds[0],
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: row.auction_id,
        version: row.auction_version,
        reasonCode: "auction_changed",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          allocationId: row.allocation_id,
          auctionId: row.auction_id,
        }),
        audienceKind: "league",
        audienceUserId: null,
      },
    ] : [
      {
        id: outboxIds[0],
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: row.fad_id,
        version: row.fad_version,
        reasonCode: "fallback_opened",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          allocationId: row.allocation_id,
          auctionId: publishedAuctionId,
        }),
        audienceKind: "league",
        audienceUserId: null,
      },
      {
        id: outboxIds[1],
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: publishedAuctionId,
        version: row.state_auction_version,
        reasonCode: "auction_changed",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          allocationId: row.allocation_id,
          auctionId: publishedAuctionId,
        }),
        audienceKind: "league",
        audienceUserId: null,
      },
      {
        id: outboxIds[2],
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: row.auction_id,
        version: row.auction_version,
        reasonCode: "auction_changed",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          allocationId: row.allocation_id,
          auctionId: row.auction_id,
        }),
        audienceKind: "league",
        audienceUserId: null,
      },
      {
        id: outboxIds[3],
        eventType: "activity.created",
        aggregateType: "league_activity",
        aggregateId: activityId,
        version: 1,
        reasonCode: "fallback_opened",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          allocationId: row.allocation_id,
          auctionId: publishedAuctionId,
        }),
        audienceKind: "league",
        audienceUserId: null,
      },
      ...notificationEvidence.map((notification, index) => ({
        id: outboxIds[index + 4],
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: notification.notificationId,
        version: 1,
        reasonCode: "fallback_opened",
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          teamId: notification.teamId,
          allocationId: row.allocation_id,
          auctionId: publishedAuctionId,
        }),
        audienceKind: "user",
        audienceUserId: notification.userId,
      })),
    ];
    if (
      expectedOutboxes.length !== expectedOutboxCount ||
      expectedOutboxes.some((expected) => {
        const rows = resolutionOutboxStatement.all({
          leagueId: row.league_id,
          outboxEventId: expected.id,
        });
        const item = rows[0];
        const expectedPayload = JSON.stringify(
          createSocketEventEnvelope({
            eventId: expected.id,
            type: expected.eventType,
            leagueId: row.league_id,
            resourceId: expected.aggregateId,
            version: expected.version,
            reasonCode: expected.reasonCode,
            occurredAt: row.resolved_at_ms,
            related: expected.related,
          })
        );
        return rows.length !== 1 || !item ||
          item.event_type !== expected.eventType ||
          item.aggregate_type !== expected.aggregateType ||
          item.aggregate_id !== expected.aggregateId ||
          item.payload_json !== expectedPayload ||
          item.created_at_ms !== row.resolved_at_ms ||
          item.audience_kind !== expected.audienceKind ||
          item.audience_team_id !== null ||
          item.audience_user_id !== expected.audienceUserId;
      })
    ) {
      incompatible(
        "The persisted FAD resolution outbox evidence is not exact.",
        "RESOLUTION_OUTBOX_INVALID"
      );
    }
    const orderedBidIds = JSON.parse(
      row.ordered_tied_bid_ids_json || "[]"
    );
    const orderedTeamIds = JSON.parse(
      row.ordered_tied_team_ids_json || "[]"
    );
    const drawReveal = deepFreeze({
      algorithmVersion: row.algorithm_version,
      nonceHex: Buffer.from(row.nonce_bytes).toString("hex"),
      selectionUsed: row.selected_bid_id !== null,
      orderedBidIds,
      orderedTeamIds,
      counter: row.rejection_counter,
      digestHex: row.selected_digest_hex,
      selectedIndex: row.selected_index,
      selectedBidId: row.selected_bid_id,
      selectedTeamId: row.selected_team_id,
    });
    const result = {
      completed: true,
      replayed,
      outcome,
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      allocationVersion: standaloneOpen
        ? 0
        : row.resolved_allocation_version,
      auctionId: row.auction_id,
      auctionVersion: row.auction_version,
      rolloverId: row.rollover_id,
      occurrenceKey: row.scheduled_occurrence_key,
      resolvedAtMs: row.resolved_at_ms,
      resolutionId: row.id,
      fallbackAuctionId:
        outcome === "restricted_fallback"
          ? row.state_auction_id
          : null,
      jobRunId: row.job_run_id,
      jobRunVersion: row.job_version,
      drawReveal,
      evidence: {
        clonedOfferEventIds: standaloneOpen
          ? []
          : evidenceRows
              .filter((event) => event.event_kind === "offer_considered")
              .map((event) => event.id),
        stateEventId: standaloneOpen ? null : state[0].id,
        activityId,
        notificationIds,
        outboxEventIds: outboxIds,
      },
    };
    if (row.outcome_code === "winner") {
      const winnerEvidence = terminalMetadata?.winner;
      const totalFirstEvidence =
        isPlainObject(winnerEvidence) &&
        Object.prototype.hasOwnProperty.call(
          winnerEvidence,
          "highestCompetingTotalValueCents"
        );
      if (
        totalFirstEvidence &&
        (
          winnerEvidence.bidId !== row.winning_bid_id ||
          winnerEvidence.teamId !== row.winning_team_id ||
          winnerEvidence.submittedTotalValueCents !==
            row.highest_bid_cents ||
          winnerEvidence.submittedTermYears !==
            row.winning_term_years ||
          winnerEvidence.lowestOfferedAavCents !==
            row.lowest_offered_aav_cents ||
          winnerEvidence.lowestOfferedTotalValueCents !==
            row.lowest_offered_total_value_cents ||
          (winnerEvidence.highestCompetingTotalValueCents ?? 0) !==
            row.second_price_input_cents ||
          winnerEvidence.persistedSecondPriceInputCents !==
            row.second_price_input_cents ||
          winnerEvidence.finalTotalValueCents !==
            row.final_contract_value_cents ||
          winnerEvidence.finalAavCents !== row.final_aav_cents
        )
      ) {
        incompatible(
          "The persisted total-first FAD auction winner evidence is not exact.",
          "RESOLUTION_WINNER_EVIDENCE_INVALID"
        );
      }
      result.winner = totalFirstEvidence
        ? {
            ...winnerEvidence,
            contractId: row.contract_id,
            ownershipId: row.ownership_id,
          }
        : {
            bidId: row.winning_bid_id,
            teamId: row.winning_team_id,
            submittedTotalValueCents: row.highest_bid_cents,
            submittedTermYears: row.winning_term_years,
            lowestOfferedAavCents:
              row.lowest_offered_aav_cents,
            highestCompetingAavCents:
              row.second_price_input_cents === 0
                ? null
                : row.second_price_input_cents,
            persistedSecondPriceInputCents:
              row.second_price_input_cents,
            finalTotalValueCents:
              row.final_contract_value_cents,
            finalAavCents: row.final_aav_cents,
            contractId: row.contract_id,
            ownershipId: row.ownership_id,
          };
    }
    Object.defineProperty(result, "committedRoster", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: row.outcome_code === "winner"
        ? deepFreeze({
            leagueId: row.league_id,
            seasonId: row.season_id,
            teamId: row.winning_team_id,
            ownershipWitnesses: [
              {
                ownershipId: row.ownership_id,
                ownershipVersion: 1,
                state: "present",
              },
            ],
          })
        : null,
    });
    return deepFreeze(result);
  }

  function readProjectedResolution(parameters, replayed) {
    const rows = resolutionRows(parameters);
    if (!rows[0]) return null;
    if (
      rows[0].auction_id !== parameters.auctionId ||
      rows[0].scheduled_occurrence_key !== parameters.occurrenceKey
    ) {
      conflict(
        "The FAD auction-resolution replay identity conflicts.",
        "RESOLUTION_REPLAY_CONFLICT"
      );
    }
    return projectResolution(rows[0], replayed);
  }

  function validateFailurePublicationEvidence(row, command) {
    const notifications = correctionNotificationEvidenceStatement.all({
      ...command,
      recoveryId: row.id,
    });
    if (
      notifications.length < 1 ||
      new Set(notifications.map((item) => item.user_id)).size !==
        notifications.length
    ) {
      incompatible(
        "The FAD correction-required notification set is not exact.",
        "FAILURE_NOTIFICATION_INVALID"
      );
    }
    const related = createEmptySocketRelated({
      fadId: command.fadId,
      allocationId: command.allocationId,
      auctionId: command.auctionId,
      recoveryId: row.id,
    });
    const notificationIds = [];
    const notificationOutboxIds = [];
    for (const notification of notifications) {
      let messageData = null;
      let contract = null;
      try {
        messageData = JSON.parse(notification.message_data_json);
        contract = createFreeAgentDraftNotificationContract({
          type: notification.event_type,
          recipientUserId: notification.user_id,
          messageData,
        });
      } catch {
        messageData = null;
        contract = null;
      }
      if (
        !contract ||
        notification.created_at_ms > command.failedAtMs ||
        messageData.leagueId !== command.leagueId ||
        messageData.seasonId !== command.seasonId ||
        messageData.fadId !== command.fadId ||
        messageData.allocationId !== command.allocationId ||
        messageData.auctionId !== command.auctionId ||
        messageData.recoveryId !== row.id ||
        messageData.playerId !== command.playerId ||
        messageData.errorCode !== command.errorCode
      ) {
        incompatible(
          "The FAD correction-required notification causality is invalid.",
          "FAILURE_NOTIFICATION_INVALID"
        );
      }
      validateCorrectionNotification(notification, contract, command);
      const notificationOutboxes = notificationOutboxStatement.all({
        leagueId: command.leagueId,
        notificationId: notification.id,
      });
      const publication = notificationOutboxes[0];
      const expectedPayload = publication
        ? JSON.stringify(createSocketEventEnvelope({
            eventId: publication.id,
            type: "notification.created",
            leagueId: command.leagueId,
            resourceId: notification.id,
            version: 1,
            reasonCode: "auction_changed",
            occurredAt: notification.created_at_ms,
            related,
          }))
        : null;
      if (
        notificationOutboxes.length !== 1 ||
        !publication ||
        publication.payload_json !== expectedPayload ||
        publication.created_at_ms !== notification.created_at_ms ||
        publication.audience_kind !== "user" ||
        publication.audience_team_id !== null ||
        publication.audience_user_id !== notification.user_id
      ) {
        incompatible(
          "The FAD correction-required notification publication is not exact.",
          "FAILURE_PUBLICATION_INVALID"
        );
      }
      notificationIds.push(notification.id);
      notificationOutboxIds.push(publication.id);
    }

    const baseExpectations = [
      {
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: command.fadId,
        version: row.fad_version,
        reasonCode: "allocation_changed",
      },
      {
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: command.auctionId,
        version: row.auction_version,
        reasonCode: "auction_changed",
      },
    ];
    const baseOutboxIds = [];
    for (const expected of baseExpectations) {
      const rows = failurePublicationOutboxStatement.all({
        leagueId: command.leagueId,
        eventType: expected.eventType,
        aggregateType: expected.aggregateType,
        aggregateId: expected.aggregateId,
        failedAtMs: command.failedAtMs,
      });
      const publication = rows[0];
      const expectedPayload = publication
        ? JSON.stringify(createSocketEventEnvelope({
            eventId: publication.id,
            type: expected.eventType,
            leagueId: command.leagueId,
            resourceId: expected.aggregateId,
            version: expected.version,
            reasonCode: expected.reasonCode,
            occurredAt: command.failedAtMs,
            related,
          }))
        : null;
      if (
        rows.length !== 1 ||
        !publication ||
        publication.payload_json !== expectedPayload ||
        publication.audience_kind !== "league" ||
        publication.audience_team_id !== null ||
        publication.audience_user_id !== null
      ) {
        incompatible(
          "The FAD failure publication evidence is not exact.",
          "FAILURE_PUBLICATION_INVALID"
        );
      }
      baseOutboxIds.push(publication.id);
    }
    return Object.freeze({
      notificationIds: Object.freeze(notificationIds),
      outboxEventIds: Object.freeze([
        ...baseOutboxIds,
        ...notificationOutboxIds,
      ]),
    });
  }

  function readFailureProjection(command, replayed) {
    const rows = failureReplayStatement.all(command);
    if (rows.length > 1) {
      incompatible(
        "FAD auction-resolution failure evidence is ambiguous.",
        "FAILURE_REPLAY_AMBIGUOUS"
      );
    }
    const row = rows[0];
    if (!row) return null;
    let metadata = null;
    try {
      metadata = JSON.parse(row.failure_metadata_json);
    } catch {
      metadata = null;
    }
    const metadataKeys = isPlainObject(metadata)
      ? Object.keys(metadata).sort()
      : [];
    const standaloneOpen = standaloneOpenBinding(row);
    const expectedAllocationVersion = standaloneOpen
      ? 0
      : command.expectedAllocationVersion + 1;
    const expectedAuctionVersion = command.expectedAuctionVersion + 1;
    const expectedJobVersion = command.expectedJobVersion + 1;
    if (
      row.created_at_ms > command.failedAtMs ||
      row.updated_at_ms !== command.failedAtMs ||
      row.target_resolution_at_ms !== row.scheduled_for_ms ||
      row.status !== "correction_required" ||
      row.last_error_code !== command.errorCode ||
      row.created_by_operation_id !== command.runId ||
      row.resolved_at_ms !== null ||
      row.version < 1 ||
      row.auction_status !== "failed" ||
      row.auction_updated_at_ms !== command.failedAtMs ||
      row.auction_version !== expectedAuctionVersion ||
      (standaloneOpen
        ? row.allocation_status !== null ||
          row.allocation_updated_at_ms !== null ||
          row.allocation_version !== null
        : row.allocation_status !== "correction_required" ||
          row.allocation_updated_at_ms !== command.failedAtMs ||
          row.allocation_version !== expectedAllocationVersion) ||
      row.job_type !== FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE ||
      row.occurrence_key !== command.occurrenceKey ||
      row.job_status !== "failed" ||
      row.job_attempt_count < 1 ||
      row.lease_owner !== null ||
      row.lease_token !== null ||
      row.lease_expires_at_ms !== null ||
      row.completed_at_ms !== command.failedAtMs ||
      row.result_json !== null ||
      row.job_last_error_code !== command.errorCode ||
      row.next_attempt_at_ms !== null ||
      row.job_updated_at_ms !== command.failedAtMs ||
      row.job_version !== expectedJobVersion ||
      row.failure_event_at_ms !== command.failedAtMs ||
      row.draw_version !== 1 ||
      row.revealed_at_ms !== null ||
      metadataKeys.length !== 3 ||
      metadataKeys[0] !== "errorCode" ||
      metadataKeys[1] !== "jobRunId" ||
      metadataKeys[2] !== "recoveryId" ||
      metadata.errorCode !== command.errorCode ||
      metadata.jobRunId !== command.runId ||
      metadata.recoveryId !== row.id
    ) {
      conflict(
        "The stored FAD auction-resolution failure no longer matches its exact command.",
        "FAILURE_REPLAY_CONFLICT"
      );
    }
    const restricted = row.source_kind === "fad_restricted";
    if (
      (standaloneOpen &&
        (row.source_kind !== "fad_open_rapid" ||
          !["manager_nomination", "queued_nomination"].includes(
            row.fad_origin
          ) ||
          row.allocation_id !== null)) ||
      (!standaloneOpen && restricted &&
        (row.fad_origin !== "candidate_tie_restricted" ||
          row.allocation_decision_code !==
            "exact_total_and_term_tie" ||
          row.restricted_auction_id !== command.auctionId ||
          row.fallback_open_auction_id !== null)) ||
      (!standaloneOpen && !restricted &&
        (row.source_kind !== "fad_open_rapid" ||
          row.fad_origin !==
            "restricted_no_improvement_fallback" ||
          row.allocation_decision_code !==
            "restricted_no_improvement_fallback" ||
          row.fallback_open_auction_id !== command.auctionId))
    ) {
      conflict(
        "The stored FAD auction-resolution failure source changed.",
        "FAILURE_REPLAY_CONFLICT"
      );
    }
    const publicationEvidence =
      validateFailurePublicationEvidence(row, command);
    if (standaloneOpen) {
      return deepFreeze({
        recorded: true,
        replayed,
        errorCode: command.errorCode,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId: null,
        allocationVersion: 0,
        playerId: command.playerId,
        rolloverId: command.rolloverId,
        auctionId: command.auctionId,
        auctionVersion: expectedAuctionVersion,
        occurrenceKey: command.occurrenceKey,
        failedAtMs: command.failedAtMs,
        jobRunId: command.runId,
        jobRunVersion: expectedJobVersion,
        recoveryId: row.id,
        recoveryVersion: row.version,
        failureEventId: row.failure_event_id,
        evidence: {
          clonedOfferEventIds: [],
          stateEventId: null,
          ...publicationEvidence,
        },
      });
    }
    const sourceOffers = offerEventsStatement.all({
      ...command,
      allocationVersion: command.expectedAllocationVersion,
    });
    const failureOffers = offerEventsStatement.all({
      ...command,
      allocationVersion: expectedAllocationVersion,
    });
    const evidenceRows = resolutionEvidenceStatement.all({
      leagueId: command.leagueId,
      allocationId: command.allocationId,
      allocationVersion: expectedAllocationVersion,
    });
    const states = evidenceRows.filter(
      (event) => event.event_kind !== "offer_considered"
    );
    let stateEvidence = null;
    try {
      stateEvidence = states.length === 1
        ? JSON.parse(states[0].evidence_json)
        : null;
    } catch {
      stateEvidence = null;
    }
    const comparableOffer = (event) => ({
      activityId: event.activity_id,
      actorAuthority: event.actor_authority,
      actorMembershipId: event.actor_membership_id,
      actorUserId: event.actor_user_id,
      evidenceJson: event.evidence_json,
      offerOutcomeCode: event.offer_outcome_code,
      offerValid: event.offer_valid,
      rankPosition: event.rank_position,
      snapshotEntryId: event.snapshot_entry_id,
      teamId: event.team_id,
    });
    if (
      sourceOffers.length === 0 ||
      failureOffers.length !== sourceOffers.length ||
      JSON.stringify(failureOffers.map(comparableOffer)) !==
        JSON.stringify(sourceOffers.map(comparableOffer)) ||
      states.length !== 1 ||
      states[0].event_kind !== (restricted
        ? "restricted_state_changed"
        : "fallback_state_changed") ||
      states[0].decision_code !== row.allocation_decision_code ||
      states[0].resulting_allocation_status !==
        "correction_required" ||
      states[0].auction_id !== command.auctionId ||
      states[0].activity_id !== null ||
      states[0].occurred_at_ms !== command.failedAtMs ||
      stateEvidence?.recoveryId !== row.id ||
      stateEvidence?.failureAtMs !== command.failedAtMs
    ) {
      incompatible(
        "The FAD auction-resolution failure allocation evidence is incomplete.",
        "FAILURE_EVIDENCE_INVALID"
      );
    }
    return deepFreeze({
      recorded: true,
      replayed,
      errorCode: command.errorCode,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      allocationId: command.allocationId,
      allocationVersion: expectedAllocationVersion,
      playerId: command.playerId,
      rolloverId: command.rolloverId,
      auctionId: command.auctionId,
      auctionVersion: expectedAuctionVersion,
      occurrenceKey: command.occurrenceKey,
      failedAtMs: command.failedAtMs,
      jobRunId: command.runId,
      jobRunVersion: expectedJobVersion,
      recoveryId: row.id,
      recoveryVersion: row.version,
      failureEventId: row.failure_event_id,
      evidence: {
        clonedOfferEventIds: failureOffers.map((event) => event.id),
        stateEventId: states[0].id,
        ...publicationEvidence,
      },
    });
  }

  function validateLiveFence(row, command) {
    if (
      row.league_id !== command.leagueId ||
      row.season_id !== command.seasonId ||
      row.fad_id !== command.fadId ||
      row.allocation_id !== command.allocationId ||
      row.player_id !== command.playerId ||
      row.rollover_id !== command.rolloverId ||
      row.auction_id !== command.auctionId ||
      row.occurrence_key !== command.occurrenceKey ||
      row.auction_status !== "resolving" ||
      row.auction_version !== command.expectedAuctionVersion ||
      sourceAllocationVersion(row) !==
        command.expectedAllocationVersion ||
      row.job_run_id !== command.runId ||
      row.job_status !== "running" ||
      row.job_version !== command.expectedJobVersion ||
      row.lease_owner !== command.leaseOwner ||
      row.lease_token !== command.leaseToken ||
      row.lease_expires_at_ms !== command.leaseExpiresAtMs ||
      row.lease_expires_at_ms <= command.resolvedAtMs ||
      row.job_attempt_count < 1 ||
      row.started_at_ms > command.resolvedAtMs ||
      row.job_updated_at_ms > command.resolvedAtMs ||
      row.completed_at_ms !== null ||
      row.result_json !== null ||
      row.job_last_error_code !== null ||
      row.next_attempt_at_ms !== null ||
      command.resolvedAtMs < row.resolves_at_ms
    ) {
      conflict(
        "The FAD auction, allocation, or active job lease changed.",
        "RESOLUTION_FENCE_CHANGED"
      );
    }
  }

  function sourceRecovery(row, command) {
    const recoveries = recoveryStatement.all(command);
    if (recoveries.length > 1) {
      incompatible(
        "The FAD auction-resolution recovery is not unique.",
        "RECOVERY_AMBIGUOUS"
      );
    }
    const recovery = recoveries[0] || null;
    const required = row.rollover_status === "recovery_required";
    if (required && !recovery) {
      conflict(
        "The FAD auction-resolution recovery binding changed.",
        "RECOVERY_FENCE_CHANGED"
      );
    }
    if (
      recovery &&
      (recovery.created_by_operation_id !== command.runId ||
        recovery.target_resolution_at_ms !== row.resolves_at_ms ||
        recovery.last_error_code === null ||
        recovery.resolved_by_user_id !== null ||
        recovery.resolved_by_membership_id !== null ||
        recovery.resolved_authority !== null ||
        recovery.resolved_at_ms !== null)
    ) {
      conflict(
        "The FAD auction-resolution recovery evidence changed.",
        "RECOVERY_FENCE_CHANGED"
      );
    }
    return recovery;
  }

  function recoveryResumeEvidence(row, command) {
    const standaloneOpen = standaloneOpenBinding(row);
    if (
      row.auction_status !== "failed" ||
      (!standaloneOpen &&
        (row.allocation_status !== "correction_required" ||
          row.auction_updated_at_ms !==
            row.allocation_updated_at_ms)) ||
      row.job_status !== "pending" ||
      row.job_attempt_count < 1 ||
      row.lease_owner !== null ||
      row.lease_token !== null ||
      row.lease_expires_at_ms !== null ||
      row.started_at_ms !== null ||
      row.completed_at_ms !== null ||
      row.result_json !== null ||
      row.job_last_error_code !== null ||
      row.next_attempt_at_ms === null ||
      row.next_attempt_at_ms > command.nowMs ||
      command.nowMs <= row.auction_updated_at_ms
    ) {
      conflict(
        "The failed FAD auction is not backed by a retryable recovery.",
        "RECOVERY_RESUME_FENCE_CHANGED"
      );
    }
    const rows = recoveryResumeStatement.all({
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      playerId: row.player_id,
      rolloverId: row.rollover_id,
      auctionId: row.auction_id,
      runId: row.job_run_id,
      occurrenceKey: row.occurrence_key,
      resolvesAtMs: row.resolves_at_ms,
      failedAtMs: row.auction_updated_at_ms,
      errorCode: standaloneOpen
        ? FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE
        : row.allocation_last_error_code,
    });
    if (rows.length !== 1) {
      conflict(
        "The failed FAD auction recovery retry evidence is not exact.",
        "RECOVERY_RESUME_EVIDENCE_CHANGED"
      );
    }
    return rows[0];
  }

  claimTransaction = database.transaction((command) => {
    const existing = readProjectedResolution(command, true);
    if (existing) {
      return deepFreeze({
        acquired: false,
        reason: "succeeded",
        resolution: existing,
      });
    }
    let row = validateContext(
      readSource(command),
      {
        allowCorrectionRequired: true,
        requireJob: false,
      }
    );
    if (!row) {
      notFound(
        "The due FAD auction-resolution source was not found.",
        "RESOLUTION_SOURCE_NOT_FOUND"
      );
    }
    if (
      command.occurrenceKey !==
        occurrenceKey(row.auction_id, row.resolves_at_ms) ||
      row.auction_version !== command.expectedAuctionVersion ||
      row.resolves_at_ms > command.nowMs ||
      !["open", "resolving", "failed"].includes(row.auction_status)
    ) {
      conflict(
        "The due FAD auction-resolution source changed before claim.",
        "CLAIM_FENCE_CHANGED"
      );
    }
    const recoveryResume = row.auction_status === "failed"
      ? recoveryResumeEvidence(row, command)
      : null;
    if (
      !recoveryResume &&
      row.auction_status === "open" &&
      row.job_run_id !== null &&
      row.job_attempt_count !== 0
    ) {
      conflict(
        "A first FAD auction-resolution claim cannot reuse prior attempts.",
        "JOB_CLAIM_FENCE_CHANGED"
      );
    }
    let jobVersion = command.expectedJobVersion;
    if (row.job_run_id === null) {
      if (
        command.expectedJobVersion !== 0 ||
        row.auction_status !== "open"
      ) {
        conflict(
          "The missing due resolution job does not match a first canonical claim.",
          "JOB_ENSURE_FENCE_CHANGED"
        );
      }
      insertPendingJobStatement.run({
        ...command,
        scheduledForMs: row.resolves_at_ms,
      });
      jobVersion = 1;
      row = validateContext(readSource(command));
    } else if (
      row.job_run_id !== command.runId ||
      row.job_version !== command.expectedJobVersion ||
      command.expectedJobVersion < 1
    ) {
      conflict(
        "The due FAD auction-resolution job identity changed before claim.",
        "JOB_CLAIM_FENCE_CHANGED"
      );
    }
    assertChanged(
      claimJobStatement.run({
        ...command,
        expectedJobVersion: jobVersion,
      }),
      "The FAD auction-resolution job claim",
      "JOB_CLAIM_CAS_FAILED"
    );
    let auctionVersion = row.auction_version;
    let allocationVersion = sourceAllocationVersion(row);
    let resumeEvidence = null;
    if (row.auction_status === "open") {
      assertChanged(
        claimAuctionStatement.run(command),
        "The FAD auction claim",
        "AUCTION_CLAIM_CAS_FAILED"
      );
      auctionVersion += 1;
    } else if (recoveryResume) {
      assertChanged(
        resumeFailedAuctionStatement.run(command),
        "The failed FAD auction recovery claim",
        "AUCTION_RECOVERY_CLAIM_CAS_FAILED"
      );
      auctionVersion += 1;
      if (standaloneOpenBinding(row)) {
        resumeEvidence = deepFreeze({
          clonedOfferEventIds: [],
          stateEventId: null,
        });
      } else {
        assertChanged(
          resumeAllocationStatement.run({
            ...command,
            fadId: row.fad_id,
            allocationId: row.allocation_id,
            playerId: row.player_id,
            expectedAllocationVersion: row.allocation_version,
            errorCode: row.allocation_last_error_code,
          }),
          "The FAD allocation recovery resume",
          "ALLOCATION_RECOVERY_CLAIM_CAS_FAILED"
        );
        const resumeId = newIdentityFactory();
        resumeEvidence = cloneRecoveryResumeEvidence(
          command,
          row,
          recoveryResume,
          resumeId
        );
        allocationVersion += 1;
      }
    }
    const claimed = validateContext(readSource(command));
    if (
      !claimed ||
      claimed.auction_status !== "resolving" ||
      claimed.auction_version !== auctionVersion ||
      sourceAllocationVersion(claimed) !== allocationVersion ||
      claimed.job_status !== "running" ||
      claimed.job_version !== jobVersion + 1 ||
      claimed.lease_owner !== command.leaseOwner ||
      claimed.lease_token !== command.leaseToken ||
      claimed.lease_expires_at_ms !== command.leaseExpiresAtMs
    ) {
      incompatible(
        "The claimed FAD auction-resolution fence was not preserved.",
        "CLAIM_POSTCONDITION_INVALID"
      );
    }
    return deepFreeze({
      acquired: true,
      leagueId: claimed.league_id,
      seasonId: claimed.season_id,
      fadId: claimed.fad_id,
      allocationId: claimed.allocation_id,
      allocationVersion: sourceAllocationVersion(claimed),
      playerId: claimed.player_id,
      rolloverId: claimed.rollover_id,
      auctionId: claimed.auction_id,
      auctionVersion: claimed.auction_version,
      resolvesAtMs: claimed.resolves_at_ms,
      occurrenceKey: claimed.occurrence_key,
      jobRunId: claimed.job_run_id,
      jobRunVersion: claimed.job_version,
      attemptCount: claimed.job_attempt_count,
      leaseOwner: claimed.lease_owner,
      leaseToken: claimed.lease_token,
      leaseExpiresAtMs: claimed.lease_expires_at_ms,
      recoveryResumed: recoveryResume !== null,
      recoveryId: recoveryResume?.id ?? null,
      recoveryVersion: recoveryResume?.version ?? null,
      recoveryResumeEvidence: resumeEvidence,
    });
  });

  function nextAvailableSlot(command, row, teamId, positionGroup) {
    const maximum = positionGroup === "F" ? 12 : 6;
    const occupied = new Set(
      listOccupiedSlotsStatement
        .all({
          ...command,
          seasonId: row.season_id,
          teamId,
          positionGroup,
        })
        .map(({ slot_number: value }) => value)
    );
    for (let slot = 1; slot <= maximum; slot += 1) {
      if (!occupied.has(slot)) return slot;
    }
    return null;
  }

  function winnerLegality(command, row, teamId) {
    const rows = listRosterRowsStatement.all({
      ...command,
      seasonId: row.season_id,
      teamId,
    });
    const structural = evaluateStructuralRosterLegality({
      leagueId: command.leagueId,
      seasonId: row.season_id,
      teamId,
      assignments: rows.map((item) => ({
        leagueId: item.league_id,
        seasonId: item.season_id,
        teamId: item.team_id,
        playerId: item.player_id,
        rosterCategory: item.roster_category,
        assignedPositionGroup: item.position_group,
      })),
      effectivePositions: rows.map((item) => ({
        playerId: item.player_id,
        positionGroup: item.effective_position,
      })),
    });
    const cap = capRepository.calculate({
      leagueId: command.leagueId,
      seasonId: row.season_id,
      teamId,
    });
    const warnings = [
      ...structural.reasons.map((reason) => ({ ...reason, teamId })),
      ...cap.issues.map((issue) => ({ ...issue, teamId })),
      ...(cap.overCap ? [{ code: "TEAM_OVER_CAP", teamId }] : []),
    ];
    return deepFreeze({
      generalIllegal: warnings.length > 0,
      warnings,
    });
  }

  function persistWinnerResources(command, row, decision, id) {
    if (
      row.current_season_id !== row.season_id ||
      row.season_status !== "active" ||
      row.player_status !== "active"
    ) {
      conflict(
        "The FAD winner can no longer bind to the current active season/player.",
        "WINNER_RESOURCE_UNAVAILABLE"
      );
    }
    const futureSeasonIds = [id("future season"), id("future season")];
    const seasonPlan = planContractSeasons({
      leagueId: command.leagueId,
      targetSeason: {
        id: row.season_id,
        leagueId: row.league_id,
        label: row.season_label,
        nhlSeasonKey: row.nhl_season_key,
        status: row.season_status,
      },
      existingSeasons: listSeasonsStatement.all(command).map((season) => ({
        id: season.id,
        leagueId: season.league_id,
        label: season.label,
        nhlSeasonKey: season.nhl_season_key,
        status: season.status,
      })),
      futureSeasonIds,
      termYears: decision.winner.submittedTermYears,
      nowMs: command.resolvedAtMs,
    });
    for (const season of seasonPlan.seasonsToCreate) {
      seasonsRepository.insert({
        id: season.id,
        league_id: season.leagueId,
        label: season.label,
        nhl_season_key: season.nhlSeasonKey,
        status: season.status,
        regular_season_starts_at_ms: season.regularSeasonStartsAtMs,
        regular_season_ends_at_ms: season.regularSeasonEndsAtMs,
        fantasy_playoffs_start_at_ms: season.fantasyPlayoffsStartAtMs,
        fantasy_playoffs_end_at_ms: season.fantasyPlayoffsEndAtMs,
        free_agent_draft_completed_at_ms:
          season.freeAgentDraftCompletedAtMs,
        created_at_ms: season.createdAtMs,
        updated_at_ms: season.updatedAtMs,
        version: season.version,
      });
    }
    const resolutionId = id("FAD auction resolution");
    const contractId = id("FAD auction contract");
    const contractYearIds = [
      id("FAD auction contract year"),
      id("FAD auction contract year"),
      id("FAD auction contract year"),
    ];
    const contractEventId = id("FAD auction contract event");
    const ownershipId = id("FAD auction ownership");
    const ownershipEventId = id("FAD auction ownership event");
    const contract = createNormalContractAggregate({
      contractId,
      contractYearIds: contractYearIds.slice(
        0,
        decision.winner.submittedTermYears
      ),
      contractEventId,
      leagueId: command.leagueId,
      playerId: row.player_id,
      teamId: decision.winner.teamId,
      originalTotalValueCents: decision.winner.finalTotalValueCents,
      termYears: decision.winner.submittedTermYears,
      startSeasonId: row.season_id,
      seasonIds: seasonPlan.seasonIds,
      acquisitionSourceType: "auction_resolution",
      acquisitionSourceId: resolutionId,
      auctionBuyoutLockExpiresAtMs:
        command.resolvedAtMs + AUCTION_BUYOUT_LOCK_MS,
      actorUserId: null,
      occurredAtMs: command.resolvedAtMs,
    });
    contractsRepository.insert(contract.contract);
    for (const year of contract.years) {
      contractYearsRepository.insert(year);
    }
    contractEventsRepository.insert(contract.event);

    const positionGroup = effectivePosition(row);
    const slotNumber = nextAvailableSlot(
      command,
      row,
      decision.winner.teamId,
      positionGroup
    );
    ownershipsRepository.insert(
      createRosterAssignmentRecord({
        id: ownershipId,
        leagueId: command.leagueId,
        seasonId: row.season_id,
        playerId: row.player_id,
        teamId: decision.winner.teamId,
        ownershipKind: "Rostered",
        rosterCategory: "Active",
        positionGroup,
        slotNumber,
        acquiredTransactionType: "auction_resolution",
        acquiredTransactionId: resolutionId,
        createdAtMs: command.resolvedAtMs,
        updatedAtMs: command.resolvedAtMs,
      })
    );
    ownershipEventsRepository.insert({
      id: ownershipEventId,
      league_id: command.leagueId,
      season_id: row.season_id,
      player_id: row.player_id,
      team_id: decision.winner.teamId,
      ownership_id: ownershipId,
      event_type: "auction_player_acquired",
      actor_user_id: null,
      source_type: "auction_resolution",
      source_id: resolutionId,
      before_metadata_json: null,
      after_metadata_json: JSON.stringify({
        ownershipKind: "Rostered",
        rosterCategory: "Active",
        positionGroup,
        slotNumber,
      }),
      reason: null,
      occurred_at_ms: command.resolvedAtMs,
    });
    return Object.freeze({
      resolutionId,
      contractId,
      ownershipId,
      positionGroup,
      slotNumber,
    });
  }

  function updateBids(command, candidate, decision) {
    const eligible = new Set(
      (decision.rankedBids || []).map((bid) => bid.bidId)
    );
    for (const bid of candidate.bids) {
      if (bid.status !== "active") continue;
      let status = "invalid";
      if (decision.outcome === "winner") {
        status = bid.id === decision.winner.bidId
          ? "won"
          : eligible.has(bid.id)
            ? "lost"
            : "invalid";
      }
      assertChanged(
        updateBidStatusStatement.run({
          ...command,
          bidId: bid.id,
          status,
        }),
        "A FAD auction bid",
        "BID_CAS_FAILED"
      );
    }
  }

  function cloneAllocationEvidence(
    command,
    row,
    {
      activityId,
      allocationDecisionCode,
      allocationStatus,
      contractId,
      eventKind,
      id,
      notificationIds,
      outboxEventIds,
      ownershipId,
    }
  ) {
    const sourceOffers = offerEventsStatement.all({
      ...command,
      allocationVersion: command.expectedAllocationVersion,
    });
    if (sourceOffers.length === 0) {
      incompatible(
        "The current FAD allocation has no offer evidence to clone.",
        "ALLOCATION_OFFER_EVIDENCE_MISSING"
      );
    }
    const allocationVersion = command.expectedAllocationVersion + 1;
    const clonedOfferEventIds = [];
    for (const source of sourceOffers) {
      const eventId = id("FAD resolution cloned offer event");
      clonedOfferEventIds.push(eventId);
      insertAllocationEventStatement.run({
        ...command,
        eventId,
        allocationVersion,
        eventKind: "offer_considered",
        snapshotEntryId: source.snapshot_entry_id,
        teamId: source.team_id,
        offerValid: source.offer_valid,
        rankPosition: source.rank_position,
        offerOutcomeCode: source.offer_outcome_code,
        decisionCode: null,
        resultingAllocationStatus: allocationStatus,
        contractId: null,
        ownershipId: null,
        auctionId: null,
        activityId: source.activity_id,
        actorUserId: source.actor_user_id,
        actorMembershipId: source.actor_membership_id,
        actorAuthority: source.actor_authority,
        evidenceJson: source.evidence_json,
      });
    }
    const stateEventId = id("FAD resolution allocation state event");
    insertAllocationEventStatement.run({
      ...command,
      eventId: stateEventId,
      allocationVersion,
      eventKind,
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode: allocationDecisionCode,
      resultingAllocationStatus: allocationStatus,
      contractId,
      ownershipId,
      auctionId: command.auctionId,
      activityId,
      actorUserId: null,
      actorMembershipId: null,
      actorAuthority: "system",
      evidenceJson: serializeCanonicalJsonV1({
        schemaVersion: 1,
        operation: "free_agent_draft_auction_resolution",
        occurrenceKey: command.occurrenceKey,
        notificationIds,
        outboxEventIds,
        activityId,
        auctionId: command.auctionId,
        allocationId: command.allocationId,
        fromAllocationVersion: command.expectedAllocationVersion,
        toAllocationVersion: allocationVersion,
        decisionCode: allocationDecisionCode,
        resolvedAtMs: command.resolvedAtMs,
      }),
    });
    return Object.freeze({
      clonedOfferEventIds: Object.freeze(clonedOfferEventIds),
      stateEventId,
    });
  }

  function cloneRecoveryResumeEvidence(
    command,
    row,
    recovery,
    id
  ) {
    const eventCommand = {
      ...command,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      playerId: row.player_id,
      resolvedAtMs: command.nowMs,
    };
    const sourceOffers = offerEventsStatement.all({
      ...eventCommand,
      allocationVersion: row.allocation_version,
    });
    if (sourceOffers.length === 0) {
      incompatible(
        "The failed FAD allocation has no offer evidence to resume.",
        "ALLOCATION_OFFER_EVIDENCE_MISSING"
      );
    }
    const allocationVersion = row.allocation_version + 1;
    const allocationStatus = row.source_kind === "fad_restricted"
      ? "restricted_active"
      : "restricted_fallback_open";
    const eventKind = row.source_kind === "fad_restricted"
      ? "restricted_state_changed"
      : "fallback_state_changed";
    const clonedOfferEventIds = [];
    for (const source of sourceOffers) {
      const eventId = id("FAD recovery-resume cloned offer event");
      clonedOfferEventIds.push(eventId);
      insertAllocationEventStatement.run({
        ...eventCommand,
        eventId,
        allocationVersion,
        eventKind: "offer_considered",
        snapshotEntryId: source.snapshot_entry_id,
        teamId: source.team_id,
        offerValid: source.offer_valid,
        rankPosition: source.rank_position,
        offerOutcomeCode: source.offer_outcome_code,
        decisionCode: null,
        resultingAllocationStatus: allocationStatus,
        contractId: null,
        ownershipId: null,
        auctionId: null,
        activityId: source.activity_id,
        actorUserId: source.actor_user_id,
        actorMembershipId: source.actor_membership_id,
        actorAuthority: source.actor_authority,
        evidenceJson: source.evidence_json,
      });
    }
    const stateEventId = id("FAD recovery-resume state event");
    insertAllocationEventStatement.run({
      ...eventCommand,
      eventId: stateEventId,
      allocationVersion,
      eventKind,
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode: row.allocation_decision_code,
      resultingAllocationStatus: allocationStatus,
      contractId: null,
      ownershipId: null,
      auctionId: row.auction_id,
      activityId: null,
      actorUserId: null,
      actorMembershipId: null,
      actorAuthority: "system",
      evidenceJson: serializeCanonicalJsonV1({
        allocationId: row.allocation_id,
        auctionId: row.auction_id,
        failureEventId: recovery.failure_event_id,
        fromAllocationVersion: row.allocation_version,
        operation:
          "free_agent_draft_auction_resolution_recovery_resume",
        receiptId: recovery.receipt_id,
        recoveryId: recovery.id,
        resumedAtMs: command.nowMs,
        schemaVersion: 1,
        toAllocationVersion: allocationVersion,
      }),
    });
    return deepFreeze({
      clonedOfferEventIds,
      stateEventId,
    });
  }

  function cloneFailureEvidence(
    command,
    row,
    { failureEventId, recoveryId },
    id
  ) {
    const sourceOffers = offerEventsStatement.all({
      ...command,
      allocationVersion: command.expectedAllocationVersion,
    });
    if (sourceOffers.length === 0) {
      incompatible(
        "The current FAD allocation has no offer evidence to quarantine.",
        "ALLOCATION_OFFER_EVIDENCE_MISSING"
      );
    }
    const allocationVersion = command.expectedAllocationVersion + 1;
    const clonedOfferEventIds = [];
    for (const source of sourceOffers) {
      const eventId = id("FAD failure cloned offer event");
      clonedOfferEventIds.push(eventId);
      insertAllocationEventStatement.run({
        ...command,
        eventId,
        allocationVersion,
        eventKind: "offer_considered",
        snapshotEntryId: source.snapshot_entry_id,
        teamId: source.team_id,
        offerValid: source.offer_valid,
        rankPosition: source.rank_position,
        offerOutcomeCode: source.offer_outcome_code,
        decisionCode: null,
        resultingAllocationStatus: "correction_required",
        contractId: null,
        ownershipId: null,
        auctionId: null,
        activityId: source.activity_id,
        actorUserId: source.actor_user_id,
        actorMembershipId: source.actor_membership_id,
        actorAuthority: source.actor_authority,
        evidenceJson: source.evidence_json,
      });
    }
    const stateEventId = id("FAD failure allocation state event");
    insertAllocationEventStatement.run({
      ...command,
      eventId: stateEventId,
      allocationVersion,
      eventKind: row.source_kind === "fad_restricted"
        ? "restricted_state_changed"
        : "fallback_state_changed",
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode: row.allocation_decision_code,
      resultingAllocationStatus: "correction_required",
      contractId: null,
      ownershipId: null,
      auctionId: command.auctionId,
      activityId: null,
      actorUserId: null,
      actorMembershipId: null,
      actorAuthority: "system",
      evidenceJson: serializeCanonicalJsonV1({
        allocationId: command.allocationId,
        auctionId: command.auctionId,
        errorCode: command.errorCode,
        failureAtMs: command.failedAtMs,
        failureEventId,
        fromAllocationVersion: command.expectedAllocationVersion,
        operation: "free_agent_draft_auction_resolution_failure",
        recoveryId,
        schemaVersion: 1,
        toAllocationVersion: allocationVersion,
      }),
    });
    return deepFreeze({
      clonedOfferEventIds,
      stateEventId,
    });
  }

  function eligibleBidHistory(command, decision) {
    const eligible = new Set(
      decision.rankedBids.map((bid) => bid.bidId)
    );
    return listBidHistoryStatement
      .all(command)
      .filter((row) => eligible.has(row.bid_id))
      .map((row) => {
        let metadata = null;
        try {
          metadata = JSON.parse(row.metadata_json);
        } catch {
          metadata = null;
        }
        const values = row.event_type === "auction_started"
          ? metadata
          : metadata?.after;
        return {
          bidId: row.bid_id,
          teamId: row.team_id,
          eventType: row.event_type,
          totalValueCents: values?.totalValueCents ?? null,
          termYears: values?.termYears ?? null,
          aavCents: values?.aavCents ?? null,
          editCount: values?.editCount ?? 0,
          occurredAtMs: row.occurred_at_ms,
        };
      });
  }

  function resolutionNotificationRecipients(command, row) {
    const rows = resolutionRecipientStatement.all({
      ...command,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
    });
    const byTeam = new Map();
    for (const recipient of rows) {
      const outcomeCode = recipient.participant_status === "removed"
        ? "removed"
        : recipient.bid_status === "won"
          ? "won"
          : recipient.bid_status === "lost"
            ? "lost"
            : recipient.bid_status === "cancelled"
              ? "cancelled"
              : "invalid";
      const existing = byTeam.get(recipient.team_id);
      if (
        existing &&
        (existing.userId !== recipient.user_id ||
          existing.outcomeCode !== outcomeCode)
      ) {
        incompatible(
          "A terminal FAD auction team has ambiguous current-manager notification evidence.",
          "NOTIFICATION_RECIPIENT_AMBIGUOUS"
        );
      }
      byTeam.set(recipient.team_id, Object.freeze({
        teamId: recipient.team_id,
        userId: recipient.user_id,
        outcomeCode,
      }));
    }
    return Object.freeze(
      [...byTeam.values()].sort(
        (left, right) =>
          left.teamId.localeCompare(right.teamId) ||
          left.userId.localeCompare(right.userId)
      )
    );
  }

  function createResolutionNotificationPublications(
    command,
    row,
    id
  ) {
    return Object.freeze(
      resolutionNotificationRecipients(command, row).map(
        (recipient) => {
          const contract =
            createFreeAgentDraftNotificationContract({
              type: "fad_rapid_auction_result",
              recipientUserId: recipient.userId,
              messageData: {
                leagueId: command.leagueId,
                seasonId: command.seasonId,
                fadId: row.fad_id,
                teamId: recipient.teamId,
                allocationId: row.allocation_id,
                auctionId: row.auction_id,
                playerId: row.player_id,
                outcomeCode: recipient.outcomeCode,
                destination: {
                  kind: "auction",
                  leagueId: command.leagueId,
                  auctionId: row.auction_id,
                },
              },
            });
          return Object.freeze({
            notificationId: id(
              "FAD rapid-auction result notification"
            ),
            teamId: recipient.teamId,
            userId: recipient.userId,
            contract,
          });
        }
      )
    );
  }

  function persistResolutionNotifications(command, row, publications) {
    for (const publication of publications) {
      const written = notificationsWriter.insert({
        id: publication.notificationId,
        userId: publication.userId,
        leagueId: command.leagueId,
        eventType: publication.contract.type,
        messageDataJson: JSON.stringify(
          publication.contract.messageData
        ),
        relatedFeature: "auction",
        relatedRecordId: row.auction_id,
        deliveryStatus: "pending",
        createdAtMs: command.resolvedAtMs,
        deliveredAtMs: null,
        deduplicationKey:
          publication.contract.deduplicationKey,
      });
      if (
        !written ||
        typeof written.then === "function" ||
        written.replayed !== false ||
        written.notification?.id !== publication.notificationId
      ) {
        conflict(
          "The FAD rapid-auction result notification write was not exact.",
          "NOTIFICATION_WRITE_INVALID"
        );
      }
    }
  }

  function writeOutboxes(
    command,
    row,
    { activityId, outboxEventIds, notificationPublications }
  ) {
    const related = createEmptySocketRelated({
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      auctionId: row.auction_id,
    });
    const events = [
      {
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: row.fad_id,
        version: row.fad_version,
        reasonCode: "allocation_changed",
        audiences: [{ kind: "league" }],
        related,
      },
      {
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: row.auction_id,
        version: command.expectedAuctionVersion + 1,
        reasonCode: "auction_changed",
        audiences: [{ kind: "league" }],
        related,
      },
      {
        eventType: "activity.created",
        aggregateType: "league_activity",
        aggregateId: activityId,
        version: 1,
        reasonCode: "auction_changed",
        audiences: [{ kind: "league" }],
        related,
      },
      ...notificationPublications.map((publication) => ({
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: publication.notificationId,
        version: 1,
        reasonCode: "auction_changed",
        audiences: [{
          kind: "user",
          userId: publication.userId,
        }],
        related: createEmptySocketRelated({
          fadId: row.fad_id,
          teamId: publication.teamId,
          allocationId: row.allocation_id,
          auctionId: row.auction_id,
        }),
      })),
    ];
    if (events.length !== outboxEventIds.length) {
      incompatible(
        "The FAD auction-resolution publication identity set is incomplete.",
        "OUTBOX_EVIDENCE_INVALID"
      );
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      outboxWriter.write({
        id: outboxEventIds[index],
        leagueId: command.leagueId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: createSocketEventMetadata({
          eventType: event.eventType,
          version: event.version,
          reasonCode: event.reasonCode,
          occurredAtMs: command.resolvedAtMs,
          related: event.related,
        }),
        occurredAtMs: command.resolvedAtMs,
        audiences: event.audiences,
      });
    }
    return outboxEventIds;
  }

  function currentCommissionerUserId(command) {
    const commissioner = uniqueRow(
      commissionerRecipientStatement,
      {
        leagueId: command.leagueId,
        failedAtMs: command.failedAtMs,
      },
      "The current FAD recovery commissioner"
    );
    if (!commissioner) {
      incompatible(
        "The FAD recovery has no current active commissioner recipient.",
        "CORRECTION_RECIPIENT_MISSING"
      );
    }
    return commissioner.user_id;
  }

  function correctionNotificationContract(
    command,
    row,
    recoveryId,
    userId
  ) {
    return createFreeAgentDraftNotificationContract({
      type: "fad_correction_required",
      recipientUserId: userId,
      messageData: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        auctionId: command.auctionId,
        recoveryId,
        playerId: command.playerId,
        errorCode: command.errorCode,
        destination: {
          kind: "fad_recovery",
          leagueId: command.leagueId,
          fadId: command.fadId,
          recoveryId,
        },
      },
    });
  }

  function validateCorrectionNotification(
    notification,
    contract,
    command
  ) {
    if (
      !notification ||
      notification.user_id !== contract.recipientUserId ||
      notification.league_id !== command.leagueId ||
      notification.event_type !== contract.type ||
      notification.message_data_json !==
        JSON.stringify(contract.messageData) ||
      notification.related_feature !== "free_agent_draft" ||
      notification.related_record_id !== command.fadId ||
      notification.delivery_status !== "pending" ||
      notification.read_at_ms !== null ||
      notification.delivered_at_ms !== null ||
      notification.version !== 1 ||
      notification.deduplication_key !== contract.deduplicationKey
    ) {
      incompatible(
        "The FAD correction-required notification evidence is not exact.",
        "CORRECTION_NOTIFICATION_INVALID"
      );
    }
    return notification;
  }

  function writeFailurePublications(command, row, recoveryId, id) {
    const userId = currentCommissionerUserId(command);
    const contract = correctionNotificationContract(
      command,
      row,
      recoveryId,
      userId
    );
    let notification = uniqueRow(
      notificationByDeduplicationStatement,
      {
        userId,
        eventType: contract.type,
        deduplicationKey: contract.deduplicationKey,
      },
      "The correction-required notification"
    );
    if (!notification) {
      const notificationId = id(
        "FAD correction-required notification"
      );
      const written = notificationsWriter.insert({
        id: notificationId,
        userId,
        leagueId: command.leagueId,
        eventType: contract.type,
        messageDataJson: JSON.stringify(contract.messageData),
        relatedFeature: "free_agent_draft",
        relatedRecordId: command.fadId,
        deliveryStatus: "pending",
        createdAtMs: command.failedAtMs,
        deliveredAtMs: null,
        deduplicationKey: contract.deduplicationKey,
      });
      if (
        !written ||
        typeof written.then === "function" ||
        written.replayed !== false ||
        written.notification?.id !== notificationId
      ) {
        conflict(
          "The FAD correction-required notification write was not exact.",
          "CORRECTION_NOTIFICATION_WRITE_INVALID"
        );
      }
      notification = written.notification;
    }
    validateCorrectionNotification(notification, contract, command);

    let notificationOutboxes = notificationOutboxStatement.all({
      leagueId: command.leagueId,
      notificationId: notification.id,
    });
    if (notificationOutboxes.length === 0) {
      const notificationOutboxId = id(
        "FAD correction-required notification outbox"
      );
      outboxWriter.write({
        id: notificationOutboxId,
        leagueId: command.leagueId,
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: notification.id,
        payload: createSocketEventMetadata({
          eventType: "notification.created",
          version: 1,
          reasonCode: "auction_changed",
          occurredAtMs: notification.created_at_ms,
          related: createEmptySocketRelated({
            fadId: command.fadId,
            allocationId: command.allocationId,
            auctionId: command.auctionId,
            recoveryId,
          }),
        }),
        occurredAtMs: notification.created_at_ms,
        audiences: [{ kind: "user", userId }],
      });
      notificationOutboxes = notificationOutboxStatement.all({
        leagueId: command.leagueId,
        notificationId: notification.id,
      });
    }
    if (notificationOutboxes.length !== 1) {
      incompatible(
        "The FAD correction-required notification publication is not unique.",
        "CORRECTION_NOTIFICATION_OUTBOX_INVALID"
      );
    }

    const fadOutboxEventId = id(
      "FAD failure draft outbox event"
    );
    const auctionOutboxEventId = id(
      "FAD failure auction outbox event"
    );
    const related = createEmptySocketRelated({
      fadId: command.fadId,
      allocationId: command.allocationId,
      auctionId: command.auctionId,
      recoveryId,
    });
    for (const publication of [
      {
        id: fadOutboxEventId,
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: command.fadId,
        version: row.fad_version,
        reasonCode: "allocation_changed",
      },
      {
        id: auctionOutboxEventId,
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: command.auctionId,
        version: command.expectedAuctionVersion + 1,
        reasonCode: "auction_changed",
      },
    ]) {
      outboxWriter.write({
        id: publication.id,
        leagueId: command.leagueId,
        eventType: publication.eventType,
        aggregateType: publication.aggregateType,
        aggregateId: publication.aggregateId,
        payload: createSocketEventMetadata({
          eventType: publication.eventType,
          version: publication.version,
          reasonCode: publication.reasonCode,
          occurredAtMs: command.failedAtMs,
          related,
        }),
        occurredAtMs: command.failedAtMs,
        audiences: [{ kind: "league" }],
      });
    }
    return Object.freeze({
      notificationId: notification.id,
      outboxEventIds: Object.freeze([
        fadOutboxEventId,
        auctionOutboxEventId,
        notificationOutboxes[0].id,
      ]),
    });
  }

  function drawWrite(command, row, decision) {
    const reveal = decision.drawReveal;
    const teamByBid = new Map(
      decision.tiedTopBids.map((bid) => [bid.bidId, bid.teamId])
    );
    const orderedBidIds = reveal.selectionUsed
      ? reveal.orderedBidIds
      : [];
    const orderedTeamIds = orderedBidIds.map((bidId) => {
      const teamId = teamByBid.get(bidId);
      if (!teamId) {
        incompatible(
          "The FAD draw reveal does not map to its exact tied teams.",
          "DRAW_REVEAL_INVALID"
        );
      }
      return teamId;
    });
    return {
      ...command,
      drawId: row.draw_id,
      orderedBidIdsJson: JSON.stringify(orderedBidIds),
      orderedTeamIdsJson: JSON.stringify(orderedTeamIds),
      rejectionCounter: reveal.selectionUsed ? reveal.counter : null,
      selectedIndex: reveal.selectionUsed ? reveal.selectedIndex : null,
      selectedBidId: reveal.selectionUsed ? reveal.selectedBidId : null,
      selectedTeamId: reveal.selectionUsed ? reveal.selectedTeamId : null,
      selectedDigestHex: reveal.selectionUsed ? reveal.digestHex : null,
    };
  }

  function fallbackIds(command, id) {
    const targets = targetRolloverStatement.all({
      ...command,
      nowMs: command.resolvedAtMs,
    });
    let extensionRolloverId = null;
    let fallbackOpensAtMs;
    if (targets.length > 0) {
      fallbackOpensAtMs = targets[0].opens_at_ms;
    } else {
      const predecessors = extensionPredecessorStatement.all({
        ...command,
        nowMs: command.resolvedAtMs,
      });
      if (predecessors.length !== 1) {
        conflict(
          "The restricted fallback has no exact complete rollover window.",
          "FALLBACK_WINDOW_CHANGED"
        );
      }
      extensionRolloverId = id("fallback extension rollover");
      fallbackOpensAtMs = predecessors[0].rolls_over_at_ms;
    }
    const delayed = fallbackOpensAtMs > command.resolvedAtMs;
    const offerCount = offerEventsStatement.all({
      ...command,
      allocationVersion: command.expectedAllocationVersion,
    }).length;
    const recipientCount = delayed
      ? 0
      : fallbackRecipientCountStatement.get({
          ...command,
          nowMs: command.resolvedAtMs,
        }).count;
    return Object.freeze({
      fallbackAuctionId: id("fallback auction"),
      fallbackDrawId: id("fallback draw"),
      sourceResolutionId: id("restricted no-winner resolution"),
      sourceAuctionEventId: id("restricted no-winner auction event"),
      allocationStateEventId: id("fallback allocation state event"),
      activityId: delayed ? null : id("fallback activity"),
      fadOutboxEventId: delayed ? null : id("fallback FAD outbox"),
      auctionOutboxEventId: delayed
        ? null
        : id("fallback auction outbox"),
      extensionRolloverId,
      fallbackActivationJobRunId: delayed
        ? id("fallback activation job")
        : null,
      fallbackResolutionJobRunId: id("fallback resolution job"),
      clonedOfferEventIds: Object.freeze(
        Array.from({ length: offerCount }, () =>
          id("fallback cloned offer event")
        )
      ),
      notificationIds: Object.freeze(
        Array.from({ length: recipientCount }, () =>
          id("fallback notification")
        )
      ),
    });
  }

  function persistDirect(command, row, candidate, recovery, id) {
    const { decision } = candidate;
    const winner = decision.outcome === "winner";
    const standaloneOpen = standaloneOpenBinding(row);
    const resources = winner
      ? persistWinnerResources(command, row, decision, id)
      : {
          resolutionId: id("FAD no-winner resolution"),
          contractId: null,
          ownershipId: null,
          positionGroup: null,
          slotNumber: null,
    };
    const activityId = id("FAD resolution activity");
    const auctionEventId = id("FAD terminal auction event");
    let legality = deepFreeze({ generalIllegal: false, warnings: [] });
    let allocationStatus;
    let allocationDecisionCode;
    let winningSnapshotEntryId = null;

    if (winner) {
      legality = winnerLegality(command, row, decision.winner.teamId);
      if (row.source_kind === "fad_restricted") {
        const participant = candidate.rawParticipants.find(
          (item) => item.team_id === decision.winner.teamId
        );
        if (!participant?.source_snapshot_entry_id) {
          incompatible(
            "The restricted winner has no Candidate snapshot witness.",
            "WINNER_SNAPSHOT_MISSING"
          );
        }
        winningSnapshotEntryId = participant.source_snapshot_entry_id;
        allocationStatus = "restricted_resolved";
        allocationDecisionCode = "restricted_auction_result";
      } else if (!standaloneOpen) {
        allocationStatus = "fallback_open_resolved";
        allocationDecisionCode = "fallback_open_result";
      } else {
        allocationStatus = null;
        allocationDecisionCode = null;
      }
      if (!standaloneOpen) {
        assertChanged(
          updateAllocationWinnerStatement.run({
            ...command,
            sourceKind: row.source_kind,
            allocationSourceStatus: row.allocation_status,
            allocationTerminalStatus: allocationStatus,
            allocationDecisionCode,
            winningSnapshotEntryId,
            winningTeamId: decision.winner.teamId,
            contractId: resources.contractId,
            ownershipId: resources.ownershipId,
          }),
          "The FAD winner allocation",
          "ALLOCATION_CAS_FAILED"
        );
      }
    } else {
      allocationStatus = standaloneOpen
        ? null
        : "fallback_open_resolved";
      allocationDecisionCode = standaloneOpen
        ? null
        : "fallback_open_no_winner";
      if (!standaloneOpen) {
        assertChanged(
          updateAllocationNoWinnerStatement.run(command),
          "The FAD no-winner allocation",
          "ALLOCATION_CAS_FAILED"
        );
      }
    }

    updateBids(command, candidate, decision);
    const notificationPublications =
      createResolutionNotificationPublications(
        command,
        row,
        id
      );
    const notificationIds = Object.freeze(
      notificationPublications.map(
        (publication) => publication.notificationId
      )
    );
    const outboxEventIds = Object.freeze([
      id("FAD resolution FAD outbox event"),
      id("FAD resolution auction outbox event"),
      id("FAD resolution activity outbox event"),
      ...notificationPublications.map(() =>
        id("FAD rapid-result notification outbox event")
      ),
    ]);
    const activityContract = createFreeAgentDraftActivityContract({
      eventType: winner
        ? "free_agent_draft_player_awarded"
        : "free_agent_draft_auction_no_winner",
      metadata: {
        schemaVersion: 1,
        fadId: row.fad_id,
        allocationId: row.allocation_id,
        auctionId: row.auction_id,
        resolutionId: resources.resolutionId,
        activityId,
        notificationIds,
        outboxEventIds,
        playerId: row.player_id,
        winner: winner ? decision.winner : null,
        rankedBids: decision.rankedBids,
        bidHistory: winner ? eligibleBidHistory(command, decision) : [],
        positionGroup: resources.positionGroup,
        slotNumber: resources.slotNumber,
        generalIllegal: legality.generalIllegal,
        warnings: legality.warnings,
      },
    });
    activityRepository.insert({
      id: activityId,
      league_id: command.leagueId,
      season_id: row.season_id,
      event_type: activityContract.eventType,
      actor_user_id: null,
      actor_authority: "system",
      team_id: winner ? decision.winner.teamId : null,
      player_id: row.player_id,
      related_type: "auction_resolution",
      related_id: resources.resolutionId,
      display_summary: winner
        ? `${row.player_full_name} signed through Free Agent Draft auction.`
        : `${row.player_full_name}'s Free Agent Draft auction ended without a winner.`,
      reason: null,
      metadata_json: JSON.stringify(activityContract.metadata),
      occurred_at_ms: command.resolvedAtMs,
    });
    persistResolutionNotifications(
      command,
      row,
      notificationPublications
    );
    if (!standaloneOpen) {
      cloneAllocationEvidence(command, row, {
        activityId,
        allocationDecisionCode,
        allocationStatus,
        contractId: resources.contractId,
        eventKind: row.source_kind === "fad_restricted"
          ? "restricted_state_changed"
          : "fallback_state_changed",
        id,
        notificationIds,
        outboxEventIds,
        ownershipId: resources.ownershipId,
      });
    }

    auctionEventsRepository.insert({
      id: auctionEventId,
      league_id: command.leagueId,
      season_id: row.season_id,
      auction_id: command.auctionId,
      bid_id: winner ? decision.winner.bidId : null,
      team_id: winner ? decision.winner.teamId : null,
      actor_user_id: null,
      event_type: winner ? "auction_resolved" : "auction_no_winner",
      metadata_json: JSON.stringify({
        resolutionId: resources.resolutionId,
        outcome: winner ? "winner" : "no_winner",
        winner: winner ? decision.winner : null,
        skippedBids: decision.skippedBids,
        generalIllegal: legality.generalIllegal,
        warnings: legality.warnings,
      }),
      occurred_at_ms: command.resolvedAtMs,
    });

    resolutionsRepository.insert({
      id: resources.resolutionId,
      league_id: command.leagueId,
      season_id: row.season_id,
      auction_id: command.auctionId,
      scheduled_occurrence_key: command.occurrenceKey,
      outcome_code: winner ? "winner" : "no_winner",
      winning_team_id: winner ? decision.winner.teamId : null,
      winning_bid_id: winner ? decision.winner.bidId : null,
      highest_bid_cents: winner
        ? decision.winner.submittedTotalValueCents
        : null,
      second_price_input_cents: winner
        ? decision.winner.persistedSecondPriceInputCents
        : null,
      final_contract_value_cents: winner
        ? decision.winner.finalTotalValueCents
        : null,
      winning_term_years: winner
        ? decision.winner.submittedTermYears
        : null,
      final_aav_cents: winner ? decision.winner.finalAavCents : null,
      general_illegal: legality.generalIllegal ? 1 : 0,
      warnings_json: JSON.stringify(legality.warnings),
      contract_id: resources.contractId,
      ownership_id: resources.ownershipId,
      trigger_type: "automatic",
      triggered_by_user_id: null,
      idempotency_key: command.occurrenceKey,
      status: winner ? "resolved" : "no_winner",
      resolved_at_ms: command.resolvedAtMs,
    });

    assertChanged(
      revealDrawStatement.run(drawWrite(command, row, decision)),
      "The FAD draw reveal",
      "DRAW_REVEAL_CAS_FAILED"
    );
    assertChanged(
      terminalizeAuctionStatement.run({
        ...command,
        auctionTerminalStatus: winner ? "resolved" : "no_winner",
      }),
      "The terminal FAD auction",
      "AUCTION_TERMINAL_CAS_FAILED"
    );

    writeOutboxes(command, row, {
      activityId,
      outboxEventIds,
      notificationPublications,
    });
    if (winner) {
      candidateCardSummerSynchronizer.synchronize({
        leagueId: command.leagueId,
        affectedTeamIds: [decision.winner.teamId],
        affectedPlayerIds: [row.player_id],
        sourceOperationId: resources.resolutionId,
        sourceKind: "auction_allocation",
        nowMs: command.resolvedAtMs,
      });
    }
    if (recovery) {
      assertChanged(
        resolveRecoveryStatement.run({
          ...command,
          recoveryId: recovery.id,
        }),
        "The FAD auction-resolution recovery",
        "RECOVERY_RESOLUTION_CAS_FAILED"
      );
    }
    assertChanged(
      succeedJobStatement.run({
        ...command,
        scheduledForMs: row.resolves_at_ms,
        resultJson: JSON.stringify({
          auctionId: command.auctionId,
          outcome: winner ? "resolved" : "no_winner",
        }),
      }),
      "The FAD auction-resolution job",
      "JOB_TERMINAL_CAS_FAILED"
    );
  }

  executeTransaction = database.transaction((command) => {
    const replay = readProjectedResolution(command, true);
    if (replay) return replay;
    const row = validateContext(readSource(command));
    if (!row) {
      notFound(
        "The claimed FAD auction-resolution source was not found.",
        "RESOLUTION_SOURCE_NOT_FOUND"
      );
    }
    validateLiveFence(row, command);
    const candidate = loadDecisionCandidate(row, command.resolvedAtMs);
    if (candidate.decision.outcome === "not_due") {
      conflict(
        "The claimed FAD auction is not due for resolution.",
        "RESOLUTION_NOT_DUE"
      );
    }
    const recovery = sourceRecovery(row, command);
    const id = newIdentityFactory();
    if (candidate.decision.outcome === "restricted_fallback") {
      const ids = fallbackIds(command, id);
      const result = restrictedFallbackWriter.openFallback({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        sourceAuctionId: command.auctionId,
        occurrenceKey: command.occurrenceKey,
        jobRunId: command.runId,
        leaseOwner: command.leaseOwner,
        leaseToken: command.leaseToken,
        expectedJobVersion: command.expectedJobVersion,
        expectedAuctionVersion: command.expectedAuctionVersion,
        expectedAllocationVersion: command.expectedAllocationVersion,
        nowMs: command.resolvedAtMs,
        ids,
      });
      if (!result.applied) {
        conflict(
          "The restricted fallback eligibility changed during execution.",
          "FALLBACK_ELIGIBILITY_CHANGED"
        );
      }
    } else {
      persistDirect(command, row, candidate, recovery, id);
    }
    const terminal = readProjectedResolution(command, false);
    if (!terminal) {
      incompatible(
        "The FAD auction-resolution transaction produced no terminal result.",
        "RESOLUTION_POSTCONDITION_MISSING"
      );
    }
    if (beforeCommit) {
      const hookResult = beforeCommit({ command, result: terminal });
      if (hookResult && typeof hookResult.then === "function") {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.transactionAsync,
          "FAD auction-resolution beforeCommit must be synchronous."
        );
      }
    }
    return terminal;
  });

  recordFailureTransaction = database.transaction((command) => {
    const replay = readFailureProjection(command, true);
    if (replay) return replay;
    const row = validateContext(readSource(command));
    if (!row) {
      notFound(
        "The claimed FAD auction-resolution source was not found.",
        "RESOLUTION_SOURCE_NOT_FOUND"
      );
    }
    validateLiveFence(row, command);
    const recovery = sourceRecovery(row, command);
    const standaloneOpen = standaloneOpenBinding(row);
    const id = newIdentityFactory();
    const recoveryId = recovery?.id ||
      id("FAD auction-resolution failure recovery");
    const failureEventId = id("FAD auction-resolution failure event");
    const allocationFailure = () => {
      assertChanged(
        updateAllocationFailureStatement.run({
          ...command,
          sourceKind: row.source_kind,
          allocationSourceStatus: row.allocation_status,
          allocationDecisionCode: row.allocation_decision_code,
        }),
        "The failed FAD allocation quarantine",
        "ALLOCATION_FAILURE_CAS_FAILED"
      );
      cloneFailureEvidence(
        command,
        row,
        { failureEventId, recoveryId },
        id
      );
    };
    const jobFailure = () => {
      assertChanged(
        failJobStatement.run({
          ...command,
          resolvesAtMs: row.resolves_at_ms,
        }),
        "The failed FAD auction-resolution job",
        "JOB_FAILURE_CAS_FAILED"
      );
    };
    const auctionFailure = () => {
      assertChanged(
        failAuctionStatement.run(command),
        "The failed FAD auction",
        "AUCTION_FAILURE_CAS_FAILED"
      );
    };
    if (recovery) {
      jobFailure();
      assertChanged(
        failRecoveryStatement.run({
          ...command,
          recoveryId,
          resolvesAtMs: row.resolves_at_ms,
          expectedRecoveryVersion: recovery.version,
        }),
        "The repeated FAD auction-resolution recovery failure",
        "RECOVERY_FAILURE_CAS_FAILED"
      );
      auctionFailure();
      if (!standaloneOpen) allocationFailure();
    } else {
      if (!standaloneOpen) allocationFailure();
      insertFailureRecoveryStatement.run({
        ...command,
        recoveryId,
        resolvesAtMs: row.resolves_at_ms,
      });
      jobFailure();
      auctionFailure();
    }
    writeFailurePublications(
      command,
      row,
      recoveryId,
      id
    );
    auctionEventsRepository.insert({
      id: failureEventId,
      league_id: command.leagueId,
      season_id: command.seasonId,
      auction_id: command.auctionId,
      bid_id: null,
      team_id: null,
      actor_user_id: null,
      event_type: "fad_auction_resolution_failed",
      metadata_json: serializeCanonicalJsonV1({
        errorCode: command.errorCode,
        jobRunId: command.runId,
        recoveryId,
      }),
      occurred_at_ms: command.failedAtMs,
    });
    const terminal = readFailureProjection(command, false);
    if (!terminal) {
      incompatible(
        "The FAD auction-resolution failure transaction produced no durable evidence.",
        "FAILURE_POSTCONDITION_MISSING"
      );
    }
    if (beforeCommit) {
      const hookResult = beforeCommit({ command, result: terminal });
      if (hookResult && typeof hookResult.then === "function") {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.transactionAsync,
          "FAD auction-resolution beforeCommit must be synchronous."
        );
      }
    }
    return terminal;
  });

  return Object.freeze({
    listDue({ nowMs, limit = 25 } = {}) {
      const observedAtMs = safeTimestamp(nowMs, "due-query timestamp");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        invalid(
          "The FAD auction-resolution due-query limit must be between one and 100.",
          "LIMIT_INVALID"
        );
      }
      try {
        return deepFreeze(
          listDueStatement.all({ nowMs: observedAtMs, limit }).map((row) => ({
            leagueId: row.league_id,
            seasonId: row.season_id,
            fadId: row.fad_id,
            allocationId: row.allocation_id,
            allocationVersion: row.allocation_id === null
              ? 0
              : row.allocation_version,
            playerId: row.player_id,
            rolloverId: row.rollover_id,
            auctionId: row.auction_id,
            auctionVersion: row.auction_version,
            auctionStatus: row.auction_status,
            resolvesAtMs: row.resolves_at_ms,
            occurrenceKey: occurrenceKey(
              row.auction_id,
              row.resolves_at_ms
            ),
            jobRunId: row.job_run_id,
            jobRunVersion: row.job_version,
            jobStatus: row.job_status,
            attemptCount: row.attempt_count,
          }))
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listDueFreeAgentDraftAuctionResolutions",
          tableName: "auctions",
        });
      }
    },

    claimDue(input = {}) {
      const command = normalizeClaim(input);
      try {
        return claimTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "claimDueFreeAgentDraftAuctionResolution",
          tableName: "job_runs",
        });
      }
    },

    findResolution(input = {}) {
      exactObject(
        input,
        ["auctionId", "leagueId", "occurrenceKey"],
        "FAD auction-resolution lookup"
      );
      const command = {
        leagueId: stableId(input.leagueId, "league"),
        auctionId: stableId(input.auctionId, "auction"),
        occurrenceKey: boundedText(
          input.occurrenceKey,
          500,
          "resolution occurrence key"
        ),
      };
      try {
        return readProjectedResolution(command, true);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findFreeAgentDraftAuctionResolution",
          tableName: "auction_resolutions",
        });
      }
    },

    executeClaimed(input = {}) {
      const command = normalizeExecute(input);
      try {
        if (database.inTransaction) {
          invalid(
            "FAD auction resolution owns its immediate transaction boundary.",
            "TRANSACTION_OWNERSHIP_INVALID"
          );
        }
        return executeTransaction.immediate(command);
      } catch (error) {
        throw mapExecutionError(error);
      }
    },

    recordFailure(input = {}) {
      const command = normalizeFailure(input);
      try {
        if (database.inTransaction) {
          invalid(
            "FAD auction-resolution failure owns its immediate transaction boundary.",
            "TRANSACTION_OWNERSHIP_INVALID"
          );
        }
        return recordFailureTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "recordFreeAgentDraftAuctionResolutionFailure",
          tableName: "free_agent_draft_recoveries",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE,
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE,
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_WRITER_METHODS,
  createSqliteFreeAgentDraftAuctionResolutionWriter,
  isFreeAgentDraftAuctionResolutionTerminalFailure,
};
