#!/usr/bin/env node
const { startProductionMaintenanceProcess } = require("../src/bootstrap/startProductionMaintenanceProcess");

async function runProductionMaintenanceCommand({ argv = process.argv.slice(2), env = process.env,
  processObject = process, output = console } = {}) {
  if (!Array.isArray(argv) || argv.length) {
    const error = new Error("Production maintenance takes no command arguments.");
    error.code = "PRODUCTION_MAINTENANCE_ARGUMENT_INVALID";
    throw error;
  }
  const result = await startProductionMaintenanceProcess({ env, processObject });
  try {
    output.log(JSON.stringify({ severity: "info", event: "production_maintenance.started",
      mode: result.mode, buildId: result.config.buildId, serviceId: result.config.serviceId,
      applicationLoaded: false, databaseOpened: false, jobsStarted: false, deliveryStarted: false }));
  } catch (error) {
    await result.shutdown();
    throw error;
  }
  return result;
}
if (require.main === module) {
  runProductionMaintenanceCommand().catch((error) => {
    console.error(JSON.stringify({ severity: "error", event: "production_maintenance.start_failed",
      code: error?.code === "PRODUCTION_MAINTENANCE_CONFIG_INVALID" || error?.code === "PRODUCTION_MAINTENANCE_ARGUMENT_INVALID"
        ? error.code : "PRODUCTION_MAINTENANCE_START_FAILED",
      ...(typeof error?.field === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.field) ? { field: error.field } : {}),
      message: "Production maintenance did not start. Review the confirmed release configuration." }));
    process.exitCode = 1;
  });
}
module.exports = { runProductionMaintenanceCommand };
