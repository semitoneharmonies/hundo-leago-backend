"use strict";

const { randomUUID } = require("node:crypto");

const {
  UUID_PATTERN,
  buildFreeAgentDraftFallbackActivationOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
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
  createSocketEventEnvelope,
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

const JOB_TYPE = "fad_fallback_activation";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const METHODS = Object.freeze([
  "findActivation",
  "executeClaimed",
]);
const FIND_FIELDS = Object.freeze([
  "activationAtMs",
  "allocationId",
  "fadId",
  "leagueId",
  "seasonId",
]);
const COMMAND_FIELDS = Object.freeze([
  "activatedAtMs",
  "activationAtMs",
  "allocationId",
  "auctionId",
  "expectedAllocationVersion",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "playerId",
  "rolloverId",
  "seasonId",
  "sourceAuctionId",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "expectedVersion",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
]);
const HANDOFF_EVIDENCE_FIELDS = Object.freeze([
  "activationAtMs",
  "activationJobRunId",
  "activityId",
  "fallbackAuctionId",
  "notificationIds",
  "occurrenceKey",
  "outboxEventIds",
  "schemaVersion",
  "sourceAuctionId",
  "sourceRecoveryId",
  "targetRolloverId",
]);
const RESPONSE_FIELDS = Object.freeze([
  "activatedAtMs",
  "activationAtMs",
  "allocationId",
  "allocationVersion",
  "auctionId",
  "evidence",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "outcome",
  "playerId",
  "rolloverId",
  "seasonId",
  "sourceAuctionId",
  "sourceRecoveryId",
]);
const RESPONSE_EVIDENCE_FIELDS = Object.freeze([
  "activityId",
  "notificationIds",
  "outboxEventIds",
  "sourceResolutionId",
  "stateEventId",
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
    actual.some(
      (field, index) => field !== expected[index]
    )
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

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
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

function parseJsonObject(encoded, description) {
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    incompatible(
      `The persisted ${description} is not valid JSON.`,
      "PERSISTED_JSON_INVALID",
      error
    );
  }
  if (!isPlainObject(parsed)) {
    incompatible(
      `The persisted ${description} is not a JSON object.`,
      "PERSISTED_JSON_INVALID"
    );
  }
  return deepFreeze(parsed);
}

function canonicalOccurrenceKey(scope) {
  try {
    return buildFreeAgentDraftFallbackActivationOccurrenceKey({
      fadId: scope.fadId,
      allocationId: scope.allocationId,
      activationAtMs: scope.activationAtMs,
    });
  } catch {
    invalid(
      "The fallback activation occurrence identity is invalid.",
      "OCCURRENCE_KEY_INVALID"
    );
  }
}

function normalizeFind(input) {
  exactObject(input, FIND_FIELDS, "fallback activation lookup");
  const scope = {
    leagueId: canonicalId(input.leagueId, "league"),
    seasonId: canonicalId(input.seasonId, "season"),
    fadId: canonicalId(input.fadId, "Free Agent Draft"),
    allocationId: canonicalId(input.allocationId, "allocation"),
    activationAtMs: safeTimestamp(
      input.activationAtMs,
      "fallback activation timestamp"
    ),
  };
  return Object.freeze({
    ...scope,
    occurrenceKey: canonicalOccurrenceKey(scope),
  });
}

function normalizeCommand(input) {
  exactObject(input, COMMAND_FIELDS, "fallback activation command");
  exactObject(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "fallback activation job execution"
  );
  const lookup = normalizeFind({
    leagueId: input.leagueId,
    seasonId: input.seasonId,
    fadId: input.fadId,
    allocationId: input.allocationId,
    activationAtMs: input.activationAtMs,
  });
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "fallback activation occurrence key"
  );
  if (occurrenceKey !== lookup.occurrenceKey) {
    invalid(
      "The fallback activation occurrence key does not match its exact scope.",
      "OCCURRENCE_SCOPE_INVALID"
    );
  }
  return Object.freeze({
    ...lookup,
    occurrenceKey,
    playerId: canonicalId(input.playerId, "player"),
    sourceAuctionId: canonicalId(
      input.sourceAuctionId,
      "source auction"
    ),
    auctionId: canonicalId(input.auctionId, "fallback auction"),
    rolloverId: canonicalId(input.rolloverId, "rollover"),
    expectedAllocationVersion: positiveInteger(
      input.expectedAllocationVersion,
      "allocation version"
    ),
    activatedAtMs: safeTimestamp(
      input.activatedAtMs,
      "fallback activation execution timestamp"
    ),
    runId: canonicalId(
      input.jobExecution.runId,
      "activation job-run"
    ),
    expectedJobVersion: positiveInteger(
      input.jobExecution.expectedVersion,
      "activation job-run version"
    ),
    leaseOwner: boundedText(
      input.jobExecution.leaseOwner,
      128,
      "activation lease owner"
    ),
    leaseToken: boundedText(
      input.jobExecution.leaseToken,
      200,
      "activation lease token"
    ),
    leaseExpiresAtMs: safeTimestamp(
      input.jobExecution.leaseExpiresAtMs,
      "fallback activation lease expiry"
    ),
  });
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

function canonicalJobShape(row, status) {
  if (!row || row.job_status !== status) return false;
  if (status === "succeeded") {
    return (
      row.job_lease_owner === null &&
      row.job_lease_token === null &&
      row.job_lease_expires_at_ms === null &&
      row.job_completed_at_ms !== null &&
      typeof row.job_result_json === "string" &&
      row.job_last_error_code === null &&
      row.job_next_attempt_at_ms === null &&
      row.job_updated_at_ms === row.job_completed_at_ms
    );
  }
  if (status === "pending") {
    return (
      row.job_attempt_count === 0 &&
      row.job_lease_owner === null &&
      row.job_lease_token === null &&
      row.job_lease_expires_at_ms === null &&
      row.job_started_at_ms === null &&
      row.job_completed_at_ms === null &&
      row.job_result_json === null &&
      row.job_last_error_code === null &&
      row.job_next_attempt_at_ms === null
    );
  }
  return (
    ["leased", "running"].includes(status) &&
    row.job_attempt_count >= 1 &&
    typeof row.job_lease_owner === "string" &&
    typeof row.job_lease_token === "string" &&
    Number.isSafeInteger(row.job_lease_expires_at_ms) &&
    Number.isSafeInteger(row.job_started_at_ms) &&
    row.job_completed_at_ms === null &&
    row.job_result_json === null &&
    row.job_last_error_code === null &&
    row.job_next_attempt_at_ms === null
  );
}

function createSqliteFreeAgentDraftFallbackActivationWriter({
  database,
  createId = () => randomUUID(),
  leagueOutboxWriter,
  notificationWriter,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftFallbackActivationWriter requires an opened database"
    );
  }
  if (typeof createId !== "function") {
    throw new TypeError(
      "Fallback activation identifier factory must be a function"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "Fallback activation beforeCommit must be a function"
    );
  }

  let activationStatement;
  let drawStatement;
  let allocationEvidenceStatement;
  let sourceResolutionStatement;
  let sourceTerminalEventStatement;
  let recoveryStatement;
  let recipientStatement;
  let publicationCountStatement;
  let activityReplayStatement;
  let notificationReplayStatement;
  let outboxReplayStatement;
  let insertActivityStatement;
  let resolveRecoveryStatement;
  let succeedJobStatement;
  let outbox;
  let notifications;

  try {
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    notifications = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
    activationStatement = database.prepare(`
      SELECT
        allocation.id AS allocation_id,
        allocation.league_id,
        allocation.season_id,
        allocation.fad_id,
        allocation.player_id,
        allocation.status AS allocation_status,
        allocation.decision_code,
        allocation.winning_snapshot_entry_id,
        allocation.winning_team_id,
        allocation.contract_id,
        allocation.ownership_id,
        allocation.restricted_auction_id,
        allocation.fallback_open_auction_id,
        allocation.restricted_minimum_total_cents,
        allocation.restricted_minimum_term_years,
        allocation.restricted_minimum_aav_cents,
        allocation.accounted_at_ms,
        allocation.last_error_code,
        allocation.updated_at_ms AS allocation_updated_at_ms,
        allocation.version AS allocation_version,
        fad.status AS fad_status,
        fad.version AS fad_version,
        fallback.status AS auction_status,
        fallback.opened_at_ms,
        fallback.resolves_at_ms,
        fallback.opened_by_user_id,
        fallback.created_at_ms AS auction_created_at_ms,
        fallback.updated_at_ms AS auction_updated_at_ms,
        fallback.version AS auction_version,
        context.id AS context_id,
        context.source_kind,
        context.fad_rollover_id,
        context.fad_allocation_id,
        context.fad_origin,
        context.created_at_ms AS context_created_at_ms,
        rollover.sequence AS rollover_sequence,
        rollover.window_kind,
        rollover.predecessor_rollover_id,
        rollover.extension_reason,
        rollover.extension_source_id,
        rollover.opens_at_ms AS rollover_opens_at_ms,
        rollover.creation_cutoff_at_ms,
        rollover.rolls_over_at_ms,
        rollover.status AS rollover_status,
        source.status AS source_auction_status,
        source.player_id AS source_player_id,
        source.resolves_at_ms AS source_resolves_at_ms,
        source.version AS source_auction_version,
        source_context.source_kind AS source_context_kind,
        source_context.fad_id AS source_context_fad_id,
        source_context.fad_allocation_id
          AS source_context_allocation_id,
        source_context.fad_origin AS source_context_origin,
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
        job.version AS job_version,
        resolution_job.id AS resolution_job_id,
        resolution_job.status AS resolution_job_status,
        resolution_job.attempt_count
          AS resolution_job_attempt_count,
        resolution_job.lease_owner AS resolution_job_lease_owner,
        resolution_job.lease_token AS resolution_job_lease_token,
        resolution_job.lease_expires_at_ms
          AS resolution_job_lease_expires_at_ms,
        resolution_job.started_at_ms
          AS resolution_job_started_at_ms,
        resolution_job.completed_at_ms
          AS resolution_job_completed_at_ms,
        resolution_job.result_json
          AS resolution_job_result_json,
        resolution_job.last_error_code
          AS resolution_job_last_error_code,
        resolution_job.next_attempt_at_ms
          AS resolution_job_next_attempt_at_ms,
        resolution_job.version AS resolution_job_version,
        (
          SELECT COUNT(*)
          FROM auction_resolutions AS fallback_resolution
          WHERE fallback_resolution.league_id = fallback.league_id
            AND fallback_resolution.season_id = fallback.season_id
            AND fallback_resolution.auction_id = fallback.id
        ) AS fallback_resolution_count
      FROM free_agent_draft_player_allocations AS allocation
      JOIN free_agent_drafts AS fad
        ON fad.league_id = allocation.league_id
       AND fad.season_id = allocation.season_id
       AND fad.id = allocation.fad_id
      JOIN auctions AS fallback
        ON fallback.league_id = allocation.league_id
       AND fallback.season_id = allocation.season_id
       AND fallback.id = allocation.fallback_open_auction_id
       AND fallback.player_id = allocation.player_id
      JOIN auction_contexts AS context
        ON context.league_id = fallback.league_id
       AND context.season_id = fallback.season_id
       AND context.auction_id = fallback.id
      JOIN free_agent_draft_rollovers AS rollover
        ON rollover.league_id = context.league_id
       AND rollover.season_id = context.season_id
       AND rollover.fad_id = context.fad_id
       AND rollover.id = context.fad_rollover_id
      JOIN auctions AS source
        ON source.league_id = allocation.league_id
       AND source.season_id = allocation.season_id
       AND source.id = allocation.restricted_auction_id
       AND source.player_id = allocation.player_id
      JOIN auction_contexts AS source_context
        ON source_context.league_id = source.league_id
       AND source_context.season_id = source.season_id
       AND source_context.auction_id = source.id
      JOIN job_runs AS job
        ON job.league_id = allocation.league_id
       AND job.season_id = allocation.season_id
       AND job.job_type = '${JOB_TYPE}'
       AND job.occurrence_key = @occurrenceKey
       AND job.scheduled_for_ms = @activationAtMs
      JOIN job_runs AS resolution_job
        ON resolution_job.league_id = fallback.league_id
       AND resolution_job.season_id = fallback.season_id
       AND resolution_job.job_type = 'auction.resolve.target'
       AND resolution_job.occurrence_key =
            'auction:' || fallback.id || ':' || fallback.resolves_at_ms
       AND resolution_job.scheduled_for_ms = fallback.resolves_at_ms
      WHERE allocation.league_id = @leagueId
        AND allocation.season_id = @seasonId
        AND allocation.fad_id = @fadId
        AND allocation.id = @allocationId
      LIMIT 2
    `);
    drawStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_draws
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND auction_id = @auctionId
      LIMIT 2
    `);
    allocationEvidenceStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_allocation_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND player_id = @playerId
        AND allocation_version = @allocationVersion
      ORDER BY
        CASE event_kind
          WHEN 'offer_considered' THEN 1
          ELSE 2
        END,
        snapshot_entry_id,
        id
    `);
    sourceResolutionStatement = database.prepare(`
      SELECT *
      FROM auction_resolutions
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @sourceAuctionId
      ORDER BY id
    `);
    sourceTerminalEventStatement = database.prepare(`
      SELECT *
      FROM auction_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @sourceAuctionId
        AND event_type = 'auction_no_winner'
      ORDER BY id
    `);
    recoveryStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND kind = 'fallback_activation'
      ORDER BY id
    `);
    recipientStatement = database.prepare(`
      SELECT
        assignment.user_id AS userId,
        fad_team.team_id AS teamId
      FROM free_agent_draft_teams AS fad_team
      JOIN team_manager_assignments AS assignment
        ON assignment.league_id = fad_team.league_id
       AND assignment.team_id = fad_team.team_id
      JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
      JOIN users
        ON users.id = assignment.user_id
      WHERE fad_team.league_id = @leagueId
        AND fad_team.season_id = @seasonId
        AND fad_team.fad_id = @fadId
        AND fad_team.team_status_at_setup = 'active'
        AND assignment.status = 'accepted'
        AND assignment.accepted_at_ms IS NOT NULL
        AND assignment.accepted_at_ms <= @activatedAtMs
        AND assignment.ended_at_ms IS NULL
        AND membership.status = 'active'
        AND membership.joined_at_ms <= @activatedAtMs
        AND membership.ended_at_ms IS NULL
        AND users.status = 'active'
      ORDER BY fad_team.team_id, assignment.user_id
    `);
    publicationCountStatement = database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM league_activity AS activity
          WHERE activity.league_id = @leagueId
            AND activity.season_id = @seasonId
            AND activity.event_type =
                'free_agent_draft_restricted_fallback_opened'
            AND activity.related_type =
                'free_agent_draft_allocation'
            AND activity.related_id = @allocationId
            AND activity.player_id = @playerId
        ) AS activity_count,
        (
          SELECT COUNT(*)
          FROM notifications AS notification
          WHERE notification.league_id = @leagueId
            AND notification.event_type =
                'fad_restricted_fallback_opened'
            AND notification.related_feature = 'auction'
            AND notification.related_record_id = @auctionId
        ) AS notification_count,
        (
          SELECT COUNT(*)
          FROM outbox_events AS event
          WHERE event.league_id = @leagueId
            AND event.event_type = 'auction.changed'
            AND event.aggregate_type = 'auction'
            AND event.aggregate_id = @auctionId
        ) AS auction_outbox_count
    `);
    activityReplayStatement = database.prepare(`
      SELECT *
      FROM league_activity
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND event_type =
            'free_agent_draft_restricted_fallback_opened'
        AND related_type = 'free_agent_draft_allocation'
        AND related_id = @allocationId
        AND player_id = @playerId
      ORDER BY id
    `);
    notificationReplayStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE league_id = @leagueId
        AND event_type = 'fad_restricted_fallback_opened'
        AND related_feature = 'auction'
        AND related_record_id = @auctionId
      ORDER BY
        json_extract(message_data_json, '$.teamId'),
        user_id,
        id
    `);
    outboxReplayStatement = database.prepare(`
      SELECT
        event.*,
        audience.id AS audience_id,
        audience.audience_kind,
        audience.team_id AS audience_team_id,
        audience.user_id AS audience_user_id,
        audience.created_at_ms AS audience_created_at_ms
      FROM outbox_events AS event
      JOIN outbox_event_audiences AS audience
        ON audience.league_id = event.league_id
       AND audience.outbox_event_id = event.id
      WHERE event.league_id = @leagueId
        AND event.id = @outboxEventId
      ORDER BY audience.id
    `);
    insertActivityStatement = database.prepare(`
      INSERT INTO league_activity (
        id, league_id, season_id, event_type, actor_user_id,
        actor_authority, team_id, player_id, related_type,
        related_id, display_summary, reason, metadata_json,
        occurred_at_ms
      ) VALUES (
        @activityId, @leagueId, @seasonId,
        'free_agent_draft_restricted_fallback_opened', NULL,
        'system', NULL, @playerId,
        'free_agent_draft_allocation', @allocationId,
        'A restricted Free Agent Draft auction closed without an improvement and opened a league-wide fallback auction.',
        NULL, @metadataJson, @activatedAtMs
      )
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
        AND player_id = @playerId
        AND allocation_id = @allocationId
        AND rollover_id = @rolloverId
        AND auction_id = @auctionId
        AND job_run_id = @runId
        AND kind = 'fallback_activation'
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
        AND scheduled_for_ms = @activationAtMs
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
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareFreeAgentDraftFallbackActivationWriter",
      tableName: "free_agent_draft_player_allocations",
    });
  }

  function readActivation(scope) {
    return uniqueRow(
      activationStatement,
      scope,
      "The fallback activation binding"
    );
  }

  function validateCore(row, scope) {
    if (!row) return null;
    if (
      row.league_id !== scope.leagueId ||
      row.season_id !== scope.seasonId ||
      row.fad_id !== scope.fadId ||
      row.allocation_id !== scope.allocationId ||
      (scope.playerId !== undefined &&
        row.player_id !== scope.playerId) ||
      (scope.sourceAuctionId !== undefined &&
        row.restricted_auction_id !== scope.sourceAuctionId) ||
      (scope.auctionId !== undefined &&
        row.fallback_open_auction_id !== scope.auctionId) ||
      (scope.rolloverId !== undefined &&
        row.fad_rollover_id !== scope.rolloverId) ||
      row.allocation_status !== "restricted_fallback_open" ||
      row.fad_status !== "rapid" ||
      row.decision_code !==
        "restricted_no_improvement_fallback" ||
      row.winning_snapshot_entry_id !== null ||
      row.winning_team_id !== null ||
      row.contract_id !== null ||
      row.ownership_id !== null ||
      !UUID_PATTERN.test(row.restricted_auction_id || "") ||
      !UUID_PATTERN.test(row.fallback_open_auction_id || "") ||
      !Number.isSafeInteger(
        row.restricted_minimum_total_cents
      ) ||
      row.restricted_minimum_total_cents < 1 ||
      !Number.isSafeInteger(
        row.restricted_minimum_term_years
      ) ||
      row.restricted_minimum_term_years < 1 ||
      row.restricted_minimum_term_years > 3 ||
      row.restricted_minimum_aav_cents !==
        roundedAav(
          row.restricted_minimum_total_cents,
          row.restricted_minimum_term_years
        ) ||
      row.accounted_at_ms !== null ||
      row.last_error_code !== null ||
      row.auction_status !== "open" ||
      row.opened_at_ms !== scope.activationAtMs ||
      row.resolves_at_ms - row.opened_at_ms !== DAY_MS ||
      row.opened_by_user_id !== null ||
      row.auction_created_at_ms !== row.opened_at_ms ||
      row.auction_updated_at_ms !== row.opened_at_ms ||
      row.auction_version !== 1 ||
      row.context_id !== row.fallback_open_auction_id ||
      row.source_kind !== "fad_open_rapid" ||
      row.fad_allocation_id !== row.allocation_id ||
      row.fad_origin !==
        "restricted_no_improvement_fallback" ||
      row.context_created_at_ms !== row.opened_at_ms ||
      row.rollover_opens_at_ms !== row.opened_at_ms ||
      row.rolls_over_at_ms !== row.resolves_at_ms ||
      row.creation_cutoff_at_ms !==
        row.resolves_at_ms - 60 * 60 * 1000 ||
      ![
        "scheduled",
        "processing",
        "completed",
        "recovery_required",
      ].includes(row.rollover_status) ||
      !Number.isSafeInteger(row.rollover_sequence) ||
      row.rollover_sequence < 2 ||
      !UUID_PATTERN.test(row.predecessor_rollover_id || "") ||
      row.source_auction_status !== "no_winner" ||
      row.source_player_id !== row.player_id ||
      row.source_context_kind !== "fad_restricted" ||
      row.source_context_fad_id !== row.fad_id ||
      row.source_context_allocation_id !== row.allocation_id ||
      row.source_context_origin !== "candidate_tie_restricted" ||
      row.job_type !== JOB_TYPE ||
      row.occurrence_key !== scope.occurrenceKey ||
      row.scheduled_for_ms !== scope.activationAtMs ||
      !UUID_PATTERN.test(row.job_run_id || "") ||
      !Number.isSafeInteger(row.allocation_version) ||
      row.allocation_version < 1 ||
      !Number.isSafeInteger(row.job_version) ||
      row.job_version < 1 ||
      !UUID_PATTERN.test(row.resolution_job_id || "") ||
      !Number.isSafeInteger(row.resolution_job_version) ||
      row.resolution_job_version < 1
    ) {
      incompatible(
        "The fallback activation binding is malformed or no longer exact.",
        "ACTIVATION_BINDING_INVALID"
      );
    }
    return row;
  }

  function readDraw(row) {
    const draw = uniqueRow(
      drawStatement,
      {
        leagueId: row.league_id,
        seasonId: row.season_id,
        fadId: row.fad_id,
        allocationId: row.allocation_id,
        auctionId: row.fallback_open_auction_id,
      },
      "The fallback activation private draw"
    );
    if (
      !draw ||
      draw.algorithm_version !== 1 ||
      !Buffer.isBuffer(draw.nonce_bytes) ||
      draw.nonce_bytes.byteLength !== 32 ||
      draw.ordered_tied_bid_ids_json !== null ||
      draw.ordered_tied_team_ids_json !== null ||
      draw.rejection_counter !== null ||
      draw.selected_index !== null ||
      draw.selected_bid_id !== null ||
      draw.selected_team_id !== null ||
      draw.selected_digest_hex !== null ||
      draw.revealed_at_ms !== null ||
      draw.created_at_ms !== row.opened_at_ms ||
      draw.updated_at_ms !== row.opened_at_ms ||
      draw.version !== 1
    ) {
      incompatible(
        "The fallback activation private draw is incomplete.",
        "DRAW_EVIDENCE_INVALID"
      );
    }
    let commitmentHex;
    try {
      commitmentHex =
        createFreeAgentDraftAuctionDrawCommitment({
          auctionId: row.fallback_open_auction_id,
          nonceBytes: draw.nonce_bytes,
        }).commitmentHex;
    } catch (error) {
      incompatible(
        "The fallback activation draw commitment cannot be reproduced.",
        "DRAW_COMMITMENT_INVALID",
        error
      );
    }
    if (commitmentHex !== draw.commitment_hex) {
      incompatible(
        "The fallback activation draw commitment conflicts with its nonce.",
        "DRAW_COMMITMENT_INVALID"
      );
    }
    return draw;
  }

  function readSourceEvidence(row) {
    const parameters = {
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      playerId: row.player_id,
      allocationVersion: row.allocation_version,
      sourceAuctionId: row.restricted_auction_id,
    };
    const allocationEvents =
      allocationEvidenceStatement.all(parameters);
    const offerEvents = allocationEvents.filter(
      (event) => event.event_kind === "offer_considered"
    );
    const stateEvents = allocationEvents.filter(
      (event) => event.event_kind !== "offer_considered"
    );
    if (offerEvents.length < 2 || stateEvents.length !== 1) {
      incompatible(
        "The delayed fallback allocation evidence is incomplete.",
        "HANDOFF_EVIDENCE_INVALID"
      );
    }
    const state = stateEvents[0];
    if (
      state.event_kind !== "fallback_state_changed" ||
      state.snapshot_entry_id !== null ||
      state.team_id !== null ||
      state.offer_valid !== null ||
      state.rank_position !== null ||
      state.offer_outcome_code !== null ||
      state.decision_code !==
        "restricted_no_improvement_fallback" ||
      state.resulting_allocation_status !==
        "restricted_fallback_open" ||
      state.contract_id !== null ||
      state.ownership_id !== null ||
      state.auction_id !== row.fallback_open_auction_id ||
      state.activity_id !== null ||
      state.correction_id !== null ||
      state.actor_user_id !== null ||
      state.actor_membership_id !== null ||
      state.actor_authority !== "system" ||
      state.occurred_at_ms !== row.allocation_updated_at_ms ||
      state.created_at_ms !== row.allocation_updated_at_ms ||
      state.version !== 1
    ) {
      incompatible(
        "The delayed fallback state evidence is malformed.",
        "HANDOFF_EVIDENCE_INVALID"
      );
    }
    const evidence = parseJsonObject(
      state.evidence_json,
      "delayed fallback handoff evidence"
    );
    const actualFields = Object.keys(evidence).sort();
    const expectedFields = [...HANDOFF_EVIDENCE_FIELDS].sort();
    if (
      actualFields.length !== expectedFields.length ||
      actualFields.some(
        (field, index) => field !== expectedFields[index]
      ) ||
      evidence.schemaVersion !== 1 ||
      evidence.sourceAuctionId !== row.restricted_auction_id ||
      evidence.fallbackAuctionId !==
        row.fallback_open_auction_id ||
      evidence.targetRolloverId !== row.fad_rollover_id ||
      evidence.activationJobRunId !== row.job_run_id ||
      evidence.activationAtMs !== row.opened_at_ms ||
      evidence.activityId !== null ||
      !Array.isArray(evidence.notificationIds) ||
      evidence.notificationIds.length !== 0 ||
      !Array.isArray(evidence.outboxEventIds) ||
      evidence.outboxEventIds.length !== 0 ||
      (evidence.sourceRecoveryId !== null &&
        !UUID_PATTERN.test(evidence.sourceRecoveryId || ""))
    ) {
      incompatible(
        "The delayed fallback handoff evidence conflicts with its binding.",
        "HANDOFF_EVIDENCE_INVALID"
      );
    }
    for (const event of offerEvents) {
      if (
        event.resulting_allocation_status !==
          "restricted_fallback_open" ||
        event.decision_code !== null ||
        event.contract_id !== null ||
        event.ownership_id !== null ||
        event.auction_id !== null ||
        event.correction_id !== null ||
        event.actor_authority !== "system"
      ) {
        incompatible(
          "The delayed fallback offer evidence is malformed.",
          "HANDOFF_EVIDENCE_INVALID"
        );
      }
      parseJsonObject(
        event.evidence_json,
        "delayed fallback offer evidence"
      );
    }

    const resolutions = sourceResolutionStatement.all(parameters);
    const terminalEvents = sourceTerminalEventStatement.all(parameters);
    if (resolutions.length !== 1 || terminalEvents.length !== 1) {
      incompatible(
        "The delayed fallback source resolution is incomplete.",
        "SOURCE_RESOLUTION_INVALID"
      );
    }
    const resolution = resolutions[0];
    if (
      resolution.scheduled_occurrence_key !== evidence.occurrenceKey ||
      resolution.outcome_code !== "no_winner" ||
      resolution.status !== "no_winner" ||
      resolution.winning_team_id !== null ||
      resolution.winning_bid_id !== null ||
      resolution.highest_bid_cents !== null ||
      resolution.second_price_input_cents !== null ||
      resolution.final_contract_value_cents !== null ||
      resolution.winning_term_years !== null ||
      resolution.final_aav_cents !== null ||
      resolution.general_illegal !== 0 ||
      resolution.warnings_json !== "[]" ||
      resolution.contract_id !== null ||
      resolution.ownership_id !== null ||
      resolution.trigger_type !== "automatic" ||
      resolution.triggered_by_user_id !== null ||
      resolution.idempotency_key !== evidence.occurrenceKey ||
      resolution.resolved_at_ms !== state.occurred_at_ms ||
      row.source_resolves_at_ms > resolution.resolved_at_ms
    ) {
      incompatible(
        "The delayed fallback source resolution is malformed.",
        "SOURCE_RESOLUTION_INVALID"
      );
    }
    const terminal = terminalEvents[0];
    let terminalMetadata;
    try {
      terminalMetadata = JSON.parse(terminal.metadata_json);
    } catch {
      terminalMetadata = null;
    }
    if (
      terminal.bid_id !== null ||
      terminal.team_id !== null ||
      terminal.actor_user_id !== null ||
      terminal.occurred_at_ms !== resolution.resolved_at_ms ||
      !isPlainObject(terminalMetadata) ||
      Object.keys(terminalMetadata).length !== 3 ||
      terminalMetadata.outcome !== "no_winner" ||
      terminalMetadata.resolutionId !== resolution.id ||
      terminalMetadata.fallbackAuctionId !==
        row.fallback_open_auction_id
    ) {
      incompatible(
        "The delayed fallback terminal event is malformed.",
        "SOURCE_RESOLUTION_INVALID"
      );
    }
    return Object.freeze({
      resolution,
      state,
    });
  }

  function findActivationRecovery(command, replayed, sourceRecoveryId) {
    const recoveries = recoveryStatement.all(command);
    if (replayed) {
      if (sourceRecoveryId === null) {
        if (recoveries.length !== 0) {
          incompatible(
            "Fallback activation gained unexpected recovery evidence after completion.",
            "RECOVERY_REPLAY_INVALID"
          );
        }
        return null;
      }
      if (
        recoveries.length !== 1 ||
        recoveries[0].id !== sourceRecoveryId ||
        recoveries[0].player_id !== command.playerId ||
        recoveries[0].allocation_id !== command.allocationId ||
        recoveries[0].rollover_id !== command.rolloverId ||
        recoveries[0].auction_id !== command.auctionId ||
        recoveries[0].job_run_id !== command.runId ||
        recoveries[0].status !== "resolved" ||
        recoveries[0].earliest_activation_at_ms !==
          command.activationAtMs ||
        recoveries[0].target_resolution_at_ms !==
          command.resolvesAtMs ||
        recoveries[0].created_by_operation_id !== command.runId ||
        recoveries[0].last_error_code !== null ||
        recoveries[0].resolved_by_user_id !== null ||
        recoveries[0].resolved_by_membership_id !== null ||
        recoveries[0].resolved_authority !== "system" ||
        recoveries[0].updated_at_ms !== command.activatedAtMs ||
        recoveries[0].resolved_at_ms !== command.activatedAtMs ||
        recoveries[0].version < 2
      ) {
        incompatible(
          "The resolved fallback activation recovery is invalid.",
          "RECOVERY_REPLAY_INVALID"
        );
      }
      return recoveries[0];
    }
    if (recoveries.length > 1) {
      incompatible(
        "The fallback activation recovery evidence is ambiguous.",
        "RECOVERY_AMBIGUOUS"
      );
    }
    const recovery = recoveries[0] || null;
    if (
      recovery &&
      (recovery.player_id !== command.playerId ||
        recovery.allocation_id !== command.allocationId ||
        recovery.rollover_id !== command.rolloverId ||
        recovery.auction_id !== command.auctionId ||
        recovery.job_run_id !== command.runId ||
        recovery.status !== "running" ||
        recovery.earliest_activation_at_ms !==
          command.activationAtMs ||
        recovery.target_resolution_at_ms !== command.resolvesAtMs ||
        recovery.created_by_operation_id !== command.runId ||
        typeof recovery.last_error_code !== "string" ||
        recovery.last_error_code.length < 1 ||
        recovery.resolved_by_user_id !== null ||
        recovery.resolved_by_membership_id !== null ||
        recovery.resolved_authority !== null ||
        recovery.resolved_at_ms !== null ||
        recovery.updated_at_ms > command.activatedAtMs)
    ) {
      incompatible(
        "The running fallback activation recovery is invalid.",
        "RECOVERY_BINDING_INVALID"
      );
    }
    return recovery;
  }

  function createIdentityFactory() {
    const issued = new Set();
    return (description) => {
      const id = createId(description);
      canonicalId(id, description);
      if (issued.has(id)) {
        invalid(
          "Fallback activation identifier factories must return unique identifiers.",
          "IDENTIFIER_COLLISION"
        );
      }
      issued.add(id);
      return id;
    };
  }

  function responseProjection(command, evidence, sourceRecoveryId) {
    return deepFreeze({
      outcome: "succeeded",
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      allocationId: command.allocationId,
      playerId: command.playerId,
      sourceAuctionId: command.sourceAuctionId,
      auctionId: command.auctionId,
      rolloverId: command.rolloverId,
      activationAtMs: command.activationAtMs,
      activatedAtMs: command.activatedAtMs,
      allocationVersion: command.expectedAllocationVersion,
      jobRunId: command.runId,
      jobRunVersion: command.expectedJobVersion + 1,
      sourceRecoveryId,
      evidence,
    });
  }

  function storedResult(command, response) {
    return serializeCanonicalJsonV1({
      schemaVersion: 1,
      operation: "free_agent_draft_fallback_activation",
      identity: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        playerId: command.playerId,
        sourceAuctionId: command.sourceAuctionId,
        auctionId: command.auctionId,
        rolloverId: command.rolloverId,
        activationAtMs: command.activationAtMs,
        occurrenceKey: command.occurrenceKey,
        jobRunId: command.runId,
      },
      request: {
        expectedAllocationVersion:
          command.expectedAllocationVersion,
        expectedJobVersion: command.expectedJobVersion,
        activatedAtMs: command.activatedAtMs,
      },
      response,
    });
  }

  function parseStoredResult(command, row) {
    const stored = parseCanonical(
      row.job_result_json,
      "fallback activation job result"
    );
    try {
      exactObject(
        stored,
        [
          "schemaVersion",
          "operation",
          "identity",
          "request",
          "response",
        ],
        "stored fallback activation result"
      );
      exactObject(
        stored.identity,
        [
          "activationAtMs",
          "allocationId",
          "auctionId",
          "fadId",
          "jobRunId",
          "leagueId",
          "occurrenceKey",
          "playerId",
          "rolloverId",
          "seasonId",
          "sourceAuctionId",
        ],
        "stored fallback activation identity"
      );
      exactObject(
        stored.request,
        [
          "activatedAtMs",
          "expectedAllocationVersion",
          "expectedJobVersion",
        ],
        "stored fallback activation request"
      );
    } catch (error) {
      incompatible(
        "The stored fallback activation result shape is invalid.",
        "STORED_RESULT_INVALID",
        error
      );
    }
    const identity = stored.identity;
    const request = stored.request;
    if (
      stored.schemaVersion !== 1 ||
      stored.operation !==
        "free_agent_draft_fallback_activation" ||
      identity.leagueId !== command.leagueId ||
      identity.seasonId !== command.seasonId ||
      identity.fadId !== command.fadId ||
      identity.allocationId !== command.allocationId ||
      identity.playerId !== command.playerId ||
      identity.sourceAuctionId !== command.sourceAuctionId ||
      identity.auctionId !== command.auctionId ||
      identity.rolloverId !== command.rolloverId ||
      identity.activationAtMs !== command.activationAtMs ||
      identity.occurrenceKey !== command.occurrenceKey ||
      identity.jobRunId !== command.runId ||
      request.expectedAllocationVersion !==
        command.expectedAllocationVersion ||
      request.expectedJobVersion !== command.expectedJobVersion
    ) {
      incompatible(
        "The stored fallback activation result conflicts with its exact request.",
        "STORED_RESULT_CONFLICT"
      );
    }
    return Object.freeze({
      response: stored.response,
      activatedAtMs: request.activatedAtMs,
    });
  }

  function expectedActivityContract(command) {
    return createFreeAgentDraftActivityContract({
      eventType:
        "free_agent_draft_restricted_fallback_opened",
      metadata: {
        schemaVersion: 1,
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        playerId: command.playerId,
        sourceAuctionId: command.sourceAuctionId,
        fallbackAuctionId: command.auctionId,
        resolvesAtMs: command.resolvesAtMs,
      },
    });
  }

  function expectedActivityMetadata(command) {
    return serializeCanonicalJsonV1(
      expectedActivityContract(command).metadata
    );
  }

  function expectedNotificationContract(
    command,
    { teamId, userId }
  ) {
    return createFreeAgentDraftNotificationContract({
      type: "fad_restricted_fallback_opened",
      recipientUserId: userId,
      messageData: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        teamId,
        allocationId: command.allocationId,
        auctionId: command.auctionId,
        playerId: command.playerId,
        resolvesAtMs: command.resolvesAtMs,
        destination: {
          kind: "auction",
          leagueId: command.leagueId,
          auctionId: command.auctionId,
        },
      },
    });
  }

  function validatePublication(command, row, evidence) {
    const activities = activityReplayStatement.all(command);
    let activityContract;
    try {
      activityContract =
        createFreeAgentDraftActivityContract({
          eventType: activities[0]?.event_type,
          metadata: activities[0]
            ? parseCanonical(
                activities[0].metadata_json,
                "fallback activation activity metadata"
              )
            : null,
        });
    } catch (error) {
      incompatible(
        "The fallback activation activity violates its contract.",
        "ACTIVITY_EVIDENCE_INVALID",
        error
      );
    }
    if (
      activities.length !== 1 ||
      activities[0].id !== evidence.activityId ||
      activities[0].actor_user_id !== null ||
      activities[0].actor_authority !== "system" ||
      activities[0].team_id !== null ||
      activities[0].display_summary !==
        "A restricted Free Agent Draft auction closed without an improvement and opened a league-wide fallback auction." ||
      activities[0].reason !== null ||
      activities[0].metadata_json !==
        expectedActivityMetadata(command) ||
      activities[0].metadata_json !==
        serializeCanonicalJsonV1(
          activityContract.metadata
        ) ||
      activities[0].occurred_at_ms !== command.activatedAtMs
    ) {
      incompatible(
        "The fallback activation activity evidence is incomplete.",
        "ACTIVITY_EVIDENCE_INVALID"
      );
    }

    const notificationRows =
      notificationReplayStatement.all(command);
    if (
      notificationRows.length !== evidence.notificationIds.length ||
      notificationRows.some(
        (row, index) => row.id !== evidence.notificationIds[index]
      )
    ) {
      incompatible(
        "The fallback activation notification evidence is incomplete.",
        "NOTIFICATION_EVIDENCE_INVALID"
      );
    }
    for (const row of notificationRows) {
      const message = parseCanonical(
        row.message_data_json,
        "fallback activation notification message"
      );
      let notificationContract;
      let expectedContract;
      try {
        notificationContract =
          createFreeAgentDraftNotificationContract({
            type: row.event_type,
            recipientUserId: row.user_id,
            messageData: message,
          });
        expectedContract = expectedNotificationContract(
          command,
          {
            teamId:
              notificationContract.messageData.teamId,
            userId: row.user_id,
          }
        );
      } catch (error) {
        incompatible(
          "The fallback activation notification violates its contract.",
          "NOTIFICATION_EVIDENCE_INVALID",
          error
        );
      }
      if (
        row.created_at_ms !== command.activatedAtMs ||
        row.message_data_json !==
          serializeCanonicalJsonV1(
            notificationContract.messageData
          ) ||
        JSON.stringify(notificationContract.messageData) !==
          JSON.stringify(expectedContract.messageData) ||
        row.deduplication_key !==
          notificationContract.deduplicationKey ||
        notificationContract.deduplicationKey !==
          expectedContract.deduplicationKey
      ) {
        incompatible(
          "The fallback activation notification evidence is malformed.",
          "NOTIFICATION_EVIDENCE_INVALID"
        );
      }
    }

    if (
      !Array.isArray(evidence.outboxEventIds) ||
      evidence.outboxEventIds.length !==
        3 + evidence.notificationIds.length ||
      new Set(evidence.outboxEventIds).size !==
        evidence.outboxEventIds.length ||
      evidence.outboxEventIds.some(
        (id) => !UUID_PATTERN.test(id || "")
      )
    ) {
      incompatible(
        "The fallback activation outbox identity set is invalid.",
        "OUTBOX_EVIDENCE_INVALID"
      );
    }
    const expectations = [
      {
        id: evidence.outboxEventIds[0],
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: command.fadId,
        version: row.fad_version,
        reasonCode: "fallback_opened",
        teamId: null,
        audienceUserId: null,
      },
      {
        id: evidence.outboxEventIds[1],
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: command.auctionId,
        version: row.auction_version,
        reasonCode: "auction_changed",
        teamId: null,
        audienceUserId: null,
      },
      {
        id: evidence.outboxEventIds[2],
        eventType: "activity.created",
        aggregateType: "league_activity",
        aggregateId: evidence.activityId,
        version: 1,
        reasonCode: "fallback_opened",
        teamId: null,
        audienceUserId: null,
      },
      ...notificationRows.map((notification, index) => {
        const message = parseCanonical(
          notification.message_data_json,
          "fallback activation notification message"
        );
        return {
          id: evidence.outboxEventIds[index + 3],
          eventType: "notification.created",
          aggregateType: "notification",
          aggregateId: notification.id,
          version: 1,
          reasonCode: "fallback_opened",
          teamId: message.teamId,
          audienceUserId: notification.user_id,
        };
      }),
    ];
    for (const expected of expectations) {
      const rows = outboxReplayStatement.all({
        leagueId: command.leagueId,
        outboxEventId: expected.id,
      });
      const payloadJson = JSON.stringify(
        createSocketEventEnvelope({
          eventId: expected.id,
          type: expected.eventType,
          leagueId: command.leagueId,
          resourceId: expected.aggregateId,
          version: expected.version,
          reasonCode: expected.reasonCode,
          occurredAt: command.activatedAtMs,
          related: createEmptySocketRelated({
            fadId: command.fadId,
            teamId: expected.teamId,
            allocationId: command.allocationId,
            auctionId: command.auctionId,
          }),
        })
      );
      if (
        rows.length !== 1 ||
        rows[0].event_type !== expected.eventType ||
        rows[0].aggregate_type !== expected.aggregateType ||
        rows[0].aggregate_id !== expected.aggregateId ||
        rows[0].payload_json !== payloadJson ||
        rows[0].available_at_ms !== command.activatedAtMs ||
        rows[0].created_at_ms !== command.activatedAtMs ||
        rows[0].audience_id !==
          (expected.audienceUserId === null
            ? expected.id
            : rows[0].audience_id) ||
        rows[0].audience_kind !==
          (expected.audienceUserId === null
            ? "league"
            : "user") ||
        rows[0].audience_team_id !== null ||
        rows[0].audience_user_id !==
          expected.audienceUserId ||
        rows[0].audience_created_at_ms !== command.activatedAtMs
      ) {
        incompatible(
          "The fallback activation outbox evidence is incomplete.",
          "OUTBOX_EVIDENCE_INVALID"
        );
      }
    }
  }

  function validateReplay(command, row, stored) {
    const replayCommand = Object.freeze({
      ...command,
      activatedAtMs: stored.activatedAtMs,
      resolvesAtMs: row.resolves_at_ms,
    });
    const response = stored.response;
    try {
      exactObject(
        response,
        RESPONSE_FIELDS,
        "stored fallback activation response"
      );
      exactObject(
        response.evidence,
        RESPONSE_EVIDENCE_FIELDS,
        "stored fallback activation evidence"
      );
    } catch (error) {
      incompatible(
        "The stored fallback activation response shape is invalid.",
        "STORED_RESULT_INVALID",
        error
      );
    }
    const canonical = responseProjection(
      replayCommand,
      response.evidence,
      response.sourceRecoveryId
    );
    const source = readSourceEvidence(row);
    if (
      serializeCanonicalJsonV1(canonical) !==
        serializeCanonicalJsonV1(response) ||
      !canonicalJobShape(row, "succeeded") ||
      row.job_completed_at_ms !== stored.activatedAtMs ||
      row.job_version !== command.expectedJobVersion + 1 ||
      row.allocation_version !==
        command.expectedAllocationVersion ||
      response.evidence.sourceResolutionId !==
        source.resolution.id ||
      response.evidence.stateEventId !== source.state.id ||
      !UUID_PATTERN.test(response.evidence.activityId || "") ||
      !Array.isArray(response.evidence.notificationIds) ||
      response.evidence.notificationIds.some(
        (id) => !UUID_PATTERN.test(id || "")
      ) ||
      new Set(response.evidence.notificationIds).size !==
        response.evidence.notificationIds.length
    ) {
      incompatible(
        "The persisted fallback activation result is not exact.",
        "REPLAY_STATE_INVALID"
      );
    }
    readDraw(row);
    validatePublication(
      replayCommand,
      row,
      response.evidence
    );
    findActivationRecovery(
      replayCommand,
      true,
      response.sourceRecoveryId
    );
    return deepFreeze({ ...response, replayed: true });
  }

  function writeInvalidation(command, event) {
    const result = outbox.write({
      id: event.id,
      leagueId: command.leagueId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: createSocketEventMetadata({
        eventType: event.eventType,
        version: event.version,
        reasonCode: event.reasonCode,
        occurredAtMs: command.activatedAtMs,
        related: createEmptySocketRelated({
          fadId: command.fadId,
          teamId: event.teamId || null,
          allocationId: command.allocationId,
          auctionId: command.auctionId,
        }),
      }),
      occurredAtMs: command.activatedAtMs,
      audiences:
        event.userId === undefined
          ? [{ kind: "league" }]
          : [{ kind: "user", userId: event.userId }],
    });
    if (result && typeof result.then === "function") {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.transactionAsync,
        "Fallback activation outbox writes must be synchronous."
      );
    }
  }

  const executeTransaction = database.transaction((command) => {
    const row = readActivation(command);
    if (!row) {
      notFound(
        "The exact fallback activation binding was not found.",
        "ACTIVATION_NOT_FOUND"
      );
    }
    validateCore(row, command);

    if (row.job_status === "succeeded") {
      return validateReplay(
        command,
        row,
        parseStoredResult(command, row)
      );
    }

    if (command.activatedAtMs < row.opened_at_ms) {
      conflict(
        "The fallback activation is not due.",
        "ACTIVATION_NOT_DUE"
      );
    }
    if (command.activatedAtMs >= row.resolves_at_ms) {
      conflict(
        "The fallback activation window is closed.",
        "ACTIVATION_WINDOW_CLOSED"
      );
    }
    if (
      row.allocation_version !==
        command.expectedAllocationVersion ||
      row.job_run_id !== command.runId ||
      row.job_status !== "running" ||
      row.job_version !== command.expectedJobVersion ||
      row.job_lease_owner !== command.leaseOwner ||
      row.job_lease_token !== command.leaseToken ||
      row.job_lease_expires_at_ms !== command.leaseExpiresAtMs ||
      row.job_lease_expires_at_ms <= command.activatedAtMs ||
      row.job_attempt_count < 1 ||
      !Number.isSafeInteger(row.job_started_at_ms) ||
      row.job_started_at_ms < command.activationAtMs ||
      row.job_started_at_ms > command.activatedAtMs ||
      row.job_updated_at_ms > command.activatedAtMs ||
      row.job_completed_at_ms !== null ||
      row.job_result_json !== null ||
      row.job_last_error_code !== null ||
      row.job_next_attempt_at_ms !== null ||
      row.fallback_resolution_count !== 0 ||
      row.resolution_job_status !== "pending" ||
      row.resolution_job_attempt_count !== 0 ||
      row.resolution_job_lease_owner !== null ||
      row.resolution_job_lease_token !== null ||
      row.resolution_job_lease_expires_at_ms !== null ||
      row.resolution_job_started_at_ms !== null ||
      row.resolution_job_completed_at_ms !== null ||
      row.resolution_job_result_json !== null ||
      row.resolution_job_last_error_code !== null ||
      row.resolution_job_next_attempt_at_ms !== row.resolves_at_ms ||
      row.resolution_job_version !== 1
    ) {
      conflict(
        "The fallback activation allocation or live job lease changed.",
        "ACTIVATION_FENCE_CHANGED"
      );
    }

    readDraw(row);
    const source = readSourceEvidence(row);
    const freshCommand = Object.freeze({
      ...command,
      resolvesAtMs: row.resolves_at_ms,
    });
    const sourceRecovery = findActivationRecovery(
      freshCommand,
      false,
      null
    );
    const counts = publicationCountStatement.get(freshCommand);
    if (
      counts.activity_count !== 0 ||
      counts.notification_count !== 0 ||
      counts.auction_outbox_count !== 0
    ) {
      incompatible(
        "The delayed fallback was already published without terminal job evidence.",
        "PREMATURE_PUBLICATION_INVALID"
      );
    }

    const recipients = recipientStatement.all(freshCommand);
    const recipientKeys = recipients.map(
      (recipient) => `${recipient.teamId}:${recipient.userId}`
    );
    if (new Set(recipientKeys).size !== recipientKeys.length) {
      incompatible(
        "The fallback activation recipient snapshot is ambiguous.",
        "RECIPIENT_EVIDENCE_INVALID"
      );
    }

    const id = createIdentityFactory();
    const activityId = id("fallback activation activity");
    const notificationIds = Object.freeze(
      recipients.map(() => id("fallback activation notification"))
    );
    const outboxEventIds = Object.freeze([
      id("fallback activation FAD outbox event"),
      id("fallback activation auction outbox event"),
      id("fallback activation activity outbox event"),
      ...recipients.map(() =>
        id("fallback activation notification outbox event")
      ),
    ]);
    const evidence = deepFreeze({
      sourceResolutionId: source.resolution.id,
      stateEventId: source.state.id,
      activityId,
      notificationIds,
      outboxEventIds,
    });
    const response = responseProjection(
      freshCommand,
      evidence,
      sourceRecovery?.id || null
    );

    insertActivityStatement.run({
      ...freshCommand,
      activityId,
      metadataJson: expectedActivityMetadata(freshCommand),
    });

    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index];
      const notificationContract =
        expectedNotificationContract(freshCommand, {
          teamId: recipient.teamId,
          userId: recipient.userId,
        });
      const write = notifications.insert({
        id: notificationIds[index],
        userId: notificationContract.recipientUserId,
        leagueId: command.leagueId,
        eventType: notificationContract.type,
        messageDataJson: serializeCanonicalJsonV1(
          notificationContract.messageData
        ),
        deduplicationKey:
          notificationContract.deduplicationKey,
        relatedFeature: "auction",
        relatedRecordId: command.auctionId,
        deliveryStatus: "pending",
        createdAtMs: command.activatedAtMs,
        deliveredAtMs: null,
      });
      if (
        !write ||
        typeof write.then === "function" ||
        write.replayed !== false ||
        write.notification?.id !== notificationIds[index]
      ) {
        conflict(
          "The fallback activation notification write was not exact.",
          "NOTIFICATION_WRITE_INVALID"
        );
      }
    }

    writeInvalidation(freshCommand, {
      id: outboxEventIds[0],
      eventType: "free_agent_draft.changed",
      aggregateType: "free_agent_draft",
      aggregateId: command.fadId,
      version: row.fad_version,
      reasonCode: "fallback_opened",
    });
    writeInvalidation(freshCommand, {
      id: outboxEventIds[1],
      eventType: "auction.changed",
      aggregateType: "auction",
      aggregateId: command.auctionId,
      version: row.auction_version,
      reasonCode: "auction_changed",
    });
    writeInvalidation(freshCommand, {
      id: outboxEventIds[2],
      eventType: "activity.created",
      aggregateType: "league_activity",
      aggregateId: activityId,
      version: 1,
      reasonCode: "fallback_opened",
    });
    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index];
      writeInvalidation(freshCommand, {
        id: outboxEventIds[index + 3],
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: notificationIds[index],
        version: 1,
        reasonCode: "fallback_opened",
        teamId: recipient.teamId,
        userId: recipient.userId,
      });
    }

    if (sourceRecovery) {
      if (
        resolveRecoveryStatement.run({
          ...freshCommand,
          sourceRecoveryId: sourceRecovery.id,
        }).changes !== 1
      ) {
        conflict(
          "The fallback activation recovery changed before it resolved.",
          "RECOVERY_RESOLUTION_CAS_FAILED"
        );
      }
    }

    const resultJson = storedResult(freshCommand, response);
    if (
      succeedJobStatement.run({
        ...freshCommand,
        resultJson,
      }).changes !== 1
    ) {
      conflict(
        "The fallback activation lease changed before job completion.",
        "JOB_TERMINAL_CAS_FAILED"
      );
    }

    if (beforeCommit) {
      const hookResult = beforeCommit({
        command: freshCommand,
        response,
      });
      if (
        hookResult &&
        typeof hookResult.then === "function"
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.transactionAsync,
          "Fallback activation beforeCommit must be synchronous."
        );
      }
    }

    const terminal = readActivation(freshCommand);
    validateCore(terminal, freshCommand);
    if (
      terminal.allocation_version !==
        command.expectedAllocationVersion ||
      terminal.job_run_id !== command.runId ||
      terminal.job_status !== "succeeded" ||
      terminal.job_version !== response.jobRunVersion ||
      terminal.job_completed_at_ms !== command.activatedAtMs ||
      terminal.job_result_json !== resultJson ||
      !canonicalJobShape(terminal, "succeeded")
    ) {
      incompatible(
        "The fallback activation terminal state is noncanonical.",
        "ACTIVATION_TERMINAL_STATE_INVALID"
      );
    }
    validateReplay(freshCommand, terminal, {
      response,
      activatedAtMs: command.activatedAtMs,
    });
    return deepFreeze({ ...response, replayed: false });
  });

  function projection(row) {
    return deepFreeze({
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      playerId: row.player_id,
      status: row.allocation_status,
      allocationVersion: row.allocation_version,
      sourceAuctionId: row.restricted_auction_id,
      auctionId: row.fallback_open_auction_id,
      rolloverId: row.fad_rollover_id,
      activationAtMs: row.opened_at_ms,
      resolvesAtMs: row.resolves_at_ms,
      activationJobRunId: row.job_run_id,
      activationOccurrenceKey: row.occurrence_key,
      jobStatus: row.job_status,
      jobRunVersion: row.job_version,
    });
  }

  return Object.freeze({
    findActivation(input = {}) {
      const scope = normalizeFind(input);
      try {
        const row = readActivation(scope);
        if (!row) return null;
        validateCore(row, scope);
        readDraw(row);
        readSourceEvidence(row);
        if (
          ![
            "pending",
            "leased",
            "running",
            "succeeded",
          ].includes(row.job_status) ||
          !canonicalJobShape(row, row.job_status)
        ) {
          incompatible(
            "The fallback activation job state is noncanonical.",
            "ACTIVATION_JOB_STATE_INVALID"
          );
        }
        return projection(row);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findFreeAgentDraftFallbackActivation",
          tableName: "free_agent_draft_player_allocations",
        });
      }
    },

    executeClaimed(input = {}) {
      const command = normalizeCommand(input);
      if (database.inTransaction) {
        conflict(
          "Fallback activation owns its immediate transaction boundary.",
          "TRANSACTION_ALREADY_ACTIVE"
        );
      }
      try {
        return executeTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "executeClaimedFreeAgentDraftFallbackActivation",
          tableName: "free_agent_draft_player_allocations",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_JOB_TYPE: JOB_TYPE,
  FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_WRITER_METHODS: METHODS,
  createSqliteFreeAgentDraftFallbackActivationWriter,
};
