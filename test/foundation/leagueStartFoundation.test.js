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
  IDEMPOTENCY_LIFETIME_MS,
  LEAGUE_START_OPERATION,
  createLeagueStartService,
  requestHash,
} = require(
  "../../src/application/services/leagues/createLeagueStartService"
);
const {
  LeagueStartPolicyError,
  validateLeagueStartExpectedVersion,
  validateLeagueStartIdempotencyKey,
  validateLeagueStartInput,
  validateLeagueStartLeagueId,
} = require(
  "../../src/domain/leagues/leagueStartPolicy"
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
  createSqliteLeagueStartRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueStartRepository"
);
const {
  createSqliteFreeAgentDraftReadinessHandoffWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadinessHandoffWriter"
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

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-29T16:00:00.000Z");

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
  league: uuid(10),
  season: uuid(11),
  otherLeague: uuid(20),
  otherSeason: uuid(21),
  teams: Object.freeze([
    uuid(30),
    uuid(31),
    uuid(32),
    uuid(33),
  ]),
  managerUsers: Object.freeze([
    uuid(40),
    uuid(41),
    uuid(42),
    uuid(43),
  ]),
  managerMemberships: Object.freeze([
    uuid(50),
    uuid(51),
    uuid(52),
    uuid(53),
  ]),
  managerAssignments: Object.freeze([
    uuid(60),
    uuid(61),
    uuid(62),
    uuid(63),
  ]),
});

const PARTICIPATING_TABLES = Object.freeze([
  "free_agent_draft_readiness_operations",
  "idempotency_requests",
  "job_runs",
  "league_activity",
  "league_settings",
  "leagues",
  "outbox_event_audiences",
  "outbox_events",
  "seasons",
  "security_audit_events",
  "teams",
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
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: id,
    salary_cap_cents: 10000,
    trade_deadline_at_ms:
      NOW_MS + 90 * 24 * 60 * 60 * 1000,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
    version: 1,
  });
}

function insertSeason(
  repositories,
  {
    id,
    leagueId,
    label,
    nhlSeasonKey,
    status = "planned",
  }
) {
  return repositories.seasons.insert({
    id,
    league_id: leagueId,
    label,
    nhl_season_key: nhlSeasonKey,
    status,
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: NOW_MS - 10_000,
    updated_at_ms: NOW_MS - 10_000,
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
    status = "active",
  }
) {
  return repositories.league_memberships.insert({
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status,
    joined_at_ms:
      status === "active" ? NOW_MS - 5_000 : null,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 5_000,
    updated_at_ms: NOW_MS - 5_000,
    version: 1,
  });
}

function seedDatabase(
  context,
  {
    managerless = false,
    mixedTeamState = false,
    teamCount = 4,
  } = {}
) {
  const { repositories } = context;
  insertUser(repositories, {
    id: IDS.commissioner,
    email: "commissioner@fad-start.test",
    displayName: "League Commissioner",
  });
  repositories.sessions.insert({
    id: IDS.commissionerSession,
    user_id: IDS.commissioner,
    token_digest: "a".repeat(64),
    csrf_secret_digest: "b".repeat(64),
    status: "active",
    created_at_ms: NOW_MS - 5_000,
    last_used_at_ms: NOW_MS - 5_000,
    idle_expires_at_ms: NOW_MS + 60 * 60 * 1000,
    absolute_expires_at_ms:
      NOW_MS + 2 * 60 * 60 * 1000,
    revoked_at_ms: null,
    revocation_reason: null,
    client_metadata_json: null,
    version: 1,
  });

  IDS.managerUsers
    .slice(0, teamCount)
    .forEach((id, index) => {
      insertUser(repositories, {
        id,
        email: `manager${index + 1}@fad-start.test`,
        displayName: `Launch Manager ${index + 1}`,
      });
    });

  insertLeague(repositories, {
    id: IDS.league,
    name: "FAD Launch League",
  });
  insertLeague(repositories, {
    id: IDS.otherLeague,
    name: "Untouched League",
  });
  insertSeason(repositories, {
    id: IDS.season,
    leagueId: IDS.league,
    label: "Season 2",
    nhlSeasonKey: "20262027",
  });
  insertSeason(repositories, {
    id: IDS.otherSeason,
    leagueId: IDS.otherLeague,
    label: "Other Season",
    nhlSeasonKey: "other-20262027",
  });

  const commissionerMembership =
    insertMembership(repositories, {
      id: IDS.commissionerMembership,
      leagueId: IDS.league,
      userId: IDS.commissioner,
      permissionCategory: "commissioner",
    });
  const league = repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id:
        commissionerMembership.id,
      current_season_id: IDS.season,
      updated_at_ms: NOW_MS - 4_000,
    },
  });
  repositories.leagues.updateVersioned({
    key: IDS.otherLeague,
    expectedVersion: 1,
    changes: {
      current_season_id: IDS.otherSeason,
      updated_at_ms: NOW_MS - 4_000,
    },
  });

  for (let index = 0; index < teamCount; index += 1) {
    const membership = insertMembership(repositories, {
      id: IDS.managerMemberships[index],
      leagueId: IDS.league,
      userId: IDS.managerUsers[index],
      permissionCategory: "manager",
    });
    repositories.teams.insert({
      id: IDS.teams[index],
      league_id: IDS.league,
      name: `Launch Team ${index + 1}`,
      name_normalized: `launch team ${index + 1}`,
      status:
        mixedTeamState && index === teamCount - 1
          ? "active"
          : "setup",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: NOW_MS - 3_000,
      updated_at_ms: NOW_MS - 3_000,
      version: 1,
    });
    if (!(managerless && index === teamCount - 1)) {
      repositories.team_manager_assignments.insert({
        id: IDS.managerAssignments[index],
        league_id: IDS.league,
        team_id: IDS.teams[index],
        user_id: IDS.managerUsers[index],
        membership_id: membership.id,
        assigned_by_user_id: IDS.commissioner,
        replaces_assignment_id: null,
        status: "accepted",
        assigned_at_ms: NOW_MS - 2_000,
        accepted_at_ms: NOW_MS - 1_000,
        ended_at_ms: null,
        version: 1,
      });
    }
  }
  return Object.freeze({
    expectedLeagueVersion: league.version,
  });
}

function authenticatedCommissioner() {
  return Object.freeze({
    valid: true,
    session: Object.freeze({
      id: IDS.commissionerSession,
      userId: IDS.commissioner,
    }),
    user: Object.freeze({
      id: IDS.commissioner,
      status: "active",
      version: 1,
    }),
  });
}

function attachRuntime(runtime) {
  const { database } = runtime.connection;
  runtime.database = database;
  runtime.context = createSqliteRepositoryContext({
    database,
  });
  runtime.leagueStartRepository =
    createSqliteLeagueStartRepository({
      database,
    });
  runtime.auditRepository =
    createSqliteSecurityAuditRepository({
      database,
    });
  runtime.freeAgentDraftReadinessHandoffWriter =
    createSqliteFreeAgentDraftReadinessHandoffWriter({
      database,
    });
  runtime.leagueAuthorization =
    createLeagueAuthorizationService({
      userRepository: createSqliteUserRepository({
        database,
      }),
      leagueAccessRepository:
        createSqliteLeagueAccessRepository({
          database,
        }),
    });
  runtime.service = createLeagueStartService({
    repositoryContext: runtime.context,
    leagueAuthorization:
      runtime.leagueAuthorization,
    leagueStartRepository:
      runtime.leagueStartRepository,
    freeAgentDraftReadinessHandoffWriter:
      runtime.freeAgentDraftReadinessHandoffWriter,
    auditRepository: runtime.auditRepository,
    clock: runtime.clock,
    secureRandom: runtime.secureRandom,
  });
  return runtime;
}

function createRuntime(t, options = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-04-start-")
  );
  const runtime = {
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
    temporaryRoot,
    clock: Object.freeze({ nowMs: () => NOW_MS }),
    nextSecureId: 500,
  };
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
    applicationBuildId: "fad-04-league-start-test",
    now: () => NOW_MS,
  });
  const context = createSqliteRepositoryContext({
    database: runtime.connection.database,
  });
  const seeded = seedDatabase(context, options);
  runtime.expectedLeagueVersion =
    seeded.expectedLeagueVersion;
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
  return createLeagueStartService({
    repositoryContext: runtime.context,
    leagueAuthorization:
      runtime.leagueAuthorization,
    leagueStartRepository:
      runtime.leagueStartRepository,
    freeAgentDraftReadinessHandoffWriter:
      runtime.freeAgentDraftReadinessHandoffWriter,
    auditRepository: runtime.auditRepository,
    clock: runtime.clock,
    secureRandom: runtime.secureRandom,
    ...overrides,
  });
}

function startCommand(runtime, overrides = {}) {
  return {
    leagueId: IDS.league,
    input: {},
    expectedLeagueVersion:
      runtime.expectedLeagueVersion,
    idempotencyKey: "fad-04-start-league",
    authenticated: authenticatedCommissioner(),
    auditContext: {
      requestCorrelationId: uuid(800),
      networkKeyVersion: 1,
      networkMetadataDigest: "c".repeat(64),
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

function participatingSnapshot(database) {
  return JSON.stringify(
    Object.fromEntries(
      PARTICIPATING_TABLES.map((tableName) => [
        tableName,
        rows(database, tableName),
      ])
    )
  );
}

function crossLeagueSnapshot(database) {
  const scopedTables = [
    "free_agent_draft_readiness_operations",
    "job_runs",
    "league_activity",
    "league_invitations",
    "league_memberships",
    "outbox_event_audiences",
    "outbox_events",
    "seasons",
    "teams",
    "team_manager_assignments",
  ];
  return JSON.stringify({
    league: database
      .prepare(
        "SELECT * FROM leagues WHERE id = ?"
      )
      .get(IDS.otherLeague),
    settings: database
      .prepare(
        "SELECT * FROM league_settings WHERE league_id = ?"
      )
      .get(IDS.otherLeague),
    scoped: Object.fromEntries(
      scopedTables.map((tableName) => [
        tableName,
        database
          .prepare(
            `SELECT * FROM "${tableName}" ` +
              "WHERE league_id = ? ORDER BY rowid ASC"
          )
          .all(IDS.otherLeague),
      ])
    ),
    audits: database
      .prepare(
        "SELECT * FROM security_audit_events " +
          "WHERE league_id = ? ORDER BY rowid ASC"
      )
      .all(IDS.otherLeague),
    idempotency: database
      .prepare(
        "SELECT * FROM idempotency_requests " +
          "WHERE league_id = ? ORDER BY rowid ASC"
      )
      .all(IDS.otherLeague),
  });
}

function tableCount(database, tableName) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM "${tableName}"`
    )
    .get().count;
}

function addInvitation(
  runtime,
  {
    sequence,
    status,
    workflow,
    teamId = null,
  }
) {
  const userId = uuid(1_000 + sequence);
  const membershipId = uuid(1_100 + sequence);
  const invitationId = uuid(1_200 + sequence);
  const email = `invite${sequence}@fad-start.test`;
  insertUser(runtime.context.repositories, {
    id: userId,
    email,
    displayName: `Invited Manager ${sequence}`,
  });
  insertMembership(runtime.context.repositories, {
    id: membershipId,
    leagueId: IDS.league,
    userId,
    permissionCategory: "manager",
    status: status === "accepted" ? "active" : "invited",
  });
  runtime.context.repositories.league_invitations.insert({
    id: invitationId,
    league_id: IDS.league,
    invited_email_normalized: email,
    invited_user_id: userId,
    inviting_user_id: IDS.commissioner,
    membership_id: membershipId,
    workflow,
    team_id: teamId,
    status,
    created_at_ms: NOW_MS - 2_000,
    expires_at_ms:
      status === "expired"
        ? NOW_MS - 1_000
        : NOW_MS + 10_000,
    accepted_at_ms:
      status === "accepted"
        ? NOW_MS - 1_000
        : null,
    version: 1,
  });
  return Object.freeze({
    invitationId,
    membershipId,
    userId,
  });
}

function assertFailureWithoutWrites(
  runtime,
  code,
  command = startCommand(runtime)
) {
  const before = participatingSnapshot(
    runtime.database
  );
  assert.throws(
    () => runtime.service.start(command),
    (error) => error?.code === code
  );
  assert.equal(
    participatingSnapshot(runtime.database),
    before
  );
}

describe("FAD-04 T-036 league-start policy", () => {
  test("accepts only an exact empty body and canonical command metadata", () => {
    assert.deepEqual(
      validateLeagueStartInput({}),
      {}
    );
    assert.equal(
      validateLeagueStartLeagueId(IDS.league),
      IDS.league
    );
    assert.equal(
      validateLeagueStartExpectedVersion(2),
      2
    );
    assert.equal(
      validateLeagueStartIdempotencyKey(
        "league-start-key"
      ),
      "league-start-key"
    );

    for (const [callback, reasonCode] of [
      [
        () => validateLeagueStartInput(null),
        "body_invalid",
      ],
      [
        () =>
          validateLeagueStartInput({
            start: true,
          }),
        "body_invalid",
      ],
      [
        () =>
          validateLeagueStartLeagueId(
            "not-a-league-id"
          ),
        "league_id_invalid",
      ],
      [
        () =>
          validateLeagueStartExpectedVersion(0),
        "expected_version_invalid",
      ],
      [
        () =>
          validateLeagueStartIdempotencyKey(
            " padded "
          ),
        "idempotency_key_invalid",
      ],
      [
        () =>
          validateLeagueStartIdempotencyKey(
            "league\u0085start"
          ),
        "idempotency_key_invalid",
      ],
      [
        () =>
          validateLeagueStartIdempotencyKey(
            "league\u2028start"
          ),
        "idempotency_key_invalid",
      ],
    ]) {
      assert.throws(
        callback,
        (error) =>
          error instanceof LeagueStartPolicyError &&
          error.code ===
            "LEAGUE_START_INPUT_INVALID" &&
          error.reasonCode === reasonCode
      );
    }
  });

  test("hashes league identity, operation, and expected version deterministically", () => {
    const first = requestHash({
      leagueId: IDS.league,
      expectedLeagueVersion: 2,
    });
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(
      first,
      requestHash({
        leagueId: IDS.league,
        expectedLeagueVersion: 2,
      })
    );
    assert.notEqual(
      first,
      requestHash({
        leagueId: IDS.league,
        expectedLeagueVersion: 3,
      })
    );
    assert.equal(
      LEAGUE_START_OPERATION,
      "league.start.v1"
    );
  });
});

describe("FAD-04 T-036 atomic initial league start", () => {
  test("activates four teams, the sole season, and the league with exact evidence and cross-league isolation", (t) => {
    const runtime = createRuntime(t);
    const otherBefore = crossLeagueSnapshot(
      runtime.database
    );
    const result = runtime.service.start(
      startCommand(runtime)
    );

    assert.equal(result.code, "LEAGUE_STARTED");
    assert.equal(result.replayed, false);
    assert.deepEqual(result, {
      code: "LEAGUE_STARTED",
      league: {
        id: IDS.league,
        name: "FAD Launch League",
        status: "active",
        timezone: "America/Vancouver",
        version:
          runtime.expectedLeagueVersion + 1,
        currentSeason: {
          id: IDS.season,
          label: "Season 2",
          nhlSeasonKey: "20262027",
          status: "active",
          version: 2,
        },
      },
      activatedTeamCount: 4,
      startedAtMs: NOW_MS,
    });

    const league = runtime.database
      .prepare(
        "SELECT * FROM leagues WHERE id = ?"
      )
      .get(IDS.league);
    assert.equal(league.status, "active");
    assert.equal(
      league.version,
      runtime.expectedLeagueVersion + 1
    );
    assert.equal(league.updated_at_ms, NOW_MS);
    const season = runtime.database
      .prepare(
        "SELECT * FROM seasons WHERE id = ?"
      )
      .get(IDS.season);
    assert.equal(season.status, "active");
    assert.equal(season.version, 2);
    assert.equal(season.updated_at_ms, NOW_MS);
    const teams = runtime.database
      .prepare(
        "SELECT * FROM teams WHERE league_id = ? " +
          "ORDER BY id ASC"
      )
      .all(IDS.league);
    assert.equal(teams.length, 4);
    assert(
      teams.every(
        (team) =>
          team.status === "active" &&
          team.version === 2 &&
          team.updated_at_ms === NOW_MS
      )
    );

    const activity = runtime.database
      .prepare(
        "SELECT * FROM league_activity " +
          "WHERE league_id = ?"
      )
      .get(IDS.league);
    assert.equal(activity.id, uuid(500));
    assert.equal(activity.event_type, "league_started");
    assert.equal(
      activity.actor_user_id,
      IDS.commissioner
    );
    assert.equal(
      activity.actor_authority,
      "commissioner"
    );
    assert.equal(activity.season_id, IDS.season);
    assert.equal(activity.related_type, "league");
    assert.equal(activity.related_id, IDS.league);
    assert.equal(
      activity.display_summary,
      "FAD Launch League was started."
    );
    assert.deepEqual(
      JSON.parse(activity.metadata_json),
      {
        activatedTeamCount: 4,
        leagueId: IDS.league,
        leagueName: "FAD Launch League",
        leagueStatus: "active",
        leagueTimezone: "America/Vancouver",
        leagueVersion:
          runtime.expectedLeagueVersion + 1,
        seasonId: IDS.season,
        seasonLabel: "Season 2",
        nhlSeasonKey: "20262027",
        seasonStatus: "active",
        seasonVersion: 2,
        startedAtMs: NOW_MS,
      }
    );

    const audit = runtime.database
      .prepare(
        "SELECT * FROM security_audit_events " +
          "WHERE league_id = ?"
      )
      .get(IDS.league);
    assert.equal(audit.id, uuid(501));
    assert.equal(audit.event_type, "league.started");
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

    const outbox = runtime.database
      .prepare(
        "SELECT * FROM outbox_events " +
          "WHERE league_id = ?"
      )
      .get(IDS.league);
    assert.equal(outbox.id, uuid(503));
    assert.equal(outbox.event_type, "league.changed");
    assert.equal(outbox.aggregate_type, "league");
    assert.equal(outbox.aggregate_id, IDS.league);
    assert.equal(outbox.status, "pending");
    assert.deepEqual(JSON.parse(outbox.payload_json), {
      eventId: uuid(503),
      type: "league.changed",
      leagueId: IDS.league,
      resourceId: IDS.league,
      version:
        runtime.expectedLeagueVersion + 1,
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
    });
    const audience = runtime.database
      .prepare(
        "SELECT * FROM outbox_event_audiences " +
          "WHERE league_id = ?"
      )
      .get(IDS.league);
    assert.equal(audience.outbox_event_id, outbox.id);
    assert.equal(audience.audience_kind, "league");
    assert.equal(audience.team_id, null);
    assert.equal(audience.user_id, null);

    const idempotency = runtime.database
      .prepare(
        "SELECT * FROM idempotency_requests " +
          "WHERE league_id = ?"
      )
      .get(IDS.league);
    assert.equal(idempotency.id, uuid(502));
    assert.equal(idempotency.status, "completed");
    assert.equal(
      idempotency.result_type,
      "league_start"
    );
    assert.equal(
      idempotency.result_id,
      activity.id
    );
    assert.equal(
      idempotency.completed_at_ms,
      NOW_MS
    );
    assert.equal(
      idempotency.expires_at_ms,
      NOW_MS + IDEMPOTENCY_LIFETIME_MS
    );

    const readinessOccurrenceKey = [
      "fad-readiness",
      IDS.league,
      IDS.season,
      IDS.season,
    ].join(":");
    assert.deepEqual(
      rows(
        runtime.database,
        "free_agent_draft_readiness_operations"
      ),
      [
        {
          id: uuid(504),
          league_id: IDS.league,
          season_id: IDS.season,
          readiness_occurrence_key:
            readinessOccurrenceKey,
          trigger_kind: "no_draft_inaugural",
          entry_draft_id: null,
          setup_exemption_id: null,
          job_run_id: uuid(505),
          status: "pending",
          attempt_count: 0,
          lease_owner: null,
          lease_token: null,
          lease_expires_at_ms: null,
          blockers_json: "[]",
          matchup_schedule_version_before: null,
          matchup_schedule_version_after: null,
          schedule_recovery_id: null,
          created_fad_id: null,
          reminder_job_run_id: null,
          deadline_job_run_id: null,
          cards_opened_activity_id: null,
          cards_opened_outbox_event_id: null,
          started_at_ms: null,
          next_retry_at_ms: null,
          terminal_at_ms: null,
          created_at_ms: NOW_MS,
          updated_at_ms: NOW_MS,
          version: 1,
        },
      ]
    );
    assert.deepEqual(
      rows(runtime.database, "job_runs"),
      [
        {
          id: uuid(505),
          league_id: IDS.league,
          season_id: IDS.season,
          job_type: "fad_readiness",
          occurrence_key: readinessOccurrenceKey,
          scheduled_for_ms: NOW_MS,
          status: "pending",
          attempt_count: 0,
          lease_owner: null,
          lease_expires_at_ms: null,
          started_at_ms: null,
          completed_at_ms: null,
          result_json: null,
          last_error_code: null,
          created_at_ms: NOW_MS,
          updated_at_ms: NOW_MS,
          version: 1,
          lease_token: null,
          next_attempt_at_ms: null,
        },
      ]
    );
    assert.equal(runtime.nextSecureId, 506);

    for (const tableName of [
      "candidate_card_entries",
      "candidate_card_help_requests",
      "candidate_card_revisions",
      "candidate_card_snapshot_entries",
      "candidate_card_snapshots",
      "candidate_cards",
      "free_agent_drafts",
      "free_agent_draft_setup_exemptions",
      "notifications",
      "season_rollovers",
    ]) {
      assert.equal(
        tableCount(runtime.database, tableName),
        0
      );
    }
    assert.equal(
      crossLeagueSnapshot(runtime.database),
      otherBefore
    );
  });

  test("replays the exact durable result after reopen and later benign aggregate changes without writes", (t) => {
    const runtime = createRuntime(t);
    const command = startCommand(runtime);
    const original = runtime.service.start(command);
    let handoffCallCount = 0;

    reopenRuntime(runtime);
    runtime.service = createService(runtime, {
      freeAgentDraftReadinessHandoffWriter: {
        write() {
          handoffCallCount += 1;
          throw new Error(
            "a completed replay must not invoke the readiness handoff"
          );
        },
      },
    });
    const beforeReopenReplay =
      participatingSnapshot(runtime.database);
    const reopenedReplay =
      runtime.service.start(command);
    assert.deepEqual(reopenedReplay, original);
    assert.equal(reopenedReplay.replayed, true);
    assert.equal(
      participatingSnapshot(runtime.database),
      beforeReopenReplay
    );
    assert.equal(handoffCallCount, 0);

    runtime.database.prepare(`
      UPDATE leagues
      SET name = 'Renamed After Start',
        name_normalized = 'renamed after start',
        timezone = 'UTC',
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @leagueId
    `).run({
      leagueId: IDS.league,
      nowMs: NOW_MS + 1_000,
    });
    runtime.database.prepare(`
      UPDATE teams
      SET name = 'Renamed Team After Start',
        name_normalized = 'renamed team after start',
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @teamId
    `).run({
      teamId: IDS.teams[0],
      nowMs: NOW_MS + 1_000,
    });

    const beforeMutatedReplay =
      participatingSnapshot(runtime.database);
    const mutatedReplay =
      runtime.service.start(command);
    assert.deepEqual(mutatedReplay, original);
    assert.equal(mutatedReplay.replayed, true);
    assert.equal(
      mutatedReplay.league.name,
      "FAD Launch League"
    );
    assert.equal(
      mutatedReplay.league.timezone,
      "America/Vancouver"
    );
    assert.equal(
      participatingSnapshot(runtime.database),
      beforeMutatedReplay
    );
    assert.equal(handoffCallCount, 0);
    assert.equal(
      tableCount(
        runtime.database,
        "free_agent_draft_readiness_operations"
      ),
      1
    );
    assert.equal(
      tableCount(runtime.database, "job_runs"),
      1
    );
  });

  test("rejects same-key changed input and a new start key after activation without writes", (t) => {
    const runtime = createRuntime(t);
    runtime.service.start(startCommand(runtime));
    const currentVersion = runtime.database
      .prepare(
        "SELECT version FROM leagues WHERE id = ?"
      )
      .get(IDS.league).version;

    assertFailureWithoutWrites(
      runtime,
      "IDEMPOTENCY_KEY_REUSED",
      startCommand(runtime, {
        expectedLeagueVersion: currentVersion,
      })
    );
    assertFailureWithoutWrites(
      runtime,
      "LEAGUE_START_NOT_ALLOWED",
      startCommand(runtime, {
        expectedLeagueVersion: currentVersion,
        idempotencyKey: "new-league-start-key",
      })
    );
  });

  test("rejects a stale league version without writes", (t) => {
    const runtime = createRuntime(t);
    assertFailureWithoutWrites(
      runtime,
      "LEAGUE_START_PRECONDITION_FAILED",
      startCommand(runtime, {
        expectedLeagueVersion:
          runtime.expectedLeagueVersion + 1,
      })
    );
  });

  test("requires at least four non-erased setup teams", (t) => {
    const runtime = createRuntime(t, {
      teamCount: 3,
    });
    assertFailureWithoutWrites(
      runtime,
      "LEAGUE_START_MINIMUM_TEAMS_REQUIRED"
    );
  });

  test("requires one complete settings row with the commissioner-configured trade deadline", (t) => {
    const missingSettings = createRuntime(t);
    missingSettings.database
      .prepare(
        "DELETE FROM league_settings WHERE league_id = ?"
      )
      .run(IDS.league);
    assertFailureWithoutWrites(
      missingSettings,
      "LEAGUE_START_SETTINGS_INVALID"
    );

    const missingDeadline = createRuntime(t);
    missingDeadline.database
      .prepare(
        "UPDATE league_settings " +
          "SET trade_deadline_at_ms = NULL " +
          "WHERE league_id = ?"
      )
      .run(IDS.league);
    assertFailureWithoutWrites(
      missingDeadline,
      "LEAGUE_START_SETTINGS_INVALID"
    );
  });

  test("accepts a commissioner membership as the current manager of a launch team and its accepted invitation", (t) => {
    const runtime = createRuntime(t);
    runtime.database
      .prepare(`
        UPDATE team_manager_assignments
        SET user_id = @userId,
          membership_id = @membershipId
        WHERE league_id = @leagueId
          AND id = @assignmentId
      `)
      .run({
        assignmentId: IDS.managerAssignments[0],
        leagueId: IDS.league,
        membershipId: IDS.commissionerMembership,
        userId: IDS.commissioner,
      });
    runtime.context.repositories.league_invitations.insert({
      id: uuid(1_300),
      league_id: IDS.league,
      invited_email_normalized:
        "commissioner@fad-start.test",
      invited_user_id: IDS.commissioner,
      inviting_user_id: IDS.commissioner,
      membership_id: IDS.commissionerMembership,
      workflow: "manage_team",
      team_id: IDS.teams[0],
      status: "accepted",
      created_at_ms: NOW_MS - 2_000,
      expires_at_ms: NOW_MS + 10_000,
      accepted_at_ms: NOW_MS - 1_000,
      version: 1,
    });

    const result = runtime.service.start(
      startCommand(runtime)
    );
    assert.equal(result.code, "LEAGUE_STARTED");
    assert.equal(result.activatedTeamCount, 4);
  });

  test("rejects pending launch invitations", (t) => {
    const runtime = createRuntime(t);
    addInvitation(runtime, {
      sequence: 1,
      status: "pending",
      workflow: "create_team",
    });
    assertFailureWithoutWrites(
      runtime,
      "LEAGUE_START_INVITATIONS_PENDING"
    );
  });

  test("rejects an accepted invitation whose membership, team, and manager assignment do not form one current link", (t) => {
    const runtime = createRuntime(t);
    addInvitation(runtime, {
      sequence: 2,
      status: "accepted",
      workflow: "create_team",
      teamId: IDS.teams[0],
    });
    assertFailureWithoutWrites(
      runtime,
      "LEAGUE_START_INVITATION_STATE_INVALID"
    );
  });

  test("rejects managerless and mixed-state launch teams", (t) => {
    const managerless = createRuntime(t, {
      managerless: true,
    });
    assertFailureWithoutWrites(
      managerless,
      "LEAGUE_START_TEAM_MANAGER_REQUIRED"
    );

    const mixed = createRuntime(t, {
      mixedTeamState: true,
    });
    assertFailureWithoutWrites(
      mixed,
      "LEAGUE_START_TEAM_STATE_INVALID"
    );
  });

  test("rejects non-planned, missing-current, and non-sole season state", (t) => {
    const nonPlanned = createRuntime(t);
    nonPlanned.database
      .prepare(
        "UPDATE seasons SET status = 'active' " +
          "WHERE id = ?"
      )
      .run(IDS.season);
    assertFailureWithoutWrites(
      nonPlanned,
      "LEAGUE_START_SEASON_INVALID"
    );

    const missingCurrent = createRuntime(t);
    missingCurrent.database
      .prepare(
        "UPDATE leagues SET current_season_id = NULL " +
          "WHERE id = ?"
      )
      .run(IDS.league);
    assertFailureWithoutWrites(
      missingCurrent,
      "LEAGUE_START_SEASON_INVALID"
    );

    const multiple = createRuntime(t);
    insertSeason(multiple.context.repositories, {
      id: uuid(90),
      leagueId: IDS.league,
      label: "Extra Planned Season",
      nhlSeasonKey: "20272028",
    });
    assertFailureWithoutWrites(
      multiple,
      "LEAGUE_START_SEASON_INVALID"
    );
  });

  test("treats cancelled, expired, and legacy null-workflow invitations as nonblocking terminal history", (t) => {
    const runtime = createRuntime(t);
    addInvitation(runtime, {
      sequence: 3,
      status: "cancelled",
      workflow: "create_team",
    });
    addInvitation(runtime, {
      sequence: 4,
      status: "expired",
      workflow: "manage_team",
      teamId: IDS.teams[0],
    });
    addInvitation(runtime, {
      sequence: 5,
      status: "pending",
      workflow: null,
    });

    const context =
      runtime.leagueStartRepository.findStartContext({
        leagueId: IDS.league,
      });
    assert.equal(context.launch_invitation_count, 2);
    assert.equal(
      context.pending_launch_invitation_count,
      0
    );
    assert.equal(
      context.accepted_launch_invitation_count,
      0
    );
    assert.equal(
      context.invalid_accepted_invitation_count,
      0
    );

    const result = runtime.service.start(
      startCommand(runtime)
    );
    assert.equal(result.code, "LEAGUE_STARTED");
    assert.equal(result.activatedTeamCount, 4);
  });

  test("maps a real idempotency primary-key constraint without leaking a generic repository failure", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.idempotency_requests.insert({
      id: uuid(502),
      league_id: IDS.otherLeague,
      actor_user_id: IDS.commissioner,
      operation: "constraint-regression",
      client_key: "preexisting-id",
      request_hash: "d".repeat(64),
      status: "started",
      result_type: null,
      result_id: null,
      created_at_ms: NOW_MS - 1_000,
      completed_at_ms: null,
      expires_at_ms: NOW_MS + 10_000,
    });
    assertFailureWithoutWrites(
      runtime,
      "IDEMPOTENCY_REQUEST_UNAVAILABLE"
    );
  });

  for (const failingStep of [
    "after_readiness_job_insert",
    "after_readiness_operation_insert",
  ]) {
    test(`rolls back the complete league start at ${failingStep}`, (t) => {
      const runtime = createRuntime(t);
      const before = participatingSnapshot(
        runtime.database
      );
      const writer =
        createSqliteFreeAgentDraftReadinessHandoffWriter({
          database: runtime.database,
          afterStep(step) {
            if (step === failingStep) {
              throw new Error(
                `injected ${failingStep} failure`
              );
            }
          },
        });
      const service = createService(runtime, {
        freeAgentDraftReadinessHandoffWriter:
          writer,
      });

      assert.throws(
        () => service.start(startCommand(runtime)),
        (error) =>
          error?.code ===
          "REPOSITORY_OPERATION_FAILED",
        failingStep
      );
      assert.equal(
        participatingSnapshot(runtime.database),
        before,
        failingStep
      );
      assert.equal(
        tableCount(
          runtime.database,
          "free_agent_draft_readiness_operations"
        ),
        0,
        failingStep
      );
      assert.equal(
        tableCount(runtime.database, "job_runs"),
        0,
        failingStep
      );
    });
  }

  test("rolls back every write and post-write verification seam", (t) => {
    const repositorySeams = [
      "insertStartedIdempotency",
      "activateSetupTeams",
      "activatePlannedSeason",
      "activateSetupLeague",
      "appendStartedActivity",
      "writeStartedOutbox",
      "completeIdempotency",
      "findStartedAggregate",
      "findStartedResult",
    ];
    for (const seam of repositorySeams) {
      const runtime = createRuntime(t);
      const before = participatingSnapshot(
        runtime.database
      );
      const original =
        runtime.leagueStartRepository[seam];
      const repository = {
        ...runtime.leagueStartRepository,
        [seam](...args) {
          original(...args);
          throw new Error(
            `injected ${seam} failure`
          );
        },
      };
      const service = createService(runtime, {
        leagueStartRepository: repository,
      });
      assert.throws(
        () => service.start(startCommand(runtime)),
        (error) =>
          error?.code ===
          "REPOSITORY_OPERATION_FAILED",
        seam
      );
      assert.equal(
        participatingSnapshot(runtime.database),
        before,
        seam
      );
    }

    const auditFailure = createRuntime(t);
    const beforeAudit = participatingSnapshot(
      auditFailure.database
    );
    const service = createService(auditFailure, {
      auditRepository: {
        append(record) {
          auditFailure.auditRepository.append(
            record
          );
          throw new Error(
            "injected Security Audit failure"
          );
        },
      },
    });
    assert.throws(
      () =>
        service.start(startCommand(auditFailure)),
      (error) =>
        error?.code ===
        "REPOSITORY_OPERATION_FAILED"
    );
    assert.equal(
      participatingSnapshot(auditFailure.database),
      beforeAudit
    );
  });
});
