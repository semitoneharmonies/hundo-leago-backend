const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const {
  createAccountEmailDeliveryService,
} = require(
  "../../src/application/services/accounts/createAccountEmailDeliveryService"
);
const {
  createAccountActionTokenService,
} = require(
  "../../src/application/services/accounts/createAccountActionTokenService"
);
const {
  createAdministratorCredentialSetupService,
} = require(
  "../../src/application/services/accounts/createAdministratorCredentialSetupService"
);
const {
  createCredentialAuthenticationService,
} = require(
  "../../src/application/services/accounts/createCredentialAuthenticationService"
);
const {
  FirstPlatformAdministratorExistsError,
  createFirstPlatformAdministratorService,
} = require(
  "../../src/application/services/accounts/createFirstPlatformAdministratorService"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createCaptureEmailAdapter,
} = require(
  "../../src/infrastructure/email/createCaptureEmailAdapter"
);
const {
  createSqliteAccountActionTokenRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAccountActionTokenRepository"
);
const {
  createSqliteCredentialRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCredentialRepository"
);
const {
  CLEARED_PAYLOAD_JSON,
  createSqliteOutboxEventRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteOutboxEventRepository"
);
const {
  createSqlitePlatformRoleRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteSecurityAuditRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createActionTokenDeliveryEnvelope,
} = require(
  "../../src/infrastructure/security/createActionTokenDeliveryEnvelope"
);
const {
  createOpaqueActionTokens,
} = require(
  "../../src/infrastructure/security/createOpaqueActionTokens"
);
const {
  createSecureRandom,
} = require(
  "../../src/infrastructure/security/createSecureRandom"
);
const {
  createSystemClock,
} = require(
  "../../src/infrastructure/security/createSystemClock"
);
const {
  createAccountRegistrationRouter,
} = require(
  "../../src/transport/http/createAccountRegistrationRouter"
);
const {
  createTargetRequestSecurity,
} = require(
  "../../src/transport/http/createTargetRequestSecurity"
);
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");
const {
  PRODUCTION_CONFIRMATION,
  parseArguments,
} = require("../../scripts/bootstrap-first-platform-administrator");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-20T20:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const PASSWORD = "correct horse battery staple";
const STORED_HASH = "scrypt$synthetic-bootstrap-credential";
const PUBLIC_FRONTEND_ORIGIN = "https://hundo.example";
const DELIVERY_KEY = Buffer.alloc(32, 0x63).toString("base64url");
const BOOTSTRAP_SCRIPT = path.join(
  ROOT_DIRECTORY,
  "scripts",
  "bootstrap-first-platform-administrator.js"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function deterministicRandom() {
  let id = 1;
  let byte = 1;
  return createSecureRandom({
    randomBytes(byteLength) {
      const output = Buffer.alloc(byteLength, byte);
      byte = byte === 255 ? 1 : byte + 1;
      return output;
    },
    randomUUID() {
      const output = uuid(id);
      id += 1;
      return output;
    },
  });
}

function tableCount(database, tableName) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get().count;
}

function identity(overrides = {}) {
  return {
    email: "  Grae.Admin@Example.Test  ",
    displayName: "  Grae Admin  ",
    ...overrides,
  };
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "bootstrap.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-09-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const database = connection.database;
  const context = createSqliteRepositoryContext({ database });
  const users = createSqliteUserRepository({ database });
  const credentials = createSqliteCredentialRepository({ database });
  const platformRoles = createSqlitePlatformRoleRepository({ database });
  const actionTokens = createSqliteAccountActionTokenRepository({
    database,
  });
  const audit = createSqliteSecurityAuditRepository({ database });
  const outbox = createSqliteOutboxEventRepository({ database });
  const time = { nowMs: NOW_MS };
  const clock = createSystemClock({ now: () => time.nowMs });
  const secureRandom = deterministicRandom();
  const actionTokenService = createAccountActionTokenService({
    repository: actionTokens,
    opaqueTokens: createOpaqueActionTokens({ secureRandom }),
    clock,
    secureRandom,
  });
  const deliveryEnvelope = createActionTokenDeliveryEnvelope({
    encodedKey: DELIVERY_KEY,
    keyVersion: 1,
    secureRandom,
  });
  const passwordHasher = Object.freeze({
    async hash(password) {
      assert.equal(password, PASSWORD);
      return STORED_HASH;
    },
  });

  function createBootstrapService({
    outboxRepository = outbox,
    auditRepository = audit,
  } = {}) {
    return createFirstPlatformAdministratorService({
      repositoryContext: context,
      userRepository: users,
      platformRoleRepository: platformRoles,
      actionTokenService,
      auditRepository,
      outboxRepository,
      deliveryEnvelope,
      clock,
      secureRandom,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
  }

  function createCredentialSetupService({
    outboxRepository = outbox,
    auditRepository = audit,
  } = {}) {
    return createAdministratorCredentialSetupService({
      actionTokenService,
      userRepository: users,
      credentialRepository: credentials,
      passwordHasher,
      auditRepository,
      outboxRepository,
      clock,
      secureRandom,
    });
  }

  function openBootstrapLink(result) {
    const row = outbox.findById(result.outboxEventId);
    const payload = JSON.parse(row.payload_json);
    const opened = deliveryEnvelope.open({
      envelope: payload.envelope,
      binding: {
        outboxEventId: row.id,
        publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
        purpose: payload.purpose,
        tokenId: payload.tokenId,
        userId: payload.recipientUserId,
      },
    });
    return { opened, payload, row };
  }

  return {
    actionTokenService,
    actionTokens,
    audit,
    context,
    createBootstrapService,
    createCredentialSetupService,
    credentials,
    database,
    databasePath: connection.databasePath,
    deliveryEnvelope,
    openBootstrapLink,
    outbox,
    platformRoles,
    time,
    users,
  };
}

describe("M3-09 first platform-administrator bootstrap", () => {
  test("atomically creates only pending identity, role, audit, token, and encrypted delivery", (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-bootstrap-");
    const result = runtime
      .createBootstrapService()
      .bootstrap(identity());

    assert.deepEqual(result, {
      created: true,
      code: "FIRST_PLATFORM_ADMINISTRATOR_CREATED",
      userId: result.userId,
    });
    assert.equal(Object.keys(result).length, 3);
    assert.equal(JSON.stringify(result).includes(PASSWORD), false);
    assert.equal(result.user.status, "pending_credential_setup");
    assert.equal(result.user.email_normalized, "grae.admin@example.test");
    assert.equal(result.role.role, "platform_administrator");
    assert.equal(result.role.granted_by_user_id, null);
    assert.equal(runtime.credentials.findActiveByUserId(result.userId), null);
    assert.equal(runtime.platformRoles.countPlatformAdministratorHistory(), 1);
    assert.equal(
      runtime.platformRoles.findActiveByUserId(result.userId).id,
      result.role.id
    );
    const link = runtime.openBootstrapLink(result);
    assert.equal(link.payload.purpose, "administrator_setup");
    assert.equal(link.payload.expiresAtMs, NOW_MS + 72 * HOUR_MS);
    assert.equal(link.row.payload_json.includes(link.opened.rawToken), false);
    assert.equal(
      runtime.actionTokens.findById(link.payload.tokenId).token_digest.includes(
        link.opened.rawToken
      ),
      false
    );
    const auditRows = runtime.database
      .prepare("SELECT * FROM security_audit_events")
      .all();
    assert.equal(auditRows.length, 1);
    assert.equal(
      auditRows[0].event_type,
      "system_bootstrap.platform_administrator_created"
    );
    assert.equal(auditRows[0].reason_code, "protected_environment");
    assert.equal(auditRows[0].actor_user_id, null);
    assert.equal(auditRows[0].target_user_id, result.userId);
    for (const table of [
      "leagues",
      "league_memberships",
      "teams",
      "team_manager_assignments",
      "sessions",
      "league_activity",
    ]) {
      assert.equal(tableCount(runtime.database, table), 0, table);
    }
  });

  test("provisions protected active member access when bootstrap follows an existing setup league", (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-existing-league-");
    const leagueId = uuid(90);
    runtime.context.repositories.leagues.insert({
      id: leagueId,
      name: "Existing Setup League",
      name_normalized: "existing setup league",
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });

    const result = runtime
      .createBootstrapService()
      .bootstrap(identity());
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT league_id, user_id, permission_category, status
        FROM league_memberships
      `).get(),
      {
        league_id: leagueId,
        user_id: result.userId,
        permission_category: "member",
        status: "active",
      }
    );
  });

  test("permanently refuses active or ended administrator history", (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-refuse-");
    const first = runtime
      .createBootstrapService()
      .bootstrap(identity());
    assert.throws(
      () =>
        runtime
          .createBootstrapService()
          .bootstrap(
            identity({
              email: "second@example.test",
              displayName: "Second Admin",
            })
          ),
      FirstPlatformAdministratorExistsError
    );
    runtime.database
      .prepare(`
        UPDATE platform_roles
        SET status = 'ended', ended_at_ms = ?, version = version + 1
        WHERE id = ?
      `)
      .run(NOW_MS + 1, first.role.id);
    assert.equal(
      runtime.platformRoles.findActiveByUserId(first.userId),
      null
    );
    assert.throws(
      () =>
        runtime
          .createBootstrapService()
          .bootstrap(
            identity({
              email: "third@example.test",
              displayName: "Third Admin",
            })
          ),
      FirstPlatformAdministratorExistsError
    );
    assert.equal(tableCount(runtime.database, "users"), 1);
    assert.equal(tableCount(runtime.database, "platform_roles"), 1);
  });

  test("rolls back every bootstrap row when encrypted outbox insertion fails", (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-rollback-");
    const failingOutbox = {
      insertPending() {
        throw new Error("synthetic bootstrap outbox failure");
      },
    };
    assert.throws(
      () =>
        runtime
          .createBootstrapService({ outboxRepository: failingOutbox })
          .bootstrap(identity()),
      (error) =>
        error?.code === "REPOSITORY_OPERATION_FAILED" &&
        error?.cause?.message === "synthetic bootstrap outbox failure"
    );
    for (const table of [
      "users",
      "platform_roles",
      "account_action_tokens",
      "security_audit_events",
      "outbox_events",
    ]) {
      assert.equal(tableCount(runtime.database, table), 0, table);
    }
  });

  test("delivers one idempotent fragment-only 72-hour setup link", async (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-delivery-");
    const result = runtime
      .createBootstrapService()
      .bootstrap(identity());
    const plaintext = runtime.openBootstrapLink(result).opened.rawToken;
    const adapter = createCaptureEmailAdapter();
    const delivery = createAccountEmailDeliveryService({
      outboxRepository: runtime.outbox,
      userRepository: runtime.users,
      deliveryEnvelope: runtime.deliveryEnvelope,
      emailAdapter: adapter,
      clock: createSystemClock({ now: () => runtime.time.nowMs }),
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });

    assert.equal((await delivery.deliverDue())[0].outcome, "published");
    assert.deepEqual(await delivery.deliverDue(), []);
    const messages = adapter.listCaptured();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].actionKind, "administrator_setup");
    const link = new URL(messages[0].actionUrl);
    assert.equal(link.pathname, "/setup-account");
    assert.equal(link.search, "");
    assert.equal(link.hash, `#token=${plaintext}`);
    assert.equal(
      runtime.outbox.findById(result.outboxEventId).payload_json,
      CLEARED_PAYLOAD_JSON
    );
  });
});

describe("M3-09 administrator credential setup", () => {
  test("consumes once, activates, stores one credential, notifies, and creates no session", async (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-setup-");
    const bootstrap = runtime
      .createBootstrapService()
      .bootstrap(identity());
    const link = runtime.openBootstrapLink(bootstrap);
    const service = runtime.createCredentialSetupService();
    const input = {
      token: link.opened.rawToken,
      password: PASSWORD,
      passwordConfirmation: PASSWORD,
    };

    const completed = await service.complete(input);
    assert.equal(completed.completed, true);
    assert.equal(completed.signedOut, true);
    assert.equal(completed.user.status, "active");
    assert.equal(runtime.users.findById(bootstrap.userId).status, "active");
    assert.equal(
      runtime.credentials.findActiveByUserId(bootstrap.userId).password_hash,
      STORED_HASH
    );
    assert.equal(
      runtime.actionTokens.findById(link.payload.tokenId).status,
      "consumed"
    );
    assert.equal(
      runtime.outbox.findById(bootstrap.outboxEventId).payload_json,
      CLEARED_PAYLOAD_JSON
    );
    assert.equal(tableCount(runtime.database, "sessions"), 0);
    assert.equal(tableCount(runtime.database, "league_activity"), 0);
    assert.deepEqual(await service.complete(input), {
      completed: false,
      code: "CREDENTIAL_SETUP_INVALID",
    });
    assert.equal(tableCount(runtime.database, "user_credentials"), 1);
    assert.equal(tableCount(runtime.database, "outbox_events"), 2);
    const authentication =
      createCredentialAuthenticationService({
        userRepository: runtime.users,
        credentialRepository: runtime.credentials,
        passwordHasher: {
          async verify(password, encodedPassword) {
            return {
              verified:
                password === PASSWORD &&
                encodedPassword === STORED_HASH,
              needsRehash: false,
            };
          },
        },
      });
    assert.equal(
      (
        await authentication.authenticate({
          email: "grae.admin@example.test",
          password: PASSWORD,
        })
      ).authenticated,
      true
    );
  });

  test("wrong-purpose, malformed, and unknown tokens share one failure", async (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-wrong-purpose-");
    const bootstrap = runtime
      .createBootstrapService()
      .bootstrap(identity());
    const wrongPurpose = runtime.actionTokenService.issue({
      userId: bootstrap.userId,
      purpose: "email_verification",
    });
    const service = runtime.createCredentialSetupService();
    const failures = await Promise.all(
      [wrongPurpose.rawToken, "malformed", "A".repeat(43)].map(
        (token) =>
          service.complete({
            token,
            password: PASSWORD,
            passwordConfirmation: PASSWORD,
          })
      )
    );
    for (const result of failures) {
      assert.deepEqual(result, {
        completed: false,
        code: "CREDENTIAL_SETUP_INVALID",
      });
    }
    assert.equal(
      runtime.users.findById(bootstrap.userId).status,
      "pending_credential_setup"
    );
    assert.equal(tableCount(runtime.database, "user_credentials"), 0);
  });

  test("expiry and concurrent submissions permit no completion or one winner", async (t) => {
    const expired = createRuntime(t, "hundo-m3-09-expired-");
    const expiredBootstrap = expired
      .createBootstrapService()
      .bootstrap(identity());
    const expiredToken = expired.openBootstrapLink(
      expiredBootstrap
    ).opened.rawToken;
    expired.time.nowMs = NOW_MS + 72 * HOUR_MS;
    assert.deepEqual(
      await expired.createCredentialSetupService().complete({
        token: expiredToken,
        password: PASSWORD,
        passwordConfirmation: PASSWORD,
      }),
      {
        completed: false,
        code: "CREDENTIAL_SETUP_INVALID",
      }
    );
    assert.equal(
      expired.users.findById(expiredBootstrap.userId).status,
      "pending_credential_setup"
    );
    assert.equal(tableCount(expired.database, "user_credentials"), 0);

    const concurrent = createRuntime(t, "hundo-m3-09-concurrent-");
    const concurrentBootstrap = concurrent
      .createBootstrapService()
      .bootstrap(identity());
    const concurrentToken = concurrent.openBootstrapLink(
      concurrentBootstrap
    ).opened.rawToken;
    const service = concurrent.createCredentialSetupService();
    const input = {
      token: concurrentToken,
      password: PASSWORD,
      passwordConfirmation: PASSWORD,
    };
    const results = await Promise.all([
      service.complete(input),
      service.complete(input),
    ]);
    assert.equal(results.filter((result) => result.completed).length, 1);
    assert.equal(tableCount(concurrent.database, "user_credentials"), 1);
    assert.equal(tableCount(concurrent.database, "sessions"), 0);
  });

  test("notification failure rolls back token, credential, activation, audit, and clearing", async (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-setup-rollback-");
    const bootstrap = runtime
      .createBootstrapService()
      .bootstrap(identity());
    const link = runtime.openBootstrapLink(bootstrap);
    const failingOutbox = {
      discardByTokenId(options) {
        return runtime.outbox.discardByTokenId(options);
      },
      insertPending() {
        throw new Error("synthetic setup notification failure");
      },
    };

    await assert.rejects(
      () =>
        runtime
          .createCredentialSetupService({
            outboxRepository: failingOutbox,
          })
          .complete({
            token: link.opened.rawToken,
            password: PASSWORD,
            passwordConfirmation: PASSWORD,
          }),
      (error) =>
        error?.code === "REPOSITORY_OPERATION_FAILED" &&
        error?.cause?.message ===
          "synthetic setup notification failure"
    );
    assert.equal(
      runtime.users.findById(bootstrap.userId).status,
      "pending_credential_setup"
    );
    assert.equal(tableCount(runtime.database, "user_credentials"), 0);
    assert.equal(
      runtime.actionTokens.findById(link.payload.tokenId).status,
      "active"
    );
    assert.notEqual(
      runtime.outbox.findById(bootstrap.outboxEventId).payload_json,
      CLEARED_PAYLOAD_JSON
    );
    assert.equal(tableCount(runtime.database, "security_audit_events"), 1);
  });
});

describe("M3-09 first-administrator command boundary", () => {
  test("requires exact environment and production confirmation arguments", () => {
    const base = [
      "--app-env",
      "test",
      "--confirm-app-env",
      "test",
      "--database",
      "C:\\safe\\test.sqlite3",
      "--migrations",
      "C:\\safe\\migrations",
    ];
    assert.equal(parseArguments(base).appEnv, "test");
    for (const invalid of [
      [...base, "--password", "unsafe"],
      base.filter((entry) => entry !== "--database"),
      base.map((entry) =>
        entry === "--confirm-app-env" ? "--app-env" : entry
      ),
      [
        "--app-env",
        "production",
        "--confirm-app-env",
        "production",
        "--database",
        "C:\\safe\\test.sqlite3",
        "--migrations",
        "C:\\safe\\migrations",
        "--persistent-root",
        "C:\\safe",
      ],
    ]) {
      assert.throws(() => parseArguments(invalid), {
        code: "FIRST_PLATFORM_ADMINISTRATOR_ARGUMENT_INVALID",
      });
    }
    assert.equal(
      parseArguments([
        "--app-env",
        "production",
        "--confirm-app-env",
        "production",
        "--database",
        "C:\\safe\\data\\test.sqlite3",
        "--migrations",
        "C:\\safe\\migrations",
        "--persistent-root",
        "C:\\safe",
        "--production-confirmation",
        PRODUCTION_CONFIRMATION,
      ]).productionConfirmation,
      PRODUCTION_CONFIRMATION
    );
  });

  test("creates once through protected input and prints only safe details", (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-command-");
    const argv = [
      BOOTSTRAP_SCRIPT,
      "--app-env",
      "test",
      "--confirm-app-env",
      "test",
      "--database",
      runtime.databasePath,
      "--migrations",
      MIGRATIONS_DIRECTORY,
    ];
    const env = {
      ...process.env,
      BOOTSTRAP_ADMIN_EMAIL: "grae.command@example.test",
      BOOTSTRAP_ADMIN_DISPLAY_NAME: "Grae Command",
      PUBLIC_FRONTEND_ORIGIN,
      ACTION_TOKEN_DELIVERY_KEY: DELIVERY_KEY,
    };

    const first = spawnSync(process.execPath, argv, {
      cwd: ROOT_DIRECTORY,
      env,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    const summary = JSON.parse(first.stdout);
    assert.deepEqual(summary, {
      status: "created",
      code: "FIRST_PLATFORM_ADMINISTRATOR_CREATED",
      userId: summary.userId,
      deliveryQueued: true,
    });
    for (const secret of [
      env.BOOTSTRAP_ADMIN_EMAIL,
      env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
      env.ACTION_TOKEN_DELIVERY_KEY,
    ]) {
      assert.equal(first.stdout.includes(secret), false);
      assert.equal(first.stderr.includes(secret), false);
    }
    assert.equal(tableCount(runtime.database, "users"), 1);
    assert.equal(tableCount(runtime.database, "platform_roles"), 1);

    const second = spawnSync(process.execPath, argv, {
      cwd: ROOT_DIRECTORY,
      env,
      encoding: "utf8",
    });
    assert.equal(second.status, 1);
    assert.equal(second.stdout, "");
    const failure = JSON.parse(second.stderr);
    assert.equal(
      failure.error.code,
      "FIRST_PLATFORM_ADMINISTRATOR_EXISTS"
    );
    assert.equal(second.stderr.includes(env.BOOTSTRAP_ADMIN_EMAIL), false);
    assert.equal(tableCount(runtime.database, "users"), 1);

    const rejected = spawnSync(
      process.execPath,
      [...argv, "--password", PASSWORD],
      {
        cwd: ROOT_DIRECTORY,
        env,
        encoding: "utf8",
      }
    );
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr.includes(PASSWORD), false);
    assert.equal(
      JSON.parse(rejected.stderr).error.code,
      "FIRST_PLATFORM_ADMINISTRATOR_ARGUMENT_INVALID"
    );
    assert.equal(tableCount(runtime.database, "users"), 1);
  });
});

function browserHeaders() {
  return {
    Origin: PUBLIC_FRONTEND_ORIGIN,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
}

async function startAccountApi(t, credentialSetupService) {
  const sessionCookie = createSessionCookie({
    appEnv: "staging",
    publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    sameSite: "none",
  });
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin(origin) {
      return origin === PUBLIC_FRONTEND_ORIGIN;
    },
    requestIdFactory() {
      return "m3-09-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap() {
        return { valid: false, code: "SESSION_INVALID" };
      },
      resolveWithCsrf() {
        return { valid: false, code: "SESSION_INVALID" };
      },
    },
  });
  const unused = {
    async register() {
      throw new Error("unused registration service");
    },
    verify() {
      throw new Error("unused verification service");
    },
    request() {
      throw new Error("unused verification request service");
    },
  };
  const rateLimiter = {
    check() {
      return {
        allowed: true,
        code: "RATE_LIMIT_ALLOWED",
        retryAfterSeconds: 0,
      };
    },
    recordAttempt() {
      return {
        allowed: true,
        code: "RATE_LIMIT_ALLOWED",
        retryAfterSeconds: 0,
      };
    },
  };
  const app = express();
  app.use(
    createAccountRegistrationRouter({
      requestSecurity,
      registrationService: unused,
      verificationService: unused,
      verificationRequestService: unused,
      credentialSetupService,
      rateLimiter,
      sessionCookie,
      networkSourceResolver() {
        return "198.51.100.0/24";
      },
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

describe("M3-09 isolated credential-setup HTTP contract", () => {
  test("completes signed out and keeps invalid links generic", async (t) => {
    const runtime = createRuntime(t, "hundo-m3-09-http-");
    const bootstrap = runtime
      .createBootstrapService()
      .bootstrap(identity());
    const rawToken = runtime.openBootstrapLink(bootstrap).opened.rawToken;
    const baseUrl = await startAccountApi(
      t,
      runtime.createCredentialSetupService()
    );

    const response = await fetch(
      new URL("/api/v1/accounts/credential-setups", baseUrl),
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({
          token: rawToken,
          password: PASSWORD,
          passwordConfirmation: PASSWORD,
        }),
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    const body = await response.json();
    assert.equal(body.data.signedOut, true);
    assert.equal(body.data.user.status, "active");

    const replay = await fetch(
      new URL("/api/v1/accounts/credential-setups", baseUrl),
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({
          token: rawToken,
          password: PASSWORD,
          passwordConfirmation: PASSWORD,
        }),
      }
    );
    assert.equal(replay.status, 400);
    const replayBody = await replay.json();
    assert.equal(replayBody.error.code, "CREDENTIAL_SETUP_INVALID");
    assert.equal(JSON.stringify(replayBody).includes(rawToken), false);
  });
});
