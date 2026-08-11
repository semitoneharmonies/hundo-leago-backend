"use strict";

const {
  createHash,
  randomBytes,
} = require("node:crypto");

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
} = require(
  "../../../domain/leagues/socketInvalidation"
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
const INPUT_FIELDS = Object.freeze([
  "allocationId",
  "expectedAllocationVersion",
  "expectedAuctionVersion",
  "expectedJobVersion",
  "fadId",
  "ids",
  "jobRunId",
  "leagueId",
  "leaseOwner",
  "leaseToken",
  "nowMs",
  "occurrenceKey",
  "seasonId",
  "sourceAuctionId",
]);
const ID_FIELDS = Object.freeze([
  "activityId",
  "allocationStateEventId",
  "auctionOutboxEventId",
  "clonedOfferEventIds",
  "extensionRolloverId",
  "fadOutboxEventId",
  "fallbackActivationJobRunId",
  "fallbackAuctionId",
  "fallbackDrawId",
  "fallbackResolutionJobRunId",
  "notificationIds",
  "sourceAuctionEventId",
  "sourceResolutionId",
]);

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function conflict(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message
  );
}

function incompatible(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message
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
  return value;
}

function uuid(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function nullableUuid(value, description) {
  return value === null
    ? null
    : uuid(value, description);
}

function positiveVersion(value, description) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(`A positive ${description} is required.`);
  }
  return value;
}

function timestamp(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function boundedText(value, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalid(`A bounded ${description} is required.`);
  }
  return value;
}

function uuidArray(value, description) {
  if (!Array.isArray(value)) {
    invalid(`Canonical ${description} are required.`);
  }
  const ids = value.map((entry) =>
    uuid(entry, description)
  );
  if (new Set(ids).size !== ids.length) {
    invalid(`Canonical ${description} must be unique.`);
  }
  return Object.freeze(ids);
}

function deterministicUuid(namespace) {
  const bytes = Buffer.from(
    createHash("sha256")
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

function sourceAuctionOutboxEventId(command) {
  return deterministicUuid(
    "fad:restricted-no-improvement:" +
      `source-auction-outbox:${command.ids.sourceAuctionEventId}`
  );
}

function activityOutboxEventId(activityId) {
  return deterministicUuid(
    `fad:restricted-no-improvement:activity-outbox:${activityId}`
  );
}

function notificationOutboxEventId(notificationId) {
  return deterministicUuid(
    "fad:restricted-no-improvement:" +
      `notification-outbox:${notificationId}`
  );
}

function stateOutboxEventIds(command, delayedActivation) {
  const sourceOutboxEventId =
    sourceAuctionOutboxEventId(command);
  if (delayedActivation) {
    return Object.freeze([sourceOutboxEventId]);
  }
  return Object.freeze([
    command.ids.fadOutboxEventId,
    command.ids.auctionOutboxEventId,
    sourceOutboxEventId,
    activityOutboxEventId(command.ids.activityId),
    ...command.ids.notificationIds.map(
      notificationOutboxEventId
    ),
  ]);
}

function normalize(input) {
  exactObject(
    input,
    INPUT_FIELDS,
    "restricted fallback command"
  );
  const rawIds = exactObject(
    input.ids,
    ID_FIELDS,
    "restricted fallback identifier set"
  );
  const extensionRolloverId =
    nullableUuid(
      rawIds.extensionRolloverId,
      "extension rollover identifier"
    );
  return Object.freeze({
    leagueId: uuid(input.leagueId, "league identifier"),
    seasonId: uuid(input.seasonId, "season identifier"),
    fadId: uuid(input.fadId, "FAD identifier"),
    allocationId: uuid(
      input.allocationId,
      "allocation identifier"
    ),
    sourceAuctionId: uuid(
      input.sourceAuctionId,
      "source auction identifier"
    ),
    occurrenceKey: boundedText(
      input.occurrenceKey,
      "occurrence key"
    ),
    jobRunId: uuid(input.jobRunId, "job identifier"),
    leaseOwner: boundedText(
      input.leaseOwner,
      "lease owner"
    ),
    leaseToken: uuid(
      input.leaseToken,
      "lease token"
    ),
    expectedJobVersion: positiveVersion(
      input.expectedJobVersion,
      "job version"
    ),
    expectedAuctionVersion: positiveVersion(
      input.expectedAuctionVersion,
      "auction version"
    ),
    expectedAllocationVersion: positiveVersion(
      input.expectedAllocationVersion,
      "allocation version"
    ),
    nowMs: timestamp(input.nowMs, "execution timestamp"),
    ids: Object.freeze({
      fallbackAuctionId: uuid(
        rawIds.fallbackAuctionId,
        "fallback auction identifier"
      ),
      fallbackDrawId: uuid(
        rawIds.fallbackDrawId,
        "fallback draw identifier"
      ),
      sourceResolutionId: uuid(
        rawIds.sourceResolutionId,
        "source resolution identifier"
      ),
      sourceAuctionEventId: uuid(
        rawIds.sourceAuctionEventId,
        "source auction event identifier"
      ),
      allocationStateEventId: uuid(
        rawIds.allocationStateEventId,
        "allocation state event identifier"
      ),
      activityId: nullableUuid(
        rawIds.activityId,
        "activity identifier"
      ),
      fadOutboxEventId: nullableUuid(
        rawIds.fadOutboxEventId,
        "FAD outbox identifier"
      ),
      auctionOutboxEventId: nullableUuid(
        rawIds.auctionOutboxEventId,
        "auction outbox identifier"
      ),
      extensionRolloverId,
      fallbackActivationJobRunId: nullableUuid(
        rawIds.fallbackActivationJobRunId,
        "fallback activation job identifier"
      ),
      fallbackResolutionJobRunId: uuid(
        rawIds.fallbackResolutionJobRunId,
        "fallback resolution job identifier"
      ),
      clonedOfferEventIds: uuidArray(
        rawIds.clonedOfferEventIds,
        "cloned offer event identifiers"
      ),
      notificationIds: uuidArray(
        rawIds.notificationIds,
        "notification identifiers"
      ),
    }),
  });
}

function assertChanged(result, description) {
  if (result.changes !== 1) {
    conflict(`${description} changed concurrently.`);
  }
}

function canonicalResult(
  command,
  {
    activationJobRunId,
    fallbackOpensAtMs,
    fallbackResolvesAtMs,
    sourceRecoveryId,
    targetRolloverId,
  }
) {
  const delayedActivation =
    fallbackOpensAtMs > command.nowMs;
  return Object.freeze({
    applied: true,
    replayed: false,
    reason: null,
    leagueId: command.leagueId,
    seasonId: command.seasonId,
    fadId: command.fadId,
    allocationId: command.allocationId,
    allocationVersion:
      command.expectedAllocationVersion + 1,
    sourceAuctionId: command.sourceAuctionId,
    sourceAuctionVersion:
      command.expectedAuctionVersion + 1,
    sourceResolutionId:
      command.ids.sourceResolutionId,
    fallbackAuctionId:
      command.ids.fallbackAuctionId,
    fallbackRolloverId: targetRolloverId,
    fallbackOpensAtMs,
    fallbackResolvesAtMs,
    activationJobRunId,
    activationAtMs: delayedActivation
      ? fallbackOpensAtMs
      : null,
    sourceRecoveryId,
    activityId: delayedActivation
      ? null
      : command.ids.activityId,
    notificationIds: delayedActivation
      ? Object.freeze([])
      : command.ids.notificationIds,
    outboxEventIds: stateOutboxEventIds(
      command,
      delayedActivation
    ),
  });
}

function createSqliteRestrictedNoImprovementFallbackWriter({
  database,
  createDrawNonce = () => randomBytes(32),
  leagueOutboxWriter,
  notificationWriter,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    invalid(
      "Restricted fallback writing requires an opened SQLite database."
    );
  }
  if (typeof createDrawNonce !== "function") {
    invalid(
      "Restricted fallback draw nonce creation must be a function."
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    invalid(
      "Restricted fallback beforeCommit must be a function."
    );
  }
  const outboxWriter =
    resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
  const notifications =
    resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });

  const findResolution = database.prepare(`
    SELECT *
    FROM auction_resolutions
    WHERE league_id = @leagueId
      AND auction_id = @sourceAuctionId
    ORDER BY id
  `);
  const findSource = database.prepare(`
    SELECT
      auction.player_id AS playerId,
      auction.status AS auctionStatus,
      auction.opened_at_ms AS auctionOpenedAtMs,
      auction.resolves_at_ms AS auctionResolvesAtMs,
      auction.version AS auctionVersion,
      context.source_kind AS sourceKind,
      context.fad_id AS contextFadId,
      context.fad_rollover_id AS sourceRolloverId,
      context.fad_allocation_id AS contextAllocationId,
      context.fad_origin AS fadOrigin,
      allocation.status AS allocationStatus,
      allocation.decision_code AS allocationDecisionCode,
      allocation.restricted_auction_id AS restrictedAuctionId,
      allocation.fallback_open_auction_id AS fallbackAuctionId,
      allocation.restricted_minimum_total_cents AS minimumTotalCents,
      allocation.restricted_minimum_term_years AS minimumTermYears,
      allocation.restricted_minimum_aav_cents AS minimumAavCents,
      allocation.winning_snapshot_entry_id AS winningSnapshotEntryId,
      allocation.winning_team_id AS winningTeamId,
      allocation.contract_id AS contractId,
      allocation.ownership_id AS ownershipId,
      allocation.accounted_at_ms AS accountedAtMs,
      allocation.last_error_code AS allocationErrorCode,
      allocation.version AS allocationVersion,
      fad.version AS fadVersion,
      draw.id AS sourceDrawId,
      draw.revealed_at_ms AS sourceDrawRevealedAtMs,
      draw.version AS sourceDrawVersion,
      job.job_type AS jobType,
      job.occurrence_key AS jobOccurrenceKey,
      job.scheduled_for_ms AS jobScheduledForMs,
      job.status AS jobStatus,
      job.attempt_count AS jobAttemptCount,
      job.lease_owner AS jobLeaseOwner,
      job.lease_token AS jobLeaseToken,
      job.lease_expires_at_ms AS jobLeaseExpiresAtMs,
      job.completed_at_ms AS jobCompletedAtMs,
      job.result_json AS jobResultJson,
      job.last_error_code AS jobErrorCode,
      job.next_attempt_at_ms AS jobNextAttemptAtMs,
      job.version AS jobVersion
    FROM auctions AS auction
    JOIN auction_contexts AS context
      ON context.league_id = auction.league_id
     AND context.season_id = auction.season_id
     AND context.auction_id = auction.id
    JOIN free_agent_draft_player_allocations AS allocation
      ON allocation.league_id = context.league_id
     AND allocation.season_id = context.season_id
     AND allocation.fad_id = context.fad_id
     AND allocation.id = context.fad_allocation_id
     AND allocation.player_id = auction.player_id
    JOIN free_agent_drafts AS fad
      ON fad.league_id = allocation.league_id
     AND fad.season_id = allocation.season_id
     AND fad.id = allocation.fad_id
    JOIN free_agent_draft_draws AS draw
      ON draw.league_id = context.league_id
     AND draw.season_id = context.season_id
     AND draw.fad_id = context.fad_id
     AND draw.allocation_id = context.fad_allocation_id
     AND draw.auction_id = context.auction_id
    JOIN job_runs AS job
      ON job.league_id = auction.league_id
     AND job.season_id = auction.season_id
     AND job.id = @jobRunId
    WHERE auction.league_id = @leagueId
      AND auction.season_id = @seasonId
      AND auction.id = @sourceAuctionId
      AND context.fad_id = @fadId
      AND context.fad_allocation_id = @allocationId
  `);
  const findTargetRollovers = database.prepare(`
    SELECT
      target.id,
      target.sequence,
      target.predecessor_rollover_id AS predecessorRolloverId,
      target.opens_at_ms AS opensAtMs,
      target.creation_cutoff_at_ms AS cutoffAtMs,
      target.rolls_over_at_ms AS rollsOverAtMs,
      target.status,
      predecessor.predecessor_rollover_id AS predecessorPredecessorId,
      predecessor.sequence AS predecessorSequence,
      predecessor.opens_at_ms AS predecessorOpensAtMs,
      predecessor.rolls_over_at_ms AS predecessorRollsOverAtMs,
      predecessor.status AS predecessorStatus
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
      AND target.rolls_over_at_ms =
          target.opens_at_ms + 86400000
      AND target.creation_cutoff_at_ms =
          target.rolls_over_at_ms - 3600000
      AND target.status IN ('scheduled', 'processing')
    ORDER BY target.opens_at_ms, target.id
  `);
  const findSourceRollover = database.prepare(`
    SELECT
      rollover.id,
      rollover.sequence,
      rollover.predecessor_rollover_id AS predecessorRolloverId,
      rollover.opens_at_ms AS opensAtMs,
      rollover.creation_cutoff_at_ms AS cutoffAtMs,
      rollover.rolls_over_at_ms AS rollsOverAtMs,
      rollover.status
    FROM auction_contexts AS context
    JOIN free_agent_draft_rollovers AS rollover
      ON rollover.league_id = context.league_id
     AND rollover.season_id = context.season_id
     AND rollover.fad_id = context.fad_id
     AND rollover.id = context.fad_rollover_id
    WHERE context.league_id = @leagueId
      AND context.season_id = @seasonId
      AND context.auction_id = @sourceAuctionId
      AND context.fad_id = @fadId
      AND context.fad_allocation_id = @allocationId
  `);
  const findExtensionPredecessors = database.prepare(`
    SELECT
      rollover.id,
      rollover.sequence,
      rollover.predecessor_rollover_id AS predecessorRolloverId,
      rollover.opens_at_ms AS opensAtMs,
      rollover.creation_cutoff_at_ms AS cutoffAtMs,
      rollover.rolls_over_at_ms AS rollsOverAtMs,
      rollover.status
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
      CASE WHEN rollover.rolls_over_at_ms = @nowMs
        THEN 0 ELSE 1 END,
      rollover.sequence DESC,
      rollover.id
  `);
  const findSourceRecoveries = database.prepare(`
    SELECT *
    FROM free_agent_draft_recoveries
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND fad_id = @fadId
      AND allocation_id = @allocationId
      AND auction_id = @sourceAuctionId
      AND job_run_id = @jobRunId
      AND kind = 'auction_resolution'
      AND status = 'running'
    ORDER BY id
  `);
  const findDelayedRetryEvidence = database.prepare(`
    SELECT receipt.id
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
      AND recovery.id = @sourceRecoveryId
      AND recovery.player_id = @playerId
      AND recovery.allocation_id = @allocationId
      AND recovery.rollover_id = @sourceRolloverId
      AND recovery.auction_id = @sourceAuctionId
      AND recovery.job_run_id = @jobRunId
      AND recovery.kind = 'auction_resolution'
      AND recovery.status = 'running'
      AND recovery.last_error_code IS NOT NULL
      AND recovery.created_by_operation_id = @jobRunId
      AND recovery.resolved_at_ms IS NULL
      AND recovery.created_at_ms <= failure_event.occurred_at_ms
      AND recovery.updated_at_ms <= @nowMs
      AND failure_event.occurred_at_ms <= @nowMs
      AND failure_event.actor_user_id IS NULL
      AND failure_event.bid_id IS NULL
      AND failure_event.team_id IS NULL
      AND json_valid(failure_event.metadata_json) = 1
      AND json_type(failure_event.metadata_json) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(failure_event.metadata_json)
      ) = 3
      AND json_extract(
            failure_event.metadata_json,
            '$.recoveryId'
          ) = recovery.id
      AND json_extract(
            failure_event.metadata_json,
            '$.jobRunId'
          ) = recovery.job_run_id
      AND json_extract(
            failure_event.metadata_json,
            '$.errorCode'
          ) = recovery.last_error_code
      AND receipt.action = 'retry_auction_resolution'
      AND receipt.resource_kind = 'auction'
      AND receipt.resource_id = @sourceAuctionId
      AND receipt.operation_id = @jobRunId
      AND receipt.occurrence_key = @occurrenceKey
      AND receipt.accepted_status = 'pending'
      AND receipt.accepted_at_ms >= failure_event.occurred_at_ms
      AND receipt.accepted_at_ms <= @nowMs
      AND request.status = 'completed'
      AND request.result_type =
          'free_agent_draft_recovery_action_command_result'
      AND request.result_id = receipt.id
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
        FROM free_agent_draft_recovery_action_command_results AS later
        WHERE later.league_id = receipt.league_id
          AND later.recovery_id = receipt.recovery_id
          AND later.action = 'retry_auction_resolution'
          AND later.accepted_at_ms > receipt.accepted_at_ms
          AND later.accepted_at_ms <= @nowMs
      )
    ORDER BY receipt.accepted_at_ms DESC, receipt.id
  `);
  const findEligibleImprovements = database.prepare(`
    SELECT bid.id
    FROM auction_bids AS bid
    JOIN free_agent_draft_auction_participants AS participant
      ON participant.league_id = bid.league_id
     AND participant.season_id = bid.season_id
     AND participant.auction_id = bid.auction_id
     AND participant.team_id = bid.team_id
     AND participant.active_improvement_bid_id = bid.id
    JOIN teams
      ON teams.league_id = bid.league_id
     AND teams.id = bid.team_id
    WHERE bid.league_id = @leagueId
      AND bid.season_id = @seasonId
      AND bid.auction_id = @sourceAuctionId
      AND bid.status = 'active'
      AND participant.status = 'active'
      AND teams.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM auction_events AS submission
        JOIN league_memberships AS historical_membership
          ON historical_membership.league_id = submission.league_id
         AND historical_membership.id = json_extract(
              submission.metadata_json,
              '$.actorMembershipId'
            )
         AND historical_membership.user_id = submission.actor_user_id
        WHERE submission.league_id = bid.league_id
          AND submission.season_id = bid.season_id
          AND submission.auction_id = bid.auction_id
          AND submission.bid_id = bid.id
          AND submission.team_id = bid.team_id
          AND submission.actor_user_id = bid.submitted_by_user_id
          AND submission.event_type IN (
            'auction_started',
            'bid_submitted'
          )
          AND submission.occurred_at_ms = bid.first_submitted_at_ms
          AND historical_membership.status IN (
            'active',
            'ended',
            'suspended'
          )
          AND historical_membership.joined_at_ms IS NOT NULL
          AND historical_membership.joined_at_ms <=
              submission.occurred_at_ms
          AND (
            historical_membership.ended_at_ms IS NULL
            OR historical_membership.ended_at_ms >
                submission.occurred_at_ms
          )
          AND json_extract(
                submission.metadata_json,
                '$.actorAuthority'
              ) = historical_membership.permission_category
          AND (
            historical_membership.permission_category = 'commissioner'
            OR (
              historical_membership.permission_category = 'manager'
              AND EXISTS (
                SELECT 1
                FROM team_manager_assignments AS historical_assignment
                WHERE historical_assignment.league_id = bid.league_id
                  AND historical_assignment.team_id = bid.team_id
                  AND historical_assignment.user_id =
                      bid.submitted_by_user_id
                  AND historical_assignment.membership_id =
                      historical_membership.id
                  AND historical_assignment.assigned_at_ms <=
                      submission.occurred_at_ms
                  AND historical_assignment.accepted_at_ms IS NOT NULL
                  AND historical_assignment.accepted_at_ms <=
                      submission.occurred_at_ms
                  AND (
                    historical_assignment.ended_at_ms IS NULL
                    OR historical_assignment.ended_at_ms >
                        submission.occurred_at_ms
                  )
              )
            )
          )
      )
      AND (
        bid.total_value_cents > @minimumTotalCents
        OR (
          bid.total_value_cents = @minimumTotalCents
          AND (
            (bid.total_value_cents / bid.term_years)
            + CASE
                WHEN
                  (bid.total_value_cents % bid.term_years) * 2
                    >= bid.term_years
                THEN 1
                ELSE 0
              END
          ) > @minimumAavCents
        )
      )
    ORDER BY bid.id
  `);
  const countActiveBids = database.prepare(`
    SELECT COUNT(*) AS count
    FROM auction_bids
    WHERE league_id = @leagueId
      AND auction_id = @sourceAuctionId
      AND status = 'active'
  `);
  const invalidateNonContendingBids = database.prepare(`
    UPDATE auction_bids
    SET status = 'invalid',
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND auction_id = @sourceAuctionId
      AND status = 'active'
  `);
  const findOfferEvents = database.prepare(`
    SELECT *
    FROM free_agent_draft_allocation_events
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND fad_id = @fadId
      AND allocation_id = @allocationId
      AND allocation_version = @expectedAllocationVersion
      AND event_kind = 'offer_considered'
    ORDER BY snapshot_entry_id, id
  `);
  const findRecipients = database.prepare(`
    SELECT DISTINCT
      assignment.user_id AS userId,
      assignment.team_id AS teamId
    FROM candidate_card_snapshots AS snapshot
    JOIN team_manager_assignments AS assignment
      ON assignment.league_id = snapshot.league_id
     AND assignment.team_id = snapshot.team_id
    JOIN league_memberships AS membership
      ON membership.league_id = assignment.league_id
     AND membership.id = assignment.membership_id
     AND membership.user_id = assignment.user_id
    JOIN users
      ON users.id = assignment.user_id
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
    ORDER BY assignment.team_id, assignment.user_id
  `);

  const insertAuction = database.prepare(`
    INSERT INTO auctions (
      id, league_id, season_id, player_id, status,
      opened_at_ms, resolves_at_ms, opened_by_user_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      @fallbackAuctionId, @leagueId, @seasonId, @playerId, 'open',
      @fallbackOpensAtMs, @fallbackResolvesAtMs, NULL,
      @fallbackOpensAtMs, @fallbackOpensAtMs, 1
    )
  `);
  const updateAllocation = database.prepare(`
    UPDATE free_agent_draft_player_allocations
    SET status = 'restricted_fallback_open',
        decision_code = 'restricted_no_improvement_fallback',
        fallback_open_auction_id = @fallbackAuctionId,
        updated_at_ms = @nowMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND fad_id = @fadId
      AND id = @allocationId
      AND status = 'restricted_active'
      AND decision_code = 'exact_total_and_term_tie'
      AND restricted_auction_id = @sourceAuctionId
      AND fallback_open_auction_id IS NULL
      AND version = @expectedAllocationVersion
  `);
  const insertContext = database.prepare(`
    INSERT INTO auction_contexts (
      id, league_id, season_id, auction_id, source_kind,
      fad_id, fad_rollover_id, fad_allocation_id,
      fad_origin, created_at_ms
    ) VALUES (
      @fallbackAuctionId, @leagueId, @seasonId,
      @fallbackAuctionId, 'fad_open_rapid',
      @fadId, @targetRolloverId, @allocationId,
      'restricted_no_improvement_fallback', @fallbackOpensAtMs
    )
  `);
  const insertDraw = database.prepare(`
    INSERT INTO free_agent_draft_draws (
      id, league_id, season_id, fad_id, allocation_id,
      auction_id, algorithm_version, nonce_bytes,
      commitment_hex, ordered_tied_bid_ids_json,
      ordered_tied_team_ids_json, rejection_counter,
      selected_index, selected_bid_id, selected_team_id,
      selected_digest_hex, revealed_at_ms, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      @fallbackDrawId, @leagueId, @seasonId, @fadId,
      @allocationId, @fallbackAuctionId, 1, @nonceBytes,
      @commitmentHex, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, @fallbackOpensAtMs, @fallbackOpensAtMs, 1
    )
  `);
  const insertFallbackJob = database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type, occurrence_key,
      scheduled_for_ms, status, attempt_count, lease_owner,
      lease_expires_at_ms, started_at_ms, completed_at_ms,
      result_json, last_error_code, created_at_ms, updated_at_ms,
      version, lease_token, next_attempt_at_ms
    ) VALUES (
      @fallbackResolutionJobRunId, @leagueId, @seasonId,
      'auction.resolve.target', @fallbackOccurrenceKey,
      @fallbackResolvesAtMs, 'pending', 0, NULL, NULL, NULL,
      NULL, NULL, NULL, @nowMs, @nowMs, 1, NULL,
      @fallbackResolvesAtMs
    )
  `);
  const insertFallbackActivationJob = database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type, occurrence_key,
      scheduled_for_ms, status, attempt_count, lease_owner,
      lease_expires_at_ms, started_at_ms, completed_at_ms,
      result_json, last_error_code, created_at_ms, updated_at_ms,
      version, lease_token, next_attempt_at_ms
    ) VALUES (
      @fallbackActivationJobRunId, @leagueId, @seasonId,
      'fad_fallback_activation', @fallbackActivationOccurrenceKey,
      @fallbackOpensAtMs, 'pending', 0, NULL, NULL, NULL,
      NULL, NULL, NULL, @nowMs, @nowMs, 1, NULL, NULL
    )
  `);
  const insertExtensionRollover = database.prepare(`
    INSERT INTO free_agent_draft_rollovers (
      id, league_id, season_id, fad_id, sequence, window_kind,
      predecessor_rollover_id, extension_reason,
      extension_source_id, opens_at_ms, creation_cutoff_at_ms,
      rolls_over_at_ms, status, processing_job_run_id,
      processing_started_at_ms, completed_at_ms, last_error_code,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      @extensionRolloverId, @leagueId, @seasonId, @fadId,
      @extensionSequence, 'extension', @extensionPredecessorRolloverId,
      'fallback_auction', @allocationId, @fallbackOpensAtMs,
      @fallbackCutoffAtMs, @fallbackResolvesAtMs, 'scheduled',
      NULL, NULL, NULL, NULL, @nowMs, @nowMs, 1
    )
  `);
  const insertAuctionEvent = database.prepare(`
    INSERT INTO auction_events (
      id, league_id, season_id, auction_id, bid_id,
      team_id, actor_user_id, event_type, metadata_json,
      occurred_at_ms
    ) VALUES (
      @sourceAuctionEventId, @leagueId, @seasonId,
      @sourceAuctionId, NULL, NULL, NULL,
      'auction_no_winner', @metadataJson, @nowMs
    )
  `);
  const insertResolution = database.prepare(`
    INSERT INTO auction_resolutions (
      id, league_id, season_id, auction_id,
      scheduled_occurrence_key, outcome_code,
      winning_team_id, winning_bid_id, highest_bid_cents,
      second_price_input_cents, final_contract_value_cents,
      winning_term_years, final_aav_cents, general_illegal,
      warnings_json, contract_id, ownership_id, trigger_type,
      triggered_by_user_id, idempotency_key, status,
      resolved_at_ms
    ) VALUES (
      @sourceResolutionId, @leagueId, @seasonId,
      @sourceAuctionId, @occurrenceKey, 'no_winner',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, '[]',
      NULL, NULL, 'automatic', NULL, @occurrenceKey,
      'no_winner', @nowMs
    )
  `);
  const revealSourceDraw = database.prepare(`
    UPDATE free_agent_draft_draws
    SET ordered_tied_bid_ids_json = '[]',
        ordered_tied_team_ids_json = '[]',
        rejection_counter = NULL,
        selected_index = NULL,
        selected_bid_id = NULL,
        selected_team_id = NULL,
        selected_digest_hex = NULL,
        revealed_at_ms = @nowMs,
        updated_at_ms = @nowMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND auction_id = @sourceAuctionId
      AND revealed_at_ms IS NULL
      AND version = 1
  `);
  const terminalizeSource = database.prepare(`
    UPDATE auctions
    SET status = 'no_winner',
        updated_at_ms = @nowMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND id = @sourceAuctionId
      AND status = 'resolving'
      AND version = @expectedAuctionVersion
  `);
  const insertActivity = database.prepare(`
    INSERT INTO league_activity (
      id, league_id, season_id, event_type, actor_user_id,
      actor_authority, team_id, player_id, related_type,
      related_id, display_summary, reason, metadata_json,
      occurred_at_ms
    ) VALUES (
      @activityId, @leagueId, @seasonId,
      'free_agent_draft_restricted_fallback_opened', NULL,
      'system', NULL, @playerId, 'free_agent_draft_allocation',
      @allocationId,
      'A restricted Free Agent Draft auction closed without an improvement and opened a league-wide fallback auction.',
      NULL, @metadataJson, @nowMs
    )
  `);
  const insertAllocationEvent = database.prepare(`
    INSERT INTO free_agent_draft_allocation_events (
      id, league_id, season_id, fad_id, allocation_id,
      allocation_version, player_id, event_kind,
      snapshot_entry_id, team_id, offer_valid, rank_position,
      offer_outcome_code, decision_code,
      resulting_allocation_status, contract_id, ownership_id,
      auction_id, activity_id, correction_id, actor_user_id,
      actor_membership_id, actor_authority, evidence_json,
      occurred_at_ms, created_at_ms, version
    ) VALUES (
      @id, @leagueId, @seasonId, @fadId, @allocationId,
      @allocationVersion, @playerId, @eventKind,
      @snapshotEntryId, @teamId, @offerValid, @rankPosition,
      @offerOutcomeCode, @decisionCode,
      'restricted_fallback_open', @contractId, @ownershipId,
      @auctionId, @activityId, @correctionId, @actorUserId,
      @actorMembershipId, @actorAuthority, @evidenceJson,
      @nowMs, @nowMs, 1
    )
  `);
  const succeedSourceJob = database.prepare(`
    UPDATE job_runs
    SET status = 'succeeded',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @nowMs,
        result_json = @resultJson,
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @nowMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND id = @jobRunId
      AND job_type = 'auction.resolve.target'
      AND occurrence_key = @occurrenceKey
      AND status IN ('leased', 'running')
      AND lease_owner = @leaseOwner
      AND lease_token = @leaseToken
      AND lease_expires_at_ms > @nowMs
      AND version = @expectedJobVersion
  `);
  const resolveSourceRecovery = database.prepare(`
    UPDATE free_agent_draft_recoveries
    SET status = 'resolved',
        last_error_code = NULL,
        resolved_by_user_id = NULL,
        resolved_by_membership_id = NULL,
        resolved_authority = 'system',
        updated_at_ms = @nowMs,
        resolved_at_ms = @nowMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND fad_id = @fadId
      AND id = @sourceRecoveryId
      AND allocation_id = @allocationId
      AND auction_id = @sourceAuctionId
      AND job_run_id = @jobRunId
      AND kind = 'auction_resolution'
      AND status = 'running'
      AND resolved_at_ms IS NULL
  `);

  function replay(command, resolutions) {
    if (resolutions.length === 0) return null;
    if (resolutions.length !== 1) {
      incompatible(
        "Restricted fallback source resolution evidence is not unique."
      );
    }
    const resolution = resolutions[0];
    if (
      resolution.scheduled_occurrence_key !==
        command.occurrenceKey ||
      resolution.outcome_code !== "no_winner" ||
      resolution.status !== "no_winner" ||
      resolution.winning_team_id !== null ||
      resolution.winning_bid_id !== null ||
      resolution.highest_bid_cents !== null ||
      resolution.second_price_input_cents !== null ||
      resolution.final_contract_value_cents !== null ||
      resolution.winning_term_years !== null ||
      resolution.final_aav_cents !== null ||
      resolution.contract_id !== null ||
      resolution.ownership_id !== null ||
      resolution.general_illegal !== 0 ||
      resolution.warnings_json !== "[]" ||
      resolution.trigger_type !== "automatic" ||
      resolution.triggered_by_user_id !== null ||
      resolution.idempotency_key !== command.occurrenceKey
    ) {
      conflict(
        "The source auction already has different resolution evidence."
      );
    }
    const row = database.prepare(`
      SELECT
        source.player_id AS playerId,
        source.status AS sourceStatus,
        source.updated_at_ms AS sourceUpdatedAtMs,
        source.version AS sourceVersion,
        source_context.source_kind AS sourceKind,
        source_context.fad_origin AS sourceOrigin,
        allocation.status AS allocationStatus,
        allocation.decision_code AS allocationDecisionCode,
        allocation.fallback_open_auction_id AS fallbackAuctionId,
        allocation.updated_at_ms AS allocationUpdatedAtMs,
        allocation.version AS allocationVersion,
        fad.version AS fadVersion,
        fallback.status AS fallbackStatus,
        fallback.opened_at_ms AS fallbackOpenedAtMs,
        fallback.resolves_at_ms AS fallbackResolvesAtMs,
        fallback.opened_by_user_id AS fallbackOpenedByUserId,
        fallback.version AS fallbackVersion,
        fallback_context.source_kind AS fallbackSourceKind,
        fallback_context.fad_id AS fallbackFadId,
        fallback_context.fad_allocation_id AS fallbackAllocationId,
        fallback_context.fad_origin AS fallbackOrigin,
        fallback_context.fad_rollover_id AS fallbackRolloverId,
        fallback_draw.id AS fallbackDrawId,
        fallback_draw.algorithm_version AS fallbackDrawAlgorithm,
        fallback_draw.ordered_tied_bid_ids_json AS fallbackBidIds,
        fallback_draw.ordered_tied_team_ids_json AS fallbackTeamIds,
        fallback_draw.rejection_counter AS fallbackCounter,
        fallback_draw.selected_index AS fallbackSelectedIndex,
        fallback_draw.selected_bid_id AS fallbackSelectedBidId,
        fallback_draw.selected_team_id AS fallbackSelectedTeamId,
        fallback_draw.selected_digest_hex AS fallbackDigest,
        fallback_draw.revealed_at_ms AS fallbackRevealedAtMs,
        fallback_draw.version AS fallbackDrawVersion,
        source_draw.ordered_tied_bid_ids_json AS sourceBidIds,
        source_draw.ordered_tied_team_ids_json AS sourceTeamIds,
        source_draw.rejection_counter AS sourceCounter,
        source_draw.selected_index AS sourceSelectedIndex,
        source_draw.selected_bid_id AS sourceSelectedBidId,
        source_draw.selected_team_id AS sourceSelectedTeamId,
        source_draw.selected_digest_hex AS sourceDigest,
        source_draw.revealed_at_ms AS sourceRevealedAtMs,
        source_draw.version AS sourceDrawVersion,
        source_job.id AS sourceJobId,
        source_job.occurrence_key AS sourceJobOccurrenceKey,
        source_job.status AS sourceJobStatus,
        source_job.lease_owner AS sourceJobLeaseOwner,
        source_job.lease_token AS sourceJobLeaseToken,
        source_job.lease_expires_at_ms AS sourceJobLeaseExpiresAtMs,
        source_job.completed_at_ms AS sourceJobCompletedAtMs,
        source_job.result_json AS sourceJobResultJson,
        source_job.last_error_code AS sourceJobErrorCode,
        source_job.next_attempt_at_ms AS sourceJobNextAttemptAtMs,
        source_job.version AS sourceJobVersion,
        fallback_job.id AS fallbackJobId,
        fallback_job.occurrence_key AS fallbackJobOccurrenceKey,
        fallback_job.scheduled_for_ms AS fallbackJobScheduledForMs,
        fallback_job.status AS fallbackJobStatus,
        fallback_job.attempt_count AS fallbackJobAttemptCount,
        fallback_job.lease_owner AS fallbackJobLeaseOwner,
        fallback_job.lease_token AS fallbackJobLeaseToken,
        fallback_job.completed_at_ms AS fallbackJobCompletedAtMs,
        fallback_job.result_json AS fallbackJobResultJson,
        fallback_job.last_error_code AS fallbackJobErrorCode,
        fallback_job.next_attempt_at_ms AS fallbackJobNextAttemptAtMs,
        fallback_job.version AS fallbackJobVersion,
        (
          SELECT COUNT(*)
          FROM auction_bids
          WHERE auction_bids.league_id = fallback.league_id
            AND auction_bids.auction_id = fallback.id
        ) AS fallbackBidCount,
        (
          SELECT COUNT(*)
          FROM auction_resolutions AS fallback_resolution
          WHERE fallback_resolution.league_id = fallback.league_id
            AND fallback_resolution.auction_id = fallback.id
        ) AS fallbackResolutionCount
      FROM auctions AS source
      JOIN auction_contexts AS source_context
        ON source_context.league_id = source.league_id
       AND source_context.auction_id = source.id
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = source_context.league_id
       AND allocation.id = source_context.fad_allocation_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = allocation.league_id
       AND fad.season_id = allocation.season_id
       AND fad.id = source_context.fad_id
      JOIN auctions AS fallback
        ON fallback.league_id = allocation.league_id
       AND fallback.id = allocation.fallback_open_auction_id
      JOIN auction_contexts AS fallback_context
        ON fallback_context.league_id = fallback.league_id
       AND fallback_context.auction_id = fallback.id
      JOIN free_agent_draft_draws AS fallback_draw
        ON fallback_draw.league_id = fallback.league_id
       AND fallback_draw.auction_id = fallback.id
      JOIN free_agent_draft_draws AS source_draw
        ON source_draw.league_id = source.league_id
       AND source_draw.auction_id = source.id
      JOIN job_runs AS source_job
        ON source_job.league_id = source.league_id
       AND source_job.id = @jobRunId
      JOIN job_runs AS fallback_job
        ON fallback_job.league_id = fallback.league_id
       AND fallback_job.season_id = fallback.season_id
       AND fallback_job.job_type = 'auction.resolve.target'
       AND fallback_job.occurrence_key =
            'auction:' || fallback.id || ':' || fallback.resolves_at_ms
       AND fallback_job.scheduled_for_ms = fallback.resolves_at_ms
      WHERE source.league_id = @leagueId
        AND source.season_id = @seasonId
        AND source.id = @sourceAuctionId
        AND source_context.fad_id = @fadId
        AND source_context.fad_allocation_id = @allocationId
    `).get(command);
    const expectedJobResult = JSON.stringify({
      auctionId: command.sourceAuctionId,
      outcome: "no_winner",
    });
    if (
      !row ||
      row.sourceStatus !== "no_winner" ||
      row.sourceUpdatedAtMs !== resolution.resolved_at_ms ||
      row.sourceVersion !==
        command.expectedAuctionVersion + 1 ||
      row.sourceKind !== "fad_restricted" ||
      row.sourceOrigin !== "candidate_tie_restricted" ||
      row.allocationStatus !==
        "restricted_fallback_open" ||
      row.allocationDecisionCode !==
        "restricted_no_improvement_fallback" ||
      row.allocationUpdatedAtMs !==
        resolution.resolved_at_ms ||
      row.allocationVersion !==
        command.expectedAllocationVersion + 1 ||
      row.fallbackStatus !== "open" ||
      row.fallbackOpenedAtMs < resolution.resolved_at_ms ||
      row.fallbackResolvesAtMs !==
        row.fallbackOpenedAtMs + DAY_MS ||
      row.fallbackOpenedByUserId !== null ||
      row.fallbackVersion !== 1 ||
      row.fallbackSourceKind !== "fad_open_rapid" ||
      row.fallbackFadId !== command.fadId ||
      row.fallbackAllocationId !== command.allocationId ||
      row.fallbackOrigin !==
        "restricted_no_improvement_fallback" ||
      row.fallbackDrawAlgorithm !== 1 ||
      row.fallbackBidIds !== null ||
      row.fallbackTeamIds !== null ||
      row.fallbackCounter !== null ||
      row.fallbackSelectedIndex !== null ||
      row.fallbackSelectedBidId !== null ||
      row.fallbackSelectedTeamId !== null ||
      row.fallbackDigest !== null ||
      row.fallbackRevealedAtMs !== null ||
      row.fallbackDrawVersion !== 1 ||
      row.sourceBidIds !== "[]" ||
      row.sourceTeamIds !== "[]" ||
      row.sourceCounter !== null ||
      row.sourceSelectedIndex !== null ||
      row.sourceSelectedBidId !== null ||
      row.sourceSelectedTeamId !== null ||
      row.sourceDigest !== null ||
      row.sourceRevealedAtMs !== resolution.resolved_at_ms ||
      row.sourceDrawVersion !== 2 ||
      row.sourceJobId !== command.jobRunId ||
      row.sourceJobOccurrenceKey !== command.occurrenceKey ||
      row.sourceJobStatus !== "succeeded" ||
      row.sourceJobLeaseOwner !== null ||
      row.sourceJobLeaseToken !== null ||
      row.sourceJobLeaseExpiresAtMs !== null ||
      row.sourceJobCompletedAtMs !== resolution.resolved_at_ms ||
      row.sourceJobResultJson !== expectedJobResult ||
      row.sourceJobErrorCode !== null ||
      row.sourceJobNextAttemptAtMs !== null ||
      row.sourceJobVersion !== command.expectedJobVersion + 1 ||
      row.fallbackJobOccurrenceKey !==
        `auction:${row.fallbackAuctionId}:${row.fallbackResolvesAtMs}` ||
      row.fallbackJobScheduledForMs !== row.fallbackResolvesAtMs ||
      row.fallbackJobStatus !== "pending" ||
      row.fallbackJobAttemptCount !== 0 ||
      row.fallbackJobLeaseOwner !== null ||
      row.fallbackJobLeaseToken !== null ||
      row.fallbackJobCompletedAtMs !== null ||
      row.fallbackJobResultJson !== null ||
      row.fallbackJobErrorCode !== null ||
      row.fallbackJobNextAttemptAtMs !==
        row.fallbackResolvesAtMs ||
      row.fallbackJobVersion !== 1 ||
      row.fallbackBidCount !== 0 ||
      row.fallbackResolutionCount !== 0
    ) {
      conflict(
        "The persisted restricted fallback replay evidence changed."
      );
    }

    const terminalEvents = database.prepare(`
      SELECT id, metadata_json AS metadataJson
      FROM auction_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @sourceAuctionId
        AND event_type = 'auction_no_winner'
        AND occurred_at_ms = @resolvedAtMs
      ORDER BY id
    `).all({
      ...command,
      resolvedAtMs: resolution.resolved_at_ms,
    });
    let terminalMetadata;
    try {
      terminalMetadata = JSON.parse(
        terminalEvents[0]?.metadataJson
      );
    } catch {
      terminalMetadata = null;
    }
    if (
      terminalEvents.length !== 1 ||
      !isPlainObject(terminalMetadata) ||
      terminalMetadata.outcome !== "no_winner" ||
      terminalMetadata.resolutionId !== resolution.id ||
      terminalMetadata.fallbackAuctionId !==
        row.fallbackAuctionId
    ) {
      conflict(
        "The persisted restricted fallback terminal event changed."
      );
    }

    const stateEvents = database.prepare(`
      SELECT id, activity_id AS activityId,
             evidence_json AS evidenceJson
      FROM free_agent_draft_allocation_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND allocation_version = @allocationVersion
        AND event_kind = 'fallback_state_changed'
        AND decision_code = 'restricted_no_improvement_fallback'
        AND resulting_allocation_status = 'restricted_fallback_open'
        AND auction_id = @fallbackAuctionId
        AND occurred_at_ms = @resolvedAtMs
      ORDER BY id
    `).all({
      ...command,
      allocationVersion: row.allocationVersion,
      fallbackAuctionId: row.fallbackAuctionId,
      resolvedAtMs: resolution.resolved_at_ms,
    });
    const offerEvents = database.prepare(`
      SELECT id
      FROM free_agent_draft_allocation_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND allocation_version = @allocationVersion
        AND event_kind = 'offer_considered'
        AND resulting_allocation_status = 'restricted_fallback_open'
      ORDER BY snapshot_entry_id, id
    `).all({
      ...command,
      allocationVersion: row.allocationVersion,
    });
    let stateEvidence;
    try {
      stateEvidence = JSON.parse(
        stateEvents[0]?.evidenceJson
      );
    } catch {
      stateEvidence = null;
    }
    const delayedActivation =
      row.fallbackOpenedAtMs > resolution.resolved_at_ms;
    const activationJobRunId =
      stateEvidence?.activationJobRunId ?? null;
    const sourceRecoveryId =
      stateEvidence?.sourceRecoveryId ?? null;
    if (
      stateEvents.length !== 1 ||
      offerEvents.length === 0 ||
      !isPlainObject(stateEvidence) ||
      stateEvidence.schemaVersion !== 1 ||
      stateEvidence.occurrenceKey !==
        command.occurrenceKey ||
      stateEvidence.sourceAuctionId !==
        command.sourceAuctionId ||
      stateEvidence.fallbackAuctionId !==
        row.fallbackAuctionId ||
      stateEvidence.targetRolloverId !==
        row.fallbackRolloverId ||
      stateEvidence.activityId !==
        stateEvents[0].activityId ||
      (delayedActivation
        ? stateEvents[0].activityId !== null ||
          !UUID_PATTERN.test(activationJobRunId || "") ||
          stateEvidence.activationAtMs !==
            row.fallbackOpenedAtMs
        : !UUID_PATTERN.test(
            stateEvents[0].activityId || ""
          ) ||
          activationJobRunId !== null ||
          stateEvidence.activationAtMs !== null) ||
      (sourceRecoveryId !== null &&
        !UUID_PATTERN.test(sourceRecoveryId || "")) ||
      !Array.isArray(
        stateEvidence.notificationIds
      ) ||
      stateEvidence.notificationIds.some(
        (id) => !UUID_PATTERN.test(id || "")
      ) ||
      new Set(stateEvidence.notificationIds).size !==
        stateEvidence.notificationIds.length ||
      !Array.isArray(
        stateEvidence.outboxEventIds
      ) ||
      stateEvidence.outboxEventIds.length !==
        (delayedActivation
          ? 1
          : 4 + stateEvidence.notificationIds.length) ||
      stateEvidence.outboxEventIds.some(
        (id) => !UUID_PATTERN.test(id || "")
      ) ||
      new Set(stateEvidence.outboxEventIds).size !==
        stateEvidence.outboxEventIds.length
    ) {
      conflict(
        "The persisted restricted fallback allocation evidence changed."
      );
    }
    const activityId = stateEvents[0].activityId;
    const activities = database.prepare(`
      SELECT id, player_id AS playerId,
             metadata_json AS metadataJson
      FROM league_activity
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND event_type =
          'free_agent_draft_restricted_fallback_opened'
        AND actor_user_id IS NULL
        AND actor_authority = 'system'
        AND team_id IS NULL
        AND related_type = 'free_agent_draft_allocation'
        AND related_id = @allocationId
        AND occurred_at_ms = @resolvedAtMs
      ORDER BY id
    `).all({
      ...command,
      resolvedAtMs: resolution.resolved_at_ms,
    });
    const expectedActivityContract = delayedActivation
      ? null
      : createFreeAgentDraftActivityContract({
          eventType:
            "free_agent_draft_restricted_fallback_opened",
          metadata: {
            schemaVersion: 1,
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            fadId: command.fadId,
            allocationId: command.allocationId,
            playerId: row.playerId,
            sourceAuctionId: command.sourceAuctionId,
            fallbackAuctionId: row.fallbackAuctionId,
            resolvesAtMs: row.fallbackResolvesAtMs,
          },
        });
    if (
      delayedActivation
        ? activities.length !== 0
        : activities.length !== 1 ||
          activities[0].id !== activityId ||
          activities[0].playerId !== row.playerId ||
          activities[0].metadataJson !==
            JSON.stringify(expectedActivityContract.metadata)
    ) {
      conflict(
        "The persisted restricted fallback activity changed."
      );
    }

    const activationJobs = database.prepare(`
      SELECT id, job_type AS jobType,
             occurrence_key AS occurrenceKey,
             scheduled_for_ms AS scheduledForMs,
             status, attempt_count AS attemptCount,
             lease_owner AS leaseOwner,
             lease_token AS leaseToken,
             lease_expires_at_ms AS leaseExpiresAtMs,
             started_at_ms AS startedAtMs,
             completed_at_ms AS completedAtMs,
             result_json AS resultJson,
             last_error_code AS lastErrorCode,
             next_attempt_at_ms AS nextAttemptAtMs,
             version
      FROM job_runs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND job_type = 'fad_fallback_activation'
        AND occurrence_key = @activationOccurrenceKey
        AND scheduled_for_ms = @fallbackOpenedAtMs
      ORDER BY id
    `).all({
      ...command,
      activationOccurrenceKey:
        `fad:${command.fadId}:fallback-activate:` +
        `${command.allocationId}:${row.fallbackOpenedAtMs}`,
      fallbackOpenedAtMs: row.fallbackOpenedAtMs,
    });
    if (
      delayedActivation
        ? activationJobs.length !== 1 ||
          activationJobs[0].id !== activationJobRunId ||
          activationJobs[0].jobType !==
            "fad_fallback_activation" ||
          activationJobs[0].status !== "pending" ||
          activationJobs[0].attemptCount !== 0 ||
          activationJobs[0].leaseOwner !== null ||
          activationJobs[0].leaseToken !== null ||
          activationJobs[0].leaseExpiresAtMs !== null ||
          activationJobs[0].startedAtMs !== null ||
          activationJobs[0].completedAtMs !== null ||
          activationJobs[0].resultJson !== null ||
          activationJobs[0].lastErrorCode !== null ||
          activationJobs[0].nextAttemptAtMs !== null ||
          activationJobs[0].version !== 1
        : activationJobs.length !== 0
    ) {
      conflict(
        "The persisted restricted fallback activation job changed."
      );
    }

    const sourceRecoveries = database.prepare(`
      SELECT id, status,
             last_error_code AS lastErrorCode,
             resolved_by_user_id AS resolvedByUserId,
             resolved_by_membership_id AS resolvedByMembershipId,
             resolved_authority AS resolvedAuthority,
             updated_at_ms AS updatedAtMs,
             resolved_at_ms AS resolvedAtMs,
             version
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND auction_id = @sourceAuctionId
        AND job_run_id = @jobRunId
        AND kind = 'auction_resolution'
      ORDER BY id
    `).all(command);
    if (
      sourceRecoveryId === null
        ? sourceRecoveries.length !== 0
        : sourceRecoveries.length !== 1 ||
          sourceRecoveries[0].id !== sourceRecoveryId ||
          sourceRecoveries[0].status !== "resolved" ||
          sourceRecoveries[0].lastErrorCode !== null ||
          sourceRecoveries[0].resolvedByUserId !== null ||
          sourceRecoveries[0].resolvedByMembershipId !== null ||
          sourceRecoveries[0].resolvedAuthority !== "system" ||
          sourceRecoveries[0].updatedAtMs !==
            resolution.resolved_at_ms ||
          sourceRecoveries[0].resolvedAtMs !==
            resolution.resolved_at_ms ||
          sourceRecoveries[0].version < 2
    ) {
      conflict(
        "The persisted restricted fallback source recovery changed."
      );
    }

    const notifications = database.prepare(`
      SELECT id, user_id AS userId,
             message_data_json AS messageDataJson,
             deduplication_key AS deduplicationKey
      FROM notifications
      WHERE league_id = @leagueId
        AND event_type = 'fad_restricted_fallback_opened'
        AND related_feature = 'auction'
        AND related_record_id = @fallbackAuctionId
        AND created_at_ms = @resolvedAtMs
      ORDER BY
        json_extract(message_data_json, '$.teamId'),
        user_id,
        id
    `).all({
      ...command,
      fallbackAuctionId: row.fallbackAuctionId,
      resolvedAtMs: resolution.resolved_at_ms,
    });
    if (
      notifications.length !==
        stateEvidence.notificationIds.length ||
      notifications.some(
        ({ id }, index) =>
          id !== stateEvidence.notificationIds[index]
      )
    ) {
      conflict(
        "The persisted restricted fallback notifications changed."
      );
    }
    const notificationEvidence = [];
    for (const notification of notifications) {
      let message;
      try {
        message = JSON.parse(notification.messageDataJson);
      } catch {
        message = null;
      }
      let contract;
      try {
        contract = createFreeAgentDraftNotificationContract({
          type: "fad_restricted_fallback_opened",
          recipientUserId: notification.userId,
          messageData: message,
        });
      } catch {
        contract = null;
      }
      if (
        contract === null ||
        contract.messageData.leagueId !== command.leagueId ||
        contract.messageData.seasonId !== command.seasonId ||
        contract.messageData.fadId !== command.fadId ||
        contract.messageData.allocationId !== command.allocationId ||
        contract.messageData.auctionId !== row.fallbackAuctionId ||
        contract.messageData.playerId !== row.playerId ||
        contract.messageData.resolvesAtMs !==
          row.fallbackResolvesAtMs ||
        notification.messageDataJson !==
          JSON.stringify(contract.messageData) ||
        notification.deduplicationKey !==
          contract.deduplicationKey
      ) {
        conflict(
          "The persisted restricted fallback notification evidence changed."
        );
      }
      notificationEvidence.push(
        Object.freeze({
          ...notification,
          message: contract.messageData,
        })
      );
    }

    const sourceOutboxEventId = deterministicUuid(
      "fad:restricted-no-improvement:" +
        `source-auction-outbox:${terminalEvents[0].id}`
    );
    const expectedStateOutboxIds = delayedActivation
      ? [sourceOutboxEventId]
      : [
          stateEvidence.outboxEventIds[0],
          stateEvidence.outboxEventIds[1],
          sourceOutboxEventId,
          activityOutboxEventId(activityId),
          ...notifications.map(({ id }) =>
            notificationOutboxEventId(id)
          ),
        ];
    if (
      expectedStateOutboxIds.some(
        (id, index) =>
          id !== stateEvidence.outboxEventIds[index]
      )
    ) {
      conflict(
        "The persisted restricted fallback outbox identity evidence changed."
      );
    }

    if (delayedActivation) {
      const prematureAuctionOutbox = database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_events
        WHERE league_id = @leagueId
          AND event_type = 'auction.changed'
          AND aggregate_type = 'auction'
          AND aggregate_id = @fallbackAuctionId
          AND created_at_ms = @resolvedAtMs
      `).get({
        ...command,
        fallbackAuctionId: row.fallbackAuctionId,
        resolvedAtMs: resolution.resolved_at_ms,
      });
      if (prematureAuctionOutbox.count !== 0) {
        conflict(
          "The persisted restricted fallback outbox evidence changed."
        );
      }
    }
    const fallbackRelated = createEmptySocketRelated({
      fadId: command.fadId,
      allocationId: command.allocationId,
      auctionId: row.fallbackAuctionId,
    });
    const expectedOutbox = [
      ...(delayedActivation
        ? []
        : [
        {
          id: stateEvidence.outboxEventIds[0],
          eventType: "free_agent_draft.changed",
          aggregateType: "free_agent_draft",
          aggregateId: command.fadId,
          version: row.fadVersion,
          reasonCode: "fallback_opened",
          related: fallbackRelated,
          audienceKind: "league",
          audienceUserId: null,
        },
        {
          id: stateEvidence.outboxEventIds[1],
          eventType: "auction.changed",
          aggregateType: "auction",
          aggregateId: row.fallbackAuctionId,
          version: row.fallbackVersion,
          reasonCode: "auction_changed",
          related: fallbackRelated,
          audienceKind: "league",
          audienceUserId: null,
        },
        ]),
      {
        id: sourceOutboxEventId,
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: command.sourceAuctionId,
        version: row.sourceVersion,
        reasonCode: "auction_changed",
        related: createEmptySocketRelated({
          fadId: command.fadId,
          allocationId: command.allocationId,
          auctionId: command.sourceAuctionId,
        }),
        audienceKind: "league",
        audienceUserId: null,
      },
      ...(delayedActivation
        ? []
        : [
            {
              id: activityOutboxEventId(activityId),
              eventType: "activity.created",
              aggregateType: "league_activity",
              aggregateId: activityId,
              version: 1,
              reasonCode: "fallback_opened",
              related: fallbackRelated,
              audienceKind: "league",
              audienceUserId: null,
            },
            ...notificationEvidence.map((notification) => ({
              id: notificationOutboxEventId(notification.id),
              eventType: "notification.created",
              aggregateType: "notification",
              aggregateId: notification.id,
              version: 1,
              reasonCode: "fallback_opened",
              related: createEmptySocketRelated({
                fadId: command.fadId,
                teamId: notification.message.teamId,
                allocationId: command.allocationId,
                auctionId: row.fallbackAuctionId,
              }),
              audienceKind: "user",
              audienceUserId: notification.userId,
            })),
          ]),
    ];
    const findOutbox = database.prepare(`
      SELECT id, event_type AS eventType,
             aggregate_type AS aggregateType,
             aggregate_id AS aggregateId,
             payload_json AS payloadJson
      FROM outbox_events
      WHERE league_id = @leagueId
        AND id = @id
        AND created_at_ms = @resolvedAtMs
    `);
    const outbox = expectedOutbox
      .map((event) =>
        findOutbox.get({
          leagueId: command.leagueId,
          id: event.id,
          resolvedAtMs: resolution.resolved_at_ms,
        })
      )
      .filter(Boolean);
    const expectedOutboxRows = expectedOutbox.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payloadJson: JSON.stringify(
          createSocketEventEnvelope({
            eventId: event.id,
            type: event.eventType,
            leagueId: command.leagueId,
            resourceId: event.aggregateId,
            version: event.version,
            reasonCode: event.reasonCode,
            occurredAt: resolution.resolved_at_ms,
            related: event.related,
          })
        ),
      }));
    if (
      outbox.length !== expectedOutboxRows.length ||
      outbox.some(
        (event, index) =>
          Object.keys(expectedOutboxRows[index]).some(
            (field) =>
              event[field] !== expectedOutboxRows[index][field]
          )
      ) ||
      outbox.some((event, index) => {
          const audiences = database.prepare(`
            SELECT audience_kind AS audienceKind,
                   team_id AS teamId,
                   user_id AS userId
            FROM outbox_event_audiences
            WHERE league_id = ?
              AND outbox_event_id = ?
          `).all(command.leagueId, event.id);
          return (
            audiences.length !== 1 ||
            audiences[0].audienceKind !==
              expectedOutbox[index].audienceKind ||
            audiences[0].teamId !== null ||
            audiences[0].userId !==
              expectedOutbox[index].audienceUserId
          );
      })
    ) {
      conflict(
        "The persisted restricted fallback outbox evidence changed."
      );
    }
    return Object.freeze({
      applied: true,
      replayed: true,
      reason: null,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      allocationId: command.allocationId,
      allocationVersion: row.allocationVersion,
      sourceAuctionId: command.sourceAuctionId,
      sourceAuctionVersion: row.sourceVersion,
      sourceResolutionId: resolution.id,
      fallbackAuctionId: row.fallbackAuctionId,
      fallbackRolloverId: row.fallbackRolloverId,
      fallbackOpensAtMs: row.fallbackOpenedAtMs,
      fallbackResolvesAtMs: row.fallbackResolvesAtMs,
      activationJobRunId,
      activationAtMs: delayedActivation
        ? row.fallbackOpenedAtMs
        : null,
      sourceRecoveryId,
      activityId,
      notificationIds: Object.freeze(
        notifications.map(({ id }) => id)
      ),
      outboxEventIds: Object.freeze(
        outbox.map(({ id }) => id)
      ),
    });
  }

  function execute(command) {
    const resolutions = findResolution.all(command);
    const replayed = replay(command, resolutions);
    if (replayed) return replayed;

    const source = findSource.get(command);
    const expectedOccurrence = source
      ? `auction:${command.sourceAuctionId}:${source.auctionResolvesAtMs}`
      : null;
    if (!source) {
      conflict(
        "The restricted fallback source evidence was not found."
      );
    }
    if (
      source.auctionStatus !== "resolving" ||
      source.auctionVersion !==
        command.expectedAuctionVersion ||
      source.auctionResolvesAtMs > command.nowMs ||
      source.sourceKind !== "fad_restricted" ||
      source.contextFadId !== command.fadId ||
      source.contextAllocationId !==
        command.allocationId ||
      source.fadOrigin !== "candidate_tie_restricted" ||
      source.allocationStatus !== "restricted_active" ||
      source.allocationDecisionCode !==
        "exact_total_and_term_tie" ||
      source.restrictedAuctionId !==
        command.sourceAuctionId ||
      source.fallbackAuctionId !== null ||
      source.winningSnapshotEntryId !== null ||
      source.winningTeamId !== null ||
      source.contractId !== null ||
      source.ownershipId !== null ||
      source.accountedAtMs !== null ||
      source.allocationErrorCode !== null ||
      source.allocationVersion !==
        command.expectedAllocationVersion ||
      source.minimumTotalCents === null ||
      source.minimumTermYears === null ||
      source.minimumAavCents === null ||
      source.sourceDrawRevealedAtMs !== null ||
      source.sourceDrawVersion !== 1 ||
      source.jobType !== "auction.resolve.target" ||
      source.jobOccurrenceKey !== expectedOccurrence ||
      command.occurrenceKey !== expectedOccurrence ||
      source.jobScheduledForMs !==
        source.auctionResolvesAtMs ||
      !["leased", "running"].includes(source.jobStatus) ||
      source.jobAttemptCount < 1 ||
      source.jobLeaseOwner !== command.leaseOwner ||
      source.jobLeaseToken !== command.leaseToken ||
      source.jobLeaseExpiresAtMs <= command.nowMs ||
      source.jobCompletedAtMs !== null ||
      source.jobResultJson !== null ||
      source.jobErrorCode !== null ||
      source.jobNextAttemptAtMs !== null ||
      source.jobVersion !== command.expectedJobVersion
    ) {
      conflict(
        "The restricted fallback source or job lease changed."
      );
    }

    const eligible = findEligibleImprovements.all({
      ...command,
      minimumTotalCents: source.minimumTotalCents,
      minimumAavCents: source.minimumAavCents,
    });
    if (eligible.length > 0) {
      return Object.freeze({
        applied: false,
        reason: "eligible_improvement_remains",
      });
    }
    const activeBidCount =
      countActiveBids.get(command).count;
    if (activeBidCount > 0) {
      const invalidated =
        invalidateNonContendingBids.run(command);
      if (invalidated.changes !== activeBidCount) {
        conflict(
          "A non-contending bid changed before fallback handoff."
        );
      }
    }

    const sourceRollover =
      findSourceRollover.get(command);
    if (
      !sourceRollover ||
      sourceRollover.id !== source.sourceRolloverId ||
      sourceRollover.rollsOverAtMs !==
        source.auctionResolvesAtMs ||
      source.auctionOpenedAtMs <
        sourceRollover.opensAtMs ||
      source.auctionOpenedAtMs >=
        sourceRollover.rollsOverAtMs
    ) {
      conflict(
        "The restricted source rollover evidence changed."
      );
    }
    const sourceRecoveries =
      findSourceRecoveries.all(command);
    if (sourceRecoveries.length > 1) {
      incompatible(
        "The restricted source recovery evidence is not unique."
      );
    }
    const sourceRecovery = sourceRecoveries[0] || null;
    const requiresSourceRecovery =
      sourceRollover.status === "recovery_required";
    if (
      (requiresSourceRecovery
        ? sourceRecovery === null
        : sourceRecovery !== null) ||
      (sourceRecovery !== null &&
        (sourceRecovery.player_id !== source.playerId ||
          sourceRecovery.rollover_id !== sourceRollover.id ||
          sourceRecovery.created_by_operation_id !==
            command.jobRunId ||
          sourceRecovery.target_resolution_at_ms !==
            source.auctionResolvesAtMs ||
          sourceRecovery.last_error_code === null ||
          sourceRecovery.resolved_by_user_id !== null ||
          sourceRecovery.resolved_by_membership_id !== null ||
          sourceRecovery.resolved_authority !== null ||
          sourceRecovery.resolved_at_ms !== null))
    ) {
      conflict(
        "The restricted source recovery evidence changed."
      );
    }

    const targetRollovers =
      findTargetRollovers.all(command);
    if (
      targetRollovers.length > 1 &&
      targetRollovers[0].opensAtMs ===
        targetRollovers[1].opensAtMs
    ) {
      incompatible(
        "The complete fallback rollover window is not unique."
      );
    }
    let createExtension = false;
    let targetRolloverId;
    let fallbackOpensAtMs;
    let fallbackResolvesAtMs;
    let extensionPredecessor = null;
    let targetPredecessor;
    if (targetRollovers.length > 0) {
      if (command.ids.extensionRolloverId !== null) {
        conflict(
          "An extension identifier cannot replace an existing fallback rollover."
        );
      }
      targetRolloverId = targetRollovers[0].id;
      fallbackOpensAtMs =
        targetRollovers[0].opensAtMs;
      fallbackResolvesAtMs =
        targetRollovers[0].rollsOverAtMs;
      targetPredecessor = {
        id: targetRollovers[0].predecessorRolloverId,
        predecessorRolloverId:
          targetRollovers[0].predecessorPredecessorId,
        sequence:
          targetRollovers[0].predecessorSequence,
        opensAtMs:
          targetRollovers[0].predecessorOpensAtMs,
        rollsOverAtMs:
          targetRollovers[0].predecessorRollsOverAtMs,
        status:
          targetRollovers[0].predecessorStatus,
      };
    } else if (
      command.ids.extensionRolloverId !== null
    ) {
      const predecessors =
        findExtensionPredecessors.all(command);
      if (
        predecessors.length !== 1 ||
        predecessors[0].sequence < 7
      ) {
        conflict(
          "The missing fallback rollover requires one exact full-window predecessor."
        );
      }
      extensionPredecessor = predecessors[0];
      const atTerminalBoundary =
        extensionPredecessor.rollsOverAtMs ===
        command.nowMs;
      const inFinalHour =
        extensionPredecessor.status === "scheduled" &&
        command.nowMs >=
          extensionPredecessor.cutoffAtMs &&
        command.nowMs <
          extensionPredecessor.rollsOverAtMs;
      if (
        !inFinalHour &&
        !(
          atTerminalBoundary &&
          [
            "processing",
            "completed",
            "recovery_required",
          ].includes(extensionPredecessor.status)
        )
      ) {
        conflict(
          "The fallback extension is outside its exact final-hour or terminal boundary."
        );
      }
      createExtension = true;
      targetRolloverId =
        command.ids.extensionRolloverId;
      fallbackOpensAtMs =
        extensionPredecessor.rollsOverAtMs;
      fallbackResolvesAtMs =
        fallbackOpensAtMs + DAY_MS;
      targetPredecessor = extensionPredecessor;
    } else {
      conflict(
        "One exact complete fallback rollover window is required."
      );
    }
    if (
      fallbackOpensAtMs < command.nowMs ||
      fallbackResolvesAtMs !==
        fallbackOpensAtMs + DAY_MS
    ) {
      conflict(
        "The fallback auction requires one complete current or future window."
      );
    }
    const delayedActivation =
      fallbackOpensAtMs > command.nowMs;
    const directSourceWindow =
      targetPredecessor.id === sourceRollover.id &&
      targetPredecessor.sequence === sourceRollover.sequence &&
      fallbackOpensAtMs === sourceRollover.rollsOverAtMs;
    const adjacentSourceWindow =
      targetPredecessor.predecessorRolloverId ===
        sourceRollover.id &&
      targetPredecessor.sequence ===
        sourceRollover.sequence + 1 &&
      targetPredecessor.opensAtMs ===
        sourceRollover.rollsOverAtMs;
    const fartherSourceWindow =
      sourceRollover.sequence <
        targetPredecessor.sequence - 1 &&
      sourceRollover.rollsOverAtMs <
        targetPredecessor.opensAtMs;
    if (
      !directSourceWindow &&
      !adjacentSourceWindow &&
      !fartherSourceWindow
    ) {
      conflict(
        "The fallback window is not contiguous with its source evidence."
      );
    }
    if (
      adjacentSourceWindow &&
      ![
        "scheduled",
        "processing",
        "recovery_required",
      ].includes(sourceRollover.status)
    ) {
      conflict(
        "The adjacent delayed fallback source rollover changed."
      );
    }
    if (fartherSourceWindow) {
      const retryEvidence = sourceRecovery
        ? findDelayedRetryEvidence.all({
            ...command,
            playerId: source.playerId,
            sourceRecoveryId: sourceRecovery.id,
            sourceRolloverId: sourceRollover.id,
          })
        : [];
      if (
        sourceRollover.status !== "recovery_required" ||
        source.jobAttemptCount < 2 ||
        sourceRecovery === null ||
        retryEvidence.length !== 1
      ) {
        conflict(
          "The farther delayed fallback requires exact recovery and retry evidence."
        );
      }
    }
    if (
      delayedActivation
        ? command.ids.fallbackActivationJobRunId === null ||
          command.ids.activityId !== null ||
          command.ids.fadOutboxEventId !== null ||
          command.ids.auctionOutboxEventId !== null ||
          command.ids.notificationIds.length !== 0
        : command.ids.fallbackActivationJobRunId !== null ||
          command.ids.activityId === null ||
          command.ids.fadOutboxEventId === null ||
          command.ids.auctionOutboxEventId === null
    ) {
      invalid(
        "Fallback activation and publication identifiers do not match the selected window."
      );
    }
    const offerEvents = findOfferEvents.all(command);
    if (
      offerEvents.length === 0 ||
      offerEvents.length !==
        command.ids.clonedOfferEventIds.length
    ) {
      incompatible(
        "Current allocation offer evidence does not match its cloned identifiers."
      );
    }
    const recipients = delayedActivation
      ? []
      : findRecipients.all(command);
    if (
      recipients.length !==
        command.ids.notificationIds.length
    ) {
      conflict(
        "Current participating-team managers changed before fallback handoff."
      );
    }

    let nonceBytes = createDrawNonce({
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      allocationId: command.allocationId,
      auctionId: command.ids.fallbackAuctionId,
    });
    if (
      !(nonceBytes instanceof Uint8Array) ||
      nonceBytes.byteLength !== 32
    ) {
      invalid(
        "Restricted fallback draw nonce factories must return exactly 32 bytes."
      );
    }
    nonceBytes = Buffer.from(nonceBytes);
    const commitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: command.ids.fallbackAuctionId,
        nonceBytes,
      });
    const write = {
      ...command,
      ...command.ids,
      playerId: source.playerId,
      targetRolloverId,
      fallbackOpensAtMs,
      fallbackResolvesAtMs,
      fallbackOccurrenceKey:
        `auction:${command.ids.fallbackAuctionId}:` +
        `${fallbackResolvesAtMs}`,
      fallbackActivationOccurrenceKey:
        `fad:${command.fadId}:fallback-activate:` +
        `${command.allocationId}:${fallbackOpensAtMs}`,
      extensionPredecessorRolloverId:
        extensionPredecessor?.id || null,
      extensionSequence:
        extensionPredecessor?.sequence + 1 || null,
      extensionRolloverId:
        command.ids.extensionRolloverId,
      fallbackCutoffAtMs:
        fallbackResolvesAtMs - 3_600_000,
      nonceBytes,
      commitmentHex: commitment.commitmentHex,
      sourceRecoveryId: sourceRecovery?.id || null,
    };

    const pretransitionExtension =
      createExtension &&
      extensionPredecessor.status === "scheduled";
    if (pretransitionExtension) {
      insertExtensionRollover.run(write);
    }
    insertAuction.run(write);
    assertChanged(
      updateAllocation.run(write),
      "The restricted allocation"
    );
    if (createExtension && !pretransitionExtension) {
      insertExtensionRollover.run(write);
    }
    insertContext.run(write);
    insertDraw.run(write);
    insertFallbackJob.run(write);
    if (delayedActivation) {
      insertFallbackActivationJob.run(write);
    }
    insertAuctionEvent.run({
      ...write,
      metadataJson: JSON.stringify({
        outcome: "no_winner",
        resolutionId: command.ids.sourceResolutionId,
        fallbackAuctionId:
          command.ids.fallbackAuctionId,
      }),
    });
    insertResolution.run(write);
    assertChanged(
      revealSourceDraw.run(write),
      "The restricted source draw"
    );
    assertChanged(
      terminalizeSource.run(write),
      "The restricted source auction"
    );
    if (sourceRecovery) {
      assertChanged(
        resolveSourceRecovery.run(write),
        "The restricted source recovery"
      );
    }

    const activityContract =
      createFreeAgentDraftActivityContract({
        eventType:
          "free_agent_draft_restricted_fallback_opened",
        metadata: {
          schemaVersion: 1,
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          fadId: command.fadId,
          allocationId: command.allocationId,
          playerId: source.playerId,
          sourceAuctionId: command.sourceAuctionId,
          fallbackAuctionId:
            command.ids.fallbackAuctionId,
          resolvesAtMs: fallbackResolvesAtMs,
        },
      });
    if (!delayedActivation) {
      insertActivity.run({
        ...write,
        metadataJson: JSON.stringify(
          activityContract.metadata
        ),
      });
    }

    const publicationOutboxEventIds =
      stateOutboxEventIds(command, delayedActivation);

    for (
      let index = 0;
      index < offerEvents.length;
      index += 1
    ) {
      const event = offerEvents[index];
      insertAllocationEvent.run({
        ...write,
        id: command.ids.clonedOfferEventIds[index],
        allocationVersion:
          command.expectedAllocationVersion + 1,
        eventKind: "offer_considered",
        snapshotEntryId: event.snapshot_entry_id,
        teamId: event.team_id,
        offerValid: event.offer_valid,
        rankPosition: event.rank_position,
        offerOutcomeCode: event.offer_outcome_code,
        decisionCode: event.decision_code,
        contractId: null,
        ownershipId: null,
        auctionId: null,
        activityId: null,
        correctionId: null,
        actorUserId: event.actor_user_id,
        actorMembershipId:
          event.actor_membership_id,
        actorAuthority: event.actor_authority,
        evidenceJson: event.evidence_json,
      });
    }
    insertAllocationEvent.run({
      ...write,
      id: command.ids.allocationStateEventId,
      allocationVersion:
        command.expectedAllocationVersion + 1,
      eventKind: "fallback_state_changed",
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode:
        "restricted_no_improvement_fallback",
      contractId: null,
      ownershipId: null,
      auctionId: command.ids.fallbackAuctionId,
      activityId: delayedActivation
        ? null
        : command.ids.activityId,
      correctionId: null,
      actorUserId: null,
      actorMembershipId: null,
      actorAuthority: "system",
      evidenceJson: JSON.stringify({
        schemaVersion: 1,
        occurrenceKey: command.occurrenceKey,
        sourceAuctionId: command.sourceAuctionId,
        fallbackAuctionId:
          command.ids.fallbackAuctionId,
        targetRolloverId,
        activationJobRunId: delayedActivation
          ? command.ids.fallbackActivationJobRunId
          : null,
        activationAtMs: delayedActivation
          ? fallbackOpensAtMs
          : null,
        sourceRecoveryId: sourceRecovery?.id || null,
        activityId: delayedActivation
          ? null
          : command.ids.activityId,
        notificationIds: delayedActivation
          ? []
          : command.ids.notificationIds,
        outboxEventIds: publicationOutboxEventIds,
      }),
    });

    const notificationContracts = recipients.map(
      (recipient) =>
        createFreeAgentDraftNotificationContract({
          type: "fad_restricted_fallback_opened",
          recipientUserId: recipient.userId,
          messageData: {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            fadId: command.fadId,
            teamId: recipient.teamId,
            allocationId: command.allocationId,
            auctionId: command.ids.fallbackAuctionId,
            playerId: source.playerId,
            resolvesAtMs: fallbackResolvesAtMs,
            destination: {
              kind: "auction",
              leagueId: command.leagueId,
              auctionId:
                command.ids.fallbackAuctionId,
            },
          },
        })
    );
    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index];
      const contract = notificationContracts[index];
      notifications.insert({
        id: command.ids.notificationIds[index],
        userId: contract.recipientUserId,
        leagueId: command.leagueId,
        eventType: contract.type,
        messageDataJson: JSON.stringify(
          contract.messageData
        ),
        deduplicationKey: contract.deduplicationKey,
        relatedFeature: "auction",
        relatedRecordId:
          command.ids.fallbackAuctionId,
        deliveryStatus: "pending",
        createdAtMs: command.nowMs,
        deliveredAtMs: null,
      });
    }

    const fallbackRelated = createEmptySocketRelated({
      fadId: command.fadId,
      allocationId: command.allocationId,
      auctionId: command.ids.fallbackAuctionId,
    });
    const publicationEvents = [
      ...(delayedActivation
        ? []
        : [
        {
          id: command.ids.fadOutboxEventId,
          eventType: "free_agent_draft.changed",
          aggregateType: "free_agent_draft",
          aggregateId: command.fadId,
          version: source.fadVersion,
          reasonCode: "fallback_opened",
          related: fallbackRelated,
          audiences: [{ kind: "league" }],
        },
        {
          id: command.ids.auctionOutboxEventId,
          eventType: "auction.changed",
          aggregateType: "auction",
          aggregateId: command.ids.fallbackAuctionId,
          version: 1,
          reasonCode: "auction_changed",
          related: fallbackRelated,
          audiences: [{ kind: "league" }],
        },
        ]),
      {
        id: sourceAuctionOutboxEventId(command),
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: command.sourceAuctionId,
        version: source.auctionVersion + 1,
        reasonCode: "auction_changed",
        related: createEmptySocketRelated({
          fadId: command.fadId,
          allocationId: command.allocationId,
          auctionId: command.sourceAuctionId,
        }),
        audiences: [{ kind: "league" }],
      },
      ...(delayedActivation
        ? []
        : [
            {
              id: activityOutboxEventId(
                command.ids.activityId
              ),
              eventType: "activity.created",
              aggregateType: "league_activity",
              aggregateId: command.ids.activityId,
              version: 1,
              reasonCode: "fallback_opened",
              related: fallbackRelated,
              audiences: [{ kind: "league" }],
            },
            ...notificationContracts.map((contract, index) => ({
              id: notificationOutboxEventId(
                command.ids.notificationIds[index]
              ),
              eventType: "notification.created",
              aggregateType: "notification",
              aggregateId:
                command.ids.notificationIds[index],
              version: 1,
              reasonCode: "fallback_opened",
              related: createEmptySocketRelated({
                fadId: command.fadId,
                teamId:
                  contract.messageData.teamId,
                allocationId: command.allocationId,
                auctionId:
                  command.ids.fallbackAuctionId,
              }),
              audiences: [
                {
                  kind: "user",
                  userId: contract.recipientUserId,
                },
              ],
            })),
          ]),
    ];
    for (const event of publicationEvents) {
      outboxWriter.write({
        id: event.id,
        leagueId: command.leagueId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: createSocketEventMetadata({
          eventType: event.eventType,
          version: event.version,
          reasonCode: event.reasonCode,
          occurredAtMs: command.nowMs,
          related: event.related,
        }),
        occurredAtMs: command.nowMs,
        audiences: event.audiences,
      });
    }

    assertChanged(
      succeedSourceJob.run({
        ...write,
        resultJson: JSON.stringify({
          auctionId: command.sourceAuctionId,
          outcome: "no_winner",
        }),
      }),
      "The restricted source resolution job"
    );

    const result = canonicalResult(command, {
      activationJobRunId: delayedActivation
        ? command.ids.fallbackActivationJobRunId
        : null,
      fallbackOpensAtMs,
      fallbackResolvesAtMs,
      sourceRecoveryId: sourceRecovery?.id || null,
      targetRolloverId,
    });
    if (beforeCommit) {
      beforeCommit(result, command);
    }
    return result;
  }

  return Object.freeze({
    openFallback(input) {
      const command = normalize(input);
      try {
        if (!database.inTransaction) {
          invalid(
            "Restricted fallback writing requires a caller-owned transaction."
          );
        }
        return execute(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "openRestrictedNoImprovementFallback",
          tableName: "free_agent_draft_player_allocations",
        });
      }
    },
  });
}

module.exports = {
  createSqliteRestrictedNoImprovementFallbackWriter,
};
