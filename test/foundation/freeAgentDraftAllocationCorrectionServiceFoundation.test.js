"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
  FREE_AGENT_DRAFT_CORRECTION_MODE,
  hashFreeAgentDraftCorrectionApplyRequest,
  serializeFreeAgentDraftCorrectionApplyRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);
const {
  FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_IDEMPOTENCY_LIFETIME_MS,
  FreeAgentDraftAllocationCorrectionServiceError,
  createFreeAgentDraftAllocationCorrectionService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftAllocationCorrectionService"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  fad: uuid(2),
  allocation: uuid(3),
  player: uuid(4),
  team: uuid(5),
  snapshot: uuid(6),
  contract: uuid(7),
  ownership: uuid(8),
  correction: uuid(9),
  activity: uuid(10),
  actor: uuid(11),
  membership: uuid(12),
  idempotencyRequest: uuid(13),
  commandResult: uuid(14),
});
const COMPLETED_AT_MS = 10_000;

function safeTeam() {
  return {
    teamId: IDS.team,
    name: "Snow Owls",
    primaryColour: "#112233",
    secondaryColour: "#ffffff",
    tertiaryColour: null,
    patternTemplate: "mirrored-centre-band",
    logoReference: null,
  };
}

function safePlayer() {
  return {
    playerId: IDS.player,
    fullName: "Casey Candidate",
    positionGroup: "F",
  };
}

function emptyAfterSummary(overrides = {}) {
  return {
    status: null,
    team: null,
    player: null,
    contractId: null,
    ownershipId: null,
    auctionId: null,
    totalValueCents: null,
    termYears: null,
    aavCents: null,
    rosterCategory: null,
    ...overrides,
  };
}

function resultData(overrides = {}) {
  return {
    correctionId: IDS.correction,
    allocation: {
      allocationId: IDS.allocation,
      allocationVersion: 4,
      player: safePlayer(),
      status: "automatic_award",
      decisionCode: "corrected",
      rankedOffers: [
        {
          snapshotEntryId: IDS.snapshot,
          teamId: IDS.team,
          team: safeTeam(),
          slotKey: "F01",
          totalValueCents: null,
          termYears: null,
          aavCents: null,
          valid: true,
          validationCode: null,
          rank: 1,
          outcomeCode: "winner",
        },
      ],
      winner: {
        teamId: IDS.team,
        snapshotEntryId: IDS.snapshot,
        contractId: IDS.contract,
        ownershipId: IDS.ownership,
        slotKey: "F01",
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      },
      restricted: null,
      fallback: null,
      draws: [],
      recoveryStatus: null,
      resolvedAtMs: COMPLETED_AT_MS,
    },
    appliedDeltas: [
      {
        resourceType: "allocation",
        resourceId: IDS.allocation,
        action: "update",
        beforeVersion: 3,
        afterSummary: emptyAfterSummary({
          status: "automatic_award",
          team: safeTeam(),
          player: safePlayer(),
          contractId: IDS.contract,
          ownershipId: IDS.ownership,
          totalValueCents: null,
          termYears: null,
          aavCents: null,
          rosterCategory: "Active",
        }),
      },
      {
        resourceType: "activity",
        resourceId: IDS.activity,
        action: "append",
        beforeVersion: null,
        afterSummary: emptyAfterSummary({ status: "appended" }),
      },
    ],
    activityId: IDS.activity,
    completedAtMs: COMPLETED_AT_MS,
    ...overrides,
  };
}

function body(overrides = {}) {
  return {
    mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
    previewFingerprint: "a".repeat(64),
    reason:
      "Reconcile the result to the locked Candidate Card snapshot.",
    confirmation: FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    allocationId: IDS.allocation,
    authenticated: Object.freeze({ userId: IDS.actor }),
    expectedAllocationVersion: 3,
    fadId: IDS.fad,
    idempotencyKey: "fad-correction-0001",
    input: body(),
    leagueId: IDS.league,
    ...overrides,
  };
}

function createHarness({
  authority = "commissioner",
  replay = null,
  applyResult = {
    data: resultData(),
    httpStatus: 200,
    replayed: false,
    committedRoster: null,
  },
  authorizationError = null,
  nowMs = COMPLETED_AT_MS,
  secureIds = [IDS.idempotencyRequest, IDS.commandResult],
  lateLockError = null,
} = {}) {
  const calls = [];
  const ids = [...secureIds];
  const service = createFreeAgentDraftAllocationCorrectionService({
    leagueAuthorization: {
      requireCommissioner(authenticated, leagueId) {
        calls.push(["authorize", authenticated, leagueId]);
        if (authorizationError) throw authorizationError;
        return {
          actorUserId: IDS.actor,
          membershipId: IDS.membership,
          authority,
        };
      },
    },
    repository: {
      findAllocationCorrectionReplay(command) {
        calls.push(["replay", command]);
        return replay;
      },
      applyAllocationCorrection(command) {
        calls.push(["apply", command]);
        return applyResult;
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
        calls.push(["id"]);
        return ids.shift();
      },
    },
    lateLockCoordinator: {
      async coordinateCommittedRoster(batch) {
        calls.push(["lateLock", batch]);
        if (lateLockError) throw lateLockError;
        return Object.freeze({ status: "not_applicable" });
      },
    },
  });
  return { calls, service };
}

function canonicalCommand() {
  return {
    allocationId: IDS.allocation,
    body: body(),
    expectedAllocationVersion: 3,
    fadId: IDS.fad,
    idempotencyKey: "fad-correction-0001",
    leagueId: IDS.league,
  };
}

describe("Free Agent Draft allocation-correction service foundation", () => {
  test("requires every correction dependency", () => {
    assert.throws(
      () => createFreeAgentDraftAllocationCorrectionService(),
      /league-commissioner authorization/u
    );
    assert.throws(
      () =>
        createFreeAgentDraftAllocationCorrectionService({
          leagueAuthorization: { requireCommissioner() {} },
          repository: {},
        }),
      /allocation-correction persistence/u
    );
  });

  test("binds the fresh correction to authority, request hash, version, clock, and receipt IDs", async () => {
    const harness = createHarness();
    const result = await harness.service.apply(input());
    assert.deepEqual(result.data, resultData());
    assert.equal(result.httpStatus, 200);
    assert.equal(result.replayed, false);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(
      [
        result.data.allocation.rankedOffers[0]
          .totalValueCents,
        result.data.allocation.winner.termYears,
        result.data.appliedDeltas[0].afterSummary.aavCents,
      ],
      [null, null, null]
    );

    const applyCall = harness.calls.find(([kind]) => kind === "apply")[1];
    assert.deepEqual(
      {
        actorAuthority: applyCall.actorAuthority,
        actorMembershipId: applyCall.actorMembershipId,
        actorUserId: applyCall.actorUserId,
        completedAtMs: applyCall.completedAtMs,
        commandResultId: applyCall.commandResultId,
        idempotencyRequestId: applyCall.idempotencyRequestId,
        idempotencyExpiresAtMs: applyCall.idempotencyExpiresAtMs,
        requestJson: applyCall.requestJson,
        requestSha256: applyCall.requestSha256,
      },
      {
        actorAuthority: "commissioner",
        actorMembershipId: IDS.membership,
        actorUserId: IDS.actor,
        completedAtMs: COMPLETED_AT_MS,
        commandResultId: IDS.commandResult,
        idempotencyRequestId: IDS.idempotencyRequest,
        idempotencyExpiresAtMs:
          COMPLETED_AT_MS +
          FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_IDEMPOTENCY_LIFETIME_MS,
        requestJson:
          serializeFreeAgentDraftCorrectionApplyRequest(canonicalCommand()),
        requestSha256:
          hashFreeAgentDraftCorrectionApplyRequest(canonicalCommand()),
      }
    );
  });

  test("returns an exact immutable replay before consulting clock or randomness", async () => {
    const replayData = resultData({ completedAtMs: 1 });
    replayData.allocation.rankedOffers[0].totalValueCents = 600;
    replayData.allocation.rankedOffers[0].termYears = 2;
    replayData.allocation.rankedOffers[0].aavCents = 300;
    replayData.allocation.winner.totalValueCents = 600;
    replayData.allocation.winner.termYears = 2;
    replayData.allocation.winner.aavCents = 300;
    replayData.appliedDeltas[0].afterSummary.totalValueCents = 600;
    replayData.appliedDeltas[0].afterSummary.termYears = 2;
    replayData.appliedDeltas[0].afterSummary.aavCents = 300;
    const harness = createHarness({
      replay: {
        data: replayData,
        httpStatus: 200,
        replayed: true,
      },
      nowMs: Number.NaN,
      secureIds: [],
    });
    const result = await harness.service.apply(input());
    assert.deepEqual(
      result.data,
      resultData({ completedAtMs: 1 })
    );
    assert.equal(result.replayed, true);
    assert.deepEqual(
      [
        result.data.allocation.winner.totalValueCents,
        result.data.appliedDeltas[0].afterSummary.termYears,
      ],
      [null, null]
    );
    assert.deepEqual(
      harness.calls.map(([kind]) => kind),
      ["authorize", "replay"]
    );
  });

  test("maps an active member platform administrator to inherited commissioner authority", async () => {
    const harness = createHarness({
      authority: "platform_administrator",
    });
    await harness.service.apply(input());
    assert.equal(
      harness.calls.find(([kind]) => kind === "apply")[1]
        .actorAuthority,
      "platform_administrator_as_commissioner"
    );
  });

  test("rejects malformed requests and authorization failures before replay or apply", async () => {
    for (const request of [
      input({ expectedAllocationVersion: 0 }),
      input({ input: body({ winner: IDS.team }) }),
      input({ idempotencyKey: " unsafe" }),
      { ...input(), control: "override" },
    ]) {
      const harness = createHarness();
      await assert.rejects(() => harness.service.apply(request));
      assert.equal(
        harness.calls.some(([kind]) => ["replay", "apply"].includes(kind)),
        false
      );
    }

    const denial = Object.assign(new Error("denied"), {
      code: "LEAGUE_COMMISSIONER_REQUIRED",
    });
    const denied = createHarness({ authorizationError: denial });
    await assert.rejects(
      () => denied.service.apply(input()),
      (error) => error === denial
    );
    assert.deepEqual(
      denied.calls.map(([kind]) => kind),
      ["authorize"]
    );
  });

  test("rejects mismatched versions, identities, decision codes, and malformed repository envelopes", async () => {
    const partialAllocation = resultData();
    partialAllocation.allocation.winner.termYears = 2;
    const partialDelta = resultData();
    partialDelta.appliedDeltas[0].afterSummary.aavCents = 300;
    const cases = [
      { data: resultData({ allocation: { ...resultData().allocation, allocationVersion: 5 } }), httpStatus: 200, replayed: false, committedRoster: null },
      { data: resultData({ allocation: { ...resultData().allocation, allocationId: uuid(99) } }), httpStatus: 200, replayed: false, committedRoster: null },
      { data: resultData({ allocation: { ...resultData().allocation, decisionCode: "sole_valid_offer" } }), httpStatus: 200, replayed: false, committedRoster: null },
      { data: { ...resultData(), control: "leak" }, httpStatus: 200, replayed: false, committedRoster: null },
      { data: partialAllocation, httpStatus: 200, replayed: false, committedRoster: null },
      { data: partialDelta, httpStatus: 200, replayed: false, committedRoster: null },
      { data: resultData(), httpStatus: 202, replayed: false, committedRoster: null },
    ];
    for (const applyResult of cases) {
      const harness = createHarness({ applyResult });
      await assert.rejects(
        () => harness.service.apply(input()),
        (error) =>
          error instanceof
            FreeAgentDraftAllocationCorrectionServiceError &&
          error.code === "FAD_CORRECTION_RESULT_INVALID"
      );
    }
  });

  test("rejects unsafe clocks and repeated or noncanonical secure IDs before persistence", async () => {
    const unsafeClock = createHarness({ nowMs: Number.NaN });
    await assert.rejects(() => unsafeClock.service.apply(input()), /safe UTC/u);
    assert.equal(
      unsafeClock.calls.some(([kind]) => kind === "apply"),
      false
    );

    for (const secureIds of [
      [IDS.commandResult, IDS.commandResult],
      ["not-a-uuid", IDS.commandResult],
    ]) {
      const harness = createHarness({ secureIds });
      await assert.rejects(() => harness.service.apply(input()), /secure identifiers/u);
      assert.equal(
        harness.calls.some(([kind]) => kind === "apply"),
        false
      );
    }
  });

  test("coordinates an exact committed roster witness only after a fresh commit and never leaks it publicly", async () => {
    const committedRoster = Object.freeze({
      teams: Object.freeze([
        Object.freeze({
          leagueId: IDS.league,
          seasonId: uuid(20),
          teamId: IDS.team,
          ownershipWitnesses: Object.freeze([
            Object.freeze({
              ownershipId: IDS.ownership,
              ownershipVersion: 1,
              state: "present",
            }),
          ]),
        }),
      ]),
    });
    const harness = createHarness({
      applyResult: {
        data: resultData(),
        httpStatus: 200,
        replayed: false,
        committedRoster,
      },
    });
    const result = await harness.service.apply(input());
    assert.deepEqual(Object.keys(result).sort(), [
      "data",
      "httpStatus",
      "replayed",
    ]);
    assert.deepEqual(
      harness.calls.find(([kind]) => kind === "lateLock")[1],
      {
        mutationKind: "fad_allocation_correction",
        teams: committedRoster.teams,
      }
    );
  });

  test("does not reject or alter an already committed correction when late-lock coordination fails", async () => {
    const committedRoster = {
      teams: [
        {
          leagueId: IDS.league,
          seasonId: uuid(20),
          teamId: IDS.team,
          ownershipWitnesses: [
            {
              ownershipId: IDS.ownership,
              ownershipVersion: 1,
              state: "present",
            },
          ],
        },
      ],
    };
    const harness = createHarness({
      applyResult: {
        data: resultData(),
        httpStatus: 200,
        replayed: false,
        committedRoster,
      },
      lateLockError: new Error("late lock unavailable"),
    });
    assert.deepEqual(
      await harness.service.apply(input()),
      Object.freeze({
        data: resultData(),
        httpStatus: 200,
        replayed: false,
      })
    );
  });

  test("accepts repository-level race convergence as replay without post-commit coordination", async () => {
    const harness = createHarness({
      applyResult: {
        data: resultData({ completedAtMs: 9_000 }),
        httpStatus: 200,
        replayed: true,
      },
    });
    const result = await harness.service.apply(input());
    assert.equal(result.replayed, true);
    assert.equal(
      harness.calls.some(([kind]) => kind === "lateLock"),
      false
    );
  });
});
