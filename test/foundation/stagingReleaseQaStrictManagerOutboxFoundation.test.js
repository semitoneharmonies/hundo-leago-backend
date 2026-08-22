"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const express = require("express");

const {
  DATABASE_IDENTITY_KEYS,
  openDeployedTargetRuntime,
} = require("../../src/bootstrap/openDeployedTargetRuntime");
const {
  createSecurityFoundations,
} = require("../../src/bootstrap/createSecurityFoundations");
const {
  loadTargetRuntimeConfig,
} = require("../../src/config/loadTargetRuntimeConfig");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  discoverMigrations,
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  DEFAULT_CONTRACT: STRICT_RESTORE_CONTRACT,
} = require(
  "../../src/operations/release/materializeReleaseQaStrictRestore"
);
const {
  PHASES,
  migrationChecksumSetId,
  runtimeBindingMatches,
} = require(
  "../../src/operations/release/publishReleaseQaStrictManagerOutbox"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);
const {
  createReleaseQaStrictManagerOutboxRouter,
} = require(
  "../../src/transport/http/createReleaseQaStrictManagerOutboxRouter"
);
const {
  createTargetRequestSecurity,
} = require("../../src/transport/http/createTargetRequestSecurity");

const ROOT = path.resolve(__dirname, "..", "..");
const FRONTEND_ORIGIN = "https://strict-outbox.test";
const BACKEND_BUILD_ID = "b".repeat(40);
const MANAGER_A = fixtureId("account:leagueAManagerOne");
const MANAGER_B = fixtureId("account:leagueAManagerTwo");
const ADMINISTRATOR = fixtureId("account:platformAdmin");
const COMMISSIONER = fixtureId("account:leagueACommissioner");

function migrationState() {
  return Object.freeze({
    status: "exact",
    userVersion: 54,
    applied: discoverMigrations({
      migrationsDirectory: path.join(ROOT, "database", "migrations"),
    }),
  });
}

function localContract(state) {
  const persistentRoot = path.join(ROOT, ".strict-outbox-binding-test");
  return Object.freeze({
    ...STRICT_RESTORE_CONTRACT,
    persistentRoot,
    sourceDatabasePath: path.join(persistentRoot, "source.sqlite3"),
    targetDatabasePath: path.join(persistentRoot, "restored.sqlite3"),
    migrationChecksumSetId: migrationChecksumSetId(state),
  });
}

function seedDeployedDatabase(databasePath) {
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  try {
    migrateDatabase({
      database: connection.database,
      migrationsDirectory: path.join(ROOT, "database", "migrations"),
      applicationBuildId: BACKEND_BUILD_ID,
      now: () => Date.parse("2026-08-21T18:00:00.000Z"),
    });
    const insert = connection.database.prepare(`
      INSERT INTO application_metadata (
        metadata_key, metadata_value, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 0, 0)
    `);
    insert.run(
      DATABASE_IDENTITY_KEYS.environmentId,
      FIXTURE_ENVIRONMENT_ID
    );
    insert.run(
      DATABASE_IDENTITY_KEYS.databaseId,
      FIXTURE_DATABASE_ID
    );
    insert.run(
      DATABASE_IDENTITY_KEYS.createdAt,
      "2026-08-21T18:00:00.000Z"
    );
  } finally {
    connection.database.close();
  }
}

function openBoundDeployedRuntime(t, config, env, contract) {
  const securityFoundations = createSecurityFoundations({
    env,
    loadConfig: () => config.security,
    now: () => Date.parse("2026-08-21T18:00:00.000Z"),
    loggerSink() {},
  });
  const runtime = openDeployedTargetRuntime({
    config,
    securityFoundations,
    releaseQaStrictManagerOutboxContract: contract,
  });
  t.after(() => runtime.close());
  return runtime;
}

function runtimeEnvironment(contract, overrides = {}) {
  return {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_BUILD_ID: BACKEND_BUILD_ID,
    APP_ENVIRONMENT_ID: FIXTURE_ENVIRONMENT_ID,
    DATABASE_ID: FIXTURE_DATABASE_ID,
    FRONTEND_BUILD_ID: contract.frontendBuildId,
    PORT: "4000",
    DATABASE_PATH: contract.sourceDatabasePath,
    PERSISTENT_DATA_ROOT: contract.persistentRoot,
    CURRENT_SEASON_LABEL: "2026",
    CURRENT_NHL_SEASON_KEY: "20262027",
    SPORTSDATAIO_NHL_LIVE_MODE: "disabled",
    PUBLIC_FRONTEND_ORIGIN: FRONTEND_ORIGIN,
    FRONTEND_ORIGINS: FRONTEND_ORIGIN,
    LOG_LEVEL: "error",
    SESSION_COOKIE_SAME_SITE: "lax",
    ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
    SCHEDULED_JOBS_ENABLED: "false",
    FREE_AGENT_DRAFT_ROUTES_ENABLED: "true",
    LEAGUE_WRITE_MODE: "open",
    DEBUG_ROUTES_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "capture",
    BACKUP_SCHEDULE_ENABLED: "false",
    STAGING_MAINTENANCE_HOLD: "false",
    RATE_LIMIT_KEY_SECRET:
      "strict-outbox-rate-limit-secret-material-2026",
    AUDIT_METADATA_SECRET:
      "strict-outbox-audit-secret-material-2026",
    ACTION_TOKEN_DELIVERY_KEY:
      Buffer.alloc(32, 0x51).toString("base64url"),
    ...overrides,
  };
}

function createBinding(state, contract, overrides = {}) {
  return loadTargetRuntimeConfig({
    env: runtimeEnvironment(contract, overrides),
    backendRoot: ROOT,
  });
}

function authenticated(userId) {
  return Object.freeze({
    valid: true,
    code: "SESSION_VALID",
    user: Object.freeze({ id: userId, status: "active", version: 1 }),
    session: Object.freeze({
      id: "10000000-0000-4000-8000-000000000001",
      userId,
      status: "active",
      version: 1,
    }),
  });
}

function requestSecurity() {
  const userByToken = new Map([
    ["manager-a", MANAGER_A],
    ["manager-b", MANAGER_B],
    ["administrator", ADMINISTRATOR],
    ["commissioner", COMMISSIONER],
  ]);
  return createTargetRequestSecurity({
    isAllowedOrigin(origin) {
      return origin === FRONTEND_ORIGIN;
    },
    sessionCookie: Object.freeze({
      read(cookie) {
        const match = /(?:^|;\s*)hl_test=([^;]+)/u.exec(cookie || "");
        return match?.[1] || null;
      },
    }),
    sessionService: Object.freeze({
      bootstrap(rawSessionToken) {
        const userId = userByToken.get(rawSessionToken);
        return userId
          ? authenticated(userId)
          : Object.freeze({ valid: false, code: "SESSION_INVALID" });
      },
      resolveWithCsrf({ rawSessionToken, rawCsrfToken }) {
        const userId = userByToken.get(rawSessionToken);
        if (!userId) {
          return Object.freeze({ valid: false, code: "SESSION_INVALID" });
        }
        if (rawCsrfToken !== `csrf-${rawSessionToken}`) {
          return Object.freeze({ valid: false, code: "CSRF_INVALID" });
        }
        return authenticated(userId);
      },
    }),
    requestIdFactory: () => "strict-outbox-request",
  });
}

function exactBody(phase) {
  return {
    backendBuildId: BACKEND_BUILD_ID,
    confirmation: PHASES[phase].confirmation,
    phase,
    releaseId: "HL-20260821-3",
  };
}

function headers(token, phase, overrides = {}) {
  return {
    Origin: FRONTEND_ORIGIN,
    "Content-Type": "application/json",
    Cookie: `hl_test=${token}`,
    "X-CSRF-Token": `csrf-${token}`,
    "Idempotency-Key": PHASES[phase].idempotencyKey,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...overrides,
  };
}

async function start(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      }),
  });
}

function successfulService(calls) {
  return Object.freeze({
    async publish({ input, idempotencyKey, authenticated: caller }) {
      calls.push({ input, idempotencyKey, caller });
      const phase = PHASES[input?.phase];
      if (
        !phase ||
        Object.keys(input).sort().join("|") !==
          [
            "backendBuildId",
            "confirmation",
            "phase",
            "releaseId",
          ].sort().join("|") ||
        input.backendBuildId !== BACKEND_BUILD_ID ||
        input.confirmation !== phase.confirmation ||
        input.releaseId !== "HL-20260821-3" ||
        idempotencyKey !== phase.idempotencyKey
      ) {
        const error = new Error("invalid");
        error.code = "RELEASE_QA_STRICT_MANAGER_OUTBOX_INPUT_INVALID";
        throw error;
      }
      if (caller?.user?.id !== phase.acceptingUserId) {
        const error = new Error("denied");
        error.code = "RELEASE_QA_STRICT_MANAGER_OUTBOX_DENIED";
        throw error;
      }
      return Object.freeze({
        code: "RELEASE_QA_STRICT_MANAGER_OUTBOX_PUBLISHED",
        contractVersion: 1,
        releaseId: "HL-20260821-3",
        phase: input.phase,
        outcome: "published",
        replayed: true,
        databaseWriteCount: 0,
        schedulerRemainedDisabled: true,
      });
    },
  });
}

test("strict manager-outbox mount predicate requires every release binding and leaves restored or provider-drifted deployments at 404", async (t) => {
  const state = migrationState();
  const contract = localContract(state);
  const exact = createBinding(state, contract);
  assert.equal(
    runtimeBindingMatches({ config: exact, migrationState: state, contract }),
    true
  );
  for (const drifted of [
    { ...exact, databasePath: contract.targetDatabasePath },
    { ...exact, backupScheduleEnabled: null },
    { ...exact, stagingMaintenanceHoldEnabled: null },
    { ...exact, frontendBuildId: "c".repeat(40) },
    { ...exact, sportsDataIoNhlImportFieldsAbsent: false },
  ]) {
    assert.equal(
      runtimeBindingMatches({
        config: Object.freeze(drifted),
        migrationState: state,
        contract,
      }),
      false
    );
  }
  const providerDrift = createBinding(state, contract, {
    SPORTSDATAIO_NHL_API_ORIGIN:
      "https://api.sportsdata.io/api/nhl/fantasy",
    SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR: "2025",
  });
  assert.deepEqual(providerDrift.sportsDataIoNhl, { enabled: false });
  assert.equal(providerDrift.sportsDataIoNhlImportFieldsAbsent, false);
  assert.equal(
    runtimeBindingMatches({
      config: providerDrift,
      migrationState: state,
      contract,
    }),
    false
  );

  const calls = [];
  const mounted = express();
  if (
    runtimeBindingMatches({
      config: exact,
      migrationState: state,
      contract,
    })
  ) {
    mounted.use(
      createReleaseQaStrictManagerOutboxRouter({
        requestSecurity: requestSecurity(),
        service: successfulService(calls),
      })
    );
  }
  const mountedApi = await start(mounted);
  t.after(() => mountedApi.close());
  const mountedResponse = await fetch(
    `${mountedApi.baseUrl}/api/v1/operations/release-qa/strict-manager-outbox`,
    {
      method: "POST",
      headers: headers("manager-b", "team1-to-manager-b"),
      body: JSON.stringify(exactBody("team1-to-manager-b")),
    }
  );
  assert.equal(mountedResponse.status, 200);
  assert.equal((await mountedResponse.json()).data.databaseWriteCount, 0);
  assert.equal(calls.length, 1);

  const absent = express();
  const restored = Object.freeze({
    ...exact,
    databasePath: contract.targetDatabasePath,
  });
  if (
    runtimeBindingMatches({
      config: restored,
      migrationState: state,
      contract,
    })
  ) {
    absent.use(
      createReleaseQaStrictManagerOutboxRouter({
        requestSecurity: requestSecurity(),
        service: successfulService(calls),
      })
    );
  }
  const api = await start(absent);
  t.after(() => api.close());
  const response = await fetch(
    `${api.baseUrl}/api/v1/operations/release-qa/strict-manager-outbox`,
    {
      method: "POST",
      headers: headers("manager-a", "team1-return-to-manager-a"),
      body: JSON.stringify(exactBody("team1-return-to-manager-a")),
    }
  );
  assert.equal(response.status, 404);
  assert.equal(calls.length, 1);
});

test("deployed runtime mounts the release route only on the exact source database path", async (t) => {
  const state = migrationState();
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-strict-outbox-deployed-")
  );
  const databaseDirectory = path.join(persistentRoot, "sqlite");
  fs.mkdirSync(databaseDirectory);
  const sourceDatabasePath = path.join(databaseDirectory, "source.sqlite3");
  const targetDatabasePath = path.join(databaseDirectory, "restored.sqlite3");
  seedDeployedDatabase(sourceDatabasePath);
  seedDeployedDatabase(targetDatabasePath);
  const contract = Object.freeze({
    ...STRICT_RESTORE_CONTRACT,
    persistentRoot,
    sourceDatabasePath,
    targetDatabasePath,
    migrationChecksumSetId: migrationChecksumSetId(state),
  });

  const sourceEnv = runtimeEnvironment(contract);
  const sourceConfig = loadTargetRuntimeConfig({
    env: sourceEnv,
    backendRoot: ROOT,
  });
  const sourceRuntime = openBoundDeployedRuntime(
    t,
    sourceConfig,
    sourceEnv,
    contract
  );
  const sourceApi = await start(sourceRuntime.app);
  t.after(() => sourceApi.close());
  const route = "/api/v1/operations/release-qa/strict-manager-outbox";
  const mounted = await fetch(`${sourceApi.baseUrl}${route}`, {
    method: "POST",
    headers: {
      Origin: FRONTEND_ORIGIN,
      "Content-Type": "application/json",
      "X-CSRF-Token": "not-a-session",
      "Idempotency-Key": PHASES["team1-to-manager-b"].idempotencyKey,
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    body: JSON.stringify(exactBody("team1-to-manager-b")),
  });
  const mountedBody = await mounted.text();
  assert.equal(mounted.status, 401, mountedBody);

  const restoredEnv = runtimeEnvironment(contract, {
    DATABASE_PATH: targetDatabasePath,
  });
  const restoredConfig = loadTargetRuntimeConfig({
    env: restoredEnv,
    backendRoot: ROOT,
  });
  const restoredRuntime = openBoundDeployedRuntime(
    t,
    restoredConfig,
    restoredEnv,
    contract
  );
  const restoredApi = await start(restoredRuntime.app);
  t.after(() => restoredApi.close());
  const absent = await fetch(`${restoredApi.baseUrl}${route}`, {
    method: "POST",
    headers: {
      Origin: FRONTEND_ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(exactBody("team1-to-manager-b")),
  });
  const absentBody = await absent.text();
  assert.equal(absent.status, 404, absentBody);
  t.after(() =>
    fs.rmSync(persistentRoot, { recursive: true, force: true })
  );
});

test("strict manager-outbox POST enforces browser security, exact accepting-manager phase input, and sanitized zero-write replay", async (t) => {
  const calls = [];
  const app = express();
  app.use(
    createReleaseQaStrictManagerOutboxRouter({
      requestSecurity: requestSecurity(),
      service: successfulService(calls),
    })
  );
  const api = await start(app);
  t.after(() => api.close());
  const route =
    `${api.baseUrl}/api/v1/operations/release-qa/strict-manager-outbox`;
  const phase = "team1-return-to-manager-a";
  const exact = await fetch(route, {
    method: "POST",
    headers: headers("manager-a", phase),
    body: JSON.stringify(exactBody(phase)),
  });
  assert.equal(exact.status, 200);
  assert.equal(exact.headers.get("access-control-allow-origin"), FRONTEND_ORIGIN);
  assert.equal(exact.headers.get("cache-control"), "no-store");
  const exactJson = await exact.json();
  assert.equal(exactJson.data.replayed, true);
  assert.equal(exactJson.data.databaseWriteCount, 0);
  assert.equal(exactJson.data.schedulerRemainedDisabled, true);
  assert.equal(JSON.stringify(exactJson).includes("@"), false);

  const toManagerB = await fetch(route, {
    method: "POST",
    headers: headers("manager-b", "team1-to-manager-b"),
    body: JSON.stringify(exactBody("team1-to-manager-b")),
  });
  assert.equal(toManagerB.status, 200);
  assert.equal((await toManagerB.json()).data.phase, "team1-to-manager-b");

  for (const token of ["manager-b", "administrator", "commissioner"]) {
    const denied = await fetch(route, {
      method: "POST",
      headers: headers(token, phase),
      body: JSON.stringify(exactBody(phase)),
    });
    assert.equal(denied.status, 403);
    assert.equal(
      (await denied.json()).error.code,
      "RELEASE_QA_STRICT_MANAGER_OUTBOX_DENIED"
    );
  }
  for (const [label, request] of [
    ["missing session", { headers: headers("unknown", phase) }],
    [
      "missing csrf",
      { headers: headers("manager-a", phase, { "X-CSRF-Token": "" }) },
    ],
    [
      "wrong origin",
      { headers: headers("manager-a", phase, { Origin: "https://wrong.test" }) },
    ],
    [
      "wrong fetch metadata",
      {
        headers: headers("manager-a", phase, {
          "Sec-Fetch-Site": "none",
        }),
      },
    ],
  ]) {
    const rejected = await fetch(route, {
      method: "POST",
      ...request,
      body: JSON.stringify(exactBody(phase)),
    });
    assert.equal(rejected.status, label === "missing session" ? 401 : 403);
  }
  for (const [body, key] of [
    [{ ...exactBody(phase), unexpected: true }, PHASES[phase].idempotencyKey],
    [{ ...exactBody(phase), backendBuildId: "c".repeat(40) }, PHASES[phase].idempotencyKey],
    [{ ...exactBody(phase), confirmation: "wrong" }, PHASES[phase].idempotencyKey],
    [{ ...exactBody(phase), phase: "wrong" }, PHASES[phase].idempotencyKey],
    [exactBody(phase), "wrong-key"],
  ]) {
    const invalid = await fetch(route, {
      method: "POST",
      headers: headers("manager-a", phase, { "Idempotency-Key": key }),
      body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (await invalid.json()).error.code,
      "RELEASE_QA_STRICT_MANAGER_OUTBOX_INPUT_INVALID"
    );
  }
  assert.equal(calls.length, 10);
});
