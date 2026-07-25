const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  CommissionerAssignmentConflictError,
  CommissionerAssignmentNotFoundError,
  createCommissionerAssignmentService,
} = require(
  "../../src/application/services/leagues/createCommissionerAssignmentService"
);
const {
  createPlatformAuthorizationService,
} = require(
  "../../src/application/services/authorization/requirePlatformAdministrator"
);
const {
  CommissionerAssignmentPolicyError,
  validateDecisionInput,
  validateIdempotencyKey,
  validateProposalInput,
  validateStableId,
} = require(
  "../../src/domain/leagues/commissionerAssignmentPolicy"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteCommissionerAssignmentRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCommissionerAssignmentRepository"
);
const {
  createSqlitePlatformRoleRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository"
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
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createCommissionerAssignmentRouter,
} = require(
  "../../src/transport/http/createCommissionerAssignmentRouter"
);
const {
  createTargetRequestSecurity,
} = require(
  "../../src/transport/http/createTargetRequestSecurity"
);
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-20T23:00:00.000Z");
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ID = "00000000-0000-4000-8000-000000000003";
const LEAGUE_ID = "00000000-0000-4000-8000-000000000004";
const PUBLIC_FRONTEND_ORIGIN = "https://hundo.example";
const SESSION_TOKENS = Object.freeze({
  [ADMIN_ID]: Buffer.alloc(32, 0x61).toString("base64url"),
  [TARGET_ID]: Buffer.alloc(32, 0x62).toString("base64url"),
  [OTHER_ID]: Buffer.alloc(32, 0x63).toString("base64url"),
});
const CSRF_TOKENS = Object.freeze({
  [ADMIN_ID]: Buffer.alloc(32, 0x64).toString("base64url"),
  [TARGET_ID]: Buffer.alloc(32, 0x65).toString("base64url"),
  [OTHER_ID]: Buffer.alloc(32, 0x66).toString("base64url"),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function sessionIdFor(userId) {
  if (userId === ADMIN_ID) return uuid(10);
  if (userId === TARGET_ID) return uuid(11);
  return uuid(12);
}

function authenticated(userId = ADMIN_ID) {
  return {
    valid: true,
    code: "SESSION_VALID",
    session: {
      id: sessionIdFor(userId),
      userId,
      version: 1,
    },
    user: { id: userId, status: "active", version: 1 },
  };
}

function insertUser(context, {
  id,
  email,
  displayName,
  status = "active",
  digestCharacter,
}) {
  context.repositories.users.insert({
    id,
    email_normalized: email,
    email_display: email,
    display_name: displayName,
    display_name_normalized: displayName.toLowerCase(),
    status,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.sessions.insert({
    id: sessionIdFor(id),
    user_id: id,
    token_digest: digestCharacter.repeat(64),
    csrf_secret_digest: digestCharacter.toUpperCase().repeat(64),
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

function insertLeague(context, {
  id = LEAGUE_ID,
  name = "Commissioner Test League",
  status = "setup",
  commissionerMembershipId = null,
} = {}) {
  return context.repositories.leagues.insert({
    id,
    name,
    name_normalized: name.toLowerCase(),
    status,
    timezone: "America/Vancouver",
    commissioner_membership_id: commissionerMembershipId,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function createRuntime(t, {
  targetStatus = "active",
  leagueStatus = "setup",
} = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-11-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-11-test",
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
    id: ADMIN_ID,
    email: "admin@example.test",
    displayName: "Platform Admin",
    digestCharacter: "a",
  });
  insertUser(context, {
    id: TARGET_ID,
    email: "target@example.test",
    displayName: "Target User",
    status: targetStatus,
    digestCharacter: "b",
  });
  insertUser(context, {
    id: OTHER_ID,
    email: "other@example.test",
    displayName: "Other User",
    digestCharacter: "c",
  });
  context.repositories.platform_roles.insert({
    id: uuid(20),
    user_id: ADMIN_ID,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });
  insertLeague(context, { status: leagueStatus });

  const userRepository = createSqliteUserRepository({
    database: connection.database,
  });
  const platformRoleRepository =
    createSqlitePlatformRoleRepository({
      database: connection.database,
    });
  let nextId = 100;
  const runtime = {
    assignmentRepository:
      createSqliteCommissionerAssignmentRepository({
        database: connection.database,
      }),
    auditRepository: createSqliteSecurityAuditRepository({
      database: connection.database,
    }),
    clock: { nowMs: () => NOW_MS },
    context,
    database: connection.database,
    platformAuthorization: createPlatformAuthorizationService({
      userRepository,
      platformRoleRepository,
    }),
    secureRandom: { id: () => uuid(nextId++) },
    userRepository,
  };
  return runtime;
}

function createService(runtime, overrides = {}) {
  return createCommissionerAssignmentService({
    repositoryContext: runtime.context,
    platformAuthorization: runtime.platformAuthorization,
    userRepository: runtime.userRepository,
    assignmentRepository: runtime.assignmentRepository,
    auditRepository: runtime.auditRepository,
    clock: runtime.clock,
    secureRandom: runtime.secureRandom,
    ...overrides,
  });
}

function proposalCommand(overrides = {}) {
  return {
    leagueId: LEAGUE_ID,
    input: { userId: TARGET_ID },
    idempotencyKey: "commissioner-proposal-key",
    authenticated: authenticated(ADMIN_ID),
    auditContext: {
      requestCorrelationId: "request-m3-11",
      networkKeyVersion: 1,
      networkMetadataDigest: "d".repeat(64),
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "unknown",
        origin: "https://hundo.example",
      }),
    },
    ...overrides,
  };
}

function tableCount(database, tableName) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get().count;
}

function proposalCounts(database) {
  return Object.fromEntries(
    [
      "league_memberships",
      "league_invitations",
      "notifications",
      "league_activity",
      "security_audit_events",
      "idempotency_requests",
    ].map((table) => [table, tableCount(database, table)])
  );
}

describe("M3-11 commissioner-assignment policy", () => {
  test("accepts only canonical proposal, decision, ID, and idempotency inputs", () => {
    assert.deepEqual(validateProposalInput({ userId: TARGET_ID }), {
      userId: TARGET_ID,
    });
    assert.deepEqual(validateDecisionInput({}), {});
    assert.equal(validateStableId(LEAGUE_ID), LEAGUE_ID);
    assert.equal(
      validateIdempotencyKey("opaque-proposal-key"),
      "opaque-proposal-key"
    );

    for (const candidate of [
      null,
      {},
      { userId: "not-an-id" },
      { userId: TARGET_ID, role: "commissioner" },
      { userId: TARGET_ID, leagueId: LEAGUE_ID },
    ]) {
      assert.throws(
        () => validateProposalInput(candidate),
        CommissionerAssignmentPolicyError
      );
    }
    for (const candidate of [null, [], { accept: true }]) {
      assert.throws(
        () => validateDecisionInput(candidate),
        CommissionerAssignmentPolicyError
      );
    }
    for (const key of [undefined, "", " padded ", "x\n", "x".repeat(129)]) {
      assert.throws(
        () => validateIdempotencyKey(key),
        CommissionerAssignmentPolicyError
      );
    }
  });
});

describe("M3-11 commissioner proposal and safe read", () => {
  test("atomically stores one pending proposal, invited membership, notification, and both audit surfaces", (t) => {
    const runtime = createRuntime(t);
    const result = createService(runtime).propose(proposalCommand());

    assert.equal(result.code, "COMMISSIONER_ASSIGNMENT_PROPOSED");
    assert.equal(result.assignment.status, "pending");
    assert.equal(result.league.id, LEAGUE_ID);
    assert.equal(result.league.commissionerMembershipId, null);
    assert.equal(result.proposedUser.id, TARGET_ID);
    assert.equal(result.membership.permissionCategory, "commissioner");
    assert.equal(result.membership.status, "invited");
    assert.deepEqual(proposalCounts(runtime.database), {
      league_memberships: 1,
      league_invitations: 1,
      notifications: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
    const invitation = runtime.database
      .prepare("SELECT * FROM league_invitations")
      .get();
    assert.equal(invitation.invited_email_normalized, "target@example.test");
    assert.equal(invitation.expires_at_ms, Number.MAX_SAFE_INTEGER);
    const notification = runtime.database
      .prepare("SELECT * FROM notifications")
      .get();
    assert.equal(notification.delivery_status, "delivered");
    assert.equal(notification.delivered_at_ms, NOW_MS);
    assert.deepEqual(JSON.parse(notification.message_data_json), {
      assignmentId: result.assignment.id,
      leagueId: LEAGUE_ID,
      leagueName: "Commissioner Test League",
    });
    assert.equal(
      JSON.stringify(result).includes("target@example.test"),
      false
    );
    assert.equal(JSON.stringify(result).includes("token"), false);
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("replays exactly once and rejects key reuse across user or league", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const first = service.propose(proposalCommand());
    const replay = service.propose(proposalCommand());
    assert.deepEqual(replay, first);
    assert.equal(replay.replayed, true);
    assert.deepEqual(proposalCounts(runtime.database), {
      league_memberships: 1,
      league_invitations: 1,
      notifications: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
    assert.throws(
      () =>
        service.propose(
          proposalCommand({ input: { userId: OTHER_ID } })
        ),
      (error) =>
        error instanceof CommissionerAssignmentConflictError &&
        error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    insertLeague(runtime.context, {
      id: uuid(30),
      name: "Other Proposal League",
    });
    assert.throws(
      () =>
        service.propose(
          proposalCommand({ leagueId: uuid(30) })
        ),
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED"
    );
    assert.equal(tableCount(runtime.database, "league_invitations"), 1);
  });

  test("reveals an assignment only to its currently active proposed user", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const proposed = service.propose(proposalCommand());
    const found = service.read({
      assignmentId: proposed.assignment.id,
      authenticated: authenticated(TARGET_ID),
    });
    assert.equal(found.code, "COMMISSIONER_ASSIGNMENT_FOUND");
    assert.equal(found.assignment.id, proposed.assignment.id);

    for (const command of [
      {
        assignmentId: proposed.assignment.id,
        authenticated: authenticated(OTHER_ID),
      },
      {
        assignmentId: uuid(999),
        authenticated: authenticated(TARGET_ID),
      },
    ]) {
      assert.throws(
        () => service.read(command),
        CommissionerAssignmentNotFoundError
      );
    }
    runtime.userRepository.updateVersioned({
      key: TARGET_ID,
      expectedVersion: 1,
      changes: { status: "deactivated", updated_at_ms: NOW_MS },
    });
    assert.throws(
      () =>
        service.read({
          assignmentId: proposed.assignment.id,
          authenticated: authenticated(TARGET_ID),
        }),
      CommissionerAssignmentNotFoundError
    );
    assert.deepEqual(proposalCounts(runtime.database), {
      league_memberships: 1,
      league_invitations: 1,
      notifications: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
  });

  test("rejects stale authority, ineligible users, non-setup leagues, and a second pending proposal without writes", (t) => {
    const noAdmin = createRuntime(t);
    noAdmin.context.repositories.platform_roles.updateVersioned({
      key: uuid(20),
      expectedVersion: 1,
      changes: { status: "ended", ended_at_ms: NOW_MS },
    });
    assert.throws(
      () => createService(noAdmin).propose(proposalCommand()),
      (error) => error.code === "PLATFORM_ADMINISTRATOR_REQUIRED"
    );
    assert.deepEqual(proposalCounts(noAdmin.database), {
      league_memberships: 0,
      league_invitations: 0,
      notifications: 0,
      league_activity: 0,
      security_audit_events: 0,
      idempotency_requests: 0,
    });

    for (const options of [
      { targetStatus: "deactivated" },
      { leagueStatus: "active" },
    ]) {
      const runtime = createRuntime(t, options);
      assert.throws(
        () => createService(runtime).propose(proposalCommand()),
        CommissionerAssignmentConflictError
      );
      assert.equal(tableCount(runtime.database, "league_memberships"), 0);
      assert.equal(tableCount(runtime.database, "idempotency_requests"), 0);
    }

    for (const permissionCategory of ["member", "commissioner"]) {
      const runtime = createRuntime(t);
      runtime.context.repositories.league_memberships.insert({
        id: permissionCategory === "member" ? uuid(31) : uuid(32),
        league_id: LEAGUE_ID,
        user_id:
          permissionCategory === "member" ? TARGET_ID : OTHER_ID,
        permission_category: permissionCategory,
        status: "active",
        joined_at_ms: NOW_MS,
        ended_at_ms: null,
        created_at_ms: NOW_MS,
        updated_at_ms: NOW_MS,
        version: 1,
      });
      assert.throws(
        () => createService(runtime).propose(proposalCommand()),
        CommissionerAssignmentConflictError
      );
      assert.equal(tableCount(runtime.database, "league_memberships"), 1);
      assert.equal(tableCount(runtime.database, "league_invitations"), 0);
      assert.equal(tableCount(runtime.database, "idempotency_requests"), 0);
    }

    const pending = createRuntime(t);
    const service = createService(pending);
    service.propose(proposalCommand());
    assert.throws(
      () =>
        service.propose(
          proposalCommand({
            input: { userId: OTHER_ID },
            idempotencyKey: "another-proposal-key",
          })
        ),
      CommissionerAssignmentConflictError
    );
    assert.equal(tableCount(pending.database, "league_memberships"), 1);
    assert.equal(tableCount(pending.database, "league_invitations"), 1);
    assert.equal(tableCount(pending.database, "idempotency_requests"), 1);
  });

  test("rolls every proposal write seam back completely", (t) => {
    const seams = [
      "insertStartedIdempotency",
      "insertInvitedCommissionerMembership",
      "insertCommissionerInvitation",
      "insertProposalNotification",
      "appendAssignmentActivity",
      "completeIdempotency",
    ];
    for (const seam of seams) {
      const runtime = createRuntime(t);
      const repository = {
        ...runtime.assignmentRepository,
        [seam]() {
          throw new Error(`injected ${seam} failure`);
        },
      };
      assert.throws(
        () =>
          createService(runtime, {
            assignmentRepository: repository,
          }).propose(proposalCommand()),
        /repository operation failed/i
      );
      assert.deepEqual(proposalCounts(runtime.database), {
        league_memberships: 0,
        league_invitations: 0,
        notifications: 0,
        league_activity: 0,
        security_audit_events: 0,
        idempotency_requests: 0,
      });
    }

    const runtime = createRuntime(t);
    const auditRepository = {
      append() {
        throw new Error("injected Security Audit failure");
      },
    };
    assert.throws(
      () =>
        createService(runtime, { auditRepository }).propose(
          proposalCommand()
        ),
      /repository operation failed/i
    );
    assert.deepEqual(proposalCounts(runtime.database), {
      league_memberships: 0,
      league_invitations: 0,
      notifications: 0,
      league_activity: 0,
      security_audit_events: 0,
      idempotency_requests: 0,
    });
  });
});

describe("M3-11 commissioner acceptance and decline", () => {
  test("accepts atomically, replays without writes, and rejects the opposite action", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const proposed = service.propose(proposalCommand());
    const accepted = service.accept({
      assignmentId: proposed.assignment.id,
      input: {},
      authenticated: authenticated(TARGET_ID),
    });
    assert.equal(accepted.code, "COMMISSIONER_ASSIGNMENT_ACCEPTED");
    assert.equal(accepted.assignment.status, "accepted");
    assert.equal(accepted.membership.status, "active");
    assert.equal(accepted.membership.joinedAtMs, NOW_MS);
    assert.equal(
      accepted.league.commissionerMembershipId,
      accepted.membership.id
    );
    const counts = proposalCounts(runtime.database);
    assert.deepEqual(counts, {
      league_memberships: 1,
      league_invitations: 1,
      notifications: 1,
      league_activity: 2,
      security_audit_events: 2,
      idempotency_requests: 1,
    });
    const replay = service.accept({
      assignmentId: proposed.assignment.id,
      input: {},
      authenticated: authenticated(TARGET_ID),
    });
    assert.deepEqual(replay, accepted);
    assert.equal(replay.replayed, true);
    assert.deepEqual(proposalCounts(runtime.database), counts);
    assert.throws(
      () =>
        service.decline({
          assignmentId: proposed.assignment.id,
          input: {},
          authenticated: authenticated(TARGET_ID),
        }),
      CommissionerAssignmentConflictError
    );
    assert.deepEqual(proposalCounts(runtime.database), counts);
  });

  test("declines without granting authority, replays safely, and rejects acceptance", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const proposed = service.propose(proposalCommand());
    const declined = service.decline({
      assignmentId: proposed.assignment.id,
      input: {},
      authenticated: authenticated(TARGET_ID),
    });
    assert.equal(declined.code, "COMMISSIONER_ASSIGNMENT_DECLINED");
    assert.equal(declined.assignment.status, "declined");
    assert.equal(declined.membership.status, "ended");
    assert.equal(declined.membership.joinedAtMs, null);
    assert.equal(declined.league.commissionerMembershipId, null);
    const membership = runtime.database
      .prepare("SELECT * FROM league_memberships")
      .get();
    assert.equal(membership.ended_at_ms, null);
    const counts = proposalCounts(runtime.database);
    const replay = service.decline({
      assignmentId: proposed.assignment.id,
      input: {},
      authenticated: authenticated(TARGET_ID),
    });
    assert.deepEqual(replay, declined);
    assert.equal(replay.replayed, true);
    assert.deepEqual(proposalCounts(runtime.database), counts);
    assert.throws(
      () =>
        service.accept({
          assignmentId: proposed.assignment.id,
          input: {},
          authenticated: authenticated(TARGET_ID),
        }),
      CommissionerAssignmentConflictError
    );
    assert.deepEqual(proposalCounts(runtime.database), counts);
  });

  test("returns the same not-found behavior to other users and unknown assignments", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const proposed = service.propose(proposalCommand());
    for (const method of ["accept", "decline"]) {
      assert.throws(
        () =>
          service[method]({
            assignmentId: proposed.assignment.id,
            input: {},
            authenticated: authenticated(OTHER_ID),
          }),
        CommissionerAssignmentNotFoundError
      );
      assert.throws(
        () =>
          service[method]({
            assignmentId: uuid(998),
            input: {},
            authenticated: authenticated(TARGET_ID),
          }),
        CommissionerAssignmentNotFoundError
      );
    }
    assert.deepEqual(proposalCounts(runtime.database), {
      league_memberships: 1,
      league_invitations: 1,
      notifications: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
  });

  test("revalidates active membership eligibility before acceptance", (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const proposed = service.propose(proposalCommand());
    runtime.context.repositories.league_memberships.insert({
      id: uuid(33),
      league_id: LEAGUE_ID,
      user_id: TARGET_ID,
      permission_category: "member",
      status: "active",
      joined_at_ms: NOW_MS,
      ended_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    const before = proposalCounts(runtime.database);
    assert.throws(
      () =>
        service.accept({
          assignmentId: proposed.assignment.id,
          input: {},
          authenticated: authenticated(TARGET_ID),
        }),
      CommissionerAssignmentConflictError
    );
    const aggregate = runtime.assignmentRepository.findAssignmentAggregate(
      proposed.assignment.id
    );
    assert.equal(aggregate.assignment_status, "pending");
    assert.equal(aggregate.membership_status, "invited");
    assert.equal(aggregate.commissioner_membership_id, null);
    assert.deepEqual(proposalCounts(runtime.database), before);
  });

  test("gives one terminal winner to competing accept and decline actions", async (t) => {
    const runtime = createRuntime(t);
    const service = createService(runtime);
    const proposed = service.propose(proposalCommand());
    const command = {
      assignmentId: proposed.assignment.id,
      input: {},
      authenticated: authenticated(TARGET_ID),
    };
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => service.accept(command)),
      Promise.resolve().then(() => service.decline(command)),
    ]);
    assert.equal(
      outcomes.filter(({ status }) => status === "fulfilled").length,
      1
    );
    assert.equal(
      outcomes.filter(({ status }) => status === "rejected").length,
      1
    );
    assert.equal(
      outcomes.find(({ status }) => status === "rejected").reason.code,
      "COMMISSIONER_ASSIGNMENT_CONFLICT"
    );
    const aggregate = runtime.assignmentRepository.findAssignmentAggregate(
      proposed.assignment.id
    );
    assert.equal(aggregate.assignment_status, "accepted");
    assert.equal(aggregate.membership_status, "active");
    assert.equal(
      aggregate.commissioner_membership_id,
      aggregate.membership_id
    );
    assert.equal(tableCount(runtime.database, "league_activity"), 2);
    assert.equal(tableCount(runtime.database, "security_audit_events"), 2);
  });

  test("rolls every acceptance and decline write seam back to pending", (t) => {
    const methodSeams = {
      accept: [
        "activateMembership",
        "setLeagueCommissioner",
        "acceptInvitation",
        "appendAssignmentActivity",
      ],
      decline: [
        "endNeverActiveMembership",
        "cancelInvitation",
        "appendAssignmentActivity",
      ],
    };
    for (const [method, seams] of Object.entries(methodSeams)) {
      for (const seam of seams) {
        const runtime = createRuntime(t);
        const setupService = createService(runtime);
        const proposed = setupService.propose(proposalCommand());
        const before = proposalCounts(runtime.database);
        const repository = {
          ...runtime.assignmentRepository,
          [seam]() {
            throw new Error(`injected ${seam} failure`);
          },
        };
        const service = createService(runtime, {
          assignmentRepository: repository,
        });
        assert.throws(
          () =>
            service[method]({
              assignmentId: proposed.assignment.id,
              input: {},
              authenticated: authenticated(TARGET_ID),
            }),
          /repository operation failed/i
        );
        const aggregate =
          runtime.assignmentRepository.findAssignmentAggregate(
            proposed.assignment.id
          );
        assert.equal(aggregate.assignment_status, "pending");
        assert.equal(aggregate.membership_status, "invited");
        assert.equal(aggregate.commissioner_membership_id, null);
        assert.deepEqual(proposalCounts(runtime.database), before);
      }
    }

    for (const method of ["accept", "decline"]) {
      const runtime = createRuntime(t);
      const proposed = createService(runtime).propose(proposalCommand());
      const before = proposalCounts(runtime.database);
      const service = createService(runtime, {
        auditRepository: {
          append() {
            throw new Error("injected audit failure");
          },
        },
      });
      assert.throws(
        () =>
          service[method]({
            assignmentId: proposed.assignment.id,
            input: {},
            authenticated: authenticated(TARGET_ID),
          }),
        /repository operation failed/i
      );
      const aggregate =
        runtime.assignmentRepository.findAssignmentAggregate(
          proposed.assignment.id
        );
      assert.equal(aggregate.assignment_status, "pending");
      assert.equal(aggregate.membership_status, "invited");
      assert.equal(aggregate.commissioner_membership_id, null);
      assert.deepEqual(proposalCounts(runtime.database), before);
    }
  });
});

function httpHeaders(sessionCookie, userId, {
  csrfToken = CSRF_TOKENS[userId],
  idempotencyKey = "http-commissioner-proposal",
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
    ...(includeCookie
      ? {
          Cookie: `${sessionCookie.name}=${SESSION_TOKENS[userId]}`,
        }
      : {}),
  };
}

async function startCommissionerApi(t, runtime) {
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
      return "m3-11-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap(rawSessionToken) {
        const userId = userByToken.get(rawSessionToken);
        if (!userId) {
          return { valid: false, code: "SESSION_INVALID" };
        }
        return authenticated(userId);
      },
      resolveWithCsrf({ rawSessionToken, rawCsrfToken }) {
        const userId = userByToken.get(rawSessionToken);
        if (!userId) {
          return { valid: false, code: "SESSION_INVALID" };
        }
        if (rawCsrfToken !== CSRF_TOKENS[userId]) {
          return { valid: false, code: "CSRF_INVALID" };
        }
        return authenticated(userId);
      },
    },
  });
  const app = express();
  app.use(
    createCommissionerAssignmentRouter({
      requestSecurity,
      commissionerAssignmentService: createService(runtime),
      auditPrivacyDigest: {
        digest() {
          return {
            digest: "e".repeat(64),
            keyVersion: 1,
          };
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

describe("M3-11 isolated commissioner-assignment HTTP contract", () => {
  test("proposes, replays, reads, and accepts through safe target envelopes", async (t) => {
    const runtime = createRuntime(t);
    const api = await startCommissionerApi(t, runtime);
    const proposalUrl = new URL(
      `/api/v1/admin/leagues/${LEAGUE_ID}/commissioner-assignments`,
      api.baseUrl
    );
    const adminHeaders = httpHeaders(
      api.sessionCookie,
      ADMIN_ID
    );
    const created = await fetch(proposalUrl, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.equal(
      created.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );
    assert.equal(
      created.headers.get("access-control-allow-credentials"),
      "true"
    );
    assert.equal(created.headers.get("set-cookie"), null);
    assert.equal(
      createdBody.data.code,
      "COMMISSIONER_ASSIGNMENT_PROPOSED"
    );
    assert.equal(createdBody.meta.requestId, "m3-11-request");
    assert.equal(JSON.stringify(createdBody).includes("replayed"), false);

    const replay = await fetch(proposalUrl, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).data, createdBody.data);

    const assignmentId = createdBody.data.assignment.id;
    const assignmentUrl = new URL(
      `/api/v1/commissioner-assignments/${assignmentId}`,
      api.baseUrl
    );
    const read = await fetch(assignmentUrl, {
      headers: httpHeaders(api.sessionCookie, TARGET_ID),
    });
    const readBody = await read.json();
    assert.equal(read.status, 200);
    assert.equal(
      readBody.data.code,
      "COMMISSIONER_ASSIGNMENT_FOUND"
    );
    assert.equal(readBody.data.assignment.id, assignmentId);
    assert.equal(read.headers.get("set-cookie"), null);

    const hidden = await fetch(assignmentUrl, {
      headers: httpHeaders(api.sessionCookie, OTHER_ID),
    });
    assert.equal(hidden.status, 404);
    assert.equal(
      (await hidden.json()).error.code,
      "COMMISSIONER_ASSIGNMENT_NOT_FOUND"
    );

    const accept = await fetch(
      new URL(`${assignmentUrl.pathname}/accept`, api.baseUrl),
      {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, TARGET_ID),
        body: JSON.stringify({}),
      }
    );
    const acceptedBody = await accept.json();
    assert.equal(accept.status, 200);
    assert.equal(
      acceptedBody.data.code,
      "COMMISSIONER_ASSIGNMENT_ACCEPTED"
    );
    assert.equal(acceptedBody.data.membership.status, "active");
    assert.equal(
      acceptedBody.data.league.commissionerMembershipId,
      acceptedBody.data.membership.id
    );
    assert.equal(accept.headers.get("set-cookie"), null);
    assert.equal(tableCount(runtime.database, "league_memberships"), 1);
    assert.equal(tableCount(runtime.database, "league_activity"), 2);
    assert.equal(tableCount(runtime.database, "security_audit_events"), 2);
  });

  test("declines through the target route without creating authority", async (t) => {
    const runtime = createRuntime(t);
    const api = await startCommissionerApi(t, runtime);
    const proposal = await fetch(
      new URL(
        `/api/v1/admin/leagues/${LEAGUE_ID}/commissioner-assignments`,
        api.baseUrl
      ),
      {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, ADMIN_ID),
        body: JSON.stringify({ userId: TARGET_ID }),
      }
    );
    const assignmentId = (await proposal.json()).data.assignment.id;
    const declined = await fetch(
      new URL(
        `/api/v1/commissioner-assignments/${assignmentId}/decline`,
        api.baseUrl
      ),
      {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, TARGET_ID),
        body: JSON.stringify({}),
      }
    );
    const body = await declined.json();
    assert.equal(declined.status, 200);
    assert.equal(body.data.code, "COMMISSIONER_ASSIGNMENT_DECLINED");
    assert.equal(body.data.membership.status, "ended");
    assert.equal(body.data.membership.joinedAtMs, null);
    assert.equal(body.data.league.commissionerMembershipId, null);
  });

  test("maps malformed, signed-out, CSRF, Origin, body, role, and state failures without partial writes", async (t) => {
    const runtime = createRuntime(t);
    const api = await startCommissionerApi(t, runtime);
    const proposalUrl = new URL(
      `/api/v1/admin/leagues/${LEAGUE_ID}/commissioner-assignments`,
      api.baseUrl
    );

    const malformed = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, ADMIN_ID),
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      (await malformed.json()).error.code,
      "COMMISSIONER_ASSIGNMENT_INVALID"
    );
    const extraField = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, ADMIN_ID),
      body: JSON.stringify({
        userId: TARGET_ID,
        role: "commissioner",
      }),
    });
    assert.equal(extraField.status, 400);
    const signedOut = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, ADMIN_ID, {
        includeCookie: false,
      }),
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).error.code, "SESSION_REQUIRED");
    const badCsrf = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, ADMIN_ID, {
        csrfToken: "invalid-csrf",
      }),
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error.code, "CSRF_INVALID");
    const badOrigin = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, ADMIN_ID, {
        origin: "https://evil.example",
      }),
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error.code, "ORIGIN_NOT_ALLOWED");
    const notAdmin = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, TARGET_ID),
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    assert.equal(notAdmin.status, 403);
    assert.equal(
      (await notAdmin.json()).error.code,
      "PLATFORM_ADMINISTRATOR_REQUIRED"
    );
    assert.deepEqual(proposalCounts(runtime.database), {
      league_memberships: 0,
      league_invitations: 0,
      notifications: 0,
      league_activity: 0,
      security_audit_events: 0,
      idempotency_requests: 0,
    });

    const created = await fetch(proposalUrl, {
      method: "POST",
      headers: httpHeaders(api.sessionCookie, ADMIN_ID),
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    const assignmentId = (await created.json()).data.assignment.id;
    const invalidDecision = await fetch(
      new URL(
        `/api/v1/commissioner-assignments/${assignmentId}/accept`,
        api.baseUrl
      ),
      {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, TARGET_ID),
        body: JSON.stringify({ userId: TARGET_ID }),
      }
    );
    assert.equal(invalidDecision.status, 400);
    const aggregate = runtime.assignmentRepository.findAssignmentAggregate(
      assignmentId
    );
    assert.equal(aggregate.assignment_status, "pending");
    assert.equal(aggregate.membership_status, "invited");
    assert.equal(aggregate.commissioner_membership_id, null);
  });

  test("two simultaneous exact proposal requests create one assignment", async (t) => {
    const runtime = createRuntime(t);
    const api = await startCommissionerApi(t, runtime);
    const url = new URL(
      `/api/v1/admin/leagues/${LEAGUE_ID}/commissioner-assignments`,
      api.baseUrl
    );
    const request = () =>
      fetch(url, {
        method: "POST",
        headers: httpHeaders(api.sessionCookie, ADMIN_ID, {
          idempotencyKey: "simultaneous-http-proposal",
        }),
        body: JSON.stringify({ userId: TARGET_ID }),
      });
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(
      responses.map(({ status }) => status).sort(),
      [200, 201]
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json())
    );
    assert.deepEqual(bodies[0].data, bodies[1].data);
    assert.deepEqual(proposalCounts(runtime.database), {
      league_memberships: 1,
      league_invitations: 1,
      notifications: 1,
      league_activity: 1,
      security_audit_events: 1,
      idempotency_requests: 1,
    });
  });
});
