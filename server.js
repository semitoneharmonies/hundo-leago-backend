const {
  reportTargetStartupFailure,
  startTargetProcess,
} = require("./src/bootstrap/startTargetProcess");

startTargetProcess().catch((error) => {
  reportTargetStartupFailure(error);
  process.exitCode = 1;
});
