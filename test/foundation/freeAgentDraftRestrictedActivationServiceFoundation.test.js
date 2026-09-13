"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_SERVICE_CODES,
  FreeAgentDraftRestrictedActivationServiceError,
  createFreeAgentDraftRestrictedActivationService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftRestrictedActivationService"
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
  auction: uuid(6),
  rollover: uuid(7),
  run: uuid(8),
  leaseToken: uuid(9),
  offerEventOne: uuid(10),
  offerEventTwo: uuid(11),
  stateEvent: uuid(12),
  auctionOutbox: uuid(13),
  fadOutbox: uuid(14),
  recovery: uuid(15),
});
const ACTIVATION_AT_MS = 1_000;
const STARTED_AT_MS = 1_100;
const ACTIVATED_AT_MS = 2_000;
const LEASE_EXPIRES_AT_MS = 3_000;
const RESOLVES_AT_MS =
  ACTIVATION_AT_MS + 24 * 60 * 60 * 1000;
const FAIR_ACCESS_MS = 60 * 60 * 1000;
const OCCURRENCE_KEY =
  buildFreeAgentDraftRestrictedActivationOccurrenceKey(
    {
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      activationAtMs: ACTIVATION_AT_MS,
    }
  );

function input(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    auctionId: IDS.auction,
    rolloverId: IDS.rollover,
    activationAtMs: ACTIVATION_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: ACTIVATION_AT_MS,
    jobExecution: {
      runId: IDS.run,
      leaseOwner: "fad-restricted-activation-worker",
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
    status: "restricted_scheduled",
    allocationVersion: 2,
    auctionId: IDS.auction,
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
    auctionId: IDS.auction,
    rolloverId: IDS.rollover,
    activationAtMs: ACTIVATION_AT_MS,
    activatedAtMs: ACTIVATED_AT_MS,
    allocationVersion: 3,
    jobRunId: IDS.run,
    jobRunVersion: 3,
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
    createFreeAgentDraftRestrictedActivationService({
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
  "FAD restricted-auction activation service",
  () => {
    test("loads exact activation evidence and forwards the claimed versions and lease identity", () => {
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
            auctionId: IDS.auction,
            rolloverId: IDS.rollover,
            activationAtMs: ACTIVATION_AT_MS,
            occurrenceKey: OCCURRENCE_KEY,
            expectedAllocationVersion: 2,
            activatedAtMs: ACTIVATED_AT_MS,
            jobExecution: {
              runId: IDS.run,
              expectedVersion: 2,
              leaseOwner:
                "fad-restricted-activation-worker",
              leaseToken: IDS.leaseToken,
              leaseExpiresAtMs:
                LEASE_EXPIRES_AT_MS,
            },
          },
        ],
      ]);
    });

    test("delegates an exact durable replay using both preceding versions", () => {
      const replayState = activation({
        status: "restricted_active",
        allocationVersion: 3,
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
        nowMs: LEASE_EXPIRES_AT_MS + 1,
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
            FreeAgentDraftRestrictedActivationServiceError &&
          error.code ===
            FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_SERVICE_CODES
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
            FreeAgentDraftRestrictedActivationServiceError &&
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

    test("rejects not-due and expired claimed execution after the authoritative read", () => {
      const early = harness({
        nowMs: ACTIVATION_AT_MS - 1,
      });
      assert.throws(
        () =>
          early.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftRestrictedActivationServiceError &&
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
            FreeAgentDraftRestrictedActivationServiceError &&
          error.reasonCode ===
            "claimed_lease_expired"
      );
      assert.deepEqual(
        expired.calls.map(([name]) => name),
        ["find", "clock"]
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
            FreeAgentDraftRestrictedActivationServiceError &&
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

    test("requires strictly more than sixty minutes of fair access for a fresh activation", () => {
      for (const nowMs of [
        RESOLVES_AT_MS - FAIR_ACCESS_MS,
        RESOLVES_AT_MS - FAIR_ACCESS_MS + 1,
      ]) {
        const blocked = harness({ nowMs });
        assert.throws(
          () =>
            blocked.service.executeClaimedActivation(
              input({
                jobExecution: {
                  ...input().jobExecution,
                  leaseExpiresAtMs: RESOLVES_AT_MS + 1,
                },
              })
            ),
          (error) =>
            error instanceof
              FreeAgentDraftRestrictedActivationServiceError &&
            error.reasonCode ===
              "activation_fair_access_unavailable"
        );
        assert.equal(
          blocked.calls.some(
            ([name]) => name === "execute"
          ),
          false
        );
      }

      const allowedAtMs =
        RESOLVES_AT_MS - FAIR_ACCESS_MS - 1;
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

    test("fails closed on malformed activation or terminal evidence", () => {
      const malformedState = harness({
        activationResult: {
          ...activation(),
          auctionId: uuid(99),
        },
      });
      assert.throws(
        () =>
          malformedState.service
            .executeClaimedActivation(input()),
        (error) =>
          error instanceof
            FreeAgentDraftRestrictedActivationServiceError &&
          error.reasonCode ===
            "activation_state_invalid"
      );

      const malformedTerminal = harness({
        terminalResult: terminal({
          evidence: {
            offerEventIds: [IDS.offerEventOne],
            stateEventId: IDS.stateEvent,
            outboxEventIds: [
              IDS.auctionOutbox,
              IDS.fadOutbox,
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
            FreeAgentDraftRestrictedActivationServiceError &&
          error.reasonCode ===
            "terminal_result_invalid"
      );
    });

    test("validates required synchronous collaborators", () => {
      assert.throws(
        () =>
          createFreeAgentDraftRestrictedActivationService(),
        /durable repository/
      );
      assert.throws(
        () =>
          createFreeAgentDraftRestrictedActivationService({
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
            FreeAgentDraftRestrictedActivationServiceError &&
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
            FreeAgentDraftRestrictedActivationServiceError &&
          error.reasonCode ===
            "repository_must_be_synchronous"
      );
    });
  }
);
