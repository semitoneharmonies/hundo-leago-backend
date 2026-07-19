const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, test } = require("node:test");

const { createFakePublisher } = require("../helpers/fakePublisher");
const { createFixedClock } = require("../helpers/fixedClock");
const {
  debugRoutesAreGuarded,
  readEndpointManifest,
} = require("../helpers/readEndpointManifest");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const EXPECTED_ENDPOINTS = [
  "GET /",
  "GET /api/backups",
  "GET /api/league",
  "GET /api/matchups/baseline/preview",
  "GET /api/matchups/baseline/status",
  "GET /api/matchups/current",
  "GET /api/matchups/debug/stateSummary",
  "GET /api/matchups/locks",
  "GET /api/matchups/locks/preview",
  "GET /api/matchups/rollover/status",
  "GET /api/matchups/scoring/preview",
  "GET /api/matchups/standings",
  "GET /api/players",
  "GET /api/players/:id",
  "GET /api/players/debug",
  "GET /api/snapshots",
  "GET /api/stats",
  "GET /api/stats/debug",
  "GET /api/stats/debug-localpath",
  "GET /health",
  "POST /api/backups/restore",
  "POST /api/league",
  "POST /api/matchups/debug/captureBaselineNow",
  "POST /api/matchups/debug/resetBaselineForWeek",
  "POST /api/matchups/debug/resetLocks",
  "POST /api/matchups/debug/runLockNow",
  "POST /api/matchups/debug/setTeamRosterEmpty",
  "POST /api/matchups/schedule/generate",
  "POST /api/matchups/schedule/shiftFrom",
  "POST /api/matchups/schedule/updateWeek",
  "POST /api/players/reload",
  "POST /api/snapshots/create",
  "POST /api/snapshots/restore",
  "POST /api/stats/refresh",
].sort((left, right) => left.localeCompare(right));

describe("current compatibility endpoint manifest", () => {
  test("contains exactly 34 routes, six debug routes, and 28 non-debug routes", () => {
    const manifest = readEndpointManifest(BACKEND_ROOT);
    const keys = manifest.map((entry) => entry.key);
    const uniqueKeys = [...new Set(keys)];
    const debug = manifest.filter((entry) => entry.debug);
    const nonDebug = manifest.filter((entry) => !entry.debug);

    assert.equal(manifest.length, 34);
    assert.equal(uniqueKeys.length, 34);
    assert.equal(debug.length, 6);
    assert.equal(nonDebug.length, 28);
    assert.deepEqual(keys, EXPECTED_ENDPOINTS);
  });

  test("keeps player debug before the dynamic player route", () => {
    const manifest = readEndpointManifest(BACKEND_ROOT);
    const playerDebug = manifest.find(
      (entry) => entry.key === "GET /api/players/debug"
    );
    const playerById = manifest.find(
      (entry) => entry.key === "GET /api/players/:id"
    );

    assert.ok(playerDebug);
    assert.ok(playerById);
    assert.equal(playerDebug.sourceFile, "routes/playersReadRoutes.js");
    assert.equal(playerById.sourceFile, "routes/playersReadRoutes.js");
    assert.ok(playerDebug.sourceIndex < playerById.sourceIndex);
  });

  test("keeps all matchup debug routes inside the current debug guard", () => {
    assert.equal(debugRoutesAreGuarded(BACKEND_ROOT), true);
  });
});

describe("test seam helpers", () => {
  test("fixed clock advances only by explicit safe integer values", () => {
    const clock = createFixedClock(1700000000000);

    assert.equal(clock.nowMs(), 1700000000000);
    assert.equal(clock.advance(250), 1700000000250);
    assert.equal(clock.set(1800000000000), 1800000000000);
    assert.throws(() => clock.advance(0.5), /safe integer/);
  });

  test("fake publisher records cloned events and can fail once", async () => {
    const publisher = createFakePublisher();
    const payload = { leagueId: "test-league", nested: { value: 1 } };

    await publisher.publish("league:updated", payload);
    payload.nested.value = 2;

    assert.deepEqual(publisher.calls, [
      {
        eventName: "league:updated",
        payload: { leagueId: "test-league", nested: { value: 1 } },
      },
    ]);

    publisher.failNext(new Error("expected publication failure"));
    await assert.rejects(
      publisher.publish("league:updated", {}),
      /expected publication failure/
    );

    await publisher.publish("league:updated", { recovered: true });
    assert.equal(publisher.calls.length, 2);
  });
});
