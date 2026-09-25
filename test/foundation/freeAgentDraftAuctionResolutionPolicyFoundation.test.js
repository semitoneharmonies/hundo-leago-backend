const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  evaluateAuctionResolution,
} = require(
  "../../src/domain/auctions/auctionResolutionPolicy"
);
const {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES,
  FreeAgentDraftAuctionResolutionPolicyError,
  evaluateFreeAgentDraftAuctionResolution,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionResolutionPolicy"
);
const {
  FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);

const ROLLOVER_AT_MS = 2_000_000_000;
const NONCE = Uint8Array.from(
  { length: 32 },
  (_, index) => index
);

function uuid(number) {
  return (
    "00000000-0000-4000-8000-" +
    String(number).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  auction: uuid(2),
  player: uuid(3),
  allocation: uuid(4),
  participant1: uuid(5),
  participant2: uuid(6),
  participant3: uuid(7),
  team1: uuid(8),
  team2: uuid(9),
  team3: uuid(10),
  bid1: uuid(11),
  bid2: uuid(12),
  bid3: uuid(13),
});

function aav(totalValueCents, termYears) {
  const whole = Math.floor(
    totalValueCents / termYears
  );
  const remainder = totalValueCents % termYears;
  return whole +
    (remainder * 2 >= termYears ? 1 : 0);
}

function contract(
  totalValueCents = 300,
  termYears = 2
) {
  return {
    totalValueCents,
    termYears,
    aavCents: aav(totalValueCents, termYears),
  };
}

function drawEvidence() {
  const commitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.auction,
      nonceBytes: NONCE,
    });
  return {
    algorithmVersion:
      FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
    commitmentHex: commitment.commitmentHex,
    nonceBytes: NONCE,
  };
}

function bid({
  id = IDS.bid1,
  teamId = IDS.team1,
  totalValueCents = 600,
  termYears = 2,
  lowestOfferedAavCents = aav(
    totalValueCents,
    termYears
  ),
  lowestOfferedTotalValueCents = totalValueCents,
  firstSubmittedAtMs = ROLLOVER_AT_MS - 1_000,
  status = "active",
  teamStatus = "active",
  authorityValid = true,
  isStartingBid = false,
} = {}) {
  return {
    id,
    leagueId: IDS.league,
    auctionId: IDS.auction,
    teamId,
    status,
    teamStatus,
    totalValueCents,
    termYears,
    lowestOfferedAavCents,
    lowestOfferedTotalValueCents,
    firstSubmittedAtMs,
    isStartingBid,
    authorityValid,
  };
}

function participant({
  id = IDS.participant1,
  teamId = IDS.team1,
  activeImprovementBidId = null,
  status = "active",
  floor = contract(),
} = {}) {
  return {
    id,
    leagueId: IDS.league,
    allocationId: IDS.allocation,
    auctionId: IDS.auction,
    teamId,
    status,
    activeImprovementBidId,
    minimumTotalValueCents:
      floor.totalValueCents,
    minimumTermYears: floor.termYears,
    minimumAavCents: floor.aavCents,
  };
}

function resolutionInput({
  kind = "restricted",
  floor = contract(),
  bids = [],
  participants,
  auction = {},
  context = {},
  draw = drawEvidence(),
} = {}) {
  const restricted = kind === "restricted";
  const fallback = kind === "fallback";
  const allocationLinked = restricted || fallback;
  const origin = {
    restricted: "candidate_tie_restricted",
    fallback: "restricted_no_improvement_fallback",
    direct: "manager_nomination",
    queued: "queued_nomination",
  }[kind];
  return {
    context: {
      sourceKind: restricted
        ? "fad_restricted"
        : "fad_open_rapid",
      origin,
      allocationId: allocationLinked
        ? IDS.allocation
        : null,
      ...context,
    },
    auction: {
      id: IDS.auction,
      leagueId: IDS.league,
      playerId: IDS.player,
      status: "open",
      resolvesAtMs: ROLLOVER_AT_MS,
      playerOwned: false,
      nowMs: ROLLOVER_AT_MS,
      ...auction,
    },
    bids,
    participants:
      participants ??
      (restricted
        ? [
            participant({ floor }),
            participant({
              id: IDS.participant2,
              teamId: IDS.team2,
              floor,
            }),
          ]
        : []),
    floor: allocationLinked ? floor : null,
    draw,
  };
}

function assertPolicyError(
  callback,
  { code, reasonCode }
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftAuctionResolutionPolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe(
  "Free Agent Draft auction resolution policy foundation",
  () => {
    test(
      "returns the mandatory restricted fallback with a no-selection reveal when no active linked improvement remains",
      () => {
        const floor = contract(500, 1);
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              floor,
              bids: [
                bid({
                  status: "withdrawn",
                  totalValueCents: 600,
                  termYears: 1,
                }),
              ],
              participants: [
                participant({
                  floor,
                  activeImprovementBidId: IDS.bid1,
                }),
                participant({
                  id: IDS.participant2,
                  teamId: IDS.team2,
                  floor,
                }),
              ],
            })
          );

        assert.equal(result.outcome, "restricted_fallback");
        assert.equal(result.eligibleBidCount, 0);
        assert.deepEqual(result.rankedBids, []);
        assert.deepEqual(result.tiedTopBids, []);
        assert.deepEqual(result.skippedBids, [
          {
            bidId: IDS.bid1,
            reasonCode:
              "AUCTION_RESOLUTION_BID_INACTIVE",
          },
        ]);
        assert.equal(
          result.drawReveal.selectionUsed,
          false
        );
        assert.deepEqual(
          result.drawReveal.orderedBidIds,
          []
        );
        assert.equal(
          result.drawReveal.selectedBidId,
          null
        );
      }
    );

    test(
      "admits only exact active participant-linked strict improvements and skips stale, removed, and below-floor bids",
      () => {
        const floor = contract(500, 1);
        const valid = bid({
          id: IDS.bid1,
          teamId: IDS.team1,
          totalValueCents: 1200,
          termYears: 2,
          lowestOfferedAavCents: 250,
        });
        const removed = bid({
          id: IDS.bid2,
          teamId: IDS.team2,
          totalValueCents: 700,
          termYears: 2,
        });
        const belowFloor = bid({
          id: IDS.bid3,
          teamId: IDS.team3,
          totalValueCents: 500,
          termYears: 2,
        });
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              floor,
              bids: [belowFloor, removed, valid],
              participants: [
                participant({
                  floor,
                  activeImprovementBidId: IDS.bid1,
                }),
                participant({
                  id: IDS.participant2,
                  teamId: IDS.team2,
                  floor,
                  status: "removed",
                }),
                participant({
                  id: IDS.participant3,
                  teamId: IDS.team3,
                  floor,
                  activeImprovementBidId: IDS.bid3,
                }),
              ],
            })
          );

        assert.equal(result.outcome, "winner");
        assert.equal(result.eligibleBidCount, 1);
        assert.equal(result.winner.bidId, IDS.bid1);
        assert.deepEqual(
          result.skippedBids.map(
            ({ bidId, reasonCode }) => [
              bidId,
              reasonCode,
            ]
          ),
          [
            [
              IDS.bid2,
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .participantInactive,
            ],
            [
              IDS.bid3,
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .restrictedFloorNotImproved,
            ],
          ]
        );
      }
    );

    test(
      "ranks higher AAV ahead of longer lower-AAV offers and charges an actual submitted offer",
      () => {
        const floor = contract(500, 1);
        const winner = bid({
          id: IDS.bid1,
          teamId: IDS.team1,
          totalValueCents: 1250,
          termYears: 2,
          lowestOfferedAavCents: 200,
        });
        const competitor = bid({
          id: IDS.bid2,
          teamId: IDS.team2,
          totalValueCents: 1800,
          termYears: 3,
          lowestOfferedAavCents: 200,
        });
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              floor,
              bids: [competitor, winner],
              participants: [
                participant({
                  floor,
                  activeImprovementBidId: IDS.bid1,
                }),
                participant({
                  id: IDS.participant2,
                  teamId: IDS.team2,
                  floor,
                  activeImprovementBidId: IDS.bid2,
                }),
              ],
            })
          );

        assert.equal(result.outcome, "winner");
        assert.equal(result.winner.bidId, IDS.bid1);
        assert.equal(
          result.winner.highestCompetingAavCents,
          600
        );
        assert.equal(
          result.winner.requiredWinningAavCents,
          625
        );
        assert.equal(
          result.winner.finalTotalValueCents,
          1250
        );
        assert.equal(result.winner.finalAavCents, 625);
        assert.equal(
          result.drawReveal.selectionUsed,
          false
        );
      }
    );

    test(
      "rechecks the joining minimum for every restricted current improvement",
      () => {
        const floor = contract(100, 1);
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              floor,
              bids: [
                bid({
                  totalValueCents: 101,
                  termYears: 1,
                  lowestOfferedAavCents: 101,
                }),
              ],
              participants: [
                participant({
                  floor,
                  activeImprovementBidId: IDS.bid1,
                }),
                participant({
                  id: IDS.participant2,
                  teamId: IDS.team2,
                  floor,
                }),
              ],
            })
          );

        assert.equal(result.outcome, "restricted_fallback");
        assert.deepEqual(result.skippedBids, [
          {
            bidId: IDS.bid1,
            reasonCode:
              "AUCTION_RESOLUTION_VALUE_INVALID",
          },
        ]);
      }
    );

    test(
      "selects the earliest original bid in a restricted tie regardless of stable ID or input order",
      () => {
        const floor = contract(300, 2);
        const laterLowerId = bid({
          id: IDS.bid1,
          teamId: IDS.team1,
          firstSubmittedAtMs:
            ROLLOVER_AT_MS - 1_000,
        });
        const earlierHigherId = bid({
          id: IDS.bid2,
          teamId: IDS.team2,
          firstSubmittedAtMs:
            ROLLOVER_AT_MS - 10_000,
        });
        const participants = [
          participant({
            floor,
            activeImprovementBidId: IDS.bid1,
          }),
          participant({
            id: IDS.participant2,
            teamId: IDS.team2,
            floor,
            activeImprovementBidId: IDS.bid2,
          }),
        ];
        const first =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              floor,
              bids: [
                earlierHigherId,
                laterLowerId,
              ],
              participants,
            })
          );
        const replay =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              floor,
              bids: [
                laterLowerId,
                earlierHigherId,
              ],
              participants: [...participants].reverse(),
            })
          );

        assert.deepEqual(replay, first);
        assert.equal(first.outcome, "winner");
        assert.equal(
          first.drawReveal.selectionUsed,
          false
        );
        assert.deepEqual(
          first.drawReveal.orderedBidIds,
          []
        );
        assert.equal(
          first.winner.bidId,
          IDS.bid2
        );
        assert.equal(
          first.winner.teamId,
          IDS.team2
        );
        assert.deepEqual(
          first.rankedBids.map(({ rank }) => rank),
          [1, 1]
        );
        assert.deepEqual(
          first.tiedTopBids.map(({ bidId }) => bidId),
          [IDS.bid2, IDS.bid1]
        );
        assert.ok(Object.isFrozen(first));
        assert.ok(Object.isFrozen(first.rankedBids));
        assert.ok(Object.isFrozen(first.drawReveal));
        assert.ok(
          Object.isFrozen(
            first.drawReveal.orderedBidIds
          )
        );
      }
    );

    test(
      "accepts an equal fallback floor, rejects the same total at lower AAV, and returns no winner without selection",
      () => {
        const floor = contract(500, 1);
        const equalFloor = bid({
          id: IDS.bid1,
          teamId: IDS.team1,
          totalValueCents: 500,
          termYears: 1,
        });
        const lowerAav = bid({
          id: IDS.bid2,
          teamId: IDS.team2,
          totalValueCents: 500,
          termYears: 2,
        });
        const winning =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "fallback",
              floor,
              bids: [lowerAav, equalFloor],
            })
          );

        assert.equal(winning.outcome, "winner");
        assert.equal(winning.winner.bidId, IDS.bid1);
        assert.deepEqual(winning.skippedBids, [
          {
            bidId: IDS.bid2,
            reasonCode:
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .fallbackFloorNotMet,
          },
        ]);

        const empty =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "fallback",
              floor,
              bids: [lowerAav],
            })
          );
        assert.equal(empty.outcome, "no_winner");
        assert.equal(empty.eligibleBidCount, 0);
        assert.equal(
          empty.drawReveal.selectionUsed,
          false
        );
      }
    );

    test(
      "uses actual-offer pricing for an allocation-linked fallback winner",
      () => {
        const floor = contract(400, 2);
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "fallback",
              floor,
              bids: [
                bid({
                  id: IDS.bid1,
                  teamId: IDS.team1,
                  totalValueCents: 900,
                  termYears: 3,
                  lowestOfferedAavCents: 200,
                  lowestOfferedTotalValueCents: 600,
                }),
                bid({
                  id: IDS.bid2,
                  teamId: IDS.team2,
                  totalValueCents: 600,
                  termYears: 3,
                  lowestOfferedAavCents: 200,
                }),
              ],
            })
          );

        assert.equal(result.winner.bidId, IDS.bid1);
        assert.equal(
          result.winner.highestCompetingAavCents,
          200
        );
        assert.equal(
          result.winner.persistedSecondPriceInputCents,
          600
        );
        assert.equal(
          result.winner.finalTotalValueCents,
          900
        );
        assert.equal(result.winner.finalAavCents, 300);
      }
    );

    test(
      "retains a legitimate below-joining fallback edit when its current contract still meets the immutable floor",
      () => {
        const floor = contract(100, 1);
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "fallback",
              floor,
              bids: [
                bid({
                  totalValueCents: 100,
                  termYears: 1,
                  lowestOfferedAavCents: 100,
                }),
              ],
            })
          );

        assert.equal(result.outcome, "winner");
        assert.equal(result.winner.bidId, IDS.bid1);
        assert.equal(
          result.winner.finalTotalValueCents,
          100
        );
      }
    );

    test(
      "keeps a sole winner at its submitted price and exposes the schema-only zero second-price sentinel",
      () => {
        const floor = contract(500, 2);
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "fallback",
              floor,
              bids: [
                bid({
                  totalValueCents: 900,
                  termYears: 3,
                  lowestOfferedAavCents: 200,
                }),
              ],
            })
          );

        assert.equal(
          result.winner.highestCompetingAavCents,
          null
        );
        assert.equal(
          result.winner.persistedSecondPriceInputCents,
          0
        );
        assert.equal(
          result.winner.requiredWinningAavCents,
          300
        );
        assert.equal(
          result.winner.finalTotalValueCents,
          900
        );
      }
    );

    test(
      "admits the direct starter and all other active valid bids with actual-offer pricing",
      () => {
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "direct",
              bids: [
                bid({
                  id: IDS.bid1,
                  teamId: IDS.team1,
                  totalValueCents: 900,
                  termYears: 3,
                  lowestOfferedAavCents: 200,
                  lowestOfferedTotalValueCents: 600,
                  isStartingBid: true,
                }),
                bid({
                  id: IDS.bid2,
                  teamId: IDS.team2,
                  totalValueCents: 600,
                  termYears: 3,
                  lowestOfferedAavCents: 200,
                }),
              ],
            })
          );

        assert.equal(result.outcome, "winner");
        assert.equal(result.allocationId, null);
        assert.equal(result.winner.bidId, IDS.bid1);
        assert.equal(
          result.winner.highestCompetingAavCents,
          200
        );
        assert.equal(
          result.winner.persistedSecondPriceInputCents,
          600
        );
        assert.equal(
          result.winner.finalTotalValueCents,
          900
        );
        assert.equal(result.drawReveal.selectionUsed, false);
      }
    );

    test(
      "keeps a sole direct starter at its submitted price with the zero second-price sentinel",
      () => {
        const result =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "direct",
              bids: [
                bid({
                  totalValueCents: 900,
                  termYears: 3,
                  lowestOfferedAavCents: 200,
                  isStartingBid: true,
                }),
              ],
            })
          );

        assert.equal(result.outcome, "winner");
        assert.equal(
          result.winner.highestCompetingAavCents,
          null
        );
        assert.equal(
          result.winner.persistedSecondPriceInputCents,
          0
        );
        assert.equal(
          result.winner.requiredWinningAavCents,
          300
        );
        assert.equal(
          result.winner.finalTotalValueCents,
          900
        );
      }
    );

    test(
      "uses stable bid ID only for identical timestamps in a queued tie and is stable under reordering",
      () => {
        const starter = bid({
          id: IDS.bid1,
          teamId: IDS.team1,
          isStartingBid: true,
        });
        const contender = bid({
          id: IDS.bid2,
          teamId: IDS.team2,
        });
        const first =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "queued",
              bids: [contender, starter],
            })
          );
        const replay =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "queued",
              bids: [starter, contender],
            })
          );

        assert.deepEqual(replay, first);
        assert.equal(first.outcome, "winner");
        assert.equal(first.allocationId, null);
        assert.equal(first.drawReveal.selectionUsed, false);
        assert.deepEqual(
          first.drawReveal.orderedBidIds,
          []
        );
        assert.equal(
          first.winner.bidId,
          IDS.bid1
        );
        assert.deepEqual(
          first.tiedTopBids.map(({ bidId }) => bidId),
          [IDS.bid1, IDS.bid2]
        );
      }
    );

    test(
      "returns an unclaimed no-winner result without selection when no direct or queued bid remains eligible",
      () => {
        for (const kind of ["direct", "queued"]) {
          const result =
            evaluateFreeAgentDraftAuctionResolution(
              resolutionInput({
                kind,
                bids: [
                  bid({
                    status: "withdrawn",
                    isStartingBid: true,
                  }),
                ],
              })
            );

          assert.equal(result.outcome, "no_winner");
          assert.equal(result.allocationId, null);
          assert.equal(result.eligibleBidCount, 0);
          assert.deepEqual(result.rankedBids, []);
          assert.deepEqual(result.tiedTopBids, []);
          assert.equal(
            result.drawReveal.selectionUsed,
            false
          );
          assert.deepEqual(
            result.drawReveal.orderedBidIds,
            []
          );
        }
      }
    );

    test(
      "continues to reject persisted starters from allocation-linked restricted and fallback auctions",
      () => {
        const floor = contract(500, 1);
        for (const kind of ["restricted", "fallback"]) {
          const result =
            evaluateFreeAgentDraftAuctionResolution(
              resolutionInput({
                kind,
                floor,
                bids: [
                  bid({
                    totalValueCents: 600,
                    termYears: 1,
                    isStartingBid: true,
                  }),
                ],
                ...(kind === "restricted"
                  ? {
                      participants: [
                        participant({
                          floor,
                          activeImprovementBidId: IDS.bid1,
                        }),
                        participant({
                          id: IDS.participant2,
                          teamId: IDS.team2,
                          floor,
                        }),
                      ],
                    }
                  : {}),
              })
            );

          assert.equal(
            result.outcome,
            kind === "restricted"
              ? "restricted_fallback"
              : "no_winner"
          );
          assert.deepEqual(result.skippedBids, [
            {
              bidId: IDS.bid1,
              reasonCode:
                FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                  .fadBidMustBeNonstarter,
            },
          ]);
        }
      }
    );

    test(
      "fails closed for malformed open-rapid authority inputs and other authoritative evidence",
      () => {
        assertPolicyError(
          () =>
            evaluateFreeAgentDraftAuctionResolution({
              ...resolutionInput({ kind: "direct" }),
              floor: contract(),
            }),
          {
            code:
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .floorInvalid,
            reasonCode: "open_rapid_floor_not_null",
          }
        );
        assertPolicyError(
          () =>
            evaluateFreeAgentDraftAuctionResolution({
              ...resolutionInput({ kind: "queued" }),
              participants: [participant()],
            }),
          {
            code:
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .participantInvalid,
            reasonCode: "open_rapid_participants_not_empty",
          }
        );
        assertPolicyError(
          () =>
            evaluateFreeAgentDraftAuctionResolution(
              resolutionInput({
                kind: "direct",
                context: {
                  allocationId: IDS.allocation,
                },
              })
            ),
          {
            code:
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .contextInvalid,
            reasonCode:
              "open_rapid_allocation_id_not_null",
          }
        );

        assertPolicyError(
          () =>
            evaluateFreeAgentDraftAuctionResolution({
              ...resolutionInput(),
              extra: true,
            }),
          {
            code:
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .inputInvalid,
            reasonCode: "resolution_fields_invalid",
          }
        );
        assertPolicyError(
          () =>
            evaluateFreeAgentDraftAuctionResolution(
              resolutionInput({
                draw: {
                  ...drawEvidence(),
                  commitmentHex: "0".repeat(64),
                },
              })
            ),
          {
            code:
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .drawInvalid,
            reasonCode: "draw_commitment_mismatch",
          }
        );
        assertPolicyError(
          () =>
            evaluateFreeAgentDraftAuctionResolution(
              resolutionInput({
                participants: [],
              })
            ),
          {
            code:
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .participantInvalid,
            reasonCode:
              "restricted_participant_count_invalid",
          }
        );
        assertPolicyError(
          () =>
            evaluateFreeAgentDraftAuctionResolution(
              resolutionInput({
                auction: { playerOwned: true },
              })
            ),
          {
            code:
              FREE_AGENT_DRAFT_AUCTION_RESOLUTION_CODES
                .auctionInvalid,
            reasonCode: "player_already_owned",
          }
        );
      }
    );

    test(
      "accepts the atomically claimed resolving state while rejecting terminal auction states",
      () => {
        const claimed =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "fallback",
              auction: { status: "resolving" },
            })
          );
        assert.equal(claimed.outcome, "no_winner");

        const terminal =
          evaluateFreeAgentDraftAuctionResolution(
            resolutionInput({
              kind: "fallback",
              auction: { status: "failed" },
            })
          );
        assert.deepEqual(terminal, {
          auctionId: IDS.auction,
          leagueId: IDS.league,
          allocationId: IDS.allocation,
          auctionType: "fad_open_rapid",
          dueAtMs: ROLLOVER_AT_MS,
          outcome: "not_due",
          reason: "auction_not_open",
        });
      }
    );

    test(
      "leaves the ordinary timestamp and stable-ID tie policy behavior unchanged",
      () => {
        const ordinary = evaluateAuctionResolution({
          auction: {
            id: IDS.auction,
            leagueId: IDS.league,
            playerId: IDS.player,
            status: "open",
            resolvesAtMs: ROLLOVER_AT_MS,
            playoffsStartAtMs: null,
            playerOwned: false,
            nowMs: ROLLOVER_AT_MS,
          },
          bids: [
            {
              ...bid({
                id: IDS.bid1,
                teamId: IDS.team1,
                firstSubmittedAtMs:
                  ROLLOVER_AT_MS - 1_000,
                isStartingBid: true,
              }),
            },
            {
              ...bid({
                id: IDS.bid2,
                teamId: IDS.team2,
                firstSubmittedAtMs:
                  ROLLOVER_AT_MS - 10_000,
                isStartingBid: true,
              }),
            },
          ].map(
            ({
              teamStatus,
              authorityValid,
              isStartingBid,
              ...value
            }) => ({
              ...value,
              teamStatus,
              authorityValid,
              isStartingBid,
            })
          ),
        });

        assert.equal(ordinary.outcome, "winner");
        assert.equal(ordinary.winner.bidId, IDS.bid2);
      }
    );
  }
);

for (const kind of ['direct', 'queued', 'fallback', 'restricted']) {
  test('equal AAV prefers longer term with AAV anti-bluff pricing: ' + kind, () => {
    const floor = contract(100, 1);
    const bids = [bid({totalValueCents: 600, termYears: 3, lowestOfferedAavCents: 200}), bid({id: IDS.bid2, teamId: IDS.team2, totalValueCents: 400, termYears: 2, lowestOfferedAavCents: 200})];
    const participants = kind === 'restricted' ? [participant({floor, activeImprovementBidId: IDS.bid1}), participant({id: IDS.participant2, teamId: IDS.team2, floor, activeImprovementBidId: IDS.bid2})] : [];
    const result = evaluateFreeAgentDraftAuctionResolution(resolutionInput({kind, floor, bids, participants}));
    assert.equal(result.winner.bidId, IDS.bid1);
    assert.equal(result.winner.finalAavCents, 200);
    assert.equal(result.winner.submittedTermYears, 3);
    assert.equal(result.drawReveal.selectionUsed, false);
  });
}

for (const kind of ["direct", "queued", "fallback", "restricted"]) {
  test("earliest original bid wins an exact tie regardless of draw nonce: " + kind, () => {
    const floor = contract(100, 1);
    const later = bid({ firstSubmittedAtMs: ROLLOVER_AT_MS - 1_000 });
    const earlier = bid({ id: IDS.bid2, teamId: IDS.team2, firstSubmittedAtMs: ROLLOVER_AT_MS - 10_000 });
    const participants = kind === "restricted" ? [
      participant({ floor, activeImprovementBidId: IDS.bid1 }),
      participant({ id: IDS.participant2, teamId: IDS.team2, floor, activeImprovementBidId: IDS.bid2 }),
    ] : [];
    for (const value of [0, 127, 255]) {
      const nonceBytes = new Uint8Array(32).fill(value);
      const draw = { ...createFreeAgentDraftAuctionDrawCommitment({ auctionId: IDS.auction, nonceBytes }), nonceBytes };
      const input = resolutionInput({ kind, floor, bids: [later, earlier], participants, draw });
      const result = evaluateFreeAgentDraftAuctionResolution(input);
      assert.equal(result.winner.bidId, IDS.bid2);
      assert.equal(result.winner.highestCompetingAavCents, 300);
      assert.equal(result.drawReveal.selectionUsed, false);
      assert.deepEqual(evaluateFreeAgentDraftAuctionResolution({ ...input, bids: [earlier, later] }), result);
      // Equal recorded timestamps use the existing stable-ID fallback.
      const sameTime = { ...earlier, firstSubmittedAtMs: later.firstSubmittedAtMs };
      assert.equal(evaluateFreeAgentDraftAuctionResolution({ ...input, bids: [sameTime, later] }).winner.bidId, IDS.bid1);
    }
  });
}

for (const kind of ["ordinary", "direct", "queued", "fallback"]) {
  const cases = [
    { name: "Marner does not inherit a competitor price", current: [1400,2], prior:[1200,2], rival:[1275,3], expected:[1400,2] },
    { name: "valid lower offer keeps its term even when its total is higher", current:[1000,1], prior:[800,3], rival:[750,3], expected:[800,3] },
    { name: "lower offer with shorter term loses an AAV tie", current:[1000,2], prior:[800,1], rival:[800,3], expected:[1000,2] },
    { name: "original timestamp breaks an exact historical tie", current:[1000,2], prior:[800,3], rival:[800,3], expected:[800,3] },
    { name: "earlier rival defeats identical historical offer", current:[1000,2], prior:[800,3], rival:[800,3], rivalEarlier:true, expected:[1000,2] },
    { name: "sole bidder pays its lower actual offer", current:[1000,2], prior:[800,1], expected:[800,1] },
    { name: "lowest accumulator alone cannot establish a real offer", current:[1000,2], rival:[750,3], expected:[1000,2] },
    { name: "future history cannot reduce the price", current:[1000,2], prior:[800,3], future:true, rival:[750,3], expected:[1000,2] },
  ];
  for (const scenario of cases) test(kind + ": " + scenario.name, () => {
    const [price,term] = scenario.current;
    const winner = bid({totalValueCents:price*term,termYears:term,lowestOfferedAavCents:300,lowestOfferedTotalValueCents:300*term});
    const bids=[winner];
    if(scenario.rival) bids.push(bid({id:IDS.bid2,teamId:IDS.team2,totalValueCents:scenario.rival[0]*scenario.rival[1],termYears:scenario.rival[1],firstSubmittedAtMs:winner.firstSubmittedAtMs+(scenario.rivalEarlier?-100:100)}));
    const bidHistory=scenario.prior?[{bidId:winner.id,teamId:winner.teamId,totalValueCents:scenario.prior[0]*scenario.prior[1],termYears:scenario.prior[1],occurredAtMs:scenario.future?ROLLOVER_AT_MS+1:winner.firstSubmittedAtMs}]:[];
    const input=resolutionInput({kind:kind==='ordinary'?'direct':kind,bids});
    const result=kind==='ordinary'?evaluateAuctionResolution({auction:{...input.auction,playoffsStartAtMs:ROLLOVER_AT_MS+1000},bids,bidHistory}):evaluateFreeAgentDraftAuctionResolution({...input,bidHistory});
    assert.equal(result.winner.finalAavCents,scenario.expected[0]);
    assert.equal(result.winner.finalTermYears,scenario.expected[1]);
    assert.equal(result.winner.finalTotalValueCents,scenario.expected[0]*scenario.expected[1]);
  });
}

for (const scenario of [{prior:[400,3],expected:[400,3]}, {prior:[300,2],expected:[800,1]}]) {
  test("restricted pricing keeps an actual offer only when it improves the original floor: " + scenario.prior, () => {
    const floor=contract(600,2);
    const winner=bid({totalValueCents:800,termYears:1,lowestOfferedAavCents:300});
    const input=resolutionInput({floor,bids:[winner],participants:[participant({floor,activeImprovementBidId:winner.id}),participant({floor,id:IDS.participant2,teamId:IDS.team2})]});
    input.bidHistory=[{bidId:winner.id,teamId:winner.teamId,totalValueCents:scenario.prior[0]*scenario.prior[1],termYears:scenario.prior[1],occurredAtMs:winner.firstSubmittedAtMs}];
    const result=evaluateFreeAgentDraftAuctionResolution(input);
    assert.equal(result.winner.finalAavCents,scenario.expected[0]);
    assert.equal(result.winner.finalTermYears,scenario.expected[1]);
  });
}
