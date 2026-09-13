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
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const migrationsDirectory = path.join(temporaryRoot, "migrations");
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { ...connection, migrationsDirectory };
}

function copyMigration(fileName, targetDirectory) {
  fs.copyFileSync(
    path.join(CANONICAL_MIGRATIONS, fileName),
    path.join(targetDirectory, fileName)
  );
}

function migrate(database, migrationsDirectory, applicationBuildId) {
  return applyMigrations({
    database,
    migrations: discoverMigrations({ migrationsDirectory }),
    applicationBuildId,
    now: () => 1_000,
  });
}

function copyBaseMigrations(runtime) {
  copyMigration("0001_initial.sql", runtime.migrationsDirectory);
  copyMigration(
    "0002_add_pending_credential_setup_user_status.sql",
    runtime.migrationsDirectory
  );
}

function copyWorkflowMigration(runtime) {
  copyMigration(
    "0003_add_league_invitation_team_workflow.sql",
    runtime.migrationsDirectory
  );
}

function seedAuthorityRows(database) {
  const ids = {
    invitingUser: uuid(1),
    invitedUser: uuid(2),
    leagueA: uuid(10),
    leagueB: uuid(11),
    membershipA: uuid(20),
    teamA: uuid(30),
    teamB: uuid(31),
  };
  database
    .prepare(`
      INSERT INTO users (
        id, email_normalized, email_display, display_name,
        display_name_normalized, status, created_at_ms, updated_at_ms
      ) VALUES
        (?, 'commissioner@example.test', 'commissioner@example.test',
          'Commissioner', 'commissioner', 'active', 10, 10),
        (?, 'invitee@example.test', 'invitee@example.test',
          'Invitee', 'invitee', 'active', 10, 10)
    `)
    .run(ids.invitingUser, ids.invitedUser);
  database
    .prepare(`
      INSERT INTO leagues (
        id, name, name_normalized, status, timezone,
        created_at_ms, updated_at_ms
      ) VALUES
        (?, 'League A', 'league a', 'setup', 'America/Vancouver', 10, 10),
        (?, 'League B', 'league b', 'setup', 'America/Vancouver', 10, 10)
    `)
    .run(ids.leagueA, ids.leagueB);
  database
    .prepare(`
      INSERT INTO league_memberships (
        id, league_id, user_id, permission_category, status,
        joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'manager', 'invited', NULL, NULL, 10, 10)
    `)
    .run(ids.membershipA, ids.leagueA, ids.invitedUser);
  database
    .prepare(`
      INSERT INTO teams (
        id, league_id, name, name_normalized, status,
        primary_colour, secondary_colour, logo_reference,
        created_at_ms, updated_at_ms
      ) VALUES
        (?, ?, 'Team A', 'team a', 'setup', NULL, NULL, NULL, 10, 10),
        (?, ?, 'Team B', 'team b', 'setup', NULL, NULL, NULL, 10, 10)
    `)
    .run(ids.teamA, ids.leagueA, ids.teamB, ids.leagueB);
  return ids;
}

function insertInvitation(database, values) {
  database
    .prepare(`
      INSERT INTO league_invitations (
        id, league_id, invited_email_normalized, invited_user_id,
        inviting_user_id, membership_id, workflow, team_id, status,
        created_at_ms, expires_at_ms, accepted_at_ms, version
      ) VALUES (
        @id, @leagueId, @email, @invitedUserId,
        @invitingUserId, @membershipId, @workflow, @teamId, 'pending',
        20, 9223372036854775807, NULL, 1
      )
    `)
    .run(values);
}

describe("M3-15 league invitation workflow migration", () => {
  test("upgrades existing commissioner proposals without reclassifying them", (t) => {
    const runtime = createRuntime(t, "hundo-leago-m3-15-upgrade-");
    copyBaseMigrations(runtime);
    migrate(runtime.database, runtime.migrationsDirectory, "m3-15-before");
    const ids = seedAuthorityRows(runtime.database);
    const invitationId = uuid(40);
    runtime.database
      .prepare(`
        INSERT INTO league_invitations (
          id, league_id, invited_email_normalized, invited_user_id,
          inviting_user_id, membership_id, status, created_at_ms,
          expires_at_ms, accepted_at_ms, version
        ) VALUES (?, ?, 'invitee@example.test', ?, ?, ?, 'pending',
          20, 9223372036854775807, NULL, 4)
      `)
      .run(
        invitationId,
        ids.leagueA,
        ids.invitedUser,
        ids.invitingUser,
        ids.membershipA
      );

    copyWorkflowMigration(runtime);
    const result = migrate(
      runtime.database,
      runtime.migrationsDirectory,
      "m3-15-upgrade"
    );

    assert.equal(result.applied.length, 3);
    assert.equal(runtime.database.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT id, league_id AS leagueId, membership_id AS membershipId,
            workflow, team_id AS teamId, status, version
          FROM league_invitations WHERE id = ?
        `)
        .get(invitationId),
      {
        id: invitationId,
        leagueId: ids.leagueA,
        membershipId: ids.membershipA,
        workflow: null,
        teamId: null,
        status: "pending",
        version: 4,
      }
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
    assert.equal(runtime.database.pragma("foreign_keys", { simple: true }), 1);
  });

  test("accepts only the approved workflow and target-team combinations", (t) => {
    const runtime = createRuntime(t, "hundo-leago-m3-15-contract-");
    copyBaseMigrations(runtime);
    copyWorkflowMigration(runtime);
    migrate(runtime.database, runtime.migrationsDirectory, "m3-15-contract");
    const ids = seedAuthorityRows(runtime.database);

    insertInvitation(runtime.database, {
      id: uuid(41),
      leagueId: ids.leagueA,
      email: "create@example.test",
      invitedUserId: ids.invitedUser,
      invitingUserId: ids.invitingUser,
      membershipId: ids.membershipA,
      workflow: "create_team",
      teamId: null,
    });
    insertInvitation(runtime.database, {
      id: uuid(42),
      leagueId: ids.leagueA,
      email: "manage@example.test",
      invitedUserId: ids.invitedUser,
      invitingUserId: ids.invitingUser,
      membershipId: ids.membershipA,
      workflow: "manage_team",
      teamId: ids.teamA,
    });
    runtime.database
      .prepare(`
        UPDATE league_invitations
        SET status = 'accepted', team_id = ?, accepted_at_ms = 30
        WHERE id = ?
      `)
      .run(ids.teamA, uuid(41));

    for (const invalid of [
      { id: uuid(50), workflow: "create_team", teamId: ids.teamA },
      { id: uuid(51), workflow: "manage_team", teamId: null },
      { id: uuid(52), workflow: "membership_only", teamId: null },
    ]) {
      assert.throws(
        () =>
          insertInvitation(runtime.database, {
            id: invalid.id,
            leagueId: ids.leagueA,
            email: `${invalid.workflow}-${String(invalid.teamId)}@example.test`,
            invitedUserId: ids.invitedUser,
            invitingUserId: ids.invitingUser,
            membershipId: ids.membershipA,
            workflow: invalid.workflow,
            teamId: invalid.teamId,
          }),
        /constraint failed/i
      );
    }
    assert.throws(
      () =>
        insertInvitation(runtime.database, {
          id: uuid(60),
          leagueId: ids.leagueA,
          email: "cross-league@example.test",
          invitedUserId: ids.invitedUser,
          invitingUserId: ids.invitingUser,
          membershipId: ids.membershipA,
          workflow: "manage_team",
          teamId: ids.teamB,
        }),
      /FOREIGN KEY constraint failed/
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM league_invitations")
        .get().count,
      2
    );
  });

  test("restores both invitation indexes and advances only schema metadata", (t) => {
    const runtime = createRuntime(t, "hundo-leago-m3-15-metadata-");
    copyBaseMigrations(runtime);
    copyWorkflowMigration(runtime);
    migrate(runtime.database, runtime.migrationsDirectory, "m3-15-metadata");

    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT metadata_key AS key, metadata_value AS value
          FROM application_metadata ORDER BY metadata_key
        `)
        .all(),
      [
        { key: "application_compatibility_version", value: "1" },
        { key: "data_model_version", value: "3" },
      ]
    );
    const indexes = runtime.database
      .pragma("index_list(league_invitations)")
      .map(({ name }) => name);
    assert(indexes.includes("league_invitations_one_pending_email"));
    assert(indexes.includes("league_invitations_league_status"));
    assert.equal(runtime.database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });
});
