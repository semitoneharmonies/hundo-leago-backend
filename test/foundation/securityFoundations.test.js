const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createSecurityFoundations,
} = require(
  "../../src/bootstrap/createSecurityFoundations"
);
const {
  APP_ENVIRONMENTS,
  INITIAL_KEY_VERSION,
  SecurityConfigError,
  loadSecurityConfig,
} = require("../../src/config/loadSecurityConfig");
const {
  CIRCULAR,
  REDACTED,
  createStructuredLogger,
  sanitizeLogContext,
} = require(
  "../../src/infrastructure/logging/createStructuredLogger"
);
const {
  MAXIMUM_RANDOM_BYTES,
  createSecureRandom,
} = require(
  "../../src/infrastructure/security/createSecureRandom"
);
const {
  createSystemClock,
} = require(
  "../../src/infrastructure/security/createSystemClock"
);

const FIXED_NOW_MS = Date.parse(
  "2026-07-19T18:23:45.678Z"
);
const RATE_LIMIT_SECRET =
  "rate-limit-key-material-0123456789-ABCDEF";
const AUDIT_SECRET =
  "audit-metadata-key-material-9876543210-ZYXW";
const ACTION_TOKEN_DELIVERY_KEY = Buffer.alloc(
  32,
  0x5a
).toString("base64url");
const RESEND_API_KEY =
  "re_m3_21_fake_provider_key_material_0123456789";
const FIXED_UUID =
  "018f4ca6-7f73-4d95-8b65-91f9a2cc4d8e";

function localEnv(overrides = {}) {
  return {
    APP_ENV: "local",
    NODE_ENV: "development",
    LOG_LEVEL: "debug",
    PUBLIC_FRONTEND_ORIGIN:
      "http://localhost:5173",
    FRONTEND_ORIGINS:
      "http://localhost:5173,http://localhost:5174",
    EMAIL_DELIVERY_MODE: "capture",
    ...overrides,
  };
}

function deployedEnv(appEnv, overrides = {}) {
  const publicFrontendOrigin =
    appEnv === "production"
      ? "https://hundo.example"
      : "https://staging-hundo.netlify.app";
  return {
    APP_ENV: appEnv,
    NODE_ENV: "production",
    APP_BUILD_ID: "commit-0123456789abcdef",
    LOG_LEVEL: "info",
    SESSION_COOKIE_SAME_SITE: "none",
    PUBLIC_FRONTEND_ORIGIN:
      publicFrontendOrigin,
    FRONTEND_ORIGINS: publicFrontendOrigin,
    RATE_LIMIT_KEY_SECRET: RATE_LIMIT_SECRET,
    AUDIT_METADATA_SECRET: AUDIT_SECRET,
    ACTION_TOKEN_DELIVERY_KEY,
    EMAIL_DELIVERY_MODE:
      appEnv === "production" ? "send" : "capture",
    ...(appEnv === "production"
      ? {
          EMAIL_FROM:
            "Hundo Leago <accounts@hundo.example>",
          EMAIL_REPLY_TO: "support@hundo.example",
          RESEND_API_KEY,
        }
      : {}),
    ...overrides,
  };
}

function createCaptureLogger({
  logLevel = "debug",
  sensitiveValues = [],
} = {}) {
  const lines = [];
  const clock = createSystemClock({
    now: () => FIXED_NOW_MS,
  });
  const logger = createStructuredLogger({
    environment: "test",
    buildId: "test-build",
    logLevel,
    clock,
    sensitiveValues,
    sink(line) {
      lines.push(line);
    },
  });
  return { lines, logger };
}

describe("M3-02 security configuration", () => {
  test("accepts every approved environment and exact NODE_ENV pairing", () => {
    const inputs = [
      localEnv(),
      {
        APP_ENV: "test",
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        EMAIL_DELIVERY_MODE: "capture",
        PUBLIC_FRONTEND_ORIGIN:
          "http://localhost:4173",
        FRONTEND_ORIGINS:
          "http://localhost:4173",
      },
      deployedEnv("staging"),
      deployedEnv("production"),
    ];

    assert.deepEqual(
      inputs.map(
        (env) => loadSecurityConfig({ env }).appEnv
      ),
      APP_ENVIRONMENTS
    );

    const local = loadSecurityConfig({
      env: inputs[0],
    });
    const testConfig = loadSecurityConfig({
      env: inputs[1],
    });
    const staging = loadSecurityConfig({
      env: inputs[2],
    });

    assert.equal(local.buildId, "local-unbuilt");
    assert.equal(testConfig.buildId, "test-unbuilt");
    assert.equal(local.sessionCookieSameSite, "lax");
    assert.equal(testConfig.sessionCookieSameSite, "lax");
    assert.equal(staging.sessionCookieSameSite, "none");
    assert.equal(local.rateLimitKey.configured, false);
    assert.equal(local.email.deliveryMode, "capture");
    assert.equal(local.email.provider, null);
    assert.equal(local.email.apiKey.configured, false);
    assert.equal(
      local.auditMetadataKey.configured,
      false
    );
    assert.equal(
      local.actionTokenDeliveryKey.configured,
      false
    );
    assert.equal(local.rateLimitKey.value, null);
    assert.equal(
      staging.rateLimitKey.configured,
      true
    );
    assert.equal(
      staging.rateLimitKey.keyVersion,
      INITIAL_KEY_VERSION
    );
    assert.equal(
      staging.auditMetadataKey.keyVersion,
      INITIAL_KEY_VERSION
    );
    assert.equal(
      staging.actionTokenDeliveryKey.keyVersion,
      INITIAL_KEY_VERSION
    );
    assert.equal(staging.email.deliveryMode, "capture");
    assert.deepEqual(local.frontendOrigins, [
      "http://localhost:5173",
      "http://localhost:5174",
    ]);
    assert.equal(
      local.publicFrontendOrigin,
      "http://localhost:5173"
    );
    assert.equal(
      local.isAllowedFrontendOrigin(
        "http://localhost:5174"
      ),
      true
    );
    assert.equal(
      local.isAllowedFrontendOrigin(
        "https://preview--hundo.netlify.app"
      ),
      false
    );
  });

  test("requires an explicit approved cookie site policy when deployed", () => {
    const sameSiteStaging = loadSecurityConfig({
      env: deployedEnv("staging", {
        SESSION_COOKIE_SAME_SITE: "lax",
        PUBLIC_FRONTEND_ORIGIN: "https://staging.hundoleago.com",
        FRONTEND_ORIGINS: "https://staging.hundoleago.com",
      }),
    });
    assert.equal(sameSiteStaging.sessionCookieSameSite, "lax");

    for (const env of [
      deployedEnv("staging", {
        SESSION_COOKIE_SAME_SITE: undefined,
      }),
      deployedEnv("production", {
        SESSION_COOKIE_SAME_SITE: "strict",
      }),
      localEnv({
        SESSION_COOKIE_SAME_SITE: "none",
      }),
    ]) {
      assert.throws(
        () => loadSecurityConfig({ env }),
        (error) =>
          error instanceof SecurityConfigError &&
          error.field === "SESSION_COOKIE_SAME_SITE"
      );
    }
  });

  test("accepts only canonical exact frontend origins", () => {
    const cases = [
      {
        overrides: {
          PUBLIC_FRONTEND_ORIGIN: undefined,
        },
        field: "PUBLIC_FRONTEND_ORIGIN",
      },
      {
        overrides: {
          FRONTEND_ORIGINS: undefined,
        },
        field: "FRONTEND_ORIGINS",
      },
      {
        overrides: {
          FRONTEND_ORIGINS: "*",
        },
        field: "FRONTEND_ORIGINS",
      },
      {
        overrides: {
          FRONTEND_ORIGINS:
            "http://localhost:5173/",
        },
        field: "FRONTEND_ORIGINS",
      },
      {
        overrides: {
          FRONTEND_ORIGINS:
            "http://user:pass@localhost:5173",
        },
        field: "FRONTEND_ORIGINS",
      },
      {
        overrides: {
          FRONTEND_ORIGINS:
            "http://localhost:5173,http://localhost:5173",
        },
        field: "FRONTEND_ORIGINS",
      },
      {
        overrides: {
          PUBLIC_FRONTEND_ORIGIN:
            "http://localhost:5175",
        },
        field: "PUBLIC_FRONTEND_ORIGIN",
      },
    ];

    for (const { overrides, field } of cases) {
      assert.throws(
        () =>
          loadSecurityConfig({
            env: localEnv(overrides),
          }),
        (error) =>
          error instanceof SecurityConfigError &&
          error.field === field
      );
    }

    assert.throws(
      () =>
        loadSecurityConfig({
          env: deployedEnv("production", {
            PUBLIC_FRONTEND_ORIGIN:
              "http://hundo.example",
            FRONTEND_ORIGINS:
              "http://hundo.example",
          }),
        }),
      (error) =>
        error instanceof SecurityConfigError &&
        error.field === "PUBLIC_FRONTEND_ORIGIN"
    );
  });

  test("enforces environment-specific email modes and provider configuration", () => {
    const sandbox = loadSecurityConfig({
      env: deployedEnv("staging", {
        EMAIL_DELIVERY_MODE: "sandbox",
        EMAIL_FROM: "Hundo Leago <accounts@staging.hundo.example>",
        EMAIL_REPLY_TO: "support@hundo.example",
        RESEND_API_KEY,
      }),
    });
    const production = loadSecurityConfig({
      env: deployedEnv("production"),
    });
    const stagingSend = loadSecurityConfig({
      env: deployedEnv("staging", {
        EMAIL_DELIVERY_MODE: "send",
        EMAIL_FROM: "Hundo Leago <accounts@staging.hundo.example>",
        RESEND_API_KEY,
      }),
    });
    const allowlist = loadSecurityConfig({
      env: deployedEnv("staging", {
        EMAIL_DELIVERY_MODE: "allowlist",
        EMAIL_FROM: "Hundo Leago <accounts@staging.hundo.example>",
        RESEND_API_KEY,
        STAGING_EMAIL_RECIPIENT_ALLOWLIST:
          "manager+one@example.test,manager+two@example.test",
      }),
    });

    assert.equal(sandbox.email.provider, "resend");
    assert.equal(sandbox.email.apiOrigin, "https://api.resend.com");
    assert.equal(sandbox.email.apiKey.configured, true);
    assert.deepEqual(allowlist.email.recipientAllowlist, [
      "manager+one@example.test",
      "manager+two@example.test",
    ]);
    assert.equal(stagingSend.email.deliveryMode, "send");
    assert.deepEqual(stagingSend.email.recipientAllowlist, []);
    assert.equal(production.email.deliveryMode, "send");
    assert.equal(production.email.from.includes("accounts@"), true);

    const cases = [
      [localEnv({ EMAIL_DELIVERY_MODE: undefined }), "EMAIL_DELIVERY_MODE"],
      [localEnv({ EMAIL_DELIVERY_MODE: "send" }), "EMAIL_DELIVERY_MODE"],
      [
        deployedEnv("production", { EMAIL_DELIVERY_MODE: "capture" }),
        "EMAIL_DELIVERY_MODE",
      ],
      [
        deployedEnv("staging", {
          EMAIL_DELIVERY_MODE: "allowlist",
          EMAIL_FROM: "accounts@staging.hundo.example",
          RESEND_API_KEY,
        }),
        "STAGING_EMAIL_RECIPIENT_ALLOWLIST",
      ],
      [
        deployedEnv("staging", {
          STAGING_EMAIL_RECIPIENT_ALLOWLIST: "manager@example.test",
        }),
        "STAGING_EMAIL_RECIPIENT_ALLOWLIST",
      ],
      [
        deployedEnv("staging", {
          EMAIL_DELIVERY_MODE: "sandbox",
          EMAIL_FROM: "accounts@staging.hundo.example",
        }),
        "RESEND_API_KEY",
      ],
      [
        localEnv({ RESEND_API_KEY }),
        "RESEND_API_KEY",
      ],
      [
        deployedEnv("production", { EMAIL_FROM: "not-an-email" }),
        "EMAIL_FROM",
      ],
      [
        deployedEnv("production", { EMAIL_REPLY_TO: "not-an-email" }),
        "EMAIL_REPLY_TO",
      ],
    ];
    for (const [env, field] of cases) {
      assert.throws(
        () => loadSecurityConfig({ env }),
        (error) =>
          error instanceof SecurityConfigError && error.field === field
      );
    }
  });

  test("requires explicit input and rejects invalid identity, level, and build values", () => {
    assert.throws(
      () => loadSecurityConfig(),
      /explicit environment object/
    );

    const cases = [
      {
        env: localEnv({ APP_ENV: "preview" }),
        field: "APP_ENV",
      },
      {
        env: localEnv({ NODE_ENV: "production" }),
        field: "NODE_ENV",
      },
      {
        env: {
          ...deployedEnv("staging"),
          NODE_ENV: "test",
        },
        field: "NODE_ENV",
      },
      {
        env: localEnv({ LOG_LEVEL: "verbose" }),
        field: "LOG_LEVEL",
      },
      {
        env: deployedEnv("production", {
          APP_BUILD_ID: "",
        }),
        field: "APP_BUILD_ID",
      },
      {
        env: deployedEnv("production", {
          APP_BUILD_ID: "contains spaces",
        }),
        field: "APP_BUILD_ID",
      },
    ];

    for (const { env, field } of cases) {
      assert.throws(
        () => loadSecurityConfig({ env }),
        (error) =>
          error instanceof SecurityConfigError &&
          error.code ===
            "SECURITY_CONFIG_INVALID" &&
          error.field === field
      );
    }
  });

  test("rejects absent, short, altered, placeholder, and reused deployed secrets without echoing values", () => {
    const tooShort = "too-short";
    const whitespaceAltered =
      ` ${RATE_LIMIT_SECRET}`;
    const placeholder = "x".repeat(40);
    const placeholderPhrase =
      "replace-me-placeholder-replace-me";
    const cases = [
      deployedEnv("staging", {
        RATE_LIMIT_KEY_SECRET: "",
      }),
      deployedEnv("staging", {
        AUDIT_METADATA_SECRET: "",
      }),
      deployedEnv("staging", {
        ACTION_TOKEN_DELIVERY_KEY: "",
      }),
      deployedEnv("staging", {
        RATE_LIMIT_KEY_SECRET: tooShort,
      }),
      deployedEnv("staging", {
        RATE_LIMIT_KEY_SECRET:
          whitespaceAltered,
      }),
      deployedEnv("staging", {
        RATE_LIMIT_KEY_SECRET: placeholder,
      }),
      deployedEnv("staging", {
        RATE_LIMIT_KEY_SECRET:
          placeholderPhrase,
      }),
      deployedEnv("staging", {
        AUDIT_METADATA_SECRET:
          RATE_LIMIT_SECRET,
      }),
      deployedEnv("staging", {
        ACTION_TOKEN_DELIVERY_KEY:
          `${ACTION_TOKEN_DELIVERY_KEY}=`,
      }),
      deployedEnv("staging", {
        ACTION_TOKEN_DELIVERY_KEY:
          ACTION_TOKEN_DELIVERY_KEY.slice(1),
      }),
      deployedEnv("staging", {
        RATE_LIMIT_KEY_SECRET:
          ACTION_TOKEN_DELIVERY_KEY,
      }),
    ];

    for (const env of cases) {
      let caught;
      try {
        loadSecurityConfig({ env });
      } catch (error) {
        caught = error;
      }

      assert.ok(
        caught instanceof SecurityConfigError
      );
      const serialized = JSON.stringify({
        message: caught.message,
        stack: caught.stack,
      });
      for (const secret of [
        tooShort,
        whitespaceAltered,
        placeholder,
        placeholderPhrase,
        RATE_LIMIT_SECRET,
        AUDIT_SECRET,
        ACTION_TOKEN_DELIVERY_KEY,
      ]) {
        assert.equal(
          serialized.includes(secret),
          false
        );
      }
    }
  });

  test("returns frozen configuration whose serialization omits secret material", () => {
    const config = loadSecurityConfig({
      env: deployedEnv("production"),
    });
    const serialized = JSON.stringify(config);

    assert.equal(Object.isFrozen(config), true);
    assert.equal(
      Object.isFrozen(config.rateLimitKey),
      true
    );
    assert.equal(
      Object.isFrozen(config.auditMetadataKey),
      true
    );
    assert.equal(
      Object.isFrozen(
        config.actionTokenDeliveryKey
      ),
      true
    );
    assert.equal(
      Object.isFrozen(config.frontendOrigins),
      true
    );
    assert.equal(Object.isFrozen(config.email), true);
    assert.equal(Object.isFrozen(config.email.apiKey), true);
    assert.equal(
      Object.keys(config.rateLimitKey).includes(
        "value"
      ),
      false
    );
    assert.equal(
      serialized.includes(RATE_LIMIT_SECRET),
      false
    );
    assert.equal(
      serialized.includes(AUDIT_SECRET),
      false
    );
    assert.equal(
      serialized.includes(ACTION_TOKEN_DELIVERY_KEY),
      false
    );
    assert.equal(serialized.includes(RESEND_API_KEY), false);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(config.rateLimitKey)
      ),
      {
        configured: true,
        keyVersion: INITIAL_KEY_VERSION,
      }
    );
  });
});

describe("M3-02 injected UTC clock", () => {
  test("samples one safe timestamp for matching millisecond and ISO values", () => {
    let calls = 0;
    const clock = createSystemClock({
      now() {
        calls += 1;
        return FIXED_NOW_MS + calls - 1;
      },
    });

    const sample = clock.sample();
    assert.deepEqual(sample, {
      nowMs: FIXED_NOW_MS,
      nowIso: "2026-07-19T18:23:45.678Z",
    });
    assert.equal(calls, 1);
    assert.equal(clock.nowMs(), FIXED_NOW_MS + 1);
    assert.equal(
      clock.nowIso(),
      "2026-07-19T18:23:45.680Z"
    );
    assert.equal(calls, 3);
    assert.equal(Object.isFrozen(clock), true);
    assert.equal(Object.isFrozen(sample), true);
  });

  test("fails closed for non-functions, unsafe values, and unsupported dates", () => {
    assert.throws(
      () => createSystemClock({ now: 7 }),
      /time-source function/
    );
    assert.throws(
      () =>
        createSystemClock({
          now: () => 1.5,
        }).nowMs(),
      /safe-integer/
    );
    assert.throws(
      () =>
        createSystemClock({
          now: () => Number.MAX_SAFE_INTEGER,
        }).sample(),
      /unsupported UTC timestamp/
    );
  });
});

describe("M3-02 cryptographically secure randomness adapter", () => {
  test("returns copied exact-length bytes, unpadded base64url tokens, and UUID v4 identifiers", () => {
    const provided = [];
    const secureRandom = createSecureRandom({
      randomBytes(byteLength) {
        const value = Buffer.alloc(
          byteLength,
          0xfb
        );
        provided.push(value);
        return value;
      },
      randomUUID() {
        return FIXED_UUID;
      },
    });

    const bytes = secureRandom.bytes(4);
    assert.deepEqual(bytes, Buffer.alloc(4, 0xfb));
    assert.notEqual(bytes, provided[0]);
    assert.equal(secureRandom.token(3), "-_v7");
    assert.equal(
      /[=+/]/.test(secureRandom.token()),
      false
    );
    assert.equal(secureRandom.id(), FIXED_UUID);
    assert.equal(Object.isFrozen(secureRandom), true);
  });

  test("rejects invalid sizes and malformed provider output", () => {
    const validUuid = () => FIXED_UUID;
    const wrongLength = createSecureRandom({
      randomBytes: () => Buffer.alloc(2),
      randomUUID: validUuid,
    });
    const wrongType = createSecureRandom({
      randomBytes: () => "not-bytes",
      randomUUID: validUuid,
    });
    const wrongUuid = createSecureRandom({
      randomBytes: Buffer.alloc,
      randomUUID: () =>
        "00000000-0000-0000-0000-000000000000",
    });

    for (const byteLength of [
      0,
      -1,
      1.5,
      MAXIMUM_RANDOM_BYTES + 1,
    ]) {
      assert.throws(
        () =>
          createSecureRandom().bytes(
            byteLength
          ),
        /random byte length/
      );
    }
    assert.throws(
      () => wrongLength.bytes(3),
      /wrong byte length/
    );
    assert.throws(
      () => wrongType.bytes(3),
      /must return bytes/
    );
    assert.throws(
      () => wrongUuid.id(),
      /canonical UUID v4/
    );
  });
});

describe("M3-02 structured redacted logging", () => {
  test("emits the required envelope and recursively removes representative secrets", () => {
    const { lines, logger } = createCaptureLogger({
      sensitiveValues: [
        RATE_LIMIT_SECRET,
        AUDIT_SECRET,
        ACTION_TOKEN_DELIVERY_KEY,
      ],
    });
    const context = {
      correlationId: "request-123",
      outcome: "denied",
      nested: {
        Cookie: "hundo_session=cookie-value",
        Authorization: "Bearer auth-value",
        password: "correct horse battery staple",
        passwordConfirmation:
          "correct horse battery staple",
        passwordHash: "scrypt$private-hash",
        sessionToken: "session-token-value",
        csrfToken: "csrf-token-value",
        verificationToken:
          "verification-token-value",
        setupToken: "setup-token-value",
        resetToken: "reset-token-value",
        reactivationToken:
          "reactivation-token-value",
        email: "private.manager@example.com",
        providerCredential:
          "provider-private-value",
        activeBid: { amount: 72.5 },
        requestBody: {
          private: "private-request-value",
        },
        originalUrl:
          "https://example.test/reset?token=value#secret",
      },
      note:
        "password=correct horse battery staple; " +
        `Bearer raw-bearer ${RATE_LIMIT_SECRET} ` +
        `${AUDIT_SECRET} private.manager@example.com ` +
        "https://example.test/path?token=value",
      bid: {
        amount: 72.5,
      },
    };
    const before = structuredClone(context);

    assert.equal(
      logger.warn("security.request.denied", context),
      true
    );
    assert.deepEqual(context, before);
    assert.equal(lines.length, 1);

    const serialized = lines[0];
    const record = JSON.parse(serialized);
    assert.equal(
      record.timestamp,
      "2026-07-19T18:23:45.678Z"
    );
    assert.equal(record.severity, "warn");
    assert.equal(
      record.event,
      "security.request.denied"
    );
    assert.equal(record.environment, "test");
    assert.equal(record.buildId, "test-build");
    assert.equal(
      record.correlationId,
      "request-123"
    );
    assert.equal(record.nested.Cookie, REDACTED);
    assert.equal(
      record.nested.sessionToken,
      REDACTED
    );
    assert.equal(
      record.nested.requestBody,
      REDACTED
    );
    assert.equal(
      record.nested.activeBid,
      REDACTED
    );
    assert.equal(record.bid, REDACTED);

    for (const forbidden of [
      "cookie-value",
      "auth-value",
      "correct horse battery staple",
      "scrypt$private-hash",
      "session-token-value",
      "csrf-token-value",
      "verification-token-value",
      "setup-token-value",
      "reset-token-value",
      "reactivation-token-value",
      "private.manager@example.com",
      "provider-private-value",
      "private-request-value",
      "example.test",
      "hunter2",
      "horse",
      "battery",
      "staple",
      "raw-bearer",
      RATE_LIMIT_SECRET,
      AUDIT_SECRET,
      ACTION_TOKEN_DELIVERY_KEY,
      "72.5",
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        forbidden
      );
    }
  });

  test("filters below-threshold records without sampling time or writing", () => {
    const lines = [];
    let clockCalls = 0;
    const logger = createStructuredLogger({
      environment: "test",
      buildId: "test-build",
      logLevel: "warn",
      clock: {
        nowIso() {
          clockCalls += 1;
          return "2026-07-19T18:23:45.678Z";
        },
      },
      sink(line) {
        lines.push(line);
      },
    });

    assert.equal(
      logger.debug("security.debug", {
        outcome: "filtered",
      }),
      false
    );
    assert.equal(
      logger.info("security.info", {
        outcome: "filtered",
      }),
      false
    );
    assert.equal(lines.length, 0);
    assert.equal(clockCalls, 0);
    assert.equal(
      logger.error("security.error", {
        outcome: "written",
      }),
      true
    );
    assert.equal(lines.length, 1);
    assert.equal(clockCalls, 1);
  });

  test("sanitizes errors and circular values without mutating them", () => {
    const { lines, logger } = createCaptureLogger({
      sensitiveValues: [RATE_LIMIT_SECRET],
    });
    const circular = { safe: "value" };
    circular.self = circular;
    const error = new Error(
      `failed for ${RATE_LIMIT_SECRET} at https://example.test/private`
    );
    error.code = "SAFE_CODE";
    error.submittedEmail =
      "private.manager@example.com";

    logger.error("security.failure", {
      error,
      circular,
    });

    const record = JSON.parse(lines[0]);
    assert.equal(record.error.name, "Error");
    assert.equal(record.error.code, "SAFE_CODE");
    assert.equal(
      record.error.submittedEmail,
      REDACTED
    );
    assert.equal(record.circular.self, CIRCULAR);
    assert.equal(error.code, "SAFE_CODE");
    assert.equal(circular.self, circular);

    for (const forbidden of [
      RATE_LIMIT_SECRET,
      "private.manager@example.com",
      "example.test",
    ]) {
      assert.equal(
        lines[0].includes(forbidden),
        false
      );
    }
  });

  test("fails closed for invalid events and context shapes before output", () => {
    const { lines, logger } = createCaptureLogger();

    assert.throws(
      () => logger.info("Invalid Event", {}),
      /event name/
    );
    assert.throws(
      () => logger.info("valid.event", []),
      /plain object/
    );
    assert.throws(
      () =>
        logger.info("valid.event", {
          timestamp: "override",
        }),
      /reserved field/
    );
    assert.throws(
      () =>
        logger.info("valid.event", {
          "bad field": "value",
        }),
      /invalid field name/
    );
    assert.equal(lines.length, 0);
  });

  test("sanitizer handles unsupported values without leaking caller data", () => {
    const input = {
      binary: Buffer.from("private binary"),
      callback() {},
      invalidNumber: Number.NaN,
      rawEmail: "private.manager@example.com",
    };
    const output = sanitizeLogContext(input);

    assert.equal(output.binary, "[UNSUPPORTED]");
    assert.equal(output.callback, "[UNSUPPORTED]");
    assert.equal(
      output.invalidNumber,
      "[UNSUPPORTED]"
    );
    assert.equal(output.rawEmail, REDACTED);
    assert.equal(
      input.binary.toString(),
      "private binary"
    );
  });
});

describe("M3-02 security foundation composition", () => {
  test("composes immutable local foundations from explicit injected providers", () => {
    const lines = [];
    const foundations = createSecurityFoundations({
      env: localEnv(),
      now: () => FIXED_NOW_MS,
      randomBytes: (byteLength) =>
        Buffer.alloc(byteLength, 7),
      randomUUID: () => FIXED_UUID,
      loggerSink(line) {
        lines.push(line);
      },
    });

    assert.equal(
      Object.isFrozen(foundations),
      true
    );
    assert.equal(
      Object.isFrozen(foundations.config),
      true
    );
    assert.equal(
      foundations.clock.nowMs(),
      FIXED_NOW_MS
    );
    assert.equal(
      foundations.secureRandom.token(2),
      "Bwc"
    );
    assert.equal(
      foundations.secureRandom.id(),
      FIXED_UUID
    );
    assert.equal(
      foundations.logger.info(
        "security.foundation.ready",
        { outcome: "ok" }
      ),
      true
    );
    assert.equal(lines.length, 1);
  });

  test("passes deployed secret values only to the logger redaction boundary", () => {
    const lines = [];
    const foundations = createSecurityFoundations({
      env: deployedEnv("staging"),
      now: () => FIXED_NOW_MS,
      randomBytes: (byteLength) =>
        Buffer.alloc(byteLength, 9),
      randomUUID: () => FIXED_UUID,
      loggerSink(line) {
        lines.push(line);
      },
    });

    foundations.logger.info(
      "security.redaction.proof",
      {
        note:
          `${RATE_LIMIT_SECRET}:${AUDIT_SECRET}:` +
          ACTION_TOKEN_DELIVERY_KEY +
          `:${RESEND_API_KEY}`,
      }
    );

    const serializedConfig = JSON.stringify(
      foundations.config
    );
    assert.equal(
      serializedConfig.includes(RATE_LIMIT_SECRET),
      false
    );
    assert.equal(
      serializedConfig.includes(AUDIT_SECRET),
      false
    );
    assert.equal(
      serializedConfig.includes(
        ACTION_TOKEN_DELIVERY_KEY
      ),
      false
    );
    assert.equal(
      serializedConfig.includes(RESEND_API_KEY),
      false
    );
    assert.equal(
      lines[0].includes(RATE_LIMIT_SECRET),
      false
    );
    assert.equal(
      lines[0].includes(AUDIT_SECRET),
      false
    );
    assert.equal(
      lines[0].includes(ACTION_TOKEN_DELIVERY_KEY),
      false
    );
  });
});
