const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createAccountActionTokenService,
} = require(
  "../../src/application/services/accounts/createAccountActionTokenService"
);
const {
  createAuthenticationRateLimiter,
} = require(
  "../../src/application/services/accounts/createAuthenticationRateLimiter"
);
const {
  ACTION_TOKEN_LIFETIMES_MS,
  ACTION_TOKEN_PURPOSES,
  createActionTokenDeadline,
  evaluateActionToken,
} = require(
  "../../src/domain/accounts/accountActionTokenPolicy"
);
const {
  AUTHENTICATION_RATE_LIMITS,
  HOUR_MS,
  MINUTE_MS,
  createRateLimitWindow,
} = require(
  "../../src/domain/accounts/authenticationRateLimitPolicy"
);
const {
  loadSecurityConfig,
} = require("../../src/config/loadSecurityConfig");
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
  createSqliteAuthenticationRateLimitRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuthenticationRateLimitRepository"
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
  createSystemClock,
} = require(
  "../../src/infrastructure/security/createSystemClock"
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
  "2026-07-20T08:00:00.000Z"
);
const RATE_SECRET =
  "rate-limit-private-key-0123456789-ABCDEF";
const AUDIT_SECRET =
  "audit-private-key-9876543210-ZYXWVUT";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

function deterministicRandom({
  firstByte = 1,
  firstId = 1,
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

function securityConfig() {
  return loadSecurityConfig({
    env: {
      APP_ENV: "test",
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      PUBLIC_FRONTEND_ORIGIN:
        "http://localhost:4173",
      FRONTEND_ORIGINS:
        "http://localhost:4173",
      EMAIL_DELIVERY_MODE: "capture",
      RATE_LIMIT_KEY_SECRET: RATE_SECRET,
      AUDIT_METADATA_SECRET: AUDIT_SECRET,
    },
  });
}

function userRecord(value, overrides = {}) {
  return {
    id: uuid(value),
    email_normalized:
      `user${value}@example.test`,
    email_display:
      `user${value}@example.test`,
    display_name: `User ${value}`,
    display_name_normalized: `user ${value}`,
    status: "active",
    created_at_ms: CREATED_AT_MS,
    updated_at_ms: CREATED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function createDatabaseRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const databasePath = path.join(
    temporaryRoot,
    "security-state.sqlite3"
  );
  let connection = openDatabase({
    databasePath,
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-06-test",
    now: () => CREATED_AT_MS,
  });

  t.after(() => {
    if (connection?.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });

  function repositories() {
    return {
      actionTokens:
        createSqliteAccountActionTokenRepository({
          database: connection.database,
        }),
      audit:
        createSqliteSecurityAuditRepository({
          database: connection.database,
        }),
      rateLimits:
        createSqliteAuthenticationRateLimitRepository({
          database: connection.database,
        }),
      users: createSqliteUserRepository({
        database: connection.database,
      }),
    };
  }

  return {
    databasePath,
    get database() {
      return connection.database;
    },
    reopen() {
      if (connection.database.open) {
        connection.database.close();
      }
      connection = openDatabase({
        databasePath,
        environment: "test",
      });
      return repositories();
    },
    repositories,
    temporaryRoot,
  };
}

function createTokenService(
  repository,
  time,
  random = deterministicRandom({
    firstByte: 11,
    firstId: 100,
  })
) {
  return createAccountActionTokenService({
    repository,
    opaqueTokens: createOpaqueActionTokens({
      secureRandom: random,
    }),
    clock: createSystemClock({
      now: () => time.nowMs,
    }),
    secureRandom: random,
  });
}

function auditRecord(value, overrides = {}) {
  return {
    id: uuid(value),
    event_type: "account.security_event",
    outcome: "success",
    actor_user_id: null,
    target_user_id: null,
    league_id: null,
    session_id: null,
    request_correlation_id: `request-${value}`,
    reason_code: "approved",
    network_key_version: null,
    network_metadata_digest: null,
    client_metadata_json: JSON.stringify({
      networkSourceCategory: "local",
      origin: "http://localhost:4173",
    }),
    unknown_account_digest: null,
    occurred_at_ms: CREATED_AT_MS + value,
    ...overrides,
  };
}

describe("M3-06 account security policies", () => {
  test("uses every exact action-token lifetime and expiry boundary", () => {
    assert.deepEqual(ACTION_TOKEN_PURPOSES, [
      "email_verification",
      "administrator_setup",
      "password_reset",
      "self_reactivation",
    ]);
    assert.deepEqual(ACTION_TOKEN_LIFETIMES_MS, {
      email_verification: 24 * HOUR_MS,
      administrator_setup: 72 * HOUR_MS,
      password_reset: 30 * MINUTE_MS,
      self_reactivation: 30 * MINUTE_MS,
    });

    for (const purpose of ACTION_TOKEN_PURPOSES) {
      const deadline =
        createActionTokenDeadline(
          purpose,
          CREATED_AT_MS
        );
      const row = {
        purpose,
        status: "active",
        created_at_ms: deadline.createdAtMs,
        expires_at_ms: deadline.expiresAtMs,
        consumed_at_ms: null,
        invalidated_at_ms: null,
      };
      assert.equal(
        evaluateActionToken(
          row,
          purpose,
          deadline.expiresAtMs - 1
        ).valid,
        true
      );
      assert.deepEqual(
        evaluateActionToken(
          row,
          purpose,
          deadline.expiresAtMs
        ),
        {
          valid: false,
          code: "ACTION_TOKEN_INVALID",
        }
      );
    }
  });

  test("publishes every approved initial rate-limit default", () => {
    const summary = Object.fromEntries(
      Object.entries(
        AUTHENTICATION_RATE_LIMITS
      ).map(([action, buckets]) => [
        action,
        Object.fromEntries(
          Object.entries(buckets).map(
            ([bucket, value]) => [
              bucket,
              value &&
                [
                  value.limit,
                  value.windowMs,
                  value.counter,
                ],
            ]
          )
        ),
      ])
    );
    assert.deepEqual(summary, {
      sign_in: {
        network: [
          20,
          15 * MINUTE_MS,
          "attempts",
        ],
        subject: [
          5,
          15 * MINUTE_MS,
          "failures",
        ],
      },
      sign_up: {
        network: [5, HOUR_MS, "attempts"],
        subject: [3, HOUR_MS, "attempts"],
      },
      verification_resend: {
        network: [10, HOUR_MS, "attempts"],
        subject: [3, HOUR_MS, "attempts"],
      },
      password_reset_request: {
        network: [10, HOUR_MS, "attempts"],
        subject: [3, HOUR_MS, "attempts"],
      },
      reactivation_request: {
        network: [10, HOUR_MS, "attempts"],
        subject: [3, HOUR_MS, "attempts"],
      },
      administrator_setup_resend: {
        network: null,
        subject: [3, HOUR_MS, "attempts"],
      },
      action_token_completion: {
        network: [
          20,
          15 * MINUTE_MS,
          "attempts",
        ],
        subject: [
          5,
          15 * MINUTE_MS,
          "failures",
        ],
      },
      password_change: {
        network: null,
        subject: [5, HOUR_MS, "attempts"],
      },
      account_deactivation: {
        network: null,
        subject: [5, HOUR_MS, "attempts"],
      },
    });
    assert.deepEqual(
      createRateLimitWindow(
        CREATED_AT_MS + 1234,
        15 * MINUTE_MS
      ),
      {
        windowStartedAtMs: CREATED_AT_MS,
        windowEndsAtMs:
          CREATED_AT_MS + 15 * MINUTE_MS,
      }
    );
  });
});

describe("M3-06 opaque account-action tokens", () => {
  test("generates canonical digest-only internal material and compares in constant time", () => {
    const comparisons = [];
    const adapter = createOpaqueActionTokens({
      secureRandom: deterministicRandom(),
      timingSafeEqual(left, right) {
        comparisons.push([
          left.byteLength,
          right.byteLength,
        ]);
        return left.equals(right);
      },
    });
    const generated = adapter.generate();

    assert.equal(generated.rawToken.length, 43);
    assert.match(
      generated.tokenDigest,
      /^[0-9a-f]{64}$/
    );
    assert.deepEqual(Object.keys(generated), [
      "tokenDigest",
    ]);
    assert.equal(
      JSON.stringify(generated).includes(
        generated.rawToken
      ),
      false
    );
    assert.equal(
      adapter.digest(generated.rawToken),
      generated.tokenDigest
    );
    assert.equal(
      adapter.matches(
        generated.rawToken,
        generated.tokenDigest
      ),
      true
    );
    assert.deepEqual(comparisons, [[32, 32]]);
    assert.equal(
      adapter.matches(
        "malformed",
        generated.tokenDigest
      ),
      false
    );
  });

  test("replaces, expires, consumes once, rolls back hooks, and exposes no digest", (t) => {
    const runtime = createDatabaseRuntime(
      t,
      "hundo-m3-06-tokens-"
    );
    const repositories =
      runtime.repositories();
    const user = repositories.users.insert(
      userRecord(1)
    );
    const time = { nowMs: CREATED_AT_MS };
    const service = createTokenService(
      repositories.actionTokens,
      time
    );

    const first = service.issue({
      userId: user.id,
      purpose: "email_verification",
    });
    const firstRaw = first.rawToken;
    assert.equal(
      Object.keys(first).includes("rawToken"),
      false
    );
    assert.equal(
      JSON.stringify(first).includes(firstRaw),
      false
    );
    const storedFirst =
      repositories.actionTokens.findById(
        first.token.id
      );
    assert.equal(
      JSON.stringify(storedFirst).includes(
        firstRaw
      ),
      false
    );
    assert.equal(
      Object.hasOwn(first.token, "tokenDigest"),
      false
    );

    time.nowMs += 1;
    const second = service.issue({
      userId: user.id,
      purpose: "email_verification",
    });
    assert.equal(
      second.previousTokenId,
      first.token.id
    );
    assert.deepEqual(
      service.resolve({
        rawToken: firstRaw,
        expectedPurpose:
          "email_verification",
      }),
      {
        valid: false,
        code: "ACTION_TOKEN_INVALID",
      }
    );
    assert.equal(
      service.resolve({
        rawToken: second.rawToken,
        expectedPurpose:
          "password_reset",
      }).valid,
      false
    );
    assert.equal(
      service.recordFailedAttempt({
        rawToken: second.rawToken,
        expectedPurpose:
          "email_verification",
      }).token.failedAttemptCount,
      1
    );

    assert.throws(() =>
      service.consume({
        rawToken: second.rawToken,
        expectedPurpose:
          "email_verification",
        transactionHook() {
          throw new Error("synthetic rollback");
        },
      })
    );
    assert.equal(
      repositories.actionTokens.findById(
        second.token.id
      ).status,
      "active"
    );

    const consumed = service.consume({
      rawToken: second.rawToken,
      expectedPurpose:
        "email_verification",
      transactionHook(context) {
        repositories.audit.append(
          auditRecord(20, {
            target_user_id: context.userId,
          })
        );
      },
    });
    assert.equal(consumed.token.status, "consumed");
    assert.deepEqual(
      service.consume({
        rawToken: second.rawToken,
        expectedPurpose:
          "email_verification",
      }),
      {
        valid: false,
        code: "ACTION_TOKEN_INVALID",
      }
    );
    assert.equal(
      repositories.audit.findById(uuid(20))
        .target_user_id,
      user.id
    );

    const expiring = service.issue({
      userId: user.id,
      purpose: "password_reset",
    });
    time.nowMs = expiring.token.expiresAtMs;
    assert.equal(
      service.resolve({
        rawToken: expiring.rawToken,
        expectedPurpose: "password_reset",
      }).valid,
      false
    );
    assert.equal(
      repositories.actionTokens.findById(
        expiring.token.id
      ).status,
      "expired"
    );
  });
});

describe("M3-06 privacy digests and Security Audit", () => {
  test("separates keyed purposes and serializes neither inputs nor secrets", () => {
    const config = securityConfig();
    const rate = createKeyedPrivacyDigest({
      secretSlot: config.rateLimitKey,
      purpose: "rate_limit_bucket",
    });
    const audit = createKeyedPrivacyDigest({
      secretSlot: config.auditMetadataKey,
      purpose: "audit_network",
    });
    const input =
      "sign_in\u0000network\u0000192.0.2.0/24";
    const first = rate.digest(input);
    const second = audit.digest(input);

    assert.match(first.digest, /^[0-9a-f]{64}$/);
    assert.notEqual(first.digest, second.digest);
    assert.equal(first.keyVersion, 1);
    const serialized = JSON.stringify({
      rate,
      audit,
      first,
      second,
    });
    for (const forbidden of [
      input,
      RATE_SECRET,
      AUDIT_SECRET,
      "192.0.2.0",
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false
      );
    }
    assert.throws(
      () =>
        createKeyedPrivacyDigest({
          secretSlot: {
            configured: false,
            keyVersion: 1,
          },
          purpose: "rate_limit_bucket",
        }),
      /configured versioned privacy key/
    );
  });

  test("appends only safe audit rows, supports narrow lookups, and never writes League Activity", (t) => {
    const runtime = createDatabaseRuntime(
      t,
      "hundo-m3-06-audit-"
    );
    const repositories =
      runtime.repositories();
    const actor = repositories.users.insert(
      userRecord(1)
    );
    const target = repositories.users.insert(
      userRecord(2)
    );
    const config = securityConfig();
    const network =
      createKeyedPrivacyDigest({
        secretSlot:
          config.auditMetadataKey,
        purpose: "audit_network",
      }).digest("192.0.2.0/24");
    const beforeLeagueActivity =
      runtime.database
        .prepare(
          "SELECT count(*) AS count FROM league_activity"
        )
        .get().count;

    const inserted = repositories.audit.append(
      auditRecord(1, {
        actor_user_id: actor.id,
        target_user_id: target.id,
        network_key_version:
          network.keyVersion,
        network_metadata_digest:
          network.digest,
      })
    );
    assert.deepEqual(
      repositories.audit.findById(inserted.id),
      inserted
    );
    assert.equal(
      repositories.audit.findRecentByActor({
        id: actor.id,
        limit: 10,
      })[0].id,
      inserted.id
    );
    assert.equal(
      repositories.audit.findRecentByTarget({
        id: target.id,
        limit: 10,
      })[0].id,
      inserted.id
    );
    assert.equal(
      Object.hasOwn(repositories.audit, "update"),
      false
    );
    assert.equal(
      Object.hasOwn(repositories.audit, "delete"),
      false
    );
    assert.equal(
      Object.hasOwn(repositories.audit, "listAll"),
      false
    );
    assert.equal(
      runtime.database
        .prepare(
          "SELECT count(*) AS count FROM league_activity"
        )
        .get().count,
      beforeLeagueActivity
    );
    assert.throws(
      () =>
        repositories.audit.append(
          auditRecord(2, {
            client_metadata_json:
              JSON.stringify({
                rawHeader: "private",
              }),
          })
        ),
      /client metadata/
    );

    const rollback =
      runtime.database.transaction(() => {
        repositories.audit.append(
          auditRecord(3)
        );
        throw new Error("synthetic rollback");
      });
    assert.throws(() => rollback.immediate());
    assert.equal(
      repositories.audit.findById(uuid(3)),
      null
    );
  });
});

describe("M3-06 durable authentication rate limits", () => {
  function createLimiter(
    repository,
    time,
    random = deterministicRandom({
      firstId: 500,
    })
  ) {
    const config = securityConfig();
    return createAuthenticationRateLimiter({
      repository,
      privacyDigest:
        createKeyedPrivacyDigest({
          secretSlot:
            config.rateLimitKey,
          purpose: "rate_limit_bucket",
        }),
      clock: createSystemClock({
        now: () => time.nowMs,
      }),
      secureRandom: random,
    });
  }

  test("enforces exact network and failure thresholds, preserves separation, and clears only sign-in account failures", (t) => {
    const runtime = createDatabaseRuntime(
      t,
      "hundo-m3-06-rate-threshold-"
    );
    const repositories =
      runtime.repositories();
    const time = { nowMs: CREATED_AT_MS };
    const limiter = createLimiter(
      repositories.rateLimits,
      time
    );
    const network = "192.0.2.0/24";
    const account = "manager@example.test";

    for (let index = 0; index < 20; index += 1) {
      assert.equal(
        limiter.recordAttempt({
          action: "sign_in",
          bucket: "network",
          canonicalIdentifier: network,
          failed: true,
        }).allowed,
        true
      );
    }
    const networkBlocked = limiter.check({
      action: "sign_in",
      bucket: "network",
      canonicalIdentifier: network,
    });
    assert.deepEqual(networkBlocked, {
      allowed: false,
      code: "RATE_LIMITED",
      retryAfterSeconds: 15 * 60,
    });
    assert.equal(
      limiter.recordAttempt({
        action: "sign_in",
        bucket: "network",
        canonicalIdentifier: network,
        failed: true,
      }).allowed,
      false
    );

    for (let index = 0; index < 5; index += 1) {
      assert.equal(
        limiter.recordAttempt({
          action: "sign_in",
          bucket: "subject",
          canonicalIdentifier: account,
          failed: true,
        }).allowed,
        true
      );
    }
    assert.equal(
      limiter.check({
        action: "sign_in",
        bucket: "subject",
        canonicalIdentifier: account,
      }).allowed,
      false
    );
    assert.equal(
      limiter.clearSignInAccountFailures({
        canonicalIdentifier: account,
      }),
      true
    );
    assert.equal(
      limiter.check({
        action: "sign_in",
        bucket: "subject",
        canonicalIdentifier: account,
      }).allowed,
      true
    );
    assert.equal(
      limiter.check({
        action: "sign_in",
        bucket: "network",
        canonicalIdentifier: network,
      }).allowed,
      false
    );

    const successfulAccount =
      "successful@example.test";
    for (let index = 0; index < 8; index += 1) {
      limiter.recordAttempt({
        action: "sign_in",
        bucket: "subject",
        canonicalIdentifier:
          successfulAccount,
        failed: false,
      });
    }
    assert.equal(
      limiter.check({
        action: "sign_in",
        bucket: "subject",
        canonicalIdentifier:
          successfulAccount,
      }).allowed,
      true
    );

    const serializedRows = JSON.stringify(
      runtime.database
        .prepare(
          "SELECT * FROM authentication_rate_limits"
        )
        .all()
    );
    for (const forbidden of [
      network,
      account,
      successfulAccount,
      RATE_SECRET,
    ]) {
      assert.equal(
        serializedRows.includes(forbidden),
        false
      );
    }
  });

  test("rolls windows, survives reopen, delegates undefined normal limits, and cleans expired rows in bounded batches", (t) => {
    const runtime = createDatabaseRuntime(
      t,
      "hundo-m3-06-rate-reopen-"
    );
    let repositories = runtime.repositories();
    const time = { nowMs: CREATED_AT_MS };
    let limiter = createLimiter(
      repositories.rateLimits,
      time
    );
    const identifier = "198.51.100.0/24";

    assert.deepEqual(
      limiter.check({
        action: "password_change",
        bucket: "network",
        canonicalIdentifier: identifier,
      }),
      {
        allowed: true,
        code: "RATE_LIMIT_DELEGATED",
        retryAfterSeconds: 0,
      }
    );
    for (let index = 0; index < 5; index += 1) {
      limiter.recordAttempt({
        action: "sign_up",
        bucket: "network",
        canonicalIdentifier: identifier,
      });
    }
    assert.equal(
      limiter.check({
        action: "sign_up",
        bucket: "network",
        canonicalIdentifier: identifier,
      }).allowed,
      false
    );

    repositories = runtime.reopen();
    limiter = createLimiter(
      repositories.rateLimits,
      time,
      deterministicRandom({
        firstId: 700,
      })
    );
    assert.equal(
      limiter.check({
        action: "sign_up",
        bucket: "network",
        canonicalIdentifier: identifier,
      }).allowed,
      false
    );

    time.nowMs += HOUR_MS;
    assert.equal(
      limiter.check({
        action: "sign_up",
        bucket: "network",
        canonicalIdentifier: identifier,
      }).allowed,
      true
    );
    assert.equal(
      limiter.cleanupExpired({ limit: 1 }),
      1
    );
    assert.equal(
      limiter.cleanupExpired({ limit: 1 }),
      0
    );
  });
});
