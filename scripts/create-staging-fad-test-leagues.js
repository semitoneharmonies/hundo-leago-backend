"use strict";

const path = require("node:path");

const {
  createSecurityFoundations,
} = require("../src/bootstrap/createSecurityFoundations");
const {
  openDeployedTargetRuntime,
} = require("../src/bootstrap/openDeployedTargetRuntime");
const {
  loadTargetRuntimeConfig,
} = require("../src/config/loadTargetRuntimeConfig");
const {
  createFreeAgentDraftBrowserFixture,
} = require(
  "../src/operations/release/createFreeAgentDraftBrowserFixture"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require(
  "../src/operations/release/releaseQaFixtureContract"
);

const EXPECTED_LEAGUE_IDS = Object.freeze([
  fixtureId("fad-browser:league:alpha"),
  fixtureId("fad-browser:league:beta"),
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertStagingScope(config) {
  if (
    config.appEnv !== "staging" ||
    config.environmentId !== FIXTURE_ENVIRONMENT_ID ||
    config.databaseId !== FIXTURE_DATABASE_ID ||
    config.leagueWriteMode !== "open" ||
    config.freeAgentDraftRoutesEnabled !== true ||
    config.scheduledJobsEnabled !== false
  ) {
    fail(
      "STAGING_FAD_TEST_SCOPE_INVALID",
      "FAD test leagues require the exact writable staging fixture runtime."
    );
  }
}

function assertNoPriorFixture(database) {
  const placeholders = EXPECTED_LEAGUE_IDS.map(() => "?").join(", ");
  const existing = database.prepare(`
    SELECT id
    FROM leagues
    WHERE id IN (${placeholders})
    ORDER BY id ASC
  `).all(...EXPECTED_LEAGUE_IDS);
  if (existing.length !== 0) {
    fail(
      "STAGING_FAD_TEST_ALREADY_EXISTS",
      "The deterministic staging FAD test leagues already exist or are partial."
    );
  }
}

async function run({
  env = process.env,
  backendRoot = path.resolve(__dirname, ".."),
  stdout = process.stdout,
} = {}) {
  const config = loadTargetRuntimeConfig({ env, backendRoot });
  assertStagingScope(config);
  const securityFoundations = createSecurityFoundations({
    env,
    loadConfig: () => config.security,
  });
  const runtime = openDeployedTargetRuntime({
    config,
    securityFoundations,
  });
  try {
    assertNoPriorFixture(runtime.database);
    const manifest = await createFreeAgentDraftBrowserFixture({
      runtime,
      nowMs: securityFoundations.clock.nowMs(),
    });
    const result = Object.freeze({
      code: "STAGING_FAD_TEST_CREATED",
      leagues: Object.values(manifest.leagues).map((league) => ({
        alias: league.alias,
        leagueId: league.leagueId,
        seasonId: league.seasonId,
        fadId: league.fadId,
        phase: league.phase,
        teamCount: league.teams.length,
        firstWeekStartsAtMs: league.firstWeekStartsAtMs,
      })),
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    runtime.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code:
        typeof error?.code === "string"
          ? error.code
          : "STAGING_FAD_TEST_FAILED",
      message: "The staging FAD test leagues were not created.",
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_LEAGUE_IDS,
  assertNoPriorFixture,
  assertStagingScope,
  run,
};
