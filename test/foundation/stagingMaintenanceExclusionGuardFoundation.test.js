const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Database = require("better-sqlite3");

const {
  STAGING_MAINTENANCE_EXCLUSION_NAMES,
  StagingMaintenanceExclusionError,
  createStagingMaintenanceExclusionGuard,
} = require("../../src/application/services/operations/createStagingMaintenanceExclusionGuard");
const {
  DATABASE_IDENTITY_KEYS,
} = require("../../src/infrastructure/database/databaseIdentity");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require("../../src/operations/release/releaseQaFixtureContract");

const CREATED_AT = "2026-07-25T12:00:00.000Z";
const BASE_OPTIONS = Object.freeze({
  appEnv: "staging",
  environmentId: FIXTURE_ENVIRONMENT_ID,
  databaseId: FIXTURE_DATABASE_ID,
  leagueWriteMode: "closed",
  scheduledJobsEnabled: false,
});

function insertIdentity(database, overrides = {}) {
  const values = {
    [DATABASE_IDENTITY_KEYS.createdAt]: CREATED_AT,
    [DATABASE_IDENTITY_KEYS.databaseId]: FIXTURE_DATABASE_ID,
    [DATABASE_IDENTITY_KEYS.environmentId]: FIXTURE_ENVIRONMENT_ID,
    ...overrides,
  };
  const insert = database.prepare(
    "INSERT INTO application_metadata " +
      "(metadata_key, metadata_value) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(values)) {
    insert.run(key, value);
  }
}

function createFixtureDatabase(t, options = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-staging-maintenance-guard-")
  );
  const databasePath = path.join(directory, "fixture.sqlite3");
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE application_metadata (
      metadata_key TEXT PRIMARY KEY,
      metadata_value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE matchup_weeks (
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE matchups (
      status TEXT NOT NULL
    ) STRICT;
  `);
  insertIdentity(database, options.identity);
  for (const status of options.matchupWeekStatuses || []) {
    database
      .prepare("INSERT INTO matchup_weeks (status) VALUES (?)")
      .run(status);
  }
  for (const status of options.matchupStatuses || []) {
    database
      .prepare("INSERT INTO matchups (status) VALUES (?)")
      .run(status);
  }
  database.pragma("wal_checkpoint(TRUNCATE)");
  t.after(() => {
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { database, databasePath };
}

function guard(database, overrides = {}) {
  return createStagingMaintenanceExclusionGuard({
    ...BASE_OPTIONS,
    database,
    ...overrides,
  });
}

function isGuardError(code) {
  return (error) =>
    error instanceof StagingMaintenanceExclusionError &&
    error.code === code;
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

test("maintenance guard names only the two exact approved exclusions", (t) => {
  const { database } = createFixtureDatabase(t);
  assert.deepEqual(STAGING_MAINTENANCE_EXCLUSION_NAMES, [
    "release_qa_fixture_reset",
    "staging_provider_catalog_import",
  ]);
  assert.equal(Object.isFrozen(STAGING_MAINTENANCE_EXCLUSION_NAMES), true);

  const exclusionGuard = guard(database);
  for (const exclusionName of STAGING_MAINTENANCE_EXCLUSION_NAMES) {
    const descriptor = exclusionGuard.assertExclusion(exclusionName);
    assert.deepEqual(descriptor, {
      exclusionName,
      status: "excluded",
    });
    assert.equal(Object.isFrozen(descriptor), true);
  }
  for (const invalidName of [
    "staging_fixture_reset",
    "provider_catalog_import",
    "release_qa_fixture_reset ",
    "RELEASE_QA_FIXTURE_RESET",
    "",
    null,
  ]) {
    assert.throws(
      () => exclusionGuard.assertExclusion(invalidName),
      isGuardError("STAGING_MAINTENANCE_EXCLUSION_NAME_INVALID")
    );
  }
});

test("maintenance guard accepts nonblocking rows and returns no state detail", (t) => {
  const { database } = createFixtureDatabase(t, {
    matchupWeekStatuses: [
      "scheduled",
      "baseline_ready",
      "awaiting_data",
      "final",
      "cancelled",
    ],
    matchupStatuses: [
      "scheduled",
      "locked",
      "awaiting_data",
      "final",
      "cancelled",
    ],
  });
  const exclusionGuard = guard(database);
  assert.equal(Object.isFrozen(exclusionGuard), true);
  assert.deepEqual(
    Object.keys(
      exclusionGuard.assertExclusion(
        "staging_provider_catalog_import"
      )
    ).sort(),
    ["exclusionName", "status"]
  );
});

for (const tableName of ["matchup_weeks", "matchups"]) {
  for (const status of ["live", "correction_required"]) {
    test(`maintenance guard rejects ${status} in ${tableName}`, (t) => {
      const options = {
        matchupWeekStatuses: ["final"],
        matchupStatuses: ["final"],
      };
      options[
        tableName === "matchup_weeks"
          ? "matchupWeekStatuses"
          : "matchupStatuses"
      ] = [status];
      const { database } = createFixtureDatabase(t, options);
      assert.throws(
        () =>
          guard(database).assertExclusion(
            "release_qa_fixture_reset"
          ),
        isGuardError("STAGING_MAINTENANCE_EXCLUSION_MATCHUP_ACTIVE")
      );
    });
  }
}

test("maintenance guard refuses every wrong static precondition", (t) => {
  const { database } = createFixtureDatabase(t);
  for (const override of [
    { appEnv: "production" },
    { appEnv: "Staging" },
    { environmentId: "test:other-environment" },
    { databaseId: "other-release-qa-database" },
    { leagueWriteMode: "open" },
    { scheduledJobsEnabled: true },
    { scheduledJobsEnabled: undefined },
  ]) {
    assert.throws(
      () => guard(database, override),
      isGuardError("STAGING_MAINTENANCE_EXCLUSION_CONFIG_INVALID")
    );
  }
});

test("maintenance guard reverifies stored release-QA identity on every assertion", (t) => {
  const { database } = createFixtureDatabase(t);
  const exclusionGuard = guard(database);
  const updateIdentity = database.prepare(
    "UPDATE application_metadata SET metadata_value = ? " +
      "WHERE metadata_key = ?"
  );
  for (const [metadataKey, invalidValue, expectedValue] of [
    [
      DATABASE_IDENTITY_KEYS.environmentId,
      "test:replacement-environment",
      FIXTURE_ENVIRONMENT_ID,
    ],
    [
      DATABASE_IDENTITY_KEYS.databaseId,
      "replacement-release-qa-database",
      FIXTURE_DATABASE_ID,
    ],
  ]) {
    assert.deepEqual(
      exclusionGuard.assertExclusion("release_qa_fixture_reset"),
      {
        exclusionName: "release_qa_fixture_reset",
        status: "excluded",
      }
    );
    updateIdentity.run(invalidValue, metadataKey);
    assert.throws(
      () => exclusionGuard.assertExclusion("release_qa_fixture_reset"),
      isGuardError("STAGING_MAINTENANCE_EXCLUSION_IDENTITY_INVALID")
    );
    updateIdentity.run(expectedValue, metadataKey);
  }
});

test("maintenance guard fails closed for missing schema and query failure", (t) => {
  const { database } = createFixtureDatabase(t);
  database.exec("DROP TABLE matchups");
  assert.throws(
    () =>
      guard(database).assertExclusion(
        "staging_provider_catalog_import"
      ),
    isGuardError("STAGING_MAINTENANCE_EXCLUSION_STATE_UNAVAILABLE")
  );

  database.exec("CREATE TABLE matchups (status TEXT NOT NULL) STRICT");
  const preparedSql = [];
  const queryFailureDatabase = {
    prepare(sql) {
      preparedSql.push(sql);
      if (/FROM\s+matchup_weeks/i.test(sql)) {
        throw new Error("injected matchup-week query failure");
      }
      return database.prepare(sql);
    },
  };
  assert.throws(
    () =>
      guard(queryFailureDatabase).assertExclusion(
        "release_qa_fixture_reset"
      ),
    isGuardError("STAGING_MAINTENANCE_EXCLUSION_STATE_UNAVAILABLE")
  );
  assert.equal(
    preparedSql.some((sql) => /FROM\s+matchup_weeks/i.test(sql)),
    true
  );
  assert.equal(
    preparedSql.some((sql) => /FROM\s+matchups/i.test(sql)),
    true
  );
});

test("maintenance guard fails closed for malformed query results", (t) => {
  const { database } = createFixtureDatabase(t);
  for (const malformedRow of [
    undefined,
    null,
    [],
    {},
    { blocking_count: "0" },
    { blocking_count: -1 },
    { blocking_count: 0, extra: true },
  ]) {
    const malformedDatabase = {
      prepare(sql) {
        if (/FROM\s+matchups/i.test(sql)) {
          return { get: () => malformedRow };
        }
        return database.prepare(sql);
      },
    };
    assert.throws(
      () =>
        guard(malformedDatabase).assertExclusion(
          "staging_provider_catalog_import"
        ),
      isGuardError("STAGING_MAINTENANCE_EXCLUSION_STATE_UNAVAILABLE")
    );
  }
});

test("maintenance exclusion assertion preserves database bytes exactly", (t) => {
  const { database, databasePath } = createFixtureDatabase(t, {
    matchupWeekStatuses: ["final"],
    matchupStatuses: ["final"],
  });
  const changesBefore = database
    .prepare("SELECT total_changes() AS count")
    .get().count;
  const bytesBefore = sha256(databasePath);

  const exclusionGuard = guard(database);
  for (const exclusionName of STAGING_MAINTENANCE_EXCLUSION_NAMES) {
    exclusionGuard.assertExclusion(exclusionName);
  }

  assert.equal(sha256(databasePath), bytesBefore);
  assert.equal(
    database.prepare("SELECT total_changes() AS count").get().count,
    changesBefore
  );
});
