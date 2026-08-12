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
  createAccountActionTokenService,
} = require(
  "../../src/application/services/accounts/createAccountActionTokenService"
);
const {
  createEmailVerificationService,
} = require(
  "../../src/application/services/accounts/createEmailVerificationService"
);
const {
  createEmailVerificationRequestService,
} = require(
  "../../src/application/services/accounts/createEmailVerificationRequestService"
);
const {
  createSelfServiceAccountService,
} = require(
  "../../src/application/services/accounts/createSelfServiceAccountService"
);
const {
  createSessionService,
} = require(
  "../../src/application/services/accounts/createSessionService"
);
const {
  AccountRegistrationPolicyError,
  normalizeDisplayName,
  normalizeEmail,
  validateAccountRegistration,
} = require(
  "../../src/domain/accounts/accountRegistrationPolicy"
);
const {
  PasswordPolicyError,
  assertPasswordConfirmation,
} = require(
  "../../src/domain/accounts/passwordPolicy"
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
  createSqliteOutboxEventRepository,
  CLEARED_PAYLOAD_JSON,
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
  createCaptureEmailAdapter,
} = require(
  "../../src/infrastructure/email/createCaptureEmailAdapter"
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
} = require(
  "../../src/transport/http/sessionCookie"
);

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
const CREATED_AT_MS = Date.parse(
  "2026-07-20T12:00:00.000Z"
);
const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_FRONTEND_ORIGIN =
  "https://hundo.example";
const DELIVERY_KEY = Buffer.alloc(32, 0x61).toString(
  "base64url"
);

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

function tableCount(database, table) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get().count;
}

function registration(overrides = {}) {
  return {
    email: "  Manager.One@Example.Test  ",
    displayName: "  Månager One 🏒  ",
    password: "correct horse battery staple",
    passwordConfirmation:
      "correct horse battery staple",
    ...overrides,
  };
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const databasePath = path.join(
    temporaryRoot,
    "account-registration.sqlite3"
  );
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-07-test",
    now: () => CREATED_AT_MS,
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
  const context = createSqliteRepositoryContext({
    database,
  });
  const users = createSqliteUserRepository({ database });
  const credentials = createSqliteCredentialRepository({
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
  const sessions = createSqliteSessionRepository({
    database,
  });
  const time = { nowMs: CREATED_AT_MS };
  const clock = createSystemClock({
    now: () => time.nowMs,
  });
  const secureRandom = deterministicRandom();
  const opaqueActionTokens = createOpaqueActionTokens({
    secureRandom,
  });
  const actionTokenService =
    createAccountActionTokenService({
      repository: actionTokens,
      opaqueTokens: opaqueActionTokens,
      clock,
      secureRandom,
    });
  const deliveryEnvelope =
    createActionTokenDeliveryEnvelope({
      encodedKey: DELIVERY_KEY,
      keyVersion: 1,
      secureRandom,
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
  const passwordHasher = Object.freeze({
    async hash(password) {
      assert.equal(
        password,
        "correct horse battery staple"
      );
      return "scrypt$synthetic-test-credential";
    },
  });

  function createRegistrationService({
    outboxRepository = outbox,
    auditRepository = audit,
  } = {}) {
    return createSelfServiceAccountService({
      repositoryContext: context,
      userRepository: users,
      credentialRepository: credentials,
      actionTokenService,
      auditRepository,
      outboxRepository,
      passwordHasher,
      deliveryEnvelope,
      clock,
      secureRandom,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
  }

  function createVerificationService({
    auditRepository = audit,
  } = {}) {
    return createEmailVerificationService({
      actionTokenService,
      userRepository: users,
      sessionService,
      auditRepository,
      outboxRepository: outbox,
      clock,
      secureRandom,
    });
  }

  function createVerificationRequestService() {
    return createEmailVerificationRequestService({
      userRepository: users,
      actionTokenService,
      auditRepository: audit,
      outboxRepository: outbox,
      deliveryEnvelope,
      clock,
      secureRandom,
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
  }

  function decryptRegistration(result) {
    const row = outbox.findById(result.outboxEventId);
    const payload = JSON.parse(row.payload_json);
    const opened = deliveryEnvelope.open({
      envelope: payload.envelope,
      binding: {
        outboxEventId: row.id,
        publicFrontendOrigin:
          PUBLIC_FRONTEND_ORIGIN,
        purpose: payload.purpose,
        tokenId: payload.tokenId,
        userId: payload.recipientUserId,
      },
    });
    return { opened, payload, row };
  }

  return {
    actionTokens,
    audit,
    context,
    credentials,
    createRegistrationService,
    createVerificationService,
    createVerificationRequestService,
    database,
    decryptRegistration,
    deliveryEnvelope,
    outbox,
    sessions,
    time,
    users,
  };
}

describe("M3-07 account registration policy", () => {
  test("normalizes approved identity fields and keeps the password non-enumerable", () => {
    assert.deepEqual(
      normalizeEmail("  Person@Example.Test "),
      {
        display: "Person@Example.Test",
        normalized: "person@example.test",
      }
    );
    assert.deepEqual(
      normalizeDisplayName("  Månager 🏒  "),
      {
        display: "Månager 🏒",
        normalized: "manager 🏒".replace(
          "manager",
          "månager"
        ),
      }
    );
    const validated = validateAccountRegistration(
      registration()
    );
    assert.equal(
      validated.emailNormalized,
      "manager.one@example.test"
    );
    assert.equal(validated.displayName, "Månager One 🏒");
    assert.equal(
      Object.keys(validated).includes("password"),
      false
    );
    assert.equal(
      JSON.stringify(validated).includes(
        registration().password
      ),
      false
    );
  });

  test("rejects malformed email, control characters, overlong names, mismatches, and extra input", () => {
    const invalidInputs = [
      registration({ email: "missing-at-sign" }),
      registration({ email: "a@.example" }),
      registration({ displayName: "line\nbreak" }),
      registration({ displayName: "🏒".repeat(51) }),
      { ...registration(), authority: "commissioner" },
    ];
    for (const input of invalidInputs) {
      assert.throws(
        () => validateAccountRegistration(input),
        AccountRegistrationPolicyError
      );
    }
    assert.throws(
      () => {
        const input = registration({
          passwordConfirmation: "different value",
        });
        const validated =
          validateAccountRegistration(input);
        assertPasswordConfirmation(
          validated.password,
          validated.passwordConfirmation
        );
      },
      PasswordPolicyError
    );
  });
});

describe("M3-07 atomic pending account creation", () => {
  test("creates only pending account state, digest-only token state, audit, and encrypted outbox", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-registration-"
    );
    const result = await runtime
      .createRegistrationService()
      .register(registration());

    assert.deepEqual(
      JSON.parse(JSON.stringify(result)),
      {
        accepted: true,
        code: "ACCOUNT_REGISTRATION_ACCEPTED",
      }
    );
    assert.equal(result.created, true);
    const user = runtime.users.findById(result.user.id);
    assert.equal(user.status, "pending_verification");
    assert.equal(
      user.email_normalized,
      "manager.one@example.test"
    );
    assert.equal(user.display_name, "Månager One 🏒");
    const credential =
      runtime.credentials.findActiveByUserId(user.id);
    assert.equal(
      credential.password_hash,
      "scrypt$synthetic-test-credential"
    );
    const storedToken =
      runtime.actionTokens.findActiveByUserPurpose(
        user.id,
        "email_verification"
      );
    assert.match(storedToken.token_digest, /^[0-9a-f]{64}$/);
    const { opened, payload, row } =
      runtime.decryptRegistration(result);
    assert.equal(
      payload.expiresAtMs,
      CREATED_AT_MS + DAY_MS
    );
    assert.equal(
      runtime.actionTokens.findByDigest(
        require("node:crypto")
          .createHash("sha256")
          .update(
            Buffer.from(opened.rawToken, "base64url")
          )
          .digest("hex")
      ).id,
      storedToken.id
    );
    const serializedDatabaseState = JSON.stringify({
      user,
      credential,
      storedToken,
      row,
      audit: runtime.audit.findRecentByTarget({
        id: user.id,
        limit: 10,
      }),
    });
    for (const forbidden of [
      opened.rawToken,
      registration().password,
      "https://hundo.example/verify",
    ]) {
      assert.equal(
        serializedDatabaseState.includes(forbidden),
        false
      );
    }
    assert.equal(tableCount(runtime.database, "users"), 1);
    assert.equal(
      tableCount(runtime.database, "user_credentials"),
      1
    );
    assert.equal(
      tableCount(runtime.database, "account_action_tokens"),
      1
    );
    assert.equal(
      tableCount(runtime.database, "security_audit_events"),
      1
    );
    assert.equal(
      tableCount(runtime.database, "account_events"),
      0
    );
    for (const table of [
      "platform_roles",
      "league_memberships",
      "team_manager_assignments",
      "teams",
    ]) {
      assert.equal(tableCount(runtime.database, table), 0);
    }
  });

  test("returns the same public result for duplicate email or display name and creates no duplicate", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-duplicate-"
    );
    const service = runtime.createRegistrationService();
    const first = await service.register(registration());
    const duplicateEmail = await service.register(
      registration({
        email: "manager.one@example.test",
        displayName: "Different Manager",
      })
    );
    const duplicateName = await service.register(
      registration({
        email: "different@example.test",
        displayName: "mÅNAGER ONE 🏒",
      })
    );

    assert.deepEqual(
      JSON.parse(JSON.stringify(duplicateEmail)),
      JSON.parse(JSON.stringify(first))
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(duplicateName)),
      JSON.parse(JSON.stringify(first))
    );
    assert.equal(duplicateEmail.created, false);
    assert.equal(duplicateName.created, false);
    assert.equal(tableCount(runtime.database, "users"), 1);
    assert.equal(
      tableCount(runtime.database, "outbox_events"),
      1
    );
  });

  test("rolls back every account row when encrypted outbox insertion fails", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-rollback-"
    );
    const service = runtime.createRegistrationService({
      outboxRepository: {
        insertPending() {
          throw new Error("synthetic outbox failure");
        },
      },
    });
    await assert.rejects(
      service.register(registration()),
      (error) =>
        error.code === "REPOSITORY_OPERATION_FAILED" &&
        error.cause?.message ===
          "synthetic outbox failure"
    );
    for (const table of [
      "users",
      "user_credentials",
      "account_action_tokens",
      "security_audit_events",
      "outbox_events",
    ]) {
      assert.equal(tableCount(runtime.database, table), 0);
    }
  });
});

describe("M3-07 email verification lifecycle", () => {
  test("atomically activates once, creates the initial session, and audits outside League Activity", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-verification-"
    );
    const registrationResult = await runtime
      .createRegistrationService()
      .register(registration());
    const { opened, payload } =
      runtime.decryptRegistration(registrationResult);
    const service = runtime.createVerificationService();
    const verified = service.verify({
      rawToken: opened.rawToken,
      clientMetadata: {
        networkSourceCategory: "local",
        origin: "https://hundo.example",
        userAgentFamily: "Synthetic Browser",
        userAgentHash: "a".repeat(64),
      },
    });

    assert.equal(verified.verified, true);
    assert.equal(verified.user.status, "active");
    assert.equal(
      Object.keys(verified).includes("rawSessionToken"),
      false
    );
    assert.equal(
      Object.keys(verified).includes("rawCsrfToken"),
      false
    );
    assert.equal(
      runtime.users.findById(verified.user.id).status,
      "active"
    );
    assert.equal(
      runtime.actionTokens.findById(payload.tokenId).status,
      "consumed"
    );
    assert.equal(
      runtime.outbox.findById(
        registrationResult.outboxEventId
      ).payload_json,
      CLEARED_PAYLOAD_JSON
    );
    assert.equal(tableCount(runtime.database, "sessions"), 1);
    assert.equal(
      runtime.sessions.findByTokenDigest(
        require("node:crypto")
          .createHash("sha256")
          .update(
            Buffer.from(
              verified.rawSessionToken,
              "base64url"
            )
          )
          .digest("hex")
      ).id,
      verified.session.id
    );
    assert.equal(
      tableCount(runtime.database, "security_audit_events"),
      2
    );
    assert.equal(
      tableCount(runtime.database, "account_events"),
      0
    );
    assert.deepEqual(
      service.verify({ rawToken: opened.rawToken }),
      {
        verified: false,
        code: "EMAIL_VERIFICATION_INVALID",
      }
    );
    assert.equal(tableCount(runtime.database, "sessions"), 1);
  });

  test("rejects expiry without activation and rolls back activation when audit fails", async (t) => {
    const expiredRuntime = createRuntime(
      t,
      "hundo-m3-07-expired-"
    );
    const expiredRegistration = await expiredRuntime
      .createRegistrationService()
      .register(registration());
    const expiredPlaintext =
      expiredRuntime.decryptRegistration(
        expiredRegistration
      ).opened.rawToken;
    expiredRuntime.time.nowMs =
      CREATED_AT_MS + DAY_MS;
    assert.deepEqual(
      expiredRuntime
        .createVerificationService()
        .verify({ rawToken: expiredPlaintext }),
      {
        verified: false,
        code: "EMAIL_VERIFICATION_INVALID",
      }
    );
    assert.equal(
      expiredRuntime.users.findById(
        expiredRegistration.user.id
      ).status,
      "pending_verification"
    );
    assert.equal(
      tableCount(expiredRuntime.database, "sessions"),
      0
    );

    const rollbackRuntime = createRuntime(
      t,
      "hundo-m3-07-verify-rollback-"
    );
    const rollbackRegistration = await rollbackRuntime
      .createRegistrationService()
      .register(registration());
    const decrypted = rollbackRuntime.decryptRegistration(
      rollbackRegistration
    );
    const failingAudit = {
      append() {
        throw new Error("synthetic audit failure");
      },
    };
    assert.throws(
      () =>
        rollbackRuntime
          .createVerificationService({
            auditRepository: failingAudit,
          })
          .verify({ rawToken: decrypted.opened.rawToken }),
      (error) =>
        error.code === "REPOSITORY_OPERATION_FAILED" &&
        error.cause?.message ===
          "synthetic audit failure"
    );
    assert.equal(
      rollbackRuntime.users.findById(
        rollbackRegistration.user.id
      ).status,
      "pending_verification"
    );
    assert.equal(
      rollbackRuntime.actionTokens.findById(
        decrypted.payload.tokenId
      ).status,
      "active"
    );
    assert.equal(
      tableCount(rollbackRuntime.database, "sessions"),
      0
    );
    assert.equal(
      rollbackRuntime.outbox.findById(
        rollbackRegistration.outboxEventId
      ).status,
      "pending"
    );
  });
});

describe("M3-07 durable account-email outbox transitions", () => {
  test("claims once, retains ciphertext for retry, and clears it on terminal discard", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-outbox-"
    );
    const registrationResult = await runtime
      .createRegistrationService()
      .register(registration());
    const pending = runtime.outbox.findById(
      registrationResult.outboxEventId
    );
    assert.equal(
      runtime.outbox.findDue({
        nowMs: CREATED_AT_MS,
        limit: 10,
      }).length,
      1
    );
    const publishing = runtime.outbox.claimForDelivery({
      eventId: pending.id,
      expectedVersion: pending.version,
      nowMs: CREATED_AT_MS,
    });
    assert.equal(publishing.status, "publishing");
    assert.equal(publishing.attempt_count, 1);
    const failed = runtime.outbox.markRetryableFailure({
      eventId: publishing.id,
      expectedVersion: publishing.version,
      nowMs: CREATED_AT_MS,
      availableAtMs: CREATED_AT_MS + 1000,
      errorCode: "EMAIL_PROVIDER_RETRYABLE",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.payload_json, pending.payload_json);
    assert.equal(
      runtime.outbox.findDue({
        nowMs: CREATED_AT_MS,
        limit: 10,
      }).length,
      0
    );
    const discarded = runtime.outbox.discard({
      eventId: failed.id,
      expectedVersion: failed.version,
      nowMs: CREATED_AT_MS + 1000,
      errorCode: "EMAIL_TOKEN_EXPIRED",
    });
    assert.equal(discarded.status, "discarded");
    assert.equal(
      discarded.payload_json,
      CLEARED_PAYLOAD_JSON
    );
    assert.equal(
      discarded.payload_json.includes(
        JSON.parse(pending.payload_json).envelope
          .ciphertext
      ),
      false
    );
  });

  test("delivers after commit with one fragment link and clears ciphertext on publish", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-delivery-"
    );
    const result = await runtime
      .createRegistrationService()
      .register(registration());
    const plaintext =
      runtime.decryptRegistration(result).opened
        .rawToken;
    const adapter = createCaptureEmailAdapter();
    const delivery = createAccountEmailDeliveryService({
      outboxRepository: runtime.outbox,
      userRepository: runtime.users,
      deliveryEnvelope: runtime.deliveryEnvelope,
      emailAdapter: adapter,
      clock: createSystemClock({
        now: () => runtime.time.nowMs,
      }),
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });

    assert.deepEqual(await delivery.deliverDue(), [
      {
        eventId: result.outboxEventId,
        outcome: "published",
      },
    ]);
    const published = runtime.outbox.findById(
      result.outboxEventId
    );
    assert.equal(published.status, "published");
    assert.equal(
      published.payload_json,
      CLEARED_PAYLOAD_JSON
    );
    const captured = adapter.listCaptured();
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].verificationUrl,
      `${PUBLIC_FRONTEND_ORIGIN}/verify-email#token=${plaintext}`
    );
    assert.equal(
      new URL(captured[0].verificationUrl).search,
      ""
    );
    const duplicate =
      await adapter.sendEmailVerification({
        expiresAtMs: captured[0].expiresAtMs,
        idempotencyKey:
          captured[0].idempotencyKey,
        to: captured[0].to,
        verificationUrl:
          captured[0].verificationUrl,
      });
    assert.equal(duplicate.duplicate, true);
    assert.equal(adapter.listCaptured().length, 1);
  });

  test("recovers interrupted claims and bounds retry attempts before clearing ciphertext", async (t) => {
    const recoveryRuntime = createRuntime(
      t,
      "hundo-m3-07-recovery-"
    );
    const recoveryResult = await recoveryRuntime
      .createRegistrationService()
      .register(registration());
    const pending = recoveryRuntime.outbox.findById(
      recoveryResult.outboxEventId
    );
    recoveryRuntime.outbox.claimForDelivery({
      eventId: pending.id,
      expectedVersion: pending.version,
      nowMs: CREATED_AT_MS,
    });
    recoveryRuntime.time.nowMs =
      CREATED_AT_MS + 5 * 60 * 1000;
    const capture = createCaptureEmailAdapter();
    const recoveryDelivery =
      createAccountEmailDeliveryService({
        outboxRepository: recoveryRuntime.outbox,
        userRepository: recoveryRuntime.users,
        deliveryEnvelope:
          recoveryRuntime.deliveryEnvelope,
        emailAdapter: capture,
        clock: createSystemClock({
          now: () => recoveryRuntime.time.nowMs,
        }),
        publicFrontendOrigin:
          PUBLIC_FRONTEND_ORIGIN,
      });
    assert.equal(
      recoveryDelivery.recoverInterrupted().length,
      1
    );
    assert.equal(
      recoveryRuntime.outbox.findById(pending.id).status,
      "failed"
    );
    assert.equal(
      (await recoveryDelivery.deliverDue())[0].outcome,
      "published"
    );
    assert.equal(capture.listCaptured().length, 1);

    const retryRuntime = createRuntime(
      t,
      "hundo-m3-07-bounded-retry-"
    );
    const retryResult = await retryRuntime
      .createRegistrationService()
      .register(registration());
    const failingAdapter = {
      async sendEmailVerification() {
        const error = new Error("provider unavailable");
        error.retryable = true;
        throw error;
      },
    };
    const retryDelivery =
      createAccountEmailDeliveryService({
        outboxRepository: retryRuntime.outbox,
        userRepository: retryRuntime.users,
        deliveryEnvelope:
          retryRuntime.deliveryEnvelope,
        emailAdapter: failingAdapter,
        clock: createSystemClock({
          now: () => retryRuntime.time.nowMs,
        }),
        publicFrontendOrigin:
          PUBLIC_FRONTEND_ORIGIN,
        maximumAttempts: 2,
      });
    assert.equal(
      (await retryDelivery.deliverDue())[0].outcome,
      "retry_scheduled"
    );
    const failed = retryRuntime.outbox.findById(
      retryResult.outboxEventId
    );
    assert.equal(failed.status, "failed");
    assert.notEqual(
      failed.payload_json,
      CLEARED_PAYLOAD_JSON
    );
    retryRuntime.time.nowMs = failed.available_at_ms;
    assert.equal(
      (await retryDelivery.deliverDue())[0].outcome,
      "discarded"
    );
    const discarded = retryRuntime.outbox.findById(
      retryResult.outboxEventId
    );
    assert.equal(discarded.attempt_count, 2);
    assert.equal(
      discarded.payload_json,
      CLEARED_PAYLOAD_JSON
    );
  });

  test("discards expired encrypted delivery without calling the adapter", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-delivery-expired-"
    );
    const result = await runtime
      .createRegistrationService()
      .register(registration());
    runtime.time.nowMs = CREATED_AT_MS + DAY_MS;
    let calls = 0;
    const delivery = createAccountEmailDeliveryService({
      outboxRepository: runtime.outbox,
      userRepository: runtime.users,
      deliveryEnvelope: runtime.deliveryEnvelope,
      emailAdapter: {
        async sendEmailVerification() {
          calls += 1;
        },
      },
      clock: createSystemClock({
        now: () => runtime.time.nowMs,
      }),
      publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    });
    assert.equal(
      (await delivery.deliverDue())[0].outcome,
      "discarded"
    );
    assert.equal(calls, 0);
    assert.equal(
      runtime.outbox.findById(result.outboxEventId)
        .payload_json,
      CLEARED_PAYLOAD_JSON
    );
  });
});

function browserJsonHeaders(origin = PUBLIC_FRONTEND_ORIGIN) {
  return {
    Origin: origin,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
}

async function httpRequest(
  baseUrl,
  pathname,
  { headers, body } = {}
) {
  const response = await fetch(
    new URL(pathname, baseUrl),
    {
      method: "POST",
      headers,
      body,
    }
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text ? JSON.parse(text) : null,
  };
}

async function startAccountApi(
  t,
  runtime,
  {
    rateLimiter: suppliedRateLimiter,
    automaticVerificationEnabled = false,
  } = {}
) {
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
    requestIdFactory() {
      const value = `request-${requestNumber}`;
      requestNumber += 1;
      return value;
    },
    sessionCookie,
    sessionService: {
      bootstrap() {
        return {
          valid: false,
          code: "SESSION_INVALID",
        };
      },
      resolveWithCsrf() {
        return {
          valid: false,
          code: "SESSION_INVALID",
        };
      },
    },
  });
  const rateCalls = [];
  const rateLimiter =
    suppliedRateLimiter || {
      check(identity) {
        rateCalls.push({ operation: "check", ...identity });
        return {
          allowed: true,
          code: "RATE_LIMIT_ALLOWED",
          retryAfterSeconds: 0,
        };
      },
      recordAttempt(identity) {
        rateCalls.push({
          operation: "recordAttempt",
          ...identity,
        });
        return {
          allowed: true,
          code: "RATE_LIMIT_ALLOWED",
          retryAfterSeconds: 0,
        };
      },
    };
  const router = createAccountRegistrationRouter({
    requestSecurity,
    registrationService:
      runtime.createRegistrationService(),
    verificationService:
      runtime.createVerificationService(),
    verificationRequestService:
      runtime.createVerificationRequestService(),
    credentialSetupService: {
      async complete() {
        throw new Error(
          "credential setup is outside the M3-07 fixture"
        );
      },
    },
    rateLimiter,
    sessionCookie,
    networkSourceResolver() {
      return "198.51.100.0/24";
    },
    automaticVerificationEnabled,
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
    rateCalls,
  };
}

describe("M3-07 isolated public account HTTP contracts", () => {
  test("automatically verifies only when the staging fixture capability is explicitly enabled", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-staging-auto-verification-"
    );
    const api = await startAccountApi(t, runtime, {
      automaticVerificationEnabled: true,
    });
    const signUp = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts",
      {
        headers: browserJsonHeaders(),
        body: JSON.stringify(registration()),
      }
    );

    assert.equal(signUp.status, 201);
    assert.equal(signUp.json.data.accepted, true);
    assert.equal(
      signUp.json.data.automaticVerification,
      true
    );
    assert.equal(signUp.json.data.user.status, "active");
    assert.equal(signUp.json.data.session.status, "active");
    assert.match(
      signUp.json.data.csrfToken,
      /^[A-Za-z0-9_-]{43}$/
    );
    assert.match(
      signUp.headers.get("set-cookie"),
      /^__Host-hl_session=[A-Za-z0-9_-]{43}; /
    );
    assert.equal(
      runtime.users.findByNormalizedEmail(
        "manager.one@example.test"
      ).status,
      "active"
    );
    const outbox = runtime.database
      .prepare(
        "SELECT status, payload_json FROM outbox_events"
      )
      .get();
    assert.deepEqual(outbox, {
      status: "discarded",
      payload_json: CLEARED_PAYLOAD_JSON,
    });
  });

  test("registers, generically resends, verifies, and sets only the opaque session cookie", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-http-"
    );
    const api = await startAccountApi(t, runtime);
    const signUp = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts",
      {
        headers: browserJsonHeaders(),
        body: JSON.stringify(registration()),
      }
    );
    assert.equal(signUp.status, 202);
    assert.deepEqual(signUp.json.data, {
      accepted: true,
    });
    assert.equal(signUp.json.meta.requestId, "request-1");
    assert.equal(
      signUp.headers.get(
        "access-control-allow-origin"
      ),
      PUBLIC_FRONTEND_ORIGIN
    );
    assert.equal(
      signUp.headers.get("cache-control"),
      "no-store"
    );

    const firstPending = runtime.database
      .prepare(
        "SELECT id, payload_json FROM outbox_events " +
          "WHERE status = 'pending'"
      )
      .get();
    const firstToken = runtime.decryptRegistration({
      outboxEventId: firstPending.id,
    }).opened.rawToken;
    assert.equal(signUp.text.includes(firstToken), false);

    const knownResend = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts/email-verification-requests",
      {
        headers: browserJsonHeaders(),
        body: JSON.stringify({
          email: "MANAGER.ONE@example.test",
        }),
      }
    );
    const unknownResend = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts/email-verification-requests",
      {
        headers: browserJsonHeaders(),
        body: JSON.stringify({
          email: "unknown@example.test",
        }),
      }
    );
    assert.equal(knownResend.status, 202);
    assert.equal(unknownResend.status, 202);
    assert.deepEqual(
      knownResend.json.data,
      unknownResend.json.data
    );
    assert.equal(
      knownResend.text.includes(
        "manager.one@example.test"
      ),
      false
    );
    const rows = runtime.database
      .prepare(
        "SELECT id, status, payload_json FROM outbox_events " +
          "ORDER BY created_at_ms ASC, id ASC"
      )
      .all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, "discarded");
    assert.equal(
      rows[0].payload_json,
      CLEARED_PAYLOAD_JSON
    );
    assert.equal(rows[1].status, "pending");
    const currentToken = runtime.decryptRegistration({
      outboxEventId: rows[1].id,
    }).opened.rawToken;
    assert.notEqual(currentToken, firstToken);

    const replaced = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts/email-verifications",
      {
        headers: browserJsonHeaders(),
        body: JSON.stringify({ token: firstToken }),
      }
    );
    assert.equal(replaced.status, 400);
    assert.equal(
      replaced.json.error.code,
      "EMAIL_VERIFICATION_INVALID"
    );
    assert.equal(
      runtime.users.findByNormalizedEmail(
        "manager.one@example.test"
      ).status,
      "pending_verification"
    );

    const verify = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts/email-verifications",
      {
        headers: browserJsonHeaders(),
        body: JSON.stringify({ token: currentToken }),
      }
    );
    assert.equal(verify.status, 200);
    assert.equal(verify.json.data.user.status, "active");
    assert.match(
      verify.json.data.csrfToken,
      /^[A-Za-z0-9_-]{43}$/
    );
    const setCookie = verify.headers.get("set-cookie");
    assert.match(
      setCookie,
      /^__Host-hl_session=[A-Za-z0-9_-]{43}; /
    );
    assert.match(setCookie, /; HttpOnly; Secure; SameSite=None$/);
    const rawSessionToken =
      /^__Host-hl_session=([^;]+)/.exec(setCookie)[1];
    assert.equal(
      verify.text.includes(rawSessionToken),
      false
    );
    assert.equal(
      runtime.users.findByNormalizedEmail(
        "manager.one@example.test"
      ).status,
      "active"
    );
    assert.equal(
      api.rateCalls.some(
        (call) =>
          call.action === "sign_up" &&
          call.bucket === "network" &&
          call.canonicalIdentifier ===
            "198.51.100.0/24"
      ),
      true
    );
    assert.equal(
      api.rateCalls.some(
        (call) =>
          call.action ===
            "action_token_completion" &&
          call.bucket === "subject" &&
          call.failed === false
      ),
      true
    );
  });

  test("rejects unknown origins, malformed JSON, and durable rate limits with safe request IDs", async (t) => {
    const runtime = createRuntime(
      t,
      "hundo-m3-07-http-denials-"
    );
    const rateLimiter = {
      check(identity) {
        if (
          identity.action === "sign_up" &&
          identity.bucket === "network"
        ) {
          return {
            allowed: false,
            code: "RATE_LIMITED",
            retryAfterSeconds: 37,
          };
        }
        return {
          allowed: true,
          code: "RATE_LIMIT_ALLOWED",
          retryAfterSeconds: 0,
        };
      },
      recordAttempt() {
        throw new Error(
          "a blocked request must not be recorded again"
        );
      },
    };
    const api = await startAccountApi(t, runtime, {
      rateLimiter,
    });
    const wrongOrigin = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts",
      {
        headers: browserJsonHeaders(
          "https://attacker.example"
        ),
        body: JSON.stringify(registration()),
      }
    );
    assert.equal(wrongOrigin.status, 403);
    assert.equal(
      wrongOrigin.json.error.code,
      "ORIGIN_NOT_ALLOWED"
    );
    assert.equal(
      wrongOrigin.json.error.requestId,
      "request-1"
    );
    assert.equal(
      wrongOrigin.headers.get(
        "access-control-allow-origin"
      ),
      null
    );

    const malformed = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts",
      {
        headers: browserJsonHeaders(),
        body: "{",
      }
    );
    assert.equal(malformed.status, 400);
    assert.equal(
      malformed.json.error.code,
      "REQUEST_BODY_INVALID"
    );
    assert.equal(
      malformed.json.error.requestId,
      "request-2"
    );

    const limited = await httpRequest(
      api.baseUrl,
      "/api/v1/accounts",
      {
        headers: browserJsonHeaders(),
        body: JSON.stringify(registration()),
      }
    );
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "37");
    assert.equal(
      limited.json.error.code,
      "RATE_LIMITED"
    );
    assert.equal(
      limited.json.error.requestId,
      "request-3"
    );
    assert.equal(tableCount(runtime.database, "users"), 0);
    for (const response of [
      wrongOrigin,
      malformed,
      limited,
    ]) {
      assert.equal(
        response.text.includes(registration().password),
        false
      );
      assert.equal(
        response.text.includes("attacker.example"),
        false
      );
      assert.equal(
        response.headers.get("cache-control"),
        "no-store"
      );
    }
  });
});
