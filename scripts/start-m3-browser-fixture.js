const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const {
  createTargetRuntime,
} = require("../src/bootstrap/createTargetRuntime");
const {
  createTargetHttpServer,
} = require("../src/bootstrap/createTargetHttpServer");
const {
  createSecurityFoundations,
} = require("../src/bootstrap/createSecurityFoundations");
const {
  openDatabase,
} = require("../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../src/infrastructure/database/migrate");
const {
  createScryptPasswordHasher,
} = require(
  "../src/infrastructure/security/createScryptPasswordHasher"
);
const {
  createTestAccount,
} = require("../test/helpers/createTestAccount");

const ROOT_DIRECTORY = path.resolve(__dirname, "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const HOST = "127.0.0.1";
const PORT = Number(process.env.M3_BROWSER_API_PORT || 4100);
const FRONTEND_ORIGIN =
  process.env.M3_BROWSER_FRONTEND_ORIGIN || "http://127.0.0.1:5173";
const PASSWORD = process.env.M3_BROWSER_PASSWORD;
const INCLUDE_ACTION_LINKS =
  process.env.M3_BROWSER_ACTION_LINKS === "true";
const NOW_MS = Date.parse("2026-07-20T12:00:00.000Z");

function fail(message) {
  throw new TypeError(message);
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function validateInputs() {
  const nodeVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node);
  if (
    !nodeVersion ||
    Number(nodeVersion[1]) !== 24 ||
    Number(nodeVersion[2]) < 14 ||
    (Number(nodeVersion[2]) === 14 && Number(nodeVersion[3]) < 1)
  ) {
    fail("M3 browser fixture requires Node >=24.14.1 <25.");
  }
  if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65535) {
    fail("M3 browser fixture requires a valid non-privileged API port.");
  }
  const frontend = new URL(FRONTEND_ORIGIN);
  if (
    frontend.origin !== FRONTEND_ORIGIN ||
    frontend.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(frontend.hostname)
  ) {
    fail("M3 browser fixture requires an exact loopback HTTP frontend origin.");
  }
  if (typeof PASSWORD !== "string" || PASSWORD.length < 6) {
    fail("M3_BROWSER_PASSWORD is required and must satisfy the password policy.");
  }
  if (
    process.env.M3_BROWSER_ACTION_LINKS !== undefined &&
    !["true", "false"].includes(process.env.M3_BROWSER_ACTION_LINKS)
  ) {
    fail("M3_BROWSER_ACTION_LINKS must be exactly true or false when provided.");
  }
}

function securityFoundations() {
  return createSecurityFoundations({
    env: {
      APP_ENV: "local",
      NODE_ENV: "development",
      LOG_LEVEL: "error",
      PUBLIC_FRONTEND_ORIGIN: FRONTEND_ORIGIN,
      FRONTEND_ORIGINS: FRONTEND_ORIGIN,
      EMAIL_DELIVERY_MODE: "capture",
      RATE_LIMIT_KEY_SECRET: crypto.randomBytes(32).toString("base64url"),
      AUDIT_METADATA_SECRET: crypto.randomBytes(32).toString("base64url"),
      ACTION_TOKEN_DELIVERY_KEY: crypto.randomBytes(32).toString("base64url"),
    },
    now: () => NOW_MS,
    loggerSink() {},
  });
}

function insertLeagueScenario(runtime, userId, ordinal) {
  const repositories = runtime.repositories.context.repositories;
  const leagueId = uuid(5000 + ordinal);
  const membershipId = uuid(5100 + ordinal);
  const teamId = uuid(5200 + ordinal);
  const leagueName = ordinal === 1 ? "Browser Test League" : "Second Test League";
  const teamName = ordinal === 1 ? "Browser Owls" : "Second Ravens";

  repositories.leagues.insert({
    id: leagueId,
    name: leagueName,
    name_normalized: leagueName.toLowerCase(),
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: membershipId,
    league_id: leagueId,
    user_id: userId,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.teams.insert({
    id: teamId,
    league_id: leagueId,
    name: teamName,
    name_normalized: teamName.toLowerCase(),
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.team_manager_assignments.insert({
    id: uuid(5300 + ordinal),
    league_id: leagueId,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: userId,
    status: "accepted",
    assigned_at_ms: NOW_MS,
    accepted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });
  return Object.freeze({ leagueId, leagueName, teamId, teamName });
}

function actionUrl(pathname, rawToken) {
  const url = new URL(pathname, FRONTEND_ORIGIN);
  url.hash = `token=${rawToken}`;
  return url.toString();
}

async function createActionLinkScenarios({
  composed,
  foundations,
  passwordHasher,
}) {
  const accountOptions = {
    repositoryContext: composed.repositories.context,
    userRepository: composed.repositories.users,
    credentialRepository: composed.repositories.credentials,
    passwordHasher,
    clock: foundations.clock,
    secureRandom: foundations.secureRandom,
    password: PASSWORD,
  };
  const verification = await createTestAccount({
    ...accountOptions,
    emailNormalized: "browser.verify@example.test",
    emailDisplay: "browser.verify@example.test",
    displayName: "Browser Verification User",
    displayNameNormalized: "browser verification user",
    status: "pending_verification",
  });
  const reset = await createTestAccount({
    ...accountOptions,
    emailNormalized: "browser.reset@example.test",
    emailDisplay: "browser.reset@example.test",
    displayName: "Browser Reset User",
    displayNameNormalized: "browser reset user",
  });
  const reactivation = await createTestAccount({
    ...accountOptions,
    emailNormalized: "browser.reactivate@example.test",
    emailDisplay: "browser.reactivate@example.test",
    displayName: "Browser Reactivation User",
    displayNameNormalized: "browser reactivation user",
    status: "deactivated",
  });
  const setupUser = composed.repositories.users.insert({
    id: uuid(5401),
    email_normalized: "browser.setup@example.test",
    email_display: "browser.setup@example.test",
    display_name: "Browser Setup User",
    display_name_normalized: "browser setup user",
    status: "pending_credential_setup",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  const issue = (userId, purpose, pathname) => {
    const issued = composed.services.actionTokenService.issue({
      userId,
      purpose,
    });
    return actionUrl(pathname, issued.rawToken);
  };

  return Object.freeze({
    ephemeralOnly: true,
    verification: Object.freeze({
      email: verification.user.email_display,
      url: issue(verification.user.id, "email_verification", "/verify-email"),
    }),
    setup: Object.freeze({
      email: setupUser.email_display,
      url: issue(setupUser.id, "administrator_setup", "/setup-account"),
    }),
    reset: Object.freeze({
      email: reset.user.email_display,
      url: issue(reset.user.id, "password_reset", "/reset-password"),
    }),
    reactivation: Object.freeze({
      email: reactivation.user.email_display,
      url: issue(
        reactivation.user.id,
        "self_reactivation",
        "/reactivate"
      ),
    }),
  });
}

async function main() {
  validateInputs();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m3-browser-"));
  const databasePath = path.join(temporaryRoot, "browser-fixture.sqlite3");
  const connection = openDatabase({ databasePath, environment: "test" });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-browser-fixture",
    now: () => NOW_MS,
  });
  const foundations = securityFoundations();
  const passwordHasher = createScryptPasswordHasher({
    secureRandom: foundations.secureRandom,
  });
  const composed = createTargetRuntime({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    securityFoundations: foundations,
    currentSeason: { label: "2026", nhlSeasonKey: "20262027" },
    networkSourceResolver() {
      return "127.0.0.1";
    },
  });
  const account = await createTestAccount({
    repositoryContext: composed.repositories.context,
    userRepository: composed.repositories.users,
    credentialRepository: composed.repositories.credentials,
    passwordHasher,
    clock: foundations.clock,
    secureRandom: foundations.secureRandom,
    emailNormalized: "browser.manager@example.test",
    emailDisplay: "browser.manager@example.test",
    displayName: "Browser Manager",
    displayNameNormalized: "browser manager",
    password: PASSWORD,
  });
  const leagues = [
    insertLeagueScenario(composed, account.user.id, 1),
    insertLeagueScenario(composed, account.user.id, 2),
  ];
  const actionLinks = INCLUDE_ACTION_LINKS
    ? await createActionLinkScenarios({
        composed,
        foundations,
        passwordHasher,
      })
    : null;
  let closed = false;
  const runtime = Object.freeze({
    ...composed,
    close() {
      if (closed) return;
      closed = true;
      if (connection.database.open) connection.database.close();
    },
  });
  const targetServer = createTargetHttpServer({ runtime });
  await targetServer.listen({ host: HOST, port: PORT });
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      apiOrigin: `http://${HOST}:${PORT}`,
      frontendOrigin: FRONTEND_ORIGIN,
      email: "browser.manager@example.test",
      databasePath,
      leagues,
      ...(actionLinks ? { actionLinks } : {}),
    })}\n`
  );

  async function shutdown() {
    try {
      await targetServer.close();
    } finally {
      process.exit(0);
    }
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
