const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ReleaseQaRuntimeError,
  createReleaseQaRuntime,
} = require("../../src/operations/release/createReleaseQaRuntime");
const {
  browserHeaders,
  runtimeBinding,
  SESSION_COOKIE_PATTERN,
  verifyReleaseQaRuntime,
} = require("../../src/operations/release/verifyReleaseQaRuntime");
const {
  fixtureEmail,
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");
const {
  parseArguments: parseStartArguments,
  runReleaseQaRuntimeCommand,
} = require("../../scripts/start-m7-release-qa");
const {
  parseArguments: parseVerifyArguments,
  runReleaseQaVerificationCommand,
} = require("../../scripts/verify-m7-release-qa");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "hundo";
const REGISTRATION_PASSWORD = "M7 Runtime Fixture Password 2026!";

test("M7 release-QA verifier accepts only exact loopback or staging provider origins", () => {
  assert.equal(
    runtimeBinding(
      "https://hundo-leago-backend-staging.onrender.com",
      "https://hundoleago-staging.netlify.app"
    ),
    "hosted"
  );
  assert.equal(
    browserHeaders(
      "https://hundoleago-staging.netlify.app",
      {},
      "hosted"
    )["Sec-Fetch-Site"],
    "cross-site"
  );
  assert.throws(
    () =>
      runtimeBinding(
        "https://hundo-leago-backend.onrender.com",
        "https://hundoleago.netlify.app"
      ),
    { code: "RELEASE_QA_RUNTIME_VERIFICATION_FAILED" }
  );
  assert.equal(
    SESSION_COOKIE_PATTERN.test(`hl_session=${"a".repeat(43)}`),
    true
  );
  assert.equal(
    SESSION_COOKIE_PATTERN.test(`__Host-hl_session=${"a".repeat(43)}`),
    true
  );
});

function headers(extra = {}) {
  return {
    Accept: "application/json",
    Origin: FRONTEND_ORIGIN,
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...extra,
  };
}

async function signIn(started, alias) {
  const response = await fetch(`${started.baseUrl}/api/v1/session`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ email: fixtureEmail(alias), password: PASSWORD }),
  });
  const json = await response.json();
  assert.equal(response.status, 200);
  return Object.freeze({
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrfToken: json.data.csrfToken,
  });
}

test("M7 release-QA runtime rejects non-loopback, missing, and invalid control input before startup", async () => {
  await assert.rejects(
    createReleaseQaRuntime({
      frontendOrigin: "https://staging.example.test",
      leagueWriteMode: "open",
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      password: PASSWORD,
      port: 0,
    }),
    (error) => error instanceof ReleaseQaRuntimeError &&
      error.code === "RELEASE_QA_FRONTEND_ORIGIN_INVALID"
  );
  await assert.rejects(
    createReleaseQaRuntime({
      frontendOrigin: FRONTEND_ORIGIN,
      leagueWriteMode: "enabled",
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      password: PASSWORD,
      port: 0,
    }),
    (error) => error instanceof ReleaseQaRuntimeError &&
      error.code === "RELEASE_QA_WRITE_MODE_INVALID"
  );
  await assert.rejects(
    createReleaseQaRuntime({
      frontendOrigin: FRONTEND_ORIGIN,
      leagueWriteMode: "open",
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      port: 0,
    }),
    (error) => error instanceof ReleaseQaRuntimeError &&
      error.code === "RELEASE_QA_PASSWORD_REQUIRED"
  );
});

test("M7 release-QA runtime passes full-stack role, isolation, privacy, health, and lifecycle checks", async (t) => {
  const started = await createReleaseQaRuntime({
    frontendOrigin: FRONTEND_ORIGIN,
    leagueWriteMode: "open",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: PASSWORD,
    port: 0,
  });
  t.after(() => started.close());
  assert.equal(started.address.host, "127.0.0.1");
  assert.equal(started.schedulerStart.status, "disabled");
  assert.equal(fs.existsSync(started.databasePath), true);
  assert.equal(
    started.runtime.database.pragma("user_version", { simple: true }),
    50
  );

  const report = await verifyReleaseQaRuntime({
    baseUrl: started.baseUrl,
    expectedWriteMode: "open",
    fixtureManifestChecksum: started.fixtureManifest.manifestChecksum,
    frontendOrigin: FRONTEND_ORIGIN,
    password: PASSWORD,
  });
  assert.equal(report.accountAliasCount, 9);
  assert.equal(report.controls.backendBinding, "loopback");
  assert.equal(report.controls.email, "capture-only");
  assert.equal(report.controls.scheduledJobs, "disabled");
  assert.match(report.reportChecksum, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(PASSWORD), false);
  assert.equal(serialized.includes("@release-qa.example.test"), false);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/.test(serialized), false);

  await assert.rejects(
    started.runtime.services.league.statistics.refresh(),
    { code: "LIVE_STATISTICS_PROVIDER_FAILED" }
  );
  assert.equal(
    started.runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM stat_refreshes
      WHERE status='failed'
        AND error_code='LIVE_STATISTICS_PROVIDER_FAILED'
    `).get().count,
    1
  );
  assert.equal(started.runtime.scheduler.runCycle instanceof Function, true);
  assert.deepEqual(
    await started.runtime.scheduler.runCycle(),
    { status: "skipped", reason: "not_running" }
  );

  const registration = await fetch(`${started.baseUrl}/api/v1/accounts`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      email: "runtime.capture@release-qa.example.test",
      displayName: "Runtime Capture",
      password: REGISTRATION_PASSWORD,
      passwordConfirmation: REGISTRATION_PASSWORD,
    }),
  });
  assert.equal(registration.status, 202);
  assert.equal((await registration.json()).data.accepted, true);
  const delivered = await started.runtime.services.accountEmail.deliveryService.deliverDue();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].outcome, "published");
  const captured = started.runtime.services.accountEmail.adapter.listCaptured();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].to, "runtime.capture@release-qa.example.test");

  const temporaryRoot = started.temporaryRoot;
  await started.close();
  assert.equal(fs.existsSync(temporaryRoot), false);
});

test("M7 release-QA closed mode preserves reads and sessions while blocking league writes", async (t) => {
  const started = await createReleaseQaRuntime({
    frontendOrigin: FRONTEND_ORIGIN,
    leagueWriteMode: "closed",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: PASSWORD,
    port: 0,
  });
  t.after(() => started.close());
  const session = await signIn(started, "leagueAManagerOne");
  const leagueId = fixtureId("league:leagueA");
  const teamId = fixtureId("team:leagueA:1");
  const read = await fetch(`${started.baseUrl}/api/v1/leagues`, {
    headers: headers({ Cookie: session.cookie }),
  });
  assert.equal(read.status, 200);
  const before = started.runtime.database.serialize();
  const write = await fetch(
    `${started.baseUrl}/api/v1/leagues/${leagueId}/teams/${teamId}`,
    {
      method: "PATCH",
      headers: headers({
        Cookie: session.cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
        "If-Match": '"1"',
        "Idempotency-Key": "m7-closed-write",
      }),
      body: JSON.stringify({ primaryColour: "#ffffff", secondaryColour: "#000000" }),
    }
  );
  assert.equal(write.status, 503);
  assert.equal((await write.json()).error.code, "LEAGUE_WRITES_CLOSED");
  assert.equal(before.equals(started.runtime.database.serialize()), true);
  assert.equal(started.runtime.scheduler.getState(), "disabled");
});

test("M7 release-QA command contracts require exact safe input and omit the password", async () => {
  assert.deepEqual(
    parseStartArguments([
      "--frontend-origin", FRONTEND_ORIGIN,
      "--port", "4107",
      "--write-mode", "open",
    ]),
    { frontendOrigin: FRONTEND_ORIGIN, port: 4107, leagueWriteMode: "open" }
  );
  assert.deepEqual(
    parseVerifyArguments([
      "--base-url", "http://127.0.0.1:4107",
      "--fixture-manifest-checksum", "a".repeat(64),
      "--frontend-origin", FRONTEND_ORIGIN,
      "--write-mode", "open",
    ]),
    {
      baseUrl: "http://127.0.0.1:4107",
      fixtureManifestChecksum: "a".repeat(64),
      frontendOrigin: FRONTEND_ORIGIN,
      expectedWriteMode: "open",
    }
  );

  const output = [];
  const fakeStarted = {
    baseUrl: "http://127.0.0.1:4107",
    frontendOrigin: FRONTEND_ORIGIN,
    fixtureManifest: { manifestChecksum: "a".repeat(64) },
    schedulerStart: { status: "disabled" },
  };
  await runReleaseQaRuntimeCommand({
    argv: [
      "--frontend-origin", FRONTEND_ORIGIN,
      "--port", "4107",
      "--write-mode", "open",
    ],
    env: { M7_RELEASE_QA_PASSWORD: PASSWORD },
    createRuntime: async (options) => {
      assert.equal(options.password, PASSWORD);
      return fakeStarted;
    },
    output: { log: (value) => output.push(value) },
  });
  const report = { reportVersion: 1, reportChecksum: "b".repeat(64) };
  await runReleaseQaVerificationCommand({
    argv: [
      "--base-url", fakeStarted.baseUrl,
      "--fixture-manifest-checksum", "a".repeat(64),
      "--frontend-origin", FRONTEND_ORIGIN,
      "--write-mode", "open",
    ],
    env: { M7_RELEASE_QA_PASSWORD: PASSWORD },
    verify: async (options) => {
      assert.equal(options.password, PASSWORD);
      return report;
    },
    output: { log: (value) => output.push(value) },
  });
  assert.equal(output.length, 2);
  assert.equal(output.join("\n").includes(PASSWORD), false);
});
