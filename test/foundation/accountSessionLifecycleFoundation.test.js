const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createAccountEmailDeliveryService,
} = require(
  "../../src/application/services/accounts/createAccountEmailDeliveryService"
);
const {
  AccountDeactivationServiceError,
  DEACTIVATION_CONFIRMATION,
  createAccountDeactivationService,
} = require(
  "../../src/application/services/accounts/createAccountDeactivationService"
);
const {
  createAccountReactivationService,
} = require(
  "../../src/application/services/accounts/createAccountReactivationService"
);
const {
  createAccountActionLinkRequestService,
} = require(
  "../../src/application/services/accounts/createAccountActionLinkRequestService"
);
const {
  createAccountActionTokenService,
} = require(
  "../../src/application/services/accounts/createAccountActionTokenService"
);
const {
  createCredentialAuthenticationService,
} = require(
  "../../src/application/services/accounts/createCredentialAuthenticationService"
);
const {
  PasswordChangeServiceError,
  createPasswordChangeService,
} = require(
  "../../src/application/services/accounts/createPasswordChangeService"
);
const {
  createPasswordResetService,
} = require(
  "../../src/application/services/accounts/createPasswordResetService"
);
const {
  createSessionService,
} = require(
  "../../src/application/services/accounts/createSessionService"
);
const {
  createSignInService,
} = require(
  "../../src/application/services/accounts/createSignInService"
);
const {
  createSignOutService,
} = require(
  "../../src/application/services/accounts/createSignOutService"
);
const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  migrateDatabase,
} = require(
  "../../src/infrastructure/database/migrate"
);
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
  createSqliteSessionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSessionRepository"
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
  createKeyedPrivacyDigest,
} = require(
  "../../src/infrastructure/security/createKeyedPrivacyDigest"
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
  createSessionSecrets,
} = require(
  "../../src/infrastructure/security/createSessionSecrets"
);
const {
  createSystemClock,
} = require(
  "../../src/infrastructure/security/createSystemClock"
);
const {
  createAccountSessionRouter,
} = require(
  "../../src/transport/http/createAccountSessionRouter"
);
const {
  createTargetRequestSecurity,
} = require(
  "../../src/transport/http/createTargetRequestSecurity"
);
const {
  createSessionCookie,
} = require(
  "../../src/transport/http/sessionCookie"
);
const {
  createTestAccount,
} = require("../helpers/createTestAccount");

const ROOT_DIRECTORY = path.resolve(
  __dirname,
  "..",
  ".."
);
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse(
  "2026-07-20T16:00:00.000Z"
);
const PASSWORD = "correct horse battery staple";
const STORED_HASH = "scrypt$synthetic-test-credential";
const PUBLIC_FRONTEND_ORIGIN =
  "https://hundo.example";
const DELIVERY_KEY = Buffer.alloc(32, 0x62).toString(
  "base64url"
);
const REPLACEMENT_HASH =
  "scrypt$synthetic-replacement-hash";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

function deterministicRandom() {
  let id = 1;
  let byte = 1;
  return createSecureRandom({
    randomBytes(byteLength) {
      const value = Buffer.alloc(byteLength, byte);
      byte = byte === 255 ? 1 : byte + 1;
      return value;
    },
    randomUUID() {
      const value = uuid(id);
      id += 1;
      return value;
    },
  });
}

function count(database, table) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get().count;
}

async function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-08-session-")
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "session-lifecycle.sqlite3"
    ),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-08-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });

  const database = connection.database;
  const repositoryContext =
    createSqliteRepositoryContext({ database });
  const users = createSqliteUserRepository({ database });
  const credentials =
    createSqliteCredentialRepository({ database });
  const sessions = createSqliteSessionRepository({
    database,
  });
  const actionTokens =
    createSqliteAccountActionTokenRepository({
      database,
    });
  const audit = createSqliteSecurityAuditRepository({
    database,
  });
  const outbox = createSqliteOutboxEventRepository({
    database,
  });
  const secureRandom = deterministicRandom();
  const time = { nowMs: NOW_MS };
  const clock = createSystemClock({
    now: () => time.nowMs,
  });
  const created = await createTestAccount({
    repositoryContext,
    userRepository: users,
    credentialRepository: credentials,
    passwordHasher: {
      async hash() {
        return STORED_HASH;
      },
    },
    clock,
    secureRandom,
    emailNormalized: "manager@example.test",
    emailDisplay: "Manager@Example.Test",
    displayName: "Manager One",
    displayNameNormalized: "manager one",
    password: PASSWORD,
  });
  const passwordHasher = {
    async hash(password) {
      assert.equal(password, "new secure password");
      return REPLACEMENT_HASH;
    },
    async verify(password, encodedPassword) {
      return Object.freeze({
        verified:
          (password === PASSWORD &&
            encodedPassword === STORED_HASH) ||
          (password === "new secure password" &&
            encodedPassword === REPLACEMENT_HASH),
        needsRehash: false,
      });
    },
  };
  const credentialAuthenticationService =
    createCredentialAuthenticationService({
      userRepository: users,
      credentialRepository: credentials,
      passwordHasher,
    });
  const sessionService = createSessionService({
    userRepository: users,
    sessionRepository: sessions,
    sessionSecrets: createSessionSecrets({
      secureRandom,
    }),
    clock,
    secureRandom,
  });
  const actionTokenService =
    createAccountActionTokenService({
      repository: actionTokens,
      opaqueTokens: createOpaqueActionTokens({
        secureRandom,
      }),
      clock,
      secureRandom,
    });
  const deliveryEnvelope =
    createActionTokenDeliveryEnvelope({
      encodedKey: DELIVERY_KEY,
      keyVersion: 1,
      secureRandom,
    });
  const clearCalls = [];
  const rateCalls = [];
  const rateLimiter = {
    check(options) {
      rateCalls.push({ operation: "check", ...options });
      return {
        allowed: true,
        code: "RATE_LIMIT_ALLOWED",
        retryAfterSeconds: 0,
      };
    },
    recordAttempt(options) {
      rateCalls.push({
        operation: "recordAttempt",
        ...options,
      });
      return {
        allowed: true,
        code: "RATE_LIMIT_ALLOWED",
        retryAfterSeconds: 0,
      };
    },
    clearSignInAccountFailures(options) {
      const recent = audit.findRecentByTarget({
        id: created.user.id,
        limit: 100,
      });
      assert.equal(
        recent.some(
          (event) =>
            event.event_type === "account.sign_in" &&
            event.outcome === "success"
        ),
        true
      );
      clearCalls.push(options);
      return true;
    },
  };

  function signInService({
    auditRepository = audit,
    outboxRepository = outbox,
  } = {}) {
    return createSignInService({
      credentialAuthenticationService,
      sessionService,
      auditRepository,
      outboxRepository,
      rateLimiter,
      clock,
      secureRandom,
    });
  }

  return {
    actionTokens,
    actionTokenService,
    audit,
    clearCalls,
    created,
    credentials,
    database,
    deliveryEnvelope,
    outbox,
    passwordHasher,
    rateCalls,
    rateLimiter,
    repositoryContext,
    secureRandom,
    sessionService,
    sessions,
    signInService,
    time,
    users,
    clock,
  };
}

function credentials(password = PASSWORD) {
  return {
    email: " Manager@Example.Test ",
    password,
  };
}

function browserHeaders(extra = {}) {
  return {
    Origin: PUBLIC_FRONTEND_ORIGIN,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...extra,
  };
}

async function request(baseUrl, pathname, {
  method = "GET",
  headers = {},
  body,
} = {}) {
  const response = await fetch(
    new URL(pathname, baseUrl),
    { method, headers, body }
  );
  const text = await response.text();
  return {
    headers: response.headers,
    json: text ? JSON.parse(text) : null,
    status: response.status,
    text,
  };
}

async function startSessionApi(t, runtime) {
  const sessionCookie = createSessionCookie({
    appEnv: "staging",
    publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    sameSite: "none",
  });
  let requestNumber = 1;
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin(origin) {
      return origin === PUBLIC_FRONTEND_ORIGIN;
    },
    sessionCookie,
    sessionService: runtime.sessionService,
    requestIdFactory() {
      const id = `session-request-${requestNumber}`;
      requestNumber += 1;
      return id;
    },
  });
  const signOutService = createSignOutService({
    sessionService: runtime.sessionService,
    auditRepository: runtime.audit,
    clock: runtime.clock,
    secureRandom: runtime.secureRandom,
  });
  const passwordChangeService =
    createPasswordChangeService({
      repositoryContext: runtime.repositoryContext,
      userRepository: runtime.users,
      credentialRepository: runtime.credentials,
      sessionService: runtime.sessionService,
      passwordHasher: runtime.passwordHasher,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  const passwordResetRequestService =
    createAccountActionLinkRequestService({
      purpose: "password_reset",
      userRepository: runtime.users,
      actionTokenService: runtime.actionTokenService,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      deliveryEnvelope: runtime.deliveryEnvelope,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
  const passwordResetService =
    createPasswordResetService({
      actionTokenService: runtime.actionTokenService,
      userRepository: runtime.users,
      credentialRepository: runtime.credentials,
      sessionRepository: runtime.sessions,
      sessionService: runtime.sessionService,
      passwordHasher: runtime.passwordHasher,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  const accountDeactivationService =
    createAccountDeactivationService({
      repositoryContext: runtime.repositoryContext,
      userRepository: runtime.users,
      credentialRepository: runtime.credentials,
      actionTokenService: runtime.actionTokenService,
      sessionService: runtime.sessionService,
      passwordHasher: runtime.passwordHasher,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  const reactivationRequestService =
    createAccountActionLinkRequestService({
      purpose: "self_reactivation",
      userRepository: runtime.users,
      actionTokenService: runtime.actionTokenService,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      deliveryEnvelope: runtime.deliveryEnvelope,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
  const reactivationService =
    createAccountReactivationService({
      actionTokenService: runtime.actionTokenService,
      userRepository: runtime.users,
      credentialRepository: runtime.credentials,
      passwordHasher: runtime.passwordHasher,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  const auditPrivacyDigest =
    createKeyedPrivacyDigest({
      secretSlot: {
        configured: true,
        keyVersion: 1,
        value: "m3-08-audit-test-key",
      },
      purpose: "audit_metadata",
    });
  const router = createAccountSessionRouter({
    requestSecurity,
    signInService: runtime.signInService(),
    signOutService,
    passwordChangeService,
    passwordResetRequestService,
    passwordResetService,
    accountDeactivationService,
    reactivationRequestService,
    reactivationService,
    rateLimiter: runtime.rateLimiter,
    auditPrivacyDigest,
    sessionCookie,
    networkSourceResolver() {
      return "198.51.100.0/24";
    },
  });
  const app = express();
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) =>
          error ? reject(error) : resolve()
        );
      })
  );
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    sessionCookie,
  };
}

describe("M3-08 sign-in and sign-out lifecycle", () => {
  test("failed sign-in is generic, audited, and leaves an existing session unchanged", async (t) => {
    const runtime = await createRuntime(t);
    const existing = runtime.sessionService.issueForUser({
      userId: runtime.created.user.id,
    });

    const result = await runtime
      .signInService()
      .signIn(credentials("incorrect password"));

    assert.deepEqual(result, {
      signedIn: false,
      code: "SIGN_IN_FAILED",
    });
    assert.equal(
      runtime.sessionService.resolve(
        existing.rawSessionToken
      ).valid,
      true
    );
    assert.equal(count(runtime.database, "sessions"), 1);
    assert.equal(count(runtime.database, "outbox_events"), 0);
    const events = runtime.audit.findRecentByTarget({
      id: runtime.created.user.id,
      limit: 10,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "account.sign_in");
    assert.equal(events[0].outcome, "failure");
    assert.equal(events[0].session_id, null);
    assert.doesNotMatch(
      JSON.stringify(events),
      /incorrect password|Manager@Example/
    );
  });

  test("successful sign-in creates one session and clears failures only after audit", async (t) => {
    const runtime = await createRuntime(t);
    const result = await runtime
      .signInService()
      .signIn(credentials(), {
        clientMetadata: {
          networkSourceCategory: "unknown",
          origin: PUBLIC_FRONTEND_ORIGIN,
        },
      });

    assert.equal(result.signedIn, true);
    assert.equal(result.user.id, runtime.created.user.id);
    assert.equal(result.session.status, "active");
    assert.equal(
      Object.keys(result).includes("rawSessionToken"),
      false
    );
    assert.equal(
      runtime.sessionService.resolve(
        result.rawSessionToken
      ).valid,
      true
    );
    assert.deepEqual(runtime.clearCalls, [
      { canonicalIdentifier: "manager@example.test" },
    ]);
    assert.equal(count(runtime.database, "outbox_events"), 0);
  });

  test("new login atomically replaces the old session and queues an idempotent notification", async (t) => {
    const runtime = await createRuntime(t);
    const service = runtime.signInService();
    const first = await service.signIn(credentials());
    const second = await service.signIn(credentials());

    assert.equal(
      runtime.sessionService.resolve(
        first.rawSessionToken
      ).valid,
      false
    );
    assert.equal(
      runtime.sessionService.resolve(
        second.rawSessionToken
      ).valid,
      true
    );
    assert.equal(count(runtime.database, "sessions"), 2);
    assert.equal(
      runtime.database
        .prepare(
          "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'"
        )
        .get().count,
      1
    );
    assert.equal(count(runtime.database, "outbox_events"), 1);
    const pending = runtime.outbox.findDue({
      nowMs: NOW_MS,
      limit: 10,
    })[0];
    assert.deepEqual(JSON.parse(pending.payload_json), {
      deliveryKind: "security_notification",
      notificationKind: "session_replaced",
      occurredAtMs: NOW_MS,
      recipientUserId: runtime.created.user.id,
      schemaVersion: 1,
    });
    assert.doesNotMatch(
      pending.payload_json,
      /token|password|sessionId|Manager@Example/
    );

    const adapter = createCaptureEmailAdapter();
    const delivery = createAccountEmailDeliveryService({
      outboxRepository: runtime.outbox,
      userRepository: runtime.users,
      deliveryEnvelope: {
        open() {
          throw new Error(
            "notification delivery must not open an envelope"
          );
        },
      },
      emailAdapter: adapter,
      clock: runtime.clock,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
    assert.deepEqual(await delivery.deliverDue(), [
      { eventId: pending.id, outcome: "published" },
    ]);
    const captured = adapter.listCaptured();
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].notificationKind,
      "session_replaced"
    );
    assert.equal(
      runtime.outbox.findById(pending.id).payload_json,
      CLEARED_PAYLOAD_JSON
    );
    const duplicate =
      await adapter.sendSecurityNotification({
        idempotencyKey: pending.id,
        notificationKind: "session_replaced",
        occurredAtMs: NOW_MS,
        to: "Manager@Example.Test",
      });
    assert.equal(duplicate.duplicate, true);
  });

  test("notification or audit failure rolls back session replacement", async (t) => {
    const runtime = await createRuntime(t);
    const first = await runtime
      .signInService()
      .signIn(credentials());
    const auditsBefore = count(
      runtime.database,
      "security_audit_events"
    );

    await assert.rejects(
      runtime
        .signInService({
          outboxRepository: {
            insertPending() {
              throw new Error("outbox unavailable");
            },
          },
        })
        .signIn(credentials()),
      (error) =>
        error?.code === "REPOSITORY_OPERATION_FAILED" &&
        error?.cause?.message === "outbox unavailable"
    );
    assert.equal(
      runtime.sessionService.resolve(
        first.rawSessionToken
      ).valid,
      true
    );
    assert.equal(count(runtime.database, "sessions"), 1);
    assert.equal(
      count(runtime.database, "security_audit_events"),
      auditsBefore
    );
  });

  test("sign-out revokes the current session and records its audit atomically", async (t) => {
    const runtime = await createRuntime(t);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const signOut = createSignOutService({
      sessionService: runtime.sessionService,
      auditRepository: runtime.audit,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });

    assert.deepEqual(
      signOut.signOut({
        session: signedIn.session,
        user: signedIn.user,
      }),
      {
        signedOut: true,
        code: "SESSION_SIGNED_OUT",
      }
    );
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      false
    );
    const events = runtime.audit.findRecentByTarget({
      id: runtime.created.user.id,
      limit: 10,
    });
    assert.equal(events[0].event_type, "account.sign_out");
    assert.equal(events[0].session_id, signedIn.session.id);
  });

  test("sign-out audit failure leaves the session active", async (t) => {
    const runtime = await createRuntime(t);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const signOut = createSignOutService({
      sessionService: runtime.sessionService,
      auditRepository: {
        append() {
          throw new Error("audit unavailable");
        },
      },
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });

    assert.throws(
      () =>
        signOut.signOut({
          session: signedIn.session,
          user: signedIn.user,
        }),
      (error) =>
        error?.code === "REPOSITORY_OPERATION_FAILED" &&
        error?.cause?.message === "audit unavailable"
    );
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      true
    );
  });
});

describe("M3-08 password change lifecycle", () => {
  function passwordChangeService(
    runtime,
    { outboxRepository = runtime.outbox } = {}
  ) {
    return createPasswordChangeService({
      repositoryContext: runtime.repositoryContext,
      userRepository: runtime.users,
      credentialRepository: runtime.credentials,
      sessionService: runtime.sessionService,
      passwordHasher: runtime.passwordHasher,
      auditRepository: runtime.audit,
      outboxRepository,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  }

  function changeInput(overrides = {}) {
    return {
      currentPassword: PASSWORD,
      newPassword: "new secure password",
      newPasswordConfirmation: "new secure password",
      ...overrides,
    };
  }

  test("replaces the credential, revokes the session, audits, and queues notification atomically", async (t) => {
    const runtime = await createRuntime(t);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const oldCredential =
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      );

    const result = await passwordChangeService(
      runtime
    ).change({
      input: changeInput(),
      authenticated: {
        session: signedIn.session,
        user: signedIn.user,
      },
    });

    assert.deepEqual(result, {
      changed: true,
      code: "PASSWORD_CHANGED_SIGN_IN_REQUIRED",
      signedOut: true,
    });
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      false
    );
    assert.equal(
      runtime.credentials.findById(oldCredential.id)
        .status,
      "replaced"
    );
    const active =
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      );
    assert.equal(
      active.password_hash,
      REPLACEMENT_HASH
    );
    const event = runtime.audit.findRecentByTarget({
      id: runtime.created.user.id,
      limit: 10,
    })[0];
    assert.equal(
      event.event_type,
      "account.password_change"
    );
    assert.equal(event.outcome, "success");
    const pending = runtime.outbox.findDue({
      nowMs: NOW_MS,
      limit: 10,
    });
    assert.equal(pending.length, 1);
    assert.equal(
      JSON.parse(pending[0].payload_json)
        .notificationKind,
      "password_changed"
    );
    assert.doesNotMatch(
      JSON.stringify(result) +
        JSON.stringify(event) +
        pending[0].payload_json,
      /new secure password|correct horse/
    );
  });

  test("wrong current password is audited but changes no credential or session state", async (t) => {
    const runtime = await createRuntime(t);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const credentialBefore =
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      );

    const result = await passwordChangeService(
      runtime
    ).change({
      input: changeInput({
        currentPassword: "incorrect password",
      }),
      authenticated: {
        session: signedIn.session,
        user: signedIn.user,
      },
    });

    assert.deepEqual(result, {
      changed: false,
      code: "PASSWORD_CHANGE_DENIED",
    });
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      true
    );
    assert.deepEqual(
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      ),
      credentialBefore
    );
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(
      runtime.audit.findRecentByTarget({
        id: runtime.created.user.id,
        limit: 10,
      })[0].reason_code,
      "current_password_rejected"
    );
  });

  test("rejects mismatched or unchanged new passwords before writing", async (t) => {
    const runtime = await createRuntime(t);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const authenticated = {
      session: signedIn.session,
      user: signedIn.user,
    };
    await assert.rejects(
      passwordChangeService(runtime).change({
        input: changeInput({
          newPasswordConfirmation: "different password",
        }),
        authenticated,
      }),
      (error) => error?.code === "PASSWORD_POLICY_INVALID"
    );
    await assert.rejects(
      passwordChangeService(runtime).change({
        input: changeInput({
          newPassword: PASSWORD,
          newPasswordConfirmation: PASSWORD,
        }),
        authenticated,
      }),
      (error) =>
        error instanceof PasswordChangeServiceError &&
        error.code ===
          "PASSWORD_CHANGE_NEW_PASSWORD_UNCHANGED"
    );
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      true
    );
    assert.equal(count(runtime.database, "outbox_events"), 0);
  });

  test("outbox failure rolls back credential replacement, session revocation, and audit", async (t) => {
    const runtime = await createRuntime(t);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const activeBefore =
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      );
    const auditsBefore = count(
      runtime.database,
      "security_audit_events"
    );

    await assert.rejects(
      passwordChangeService(runtime, {
        outboxRepository: {
          insertPending() {
            throw new Error("outbox unavailable");
          },
        },
      }).change({
        input: changeInput(),
        authenticated: {
          session: signedIn.session,
          user: signedIn.user,
        },
      }),
      (error) =>
        error?.code === "REPOSITORY_OPERATION_FAILED" &&
        error?.cause?.message === "outbox unavailable"
    );
    assert.deepEqual(
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      ),
      activeBefore
    );
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      true
    );
    assert.equal(
      count(runtime.database, "security_audit_events"),
      auditsBefore
    );
  });
});

describe("M3-08 password reset lifecycle", () => {
  function resetRequestService(runtime) {
    return createAccountActionLinkRequestService({
      purpose: "password_reset",
      userRepository: runtime.users,
      actionTokenService: runtime.actionTokenService,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      deliveryEnvelope: runtime.deliveryEnvelope,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
  }

  function passwordResetService(
    runtime,
    { outboxRepository = runtime.outbox } = {}
  ) {
    return createPasswordResetService({
      actionTokenService: runtime.actionTokenService,
      userRepository: runtime.users,
      credentialRepository: runtime.credentials,
      sessionRepository: runtime.sessions,
      sessionService: runtime.sessionService,
      passwordHasher: runtime.passwordHasher,
      auditRepository: runtime.audit,
      outboxRepository,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  }

  function activeReset(runtime) {
    const token =
      runtime.actionTokens.findActiveByUserPurpose(
        runtime.created.user.id,
        "password_reset"
      );
    const outbox = runtime.database
      .prepare(
        "SELECT * FROM outbox_events " +
          "WHERE event_type = 'account.password_reset_requested' " +
          "ORDER BY created_at_ms DESC, id DESC LIMIT 1"
      )
      .get();
    const payload = JSON.parse(outbox.payload_json);
    const opened = runtime.deliveryEnvelope.open({
      envelope: payload.envelope,
      binding: {
        outboxEventId: outbox.id,
        publicFrontendOrigin:
          PUBLIC_FRONTEND_ORIGIN,
        purpose: "password_reset",
        tokenId: token.id,
        userId: runtime.created.user.id,
      },
    });
    return {
      outbox,
      payload,
      rawToken: opened.rawToken,
      token,
    };
  }

  function resetInput(rawToken) {
    return {
      token: rawToken,
      newPassword: "new secure password",
      newPasswordConfirmation: "new secure password",
    };
  }

  test("uses the same public request result and stores only a digest plus encrypted link envelope", async (t) => {
    const runtime = await createRuntime(t);
    const service = resetRequestService(runtime);
    const known = service.request({
      email: " Manager@Example.Test ",
    });
    const unknown = service.request({
      email: "unknown@example.test",
    });

    assert.deepEqual(known, {
      accepted: true,
      code: "PASSWORD_RESET_REQUEST_ACCEPTED",
    });
    assert.deepEqual(unknown, known);
    assert.equal(known.issued, true);
    assert.equal(unknown.issued, false);
    const reset = activeReset(runtime);
    assert.equal(
      reset.token.expires_at_ms,
      NOW_MS + 30 * 60 * 1000
    );
    assert.notEqual(
      reset.token.token_digest,
      reset.rawToken
    );
    assert.equal(
      reset.outbox.payload_json.includes(
        reset.rawToken
      ),
      false
    );
    assert.equal(
      runtime.audit.findRecentByTarget({
        id: runtime.created.user.id,
        limit: 10,
      })[0].event_type,
      "account.password_reset_requested"
    );
  });

  test("a replacement request invalidates the old token and clears its ciphertext", async (t) => {
    const runtime = await createRuntime(t);
    const service = resetRequestService(runtime);
    service.request({ email: "manager@example.test" });
    const first = activeReset(runtime);
    service.request({ email: "manager@example.test" });
    const second = activeReset(runtime);

    assert.notEqual(first.token.id, second.token.id);
    assert.equal(
      runtime.actionTokenService.resolve({
        rawToken: first.rawToken,
        expectedPurpose: "password_reset",
      }).valid,
      false
    );
    assert.equal(
      runtime.outbox.findById(first.outbox.id)
        .payload_json,
      CLEARED_PAYLOAD_JSON
    );
    assert.equal(
      runtime.actionTokenService.resolve({
        rawToken: second.rawToken,
        expectedPurpose: "password_reset",
      }).valid,
      true
    );
  });

  test("delivers a fragment-only reset link idempotently and clears ciphertext", async (t) => {
    const runtime = await createRuntime(t);
    resetRequestService(runtime).request({
      email: "manager@example.test",
    });
    const reset = activeReset(runtime);
    const adapter = createCaptureEmailAdapter();
    const delivery = createAccountEmailDeliveryService({
      outboxRepository: runtime.outbox,
      userRepository: runtime.users,
      deliveryEnvelope: runtime.deliveryEnvelope,
      emailAdapter: adapter,
      clock: runtime.clock,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });

    assert.equal(
      (await delivery.deliverDue())[0].outcome,
      "published"
    );
    const captured = adapter.listCaptured()[0];
    assert.equal(captured.actionKind, "password_reset");
    assert.equal(
      captured.actionUrl,
      `${PUBLIC_FRONTEND_ORIGIN}/reset-password#token=${reset.rawToken}`
    );
    assert.equal(new URL(captured.actionUrl).search, "");
    assert.equal(
      runtime.outbox.findById(reset.outbox.id)
        .payload_json,
      CLEARED_PAYLOAD_JSON
    );
  });

  test("completion consumes once, replaces the credential, revokes the session, and creates no new session", async (t) => {
    const runtime = await createRuntime(t);
    resetRequestService(runtime).request({
      email: "manager@example.test",
    });
    const reset = activeReset(runtime);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const sessionsBefore = count(
      runtime.database,
      "sessions"
    );

    const result = await passwordResetService(
      runtime
    ).reset(resetInput(reset.rawToken));

    assert.deepEqual(result, {
      reset: true,
      code: "PASSWORD_RESET_COMPLETED",
      signedOut: true,
    });
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      false
    );
    assert.equal(
      count(runtime.database, "sessions"),
      sessionsBefore
    );
    assert.equal(
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      ).password_hash,
      REPLACEMENT_HASH
    );
    assert.equal(
      runtime.actionTokens.findById(reset.token.id)
        .status,
      "consumed"
    );
    assert.equal(
      runtime.outbox.findById(reset.outbox.id)
        .payload_json,
      CLEARED_PAYLOAD_JSON
    );
    const pending = runtime.outbox.findDue({
      nowMs: NOW_MS,
      limit: 10,
    });
    assert.equal(pending.length, 1);
    assert.equal(
      JSON.parse(pending[0].payload_json)
        .notificationKind,
      "password_reset_completed"
    );
    assert.deepEqual(
      await passwordResetService(runtime).reset(
        resetInput(reset.rawToken)
      ),
      {
        reset: false,
        code: "PASSWORD_RESET_INVALID",
      }
    );
  });

  test("expired and concurrent submissions permit no reset or only one reset", async (t) => {
    const expiredRuntime = await createRuntime(t);
    resetRequestService(expiredRuntime).request({
      email: "manager@example.test",
    });
    const expired = activeReset(expiredRuntime);
    expiredRuntime.time.nowMs =
      NOW_MS + 30 * 60 * 1000;
    assert.deepEqual(
      await passwordResetService(expiredRuntime).reset(
        resetInput(expired.rawToken)
      ),
      {
        reset: false,
        code: "PASSWORD_RESET_INVALID",
      }
    );
    assert.equal(
      expiredRuntime.credentials.findActiveByUserId(
        expiredRuntime.created.user.id
      ).password_hash,
      STORED_HASH
    );

    const raceRuntime = await createRuntime(t);
    resetRequestService(raceRuntime).request({
      email: "manager@example.test",
    });
    const raced = activeReset(raceRuntime);
    const results = await Promise.all([
      passwordResetService(raceRuntime).reset(
        resetInput(raced.rawToken)
      ),
      passwordResetService(raceRuntime).reset(
        resetInput(raced.rawToken)
      ),
    ]);
    assert.equal(
      results.filter((result) => result.reset).length,
      1
    );
  });

  test("completion notification failure rolls back token, credential, session, audit, and link clearing", async (t) => {
    const runtime = await createRuntime(t);
    resetRequestService(runtime).request({
      email: "manager@example.test",
    });
    const reset = activeReset(runtime);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const auditsBefore = count(
      runtime.database,
      "security_audit_events"
    );
    const failingOutbox = {
      discardByTokenId(options) {
        return runtime.outbox.discardByTokenId(options);
      },
      insertPending() {
        throw new Error("completion outbox unavailable");
      },
    };

    await assert.rejects(
      passwordResetService(runtime, {
        outboxRepository: failingOutbox,
      }).reset(resetInput(reset.rawToken)),
      (error) =>
        error?.code === "REPOSITORY_OPERATION_FAILED" &&
        error?.cause?.message ===
          "completion outbox unavailable"
    );
    assert.equal(
      runtime.actionTokens.findById(reset.token.id)
        .status,
      "active"
    );
    assert.equal(
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      ).password_hash,
      STORED_HASH
    );
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      true
    );
    assert.equal(
      runtime.outbox.findById(reset.outbox.id).status,
      "pending"
    );
    assert.equal(
      count(runtime.database, "security_audit_events"),
      auditsBefore
    );
  });
});

describe("M3-08 deactivation and reactivation lifecycle", () => {
  function deactivationService(
    runtime,
    { outboxRepository = runtime.outbox } = {}
  ) {
    return createAccountDeactivationService({
      repositoryContext: runtime.repositoryContext,
      userRepository: runtime.users,
      credentialRepository: runtime.credentials,
      actionTokenService: runtime.actionTokenService,
      sessionService: runtime.sessionService,
      passwordHasher: runtime.passwordHasher,
      auditRepository: runtime.audit,
      outboxRepository,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  }

  function reactivationRequestService(runtime) {
    return createAccountActionLinkRequestService({
      purpose: "self_reactivation",
      userRepository: runtime.users,
      actionTokenService: runtime.actionTokenService,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      deliveryEnvelope: runtime.deliveryEnvelope,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
  }

  function reactivationService(
    runtime,
    { outboxRepository = runtime.outbox } = {}
  ) {
    return createAccountReactivationService({
      actionTokenService: runtime.actionTokenService,
      userRepository: runtime.users,
      credentialRepository: runtime.credentials,
      passwordHasher: runtime.passwordHasher,
      auditRepository: runtime.audit,
      outboxRepository,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  }

  async function deactivate(runtime) {
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const result = await deactivationService(
      runtime
    ).deactivate({
      input: {
        confirmation: DEACTIVATION_CONFIRMATION,
        currentPassword: PASSWORD,
      },
      authenticated: {
        session: signedIn.session,
        user: signedIn.user,
      },
    });
    return { result, signedIn };
  }

  function activeReactivation(runtime) {
    const token =
      runtime.actionTokens.findActiveByUserPurpose(
        runtime.created.user.id,
        "self_reactivation"
      );
    const outbox = runtime.database
      .prepare(
        "SELECT * FROM outbox_events " +
          "WHERE event_type = 'account.reactivation_requested' " +
          "ORDER BY created_at_ms DESC, id DESC LIMIT 1"
      )
      .get();
    const payload = JSON.parse(outbox.payload_json);
    const opened = runtime.deliveryEnvelope.open({
      envelope: payload.envelope,
      binding: {
        outboxEventId: outbox.id,
        publicFrontendOrigin:
          PUBLIC_FRONTEND_ORIGIN,
        purpose: "self_reactivation",
        tokenId: token.id,
        userId: runtime.created.user.id,
      },
    });
    return {
      outbox,
      payload,
      rawToken: opened.rawToken,
      token,
    };
  }

  test("deactivation requires the exact confirmation and current password", async (t) => {
    const runtime = await createRuntime(t);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const authenticated = {
      session: signedIn.session,
      user: signedIn.user,
    };

    await assert.rejects(
      deactivationService(runtime).deactivate({
        input: {
          confirmation: "yes",
          currentPassword: PASSWORD,
        },
        authenticated,
      }),
      (error) =>
        error instanceof AccountDeactivationServiceError &&
        error.code ===
          "ACCOUNT_DEACTIVATION_CONFIRMATION_INVALID"
    );
    const denied = await deactivationService(
      runtime
    ).deactivate({
      input: {
        confirmation: DEACTIVATION_CONFIRMATION,
        currentPassword: "incorrect password",
      },
      authenticated,
    });
    assert.deepEqual(denied, {
      deactivated: false,
      code: "ACCOUNT_DEACTIVATION_DENIED",
    });
    assert.equal(
      runtime.users.findById(runtime.created.user.id)
        .status,
      "active"
    );
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      true
    );
    assert.equal(count(runtime.database, "outbox_events"), 0);
  });

  test("deactivation changes only account eligibility, revokes the session, and preserves records", async (t) => {
    const runtime = await createRuntime(t);
    createAccountActionLinkRequestService({
      purpose: "password_reset",
      userRepository: runtime.users,
      actionTokenService: runtime.actionTokenService,
      auditRepository: runtime.audit,
      outboxRepository: runtime.outbox,
      deliveryEnvelope: runtime.deliveryEnvelope,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    }).request({ email: "manager@example.test" });
    const resetToken =
      runtime.actionTokens.findActiveByUserPurpose(
        runtime.created.user.id,
        "password_reset"
      );
    const resetOutbox = runtime.database
      .prepare(
        "SELECT id FROM outbox_events " +
          "WHERE event_type = 'account.password_reset_requested'"
      )
      .get();
    const membershipCount = count(
      runtime.database,
      "league_memberships"
    );
    const credential =
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      );
    const { result, signedIn } = await deactivate(
      runtime
    );

    assert.deepEqual(result, {
      deactivated: true,
      code: "ACCOUNT_DEACTIVATED",
      signedOut: true,
    });
    assert.equal(
      runtime.users.findById(runtime.created.user.id)
        .status,
      "deactivated"
    );
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      false
    );
    assert.deepEqual(
      runtime.credentials.findActiveByUserId(
        runtime.created.user.id
      ),
      credential
    );
    assert.equal(
      count(runtime.database, "league_memberships"),
      membershipCount
    );
    assert.equal(
      runtime.actionTokens.findById(resetToken.id).status,
      "invalidated"
    );
    assert.equal(
      runtime.outbox.findById(resetOutbox.id)
        .payload_json,
      CLEARED_PAYLOAD_JSON
    );
    const pending = runtime.outbox.findDue({
      nowMs: NOW_MS,
      limit: 10,
    });
    assert.equal(pending.length, 1);
    assert.equal(
      JSON.parse(pending[0].payload_json)
        .notificationKind,
      "account_deactivated"
    );
  });

  test("deactivation notification failure rolls back status, session, and audit", async (t) => {
    const runtime = await createRuntime(t);
    const signedIn = await runtime
      .signInService()
      .signIn(credentials());
    const auditsBefore = count(
      runtime.database,
      "security_audit_events"
    );

    await assert.rejects(
      deactivationService(runtime, {
        outboxRepository: {
          discardByTokenId(options) {
            return runtime.outbox.discardByTokenId(
              options
            );
          },
          insertPending() {
            throw new Error("deactivation outbox unavailable");
          },
        },
      }).deactivate({
        input: {
          confirmation: DEACTIVATION_CONFIRMATION,
          currentPassword: PASSWORD,
        },
        authenticated: {
          session: signedIn.session,
          user: signedIn.user,
        },
      }),
      (error) =>
        error?.code === "REPOSITORY_OPERATION_FAILED" &&
        error?.cause?.message ===
          "deactivation outbox unavailable"
    );
    assert.equal(
      runtime.users.findById(runtime.created.user.id)
        .status,
      "active"
    );
    assert.equal(
      runtime.sessionService.resolve(
        signedIn.rawSessionToken
      ).valid,
      true
    );
    assert.equal(
      count(runtime.database, "security_audit_events"),
      auditsBefore
    );
  });

  test("reactivation request is generic, replaces links, and delivers a fragment-only link", async (t) => {
    const runtime = await createRuntime(t);
    await deactivate(runtime);
    const service = reactivationRequestService(runtime);
    const known = service.request({
      email: "manager@example.test",
    });
    const unknown = service.request({
      email: "unknown@example.test",
    });
    assert.deepEqual(known, {
      accepted: true,
      code: "REACTIVATION_REQUEST_ACCEPTED",
    });
    assert.deepEqual(unknown, known);
    const first = activeReactivation(runtime);
    service.request({ email: "manager@example.test" });
    const second = activeReactivation(runtime);
    assert.equal(
      runtime.actionTokenService.resolve({
        rawToken: first.rawToken,
        expectedPurpose: "self_reactivation",
      }).valid,
      false
    );
    assert.equal(
      runtime.outbox.findById(first.outbox.id)
        .payload_json,
      CLEARED_PAYLOAD_JSON
    );
    assert.equal(
      second.token.expires_at_ms,
      NOW_MS + 30 * 60 * 1000
    );

    const adapter = createCaptureEmailAdapter();
    const delivery = createAccountEmailDeliveryService({
      outboxRepository: runtime.outbox,
      userRepository: runtime.users,
      deliveryEnvelope: runtime.deliveryEnvelope,
      emailAdapter: adapter,
      clock: runtime.clock,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
    await delivery.deliverDue({ limit: 10 });
    const captured = adapter
      .listCaptured()
      .find(
        (message) =>
          message.actionKind === "self_reactivation"
      );
    assert.equal(
      captured.actionUrl,
      `${PUBLIC_FRONTEND_ORIGIN}/reactivate#token=${second.rawToken}`
    );
    assert.equal(new URL(captured.actionUrl).search, "");
  });

  test("reactivation requires the current password, creates no session, and restores no authority", async (t) => {
    const runtime = await createRuntime(t);
    await deactivate(runtime);
    reactivationRequestService(runtime).request({
      email: "manager@example.test",
    });
    const link = activeReactivation(runtime);
    const service = reactivationService(runtime);
    const denied = await service.reactivate({
      token: link.rawToken,
      currentPassword: "incorrect password",
    });
    assert.deepEqual(denied, {
      reactivated: false,
      code: "ACCOUNT_REACTIVATION_INVALID",
    });
    assert.equal(
      runtime.actionTokens.findById(link.token.id)
        .failed_attempt_count,
      1
    );
    const sessionCount = count(
      runtime.database,
      "sessions"
    );
    const membershipCount = count(
      runtime.database,
      "league_memberships"
    );

    const result = await service.reactivate({
      token: link.rawToken,
      currentPassword: PASSWORD,
    });
    assert.deepEqual(result, {
      reactivated: true,
      code: "ACCOUNT_REACTIVATED_SIGN_IN_REQUIRED",
      signedIn: false,
      user: {
        id: runtime.created.user.id,
        displayName: "Manager One",
        status: "active",
        version: 3,
      },
    });
    assert.equal(
      count(runtime.database, "sessions"),
      sessionCount
    );
    assert.equal(
      runtime.database
        .prepare(
          "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'"
        )
        .get().count,
      0
    );
    assert.equal(
      count(runtime.database, "league_memberships"),
      membershipCount
    );
    assert.equal(
      runtime.actionTokens.findById(link.token.id)
        .status,
      "consumed"
    );
    assert.deepEqual(
      await service.reactivate({
        token: link.rawToken,
        currentPassword: PASSWORD,
      }),
      {
        reactivated: false,
        code: "ACCOUNT_REACTIVATION_INVALID",
      }
    );
  });

  test("expired and concurrent reactivation submissions allow no activation or one activation", async (t) => {
    const expiredRuntime = await createRuntime(t);
    await deactivate(expiredRuntime);
    reactivationRequestService(expiredRuntime).request({
      email: "manager@example.test",
    });
    const expired = activeReactivation(expiredRuntime);
    expiredRuntime.time.nowMs =
      NOW_MS + 30 * 60 * 1000;
    assert.equal(
      (
        await reactivationService(
          expiredRuntime
        ).reactivate({
          token: expired.rawToken,
          currentPassword: PASSWORD,
        })
      ).reactivated,
      false
    );
    assert.equal(
      expiredRuntime.users.findById(
        expiredRuntime.created.user.id
      ).status,
      "deactivated"
    );

    const raceRuntime = await createRuntime(t);
    await deactivate(raceRuntime);
    reactivationRequestService(raceRuntime).request({
      email: "manager@example.test",
    });
    const raced = activeReactivation(raceRuntime);
    const results = await Promise.all([
      reactivationService(raceRuntime).reactivate({
        token: raced.rawToken,
        currentPassword: PASSWORD,
      }),
      reactivationService(raceRuntime).reactivate({
        token: raced.rawToken,
        currentPassword: PASSWORD,
      }),
    ]);
    assert.equal(
      results.filter(
        (result) => result.reactivated
      ).length,
      1
    );
  });

  test("reactivation notification failure rolls back status, token, audit, and link clearing", async (t) => {
    const runtime = await createRuntime(t);
    await deactivate(runtime);
    reactivationRequestService(runtime).request({
      email: "manager@example.test",
    });
    const link = activeReactivation(runtime);
    const auditsBefore = count(
      runtime.database,
      "security_audit_events"
    );
    const failingOutbox = {
      discardByTokenId(options) {
        return runtime.outbox.discardByTokenId(options);
      },
      insertPending() {
        throw new Error("reactivation outbox unavailable");
      },
    };

    await assert.rejects(
      reactivationService(runtime, {
        outboxRepository: failingOutbox,
      }).reactivate({
        token: link.rawToken,
        currentPassword: PASSWORD,
      }),
      (error) =>
        error?.code === "REPOSITORY_OPERATION_FAILED" &&
        error?.cause?.message ===
          "reactivation outbox unavailable"
    );
    assert.equal(
      runtime.users.findById(runtime.created.user.id)
        .status,
      "deactivated"
    );
    assert.equal(
      runtime.actionTokens.findById(link.token.id)
        .status,
      "active"
    );
    assert.equal(
      runtime.outbox.findById(link.outbox.id).status,
      "pending"
    );
    assert.equal(
      count(runtime.database, "security_audit_events"),
      auditsBefore
    );
  });

  test("platform-disabled accounts cannot enter self-reactivation", async (t) => {
    const runtime = await createRuntime(t);
    const user = runtime.users.findById(
      runtime.created.user.id
    );
    runtime.users.updateVersioned({
      key: user.id,
      expectedVersion: user.version,
      changes: {
        status: "disabled",
        updated_at_ms: NOW_MS,
      },
    });
    const result = reactivationRequestService(
      runtime
    ).request({ email: "manager@example.test" });
    assert.deepEqual(result, {
      accepted: true,
      code: "REACTIVATION_REQUEST_ACCEPTED",
    });
    assert.equal(
      runtime.actionTokens.findActiveByUserPurpose(
        user.id,
        "self_reactivation"
      ),
      null
    );
  });
});

describe("M3-08 isolated session HTTP contracts", () => {
  test("signs in, bootstraps without writes, and authoritatively signs out", async (t) => {
    const runtime = await createRuntime(t);
    const api = await startSessionApi(t, runtime);
    const signIn = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(credentials()),
      }
    );

    assert.equal(signIn.status, 200);
    assert.equal(signIn.json.data.user.displayName, "Manager One");
    assert.equal(
      signIn.json.meta.requestId,
      "session-request-1"
    );
    const setCookie = signIn.headers.get("set-cookie");
    assert.match(
      setCookie,
      /^__Host-hl_session=[A-Za-z0-9_-]{43};/
    );
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=None/);
    assert.doesNotMatch(
      signIn.text,
      /correct horse|token_digest|password_hash/
    );
    const cookie = setCookie.split(";", 1)[0];

    const before = runtime.database
      .prepare("SELECT * FROM sessions ORDER BY id")
      .all();
    const bootstrap = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        headers: browserHeaders({ Cookie: cookie }),
      }
    );
    const after = runtime.database
      .prepare("SELECT * FROM sessions ORDER BY id")
      .all();
    assert.equal(bootstrap.status, 200);
    assert.equal(
      bootstrap.json.data.session.id,
      signIn.json.data.session.id
    );
    assert.equal(
      bootstrap.json.data.csrfToken,
      signIn.json.data.csrfToken
    );
    assert.deepEqual(after, before);

    const wrongCsrf = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "DELETE",
        headers: browserHeaders({
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": "wrong-token",
        }),
        body: "{}",
      }
    );
    assert.equal(wrongCsrf.status, 403);

    const signOut = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "DELETE",
        headers: browserHeaders({
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token":
            signIn.json.data.csrfToken,
        }),
        body: "{}",
      }
    );
    assert.equal(signOut.status, 200);
    assert.deepEqual(signOut.json.data, {
      signedOut: true,
      code: "SESSION_SIGNED_OUT",
    });
    assert.match(
      signOut.headers.get("set-cookie"),
      /^__Host-hl_session=; Max-Age=0;/
    );

    const rejected = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        headers: browserHeaders({ Cookie: cookie }),
      }
    );
    assert.equal(rejected.status, 401);
  });

  test("keeps wrong and unknown login failures equivalent and enforces browser boundaries", async (t) => {
    const runtime = await createRuntime(t);
    const api = await startSessionApi(t, runtime);

    const wrong = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(
          credentials("incorrect password")
        ),
      }
    );
    const unknown = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          email: "unknown@example.test",
          password: "incorrect password",
        }),
      }
    );
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(
      wrong.json.error.code,
      unknown.json.error.code
    );
    assert.equal(
      wrong.json.error.message,
      unknown.json.error.message
    );
    assert.equal(
      wrong.headers.get("set-cookie"),
      null
    );
    assert.equal(
      unknown.headers.get("set-cookie"),
      null
    );
    assert.doesNotMatch(
      wrong.text + unknown.text,
      /manager@example|unknown@example|credential_rejected/
    );

    const deniedOrigin = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "POST",
        headers: {
          ...browserHeaders({
            "Content-Type": "application/json",
          }),
          Origin: "https://evil.example",
        },
        body: JSON.stringify(credentials()),
      }
    );
    assert.equal(deniedOrigin.status, 403);
    assert.equal(
      deniedOrigin.json.error.code,
      "ORIGIN_NOT_ALLOWED"
    );
    assert.equal(count(runtime.database, "sessions"), 0);
    assert.equal(
      runtime.rateCalls.filter(
        (call) => call.operation === "recordAttempt"
      ).length,
      4
    );
  });

  test("changes a password only with the authenticated CSRF boundary and clears the cookie", async (t) => {
    const runtime = await createRuntime(t);
    const api = await startSessionApi(t, runtime);
    const signIn = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(credentials()),
      }
    );
    const cookie = signIn.headers
      .get("set-cookie")
      .split(";", 1)[0];

    const missingCsrf = await request(
      api.baseUrl,
      "/api/v1/session/password",
      {
        method: "POST",
        headers: browserHeaders({
          Cookie: cookie,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          currentPassword: PASSWORD,
          newPassword: "new secure password",
          newPasswordConfirmation: "new secure password",
        }),
      }
    );
    assert.equal(missingCsrf.status, 403);

    const changed = await request(
      api.baseUrl,
      "/api/v1/session/password",
      {
        method: "POST",
        headers: browserHeaders({
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token":
            signIn.json.data.csrfToken,
        }),
        body: JSON.stringify({
          currentPassword: PASSWORD,
          newPassword: "new secure password",
          newPasswordConfirmation: "new secure password",
        }),
      }
    );
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.json.data, {
      changed: true,
      code: "PASSWORD_CHANGED_SIGN_IN_REQUIRED",
      signedOut: true,
    });
    assert.match(
      changed.headers.get("set-cookie"),
      /^__Host-hl_session=; Max-Age=0;/
    );
    assert.doesNotMatch(
      changed.text,
      /correct horse|new secure password/
    );
    const rejected = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        headers: browserHeaders({ Cookie: cookie }),
      }
    );
    assert.equal(rejected.status, 401);
    assert.equal(
      runtime.rateCalls.some(
        (call) =>
          call.operation === "recordAttempt" &&
          call.action === "password_change" &&
          call.canonicalIdentifier ===
            runtime.created.user.id
      ),
      true
    );
  });

  test("keeps reset requests generic and completes one public reset without creating a session", async (t) => {
    const runtime = await createRuntime(t);
    const api = await startSessionApi(t, runtime);
    const known = await request(
      api.baseUrl,
      "/api/v1/password-reset-requests",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          email: "manager@example.test",
        }),
      }
    );
    const unknown = await request(
      api.baseUrl,
      "/api/v1/password-reset-requests",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          email: "unknown@example.test",
        }),
      }
    );
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(known.json.data, { accepted: true });
    assert.deepEqual(unknown.json.data, known.json.data);
    const reset = (() => {
      const token =
        runtime.actionTokens.findActiveByUserPurpose(
          runtime.created.user.id,
          "password_reset"
        );
      const outbox = runtime.database
        .prepare(
          "SELECT * FROM outbox_events " +
            "WHERE event_type = 'account.password_reset_requested'"
        )
        .get();
      const payload = JSON.parse(outbox.payload_json);
      const opened = runtime.deliveryEnvelope.open({
        envelope: payload.envelope,
        binding: {
          outboxEventId: outbox.id,
          publicFrontendOrigin:
            PUBLIC_FRONTEND_ORIGIN,
          purpose: "password_reset",
          tokenId: token.id,
          userId: runtime.created.user.id,
        },
      });
      return opened.rawToken;
    })();

    const signIn = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(credentials()),
      }
    );
    const oldCookie = signIn.headers
      .get("set-cookie")
      .split(";", 1)[0];
    const invalid = await request(
      api.baseUrl,
      "/api/v1/password-resets",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          token: "A".repeat(43),
          newPassword: "new secure password",
          newPasswordConfirmation: "new secure password",
        }),
      }
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      invalid.json.error.code,
      "PASSWORD_RESET_INVALID"
    );

    const completed = await request(
      api.baseUrl,
      "/api/v1/password-resets",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          token: reset,
          newPassword: "new secure password",
          newPasswordConfirmation: "new secure password",
        }),
      }
    );
    assert.equal(completed.status, 200);
    assert.deepEqual(completed.json.data, {
      reset: true,
      code: "PASSWORD_RESET_COMPLETED",
      signedOut: true,
    });
    assert.match(
      completed.headers.get("set-cookie"),
      /^__Host-hl_session=; Max-Age=0;/
    );
    assert.doesNotMatch(
      known.text + unknown.text + completed.text,
      /manager@example|unknown@example|new secure password/
    );
    const oldSession = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        headers: browserHeaders({
          Cookie: oldCookie,
        }),
      }
    );
    assert.equal(oldSession.status, 401);
    assert.equal(
      runtime.rateCalls.some(
        (call) =>
          call.action === "password_reset_request"
      ),
      true
    );
    assert.equal(
      runtime.rateCalls.some(
        (call) =>
          call.action === "action_token_completion"
      ),
      true
    );
  });

  test("deactivates behind CSRF, then generically requests and completes reactivation signed out", async (t) => {
    const runtime = await createRuntime(t);
    const api = await startSessionApi(t, runtime);
    const signIn = await request(
      api.baseUrl,
      "/api/v1/session",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(credentials()),
      }
    );
    const cookie = signIn.headers
      .get("set-cookie")
      .split(";", 1)[0];
    const deniedCsrf = await request(
      api.baseUrl,
      "/api/v1/account/deactivation",
      {
        method: "POST",
        headers: browserHeaders({
          Cookie: cookie,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          confirmation: DEACTIVATION_CONFIRMATION,
          currentPassword: PASSWORD,
        }),
      }
    );
    assert.equal(deniedCsrf.status, 403);
    const deactivated = await request(
      api.baseUrl,
      "/api/v1/account/deactivation",
      {
        method: "POST",
        headers: browserHeaders({
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token":
            signIn.json.data.csrfToken,
        }),
        body: JSON.stringify({
          confirmation: DEACTIVATION_CONFIRMATION,
          currentPassword: PASSWORD,
        }),
      }
    );
    assert.equal(deactivated.status, 200);
    assert.match(
      deactivated.headers.get("set-cookie"),
      /^__Host-hl_session=; Max-Age=0;/
    );

    const known = await request(
      api.baseUrl,
      "/api/v1/account/reactivation-requests",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          email: "manager@example.test",
        }),
      }
    );
    const unknown = await request(
      api.baseUrl,
      "/api/v1/account/reactivation-requests",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          email: "unknown@example.test",
        }),
      }
    );
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(known.json.data, unknown.json.data);
    const token =
      runtime.actionTokens.findActiveByUserPurpose(
        runtime.created.user.id,
        "self_reactivation"
      );
    const linkOutbox = runtime.database
      .prepare(
        "SELECT * FROM outbox_events " +
          "WHERE event_type = 'account.reactivation_requested'"
      )
      .get();
    const payload = JSON.parse(
      linkOutbox.payload_json
    );
    const rawToken = runtime.deliveryEnvelope.open({
      envelope: payload.envelope,
      binding: {
        outboxEventId: linkOutbox.id,
        publicFrontendOrigin:
          PUBLIC_FRONTEND_ORIGIN,
        purpose: "self_reactivation",
        tokenId: token.id,
        userId: runtime.created.user.id,
      },
    }).rawToken;

    const wrong = await request(
      api.baseUrl,
      "/api/v1/account/reactivations",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          token: rawToken,
          currentPassword: "incorrect password",
        }),
      }
    );
    assert.equal(wrong.status, 400);
    const reactivated = await request(
      api.baseUrl,
      "/api/v1/account/reactivations",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          token: rawToken,
          currentPassword: PASSWORD,
        }),
      }
    );
    assert.equal(reactivated.status, 200);
    assert.equal(
      reactivated.json.data.signedIn,
      false
    );
    assert.equal(
      reactivated.json.data.user.status,
      "active"
    );
    assert.match(
      reactivated.headers.get("set-cookie"),
      /^__Host-hl_session=; Max-Age=0;/
    );
    assert.equal(
      runtime.database
        .prepare(
          "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'"
        )
        .get().count,
      0
    );
    assert.equal(
      runtime.rateCalls.some(
        (call) =>
          call.action === "account_deactivation"
      ),
      true
    );
    assert.equal(
      runtime.rateCalls.some(
        (call) =>
          call.action === "reactivation_request"
      ),
      true
    );
  });
});
