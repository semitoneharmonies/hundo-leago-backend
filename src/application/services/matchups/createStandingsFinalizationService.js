const crypto = require("node:crypto");

const {
  calculateStandings,
} = require("../../../domain/matchups/matchupStandingsPolicy");
const {
  FORBIDDEN_TEXT_PATTERN,
  RESULT_SET_HASH_PATTERN,
  STANDINGS_FINALIZATION_CODES,
  StandingsFinalizationPolicyError,
  UUID_PATTERN,
  calculateStandingsResultSetHash,
  validateStandingsFinalizationExpectedVersion,
  validateStandingsFinalizationIdempotencyKey,
  validateStandingsFinalizationInput,
  validateStandingsFinalizationLeagueId,
  validateStandingsFinalizationSeasonId,
} = require(
  "../../../domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  COLOUR_PATTERN,
  MAXIMUM_LOGO_BYTES,
  MAXIMUM_LOGO_DIMENSION,
  SUPPORTED_LOGO_MEDIA_TYPES,
} = require("../../../domain/leagues/teamProfilePolicy");
const {
  teamPatternColourCount,
} = require("../../../domain/leagues/teamPatternPolicy");
const {
  addLocalDays,
  firstEligibleMonday,
} = require("../../../domain/matchups/matchupSchedulePolicy");

const STANDINGS_FINALIZATION_OPERATION =
  "standings.finalize_regular_season.v1";
const STANDINGS_FINALIZATION_RESULT_TYPE =
  "standings_finalization";
const STANDINGS_FINALIZATION_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1000;
const FINALIZATION_AUDIT_EVENT_TYPE =
  "standings.regular_season_finalized";
const VALID_LEAGUE_STATUSES = new Set([
  "active",
  "frozen",
]);
const VALID_RESULT_STATUSES = new Set([
  "official",
  "corrected",
]);
const VALID_RESULT_SOURCE_TYPES = new Set([
  "calculated",
  "correction",
]);
const VALID_LOGO_MEDIA_TYPES = new Set(
  SUPPORTED_LOGO_MEDIA_TYPES
);

class StandingsFinalizationServiceError extends Error {
  constructor(code, { details, reasonCode } = {}) {
    super(
      "The regular-season standings cannot be finalized."
    );
    this.name = "StandingsFinalizationServiceError";
    this.code = code;
    if (reasonCode !== undefined) {
      this.reasonCode = reasonCode;
    }
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function fail(code, options) {
  throw new StandingsFinalizationServiceError(
    code,
    options
  );
}

function failNotReady(reasonCode) {
  fail(
    STANDINGS_FINALIZATION_CODES.notReady,
    { reasonCode }
  );
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `standings finalization requires ${description}`
    );
  }
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    throw new TypeError(
      "standings finalization requires a safe UTC timestamp"
    );
  }
  return nowMs;
}

function createSecureIdFactory(secureRandom) {
  const generated = new Set();
  return function secureId() {
    const id = secureRandom.id();
    if (
      typeof id !== "string" ||
      !UUID_PATTERN.test(id) ||
      generated.has(id)
    ) {
      throw new TypeError(
        "standings finalization requires unique canonical secure identifiers"
      );
    }
    generated.add(id);
    return id;
  };
}

function standingsFinalizationRequestHash({
  leagueId,
  seasonId,
  expectedSeasonVersion,
  resultSetHash,
  confirmation,
}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        confirmation,
        expectedSeasonVersion,
        leagueId,
        operation:
          STANDINGS_FINALIZATION_OPERATION,
        resultSetHash,
        seasonId,
      }),
      "utf8"
    )
    .digest("hex");
}

function internalResult(result, replayed) {
  const copy = { ...result };
  Object.defineProperty(copy, "replayed", {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false,
  });
  return Object.freeze(copy);
}

function safeFinalizationResult(row) {
  if (
    !row ||
    !UUID_PATTERN.test(row.operation_id || "") ||
    !UUID_PATTERN.test(row.snapshot_id || "") ||
    !UUID_PATTERN.test(row.league_id || "") ||
    !UUID_PATTERN.test(row.season_id || "") ||
    !Number.isSafeInteger(row.snapshot_version) ||
    row.snapshot_version < 1 ||
    !Number.isSafeInteger(row.season_version) ||
    row.season_version < 2 ||
    !Number.isSafeInteger(
      row.standings_rule_version
    ) ||
    row.standings_rule_version < 1 ||
    !RESULT_SET_HASH_PATTERN.test(
      row.result_set_hash || ""
    ) ||
    !Number.isSafeInteger(
      row.expected_matchup_count
    ) ||
    row.expected_matchup_count < 1 ||
    row.included_result_count !==
      row.expected_matchup_count ||
    !Number.isSafeInteger(row.participant_count) ||
    row.participant_count < 2 ||
    !Number.isSafeInteger(row.finalized_at_ms) ||
    row.finalized_at_ms < 0
  ) {
    fail("STANDINGS_FINALIZATION_RESULT_UNAVAILABLE");
  }

  return Object.freeze({
    code: "STANDINGS_FINALIZED",
    finalization: Object.freeze({
      operationId: row.operation_id,
      snapshotId: row.snapshot_id,
      snapshotVersion: row.snapshot_version,
      leagueId: row.league_id,
      seasonId: row.season_id,
      seasonVersion: row.season_version,
      standingsRuleVersion:
        row.standings_rule_version,
      resultSetHash: row.result_set_hash,
      expectedMatchupCount:
        row.expected_matchup_count,
      includedResultCount:
        row.included_result_count,
      participantCount: row.participant_count,
      finalizedAtMs: row.finalized_at_ms,
    }),
  });
}

function canonicalActorAuthority(authority) {
  if (
    !UUID_PATTERN.test(authority?.actorUserId || "") ||
    !UUID_PATTERN.test(authority?.membershipId || "")
  ) {
    fail("LEAGUE_COMMISSIONER_REQUIRED");
  }
  if (authority.authority === "commissioner") {
    return "commissioner";
  }
  if (
    authority.authority ===
      "platform_administrator" ||
    authority.authority ===
      "platform_administrator_as_commissioner"
  ) {
    return "platform_administrator_as_commissioner";
  }
  fail("LEAGUE_COMMISSIONER_REQUIRED");
}

function isSafeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function inspectAggregate(
  aggregate,
  {
    leagueId,
    seasonId,
    expectedSeasonVersion,
  }
) {
  if (
    !aggregate ||
    aggregate.league_id !== leagueId ||
    aggregate.season_id !== seasonId
  ) {
    fail("STANDINGS_FINALIZATION_NOT_FOUND");
  }
  if (
    aggregate.season_version !==
    expectedSeasonVersion
  ) {
    fail(
      "STANDINGS_FINALIZATION_PRECONDITION_FAILED",
      {
        details: {
          currentVersion:
            Number.isSafeInteger(
              aggregate.season_version
            )
              ? aggregate.season_version
              : null,
          refetch: true,
        },
      }
    );
  }
  if (
    !VALID_LEAGUE_STATUSES.has(
      aggregate.league_status
    ) ||
    aggregate.current_season_id !== seasonId ||
    aggregate.season_status !== "active" ||
    !isSafeTimestamp(
      aggregate.regular_season_starts_at_ms
    ) ||
    !isSafeTimestamp(
      aggregate.fantasy_playoffs_start_at_ms
    ) ||
    aggregate.regular_season_starts_at_ms >=
      aggregate.fantasy_playoffs_start_at_ms ||
    typeof aggregate.league_timezone !== "string" ||
    aggregate.league_timezone.length < 1 ||
    aggregate.league_timezone.length > 120 ||
    aggregate.league_timezone !==
      aggregate.league_timezone.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(
      aggregate.league_timezone
    ) ||
    !Number.isSafeInteger(
      aggregate.standings_rule_version
    ) ||
    aggregate.standings_rule_version < 1 ||
    !Number.isSafeInteger(
      aggregate.scoring_rule_version
    ) ||
    aggregate.scoring_rule_version < 1
  ) {
    failNotReady("season_not_ready");
  }
}

function inspectScheduleGeneration(
  scheduleOperations,
  scheduleGenerations,
  scheduleCommandResults,
  scheduleRecoveries,
  {
    leagueId,
    seasonId,
    participantIds,
    weekCount,
    matchupCount,
    firstWeekId,
    firstWeekStartsAtMs,
    nowMs,
  }
) {
  if (
    !Array.isArray(scheduleOperations) ||
    !Array.isArray(scheduleGenerations) ||
    !Array.isArray(scheduleCommandResults) ||
    !Array.isArray(scheduleRecoveries)
  ) {
    failNotReady("schedule_generation_evidence_invalid");
  }
  const succeeded = scheduleOperations.filter(
    (operation) =>
      operation?.operation_status === "succeeded"
  );
  if (
    succeeded.length < 1 ||
    succeeded.length !== scheduleGenerations.length
  ) {
    failNotReady("schedule_generation_evidence_invalid");
  }

  const exactKeys = (value, expected) => {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (
      actual.length === sortedExpected.length &&
      actual.every(
        (key, index) => key === sortedExpected[index]
      )
    );
  };
  const parseMetadata = (operation) => {
    if (
      typeof operation.metadata_json !== "string" ||
      operation.metadata_json.length < 2 ||
      operation.metadata_json.length > 16_384
    ) {
      failNotReady("schedule_generation_evidence_invalid");
    }
    let metadata;
    try {
      metadata = JSON.parse(operation.metadata_json);
    } catch {
      failNotReady("schedule_generation_evidence_invalid");
    }
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      JSON.stringify(metadata) !== operation.metadata_json
    ) {
      failNotReady("schedule_generation_evidence_invalid");
    }
    return metadata;
  };
  const expectedParticipantIds =
    participantIds instanceof Set
      ? [...participantIds].sort()
      : null;
  const validParticipantIds = (ids) =>
    expectedParticipantIds !== null &&
    Array.isArray(ids) &&
    ids.length === expectedParticipantIds.length &&
    ids.every(
      (teamId, index) =>
        UUID_PATTERN.test(teamId || "") &&
        teamId === expectedParticipantIds[index]
    );
  const operationById = new Map();
  for (const operation of succeeded) {
    if (
      operation?.operation_league_id !== leagueId ||
      operation.operation_season_id !== seasonId ||
      !UUID_PATTERN.test(operation.schedule_operation_id || "") ||
      operationById.has(operation.schedule_operation_id) ||
      operation.operation_matchup_week_id !== null ||
      operation.operation_matchup_id !== null ||
      !isSafeTimestamp(operation.started_at_ms) ||
      !isSafeTimestamp(operation.completed_at_ms) ||
      operation.completed_at_ms < operation.started_at_ms ||
      operation.started_at_ms > nowMs ||
      operation.completed_at_ms > nowMs
    ) {
      failNotReady("schedule_generation_evidence_invalid");
    }
    operationById.set(operation.schedule_operation_id, operation);
  }

  const generations = [...scheduleGenerations].sort(
    (left, right) =>
      left.schedule_version - right.schedule_version
  );
  const current = generations.filter(
    (generation) => generation?.generation_status === "current"
  );
  if (current.length !== 1) {
    failNotReady("schedule_generation_evidence_invalid");
  }

  const commandRowsByOperation = new Map();
  for (const command of scheduleCommandResults) {
    const operationId = command?.command_new_schedule_operation_id;
    if (
      command.command_league_id !== leagueId ||
      command.command_season_id !== seasonId ||
      !UUID_PATTERN.test(command.command_result_id || "") ||
      !UUID_PATTERN.test(operationId || "") ||
      !operationById.has(operationId) ||
      command.command_version !== 1
    ) {
      failNotReady("schedule_generation_evidence_invalid");
    }
    const rows = commandRowsByOperation.get(operationId) || [];
    rows.push(command);
    commandRowsByOperation.set(operationId, rows);
  }
  const recoveryRowsByOperation = new Map();
  for (const recovery of scheduleRecoveries) {
    const operationId = recovery?.recovery_new_schedule_operation_id;
    if (
      recovery.recovery_league_id !== leagueId ||
      recovery.recovery_season_id !== seasonId ||
      !UUID_PATTERN.test(recovery.recovery_id || "") ||
      !UUID_PATTERN.test(operationId || "") ||
      !operationById.has(operationId) ||
      recovery.recovery_version !== 1 ||
      recovery.recovery_evidence_schema_version !== 1 ||
      !RESULT_SET_HASH_PATTERN.test(
        recovery.recovery_evidence_sha256 || ""
      )
    ) {
      failNotReady("schedule_generation_evidence_invalid");
    }
    const rows = recoveryRowsByOperation.get(operationId) || [];
    rows.push(recovery);
    recoveryRowsByOperation.set(operationId, rows);
  }

  for (const [index, generation] of generations.entries()) {
    const operation = operationById.get(
      generation?.schedule_operation_id
    );
    const previous = generations[index - 1] || null;
    const isCurrent = generation.generation_status === "current";
    if (
      generation.generation_league_id !== leagueId ||
      generation.generation_season_id !== seasonId ||
      generation.schedule_version !== index + 1 ||
      !UUID_PATTERN.test(generation.schedule_operation_id || "") ||
      !UUID_PATTERN.test(generation.week_one_matchup_week_id || "") ||
      !isSafeTimestamp(generation.week_one_starts_at_ms) ||
      !isSafeTimestamp(generation.generation_created_at_ms) ||
      generation.generation_created_at_ms > nowMs ||
      !operation ||
      operation.completed_at_ms !== generation.generation_created_at_ms ||
      (
        isCurrent
          ? generation.generation_superseded_at_ms !== null ||
            generation.generation_version !== 1 ||
            index !== generations.length - 1 ||
            generation.week_one_matchup_week_id !== firstWeekId ||
            generation.week_one_starts_at_ms !== firstWeekStartsAtMs
          : generation.generation_status !== "superseded" ||
            !isSafeTimestamp(
              generation.generation_superseded_at_ms
            ) ||
            generation.generation_version !== 2 ||
            generation.generation_superseded_at_ms > nowMs ||
            generations[index + 1]?.generation_created_at_ms !==
              generation.generation_superseded_at_ms
      )
    ) {
      failNotReady("schedule_generation_evidence_invalid");
    }

    const metadata = parseMetadata(operation);
    const commands =
      commandRowsByOperation.get(generation.schedule_operation_id) || [];
    const recoveries =
      recoveryRowsByOperation.get(generation.schedule_operation_id) || [];

    if (generation.schedule_version === 1) {
      const requiredKeys = [
        "matchupCount",
        "participantCount",
        "participantTeamIds",
        "weekCount",
      ];
      const accepted =
        exactKeys(metadata, requiredKeys) ||
        exactKeys(metadata, ["jobOccurrenceCount", ...requiredKeys]);
      if (
        !accepted ||
        !UUID_PATTERN.test(operation.actor_user_id || "") ||
        operation.reason !== null ||
        !Number.isSafeInteger(metadata.participantCount) ||
        metadata.participantCount !== expectedParticipantIds?.length ||
        !validParticipantIds(metadata.participantTeamIds) ||
        !Number.isSafeInteger(metadata.weekCount) ||
        metadata.weekCount < 1 ||
        !Number.isSafeInteger(metadata.matchupCount) ||
        metadata.matchupCount < 1 ||
        (
          Object.hasOwn(metadata, "jobOccurrenceCount") &&
          (
            !Number.isSafeInteger(metadata.jobOccurrenceCount) ||
            metadata.jobOccurrenceCount < 0
          )
        ) ||
        (isCurrent && metadata.weekCount !== weekCount) ||
        (isCurrent && metadata.matchupCount !== matchupCount) ||
        recoveries.length !== 0 ||
        commands.length > 1
      ) {
        failNotReady("schedule_generation_evidence_invalid");
      }
      if (commands.length === 1) {
        const command = commands[0];
        if (
          command.command_action !== "generate" ||
          command.command_matchup_operation_id !== operation.schedule_operation_id ||
          command.command_actor_user_id !== operation.actor_user_id ||
          command.command_old_schedule_operation_id !== null ||
          command.command_old_schedule_version !== null ||
          command.command_new_schedule_version !== 1 ||
          command.command_week_one_matchup_week_id !==
            generation.week_one_matchup_week_id ||
          command.command_previous_first_week_starts_at_ms !== null ||
          command.command_first_week_starts_at_ms !==
            generation.week_one_starts_at_ms ||
          command.command_shifted_week_count !== null ||
          command.command_replaced_job_occurrence_count !== null ||
          command.command_created_at_ms !== operation.completed_at_ms
        ) {
          failNotReady("schedule_generation_evidence_invalid");
        }
      }
      continue;
    }

    if (commands.length === 1 && recoveries.length === 0) {
      const command = commands[0];
      const shiftKeys = [
        "action",
        "firstWeekStartsAtMs",
        "newScheduleVersion",
        "oldScheduleOperationId",
        "oldScheduleVersion",
        "participantTeamIds",
        "previousFirstWeekStartsAtMs",
        "replacedJobOccurrenceCount",
        "responseSha256",
        "shiftedWeekCount",
      ];
      if (
        !previous ||
        !exactKeys(metadata, shiftKeys) ||
        !UUID_PATTERN.test(operation.actor_user_id || "") ||
        operation.reason !== null ||
        command.command_action !== "shift_week_one" ||
        command.command_matchup_operation_id !== operation.schedule_operation_id ||
        command.command_actor_user_id !== operation.actor_user_id ||
        command.command_old_schedule_operation_id !== previous.schedule_operation_id ||
        command.command_old_schedule_version !== previous.schedule_version ||
        command.command_new_schedule_version !== generation.schedule_version ||
        previous.week_one_matchup_week_id !==
          generation.week_one_matchup_week_id ||
        command.command_week_one_matchup_week_id !== generation.week_one_matchup_week_id ||
        command.command_previous_first_week_starts_at_ms !== previous.week_one_starts_at_ms ||
        command.command_first_week_starts_at_ms !== generation.week_one_starts_at_ms ||
        !Number.isSafeInteger(command.command_shifted_week_count) ||
        command.command_shifted_week_count < 1 ||
        !Number.isSafeInteger(command.command_replaced_job_occurrence_count) ||
        command.command_replaced_job_occurrence_count < 0 ||
        command.command_created_at_ms !== operation.completed_at_ms ||
        metadata.action !== "shift_week_one" ||
        metadata.oldScheduleOperationId !== previous.schedule_operation_id ||
        metadata.oldScheduleVersion !== previous.schedule_version ||
        metadata.newScheduleVersion !== generation.schedule_version ||
        metadata.previousFirstWeekStartsAtMs !== previous.week_one_starts_at_ms ||
        metadata.firstWeekStartsAtMs !== generation.week_one_starts_at_ms ||
        metadata.shiftedWeekCount !== command.command_shifted_week_count ||
        metadata.replacedJobOccurrenceCount !==
          command.command_replaced_job_occurrence_count ||
        !validParticipantIds(metadata.participantTeamIds) ||
        !RESULT_SET_HASH_PATTERN.test(metadata.responseSha256 || "")
      ) {
        failNotReady("schedule_generation_evidence_invalid");
      }
      continue;
    }

    if (commands.length === 0 && recoveries.length === 1) {
      const recovery = recoveries[0];
      const recoveryKeys = [
        "fadId",
        "newScheduleVersion",
        "oldScheduleOperationId",
        "oldScheduleVersion",
        "recoveryId",
        "recoveryKind",
      ];
      if (
        !previous ||
        !exactKeys(metadata, recoveryKeys) ||
        operation.actor_user_id !== null ||
        !["pre_open", "completion"].includes(recovery.recovery_kind) ||
        operation.reason !== `fad_${recovery.recovery_kind}_schedule_recovery` ||
        recovery.recovery_matchup_operation_id !== operation.schedule_operation_id ||
        recovery.recovery_old_schedule_operation_id !== previous.schedule_operation_id ||
        recovery.recovery_new_schedule_operation_id !== generation.schedule_operation_id ||
        recovery.recovery_old_schedule_version !== previous.schedule_version ||
        recovery.recovery_new_schedule_version !== generation.schedule_version ||
        recovery.recovery_old_first_matchup_week_id !== previous.week_one_matchup_week_id ||
        recovery.recovery_new_first_matchup_week_id !== generation.week_one_matchup_week_id ||
        recovery.recovery_old_week_one_starts_at_ms !== previous.week_one_starts_at_ms ||
        recovery.recovery_new_week_one_starts_at_ms !== generation.week_one_starts_at_ms ||
        recovery.recovery_completed_at_ms !== operation.completed_at_ms ||
        recovery.recovery_created_at_ms !== operation.completed_at_ms ||
        metadata.fadId !== recovery.recovery_fad_id ||
        metadata.recoveryId !== recovery.recovery_id ||
        metadata.recoveryKind !== recovery.recovery_kind ||
        metadata.oldScheduleOperationId !== previous.schedule_operation_id ||
        metadata.oldScheduleVersion !== previous.schedule_version ||
        metadata.newScheduleVersion !== generation.schedule_version
      ) {
        failNotReady("schedule_generation_evidence_invalid");
      }
      continue;
    }

    failNotReady("schedule_generation_evidence_invalid");
  }
}

function inspectSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) {
    failNotReady("snapshot_context_invalid");
  }
  let maximumSnapshotVersion = 0;
  let currentSnapshotId = null;
  const versions = new Set();

  for (const snapshot of snapshots) {
    if (
      !UUID_PATTERN.test(snapshot?.snapshot_id || "") ||
      !Number.isSafeInteger(
        snapshot.snapshot_version
      ) ||
      snapshot.snapshot_version < 1 ||
      versions.has(snapshot.snapshot_version) ||
      !["current", "superseded", "final"].includes(
        snapshot.snapshot_status
      )
    ) {
      failNotReady("snapshot_context_invalid");
    }
    versions.add(snapshot.snapshot_version);
    maximumSnapshotVersion = Math.max(
      maximumSnapshotVersion,
      snapshot.snapshot_version
    );

    const qualifyingCompletion =
      snapshot.finalization_cause ===
        "regular_season_completion" &&
      snapshot.operation_type ===
        "finalize_regular_season" &&
      snapshot.idempotency_result_type ===
        STANDINGS_FINALIZATION_RESULT_TYPE &&
      snapshot.idempotency_result_id ===
        snapshot.finalization_id;
    const qualifyingCorrection =
      snapshot.finalization_cause ===
        "result_correction" &&
      snapshot.operation_type ===
        "correction_propagation" &&
      snapshot.idempotency_result_type ===
        "matchup_result_correction" &&
      UUID_PATTERN.test(
        snapshot.idempotency_result_id || ""
      ) &&
      snapshot.idempotency_result_link_count === 1;
    const canonicalEvidence =
      ["final", "superseded"].includes(
        snapshot.snapshot_status
      ) &&
      snapshot.finalization_status ===
        snapshot.snapshot_status &&
      UUID_PATTERN.test(
        snapshot.finalization_id || ""
      ) &&
      snapshot.evidence_schema_version === 1 &&
      (qualifyingCompletion ||
        qualifyingCorrection) &&
      snapshot.operation_status === "succeeded" &&
      snapshot.idempotency_status === "completed";

    if (
      canonicalEvidence &&
      snapshot.snapshot_status === "final"
    ) {
      fail("STANDINGS_ALREADY_FINALIZED");
    }
    if (canonicalEvidence) continue;
    if (
      snapshot.snapshot_status === "final" ||
      snapshot.finalization_id !== null
    ) {
      fail("STANDINGS_FINALIZATION_LEGACY_CONFLICT");
    }
    if (snapshot.snapshot_status === "current") {
      if (currentSnapshotId !== null) {
        failNotReady("multiple_current_snapshots");
      }
      currentSnapshotId = snapshot.snapshot_id;
    }
  }

  if (
    maximumSnapshotVersion >=
    Number.MAX_SAFE_INTEGER
  ) {
    failNotReady("snapshot_version_exhausted");
  }
  return Object.freeze({
    currentSnapshotId,
    snapshotVersion:
      maximumSnapshotVersion + 1,
  });
}

function inspectWeeks(
  weeks,
  {
    regularSeasonStartsAtMs,
    fantasyPlayoffsStartAtMs,
    leagueTimezone,
    nowMs,
  }
) {
  if (!Array.isArray(weeks) || weeks.length < 1) {
    failNotReady("regular_season_weeks_missing");
  }
  const ordered = [...weeks].sort(
    (left, right) => left.sequence - right.sequence
  );
  const ids = new Set();
  for (const [index, week] of ordered.entries()) {
    let expectedRolloverAtMs;
    try {
      expectedRolloverAtMs = addLocalDays(
        week?.starts_at_ms,
        7,
        leagueTimezone
      );
    } catch {
      failNotReady("regular_season_calendar_invalid");
    }
    if (
      !UUID_PATTERN.test(week?.id || "") ||
      ids.has(week.id) ||
      week.sequence !== index + 1 ||
      week.status !== "final" ||
      !isSafeTimestamp(week.starts_at_ms) ||
      !isSafeTimestamp(week.ends_at_ms) ||
      !isSafeTimestamp(week.rolls_over_at_ms) ||
      week.starts_at_ms < regularSeasonStartsAtMs ||
      week.ends_at_ms !== expectedRolloverAtMs ||
      week.rolls_over_at_ms !==
        expectedRolloverAtMs ||
      week.rolls_over_at_ms >
        fantasyPlayoffsStartAtMs ||
      (index === 0 &&
        firstEligibleMonday(
          week.starts_at_ms,
          leagueTimezone
        ) !== week.starts_at_ms) ||
      (index > 0 &&
        week.starts_at_ms !==
          ordered[index - 1].rolls_over_at_ms) ||
      (index === ordered.length - 1 &&
        week.rolls_over_at_ms !==
          fantasyPlayoffsStartAtMs) ||
      nowMs < week.rolls_over_at_ms
    ) {
      failNotReady("regular_season_weeks_incomplete");
    }
    ids.add(week.id);
  }
  return Object.freeze({
    count: ordered.length,
    ids,
    ordered,
  });
}

function inspectByes(
  byes,
  {
    seasonId,
    weekEvidence,
    participantIds,
  }
) {
  if (!Array.isArray(byes)) {
    failNotReady("matchup_byes_invalid");
  }
  const byeIds = new Set();
  const assignmentKeys = new Set();
  const weekById = new Map(
    weekEvidence.ordered.map((week) => [
      week.id,
      week,
    ])
  );
  const normalized = [];
  for (const bye of byes) {
    const week = weekById.get(
      bye?.matchup_week_id
    );
    const assignmentKey =
      `${bye?.matchup_week_id}:${bye?.team_id}`;
    if (
      !UUID_PATTERN.test(bye?.bye_id || "") ||
      byeIds.has(bye.bye_id) ||
      !week ||
      !UUID_PATTERN.test(bye.team_id || "") ||
      !participantIds.has(bye.team_id) ||
      assignmentKeys.has(assignmentKey) ||
      bye.joined_week_id !== bye.matchup_week_id ||
      bye.joined_week_season_id !== seasonId ||
      bye.joined_week_sequence !== week.sequence ||
      bye.joined_week_status !== "final"
    ) {
      failNotReady("matchup_byes_invalid");
    }
    byeIds.add(bye.bye_id);
    assignmentKeys.add(assignmentKey);
    normalized.push({
      matchupWeekId: bye.matchup_week_id,
      teamId: bye.team_id,
    });
  }
  return normalized;
}

function inspectWeeklyScheduleCoverage({
  weekEvidence,
  participantIds,
  results,
  byes,
}) {
  const expectedByeCount =
    participantIds.size % 2;
  for (const week of weekEvidence.ordered) {
    const counts = new Map(
      [...participantIds].map((teamId) => [
        teamId,
        0,
      ])
    );
    for (const result of results) {
      if (result.matchup_week_id !== week.id) {
        continue;
      }
      counts.set(
        result.home_team_id,
        (counts.get(result.home_team_id) || 0) + 1
      );
      counts.set(
        result.away_team_id,
        (counts.get(result.away_team_id) || 0) + 1
      );
    }
    const weekByes = byes.filter(
      (bye) => bye.matchupWeekId === week.id
    );
    for (const bye of weekByes) {
      counts.set(
        bye.teamId,
        (counts.get(bye.teamId) || 0) + 1
      );
    }
    if (
      weekByes.length !== expectedByeCount ||
      [...counts.values()].some(
        (count) => count !== 1
      )
    ) {
      failNotReady("weekly_schedule_coverage_invalid");
    }
  }
}

function inspectParticipants(participants) {
  if (
    !Array.isArray(participants) ||
    participants.length < 2
  ) {
    failNotReady("participants_incomplete");
  }
  const ids = new Set();
  const identities = [];
  for (const participant of participants) {
    const colourCount = teamPatternColourCount(
      participant?.pattern_template
    );
    if (
      !UUID_PATTERN.test(participant?.team_id || "") ||
      ids.has(participant.team_id) ||
      typeof participant.team_display_name !== "string" ||
      participant.team_display_name.length < 1 ||
      participant.team_display_name.length > 120 ||
      participant.team_display_name !==
        participant.team_display_name.trim() ||
      FORBIDDEN_TEXT_PATTERN.test(
        participant.team_display_name
      ) ||
      typeof participant.team_status !== "string" ||
      !COLOUR_PATTERN.test(
        participant.primary_colour || ""
      ) ||
      !COLOUR_PATTERN.test(
        participant.secondary_colour || ""
      ) ||
      ![2, 3].includes(colourCount) ||
      (colourCount === 2 &&
        participant.tertiary_colour !== null) ||
      (colourCount === 3 &&
        !COLOUR_PATTERN.test(
          participant.tertiary_colour || ""
        ))
    ) {
      failNotReady("participant_identity_invalid");
    }

    const logoValues = [
      participant.source_logo_object_id,
      participant.logo_media_type,
      participant.logo_byte_length,
      participant.logo_width,
      participant.logo_height,
      participant.logo_content_sha256,
      participant.logo_content_bytes,
    ];
    const hasLogo =
      participant.logo_reference !== null;
    if (
      (!hasLogo &&
        logoValues.some((value) => value !== null)) ||
      (hasLogo &&
        (!UUID_PATTERN.test(
          participant.logo_reference || ""
        ) ||
          participant.source_logo_object_id !==
            participant.logo_reference ||
          !VALID_LOGO_MEDIA_TYPES.has(
            participant.logo_media_type
          ) ||
          !Number.isSafeInteger(
            participant.logo_byte_length
          ) ||
          participant.logo_byte_length < 1 ||
          participant.logo_byte_length >
            MAXIMUM_LOGO_BYTES ||
          !Number.isSafeInteger(
            participant.logo_width
          ) ||
          participant.logo_width < 1 ||
          participant.logo_width >
            MAXIMUM_LOGO_DIMENSION ||
          !Number.isSafeInteger(
            participant.logo_height
          ) ||
          participant.logo_height < 1 ||
          participant.logo_height >
            MAXIMUM_LOGO_DIMENSION ||
          !RESULT_SET_HASH_PATTERN.test(
            participant.logo_content_sha256 || ""
          ) ||
          !Buffer.isBuffer(
            participant.logo_content_bytes
          ) ||
          participant.logo_content_bytes.length !==
            participant.logo_byte_length))
    ) {
      failNotReady("participant_logo_invalid");
    }

    ids.add(participant.team_id);
    identities.push({
      teamId: participant.team_id,
      teamDisplayName:
        participant.team_display_name,
      primaryColour: participant.primary_colour,
      secondaryColour:
        participant.secondary_colour,
      tertiaryColour:
        participant.tertiary_colour,
      patternTemplate:
        participant.pattern_template,
      sourceLogoObjectId:
        participant.source_logo_object_id,
      logoMediaType: participant.logo_media_type,
      logoByteLength:
        participant.logo_byte_length,
      logoWidth: participant.logo_width,
      logoHeight: participant.logo_height,
      logoContentSha256:
        participant.logo_content_sha256,
      logoContentBytes: hasLogo
        ? Buffer.from(participant.logo_content_bytes)
        : null,
    });
  }
  return Object.freeze({ ids, identities });
}

function inspectResults(
  results,
  {
    leagueId,
    seasonId,
    weekIds,
    participantIds,
    nowMs,
  }
) {
  if (!Array.isArray(results) || results.length < 1) {
    failNotReady("matchup_results_missing");
  }
  const matchupIds = new Set();
  const resultIds = new Set();
  const versionIds = new Set();
  let sourceResultVersion = 0;
  const links = [];
  const descriptors = [];
  const standingsResults = [];

  for (const result of results) {
    const versionNumber = result?.version_number;
    const scoresMatchOutcome =
      (result?.outcome === "home_win" &&
        result.home_score_hundredths >
          result.away_score_hundredths) ||
      (result?.outcome === "away_win" &&
        result.away_score_hundredths >
          result.home_score_hundredths) ||
      (result?.outcome === "tie" &&
        result.home_score_hundredths ===
          result.away_score_hundredths);
    const calculatedSourceValid =
      result?.result_status === "official" &&
      result.source_type === "calculated" &&
      versionNumber === 1 &&
      result.result_version_count === 1 &&
      result.actor_user_id === null &&
      result.reason === null &&
      result.supersedes_version_id === null;
    const correctionSourceValid =
      result?.result_status === "corrected" &&
      result.source_type === "correction" &&
      versionNumber > 1 &&
      UUID_PATTERN.test(result.actor_user_id || "") &&
      typeof result.reason === "string" &&
      result.reason.length >= 1 &&
      result.reason.length <= 500 &&
      result.reason === result.reason.trim() &&
      !FORBIDDEN_TEXT_PATTERN.test(result.reason) &&
      UUID_PATTERN.test(
        result.supersedes_version_id || ""
      );
    if (
      !UUID_PATTERN.test(result?.matchup_id || "") ||
      matchupIds.has(result.matchup_id) ||
      !UUID_PATTERN.test(
        result.matchup_week_id || ""
      ) ||
      !weekIds.has(result.matchup_week_id) ||
      result.matchup_status !== "final" ||
      !UUID_PATTERN.test(
        result.matchup_result_id || ""
      ) ||
      resultIds.has(result.matchup_result_id) ||
      result.result_row_count !== 1 ||
      !VALID_RESULT_STATUSES.has(
        result.result_status
      ) ||
      !UUID_PATTERN.test(
        result.current_version_id || ""
      ) ||
      result.current_version_id !==
        result.result_version_id ||
      !UUID_PATTERN.test(
        result.result_version_id || ""
      ) ||
      versionIds.has(result.result_version_id) ||
      !Number.isSafeInteger(versionNumber) ||
      versionNumber < 1 ||
      result.latest_version_number !== versionNumber ||
      !Number.isSafeInteger(
        result.result_version_count
      ) ||
      result.result_version_count !== versionNumber ||
      result.invalid_version_chain_count !== 0 ||
      !UUID_PATTERN.test(
        result.home_team_id || ""
      ) ||
      !UUID_PATTERN.test(
        result.away_team_id || ""
      ) ||
      result.home_team_id === result.away_team_id ||
      !participantIds.has(result.home_team_id) ||
      !participantIds.has(result.away_team_id) ||
      result.version_home_team_id !==
        result.home_team_id ||
      result.version_away_team_id !==
        result.away_team_id ||
      !Number.isSafeInteger(
        result.home_score_hundredths
      ) ||
      result.home_score_hundredths < 0 ||
      !Number.isSafeInteger(
        result.away_score_hundredths
      ) ||
      result.away_score_hundredths < 0 ||
      !scoresMatchOutcome ||
      !isSafeTimestamp(
        result.result_finalized_at_ms
      ) ||
      result.result_finalized_at_ms > nowMs ||
      !isSafeTimestamp(
        result.result_version_created_at_ms
      ) ||
      result.result_version_created_at_ms > nowMs ||
      !VALID_RESULT_SOURCE_TYPES.has(result.source_type) ||
      !UUID_PATTERN.test(
        result.source_snapshot_id || ""
      ) ||
      result.source_snapshot_record_id !==
        result.source_snapshot_id ||
      result.source_snapshot_league_id !== leagueId ||
      result.source_snapshot_season_id !== seasonId ||
      result.source_snapshot_week_id !==
        result.matchup_week_id ||
      result.source_snapshot_intended_use !==
        "matchup_final" ||
      result.source_snapshot_completeness !==
        "complete" ||
      result.source_snapshot_freshness !== "fresh" ||
      result.source_snapshot_committed !== 1 ||
      (!calculatedSourceValid &&
        !correctionSourceValid) ||
      (correctionSourceValid &&
        (result.superseded_version_record_id !==
          result.supersedes_version_id ||
          result.previous_result_version_id !==
            result.supersedes_version_id ||
          result.superseded_version_matchup_result_id !==
            result.matchup_result_id ||
          result.superseded_version_number !==
            versionNumber - 1 ||
          result.supersedes_previous_version !== 1))
    ) {
      failNotReady("matchup_result_invalid");
    }

    sourceResultVersion += versionNumber;
    if (!Number.isSafeInteger(sourceResultVersion)) {
      failNotReady("source_result_version_invalid");
    }
    matchupIds.add(result.matchup_id);
    resultIds.add(result.matchup_result_id);
    versionIds.add(result.result_version_id);
    links.push({
      matchupWeekId: result.matchup_week_id,
      matchupId: result.matchup_id,
      matchupResultId: result.matchup_result_id,
      resultVersionId: result.result_version_id,
      resultVersionNumber: versionNumber,
    });
    descriptors.push({
      matchupId: result.matchup_id,
      matchupResultId: result.matchup_result_id,
      resultVersionId: result.result_version_id,
      resultVersion: versionNumber,
    });
    standingsResults.push({
      home_team_id: result.home_team_id,
      away_team_id: result.away_team_id,
      home_score_hundredths:
        result.home_score_hundredths,
      away_score_hundredths:
        result.away_score_hundredths,
    });
  }

  return Object.freeze({
    count: results.length,
    descriptors,
    links,
    sourceResultVersion,
    standingsResults,
  });
}

function inspectCorrectionOperations(
  correctionOperations,
  {
    results,
    weekIds,
    nowMs,
  }
) {
  if (
    !Array.isArray(correctionOperations) ||
    !Array.isArray(results) ||
    !(weekIds instanceof Set)
  ) {
    failNotReady(
      "matchup_result_correction_evidence_invalid"
    );
  }

  const resultById = new Map();
  let expectedCorrectionCount = 0;
  for (const result of results) {
    if (
      !UUID_PATTERN.test(
        result?.matchup_result_id || ""
      ) ||
      resultById.has(result.matchup_result_id) ||
      !Number.isSafeInteger(result.version_number) ||
      result.version_number < 1
    ) {
      failNotReady(
        "matchup_result_correction_evidence_invalid"
      );
    }
    resultById.set(result.matchup_result_id, result);
    expectedCorrectionCount +=
      result.version_number - 1;
    if (
      !Number.isSafeInteger(
        expectedCorrectionCount
      )
    ) {
      failNotReady(
        "matchup_result_correction_evidence_invalid"
      );
    }
  }

  const succeeded = correctionOperations.filter(
    (operation) =>
      operation?.operation_status === "succeeded"
  );
  if (
    succeeded.length !== expectedCorrectionCount
  ) {
    failNotReady(
      "matchup_result_correction_evidence_invalid"
    );
  }

  const operationIds = new Set();
  const versionIds = new Set();
  const versionNumbersByResult = new Map();
  for (const operation of succeeded) {
    let metadata;
    try {
      metadata = JSON.parse(
        operation?.metadata_json
      );
    } catch {
      failNotReady(
        "matchup_result_correction_evidence_invalid"
      );
    }
    const metadataKeys =
      metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata)
        ? Object.keys(metadata).sort()
        : [];
    const result =
      resultById.get(
        operation?.matched_matchup_result_id
      );
    const matchedVersionNumber =
      operation?.matched_version_number;
    const reasonValid =
      typeof operation?.reason === "string" &&
      operation.reason.length >= 1 &&
      operation.reason.length <= 500 &&
      operation.reason === operation.reason.trim() &&
      !FORBIDDEN_TEXT_PATTERN.test(operation.reason);
    if (
      !UUID_PATTERN.test(
        operation?.correction_operation_id || ""
      ) ||
      operationIds.has(
        operation.correction_operation_id
      ) ||
      !UUID_PATTERN.test(
        operation?.matchup_week_id || ""
      ) ||
      !weekIds.has(operation.matchup_week_id) ||
      !UUID_PATTERN.test(
        operation?.matchup_id || ""
      ) ||
      !UUID_PATTERN.test(
        operation?.actor_user_id || ""
      ) ||
      !reasonValid ||
      typeof operation.metadata_json !== "string" ||
      operation.metadata_json.length < 2 ||
      operation.metadata_json.length > 16_384 ||
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      JSON.stringify(metadata) !==
        operation.metadata_json ||
      metadataKeys.length !== 2 ||
      metadataKeys[0] !== "resultId" ||
      metadataKeys[1] !== "resultVersionId" ||
      !UUID_PATTERN.test(metadata.resultId || "") ||
      !UUID_PATTERN.test(
        metadata.resultVersionId || ""
      ) ||
      metadata.resultId !==
        operation.metadata_result_id ||
      metadata.resultVersionId !==
        operation.metadata_result_version_id ||
      !isSafeTimestamp(operation.started_at_ms) ||
      !isSafeTimestamp(operation.completed_at_ms) ||
      operation.completed_at_ms <
        operation.started_at_ms ||
      operation.completed_at_ms > nowMs ||
      !UUID_PATTERN.test(
        operation.matched_result_version_id || ""
      ) ||
      versionIds.has(
        operation.matched_result_version_id
      ) ||
      metadata.resultVersionId !==
        operation.matched_result_version_id ||
      metadata.resultId !==
        operation.matched_matchup_result_id ||
      !Number.isSafeInteger(matchedVersionNumber) ||
      matchedVersionNumber < 2 ||
      operation.matched_source_type !==
        "correction" ||
      operation.matched_actor_user_id !==
        operation.actor_user_id ||
      operation.matched_reason !== operation.reason ||
      operation.matched_created_at_ms !==
        operation.completed_at_ms ||
      !UUID_PATTERN.test(
        operation.matched_supersedes_version_id ||
          ""
      ) ||
      !result ||
      operation.matchup_week_id !==
        result.matchup_week_id ||
      operation.matchup_id !== result.matchup_id ||
      operation.result_matchup_id !==
        result.matchup_id ||
      operation.current_matchup_result_id !==
        result.matchup_result_id ||
      operation.current_result_version_id !==
        result.result_version_id ||
      operation.current_result_status !==
        result.result_status ||
      matchedVersionNumber >
        result.version_number ||
      (
        matchedVersionNumber ===
          result.version_number &&
        (
          operation.matched_result_version_id !==
            result.result_version_id ||
          operation.matched_actor_user_id !==
            result.actor_user_id ||
          operation.matched_reason !== result.reason ||
          operation.matched_created_at_ms !==
            result.result_version_created_at_ms ||
          operation
            .matched_supersedes_version_id !==
            result.supersedes_version_id
        )
      )
    ) {
      failNotReady(
        "matchup_result_correction_evidence_invalid"
      );
    }

    operationIds.add(
      operation.correction_operation_id
    );
    versionIds.add(
      operation.matched_result_version_id
    );
    const versionNumbers =
      versionNumbersByResult.get(
        result.matchup_result_id
      ) || new Set();
    if (versionNumbers.has(matchedVersionNumber)) {
      failNotReady(
        "matchup_result_correction_evidence_invalid"
      );
    }
    versionNumbers.add(matchedVersionNumber);
    versionNumbersByResult.set(
      result.matchup_result_id,
      versionNumbers
    );
  }

  for (const result of results) {
    const versionNumbers =
      versionNumbersByResult.get(
        result.matchup_result_id
      ) || new Set();
    for (
      let versionNumber = 2;
      versionNumber <= result.version_number;
      versionNumber += 1
    ) {
      if (!versionNumbers.has(versionNumber)) {
        failNotReady(
          "matchup_result_correction_evidence_invalid"
        );
      }
    }
  }
}

function inspectActiveMemberUserIds(value) {
  if (!Array.isArray(value) || value.length < 1) {
    failNotReady("active_members_missing");
  }
  const ids = new Set();
  for (const userId of value) {
    if (
      !UUID_PATTERN.test(userId || "") ||
      ids.has(userId)
    ) {
      failNotReady("active_members_invalid");
    }
    ids.add(userId);
  }
  return [...ids].sort();
}

function calculateRows(participants, results) {
  try {
    return calculateStandings({
      participants: participants.map((participant) => ({
        team_id: participant.team_id,
        team_display_name:
          participant.team_display_name,
      })),
      results,
    });
  } catch (error) {
    failNotReady(
      error?.code || "standings_calculation_failed"
    );
  }
}

function auditClientMetadata(
  value,
  actorAuthority
) {
  let metadata = {};
  if (value !== null && value !== undefined) {
    if (
      typeof value !== "string" ||
      value.length < 2 ||
      value.length > 2_048
    ) {
      throw new TypeError(
        "standings finalization requires safe audit client metadata"
      );
    }
    try {
      metadata = JSON.parse(value);
    } catch {
      throw new TypeError(
        "standings finalization requires safe audit client metadata"
      );
    }
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Object.getPrototypeOf(metadata) !==
        Object.prototype
    ) {
      throw new TypeError(
        "standings finalization requires safe audit client metadata"
      );
    }
  }
  return JSON.stringify({
    ...metadata,
    actorAuthority,
  });
}

function auditRecord({
  id,
  audit,
  authority,
  actorAuthority,
  authenticated,
  leagueId,
  nowMs,
}) {
  return {
    id,
    event_type: FINALIZATION_AUDIT_EVENT_TYPE,
    outcome: "success",
    actor_user_id: authority.actorUserId,
    target_user_id: null,
    league_id: leagueId,
    session_id: authenticated?.session?.id,
    request_correlation_id:
      audit.requestCorrelationId || null,
    reason_code: null,
    network_key_version:
      audit.networkKeyVersion || null,
    network_metadata_digest:
      audit.networkMetadataDigest || null,
    client_metadata_json:
      auditClientMetadata(
        audit.clientMetadataJson,
        actorAuthority
      ),
    unknown_account_digest: null,
    occurred_at_ms: nowMs,
  };
}

function createStandingsFinalizationService({
  repositoryContext,
  leagueAuthorization,
  standingsFinalizationRepository,
  auditRepository,
  clock,
  secureRandom,
} = {}) {
  requireMethod(
    repositoryContext,
    "transaction",
    "an immediate repository transaction boundary"
  );
  requireMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league-commissioner authorization"
  );
  for (const method of [
    "advanceSeasonVersion",
    "completeIdempotency",
    "findFinalizationResult",
    "findIdempotency",
    "insertFinalSnapshot",
    "insertFinalizationEvidence",
    "insertResultVersionLinks",
    "insertStandingsRows",
    "insertStartedIdempotency",
    "insertSucceededOperation",
    "insertTeamIdentities",
    "readFinalizationContext",
    "supersedeCurrentDerivedSnapshot",
    "writeFinalizedNotification",
    "writeFinalizedOutbox",
  ]) {
    requireMethod(
      standingsFinalizationRepository,
      method,
      "a standings-finalization repository"
    );
  }
  requireMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );

  function finalize({
    leagueId,
    seasonId,
    input,
    expectedSeasonVersion,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId =
      validateStandingsFinalizationLeagueId(leagueId);
    const canonicalSeasonId =
      validateStandingsFinalizationSeasonId(seasonId);
    const canonicalInput =
      validateStandingsFinalizationInput(input);
    const expectedVersion =
      validateStandingsFinalizationExpectedVersion(
        expectedSeasonVersion
      );
    const clientKey =
      validateStandingsFinalizationIdempotencyKey(
        idempotencyKey
      );
    const requestHash =
      standingsFinalizationRequestHash({
        leagueId: canonicalLeagueId,
        seasonId: canonicalSeasonId,
        expectedSeasonVersion: expectedVersion,
        resultSetHash:
          canonicalInput.resultSetHash,
        confirmation:
          canonicalInput.confirmation,
      });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority =
          leagueAuthorization.requireCommissioner(
            authenticated,
            canonicalLeagueId
          );
        const actorAuthority =
          canonicalActorAuthority(authority);
        const existing =
          standingsFinalizationRepository.findIdempotency({
            leagueId: canonicalLeagueId,
            actorUserId: authority.actorUserId,
            operation:
              STANDINGS_FINALIZATION_OPERATION,
            clientKey,
          });

        if (existing) {
          if (
            existing.league_id !== canonicalLeagueId ||
            existing.actor_user_id !==
              authority.actorUserId ||
            existing.operation !==
              STANDINGS_FINALIZATION_OPERATION ||
            existing.client_key !== clientKey ||
            existing.request_hash !== requestHash
          ) {
            fail("IDEMPOTENCY_KEY_REUSED");
          }
          if (
            existing.status !== "completed" ||
            existing.result_type !==
              STANDINGS_FINALIZATION_RESULT_TYPE ||
            !UUID_PATTERN.test(existing.result_id || "") ||
            !isSafeTimestamp(existing.completed_at_ms)
          ) {
            fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
          }
          const durable =
            standingsFinalizationRepository
              .findFinalizationResult({
                leagueId: canonicalLeagueId,
                finalizationId: existing.result_id,
              });
          if (
            !durable ||
            durable.league_id !== canonicalLeagueId ||
            durable.season_id !== canonicalSeasonId ||
            durable.result_set_hash !==
              canonicalInput.resultSetHash ||
            durable.finalized_at_ms !==
              existing.completed_at_ms
          ) {
            fail(
              "STANDINGS_FINALIZATION_RESULT_UNAVAILABLE"
            );
          }
          return internalResult(
            safeFinalizationResult(durable),
            true
          );
        }

        const context =
          standingsFinalizationRepository
            .readFinalizationContext({
              leagueId: canonicalLeagueId,
              seasonId: canonicalSeasonId,
            });
        if (!context) {
          fail("STANDINGS_FINALIZATION_NOT_FOUND");
        }
        const snapshot =
          inspectSnapshots(context.snapshots);
        inspectAggregate(context.aggregate, {
          leagueId: canonicalLeagueId,
          seasonId: canonicalSeasonId,
          expectedSeasonVersion: expectedVersion,
        });
        const nowMs = safeNow(clock);
        const weekEvidence = inspectWeeks(
          context.weeks,
          {
            regularSeasonStartsAtMs:
              context.aggregate
                .regular_season_starts_at_ms,
            fantasyPlayoffsStartAtMs:
              context.aggregate
                .fantasy_playoffs_start_at_ms,
            leagueTimezone:
              context.aggregate.league_timezone,
            nowMs,
          }
        );
        const participantEvidence =
          inspectParticipants(context.participants);
        const resultEvidence = inspectResults(
          context.results,
          {
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            weekIds: weekEvidence.ids,
            participantIds:
              participantEvidence.ids,
            nowMs,
          }
        );
        inspectCorrectionOperations(
          context.correctionOperations,
          {
            results: context.results,
            weekIds: weekEvidence.ids,
            nowMs,
          }
        );
        inspectScheduleGeneration(
          context.scheduleOperations,
          context.scheduleGenerations,
          context.scheduleCommandResults,
          context.scheduleRecoveries,
          {
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            participantIds:
              participantEvidence.ids,
            weekCount: weekEvidence.count,
            matchupCount: resultEvidence.count,
            firstWeekId:
              weekEvidence.ordered[0].id,
            firstWeekStartsAtMs:
              weekEvidence.ordered[0]
                .starts_at_ms,
            nowMs,
          }
        );
        const byeEvidence = inspectByes(
          context.byes,
          {
            seasonId: canonicalSeasonId,
            weekEvidence,
            participantIds:
              participantEvidence.ids,
          }
        );
        inspectWeeklyScheduleCoverage({
          weekEvidence,
          participantIds:
            participantEvidence.ids,
          results: context.results,
          byes: byeEvidence,
        });
        const activeMemberUserIds =
          inspectActiveMemberUserIds(
            context.activeMemberUserIds
          );
        if (
          !activeMemberUserIds.includes(
            authority.actorUserId
          )
        ) {
          fail("LEAGUE_COMMISSIONER_REQUIRED");
        }

        const calculatedHash =
          calculateStandingsResultSetHash({
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            standingsRuleVersion: String(
              context.aggregate
                .standings_rule_version
            ),
            results:
              resultEvidence.descriptors,
          });
        if (
          calculatedHash !== canonicalInput.resultSetHash
        ) {
          fail("STANDINGS_RESULT_SET_CHANGED");
        }
        const calculatedRows = calculateRows(
          context.participants,
          resultEvidence.standingsResults
        );
        if (
          calculatedRows.length !==
          context.participants.length
        ) {
          failNotReady("standings_rows_incomplete");
        }

        const nextId =
          createSecureIdFactory(secureRandom);
        const snapshotId = nextId();
        const rows = calculatedRows.map((row) => ({
          id: nextId(),
          teamId: row.teamId,
          rank: row.rank,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          standingsPoints: row.standingsPoints,
          fantasyPointsForHundredths:
            row.fantasyPointsForHundredths,
          fantasyPointsAgainstHundredths:
            row.fantasyPointsAgainstHundredths,
          fantasyPointsDifferentialHundredths:
            row.fantasyPointsDifferentialHundredths,
        }));
        const links = resultEvidence.links.map(
          (link) => ({
            id: nextId(),
            ...link,
          })
        );
        const identities =
          participantEvidence.identities.map(
            (identity) => ({
              id: nextId(),
              ...identity,
            })
          );
        const operationId = nextId();
        const finalizationId = nextId();
        const idempotencyRequestId = nextId();
        const auditId = nextId();
        const notifications =
          activeMemberUserIds.map((userId) => ({
            id: nextId(),
            userId,
          }));
        const outboxId = nextId();
        const expiresAtMs =
          nowMs +
          STANDINGS_FINALIZATION_IDEMPOTENCY_LIFETIME_MS;
        if (!Number.isSafeInteger(expiresAtMs)) {
          throw new TypeError(
            "standings finalization requires a safe idempotency expiry"
          );
        }
        const seasonVersionAfter =
          expectedVersion + 1;
        if (!Number.isSafeInteger(seasonVersionAfter)) {
          failNotReady("season_version_exhausted");
        }
        const operationMetadataJson =
          JSON.stringify({
            expectedMatchupCount:
              resultEvidence.count,
            expectedWeekCount: weekEvidence.count,
            finalizedAtMs: nowMs,
            participantCount:
              context.participants.length,
            resultSetHash: calculatedHash,
            seasonVersionAfter,
            seasonVersionBefore: expectedVersion,
            snapshotVersion:
              snapshot.snapshotVersion,
            scoringRuleVersion:
              context.aggregate
                .scoring_rule_version,
            standingsRuleVersion:
              context.aggregate
                .standings_rule_version,
          });

        standingsFinalizationRepository
          .insertStartedIdempotency({
            id: idempotencyRequestId,
            leagueId: canonicalLeagueId,
            actorUserId: authority.actorUserId,
            operation:
              STANDINGS_FINALIZATION_OPERATION,
            clientKey,
            requestHash,
            createdAtMs: nowMs,
            expiresAtMs,
          });
        if (snapshot.currentSnapshotId !== null) {
          standingsFinalizationRepository
            .supersedeCurrentDerivedSnapshot({
              leagueId: canonicalLeagueId,
              seasonId: canonicalSeasonId,
              snapshotId:
                snapshot.currentSnapshotId,
            });
        }
        standingsFinalizationRepository
          .insertFinalSnapshot({
            id: snapshotId,
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            snapshotVersion:
              snapshot.snapshotVersion,
            sourceResultVersion:
              resultEvidence.sourceResultVersion,
            nowMs,
          });
        standingsFinalizationRepository
          .insertStandingsRows({
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            snapshotId,
            rows,
          });
        standingsFinalizationRepository
          .insertResultVersionLinks({
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            snapshotId,
            links,
            nowMs,
          });
        standingsFinalizationRepository
          .insertTeamIdentities({
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            snapshotId,
            identities,
            nowMs,
          });
        standingsFinalizationRepository
          .insertSucceededOperation({
            id: operationId,
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            snapshotId,
            actorUserId: authority.actorUserId,
            actorMembershipId:
              authority.membershipId,
            actorAuthority,
            idempotencyRequestId,
            metadataJson: operationMetadataJson,
            nowMs,
          });
        standingsFinalizationRepository
          .insertFinalizationEvidence({
            id: finalizationId,
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            snapshotId,
            finalizationVersion:
              snapshot.snapshotVersion,
            standingsRuleVersion:
              context.aggregate
                .standings_rule_version,
            resultSetHash: calculatedHash,
            expectedMatchupCount:
              resultEvidence.count,
            expectedWeekCount: weekEvidence.count,
            participantCount:
              context.participants.length,
            seasonVersionBefore: expectedVersion,
            actorUserId: authority.actorUserId,
            actorMembershipId:
              authority.membershipId,
            actorAuthority,
            operationId,
            idempotencyRequestId,
            nowMs,
          });
        auditRepository.append(
          auditRecord({
            id: auditId,
            audit,
            authority,
            actorAuthority,
            authenticated,
            leagueId: canonicalLeagueId,
            nowMs,
          })
        );
        for (const notification of notifications) {
          standingsFinalizationRepository
            .writeFinalizedNotification({
              id: notification.id,
              leagueId: canonicalLeagueId,
              seasonId: canonicalSeasonId,
              finalizationId,
              snapshotId,
              userId: notification.userId,
              nowMs,
            });
        }
        standingsFinalizationRepository
          .writeFinalizedOutbox({
            id: outboxId,
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            snapshotId,
            seasonVersion: seasonVersionAfter,
            nowMs,
          });
        standingsFinalizationRepository
          .advanceSeasonVersion({
            leagueId: canonicalLeagueId,
            seasonId: canonicalSeasonId,
            expectedVersion,
            nowMs,
          });
        standingsFinalizationRepository
          .completeIdempotency({
            id: idempotencyRequestId,
            leagueId: canonicalLeagueId,
            finalizationId,
            completedAtMs: nowMs,
          });

        const durable =
          standingsFinalizationRepository
            .findFinalizationResult({
              leagueId: canonicalLeagueId,
              finalizationId,
            });
        const expectedDurable = {
          operation_id: operationId,
          snapshot_id: snapshotId,
          snapshot_version:
            snapshot.snapshotVersion,
          league_id: canonicalLeagueId,
          season_id: canonicalSeasonId,
          season_version: seasonVersionAfter,
          standings_rule_version:
            context.aggregate
              .standings_rule_version,
          result_set_hash: calculatedHash,
          expected_matchup_count:
            resultEvidence.count,
          included_result_count:
            resultEvidence.count,
          participant_count:
            context.participants.length,
          finalized_at_ms: nowMs,
        };
        if (
          JSON.stringify(durable) !==
          JSON.stringify(expectedDurable)
        ) {
          fail(
            "STANDINGS_FINALIZATION_RESULT_UNAVAILABLE"
          );
        }
        return internalResult(
          safeFinalizationResult(durable),
          false
        );
      });
    } catch (error) {
      const chain = errorChain(error);
      const applicationError = chain.find(
        (candidate) =>
          candidate instanceof
            StandingsFinalizationServiceError ||
          candidate instanceof
            StandingsFinalizationPolicyError ||
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            "LEAGUE_NOT_FOUND",
          ].includes(candidate?.code)
      );
      if (applicationError) throw applicationError;

      if (
        chain.some(
          (candidate) =>
            candidate?.code ===
            "REPOSITORY_VERSION_CONFLICT"
        )
      ) {
        fail(
          "STANDINGS_FINALIZATION_PRECONDITION_FAILED",
          {
            details: {
              currentVersion: null,
              refetch: true,
            },
          }
        );
      }

      const recordMissing = chain.find(
        (candidate) =>
          candidate?.code ===
          "REPOSITORY_RECORD_NOT_FOUND"
      );
      if (recordMissing) {
        failNotReady("repository_record_changed");
      }

      const constraint = chain.find(
        (candidate) =>
          candidate?.code ===
          "REPOSITORY_CONSTRAINT"
      );
      if (constraint) {
        const tableName =
          constraint?.details?.tableName;
        if (tableName === "idempotency_requests") {
          fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
        }
        if (
          [
            "standings_snapshot_finalizations",
            "standings_snapshots",
          ].includes(tableName)
        ) {
          fail("STANDINGS_ALREADY_FINALIZED");
        }
        failNotReady("repository_state_changed");
      }
      throw error;
    }
  }

  return Object.freeze({ finalize });
}

module.exports = {
  FINALIZATION_AUDIT_EVENT_TYPE,
  STANDINGS_FINALIZATION_IDEMPOTENCY_LIFETIME_MS,
  STANDINGS_FINALIZATION_OPERATION,
  STANDINGS_FINALIZATION_RESULT_TYPE,
  StandingsFinalizationServiceError,
  createStandingsFinalizationService,
  safeFinalizationResult,
  standingsFinalizationRequestHash,
};
