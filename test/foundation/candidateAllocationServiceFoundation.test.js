"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftAllocationOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  CANDIDATE_ALLOCATION_SERVICE_CODES,
  CandidateAllocationServiceError,
  createCandidateAllocationService,
} = require(
  "../../src/application/services/freeAgentDraft/createCandidateAllocationService"
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
  allocation: uuid(4),
  player: uuid(5),
  run: uuid(6),
  leaseToken: uuid(7),
  decisionEvent: uuid(8),
  activity: uuid(9),
  outbox: uuid(10),
  recovery: uuid(11),
});
const SCHEDULED_FOR_MS = 1_000;
const STARTED_AT_MS = 1_100;
const EXECUTED_AT_MS = 2_000;
const LEASE_EXPIRES_AT_MS = 3_000;
const OCCURRENCE_KEY =
  buildFreeAgentDraftAllocationOccurrenceKey({
    fadId: IDS.fad,
    playerId: IDS.player,
  });

function input(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: SCHEDULED_FOR_MS,
    jobExecution: {
      runId: IDS.run,
      leaseOwner: "fad-allocation-worker",
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: STARTED_AT_MS,
      attemptCount: 1,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function allocation(overrides = {}) {
  return Object.freeze({
    id: IDS.allocation,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    playerId: IDS.player,
    status: "pending",
    decisionCode: null,
    winningSnapshotEntryId: null,
    winningTeamId: null,
    contractId: null,
    ownershipId: null,
    restrictedAuctionId: null,
    fallbackOpenAuctionId: null,
    restrictedMinimum: null,
    accountedAtMs: null,
    lastErrorCode: null,
    createdAtMs: 500,
    updatedAtMs: 500,
    version: 1,
    ...overrides,
  });
}

function terminal(overrides = {}) {
  return Object.freeze({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    occurrenceKey: OCCURRENCE_KEY,
    status: "no_valid_offer",
    decisionCode: "no_valid_offer",
    allocationVersion: 2,
    accountedAtMs: EXECUTED_AT_MS,
    winner: null,
    restrictedAuction: null,
    evidence: {
      offerEventIds: [],
      decisionEventId: IDS.decisionEvent,
      activityId: IDS.activity,
      outboxEventId: IDS.outbox,
    },
    jobRunId: IDS.run,
    jobRunVersion: 3,
    replayed: false,
    ...overrides,
  });
}

function harness({
  allocationResult = allocation(),
  terminalResult = terminal(),
  nowMs = EXECUTED_AT_MS,
} = {}) {
  const calls = [];
  const repository = {
    findAllocation(command) {
      calls.push(["find", command]);
      return allocationResult;
    },
    resolvePending(command) {
      calls.push(["resolve", command]);
      return terminalResult;
    },
  };
  const service = createCandidateAllocationService({
    repository,
    clock: {
      nowMs() {
        calls.push(["clock"]);
        return nowMs;
      },
    },
  });
  return { calls, service };
}

describe("FAD Candidate allocation service", () => {
  test("loads the claimed allocation and forwards exact versions and lease identity", () => {
    const { calls, service } = harness();

    assert.deepEqual(
      service.executeClaimedAllocation(input()),
      terminal()
    );
    assert.deepEqual(calls, [
      [
        "find",
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          playerId: IDS.player,
        },
      ],
      ["clock"],
      [
        "resolve",
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          playerId: IDS.player,
          expectedAllocationVersion: 1,
          jobRunId: IDS.run,
          expectedJobVersion: 2,
          leaseOwner: "fad-allocation-worker",
          leaseToken: IDS.leaseToken,
          nowMs: EXECUTED_AT_MS,
        },
      ],
    ]);
  });

  test("accepts correction-required as a processed terminal result", () => {
    const correction = terminal({
      status: "correction_required",
      decisionCode: null,
      accountedAtMs: null,
      recovery: {
        id: IDS.recovery,
        kind: "allocation_retry",
        status: "correction_required",
        errorCode:
          "FAD_ALLOCATION_PLAYER_OWNED",
        jobRunId: IDS.run,
      },
    });
    const { service } = harness({
      terminalResult: correction,
    });

    assert.deepEqual(
      service.executeClaimedAllocation(input()),
      correction
    );
  });

  test("delegates exact durable replay against the preceding allocation version", () => {
    const persisted = allocation({
      status: "no_valid_offer",
      decisionCode: "no_valid_offer",
      accountedAtMs: 1_500,
      updatedAtMs: 1_500,
      version: 2,
    });
    const replay = terminal({
      accountedAtMs: 1_500,
      replayed: true,
    });
    const { calls, service } = harness({
      allocationResult: persisted,
      terminalResult: replay,
    });

    assert.deepEqual(
      service.executeClaimedAllocation(input()),
      replay
    );
    assert.equal(
      calls.at(-1)[1].expectedAllocationVersion,
      1
    );
  });

  test("rejects malformed scope and unsupported allocation state before resolution", () => {
    const malformed = harness();
    assert.throws(
      () =>
        malformed.service.executeClaimedAllocation({
          ...input(),
          occurrenceKey: "tampered",
        }),
      (error) =>
        error instanceof CandidateAllocationServiceError &&
        error.code ===
          CANDIDATE_ALLOCATION_SERVICE_CODES
            .inputInvalid
    );
    assert.equal(malformed.calls.length, 0);

    const unsupported = harness({
      allocationResult: allocation({
        status: "restricted_fallback_open",
        updatedAtMs: 1_500,
        version: 2,
      }),
    });
    assert.throws(
      () =>
        unsupported.service
          .executeClaimedAllocation(input()),
      (error) =>
        error instanceof CandidateAllocationServiceError &&
        error.reasonCode ===
          "allocation_not_pending_or_replayable"
    );
    assert.equal(
      unsupported.calls.some(
        ([name]) => name === "resolve"
      ),
      false
    );
  });

  test("rejects a not-due execution and an expired lease after the authoritative read", () => {
    const early = harness({
      nowMs: SCHEDULED_FOR_MS - 1,
    });
    assert.throws(
      () =>
        early.service.executeClaimedAllocation(input()),
      (error) =>
        error instanceof CandidateAllocationServiceError &&
        error.reasonCode === "allocation_not_due"
    );
    assert.deepEqual(
      early.calls.map(([name]) => name),
      ["find", "clock"]
    );

    const expired = harness({
      nowMs: LEASE_EXPIRES_AT_MS,
    });
    assert.throws(
      () =>
        expired.service.executeClaimedAllocation(
          input()
        ),
      (error) =>
        error instanceof CandidateAllocationServiceError &&
        error.reasonCode === "claimed_lease_expired"
    );
    assert.deepEqual(
      expired.calls.map(([name]) => name),
      ["find", "clock"]
    );
  });

  test("fails closed on a malformed allocation or terminal projection", () => {
    const malformedState = harness({
      allocationResult: {
        ...allocation(),
        leagueId: uuid(99),
      },
    });
    assert.throws(
      () =>
        malformedState.service
          .executeClaimedAllocation(input()),
      (error) =>
        error instanceof CandidateAllocationServiceError &&
        error.reasonCode === "allocation_state_invalid"
    );

    const malformedTerminal = harness({
      terminalResult: terminal({
        jobRunVersion: 2,
      }),
    });
    assert.throws(
      () =>
        malformedTerminal.service
          .executeClaimedAllocation(input()),
      (error) =>
        error instanceof CandidateAllocationServiceError &&
        error.reasonCode === "terminal_result_invalid"
    );
  });

  test("validates required synchronous collaborators", () => {
    assert.throws(
      () => createCandidateAllocationService(),
      /durable repository/
    );
    assert.throws(
      () =>
        createCandidateAllocationService({
          repository: {
            findAllocation() {},
            resolvePending() {},
          },
        }),
      /UTC clock/
    );

    const { service } = harness({
      allocationResult: Promise.resolve(allocation()),
    });
    assert.throws(
      () => service.executeClaimedAllocation(input()),
      (error) =>
        error instanceof CandidateAllocationServiceError &&
        error.reasonCode ===
          "repository_must_be_synchronous"
    );
  });
});
