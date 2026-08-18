const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  AUCTION_CREATION_CODES,
  AuctionCreationPolicyError,
} = require("../../src/domain/auctions/auctionCreationPolicy");
const {
  FAD_BINDING_CONFIRMATION_REQUIRED,
  decideFreeAgentDraftAuctionStart,
  validateAuctionStartBody,
} = require("../../src/domain/auctions/auctionStartDecisionPolicy");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const OPENS_AT_MS = Date.parse("2026-08-10T16:00:00.000Z");
const ROLLS_OVER_AT_MS = OPENS_AT_MS + DAY_MS;
const CREATION_CUTOFF_AT_MS = ROLLS_OVER_AT_MS - HOUR_MS;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  rollover: uuid(4),
  team: uuid(5),
  otherTeam: uuid(6),
  player: uuid(7),
  otherPlayer: uuid(8),
});

function body(overrides = {}) {
  return {
    playerId: IDS.player,
    teamId: IDS.team,
    aavCents: 300,
    termYears: 2,
    bindingIllegalityConfirmed: true,
    ...overrides,
  };
}

function authority(overrides = {}) {
  return {
    currentCommissioner: false,
    fadTeamParticipating: true,
    leagueStatus: "active",
    managerAssignmentAcceptedAtMs: OPENS_AT_MS - 1,
    managerAssignmentEndedAtMs: null,
    managerAssignmentStatus: "accepted",
    membershipStatus: "active",
    teamId: IDS.team,
    teamStatus: "active",
    ...overrides,
  };
}

function rapidContext(overrides = {}, rolloverOverrides = {}) {
  return {
    allocationCompletedAtMs: OPENS_AT_MS,
    candidateDeadlineAtMs: OPENS_AT_MS - 2,
    deadlineLockedAtMs: OPENS_AT_MS - 1,
    fadId: IDS.fad,
    fadStatus: "rapid",
    leagueId: IDS.league,
    seasonId: IDS.season,
    seasonStatus: "active",
    rollover: {
      creationCutoffAtMs: CREATION_CUTOFF_AT_MS,
      fadId: IDS.fad,
      id: IDS.rollover,
      leagueId: IDS.league,
      opensAtMs: OPENS_AT_MS,
      rollsOverAtMs: ROLLS_OVER_AT_MS,
      seasonId: IDS.season,
      status: "scheduled",
      ...rolloverOverrides,
    },
    ...overrides,
  };
}

function player(overrides = {}) {
  return {
    activeAuctionExists: false,
    fadEligible: true,
    id: IDS.player,
    owned: false,
    positionGroup: "F",
    quarantined: false,
    status: "active",
    ...overrides,
  };
}

function decisionInput({
  nowMs = CREATION_CUTOFF_AT_MS - 1,
  body: bodyValue = body(),
  authority: authorityValue = authority(),
  rapidContext: contextValue = rapidContext(),
  player: playerValue = player(),
} = {}) {
  return {
    authority: authorityValue,
    body: bodyValue,
    nowMs,
    player: playerValue,
    rapidContext: contextValue,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof AuctionCreationPolicyError);
    assert.equal(error.code, AUCTION_CREATION_CODES.inputInvalid);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("FAD-13 server-derived auction-start body policy", () => {
  test("preserves the exact ordinary four-field body and records FAD binding acceptance server-side", () => {
    const ordinaryInput = {
      playerId: IDS.player,
      teamId: IDS.team,
      aavCents: 300,
      termYears: 2,
    };
    const ordinary = validateAuctionStartBody(ordinaryInput, {
      sourceKind: "ordinary_weekly",
    });
    const fad = validateAuctionStartBody(ordinaryInput, {
      sourceKind: "fad_open_rapid",
    });

    assert.deepEqual(ordinary, {
      ...ordinaryInput,
      totalValueCents: 600,
    });
    assert.deepEqual(Object.keys(ordinary), [
      "playerId",
      "teamId",
      "totalValueCents",
      "aavCents",
      "termYears",
    ]);
    assert.equal(JSON.stringify(ordinary), JSON.stringify({
      playerId: IDS.player,
      teamId: IDS.team,
      totalValueCents: 600,
      aavCents: 300,
      termYears: 2,
    }));
    assert.deepEqual(fad, {
      ...ordinaryInput,
      totalValueCents: 600,
      bindingIllegalityConfirmed: true,
    });
    assert.ok(Object.isFrozen(ordinary));
    assert.ok(Object.isFrozen(fad));
    assert.equal(
      Object.hasOwn(ordinary, "bindingIllegalityConfirmed"),
      false
    );
  });

  test("rejects confirmation on ordinary starts and accepts only an optional literal true on FAD starts", () => {
    for (const bindingIllegalityConfirmed of [
      true,
      false,
      null,
      1,
    ]) {
      assertPolicyError(
        () =>
          validateAuctionStartBody(
            body({ bindingIllegalityConfirmed }),
            { sourceKind: "ordinary_weekly" }
          ),
        AUCTION_CREATION_CODES.inputInvalid
      );
    }

    for (const fadBody of [
      body({ bindingIllegalityConfirmed: false }),
      body({ bindingIllegalityConfirmed: null }),
      body({ bindingIllegalityConfirmed: 1 }),
    ]) {
      assertPolicyError(
        () =>
          validateAuctionStartBody(fadBody, {
            sourceKind: "fad_open_rapid",
          }),
        FAD_BINDING_CONFIRMATION_REQUIRED
      );
    }
    const missing = body();
    delete missing.bindingIllegalityConfirmed;
    assert.equal(
      validateAuctionStartBody(missing, {
        sourceKind: "fad_open_rapid",
      }).bindingIllegalityConfirmed,
      true
    );
  });

  test("rejects every caller-authored context, rollover, timing, and unknown body field", () => {
    for (const extraField of [
      "sourceKind",
      "fadId",
      "fadRolloverId",
      "sourceRolloverId",
      "targetOpeningRolloverId",
      "resolutionRolloverId",
      "opensAtMs",
      "resolvesAtMs",
      "acceptedAtMs",
      "bindingIllegalityConfirmedAtMs",
    ]) {
      assertPolicyError(
        () =>
          validateAuctionStartBody(
            { ...body(), [extraField]: "caller-value" },
            { sourceKind: "fad_open_rapid" }
          ),
        AUCTION_CREATION_CODES.inputInvalid
      );
    }
    assertPolicyError(
      () =>
        validateAuctionStartBody(body(), {
          sourceKind: "fad_restricted",
        }),
      AUCTION_CREATION_CODES.inputInvalid
    );
    assertPolicyError(
      () =>
        validateAuctionStartBody(body(), {
          sourceKind: "fad_open_rapid",
          fadId: IDS.fad,
        }),
      AUCTION_CREATION_CODES.inputInvalid
    );
  });

  test("inherits stable-ID, minimum AAV, term, and quarter-AAV validation", () => {
    for (const [overrides, reasonCode] of [
      [{ playerId: "not-an-id" }, AUCTION_CREATION_CODES.stableIdInvalid],
      [{ teamId: "not-an-id" }, AUCTION_CREATION_CODES.stableIdInvalid],
      [{ aavCents: 75, termYears: 2 }, AUCTION_CREATION_CODES.valueInvalid],
      [{ aavCents: 110, termYears: 2 }, AUCTION_CREATION_CODES.valueInvalid],
      [{ aavCents: 400, termYears: 4 }, AUCTION_CREATION_CODES.termInvalid],
    ]) {
      assertPolicyError(
        () =>
          validateAuctionStartBody(body(overrides), {
            sourceKind: "fad_open_rapid",
          }),
        reasonCode
      );
    }
  });
});

describe("FAD-13 server-derived rapid start decision policy", () => {
  test("opens with strictly more than 60 minutes and queues at every final-hour boundary", () => {
    const directAtOpen = decideFreeAgentDraftAuctionStart(
      decisionInput({ nowMs: OPENS_AT_MS })
    );
    const directAtLastInstant =
      decideFreeAgentDraftAuctionStart(
        decisionInput({
          nowMs: CREATION_CUTOFF_AT_MS - 1,
        })
      );
    assert.equal(directAtOpen.kind, "auction_opened");
    assert.equal(
      directAtLastInstant.kind,
      "auction_opened"
    );
    assert.deepEqual(
      {
        sourceRolloverId:
          directAtLastInstant.sourceRolloverId,
        targetOpeningRolloverId:
          directAtLastInstant.targetOpeningRolloverId,
        resolutionRolloverId:
          directAtLastInstant.resolutionRolloverId,
        acceptedAtMs: directAtLastInstant.acceptedAtMs,
        opensAtMs: directAtLastInstant.opensAtMs,
        resolvesAtMs: directAtLastInstant.resolvesAtMs,
        bindingIllegalityConfirmedAtMs:
          directAtLastInstant
            .bindingIllegalityConfirmedAtMs,
      },
      {
        sourceRolloverId: IDS.rollover,
        targetOpeningRolloverId: null,
        resolutionRolloverId: IDS.rollover,
        acceptedAtMs: CREATION_CUTOFF_AT_MS - 1,
        opensAtMs: CREATION_CUTOFF_AT_MS - 1,
        resolvesAtMs: ROLLS_OVER_AT_MS,
        bindingIllegalityConfirmedAtMs:
          CREATION_CUTOFF_AT_MS - 1,
      }
    );

    for (const nowMs of [
      CREATION_CUTOFF_AT_MS,
      CREATION_CUTOFF_AT_MS + 1,
      ROLLS_OVER_AT_MS - 1,
    ]) {
      const queued = decideFreeAgentDraftAuctionStart(
        decisionInput({ nowMs })
      );
      assert.deepEqual(
        {
          kind: queued.kind,
          sourceKind: queued.sourceKind,
          actorAuthority: queued.actorAuthority,
          sourceRolloverId: queued.sourceRolloverId,
          targetOpeningRolloverId:
            queued.targetOpeningRolloverId,
          resolutionRolloverId:
            queued.resolutionRolloverId,
          acceptedAtMs: queued.acceptedAtMs,
          opensAtMs: queued.opensAtMs,
          resolvesAtMs: queued.resolvesAtMs,
          bindingIllegalityConfirmedAtMs:
            queued.bindingIllegalityConfirmedAtMs,
        },
        {
          kind: "nomination_queued",
          sourceKind: "fad_open_rapid",
          actorAuthority: "manager",
          sourceRolloverId: IDS.rollover,
          targetOpeningRolloverId: IDS.rollover,
          resolutionRolloverId: null,
          acceptedAtMs: nowMs,
          opensAtMs: ROLLS_OVER_AT_MS,
          resolvesAtMs: ROLLS_OVER_AT_MS + DAY_MS,
          bindingIllegalityConfirmedAtMs: nowMs,
        }
      );
    }
  });

  test("admits an active assigned manager or current commissioner directly but keeps the private queue manager-only", () => {
    const manager = decideFreeAgentDraftAuctionStart(
      decisionInput()
    );
    assert.equal(manager.actorAuthority, "manager");

    const commissionerAuthority = authority({
      currentCommissioner: true,
      managerAssignmentAcceptedAtMs: null,
      managerAssignmentStatus: null,
    });
    const commissioner = decideFreeAgentDraftAuctionStart(
      decisionInput({ authority: commissionerAuthority })
    );
    assert.equal(
      commissioner.actorAuthority,
      "commissioner"
    );
    const dualRoleDirect =
      decideFreeAgentDraftAuctionStart(
        decisionInput({
          authority: authority({
            currentCommissioner: true,
          }),
        })
      );
    assert.equal(
      dualRoleDirect.actorAuthority,
      "manager"
    );
    assertPolicyError(
      () =>
        decideFreeAgentDraftAuctionStart(
          decisionInput({
            nowMs: CREATION_CUTOFF_AT_MS,
            authority: commissionerAuthority,
          })
        ),
      AUCTION_CREATION_CODES.authorizationDenied
    );

    const dualRoleQueue = decideFreeAgentDraftAuctionStart(
      decisionInput({
        nowMs: CREATION_CUTOFF_AT_MS,
        authority: authority({
          currentCommissioner: true,
        }),
      })
    );
    assert.equal(
      dualRoleQueue.actorAuthority,
      "manager"
    );

    const frozenCommissioner =
      decideFreeAgentDraftAuctionStart(
        decisionInput({
          authority: {
            ...commissionerAuthority,
            leagueStatus: "frozen",
          },
        })
      );
    assert.equal(
      frozenCommissioner.actorAuthority,
      "commissioner"
    );
    assertPolicyError(
      () =>
        decideFreeAgentDraftAuctionStart(
          decisionInput({
            authority: authority({
              leagueStatus: "frozen",
            }),
          })
        ),
      AUCTION_CREATION_CODES.authorizationDenied
    );
  });

  test("fails closed for stale, inactive, cross-team, and non-participating authority evidence", () => {
    const deniedAuthorities = [
      authority({ membershipStatus: "ended" }),
      authority({ teamStatus: "inactive" }),
      authority({ teamId: IDS.otherTeam }),
      authority({ fadTeamParticipating: false }),
      authority({ managerAssignmentStatus: "pending" }),
      authority({ managerAssignmentEndedAtMs: OPENS_AT_MS }),
      authority({
        managerAssignmentAcceptedAtMs:
          CREATION_CUTOFF_AT_MS,
      }),
      authority({
        currentCommissioner: false,
        managerAssignmentAcceptedAtMs: null,
        managerAssignmentStatus: null,
      }),
    ];
    for (const authorityValue of deniedAuthorities) {
      assertPolicyError(
        () =>
          decideFreeAgentDraftAuctionStart(
            decisionInput({ authority: authorityValue })
          ),
        AUCTION_CREATION_CODES.authorizationDenied
      );
    }
  });

  test("fails closed outside one active rapid context or a current exact elapsed-time rollover", () => {
    for (const nowMs of [
      OPENS_AT_MS - 1,
      ROLLS_OVER_AT_MS,
      ROLLS_OVER_AT_MS + 1,
    ]) {
      assertPolicyError(
        () =>
          decideFreeAgentDraftAuctionStart(
            decisionInput({
              nowMs,
              rapidContext:
                nowMs < OPENS_AT_MS
                  ? rapidContext({
                      allocationCompletedAtMs:
                        OPENS_AT_MS - 1,
                    })
                  : rapidContext(),
            })
          ),
        AUCTION_CREATION_CODES.windowClosed
      );
    }
    for (const contextValue of [
      rapidContext({ seasonStatus: "completed" }),
      rapidContext({
        allocationCompletedAtMs:
          CREATION_CUTOFF_AT_MS,
      }),
      rapidContext({}, { leagueId: uuid(99) }),
      rapidContext({}, { seasonId: uuid(99) }),
      rapidContext({}, { fadId: uuid(99) }),
    ]) {
      assertPolicyError(
        () =>
          decideFreeAgentDraftAuctionStart(
            decisionInput({ rapidContext: contextValue })
          ),
        AUCTION_CREATION_CODES.seasonUnavailable
      );
    }
    for (const contextValue of [
      rapidContext({ candidateDeadlineAtMs: CREATION_CUTOFF_AT_MS }),
      rapidContext({ deadlineLockedAtMs: CREATION_CUTOFF_AT_MS }),
      rapidContext({ fadStatus: "allocating" }),
    ]) {
      if (contextValue.fadStatus === "allocating") {
        contextValue.allocationCompletedAtMs = OPENS_AT_MS;
      }
      assertPolicyError(
        () =>
          decideFreeAgentDraftAuctionStart(
            decisionInput({ rapidContext: contextValue })
          ),
        AUCTION_CREATION_CODES.seasonUnavailable
      );
    }
    assertPolicyError(
      () =>
        decideFreeAgentDraftAuctionStart(
          decisionInput({
            rapidContext: rapidContext({}, {
              status: "processing",
            }),
          })
        ),
      AUCTION_CREATION_CODES.windowClosed
    );
    for (const rolloverValue of [
      {
        creationCutoffAtMs:
          CREATION_CUTOFF_AT_MS + 1,
      },
      { rollsOverAtMs: ROLLS_OVER_AT_MS + 1 },
    ]) {
      assertPolicyError(
        () =>
          decideFreeAgentDraftAuctionStart(
            decisionInput({
              rapidContext: rapidContext(
                {},
                rolloverValue
              ),
            })
          ),
        AUCTION_CREATION_CODES.inputInvalid
      );
    }
  });

  test("allows an eligible nomination while allocation ties are still resolving", () => {
    const decision = decideFreeAgentDraftAuctionStart(
      decisionInput({
        rapidContext: rapidContext({
          allocationCompletedAtMs: null,
          fadStatus: "allocating",
        }),
      })
    );

    assert.equal(decision.kind, "auction_opened");
    assert.equal(decision.sourceKind, "fad_open_rapid");
  });

  test("uses elapsed milliseconds across DST rather than local-calendar arithmetic", () => {
    const dstOpensAtMs = Date.parse(
      "2026-10-31T23:30:00-07:00"
    );
    const dstRollsOverAtMs = dstOpensAtMs + DAY_MS;
    const dstCutoffAtMs = dstRollsOverAtMs - HOUR_MS;
    const context = rapidContext(
      { allocationCompletedAtMs: dstOpensAtMs },
      {
        opensAtMs: dstOpensAtMs,
        creationCutoffAtMs: dstCutoffAtMs,
        rollsOverAtMs: dstRollsOverAtMs,
      }
    );
    const direct = decideFreeAgentDraftAuctionStart(
      decisionInput({
        nowMs: dstCutoffAtMs - 1,
        rapidContext: context,
      })
    );
    const queued = decideFreeAgentDraftAuctionStart(
      decisionInput({
        nowMs: dstCutoffAtMs,
        rapidContext: context,
      })
    );

    assert.equal(direct.kind, "auction_opened");
    assert.equal(queued.kind, "nomination_queued");
    assert.equal(
      dstRollsOverAtMs - dstOpensAtMs,
      DAY_MS
    );
    assert.equal(
      queued.resolvesAtMs - queued.opensAtMs,
      DAY_MS
    );
    assert.notEqual(
      new Date(dstOpensAtMs).toLocaleString("en-US", {
        timeZone: "America/Vancouver",
        hour: "2-digit",
        hour12: false,
      }),
      new Date(dstRollsOverAtMs).toLocaleString("en-US", {
        timeZone: "America/Vancouver",
        hour: "2-digit",
        hour12: false,
      })
    );
  });

  test("rejects ineligible, owned, or already-active players and collapses every private quarantine cause", () => {
    for (const playerValue of [
      player({ fadEligible: false }),
      player({ status: "inactive" }),
      player({ positionGroup: "G" }),
      player({ id: IDS.otherPlayer }),
    ]) {
      assertPolicyError(
        () =>
          decideFreeAgentDraftAuctionStart(
            decisionInput({ player: playerValue })
          ),
        AUCTION_CREATION_CODES.playerIneligible
      );
    }
    assertPolicyError(
      () =>
        decideFreeAgentDraftAuctionStart(
          decisionInput({ player: player({ owned: true }) })
        ),
      AUCTION_CREATION_CODES.playerOwned
    );
    assertPolicyError(
      () =>
        decideFreeAgentDraftAuctionStart(
          decisionInput({
            player: player({ activeAuctionExists: true }),
          })
        ),
      AUCTION_CREATION_CODES.activeAuctionExists
    );

    for (const privateCause of [
      "allocation_pending",
      "queued_by_other_team",
      "unresolved_auction_recovery",
      "correction_required",
    ]) {
      let caught;
      try {
        decideFreeAgentDraftAuctionStart(
          decisionInput({
            player: player({ quarantined: true }),
          })
        );
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof AuctionCreationPolicyError);
      assert.equal(
        caught.reasonCode,
        AUCTION_CREATION_CODES.fadAllocationQuarantined
      );
      const serialized = JSON.stringify({
        name: caught.name,
        code: caught.code,
        reasonCode: caught.reasonCode,
        message: caught.message,
      });
      assert.equal(serialized.includes(privateCause), false);
      assert.equal(serialized.includes(IDS.otherTeam), false);
      assert.equal(serialized.includes(IDS.rollover), false);
    }
  });

  test("returns a detached immutable deterministic plan with no future queue rollover ID", () => {
    const input = decisionInput({
      nowMs: CREATION_CUTOFF_AT_MS,
    });
    const first = decideFreeAgentDraftAuctionStart(input);
    const replay = decideFreeAgentDraftAuctionStart(
      decisionInput({
        nowMs: CREATION_CUTOFF_AT_MS,
      })
    );

    assert.deepEqual(replay, first);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.body));
    assert.equal(first.resolutionRolloverId, null);
    assert.equal(first.resolvesAtMs, ROLLS_OVER_AT_MS + DAY_MS);
    input.body.totalValueCents = 900;
    input.rapidContext.rollover.rollsOverAtMs += DAY_MS;
    assert.equal(first.body.totalValueCents, 600);
    assert.equal(first.resolvesAtMs, ROLLS_OVER_AT_MS + DAY_MS);
  });
});
