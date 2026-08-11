"use strict";

const crypto = require("node:crypto");

const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
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

const WRITER_METHODS = Object.freeze([
  "afterTransition",
  "beforeTransition",
  "listCandidates",
]);
const ROOT_SCAN_FIELDS = Object.freeze([
  "limit",
  "nowMs",
]);
const RAPID_EDGES = new Set([
  "deadline_locked:rapid",
  "allocating:rapid",
]);
const SUPPORTED_EDGES = new Set([
  "deadline_locked:allocating",
  ...RAPID_EDGES,
]);
const INVALID_OFFER_OUTCOMES = new Set([
  "excluded_over_cap",
  "excluded_structural_conflict",
  "invalid",
]);
const APPROVED_PRE_RAPID_STATUSES = new Set([
  "automatic_award",
  "correction_required",
  "invalid",
  "no_valid_offer",
  "restricted_active",
  "restricted_scheduled",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function invalid(message, reasonCode = "INPUT_INVALID") {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    { details: { reasonCode } }
  );
}

function conflict(message, reasonCode = "STATE_CHANGED") {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    { details: { reasonCode } }
  );
}

function incompatible(
  message,
  reasonCode = "PERSISTED_EVIDENCE_INVALID"
) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    { details: { reasonCode } }
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

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function nonnegativeInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    incompatible(
      `Persisted ${description} must be a nonnegative integer.`
    );
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

function boundedText(value, maximumLength, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    incompatible(`Persisted ${description} is invalid.`);
  }
  return value;
}

function edge(fromStatus, toStatus) {
  return `${fromStatus}:${toStatus}`;
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

function assertSynchronous(value, description) {
  if (value && typeof value.then === "function") {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      `${description} must be synchronous.`
    );
  }
  return value;
}

function uniqueRow(rows, description) {
  if (rows.length > 1) {
    incompatible(`${description} is ambiguous.`);
  }
  return rows[0] || null;
}

function parseJson(value, description) {
  try {
    const parsed = JSON.parse(value);
    if (!isPlainObject(parsed)) throw new TypeError();
    return parsed;
  } catch {
    incompatible(`${description} is not valid object JSON.`);
  }
}

function scheduleFromRow(row) {
  if (
    !UUID_PATTERN.test(
      row.schedule_operation_id || ""
    ) ||
    !Number.isSafeInteger(row.schedule_version) ||
    row.schedule_version < 1 ||
    !UUID_PATTERN.test(
      row.week_one_matchup_week_id || ""
    ) ||
    !Number.isSafeInteger(
      row.week_one_starts_at_ms
    ) ||
    row.week_one_starts_at_ms < 0
  ) {
    incompatible(
      "A scanned FAD is missing its exact current schedule binding.",
      "CURRENT_SCHEDULE_INVALID"
    );
  }
  return Object.freeze({
    operationId: row.schedule_operation_id,
    version: row.schedule_version,
    weekOneMatchupWeekId:
      row.week_one_matchup_week_id,
    weekOneStartsAtMs:
      row.week_one_starts_at_ms,
  });
}

function scheduleMatches(row, schedule) {
  return Boolean(
    isPlainObject(schedule) &&
      row.schedule_operation_id ===
        schedule.operationId &&
      row.schedule_version === schedule.version &&
      row.week_one_matchup_week_id ===
        schedule.weekOneMatchupWeekId &&
      row.week_one_starts_at_ms ===
        schedule.weekOneStartsAtMs
  );
}

function normalizeScan(input) {
  exactObject(
    input,
    ROOT_SCAN_FIELDS,
    "FAD allocation lifecycle root scan"
  );
  const limit = positiveInteger(
    input.limit,
    "FAD allocation lifecycle scan limit"
  );
  if (limit > 100) {
    invalid(
      "The FAD allocation lifecycle scan limit cannot exceed 100."
    );
  }
  return Object.freeze({
    limit,
    nowMs: safeTimestamp(
      input.nowMs,
      "FAD allocation lifecycle scan timestamp"
    ),
  });
}

function candidateFromRow(row, nowMs) {
  if (
    !UUID_PATTERN.test(row.league_id || "") ||
    !UUID_PATTERN.test(row.season_id || "") ||
    !UUID_PATTERN.test(row.fad_id || "") ||
    !["deadline_locked", "allocating"].includes(
      row.status
    ) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < 0 ||
    row.updated_at_ms > nowMs ||
    !Number.isSafeInteger(
      row.deadline_locked_at_ms
    ) ||
    row.deadline_locked_at_ms < 0 ||
    row.deadline_locked_at_ms > nowMs
  ) {
    incompatible(
      "A scanned FAD allocation lifecycle root is noncanonical.",
      "ROOT_STATE_INVALID"
    );
  }
  const allocationCount = nonnegativeInteger(
    row.allocation_count,
    "FAD allocation count"
  );
  const pendingAllocationCount = nonnegativeInteger(
    row.pending_allocation_count,
    "FAD pending-allocation count"
  );
  if (pendingAllocationCount > allocationCount) {
    incompatible(
      "A scanned FAD has more pending allocations than allocations.",
      "ALLOCATION_COUNTS_INVALID"
    );
  }
  return Object.freeze({
    leagueId: row.league_id,
    seasonId: row.season_id,
    fadId: row.fad_id,
    status: row.status,
    version: row.version,
    updatedAtMs: row.updated_at_ms,
    deadlineLockedAtMs:
      row.deadline_locked_at_ms,
    allocationCount,
    pendingAllocationCount,
    schedule: scheduleFromRow(row),
  });
}

function validateBarrierSql(sql) {
  if (typeof sql !== "string") {
    incompatible(
      "The locked FAD allocation-completion barrier is missing.",
      "RAPID_BARRIER_MISSING"
    );
  }
  const normalized = sql
    .toLowerCase()
    .replace(/\s+/gu, " ");
  for (const required of [
    "old.status in ('deadline_locked', 'allocating')",
    "new.status = 'rapid'",
    "fad rapid phase requires current evidence for every allocation and offer",
    "fad rapid phase requires an approved accounted allocation state",
    "fad rapid phase requires correction-required allocation recovery",
  ]) {
    if (!normalized.includes(required)) {
      incompatible(
        "The locked FAD allocation-completion barrier is incompatible.",
        "RAPID_BARRIER_INCOMPATIBLE"
      );
    }
  }
}

function requireSupportedTransition(input) {
  if (!isPlainObject(input)) {
    invalid(
      "A FAD allocation lifecycle transition payload is required."
    );
  }
  const fromStatus = input.fromStatus;
  const toStatus = input.toStatus;
  if (!SUPPORTED_EDGES.has(edge(fromStatus, toStatus))) {
    invalid(
      "The FAD allocation lifecycle writer received an unsupported transition."
    );
  }
  canonicalId(input.leagueId, "league identifier");
  canonicalId(input.seasonId, "season identifier");
  canonicalId(input.fadId, "Free Agent Draft identifier");
  positiveInteger(input.expectedVersion, "FAD version");
  safeTimestamp(input.occurredAtMs, "FAD transition timestamp");
  return Object.freeze({
    leagueId: input.leagueId,
    seasonId: input.seasonId,
    fadId: input.fadId,
    expectedVersion: input.expectedVersion,
    fromStatus,
    toStatus,
    occurredAtMs: input.occurredAtMs,
    schedule: input.schedule,
    existing: input.existing,
  });
}

function createSqliteFreeAgentDraftAllocationLifecycleWriter({
  database,
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
      "createSqliteFreeAgentDraftAllocationLifecycleWriter requires an opened database"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "FAD allocation lifecycle beforeCommit must be a function"
    );
  }

  let notifications;
  let outbox;
  let listStatement;
  let evidenceStatement;
  let participantsStatement;
  let outcomesStatement;
  let notificationStatement;
  let outboxStatement;
  let outboxAudienceStatement;
  try {
    notifications = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    const barrier = uniqueRow(
      database
        .prepare(`
          SELECT sql
          FROM sqlite_schema
          WHERE type = 'trigger'
            AND name =
              'free_agent_drafts_allocation_completion_barrier'
          LIMIT 2
        `)
        .all(),
      "The FAD allocation-completion barrier"
    );
    validateBarrierSql(barrier?.sql);
    listStatement = database.prepare(`
      WITH lifecycle_roots AS (
        SELECT
          draft.league_id,
          draft.season_id,
          draft.id AS fad_id,
          draft.status,
          draft.version,
          draft.updated_at_ms,
          draft.deadline_locked_at_ms,
          generation.schedule_operation_id,
          generation.schedule_version,
          generation.week_one_matchup_week_id,
          generation.week_one_starts_at_ms,
          (
            SELECT COUNT(*)
            FROM free_agent_draft_player_allocations
              AS allocation
            WHERE allocation.league_id = draft.league_id
              AND allocation.season_id = draft.season_id
              AND allocation.fad_id = draft.id
          ) AS allocation_count,
          (
            SELECT COUNT(*)
            FROM free_agent_draft_player_allocations
              AS allocation
            WHERE allocation.league_id = draft.league_id
              AND allocation.season_id = draft.season_id
              AND allocation.fad_id = draft.id
              AND allocation.status = 'pending'
          ) AS pending_allocation_count
        FROM free_agent_drafts AS draft
        LEFT JOIN season_matchup_schedule_generations
          AS generation
          ON generation.league_id = draft.league_id
         AND generation.season_id = draft.season_id
         AND generation.status = 'current'
        WHERE draft.status IN (
          'deadline_locked',
          'allocating'
        )
      )
      SELECT *
      FROM lifecycle_roots
      ORDER BY
        CASE
          WHEN status = 'deadline_locked' THEN 0
          WHEN pending_allocation_count = 0 THEN 0
          ELSE 1
        END,
        updated_at_ms,
        league_id,
        season_id,
        fad_id
      LIMIT @limit
    `);
    evidenceStatement = database.prepare(`
      SELECT
        draft.*,
        generation.schedule_operation_id,
        generation.schedule_version,
        generation.week_one_matchup_week_id,
        generation.week_one_starts_at_ms,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_player_allocations AS allocation
          WHERE allocation.league_id = draft.league_id
            AND allocation.season_id = draft.season_id
            AND allocation.fad_id = draft.id
        ) AS allocation_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_player_allocations AS allocation
          WHERE allocation.league_id = draft.league_id
            AND allocation.season_id = draft.season_id
            AND allocation.fad_id = draft.id
            AND allocation.status = 'pending'
        ) AS pending_allocation_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_player_allocations AS allocation
          WHERE allocation.league_id = draft.league_id
            AND allocation.season_id = draft.season_id
            AND allocation.fad_id = draft.id
            AND (
              SELECT COUNT(*)
              FROM job_runs AS job
              WHERE job.league_id = allocation.league_id
                AND job.season_id = allocation.season_id
                AND job.job_type = 'fad_allocation'
                AND job.occurrence_key =
                  'fad:' || allocation.fad_id ||
                  ':allocate:' || allocation.player_id
                AND job.scheduled_for_ms =
                  draft.candidate_deadline_at_ms
            ) <> 1
        ) AS invalid_allocation_job_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_player_allocations AS allocation
          WHERE allocation.league_id = draft.league_id
            AND allocation.season_id = draft.season_id
            AND allocation.fad_id = draft.id
            AND allocation.status NOT IN (
              'automatic_award',
              'restricted_scheduled',
              'restricted_active',
              'no_valid_offer',
              'invalid',
              'correction_required'
            )
        ) AS unapproved_allocation_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_player_allocations AS allocation
          WHERE allocation.league_id = draft.league_id
            AND allocation.season_id = draft.season_id
            AND allocation.fad_id = draft.id
            AND (
              SELECT COUNT(*)
              FROM free_agent_draft_allocation_events AS event
              WHERE event.league_id = allocation.league_id
                AND event.season_id = allocation.season_id
                AND event.fad_id = allocation.fad_id
                AND event.allocation_id = allocation.id
                AND event.player_id = allocation.player_id
                AND event.allocation_version = allocation.version
                AND event.resulting_allocation_status =
                  allocation.status
                AND event.decision_code IS allocation.decision_code
                AND event.contract_id IS allocation.contract_id
                AND event.ownership_id IS allocation.ownership_id
                AND event.occurred_at_ms =
                  allocation.updated_at_ms
                AND event.event_kind IN (
                  'decision_recorded',
                  'restricted_state_changed',
                  'fallback_state_changed',
                  'correction_applied'
                )
            ) <> 1
        ) AS missing_current_event_count,
        (
          SELECT COUNT(*)
          FROM candidate_card_snapshot_entries AS candidate
          JOIN free_agent_draft_player_allocations AS allocation
            ON allocation.league_id = candidate.league_id
           AND allocation.season_id = candidate.season_id
           AND allocation.fad_id = candidate.fad_id
           AND allocation.player_id = candidate.player_id
          WHERE candidate.league_id = draft.league_id
            AND candidate.season_id = draft.season_id
            AND candidate.fad_id = draft.id
            AND candidate.occupant_kind = 'candidate'
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_allocation_events AS event
              WHERE event.league_id = candidate.league_id
                AND event.season_id = candidate.season_id
                AND event.fad_id = candidate.fad_id
                AND event.allocation_id = allocation.id
                AND event.player_id = candidate.player_id
                AND event.allocation_version = allocation.version
                AND event.event_kind = 'offer_considered'
                AND event.snapshot_entry_id = candidate.id
            )
        ) AS missing_offer_event_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_player_allocations AS allocation
          WHERE allocation.league_id = draft.league_id
            AND allocation.season_id = draft.season_id
            AND allocation.fad_id = draft.id
            AND allocation.status = 'correction_required'
            AND NOT EXISTS (
              SELECT 1
              FROM free_agent_draft_recoveries AS recovery
              WHERE recovery.league_id = allocation.league_id
                AND recovery.season_id = allocation.season_id
                AND recovery.fad_id = allocation.fad_id
                AND recovery.allocation_id = allocation.id
                AND recovery.player_id = allocation.player_id
                AND recovery.status IN (
                  'pending',
                  'ready',
                  'running',
                  'correction_required'
                )
                AND recovery.last_error_code =
                  allocation.last_error_code
                AND recovery.created_at_ms =
                  allocation.updated_at_ms
                AND recovery.job_run_id IS NOT NULL
            )
        ) AS missing_recovery_count
      FROM free_agent_drafts AS draft
      LEFT JOIN season_matchup_schedule_generations
        AS generation
        ON generation.league_id = draft.league_id
       AND generation.season_id = draft.season_id
       AND generation.status = 'current'
      WHERE draft.league_id = @leagueId
        AND draft.season_id = @seasonId
        AND draft.id = @fadId
      LIMIT 2
    `);
    participantsStatement = database.prepare(`
      SELECT
        participant.team_id,
        manager.user_id AS manager_user_id
      FROM free_agent_draft_teams AS participant
      LEFT JOIN (
        SELECT
          assignment.league_id,
          assignment.team_id,
          user.id AS user_id
        FROM team_manager_assignments AS assignment
        JOIN league_memberships AS membership
          ON membership.league_id = assignment.league_id
         AND membership.id = assignment.membership_id
         AND membership.user_id = assignment.user_id
         AND membership.status = 'active'
         AND membership.ended_at_ms IS NULL
        JOIN users AS user
          ON user.id = membership.user_id
         AND user.status = 'active'
        WHERE assignment.status = 'accepted'
          AND assignment.accepted_at_ms IS NOT NULL
          AND assignment.ended_at_ms IS NULL
      ) AS manager
        ON manager.league_id = participant.league_id
       AND manager.team_id = participant.team_id
      WHERE participant.league_id = @leagueId
        AND participant.season_id = @seasonId
        AND participant.fad_id = @fadId
      ORDER BY participant.team_id
    `);
    outcomesStatement = database.prepare(`
      SELECT
        candidate.id AS snapshot_entry_id,
        candidate.team_id,
        allocation.id AS allocation_id,
        allocation.status AS allocation_status,
        allocation.winning_snapshot_entry_id,
        event.offer_valid,
        event.offer_outcome_code
      FROM candidate_card_snapshot_entries AS candidate
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = candidate.league_id
       AND allocation.season_id = candidate.season_id
       AND allocation.fad_id = candidate.fad_id
       AND allocation.player_id = candidate.player_id
      LEFT JOIN free_agent_draft_allocation_events AS event
        ON event.league_id = allocation.league_id
       AND event.season_id = allocation.season_id
       AND event.fad_id = allocation.fad_id
       AND event.allocation_id = allocation.id
       AND event.allocation_version = allocation.version
       AND event.player_id = allocation.player_id
       AND event.event_kind = 'offer_considered'
       AND event.snapshot_entry_id = candidate.id
      WHERE candidate.league_id = @leagueId
        AND candidate.season_id = @seasonId
        AND candidate.fad_id = @fadId
        AND candidate.occupant_kind = 'candidate'
      ORDER BY candidate.team_id, candidate.id
    `);
    notificationStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE id = @notificationId
      LIMIT 2
    `);
    outboxStatement = database.prepare(`
      SELECT *
      FROM outbox_events
      WHERE league_id = @leagueId
        AND id = @outboxEventId
      LIMIT 2
    `);
    outboxAudienceStatement = database.prepare(`
      SELECT audience_kind, team_id, user_id
      FROM outbox_event_audiences
      WHERE league_id = @leagueId
        AND outbox_event_id = @outboxEventId
      ORDER BY audience_kind, team_id, user_id
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftAllocationLifecycleWriter",
      tableName: "free_agent_drafts",
    });
  }

  function readEvidence(command) {
    const row = uniqueRow(
      evidenceStatement.all(command),
      "The FAD allocation lifecycle root"
    );
    if (!row) {
      conflict(
        "The FAD allocation lifecycle root is unavailable.",
        "ROOT_NOT_FOUND"
      );
    }
    return row;
  }

  function requireTransaction() {
    if (database.inTransaction !== true) {
      invalid(
        "FAD allocation lifecycle writes require the lifecycle transaction.",
        "TRANSACTION_REQUIRED"
      );
    }
  }

  function requireBoundRoot(command, row) {
    const existing = command.existing;
    if (
      !isPlainObject(existing) ||
      row.league_id !== command.leagueId ||
      row.season_id !== command.seasonId ||
      row.id !== command.fadId ||
      row.status !== command.fromStatus ||
      row.version !== command.expectedVersion ||
      row.updated_at_ms > command.occurredAtMs ||
      existing.id !== command.fadId ||
      existing.leagueId !== command.leagueId ||
      existing.seasonId !== command.seasonId ||
      existing.status !== command.fromStatus ||
      existing.version !== command.expectedVersion ||
      existing.updatedAtMs !== row.updated_at_ms ||
      existing.deadlineLockedAtMs !==
        row.deadline_locked_at_ms ||
      existing.currentCompetitionFirstMatchupWeekId !==
        row.current_competition_first_matchup_week_id ||
      !scheduleMatches(row, command.schedule)
    ) {
      conflict(
        "The FAD allocation lifecycle transition lost its exact root or schedule binding.",
        "ROOT_BINDING_CHANGED"
      );
    }
  }

  function beforeTransition(input = {}) {
    requireTransaction();
    const command = requireSupportedTransition(input);
    try {
      const row = readEvidence(command);
      requireBoundRoot(command, row);
      const allocationCount = nonnegativeInteger(
        row.allocation_count,
        "FAD allocation count"
      );
      const pendingAllocationCount = nonnegativeInteger(
        row.pending_allocation_count,
        "FAD pending-allocation count"
      );
      if (
        pendingAllocationCount > allocationCount
      ) {
        incompatible(
          "The FAD allocation counts are inconsistent.",
          "ALLOCATION_COUNTS_INVALID"
        );
      }
      if (command.toStatus === "allocating") {
        if (
          allocationCount < 1 ||
          pendingAllocationCount !== allocationCount ||
          row.invalid_allocation_job_count !== 0
        ) {
          conflict(
            "FAD allocation may start only with complete pending durable per-player work.",
            "ALLOCATION_START_NOT_READY"
          );
        }
      } else if (
        command.fromStatus === "deadline_locked"
      ) {
        if (
          allocationCount !== 0 ||
          pendingAllocationCount !== 0
        ) {
          conflict(
            "A deadline-locked FAD may enter rapid directly only with zero Candidate allocations.",
            "DIRECT_RAPID_NOT_READY"
          );
        }
      } else if (
        allocationCount < 1 ||
        pendingAllocationCount !== 0 ||
        row.unapproved_allocation_count !== 0 ||
        row.missing_current_event_count !== 0 ||
        row.missing_offer_event_count !== 0 ||
        row.missing_recovery_count !== 0
      ) {
        conflict(
          "FAD allocation completion requires every allocation and offer to have approved current durable evidence.",
          "ALLOCATION_COMPLETION_NOT_READY"
        );
      }
      return Object.freeze({
        allocationCount,
        pendingAllocationCount,
        fromStatus: command.fromStatus,
        toStatus: command.toStatus,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "validateFreeAgentDraftAllocationLifecycleTransition",
        tableName: "free_agent_drafts",
      });
    }
  }

  function canonicalParticipants(command, root) {
    const rows = participantsStatement.all(command);
    if (
      rows.length !== root.participating_team_count ||
      rows.some(
        (row, index) =>
          !UUID_PATTERN.test(row.team_id || "") ||
          (index > 0 &&
            rows[index - 1].team_id >= row.team_id) ||
          (row.manager_user_id !== null &&
            !UUID_PATTERN.test(
              row.manager_user_id || ""
            ))
      )
    ) {
      incompatible(
        "The current FAD manager/team recipient projection is noncanonical.",
        "RECIPIENT_PROJECTION_INVALID"
      );
    }
    return rows;
  }

  function aggregateCounts(command, participants) {
    const countsByTeam = new Map(
      participants.map((participant) => [
        participant.team_id,
        {
          automaticWins: 0,
          losses: 0,
          restrictedPending: 0,
          invalidOffers: 0,
        },
      ])
    );
    const rows = outcomesStatement.all(command);
    const seen = new Set();
    for (const row of rows) {
      if (
        !UUID_PATTERN.test(
          row.snapshot_entry_id || ""
        ) ||
        !UUID_PATTERN.test(row.team_id || "") ||
        !UUID_PATTERN.test(
          row.allocation_id || ""
        ) ||
        seen.has(row.snapshot_entry_id) ||
        !countsByTeam.has(row.team_id) ||
        !APPROVED_PRE_RAPID_STATUSES.has(
          row.allocation_status
        ) ||
        typeof row.offer_outcome_code !== "string" ||
        ![0, 1].includes(row.offer_valid)
      ) {
        incompatible(
          "The aggregate Candidate outcome evidence is noncanonical.",
          "OUTCOME_EVIDENCE_INVALID"
        );
      }
      seen.add(row.snapshot_entry_id);
      const counts = countsByTeam.get(row.team_id);
      if (
        INVALID_OFFER_OUTCOMES.has(
          row.offer_outcome_code
        )
      ) {
        counts.invalidOffers += 1;
      } else if (
        ["no_valid_offer", "invalid"].includes(
          row.allocation_status
        )
      ) {
        counts.invalidOffers += 1;
      } else if (
        row.allocation_status ===
        "correction_required"
      ) {
        continue;
      } else if (
        row.allocation_status === "automatic_award"
      ) {
        if (
          row.winning_snapshot_entry_id ===
          row.snapshot_entry_id
        ) {
          counts.automaticWins += 1;
        } else {
          counts.losses += 1;
        }
      } else if (
        [
          "restricted_scheduled",
          "restricted_active",
        ].includes(row.allocation_status)
      ) {
        if (
          row.offer_outcome_code ===
          "restricted_tied"
        ) {
          counts.restrictedPending += 1;
        } else {
          counts.losses += 1;
        }
      }
    }
    return countsByTeam;
  }

  function requirePersistedNotification({
    command,
    notificationId,
    teamId,
    userId,
    counts,
  }) {
    const row = uniqueRow(
      notificationStatement.all({ notificationId }),
      "The aggregate FAD result notification"
    );
    const message = row
      ? parseJson(
          row.message_data_json,
          "The aggregate FAD result notification data"
        )
      : null;
    let persistedContract;
    let expectedContract;
    try {
      persistedContract =
        createFreeAgentDraftNotificationContract({
          type: row?.event_type,
          recipientUserId: row?.user_id,
          messageData: message,
        });
      expectedContract =
        createFreeAgentDraftNotificationContract({
          type: "fad_automatic_result",
          recipientUserId: userId,
          messageData: {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            fadId: command.fadId,
            teamId,
            automaticWins: counts.automaticWins,
            losses: counts.losses,
            restrictedPending:
              counts.restrictedPending,
            invalidOffers: counts.invalidOffers,
            destination: {
              kind: "fad_results",
              leagueId: command.leagueId,
              fadId: command.fadId,
            },
          },
        });
    } catch {
      incompatible(
        "The persisted aggregate FAD result notification violates its contract.",
        "NOTIFICATION_EVIDENCE_INVALID"
      );
    }
    if (
      !row ||
      row.user_id !== userId ||
      row.league_id !== command.leagueId ||
      row.event_type !== "fad_automatic_result" ||
      row.related_feature !== "free_agent_draft" ||
      row.related_record_id !== command.fadId ||
      row.delivery_status !== "pending" ||
      row.created_at_ms !== command.occurredAtMs ||
      row.delivered_at_ms !== null ||
      row.message_data_json !==
        JSON.stringify(persistedContract.messageData) ||
      row.deduplication_key !==
        persistedContract.deduplicationKey ||
      JSON.stringify(persistedContract.messageData) !==
        JSON.stringify(expectedContract.messageData) ||
      persistedContract.deduplicationKey !==
        expectedContract.deduplicationKey
    ) {
      incompatible(
        "The persisted aggregate FAD result notification is incomplete.",
        "NOTIFICATION_EVIDENCE_INVALID"
      );
    }
  }

  function writeOutbox({
    command,
    updated,
    notificationPublications,
  }) {
    const draftOutboxEventId = deterministicUuid(
      `fad-allocation-lifecycle:outbox:draft:` +
        `${command.fadId}:${updated.version}`
    );
    const existingDraftOutbox = uniqueRow(
      outboxStatement.all({
        leagueId: command.leagueId,
        outboxEventId: draftOutboxEventId,
      }),
      "The replayed FAD allocation lifecycle outbox event"
    );
    if (!existingDraftOutbox) {
      assertSynchronous(
        outbox.write({
          id: draftOutboxEventId,
          leagueId: command.leagueId,
          eventType: "free_agent_draft.changed",
          aggregateType: "free_agent_draft",
          aggregateId: command.fadId,
          payload: createSocketEventMetadata({
            eventType: "free_agent_draft.changed",
            version: updated.version,
            reasonCode: "allocation_changed",
            occurredAtMs: command.occurredAtMs,
            related: createEmptySocketRelated({
              fadId: command.fadId,
            }),
          }),
          occurredAtMs: command.occurredAtMs,
          audiences: [{ kind: "league" }],
        }),
        "FAD allocation lifecycle outbox write"
      );
    }
    const notificationOutboxEventIds = [];
    for (const publication of notificationPublications) {
      const notificationOutboxEventId = deterministicUuid(
        `fad-allocation-lifecycle:outbox:notification:` +
          publication.notificationId
      );
      const existingNotificationOutbox = uniqueRow(
        outboxStatement.all({
          leagueId: command.leagueId,
          outboxEventId: notificationOutboxEventId,
        }),
        "The replayed FAD allocation notification outbox event"
      );
      if (!existingNotificationOutbox) {
        assertSynchronous(
          outbox.write({
            id: notificationOutboxEventId,
            leagueId: command.leagueId,
            eventType: "notification.created",
            aggregateType: "notification",
            aggregateId: publication.notificationId,
            payload: createSocketEventMetadata({
              eventType: "notification.created",
              version: 1,
              reasonCode: "allocation_changed",
              occurredAtMs: command.occurredAtMs,
              related: createEmptySocketRelated({
                fadId: command.fadId,
                teamId: publication.teamId,
              }),
            }),
            occurredAtMs: command.occurredAtMs,
            audiences: [{
              kind: "user",
              userId: publication.userId,
            }],
          }),
          "FAD allocation notification outbox write"
        );
      }
      notificationOutboxEventIds.push(
        notificationOutboxEventId
      );
    }
    return Object.freeze({
      draftOutboxEventId,
      notificationOutboxEventIds: Object.freeze(
        notificationOutboxEventIds
      ),
    });
  }

  function requirePersistedOutbox({
    command,
    updated,
    outboxIds,
    notificationPublications,
  }) {
    const expected = [
      {
        id: outboxIds.draftOutboxEventId,
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: command.fadId,
        payload: createSocketEventEnvelope({
          eventId: outboxIds.draftOutboxEventId,
          type: "free_agent_draft.changed",
          leagueId: command.leagueId,
          resourceId: command.fadId,
          version: updated.version,
          reasonCode: "allocation_changed",
          occurredAt: command.occurredAtMs,
          related: createEmptySocketRelated({
            fadId: command.fadId,
          }),
        }),
        audiences: [
          {
            audience_kind: "league",
            team_id: null,
            user_id: null,
          },
        ],
      },
      ...notificationPublications.map((publication, index) => ({
        id: outboxIds.notificationOutboxEventIds[index],
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: publication.notificationId,
        payload: createSocketEventEnvelope({
          eventId: outboxIds.notificationOutboxEventIds[index],
          type: "notification.created",
          leagueId: command.leagueId,
          resourceId: publication.notificationId,
          version: 1,
          reasonCode: "allocation_changed",
          occurredAt: command.occurredAtMs,
          related: createEmptySocketRelated({
            fadId: command.fadId,
            teamId: publication.teamId,
          }),
        }),
        audiences: [{
          audience_kind: "user",
          team_id: null,
          user_id: publication.userId,
        }],
      })),
    ];
    for (const item of expected) {
      const row = uniqueRow(
        outboxStatement.all({
          leagueId: command.leagueId,
          outboxEventId: item.id,
        }),
        "The FAD allocation lifecycle outbox event"
      );
      const audiences = outboxAudienceStatement.all({
        leagueId: command.leagueId,
        outboxEventId: item.id,
      });
      const payload = row
        ? parseJson(
            row.payload_json,
            "The FAD allocation lifecycle outbox payload"
          )
        : null;
      if (
        !row ||
        row.event_type !== item.eventType ||
        row.aggregate_type !== item.aggregateType ||
        row.aggregate_id !== item.aggregateId ||
        row.status !== "pending" ||
        row.available_at_ms !== command.occurredAtMs ||
        row.created_at_ms !== command.occurredAtMs ||
        row.updated_at_ms !== command.occurredAtMs ||
        JSON.stringify(payload) !==
          JSON.stringify(item.payload) ||
        JSON.stringify(audiences) !==
          JSON.stringify(item.audiences)
      ) {
        incompatible(
          "The persisted FAD allocation lifecycle outbox evidence is incomplete.",
          "OUTBOX_EVIDENCE_INVALID"
        );
      }
    }
  }

  function afterTransition(input = {}) {
    requireTransaction();
    if (
      !isPlainObject(input) ||
      !isPlainObject(input.effectiveCommand) ||
      !isPlainObject(input.existing) ||
      !isPlainObject(input.updated)
    ) {
      invalid(
        "An exact FAD allocation lifecycle after-transition payload is required."
      );
    }
    const command = requireSupportedTransition({
      ...input.effectiveCommand,
      existing: input.existing,
    });
    const updated = input.updated;
    try {
      const root = readEvidence(command);
      if (
        updated.id !== command.fadId ||
        updated.leagueId !== command.leagueId ||
        updated.seasonId !== command.seasonId ||
        updated.status !== command.toStatus ||
        updated.version !== command.expectedVersion + 1 ||
        updated.updatedAtMs !== command.occurredAtMs ||
        root.status !== command.toStatus ||
        root.version !== updated.version ||
        root.updated_at_ms !== command.occurredAtMs ||
        (command.toStatus === "rapid" &&
          (updated.allocationCompletedAtMs !==
            command.occurredAtMs ||
            root.allocation_completed_at_ms !==
              command.occurredAtMs)) ||
        !scheduleMatches(root, command.schedule)
      ) {
        incompatible(
          "The transitioned FAD allocation lifecycle root is not durably visible.",
          "TRANSITION_RESULT_INVALID"
        );
      }

      const notificationIds = [];
      const notificationPublications = [];
      if (command.toStatus === "rapid") {
        const participants = canonicalParticipants(
          command,
          root
        );
        const countsByTeam = aggregateCounts(
          command,
          participants
        );
        for (const participant of participants) {
          const userId = participant.manager_user_id;
          if (userId === null) continue;
          const teamId = participant.team_id;
          const counts = countsByTeam.get(teamId);
          const notificationId = deterministicUuid(
            `fad-automatic-result:notification:` +
              `${command.fadId}:${teamId}:${userId}`
          );
          const notificationContract =
            createFreeAgentDraftNotificationContract({
              type: "fad_automatic_result",
              recipientUserId: userId,
              messageData: {
                leagueId: command.leagueId,
                seasonId: command.seasonId,
                fadId: command.fadId,
                teamId,
                automaticWins: counts.automaticWins,
                losses: counts.losses,
                restrictedPending:
                  counts.restrictedPending,
                invalidOffers: counts.invalidOffers,
                destination: {
                  kind: "fad_results",
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
              createdAtMs: command.occurredAtMs,
              deliveredAtMs: null,
              deduplicationKey:
                notificationContract.deduplicationKey,
            }),
            "FAD automatic-result notification write"
          );
          if (
            inserted?.notification?.id !==
            notificationId
          ) {
            incompatible(
              "The FAD automatic-result notification writer returned inconsistent evidence.",
              "NOTIFICATION_WRITE_INVALID"
            );
          }
          requirePersistedNotification({
            command,
            notificationId,
            teamId,
            userId,
            counts,
          });
          notificationIds.push(notificationId);
          notificationPublications.push(
            Object.freeze({
              notificationId,
              teamId,
              userId,
            })
          );
        }
      }
      const outboxIds = writeOutbox({
        command,
        updated,
        notificationPublications,
      });
      requirePersistedOutbox({
        command,
        updated,
        outboxIds,
        notificationPublications,
      });
      const result = Object.freeze({
        fromStatus: command.fromStatus,
        toStatus: command.toStatus,
        fadVersion: updated.version,
        notificationIds: Object.freeze(
          notificationIds
        ),
        outboxEventIds: Object.freeze(
          [
            outboxIds.draftOutboxEventId,
            ...outboxIds.notificationOutboxEventIds,
          ]
        ),
      });
      if (beforeCommit) {
        assertSynchronous(
          beforeCommit(
            "completeFadAllocationLifecycleTransition",
            result
          ),
          "FAD allocation lifecycle beforeCommit"
        );
      }
      return result;
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "completeFreeAgentDraftAllocationLifecycleTransition",
        tableName: "free_agent_drafts",
      });
    }
  }

  const writer = Object.freeze({
    afterTransition,
    beforeTransition,
    listCandidates(input = {}) {
      const scan = normalizeScan(input);
      try {
        const rows = listStatement.all(scan);
        const seen = new Set();
        return Object.freeze(
          rows.map((row) => {
            const candidate = candidateFromRow(
              row,
              scan.nowMs
            );
            const identity =
              `${candidate.leagueId}:` +
              `${candidate.seasonId}:` +
              candidate.fadId;
            if (seen.has(identity)) {
              incompatible(
                "The FAD root scan returned a duplicate current schedule binding.",
                "ROOT_SCAN_AMBIGUOUS"
              );
            }
            seen.add(identity);
            return candidate;
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "listFreeAgentDraftAllocationLifecycleCandidates",
          tableName: "free_agent_drafts",
        });
      }
    },
  });
  if (
    Object.keys(writer).length !==
      WRITER_METHODS.length ||
    WRITER_METHODS.some(
      (method) => typeof writer[method] !== "function"
    )
  ) {
    throw new TypeError(
      "The FAD allocation lifecycle writer surface is incomplete."
    );
  }
  return writer;
}

module.exports = {
  FREE_AGENT_DRAFT_ALLOCATION_LIFECYCLE_WRITER_METHODS:
    WRITER_METHODS,
  createSqliteFreeAgentDraftAllocationLifecycleWriter,
};
