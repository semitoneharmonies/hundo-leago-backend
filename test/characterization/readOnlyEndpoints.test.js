const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");
const { hashTree } = require("../helpers/hashTree");
const { httpRequest } = require("../helpers/httpRequest");
const {
  startCompatibilityServer,
} = require("../helpers/startCompatibilityServer");

const CASES = [
  { path: "/", status: 200, contentType: /^text\/html/ },
  { path: "/health", status: 200, keys: ["ok", "schemaVersion"] },
  { path: "/api/league", status: 200, keys: ["schemaVersion", "teams"] },
  {
    path: "/api/players",
    status: 200,
    keys: ["ok", "players", "count", "cacheCount", "limitUsed"],
  },
  {
    path: "/api/players?query=Test%20Forward&limit=25",
    status: 200,
    keys: ["ok", "players", "count", "cacheCount", "limitUsed"],
  },
  {
    path: "/api/players/debug",
    status: 200,
    keys: ["ok", "disk", "repo", "cacheCount"],
  },
  {
    path: "/api/players/1001",
    status: 200,
    keys: ["ok", "player"],
  },
  {
    path: "/api/players/not-a-number",
    status: 400,
    keys: ["ok", "error"],
  },
  {
    path: "/api/stats",
    status: 200,
    keys: ["ok", "ready", "byPlayerId"],
  },
  {
    path: "/api/stats?playerId=1001",
    status: 200,
    keys: ["ok", "playerId", "stats"],
  },
  {
    path: "/api/stats/debug",
    status: 200,
    keys: ["ok", "disk"],
  },
  {
    path: "/api/stats/debug-localpath",
    status: 200,
    keys: ["ok", "localPath", "localExists"],
  },
  { path: "/api/snapshots", status: 200, keys: ["snapshots"] },
  { path: "/api/backups", status: 200, keys: ["ok", "backups"] },
  {
    path: "/api/matchups/current",
    status: 200,
    keys: ["ok", "currentWeekIndex", "currentWeekId", "week"],
  },
  {
    path: "/api/matchups/standings",
    status: 200,
    keys: ["ok", "weeksCounted", "standings"],
  },
  {
    path: "/api/matchups/locks",
    status: 200,
    keys: ["ok", "currentWeekIndex", "locksByTeam"],
  },
  {
    path: "/api/matchups/locks/preview",
    status: 200,
    keys: ["ok", "reason", "wouldLock"],
  },
  {
    path: "/api/matchups/baseline/preview",
    status: 200,
    keys: ["ok", "weekId", "preview"],
  },
  {
    path: "/api/matchups/baseline/status",
    status: 200,
    keys: ["ok", "canCapture", "reason"],
  },
  {
    path: "/api/matchups/scoring/preview",
    status: 200,
    keys: ["ok", "weekId", "teams"],
  },
  {
    path: "/api/matchups/rollover/status",
    status: 200,
    keys: ["ok", "currentWeekIndex", "canRollover"],
  },
  {
    path: "/api/matchups/debug/stateSummary",
    status: 200,
    keys: ["ok", "currentWeekIndex", "resultsKeys"],
  },
];

test("all current GET routes preserve the complete fixture-runtime tree", async (t) => {
  const runtime = await createFixtureRuntime();
  let server = null;

  t.after(async () => {
    await server?.stop();
    await runtime.cleanup();
  });

  server = await startCompatibilityServer(runtime, {
    matchupsDebug: true,
  });

  const before = await hashTree(runtime.root);

  for (const testCase of CASES) {
    const response = await httpRequest(server.baseUrl, testCase.path);

    assert.equal(
      response.status,
      testCase.status,
      `${testCase.path} returned ${response.status}: ${response.text}`
    );
    assert.match(
      response.contentType,
      testCase.contentType || /^application\/json/,
      `${testCase.path} returned unexpected content type ${response.contentType}`
    );

    if (testCase.keys) {
      assert.ok(
        response.json && typeof response.json === "object",
        `${testCase.path} did not return JSON`
      );

      for (const key of testCase.keys) {
        assert.equal(
          Object.hasOwn(response.json, key),
          true,
          `${testCase.path} is missing response key ${key}`
        );
      }
    }
  }

  const after = await hashTree(runtime.root);
  assert.deepEqual(after, before);
});
