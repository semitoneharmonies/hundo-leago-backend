"use strict";

const { randomUUID } = require("node:crypto");

const {
  UUID_PATTERN,
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
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

const JOB_TYPE = "fad_restricted_activation";
const COOLDOWN_DURATION_MS = 75 * 60 * 1000;
const MINIMUM_FAIR_ACCESS_MS = 60 * 60 * 1000;
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
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "expectedVersion",
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

function canonicalOccurrenceKey(scope) {
  try {
    return buildFreeAgentDraftRestrictedActivationOccurrenceKey({
      fadId: scope.fadId,
      allocationId: scope.allocationId,
      activationAtMs: scope.activationAtMs,
    });
  } catch (error) {
    invalid(
      "The restricted activation occurrence identity is invalid.",
      "OCCURRENCE_KEY_INVALID"
    );
  }
}

function normalizeFind(input) {
  exactObject(input, FIND_FIELDS, "restricted activation lookup");
  const scope = {
    leagueId: canonicalId(input.leagueId, "league"),
    seasonId: canonicalId(input.seasonId, "season"),
    fadId: canonicalId(input.fadId, "Free Agent Draft"),
    allocationId: canonicalId(input.allocationId, "allocation"),
    activationAtMs: safeTimestamp(
      input.activationAtMs,
      "restricted activation timestamp"
    ),
  };
  return Object.freeze({
    ...scope,
    occurrenceKey: canonicalOccurrenceKey(scope),
  });
}

function normalizeCommand(input) {
  exactObject(
    input,
    COMMAND_FIELDS,
    "restricted activation command"
  );
  exactObject(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "restricted activation job execution"
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
    "restricted activation occurrence key"
  );
  if (occurrenceKey !== lookup.occurrenceKey) {
    invalid(
      "The restricted activation occurrence key does not match its exact scope.",
      "OCCURRENCE_SCOPE_INVALID"
    );
  }
  const activatedAtMs = safeTimestamp(
    input.activatedAtMs,
    "restricted activation execution timestamp"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.jobExecution.leaseExpiresAtMs,
    "restricted activation lease expiry"
  );
  return Object.freeze({
    ...lookup,
    occurrenceKey,
    playerId: canonicalId(input.playerId, "player"),
    auctionId: canonicalId(input.auctionId, "auction"),
    rolloverId: canonicalId(input.rolloverId, "rollover"),
    expectedAllocationVersion: positiveInteger(
      input.expectedAllocationVersion,
      "allocation version"
    ),
    activatedAtMs,
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
    leaseExpiresAtMs,
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

function canonicalJobShape(job, status) {
  if (!job || job.job_status !== status) return false;
  if (status === "succeeded") {
    return (
      job.job_lease_owner === null &&
      job.job_lease_token === null &&
      job.job_lease_expires_at_ms === null &&
      job.job_completed_at_ms !== null &&
      typeof job.job_result_json === "string" &&
      job.job_last_error_code === null &&
      job.job_next_attempt_at_ms === null &&
      job.job_updated_at_ms === job.job_completed_at_ms
    );
  }
  if (status === "pending") {
    return (
      job.job_attempt_count === 0 &&
      job.job_lease_owner === null &&
      job.job_lease_token === null &&
      job.job_lease_expires_at_ms === null &&
      job.job_started_at_ms === null &&
      job.job_completed_at_ms === null &&
      job.job_result_json === null &&
      job.job_last_error_code === null &&
      job.job_next_attempt_at_ms === null
    );
  }
  return ["leased", "running"].includes(status) &&
    job.job_attempt_count >= 1 &&
    typeof job.job_lease_owner === "string" &&
    typeof job.job_lease_token === "string" &&
    Number.isSafeInteger(job.job_lease_expires_at_ms) &&
    Number.isSafeInteger(job.job_started_at_ms) &&
    job.job_completed_at_ms === null &&
    job.job_result_json === null &&
    job.job_last_error_code === null &&
    job.job_next_attempt_at_ms === null;
}

function createSqliteFreeAgentDraftRestrictedActivationWriter({
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
      "createSqliteFreeAgentDraftRestrictedActivationWriter requires an opened database"
    );
  }
  if (typeof createId !== "function") {
    throw new TypeError(
      "Restricted activation identifier factory must be a function"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "Restricted activation beforeCommit must be a function"
    );
  }

  let activationStatement;
  let participantsStatement;
  let recipientsStatement;
  let drawStatement;
  let versionEventsStatement;
  let activeBidsStatement;
  let resolutionsStatement;
  let recoveriesStatement;
  let notificationReplayStatement;
  let outboxReplayStatement;
  let updateAllocationStatement;
  let insertEventStatement;
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
        allocation.created_at_ms AS allocation_created_at_ms,
        allocation.updated_at_ms AS allocation_updated_at_ms,
        allocation.version AS allocation_version,
        fad.version AS fad_version,
        auction.status AS auction_status,
        auction.opened_at_ms,
        auction.resolves_at_ms,
        auction.opened_by_user_id,
        auction.created_at_ms AS auction_created_at_ms,
        auction.updated_at_ms AS auction_updated_at_ms,
        auction.version AS auction_version,
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
        rollover.created_at_ms AS rollover_created_at_ms,
        rollover.updated_at_ms AS rollover_updated_at_ms,
        rollover.version AS rollover_version,
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
      FROM free_agent_draft_player_allocations AS allocation
      JOIN free_agent_drafts AS fad
        ON fad.league_id = allocation.league_id
       AND fad.season_id = allocation.season_id
       AND fad.id = allocation.fad_id
      JOIN auctions AS auction
        ON auction.league_id = allocation.league_id
       AND auction.season_id = allocation.season_id
       AND auction.id = allocation.restricted_auction_id
       AND auction.player_id = allocation.player_id
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
      JOIN free_agent_draft_rollovers AS rollover
        ON rollover.league_id = context.league_id
       AND rollover.season_id = context.season_id
       AND rollover.fad_id = context.fad_id
       AND rollover.id = context.fad_rollover_id
      JOIN job_runs AS job
        ON job.league_id = allocation.league_id
       AND job.season_id = allocation.season_id
       AND job.job_type = '${JOB_TYPE}'
       AND job.occurrence_key = @occurrenceKey
       AND job.scheduled_for_ms = @activationAtMs
      WHERE allocation.league_id = @leagueId
        AND allocation.season_id = @seasonId
        AND allocation.fad_id = @fadId
        AND allocation.id = @allocationId
      LIMIT 2
    `);
    participantsStatement = database.prepare(`
      SELECT
        participant.*,
        snapshot_entry.card_id AS source_card_id
      FROM free_agent_draft_auction_participants AS participant
      JOIN candidate_card_snapshot_entries AS snapshot_entry
        ON snapshot_entry.league_id = participant.league_id
       AND snapshot_entry.season_id = participant.season_id
       AND snapshot_entry.fad_id = participant.fad_id
       AND snapshot_entry.id = participant.source_snapshot_entry_id
       AND snapshot_entry.team_id = participant.team_id
      WHERE participant.league_id = @leagueId
        AND participant.season_id = @seasonId
        AND participant.fad_id = @fadId
        AND participant.allocation_id = @allocationId
        AND participant.auction_id = @auctionId
      ORDER BY participant.team_id, participant.id
    `);
    recipientsStatement = database.prepare(`
      SELECT
        participant.team_id,
        assignment.user_id
      FROM free_agent_draft_auction_participants AS participant
      JOIN team_manager_assignments AS assignment
        ON assignment.league_id = participant.league_id
       AND assignment.team_id = participant.team_id
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.ended_at_ms IS NULL
      JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
       AND membership.status = 'active'
       AND membership.ended_at_ms IS NULL
      JOIN users AS manager
        ON manager.id = assignment.user_id
       AND manager.status = 'active'
      WHERE participant.league_id = @leagueId
        AND participant.season_id = @seasonId
        AND participant.fad_id = @fadId
        AND participant.allocation_id = @allocationId
        AND participant.auction_id = @auctionId
        AND participant.status = 'active'
      ORDER BY participant.team_id, assignment.user_id
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
    versionEventsStatement = database.prepare(`
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
        rank_position,
      id
    `);
    activeBidsStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM auction_bids
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @auctionId
    `);
    resolutionsStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM auction_resolutions
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @auctionId
    `);
    recoveriesStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND player_id = @playerId
        AND allocation_id = @allocationId
        AND rollover_id = @rolloverId
        AND auction_id = @auctionId
        AND job_run_id = @runId
        AND kind = 'restricted_activation'
      ORDER BY id
    `);
    notificationReplayStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE league_id = @leagueId
        AND event_type = 'fad_restricted_eligible'
        AND related_feature = 'free_agent_draft_auction'
        AND related_record_id = @auctionId
      ORDER BY id
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
    updateAllocationStatement = database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'restricted_active',
          updated_at_ms = @activatedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @allocationId
        AND player_id = @playerId
        AND restricted_auction_id = @auctionId
        AND status = 'restricted_scheduled'
        AND version = @expectedAllocationVersion
    `);
    insertEventStatement = database.prepare(`
      INSERT INTO free_agent_draft_allocation_events (
        id,
        league_id,
        season_id,
        fad_id,
        allocation_id,
        allocation_version,
        player_id,
        event_kind,
        snapshot_entry_id,
        team_id,
        offer_valid,
        rank_position,
        offer_outcome_code,
        decision_code,
        resulting_allocation_status,
        contract_id,
        ownership_id,
        auction_id,
        activity_id,
        correction_id,
        actor_user_id,
        actor_membership_id,
        actor_authority,
        evidence_json,
        occurred_at_ms,
        created_at_ms,
        version
      ) VALUES (
        @eventId,
        @leagueId,
        @seasonId,
        @fadId,
        @allocationId,
        @allocationVersion,
        @playerId,
        @eventKind,
        @snapshotEntryId,
        @teamId,
        @offerValid,
        @rankPosition,
        @offerOutcomeCode,
        @decisionCode,
        'restricted_active',
        @contractId,
        @ownershipId,
        @auctionId,
        @activityId,
        @correctionId,
        @actorUserId,
        @actorMembershipId,
        @actorAuthority,
        @evidenceJson,
        @activatedAtMs,
        @activatedAtMs,
        1
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
        AND kind = 'restricted_activation'
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
      operation: "prepareFreeAgentDraftRestrictedActivationWriter",
      tableName: "free_agent_draft_player_allocations",
    });
  }

  function readActivation(scope) {
    return uniqueRow(
      activationStatement,
      scope,
      "The restricted activation binding"
    );
  }

  function validateCore(row, scope, allowedStatuses) {
    if (!row) return null;
    if (
      !allowedStatuses.includes(row.allocation_status) ||
      row.league_id !== scope.leagueId ||
      row.season_id !== scope.seasonId ||
      row.fad_id !== scope.fadId ||
      row.allocation_id !== scope.allocationId ||
      (scope.playerId !== undefined &&
        row.player_id !== scope.playerId) ||
      (scope.auctionId !== undefined &&
        row.restricted_auction_id !== scope.auctionId) ||
      (scope.rolloverId !== undefined &&
        row.fad_rollover_id !== scope.rolloverId) ||
      row.decision_code !== "exact_total_and_term_tie" ||
      row.winning_snapshot_entry_id !== null ||
      row.winning_team_id !== null ||
      row.contract_id !== null ||
      row.ownership_id !== null ||
      !UUID_PATTERN.test(row.restricted_auction_id || "") ||
      row.fallback_open_auction_id !== null ||
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
      row.resolves_at_ms - row.opened_at_ms !==
        24 * 60 * 60 * 1000 ||
      row.opened_by_user_id !== null ||
      row.auction_created_at_ms !==
        row.auction_updated_at_ms ||
      row.auction_version !== 1 ||
      row.context_id !== row.restricted_auction_id ||
      row.source_kind !== "fad_restricted" ||
      row.fad_allocation_id !== row.allocation_id ||
      row.fad_origin !== "candidate_tie_restricted" ||
      row.rollover_opens_at_ms !== row.opened_at_ms ||
      row.rolls_over_at_ms !== row.resolves_at_ms ||
      !["scheduled", "processing"].includes(
        row.rollover_status
      ) ||
      !Number.isSafeInteger(row.rollover_sequence) ||
      row.rollover_sequence < 2 ||
      !UUID_PATTERN.test(row.predecessor_rollover_id || "") ||
      row.job_type !== JOB_TYPE ||
      row.occurrence_key !== scope.occurrenceKey ||
      row.scheduled_for_ms !== scope.activationAtMs ||
      !UUID_PATTERN.test(row.job_run_id || "") ||
      !Number.isSafeInteger(row.allocation_version) ||
      row.allocation_version < 1 ||
      !Number.isSafeInteger(row.job_version) ||
      row.job_version < 1
    ) {
      incompatible(
        "The restricted activation binding is malformed or no longer exact.",
        "ACTIVATION_BINDING_INVALID"
      );
    }
    return row;
  }

  function readResources(row, { fresh }) {
    const parameters = {
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      auctionId: row.restricted_auction_id,
    };
    const participants = participantsStatement.all(parameters);
    const draw = uniqueRow(
      drawStatement,
      parameters,
      "The restricted activation private draw"
    );
    const teamIds = new Set();
    const participantIds = new Set();
    if (
      participants.length < 2 ||
      !draw ||
      draw.algorithm_version !== 1 ||
      !Buffer.isBuffer(draw.nonce_bytes) ||
      draw.nonce_bytes.byteLength !== 32 ||
      draw.version !== 1 ||
      draw.revealed_at_ms !== null ||
      draw.ordered_tied_bid_ids_json !== null ||
      draw.ordered_tied_team_ids_json !== null ||
      draw.rejection_counter !== null ||
      draw.selected_index !== null ||
      draw.selected_bid_id !== null ||
      draw.selected_team_id !== null ||
      draw.selected_digest_hex !== null ||
      draw.created_at_ms !== row.opened_at_ms ||
      draw.updated_at_ms !== row.opened_at_ms
    ) {
      incompatible(
        "The restricted activation participants or private draw are incomplete.",
        "ACTIVATION_RESOURCES_INVALID"
      );
    }
    let commitmentHex;
    try {
      commitmentHex =
        createFreeAgentDraftAuctionDrawCommitment({
          auctionId: row.restricted_auction_id,
          nonceBytes: draw.nonce_bytes,
        }).commitmentHex;
    } catch (error) {
      incompatible(
        "The restricted activation draw commitment cannot be reproduced.",
        "DRAW_COMMITMENT_INVALID",
        error
      );
    }
    if (commitmentHex !== draw.commitment_hex) {
      incompatible(
        "The restricted activation draw commitment conflicts with its nonce.",
        "DRAW_COMMITMENT_INVALID"
      );
    }
    for (const participant of participants) {
      if (
        participantIds.has(participant.id) ||
        teamIds.has(participant.team_id) ||
        participant.minimum_total_value_cents !==
          row.restricted_minimum_total_cents ||
        participant.minimum_term_years !==
          row.restricted_minimum_term_years ||
        participant.minimum_aav_cents !==
          row.restricted_minimum_aav_cents ||
        participant.manager_edit_limit !== 1 ||
        participant.cooldown_duration_ms !==
          COOLDOWN_DURATION_MS ||
        !UUID_PATTERN.test(
          participant.source_snapshot_entry_id || ""
        ) ||
        !UUID_PATTERN.test(
          participant.source_card_id || ""
        ) ||
        !UUID_PATTERN.test(
          participant.originating_candidate_revision_id || ""
        ) ||
        !UUID_PATTERN.test(
          participant.originating_actor_user_id || ""
        ) ||
        !UUID_PATTERN.test(
          participant.originating_actor_membership_id || ""
        ) ||
        ![
          "manager",
          "commissioner",
          "platform_administrator_as_commissioner",
        ].includes(participant.originating_actor_authority) ||
        !Number.isSafeInteger(participant.created_at_ms) ||
        participant.created_at_ms < 0 ||
        !Number.isSafeInteger(participant.updated_at_ms) ||
        participant.updated_at_ms < participant.created_at_ms ||
        !Number.isSafeInteger(participant.version) ||
        participant.version < 1 ||
        (fresh &&
          (participant.status !== "active" ||
            participant.active_improvement_bid_id !== null ||
            participant.first_improvement_at_ms !== null ||
            participant.current_cooldown_anchor_at_ms !== null ||
            participant.improvement_committed_at_ms !== null ||
            participant.removed_by_user_id !== null ||
            participant.removed_by_membership_id !== null ||
            participant.removed_authority !== null ||
            participant.removal_reason !== null ||
            participant.removed_at_ms !== null ||
            participant.updated_at_ms !==
              participant.created_at_ms ||
            participant.version !== 1))
      ) {
        incompatible(
          "The restricted activation participant allowlist is malformed.",
          "PARTICIPANT_EVIDENCE_INVALID"
        );
      }
      participantIds.add(participant.id);
      teamIds.add(participant.team_id);
    }
    return Object.freeze({
      draw,
      participants: Object.freeze(participants),
    });
  }

  function readVersionEvidence(row, allocationVersion) {
    const rows = versionEventsStatement.all({
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      playerId: row.player_id,
      allocationVersion,
    });
    const offers = rows.filter(
      (event) => event.event_kind === "offer_considered"
    );
    const states = rows.filter(
      (event) => event.event_kind !== "offer_considered"
    );
    if (offers.length < 2 || states.length !== 1) {
      incompatible(
        "The restricted activation allocation evidence is incomplete.",
        "ALLOCATION_EVIDENCE_INVALID"
      );
    }
    const offerIds = new Set();
    for (const event of offers) {
      if (
        offerIds.has(event.id) ||
        !UUID_PATTERN.test(event.snapshot_entry_id || "") ||
        !UUID_PATTERN.test(event.team_id || "") ||
        ![0, 1].includes(event.offer_valid) ||
        (event.offer_valid === 1) !==
          (event.rank_position !== null) ||
        typeof event.offer_outcome_code !== "string" ||
        event.decision_code !== null ||
        event.resulting_allocation_status !==
          (allocationVersion === row.allocation_version
            ? row.allocation_status
            : "restricted_scheduled") ||
        event.contract_id !== null ||
        event.ownership_id !== null ||
        event.auction_id !== null ||
        event.correction_id !== null ||
        event.actor_authority !== "system"
      ) {
        incompatible(
          "The restricted activation offer evidence is malformed.",
          "OFFER_EVIDENCE_INVALID"
        );
      }
      parseCanonical(
        event.evidence_json,
        "restricted activation offer evidence"
      );
      offerIds.add(event.id);
    }
    const state = states[0];
    if (
      state.event_kind !== "restricted_state_changed" ||
      state.decision_code !== "exact_total_and_term_tie" ||
      state.resulting_allocation_status !==
        (allocationVersion === row.allocation_version
          ? row.allocation_status
          : "restricted_scheduled") ||
      state.snapshot_entry_id !== null ||
      state.team_id !== null ||
      state.offer_valid !== null ||
      state.rank_position !== null ||
      state.offer_outcome_code !== null ||
      state.contract_id !== null ||
      state.ownership_id !== null ||
      state.auction_id !== row.restricted_auction_id ||
      state.correction_id !== null ||
      state.actor_authority !== "system"
    ) {
      incompatible(
        "The restricted activation state evidence is malformed.",
        "STATE_EVIDENCE_INVALID"
      );
    }
    parseCanonical(
      state.evidence_json,
      "restricted activation state evidence"
    );
    return Object.freeze({
      offers: Object.freeze(offers),
      state,
    });
  }

  function validateParticipantOfferCoverage(resources, evidence) {
    const tiedOffers = evidence.offers.filter(
      (event) =>
        event.offer_valid === 1 &&
        event.offer_outcome_code === "restricted_tied"
    );
    const offersBySnapshot = new Map(
      tiedOffers.map((event) => [
        event.snapshot_entry_id,
        event,
      ])
    );
    const offersByTeam = new Map(
      tiedOffers.map((event) => [event.team_id, event])
    );
    if (
      tiedOffers.length !== resources.participants.length ||
      offersBySnapshot.size !== tiedOffers.length ||
      offersByTeam.size !== tiedOffers.length
    ) {
      incompatible(
        "The restricted activation allowlist is not an exact tied-offer bijection.",
        "PARTICIPANT_OFFER_COVERAGE_INVALID"
      );
    }
    for (const participant of resources.participants) {
      const offer = offersBySnapshot.get(
        participant.source_snapshot_entry_id
      );
      if (
        !offer ||
        offersByTeam.get(participant.team_id) !== offer ||
        offer.team_id !== participant.team_id ||
        offer.offer_valid !== 1 ||
        offer.offer_outcome_code !== "restricted_tied" ||
        participant.created_at_ms !==
          evidence.state.occurred_at_ms
      ) {
        incompatible(
          "The restricted activation participant allowlist is not covered by tied-offer evidence.",
          "PARTICIPANT_OFFER_COVERAGE_INVALID"
        );
      }
    }
  }

  function findSourceRecovery(command, { replayed, sourceRecoveryId }) {
    const recoveries = recoveriesStatement.all(command);
    if (replayed) {
      if (sourceRecoveryId === null) {
        if (recoveries.length !== 0) {
          incompatible(
            "The restricted activation acquired unexpected recovery evidence after completion.",
            "RECOVERY_REPLAY_INVALID"
          );
        }
        return null;
      }
      if (
        recoveries.length !== 1 ||
        recoveries[0].id !== sourceRecoveryId ||
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
        recoveries[0].resolved_at_ms !== command.activatedAtMs ||
        recoveries[0].updated_at_ms !== command.activatedAtMs ||
        recoveries[0].version < 2
      ) {
        incompatible(
          "The resolved restricted activation recovery evidence is invalid.",
          "RECOVERY_REPLAY_INVALID"
        );
      }
      return recoveries[0];
    }
    if (recoveries.length > 1) {
      incompatible(
        "The restricted activation has ambiguous running recovery evidence.",
        "RECOVERY_AMBIGUOUS"
      );
    }
    const recovery = recoveries[0] || null;
    if (
      recovery &&
      (recovery.status !== "running" ||
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
        "The running restricted activation recovery evidence is invalid.",
        "RECOVERY_BINDING_INVALID"
      );
    }
    return recovery;
  }

  function readCurrentRecipients(command, resources) {
    const rows = recipientsStatement.all(command);
    const seenTeams = new Set();
    if (
      rows.length !== resources.participants.length ||
      rows.some((row, index) => {
        const participant = resources.participants[index];
        const invalidRow =
          !participant ||
          row.team_id !== participant.team_id ||
          !UUID_PATTERN.test(row.user_id || "") ||
          seenTeams.has(row.team_id);
        seenTeams.add(row.team_id);
        return invalidRow;
      })
    ) {
      conflict(
        "Every restricted activation participant requires one current accepted manager.",
        "ACTIVATION_RECIPIENTS_CHANGED"
      );
    }
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          teamId: row.team_id,
          userId: row.user_id,
        })
      )
    );
  }

  function restrictedEligibleContract(command, recipient) {
    return createFreeAgentDraftNotificationContract({
      type: "fad_restricted_eligible",
      recipientUserId: recipient.userId,
      messageData: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        auctionId: command.auctionId,
        playerId: command.playerId,
        teamId: recipient.teamId,
        destination: {
          kind: "auction",
          leagueId: command.leagueId,
          auctionId: command.auctionId,
        },
      },
    });
  }

  function writeNotification(command, {
    notificationId,
    recipient,
  }) {
    const contract = restrictedEligibleContract(
      command,
      recipient
    );
    const result = notifications.insert({
      id: notificationId,
      userId: contract.recipientUserId,
      leagueId: command.leagueId,
      eventType: contract.type,
      messageDataJson: serializeCanonicalJsonV1(
        contract.messageData
      ),
      relatedFeature: "free_agent_draft_auction",
      relatedRecordId: command.auctionId,
      deliveryStatus: "pending",
      createdAtMs: command.activatedAtMs,
      deliveredAtMs: null,
      deduplicationKey: contract.deduplicationKey,
    });
    if (
      result &&
      typeof result.then === "function"
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.transactionAsync,
        "Restricted activation notification writes must be synchronous."
      );
    }
  }

  function validateNotifications(
    command,
    resources,
    notificationIds,
    { fresh }
  ) {
    if (
      !Array.isArray(notificationIds) ||
      notificationIds.length !== resources.participants.length ||
      new Set(notificationIds).size !== notificationIds.length ||
      notificationIds.some(
        (id) => !UUID_PATTERN.test(id || "")
      )
    ) {
      incompatible(
        "The restricted activation notification identity set is invalid.",
        "NOTIFICATION_EVIDENCE_INVALID"
      );
    }
    const rows = notificationReplayStatement.all(command);
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (
      rows.length !== notificationIds.length ||
      byId.size !== rows.length
    ) {
      incompatible(
        "The restricted activation notification evidence is incomplete.",
        "NOTIFICATION_EVIDENCE_INVALID"
      );
    }
    return Object.freeze(
      resources.participants.map((participant, index) => {
        const notificationId = notificationIds[index];
        const notification = byId.get(notificationId);
        if (
          !notification ||
          !UUID_PATTERN.test(notification.user_id || "")
        ) {
          incompatible(
            "The restricted activation notification evidence is incomplete.",
            "NOTIFICATION_EVIDENCE_INVALID"
          );
        }
        const recipient = Object.freeze({
          teamId: participant.team_id,
          userId: notification.user_id,
        });
        const contract = restrictedEligibleContract(
          command,
          recipient
        );
        if (
          notification.league_id !== command.leagueId ||
          notification.event_type !== contract.type ||
          notification.message_data_json !==
            serializeCanonicalJsonV1(contract.messageData) ||
          notification.related_feature !==
            "free_agent_draft_auction" ||
          notification.related_record_id !== command.auctionId ||
          notification.created_at_ms !== command.activatedAtMs ||
          notification.deduplication_key !==
            contract.deduplicationKey ||
          !Number.isSafeInteger(notification.version) ||
          notification.version < 1 ||
          (fresh &&
            (notification.delivery_status !== "pending" ||
              notification.read_at_ms !== null ||
              notification.delivered_at_ms !== null ||
              notification.version !== 1))
        ) {
          incompatible(
            "The restricted activation notification contract is not exact.",
            "NOTIFICATION_EVIDENCE_INVALID"
          );
        }
        return Object.freeze({
          id: notificationId,
          teamId: participant.team_id,
          cardId: participant.source_card_id,
          userId: notification.user_id,
        });
      })
    );
  }

  function writeInvalidation(command, {
    id,
    eventType,
    aggregateType,
    aggregateId,
    version,
    reasonCode,
    teamId = null,
    cardId = null,
    userId = null,
  }) {
    const result = outbox.write({
      id,
      leagueId: command.leagueId,
      eventType,
      aggregateType,
      aggregateId,
      payload: createSocketEventMetadata({
        eventType,
        version,
        reasonCode,
        occurredAtMs: command.activatedAtMs,
        related: createEmptySocketRelated({
          fadId: command.fadId,
          teamId,
          cardId,
          allocationId: command.allocationId,
          auctionId: command.auctionId,
        }),
      }),
      occurredAtMs: command.activatedAtMs,
      audiences:
        userId === null
          ? [{ kind: "league" }]
          : [{ kind: "user", userId }],
    });
    if (
      result &&
      typeof result.then === "function"
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.transactionAsync,
        "Restricted activation outbox writes must be synchronous."
      );
    }
  }

  function validateOutboxes(
    command,
    row,
    outboxEventIds,
    notificationEvidence
  ) {
    const expectedCount = 2 + notificationEvidence.length;
    if (
      !Array.isArray(outboxEventIds) ||
      outboxEventIds.length !== expectedCount ||
      new Set(outboxEventIds).size !== expectedCount ||
      outboxEventIds.some(
        (id) => !UUID_PATTERN.test(id || "")
      )
    ) {
      incompatible(
        "The restricted activation outbox identity set is invalid.",
        "OUTBOX_EVIDENCE_INVALID"
      );
    }
    const expectations = [
      {
        id: outboxEventIds[0],
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: command.fadId,
        version: row.fad_version,
        reasonCode: "allocation_changed",
        teamId: null,
        cardId: null,
        userId: null,
      },
      {
        id: outboxEventIds[1],
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: command.auctionId,
        version: row.auction_version,
        reasonCode: "auction_changed",
        teamId: null,
        cardId: null,
        userId: null,
      },
      ...notificationEvidence.map((notification, index) => ({
        id: outboxEventIds[index + 2],
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: notification.id,
        version: 1,
        reasonCode: "allocation_changed",
        teamId: notification.teamId,
        cardId: notification.cardId,
        userId: notification.userId,
      })),
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
            cardId: expected.cardId,
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
        (expected.userId === null
          ? rows[0].audience_id !== expected.id
          : !UUID_PATTERN.test(rows[0].audience_id || "")) ||
        rows[0].audience_kind !==
          (expected.userId === null ? "league" : "user") ||
        rows[0].audience_team_id !== null ||
        rows[0].audience_user_id !== expected.userId ||
        rows[0].audience_created_at_ms !== command.activatedAtMs
      ) {
        incompatible(
          "The restricted activation outbox evidence is incomplete.",
          "OUTBOX_EVIDENCE_INVALID"
        );
      }
    }
  }

  function projection(row) {
    return deepFreeze({
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      allocationId: row.allocation_id,
      playerId: row.player_id,
      status: row.allocation_status,
      allocationVersion: row.allocation_version,
      auctionId: row.restricted_auction_id,
      rolloverId: row.fad_rollover_id,
      activationAtMs: row.opened_at_ms,
      resolvesAtMs: row.resolves_at_ms,
      activationJobRunId: row.job_run_id,
      activationOccurrenceKey: row.occurrence_key,
      jobStatus: row.job_status,
      jobRunVersion: row.job_version,
    });
  }

  function createIdentityFactory() {
    const issued = new Set();
    return (description) => {
      const id = createId(description);
      canonicalId(id, description);
      if (issued.has(id)) {
        invalid(
          "Restricted activation identifier factories must return unique identifiers.",
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
      auctionId: command.auctionId,
      rolloverId: command.rolloverId,
      activationAtMs: command.activationAtMs,
      activatedAtMs: command.activatedAtMs,
      allocationVersion:
        command.expectedAllocationVersion + 1,
      jobRunId: command.runId,
      jobRunVersion: command.expectedJobVersion + 1,
      sourceRecoveryId,
      evidence,
    });
  }

  function storedResult(command, response) {
    return serializeCanonicalJsonV1({
      schemaVersion: 1,
      operation: "free_agent_draft_restricted_activation",
      identity: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        playerId: command.playerId,
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

  function validateStoredResult(command, row) {
    if (
      row.job_status !== "succeeded" ||
      typeof row.job_result_json !== "string"
    ) {
      return null;
    }
    const stored = parseCanonical(
      row.job_result_json,
      "restricted activation job result"
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
        "stored restricted activation result"
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
        ],
        "stored restricted activation identity"
      );
      exactObject(
        stored.request,
        [
          "activatedAtMs",
          "expectedAllocationVersion",
          "expectedJobVersion",
        ],
        "stored restricted activation request"
      );
    } catch (error) {
      incompatible(
        "The stored restricted activation result shape is invalid.",
        "STORED_RESULT_INVALID",
        error
      );
    }
    const identity = stored.identity;
    const request = stored.request;
    if (
      stored.schemaVersion !== 1 ||
      stored.operation !==
        "free_agent_draft_restricted_activation" ||
      identity.leagueId !== command.leagueId ||
      identity.seasonId !== command.seasonId ||
      identity.fadId !== command.fadId ||
      identity.allocationId !== command.allocationId ||
      identity.playerId !== command.playerId ||
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
        "The stored restricted activation result conflicts with its exact request.",
        "STORED_RESULT_CONFLICT"
      );
    }
    return Object.freeze({
      response: stored.response,
      activatedAtMs: request.activatedAtMs,
    });
  }

  function validateReplay(command, row, storedResult) {
    const { response, activatedAtMs } = storedResult;
    const replayCommand = Object.freeze({
      ...command,
      activatedAtMs,
      resolvesAtMs: row.resolves_at_ms,
    });
    const expected = [
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
      "sourceRecoveryId",
    ];
    exactObject(response, expected, "stored activation response");
    exactObject(
      response.evidence,
      [
        "notificationIds",
        "offerEventIds",
        "outboxEventIds",
        "stateEventId",
      ],
      "stored activation evidence"
    );
    const canonical = responseProjection(
      replayCommand,
      response.evidence,
      response.sourceRecoveryId
    );
    if (
      serializeCanonicalJsonV1(canonical) !==
        serializeCanonicalJsonV1(response) ||
      !canonicalJobShape(row, "succeeded") ||
      row.job_completed_at_ms !== activatedAtMs ||
      row.job_version !== command.expectedJobVersion + 1 ||
      row.allocation_status !== "restricted_active" ||
      row.allocation_version !==
        command.expectedAllocationVersion + 1 ||
      row.allocation_updated_at_ms !== activatedAtMs
    ) {
      incompatible(
        "The persisted restricted activation result is not exact.",
        "REPLAY_STATE_INVALID"
      );
    }
    const resources = readResources(row, { fresh: false });
    const notificationEvidence = validateNotifications(
      replayCommand,
      resources,
      response.evidence.notificationIds,
      { fresh: false }
    );
    const sourceEvidence = readVersionEvidence(
      row,
      command.expectedAllocationVersion
    );
    const activeEvidence = readVersionEvidence(
      row,
      command.expectedAllocationVersion + 1
    );
    validateParticipantOfferCoverage(resources, sourceEvidence);
    const activeById = new Map(
      activeEvidence.offers.map((event) => [event.id, event])
    );
    if (
      !Array.isArray(response.evidence.offerEventIds) ||
      response.evidence.offerEventIds.length !==
        sourceEvidence.offers.length ||
      activeEvidence.offers.length !==
        sourceEvidence.offers.length ||
      sourceEvidence.offers.some(
        (source, index) => {
          const event = activeById.get(
            response.evidence.offerEventIds[index]
          );
          return !event ||
          event.snapshot_entry_id !==
            source.snapshot_entry_id ||
          event.team_id !== source.team_id ||
          event.offer_valid !==
            source.offer_valid ||
          event.rank_position !==
            source.rank_position ||
          event.offer_outcome_code !==
            source.offer_outcome_code ||
          event.activity_id !==
            source.activity_id ||
          event.evidence_json !==
            source.evidence_json ||
          event.occurred_at_ms !== activatedAtMs ||
          event.created_at_ms !== activatedAtMs;
        }
      ) ||
      activeEvidence.state.id !== response.evidence.stateEventId ||
      activeEvidence.state.occurred_at_ms !== activatedAtMs ||
      activeEvidence.state.created_at_ms !== activatedAtMs ||
      activeEvidence.state.activity_id !== null
    ) {
      incompatible(
        "The persisted restricted activation evidence is incomplete.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    if (
      response.sourceRecoveryId !== null &&
      !UUID_PATTERN.test(response.sourceRecoveryId || "")
    ) {
      incompatible(
        "The restricted activation recovery identity is invalid.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    const expectedStateEvidence = serializeCanonicalJsonV1({
      schemaVersion: 1,
      operation: "free_agent_draft_restricted_activation",
      identity: {
        leagueId: replayCommand.leagueId,
        seasonId: replayCommand.seasonId,
        fadId: replayCommand.fadId,
        allocationId: replayCommand.allocationId,
        playerId: replayCommand.playerId,
        auctionId: replayCommand.auctionId,
        rolloverId: replayCommand.rolloverId,
        activationAtMs: replayCommand.activationAtMs,
        occurrenceKey: replayCommand.occurrenceKey,
        jobRunId: replayCommand.runId,
      },
      transition: {
        fromStatus: "restricted_scheduled",
        toStatus: "restricted_active",
        fromAllocationVersion:
          replayCommand.expectedAllocationVersion,
        toAllocationVersion: response.allocationVersion,
        activatedAtMs,
      },
      resources: {
        participantIds: resources.participants.map(
          (participant) => participant.id
        ),
        drawId: resources.draw.id,
        floor: {
          totalValueCents:
            row.restricted_minimum_total_cents,
          termYears: row.restricted_minimum_term_years,
          aavCents: row.restricted_minimum_aav_cents,
        },
      },
      sourceEvidence: {
        offerEventIds: sourceEvidence.offers.map(
          (event) => event.id
        ),
        stateEventId: sourceEvidence.state.id,
      },
      sideEffects: {
        notificationIds: response.evidence.notificationIds,
        outboxEventIds: response.evidence.outboxEventIds,
        sourceRecoveryId: response.sourceRecoveryId,
      },
    });
    if (
      activeEvidence.state.evidence_json !== expectedStateEvidence
    ) {
      incompatible(
        "The restricted activation state-event evidence conflicts with its result.",
        "REPLAY_EVIDENCE_INVALID"
      );
    }
    validateOutboxes(
      replayCommand,
      row,
      response.evidence.outboxEventIds,
      notificationEvidence
    );
    findSourceRecovery(replayCommand, {
      replayed: true,
      sourceRecoveryId: response.sourceRecoveryId,
    });
    return deepFreeze({ ...response, replayed: true });
  }

  const executeTransaction = database.transaction((command) => {
    const row = readActivation(command);
    if (!row) {
      notFound(
        "The exact restricted activation binding was not found.",
        "ACTIVATION_NOT_FOUND"
      );
    }
    validateCore(
      row,
      command,
      ["restricted_scheduled", "restricted_active"]
    );

    if (row.job_status === "succeeded") {
      const replay = validateStoredResult(command, row);
      return validateReplay(command, row, replay);
    }

    if (
      command.activatedAtMs < row.opened_at_ms ||
      command.activatedAtMs >= row.resolves_at_ms
    ) {
      conflict(
        "The restricted activation is outside its full auction window.",
        command.activatedAtMs < row.opened_at_ms
          ? "ACTIVATION_NOT_DUE"
          : "ACTIVATION_WINDOW_CLOSED"
      );
    }
    if (
      row.resolves_at_ms - command.activatedAtMs <=
      MINIMUM_FAIR_ACCESS_MS
    ) {
      conflict(
        "The restricted activation would leave no more than sixty minutes of fair access.",
        "ACTIVATION_FAIR_ACCESS_INSUFFICIENT"
      );
    }

    if (
      row.allocation_status !== "restricted_scheduled" ||
      row.player_id !== command.playerId ||
      row.restricted_auction_id !== command.auctionId ||
      row.fad_rollover_id !== command.rolloverId ||
      row.allocation_version !==
        command.expectedAllocationVersion ||
      row.job_run_id !== command.runId ||
      row.job_status !== "running" ||
      row.job_version !== command.expectedJobVersion ||
      row.job_lease_owner !== command.leaseOwner ||
      row.job_lease_token !== command.leaseToken ||
      row.job_lease_expires_at_ms !==
        command.leaseExpiresAtMs ||
      row.job_lease_expires_at_ms <= command.activatedAtMs ||
      row.job_attempt_count < 1 ||
      !Number.isSafeInteger(row.job_started_at_ms) ||
      row.job_started_at_ms < command.activationAtMs ||
      row.job_started_at_ms > command.activatedAtMs ||
      row.job_updated_at_ms > command.activatedAtMs ||
      row.job_completed_at_ms !== null ||
      row.job_result_json !== null ||
      row.job_last_error_code !== null ||
      row.job_next_attempt_at_ms !== null
    ) {
      conflict(
        "The restricted activation allocation or live job lease changed.",
        "ACTIVATION_FENCE_CHANGED"
      );
    }

    const freshCommand = Object.freeze({
      ...command,
      resolvesAtMs: row.resolves_at_ms,
    });
    const resources = readResources(row, { fresh: true });
    const recipients = readCurrentRecipients(command, resources);
    const sourceEvidence = readVersionEvidence(
      row,
      command.expectedAllocationVersion
    );
    validateParticipantOfferCoverage(resources, sourceEvidence);
    if (
      activeBidsStatement.get(command).count !== 0 ||
      resolutionsStatement.get(command).count !== 0
    ) {
      conflict(
        "The scheduled restricted auction already has bid or resolution state.",
        "ACTIVATION_AUCTION_NOT_PRISTINE"
      );
    }
    const sourceRecovery = findSourceRecovery(freshCommand, {
      replayed: false,
      sourceRecoveryId: null,
    });
    const id = createIdentityFactory();
    const offerEventIds = sourceEvidence.offers.map(() =>
      id("restricted activation offer event")
    );
    const stateEventId = id(
      "restricted activation state event"
    );
    const notificationIds = Object.freeze(
      recipients.map(() =>
        id("restricted activation notification")
      )
    );
    const outboxEventIds = Object.freeze([
      id("restricted activation FAD outbox event"),
      id("restricted activation auction outbox event"),
      ...recipients.map(() =>
        id("restricted activation notification outbox event")
      ),
    ]);
    const evidence = deepFreeze({
      notificationIds,
      offerEventIds: Object.freeze(offerEventIds),
      outboxEventIds,
      stateEventId,
    });
    const response = responseProjection(
      command,
      evidence,
      sourceRecovery?.id || null
    );

    if (
      updateAllocationStatement.run(command).changes !== 1
    ) {
      conflict(
        "The restricted allocation changed before activation committed.",
        "ALLOCATION_CAS_FAILED"
      );
    }

    writeInvalidation(command, {
      id: outboxEventIds[0],
      eventType: "free_agent_draft.changed",
      aggregateType: "free_agent_draft",
      aggregateId: command.fadId,
      version: row.fad_version,
      reasonCode: "allocation_changed",
    });
    writeInvalidation(command, {
      id: outboxEventIds[1],
      eventType: "auction.changed",
      aggregateType: "auction",
      aggregateId: command.auctionId,
      version: row.auction_version,
      reasonCode: "auction_changed",
    });

    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index];
      writeNotification(command, {
        notificationId: notificationIds[index],
        recipient,
      });
      writeInvalidation(command, {
        id: outboxEventIds[index + 2],
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: notificationIds[index],
        version: 1,
        reasonCode: "allocation_changed",
        teamId: recipient.teamId,
        cardId: resources.participants[index].source_card_id,
        userId: recipient.userId,
      });
    }
    validateNotifications(
      command,
      resources,
      notificationIds,
      { fresh: true }
    );

    for (
      let index = 0;
      index < sourceEvidence.offers.length;
      index += 1
    ) {
      const source = sourceEvidence.offers[index];
      insertEventStatement.run({
        ...command,
        eventId: offerEventIds[index],
        allocationVersion: response.allocationVersion,
        eventKind: "offer_considered",
        snapshotEntryId: source.snapshot_entry_id,
        teamId: source.team_id,
        offerValid: source.offer_valid,
        rankPosition: source.rank_position,
        offerOutcomeCode: source.offer_outcome_code,
        decisionCode: null,
        contractId: null,
        ownershipId: null,
        auctionId: null,
        activityId: source.activity_id,
        correctionId: null,
        actorUserId: source.actor_user_id,
        actorMembershipId: source.actor_membership_id,
        actorAuthority: source.actor_authority,
        evidenceJson: source.evidence_json,
      });
    }

    insertEventStatement.run({
      ...command,
      eventId: stateEventId,
      allocationVersion: response.allocationVersion,
      eventKind: "restricted_state_changed",
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode: "exact_total_and_term_tie",
      contractId: null,
      ownershipId: null,
      auctionId: command.auctionId,
      activityId: null,
      correctionId: null,
      actorUserId: null,
      actorMembershipId: null,
      actorAuthority: "system",
      evidenceJson: serializeCanonicalJsonV1({
        schemaVersion: 1,
        operation: "free_agent_draft_restricted_activation",
        identity: {
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          fadId: command.fadId,
          allocationId: command.allocationId,
          playerId: command.playerId,
          auctionId: command.auctionId,
          rolloverId: command.rolloverId,
          activationAtMs: command.activationAtMs,
          occurrenceKey: command.occurrenceKey,
          jobRunId: command.runId,
        },
        transition: {
          fromStatus: "restricted_scheduled",
          toStatus: "restricted_active",
          fromAllocationVersion:
            command.expectedAllocationVersion,
          toAllocationVersion: response.allocationVersion,
          activatedAtMs: command.activatedAtMs,
        },
        resources: {
          participantIds: resources.participants.map(
            (participant) => participant.id
          ),
          drawId: resources.draw.id,
          floor: {
            totalValueCents:
              row.restricted_minimum_total_cents,
            termYears:
              row.restricted_minimum_term_years,
            aavCents: row.restricted_minimum_aav_cents,
          },
        },
        sourceEvidence: {
          offerEventIds: sourceEvidence.offers.map(
            (event) => event.id
          ),
          stateEventId: sourceEvidence.state.id,
        },
        sideEffects: {
          notificationIds,
          outboxEventIds,
          sourceRecoveryId: sourceRecovery?.id || null,
        },
      }),
    });

    if (sourceRecovery) {
      if (
        resolveRecoveryStatement.run({
          ...command,
          sourceRecoveryId: sourceRecovery.id,
        }).changes !== 1
      ) {
        conflict(
          "The restricted activation recovery changed before it resolved.",
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
        "The restricted activation lease changed before job completion.",
        "JOB_TERMINAL_CAS_FAILED"
      );
    }

    if (beforeCommit) {
      const hookResult = beforeCommit({ command, response });
      if (
        hookResult &&
        typeof hookResult.then === "function"
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.transactionAsync,
          "Restricted activation beforeCommit must be synchronous."
        );
      }
    }

    const terminal = readActivation(command);
    validateCore(terminal, command, ["restricted_active"]);
    if (
      terminal.allocation_version !== response.allocationVersion ||
      terminal.allocation_updated_at_ms !== command.activatedAtMs ||
      terminal.job_run_id !== command.runId ||
      terminal.job_status !== "succeeded" ||
      terminal.job_version !== response.jobRunVersion ||
      terminal.job_completed_at_ms !== command.activatedAtMs ||
      terminal.job_result_json !== resultJson ||
      !canonicalJobShape(terminal, "succeeded")
    ) {
      incompatible(
        "The restricted activation terminal state is noncanonical.",
        "ACTIVATION_TERMINAL_STATE_INVALID"
      );
    }
    validateReplay(command, terminal, {
      response,
      activatedAtMs: command.activatedAtMs,
    });
    return deepFreeze({ ...response, replayed: false });
  });

  return Object.freeze({
    findActivation(input = {}) {
      const scope = normalizeFind(input);
      try {
        const row = readActivation(scope);
        if (!row) return null;
        validateCore(
          row,
          scope,
          ["restricted_scheduled", "restricted_active"]
        );
        const fresh =
          row.allocation_status === "restricted_scheduled";
        const resources = readResources(row, { fresh });
        const evidence = readVersionEvidence(
          row,
          fresh
            ? row.allocation_version
            : row.allocation_version - 1
        );
        validateParticipantOfferCoverage(resources, evidence);
        if (!fresh) {
          readVersionEvidence(row, row.allocation_version);
        } else if (
          activeBidsStatement.get({
            leagueId: row.league_id,
            seasonId: row.season_id,
            auctionId: row.restricted_auction_id,
          }).count !== 0 ||
          resolutionsStatement.get({
            leagueId: row.league_id,
            seasonId: row.season_id,
            auctionId: row.restricted_auction_id,
          }).count !== 0
        ) {
          incompatible(
            "The scheduled restricted activation has premature auction state.",
            "ACTIVATION_AUCTION_NOT_PRISTINE"
          );
        }
        if (
          (row.allocation_status === "restricted_scheduled" &&
            !["pending", "leased", "running"].includes(
              row.job_status
            )) ||
          (row.allocation_status === "restricted_active" &&
            row.job_status !== "succeeded") ||
          !canonicalJobShape(row, row.job_status)
        ) {
          incompatible(
            "The restricted activation job state conflicts with its allocation.",
            "ACTIVATION_JOB_STATE_INVALID"
          );
        }
        return projection(row);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findFreeAgentDraftRestrictedActivation",
          tableName: "free_agent_draft_player_allocations",
        });
      }
    },

    executeClaimed(input = {}) {
      const command = normalizeCommand(input);
      if (database.inTransaction) {
        conflict(
          "Restricted activation owns its immediate transaction boundary.",
          "TRANSACTION_ALREADY_ACTIVE"
        );
      }
      try {
        return executeTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "executeClaimedFreeAgentDraftRestrictedActivation",
          tableName: "free_agent_draft_player_allocations",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_JOB_TYPE: JOB_TYPE,
  FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_WRITER_METHODS: METHODS,
  createSqliteFreeAgentDraftRestrictedActivationWriter,
};
