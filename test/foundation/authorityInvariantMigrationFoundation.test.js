"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Database = require("better-sqlite3");
const { test } = require("node:test");

const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  previewAuthorityReconciliation,
} = require("../../scripts/preview-m7-26-authority-reconciliation");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function migrations(maximumId) {
  return discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  }).filter(({ id }) => id <= maximumId);
}

function apply(database, maximumId, buildId) {
  return applyMigrations({
    database,
    migrations: migrations(maximumId),
    applicationBuildId: buildId,
    now: () => 54,
  });
}

function databaseAt(maximumId, buildId) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  apply(database, maximumId, buildId);
  return database;
}

function insertUser(database, id, name) {
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms, updated_at_ms,
      version
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 1)
  `).run(id, `${name}@example.test`, `${name}@example.test`, name, name);
}

function insertLeague(database, id, name) {
  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      commissioner_membership_id, current_season_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, 'setup', 'America/Vancouver', NULL, NULL, 1, 1, 1)
  `).run(id, name, name.toLowerCase());
}

function insertMembership(
  database,
  { id, leagueId, userId, permissionCategory }
) {
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'active', 1, NULL, 1, 1, 1)
  `).run(id, leagueId, userId, permissionCategory);
}

test("schema 54 aborts dirty commissioner data, then enforces one active commissioner after explicit reconciliation", () => {
  const database = databaseAt(53, "authority-invariant-base");
  try {
    const leagueId = uuid(1);
    const firstUserId = uuid(2);
    const secondUserId = uuid(3);
    const thirdUserId = uuid(4);
    const firstMembershipId = uuid(5);
    const secondMembershipId = uuid(6);
    insertUser(database, firstUserId, "first");
    insertUser(database, secondUserId, "second");
    insertUser(database, thirdUserId, "third");
    insertLeague(database, leagueId, "Authority League");
    insertMembership(database, {
      id: firstMembershipId,
      leagueId,
      userId: firstUserId,
      permissionCategory: "commissioner",
    });
    insertMembership(database, {
      id: secondMembershipId,
      leagueId,
      userId: secondUserId,
      permissionCategory: "commissioner",
    });
    database.prepare(`
      UPDATE leagues SET commissioner_membership_id = ?, version = 2
      WHERE id = ?
    `).run(firstMembershipId, leagueId);

    assert.throws(
      () => apply(database, 54, "authority-invariant-dirty"),
      (error) =>
        error?.code === "MIGRATION_APPLY_FAILED" &&
        error?.details?.migrationId === 54
    );
    assert.equal(database.pragma("user_version", { simple: true }), 53);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM schema_migrations
        WHERE migration_id = 54
      `).get().count,
      0
    );

    database.prepare(
      "DELETE FROM league_memberships WHERE id = ?"
    ).run(secondMembershipId);
    const state = apply(database, 54, "authority-invariant-clean");
    assert.equal(state.userVersion, 54);
    assert.equal(
      database.prepare(`
        SELECT metadata_value FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).get().metadata_value,
      "54"
    );
    assert.throws(
      () =>
        insertMembership(database, {
          id: uuid(7),
          leagueId,
          userId: thirdUserId,
          permissionCategory: "commissioner",
        }),
      (error) => error?.code?.startsWith("SQLITE_CONSTRAINT")
    );
  } finally {
    database.close();
  }
});

test("schema 54 requires canonical protected membership coverage for every active administrator", () => {
  const database = databaseAt(53, "authority-admin-coverage-base");
  try {
    const leagueId = uuid(20);
    const administratorId = uuid(21);
    insertUser(database, administratorId, "coverage-admin");
    insertLeague(database, leagueId, "Coverage League");
    database.prepare(`
      INSERT INTO platform_roles (
        id, user_id, role, status, granted_by_user_id,
        granted_at_ms, ended_at_ms, version
      ) VALUES (?, ?, 'platform_administrator', 'active', NULL, 1, NULL, 1)
    `).run(uuid(22), administratorId);

    assert.throws(
      () => apply(database, 54, "authority-admin-coverage-missing"),
      (error) => error?.code === "MIGRATION_APPLY_FAILED"
    );
    insertMembership(database, {
      id: uuid(23),
      leagueId,
      userId: administratorId,
      permissionCategory: "member",
    });
    assert.equal(
      apply(database, 54, "authority-admin-coverage-clean").userVersion,
      54
    );
  } finally {
    database.close();
  }
});

test("the M7-26 reconciliation preview reports legacy violations without writes", () => {
  const database = databaseAt(53, "authority-preview-base");
  try {
    const leagueId = uuid(40);
    const administratorId = uuid(41);
    const commissionerOneId = uuid(42);
    const commissionerTwoId = uuid(43);
    insertUser(database, administratorId, "preview-admin");
    insertUser(database, commissionerOneId, "preview-one");
    insertUser(database, commissionerTwoId, "preview-two");
    insertLeague(database, leagueId, "Preview League");
    database.prepare(`
      INSERT INTO platform_roles (
        id, user_id, role, status, granted_by_user_id,
        granted_at_ms, ended_at_ms, version
      ) VALUES (?, ?, 'platform_administrator', 'active', NULL, 1, NULL, 1)
    `).run(uuid(44), administratorId);
    insertMembership(database, {
      id: uuid(45),
      leagueId,
      userId: commissionerOneId,
      permissionCategory: "commissioner",
    });
    insertMembership(database, {
      id: uuid(46),
      leagueId,
      userId: commissionerTwoId,
      permissionCategory: "commissioner",
    });

    const before = database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    const preview = previewAuthorityReconciliation(database);
    assert.equal(
      database.prepare("SELECT total_changes() AS count").get().count,
      before
    );
    assert.equal(preview.readOnly, true);
    assert.equal(preview.mutationRequired, true);
    assert.deepEqual(preview.findings.missingAdministratorMemberships, [
      {
        leagueId,
        leagueName: "Preview League",
        userId: administratorId,
      },
    ]);
    assert.equal(
      preview.findings.invalidCommissionerCardinality[0]
        .activeCommissionerCount,
      2
    );
  } finally {
    database.close();
  }
});
