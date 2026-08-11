const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const express = require("express");

const {
  TeamManagerAssignmentConflictError,
  TeamManagerAssignmentNotFoundError,
  createTeamManagerAssignmentService,
} = require(
  "../../src/application/services/leagues/createTeamManagerAssignmentService"
);
const {
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  TeamManagerAssignmentPolicyError,
  validateDecisionInput,
  validateExpectedVersion,
  validateIdempotencyKey,
  validateProposalInput,
  validateRemovalInput,
} = require(
  "../../src/domain/leagues/teamManagerAssignmentPolicy"
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
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteSecurityAuditRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository"
);
const {
  createSqliteTeamManagerAssignmentRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamManagerAssignmentRepository"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createTargetRequestSecurity,
} = require("../../src/transport/http/createTargetRequestSecurity");
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");
const {
  assertCanonicalAuthorityPublication,
  readCanonicalAuthorityPublications,
} = require("../helpers/canonicalAuthorityPublication");
const {
  createTeamManagerAssignmentRouter,
  parseIfMatch,
} = require(
  "../../src/transport/http/createTeamManagerAssignmentRouter"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const NOW_MS = Date.parse("2026-07-21T12:00:00.000Z");
const COMMISSIONER_ID = "00000000-0000-4000-8000-000000000001";
const MANAGER_A_ID = "00000000-0000-4000-8000-000000000002";
const MANAGER_B_ID = "00000000-0000-4000-8000-000000000003";
const OUTSIDER_ID = "00000000-0000-4000-8000-000000000004";
const LEAGUE_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_LEAGUE_ID = "00000000-0000-4000-8000-000000000011";
const TEAM_A_ID = "00000000-0000-4000-8000-000000000020";
const TEAM_B_ID = "00000000-0000-4000-8000-000000000021";
const OTHER_TEAM_ID = "00000000-0000-4000-8000-000000000022";
const CURRENT_ASSIGNMENT_ID = "00000000-0000-4000-8000-000000000030";
const PUBLIC_FRONTEND_ORIGIN = "https://staging.hundo.example";
const SESSION_TOKENS = Object.freeze({
  [COMMISSIONER_ID]: Buffer.alloc(32, 0x61).toString("base64url"),
  [MANAGER_A_ID]: Buffer.alloc(32, 0x62).toString("base64url"),
  [MANAGER_B_ID]: Buffer.alloc(32, 0x63).toString("base64url"),
  [OUTSIDER_ID]: Buffer.alloc(32, 0x64).toString("base64url"),
});
const CSRF_TOKENS = Object.freeze({
  [COMMISSIONER_ID]: Buffer.alloc(32, 0x65).toString("base64url"),
  [MANAGER_A_ID]: Buffer.alloc(32, 0x66).toString("base64url"),
  [MANAGER_B_ID]: Buffer.alloc(32, 0x67).toString("base64url"),
  [OUTSIDER_ID]: Buffer.alloc(32, 0x68).toString("base64url"),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function sessionIdFor(userId) {
  return uuid(900 + Number(userId.slice(-1)));
}

function authenticated(userId) {
  return {
    valid: true,
    session: { id: sessionIdFor(userId), userId, version: 1 },
    user: { id: userId, status: "active", version: 1 },
  };
}

function insertUser(context, id, email, displayName) {
  context.repositories.users.insert({
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
  context.repositories.sessions.insert({
    id: sessionIdFor(id),
    user_id: id,
    token_digest: id.slice(-1).repeat(64),
    csrf_secret_digest: id.slice(-1).toUpperCase().repeat(64),
    status: "active",
    created_at_ms: NOW_MS,
    last_used_at_ms: NOW_MS,
    idle_expires_at_ms: NOW_MS + 60 * 60 * 1000,
    absolute_expires_at_ms: NOW_MS + 2 * 60 * 60 * 1000,
    revoked_at_ms: null,
    revocation_reason: null,
    client_metadata_json: null,
    version: 1,
  });
}

function insertLeague(context, id, name, status) {
  context.repositories.leagues.insert({
    id,
    name,
    name_normalized: name.toLowerCase(),
    status,
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.league_settings.insert({
    league_id: id,
    salary_cap_cents: 10000,
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

function insertMembership(context, id, leagueId, userId, permissionCategory) {
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

function insertTeam(context, id, leagueId, name) {
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

function insertAcceptedAssignment(context, {
  id = CURRENT_ASSIGNMENT_ID,
  leagueId = LEAGUE_ID,
  teamId = TEAM_A_ID,
  userId = MANAGER_A_ID,
  membershipId = uuid(41),
  version = 1,
} = {}) {
  return context.repositories.team_manager_assignments.insert({
    id,
    league_id: leagueId,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: COMMISSIONER_ID,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: NOW_MS,
    accepted_at_ms: NOW_MS,
    ended_at_ms: null,
    version,
  });
}

function createRuntime(t, { withCurrent = true, leagueStatus = "active" } = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-17-assignment-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-17-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  insertUser(context, COMMISSIONER_ID, "commissioner@example.test", "Commissioner");
  insertUser(context, MANAGER_A_ID, "manager-a@example.test", "Manager A");
  insertUser(context, MANAGER_B_ID, "manager-b@example.test", "Manager B");
  insertUser(context, OUTSIDER_ID, "outsider@example.test", "Outsider");
  insertLeague(context, LEAGUE_ID, "Assignment League", leagueStatus);
  insertLeague(context, OTHER_LEAGUE_ID, "Other League", "active");
  const commissionerMembership = insertMembership(
    context,
    uuid(40),
    LEAGUE_ID,
    COMMISSIONER_ID,
    "commissioner"
  );
  const managerAMembership = insertMembership(
    context,
    uuid(41),
    LEAGUE_ID,
    MANAGER_A_ID,
    "manager"
  );
  const managerBMembership = insertMembership(
    context,
    uuid(42),
    LEAGUE_ID,
    MANAGER_B_ID,
    "manager"
  );
  context.repositories.leagues.updateVersioned({
    key: LEAGUE_ID,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: commissionerMembership.id,
      updated_at_ms: NOW_MS,
    },
  });
  insertTeam(context, TEAM_A_ID, LEAGUE_ID, "Alpha Team");
  insertTeam(context, TEAM_B_ID, LEAGUE_ID, "Beta Team");
  insertTeam(context, OTHER_TEAM_ID, OTHER_LEAGUE_ID, "Other Team");
  if (withCurrent) insertAcceptedAssignment(context);

  const userRepository = createSqliteUserRepository({
    database: connection.database,
  });
  let nextId = 100;
  return {
    auditRepository: createSqliteSecurityAuditRepository({
      database: connection.database,
    }),
    assignmentRepository: createSqliteTeamManagerAssignmentRepository({
      database: connection.database,
    }),
    clock: { nowMs: () => NOW_MS + 100 },
    context,
    database: connection.database,
    leagueAuthorization: createLeagueAuthorizationService({
      userRepository,
      leagueAccessRepository: createSqliteLeagueAccessRepository({
        database: connection.database,
      }),
    }),
    managerAMembership,
    managerBMembership,
    secureRandom: { id: () => uuid(nextId++) },
    userRepository,
  };
}

function createService(runtime, overrides = {}) {
  return createTeamManagerAssignmentService({
    repositoryContext: runtime.context,
    leagueAuthorization: runtime.leagueAuthorization,
    userRepository: runtime.userRepository,
    assignmentRepository: runtime.assignmentRepository,
    auditRepository: runtime.auditRepository,
    clock: runtime.clock,
    secureRandom: runtime.secureRandom,
    ...overrides,
  });
}

function auditContext() {
  return {
    requestCorrelationId: "request-m3-17",
    networkKeyVersion: 1,
    networkMetadataDigest: "d".repeat(64),
    clientMetadataJson: JSON.stringify({
      networkSourceCategory: "unknown",
      origin: "https://hundo.example",
    }),
  };
}

function proposalCommand(userId = MANAGER_B_ID, overrides = {}) {
  return {
    leagueId: LEAGUE_ID,
    teamId: TEAM_A_ID,
    input: { userId },
    idempotencyKey: "manager-proposal",
    authenticated: authenticated(COMMISSIONER_ID),
    auditContext: auditContext(),
    ...overrides,
  };
}

function decisionCommand(assignmentId, userId, action, overrides = {}) {
  return {
    assignmentId,
    input: {},
    idempotencyKey: `manager-${action}`,
    authenticated: authenticated(userId),
    auditContext: auditContext(),
    ...overrides,
  };
}

function tableCount(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()
    .count;
}

function writeCounts(database) {
  return Object.fromEntries(
    [
      "team_manager_assignments",
      "notifications",
      "league_activity",
      "security_audit_events",
      "idempotency_requests",
    ].map((tableName) => [tableName, tableCount(database, tableName)])
  );
}

describe("M3-17 team-manager assignment policy", () => {
  test("accepts only exact proposal, decision, removal, key, and version inputs", () => {
    assert.deepEqual(validateProposalInput({ userId: MANAGER_A_ID }), {
      userId: MANAGER_A_ID,
    });
    assert.deepEqual(validateDecisionInput({}), {});
    assert.deepEqual(validateRemovalInput({ assignmentId: CURRENT_ASSIGNMENT_ID }), {
      assignmentId: CURRENT_ASSIGNMENT_ID,
    });
    assert.equal(validateIdempotencyKey("opaque-key"), "opaque-key");
    assert.equal(validateExpectedVersion(1), 1);
    assert.equal(parseIfMatch({ get: () => '"17"' }), 17);
    for (const value of [undefined, "17", '"0"', '"01"', '"1.0"', '"9007199254740992"']) {
      assert.equal(parseIfMatch({ get: () => value }), null);
    }
    for (const callback of [
      () => validateProposalInput({ userId: "bad" }),
      () => validateProposalInput({ userId: MANAGER_A_ID, role: "manager" }),
      () => validateDecisionInput({ accepted: true }),
      () => validateRemovalInput({}),
      () => validateIdempotencyKey(" padded "),
      () => validateExpectedVersion(0),
    ]) {
      assert.throws(callback, TeamManagerAssignmentPolicyError);
    }
  });
});

describe("M3-17 active-member manager assignment", () => {
  test("proposes, privately reads, accepts, and replays an unassigned team atomically", (t) => {
    const runtime = createRuntime(t, { withCurrent: false });
    const service = createService(runtime);
    const proposed = service.propose(proposalCommand());
    assert.equal(proposed.code, "TEAM_MANAGER_ASSIGNMENT_PROPOSED");
    assert.equal(proposed.assignment.status, "pending");
    assert.equal(proposed.assignment.replacesAssignmentId, null);
    assert.equal(proposed.team.currentManager, null);
    assert.equal(proposed.proposedUser.id, MANAGER_B_ID);
    assert.equal(proposed.membership.id, runtime.managerBMembership.id);
    assert.deepEqual(writeCounts(runtime.database), {
      team_manager_assignments: 1,
      notifications: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
    const replay = service.propose(proposalCommand());
    assert.deepEqual(replay, proposed);
    assert.equal(replay.replayed, true);
    assert.throws(
      () => service.propose(proposalCommand(MANAGER_A_ID)),
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    assert.equal(
      service.read({
        assignmentId: proposed.assignment.id,
        authenticated: authenticated(MANAGER_B_ID),
      }).assignment.id,
      proposed.assignment.id
    );
    assert.throws(
      () =>
        service.read({
          assignmentId: proposed.assignment.id,
          authenticated: authenticated(MANAGER_A_ID),
        }),
      TeamManagerAssignmentNotFoundError
    );

    const accepted = service.accept(
      decisionCommand(proposed.assignment.id, MANAGER_B_ID, "accept")
    );
    assert.equal(accepted.assignment.status, "accepted");
    assert.equal(accepted.team.currentManager.userId, MANAGER_B_ID);
    assert.equal(accepted.team.currentManager.assignmentId, proposed.assignment.id);
    const publications = readCanonicalAuthorityPublications(
      runtime.database
    );
    assert.equal(publications.length, 1);
    assertCanonicalAuthorityPublication(publications[0], {
      leagueId: LEAGUE_ID,
      eventType: "team.changed",
      aggregateType: "team_manager_assignment",
      resourceId: accepted.assignment.id,
      resourceVersion: accepted.assignment.version,
      reasonCode: "manager_assignment_changed",
      occurredAtMs: NOW_MS + 100,
      teamId: TEAM_A_ID,
    });
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM league_memberships WHERE id = ?")
        .get(runtime.managerBMembership.id).status,
      "active"
    );
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(sessionIdFor(MANAGER_B_ID)).status,
      "active"
    );
    const acceptedReplay = service.accept(
      decisionCommand(proposed.assignment.id, MANAGER_B_ID, "accept")
    );
    assert.deepEqual(acceptedReplay, accepted);
    assert.equal(acceptedReplay.replayed, true);
    assert.equal(
      readCanonicalAuthorityPublications(runtime.database).length,
      1
    );
    assert.deepEqual(writeCounts(runtime.database), {
      team_manager_assignments: 1,
      notifications: 1,
      league_activity: 2,
      security_audit_events: 2,
      idempotency_requests: 2,
    });
    assert.equal(JSON.stringify(accepted).includes("@example.test"), false);
  });

  test("keeps the old manager authoritative until transfer acceptance, then swaps atomically", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const transfer = service.propose(proposalCommand());
    assert.equal(transfer.assignment.replacesAssignmentId, CURRENT_ASSIGNMENT_ID);
    assert.equal(transfer.team.currentManager.userId, MANAGER_A_ID);
    assert.equal(
      runtime.assignmentRepository.findCurrentAssignment({
        leagueId: LEAGUE_ID,
        teamId: TEAM_A_ID,
      }).user_id,
      MANAGER_A_ID
    );

    const accepted = service.accept(
      decisionCommand(transfer.assignment.id, MANAGER_B_ID, "accept")
    );
    assert.equal(accepted.team.currentManager.userId, MANAGER_B_ID);
    const publications = readCanonicalAuthorityPublications(
      runtime.database
    );
    assert.equal(publications.length, 1);
    assertCanonicalAuthorityPublication(publications[0], {
      leagueId: LEAGUE_ID,
      eventType: "team.changed",
      aggregateType: "team_manager_assignment",
      resourceId: accepted.assignment.id,
      resourceVersion: accepted.assignment.version,
      reasonCode: "manager_assignment_changed",
      occurredAtMs: NOW_MS + 100,
      teamId: TEAM_A_ID,
    });
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT id, status, ended_at_ms FROM team_manager_assignments
          ORDER BY assigned_at_ms, id
        `)
        .all(),
      [
        { id: CURRENT_ASSIGNMENT_ID, status: "ended", ended_at_ms: NOW_MS + 100 },
        { id: transfer.assignment.id, status: "accepted", ended_at_ms: null },
      ]
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM team_manager_assignments WHERE status = 'accepted' AND ended_at_ms IS NULL")
        .get().count,
      1
    );
  });

  test("authorizes one manager for two explicitly identified teams", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const second = service.propose(
      proposalCommand(MANAGER_A_ID, {
        teamId: TEAM_B_ID,
        idempotencyKey: "second-team-proposal",
      })
    );
    const accepted = service.accept(
      decisionCommand(second.assignment.id, MANAGER_A_ID, "accept", {
        idempotencyKey: "second-team-accept",
      })
    );
    assert.equal(accepted.team.id, TEAM_B_ID);
    assert.equal(accepted.team.currentManager.userId, MANAGER_A_ID);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT team_id FROM team_manager_assignments
          WHERE user_id = ? AND status = 'accepted' AND ended_at_ms IS NULL
          ORDER BY team_id
        `)
        .all(MANAGER_A_ID)
        .map(({ team_id: teamId }) => teamId),
      [TEAM_A_ID, TEAM_B_ID]
    );
  });

  test("decline leaves the current manager unchanged and stale transfer acceptance writes nothing", (t) => {
    const declinedRuntime = createRuntime(t);
    const declinedService = createService(declinedRuntime);
    const declinedProposal = declinedService.propose(proposalCommand());
    const declined = declinedService.decline(
      decisionCommand(declinedProposal.assignment.id, MANAGER_B_ID, "decline")
    );
    assert.equal(declined.assignment.status, "declined");
    assert.equal(declined.team.currentManager.userId, MANAGER_A_ID);
    assert.equal(
      readCanonicalAuthorityPublications(declinedRuntime.database).length,
      0
    );

    const staleRuntime = createRuntime(t);
    const staleService = createService(staleRuntime);
    const staleProposal = staleService.propose(proposalCommand());
    staleRuntime.assignmentRepository.endAssignment({
      leagueId: LEAGUE_ID,
      assignmentId: CURRENT_ASSIGNMENT_ID,
      expectedVersion: 1,
      nowMs: NOW_MS + 50,
    });
    const before = writeCounts(staleRuntime.database);
    assert.throws(
      () =>
        staleService.accept(
          decisionCommand(staleProposal.assignment.id, MANAGER_B_ID, "accept")
        ),
      (error) => error.code === "TEAM_MANAGER_TRANSFER_STALE"
    );
    assert.deepEqual(writeCounts(staleRuntime.database), before);
    assert.equal(
      staleRuntime.database
        .prepare("SELECT status FROM team_manager_assignments WHERE id = ?")
        .get(staleProposal.assignment.id).status,
      "pending"
    );
  });

  test("removes only the exact current assignment and preserves session and membership", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const removed = service.remove({
      leagueId: LEAGUE_ID,
      teamId: TEAM_A_ID,
      input: { assignmentId: CURRENT_ASSIGNMENT_ID },
      expectedVersion: 1,
      idempotencyKey: "manager-remove",
      authenticated: authenticated(COMMISSIONER_ID),
      auditContext: auditContext(),
    });
    assert.equal(removed.code, "TEAM_MANAGER_ASSIGNMENT_REMOVED");
    assert.equal(removed.assignment.status, "ended");
    assert.equal(removed.team.currentManager, null);
    const publications = readCanonicalAuthorityPublications(
      runtime.database
    );
    assert.equal(publications.length, 1);
    assertCanonicalAuthorityPublication(publications[0], {
      leagueId: LEAGUE_ID,
      eventType: "team.changed",
      aggregateType: "team_manager_assignment",
      resourceId: removed.assignment.id,
      resourceVersion: removed.assignment.version,
      reasonCode: "manager_assignment_changed",
      occurredAtMs: NOW_MS + 100,
      teamId: TEAM_A_ID,
    });
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM league_memberships WHERE id = ?")
        .get(runtime.managerAMembership.id).status,
      "active"
    );
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(sessionIdFor(MANAGER_A_ID)).status,
      "active"
    );
    const replay = service.remove({
      leagueId: LEAGUE_ID,
      teamId: TEAM_A_ID,
      input: { assignmentId: CURRENT_ASSIGNMENT_ID },
      expectedVersion: 1,
      idempotencyKey: "manager-remove",
      authenticated: authenticated(COMMISSIONER_ID),
      auditContext: auditContext(),
    });
    assert.deepEqual(replay, removed);
    assert.equal(replay.replayed, true);
    assert.equal(
      readCanonicalAuthorityPublications(runtime.database).length,
      1
    );

    const stale = createRuntime(t);
    const staleBefore = writeCounts(stale.database);
    assert.throws(
      () =>
        createService(stale).remove({
          leagueId: LEAGUE_ID,
          teamId: TEAM_A_ID,
          input: { assignmentId: uuid(999) },
          expectedVersion: 1,
          idempotencyKey: "stale-remove",
          authenticated: authenticated(COMMISSIONER_ID),
          auditContext: auditContext(),
        }),
      (error) =>
        error.code === "TEAM_MANAGER_ASSIGNMENT_PRECONDITION_FAILED"
    );
    assert.deepEqual(writeCounts(stale.database), staleBefore);
  });

  test("rejects ineligible, unauthorized, cross-league, duplicate, and rollback cases", (t) => {
    const outsider = createRuntime(t, { withCurrent: false });
    const outsiderBefore = writeCounts(outsider.database);
    assert.throws(
      () => createService(outsider).propose(proposalCommand(OUTSIDER_ID)),
      TeamManagerAssignmentConflictError
    );
    assert.deepEqual(writeCounts(outsider.database), outsiderBefore);

    const manager = createRuntime(t, { withCurrent: false });
    assert.throws(
      () =>
        createService(manager).propose(
          proposalCommand(MANAGER_B_ID, {
            authenticated: authenticated(MANAGER_A_ID),
          })
        ),
      (error) => error.code === "LEAGUE_COMMISSIONER_REQUIRED"
    );

    const crossLeague = createRuntime(t, { withCurrent: false });
    assert.throws(
      () =>
        createService(crossLeague).propose(
          proposalCommand(MANAGER_B_ID, { teamId: OTHER_TEAM_ID })
        ),
      TeamManagerAssignmentConflictError
    );

    const duplicate = createRuntime(t, { withCurrent: false });
    const duplicateService = createService(duplicate);
    duplicateService.propose(proposalCommand());
    const duplicateBefore = writeCounts(duplicate.database);
    assert.throws(
      () =>
        duplicateService.propose(
          proposalCommand(MANAGER_A_ID, {
            idempotencyKey: "second-manager-proposal",
          })
        ),
      TeamManagerAssignmentConflictError
    );
    assert.deepEqual(writeCounts(duplicate.database), duplicateBefore);

    for (const seam of [
      "insertPendingAssignment",
      "insertProposalNotification",
      "appendAssignmentActivity",
      "completeIdempotency",
    ]) {
      const runtime = createRuntime(t, { withCurrent: false });
      const before = writeCounts(runtime.database);
      assert.throws(
        () =>
          createService(runtime, {
            assignmentRepository: {
              ...runtime.assignmentRepository,
              [seam]() {
                throw new Error(`injected ${seam} failure`);
              },
            },
          }).propose(proposalCommand()),
        /repository operation failed/i
      );
      assert.deepEqual(writeCounts(runtime.database), before);
    }

    const auditFailure = createRuntime(t, { withCurrent: false });
    const auditBefore = writeCounts(auditFailure.database);
    assert.throws(
      () =>
        createService(auditFailure, {
          auditRepository: {
            append() {
              throw new Error("injected Security Audit failure");
            },
          },
        }).propose(proposalCommand()),
      /repository operation failed/i
    );
    assert.deepEqual(writeCounts(auditFailure.database), auditBefore);

    for (const seam of [
      "endAssignment",
      "acceptAssignment",
      "appendManagerAssignmentChangedPublication",
      "appendAssignmentActivity",
      "completeIdempotency",
    ]) {
      const runtime = createRuntime(t);
      const service = createService(runtime);
      const proposed = service.propose(proposalCommand());
      const before = writeCounts(runtime.database);
      const beforePublications = readCanonicalAuthorityPublications(
        runtime.database
      );
      assert.throws(
        () =>
          createService(runtime, {
            assignmentRepository: {
              ...runtime.assignmentRepository,
              [seam]() {
                throw new Error(`injected acceptance ${seam} failure`);
              },
            },
          }).accept(
            decisionCommand(proposed.assignment.id, MANAGER_B_ID, "accept")
          ),
        /repository operation failed/i
      );
      assert.deepEqual(writeCounts(runtime.database), before);
      assert.deepEqual(
        readCanonicalAuthorityPublications(runtime.database),
        beforePublications
      );
      assert.equal(
        runtime.assignmentRepository.findCurrentAssignment({
          leagueId: LEAGUE_ID,
          teamId: TEAM_A_ID,
        }).id,
        CURRENT_ASSIGNMENT_ID
      );
      assert.equal(
        runtime.database
          .prepare("SELECT status FROM team_manager_assignments WHERE id = ?")
          .get(proposed.assignment.id).status,
        "pending"
      );
    }

    for (const seam of [
      "endAssignment",
      "appendManagerAssignmentChangedPublication",
      "appendAssignmentActivity",
      "completeIdempotency",
    ]) {
      const runtime = createRuntime(t);
      const before = writeCounts(runtime.database);
      const beforePublications = readCanonicalAuthorityPublications(
        runtime.database
      );
      assert.throws(
        () =>
          createService(runtime, {
            assignmentRepository: {
              ...runtime.assignmentRepository,
              [seam]() {
                throw new Error(`injected removal ${seam} failure`);
              },
            },
          }).remove({
            leagueId: LEAGUE_ID,
            teamId: TEAM_A_ID,
            input: { assignmentId: CURRENT_ASSIGNMENT_ID },
            expectedVersion: 1,
            idempotencyKey: `manager-remove-${seam}`,
            authenticated: authenticated(COMMISSIONER_ID),
            auditContext: auditContext(),
          }),
        /repository operation failed/i
      );
      assert.deepEqual(writeCounts(runtime.database), before);
      assert.deepEqual(
        readCanonicalAuthorityPublications(runtime.database),
        beforePublications
      );
      assert.equal(
        runtime.assignmentRepository.findCurrentAssignment({
          leagueId: LEAGUE_ID,
          teamId: TEAM_A_ID,
        }).id,
        CURRENT_ASSIGNMENT_ID
      );
    }
  });
});

function httpHeaders(sessionCookie, userId, {
  csrfToken = CSRF_TOKENS[userId],
  idempotencyKey = "http-manager-assignment",
  ifMatch,
  includeCookie = true,
  origin = PUBLIC_FRONTEND_ORIGIN,
} = {}) {
  return {
    Origin: origin,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": idempotencyKey,
    ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
    ...(includeCookie
      ? {
          Cookie: `${sessionCookie.name}=${SESSION_TOKENS[userId]}`,
        }
      : {}),
  };
}

async function startTeamManagerAssignmentApi(t, runtime) {
  const sessionCookie = createSessionCookie({
    appEnv: "staging",
    publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    sameSite: "none",
  });
  const userByToken = new Map(
    Object.entries(SESSION_TOKENS).map(([userId, token]) => [token, userId])
  );
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin(origin) {
      return origin === PUBLIC_FRONTEND_ORIGIN;
    },
    requestIdFactory() {
      return "m3-17-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap(rawSessionToken) {
        const userId = userByToken.get(rawSessionToken);
        return userId
          ? authenticated(userId)
          : { valid: false, code: "SESSION_INVALID" };
      },
      resolveWithCsrf({ rawSessionToken, rawCsrfToken }) {
        const userId = userByToken.get(rawSessionToken);
        if (!userId) return { valid: false, code: "SESSION_INVALID" };
        if (rawCsrfToken !== CSRF_TOKENS[userId]) {
          return { valid: false, code: "CSRF_INVALID" };
        }
        return authenticated(userId);
      },
    },
  });
  const app = express();
  app.use(
    createTeamManagerAssignmentRouter({
      requestSecurity,
      teamManagerAssignmentService: createService(runtime),
      auditPrivacyDigest: {
        digest() {
          return { digest: "e".repeat(64), keyVersion: 1 };
        },
      },
      networkSourceResolver() {
        return "198.51.100.0/24";
      },
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    sessionCookie,
  };
}

describe("M3-17 isolated team-manager assignment HTTP contract", () => {
  test("proposes, privately reads, accepts, and removes through safe envelopes", async (t) => {
    const runtime = createRuntime(t);
    const api = await startTeamManagerAssignmentApi(t, runtime);
    const proposalUrl = new URL(
      `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_A_ID}/manager-assignment`,
      api.baseUrl
    );
    const commissionerHeaders = httpHeaders(
      api.sessionCookie,
      COMMISSIONER_ID,
      { idempotencyKey: "http-manager-propose" }
    );

    const proposed = await fetch(proposalUrl, {
      method: "POST",
      headers: commissionerHeaders,
      body: JSON.stringify({ userId: MANAGER_B_ID }),
    });
    const proposedBody = await proposed.json();
    assert.equal(proposed.status, 201);
    assert.equal(proposed.headers.get("cache-control"), "no-store");
    assert.equal(
      proposed.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );
    assert.equal(proposedBody.meta.requestId, "m3-17-request");
    assert.equal(
      proposedBody.data.code,
      "TEAM_MANAGER_ASSIGNMENT_PROPOSED"
    );
    assert.equal(
      proposedBody.data.team.currentManager.assignmentId,
      CURRENT_ASSIGNMENT_ID
    );
    assert.equal(JSON.stringify(proposedBody).includes("replayed"), false);

    const replay = await fetch(proposalUrl, {
      method: "POST",
      headers: commissionerHeaders,
      body: JSON.stringify({ userId: MANAGER_B_ID }),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).data, proposedBody.data);

    const assignmentId = proposedBody.data.assignment.id;
    const assignmentUrl = new URL(
      `/api/v1/team-manager-assignments/${assignmentId}`,
      api.baseUrl
    );
    const read = await fetch(assignmentUrl, {
      headers: httpHeaders(api.sessionCookie, MANAGER_B_ID),
    });
    const readBody = await read.json();
    assert.equal(read.status, 200);
    assert.equal(readBody.data.assignment.id, assignmentId);
    assert.equal(readBody.data.proposedUser.id, MANAGER_B_ID);

    const accepted = await fetch(
      new URL(
        `/api/v1/team-manager-assignments/${assignmentId}/accept`,
        api.baseUrl
      ),
      {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, MANAGER_B_ID, {
          idempotencyKey: "http-manager-accept",
        }),
        body: JSON.stringify({}),
      }
    );
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.data.assignment.status, "accepted");
    assert.equal(acceptedBody.data.team.currentManager.userId, MANAGER_B_ID);

    const removed = await fetch(proposalUrl, {
      method: "DELETE",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        idempotencyKey: "http-manager-remove",
        ifMatch: `"${acceptedBody.data.assignment.version}"`,
      }),
      body: JSON.stringify({ assignmentId }),
    });
    const removedBody = await removed.json();
    assert.equal(removed.status, 200);
    assert.equal(
      removedBody.data.code,
      "TEAM_MANAGER_ASSIGNMENT_REMOVED"
    );
    assert.equal(removedBody.data.assignment.status, "ended");
    assert.equal(removedBody.data.team.currentManager, null);
    assert.deepEqual(writeCounts(runtime.database), {
      team_manager_assignments: 2,
      notifications: 1,
      league_activity: 3,
      security_audit_events: 3,
      idempotency_requests: 3,
    });
  });

  test("maps malformed, hidden, security, authority, and stale failures without writes", async (t) => {
    const runtime = createRuntime(t);
    const api = await startTeamManagerAssignmentApi(t, runtime);
    const proposalUrl = new URL(
      `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_A_ID}/manager-assignment`,
      api.baseUrl
    );
    const assignmentUrl = new URL(
      `/api/v1/team-manager-assignments/${CURRENT_ASSIGNMENT_ID}`,
      api.baseUrl
    );
    const before = writeCounts(runtime.database);

    const malformedId = await fetch(
      new URL("/api/v1/team-manager-assignments/bad", api.baseUrl),
      { headers: httpHeaders(api.sessionCookie, MANAGER_A_ID) }
    );
    assert.equal(malformedId.status, 400);
    assert.equal(
      (await malformedId.json()).error.code,
      "TEAM_MANAGER_ASSIGNMENT_INVALID"
    );

    const hidden = await fetch(assignmentUrl, {
      headers: httpHeaders(api.sessionCookie, MANAGER_B_ID),
    });
    assert.equal(hidden.status, 404);
    assert.equal(
      (await hidden.json()).error.code,
      "TEAM_MANAGER_ASSIGNMENT_NOT_FOUND"
    );

    const signedOut = await fetch(assignmentUrl, {
      headers: httpHeaders(api.sessionCookie, MANAGER_A_ID, {
        includeCookie: false,
      }),
    });
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).error.code, "SESSION_REQUIRED");

    const invalidBody = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID),
      body: JSON.stringify({ userId: MANAGER_B_ID, accepted: true }),
    });
    assert.equal(invalidBody.status, 400);
    assert.equal(
      (await invalidBody.json()).error.code,
      "TEAM_MANAGER_ASSIGNMENT_INVALID"
    );

    const invalidJson = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID),
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(
      (await invalidJson.json()).error.code,
      "TEAM_MANAGER_ASSIGNMENT_INVALID"
    );

    const badCsrf = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        csrfToken: "invalid-csrf",
      }),
      body: JSON.stringify({ userId: MANAGER_B_ID }),
    });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error.code, "CSRF_INVALID");

    const badOrigin = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        origin: "https://evil.example",
      }),
      body: JSON.stringify({ userId: MANAGER_B_ID }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error.code, "ORIGIN_NOT_ALLOWED");

    const manager = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, MANAGER_A_ID),
      body: JSON.stringify({ userId: MANAGER_B_ID }),
    });
    assert.equal(manager.status, 403);
    assert.equal(
      (await manager.json()).error.code,
      "LEAGUE_COMMISSIONER_REQUIRED"
    );

    const missingIfMatch = await fetch(proposalUrl, {
      method: "DELETE",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        idempotencyKey: "http-remove-missing-version",
      }),
      body: JSON.stringify({ assignmentId: CURRENT_ASSIGNMENT_ID }),
    });
    assert.equal(missingIfMatch.status, 400);
    assert.equal(
      (await missingIfMatch.json()).error.code,
      "TEAM_MANAGER_ASSIGNMENT_INVALID"
    );

    const stale = await fetch(proposalUrl, {
      method: "DELETE",
      headers: httpHeaders(api.sessionCookie, COMMISSIONER_ID, {
        idempotencyKey: "http-remove-stale-version",
        ifMatch: '"2"',
      }),
      body: JSON.stringify({ assignmentId: CURRENT_ASSIGNMENT_ID }),
    });
    const staleBody = await stale.json();
    assert.equal(stale.status, 412);
    assert.equal(staleBody.error.code, "PRECONDITION_FAILED");
    assert.deepEqual(staleBody.error.details, {
      currentVersion: 1,
      refetch: true,
    });
    assert.deepEqual(writeCounts(runtime.database), before);
  });
});
