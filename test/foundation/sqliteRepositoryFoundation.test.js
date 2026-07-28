const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_ERROR_CODES,
} = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");
const {
  REPOSITORY_CATALOG,
  REPOSITORY_SCOPES,
  validateRepositoryCatalog,
} = require("../../src/infrastructure/persistence/sqlite/repositoryCatalog");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function assertRepositoryError(code) {
  return (error) => error?.code === code;
}

function createTemporaryDatabase(
  t,
  prefix,
  {
    migrate = true,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "repository.sqlite3"),
    environment: "test",
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  if (migrate) {
    migrateDatabase({
      database: connection.database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      applicationBuildId: "m2-05-repository-test",
    });
  }

  return {
    ...connection,
    context: migrate
      ? createSqliteRepositoryContext({
          database: connection.database,
        })
      : null,
    temporaryRoot,
  };
}

function userRecord(
  id,
  email,
  displayName,
  overrides = {}
) {
  return {
    id,
    email_normalized: email,
    email_display: email,
    display_name: displayName,
    display_name_normalized: displayName.toLowerCase(),
    status: "active",
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function leagueRecord(id, name, overrides = {}) {
  return {
    id,
    name,
    name_normalized: name.toLowerCase(),
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function seasonRecord(
  id,
  leagueId,
  label,
  overrides = {}
) {
  return {
    id,
    league_id: leagueId,
    label,
    nhl_season_key: label.toLowerCase().replaceAll(" ", "-"),
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function teamRecord(
  id,
  leagueId,
  name,
  overrides = {}
) {
  return {
    id,
    league_id: leagueId,
    name,
    name_normalized: name.toLowerCase(),
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function seedTwoLeagues(repositories) {
  const ids = {
    userA: uuid(1),
    userB: uuid(2),
    leagueA: uuid(10),
    leagueB: uuid(11),
    seasonA: uuid(20),
    seasonB: uuid(21),
    teamA: uuid(30),
    teamB: uuid(31),
  };

  repositories.users.insert(
    userRecord(ids.userA, "a@example.test", "Alpha")
  );
  repositories.users.insert(
    userRecord(ids.userB, "b@example.test", "Bravo")
  );
  repositories.leagues.insert(
    leagueRecord(ids.leagueA, "League Alpha")
  );
  repositories.leagues.insert(
    leagueRecord(ids.leagueB, "League Bravo")
  );
  repositories.seasons.insert(
    seasonRecord(ids.seasonA, ids.leagueA, "Season A")
  );
  repositories.seasons.insert(
    seasonRecord(ids.seasonB, ids.leagueB, "Season B")
  );
  repositories.teams.insert(
    teamRecord(ids.teamA, ids.leagueA, "Team Alpha")
  );
  repositories.teams.insert(
    teamRecord(ids.teamB, ids.leagueB, "Team Bravo")
  );

  return ids;
}

function collectRepositoryDatabaseArtifacts() {
  const artifacts = [];
  const skippedDirectories = new Set([".git", "node_modules"]);
  const databaseFilePattern =
    /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i;

  function walk(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (databaseFilePattern.test(entry.name)) {
        artifacts.push(path.relative(ROOT_DIRECTORY, entryPath));
      }
    }
  }

  walk(ROOT_DIRECTORY);
  return artifacts.sort();
}

describe("M2-05 SQLite repository foundation", () => {
  test("catalogs every application table with schema-exact scope, key, and version metadata", (t) => {
    const { database, context } = createTemporaryDatabase(
      t,
      "hundo-leago-m2-05-catalog-"
    );
    const actualTables = database
      .prepare(
        "SELECT name FROM sqlite_schema " +
          "WHERE type = ? AND name NOT LIKE ? AND name <> ? " +
          "ORDER BY name ASC"
      )
      .all("table", "sqlite_%", "schema_migrations")
      .map(({ name }) => name);
    const catalogTables = REPOSITORY_CATALOG.map(
      ({ tableName }) => tableName
    ).sort();

    assert.equal(REPOSITORY_CATALOG.length, 79);
    assert.equal(Object.isFrozen(REPOSITORY_CATALOG), true);
    assert.equal(
      REPOSITORY_CATALOG.every(Object.isFrozen),
      true
    );
    assert.deepEqual(catalogTables, actualTables);
    assert.deepEqual(context.schemaTables, actualTables);
    assert.equal(Object.keys(context.repositories).length, 79);
    assert.equal(Object.isFrozen(context.repositories), true);
    assert.equal(Object.isFrozen(context), true);

    for (const definition of REPOSITORY_CATALOG) {
      const columns = database.pragma(
        `table_info(${definition.tableName})`
      );
      const leagueColumn = columns.find(
        ({ name }) => name === "league_id"
      );
      const keyColumn = columns.find(
        ({ name }) => name === definition.keyColumn
      );

      assert.ok(keyColumn?.pk > 0, definition.tableName);
      assert.equal(
        columns.some(({ name }) => name === "version"),
        definition.versioned,
        definition.tableName
      );
      if (definition.scope === REPOSITORY_SCOPES.global) {
        assert.equal(leagueColumn, undefined, definition.tableName);
      } else if (
        definition.scope === REPOSITORY_SCOPES.requiredLeague
      ) {
        assert.equal(
          leagueColumn?.notnull,
          1,
          definition.tableName
        );
      } else {
        assert.equal(
          leagueColumn?.notnull,
          0,
          definition.tableName
        );
      }
    }

    assert.throws(
      () => validateRepositoryCatalog([]),
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.catalogInvalid
      )
    );
    assert.throws(
      () => {
        validateRepositoryCatalog([
          {
            tableName: "users",
            keyColumn: "id",
            scope: REPOSITORY_SCOPES.global,
            versioned: true,
          },
          {
            tableName: "users",
            keyColumn: "id",
            scope: REPOSITORY_SCOPES.global,
            versioned: true,
          },
        ]);
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.catalogInvalid
      )
    );
    assert.throws(
      () => {
        validateRepositoryCatalog([
          {
            tableName: "unsafe-table",
            keyColumn: "id",
            scope: "unknown",
            versioned: "yes",
          },
        ]);
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.catalogInvalid
      )
    );
  });

  test("fails closed when the catalog and database schema differ", (t) => {
    const empty = createTemporaryDatabase(
      t,
      "hundo-leago-m2-05-empty-schema-",
      { migrate: false }
    );
    assert.throws(
      () => {
        createSqliteRepositoryContext({
          database: empty.database,
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible
      )
    );

    const migrated = createTemporaryDatabase(
      t,
      "hundo-leago-m2-05-extra-schema-"
    );
    migrated.database.exec(
      "CREATE TABLE unexpected_table " +
        "(id TEXT PRIMARY KEY) STRICT;"
    );
    assert.throws(
      () => {
        createSqliteRepositoryContext({
          database: migrated.database,
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible
      )
    );
  });

  test("keeps global, required-league, optional-league, and settings reads explicitly scoped", (t) => {
    const { database, context } = createTemporaryDatabase(
      t,
      "hundo-leago-m2-05-scope-"
    );
    const { repositories } = context;
    const ids = seedTwoLeagues(repositories);

    const metadata =
      repositories.application_metadata.findByKey({
        key: "data_model_version",
      });
    assert.equal(metadata.metadata_value, "22");
    assert.equal(
      typeof repositories.application_metadata.listAll,
      "function"
    );
    assert.equal(
      repositories.application_metadata.listByLeague,
      undefined
    );

    assert.equal(
      repositories.seasons.findByKey({
        key: ids.seasonA,
        leagueId: ids.leagueA,
      }).label,
      "Season A"
    );
    assert.equal(
      repositories.seasons.findByKey({
        key: ids.seasonA,
        leagueId: ids.leagueB,
      }),
      null
    );
    assert.deepEqual(
      repositories.teams
        .listByLeague({ leagueId: ids.leagueA })
        .map(({ id }) => id),
      [ids.teamA]
    );
    assert.deepEqual(
      repositories.teams
        .listByLeague({ leagueId: ids.leagueB })
        .map(({ id }) => id),
      [ids.teamB]
    );
    assert.equal(repositories.teams.listAll, undefined);
    assert.throws(
      () => {
        repositories.seasons.findByKey({
          key: ids.seasonA,
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.scopeRequired
      )
    );

    repositories.operational_events.insert({
      id: uuid(40),
      league_id: null,
      season_id: null,
      event_type: "global_event",
      feature: "repository_test",
      outcome: "ok",
      actor_user_id: null,
      reason_code: null,
      details_json: null,
      occurred_at_ms: 1_000,
    });
    repositories.operational_events.insert({
      id: uuid(41),
      league_id: ids.leagueA,
      season_id: ids.seasonA,
      event_type: "league_event",
      feature: "repository_test",
      outcome: "ok",
      actor_user_id: ids.userA,
      reason_code: null,
      details_json: null,
      occurred_at_ms: 1_000,
    });
    assert.equal(
      repositories.operational_events.findByKey({
        key: uuid(40),
        leagueId: null,
      }).event_type,
      "global_event"
    );
    assert.equal(
      repositories.operational_events.findByKey({
        key: uuid(41),
        leagueId: ids.leagueA,
      }).event_type,
      "league_event"
    );
    assert.equal(
      repositories.operational_events.findByKey({
        key: uuid(41),
        leagueId: null,
      }),
      null
    );
    assert.throws(
      () => {
        repositories.operational_events.findByKey({
          key: uuid(40),
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.scopeRequired
      )
    );

    repositories.league_settings.insert({
      league_id: ids.leagueA,
      salary_cap_cents: 100_000,
      trade_deadline_at_ms: null,
      maximum_teams: 4,
      active_forward_slots: 12,
      active_defence_slots: 6,
      bench_slots: 4,
      maximum_bench_aav_cents: 400,
      injured_reserve_slots: 4,
      prospect_slots_unlimited: 1,
      scoring_rule_version: 1,
      standings_rule_version: 1,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
    assert.equal(
      repositories.league_settings.findByKey({
        key: ids.leagueA,
        leagueId: ids.leagueA,
      }).salary_cap_cents,
      100_000
    );
    assert.equal(
      repositories.league_settings.findByKey({
        key: ids.leagueA,
        leagueId: ids.leagueB,
      }),
      null
    );

    const totalChangesBefore = database
      .prepare("SELECT total_changes() AS value")
      .get().value;
    const dataVersionBefore = database.pragma("data_version", {
      simple: true,
    });
    const teamsBefore = database
      .prepare("SELECT * FROM teams ORDER BY id")
      .all();
    const returned = repositories.teams.requireByKey({
      key: ids.teamA,
      leagueId: ids.leagueA,
    });
    returned.name = "Mutated Caller Copy";
    repositories.teams.listByLeague({
      leagueId: ids.leagueA,
    });

    assert.equal(
      database.prepare("SELECT total_changes() AS value").get()
        .value,
      totalChangesBefore
    );
    assert.equal(
      database.pragma("data_version", { simple: true }),
      dataVersionBefore
    );
    assert.deepEqual(
      database.prepare("SELECT * FROM teams ORDER BY id").all(),
      teamsBefore
    );
    assert.equal(
      repositories.teams.requireByKey({
        key: ids.teamA,
        leagueId: ids.leagueA,
      }).name,
      "Team Alpha"
    );
  });

  test("validates insert fields and values and maps database constraints", (t) => {
    const { context } = createTemporaryDatabase(
      t,
      "hundo-leago-m2-05-insert-"
    );
    const { repositories } = context;
    const user = userRecord(
      uuid(50),
      "insert@example.test",
      "Insert"
    );
    const inserted = repositories.users.insert(user);

    assert.deepEqual(inserted, user);
    assert.throws(
      () => {
        repositories.users.insert({
          ...userRecord(
            uuid(51),
            "other@example.test",
            "Other"
          ),
          unknown_field: "unsafe",
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        repositories.users.insert(
          userRecord(
            uuid(52),
            "unsafe@example.test",
            "Unsafe",
            { created_at_ms: Number.MAX_SAFE_INTEGER + 1 }
          )
        );
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        repositories.users.insert(
          userRecord(
            uuid(53),
            "boolean@example.test",
            "Boolean",
            { version: true }
          )
        );
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        repositories.users.insert(
          userRecord(
            uuid(54),
            "insert@example.test",
            "Duplicate"
          )
        );
      },
      (error) => {
        return (
          error?.code === REPOSITORY_ERROR_CODES.constraint &&
          error.cause?.code?.startsWith("SQLITE_CONSTRAINT")
        );
      }
    );

    repositories.leagues.insert(
      leagueRecord(uuid(55), "Unique League")
    );
    repositories.teams.insert(
      teamRecord(uuid(56), uuid(55), "Unique Team")
    );
    assert.throws(
      () => {
        repositories.teams.insert(
          teamRecord(uuid(57), uuid(55), "Unique Team")
        );
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.constraint
      )
    );
  });

  test("increments optimistic versions once and distinguishes stale, missing, scoped, and constrained updates", (t) => {
    const { context } = createTemporaryDatabase(
      t,
      "hundo-leago-m2-05-version-"
    );
    const { repositories } = context;
    const ids = seedTwoLeagues(repositories);

    const updated = repositories.users.updateVersioned({
      key: ids.userA,
      expectedVersion: 1,
      changes: {
        display_name: "Alpha Updated",
        display_name_normalized: "alpha updated",
        updated_at_ms: 2_000,
      },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.display_name, "Alpha Updated");

    assert.throws(
      () => {
        repositories.users.updateVersioned({
          key: ids.userA,
          expectedVersion: 1,
          changes: {
            updated_at_ms: 3_000,
          },
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.versionConflict
      )
    );
    assert.throws(
      () => {
        repositories.users.updateVersioned({
          key: uuid(99),
          expectedVersion: 1,
          changes: {
            updated_at_ms: 3_000,
          },
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound
      )
    );
    assert.throws(
      () => {
        repositories.users.updateVersioned({
          key: ids.userA,
          expectedVersion: 2,
          changes: {
            version: 10,
          },
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        repositories.users.updateVersioned({
          key: ids.userA,
          expectedVersion: 2,
          changes: {
            display_name_normalized: "bravo",
          },
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.constraint
      )
    );
    assert.equal(
      repositories.users.requireByKey({
        key: ids.userA,
      }).version,
      2
    );

    assert.throws(
      () => {
        repositories.teams.updateVersioned({
          key: ids.teamA,
          leagueId: ids.leagueB,
          expectedVersion: 1,
          changes: {
            name: "Wrong Scope",
            name_normalized: "wrong scope",
            updated_at_ms: 2_000,
          },
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound
      )
    );
    assert.equal(
      repositories.teams.requireByKey({
        key: ids.teamA,
        leagueId: ids.leagueA,
      }).name,
      "Team Alpha"
    );
  });

  test("commits successful immediate work and rolls back explicit, constraint, asynchronous, and nested failures", (t) => {
    const { database, context } = createTemporaryDatabase(
      t,
      "hundo-leago-m2-05-transactions-"
    );
    const { users } = context.repositories;

    const transactionResult = context.transaction(() => {
      assert.equal(database.inTransaction, true);
      users.insert(
        userRecord(
          uuid(60),
          "commit-a@example.test",
          "Commit A"
        )
      );
      users.insert(
        userRecord(
          uuid(61),
          "commit-b@example.test",
          "Commit B"
        )
      );
      return "committed";
    });
    assert.equal(transactionResult, "committed");
    assert.equal(
      users.requireByKey({ key: uuid(60) }).email_normalized,
      "commit-a@example.test"
    );
    assert.equal(
      users.requireByKey({ key: uuid(61) }).email_normalized,
      "commit-b@example.test"
    );

    assert.throws(
      () => {
        context.transaction(() => {
          users.insert(
            userRecord(
              uuid(62),
              "rollback@example.test",
              "Rollback"
            )
          );
          throw new Error("explicit rollback");
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.operationFailed
      )
    );
    assert.equal(users.findByKey({ key: uuid(62) }), null);

    assert.throws(
      () => {
        context.transaction(() => {
          users.insert(
            userRecord(
              uuid(63),
              "constraint@example.test",
              "Constraint A"
            )
          );
          users.insert(
            userRecord(
              uuid(64),
              "constraint@example.test",
              "Constraint B"
            )
          );
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.constraint
      )
    );
    assert.equal(users.findByKey({ key: uuid(63) }), null);
    assert.equal(users.findByKey({ key: uuid(64) }), null);

    assert.throws(
      () => {
        context.transaction(() => {
          users.insert(
            userRecord(
              uuid(65),
              "async@example.test",
              "Async"
            )
          );
          return Promise.resolve("not allowed");
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.transactionAsync
      )
    );
    assert.equal(users.findByKey({ key: uuid(65) }), null);

    assert.throws(
      () => {
        context.transaction(() => {
          users.insert(
            userRecord(
              uuid(66),
              "nested-a@example.test",
              "Nested A"
            )
          );
          context.transaction(() => {
            users.insert(
              userRecord(
                uuid(67),
                "nested-b@example.test",
                "Nested B"
              )
            );
          });
          throw new Error("outer rollback");
        });
      },
      assertRepositoryError(
        REPOSITORY_ERROR_CODES.operationFailed
      )
    );
    assert.equal(users.findByKey({ key: uuid(66) }), null);
    assert.equal(users.findByKey({ key: uuid(67) }), null);

    const nestedSuccess = context.transaction(() => {
      users.insert(
        userRecord(
          uuid(68),
          "nested-c@example.test",
          "Nested C"
        )
      );
      return context.transaction(() => {
        users.insert(
          userRecord(
            uuid(69),
            "nested-d@example.test",
            "Nested D"
          )
        );
        return "nested committed";
      });
    });
    assert.equal(nestedSuccess, "nested committed");
    assert.ok(users.findByKey({ key: uuid(68) }));
    assert.ok(users.findByKey({ key: uuid(69) }));
  });

  test("does not expose raw deletion and leaves no repository database artifact", (t) => {
    const { context } = createTemporaryDatabase(
      t,
      "hundo-leago-m2-05-surface-"
    );

    for (const repository of Object.values(
      context.repositories
    )) {
      assert.equal(repository.delete, undefined);
      assert.equal(repository.remove, undefined);
      assert.equal(repository.query, undefined);
      assert.equal(repository.exec, undefined);
      assert.equal(Object.isFrozen(repository), true);
    }
    assert.deepEqual(collectRepositoryDatabaseArtifacts(), []);
  });
});
