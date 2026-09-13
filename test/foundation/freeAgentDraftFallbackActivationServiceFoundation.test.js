"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftFallbackActivationOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_SERVICE_CODES,
  FreeAgentDraftFallbackActivationServiceError,
  createFreeAgentDraftFallbackActivationService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftFallbackActivationService"
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
  sourceAuction: uuid(6),
  fallbackAuction: uuid(7),
  rollover: uuid(8),
  run: uuid(9),
  leaseToken: uuid(10),
  sourceResolution: uuid(11),
  stateEvent: uuid(12),
  activity: uuid(13),
  notificationOne: uuid(14),
  notificationTwo: uuid(15),
  auctionOutbox: uuid(16),
  fadOutbox: uuid(17),
  recovery: uuid(18),
});
const ACTIVATION_AT_MS = 1_000;
const STARTED_AT_MS = 1_100;
const ACTIVATED_AT_MS = 2_000;
const LEASE_EXPIRES_AT_MS = 3_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const RESOLVES_AT_MS = ACTIVATION_AT_MS + WINDOW_MS;
const OCCURRENCE_KEY =
  buildFreeAgentDraftFallbackActivationOccurrenceKey({
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    activationAtMs: ACTIVATION_AT_MS,
  });

function input(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    auctionId: IDS.fallbackAuction,
    rolloverId: IDS.rollover,
    activationAtMs: ACTIVATION_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: ACTIVATION_AT_MS,
    jobExecution: {
      runId: IDS.run,
      leaseOwner: "fad-fallback-activation-worker",
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: STARTED_AT_MS,
      attemptCount: 1,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function activation(overrides = {}) {
  return Object.freeze({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    status: "restricted_fallback_open",
    allocationVersion: 2,
    sourceAuctionId: IDS.sourceAuction,
    auctionId: IDS.fallbackAuction,
    rolloverId: IDS.rollover,
    activationAtMs: ACTIVATION_AT_MS,
    resolvesAtMs: RESOLVES_AT_MS,
    activationJobRunId: IDS.run,
    activationOccurrenceKey: OCCURRENCE_KEY,
    jobStatus: "running",
    jobRunVersion: 2,
    ...overrides,
  });
}

function terminal(overrides = {}) {
  return Object.freeze({
    outcome: "succeeded",
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    sourceAuctionId: IDS.sourceAuction,
    auctionId: IDS.fallbackAuction,
    rolloverId: IDS.rollover,
    activationAtMs: ACTIVATION_AT_MS,
    activatedAtMs: ACTIVATED_AT_MS,
    allocationVersion: 2,
    jobRunId: IDS.run,
    jobRunVersion: 3,
    sourceRecoveryId: null,
    evidence: {
      sourceResolutionId: IDS.sourceResolution,
      stateEventId: IDS.stateEvent,
      activityId: IDS.activity,
      notificationIds: [
        IDS.notificationOne,
        IDS.notificationTwo,
      ],
      outboxEventIds: [
        IDS.fadOutbox,
        IDS.auctionOutbox,
      ],
    },
    replayed: false,
    ...overrides,
  });
}

function harness({
  activationResult = activation(),
  terminalResult = terminal(),
  nowMs = ACTIVATED_AT_MS,
} = {}) {
  const calls = [];
  const repository = {
    findActivation(command) {
      calls.push(["find", command]);
      return activationResult;
    },
    executeClaimed(command) {
      calls.push(["execute", command]);
      return terminalResult;
    },
  };
  const service =
    createFreeAgentDraftFallbackActivationService({
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

describe(
  "FAD fallback-auction activation service",
  () => {
    test("loads exact lineage and forwards the claimed versions and lease identity", () => {
      const { calls, service } = harness();

      assert.deepEqual(
        service.executeClaimedActivation(input()),
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
            activationAtMs: ACTIVATION_AT_MS,
          },
        ],
        ["clock"],
        [
          "execute",
          {
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            playerId: IDS.player,
            sourceAuctionId: IDS.sourceAuction,
            auctionId: IDS.fallbackAuction,
            rolloverId: IDS.rollover,
            activationAtMs: ACTIVATION_AT_MS,
            occurrenceKey: OCCURRENCE_KEY,
            expectedAllocationVersion: 2,
            activatedAtMs: ACTIVATED_AT_MS,
            jobExecution: {
              runId: IDS.run,
              expectedVersion: 2,
              leaseOwner:
                "fad-fallback-activation-worker",
              leaseToken: IDS.leaseToken,
              leaseExpiresAtMs:
                LEASE_EXPIRES_AT_MS,
            },
          },
        ],
      ]);
    });

    test("delegates immutable replay after the original lease and auction window while preserving the allocation version", () => {
      const replayState = activation({
        jobStatus: "succeeded",
        jobRunVersion: 3,
      });
      const replay = terminal({
        activatedAtMs: 1_500,
        sourceRecoveryId: IDS.recovery,
        replayed: true,
      });
      const { calls, service } = harness({
        activationResult: replayState,
        terminalResult: replay,
        nowMs: RESOLVES_AT_MS + 1,
      });

      assert.deepEqual(
        service.executeClaimedActivation(input()),
        replay
      );
      const command = calls.at(-1)[1];
      assert.equal(
        command.expectedAllocationVersion,
        2
      );
      assert.equal(
        command.jobExecution.expectedVersion,
        2
      );
      assert.equal(
        command.activatedAtMs,
        RESOLVES_AT_MS + 1
      );
    });

    test("rejects malformed scope and a non-running activation before writing", () => {
      const malformed = harness();
      assert.throws(
        () =>
          malformed.service
            .executeClaimedActivation({
              ...input(),
              occurrenceKey: "tampered",
            }),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.code ===
            FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_SERVICE_CODES
              .inputInvalid
      );
      assert.equal(malformed.calls.length, 0);

      const pending = harness({
        activationResult: activation({
          jobStatus: "pending",
        }),
      });
      assert.throws(
        () =>
          pending.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.reasonCode ===
            "activation_not_claimed_or_replayable"
      );
      assert.equal(
        pending.calls.some(
          ([name]) => name === "execute"
        ),
        false
      );
    });

    test("rejects not-due, expired, and closed claimed execution after the authoritative read", () => {
      const early = harness({
        nowMs: ACTIVATION_AT_MS - 1,
      });
      assert.throws(
        () =>
          early.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.reasonCode === "activation_not_due"
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
          expired.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.reasonCode ===
            "claimed_lease_expired"
      );

      const closed = harness({
        nowMs: RESOLVES_AT_MS,
      });
      assert.throws(
        () =>
          closed.service.executeClaimedActivation(
            input({
              jobExecution: {
                ...input().jobExecution,
                leaseExpiresAtMs:
                  RESOLVES_AT_MS + 1_000,
              },
            })
          ),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.reasonCode ===
            "activation_window_closed"
      );
      assert.equal(
        closed.calls.some(
          ([name]) => name === "execute"
        ),
        false
      );
    });

    test("permits fresh publication through the final millisecond of the existing fallback window", () => {
      const allowedAtMs = RESOLVES_AT_MS - 1;
      const allowedResult = terminal({
        activatedAtMs: allowedAtMs,
      });
      const allowed = harness({
        nowMs: allowedAtMs,
        terminalResult: allowedResult,
      });
      assert.deepEqual(
        allowed.service.executeClaimedActivation(
          input({
            jobExecution: {
              ...input().jobExecution,
              leaseExpiresAtMs: RESOLVES_AT_MS + 1,
            },
          })
        ),
        allowedResult
      );
    });

    test("fails closed on malformed activation lineage or terminal publication evidence", () => {
      const malformedState = harness({
        activationResult: activation({
          sourceAuctionId: IDS.fallbackAuction,
        }),
      });
      assert.throws(
        () =>
          malformedState.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.reasonCode ===
            "activation_state_invalid"
      );

      const malformedTerminal = harness({
        terminalResult: terminal({
          evidence: {
            sourceResolutionId:
              IDS.sourceResolution,
            stateEventId: IDS.stateEvent,
            activityId: IDS.activity,
            notificationIds: [
              IDS.notificationOne,
              IDS.notificationOne,
            ],
            outboxEventIds: [
              IDS.fadOutbox,
              IDS.auctionOutbox,
            ],
          },
        }),
      });
      assert.throws(
        () =>
          malformedTerminal.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.reasonCode ===
            "terminal_result_invalid"
      );
    });

    test("validates required synchronous collaborators", () => {
      assert.throws(
        () =>
          createFreeAgentDraftFallbackActivationService(),
        /durable repository/
      );
      assert.throws(
        () =>
          createFreeAgentDraftFallbackActivationService({
            repository: {
              findActivation() {},
              executeClaimed() {},
            },
          }),
        /UTC clock/
      );

      const asynchronousFind = harness({
        activationResult: Promise.resolve(
          activation()
        ),
      });
      assert.throws(
        () =>
          asynchronousFind.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.reasonCode ===
            "repository_must_be_synchronous"
      );

      const asynchronousWrite = harness({
        terminalResult: Promise.resolve(terminal()),
      });
      assert.throws(
        () =>
          asynchronousWrite.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftFallbackActivationServiceError &&
          error.reasonCode ===
            "repository_must_be_synchronous"
      );
    });
  }
);
