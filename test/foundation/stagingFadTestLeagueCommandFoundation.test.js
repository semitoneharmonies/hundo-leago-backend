"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const Database = require("better-sqlite3");

const {
  EXPECTED_LEAGUE_IDS,
  LEGACY_FIXTURE_LEAGUES,
  STAGING_FAD_TEST_PASSWORD_ENV,
  createAndActivateFixtureCandidate,
  replaceFixtureCredentials,
  requireStagingTestPassword,
  safeAccountManifest,
} = require(
  "../../scripts/create-staging-fad-test-leagues"
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
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_KEY_BYTES,
  SCRYPT_MAX_MEMORY_BYTES,
  SCRYPT_PARALLELIZATION,
  createScryptPasswordHasher,
} = require(
  "../../src/infrastructure/security/createScryptPasswordHasher"
);

const NOW_MS = 1_786_641_200_000;
const SESSION_CREATED_AT_MS = NOW_MS + 500;
const ORIGINAL_TEST_INPUT = "original fixture input";
const REPLACEMENT_TEST_INPUT = "replacement fixture input";

function manifest() {
  return {
    accounts: {
      platformAdmin: {
        userId: "10000000-0000-4000-8000-000000000001",
        email: "admin@release-qa.example.test",
      },
      alphaCommissioner: {
        userId: "10000000-0000-4000-8000-000000000002",
        email: "comm.a@release-qa.example.test",
      },
      gammaCommissioner: {
        userId: "10000000-0000-4000-8000-000000000002",
        email: "comm.a@release-qa.example.test",
      },
      sharedManager: {
        userId: "10000000-0000-4000-8000-000000000003",
        email: "manager@release-qa.example.test",
      },
    },
    leagues: {
      alpha: {
        name: "Alpha League",
        commissionerAccountAlias: "alphaCommissioner",
        teams: [
          {
            alias: "alphaTeam1",
            managerAccountAlias: "sharedManager",
          },
        ],
      },
      gamma: {
        name: "Gamma League",
        commissionerAccountAlias: "gammaCommissioner",
        teams: [
          {
            alias: "gammaTeam1",
            managerAccountAlias: "sharedManager",
          },
        ],
      },
    },
  };
}

function database() {
  const connection = new Database(":memory:");
  connection.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email_normalized TEXT NOT NULL UNIQUE,
      email_display TEXT NOT NULL,
      display_name TEXT NOT NULL,
      display_name_normalized TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE user_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      password_hash TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      algorithm_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      replaced_at_ms INTEGER,
      version INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX user_credentials_one_active_per_user
      ON user_credentials (user_id)
      WHERE status = 'active';

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      token_digest TEXT NOT NULL UNIQUE,
      csrf_secret_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      last_used_at_ms INTEGER NOT NULL,
      idle_expires_at_ms INTEGER NOT NULL,
      absolute_expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      revocation_reason TEXT,
      client_metadata_json TEXT,
      version INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX sessions_one_active_per_user
      ON sessions (user_id)
      WHERE status = 'active';

    CREATE TABLE leagues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;
  `);
  return connection;
}

function stableId(prefix, number) {
  return `${prefix}-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function createFastProductionShapeHasher() {
  let saltNumber = 0;
  return createScryptPasswordHasher({
    secureRandom: {
      bytes(size) {
        const value = Buffer.alloc(size);
        value.writeUInt32BE(++saltNumber, size - 4);
        return value;
      },
    },
    scrypt(password, salt, keyBytes, options, callback) {
      assert.equal(keyBytes, SCRYPT_KEY_BYTES);
      assert.deepEqual(options, {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY_BYTES,
      });
      const derived = crypto
        .createHash("sha256")
        .update(password, "utf8")
        .update(salt)
        .digest();
      queueMicrotask(() => callback(null, derived));
    },
  });
}

function securityRepositories(connection) {
  return {
    credentials: createSqliteCredentialRepository({
      database: connection,
    }),
    sessions: createSqliteSessionRepository({
      database: connection,
    }),
  };
}

async function seedAccountSecurity({
  connection,
  accounts,
  passwordHasher,
}) {
  const insertUser = connection.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display,
      display_name, display_name_normalized,
      status, created_at_ms, updated_at_ms, version
    ) VALUES (
      @id, @email, @email,
      @displayName, @displayNameNormalized,
      'active', 1, 1, 1
    )
  `);
  const insertCredential = connection.prepare(`
    INSERT INTO user_credentials (
      id, user_id, password_hash, algorithm,
      algorithm_version, status, created_at_ms,
      replaced_at_ms, version
    ) VALUES (
      @id, @userId, @passwordHash, 'scrypt',
      1, 'active', 1, NULL, 1
    )
  `);
  const insertSession = connection.prepare(`
    INSERT INTO sessions (
      id, user_id, token_digest, csrf_secret_digest,
      status, created_at_ms, last_used_at_ms,
      idle_expires_at_ms, absolute_expires_at_ms,
      revoked_at_ms, revocation_reason,
      client_metadata_json, version
    ) VALUES (
      @id, @userId, @tokenDigest, @csrfDigest,
      'active', @createdAtMs, @createdAtMs,
      @idleExpiresAtMs, @absoluteExpiresAtMs,
      NULL, NULL, NULL, 1
    )
  `);
  const seeded = [];
  for (const [index, account] of accounts.entries()) {
    const credentialId = stableId(
      "20000000",
      index + 1
    );
    const sessionId = stableId(
      "21000000",
      index + 1
    );
    const passwordHash = await passwordHasher.hash(
      ORIGINAL_TEST_INPUT
    );
    insertUser.run({
      id: account.userId,
      email: account.email,
      displayName: `Fixture User ${index + 1}`,
      displayNameNormalized: `fixture user ${index + 1}`,
    });
    insertCredential.run({
      id: credentialId,
      userId: account.userId,
      passwordHash,
    });
    insertSession.run({
      id: sessionId,
      userId: account.userId,
      tokenDigest: String(index + 1).padStart(64, "0"),
      csrfDigest: String(index + 101).padStart(64, "0"),
      createdAtMs: SESSION_CREATED_AT_MS,
      idleExpiresAtMs: NOW_MS + 1_000,
      absoluteExpiresAtMs: NOW_MS + 2_000,
    });
    seeded.push({
      userId: account.userId,
      credentialId,
      sessionId,
      passwordHash,
    });
  }
  return seeded;
}

function createReplacement({
  accounts,
  passwordHasher,
  repositories,
  createId,
}) {
  return replaceFixtureCredentials({
    accounts,
    password: REPLACEMENT_TEST_INPUT,
    passwordHasher,
    credentialRepository: repositories.credentials,
    sessionRepository: repositories.sessions,
    createId,
    nowMs: NOW_MS,
  });
}

function insertLegacyLeague(connection) {
  const legacy = LEGACY_FIXTURE_LEAGUES[0];
  connection.prepare(`
    INSERT INTO leagues (id, name, status, updated_at_ms, version)
    VALUES (?, ?, 'active', 1, 1)
  `).run(legacy.id, legacy.name);
  return legacy;
}

function insertFixtureLeagues(connection) {
  const insert = connection.prepare(`
    INSERT INTO leagues (id, name, status, updated_at_ms, version)
    VALUES (?, ?, 'active', ?, 1)
  `);
  ["Alpha League", "Beta League", "Gamma League"].forEach(
    (name, index) =>
      insert.run(EXPECTED_LEAGUE_IDS[index], name, NOW_MS)
  );
}

async function candidateState(t) {
  const connection = database();
  t.after(() => connection.close());
  const legacy = insertLegacyLeague(connection);
  const fixtureManifest = manifest();
  const accounts = safeAccountManifest(fixtureManifest);
  const passwordHasher =
    createFastProductionShapeHasher();
  const repositories =
    securityRepositories(connection);
  const originalSecurity = await seedAccountSecurity({
    connection,
    accounts,
    passwordHasher,
  });
  return {
    accounts,
    connection,
    fixtureManifest,
    legacy,
    originalSecurity,
    passwordHasher,
    repositories,
  };
}

function assertOriginalSecurity(
  repositories,
  originalSecurity
) {
  for (const original of originalSecurity) {
    assert.deepEqual(
      repositories.credentials.findActiveByUserId(
        original.userId
      ),
      {
        id: original.credentialId,
        user_id: original.userId,
        password_hash: original.passwordHash,
        algorithm: "scrypt",
        algorithm_version: 1,
        status: "active",
        created_at_ms: 1,
        replaced_at_ms: null,
        version: 1,
      }
    );
    assert.equal(
      repositories.sessions.findActiveByUserId(
        original.userId
      )?.id,
      original.sessionId
    );
  }
}

test("failed staging FAD fixture construction abandons the partial candidate before activation and blocks in-place retry", async (t) => {
  const state = await candidateState(t);
  let credentialReplacementCalled = false;
  await assert.rejects(
    createAndActivateFixtureCandidate({
      database: state.connection,
      nowMs: NOW_MS,
      createFixture: async () => {
        state.connection.prepare(`
          INSERT INTO leagues (id, name, status, updated_at_ms, version)
          VALUES (?, 'Alpha League', 'active', ?, 1)
        `).run(EXPECTED_LEAGUE_IDS[0], NOW_MS);
        const error = new Error("synthetic fixture lifecycle failure");
        error.code = "SYNTHETIC_FIXTURE_LIFECYCLE_FAILED";
        throw error;
      },
      replaceCredentials: async () => {
        credentialReplacementCalled = true;
      },
    }),
    (error) =>
      error.code ===
        "STAGING_FAD_TEST_CANDIDATE_ABANDON_REQUIRED" &&
      error.cause?.code ===
        "SYNTHETIC_FIXTURE_LIFECYCLE_FAILED"
  );
  assert.equal(state.connection.inTransaction, false);
  assert.equal(credentialReplacementCalled, false);
  assert.deepEqual(
    state.connection.prepare(`
      SELECT id, status, version
      FROM leagues
      ORDER BY id
    `).all(),
    [
      {
        id: EXPECTED_LEAGUE_IDS[0],
        status: "active",
        version: 1,
      },
      {
        id: state.legacy.id,
        status: "active",
        version: 1,
      },
    ].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  );
  assertOriginalSecurity(
    state.repositories,
    state.originalSecurity
  );

  await assert.rejects(
    createAndActivateFixtureCandidate({
      database: state.connection,
      nowMs: NOW_MS,
      createFixture: async () => {
        assert.fail(
          "an abandoned candidate must not be rebuilt in place"
        );
      },
      replaceCredentials: async () => {
        assert.fail(
          "an abandoned candidate must not be activated"
        );
      },
    }),
    (error) =>
      error.code === "STAGING_FAD_TEST_ALREADY_EXISTS"
  );
});

test("failed final staging activation rolls credentials and legacy visibility back but still requires a fresh candidate", async (t) => {
  const state = await candidateState(t);

  await assert.rejects(
    createAndActivateFixtureCandidate({
      database: state.connection,
      nowMs: NOW_MS,
      createFixture: async () => {
        insertFixtureLeagues(state.connection);
        return state.fixtureManifest;
      },
      replaceCredentials: ({ accounts: replacementAccounts }) =>
        createReplacement({
          accounts: replacementAccounts,
          passwordHasher: state.passwordHasher,
          repositories: state.repositories,
          createId: () =>
            stableId("30000000", 1),
        }),
    }),
    (error) =>
      error.code ===
        "STAGING_FAD_TEST_CANDIDATE_ABANDON_REQUIRED" &&
      error.cause instanceof Error
  );
  assert.equal(state.connection.inTransaction, false);
  assert.equal(
    state.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM leagues
      WHERE id IN (${EXPECTED_LEAGUE_IDS.map(() => "?").join(", ")})
        AND status = 'active'
    `).get(...EXPECTED_LEAGUE_IDS).count,
    3
  );
  assert.deepEqual(
    state.connection.prepare(`
      SELECT status, version FROM leagues WHERE id = ?
    `).get(state.legacy.id),
    { status: "active", version: 1 }
  );
  assertOriginalSecurity(
    state.repositories,
    state.originalSecurity
  );

  await assert.rejects(
    createAndActivateFixtureCandidate({
      database: state.connection,
      nowMs: NOW_MS,
      createFixture: async () => state.fixtureManifest,
      replaceCredentials: async () => {
        assert.fail(
          "an abandoned candidate must not be activated"
        );
      },
    }),
    (error) =>
      error.code === "STAGING_FAD_TEST_ALREADY_EXISTS"
  );
});

test("a fresh staging FAD candidate atomically rotates credentials, revokes logins, and hides legacy leagues", async (t) => {
  const state = await candidateState(t);
  let nextCredentialId = 0;
  const result = await createAndActivateFixtureCandidate({
    database: state.connection,
    nowMs: NOW_MS,
    createFixture: async () => {
      insertFixtureLeagues(state.connection);
      await Promise.resolve();
      return state.fixtureManifest;
    },
    replaceCredentials: ({ accounts: replacementAccounts }) =>
      createReplacement({
        accounts: replacementAccounts,
        passwordHasher: state.passwordHasher,
        repositories: state.repositories,
        createId: () =>
          stableId("30000000", ++nextCredentialId),
      }),
  });
  assert.equal(state.connection.inTransaction, false);
  assert.equal(result.manifest, state.fixtureManifest);
  assert.equal(result.hiddenLegacyLeagueCount, 1);
  assert.deepEqual(
    result.accounts,
    safeAccountManifest(state.fixtureManifest)
  );
  assert.deepEqual(result.credentialReplacement, {
    rotatedAccountCount: state.accounts.length,
    revokedActiveLoginCount: state.accounts.length,
  });
  assert.equal(
    state.connection.prepare(`
      SELECT COUNT(*) AS count FROM leagues
      WHERE id IN (${EXPECTED_LEAGUE_IDS.map(() => "?").join(", ")})
        AND status = 'active'
    `).get(...EXPECTED_LEAGUE_IDS).count,
    3
  );
  assert.deepEqual(
    state.connection.prepare(`
      SELECT status, version FROM leagues WHERE id = ?
    `).get(state.legacy.id),
    { status: "deleted", version: 2 }
  );
  const activeHashes = [];
  for (const original of state.originalSecurity) {
    const active =
      state.repositories.credentials.findActiveByUserId(
        original.userId
      );
    assert.notEqual(active.id, original.credentialId);
    assert.equal(active.user_id, original.userId);
    assert.equal(active.status, "active");
    assert.equal(active.version, 1);
    assert.equal(
      active.created_at_ms,
      SESSION_CREATED_AT_MS
    );
    assert.equal(
      (
        await state.passwordHasher.verify(
          REPLACEMENT_TEST_INPUT,
          active.password_hash
        )
      ).verified,
      true
    );
    assert.equal(
      (
        await state.passwordHasher.verify(
          ORIGINAL_TEST_INPUT,
          active.password_hash
        )
      ).verified,
      false
    );
    activeHashes.push(active.password_hash);
    assert.equal(
      state.repositories.sessions.findActiveByUserId(
        original.userId
      ),
      null
    );
    assert.deepEqual(
      state.connection.prepare(`
        SELECT status, revoked_at_ms, revocation_reason, version
        FROM sessions WHERE id = ?
      `).get(original.sessionId),
      {
        status: "revoked",
        revoked_at_ms: SESSION_CREATED_AT_MS,
        revocation_reason: "platform_security_action",
        version: 2,
      }
    );
    assert.deepEqual(
      state.connection.prepare(`
        SELECT status, replaced_at_ms, version
        FROM user_credentials WHERE id = ?
      `).get(original.credentialId),
      {
        status: "replaced",
        replaced_at_ms: SESSION_CREATED_AT_MS,
        version: 2,
      }
    );
  }
  assert.equal(
    new Set(activeHashes).size,
    state.accounts.length
  );
});

test("staging FAD password input is explicit and uses the canonical exact-value policy", () => {
  assert.equal(
    requireStagingTestPassword("  exact Unicode value 🏒"),
    "  exact Unicode value 🏒"
  );
  assert.throws(
    () => requireStagingTestPassword(undefined),
    (error) =>
      error.code === "STAGING_FAD_TEST_PASSWORD_REQUIRED"
  );
  for (const invalid of [
    "short",
    "x".repeat(257),
    "\ud800aaaaaa",
  ]) {
    assert.throws(
      () => requireStagingTestPassword(invalid),
      (error) =>
        error.code === "STAGING_FAD_TEST_PASSWORD_INVALID"
    );
  }
});

test("safe staging account output consolidates reused identities and contains no secret fields", () => {
  const accounts = safeAccountManifest(manifest());
  assert.deepEqual(accounts, [
    {
      userId: "10000000-0000-4000-8000-000000000001",
      email: "admin@release-qa.example.test",
      accountAliases: ["platformAdmin"],
      platformAdministrator: true,
      leagueAccess: [
        {
          leagueAlias: "alpha",
          leagueName: "Alpha League",
          commissioner: false,
          managedTeamAliases: [],
        },
        {
          leagueAlias: "gamma",
          leagueName: "Gamma League",
          commissioner: false,
          managedTeamAliases: [],
        },
      ],
    },
    {
      userId: "10000000-0000-4000-8000-000000000002",
      email: "comm.a@release-qa.example.test",
      accountAliases: ["alphaCommissioner", "gammaCommissioner"],
      platformAdministrator: false,
      leagueAccess: [
        {
          leagueAlias: "alpha",
          leagueName: "Alpha League",
          commissioner: true,
          managedTeamAliases: [],
        },
        {
          leagueAlias: "gamma",
          leagueName: "Gamma League",
          commissioner: true,
          managedTeamAliases: [],
        },
      ],
    },
    {
      userId: "10000000-0000-4000-8000-000000000003",
      email: "manager@release-qa.example.test",
      accountAliases: ["sharedManager"],
      platformAdministrator: false,
      leagueAccess: [
        {
          leagueAlias: "alpha",
          leagueName: "Alpha League",
          commissioner: false,
          managedTeamAliases: ["alphaTeam1"],
        },
        {
          leagueAlias: "gamma",
          leagueName: "Gamma League",
          commissioner: false,
          managedTeamAliases: ["gammaTeam1"],
        },
      ],
    },
  ]);
  assert.equal(
    /password|hash|token|session|secret/iu.test(
      JSON.stringify(accounts)
    ),
    false
  );
  const publicResult = {
    code: "STAGING_FAD_TEST_CREATED",
    credentialInputEnvironmentVariable:
      STAGING_FAD_TEST_PASSWORD_ENV,
    accounts,
    leagues: [
      { alias: "alpha", name: "Alpha League" },
      { alias: "gamma", name: "Gamma League" },
    ],
  };
  assert.equal(
    publicResult.credentialInputEnvironmentVariable,
    "STAGING_FAD_TEST_PASSWORD"
  );
  const {
    credentialInputEnvironmentVariable,
    ...safeOutput
  } = publicResult;
  assert.equal(
    typeof credentialInputEnvironmentVariable,
    "string"
  );
  assert.equal(
    /password|hash|token|session|secret/iu.test(
      JSON.stringify(safeOutput)
    ),
    false
  );
  assert.equal(
    JSON.stringify(publicResult).includes(
      REPLACEMENT_TEST_INPUT
    ),
    false
  );
});
