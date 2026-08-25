"use strict";

const {
  buildAuctionResolutionOccurrenceKey,
} = require("../../../domain/auctions/auctionResolutionPolicy");
const {
  createFreeAgentDraftScheduleRecoveryEvidence,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftScheduleRecoveryEvidencePolicy"
);
const {
  FREE_AGENT_DRAFT_REMINDER_LEAD_MS,
  UUID_PATTERN,
  deriveFreeAgentDraftViewerPhase,
  parseFreeAgentDraftOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_RECOVERY_READ_ACTIONS,
  projectFreeAgentDraftRecoveryRead,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftRecoveryReadPolicy"
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

const MAXIMUM_TIMESTAMP_MS =
  8_640_000_000_000_000;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/;
const FAD_JOB_TYPES = Object.freeze([
  "fad_deadline",
  "fad_allocation",
  "fad_restricted_activation",
  "fad_fallback_activation",
  "fad_queued_nomination_activation",
  "fad_rollover",
  "fad_completion",
]);

const JOB_POLICY = Object.freeze({
  fad_deadline: Object.freeze({
    occurrenceType: "deadline",
    operationKind: "deadline",
    action: "retry_deadline",
  }),
  fad_allocation: Object.freeze({
    occurrenceType: "allocate",
    operationKind: "allocation",
    action: "retry_allocation",
  }),
  fad_restricted_activation: Object.freeze({
    occurrenceType: "restricted_activate",
    operationKind: "restricted_activation",
    action: "activate_restricted",
  }),
  fad_fallback_activation: Object.freeze({
    occurrenceType: "fallback_activate",
    operationKind: "fallback_activation",
    action: "activate_fallback",
  }),
  fad_queued_nomination_activation: Object.freeze({
    occurrenceType: "nomination_open",
    operationKind: "queued_nomination_activation",
    action: "activate_queued_nomination",
  }),
  fad_rollover: Object.freeze({
    occurrenceType: "rollover",
    operationKind: null,
    action: "finalize_rollover",
  }),
  fad_completion: Object.freeze({
    occurrenceType: "complete",
    operationKind: "completion",
    action: "complete_fad",
  }),
  "auction.resolve.target": Object.freeze({
    occurrenceType: "auction_resolution",
    operationKind: "auction_resolution",
    action: "retry_auction_resolution",
  }),
});

const RECOVERY_ACTION = Object.freeze({
  deadline_retry: "retry_deadline",
  allocation_retry: "retry_allocation",
  restricted_activation: "activate_restricted",
  queued_nomination_activation:
    "activate_queued_nomination",
  fallback_activation: "activate_fallback",
  auction_resolution: "retry_auction_resolution",
  rollover_finalize: "finalize_rollover",
  completion: "complete_fad",
});

const FREE_AGENT_DRAFT_RECOVERY_READ_REPOSITORY_CODES =
  Object.freeze({
    authorizationDenied:
      "FAD_RECOVERY_READ_AUTHORIZATION_DENIED",
  });

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function incompatible(message, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function notFound() {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
    "The scoped Free Agent Draft was not found."
  );
}

function exactObject(value, fields, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value)
    ) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value)
      .sort()
      .join("|") !== [...fields].sort().join("|")
  ) {
    invalid(message);
  }
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      "A canonical FAD recovery-read identifier is required."
    );
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    invalid(
      "A safe FAD recovery-read timestamp is required."
    );
  }
  return value;
}

function normalizeInput(input) {
  exactObject(
    input,
    [
      "leagueId",
      "fadId",
      "viewerUserId",
      "viewerMembershipId",
      "viewerAuthority",
      "nowMs",
    ],
    "An exact FAD recovery-read repository input is required."
  );
  if (
    ![
      "commissioner",
      "platform_administrator_as_commissioner",
    ].includes(input.viewerAuthority)
  ) {
    invalid(
      "Canonical FAD recovery-read authority is required."
    );
  }
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    fadId: stableId(input.fadId),
    viewerUserId: stableId(input.viewerUserId),
    viewerMembershipId: stableId(
      input.viewerMembershipId
    ),
    viewerAuthority: input.viewerAuthority,
    nowMs: safeTimestamp(input.nowMs),
  });
}

function unique(statement, parameters, description) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(`${description} is ambiguous.`);
  }
  return rows[0] || null;
}

function actionKey(action, resourceId) {
  return `${action}:${resourceId ?? ""}`;
}

function publicActionResourceId(action, resourceId) {
  return ["retry_deadline", "complete_fad"].includes(
    action
  )
    ? null
    : resourceId;
}

function compareText(left, right) {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function compareOperation(left, right) {
  const operationOrder = [
    "deadline",
    "allocation",
    "restricted_activation",
    "queued_nomination_activation",
    "fallback_activation",
    "auction_resolution",
    "completion",
  ];
  return (
    left.scheduledForMs - right.scheduledForMs ||
    operationOrder.indexOf(left.operationKind) -
      operationOrder.indexOf(right.operationKind) ||
    compareText(left.resourceId, right.resourceId) ||
    compareText(left.operationId, right.operationId)
  );
}

function isCanonicalJob(row) {
  if (
    !row ||
    !UUID_PATTERN.test(row.id || "") ||
    !UUID_PATTERN.test(row.league_id || "") ||
    !UUID_PATTERN.test(row.season_id || "") ||
    !Object.prototype.hasOwnProperty.call(
      JOB_POLICY,
      row.job_type
    ) ||
    typeof row.occurrence_key !== "string" ||
    row.occurrence_key.length < 1 ||
    row.occurrence_key.length > 500 ||
    !Number.isSafeInteger(row.scheduled_for_ms) ||
    row.scheduled_for_ms < 0 ||
    !Number.isSafeInteger(row.attempt_count) ||
    row.attempt_count < 0 ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1
  ) {
    return false;
  }
  const noLease =
    row.lease_owner === null &&
    row.lease_token === null &&
    row.lease_expires_at_ms === null;
  if (row.status === "pending") {
    return (
      noLease &&
      row.started_at_ms === null &&
      row.completed_at_ms === null &&
      row.result_json === null &&
      row.last_error_code === null &&
      (
        row.next_attempt_at_ms === null ||
        (
          Number.isSafeInteger(row.next_attempt_at_ms) &&
          row.next_attempt_at_ms >= 0
        )
      )
    );
  }
  if (["leased", "running"].includes(row.status)) {
    return (
      typeof row.lease_owner === "string" &&
      row.lease_owner.trim().length > 0 &&
      typeof row.lease_token === "string" &&
      row.lease_token.trim().length > 0 &&
      Number.isSafeInteger(row.lease_expires_at_ms) &&
      row.lease_expires_at_ms >= 0 &&
      (
        row.status === "leased"
          ? row.started_at_ms === null
          : Number.isSafeInteger(row.started_at_ms) &&
            row.started_at_ms >= 0
      ) &&
      row.completed_at_ms === null &&
      row.result_json === null &&
      row.last_error_code === null &&
      row.next_attempt_at_ms === null
    );
  }
  if (["succeeded", "skipped"].includes(row.status)) {
    if (
      !noLease ||
      !Number.isSafeInteger(row.started_at_ms) ||
      !Number.isSafeInteger(row.completed_at_ms) ||
      row.completed_at_ms < row.started_at_ms ||
      typeof row.result_json !== "string" ||
      row.last_error_code !== null ||
      row.next_attempt_at_ms !== null
    ) {
      return false;
    }
    try {
      return (
        serializeCanonicalJsonV1(
          JSON.parse(row.result_json)
        ) === row.result_json
      );
    } catch {
      return false;
    }
  }
  if (row.status === "failed") {
    return (
      noLease &&
      Number.isSafeInteger(row.started_at_ms) &&
      Number.isSafeInteger(row.completed_at_ms) &&
      row.completed_at_ms >= row.started_at_ms &&
      row.result_json === null &&
      typeof row.last_error_code === "string" &&
      SAFE_CODE_PATTERN.test(row.last_error_code) &&
      (
        row.next_attempt_at_ms === null ||
        (
          Number.isSafeInteger(row.next_attempt_at_ms) &&
          row.next_attempt_at_ms > row.completed_at_ms
        )
      )
    );
  }
  return false;
}

function createSqliteFreeAgentDraftRecoveryReadRepository({
  database,
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError(
      "createSqliteFreeAgentDraftRecoveryReadRepository requires an opened database"
    );
  }

  const authorityStatement = database.prepare(`
    SELECT
      league.status AS league_status,
      league.commissioner_membership_id,
      user.status AS user_status,
      membership.status AS membership_status,
      membership.permission_category,
      CASE WHEN EXISTS (
        SELECT 1
        FROM platform_roles AS role
        WHERE role.user_id = @viewerUserId
          AND role.role = 'platform_administrator'
          AND role.status = 'active'
          AND role.ended_at_ms IS NULL
      ) THEN 1 ELSE 0 END AS is_platform_administrator
    FROM leagues AS league
    JOIN users AS user
      ON user.id = @viewerUserId
    LEFT JOIN league_memberships AS membership
      ON membership.league_id = league.id
     AND membership.id = @viewerMembershipId
     AND membership.user_id = @viewerUserId
     AND membership.ended_at_ms IS NULL
    WHERE league.id = @leagueId
    LIMIT 2
  `);
  const fadStatement = database.prepare(`
    SELECT
      fad.*,
      season.free_agent_draft_completed_at_ms
    FROM free_agent_drafts AS fad
    JOIN seasons AS season
      ON season.league_id = fad.league_id
     AND season.id = fad.season_id
    WHERE fad.league_id = @leagueId
      AND fad.id = @fadId
    LIMIT 2
  `);
  const competitionWeekStatement = database.prepare(`
    SELECT
      week.id AS week_id,
      week.starts_at_ms,
      generation.schedule_operation_id,
      generation.schedule_version
    FROM matchup_weeks AS week
    JOIN season_matchup_schedule_generations AS generation
      ON generation.league_id = week.league_id
     AND generation.season_id = week.season_id
     AND generation.week_one_matchup_week_id = week.id
     AND generation.week_one_starts_at_ms = week.starts_at_ms
     AND generation.status = 'current'
    WHERE week.league_id = @leagueId
      AND week.season_id = @seasonId
      AND week.id = @weekId
      AND week.sequence = 1
    LIMIT 2
  `);
  const countsStatement = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM free_agent_draft_teams
        WHERE league_id=@leagueId AND fad_id=@fadId)
        AS participating_teams,
      (SELECT COUNT(*) FROM candidate_cards
        WHERE league_id=@leagueId AND fad_id=@fadId
          AND status <> 'open') AS cards_locked,
      (SELECT COUNT(*) FROM free_agent_draft_player_allocations
        WHERE league_id=@leagueId AND fad_id=@fadId
          AND status='pending') AS allocations_pending,
      (SELECT COUNT(*) FROM free_agent_draft_player_allocations
        WHERE league_id=@leagueId AND fad_id=@fadId
          AND status='automatic_award') AS allocations_automatic,
      (SELECT COUNT(*) FROM free_agent_draft_player_allocations
        WHERE league_id=@leagueId AND fad_id=@fadId
          AND status IN ('restricted_scheduled','restricted_active'))
        AS restricted_pending,
      (SELECT COUNT(*) FROM free_agent_draft_player_allocations
        WHERE league_id=@leagueId AND fad_id=@fadId
          AND status='restricted_fallback_open')
        AS restricted_fallback_pending,
      (SELECT COUNT(*)
         FROM auctions AS auction
         JOIN auction_contexts AS context
           ON context.league_id=auction.league_id
          AND context.season_id=auction.season_id
          AND context.auction_id=auction.id
        WHERE context.league_id=@leagueId
          AND context.fad_id=@fadId
          AND context.source_kind='fad_open_rapid'
          AND auction.status IN ('open','resolving'))
        AS rapid_auctions_open,
      (SELECT COUNT(*) FROM free_agent_draft_nomination_queue
        WHERE league_id=@leagueId AND fad_id=@fadId
          AND status='queued') AS queued_nominations,
      (SELECT COUNT(*) FROM free_agent_draft_rollovers
        WHERE league_id=@leagueId AND fad_id=@fadId)
        AS rollovers_persisted,
      (SELECT COUNT(*) FROM free_agent_draft_rollovers
        WHERE league_id=@leagueId AND fad_id=@fadId
          AND status='completed') AS rollovers_completed,
      (SELECT COUNT(*) FROM free_agent_draft_recoveries
        WHERE league_id=@leagueId AND fad_id=@fadId
          AND status <> 'resolved') AS recoveries_open
  `);
  const allocationStatement = database.prepare(`
    SELECT *
    FROM free_agent_draft_player_allocations
    WHERE league_id=@leagueId
      AND season_id=@seasonId
      AND fad_id=@fadId
    ORDER BY id
  `);
  const queueStatement = database.prepare(`
    SELECT *
    FROM free_agent_draft_nomination_queue
    WHERE league_id=@leagueId
      AND season_id=@seasonId
      AND fad_id=@fadId
    ORDER BY id
  `);
  const rolloverStatement = database.prepare(`
    SELECT *
    FROM free_agent_draft_rollovers
    WHERE league_id=@leagueId
      AND season_id=@seasonId
      AND fad_id=@fadId
    ORDER BY sequence, id
  `);
  const recoveryStatement = database.prepare(`
    SELECT *
    FROM free_agent_draft_recoveries
    WHERE league_id=@leagueId
      AND season_id=@seasonId
      AND fad_id=@fadId
    ORDER BY created_at_ms, id
  `);
  const fadJobStatement = database.prepare(`
    SELECT *
    FROM job_runs
    WHERE league_id=@leagueId
      AND season_id=@seasonId
      AND job_type IN (
        'fad_deadline',
        'fad_allocation',
        'fad_restricted_activation',
        'fad_fallback_activation',
        'fad_queued_nomination_activation',
        'fad_rollover',
        'fad_completion'
      )
      AND substr(occurrence_key,1,length(@occurrencePrefix))=
          @occurrencePrefix
    ORDER BY scheduled_for_ms, job_type, occurrence_key, id
  `);
  const auctionJobStatement = database.prepare(`
    SELECT
      job.*,
      auction.id AS scoped_auction_id,
      auction.resolves_at_ms AS scoped_resolves_at_ms
    FROM auction_contexts AS context
    JOIN auctions AS auction
      ON auction.league_id=context.league_id
     AND auction.season_id=context.season_id
     AND auction.id=context.auction_id
    JOIN job_runs AS job
      ON job.league_id=auction.league_id
     AND job.season_id=auction.season_id
     AND job.job_type='auction.resolve.target'
     AND job.occurrence_key=
          'auction:' || auction.id || ':' || auction.resolves_at_ms
     AND job.scheduled_for_ms=auction.resolves_at_ms
    WHERE context.league_id=@leagueId
      AND context.season_id=@seasonId
      AND context.fad_id=@fadId
      AND context.source_kind IN ('fad_open_rapid','fad_restricted')
    ORDER BY job.scheduled_for_ms, auction.id, job.id
  `);
  const scheduleRecoveryStatement = database.prepare(`
    SELECT *
    FROM free_agent_draft_schedule_recoveries
    WHERE league_id=@leagueId
      AND season_id=@seasonId
      AND fad_id=@fadId
      AND id=@scheduleRecoveryId
    LIMIT 2
  `);
  const scheduleWeeksStatement = database.prepare(`
    SELECT *
    FROM free_agent_draft_schedule_recovery_weeks
    WHERE league_id=@leagueId
      AND season_id=@seasonId
      AND schedule_recovery_id=@scheduleRecoveryId
    ORDER BY removed_sequence, removed_matchup_week_id
  `);
  const scheduleMatchupsStatement = database.prepare(`
    SELECT
      matchup.*,
      week.removed_sequence
    FROM free_agent_draft_schedule_recovery_matchups AS matchup
    JOIN free_agent_draft_schedule_recovery_weeks AS week
      ON week.league_id=matchup.league_id
     AND week.season_id=matchup.season_id
     AND week.schedule_recovery_id=matchup.schedule_recovery_id
     AND week.removed_matchup_week_id=
          matchup.removed_matchup_week_id
    WHERE matchup.league_id=@leagueId
      AND matchup.season_id=@seasonId
      AND matchup.schedule_recovery_id=@scheduleRecoveryId
    ORDER BY week.removed_sequence, matchup.removed_matchup_id
  `);
  const scheduleJobsStatement = database.prepare(`
    SELECT *
    FROM free_agent_draft_schedule_recovery_jobs
    WHERE league_id=@leagueId
      AND season_id=@seasonId
      AND schedule_recovery_id=@scheduleRecoveryId
    ORDER BY replaced_occurrence_key, replaced_job_run_id
  `);

  function requireAuthority(input) {
    const row = unique(
      authorityStatement,
      input,
      "The FAD recovery viewer authority"
    );
    const isCommissioner =
      row &&
      row.commissioner_membership_id ===
        input.viewerMembershipId &&
      row.permission_category === "commissioner";
    const actualAuthority = isCommissioner
      ? "commissioner"
      : row?.is_platform_administrator === 1
        ? "platform_administrator_as_commissioner"
        : null;
    if (
      !row ||
      row.league_status === "deleted" ||
      row.user_status !== "active" ||
      row.membership_status !== "active" ||
      actualAuthority === null ||
      actualAuthority !== input.viewerAuthority
    ) {
      throw repositoryError(
        FREE_AGENT_DRAFT_RECOVERY_READ_REPOSITORY_CODES
          .authorizationDenied,
        "Current commissioner authority is required to read FAD recovery state."
      );
    }
  }

  function recoveryResource(row) {
    const action = RECOVERY_ACTION[row.kind];
    if (!action) {
      incompatible(
        "The FAD recovery kind is noncanonical."
      );
    }
    let resourceId;
    switch (action) {
      case "retry_deadline":
      case "complete_fad":
        resourceId = null;
        break;
      case "retry_allocation":
      case "activate_restricted":
      case "activate_fallback":
        resourceId = row.allocation_id;
        break;
      case "activate_queued_nomination":
        resourceId = row.nomination_queue_id;
        break;
      case "retry_auction_resolution":
        resourceId = row.auction_id;
        break;
      case "finalize_rollover":
        resourceId = row.rollover_id;
        break;
      default:
        incompatible(
          "The FAD recovery action is noncanonical."
        );
    }
    if (
      resourceId !== null &&
      !UUID_PATTERN.test(resourceId || "")
    ) {
      incompatible(
        "The FAD recovery resource is unavailable."
      );
    }
    return Object.freeze({ action, resourceId });
  }

  function projectRecovery(row, queueById) {
    const binding = recoveryResource(row);
    let playerId = row.player_id;
    if (row.kind === "queued_nomination_activation") {
      const queue = queueById.get(
        row.nomination_queue_id
      );
      if (
        !queue ||
        queue.player_id !== row.player_id ||
        queue.target_opening_rollover_id !==
          row.rollover_id ||
        !["queued", "opened", "invalid"].includes(
          queue.status
        )
      ) {
        incompatible(
          "The queued-nomination recovery evidence is split."
        );
      }
      if (queue.status === "queued") {
        playerId = null;
      }
    }
    return Object.freeze({
      recoveryId: row.id,
      kind: row.kind,
      status: row.status,
      playerId,
      allocationId: row.allocation_id,
      rolloverId: row.rollover_id,
      auctionId: row.auction_id,
      jobRunId: row.job_run_id,
      nominationQueueId: row.nomination_queue_id,
      earliestActivationAtMs:
        row.earliest_activation_at_ms,
      targetResolutionAtMs:
        row.target_resolution_at_ms,
      lastErrorCode: row.last_error_code,
      commissionerReason: row.commissioner_reason,
      createdByOperationId:
        row.created_by_operation_id,
      resolvedByUserId: row.resolved_by_user_id,
      resolvedByMembershipId:
        row.resolved_by_membership_id,
      resolvedAuthority: row.resolved_authority,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      resolvedAtMs: row.resolved_at_ms,
      version: row.version,
      _binding: binding,
    });
  }

  function buildRecoveryIndex(rows, queueById) {
    const projections = rows.map((row) =>
      projectRecovery(row, queueById)
    );
    const grouped = new Map();
    for (const recovery of projections) {
      const key = actionKey(
        recovery._binding.action,
        recovery._binding.resourceId
      );
      const values = grouped.get(key) || [];
      values.push(recovery);
      grouped.set(key, values);
    }
    for (const values of grouped.values()) {
      if (
        values.filter(
          ({ status }) => status !== "resolved"
        ).length > 1
      ) {
        incompatible(
          "Multiple unresolved FAD recoveries target one action resource."
        );
      }
    }
    return Object.freeze({
      grouped,
      projections,
      latest(key) {
        const values = grouped.get(key) || [];
        return values.length === 0
          ? null
          : values[values.length - 1];
      },
    });
  }

  function jobProjection({
    row,
    operationKind,
    resourceId,
    recoveryIndex,
    action,
  }) {
    if (!isCanonicalJob(row)) {
      incompatible(
        "A FAD operation has noncanonical job state."
      );
    }
    const key = actionKey(
      action,
      publicActionResourceId(action, resourceId)
    );
    const recoveries =
      recoveryIndex.grouped.get(key) || [];
    for (const recovery of recoveries) {
      if (
        recovery.createdByOperationId !== row.id ||
        (
          recovery.jobRunId !== null &&
          recovery.jobRunId !== row.id
        )
      ) {
        incompatible(
          "A FAD recovery is not bound to its causal operation."
        );
      }
    }
    const latestRecovery =
      recoveryIndex.latest(key);
    const status =
      row.status === "skipped"
        ? "succeeded"
        : row.status;
    return Object.freeze({
      operationId: row.id,
      operationKind,
      resourceId,
      occurrenceKey: row.occurrence_key,
      status,
      attemptCount: row.attempt_count,
      scheduledForMs: row.scheduled_for_ms,
      nextAttemptAtMs: row.next_attempt_at_ms,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms,
      lastErrorCode: row.last_error_code,
      recoveryId: latestRecovery?.recoveryId ?? null,
      blocksCompletion:
        !["succeeded", "skipped"].includes(
          row.status
        ) &&
        !(
          row.status === "failed" &&
          latestRecovery?.status === "resolved"
        ),
      version: row.version,
    });
  }

  function parseFadJob({
    row,
    fad,
    allocationsById,
    allocationsByPlayer,
    queuesById,
    rolloversById,
    rolloversBySequence,
    recoveryIndex,
  }) {
    const policy = JOB_POLICY[row.job_type];
    if (!policy || !FAD_JOB_TYPES.includes(row.job_type)) {
      incompatible("The FAD job type is unavailable.");
    }
    let occurrence;
    try {
      occurrence = parseFreeAgentDraftOccurrenceKey(
        row.occurrence_key
      );
    } catch (error) {
      incompatible(
        "A FAD operation occurrence is noncanonical.",
        error
      );
    }
    if (
      occurrence.fadId !== fad.id ||
      occurrence.type !== policy.occurrenceType
    ) {
      incompatible(
        "A FAD operation occurrence is cross-scoped."
      );
    }
    let resourceId;
    if (row.job_type === "fad_deadline") {
      resourceId = fad.id;
      if (
        occurrence.deadlineAtMs !==
          fad.candidate_deadline_at_ms ||
        row.scheduled_for_ms !==
          occurrence.deadlineAtMs
      ) {
        incompatible(
          "The FAD deadline occurrence is split."
        );
      }
    } else if (row.job_type === "fad_allocation") {
      const allocation = allocationsByPlayer.get(
        occurrence.playerId
      );
      if (
        !allocation ||
        row.scheduled_for_ms !==
          fad.candidate_deadline_at_ms
      ) {
        incompatible(
          "The FAD allocation occurrence is split."
        );
      }
      resourceId = allocation.id;
    } else if (
      row.job_type === "fad_restricted_activation" ||
      row.job_type === "fad_fallback_activation"
    ) {
      if (
        !allocationsById.has(occurrence.allocationId) ||
        row.scheduled_for_ms !==
          occurrence.activationAtMs
      ) {
        incompatible(
          "The FAD activation occurrence is split."
        );
      }
      resourceId = occurrence.allocationId;
    } else if (
      row.job_type ===
      "fad_queued_nomination_activation"
    ) {
      const queue = queuesById.get(occurrence.queueId);
      const rollover = queue
        ? rolloversById.get(
            queue.target_opening_rollover_id
          )
        : null;
      if (
        !queue ||
        !rollover ||
        rollover.rolls_over_at_ms !==
          occurrence.rolloverAtMs ||
        row.scheduled_for_ms !==
          occurrence.rolloverAtMs
      ) {
        incompatible(
          "The queued-nomination occurrence is split."
        );
      }
      resourceId = occurrence.queueId;
    } else if (row.job_type === "fad_rollover") {
      const rollover = rolloversBySequence.get(
        occurrence.sequence
      );
      if (
        !rollover ||
        rollover.rolls_over_at_ms !==
          occurrence.rolloverAtMs ||
        row.scheduled_for_ms !==
          occurrence.rolloverAtMs
      ) {
        incompatible(
          "The FAD rollover occurrence is split."
        );
      }
      resourceId = rollover.id;
    } else if (row.job_type === "fad_completion") {
      resourceId = fad.id;
    } else {
      incompatible("The FAD job type is unavailable.");
    }
    return Object.freeze({
      row,
      policy,
      resourceId,
      operation:
        policy.operationKind === null
          ? null
          : jobProjection({
              row,
              operationKind: policy.operationKind,
              resourceId,
              recoveryIndex,
              action: policy.action,
            }),
    });
  }

  function parseAuctionJob({
    row,
    fad,
    recoveryIndex,
  }) {
    let canonical;
    try {
      canonical = buildAuctionResolutionOccurrenceKey({
        auctionId: row.scoped_auction_id,
        dueAtMs: row.scoped_resolves_at_ms,
      });
    } catch (error) {
      incompatible(
        "The FAD auction-resolution occurrence is invalid.",
        error
      );
    }
    if (
      row.occurrence_key !== canonical ||
      row.scheduled_for_ms !==
        row.scoped_resolves_at_ms
    ) {
      incompatible(
        "The FAD auction-resolution occurrence is split."
      );
    }
    return Object.freeze({
      row,
      policy: JOB_POLICY["auction.resolve.target"],
      resourceId: row.scoped_auction_id,
      operation: jobProjection({
        row,
        operationKind: "auction_resolution",
        resourceId: row.scoped_auction_id,
        recoveryIndex,
        action: "retry_auction_resolution",
      }),
      fadId: fad.id,
    });
  }

  function rolloverProjection({
    row,
    jobBinding,
    recoveries,
  }) {
    if (!jobBinding || !isCanonicalJob(jobBinding.row)) {
      incompatible(
        "A FAD rollover is missing its exact operation."
      );
    }
    if (
      row.processing_job_run_id !== null &&
      row.processing_job_run_id !== jobBinding.row.id
    ) {
      incompatible(
        "The FAD rollover processing operation is split."
      );
    }
    if (
      row.status === "completed" &&
      !["succeeded", "skipped"].includes(
        jobBinding.row.status
      )
    ) {
      incompatible(
        "A completed FAD rollover has a nonterminal operation."
      );
    }
    if (
      row.status === "recovery_required" &&
      jobBinding.row.status !== "failed"
    ) {
      incompatible(
        "A recovery-required FAD rollover lacks a failed operation."
      );
    }
    return Object.freeze({
      rolloverId: row.id,
      sequence: row.sequence,
      opensAtMs: row.opens_at_ms,
      creationCutoffAtMs:
        row.creation_cutoff_at_ms,
      rollsOverAtMs: row.rolls_over_at_ms,
      status: row.status,
      processingStartedAtMs:
        row.processing_started_at_ms,
      completedAtMs: row.completed_at_ms,
      lastErrorCode: row.last_error_code,
      recoveryIds: recoveries
        .filter(
          (recovery) =>
            recovery.rolloverId === row.id
        )
        .map(({ recoveryId }) => recoveryId)
        .sort(compareText),
      blocksCompletion: row.status !== "completed",
      version: row.version,
    });
  }

  function scheduleRecoveryProjection({
    fad,
    competitionWeek,
    scope,
  }) {
    if (fad.schedule_recovery_id === null) {
      return null;
    }
    const parameters = {
      leagueId: scope.leagueId,
      seasonId: fad.season_id,
      fadId: fad.id,
      scheduleRecoveryId: fad.schedule_recovery_id,
    };
    const root = unique(
      scheduleRecoveryStatement,
      parameters,
      "The FAD completion schedule recovery"
    );
    if (!root) {
      incompatible(
        "The FAD completion schedule recovery is missing."
      );
    }
    const weeks = scheduleWeeksStatement.all(parameters);
    const matchups =
      scheduleMatchupsStatement.all(parameters);
    const jobs = scheduleJobsStatement.all(parameters);
    let sealed;
    try {
      sealed = createFreeAgentDraftScheduleRecoveryEvidence({
        recoveryId: root.id,
        leagueId: root.league_id,
        seasonId: root.season_id,
        fadId: root.fad_id,
        recoveryKind: root.recovery_kind,
        operationId: root.matchup_operation_id,
        oldScheduleOperationId:
          root.old_schedule_operation_id,
        newScheduleOperationId:
          root.new_schedule_operation_id,
        oldScheduleVersion:
          root.old_schedule_version,
        newScheduleVersion:
          root.new_schedule_version,
        oldFirstMatchupWeekId:
          root.old_first_matchup_week_id,
        newFirstMatchupWeekId:
          root.new_first_matchup_week_id,
        oldWeek1StartsAtMs:
          root.old_week_one_starts_at_ms,
        newWeek1StartsAtMs:
          root.new_week_one_starts_at_ms,
        completedAtMs: root.completed_at_ms,
        removedWeeks: weeks.map((row) => ({
          matchupWeekId:
            row.removed_matchup_week_id,
          sequence: row.removed_sequence,
          startsAtMs: row.removed_starts_at_ms,
        })),
        removedMatchups: matchups.map((row) => ({
          matchupId: row.removed_matchup_id,
          matchupWeekId:
            row.removed_matchup_week_id,
        })),
        jobEffects: jobs.map((row) => ({
          disposition: row.disposition,
          jobType: row.job_type,
          oldJobRunId: row.replaced_job_run_id,
          oldOccurrenceKey:
            row.replaced_occurrence_key,
          oldScheduleOperationId:
            row.replaced_schedule_operation_id,
          oldScheduleVersion:
            row.replaced_schedule_version,
          newJobRunId:
            row.replacement_job_run_id,
          newOccurrenceKey:
            row.replacement_occurrence_key,
          newScheduleOperationId:
            row.replacement_schedule_operation_id,
          newScheduleVersion:
            row.replacement_schedule_version,
        })),
      });
    } catch (error) {
      incompatible(
        "The FAD schedule-recovery evidence is invalid.",
        error
      );
    }
    const replacedJobs = jobs.filter(
      ({ disposition }) => disposition === "replaced"
    );
    if (
      root.recovery_kind !== "completion" ||
      root.evidence_schema_version !== 1 ||
      root.evidence_sha256 !== sealed.evidenceSha256 ||
      root.removed_week_count !== weeks.length ||
      root.removed_matchup_count !== matchups.length ||
      root.replaced_job_count !== replacedJobs.length ||
      root.cancelled_job_count !==
        jobs.filter(
          ({ disposition }) =>
            disposition === "cancelled"
        ).length ||
      root.version !== 1 ||
      fad.status !== "completed" ||
      fad.completed_at_ms !== root.completed_at_ms ||
      fad.free_agent_draft_completed_at_ms !==
        root.completed_at_ms ||
      fad.first_matchup_week_id !==
        root.old_first_matchup_week_id ||
      fad.current_competition_first_matchup_week_id !==
        root.new_first_matchup_week_id ||
      fad.first_matchup_starts_at_ms !==
        root.old_week_one_starts_at_ms ||
      competitionWeek.starts_at_ms !==
        root.new_week_one_starts_at_ms ||
      competitionWeek.schedule_operation_id !==
        root.new_schedule_operation_id ||
      competitionWeek.schedule_version !==
        root.new_schedule_version ||
      root.matchup_operation_id !==
        root.new_schedule_operation_id
    ) {
      incompatible(
        "The FAD schedule-recovery root is inconsistent."
      );
    }
    return Object.freeze({
      operationId: root.matchup_operation_id,
      status: "succeeded",
      oldWeek1StartsAtMs:
        root.old_week_one_starts_at_ms,
      newWeek1StartsAtMs:
        root.new_week_one_starts_at_ms,
      oldScheduleVersion: root.old_schedule_version,
      newScheduleVersion: root.new_schedule_version,
      removedWeekIds: weeks.map(
        (row) => row.removed_matchup_week_id
      ),
      removedMatchupIds: matchups.map(
        (row) => row.removed_matchup_id
      ),
      replacedJobs: replacedJobs.map((row) => ({
        oldJobId: row.replaced_job_run_id,
        oldOccurrenceKey:
          row.replaced_occurrence_key,
        newJobId: row.replacement_job_run_id,
        newOccurrenceKey:
          row.replacement_occurrence_key,
      })),
      completedAtMs: root.completed_at_ms,
      version: root.version,
    });
  }

  function readRecovery(input) {
    const scope = normalizeInput(input);
    try {
      requireAuthority(scope);
      const fad = unique(
        fadStatement,
        scope,
        "The scoped FAD recovery view"
      );
      if (!fad) notFound();
      const common = {
        leagueId: scope.leagueId,
        seasonId: fad.season_id,
        fadId: fad.id,
      };
      const competitionWeek = unique(
        competitionWeekStatement,
        {
          ...common,
          weekId:
            fad.current_competition_first_matchup_week_id,
        },
        "The current FAD competition Week 1"
      );
      if (!competitionWeek) {
        incompatible(
          "The current FAD competition Week 1 is unavailable."
        );
      }
      const allocations =
        allocationStatement.all(common);
      const queues = queueStatement.all(common);
      const rolloverRows =
        rolloverStatement.all(common);
      if (
        rolloverRows.length < 7 ||
        rolloverRows.some(
          (row, index) => row.sequence !== index + 1
        )
      ) {
        incompatible(
          "FAD rollover sequence evidence is noncontiguous."
        );
      }
      const allocationsById = new Map(
        allocations.map((row) => [row.id, row])
      );
      const allocationsByPlayer = new Map();
      for (const row of allocations) {
        if (allocationsByPlayer.has(row.player_id)) {
          incompatible(
            "A FAD player has ambiguous allocation evidence."
          );
        }
        allocationsByPlayer.set(row.player_id, row);
      }
      const queuesById = new Map(
        queues.map((row) => [row.id, row])
      );
      const rolloversById = new Map(
        rolloverRows.map((row) => [row.id, row])
      );
      const rolloversBySequence = new Map(
        rolloverRows.map((row) => [
          row.sequence,
          row,
        ])
      );
      const recoveryRows =
        recoveryStatement.all(common);
      const recoveryIndex = buildRecoveryIndex(
        recoveryRows,
        queuesById
      );
      const fadJobRows = fadJobStatement.all({
        ...common,
        occurrencePrefix: `fad:${fad.id}:`,
      });
      const parsedFadJobs = fadJobRows.map((row) =>
        parseFadJob({
          row,
          fad,
          allocationsById,
          allocationsByPlayer,
          queuesById,
          rolloversById,
          rolloversBySequence,
          recoveryIndex,
        })
      );
      const parsedAuctionJobs =
        auctionJobStatement
          .all(common)
          .map((row) =>
            parseAuctionJob({
              row,
              fad,
              recoveryIndex,
            })
          );
      const allBindings = [
        ...parsedFadJobs,
        ...parsedAuctionJobs,
      ];
      const bindingByActionResource = new Map();
      for (const binding of allBindings) {
        const key = actionKey(
          binding.policy.action,
          publicActionResourceId(
            binding.policy.action,
            binding.resourceId
          )
        );
        if (bindingByActionResource.has(key)) {
          incompatible(
            "A FAD action resource has ambiguous operation evidence."
          );
        }
        for (const recovery of
          recoveryIndex.grouped.get(key) || []) {
          if (
            recovery.createdByOperationId !==
              binding.row.id ||
            (
              recovery.jobRunId !== null &&
              recovery.jobRunId !== binding.row.id
            )
          ) {
            incompatible(
              "A FAD recovery is not bound to its causal operation."
            );
          }
        }
        bindingByActionResource.set(key, binding);
      }
      for (const key of recoveryIndex.grouped.keys()) {
        if (!bindingByActionResource.has(key)) {
          incompatible(
            "A FAD recovery lacks its exact action operation."
          );
        }
      }
      const rolloverBindings = new Map(
        parsedFadJobs
          .filter(
            ({ policy }) =>
              policy.action === "finalize_rollover"
          )
          .map((binding) => [
            binding.resourceId,
            binding,
          ])
      );
      const recoveries = recoveryIndex.projections.map(
        ({ _binding, ...projection }) => projection
      );
      const rollovers = rolloverRows.map((row) =>
        rolloverProjection({
          row,
          jobBinding: rolloverBindings.get(row.id),
          recoveries,
        })
      );
      const operations = allBindings
        .map(({ operation }) => operation)
        .filter(Boolean)
        .sort(compareOperation);
      const deadlineOperations = operations.filter(
        ({ operationKind }) =>
          operationKind === "deadline"
      );
      const completionOperations = operations.filter(
        ({ operationKind }) =>
          operationKind === "completion"
      );
      if (
        deadlineOperations.length > 1 ||
        completionOperations.length > 1
      ) {
        incompatible(
          "A singleton FAD operation is ambiguous."
        );
      }
      const availableActions = [
        ...bindingByActionResource.entries(),
      ]
        .map(([key, binding]) => {
          const latest = recoveryIndex.latest(key);
          const enabled =
            latest !== null &&
            ["pending", "ready"].includes(
              latest.status
            );
          return {
            action: binding.policy.action,
            resourceId: [
              "retry_deadline",
              "complete_fad",
            ].includes(binding.policy.action)
              ? null
              : binding.resourceId,
            enabled,
            reasonCode: enabled
              ? null
              : "RECOVERY_NOT_AVAILABLE",
          };
        })
        .sort(
          (left, right) =>
            FREE_AGENT_DRAFT_RECOVERY_READ_ACTIONS.indexOf(
              left.action
            ) -
              FREE_AGENT_DRAFT_RECOVERY_READ_ACTIONS.indexOf(
                right.action
              ) ||
            compareText(
              left.resourceId || "",
              right.resourceId || ""
            )
        );
      const counts = countsStatement.get(common);
      if (
        counts.participating_teams !==
          fad.participating_team_count ||
        counts.rollovers_persisted !==
          rolloverRows.length ||
        counts.rollovers_completed !==
          rolloverRows.filter(
            ({ status }) => status === "completed"
          ).length ||
        counts.recoveries_open !==
          recoveryRows.filter(
            ({ status }) => status !== "resolved"
          ).length
      ) {
        incompatible(
          "The FAD recovery counts are inconsistent."
        );
      }
      const nextRollover = rolloverRows.find(
        ({ status }) => status !== "completed"
      );
      let phase;
      try {
        phase = deriveFreeAgentDraftViewerPhase({
          status: fad.status,
          nowMs: scope.nowMs,
          cardsOpenedAtMs: fad.opened_at_ms,
          helpOpensAtMs: fad.help_opens_at_ms,
          candidateDeadlineAtMs:
            fad.candidate_deadline_at_ms,
        });
      } catch (error) {
        incompatible(
          "The FAD recovery viewer clock is invalid.",
          error
        );
      }
      const scheduleRecovery =
        scheduleRecoveryProjection({
          fad,
          competitionWeek,
          scope,
        });
      const projection = {
        fad: {
          leagueId: fad.league_id,
          seasonId: fad.season_id,
          fadId: fad.id,
          version: fad.version,
          status: fad.status,
          phase,
          openedAtMs: fad.opened_at_ms,
          reminderAtMs:
            fad.candidate_deadline_at_ms -
            FREE_AGENT_DRAFT_REMINDER_LEAD_MS,
          helpOpensAtMs: fad.help_opens_at_ms,
          candidateDeadlineAtMs:
            fad.candidate_deadline_at_ms,
          deadlineLockedAtMs:
            fad.deadline_locked_at_ms,
          allocationCompletedAtMs:
            fad.allocation_completed_at_ms,
          nextRolloverAtMs:
            nextRollover?.rolls_over_at_ms ?? null,
          frozenFadFirstMatchupStartsAtMs:
            fad.first_matchup_starts_at_ms,
          competitionFirstMatchupStartsAtMs:
            competitionWeek.starts_at_ms,
          scheduleRecoveryOperationId:
            scheduleRecovery?.operationId ?? null,
          completedAtMs: fad.completed_at_ms,
          counts: {
            participatingTeams:
              counts.participating_teams,
            cardsLocked: counts.cards_locked,
            allocationsPending:
              counts.allocations_pending,
            allocationsAutomatic:
              counts.allocations_automatic,
            restrictedPending:
              counts.restricted_pending,
            restrictedFallbackPending:
              counts.restricted_fallback_pending,
            rapidAuctionsOpen:
              counts.rapid_auctions_open,
            queuedNominations:
              counts.queued_nominations,
            rolloversPersisted:
              counts.rollovers_persisted,
            rolloversCompleted:
              counts.rollovers_completed,
            recoveriesOpen: counts.recoveries_open,
          },
        },
        deadlineOperation:
          deadlineOperations[0] || null,
        allocationOperations: operations.filter(
          ({ operationKind }) =>
            [
              "allocation",
              "restricted_activation",
            ].includes(operationKind)
        ),
        rapidOperations: operations.filter(
          ({ operationKind }) =>
            [
              "queued_nomination_activation",
              "fallback_activation",
              "auction_resolution",
            ].includes(operationKind)
        ),
        completionOperation:
          completionOperations[0] || null,
        rollovers,
        recoveries,
        availableActions,
      };
      if (scheduleRecovery !== null) {
        projection.scheduleRecoveryEvidence =
          scheduleRecovery;
      }
      try {
        return projectFreeAgentDraftRecoveryRead(
          projection
        );
      } catch (error) {
        incompatible(
          "The canonical FAD recovery-read projection is unavailable.",
          error
        );
      }
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readFadRecovery",
        tableName: "free_agent_drafts",
      });
    }
  }

  return Object.freeze({ readRecovery });
}

module.exports = {
  FREE_AGENT_DRAFT_RECOVERY_READ_REPOSITORY_CODES,
  createSqliteFreeAgentDraftRecoveryReadRepository,
};
