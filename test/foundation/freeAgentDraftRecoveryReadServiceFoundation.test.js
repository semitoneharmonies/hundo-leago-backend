"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createFreeAgentDraftRecoveryReadService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftRecoveryReadService"
);

const LEAGUE_ID =
  "11111111-1111-4111-8111-111111111111";
const FAD_ID =
  "22222222-2222-4222-8222-222222222222";
const SEASON_ID =
  "33333333-3333-4333-8333-333333333333";
const USER_ID =
  "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP_ID =
  "55555555-5555-4555-8555-555555555555";
const NOW_MS = 1_800_000_000_000;
const AUTHENTICATED = Object.freeze({ session: true });

function validProjection() {
  const rollovers = Array.from(
    { length: 7 },
    (_, index) => ({
      rolloverId:
        `00000000-0000-4000-8000-${String(
          100 + index
        ).padStart(12, "0")}`,
      sequence: index + 1,
      opensAtMs: NOW_MS + index * 100_000,
      creationCutoffAtMs:
        NOW_MS + index * 100_000 + 40_000,
      rollsOverAtMs:
        NOW_MS + index * 100_000 + 80_000,
      status: "scheduled",
      processingStartedAtMs: null,
      completedAtMs: null,
      lastErrorCode: null,
      recoveryIds: [],
      blocksCompletion: true,
      version: 1,
    })
  );
  return {
    fad: {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      fadId: FAD_ID,
      version: 1,
      status: "cards_open",
      phase: "cards_open",
      openedAtMs: NOW_MS - 4_000,
      reminderAtMs: NOW_MS - 3_000,
      helpOpensAtMs: NOW_MS - 2_000,
      candidateDeadlineAtMs: NOW_MS + 1_000,
      deadlineLockedAtMs: null,
      allocationCompletedAtMs: null,
      nextRolloverAtMs: null,
      frozenFadFirstMatchupStartsAtMs:
        NOW_MS + 604_801_000,
      competitionFirstMatchupStartsAtMs:
        NOW_MS + 604_801_000,
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
    rollovers,
    recoveries: [],
    availableActions: rollovers.map((rollover) => ({
      action: "finalize_rollover",
      resourceId: rollover.rolloverId,
      enabled: false,
      reasonCode: "RECOVERY_NOT_AVAILABLE",
    })),
  };
}

function harness({
  authority = "commissioner",
  authorizationError = null,
  repositoryResult = validProjection(),
} = {}) {
  const calls = [];
  const leagueAuthorization = {
    requireCommissioner(authenticated, leagueId) {
      calls.push([
        "requireCommissioner",
        authenticated,
        leagueId,
      ]);
      if (authorizationError) throw authorizationError;
      return {
        actorUserId: USER_ID,
        membershipId: MEMBERSHIP_ID,
        authority,
      };
    },
  };
  const clock = {
    nowMs() {
      calls.push(["nowMs"]);
      return NOW_MS;
    },
  };
  const repository = {
    readRecovery(input) {
      calls.push(["readRecovery", input]);
      return repositoryResult;
    },
  };
  return {
    calls,
    service: createFreeAgentDraftRecoveryReadService({
      leagueAuthorization,
      repository,
      clock,
    }),
  };
}

describe("FAD-11 recovery-read application service", () => {
  test("authorizes first and forwards an exact queryless commissioner scope", () => {
    const { calls, service } = harness();
    const result = service.recovery({
      authenticated: AUTHENTICATED,
      leagueId: LEAGUE_ID,
      fadId: FAD_ID,
    });

    assert.ok(Object.isFrozen(result));
    assert.deepEqual(calls, [
      [
        "requireCommissioner",
        AUTHENTICATED,
        LEAGUE_ID,
      ],
      ["nowMs"],
      [
        "readRecovery",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          viewerUserId: USER_ID,
          viewerMembershipId: MEMBERSHIP_ID,
          viewerAuthority: "commissioner",
          nowMs: NOW_MS,
        },
      ],
    ]);
  });

  test("preserves inherited member-platform-admin authority for DB revalidation", () => {
    const { calls, service } = harness({
      authority: "platform_administrator",
    });

    service.recovery({
      authenticated: AUTHENTICATED,
      leagueId: LEAGUE_ID,
      fadId: FAD_ID,
    });
    assert.equal(
      calls.at(-1)[1].viewerAuthority,
      "platform_administrator_as_commissioner"
    );
  });

  test("samples no clock and performs no read after authorization denial", () => {
    const denied = new Error("denied");
    const { calls, service } = harness({
      authorizationError: denied,
    });

    assert.throws(
      () =>
        service.recovery({
          authenticated: AUTHENTICATED,
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
        }),
      (error) => error === denied
    );
    assert.deepEqual(calls, [
      [
        "requireCommissioner",
        AUTHENTICATED,
        LEAGUE_ID,
      ],
    ]);
  });

  test("rejects query fields and all non-exact request shapes before authorization", () => {
    const { calls, service } = harness();
    assert.throws(
      () =>
        service.recovery({
          authenticated: AUTHENTICATED,
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          includeCandidateCards: true,
        }),
      { code: "FAD_RECOVERY_READ_INPUT_INVALID" }
    );
    assert.deepEqual(calls, []);
  });

  test("fails closed when repository output is absent or violates the exact DTO", () => {
    for (const repositoryResult of [
      null,
      Promise.resolve(validProjection()),
      { ...validProjection(), privateBids: [] },
    ]) {
      const { service } = harness({ repositoryResult });
      assert.throws(() =>
        service.recovery({
          authenticated: AUTHENTICATED,
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
        })
      );
    }
  });
});
