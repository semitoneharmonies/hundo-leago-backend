"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { describe, test } = require("node:test");

const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  AUDIT_EVENT_TYPE,
  ERROR_CODES,
  RESULT_CODE,
  assertExactPhysicalTarget,
  confirmationFor,
  parseArguments,
  reconcileAuthorityDatabase,
  runAuthorityReconciliationCommand,
} = require("../../scripts/reconcile-m7-26-staging-authority");
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
const RELEASE_ID = "HL-20260820-1";
const ENVIRONMENT_ID = "hundo-staging-environment-v1";
const DATABASE_ID = "hundo-staging-database-v1";
const CREATED_AT = "2026-08-20T12:00:00.000Z";
const NOW_MS = Date.parse(CREATED_AT);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function applySchema(database, maximumId = 53) {
  const migrations = discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  }).filter(({ id }) => id <= maximumId);
  applyMigrations({
    database,
    migrations,
    applicationBuildId: `authority-command-schema-${maximumId}`,
    now: () => maximumId,
  });
  const insert = database.prepare(`
    INSERT INTO application_metadata (
      metadata_key, metadata_value, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?)
  `);
  insert.run("database_created_at", CREATED_AT, NOW_MS, NOW_MS);
  insert.run("database_id", DATABASE_ID, NOW_MS, NOW_MS);
  insert.run("environment_id", ENVIRONMENT_ID, NOW_MS, NOW_MS);
}

function insertUser(database, id, label) {
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms, updated_at_ms,
      version
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1)
  `).run(
    id,
    `${label}@example.test`,
    `${label}@example.test`,
    label,
    label,
    NOW_MS,
    NOW_MS
  );
}

function insertLeague(database, { id, name }) {
  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      commissioner_membership_id, current_season_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, 'setup', 'America/Vancouver', NULL, NULL, ?, ?, 1)
  `).run(id, name, name.toLowerCase(), NOW_MS, NOW_MS);
}

function insertMembership(database, {
  id,
  leagueId,
  userId,
  permissionCategory = "member",
  status = "active",
  joinedAtMs = ["active", "ended", "suspended"].includes(status)
    ? NOW_MS
    : null,
  endedAtMs = status === "ended" ? NOW_MS + 1 : null,
  createdAtMs = NOW_MS,
}) {
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id,
    leagueId,
    userId,
    permissionCategory,
    status,
    joinedAtMs,
    endedAtMs,
    createdAtMs,
    Math.max(createdAtMs, endedAtMs || 0)
  );
}

function setCommissioner(database, leagueId, membershipId) {
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?, version = version + 1,
      updated_at_ms = ?
    WHERE id = ?
  `).run(membershipId, NOW_MS, leagueId);
}

function insertAdministrator(database, { roleId, userId }) {
  database.prepare(`
    INSERT INTO platform_roles (
      id, user_id, role, status, granted_by_user_id,
      granted_at_ms, ended_at_ms, version
    ) VALUES (?, ?, 'platform_administrator', 'active', NULL, ?, NULL, 1)
  `).run(roleId, userId, NOW_MS);
}

function insertTeamAssignment(database, {
  assignmentId,
  leagueId,
  membershipId,
  teamId,
  userId,
  label,
}) {
  database.prepare(`
    INSERT INTO teams (
      id, league_id, name, name_normalized, status,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)
  `).run(teamId, leagueId, label, label.toLowerCase(), NOW_MS, NOW_MS);
  database.prepare(`
    INSERT INTO team_manager_assignments (
      id, league_id, team_id, user_id, membership_id,
      assigned_by_user_id, replaces_assignment_id, status,
      assigned_at_ms, accepted_at_ms, ended_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'accepted', ?, ?, NULL, 1)
  `).run(
    assignmentId,
    leagueId,
    teamId,
    userId,
    membershipId,
    userId,
    NOW_MS,
    NOW_MS
  );
}

function insertPendingCommissionerTransfer(database, {
  id,
  leagueId,
  membershipId,
  invitingUserId,
  proposedUserId,
  label,
}) {
  database.prepare(`
    INSERT INTO league_invitations (
      id, league_id, invited_email_normalized, invited_user_id,
      inviting_user_id, membership_id, workflow, team_id, status,
      created_at_ms, expires_at_ms, accepted_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, ?, NULL, 1)
  `).run(
    id,
    leagueId,
    `${label}@example.test`,
    proposedUserId,
    invitingUserId,
    membershipId,
    NOW_MS,
    NOW_MS + 60_000
  );
}

function seedCanonicalLeague(database, offset = 0, name = `League ${offset}`) {
  const leagueId = uuid(100 + offset);
  const commissionerUserId = uuid(101 + offset);
  const commissionerMembershipId = uuid(102 + offset);
  insertUser(database, commissionerUserId, `commissioner-${offset}`);
  insertLeague(database, { id: leagueId, name });
  insertMembership(database, {
    id: commissionerMembershipId,
    leagueId,
    userId: commissionerUserId,
    permissionCategory: "commissioner",
  });
  setCommissioner(database, leagueId, commissionerMembershipId);
  return { leagueId, commissionerUserId, commissionerMembershipId };
}

function createTarget(t, seed, maximumSchemaId = 53) {
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m7-authority-")
  );
  const databasePath = path.join(persistentRoot, "authority.sqlite");
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  applySchema(database, maximumSchemaId);
  const state = seed?.(database) || {};
  database.close();
  t.after(() => fs.rmSync(persistentRoot, { recursive: true, force: true }));
  const confirmation = confirmationFor({
    releaseId: RELEASE_ID,
    environmentId: ENVIRONMENT_ID,
    databaseId: DATABASE_ID,
  });
  const argv = [
    "--database",
    databasePath,
    "--environment",
    "staging",
    "--persistent-root",
    persistentRoot,
    "--release-id",
    RELEASE_ID,
    "--confirmation",
    confirmation,
  ];
  const env = {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_ENVIRONMENT_ID: ENVIRONMENT_ID,
    DATABASE_ID,
    DATABASE_PATH: databasePath,
    PERSISTENT_DATA_ROOT: persistentRoot,
    PORT: "3000",
    STAGING_MAINTENANCE_HOLD: "true",
    LEAGUE_WRITE_MODE: "closed",
    SCHEDULED_JOBS_ENABLED: "false",
    FREE_AGENT_DRAFT_ROUTES_ENABLED: "false",
    ACCOUNT_EMAIL_DELIVERY_ENABLED: "false",
    DEBUG_ROUTES_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "capture",
    SPORTSDATAIO_NHL_LIVE_MODE: "disabled",
    BACKUP_SCHEDULE_ENABLED: "false",
  };
  return { argv, databasePath, env, persistentRoot, ...state };
}

function run(target, nowMs = NOW_MS + 10_000) {
  const lines = [];
  const result = runAuthorityReconciliationCommand({
    argv: target.argv,
    env: target.env,
    nowMs,
    output: { log: (line) => lines.push(line) },
  });
  assert.equal(lines.length, 1);
  return { result, json: lines[0] };
}

function readRows(databasePath, sql) {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function authoritySnapshot(database) {
  const tables = [
    "leagues",
    "league_memberships",
    "league_invitations",
    "team_manager_assignments",
    "security_audit_events",
  ];
  return Object.freeze(Object.fromEntries(tables.map((table) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  ])));
}

function directBinding(database, overrides = {}) {
  return {
    database,
    databaseId: DATABASE_ID,
    environmentId: ENVIRONMENT_ID,
    releaseId: RELEASE_ID,
    schemaVersion: 53,
    nowMs: NOW_MS + 20_000,
    ...overrides,
  };
}

function assertDirectFailureWithoutWrites(database, expectedCode) {
  const beforeRows = authoritySnapshot(database);
  const beforeChanges = database.prepare(
    "SELECT total_changes() AS count"
  ).get().count;
  assert.throws(
    () => reconcileAuthorityDatabase(directBinding(database)),
    { code: expectedCode }
  );
  assert.equal(
    database.prepare("SELECT total_changes() AS count").get().count,
    beforeChanges
  );
  assert.deepEqual(authoritySnapshot(database), beforeRows);
}

describe("M7-26 staging authority reconciliation command", () => {
  test("requires the exact staging target and identity-bound typed confirmation", () => {
    const options = parseArguments([
      "--release-id",
      RELEASE_ID,
      "--persistent-root",
      path.resolve("persistent"),
      "--confirmation",
      confirmationFor({
        releaseId: RELEASE_ID,
        environmentId: ENVIRONMENT_ID,
        databaseId: DATABASE_ID,
      }),
      "--database",
      path.resolve("persistent", "authority.sqlite"),
      "--environment",
      "staging",
    ]);
    assert.equal(options.releaseId, RELEASE_ID);
    assert.equal(options.environment, "staging");
    for (const argv of [
      [],
      ["--database", path.resolve("authority.sqlite")],
      [
        "--database", path.resolve("authority.sqlite"),
        "--environment", "production",
        "--persistent-root", path.resolve("persistent"),
        "--release-id", RELEASE_ID,
        "--confirmation", "wrong",
      ],
      [
        "--database", path.resolve("authority.sqlite"),
        "--environment", "staging",
        "--persistent-root", path.resolve("persistent"),
        "--release-id", RELEASE_ID,
        "--force", "true",
      ],
    ]) {
      assert.throws(() => parseArguments(argv), {
        code: ERROR_CODES.argumentInvalid,
      });
    }
  });

  test("repairs the Beta-style duplicate, provisions administrator coverage, and replays exactly without writes", (t) => {
    const target = createTarget(t, (database) => {
      const canonical = seedCanonicalLeague(database, 0, "Beta League");
      const duplicateUserId = uuid(110);
      const duplicateMembershipId = uuid(111);
      const administratorUserId = uuid(112);
      insertUser(database, duplicateUserId, "beta-duplicate");
      insertMembership(database, {
        id: duplicateMembershipId,
        leagueId: canonical.leagueId,
        userId: duplicateUserId,
        permissionCategory: "commissioner",
      });
      insertUser(database, administratorUserId, "beta-admin");
      insertAdministrator(database, {
        roleId: uuid(113),
        userId: administratorUserId,
      });
      return {
        ...canonical,
        duplicateMembershipId,
        administratorUserId,
      };
    });

    const first = run(target);
    assert.equal(first.result.code, RESULT_CODE);
    assert.equal(first.result.replayed, false);
    assert.equal(first.result.changesThisRun, 3);
    assert.equal(first.result.authorityMutationCount, 2);
    assert.equal(first.result.changes.commissionerDemotions.length, 1);
    assert.equal(
      first.result.changes.commissionerDemotions[0].permissionCategory,
      "member"
    );
    assert.equal(
      first.result.changes.administratorMembershipsProvisioned.length,
      1
    );
    assert.equal(first.result.after.counts.invalidCommissionerPointerCount, 0);
    assert.equal(
      first.result.after.counts.invalidCommissionerCardinalityCount,
      0
    );

    const memberships = readRows(target.databasePath, `
      SELECT id, user_id AS userId, permission_category AS permissionCategory,
        status
      FROM league_memberships
      ORDER BY id
    `);
    assert.equal(
      memberships.find(({ id }) => id === target.duplicateMembershipId)
        .permissionCategory,
      "member"
    );
    assert.equal(
      memberships.find(({ userId }) => userId === target.administratorUserId)
        .permissionCategory,
      "member"
    );
    assert.deepEqual(readRows(target.databasePath, `
      SELECT commissioner_membership_id AS commissionerMembershipId
      FROM leagues
    `), [{ commissionerMembershipId: target.commissionerMembershipId }]);

    const migrated = new Database(target.databasePath);
    try {
      migrated.pragma("foreign_keys = ON");
      applyMigrations({
        database: migrated,
        migrations: discoverMigrations({
          migrationsDirectory: MIGRATIONS_DIRECTORY,
        }),
        applicationBuildId: "authority-command-post-reconciliation",
        now: () => 54,
      });
    } finally {
      migrated.close();
    }

    const second = run(target, NOW_MS + 30_000);
    assert.equal(second.result.replayed, true);
    assert.equal(second.result.changesThisRun, 0);
    assert.equal(second.json, first.json);
    assert.equal(
      readRows(target.databasePath, `
        SELECT COUNT(*) AS count FROM security_audit_events
        WHERE event_type = '${AUDIT_EVENT_TYPE}'
      `)[0].count,
      1
    );

  });

  test("runs against the exact schema-52 staging source without advancing schema", (t) => {
    const target = createTarget(t, (database) => {
      const canonical = seedCanonicalLeague(database, 10, "Schema 52 League");
      const duplicateUserId = uuid(115);
      const administratorUserId = uuid(116);
      insertUser(database, duplicateUserId, "schema-52-duplicate");
      insertMembership(database, {
        id: uuid(117),
        leagueId: canonical.leagueId,
        userId: duplicateUserId,
        permissionCategory: "commissioner",
      });
      insertUser(database, administratorUserId, "schema-52-admin");
      insertAdministrator(database, {
        roleId: uuid(118),
        userId: administratorUserId,
      });
    }, 52);

    const { result } = run(target);
    assert.equal(result.schemaVersion, 52);
    assert.equal(result.authorityMutationCount, 2);
    assert.equal(result.changes.commissionerDemotions.length, 1);
    assert.equal(
      result.changes.administratorMembershipsProvisioned.length,
      1
    );
    assert.deepEqual(readRows(target.databasePath, `
      SELECT user_version AS schemaVersion FROM pragma_user_version
    `), [{ schemaVersion: 52 }]);
    assert.deepEqual(readRows(target.databasePath, `
      SELECT metadata_value AS dataModelVersion
      FROM application_metadata
      WHERE metadata_key = 'data_model_version'
    `), [{ dataModelVersion: "52" }]);
  });

  test("demotes only an actual same-league current team manager to manager", (t) => {
    const target = createTarget(t, (database) => {
      const first = seedCanonicalLeague(database, 20, "Manager League");
      const managerUserId = uuid(130);
      const managerMembershipId = uuid(131);
      insertUser(database, managerUserId, "manager-demotion");
      insertMembership(database, {
        id: managerMembershipId,
        leagueId: first.leagueId,
        userId: managerUserId,
        permissionCategory: "commissioner",
      });
      insertTeamAssignment(database, {
        assignmentId: uuid(132),
        leagueId: first.leagueId,
        membershipId: managerMembershipId,
        teamId: uuid(133),
        userId: managerUserId,
        label: "Manager Team",
      });

      const second = seedCanonicalLeague(database, 40, "Cross League");
      const crossUserId = uuid(150);
      const crossMembershipId = uuid(151);
      insertUser(database, crossUserId, "cross-demotion");
      insertMembership(database, {
        id: crossMembershipId,
        leagueId: second.leagueId,
        userId: crossUserId,
        permissionCategory: "commissioner",
      });
      const crossFirstMembershipId = uuid(152);
      insertMembership(database, {
        id: crossFirstMembershipId,
        leagueId: first.leagueId,
        userId: crossUserId,
      });
      insertTeamAssignment(database, {
        assignmentId: uuid(153),
        leagueId: first.leagueId,
        membershipId: crossFirstMembershipId,
        teamId: uuid(154),
        userId: crossUserId,
        label: "Other League Team",
      });
      return { managerMembershipId, crossMembershipId };
    });

    const { result } = run(target);
    const byMembership = new Map(
      result.changes.commissionerDemotions.map((row) => [row.membershipId, row])
    );
    assert.equal(
      byMembership.get(target.managerMembershipId).permissionCategory,
      "manager"
    );
    assert.equal(
      byMembership.get(target.crossMembershipId).permissionCategory,
      "member"
    );
  });

  test("normalizes a noncanonical administrator membership without changing its protected team assignment", (t) => {
    const target = createTarget(t, (database) => {
      const league = seedCanonicalLeague(database, 60, "Admin League");
      const administratorUserId = uuid(170);
      const administratorMembershipId = uuid(171);
      const assignmentId = uuid(172);
      insertUser(database, administratorUserId, "legacy-admin");
      insertAdministrator(database, {
        roleId: uuid(173),
        userId: administratorUserId,
      });
      insertMembership(database, {
        id: administratorMembershipId,
        leagueId: league.leagueId,
        userId: administratorUserId,
        permissionCategory: "manager",
      });
      insertTeamAssignment(database, {
        assignmentId,
        leagueId: league.leagueId,
        membershipId: administratorMembershipId,
        teamId: uuid(174),
        userId: administratorUserId,
        label: "Protected Admin Team",
      });
      return { administratorMembershipId, assignmentId };
    });

    const { result } = run(target);
    assert.deepEqual(
      result.changes.administratorMembershipsNormalized[0]
        .protectedTeamAssignmentIds,
      [target.assignmentId]
    );
    assert.deepEqual(readRows(target.databasePath, `
      SELECT status, ended_at_ms AS endedAtMs, version
      FROM team_manager_assignments WHERE id = '${target.assignmentId}'
    `), [{ status: "accepted", endedAtMs: null, version: 1 }]);
    assert.equal(readRows(target.databasePath, `
      SELECT permission_category AS permissionCategory
      FROM league_memberships
      WHERE id = '${target.administratorMembershipId}'
    `)[0].permissionCategory, "member");
  });

  test("fails before writes for a null or noncanonical commissioner pointer", () => {
    const database = new Database(":memory:");
    applySchema(database);
    const league = seedCanonicalLeague(database, 80, "Invalid Pointer");
    database.prepare(`
      UPDATE league_memberships SET permission_category = 'member'
      WHERE id = ?
    `).run(league.commissionerMembershipId);
    assertDirectFailureWithoutWrites(database, ERROR_CODES.pointerInvalid);
    database.close();
  });

  test("fails before writes when an active administrator is any active commissioner", () => {
    const database = new Database(":memory:");
    applySchema(database);
    const league = seedCanonicalLeague(database, 100, "Admin Commissioner");
    insertAdministrator(database, {
      roleId: uuid(205),
      userId: league.commissionerUserId,
    });
    assertDirectFailureWithoutWrites(
      database,
      ERROR_CODES.administratorCommissioner
    );
    database.close();
  });

  test("fails before writes for duplicate active administrator memberships", () => {
    const database = new Database(":memory:");
    applySchema(database);
    const league = seedCanonicalLeague(database, 120, "Duplicate Admin");
    const administratorUserId = uuid(225);
    insertUser(database, administratorUserId, "duplicate-admin");
    insertAdministrator(database, {
      roleId: uuid(226),
      userId: administratorUserId,
    });
    database.exec("DROP INDEX league_memberships_one_active_per_user");
    insertMembership(database, {
      id: uuid(227),
      leagueId: league.leagueId,
      userId: administratorUserId,
    });
    insertMembership(database, {
      id: uuid(228),
      leagueId: league.leagueId,
      userId: administratorUserId,
    });
    assertDirectFailureWithoutWrites(
      database,
      ERROR_CODES.administratorMembershipDuplicate
    );
    database.close();
  });

  test("fails before writes for ambiguous inactive administrator history", () => {
    const database = new Database(":memory:");
    applySchema(database);
    const league = seedCanonicalLeague(database, 140, "Admin History");
    const administratorUserId = uuid(245);
    insertUser(database, administratorUserId, "history-admin");
    insertAdministrator(database, {
      roleId: uuid(246),
      userId: administratorUserId,
    });
    insertMembership(database, {
      id: uuid(247),
      leagueId: league.leagueId,
      userId: administratorUserId,
      status: "ended",
    });
    insertMembership(database, {
      id: uuid(248),
      leagueId: league.leagueId,
      userId: administratorUserId,
      status: "ended",
      createdAtMs: NOW_MS + 2,
    });
    assertDirectFailureWithoutWrites(
      database,
      ERROR_CODES.administratorHistoryAmbiguous
    );
    database.close();
  });

  test("fails closed and reports duplicate pending commissioner transfers", () => {
    const database = new Database(":memory:");
    applySchema(database);
    const league = seedCanonicalLeague(database, 160, "Transfer Conflict");
    for (let index = 0; index < 2; index += 1) {
      const userId = uuid(265 + index * 3);
      const membershipId = uuid(266 + index * 3);
      insertUser(database, userId, `pending-${index}`);
      insertMembership(database, {
        id: membershipId,
        leagueId: league.leagueId,
        userId,
        permissionCategory: "commissioner",
        status: "invited",
      });
      insertPendingCommissionerTransfer(database, {
        id: uuid(267 + index * 3),
        leagueId: league.leagueId,
        membershipId,
        invitingUserId: league.commissionerUserId,
        proposedUserId: userId,
        label: `pending-${index}`,
      });
    }
    const before = authoritySnapshot(database);
    assert.throws(
      () => reconcileAuthorityDatabase(directBinding(database)),
      (error) => {
        assert.equal(error.code, ERROR_CODES.pendingTransfersAmbiguous);
        assert.deepEqual(error.details.findings, [{
          leagueId: league.leagueId,
          pendingTransferCount: 2,
        }]);
        return true;
      }
    );
    assert.deepEqual(authoritySnapshot(database), before);
    database.close();
  });

  test("fails before writes when deleted-league commissioner rows would block migration 54", () => {
    const database = new Database(":memory:");
    applySchema(database);
    const league = seedCanonicalLeague(database, 170, "Deleted Duplicate");
    const duplicateUserId = uuid(275);
    insertUser(database, duplicateUserId, "deleted-duplicate");
    insertMembership(database, {
      id: uuid(276),
      leagueId: league.leagueId,
      userId: duplicateUserId,
      permissionCategory: "commissioner",
    });
    database.prepare(`
      UPDATE leagues SET status = 'deleted' WHERE id = ?
    `).run(league.leagueId);

    const before = authoritySnapshot(database);
    assert.throws(
      () => reconcileAuthorityDatabase(directBinding(database)),
      (error) => {
        assert.equal(
          error.code,
          ERROR_CODES.deletedLeagueCommissionersDuplicate
        );
        assert.deepEqual(error.details.findings, [{
          leagueId: league.leagueId,
          activeCommissionerCount: 2,
        }]);
        return true;
      }
    );
    assert.deepEqual(authoritySnapshot(database), before);
    database.close();
  });

  test("rejects unsafe environment drift before opening or changing the database", (t) => {
    const target = createTarget(t, (database) =>
      seedCanonicalLeague(database, 180, "Environment Guard")
    );
    const before = readRows(target.databasePath, `
      SELECT id, commissioner_membership_id AS commissionerMembershipId,
        version FROM leagues ORDER BY id
    `);
    for (const drift of [
      { APP_ENV: "production" },
      { STAGING_MAINTENANCE_HOLD: "false" },
      { LEAGUE_WRITE_MODE: "open" },
      { SCHEDULED_JOBS_ENABLED: "true" },
      { FREE_AGENT_DRAFT_ROUTES_ENABLED: "true" },
      { ACCOUNT_EMAIL_DELIVERY_ENABLED: "true" },
      { DEBUG_ROUTES_ENABLED: "true" },
      { BACKUP_SCHEDULE_ENABLED: "true" },
      { EMAIL_DELIVERY_MODE: "send" },
      { DATABASE_ID: "different-staging-database" },
    ]) {
      assert.throws(
        () => runAuthorityReconciliationCommand({
          argv: target.argv,
          env: { ...target.env, ...drift },
          output: { log() {} },
        }),
        { code: ERROR_CODES.environmentUnsafe }
      );
    }
    assert.deepEqual(readRows(target.databasePath, `
      SELECT id, commissioner_membership_id AS commissionerMembershipId,
        version FROM leagues ORDER BY id
    `), before);
    assert.equal(readRows(target.databasePath, `
      SELECT COUNT(*) AS count FROM security_audit_events
    `)[0].count, 0);
  });

  test("rolls back every authority mutation when the audit receipt cannot be stored", () => {
    const database = new Database(":memory:");
    applySchema(database);
    const league = seedCanonicalLeague(database, 195, "Audit Rollback");
    const duplicateUserId = uuid(298);
    insertUser(database, duplicateUserId, "audit-rollback-duplicate");
    insertMembership(database, {
      id: uuid(299),
      leagueId: league.leagueId,
      userId: duplicateUserId,
      permissionCategory: "commissioner",
    });
    database.exec(`
      CREATE TRIGGER reject_authority_reconciliation_audit
      BEFORE INSERT ON security_audit_events
      WHEN NEW.event_type = '${AUDIT_EVENT_TYPE}'
      BEGIN
        SELECT RAISE(ABORT, 'injected authority audit failure');
      END
    `);
    const before = authoritySnapshot(database);

    assert.throws(
      () => reconcileAuthorityDatabase(directBinding(database)),
      /injected authority audit failure/u
    );
    assert.deepEqual(authoritySnapshot(database), before);
    database.close();
  });

  test("rejects a stored staging database identity mismatch without authority writes", (t) => {
    const target = createTarget(t, (database) =>
      seedCanonicalLeague(database, 190, "Identity Guard")
    );
    const database = new Database(target.databasePath);
    try {
      database.prepare(`
        UPDATE application_metadata
        SET metadata_value = 'different-staging-database'
        WHERE metadata_key = 'database_id'
      `).run();
    } finally {
      database.close();
    }
    const before = readRows(target.databasePath, `
      SELECT id, commissioner_membership_id AS commissionerMembershipId,
        version FROM leagues ORDER BY id
    `);
    assert.throws(
      () => runAuthorityReconciliationCommand({
        argv: target.argv,
        env: target.env,
        output: { log() {} },
      }),
      { code: ERROR_CODES.identityMismatch }
    );
    assert.deepEqual(readRows(target.databasePath, `
      SELECT id, commissioner_membership_id AS commissionerMembershipId,
        version FROM leagues ORDER BY id
    `), before);
    assert.equal(readRows(target.databasePath, `
      SELECT COUNT(*) AS count FROM security_audit_events
    `)[0].count, 0);
  });

  test("rejects a database outside the exact persistent root", (t) => {
    const first = createTarget(t, (database) =>
      seedCanonicalLeague(database, 200, "Path Guard")
    );
    const otherRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-m7-authority-other-")
    );
    t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
    assert.throws(
      () => assertExactPhysicalTarget({
        databasePath: first.databasePath,
        persistentRoot: otherRoot,
      }),
      { code: ERROR_CODES.targetUnsafe }
    );
  });

  test("post-checks the existing preview as clean after reconciliation", (t) => {
    const target = createTarget(t, (database) => {
      const league = seedCanonicalLeague(database, 220, "Preview Clean");
      const duplicateUserId = uuid(325);
      insertUser(database, duplicateUserId, "preview-duplicate");
      insertMembership(database, {
        id: uuid(326),
        leagueId: league.leagueId,
        userId: duplicateUserId,
        permissionCategory: "commissioner",
      });
    });
    run(target);
    const database = new Database(target.databasePath);
    try {
      const preview = previewAuthorityReconciliation(database);
      assert.equal(preview.mutationRequired, false);
      assert.deepEqual(preview.findings.invalidCommissionerCardinality, []);
      assert.deepEqual(preview.findings.invalidCommissionerPointers, []);
    } finally {
      database.close();
    }
  });
});
