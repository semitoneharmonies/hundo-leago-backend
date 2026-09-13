const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const CANONICAL_MIGRATIONS = path.join(
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

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function assertConstraint(callback, pattern) {
  assert.throws(callback, (error) => {
    return (
      error?.code?.startsWith("SQLITE_CONSTRAINT") &&
      (!pattern || pattern.test(error.message))
    );
  });
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    temporaryRoot,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  return {
    ...connection,
    migrationsDirectory,
  };
}

function copyMigrationsThrough(runtime, maximumId) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (migration.id > maximumId) continue;
    fs.copyFileSync(
      migration.filePath,
      path.join(
        runtime.migrationsDirectory,
        migration.fileName
      )
    );
  }
}

function migrate(runtime, buildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function seedLeague(runtime, {
  base,
  sourceSeasonKey = "20252026",
  targetSeasonKey = "20262027",
} = {}) {
  const ids = {
    user: uuid(base + 1),
    platformRole: uuid(base + 2),
    league: uuid(base + 3),
    membership: uuid(base + 4),
    sourceSeason: uuid(base + 5),
    targetSeason: uuid(base + 6),
  };
  const database = runtime.database;

  insert(database, "users", {
    id: ids.user,
    email_normalized: `admin-${base}@example.test`,
    email_display: `admin-${base}@example.test`,
    display_name: `Admin ${base}`,
    display_name_normalized: `admin ${base}`,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `League ${base}`,
    name_normalized: `league ${base}`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.sourceSeason,
    league_id: ids.league,
    label: "2025-26",
    nhl_season_key: sourceSeasonKey,
    status: "completed",
    regular_season_starts_at_ms: 100,
    regular_season_ends_at_ms: 200,
    fantasy_playoffs_start_at_ms: 170,
    fantasy_playoffs_end_at_ms: 200,
    created_at_ms: 10,
    updated_at_ms: 20,
    version: 2,
  });
  insert(database, "seasons", {
    id: ids.targetSeason,
    league_id: ids.league,
    label: "2026-27",
    nhl_season_key: targetSeasonKey,
    status: "active",
    regular_season_starts_at_ms: 300,
    regular_season_ends_at_ms: 400,
    fantasy_playoffs_start_at_ms: 370,
    fantasy_playoffs_end_at_ms: 400,
    created_at_ms: 20,
    updated_at_ms: 30,
    version: 2,
  });
  insert(database, "league_memberships", {
    id: ids.membership,
    league_id: ids.league,
    user_id: ids.user,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: 10,
    ended_at_ms: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "platform_roles", {
    id: ids.platformRole,
    user_id: ids.user,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: 10,
    ended_at_ms: null,
    version: 1,
  });
  database
    .prepare(`
      UPDATE leagues
      SET status = 'active',
          commissioner_membership_id = ?,
          current_season_id = ?,
          updated_at_ms = 30,
          version = 2
      WHERE id = ?
    `)
    .run(
      ids.membership,
      ids.targetSeason,
      ids.league
    );

  return ids;
}

function rolloverRecord(ids, overrides = {}) {
  return {
    id: uuid(800),
    league_id: ids.league,
    from_season_id: ids.sourceSeason,
    to_season_id: ids.targetSeason,
    status: "succeeded",
    authorized_by_user_id: ids.user,
    authorized_by_membership_id: ids.membership,
    authorized_authority: "commissioner",
    league_version_before: 1,
    league_version_after: 2,
    from_season_version_before: 1,
    from_season_version_after: 2,
    to_season_version_before: 1,
    to_season_version_after: 2,
    target_season_created: 0,
    completed_at_ms: 30,
    contracts_advanced: 2,
    contracts_expired: 1,
    ownerships_carried: 3,
    ownerships_released: 1,
    retention_years_advanced: 1,
    retention_obligations_completed: 0,
    buyout_years_advanced: 1,
    buyout_obligations_completed: 0,
    trades_cancelled: 1,
    created_at_ms: 30,
    version: 1,
    ...overrides,
  };
}

function insertMigrationReport(database, ids, {
  id = uuid(850),
  sourceBundleId = `bundle-${ids.league}`,
} = {}) {
  insert(database, "migration_reports", {
    id,
    league_id: ids.league,
    source_bundle_id: sourceBundleId,
    reset_manifest_id: "2026-season-1-reset-v1",
    database_schema_version: 22,
    status: "succeeded",
    source_hashes_json: '{"source":"abc"}',
    counts_json: '{"teams":4}',
    totals_json: '{"salaryCapCents":4000000}',
    warnings_json: "[]",
    rejects_json: "[]",
    started_at_ms: 20,
    completed_at_ms: 30,
    created_at_ms: 20,
  });
  return id;
}

function exemptionRecord(ids, migrationReportId, overrides = {}) {
  return {
    id: uuid(900),
    league_id: ids.league,
    season_id: ids.targetSeason,
    exemption_kind: "initial_season2_transition",
    migration_report_id: migrationReportId,
    reason: "The Entry Draft is unavailable for this transition.",
    authorized_by_user_id: ids.user,
    authorized_by_membership_id: ids.membership,
    authorized_authority:
      "platform_administrator_as_commissioner",
    authorized_at_ms: 30,
    consumed_fad_id: null,
    consumed_at_ms: null,
    created_at_ms: 30,
    updated_at_ms: 30,
    version: 1,
    ...overrides,
  };
}

function readProtectedRows(database) {
  return {
    users: database
      .prepare("SELECT * FROM users ORDER BY id")
      .all(),
    leagues: database
      .prepare("SELECT * FROM leagues ORDER BY id")
      .all(),
    memberships: database
      .prepare("SELECT * FROM league_memberships ORDER BY id")
      .all(),
    roles: database
      .prepare("SELECT * FROM platform_roles ORDER BY id")
      .all(),
    seasons: database
      .prepare("SELECT * FROM seasons ORDER BY id")
      .all(),
  };
}

describe("FAD-01.1 lifecycle prerequisite migration", () => {
  test("upgrades schema 22 to 23 without fabricating domain rows", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0023-upgrade-"
    );
    copyMigrationsThrough(runtime, 22);
    migrate(runtime, "fad-0023-before");
    const first = seedLeague(runtime, { base: 100 });
    seedLeague(runtime, { base: 200 });
    const before = readProtectedRows(runtime.database);

    copyMigrationsThrough(runtime, 23);
    const result = migrate(runtime, "fad-0023-upgrade");

    assert.equal(result.status, "exact");
    assert.equal(result.applied.length, 23);
    assert.equal(
      runtime.database.pragma("user_version", {
        simple: true,
      }),
      23
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "23"
    );
    assert.deepEqual(readProtectedRows(runtime.database), before);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT migration_id, file_name
          FROM schema_migrations
          ORDER BY migration_id DESC
          LIMIT 1
        `)
        .get(),
      {
        migration_id: 23,
        file_name:
          "0023_add_fad_lifecycle_prerequisites.sql",
      }
    );

    for (const tableName of [
      "season_rollovers",
      "free_agent_draft_setup_exemptions",
    ]) {
      assert.equal(
        runtime.database
          .pragma("table_list")
          .find(({ name }) => name === tableName)?.strict,
        1
      );
      assert.equal(
        runtime.database
          .prepare(
            `SELECT COUNT(*) AS count FROM ${tableName}`
          )
          .get().count,
        0
      );
    }
    assert.equal(
      runtime.database
        .prepare(
          "SELECT COUNT(*) AS count FROM migration_reports"
        )
        .get().count,
      0
    );

    assertConstraint(() => {
      insert(runtime.database, "seasons", {
        id: uuid(700),
        league_id: first.league,
        label: "Duplicate key",
        nhl_season_key: "20262027",
        status: "planned",
        regular_season_starts_at_ms: null,
        regular_season_ends_at_ms: null,
        fantasy_playoffs_start_at_ms: null,
        fantasy_playoffs_end_at_ms: null,
        created_at_ms: 40,
        updated_at_ms: 40,
        version: 1,
      });
    });
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("rolls back 0023 when schema 22 has duplicate league season keys", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0023-duplicate-key-"
    );
    copyMigrationsThrough(runtime, 22);
    migrate(runtime, "fad-0023-duplicate-before");
    const ids = seedLeague(runtime, { base: 300 });
    insert(runtime.database, "seasons", {
      id: uuid(710),
      league_id: ids.league,
      label: "Duplicate key",
      nhl_season_key: "20262027",
      status: "planned",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: 40,
      updated_at_ms: 40,
      version: 1,
    });
    copyMigrationsThrough(runtime, 23);

    assert.throws(
      () => migrate(runtime, "fad-0023-duplicate-upgrade"),
      (error) => error?.code === "MIGRATION_APPLY_FAILED"
    );
    assert.equal(
      runtime.database.pragma("user_version", {
        simple: true,
      }),
      22
    );
    assert.equal(
      runtime.database
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations"
        )
        .get().count,
      22
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "22"
    );
    for (const objectName of [
      "seasons_one_nhl_key_per_league",
      "season_rollovers",
      "free_agent_draft_setup_exemptions",
    ]) {
      assert.equal(
        runtime.database
          .prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE name = ?
          `)
          .get(objectName),
        undefined
      );
    }
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("enforces durable same-league rollover evidence", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0023-rollover-"
    );
    copyMigrationsThrough(runtime, 23);
    migrate(runtime, "fad-0023-rollover");
    const first = seedLeague(runtime, { base: 400 });
    const second = seedLeague(runtime, { base: 500 });
    const valid = rolloverRecord(first);

    for (const overrides of [
      {
        from_season_id: first.targetSeason,
      },
      {
        contracts_advanced: -1,
      },
      {
        league_version_after: 4,
      },
      {
        authorized_authority: "manager",
      },
      {
        to_season_id: second.targetSeason,
      },
      {
        authorized_by_membership_id: second.membership,
      },
    ]) {
      assertConstraint(() => {
        insert(
          runtime.database,
          "season_rollovers",
          rolloverRecord(first, overrides)
        );
      });
    }

    runtime.database
      .prepare(
        "UPDATE seasons SET status = 'cancelled' WHERE id = ?"
      )
      .run(first.sourceSeason);
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "season_rollovers",
          rolloverRecord(first)
        );
      },
      /source must be the completed version/i
    );
    runtime.database
      .prepare(
        "UPDATE seasons SET status = 'completed' WHERE id = ?"
      )
      .run(first.sourceSeason);

    insert(runtime.database, "season_rollovers", valid);
    assert.equal(
      runtime.database
        .prepare(
          "SELECT COUNT(*) AS count FROM season_rollovers"
        )
        .get().count,
      1
    );
    assertConstraint(() => {
      insert(runtime.database, "season_rollovers", {
        ...valid,
        id: uuid(801),
      });
    });

    const uniqueColumnSets = runtime.database
      .pragma("index_list(season_rollovers)")
      .filter(({ unique }) => unique === 1)
      .map(({ name }) => {
        return runtime.database
          .pragma(`index_info(${name})`)
          .map(({ name: columnName }) => columnName)
          .join(",");
      });
    assert.ok(
      uniqueColumnSets.includes("league_id,from_season_id")
    );
    assert.ok(
      uniqueColumnSets.includes("league_id,to_season_id")
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE season_rollovers
            SET contracts_advanced = 99,
                version = 2
            WHERE id = ?
          `)
          .run(valid.id);
      },
      /rollover evidence is immutable/i
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(
            "DELETE FROM season_rollovers WHERE id = ?"
          )
          .run(valid.id);
      },
      /rollover evidence is immutable/i
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("enforces exemption attribution, reuse, and one-time consumption", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0023-exemption-"
    );
    copyMigrationsThrough(runtime, 23);
    migrate(runtime, "fad-0023-exemption");
    const first = seedLeague(runtime, { base: 600 });
    const second = seedLeague(runtime, { base: 700 });
    const firstReport = insertMigrationReport(
      runtime.database,
      first
    );
    const secondReport = insertMigrationReport(
      runtime.database,
      second,
      {
        id: uuid(851),
        sourceBundleId: "bundle-second",
      }
    );
    const alternateFirstReport = insertMigrationReport(
      runtime.database,
      first,
      {
        id: uuid(852),
        sourceBundleId: "bundle-first-alternate",
      }
    );
    const valid = exemptionRecord(first, firstReport, {
      created_at_ms: 35,
      updated_at_ms: 35,
    });

    insert(
      runtime.database,
      "free_agent_draft_setup_exemptions",
      valid
    );
    assertConstraint(() => {
      insert(
        runtime.database,
        "free_agent_draft_setup_exemptions",
        {
          ...valid,
          id: uuid(901),
        }
      );
    });
    for (const updateSql of [
      `
        UPDATE free_agent_draft_setup_exemptions
        SET season_id = '${first.sourceSeason}',
            updated_at_ms = 36,
            version = 2
        WHERE id = '${valid.id}'
      `,
      `
        UPDATE free_agent_draft_setup_exemptions
        SET migration_report_id = '${alternateFirstReport}',
            updated_at_ms = 36,
            version = 2
        WHERE id = '${valid.id}'
      `,
      `
        UPDATE free_agent_draft_setup_exemptions
        SET reason = 'Rewritten evidence',
            updated_at_ms = 36,
            version = 2
        WHERE id = '${valid.id}'
      `,
      `
        UPDATE free_agent_draft_setup_exemptions
        SET consumed_fad_id = '${uuid(949)}',
            consumed_at_ms = 40,
            updated_at_ms = 40,
            version = 1
        WHERE id = '${valid.id}'
      `,
      `
        UPDATE free_agent_draft_setup_exemptions
        SET consumed_fad_id = '${uuid(948)}',
            consumed_at_ms = 34,
            updated_at_ms = 40,
            version = 2
        WHERE id = '${valid.id}'
      `,
    ]) {
      assertConstraint(
        () => runtime.database.prepare(updateSql).run(),
        /may only be consumed once/i
      );
    }

    runtime.database
      .prepare(`
        UPDATE free_agent_draft_setup_exemptions
        SET consumed_fad_id = ?,
            consumed_at_ms = 40,
            updated_at_ms = 40,
            version = 2
        WHERE id = ?
      `)
      .run(uuid(950), valid.id);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT consumed_fad_id, consumed_at_ms, version
          FROM free_agent_draft_setup_exemptions
          WHERE id = ?
        `)
        .get(valid.id),
      {
        consumed_fad_id: uuid(950),
        consumed_at_ms: 40,
        version: 2,
      }
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_setup_exemptions
            SET consumed_fad_id = ?,
                consumed_at_ms = 41,
                updated_at_ms = 41,
                version = 3
            WHERE id = ?
          `)
          .run(uuid(951), valid.id);
      },
      /may only be consumed once/i
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_setup_exemptions
            SET reason = 'Rewritten after consumption',
                updated_at_ms = 41,
                version = 3
            WHERE id = ?
          `)
          .run(valid.id);
      },
      /may only be consumed once/i
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            DELETE FROM free_agent_draft_setup_exemptions
            WHERE id = ?
          `)
          .run(valid.id);
      },
      /exemption evidence is immutable/i
    );

    for (const record of [
      exemptionRecord(second, secondReport, {
        id: uuid(910),
        exemption_kind: "inaugural",
      }),
      exemptionRecord(second, secondReport, {
        id: uuid(911),
        reason: " padded ",
      }),
      exemptionRecord(second, secondReport, {
        id: uuid(912),
        authorized_authority: "commissioner",
      }),
      exemptionRecord(second, secondReport, {
        id: uuid(913),
        consumed_fad_id: uuid(952),
      }),
      exemptionRecord(second, secondReport, {
        id: uuid(915),
        consumed_fad_id: uuid(952),
        consumed_at_ms: 31,
      }),
      exemptionRecord(second, secondReport, {
        id: uuid(914),
        league_id: first.league,
      }),
    ]) {
      assertConstraint(() => {
        insert(
          runtime.database,
          "free_agent_draft_setup_exemptions",
          record
        );
      });
    }

    const exemptionForeignKeys = runtime.database.pragma(
      "foreign_key_list(free_agent_draft_setup_exemptions)"
    );
    assert.equal(
      exemptionForeignKeys.some(
        ({ table }) => table === "free_agent_drafts"
      ),
      false
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });
});
