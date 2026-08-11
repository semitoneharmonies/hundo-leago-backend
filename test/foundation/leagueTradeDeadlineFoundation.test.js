const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  createPlatformAuthorizationService,
} = require(
  "../../src/application/services/authorization/requirePlatformAdministrator"
);
const {
  IDEMPOTENCY_LIFETIME_MS,
  LEAGUE_TRADE_DEADLINE_OPERATION,
  createLeagueTradeDeadlineService,
  requestHash,
} = require(
  "../../src/application/services/leagues/createLeagueTradeDeadlineService"
);
const {
  LeagueTradeDeadlinePolicyError,
  validateLeagueTradeDeadlineExpectedVersion,
  validateLeagueTradeDeadlineIdempotencyKey,
  validateLeagueTradeDeadlineInput,
  validateLeagueTradeDeadlineLeagueId,
} = require(
  "../../src/domain/leagues/leagueTradeDeadlinePolicy"
);
const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  migrateDatabase,
} = require(
  "../../src/infrastructure/database/migrate"
);
const {
  createSqliteLeagueAccessRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository"
);
const {
  createSqliteLeagueTradeDeadlineRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueTradeDeadlineRepository"
);
const {
  createSqlitePlatformRoleRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository"
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
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);

const ROOT_DIRECTORY = path.resolve(
  __dirname,
  "..",
  ".."
);
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse(
  "2026-07-29T16:00:00.000Z"
);
const FIRST_DEADLINE_MS =
  NOW_MS + 90 * 24 * 60 * 60 * 1000;
const SECOND_DEADLINE_MS =
  NOW_MS + 100 * 24 * 60 * 60 * 1000;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  commissioner: uuid(1),
  commissionerSession: uuid(2),
  commissionerMembership: uuid(3),
  memberAdministrator: uuid(4),
  memberAdministratorSession: uuid(5),
  memberAdministratorMembership: uuid(6),
  memberAdministratorRole: uuid(7),
  manager: uuid(8),
  managerSession: uuid(9),
  managerMembership: uuid(10),
  league: uuid(20),
  otherLeague: uuid(21),
});

const PARTICIPATING_TABLES = Object.freeze([
  "idempotency_requests",
  "job_runs",
  "league_activity",
  "league_settings",
  "leagues",
  "notifications",
  "outbox_event_audiences",
  "outbox_events",
  "security_audit_events",
]);

function insertUser(
  repositories,
  { id, email, displayName }
) {
  return repositories.users.insert({
    id,
    email_normalized: email,
    email_display: email,
    display_name: displayName,
    display_name_normalized:
      displayName.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
  });
}

function insertSession(
  repositories,
  { id, userId, digestCharacter }
) {
  return repositories.sessions.insert({
    id,
    user_id: userId,
    token_digest: digestCharacter.repeat(64),
    csrf_secret_digest:
      digestCharacter.toUpperCase().repeat(64),
    status: "active",
    created_at_ms: NOW_MS - 9_000,
    last_used_at_ms: NOW_MS - 9_000,
    idle_expires_at_ms:
      NOW_MS + 60 * 60 * 1000,
    absolute_expires_at_ms:
      NOW_MS + 2 * 60 * 60 * 1000,
    revoked_at_ms: null,
    revocation_reason: null,
    client_metadata_json: null,
    version: 1,
  });
}

function insertLeague(
  repositories,
  { id, name }
) {
  repositories.leagues.insert({
    id,
    name,
    name_normalized: name.toLowerCase(),
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS - 8_000,
    updated_at_ms: NOW_MS - 8_000,
    version: 1,
  });
  repositories.league_settings.insert({
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
    created_at_ms: NOW_MS - 8_000,
    updated_at_ms: NOW_MS - 8_000,
    version: 1,
  });
}

function insertMembership(
  repositories,
  {
    id,
    leagueId,
    userId,
    permissionCategory,
  }
) {
  return repositories.league_memberships.insert({
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: NOW_MS - 7_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 7_000,
    updated_at_ms: NOW_MS - 7_000,
    version: 1,
  });
}

function seedDatabase(context) {
  const { repositories } = context;
  insertUser(repositories, {
    id: IDS.commissioner,
    email: "commissioner@trade-deadline.test",
    displayName: "League Commissioner",
  });
  insertSession(repositories, {
    id: IDS.commissionerSession,
    userId: IDS.commissioner,
    digestCharacter: "a",
  });
  insertUser(repositories, {
    id: IDS.memberAdministrator,
    email: "administrator@trade-deadline.test",
    displayName: "Member Administrator",
  });
  insertSession(repositories, {
    id: IDS.memberAdministratorSession,
    userId: IDS.memberAdministrator,
    digestCharacter: "b",
  });
  insertUser(repositories, {
    id: IDS.manager,
    email: "manager@trade-deadline.test",
    displayName: "League Manager",
  });
  insertSession(repositories, {
    id: IDS.managerSession,
    userId: IDS.manager,
    digestCharacter: "c",
  });

  insertLeague(repositories, {
    id: IDS.league,
    name: "Trade Deadline League",
  });
  insertLeague(repositories, {
    id: IDS.otherLeague,
    name: "Untouched League",
  });

  const commissionerMembership =
    insertMembership(repositories, {
      id: IDS.commissionerMembership,
      leagueId: IDS.league,
      userId: IDS.commissioner,
      permissionCategory: "commissioner",
    });
  insertMembership(repositories, {
    id: IDS.memberAdministratorMembership,
    leagueId: IDS.league,
    userId: IDS.memberAdministrator,
    permissionCategory: "member",
  });
  insertMembership(repositories, {
    id: IDS.managerMembership,
    leagueId: IDS.league,
    userId: IDS.manager,
    permissionCategory: "manager",
  });
  repositories.platform_roles.insert({
    id: IDS.memberAdministratorRole,
    user_id: IDS.memberAdministrator,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: NOW_MS - 6_000,
    ended_at_ms: null,
    version: 1,
  });
  return repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id:
        commissionerMembership.id,
      updated_at_ms: NOW_MS - 5_000,
    },
  });
}

function authenticated({
  userId,
  sessionId,
}) {
  return Object.freeze({
    valid: true,
    session: Object.freeze({
      id: sessionId,
      userId,
    }),
    user: Object.freeze({
      id: userId,
      status: "active",
      version: 1,
    }),
  });
}

function authenticatedCommissioner() {
  return authenticated({
    userId: IDS.commissioner,
    sessionId: IDS.commissionerSession,
  });
}

function authenticatedMemberAdministrator() {
  return authenticated({
    userId: IDS.memberAdministrator,
    sessionId: IDS.memberAdministratorSession,
  });
}

function authenticatedManager() {
  return authenticated({
    userId: IDS.manager,
    sessionId: IDS.managerSession,
  });
}

function attachRuntime(runtime) {
  const { database } = runtime.connection;
  runtime.database = database;
  runtime.context =
    createSqliteRepositoryContext({ database });
  runtime.tradeDeadlineRepository =
    createSqliteLeagueTradeDeadlineRepository({
      database,
    });
  runtime.auditRepository =
    createSqliteSecurityAuditRepository({
      database,
    });
  const userRepository =
    createSqliteUserRepository({ database });
  const platformAuthorization =
    createPlatformAuthorizationService({
      userRepository,
      platformRoleRepository:
        createSqlitePlatformRoleRepository({
          database,
        }),
    });
  runtime.leagueAuthorization =
    createLeagueAuthorizationService({
      userRepository,
      leagueAccessRepository:
        createSqliteLeagueAccessRepository({
          database,
        }),
      platformAuthorization,
    });
  runtime.service =
    createLeagueTradeDeadlineService({
      repositoryContext: runtime.context,
      leagueAuthorization:
        runtime.leagueAuthorization,
      leagueTradeDeadlineRepository:
        runtime.tradeDeadlineRepository,
      auditRepository: runtime.auditRepository,
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
  return runtime;
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad-04-trade-deadline-"
    )
  );
  const runtime = {
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
    temporaryRoot,
    nowMs: NOW_MS,
    nextSecureId: 500,
  };
  runtime.clock = Object.freeze({
    nowMs: () => runtime.nowMs,
  });
  runtime.secureRandom = Object.freeze({
    id() {
      const id = uuid(runtime.nextSecureId);
      runtime.nextSecureId += 1;
      return id;
    },
  });
  runtime.connection = openDatabase({
    databasePath: runtime.databasePath,
    environment: "test",
  });
  migrateDatabase({
    database: runtime.connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId:
      "fad-04-league-trade-deadline-test",
    now: () => NOW_MS,
  });
  const context =
    createSqliteRepositoryContext({
      database: runtime.connection.database,
    });
  runtime.initialLeague =
    seedDatabase(context);
  attachRuntime(runtime);
  t.after(() => {
    if (runtime.connection?.database?.open) {
      runtime.connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  return runtime;
}

function reopenRuntime(runtime) {
  if (runtime.connection.database.open) {
    runtime.connection.database.close();
  }
  runtime.connection = openDatabase({
    databasePath: runtime.databasePath,
    environment: "test",
  });
  return attachRuntime(runtime);
}

function createService(runtime, overrides = {}) {
  return createLeagueTradeDeadlineService({
    repositoryContext: runtime.context,
    leagueAuthorization:
      runtime.leagueAuthorization,
    leagueTradeDeadlineRepository:
      runtime.tradeDeadlineRepository,
    auditRepository: runtime.auditRepository,
    clock: runtime.clock,
    secureRandom: runtime.secureRandom,
    ...overrides,
  });
}

function recordCommand(
  runtime,
  overrides = {}
) {
  return {
    leagueId: IDS.league,
    input: {
      tradeDeadlineAtMs:
        FIRST_DEADLINE_MS,
    },
    expectedLeagueVersion:
      runtime.initialLeague.version,
    idempotencyKey:
      "fad-04-trade-deadline-first",
    authenticated:
      authenticatedCommissioner(),
    auditContext: {
      requestCorrelationId: uuid(800),
      networkKeyVersion: 1,
      networkMetadataDigest: "d".repeat(64),
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "local",
      }),
    },
    ...overrides,
  };
}

function rows(database, tableName) {
  return database
    .prepare(
      `SELECT * FROM "${tableName}" ORDER BY rowid ASC`
    )
    .all();
}

function snapshotTables(
  database,
  tableNames = PARTICIPATING_TABLES
) {
  return JSON.stringify(
    Object.fromEntries(
      tableNames.map((tableName) => [
        tableName,
        rows(database, tableName),
      ])
    )
  );
}

function fadAndSideEffectSnapshot(database) {
  const tableNames = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND " +
        "(name LIKE 'free_agent%' OR " +
        "name IN ('job_runs', 'notifications')) " +
        "ORDER BY name ASC"
    )
    .all()
    .map((row) => row.name);
  return snapshotTables(database, tableNames);
}

function crossLeagueSnapshot(database) {
  return JSON.stringify({
    league: database
      .prepare(
        "SELECT * FROM leagues WHERE id = ?"
      )
      .get(IDS.otherLeague),
    settings: database
      .prepare(
        "SELECT * FROM league_settings " +
          "WHERE league_id = ?"
      )
      .get(IDS.otherLeague),
    activity: database
      .prepare(
        "SELECT * FROM league_activity " +
          "WHERE league_id = ? ORDER BY rowid"
      )
      .all(IDS.otherLeague),
    audit: database
      .prepare(
        "SELECT * FROM security_audit_events " +
          "WHERE league_id = ? ORDER BY rowid"
      )
      .all(IDS.otherLeague),
    idempotency: database
      .prepare(
        "SELECT * FROM idempotency_requests " +
          "WHERE league_id = ? ORDER BY rowid"
      )
      .all(IDS.otherLeague),
    outbox: database
      .prepare(
        "SELECT * FROM outbox_events " +
          "WHERE league_id = ? ORDER BY rowid"
      )
      .all(IDS.otherLeague),
  });
}

function count(
  database,
  tableName,
  where = "",
  ...parameters
) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM "${tableName}" ${where}`
    )
    .get(...parameters).count;
}

function assertErrorWithoutWrites(
  runtime,
  expectedCode,
  command = recordCommand(runtime)
) {
  const before = snapshotTables(
    runtime.database
  );
  assert.throws(
    () => runtime.service.record(command),
    (error) => error?.code === expectedCode
  );
  assert.equal(
    snapshotTables(runtime.database),
    before
  );
}

function repositoryFailingAfterCall(
  repository,
  methodName
) {
  return Object.freeze({
    ...repository,
    [methodName](...argumentsList) {
      repository[methodName](
        ...argumentsList
      );
      throw new Error(
        `injected ${methodName} failure`
      );
    },
  });
}

function errorChainIncludes(
  error,
  expectedMessage
) {
  const seen = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !seen.has(current)
  ) {
    if (current.message === expectedMessage) {
      return true;
    }
    seen.add(current);
    current = current.cause;
  }
  return false;
}

describe(
  "FAD-04 T-035 trade-deadline policy",
  () => {
    test(
      "accepts only exact canonical command values and hashes every conflict-relevant value",
      () => {
        assert.deepEqual(
          validateLeagueTradeDeadlineInput({
            tradeDeadlineAtMs:
              FIRST_DEADLINE_MS,
          }),
          {
            tradeDeadlineAtMs:
              FIRST_DEADLINE_MS,
          }
        );
        assert.equal(
          validateLeagueTradeDeadlineLeagueId(
            IDS.league
          ),
          IDS.league
        );
        assert.equal(
          validateLeagueTradeDeadlineExpectedVersion(
            2
          ),
          2
        );
        assert.equal(
          validateLeagueTradeDeadlineIdempotencyKey(
            "trade-deadline-key"
          ),
          "trade-deadline-key"
        );

        for (const callback of [
          () =>
            validateLeagueTradeDeadlineInput(
              null
            ),
          () =>
            validateLeagueTradeDeadlineInput(
              {}
            ),
          () =>
            validateLeagueTradeDeadlineInput({
              tradeDeadlineAtMs:
                FIRST_DEADLINE_MS,
              force: true,
            }),
          () =>
            validateLeagueTradeDeadlineInput({
              tradeDeadlineAtMs: -1,
            }),
          () =>
            validateLeagueTradeDeadlineInput({
              tradeDeadlineAtMs: 1.5,
            }),
          () =>
            validateLeagueTradeDeadlineLeagueId(
              "not-a-league-id"
            ),
          () =>
            validateLeagueTradeDeadlineExpectedVersion(
              0
            ),
          () =>
            validateLeagueTradeDeadlineIdempotencyKey(
              " padded "
            ),
          () =>
            validateLeagueTradeDeadlineIdempotencyKey(
              "deadline\u0085key"
            ),
          () =>
            validateLeagueTradeDeadlineIdempotencyKey(
              "deadline\u2028key"
            ),
        ]) {
          assert.throws(
            callback,
            (error) =>
              error instanceof
                LeagueTradeDeadlinePolicyError &&
              error.code ===
                "LEAGUE_TRADE_DEADLINE_INPUT_INVALID"
          );
        }

        const firstHash = requestHash({
          leagueId: IDS.league,
          expectedLeagueVersion: 2,
          tradeDeadlineAtMs:
            FIRST_DEADLINE_MS,
        });
        assert.match(
          firstHash,
          /^[a-f0-9]{64}$/
        );
        assert.equal(
          firstHash,
          requestHash({
            leagueId: IDS.league,
            expectedLeagueVersion: 2,
            tradeDeadlineAtMs:
              FIRST_DEADLINE_MS,
          })
        );
        assert.notEqual(
          firstHash,
          requestHash({
            leagueId: IDS.league,
            expectedLeagueVersion: 3,
            tradeDeadlineAtMs:
              FIRST_DEADLINE_MS,
          })
        );
        assert.notEqual(
          firstHash,
          requestHash({
            leagueId: IDS.league,
            expectedLeagueVersion: 2,
            tradeDeadlineAtMs:
              SECOND_DEADLINE_MS,
          })
        );
        assert.equal(
          LEAGUE_TRADE_DEADLINE_OPERATION,
          "league.setup.trade_deadline.v1"
        );
        assert.equal(
          IDEMPOTENCY_LIFETIME_MS,
          24 * 60 * 60 * 1000
        );
      }
    );
  }
);

describe(
  "FAD-04 T-035 atomic setup trade deadline",
  () => {
    test(
      "records a future deadline with league/settings CAS, exact evidence, no hidden work, and cross-league isolation",
      (t) => {
        const runtime = createRuntime(t);
        const otherBefore =
          crossLeagueSnapshot(
            runtime.database
          );
        const sideEffectsBefore =
          fadAndSideEffectSnapshot(
            runtime.database
          );

        const result =
          runtime.service.record(
            recordCommand(runtime)
          );

        assert.deepEqual(result, {
          code:
            "LEAGUE_TRADE_DEADLINE_RECORDED",
          league: {
            id: IDS.league,
            status: "setup",
            timezone: "America/Vancouver",
            version:
              runtime.initialLeague.version +
              1,
          },
          settings: {
            tradeDeadlineAtMs:
              FIRST_DEADLINE_MS,
            version: 2,
          },
          recordedAtMs: NOW_MS,
        });
        assert.equal(result.replayed, false);
        assert.equal(
          Object.keys(result).includes(
            "replayed"
          ),
          false
        );

        const league = runtime.database
          .prepare(
            "SELECT * FROM leagues WHERE id = ?"
          )
          .get(IDS.league);
        assert.equal(league.status, "setup");
        assert.equal(
          league.version,
          runtime.initialLeague.version + 1
        );
        assert.equal(
          league.updated_at_ms,
          NOW_MS
        );
        const settings = runtime.database
          .prepare(
            "SELECT * FROM league_settings " +
              "WHERE league_id = ?"
          )
          .get(IDS.league);
        assert.equal(
          settings.trade_deadline_at_ms,
          FIRST_DEADLINE_MS
        );
        assert.equal(settings.version, 2);
        assert.equal(
          settings.updated_at_ms,
          NOW_MS
        );

        const activity = runtime.database
          .prepare(
            "SELECT * FROM league_activity " +
              "WHERE league_id = ?"
          )
          .get(IDS.league);
        assert.equal(
          activity.event_type,
          "league_trade_deadline_recorded"
        );
        assert.equal(
          activity.actor_user_id,
          IDS.commissioner
        );
        assert.equal(
          activity.actor_authority,
          "commissioner"
        );
        assert.equal(
          activity.related_type,
          "league"
        );
        assert.equal(
          activity.related_id,
          IDS.league
        );
        assert.equal(
          activity.occurred_at_ms,
          NOW_MS
        );
        assert.deepEqual(
          JSON.parse(activity.metadata_json),
          {
            leagueId: IDS.league,
            leagueStatus: "setup",
            leagueTimezone:
              "America/Vancouver",
            leagueVersion:
              runtime.initialLeague.version +
              1,
            settingsVersion: 2,
            tradeDeadlineAtMs:
              FIRST_DEADLINE_MS,
            recordedAtMs: NOW_MS,
          }
        );

        const audit = runtime.database
          .prepare(
            "SELECT * FROM security_audit_events " +
              "WHERE league_id = ?"
          )
          .get(IDS.league);
        assert.equal(
          audit.event_type,
          "league.trade_deadline_recorded"
        );
        assert.equal(audit.outcome, "success");
        assert.equal(
          audit.actor_user_id,
          IDS.commissioner
        );
        assert.equal(
          audit.session_id,
          IDS.commissionerSession
        );
        assert.equal(
          audit.request_correlation_id,
          uuid(800)
        );
        assert.equal(
          audit.network_key_version,
          1
        );
        assert.equal(
          audit.network_metadata_digest,
          "d".repeat(64)
        );

        const outbox = runtime.database
          .prepare(
            "SELECT * FROM outbox_events " +
              "WHERE league_id = ?"
          )
          .get(IDS.league);
        assert.equal(
          outbox.event_type,
          "league.changed"
        );
        assert.equal(
          outbox.aggregate_type,
          "league"
        );
        assert.equal(
          outbox.aggregate_id,
          IDS.league
        );
        assert.equal(
          outbox.created_at_ms,
          NOW_MS
        );
        assert.deepEqual(
          JSON.parse(outbox.payload_json),
          {
            eventId: uuid(503),
            type: "league.changed",
            leagueId: IDS.league,
            resourceId: IDS.league,
            version:
              runtime.initialLeague.version +
              1,
            reasonCode: "league_changed",
            occurredAt: NOW_MS,
            related: {
              fadId: null,
              teamId: null,
              cardId: null,
              allocationId: null,
              auctionId: null,
              recoveryId: null,
              nominationQueueId: null,
              scheduleRecoveryOperationId: null,
            },
          }
        );
        const audiences = runtime.database
          .prepare(
            "SELECT * FROM outbox_event_audiences " +
              "WHERE outbox_event_id = ?"
          )
          .all(outbox.id);
        assert.equal(audiences.length, 1);
        assert.equal(
          audiences[0].audience_kind,
          "league"
        );
        assert.equal(
          audiences[0].league_id,
          IDS.league
        );
        assert.equal(
          audiences[0].team_id,
          null
        );
        assert.equal(
          audiences[0].user_id,
          null
        );

        const idempotency = runtime.database
          .prepare(
            "SELECT * FROM idempotency_requests " +
              "WHERE league_id = ?"
          )
          .get(IDS.league);
        assert.equal(
          idempotency.actor_user_id,
          IDS.commissioner
        );
        assert.equal(
          idempotency.operation,
          LEAGUE_TRADE_DEADLINE_OPERATION
        );
        assert.equal(
          idempotency.client_key,
          "fad-04-trade-deadline-first"
        );
        assert.equal(
          idempotency.status,
          "completed"
        );
        assert.equal(
          idempotency.result_type,
          "league_trade_deadline"
        );
        assert.equal(
          idempotency.result_id,
          activity.id
        );
        assert.equal(
          idempotency.created_at_ms,
          NOW_MS
        );
        assert.equal(
          idempotency.completed_at_ms,
          NOW_MS
        );
        assert.equal(
          idempotency.expires_at_ms,
          NOW_MS + IDEMPOTENCY_LIFETIME_MS
        );
        assert.equal(
          idempotency.request_hash,
          requestHash({
            leagueId: IDS.league,
            expectedLeagueVersion:
              runtime.initialLeague.version,
            tradeDeadlineAtMs:
              FIRST_DEADLINE_MS,
          })
        );

        assert.equal(
          crossLeagueSnapshot(
            runtime.database
          ),
          otherBefore
        );
        assert.equal(
          fadAndSideEffectSnapshot(
            runtime.database
          ),
          sideEffectsBefore
        );
      }
    );

    test(
      "allows setup replacement and replays the first immutable result after replacement, stale state, elapsed time, and reopen",
      (t) => {
        const runtime = createRuntime(t);
        const firstCommand =
          recordCommand(runtime);
        const first =
          runtime.service.record(firstCommand);
        const second =
          runtime.service.record(
            recordCommand(runtime, {
              input: {
                tradeDeadlineAtMs:
                  SECOND_DEADLINE_MS,
              },
              expectedLeagueVersion:
                first.league.version,
              idempotencyKey:
                "fad-04-trade-deadline-second",
            })
          );

        assert.equal(
          second.settings.tradeDeadlineAtMs,
          SECOND_DEADLINE_MS
        );
        assert.equal(
          second.settings.version,
          first.settings.version + 1
        );
        assert.equal(
          second.league.version,
          first.league.version + 1
        );
        assert.equal(
          count(
            runtime.database,
            "league_activity",
            "WHERE league_id = ?",
            IDS.league
          ),
          2
        );

        runtime.database
          .prepare(
            "UPDATE leagues SET status = 'active', " +
              "version = version + 1, " +
              "updated_at_ms = ? WHERE id = ?"
          )
          .run(
            SECOND_DEADLINE_MS + 1,
            IDS.league
          );
        runtime.nowMs =
          SECOND_DEADLINE_MS + 1;
        const beforeReplay = snapshotTables(
          runtime.database
        );
        const replay =
          runtime.service.record(firstCommand);
        assert.deepEqual(replay, first);
        assert.equal(replay.replayed, true);
        assert.equal(
          snapshotTables(runtime.database),
          beforeReplay
        );

        reopenRuntime(runtime);
        const reopenedBefore =
          snapshotTables(runtime.database);
        const reopenedReplay =
          runtime.service.record(firstCommand);
        assert.deepEqual(
          reopenedReplay,
          first
        );
        assert.equal(
          reopenedReplay.replayed,
          true
        );
        assert.equal(
          snapshotTables(runtime.database),
          reopenedBefore
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT trade_deadline_at_ms " +
                "FROM league_settings " +
                "WHERE league_id = ?"
            )
            .get(IDS.league)
            .trade_deadline_at_ms,
          SECOND_DEADLINE_MS
        );
      }
    );

    test(
      "authorizes an active member platform administrator with distinct attribution and denies an ordinary manager",
      (t) => {
        const denied = createRuntime(t);
        assertErrorWithoutWrites(
          denied,
          "LEAGUE_COMMISSIONER_REQUIRED",
          recordCommand(denied, {
            authenticated:
              authenticatedManager(),
          })
        );

        const runtime = createRuntime(t);
        const result =
          runtime.service.record(
            recordCommand(runtime, {
              authenticated:
                authenticatedMemberAdministrator(),
              idempotencyKey:
                "member-administrator-deadline",
            })
          );
        assert.equal(
          result.code,
          "LEAGUE_TRADE_DEADLINE_RECORDED"
        );
        const activity = runtime.database
          .prepare(
            "SELECT * FROM league_activity " +
              "WHERE league_id = ?"
          )
          .get(IDS.league);
        assert.equal(
          activity.actor_user_id,
          IDS.memberAdministrator
        );
        assert.equal(
          activity.actor_authority,
          "platform_administrator"
        );
        const audit = runtime.database
          .prepare(
            "SELECT * FROM security_audit_events " +
              "WHERE league_id = ?"
          )
          .get(IDS.league);
        assert.equal(
          audit.actor_user_id,
          IDS.memberAdministrator
        );
        assert.equal(
          audit.session_id,
          IDS.memberAdministratorSession
        );
      }
    );

    test(
      "rejects stale version, missing settings, non-setup state, and current-or-past timestamps without writes",
      (t) => {
        const stale = createRuntime(t);
        assertErrorWithoutWrites(
          stale,
          "LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED",
          recordCommand(stale, {
            expectedLeagueVersion:
              stale.initialLeague.version + 1,
          })
        );

        const missingSettings =
          createRuntime(t);
        missingSettings.database
          .prepare(
            "DELETE FROM league_settings " +
              "WHERE league_id = ?"
          )
          .run(IDS.league);
        assertErrorWithoutWrites(
          missingSettings,
          "LEAGUE_TRADE_DEADLINE_SETTINGS_INVALID"
        );

        const active = createRuntime(t);
        active.database
          .prepare(
            "UPDATE leagues SET status = 'active' " +
              "WHERE id = ?"
          )
          .run(IDS.league);
        assertErrorWithoutWrites(
          active,
          "LEAGUE_TRADE_DEADLINE_NOT_ALLOWED"
        );

        for (const deadline of [
          NOW_MS,
          NOW_MS - 1,
        ]) {
          const runtime = createRuntime(t);
          assertErrorWithoutWrites(
            runtime,
            "LEAGUE_TRADE_DEADLINE_NOT_FUTURE",
            recordCommand(runtime, {
              input: {
                tradeDeadlineAtMs:
                  deadline,
              },
              idempotencyKey:
                `deadline-${deadline}`,
            })
          );
        }
      }
    );

    test(
      "rejects an idempotency key reused for another deadline or version and an incomplete matching request",
      (t) => {
        const runtime = createRuntime(t);
        const first =
          runtime.service.record(
            recordCommand(runtime)
          );
        const before = snapshotTables(
          runtime.database
        );
        for (const command of [
          recordCommand(runtime, {
            input: {
              tradeDeadlineAtMs:
                SECOND_DEADLINE_MS,
            },
          }),
          recordCommand(runtime, {
            expectedLeagueVersion:
              first.league.version,
          }),
        ]) {
          assert.throws(
            () =>
              runtime.service.record(command),
            (error) =>
              error?.code ===
              "IDEMPOTENCY_KEY_REUSED"
          );
          assert.equal(
            snapshotTables(
              runtime.database
            ),
            before
          );
        }

        const incomplete = createRuntime(t);
        const command =
          recordCommand(incomplete, {
            idempotencyKey:
              "incomplete-deadline-request",
          });
        incomplete.context.repositories
          .idempotency_requests.insert({
            id: uuid(1_500),
            league_id: IDS.league,
            actor_user_id:
              IDS.commissioner,
            operation:
              LEAGUE_TRADE_DEADLINE_OPERATION,
            client_key:
              command.idempotencyKey,
            request_hash: requestHash({
              leagueId: IDS.league,
              expectedLeagueVersion:
                incomplete.initialLeague
                  .version,
              tradeDeadlineAtMs:
                FIRST_DEADLINE_MS,
            }),
            status: "started",
            result_type: null,
            result_id: null,
            created_at_ms: NOW_MS - 1,
            completed_at_ms: null,
            expires_at_ms:
              NOW_MS +
              IDEMPOTENCY_LIFETIME_MS,
          });
        assertErrorWithoutWrites(
          incomplete,
          "IDEMPOTENCY_REQUEST_UNAVAILABLE",
          command
        );
      }
    );

    test(
      "maps a real idempotency primary-key constraint and rolls the attempted command back",
      (t) => {
        const runtime = createRuntime(t);
        const collisionId = uuid(1_600);
        runtime.context.repositories
          .idempotency_requests.insert({
            id: collisionId,
            league_id: IDS.otherLeague,
            actor_user_id:
              IDS.commissioner,
            operation: "fixture.other_operation",
            client_key: "existing-fixture-key",
            request_hash: "e".repeat(64),
            status: "started",
            result_type: null,
            result_id: null,
            created_at_ms: NOW_MS - 2,
            completed_at_ms: null,
            expires_at_ms:
              NOW_MS +
              IDEMPOTENCY_LIFETIME_MS,
          });
        const service = createService(runtime, {
          secureRandom: Object.freeze({
            id: () => collisionId,
          }),
        });
        const before = snapshotTables(
          runtime.database
        );
        assert.throws(
          () =>
            service.record(
              recordCommand(runtime, {
                idempotencyKey:
                  "real-constraint-deadline",
              })
            ),
          (error) =>
            error?.code ===
            "IDEMPOTENCY_REQUEST_UNAVAILABLE"
        );
        assert.equal(
          snapshotTables(runtime.database),
          before
        );
      }
    );

    test(
      "fails closed and rolls back on real settings or league CAS drift inside the transaction",
      (t) => {
        const settingsDrift = createRuntime(t);
        const settingsRepository =
          settingsDrift.tradeDeadlineRepository;
        const settingsService = createService(
          settingsDrift,
          {
            leagueTradeDeadlineRepository:
              Object.freeze({
                ...settingsRepository,
                findContext(options) {
                  const context =
                    settingsRepository.findContext(
                      options
                    );
                  settingsDrift.database
                    .prepare(
                      "UPDATE league_settings " +
                        "SET version = version + 1 " +
                        "WHERE league_id = ?"
                    )
                    .run(IDS.league);
                  return context;
                },
              }),
          }
        );
        const settingsBefore = snapshotTables(
          settingsDrift.database
        );
        assert.throws(
          () =>
            settingsService.record(
              recordCommand(settingsDrift, {
                idempotencyKey:
                  "settings-cas-drift",
              })
            ),
          (error) =>
            error?.code ===
            "LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED"
        );
        assert.equal(
          snapshotTables(
            settingsDrift.database
          ),
          settingsBefore
        );

        const leagueDrift = createRuntime(t);
        const leagueRepository =
          leagueDrift.tradeDeadlineRepository;
        const leagueService = createService(
          leagueDrift,
          {
            leagueTradeDeadlineRepository:
              Object.freeze({
                ...leagueRepository,
                updateSettingsDeadline(
                  options
                ) {
                  const settings =
                    leagueRepository
                      .updateSettingsDeadline(
                        options
                      );
                  leagueDrift.database
                    .prepare(
                      "UPDATE leagues " +
                        "SET version = version + 1 " +
                        "WHERE id = ?"
                    )
                    .run(IDS.league);
                  return settings;
                },
              }),
          }
        );
        const leagueBefore = snapshotTables(
          leagueDrift.database
        );
        assert.throws(
          () =>
            leagueService.record(
              recordCommand(leagueDrift, {
                idempotencyKey:
                  "league-cas-drift",
              })
            ),
          (error) =>
            error?.code ===
            "LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED"
        );
        assert.equal(
          snapshotTables(
            leagueDrift.database
          ),
          leagueBefore
        );
      }
    );

    test(
      "rolls back exact state when every repository write, audit append, or final consistency read fails",
      (t) => {
        const repositorySeams = [
          "insertStartedIdempotency",
          "updateSettingsDeadline",
          "updateSetupLeagueVersion",
          "appendRecordedActivity",
          "writeRecordedOutbox",
          "completeIdempotency",
          "findCurrentAggregate",
          "findRecordedResult",
        ];
        for (const methodName of repositorySeams) {
          const runtime = createRuntime(t);
          const service = createService(runtime, {
            leagueTradeDeadlineRepository:
              repositoryFailingAfterCall(
                runtime.tradeDeadlineRepository,
                methodName
              ),
          });
          const before = snapshotTables(
            runtime.database
          );
          assert.throws(
            () =>
              service.record(
                recordCommand(runtime, {
                  idempotencyKey:
                    `rollback-${methodName}`,
                })
              ),
            (error) =>
              errorChainIncludes(
                error,
                `injected ${methodName} failure`
              )
          );
          assert.equal(
            snapshotTables(
              runtime.database
            ),
            before,
            methodName
          );
        }

        const runtime = createRuntime(t);
        const service = createService(runtime, {
          auditRepository: Object.freeze({
            append(record) {
              runtime.auditRepository.append(
                record
              );
              throw new Error(
                "injected audit append failure"
              );
            },
          }),
        });
        const before = snapshotTables(
          runtime.database
        );
        assert.throws(
          () =>
            service.record(
              recordCommand(runtime, {
                idempotencyKey:
                  "rollback-audit-append",
              })
            ),
          (error) =>
            errorChainIncludes(
              error,
              "injected audit append failure"
            )
        );
        assert.equal(
          snapshotTables(runtime.database),
          before
        );
      }
    );
  }
);
