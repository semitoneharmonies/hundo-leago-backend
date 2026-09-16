const path = require("node:path");
const { loadTargetRuntimeConfig } = require("../src/config/loadTargetRuntimeConfig");
const { createSecurityFoundations } = require("../src/bootstrap/createSecurityFoundations");
const { openDeployedTargetRuntime } = require("../src/bootstrap/openDeployedTargetRuntime");
const { deliverFirstAdministratorSetup, ERROR_CODE } = require("../src/operations/accounts/deliverFirstAdministratorSetup");

const CONFIRM_ARGUMENT = "--confirm-send-first-administrator-setup";

async function runDeliveryCommand({
  argv = process.argv.slice(2), env = process.env, output = console,
  emailAdapter, emailFetchImplementation, now = Date.now,
} = {}) {
  if (argv.length !== 1 || argv[0] !== CONFIRM_ARGUMENT || env.ACCOUNT_EMAIL_DELIVERY_ENABLED !== "false") {
    const error = new Error("Explicit confirmation and a disabled general account-email worker are required.");
    error.code = ERROR_CODE;
    throw error;
  }
  const config = loadTargetRuntimeConfig({ env, backendRoot: path.resolve(__dirname, "..") });
  if (!config.firstAdministratorSetup || config.appEnv !== "production") {
    const error = new Error("The limited production setup window is required.");
    error.code = ERROR_CODE;
    throw error;
  }
  const securityFoundations = createSecurityFoundations({ env, loadConfig: () => config.security, now, loggerSink() {} });
  const runtime = openDeployedTargetRuntime({ config, securityFoundations, emailAdapter, emailFetchImplementation });
  try {
    const result = await deliverFirstAdministratorSetup({ runtime, securityFoundations,
      eventId: env.FIRST_ADMINISTRATOR_SETUP_OUTBOX_EVENT_ID,
      recipientEmail: env.FIRST_ADMINISTRATOR_SETUP_RECIPIENT,
      confirmation: env.FIRST_ADMINISTRATOR_SETUP_DELIVERY_CONFIRMATION });
    output.log(JSON.stringify(result));
    return result;
  } finally {
    await runtime.close();
  }
}

async function main() {
  try {
    const result = await runDeliveryCommand();
    if (!["published", "already_published"].includes(result.outcome)) process.exitCode = 1;
  } catch {
    // Provider exceptions and configuration errors can contain protected values.
    console.error(JSON.stringify({ error: { code: ERROR_CODE,
      message: "The confirmed setup delivery did not complete. Review the exact event before any further attempt." } }));
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
module.exports = { CONFIRM_ARGUMENT, runDeliveryCommand };
