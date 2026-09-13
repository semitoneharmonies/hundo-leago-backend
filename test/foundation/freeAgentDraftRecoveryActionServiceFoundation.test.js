"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  hashFreeAgentDraftRecoveryActionRequest,
  serializeFreeAgentDraftRecoveryActionRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftRecoveryPolicy"
);
const {
  buildFreeAgentDraftAllocationOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_RECOVERY_ACTION_IDEMPOTENCY_LIFETIME_MS,
  FreeAgentDraftRecoveryActionServiceError,
  createFreeAgentDraftRecoveryActionService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftRecoveryActionService"
);

const IDS = Object.freeze({
  league: "11111111-1111-4111-8111-111111111111",
  fad: "22222222-2222-4222-8222-222222222222",
  allocation: "33333333-3333-4333-8333-333333333333",
  player: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555",
  membership: "66666666-6666-4666-8666-666666666666",
  operation: "77777777-7777-4777-8777-777777777777",
  commandResult: "88888888-8888-4888-8888-888888888888",
  idempotency: "99999999-9999-4999-8999-999999999999",
});
const NOW_MS = 1_700_000_000_000;
const CLIENT_KEY = "fad-recovery-action-one";
const BODY = Object.freeze({
  action: "retry_allocation",
  resourceId: IDS.allocation,
  reason: "Retry the failed automatic allocation.",
});

function serviceInput(overrides = {}) {
  return {
    authenticated: Object.freeze({ sessionId: "session" }),
    fadId: IDS.fad,
    idempotencyKey: CLIENT_KEY,
    input: BODY,
    leagueId: IDS.league,
    ...overrides,
  };
}

function acceptedData(overrides = {}) {
  return {
    operationId: IDS.operation,
    occurrenceKey: buildFreeAgentDraftAllocationOccurrenceKey({
      fadId: IDS.fad,
      playerId: IDS.player,
    }),
    action: BODY.action,
    resourceId: BODY.resourceId,
    status: "pending",
    acceptedAtMs: NOW_MS,
    pollDescriptor: {
      kind: "fad_recovery",
      leagueId: IDS.league,
      fadId: IDS.fad,
    },
    ...overrides,
  };
}

function createHarness({
  replay = null,
  acceptResult,
  authority = null,
  nowMs = NOW_MS,
  authorizationError = null,
} = {}) {
  const calls = [];
  const generatedIds = [IDS.commandResult, IDS.idempotency];
  const service = createFreeAgentDraftRecoveryActionService({
    leagueAuthorization: {
      requireCommissioner(authenticated, leagueId) {
        calls.push(["authorize", authenticated, leagueId]);
        if (authorizationError) throw authorizationError;
        return authority || {
          actorUserId: IDS.user,
          membershipId: IDS.membership,
          authority: "commissioner",
        };
      },
    },
    repository: {
      findRecoveryActionReplay(input) {
        calls.push(["replay", input]);
        return replay;
      },
      acceptRecoveryAction(input) {
        calls.push(["accept", input]);
        return acceptResult === null
          ? null
          : acceptResult || {
              data: acceptedData(),
              httpStatus: 202,
              replayed: false,
            };
      },
    },
    clock: {
      nowMs() {
        calls.push(["clock"]);
        return nowMs;
      },
    },
    secureRandom: {
      id() {
        const id = generatedIds.shift();
        calls.push(["id", id]);
        return id;
      },
    },
  });
  return { calls, generatedIds, service };
}

function canonicalRequest() {
  return {
    body: BODY,
    fadId: IDS.fad,
    leagueId: IDS.league,
  };
}

describe("FAD recovery-action application boundary", () => {
  test("authorizes, probes replay, then samples clock and persists one exact acceptance", () => {
    const harness = createHarness();
    const result = harness.service.accept(serviceInput());
    assert.deepEqual(result, {
      data: acceptedData(),
      httpStatus: 202,
      replayed: false,
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.data), true);
    assert.deepEqual(
      harness.calls.map(([name]) => name),
      ["authorize", "replay", "clock", "id", "id", "accept"]
    );
    const replayInput = harness.calls[1][1];
    assert.deepEqual(replayInput, {
      actorAuthority: "commissioner",
      actorMembershipId: IDS.membership,
      actorUserId: IDS.user,
      body: BODY,
      clientKey: CLIENT_KEY,
      fadId: IDS.fad,
      leagueId: IDS.league,
      requestJson:
        serializeFreeAgentDraftRecoveryActionRequest(canonicalRequest()),
      requestSha256:
        hashFreeAgentDraftRecoveryActionRequest(canonicalRequest()),
    });
    const write = harness.calls.at(-1)[1];
    assert.deepEqual(write, {
      ...replayInput,
      acceptedAtMs: NOW_MS,
      commandResultId: IDS.commandResult,
      idempotencyExpiresAtMs:
        NOW_MS +
        FREE_AGENT_DRAFT_RECOVERY_ACTION_IDEMPOTENCY_LIFETIME_MS,
      idempotencyRequestId: IDS.idempotency,
    });
  });

  test("returns exact immutable replay before clock or identifier work", () => {
    const replay = {
      data: acceptedData({
        status: "already_succeeded",
        acceptedAtMs: NOW_MS - 500,
      }),
      httpStatus: 202,
      replayed: true,
    };
    const harness = createHarness({ replay });
    assert.deepEqual(harness.service.accept(serviceInput()), replay);
    assert.deepEqual(
      harness.calls.map(([name]) => name),
      ["authorize", "replay"]
    );
    assert.equal(harness.generatedIds.length, 2);
  });

  test("normalizes inherited platform-administrator authority", () => {
    const harness = createHarness({
      authority: {
        actorUserId: IDS.user,
        membershipId: IDS.membership,
        authority: "platform_administrator",
      },
    });
    harness.service.accept(serviceInput());
    assert.equal(
      harness.calls[1][1].actorAuthority,
      "platform_administrator_as_commissioner"
    );
  });

  test("performs no replay, clock, or identifier work when authority fails", () => {
    const denied = Object.assign(new Error("denied"), {
      code: "LEAGUE_COMMISSIONER_REQUIRED",
    });
    const harness = createHarness({ authorizationError: denied });
    assert.throws(
      () => harness.service.accept(serviceInput()),
      (error) => error === denied
    );
    assert.deepEqual(
      harness.calls.map(([name]) => name),
      ["authorize"]
    );
    assert.equal(harness.generatedIds.length, 2);
  });

  test("rejects invalid bodies and idempotency keys before persistence", () => {
    for (const input of [
      serviceInput({ input: { ...BODY, winnerId: IDS.user } }),
      serviceInput({ idempotencyKey: " padded " }),
      { ...serviceInput(), unknown: true },
    ]) {
      const harness = createHarness();
      assert.throws(() => harness.service.accept(input));
      assert.equal(
        harness.calls.some(([name]) =>
          ["replay", "clock", "id", "accept"].includes(name)
        ),
        false
      );
    }
  });

  test("fails closed on unsafe clocks and mismatched persistence results", () => {
    for (const nowMs of [
      -1,
      Number.MAX_SAFE_INTEGER,
      1.5,
    ]) {
      const harness = createHarness({ nowMs });
      assert.throws(() => harness.service.accept(serviceInput()));
      assert.equal(
        harness.calls.some(([name]) => name === "accept"),
        false
      );
    }
    for (const result of [
      null,
      {
        data: acceptedData({ action: "activate_restricted" }),
        httpStatus: 202,
        replayed: false,
      },
      {
        data: acceptedData({ acceptedAtMs: NOW_MS + 1 }),
        httpStatus: 202,
        replayed: false,
      },
      {
        data: acceptedData(),
        httpStatus: 200,
        replayed: false,
      },
    ]) {
      const harness = createHarness({ acceptResult: result });
      assert.throws(
        () => harness.service.accept(serviceInput()),
        (error) =>
          error instanceof FreeAgentDraftRecoveryActionServiceError
      );
    }
  });

  test("validates every required dependency", () => {
    const base = {
      leagueAuthorization: { requireCommissioner() {} },
      repository: {
        findRecoveryActionReplay() {},
        acceptRecoveryAction() {},
      },
      clock: { nowMs() {} },
      secureRandom: { id() {} },
    };
    for (const mutation of [
      { leagueAuthorization: {} },
      { repository: {} },
      { clock: {} },
      { secureRandom: {} },
    ]) {
      assert.throws(
        () =>
          createFreeAgentDraftRecoveryActionService({
            ...base,
            ...mutation,
          }),
        TypeError
      );
    }
  });
});
