const assert = require("node:assert/strict");
const fs = require("node:fs");
const { describe, test } = require("node:test");

const {
  buildScheduleWeeks,
  makeUtcMsForTZ,
} = require("../../src/domain/matchups/buildSchedule");
const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");
const { hashFile } = require("../helpers/hashTree");
const { httpRequest } = require("../helpers/httpRequest");
const {
  startCompatibilityServer,
} = require("../helpers/startCompatibilityServer");
const {
  createGenerateScheduleService,
} = require(
  "../../src/application/services/matchups/generateSchedule"
);
const {
  createUpdateWeekService,
} = require(
  "../../src/application/services/matchups/updateWeek"
);
const {
  createShiftScheduleService,
} = require(
  "../../src/application/services/matchups/shiftSchedule"
);
const {
  createFakePublisher,
} = require("../helpers/fakePublisher");

const TIME_ZONE = "America/Los_Angeles";

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

async function postJson(server, requestPath, body) {
  return httpRequest(server.baseUrl, requestPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function withServer(t, { prepare } = {}) {
  const runtime = await createFixtureRuntime();
  if (prepare) await prepare(runtime);
  const server = await startCompatibilityServer(runtime);

  t.after(async () => {
    await server.stop();
    await runtime.cleanup();
  });

  return { runtime, server };
}

describe(
  "current matchup schedule command compatibility",
  { concurrency: false },
  () => {
    test("rejects non-commissioners and odd-team generation without changing state", async (t) => {
      const { runtime, server } = await withServer(t, {
        async prepare(runtime) {
          const state = await readJson(runtime.leagueFile);
          state.teams.push({
            name: "Test Team Gamma",
            roster: [],
            buyouts: [],
          });
          await fs.promises.writeFile(
            runtime.leagueFile,
            JSON.stringify(state, null, 2),
            "utf8"
          );
        },
      });
      const before = await hashFile(runtime.leagueFile);

      const forbidden = await postJson(
        server,
        "/api/matchups/schedule/generate",
        {
          meta: { actorRole: "manager" },
        }
      );
      const oddTeams = await postJson(
        server,
        "/api/matchups/schedule/generate",
        {
          meta: { actorRole: "commissioner" },
        }
      );

      assert.equal(forbidden.status, 403);
      assert.deepEqual(forbidden.json, {
        ok: false,
        error: "Commissioner only.",
      });
      assert.equal(oddTeams.status, 400);
      assert.deepEqual(oddTeams.json, {
        ok: false,
        error:
          "Round robin schedule currently requires an even number of teams.",
      });
      assert.equal(await hashFile(runtime.leagueFile), before);
    });

    test("generates the current even-team schedule and resets matchup progress", async (t) => {
      const { runtime, server } = await withServer(t, {
        async prepare(runtime) {
          const state = await readJson(runtime.leagueFile);
          state.matchups.locksByTeam = {
            "Test Team Alpha": { lockedAtMs: 1 },
          };
          state.matchups.baselineByWeekId = {
            old: { capturedAtMs: 1 },
          };
          state.matchups.resultsByWeek = {
            old: { perTeam: {} },
          };
          state.matchups.lastRolloverWeekId = "old";
          state.matchups.baselineByPlayerId = {
            1001: 7,
          };
          await fs.promises.writeFile(
            runtime.leagueFile,
            JSON.stringify(state, null, 2),
            "utf8"
          );
        },
      });
      const startWeekMsPT = makeUtcMsForTZ(
        {
          year: 2027,
          month: 1,
          day: 4,
          hour: 0,
          minute: 0,
        },
        TIME_ZONE
      );
      const before = await hashFile(runtime.leagueFile);

      const response = await postJson(
        server,
        "/api/matchups/schedule/generate",
        {
          meta: { actorRole: "Commissioner" },
          seasonId: "season-2027",
          numWeeks: 3,
          startWeekMsPT,
          lockHour: 15,
          lockMinute: 30,
        }
      );
      const after = await hashFile(runtime.leagueFile);
      const state = await readJson(runtime.leagueFile);

      assert.equal(response.status, 200);
      assert.deepEqual(response.json, {
        ok: true,
        generated: {
          seasonId: "season-2027",
          numWeeks: 3,
          startWeekMsPT,
          currentWeekId: "season-2027-W01",
        },
      });
      assert.notEqual(after, before);
      assert.equal(
        state.meta.lastSavedBy,
        "commissioner:generateSchedule"
      );
      assert.equal(state.matchups.scheduleWeeks.length, 3);
      assert.equal(
        state.matchups.scheduleWeeks[0].lockAtMs,
        makeUtcMsForTZ(
          {
            year: 2027,
            month: 1,
            day: 4,
            hour: 15,
            minute: 30,
          },
          TIME_ZONE
        )
      );
      assert.deepEqual(state.matchups.locksByTeam, {});
      assert.deepEqual(state.matchups.baselineByWeekId, {});
      assert.deepEqual(state.matchups.resultsByWeek, {});
      assert.equal(state.matchups.lastRolloverWeekId, null);
      assert.deepEqual(state.matchups.baselineByPlayerId, {
        1001: 7,
      });
    });

    test("updates only future weeks, preserves overlap failures, and allows force outside production", async (t) => {
      const startWeekMsPT = makeUtcMsForTZ(
        {
          year: 2027,
          month: 2,
          day: 1,
          hour: 0,
          minute: 0,
        },
        TIME_ZONE
      );
      const scheduleWeeks = buildScheduleWeeks({
        teamNames: ["Test Team Alpha", "Test Team Beta"],
        startWeekMsPT,
        numWeeks: 3,
        seasonId: "future",
        timeZone: TIME_ZONE,
      });
      const { runtime, server } = await withServer(t, {
        async prepare(runtime) {
          const state = await readJson(runtime.leagueFile);
          state.matchups.scheduleWeeks = scheduleWeeks;
          state.matchups.currentWeekIndex = 0;
          state.matchups.currentWeekId =
            scheduleWeeks[0].weekId;
          await fs.promises.writeFile(
            runtime.leagueFile,
            JSON.stringify(state, null, 2),
            "utf8"
          );
        },
      });

      const updatedLockAtMs =
        scheduleWeeks[1].lockAtMs + 60 * 60 * 1000;
      const updated = await postJson(
        server,
        "/api/matchups/schedule/updateWeek",
        {
          meta: { actorRole: "commissioner" },
          weekIndex: 1,
          lockAtMs: updatedLockAtMs,
        }
      );

      assert.equal(updated.status, 200);
      assert.equal(updated.json.ok, true);
      assert.equal(updated.json.weekIndex, 1);
      assert.equal(
        updated.json.updated.lockAtMs,
        updatedLockAtMs
      );

      const overlapBefore = await hashFile(runtime.leagueFile);
      const overlap = await postJson(
        server,
        "/api/matchups/schedule/updateWeek",
        {
          meta: { actorRole: "commissioner" },
          weekIndex: 1,
          weekStartAtMs:
            scheduleWeeks[0].rolloverAtMs - 1,
        }
      );

      assert.equal(overlap.status, 400);
      assert.deepEqual(overlap.json, {
        ok: false,
        error:
          "This change would overlap the previous week. Use force=true if you really intend this.",
      });
      assert.equal(
        await hashFile(runtime.leagueFile),
        overlapBefore
      );

      const state = await readJson(runtime.leagueFile);
      state.matchups.scheduleWeeks[0].weekStartAtMs = 1;
      state.matchups.scheduleWeeks[0].baselineAtMs =
        60 * 60 * 1000 + 1;
      state.matchups.scheduleWeeks[0].lockAtMs =
        2 * 60 * 60 * 1000;
      state.matchups.scheduleWeeks[0].weekEndAtMs =
        Date.now() + 7 * 24 * 60 * 60 * 1000;
      state.matchups.scheduleWeeks[0].rolloverAtMs =
        state.matchups.scheduleWeeks[0].weekEndAtMs + 1;
      await fs.promises.writeFile(
        runtime.leagueFile,
        JSON.stringify(state, null, 2),
        "utf8"
      );
      const pastBefore = await hashFile(runtime.leagueFile);

      const pastRejected = await postJson(
        server,
        "/api/matchups/schedule/updateWeek",
        {
          meta: { actorRole: "commissioner" },
          weekIndex: 0,
          lockAtMs: 3 * 60 * 60 * 1000,
        }
      );
      assert.equal(pastRejected.status, 400);
      assert.equal(
        pastRejected.json.error,
        "Only future weeks can be edited. Use force=true only for emergency commissioner fixes."
      );
      assert.equal(
        await hashFile(runtime.leagueFile),
        pastBefore
      );

      const forced = await postJson(
        server,
        "/api/matchups/schedule/updateWeek",
        {
          meta: { actorRole: "commissioner" },
          weekIndex: 0,
          lockAtMs: 3 * 60 * 60 * 1000,
          force: true,
        }
      );
      assert.equal(forced.status, 200);
      assert.equal(forced.json.updated.lockAtMs, 10800000);
    });

    test("shifts only the selected and later weeks using current calendar windows", async (t) => {
      const startWeekMsPT = makeUtcMsForTZ(
        {
          year: 2027,
          month: 3,
          day: 1,
          hour: 0,
          minute: 0,
        },
        TIME_ZONE
      );
      const scheduleWeeks = buildScheduleWeeks({
        teamNames: ["Test Team Alpha", "Test Team Beta"],
        startWeekMsPT,
        numWeeks: 3,
        seasonId: "shift",
        timeZone: TIME_ZONE,
      });
      const originalFirst = structuredClone(scheduleWeeks[0]);
      const { runtime, server } = await withServer(t, {
        async prepare(runtime) {
          const state = await readJson(runtime.leagueFile);
          state.matchups.scheduleWeeks = scheduleWeeks;
          await fs.promises.writeFile(
            runtime.leagueFile,
            JSON.stringify(state, null, 2),
            "utf8"
          );
        },
      });

      const missingBefore = await hashFile(runtime.leagueFile);
      const missing = await postJson(
        server,
        "/api/matchups/schedule/shiftFrom",
        {
          meta: { actorRole: "commissioner" },
          fromWeekIndex: 10,
        }
      );
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.json, {
        ok: false,
        error: "fromWeekIndex out of range.",
      });
      assert.equal(
        await hashFile(runtime.leagueFile),
        missingBefore
      );

      const shifted = await postJson(
        server,
        "/api/matchups/schedule/shiftFrom",
        {
          meta: { actorRole: "commissioner" },
          fromWeekIndex: 1,
          lockHour: 14,
          lockMinute: 15,
        }
      );
      const state = await readJson(runtime.leagueFile);

      assert.equal(shifted.status, 200);
      assert.deepEqual(shifted.json, {
        ok: true,
        shiftedFrom: 1,
        weeksShifted: 2,
      });
      assert.deepEqual(
        state.matchups.scheduleWeeks[0],
        originalFirst
      );
      assert.equal(
        state.matchups.scheduleWeeks[1].weekStartAtMs,
        state.matchups.scheduleWeeks[0].rolloverAtMs
      );
      assert.equal(
        state.matchups.scheduleWeeks[2].weekStartAtMs,
        state.matchups.scheduleWeeks[1].rolloverAtMs
      );
      assert.equal(
        state.meta.lastSavedBy,
        "commissioner:shiftSchedule"
      );
      assert.equal(
        new Date(
          state.matchups.scheduleWeeks[1].lockAtMs
        ).toISOString(),
        "2027-03-08T22:15:00.000Z"
      );
    });
  }
);

describe("matchup schedule generation service", () => {
  test("saves before one event attempt and preserves current reset semantics", async () => {
    const order = [];
    let saved = null;
    const publisher = createFakePublisher();
    const originalPublish = publisher.publish.bind(publisher);
    publisher.publish = async (...args) => {
      order.push("publish");
      return originalPublish(...args);
    };
    const previous = {
      teams: [{ name: "Alpha" }, { name: "Beta" }],
      matchups: {
        seasonId: "old-season",
        locksByTeam: { Alpha: { lockedAtMs: 1 } },
        baselineByWeekId: { old: {} },
        resultsByWeek: { old: {} },
        lastRolloverWeekId: "old",
        baselineByPlayerId: { 1: 2 },
      },
    };
    const service = createGenerateScheduleService({
      leagueStore: {
        loadLeague: () => previous,
        async saveLeague(state, options) {
          order.push("save");
          saved = {
            state: structuredClone(state),
            options,
          };
        },
      },
      timeZone: TIME_ZONE,
      clock: { nowMs: () => 1000 },
      publisher,
      getNextMondayStart({ nowMs, timeZone }) {
        assert.equal(nowMs, 1000);
        assert.equal(timeZone, TIME_ZONE);
        return 2000;
      },
      buildSchedule(options) {
        assert.deepEqual(options, {
          teamNames: ["Alpha", "Beta"],
          startWeekMsPT: 2000,
          numWeeks: 2,
          lockHour: 16,
          lockMinute: 0,
          seasonId: "new-season",
          timeZone: TIME_ZONE,
        });
        return [
          { weekId: "new-season-W01" },
          { weekId: "new-season-W02" },
        ];
      },
    });

    const result = await service.generateSchedule({
      seasonId: "new-season",
      numWeeks: 2,
    });

    assert.deepEqual(order, ["save", "publish"]);
    assert.deepEqual(saved.options, {
      savedBy: "commissioner:generateSchedule",
    });
    assert.deepEqual(saved.state.matchups.locksByTeam, {});
    assert.deepEqual(
      saved.state.matchups.baselineByWeekId,
      {}
    );
    assert.deepEqual(saved.state.matchups.resultsByWeek, {});
    assert.equal(
      saved.state.matchups.lastRolloverWeekId,
      null
    );
    assert.deepEqual(
      saved.state.matchups.baselineByPlayerId,
      { 1: 2 }
    );
    assert.deepEqual(result, {
      ok: true,
      generated: {
        seasonId: "new-season",
        numWeeks: 2,
        startWeekMsPT: 2000,
        currentWeekId: "new-season-W01",
      },
    });
    assert.deepEqual(publisher.calls, [
      {
        eventName: "league:updated",
        payload: {
          reason: "matchups:scheduleGenerated",
        },
      },
    ]);
  });

  test("rejects too few and odd teams before saving", async () => {
    let saves = 0;
    const leagueStore = {
      loadLeague: () => ({
        teams: [{ name: "Only" }],
        matchups: {},
      }),
      async saveLeague() {
        saves += 1;
      },
    };
    const service = createGenerateScheduleService({
      leagueStore,
      timeZone: TIME_ZONE,
    });

    await assert.rejects(
      service.generateSchedule({}),
      (error) =>
        error.statusCode === 400 &&
        error.message ===
          "Need at least 2 teams to generate schedule."
    );

    leagueStore.loadLeague = () => ({
      teams: [
        { name: "One" },
        { name: "Two" },
        { name: "Three" },
      ],
      matchups: {},
    });
    await assert.rejects(
      service.generateSchedule({}),
      (error) =>
        error.statusCode === 400 &&
        error.message ===
          "Round robin schedule currently requires an even number of teams."
    );
    assert.equal(saves, 0);
  });
});

describe("matchup one-week update service", () => {
  function createState() {
    return {
      teams: [],
      matchups: {
        scheduleWeeks: [
          {
            weekId: "week-1",
            weekStartAtMs: 1000000,
            baselineAtMs: 4600000,
            lockAtMs: 5000000,
            weekEndAtMs: 10000000,
            rolloverAtMs: 11000000,
          },
          {
            weekId: "week-2",
            weekStartAtMs: 11000000,
            baselineAtMs: 14600000,
            lockAtMs: 15000000,
            weekEndAtMs: 20000000,
            rolloverAtMs: 21000000,
          },
        ],
      },
    };
  }

  test("ignores force in production and does not save a past week", async () => {
    let saves = 0;
    const service = createUpdateWeekService({
      leagueStore: {
        loadLeague: createState,
        async saveLeague() {
          saves += 1;
        },
      },
      nodeEnv: "production",
      clock: { nowMs: () => 12000000 },
    });

    await assert.rejects(
      service.updateWeek({
        weekIndex: 0,
        force: true,
      }),
      (error) =>
        error.statusCode === 400 &&
        error.message ===
          "Only future weeks can be edited. Use force=true only for emergency commissioner fixes."
    );
    assert.equal(saves, 0);
  });

  test("allows force outside production, derives baseline, and saves before publishing", async () => {
    const order = [];
    let saved = null;
    const publisher = createFakePublisher();
    const originalPublish = publisher.publish.bind(publisher);
    publisher.publish = async (...args) => {
      order.push("publish");
      return originalPublish(...args);
    };
    const service = createUpdateWeekService({
      leagueStore: {
        loadLeague: createState,
        async saveLeague(state, options) {
          order.push("save");
          saved = {
            state: structuredClone(state),
            options,
          };
        },
      },
      nodeEnv: "test",
      clock: { nowMs: () => 12000000 },
      publisher,
    });

    const result = await service.updateWeek({
      weekIndex: 0,
      force: true,
      weekStartAtMs: 2000000,
      lockAtMs: 6000000,
      weekEndAtMs: 10000000,
      rolloverAtMs: 11000000,
    });

    assert.deepEqual(order, ["save", "publish"]);
    assert.equal(result.updated.baselineAtMs, 5600000);
    assert.equal(
      saved.state.matchups.scheduleWeeks[0].baselineAtMs,
      5600000
    );
    assert.deepEqual(saved.options, {
      savedBy: "commissioner:updateWeekWindow",
    });
    assert.deepEqual(publisher.calls[0], {
      eventName: "league:updated",
      payload: {
        reason: "matchups:weekUpdated",
        weekIndex: 0,
      },
    });
  });

  test("rejects neighbor overlap before saving", async () => {
    let saves = 0;
    const service = createUpdateWeekService({
      leagueStore: {
        loadLeague: createState,
        async saveLeague() {
          saves += 1;
        },
      },
      nodeEnv: "test",
      clock: { nowMs: () => 1 },
    });

    await assert.rejects(
      service.updateWeek({
        weekIndex: 1,
        weekStartAtMs: 10999999,
      }),
      (error) =>
        error.statusCode === 400 &&
        error.message ===
          "This change would overlap the previous week. Use force=true if you really intend this."
    );
    assert.equal(saves, 0);
  });
});

describe("matchup shift-from service", () => {
  test("preserves earlier weeks, rebuilds later windows, and saves before publishing", async () => {
    const startWeekMsPT = makeUtcMsForTZ(
      {
        year: 2027,
        month: 3,
        day: 1,
        hour: 0,
        minute: 0,
      },
      TIME_ZONE
    );
    const weeks = buildScheduleWeeks({
      teamNames: ["Alpha", "Beta"],
      startWeekMsPT,
      numWeeks: 3,
      seasonId: "shift-service",
      timeZone: TIME_ZONE,
    });
    weeks[0].rolloverAtMs = makeUtcMsForTZ(
      {
        year: 2027,
        month: 3,
        day: 15,
        hour: 0,
        minute: 0,
      },
      TIME_ZONE
    );
    const originalFirst = structuredClone(weeks[0]);
    const order = [];
    let saved = null;
    const publisher = createFakePublisher();
    const originalPublish = publisher.publish.bind(publisher);
    publisher.publish = async (...args) => {
      order.push("publish");
      return originalPublish(...args);
    };
    const service = createShiftScheduleService({
      leagueStore: {
        loadLeague: () => ({
          teams: [],
          matchups: { scheduleWeeks: weeks },
        }),
        async saveLeague(state, options) {
          order.push("save");
          saved = {
            state: structuredClone(state),
            options,
          };
        },
      },
      timeZone: TIME_ZONE,
      publisher,
    });

    const result = await service.shiftSchedule({
      fromWeekIndex: 1,
      lockHour: 14,
      lockMinute: 15,
    });

    assert.deepEqual(order, ["save", "publish"]);
    assert.deepEqual(
      saved.state.matchups.scheduleWeeks[0],
      originalFirst
    );
    assert.equal(
      new Date(
        saved.state.matchups.scheduleWeeks[1].weekStartAtMs
      ).toISOString(),
      "2027-03-15T07:00:00.000Z"
    );
    assert.equal(
      saved.state.matchups.scheduleWeeks[2].weekStartAtMs,
      saved.state.matchups.scheduleWeeks[1].rolloverAtMs
    );
    assert.deepEqual(saved.options, {
      savedBy: "commissioner:shiftSchedule",
    });
    assert.deepEqual(result, {
      ok: true,
      shiftedFrom: 1,
      weeksShifted: 2,
    });
    assert.deepEqual(publisher.calls[0], {
      eventName: "league:updated",
      payload: {
        reason: "matchups:scheduleShifted",
        fromWeekIndex: 1,
      },
    });
  });

  test("rejects missing and out-of-range schedules before saving", async () => {
    let saves = 0;
    const leagueStore = {
      loadLeague: () => ({
        matchups: { scheduleWeeks: [] },
      }),
      async saveLeague() {
        saves += 1;
      },
    };
    const service = createShiftScheduleService({
      leagueStore,
      timeZone: TIME_ZONE,
    });

    await assert.rejects(
      service.shiftSchedule({ fromWeekIndex: 0 }),
      (error) =>
        error.statusCode === 400 &&
        error.message === "No scheduleWeeks to shift."
    );

    leagueStore.loadLeague = () => ({
      matchups: {
        scheduleWeeks: [{ weekStartAtMs: 1 }],
      },
    });
    await assert.rejects(
      service.shiftSchedule({ fromWeekIndex: 2 }),
      (error) =>
        error.statusCode === 404 &&
        error.message === "fromWeekIndex out of range."
    );
    assert.equal(saves, 0);
  });
});
