const {
  isDeepStrictEqual,
} = require("node:util");

const {
  ENTRY_DRAFT_RESCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_OPERATION,
} = require(
  "../../../domain/drafts/entryDraftSchedulePolicy"
);
const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
} = require(
  "../../../domain/leagues/seasonRolloverJobPolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteSecurityAuditRepository,
} = require("./SqliteSecurityAuditRepository");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RESULT_TYPE = "entry_draft_schedule";
const SCHEDULE_AUDIT_EVENT =
  "entry_draft.scheduled";
const RESCHEDULE_AUDIT_EVENT =
  "entry_draft.rescheduled";
const SCHEDULE_EVENT =
  "entry_draft_scheduled";
const RESCHEDULE_EVENT =
  "entry_draft_rescheduled";

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

function exactObject(
  value,
  expectedKeys,
  message
) {
  if (!isPlainObject(value)) invalid(message);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    invalid(message);
  }
  return value;
}

function stableId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`
    );
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
    invalid(
      `A positive ${description} is required.`
    );
  }
  return value;
}

function boundedText(
  value,
  maximum,
  description,
  { nullable = false } = {}
) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(
      value
    )
  ) {
    invalid(
      `A bounded ${description} is required.`
    );
  }
  return value;
}

function freeze(value) {
  return value === null
    ? null
    : Object.freeze({ ...value });
}

function uniqueRow(
  statement,
  parameters,
  description
) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(`${description} was not unique.`);
  }
  return rows[0] || null;
}

function runExactly(statement, parameters, message) {
  if (statement.run(parameters).changes !== 1) {
    conflict(message);
  }
}

function auditClientMetadata(
  encoded,
  actorAuthority
) {
  let metadata = {};
  if (encoded !== undefined && encoded !== null) {
    if (typeof encoded !== "string") {
      invalid(
        "Entry Draft schedule audit metadata must be encoded JSON."
      );
    }
    try {
      metadata = JSON.parse(encoded);
    } catch {
      invalid(
        "Entry Draft schedule audit metadata must be encoded JSON."
      );
    }
    if (!isPlainObject(metadata)) {
      invalid(
        "Entry Draft schedule audit metadata must be a JSON object."
      );
    }
  }
  return JSON.stringify({
    ...metadata,
    actorAuthority,
  });
}

function idempotencyResult(row) {
  if (!row) return null;
  return Object.freeze({
    leagueId: row.league_id,
    actorUserId: row.actor_user_id,
    operation: row.operation,
    clientKey: row.client_key,
    requestHash: row.request_hash,
    status: row.status,
    resultType: row.result_type,
    resultId: row.result_id,
    completedAtMs: row.completed_at_ms,
  });
}

function scheduleResult(row) {
  if (!row) return null;
  return Object.freeze({
    operationId: row.id,
    entryDraftId: row.entry_draft_id,
    entryDraftVersion:
      row.entry_draft_version_after,
    rolloverBindingId:
      row.rollover_binding_id,
    rolloverBindingVersion:
      row.rollover_binding_version_after,
    rolloverOccurrenceId:
      row.rollover_occurrence_id,
    scheduledStartsAtMs:
      row.scheduled_starts_at_ms,
    jobRunId: row.scheduled_job_run_id,
    action: row.action,
  });
}

function normalizeLookup(options, keys, description) {
  exactObject(options, keys, description);
  const normalized = {};
  for (const key of keys) {
    if (
      key === "operation" ||
      key === "clientKey"
    ) {
      normalized[key] = boundedText(
        options[key],
        key === "operation" ? 128 : 500,
        key === "operation"
          ? "idempotency operation"
          : "idempotency key"
      );
    } else {
      normalized[key] = stableId(
        options[key],
        key.replace(
          /([A-Z])/g,
          " $1"
        ).toLowerCase()
      );
    }
  }
  return normalized;
}

function normalizePlan(plan) {
  if (!isPlainObject(plan)) {
    invalid(
      "An exact Entry Draft schedule plan is required."
    );
  }
  const {
    action,
    actor,
    auditContext,
    entryDraft,
    idempotency,
    ids,
    job,
    leagueId,
    nowMs,
    reason,
    replacement,
    result,
    serverBinding,
  } = plan;
  if (
    ![
      ENTRY_DRAFT_SCHEDULE_ACTION,
      ENTRY_DRAFT_RESCHEDULE_ACTION,
    ].includes(action)
  ) {
    invalid(
      "A supported Entry Draft schedule action is required."
    );
  }
  stableId(leagueId, "league identifier");
  safeTimestamp(nowMs, "schedule timestamp");
  if (!isPlainObject(actor)) {
    invalid(
      "Canonical Entry Draft schedule authority is required."
    );
  }
  stableId(actor.actorUserId, "actor-user identifier");
  stableId(
    actor.membershipId,
    "actor-membership identifier"
  );
  if (
    actor.leagueId !== leagueId ||
    ![
      "commissioner",
      "platform_administrator_as_commissioner",
    ].includes(actor.authority)
  ) {
    invalid(
      "Canonical Entry Draft schedule authority is required."
    );
  }
  if (!isPlainObject(entryDraft)) {
    invalid(
      "Canonical Entry Draft schedule state is required."
    );
  }
  stableId(entryDraft.id, "Entry Draft identifier");
  positiveInteger(
    entryDraft.expectedVersion,
    "Entry Draft version"
  );
  if (
    !["setup", "lottery_ready", "ready"].includes(
      entryDraft.status
    )
  ) {
    invalid(
      "Canonical Entry Draft schedule state is required."
    );
  }
  if (!isPlainObject(idempotency)) {
    invalid(
      "Canonical Entry Draft schedule idempotency is required."
    );
  }
  stableId(
    idempotency.operationId,
    "schedule-operation identifier"
  );
  boundedText(
    idempotency.clientKey,
    500,
    "idempotency key"
  );
  safeTimestamp(
    idempotency.expiresAtMs,
    "idempotency expiry"
  );
  if (
    idempotency.expiresAtMs <= nowMs ||
    idempotency.operation !==
      ENTRY_DRAFT_SCHEDULE_OPERATION ||
    idempotency.resultType !== RESULT_TYPE ||
    typeof idempotency.requestHash !==
      "string" ||
    !DIGEST_PATTERN.test(
      idempotency.requestHash
    )
  ) {
    invalid(
      "Canonical Entry Draft schedule idempotency is required."
    );
  }
  if (
    !isPlainObject(ids) ||
    !Array.isArray(ids.notificationIds) ||
    ids.notificationIds.length < 1
  ) {
    invalid(
      "Canonical Entry Draft schedule evidence identifiers are required."
    );
  }
  for (const key of [
    "auditEventId",
    "draftEventId",
    "jobRunId",
    "outboxEventId",
    "rolloverBindingId",
    "rolloverOccurrenceId",
  ]) {
    stableId(
      ids[key],
      `${key} identifier`
    );
  }
  const notificationIds =
    ids.notificationIds.map((notification) => {
      if (!isPlainObject(notification)) {
        invalid(
          "Canonical Entry Draft schedule notification identifiers are required."
        );
      }
      return Object.freeze({
        id: stableId(
          notification.id,
          "notification identifier"
        ),
        userId: stableId(
          notification.userId,
          "notification user identifier"
        ),
      });
    });
  if (
    new Set(
      notificationIds.map(({ id }) => id)
    ).size !== notificationIds.length ||
    new Set(
      notificationIds.map(({ userId }) => userId)
    ).size !== notificationIds.length
  ) {
    invalid(
      "Entry Draft schedule notification identifiers must be unique."
    );
  }
  if (!isPlainObject(job)) {
    invalid(
      "Canonical Entry Draft rollover job evidence is required."
    );
  }
  boundedText(
    job.occurrenceKey,
    500,
    "rollover occurrence key"
  );
  safeTimestamp(
    job.scheduledForMs,
    "rollover scheduled timestamp"
  );
  if (
    job.jobType !==
    ENTRY_DRAFT_ROLLOVER_JOB_TYPE
  ) {
    invalid(
      "The Entry Draft rollover job type is required."
    );
  }
  if (!isPlainObject(result)) {
    invalid(
      "Canonical Entry Draft schedule result evidence is required."
    );
  }
  for (const key of [
    "operationId",
    "entryDraftId",
    "rolloverBindingId",
    "rolloverOccurrenceId",
    "jobRunId",
  ]) {
    stableId(
      result[key],
      `result ${key} identifier`
    );
  }
  positiveInteger(
    result.entryDraftVersion,
    "result Entry Draft version"
  );
  positiveInteger(
    result.rolloverBindingVersion,
    "result rollover-binding version"
  );
  safeTimestamp(
    result.scheduledStartsAtMs,
    "result scheduled timestamp"
  );
  if (
    result.action !== action ||
    result.operationId !==
      idempotency.operationId ||
    result.entryDraftId !== entryDraft.id ||
    result.entryDraftVersion !==
      entryDraft.expectedVersion + 1 ||
    result.rolloverBindingId !==
      ids.rolloverBindingId ||
    result.rolloverOccurrenceId !==
      ids.rolloverOccurrenceId ||
    result.jobRunId !== ids.jobRunId ||
    result.scheduledStartsAtMs !==
      job.scheduledForMs
  ) {
    invalid(
      "The Entry Draft schedule result does not match its plan."
    );
  }
  if (!isPlainObject(serverBinding)) {
    invalid(
      "Canonical server-owned Entry Draft schedule evidence is required."
    );
  }
  for (const name of [
    "sourceSeason",
    "targetSeason",
    "targetSchedule",
  ]) {
    if (!isPlainObject(serverBinding[name])) {
      invalid(
        "Canonical server-owned Entry Draft schedule evidence is required."
      );
    }
  }
  if (
    serverBinding.sourceSeason.leagueId !==
      leagueId ||
    serverBinding.targetSeason.leagueId !==
      leagueId ||
    serverBinding.targetSchedule.leagueId !==
      leagueId ||
    serverBinding.targetSchedule.seasonId !==
      serverBinding.targetSeason.id
  ) {
    invalid(
      "Server-owned Entry Draft schedule evidence crossed league scope."
    );
  }
  for (const value of [
    serverBinding.sourceSeason.id,
    serverBinding.targetSeason.id,
    serverBinding.targetSchedule.id,
    serverBinding.targetSchedule
      .weekOneMatchupWeekId,
  ]) {
    stableId(
      value,
      "server-owned schedule evidence"
    );
  }
  for (const value of [
    serverBinding.sourceSeason.version,
    serverBinding.targetSeason.version,
    serverBinding.targetSchedule.version,
  ]) {
    positiveInteger(
      value,
      "server-owned schedule version"
    );
  }
  if (
    action === ENTRY_DRAFT_SCHEDULE_ACTION
      ? replacement !== null ||
        result.rolloverBindingVersion !== 1 ||
        reason !== null
      : !isPlainObject(replacement) ||
        result.rolloverBindingVersion !==
          replacement.version + 1
  ) {
    invalid(
      "The Entry Draft schedule replacement evidence is inconsistent."
    );
  }
  if (reason !== null) {
    boundedText(
      reason,
      500,
      "Entry Draft reschedule reason"
    );
  }
  if (
    auditContext !== null &&
    auditContext !== undefined &&
    !isPlainObject(auditContext)
  ) {
    invalid(
      "Safe Entry Draft schedule audit context is required."
    );
  }
  return Object.freeze({
    ...plan,
    ids: Object.freeze({
      ...ids,
      notificationIds: Object.freeze(
        notificationIds
      ),
    }),
  });
}

function createSqliteEntryDraftScheduleRepository({
  database,
  auditRepository,
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
      "createSqliteEntryDraftScheduleRepository requires an opened database"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "Entry Draft schedule beforeCommit must be a function"
    );
  }

  const audits =
    auditRepository === undefined
      ? createSqliteSecurityAuditRepository({
          database,
        })
      : auditRepository;
  if (
    !audits ||
    typeof audits.append !== "function"
  ) {
    throw new TypeError(
      "Entry Draft scheduling requires a security-audit repository"
    );
  }
  const notifications =
    resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
  const outbox =
    resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });

  let idempotencyByScopeStatement;
  let scheduleResultStatement;
  let draftContextStatement;
  let sourceSeasonStatement;
  let targetScheduleStatement;
  let lotteryReadinessStatement;
  let eligibilityReadinessStatement;
  let pickReadinessStatement;
  let recipientsStatement;
  let bindingStatement;
  let activeMembershipStatement;
  let insertIdempotencyStatement;
  let insertJobStatement;
  let initialDraftStatement;
  let rescheduleDraftStatement;
  let skipJobStatement;
  let supersedeOccurrenceStatement;
  let insertBindingStatement;
  let updateBindingStatement;
  let insertOccurrenceStatement;
  let insertOperationStatement;
  let insertDraftEventStatement;
  let completeIdempotencyStatement;

  try {
    idempotencyByScopeStatement =
      database.prepare(`
        SELECT
          league_id,
          actor_user_id,
          operation,
          client_key,
          request_hash,
          status,
          result_type,
          result_id,
          completed_at_ms
        FROM idempotency_requests
        WHERE league_id = @leagueId
          AND actor_user_id = @actorUserId
          AND operation = @operation
          AND client_key = @clientKey
        LIMIT 2
      `);
    scheduleResultStatement =
      database.prepare(`
        SELECT
          id,
          entry_draft_id,
          action,
          rollover_binding_id,
          rollover_occurrence_id,
          scheduled_job_run_id,
          scheduled_starts_at_ms,
          entry_draft_version_after,
          rollover_binding_version_after
        FROM entry_draft_schedule_operations
        WHERE league_id = @leagueId
          AND id = @operationId
        LIMIT 2
      `);
    draftContextStatement = database.prepare(`
      SELECT
        draft.id,
        draft.league_id,
        draft.season_id,
        draft.status,
        draft.rounds,
        draft.pick_clock_seconds,
        draft.starts_at_ms,
        draft.version,
        league.timezone AS league_timezone,
        league.current_season_id,
        league.version AS league_version,
        target.status AS target_status,
        target.regular_season_starts_at_ms
          AS target_regular_season_starts_at_ms,
        target.regular_season_ends_at_ms
          AS target_regular_season_ends_at_ms,
        target.fantasy_playoffs_start_at_ms
          AS target_fantasy_playoffs_start_at_ms,
        target.fantasy_playoffs_end_at_ms
          AS target_fantasy_playoffs_end_at_ms,
        target.version AS target_version
      FROM entry_drafts AS draft
      JOIN leagues AS league
        ON league.id = draft.league_id
      JOIN seasons AS target
        ON target.league_id = draft.league_id
       AND target.id = draft.season_id
      WHERE draft.league_id = @leagueId
        AND draft.id = @entryDraftId
      LIMIT 2
    `);
    sourceSeasonStatement = database.prepare(`
      SELECT
        source.id,
        source.league_id,
        source.status,
        source.regular_season_ends_at_ms,
        source.version,
        finalization.id AS finalization_id,
        finalization.finalized_at_ms,
        finalization.expected_matchup_count,
        finalization.finalized_matchup_count,
        finalization.participant_count,
        finalization.result_set_hash,
        finalization.standings_rule_version,
        finalization.season_version_after
          AS finalization_season_version,
        snapshot.id AS standings_snapshot_id,
        snapshot.snapshot_version
          AS standings_snapshot_version
      FROM seasons AS source
      LEFT JOIN standings_snapshot_finalizations
        AS finalization
        ON finalization.league_id = source.league_id
       AND finalization.season_id = source.id
       AND finalization.status = 'final'
      LEFT JOIN standings_snapshots AS snapshot
        ON snapshot.league_id = finalization.league_id
       AND snapshot.season_id = finalization.season_id
       AND snapshot.id =
         finalization.standings_snapshot_id
       AND snapshot.status = 'final'
      WHERE source.league_id = @leagueId
        AND source.id = @sourceSeasonId
      LIMIT 2
    `);
    targetScheduleStatement = database.prepare(`
      SELECT
        generation.schedule_operation_id,
        generation.schedule_version,
        generation.week_one_matchup_week_id,
        generation.week_one_starts_at_ms
      FROM season_matchup_schedule_generations
        AS generation
      JOIN matchup_operations AS operation
        ON operation.league_id =
          generation.league_id
       AND operation.season_id =
          generation.season_id
       AND operation.id =
          generation.schedule_operation_id
       AND operation.operation_type =
         'schedule_generate'
       AND operation.status = 'succeeded'
       AND operation.completed_at_ms IS NOT NULL
      JOIN matchup_weeks AS week_one
        ON week_one.league_id =
          generation.league_id
       AND week_one.season_id =
          generation.season_id
       AND week_one.id =
          generation.week_one_matchup_week_id
       AND week_one.sequence = 1
       AND week_one.starts_at_ms =
          generation.week_one_starts_at_ms
      WHERE generation.league_id = @leagueId
        AND generation.season_id = @targetSeasonId
        AND generation.status = 'current'
      LIMIT 2
    `);
    lotteryReadinessStatement = database.prepare(`
      SELECT
        run.id,
        run.participant_count,
        (
          SELECT COUNT(*)
          FROM draft_lottery_results AS result
          WHERE result.league_id = run.league_id
            AND result.lottery_run_id = run.id
        ) AS result_count,
        (
          SELECT MIN(result.final_draft_position)
          FROM draft_lottery_results AS result
          WHERE result.league_id = run.league_id
            AND result.lottery_run_id = run.id
        ) AS minimum_position,
        (
          SELECT MAX(result.final_draft_position)
          FROM draft_lottery_results AS result
          WHERE result.league_id = run.league_id
            AND result.lottery_run_id = run.id
        ) AS maximum_position,
        (
          SELECT COUNT(*)
          FROM teams AS current_team
          WHERE current_team.league_id =
              run.league_id
            AND current_team.status IN (
              'setup',
              'active'
            )
        ) AS current_team_count,
        (
          SELECT COUNT(*)
          FROM draft_lottery_results AS result
          JOIN teams AS current_team
            ON current_team.league_id =
              result.league_id
           AND current_team.id =
              result.original_team_id
           AND current_team.status IN (
             'setup',
             'active'
           )
          WHERE result.league_id = run.league_id
            AND result.lottery_run_id = run.id
        ) AS current_result_team_count
      FROM draft_lottery_runs AS run
      WHERE run.league_id = @leagueId
        AND run.draft_id = @entryDraftId
        AND run.status = 'committed'
      LIMIT 2
    `);
    eligibilityReadinessStatement =
      database.prepare(`
        SELECT
          snapshot.id,
          (
            SELECT COUNT(*)
            FROM draft_eligible_players AS player
            WHERE player.league_id =
                snapshot.league_id
              AND player.eligibility_snapshot_id =
                snapshot.id
          ) AS player_count
        FROM draft_eligibility_snapshots
          AS snapshot
        WHERE snapshot.league_id = @leagueId
          AND snapshot.draft_id = @entryDraftId
          AND snapshot.status = 'confirmed'
        LIMIT 2
      `);
    pickReadinessStatement = database.prepare(`
      SELECT
        COUNT(*) AS pick_count,
        COALESCE(SUM(
          CASE
            WHEN pick.target_season_id <>
                 @targetSeasonId
              OR pick.status <> 'unused'
              OR pick.round_number NOT BETWEEN 1 AND 4
              OR pick.position_number < 1
              OR pick.position_number >
                 @participantCount
              OR team.status NOT IN ('setup', 'active')
              OR NOT EXISTS (
                SELECT 1
                FROM draft_lottery_results
                  AS result
                WHERE result.league_id =
                    pick.league_id
                  AND result.lottery_run_id =
                    @lotteryRunId
                  AND result.final_draft_position =
                    pick.position_number
                  AND result.original_team_id =
                    pick.original_team_id
              )
            THEN 1
            ELSE 0
          END
        ), 0) AS invalid_pick_count
      FROM draft_picks AS pick
      JOIN teams AS team
        ON team.league_id = pick.league_id
       AND team.id = pick.current_owner_team_id
      WHERE pick.league_id = @leagueId
        AND pick.draft_id = @entryDraftId
    `);
    recipientsStatement = database.prepare(`
      SELECT DISTINCT user_id
      FROM league_memberships
      WHERE league_id = @leagueId
        AND status = 'active'
      ORDER BY user_id ASC
    `);
    bindingStatement = database.prepare(`
      SELECT
        binding.*,
        occurrence.id AS occurrence_id,
        occurrence.occurrence_key,
        occurrence.status AS occurrence_status,
        run.id AS job_id,
        run.version AS job_version,
        run.job_type,
        run.status AS job_status,
        run.attempt_count AS job_attempt_count,
        run.occurrence_key AS job_occurrence_key,
        run.scheduled_for_ms,
        run.started_at_ms,
        run.lease_owner,
        run.lease_token,
        run.lease_expires_at_ms,
        run.completed_at_ms,
        run.result_json AS job_result_json,
        run.last_error_code AS job_last_error_code,
        run.next_attempt_at_ms
          AS job_next_attempt_at_ms,
        (
          SELECT COUNT(*)
          FROM season_rollover_attempts AS attempt
          WHERE attempt.league_id =
              binding.league_id
            AND attempt.binding_id = binding.id
            AND attempt.rollover_occurrence_id =
              occurrence.id
        ) AS rollover_attempt_count
      FROM entry_draft_rollover_bindings
        AS binding
      JOIN season_rollover_occurrences
        AS occurrence
        ON occurrence.league_id =
          binding.league_id
       AND occurrence.binding_id = binding.id
       AND occurrence.id =
          binding.current_rollover_occurrence_id
       AND occurrence.scheduled_job_run_id =
          binding.current_scheduled_job_run_id
      JOIN job_runs AS run
        ON run.league_id = binding.league_id
       AND run.id =
          binding.current_scheduled_job_run_id
      WHERE binding.league_id = @leagueId
        AND binding.entry_draft_id =
          @entryDraftId
      LIMIT 2
    `);
    activeMembershipStatement =
      database.prepare(`
        SELECT membership.id
        FROM league_memberships AS membership
        JOIN leagues AS league
          ON league.id = membership.league_id
        WHERE membership.league_id = @leagueId
          AND membership.id = @membershipId
          AND membership.user_id = @actorUserId
          AND membership.status = 'active'
          AND (
            (
              @authority = 'commissioner'
              AND league.commissioner_membership_id =
                membership.id
              AND membership.permission_category =
                'commissioner'
            )
            OR (
              @authority =
                'platform_administrator_as_commissioner'
              AND EXISTS (
                SELECT 1
                FROM platform_roles AS role
                WHERE role.user_id =
                    membership.user_id
                  AND role.role =
                    'platform_administrator'
                  AND role.status = 'active'
              )
            )
          )
        LIMIT 2
      `);
    insertIdempotencyStatement =
      database.prepare(`
        INSERT INTO idempotency_requests (
          id,
          league_id,
          actor_user_id,
          operation,
          client_key,
          request_hash,
          status,
          result_type,
          result_id,
          created_at_ms,
          completed_at_ms,
          expires_at_ms
        ) VALUES (
          @operationId,
          @leagueId,
          @actorUserId,
          @operation,
          @clientKey,
          @requestHash,
          'started',
          NULL,
          NULL,
          @nowMs,
          NULL,
          @expiresAtMs
        )
      `);
    insertJobStatement = database.prepare(`
      INSERT INTO job_runs (
        id,
        league_id,
        season_id,
        job_type,
        occurrence_key,
        scheduled_for_ms,
        status,
        attempt_count,
        lease_owner,
        lease_expires_at_ms,
        started_at_ms,
        completed_at_ms,
        result_json,
        last_error_code,
        created_at_ms,
        updated_at_ms,
        version,
        lease_token,
        next_attempt_at_ms
      ) VALUES (
        @jobRunId,
        @leagueId,
        @targetSeasonId,
        @jobType,
        @occurrenceKey,
        @scheduledStartsAtMs,
        'pending',
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        @nowMs,
        @nowMs,
        1,
        NULL,
        @scheduledStartsAtMs
      )
    `);
    initialDraftStatement = database.prepare(`
      UPDATE entry_drafts
      SET status = 'ready',
          starts_at_ms = @scheduledStartsAtMs,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @entryDraftId
        AND status = @expectedStatus
        AND status IN ('setup', 'lottery_ready')
        AND starts_at_ms IS NULL
        AND version = @expectedVersion
    `);
    rescheduleDraftStatement =
      database.prepare(`
        UPDATE entry_drafts
        SET starts_at_ms = @scheduledStartsAtMs,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @entryDraftId
          AND status = 'ready'
          AND starts_at_ms =
            @priorScheduledStartsAtMs
          AND version = @expectedVersion
      `);
    skipJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'skipped',
          next_attempt_at_ms = NULL,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @priorJobRunId
        AND season_id = @targetSeasonId
        AND job_type = @jobType
        AND occurrence_key =
          @priorOccurrenceKey
        AND scheduled_for_ms =
          @priorScheduledStartsAtMs
        AND scheduled_for_ms > @nowMs
        AND status = 'pending'
        AND attempt_count = 0
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at_ms IS NULL
        AND started_at_ms IS NULL
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND version = @priorJobVersion
    `);
    supersedeOccurrenceStatement =
      database.prepare(`
        UPDATE season_rollover_occurrences
        SET status = 'superseded',
            superseded_by_occurrence_id =
              @rolloverOccurrenceId,
            terminal_at_ms = @nowMs,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @priorOccurrenceId
          AND binding_id = @rolloverBindingId
          AND entry_draft_id = @entryDraftId
          AND scheduled_job_run_id =
            @priorJobRunId
          AND status = 'scheduled'
          AND superseded_by_occurrence_id IS NULL
          AND successful_rollover_id IS NULL
          AND terminal_at_ms IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM season_rollover_attempts
              AS attempt
            WHERE attempt.league_id =
                @leagueId
              AND attempt.rollover_occurrence_id =
                @priorOccurrenceId
          )
      `);
    insertBindingStatement = database.prepare(`
      INSERT INTO entry_draft_rollover_bindings (
        id,
        league_id,
        entry_draft_id,
        from_season_id,
        to_season_id,
        current_rollover_occurrence_id,
        current_scheduled_job_run_id,
        current_schedule_operation_id,
        target_schedule_id,
        target_schedule_version,
        week_one_matchup_week_id,
        week_one_starts_at_ms,
        scheduled_starts_at_ms,
        current_occurrence_key,
        status,
        successful_rollover_id,
        selection_gate_status,
        trading_gate_status,
        scheduled_by_user_id,
        scheduled_by_membership_id,
        scheduled_by_authority,
        source_season_version_at_schedule,
        target_season_version_at_schedule,
        entry_draft_version_at_schedule,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        @rolloverBindingId,
        @leagueId,
        @entryDraftId,
        @sourceSeasonId,
        @targetSeasonId,
        @rolloverOccurrenceId,
        @jobRunId,
        @operationId,
        @targetScheduleId,
        @targetScheduleVersion,
        @weekOneMatchupWeekId,
        @weekOneStartsAtMs,
        @scheduledStartsAtMs,
        @occurrenceKey,
        'scheduled',
        NULL,
        'locked',
        'locked',
        @actorUserId,
        @membershipId,
        @authority,
        @sourceSeasonVersion,
        @targetSeasonVersion,
        @entryDraftVersionAfter,
        @nowMs,
        @nowMs,
        1
      )
    `);
    updateBindingStatement = database.prepare(`
      UPDATE entry_draft_rollover_bindings
      SET current_rollover_occurrence_id =
            @rolloverOccurrenceId,
          current_scheduled_job_run_id =
            @jobRunId,
          current_schedule_operation_id =
            @operationId,
          target_schedule_id =
            @targetScheduleId,
          target_schedule_version =
            @targetScheduleVersion,
          week_one_matchup_week_id =
            @weekOneMatchupWeekId,
          week_one_starts_at_ms =
            @weekOneStartsAtMs,
          scheduled_starts_at_ms =
            @scheduledStartsAtMs,
          current_occurrence_key =
            @occurrenceKey,
          scheduled_by_user_id =
            @actorUserId,
          scheduled_by_membership_id =
            @membershipId,
          scheduled_by_authority =
            @authority,
          source_season_version_at_schedule =
            @sourceSeasonVersion,
          target_season_version_at_schedule =
            @targetSeasonVersion,
          entry_draft_version_at_schedule =
            @entryDraftVersionAfter,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @rolloverBindingId
        AND entry_draft_id = @entryDraftId
        AND current_rollover_occurrence_id =
          @priorOccurrenceId
        AND current_scheduled_job_run_id =
          @priorJobRunId
        AND scheduled_starts_at_ms =
          @priorScheduledStartsAtMs
        AND status = 'scheduled'
        AND successful_rollover_id IS NULL
        AND selection_gate_status = 'locked'
        AND trading_gate_status = 'locked'
        AND version = @priorBindingVersion
    `);
    insertOccurrenceStatement =
      database.prepare(`
        INSERT INTO season_rollover_occurrences (
          id,
          league_id,
          binding_id,
          entry_draft_id,
          from_season_id,
          to_season_id,
          target_schedule_id,
          target_schedule_version,
          week_one_matchup_week_id,
          week_one_starts_at_ms,
          scheduled_starts_at_ms,
          occurrence_key,
          scheduled_by_user_id,
          scheduled_by_membership_id,
          scheduled_by_authority,
          status,
          superseded_by_occurrence_id,
          scheduled_job_run_id,
          schedule_operation_id,
          successful_rollover_id,
          source_season_version_at_schedule,
          target_season_version_at_schedule,
          entry_draft_version_at_schedule,
          terminal_at_ms,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @rolloverOccurrenceId,
          @leagueId,
          @rolloverBindingId,
          @entryDraftId,
          @sourceSeasonId,
          @targetSeasonId,
          @targetScheduleId,
          @targetScheduleVersion,
          @weekOneMatchupWeekId,
          @weekOneStartsAtMs,
          @scheduledStartsAtMs,
          @occurrenceKey,
          @actorUserId,
          @membershipId,
          @authority,
          'scheduled',
          NULL,
          @jobRunId,
          @operationId,
          NULL,
          @sourceSeasonVersion,
          @targetSeasonVersion,
          @entryDraftVersionAfter,
          NULL,
          @nowMs,
          @nowMs,
          1
        )
      `);
    insertOperationStatement =
      database.prepare(`
        INSERT INTO entry_draft_schedule_operations (
          id,
          league_id,
          entry_draft_id,
          action,
          idempotency_request_id,
          rollover_binding_id,
          rollover_occurrence_id,
          scheduled_job_run_id,
          superseded_rollover_occurrence_id,
          superseded_job_run_id,
          scheduled_starts_at_ms,
          entry_draft_version_before,
          entry_draft_version_after,
          rollover_binding_version_before,
          rollover_binding_version_after,
          scheduled_job_version,
          superseded_job_version_before,
          superseded_job_version_after,
          scheduled_by_user_id,
          scheduled_by_membership_id,
          scheduled_by_authority,
          reason,
          result_schema_version,
          created_at_ms,
          version
        ) VALUES (
          @operationId,
          @leagueId,
          @entryDraftId,
          @action,
          @operationId,
          @rolloverBindingId,
          @rolloverOccurrenceId,
          @jobRunId,
          @priorOccurrenceId,
          @priorJobRunId,
          @scheduledStartsAtMs,
          @entryDraftVersionBefore,
          @entryDraftVersionAfter,
          @bindingVersionBefore,
          @bindingVersionAfter,
          1,
          @priorJobVersion,
          @priorJobVersionAfter,
          @actorUserId,
          @membershipId,
          @authority,
          @reason,
          1,
          @nowMs,
          1
        )
      `);
    insertDraftEventStatement =
      database.prepare(`
        INSERT INTO draft_events (
          id,
          league_id,
          draft_id,
          actor_user_id,
          event_type,
          metadata_json,
          occurred_at_ms
        ) VALUES (
          @draftEventId,
          @leagueId,
          @entryDraftId,
          @actorUserId,
          @eventType,
          @metadataJson,
          @nowMs
        )
      `);
    completeIdempotencyStatement =
      database.prepare(`
        UPDATE idempotency_requests
        SET status = 'completed',
            result_type = @resultType,
            result_id = @operationId,
            completed_at_ms = @nowMs
        WHERE league_id = @leagueId
          AND id = @operationId
          AND actor_user_id = @actorUserId
          AND operation = @operation
          AND client_key = @clientKey
          AND request_hash = @requestHash
          AND status = 'started'
          AND result_type IS NULL
          AND result_id IS NULL
          AND completed_at_ms IS NULL
      `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareEntryDraftScheduleRepository",
      tableName:
        "entry_draft_schedule_operations",
    });
  }

  function readScheduleContextInternal({
    leagueId,
    entryDraftId,
  }) {
    const draft = uniqueRow(
      draftContextStatement,
      { leagueId, entryDraftId },
      "The Entry Draft schedule context"
    );
    if (!draft) return null;
    const source = draft.current_season_id
      ? uniqueRow(
          sourceSeasonStatement,
          {
            leagueId,
            sourceSeasonId:
              draft.current_season_id,
          },
          "The source-season schedule evidence"
        )
      : null;
    const targetSchedule = uniqueRow(
      targetScheduleStatement,
      {
        leagueId,
        targetSeasonId: draft.season_id,
      },
      "The target schedule generation"
    );
    const lottery = uniqueRow(
      lotteryReadinessStatement,
      { leagueId, entryDraftId },
      "The Entry Draft lottery readiness"
    );
    const eligibility = uniqueRow(
      eligibilityReadinessStatement,
      { leagueId, entryDraftId },
      "The Entry Draft eligibility readiness"
    );
    const participantCount =
      lottery?.participant_count || 0;
    const picks = pickReadinessStatement.get({
      leagueId,
      entryDraftId,
      targetSeasonId: draft.season_id,
      participantCount,
      lotteryRunId: lottery?.id || "",
    });
    const binding = uniqueRow(
      bindingStatement,
      { leagueId, entryDraftId },
      "The Entry Draft rollover binding"
    );
    const recipients = recipientsStatement
      .all({ leagueId })
      .map(({ user_id: userId }) => userId);

    const sourceSeason = source
      ? Object.freeze({
          id: source.id,
          leagueId: source.league_id,
          version: source.version,
          status: source.status,
          isCurrent:
            source.id ===
            draft.current_season_id,
          nhlRegularSeasonEndsAtMs:
            source.regular_season_ends_at_ms,
          completionEvidence:
            source.finalization_id === null
              ? null
              : Object.freeze({
                  competitionCompletedAtMs:
                    source
                      .regular_season_ends_at_ms,
                  expectedMatchupCount:
                    source
                      .expected_matchup_count,
                  finalizationId:
                    source.finalization_id,
                  finalizedAtMs:
                    source.finalized_at_ms,
                  includedResultCount:
                    source
                      .finalized_matchup_count,
                  participantCount:
                    source.participant_count,
                  resultSetHash:
                    source.result_set_hash,
                  seasonVersion:
                    source
                      .finalization_season_version,
                  standingsRuleVersion:
                    source
                      .standings_rule_version,
                  standingsSnapshotId:
                    source
                      .standings_snapshot_id,
                  standingsSnapshotVersion:
                    source
                      .standings_snapshot_version,
                }),
        })
      : null;
    const mappedTargetSchedule =
      targetSchedule
        ? Object.freeze({
            id: targetSchedule
              .schedule_operation_id,
            leagueId,
            seasonId: draft.season_id,
            version:
              targetSchedule.schedule_version,
            status: "selected",
            complete: true,
            weekOneMatchupWeekId:
              targetSchedule
                .week_one_matchup_week_id,
            weekOneStartsAtMs:
              targetSchedule
                .week_one_starts_at_ms,
          })
        : null;
    const scheduledBinding = binding
      ? Object.freeze({
          id: binding.id,
          version: binding.version,
          leagueId: binding.league_id,
          entryDraftId:
            binding.entry_draft_id,
          entryDraftVersion:
            binding
              .entry_draft_version_at_schedule,
          sourceSeasonId:
            binding.from_season_id,
          sourceSeasonVersion:
            binding
              .source_season_version_at_schedule,
          targetSeasonId:
            binding.to_season_id,
          targetSeasonVersion:
            binding
              .target_season_version_at_schedule,
          targetScheduleId:
            binding.target_schedule_id,
          targetScheduleVersion:
            binding.target_schedule_version,
          weekOneMatchupWeekId:
            binding.week_one_matchup_week_id,
          weekOneStartsAtMs:
            binding.week_one_starts_at_ms,
          status:
            binding.occurrence_status ===
            binding.status
              ? binding.status
              : "invalid",
          selectionGateStatus:
            binding.selection_gate_status,
          tradingGateStatus:
            binding.trading_gate_status,
          occurrenceId:
            binding.occurrence_id,
          occurrenceKey:
            binding.occurrence_key,
          scheduledStartsAtMs:
            binding.scheduled_starts_at_ms,
          rolloverAttemptCount:
            binding.rollover_attempt_count,
          rolloverId:
            binding.successful_rollover_id,
          job: Object.freeze({
            id: binding.job_id,
            version: binding.job_version,
            jobType: binding.job_type,
            status:
              binding.job_status === "pending" &&
              (
                binding.job_attempt_count !== 0 ||
                binding.job_result_json !== null ||
                binding.job_last_error_code !==
                  null ||
                binding
                  .job_next_attempt_at_ms !==
                  binding.scheduled_for_ms
              )
                ? "invalid"
                : binding.job_status,
            occurrenceKey:
              binding.job_occurrence_key,
            scheduledForMs:
              binding.scheduled_for_ms,
            startedAtMs:
              binding.started_at_ms,
            leaseOwner: binding.lease_owner,
            leaseToken: binding.lease_token,
            leaseExpiresAtMs:
              binding.lease_expires_at_ms,
            completedAtMs:
              binding.completed_at_ms,
          }),
        })
      : null;
    const orderConfirmed = Boolean(
      lottery &&
        participantCount >= 2 &&
        lottery.result_count ===
          participantCount &&
        lottery.minimum_position === 1 &&
        lottery.maximum_position ===
          participantCount &&
        lottery.current_team_count ===
          participantCount &&
        lottery.current_result_team_count ===
          participantCount
    );
    const pickOwnersConfirmed = Boolean(
      orderConfirmed &&
        picks &&
        picks.pick_count ===
          participantCount * draft.rounds &&
        picks.invalid_pick_count === 0
    );
    return Object.freeze({
      leagueId,
      leagueVersion: draft.league_version,
      entryDraftId,
      entryDraftVersion: draft.version,
      entryDraftStatus: draft.status,
      sourceSeason,
      targetSeason: Object.freeze({
        id: draft.season_id,
        leagueId,
        version: draft.target_version,
        status: draft.target_status,
        leagueTimezone:
          draft.league_timezone,
        calendar: Object.freeze({
          nhlRegularSeasonStartsAtMs:
            draft
              .target_regular_season_starts_at_ms,
          firstWeekStartsAtMs:
            targetSchedule
              ?.week_one_starts_at_ms ??
            null,
          fantasyPlayoffsStartAtMs:
            draft
              .target_fantasy_playoffs_start_at_ms,
          fantasyPlayoffsEndAtMs:
            draft
              .target_fantasy_playoffs_end_at_ms,
          nhlRegularSeasonEndsAtMs:
            draft
              .target_regular_season_ends_at_ms,
        }),
      }),
      targetSchedule: mappedTargetSchedule,
      readiness: Object.freeze({
        setupConfirmed:
          draft.rounds === 4 &&
          draft.pick_clock_seconds === 300,
        orderConfirmed,
        eligibilityConfirmed: Boolean(
          eligibility &&
            eligibility.player_count >= 1
        ),
        pickOwnersConfirmed,
      }),
      scheduledBinding,
      notificationRecipientUserIds:
        Object.freeze(recipients),
    });
  }

  function assertPlanContext(plan) {
    const context =
      readScheduleContextInternal({
        leagueId: plan.leagueId,
        entryDraftId: plan.entryDraft.id,
      });
    if (!context) {
      conflict(
        "The Entry Draft schedule context no longer exists."
      );
    }
    if (
      context.entryDraftVersion !==
        plan.entryDraft.expectedVersion ||
      context.entryDraftStatus !==
        plan.entryDraft.status
    ) {
      conflict(
        "The Entry Draft schedule version changed."
      );
    }
    if (
      !isDeepStrictEqual(
        context.sourceSeason,
        plan.serverBinding.sourceSeason
      ) ||
      !isDeepStrictEqual(
        context.targetSeason,
        plan.serverBinding.targetSeason
      ) ||
      !isDeepStrictEqual(
        context.targetSchedule,
        plan.serverBinding.targetSchedule
      ) ||
      !Object.values(context.readiness).every(
        (value) => value === true
      )
    ) {
      conflict(
        "The server-owned Entry Draft schedule evidence changed."
      );
    }
    if (
      plan.action ===
      ENTRY_DRAFT_SCHEDULE_ACTION
        ? context.scheduledBinding !== null
        : !isDeepStrictEqual(
            context.scheduledBinding,
            plan.replacement
          )
    ) {
      conflict(
        "The Entry Draft rollover binding changed."
      );
    }
    const recipientUserIds =
      plan.ids.notificationIds.map(
        ({ userId }) => userId
      );
    if (
      !isDeepStrictEqual(
        context.notificationRecipientUserIds,
        recipientUserIds
      )
    ) {
      conflict(
        "The Entry Draft schedule notification audience changed."
      );
    }
    if (
      !uniqueRow(
        activeMembershipStatement,
        {
          leagueId: plan.leagueId,
          membershipId:
            plan.actor.membershipId,
          actorUserId:
            plan.actor.actorUserId,
          authority: plan.actor.authority,
        },
        "The Entry Draft scheduling authority"
      )
    ) {
      conflict(
        "The Entry Draft scheduling authority changed."
      );
    }
    return context;
  }

  function writeEvidence(plan, parameters, leagueVersion) {
    const eventType =
      plan.action ===
      ENTRY_DRAFT_SCHEDULE_ACTION
        ? SCHEDULE_EVENT
        : RESCHEDULE_EVENT;
    const metadataJson = JSON.stringify({
      action: plan.action,
      actorAuthority: plan.actor.authority,
      entryDraftVersionAfter:
        plan.result.entryDraftVersion,
      entryDraftVersionBefore:
        plan.entryDraft.expectedVersion,
      jobRunId: plan.ids.jobRunId,
      operationId:
        plan.idempotency.operationId,
      rolloverBindingId:
        plan.ids.rolloverBindingId,
      rolloverBindingVersion:
        plan.result.rolloverBindingVersion,
      rolloverOccurrenceId:
        plan.ids.rolloverOccurrenceId,
      scheduledStartsAtMs:
        plan.result.scheduledStartsAtMs,
      sourceSeasonId:
        plan.serverBinding.sourceSeason.id,
      sourceSeasonVersion:
        plan.serverBinding.sourceSeason
          .version,
      targetScheduleId:
        plan.serverBinding.targetSchedule.id,
      targetScheduleVersion:
        plan.serverBinding.targetSchedule
          .version,
      targetSeasonId:
        plan.serverBinding.targetSeason.id,
      targetSeasonVersion:
        plan.serverBinding.targetSeason
          .version,
      weekOneMatchupWeekId:
        plan.serverBinding.targetSchedule
          .weekOneMatchupWeekId,
      weekOneStartsAtMs:
        plan.serverBinding.targetSchedule
          .weekOneStartsAtMs,
    });
    insertDraftEventStatement.run({
      ...parameters,
      draftEventId:
        plan.ids.draftEventId,
      eventType,
      metadataJson,
    });
    const audit = plan.auditContext || {};
    audits.append({
      id: plan.ids.auditEventId,
      event_type:
        plan.action ===
        ENTRY_DRAFT_SCHEDULE_ACTION
          ? SCHEDULE_AUDIT_EVENT
          : RESCHEDULE_AUDIT_EVENT,
      outcome: "success",
      actor_user_id:
        plan.actor.actorUserId,
      target_user_id: null,
      league_id: plan.leagueId,
      session_id: null,
      request_correlation_id:
        audit.requestCorrelationId || null,
      reason_code:
        plan.action ===
        ENTRY_DRAFT_RESCHEDULE_ACTION
          ? "commissioner_reschedule"
          : null,
      network_key_version:
        audit.networkKeyVersion ?? null,
      network_metadata_digest:
        audit.networkMetadataDigest ?? null,
      client_metadata_json:
        auditClientMetadata(
          audit.clientMetadataJson,
          plan.actor.authority
        ),
      unknown_account_digest: null,
      occurred_at_ms: plan.nowMs,
    });
    const messageDataJson = JSON.stringify({
      action: plan.action,
      entryDraftId: plan.entryDraft.id,
      scheduledStartsAtMs:
        plan.result.scheduledStartsAtMs,
      weekOneMatchupWeekId:
        plan.serverBinding.targetSchedule
          .weekOneMatchupWeekId,
      weekOneStartsAtMs:
        plan.serverBinding.targetSchedule
          .weekOneStartsAtMs,
    });
    for (const notification of
      plan.ids.notificationIds) {
      const written = notifications.insert({
        id: notification.id,
        userId: notification.userId,
        leagueId: plan.leagueId,
        eventType,
        messageDataJson,
        relatedFeature: "entry_draft",
        relatedRecordId: plan.entryDraft.id,
        deliveryStatus: "pending",
        createdAtMs: plan.nowMs,
        deliveredAtMs: null,
        deduplicationKey:
          `entry-draft-schedule:` +
          plan.idempotency.operationId,
      });
      if (written.replayed) {
        conflict(
          "The Entry Draft schedule notification evidence already exists."
        );
      }
    }
    outbox.write({
      id: plan.ids.outboxEventId,
      leagueId: plan.leagueId,
      eventType: "league.changed",
      aggregateType: "league",
      aggregateId: plan.leagueId,
      payload: createSocketEventMetadata({
        eventType: "league.changed",
        version: leagueVersion,
        reasonCode: "league_changed",
        occurredAtMs: plan.nowMs,
        related: createEmptySocketRelated(),
      }),
      occurredAtMs: plan.nowMs,
      audiences: [{ kind: "league" }],
    });
  }

  const applyTransaction = database.transaction(
    (rawPlan) => {
      const plan = normalizePlan(rawPlan);
      const currentContext = assertPlanContext(plan);
      const source =
        plan.serverBinding.sourceSeason;
      const target =
        plan.serverBinding.targetSeason;
      const schedule =
        plan.serverBinding.targetSchedule;
      const replacement = plan.replacement;
      const parameters = {
        action: plan.action,
        actorUserId:
          plan.actor.actorUserId,
        authority: plan.actor.authority,
        bindingVersionAfter:
          plan.result.rolloverBindingVersion,
        bindingVersionBefore:
          replacement?.version || 0,
        clientKey:
          plan.idempotency.clientKey,
        entryDraftId: plan.entryDraft.id,
        entryDraftVersionAfter:
          plan.result.entryDraftVersion,
        entryDraftVersionBefore:
          plan.entryDraft.expectedVersion,
        expiresAtMs:
          plan.idempotency.expiresAtMs,
        expectedStatus:
          plan.entryDraft.status,
        expectedVersion:
          plan.entryDraft.expectedVersion,
        jobRunId: plan.ids.jobRunId,
        jobType: plan.job.jobType,
        leagueId: plan.leagueId,
        membershipId:
          plan.actor.membershipId,
        nowMs: plan.nowMs,
        occurrenceKey:
          plan.job.occurrenceKey,
        operation:
          plan.idempotency.operation,
        operationId:
          plan.idempotency.operationId,
        priorBindingVersion:
          replacement?.version ?? null,
        priorJobRunId:
          replacement?.job.id ?? null,
        priorJobVersion:
          replacement?.job.version ?? null,
        priorJobVersionAfter:
          replacement
            ? replacement.job.version + 1
            : null,
        priorOccurrenceId:
          replacement?.occurrenceId ?? null,
        priorOccurrenceKey:
          replacement?.occurrenceKey ?? null,
        priorScheduledStartsAtMs:
          replacement?.scheduledStartsAtMs ??
          null,
        reason: plan.reason,
        requestHash:
          plan.idempotency.requestHash,
        resultType:
          plan.idempotency.resultType,
        rolloverBindingId:
          plan.ids.rolloverBindingId,
        rolloverOccurrenceId:
          plan.ids.rolloverOccurrenceId,
        scheduledStartsAtMs:
          plan.result.scheduledStartsAtMs,
        sourceSeasonId: source.id,
        sourceSeasonVersion:
          source.version,
        targetScheduleId: schedule.id,
        targetScheduleVersion:
          schedule.version,
        targetSeasonId: target.id,
        targetSeasonVersion:
          target.version,
        weekOneMatchupWeekId:
          schedule.weekOneMatchupWeekId,
        weekOneStartsAtMs:
          schedule.weekOneStartsAtMs,
      };
      insertIdempotencyStatement.run(parameters);
      if (
        plan.action ===
        ENTRY_DRAFT_RESCHEDULE_ACTION
      ) {
        runExactly(
          skipJobStatement,
          parameters,
          "The prior Entry Draft rollover job changed."
        );
        runExactly(
          rescheduleDraftStatement,
          parameters,
          "The Entry Draft schedule version changed."
        );
      } else {
        runExactly(
          initialDraftStatement,
          parameters,
          "The Entry Draft setup version changed."
        );
      }
      insertJobStatement.run(parameters);
      if (
        plan.action ===
        ENTRY_DRAFT_RESCHEDULE_ACTION
      ) {
        runExactly(
          supersedeOccurrenceStatement,
          parameters,
          "The prior Entry Draft rollover occurrence changed."
        );
        runExactly(
          updateBindingStatement,
          parameters,
          "The Entry Draft rollover binding changed."
        );
      } else {
        insertBindingStatement.run(parameters);
      }
      insertOccurrenceStatement.run(parameters);
      insertOperationStatement.run(parameters);
      writeEvidence(
        plan,
        parameters,
        currentContext.leagueVersion
      );
      runExactly(
        completeIdempotencyStatement,
        parameters,
        "The Entry Draft schedule idempotency result changed."
      );
      if (beforeCommit) beforeCommit(plan.action);
      const durable = scheduleResult(
        uniqueRow(
          scheduleResultStatement,
          {
            leagueId: plan.leagueId,
            operationId:
              plan.idempotency.operationId,
          },
          "The durable Entry Draft schedule result"
        )
      );
      if (
        !durable ||
        !isDeepStrictEqual(
          durable,
          plan.result
        )
      ) {
        incompatible(
          "The durable Entry Draft schedule result is inconsistent."
        );
      }
      return Object.freeze({ applied: true });
    }
  );

  return Object.freeze({
    findIdempotency(options) {
      const canonical = normalizeLookup(
        options,
        [
          "leagueId",
          "actorUserId",
          "operation",
          "clientKey",
        ],
        "An exact Entry Draft schedule idempotency lookup is required."
      );
      if (
        canonical.operation !==
        ENTRY_DRAFT_SCHEDULE_OPERATION
      ) {
        invalid(
          "The Entry Draft schedule idempotency operation is required."
        );
      }
      try {
        return idempotencyResult(
          uniqueRow(
            idempotencyByScopeStatement,
            canonical,
            "The Entry Draft schedule idempotency scope"
          )
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "findEntryDraftScheduleIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },

    findScheduleResult(options) {
      const canonical = normalizeLookup(
        options,
        ["leagueId", "operationId"],
        "An exact Entry Draft schedule result lookup is required."
      );
      try {
        return scheduleResult(
          uniqueRow(
            scheduleResultStatement,
            canonical,
            "The durable Entry Draft schedule result"
          )
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "findEntryDraftScheduleResult",
          tableName:
            "entry_draft_schedule_operations",
        });
      }
    },

    readScheduleContext(options) {
      const canonical = normalizeLookup(
        options,
        ["leagueId", "entryDraftId"],
        "An exact Entry Draft schedule context lookup is required."
      );
      try {
        return readScheduleContextInternal(
          canonical
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "readEntryDraftScheduleContext",
          tableName: "entry_drafts",
        });
      }
    },

    applySchedulePlan(plan) {
      try {
        return applyTransaction.immediate(plan);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "applyEntryDraftSchedulePlan",
          tableName:
            "entry_draft_schedule_operations",
        });
      }
    },
  });
}

module.exports = {
  createSqliteEntryDraftScheduleRepository,
};
