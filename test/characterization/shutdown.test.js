const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { describe, test } = require("node:test");

const {
  createApplication,
} = require("../../src/bootstrap/createApplication");
const {
  createHttpServer,
} = require("../../src/bootstrap/createHttpServer");
const {
  createShutdown,
} = require("../../src/bootstrap/shutdown");
const { loadConfig } = require("../../src/config/loadConfig");

function createCallbackCloseTarget({ listening = true } = {}) {
  return {
    closeCalls: 0,
    listening,
    close(callback) {
      this.closeCalls += 1;
      this.listening = false;
      callback();
    },
  };
}

describe("bootstrap shutdown lifecycle", () => {
  test("clears tracked intervals and closes each transport once", async () => {
    const cleared = [];
    const server = createCallbackCloseTarget();
    const io = createCallbackCloseTarget();
    const lifecycle = createShutdown({
      server,
      io,
      clearIntervalFn: (handle) => cleared.push(handle),
    });

    lifecycle.trackInterval("timer-a");
    lifecycle.trackInterval("timer-b");

    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();

    assert.equal(first, second);
    await first;
    assert.deepEqual(cleared, ["timer-a", "timer-b"]);
    assert.equal(io.closeCalls, 1);
    assert.equal(server.closeCalls, 1);
  });

  test("handles a never-started HTTP server safely", async () => {
    const server = createCallbackCloseTarget({ listening: false });
    const lifecycle = createShutdown({ server });

    await lifecycle.shutdown();
    assert.equal(server.closeCalls, 0);
  });

  test("closes a real loopback server and its tracked timer", async () => {
    const config = loadConfig({
      env: { NODE_ENV: "test" },
      existsSync: () => false,
    });
    const app = createApplication(config);
    app.get("/shutdown-probe", (request, response) => {
      response.json({ ok: true });
    });

    const runtime = createHttpServer({
      app,
      isAllowedOrigin: config.isAllowedOrigin,
    });
    const lifecycle = createShutdown({
      server: runtime.server,
      io: runtime.io,
    });
    const timer = lifecycle.trackInterval(
      setInterval(() => {}, 60 * 1000)
    );

    const address = await runtime.listen({
      port: 0,
      host: "127.0.0.1",
    });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const before = await fetch(`${baseUrl}/shutdown-probe`);

    assert.equal(before.status, 200);
    await lifecycle.shutdown();
    assert.equal(runtime.server.listening, false);
    assert.equal(timer._destroyed, true);

    await assert.rejects(fetch(`${baseUrl}/shutdown-probe`));
  });

  test("installs each signal once and disposes listeners", async () => {
    const processRef = new EventEmitter();
    processRef.exitCode = undefined;
    const server = createCallbackCloseTarget();
    const lifecycle = createShutdown({
      server,
      processRef,
      logger: {
        error() {},
      },
    });

    const dispose = lifecycle.installSignalHandlers();
    lifecycle.installSignalHandlers();

    assert.equal(processRef.listenerCount("SIGINT"), 1);
    assert.equal(processRef.listenerCount("SIGTERM"), 1);

    processRef.emit("SIGTERM");
    await lifecycle.shutdown();

    assert.equal(server.closeCalls, 1);
    assert.equal(processRef.listenerCount("SIGINT"), 0);
    assert.equal(processRef.listenerCount("SIGTERM"), 0);
    assert.equal(processRef.exitCode, undefined);

    dispose();
    assert.equal(processRef.listenerCount("SIGINT"), 0);
    assert.equal(processRef.listenerCount("SIGTERM"), 0);
  });
});
