const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createTradeRouter,
  emptyObject,
} = require("../../src/transport/http/createTradeRouter");

const LEAGUE_ID = "00000000-0000-4000-8000-000000000001";
const TRADE_ID = "00000000-0000-4000-8000-000000000002";

function requestSecurity(calls) {
  const session = Object.freeze({ user: { id: "user" }, session: { id: "session" } });
  return {
    assignRequestId(request, response, next) {
      request.testRequestId = "m5-11-request";
      next();
    },
    securityHeaders(request, response, next) {
      response.set("Cache-Control", "no-store");
      next();
    },
    credentialedCors(request, response, next) { next(); },
    requireAllowedOrigin(request, response, next) { next(); },
    requireJson(request, response, next) { next(); },
    requireCompatibleFetchMetadata(request, response, next) { next(); },
    authenticateBootstrap(request, response, next) {
      calls.push("authenticateBootstrap");
      if (request.get("x-test-session") !== "valid") {
        return response.status(401).json({ error: { code: "AUTH_REQUIRED" } });
      }
      return next();
    },
    authenticateUnsafe(request, response, next) {
      calls.push("authenticateUnsafe");
      if (
        request.get("x-test-session") !== "valid" ||
        request.get("x-test-csrf") !== "valid"
      ) {
        return response.status(403).json({ error: { code: "CSRF_REQUIRED" } });
      }
      return next();
    },
    getRequestId(request) { return request.testRequestId; },
    getSessionBootstrap() { return session; },
    getAuthenticatedSession() { return session; },
  };
}

function services(calls, overrides = {}) {
  function record(method, result) {
    return (input) => {
      calls.push({ method, input });
      return { code: result };
    };
  }
  return {
    tradeReadService: { read: record("read", "TRADE_PROPOSAL_FOUND") },
    tradeProposalService: { list: record("list", "TRADE_PROPOSALS_FOUND") },
    tradeCreationService: { create: record("create", "TRADE_PROPOSAL_CREATED") },
    tradeLifecycleService: { respond: record("respond", "TRADE_PROPOSAL_UPDATED") },
    tradeAcceptancePreviewService: {
      preview: record("acceptancePreview", "TRADE_ACCEPTANCE_PREVIEWED"),
    },
    tradeAcceptanceService: { accept: record("accept", "TRADE_ACCEPTED") },
    ...overrides,
  };
}

async function startApi(t, stubs, securityCalls = []) {
  const app = express();
  app.use(createTradeRouter({
    requestSecurity: requestSecurity(securityCalls),
    ...stubs,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    "x-test-session": "valid",
    "x-test-csrf": "valid",
    ...extra,
  };
}

describe("M5-11 isolated trade HTTP contract", () => {
  test("routes all seven list, detail, proposal, preview, and lifecycle operations", async (t) => {
    const calls = [];
    const securityCalls = [];
    const baseUrl = await startApi(t, services(calls), securityCalls);
    const collection = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/trades`;
    const detail = `${collection}/${TRADE_ID}`;
    const proposal = {
      proposingTeamId: LEAGUE_ID,
      receivingTeamId: TRADE_ID,
      proposingAssets: [{ type: "contract", contractId: TRADE_ID }],
      receivingAssets: [{ type: "prospect_right", playerId: LEAGUE_ID }],
    };
    const responses = [];
    responses.push(await fetch(collection, { headers: { "x-test-session": "valid" } }));
    responses.push(await fetch(collection, {
      method: "POST",
      headers: headers({ "idempotency-key": "create-1" }),
      body: JSON.stringify(proposal),
    }));
    responses.push(await fetch(detail, { headers: { "x-test-session": "valid" } }));
    responses.push(await fetch(`${detail}/acceptance-preview`, {
      headers: { "x-test-session": "valid" },
    }));
    for (const [path, key] of [
      ["accept", "accept-1"],
      ["decline", "decline-1"],
      ["cancel", "cancel-1"],
    ]) {
      responses.push(await fetch(`${detail}/${path}`, {
        method: "POST",
        headers: headers({ "idempotency-key": key }),
        body: "{}",
      }));
    }

    assert.deepEqual(responses.map(({ status }) => status), [200, 201, 200, 200, 200, 200, 200]);
    assert.deepEqual(calls.map(({ method }) => method), [
      "list", "create", "read", "acceptancePreview", "accept", "respond", "respond",
    ]);
    assert.deepEqual(calls[1].input.input, proposal);
    assert.equal(calls[1].input.idempotencyKey, "create-1");
    assert.equal(calls[2].input.tradeId, TRADE_ID);
    assert.deepEqual(calls[3].input.input, { tradeId: TRADE_ID });
    assert.deepEqual(calls[4].input.input, { tradeId: TRADE_ID });
    assert.deepEqual(calls[5].input.input, { tradeId: TRADE_ID, action: "reject" });
    assert.deepEqual(calls[6].input.input, { tradeId: TRADE_ID, action: "cancel" });
    assert.deepEqual(securityCalls, [
      "authenticateBootstrap",
      "authenticateUnsafe",
      "authenticateBootstrap",
      "authenticateBootstrap",
      "authenticateUnsafe",
      "authenticateUnsafe",
      "authenticateUnsafe",
    ]);
  });

  test("keeps GETs authenticated and writes CSRF-protected", async (t) => {
    const calls = [];
    const baseUrl = await startApi(t, services(calls));
    const collection = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/trades`;
    const unauthenticated = await fetch(collection);
    const noCsrf = await fetch(`${collection}/${TRADE_ID}/accept`, {
      method: "POST",
      headers: headers({ "x-test-csrf": "missing" }),
      body: "{}",
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(noCsrf.status, 403);
    assert.equal(calls.length, 0);
  });

  test("rejects non-empty lifecycle bodies before a service call", async (t) => {
    const calls = [];
    const baseUrl = await startApi(t, services(calls));
    const response = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/trades/${TRADE_ID}/cancel`,
      {
        method: "POST",
        headers: headers({ "idempotency-key": "cancel-invalid" }),
        body: JSON.stringify({ confirmed: true }),
      }
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "TRADE_INPUT_INVALID");
    assert.equal(calls.length, 0);
  });

  test("maps authorization, missing, stale, conflict, and internal errors safely", async (t) => {
    const cases = [
      ["TEAM_MANAGER_REQUIRED", 403, "TRADE_AUTHORIZATION_DENIED"],
      ["TRADE_EXECUTION_NOT_FOUND", 404, "TRADE_NOT_FOUND"],
      ["TRADE_EXECUTION_VERSION_CONFLICT", 412, "TRADE_PRECONDITION_FAILED"],
      ["TRADE_ASSET_INELIGIBLE", 409, "TRADE_REQUEST_CONFLICT"],
      ["REPOSITORY_OPERATION_FAILED", 500, "TRADE_REQUEST_FAILED"],
    ];
    for (const [errorCode, status, publicCode] of cases) {
      const error = Object.assign(new Error("private detail"), {
        code: errorCode,
        reasonCode: errorCode.startsWith("TRADE_") ? errorCode : undefined,
      });
      const baseUrl = await startApi(t, services([], {
        tradeReadService: { read() { throw error; } },
      }));
      const response = await fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/trades/${TRADE_ID}`,
        { headers: { "x-test-session": "valid" } }
      );
      const body = await response.json();
      assert.equal(response.status, status, errorCode);
      assert.equal(body.error.code, publicCode, errorCode);
      assert.equal(JSON.stringify(body).includes("private detail"), false);
    }
  });

  test("validates the isolated empty-body helper", () => {
    assert.equal(emptyObject({}), true);
    assert.equal(emptyObject({ confirmed: true }), false);
    assert.equal(emptyObject(null), false);
  });
});
