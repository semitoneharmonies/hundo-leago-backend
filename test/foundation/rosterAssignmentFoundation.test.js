const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  ROSTER_ASSIGNMENT_CODES,
  RosterAssignmentPolicyError,
  buildRosterCategoryProjection,
  createRosterAssignmentRecord,
  normalizeSourcePosition,
} = require(
  "../../src/domain/rosters/rosterAssignmentPolicy"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  otherLeague: uuid(2),
  season: uuid(3),
  team: uuid(4),
  player1: uuid(10),
  player2: uuid(11),
  player3: uuid(12),
  player4: uuid(13),
});

function assignmentInput(overrides = {}) {
  return {
    id: uuid(100),
    leagueId: IDS.league,
    seasonId: IDS.season,
    playerId: IDS.player1,
    teamId: IDS.team,
    ownershipKind: "Rostered",
    rosterCategory: "Active",
    positionGroup: "F",
    slotNumber: 1,
    acquiredTransactionType: "migration",
    acquiredTransactionId: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

function assignment(overrides = {}) {
  return createRosterAssignmentRecord(
    assignmentInput(overrides)
  );
}

function projection(assignments) {
  return buildRosterCategoryProjection({
    leagueId: IDS.league,
    seasonId: IDS.season,
    teamId: IDS.team,
    assignments,
  });
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    return (
      error instanceof RosterAssignmentPolicyError &&
      error.code === ROSTER_ASSIGNMENT_CODES.inputInvalid &&
      error.reasonCode === reasonCode
    );
  });
}

describe("M4-03 roster category and slot-assignment policy", () => {
  test("normalizes only approved forward and defence source positions", () => {
    for (const source of ["C", "LW", "RW", "F"]) {
      assert.equal(normalizeSourcePosition(source), "F");
    }
    for (const source of ["LD", "RD", "D"]) {
      assert.equal(normalizeSourcePosition(source), "D");
    }
    for (const source of ["G", "C/RD", "", null]) {
      assertPolicyError(
        () => normalizeSourcePosition(source),
        ROSTER_ASSIGNMENT_CODES.positionInvalid
      );
    }
  });

  test("constructs every approved category with exact ownership and slot shape", () => {
    const activeForward = assignment();
    const activeDefence = assignment({
      id: uuid(101),
      playerId: IDS.player2,
      positionGroup: "D",
      slotNumber: 6,
    });
    const bench = assignment({
      id: uuid(102),
      playerId: IDS.player2,
      rosterCategory: "Bench",
      positionGroup: "D",
      slotNumber: 4,
    });
    const injuredReserve = assignment({
      id: uuid(103),
      playerId: IDS.player3,
      rosterCategory: "Injured Reserve",
      slotNumber: 4,
    });
    const prospectRight = assignment({
      id: uuid(104),
      playerId: IDS.player4,
      ownershipKind: "Prospect Right",
      rosterCategory: "Prospect",
      slotNumber: null,
    });
    const signedProspect = assignment({
      id: uuid(105),
      playerId: uuid(14),
      rosterCategory: "Prospect",
      slotNumber: null,
    });

    assert.equal(activeForward.slot_number, 1);
    assert.equal(activeDefence.slot_number, 6);
    assert.equal(bench.slot_number, 4);
    assert.equal(injuredReserve.slot_number, 4);
    assert.equal(prospectRight.ownership_kind, "Prospect Right");
    assert.equal(signedProspect.ownership_kind, "Rostered");
    for (const record of [
      activeForward,
      activeDefence,
      bench,
      injuredReserve,
      prospectRight,
      signedProspect,
    ]) {
      assert.equal(Object.isFrozen(record), true);
    }
  });

  test("rejects invalid category, ownership-kind, slot, ID, and timestamp combinations", () => {
    const cases = [
      [
        { rosterCategory: "Goalie" },
        ROSTER_ASSIGNMENT_CODES.categoryInvalid,
      ],
      [
        { ownershipKind: "Prospect Right" },
        ROSTER_ASSIGNMENT_CODES.ownershipKindInvalid,
      ],
      [
        { positionGroup: "G" },
        ROSTER_ASSIGNMENT_CODES.positionInvalid,
      ],
      [{ slotNumber: 13 }, ROSTER_ASSIGNMENT_CODES.slotInvalid],
      [
        { positionGroup: "D", slotNumber: 7 },
        ROSTER_ASSIGNMENT_CODES.slotInvalid,
      ],
      [
        { rosterCategory: "Bench", slotNumber: null },
        ROSTER_ASSIGNMENT_CODES.slotInvalid,
      ],
      [
        { rosterCategory: "Prospect", slotNumber: 1 },
        ROSTER_ASSIGNMENT_CODES.slotInvalid,
      ],
      [
        { playerId: "not-a-stable-id" },
        ROSTER_ASSIGNMENT_CODES.stableIdInvalid,
      ],
      [
        { updatedAtMs: 999 },
        ROSTER_ASSIGNMENT_CODES.timestampInvalid,
      ],
    ];
    for (const [overrides, reasonCode] of cases) {
      assertPolicyError(
        () => assignment(overrides),
        reasonCode
      );
    }
    assertPolicyError(
      () =>
        createRosterAssignmentRecord({
          ...assignmentInput(),
          unknown: true,
        }),
      ROSTER_ASSIGNMENT_CODES.inputInvalid
    );
  });

  test("projects finite empty slots and unlimited prospects immutably", () => {
    const records = [
      assignment(),
      assignment({
        id: uuid(101),
        playerId: IDS.player2,
        positionGroup: "D",
        slotNumber: 6,
      }),
      assignment({
        id: uuid(102),
        playerId: IDS.player3,
        rosterCategory: "Bench",
        slotNumber: 2,
      }),
      assignment({
        id: uuid(103),
        playerId: IDS.player4,
        ownershipKind: "Prospect Right",
        rosterCategory: "Prospect",
        slotNumber: null,
      }),
    ];
    const before = JSON.stringify(records);
    const roster = projection(records);

    assert.equal(roster.active.forwards.length, 12);
    assert.equal(roster.active.defence.length, 6);
    assert.deepEqual(roster.active.unplaced, []);
    assert.equal(roster.bench.length, 4);
    assert.equal(roster.injuredReserve.length, 4);
    assert.equal(roster.active.forwards[0].assignment.player_id, IDS.player1);
    assert.equal(roster.active.forwards[1].assignment, null);
    assert.equal(roster.active.defence[5].assignment.player_id, IDS.player2);
    assert.equal(roster.bench[1].assignment.player_id, IDS.player3);
    assert.equal(roster.prospects[0].player_id, IDS.player4);
    assert.deepEqual(roster.counts, {
      activeForwards: 1,
      activeDefence: 1,
      active: 2,
      bench: 1,
      injuredReserve: 0,
      prospects: 1,
      total: 4,
    });
    assert.equal(Object.isFrozen(roster), true);
    assert.equal(Object.isFrozen(roster.active.forwards), true);
    assert.equal(Object.isFrozen(roster.active.unplaced), true);
    assert.equal(Object.isFrozen(roster.active.forwards[0]), true);
    assert.equal(JSON.stringify(records), before);
  });

  test("permits and surfaces only auction-resolution Active overflow", () => {
    const unplacedForward = assignment({
      slotNumber: null,
      acquiredTransactionType: "auction_resolution",
    });
    const unplacedDefence = assignment({
      id: uuid(101),
      playerId: IDS.player2,
      positionGroup: "D",
      slotNumber: null,
      acquiredTransactionType: "auction_resolution",
    });
    const roster = projection([unplacedDefence, unplacedForward]);

    assert.deepEqual(
      roster.active.unplaced.map((record) => record.player_id),
      [IDS.player1, IDS.player2]
    );
    assert.equal(roster.counts.active, 2);
    assert.equal(roster.active.forwards.every(({ assignment: value }) => value === null), true);
    assert.equal(roster.active.defence.every(({ assignment: value }) => value === null), true);
    assertPolicyError(
      () => assignment({ slotNumber: null }),
      ROSTER_ASSIGNMENT_CODES.slotInvalid
    );
    assertPolicyError(
      () =>
        assignment({
          rosterCategory: "Bench",
          slotNumber: null,
          acquiredTransactionType: "auction_resolution",
        }),
      ROSTER_ASSIGNMENT_CODES.slotInvalid
    );
  });

  test("rejects duplicate occupied slots and duplicate players", () => {
    const first = assignment();
    assertPolicyError(
      () =>
        projection([
          first,
          assignment({
            id: uuid(101),
            playerId: IDS.player2,
          }),
        ]),
      ROSTER_ASSIGNMENT_CODES.slotDuplicate
    );
    assertPolicyError(
      () =>
        projection([
          first,
          assignment({
            id: uuid(102),
            rosterCategory: "Bench",
            slotNumber: 1,
          }),
        ]),
      ROSTER_ASSIGNMENT_CODES.playerDuplicate
    );
  });

  test("rejects any assignment outside the exact league, season, or team scope", () => {
    const crossLeague = assignment({
      leagueId: IDS.otherLeague,
    });
    assertPolicyError(
      () => projection([crossLeague]),
      ROSTER_ASSIGNMENT_CODES.scopeMismatch
    );
  });
});
