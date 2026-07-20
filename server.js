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
  "SERVER ENTRY LOADED: server.js",
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
      "[BACKEND] Failed to start HTTP server:",
      error?.message || error
    );
    process.exitCode = 1;
    try {
      await shutdown.shutdown();
    } catch (shutdownError) {
      console.error(
        "[BACKEND] Startup cleanup failed:",
        shutdownError?.message || shutdownError
      );
    }
  });
