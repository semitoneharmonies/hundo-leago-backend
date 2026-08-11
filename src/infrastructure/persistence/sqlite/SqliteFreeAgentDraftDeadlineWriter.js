const crypto = require("node:crypto");

const {
  evaluateCandidateCard,
} = require(
  "../../../domain/freeAgentDraft/candidateCardPolicy"
);
const {
  UUID_PATTERN,
  buildFreeAgentDraftAllocationOccurrenceKey,
  buildFreeAgentDraftDeadlineOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
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
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");

const JOB_TYPE = "fad_deadline";
const ALLOCATION_JOB_TYPE = "fad_allocation";
const COMMAND_FIELDS = Object.freeze([
  "deadlineAtMs",
  "executedAtMs",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "scheduledForMs",
  "seasonId",
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
const RESULT_FIELDS = Object.freeze([
  "activityId",
  "allocationCount",
  "candidatePlayerCount",
  "cardCount",
  "code",
  "deadlineAtMs",
  "fadId",
  "fadVersion",
  "notificationIds",
  "outboxEventIds",
  "processedAtMs",
  "schemaVersion",
]);
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function invalid(message, reasonCode) {
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
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`,
      "IDENTIFIER_INVALID"
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

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
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

function normalizeCommand(input) {
  exactObject(
    input,
    COMMAND_FIELDS,
    "FAD deadline execution command"
  );
  exactObject(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "FAD deadline job execution"
  );
  const fadId = canonicalId(
    input.fadId,
    "Free Agent Draft identifier"
  );
  const deadlineAtMs = safeTimestamp(
    input.deadlineAtMs,
    "Candidate Card deadline timestamp"
  );
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "deadline scheduled timestamp"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "deadline occurrence key"
  );
  let canonicalOccurrenceKey;
  try {
    canonicalOccurrenceKey =
      buildFreeAgentDraftDeadlineOccurrenceKey({
        fadId,
        deadlineAtMs,
      });
  } catch {
    invalid(
      "The FAD deadline occurrence key is invalid.",
      "OCCURRENCE_KEY_INVALID"
    );
  }
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    scheduledForMs !== deadlineAtMs
  ) {
    invalid(
      "The FAD deadline occurrence is not canonical for its scope.",
      "OCCURRENCE_SCOPE_INVALID"
    );
  }
  const executedAtMs = safeTimestamp(
    input.executedAtMs,
    "deadline execution timestamp"
  );
  const startedAtMs = safeTimestamp(
    input.jobExecution.startedAtMs,
    "deadline job start timestamp"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.jobExecution.leaseExpiresAtMs,
    "deadline job lease expiry"
  );
  if (
    executedAtMs < deadlineAtMs ||
    startedAtMs < scheduledForMs ||
    startedAtMs > executedAtMs ||
    leaseExpiresAtMs <= executedAtMs
  ) {
    conflict(
      "The FAD deadline clock or job lease is not valid for execution.",
      "DEADLINE_EXECUTION_TIME_INVALID"
    );
  }
  return Object.freeze({
    leagueId: canonicalId(
      input.leagueId,
      "league identifier"
    ),
    seasonId: canonicalId(
      input.seasonId,
      "season identifier"
    ),
    fadId,
    deadlineAtMs,
    occurrenceKey,
    scheduledForMs,
    executedAtMs,
    runId: canonicalId(
      input.jobExecution.runId,
      "job-run identifier"
    ),
    leaseOwner: boundedText(
      input.jobExecution.leaseOwner,
      128,
      "job lease owner"
    ),
    leaseToken: boundedText(
      input.jobExecution.leaseToken,
      200,
      "job lease token"
    ),
    leaseExpiresAtMs,
    startedAtMs,
    attemptCount: positiveInteger(
      input.jobExecution.attemptCount,
      "job attempt count"
    ),
    expectedJobVersion: positiveInteger(
      input.jobExecution.expectedVersion,
      "job-run version"
    ),
  });
}

function uniqueRow(rows, description) {
  if (rows.length > 1) {
    incompatible(
      `${description} is ambiguous.`,
      "STORED_STATE_AMBIGUOUS"
    );
  }
  return rows[0] || null;
}

function assertSynchronous(value, description) {
  if (
    value &&
    typeof value.then === "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      `${description} must be synchronous.`
    );
  }
  return value;
}

function slotKey(group, number) {
  return `${group}${String(number).padStart(2, "0")}`;
}

function mapEntry(row) {
  const common = {
    entryId: row.id,
    entryVersion: row.version,
    entryKind: row.entry_kind,
    playerId: row.player_id,
    effectivePositionGroup:
      row.effective_position_group,
    slotKey: slotKey(
      row.requested_slot_group,
      row.requested_slot_number
    ),
    placementState: row.placement_state,
    conflictCode: row.conflict_code,
  };
  if (row.entry_kind === "carryover") {
    return Object.freeze({
      ...common,
      ownershipId: row.carryover_ownership_id,
      contractId: row.carryover_contract_id,
      sourceRosterCategory:
        row.source_roster_category,
      contractType: row.carryover_contract_type,
      originalTotalValueCents:
        row.carryover_original_total_value_cents,
      originalTermYears:
        row.carryover_original_term_years,
      aavCents: row.carryover_aav_cents,
      remainingYears: row.remaining_years,
    });
  }
  return Object.freeze({
    ...common,
    totalValueCents:
      row.proposed_total_value_cents,
    termYears: row.proposed_term_years,
    eligibilityStatus: row.eligibility_status,
    validationCode: row.validation_code,
  });
}

function domainEntry(entry) {
  if (entry.entryKind === "carryover") {
    return {
      entryId: entry.entryId,
      entryKind: "carryover",
      playerId: entry.playerId,
      ownershipId: entry.ownershipId,
      contractId: entry.contractId,
      effectivePositionGroup:
        entry.effectivePositionGroup,
      slotKey: entry.slotKey,
      placementState: entry.placementState,
      conflictCode: entry.conflictCode,
      sourceRosterCategory:
        entry.sourceRosterCategory,
      contractType: entry.contractType,
      originalTotalValueCents:
        entry.originalTotalValueCents,
      originalTermYears:
        entry.originalTermYears,
      aavCents: entry.aavCents,
      remainingYears: entry.remainingYears,
    };
  }
  return {
    entryId: entry.entryId,
    entryKind: "candidate",
    playerId: entry.playerId,
    effectivePositionGroup:
      entry.effectivePositionGroup,
    slotKey: entry.slotKey,
    placementState: entry.placementState,
    conflictCode: entry.conflictCode,
    totalValueCents: entry.totalValueCents,
    termYears: entry.termYears,
    eligibilityStatus:
      entry.eligibilityStatus,
    validationCode: entry.validationCode,
  };
}

function warningCodes(evaluation) {
  const codes = new Set();
  if (evaluation.capStatus === "over_cap") {
    codes.add("CANDIDATE_CARD_OVER_CAP");
  }
  for (const entry of evaluation.entries) {
    if (
      entry.entryKind === "candidate" &&
      entry.eligibilityStatus === "warning"
    ) {
      codes.add(entry.validationCode);
    }
  }
  return Object.freeze([...codes].sort());
}

function requireDeadlineResult(value) {
  const actual = isPlainObject(value)
    ? Object.keys(value).sort()
    : [];
  const expected = [...RESULT_FIELDS].sort();
  if (
    !isPlainObject(value) ||
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    ) ||
    value.schemaVersion !== 1 ||
    value.code !== "FAD_DEADLINE_PUBLISHED" ||
    !UUID_PATTERN.test(value.fadId || "") ||
    !UUID_PATTERN.test(value.activityId || "") ||
    !Number.isSafeInteger(value.deadlineAtMs) ||
    value.deadlineAtMs < 0 ||
    !Number.isSafeInteger(value.processedAtMs) ||
    value.processedAtMs < value.deadlineAtMs ||
    !Number.isSafeInteger(value.fadVersion) ||
    value.fadVersion < 1 ||
    !Number.isSafeInteger(value.cardCount) ||
    value.cardCount < 1 ||
    !Number.isSafeInteger(value.allocationCount) ||
    value.allocationCount < 0 ||
    value.candidatePlayerCount !==
      value.allocationCount ||
    !Array.isArray(value.notificationIds) ||
    value.notificationIds.some(
      (id) => !UUID_PATTERN.test(id || "")
    ) ||
    new Set(value.notificationIds).size !==
      value.notificationIds.length ||
    !Array.isArray(value.outboxEventIds) ||
    value.outboxEventIds.length < 2 ||
    value.outboxEventIds.some(
      (id) => !UUID_PATTERN.test(id || "")
    ) ||
    new Set(value.outboxEventIds).size !==
      value.outboxEventIds.length
  ) {
    incompatible(
      "The persisted FAD deadline result is noncanonical.",
      "DEADLINE_RESULT_INVALID"
    );
  }
  return Object.freeze({
    ...value,
    notificationIds: Object.freeze([
      ...value.notificationIds,
    ]),
    outboxEventIds: Object.freeze([
      ...value.outboxEventIds,
    ]),
  });
}

function terminalProjection({
  command,
  result,
  replayed,
}) {
  return Object.freeze({
    outcome: "succeeded",
    replayed,
    runId: command.runId,
    completedAtMs: result.processedAtMs,
    jobVersion: command.expectedJobVersion + 1,
    fadVersion: result.fadVersion,
    cardCount: result.cardCount,
    allocationCount: result.allocationCount,
    notificationIds: result.notificationIds,
    activityId: result.activityId,
    outboxEventIds: result.outboxEventIds,
  });
}

function createSqliteFreeAgentDraftDeadlineWriter({
  database,
  eligibilityDeadlineReconciler,
  capReadRepository,
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
      "createSqliteFreeAgentDraftDeadlineWriter requires an opened database"
    );
  }
  if (
    !eligibilityDeadlineReconciler ||
    typeof eligibilityDeadlineReconciler
      .reconcileInCurrentTransaction !== "function"
  ) {
    throw new TypeError(
      "FAD deadline publication requires the final eligibility deadline reconciler"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "FAD deadline beforeCommit must be a function"
    );
  }

  const capReader =
    capReadRepository === undefined
      ? createSqliteCapReadRepository({ database })
      : capReadRepository;
  if (
    !capReader ||
    typeof capReader.calculate !== "function"
  ) {
    throw new TypeError(
      "FAD deadline publication requires a cap-read repository"
    );
  }

  let notifications;
  let outbox;
  let rootStatement;
  let scheduleStatement;
  let jobStatement;
  let cardsStatement;
  let entriesStatement;
  let membersStatement;
  let updateCardStatement;
  let insertRevisionStatement;
  let expireHelpStatement;
  let insertSnapshotStatement;
  let insertSnapshotEntryStatement;
  let insertAllocationStatement;
  let insertAllocationJobStatement;
  let insertActivityStatement;
  let terminalJobStatement;
  let resultEvidenceStatement;
  let activityEvidenceStatement;
  let notificationEvidenceStatement;
  let outboxEvidenceStatement;

  try {
    notifications = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    rootStatement = database.prepare(`
      SELECT
        draft.*,
        readiness.deadline_job_run_id
          AS bound_deadline_job_run_id
      FROM free_agent_drafts AS draft
      JOIN free_agent_draft_readiness_operations
        AS readiness
        ON readiness.league_id = draft.league_id
       AND readiness.season_id = draft.season_id
       AND readiness.id = draft.readiness_operation_id
       AND readiness.readiness_occurrence_key =
           draft.readiness_occurrence_key
       AND readiness.status = 'succeeded'
       AND readiness.created_fad_id = draft.id
      WHERE draft.league_id = @leagueId
        AND draft.season_id = @seasonId
        AND draft.id = @fadId
      LIMIT 2
    `);
    scheduleStatement = database.prepare(`
      SELECT
        generation.schedule_operation_id,
        generation.schedule_version,
        generation.week_one_matchup_week_id,
        generation.week_one_starts_at_ms
      FROM season_matchup_schedule_generations
        AS generation
      JOIN matchup_operations AS operation
        ON operation.league_id = generation.league_id
       AND operation.season_id = generation.season_id
       AND operation.id = generation.schedule_operation_id
       AND operation.operation_type = 'schedule_generate'
       AND operation.status = 'succeeded'
       AND operation.completed_at_ms IS NOT NULL
      JOIN matchup_weeks AS week_one
        ON week_one.league_id = generation.league_id
       AND week_one.season_id = generation.season_id
       AND week_one.id = generation.week_one_matchup_week_id
       AND week_one.sequence = 1
       AND week_one.starts_at_ms =
           generation.week_one_starts_at_ms
      WHERE generation.league_id = @leagueId
        AND generation.season_id = @seasonId
        AND generation.status = 'current'
      LIMIT 2
    `);
    jobStatement = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
      LIMIT 2
    `);
    cardsStatement = database.prepare(`
      SELECT card.*
      FROM free_agent_draft_teams AS participant
      JOIN candidate_cards AS card
        ON card.league_id = participant.league_id
       AND card.season_id = participant.season_id
       AND card.fad_id = participant.fad_id
       AND card.team_id = participant.team_id
      WHERE participant.league_id = @leagueId
        AND participant.season_id = @seasonId
        AND participant.fad_id = @fadId
      ORDER BY card.team_id, card.id
    `);
    entriesStatement = database.prepare(`
      SELECT
        entry.*,
        contract.contract_type
          AS carryover_contract_type
      FROM candidate_card_entries AS entry
      LEFT JOIN contracts AS contract
        ON contract.league_id = entry.league_id
       AND contract.id = entry.carryover_contract_id
      WHERE entry.league_id = @leagueId
        AND entry.season_id = @seasonId
        AND entry.fad_id = @fadId
        AND entry.card_id = @cardId
        AND entry.team_id = @teamId
      ORDER BY entry.id
    `);
    membersStatement = database.prepare(`
      SELECT DISTINCT membership.user_id
      FROM league_memberships AS membership
      JOIN users AS user
        ON user.id = membership.user_id
       AND user.status = 'active'
      WHERE membership.league_id = @leagueId
        AND membership.status = 'active'
        AND membership.ended_at_ms IS NULL
      ORDER BY membership.user_id
    `);
    updateCardStatement = database.prepare(`
      UPDATE candidate_cards
      SET status = @lockedStatus,
          completeness_code = @completenessCode,
          filled_mandatory_count = @filledMandatoryCount,
          missing_mandatory_count = @missingMandatoryCount,
          filled_bench_count = @filledBenchCount,
          empty_bench_count = @emptyBenchCount,
          blocking_validation_count = @blockingValidationCount,
          structural_conflict_count = @structuralConflictCount,
          carried_roster_structural_conflict_count =
            @carriedRosterStructuralConflictCount,
          maximum_possible_cap_cents = @maximumPossibleCapCents,
          cap_status = @capStatus,
          allocation_eligibility = @allocationEligibility,
          allocation_exclusion_reason = @allocationExclusionReason,
          locked_at_ms = @deadlineAtMs,
          updated_at_ms = @executedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @cardId
        AND team_id = @teamId
        AND status = 'open'
        AND version = @expectedCardVersion
    `);
    insertRevisionStatement = database.prepare(`
      INSERT INTO candidate_card_revisions (
        id, league_id, season_id, fad_id, card_id, team_id,
        resulting_card_version, action, affected_entry_id,
        player_id, actor_user_id, actor_membership_id,
        actor_authority, before_evidence_json,
        after_evidence_json, potential_illegality_acknowledged,
        warning_codes_json, occurred_at_ms, created_at_ms, version
      ) VALUES (
        @revisionId, @leagueId, @seasonId, @fadId, @cardId,
        @teamId, @lockedCardVersion, 'deadline_locked', NULL,
        NULL, NULL, NULL, 'system', @beforeEvidenceJson,
        @afterEvidenceJson, 0, @warningCodesJson,
        @executedAtMs, @executedAtMs, 1
      )
    `);
    expireHelpStatement = database.prepare(`
      UPDATE candidate_card_help_requests
      SET status = 'expired',
          updated_at_ms = @executedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND status = 'active'
    `);
    insertSnapshotStatement = database.prepare(`
      INSERT INTO candidate_card_snapshots (
        id, league_id, season_id, fad_id, card_id, team_id,
        locked_card_version, locked_status, completeness_code,
        filled_mandatory_count, missing_mandatory_count,
        filled_bench_count, empty_bench_count,
        blocking_validation_count, structural_conflict_count,
        cap_limit_cents, carried_active_player_amount_cents,
        retention_obligation_cents, buyout_penalty_cents,
        carried_cap_usage_cents, proposed_candidate_aav_cents,
        maximum_possible_cap_cents, maximum_cap_space_cents,
        effective_deadline_at_ms, processed_at_ms, created_at_ms,
        carried_roster_structural_conflict_count, cap_status,
        allocation_eligibility, allocation_exclusion_reason
      ) VALUES (
        @snapshotId, @leagueId, @seasonId, @fadId, @cardId,
        @teamId, @lockedCardVersion, @lockedStatus,
        @completenessCode, @filledMandatoryCount,
        @missingMandatoryCount, @filledBenchCount,
        @emptyBenchCount, @blockingValidationCount,
        @structuralConflictCount, @capLimitCents,
        @carriedActivePlayerAmountCents,
        @retentionObligationCents, @buyoutPenaltyCents,
        @carriedCapUsageCents, @proposedCandidateAavCents,
        @maximumPossibleCapCents, @maximumCapSpaceCents,
        @deadlineAtMs, @executedAtMs, @executedAtMs,
        @carriedRosterStructuralConflictCount, @capStatus,
        @allocationEligibility, @allocationExclusionReason
      )
    `);
    insertSnapshotEntryStatement = database.prepare(`
      INSERT INTO candidate_card_snapshot_entries (
        id, league_id, season_id, fad_id, snapshot_id,
        card_id, team_id, row_kind, occupant_kind,
        slot_group, slot_number, source_entry_id,
        source_entry_version, player_id, effective_position_group,
        conflict_code, carryover_ownership_id,
        carryover_contract_id, source_roster_category,
        carryover_original_total_value_cents,
        carryover_original_term_years, carryover_aav_cents,
        remaining_years, proposed_total_value_cents,
        proposed_term_years, proposed_aav_cents,
        eligibility_status, validation_code,
        last_edited_by_user_id, last_edited_by_membership_id,
        last_edited_by_authority, last_edited_at_ms,
        created_at_ms, allocation_eligibility,
        allocation_exclusion_reason
      ) VALUES (
        @id, @leagueId, @seasonId, @fadId, @snapshotId,
        @cardId, @teamId, @rowKind, @occupantKind,
        @slotGroup, @slotNumber, @sourceEntryId,
        @sourceEntryVersion, @playerId, @effectivePositionGroup,
        @conflictCode, @carryoverOwnershipId,
        @carryoverContractId, @sourceRosterCategory,
        @carryoverOriginalTotalValueCents,
        @carryoverOriginalTermYears, @carryoverAavCents,
        @remainingYears, @proposedTotalValueCents,
        @proposedTermYears, @proposedAavCents,
        @eligibilityStatus, @validationCode,
        @lastEditedByUserId, @lastEditedByMembershipId,
        @lastEditedByAuthority, @lastEditedAtMs,
        @executedAtMs, @allocationEligibility,
        @allocationExclusionReason
      )
    `);
    insertAllocationStatement = database.prepare(`
      INSERT INTO free_agent_draft_player_allocations (
        id, league_id, season_id, fad_id, player_id, status,
        decision_code, winning_snapshot_entry_id, winning_team_id,
        contract_id, ownership_id, restricted_auction_id,
        fallback_open_auction_id, restricted_minimum_total_cents,
        restricted_minimum_term_years, restricted_minimum_aav_cents,
        accounted_at_ms, last_error_code, created_at_ms,
        updated_at_ms, version
      ) VALUES (
        @allocationId, @leagueId, @seasonId, @fadId, @playerId,
        'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, @executedAtMs,
        @executedAtMs, 1
      )
    `);
    insertAllocationJobStatement = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type, occurrence_key,
        scheduled_for_ms, status, attempt_count, lease_owner,
        lease_expires_at_ms, started_at_ms, completed_at_ms,
        result_json, last_error_code, created_at_ms,
        updated_at_ms, version, lease_token, next_attempt_at_ms
      ) VALUES (
        @allocationJobRunId, @leagueId, @seasonId,
        '${ALLOCATION_JOB_TYPE}', @allocationOccurrenceKey,
        @deadlineAtMs, 'pending', 0, NULL, NULL, NULL, NULL,
        NULL, NULL, @executedAtMs, @executedAtMs, 1, NULL, NULL
      )
    `);
    insertActivityStatement = database.prepare(`
      INSERT INTO league_activity (
        id, league_id, season_id, event_type, actor_user_id,
        actor_authority, team_id, player_id, related_type,
        related_id, display_summary, reason, metadata_json,
        occurred_at_ms
      ) VALUES (
        @activityId, @leagueId, @seasonId,
        'free_agent_draft_cards_published', NULL, 'system',
        NULL, NULL, 'free_agent_draft', @fadId,
        'Candidate Cards published.', NULL, @metadataJson,
        @executedAtMs
      )
    `);
    terminalJobStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @executedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @executedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @runId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @scheduledForMs
        AND status = 'running'
        AND attempt_count = @attemptCount
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms = @leaseExpiresAtMs
        AND lease_expires_at_ms > @executedAtMs
        AND started_at_ms = @startedAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedJobVersion
    `);
    resultEvidenceStatement = database.prepare(`
      SELECT
        (SELECT COUNT(*)
           FROM candidate_card_snapshots
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND fad_id = @fadId) AS card_count,
        (SELECT COUNT(DISTINCT player_id)
           FROM candidate_card_snapshot_entries
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND fad_id = @fadId
            AND occupant_kind = 'candidate'
            AND player_id IS NOT NULL) AS candidate_player_count,
        (SELECT COUNT(*)
           FROM free_agent_draft_player_allocations
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND fad_id = @fadId
            AND status = 'pending') AS allocation_count,
        (SELECT COUNT(*)
           FROM candidate_cards
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND fad_id = @fadId
            AND status IN (
              'locked_complete',
              'locked_incomplete',
              'locked_conflicted'
            )) AS locked_card_count,
        (SELECT COUNT(*)
           FROM candidate_card_help_requests
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND fad_id = @fadId
            AND status = 'active') AS active_help_count
    `);
    activityEvidenceStatement = database.prepare(`
      SELECT *
      FROM league_activity
      WHERE id = @activityId
      LIMIT 2
    `);
    notificationEvidenceStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE id = @notificationId
      LIMIT 2
    `);
    outboxEvidenceStatement = database.prepare(`
      SELECT
        event.*,
        (SELECT COUNT(*)
           FROM outbox_event_audiences AS audience
          WHERE audience.league_id = event.league_id
            AND audience.outbox_event_id = event.id)
          AS audience_count,
        (SELECT COUNT(*)
           FROM outbox_event_audiences AS audience
          WHERE audience.league_id = event.league_id
            AND audience.outbox_event_id = event.id
            AND audience.audience_kind = 'league'
            AND audience.team_id IS NULL
            AND audience.user_id IS NULL)
          AS league_audience_count,
        (SELECT audience.user_id
           FROM outbox_event_audiences AS audience
          WHERE audience.league_id = event.league_id
            AND audience.outbox_event_id = event.id
            AND audience.audience_kind = 'user'
            AND audience.team_id IS NULL
          LIMIT 1)
          AS audience_user_id
      FROM outbox_events AS event
      WHERE event.id = @outboxEventId
      LIMIT 2
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftDeadlineWriter",
      tableName: "free_agent_drafts",
    });
  }

  function requireLiveJob(command) {
    const job = uniqueRow(
      jobStatement.all(command),
      "The claimed FAD deadline job"
    );
    if (!job) {
      conflict(
        "The claimed FAD deadline job is unavailable.",
        "JOB_BINDING_CHANGED"
      );
    }
    if (
      job.status !== "running" ||
      job.attempt_count !== command.attemptCount ||
      job.lease_owner !== command.leaseOwner ||
      job.lease_token !== command.leaseToken ||
      job.lease_expires_at_ms !==
        command.leaseExpiresAtMs ||
      job.lease_expires_at_ms <=
        command.executedAtMs ||
      job.started_at_ms !== command.startedAtMs ||
      job.completed_at_ms !== null ||
      job.result_json !== null ||
      job.last_error_code !== null ||
      job.next_attempt_at_ms !== null ||
      job.version !== command.expectedJobVersion
    ) {
      conflict(
        "The FAD deadline job lease, attempt, or version changed.",
        "JOB_LEASE_CHANGED"
      );
    }
    return job;
  }

  function requireBoundRoot(command, { allowTerminal = false } = {}) {
    const root = uniqueRow(
      rootStatement.all(command),
      "The FAD deadline root"
    );
    if (
      !root ||
      root.bound_deadline_job_run_id !== command.runId ||
      root.candidate_deadline_at_ms !==
        command.deadlineAtMs ||
      root.current_competition_first_matchup_week_id === null ||
      (
        allowTerminal
          ? !["cards_open", "deadline_locked"].includes(root.status)
          : root.status !== "cards_open"
      )
    ) {
      conflict(
        "The FAD deadline job lost its sealed aggregate binding.",
        "FAD_BINDING_CHANGED"
      );
    }
    return root;
  }

  function requireSchedule(command, root) {
    const schedule = uniqueRow(
      scheduleStatement.all(command),
      "The current matchup schedule generation"
    );
    if (
      !schedule ||
      schedule.week_one_matchup_week_id !==
        root.current_competition_first_matchup_week_id
    ) {
      conflict(
        "The FAD deadline is not bound to the current competition schedule.",
        "SCHEDULE_BINDING_CHANGED"
      );
    }
    return Object.freeze({
      operationId: schedule.schedule_operation_id,
      version: schedule.schedule_version,
      weekOneMatchupWeekId:
        schedule.week_one_matchup_week_id,
      weekOneStartsAtMs:
        schedule.week_one_starts_at_ms,
    });
  }

  function transitionCommand(command, root) {
    return Object.freeze({
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      expectedVersion: root.version,
      fromStatus: "cards_open",
      toStatus: "deadline_locked",
      occurredAtMs: command.executedAtMs,
      schedule: requireSchedule(command, root),
      scheduleRecoveryPlan: null,
      jobExecution: Object.freeze({
        runId: command.runId,
        jobType: JOB_TYPE,
        occurrenceKey: command.occurrenceKey,
        scheduledForMs: command.scheduledForMs,
        leaseOwner: command.leaseOwner,
        leaseToken: command.leaseToken,
        leaseExpiresAtMs:
          command.leaseExpiresAtMs,
        startedAtMs: command.startedAtMs,
        attemptCount: command.attemptCount,
        expectedVersion:
          command.expectedJobVersion,
      }),
    });
  }

  function requireHookCommand(input) {
    if (
      !isPlainObject(input) ||
      input.toStatus !== "deadline_locked" ||
      input.fromStatus !== "cards_open" ||
      input.scheduleRecoveryPlan !== null ||
      !isPlainObject(input.existing) ||
      !isPlainObject(input.jobExecution)
    ) {
      invalid(
        "The deadline writer requires a cards-open to deadline-locked lifecycle command.",
        "TRANSITION_COMMAND_INVALID"
      );
    }
    const command = normalizeCommand({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      fadId: input.fadId,
      deadlineAtMs:
        input.existing.candidateDeadlineAtMs,
      occurrenceKey:
        input.jobExecution.occurrenceKey,
      scheduledForMs:
        input.jobExecution.scheduledForMs,
      executedAtMs: input.occurredAtMs,
      jobExecution: {
        runId: input.jobExecution.runId,
        leaseOwner:
          input.jobExecution.leaseOwner,
        leaseToken:
          input.jobExecution.leaseToken,
        leaseExpiresAtMs:
          input.jobExecution.leaseExpiresAtMs,
        startedAtMs:
          input.jobExecution.startedAtMs,
        attemptCount:
          input.jobExecution.attemptCount,
        expectedVersion:
          input.jobExecution.expectedVersion,
      },
    });
    if (
      input.jobExecution.jobType !== JOB_TYPE ||
      input.expectedVersion !==
        input.existing.version ||
      input.existing.status !== "cards_open" ||
      input.existing.id !== command.fadId ||
      input.existing.leagueId !== command.leagueId ||
      input.existing.seasonId !== command.seasonId
    ) {
      conflict(
        "The deadline lifecycle witness does not match the current FAD.",
        "TRANSITION_WITNESS_CHANGED"
      );
    }
    return command;
  }

  function snapshotEntryParameters({
    command,
    card,
    evaluation,
    snapshotId,
    rowKind,
    slot,
    source,
  }) {
    const empty = source === null;
    const candidate =
      source?.entry_kind === "candidate";
    return {
      id: deterministicUuid(
        `fad-deadline:snapshot-entry:${snapshotId}:` +
          `${rowKind}:${slot.slotKey}:` +
          `${source?.id || "empty"}`
      ),
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      snapshotId,
      cardId: card.id,
      teamId: card.team_id,
      rowKind,
      occupantKind: empty
        ? "empty"
        : source.entry_kind,
      slotGroup: slot.slotKey.slice(0, 1),
      slotNumber: Number(slot.slotKey.slice(1)),
      sourceEntryId: source?.id ?? null,
      sourceEntryVersion: source?.version ?? null,
      playerId: source?.player_id ?? null,
      effectivePositionGroup:
        source?.effective_position_group ?? null,
      conflictCode:
        rowKind === "conflict"
          ? source.conflict_code
          : null,
      carryoverOwnershipId:
        source?.carryover_ownership_id ?? null,
      carryoverContractId:
        source?.carryover_contract_id ?? null,
      sourceRosterCategory:
        source?.source_roster_category ?? null,
      carryoverOriginalTotalValueCents:
        source?.carryover_original_total_value_cents ?? null,
      carryoverOriginalTermYears:
        source?.carryover_original_term_years ?? null,
      carryoverAavCents:
        source?.carryover_aav_cents ?? null,
      remainingYears: source?.remaining_years ?? null,
      proposedTotalValueCents:
        source?.proposed_total_value_cents ?? null,
      proposedTermYears:
        source?.proposed_term_years ?? null,
      proposedAavCents:
        source?.proposed_aav_cents ?? null,
      eligibilityStatus:
        source?.eligibility_status ?? null,
      validationCode:
        source?.validation_code ?? null,
      lastEditedByUserId:
        source?.last_edited_by_user_id ?? null,
      lastEditedByMembershipId:
        source?.last_edited_by_membership_id ?? null,
      lastEditedByAuthority:
        source?.last_edited_by_authority ?? null,
      lastEditedAtMs: source?.updated_at_ms ?? null,
      executedAtMs: command.executedAtMs,
      allocationEligibility: candidate
        ? evaluation.allocationEligibility
        : null,
      allocationExclusionReason: candidate
        ? evaluation.allocationExclusionReason
        : null,
    };
  }

  function writePublications(command, counts) {
    const activityId = deterministicUuid(
      `fad-deadline:activity:${command.runId}`
    );
    const activityContract =
      createFreeAgentDraftActivityContract({
        eventType:
          "free_agent_draft_cards_published",
        metadata: {
          fadId: command.fadId,
          candidateDeadlineAtMs:
            command.deadlineAtMs,
          cardCount: counts.cardCount,
          allocationCount: counts.allocationCount,
        },
      });
    insertActivityStatement.run({
      ...command,
      activityId,
      metadataJson: serializeCanonicalJsonV1(
        activityContract.metadata
      ),
    });

    const memberRows = membersStatement.all(command);
    const userIds = memberRows.map(
      ({ user_id: userId }) => userId
    );
    if (
      userIds.some(
        (userId) => !UUID_PATTERN.test(userId || "")
      ) ||
      new Set(userIds).size !== userIds.length
    ) {
      incompatible(
        "The deadline notification audience is noncanonical.",
        "NOTIFICATION_AUDIENCE_INVALID"
      );
    }
    const notificationIds = [];
    const notificationPublications = [];
    for (const userId of userIds) {
      const notificationId = deterministicUuid(
        `fad-deadline:notification:${command.fadId}:${userId}`
      );
      const notificationContract =
        createFreeAgentDraftNotificationContract({
          type: "fad_cards_locked",
          recipientUserId: userId,
          messageData: {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            fadId: command.fadId,
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
          createdAtMs: command.executedAtMs,
          deliveredAtMs: null,
          deduplicationKey:
            notificationContract.deduplicationKey,
        }),
        "FAD deadline notification write"
      );
      notificationIds.push(
        inserted.notification.id
      );
      notificationPublications.push({
        notificationId,
        userId,
      });
    }

    const publications = [
      {
        label: "draft",
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: command.fadId,
        version: counts.fadVersion,
        audiences: [{ kind: "league" }],
      },
      {
        label: "activity",
        eventType: "activity.created",
        aggregateType: "league_activity",
        aggregateId: activityId,
        version: 1,
        audiences: [{ kind: "league" }],
      },
      ...notificationPublications.map((publication) => ({
        label: `notification:${publication.notificationId}`,
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: publication.notificationId,
        version: 1,
        audiences: [{
          kind: "user",
          userId: publication.userId,
        }],
      })),
    ];
    const outboxEventIds = [];
    for (const publication of publications) {
      const outboxEventId = deterministicUuid(
        `fad-deadline:outbox:${publication.label}:` +
          (publication.eventType === "notification.created"
            ? command.fadId
            : command.runId)
      );
      assertSynchronous(
        outbox.write({
          id: outboxEventId,
          leagueId: command.leagueId,
          eventType: publication.eventType,
          aggregateType: publication.aggregateType,
          aggregateId: publication.aggregateId,
          payload: createSocketEventMetadata({
            eventType: publication.eventType,
            version: publication.version,
            reasonCode: "cards_published",
            occurredAtMs: command.executedAtMs,
            related: createEmptySocketRelated({
              fadId: command.fadId,
            }),
          }),
          occurredAtMs: command.executedAtMs,
          audiences: publication.audiences,
        }),
        "FAD deadline outbox write"
      );
      outboxEventIds.push(outboxEventId);
    }
    return Object.freeze({
      activityId,
      notificationIds: Object.freeze(notificationIds),
      outboxEventIds: Object.freeze(outboxEventIds),
    });
  }

  function requirePersistedPublications(command, result) {
    const activity = uniqueRow(
      activityEvidenceStatement.all({
        activityId: result.activityId,
      }),
      "The FAD cards-published activity"
    );
    let activityMetadata;
    let activityContract;
    try {
      activityMetadata = activity
        ? parseCanonicalJsonV1(
            activity.metadata_json
          )
        : null;
      activityContract =
        createFreeAgentDraftActivityContract({
          eventType: activity?.event_type,
          metadata: activityMetadata,
        });
    } catch (error) {
      incompatible(
        "The FAD cards-published activity metadata is invalid.",
        "PUBLICATION_ACTIVITY_INVALID",
        error
      );
    }
    if (
      !activity ||
      activity.league_id !== command.leagueId ||
      activity.season_id !== command.seasonId ||
      activity.event_type !==
        "free_agent_draft_cards_published" ||
      activity.actor_user_id !== null ||
      activity.actor_authority !== "system" ||
      activity.team_id !== null ||
      activity.player_id !== null ||
      activity.related_type !== "free_agent_draft" ||
      activity.related_id !== command.fadId ||
      activity.occurred_at_ms !==
        result.processedAtMs ||
      activity.metadata_json !==
        serializeCanonicalJsonV1(
          activityContract.metadata
        ) ||
      activityContract.metadata.fadId !==
        command.fadId ||
      activityContract.metadata.candidateDeadlineAtMs !==
        command.deadlineAtMs ||
      activityContract.metadata.cardCount !==
        result.cardCount ||
      activityContract.metadata.allocationCount !==
        result.allocationCount
    ) {
      incompatible(
        "The FAD cards-published activity is unavailable or noncanonical.",
        "PUBLICATION_ACTIVITY_INVALID"
      );
    }

    const notificationUsers = new Map();
    for (const notificationId of result.notificationIds) {
      const notification = uniqueRow(
        notificationEvidenceStatement.all({
          notificationId,
        }),
        "The FAD cards-locked notification"
      );
      let messageData;
      let notificationContract;
      try {
        messageData = notification
          ? JSON.parse(notification.message_data_json)
          : null;
        notificationContract =
          createFreeAgentDraftNotificationContract({
            type: notification?.event_type,
            recipientUserId:
              notification?.user_id,
            messageData,
          });
      } catch (error) {
        incompatible(
          "A FAD cards-locked notification message is invalid.",
          "PUBLICATION_NOTIFICATION_INVALID",
          error
        );
      }
      if (
        !notification ||
        !UUID_PATTERN.test(notification.user_id || "") ||
        notification.league_id !== command.leagueId ||
        notification.event_type !== "fad_cards_locked" ||
        notification.related_feature !==
          "free_agent_draft" ||
        notification.related_record_id !== command.fadId ||
        notification.created_at_ms !==
          result.processedAtMs ||
        notification.message_data_json !==
          JSON.stringify(
            notificationContract.messageData
          ) ||
        notificationContract.messageData.leagueId !==
          command.leagueId ||
        notificationContract.messageData.seasonId !==
          command.seasonId ||
        notificationContract.messageData.fadId !==
          command.fadId ||
        notification.deduplication_key !==
          notificationContract.deduplicationKey
      ) {
        incompatible(
          "A FAD cards-locked notification is unavailable or noncanonical.",
          "PUBLICATION_NOTIFICATION_INVALID"
        );
      }
      notificationUsers.set(
        notificationId,
        notification.user_id
      );
    }

    const eventTypeCounts = new Map();
    for (const outboxEventId of result.outboxEventIds) {
      const event = uniqueRow(
        outboxEvidenceStatement.all({
          outboxEventId,
        }),
        "The FAD deadline outbox event"
      );
      let payload;
      try {
        payload = event
          ? JSON.parse(event.payload_json)
          : null;
      } catch (error) {
        incompatible(
          "A FAD deadline outbox payload is invalid.",
          "PUBLICATION_OUTBOX_INVALID",
          error
        );
      }
      const isDraft =
        event?.event_type ===
        "free_agent_draft.changed";
      const isActivity =
        event?.event_type === "activity.created";
      const isNotification =
        event?.event_type === "notification.created";
      const expectedVersion = isDraft
        ? result.fadVersion
        : 1;
      const expectedAggregateType = isDraft
        ? "free_agent_draft"
        : isActivity
          ? "league_activity"
          : "notification";
      const expectedAggregateId = isDraft
        ? command.fadId
        : isActivity
          ? result.activityId
          : event?.aggregate_id;
      const expectedUserId = isNotification
        ? notificationUsers.get(event?.aggregate_id)
        : null;
      if (
        !event ||
        event.league_id !== command.leagueId ||
        (!isDraft && !isActivity && !isNotification) ||
        event.aggregate_type !== expectedAggregateType ||
        event.aggregate_id !== expectedAggregateId ||
        event.created_at_ms !== result.processedAtMs ||
        event.audience_count !== 1 ||
        (isNotification
          ? event.league_audience_count !== 0 ||
            event.audience_user_id !== expectedUserId
          : event.league_audience_count !== 1 ||
            event.audience_user_id !== null) ||
        !isPlainObject(payload) ||
        Object.keys(payload).length !== 8 ||
        payload.eventId !== event.id ||
        payload.type !== event.event_type ||
        payload.leagueId !== command.leagueId ||
        payload.resourceId !== event.aggregate_id ||
        payload.version !== expectedVersion ||
        payload.reasonCode !== "cards_published" ||
        payload.occurredAt !== result.processedAtMs ||
        !isPlainObject(payload.related) ||
        Object.keys(payload.related).length !== 8 ||
        payload.related.fadId !== command.fadId ||
        Object.entries(payload.related).some(
          ([key, value]) =>
            key !== "fadId" && value !== null
        )
      ) {
        incompatible(
          "A FAD deadline outbox event is unavailable or noncanonical.",
          "PUBLICATION_OUTBOX_INVALID"
        );
      }
      eventTypeCounts.set(
        event.event_type,
        (eventTypeCounts.get(event.event_type) || 0) + 1
      );
    }
    if (
      eventTypeCounts.get("free_agent_draft.changed") !== 1 ||
      eventTypeCounts.get("activity.created") !== 1 ||
      (eventTypeCounts.get("notification.created") || 0) !==
        result.notificationIds.length
    ) {
      incompatible(
        "The exact FAD deadline publication event set is incomplete.",
        "PUBLICATION_OUTBOX_INVALID"
      );
    }
  }

  function beforeTransition(input) {
    if (database.inTransaction !== true) {
      invalid(
        "FAD deadline publication requires the lifecycle transaction.",
        "TRANSACTION_REQUIRED"
      );
    }
    const command = requireHookCommand(input);
    const job = requireLiveJob(command);
    const root = requireBoundRoot(command);
    if (
      root.version !== input.expectedVersion ||
      root.updated_at_ms > command.executedAtMs
    ) {
      conflict(
        "The FAD deadline root changed before publication.",
        "FAD_VERSION_CHANGED"
      );
    }

    const reconciliation = assertSynchronous(
      eligibilityDeadlineReconciler
        .reconcileInCurrentTransaction({
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          fadId: command.fadId,
          deadlineOperationId: command.runId,
          nowMs: command.executedAtMs,
        }),
      "FAD deadline eligibility reconciliation"
    );
    if (
      !isPlainObject(reconciliation) ||
      reconciliation.outcome !==
        "deadline_reconciled" ||
      reconciliation.leagueId !== command.leagueId ||
      reconciliation.seasonId !== command.seasonId ||
      reconciliation.fadId !== command.fadId ||
      reconciliation.deadlineOperationId !==
        command.runId
    ) {
      incompatible(
        "The final deadline reconciliation result is invalid.",
        "DEADLINE_RECONCILIATION_INVALID"
      );
    }

    const cards = cardsStatement.all(command);
    if (
      !Number.isSafeInteger(
        root.participating_team_count
      ) ||
      root.participating_team_count < 1 ||
      cards.length !== root.participating_team_count ||
      cards.some(
        (card) =>
          !UUID_PATTERN.test(card.id || "") ||
          !UUID_PATTERN.test(card.team_id || "") ||
          card.status !== "open"
      ) ||
      new Set(cards.map(({ id }) => id)).size !==
        cards.length ||
      new Set(
        cards.map(({ team_id: teamId }) => teamId)
      ).size !== cards.length
    ) {
      incompatible(
        "The deadline lost exact participant/card coverage.",
        "CARD_COVERAGE_INVALID"
      );
    }

    const lockedCardPlans = [];
    for (const card of cards) {
      const rows = entriesStatement.all({
        ...command,
        cardId: card.id,
        teamId: card.team_id,
      });
      const entries = rows.map(mapEntry);
      const cap = assertSynchronous(
        capReader.calculate({
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          teamId: card.team_id,
        }),
        "FAD deadline cap read"
      );
      if (!cap || cap.complete !== true) {
        conflict(
          "Candidate Card cap evidence is incomplete at the deadline.",
          "CANDIDATE_CAP_STATE_INCOMPLETE"
        );
      }
      let evaluation;
      try {
        evaluation = evaluateCandidateCard({
          capLimitCents: cap.capLimitCents,
          carriedActivePlayerAmountCents:
            cap.breakdown.activePlayerCents,
          retentionObligationCents:
            cap.breakdown.retentionCents,
          buyoutPenaltyCents:
            cap.breakdown.buyoutCents,
          entries: entries.map(domainEntry),
        });
      } catch (error) {
        incompatible(
          "A Candidate Card cannot be evaluated at the deadline.",
          "CANDIDATE_CARD_POLICY_INVALID",
          error
        );
      }

      const lockedCardVersion = card.version + 1;
      const cardParameters = {
        ...command,
        cardId: card.id,
        teamId: card.team_id,
        expectedCardVersion: card.version,
        lockedCardVersion,
        lockedStatus: evaluation.lockedStatus,
        completenessCode:
          evaluation.completeness.code,
        filledMandatoryCount:
          evaluation.completeness.filledMandatory,
        missingMandatoryCount:
          evaluation.completeness.missingMandatory,
        filledBenchCount:
          evaluation.completeness.filledBench,
        emptyBenchCount:
          evaluation.completeness.emptyBench,
        blockingValidationCount:
          evaluation.completeness
            .blockingValidationCount,
        structuralConflictCount:
          evaluation.completeness
            .structuralConflictCount,
        carriedRosterStructuralConflictCount:
          evaluation.completeness
            .carriedRosterStructuralConflictCount,
        maximumPossibleCapCents:
          evaluation.capProjection
            .maximumPossibleCapCents,
        capStatus: evaluation.capStatus,
        allocationEligibility:
          evaluation.allocationEligibility,
        allocationExclusionReason:
          evaluation.allocationExclusionReason,
      };
      if (
        updateCardStatement.run(cardParameters).changes !== 1
      ) {
        conflict(
          "A Candidate Card changed before deadline locking.",
          "CANDIDATE_CARD_VERSION_CHANGED"
        );
      }
      const revisionId = deterministicUuid(
        `fad-deadline:revision:${command.runId}:${card.id}`
      );
      if (
        insertRevisionStatement.run({
          ...cardParameters,
          revisionId,
          beforeEvidenceJson:
            serializeCanonicalJsonV1({
              cardId: card.id,
              cardVersion: card.version,
              status: card.status,
            }),
          afterEvidenceJson:
            serializeCanonicalJsonV1({
              allocationEligibility:
                evaluation.allocationEligibility,
              cardId: card.id,
              cardVersion: lockedCardVersion,
              capStatus: evaluation.capStatus,
              completenessCode:
                evaluation.completeness.code,
              deadlineOperationId: command.runId,
              lockedStatus: evaluation.lockedStatus,
            }),
          warningCodesJson:
            serializeCanonicalJsonV1(
              warningCodes(evaluation)
            ),
        }).changes !== 1
      ) {
        conflict(
          "The Candidate Card deadline revision could not be recorded.",
          "CANDIDATE_CARD_REVISION_FAILED"
        );
      }

      lockedCardPlans.push(
        Object.freeze({
          card,
          rows: Object.freeze([...rows]),
          evaluation,
          cardParameters: Object.freeze({
            ...cardParameters,
          }),
        })
      );
    }

    expireHelpStatement.run(command);

    const snapshotCandidatePlayerIds = new Set();
    for (const plan of lockedCardPlans) {
      const {
        card,
        rows,
        evaluation,
        cardParameters,
      } = plan;
      const snapshotId = deterministicUuid(
        `fad-deadline:snapshot:${command.fadId}:${card.id}`
      );
      if (
        insertSnapshotStatement.run({
          ...cardParameters,
          snapshotId,
          capLimitCents:
            evaluation.capProjection.capLimitCents,
          carriedActivePlayerAmountCents:
            evaluation.capProjection
              .carriedActivePlayerAmountCents,
          retentionObligationCents:
            evaluation.capProjection
              .retentionObligationCents,
          buyoutPenaltyCents:
            evaluation.capProjection
              .buyoutPenaltyCents,
          carriedCapUsageCents:
            evaluation.capProjection
              .carriedCapUsageCents,
          proposedCandidateAavCents:
            evaluation.capProjection
              .proposedCandidateAavCents,
          maximumCapSpaceCents:
            evaluation.capProjection
              .maximumCapSpaceCents,
        }).changes !== 1
      ) {
        conflict(
          "The immutable Candidate Card snapshot could not be recorded.",
          "CANDIDATE_CARD_SNAPSHOT_FAILED"
        );
      }

      const rowById = new Map(
        rows.map((row) => [row.id, row])
      );
      for (const slot of evaluation.slots) {
        const source = slot.occupantEntryId === null
          ? null
          : rowById.get(slot.occupantEntryId);
        if (
          slot.occupantEntryId !== null &&
          !source
        ) {
          incompatible(
            "A Candidate Card slot lost its source entry.",
            "SNAPSHOT_SOURCE_MISSING"
          );
        }
        insertSnapshotEntryStatement.run(
          snapshotEntryParameters({
            command,
            card,
            evaluation,
            snapshotId,
            rowKind: "slot",
            slot,
            source,
          })
        );
        if (source?.entry_kind === "candidate") {
          snapshotCandidatePlayerIds.add(
            source.player_id
          );
        }
      }
      for (const conflictEntry of evaluation.conflicts) {
        const source = rowById.get(
          conflictEntry.entryId
        );
        if (!source) {
          incompatible(
            "A Candidate Card conflict lost its source entry.",
            "SNAPSHOT_CONFLICT_SOURCE_MISSING"
          );
        }
        insertSnapshotEntryStatement.run(
          snapshotEntryParameters({
            command,
            card,
            evaluation,
            snapshotId,
            rowKind: "conflict",
            slot: {
              slotKey: conflictEntry.slotKey,
            },
            source,
          })
        );
        if (source.entry_kind === "candidate") {
          snapshotCandidatePlayerIds.add(
            source.player_id
          );
        }
      }
    }

    for (const playerId of [
      ...snapshotCandidatePlayerIds,
    ].sort()) {
      const allocationId = deterministicUuid(
        `fad-deadline:allocation:${command.fadId}:${playerId}`
      );
      insertAllocationStatement.run({
        ...command,
        allocationId,
        playerId,
      });
      const allocationOccurrenceKey =
        buildFreeAgentDraftAllocationOccurrenceKey({
          fadId: command.fadId,
          playerId,
        });
      insertAllocationJobStatement.run({
        ...command,
        allocationJobRunId: deterministicUuid(
          `fad-deadline:allocation-job:${command.fadId}:${playerId}`
        ),
        allocationOccurrenceKey,
      });
    }

    const evidence = resultEvidenceStatement.get(command);
    if (
      !evidence ||
      evidence.card_count !== cards.length ||
      evidence.locked_card_count !== cards.length ||
      evidence.active_help_count !== 0 ||
      evidence.candidate_player_count !==
        snapshotCandidatePlayerIds.size ||
      evidence.allocation_count !==
        snapshotCandidatePlayerIds.size
    ) {
      conflict(
        "The complete Candidate Card publication evidence is not ready.",
        "DEADLINE_EVIDENCE_INCOMPLETE"
      );
    }
    return Object.freeze({
      deadlineOperationId: command.runId,
      cardCount: cards.length,
      allocationCount:
        snapshotCandidatePlayerIds.size,
      reconciledJobAttempt: job.attempt_count,
    });
  }

  function afterTransition(input) {
    if (database.inTransaction !== true) {
      invalid(
        "FAD deadline completion requires the lifecycle transaction.",
        "TRANSACTION_REQUIRED"
      );
    }
    if (
      !isPlainObject(input) ||
      !isPlainObject(input.effectiveCommand) ||
      !isPlainObject(input.existing) ||
      !isPlainObject(input.updated)
    ) {
      invalid(
        "An exact FAD deadline post-transition witness is required.",
        "POST_TRANSITION_INPUT_INVALID"
      );
    }
    const command = requireHookCommand({
      ...input.effectiveCommand,
      existing: input.existing,
    });
    if (
      input.updated.id !== command.fadId ||
      input.updated.status !== "deadline_locked" ||
      input.updated.version !== input.existing.version + 1 ||
      input.updated.deadlineLockedAtMs !==
        command.executedAtMs
    ) {
      incompatible(
        "The transitioned FAD deadline root is noncanonical.",
        "POST_TRANSITION_ROOT_INVALID"
      );
    }
    requireLiveJob(command);
    const evidence = resultEvidenceStatement.get(command);
    if (
      !evidence ||
      evidence.card_count !==
        input.existing.participatingTeamCount ||
      evidence.locked_card_count !==
        evidence.card_count ||
      evidence.active_help_count !== 0 ||
      evidence.candidate_player_count !==
        evidence.allocation_count
    ) {
      incompatible(
        "The committed FAD deadline publication evidence is incomplete.",
        "POST_TRANSITION_EVIDENCE_INVALID"
      );
    }
    const publications = writePublications(command, {
      cardCount: evidence.card_count,
      allocationCount: evidence.allocation_count,
      fadVersion: input.updated.version,
    });
    const result = requireDeadlineResult({
      schemaVersion: 1,
      code: "FAD_DEADLINE_PUBLISHED",
      fadId: command.fadId,
      deadlineAtMs: command.deadlineAtMs,
      processedAtMs: command.executedAtMs,
      fadVersion: input.updated.version,
      cardCount: evidence.card_count,
      candidatePlayerCount:
        evidence.candidate_player_count,
      allocationCount: evidence.allocation_count,
      activityId: publications.activityId,
      notificationIds:
        publications.notificationIds,
      outboxEventIds:
        publications.outboxEventIds,
    });
    requirePersistedPublications(command, result);
    const resultJson =
      serializeCanonicalJsonV1(result);
    if (
      terminalJobStatement.run({
        ...command,
        resultJson,
      }).changes !== 1
    ) {
      conflict(
        "The FAD deadline job lease or version changed before completion.",
        "JOB_TERMINAL_CAS_FAILED"
      );
    }
    if (beforeCommit) {
      assertSynchronous(
        beforeCommit(
          Object.freeze({
            command,
            existing: input.existing,
            updated: input.updated,
            result,
          })
        ),
        "FAD deadline beforeCommit"
      );
    }
    return result;
  }

  const executeTransaction = database.transaction(
    (command, lifecycleRepository) => {
      if (
        !lifecycleRepository ||
        typeof lifecycleRepository.advanceStatus !==
          "function"
      ) {
        throw new TypeError(
          "FAD deadline execution requires the lifecycle repository"
        );
      }
      const root = requireBoundRoot(command, {
        allowTerminal: true,
      });
      const job = uniqueRow(
        jobStatement.all(command),
        "The FAD deadline job"
      );
      if (
        root.status === "deadline_locked" &&
        job?.status === "succeeded" &&
        job.version === command.expectedJobVersion + 1 &&
        job.completed_at_ms !== null &&
        job.result_json !== null
      ) {
        let persisted;
        try {
          persisted = parseCanonicalJsonV1(
            job.result_json
          );
        } catch (error) {
          incompatible(
            "The succeeded FAD deadline job result is unreadable.",
            "DEADLINE_RESULT_INVALID",
            error
          );
        }
        const result = requireDeadlineResult(persisted);
        if (
          result.fadId !== command.fadId ||
          result.deadlineAtMs !==
            command.deadlineAtMs ||
          result.processedAtMs !==
            job.completed_at_ms ||
          result.fadVersion !== root.version
        ) {
          incompatible(
            "The succeeded FAD deadline job result lost its root binding.",
            "DEADLINE_REPLAY_INVALID"
          );
        }
        requirePersistedPublications(command, result);
        return terminalProjection({
          command,
          result,
          replayed: true,
        });
      }
      requireLiveJob(command);
      if (root.status !== "cards_open") {
        conflict(
          "The FAD Candidate Cards are no longer open.",
          "FAD_NOT_CARDS_OPEN"
        );
      }
      const transitionResult = assertSynchronous(
        lifecycleRepository.advanceStatus(
          transitionCommand(command, root)
        ),
        "FAD deadline lifecycle transition"
      );
      if (
        !isPlainObject(transitionResult) ||
        transitionResult.replayed !== false ||
        !isPlainObject(transitionResult.draft) ||
        transitionResult.draft.id !== command.fadId ||
        transitionResult.draft.status !==
          "deadline_locked" ||
        transitionResult.draft.version !== root.version + 1
      ) {
        incompatible(
          "The FAD lifecycle repository returned a noncanonical deadline transition.",
          "LIFECYCLE_RESULT_INVALID"
        );
      }
      const terminal = uniqueRow(
        jobStatement.all(command),
        "The completed FAD deadline job"
      );
      if (
        !terminal ||
        terminal.status !== "succeeded" ||
        terminal.attempt_count !== command.attemptCount ||
        terminal.lease_owner !== null ||
        terminal.lease_token !== null ||
        terminal.lease_expires_at_ms !== null ||
        terminal.started_at_ms !== command.startedAtMs ||
        terminal.completed_at_ms !== command.executedAtMs ||
        terminal.last_error_code !== null ||
        terminal.next_attempt_at_ms !== null ||
        terminal.updated_at_ms !== command.executedAtMs ||
        terminal.version !== command.expectedJobVersion + 1 ||
        terminal.result_json === null
      ) {
        incompatible(
          "The completed FAD deadline job is noncanonical.",
          "JOB_TERMINAL_STATE_INVALID"
        );
      }
      let persisted;
      try {
        persisted = parseCanonicalJsonV1(
          terminal.result_json
        );
      } catch (error) {
        incompatible(
          "The completed FAD deadline result is unreadable.",
          "DEADLINE_RESULT_INVALID",
          error
        );
      }
      const result = requireDeadlineResult(persisted);
      return terminalProjection({
        command,
        result,
        replayed: false,
      });
    }
  );

  return Object.freeze({
    beforeTransition,
    afterTransition,
    executeClaimed(input = {}, lifecycleRepository) {
      const command = normalizeCommand(input);
      try {
        return executeTransaction.immediate(
          command,
          lifecycleRepository
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "executeClaimedFreeAgentDraftDeadline",
          tableName: "job_runs",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_DEADLINE_JOB_TYPE: JOB_TYPE,
  createSqliteFreeAgentDraftDeadlineWriter,
};
