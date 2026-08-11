"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_SERVICE_CODES,
  FreeAgentDraftAuctionResolutionServiceError,
  createFreeAgentDraftAuctionResolutionService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftAuctionResolutionService"
);

const RESOLVES_AT_MS = Date.parse(
  "2026-08-10T18:00:00.000Z"
);
const NOW_MS = RESOLVES_AT_MS + 10_000;
const LEASE_EXPIRES_AT_MS = NOW_MS + 60_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  allocation: uuid(4),
  player: uuid(5),
  rollover: uuid(6),
  auction: uuid(7),
  job: uuid(8),
  leaseToken: uuid(9),
  resolution: uuid(10),
  bid: uuid(11),
  team: uuid(12),
  contract: uuid(13),
  ownership: uuid(14),
  offerA: uuid(15),
  offerB: uuid(16),
  state: uuid(17),
  activity: uuid(18),
  fadOutbox: uuid(19),
  auctionOutbox: uuid(20),
  fallbackAuction: uuid(21),
  lock: uuid(22),
  activityOutbox: uuid(23),
  notificationA: uuid(24),
  notificationB: uuid(25),
  notificationOutboxA: uuid(26),
  notificationOutboxB: uuid(27),
  sourceAuctionOutbox: uuid(28),
});

function execution(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    rolloverId: IDS.rollover,
    auctionId: IDS.auction,
    resolvesAtMs: RESOLVES_AT_MS,
    occurrenceKey:
      `auction:${IDS.auction}:${RESOLVES_AT_MS}`,
    expectedAuctionVersion: 7,
    expectedAllocationVersion: 9,
    jobExecution: {
      runId: IDS.job,
      expectedVersion: 5,
      leaseOwner: "fad-12-resolution-worker",
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: NOW_MS - 1_000,
      attemptCount: 1,
    },
    ...overrides,
  };
}

function noSelectionReveal() {
  return {
    algorithmVersion: 1,
    nonceHex: "ab".repeat(32),
    selectionUsed: false,
    orderedBidIds: [],
    orderedTeamIds: [],
    counter: null,
    digestHex: null,
    selectedIndex: null,
    selectedBidId: null,
    selectedTeamId: null,
  };
}

function committedRoster() {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    teamId: IDS.team,
    ownershipWitnesses: [
      {
        ownershipId: IDS.ownership,
        ownershipVersion: 1,
        state: "present",
      },
    ],
  };
}

function terminalResult({
  outcome = "winner",
  replayed = false,
  resolvedAtMs = NOW_MS,
  allocationId = IDS.allocation,
  allocationVersion = allocationId === null ? 0 : 10,
  activityId = outcome === "restricted_fallback"
    ? null
    : IDS.activity,
  notificationIds = outcome === "restricted_fallback"
    ? []
    : [IDS.notificationA],
  outboxEventIds = outcome === "restricted_fallback"
    ? [IDS.auctionOutbox]
    : [
        IDS.fadOutbox,
        IDS.auctionOutbox,
        IDS.activityOutbox,
        IDS.notificationOutboxA,
      ],
  roster = outcome === "winner"
    ? committedRoster()
    : null,
} = {}) {
  const result = {
    completed: true,
    replayed,
    outcome,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId,
    allocationVersion,
    auctionId: IDS.auction,
    auctionVersion: 8,
    rolloverId: IDS.rollover,
    occurrenceKey:
      `auction:${IDS.auction}:${RESOLVES_AT_MS}`,
    resolvedAtMs,
    resolutionId: IDS.resolution,
    fallbackAuctionId:
      outcome === "restricted_fallback"
        ? IDS.fallbackAuction
        : null,
    jobRunId: IDS.job,
    jobRunVersion: 6,
    drawReveal: noSelectionReveal(),
    evidence: {
      clonedOfferEventIds: allocationId === null
        ? []
        : [IDS.offerA, IDS.offerB],
      stateEventId: allocationId === null
        ? null
        : IDS.state,
      activityId,
      notificationIds,
      outboxEventIds,
    },
    ...(outcome === "winner"
      ? {
          winner: {
            bidId: IDS.bid,
            teamId: IDS.team,
            submittedTotalValueCents: 3_000_000,
            submittedTermYears: 3,
            lowestOfferedAavCents: 900_000,
            highestCompetingAavCents: null,
            persistedSecondPriceInputCents: 0,
            finalTotalValueCents: 3_000_000,
            finalAavCents: 1_000_000,
            contractId: IDS.contract,
            ownershipId: IDS.ownership,
          },
        }
      : {}),
  };
  Object.defineProperty(result, "committedRoster", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: roster,
  });
  return result;
}

function createRuntime({
  result = terminalResult(),
  nowMs = NOW_MS,
  coordinator = null,
  repository = null,
} = {}) {
  const calls = [];
  const resolvedRepository = repository || {
    executeClaimed(input) {
      calls.push(["executeClaimed", input]);
      return result;
    },
  };
  const resolvedCoordinator = coordinator || {
    async coordinateCommittedRoster(input) {
      calls.push(["coordinateCommittedRoster", input]);
      return {
        status: "completed",
        lockId: IDS.lock,
      };
    },
  };
  return {
    calls,
    service: createFreeAgentDraftAuctionResolutionService({
      repository: resolvedRepository,
      clock: { nowMs: () => nowMs },
      lateLockCoordinator: resolvedCoordinator,
    }),
  };
}

describe("FAD-12 auction-resolution application service foundation", () => {
  test("passes the exact live claim to the synchronous writer and coordinates a fresh committed winner after commit", async () => {
    const runtime = createRuntime();

    const result = await runtime.service
      .executeClaimedResolution(execution());

    assert.deepEqual(result, {
      ...terminalResult(),
      lateLock: {
        status: "completed",
        lockId: IDS.lock,
      },
    });
    assert.equal(
      Object.hasOwn(result, "committedRoster"),
      false
    );
    assert.deepEqual(runtime.calls, [
      [
        "executeClaimed",
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          playerId: IDS.player,
          rolloverId: IDS.rollover,
          auctionId: IDS.auction,
          occurrenceKey:
            `auction:${IDS.auction}:${RESOLVES_AT_MS}`,
          expectedAuctionVersion: 7,
          expectedAllocationVersion: 9,
          expectedJobVersion: 5,
          resolvedAtMs: NOW_MS,
          jobExecution: {
            runId: IDS.job,
            leaseOwner: "fad-12-resolution-worker",
            leaseToken: IDS.leaseToken,
            leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
          },
        },
      ],
      [
        "coordinateCommittedRoster",
        {
          mutationKind: "fad_auction_resolution",
          teams: [committedRoster()],
        },
      ],
    ]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(runtime.calls[1][1]), true);
    assert.equal(Object.isFrozen(runtime.calls[1][1].teams), true);
  });

  test("preserves the allocation-null version-zero contract through fresh execution, immutable replay, no-winner evidence, and late-lock", async () => {
    const directExecution = execution({
      allocationId: null,
      expectedAllocationVersion: 0,
    });
    const winner = terminalResult({ allocationId: null });
    const runtime = createRuntime({ result: winner });

    const completed = await runtime.service
      .executeClaimedResolution(directExecution);
    assert.equal(completed.allocationId, null);
    assert.equal(completed.allocationVersion, 0);
    assert.deepEqual(completed.evidence.clonedOfferEventIds, []);
    assert.equal(completed.evidence.stateEventId, null);
    assert.deepEqual(completed.lateLock, {
      status: "completed",
      lockId: IDS.lock,
    });
    assert.equal(runtime.calls[0][1].allocationId, null);
    assert.equal(
      runtime.calls[0][1].expectedAllocationVersion,
      0
    );

    const replay = terminalResult({
      allocationId: null,
      replayed: true,
      resolvedAtMs: NOW_MS - 500,
    });
    const replayRuntime = createRuntime();
    const coordinated = await replayRuntime.service
      .coordinateCommittedResolution({
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        allocationId: null,
        rolloverId: IDS.rollover,
        auctionId: IDS.auction,
        resolvesAtMs: RESOLVES_AT_MS,
        occurrenceKey:
          `auction:${IDS.auction}:${RESOLVES_AT_MS}`,
        resolution: replay,
      });
    assert.equal(coordinated.replayed, true);
    assert.equal(coordinated.allocationVersion, 0);
    assert.deepEqual(coordinated.lateLock, {
      status: "completed",
      lockId: IDS.lock,
    });
    assert.equal(
      replayRuntime.calls.some(
        ([kind]) => kind === "executeClaimed"
      ),
      false
    );

    const noWinnerRuntime = createRuntime({
      result: terminalResult({
        allocationId: null,
        outcome: "no_winner",
      }),
    });
    const noWinner = await noWinnerRuntime.service
      .executeClaimedResolution(directExecution);
    assert.equal(noWinner.outcome, "no_winner");
    assert.equal(noWinner.evidence.stateEventId, null);
    assert.equal(Object.hasOwn(noWinner, "lateLock"), false);

    await assert.rejects(
      runtime.service.executeClaimedResolution(
        execution({
          allocationId: null,
          expectedAllocationVersion: 9,
        })
      ),
      (error) =>
        error.reasonCode === "allocation_binding_invalid"
    );
  });

  test("validates exact standalone and multi-recipient notification outbox evidence on fresh execution and replay", async () => {
    const multiRecipientEvidence = {
      activityId: IDS.activity,
      notificationIds: [
        IDS.notificationA,
        IDS.notificationB,
      ],
      outboxEventIds: [
        IDS.fadOutbox,
        IDS.auctionOutbox,
        IDS.activityOutbox,
        IDS.notificationOutboxA,
        IDS.notificationOutboxB,
      ],
    };
    const directExecution = execution({
      allocationId: null,
      expectedAllocationVersion: 0,
    });
    const directResult = terminalResult({
      allocationId: null,
      ...multiRecipientEvidence,
    });
    const directRuntime = createRuntime({
      result: directResult,
    });

    const completed = await directRuntime.service
      .executeClaimedResolution(directExecution);
    assert.deepEqual(
      completed.evidence.notificationIds,
      multiRecipientEvidence.notificationIds
    );
    assert.deepEqual(
      completed.evidence.outboxEventIds,
      multiRecipientEvidence.outboxEventIds
    );
    assert.equal(
      Object.isFrozen(completed.evidence.notificationIds),
      true
    );
    assert.equal(
      Object.isFrozen(completed.evidence.outboxEventIds),
      true
    );

    const replay = terminalResult({
      allocationId: null,
      replayed: true,
      resolvedAtMs: NOW_MS - 500,
      ...multiRecipientEvidence,
    });
    const replayRuntime = createRuntime();
    const coordinated = await replayRuntime.service
      .coordinateCommittedResolution({
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        allocationId: null,
        rolloverId: IDS.rollover,
        auctionId: IDS.auction,
        resolvesAtMs: RESOLVES_AT_MS,
        occurrenceKey:
          `auction:${IDS.auction}:${RESOLVES_AT_MS}`,
        resolution: replay,
      });
    assert.equal(coordinated.replayed, true);
    assert.deepEqual(
      coordinated.evidence,
      completed.evidence
    );

    const staleCardinality = terminalResult({
      allocationId: null,
      ...multiRecipientEvidence,
      outboxEventIds:
        multiRecipientEvidence.outboxEventIds.slice(0, -1),
    });
    await assert.rejects(
      createRuntime({ result: staleCardinality })
        .service.executeClaimedResolution(directExecution),
      (error) =>
        error.reasonCode === "resolution_evidence_invalid"
    );

    const immediateFallback = terminalResult({
      outcome: "restricted_fallback",
      activityId: IDS.activity,
      notificationIds: [
        IDS.notificationA,
        IDS.notificationB,
      ],
      outboxEventIds: [
        IDS.fadOutbox,
        IDS.auctionOutbox,
        IDS.sourceAuctionOutbox,
        IDS.activityOutbox,
        IDS.notificationOutboxA,
        IDS.notificationOutboxB,
      ],
    });
    const fallbackRuntime = createRuntime({
      result: immediateFallback,
    });
    const fallback = await fallbackRuntime.service
      .executeClaimedResolution(execution());
    assert.equal(fallback.outcome, "restricted_fallback");
    assert.deepEqual(
      fallback.evidence.notificationIds,
      [IDS.notificationA, IDS.notificationB]
    );
  });

  test("retries late-lock evaluation for an exact immutable winner replay without changing its durable timestamp", async () => {
    const replayedAtMs = NOW_MS - 500;
    const runtime = createRuntime({
      result: terminalResult({
        replayed: true,
        resolvedAtMs: replayedAtMs,
      }),
    });

    const result = await runtime.service
      .executeClaimedResolution(
        execution({
          jobExecution: {
            ...execution().jobExecution,
            startedAtMs: NOW_MS - 1_000,
          },
        })
      );

    assert.equal(result.replayed, true);
    assert.equal(result.resolvedAtMs, replayedAtMs);
    assert.deepEqual(result.lateLock, {
      status: "completed",
      lockId: IDS.lock,
    });
    assert.equal(
      runtime.calls.filter(
        ([kind]) => kind === "coordinateCommittedRoster"
      ).length,
      1
    );
  });

  test("coordinates a supplied committed winner replay without a repository write, contains late-lock failure, and rejects malformed replay evidence", async () => {
    let repositoryWrites = 0;
    let coordinatorCalls = 0;
    const service =
      createFreeAgentDraftAuctionResolutionService({
        repository: {
          executeClaimed() {
            repositoryWrites += 1;
          },
        },
        clock: { nowMs: () => NOW_MS },
        lateLockCoordinator: {
          async coordinateCommittedRoster() {
            coordinatorCalls += 1;
            throw new Error(
              "late-lock provider details must remain contained"
            );
          },
        },
      });
    const replay = terminalResult({
      replayed: true,
      resolvedAtMs: NOW_MS - 500,
    });
    const input = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      rolloverId: IDS.rollover,
      auctionId: IDS.auction,
      resolvesAtMs: RESOLVES_AT_MS,
      occurrenceKey:
        `auction:${IDS.auction}:${RESOLVES_AT_MS}`,
      resolution: replay,
    };

    const result = await service
      .coordinateCommittedResolution(input);
    assert.equal(result.replayed, true);
    assert.deepEqual(result.lateLock, {
      status: "awaiting_data",
    });
    assert.equal(repositoryWrites, 0);
    assert.equal(coordinatorCalls, 1);

    const malformed = { ...replay };
    await assert.rejects(
      service.coordinateCommittedResolution({
        ...input,
        resolution: malformed,
      }),
      (error) =>
        error instanceof
          FreeAgentDraftAuctionResolutionServiceError &&
        error.code ===
          FREE_AGENT_DRAFT_AUCTION_RESOLUTION_SERVICE_CODES
            .stateInvalid &&
        error.reasonCode === "terminal_result_invalid"
    );
    assert.equal(repositoryWrites, 0);
    assert.equal(coordinatorCalls, 1);
  });

  test("skips late-lock for both terminal non-winner paths", async () => {
    for (const outcome of [
      "no_winner",
      "restricted_fallback",
    ]) {
      const runtime = createRuntime({
        result: terminalResult({ outcome }),
      });
      const result = await runtime.service
        .executeClaimedResolution(execution());

      assert.equal(result.outcome, outcome);
      assert.equal(Object.hasOwn(result, "lateLock"), false);
      assert.deepEqual(
        runtime.calls.map(([kind]) => kind),
        ["executeClaimed"]
      );
    }
  });

  test("contains thrown and malformed late-lock results as awaiting_data after a winner is durable", async () => {
    for (const coordinator of [
      {
        async coordinateCommittedRoster() {
          throw new Error("provider details must not escape");
        },
      },
      {
        async coordinateCommittedRoster() {
          return { status: "unsafe", secret: "value" };
        },
      },
    ]) {
      let committed = false;
      const runtime = createRuntime({
        repository: {
          executeClaimed() {
            committed = true;
            return terminalResult();
          },
        },
        coordinator: {
          async coordinateCommittedRoster(input) {
            assert.equal(committed, true);
            return coordinator.coordinateCommittedRoster(input);
          },
        },
      });

      const result = await runtime.service
        .executeClaimedResolution(execution());
      assert.deepEqual(result.lateLock, {
        status: "awaiting_data",
      });
      assert.equal(result.completed, true);
    }
  });

  test("fails closed on noncanonical input, an expired lease, asynchronous persistence, and malformed terminal pricing", async () => {
    const base = createRuntime();
    await assert.rejects(
      base.service.executeClaimedResolution({
        ...execution(),
        extra: true,
      }),
      (error) =>
        error instanceof
          FreeAgentDraftAuctionResolutionServiceError &&
        error.code ===
          FREE_AGENT_DRAFT_AUCTION_RESOLUTION_SERVICE_CODES
            .inputInvalid &&
        error.reasonCode === "execution_fields_invalid"
    );

    let expiredWriterCalls = 0;
    const expired = createRuntime({
      nowMs: LEASE_EXPIRES_AT_MS,
      repository: {
        executeClaimed() {
          expiredWriterCalls += 1;
          return terminalResult();
        },
      },
    });
    await assert.rejects(
      expired.service.executeClaimedResolution(execution()),
      (error) =>
        error.reasonCode === "claimed_lease_expired"
    );
    assert.equal(expiredWriterCalls, 0);

    const asynchronous = createRuntime({
      repository: {
        executeClaimed() {
          return Promise.resolve(terminalResult());
        },
      },
    });
    await assert.rejects(
      asynchronous.service
        .executeClaimedResolution(execution()),
      (error) =>
        error.reasonCode ===
          "repository_must_be_synchronous"
    );

    const malformedResult = terminalResult();
    malformedResult.winner.finalAavCents = 999_999;
    const malformed = createRuntime({
      result: malformedResult,
    });
    await assert.rejects(
      malformed.service
        .executeClaimedResolution(execution()),
      (error) =>
        error.code ===
          FREE_AGENT_DRAFT_AUCTION_RESOLUTION_SERVICE_CODES
            .stateInvalid &&
        error.reasonCode === "winner_pricing_invalid"
    );
  });

  test("requires the exact durable writer, UTC clock, and late-lock coordinator dependencies", () => {
    assert.throws(
      () =>
        createFreeAgentDraftAuctionResolutionService(),
      /atomic resolution repository/u
    );
    assert.throws(
      () =>
        createFreeAgentDraftAuctionResolutionService({
          repository: { executeClaimed() {} },
        }),
      /UTC clock/u
    );
    assert.throws(
      () =>
        createFreeAgentDraftAuctionResolutionService({
          repository: { executeClaimed() {} },
          clock: { nowMs() {} },
        }),
      /late-lock coordinator/u
    );
  });
});
