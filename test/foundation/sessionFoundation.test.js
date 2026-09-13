const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createSessionService,
} = require(
  "../../src/application/services/accounts/createSessionService"
);
const {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_LIFETIME_MS,
  SESSION_POLICY_CODES,
  SESSION_REFRESH_INTERVAL_MS,
  SessionPolicyError,
  createSessionDeadlines,
  evaluateSession,
} = require(
  "../../src/domain/accounts/sessionPolicy"
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
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
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
  CSRF_DERIVATION_LABEL,
  SessionSecretError,
  createSessionSecrets,
} = require(
  "../../src/infrastructure/security/createSessionSecrets"
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
  HOST_SESSION_COOKIE_NAME,
  LOCAL_SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SessionCookieError,
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
  "2026-07-19T21:00:00.000Z"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function createTemporaryDatabase(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "sessions.sqlite3"
    ),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-04-test",
    now: () => CREATED_AT_MS,
  });

  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  const users = createSqliteUserRepository({
    database: connection.database,
  });
  const sessions = createSqliteSessionRepository({
    database: connection.database,
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

  return {
    ...connection,
    context,
    sessions,
    temporaryRoot,
    users,
  };
}

function userRecord(value, overrides = {}) {
  return {
    id: uuid(value),
    email_normalized:
      `session-user-${value}@example.test`,
    email_display:
      `session-user-${value}@example.test`,
    display_name: `Session User ${value}`,
    display_name_normalized:
      `session user ${value}`,
    status: "active",
    created_at_ms: CREATED_AT_MS,
    updated_at_ms: CREATED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function sessionRecord(
  value,
  userId,
  overrides = {}
) {
  const deadlines =
    createSessionDeadlines(CREATED_AT_MS);
  return {
    id: uuid(value),
    user_id: userId,
    token_digest: digest(`session-${value}`),
    csrf_secret_digest: digest(`csrf-${value}`),
    status: "active",
    created_at_ms: deadlines.createdAtMs,
    last_used_at_ms:
      deadlines.lastUsedAtMs,
    idle_expires_at_ms:
      deadlines.idleExpiresAtMs,
    absolute_expires_at_ms:
      deadlines.absoluteExpiresAtMs,
    revoked_at_ms: null,
    revocation_reason: null,
    client_metadata_json: null,
    version: 1,
    ...overrides,
  };
}

function createDeterministicRandom({
  firstByte = 1,
  firstId = 100,
} = {}) {
  let byte = firstByte;
  let id = firstId;
  return createSecureRandom({
    randomBytes(byteLength) {
      const value = Buffer.alloc(
        byteLength,
        byte
      );
      byte += 1;
      return value;
    },
    randomUUID() {
      const value = uuid(id);
      id += 1;
      return value;
    },
  });
}

function assertRepositoryError(code) {
  return (error) => error?.code === code;
}

describe("M3-04 session timing policy", () => {
  test("creates exact deadlines and persists refresh only at the five-minute boundary", () => {
    const deadlines =
      createSessionDeadlines(CREATED_AT_MS);
    const row = sessionRecord(1, uuid(1));

    assert.equal(
      deadlines.idleExpiresAtMs,
      CREATED_AT_MS +
        SESSION_IDLE_LIFETIME_MS
    );
    assert.equal(
      deadlines.absoluteExpiresAtMs,
      CREATED_AT_MS +
        SESSION_ABSOLUTE_LIFETIME_MS
    );

    const before = evaluateSession(
      row,
      CREATED_AT_MS +
        SESSION_REFRESH_INTERVAL_MS -
        1
    );
    assert.equal(before.valid, true);
    assert.equal(before.persistRefresh, false);
    assert.equal(before.refresh, null);

    const atBoundary = evaluateSession(
      row,
      CREATED_AT_MS +
        SESSION_REFRESH_INTERVAL_MS
    );
    assert.equal(atBoundary.valid, true);
    assert.equal(
      atBoundary.persistRefresh,
      true
    );
    assert.deepEqual(atBoundary.refresh, {
      lastUsedAtMs:
        CREATED_AT_MS +
        SESSION_REFRESH_INTERVAL_MS,
      idleExpiresAtMs:
        CREATED_AT_MS +
        SESSION_REFRESH_INTERVAL_MS +
        SESSION_IDLE_LIFETIME_MS,
    });
  });

  test("expires at exact idle and absolute boundaries and caps refresh at absolute expiry", () => {
    const row = sessionRecord(1, uuid(1));
    assert.deepEqual(
      evaluateSession(
        row,
        row.idle_expires_at_ms
      ),
      {
        valid: false,
        reasonCode:
          SESSION_POLICY_CODES.idleExpired,
        persistRefresh: false,
      }
    );

    const nearAbsolute = sessionRecord(
      2,
      uuid(1),
      {
        last_used_at_ms:
          CREATED_AT_MS +
          SESSION_ABSOLUTE_LIFETIME_MS -
          2 * SESSION_REFRESH_INTERVAL_MS,
        idle_expires_at_ms:
          CREATED_AT_MS +
          SESSION_ABSOLUTE_LIFETIME_MS,
      }
    );
    const refreshed = evaluateSession(
      nearAbsolute,
      nearAbsolute.last_used_at_ms +
        SESSION_REFRESH_INTERVAL_MS
    );
    assert.equal(
      refreshed.persistRefresh,
      true
    );
    assert.equal(
      refreshed.refresh.idleExpiresAtMs,
      nearAbsolute.absolute_expires_at_ms
    );

    const absoluteRow = sessionRecord(
      3,
      uuid(1),
      {
        idle_expires_at_ms:
          CREATED_AT_MS +
          SESSION_ABSOLUTE_LIFETIME_MS,
      }
    );
    assert.equal(
      evaluateSession(
        absoluteRow,
        absoluteRow.absolute_expires_at_ms
      ).reasonCode,
      SESSION_POLICY_CODES.absoluteExpired
    );
  });

  test("rejects revoked, expired, malformed, and backward-clock state safely", () => {
    const active = sessionRecord(1, uuid(1));
    assert.equal(
      evaluateSession(
        { ...active, status: "revoked" },
        CREATED_AT_MS
      ).reasonCode,
      SESSION_POLICY_CODES.revoked
    );
    assert.equal(
      evaluateSession(
        { ...active, status: "expired" },
        CREATED_AT_MS
      ).reasonCode,
      SESSION_POLICY_CODES.expired
    );
    assert.throws(
      () =>
        evaluateSession(
          {
            ...active,
            idle_expires_at_ms:
              CREATED_AT_MS,
          },
          CREATED_AT_MS
        ),
      (error) =>
        error instanceof SessionPolicyError &&
        error.reasonCode ===
          SESSION_POLICY_CODES.malformed
    );
    assert.throws(
      () =>
        evaluateSession(
          active,
          CREATED_AT_MS - 1
        ),
      (error) =>
        error.reasonCode ===
        SESSION_POLICY_CODES.clockInvalid
    );
  });
});

describe("M3-05 derived session-bound CSRF secrets", () => {
  test("derives a stable domain-separated canonical token while serialization exposes nothing", () => {
    const secureRandom =
      createDeterministicRandom();
    const secrets = createSessionSecrets({
      secureRandom,
    });
    const bundle = secrets.generate();

    assert.equal(
      bundle.rawSessionToken.length,
      43
    );
    assert.equal(bundle.rawCsrfToken.length, 43);
    assert.notEqual(
      bundle.rawSessionToken,
      bundle.rawCsrfToken
    );
    const expectedCsrf = crypto
      .createHmac(
        "sha256",
        Buffer.from(
          bundle.rawSessionToken,
          "base64url"
        )
      )
      .update(CSRF_DERIVATION_LABEL, "utf8")
      .digest("base64url");
    assert.equal(
      bundle.rawCsrfToken,
      expectedCsrf
    );
    assert.equal(
      secrets.deriveCsrf(
        bundle.rawSessionToken
      ),
      bundle.rawCsrfToken
    );
    assert.match(
      bundle.sessionTokenDigest,
      /^[0-9a-f]{64}$/
    );
    assert.match(
      bundle.csrfTokenDigest,
      /^[0-9a-f]{64}$/
    );
    assert.equal(
      secrets.digest(bundle.rawSessionToken),
      bundle.sessionTokenDigest
    );
    assert.equal(
      secrets.verifyCsrf({
        rawSessionToken:
          bundle.rawSessionToken,
        rawCsrfToken: bundle.rawCsrfToken,
        storedDigest:
          bundle.csrfTokenDigest,
      }),
      true
    );
    assert.deepEqual(Object.keys(bundle), []);
    assert.equal(JSON.stringify(bundle), "{}");
  });

  test("rejects malformed, cross-session, and digest-mismatched values without echoing token material", () => {
    const secrets = createSessionSecrets({
      secureRandom:
        createDeterministicRandom(),
    });
    const malformed = [
      null,
      "",
      "short",
      "a".repeat(42),
      `${"a".repeat(42)}=`,
      `${"a".repeat(42)}+`,
    ];
    for (const value of malformed) {
      let caught;
      try {
        secrets.digest(value);
      } catch (error) {
        caught = error;
      }
      assert.ok(
        caught instanceof SessionSecretError
      );
      if (String(value).length > 0) {
        assert.equal(
          caught.message.includes(String(value)),
          false
        );
      }
    }

    const first = secrets.generate();
    const second = secrets.generate();
    assert.equal(
      secrets.verifyCsrf({
        rawSessionToken:
          first.rawSessionToken,
        rawCsrfToken: second.rawCsrfToken,
        storedDigest: first.csrfTokenDigest,
      }),
      false
    );
    assert.equal(
      secrets.verifyCsrf({
        rawSessionToken:
          first.rawSessionToken,
        rawCsrfToken: first.rawCsrfToken,
        storedDigest: "0".repeat(64),
      }),
      false
    );
    assert.equal(
      secrets.verifyCsrf({
        rawSessionToken: "malformed",
        rawCsrfToken: first.rawCsrfToken,
        storedDigest: first.csrfTokenDigest,
      }),
      false
    );
  });
});

describe("M3-04 sensitive SQLite session repository", () => {
  test("enforces one active session, unique digest, and atomic replacement", (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-04-session-repo-"
    );
    const firstUser =
      runtime.users.insert(userRecord(1));
    const secondUser =
      runtime.users.insert(userRecord(2));
    const first =
      runtime.sessions.insertActive(
        sessionRecord(10, firstUser.id)
      );

    assert.equal(
      runtime.sessions.findById(first.id)?.id,
      first.id
    );
    assert.equal(
      runtime.sessions.findByTokenDigest(
        first.token_digest
      )?.id,
      first.id
    );
    assert.equal(
      runtime.sessions.findActiveByUserId(
        firstUser.id
      )?.id,
      first.id
    );
    assert.equal(
      Object.hasOwn(runtime.sessions, "listAll"),
      false
    );
    assert.equal(
      Object.hasOwn(runtime.sessions, "delete"),
      false
    );
    assert.throws(
      () =>
        runtime.sessions.insertActive(
          sessionRecord(11, firstUser.id)
        ),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.constraint
      )
    );
    assert.throws(
      () =>
        runtime.sessions.insertActive(
          sessionRecord(12, secondUser.id, {
            token_digest: first.token_digest,
          })
        ),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.constraint
      )
    );

    let hookContext = null;
    const replacement = sessionRecord(
      13,
      firstUser.id,
      {
        created_at_ms: CREATED_AT_MS + 1,
        last_used_at_ms: CREATED_AT_MS + 1,
        idle_expires_at_ms:
          CREATED_AT_MS +
          1 +
          SESSION_IDLE_LIFETIME_MS,
        absolute_expires_at_ms:
          CREATED_AT_MS +
          1 +
          SESSION_ABSOLUTE_LIFETIME_MS,
      }
    );
    const result =
      runtime.sessions.replaceActive({
        replacement,
        replacedAtMs: CREATED_AT_MS + 1,
        transactionHook(context) {
          hookContext = context;
        },
      });
    assert.equal(result.previous.status, "revoked");
    assert.equal(
      result.previous.revocation_reason,
      "replaced_by_login"
    );
    assert.equal(result.previous.version, 2);
    assert.equal(result.active.id, replacement.id);
    assert.deepEqual(hookContext, {
      userId: firstUser.id,
      previousSessionId: first.id,
      activeSessionId: replacement.id,
    });
    assert.equal(
      JSON.stringify(hookContext).includes(
        "digest"
      ),
      false
    );
  });

  test("rolls back replacement when its transaction hook fails", (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-04-session-hook-"
    );
    const user = runtime.users.insert(
      userRecord(1)
    );
    const original =
      runtime.sessions.insertActive(
        sessionRecord(10, user.id)
      );
    const replacement = sessionRecord(
      11,
      user.id,
      {
        created_at_ms: CREATED_AT_MS + 1,
        last_used_at_ms: CREATED_AT_MS + 1,
        idle_expires_at_ms:
          CREATED_AT_MS +
          1 +
          SESSION_IDLE_LIFETIME_MS,
        absolute_expires_at_ms:
          CREATED_AT_MS +
          1 +
          SESSION_ABSOLUTE_LIFETIME_MS,
      }
    );

    assert.throws(() =>
      runtime.sessions.replaceActive({
        replacement,
        replacedAtMs: CREATED_AT_MS + 1,
        transactionHook() {
          throw new Error("synthetic hook failure");
        },
      })
    );
    assert.deepEqual(
      runtime.sessions.findActiveByUserId(user.id),
      original
    );
    assert.equal(
      runtime.sessions.findById(replacement.id),
      null
    );
  });

  test("refreshes, revokes, and expires with optimistic version checks", (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-04-session-transitions-"
    );
    const user = runtime.users.insert(
      userRecord(1)
    );
    const initial =
      runtime.sessions.insertActive(
        sessionRecord(10, user.id)
      );
    const refreshed =
      runtime.sessions.refreshActive({
        sessionId: initial.id,
        expectedVersion: 1,
        lastUsedAtMs:
          CREATED_AT_MS +
          SESSION_REFRESH_INTERVAL_MS,
        idleExpiresAtMs:
          CREATED_AT_MS +
          SESSION_REFRESH_INTERVAL_MS +
          SESSION_IDLE_LIFETIME_MS,
      });
    assert.equal(refreshed.version, 2);
    assert.equal(
      refreshed.last_used_at_ms,
      CREATED_AT_MS +
        SESSION_REFRESH_INTERVAL_MS
    );
    assert.throws(
      () =>
        runtime.sessions.revokeActive({
          sessionId: initial.id,
          expectedVersion: 1,
          changedAtMs: CREATED_AT_MS + 1,
          reason: "sign_out",
          transactionHook: null,
        }),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.versionConflict
      )
    );
    const revoked =
      runtime.sessions.revokeActive({
        sessionId: initial.id,
        expectedVersion: 2,
        changedAtMs:
          CREATED_AT_MS +
          SESSION_REFRESH_INTERVAL_MS +
          1,
        reason: "sign_out",
        transactionHook: null,
      });
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.version, 3);

    const expiring =
      runtime.sessions.insertActive(
        sessionRecord(11, user.id, {
          created_at_ms: CREATED_AT_MS + 10,
          last_used_at_ms: CREATED_AT_MS + 10,
          idle_expires_at_ms:
            CREATED_AT_MS +
            10 +
            SESSION_IDLE_LIFETIME_MS,
          absolute_expires_at_ms:
            CREATED_AT_MS +
            10 +
            SESSION_ABSOLUTE_LIFETIME_MS,
        })
      );
    const expired =
      runtime.sessions.expireActive({
        sessionId: expiring.id,
        expectedVersion: 1,
        changedAtMs:
          expiring.idle_expires_at_ms,
        reason: "idle_expired",
        transactionHook: null,
      });
    assert.equal(expired.status, "expired");
    assert.equal(
      expired.revocation_reason,
      "idle_expired"
    );
  });
});

function createServiceRuntime(t, prefix) {
  const runtime = createTemporaryDatabase(
    t,
    prefix
  );
  const time = { nowMs: CREATED_AT_MS };
  const secureRandom =
    createDeterministicRandom({
      firstByte: 20,
      firstId: 500,
    });
  const sessionSecrets = createSessionSecrets({
    secureRandom,
  });
  const service = createSessionService({
    userRepository: runtime.users,
    sessionRepository: runtime.sessions,
    sessionSecrets,
    clock: createSystemClock({
      now: () => time.nowMs,
    }),
    secureRandom,
  });

  return {
    ...runtime,
    secureRandom,
    service,
    sessionSecrets,
    time,
  };
}

describe("M3-04 internal session lifecycle service", () => {
  test("issues digest-only storage, resolves active identity, and invalidates a replaced token", (t) => {
    const runtime = createServiceRuntime(
      t,
      "hundo-m3-04-session-service-"
    );
    const user = runtime.users.insert(
      userRecord(1)
    );
    const first = runtime.service.issueForUser({
      userId: user.id,
      clientMetadata: {
        networkSourceCategory: "local",
        origin: "http://localhost:5173",
        userAgentFamily: "Synthetic Browser",
        userAgentHash: "a".repeat(64),
      },
    });

    assert.equal(
      first.kind,
      "internal_session_issue"
    );
    assert.equal(
      Object.keys(first).includes(
        "rawSessionToken"
      ),
      false
    );
    assert.equal(
      Object.keys(first).includes("rawCsrfToken"),
      false
    );
    const serializedFirst = JSON.stringify(first);
    assert.equal(
      serializedFirst.includes(
        first.rawSessionToken
      ),
      false
    );
    assert.equal(
      serializedFirst.includes(first.rawCsrfToken),
      false
    );

    const stored =
      runtime.sessions.findById(first.session.id);
    assert.equal(
      stored.token_digest,
      runtime.sessionSecrets.digest(
        first.rawSessionToken
      )
    );
    assert.equal(
      JSON.stringify(stored).includes(
        first.rawSessionToken
      ),
      false
    );
    assert.equal(
      JSON.stringify(stored).includes(
        first.rawCsrfToken
      ),
      false
    );
    assert.deepEqual(
      runtime.service.resolve(
        first.rawSessionToken
      ),
      {
        valid: true,
        code: "SESSION_VALID",
        session: first.session,
        user: {
          id: user.id,
          displayName: user.display_name,
          status: "active",
          version: 1,
        },
      }
    );

    runtime.time.nowMs += 1;
    const second =
      runtime.service.issueForUser({
        userId: user.id,
      });
    assert.equal(
      second.previousSessionId,
      first.session.id
    );
    assert.deepEqual(
      runtime.service.resolve(
        first.rawSessionToken
      ),
      {
        valid: false,
        code: "SESSION_INVALID",
      }
    );
    assert.equal(
      runtime.service.resolve(
        second.rawSessionToken
      ).valid,
      true
    );
  });

  test("bootstraps the same non-enumerable CSRF token without a write and verifies unsafe requests", (t) => {
    const runtime = createServiceRuntime(
      t,
      "hundo-m3-05-session-bootstrap-"
    );
    const firstUser = runtime.users.insert(
      userRecord(1)
    );
    const secondUser = runtime.users.insert(
      userRecord(2)
    );
    const first =
      runtime.service.issueForUser({
        userId: firstUser.id,
      });
    const second =
      runtime.service.issueForUser({
        userId: secondUser.id,
      });
    runtime.time.nowMs +=
      SESSION_REFRESH_INTERVAL_MS;
    const before = runtime.sessions.findById(
      first.session.id
    );

    const firstBootstrap =
      runtime.service.bootstrap(
        first.rawSessionToken
      );
    const secondBootstrap =
      runtime.service.bootstrap(
        first.rawSessionToken
      );
    assert.equal(
      firstBootstrap.kind,
      "internal_session_bootstrap"
    );
    assert.equal(
      firstBootstrap.rawCsrfToken,
      first.rawCsrfToken
    );
    assert.equal(
      secondBootstrap.rawCsrfToken,
      first.rawCsrfToken
    );
    assert.equal(
      Object.keys(firstBootstrap).includes(
        "rawCsrfToken"
      ),
      false
    );
    assert.equal(
      JSON.stringify(firstBootstrap).includes(
        first.rawCsrfToken
      ),
      false
    );
    assert.deepEqual(
      runtime.sessions.findById(
        first.session.id
      ),
      before
    );

    assert.equal(
      runtime.service.resolveWithCsrf({
        rawSessionToken:
          first.rawSessionToken,
        rawCsrfToken: first.rawCsrfToken,
      }).valid,
      true
    );
    assert.deepEqual(
      runtime.service.resolveWithCsrf({
        rawSessionToken:
          first.rawSessionToken,
        rawCsrfToken: second.rawCsrfToken,
      }),
      {
        valid: false,
        code: "CSRF_INVALID",
      }
    );
    assert.deepEqual(
      runtime.service.resolveWithCsrf({
        rawSessionToken: "malformed",
        rawCsrfToken: first.rawCsrfToken,
      }),
      {
        valid: false,
        code: "SESSION_INVALID",
      }
    );
  });

  test("resolves socket identity without refreshing activity or persisting expiry", (t) => {
    const runtime = createServiceRuntime(
      t,
      "hundo-m3-13-session-read-only-"
    );
    const user = runtime.users.insert(
      userRecord(1)
    );
    const issued = runtime.service.issueForUser({
      userId: user.id,
    });
    runtime.time.nowMs +=
      SESSION_REFRESH_INTERVAL_MS;
    const before = runtime.sessions.findById(
      issued.session.id
    );

    const resolved =
      runtime.service.resolveWithoutActivity(
        issued.rawSessionToken
      );

    assert.equal(resolved.valid, true);
    assert.deepEqual(resolved.session, issued.session);
    assert.deepEqual(
      runtime.sessions.findById(issued.session.id),
      before
    );

    runtime.time.nowMs =
      issued.session.idleExpiresAtMs;
    assert.deepEqual(
      runtime.service.resolveWithoutActivity(
        issued.rawSessionToken
      ),
      {
        valid: false,
        code: "SESSION_INVALID",
      }
    );
    assert.deepEqual(
      runtime.sessions.findById(issued.session.id),
      before
    );
  });

  test("denies missing or inactive users and rejects unsafe client metadata", (t) => {
    const runtime = createServiceRuntime(
      t,
      "hundo-m3-04-session-denial-"
    );
    const user = runtime.users.insert(
      userRecord(1, {
        status: "disabled",
      })
    );

    assert.throws(
      () =>
        runtime.service.issueForUser({
          userId: user.id,
        }),
      (error) =>
        error.code === "SESSION_ISSUE_DENIED"
    );
    assert.throws(
      () =>
        runtime.service.issueForUser({
          userId: uuid(999),
        }),
      (error) =>
        error.code === "SESSION_ISSUE_DENIED"
    );

    const active = runtime.users.insert(
      userRecord(2)
    );
    assert.throws(
      () =>
        runtime.service.issueForUser({
          userId: active.id,
          clientMetadata: {
            rawUserAgent:
              "unrestricted private header",
          },
        }),
      (error) =>
        error.code ===
        "SESSION_CLIENT_METADATA_INVALID"
    );
  });

  test("persists activity only at five minutes and changes no league-domain rows", (t) => {
    const runtime = createServiceRuntime(
      t,
      "hundo-m3-04-session-refresh-"
    );
    const user = runtime.users.insert(
      userRecord(1)
    );
    const issued =
      runtime.service.issueForUser({
        userId: user.id,
      });
    const leagueTables = [
      "leagues",
      "league_memberships",
      "teams",
      "matchup_weeks",
      "matchups",
      "standings_snapshots",
      "league_activity",
    ];
    const before = Object.fromEntries(
      leagueTables.map((tableName) => [
        tableName,
        runtime.database
          .prepare(
            `SELECT count(*) AS count FROM ${tableName}`
          )
          .get().count,
      ])
    );

    runtime.time.nowMs =
      CREATED_AT_MS +
      SESSION_REFRESH_INTERVAL_MS -
      1;
    runtime.service.resolve(
      issued.rawSessionToken
    );
    assert.equal(
      runtime.sessions.findById(issued.session.id)
        .version,
      1
    );

    runtime.time.nowMs += 1;
    const resolved = runtime.service.resolve(
      issued.rawSessionToken
    );
    assert.equal(resolved.session.version, 2);
    assert.equal(
      resolved.session.lastUsedAtMs,
      runtime.time.nowMs
    );

    const after = Object.fromEntries(
      leagueTables.map((tableName) => [
        tableName,
        runtime.database
          .prepare(
            `SELECT count(*) AS count FROM ${tableName}`
          )
          .get().count,
      ])
    );
    assert.deepEqual(after, before);
  });

  test("expires idle and absolute sessions and returns one generic invalid result", (t) => {
    const idleRuntime = createServiceRuntime(
      t,
      "hundo-m3-04-session-idle-"
    );
    const idleUser = idleRuntime.users.insert(
      userRecord(1)
    );
    const idle =
      idleRuntime.service.issueForUser({
        userId: idleUser.id,
      });
    idleRuntime.time.nowMs =
      idle.session.idleExpiresAtMs;
    assert.deepEqual(
      idleRuntime.service.resolve(
        idle.rawSessionToken
      ),
      {
        valid: false,
        code: "SESSION_INVALID",
      }
    );
    assert.equal(
      idleRuntime.sessions.findById(idle.session.id)
        .status,
      "expired"
    );

    const absoluteRuntime = createServiceRuntime(
      t,
      "hundo-m3-04-session-absolute-"
    );
    const absoluteUser =
      absoluteRuntime.users.insert(userRecord(2));
    const absolute =
      absoluteRuntime.service.issueForUser({
        userId: absoluteUser.id,
      });
    absoluteRuntime.time.nowMs =
      absolute.session.absoluteExpiresAtMs;
    assert.deepEqual(
      absoluteRuntime.service.resolve(
        absolute.rawSessionToken
      ),
      absoluteRuntime.service.resolve(
        "not-a-session-token"
      )
    );
    assert.equal(
      absoluteRuntime.sessions.findById(
        absolute.session.id
      ).revocation_reason,
      "absolute_expired"
    );
  });

  test("fails closed when a user becomes inactive and revokes explicitly", (t) => {
    const runtime = createServiceRuntime(
      t,
      "hundo-m3-04-session-revoke-"
    );
    const user = runtime.users.insert(
      userRecord(1)
    );
    const issued =
      runtime.service.issueForUser({
        userId: user.id,
      });
    runtime.users.updateVersioned({
      key: user.id,
      expectedVersion: 1,
      changes: {
        status: "disabled",
        updated_at_ms: CREATED_AT_MS + 1,
      },
    });
    assert.equal(
      runtime.service.resolve(
        issued.rawSessionToken
      ).valid,
      false
    );

    const secondUser = runtime.users.insert(
      userRecord(2)
    );
    const second =
      runtime.service.issueForUser({
        userId: secondUser.id,
      });
    runtime.time.nowMs += 2;
    const revoked = runtime.service.revoke({
      sessionId: second.session.id,
      expectedVersion: 1,
      reason: "sign_out",
    });
    assert.equal(revoked.status, "revoked");
    assert.equal(
      runtime.service.resolve(
        second.rawSessionToken
      ).valid,
      false
    );
  });
});

describe("M3-04 session cookie transport", () => {
  const rawToken = Buffer.alloc(32, 9).toString(
    "base64url"
  );

  test("serializes and clears the exact insecure-local HttpOnly Lax cookie", () => {
    const cookie = createSessionCookie({
      appEnv: "local",
      publicFrontendOrigin:
        "http://localhost:5173",
      sameSite: "lax",
    });
    const serialized = cookie.serialize(rawToken);

    assert.equal(
      cookie.name,
      LOCAL_SESSION_COOKIE_NAME
    );
    assert.equal(cookie.secure, false);
    assert.equal(
      serialized,
      `${LOCAL_SESSION_COOKIE_NAME}=${rawToken}; ` +
        `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; ` +
        "Path=/; HttpOnly; SameSite=Lax"
    );
    assert.equal(serialized.includes("Secure"), false);
    assert.equal(serialized.includes("Domain"), false);
    assert.equal(
      cookie.clear(),
      `${LOCAL_SESSION_COOKIE_NAME}=; Max-Age=0; ` +
        "Path=/; HttpOnly; SameSite=Lax"
    );
  });

  test("requires the secure host cookie for explicit staging None and production Lax topology", () => {
    const staging = createSessionCookie({
      appEnv: "staging",
      publicFrontendOrigin:
        "https://staging.example.test",
      sameSite: "none",
    });
    const production = createSessionCookie({
      appEnv: "production",
      publicFrontendOrigin:
        "https://app.example.test",
      sameSite: "lax",
    });

    for (const cookie of [staging, production]) {
      const serialized = cookie.serialize(rawToken);
      assert.equal(
        cookie.name,
        HOST_SESSION_COOKIE_NAME
      );
      assert.equal(cookie.secure, true);
      assert.equal(
        serialized.includes("; Secure;"),
        true
      );
      assert.equal(
        serialized.includes("Domain"),
        false
      );
      assert.equal(
        serialized.includes("HttpOnly"),
        true
      );
      assert.equal(
        serialized.includes("Path=/"),
        true
      );
    }
    assert.equal(staging.sameSite, "None");
    assert.equal(production.sameSite, "Lax");
  });

  test("reads only one configured cookie and rejects duplicates or malformed values", () => {
    const cookie = createSessionCookie({
      appEnv: "production",
      publicFrontendOrigin:
        "https://app.example.test",
      sameSite: "lax",
    });

    assert.equal(cookie.read(undefined), null);
    assert.equal(
      cookie.read("other=value"),
      null
    );
    assert.equal(
      cookie.read(
        `other=value; ${cookie.name}=${rawToken}; final=ok`
      ),
      rawToken
    );
    assert.throws(
      () =>
        cookie.read(
          `${cookie.name}=${rawToken}; ${cookie.name}=${rawToken}`
        ),
      (error) =>
        error instanceof SessionCookieError &&
        error.reasonCode ===
          "SESSION_COOKIE_DUPLICATE"
    );
    assert.throws(
      () =>
        cookie.read(`${cookie.name}=invalid`),
      (error) =>
        error.reasonCode ===
        "SESSION_COOKIE_TOKEN_INVALID"
    );
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(
      rawToken.at(-1)
    );
    const noncanonical =
      rawToken.slice(0, -1) +
      alphabet[lastIndex + 1];
    assert.throws(
      () =>
        cookie.read(
          `${cookie.name}=${noncanonical}`
        ),
      (error) =>
        error.reasonCode ===
        "SESSION_COOKIE_TOKEN_INVALID"
    );
  });

  test("rejects unsafe local origins, insecure deployed origins, and local SameSite None", () => {
    const cases = [
      {
        appEnv: "local",
        publicFrontendOrigin:
          "http://example.test",
        sameSite: "lax",
      },
      {
        appEnv: "staging",
        publicFrontendOrigin:
          "http://staging.example.test",
        sameSite: "none",
      },
      {
        appEnv: "local",
        publicFrontendOrigin:
          "http://127.0.0.1:5173",
        sameSite: "none",
      },
    ];
    for (const options of cases) {
      assert.throws(
        () => createSessionCookie(options),
        SessionCookieError
      );
    }
  });
});
