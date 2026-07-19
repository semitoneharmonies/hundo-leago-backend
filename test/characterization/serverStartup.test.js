const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");
const { hashTree } = require("../helpers/hashTree");
const { httpRequest } = require("../helpers/httpRequest");
const {
  startCompatibilityServer,
} = require("../helpers/startCompatibilityServer");

const FIXTURE_SOURCE = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "minimal"
);

test("current server starts against isolated copied state and stops cleanly", async (t) => {
  const runtime = await createFixtureRuntime();
  let server = null;

  t.after(async () => {
    await server?.stop();
    await runtime.cleanup();
  });

  const sourceBefore = await hashTree(FIXTURE_SOURCE);
  const runtimeBefore = await hashTree(runtime.root);

  server = await startCompatibilityServer(runtime, {
    matchupsDebug: false,
  });

  const root = await httpRequest(server.baseUrl, "/");
  const health = await httpRequest(server.baseUrl, "/health");

  assert.equal(root.status, 200);
  assert.equal(root.text, "Hundo Leago backend is running.");
  assert.match(root.contentType, /^text\/html/);

  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.schemaVersion, 1);
  assert.equal(health.json.loadedFromDisk, true);
  assert.equal(health.json.backupsCount, 0);
  assert.equal(path.resolve(health.json.dataFilePath), runtime.leagueFile);
  assert.equal(path.resolve(health.json.backupsDir), runtime.backupsDir);

  const runtimeAfterRequests = await hashTree(runtime.root);
  const sourceAfter = await hashTree(FIXTURE_SOURCE);

  assert.deepEqual(runtimeAfterRequests, runtimeBefore);
  assert.deepEqual(sourceAfter, sourceBefore);

  const childPid = server.child.pid;
  await server.stop();

  assert.ok(Number.isInteger(childPid));
  assert.ok(
    server.child.exitCode !== null || server.child.signalCode !== null,
    "the compatibility server process should have exited"
  );
});
