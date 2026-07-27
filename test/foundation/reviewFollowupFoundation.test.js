const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createLeagueMembershipService,
} = require("../../src/application/services/leagues/createLeagueMembershipService");
const {
  createRosterActionService,
} = require("../../src/application/services/leagues/createRosterActionService");
const {
  createTeamWorkspaceService,
} = require("../../src/application/services/leagues/createTeamWorkspaceService");
const {
  validateTeamProfileInput,
} = require("../../src/domain/leagues/teamProfilePolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

const IDS = Object.freeze({
  activity: "11111111-1111-4111-8111-111111111111",
  actor: "22222222-2222-4222-8222-222222222222",
  buyout: "33333333-3333-4333-8333-333333333333",
  commissionerMembership: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  contract: "44444444-4444-4444-8444-444444444444",
  league: "55555555-5555-4555-8555-555555555555",
  membership: "66666666-6666-4666-8666-666666666666",
  ownership: "77777777-7777-4777-8777-777777777777",
  player: "88888888-8888-4888-8888-888888888888",
  season: "99999999-9999-4999-8999-999999999999",
  team: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
});

function identifierSource() {
  let counter = 0;
  return {
    id() {
      counter += 1;
      return `${String(counter).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    },
  };
}

function workspacePlayer(overrides = {}) {
  return {
    ownership_id: IDS.ownership,
    ownership_version: 3,
    player_id: IDS.player,
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    source_payload_json: JSON.stringify({ Status: "Injured Reserve" }),
    contract_id: IDS.contract,
    contract_version: 4,
    remaining_contract_years: 2,
    ...overrides,
  };
}

function workspaceRecord(players = [workspacePlayer()]) {
  return {
    scope: {
      league_id: IDS.league,
      season_id: IDS.season,
      team_id: IDS.team,
    },
    players,
    cap: {
      capLimitCents: 10_000,
      capUsageCents: 200,
      complete: true,
    },
  };
}

function authorization() {
  return {
    leagueAuthorization: {
      requireCommissioner() {
        return {
          actorUserId: IDS.actor,
          authority: "commissioner",
          membershipId: IDS.commissionerMembership,
        };
      },
    },
    teamAuthorization: {
      requireManager() {
        return { actorUserId: IDS.actor, authority: "manager" };
      },
      requireTeamVisibility() {},
    },
  };
}

describe("M7-14 roster review actions", () => {
  test("accepts an optional canonical third team colour", () => {
    assert.deepEqual(
      validateTeamProfileInput({
        primaryColour: "#112233",
        secondaryColour: "#445566",
        tertiaryColour: "#778899",
      }).colours,
      {
        primaryColour: "#112233",
        secondaryColour: "#445566",
        tertiaryColour: "#778899",
      }
    );
    assert.throws(
      () =>
        validateTeamProfileInput({
          tertiaryColour: "#778899",
        }),
      { code: "TEAM_PROFILE_INPUT_INVALID" }
    );
  });

  test("moves only provider-eligible players into the first open IR slot", () => {
    let command = null;
    const { leagueAuthorization, teamAuthorization } = authorization();
    const service = createRosterActionService({
      leagueAuthorization,
      teamAuthorization,
      workspaceRepository: {
        read() {
          return workspaceRecord([
            workspacePlayer(),
            workspacePlayer({
              ownership_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              player_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              roster_category: "Injured Reserve",
              slot_number: 1,
            }),
          ]);
        },
      },
      rosterMovementRepository: {
        move(input) {
          command = input;
          return {
            ownership: {
              id: IDS.ownership,
              version: 4,
              roster_category: "Injured Reserve",
              slot_number: 2,
            },
          };
        },
      },
      buyoutRepository: { buyOut() {} },
      clock: { nowMs: () => 1_000 },
      secureRandom: identifierSource(),
    });

    const result = service.moveToInjuredReserve({
      authenticated: {},
      leagueId: IDS.league,
      teamId: IDS.team,
      ownershipId: IDS.ownership,
      input: { expectedVersion: 3 },
    });

    assert.equal(result.code, "PLAYER_MOVED_TO_INJURED_RESERVE");
    assert.equal(result.ownership.slotNumber, 2);
    assert.equal(command.destinationCategory, "Injured Reserve");
    assert.equal(command.destinationSlotNumber, 2);
    assert.equal(command.actorAuthority, "manager");
  });

  test("requires confirmation, then persists an over-limit Bench-to-Active move", () => {
    let command = null;
    const { leagueAuthorization, teamAuthorization } = authorization();
    const activeForwards = Array.from({ length: 12 }, (_, index) =>
      workspacePlayer({
        ownership_id:
          `${String(index + 1).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`,
        player_id:
          `${String(index + 101).padStart(8, "0")}-eeee-4eee-8eee-eeeeeeeeeeee`,
        slot_number: index + 1,
      })
    );
    const benchPlayer = workspacePlayer({
      ownership_id: IDS.ownership,
      player_id: IDS.player,
      roster_category: "Bench",
      slot_number: 1,
      contract_id: IDS.contract,
      aav_cents: 300,
    });
    const service = createRosterActionService({
      leagueAuthorization,
      teamAuthorization,
      workspaceRepository: {
        read: () => workspaceRecord([...activeForwards, benchPlayer]),
      },
      rosterMovementRepository: {
        move(input) {
          command = input;
          return {
            ownership: {
              id: IDS.ownership,
              version: 4,
              roster_category: "Active",
              slot_number: null,
            },
          };
        },
      },
      buyoutRepository: { buyOut() {} },
      clock: { nowMs: () => 1_000 },
      secureRandom: identifierSource(),
    });
    const request = {
      authenticated: {},
      leagueId: IDS.league,
      teamId: IDS.team,
      ownershipId: IDS.ownership,
      input: {
        confirmedIllegal: false,
        destinationCategory: "Active",
        expectedVersion: 3,
      },
    };

    assert.throws(
      () => service.moveRosterPlayer(request),
      { code: "ROSTER_ILLEGAL_CONFIRMATION_REQUIRED" }
    );
    const result = service.moveRosterPlayer({
      ...request,
      input: { ...request.input, confirmedIllegal: true },
    });

    assert.equal(result.code, "ROSTER_PLAYER_MOVED");
    assert.equal(result.legality.legal, false);
    assert.equal(command.destinationSlotNumber, null);
  });

  test("buys out the selected contract with its exact remaining term", () => {
    let command = null;
    const { leagueAuthorization, teamAuthorization } = authorization();
    const service = createRosterActionService({
      leagueAuthorization,
      teamAuthorization,
      workspaceRepository: { read: () => workspaceRecord() },
      rosterMovementRepository: { move() {} },
      buyoutRepository: {
        buyOut(input) {
          command = input;
          return {
            obligation: { id: IDS.buyout },
            annualPenaltyCents: 125,
            years: [{}, {}],
          };
        },
      },
      clock: { nowMs: () => 2_000 },
      secureRandom: identifierSource(),
    });

    const result = service.buyOutContract({
      authenticated: {},
      leagueId: IDS.league,
      teamId: IDS.team,
      contractId: IDS.contract,
      input: {
        confirmed: true,
        expectedContractVersion: 4,
        expectedOwnershipVersion: 3,
      },
    });

    assert.equal(result.code, "CONTRACT_BOUGHT_OUT");
    assert.equal(result.buyout.remainingYears, 2);
    assert.equal(command.contractId, IDS.contract);
    assert.equal(command.buyoutYearIds.length, 2);
    assert.equal(command.playerId, IDS.player);
  });

  test("persists an explicit trade-block flag with optimistic ownership versioning", () => {
    let command = null;
    const { leagueAuthorization, teamAuthorization } = authorization();
    const service = createTeamWorkspaceService({
      leagueAuthorization,
      teamAuthorization,
      repository: {
        read() {
          return workspaceRecord();
        },
        saveOrder() {},
        setTradeBlock(input) {
          command = input;
          return { id: IDS.ownership, version: 4, trade_blocked: 1 };
        },
      },
      clock: { nowMs: () => 3_000 },
      secureRandom: identifierSource(),
    });

    const result = service.setTradeBlock({
      authenticated: {},
      leagueId: IDS.league,
      teamId: IDS.team,
      ownershipId: IDS.ownership,
      input: { blocked: true, expectedVersion: 3 },
    });

    assert.equal(result.code, "PLAYER_ADDED_TO_TRADE_BLOCK");
    assert.equal(result.ownership.onTradeBlock, true);
    assert.equal(command.expectedVersion, 3);
    assert.equal(command.blocked, true);
  });

  test("clears a persisted trade-block flag when ownership transfers teams", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m7-14-"));
    const connection = openDatabase({
      databasePath: path.join(root, "review.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      if (connection.database.open) connection.database.close();
      fs.rmSync(root, { force: true, recursive: true });
    });
    migrateDatabase({
      database: connection.database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      applicationBuildId: "m7-14-review-test",
      now: () => 1,
    });
    const secondTeam = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    connection.database.prepare(`
      INSERT INTO leagues (
        id, name, name_normalized, status, timezone,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, 'Review League', 'review league', 'active',
        'America/Vancouver', 1, 1, 1)
    `).run(IDS.league);
    connection.database.prepare(`
      INSERT INTO seasons (
        id, league_id, label, nhl_season_key, status,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)
    `).run(IDS.season, IDS.league);
    const insertTeam = connection.database.prepare(`
      INSERT INTO teams (
        id, league_id, name, name_normalized, status,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)
    `);
    insertTeam.run(IDS.team, IDS.league, "First Team", "first team");
    insertTeam.run(secondTeam, IDS.league, "Second Team", "second team");
    connection.database.prepare(`
      INSERT INTO players (
        id, first_name, last_name, full_name, status,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, 'Review', 'Player', 'Review Player', 'active', 1, 1, 1)
    `).run(IDS.player);
    connection.database.prepare(`
      INSERT INTO player_ownerships (
        id, league_id, season_id, player_id, team_id, ownership_kind,
        roster_category, position_group, slot_number, trade_blocked,
        acquired_transaction_type, created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, 'Rostered', 'Active', 'F', 1, 1,
        'test', 1, 1, 1)
    `).run(
      IDS.ownership,
      IDS.league,
      IDS.season,
      IDS.player,
      IDS.team
    );

    connection.database
      .prepare(
        "UPDATE player_ownerships SET team_id = ?, version = version + 1 WHERE id = ?"
      )
      .run(secondTeam, IDS.ownership);

    const ownership = connection.database
      .prepare(
        "SELECT team_id, trade_blocked, version FROM player_ownerships WHERE id = ?"
      )
      .get(IDS.ownership);
    assert.deepEqual(ownership, {
      team_id: secondTeam,
      trade_blocked: 0,
      version: 2,
    });
  });
});

describe("M7-14 commissioner member removal", () => {
  test("ends the selected non-commissioner membership by exact version", () => {
    let command = null;
    const { leagueAuthorization } = authorization();
    const service = createLeagueMembershipService({
      leagueAuthorization,
      leagueAccessRepository: {
        listLeagueMemberships() {
          return [
            {
              membership_id: IDS.membership,
              permission_category: "manager",
              membership_status: "active",
              membership_version: 2,
            },
          ];
        },
        endMembership(input) {
          command = input;
          return {
            id: IDS.membership,
            status: "ended",
            ended_at_ms: 4_000,
            version: 3,
          };
        },
      },
      clock: { nowMs: () => 4_000 },
      secureRandom: { id: () => IDS.activity },
    });

    const result = service.remove({
      authenticated: {},
      leagueId: IDS.league,
      membershipId: IDS.membership,
      input: { confirmed: true, expectedVersion: 2 },
    });

    assert.equal(result.code, "LEAGUE_MEMBERSHIP_REMOVED");
    assert.equal(result.membership.status, "ended");
    assert.equal(command.membershipId, IDS.membership);
    assert.equal(command.expectedVersion, 2);
  });
});
