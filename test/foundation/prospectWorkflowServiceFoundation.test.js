const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createRosterActionService,
} = require("../../src/application/services/leagues/createRosterActionService");

const IDS = Object.freeze({
  actor: "10000000-0000-4000-8000-000000000001",
  contract: "10000000-0000-4000-8000-000000000002",
  league: "10000000-0000-4000-8000-000000000003",
  otherTeam: "10000000-0000-4000-8000-000000000004",
  ownership: "10000000-0000-4000-8000-000000000005",
  player: "10000000-0000-4000-8000-000000000006",
  season1: "10000000-0000-4000-8000-000000000007",
  season2: "10000000-0000-4000-8000-000000000008",
  season3: "10000000-0000-4000-8000-000000000009",
  team: "10000000-0000-4000-8000-000000000010",
  trade: "10000000-0000-4000-8000-000000000011",
});

function player(overrides = {}) {
  return {
    ownership_id: IDS.ownership,
    ownership_version: 1,
    ownership_kind: "Prospect Right",
    player_id: IDS.player,
    roster_category: "Prospect",
    position_group: "F",
    slot_number: null,
    source_payload_json: JSON.stringify({ Status: "Injured Reserve" }),
    contract_id: null,
    contract_type: null,
    aav_cents: null,
    retained_aav_cents: 0,
    ...overrides,
  };
}

function workspace(players = [player()]) {
  return {
    scope: {
      league_id: IDS.league,
      season_id: IDS.season1,
      team_id: IDS.team,
    },
    players,
    cap: {
      capLimitCents: 10_000,
      capUsageCents: 0,
      complete: true,
    },
  };
}

function idSource() {
  let value = 0;
  return {
    id() {
      value += 1;
      return `90000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
    },
  };
}

function signingResult(command) {
  return {
    ownership: {
      id: command.ownershipId,
      version: command.expectedOwnershipVersion + 1,
      roster_category: command.destinationCategory,
      slot_number: command.destinationSlotNumber,
    },
    contract: {
      id: command.contractId,
      version: 1,
      contract_type: "fantasy_elc",
      aav_cents: 100,
      original_term_years: 3,
    },
    automaticallyCancelledTradeIds: [IDS.trade],
  };
}

function createService({
  record = workspace(),
  requireManager = () => ({
    actorUserId: IDS.actor,
    authority: "manager",
  }),
  signFantasyElc = signingResult,
  releaseUnsignedRights = (command) => ({
    releasedOwnership: {
      id: command.ownershipId,
      version: command.expectedOwnershipVersion,
    },
    automaticallyCancelledTradeIds: [IDS.trade],
  }),
  move = () => {
    throw new Error("movement is outside this scenario");
  },
  coordinateCommittedRoster = () => ({ status: "not_applicable" }),
  seasons = [
    { id: IDS.season3, nhl_season_key: "20282029" },
    { id: IDS.season1, nhl_season_key: "20262027" },
    { id: IDS.season2, nhl_season_key: "20272028" },
  ],
} = {}) {
  return createRosterActionService({
    leagueAuthorization: {
      requireCommissioner() {
        throw new Error("commissioner fallback is outside this scenario");
      },
    },
    teamAuthorization: { requireManager },
    workspaceRepository: { read: () => record },
    rosterMovementRepository: { move },
    prospectDecisionRepository: {
      signFantasyElc,
      releaseUnsignedRights,
    },
    seasonRepository: { listByLeague: () => seasons },
    buyoutRepository: {
      buyOut() {
        throw new Error("buyout is outside this scenario");
      },
    },
    lateLockCoordinator: { coordinateCommittedRoster },
    clock: { nowMs: () => 1_900_000_000_000 },
    secureRandom: idSource(),
  });
}

describe("manager prospect workflow service", () => {
  test("signs one ELC while the player remains a cap-exempt Prospect", async () => {
    let command;
    let coordination;
    const service = createService({
      signFantasyElc(input) {
        command = input;
        return signingResult(input);
      },
      coordinateCommittedRoster(input) {
        coordination = input;
        return { status: "completed", lockId: IDS.contract };
      },
    });

    const result = await service.signProspect({
      authenticated: { user: { id: IDS.actor } },
      leagueId: IDS.league,
      teamId: IDS.team,
      playerId: IDS.player,
      input: { destinationCategory: "Prospect", expectedVersion: 1 },
    });

    assert.deepEqual(command.seasonIds, [
      IDS.season1,
      IDS.season2,
      IDS.season3,
    ]);
    assert.deepEqual(
      [
        command.destinationCategory,
        command.destinationPositionGroup,
        command.destinationSlotNumber,
        command.actorAuthority,
      ],
      ["Prospect", "F", null, "manager"]
    );
    assert.equal(result.code, "PROSPECT_FANTASY_ELC_SIGNED");
    assert.equal(result.contract.aavCents, 100);
    assert.equal(result.contract.termYears, 3);
    assert.deepEqual(result.automaticallyCancelledTradeIds, [IDS.trade]);
    assert.equal(coordination.mutationKind, "prospect_signing");
  });

  test("signs directly to an eligible IR slot and rejects an illegal Active destination", async () => {
    let command;
    const eligible = createService({
      signFantasyElc(input) {
        command = input;
        return signingResult(input);
      },
    });
    const signed = await eligible.signProspect({
      authenticated: {},
      leagueId: IDS.league,
      teamId: IDS.team,
      playerId: IDS.player,
      input: {
        destinationCategory: "Injured Reserve",
        expectedVersion: 1,
      },
    });
    assert.equal(command.destinationSlotNumber, 1);
    assert.deepEqual(signed.automaticallyCancelledTradeIds, [IDS.trade]);

    const fullActive = Array.from({ length: 12 }, (_, index) =>
      player({
        ownership_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        player_id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ownership_kind: "Rostered",
        roster_category: "Active",
        slot_number: index + 1,
        contract_id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        contract_type: "standard",
        aav_cents: 100,
      })
    );
    let writes = 0;
    const illegal = createService({
      record: workspace([player(), ...fullActive]),
      signFantasyElc() {
        writes += 1;
      },
    });
    await assert.rejects(
      illegal.signProspect({
        authenticated: {},
        leagueId: IDS.league,
        teamId: IDS.team,
        playerId: IDS.player,
        input: { destinationCategory: "Active", expectedVersion: 1 },
      }),
      { code: "PROSPECT_DESTINATION_ILLEGAL" }
    );
    assert.equal(writes, 0);
  });

  test("declines an ELC and voluntarily releases rights as distinct confirmed decisions", async () => {
    const commands = [];
    const batches = [];
    const service = createService({
      releaseUnsignedRights(command) {
        commands.push(command);
        return {
          releasedOwnership: {
            id: command.ownershipId,
            version: command.expectedOwnershipVersion,
          },
          automaticallyCancelledTradeIds: [IDS.trade],
        };
      },
      coordinateCommittedRoster(batch) {
        batches.push(batch);
        return { status: "not_applicable" };
      },
    });
    for (const method of ["declineProspectElc", "releaseProspectRights"]) {
      const result = await service[method]({
        authenticated: {},
        leagueId: IDS.league,
        teamId: IDS.team,
        playerId: IDS.player,
        input: { confirmed: true, expectedVersion: 1 },
      });
      assert.deepEqual(result.automaticallyCancelledTradeIds, [IDS.trade]);
    }
    assert.deepEqual(
      commands.map(({ decision }) => decision),
      ["decline_elc", "release_unsigned_rights"]
    );
    assert.deepEqual(
      batches.map(({ mutationKind }) => mutationKind),
      ["prospect_release", "prospect_release"]
    );
  });

  test("promotes only a signed fantasy-ELC Prospect and never accepts illegal confirmation", async () => {
    let movement;
    let batch;
    const signed = player({
      ownership_version: 2,
      ownership_kind: "Prospect Right",
      contract_id: IDS.contract,
      contract_type: "fantasy_elc",
      aav_cents: 100,
    });
    const service = createService({
      record: workspace([signed]),
      move(command) {
        movement = command;
        return {
          ownership: {
            id: IDS.ownership,
            version: 3,
            roster_category: "Bench",
            slot_number: 1,
          },
          affectedOwnerships: [
            {
              id: IDS.ownership,
              version: 3,
              roster_category: "Bench",
              slot_number: 1,
            },
          ],
          automaticallyCancelledTradeIds: [IDS.trade],
        };
      },
      coordinateCommittedRoster(value) {
        batch = value;
        return { status: "not_applicable" };
      },
    });
    const promoted = await service.moveRosterPlayer({
      authenticated: {},
      leagueId: IDS.league,
      teamId: IDS.team,
      ownershipId: IDS.ownership,
      input: {
        confirmedIllegal: false,
        destinationCategory: "Bench",
        expectedVersion: 2,
      },
    });
    assert.equal(movement.expectedSourceCategory, "Prospect");
    assert.equal(batch.mutationKind, "prospect_activation");
    assert.deepEqual(
      promoted.automaticallyCancelledTradeIds,
      [IDS.trade]
    );
    await assert.rejects(
      service.moveRosterPlayer({
        authenticated: {},
        leagueId: IDS.league,
        teamId: IDS.team,
        ownershipId: IDS.ownership,
        input: {
          confirmedIllegal: false,
          destinationCategory: "Prospect",
          expectedVersion: 2,
        },
      }),
      { code: "ROSTER_ACTION_INPUT_INVALID" }
    );

    let illegalWrites = 0;
    const overCap = createService({
      record: {
        ...workspace([signed]),
        cap: { capLimitCents: 50, capUsageCents: 0, complete: true },
      },
      move() {
        illegalWrites += 1;
      },
    });
    await assert.rejects(
      overCap.moveRosterPlayer({
        authenticated: {},
        leagueId: IDS.league,
        teamId: IDS.team,
        ownershipId: IDS.ownership,
        input: {
          confirmedIllegal: true,
          destinationCategory: "Active",
          expectedVersion: 2,
        },
      }),
      { code: "PROSPECT_DESTINATION_ILLEGAL" }
    );
    assert.equal(illegalWrites, 0);
  });

  test("requires exact team-manager authority before any cross-team read or write", async () => {
    let writes = 0;
    const denied = Object.assign(new Error("manager required"), {
      code: "TEAM_MANAGER_REQUIRED",
    });
    const service = createService({
      requireManager(_authenticated, leagueId, teamId) {
        assert.equal(leagueId, IDS.league);
        assert.equal(teamId, IDS.otherTeam);
        throw denied;
      },
      signFantasyElc() {
        writes += 1;
      },
    });
    await assert.rejects(
      service.signProspect({
        authenticated: {},
        leagueId: IDS.league,
        teamId: IDS.otherTeam,
        playerId: IDS.player,
        input: { destinationCategory: "Prospect", expectedVersion: 1 },
      }),
      { code: "TEAM_MANAGER_REQUIRED" }
    );
    assert.equal(writes, 0);
  });
});
