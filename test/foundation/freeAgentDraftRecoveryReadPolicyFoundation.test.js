"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_RECOVERY_READ_CODES,
  projectFreeAgentDraftRecoveryRead,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftRecoveryReadPolicy"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  deadlineJob: uuid(4),
  allocation: uuid(5),
  allocationJob: uuid(6),
  queue: uuid(7),
  queueJob: uuid(8),
  recovery: uuid(9),
  rollover: uuid(10),
  scheduleOperation: uuid(11),
  oldWeek: uuid(12),
  newWeek: uuid(13),
  matchup: uuid(14),
  oldJob: uuid(15),
  newJob: uuid(16),
});

function operation(overrides = {}) {
  return {
    operationId: IDS.deadlineJob,
    operationKind: "deadline",
    resourceId: IDS.fad,
    occurrenceKey: `fad:${IDS.fad}:deadline:400`,
    status: "pending",
    attemptCount: 0,
    scheduledForMs: 400,
    nextAttemptAtMs: null,
    leaseExpiresAtMs: null,
    startedAtMs: null,
    completedAtMs: null,
    lastErrorCode: null,
    recoveryId: null,
    blocksCompletion: true,
    version: 1,
    ...overrides,
  };
}

function initialRollovers() {
  return Array.from({ length: 7 }, (_, index) => ({
    rolloverId: uuid(100 + index),
    sequence: index + 1,
    opensAtMs: 400 + index * 100,
    creationCutoffAtMs: 450 + index * 100,
    rollsOverAtMs: 500 + index * 100,
    status: "scheduled",
    processingStartedAtMs: null,
    completedAtMs: null,
    lastErrorCode: null,
    recoveryIds: [],
    blocksCompletion: true,
    version: 1,
  }));
}

function initialActions() {
  return Array.from({ length: 7 }, (_, index) => ({
    action: "finalize_rollover",
    resourceId: uuid(100 + index),
    enabled: false,
    reasonCode: "RECOVERY_NOT_AVAILABLE",
  }));
}

function projection(overrides = {}) {
  return {
    fad: {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      version: 1,
      status: "cards_open",
      phase: "cards_open",
      openedAtMs: 100,
      reminderAtMs: 200,
      helpOpensAtMs: 300,
      candidateDeadlineAtMs: 400,
      deadlineLockedAtMs: null,
      allocationCompletedAtMs: null,
      nextRolloverAtMs: null,
      frozenFadFirstMatchupStartsAtMs: 1_100,
      competitionFirstMatchupStartsAtMs: 1_100,
      scheduleRecoveryOperationId: null,
      completedAtMs: null,
      counts: {
        participatingTeams: 0,
        cardsLocked: 0,
        allocationsPending: 0,
        allocationsAutomatic: 0,
        restrictedPending: 0,
        restrictedFallbackPending: 0,
        rapidAuctionsOpen: 0,
        queuedNominations: 0,
        rolloversPersisted: 7,
        rolloversCompleted: 0,
        recoveriesOpen: 0,
      },
    },
    deadlineOperation: null,
    allocationOperations: [],
    rapidOperations: [],
    completionOperation: null,
    rollovers: initialRollovers(),
    recoveries: [],
    availableActions: initialActions(),
    ...overrides,
  };
}

function assertProjectionInvalid(candidate, reasonCode) {
  assert.throws(
    () => projectFreeAgentDraftRecoveryRead(candidate),
    (error) =>
      error.code ===
        FREE_AGENT_DRAFT_RECOVERY_READ_CODES
          .projectionInvalid &&
      error.reasonCode === reasonCode
  );
}

describe("FAD-11 recovery-read projection policy", () => {
  test("accepts nullable durable singleton operations and deeply freezes the exact DTO", () => {
    const result = projectFreeAgentDraftRecoveryRead(
      projection()
    );

    assert.deepEqual(Object.keys(result), [
      "fad",
      "deadlineOperation",
      "allocationOperations",
      "rapidOperations",
      "completionOperation",
      "rollovers",
      "recoveries",
      "availableActions",
    ]);
    assert.equal(result.deadlineOperation, null);
    assert.equal(result.completionOperation, null);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.fad.counts));
    assert.ok(Object.isFrozen(result.availableActions));
  });

  test("enforces the closed singleton and collection operation partitions", () => {
    const deadline = operation();
    const allocation = operation({
      operationId: IDS.allocationJob,
      operationKind: "allocation",
      resourceId: IDS.allocation,
      occurrenceKey: `fad:${IDS.fad}:allocate:${uuid(90)}`,
    });
    const queue = operation({
      operationId: IDS.queueJob,
      operationKind: "queued_nomination_activation",
      resourceId: IDS.queue,
      occurrenceKey: `fad:${IDS.fad}:nomination-open:${IDS.queue}:400`,
    });

    const result = projectFreeAgentDraftRecoveryRead(
      projection({
        deadlineOperation: deadline,
        allocationOperations: [allocation],
        rapidOperations: [queue],
        availableActions: [
          {
            action: "retry_deadline",
            resourceId: null,
            enabled: false,
            reasonCode: "RECOVERY_NOT_AVAILABLE",
          },
          {
            action: "retry_allocation",
            resourceId: IDS.allocation,
            enabled: false,
            reasonCode: "RECOVERY_NOT_AVAILABLE",
          },
          {
            action: "activate_queued_nomination",
            resourceId: IDS.queue,
            enabled: false,
            reasonCode: "RECOVERY_NOT_AVAILABLE",
          },
          ...initialActions(),
        ],
      })
    );
    assert.equal(
      result.deadlineOperation.operationKind,
      "deadline"
    );
    assert.equal(
      result.allocationOperations[0].operationKind,
      "allocation"
    );
    assert.equal(
      result.rapidOperations[0].operationKind,
      "queued_nomination_activation"
    );

    assertProjectionInvalid(
      projection({ allocationOperations: [queue] }),
      "allocation_operations_invalid"
    );
    assertProjectionInvalid(
      projection({
        deadlineOperation: operation({
          resourceId: IDS.allocation,
        }),
      }),
      "singleton_operation_partition_invalid"
    );
  });

  test("requires deterministic strict operation ordering", () => {
    const earlier = operation({
      operationId: IDS.allocationJob,
      operationKind: "allocation",
      resourceId: IDS.allocation,
      occurrenceKey: `fad:${IDS.fad}:allocate:${uuid(90)}`,
      scheduledForMs: 500,
    });
    const later = operation({
      operationId: uuid(20),
      operationKind: "restricted_activation",
      resourceId: uuid(21),
      occurrenceKey: `fad:${IDS.fad}:restricted-activate:${uuid(21)}:600`,
      scheduledForMs: 600,
    });

    assertProjectionInvalid(
      projection({ allocationOperations: [later, earlier] }),
      "allocation_operations_invalid"
    );
  });

  test("projects the approved durable schedule-recovery shape only", () => {
    const completedAtMs = 1_300;
    const candidate = projection({
      fad: {
        ...projection().fad,
        status: "completed",
        phase: "completed",
        competitionFirstMatchupStartsAtMs: 1_200,
        scheduleRecoveryOperationId:
          IDS.scheduleOperation,
        completedAtMs,
      },
      scheduleRecoveryEvidence: {
        operationId: IDS.scheduleOperation,
        status: "succeeded",
        oldWeek1StartsAtMs: 1_100,
        newWeek1StartsAtMs: 1_200,
        oldScheduleVersion: 1,
        newScheduleVersion: 2,
        removedWeekIds: [IDS.oldWeek],
        removedMatchupIds: [IDS.matchup],
        replacedJobs: [
          {
            oldJobId: IDS.oldJob,
            oldOccurrenceKey: "matchup:old:1000",
            newJobId: IDS.newJob,
            newOccurrenceKey: "matchup:new:1100",
          },
        ],
        completedAtMs,
        version: 1,
      },
    });

    const result =
      projectFreeAgentDraftRecoveryRead(candidate);
    assert.deepEqual(
      Object.keys(
        result.scheduleRecoveryEvidence.replacedJobs[0]
      ),
      [
        "oldJobId",
        "oldOccurrenceKey",
        "newJobId",
        "newOccurrenceKey",
      ]
    );
    assert.equal(
      result.scheduleRecoveryEvidence.status,
      "succeeded"
    );
  });

  test("rejects candidate-card, help, bid, draw, queue payload, and any other extra field", () => {
    for (const field of [
      "candidateCard",
      "helpRequest",
      "bids",
      "drawNonce",
      "nominationQueue",
    ]) {
      assertProjectionInvalid(
        { ...projection(), [field]: "private" },
        "recovery_read_fields_invalid"
      );
    }
    assertProjectionInvalid(
      projection({
        deadlineOperation: {
          ...operation(),
          retryPayload: { reason: "private" },
        },
      }),
      "operation_fields_invalid"
    );
  });
});
