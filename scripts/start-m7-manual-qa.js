#!/usr/bin/env node

const path = require("node:path");

const {
  createReleaseQaRuntime,
} = require("../src/operations/release/createReleaseQaRuntime");
const {
  ACCOUNT_ALIASES,
  fixtureEmail,
} = require("../src/operations/release/releaseQaFixtureContract");
const {
  startFrontend,
  stopFrontend,
  waitForFrontend,
} = require("./rehearse-m7-integrated-local");

const ROOT_DIRECTORY = path.resolve(__dirname, "..");
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const MANUAL_QA_GUIDE_PATH = path.resolve(
  ROOT_DIRECTORY,
  "..",
  "hundo-leago",
  "docs",
  "07-testing",
  "M7_MANUAL_WEBSITE_TEST_GUIDE.md"
);
const ACCOUNT_EXPECTATIONS = Object.freeze({
  platformAdmin: Object.freeze({
    role: "Platform administrator",
    expectedAccess: "Platform administration and both release-QA leagues",
  }),
  leagueACommissioner: Object.freeze({
    role: "Commissioner",
    expectedAccess: "Release QA Alpha League",
  }),
  leagueBCommissioner: Object.freeze({
    role: "Commissioner",
    expectedAccess: "Release QA Beta League",
  }),
  leagueAManagerOne: Object.freeze({
    role: "Manager",
    expectedAccess: "Release QA Alpha League, Owls",
  }),
  leagueAManagerTwo: Object.freeze({
    role: "Manager",
    expectedAccess: "Release QA Alpha League, Ravens",
  }),
  leagueBManagerOne: Object.freeze({
    role: "Manager",
    expectedAccess: "Release QA Beta League, Owls",
  }),
  verifiedWithoutMembership: Object.freeze({
    role: "Verified user without membership",
    expectedAccess: "No leagues",
  }),
  pendingVerification: Object.freeze({
    role: "Pending-verification account",
    expectedAccess: "Sign-in rejected until verification",
  }),
  deactivated: Object.freeze({
    role: "Deactivated account",
    expectedAccess: "Sign-in rejected",
  }),
});

class ManualReleaseQaSiteError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ManualReleaseQaSiteError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ManualReleaseQaSiteError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function assertManualQaInput(env) {
  if (
    typeof env.M7_RELEASE_QA_PASSWORD !== "string" ||
    env.M7_RELEASE_QA_PASSWORD === ""
  ) {
    fail(
      "RELEASE_QA_SITE_PASSWORD_REQUIRED",
      "M7_RELEASE_QA_PASSWORD is required and is never written to output."
    );
  }
}

function createAccountGuide() {
  return Object.freeze(ACCOUNT_ALIASES.map((alias) => Object.freeze({
    alias,
    email: fixtureEmail(alias),
    ...ACCOUNT_EXPECTATIONS[alias],
  })));
}

function createReadySummary({ started, writeMode = "open" }) {
  return Object.freeze({
    status: "ready",
    siteUrl: FRONTEND_ORIGIN,
    backendUrl: started.baseUrl,
    accounts: createAccountGuide(),
    password: "Use the M7_RELEASE_QA_PASSWORD value that launched this command.",
    fixtureManifestChecksum: started.fixtureManifest.manifestChecksum,
    scheduler: started.schedulerStart.status,
    storage: "Disposable operating-system temporary directory",
    writeMode,
    guidePath: MANUAL_QA_GUIDE_PATH,
    cleanup: "Press Ctrl+C once when testing is finished.",
  });
}

function formatReadySummary(summary) {
  const accountLines = summary.accounts.map((account) =>
    `  ${account.email} | ${account.role} | ${account.expectedAccess}`
  );
  return [
    "",
    "Hundo Leago local QA site is ready.",
    `Open: ${summary.siteUrl}`,
    `Backend: ${summary.backendUrl}`,
    `Password: ${summary.password}`,
    `Scheduler: ${summary.scheduler}`,
    `Storage: ${summary.storage}`,
    `Guide: ${summary.guidePath}`,
    "",
    "Test accounts:",
    ...accountLines,
    "",
    summary.cleanup,
  ].join("\n");
}

async function runManualReleaseQaSiteCommand({
  env = process.env,
  createRuntime = createReleaseQaRuntime,
  launchFrontend = startFrontend,
  awaitFrontend = waitForFrontend,
  closeFrontend = stopFrontend,
  output = console,
} = {}) {
  assertManualQaInput(env);
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
    frontend = launchFrontend({
      backendOrigin: started.baseUrl,
      environment: env,
    });
    await awaitFrontend(frontend);
  } catch (error) {
    try {
      await closeFrontend(frontend);
    } catch {
      // Preserve the startup failure.
    }
    try {
      if (started) await started.close();
    } catch {
      // Preserve the startup failure.
    }
    if (error instanceof ManualReleaseQaSiteError) throw error;
    fail(
      "RELEASE_QA_SITE_START_FAILED",
      "The local manual-QA site failed to start safely.",
      error
    );
  }

  let closePromise = null;
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      let frontendCloseError;
      try {
        await closeFrontend(frontend);
      } catch (error) {
        frontendCloseError = error;
      }
      await started.close();
      if (frontendCloseError) throw frontendCloseError;
    })();
    return closePromise;
  }

  const summary = createReadySummary({ started });
  output.log(formatReadySummary(summary));
  return Object.freeze({
    close,
    frontend,
    started,
    summary,
  });
}

async function main() {
  let site;
  let closing = null;
  function close(signal) {
    if (closing || !site) return closing;
    closing = site.close().then(() => {
      process.stdout.write(
        `${JSON.stringify({ status: "closed", signal })}\n`
      );
    });
    return closing;
  }

  try {
    site = await runManualReleaseQaSiteCommand();
    process.once("SIGINT", () => {
      close("SIGINT").catch(() => { process.exitCode = 1; });
    });
    process.once("SIGTERM", () => {
      close("SIGTERM").catch(() => { process.exitCode = 1; });
    });
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || "RELEASE_QA_SITE_START_FAILED",
        message: error?.message || "The local manual-QA site failed safely.",
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ACCOUNT_EXPECTATIONS,
  FRONTEND_ORIGIN,
  MANUAL_QA_GUIDE_PATH,
  ManualReleaseQaSiteError,
  assertManualQaInput,
  createAccountGuide,
  createReadySummary,
  formatReadySummary,
  runManualReleaseQaSiteCommand,
};
