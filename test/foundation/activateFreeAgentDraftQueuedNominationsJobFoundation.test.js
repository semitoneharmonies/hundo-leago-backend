"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftNominationOpenOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftQueuedNominationActivationService"
);
const {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftQueuedNominationActivationWriter"
);
const {
  DEFAULT_LEASE_MS,
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE,
  JOB_NAME,
  createActivateFreeAgentDraftQueuedNominationsJob,
} = require(
  "../../src/jobs/definitions/activateFreeAgentDraftQueuedNominations"
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
  rollover: uuid(4),
  resolutionRollover: uuid(5),
  auction: uuid(6),
  bid: uuid(7),
  draw: uuid(8),
  resolutionJob: uuid(9),
  event: uuid(10),
  extension: uuid(11),
  recovery: uuid(12),
  leaseOne: uuid(90),
  leaseTwo: uuid(91),
});
const OPENING_AT_MS = 10_000;
const LISTED_AT_MS = 10_100;
const CLAIMED_AT_MS = 10_200;
const LEASE_OWNER =
  "fad-queued-nomination-activation-runner";
const DAY_MS = 86_400_000;

function descriptor(index = 1, overrides = {}) {
  const runId = uuid(100 + index);
  const queueId = uuid(200 + index);
  const playerId = uuid(300 + index);
  const occurrenceKey =
    buildFreeAgentDraftNominationOpenOccurrenceKey({
      fadId: IDS.fad,
      queueId,
      rolloverAtMs: OPENING_AT_MS,
    });
  const base = {
    runId,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    jobType:
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE,
    occurrenceKey,
    scheduledForMs: OPENING_AT_MS,
    status: "pending",
    attemptCount: 0,
    nextAttemptAtMs: null,
    leaseExpiresAtMs: null,
    startedAtMs: null,
    completedAtMs: null,
    resultJson: null,
    lastErrorCode: null,
    version: 1,
    parsedOccurrence: {
      type: "nomination_open",
      fadId: IDS.fad,
      queueId,
      rolloverAtMs: OPENING_AT_MS,
    },
    binding: {
      type: "nomination_open",
      resourceType: "nomination_queue",
      resourceId: queueId,
      fadId: IDS.fad,
      playerId,
      queueId,
      rolloverId: IDS.rollover,
      rolloverAtMs: OPENING_AT_MS,
    },
  };
  return {
    ...base,
    ...overrides,
  };
}

function claimed(due, command) {
  return {
    ...due,
    status: "running",
    attemptCount: due.attemptCount + 1,
    nextAttemptAtMs: null,
    leaseExpiresAtMs: command.leaseExpiresAtMs,
    startedAtMs: command.nowMs,
    completedAtMs: null,
    resultJson: null,
    lastErrorCode: null,
    version: due.version + 1,
  };
}

function opened(command, overrides = {}) {
  return {
    outcome: "opened",
    leagueId: command.leagueId,
    seasonId: command.seasonId,
    fadId: command.fadId,
    queueId: command.queueId,
    openingRolloverId: command.openingRolloverId,
    resolutionRolloverId: IDS.resolutionRollover,
    openingAtMs: command.openingAtMs,
    activatedAtMs: command.jobExecution.startedAtMs,
    resolvesAtMs: command.openingAtMs + DAY_MS,
    queueVersion: 2,
    auctionId: IDS.auction,
    starterBidId: IDS.bid,
    drawId: IDS.draw,
    resolutionJobRunId: IDS.resolutionJob,
    validationCode: null,
    jobRunId: command.jobExecution.runId,
    jobRunVersion:
      command.jobExecution.expectedVersion + 1,
    sourceRecoveryId: null,
    evidence: {
      auctionEventId: IDS.event,
      extensionRolloverId: IDS.extension,
    },
    replayed: false,
    ...overrides,
  };
}

function invalid(command) {
  return opened(command, {
    outcome: "invalid",
    resolutionRolloverId: null,
    resolvesAtMs: null,
    auctionId: null,
    starterBidId: null,
    drawId: null,
    resolutionJobRunId: null,
    validationCode: "PLAYER_UNAVAILABLE",
    evidence: {
      auctionEventId: null,
      extensionRolloverId: null,
    },
  });
}

function recordedFailure(command, overrides = {}) {
  return {
    recorded: true,
    replayed: false,
    leagueId: command.leagueId,
    seasonId: command.seasonId,
    fadId: command.fadId,
    queueId: command.queueId,
    openingRolloverId: command.openingRolloverId,
    failedAtMs: command.jobExecution.startedAtMs + 1,
    errorCode:
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
    recoveryId: IDS.recovery,
    recoveryVersion: 1,
    jobRunId: command.jobExecution.runId,
    jobRunVersion:
      command.jobExecution.expectedVersion + 1,
    ...overrides,
  };
}

function deterministicFailure() {
  return Object.assign(new Error("private deterministic detail"), {
    code:
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES
        .deterministicFailure,
    details: Object.freeze({
      reasonCode: "activation_lifecycle_changed",
      terminalFailure: true,
    }),
  });
}

function harness({
  due = [descriptor()],
  claimImplementation,
  executeImplementation,
  failureImplementation,
  clockValues = [LISTED_AT_MS, CLAIMED_AT_MS],
  leaseTokens = [IDS.leaseOne, IDS.leaseTwo],
  batchSize,
} = {}) {
  const calls = [];
  let clockIndex = 0;
  let tokenIndex = 0;
  const repository = {
    listDue(command) {
      calls.push(["list", command]);
      return due;
    },
    claim(command) {
      calls.push(["claim", command]);
      if (claimImplementation) {
        return claimImplementation(command, due);
      }
      const source = due.find(
        ({ runId }) => runId === command.runId
      );
      return {
        acquired: true,
        occurrence: claimed(source, command),
      };
    },
  };
  const activationService = {
    async executeClaimedActivation(command) {
      calls.push(["execute", command]);
      if (executeImplementation) {
        return executeImplementation(command, calls);
      }
      return opened(command);
    },
    async recordClaimedFailure(command) {
      calls.push(["failure", command]);
      if (failureImplementation) {
        return failureImplementation(command, calls);
      }
      return recordedFailure(command);
    },
  };
  const job =
    createActivateFreeAgentDraftQueuedNominationsJob({
      repository,
      activationService,
      clock: {
        nowMs() {
          const value =
            clockValues[
              Math.min(
                clockIndex,
                clockValues.length - 1
              )
            ];
          clockIndex += 1;
          return value;
        },
      },
      secureRandom: {
        id() {
          const value =
            leaseTokens[
              Math.min(
                tokenIndex,
                leaseTokens.length - 1
              )
            ];
          tokenIndex += 1;
          calls.push(["id", value]);
          return value;
        },
      },
      leaseOwner: LEASE_OWNER,
      batchSize,
      logger: {
        error(event, details) {
          calls.push(["error", event, details]);
        },
      },
    });
  return { calls, job };
}

function expectedSummary(overrides = {}) {
  return {
    job: JOB_NAME,
    status: "succeeded",
    due: 1,
    acquired: 1,
    succeeded: 1,
    failed: 0,
    terminalFailed: 0,
    transientFailed: 0,
    skipped: 0,
    ...overrides,
  };
}

describe(
  "FAD queued-nomination activation scheduled job",
  () => {
    test("filters other work and forwards the exact claimed queue and lease witness", async () => {
      const other = {
        jobType: "fad_fallback_activation",
        malformedForQueuedActivation: true,
      };
      const nomination = descriptor();
      const { calls, job } = harness({
        due: [other, nomination],
      });

      assert.deepEqual(await job.run(), expectedSummary());
      assert.deepEqual(calls[0], [
        "list",
        { nowMs: LISTED_AT_MS, limit: 25 },
      ]);
      const claim = calls.find(([name]) => name === "claim")[1];
      assert.deepEqual(claim, {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        runId: nomination.runId,
        jobType:
          FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE,
        occurrenceKey: nomination.occurrenceKey,
        scheduledForMs: OPENING_AT_MS,
        expectedVersion: 1,
        leaseOwner: LEASE_OWNER,
        leaseToken: IDS.leaseOne,
        nowMs: CLAIMED_AT_MS,
        leaseExpiresAtMs:
          CLAIMED_AT_MS + DEFAULT_LEASE_MS,
      });
      const execution = calls.find(
        ([name]) => name === "execute"
      )[1];
      assert.deepEqual(execution, {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        queueId: nomination.binding.queueId,
        playerId: nomination.binding.playerId,
        openingRolloverId: IDS.rollover,
        openingAtMs: OPENING_AT_MS,
        occurrenceKey: nomination.occurrenceKey,
        scheduledForMs: OPENING_AT_MS,
        jobExecution: {
          runId: nomination.runId,
          expectedVersion: 2,
          leaseOwner: LEASE_OWNER,
          leaseToken: IDS.leaseOne,
          leaseExpiresAtMs:
            CLAIMED_AT_MS + DEFAULT_LEASE_MS,
          startedAtMs: CLAIMED_AT_MS,
          attemptCount: 1,
        },
      });
    });

    test("treats PLAYER_UNAVAILABLE as a successful terminal invalidation", async () => {
      const { calls, job } = harness({
        executeImplementation: invalid,
      });
      assert.deepEqual(await job.run(), expectedSummary());
      assert.equal(
        calls.filter(([name]) => name === "failure").length,
        0
      );
    });

    test("skips compare-and-set misses and failed correction-required work awaiting T142", async () => {
      const stale = descriptor(1);
      const failed = descriptor(2, {
        status: "failed",
        attemptCount: 1,
        startedAtMs: CLAIMED_AT_MS,
        completedAtMs: CLAIMED_AT_MS + 10,
        lastErrorCode:
          FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
      });
      const { calls, job } = harness({
        due: [failed, stale],
        claimImplementation(command) {
          return {
            acquired: false,
            occurrence: stale,
          };
        },
        clockValues: [LISTED_AT_MS, CLAIMED_AT_MS],
      });
      assert.deepEqual(
        await job.run(),
        expectedSummary({
          due: 2,
          acquired: 0,
          succeeded: 0,
          skipped: 2,
        })
      );
      assert.equal(
        calls.filter(([name]) => name === "claim").length,
        1
      );
      assert.equal(
        calls.filter(([name]) => name === "id").length,
        1
      );
      assert.equal(
        calls.filter(([name]) => name === "execute").length,
        0
      );
    });

    test("records only an explicitly branded deterministic terminal failure", async () => {
      const { calls, job } = harness({
        executeImplementation() {
          throw deterministicFailure();
        },
      });
      assert.deepEqual(
        await job.run(),
        expectedSummary({
          status: "failed",
          succeeded: 0,
          failed: 1,
          terminalFailed: 1,
        })
      );
      const execute = calls.find(
        ([name]) => name === "execute"
      )[1];
      assert.deepEqual(
        calls.find(([name]) => name === "failure")[1],
        execute
      );
      const log = calls.find(([name]) => name === "error");
      assert.deepEqual(log, [
        "error",
        "free_agent_draft.queued_nomination_activation_occurrence_failed",
        {
          job: JOB_NAME,
          leagueId: IDS.league,
          fadId: IDS.fad,
          queueId: descriptor().binding.queueId,
          jobRunId: descriptor().runId,
          classification: "terminal_recorded",
          failureRecorded: true,
        },
      ]);
      const encoded = JSON.stringify(log);
      assert.equal(encoded.includes("private deterministic detail"), false);
      assert.equal(encoded.includes(IDS.leaseOne), false);
      assert.equal(encoded.includes(descriptor().binding.playerId), false);
    });

    test("leaves transient claims for lease reclaim and continues the batch", async () => {
      const first = descriptor(1);
      const second = descriptor(2);
      const { calls, job } = harness({
        due: [first, second],
        clockValues: [
          LISTED_AT_MS,
          CLAIMED_AT_MS,
          CLAIMED_AT_MS + 1,
        ],
        executeImplementation(command) {
          if (command.queueId === first.binding.queueId) {
            throw new Error("secret database constraint");
          }
          return opened(command);
        },
      });
      assert.deepEqual(
        await job.run(),
        expectedSummary({
          status: "failed",
          due: 2,
          acquired: 2,
          failed: 1,
          transientFailed: 1,
        })
      );
      assert.equal(
        calls.filter(([name]) => name === "failure").length,
        0
      );
      assert.equal(
        calls.filter(([name]) => name === "execute").length,
        2
      );
      const log = calls.find(([name]) => name === "error");
      assert.equal(log[2].classification, "transient_execution");
      assert.equal(
        JSON.stringify(log).includes("secret database constraint"),
        false
      );
    });

    test("leaves the claim running when durable failure recording is transient", async () => {
      const { calls, job } = harness({
        executeImplementation() {
          throw deterministicFailure();
        },
        failureImplementation() {
          throw new Error("private rollback cause");
        },
      });
      assert.deepEqual(
        await job.run(),
        expectedSummary({
          status: "failed",
          succeeded: 0,
          failed: 1,
          transientFailed: 1,
        })
      );
      const log = calls.find(([name]) => name === "error");
      assert.equal(
        log[2].classification,
        "terminal_recording_transient"
      );
      assert.equal(log[2].failureRecorded, false);
      assert.equal(
        JSON.stringify(log).includes("private rollback cause"),
        false
      );
    });

    test("fails malformed descriptors, claims, and results closed without stopping later work", async () => {
      const malformed = descriptor(1, {
        binding: {
          ...descriptor(1).binding,
          queueId: uuid(999),
        },
      });
      const valid = descriptor(2);
      const { calls, job } = harness({
        due: [malformed, valid],
        clockValues: [LISTED_AT_MS, CLAIMED_AT_MS],
        executeImplementation(command) {
          return opened(command, { queueVersion: 1 });
        },
      });
      assert.deepEqual(
        await job.run(),
        expectedSummary({
          status: "failed",
          due: 2,
          acquired: 1,
          succeeded: 0,
          failed: 2,
          transientFailed: 2,
        })
      );
      assert.equal(
        calls.filter(([name]) => name === "claim").length,
        1
      );
      assert.equal(
        calls.filter(([name]) => name === "error").length,
        2
      );
    });

    test("rejects incomplete collaborators and unsafe configuration", () => {
      assert.equal(DEFAULT_LEASE_MS, 900_000);
      assert.equal(
        FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE,
        "fad_queued_nomination_activation"
      );
      assert.throws(
        () => createActivateFreeAgentDraftQueuedNominationsJob(),
        TypeError
      );
      const required = {
        repository: { listDue() {}, claim() {} },
        activationService: {
          executeClaimedActivation() {},
          recordClaimedFailure() {},
        },
        clock: { nowMs() { return 1; } },
        secureRandom: { id() { return IDS.leaseOne; } },
        leaseOwner: LEASE_OWNER,
        logger: { error() {} },
      };
      assert.throws(
        () => createActivateFreeAgentDraftQueuedNominationsJob({
          ...required,
          leaseDurationMs: 0,
        }),
        TypeError
      );
      assert.throws(
        () => createActivateFreeAgentDraftQueuedNominationsJob({
          ...required,
          batchSize: 101,
        }),
        TypeError
      );
      assert.throws(
        () => createActivateFreeAgentDraftQueuedNominationsJob({
          ...required,
          activationService: {
            executeClaimedActivation() {},
          },
        }),
        TypeError
      );
    });
  }
);
