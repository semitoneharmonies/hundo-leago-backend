const http = require("node:http");

const HEALTH_PATHS = new Set([
  "/api/v1/health/live",
  "/api/v1/health/ready",
]);
const HEALTH_BODY = JSON.stringify({ status: "ok" });
const MAINTENANCE_BODY = JSON.stringify({
  error: {
    code: "SERVICE_MAINTENANCE",
    message: "Service is temporarily unavailable.",
  },
});

function writeJson(response, statusCode, body, { head = false } = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(head ? undefined : body);
}

function handleMaintenanceHoldRequest(request, response) {
  const isHealth = HEALTH_PATHS.has(request.url);
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (isHealth && isRead) {
    writeJson(response, 200, HEALTH_BODY, {
      head: request.method === "HEAD",
    });
    return;
  }
  writeJson(response, 503, MAINTENANCE_BODY, {
    head: request.method === "HEAD",
  });
}

function createStagingMaintenanceHoldServer() {
  const nodeServer = http.createServer(handleMaintenanceHoldRequest);

  function listen({ port, host } = {}) {
    return new Promise((resolve, reject) => {
      function onError(error) {
        nodeServer.off("listening", onListening);
        reject(error);
      }
      function onListening() {
        nodeServer.off("error", onError);
        resolve(nodeServer.address());
      }
      nodeServer.once("error", onError);
      nodeServer.once("listening", onListening);
      nodeServer.listen({
        port,
        ...(host === undefined ? {} : { host }),
      });
    });
  }

  function close() {
    if (!nodeServer.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      nodeServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  return Object.freeze({ close, listen, nodeServer });
}

async function startStagingMaintenanceHoldProcess({
  config,
  processObject = process,
  createServer = createStagingMaintenanceHoldServer,
} = {}) {
  if (
    config?.enabled !== true ||
    !Number.isSafeInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535 ||
    !processObject ||
    typeof processObject.once !== "function" ||
    typeof processObject.off !== "function" ||
    typeof createServer !== "function"
  ) {
    throw new TypeError(
      "maintenance-hold process requires explicit validated adapters"
    );
  }

  const server = createServer();
  let shutdownPromise = null;

  function removeSignalHandlers() {
    processObject.off("SIGTERM", onSigterm);
    processObject.off("SIGINT", onSigint);
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = Promise.resolve()
      .then(() => server.close())
      .then(removeSignalHandlers)
      .catch((error) => {
        removeSignalHandlers();
        processObject.exitCode = 1;
        throw error;
      });
    return shutdownPromise;
  }

  function onSigterm() {
    shutdown().catch(() => {});
  }

  function onSigint() {
    shutdown().catch(() => {});
  }

  processObject.once("SIGTERM", onSigterm);
  processObject.once("SIGINT", onSigint);
  try {
    const address = await server.listen({ port: config.port });
    return Object.freeze({
      address,
      config,
      mode: "staging-maintenance-hold",
      server,
      shutdown,
    });
  } catch (error) {
    removeSignalHandlers();
    try {
      await server.close();
    } catch {
      // Preserve the startup failure.
    }
    throw error;
  }
}

module.exports = {
  createStagingMaintenanceHoldServer,
  handleMaintenanceHoldRequest,
  startStagingMaintenanceHoldProcess,
};
