const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createAuctionService,
} = require("../../src/application/services/auctions/createAuctionService");
const {
  createAuctionRouter,
  optionalIfMatch,
} = require("../../src/transport/http/createAuctionRouter");

const LEAGUE_ID = "00000000-0000-4000-8000-000000000001";
const SEASON_ID = "00000000-0000-4000-8000-000000000002";
const TEAM_ID = "00000000-0000-4000-8000-000000000003";
const PLAYER_ID = "00000000-0000-4000-8000-000000000004";
const AUCTION_ID = "00000000-0000-4000-8000-000000000005";
const BID_ID = "00000000-0000-4000-8000-000000000006";
const USER_ID = "00000000-0000-4000-8000-000000000007";
const MEMBERSHIP_ID = "00000000-0000-4000-8000-000000000008";
const NOW_MS = Date.parse("2026-07-21T19:00:00.000Z");

function idFactory() {
  let next = 100;
  return {
    id() {
      const id = `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
      next += 1;
      return id;
    },
  };
}

function writeResult(overrides = {}) {
  return {
    replayed: false,
    action: "edited",
    auction: {
      id: AUCTION_ID,
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      status: "open",
      openedAtMs: NOW_MS - 1,
      bidClosesAtMs: NOW_MS + 1,
    },
    bid: {
      id: BID_ID,
      teamId: TEAM_ID,
      totalValueCents: 600,
      termYears: 3,
      aavCents: 200,
      firstSubmittedAtMs: NOW_MS - 1,
      lastEditedAtMs: NOW_MS,
      editCount: 1,
      status: "active",
      version: 2,
    },
    ...overrides,
  };
}

function serviceDependencies(overrides = {}) {
  const calls = [];
  const managerAuthority = Object.freeze({
    actorUserId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    authority: "manager",
  });
  const commissionerAuthority = Object.freeze({
    actorUserId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    authority: "commissioner",
  });
  return {
    calls,
    dependencies: {
      leagueAuthorization: {
        requireActiveMembership() {
          return managerAuthority;
        },
        requireCommissioner() {
          return commissionerAuthority;
        },
      },
      teamAuthorization: {
        requireManager() {
          return managerAuthority;
        },
      },
      leagueAccessRepository: {
        findLeagueSummary() {
          return { current_season_id: SEASON_ID };
        },
      },
      auctionRepository: {
        startAuction(input) {
          calls.push({ method: "startAuction", input });
          return {
            replayed: false,
            auction: { id: AUCTION_ID, leagueId: LEAGUE_ID },
            openingBid: writeResult().bid,
            event: { id: BID_ID, type: "auction_started" },
          };
        },
      },
      auctionBidRepository: {
        listActive(input) {
          calls.push({ method: "listActive", input });
          return [];
        },
        readActive(input) {
          calls.push({ method: "readActive", input });
          return { id: AUCTION_ID, ownBid: null };
        },
        putBid(input) {
          calls.push({ method: "putBid", input });
          return writeResult();
        },
      },
      clock: { nowMs: () => NOW_MS },
      secureRandom: idFactory(),
      ...overrides,
    },
  };
}

function requestSecurity() {
  const session = Object.freeze({ user: { id: USER_ID }, session: { id: BID_ID } });
  return {
    assignRequestId(request, response, next) {
      request.testRequestId = "m5-02-request";
      next();
    },
    securityHeaders(request, response, next) {
      response.set("Cache-Control", "no-store");
      next();
    },
    credentialedCors(request, response, next) {
      next();
    },
    requireAllowedOrigin(request, response, next) {
      next();
    },
    requireJson(request, response, next) {
      next();
    },
    requireCompatibleFetchMetadata(request, response, next) {
      next();
    },
    authenticateBootstrap(request, response, next) {
      next();
    },
    authenticateUnsafe(request, response, next) {
      next();
    },
    getRequestId(request) {
      return request.testRequestId;
    },
    getSessionBootstrap() {
      return session;
    },
    getAuthenticatedSession() {
      return session;
    },
  };
}

async function startApi(t, auctionService) {
  const app = express();
  app.use(createAuctionRouter({ requestSecurity: requestSecurity(), auctionService }));
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

function auctionServiceStub(overrides = {}) {
  return {
    list() {
      return { code: "ACTIVE_AUCTIONS_FOUND", auctions: [] };
    },
    read() {
      return { code: "ACTIVE_AUCTION_FOUND", auction: { id: AUCTION_ID } };
    },
    start() {
      return { code: "AUCTION_STARTED", auction: { id: AUCTION_ID } };
    },
    putMine() {
      return { code: "AUCTION_BID_SUBMITTED", bid: { id: BID_ID } };
    },
    putAsCommissioner() {
      return { code: "AUCTION_BID_EDITED", bid: { id: BID_ID } };
    },
    ...overrides,
  };
}

describe("M5-02 auction application service", () => {
  test("passes authenticated read scope and exact manager bid authority", () => {
    const fixture = serviceDependencies();
    fixture.dependencies.leagueAuthorization.requireCommissioner = () => {
      const error = new Error("not commissioner");
      error.code = "LEAGUE_COMMISSIONER_REQUIRED";
      throw error;
    };
    const service = createAuctionService(fixture.dependencies);
    assert.equal(service.list({ leagueId: LEAGUE_ID, authenticated: {} }).code,
      "ACTIVE_AUCTIONS_FOUND");
    assert.equal(
      service.read({
        leagueId: LEAGUE_ID,
        auctionId: AUCTION_ID,
        authenticated: {},
      }).code,
      "ACTIVE_AUCTION_FOUND"
    );
    const result = service.putMine({
      leagueId: LEAGUE_ID,
      auctionId: AUCTION_ID,
      input: { teamId: TEAM_ID, totalValueCents: 600, termYears: 3 },
      expectedBidVersion: 1,
      idempotencyKey: "manager-edit",
      authenticated: {},
    });
    assert.equal(result.bid.totalValueCents, 600);
    const write = fixture.calls.find(({ method }) => method === "putBid").input;
    assert.equal(write.actorAuthority, "manager");
    assert.equal(write.expectedBidVersion, 1);
    assert.equal(write.occurredAtMs, NOW_MS);
    assert.equal(write.idempotencyExpiresAtMs, NOW_MS + 86_400_000);
  });

  test("never returns active values to a commissioner after start or replacement", () => {
    const fixture = serviceDependencies();
    const service = createAuctionService(fixture.dependencies);
    const started = service.start({
      leagueId: LEAGUE_ID,
      input: {
        teamId: TEAM_ID,
        playerId: PLAYER_ID,
        totalValueCents: 1_000,
        termYears: 3,
      },
      idempotencyKey: "commissioner-start",
      authenticated: {},
    });
    const edited = service.putAsCommissioner({
      leagueId: LEAGUE_ID,
      auctionId: AUCTION_ID,
      bidId: BID_ID,
      input: { teamId: TEAM_ID, totalValueCents: 600, termYears: 3 },
      expectedBidVersion: 1,
      idempotencyKey: "commissioner-edit",
      authenticated: {},
    });
    for (const result of [started, edited]) {
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("totalValueCents"), false);
      assert.equal(serialized.includes("termYears"), false);
      assert.equal(serialized.includes("aavCents"), false);
    }
    assert.deepEqual(Object.keys(edited.bid).sort(), ["id", "status", "teamId", "version"]);
    assert.equal(
      fixture.calls.filter(({ method }) => method === "putBid")[0].input.actorAuthority,
      "commissioner"
    );
  });

  test("requires every authorization, persistence, clock, and identifier boundary", () => {
    assert.throws(() => createAuctionService(), /auction service requires/);
  });
});

describe("M5-02 isolated auction HTTP contract", () => {
  test("routes list, detail, start, own bid, and commissioner bid without DELETE", async (t) => {
    const calls = [];
    const service = auctionServiceStub({
      list(input) {
        calls.push({ method: "list", input });
        return { code: "ACTIVE_AUCTIONS_FOUND", auctions: [] };
      },
      read(input) {
        calls.push({ method: "read", input });
        return { code: "ACTIVE_AUCTION_FOUND", auction: { id: AUCTION_ID } };
      },
      start(input) {
        calls.push({ method: "start", input });
        return { code: "AUCTION_STARTED", auction: { id: AUCTION_ID } };
      },
      putMine(input) {
        calls.push({ method: "putMine", input });
        return { code: "AUCTION_BID_EDITED", bid: { id: BID_ID } };
      },
      putAsCommissioner(input) {
        calls.push({ method: "putAsCommissioner", input });
        return { code: "AUCTION_BID_EDITED", bid: { id: BID_ID } };
      },
    });
    const baseUrl = await startApi(t, service);
    const requests = [
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions`),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}`),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "start" },
        body: JSON.stringify({
          teamId: TEAM_ID,
          playerId: PLAYER_ID,
          totalValueCents: 1_000,
          termYears: 3,
        }),
      }),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/mine`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "mine",
          "if-match": '"2"',
        },
        body: JSON.stringify({ teamId: TEAM_ID, totalValueCents: 600, termYears: 3 }),
      }),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/${BID_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "admin" },
        body: JSON.stringify({ teamId: TEAM_ID, totalValueCents: 500, termYears: 3 }),
      }),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map(({ status }) => status), [200, 200, 201, 200, 200]);
    assert.deepEqual(calls.map(({ method }) => method).sort(), [
      "list",
      "putAsCommissioner",
      "putMine",
      "read",
      "start",
    ].sort());
    assert.equal(
      calls.find(({ method }) => method === "putMine").input.expectedBidVersion,
      2
    );
    assert.equal(
      calls.find(({ method }) => method === "putAsCommissioner").input
        .expectedBidVersion,
      null
    );
    const withdrawn = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/${BID_ID}`,
      { method: "DELETE" }
    );
    assert.equal(withdrawn.status, 404);
  });

  test("maps malformed preconditions and private policy failures to safe responses", async (t) => {
    let calls = 0;
    const baseUrl = await startApi(t, auctionServiceStub({
      putMine() {
        calls += 1;
        const error = new Error("private active value");
        error.reasonCode = "AUCTION_BID_COOLDOWN_ACTIVE";
        throw error;
      },
    }));
    const malformed = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/mine`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": "2" },
        body: JSON.stringify({ teamId: TEAM_ID, totalValueCents: 600, termYears: 3 }),
      }
    );
    assert.equal(malformed.status, 400);
    assert.equal(calls, 0);
    const cooldown = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/mine`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: TEAM_ID, totalValueCents: 600, termYears: 3 }),
      }
    );
    const body = await cooldown.json();
    assert.equal(cooldown.status, 409);
    assert.equal(body.error.code, "AUCTION_BID_COOLDOWN_ACTIVE");
    assert.equal(body.error.requestId, "m5-02-request");
    assert.equal(JSON.stringify(body).includes("private active value"), false);
  });

  test("parses only optional strong numeric bid versions and requires full boundaries", () => {
    assert.deepEqual(optionalIfMatch({ get: () => undefined }), {
      valid: true,
      version: null,
    });
    assert.deepEqual(optionalIfMatch({ get: () => '"7"' }), {
      valid: true,
      version: 7,
    });
    assert.deepEqual(optionalIfMatch({ get: () => "7" }), {
      valid: false,
      version: null,
    });
    assert.throws(
      () => createAuctionRouter({ requestSecurity: {}, auctionService: auctionServiceStub() }),
      /request-security boundary/
    );
  });
});
