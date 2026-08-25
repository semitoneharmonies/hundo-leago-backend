const assert = require("node:assert/strict");
const { once } = require("node:events");
const { describe, test } = require("node:test");

const express = require("express");

const {
  createSaveCompatibilityLeagueService,
} = require(
  "../../src/application/services/league/saveCompatibilityLeague"
);
const {
  createApplication,
} = require("../../src/bootstrap/createApplication");
const {
  createHttpServer,
} = require("../../src/bootstrap/createHttpServer");
const {
  loadConfig,
} = require("../../src/config/loadConfig");
const {
  createSocketIoCompatibilityPublisher,
} = require(
  "../../src/infrastructure/realtime/SocketIoCompatibilityPublisher"
);
const {
  createLeagueWriteCompatibilityRouter,
} = require(
  "../../src/transport/http/routes/leagueWriteCompatibilityRouter"
);
const {
  httpRequest,
} = require("../helpers/httpRequest");

function createState() {
  return {
    teams: [{ name: "Socket Test Team" }],
    freeAgents: [],
    leagueLog: [],
    tradeProposals: [],
    tradeBlock: [],
    matchups: {},
    settings: { frozen: false },
  };
}

function createRepository({
  order,
  saveFailure = null,
} = {}) {
  let state = createState();

  return {
    readLeagueState() {
      return structuredClone(state);
    },
    async replaceCompatibilityLeagueState(nextState) {
      if (saveFailure) throw saveFailure;
      order?.push("save");
      state = structuredClone(nextState);
    },
  };
}

async function startWriteServer({
  io,
  repository,
  order,
}) {
  const app = express();
  app.use(express.json());
  if (io) app.set("io", io);

  const publisher =
    createSocketIoCompatibilityPublisher({ app });
  const service =
    createSaveCompatibilityLeagueService({
      leagueRepository: repository,
      publisher,
    });
  app.use(
    createLeagueWriteCompatibilityRouter({
      saveCompatibilityLeagueService: service,
      logger: { error() {} },
    })
  );

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async post() {
      return httpRequest(
        this.baseUrl,
        "/api/league",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(createState()),
        }
      );
    },
    async stop() {
      server.close();
      await once(server, "close");
    },
    order,
  };
}

describe("Socket.IO compatibility restoration", () => {
  test("attaches the exact Socket.IO server and one connection handler", () => {
    const registrations = [];

    class FakeSocketServer {
      constructor(server, options) {
        this.server = server;
        this.options = options;
      }

      on(eventName, handler) {
        registrations.push({ eventName, handler });
      }
    }

    const config = loadConfig({
      env: { NODE_ENV: "test" },
      existsSync: () => false,
    });
    const app = createApplication(config);
    const runtime = createHttpServer({
      app,
      isAllowedOrigin: config.isAllowedOrigin,
      SocketServerClass: FakeSocketServer,
    });

    assert.equal(app.get("io"), runtime.io);
    assert.equal(registrations.length, 1);
    assert.equal(
      registrations[0].eventName,
      "connection"
    );
    assert.equal(
      typeof registrations[0].handler,
      "function"
    );
  });

  test("emits once only after a committed compatibility write", async (t) => {
    const order = [];
    const emissions = [];
    const io = {
      emit(eventName, payload) {
        order.push("emit");
        emissions.push({ eventName, payload });
      },
    };
    const repository = createRepository({ order });
    const server = await startWriteServer({
      io,
      repository,
      order,
    });
    t.after(() => server.stop());

    const response = await server.post();

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true });
    assert.deepEqual(order, ["save", "emit"]);
    assert.deepEqual(emissions, [
      {
        eventName: "league:updated",
        payload: { reason: "saveLeague" },
      },
    ]);
  });

  test("save failure emits nothing and unavailable Socket.IO leaves HTTP working", async (t) => {
    const failedEmissions = [];
    const failedServer = await startWriteServer({
      io: {
        emit(eventName, payload) {
          failedEmissions.push({
            eventName,
            payload,
          });
        },
      },
      repository: createRepository({
        saveFailure: new Error("simulated save failure"),
      }),
    });
    t.after(() => failedServer.stop());

    const failedResponse = await failedServer.post();
    assert.equal(failedResponse.status, 500);
    assert.deepEqual(failedEmissions, []);

    const unavailableServer = await startWriteServer({
      repository: createRepository(),
    });
    t.after(() => unavailableServer.stop());

    const unavailableResponse =
      await unavailableServer.post();
    assert.equal(unavailableResponse.status, 200);
    assert.deepEqual(unavailableResponse.json, {
      ok: true,
    });
  });
});
