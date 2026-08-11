"use strict";

const {
  createHash,
  randomBytes,
  randomUUID,
} = require("node:crypto");

const {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
  UUID_PATTERN,
  buildFreeAgentDraftNominationOpenOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  parseCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");

const JOB_TYPE = "fad_queued_nomination_activation";
const RESOLUTION_JOB_TYPE = "auction.resolve.target";
const OPERATION =
  "free_agent_draft_queued_nomination_activation";
const PLAYER_UNAVAILABLE = "PLAYER_UNAVAILABLE";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/u;

const METHODS = Object.freeze([
  "findActivation",
  "executeClaimed",
  "recordFailure",
]);
const FIND_FIELDS = Object.freeze([
  "fadId",
  "leagueId",
  "queueId",
  "rolloverAtMs",
  "seasonId",
]);
const EXECUTE_FIELDS = Object.freeze([
  "activatedAtMs",
  "expectedQueueVersion",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "openingAtMs",
  "openingRolloverId",
  "playerId",
  "queueId",
  "seasonId",
]);
const FAILURE_FIELDS = Object.freeze([
  "errorCode",
  "expectedQueueVersion",
  "fadId",
  "failedAtMs",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "openingAtMs",
  "openingRolloverId",
  "playerId",
  "queueId",
  "seasonId",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "expectedVersion",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
]);
const STORED_RESULT_FIELDS = Object.freeze([
  "identity",
  "operation",
  "request",
  "response",
  "schemaVersion",
]);
const STORED_IDENTITY_FIELDS = Object.freeze([
  "fadId",
  "jobRunId",
  "leagueId",
  "occurrenceKey",
  "openingAtMs",
  "openingRolloverId",
  "queueId",
  "seasonId",
]);
const STORED_REQUEST_FIELDS = Object.freeze([
  "activatedAtMs",
  "expectedJobVersion",
  "expectedQueueVersion",
]);
const RESPONSE_FIELDS = Object.freeze([
  "activatedAtMs",
  "auctionId",
  "drawId",
  "evidence",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "openingAtMs",
  "openingRolloverId",
  "outcome",
  "queueId",
  "queueVersion",
  "resolutionJobRunId",
  "resolutionRolloverId",
  "resolvesAtMs",
  "seasonId",
  "sourceRecoveryId",
  "starterBidId",
  "validationCode",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "auctionEventId",
  "extensionRolloverId",
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
    actual.some((field, index) => field !== expected[index])
  ) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_FIELDS_INVALID"
    );
  }
  return value;
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
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
      "VERSION_INVALID"
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

function safeErrorCode(value) {
  if (
    typeof value !== "string" ||
    !ERROR_CODE_PATTERN.test(value)
  ) {
    invalid(
      "A safe queued-nomination activation error code is required.",
      "ERROR_CODE_INVALID"
    );
  }
  if (
    value !==
    FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE
  ) {
    invalid(
      "Queued-nomination activation failures use one stable public-safe code.",
      "ERROR_CODE_UNSUPPORTED"
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

function roundedAav(totalValueCents, termYears) {
  const whole = Math.floor(totalValueCents / termYears);
  const remainder = totalValueCents % termYears;
  return whole + (remainder * 2 >= termYears ? 1 : 0);
}

function canonicalOccurrenceKey(scope) {
  try {
    return buildFreeAgentDraftNominationOpenOccurrenceKey({
      fadId: scope.fadId,
      queueId: scope.queueId,
      rolloverAtMs: scope.openingAtMs,
    });
  } catch (error) {
    invalid(
      "The queued-nomination activation occurrence identity is invalid.",
      "OCCURRENCE_KEY_INVALID"
    );
  }
}

function deterministicUuid(value) {
  const hex = createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function terminalQueueOutboxEventId(queueId) {
  return deterministicUuid(
    `fad-queued-nomination:${queueId}:nomination-opened`
  );
}

function openedAuctionOutboxEventId(auctionId) {
  return deterministicUuid(
    `fad-queued-nomination:${auctionId}:auction-opened`
  );
}

function normalizeFind(input) {
  exactObject(input, FIND_FIELDS, "queued-nomination activation lookup");
  const scope = {
    leagueId: canonicalId(input.leagueId, "league"),
    seasonId: canonicalId(input.seasonId, "season"),
    fadId: canonicalId(input.fadId, "Free Agent Draft"),
    queueId: canonicalId(input.queueId, "nomination queue"),
    openingAtMs: safeTimestamp(
      input.rolloverAtMs,
      "queued-nomination opening timestamp"
    ),
  };
  return Object.freeze({
    ...scope,
    occurrenceKey: canonicalOccurrenceKey(scope),
  });
}

function normalizeJobExecution(input) {
  exactObject(
    input,
    JOB_EXECUTION_FIELDS,
    "queued-nomination activation job execution"
  );
  return Object.freeze({
    runId: canonicalId(input.runId, "activation job-run"),
    expectedJobVersion: positiveInteger(
      input.expectedVersion,
      "activation job-run version"
    ),
    leaseOwner: boundedText(
      input.leaseOwner,
      128,
      "activation lease owner"
    ),
    leaseToken: boundedText(
      input.leaseToken,
      200,
      "activation lease token"
    ),
    leaseExpiresAtMs: safeTimestamp(
      input.leaseExpiresAtMs,
      "activation lease expiry"
    ),
  });
}

function normalizeCommand(input, { failure }) {
  exactObject(
    input,
    failure ? FAILURE_FIELDS : EXECUTE_FIELDS,
    failure
      ? "queued-nomination activation failure command"
      : "queued-nomination activation command"
  );
  const openingAtMs = safeTimestamp(
    input.openingAtMs,
    "queued-nomination opening timestamp"
  );
  const scope = {
    leagueId: canonicalId(input.leagueId, "league"),
    seasonId: canonicalId(input.seasonId, "season"),
    fadId: canonicalId(input.fadId, "Free Agent Draft"),
    queueId: canonicalId(input.queueId, "nomination queue"),
    openingRolloverId: canonicalId(
      input.openingRolloverId,
      "opening rollover"
    ),
    openingAtMs,
    playerId: canonicalId(input.playerId, "player"),
    expectedQueueVersion: positiveInteger(
      input.expectedQueueVersion,
      "nomination queue version"
    ),
    ...normalizeJobExecution(input.jobExecution),
  };
  const expectedOccurrenceKey = canonicalOccurrenceKey(scope);
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "queued-nomination activation occurrence key"
  );
  if (occurrenceKey !== expectedOccurrenceKey) {
    invalid(
      "The queued-nomination occurrence key does not match its exact scope.",
      "OCCURRENCE_SCOPE_INVALID"
    );
  }
  const terminalAtMs = safeTimestamp(
    failure ? input.failedAtMs : input.activatedAtMs,
    failure
      ? "queued-nomination failure timestamp"
      : "queued-nomination activation timestamp"
  );
  return Object.freeze({
    ...scope,
    occurrenceKey,
    ...(failure
      ? {
          failedAtMs: terminalAtMs,
          errorCode: safeErrorCode(input.errorCode),
        }
      : { activatedAtMs: terminalAtMs }),
  });
}

function parseCanonical(encoded, description) {
  try {
    return deepFreeze(parseCanonicalJsonV1(encoded));
  } catch (error) {
    incompatible(
      `The persisted ${description} is not canonical JSON.`,
      "PERSISTED_JSON_INVALID",
      error
    );
  }
}

function createSqliteFreeAgentDraftQueuedNominationActivationWriter({
  database,
  createId = () => randomUUID(),
  createDrawNonce = () => randomBytes(32),
  leagueOutboxWriter,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftQueuedNominationActivationWriter requires an opened database"
    );
  }
  if (typeof createId !== "function") {
    throw new TypeError(
      "Queued-nomination activation identifier creation must be a function"
    );
  }
  if (typeof createDrawNonce !== "function") {
    throw new TypeError(
      "Queued-nomination activation draw nonce creation must be a function"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "Queued-nomination activation beforeCommit must be a function"
    );
  }

  let activationStatement;
  let successorStatement;
  let recoveryStatement;
  let playerStatement;
  let positionCorrectionStatement;
  let sourcePositionsStatement;
  let ownershipStatement;
  let releasedRightsStatement;
  let activeAuctionStatement;
  let starterUseStatement;
  let artifactStatement;
  let insertExtensionStatement;
  let insertAuctionStatement;
  let insertContextStatement;
  let insertDrawStatement;
  let insertBidStatement;
  let insertEventStatement;
  let insertResolutionJobStatement;
  let openQueueStatement;
  let invalidateQueueStatement;
  let resolveRecoveryStatement;
  let succeedJobStatement;
  let insertRecoveryStatement;
  let failRecoveryStatement;
  let failJobStatement;
  let outbox;
  let findProtectedCommissionerStatement;
  let listProtectedAdministratorsStatement;
  let findOutboxEventStatement;
  let listOutboxAudiencesStatement;
  let countRelatedOutboxesAtStatement;

  try {
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    findProtectedCommissionerStatement = database.prepare(`
      SELECT membership.user_id
      FROM leagues AS league
      JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = league.commissioner_membership_id
      JOIN users AS user
        ON user.id = membership.user_id
      WHERE league.id = @leagueId
        AND membership.status = 'active'
        AND membership.permission_category = 'commissioner'
        AND membership.joined_at_ms IS NOT NULL
        AND membership.joined_at_ms <= @occurredAtMs
        AND membership.ended_at_ms IS NULL
        AND user.status = 'active'
      LIMIT 2
    `);
    listProtectedAdministratorsStatement = database.prepare(`
      SELECT DISTINCT role.user_id
      FROM platform_roles AS role
      JOIN users AS user
        ON user.id = role.user_id
      JOIN league_memberships AS membership
        ON membership.league_id = @leagueId
       AND membership.user_id = role.user_id
      WHERE role.role = 'platform_administrator'
        AND role.status = 'active'
        AND role.ended_at_ms IS NULL
        AND user.status = 'active'
        AND membership.status = 'active'
        AND membership.joined_at_ms IS NOT NULL
        AND membership.joined_at_ms <= @occurredAtMs
        AND membership.ended_at_ms IS NULL
      ORDER BY role.user_id
    `);
    findOutboxEventStatement = database.prepare(`
      SELECT
        id, league_id, event_type, aggregate_type, aggregate_id,
        payload_json, available_at_ms, created_at_ms
      FROM outbox_events
      WHERE league_id = @leagueId
        AND id = @outboxEventId
      LIMIT 2
    `);
    listOutboxAudiencesStatement = database.prepare(`
      SELECT id, audience_kind, team_id, user_id, created_at_ms
      FROM outbox_event_audiences
      WHERE league_id = @leagueId
        AND outbox_event_id = @outboxEventId
      ORDER BY audience_kind, COALESCE(team_id, user_id, '')
    `);
    countRelatedOutboxesAtStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM outbox_events
      WHERE league_id = @leagueId
        AND created_at_ms = @occurredAtMs
        AND json_valid(payload_json) = 1
        AND json_extract(
              payload_json,
              '$.related.nominationQueueId'
            ) = @queueId
    `);
    activationStatement = database.prepare(`
      SELECT
        queue.id AS queue_id,
        queue.league_id,
        queue.season_id,
        queue.fad_id,
        queue.team_id,
        queue.player_id,
        queue.source_rollover_id,
        queue.target_opening_rollover_id,
        queue.resolution_rollover_id,
        queue.opening_total_value_cents,
        queue.opening_term_years,
        queue.opening_aav_cents,
        queue.binding_illegality_confirmed,
        queue.binding_confirmed_at_ms,
        queue.submitted_by_user_id,
        queue.submitted_by_membership_id,
        queue.accepted_at_ms,
        queue.candidate_card_version_observed,
        queue.team_version_observed,
        queue.status AS queue_status,
        queue.opened_auction_id,
        queue.opened_starter_bid_id,
        queue.opened_at_ms,
        queue.terminal_at_ms,
        queue.validation_code,
        queue.created_at_ms AS queue_created_at_ms,
        queue.updated_at_ms AS queue_updated_at_ms,
        queue.version AS queue_version,
        queue.acceptance_idempotency_request_id,
        opening.sequence AS opening_sequence,
        opening.window_kind AS opening_window_kind,
        opening.predecessor_rollover_id
          AS opening_predecessor_rollover_id,
        opening.opens_at_ms AS opening_opens_at_ms,
        opening.creation_cutoff_at_ms,
        opening.rolls_over_at_ms AS opening_rolls_over_at_ms,
        opening.status AS opening_status,
        opening.created_at_ms AS opening_created_at_ms,
        opening.updated_at_ms AS opening_updated_at_ms,
        opening.version AS opening_version,
        request.actor_user_id AS request_actor_user_id,
        request.operation AS request_operation,
        request.status AS request_status,
        request.result_type AS request_result_type,
        request.result_id AS request_result_id,
        request.created_at_ms AS request_created_at_ms,
        request.completed_at_ms AS request_completed_at_ms,
        request.expires_at_ms AS request_expires_at_ms,
        membership.user_id AS membership_user_id,
        league.status AS league_status,
        league.current_season_id,
        season.status AS season_status,
        fad.status AS fad_status,
        team.status AS team_status,
        CASE WHEN fad_team.id IS NULL THEN 0 ELSE 1 END
          AS fad_team_participating,
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
      FROM free_agent_draft_nomination_queue AS queue
      JOIN free_agent_draft_rollovers AS opening
        ON opening.league_id = queue.league_id
       AND opening.season_id = queue.season_id
       AND opening.fad_id = queue.fad_id
       AND opening.id = queue.target_opening_rollover_id
      JOIN idempotency_requests AS request
        ON request.league_id = queue.league_id
       AND request.id = queue.acceptance_idempotency_request_id
      JOIN league_memberships AS membership
        ON membership.league_id = queue.league_id
       AND membership.id = queue.submitted_by_membership_id
      JOIN leagues AS league
        ON league.id = queue.league_id
      JOIN seasons AS season
        ON season.league_id = queue.league_id
       AND season.id = queue.season_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = queue.league_id
       AND fad.season_id = queue.season_id
       AND fad.id = queue.fad_id
      JOIN teams AS team
        ON team.league_id = queue.league_id
       AND team.id = queue.team_id
      LEFT JOIN free_agent_draft_teams AS fad_team
        ON fad_team.league_id = queue.league_id
       AND fad_team.season_id = queue.season_id
       AND fad_team.fad_id = queue.fad_id
       AND fad_team.team_id = queue.team_id
      JOIN job_runs AS job
        ON job.league_id = queue.league_id
       AND job.season_id = queue.season_id
       AND job.job_type = '${JOB_TYPE}'
       AND job.occurrence_key = @occurrenceKey
       AND job.scheduled_for_ms = @openingAtMs
      WHERE queue.league_id = @leagueId
        AND queue.season_id = @seasonId
        AND queue.fad_id = @fadId
        AND queue.id = @queueId
      LIMIT 2
    `);
    successorStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_rollovers
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND predecessor_rollover_id = @openingRolloverId
      LIMIT 2
    `);
    recoveryStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND nomination_queue_id = @queueId
        AND job_run_id = @runId
        AND kind = 'queued_nomination_activation'
      LIMIT 2
    `);
    playerStatement = database.prepare(`
      SELECT id, status
      FROM players
      WHERE id = @playerId
      LIMIT 2
    `);
    positionCorrectionStatement = database.prepare(`
      SELECT id, position_group
      FROM league_player_positions
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND ended_at_ms IS NULL
      ORDER BY id
      LIMIT 3
    `);
    sourcePositionsStatement = database.prepare(`
      SELECT DISTINCT normalized_position AS position_group
      FROM player_source_state
      WHERE player_id = @playerId
        AND ended_at_ms IS NULL
        AND active = 1
        AND normalized_position IN ('F', 'D')
      ORDER BY normalized_position
    `);
    ownershipStatement = database.prepare(`
      SELECT id
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND player_id = @playerId
      LIMIT 2
    `);
    releasedRightsStatement = database.prepare(`
      SELECT 1 AS excluded
      FROM ownership_events
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND event_type IN (
          'fantasy_elc_declined',
          'unsigned_prospect_rights_released'
        )
      LIMIT 1
    `);
    activeAuctionStatement = database.prepare(`
      SELECT id
      FROM auctions
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND player_id = @playerId
        AND status IN ('open', 'resolving')
      LIMIT 2
    `);
    starterUseStatement = database.prepare(`
      SELECT id
      FROM auction_bids
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND idempotency_request_id = @acceptanceIdempotencyRequestId
      LIMIT 2
    `);
    artifactStatement = database.prepare(`
      SELECT
        auction.id AS auction_id,
        auction.league_id,
        auction.season_id,
        auction.player_id,
        auction.status AS auction_status,
        auction.opened_at_ms,
        auction.resolves_at_ms,
        auction.opened_by_user_id,
        auction.created_at_ms AS auction_created_at_ms,
        auction.updated_at_ms AS auction_updated_at_ms,
        auction.version AS auction_version,
        context.id AS context_id,
        context.source_kind,
        context.fad_id AS context_fad_id,
        context.fad_rollover_id,
        context.fad_allocation_id,
        context.fad_origin,
        context.created_at_ms AS context_created_at_ms,
        starter.id AS starter_bid_id,
        starter.team_id AS starter_team_id,
        starter.submitted_by_user_id,
        starter.total_value_cents,
        starter.term_years,
        starter.lowest_offered_aav_cents,
        starter.first_submitted_at_ms,
        starter.last_edited_at_ms,
        starter.edit_count,
        starter.status AS starter_status,
        starter.idempotency_request_id,
        starter.version AS starter_version,
        event.id AS event_id,
        event.bid_id AS event_bid_id,
        event.team_id AS event_team_id,
        event.actor_user_id AS event_actor_user_id,
        event.event_type,
        event.metadata_json,
        event.occurred_at_ms,
        draw.id AS draw_id,
        draw.algorithm_version,
        draw.nonce_bytes,
        draw.commitment_hex,
        draw.created_at_ms AS draw_created_at_ms,
        draw.updated_at_ms AS draw_updated_at_ms,
        draw.version AS draw_version,
        resolver.id AS resolution_job_run_id,
        resolver.job_type AS resolution_job_type,
        resolver.occurrence_key AS resolution_occurrence_key,
        resolver.scheduled_for_ms AS resolution_scheduled_for_ms,
        resolver.created_at_ms AS resolution_created_at_ms
      FROM auctions AS auction
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
      JOIN auction_bids AS starter
        ON starter.league_id = auction.league_id
       AND starter.season_id = auction.season_id
       AND starter.auction_id = auction.id
       AND starter.id = @starterBidId
      JOIN auction_events AS event
        ON event.league_id = auction.league_id
       AND event.season_id = auction.season_id
       AND event.auction_id = auction.id
       AND event.id = @auctionEventId
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = auction.league_id
       AND draw.season_id = auction.season_id
       AND draw.auction_id = auction.id
       AND draw.id = @drawId
      JOIN job_runs AS resolver
        ON resolver.league_id = auction.league_id
       AND resolver.season_id = auction.season_id
       AND resolver.id = @resolutionJobRunId
      WHERE auction.league_id = @leagueId
        AND auction.season_id = @seasonId
        AND auction.id = @auctionId
      LIMIT 2
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
        @resolutionRolloverId, @leagueId, @seasonId, @fadId,
        @resolutionSequence, 'extension', @openingRolloverId,
        'queued_nomination', @queueId, @openingAtMs,
        @resolutionCreationCutoffAtMs, @resolvesAtMs,
        'scheduled', NULL, NULL, NULL, NULL,
        @activatedAtMs, @activatedAtMs, 1
      )
    `);
    insertAuctionStatement = database.prepare(`
      INSERT INTO auctions (
        id, league_id, season_id, player_id, status,
        opened_at_ms, resolves_at_ms, opened_by_user_id,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        @auctionId, @leagueId, @seasonId, @playerId, 'open',
        @openingAtMs, @resolvesAtMs, @submittedByUserId,
        @openingAtMs, @openingAtMs, 1
      )
    `);
    insertContextStatement = database.prepare(`
      INSERT INTO auction_contexts (
        id, league_id, season_id, auction_id, source_kind,
        fad_id, fad_rollover_id, fad_allocation_id,
        fad_origin, created_at_ms
      ) VALUES (
        @auctionId, @leagueId, @seasonId, @auctionId,
        'fad_open_rapid', @fadId, @resolutionRolloverId,
        NULL, 'queued_nomination', @openingAtMs
      )
    `);
    insertDrawStatement = database.prepare(`
      INSERT INTO free_agent_draft_draws (
        id, league_id, season_id, fad_id, allocation_id,
        auction_id, algorithm_version, nonce_bytes,
        commitment_hex, ordered_tied_bid_ids_json,
        ordered_tied_team_ids_json, rejection_counter,
        selected_index, selected_bid_id, selected_team_id,
        selected_digest_hex, revealed_at_ms, created_at_ms,
        updated_at_ms, version
      ) VALUES (
        @drawId, @leagueId, @seasonId, @fadId, NULL,
        @auctionId, 1, @nonceBytes, @commitmentHex,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        @openingAtMs, @openingAtMs, 1
      )
    `);
    insertBidStatement = database.prepare(`
      INSERT INTO auction_bids (
        id, league_id, season_id, auction_id, team_id,
        submitted_by_user_id, total_value_cents, term_years,
        lowest_offered_aav_cents, first_submitted_at_ms,
        last_edited_at_ms, edit_count, status,
        idempotency_request_id, version
      ) VALUES (
        @starterBidId, @leagueId, @seasonId, @auctionId,
        @teamId, @submittedByUserId, @totalValueCents,
        @termYears, @aavCents, @acceptedAtMs, @acceptedAtMs,
        0, 'active', @acceptanceIdempotencyRequestId, 1
      )
    `);
    insertEventStatement = database.prepare(`
      INSERT INTO auction_events (
        id, league_id, season_id, auction_id, bid_id, team_id,
        actor_user_id, event_type, metadata_json, occurred_at_ms
      ) VALUES (
        @auctionEventId, @leagueId, @seasonId, @auctionId,
        @starterBidId, @teamId, @submittedByUserId,
        'auction_started', @metadataJson, @openingAtMs
      )
    `);
    insertResolutionJobStatement = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type, occurrence_key,
        scheduled_for_ms, status, attempt_count, lease_owner,
        lease_expires_at_ms, started_at_ms, completed_at_ms,
        result_json, last_error_code, created_at_ms,
        updated_at_ms, version, lease_token, next_attempt_at_ms
      ) VALUES (
        @resolutionJobRunId, @leagueId, @seasonId,
        '${RESOLUTION_JOB_TYPE}', @resolutionOccurrenceKey,
        @resolvesAtMs, 'pending', 0, NULL, NULL, NULL, NULL,
        NULL, NULL, @activatedAtMs, @activatedAtMs, 1,
        NULL, NULL
      )
    `);
    openQueueStatement = database.prepare(`
      UPDATE free_agent_draft_nomination_queue
      SET resolution_rollover_id = @resolutionRolloverId,
          status = 'opened',
          opened_auction_id = @auctionId,
          opened_starter_bid_id = @starterBidId,
          opened_at_ms = @openingAtMs,
          terminal_at_ms = @activatedAtMs,
          validation_code = NULL,
          updated_at_ms = @activatedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @queueId
        AND player_id = @playerId
        AND target_opening_rollover_id = @openingRolloverId
        AND status = 'queued'
        AND version = @expectedQueueVersion
    `);
    invalidateQueueStatement = database.prepare(`
      UPDATE free_agent_draft_nomination_queue
      SET status = 'invalid',
          terminal_at_ms = @activatedAtMs,
          validation_code = '${PLAYER_UNAVAILABLE}',
          updated_at_ms = @activatedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @queueId
        AND player_id = @playerId
        AND target_opening_rollover_id = @openingRolloverId
        AND status = 'queued'
        AND resolution_rollover_id IS NULL
        AND opened_auction_id IS NULL
        AND opened_starter_bid_id IS NULL
        AND opened_at_ms IS NULL
        AND terminal_at_ms IS NULL
        AND validation_code IS NULL
        AND version = @expectedQueueVersion
    `);
    resolveRecoveryStatement = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = NULL,
          resolved_by_membership_id = NULL,
          resolved_authority = 'system',
          updated_at_ms = @activatedAtMs,
          resolved_at_ms = @activatedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @sourceRecoveryId
        AND nomination_queue_id = @queueId
        AND player_id = @playerId
        AND allocation_id IS NULL
        AND rollover_id = @openingRolloverId
        AND auction_id IS NULL
        AND job_run_id = @runId
        AND kind = 'queued_nomination_activation'
        AND status = 'running'
        AND resolved_at_ms IS NULL
        AND updated_at_ms <= @activatedAtMs
    `);
    succeedJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @activatedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @activatedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @openingAtMs
        AND status = 'running'
        AND attempt_count >= 1
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms = @leaseExpiresAtMs
        AND lease_expires_at_ms > @activatedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedJobVersion
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
        @recoveryId, @leagueId, @seasonId, @fadId, @playerId,
        NULL, @openingRolloverId, NULL, @runId,
        'queued_nomination_activation', 'correction_required',
        @openingAtMs, NULL, @errorCode, NULL, @runId,
        NULL, NULL, NULL, @failedAtMs, @failedAtMs,
        NULL, 1, @queueId
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
        AND nomination_queue_id = @queueId
        AND player_id = @playerId
        AND allocation_id IS NULL
        AND rollover_id = @openingRolloverId
        AND auction_id IS NULL
        AND job_run_id = @runId
        AND kind = 'queued_nomination_activation'
        AND status = 'running'
        AND created_by_operation_id = @runId
        AND earliest_activation_at_ms = @openingAtMs
        AND target_resolution_at_ms IS NULL
        AND resolved_by_user_id IS NULL
        AND resolved_by_membership_id IS NULL
        AND resolved_authority IS NULL
        AND resolved_at_ms IS NULL
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
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @openingAtMs
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
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftQueuedNominationActivationWriter",
      tableName: "free_agent_draft_nomination_queue",
    });
  }

  function currentProtectedUserIds(leagueId, occurredAtMs) {
    const commissioner = uniqueRow(
      findProtectedCommissionerStatement,
      { leagueId, occurredAtMs },
      "The current protected FAD commissioner"
    );
    const userIds = new Set(
      listProtectedAdministratorsStatement
        .all({ leagueId, occurredAtMs })
        .map(({ user_id: userId }) => userId)
    );
    if (commissioner) userIds.add(commissioner.user_id);
    const result = [...userIds].sort();
    if (result.some((userId) => !UUID_PATTERN.test(userId))) {
      incompatible(
        "The current protected FAD authority is malformed.",
        "PROTECTED_AUTHORITY_INVALID"
      );
    }
    return Object.freeze(result);
  }

  function queueAudiences(leagueId, teamId, occurredAtMs) {
    return Object.freeze([
      Object.freeze({ kind: "team", teamId }),
      ...currentProtectedUserIds(leagueId, occurredAtMs).map((userId) =>
        Object.freeze({ kind: "user", userId })
      ),
    ]);
  }

  function persistedQueueAudiences(
    leagueId,
    outboxEventId,
    teamId
  ) {
    const rows = listOutboxAudiencesStatement.all({
      leagueId,
      outboxEventId,
    });
    const teamRows = rows.filter(
      ({ audience_kind: kind }) => kind === "team"
    );
    const userRows = rows.filter(
      ({ audience_kind: kind }) => kind === "user"
    );
    const userIds = userRows.map(({ user_id: userId }) => userId);
    if (
      rows.length < 1 ||
      teamRows.length !== 1 ||
      teamRows[0].team_id !== teamId ||
      teamRows[0].user_id !== null ||
      teamRows[0].id !== deterministicUuid(
        `${outboxEventId}:audience:team:${teamId}`
      ) ||
      userRows.some(
        (row) =>
          row.team_id !== null ||
          !UUID_PATTERN.test(row.user_id || "") ||
          row.id !== deterministicUuid(
            `${outboxEventId}:audience:user:${row.user_id}`
          )
      ) ||
      rows.some(
        ({ audience_kind: kind }) =>
          kind !== "team" && kind !== "user"
      ) ||
      new Set(userIds).size !== userIds.length
    ) {
      incompatible(
        "The persisted private nomination-queue audience is invalid.",
        "OUTBOX_AUDIENCE_INVALID"
      );
    }
    return Object.freeze([
      Object.freeze({ kind: "team", teamId }),
      ...userIds.sort().map((userId) =>
        Object.freeze({ kind: "user", userId })
      ),
    ]);
  }

  function writePublication({
    id,
    leagueId,
    eventType,
    aggregateType,
    aggregateId,
    version,
    reasonCode,
    occurredAtMs,
    related,
    audiences,
  }) {
    const result = outbox.write({
      id,
      leagueId,
      eventType,
      aggregateType,
      aggregateId,
      payload: createSocketEventMetadata({
        eventType,
        version,
        reasonCode,
        occurredAtMs,
        related,
      }),
      occurredAtMs,
      audiences,
    });
    if (result && typeof result.then === "function") {
      invalid(
        "Queued-nomination outbox writes must be synchronous.",
        "OUTBOX_WRITE_ASYNC"
      );
    }
  }

  function validatePublication({
    id,
    leagueId,
    eventType,
    aggregateType,
    aggregateId,
    version,
    reasonCode,
    occurredAtMs,
    related,
    audiences,
    expectedRelatedCount,
  }) {
    const event = uniqueRow(
      findOutboxEventStatement,
      { leagueId, outboxEventId: id },
      "The canonical queued-nomination outbox event"
    );
    const expectedPayload = JSON.stringify(
      createSocketEventEnvelope({
        eventId: id,
        type: eventType,
        leagueId,
        resourceId: aggregateId,
        version,
        reasonCode,
        occurredAt: occurredAtMs,
        related,
      })
    );
    if (
      !event ||
      event.league_id !== leagueId ||
      event.event_type !== eventType ||
      event.aggregate_type !== aggregateType ||
      event.aggregate_id !== aggregateId ||
      event.payload_json !== expectedPayload ||
      event.created_at_ms !== occurredAtMs
    ) {
      incompatible(
        "The canonical queued-nomination outbox event is split.",
        "OUTBOX_EVIDENCE_INVALID"
      );
    }

    const expectedAudiences = audiences
      .map((audience) => ({
        id:
          audience.kind === "league"
            ? id
            : deterministicUuid(
                `${id}:audience:${audience.kind}:` +
                `${audience.teamId || audience.userId}`
              ),
        audience_kind: audience.kind,
        team_id:
          audience.kind === "team" ? audience.teamId : null,
        user_id:
          audience.kind === "user" ? audience.userId : null,
        created_at_ms: occurredAtMs,
      }))
      .sort((left, right) => {
        const leftKey =
          `${left.audience_kind}:` +
          `${left.team_id || left.user_id || ""}`;
        const rightKey =
          `${right.audience_kind}:` +
          `${right.team_id || right.user_id || ""}`;
        return leftKey.localeCompare(rightKey);
      });
    const persistedAudiences = listOutboxAudiencesStatement.all({
      leagueId,
      outboxEventId: id,
    });
    if (
      persistedAudiences.length !== expectedAudiences.length ||
      persistedAudiences.some((audience, index) => {
        const expected = expectedAudiences[index];
        return (
          audience.id !== expected.id ||
          audience.audience_kind !== expected.audience_kind ||
          audience.team_id !== expected.team_id ||
          audience.user_id !== expected.user_id ||
          audience.created_at_ms !== expected.created_at_ms
        );
      }) ||
      countRelatedOutboxesAtStatement.get({
        leagueId,
        occurredAtMs,
        queueId: related.nominationQueueId,
      }).count !== expectedRelatedCount
    ) {
      incompatible(
        "The canonical queued-nomination outbox audience is split.",
        "OUTBOX_AUDIENCE_INVALID"
      );
    }
  }

  function writeTerminalPublications(row, response) {
    const privateRelated = createEmptySocketRelated({
      fadId: row.fad_id,
      teamId: row.team_id,
      nominationQueueId: row.queue_id,
    });
    writePublication({
      id: terminalQueueOutboxEventId(row.queue_id),
      leagueId: row.league_id,
      eventType: "fad_nomination_queue.changed",
      aggregateType: "fad_nomination_queue",
      aggregateId: row.queue_id,
      version: response.queueVersion,
      reasonCode: "nomination_opened",
      occurredAtMs: response.activatedAtMs,
      related: privateRelated,
      audiences: queueAudiences(
        row.league_id,
        row.team_id,
        response.activatedAtMs
      ),
    });
    if (response.outcome !== "opened") return;
    writePublication({
      id: openedAuctionOutboxEventId(response.auctionId),
      leagueId: row.league_id,
      eventType: "auction.changed",
      aggregateType: "auction",
      aggregateId: response.auctionId,
      version: 1,
      reasonCode: "auction_changed",
      occurredAtMs: response.activatedAtMs,
      related: createEmptySocketRelated({
        fadId: row.fad_id,
        teamId: row.team_id,
        auctionId: response.auctionId,
        nominationQueueId: row.queue_id,
      }),
      audiences: [Object.freeze({ kind: "league" })],
    });
  }

  function validateTerminalPublications(
    row,
    response,
    { currentAudienceRequired = false } = {}
  ) {
    const expectedRelatedCount =
      response.outcome === "opened" ? 2 : 1;
    const privateOutboxEventId = terminalQueueOutboxEventId(
      row.queue_id
    );
    validatePublication({
      id: privateOutboxEventId,
      leagueId: row.league_id,
      eventType: "fad_nomination_queue.changed",
      aggregateType: "fad_nomination_queue",
      aggregateId: row.queue_id,
      version: response.queueVersion,
      reasonCode: "nomination_opened",
      occurredAtMs: response.activatedAtMs,
      related: createEmptySocketRelated({
        fadId: row.fad_id,
        teamId: row.team_id,
        nominationQueueId: row.queue_id,
      }),
      audiences: currentAudienceRequired
        ? queueAudiences(
            row.league_id,
            row.team_id,
            response.activatedAtMs
          )
        : persistedQueueAudiences(
            row.league_id,
            privateOutboxEventId,
            row.team_id
          ),
      expectedRelatedCount,
    });
    if (response.outcome !== "opened") return;
    validatePublication({
      id: openedAuctionOutboxEventId(response.auctionId),
      leagueId: row.league_id,
      eventType: "auction.changed",
      aggregateType: "auction",
      aggregateId: response.auctionId,
      version: 1,
      reasonCode: "auction_changed",
      occurredAtMs: response.activatedAtMs,
      related: createEmptySocketRelated({
        fadId: row.fad_id,
        teamId: row.team_id,
        auctionId: response.auctionId,
        nominationQueueId: row.queue_id,
      }),
      audiences: [Object.freeze({ kind: "league" })],
      expectedRelatedCount,
    });
  }

  function readActivation(scope) {
    return uniqueRow(
      activationStatement,
      scope,
      "The queued-nomination activation binding"
    );
  }

  function readRecovery(scope) {
    return uniqueRow(
      recoveryStatement,
      scope,
      "The queued-nomination activation recovery"
    );
  }

  function validateJobShape(row) {
    if (
      !Number.isSafeInteger(row.job_attempt_count) ||
      row.job_attempt_count < 0 ||
      !Number.isSafeInteger(row.job_version) ||
      row.job_version < 1 ||
      row.job_created_at_ms !== row.accepted_at_ms ||
      row.job_updated_at_ms < row.job_created_at_ms
    ) {
      return false;
    }
    if (row.job_status === "pending") {
      return (
        row.job_lease_owner === null &&
        row.job_lease_token === null &&
        row.job_lease_expires_at_ms === null &&
        row.job_started_at_ms === null &&
        row.job_completed_at_ms === null &&
        row.job_result_json === null &&
        row.job_last_error_code === null &&
        (
          row.job_next_attempt_at_ms === null ||
          (
            Number.isSafeInteger(row.job_next_attempt_at_ms) &&
            row.job_next_attempt_at_ms === row.job_updated_at_ms
          )
        )
      );
    }
    if (["leased", "running"].includes(row.job_status)) {
      return (
        row.job_attempt_count >= 1 &&
        typeof row.job_lease_owner === "string" &&
        typeof row.job_lease_token === "string" &&
        Number.isSafeInteger(row.job_lease_expires_at_ms) &&
        (
          row.job_status === "leased"
            ? row.job_started_at_ms === null
            : (
                Number.isSafeInteger(row.job_started_at_ms) &&
                row.job_updated_at_ms === row.job_started_at_ms
              )
        ) &&
        row.job_completed_at_ms === null &&
        row.job_result_json === null &&
        row.job_last_error_code === null &&
        row.job_next_attempt_at_ms === null
      );
    }
    if (row.job_status === "failed") {
      return (
        row.job_attempt_count >= 1 &&
        row.job_lease_owner === null &&
        row.job_lease_token === null &&
        row.job_lease_expires_at_ms === null &&
        Number.isSafeInteger(row.job_started_at_ms) &&
        Number.isSafeInteger(row.job_completed_at_ms) &&
        row.job_completed_at_ms >= row.job_started_at_ms &&
        row.job_updated_at_ms === row.job_completed_at_ms &&
        row.job_result_json === null &&
        row.job_last_error_code ===
          FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE &&
        row.job_next_attempt_at_ms === null
      );
    }
    if (row.job_status === "succeeded") {
      return (
        row.job_attempt_count >= 1 &&
        row.job_lease_owner === null &&
        row.job_lease_token === null &&
        row.job_lease_expires_at_ms === null &&
        Number.isSafeInteger(row.job_started_at_ms) &&
        Number.isSafeInteger(row.job_completed_at_ms) &&
        row.job_completed_at_ms >= row.job_started_at_ms &&
        row.job_updated_at_ms === row.job_completed_at_ms &&
        typeof row.job_result_json === "string" &&
        row.job_last_error_code === null &&
        row.job_next_attempt_at_ms === null
      );
    }
    return false;
  }

  function validateCore(row, scope) {
    if (!row) return null;
    if (
      row.league_id !== scope.leagueId ||
      row.season_id !== scope.seasonId ||
      row.fad_id !== scope.fadId ||
      row.queue_id !== scope.queueId ||
      row.source_rollover_id !==
        row.target_opening_rollover_id ||
      row.target_opening_rollover_id !==
        (scope.openingRolloverId ||
          row.target_opening_rollover_id) ||
      row.opening_rolls_over_at_ms !== scope.openingAtMs ||
      (scope.playerId !== undefined &&
        row.player_id !== scope.playerId) ||
      row.binding_illegality_confirmed !== 1 ||
      row.binding_confirmed_at_ms !== row.accepted_at_ms ||
      row.queue_created_at_ms !== row.accepted_at_ms ||
      row.opening_aav_cents !== roundedAav(
        row.opening_total_value_cents,
        row.opening_term_years
      ) ||
      !Number.isSafeInteger(row.opening_total_value_cents) ||
      row.opening_total_value_cents < 1 ||
      !Number.isSafeInteger(row.opening_term_years) ||
      row.opening_term_years < 1 ||
      row.opening_term_years > 3 ||
      row.accepted_at_ms < row.creation_cutoff_at_ms ||
      row.accepted_at_ms >= row.opening_rolls_over_at_ms ||
      row.request_actor_user_id !== row.submitted_by_user_id ||
      row.membership_user_id !== row.submitted_by_user_id ||
      row.request_operation !== "auction.start" ||
      row.request_status !== "completed" ||
      row.request_result_type !== "fad_nomination_queue" ||
      row.request_result_id !== row.queue_id ||
      row.request_created_at_ms !== row.accepted_at_ms ||
      row.request_completed_at_ms !== row.accepted_at_ms ||
      row.request_expires_at_ms <= row.accepted_at_ms ||
      row.job_run_id !== (scope.runId || row.job_run_id) ||
      row.job_type !== JOB_TYPE ||
      row.occurrence_key !== scope.occurrenceKey ||
      row.scheduled_for_ms !== scope.openingAtMs ||
      !Number.isSafeInteger(row.opening_sequence) ||
      row.opening_sequence < 1 ||
      !["initial", "extension"].includes(row.opening_window_kind) ||
      row.opening_opens_at_ms !==
        row.opening_rolls_over_at_ms - DAY_MS ||
      row.creation_cutoff_at_ms !==
        row.opening_rolls_over_at_ms - HOUR_MS ||
      !Number.isSafeInteger(row.queue_version) ||
      row.queue_version < 1 ||
      !Number.isSafeInteger(row.candidate_card_version_observed) ||
      row.candidate_card_version_observed < 1 ||
      !Number.isSafeInteger(row.team_version_observed) ||
      row.team_version_observed < 1 ||
      !validateJobShape(row)
    ) {
      incompatible(
        "The queued-nomination activation binding is malformed or split.",
        "ACTIVATION_BINDING_INVALID"
      );
    }
    const queuedShape =
      row.queue_status === "queued" &&
      row.resolution_rollover_id === null &&
      row.opened_auction_id === null &&
      row.opened_starter_bid_id === null &&
      row.opened_at_ms === null &&
      row.terminal_at_ms === null &&
      row.validation_code === null;
    const openedShape =
      row.queue_status === "opened" &&
      UUID_PATTERN.test(row.resolution_rollover_id || "") &&
      UUID_PATTERN.test(row.opened_auction_id || "") &&
      UUID_PATTERN.test(row.opened_starter_bid_id || "") &&
      row.opened_at_ms === row.opening_rolls_over_at_ms &&
      Number.isSafeInteger(row.terminal_at_ms) &&
      row.validation_code === null;
    const invalidShape =
      row.queue_status === "invalid" &&
      row.resolution_rollover_id === null &&
      row.opened_auction_id === null &&
      row.opened_starter_bid_id === null &&
      row.opened_at_ms === null &&
      Number.isSafeInteger(row.terminal_at_ms) &&
      row.validation_code === PLAYER_UNAVAILABLE;
    if (!queuedShape && !openedShape && !invalidShape) {
      incompatible(
        "The nomination queue terminal shape is invalid.",
        "QUEUE_STATE_INVALID"
      );
    }
    if (
      (
        queuedShape &&
        row.job_status === "succeeded"
      ) ||
      (
        (openedShape || invalidShape) &&
        row.job_status !== "succeeded"
      )
    ) {
      incompatible(
        "The nomination queue and activation job disagree.",
        "QUEUE_JOB_STATE_INVALID"
      );
    }
    return row;
  }

  function validateRecovery(row, activation) {
    if (!row) return null;
    if (
      row.league_id !== activation.league_id ||
      row.season_id !== activation.season_id ||
      row.fad_id !== activation.fad_id ||
      row.player_id !== activation.player_id ||
      row.allocation_id !== null ||
      row.rollover_id !==
        activation.target_opening_rollover_id ||
      row.auction_id !== null ||
      row.job_run_id !== activation.job_run_id ||
      row.nomination_queue_id !== activation.queue_id ||
      row.kind !== "queued_nomination_activation" ||
      !["running", "resolved", "correction_required"].includes(
        row.status
      ) ||
      row.earliest_activation_at_ms !==
        activation.opening_rolls_over_at_ms ||
      row.target_resolution_at_ms !== null ||
      row.created_by_operation_id !== activation.job_run_id ||
      row.resolved_by_user_id !== null ||
      row.resolved_by_membership_id !== null ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      row.updated_at_ms < row.created_at_ms ||
      (
        row.status === "resolved"
          ? (
              row.last_error_code !== null ||
              row.resolved_authority !== "system" ||
              row.resolved_at_ms !== row.updated_at_ms
            )
          : (
              row.last_error_code !==
                FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE ||
              row.resolved_authority !== null ||
              row.resolved_at_ms !== null
            )
      )
    ) {
      incompatible(
        "The queued-nomination recovery binding is malformed.",
        "RECOVERY_BINDING_INVALID"
      );
    }
    return row;
  }

  function projection(row, recovery) {
    return deepFreeze({
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      queueId: row.queue_id,
      playerId: row.player_id,
      openingRolloverId: row.target_opening_rollover_id,
      openingAtMs: row.opening_rolls_over_at_ms,
      status: row.queue_status,
      queueVersion: row.queue_version,
      activationJobRunId: row.job_run_id,
      activationOccurrenceKey: row.occurrence_key,
      jobStatus: row.job_status,
      jobRunVersion: row.job_version,
      resolutionRolloverId: row.resolution_rollover_id,
      auctionId: row.opened_auction_id,
      starterBidId: row.opened_starter_bid_id,
      recoveryId: recovery?.id || null,
      recoveryStatus: recovery?.status || null,
      recoveryVersion: recovery?.version || null,
    });
  }

  function validateLiveFence(row, command, terminalAtMs) {
    if (
      row.queue_status !== "queued" ||
      row.queue_version !== command.expectedQueueVersion ||
      row.player_id !== command.playerId ||
      row.target_opening_rollover_id !==
        command.openingRolloverId ||
      row.job_run_id !== command.runId ||
      row.job_status !== "running" ||
      row.job_version !== command.expectedJobVersion ||
      row.job_attempt_count < 1 ||
      row.job_lease_owner !== command.leaseOwner ||
      row.job_lease_token !== command.leaseToken ||
      row.job_lease_expires_at_ms !==
        command.leaseExpiresAtMs ||
      row.job_lease_expires_at_ms <= terminalAtMs ||
      !Number.isSafeInteger(row.job_started_at_ms) ||
      row.job_started_at_ms < command.openingAtMs ||
      row.job_started_at_ms > terminalAtMs ||
      row.job_updated_at_ms !== row.job_started_at_ms ||
      row.job_completed_at_ms !== null ||
      row.job_result_json !== null ||
      row.job_last_error_code !== null ||
      row.job_next_attempt_at_ms !== null
    ) {
      conflict(
        "The queued nomination or live activation lease changed.",
        "ACTIVATION_FENCE_CHANGED"
      );
    }
  }

  function validateCurrentLifecycle(row, command, recovery) {
    if (command.activatedAtMs < command.openingAtMs) {
      conflict(
        "The queued nomination is not due to open.",
        "ACTIVATION_NOT_DUE"
      );
    }
    if (command.activatedAtMs >= command.openingAtMs + DAY_MS) {
      conflict(
        "The queued nomination can no longer receive a full auction window.",
        "ACTIVATION_WINDOW_CLOSED"
      );
    }
    if (
      row.league_status !== "active" ||
      row.current_season_id !== command.seasonId ||
      row.season_status !== "active" ||
      row.fad_status !== "rapid" ||
      row.team_status !== "active" ||
      row.fad_team_participating !== 1 ||
      !["scheduled", "processing", "recovery_required"].includes(
        row.opening_status
      )
    ) {
      conflict(
        "The queued-nomination lifecycle is no longer eligible for activation.",
        "ACTIVATION_LIFECYCLE_CHANGED"
      );
    }
    if (
      (
        recovery &&
        recovery.status !== "running"
      ) ||
      (
        row.opening_status === "recovery_required" &&
        !recovery
      )
    ) {
      conflict(
        "The queued-nomination recovery must be explicitly resumed.",
        "ACTIVATION_RECOVERY_NOT_RUNNING"
      );
    }
  }

  function currentPlayerAvailability(command) {
    const player = uniqueRow(
      playerStatement,
      command,
      "The queued-nomination player"
    );
    const corrections = positionCorrectionStatement.all(command);
    if (corrections.length > 1) {
      incompatible(
        "The queued-nomination player has ambiguous current position corrections.",
        "PLAYER_POSITION_AMBIGUOUS"
      );
    }
    const sourcePositions = sourcePositionsStatement.all(command);
    const positionGroup = corrections.length === 1
      ? corrections[0].position_group
      : sourcePositions.length === 1
        ? sourcePositions[0].position_group
        : null;
    const owned = Boolean(ownershipStatement.get(command));
    const activeAuction = Boolean(
      activeAuctionStatement.get(command)
    );
    const released = Boolean(releasedRightsStatement.get(command));
    return Object.freeze({
      available:
        player?.status === "active" &&
        ["F", "D"].includes(positionGroup) &&
        !released &&
        !owned &&
        !activeAuction,
      positionGroup,
    });
  }

  function readSuccessor(row, { fresh = true } = {}) {
    const successor = uniqueRow(
      successorStatement,
      {
        leagueId: row.league_id,
        seasonId: row.season_id,
        fadId: row.fad_id,
        openingRolloverId: row.target_opening_rollover_id,
      },
      "The queued-nomination resolution rollover"
    );
    if (!successor) return null;
    if (
      successor.sequence !== row.opening_sequence + 1 ||
      successor.opens_at_ms !== row.opening_rolls_over_at_ms ||
      successor.creation_cutoff_at_ms !==
        successor.rolls_over_at_ms - HOUR_MS ||
      successor.rolls_over_at_ms !==
        row.opening_rolls_over_at_ms + DAY_MS ||
      (
        fresh
          ? successor.status !== "scheduled"
          : ![
              "scheduled",
              "processing",
              "completed",
              "recovery_required",
            ].includes(successor.status)
      )
    ) {
      conflict(
        "The queued-nomination resolution rollover is not a pristine contiguous window.",
        "RESOLUTION_ROLLOVER_CHANGED"
      );
    }
    return successor;
  }

  function createIdentityFactory() {
    const issued = new Set();
    return (description) => {
      const id = createId(description);
      canonicalId(id, description);
      if (issued.has(id)) {
        invalid(
          "Queued-nomination activation identifier factories must return unique identifiers.",
          "IDENTIFIER_COLLISION"
        );
      }
      issued.add(id);
      return id;
    };
  }

  function responseProjection(command, {
    outcome,
    queueVersion,
    resolutionRolloverId,
    resolvesAtMs,
    auctionId,
    starterBidId,
    drawId,
    resolutionJobRunId,
    validationCode,
    sourceRecoveryId,
    auctionEventId,
    extensionRolloverId,
  }) {
    return deepFreeze({
      outcome,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      queueId: command.queueId,
      openingRolloverId: command.openingRolloverId,
      resolutionRolloverId,
      openingAtMs: command.openingAtMs,
      activatedAtMs: command.activatedAtMs,
      resolvesAtMs,
      queueVersion,
      auctionId,
      starterBidId,
      drawId,
      resolutionJobRunId,
      validationCode,
      jobRunId: command.runId,
      jobRunVersion: command.expectedJobVersion + 1,
      sourceRecoveryId,
      evidence: {
        auctionEventId,
        extensionRolloverId,
      },
    });
  }

  function storedResult(command, response) {
    return serializeCanonicalJsonV1({
      schemaVersion: 1,
      operation: OPERATION,
      identity: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        queueId: command.queueId,
        openingRolloverId: command.openingRolloverId,
        openingAtMs: command.openingAtMs,
        occurrenceKey: command.occurrenceKey,
        jobRunId: command.runId,
      },
      request: {
        expectedQueueVersion: command.expectedQueueVersion,
        expectedJobVersion: command.expectedJobVersion,
        activatedAtMs: command.activatedAtMs,
      },
      response,
    });
  }

  function validateResponseShape(response) {
    try {
      exactObject(
        response,
        RESPONSE_FIELDS,
        "stored queued-nomination activation response"
      );
      exactObject(
        response.evidence,
        EVIDENCE_FIELDS,
        "stored queued-nomination activation evidence"
      );
    } catch (error) {
      incompatible(
        "The stored queued-nomination activation response shape is invalid.",
        "STORED_RESULT_INVALID",
        error
      );
    }
    const opened = response.outcome === "opened";
    const invalidOutcome = response.outcome === "invalid";
    if (
      (!opened && !invalidOutcome) ||
      !UUID_PATTERN.test(response.leagueId || "") ||
      !UUID_PATTERN.test(response.seasonId || "") ||
      !UUID_PATTERN.test(response.fadId || "") ||
      !UUID_PATTERN.test(response.queueId || "") ||
      !UUID_PATTERN.test(response.openingRolloverId || "") ||
      !UUID_PATTERN.test(response.jobRunId || "") ||
      !Number.isSafeInteger(response.openingAtMs) ||
      !Number.isSafeInteger(response.activatedAtMs) ||
      !Number.isSafeInteger(response.queueVersion) ||
      response.queueVersion < 2 ||
      !Number.isSafeInteger(response.jobRunVersion) ||
      response.jobRunVersion < 2 ||
      (
        response.sourceRecoveryId !== null &&
        !UUID_PATTERN.test(response.sourceRecoveryId || "")
      ) ||
      (
        opened
          ? (
              !UUID_PATTERN.test(response.resolutionRolloverId || "") ||
              !Number.isSafeInteger(response.resolvesAtMs) ||
              !UUID_PATTERN.test(response.auctionId || "") ||
              !UUID_PATTERN.test(response.starterBidId || "") ||
              !UUID_PATTERN.test(response.drawId || "") ||
              !UUID_PATTERN.test(response.resolutionJobRunId || "") ||
              response.validationCode !== null ||
              !UUID_PATTERN.test(
                response.evidence.auctionEventId || ""
              ) ||
              (
                response.evidence.extensionRolloverId !== null &&
                !UUID_PATTERN.test(
                  response.evidence.extensionRolloverId || ""
                )
              )
            )
          : (
              response.resolutionRolloverId !== null ||
              response.resolvesAtMs !== null ||
              response.auctionId !== null ||
              response.starterBidId !== null ||
              response.drawId !== null ||
              response.resolutionJobRunId !== null ||
              response.validationCode !== PLAYER_UNAVAILABLE ||
              response.evidence.auctionEventId !== null ||
              response.evidence.extensionRolloverId !== null
            )
      )
    ) {
      incompatible(
        "The stored queued-nomination activation response is invalid.",
        "STORED_RESULT_INVALID"
      );
    }
    return response;
  }

  function validateStoredResult(scope, row) {
    if (
      row.job_status !== "succeeded" ||
      typeof row.job_result_json !== "string"
    ) {
      return null;
    }
    const stored = parseCanonical(
      row.job_result_json,
      "queued-nomination activation job result"
    );
    try {
      exactObject(
        stored,
        STORED_RESULT_FIELDS,
        "stored queued-nomination activation result"
      );
      exactObject(
        stored.identity,
        STORED_IDENTITY_FIELDS,
        "stored queued-nomination activation identity"
      );
      exactObject(
        stored.request,
        STORED_REQUEST_FIELDS,
        "stored queued-nomination activation request"
      );
    } catch (error) {
      incompatible(
        "The stored queued-nomination activation result shape is invalid.",
        "STORED_RESULT_INVALID",
        error
      );
    }
    const identity = stored.identity;
    const request = stored.request;
    if (
      stored.schemaVersion !== 1 ||
      stored.operation !== OPERATION ||
      identity.leagueId !== scope.leagueId ||
      identity.seasonId !== scope.seasonId ||
      identity.fadId !== scope.fadId ||
      identity.queueId !== scope.queueId ||
      identity.openingRolloverId !==
        row.target_opening_rollover_id ||
      identity.openingAtMs !== scope.openingAtMs ||
      identity.occurrenceKey !== scope.occurrenceKey ||
      identity.jobRunId !== row.job_run_id ||
      (
        scope.runId !== undefined &&
        identity.jobRunId !== scope.runId
      ) ||
      (
        scope.expectedQueueVersion !== undefined &&
        request.expectedQueueVersion !==
          scope.expectedQueueVersion
      ) ||
      (
        scope.expectedJobVersion !== undefined &&
        request.expectedJobVersion !==
          scope.expectedJobVersion
      ) ||
      !Number.isSafeInteger(request.activatedAtMs)
    ) {
      incompatible(
        "The stored queued-nomination activation result conflicts with its exact request.",
        "STORED_RESULT_CONFLICT"
      );
    }
    return Object.freeze({
      response: validateResponseShape(stored.response),
      resultJson: row.job_result_json,
      request,
    });
  }

  function parseStartMetadata(encoded) {
    let metadata;
    try {
      metadata = JSON.parse(encoded);
      const actual = Object.keys(metadata).sort();
      const expected = [
        "aavCents",
        "actorAuthority",
        "actorMembershipId",
        "bidClosesAtMs",
        "bindingIllegalityConfirmed",
        "creationCutoffAtMs",
        "fadId",
        "fadRolloverId",
        "openingTeamId",
        "playerPosition",
        "termYears",
        "totalValueCents",
      ].sort();
      if (
        !isPlainObject(metadata) ||
        actual.length !== expected.length ||
        actual.some((field, index) => field !== expected[index])
      ) {
        throw new TypeError("metadata shape");
      }
    } catch (error) {
      incompatible(
        "The queued-nomination auction-start event is malformed.",
        "START_EVENT_INVALID",
        error
      );
    }
    return metadata;
  }

  function validateReplay(
    row,
    stored,
    recovery,
    { currentAudienceRequired = false } = {}
  ) {
    const { response, resultJson, request } = stored;
    if (
      response.leagueId !== row.league_id ||
      response.seasonId !== row.season_id ||
      response.fadId !== row.fad_id ||
      response.queueId !== row.queue_id ||
      response.openingRolloverId !==
        row.target_opening_rollover_id ||
      response.openingAtMs !== row.opening_rolls_over_at_ms ||
      response.activatedAtMs !== request.activatedAtMs ||
      response.queueVersion !== row.queue_version ||
      response.jobRunId !== row.job_run_id ||
      response.jobRunVersion !== row.job_version ||
      row.job_completed_at_ms !== response.activatedAtMs ||
      row.job_result_json !== resultJson ||
      response.sourceRecoveryId !== (recovery?.id || null)
    ) {
      incompatible(
        "The queued-nomination replay evidence conflicts with its terminal aggregate.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    if (response.outcome === "invalid") {
      if (
        row.queue_status !== "invalid" ||
        row.terminal_at_ms !== response.activatedAtMs ||
        row.validation_code !== PLAYER_UNAVAILABLE ||
        recovery && recovery.status !== "resolved"
      ) {
        incompatible(
          "The invalid queued nomination lost its exact terminal evidence.",
          "REPLAY_EVIDENCE_INVALID"
        );
      }
      validateTerminalPublications(row, response, {
        currentAudienceRequired,
      });
      return deepFreeze({ ...response, replayed: true });
    }

    if (
      row.queue_status !== "opened" ||
      row.resolution_rollover_id !==
        response.resolutionRolloverId ||
      row.opened_auction_id !== response.auctionId ||
      row.opened_starter_bid_id !== response.starterBidId ||
      row.opened_at_ms !== response.openingAtMs ||
      row.terminal_at_ms !== response.activatedAtMs ||
      recovery && recovery.status !== "resolved"
    ) {
      incompatible(
        "The opened queued nomination lost its exact terminal evidence.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    const successor = readSuccessor(row, { fresh: false });
    if (
      !successor ||
      successor.id !== response.resolutionRolloverId ||
      successor.rolls_over_at_ms !== response.resolvesAtMs
    ) {
      incompatible(
        "The queued-nomination resolution rollover conflicts with replay.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    if (
      response.evidence.extensionRolloverId !== null &&
      (
        response.evidence.extensionRolloverId !== successor.id ||
        successor.window_kind !== "extension" ||
        successor.extension_reason !== "queued_nomination" ||
        successor.extension_source_id !== row.queue_id
      )
    ) {
      incompatible(
        "The queued-nomination extension evidence conflicts with replay.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    const artifact = uniqueRow(
      artifactStatement,
      {
        leagueId: row.league_id,
        seasonId: row.season_id,
        auctionId: response.auctionId,
        starterBidId: response.starterBidId,
        auctionEventId: response.evidence.auctionEventId,
        drawId: response.drawId,
        resolutionJobRunId: response.resolutionJobRunId,
      },
      "The queued-nomination opened-auction evidence"
    );
    if (!artifact) {
      incompatible(
        "The queued-nomination opened-auction evidence is unavailable.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    const metadata = parseStartMetadata(artifact.metadata_json);
    let commitmentHex;
    try {
      commitmentHex =
        createFreeAgentDraftAuctionDrawCommitment({
          auctionId: response.auctionId,
          nonceBytes: artifact.nonce_bytes,
        }).commitmentHex;
    } catch (error) {
      incompatible(
        "The queued-nomination private draw is malformed.",
        "REPLAY_EVIDENCE_INVALID",
        error
      );
    }
    if (
      artifact.player_id !== row.player_id ||
      artifact.opened_at_ms !== response.openingAtMs ||
      artifact.resolves_at_ms !== response.resolvesAtMs ||
      artifact.opened_by_user_id !== row.submitted_by_user_id ||
      artifact.auction_created_at_ms !== response.openingAtMs ||
      artifact.context_id !== response.auctionId ||
      artifact.source_kind !== "fad_open_rapid" ||
      artifact.context_fad_id !== row.fad_id ||
      artifact.fad_rollover_id !== response.resolutionRolloverId ||
      artifact.fad_allocation_id !== null ||
      artifact.fad_origin !== "queued_nomination" ||
      artifact.context_created_at_ms !== response.openingAtMs ||
      artifact.starter_team_id !== row.team_id ||
      artifact.submitted_by_user_id !== row.submitted_by_user_id ||
      artifact.first_submitted_at_ms !== row.accepted_at_ms ||
      artifact.idempotency_request_id !==
        row.acceptance_idempotency_request_id ||
      artifact.event_bid_id !== response.starterBidId ||
      artifact.event_team_id !== row.team_id ||
      artifact.event_actor_user_id !== row.submitted_by_user_id ||
      artifact.event_type !== "auction_started" ||
      artifact.occurred_at_ms !== response.openingAtMs ||
      metadata.openingTeamId !== row.team_id ||
      metadata.actorMembershipId !==
        row.submitted_by_membership_id ||
      metadata.actorAuthority !== "manager" ||
      !["F", "D"].includes(metadata.playerPosition) ||
      metadata.creationCutoffAtMs !== row.creation_cutoff_at_ms ||
      metadata.bidClosesAtMs !== response.resolvesAtMs ||
      metadata.totalValueCents !== row.opening_total_value_cents ||
      metadata.termYears !== row.opening_term_years ||
      metadata.aavCents !== row.opening_aav_cents ||
      metadata.bindingIllegalityConfirmed !== true ||
      metadata.fadId !== row.fad_id ||
      metadata.fadRolloverId !== response.resolutionRolloverId ||
      artifact.algorithm_version !== 1 ||
      !(artifact.nonce_bytes instanceof Uint8Array) ||
      artifact.nonce_bytes.byteLength !== 32 ||
      artifact.commitment_hex !== commitmentHex ||
      artifact.draw_created_at_ms !== response.openingAtMs ||
      ![1, 2].includes(artifact.draw_version) ||
      artifact.resolution_job_type !== RESOLUTION_JOB_TYPE ||
      artifact.resolution_occurrence_key !==
        `auction:${response.auctionId}:${response.resolvesAtMs}` ||
      artifact.resolution_scheduled_for_ms !== response.resolvesAtMs ||
      artifact.resolution_created_at_ms !== response.activatedAtMs
    ) {
      incompatible(
        "The queued-nomination opened-auction evidence conflicts with replay.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    validateTerminalPublications(row, response, {
      currentAudienceRequired,
    });
    return deepFreeze({ ...response, replayed: true });
  }

  function invokeBeforeCommit(operation, command, result) {
    if (!beforeCommit) return;
    const returned = beforeCommit({ operation, command, result });
    if (returned && typeof returned.then === "function") {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.transactionAsync,
        "Queued-nomination activation beforeCommit must be synchronous."
      );
    }
  }

  const executeTransaction = database.transaction((command) => {
    const row = validateCore(readActivation(command), command);
    if (!row) {
      notFound(
        "The exact queued-nomination activation binding was not found.",
        "ACTIVATION_NOT_FOUND"
      );
    }
    const recovery = validateRecovery(readRecovery(command), row);
    if (row.job_status === "succeeded") {
      const stored = validateStoredResult(command, row);
      return validateReplay(row, stored, recovery);
    }
    validateLiveFence(row, command, command.activatedAtMs);
    validateCurrentLifecycle(row, command, recovery);
    if (
      starterUseStatement.get({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        acceptanceIdempotencyRequestId:
          row.acceptance_idempotency_request_id,
      })
    ) {
      conflict(
        "The queued nomination already has premature auction artifacts.",
        "ACTIVATION_ARTIFACTS_NOT_PRISTINE"
      );
    }
    const availability = currentPlayerAvailability(command);
    const sourceRecoveryId = recovery?.id || null;
    let response;

    if (!availability.available) {
      response = responseProjection(command, {
        outcome: "invalid",
        queueVersion: command.expectedQueueVersion + 1,
        resolutionRolloverId: null,
        resolvesAtMs: null,
        auctionId: null,
        starterBidId: null,
        drawId: null,
        resolutionJobRunId: null,
        validationCode: PLAYER_UNAVAILABLE,
        sourceRecoveryId,
        auctionEventId: null,
        extensionRolloverId: null,
      });
      if (invalidateQueueStatement.run(command).changes !== 1) {
        conflict(
          "The queued nomination changed before invalidation committed.",
          "QUEUE_CAS_FAILED"
        );
      }
    } else {
      let successor = readSuccessor(row);
      const id = createIdentityFactory();
      let extensionRolloverId = null;
      if (!successor) {
        if (row.opening_sequence < 7) {
          conflict(
            "The queued nomination is missing its required initial successor rollover.",
            "RESOLUTION_ROLLOVER_MISSING"
          );
        }
        extensionRolloverId = id(
          "queued-nomination extension rollover"
        );
        const rolloverWrite = {
          ...command,
          resolutionRolloverId: extensionRolloverId,
          resolutionSequence: row.opening_sequence + 1,
          resolutionCreationCutoffAtMs:
            command.openingAtMs + DAY_MS - HOUR_MS,
          resolvesAtMs: command.openingAtMs + DAY_MS,
        };
        insertExtensionStatement.run(rolloverWrite);
        successor = readSuccessor(row);
        if (!successor || successor.id !== extensionRolloverId) {
          incompatible(
            "The queued-nomination extension rollover was not persisted exactly.",
            "EXTENSION_POSTCONDITION_FAILED"
          );
        }
      } else if (
        successor.window_kind === "extension" &&
        successor.extension_reason === "queued_nomination" &&
        successor.extension_source_id === command.queueId
      ) {
        extensionRolloverId = successor.id;
      }

      const auctionId = id("queued-nomination auction");
      const drawId = id("queued-nomination private draw");
      const starterBidId = id("queued-nomination starter bid");
      const auctionEventId = id(
        "queued-nomination auction-start event"
      );
      const resolutionJobRunId = id(
        "queued-nomination auction-resolution job"
      );
      let nonceBytes = createDrawNonce({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        queueId: command.queueId,
        auctionId,
      });
      if (
        !(nonceBytes instanceof Uint8Array) ||
        nonceBytes.byteLength !== 32
      ) {
        invalid(
          "Queued-nomination draw nonce factories must return exactly 32 bytes.",
          "DRAW_NONCE_INVALID"
        );
      }
      nonceBytes = Buffer.from(nonceBytes);
      const commitmentHex =
        createFreeAgentDraftAuctionDrawCommitment({
          auctionId,
          nonceBytes,
        }).commitmentHex;
      const write = {
        ...command,
        resolutionRolloverId: successor.id,
        resolvesAtMs: successor.rolls_over_at_ms,
        auctionId,
        drawId,
        starterBidId,
        auctionEventId,
        resolutionJobRunId,
        submittedByUserId: row.submitted_by_user_id,
        submittedByMembershipId:
          row.submitted_by_membership_id,
        teamId: row.team_id,
        totalValueCents: row.opening_total_value_cents,
        termYears: row.opening_term_years,
        aavCents: row.opening_aav_cents,
        acceptedAtMs: row.accepted_at_ms,
        acceptanceIdempotencyRequestId:
          row.acceptance_idempotency_request_id,
        nonceBytes,
        commitmentHex,
        resolutionOccurrenceKey:
          `auction:${auctionId}:${successor.rolls_over_at_ms}`,
        metadataJson: JSON.stringify({
          openingTeamId: row.team_id,
          actorMembershipId: row.submitted_by_membership_id,
          actorAuthority: "manager",
          playerPosition: availability.positionGroup,
          creationCutoffAtMs: row.creation_cutoff_at_ms,
          bidClosesAtMs: successor.rolls_over_at_ms,
          totalValueCents: row.opening_total_value_cents,
          termYears: row.opening_term_years,
          aavCents: row.opening_aav_cents,
          bindingIllegalityConfirmed: true,
          fadId: row.fad_id,
          fadRolloverId: successor.id,
        }),
      };
      insertAuctionStatement.run(write);
      insertContextStatement.run(write);
      insertDrawStatement.run(write);
      insertBidStatement.run(write);
      insertEventStatement.run(write);
      insertResolutionJobStatement.run(write);
      if (openQueueStatement.run(write).changes !== 1) {
        conflict(
          "The queued nomination changed before opening committed.",
          "QUEUE_CAS_FAILED"
        );
      }
      response = responseProjection(command, {
        outcome: "opened",
        queueVersion: command.expectedQueueVersion + 1,
        resolutionRolloverId: successor.id,
        resolvesAtMs: successor.rolls_over_at_ms,
        auctionId,
        starterBidId,
        drawId,
        resolutionJobRunId,
        validationCode: null,
        sourceRecoveryId,
        auctionEventId,
        extensionRolloverId,
      });
    }

    writeTerminalPublications(row, response);

    if (recovery) {
      if (
        resolveRecoveryStatement.run({
          ...command,
          sourceRecoveryId: recovery.id,
        }).changes !== 1
      ) {
        conflict(
          "The queued-nomination recovery changed before it resolved.",
          "RECOVERY_RESOLUTION_CAS_FAILED"
        );
      }
    }
    const resultJson = storedResult(command, response);
    if (
      succeedJobStatement.run({
        ...command,
        resultJson,
      }).changes !== 1
    ) {
      conflict(
        "The queued-nomination activation lease changed before completion.",
        "JOB_TERMINAL_CAS_FAILED"
      );
    }
    invokeBeforeCommit("executeClaimed", command, response);
    const terminal = validateCore(readActivation(command), command);
    const terminalRecovery = validateRecovery(
      readRecovery(command),
      terminal
    );
    const stored = validateStoredResult(command, terminal);
    const replay = validateReplay(
      terminal,
      stored,
      terminalRecovery,
      { currentAudienceRequired: true }
    );
    return deepFreeze({
      ...replay,
      replayed: false,
    });
  });

  function failureProjection(command, recovery, replayed) {
    return deepFreeze({
      recorded: true,
      replayed,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      queueId: command.queueId,
      openingRolloverId: command.openingRolloverId,
      failedAtMs: command.failedAtMs,
      errorCode: command.errorCode,
      recoveryId: recovery.id,
      recoveryVersion: recovery.version,
      jobRunId: command.runId,
      jobRunVersion: command.expectedJobVersion + 1,
    });
  }

  function failureReplay(command, row, recovery) {
    if (row.job_status !== "failed") return null;
    if (
      !recovery ||
      recovery.status !== "correction_required" ||
      row.queue_status !== "queued" ||
      row.queue_version !== command.expectedQueueVersion ||
      row.job_version !== command.expectedJobVersion + 1 ||
      row.job_completed_at_ms !== command.failedAtMs ||
      row.job_updated_at_ms !== command.failedAtMs ||
      row.job_last_error_code !== command.errorCode ||
      recovery.updated_at_ms !== command.failedAtMs
    ) {
      incompatible(
        "The queued-nomination activation failure replay is split.",
        "FAILURE_REPLAY_INVALID"
      );
    }
    return failureProjection(command, recovery, true);
  }

  const failureTransaction = database.transaction((command) => {
    const row = validateCore(readActivation(command), command);
    if (!row) {
      notFound(
        "The exact queued-nomination activation binding was not found.",
        "ACTIVATION_NOT_FOUND"
      );
    }
    const recovery = validateRecovery(readRecovery(command), row);
    const replay = failureReplay(command, row, recovery);
    if (replay) return replay;
    if (row.job_status === "succeeded") {
      conflict(
        "The queued nomination already completed successfully.",
        "ACTIVATION_ALREADY_SUCCEEDED"
      );
    }
    validateLiveFence(row, command, command.failedAtMs);
    let recoveryId;
    if (!recovery) {
      recoveryId = createIdentityFactory()(
        "queued-nomination activation recovery"
      );
      insertRecoveryStatement.run({
        ...command,
        recoveryId,
      });
    } else {
      if (recovery.status !== "running") {
        conflict(
          "The queued-nomination recovery is not running for a repeat failure.",
          "RECOVERY_NOT_RUNNING"
        );
      }
      recoveryId = recovery.id;
      if (
        failRecoveryStatement.run({
          ...command,
          recoveryId,
          expectedRecoveryVersion: recovery.version,
        }).changes !== 1
      ) {
        conflict(
          "The queued-nomination recovery changed before failure was recorded.",
          "RECOVERY_FAILURE_CAS_FAILED"
        );
      }
    }
    if (failJobStatement.run(command).changes !== 1) {
      conflict(
        "The queued-nomination activation lease changed before failure was recorded.",
        "JOB_FAILURE_CAS_FAILED"
      );
    }
    const terminal = validateCore(readActivation(command), command);
    const terminalRecovery = validateRecovery(
      readRecovery(command),
      terminal
    );
    const result = failureProjection(
      command,
      terminalRecovery,
      false
    );
    invokeBeforeCommit("recordFailure", command, result);
    return result;
  });

  return Object.freeze({
    findActivation(input = {}) {
      const scope = normalizeFind(input);
      try {
        const row = validateCore(readActivation(scope), scope);
        if (!row) return null;
        const recovery = validateRecovery(
          readRecovery({ ...scope, runId: row.job_run_id }),
          row
        );
        if (row.job_status === "succeeded") {
          const stored = validateStoredResult(scope, row);
          validateReplay(row, stored, recovery);
        }
        if (
          row.job_status === "failed" &&
          (!recovery || recovery.status !== "correction_required")
        ) {
          incompatible(
            "The failed queued-nomination activation lacks its causal recovery.",
            "FAILURE_RECOVERY_MISSING"
          );
        }
        return projection(row, recovery);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "findFreeAgentDraftQueuedNominationActivation",
          tableName: "free_agent_draft_nomination_queue",
        });
      }
    },

    executeClaimed(input = {}) {
      const command = normalizeCommand(input, { failure: false });
      if (database.inTransaction) {
        conflict(
          "Queued-nomination activation owns its immediate transaction boundary.",
          "TRANSACTION_ALREADY_ACTIVE"
        );
      }
      try {
        return executeTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "executeClaimedFreeAgentDraftQueuedNominationActivation",
          tableName: "free_agent_draft_nomination_queue",
        });
      }
    },

    recordFailure(input = {}) {
      const command = normalizeCommand(input, { failure: true });
      if (database.inTransaction) {
        conflict(
          "Queued-nomination activation owns its immediate transaction boundary.",
          "TRANSACTION_ALREADY_ACTIVE"
        );
      }
      try {
        return failureTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "recordFailedFreeAgentDraftQueuedNominationActivation",
          tableName: "free_agent_draft_nomination_queue",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE:
    FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE:
    JOB_TYPE,
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_WRITER_METHODS:
    METHODS,
  createSqliteFreeAgentDraftQueuedNominationActivationWriter,
};
