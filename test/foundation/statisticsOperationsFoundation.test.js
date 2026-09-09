const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
const { createStatisticsOperationsService } = require("../../src/application/services/statistics/createStatisticsOperationsService");
const { createStatisticsOperationsRouter, ROOT_PATH } = require("../../src/transport/http/createStatisticsOperationsRouter");
const { createTargetRequestSecurity } = require("../../src/transport/http/createTargetRequestSecurity");
const { createSessionCookie } = require("../../src/transport/http/sessionCookie");
const ID = "40000000-0000-4000-8000-000000000001", ORIGIN = "https://hundo.example";
const TOKEN = Buffer.alloc(32, 23).toString("base64url");
const AUTH = { valid: true, user: { id: ID }, session: { id: ID, userId: ID } };

function fixture({ enabled = true, refresh } = {}) {
  const calls = { authorizations: 0, refreshes: 0, reads: 0 };
  let administrator = true;
  const service = createStatisticsOperationsService({ enabled,
    platformAuthorization: { requireAdministrator(input) { calls.authorizations += 1; if (!administrator || input !== AUTH) throw Object.assign(new Error("private detail"), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" }); } },
    statisticsService: { async refresh(input) { calls.refreshes += 1; if (refresh) return refresh(input); await input.authorizePersist(); return { refreshId: ID, status: "succeeded", playerCount: 500, capturedAtMs: 100 }; } },
    repository: { readRefresh(jobId) { calls.reads += 1; return jobId === ID ? { id: ID, status: "succeeded", nhl_season_key: "20262027", player_count: 500, started_at_ms: 90, completed_at_ms: 100, source_version: "private" } : null; } },
  });
  return { service, calls, revoke: () => { administrator = false; } };
}

test("administrator statistics operations validate authority before work and again before persistence", async () => {
  const f = fixture();
  await assert.rejects(f.service.refresh({ authenticated: {}, input: {} }), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
  await assert.rejects(f.service.refresh({ authenticated: AUTH, input: { provider: "untrusted" } }), { code: "STATISTICS_OPERATION_INVALID" });
  assert.equal(f.calls.refreshes, 0);
  const result = await f.service.refresh({ authenticated: AUTH, input: {} });
  assert.equal(result.jobId, ID);
  assert.equal(f.calls.authorizations, 4);
  f.revoke();
  assert.throws(() => f.service.read({ authenticated: AUTH, jobId: ID }), { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
  assert.equal(f.calls.reads, 0);
});

test("statistics status reads never invoke a refresh and expose a bounded projection", () => {
  const f = fixture();
  const result = f.service.read({ authenticated: AUTH, jobId: ID });
  assert.equal(result.status, "succeeded");
  assert.equal(result.source_version, undefined);
  assert.equal(f.calls.refreshes, 0);
  assert.throws(() => f.service.read({ authenticated: AUTH, jobId: "bad" }), { code: "STATISTICS_OPERATION_INVALID" });
});

test("disabled operations and overlapping manual refreshes cannot start extra work", async () => {
  const disabled = fixture({ enabled: false });
  await assert.rejects(disabled.service.refresh({ authenticated: AUTH, input: {} }), { code: "STATISTICS_OPERATION_DISABLED" });
  assert.equal(disabled.calls.refreshes, 0);
  let release;
  const f = fixture({ refresh: async ({ authorizePersist }) => { await new Promise((resolve) => { release = resolve; }); await authorizePersist(); return { refreshId: ID, status: "succeeded" }; } });
  const pending = f.service.refresh({ authenticated: AUTH, input: {} });
  await assert.rejects(f.service.refresh({ authenticated: AUTH, input: {} }), { code: "STATISTICS_OPERATION_IN_PROGRESS" });
  f.revoke(); release();
  await assert.rejects(pending, { code: "PLATFORM_ADMINISTRATOR_REQUIRED" });
});

test("statistics HTTP routes enforce session, origin, CSRF and platform authority; GET stays read-only", async (t) => {
  const f = fixture();
  const sessionCookie = createSessionCookie({ appEnv: "staging", publicFrontendOrigin: ORIGIN, sameSite: "none" });
  const invalid = { valid: false, code: "SESSION_INVALID" };
  const requestSecurity = createTargetRequestSecurity({ sessionCookie, requestIdFactory: () => "statistics-http-test", isAllowedOrigin: (value) => value === ORIGIN,
    sessionService: {
      bootstrap: (rawSessionToken) => rawSessionToken === TOKEN ? AUTH : invalid,
      resolveWithCsrf: ({ rawSessionToken, rawCsrfToken }) => rawSessionToken !== TOKEN ? invalid : rawCsrfToken !== "statistics-csrf" ? { valid: false, code: "CSRF_INVALID" } : AUTH,
    },
  });
  const app = express(); app.use(createStatisticsOperationsRouter({ requestSecurity, statisticsOperationsService: f.service }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}${ROOT_PATH}`;
  const headers = { Origin: ORIGIN, "Content-Type": "application/json", Cookie: `${sessionCookie.name}=${TOKEN}`, "X-CSRF-Token": "statistics-csrf", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" };
  for (const [overrides, status] of [[{ Cookie: "" }, 401], [{ Origin: "https://untrusted.example" }, 403], [{ "X-CSRF-Token": "invalid" }, 403]]) {
    assert.equal((await fetch(`${base}/refresh`, { method: "POST", headers: { ...headers, ...overrides }, body: "{}" })).status, status);
  }
  assert.equal(f.calls.refreshes, 0);
  const response = await fetch(`${base}/refresh`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.jobId, ID);
  const read = await fetch(`${base}/refreshes/${ID}`, { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).data.playerCount, 500);
  assert.equal(f.calls.refreshes, 1);
  f.revoke();
  assert.equal((await fetch(`${base}/refreshes/${ID}`, { headers })).status, 403);
  const denied = await fetch(`${base}/refresh`, { method: "POST", headers, body: "{}" });
  assert.equal(denied.status, 403);
  assert.ok(!(await denied.text()).includes("private detail"));
});
