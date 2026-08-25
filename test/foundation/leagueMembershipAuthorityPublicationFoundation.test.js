const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createSocketAuthorizationService,
} = require(
  "../../src/application/services/authorization/createSocketAuthorizationService"
);
const {
  LeagueMembershipConflictError,
  createLeagueMembershipService,
} = require(
  "../../src/application/services/leagues/createLeagueMembershipService"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLeagueAccessRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository"
);
const {
  createSqliteLeagueOutboxWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxWriter"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteTeamAuthorityRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository"
);
const {
  assertCanonicalAuthorityPublication,
  readCanonicalAuthorityPublications,
} = require("../helpers/canonicalAuthorityPublication");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-08-10T18:00:00.000Z");
const ENDED_AT_MS = NOW_MS + 500;
const COMMISSIONER_ID = "00000000-0000-4000-8000-000000000001";
const MANAGER_ID = "00000000-0000-4000-8000-000000000002";
const LEAGUE_A_ID = "00000000-0000-4000-8000-000000000010";
const LEAGUE_B_ID = "00000000-0000-4000-8000-000000000011";
const COMMISSIONER_A_MEMBERSHIP_ID =
  "00000000-0000-4000-8000-000000000020";
const COMMISSIONER_B_MEMBERSHIP_ID =
  "00000000-0000-4000-8000-000000000021";
const MANAGER_A_MEMBERSHIP_ID =
  "00000000-0000-4000-8000-000000000022";
const MANAGER_B_MEMBERSHIP_ID =
  "00000000-0000-4000-8000-000000000023";
const TEAM_A_ONE_ID = "00000000-0000-4000-8000-000000000030";
const TEAM_A_TWO_ID = "00000000-0000-4000-8000-000000000031";
const TEAM_B_ID = "00000000-0000-4000-8000-000000000032";
const ASSIGNMENT_A_ONE_ID =
  "00000000-0000-4000-8000-000000000040";
const ASSIGNMENT_A_TWO_ID =
  "00000000-0000-4000-8000-000000000041";
const ASSIGNMENT_B_ID = "00000000-0000-4000-8000-000000000042";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function insertUser(context, { id, email, displayName }) {
  return context.repositories.users.insert({
    id,
    email_normalized: email,
    email_display: email,
    display_name: displayName,
    display_name_normalized: displayName.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertLeague(context, { id, name }) {
  context.repositories.leagues.insert({
    id,
    name,
    name_normalized: name.toLowerCase(),
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.league_settings.insert({
    league_id: id,
    salary_cap_cents: 10_000,
    trade_deadline_at_ms: null,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertMembership(context, {
  id,
  leagueId,
  userId,
  permissionCategory,
}) {
  return context.repositories.league_memberships.insert({
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertTeam(context, { id, leagueId, name }) {
  return context.repositories.teams.insert({
    id,
    league_id: leagueId,
    name,
    name_normalized: name.toLowerCase(),
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertAssignment(context, {
  id,
  leagueId,
  teamId,
  membershipId,
  status,
}) {
  return context.repositories.team_manager_assignments.insert({
    id,
    league_id: leagueId,
    team_id: teamId,
    user_id: MANAGER_ID,
    membership_id: membershipId,
    assigned_by_user_id: COMMISSIONER_ID,
    replaces_assignment_id: null,
    status,
    assigned_at_ms: NOW_MS,
    accepted_at_ms: status === "accepted" ? NOW_MS : null,
    ended_at_ms: null,
    version: 1,
  });
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad14-membership-authority-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad14-membership-authority-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  insertUser(context, {
    id: COMMISSIONER_ID,
    email: "commissioner@example.test",
    displayName: "Commissioner",
  });
  insertUser(context, {
    id: MANAGER_ID,
    email: "manager@example.test",
    displayName: "Manager",
  });
  insertLeague(context, { id: LEAGUE_A_ID, name: "Alpha League" });
  insertLeague(context, { id: LEAGUE_B_ID, name: "Bravo League" });
  insertMembership(context, {
    id: COMMISSIONER_A_MEMBERSHIP_ID,
    leagueId: LEAGUE_A_ID,
    userId: COMMISSIONER_ID,
    permissionCategory: "commissioner",
  });
  insertMembership(context, {
    id: COMMISSIONER_B_MEMBERSHIP_ID,
    leagueId: LEAGUE_B_ID,
    userId: COMMISSIONER_ID,
    permissionCategory: "commissioner",
  });
  insertMembership(context, {
    id: MANAGER_A_MEMBERSHIP_ID,
    leagueId: LEAGUE_A_ID,
    userId: MANAGER_ID,
    permissionCategory: "manager",
  });
  insertMembership(context, {
    id: MANAGER_B_MEMBERSHIP_ID,
    leagueId: LEAGUE_B_ID,
    userId: MANAGER_ID,
    permissionCategory: "manager",
  });
  for (const [leagueId, membershipId] of [
    [LEAGUE_A_ID, COMMISSIONER_A_MEMBERSHIP_ID],
    [LEAGUE_B_ID, COMMISSIONER_B_MEMBERSHIP_ID],
  ]) {
    const league = context.repositories.leagues.findByKey({ key: leagueId });
    context.repositories.leagues.updateVersioned({
      key: leagueId,
      expectedVersion: league.version,
      changes: {
        commissioner_membership_id: membershipId,
        updated_at_ms: NOW_MS,
      },
    });
  }
  insertTeam(context, {
    id: TEAM_A_ONE_ID,
    leagueId: LEAGUE_A_ID,
    name: "Alpha One",
  });
  insertTeam(context, {
    id: TEAM_A_TWO_ID,
    leagueId: LEAGUE_A_ID,
    name: "Alpha Two",
  });
  insertTeam(context, {
    id: TEAM_B_ID,
    leagueId: LEAGUE_B_ID,
    name: "Bravo One",
  });

  let nextId = 900;
  const secureRandom = { id: () => uuid(nextId++) };
  return {
    accessRepository: createSqliteLeagueAccessRepository({
      database: connection.database,
    }),
    context,
    database: connection.database,
    secureRandom,
  };
}

function createService(runtime, accessRepository = runtime.accessRepository) {
  return createLeagueMembershipService({
    leagueAuthorization: {
      requireCommissioner(_authenticated, leagueId) {
        assert.equal(leagueId, LEAGUE_A_ID);
        return {
          actorUserId: COMMISSIONER_ID,
          membershipId: COMMISSIONER_A_MEMBERSHIP_ID,
        };
      },
    },
    leagueAccessRepository: accessRepository,
    clock: { nowMs: () => ENDED_AT_MS },
    secureRandom: runtime.secureRandom,
  });
}

function removeCommand(overrides = {}) {
  return {
    authenticated: {},
    leagueId: LEAGUE_A_ID,
    membershipId: MANAGER_A_MEMBERSHIP_ID,
    input: { confirmed: true, expectedVersion: 1 },
    ...overrides,
  };
}

function insertLeagueAAssignments(runtime) {
  insertAssignment(runtime.context, {
    id: ASSIGNMENT_A_ONE_ID,
    leagueId: LEAGUE_A_ID,
    teamId: TEAM_A_ONE_ID,
    membershipId: MANAGER_A_MEMBERSHIP_ID,
    status: "accepted",
  });
  insertAssignment(runtime.context, {
    id: ASSIGNMENT_A_TWO_ID,
    leagueId: LEAGUE_A_ID,
    teamId: TEAM_A_TWO_ID,
    membershipId: MANAGER_A_MEMBERSHIP_ID,
    status: "pending",
  });
}

function assignmentRows(database) {
  return database
    .prepare(`
      SELECT id, league_id, team_id, status, ended_at_ms, version
      FROM team_manager_assignments
      ORDER BY league_id, team_id, id
    `)
    .all();
}

describe("FAD-14 membership authority-change publications", () => {
  test("protects an active platform administrator membership from commissioner removal", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.platform_roles.insert({
      id: uuid(899),
      user_id: MANAGER_ID,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: COMMISSIONER_ID,
      granted_at_ms: NOW_MS,
      ended_at_ms: null,
      version: 1,
    });
    const before = runtime.database.serialize();

    assert.throws(
      () => createService(runtime).remove(removeCommand()),
      (error) =>
        error instanceof LeagueMembershipConflictError &&
        error.code === "PLATFORM_ADMINISTRATOR_MEMBERSHIP_PROTECTED"
    );
    assert(before.equals(runtime.database.serialize()));
  });

  test("publishes one exact membership event with no assignments and rejects retry or stale CAS without duplicates", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const result = service.remove(removeCommand());

    assert.deepEqual(result, {
      code: "LEAGUE_MEMBERSHIP_REMOVED",
      membership: {
        id: MANAGER_A_MEMBERSHIP_ID,
        status: "ended",
        endedAtMs: ENDED_AT_MS,
        version: 2,
      },
    });
    assert.equal(assignmentRows(runtime.database).length, 0);
    const publications = readCanonicalAuthorityPublications(
      runtime.database
    );
    assert.equal(publications.length, 1);
    assertCanonicalAuthorityPublication(publications[0], {
      leagueId: LEAGUE_A_ID,
      eventType: "league.changed",
      aggregateType: "league_membership",
      resourceId: MANAGER_A_MEMBERSHIP_ID,
      resourceVersion: 2,
      reasonCode: "membership_changed",
      occurredAtMs: ENDED_AT_MS,
    });
    const activity = runtime.database
      .prepare(`
        SELECT event_type, actor_user_id, actor_authority,
          related_type, related_id, metadata_json, occurred_at_ms
        FROM league_activity
      `)
      .get();
    assert.deepEqual(
      {
        ...activity,
        metadata_json: JSON.parse(activity.metadata_json),
      },
      {
        event_type: "league_membership_ended",
        actor_user_id: COMMISSIONER_ID,
        actor_authority: "commissioner",
        related_type: "league_membership",
        related_id: MANAGER_A_MEMBERSHIP_ID,
        metadata_json: {
          membershipId: MANAGER_A_MEMBERSHIP_ID,
          removedUserId: MANAGER_ID,
        },
        occurred_at_ms: ENDED_AT_MS,
      }
    );

    assert.throws(
      () => service.remove(removeCommand()),
      (error) =>
        error instanceof LeagueMembershipConflictError &&
        error.code === "LEAGUE_MEMBERSHIP_STALE"
    );
    assert.equal(
      readCanonicalAuthorityPublications(runtime.database).length,
      1
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM league_activity")
        .get().count,
      1
    );

    const stale = createRuntime(t);
    assert.throws(
      () =>
        stale.accessRepository.endMembership({
          leagueId: LEAGUE_A_ID,
          membershipId: MANAGER_A_MEMBERSHIP_ID,
          actorUserId: COMMISSIONER_ID,
          activityId: uuid(950),
          publicationId: uuid(951),
          expectedVersion: 2,
          occurredAtMs: ENDED_AT_MS,
        }),
      (error) => error.code === "REPOSITORY_VERSION_CONFLICT"
    );
    assert.equal(
      readCanonicalAuthorityPublications(stale.database).length,
      0
    );
    assert.equal(
      stale.database
        .prepare("SELECT COUNT(*) AS count FROM league_activity")
        .get().count,
      0
    );
  });

  test("ends and publishes every linked team assignment without crossing leagues, then removes private Socket authority", (t) => {
    const runtime = createRuntime(t);
    insertLeagueAAssignments(runtime);
    insertAssignment(runtime.context, {
      id: ASSIGNMENT_B_ID,
      leagueId: LEAGUE_B_ID,
      teamId: TEAM_B_ID,
      membershipId: MANAGER_B_MEMBERSHIP_ID,
      status: "accepted",
    });

    const teamAuthorityRepository =
      createSqliteTeamAuthorityRepository({
        database: runtime.database,
      });
    const socketAuthorization = createSocketAuthorizationService({
      isAllowedOrigin: (origin) => origin === "https://hundo.example",
      sessionCookie: { read: () => "manager-session" },
      sessionService: {
        resolveWithoutActivity: () => ({ valid: true }),
      },
      leagueAuthorization: {
        requireActiveUser: () => ({ actorUserId: MANAGER_ID }),
      },
      leagueAccessRepository: runtime.accessRepository,
      teamAuthorityRepository,
    });
    const handshake = {
      headers: {
        origin: "https://hundo.example",
        cookie: "session=manager-session",
      },
    };
    assert.deepEqual(socketAuthorization.authorizeHandshake(handshake).rooms, [
      `user:${MANAGER_ID}`,
      `league:${LEAGUE_A_ID}`,
      `league:${LEAGUE_B_ID}`,
      `team:${TEAM_A_ONE_ID}`,
      `team:${TEAM_B_ID}`,
    ]);

    createService(runtime).remove(removeCommand());

    assert.deepEqual(assignmentRows(runtime.database), [
      {
        id: ASSIGNMENT_A_ONE_ID,
        league_id: LEAGUE_A_ID,
        team_id: TEAM_A_ONE_ID,
        status: "ended",
        ended_at_ms: ENDED_AT_MS,
        version: 2,
      },
      {
        id: ASSIGNMENT_A_TWO_ID,
        league_id: LEAGUE_A_ID,
        team_id: TEAM_A_TWO_ID,
        status: "ended",
        ended_at_ms: ENDED_AT_MS,
        version: 2,
      },
      {
        id: ASSIGNMENT_B_ID,
        league_id: LEAGUE_B_ID,
        team_id: TEAM_B_ID,
        status: "accepted",
        ended_at_ms: null,
        version: 1,
      },
    ]);
    const publications = readCanonicalAuthorityPublications(
      runtime.database
    );
    assert.equal(publications.length, 3);
    assert.equal(
      publications.every(({ leagueId }) => leagueId === LEAGUE_A_ID),
      true
    );
    const membershipPublication = publications.find(
      ({ payload }) => payload.reasonCode === "membership_changed"
    );
    assertCanonicalAuthorityPublication(membershipPublication, {
      leagueId: LEAGUE_A_ID,
      eventType: "league.changed",
      aggregateType: "league_membership",
      resourceId: MANAGER_A_MEMBERSHIP_ID,
      resourceVersion: 2,
      reasonCode: "membership_changed",
      occurredAtMs: ENDED_AT_MS,
    });
    for (const [assignmentId, teamId] of [
      [ASSIGNMENT_A_ONE_ID, TEAM_A_ONE_ID],
      [ASSIGNMENT_A_TWO_ID, TEAM_A_TWO_ID],
    ]) {
      const publication = publications.find(
        ({ aggregateId }) => aggregateId === assignmentId
      );
      assertCanonicalAuthorityPublication(publication, {
        leagueId: LEAGUE_A_ID,
        eventType: "team.changed",
        aggregateType: "team_manager_assignment",
        resourceId: assignmentId,
        resourceVersion: 2,
        reasonCode: "manager_assignment_changed",
        occurredAtMs: ENDED_AT_MS,
        teamId,
      });
    }
    assert.deepEqual(socketAuthorization.authorizeHandshake(handshake).rooms, [
      `user:${MANAGER_ID}`,
      `league:${LEAGUE_B_ID}`,
      `team:${TEAM_B_ID}`,
    ]);
  });

  test("rolls membership, assignments, Activity, events, and audiences back after a partial publication failure", (t) => {
    const runtime = createRuntime(t);
    insertLeagueAAssignments(runtime);
    const realWriter = createSqliteLeagueOutboxWriter({
      database: runtime.database,
    });
    let publicationCalls = 0;
    const failingWriter = {
      write(event) {
        const result = realWriter.write(event);
        publicationCalls += 1;
        if (publicationCalls === 2) {
          throw new Error("injected membership publication failure");
        }
        return result;
      },
    };
    const accessRepository = createSqliteLeagueAccessRepository({
      database: runtime.database,
      leagueOutboxWriter: failingWriter,
    });
    const beforeAssignments = assignmentRows(runtime.database);

    assert.throws(
      () => createService(runtime, accessRepository).remove(removeCommand()),
      /repository operation failed/i
    );
    assert.equal(publicationCalls, 2);
    assert.deepEqual(assignmentRows(runtime.database), beforeAssignments);
    assert.deepEqual(
      runtime.database
        .prepare(
          "SELECT status, ended_at_ms, version FROM league_memberships WHERE id = ?"
        )
        .get(MANAGER_A_MEMBERSHIP_ID),
      { status: "active", ended_at_ms: null, version: 1 }
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM league_activity")
        .get().count,
      0
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM outbox_events")
        .get().count,
      0
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM outbox_event_audiences")
        .get().count,
      0
    );
  });
});
