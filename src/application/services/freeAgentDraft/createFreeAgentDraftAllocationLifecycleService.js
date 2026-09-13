"use strict";

const {
  UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const SERVICE_CODES = Object.freeze({
  inputInvalid:
    "FAD_ALLOCATION_LIFECYCLE_INPUT_INVALID",
  stateInvalid:
    "FAD_ALLOCATION_LIFECYCLE_STATE_INVALID",
});
const ROOT_FIELDS = Object.freeze([
  "allocationCount",
  "deadlineLockedAtMs",
  "fadId",
  "leagueId",
  "pendingAllocationCount",
  "schedule",
  "seasonId",
  "status",
  "updatedAtMs",
  "version",
]);
const SCHEDULE_FIELDS = Object.freeze([
  "operationId",
  "version",
  "weekOneMatchupWeekId",
  "weekOneStartsAtMs",
]);

class FreeAgentDraftAllocationLifecycleServiceError extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft allocation lifecycle could not be coordinated."
    );
    this.name =
      "FreeAgentDraftAllocationLifecycleServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftAllocationLifecycleServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(SERVICE_CODES.inputInvalid, reasonCode);
}

function failState(reasonCode) {
  fail(SERVICE_CODES.stateInvalid, reasonCode);
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

function exactObject(value, fields, reasonCode) {
  if (!isPlainObject(value)) failInput(reasonCode);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    failInput(reasonCode);
  }
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

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput(reasonCode);
  }
  return value;
}

function nonnegativeInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
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

function normalizeRoot(input) {
  exactObject(
    input,
    ROOT_FIELDS,
    "root_fields_invalid"
  );
  exactObject(
    input.schedule,
    SCHEDULE_FIELDS,
    "schedule_fields_invalid"
  );
  const allocationCount = nonnegativeInteger(
    input.allocationCount,
    "allocation_count_invalid"
  );
  const pendingAllocationCount = nonnegativeInteger(
    input.pendingAllocationCount,
    "pending_allocation_count_invalid"
  );
  if (pendingAllocationCount > allocationCount) {
    failInput("allocation_counts_invalid");
  }
  if (
    !["deadline_locked", "allocating"].includes(
      input.status
    )
  ) {
    failInput("root_status_invalid");
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
    fadId: canonicalId(
      input.fadId,
      "fad_id_invalid"
    ),
    status: input.status,
    version: positiveInteger(
      input.version,
      "root_version_invalid"
    ),
    updatedAtMs: safeTimestamp(
      input.updatedAtMs,
      "root_updated_timestamp_invalid"
    ),
    deadlineLockedAtMs: safeTimestamp(
      input.deadlineLockedAtMs,
      "deadline_locked_timestamp_invalid"
    ),
    allocationCount,
    pendingAllocationCount,
    schedule: Object.freeze({
      operationId: canonicalId(
        input.schedule.operationId,
        "schedule_operation_id_invalid"
      ),
      version: positiveInteger(
        input.schedule.version,
        "schedule_version_invalid"
      ),
      weekOneMatchupWeekId: canonicalId(
        input.schedule.weekOneMatchupWeekId,
        "week_one_id_invalid"
      ),
      weekOneStartsAtMs: safeTimestamp(
        input.schedule.weekOneStartsAtMs,
        "week_one_timestamp_invalid"
      ),
    }),
  });
}

function nextTransition(root) {
  if (root.status === "deadline_locked") {
    if (root.allocationCount === 0) {
      return "rapid";
    }
    if (
      root.pendingAllocationCount ===
      root.allocationCount
    ) {
      return "allocating";
    }
    failState(
      "deadline_locked_allocations_noncanonical"
    );
  }
  if (root.allocationCount === 0) {
    failState("allocating_without_allocations");
  }
  if (root.pendingAllocationCount > 0) {
    return null;
  }
  return "rapid";
}

function requireTransitionResult(result, root, toStatus) {
  if (
    !isPlainObject(result) ||
    typeof result.replayed !== "boolean" ||
    !isPlainObject(result.draft) ||
    result.draft.id !== root.fadId ||
    result.draft.leagueId !== root.leagueId ||
    result.draft.seasonId !== root.seasonId ||
    result.draft.status !== toStatus ||
    result.draft.version !== root.version + 1
  ) {
    failState("transition_result_invalid");
  }
  return result;
}

function createFreeAgentDraftAllocationLifecycleService({
  lifecycleRepository,
  clock,
} = {}) {
  if (
    !lifecycleRepository ||
    typeof lifecycleRepository.advanceStatus !==
      "function"
  ) {
    throw new TypeError(
      "FAD allocation lifecycle coordination requires the lifecycle repository"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "FAD allocation lifecycle coordination requires a UTC clock"
    );
  }

  return Object.freeze({
    coordinateRoot(input = {}) {
      const root = normalizeRoot(input);
      const occurredAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(occurredAtMs) ||
        occurredAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (
        occurredAtMs < root.updatedAtMs ||
        occurredAtMs < root.deadlineLockedAtMs
      ) {
        failState("root_timestamp_in_future");
      }
      const toStatus = nextTransition(root);
      if (toStatus === null) {
        return Object.freeze({
          outcome: "waiting",
          leagueId: root.leagueId,
          seasonId: root.seasonId,
          fadId: root.fadId,
          fromStatus: root.status,
          toStatus: null,
          allocationCount: root.allocationCount,
          pendingAllocationCount:
            root.pendingAllocationCount,
          fadVersion: root.version,
          occurredAtMs,
        });
      }
      const result = lifecycleRepository.advanceStatus({
        leagueId: root.leagueId,
        seasonId: root.seasonId,
        fadId: root.fadId,
        expectedVersion: root.version,
        fromStatus: root.status,
        toStatus,
        occurredAtMs,
        schedule: root.schedule,
        scheduleRecoveryPlan: null,
      });
      if (result && typeof result.then === "function") {
        failState("repository_must_be_synchronous");
      }
      const terminal = requireTransitionResult(
        result,
        root,
        toStatus
      );
      return Object.freeze({
        outcome: terminal.replayed
          ? "replayed"
          : "transitioned",
        leagueId: root.leagueId,
        seasonId: root.seasonId,
        fadId: root.fadId,
        fromStatus: root.status,
        toStatus,
        allocationCount: root.allocationCount,
        pendingAllocationCount:
          root.pendingAllocationCount,
        fadVersion: terminal.draft.version,
        occurredAtMs,
      });
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_ALLOCATION_LIFECYCLE_SERVICE_CODES:
    SERVICE_CODES,
  FreeAgentDraftAllocationLifecycleServiceError,
  createFreeAgentDraftAllocationLifecycleService,
};
