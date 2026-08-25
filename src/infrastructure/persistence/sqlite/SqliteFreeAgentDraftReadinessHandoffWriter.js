const {
  isDeepStrictEqual,
} = require("node:util");

const {
  createFreeAgentDraftReadinessTriggerPlan,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const RESET_MANIFEST_ID = "2026-season-1-reset-v1";
const RESET_BOOTSTRAP_OPERATION =
  "admin.league.bootstrap_reset_original.v1";
const RESET_BOOTSTRAP_AUDIT_EVENT =
  "system_bootstrap.reset_original_league_created";
const RESET_BOOTSTRAP_REASON =
  "closed_write_reset_handoff";
const RESET_BOOTSTRAP_ACTIVITY_METADATA_JSON =
  '{"leagueStatus":"setup","seasonStatus":"planned"}';

function invalid(message, reasonCode, details = {}) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    {
      details: {
        reasonCode,
        ...details,
      },
    }
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

function incompatible(message, reasonCode, details = {}) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    {
      details: {
        reasonCode,
        ...details,
      },
    }
  );
}

function assertSynchronous(value) {
  if (
    value &&
    typeof value.then === "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      "FAD readiness handoff hooks must be synchronous."
    );
  }
}

function normalize(input) {
  try {
    return createFreeAgentDraftReadinessTriggerPlan(
      input
    );
  } catch (error) {
    invalid(
      "Canonical FAD readiness trigger and job evidence is required.",
      "READINESS_TRIGGER_PLAN_INVALID",
      {
        policyReasonCode:
          typeof error?.reasonCode === "string"
            ? error.reasonCode
            : null,
      }
    );
  }
}

function oneOrNull(rows, description) {
  if (rows.length > 1) {
    incompatible(
      `${description} is ambiguous.`,
      "READINESS_STORED_STATE_AMBIGUOUS"
    );
  }
  return rows[0] || null;
}

function expectedReadinessRow(readiness) {
  return {
    id: readiness.operationId,
    league_id: readiness.leagueId,
    season_id: readiness.seasonId,
    readiness_occurrence_key:
      readiness.occurrenceKey,
    trigger_kind: readiness.triggerKind,
    entry_draft_id: readiness.entryDraftId,
    setup_exemption_id:
      readiness.setupExemptionId,
    job_run_id: readiness.jobRunId,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    blockers_json: "[]",
    matchup_schedule_version_before: null,
    matchup_schedule_version_after: null,
    schedule_recovery_id: null,
    created_fad_id: null,
    reminder_job_run_id: null,
    deadline_job_run_id: null,
    cards_opened_activity_id: null,
    cards_opened_outbox_event_id: null,
    started_at_ms: null,
    next_retry_at_ms: null,
    terminal_at_ms: null,
    created_at_ms: readiness.createdAtMs,
    updated_at_ms: readiness.createdAtMs,
    version: 1,
  };
}

function expectedJobRow(job) {
  return {
    id: job.id,
    league_id: job.leagueId,
    season_id: job.seasonId,
    job_type: job.jobType,
    occurrence_key: job.occurrenceKey,
    scheduled_for_ms: job.scheduledForMs,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    next_attempt_at_ms: null,
    created_at_ms: job.scheduledForMs,
    updated_at_ms: job.scheduledForMs,
    version: 1,
  };
}

function exactStoredRow(row, expected) {
  if (!row) return false;
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [
      key,
      row[key],
    ])
  );
  return isDeepStrictEqual(actual, expected);
}

function readinessRecord(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    occurrenceKey:
      row.readiness_occurrence_key,
    triggerKind: row.trigger_kind,
    entryDraftId: row.entry_draft_id,
    setupExemptionId: row.setup_exemption_id,
    jobRunId: row.job_run_id,
    status: row.status,
    attemptCount: row.attempt_count,
    blockers: Object.freeze([]),
    matchupScheduleVersionBefore:
      row.matchup_schedule_version_before,
    matchupScheduleVersionAfter:
      row.matchup_schedule_version_after,
    scheduleRecoveryId:
      row.schedule_recovery_id,
    createdFadId: row.created_fad_id,
    reminderJobRunId:
      row.reminder_job_run_id,
    deadlineJobRunId:
      row.deadline_job_run_id,
    cardsOpenedActivityId:
      row.cards_opened_activity_id,
    cardsOpenedOutboxEventId:
      row.cards_opened_outbox_event_id,
    startedAtMs: row.started_at_ms,
    nextRetryAtMs: row.next_retry_at_ms,
    terminalAtMs: row.terminal_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
  });
}

function createSqliteFreeAgentDraftReadinessHandoffWriter({
  database,
  afterStep,
} = {}) {
  if (
    !database ||
    database.open !== true ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftReadinessHandoffWriter requires an opened database"
    );
  }
  if (
    afterStep !== undefined &&
    typeof afterStep !== "function"
  ) {
    throw new TypeError(
      "FAD readiness handoff afterStep must be a function"
    );
  }

  let entryDraftSource;
  let inauguralSource;
  let setupExemptionSource;
  let readinessByOccurrence;
  let readinessBySeason;
  let readinessById;
  let jobByOccurrence;
  let jobById;
  let insertJob;
  let insertReadiness;

  try {
    entryDraftSource = database.prepare(`
      SELECT draft.id
      FROM entry_drafts AS draft
      JOIN seasons AS season
        ON season.league_id = draft.league_id
       AND season.id = draft.season_id
      JOIN leagues AS league
        ON league.id = season.league_id
       AND league.current_season_id = season.id
      WHERE draft.league_id = @leagueId
        AND draft.season_id = @seasonId
        AND draft.id = @triggerResourceId
        AND draft.status = 'completed'
        AND draft.completed_at_ms = @createdAtMs
        AND draft.updated_at_ms = @createdAtMs
        AND season.status = 'active'
        AND league.status IN ('active', 'frozen')
        AND EXISTS (
          SELECT 1
          FROM draft_picks AS terminal_pick
          WHERE terminal_pick.league_id = draft.league_id
            AND terminal_pick.draft_id = draft.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM draft_picks AS invalid_pick
          WHERE invalid_pick.league_id = draft.league_id
            AND invalid_pick.draft_id = draft.id
            AND (
              invalid_pick.target_season_id <> draft.season_id
              OR invalid_pick.status = 'unused'
              OR (
                invalid_pick.status = 'used'
                AND (
                  invalid_pick.selection_id IS NULL
                  OR NOT EXISTS (
                    SELECT 1
                    FROM draft_selections AS selection
                    WHERE selection.league_id = invalid_pick.league_id
                      AND selection.draft_id = invalid_pick.draft_id
                      AND selection.draft_pick_id = invalid_pick.id
                      AND selection.id = invalid_pick.selection_id
                  )
                )
              )
              OR (
                invalid_pick.status = 'forfeited'
                AND invalid_pick.selection_id IS NOT NULL
              )
            )
        )
        AND EXISTS (
          SELECT 1
          FROM draft_picks AS final_pick
          WHERE final_pick.league_id = draft.league_id
            AND final_pick.draft_id = draft.id
            AND final_pick.status IN ('used', 'forfeited')
            AND final_pick.updated_at_ms = @createdAtMs
        )
      LIMIT 2
    `);
    inauguralSource = database.prepare(`
      SELECT
        league.id,
        (
          SELECT COUNT(*)
          FROM seasons AS league_season
          WHERE league_season.league_id = league.id
        ) AS season_count,
        (
          SELECT COUNT(*)
          FROM teams AS league_team
          WHERE league_team.league_id = league.id
            AND league_team.status <> 'erased'
        ) AS non_erased_team_count,
        (
          SELECT COUNT(*)
          FROM teams AS active_team
          WHERE active_team.league_id = league.id
            AND active_team.status = 'active'
            AND active_team.updated_at_ms = @createdAtMs
        ) AS activated_team_count,
        (
          SELECT COUNT(*)
          FROM teams AS active_team
          WHERE active_team.league_id = league.id
            AND active_team.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM team_manager_assignments AS assignment
              JOIN league_memberships AS membership
                ON membership.league_id = assignment.league_id
               AND membership.id = assignment.membership_id
               AND membership.user_id = assignment.user_id
              JOIN users AS manager_user
                ON manager_user.id = assignment.user_id
              WHERE assignment.league_id = active_team.league_id
                AND assignment.team_id = active_team.id
                AND assignment.status = 'accepted'
                AND assignment.accepted_at_ms IS NOT NULL
                AND assignment.ended_at_ms IS NULL
                AND membership.permission_category IN (
                  'manager',
                  'commissioner'
                )
                AND membership.status = 'active'
                AND membership.joined_at_ms IS NOT NULL
                AND membership.ended_at_ms IS NULL
                AND manager_user.status = 'active'
            )
        ) AS unmanaged_team_count,
        (
          SELECT COUNT(*)
          FROM entry_drafts AS target_draft
          WHERE target_draft.league_id = league.id
            AND target_draft.season_id = season.id
        ) AS entry_draft_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_setup_exemptions AS exemption
          WHERE exemption.league_id = league.id
            AND exemption.season_id = season.id
        ) AS setup_exemption_count,
        (
          SELECT COUNT(*)
          FROM migration_reports AS report
          WHERE report.league_id = league.id
            AND report.status = 'succeeded'
            AND report.completed_at_ms IS NOT NULL
            AND report.reset_manifest_id = @resetManifestId
            AND report.database_schema_version >= 1
            AND length(trim(report.source_bundle_id)) > 0
            AND json_valid(report.source_hashes_json) = 1
            AND json_type(report.source_hashes_json) = 'object'
            AND json_valid(report.counts_json) = 1
            AND json_type(report.counts_json) = 'object'
            AND json_valid(report.totals_json) = 1
            AND json_type(report.totals_json) = 'object'
            AND json_valid(report.warnings_json) = 1
            AND json_type(report.warnings_json) = 'array'
            AND json_valid(report.rejects_json) = 1
            AND json_type(report.rejects_json) = 'array'
            AND json_array_length(report.rejects_json) = 0
        ) AS reset_report_count,
        (
          SELECT COUNT(*)
          FROM idempotency_requests AS reset_request
          WHERE reset_request.league_id = league.id
            AND reset_request.operation = @resetBootstrapOperation
            AND reset_request.status = 'completed'
            AND reset_request.result_type = 'league'
            AND reset_request.result_id = league.id
            AND reset_request.created_at_ms = league.created_at_ms
            AND reset_request.completed_at_ms = league.created_at_ms
            AND season.created_at_ms = league.created_at_ms
            AND season.label = '2026'
            AND season.nhl_season_key = '20262027'
            AND EXISTS (
              SELECT 1
              FROM league_activity AS bootstrap_activity
              WHERE bootstrap_activity.league_id = league.id
                AND bootstrap_activity.season_id = season.id
                AND bootstrap_activity.event_type = 'league_created'
                AND bootstrap_activity.actor_user_id =
                    reset_request.actor_user_id
                AND bootstrap_activity.actor_authority =
                    'platform_administrator'
                AND bootstrap_activity.team_id IS NULL
                AND bootstrap_activity.player_id IS NULL
                AND bootstrap_activity.related_type = 'league'
                AND bootstrap_activity.related_id = league.id
                AND bootstrap_activity.reason IS NULL
                AND bootstrap_activity.metadata_json =
                    @resetBootstrapActivityMetadataJson
                AND bootstrap_activity.occurred_at_ms =
                    league.created_at_ms
            )
            AND EXISTS (
              SELECT 1
              FROM security_audit_events AS bootstrap_audit
              WHERE bootstrap_audit.league_id = league.id
                AND bootstrap_audit.event_type =
                    @resetBootstrapAuditEvent
                AND bootstrap_audit.outcome = 'success'
                AND bootstrap_audit.actor_user_id =
                    reset_request.actor_user_id
                AND bootstrap_audit.target_user_id IS NULL
                AND bootstrap_audit.session_id IS NULL
                AND bootstrap_audit.reason_code =
                    @resetBootstrapReason
                AND bootstrap_audit.occurred_at_ms =
                    league.created_at_ms
            )
        ) AS reset_bootstrap_count
      FROM leagues AS league
      JOIN seasons AS season
        ON season.league_id = league.id
       AND season.id = @seasonId
      WHERE league.id = @leagueId
        AND league.current_season_id = season.id
        AND league.status = 'active'
        AND league.updated_at_ms = @createdAtMs
        AND season.status = 'active'
        AND season.updated_at_ms = @createdAtMs
      LIMIT 2
    `);
    setupExemptionSource = database.prepare(`
      SELECT exemption.id
      FROM free_agent_draft_setup_exemptions AS exemption
      JOIN seasons AS season
        ON season.league_id = exemption.league_id
       AND season.id = exemption.season_id
      JOIN leagues AS league
        ON league.id = season.league_id
       AND league.current_season_id = season.id
      JOIN idempotency_requests AS lifecycle_request
        ON lifecycle_request.league_id = exemption.league_id
       AND lifecycle_request.id = exemption.idempotency_request_id
       AND lifecycle_request.actor_user_id =
           exemption.authorized_by_user_id
      WHERE exemption.league_id = @leagueId
        AND exemption.season_id = @seasonId
        AND exemption.id = @triggerResourceId
        AND exemption.exemption_kind =
            'initial_season2_transition'
        AND exemption.consumed_fad_id IS NULL
        AND exemption.consumed_at_ms IS NULL
        AND exemption.authorized_at_ms = @createdAtMs
        AND exemption.created_at_ms = @createdAtMs
        AND exemption.updated_at_ms = @createdAtMs
        AND exemption.version = 1
        AND lifecycle_request.operation =
            'league.lifecycle.transition.v2'
        AND lifecycle_request.status = 'started'
        AND lifecycle_request.result_type IS NULL
        AND lifecycle_request.result_id IS NULL
        AND lifecycle_request.completed_at_ms IS NULL
        AND lifecycle_request.created_at_ms = @createdAtMs
        AND season.status = 'active'
        AND league.status IN ('active', 'frozen')
      LIMIT 2
    `);
    readinessByOccurrence = database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_operations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND readiness_occurrence_key = @occurrenceKey
      LIMIT 2
    `);
    readinessBySeason = database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_operations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      LIMIT 2
    `);
    readinessById = database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_operations
      WHERE id = @operationId
      LIMIT 2
    `);
    jobByOccurrence = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND job_type = @jobType
        AND occurrence_key = @occurrenceKey
      LIMIT 2
    `);
    jobById = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE id = @jobRunId
      LIMIT 2
    `);
    insertJob = database.prepare(`
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
        @id,
        @leagueId,
        @seasonId,
        @jobType,
        @occurrenceKey,
        @scheduledForMs,
        'pending',
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        @scheduledForMs,
        @scheduledForMs,
        1,
        NULL,
        NULL
      )
    `);
    insertReadiness = database.prepare(`
      INSERT INTO free_agent_draft_readiness_operations (
        id,
        league_id,
        season_id,
        readiness_occurrence_key,
        trigger_kind,
        entry_draft_id,
        setup_exemption_id,
        job_run_id,
        status,
        attempt_count,
        lease_owner,
        lease_token,
        lease_expires_at_ms,
        blockers_json,
        matchup_schedule_version_before,
        matchup_schedule_version_after,
        schedule_recovery_id,
        created_fad_id,
        reminder_job_run_id,
        deadline_job_run_id,
        cards_opened_activity_id,
        cards_opened_outbox_event_id,
        started_at_ms,
        next_retry_at_ms,
        terminal_at_ms,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        @operationId,
        @leagueId,
        @seasonId,
        @occurrenceKey,
        @triggerKind,
        @entryDraftId,
        @setupExemptionId,
        @jobRunId,
        'pending',
        0,
        NULL,
        NULL,
        NULL,
        '[]',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        @createdAtMs,
        @createdAtMs,
        1
      )
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftReadinessHandoffWriter",
      tableName:
        "free_agent_draft_readiness_operations",
    });
  }

  function requireTransaction() {
    if (database.inTransaction !== true) {
      invalid(
        "FAD readiness handoff requires an immediate outer transaction.",
        "OUTER_TRANSACTION_REQUIRED"
      );
    }
  }

  function step(name) {
    if (afterStep) {
      assertSynchronous(afterStep(name));
    }
  }

  function sourceParameters(readiness) {
    return {
      leagueId: readiness.leagueId,
      seasonId: readiness.seasonId,
      triggerResourceId:
        readiness.triggerResourceId,
      createdAtMs: readiness.createdAtMs,
      resetManifestId: RESET_MANIFEST_ID,
      resetBootstrapOperation:
        RESET_BOOTSTRAP_OPERATION,
      resetBootstrapAuditEvent:
        RESET_BOOTSTRAP_AUDIT_EVENT,
      resetBootstrapReason:
        RESET_BOOTSTRAP_REASON,
      resetBootstrapActivityMetadataJson:
        RESET_BOOTSTRAP_ACTIVITY_METADATA_JSON,
    };
  }

  function assertAuthoritativeSource(readiness) {
    const parameters = sourceParameters(readiness);
    if (
      readiness.triggerKind ===
      "entry_draft_completed"
    ) {
      const row = oneOrNull(
        entryDraftSource.all(parameters),
        "Completed Entry Draft readiness source"
      );
      if (!row) {
        conflict(
          "The completed Entry Draft readiness source is unavailable.",
          "TRIGGER_SOURCE_INVALID",
          { triggerKind: readiness.triggerKind }
        );
      }
      return;
    }

    if (
      readiness.triggerKind ===
      "no_draft_initial_season2"
    ) {
      const row = oneOrNull(
        setupExemptionSource.all(parameters),
        "Initial Season 2 exemption readiness source"
      );
      if (!row) {
        conflict(
          "The initial Season 2 exemption readiness source is unavailable.",
          "TRIGGER_SOURCE_INVALID",
          { triggerKind: readiness.triggerKind }
        );
      }
      return;
    }

    const row = oneOrNull(
      inauguralSource.all(parameters),
      "Inaugural league-start readiness source"
    );
    if (
      !row ||
      row.season_count !== 1 ||
      row.non_erased_team_count < 4 ||
      row.activated_team_count !==
        row.non_erased_team_count ||
      row.unmanaged_team_count !== 0 ||
      row.entry_draft_count !== 0 ||
      row.setup_exemption_count !== 0 ||
      row.reset_report_count !== 0 ||
      row.reset_bootstrap_count !== 0
    ) {
      conflict(
        "The inaugural league-start readiness source is unavailable.",
        "TRIGGER_SOURCE_INVALID",
        { triggerKind: readiness.triggerKind }
      );
    }
  }

  function lookupParameters(plan) {
    return {
      ...plan.readiness,
      ...plan.job,
      operationId: plan.readiness.operationId,
      jobRunId: plan.job.id,
    };
  }

  function readStoredPair(plan) {
    const parameters = lookupParameters(plan);
    const occurrenceReadiness = oneOrNull(
      readinessByOccurrence.all(parameters),
      "FAD readiness occurrence"
    );
    const seasonReadiness = oneOrNull(
      readinessBySeason.all(parameters),
      "League-season FAD readiness operation"
    );
    const identifiedReadiness = oneOrNull(
      readinessById.all(parameters),
      "Identified FAD readiness operation"
    );
    const occurrenceJob = oneOrNull(
      jobByOccurrence.all(parameters),
      "FAD readiness job occurrence"
    );
    const identifiedJob = oneOrNull(
      jobById.all(parameters),
      "Identified FAD readiness job"
    );
    return {
      occurrenceReadiness,
      seasonReadiness,
      identifiedReadiness,
      occurrenceJob,
      identifiedJob,
    };
  }

  function isExactPair(plan, stored) {
    return Boolean(
      stored.occurrenceReadiness &&
      stored.seasonReadiness?.id ===
        stored.occurrenceReadiness.id &&
      stored.identifiedReadiness?.id ===
        stored.occurrenceReadiness.id &&
      stored.occurrenceJob &&
      stored.identifiedJob?.id ===
        stored.occurrenceJob.id &&
      exactStoredRow(
        stored.occurrenceReadiness,
        expectedReadinessRow(plan.readiness)
      ) &&
      exactStoredRow(
        stored.occurrenceJob,
        expectedJobRow(plan.job)
      )
    );
  }

  function apply(plan) {
    const stored = readStoredPair(plan);
    if (stored.occurrenceReadiness) {
      if (!isExactPair(plan, stored)) {
        incompatible(
          "The stored FAD readiness occurrence differs from the requested handoff.",
          "READINESS_REPLAY_MISMATCH"
        );
      }
      return Object.freeze({
        replayed: true,
        readiness: readinessRecord(
          stored.occurrenceReadiness
        ),
      });
    }
    if (
      stored.identifiedReadiness ||
      stored.occurrenceJob ||
      stored.identifiedJob
    ) {
      incompatible(
        "The FAD readiness handoff is split across noncanonical stored evidence.",
        "READINESS_STORED_PAIR_INVALID"
      );
    }
    if (stored.seasonReadiness) {
      conflict(
        "The league season already has a different FAD readiness occurrence.",
        "READINESS_SEASON_CONFLICT"
      );
    }
    assertAuthoritativeSource(plan.readiness);

    insertJob.run(plan.job);
    step("after_readiness_job_insert");
    insertReadiness.run(plan.readiness);
    step("after_readiness_operation_insert");

    const created = readStoredPair(plan);
    if (!isExactPair(plan, created)) {
      incompatible(
        "The FAD readiness handoff did not persist one canonical operation and job.",
        "READINESS_RECONCILIATION_FAILED"
      );
    }
    return Object.freeze({
      replayed: false,
      readiness: readinessRecord(
        created.occurrenceReadiness
      ),
    });
  }

  function write(input) {
    try {
      requireTransaction();
      return apply(normalize(input));
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "writeFreeAgentDraftReadinessHandoff",
        tableName:
          "free_agent_draft_readiness_operations",
      });
    }
  }

  return Object.freeze({ write });
}

module.exports = {
  createSqliteFreeAgentDraftReadinessHandoffWriter,
};
