const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftEligibilityOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  CANDIDATE_ELIGIBILITY_REVALIDATION_SERVICE_CODES,
  CandidateEligibilityRevalidationServiceError,
  createCandidateEligibilityRevalidationService,
} = require(
  "../../src/application/services/freeAgentDraft/createCandidateEligibilityRevalidationService"
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
  player: uuid(4),
  sourceOperation: uuid(5),
  occurrence: uuid(6),
  job: uuid(7),
  leaseToken: uuid(8),
});
const SCHEDULED_FOR_MS = 1_000;
const EXECUTED_AT_MS = 2_000;
const LEASE_EXPIRES_AT_MS = 3_000;
const OCCURRENCE_KEY =
  buildFreeAgentDraftEligibilityOccurrenceKey({
    fadId: IDS.fad,
    playerId: IDS.player,
    sourceOperationId: IDS.sourceOperation,
  });

function input(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    occurrenceId: IDS.occurrence,
    playerId: IDS.player,
    sourceOperationId: IDS.sourceOperation,
    sourceProvider: "sportsdataio-live",
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: SCHEDULED_FOR_MS,
    jobExecution: {
      runId: IDS.job,
      leaseOwner: "fad-eligibility-worker",
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function terminal(overrides = {}) {
  return Object.freeze({
    outcome: "succeeded",
    runId: IDS.job,
    occurrenceId: IDS.occurrence,
    playerId: IDS.player,
    affectedCardCount: 2,
    changedCardCount: 1,
    completedAtMs: EXECUTED_AT_MS,
    jobVersion: 3,
    ...overrides,
  });
}

function harness({
  nowMs = EXECUTED_AT_MS,
  writerResult = terminal(),
} = {}) {
  const calls = [];
  const service =
    createCandidateEligibilityRevalidationService({
      writer: {
        executeClaimed(command) {
          calls.push(command);
          return writerResult;
        },
      },
      clock: {
        nowMs() {
          return nowMs;
        },
      },
    });
  return { calls, service };
}

describe(
  "FAD Candidate eligibility revalidation service",
  () => {
    test("samples execution time once and delegates the exact claimed occurrence", () => {
      const { calls, service } = harness();
      assert.deepEqual(
        service
          .executeClaimedEligibilityRevalidation(
            input()
          ),
        terminal()
      );
      assert.deepEqual(calls, [
        {
          ...input(),
          executedAtMs: EXECUTED_AT_MS,
        },
      ]);
    });

    test("accepts a durable no-op terminal result", () => {
      const noOp = terminal({
        affectedCardCount: 0,
        changedCardCount: 0,
      });
      const { service } = harness({
        writerResult: noOp,
      });
      assert.deepEqual(
        service
          .executeClaimedEligibilityRevalidation(
            input()
          ),
        noOp
      );
    });

    test("rejects malformed scope and an expired lease before the writer", () => {
      const malformed = harness();
      assert.throws(
        () =>
          malformed.service
            .executeClaimedEligibilityRevalidation({
              ...input(),
              occurrenceKey: "tampered",
            }),
        (error) =>
          error instanceof
            CandidateEligibilityRevalidationServiceError &&
          error.code ===
            CANDIDATE_ELIGIBILITY_REVALIDATION_SERVICE_CODES
              .inputInvalid
      );
      assert.equal(malformed.calls.length, 0);

      const expired = harness({
        nowMs: LEASE_EXPIRES_AT_MS,
      });
      assert.throws(
        () =>
          expired.service
            .executeClaimedEligibilityRevalidation(
              input()
            ),
        (error) =>
          error instanceof
            CandidateEligibilityRevalidationServiceError &&
          error.code ===
            CANDIDATE_ELIGIBILITY_REVALIDATION_SERVICE_CODES
              .stateInvalid &&
          error.reasonCode ===
            "claimed_lease_expired"
      );
      assert.equal(expired.calls.length, 0);
    });

    test("fails closed on a noncanonical writer terminal result", () => {
      const { service } = harness({
        writerResult: terminal({
          jobVersion: 2,
        }),
      });
      assert.throws(
        () =>
          service
            .executeClaimedEligibilityRevalidation(
              input()
            ),
        (error) =>
          error instanceof
            CandidateEligibilityRevalidationServiceError &&
          error.reasonCode ===
            "terminal_result_invalid"
      );
    });
  }
);
