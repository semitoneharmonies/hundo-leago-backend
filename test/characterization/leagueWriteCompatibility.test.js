const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const { describe, test } = require("node:test");
const express = require("express");

const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");
const { hashFile } = require("../helpers/hashTree");
const { httpRequest } = require("../helpers/httpRequest");
const {
  startCompatibilityServer,
} = require("../helpers/startCompatibilityServer");
const {
  CompatibilityLeagueValidationError,
  validateCompatibilityLeaguePayload,
} = require(
  "../../src/validators/compatibilityLeaguePayload"
);
const {
  createSaveCompatibilityLeagueService,
  projectCompatibilityLeague,
} = require(
  "../../src/application/services/league/saveCompatibilityLeague"
);
const {
  createFakePublisher,
} = require("../helpers/fakePublisher");
const {
  createLeagueWriteCompatibilityRouter,
} = require(
  "../../src/transport/http/routes/leagueWriteCompatibilityRouter"
);

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

function validBody(state, overrides = {}) {
  return {
    teams: state.teams,
    freeAgents: state.freeAgents,
    leagueLog: state.leagueLog,
    tradeProposals: state.tradeProposals,
    tradeBlock: state.tradeBlock,
    ...overrides,
  };
}

async function postLeague(server, body) {
  return httpRequest(
    server.baseUrl,
    "/api/league",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
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

function createMemoryStore(initialState) {
  let state = structuredClone(initialState);
  const saves = [];
  let saveFailure = null;

  return {
    readLeagueState() {
      return structuredClone(state);
    },
    async replaceCompatibilityLeagueState(
      nextState,
      meta
    ) {
      if (saveFailure) throw saveFailure;
      state = structuredClone(nextState);
      saves.push({
        state: structuredClone(nextState),
        meta: structuredClone(meta),
      });
    },
    failSave(error) {
      saveFailure = error;
    },
    saves,
    state() {
      return structuredClone(state);
    },
  };
}

async function startRouterServer({
  service,
  logger = { error() {} },
}) {
  const app = express();
  app.use(express.json());
  app.use(
    createLeagueWriteCompatibilityRouter({
      saveCompatibilityLeagueService: service,
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
  "current broad league write compatibility",
  { concurrency: false },
  () => {
    test("preserves freeze as the first validation guard", async (t) => {
      const { runtime, server } = await withServer(t, {
        async prepare(runtime) {
          const state = await readJson(
            runtime.leagueFile
          );
          state.settings.frozen = true;
          await writeJson(runtime.leagueFile, state);
        },
      });
      const before = await hashFile(runtime.leagueFile);

      const response = await postLeague(server, {});

      assert.equal(response.status, 423);
      assert.deepEqual(response.json, {
        ok: false,
        error:
          "League is frozen. Manager writes are blocked.",
      });
      assert.equal(
        await hashFile(runtime.leagueFile),
        before
      );
    });

    test("preserves wipe, required-array, and optional-matchup validation order", async (t) => {
      const { runtime, server } = await withServer(t);
      const state = await readJson(runtime.leagueFile);
      const before = await hashFile(runtime.leagueFile);

      const wipe = await postLeague(server, {
        teams: [],
      });
      const invalidArrays = await postLeague(server, {
        teams: state.teams,
      });
      const invalidMatchups = await postLeague(
        server,
        validBody(state, {
          matchups: [],
        })
      );

      assert.equal(wipe.status, 400);
      assert.deepEqual(wipe.json, {
        ok: false,
        error:
          "Refusing save: incoming teams is empty (wipe protection).",
      });
      assert.equal(invalidArrays.status, 400);
      assert.deepEqual(invalidArrays.json, {
        ok: false,
        error:
          "Refusing save: invalid payload shape (arrays expected).",
      });
      assert.equal(invalidMatchups.status, 400);
      assert.deepEqual(invalidMatchups.json, {
        ok: false,
        error:
          "Refusing save: matchups must be an object if provided.",
      });
      assert.equal(
        await hashFile(runtime.leagueFile),
        before
      );
    });

    test("manager save updates accepted fields while preserving backend-owned values", async (t) => {
      const { runtime, server } = await withServer(t, {
        async prepare(runtime) {
          const state = await readJson(
            runtime.leagueFile
          );
          state.serverOwned = {
            source: "stored",
          };
          state.nextAuctionDeadline = 12345;
          state.lastAutoWeeklySnapshotId =
            "stored-snapshot";
          state.lastAutoAuctionRolloverId =
            "stored-auction";
          await writeJson(runtime.leagueFile, state);
        },
      });
      const state = await readJson(runtime.leagueFile);
      const incomingTeams = structuredClone(state.teams);
      incomingTeams[0].displayNote = "manager update";

      const response = await postLeague(
        server,
        validBody(state, {
          meta: {
            actorRole: "Manager",
            actorTeam: "Test Team Alpha",
          },
          teams: incomingTeams,
          freeAgents: [
            {
              id: "bid-1",
              player: "New Bid",
            },
          ],
          leagueLog: [{ type: "managerLog" }],
          tradeProposals: [{ id: "trade-1" }],
          tradeBlock: [{ id: "block-1" }],
          matchups: {
            seasonId: "manager-overwrite",
          },
          nextAuctionDeadline: 0,
          lastAutoWeeklySnapshotId:
            "body-snapshot",
          lastAutoAuctionRolloverId:
            "body-auction",
          serverOwned: {
            source: "body",
          },
          schemaVersion: 999,
        })
      );
      const saved = await readJson(runtime.leagueFile);

      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true });
      assert.equal(
        saved.teams[0].displayNote,
        "manager update"
      );
      assert.equal(saved.freeAgents.length, 1);
      assert.deepEqual(saved.leagueLog, [
        { type: "managerLog" },
      ]);
      assert.equal(saved.tradeProposals.length, 1);
      assert.equal(saved.tradeBlock.length, 1);
      assert.deepEqual(saved.matchups, state.matchups);
      assert.deepEqual(saved.serverOwned, {
        source: "stored",
      });
      assert.equal(saved.schemaVersion, 1);
      assert.equal(saved.nextAuctionDeadline, 12345);
      assert.equal(
        saved.lastAutoWeeklySnapshotId,
        "stored-snapshot"
      );
      assert.equal(
        saved.lastAutoAuctionRolloverId,
        "stored-auction"
      );
      assert.equal(
        saved.meta.lastSavedBy,
        "Test Team Alpha"
      );
    });

    test("commissioner may write while frozen and replace matchups", async (t) => {
      const { runtime, server } = await withServer(t, {
        async prepare(runtime) {
          const state = await readJson(
            runtime.leagueFile
          );
          state.settings.frozen = true;
          await writeJson(runtime.leagueFile, state);
        },
      });
      const state = await readJson(runtime.leagueFile);
      const replacementMatchups = {
        seasonId: "commissioner-season",
        scheduleWeeks: [],
        currentWeekIndex: 2,
        currentWeekId: "commissioner-week",
        locksByTeam: {},
        baselineByPlayerId: {},
        baselineByWeekId: {},
        resultsByWeek: {},
        lastRolloverWeekId: null,
      };

      const response = await postLeague(
        server,
        validBody(state, {
          meta: {
            actorRole: "COMMISSIONER",
            actorTeam: "Ignored Team",
          },
          matchups: replacementMatchups,
          settings: { frozen: false },
          nextAuctionDeadline: 67890,
        })
      );
      const saved = await readJson(runtime.leagueFile);

      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true });
      assert.deepEqual(
        saved.matchups,
        replacementMatchups
      );
      assert.equal(saved.settings.frozen, false);
      assert.equal(saved.nextAuctionDeadline, 67890);
      assert.equal(
        saved.meta.lastSavedBy,
        "commissioner"
      );
    });
  }
);

describe(
  "broad league compatibility validator",
  () => {
    test("returns current normalized role and input references on success", () => {
      const state = {
        teams: [{ name: "Alpha" }],
        settings: { frozen: false },
      };
      const body = {
        meta: {
          actorRole: "COMMISSIONER",
        },
        teams: [{ name: "Alpha" }],
        freeAgents: [],
        leagueLog: [],
        tradeProposals: [],
        tradeBlock: [],
        matchups: {},
      };

      assert.deepEqual(
        validateCompatibilityLeaguePayload({
          storedState: state,
          body,
        }),
        {
          body,
          meta: body.meta,
          role: "commissioner",
        }
      );
    });

    test("preserves typed freeze, wipe, array, and matchup failures in order", () => {
      const frozenState = {
        teams: [{ name: "Alpha" }],
        settings: { frozen: true },
      };
      const activeState = {
        teams: [{ name: "Alpha" }],
        settings: { frozen: false },
      };

      assert.throws(
        () =>
          validateCompatibilityLeaguePayload({
            storedState: frozenState,
            body: {},
          }),
        (error) => {
          assert.equal(
            error instanceof
              CompatibilityLeagueValidationError,
            true
          );
          assert.equal(error.code, "LEAGUE_FROZEN");
          assert.equal(error.statusCode, 423);
          return true;
        }
      );
      assert.throws(
        () =>
          validateCompatibilityLeaguePayload({
            storedState: activeState,
            body: {},
          }),
        (error) => {
          assert.equal(
            error.code,
            "WIPE_PROTECTION"
          );
          return true;
        }
      );
      assert.throws(
        () =>
          validateCompatibilityLeaguePayload({
            storedState: activeState,
            body: { teams: activeState.teams },
          }),
        (error) => {
          assert.equal(error.code, "INVALID_ARRAYS");
          return true;
        }
      );
      assert.throws(
        () =>
          validateCompatibilityLeaguePayload({
            storedState: activeState,
            body: validBody({
              teams: activeState.teams,
              freeAgents: [],
              leagueLog: [],
              tradeProposals: [],
              tradeBlock: [],
            }, {
              matchups: null,
            }),
          }),
        (error) => {
          assert.equal(
            error.code,
            "INVALID_MATCHUPS"
          );
          return true;
        }
      );
    });

    test("missing arrays reach shape validation when stored teams are already empty", () => {
      assert.throws(
        () =>
          validateCompatibilityLeaguePayload({
            storedState: {
              teams: [],
              settings: { frozen: false },
            },
            body: {},
          }),
        (error) => {
          assert.equal(error.code, "INVALID_ARRAYS");
          assert.equal(error.statusCode, 400);
          return true;
        }
      );
    });
  }
);

describe(
  "broad league compatibility save service",
  () => {
    test("manager projection preserves stored server-owned fields and compatibility fallbacks", async () => {
      const storedState = {
        schemaVersion: 1,
        serverOwned: { source: "stored" },
        teams: [{ name: "Stored Team" }],
        freeAgents: [],
        leagueLog: [],
        tradeProposals: [],
        tradeBlock: [],
        matchups: { seasonId: "stored-season" },
        settings: { frozen: false, mode: "stored" },
        nextAuctionDeadline: 12345,
        lastAutoWeeklySnapshotId:
          "stored-snapshot",
        lastAutoAuctionRolloverId:
          "stored-auction",
      };
      const body = validBody(storedState, {
        meta: {
          actorRole: "manager",
          actorTeam: "Manager Team",
        },
        teams: [{ name: "Manager Team" }],
        matchups: { seasonId: "body-season" },
        settings: undefined,
        nextAuctionDeadline: 0,
        schemaVersion: 999,
        serverOwned: { source: "body" },
        lastAutoWeeklySnapshotId:
          "body-snapshot",
        lastAutoAuctionRolloverId:
          "body-auction",
      });
      const publisher = createFakePublisher();
      const store = createMemoryStore(storedState);
      const service =
        createSaveCompatibilityLeagueService({
          leagueRepository: store,
          publisher,
        });

      assert.deepEqual(await service.save(body), {
        ok: true,
      });
      assert.equal(store.saves.length, 1);
      assert.deepEqual(store.saves[0].meta, {
        savedBy: "Manager Team",
      });
      assert.deepEqual(
        store.state().matchups,
        storedState.matchups
      );
      assert.deepEqual(
        store.state().settings,
        storedState.settings
      );
      assert.equal(
        store.state().nextAuctionDeadline,
        12345
      );
      assert.equal(store.state().schemaVersion, 1);
      assert.deepEqual(store.state().serverOwned, {
        source: "stored",
      });
      assert.equal(
        store.state().lastAutoWeeklySnapshotId,
        "stored-snapshot"
      );
      assert.equal(
        store.state().lastAutoAuctionRolloverId,
        "stored-auction"
      );
      assert.deepEqual(publisher.calls, [
        {
          eventName: "league:updated",
          payload: { reason: "saveLeague" },
        },
      ]);
    });

    test("commissioner projection accepts matchups, truthy deadline, and current object-like settings", () => {
      const storedState = {
        teams: [{ name: "Stored Team" }],
        freeAgents: [],
        leagueLog: [],
        tradeProposals: [],
        tradeBlock: [],
        matchups: { seasonId: "stored-season" },
        settings: { frozen: true },
        nextAuctionDeadline: 12345,
        lastAutoWeeklySnapshotId: "snapshot",
        lastAutoAuctionRolloverId: "auction",
      };
      const body = validBody(storedState, {
        teams: [{ name: "Commissioner Team" }],
        matchups: {
          seasonId: "commissioner-season",
        },
        settings: [],
        nextAuctionDeadline: 67890,
      });

      const projected = projectCompatibilityLeague({
        storedState,
        body,
        role: "commissioner",
      });

      assert.deepEqual(projected.matchups, {
        seasonId: "commissioner-season",
      });
      assert.deepEqual(projected.settings, []);
      assert.equal(
        projected.nextAuctionDeadline,
        67890
      );
      assert.equal(
        projected.lastAutoWeeklySnapshotId,
        "snapshot"
      );
      assert.equal(
        projected.lastAutoAuctionRolloverId,
        "auction"
      );
    });

    test("validation and save failures do not publish, while event failure follows save", async () => {
      const storedState = {
        teams: [{ name: "Stored Team" }],
        freeAgents: [],
        leagueLog: [],
        tradeProposals: [],
        tradeBlock: [],
        matchups: {},
        settings: { frozen: false },
      };

      const validationStore =
        createMemoryStore(storedState);
      const validationPublisher =
        createFakePublisher();
      const validationService =
        createSaveCompatibilityLeagueService({
          leagueRepository: validationStore,
          publisher: validationPublisher,
        });
      await assert.rejects(
        validationService.save({}),
        CompatibilityLeagueValidationError
      );
      assert.equal(validationStore.saves.length, 0);
      assert.equal(
        validationPublisher.calls.length,
        0
      );

      const body = validBody(storedState);
      const saveStore = createMemoryStore(storedState);
      saveStore.failSave(new Error("save failed"));
      const savePublisher = createFakePublisher();
      const saveService =
        createSaveCompatibilityLeagueService({
          leagueRepository: saveStore,
          publisher: savePublisher,
        });
      await assert.rejects(
        saveService.save(body),
        /save failed/
      );
      assert.equal(saveStore.saves.length, 0);
      assert.equal(savePublisher.calls.length, 0);

      const eventStore = createMemoryStore(storedState);
      const eventPublisher = createFakePublisher();
      eventPublisher.failNext(
        new Error("event failed")
      );
      const eventService =
        createSaveCompatibilityLeagueService({
          leagueRepository: eventStore,
          publisher: eventPublisher,
        });
      await assert.rejects(
        eventService.save(body),
        /event failed/
      );
      assert.equal(eventStore.saves.length, 1);
    });
  }
);

describe(
  "broad league compatibility router",
  { concurrency: false },
  () => {
    test("maps success, typed validation, and generic failure responses", async (t) => {
      const successServer = await startRouterServer({
        service: {
          async save(body) {
            assert.deepEqual(body, {
              example: true,
            });
          },
        },
      });
      t.after(() => successServer.stop());
      const success = await httpRequest(
        successServer.baseUrl,
        "/api/league",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            example: true,
          }),
        }
      );
      assert.equal(success.status, 200);
      assert.deepEqual(success.json, { ok: true });

      const validationServer =
        await startRouterServer({
          service: {
            async save() {
              throw new CompatibilityLeagueValidationError(
                "typed failure",
                {
                  code: "TYPED",
                  statusCode: 423,
                }
              );
            },
          },
        });
      t.after(() => validationServer.stop());
      const validation = await httpRequest(
        validationServer.baseUrl,
        "/api/league",
        { method: "POST" }
      );
      assert.equal(validation.status, 423);
      assert.deepEqual(validation.json, {
        ok: false,
        error: "typed failure",
      });

      const errors = [];
      const failureServer = await startRouterServer({
        service: {
          async save() {
            throw new Error("save failed");
          },
        },
        logger: {
          error(...args) {
            errors.push(args);
          },
        },
      });
      t.after(() => failureServer.stop());
      const failure = await httpRequest(
        failureServer.baseUrl,
        "/api/league",
        { method: "POST" }
      );
      assert.equal(failure.status, 500);
      assert.deepEqual(failure.json, {
        ok: false,
        error: "Failed to save state",
      });
      assert.equal(errors.length, 1);
    });
  }
);
