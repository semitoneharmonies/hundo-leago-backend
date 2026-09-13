const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  CONTRACT_SEASON_PLANNER_CODES,
  ContractSeasonPlannerError,
  planContractSeasons,
} = require("../../src/domain/contracts/contractSeasonPlanner");

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  otherLeague: uuid(2),
  target: uuid(3),
  future1: uuid(4),
  future2: uuid(5),
  generated1: uuid(6),
  generated2: uuid(7),
});

function season({
  id,
  leagueId = IDS.league,
  label,
  nhlSeasonKey,
  status = "planned",
}) {
  return {
    id,
    leagueId,
    label,
    nhlSeasonKey,
    status,
  };
}

function target(label = "2026") {
  return season({
    id: IDS.target,
    label,
    nhlSeasonKey: "20262027",
    status: "active",
  });
}

function input(overrides = {}) {
  const targetSeason =
    overrides.targetSeason || target();
  return {
    leagueId: IDS.league,
    targetSeason,
    existingSeasons:
      overrides.existingSeasons || [targetSeason],
    futureSeasonIds: [
      IDS.generated1,
      IDS.generated2,
    ],
    termYears: 3,
    nowMs: 1_000,
    ...overrides,
  };
}

function assertPlannerError(callback, reasonCode) {
  assert.throws(
    callback,
    (error) =>
      error instanceof ContractSeasonPlannerError &&
      error.code ===
        CONTRACT_SEASON_PLANNER_CODES.inputInvalid &&
      error.reasonCode === reasonCode
  );
}

function planned(id, label, nhlSeasonKey) {
  return season({ id, label, nhlSeasonKey });
}

describe("FAD-03 shared ContractSeasonPlanner", () => {
  test("creates fixed one-, two-, and three-year canonical plans", () => {
    const oneYear = planContractSeasons(
      input({ termYears: 1 })
    );
    assert.deepEqual(oneYear, {
      seasonIds: [IDS.target],
      seasonsToCreate: [],
    });

    const twoYear = planContractSeasons(
      input({ termYears: 2 })
    );
    assert.deepEqual(twoYear.seasonIds, [
      IDS.target,
      IDS.generated1,
    ]);
    assert.deepEqual(twoYear.seasonsToCreate, [
      {
        id: IDS.generated1,
        leagueId: IDS.league,
        label: "2027-28",
        nhlSeasonKey: "20272028",
        status: "planned",
        regularSeasonStartsAtMs: null,
        regularSeasonEndsAtMs: null,
        fantasyPlayoffsStartAtMs: null,
        fantasyPlayoffsEndAtMs: null,
        freeAgentDraftCompletedAtMs: null,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        version: 1,
      },
    ]);

    const threeYear = planContractSeasons(input());
    assert.deepEqual(threeYear.seasonIds, [
      IDS.target,
      IDS.generated1,
      IDS.generated2,
    ]);
    assert.deepEqual(
      threeYear.seasonsToCreate.map(
        ({ label, nhlSeasonKey }) => ({
          label,
          nhlSeasonKey,
        })
      ),
      [
        {
          label: "2027-28",
          nhlSeasonKey: "20272028",
        },
        {
          label: "2028-29",
          nhlSeasonKey: "20282029",
        },
      ]
    );
  });

  test("derives chronology from keys across display-label and century boundaries", () => {
    const legacy = planContractSeasons(
      input({ targetSeason: target("2026") })
    );
    const canonicalTarget = target("2026-27");
    const canonical = planContractSeasons(
      input({
        targetSeason: canonicalTarget,
        existingSeasons: [canonicalTarget],
      })
    );
    assert.deepEqual(
      canonical.seasonsToCreate,
      legacy.seasonsToCreate
    );

    const centuryTarget = season({
      id: IDS.target,
      label: "2099/2100",
      nhlSeasonKey: "20992100",
      status: "active",
    });
    const century = planContractSeasons(
      input({
        targetSeason: centuryTarget,
        existingSeasons: [centuryTarget],
      })
    );
    assert.deepEqual(
      century.seasonsToCreate.map(
        ({ label, nhlSeasonKey }) => ({
          label,
          nhlSeasonKey,
        })
      ),
      [
        {
          label: "2100-01",
          nhlSeasonKey: "21002101",
        },
        {
          label: "2101-02",
          nhlSeasonKey: "21012102",
        },
      ]
    );
  });

  test("reuses canonical planned seasons without changing them", () => {
    const targetSeason = target();
    const first = planned(
      IDS.future1,
      "2027-28",
      "20272028"
    );
    const second = planned(
      IDS.future2,
      "2028-29",
      "20282029"
    );
    const before = JSON.stringify([
      targetSeason,
      first,
      second,
    ]);
    const plan = planContractSeasons(
      input({
        targetSeason,
        existingSeasons: [
          targetSeason,
          first,
          second,
        ],
      })
    );

    assert.deepEqual(plan, {
      seasonIds: [
        IDS.target,
        IDS.future1,
        IDS.future2,
      ],
      seasonsToCreate: [],
    });
    assert.equal(
      JSON.stringify([targetSeason, first, second]),
      before
    );
  });

  test("uses the first available generated ID only for a missing row", () => {
    const targetSeason = target();
    const first = planned(
      IDS.future1,
      "2027-28",
      "20272028"
    );
    const plan = planContractSeasons(
      input({
        targetSeason,
        existingSeasons: [targetSeason, first],
      })
    );
    assert.deepEqual(plan.seasonIds, [
      IDS.target,
      IDS.future1,
      IDS.generated1,
    ]);
    assert.equal(
      plan.seasonsToCreate[0].nhlSeasonKey,
      "20282029"
    );
  });

  test("rejects malformed, nonconsecutive, and exhausted season keys", () => {
    const malformedTargets = [
      "2026202",
      "2026202x",
      "20262028",
    ];
    for (const nhlSeasonKey of malformedTargets) {
      const malformed = season({
        id: IDS.target,
        label: "target",
        nhlSeasonKey,
        status: "active",
      });
      assertPlannerError(
        () =>
          planContractSeasons(
            input({
              targetSeason: malformed,
              existingSeasons: [malformed],
            })
          ),
        CONTRACT_SEASON_PLANNER_CODES.seasonInvalid
      );
    }

    const exhausted = season({
      id: IDS.target,
      label: "9998",
      nhlSeasonKey: "99989999",
      status: "active",
    });
    assertPlannerError(
      () =>
        planContractSeasons(
          input({
            targetSeason: exhausted,
            existingSeasons: [exhausted],
            termYears: 2,
          })
        ),
      CONTRACT_SEASON_PLANNER_CODES.seasonInvalid
    );
  });

  test("rejects duplicate IDs, keys, and labels", () => {
    const targetSeason = target();
    const duplicateCases = [
      [
        targetSeason,
        planned(
          IDS.target,
          "2027-28",
          "20272028"
        ),
      ],
      [
        targetSeason,
        planned(
          IDS.future1,
          "different",
          "20262027"
        ),
      ],
      [
        targetSeason,
        planned(
          IDS.future1,
          targetSeason.label,
          "20272028"
        ),
      ],
    ];
    for (const existingSeasons of duplicateCases) {
      assertPlannerError(
        () =>
          planContractSeasons(
            input({ targetSeason, existingSeasons })
          ),
        CONTRACT_SEASON_PLANNER_CODES.seasonConflict
      );
    }
  });

  test("rejects missing, mismatched, inactive, cross-league, or ambiguous targets", () => {
    const targetSeason = target();
    const otherActive = season({
      id: IDS.future1,
      label: "other",
      nhlSeasonKey: "20272028",
      status: "active",
    });
    const cases = [
      input({ targetSeason, existingSeasons: [] }),
      input({
        targetSeason,
        existingSeasons: [
          { ...targetSeason, label: "different" },
        ],
      }),
      input({
        targetSeason: {
          ...targetSeason,
          status: "planned",
        },
        existingSeasons: [
          { ...targetSeason, status: "planned" },
        ],
      }),
      input({
        targetSeason,
        existingSeasons: [targetSeason, otherActive],
      }),
      input({
        targetSeason: {
          ...targetSeason,
          leagueId: IDS.otherLeague,
        },
      }),
    ];
    const expectedReasons = [
      CONTRACT_SEASON_PLANNER_CODES.seasonConflict,
      CONTRACT_SEASON_PLANNER_CODES.seasonConflict,
      CONTRACT_SEASON_PLANNER_CODES.seasonInvalid,
      CONTRACT_SEASON_PLANNER_CODES.seasonConflict,
      CONTRACT_SEASON_PLANNER_CODES.seasonConflict,
    ];
    cases.forEach((value, index) => {
      assertPlannerError(
        () => planContractSeasons(value),
        expectedReasons[index]
      );
    });
  });

  test("rejects future key, label, and lifecycle collisions", () => {
    const targetSeason = target();
    const cases = [
      planned(
        IDS.future1,
        "wrong-label",
        "20272028"
      ),
      planned(
        IDS.future1,
        "2027-28",
        "20282029"
      ),
      season({
        id: IDS.future1,
        label: "2027-28",
        nhlSeasonKey: "20272028",
        status: "cancelled",
      }),
    ];
    for (const conflicting of cases) {
      assertPlannerError(
        () =>
          planContractSeasons(
            input({
              targetSeason,
              existingSeasons: [
                targetSeason,
                conflicting,
              ],
            })
          ),
        CONTRACT_SEASON_PLANNER_CODES.seasonConflict
      );
    }

    assertPlannerError(
      () =>
        planContractSeasons(
          input({
            targetSeason,
            existingSeasons: [
              targetSeason,
              planned(
                IDS.future1,
                "different",
                "20272028"
              ),
              planned(
                IDS.future2,
                "2027-28",
                "20282029"
              ),
            ],
          })
        ),
      CONTRACT_SEASON_PLANNER_CODES.seasonConflict
    );
  });

  test("rejects duplicate or colliding generated identifiers", () => {
    for (const futureSeasonIds of [
      [IDS.generated1, IDS.generated1],
      [IDS.target, IDS.generated2],
    ]) {
      assertPlannerError(
        () =>
          planContractSeasons(
            input({ futureSeasonIds })
          ),
        CONTRACT_SEASON_PLANNER_CODES.seasonConflict
      );
    }
  });

  test("rejects malformed terms, IDs, timestamps, collections, and exact shapes", () => {
    const cases = [
      [
        input({ termYears: 4 }),
        CONTRACT_SEASON_PLANNER_CODES.termInvalid,
      ],
      [
        input({ leagueId: "bad" }),
        CONTRACT_SEASON_PLANNER_CODES.stableIdInvalid,
      ],
      [
        input({ nowMs: -1 }),
        CONTRACT_SEASON_PLANNER_CODES.timestampInvalid,
      ],
      [
        input({ existingSeasons: null }),
        CONTRACT_SEASON_PLANNER_CODES.inputInvalid,
      ],
      [
        input({ futureSeasonIds: [IDS.generated1] }),
        CONTRACT_SEASON_PLANNER_CODES.inputInvalid,
      ],
      [
        { ...input(), unexpected: true },
        CONTRACT_SEASON_PLANNER_CODES.inputInvalid,
      ],
      [
        input({
          targetSeason: {
            ...target(),
            unexpected: true,
          },
        }),
        CONTRACT_SEASON_PLANNER_CODES.inputInvalid,
      ],
    ];
    for (const [value, reasonCode] of cases) {
      assertPlannerError(
        () => planContractSeasons(value),
        reasonCode
      );
    }
  });

  test("returns a deeply immutable plan", () => {
    const plan = planContractSeasons(input());
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.seasonIds), true);
    assert.equal(
      Object.isFrozen(plan.seasonsToCreate),
      true
    );
    assert.equal(
      plan.seasonsToCreate.every(Object.isFrozen),
      true
    );
  });
});
