const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  CANDIDATE_ALLOCATION_CODES,
  CandidateAllocationPolicyError,
  FAD_BINDING_NO_RESERVATION_POLICY,
  createRestrictedCandidateMinimum,
  decideCandidateAllocation,
  evaluateFallbackFloorBid,
  evaluateRestrictedCandidateImprovement,
  getFadBindingNoReservationPolicy,
} = require(
  "../../src/domain/freeAgentDraft/candidateAllocationPolicy"
);

const PLAYER_1 =
  "00000000-0000-4000-8000-000000000001";
const PLAYER_2 =
  "00000000-0000-4000-8000-000000000002";
const TEAM_1 =
  "10000000-0000-4000-8000-000000000001";
const TEAM_2 =
  "10000000-0000-4000-8000-000000000002";
const TEAM_3 =
  "10000000-0000-4000-8000-000000000003";
const TEAM_4 =
  "10000000-0000-4000-8000-000000000004";
const SNAPSHOT_1 =
  "20000000-0000-4000-8000-000000000001";
const SNAPSHOT_2 =
  "20000000-0000-4000-8000-000000000002";
const SNAPSHOT_3 =
  "20000000-0000-4000-8000-000000000003";
const SNAPSHOT_4 =
  "20000000-0000-4000-8000-000000000004";
const OFFER_1 =
  "30000000-0000-4000-8000-000000000001";
const OFFER_2 =
  "30000000-0000-4000-8000-000000000002";
const OFFER_3 =
  "30000000-0000-4000-8000-000000000003";
const OFFER_4 =
  "30000000-0000-4000-8000-000000000004";

function roundedAav(totalValueCents, termYears) {
  const whole = Math.floor(
    totalValueCents / termYears
  );
  const remainder = totalValueCents % termYears;
  return whole + (
    remainder * 2 >= termYears ? 1 : 0
  );
}

function offer({
  offerId = OFFER_1,
  cardSnapshotId = SNAPSHOT_1,
  teamId = TEAM_1,
  playerId = PLAYER_1,
  rowKind = "slot",
  totalValueCents = 600,
  termYears = 2,
  aavCents = roundedAav(
    totalValueCents,
    termYears
  ),
  eligibilityStatus = "valid",
  cardAllocationEligibility = "eligible",
  cardCompletenessCode = "complete",
} = {}) {
  return {
    offerId,
    cardSnapshotId,
    teamId,
    playerId,
    rowKind,
    totalValueCents,
    termYears,
    aavCents,
    eligibilityStatus,
    cardAllocationEligibility,
    cardCompletenessCode,
  };
}

function contract(
  totalValueCents,
  termYears
) {
  return {
    totalValueCents,
    termYears,
    aavCents: roundedAav(
      totalValueCents,
      termYears
    ),
  };
}

function assertPolicyError(
  callback,
  { code, reasonCode }
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        CandidateAllocationPolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe(
  "Candidate allocation policy foundation",
  () => {
    test(
      "awards a sole valid immutable snapshot offer deterministically",
      () => {
        const input = {
          playerId: PLAYER_1,
          offers: [
            offer({
              cardCompletenessCode: "incomplete",
            }),
          ],
        };
        const decision =
          decideCandidateAllocation(input);

        assert.equal(
          decision.outcome,
          "automatic_award"
        );
        assert.equal(
          decision.decisionCode,
          "sole_valid_offer"
        );
        assert.equal(
          decision.winner.offerId,
          OFFER_1
        );
        assert.equal(
          decision.winner.cardCompletenessCode,
          "incomplete"
        );
        assert.equal(
          decision.eligibleOfferCount,
          1
        );
        assert.equal(
          decision.excludedOfferCount,
          0
        );
        assert.ok(Object.isFrozen(decision));
        assert.ok(
          Object.isFrozen(decision.winner)
        );
        assert.ok(
          Object.isFrozen(decision.eligibleOffers)
        );
        assert.deepEqual(
          decideCandidateAllocation({
            ...input,
            offers: [...input.offers].reverse(),
          }),
          decision
        );
      }
    );

    test(
      "ranks total first even when the lower total has the higher AAV",
      () => {
        const decision =
          decideCandidateAllocation({
            playerId: PLAYER_1,
            offers: [
              offer({
                offerId: OFFER_2,
                cardSnapshotId: SNAPSHOT_2,
                teamId: TEAM_2,
                totalValueCents: 700,
                termYears: 1,
              }),
              offer({
                totalValueCents: 800,
                termYears: 2,
              }),
            ],
          });

        assert.equal(
          decision.decisionCode,
          "highest_total"
        );
        assert.equal(
          decision.winner.offerId,
          OFFER_1
        );
        assert.equal(
          decision.winner.totalValueCents,
          800
        );
        assert.equal(
          decision.winner.aavCents,
          400
        );
        assert.equal(
          decision.eligibleOffers[1].aavCents,
          700
        );
      }
    );

    test(
      "uses higher AAV at equal total and ties only equal total with equal term",
      () => {
        const aavWinner =
          decideCandidateAllocation({
            playerId: PLAYER_1,
            offers: [
              offer({
                offerId: OFFER_2,
                cardSnapshotId: SNAPSHOT_2,
                teamId: TEAM_2,
                totalValueCents: 600,
                termYears: 3,
              }),
              offer({
                totalValueCents: 600,
                termYears: 2,
              }),
            ],
          });
        assert.equal(
          aavWinner.decisionCode,
          "highest_equal_total_aav"
        );
        assert.equal(
          aavWinner.winner.offerId,
          OFFER_1
        );

        const tie = decideCandidateAllocation({
          playerId: PLAYER_1,
          offers: [
            offer({
              offerId: OFFER_4,
              cardSnapshotId: SNAPSHOT_4,
              teamId: TEAM_4,
              totalValueCents: 600,
              termYears: 3,
            }),
            offer({
              offerId: OFFER_2,
              cardSnapshotId: SNAPSHOT_2,
              teamId: TEAM_2,
            }),
            offer({
              offerId: OFFER_3,
              cardSnapshotId: SNAPSHOT_3,
              teamId: TEAM_3,
              totalValueCents: 590,
              termYears: 1,
            }),
            offer(),
          ],
        });

        assert.equal(
          tie.outcome,
          "restricted_auction"
        );
        assert.equal(
          tie.decisionCode,
          "exact_total_and_term_tie"
        );
        assert.equal(
          tie.restrictedTie.participantCount,
          2
        );
        assert.deepEqual(
          tie.restrictedTie.participants.map(
            (participant) =>
              participant.teamId
          ),
          [TEAM_1, TEAM_2]
        );
        assert.deepEqual(
          tie.restrictedTie.floor,
          contract(600, 2)
        );
        assert.ok(
          tie.restrictedTie.participants.every(
            (participant) =>
              participant.isActiveBid ===
                false &&
              participant.isLeader === false &&
              participant.managerEditCount ===
                0 &&
              participant.cooldownAnchorAtMs ===
                null &&
              participant
                .canWinWithoutStrictImprovement ===
                false
          )
        );
        assert.ok(
          Object.isFrozen(
            tie.restrictedTie.participants
          )
        );

        const replay =
          decideCandidateAllocation({
            playerId: PLAYER_1,
            offers: [
              offer(),
              offer({
                offerId: OFFER_3,
                cardSnapshotId: SNAPSHOT_3,
                teamId: TEAM_3,
                totalValueCents: 590,
                termYears: 1,
              }),
              offer({
                offerId: OFFER_2,
                cardSnapshotId: SNAPSHOT_2,
                teamId: TEAM_2,
              }),
              offer({
                offerId: OFFER_4,
                cardSnapshotId: SNAPSHOT_4,
                teamId: TEAM_4,
                totalValueCents: 600,
                termYears: 3,
              }),
            ],
          });
        assert.deepEqual(replay, tie);
      }
    );

    test(
      "excludes every structurally conflicted or over-cap offer while admitting valid offers from conflict-free incomplete cap-compliant cards",
      () => {
        for (
          const [
            playerId,
            offerId,
            cardAllocationEligibility,
            cardCompletenessCode,
            reasonCode,
          ] of [
            [
              PLAYER_1,
              OFFER_1,
              "excluded_structural_conflict",
              "conflicted",
              "candidate_card_structural_conflict",
            ],
            [
              PLAYER_2,
              OFFER_2,
              "excluded_over_cap",
              "incomplete",
              "candidate_card_over_cap",
            ],
          ]
        ) {
          const excluded =
            decideCandidateAllocation({
              playerId,
              offers: [
                offer({
                  offerId,
                  playerId,
                  cardAllocationEligibility:
                    cardAllocationEligibility,
                  cardCompletenessCode:
                    cardCompletenessCode,
                }),
              ],
            });
          assert.equal(
            excluded.outcome,
            "no_valid_offer"
          );
          assert.deepEqual(
            excluded.excludedOffers,
            [
              {
                offerId,
                teamId: TEAM_1,
                reasonCode,
              },
            ]
          );
        }

        const incomplete =
          decideCandidateAllocation({
            playerId: PLAYER_1,
            offers: [
              offer({
                cardCompletenessCode:
                  "incomplete",
                eligibilityStatus: "warning",
              }),
              offer({
                offerId: OFFER_2,
                cardSnapshotId: SNAPSHOT_2,
                teamId: TEAM_2,
                eligibilityStatus: "invalid",
              }),
            ],
          });
        assert.equal(
          incomplete.outcome,
          "automatic_award"
        );
        assert.equal(
          incomplete.winner.offerId,
          OFFER_1
        );
        assert.equal(
          incomplete.excludedOffers[0]
            .reasonCode,
          "candidate_offer_invalid"
        );
      }
    );

    test(
      "excludes an individual Candidate conflict row even when its warning offer and card are otherwise eligible",
      () => {
        const decision =
          decideCandidateAllocation({
            playerId: PLAYER_1,
            offers: [
              offer({
                rowKind: "conflict",
                totalValueCents: 900,
                termYears: 1,
                eligibilityStatus: "warning",
                cardCompletenessCode:
                  "conflicted",
              }),
              offer({
                offerId: OFFER_2,
                cardSnapshotId: SNAPSHOT_2,
                teamId: TEAM_2,
                totalValueCents: 600,
                termYears: 2,
              }),
            ],
          });

        assert.equal(
          decision.outcome,
          "automatic_award"
        );
        assert.equal(
          decision.decisionCode,
          "sole_valid_offer"
        );
        assert.equal(
          decision.winner.offerId,
          OFFER_2
        );
        assert.deepEqual(
          decision.excludedOffers,
          [
            {
              offerId: OFFER_1,
              teamId: TEAM_1,
              reasonCode:
                "candidate_offer_invalid",
            },
          ]
        );
      }
    );

    test(
      "skips an invalid top offer, awards the next valid offer, and returns no winner when all are invalid",
      () => {
        const nextValid =
          decideCandidateAllocation({
            playerId: PLAYER_1,
            offers: [
              offer({
                totalValueCents: 900,
                termYears: 1,
                eligibilityStatus: "invalid",
              }),
              offer({
                offerId: OFFER_2,
                cardSnapshotId: SNAPSHOT_2,
                teamId: TEAM_2,
                totalValueCents: 600,
                termYears: 2,
              }),
            ],
          });
        assert.equal(
          nextValid.outcome,
          "automatic_award"
        );
        assert.equal(
          nextValid.decisionCode,
          "sole_valid_offer"
        );
        assert.equal(
          nextValid.winner.offerId,
          OFFER_2
        );

        const allInvalid =
          decideCandidateAllocation({
            playerId: PLAYER_1,
            offers: [
              offer({
                eligibilityStatus: "invalid",
              }),
              offer({
                offerId: OFFER_2,
                cardSnapshotId: SNAPSHOT_2,
                teamId: TEAM_2,
                cardAllocationEligibility:
                  "excluded_over_cap",
              }),
            ],
          });
        assert.equal(
          allInvalid.outcome,
          "no_valid_offer"
        );
        assert.equal(
          allInvalid.eligibleOfferCount,
          0
        );
        assert.equal(
          allInvalid.excludedOfferCount,
          2
        );
      }
    );

    test(
      "represents a below-joining-minimum Candidate floor without fabricating a bid or cooldown",
      () => {
        const minimum =
          createRestrictedCandidateMinimum({
            sourceSnapshotEntryId: OFFER_1,
            teamId: TEAM_1,
            ...contract(100, 1),
          });

        assert.deepEqual(minimum, {
          sourceSnapshotEntryId: OFFER_1,
          teamId: TEAM_1,
          minimumTotalValueCents: 100,
          minimumTermYears: 1,
          minimumAavCents: 100,
          isActiveBid: false,
          isLeader: false,
          managerEditCount: 0,
          cooldownAnchorAtMs: null,
          canWinWithoutStrictImprovement: false,
        });
        assert.ok(Object.isFrozen(minimum));
      }
    );

    test(
      "requires both a total-first AAV-second strict improvement and the ordinary joining minimum",
      () => {
        const candidateMinimum =
          contract(100, 1);
        const belowJoining =
          evaluateRestrictedCandidateImprovement(
            {
              candidateMinimum,
              submittedBid: contract(125, 1),
            }
          );
        assert.equal(
          belowJoining.isStrictImprovement,
          true
        );
        assert.equal(
          belowJoining
            .meetsOrdinaryJoiningMinimum,
          false
        );
        assert.equal(
          belowJoining.eligible,
          false
        );
        assert.deepEqual(
          belowJoining.reasonCodes,
          [
            "ordinary_joining_minimum_not_met",
          ]
        );

        assert.equal(
          evaluateRestrictedCandidateImprovement(
            {
              candidateMinimum,
              submittedBid: contract(150, 1),
            }
          ).eligible,
          true
        );

        const crossTermMinimum =
          contract(600, 2);
        const lowerAav =
          evaluateRestrictedCandidateImprovement(
            {
              candidateMinimum:
                crossTermMinimum,
              submittedBid: contract(600, 3),
            }
          );
        assert.equal(lowerAav.comparison, -1);
        assert.equal(lowerAav.eligible, false);
        assert.deepEqual(lowerAav.reasonCodes, [
          "restricted_candidate_minimum_not_improved",
        ]);

        const equalTotalHigherAav =
          evaluateRestrictedCandidateImprovement(
            {
              candidateMinimum:
                contract(600, 3),
              submittedBid: contract(600, 2),
            }
          );
        assert.equal(
          equalTotalHigherAav.comparison,
          1
        );
        assert.equal(
          equalTotalHigherAav.eligible,
          true
        );

        const higherTotal =
          evaluateRestrictedCandidateImprovement(
            {
              candidateMinimum:
                crossTermMinimum,
              submittedBid: contract(700, 3),
            }
          );
        assert.equal(higherTotal.comparison, 1);
        assert.equal(higherTotal.eligible, true);
        assert.ok(Object.isFrozen(higherTotal));
        assert.ok(
          Object.isFrozen(higherTotal.reasonCodes)
        );
      }
    );

    test(
      "accepts an equal fallback floor and rejects same-total lower AAV across terms",
      () => {
        const belowJoiningFloor =
          contract(100, 1);
        const equal =
          evaluateFallbackFloorBid({
            floor: belowJoiningFloor,
            submittedBid: contract(100, 1),
          });
        assert.equal(equal.comparison, 0);
        assert.equal(equal.eligible, true);

        const floor = contract(600, 2);
        const lowerAav =
          evaluateFallbackFloorBid({
            floor,
            submittedBid: contract(600, 3),
          });
        assert.equal(lowerAav.comparison, -1);
        assert.equal(lowerAav.eligible, false);
        assert.deepEqual(lowerAav.reasonCodes, [
          "fallback_floor_not_met",
        ]);

        const higherTotal =
          evaluateFallbackFloorBid({
            floor,
            submittedBid: contract(700, 3),
          });
        assert.equal(higherTotal.comparison, 1);
        assert.equal(higherTotal.eligible, true);
      }
    );

    test(
      "returns the immutable binding no-reservation FAD win policy",
      () => {
        const policy =
          getFadBindingNoReservationPolicy();
        assert.strictEqual(
          policy,
          FAD_BINDING_NO_RESERVATION_POLICY
        );
        assert.deepEqual(policy, {
          submissionIsBinding: true,
          confirmsPossibleAggregateIllegality:
            true,
          reservations: {
            salaryCap: false,
            rosterCapacity: false,
            positionCapacity: false,
            playerOwnership: false,
            otherAuctionCapacity: false,
          },
          validWinsCommitIndependently: true,
          aggregateIllegalityInvalidatesWin:
            false,
          resolverRequiresSecondConfirmation:
            false,
        });
        assert.ok(Object.isFrozen(policy));
        assert.ok(
          Object.isFrozen(policy.reservations)
        );
      }
    );

    test(
      "rejects ambiguous or malformed snapshot and floor evidence with stable errors",
      () => {
        const invalidCases = [
          [
            () =>
              decideCandidateAllocation({
                playerId: PLAYER_1,
                offers: [
                  offer({
                    aavCents: 301,
                  }),
                ],
              }),
            {
              code:
                CANDIDATE_ALLOCATION_CODES
                  .offerInvalid,
              reasonCode: "offer_aav_mismatch",
            },
          ],
          [
            () =>
              decideCandidateAllocation({
                playerId: PLAYER_1,
                offers: [
                  offer(),
                  offer({
                    offerId: OFFER_2,
                    cardSnapshotId: SNAPSHOT_2,
                  }),
                ],
              }),
            {
              code:
                CANDIDATE_ALLOCATION_CODES
                  .offerInvalid,
              reasonCode: "offer_team_duplicate",
            },
          ],
          [
            () =>
              decideCandidateAllocation({
                playerId: PLAYER_1,
                offers: [
                  offer({
                    playerId: PLAYER_2,
                  }),
                ],
              }),
            {
              code:
                CANDIDATE_ALLOCATION_CODES
                  .offerInvalid,
              reasonCode:
                "offer_player_scope_invalid",
            },
          ],
          [
            () =>
              decideCandidateAllocation({
                playerId: PLAYER_1,
                offers: [
                  offer({
                    rowKind: "unknown",
                  }),
                ],
              }),
            {
              code:
                CANDIDATE_ALLOCATION_CODES
                  .offerInvalid,
              reasonCode:
                "offer_row_kind_invalid",
            },
          ],
          [
            () =>
              evaluateFallbackFloorBid({
                floor: {
                  ...contract(600, 2),
                  unknown: true,
                },
                submittedBid: contract(600, 2),
              }),
            {
              code:
                CANDIDATE_ALLOCATION_CODES
                  .floorInvalid,
              reasonCode: "floor_fields_invalid",
            },
          ],
        ];

        for (
          const [callback, expected] of
          invalidCases
        ) {
          assertPolicyError(callback, expected);
        }
      }
    );
  }
);
