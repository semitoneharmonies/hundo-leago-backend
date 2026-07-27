const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  ROSTER_MOVEMENT_CODES,
  RosterMovementPolicyError,
  evaluateStructuralRosterLegality,
  validateRosterMove,
} = require("../../src/domain/rosters/rosterMovementPolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteRosterMovementRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRosterMovementRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T00:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  user: uuid(1),
  league: uuid(10),
  otherLeague: uuid(11),
  season: uuid(20),
  team: uuid(30),
  otherTeam: uuid(31),
  player1: uuid(40),
  player2: uuid(41),
  ownership1: uuid(50),
  ownership2: uuid(51),
  event1: uuid(60),
  event2: uuid(61),
  activity1: uuid(70),
  activity2: uuid(71),
});

function seed(context) {
  context.repositories.users.insert({
    id: IDS.user,
    email_normalized: "manager@example.test",
    email_display: "manager@example.test",
    display_name: "Manager",
    display_name_normalized: "manager",
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.leagues.insert({
    id: IDS.league,
    name: "League",
    name_normalized: "league",
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.seasons.insert({
    id: IDS.season,
    league_id: IDS.league,
    label: "Season",
    nhl_season_key: "20262027",
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  for (const [id, name] of [
    [IDS.team, "Team"],
    [IDS.otherTeam, "Other Team"],
  ]) {
    context.repositories.teams.insert({
      id,
      league_id: IDS.league,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  for (const [id, lastName] of [
    [IDS.player1, "One"],
    [IDS.player2, "Two"],
  ]) {
    context.repositories.players.insert({
      id,
      first_name: "Player",
      last_name: lastName,
      full_name: `Player ${lastName}`,
      birth_date: null,
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
}

function ownership(overrides = {}) {
  return {
    id: IDS.ownership1,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player1,
    team_id: IDS.team,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "migration",
    acquired_transaction_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
    ...overrides,
  };
}

function createRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m4-04-"));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-04-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  seed(context);
  return {
    context,
    database: connection.database,
    repository: createSqliteRosterMovementRepository({
      database: connection.database,
    }),
  };
}

function moveInput(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    teamId: IDS.team,
    playerId: IDS.player1,
    expectedVersion: 1,
    expectedSourceCategory: "Active",
    destinationCategory: "Bench",
    destinationPositionGroup: "F",
    destinationSlotNumber: 1,
    actorUserId: IDS.user,
    actorAuthority: "manager",
    ownershipEventId: IDS.event1,
    activityId: IDS.activity1,
    reason: null,
    occurredAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    return (
      error instanceof RosterMovementPolicyError &&
      error.reasonCode === reasonCode
    );
  });
}

describe("M4-04 roster movement policy", () => {
  test("accepts only Active-mediated ordinary category transitions", () => {
    for (const [source, destination] of [
      ["Active", "Bench"],
      ["Bench", "Active"],
      ["Active", "Injured Reserve"],
      ["Injured Reserve", "Active"],
    ]) {
      assert.equal(
        Object.isFrozen(
          validateRosterMove(
            moveInput({
              expectedSourceCategory: source,
              destinationCategory: destination,
            })
          )
        ),
        true
      );
    }
    for (const [source, destination] of [
      ["Bench", "Injured Reserve"],
      ["Injured Reserve", "Bench"],
      ["Active", "Active"],
    ]) {
      assertPolicyError(
        () =>
          validateRosterMove(
            moveInput({
              expectedSourceCategory: source,
              destinationCategory: destination,
            })
          ),
        ROSTER_MOVEMENT_CODES.transitionInvalid
      );
    }
  });

  test("returns immutable structural counts and explicit position failures", () => {
    const base = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      teamId: IDS.team,
    };
    const result = evaluateStructuralRosterLegality({
      ...base,
      assignments: [
        {
          ...base,
          playerId: IDS.player1,
          rosterCategory: "Active",
          assignedPositionGroup: "F",
        },
        {
          ...base,
          playerId: IDS.player2,
          rosterCategory: "Bench",
          assignedPositionGroup: "D",
        },
      ],
      effectivePositions: [
        { playerId: IDS.player1, positionGroup: "D" },
        { playerId: IDS.player2, positionGroup: null },
      ],
    });
    assert.equal(result.legal, false);
    assert.equal(result.counts.activeDefence, 1);
    assert.deepEqual(
      result.reasons.map(({ code }) => code),
      [
        "PLAYER_POSITION_ASSIGNMENT_MISMATCH",
        "PLAYER_POSITION_MISSING",
      ]
    );
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.reasons), true);
  });
});

describe("M4-04 atomic roster movement repository", () => {
  test("moves one ownership and appends both required histories atomically", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.player_ownerships.insert(ownership());
    const result = runtime.repository.move(moveInput());

    assert.equal(result.ownership.id, IDS.ownership1);
    assert.equal(result.ownership.roster_category, "Bench");
    assert.equal(result.ownership.version, 2);
    assert.equal(result.ownershipEvent.event_type, "roster_category_moved");
    assert.equal(result.activity.event_type, "roster_moved");
    assert.equal(Object.isFrozen(result), true);
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM ownership_events")
        .get().count,
      1
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM league_activity")
        .get().count,
      1
    );
  });

  test("persists a confirmed ordinary move into an unplaced overflow slot", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.player_ownerships.insert(
      ownership({ roster_category: "Bench" })
    );

    const result = runtime.repository.move(
      moveInput({
        expectedSourceCategory: "Bench",
        destinationCategory: "Active",
        destinationSlotNumber: null,
      })
    );

    assert.equal(result.ownership.roster_category, "Active");
    assert.equal(result.ownership.slot_number, null);
    assert.equal(result.ownership.version, 2);
    assert.equal(result.ownershipEvent.event_type, "roster_category_moved");
    assert.equal(result.activity.event_type, "roster_moved");
    assert.equal(
      runtime.database
        .prepare(
          "SELECT slot_number FROM player_ownerships WHERE id = ?"
        )
        .get(IDS.ownership1).slot_number,
      null
    );
  });

  test("supports the required Active-to-IR and IR-to-Active sequence", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.player_ownerships.insert(ownership());
    runtime.repository.move(
      moveInput({ destinationCategory: "Injured Reserve" })
    );
    const returned = runtime.repository.move(
      moveInput({
        expectedVersion: 2,
        expectedSourceCategory: "Injured Reserve",
        destinationCategory: "Active",
        ownershipEventId: IDS.event2,
        activityId: IDS.activity2,
        occurredAtMs: NOW_MS + 2,
      })
    );
    assert.equal(returned.ownership.roster_category, "Active");
    assert.equal(returned.ownership.version, 3);
  });

  test("rejects stale category, version, and scope without writes", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.player_ownerships.insert(ownership());
    for (const [overrides, reasonCode] of [
      [
        {
          expectedSourceCategory: "Bench",
          destinationCategory: "Active",
        },
        ROSTER_MOVEMENT_CODES.sourceChanged,
      ],
      [
        { expectedVersion: 2 },
        ROSTER_MOVEMENT_CODES.versionConflict,
      ],
      [
        { teamId: IDS.otherTeam },
        ROSTER_MOVEMENT_CODES.scopeMismatch,
      ],
    ]) {
      assertPolicyError(
        () => runtime.repository.move(moveInput(overrides)),
        reasonCode
      );
    }
    assert.equal(
      runtime.context.repositories.player_ownerships.findByKey({
        key: IDS.ownership1,
        leagueId: IDS.league,
      }).version,
      1
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM ownership_events")
        .get().count,
      0
    );
  });

  test("rolls back when the destination slot is occupied", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.player_ownerships.insert(ownership());
    runtime.context.repositories.player_ownerships.insert(
      ownership({
        id: IDS.ownership2,
        player_id: IDS.player2,
        roster_category: "Bench",
      })
    );
    assert.throws(
      () => runtime.repository.move(moveInput()),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    const current =
      runtime.context.repositories.player_ownerships.findByKey({
        key: IDS.ownership1,
        leagueId: IDS.league,
      });
    assert.equal(current.roster_category, "Active");
    assert.equal(current.version, 1);
  });

  test("rolls back the ownership update when history insertion fails", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.player_ownerships.insert(ownership());
    runtime.context.repositories.ownership_events.insert({
      id: IDS.event1,
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.player1,
      team_id: IDS.team,
      ownership_id: IDS.ownership1,
      event_type: "seed",
      actor_user_id: IDS.user,
      source_type: null,
      source_id: null,
      before_metadata_json: null,
      after_metadata_json: null,
      reason: null,
      occurred_at_ms: NOW_MS,
    });
    assert.throws(
      () => runtime.repository.move(moveInput()),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    const current =
      runtime.context.repositories.player_ownerships.findByKey({
        key: IDS.ownership1,
        leagueId: IDS.league,
      });
    assert.equal(current.roster_category, "Active");
    assert.equal(current.version, 1);
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM league_activity")
        .get().count,
      0
    );
  });
});
