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

function copyMigration(fileName, targetDirectory) {
  fs.copyFileSync(
    path.join(CANONICAL_MIGRATIONS, fileName),
    path.join(targetDirectory, fileName)
  );
}

function migrate(database, migrationsDirectory, buildId) {
  return applyMigrations({
    database,
    migrations: discoverMigrations({ migrationsDirectory }),
    applicationBuildId: buildId,
    now: (() => {
      let nowMs = 1_000;
      return () => {
        nowMs += 1;
        return nowMs;
      };
    })(),
  });
}

function insertExistingAccountRows(database) {
  const userId = "00000000-0000-4000-8000-000000000001";
  const credentialId = "00000000-0000-4000-8000-000000000002";
  const roleId = "00000000-0000-4000-8000-000000000003";
  const auditId = "00000000-0000-4000-8000-000000000004";

  database
    .prepare(`
      INSERT INTO users (
        id, email_normalized, email_display,
        display_name, display_name_normalized, status,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, 'active', 10, 10, 3)
    `)
    .run(
      userId,
      "existing@example.test",
      "Existing@example.test",
      "Existing User",
      "existing user"
    );
  database
    .prepare(`
      INSERT INTO user_credentials (
        id, user_id, password_hash, algorithm,
        algorithm_version, status, created_at_ms,
        replaced_at_ms, version
      ) VALUES (?, ?, 'safe-test-hash', 'scrypt', 1,
        'active', 10, NULL, 1)
    `)
    .run(credentialId, userId);
  database
    .prepare(`
      INSERT INTO platform_roles (
        id, user_id, role, status, granted_by_user_id,
        granted_at_ms, ended_at_ms, version
      ) VALUES (?, ?, 'platform_administrator', 'active',
        NULL, 10, NULL, 1)
    `)
    .run(roleId, userId);
  database
    .prepare(`
      INSERT INTO security_audit_events (
        id, event_type, outcome, actor_user_id,
        target_user_id, league_id, session_id,
        request_correlation_id, reason_code,
        network_key_version, network_metadata_digest,
        client_metadata_json, unknown_account_digest,
        occurred_at_ms
      ) VALUES (?, 'account.existing', 'success', ?, ?,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)
    `)
    .run(auditId, userId, userId);

  return { auditId, credentialId, roleId, userId };
}

describe("M3-09 pending credential-setup schema migration", () => {
  test("a fresh database applies both immutable migrations", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-leago-m3-09-fresh-"
    );
    copyMigration("0001_initial.sql", runtime.migrationsDirectory);
    copyMigration(
      "0002_add_pending_credential_setup_user_status.sql",
      runtime.migrationsDirectory
    );

    const result = migrate(
      runtime.database,
      runtime.migrationsDirectory,
      "m3-09-fresh"
    );

    assert.equal(result.status, "exact");
    assert.equal(result.applied.length, 2);
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      2
    );
    assert.equal(
      runtime.database.pragma("foreign_keys", { simple: true }),
      1
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "2"
    );
  });

  test("upgrades existing linked rows and only adds the approved status", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-leago-m3-09-upgrade-"
    );
    copyMigration("0001_initial.sql", runtime.migrationsDirectory);
    migrate(
      runtime.database,
      runtime.migrationsDirectory,
      "m3-09-before"
    );
    const ids = insertExistingAccountRows(runtime.database);

    copyMigration(
      "0002_add_pending_credential_setup_user_status.sql",
      runtime.migrationsDirectory
    );
    const result = migrate(
      runtime.database,
      runtime.migrationsDirectory,
      "m3-09-upgrade"
    );

    assert.equal(result.status, "exact");
    assert.deepEqual(
      runtime.database
        .prepare("SELECT * FROM pragma_foreign_key_check")
        .all(),
      []
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT id, email_normalized, email_display,
            display_name, display_name_normalized, status,
            created_at_ms, updated_at_ms, version
          FROM users
          WHERE id = ?
        `)
        .get(ids.userId),
      {
        id: ids.userId,
        email_normalized: "existing@example.test",
        email_display: "Existing@example.test",
        display_name: "Existing User",
        display_name_normalized: "existing user",
        status: "active",
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 3,
      }
    );
    assert.equal(
      runtime.database
        .prepare("SELECT user_id FROM user_credentials WHERE id = ?")
        .get(ids.credentialId).user_id,
      ids.userId
    );
    assert.equal(
      runtime.database
        .prepare("SELECT user_id FROM platform_roles WHERE id = ?")
        .get(ids.roleId).user_id,
      ids.userId
    );
    assert.equal(
      runtime.database
        .prepare("SELECT target_user_id FROM security_audit_events WHERE id = ?")
        .get(ids.auditId).target_user_id,
      ids.userId
    );

    const pendingId = "00000000-0000-4000-8000-000000000005";
    runtime.database
      .prepare(`
        INSERT INTO users (
          id, email_normalized, email_display,
          display_name, display_name_normalized, status,
          created_at_ms, updated_at_ms, version
        ) VALUES (?, 'grae@example.test', 'grae@example.test',
          'Grae', 'grae', 'pending_credential_setup', 20, 20, 1)
      `)
      .run(pendingId);
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM users WHERE id = ?")
        .get(pendingId).status,
      "pending_credential_setup"
    );
    assert.throws(() => {
      runtime.database
        .prepare(`
          INSERT INTO users (
            id, email_normalized, email_display,
            display_name, display_name_normalized, status,
            created_at_ms, updated_at_ms, version
          ) VALUES (
            '00000000-0000-4000-8000-000000000006',
            'invalid@example.test', 'invalid@example.test',
            'Invalid', 'invalid', 'other_pending', 20, 20, 1
          )
        `)
        .run();
    }, /CHECK constraint failed/);
  });

  test("a declared rebuild rolls back violations and restores enforcement", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-leago-m3-09-invalid-rebuild-"
    );
    fs.writeFileSync(
      path.join(runtime.migrationsDirectory, "0001_parent_child.sql"),
      [
        "CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE RESTRICT) STRICT;",
        "INSERT INTO parent (id) VALUES (1);",
        "INSERT INTO child (id, parent_id) VALUES (1, 1);",
        "",
      ].join("\n"),
      "utf8"
    );
    migrate(
      runtime.database,
      runtime.migrationsDirectory,
      "m3-09-valid-parent"
    );
    fs.writeFileSync(
      path.join(runtime.migrationsDirectory, "0002_invalid_rebuild.sql"),
      [
        "-- hundo-leago: foreign-key-rebuild",
        "CREATE TABLE parent_new (id INTEGER PRIMARY KEY) STRICT;",
        "DROP TABLE parent;",
        "ALTER TABLE parent_new RENAME TO parent;",
        "",
      ].join("\n"),
      "utf8"
    );

    assert.throws(
      () =>
        migrate(
          runtime.database,
          runtime.migrationsDirectory,
          "m3-09-invalid-parent"
        ),
      (error) =>
        error?.code === "MIGRATION_APPLY_FAILED" &&
        error?.cause?.message ===
          "The declared rebuild produced a foreign-key violation."
    );
    assert.equal(
      runtime.database.pragma("foreign_keys", { simple: true }),
      1
    );
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      1
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get().count,
      1
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM parent")
        .get().count,
      1
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });
});
