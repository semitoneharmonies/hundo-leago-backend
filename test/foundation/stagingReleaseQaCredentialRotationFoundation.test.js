"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  REQUIRED_HOLD_VALUES,
} = require(
  "../../src/config/loadStagingMaintenanceHoldConfig"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createScryptPasswordHasher,
} = require(
  "../../src/infrastructure/security/createScryptPasswordHasher"
);
const {
  createSqliteCredentialRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCredentialRepository"
);
const {
  createSqliteSessionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSessionRepository"
);
const {
  createSqliteSecurityAuditRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository"
);
const {
  FIXTURE_CREATED_AT,
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);
const {
  ERROR_CODES,
  EVENT_TYPE,
  fixtureAccounts,
  receiptEventId,
  receiptReasonCode,
  replacementCredentialId,
  rotateReleaseQaCredentials,
} = require(
  "../../src/operations/release/rotateReleaseQaCredentials"
);
const {
  COMMAND_ERROR_CODES,
  EXPECTED_SCHEMA_VERSION,
  PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD,
  PASSWORD_ENVIRONMENT_FIELD,
  assertSafeEnvironment,
  confirmationFor,
  consumePasswordEnvironment,
  parseArguments,
  runReleaseQaCredentialRotationCommand,
} = require("../../scripts/rotate-release-qa-credentials");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const RELEASE_ID = "HL-20260821-1";
const OLD_PASSWORD = "old staging QA password";
const NEW_PASSWORD = "new staging QA password 🏒";
const CREATED_AT_MS = Date.parse(FIXTURE_CREATED_AT);
const TARGET_SESSION_ALIASES = Object.freeze([
  "platformAdmin",
  "leagueACommissioner",
  "leagueAManagerOne",
]);
const UNRELATED_USER_ID = "90000000-0000-4000-8000-000000000001";
const UNRELATED_CREDENTIAL_ID =
  "90000000-0000-4000-8000-000000000002";
const UNRELATED_SESSION_ID =
  "90000000-0000-4000-8000-000000000003";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fastPasswordHasher() {
  let saltIndex = 0;
  return createScryptPasswordHasher({
    maxConcurrent: 2,
    maxQueued: 16,
    secureRandom: Object.freeze({
      bytes(length) {
        const salt = Buffer.alloc(length, 0);
        salt.writeUInt32BE(++saltIndex, length - 4);
        return salt;
      },
    }),
    scrypt(password, salt, keyLength, _options, callback) {
      const value = crypto
        .createHash("sha256")
        .update(password, "utf8")
        .update(salt)
        .digest()
        .subarray(0, keyLength);
      queueMicrotask(() => callback(null, value));
    },
  });
}

function insertSession(database, { id, userId, sequence }) {
  database.prepare(`
    INSERT INTO sessions (
      id, user_id, token_digest, csrf_secret_digest, status,
      created_at_ms, last_used_at_ms, idle_expires_at_ms,
      absolute_expires_at_ms, revoked_at_ms, revocation_reason,
      client_metadata_json, version
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL, NULL, 1)
  `).run(
    id,
    userId,
    digest(`token:${sequence}`),
    digest(`csrf:${sequence}`),
    CREATED_AT_MS,
    CREATED_AT_MS,
    CREATED_AT_MS + 60_000,
    CREATED_AT_MS + 120_000
  );
}

async function createFixtureDatabase(t, name = "rotation") {
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `hundo-${name}-`)
  );
  t.after(() => {
    fs.rmSync(persistentRoot, { recursive: true, force: true });
  });
  const databasePath = path.join(
    persistentRoot,
    "m7-release-qa.sqlite3"
  );
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "release-qa-rotation-test",
    now: () => CREATED_AT_MS,
  });
  const oldHash = await fastPasswordHasher().hash(OLD_PASSWORD);
  const insertMetadata = connection.database.prepare(`
    INSERT INTO application_metadata (
      metadata_key, metadata_value, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?)
  `);
  insertMetadata.run(
    "database_created_at",
    FIXTURE_CREATED_AT,
    CREATED_AT_MS,
    CREATED_AT_MS
  );
  insertMetadata.run(
    "database_id",
    FIXTURE_DATABASE_ID,
    CREATED_AT_MS,
    CREATED_AT_MS
  );
  insertMetadata.run(
    "environment_id",
    FIXTURE_ENVIRONMENT_ID,
    CREATED_AT_MS,
    CREATED_AT_MS
  );
  const insertUser = connection.database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms, updated_at_ms,
      version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insertCredential = connection.database.prepare(`
    INSERT INTO user_credentials (
      id, user_id, password_hash, algorithm, algorithm_version,
      status, created_at_ms, replaced_at_ms, version
    ) VALUES (?, ?, ?, 'scrypt', 1, 'active', ?, NULL, 1)
  `);
  connection.database.exec("BEGIN IMMEDIATE");
  try {
    for (const account of fixtureAccounts()) {
      insertUser.run(
        account.userId,
        account.email,
        account.email,
        account.alias,
        account.alias.toLowerCase(),
        account.status,
        CREATED_AT_MS,
        CREATED_AT_MS
      );
      insertCredential.run(
        fixtureId(`credential:${account.alias}`),
        account.userId,
        oldHash,
        CREATED_AT_MS
      );
    }
    insertUser.run(
      UNRELATED_USER_ID,
      "unrelated@example.test",
      "unrelated@example.test",
      "Unrelated User",
      "unrelated user",
      "active",
      CREATED_AT_MS,
      CREATED_AT_MS
    );
    insertCredential.run(
      UNRELATED_CREDENTIAL_ID,
      UNRELATED_USER_ID,
      oldHash,
      CREATED_AT_MS
    );
    for (let index = 0; index < TARGET_SESSION_ALIASES.length; index += 1) {
      const alias = TARGET_SESSION_ALIASES[index];
      insertSession(connection.database, {
        id: fixtureId(`rotation-test-session:${alias}`),
        userId: fixtureId(`account:${alias}`),
        sequence: index + 1,
      });
    }
    insertSession(connection.database, {
      id: UNRELATED_SESSION_ID,
      userId: UNRELATED_USER_ID,
      sequence: 99,
    });
    connection.database.exec("COMMIT");
  } catch (error) {
    if (connection.database.inTransaction) {
      connection.database.exec("ROLLBACK");
    }
    throw error;
  } finally {
    connection.database.close();
  }
  return Object.freeze({ databasePath, persistentRoot });
}

function environment(target, overrides = {}) {
  return {
    ...REQUIRED_HOLD_VALUES,
    APP_ENVIRONMENT_ID: FIXTURE_ENVIRONMENT_ID,
    DATABASE_ID: FIXTURE_DATABASE_ID,
    DATABASE_PATH: target.databasePath,
    PERSISTENT_DATA_ROOT: target.persistentRoot,
    PORT: "10000",
    STAGING_MAINTENANCE_HOLD: "true",
    [PASSWORD_ENVIRONMENT_FIELD]: NEW_PASSWORD,
    [PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD]: NEW_PASSWORD,
    ...overrides,
  };
}

function commandArguments(target, overrides = {}) {
  const values = {
    databasePath: target.databasePath,
    persistentRoot: target.persistentRoot,
    releaseId: RELEASE_ID,
    confirmation: confirmationFor({
      releaseId: RELEASE_ID,
      environmentId: FIXTURE_ENVIRONMENT_ID,
      databaseId: FIXTURE_DATABASE_ID,
    }),
    ...overrides,
  };
  return [
    "--database",
    values.databasePath,
    "--environment",
    "staging",
    "--persistent-root",
    values.persistentRoot,
    "--release-id",
    values.releaseId,
    "--confirmation",
    values.confirmation,
  ];
}

function openTestDatabase(target) {
  return openDatabase({
    databasePath: target.databasePath,
    environment: "test",
  });
}

function querySecurityProjection(database) {
  return Object.freeze({
    credentials: database.prepare(`
      SELECT id, user_id, password_hash, algorithm, algorithm_version,
        status, created_at_ms, replaced_at_ms, version
      FROM user_credentials
      ORDER BY id
    `).all(),
    sessions: database.prepare(`
      SELECT id, user_id, token_digest, csrf_secret_digest, status,
        created_at_ms, last_used_at_ms, idle_expires_at_ms,
        absolute_expires_at_ms, revoked_at_ms, revocation_reason,
        client_metadata_json, version
      FROM sessions
      ORDER BY id
    `).all(),
    audits: database.prepare(`
      SELECT * FROM security_audit_events ORDER BY id
    `).all(),
  });
}

function queryUnrelatedProjection(database) {
  const excluded = new Set([
    "security_audit_events",
    "sessions",
    "user_credentials",
  ]);
  const tables = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => name);
  return Object.freeze(
    Object.fromEntries(
      tables
        .filter((name) => !excluded.has(name))
        .map((name) => [
          name,
          database.prepare(`SELECT * FROM "${name}"`).all(),
        ])
    )
  );
}

async function runCommand(target, overrides = {}) {
  const logs = [];
  const env = environment(target, overrides.env);
  const result = await runReleaseQaCredentialRotationCommand({
    argv: commandArguments(target, overrides.arguments),
    env,
    output: { log(value) { logs.push(value); } },
    now: () => CREATED_AT_MS + 1_000_000,
    createPasswordHasher: fastPasswordHasher,
  });
  return Object.freeze({ env, logs, result });
}

test("release-QA credential rotation is bound to exactly nine canonical fixture accounts", () => {
  const accounts = fixtureAccounts();
  assert.equal(accounts.length, 9);
  assert.equal(new Set(accounts.map(({ alias }) => alias)).size, 9);
  assert.equal(new Set(accounts.map(({ userId }) => userId)).size, 9);
  assert.equal(new Set(accounts.map(({ email }) => email)).size, 9);
  assert.deepEqual(
    accounts.map(({ alias }) => alias),
    [
      "platformAdmin",
      "leagueACommissioner",
      "leagueBCommissioner",
      "leagueAManagerOne",
      "leagueAManagerTwo",
      "leagueBManagerOne",
      "verifiedWithoutMembership",
      "pendingVerification",
      "deactivated",
    ]
  );
});

test("exact held schema-54 staging rotation replaces all nine credentials, revokes only target sessions, and preserves every domain row", async (t) => {
  const target = await createFixtureDatabase(t, "rotation-happy");
  const beforeConnection = openTestDatabase(target);
  const unrelatedBefore = queryUnrelatedProjection(
    beforeConnection.database
  );
  const unrelatedUserBefore = beforeConnection.database.prepare(`
    SELECT user.*, credential.*, session.*
    FROM users AS user
    JOIN user_credentials AS credential
      ON credential.user_id = user.id AND credential.status = 'active'
    JOIN sessions AS session
      ON session.user_id = user.id AND session.status = 'active'
    WHERE user.id = ?
  `).get(UNRELATED_USER_ID);
  beforeConnection.database.close();

  const first = await runCommand(target);
  assert.deepEqual(first.result, {
    code: "RELEASE_QA_CREDENTIALS_ROTATED",
    contractVersion: 1,
    rotationId: RELEASE_ID,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    databaseId: FIXTURE_DATABASE_ID,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    fixtureAccountCount: 9,
    rotatedAccountCount: 9,
    revokedActiveSessionCount: TARGET_SESSION_ALIASES.length,
    receiptEventId: receiptEventId({
      databaseId: FIXTURE_DATABASE_ID,
      rotationId: RELEASE_ID,
    }),
    rotatedAtMs: CREATED_AT_MS + 1_000_000,
    replayed: false,
    databaseWriteCount: 19 + TARGET_SESSION_ALIASES.length,
  });
  assert.equal(first.logs.length, 1);
  assert.deepEqual(JSON.parse(first.logs[0]), first.result);
  assert.equal(
    Object.hasOwn(first.env, PASSWORD_ENVIRONMENT_FIELD),
    false
  );
  assert.equal(
    Object.hasOwn(
      first.env,
      PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD
    ),
    false
  );
  assert.equal(first.logs[0].includes(NEW_PASSWORD), false);
  assert.equal(first.logs[0].includes(OLD_PASSWORD), false);
  assert.doesNotMatch(
    first.logs[0],
    /@release-qa\.example\.test|password_hash|token_digest|csrf_secret/iu
  );

  const afterConnection = openTestDatabase(target);
  const credentialRepository = createSqliteCredentialRepository({
    database: afterConnection.database,
  });
  const verifier = fastPasswordHasher();
  const activeHashes = [];
  for (const account of fixtureAccounts()) {
    const active = credentialRepository.findActiveByUserId(account.userId);
    assert.equal(
      active.id,
      replacementCredentialId({
        databaseId: FIXTURE_DATABASE_ID,
        rotationId: RELEASE_ID,
        alias: account.alias,
      })
    );
    assert.equal(active.version, 1);
    assert.equal(
      (await verifier.verify(NEW_PASSWORD, active.password_hash)).verified,
      true
    );
    assert.equal(
      (await verifier.verify(OLD_PASSWORD, active.password_hash)).verified,
      false
    );
    activeHashes.push(active.password_hash);
    const original = afterConnection.database.prepare(`
      SELECT status, replaced_at_ms, version
      FROM user_credentials
      WHERE id = ?
    `).get(fixtureId(`credential:${account.alias}`));
    assert.deepEqual(original, {
      status: "replaced",
      replaced_at_ms: CREATED_AT_MS + 1_000_000,
      version: 2,
    });
  }
  assert.equal(new Set(activeHashes).size, 9);
  assert.equal(
    afterConnection.database.prepare(`
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE user_id IN (
        ${fixtureAccounts().map(() => "?").join(", ")}
      ) AND status = 'active'
    `).get(...fixtureAccounts().map(({ userId }) => userId)).count,
    0
  );
  for (const alias of TARGET_SESSION_ALIASES) {
    assert.deepEqual(
      afterConnection.database.prepare(`
        SELECT status, revoked_at_ms, revocation_reason, version
        FROM sessions WHERE id = ?
      `).get(fixtureId(`rotation-test-session:${alias}`)),
      {
        status: "revoked",
        revoked_at_ms: CREATED_AT_MS + 1_000_000,
        revocation_reason: "platform_security_action",
        version: 2,
      }
    );
  }
  const unrelatedUserAfter = afterConnection.database.prepare(`
    SELECT user.*, credential.*, session.*
    FROM users AS user
    JOIN user_credentials AS credential
      ON credential.user_id = user.id AND credential.status = 'active'
    JOIN sessions AS session
      ON session.user_id = user.id AND session.status = 'active'
    WHERE user.id = ?
  `).get(UNRELATED_USER_ID);
  assert.deepEqual(unrelatedUserAfter, unrelatedUserBefore);
  assert.deepEqual(
    queryUnrelatedProjection(afterConnection.database),
    unrelatedBefore
  );
  const receipt = afterConnection.database.prepare(`
    SELECT * FROM security_audit_events WHERE id = ?
  `).get(first.result.receiptEventId);
  assert.equal(receipt.event_type, EVENT_TYPE);
  assert.equal(receipt.outcome, "success");
  assert.equal(receipt.actor_user_id, null);
  assert.equal(receipt.target_user_id, null);
  assert.equal(receipt.league_id, null);
  assert.equal(receipt.session_id, null);
  assert.equal(receipt.request_correlation_id, RELEASE_ID);
  assert.equal(
    receipt.reason_code,
    receiptReasonCode(TARGET_SESSION_ALIASES.length)
  );
  assert.equal(receipt.client_metadata_json, null);
  assert.equal(
    JSON.stringify(receipt).includes(NEW_PASSWORD),
    false
  );
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /password_hash|token_digest|csrf_secret|@release-qa\.example\.test/iu
  );
  assert.equal(
    afterConnection.database.pragma("integrity_check", { simple: true }),
    "ok"
  );
  assert.deepEqual(afterConnection.database.pragma("foreign_key_check"), []);
  afterConnection.database.close();
});

test("same release and password replay performs zero writes; wrong password, changed credential identity, active session, or receipt tampering fails closed", async (t) => {
  const target = await createFixtureDatabase(t, "rotation-replay");
  await runCommand(target);

  const beforeReplayConnection = openTestDatabase(target);
  const beforeReplay = querySecurityProjection(
    beforeReplayConnection.database
  );
  beforeReplayConnection.database.close();
  const replay = await runCommand(target);
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.databaseWriteCount, 0);
  assert.equal(
    replay.result.revokedActiveSessionCount,
    TARGET_SESSION_ALIASES.length
  );
  const afterReplayConnection = openTestDatabase(target);
  assert.deepEqual(
    querySecurityProjection(afterReplayConnection.database),
    beforeReplay
  );
  afterReplayConnection.database.close();

  const replayConnection = openTestDatabase(target);
  const contenderConnection = openTestDatabase(target);
  contenderConnection.database.pragma("busy_timeout = 0");
  const replayHasher = fastPasswordHasher();
  let concurrentWriteAttempted = false;
  const lockedReplay = await rotateReleaseQaCredentials({
    database: replayConnection.database,
    credentialRepository: createSqliteCredentialRepository({
      database: replayConnection.database,
    }),
    sessionRepository: createSqliteSessionRepository({
      database: replayConnection.database,
    }),
    auditRepository: createSqliteSecurityAuditRepository({
      database: replayConnection.database,
    }),
    passwordHasher: {
      hash: (...arguments_) => replayHasher.hash(...arguments_),
      async verify(...arguments_) {
        if (!concurrentWriteAttempted) {
          concurrentWriteAttempted = true;
          assert.throws(
            () =>
              contenderConnection.database.prepare(`
                UPDATE user_credentials
                SET version = version + 1
                WHERE id = ?
              `).run(
                replacementCredentialId({
                  databaseId: FIXTURE_DATABASE_ID,
                  rotationId: RELEASE_ID,
                  alias: fixtureAccounts()[0].alias,
                })
              ),
            (error) => error?.code === "SQLITE_BUSY"
          );
        }
        return replayHasher.verify(...arguments_);
      },
    },
    password: NEW_PASSWORD,
    rotationId: RELEASE_ID,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    databaseId: FIXTURE_DATABASE_ID,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    nowMs: CREATED_AT_MS + 1_000_000,
    assertBinding() {},
  });
  assert.equal(concurrentWriteAttempted, true);
  assert.equal(lockedReplay.replayed, true);
  assert.equal(lockedReplay.databaseWriteCount, 0);
  assert.equal(replayConnection.database.inTransaction, false);
  contenderConnection.database.close();
  replayConnection.database.close();

  const assertRejectedWithoutWrite = async (mutate, envOverrides = {}) => {
    const connection = openTestDatabase(target);
    if (mutate) mutate(connection.database);
    const before = querySecurityProjection(connection.database);
    connection.database.close();
    await assert.rejects(
      runCommand(target, { env: envOverrides }),
      (error) => error.code === ERROR_CODES.idempotencyConflict
    );
    const afterConnection = openTestDatabase(target);
    assert.deepEqual(
      querySecurityProjection(afterConnection.database),
      before
    );
    afterConnection.database.close();
  };

  await assertRejectedWithoutWrite(null, {
    [PASSWORD_ENVIRONMENT_FIELD]: "wrong password value",
    [PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD]: "wrong password value",
  });

  await assertRejectedWithoutWrite((database) => {
    const account = fixtureAccounts()[0];
    const active = database.prepare(`
      SELECT id FROM user_credentials
      WHERE user_id = ? AND status = 'active'
    `).get(account.userId);
    database.prepare(`
      UPDATE user_credentials
      SET id = ?
      WHERE id = ?
    `).run(fixtureId("tampered-replay-credential"), active.id);
  });

  const credentialRepairConnection = openTestDatabase(target);
  const firstAccount = fixtureAccounts()[0];
  credentialRepairConnection.database.prepare(`
    UPDATE user_credentials
    SET id = ?
    WHERE user_id = ? AND status = 'active'
  `).run(
    replacementCredentialId({
      databaseId: FIXTURE_DATABASE_ID,
      rotationId: RELEASE_ID,
      alias: firstAccount.alias,
    }),
    firstAccount.userId
  );
  credentialRepairConnection.database.close();

  await assertRejectedWithoutWrite((database) => {
    insertSession(database, {
      id: fixtureId("rotation-replay-new-session"),
      userId: firstAccount.userId,
      sequence: 120,
    });
  });

  const sessionRepairConnection = openTestDatabase(target);
  sessionRepairConnection.database.prepare(`
    DELETE FROM sessions WHERE id = ?
  `).run(fixtureId("rotation-replay-new-session"));
  sessionRepairConnection.database.close();

  await assertRejectedWithoutWrite((database) => {
    database.prepare(`
      UPDATE security_audit_events
      SET reason_code = 'tampered'
      WHERE id = ?
    `).run(
      receiptEventId({
        databaseId: FIXTURE_DATABASE_ID,
        rotationId: RELEASE_ID,
      })
    );
  });
});

test("rotation command rejects password arguments, incomplete confirmation, and every unheld or misbound environment before opening a writer", async (t) => {
  const target = await createFixtureDatabase(t, "rotation-guards");
  assert.throws(
    () => parseArguments([...commandArguments(target), "--password", "nope"]),
    (error) => error.code === COMMAND_ERROR_CODES.argumentInvalid
  );
  const secretEnvironment = environment(target, {
    [PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD]: "different value",
  });
  assert.throws(
    () => consumePasswordEnvironment(secretEnvironment),
    (error) => error.code === COMMAND_ERROR_CODES.passwordInvalid
  );
  assert.equal(
    Object.hasOwn(secretEnvironment, PASSWORD_ENVIRONMENT_FIELD),
    false
  );
  assert.equal(
    Object.hasOwn(
      secretEnvironment,
      PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD
    ),
    false
  );

  const driftCases = [
    { STAGING_MAINTENANCE_HOLD: "false" },
    { APP_ENV: "production" },
    { NODE_ENV: "development" },
    { LEAGUE_WRITE_MODE: "open" },
    { SCHEDULED_JOBS_ENABLED: "true" },
    { FREE_AGENT_DRAFT_ROUTES_ENABLED: "true" },
    { ACCOUNT_EMAIL_DELIVERY_ENABLED: "true" },
    { DEBUG_ROUTES_ENABLED: "true" },
    { EMAIL_DELIVERY_MODE: "deliver" },
    { SPORTSDATAIO_NHL_LIVE_MODE: "probe" },
    { BACKUP_SCHEDULE_ENABLED: "true" },
    { APP_ENVIRONMENT_ID: "production:unsafe" },
    { DATABASE_ID: "production-database" },
    { DATABASE_PATH: path.join(target.persistentRoot, "other.sqlite3") },
    { PERSISTENT_DATA_ROOT: path.dirname(target.persistentRoot) },
  ];
  for (const drift of driftCases) {
    assert.throws(
      () =>
        assertSafeEnvironment(
          parseArguments(commandArguments(target)),
          environment(target, drift)
        ),
      (error) => error.code === COMMAND_ERROR_CODES.environmentUnsafe
    );
  }

  const beforeConnection = openTestDatabase(target);
  const before = querySecurityProjection(beforeConnection.database);
  beforeConnection.database.close();
  await assert.rejects(
    runCommand(target, { env: { LEAGUE_WRITE_MODE: "open" } }),
    (error) => error.code === COMMAND_ERROR_CODES.environmentUnsafe
  );
  const afterConnection = openTestDatabase(target);
  assert.deepEqual(querySecurityProjection(afterConnection.database), before);
  afterConnection.database.close();

  const unchangedEnvironment = environment(target, {
    [PASSWORD_ENVIRONMENT_FIELD]: OLD_PASSWORD,
    [PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD]: OLD_PASSWORD,
  });
  await assert.rejects(
    runReleaseQaCredentialRotationCommand({
      argv: commandArguments(target),
      env: unchangedEnvironment,
      output: { log() { assert.fail("unchanged password must not log"); } },
      now: () => CREATED_AT_MS + 1_000_000,
      createPasswordHasher: fastPasswordHasher,
    }),
    (error) => error.code === ERROR_CODES.passwordUnchanged
  );
  assert.equal(
    Object.hasOwn(unchangedEnvironment, PASSWORD_ENVIRONMENT_FIELD),
    false
  );
  assert.equal(
    Object.hasOwn(
      unchangedEnvironment,
      PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD
    ),
    false
  );
  const unchangedAfterConnection = openTestDatabase(target);
  assert.deepEqual(
    querySecurityProjection(unchangedAfterConnection.database),
    before
  );
  unchangedAfterConnection.database.close();

  const invalidArgumentEnvironment = environment(target);
  await assert.rejects(
    runReleaseQaCredentialRotationCommand({
      argv: ["--password", NEW_PASSWORD],
      env: invalidArgumentEnvironment,
      output: { log() { assert.fail("invalid arguments must not log"); } },
    }),
    (error) => error.code === COMMAND_ERROR_CODES.argumentInvalid
  );
  assert.equal(
    Object.hasOwn(invalidArgumentEnvironment, PASSWORD_ENVIRONMENT_FIELD),
    false
  );
  assert.equal(
    Object.hasOwn(
      invalidArgumentEnvironment,
      PASSWORD_CONFIRMATION_ENVIRONMENT_FIELD
    ),
    false
  );
});

test("identity, schema, account, email, and physical-target mismatch gates are zero-write", async (t) => {
  const cases = [
    {
      name: "identity",
      mutate(database) {
        database.prepare(`
          UPDATE application_metadata
          SET metadata_value = 'other:environment'
          WHERE metadata_key = 'environment_id'
        `).run();
      },
      code: COMMAND_ERROR_CODES.identityMismatch,
    },
    {
      name: "schema",
      mutate(database) {
        database.pragma("user_version = 53");
      },
      code: COMMAND_ERROR_CODES.schemaUnsupported,
    },
    {
      name: "account-id",
      mutate(database) {
        database.prepare("DELETE FROM users WHERE id = ?").run(
          fixtureAccounts()[0].userId
        );
      },
      code: ERROR_CODES.fixtureInvalid,
    },
    {
      name: "account-email",
      mutate(database) {
        database.prepare(`
          UPDATE users
          SET email_normalized = 'changed@example.test',
              email_display = 'changed@example.test'
          WHERE id = ?
        `).run(fixtureAccounts()[0].userId);
      },
      code: ERROR_CODES.fixtureInvalid,
    },
    {
      name: "account-status",
      mutate(database) {
        database.prepare(`
          UPDATE users
          SET status = 'deactivated'
          WHERE id = ?
        `).run(fixtureAccounts()[0].userId);
      },
      code: ERROR_CODES.fixtureInvalid,
    },
  ];
  for (const candidate of cases) {
    const target = await createFixtureDatabase(
      t,
      `rotation-mismatch-${candidate.name}`
    );
    const connection = openTestDatabase(target);
    if (candidate.name === "account-id") {
      connection.database.pragma("foreign_keys = OFF");
    }
    candidate.mutate(connection.database);
    const before = querySecurityProjection(connection.database);
    connection.database.close();
    await assert.rejects(
      runCommand(target),
      (error) => error.code === candidate.code
    );
    const afterConnection = openTestDatabase(target);
    assert.deepEqual(querySecurityProjection(afterConnection.database), before);
    afterConnection.database.close();
  }

  const target = await createFixtureDatabase(t, "rotation-outside-root");
  const wrongRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-rotation-wrong-root-")
  );
  t.after(() => fs.rmSync(wrongRoot, { recursive: true, force: true }));
  await assert.rejects(
    runReleaseQaCredentialRotationCommand({
      argv: commandArguments(target, { persistentRoot: wrongRoot }),
      env: environment(target, { PERSISTENT_DATA_ROOT: wrongRoot }),
      output: { log() { assert.fail("unsafe target must not log"); } },
      createPasswordHasher: fastPasswordHasher,
    }),
    (error) => error.code === COMMAND_ERROR_CODES.targetUnsafe
  );

  const symlinkTarget = await createFixtureDatabase(
    t,
    "rotation-symlink-target"
  );
  const symlinkPath = path.join(
    symlinkTarget.persistentRoot,
    "release-qa-link.sqlite3"
  );
  try {
    fs.symlinkSync(symlinkTarget.databasePath, symlinkPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.diagnostic(
        "filesystem link creation is unavailable; shared physical-target coverage remains authoritative"
      );
      return;
    }
    throw error;
  }
  await assert.rejects(
    runReleaseQaCredentialRotationCommand({
      argv: commandArguments(symlinkTarget, {
        databasePath: symlinkPath,
      }),
      env: environment(symlinkTarget, {
        DATABASE_PATH: symlinkPath,
      }),
      output: { log() { assert.fail("symlink target must not log"); } },
      createPasswordHasher: fastPasswordHasher,
    }),
    (error) => error.code === COMMAND_ERROR_CODES.targetUnsafe
  );
});

test("hash, credential, session, receipt, and postcheck failures roll every attempted credential mutation back", async (t) => {
  const phases = [
    "hash",
    "credential",
    "session",
    "receipt",
    "extra-write",
    "postcheck",
  ];
  for (const phase of phases) {
    await t.test(phase, async (t) => {
      const target = await createFixtureDatabase(
        t,
        `rotation-rollback-${phase}`
      );
      const connection = openTestDatabase(target);
      const credentials = createSqliteCredentialRepository({
        database: connection.database,
      });
      const sessions = createSqliteSessionRepository({
        database: connection.database,
      });
      const auditRepository = createSqliteSecurityAuditRepository({
        database: connection.database,
      });
      const before = querySecurityProjection(connection.database);
      const unrelatedBefore = queryUnrelatedProjection(connection.database);
      const hasher = fastPasswordHasher();
      let hashCalls = 0;
      let credentialCalls = 0;
      let sessionCalls = 0;
      let bindingCalls = 0;
      if (phase === "receipt") {
        connection.database.exec(`
          CREATE TRIGGER rotation_test_receipt_failure
          BEFORE INSERT ON security_audit_events
          WHEN NEW.event_type = '${EVENT_TYPE}'
          BEGIN
            SELECT RAISE(ABORT, 'receipt failure');
          END
        `);
      }
      if (phase === "extra-write") {
        connection.database.exec(`
          CREATE TRIGGER rotation_test_extra_write
          AFTER UPDATE ON user_credentials
          WHEN NEW.status = 'replaced'
          BEGIN
            INSERT INTO operational_events (
              id, league_id, season_id, event_type, feature, outcome,
              actor_user_id, reason_code, details_json, occurred_at_ms
            ) VALUES (
              NEW.id, NULL, NULL, 'rotation_test.extra_write',
              'release_qa', 'succeeded', NULL, NULL, NULL,
              NEW.replaced_at_ms
            );
          END
        `);
      }
      const passwordHasher = {
        verify: (...arguments_) => hasher.verify(...arguments_),
        async hash(...arguments_) {
          hashCalls += 1;
          if (phase === "hash" && hashCalls === 5) {
            throw new Error("injected hash failure");
          }
          return hasher.hash(...arguments_);
        },
      };
      const credentialRepository = {
        findActiveByUserId: (...arguments_) =>
          credentials.findActiveByUserId(...arguments_),
        replaceActive(...arguments_) {
          credentialCalls += 1;
          if (phase === "credential" && credentialCalls === 5) {
            throw new Error("injected credential failure");
          }
          return credentials.replaceActive(...arguments_);
        },
      };
      const sessionRepository = {
        findActiveByUserId: (...arguments_) =>
          sessions.findActiveByUserId(...arguments_),
        revokeActive(...arguments_) {
          sessionCalls += 1;
          if (phase === "session" && sessionCalls === 2) {
            throw new Error("injected session failure");
          }
          return sessions.revokeActive(...arguments_);
        },
      };
      await assert.rejects(
        rotateReleaseQaCredentials({
          database: connection.database,
          credentialRepository,
          sessionRepository,
          auditRepository,
          passwordHasher,
          password: NEW_PASSWORD,
          rotationId: RELEASE_ID,
          environmentId: FIXTURE_ENVIRONMENT_ID,
          databaseId: FIXTURE_DATABASE_ID,
          schemaVersion: EXPECTED_SCHEMA_VERSION,
          nowMs: CREATED_AT_MS + 1_000_000,
          assertBinding() {
            bindingCalls += 1;
            if (phase === "postcheck" && bindingCalls === 3) {
              throw new Error("injected postcheck failure");
            }
          },
        }),
        (error) =>
          error.code === ERROR_CODES.failed ||
          error.code === ERROR_CODES.dependencyInvalid ||
          error.code === ERROR_CODES.postcheckFailed
      );
      assert.equal(connection.database.inTransaction, false);
      assert.deepEqual(querySecurityProjection(connection.database), before);
      assert.deepEqual(
        queryUnrelatedProjection(connection.database),
        unrelatedBefore
      );
      assert.equal(
        connection.database.pragma("integrity_check", { simple: true }),
        "ok"
      );
      assert.deepEqual(connection.database.pragma("foreign_key_check"), []);
      connection.database.close();
    });
  }
});
