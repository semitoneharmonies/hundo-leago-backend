const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const {
  ROUTE_PATH,
  createStagingSportsDataIoImportRouter,
} = require(
  "../../src/transport/http/createStagingSportsDataIoImportRouter"
);

function middleware(callback = () => {}) {
  return (request, response, next) => {
    callback(request, response);
    next();
  };
}

function requestSecurity(calls = []) {
  return {
    assignRequestId: middleware(() => calls.push("request-id")),
    authenticateUnsafe: middleware(() => calls.push("authenticate")),
    credentialedCors: middleware(() => calls.push("cors")),
    getAuthenticatedSession() {
      return { valid: true, user: { id: "admin" } };
    },
    getRequestId() {
      return "staging-provider-import-request";
    },
    requireAllowedOrigin: middleware(() => calls.push("origin")),
    requireCompatibleFetchMetadata: middleware(
      () => calls.push("fetch-metadata")
    ),
    requireJson: middleware(() => calls.push("json")),
    securityHeaders: middleware(() => calls.push("headers")),
  };
}

async function start(t, service, calls = []) {
  const app = express();
  app.use(
    createStagingSportsDataIoImportRouter({
      requestSecurity: requestSecurity(calls),
      stagingSportsDataIoImportService: service,
    })
  );
  app.get("/probe", (request, response) => {
    response.status(200).json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) =>
          error ? reject(error) : resolve()
        );
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("routes the explicit staging provider import through unsafe authentication and idempotency", async (t) => {
  let captured;
  const calls = [];
  const baseUrl = await start(t, {
    async run(options) {
      captured = options;
      return {
        code: "STAGING_SPORTSDATAIO_IMPORT_COMPLETED",
        provider: "sportsdataio-discovery-lab",
      };
    },
  }, calls);
  const input = {
    confirmation: "IMPORT SPORTSDATAIO STAGING DATA",
    reason: "Populate hosted staging player data.",
  };
  const response = await fetch(`${baseUrl}${ROUTE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "provider-import-one",
    },
    body: JSON.stringify(input),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      code: "STAGING_SPORTSDATAIO_IMPORT_COMPLETED",
      provider: "sportsdataio-discovery-lab",
    },
    meta: {
      requestId: "staging-provider-import-request",
    },
  });
  assert.deepEqual(captured, {
    input,
    idempotencyKey: "provider-import-one",
    authenticated: { valid: true, user: { id: "admin" } },
  });
  assert.deepEqual(calls, [
    "request-id",
    "headers",
    "cors",
    "origin",
    "json",
    "fetch-metadata",
    "authenticate",
  ]);
});

test("maps staging provider import conflicts without leaking internal details", async (t) => {
  const baseUrl = await start(t, {
    async run() {
      const error = new Error("private provider response");
      error.code =
        "STAGING_SPORTSDATAIO_IMPORT_IDENTITY_MISMATCH";
      throw error;
    },
  });
  const response = await fetch(`${baseUrl}${ROUTE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.deepEqual(body, {
    error: {
      code: "STAGING_SPORTSDATAIO_IMPORT_CONFLICT",
      message:
        "The staging provider import conflicts with current state.",
      requestId: "staging-provider-import-request",
    },
  });
  assert.equal(JSON.stringify(body).includes("private"), false);
});

test("staging provider import middleware is scoped away from unrelated routes", async (t) => {
  const calls = [];
  const baseUrl = await start(t, {
    async run() {
      throw new Error("must not run");
    },
  }, calls);

  const response = await fetch(`${baseUrl}/probe`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls, []);
});
