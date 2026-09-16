const { assertProductionMaintenanceInactive } = require("./src/config/loadProductionMaintenanceConfig");
try {
  assertProductionMaintenanceInactive();
} catch {
  console.error(JSON.stringify({ severity: "error", event: "compatibility_runtime.start_failed",
    code: "PRODUCTION_MAINTENANCE_ENTRYPOINT_REQUIRED", field: "PRODUCTION_MAINTENANCE_HOLD",
    message: "Use the confirmed production maintenance entrypoint while the hold is set." }));
  process.exit(1);
}

const {
  createCompatibilityRuntime,
} = require(
  "./src/bootstrap/createCompatibilityRuntime"
);
const {
  loadConfig,
} = require("./src/config/loadConfig");

const config = loadConfig({
  backendRoot: __dirname,
});
console.log(
  "SERVER ENTRY LOADED: server-compatibility.js",
  new Date().toISOString()
);

const {
  listen,
  shutdown,
  startBackgroundJobs,
} = createCompatibilityRuntime({
  config,
  backendRoot: __dirname,
});

startBackgroundJobs();
shutdown.installSignalHandlers();

listen({ port: config.port })
  .then(() => {
    console.log(
      `Hundo Leago backend + WebSocket listening on port ${config.port}`
    );
  })
  .catch(async (error) => {
    console.error(
      "[BACKEND] Failed to start compatibility HTTP server:",
      error?.message || error
    );
    process.exitCode = 1;
    try {
      await shutdown.shutdown();
    } catch (shutdownError) {
      console.error(
        "[BACKEND] Compatibility startup cleanup failed:",
        shutdownError?.message || shutdownError
      );
    }
  });
