"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftAuctionResolutionWriter"
);
const {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE,
  JOB_NAME,
  createResolveFreeAgentDraftAuctionsJob,
} = require(
  "../../src/jobs/definitions/resolveFreeAgentDraftAuctions"
);

const NOW_MS = Date.parse(
  "2026-08-10T19:00:00.000Z"
);
const LEASE_EXPIRES_AT_MS = NOW_MS + 60_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  allocationA: uuid(4),
  playerA: uuid(5),
  rollover: uuid(6),
  auctionA: uuid(7),
  jobA: uuid(8),
  tokenA: uuid(9),
  allocationB: uuid(10),
  playerB: uuid(11),
  auctionB: uuid(12),
  jobB: uuid(13),
  tokenB: uuid(14),
  resolutionA: uuid(15),
  resolutionB: uuid(16),
  fallbackAuction: uuid(17),
  bid: uuid(18),
  team: uuid(19),
  contract: uuid(20),
  ownership: uuid(21),
  offerA: uuid(22),
  offerB: uuid(23),
  state: uuid(24),
  activity: uuid(25),
  fadOutbox: uuid(26),
  auctionOutbox: uuid(27),
  lock: uuid(28),
  recovery: uuid(29),
  recoveryState: uuid(30),
  failureEvent: uuid(31),
});

function dueDescriptor(overrides = {}) {
  const auctionId = overrides.auctionId || IDS.auctionA;
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId:
      overrides.allocationId || IDS.allocationA,
    allocationVersion: 9,
    playerId: overrides.playerId || IDS.playerA,
    rolloverId: IDS.rollover,
    auctionId,
    auctionVersion: 7,
    auctionStatus: "open",
    resolvesAtMs: NOW_MS,
    occurrenceKey: `auction:${auctionId}:${NOW_MS}`,
    jobRunId: IDS.jobA,
    jobRunVersion: 1,
    jobStatus: "pending",
    attemptCount: 0,
    ...overrides,
  };
}

function claimedProjection(due, claimInput, overrides = {}) {
  const missingJob = due.jobRunId === null;
  return {
    acquired: true,
    leagueId: due.leagueId,
    seasonId: due.seasonId,
    fadId: due.fadId,
    allocationId: due.allocationId,
    allocationVersion:
      due.allocationId === null
        ? 0
        : due.allocationVersion +
          (due.auctionStatus === "failed" ? 1 : 0),
    playerId: due.playerId,
    rolloverId: due.rolloverId,
    auctionId: due.auctionId,
    auctionVersion:
      due.auctionVersion +
      (due.auctionStatus === "resolving" ? 0 : 1),
    resolvesAtMs: due.resolvesAtMs,
    occurrenceKey: due.occurrenceKey,
    jobRunId: claimInput.jobExecution.runId,
    jobRunVersion: missingJob
      ? 2
      : due.jobRunVersion + 1,
    attemptCount: missingJob
      ? 1
      : due.attemptCount + 1,
    leaseOwner: claimInput.jobExecution.leaseOwner,
    leaseToken: claimInput.jobExecution.leaseToken,
    leaseExpiresAtMs:
      claimInput.jobExecution.leaseExpiresAtMs,
    recoveryResumed: due.auctionStatus === "failed",
    recoveryId:
      due.auctionStatus === "failed"
        ? IDS.recovery
        : null,
    recoveryVersion:
      due.auctionStatus === "failed" ? 3 : null,
    recoveryResumeEvidence:
      due.auctionStatus === "failed"
        ? due.allocationId === null
          ? {
              clonedOfferEventIds: [],
              stateEventId: null,
            }
          : {
              clonedOfferEventIds: [
                IDS.offerA,
                IDS.offerB,
              ],
              stateEventId: IDS.recoveryState,
            }
        : null,
    ...overrides,
  };
}

function completedResultFromExecution(
  input,
  {
    outcome = "no_winner",
    resolutionId = IDS.resolutionA,
    replayed = false,
  } = {}
) {
  return {
    completed: true,
    replayed,
    outcome,
    leagueId: input.leagueId,
    seasonId: input.seasonId,
    fadId: input.fadId,
    allocationId: input.allocationId,
    allocationVersion:
      input.allocationId === null
        ? 0
        : input.expectedAllocationVersion + 1,
    auctionId: input.auctionId,
    auctionVersion: input.expectedAuctionVersion + 1,
    rolloverId: input.rolloverId,
    occurrenceKey: input.occurrenceKey,
    resolvedAtMs: NOW_MS,
    resolutionId,
    fallbackAuctionId:
      outcome === "restricted_fallback"
        ? IDS.fallbackAuction
        : null,
    jobRunId: input.jobExecution.runId,
    jobRunVersion:
      input.jobExecution.expectedVersion + 1,
    drawReveal: {},
    evidence: {},
    ...(outcome === "winner"
      ? {
          winner: {
            bidId: IDS.bid,
            teamId: IDS.team,
            contractId: IDS.contract,
            ownershipId: IDS.ownership,
          },
          lateLock: {
            status: "completed",
            lockId: IDS.lock,
          },
        }
      : {}),
  };
}

function immutableReplay(due, { outcome = "no_winner" } = {}) {
  const result = {
    completed: true,
    replayed: true,
    outcome,
    leagueId: due.leagueId,
    seasonId: due.seasonId,
    fadId: due.fadId,
    allocationId: due.allocationId,
    allocationVersion: due.allocationId === null
      ? 0
      : due.allocationVersion + 1,
    auctionId: due.auctionId,
    auctionVersion: due.auctionVersion + 1,
    rolloverId: due.rolloverId,
    occurrenceKey: due.occurrenceKey,
    resolvedAtMs: NOW_MS,
    resolutionId: IDS.resolutionA,
    fallbackAuctionId: null,
    jobRunId: due.jobRunId,
    jobRunVersion: due.jobRunVersion + 1,
    drawReveal: {},
    evidence: {},
    ...(outcome === "winner"
      ? {
          winner: {
            bidId: IDS.bid,
            teamId: IDS.team,
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
    value:
      outcome === "winner"
        ? {
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
          }
        : null,
  });
  return result;
}

function failureResult(input) {
  return {
    recorded: true,
    replayed: false,
    errorCode:
      FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE,
    leagueId: input.leagueId,
    seasonId: input.seasonId,
    fadId: input.fadId,
    allocationId: input.allocationId,
    allocationVersion:
      input.allocationId === null
        ? 0
        : input.expectedAllocationVersion + 1,
    playerId: input.playerId,
    rolloverId: input.rolloverId,
    auctionId: input.auctionId,
    auctionVersion: input.expectedAuctionVersion + 1,
    occurrenceKey: input.occurrenceKey,
    failedAtMs: input.failedAtMs,
    jobRunId: input.jobExecution.runId,
    jobRunVersion: input.expectedJobVersion + 1,
    recoveryId: IDS.recovery,
    recoveryVersion: 1,
    failureEventId: IDS.failureEvent,
    evidence: {
      clonedOfferEventIds: input.allocationId === null
        ? []
        : [IDS.offerA, IDS.offerB],
      stateEventId: input.allocationId === null
        ? null
        : IDS.recoveryState,
    },
  };
}

function secureRandom(...values) {
  let index = 0;
  return {
    id() {
      const value = values[index];
      index += 1;
      if (!value) {
        throw new Error("unexpected secure ID request");
      }
      return value;
    },
  };
}

function createJob({
  repository,
  resolutionService,
  random = secureRandom(IDS.tokenA),
  clock = { nowMs: () => NOW_MS },
  logger = { error() {} },
} = {}) {
  return createResolveFreeAgentDraftAuctionsJob({
    repository,
    resolutionService,
    clock,
    secureRandom: random,
    leaseOwner: "fad-12-resolution-worker",
    leaseDurationMs: 60_000,
    batchSize: 10,
    logger,
  });
}

function replayCoordinator() {
  return {
    async coordinateCommittedResolution({ resolution }) {
      const projection = {
        ...resolution,
        ...(resolution.outcome === "winner"
          ? {
              lateLock: {
                status: "completed",
                lockId: IDS.lock,
              },
            }
          : {}),
      };
      return projection;
    },
  };
}

describe("FAD-12 durable auction-resolution runner foundation", () => {
  test("atomically ensures a missing canonical job, propagates the exact claim, and completes it", async () => {
    const due = dueDescriptor({
      jobRunId: null,
      jobRunVersion: null,
      jobStatus: null,
      attemptCount: null,
    });
    const calls = [];
    const repository = {
      listDue(input) {
        calls.push(["listDue", input]);
        return [due];
      },
      claimDue(input) {
        calls.push(["claimDue", input]);
        return claimedProjection(due, input);
      },
      recordFailure(input) {
        calls.push(["recordFailure", input]);
        return failureResult(input);
      },
    };
    const resolutionService = {
      ...replayCoordinator(),
      async executeClaimedResolution(input) {
        calls.push(["executeClaimedResolution", input]);
        return completedResultFromExecution(input);
      },
    };
    const job = createJob({
      repository,
      resolutionService,
      random: secureRandom(IDS.jobA, IDS.tokenA),
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "succeeded",
      due: 1,
      acquired: 1,
      succeeded: 1,
      failed: 0,
      terminalFailed: 0,
      transientFailed: 0,
      skipped: 0,
    });
    assert.deepEqual(calls, [
      ["listDue", { nowMs: NOW_MS, limit: 10 }],
      [
        "claimDue",
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          auctionId: IDS.auctionA,
          occurrenceKey:
            `auction:${IDS.auctionA}:${NOW_MS}`,
          expectedAuctionVersion: 7,
          expectedJobVersion: 0,
          nowMs: NOW_MS,
          jobExecution: {
            runId: IDS.jobA,
            leaseOwner: "fad-12-resolution-worker",
            leaseToken: IDS.tokenA,
            leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
          },
        },
      ],
      [
        "executeClaimedResolution",
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          allocationId: IDS.allocationA,
          playerId: IDS.playerA,
          rolloverId: IDS.rollover,
          auctionId: IDS.auctionA,
          resolvesAtMs: NOW_MS,
          occurrenceKey:
            `auction:${IDS.auctionA}:${NOW_MS}`,
          expectedAuctionVersion: 8,
          expectedAllocationVersion: 9,
          jobExecution: {
            runId: IDS.jobA,
            expectedVersion: 2,
            leaseOwner: "fad-12-resolution-worker",
            leaseToken: IDS.tokenA,
            leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
            startedAtMs: NOW_MS,
            attemptCount: 1,
          },
        },
      ],
    ]);
    assert.equal(
      FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE,
      "auction.resolve.target"
    );
  });

  test("uses an acquired-false immutable winner replay to retry late-lock without repeating resolution persistence", async () => {
    const due = dueDescriptor();
    const replay = immutableReplay(due, {
      outcome: "winner",
    });
    const calls = [];
    const job = createJob({
      repository: {
        listDue() {
          return [due];
        },
        claimDue() {
          return {
            acquired: false,
            reason: "succeeded",
            resolution: replay,
          };
        },
        recordFailure() {
          throw new Error("must not record");
        },
      },
      resolutionService: {
        async executeClaimedResolution() {
          throw new Error("must not execute");
        },
        async coordinateCommittedResolution(input) {
          calls.push(input);
          return {
            ...replay,
            lateLock: {
              status: "awaiting_data",
            },
          };
        },
      },
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "succeeded",
      due: 1,
      acquired: 0,
      succeeded: 0,
      failed: 0,
      terminalFailed: 0,
      transientFailed: 0,
      skipped: 1,
    });
    assert.deepEqual(calls, [
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        allocationId: IDS.allocationA,
        rolloverId: IDS.rollover,
        auctionId: IDS.auctionA,
        resolvesAtMs: NOW_MS,
        occurrenceKey:
          `auction:${IDS.auctionA}:${NOW_MS}`,
        resolution: replay,
      },
    ]);
  });

  test("coordinates an allocation-null immutable winner replay without weakening the linked replay fence", async () => {
    const due = dueDescriptor({
      allocationId: null,
      allocationVersion: 0,
    });
    const replay = immutableReplay(due, {
      outcome: "winner",
    });
    const calls = [];
    const job = createJob({
      repository: {
        listDue() {
          return [due];
        },
        claimDue() {
          return {
            acquired: false,
            reason: "succeeded",
            resolution: replay,
          };
        },
        recordFailure() {
          throw new Error("must not record");
        },
      },
      resolutionService: {
        async executeClaimedResolution() {
          throw new Error("must not execute");
        },
        async coordinateCommittedResolution(input) {
          calls.push(input);
          return {
            ...replay,
            lateLock: { status: "awaiting_data" },
          };
        },
      },
    });

    const summary = await job.run();
    assert.equal(summary.status, "succeeded");
    assert.equal(summary.skipped, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].allocationId, null);
    assert.equal(calls[0].resolution.allocationVersion, 0);
  });

  test("propagates a T-142 physical recovery resume claim without inventing a fresh recovery", async () => {
    const due = dueDescriptor({
      auctionStatus: "failed",
      jobRunVersion: 3,
      jobStatus: "pending",
      attemptCount: 1,
    });
    const serviceCalls = [];
    const repository = {
      listDue() {
        return [due];
      },
      claimDue(input) {
        return claimedProjection(due, input);
      },
      recordFailure(input) {
        return failureResult(input);
      },
    };
    const job = createJob({
      repository,
      resolutionService: {
        ...replayCoordinator(),
        async executeClaimedResolution(input) {
          serviceCalls.push(input);
          return completedResultFromExecution(input);
        },
      },
    });

    const result = await job.run();
    assert.equal(result.status, "succeeded");
    assert.equal(result.succeeded, 1);
    assert.deepEqual(
      {
        expectedAuctionVersion:
          serviceCalls[0].expectedAuctionVersion,
        expectedAllocationVersion:
          serviceCalls[0].expectedAllocationVersion,
        expectedJobVersion:
          serviceCalls[0].jobExecution.expectedVersion,
        attemptCount:
          serviceCalls[0].jobExecution.attemptCount,
      },
      {
        expectedAuctionVersion: 8,
        expectedAllocationVersion: 10,
        expectedJobVersion: 4,
        attemptCount: 2,
      }
    );
  });

  test("executes allocation-null due work and records a repeated terminal failure after an allocation-null T-142 resume", async () => {
    const directDue = dueDescriptor({
      allocationId: null,
      allocationVersion: 0,
    });
    const retryDue = dueDescriptor({
      allocationId: null,
      allocationVersion: 0,
      playerId: IDS.playerB,
      auctionId: IDS.auctionB,
      occurrenceKey:
        `auction:${IDS.auctionB}:${NOW_MS}`,
      auctionStatus: "failed",
      jobRunId: IDS.jobB,
      jobRunVersion: 3,
      jobStatus: "pending",
      attemptCount: 1,
    });
    const dueByAuction = new Map([
      [directDue.auctionId, directDue],
      [retryDue.auctionId, retryDue],
    ]);
    const serviceCalls = [];
    const failureCalls = [];
    const terminalError = new Error("private deterministic details");
    terminalError.details = {
      terminalFailure: true,
      policyCode: "FAD_AUCTION_RESOLUTION_STATE_INVALID",
      reasonCode: "player_already_owned",
    };
    const job = createJob({
      repository: {
        listDue() {
          return [directDue, retryDue];
        },
        claimDue(input) {
          return claimedProjection(
            dueByAuction.get(input.auctionId),
            input
          );
        },
        recordFailure(input) {
          failureCalls.push(input);
          return failureResult(input);
        },
      },
      resolutionService: {
        ...replayCoordinator(),
        async executeClaimedResolution(input) {
          serviceCalls.push(input);
          if (input.auctionId === IDS.auctionB) {
            throw terminalError;
          }
          return completedResultFromExecution(input);
        },
      },
      random: secureRandom(IDS.tokenA, IDS.tokenB),
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "failed",
      due: 2,
      acquired: 2,
      succeeded: 1,
      failed: 1,
      terminalFailed: 1,
      transientFailed: 0,
      skipped: 0,
    });
    assert.equal(serviceCalls[0].allocationId, null);
    assert.equal(serviceCalls[0].expectedAllocationVersion, 0);
    assert.equal(serviceCalls[1].allocationId, null);
    assert.equal(serviceCalls[1].expectedAllocationVersion, 0);
    assert.equal(serviceCalls[1].jobExecution.attemptCount, 2);
    assert.equal(failureCalls.length, 1);
    assert.equal(failureCalls[0].allocationId, null);
    assert.equal(failureCalls[0].expectedAllocationVersion, 0);
  });

  test("records only a marked deterministic terminal execution failure and continues with independent due work", async () => {
    const dueA = dueDescriptor();
    const dueB = dueDescriptor({
      allocationId: IDS.allocationB,
      playerId: IDS.playerB,
      auctionId: IDS.auctionB,
      occurrenceKey:
        `auction:${IDS.auctionB}:${NOW_MS}`,
      jobRunId: IDS.jobB,
    });
    const dueByAuction = new Map([
      [dueA.auctionId, dueA],
      [dueB.auctionId, dueB],
    ]);
    const failureCalls = [];
    const logs = [];
    const repository = {
      listDue() {
        return [dueA, dueB];
      },
      claimDue(input) {
        return claimedProjection(
          dueByAuction.get(input.auctionId),
          input
        );
      },
      recordFailure(input) {
        failureCalls.push(input);
        return failureResult(input);
      },
    };
    const terminalError = new Error(
      "private bid and database details"
    );
    terminalError.details = {
      terminalFailure: true,
      policyCode:
        "FAD_AUCTION_RESOLUTION_STATE_INVALID",
      reasonCode: "player_already_owned",
    };
    const job = createJob({
      repository,
      resolutionService: {
        ...replayCoordinator(),
        async executeClaimedResolution(input) {
          if (input.auctionId === IDS.auctionA) {
            throw terminalError;
          }
          return completedResultFromExecution(input, {
            resolutionId: IDS.resolutionB,
          });
        },
      },
      random: secureRandom(IDS.tokenA, IDS.tokenB),
      logger: {
        error(event, details) {
          logs.push([event, details]);
        },
      },
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "failed",
      due: 2,
      acquired: 2,
      succeeded: 1,
      failed: 1,
      terminalFailed: 1,
      transientFailed: 0,
      skipped: 0,
    });
    assert.equal(failureCalls.length, 1);
    assert.deepEqual(failureCalls[0], {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      allocationId: IDS.allocationA,
      playerId: IDS.playerA,
      rolloverId: IDS.rollover,
      auctionId: IDS.auctionA,
      occurrenceKey:
        `auction:${IDS.auctionA}:${NOW_MS}`,
      expectedAuctionVersion: 8,
      expectedAllocationVersion: 9,
      expectedJobVersion: 2,
      failedAtMs: NOW_MS,
      jobExecution: {
        runId: IDS.jobA,
        leaseOwner: "fad-12-resolution-worker",
        leaseToken: IDS.tokenA,
        leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      },
    });
    assert.deepEqual(logs, [
      [
        "free_agent_draft.auction_resolution_occurrence_failed",
        {
          job: JOB_NAME,
          leagueId: IDS.league,
          fadId: IDS.fad,
          allocationId: IDS.allocationA,
          auctionId: IDS.auctionA,
          jobRunId: IDS.jobA,
          classification: "terminal_recorded",
          failureRecorded: true,
        },
      ],
    ]);
    assert.equal(
      JSON.stringify(logs).includes("private bid"),
      false
    );
  });

  test("leaves an unmarked transient execution failure on its live lease for expired reclaim", async () => {
    const due = dueDescriptor();
    let failureCalls = 0;
    const logs = [];
    const job = createJob({
      repository: {
        listDue() {
          return [due];
        },
        claimDue(input) {
          return claimedProjection(due, input);
        },
        recordFailure() {
          failureCalls += 1;
        },
      },
      resolutionService: {
        ...replayCoordinator(),
        async executeClaimedResolution() {
          const error = new Error(
            "SQLite path and private bid details"
          );
          error.code = "SQLITE_BUSY";
          throw error;
        },
      },
      logger: {
        error(event, details) {
          logs.push([event, details]);
        },
      },
    });

    assert.deepEqual(await job.run(), {
      job: JOB_NAME,
      status: "failed",
      due: 1,
      acquired: 1,
      succeeded: 0,
      failed: 1,
      terminalFailed: 0,
      transientFailed: 1,
      skipped: 0,
    });
    assert.equal(failureCalls, 0);
    assert.equal(logs[0][1].classification, "transient_execution");
    assert.equal(
      JSON.stringify(logs).includes("private bid"),
      false
    );
    assert.equal(
      Object.hasOwn(logs[0][1], "error"),
      false
    );
  });

  test("treats failure-recording lease loss as transient and never fabricates correction evidence", async () => {
    const due = dueDescriptor();
    let recordCalls = 0;
    const times = [
      NOW_MS,
      NOW_MS,
      LEASE_EXPIRES_AT_MS,
    ];
    const terminalError = new Error("deterministic");
    terminalError.details = {
      terminalFailure: true,
      policyCode: "CONTRACT_POLICY_INVALID",
      reasonCode: "contract_invalid",
    };
    const job = createJob({
      repository: {
        listDue() {
          return [due];
        },
        claimDue(input) {
          return claimedProjection(due, input);
        },
        recordFailure() {
          recordCalls += 1;
        },
      },
      resolutionService: {
        ...replayCoordinator(),
        async executeClaimedResolution() {
          throw terminalError;
        },
      },
      clock: {
        nowMs() {
          return times.shift();
        },
      },
    });

    const result = await job.run();
    assert.equal(result.terminalFailed, 0);
    assert.equal(result.transientFailed, 1);
    assert.equal(recordCalls, 0);
  });

  test("fails closed on malformed due work and preserves the local overlap guard", async () => {
    const malformedJob = createJob({
      repository: {
        listDue() {
          return [{ ...dueDescriptor(), extra: true }];
        },
        claimDue() {},
        recordFailure() {},
      },
      resolutionService: {
        ...replayCoordinator(),
        async executeClaimedResolution() {},
      },
    });
    const malformed = await malformedJob.run();
    assert.equal(malformed.job, JOB_NAME);
    assert.equal(malformed.status, "failed");
    assert.match(
      malformed.error.message,
      /noncanonical due descriptor/u
    );

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const due = dueDescriptor();
    const overlapJob = createJob({
      repository: {
        listDue() {
          return [due];
        },
        claimDue(input) {
          return claimedProjection(due, input);
        },
        recordFailure() {},
      },
      resolutionService: {
        ...replayCoordinator(),
        async executeClaimedResolution(input) {
          await gate;
          return completedResultFromExecution(input);
        },
      },
    });
    const first = overlapJob.run();
    assert.equal(overlapJob.isRunning(), true);
    assert.deepEqual(await overlapJob.run(), {
      job: JOB_NAME,
      status: "skipped",
      reason: "overlap",
    });
    release();
    assert.equal((await first).status, "succeeded");
  });

  test("requires the complete durable writer, replay-aware service, clock, identifiers, logger, and bounded configuration", () => {
    assert.throws(
      () => createResolveFreeAgentDraftAuctionsJob(),
      /listDue/u
    );
    const repository = {
      listDue() { return []; },
      claimDue() {},
      recordFailure() {},
    };
    assert.throws(
      () =>
        createResolveFreeAgentDraftAuctionsJob({
          repository,
          resolutionService: {
            executeClaimedResolution() {},
          },
        }),
      /committed resolution replay coordinator/u
    );
    assert.throws(
      () =>
        createResolveFreeAgentDraftAuctionsJob({
          repository,
          resolutionService: {
            executeClaimedResolution() {},
            coordinateCommittedResolution() {},
          },
          clock: { nowMs() {} },
          secureRandom: { id() {} },
          leaseOwner: " ",
          logger: { error() {} },
        }),
      /configuration is invalid/u
    );
  });
});
