const assert = require("node:assert/strict");
const {
  readFileSync,
} = require("node:fs");
const path = require("node:path");
const {
  describe,
  test,
} = require("node:test");

const {
  CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS,
  CANDIDATE_CARD_POLICY_CODES,
  CANDIDATE_CARD_SLOT_KEYS,
  CandidateCardPolicyError,
  calculateCandidateCardAavCents,
  createCandidateCardOfferContract,
  createCandidateCardSlotStructure,
  evaluateCandidateCard,
  evaluateCandidateCardHelpAuthority,
  parseCandidateCardSlotKey,
  planCandidateCardCarryoverAction,
  validateCandidateCardContract,
  validateCandidateCardCarryover,
} = require("../../src/domain/freeAgentDraft/candidateCardPolicy");

function uuid(number) {
  return (
    "00000000-0000-4000-8000-" +
    String(number).padStart(12, "0")
  );
}

function candidate({
  entryNumber,
  playerNumber = entryNumber + 100,
  slotKey,
  position = slotKey.startsWith("D")
    ? "D"
    : "F",
  totalValueCents = 100,
  termYears = 1,
  eligibilityStatus = "valid",
  validationCode = null,
  placementState = "placed",
  conflictCode = null,
} = {}) {
  return {
    entryId: uuid(entryNumber),
    entryKind: "candidate",
    playerId: uuid(playerNumber),
    effectivePositionGroup: position,
    slotKey,
    placementState,
    conflictCode,
    totalValueCents,
    termYears,
    eligibilityStatus,
    validationCode,
  };
}

function carryover({
  entryNumber,
  playerNumber = entryNumber + 200,
  ownershipNumber = entryNumber + 300,
  contractNumber = entryNumber + 400,
  position = "F",
  slotKey = "F01",
  sourceRosterCategory = "Active",
  contractType = "normal",
  originalTotalValueCents = 600,
  originalTermYears = 2,
  aavCents = 300,
  remainingYears = 1,
  placementState = "placed",
  conflictCode = null,
} = {}) {
  return {
    entryId: uuid(entryNumber),
    entryKind: "carryover",
    playerId: uuid(playerNumber),
    ownershipId: uuid(ownershipNumber),
    contractId: uuid(contractNumber),
    effectivePositionGroup: position,
    slotKey,
    placementState,
    conflictCode,
    sourceRosterCategory,
    contractType,
    originalTotalValueCents,
    originalTermYears,
    aavCents,
    remainingYears,
  };
}

function cardInput(overrides = {}) {
  return {
    capLimitCents: 10_000,
    carriedActivePlayerAmountCents: 0,
    retentionObligationCents: 0,
    buyoutPenaltyCents: 0,
    entries: [],
    ...overrides,
  };
}

function assertPolicyError(
  callback,
  { code, reasonCode }
) {
  assert.throws(
    callback,
    (error) =>
      error instanceof
        CandidateCardPolicyError &&
      error.code === code &&
      error.reasonCode === reasonCode
  );
}

describe(
  "Candidate Card canonical slot policy",
  () => {
    test(
      "returns exactly 12 F, 6 D, and 4 optional Bench slots in canonical order",
      () => {
        const slots =
          createCandidateCardSlotStructure();
        assert.equal(slots.length, 22);
        assert.deepEqual(
          CANDIDATE_CARD_SLOT_KEYS,
          [
            "F01",
            "F02",
            "F03",
            "F04",
            "F05",
            "F06",
            "F07",
            "F08",
            "F09",
            "F10",
            "F11",
            "F12",
            "D01",
            "D02",
            "D03",
            "D04",
            "D05",
            "D06",
            "B01",
            "B02",
            "B03",
            "B04",
          ]
        );
        assert.equal(
          slots.filter(
            (slot) =>
              slot.slotGroup === "F" &&
              slot.mandatory
          ).length,
          12
        );
        assert.equal(
          slots.filter(
            (slot) =>
              slot.slotGroup === "D" &&
              slot.mandatory
          ).length,
          6
        );
        assert.equal(
          slots.filter(
            (slot) =>
              slot.slotGroup === "B" &&
              !slot.mandatory
          ).length,
          4
        );
        assert.equal(Object.isFrozen(slots), true);
        assert.equal(
          slots.every(Object.isFrozen),
          true
        );
      }
    );

    test(
      "parses only canonical allowlisted slot keys",
      () => {
        assert.deepEqual(
          parseCandidateCardSlotKey("F12"),
          {
            slotKey: "F12",
            slotGroup: "F",
            slotNumber: 12,
            mandatory: true,
          }
        );
        assert.deepEqual(
          parseCandidateCardSlotKey("B04"),
          {
            slotKey: "B04",
            slotGroup: "B",
            slotNumber: 4,
            mandatory: false,
          }
        );
        for (const slotKey of [
          "F00",
          "F13",
          "D07",
          "B05",
          "F1",
          "f01",
          "IR01",
          "G01",
          "",
          null,
        ]) {
          assertPolicyError(
            () =>
              parseCandidateCardSlotKey(
                slotKey
              ),
            {
              code:
                CANDIDATE_CARD_POLICY_CODES
                  .slotInvalid,
              reasonCode: "slot_key_invalid",
            }
          );
        }
      }
    );
  }
);

describe(
  "Candidate Card contract policy",
  () => {
    test(
      "derives rounded integer-cent AAV without floating-point money authority",
      () => {
        assert.equal(
          calculateCandidateCardAavCents(
            425,
            1
          ),
          425
        );
        assert.equal(
          calculateCandidateCardAavCents(
            900,
            2
          ),
          450
        );
        assert.equal(
          calculateCandidateCardAavCents(
            1_000,
            3
          ),
          333
        );
        assert.equal(
          calculateCandidateCardAavCents(
            1_100,
            3
          ),
          367
        );
      }
    );

    test(
      "accepts exact normal one-, two-, and three-year minimums and precision",
      () => {
        assert.deepEqual(
          createCandidateCardOfferContract({
            totalValueCents: 100,
            termYears: 1,
          }),
          {
            contractType: "normal",
            totalValueCents: 100,
            termYears: 1,
            aavCents: 100,
          }
        );
        assert.deepEqual(
          createCandidateCardOfferContract({
            totalValueCents: 200,
            termYears: 2,
          }),
          {
            contractType: "normal",
            totalValueCents: 200,
            termYears: 2,
            aavCents: 100,
          }
        );
        assert.deepEqual(
          createCandidateCardOfferContract({
            totalValueCents: 300,
            termYears: 3,
          }),
          {
            contractType: "normal",
            totalValueCents: 300,
            termYears: 3,
            aavCents: 100,
          }
        );
        assert.deepEqual(
          createCandidateCardOfferContract({
            totalValueCents: 425,
            termYears: 1,
          }),
          {
            contractType: "normal",
            totalValueCents: 425,
            termYears: 1,
            aavCents: 425,
          }
        );
      }
    );

    test(
      "rejects below-minimum, non-whole multi-year, mismatched-AAV, and invalid-term contracts with stable errors",
      () => {
        const cases = [
          {
            callback: () =>
              createCandidateCardOfferContract({
                totalValueCents: 99,
                termYears: 1,
              }),
            reasonCode: "minimum_aav_not_met",
          },
          {
            callback: () =>
              createCandidateCardOfferContract({
                totalValueCents: 199,
                termYears: 2,
              }),
            reasonCode: "minimum_aav_not_met",
          },
          {
            callback: () =>
              createCandidateCardOfferContract({
                totalValueCents: 250,
                termYears: 2,
              }),
            reasonCode:
              "multi_year_total_precision_invalid",
          },
          {
            callback: () =>
              validateCandidateCardContract({
                contractType: "normal",
                originalTotalValueCents:
                  1_000,
                originalTermYears: 3,
                aavCents: 334,
              }),
            reasonCode: "aav_cents_mismatch",
          },
          {
            callback: () =>
              createCandidateCardOfferContract({
                totalValueCents: 400,
                termYears: 4,
              }),
            reasonCode: "term_years_invalid",
          },
        ];
        for (const fixture of cases) {
          assertPolicyError(
            fixture.callback,
            {
              code:
                CANDIDATE_CARD_POLICY_CODES
                  .contractInvalid,
              reasonCode:
                fixture.reasonCode,
            }
          );
        }
      }
    );

    test(
      "accepts only the approved exact fantasy ELC",
      () => {
        const valid =
          validateCandidateCardContract({
            contractType: "fantasy_elc",
            originalTotalValueCents: 300,
            originalTermYears: 3,
            aavCents: 100,
          });
        assert.deepEqual(valid, {
          contractType: "fantasy_elc",
          originalTotalValueCents: 300,
          originalTermYears: 3,
          aavCents: 100,
        });
        assert.equal(Object.isFrozen(valid), true);

        assertPolicyError(
          () =>
            validateCandidateCardContract({
              contractType: "fantasy_elc",
              originalTotalValueCents: 300,
              originalTermYears: 3,
              aavCents: 101,
            }),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .contractInvalid,
            reasonCode:
              "fantasy_elc_terms_invalid",
          }
        );
      }
    );
  }
);

describe(
  "Candidate Card carryover policy",
  () => {
    test(
      "accepts normal and fantasy-ELC Active, Bench, and Injured Reserve carryovers",
      () => {
        const fixtures = [
          {
            sourceRosterCategory:
              "Active",
            slotKey: "F03",
            position: "F",
          },
          {
            sourceRosterCategory:
              "Bench",
            slotKey: "B02",
            position: "F",
          },
          {
            sourceRosterCategory:
              "Injured Reserve",
            slotKey: "D05",
            position: "D",
          },
        ];
        const validated = [];
        let entryNumber = 1;
        for (const contractType of [
          "normal",
          "fantasy_elc",
        ]) {
          for (const fixture of fixtures) {
            validated.push(
              validateCandidateCardCarryover(
                carryover({
                  entryNumber,
                  ...fixture,
                  contractType,
                  originalTotalValueCents:
                    contractType ===
                    "fantasy_elc"
                      ? 300
                      : 600,
                  originalTermYears:
                    contractType ===
                    "fantasy_elc"
                      ? 3
                      : 2,
                  aavCents:
                    contractType ===
                    "fantasy_elc"
                      ? 100
                      : 300,
                  remainingYears: 1,
                })
              )
            );
            entryNumber += 1;
          }
        }
        assert.deepEqual(
          validated.map((entry) => [
            entry.contractType,
            entry.sourceRosterCategory,
          ]),
          [
            ["normal", "Active"],
            ["normal", "Bench"],
            [
              "normal",
              "Injured Reserve",
            ],
            ["fantasy_elc", "Active"],
            ["fantasy_elc", "Bench"],
            [
              "fantasy_elc",
              "Injured Reserve",
            ],
          ]
        );
        assert.equal(
          validated.every(Object.isFrozen),
          true
        );
      }
    );

    test(
      "moves eligible carryovers between compatible Active and position-neutral Bench slots without changing identity or contract",
      () => {
        const activeCarryover = carryover({
          entryNumber: 10,
          slotKey: "F01",
          sourceRosterCategory: "Active",
          originalTotalValueCents: 800,
          originalTermYears: 2,
          aavCents: 400,
          remainingYears: 2,
        });
        const toBench =
          planCandidateCardCarryoverAction({
            action: "move",
            carryover: activeCarryover,
            targetSlotKey: "B04",
          });
        assert.deepEqual(toBench, {
          action: "move",
          entryId:
            activeCarryover.entryId,
          playerId:
            activeCarryover.playerId,
          ownershipId:
            activeCarryover.ownershipId,
          contractId:
            activeCarryover.contractId,
          contractType: "normal",
          originalTotalValueCents: 800,
          originalTermYears: 2,
          aavCents: 400,
          remainingYears: 2,
          currentSlotKey: "F01",
          targetSlotKey: "B04",
          targetRosterCategory: "Bench",
        });

        const benchCarryover = carryover({
          entryNumber: 11,
          position: "D",
          slotKey: "B01",
          sourceRosterCategory: "Bench",
        });
        const toActive =
          planCandidateCardCarryoverAction({
            action: "move",
            carryover: benchCarryover,
            targetSlotKey: "D06",
          });
        assert.equal(
          toActive.targetRosterCategory,
          "Active"
        );
        assert.equal(
          toActive.targetSlotKey,
          "D06"
        );
        assert.equal(Object.isFrozen(toActive), true);
      }
    );

    test(
      "keeps carryover removal, replacement, recontracting, and direct IR movement locked",
      () => {
        const activeCarryover = carryover({
          entryNumber: 20,
        });
        for (const action of [
          "remove",
          "replace_player",
          "edit_contract",
        ]) {
          assertPolicyError(
            () =>
              planCandidateCardCarryoverAction({
                action,
                carryover: activeCarryover,
                targetSlotKey: null,
              }),
            {
              code:
                CANDIDATE_CARD_POLICY_CODES
                  .carryoverLocked,
              reasonCode:
                `carryover_${action}_not_permitted`,
            }
          );
        }

        assertPolicyError(
          () =>
            planCandidateCardCarryoverAction({
              action: "move",
              carryover: carryover({
                entryNumber: 21,
                sourceRosterCategory:
                  "Injured Reserve",
              }),
              targetSlotKey: "B01",
            }),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .carryoverLocked,
            reasonCode:
              "injured_reserve_requires_roster_move",
          }
        );
      }
    );

    test(
      "enforces the exact $4 Bench AAV limit on carried movement",
      () => {
        assert.equal(
          CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS,
          400
        );
        const atLimit =
          planCandidateCardCarryoverAction({
            action: "move",
            carryover: carryover({
              entryNumber: 30,
              originalTotalValueCents: 800,
              originalTermYears: 2,
              aavCents: 400,
            }),
            targetSlotKey: "B01",
          });
        assert.equal(
          atLimit.targetSlotKey,
          "B01"
        );

        assertPolicyError(
          () =>
            planCandidateCardCarryoverAction({
              action: "move",
              carryover: carryover({
                entryNumber: 31,
                originalTotalValueCents:
                  802,
                originalTermYears: 1,
                aavCents: 802,
              }),
              targetSlotKey: "B01",
            }),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .benchAavExceeded,
            reasonCode: "bench_aav_exceeded",
          }
        );
      }
    );

    test(
      "preserves an over-limit Bench carryover only as an evidenced structural conflict",
      () => {
        const conflicted =
          validateCandidateCardCarryover(
            carryover({
              entryNumber: 32,
              slotKey: "B01",
              sourceRosterCategory: "Bench",
              originalTotalValueCents: 500,
              originalTermYears: 1,
              aavCents: 500,
              remainingYears: 1,
              placementState: "conflict",
              conflictCode:
                "CARRYOVER_SLOT_CONFLICT",
            })
          );
        assert.equal(
          conflicted.placementState,
          "conflict"
        );
        assert.equal(
          conflicted.conflictCode,
          "CARRYOVER_SLOT_CONFLICT"
        );
        assert.equal(conflicted.aavCents, 500);
        assert.equal(Object.isFrozen(conflicted), true);

        for (const conflictCode of [
          null,
          "carryover_slot_conflict",
        ]) {
          assertPolicyError(
            () =>
              validateCandidateCardCarryover(
                carryover({
                  entryNumber: 33,
                  slotKey: "B01",
                  sourceRosterCategory:
                    "Bench",
                  originalTotalValueCents:
                    500,
                  originalTermYears: 1,
                  aavCents: 500,
                  remainingYears: 1,
                  placementState: "conflict",
                  conflictCode,
                })
              ),
            {
              code:
                CANDIDATE_CARD_POLICY_CODES
                  .inputInvalid,
              reasonCode:
                "conflict_code_invalid",
            }
          );
        }
      }
    );

    test(
      "rejects an over-limit placed Bench carryover but does not apply the Bench limit to Active placement",
      () => {
        assertPolicyError(
          () =>
            validateCandidateCardCarryover(
              carryover({
                entryNumber: 34,
                slotKey: "B02",
                sourceRosterCategory: "Bench",
                originalTotalValueCents:
                  401,
                originalTermYears: 1,
                aavCents: 401,
                remainingYears: 1,
              })
            ),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .benchAavExceeded,
            reasonCode: "bench_aav_exceeded",
          }
        );

        const active =
          validateCandidateCardCarryover(
            carryover({
              entryNumber: 35,
              slotKey: "F02",
              sourceRosterCategory: "Active",
              originalTotalValueCents: 900,
              originalTermYears: 1,
              aavCents: 900,
              remainingYears: 1,
            })
          );
        assert.equal(active.slotGroup, "F");
        assert.equal(active.aavCents, 900);
        assert.equal(
          active.placementState,
          "placed"
        );
      }
    );

    test(
      "enforces the exact $4 Bench AAV limit on selectable candidates",
      () => {
        const atLimit =
          evaluateCandidateCard(
            cardInput({
              entries: [
                candidate({
                  entryNumber: 40,
                  slotKey: "B01",
                  totalValueCents: 400,
                }),
              ],
            })
          );
        assert.equal(
          atLimit.entries[0].aavCents,
          400
        );

        assertPolicyError(
          () =>
            evaluateCandidateCard(
              cardInput({
                entries: [
                  candidate({
                    entryNumber: 41,
                    slotKey: "B01",
                    totalValueCents: 401,
                  }),
                ],
              })
            ),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .benchAavExceeded,
            reasonCode: "bench_aav_exceeded",
          }
        );

        assertPolicyError(
          () =>
            evaluateCandidateCard(
              cardInput({
                entries: [
                  candidate({
                    entryNumber: 42,
                    slotKey: "B01",
                    totalValueCents: 401,
                    placementState:
                      "conflict",
                    conflictCode:
                      "CARRYOVER_SLOT_CONFLICT",
                  }),
                ],
              })
            ),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .benchAavExceeded,
            reasonCode: "bench_aav_exceeded",
          }
        );
      }
    );
  }
);

describe(
  "Candidate Card whole-card projection policy",
  () => {
    test(
      "projects the empty 22-slot card as incomplete without inventing a player or contract",
      () => {
        const result =
          evaluateCandidateCard(
            cardInput({
              capLimitCents: 10_000,
              retentionObligationCents:
                125,
              buyoutPenaltyCents: 75,
            })
          );
        assert.equal(result.slots.length, 22);
        assert.deepEqual(
          result.counts,
          {
            carryovers: 0,
            candidates: 0,
            emptyMandatory: 18,
            emptyBench: 4,
            conflicts: 0,
            carriedRosterConflicts: 0,
          }
        );
        assert.equal(
          result.completeness.code,
          "incomplete"
        );
        assert.equal(
          result.lockedStatus,
          "locked_incomplete"
        );
        assert.deepEqual(
          result.capProjection,
          {
            capLimitCents: 10_000,
            carriedActivePlayerAmountCents:
              0,
            retentionObligationCents: 125,
            buyoutPenaltyCents: 75,
            carriedCapUsageCents: 200,
            proposedCandidateAavCents: 0,
            maximumPossibleCapCents: 200,
            maximumCapSpaceCents: 9_800,
          }
        );
      }
    );

    test(
      "treats Bench candidates as cap-exempt and includes valid or warning Active offers in the strict projection",
      () => {
        const entries = [
          carryover({
            entryNumber: 100,
            slotKey: "F01",
            sourceRosterCategory: "Active",
          }),
          carryover({
            entryNumber: 101,
            position: "D",
            slotKey: "D01",
            sourceRosterCategory:
              "Injured Reserve",
          }),
          candidate({
            entryNumber: 102,
            slotKey: "F02",
            totalValueCents: 300,
            termYears: 1,
          }),
          candidate({
            entryNumber: 103,
            slotKey: "D02",
            position: "D",
            totalValueCents: 600,
            termYears: 2,
            eligibilityStatus: "warning",
            validationCode:
              "PLAYER_STATE_RECHECK_REQUIRED",
          }),
          candidate({
            entryNumber: 104,
            slotKey: "B01",
            totalValueCents: 400,
            termYears: 1,
          }),
          candidate({
            entryNumber: 105,
            slotKey: "F03",
            totalValueCents: 900,
            termYears: 1,
            eligibilityStatus: "invalid",
            validationCode:
              "PLAYER_NO_LONGER_ELIGIBLE",
          }),
        ];
        const result =
          evaluateCandidateCard(
            cardInput({
              capLimitCents: 2_000,
              carriedActivePlayerAmountCents:
                500,
              retentionObligationCents:
                100,
              buyoutPenaltyCents: 50,
              entries,
            })
          );

        assert.equal(
          result.capProjection
            .proposedCandidateAavCents,
          600
        );
        assert.equal(
          result.capProjection
            .maximumPossibleCapCents,
          1_250
        );
        assert.equal(
          result.capStatus,
          "compliant"
        );
        assert.equal(
          result.completeness
            .blockingValidationCount,
          1
        );
        assert.equal(
          result.candidateOfferDispositions.find(
            (entry) =>
              entry.entryId === uuid(104)
          ).participates,
          true
        );
      }
    );

    test(
      "lets every individually valid offer on an incomplete cap-compliant card participate",
      () => {
        const result =
          evaluateCandidateCard(
            cardInput({
              entries: [
                candidate({
                  entryNumber: 200,
                  slotKey: "F01",
                  totalValueCents: 600,
                  termYears: 2,
                }),
                candidate({
                  entryNumber: 201,
                  slotKey: "D01",
                  position: "D",
                  eligibilityStatus:
                    "invalid",
                  validationCode:
                    "PLAYER_OWNED",
                }),
              ],
            })
          );

        assert.equal(
          result.lockedStatus,
          "locked_incomplete"
        );
        assert.equal(
          result.allocationEligibility,
          "eligible"
        );
        assert.deepEqual(
          result.candidateOfferDispositions,
          [
            {
              entryId: uuid(200),
              playerId: uuid(300),
              participates: true,
              disposition: "participates",
              reasonCode: null,
            },
            {
              entryId: uuid(201),
              playerId: uuid(301),
              participates: false,
              disposition: "excluded_invalid",
              reasonCode: "PLAYER_OWNED",
            },
          ]
        );
      }
    );

    test(
      "applies the whole-card exclusion to conflict-only and over-cap cards, prioritizes conflict when both exist, and admits conflict-free incomplete cards",
      () => {
        const structuralConflict = carryover({
          entryNumber: 250,
          slotKey: "F01",
          placementState: "conflict",
          conflictCode:
            "CARRYOVER_SLOT_CONFLICT",
        });
        const validOffer = candidate({
          entryNumber: 251,
          slotKey: "F02",
          totalValueCents: 600,
          termYears: 2,
        });
        const fixtures = [
          {
            name: "conflict-only",
            input: cardInput({
              entries: [
                structuralConflict,
                validOffer,
              ],
            }),
            capStatus: "compliant",
            allocationEligibility:
              "excluded_structural_conflict",
            allocationExclusionReason:
              "candidate_card_structural_conflict",
            disposition:
              "excluded_structural_conflict",
          },
          {
            name: "over-cap-only",
            input: cardInput({
              capLimitCents: 200,
              entries: [validOffer],
            }),
            capStatus: "over_cap",
            allocationEligibility:
              "excluded_over_cap",
            allocationExclusionReason:
              "candidate_card_over_cap",
            disposition: "excluded_over_cap",
          },
          {
            name: "both-illegalities",
            input: cardInput({
              capLimitCents: 200,
              entries: [
                structuralConflict,
                validOffer,
              ],
            }),
            capStatus: "over_cap",
            allocationEligibility:
              "excluded_structural_conflict",
            allocationExclusionReason:
              "candidate_card_structural_conflict",
            disposition:
              "excluded_structural_conflict",
          },
          {
            name: "conflict-free-incomplete",
            input: cardInput({
              entries: [validOffer],
            }),
            capStatus: "compliant",
            allocationEligibility: "eligible",
            allocationExclusionReason: null,
            disposition: "participates",
          },
        ];

        for (const fixture of fixtures) {
          const result = evaluateCandidateCard(
            fixture.input
          );
          assert.equal(
            result.capStatus,
            fixture.capStatus,
            fixture.name
          );
          assert.equal(
            result.allocationEligibility,
            fixture.allocationEligibility,
            fixture.name
          );
          assert.equal(
            result.allocationExclusionReason,
            fixture.allocationExclusionReason,
            fixture.name
          );
          assert.equal(
            result.candidateOfferDispositions[0]
              .participates,
            fixture.disposition === "participates",
            fixture.name
          );
          assert.equal(
            result.candidateOfferDispositions[0]
              .disposition,
            fixture.disposition,
            fixture.name
          );
          assert.equal(
            result.candidateOfferDispositions[0]
              .reasonCode,
            fixture.allocationExclusionReason,
            fixture.name
          );
        }
      }
    );

    test(
      "keeps a candidate-only conflict individual while other valid offers remain whole-card eligible",
      () => {
        const invalidCandidate = candidate({
          entryNumber: 252,
          slotKey: "F01",
          placementState: "conflict",
          conflictCode:
            "CANDIDATE_POSITION_CHANGED",
          eligibilityStatus: "invalid",
          validationCode:
            "CANDIDATE_POSITION_CHANGED",
        });
        const validOffer = candidate({
          entryNumber: 253,
          slotKey: "F02",
        });
        const result = evaluateCandidateCard(
          cardInput({
            entries: [
              invalidCandidate,
              validOffer,
            ],
          })
        );

        assert.equal(
          result.completeness
            .structuralConflictCount,
          1
        );
        assert.equal(
          result.completeness
            .carriedRosterStructuralConflictCount,
          0
        );
        assert.equal(
          result.completeness
            .blockingValidationCount,
          1
        );
        assert.equal(
          result.allocationEligibility,
          "eligible"
        );
        assert.deepEqual(
          result.candidateOfferDispositions.map(
            (disposition) => [
              disposition.entryId,
              disposition.disposition,
              disposition.reasonCode,
            ]
          ),
          [
            [
              invalidCandidate.entryId,
              "excluded_invalid",
              "CANDIDATE_POSITION_CHANGED",
            ],
            [
              validOffer.entryId,
              "participates",
              null,
            ],
          ]
        );
      }
    );

    test(
      "excludes every new offer on an over-cap card, preserves carryovers, and reports signed negative cap space",
      () => {
        const result =
          evaluateCandidateCard(
            cardInput({
              capLimitCents: 10_000,
              carriedActivePlayerAmountCents:
                9_000,
              entries: [
                carryover({
                  entryNumber: 300,
                  slotKey: "F01",
                }),
                candidate({
                  entryNumber: 301,
                  slotKey: "F02",
                  totalValueCents: 2_000,
                  termYears: 1,
                }),
                candidate({
                  entryNumber: 302,
                  slotKey: "B01",
                  totalValueCents: 400,
                  termYears: 1,
                }),
              ],
            })
          );

        assert.equal(
          result.entries[0].entryKind,
          "carryover"
        );
        assert.equal(
          result.counts.carryovers,
          1
        );
        assert.equal(
          result.capStatus,
          "over_cap"
        );
        assert.equal(
          result.allocationEligibility,
          "excluded_over_cap"
        );
        assert.equal(
          result.allocationExclusionReason,
          "candidate_card_over_cap"
        );
        assert.equal(
          result.capProjection
            .maximumPossibleCapCents,
          11_000
        );
        assert.equal(
          result.capProjection
            .maximumCapSpaceCents,
          -1_000
        );
        assert.equal(
          result.candidateOfferDispositions
            .length,
          2
        );
        assert.equal(
          result.candidateOfferDispositions
            .every(
              (entry) =>
                !entry.participates &&
                entry.disposition ===
                  "excluded_over_cap" &&
                entry.reasonCode ===
                  "candidate_card_over_cap"
            ),
          true
        );
      }
    );

    test(
      "derives a complete status only when all 18 mandatory slots are filled without blockers",
      () => {
        const entries = [
          ...Array.from(
            { length: 12 },
            (_, index) =>
              candidate({
                entryNumber: 400 + index,
                slotKey:
                  `F${String(
                    index + 1
                  ).padStart(2, "0")}`,
              })
          ),
          ...Array.from(
            { length: 6 },
            (_, index) =>
              candidate({
                entryNumber: 500 + index,
                slotKey:
                  `D${String(
                    index + 1
                  ).padStart(2, "0")}`,
                position: "D",
              })
          ),
        ];
        const result =
          evaluateCandidateCard(
            cardInput({
              capLimitCents: 10_000,
              entries,
            })
          );
        assert.equal(
          result.completeness.code,
          "complete"
        );
        assert.equal(
          result.lockedStatus,
          "locked_complete"
        );
        assert.equal(
          result.counts.emptyMandatory,
          0
        );
        assert.equal(
          result.counts.emptyBench,
          4
        );
      }
    );

    test(
      "reports unplaced conflicts without silently discarding them",
      () => {
        const result =
          evaluateCandidateCard(
            cardInput({
              entries: [
                candidate({
                  entryNumber: 600,
                  slotKey: "F01",
                  placementState: "conflict",
                  conflictCode:
                    "CARRYOVER_SLOT_REQUIRED",
                }),
              ],
            })
          );
        assert.equal(
          result.lockedStatus,
          "locked_conflicted"
        );
        assert.equal(
          result.conflicts.length,
          1
        );
        assert.equal(
          result.counts.emptyMandatory,
          18
        );
        assert.deepEqual(
          result.candidateOfferDispositions,
          [
            {
              entryId: uuid(600),
              playerId: uuid(700),
              participates: false,
              disposition: "excluded_invalid",
              reasonCode:
                "CARRYOVER_SLOT_REQUIRED",
            },
          ]
        );
      }
    );

    test(
      "rejects duplicate players and occupied slots with distinct stable errors",
      () => {
        const first = candidate({
          entryNumber: 700,
          playerNumber: 800,
          slotKey: "F01",
        });
        assertPolicyError(
          () =>
            evaluateCandidateCard(
              cardInput({
                entries: [
                  first,
                  candidate({
                    entryNumber: 701,
                    playerNumber: 800,
                    slotKey: "F02",
                  }),
                ],
              })
            ),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .playerDuplicate,
            reasonCode:
              "candidate_player_duplicate",
          }
        );
        assertPolicyError(
          () =>
            evaluateCandidateCard(
              cardInput({
                entries: [
                  first,
                  candidate({
                    entryNumber: 702,
                    playerNumber: 801,
                    slotKey: "F01",
                  }),
                ],
              })
            ),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .slotOccupied,
            reasonCode: "slot_occupied",
          }
        );
      }
    );

    test(
      "returns recursively immutable projections detached from mutable input",
      () => {
        const entry = candidate({
          entryNumber: 800,
          slotKey: "F01",
        });
        const input = cardInput({
          entries: [entry],
        });
        const result =
          evaluateCandidateCard(input);

        entry.totalValueCents = 9_999;
        input.entries.length = 0;
        assert.equal(
          result.entries[0].totalValueCents,
          100
        );
        assert.equal(result.entries.length, 1);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(
          Object.isFrozen(result.entries),
          true
        );
        assert.equal(
          Object.isFrozen(result.entries[0]),
          true
        );
        assert.equal(
          Object.isFrozen(result.capProjection),
          true
        );
        assert.equal(
          Object.isFrozen(
            result
              .candidateOfferDispositions[0]
          ),
          true
        );
      }
    );
  }
);

describe(
  "Candidate Card help-window authority policy",
  () => {
    const HELP_OPENS_AT_MS = 1_000;
    const DEADLINE_AT_MS = 2_000;

    function helpInput(overrides = {}) {
      return {
        actorAuthority: "manager",
        activeLeagueMembership: true,
        currentTeamManager: true,
        currentCommissionerAuthority:
          false,
        activeHelpRequest: false,
        nowMs: 999,
        helpOpensAtMs: HELP_OPENS_AT_MS,
        candidateDeadlineAtMs:
          DEADLINE_AT_MS,
        ...overrides,
      };
    }

    test(
      "keeps manager editing open before the help window and opens help at the exact boundary",
      () => {
        const before =
          evaluateCandidateCardHelpAuthority(
            helpInput()
          );
        assert.equal(
          before.canReadPrivateCard,
          true
        );
        assert.equal(
          before.canEditCandidateEntries,
          true
        );
        assert.equal(
          before.canRequestHelp,
          false
        );

        const at =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              nowMs: HELP_OPENS_AT_MS,
            })
          );
        assert.equal(at.helpWindowOpen, true);
        assert.equal(
          at.canRequestHelp,
          true
        );
        assert.equal(
          at.accessSource,
          "manager_assignment"
        );
      }
    );

    test(
      "grants commissioner or member-platform-admin access only from the exact active help request",
      () => {
        const withoutHelp =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              actorAuthority:
                "commissioner",
              currentTeamManager: false,
              currentCommissionerAuthority:
                true,
              nowMs: 1_500,
            })
          );
        assert.equal(
          withoutHelp.canReadPrivateCard,
          false
        );
        const impossibleEarlyGrant =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              actorAuthority:
                "commissioner",
              currentTeamManager: false,
              currentCommissionerAuthority:
                true,
              activeHelpRequest: true,
            })
          );
        assert.equal(
          impossibleEarlyGrant
            .canReadPrivateCard,
          false
        );

        for (const actorAuthority of [
          "commissioner",
          "platform_administrator_as_commissioner",
        ]) {
          const withHelp =
            evaluateCandidateCardHelpAuthority(
              helpInput({
                actorAuthority,
                currentTeamManager: false,
                currentCommissionerAuthority:
                  true,
                activeHelpRequest: true,
                nowMs: 1_500,
              })
            );
          assert.equal(
            withHelp.accessSource,
            "help_request"
          );
          assert.equal(
            withHelp.canReadPrivateCard,
            true
          );
          assert.equal(
            withHelp.canEditCandidateEntries,
            true
          );
          assert.equal(
            withHelp.canRemoveCarryovers,
            false
          );
          assert.equal(
            withHelp
              .canEditCarryoverContracts,
            false
          );
        }
      }
    );

    test(
      "requires a dual-role actor to use the authority they selected",
      () => {
        const managerSelected =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              actorAuthority: "manager",
              currentTeamManager: true,
              currentCommissionerAuthority:
                true,
              nowMs: 1_500,
            })
          );
        assert.equal(
          managerSelected.accessSource,
          "manager_assignment"
        );

        const commissionerSelected =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              actorAuthority:
                "commissioner",
              currentTeamManager: true,
              currentCommissionerAuthority:
                true,
              nowMs: 1_500,
            })
          );
        assert.equal(
          commissionerSelected.accessSource,
          "none"
        );
        assert.equal(
          commissionerSelected
            .canReadPrivateCard,
          false
        );

        const helpedCommissioner =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              actorAuthority:
                "commissioner",
              currentTeamManager: true,
              currentCommissionerAuthority:
                true,
              activeHelpRequest: true,
              nowMs: 1_500,
            })
          );
        assert.equal(
          helpedCommissioner.accessSource,
          "help_request"
        );
        assert.equal(
          helpedCommissioner
            .canReadPrivateCard,
          true
        );
      }
    );

    test(
      "requires active membership, preserves manager read access, and ends every edit/help grant at the deadline",
      () => {
        const noMembership =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              actorAuthority:
                "platform_administrator_as_commissioner",
              activeLeagueMembership: false,
              currentTeamManager: false,
              currentCommissionerAuthority:
                true,
              activeHelpRequest: true,
              nowMs: 1_500,
            })
          );
        assert.equal(
          noMembership.accessSource,
          "none"
        );

        const atDeadline =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              activeHelpRequest: true,
              nowMs: DEADLINE_AT_MS,
            })
          );
        assert.equal(
          atDeadline.helpWindowOpen,
          false
        );
        assert.equal(
          atDeadline.canReadPrivateCard,
          true
        );
        assert.equal(
          atDeadline.accessSource,
          "manager_assignment"
        );
        assert.equal(
          atDeadline.canEditCandidateEntries,
          false
        );
        assert.equal(
          atDeadline.canRequestHelp,
          false
        );

        const helpedCommissionerAtDeadline =
          evaluateCandidateCardHelpAuthority(
            helpInput({
              actorAuthority: "commissioner",
              currentTeamManager: false,
              currentCommissionerAuthority:
                true,
              activeHelpRequest: true,
              nowMs: DEADLINE_AT_MS,
            })
          );
        assert.equal(
          helpedCommissionerAtDeadline
            .accessSource,
          "none"
        );
        assert.equal(
          helpedCommissionerAtDeadline
            .canReadPrivateCard,
          false
        );
      }
    );

    test(
      "rejects malformed help authority material with stable safe errors",
      () => {
        assertPolicyError(
          () =>
            evaluateCandidateCardHelpAuthority(
              helpInput({
                helpOpensAtMs:
                  DEADLINE_AT_MS,
              })
            ),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .inputInvalid,
            reasonCode: "help_window_invalid",
          }
        );
        assertPolicyError(
          () =>
            evaluateCandidateCardHelpAuthority({
              ...helpInput(),
              clientClaimsCommissioner: true,
            }),
          {
            code:
              CANDIDATE_CARD_POLICY_CODES
                .inputInvalid,
            reasonCode:
              "input_fields_invalid",
          }
        );
      }
    );
  }
);

test(
  "Candidate Card domain policy has no clock, network, database, filesystem, or runtime dependency",
  () => {
    const source = readFileSync(
      path.resolve(
        __dirname,
        "../../src/domain/freeAgentDraft/candidateCardPolicy.js"
      ),
      "utf8"
    );
    assert.doesNotMatch(source, /Date\.now\s*\(/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(
      source,
      /require\(["'](?:node:)?(?:fs|http|https|net|tls|sqlite|better-sqlite3)/
    );
    assert.doesNotMatch(
      source,
      /src[\\/](?:application|infrastructure|transport|jobs)/
    );
  }
);
