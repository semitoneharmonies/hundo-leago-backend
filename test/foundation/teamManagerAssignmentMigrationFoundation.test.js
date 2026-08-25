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

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-17-migration-")
  );
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

function copyThroughInvitationWorkflow(runtime) {
  for (const fileName of [
    "0001_initial.sql",
    "0002_add_pending_credential_setup_user_status.sql",
    "0003_add_league_invitation_team_workflow.sql",
  ]) {
    copyMigration(fileName, runtime.migrationsDirectory);
  }
}

function seedAuthority(database) {
  const ids = Object.freeze({
    commissioner: uuid(1),
    managerA: uuid(2),
    managerB: uuid(3),
    leagueA: uuid(10),
    leagueB: uuid(11),
    membershipA: uuid(20),
    membershipB: uuid(21),
    membershipOther: uuid(22),
    teamA: uuid(30),
    teamB: uuid(31),
    acceptedA: uuid(40),
    acceptedB: uuid(41),
    pendingA: uuid(42),
  });
  database
    .prepare(`
      INSERT INTO users (
        id, email_normalized, email_display, display_name,
        display_name_normalized, status, created_at_ms, updated_at_ms
      ) VALUES
        (?, 'commissioner@example.test', 'commissioner@example.test',
          'Commissioner', 'commissioner', 'active', 10, 10),
        (?, 'manager-a@example.test', 'manager-a@example.test',
          'Manager A', 'manager a', 'active', 10, 10),
        (?, 'manager-b@example.test', 'manager-b@example.test',
          'Manager B', 'manager b', 'active', 10, 10)
    `)
    .run(ids.commissioner, ids.managerA, ids.managerB);
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
      ) VALUES
        (?, ?, ?, 'manager', 'active', 10, NULL, 10, 10),
        (?, ?, ?, 'manager', 'active', 10, NULL, 10, 10),
        (?, ?, ?, 'manager', 'active', 10, NULL, 10, 10)
    `)
    .run(
      ids.membershipA,
      ids.leagueA,
      ids.managerA,
      ids.membershipB,
      ids.leagueA,
      ids.managerB,
      ids.membershipOther,
      ids.leagueB,
      ids.managerB
    );
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
  const insertAssignment = database.prepare(`
    INSERT INTO team_manager_assignments (
      id, league_id, team_id, user_id, membership_id,
      assigned_by_user_id, status, assigned_at_ms, accepted_at_ms,
      ended_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 20, ?, NULL, ?)
  `);
  insertAssignment.run(
    ids.acceptedA,
    ids.leagueA,
    ids.teamA,
    ids.managerA,
    ids.membershipA,
    ids.commissioner,
    "accepted",
    21,
    3
  );
  insertAssignment.run(
    ids.acceptedB,
    ids.leagueB,
    ids.teamB,
    ids.managerB,
    ids.membershipOther,
    ids.commissioner,
    "accepted",
    21,
    1
  );
  insertAssignment.run(
    ids.pendingA,
    ids.leagueA,
    ids.teamA,
    ids.managerB,
    ids.membershipB,
    ids.commissioner,
    "pending",
    null,
    2
  );
  return ids;
}

function insertTransfer(database, {
  id,
  leagueId,
  teamId,
  userId,
  membershipId,
  commissionerId,
  replacesAssignmentId,
}) {
  database
    .prepare(`
      INSERT INTO team_manager_assignments (
        id, league_id, team_id, user_id, membership_id,
        assigned_by_user_id, replaces_assignment_id, status,
        assigned_at_ms, accepted_at_ms, ended_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 30, NULL, NULL, 1)
    `)
    .run(
      id,
      leagueId,
      teamId,
      userId,
      membershipId,
      commissionerId,
      replacesAssignmentId
    );
}

describe("M3-17 manager-transfer intent migration", () => {
  test("preserves every existing assignment with null transfer intent", (t) => {
    const runtime = createRuntime(t);
    copyThroughInvitationWorkflow(runtime);
    migrate(runtime, "m3-17-before");
    const ids = seedAuthority(runtime.database);
    const before = runtime.database
      .prepare(`
        SELECT id, league_id, team_id, user_id, membership_id,
          assigned_by_user_id, status, assigned_at_ms, accepted_at_ms,
          ended_at_ms, version
        FROM team_manager_assignments ORDER BY id
      `)
      .all();

    copyMigration(
      "0004_add_manager_transfer_intent.sql",
      runtime.migrationsDirectory
    );
    const result = migrate(runtime, "m3-17-upgrade");

    assert.equal(result.applied.length, 4);
    assert.equal(runtime.database.pragma("user_version", { simple: true }), 4);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT id, league_id, team_id, user_id, membership_id,
            assigned_by_user_id, status, assigned_at_ms, accepted_at_ms,
            ended_at_ms, version
          FROM team_manager_assignments ORDER BY id
        `)
        .all(),
      before
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT id, replaces_assignment_id
          FROM team_manager_assignments ORDER BY id
        `)
        .all(),
      [ids.acceptedA, ids.acceptedB, ids.pendingA].sort().map((id) => ({
        id,
        replaces_assignment_id: null,
      }))
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "4"
    );
    const indexes = runtime.database
      .pragma("index_list(team_manager_assignments)")
      .map(({ name }) => name);
    assert(indexes.includes("team_manager_assignments_one_active_manager"));
    assert(indexes.includes("team_manager_assignments_league_team"));
    assert.equal(runtime.database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("accepts only a known same-league non-self replacement reference", (t) => {
    const runtime = createRuntime(t);
    copyThroughInvitationWorkflow(runtime);
    copyMigration(
      "0004_add_manager_transfer_intent.sql",
      runtime.migrationsDirectory
    );
    migrate(runtime, "m3-17-contract");
    const ids = seedAuthority(runtime.database);

    insertTransfer(runtime.database, {
      id: uuid(50),
      leagueId: ids.leagueA,
      teamId: ids.teamA,
      userId: ids.managerB,
      membershipId: ids.membershipB,
      commissionerId: ids.commissioner,
      replacesAssignmentId: ids.acceptedA,
    });
    for (const [id, replacement] of [
      [uuid(51), ids.acceptedB],
      [uuid(52), uuid(999)],
      [uuid(53), uuid(53)],
    ]) {
      assert.throws(
        () =>
          insertTransfer(runtime.database, {
            id,
            leagueId: ids.leagueA,
            teamId: ids.teamA,
            userId: ids.managerB,
            membershipId: ids.membershipB,
            commissionerId: ids.commissioner,
            replacesAssignmentId: replacement,
          }),
        /constraint failed/i
      );
    }
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count FROM team_manager_assignments
          WHERE replaces_assignment_id IS NOT NULL
        `)
        .get().count,
      1
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });
});
