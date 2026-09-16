"use strict";

// Child-process fault injection for disposable restored fixture databases only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { loadSecurityConfig } = require("../../src/config/loadSecurityConfig");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { createTargetRepositories, createTargetServices } = require("../../src/bootstrap/createTargetRuntime");
const { createSecureRandom } = require("../../src/infrastructure/security/createSecureRandom");
const { RECOVERY_HOLD_KEY } = require("../../src/infrastructure/database/recoveryHold");

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  assert(["matchup:lock", "matchup:finalize", "matchup:rollover"].includes(input.execution.jobType));
  assert(["exit", "throw"].includes(input.mode));
  assert(Number.isSafeInteger(input.stopAfter) && input.stopAfter > 0);
  const database = openDatabase({ databasePath: input.databasePath, environment: "test" }).database;
  assert(database.prepare("SELECT 1 FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY));
  const denied = () => { throw new Error("External recovery adapter was invoked"); };
  const secureRandom = createSecureRandom();
  const repositories = createTargetRepositories({ database, secureRandom, matchupProcessingLeagueIds: [input.execution.leagueId] });
  const services = createTargetServices({ repositories,
    securityFoundations: { config: loadSecurityConfig({ env: {
      APP_ENV: "local", NODE_ENV: "development", APP_BUILD_ID: "matchup-crash-fixture", LOG_LEVEL: "error",
      PUBLIC_FRONTEND_ORIGIN: "http://127.0.0.1:5173", FRONTEND_ORIGINS: "http://127.0.0.1:5173", EMAIL_DELIVERY_MODE: "capture",
      RATE_LIMIT_KEY_SECRET: crypto.randomBytes(36).toString("base64url"), AUDIT_METADATA_SECRET: crypto.randomBytes(36).toString("base64url"),
      ACTION_TOKEN_DELIVERY_KEY: crypto.randomBytes(32).toString("base64url"),
    } }), clock: { nowMs: () => input.nowMs }, secureRandom, logger: { info() {}, warn() {}, error() {} } },
    currentSeason: input.currentSeason, leagueInvalidationPublisher: { publish: denied },
    nhlFetchImplementation: denied, sportsDataIoFetchImplementation: denied, emailFetchImplementation: denied,
    emailAdapter: { sendEmailVerification: denied, sendAccountActionLink: denied, sendSecurityNotification: denied },
  });
  let reached = false;
  database.function("interrupt_matchup_fixture", () => {
    reached = true;
    fs.writeSync(1, JSON.stringify({ reached: true, mode: input.mode, stopAfter: input.stopAfter, inTransaction: database.inTransaction }) + "\n");
    if (input.mode === "exit") process.exit(86);
    throw new Error("Injected matchup write interruption");
  });
  // Fire after a real row write, at the first, middle or last affected team/game.
  if (input.execution.jobType === "matchup:lock") {
    database.exec(`CREATE TEMP TRIGGER interrupt_matchup_write AFTER INSERT ON matchup_roster_locks
      WHEN (SELECT count(*) FROM matchup_roster_locks WHERE matchup_week_id=NEW.matchup_week_id)=${input.stopAfter}
      BEGIN SELECT interrupt_matchup_fixture(); END;`);
  } else {
    database.exec(`CREATE TEMP TRIGGER interrupt_matchup_write AFTER INSERT ON matchup_results
      WHEN (SELECT count(*) FROM matchup_results result JOIN matchups matchup ON matchup.id=result.matchup_id
        WHERE matchup.matchup_week_id=(SELECT matchup_week_id FROM matchups WHERE id=NEW.matchup_id))=${input.stopAfter}
      BEGIN SELECT interrupt_matchup_fixture(); END;`);
  }
  try {
    await assert.rejects(services.league.matchupOccurrenceHandlers[input.execution.jobType](Object.freeze(input.execution), input.nowMs));
    assert(reached, "The injected write boundary must actually be reached");
  } finally {
    database.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
