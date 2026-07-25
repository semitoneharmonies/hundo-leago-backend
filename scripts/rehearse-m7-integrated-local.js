#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const {
  createReleaseQaRuntime,
} = require("../src/operations/release/createReleaseQaRuntime");
const {
  rehearseReleaseQaRecovery,
} = require("../src/operations/release/rehearseReleaseQaRecovery");
const {
  canonicalize,
} = require("../src/operations/release/releaseQaFixtureContract");
const {
  verifyReleaseQaRuntime,
} = require("../src/operations/release/verifyReleaseQaRuntime");

const ROOT_DIRECTORY = path.resolve(__dirname, "..");
const FRONTEND_DIRECTORY = path.resolve(ROOT_DIRECTORY, "..", "hundo-leago");
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const VITE_ENTRY = path.join(FRONTEND_DIRECTORY, "node_modules", "vite", "bin", "vite.js");
const FRONTEND_OS_ENVIRONMENT_KEYS = Object.freeze([
  "APPDATA",
  "COMSPEC",
  "ComSpec",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "Path",
  "PATH",
  "PATHEXT",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "windir",
]);

class IntegratedReleaseQaError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "IntegratedReleaseQaError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new IntegratedReleaseQaError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertLocalInput(env) {
  if (typeof env.M7_RELEASE_QA_PASSWORD !== "string" ||
      env.M7_RELEASE_QA_PASSWORD === "") {
    fail(
      "RELEASE_QA_LOCAL_PASSWORD_REQUIRED",
      "M7_RELEASE_QA_PASSWORD is required and is never written to output."
    );
  }
  if (
    path.basename(FRONTEND_DIRECTORY) !== "hundo-leago" ||
    !fs.existsSync(path.join(FRONTEND_DIRECTORY, "package.json")) ||
    !fs.existsSync(VITE_ENTRY)
  ) {
    fail(
      "RELEASE_QA_LOCAL_FRONTEND_MISSING",
      "The exact sibling frontend and its installed Vite runtime are required."
    );
  }
}

function createFrontendEnvironment({ backendOrigin, environment = process.env }) {
  const allowed = Object.fromEntries(
    FRONTEND_OS_ENVIRONMENT_KEYS
      .filter((key) => typeof environment[key] === "string")
      .map((key) => [key, environment[key]])
  );
  return Object.freeze({
    ...allowed,
    VITE_APP_ENV: "local",
    VITE_API_ORIGIN: backendOrigin,
    VITE_SOCKET_ORIGIN: backendOrigin,
    VITE_BUILD_ID: "m7-local-frontend",
  });
}

function startFrontend({
  backendOrigin,
  environment = process.env,
  spawnProcess = spawn,
}) {
  let stderr = "";
  let spawnError = null;
  const child = spawnProcess(
    process.execPath,
    [VITE_ENTRY, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    {
      cwd: FRONTEND_DIRECTORY,
      env: createFrontendEnvironment({ backendOrigin, environment }),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    }
  );
  child.once("error", (error) => { spawnError = error; });
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  return Object.freeze({
    child,
    error: () => spawnError,
    stderr: () => stderr,
  });
}

async function waitForFrontend(frontend, fetchImplementation = fetch) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (frontend.error()) {
      fail(
        "RELEASE_QA_LOCAL_FRONTEND_START_FAILED",
        "The local Vite frontend could not start.",
        frontend.error()
      );
    }
    if (frontend.child.exitCode !== null) {
      fail(
        "RELEASE_QA_LOCAL_FRONTEND_EXITED",
        `The local Vite frontend exited before readiness: ${frontend.stderr()}`
      );
    }
    try {
      const response = await fetchImplementation(`${FRONTEND_ORIGIN}/`);
      const document = await response.text();
      if (
        response.status === 200 &&
        document.includes('<div id="root"></div>') &&
        document.includes('src="/src/main.jsx"')
      ) {
        return Object.freeze({
          contentType: response.headers.get("content-type"),
          status: response.status,
        });
      }
    } catch {
      // Vite has not opened its loopback listener yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(
    "RELEASE_QA_LOCAL_FRONTEND_TIMEOUT",
    `The local Vite frontend did not become ready: ${frontend.stderr()}`
  );
}

async function stopFrontend(frontend) {
  if (!frontend || frontend.child.exitCode !== null) return;
  frontend.child.kill();
  await Promise.race([
    once(frontend.child, "exit"),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("The local Vite frontend did not stop.")),
      5_000
    )),
  ]);
}

async function runIntegratedReleaseQaCommand({
  env = process.env,
  createRuntime = createReleaseQaRuntime,
  output = console,
} = {}) {
  assertLocalInput(env);
  let started;
  let frontend;
  try {
    started = await createRuntime({
      frontendOrigin: FRONTEND_ORIGIN,
      leagueWriteMode: "open",
      migrationsDirectory: path.join(ROOT_DIRECTORY, "database", "migrations"),
      password: env.M7_RELEASE_QA_PASSWORD,
      port: 0,
    });
    frontend = startFrontend({ backendOrigin: started.baseUrl });
    const frontendReady = await waitForFrontend(frontend);
    const recovery = await rehearseReleaseQaRecovery({
      databasePath: started.databasePath,
      fixtureManifestChecksum: started.fixtureManifest.manifestChecksum,
      temporaryRoot: started.temporaryRoot,
    });
    const runtime = await verifyReleaseQaRuntime({
      baseUrl: started.baseUrl,
      expectedWriteMode: "open",
      fixtureManifestChecksum: started.fixtureManifest.manifestChecksum,
      frontendOrigin: FRONTEND_ORIGIN,
      password: env.M7_RELEASE_QA_PASSWORD,
    });
    let providerFailureCode = null;
    try {
      await started.runtime.services.league.statistics.refresh();
    } catch (error) {
      providerFailureCode = error?.code;
    }
    if (providerFailureCode !== "STATISTICS_PROVIDER_FAILED") {
      fail(
        "RELEASE_QA_LOCAL_PROVIDER_CONTROL_FAILED",
        "The disabled provider did not fail through the contained statistics boundary."
      );
    }
    const reportBase = Object.freeze({
      reportVersion: 1,
      backend: "live-http-verifier-passed",
      backendReportChecksum: runtime.reportChecksum,
      browserRendering: "not-run-by-this-command",
      frontend: "vite-index-and-module-entry-served",
      frontendContentType: frontendReady.contentType,
      providerFailure: "contained-and-recorded",
      recoveryReportChecksum: recovery.reportChecksum,
      scheduler: started.schedulerStart.status,
      topology: "loopback-only",
    });
    const report = Object.freeze({
      ...reportBase,
      reportChecksum: hash(canonicalize(reportBase)),
    });
    output.log(JSON.stringify(report));
    return report;
  } catch (error) {
    if (error instanceof IntegratedReleaseQaError) throw error;
    fail(
      "RELEASE_QA_LOCAL_REHEARSAL_FAILED",
      "The integrated local release rehearsal failed safely.",
      error
    );
  } finally {
    let frontendCloseError;
    try {
      await stopFrontend(frontend);
    } catch (error) {
      frontendCloseError = error;
    }
    if (started) await started.close();
    if (frontendCloseError) throw frontendCloseError;
  }
}

async function main() {
  try {
    await runIntegratedReleaseQaCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || "RELEASE_QA_LOCAL_REHEARSAL_FAILED",
        message: error?.message || "The integrated local release rehearsal failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  IntegratedReleaseQaError,
  createFrontendEnvironment,
  runIntegratedReleaseQaCommand,
  startFrontend,
  stopFrontend,
  waitForFrontend,
};
