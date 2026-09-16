const http = require("node:http");
const { loadProductionMaintenanceConfig } = require("../config/loadProductionMaintenanceConfig");
// Reuse only the generic HTTP response handler. The staging configuration and
// process entrypoint remain unchanged and are never invoked for production.
const { handleMaintenanceHoldRequest } = require("./startStagingMaintenanceHoldProcess");

async function startProductionMaintenanceProcess({
  env = process.env,
  processObject = process,
  createServer = http.createServer,
} = {}) {
  // Validate before creating a server or registering lifecycle handlers.
  const config = loadProductionMaintenanceConfig({ env });
  if (!processObject || typeof processObject.once !== "function" || typeof processObject.off !== "function" ||
      typeof createServer !== "function") throw new TypeError("production maintenance lifecycle adapters are required");
  const server = createServer(handleMaintenanceHoldRequest);
  // Bound clients that connect but do not complete a request during a cutover.
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  let stopping;
  function removeHandlers() {
    processObject.off("SIGTERM", onSignal);
    processObject.off("SIGINT", onSignal);
  }
  function shutdown() {
    if (stopping) return stopping;
    stopping = new Promise((resolve, reject) => {
      if (!server.listening) { removeHandlers(); resolve(); return; }
      server.close((error) => {
        removeHandlers();
        if (error) { processObject.exitCode = 1; reject(error); }
        else resolve();
      });
      // There is no application request or transaction to drain in this process.
      server.closeAllConnections();
    });
    return stopping;
  }
  function onSignal() { shutdown().catch(() => {}); }
  try {
    await new Promise((resolve, reject) => {
      function onError(error) { server.off("listening", onListening); reject(error); }
      function onListening() { server.off("error", onError); resolve(); }
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ port: config.port, host: "0.0.0.0" });
    });
    // Before listening, the process retains normal OS termination behavior.
    // Registering early could consume a signal before the listener can close.
    processObject.once("SIGTERM", onSignal);
    processObject.once("SIGINT", onSignal);
    return Object.freeze({ mode: "production-maintenance", config, server, address: server.address(), shutdown });
  } catch (error) {
    removeHandlers();
    try { server.close(); server.closeAllConnections(); } catch { /* Preserve startup failure. */ }
    throw error;
  }
}

module.exports = { startProductionMaintenanceProcess };
