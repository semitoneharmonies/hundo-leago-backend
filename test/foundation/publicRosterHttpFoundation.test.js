const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createPublicRosterService,
} = require(
  "../../src/application/services/leagues/createPublicRosterService"
);
const {
  createPublicRosterRouter,
} = require("../../src/transport/http/createPublicRosterRouter");

const LEAGUE_ID = "00000000-0000-4000-8000-000000000010";
const TEAM_ID = "00000000-0000-4000-8000-000000000020";
const NOW_MS = Date.parse("2026-07-21T23:59:59.000Z");

function roster() {
  return Object.freeze({
    league: Object.freeze({ id: LEAGUE_ID, name: "League" }),
    season: Object.freeze({ id: LEAGUE_ID, label: "Season" }),
    team: Object.freeze({
      id: TEAM_ID,
      name: "Team",
      primaryColour: null,
      secondaryColour: null,
      logoReference: null,
    }),
    players: Object.freeze([]),
    cap: Object.freeze({
      capLimitCents: 10_000,
      capUsageCents: 0,
      capSpaceCents: 10_000,
      retainedSalaryTotalCents: 0,
      buyoutPenaltyTotalCents: 0,
    }),
    updatedAt: NOW_MS,
  });
}

function requestSecurity() {
  return {
    assignRequestId(request, response, next) {
      request.testRequestId = "m4-12-request";
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
    requireCompatibleFetchMetadata(request, response, next) {
      next();
    },
    getRequestId(request) {
      return request.testRequestId;
    },
  };
}

async function startApi(t, service) {
  const app = express();
  app.use(
    createPublicRosterRouter({
      requestSecurity: requestSecurity(),
      publicRosterService: service,
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

describe("M4-12 public roster application service", () => {
  test("uses an explicit clock date and returns the repository projection unchanged", () => {
    const calls = [];
    const projection = roster();
    const service = createPublicRosterService({
      publicRosterRepository: {
        read(input) {
          calls.push(input);
          return projection;
        },
      },
      clock: { nowMs: () => NOW_MS },
    });
    const result = service.read({ leagueId: LEAGUE_ID, teamId: TEAM_ID });
    assert.deepEqual(calls, [
      {
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
        asOfDate: "2026-07-21",
      },
    ]);
    assert.equal(result.code, "PUBLIC_ROSTER_FOUND");
    assert.equal(result.roster, projection);
    assert.equal(Object.isFrozen(result), true);
  });

  test("requires only the exact read repository and clock boundaries", () => {
    assert.throws(() => createPublicRosterService(), /public roster reads/);
    assert.throws(
      () =>
        createPublicRosterService({
          publicRosterRepository: { read() {} },
          clock: {},
        }),
      /a clock/
    );
  });
});

describe("M4-12 isolated public roster HTTP contract", () => {
  test("returns the safe read-only envelope without authentication", async (t) => {
    const service = {
      read(input) {
        assert.deepEqual(input, { leagueId: LEAGUE_ID, teamId: TEAM_ID });
        return { code: "PUBLIC_ROSTER_FOUND", roster: roster() };
      },
    };
    const baseUrl = await startApi(t, service);
    const response = await fetch(
      `${baseUrl}/api/v1/public/leagues/${LEAGUE_ID}/teams/${TEAM_ID}/roster`
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.data.code, "PUBLIC_ROSTER_FOUND");
    assert.deepEqual(body.data.roster, roster());
    assert.equal(body.meta.requestId, "m4-12-request");
    assert.equal(response.headers.get("set-cookie"), null);
  });

  test("maps malformed, hidden, and unexpected failures to safe errors", async (t) => {
    const codes = new Map([
      ["bad", "PUBLIC_ROSTER_INPUT_INVALID"],
      ["missing", "REPOSITORY_RECORD_NOT_FOUND"],
      ["failed", "UNEXPECTED"],
    ]);
    const baseUrl = await startApi(t, {
      read({ leagueId }) {
        const error = new Error("private detail");
        error.code = codes.get(leagueId);
        throw error;
      },
    });
    for (const [leagueId, status, code] of [
      ["bad", 400, "PUBLIC_ROSTER_REQUEST_INVALID"],
      ["missing", 404, "PUBLIC_ROSTER_NOT_FOUND"],
      ["failed", 500, "PUBLIC_ROSTER_READ_FAILED"],
    ]) {
      const response = await fetch(
        `${baseUrl}/api/v1/public/leagues/${leagueId}/teams/${TEAM_ID}/roster`
      );
      const body = await response.json();
      assert.equal(response.status, status);
      assert.equal(body.error.code, code);
      assert.equal(body.error.requestId, "m4-12-request");
      assert.equal(JSON.stringify(body).includes("private detail"), false);
    }
  });

  test("requires the complete target security and service boundaries", () => {
    assert.throws(
      () =>
        createPublicRosterRouter({
          requestSecurity: {},
          publicRosterService: { read() {} },
        }),
      /request-security boundary/
    );
    assert.throws(
      () =>
        createPublicRosterRouter({
          requestSecurity: requestSecurity(),
          publicRosterService: {},
        }),
      /public-roster service/
    );
  });
});
