const {
  UUID_PATTERN,
  parseFreeAgentDraftOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  finalizeFreeAgentDraftOpeningReadiness,
  inspectFreeAgentDraftOpeningReadiness,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftOpeningReadinessPolicy"
);
const {
  createFreeAgentDraftReadinessAttemptEvidence,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  createFreeAgentDraftScheduleRecoveryService,
} = require(
  "./createFreeAgentDraftScheduleRecoveryService"
);

const FREE_AGENT_DRAFT_READINESS_SERVICE_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_READINESS_EXECUTION_INPUT_INVALID",
    stateInvalid:
      "FAD_READINESS_EXECUTION_STATE_INVALID",
  });

// A blocked readiness job is not automatically claimable. This timestamp is
// the earliest strictly-later requeue marker; T-095 or T-128 supplies the
// actual evidence-backed requeue instant.
const FREE_AGENT_DRAFT_READINESS_MINIMUM_RETRY_DELAY_MS = 1;
const FREE_AGENT_DRAFT_READINESS_MAXIMUM_FRESHNESS_REPLANS = 1;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

class FreeAgentDraftReadinessServiceError extends Error {
  constructor(code, reasonCode) {
    super("The Free Agent Draft readiness job could not be executed.");
    this.name = "FreeAgentDraftReadinessServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftReadinessServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.inputInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_READINESS_SERVICE_CODES.stateInvalid,
    reasonCode
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

function exactObject(value, expectedKeys, reasonCode) {
  if (!isPlainObject(value)) {
    failInput(reasonCode);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    failInput(reasonCode);
  }
  return value;
}

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function boundedText(value, maximumLength, reasonCode) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    failInput(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput(reasonCode);
  }
  return value;
}

function terminalTimestamp(
  clock,
  execution,
  observedAtMs
) {
  const value = clock.nowMs();
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failState("clock_timestamp_invalid");
  }
  if (value < observedAtMs) {
    failState("clock_moved_backwards");
  }
  if (
    value >=
    execution.jobExecution.leaseExpiresAtMs
  ) {
    failState(
      "claimed_lease_expired_before_terminal"
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

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD readiness execution requires ${description}`
    );
  }
}

function normalizeExecution(input) {
  exactObject(
    input,
    [
      "leagueId",
      "seasonId",
      "occurrenceKey",
      "readinessOperationId",
      "jobExecution",
    ],
    "execution_fields_invalid"
  );
  const leagueId = stableId(
    input.leagueId,
    "league_id_invalid"
  );
  const seasonId = stableId(
    input.seasonId,
    "season_id_invalid"
  );
  const readinessOperationId = stableId(
    input.readinessOperationId,
    "readiness_operation_id_invalid"
  );
  if (
    typeof input.occurrenceKey !== "string" ||
    input.occurrenceKey.length < 1 ||
    input.occurrenceKey.length > 500 ||
    input.occurrenceKey.trim() !== input.occurrenceKey ||
    CONTROL_PATTERN.test(input.occurrenceKey)
  ) {
    failInput("occurrence_key_invalid");
  }
  let occurrence;
  try {
    occurrence = parseFreeAgentDraftOccurrenceKey(
      input.occurrenceKey
    );
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (
    occurrence.type !== "readiness" ||
    occurrence.leagueId !== leagueId ||
    occurrence.seasonId !== seasonId
  ) {
    failInput("occurrence_scope_invalid");
  }
  exactObject(
    input.jobExecution,
    [
      "runId",
      "leaseOwner",
      "leaseToken",
      "leaseExpiresAtMs",
      "expectedVersion",
    ],
    "job_execution_fields_invalid"
  );
  const jobExecution = Object.freeze({
    runId: stableId(
      input.jobExecution.runId,
      "job_run_id_invalid"
    ),
    leaseOwner: boundedText(
      input.jobExecution.leaseOwner,
      128,
      "lease_owner_invalid"
    ),
    leaseToken: boundedText(
      input.jobExecution.leaseToken,
      200,
      "lease_token_invalid"
    ),
    leaseExpiresAtMs: safeTimestamp(
      input.jobExecution.leaseExpiresAtMs,
      "lease_expiry_invalid"
    ),
    expectedVersion: positiveInteger(
      input.jobExecution.expectedVersion,
      "job_version_invalid"
    ),
  });
  return Object.freeze({
    leagueId,
    seasonId,
    occurrenceKey: input.occurrenceKey,
    readinessOperationId,
    jobExecution,
  });
}

function createIdAllocator(secureRandom, forbiddenIds) {
  const allocated = new Set(forbiddenIds);
  return function allocateId() {
    const id = secureRandom.id();
    if (
      typeof id !== "string" ||
      !UUID_PATTERN.test(id) ||
      allocated.has(id)
    ) {
      throw new TypeError(
        "FAD readiness execution requires unique canonical secure identifiers"
      );
    }
    allocated.add(id);
    return id;
  };
}

function createReadinessAttemptCommand(input) {
  const evidence =
    createFreeAgentDraftReadinessAttemptEvidence(input);
  return Object.freeze({
    id: evidence.id,
    leagueId: evidence.leagueId,
    seasonId: evidence.seasonId,
    readinessOperationId:
      evidence.readinessOperationId,
    jobRunId: evidence.jobRunId,
    attemptNumber: evidence.attemptNumber,
    observedReadinessVersion:
      evidence.observedReadinessVersion,
    outcome: evidence.outcome,
    observedAtMs: evidence.observedAtMs,
    recordedAtMs: evidence.recordedAtMs,
    projection: evidence.projection,
  });
}

function requireClaimedContext(context, execution) {
  if (!isPlainObject(context)) {
    failState("opening_context_missing");
  }
  const operation = context.readinessOperation;
  const job = context.readinessJob;
  if (
    !isPlainObject(operation) ||
    !isPlainObject(job) ||
    operation.operationId !==
      execution.readinessOperationId ||
    operation.leagueId !== execution.leagueId ||
    operation.seasonId !== execution.seasonId ||
    operation.occurrenceKey !==
      execution.occurrenceKey ||
    operation.jobRunId !==
      execution.jobExecution.runId ||
    operation.version !==
      execution.jobExecution.expectedVersion ||
    operation.leaseOwner !==
      execution.jobExecution.leaseOwner ||
    operation.leaseToken !==
      execution.jobExecution.leaseToken ||
    operation.leaseExpiresAtMs !==
      execution.jobExecution.leaseExpiresAtMs ||
    job.jobRunId !== execution.jobExecution.runId ||
    job.leagueId !== execution.leagueId ||
    job.seasonId !== execution.seasonId ||
    job.occurrenceKey !== execution.occurrenceKey ||
    job.version !== execution.jobExecution.expectedVersion ||
    job.leaseOwner !== execution.jobExecution.leaseOwner ||
    job.leaseToken !== execution.jobExecution.leaseToken ||
    job.leaseExpiresAtMs !==
      execution.jobExecution.leaseExpiresAtMs
  ) {
    failState("claimed_execution_changed");
  }
}

function sortedStrings(values) {
  return [...values].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => value === right[index]
    )
  );
}

function scheduleRecoveryContext({
  context,
  fadId,
  inspection,
  openedAtMs,
  shiftContext,
}) {
  if (
    !isPlainObject(shiftContext) ||
    shiftContext.leagueId !== inspection.leagueId ||
    shiftContext.seasonId !== inspection.seasonId ||
    shiftContext.timeZone !== context.league.timeZone ||
    shiftContext.seasonStatus !== "active" ||
    shiftContext.seasonVersion !==
      inspection.observedSeasonVersion ||
    shiftContext.nhlSeasonKey !==
      context.season.nhlSeasonKey ||
    shiftContext.nhlRegularSeasonStartsAtMs !==
      context.season.regularSeasonStartsAtMs ||
    shiftContext.nhlRegularSeasonEndsAtMs !==
      context.season.regularSeasonEndsAtMs ||
    shiftContext.fantasyPlayoffsStartAtMs !==
      context.season.fantasyPlayoffsStartAtMs ||
    shiftContext.fantasyPlayoffsEndAtMs !==
      context.season.fantasyPlayoffsEndAtMs ||
    shiftContext.fadCount !== 0 ||
    shiftContext.currentGenerationCount !== 1 ||
    shiftContext.unboundJobCount !== 0 ||
    !isPlainObject(shiftContext.currentGeneration) ||
    !Array.isArray(shiftContext.teams) ||
    !Array.isArray(shiftContext.weeks) ||
    !Array.isArray(shiftContext.jobs)
  ) {
    failState("schedule_recovery_context_changed");
  }
  const current = inspection.currentSchedule;
  const generation = shiftContext.currentGeneration;
  if (
    current === null ||
    generation.scheduleOperationId !== current.operationId ||
    generation.scheduleVersion !== current.version ||
    generation.weekOneMatchupWeekId !==
      current.weekOneMatchupWeekId ||
    generation.weekOneStartsAtMs !==
      current.weekOneStartsAtMs ||
    generation.version !== current.generationVersion ||
    generation.status !== "current" ||
    generation.supersededAtMs !== null
  ) {
    failState("schedule_generation_changed");
  }
  const scheduledTeamIds = sortedStrings(
    shiftContext.teams.map(({ id }) => id)
  );
  const participantTeamIds = sortedStrings(
    inspection.teamProjections.map(({ teamId }) => teamId)
  );
  if (
    scheduledTeamIds.some(
      (teamId) => !UUID_PATTERN.test(teamId || "")
    ) ||
    new Set(scheduledTeamIds).size !==
      scheduledTeamIds.length ||
    !sameStrings(scheduledTeamIds, participantTeamIds)
  ) {
    failState("schedule_participant_set_changed");
  }
  return deepFreeze({
    leagueId: inspection.leagueId,
    seasonId: inspection.seasonId,
    fadId,
    recovery: {
      kind: "pre_open",
      atMs: openedAtMs,
      frozenFadFirstMatchupStartsAtMs: null,
    },
    calendar: {
      nhlSeasonKey: shiftContext.nhlSeasonKey,
      nhlRegularSeasonStartsAtMs:
        shiftContext.nhlRegularSeasonStartsAtMs,
      nhlRegularSeasonEndsAtMs:
        shiftContext.nhlRegularSeasonEndsAtMs,
      fantasyPlayoffsStartAtMs:
        shiftContext.fantasyPlayoffsStartAtMs,
      fantasyPlayoffsEndAtMs:
        shiftContext.fantasyPlayoffsEndAtMs,
      timeZone: shiftContext.timeZone,
    },
    currentGeneration: generation,
    weeks: shiftContext.weeks,
    jobs: shiftContext.jobs,
  });
}

function targetScheduleFromPlan(plan, inspection) {
  const recoveryRequired =
    inspection.scheduleDecision.recoveryRequired;
  if (!recoveryRequired) {
    if (
      !isPlainObject(plan) ||
      plan.action !== "no_op" ||
      plan.recoveryRequired !== false ||
      plan.recoveryKind !== "pre_open"
    ) {
      failState("schedule_recovery_plan_mismatch");
    }
    return Object.freeze({
      operationId: inspection.currentSchedule.operationId,
      version: inspection.currentSchedule.version,
      weekOneMatchupWeekId:
        inspection.currentSchedule.weekOneMatchupWeekId,
      weekOneStartsAtMs:
        inspection.currentSchedule.weekOneStartsAtMs,
    });
  }
  const replacement = plan?.generation?.replacement;
  if (
    !isPlainObject(plan) ||
    plan.action !== "stage_recovery" ||
    plan.recoveryRequired !== true ||
    plan.recoveryKind !== "pre_open" ||
    !isPlainObject(replacement)
  ) {
    failState("schedule_recovery_plan_mismatch");
  }
  return Object.freeze({
    operationId: replacement.scheduleOperationId,
    version: replacement.scheduleVersion,
    weekOneMatchupWeekId:
      replacement.weekOneMatchupWeekId,
    weekOneStartsAtMs:
      replacement.weekOneStartsAtMs,
  });
}

function terminalResult(result, {
  attemptId,
  fadId,
  nextRetryAtMs,
  outcome,
  readinessOperationId,
  scheduleRecoveryRequired,
}) {
  const readiness = result?.readiness;
  const expectedStatus =
    outcome === "succeeded" ? "succeeded" : "blocked";
  if (
    !isPlainObject(result) ||
    typeof result.replayed !== "boolean" ||
    !isPlainObject(readiness) ||
    readiness.id !== readinessOperationId ||
    readiness.status !== expectedStatus ||
    !Number.isSafeInteger(readiness.version) ||
    readiness.version < 1 ||
    (
      outcome === "succeeded" &&
      (
        !isPlainObject(result.draft) ||
        result.draft.id !== fadId
      )
    )
  ) {
    failState("terminal_repository_result_invalid");
  }
  return deepFreeze({
    outcome,
    replayed: result.replayed,
    readinessOperationId,
    readinessAttemptId: attemptId,
    readinessVersion: readiness.version,
    fadId: outcome === "succeeded" ? fadId : null,
    nextRetryAtMs:
      outcome === "blocked" ? nextRetryAtMs : null,
    scheduleRecoveryRequired:
      outcome === "succeeded"
        ? scheduleRecoveryRequired
        : false,
  });
}

function createFreeAgentDraftReadinessService({
  clock,
  readRepository,
  repository,
  scheduleRecoveryServiceFactory =
    createFreeAgentDraftScheduleRecoveryService,
  scheduleRepository,
  secureRandom,
} = {}) {
  requireMethod(clock, "nowMs", "a UTC clock");
  requireMethod(
    readRepository,
    "readOpeningPreflightContext",
    "the FAD opening-preflight reader"
  );
  requireMethod(
    repository,
    "blockReadinessOperation",
    "the FAD readiness blocker repository"
  );
  requireMethod(
    repository,
    "commitOpening",
    "the atomic FAD opening repository"
  );
  requireMethod(
    scheduleRepository,
    "readShiftContext",
    "the matchup schedule-shift reader"
  );
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );
  if (typeof scheduleRecoveryServiceFactory !== "function") {
    throw new TypeError(
      "FAD readiness execution requires schedule recovery composition"
    );
  }

  function persistBlockedReadiness({
    allocateId,
    attemptId = null,
    attemptNumber,
    attemptProjection,
    execution,
    internalBlockers,
    observedAtMs,
  }) {
    if (
      !Array.isArray(internalBlockers) ||
      internalBlockers.length < 1 ||
      !isPlainObject(attemptProjection)
    ) {
      failState(
        "transactional_blocker_result_invalid"
      );
    }
    const blockedAtMs = terminalTimestamp(
      clock,
      execution,
      observedAtMs
    );
    const attempt =
      createReadinessAttemptCommand({
        id: attemptId ?? allocateId(),
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        readinessOperationId:
          execution.readinessOperationId,
        jobRunId: execution.jobExecution.runId,
        attemptNumber,
        observedReadinessVersion:
          execution.jobExecution.expectedVersion,
        outcome: "blocked",
        observedAtMs,
        recordedAtMs: blockedAtMs,
        projection: attemptProjection,
      });
    const nextRetryAtMs =
      blockedAtMs +
      FREE_AGENT_DRAFT_READINESS_MINIMUM_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(nextRetryAtMs)) {
      failState("next_retry_timestamp_invalid");
    }
    const result = repository.blockReadinessOperation({
      leagueId: execution.leagueId,
      seasonId: execution.seasonId,
      occurrenceKey: execution.occurrenceKey,
      expectedVersion:
        execution.jobExecution.expectedVersion,
      blockers: internalBlockers,
      blockedAtMs,
      nextRetryAtMs,
      notificationId: allocateId(),
      jobExecution: execution.jobExecution,
      attempt,
    });
    return terminalResult(result, {
      attemptId: attempt.id,
      fadId: null,
      nextRetryAtMs,
      outcome: "blocked",
      readinessOperationId:
        execution.readinessOperationId,
      scheduleRecoveryRequired: false,
    });
  }

  function executePreparedReadiness(
    execution,
    freshnessReplanCount,
    allocateId
  ) {
    const context =
      readRepository.readOpeningPreflightContext({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
      });
    requireClaimedContext(context, execution);
    const observedAtMs = safeTimestamp(
      clock.nowMs(),
      "clock_timestamp_invalid"
    );
    if (
      execution.jobExecution.leaseExpiresAtMs <=
      observedAtMs
    ) {
      failInput("claimed_lease_expired");
    }
    const inspection =
      inspectFreeAgentDraftOpeningReadiness({
        context,
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        occurrenceKey: execution.occurrenceKey,
        observedAtMs,
      });
    const attemptNumber =
      context.readinessOperation.attemptCount;

    if (!inspection.readyForSchedulePlanning) {
      const finalized =
        finalizeFreeAgentDraftOpeningReadiness({
          inspection,
          openedAtMs: null,
          targetSchedule: null,
        });
      return persistBlockedReadiness({
        allocateId,
        attemptNumber,
        attemptProjection:
          finalized.attemptProjection,
        execution,
        internalBlockers:
          finalized.internalBlockers,
        observedAtMs,
      });
    }

    const fadId = allocateId();
    const shiftContext =
      scheduleRepository.readShiftContext({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
      });
    const recoveryContext = scheduleRecoveryContext({
      context,
      fadId,
      inspection,
      openedAtMs: observedAtMs,
      shiftContext,
    });
    const scheduleRecoveryService =
      scheduleRecoveryServiceFactory({
        secureRandom: Object.freeze({
          id: allocateId,
        }),
      });
    requireMethod(
      scheduleRecoveryService,
      "planRecovery",
      "the FAD schedule recovery planner"
    );
    const scheduleRecoveryPlan =
      scheduleRecoveryService.planRecovery(
        recoveryContext
      );
    const targetSchedule = targetScheduleFromPlan(
      scheduleRecoveryPlan,
      inspection
    );
    const finalized =
      finalizeFreeAgentDraftOpeningReadiness({
        inspection,
        openedAtMs: observedAtMs,
        targetSchedule,
      });
    if (
      finalized.outcome !== "succeeded" ||
      finalized.opening === null
    ) {
      failState("successful_opening_projection_missing");
    }
    const attempt =
      createReadinessAttemptCommand({
        id: allocateId(),
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        readinessOperationId:
          execution.readinessOperationId,
        jobRunId: execution.jobExecution.runId,
        attemptNumber,
        observedReadinessVersion:
          execution.jobExecution.expectedVersion,
        outcome: "succeeded",
        observedAtMs,
        recordedAtMs: observedAtMs,
        projection: finalized.attemptProjection,
      });
    const participants =
      finalized.opening.participantBindings.map(
        ({ teamId }) =>
          Object.freeze({
            teamId,
            participantId: allocateId(),
            cardId: allocateId(),
            notificationId: allocateId(),
          })
      );
    const evidence = Object.freeze({
      fadId,
      participants: Object.freeze(participants),
      reminderJobRunId: allocateId(),
      deadlineJobRunId: allocateId(),
      rolloverIds: Object.freeze(
        Array.from({ length: 7 }, allocateId)
      ),
      rolloverJobRunIds: Object.freeze(
        Array.from({ length: 7 }, allocateId)
      ),
      activityId: allocateId(),
      outboxEventId: allocateId(),
      outboxAudienceId: allocateId(),
    });
    const opening = finalized.opening;
    const currentSchedule = Object.freeze({
      operationId: opening.currentSchedule.operationId,
      version: opening.currentSchedule.version,
      weekOneMatchupWeekId:
        opening.currentSchedule.weekOneMatchupWeekId,
      weekOneStartsAtMs:
        opening.currentSchedule.weekOneStartsAtMs,
    });
    const terminalCheckAtMs = terminalTimestamp(
      clock,
      execution,
      observedAtMs
    );
    if (
      terminalCheckAtMs >=
      opening.clock.candidateDeadlineAtMs
    ) {
      if (
        freshnessReplanCount >=
        FREE_AGENT_DRAFT_READINESS_MAXIMUM_FRESHNESS_REPLANS
      ) {
        failState(
          "candidate_deadline_crossed_during_replanning"
        );
      }
      return executePreparedReadiness(
        execution,
        freshnessReplanCount + 1,
        allocateId
      );
    }
    const result = repository.commitOpening({
      leagueId: execution.leagueId,
      seasonId: execution.seasonId,
      occurrenceKey: execution.occurrenceKey,
      readinessOperationId:
        execution.readinessOperationId,
      expectedReadinessVersion:
        execution.jobExecution.expectedVersion,
      openedAtMs: observedAtMs,
      setupPath: opening.setup.setupPath,
      entryDraftId: opening.setup.entryDraftId,
      setupExemptionId:
        opening.setup.setupExemptionId,
      priorSeasonRolloverId:
        opening.setup.priorSeasonRolloverId,
      noDraftReason: opening.setup.noDraftReason,
      schedule: currentSchedule,
      scheduleRecoveryPlan:
        opening.scheduleRecoveryRequired
          ? scheduleRecoveryPlan
          : null,
      carryoverProjection:
        opening.carryoverProjection,
      evidence,
      jobExecution: execution.jobExecution,
      attempt,
    });
    if (result?.openingBlocked === true) {
      if (
        !isPlainObject(result) ||
        result.replayed !== false ||
        !isPlainObject(result.readiness) ||
        result.readiness.id !==
          execution.readinessOperationId ||
        result.readiness.status !== "running" ||
        result.readiness.version !==
          execution.jobExecution.expectedVersion ||
        result.observedAtMs !== observedAtMs
      ) {
        failState(
          "transactional_blocker_result_invalid"
        );
      }
      return persistBlockedReadiness({
        allocateId,
        attemptId: attempt.id,
        attemptNumber,
        attemptProjection:
          result.attemptProjection,
        execution,
        internalBlockers:
          result.internalBlockers,
        observedAtMs: result.observedAtMs,
      });
    }
    return terminalResult(result, {
      attemptId: attempt.id,
      fadId,
      nextRetryAtMs: null,
      outcome: "succeeded",
      readinessOperationId:
        execution.readinessOperationId,
      scheduleRecoveryRequired:
        opening.scheduleRecoveryRequired,
    });
  }

  function executeClaimedReadiness(input = {}) {
    const execution = normalizeExecution(input);
    return executePreparedReadiness(
      execution,
      0,
      createIdAllocator(
        secureRandom,
        [
          execution.leagueId,
          execution.seasonId,
          execution.readinessOperationId,
          execution.jobExecution.runId,
        ]
      )
    );
  }

  return Object.freeze({ executeClaimedReadiness });
}

module.exports = {
  FREE_AGENT_DRAFT_READINESS_MINIMUM_RETRY_DELAY_MS,
  FREE_AGENT_DRAFT_READINESS_SERVICE_CODES,
  FreeAgentDraftReadinessServiceError,
  createFreeAgentDraftReadinessService,
};
