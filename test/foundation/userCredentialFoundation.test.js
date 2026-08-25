const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  PASSWORD_POLICY_CODES,
  PasswordPolicyError,
  assertPassword,
  assertPasswordConfirmation,
  inspectPassword,
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
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteCredentialRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCredentialRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  SCRYPT_KEY_BYTES,
  SCRYPT_SALT_BYTES,
  ScryptCapacityError,
  ScryptOperationError,
  StoredCredentialError,
  createScryptPasswordHasher,
} = require(
  "../../src/infrastructure/security/createScryptPasswordHasher"
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
const FIXED_NOW_MS = Date.parse(
  "2026-07-19T20:00:00.000Z"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createTemporaryDatabase(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const databasePath = path.join(
    temporaryRoot,
    "accounts.sqlite3"
  );
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });

  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-03-test",
    now: () => FIXED_NOW_MS,
  });

  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  const users = createSqliteUserRepository({
    database: connection.database,
  });
  const credentials =
    createSqliteCredentialRepository({
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
    credentials,
    databasePath,
    temporaryRoot,
    users,
  };
}

function userRecord(
  value,
  {
    email = `user${value}@example.test`,
    displayName = `User ${value}`,
    ...overrides
  } = {}
) {
  return {
    id: uuid(value),
    email_normalized: email.toLowerCase(),
    email_display: email,
    display_name: displayName,
    display_name_normalized:
      displayName.toLowerCase(),
    status: "active",
    created_at_ms: FIXED_NOW_MS,
    updated_at_ms: FIXED_NOW_MS,
    version: 1,
    ...overrides,
  };
}

function credentialRecord(
  value,
  userId,
  overrides = {}
) {
  return {
    id: uuid(value),
    user_id: userId,
    password_hash:
      `scrypt$v=1$synthetic-${value}`,
    algorithm: "scrypt",
    algorithm_version: 1,
    status: "active",
    created_at_ms: FIXED_NOW_MS,
    replaced_at_ms: null,
    version: 1,
    ...overrides,
  };
}

function createDeterministicRandom({
  firstSaltByte = 1,
  firstId = 100,
} = {}) {
  let saltByte = firstSaltByte;
  let id = firstId;
  return createSecureRandom({
    randomBytes(byteLength) {
      const value = Buffer.alloc(
        byteLength,
        saltByte
      );
      saltByte += 1;
      return value;
    },
    randomUUID() {
      const value = uuid(id);
      id += 1;
      return value;
    },
  });
}

function fastScrypt(
  password,
  salt,
  keyLength,
  _options,
  callback
) {
  setImmediate(() => {
    const key = crypto
      .createHash("sha256")
      .update(Buffer.from(password, "utf8"))
      .update(salt)
      .digest()
      .subarray(0, keyLength);
    callback(null, key);
  });
}

function createFastPasswordHasher(options = {}) {
  return createScryptPasswordHasher({
    secureRandom:
      options.secureRandom ||
      createDeterministicRandom(),
    scrypt: options.scrypt || fastScrypt,
    timingSafeEqual:
      options.timingSafeEqual ||
      crypto.timingSafeEqual,
    maxConcurrent: options.maxConcurrent,
    maxQueued: options.maxQueued,
  });
}

function assertRepositoryError(code) {
  return (error) => error?.code === code;
}

describe("M3-03 exact password policy", () => {
  test("accepts exact boundary values, spaces, and Unicode without transformation", () => {
    const minimum = " a b c";
    const unicodeMaximum = "😀".repeat(256);

    assert.deepEqual(inspectPassword(minimum), {
      ok: true,
      reasonCode: null,
    });
    assert.equal(assertPassword(minimum), minimum);
    assert.deepEqual(
      inspectPassword(unicodeMaximum),
      {
        ok: true,
        reasonCode: null,
      }
    );
    assert.equal(
      Buffer.byteLength(unicodeMaximum, "utf8"),
      1024
    );

    const composed = "éabcde";
    const decomposed = "e\u0301abcde";
    assert.equal(assertPassword(composed), composed);
    assert.equal(
      assertPassword(decomposed),
      decomposed
    );
    assert.notEqual(composed, decomposed);
  });

  test("returns safe reason codes for type, Unicode, length, and confirmation failures", () => {
    const cases = [
      {
        value: null,
        code: PASSWORD_POLICY_CODES.typeInvalid,
      },
      {
        value: "\ud800abcde",
        code: PASSWORD_POLICY_CODES.unicodeInvalid,
      },
      {
        value: "abcde",
        code: PASSWORD_POLICY_CODES.tooShort,
      },
      {
        value: "a".repeat(257),
        code: PASSWORD_POLICY_CODES.tooLong,
      },
    ];

    for (const { value, code } of cases) {
      assert.deepEqual(inspectPassword(value), {
        ok: false,
        reasonCode: code,
      });
      assert.throws(
        () => assertPassword(value),
        (error) =>
          error instanceof PasswordPolicyError &&
          error.reasonCode === code &&
          !error.message.includes(String(value))
      );
    }

    assert.throws(
      () =>
        assertPasswordConfirmation(
          "abcdef",
          undefined
        ),
      (error) =>
        error.reasonCode ===
        PASSWORD_POLICY_CODES.confirmationInvalid
    );
    assert.throws(
      () =>
        assertPasswordConfirmation(
          "abcdef",
          "abcdef "
        ),
      (error) =>
        error.reasonCode ===
        PASSWORD_POLICY_CODES.confirmationMismatch
    );
  });

  test("requires byte-for-byte confirmation and preserves leading and trailing spaces", () => {
    const password = " secret ";
    assert.equal(
      assertPasswordConfirmation(
        password,
        " secret "
      ),
      password
    );
    assert.throws(
      () =>
        assertPasswordConfirmation(
          password,
          "secret"
        ),
      (error) =>
        error instanceof PasswordPolicyError &&
        error.reasonCode ===
          PASSWORD_POLICY_CODES.confirmationMismatch
    );
  });
});

describe("M3-03 asynchronous scrypt password storage", () => {
  test("performs a real approved Node scrypt hash and timing-safe verification", async () => {
    const hasher = createScryptPasswordHasher({
      secureRandom: createSecureRandom(),
      maxConcurrent: 1,
      maxQueued: 1,
    });
    const password = "correct horse 🏒";
    const encoded = await hasher.hash(password);

    assert.match(
      encoded,
      /^scrypt\$v=1\$N=131072,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/
    );
    assert.equal(encoded.includes(password), false);
    assert.deepEqual(
      await hasher.verify(password, encoded),
      {
        verified: true,
        needsRehash: false,
      }
    );
    assert.deepEqual(
      await hasher.verify(
        "different valid password",
        encoded
      ),
      {
        verified: false,
        needsRehash: false,
      }
    );
    assert.deepEqual(hasher.capacity(), {
      active: 0,
      queued: 0,
      maxConcurrent: 1,
      maxQueued: 1,
    });
  });

  test("uses a fresh exact-length salt for every encoded password", async () => {
    const requestedLengths = [];
    let saltValue = 10;
    const secureRandom = {
      bytes(byteLength) {
        requestedLengths.push(byteLength);
        const value = Buffer.alloc(
          byteLength,
          saltValue
        );
        saltValue += 1;
        return value;
      },
    };
    const hasher = createFastPasswordHasher({
      secureRandom,
    });

    const first = await hasher.hash(
      "synthetic password"
    );
    const second = await hasher.hash(
      "synthetic password"
    );

    assert.deepEqual(requestedLengths, [
      SCRYPT_SALT_BYTES,
      SCRYPT_SALT_BYTES,
    ]);
    assert.notEqual(first, second);
    assert.equal(
      first.split("$")[3],
      Buffer.alloc(SCRYPT_SALT_BYTES, 10)
        .toString("base64url")
    );
    assert.equal(
      second.split("$")[3],
      Buffer.alloc(SCRYPT_SALT_BYTES, 11)
        .toString("base64url")
    );
  });

  test("rejects every malformed stored encoding with one safe error", async () => {
    const hasher = createFastPasswordHasher();
    const encoded = await hasher.hash(
      "synthetic password"
    );
    const [, version, parameters, salt, key] =
      encoded.split("$");
    const malformed = [
      7,
      "",
      encoded.replace(/^scrypt/, "argon2"),
      `scrypt$v=2$${parameters}$${salt}$${key}`,
      `scrypt$${version}$r=8,N=131072,p=1$${salt}$${key}`,
      `scrypt$${version}$N=65536,r=8,p=1$${salt}$${key}`,
      `scrypt$${version}$N=131072,r=8,p=1,p=1$${salt}$${key}`,
      `scrypt$${version}$${parameters}$${salt}=$${key}`,
      `scrypt$${version}$${parameters}$${Buffer.alloc(
        SCRYPT_SALT_BYTES - 1
      ).toString("base64url")}$${key}`,
      `scrypt$${version}$${parameters}$${salt}$${Buffer.alloc(
        SCRYPT_KEY_BYTES - 1
      ).toString("base64url")}`,
    ];

    for (const candidate of malformed) {
      let caught;
      try {
        await hasher.verify(
          "synthetic password",
          candidate
        );
      } catch (error) {
        caught = error;
      }
      assert.ok(
        caught instanceof StoredCredentialError
      );
      assert.equal(
        caught.code,
        "STORED_CREDENTIAL_INVALID"
      );
      if (String(candidate).length > 0) {
        assert.equal(
          caught.message.includes(
            String(candidate)
          ),
          false
        );
      }
    }
  });

  test("uses the timing-safe comparison seam with equal-length derived keys", async () => {
    let comparison = null;
    const hasher = createFastPasswordHasher({
      timingSafeEqual(left, right) {
        comparison = {
          leftLength: left.byteLength,
          rightLength: right.byteLength,
        };
        return crypto.timingSafeEqual(left, right);
      },
    });
    const encoded = await hasher.hash(
      "synthetic password"
    );

    const result = await hasher.verify(
      "synthetic password",
      encoded
    );
    assert.equal(result.verified, true);
    assert.deepEqual(comparison, {
      leftLength: SCRYPT_KEY_BYTES,
      rightLength: SCRYPT_KEY_BYTES,
    });
  });

  test("runs two operations, queues eight FIFO, rejects overflow, and fully recovers", async () => {
    const started = [];
    const hasher = createFastPasswordHasher({
      maxConcurrent: 2,
      maxQueued: 8,
      scrypt(
        password,
        _salt,
        _keyLength,
        _options,
        callback
      ) {
        started.push({ callback, password });
      },
    });
    const passwords = Array.from(
      { length: 10 },
      (_value, index) =>
        `synthetic-password-${index}`
    );
    const pending = passwords.map((password) =>
      hasher.hash(password)
    );

    assert.deepEqual(hasher.capacity(), {
      active: 2,
      queued: 8,
      maxConcurrent: 2,
      maxQueued: 8,
    });
    await assert.rejects(
      hasher.hash("overflow-password"),
      (error) =>
        error instanceof ScryptCapacityError &&
        error.retryable === true
    );

    await tick();
    for (let index = 0; index < 10; index += 1) {
      while (!started[index]) {
        await tick();
      }
      started[index].callback(
        null,
        Buffer.alloc(
          SCRYPT_KEY_BYTES,
          index + 1
        )
      );
      await tick();
    }
    await Promise.all(pending);

    assert.deepEqual(
      started.map(({ password }) => password),
      passwords
    );
    assert.deepEqual(hasher.capacity(), {
      active: 0,
      queued: 0,
      maxConcurrent: 2,
      maxQueued: 8,
    });
  });

  test("releases capacity after a derivation failure and returns a generic operation error", async () => {
    let calls = 0;
    const hasher = createFastPasswordHasher({
      maxConcurrent: 1,
      maxQueued: 0,
      scrypt(
        _password,
        _salt,
        _keyLength,
        _options,
        callback
      ) {
        calls += 1;
        setImmediate(() => {
          if (calls === 1) {
            callback(
              new Error(
                "synthetic provider detail"
              )
            );
          } else {
            callback(
              null,
              Buffer.alloc(SCRYPT_KEY_BYTES, 3)
            );
          }
        });
      },
    });

    await assert.rejects(
      hasher.hash("synthetic password"),
      (error) =>
        error instanceof ScryptOperationError &&
        !error.message.includes("provider detail")
    );
    assert.equal(
      typeof (await hasher.hash(
        "synthetic password"
      )),
      "string"
    );
    assert.deepEqual(hasher.capacity(), {
      active: 0,
      queued: 0,
      maxConcurrent: 1,
      maxQueued: 0,
    });
  });
});

describe("M3-03 specialized SQLite user repository", () => {
  test("supports safe canonical lookups and optimistic updates without credential columns", (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-03-users-"
    );
    const inserted = runtime.users.insert(
      userRecord(1, {
        email: "Manager@Example.test",
        displayName: "Manager One",
      })
    );

    assert.equal(Object.isFrozen(inserted), true);
    assert.equal(
      runtime.users.findById(inserted.id)?.id,
      inserted.id
    );
    assert.equal(
      runtime.users.findByNormalizedEmail(
        "manager@example.test"
      )?.id,
      inserted.id
    );
    assert.equal(
      runtime.users.findByNormalizedDisplayName(
        "manager one"
      )?.id,
      inserted.id
    );
    assert.equal(
      runtime.users.findByNormalizedEmail(
        "missing@example.test"
      ),
      null
    );

    const updated = runtime.users.updateVersioned({
      key: inserted.id,
      expectedVersion: 1,
      changes: {
        display_name: "Manager Prime",
        display_name_normalized:
          "manager prime",
        updated_at_ms: FIXED_NOW_MS + 1,
      },
    });
    assert.equal(updated.version, 2);
    assert.equal(
      updated.display_name,
      "Manager Prime"
    );
    assert.throws(
      () =>
        runtime.users.updateVersioned({
          key: inserted.id,
          expectedVersion: 1,
          changes: {
            updated_at_ms: FIXED_NOW_MS + 2,
          },
        }),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.versionConflict
      )
    );

    const serialized = JSON.stringify(updated);
    assert.equal(
      serialized.includes("password_hash"),
      false
    );
    const userRepositorySource = fs.readFileSync(
      path.join(
        ROOT_DIRECTORY,
        "src",
        "infrastructure",
        "persistence",
        "sqlite",
        "SqliteUserRepository.js"
      ),
      "utf8"
    );
    assert.equal(
      /user_credentials|password_hash/.test(
        userRepositorySource
      ),
      false
    );
  });

  test("rejects noncanonical lookups and maps uniqueness constraints", (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-03-user-errors-"
    );
    runtime.users.insert(userRecord(1));

    for (const value of [
      "User1@example.test",
      " user1@example.test",
      "user1@example.test ",
    ]) {
      assert.throws(
        () =>
          runtime.users.findByNormalizedEmail(
            value
          ),
        assertRepositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid
        )
      );
    }

    assert.throws(
      () =>
        runtime.users.insert(
          userRecord(2, {
            email: "user1@example.test",
          })
        ),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.constraint
      )
    );
  });
});

describe("M3-03 sensitive SQLite credential repository", () => {
  test("enforces one active credential and atomically replaces it", (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-03-credentials-"
    );
    const user = runtime.users.insert(userRecord(1));
    const original =
      runtime.credentials.insertActive(
        credentialRecord(10, user.id)
      );

    assert.equal(
      runtime.credentials.findById(original.id)
        ?.password_hash,
      original.password_hash
    );
    assert.equal(
      runtime.credentials.findActiveByUserId(
        user.id
      )?.id,
      original.id
    );
    assert.equal(
      Object.hasOwn(
        runtime.credentials,
        "listAll"
      ),
      false
    );
    assert.throws(
      () =>
        runtime.credentials.insertActive(
          credentialRecord(11, user.id)
        ),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.constraint
      )
    );

    const replacement = credentialRecord(
      12,
      user.id,
      {
        created_at_ms: FIXED_NOW_MS + 10,
        password_hash:
          "scrypt$v=1$replacement",
      }
    );
    const result =
      runtime.credentials.replaceActive({
        currentCredentialId: original.id,
        expectedVersion: 1,
        replacedAtMs: FIXED_NOW_MS + 10,
        replacement,
      });

    assert.equal(result.previous.status, "replaced");
    assert.equal(result.previous.version, 2);
    assert.equal(
      result.previous.replaced_at_ms,
      FIXED_NOW_MS + 10
    );
    assert.equal(result.active.id, replacement.id);
    assert.equal(
      runtime.credentials.findActiveByUserId(
        user.id
      )?.id,
      replacement.id
    );
  });

  test("rolls back the prior credential when replacement insertion or version checks fail", (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-03-credential-rollback-"
    );
    const user = runtime.users.insert(userRecord(1));
    const original =
      runtime.credentials.insertActive(
        credentialRecord(10, user.id)
      );
    const invalidReplacement = credentialRecord(
      11,
      user.id,
      {
        created_at_ms: FIXED_NOW_MS + 1,
        password_hash: "",
      }
    );

    assert.throws(
      () =>
        runtime.credentials.replaceActive({
          currentCredentialId: original.id,
          expectedVersion: 1,
          replacedAtMs: FIXED_NOW_MS + 1,
          replacement: invalidReplacement,
        }),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.constraint
      )
    );
    assert.deepEqual(
      runtime.credentials.findActiveByUserId(
        user.id
      ),
      original
    );
    assert.equal(
      runtime.credentials.findById(
        invalidReplacement.id
      ),
      null
    );

    assert.throws(
      () =>
        runtime.credentials.replaceActive({
          currentCredentialId: original.id,
          expectedVersion: 2,
          replacedAtMs: FIXED_NOW_MS + 2,
          replacement: credentialRecord(
            12,
            user.id,
            {
              created_at_ms:
                FIXED_NOW_MS + 2,
            }
          ),
        }),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.versionConflict
      )
    );
    assert.deepEqual(
      runtime.credentials.findActiveByUserId(
        user.id
      ),
      original
    );
  });
});

describe("M3-03 test-only atomic account creation", () => {
  test("creates only one user and credential without granting authority", async (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-03-test-account-"
    );
    const secureRandom =
      createDeterministicRandom({
        firstId: 200,
      });
    const result = await createTestAccount({
      repositoryContext: runtime.context,
      userRepository: runtime.users,
      credentialRepository:
        runtime.credentials,
      passwordHasher:
        createFastPasswordHasher({
          secureRandom,
        }),
      clock: createSystemClock({
        now: () => FIXED_NOW_MS,
      }),
      secureRandom,
      emailNormalized:
        "synthetic.manager@example.test",
      emailDisplay:
        "synthetic.manager@example.test",
      displayName: "Synthetic Manager",
      displayNameNormalized:
        "synthetic manager",
      password: "synthetic password",
    });

    assert.equal(result.user.id, uuid(200));
    assert.equal(result.credentialId, uuid(201));
    assert.equal(
      JSON.stringify(result).includes(
        "password_hash"
      ),
      false
    );
    assert.equal(
      runtime.credentials.findActiveByUserId(
        result.user.id
      )?.id,
      result.credentialId
    );

    const expectedCounts = {
      users: 1,
      user_credentials: 1,
      platform_roles: 0,
      leagues: 0,
      league_memberships: 0,
      teams: 0,
      sessions: 0,
      account_action_tokens: 0,
      account_events: 0,
      notifications: 0,
    };
    for (const [tableName, expected] of Object.entries(
      expectedCounts
    )) {
      const { count } = runtime.database
        .prepare(
          `SELECT count(*) AS count FROM ${tableName}`
        )
        .get();
      assert.equal(count, expected, tableName);
    }
  });

  test("rolls back the user when credential insertion fails", async (t) => {
    const runtime = createTemporaryDatabase(
      t,
      "hundo-m3-03-test-account-rollback-"
    );
    const secureRandom =
      createDeterministicRandom({
        firstId: 300,
      });
    const failingCredentials = {
      insertActive() {
        throw new Error(
          "synthetic credential insertion failure"
        );
      },
    };

    await assert.rejects(
      createTestAccount({
        repositoryContext: runtime.context,
        userRepository: runtime.users,
        credentialRepository:
          failingCredentials,
        passwordHasher:
          createFastPasswordHasher({
            secureRandom,
          }),
        clock: createSystemClock({
          now: () => FIXED_NOW_MS,
        }),
        secureRandom,
        emailNormalized:
          "rollback.manager@example.test",
        emailDisplay:
          "rollback.manager@example.test",
        displayName: "Rollback Manager",
        displayNameNormalized:
          "rollback manager",
        password: "synthetic password",
      })
    );

    assert.equal(
      runtime.users.findById(uuid(300)),
      null
    );
    assert.equal(
      runtime.database
        .prepare(
          "SELECT count(*) AS count FROM user_credentials"
        )
        .get().count,
      0
    );
  });
});
