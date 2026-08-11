const {
  reportTargetStartupFailure,
  startBackendProcess,
} = require("./src/bootstrap/startBackendProcess");

startBackendProcess().catch((error) => {
  reportTargetStartupFailure(error);
  process.exitCode = 1;
});
