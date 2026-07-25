const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANUAL_QA_GUIDE_PATH,
  ManualReleaseQaSiteError,
  createAccountGuide,
  createReadySummary,
  formatReadySummary,
  runManualReleaseQaSiteCommand,
} = require("../../scripts/start-m7-manual-qa");

function createStartedFixture(events = []) {
  return {
    baseUrl: "http://127.0.0.1:4107",
    close: async () => { events.push("backend-closed"); },
    fixtureManifest: {
      manifestChecksum: "fixture-checksum",
    },
    schedulerStart: {
      status: "disabled",
    },
  };
}

test("M7 manual-QA guide identifies every deterministic account without a password", () => {
  const accounts = createAccountGuide();
  assert.equal(accounts.length, 9);
  assert.deepEqual(
    accounts.map((account) => account.alias),
    [
      "platformAdmin",
      "leagueACommissioner",
      "leagueBCommissioner",
      "leagueAManagerOne",
      "leagueAManagerTwo",
      "leagueBManagerOne",
      "verifiedWithoutMembership",
      "pendingVerification",
      "deactivated",
    ]
  );
  assert.equal(
    accounts.find((account) => account.alias === "leagueAManagerOne").email,
    "man.a.leag.a@release-qa.example.test"
  );
  assert.equal(
    accounts.find((account) => account.alias === "leagueBManagerOne")
      .expectedAccess,
    "Release QA Beta League, Owls"
  );
  assert.equal(
    JSON.stringify(accounts).includes("M7 Manual QA Password"),
    false
  );
  assert.equal(Object.isFrozen(accounts), true);
  assert.equal(accounts.every(Object.isFrozen), true);
});

test("M7 manual-QA ready output is readable and never contains the fixture password", () => {
  const summary = createReadySummary({
    started: createStartedFixture(),
  });
  const output = formatReadySummary(summary);
  assert.match(output, /Open: http:\/\/127\.0\.0\.1:5173/);
  assert.match(output, /man\.a\.leag\.a@release-qa\.example\.test/);
  assert.match(output, /Scheduler: disabled/);
  assert.match(output, /Guide: .*M7_MANUAL_WEBSITE_TEST_GUIDE\.md/);
  assert.match(output, /Press Ctrl\+C once/);
  assert.equal(output.includes("M7 Manual QA Password 2026!"), false);
  assert.match(
    MANUAL_QA_GUIDE_PATH,
    /hundo-leago[\\/]docs[\\/]07-testing[\\/]M7_MANUAL_WEBSITE_TEST_GUIDE\.md$/
  );
});

test("M7 manual-QA command rejects a missing password before starting anything", async () => {
  let startupCalled = false;
  await assert.rejects(
    runManualReleaseQaSiteCommand({
      env: {},
      createRuntime: async () => {
        startupCalled = true;
      },
    }),
    (error) => error instanceof ManualReleaseQaSiteError &&
      error.code === "RELEASE_QA_SITE_PASSWORD_REQUIRED"
  );
  assert.equal(startupCalled, false);
});

test("M7 manual-QA command closes frontend before its temporary backend", async () => {
  const events = [];
  const output = [];
  const site = await runManualReleaseQaSiteCommand({
    env: {
      M7_RELEASE_QA_PASSWORD: "test-only-password",
    },
    createRuntime: async (options) => {
      assert.equal(options.frontendOrigin, "http://127.0.0.1:5173");
      assert.equal(options.leagueWriteMode, "open");
      assert.equal(options.password, "test-only-password");
      assert.equal(options.port, 0);
      return createStartedFixture(events);
    },
    launchFrontend: ({ backendOrigin, environment }) => {
      assert.equal(backendOrigin, "http://127.0.0.1:4107");
      assert.equal(environment.M7_RELEASE_QA_PASSWORD, "test-only-password");
      return { child: "fixture-frontend" };
    },
    awaitFrontend: async (frontend) => {
      assert.equal(frontend.child, "fixture-frontend");
      events.push("frontend-ready");
    },
    closeFrontend: async (frontend) => {
      assert.equal(frontend.child, "fixture-frontend");
      events.push("frontend-closed");
    },
    output: {
      log(value) {
        output.push(value);
      },
    },
  });

  assert.equal(site.summary.status, "ready");
  assert.equal(output.length, 1);
  assert.equal(output[0].includes("test-only-password"), false);
  await site.close();
  await site.close();
  assert.deepEqual(events, [
    "frontend-ready",
    "frontend-closed",
    "backend-closed",
  ]);
});

test("M7 manual-QA startup failure closes every resource it opened", async () => {
  const events = [];
  await assert.rejects(
    runManualReleaseQaSiteCommand({
      env: {
        M7_RELEASE_QA_PASSWORD: "test-only-password",
      },
      createRuntime: async () => createStartedFixture(events),
      launchFrontend: () => ({ child: "fixture-frontend" }),
      awaitFrontend: async () => {
        throw new Error("synthetic Vite failure");
      },
      closeFrontend: async () => {
        events.push("frontend-closed");
      },
    }),
    (error) => error instanceof ManualReleaseQaSiteError &&
      error.code === "RELEASE_QA_SITE_START_FAILED"
  );
  assert.deepEqual(events, ["frontend-closed", "backend-closed"]);
});
