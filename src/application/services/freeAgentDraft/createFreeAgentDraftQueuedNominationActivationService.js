"use strict";

const {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
  UUID_PATTERN,
  buildFreeAgentDraftNominationOpenOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const SERVICE_CODES = Object.freeze({
  deterministicFailure:
    "FAD_QUEUED_NOMINATION_ACTIVATION_DETERMINISTIC_FAILURE",
  inputInvalid:
    "FAD_QUEUED_NOMINATION_ACTIVATION_INPUT_INVALID",
  stateInvalid:
    "FAD_QUEUED_NOMINATION_ACTIVATION_STATE_INVALID",
});
const DAY_MS = 86_400_000;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INPUT_FIELDS = Object.freeze([
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "openingAtMs",
  "openingRolloverId",
  "playerId",
  "queueId",
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
const ACTIVATION_FIELDS = Object.freeze([
  "activationJobRunId",
  "activationOccurrenceKey",
  "auctionId",
  "fadId",
  "jobRunVersion",
  "jobStatus",
  "leagueId",
  "openingAtMs",
  "openingRolloverId",
  "playerId",
  "queueId",
  "queueVersion",
  "recoveryId",
  "recoveryStatus",
  "recoveryVersion",
  "resolutionRolloverId",
  "seasonId",
  "starterBidId",
  "status",
]);
const TERMINAL_FIELDS = Object.freeze([
  "activatedAtMs",
  "auctionId",
  "drawId",
  "evidence",
  "fadId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "openingAtMs",
  "openingRolloverId",
  "outcome",
  "queueId",
  "queueVersion",
  "replayed",
  "resolutionJobRunId",
  "resolutionRolloverId",
  "resolvesAtMs",
  "seasonId",
  "sourceRecoveryId",
  "starterBidId",
  "validationCode",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "auctionEventId",
  "extensionRolloverId",
]);
const FAILURE_FIELDS = Object.freeze([
  "errorCode",
  "fadId",
  "failedAtMs",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "openingRolloverId",
  "queueId",
  "recorded",
  "recoveryId",
  "recoveryVersion",
  "replayed",
  "seasonId",
]);
const DETERMINISTIC_REPOSITORY_REASONS = Object.freeze(
  new Set([
    "ACTIVATION_LIFECYCLE_CHANGED",
    "ACTIVATION_WINDOW_CLOSED",
  ])
);

class FreeAgentDraftQueuedNominationActivationServiceError
  extends Error {
  constructor(code, reasonCode, { terminalFailure = false } = {}) {
    super(
      "The queued Free Agent Draft nomination could not be activated."
    );
    this.name =
      "FreeAgentDraftQueuedNominationActivationServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
    this.details = Object.freeze({
      reasonCode,
      terminalFailure,
    });
  }
}

function fail(code, reasonCode, options) {
  throw new FreeAgentDraftQueuedNominationActivationServiceError(
    code,
    reasonCode,
    options
  );
}

function failInput(reasonCode) {
  fail(SERVICE_CODES.inputInvalid, reasonCode);
}

function failState(reasonCode) {
  fail(SERVICE_CODES.stateInvalid, reasonCode);
}

function failDeterministic(reasonCode) {
  fail(
    SERVICE_CODES.deterministicFailure,
    reasonCode,
    { terminalFailure: true }
  );
}

function isFreeAgentDraftQueuedNominationActivationTerminalFailure(
  error
) {
  return Boolean(
    error &&
    error.code === SERVICE_CODES.deterministicFailure &&
    error.details?.terminalFailure === true &&
    typeof error.details?.reasonCode === "string"
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

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (field, index) => field === expected[index]
    )
  );
}

function exactInput(value, fields, reasonCode) {
  if (!hasExactFields(value, fields)) failInput(reasonCode);
}

function canonicalId(value, reasonCode) {
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

function safeTimestamp(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 0) {
    failInput(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 1) {
    failInput(reasonCode);
  }
  return value;
}

function distinctIds(values) {
  const ids = values.filter((value) => value !== null);
  return new Set(ids).size === ids.length;
}

function normalizeExecution(input) {
  exactInput(input, INPUT_FIELDS, "execution_fields_invalid");
  exactInput(
    input.jobExecution,
    JOB_EXECUTION_FIELDS,
    "job_execution_fields_invalid"
  );
  const fadId = canonicalId(input.fadId, "fad_id_invalid");
  const queueId = canonicalId(
    input.queueId,
    "queue_id_invalid"
  );
  const openingAtMs = safeTimestamp(
    input.openingAtMs,
    "opening_timestamp_invalid"
  );
  const scheduledForMs = safeTimestamp(
    input.scheduledForMs,
    "scheduled_timestamp_invalid"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "occurrence_key_invalid"
  );
  let expectedOccurrenceKey;
  try {
    expectedOccurrenceKey =
      buildFreeAgentDraftNominationOpenOccurrenceKey({
        fadId,
        queueId,
        rolloverAtMs: openingAtMs,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (
    occurrenceKey !== expectedOccurrenceKey ||
    scheduledForMs !== openingAtMs
  ) {
    failInput("occurrence_scope_invalid");
  }
  const startedAtMs = safeTimestamp(
    input.jobExecution.startedAtMs,
    "started_timestamp_invalid"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.jobExecution.leaseExpiresAtMs,
    "lease_expiry_invalid"
  );
  if (
    startedAtMs < scheduledForMs ||
    leaseExpiresAtMs <= startedAtMs
  ) {
    failInput("job_execution_chronology_invalid");
  }
  return Object.freeze({
    leagueId: canonicalId(
      input.leagueId,
      "league_id_invalid"
    ),
    seasonId: canonicalId(
      input.seasonId,
      "season_id_invalid"
    ),
    fadId,
    queueId,
    playerId: canonicalId(
      input.playerId,
      "player_id_invalid"
    ),
    openingRolloverId: canonicalId(
      input.openingRolloverId,
      "opening_rollover_id_invalid"
    ),
    openingAtMs,
    occurrenceKey,
    scheduledForMs,
    jobExecution: Object.freeze({
      runId: canonicalId(
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
      leaseExpiresAtMs,
      startedAtMs,
      attemptCount: positiveInteger(
        input.jobExecution.attemptCount,
        "attempt_count_invalid"
      ),
      expectedVersion: positiveInteger(
        input.jobExecution.expectedVersion,
        "job_version_invalid"
      ),
    }),
  });
}

function requireActivation(activation, execution) {
  const hasRecovery = activation?.recoveryId !== null;
  if (
    !hasExactFields(activation, ACTIVATION_FIELDS) ||
    activation.leagueId !== execution.leagueId ||
    activation.seasonId !== execution.seasonId ||
    activation.fadId !== execution.fadId ||
    activation.queueId !== execution.queueId ||
    activation.playerId !== execution.playerId ||
    activation.openingRolloverId !==
      execution.openingRolloverId ||
    activation.openingAtMs !== execution.openingAtMs ||
    activation.activationJobRunId !==
      execution.jobExecution.runId ||
    activation.activationOccurrenceKey !==
      execution.occurrenceKey ||
    !Number.isSafeInteger(activation.queueVersion) ||
    activation.queueVersion < 1 ||
    !Number.isSafeInteger(activation.jobRunVersion) ||
    activation.jobRunVersion < 1 ||
    (
      activation.recoveryId !== null &&
      !UUID_PATTERN.test(activation.recoveryId || "")
    ) ||
    (
      hasRecovery
        ? !["running", "resolved"].includes(
            activation.recoveryStatus
          )
        : activation.recoveryStatus !== null
    ) ||
    (
      hasRecovery
        ? (
        !Number.isSafeInteger(activation.recoveryVersion) ||
        activation.recoveryVersion < 1
          )
        : activation.recoveryVersion !== null
    )
  ) {
    failState("activation_state_invalid");
  }
  if (
    activation.status === "queued" &&
    activation.jobStatus === "running" &&
    (
      !hasRecovery ||
      activation.recoveryStatus === "running"
    ) &&
    activation.jobRunVersion ===
      execution.jobExecution.expectedVersion
  ) {
    return Object.freeze({
      expectedQueueVersion: activation.queueVersion,
      expectedJobVersion: activation.jobRunVersion,
      recoveryId: activation.recoveryId,
      recoveryVersion: activation.recoveryVersion,
      replayExpected: false,
    });
  }
  if (
    ["opened", "invalid"].includes(activation.status) &&
    activation.jobStatus === "succeeded" &&
    (
      !hasRecovery ||
      activation.recoveryStatus === "resolved"
    ) &&
    activation.queueVersion > 1 &&
    activation.jobRunVersion > 1 &&
    activation.jobRunVersion - 1 ===
      execution.jobExecution.expectedVersion
  ) {
    return Object.freeze({
      expectedQueueVersion: activation.queueVersion - 1,
      expectedJobVersion: activation.jobRunVersion - 1,
      recoveryId: activation.recoveryId,
      recoveryVersion: activation.recoveryVersion,
      replayExpected: true,
    });
  }
  failState("activation_not_claimed_or_replayable");
}

function currentClock(clock, reasonCode) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    failState(reasonCode);
  }
  return value;
}

function requireTerminal(
  result,
  execution,
  expectation,
  observedAtMs
) {
  const evidence = result?.evidence;
  const opened = result?.outcome === "opened";
  const invalidOutcome = result?.outcome === "invalid";
  if (
    !hasExactFields(result, TERMINAL_FIELDS) ||
    (!opened && !invalidOutcome) ||
    result.leagueId !== execution.leagueId ||
    result.seasonId !== execution.seasonId ||
    result.fadId !== execution.fadId ||
    result.queueId !== execution.queueId ||
    result.openingRolloverId !==
      execution.openingRolloverId ||
    result.openingAtMs !== execution.openingAtMs ||
    !Number.isSafeInteger(result.activatedAtMs) ||
    result.activatedAtMs < execution.openingAtMs ||
    result.activatedAtMs > observedAtMs ||
    (
      !expectation.replayExpected &&
      result.activatedAtMs !== observedAtMs
    ) ||
    result.queueVersion !==
      expectation.expectedQueueVersion + 1 ||
    result.jobRunId !== execution.jobExecution.runId ||
    result.jobRunVersion !==
      expectation.expectedJobVersion + 1 ||
    typeof result.replayed !== "boolean" ||
    (
      expectation.replayExpected
        ? result.replayed !== true
        : result.replayed !== false
    ) ||
    (
      result.sourceRecoveryId !== null &&
      !UUID_PATTERN.test(result.sourceRecoveryId || "")
    ) ||
    result.sourceRecoveryId !== expectation.recoveryId ||
    !hasExactFields(evidence, EVIDENCE_FIELDS) ||
    (
      opened
        ? (
            !UUID_PATTERN.test(result.resolutionRolloverId || "") ||
            result.resolvesAtMs !== execution.openingAtMs + DAY_MS ||
            !UUID_PATTERN.test(result.auctionId || "") ||
            !UUID_PATTERN.test(result.starterBidId || "") ||
            !UUID_PATTERN.test(result.drawId || "") ||
            !UUID_PATTERN.test(result.resolutionJobRunId || "") ||
            result.validationCode !== null ||
            !UUID_PATTERN.test(evidence.auctionEventId || "") ||
            (
              evidence.extensionRolloverId !== null &&
              !UUID_PATTERN.test(
                evidence.extensionRolloverId || ""
              )
            ) ||
            !distinctIds([
              execution.leagueId,
              execution.seasonId,
              execution.fadId,
              execution.queueId,
              execution.playerId,
              execution.openingRolloverId,
              execution.jobExecution.runId,
              result.resolutionRolloverId,
              result.auctionId,
              result.starterBidId,
              result.drawId,
              result.resolutionJobRunId,
              result.sourceRecoveryId,
              evidence.auctionEventId,
              evidence.extensionRolloverId,
            ])
          )
        : (
            result.resolutionRolloverId !== null ||
            result.resolvesAtMs !== null ||
            result.auctionId !== null ||
            result.starterBidId !== null ||
            result.drawId !== null ||
            result.resolutionJobRunId !== null ||
            result.validationCode !== "PLAYER_UNAVAILABLE" ||
            evidence.auctionEventId !== null ||
            evidence.extensionRolloverId !== null
          )
    )
  ) {
    failState("terminal_result_invalid");
  }
  return deepFreeze({ ...result });
}

function requireFailure(
  result,
  execution,
  expectation,
  failedAtMs
) {
  if (
    !hasExactFields(result, FAILURE_FIELDS) ||
    result.recorded !== true ||
    result.replayed !== false ||
    result.leagueId !== execution.leagueId ||
    result.seasonId !== execution.seasonId ||
    result.fadId !== execution.fadId ||
    result.queueId !== execution.queueId ||
    result.openingRolloverId !==
      execution.openingRolloverId ||
    result.failedAtMs !== failedAtMs ||
    result.errorCode !==
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE ||
    !UUID_PATTERN.test(result.recoveryId || "") ||
    !Number.isSafeInteger(result.recoveryVersion) ||
    result.recoveryVersion < 1 ||
    (
      expectation.recoveryId !== null &&
      result.recoveryId !== expectation.recoveryId
    ) ||
    result.recoveryVersion !==
      (expectation.recoveryVersion === null
        ? 1
        : expectation.recoveryVersion + 1) ||
    result.jobRunId !== execution.jobExecution.runId ||
    result.jobRunVersion !==
      expectation.expectedJobVersion + 1
  ) {
    failState("failure_result_invalid");
  }
  return deepFreeze({ ...result });
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function executeWriter(repository, execution, expectation, activatedAtMs) {
  try {
    return repository.executeClaimed({
      leagueId: execution.leagueId,
      seasonId: execution.seasonId,
      fadId: execution.fadId,
      queueId: execution.queueId,
      playerId: execution.playerId,
      openingRolloverId: execution.openingRolloverId,
      openingAtMs: execution.openingAtMs,
      occurrenceKey: execution.occurrenceKey,
      expectedQueueVersion:
        expectation.expectedQueueVersion,
      activatedAtMs,
      jobExecution: {
        runId: execution.jobExecution.runId,
        expectedVersion: expectation.expectedJobVersion,
        leaseOwner: execution.jobExecution.leaseOwner,
        leaseToken: execution.jobExecution.leaseToken,
        leaseExpiresAtMs:
          execution.jobExecution.leaseExpiresAtMs,
      },
    });
  } catch (error) {
    if (
      DETERMINISTIC_REPOSITORY_REASONS.has(
        error?.details?.reasonCode
      )
    ) {
      failDeterministic(
        error.details.reasonCode.toLowerCase()
      );
    }
    throw error;
  }
}

function createFreeAgentDraftQueuedNominationActivationService({
  repository,
  clock,
} = {}) {
  if (
    !repository ||
    typeof repository.findActivation !== "function" ||
    typeof repository.executeClaimed !== "function" ||
    typeof repository.recordFailure !== "function"
  ) {
    throw new TypeError(
      "FAD queued-nomination activation requires its durable repository"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "FAD queued-nomination activation requires a UTC clock"
    );
  }

  function load(execution) {
    const activation = repository.findActivation({
      leagueId: execution.leagueId,
      seasonId: execution.seasonId,
      fadId: execution.fadId,
      queueId: execution.queueId,
      rolloverAtMs: execution.openingAtMs,
    });
    if (activation && typeof activation.then === "function") {
      failState("repository_must_be_synchronous");
    }
    return activation;
  }

  return Object.freeze({
    executeClaimedActivation(input = {}) {
      const execution = normalizeExecution(input);
      const expectation = requireActivation(
        load(execution),
        execution
      );
      const activatedAtMs = currentClock(
        clock,
        "clock_timestamp_invalid"
      );
      if (!expectation.replayExpected) {
        if (activatedAtMs < execution.openingAtMs) {
          failState("activation_not_due");
        }
        if (
          activatedAtMs < execution.jobExecution.startedAtMs ||
          activatedAtMs >=
            execution.jobExecution.leaseExpiresAtMs
        ) {
          failState("claimed_lease_expired");
        }
        if (activatedAtMs >= execution.openingAtMs + DAY_MS) {
          failDeterministic("activation_window_closed");
        }
      }
      const result = executeWriter(
        repository,
        execution,
        expectation,
        activatedAtMs
      );
      if (result && typeof result.then === "function") {
        failState("repository_must_be_synchronous");
      }
      return requireTerminal(
        result,
        execution,
        expectation,
        activatedAtMs
      );
    },

    recordClaimedFailure(input = {}) {
      const execution = normalizeExecution(input);
      const expectation = requireActivation(
        load(execution),
        execution
      );
      if (expectation.replayExpected) {
        failState("terminal_failure_already_recorded");
      }
      const failedAtMs = currentClock(
        clock,
        "clock_timestamp_invalid"
      );
      if (
        failedAtMs < execution.jobExecution.startedAtMs ||
        failedAtMs >=
          execution.jobExecution.leaseExpiresAtMs
      ) {
        failState("claimed_lease_expired");
      }
      const result = repository.recordFailure({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        fadId: execution.fadId,
        queueId: execution.queueId,
        playerId: execution.playerId,
        openingRolloverId: execution.openingRolloverId,
        openingAtMs: execution.openingAtMs,
        occurrenceKey: execution.occurrenceKey,
        expectedQueueVersion:
          expectation.expectedQueueVersion,
        failedAtMs,
        errorCode:
          FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
        jobExecution: {
          runId: execution.jobExecution.runId,
          expectedVersion: expectation.expectedJobVersion,
          leaseOwner: execution.jobExecution.leaseOwner,
          leaseToken: execution.jobExecution.leaseToken,
          leaseExpiresAtMs:
            execution.jobExecution.leaseExpiresAtMs,
        },
      });
      if (result && typeof result.then === "function") {
        failState("repository_must_be_synchronous");
      }
      return requireFailure(
        result,
        execution,
        expectation,
        failedAtMs
      );
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES:
    SERVICE_CODES,
  FreeAgentDraftQueuedNominationActivationServiceError,
  createFreeAgentDraftQueuedNominationActivationService,
  isFreeAgentDraftQueuedNominationActivationTerminalFailure,
};
