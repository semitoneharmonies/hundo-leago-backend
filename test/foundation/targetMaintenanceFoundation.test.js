const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const express = require("express");

const {
  createLeagueWriteGate,
} = require("../../src/application/services/operations/createLeagueWriteGate");
const {
  TARGET_ROUTER_KEYS,
  createTargetApplication,
} = require("../../src/bootstrap/createTargetRuntime");

const ORIGIN = "https://staging-hundo.netlify.app";

function markerRouters(calls) {
  return Object.freeze(
    Object.fromEntries(
      TARGET_ROUTER_KEYS.map((key) => [
        key,
        (request, response) => {
          calls.push({ key, method: request.method, path: request.path });
          response.status(204).end();
        },
      ])
    )
  );
}

async function start(t, app) {
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

function appForMode(calls, mode) {
  return createTargetApplication({
    routers: markerRouters(calls),
    leagueWriteGate: createLeagueWriteGate({
      mode,
      isAllowedOrigin: (origin) => origin === ORIGIN,
    }),
    expressModule: express,
  });
}

describe("M7-03 target maintenance write closure", () => {
  test("closed mode blocks every league mutation before target routing", async (t) => {
    const calls = [];
    const baseUrl = await start(t, appForMode(calls, "closed"));
    for (const [method, pathname] of [
      ["POST", "/api/v1/accounts"],
      ["PUT", "/api/v1/leagues/00000000-0000-4000-8000-000000000001/auctions/00000000-0000-4000-8000-000000000002/bids/mine"],
      ["PATCH", "/api/v1/leagues/00000000-0000-4000-8000-000000000001/auctions/00000000-0000-4000-8000-000000000002/bids/00000000-0000-4000-8000-000000000003"],
      ["DELETE", "/api/v1/leagues/00000000-0000-4000-8000-000000000001/teams/00000000-0000-4000-8000-000000000002/manager-assignment"],
    ]) {
      const response = await fetch(new URL(pathname, baseUrl), {
        method,
        headers: { Origin: ORIGIN },
      });
      assert.equal(response.status, 503, `${method} ${pathname}`);
      assert.deepEqual(await response.json(), {
        error: {
          code: "LEAGUE_WRITES_CLOSED",
          message: "League changes are temporarily unavailable.",
        },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(calls, []);
  });

  test("closed mode preserves reads and only sign-in/sign-out session mutations", async (t) => {
    const calls = [];
    const baseUrl = await start(t, appForMode(calls, "closed"));
    for (const [method, pathname] of [
      ["GET", "/api/v1/leagues"],
      ["POST", "/api/v1/session"],
      ["DELETE", "/api/v1/session"],
    ]) {
      const response = await fetch(new URL(pathname, baseUrl), {
        method,
        headers: { Origin: ORIGIN },
      });
      assert.equal(response.status, 204, `${method} ${pathname}`);
    }
    assert.deepEqual(
      calls.map(({ method, path }) => `${method} ${path}`),
      ["GET /api/v1/leagues", "POST /api/v1/session", "DELETE /api/v1/session"]
    );
  });

  test("disallowed origins still reach normal security and open mode preserves routing", async (t) => {
    const closedCalls = [];
    const closedUrl = await start(t, appForMode(closedCalls, "closed"));
    const disallowed = await fetch(new URL("/api/v1/accounts", closedUrl), {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(disallowed.status, 204);
    assert.equal(closedCalls.length, 1);

    const openCalls = [];
    const openUrl = await start(t, appForMode(openCalls, "open"));
    const open = await fetch(new URL("/api/v1/accounts", openUrl), {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    assert.equal(open.status, 204);
    assert.equal(openCalls.length, 1);
  });
});
