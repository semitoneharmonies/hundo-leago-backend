const path = require("node:path");

const {
  createSecurityFoundations,
} = require("./createSecurityFoundations");
const {
  createTargetHttpServer,
} = require("./createTargetHttpServer");
const {
  openDeployedTargetRuntime,
} = require("./openDeployedTargetRuntime");
const {
  loadTargetRuntimeConfig,
} = require("../config/loadTargetRuntimeConfig");

function reportTargetStartupFailure(error, sink = process.stderr) {
  const record = {
    severity: "error",
    event: "target_runtime.start_failed",
    code:
      typeof error?.code === "string"
        ? error.code
        : "TARGET_RUNTIME_START_FAILED",
    message: "The target runtime failed to start safely.",
    ...(typeof error?.field === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.field)
      ? { field: error.field }
      : {}),
  };
  sink.write(`${JSON.stringify(record)}\n`);
}

async function startTargetProcess({
  env = process.env,
  backendRoot = path.resolve(__dirname, "..", ".."),
  processObject = process,
  loadConfig = loadTargetRuntimeConfig,
  createFoundations = createSecurityFoundations,
  openRuntime = openDeployedTargetRuntime,
  createServer = createTargetHttpServer,
} = {}) {
  if (
    !processObject ||
    typeof processObject.once !== "function" ||
    typeof processObject.off !== "function" ||
    typeof loadConfig !== "function" ||
    typeof createFoundations !== "function" ||
    typeof openRuntime !== "function" ||
    typeof createServer !== "function"
  ) {
    throw new TypeError("target process requires explicit lifecycle adapters");
  }

  const config = loadConfig({ env, backendRoot });
  if (config.debugRoutesEnabled) {
    const error = new Error(
      "Debug routes are unavailable in the deployed target runtime."
    );
    error.code = "TARGET_DEBUG_ROUTES_FORBIDDEN";
    throw error;
  }

  const securityFoundations = createFoundations({
    env,
    loadConfig: () => config.security,
  });
  let runtime;
  let server;
  let shutdownPromise = null;

  function removeSignalHandlers() {
    processObject.off("SIGTERM", onSigterm);
    processObject.off("SIGINT", onSigint);
  }

  function shutdown(signal = "application") {
    if (shutdownPromise) return shutdownPromise;
    securityFoundations.logger.info("target_runtime.shutdown_started", {
      signal,
    });
    shutdownPromise = Promise.resolve()
      .then(() => server.close())
      .then(() => {
        removeSignalHandlers();
        securityFoundations.logger.info("target_runtime.shutdown_complete", {
          signal,
        });
      })
      .catch((error) => {
        removeSignalHandlers();
        processObject.exitCode = 1;
        securityFoundations.logger.error("target_runtime.shutdown_failed", {
          signal,
          error,
        });
        throw error;
      });
    return shutdownPromise;
  }

  function onSigterm() {
    shutdown("SIGTERM").catch(() => {});
  }

  function onSigint() {
    shutdown("SIGINT").catch(() => {});
  }

  try {
    runtime = openRuntime({ config, securityFoundations });
    if (!runtime?.scheduler || typeof runtime.scheduler.start !== "function") {
      const error = new Error(
        "The deployed target scheduler lifecycle is unavailable."
      );
      error.code = "TARGET_SCHEDULER_REQUIRED";
      throw error;
    }
    server = createServer({
      runtime,
      securityConfig: securityFoundations.config,
    });
    processObject.once("SIGTERM", onSigterm);
    processObject.once("SIGINT", onSigint);
    const scheduler = runtime.scheduler.start();
    const address = await server.listen({ port: config.port });
    securityFoundations.logger.info("target_runtime.ready", {
      port: config.port,
    });
    return Object.freeze({
      address,
      config,
      runtime,
      securityFoundations,
      server,
      scheduler,
      shutdown,
    });
  } catch (error) {
    removeSignalHandlers();
    if (server) {
      try {
        await server.close();
      } catch {
        // Preserve the startup failure.
      }
    } else if (runtime && typeof runtime.close === "function") {
      runtime.close();
    }
    throw error;
  }
}

module.exports = {
  reportTargetStartupFailure,
  startTargetProcess,
};
