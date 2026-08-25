const assert = require("node:assert/strict");
const test = require("node:test");

const {
  IntegratedReleaseQaError,
  createFrontendEnvironment,
  runIntegratedReleaseQaCommand,
} = require("../../scripts/rehearse-m7-integrated-local");

test("M7 integrated frontend child receives only OS and public Vite configuration", () => {
  const environment = createFrontendEnvironment({
    backendOrigin: "http://127.0.0.1:4107",
    environment: {
      BACKUP_ENCRYPTION_KEY: "must-not-pass",
      M7_RELEASE_QA_PASSWORD: "must-not-pass",
      PATH: "C:\\safe-bin",
      SystemRoot: "C:\\Windows",
    },
  });
  assert.deepEqual(environment, {
    PATH: "C:\\safe-bin",
    SystemRoot: "C:\\Windows",
    VITE_APP_ENV: "local",
    VITE_API_ORIGIN: "http://127.0.0.1:4107",
    VITE_SOCKET_ORIGIN: "http://127.0.0.1:4107",
    VITE_BUILD_ID: "m7-local-frontend",
  });
  assert.equal(Object.hasOwn(environment, "M7_RELEASE_QA_PASSWORD"), false);
  assert.equal(Object.hasOwn(environment, "BACKUP_ENCRYPTION_KEY"), false);
  assert.equal(Object.isFrozen(environment), true);
});

test("M7 integrated command rejects a missing fixture password before startup", async () => {
  let startupCalled = false;
  await assert.rejects(
    runIntegratedReleaseQaCommand({
      env: {},
      createRuntime: async () => { startupCalled = true; },
    }),
    (error) => error instanceof IntegratedReleaseQaError &&
      error.code === "RELEASE_QA_LOCAL_PASSWORD_REQUIRED"
  );
  assert.equal(startupCalled, false);
});
