const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createTradeRecoveryRouter,
  exactConfirmationBody,
} = require("../../src/transport/http/createTradeRecoveryRouter");

const LEAGUE_ID = "00000000-0000-4000-8000-000000000001";
const TRADE_ID = "00000000-0000-4000-8000-000000000002";

function requestSecurity(calls) {
  const session = Object.freeze({ user: { id: "user" }, session: { id: "session" } });
  return {
    assignRequestId(request, response, next) {
      request.testRequestId = "m5-10-request";
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

function serviceStub(calls, overrides = {}) {
  return {
    preview(input) {
      calls.push({ method: "preview", input });
      return { code: "TRADE_REVERSAL_PREVIEWED", preview: { recoverable: true } };
    },
    reverse(input) {
      calls.push({ method: "reverse", input });
      return { code: "TRADE_REVERSED" };
    },
    markCorrectionRequired(input) {
      calls.push({ method: "markCorrectionRequired", input });
      return { code: "TRADE_CORRECTION_REQUIRED" };
    },
    ...overrides,
  };
}

async function startApi(t, service, securityCalls = []) {
  const app = express();
  app.use(createTradeRecoveryRouter({
    requestSecurity: requestSecurity(securityCalls),
    tradeRecoveryService: service,
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

describe("M5-10 isolated trade-recovery HTTP contract", () => {
  test("routes preview, reverse, and correction-required with exact inputs", async (t) => {
    const calls = [];
    const securityCalls = [];
    const baseUrl = await startApi(t, serviceStub(calls), securityCalls);
    const base = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/trades/${TRADE_ID}`;
    const responses = await Promise.all([
      fetch(`${base}/reversal-preview`, {
        headers: { "x-test-session": "valid" },
      }),
      fetch(`${base}/reverse`, {
        method: "POST",
        headers: headers({ "idempotency-key": "reverse-1" }),
        body: JSON.stringify({ confirmed: true }),
      }),
      fetch(`${base}/correction-required`, {
        method: "POST",
        headers: headers({ "idempotency-key": "correction-1" }),
        body: JSON.stringify({ confirmed: true }),
      }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200]);
    assert.deepEqual(calls.map(({ method }) => method).sort(), [
      "preview",
      "reverse",
      "markCorrectionRequired",
    ].sort());
    assert.deepEqual(
      calls.find(({ method }) => method === "preview").input.input,
      { tradeId: TRADE_ID }
    );
    const reverse = calls.find(({ method }) => method === "reverse");
    assert.deepEqual(reverse.input.input, {
      tradeId: TRADE_ID,
      confirmed: true,
    });
    assert.equal(reverse.input.idempotencyKey, "reverse-1");
    assert.deepEqual(securityCalls.sort(), [
      "authenticateBootstrap",
      "authenticateUnsafe",
      "authenticateUnsafe",
    ].sort());
  });

  test("uses authenticated GET and CSRF-protected POST middleware", async (t) => {
    const calls = [];
    const baseUrl = await startApi(t, serviceStub(calls));
    const base = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/trades/${TRADE_ID}`;
    const unauthenticated = await fetch(`${base}/reversal-preview`);
    const noCsrf = await fetch(`${base}/reverse`, {
      method: "POST",
      headers: headers({ "x-test-csrf": "missing" }),
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(noCsrf.status, 403);
    assert.equal(calls.length, 0);
  });

  test("rejects false, missing, or extra confirmation fields", async (t) => {
    const calls = [];
    const baseUrl = await startApi(t, serviceStub(calls));
    const url = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/trades/${TRADE_ID}/reverse`;
    const bodies = [
      { confirmed: false },
      {},
      { confirmed: true, reason: "not accepted here" },
    ];
    const responses = [];
    for (const body of bodies) {
      responses.push(await fetch(url, {
        method: "POST",
        headers: headers({ "idempotency-key": "invalid" }),
        body: JSON.stringify(body),
      }));
    }
    assert.deepEqual(responses.map(({ status }) => status), [400, 400, 400]);
    assert.equal(calls.length, 0);
  });

  test("maps commissioner, missing, stale, unsafe, and internal errors safely", async (t) => {
    const cases = [
      ["LEAGUE_COMMISSIONER_REQUIRED", 403, "TRADE_RECOVERY_AUTHORITY_DENIED"],
      ["TRADE_REVERSAL_NOT_FOUND", 404, "TRADE_RECOVERY_NOT_FOUND"],
      ["TRADE_REVERSAL_VERSION_CONFLICT", 412, "TRADE_RECOVERY_PRECONDITION_FAILED"],
      ["TRADE_REVERSAL_UNSAFE", 409, "TRADE_RECOVERY_CONFLICT"],
      ["REPOSITORY_OPERATION_FAILED", 500, "TRADE_RECOVERY_FAILED"],
    ];
    for (const [errorCode, status, publicCode] of cases) {
      const error = new Error("private detail");
      error.code = errorCode;
      error.reasonCode = errorCode.startsWith("TRADE_") ? errorCode : undefined;
      const baseUrl = await startApi(t, serviceStub([], {
        preview() { throw error; },
      }));
      const response = await fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/trades/${TRADE_ID}/reversal-preview`,
        { headers: { "x-test-session": "valid" } }
      );
      const body = await response.json();
      assert.equal(response.status, status, errorCode);
      assert.equal(body.error.code, publicCode, errorCode);
      assert.equal(JSON.stringify(body).includes("private detail"), false);
    }
  });

  test("validates the isolated exact-confirmation helper", () => {
    assert.equal(exactConfirmationBody({ confirmed: true }), true);
    assert.throws(() => exactConfirmationBody({ confirmed: true, extra: 1 }));
  });
});
