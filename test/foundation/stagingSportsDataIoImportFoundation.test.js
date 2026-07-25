const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONFIRMATION,
  EVENT_TYPE,
  OPERATION,
  StagingSportsDataIoImportError,
  createStagingSportsDataIoImportService,
} = require(
  "../../src/application/services/operations/createStagingSportsDataIoImportService"
);
const {
  DATABASE_IDENTITY_KEYS,
} = require("../../src/infrastructure/database/databaseIdentity");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  PROVIDER_NAME,
} = require("../../src/infrastructure/sportsdataio/SportsDataIoNhlAdapter");
const {
  createReleaseQaFixture,
} = require("../../src/operations/release/createReleaseQaFixture");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_NOW_MS,
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const ADMIN_ROLE_ID = "00000000-0000-4000-8000-000000000199";
const REFRESH_ID = "00000000-0000-4000-8000-000000000299";

async function runtime(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-staging-provider-import-")
  );
  const databasePath = path.join(root, "m7-release-qa.sqlite3");
  await createReleaseQaFixture({
    databasePath,
    environment: "test",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: "hundo",
    temporaryRoot: root,
  });
  const connection = openDatabase({
    databasePath,
    environment: "staging",
    persistentRoot: root,
    requirePersistentRoot: true,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return connection.database;
}

function authority(overrides = {}) {
  return {
    actorUserId: fixtureId("account:platformAdmin"),
    authority: "platform_administrator",
    roleId: ADMIN_ROLE_ID,
    roleVersion: 1,
    userVersion: 1,
    ...overrides,
  };
}

function importedResult() {
  return {
    provider: PROVIDER_NAME,
    catalog: {
      createdPlayerCount: 800,
      updatedPlayerCount: 0,
      sourceStateChangeCount: 800,
    },
    statistics: {
      refreshId: REFRESH_ID,
      status: "succeeded",
      playerCount: 800,
      sourceVersion: "last-season-2025",
    },
  };
}

function request(key, reason = "Populate deterministic staging player data.") {
  return {
    input: {
      confirmation: CONFIRMATION,
      reason,
    },
    idempotencyKey: key,
    authenticated: { valid: true },
  };
}

function service(database, overrides = {}) {
  let time = FIXTURE_NOW_MS + 100_000;
  return createStagingSportsDataIoImportService({
    database,
    appEnv: "staging",
    environmentId: FIXTURE_ENVIRONMENT_ID,
    databaseId: FIXTURE_DATABASE_ID,
    leagueWriteMode: "closed",
    scheduledJobsEnabled: false,
    providerEnabled: true,
    platformAuthorization: {
      requireAdministrator() {
        return authority();
      },
    },
    importService: {
      async importLastSeason() {
        return importedResult();
      },
    },
    clock: {
      nowMs() {
        time += 1;
        return time;
      },
    },
    ...overrides,
  });
}

test("staging SportsDataIO import is constructed only for the exact closed fixture target", async (t) => {
  const database = await runtime(t);
  for (const override of [
    { appEnv: "production" },
    { environmentId: "another-environment" },
    { databaseId: "another-database" },
    { leagueWriteMode: "open" },
    { scheduledJobsEnabled: true },
    { providerEnabled: false },
  ]) {
    assert.throws(
      () => service(database, override),
      /requires the exact closed release-QA staging target/
    );
  }
});

test("staging SportsDataIO import revalidates authority, audits success, and replays idempotently", async (t) => {
  const database = await runtime(t);
  let authorizationCalls = 0;
  let importCalls = 0;
  const target = service(database, {
    platformAuthorization: {
      requireAdministrator(authenticated) {
        authorizationCalls += 1;
        assert.equal(authenticated.valid, true);
        return authority();
      },
    },
    importService: {
      async importLastSeason({ authorizePersist }) {
        importCalls += 1;
        await authorizePersist();
        await authorizePersist();
        return importedResult();
      },
    },
  });

  const result = await target.run(request("provider-import-one"));
  assert.equal(result.code, "STAGING_SPORTSDATAIO_IMPORT_COMPLETED");
  assert.equal(result.provider, PROVIDER_NAME);
  assert.equal(result.catalog.createdPlayerCount, 800);
  assert.equal(result.statistics.playerCount, 800);
  assert.equal(importCalls, 1);
  assert.equal(authorizationCalls, 4);

  const event = database.prepare(`
    SELECT outcome, actor_user_id, details_json
    FROM operational_events
    WHERE event_type = ?
  `).get(EVENT_TYPE);
  assert.equal(event.outcome, "succeeded");
  assert.equal(event.actor_user_id, fixtureId("account:platformAdmin"));
  const details = JSON.parse(event.details_json);
  assert.equal(
    details.audit.reason,
    "Populate deterministic staging player data."
  );
  assert.equal(details.result.code, result.code);
  assert.equal(Object.hasOwn(details.result, "reason"), false);
  assert.deepEqual(
    database.prepare(`
      SELECT operation, status, result_type
      FROM idempotency_requests
      WHERE league_id IS NULL AND client_key = ?
    `).get("provider-import-one"),
    {
      operation: OPERATION,
      status: "completed",
      result_type: "operational_event",
    }
  );

  assert.deepEqual(
    await target.run(request("provider-import-one")),
    { ...result, replayed: true }
  );
  assert.equal(importCalls, 1);
});

test("staging SportsDataIO import rejects changed authority without success state and records only a sanitized failure", async (t) => {
  const database = await runtime(t);
  let authorizationCalls = 0;
  const target = service(database, {
    platformAuthorization: {
      requireAdministrator() {
        authorizationCalls += 1;
        return authority({
          roleVersion: authorizationCalls === 1 ? 1 : 2,
        });
      },
    },
    importService: {
      async importLastSeason({ authorizePersist }) {
        await authorizePersist();
        throw new Error("must not continue");
      },
    },
  });

  await assert.rejects(
    target.run(request("provider-import-authority-change")),
    (error) =>
      error instanceof StagingSportsDataIoImportError &&
      error.code ===
        "STAGING_SPORTSDATAIO_IMPORT_AUTHORITY_CHANGED"
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM idempotency_requests
      WHERE operation = ?
    `).get(OPERATION).count,
    0
  );
  const failure = database.prepare(`
    SELECT outcome, details_json
    FROM operational_events
    WHERE event_type = ?
  `).get(EVENT_TYPE);
  assert.equal(failure.outcome, "failed");
  assert.deepEqual(
    JSON.parse(failure.details_json).error,
    {
      code: "STAGING_SPORTSDATAIO_IMPORT_AUTHORITY_CHANGED",
    }
  );
  assert.equal(
    failure.details_json.includes("must not continue"),
    false
  );
});

test("staging SportsDataIO import rechecks identity after provider waits and serializes concurrent runs", async (t) => {
  const database = await runtime(t);
  let releaseImport;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseImport = resolve;
  });
  const target = service(database, {
    importService: {
      async importLastSeason({ authorizePersist }) {
        await authorizePersist();
        markStarted();
        await blocked;
        await authorizePersist();
        return importedResult();
      },
    },
  });

  const first = target.run(request("provider-import-concurrent-one"));
  await started;
  await assert.rejects(
    target.run(request("provider-import-concurrent-two")),
    (error) =>
      error instanceof StagingSportsDataIoImportError &&
      error.code === "STAGING_SPORTSDATAIO_IMPORT_IN_PROGRESS"
  );
  releaseImport();
  await first;

  const identityTarget = service(database, {
    importService: {
      async importLastSeason({ authorizePersist }) {
        database.prepare(`
          UPDATE application_metadata
          SET metadata_value = 'wrong-database'
          WHERE metadata_key = ?
        `).run(DATABASE_IDENTITY_KEYS.databaseId);
        await authorizePersist();
        return importedResult();
      },
    },
  });
  await assert.rejects(
    identityTarget.run(request("provider-import-identity-change")),
    (error) =>
      error instanceof StagingSportsDataIoImportError &&
      error.code ===
        "STAGING_SPORTSDATAIO_IMPORT_IDENTITY_MISMATCH"
  );
  database.prepare(`
    UPDATE application_metadata
    SET metadata_value = ?
    WHERE metadata_key = ?
  `).run(FIXTURE_DATABASE_ID, DATABASE_IDENTITY_KEYS.databaseId);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM idempotency_requests
      WHERE client_key = 'provider-import-identity-change'
    `).get().count,
    0
  );
});
