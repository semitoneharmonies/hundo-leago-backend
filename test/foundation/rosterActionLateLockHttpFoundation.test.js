const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createRosterActionService,
} = require("../../src/application/services/leagues/createRosterActionService");
const {
  createRosterActionRouter,
} = require("../../src/transport/http/createRosterActionRouter");

const IDS = Object.freeze({
  actor: "10000000-0000-4000-8000-000000000001",
  buyout: "10000000-0000-4000-8000-000000000009",
  contract: "10000000-0000-4000-8000-000000000002",
  league: "10000000-0000-4000-8000-000000000003",
  lock: "10000000-0000-4000-8000-000000000004",
  ownership: "10000000-0000-4000-8000-000000000005",
  player: "10000000-0000-4000-8000-000000000006",
  season: "10000000-0000-4000-8000-000000000007",
  team: "10000000-0000-4000-8000-000000000008",
});
const REQUEST_ID = "fad-roster-late-lock-http";

function middleware(request, response, next) {
  next();
}

function requestSecurity() {
  return {
    assignRequestId: middleware,
    authenticateUnsafe: middleware,
    credentialedCors: middleware,
    getAuthenticatedSession() {
      return { user: { id: IDS.actor }, valid: true };
    },
    getRequestId() {
      return REQUEST_ID;
    },
    requireAllowedOrigin: middleware,
    requireCompatibleFetchMetadata: middleware,
    requireJson: middleware,
    securityHeaders: middleware,
  };
}

function workspace() {
  return {
    scope: {
      league_id: IDS.league,
      season_id: IDS.season,
      team_id: IDS.team,
    },
    players: [
      {
        ownership_id: IDS.ownership,
        ownership_version: 3,
        player_id: IDS.player,
        roster_category: "Active",
        position_group: "F",
        slot_number: 1,
        source_payload_json: JSON.stringify({ Status: "Injured Reserve" }),
        contract_id: IDS.contract,
        contract_version: 2,
        remaining_contract_years: 2,
        aav_cents: 200,
        retained_aav_cents: 0,
      },
    ],
    cap: {
      capLimitCents: 10_000,
      capUsageCents: 200,
      complete: true,
    },
  };
}

function createService({
  coordinateCommittedRoster,
  move,
  buyOut = () => {
    throw new Error("buyout is outside this scenario");
  },
}) {
  return createRosterActionService({
    leagueAuthorization: {
      requireCommissioner() {
        throw new Error("commissioner fallback is outside this test");
      },
    },
    teamAuthorization: {
      requireManager() {
        return { actorUserId: IDS.actor, authority: "manager" };
      },
    },
    workspaceRepository: { read: workspace },
    rosterMovementRepository: { move },
    buyoutRepository: { buyOut },
    lateLockCoordinator: { coordinateCommittedRoster },
    clock: { nowMs: () => 1_900_000_000_000 },
    secureRandom: { id: () => "20000000-0000-4000-8000-000000000001" },
  });
}

async function startApi(t, rosterActionService) {
  const app = express();
  app.use(
    createRosterActionRouter({
      requestSecurity: requestSecurity(),
      rosterActionService,
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function moveUrl(baseUrl, suffix = "move") {
  return `${baseUrl}/api/v1/leagues/${IDS.league}/teams/${IDS.team}/roster/${IDS.ownership}/${suffix}`;
}

function buyoutUrl(baseUrl) {
  return `${baseUrl}/api/v1/leagues/${IDS.league}/teams/${IDS.team}/contracts/${IDS.contract}/buyout`;
}

function post(url, input) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

function legality(destinationCategory) {
  return {
    legal: true,
    counts: {
      activeForwards: 0,
      activeDefence: 0,
      activeUnsupported: 0,
      active: 0,
      bench: destinationCategory === "Bench" ? 1 : 0,
      injuredReserve: destinationCategory === "Injured Reserve" ? 1 : 0,
      prospects: 0,
      total: 1,
    },
    limits: {
      activeForwards: 12,
      activeDefence: 6,
      active: 18,
      bench: 4,
      injuredReserve: 4,
      prospects: null,
    },
    cap: {
      limitCents: 10_000,
      usageCents: 0,
      spaceCents: 10_000,
      complete: true,
    },
    reasons: [],
  };
}

function movedOwnership(destinationCategory) {
  return {
    id: IDS.ownership,
    version: 4,
    rosterCategory: destinationCategory,
    slotNumber: 1,
  };
}

function committedMovement(command) {
  const ownership = Object.freeze({
    id: IDS.ownership,
    version: 4,
    roster_category: command.destinationCategory,
    slot_number: command.destinationSlotNumber,
  });
  return Object.freeze({
    ownership,
    affectedOwnerships: Object.freeze([ownership]),
  });
}

describe("roster-action late-lock HTTP boundary", () => {
  test("awaits ordinary and injured-reserve coordination and returns exact safe success envelopes", async (t) => {
    const mutations = [];
    const service = createService({
      move(command) {
        return committedMovement(command);
      },
      async coordinateCommittedRoster(batch) {
        await Promise.resolve();
        mutations.push(batch.mutationKind);
        return batch.mutationKind === "roster_move"
          ? { status: "completed", lockId: IDS.lock }
          : { status: "not_applicable" };
      },
    });
    const baseUrl = await startApi(t, service);

    const moved = await post(moveUrl(baseUrl), {
      confirmedIllegal: false,
      destinationCategory: "Bench",
      expectedVersion: 3,
    });
    assert.equal(moved.status, 200);
    assert.deepEqual(await moved.json(), {
      data: {
        code: "ROSTER_PLAYER_MOVED",
        legality: legality("Bench"),
        ownership: movedOwnership("Bench"),
        lateLock: { status: "completed", lockId: IDS.lock },
      },
      meta: { requestId: REQUEST_ID },
    });

    const movedToIr = await post(moveUrl(baseUrl, "move-to-ir"), {
      expectedVersion: 3,
    });
    assert.equal(movedToIr.status, 200);
    assert.deepEqual(await movedToIr.json(), {
      data: {
        code: "PLAYER_MOVED_TO_INJURED_RESERVE",
        legality: legality("Injured Reserve"),
        ownership: movedOwnership("Injured Reserve"),
        lateLock: { status: "not_applicable" },
      },
      meta: { requestId: REQUEST_ID },
    });
    assert.deepEqual(mutations, ["roster_move", "injured_reserve_move"]);
  });

  test("keeps a committed move successful when late-lock coordination rejects", async (t) => {
    let moveCalls = 0;
    const service = createService({
      move(command) {
        moveCalls += 1;
        return committedMovement(command);
      },
      async coordinateCommittedRoster() {
        throw new Error("private late-lock failure");
      },
    });
    const baseUrl = await startApi(t, service);

    const response = await post(moveUrl(baseUrl), {
      confirmedIllegal: false,
      destinationCategory: "Bench",
      expectedVersion: 3,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(moveCalls, 1);
    assert.deepEqual(body.data.lateLock, { status: "awaiting_data" });
    assert.equal(JSON.stringify(body).includes("private"), false);
  });

  test("awaits buyout deletion coordination and returns its safe projection", async (t) => {
    let coordinatedBatch = null;
    const service = createService({
      move() {
        throw new Error("move is outside this scenario");
      },
      buyOut() {
        return {
          obligation: { id: IDS.buyout },
          annualPenaltyCents: 125,
          years: [{}, {}],
          releasedOwnership: {
            id: IDS.ownership,
            version: 3,
          },
        };
      },
      async coordinateCommittedRoster(batch) {
        coordinatedBatch = batch;
        return { status: "completed", lockId: IDS.lock };
      },
    });
    const baseUrl = await startApi(t, service);

    const response = await post(buyoutUrl(baseUrl), {
      confirmed: true,
      expectedContractVersion: 2,
      expectedOwnershipVersion: 3,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: {
        code: "CONTRACT_BOUGHT_OUT",
        buyout: {
          id: IDS.buyout,
          annualPenaltyCents: 125,
          remainingYears: 2,
        },
        lateLock: { status: "completed", lockId: IDS.lock },
      },
      meta: { requestId: REQUEST_ID },
    });
    assert.deepEqual(coordinatedBatch, {
      mutationKind: "buyout",
      teams: [
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          teamId: IDS.team,
          ownershipWitnesses: [
            {
              ownershipId: IDS.ownership,
              ownershipVersion: 3,
              state: "deleted",
            },
          ],
        },
      ],
    });
  });

  test("maps a precommit repository conflict and never invokes coordination", async (t) => {
    let coordinatorCalls = 0;
    const service = createService({
      move() {
        const error = new Error("private stale row detail");
        error.code = "REPOSITORY_VERSION_CONFLICT";
        throw error;
      },
      coordinateCommittedRoster() {
        coordinatorCalls += 1;
        return { status: "completed", lockId: IDS.lock };
      },
    });
    const baseUrl = await startApi(t, service);

    const response = await post(moveUrl(baseUrl), {
      confirmedIllegal: false,
      destinationCategory: "Bench",
      expectedVersion: 3,
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(coordinatorCalls, 0);
    assert.deepEqual(body, {
      error: {
        code: "ROSTER_ACTION_CONFLICT",
        message: "The roster changed before this action could be completed.",
        requestId: REQUEST_ID,
      },
    });
    assert.equal(JSON.stringify(body).includes("private"), false);
  });
});
