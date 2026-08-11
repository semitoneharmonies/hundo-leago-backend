const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");

const {
  startBackendProcess,
} = require("../../src/bootstrap/startBackendProcess");
const {
  createStagingMaintenanceHoldServer,
  startStagingMaintenanceHoldProcess,
} = require(
  "../../src/bootstrap/startStagingMaintenanceHoldProcess"
);
const {
  REQUIRED_HOLD_VALUES,
  StagingMaintenanceHoldConfigError,
  loadStagingMaintenanceHoldConfig,
} = require(
  "../../src/config/loadStagingMaintenanceHoldConfig"
);

function holdEnvironment(overrides = {}) {
  return {
    ...REQUIRED_HOLD_VALUES,
    PORT: "10000",
    STAGING_MAINTENANCE_HOLD: "true",
    ...overrides,
  };
}

function processDouble() {
  const emitter = new EventEmitter();
  emitter.exitCode = undefined;
  return emitter;
}

function request({ method = "GET", path: requestPath, port }) {
  return new Promise((resolve, reject) => {
    const request_ = http.request(
      {
        host: "127.0.0.1",
        method,
        path: requestPath,
        port,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      }
    );
    request_.on("error", reject);
    request_.end();
  });
}

test("missing or exact-false hold preserves normal runtime dispatch without validating hold prerequisites", async () => {
  for (const env of [{}, { STAGING_MAINTENANCE_HOLD: "false" }]) {
    const calls = [];
    const processObject = processDouble();
    const result = await startBackendProcess({
      backendRoot: "C:\\isolated-backend",
      env,
      loadHoldStarter() {
        calls.push("load-hold");
        throw new Error("hold must not load");
      },
      loadTargetStarter() {
        calls.push("load-target");
        return async (options) => {
          calls.push("start-target");
          assert.equal(options.env, env);
          assert.equal(options.processObject, processObject);
          assert.equal(options.backendRoot, "C:\\isolated-backend");
          return "target-runtime";
        };
      },
      processObject,
    });

    assert.equal(result, "target-runtime");
    assert.deepEqual(calls, ["load-target", "start-target"]);
  }
});

test("hold configuration is exact, staging-only, and validates every quiescence prerequisite", () => {
  assert.deepEqual(
    loadStagingMaintenanceHoldConfig({ env: holdEnvironment() }),
    { enabled: true, port: 10000 }
  );
  assert.deepEqual(
    loadStagingMaintenanceHoldConfig({ env: {} }),
    { enabled: false }
  );
  assert.deepEqual(
    loadStagingMaintenanceHoldConfig({
      env: { STAGING_MAINTENANCE_HOLD: "false" },
    }),
    { enabled: false }
  );

  const driftCases = [
    ["STAGING_MAINTENANCE_HOLD", "TRUE"],
    ...Object.keys(REQUIRED_HOLD_VALUES).map((field) => [field, "drift"]),
    ["PORT", "0"],
    ["PORT", "65536"],
  ];
  for (const [field, value] of driftCases) {
    assert.throws(
      () =>
        loadStagingMaintenanceHoldConfig({
          env: holdEnvironment({ [field]: value }),
        }),
      (error) =>
        error instanceof StagingMaintenanceHoldConfigError &&
        error.code === "STAGING_MAINTENANCE_HOLD_CONFIG_INVALID" &&
        error.field === field,
      `${field} drift must fail closed`
    );
  }
});

test("malformed or drifted hold fails before either process runtime loader", async () => {
  for (const env of [
    { STAGING_MAINTENANCE_HOLD: "yes" },
    holdEnvironment({ APP_ENV: "production" }),
    holdEnvironment({ LEAGUE_WRITE_MODE: "open" }),
  ]) {
    const calls = [];
    await assert.rejects(
      startBackendProcess({
        env,
        loadHoldStarter() {
          calls.push("load-hold");
        },
        loadTargetStarter() {
          calls.push("load-target");
        },
      }),
      { code: "STAGING_MAINTENANCE_HOLD_CONFIG_INVALID" }
    );
    assert.deepEqual(calls, []);
  }
});

test("enabled hold lazily avoids the target, database, app, route, job, socket, and email runtime", async () => {
  const forbiddenModules = [
    "../../src/bootstrap/startTargetProcess",
    "../../src/bootstrap/createTargetHttpServer",
    "../../src/bootstrap/openDeployedTargetRuntime",
  ].map((relativePath) => require.resolve(relativePath));
  for (const modulePath of forbiddenModules) delete require.cache[modulePath];

  const processObject = processDouble();
  const result = await startBackendProcess({
    env: holdEnvironment(),
    loadHoldStarter() {
      return async ({ config, processObject: receivedProcess }) => {
        assert.deepEqual(config, { enabled: true, port: 10000 });
        assert.equal(receivedProcess, processObject);
        return "hold-runtime";
      };
    },
    processObject,
  });

  assert.equal(result, "hold-runtime");
  for (const modulePath of forbiddenModules) {
    assert.equal(require.cache[modulePath], undefined);
  }

  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "src",
      "bootstrap",
      "startStagingMaintenanceHoldProcess.js"
    ),
    "utf8"
  );
  assert.deepEqual(
    [...source.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]),
    ["node:http"]
  );
});

test("hold HTTP surface exposes only generic GET and HEAD liveness and readiness", async (t) => {
  const server = createStagingMaintenanceHoldServer();
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());

  for (const requestPath of [
    "/api/v1/health/live",
    "/api/v1/health/ready",
  ]) {
    const getResponse = await request({
      path: requestPath,
      port: address.port,
    });
    assert.equal(getResponse.statusCode, 200);
    assert.equal(getResponse.body, '{"status":"ok"}');
    assert.equal(getResponse.headers["access-control-allow-origin"], undefined);
    assert.equal(getResponse.headers["x-powered-by"], undefined);

    const headResponse = await request({
      method: "HEAD",
      path: requestPath,
      port: address.port,
    });
    assert.equal(headResponse.statusCode, 200);
    assert.equal(headResponse.body, "");
  }

  for (const requestCase of [
    { method: "OPTIONS", path: "/api/v1/health/ready" },
    { method: "POST", path: "/api/v1/health/live" },
    { method: "PUT", path: "/api/v1/health/live" },
    { method: "PATCH", path: "/api/v1/health/ready" },
    { method: "DELETE", path: "/api/v1/health/ready" },
    { method: "GET", path: "/api/v1/health/ready?detail=true" },
    { method: "GET", path: "/api/v1/health/live/" },
    { method: "GET", path: "/api/v1/leagues" },
    { method: "GET", path: "/" },
  ]) {
    const response = await request({
      ...requestCase,
      port: address.port,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(
      response.body,
      '{"error":{"code":"SERVICE_MAINTENANCE","message":"Service is temporarily unavailable."}}'
    );
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.doesNotMatch(
      JSON.stringify(response),
      /(?:database|sqlite|schema|build|commit|staging|socket|email)/iu
    );
  }
});

test("hold lifecycle handles SIGTERM and SIGINT with one idempotent shutdown", async () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const processObject = processDouble();
    const runtime = await startStagingMaintenanceHoldProcess({
      config: Object.freeze({ enabled: true, port: 0 }),
      processObject,
      createServer() {
        const server = createStagingMaintenanceHoldServer();
        return Object.freeze({
          ...server,
          listen() {
            return server.listen({ host: "127.0.0.1", port: 0 });
          },
        });
      },
    });

    assert.equal(runtime.mode, "staging-maintenance-hold");
    assert.equal(processObject.listenerCount("SIGTERM"), 1);
    assert.equal(processObject.listenerCount("SIGINT"), 1);
    processObject.emit(signal);
    const shutdown = runtime.shutdown();
    assert.equal(runtime.shutdown(), shutdown);
    await shutdown;
    assert.equal(processObject.listenerCount("SIGTERM"), 0);
    assert.equal(processObject.listenerCount("SIGINT"), 0);
    assert.equal(processObject.exitCode, undefined);
  }
});
