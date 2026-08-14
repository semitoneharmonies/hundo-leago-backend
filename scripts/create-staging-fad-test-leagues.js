"use strict";

const path = require("node:path");

const {
  assertPassword,
} = require("../src/domain/accounts/passwordPolicy");
const {
  createSecurityFoundations,
} = require("../src/bootstrap/createSecurityFoundations");
const {
  openDeployedTargetRuntime,
} = require("../src/bootstrap/openDeployedTargetRuntime");
const {
  loadTargetRuntimeConfig,
} = require("../src/config/loadTargetRuntimeConfig");
const {
  createFreeAgentDraftBrowserFixture,
} = require(
  "../src/operations/release/createFreeAgentDraftBrowserFixture"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require(
  "../src/operations/release/releaseQaFixtureContract"
);
const {
  createScryptPasswordHasher,
} = require(
  "../src/infrastructure/security/createScryptPasswordHasher"
);

const STAGING_FAD_TEST_PASSWORD_ENV =
  "STAGING_FAD_TEST_PASSWORD";

const EXPECTED_LEAGUE_IDS = Object.freeze([
  fixtureId("fad-browser-v4:league:alpha"),
  fixtureId("fad-browser-v4:league:beta"),
  fixtureId("fad-browser-v4:league:gamma"),
]);
const LEGACY_FIXTURE_LEAGUES = Object.freeze([
  Object.freeze({
    id: fixtureId("league:leagueA"),
    name: "Release QA Alpha League",
  }),
  Object.freeze({
    id: fixtureId("league:leagueB"),
    name: "Release QA Beta League",
  }),
  Object.freeze({
    id: fixtureId("fad-browser:league:alpha"),
    name: "Pre-Week 1 FAD Test - Alpha (6 Teams)",
  }),
  Object.freeze({
    id: fixtureId("fad-browser:league:beta"),
    name: "Pre-Week 1 FAD Test - Beta (10 Teams)",
  }),
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function abandonCandidate(cause) {
  const error = new Error(
    "The staging FAD candidate database must be abandoned and recreated.",
    { cause }
  );
  error.code =
    "STAGING_FAD_TEST_CANDIDATE_ABANDON_REQUIRED";
  throw error;
}

function assertFixtureIdentitiesDistinct() {
  const legacyIds = LEGACY_FIXTURE_LEAGUES.map(({ id }) => id);
  const allIds = [...EXPECTED_LEAGUE_IDS, ...legacyIds];
  if (
    EXPECTED_LEAGUE_IDS.length !== 3 ||
    legacyIds.length !== 4 ||
    new Set(allIds).size !== allIds.length
  ) {
    fail(
      "STAGING_FAD_TEST_IDENTITY_COLLISION",
      "The v4 staging fixture and exact legacy replacement identifiers must be distinct."
    );
  }
}

function assertStagingScope(config) {
  assertFixtureIdentitiesDistinct();
  if (
    config.appEnv !== "staging" ||
    config.environmentId !== FIXTURE_ENVIRONMENT_ID ||
    config.databaseId !== FIXTURE_DATABASE_ID ||
    config.leagueWriteMode !== "open" ||
    config.freeAgentDraftRoutesEnabled !== true ||
    config.scheduledJobsEnabled !== false
  ) {
    fail(
      "STAGING_FAD_TEST_SCOPE_INVALID",
      "FAD test leagues require the exact writable staging fixture runtime."
    );
  }
}

function requireStagingTestPassword(password) {
  if (typeof password !== "string") {
    fail(
      "STAGING_FAD_TEST_PASSWORD_REQUIRED",
      `FAD test account replacement requires ${STAGING_FAD_TEST_PASSWORD_ENV}.`
    );
  }
  try {
    return assertPassword(password);
  } catch {
    fail(
      "STAGING_FAD_TEST_PASSWORD_INVALID",
      "The staging FAD test password must satisfy the canonical password policy."
    );
  }
}

function assertNoPriorFixture(database) {
  const placeholders = EXPECTED_LEAGUE_IDS.map(() => "?").join(", ");
  const existing = database.prepare(`
    SELECT id
    FROM leagues
    WHERE id IN (${placeholders})
    ORDER BY id ASC
  `).all(...EXPECTED_LEAGUE_IDS);
  if (existing.length !== 0) {
    fail(
      "STAGING_FAD_TEST_ALREADY_EXISTS",
      "The deterministic staging FAD test leagues already exist or are partial."
    );
  }
}

function hideLegacyFixtures(database, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail(
      "STAGING_FAD_TEST_CLOCK_INVALID",
      "FAD test league replacement requires a safe timestamp."
    );
  }
  const find = database.prepare(`
    SELECT id, name, status, updated_at_ms
    FROM leagues
    WHERE id = ?
  `);
  const hide = database.prepare(`
    UPDATE leagues
    SET status = 'deleted',
        updated_at_ms = CASE
          WHEN updated_at_ms > @nowMs THEN updated_at_ms
          ELSE @nowMs
        END,
        version = version + 1
    WHERE id = @id AND status <> 'deleted'
  `);
  return database.transaction(() => {
    let hidden = 0;
    for (const expected of LEGACY_FIXTURE_LEAGUES) {
      const row = find.get(expected.id);
      if (!row) continue;
      if (row.name !== expected.name) {
        fail(
          "STAGING_FAD_TEST_LEGACY_IDENTITY_INVALID",
          "A known legacy fixture identifier has unexpected league identity."
        );
      }
      hidden += hide.run({
        id: expected.id,
        nowMs,
      }).changes;
    }
    return hidden;
  }).immediate();
}

function safeAccountManifest(manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !manifest.accounts ||
    typeof manifest.accounts !== "object" ||
    !manifest.leagues ||
    typeof manifest.leagues !== "object"
  ) {
    fail(
      "STAGING_FAD_TEST_MANIFEST_INVALID",
      "The FAD test fixture returned an invalid manifest."
    );
  }
  const byUserId = new Map();
  for (const [accountAlias, account] of Object.entries(
    manifest.accounts
  )) {
    if (
      typeof account?.userId !== "string" ||
      typeof account?.email !== "string"
    ) {
      fail(
        "STAGING_FAD_TEST_MANIFEST_INVALID",
        "The FAD test fixture returned an invalid account manifest."
      );
    }
    const existing = byUserId.get(account.userId) || {
      userId: account.userId,
      email: account.email,
      accountAliases: [],
      platformAdministrator: false,
      leagueAccess: new Map(),
    };
    if (existing.email !== account.email) {
      fail(
        "STAGING_FAD_TEST_MANIFEST_INVALID",
        "One FAD test account identity has conflicting email addresses."
      );
    }
    existing.accountAliases.push(accountAlias);
    existing.platformAdministrator ||=
      accountAlias === "platformAdmin";
    byUserId.set(account.userId, existing);
  }

  for (const [leagueAlias, league] of Object.entries(
    manifest.leagues
  )) {
    const platformAdministrator =
      manifest.accounts.platformAdmin;
    const platformAdministratorAccount =
      platformAdministrator
        ? byUserId.get(platformAdministrator.userId)
        : null;
    if (platformAdministratorAccount) {
      platformAdministratorAccount.leagueAccess.set(
        leagueAlias,
        {
          leagueAlias,
          leagueName: league.name,
          commissioner: false,
          managedTeamAliases: [],
        }
      );
    }
    const commissioner =
      manifest.accounts[league.commissionerAccountAlias];
    const commissionerAccount = commissioner
      ? byUserId.get(commissioner.userId)
      : null;
    if (!commissionerAccount) {
      fail(
        "STAGING_FAD_TEST_MANIFEST_INVALID",
        "A FAD test commissioner account is unavailable."
      );
    }
    commissionerAccount.leagueAccess.set(leagueAlias, {
      leagueAlias,
      leagueName: league.name,
      commissioner: true,
      managedTeamAliases: [],
    });
    for (const team of league.teams) {
      const manager =
        manifest.accounts[team.managerAccountAlias];
      const managerAccount = manager
        ? byUserId.get(manager.userId)
        : null;
      if (!managerAccount) {
        fail(
          "STAGING_FAD_TEST_MANIFEST_INVALID",
          "A FAD test manager account is unavailable."
        );
      }
      const access = managerAccount.leagueAccess.get(
        leagueAlias
      ) || {
        leagueAlias,
        leagueName: league.name,
        commissioner: false,
        managedTeamAliases: [],
      };
      access.managedTeamAliases.push(team.alias);
      managerAccount.leagueAccess.set(leagueAlias, access);
    }
  }

  return [...byUserId.values()]
    .map((account) => ({
      userId: account.userId,
      email: account.email,
      accountAliases: [...account.accountAliases].sort(),
      platformAdministrator:
        account.platformAdministrator,
      leagueAccess: [...account.leagueAccess.values()]
        .map((access) => ({
          ...access,
          managedTeamAliases: [
            ...access.managedTeamAliases,
          ].sort(),
        }))
        .sort((left, right) =>
          left.leagueAlias.localeCompare(right.leagueAlias)
        ),
    }))
    .sort((left, right) =>
      left.email.localeCompare(right.email)
    );
}

async function replaceFixtureCredentials({
  accounts,
  password,
  passwordHasher,
  credentialRepository,
  sessionRepository,
  createId,
  nowMs,
}) {
  const validatedPassword =
    requireStagingTestPassword(password);
  if (
    !Array.isArray(accounts) ||
    accounts.length === 0 ||
    new Set(accounts.map((account) => account?.userId)).size !==
      accounts.length ||
    typeof passwordHasher?.hash !== "function" ||
    typeof credentialRepository?.findActiveByUserId !==
      "function" ||
    typeof credentialRepository?.replaceActive !==
      "function" ||
    typeof sessionRepository?.findActiveByUserId !==
      "function" ||
    typeof sessionRepository?.revokeActive !== "function" ||
    typeof createId !== "function" ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    fail(
      "STAGING_FAD_TEST_CREDENTIAL_REPLACEMENT_INVALID",
      "FAD test account replacement requires complete account security dependencies."
    );
  }

  const prepared = [];
  for (const account of accounts) {
    if (
      typeof account?.userId !== "string" ||
      typeof account?.email !== "string"
    ) {
      fail(
        "STAGING_FAD_TEST_CREDENTIAL_REPLACEMENT_INVALID",
        "FAD test account replacement requires stable account identities."
      );
    }
    const currentCredential =
      credentialRepository.findActiveByUserId(
        account.userId
      );
    if (
      !currentCredential ||
      currentCredential.user_id !== account.userId ||
      currentCredential.status !== "active" ||
      !Number.isSafeInteger(
        currentCredential.created_at_ms
      ) ||
      currentCredential.created_at_ms < 0 ||
      !Number.isSafeInteger(currentCredential.version) ||
      currentCredential.version < 1
    ) {
      fail(
        "STAGING_FAD_TEST_ACTIVE_CREDENTIAL_REQUIRED",
        "Every FAD test account requires one active credential before replacement."
      );
    }
    const activeSession =
      sessionRepository.findActiveByUserId(
        account.userId
      );
    if (
      activeSession &&
      (
        activeSession.user_id !== account.userId ||
        activeSession.status !== "active" ||
        !Number.isSafeInteger(
          activeSession.created_at_ms
        ) ||
        activeSession.created_at_ms < 0 ||
        !Number.isSafeInteger(activeSession.version) ||
        activeSession.version < 1
      )
    ) {
      fail(
        "STAGING_FAD_TEST_ACTIVE_SESSION_INVALID",
        "A FAD test account has invalid active-session state."
      );
    }
    prepared.push({
      account,
      currentCredential,
      activeSession,
      passwordHash: await passwordHasher.hash(
        validatedPassword
      ),
    });
  }

  const replacedAtMs = prepared.reduce(
    (latest, item) =>
      Math.max(
        latest,
        item.currentCredential.created_at_ms,
        item.activeSession?.created_at_ms || 0
      ),
    nowMs
  );
  let revokedActiveLoginCount = 0;
  for (const item of prepared) {
    credentialRepository.replaceActive({
      currentCredentialId: item.currentCredential.id,
      expectedVersion: item.currentCredential.version,
      replacedAtMs,
      replacement: {
        id: createId(),
        user_id: item.account.userId,
        password_hash: item.passwordHash,
        algorithm: "scrypt",
        algorithm_version: 1,
        status: "active",
        created_at_ms: replacedAtMs,
        replaced_at_ms: null,
        version: 1,
      },
    });
    if (item.activeSession) {
      sessionRepository.revokeActive({
        sessionId: item.activeSession.id,
        expectedVersion: item.activeSession.version,
        changedAtMs: replacedAtMs,
        reason: "platform_security_action",
        transactionHook: null,
      });
      revokedActiveLoginCount += 1;
    }
  }

  return Object.freeze({
    rotatedAccountCount: prepared.length,
    revokedActiveLoginCount,
  });
}

async function createAndActivateFixtureCandidate({
  database,
  nowMs,
  createFixture,
  replaceCredentials,
}) {
  if (
    !database ||
    typeof database.exec !== "function" ||
    typeof createFixture !== "function" ||
    typeof replaceCredentials !== "function" ||
    database.inTransaction
  ) {
    fail(
      "STAGING_FAD_TEST_TRANSACTION_INVALID",
      "FAD test league replacement requires one unowned database transaction."
    );
  }
  assertNoPriorFixture(database);
  let manifest;
  let accounts;
  try {
    manifest = await createFixture();
    accounts = safeAccountManifest(manifest);
    if (database.inTransaction) {
      const error = new Error(
        "The FAD fixture left an owned transaction active."
      );
      error.code =
        "STAGING_FAD_TEST_FIXTURE_TRANSACTION_INVALID";
      throw error;
    }
  } catch (error) {
    let cause = error;
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        cause = new AggregateError(
          [error, rollbackError],
          "The failed FAD candidate transaction could not be closed."
        );
      }
    }
    abandonCandidate(cause);
  }

  try {
    database.exec("BEGIN IMMEDIATE");
    const credentialReplacement =
      await replaceCredentials({ accounts });
    if (
      credentialReplacement?.rotatedAccountCount !==
        accounts.length ||
      !Number.isSafeInteger(
        credentialReplacement.revokedActiveLoginCount
      ) ||
      credentialReplacement.revokedActiveLoginCount < 0 ||
      credentialReplacement.revokedActiveLoginCount >
        accounts.length
    ) {
      fail(
        "STAGING_FAD_TEST_CREDENTIAL_REPLACEMENT_INCOMPLETE",
        "Every FAD test account credential must be replaced before fixture activation."
      );
    }
    const hiddenLegacyLeagueCount = hideLegacyFixtures(
      database,
      nowMs
    );
    database.exec("COMMIT");
    return Object.freeze({
      manifest,
      hiddenLegacyLeagueCount,
      accounts,
      credentialReplacement,
    });
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        abandonCandidate(
          new AggregateError(
            [error, rollbackError],
            "The failed FAD candidate activation could not be rolled back."
          )
        );
      }
    }
    abandonCandidate(error);
  }
}

async function run({
  env = process.env,
  backendRoot = path.resolve(__dirname, ".."),
  stdout = process.stdout,
  testPassword = env[STAGING_FAD_TEST_PASSWORD_ENV],
} = {}) {
  const config = loadTargetRuntimeConfig({ env, backendRoot });
  assertStagingScope(config);
  const password =
    requireStagingTestPassword(testPassword);
  const securityFoundations = createSecurityFoundations({
    env,
    loadConfig: () => config.security,
  });
  const passwordHasher = createScryptPasswordHasher({
    secureRandom: securityFoundations.secureRandom,
  });
  const runtime = openDeployedTargetRuntime({
    config,
    securityFoundations,
  });
  try {
    const nowMs = securityFoundations.clock.nowMs();
    const replacement = await createAndActivateFixtureCandidate({
      database: runtime.database,
      nowMs,
      createFixture: () =>
        createFreeAgentDraftBrowserFixture({
          runtime,
          nowMs,
        }),
      replaceCredentials: ({ accounts }) =>
        replaceFixtureCredentials({
          accounts,
          password,
          passwordHasher,
          credentialRepository:
            runtime.repositories.credentials,
          sessionRepository:
            runtime.repositories.sessions,
          createId: () =>
            securityFoundations.secureRandom.id(),
          nowMs,
        }),
    });
    const result = Object.freeze({
      code: "STAGING_FAD_TEST_CREATED",
      credentialInputEnvironmentVariable:
        STAGING_FAD_TEST_PASSWORD_ENV,
      hiddenLegacyLeagueCount:
        replacement.hiddenLegacyLeagueCount,
      accounts: replacement.accounts,
      leagues: Object.values(replacement.manifest.leagues).map((league) => ({
        alias: league.alias,
        leagueId: league.leagueId,
        seasonId: league.seasonId,
        fadId: league.fadId,
        phase: league.phase,
        teamCount: league.teams.length,
        firstWeekStartsAtMs: league.firstWeekStartsAtMs,
      })),
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    runtime.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code:
        typeof error?.code === "string"
          ? error.code
          : "STAGING_FAD_TEST_FAILED",
      message: "The staging FAD test leagues were not created.",
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_LEAGUE_IDS,
  LEGACY_FIXTURE_LEAGUES,
  STAGING_FAD_TEST_PASSWORD_ENV,
  assertFixtureIdentitiesDistinct,
  assertNoPriorFixture,
  assertStagingScope,
  createAndActivateFixtureCandidate,
  hideLegacyFixtures,
  replaceFixtureCredentials,
  requireStagingTestPassword,
  run,
  safeAccountManifest,
};
