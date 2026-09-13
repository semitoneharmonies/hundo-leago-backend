const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const { describe, test } = require("node:test");

const express = require("express");

const {
  createMatchupsDebugCompatibilityRouter,
} = require(
  "../../src/transport/http/routes/matchupsDebugCompatibilityRouter"
);
const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");
const {
  hashFile,
} = require("../helpers/hashTree");
const {
  httpRequest,
} = require("../helpers/httpRequest");
const {
  startCompatibilityServer,
} = require("../helpers/startCompatibilityServer");

async function readJson(filePath) {
  return JSON.parse(
    await fs.promises.readFile(filePath, "utf8")
  );
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(
    filePath,
    JSON.stringify(value, null, 2),
    "utf8"
  );
}

async function post(server, routePath, body) {
  return httpRequest(server.baseUrl, routePath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function withServer(
  t,
  { matchupsDebug, prepare } = {}
) {
  const runtime = await createFixtureRuntime();
  if (prepare) await prepare(runtime);
  const server = await startCompatibilityServer(
    runtime,
    { matchupsDebug }
  );

  t.after(async () => {
    await server.stop();
    await runtime.cleanup();
  });

  return { runtime, server };
}

const COMMISSIONER = {
  meta: { actorRole: "commissioner" },
};

async function startDebugRouterServer({
  leagueStore,
  publisher,
  nowMs = Date.now,
  logger = { error() {} },
}) {
  const app = express();
  app.use(express.json());
  app.use(
    createMatchupsDebugCompatibilityRouter({
      leagueStore,
      captureMatchupBaselineJob: {
        async run() {},
      },
      applyRosterLocksJob: {
        async run() {},
      },
      publisher,
      nowMs,
      logger,
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

describe(
  "current matchup debug HTTP compatibility",
  { concurrency: false },
  () => {
    test("registers none of the debug routes when the flag is disabled", async (t) => {
      const { server } = await withServer(t, {
        matchupsDebug: false,
      });

      const summary = await httpRequest(
        server.baseUrl,
        "/api/matchups/debug/stateSummary"
      );
      const reset = await post(
        server,
        "/api/matchups/debug/resetLocks",
        COMMISSIONER
      );

      assert.equal(summary.status, 404);
      assert.equal(reset.status, 404);
    });

    test("preserves commissioner guards for all five debug commands", async (t) => {
      const { runtime, server } = await withServer(t, {
        matchupsDebug: true,
      });
      const before = await hashFile(runtime.leagueFile);
      const commands = [
        "/api/matchups/debug/resetLocks",
        "/api/matchups/debug/resetBaselineForWeek",
        "/api/matchups/debug/captureBaselineNow",
        "/api/matchups/debug/runLockNow",
        "/api/matchups/debug/setTeamRosterEmpty",
      ];

      for (const routePath of commands) {
        const response = await post(server, routePath, {
          meta: { actorRole: "manager" },
          teamName: "Test Team Alpha",
          empty: true,
        });
        assert.equal(response.status, 403, routePath);
        assert.deepEqual(
          response.json,
          {
            ok: false,
            error: "Commissioner only.",
          },
          routePath
        );
      }

      assert.equal(
        await hashFile(runtime.leagueFile),
        before
      );
    });

    test("preserves state summary, reset, and roster-placeholder behavior", async (t) => {
      const { runtime, server } = await withServer(t, {
        matchupsDebug: true,
        async prepare(preparedRuntime) {
          const state = await readJson(
            preparedRuntime.leagueFile
          );
          state.matchups.locksByTeam = {
            "Test Team Alpha": {
              lockedAtMs: 1700000002000,
            },
          };
          state.matchups.baselineByWeekId = {
            "test-week-1": {
              capturedAtMs: 1700000001000,
              byPlayerId: {},
            },
          };
          await writeJson(
            preparedRuntime.leagueFile,
            state
          );
        },
      });

      const summary = await httpRequest(
        server.baseUrl,
        "/api/matchups/debug/stateSummary"
      );
      assert.equal(summary.status, 200);
      assert.deepEqual(summary.json, {
        ok: true,
        currentWeekIndex: 0,
        currentWeekId: "test-week-1",
        resultsKeys: [],
        lastRolloverWeekId: null,
      });

      const resetLocks = await post(
        server,
        "/api/matchups/debug/resetLocks",
        COMMISSIONER
      );
      assert.deepEqual(resetLocks.json, { ok: true });

      const resetBaseline = await post(
        server,
        "/api/matchups/debug/resetBaselineForWeek",
        COMMISSIONER
      );
      assert.deepEqual(resetBaseline.json, {
        ok: true,
        weekId: "test-week-1",
        existed: true,
      });

      const empty = await post(
        server,
        "/api/matchups/debug/setTeamRosterEmpty",
        {
          ...COMMISSIONER,
          teamName: "Test Team Alpha",
          empty: true,
        }
      );
      assert.deepEqual(empty.json, {
        ok: true,
        teamName: "Test Team Alpha",
        empty: true,
        rosterCount: 0,
      });

      const restored = await post(
        server,
        "/api/matchups/debug/setTeamRosterEmpty",
        {
          ...COMMISSIONER,
          teamName: "Test Team Alpha",
          empty: false,
        }
      );
      assert.deepEqual(restored.json, {
        ok: true,
        teamName: "Test Team Alpha",
        empty: false,
        rosterCount: 1,
      });

      const state = await readJson(runtime.leagueFile);
      assert.deepEqual(state.matchups.locksByTeam, {});
      assert.deepEqual(
        state.matchups.baselineByWeekId,
        {}
      );
      assert.deepEqual(state.teams[0].roster, [
        {
          name: "__TEST_PLAYER__",
          salary: 1,
          position: "F",
          onIR: false,
        },
      ]);
      assert.equal(
        state.meta.lastSavedBy,
        "commissioner:debugSetTeamRosterEmpty"
      );
    });

    test("preserves manual baseline and roster-lock job responses", async (t) => {
      const { runtime, server } = await withServer(t, {
        matchupsDebug: true,
      });

      const baseline = await post(
        server,
        "/api/matchups/debug/captureBaselineNow",
        COMMISSIONER
      );
      assert.equal(baseline.status, 200);
      assert.equal(baseline.json.ok, true);
      assert.equal(
        baseline.json.currentWeekIndex,
        0
      );
      assert.equal(
        baseline.json.weekId,
        "test-week-1"
      );
      assert.equal(baseline.json.captured, true);
      assert.equal(
        typeof baseline.json.capturedAtMs,
        "number"
      );
      assert.equal(
        typeof baseline.json.playerCount,
        "number"
      );

      const locks = await post(
        server,
        "/api/matchups/debug/runLockNow",
        COMMISSIONER
      );
      assert.equal(locks.status, 200);
      assert.equal(locks.json.ok, true);
      assert.equal(locks.json.currentWeekIndex, 0);
      assert.equal(locks.json.weekId, "test-week-1");
      assert.equal(
        typeof locks.json.serverNowMs,
        "number"
      );
      assert.equal(
        locks.json.lockAtMs,
        1700000002000
      );
      assert.deepEqual(locks.json.lockedTeams, [
        "Test Team Alpha",
        "Test Team Beta",
      ]);
      assert.equal(locks.json.lockedCount, 2);

      const state = await readJson(runtime.leagueFile);
      assert.ok(
        state.matchups.baselineByWeekId[
          "test-week-1"
        ]
      );
      assert.deepEqual(
        Object.keys(state.matchups.locksByTeam),
        ["Test Team Alpha", "Test Team Beta"]
      );
    });
  }
);

describe(
  "matchup debug compatibility router",
  { concurrency: false },
  () => {
    test("commits before publishing and maps save failure without an event", async (t) => {
      const order = [];
      const saves = [];
      const events = [];
      let state = {
        teams: [],
        matchups: {
          scheduleWeeks: [
            {
              weekId: "router-week",
              lockAtMs: 123,
            },
          ],
          currentWeekIndex: 0,
          currentWeekId: "router-week",
          locksByTeam: {
            "Router Team": {},
          },
          baselineByWeekId: {},
          resultsByWeek: {},
        },
      };
      let saveFailure = null;
      const leagueStore = {
        loadLeague() {
          return structuredClone(state);
        },
        async saveLeague(nextState, metadata) {
          if (saveFailure) throw saveFailure;
          order.push("save");
          state = structuredClone(nextState);
          saves.push({
            state: structuredClone(nextState),
            metadata: structuredClone(metadata),
          });
        },
      };
      const publisher = {
        publish(eventName, payload) {
          order.push("event");
          events.push({ eventName, payload });
        },
      };
      const server = await startDebugRouterServer({
        leagueStore,
        publisher,
        nowMs: () => 456,
      });
      t.after(() => server.stop());

      const reset = await post(
        server,
        "/api/matchups/debug/resetLocks",
        COMMISSIONER
      );
      assert.equal(reset.status, 200);
      assert.deepEqual(order, ["save", "event"]);
      assert.deepEqual(saves[0].metadata, {
        savedBy: "commissioner:debugResetLocks",
      });
      assert.deepEqual(events, [
        {
          eventName: "league:updated",
          payload: {
            reason: "matchups:debugResetLocks",
          },
        },
      ]);

      state.matchups.locksByTeam = {
        "Router Team": {},
      };
      const lockResponse = await post(
        server,
        "/api/matchups/debug/runLockNow",
        COMMISSIONER
      );
      assert.equal(lockResponse.status, 200);
      assert.equal(
        lockResponse.json.serverNowMs,
        456
      );

      saveFailure = new Error(
        "simulated debug save failure"
      );
      const failed = await post(
        server,
        "/api/matchups/debug/resetLocks",
        COMMISSIONER
      );
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.json, {
        ok: false,
        error: "Failed to reset locks.",
      });
      assert.equal(events.length, 1);
    });
  }
);
