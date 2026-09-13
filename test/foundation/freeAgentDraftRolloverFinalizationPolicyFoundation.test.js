"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_ROLLOVER_FINALIZATION_POLICY_ERROR_CODE,
  FreeAgentDraftRolloverFinalizationPolicyError,
  evaluateFreeAgentDraftRolloverFinalization,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftRolloverFinalizationPolicy"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const DAY_MS = 86_400_000;
const ROLLOVER_AT_MS = 2_000_000_000_000;
const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  rollover: uuid(4),
  successor: uuid(5),
  auctionOne: uuid(6),
  auctionTwo: uuid(7),
  auctionThree: uuid(8),
  playerOne: uuid(9),
  playerTwo: uuid(10),
  playerThree: uuid(11),
  jobOne: uuid(12),
  jobTwo: uuid(13),
  jobThree: uuid(14),
  recoveryOne: uuid(15),
  recoveryTwo: uuid(16),
  queueOne: uuid(17),
  queueTwo: uuid(18),
  allocation: uuid(19),
  fallbackAuction: uuid(20),
  allocationTwo: uuid(21),
  allocationThree: uuid(22),
  jobFour: uuid(23),
  recoveryThree: uuid(24),
});

function rollover(overrides = {}) {
  return {
    id: IDS.rollover,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    sequence: 7,
    rollsOverAtMs: ROLLOVER_AT_MS,
    status: "processing",
    nowMs: ROLLOVER_AT_MS + 100,
    ...overrides,
  };
}

function auction(index = 1, overrides = {}) {
  const id = IDS[`auction${["One", "Two", "Three"][index - 1]}`];
  const playerId = IDS[`player${["One", "Two", "Three"][index - 1]}`];
  const jobRunId = IDS[`job${["One", "Two", "Three"][index - 1]}`];
  return {
    id,
    playerId,
    status: "resolved",
    resolutionStatus: "succeeded",
    resolutionOutcomeCode: "winner",
    jobStatus: "succeeded",
    recoveryId: null,
    recoveryStatus: null,
    recoveryPlayerId: null,
    recoveryAuctionId: null,
    recoveryJobRunId: null,
    recoveryRolloverId: null,
    ...overrides,
  };
}

function nomination(index = 1, overrides = {}) {
  return {
    id: index === 1 ? IDS.queueOne : IDS.queueTwo,
    playerId: index === 1 ? IDS.playerOne : IDS.playerTwo,
    jobRunId: index === 1 ? IDS.jobOne : IDS.jobTwo,
    status: "invalid",
    openedAuctionId: null,
    validationCode: "PLAYER_UNAVAILABLE",
    jobStatus: "succeeded",
    recoveryId: null,
    recoveryStatus: null,
    ...overrides,
  };
}

function fallback(overrides = {}) {
  return {
    sourceAuctionId: IDS.auctionTwo,
    allocationId: IDS.allocation,
    required: true,
    createdAuctionId: IDS.fallbackAuction,
    successorRolloverId: IDS.successor,
    ...overrides,
  };
}

function recovery(index = 1, overrides = {}) {
  return {
    id: [IDS.recoveryOne, IDS.recoveryTwo, IDS.recoveryThree][
      index - 1
    ],
    kind: "auction_resolution",
    status: "correction_required",
    rolloverId: IDS.rollover,
    auctionId: IDS.auctionOne,
    allocationId: null,
    nominationQueueId: null,
    playerId: IDS.playerOne,
    jobRunId: IDS.jobOne,
    ...overrides,
  };
}

function successor(overrides = {}) {
  return {
    id: IDS.successor,
    sequence: 8,
    predecessorRolloverId: IDS.rollover,
    opensAtMs: ROLLOVER_AT_MS,
    rollsOverAtMs: ROLLOVER_AT_MS + DAY_MS,
    status: "scheduled",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    rollover: rollover(),
    auctions: [],
    nominations: [],
    fallbacks: [],
    recoveries: [],
    successor: null,
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    auctionCount: 0,
    normalAuctionCount: 0,
    recoverableAuctionCount: 0,
    nominationCount: 0,
    terminalNominationCount: 0,
    requiredFallbackCount: 0,
    createdFallbackCount: 0,
    unresolvedCount: 0,
    recoverableUnresolvedCount: 0,
    ...overrides,
  };
}

function result(outcome, reasonCode, evidenceValue) {
  return {
    rolloverId: IDS.rollover,
    fadId: IDS.fad,
    sequence: 7,
    rolloverAtMs: ROLLOVER_AT_MS,
    outcome,
    reasonCode,
    evidence: evidenceValue,
  };
}

function assertInvalid(value) {
  assert.throws(
    () => evaluateFreeAgentDraftRolloverFinalization(value),
    (error) => {
      assert.ok(
        error instanceof
          FreeAgentDraftRolloverFinalizationPolicyError
      );
      assert.equal(
        error.code,
        FREE_AGENT_DRAFT_ROLLOVER_FINALIZATION_POLICY_ERROR_CODE
      );
      return true;
    }
  );
}

describe("FAD rollover finalization policy", () => {
  test("completes an empty due boundary and freezes the exact evidence projection", () => {
    const actual =
      evaluateFreeAgentDraftRolloverFinalization(input());
    assert.deepEqual(
      actual,
      result(
        "completed",
        "boundary_accounted",
        evidence()
      )
    );
    assert.ok(Object.isFrozen(actual));
    assert.ok(Object.isFrozen(actual.evidence));
  });

  test("completes only exact normal auction, nomination, fallback, and successor evidence", () => {
    const actual = evaluateFreeAgentDraftRolloverFinalization(
      input({
        auctions: [
          auction(),
          auction(2, {
            status: "no_winner",
            resolutionOutcomeCode: "no_winner",
          }),
        ],
        nominations: [
          nomination(),
          nomination(2, {
            status: "opened",
            openedAuctionId: IDS.auctionThree,
            validationCode: null,
          }),
        ],
        fallbacks: [fallback()],
        successor: successor(),
      })
    );
    assert.deepEqual(
      actual,
      result(
        "completed",
        "boundary_accounted",
        evidence({
          auctionCount: 2,
          normalAuctionCount: 2,
          nominationCount: 2,
          terminalNominationCount: 2,
          requiredFallbackCount: 1,
          createdFallbackCount: 1,
        })
      )
    );
  });

  test("keeps open work, early clocks, queued nominations, and missing fallback/successor evidence awaiting", () => {
    const cases = [
      input({
        rollover: rollover({ nowMs: ROLLOVER_AT_MS - 1 }),
      }),
      input({
        auctions: [auction(1, {
          status: "open",
          resolutionStatus: null,
          resolutionOutcomeCode: null,
          jobStatus: "running",
        })],
      }),
      input({
        nominations: [nomination(1, {
          status: "queued",
          validationCode: null,
          jobStatus: "pending",
        })],
      }),
      input({
        auctions: [auction(2, {
          status: "no_winner",
          resolutionOutcomeCode: "no_winner",
        })],
        fallbacks: [fallback({ createdAuctionId: null })],
        successor: successor(),
      }),
      input({
        nominations: [nomination(2, {
          status: "opened",
          openedAuctionId: IDS.auctionThree,
          validationCode: null,
        })],
      }),
    ];
    for (const value of cases) {
      const actual =
        evaluateFreeAgentDraftRolloverFinalization(value);
      assert.equal(actual.outcome, "awaiting_data");
      assert.equal(actual.reasonCode, "boundary_work_pending");
      assert.ok(actual.evidence.unresolvedCount >= 1);
    }
  });

  test("marks only an exact failed-auction recovery chain recovery-required", () => {
    const failedAuction = auction(1, {
      status: "failed",
      resolutionStatus: null,
      resolutionOutcomeCode: null,
      jobStatus: "failed",
      recoveryId: IDS.recoveryOne,
      recoveryStatus: "correction_required",
      recoveryPlayerId: IDS.playerOne,
      recoveryAuctionId: IDS.auctionOne,
      recoveryJobRunId: IDS.jobOne,
      recoveryRolloverId: IDS.rollover,
    });
    const actual = evaluateFreeAgentDraftRolloverFinalization(
      input({
        auctions: [failedAuction],
        recoveries: [recovery()],
      })
    );
    assert.deepEqual(
      actual,
      result(
        "recovery_required",
        "boundary_recovery_required",
        evidence({
          auctionCount: 1,
          recoverableAuctionCount: 1,
          unresolvedCount: 1,
          recoverableUnresolvedCount: 1,
        })
      )
    );

    for (const mismatch of [
      { recoveryAuctionId: IDS.auctionTwo },
      { recoveryPlayerId: IDS.playerTwo },
      { recoveryJobRunId: IDS.jobTwo },
      { recoveryRolloverId: IDS.successor },
      { recoveryStatus: "resolved" },
    ]) {
      const mismatched = evaluateFreeAgentDraftRolloverFinalization(
        input({
          auctions: [{ ...failedAuction, ...mismatch }],
          recoveries: [recovery()],
        })
      );
      assert.equal(mismatched.outcome, "awaiting_data");
    }
  });

  test("treats queued activation failure as recoverable only through its exact joined recovery", () => {
    const queued = nomination(1, {
      status: "queued",
      validationCode: null,
      jobStatus: "failed",
      recoveryId: IDS.recoveryOne,
      recoveryStatus: "correction_required",
    });
    const queuedRecovery = recovery(1, {
      kind: "queued_nomination_activation",
      auctionId: null,
      nominationQueueId: IDS.queueOne,
      playerId: IDS.playerOne,
    });
    const actual = evaluateFreeAgentDraftRolloverFinalization(
      input({
        nominations: [queued],
        recoveries: [queuedRecovery],
      })
    );
    assert.equal(actual.outcome, "recovery_required");
    assert.deepEqual(
      actual.evidence,
      evidence({
        nominationCount: 1,
        unresolvedCount: 1,
        recoverableUnresolvedCount: 1,
      })
    );
    for (const mismatch of [
      { kind: "auction_resolution" },
      { nominationQueueId: IDS.queueTwo },
      { playerId: IDS.playerTwo },
      { jobRunId: IDS.jobTwo },
      { rolloverId: IDS.successor },
    ]) {
      assert.equal(
        evaluateFreeAgentDraftRolloverFinalization(
          input({
            nominations: [queued],
            recoveries: [{ ...queuedRecovery, ...mismatch }],
          })
        ).outcome,
        "awaiting_data"
      );
    }
  });

  test("accounts for every unattached nonresolved boundary recovery", () => {
    const boundaryRecoveries = [
      recovery(1, {
        kind: "restricted_activation",
        auctionId: IDS.auctionOne,
        allocationId: IDS.allocation,
      }),
      recovery(2, {
        kind: "fallback_activation",
        auctionId: IDS.auctionTwo,
        allocationId: IDS.allocationTwo,
        playerId: IDS.playerTwo,
        jobRunId: IDS.jobTwo,
      }),
      recovery(3, {
        kind: "allocation_retry",
        auctionId: null,
        allocationId: IDS.allocationThree,
        playerId: IDS.playerThree,
        jobRunId: IDS.jobThree,
      }),
    ];
    const actual = evaluateFreeAgentDraftRolloverFinalization(
      input({ recoveries: boundaryRecoveries })
    );
    assert.deepEqual(
      actual,
      result(
        "recovery_required",
        "boundary_recovery_required",
        evidence({
          unresolvedCount: 3,
          recoverableUnresolvedCount: 3,
        })
      )
    );

    const resolved = evaluateFreeAgentDraftRolloverFinalization(
      input({
        recoveries: boundaryRecoveries.map((item) => ({
          ...item,
          status: "resolved",
        })),
      })
    );
    assert.equal(resolved.outcome, "completed");
  });

  test("does not let the current T142 rollover wrapper recovery block terminal boundary evidence", () => {
    const actual = evaluateFreeAgentDraftRolloverFinalization(
      input({
        recoveries: [recovery(1, {
          kind: "rollover_finalize",
          auctionId: null,
          playerId: null,
          jobRunId: IDS.jobFour,
        })],
      })
    );
    assert.deepEqual(
      actual,
      result(
        "completed",
        "boundary_accounted",
        evidence()
      )
    );
  });

  test("gives any transient pending work precedence over other exact recoveries", () => {
    const actual = evaluateFreeAgentDraftRolloverFinalization(
      input({
        auctions: [auction(1, {
          status: "failed",
          resolutionStatus: null,
          resolutionOutcomeCode: null,
          jobStatus: "failed",
          recoveryId: IDS.recoveryOne,
          recoveryStatus: "correction_required",
          recoveryPlayerId: IDS.playerOne,
          recoveryAuctionId: IDS.auctionOne,
          recoveryJobRunId: IDS.jobOne,
          recoveryRolloverId: IDS.rollover,
        }), auction(2, {
          status: "resolving",
          resolutionStatus: null,
          resolutionOutcomeCode: null,
          jobStatus: "running",
        })],
        recoveries: [recovery()],
      })
    );
    assert.equal(actual.outcome, "awaiting_data");
    assert.equal(actual.evidence.unresolvedCount, 2);
    assert.equal(actual.evidence.recoverableUnresolvedCount, 1);
  });

  test("accepts cancelled auctions as normal only with exact resolved recovery evidence", () => {
    const cancelled = auction(1, {
      status: "cancelled",
      resolutionStatus: "cancelled",
      resolutionOutcomeCode: "recovered",
      jobStatus: "succeeded",
      recoveryId: IDS.recoveryOne,
      recoveryStatus: "resolved",
      recoveryPlayerId: IDS.playerOne,
      recoveryAuctionId: IDS.auctionOne,
      recoveryJobRunId: IDS.jobOne,
      recoveryRolloverId: IDS.rollover,
    });
    const resolved = recovery(1, { status: "resolved" });
    assert.equal(
      evaluateFreeAgentDraftRolloverFinalization(
        input({ auctions: [cancelled], recoveries: [resolved] })
      ).outcome,
      "completed"
    );
    assert.equal(
      evaluateFreeAgentDraftRolloverFinalization(
        input({ auctions: [cancelled], recoveries: [] })
      ).outcome,
      "awaiting_data"
    );
  });

  test("rejects malformed or ambiguous input instead of coercing it", () => {
    assert.equal(
      FREE_AGENT_DRAFT_ROLLOVER_FINALIZATION_POLICY_ERROR_CODE,
      "FAD_ROLLOVER_FINALIZATION_INPUT_INVALID"
    );
    for (const value of [
      {},
      { ...input(), extra: true },
      input({ rollover: rollover({ sequence: 0 }) }),
      input({ auctions: [auction(), auction()] }),
      input({ nominations: [nomination(), nomination()] }),
      input({ recoveries: [recovery(), recovery()] }),
      input({ successor: successor({ sequence: 9 }) }),
      input({ successor: successor({ opensAtMs: ROLLOVER_AT_MS + 1 }) }),
      input({
        rollover: rollover({
          rollsOverAtMs: Number.MAX_SAFE_INTEGER,
          nowMs: Number.MAX_SAFE_INTEGER,
        }),
        successor: successor({
          opensAtMs: Number.MAX_SAFE_INTEGER,
          rollsOverAtMs: Number.MAX_SAFE_INTEGER,
        }),
      }),
    ]) {
      assertInvalid(value);
    }
  });
});
