"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  DEFAULT_LEASE_MS,
  JOB_NAME,
  createActivateFreeAgentDraftRestrictedAuctionsJob,
} = require(
  "../../src/jobs/definitions/activateFreeAgentDraftRestrictedAuctions"
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
  leaseOne: uuid(90),
  leaseTwo: uuid(91),
  offerEventOne: uuid(92),
  offerEventTwo: uuid(93),
  stateEvent: uuid(94),
  auctionOutbox: uuid(95),
  fadOutbox: uuid(96),
});
const ACTIVATION_AT_MS = 10_000;
const LISTED_AT_MS = 10_100;
const CLAIMED_AT_MS = 10_200;
const LEASE_OWNER =
  "fad-restricted-activation-runner";

function descriptor(index = 1, overrides = {}) {
  const runId = uuid(10 + index);
  const allocationId = uuid(20 + index);
  const playerId = uuid(30 + index);
  const auctionId = uuid(40 + index);
  const rolloverId = uuid(50 + index);
  const occurrenceKey =
    buildFreeAgentDraftRestrictedActivationOccurrenceKey(
      {
        fadId: IDS.fad,
        allocationId,
        activationAtMs: ACTIVATION_AT_MS,
      }
    );
  const base = {
    runId,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    jobType: "fad_restricted_activation",
    occurrenceKey,
    scheduledForMs: ACTIVATION_AT_MS,
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
      type: "restricted_activate",
      fadId: IDS.fad,
      allocationId,
      activationAtMs: ACTIVATION_AT_MS,
    },
    binding: {
      type: "restricted_activate",
      resourceType: "allocation",
      resourceId: allocationId,
      fadId: IDS.fad,
      playerId,
      allocationId,
      auctionId,
      rolloverId,
      activationAtMs: ACTIVATION_AT_MS,
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

function terminal(command, overrides = {}) {
  return {
    outcome: "succeeded",
    leagueId: command.leagueId,
    seasonId: command.seasonId,
    fadId: command.fadId,
    allocationId: command.allocationId,
    playerId: command.playerId,
    auctionId: command.auctionId,
    rolloverId: command.rolloverId,
    activationAtMs: command.activationAtMs,
    activatedAtMs: command.jobExecution.startedAtMs,
    allocationVersion: 3,
    jobRunId: command.jobExecution.runId,
    jobRunVersion:
      command.jobExecution.expectedVersion + 1,
    sourceRecoveryId: null,
    evidence: {
      offerEventIds: [
        IDS.offerEventOne,
        IDS.offerEventTwo,
      ],
      stateEventId: IDS.stateEvent,
      outboxEventIds: [
        IDS.auctionOutbox,
        IDS.fadOutbox,
      ],
    },
    replayed: false,
    ...overrides,
  };
}

function harness({
  due = [descriptor()],
  claimImplementation,
  serviceImplementation,
  clockValues = [LISTED_AT_MS, CLAIMED_AT_MS],
  leaseTokens = [IDS.leaseOne, IDS.leaseTwo],
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
      if (serviceImplementation) {
        return serviceImplementation(command);
      }
      return terminal(command);
    },
  };
  const job =
    createActivateFreeAgentDraftRestrictedAuctionsJob(
      {
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
        logger: {
          error(...input) {
            calls.push(["error", input]);
          },
        },
      }
    );
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
    skipped: 0,
    ...overrides,
  };
}

describe(
  "FAD restricted-auction activation scheduled job",
  () => {
    test("filters other work and forwards the exact claimed activation witness", async () => {
      const other = {
        jobType: "fad_fallback_activation",
        malformedForRestrictedActivation: true,
      };
      const activationDue = descriptor();
      const { calls, job } = harness({
        due: [other, activationDue],
      });

      assert.deepEqual(
        await job.run(),
        expectedSummary()
      );
      const claim = calls.find(
        ([name]) => name === "claim"
      )[1];
      assert.deepEqual(claim, {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        runId: activationDue.runId,
        jobType: "fad_restricted_activation",
        occurrenceKey:
          activationDue.occurrenceKey,
        scheduledForMs: ACTIVATION_AT_MS,
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
        allocationId:
          activationDue.binding.allocationId,
        playerId: activationDue.binding.playerId,
        auctionId: activationDue.binding.auctionId,
        rolloverId:
          activationDue.binding.rolloverId,
        activationAtMs: ACTIVATION_AT_MS,
        occurrenceKey:
          activationDue.occurrenceKey,
        scheduledForMs: ACTIVATION_AT_MS,
        jobExecution: {
          runId: activationDue.runId,
          leaseOwner: LEASE_OWNER,
          leaseToken: IDS.leaseOne,
          leaseExpiresAtMs:
            CLAIMED_AT_MS + DEFAULT_LEASE_MS,
          startedAtMs: CLAIMED_AT_MS,
          attemptCount: 1,
          expectedVersion: 2,
        },
      });
    });

    test("skips a stale compare-and-set claim without executing", async () => {
      const only = descriptor();
      const { calls, job } = harness({
        due: [only],
        claimImplementation() {
          return {
            acquired: false,
            occurrence: only,
          };
        },
      });

      assert.deepEqual(
        await job.run(),
        expectedSummary({
          acquired: 0,
          succeeded: 0,
          skipped: 1,
        })
      );
      assert.equal(
        calls.some(([name]) => name === "execute"),
        false
      );
    });

    test("continues with a second activation when the first claimed execution fails", async () => {
      const first = descriptor(1);
      const second = descriptor(2);
      const failure = new Error(
        "activation storage failed"
      );
      let executions = 0;
      const { calls, job } = harness({
        due: [first, second],
        clockValues: [
          LISTED_AT_MS,
          CLAIMED_AT_MS,
          CLAIMED_AT_MS + 1,
        ],
        serviceImplementation(command) {
          executions += 1;
          if (executions === 1) throw failure;
          return terminal(command);
        },
      });

      assert.deepEqual(await job.run(), {
        job: JOB_NAME,
        status: "failed",
        due: 2,
        acquired: 2,
        succeeded: 1,
        failed: 1,
        skipped: 0,
      });
      assert.equal(
        calls.filter(
          ([name]) => name === "execute"
        ).length,
        2
      );
      const logged = calls.find(
        ([name]) => name === "error"
      );
      assert.equal(
        logged[1][0],
        "free_agent_draft.restricted_activation_occurrence_failed"
      );
      assert.deepEqual(logged[1][1], {
        job: JOB_NAME,
        runId: first.runId,
        fadId: first.fadId,
        allocationId: first.binding.allocationId,
        auctionId: first.binding.auctionId,
        classification: "transient",
      });
    });

    test("fails closed on malformed activation binding before any claim", async () => {
      const canonical = descriptor();
      const malformed = {
        ...canonical,
        binding: {
          ...canonical.binding,
          auctionId: "not-a-uuid",
        },
      };
      const { calls, job } = harness({
        due: [malformed],
        clockValues: [LISTED_AT_MS],
      });

      const result = await job.run();
      assert.equal(result.status, "failed");
      assert.deepEqual(
        calls.map(([name]) => name),
        ["list", "error"]
      );
    });

    test("rejects a malformed terminal result and continues", async () => {
      const first = descriptor(1);
      const second = descriptor(2);
      let executions = 0;
      const { calls, job } = harness({
        due: [first, second],
        clockValues: [
          LISTED_AT_MS,
          CLAIMED_AT_MS,
          CLAIMED_AT_MS + 1,
        ],
        serviceImplementation(command) {
          executions += 1;
          return terminal(
            command,
            executions === 1
              ? { jobRunVersion: 999 }
              : {}
          );
        },
      });

      const result = await job.run();
      assert.equal(result.status, "failed");
      assert.equal(result.failed, 1);
      assert.equal(result.succeeded, 1);
      assert.equal(
        calls.filter(
          ([name]) => name === "claim"
        ).length,
        2
      );
    });

    test("rejects an invalid claimed lease witness and an unsafe token", async () => {
      const mismatched = harness({
        claimImplementation(command, due) {
          return {
            acquired: true,
            occurrence: {
              ...claimed(due[0], command),
              leaseExpiresAtMs: command.nowMs,
            },
          };
        },
      });
      const mismatchResult =
        await mismatched.job.run();
      assert.equal(mismatchResult.status, "failed");
      assert.equal(mismatchResult.acquired, 1);
      assert.equal(
        mismatched.calls.some(
          ([name]) => name === "execute"
        ),
        false
      );

      const unsafeToken = harness({
        leaseTokens: [" unsafe "],
      });
      const unsafeResult =
        await unsafeToken.job.run();
      assert.equal(unsafeResult.status, "failed");
      assert.equal(unsafeResult.acquired, 0);
      assert.equal(
        unsafeToken.calls.some(
          ([name]) => name === "claim"
        ),
        false
      );
    });

    test("validates dependencies and bounded runner configuration", () => {
      assert.throws(
        () =>
          createActivateFreeAgentDraftRestrictedAuctionsJob(),
        /listDue/
      );
      assert.throws(
        () =>
          createActivateFreeAgentDraftRestrictedAuctionsJob({
            repository: {
              listDue() {},
              claim() {},
            },
            activationService: {
              executeClaimedActivation() {},
            },
            clock: { nowMs() {} },
            secureRandom: { id() {} },
            leaseOwner: "",
            logger: { error() {} },
          }),
        /configuration/
      );
      assert.throws(
        () =>
          createActivateFreeAgentDraftRestrictedAuctionsJob({
            repository: {
              listDue() {},
              claim() {},
            },
            activationService: {
              executeClaimedActivation() {},
            },
            clock: { nowMs() {} },
            secureRandom: { id() {} },
            leaseOwner: LEASE_OWNER,
            batchSize: 101,
            logger: { error() {} },
          }),
        /configuration/
      );
    });
  }
);
