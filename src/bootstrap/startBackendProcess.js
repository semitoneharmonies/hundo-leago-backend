const {
  loadStagingMaintenanceHoldConfig,
} = require("../config/loadStagingMaintenanceHoldConfig");

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
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.field)
      ? { field: error.field }
      : {}),
  };
  sink.write(`${JSON.stringify(record)}\n`);
}

function loadTargetProcess() {
  return require("./startTargetProcess").startTargetProcess;
}

function loadMaintenanceHoldProcess() {
  return require("./startStagingMaintenanceHoldProcess")
    .startStagingMaintenanceHoldProcess;
}

async function startBackendProcess({
  env = process.env,
  backendRoot,
  processObject = process,
  loadHoldConfig = loadStagingMaintenanceHoldConfig,
  loadTargetStarter = loadTargetProcess,
  loadHoldStarter = loadMaintenanceHoldProcess,
} = {}) {
  if (typeof loadHoldConfig !== "function") {
    throw new TypeError("maintenance-hold config loader is required");
  }

  const hold = loadHoldConfig({ env });
  if (hold.enabled) {
    if (typeof loadHoldStarter !== "function") {
      throw new TypeError("maintenance-hold process loader is required");
    }
    const startHold = loadHoldStarter();
    if (typeof startHold !== "function") {
      throw new TypeError("maintenance-hold process starter is required");
    }
    return startHold({ config: hold, processObject });
  }

  if (typeof loadTargetStarter !== "function") {
    throw new TypeError("target process loader is required");
  }
  const startTarget = loadTargetStarter();
  if (typeof startTarget !== "function") {
    throw new TypeError("target process starter is required");
  }
  return startTarget({ env, backendRoot, processObject });
}

module.exports = {
  reportTargetStartupFailure,
  startBackendProcess,
};
