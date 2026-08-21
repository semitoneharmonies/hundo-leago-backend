const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createRosterActionRouter,
} = require("../../src/transport/http/createRosterActionRouter");

const IDS = Object.freeze({
  actor: "10000000-0000-4000-8000-000000000001",
  league: "10000000-0000-4000-8000-000000000002",
  player: "10000000-0000-4000-8000-000000000003",
  team: "10000000-0000-4000-8000-000000000004",
  trade: "10000000-0000-4000-8000-000000000005",
  ownership: "10000000-0000-4000-8000-000000000006",
});

function middleware(_request, _response, next) {
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
      return "prospect-http-request";
    },
    requireAllowedOrigin: middleware,
    requireCompatibleFetchMetadata: middleware,
    requireJson: middleware,
    securityHeaders: middleware,
  };
}

function service(overrides = {}) {
  const outside = () => {
    throw new Error("outside this route scenario");
  };
  return {
    buyOutContract: outside,
    declineProspectElc: outside,
    moveRosterPlayer: outside,
    moveToInjuredReserve: outside,
    releaseProspectRights: outside,
    signProspect: outside,
    ...overrides,
  };
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

async function request(baseUrl, suffix, method, body) {
  const response = await fetch(
    `${baseUrl}/api/v1/leagues/${IDS.league}/teams/${IDS.team}/${suffix}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return { response, payload: await response.json() };
}

describe("manager prospect workflow HTTP boundary", () => {
  test("routes sign, decline, and voluntary release with only stable route scope and exact bodies", async (t) => {
    const calls = [];
    const baseUrl = await startApi(
      t,
      service({
        signProspect(input) {
          calls.push(["sign", input]);
          return {
            code: "PROSPECT_FANTASY_ELC_SIGNED",
            automaticallyCancelledTradeIds: [IDS.trade],
          };
        },
        declineProspectElc(input) {
          calls.push(["decline", input]);
          return {
            code: "PROSPECT_FANTASY_ELC_DECLINED",
            automaticallyCancelledTradeIds: [IDS.trade],
          };
        },
        releaseProspectRights(input) {
          calls.push(["release", input]);
          return {
            code: "PROSPECT_RIGHTS_RELEASED",
            automaticallyCancelledTradeIds: [IDS.trade],
          };
        },
      })
    );

    const inputs = [
      [
        `prospects/${IDS.player}/sign`,
        "POST",
        { destinationCategory: "Prospect", expectedVersion: 1 },
      ],
      [
        `prospects/${IDS.player}/decline`,
        "POST",
        { confirmed: true, expectedVersion: 1 },
      ],
      [
        `prospect-rights/${IDS.player}`,
        "DELETE",
        { confirmed: true, expectedVersion: 1 },
      ],
    ];
    const payloads = [];
    for (const input of inputs) {
      const { response, payload } = await request(baseUrl, ...input);
      assert.equal(response.status, 200);
      payloads.push(payload);
    }
    assert.deepEqual(
      payloads.map(({ data }) =>
        data.automaticallyCancelledTradeIds
      ),
      [[IDS.trade], [IDS.trade], [IDS.trade]]
    );
    assert.deepEqual(
      calls.map(([kind, input]) => [
        kind,
        input.leagueId,
        input.teamId,
        input.playerId,
        input.input,
      ]),
      [
        ["sign", IDS.league, IDS.team, IDS.player, inputs[0][2]],
        ["decline", IDS.league, IDS.team, IDS.player, inputs[1][2]],
        ["release", IDS.league, IDS.team, IDS.player, inputs[2][2]],
      ]
    );
  });

  test("maps destination illegality and manager-authority denial without false success", async (t) => {
    const illegalBaseUrl = await startApi(
      t,
      service({
        signProspect() {
          const error = new Error("illegal");
          error.name = "RosterActionConflictError";
          error.code = "PROSPECT_DESTINATION_ILLEGAL";
          error.details = { legality: { legal: false, reasons: [] } };
          throw error;
        },
      })
    );
    const illegal = await request(
      illegalBaseUrl,
      `prospects/${IDS.player}/sign`,
      "POST",
      { destinationCategory: "Active", expectedVersion: 1 }
    );
    assert.equal(illegal.response.status, 409);
    assert.equal(illegal.payload.error.code, "PROSPECT_DESTINATION_ILLEGAL");

    const deniedBaseUrl = await startApi(
      t,
      service({
        releaseProspectRights() {
          throw Object.assign(new Error("denied"), {
            code: "TEAM_MANAGER_REQUIRED",
          });
        },
      })
    );
    const denied = await request(
      deniedBaseUrl,
      `prospect-rights/${IDS.player}`,
      "DELETE",
      { confirmed: true, expectedVersion: 1 }
    );
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.error.code, "TEAM_MANAGER_REQUIRED");
  });

  test("returns signed-Prospect activation cancellation receipts through the normal move route", async (t) => {
    let call;
    const baseUrl = await startApi(
      t,
      service({
        moveRosterPlayer(input) {
          call = input;
          return {
            code: "ROSTER_PLAYER_MOVED",
            automaticallyCancelledTradeIds: [IDS.trade],
          };
        },
      })
    );
    const body = {
      confirmedIllegal: false,
      destinationCategory: "Bench",
      expectedVersion: 2,
    };
    const { response, payload } = await request(
      baseUrl,
      `roster/${IDS.ownership}/move`,
      "POST",
      body
    );
    assert.equal(response.status, 200);
    assert.deepEqual(payload.data.automaticallyCancelledTradeIds, [IDS.trade]);
    assert.deepEqual(
      [call.leagueId, call.teamId, call.ownershipId, call.input],
      [IDS.league, IDS.team, IDS.ownership, body]
    );
  });
});
