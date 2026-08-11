"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_CORRECTION_CODES,
  FREE_AGENT_DRAFT_CORRECTION_MODE,
  createFreeAgentDraftCorrectionPreview,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);
const {
  FreeAgentDraftCorrectionPreviewServiceError,
  createFreeAgentDraftCorrectionPreviewService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftCorrectionPreviewService"
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
  recovery: uuid(7),
  actor: uuid(8),
  membership: uuid(9),
});

function team() {
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

function decision(recoveryStatus) {
  return {
    status: "invalid",
    decisionCode: "invalid_snapshot",
    rankedOffers: [
      {
        snapshotEntryId: IDS.snapshot,
        teamId: IDS.team,
        team: team(),
        slotKey: "F01",
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
        valid: false,
        validationCode: "INVALID_SNAPSHOT",
        rank: null,
        outcomeCode: "invalid",
      },
    ],
    winner: null,
    restricted: null,
    recoveryStatus,
  };
}

function afterSummary(overrides = {}) {
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

function validPreview(overrides = {}) {
  return createFreeAgentDraftCorrectionPreview({
    leagueId: IDS.league,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    allocationVersion: 3,
    reversible: true,
    currentDecision: decision("correction_required"),
    recomputedDecision: decision("resolved"),
    deltas: [
      {
        resourceType: "recovery",
        resourceId: IDS.recovery,
        action: "resolve",
        beforeVersion: 2,
        afterSummary: afterSummary({ status: "resolved" }),
      },
    ],
    warnings: [],
    blockers: [],
    ...overrides,
  });
}

function input(overrides = {}) {
  return {
    allocationId: IDS.allocation,
    authenticated: Object.freeze({ userId: IDS.actor }),
    fadId: IDS.fad,
    input: { mode: FREE_AGENT_DRAFT_CORRECTION_MODE },
    leagueId: IDS.league,
    ...overrides,
  };
}

function createHarness({
  authority = "commissioner",
  repositoryResult = validPreview(),
  authorizationError = null,
} = {}) {
  const calls = [];
  const leagueAuthorization = {
    requireCommissioner(authenticated, leagueId) {
      calls.push(["authorize", authenticated, leagueId]);
      if (authorizationError) throw authorizationError;
      return {
        actorUserId: IDS.actor,
        membershipId: IDS.membership,
        authority,
      };
    },
  };
  const repository = {
    previewAllocationCorrection(command) {
      calls.push(["preview", command]);
      return repositoryResult;
    },
  };
  return {
    calls,
    service: createFreeAgentDraftCorrectionPreviewService({
      leagueAuthorization,
      repository,
    }),
  };
}

describe("Free Agent Draft correction-preview service foundation", () => {
  test("requires exact authorization and read-repository dependencies", () => {
    assert.throws(
      () => createFreeAgentDraftCorrectionPreviewService(),
      /league-commissioner authorization/u
    );
    assert.throws(
      () =>
        createFreeAgentDraftCorrectionPreviewService({
          leagueAuthorization: { requireCommissioner() {} },
          repository: {},
        }),
      /read-only correction-preview persistence/u
    );
  });

  test("authorizes and returns the exact canonical read-only preview", () => {
    const harness = createHarness();
    const result = harness.service.preview(input());

    assert.deepEqual(result, validPreview());
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(harness.calls, [
      ["authorize", input().authenticated, IDS.league],
      [
        "preview",
        {
          actorAuthority: "commissioner",
          actorMembershipId: IDS.membership,
          actorUserId: IDS.actor,
          allocationId: IDS.allocation,
          fadId: IDS.fad,
          leagueId: IDS.league,
          mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
        },
      ],
    ]);
  });

  test("maps a member platform administrator to inherited commissioner authority", () => {
    const harness = createHarness({
      authority: "platform_administrator",
    });
    harness.service.preview(input());
    assert.equal(
      harness.calls[1][1].actorAuthority,
      "platform_administrator_as_commissioner"
    );
  });

  test("rejects malformed bodies and unknown service fields before persistence", () => {
    for (const request of [
      input({ input: { mode: "choose_winner" } }),
      input({ input: { mode: FREE_AGENT_DRAFT_CORRECTION_MODE, winner: IDS.team } }),
      { ...input(), control: "override" },
    ]) {
      const harness = createHarness();
      assert.throws(
        () => harness.service.preview(request),
        (error) =>
          error.code ===
          FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid
      );
      assert.equal(
        harness.calls.some(([kind]) => kind === "preview"),
        false
      );
    }
  });

  test("does not read correction state when commissioner authorization fails", () => {
    const denial = Object.assign(new Error("denied"), {
      code: "LEAGUE_COMMISSIONER_REQUIRED",
    });
    const harness = createHarness({
      authorizationError: denial,
    });
    assert.throws(
      () => harness.service.preview(input()),
      (error) => error === denial
    );
    assert.deepEqual(
      harness.calls.map(([kind]) => kind),
      ["authorize"]
    );
  });

  test("rejects mismatched, corrupt, or noncanonical repository projections", () => {
    const cases = [
      validPreview({ allocationId: uuid(99) }),
      { ...validPreview(), previewFingerprint: "0".repeat(64) },
      { ...validPreview(), control: "leak" },
    ];
    for (const repositoryResult of cases) {
      const harness = createHarness({ repositoryResult });
      assert.throws(
        () => harness.service.preview(input()),
        (error) =>
          error instanceof
            FreeAgentDraftCorrectionPreviewServiceError &&
          error.code === "FAD_CORRECTION_RESULT_INVALID"
      );
      assert.deepEqual(
        harness.calls.map(([kind]) => kind),
        ["authorize", "preview"]
      );
    }
  });
});
