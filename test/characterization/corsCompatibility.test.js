const assert = require("node:assert/strict");
const { afterEach, describe, test } = require("node:test");

const {
  createApplication,
} = require("../../src/bootstrap/createApplication");
const {
  createHttpServer,
} = require("../../src/bootstrap/createHttpServer");
const {
  COMPATIBILITY_ORIGINS,
  loadConfig,
} = require("../../src/config/loadConfig");

const config = loadConfig({
  env: {},
  existsSync: () => false,
});

let currentRuntime = null;

afterEach(async () => {
  if (!currentRuntime) return;

  const { io, server } = currentRuntime;
  currentRuntime = null;

  await new Promise((resolve) => io.close(resolve));
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) return reject(error);
        resolve();
      });
    });
  }
});

async function startCorsProbe() {
  const app = createApplication(config);
  app.get("/cors-probe", (request, response) => {
    response.json({ ok: true });
  });

  const runtime = createHttpServer({
    app,
    isAllowedOrigin: config.isAllowedOrigin,
  });

  assert.equal(runtime.server.listening, false);
  assert.equal(app.get("io"), runtime.io);

  const address = await runtime.listen({
    port: 0,
    host: "127.0.0.1",
  });

  currentRuntime = runtime;
  return `http://127.0.0.1:${address.port}`;
}

describe("current compatibility CORS behavior", () => {
  test("allows every fixed browser origin with credentials", async () => {
    const baseUrl = await startCorsProbe();

    for (const origin of COMPATIBILITY_ORIGINS) {
      const response = await fetch(`${baseUrl}/cors-probe`, {
        headers: { Origin: origin },
      });

      assert.equal(response.status, 200, origin);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        origin
      );
      assert.equal(
        response.headers.get("access-control-allow-credentials"),
        "true"
      );
    }
  });

  test("allows the current Netlify preview suffix", async () => {
    const baseUrl = await startCorsProbe();
    const origin = "https://deploy-preview-77--hundo.netlify.app";
    const response = await fetch(`${baseUrl}/cors-probe`, {
      headers: { Origin: origin },
    });

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      origin
    );
    assert.equal(
      response.headers.get("access-control-allow-credentials"),
      "true"
    );
  });

  test("allows a request without an Origin header", async () => {
    const baseUrl = await startCorsProbe();
    const response = await fetch(`${baseUrl}/cors-probe`);

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      null
    );
  });

  test("rejects disallowed and malformed origins with the current error", async () => {
    const baseUrl = await startCorsProbe();

    for (const origin of ["https://example.com", "not a valid origin"]) {
      const response = await fetch(`${baseUrl}/cors-probe`, {
        headers: { Origin: origin },
      });

      assert.equal(response.status, 500, origin);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        null
      );
    }
  });

  test("uses the same decisions for the attached Socket.IO server", () => {
    let capturedOptions = null;
    const registrations = [];

    class FakeSocketServer {
      constructor(server, options) {
        assert.ok(server);
        capturedOptions = options;
      }

      on(eventName, handler) {
        registrations.push({ eventName, handler });
      }
    }

    const app = createApplication(config);
    const runtime = createHttpServer({
      app,
      isAllowedOrigin: config.isAllowedOrigin,
      SocketServerClass: FakeSocketServer,
    });

    assert.equal(runtime.server.listening, false);
    assert.equal(app.get("io"), runtime.io);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].eventName, "connection");
    assert.deepEqual(capturedOptions.cors.methods, ["GET", "POST"]);
    assert.equal(capturedOptions.cors.credentials, true);

    capturedOptions.cors.origin(
      "https://hundoleago.netlify.app",
      (error, allowed) => {
        assert.equal(error, null);
        assert.equal(allowed, true);
      }
    );

    capturedOptions.cors.origin("https://example.com", (error) => {
      assert.match(error.message, /^Socket CORS blocked:/);
    });
  });
});
