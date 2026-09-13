const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const {
  createStagingFixtureResetRouter,
} = require("../../src/transport/http/createStagingFixtureResetRouter");

function middleware(callback = () => {}) {
  return (request, response, next) => {
    callback(request, response);
    next();
  };
}

function requestSecurity() {
  return {
    assignRequestId: middleware(),
    authenticateUnsafe: middleware(),
    credentialedCors: middleware(),
    getAuthenticatedSession() {
      return { valid: true, user: { id: "admin" } };
    },
    getRequestId() {
      return "staging-reset-request";
    },
    requireAllowedOrigin: middleware(),
    requireCompatibleFetchMetadata: middleware(),
    requireJson: middleware(),
    securityHeaders: middleware(),
  };
}

async function start(t, service) {
  const app = express();
  app.use(
    createStagingFixtureResetRouter({
      requestSecurity: requestSecurity(),
      stagingFixtureResetService: service,
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

test("M7-10 routes the explicit staging reset through unsafe authentication and idempotency", async (t) => {
  let captured;
  const baseUrl = await start(t, {
    async reset(options) {
      captured = options;
      return {
        code: "STAGING_FIXTURE_RESET_COMPLETED",
        sessionInvalidated: true,
      };
    },
  });
  const input = {
    confirmation: "RESET STAGING TEST LEAGUES",
    reason: "Restore manual testing state.",
  };
  const response = await fetch(
    `${baseUrl}/api/v1/operations/staging-fixture-reset`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "reset-one",
      },
      body: JSON.stringify(input),
    }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      code: "STAGING_FIXTURE_RESET_COMPLETED",
      sessionInvalidated: true,
    },
    meta: { requestId: "staging-reset-request" },
  });
  assert.deepEqual(captured, {
    input,
    idempotencyKey: "reset-one",
    authenticated: { valid: true, user: { id: "admin" } },
  });
});

test("M7-10 maps reset identity conflicts without leaking internal details", async (t) => {
  const baseUrl = await start(t, {
    async reset() {
      const error = new Error("private path");
      error.code = "DATABASE_IDENTITY_MISMATCH";
      throw error;
    },
  });
  const response = await fetch(
    `${baseUrl}/api/v1/operations/staging-fixture-reset`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "STAGING_FIXTURE_RESET_CONFLICT",
      message: "The staging fixture reset conflicts with current state.",
      requestId: "staging-reset-request",
    },
  });
});

test("M7-10 reset middleware is scoped away from unrelated routes", async (t) => {
  const baseUrl = await start(t, {
    async reset() {
      throw new Error("must not run");
    },
  });
  const response = await fetch(`${baseUrl}/probe`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
