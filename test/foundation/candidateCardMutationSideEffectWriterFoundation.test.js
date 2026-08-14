const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  after,
  before,
  describe,
  test,
} = require("node:test");

const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require("../../src/domain/leagues/socketInvalidation");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteCandidateCardMutationSideEffectWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardMutationSideEffectWriter"
);
const {
  createSqliteCandidateCardHelpSideEffectWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardHelpSideEffectWriter"
);
const {
  createSqliteLeagueOutboxWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxWriter"
);
const {
  createSqliteLeagueOutboxRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxRepository"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const FIRST_MATCHUP_STARTS_AT_MS = 2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 604_800_000;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 172_800_000;
const OPENED_AT_MS = HELP_OPENS_AT_MS - 10_000;
const CHANGED_AT_MS = HELP_OPENS_AT_MS + 1_000;

let templateRoot;
let templatePath;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  commissionerUser: uuid(1),
  administratorUser: uuid(2),
  managerUser: uuid(3),
  memberUser: uuid(4),
  outsiderAdministratorUser: uuid(5),
  commissionerRole: uuid(11),
  administratorRole: uuid(12),
  outsiderAdministratorRole: uuid(13),
  league: uuid(21),
  otherLeague: uuid(22),
  commissionerMembership: uuid(31),
  administratorMembership: uuid(32),
  managerMembership: uuid(33),
  memberMembership: uuid(34),
  outsiderAdministratorMembership: uuid(35),
  season: uuid(41),
  team: uuid(42),
  otherTeam: uuid(43),
  managerAssignment: uuid(44),
  week: uuid(45),
  readiness: uuid(46),
  fad: uuid(47),
  participant: uuid(48),
  card: uuid(49),
  help: uuid(50),
  revision: uuid(61),
  secondRevision: uuid(62),
  thirdRevision: uuid(63),
  fourthRevision: uuid(64),
  fifthRevision: uuid(65),
});

const SYSTEM_ACTION_CASES = Object.freeze([
  Object.freeze({
    kind: "candidate_card_carryovers_synchronized",
    action: "carryover_synchronized",
    revisionId: IDS.secondRevision,
    cardVersion: 3,
  }),
  Object.freeze({
    kind: "candidate_card_eligibility_revalidated",
    action: "eligibility_revalidated",
    revisionId: IDS.fourthRevision,
    cardVersion: 4,
  }),
  Object.freeze({
    kind: "candidate_card_summer_state_synchronized",
    action: "summer_state_synchronized",
    revisionId: IDS.fifthRevision,
    cardVersion: 5,
  }),
]);

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  return database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function count(database, tableName, where = "", parameters = {}) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName} ${where}`
    )
    .get(parameters).count;
}

before(() => {
  templateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-candidate-side-effects-template-")
  );
  templatePath = path.join(templateRoot, "template.sqlite3");
  const connection = openDatabase({
    databasePath: templatePath,
    environment: "test",
  });
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }),
    applicationBuildId:
      "candidate-card-mutation-side-effect-writer-foundation",
    now: () => 1_000,
  });
  connection.database.close();
});

after(() => {
  if (templateRoot) {
    fs.rmSync(templateRoot, { recursive: true, force: true });
  }
});

function seedUser(database, id, label) {
  insert(database, "users", {
    id,
    email_normalized: `${label.toLowerCase()}@example.test`,
    email_display: `${label}@example.test`,
    display_name: label,
    display_name_normalized: label.toLowerCase(),
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function seedMembership(
  database,
  { id, leagueId, userId, permissionCategory }
) {
  insert(database, "league_memberships", {
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: 10,
    ended_at_ms: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function seedFixture(database) {
  for (const [id, label] of [
    [IDS.commissionerUser, "Commissioner"],
    [IDS.administratorUser, "Administrator"],
    [IDS.managerUser, "Manager"],
    [IDS.memberUser, "Member"],
    [IDS.outsiderAdministratorUser, "Outsider Administrator"],
  ]) {
    seedUser(database, id, label);
  }

  for (const [id, name, normalized] of [
    [IDS.league, "Candidate League", "candidate league"],
    [IDS.otherLeague, "Other League", "other league"],
  ]) {
    insert(database, "leagues", {
      id,
      name,
      name_normalized: normalized,
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
  }

  for (const membership of [
    {
      id: IDS.commissionerMembership,
      leagueId: IDS.league,
      userId: IDS.commissionerUser,
      permissionCategory: "commissioner",
    },
    {
      id: IDS.administratorMembership,
      leagueId: IDS.league,
      userId: IDS.administratorUser,
      permissionCategory: "member",
    },
    {
      id: IDS.managerMembership,
      leagueId: IDS.league,
      userId: IDS.managerUser,
      permissionCategory: "manager",
    },
    {
      id: IDS.memberMembership,
      leagueId: IDS.league,
      userId: IDS.memberUser,
      permissionCategory: "member",
    },
    {
      id: IDS.outsiderAdministratorMembership,
      leagueId: IDS.otherLeague,
      userId: IDS.outsiderAdministratorUser,
      permissionCategory: "member",
    },
  ]) {
    seedMembership(database, membership);
  }

  for (const [id, userId] of [
    [IDS.commissionerRole, IDS.commissionerUser],
    [IDS.administratorRole, IDS.administratorUser],
    [
      IDS.outsiderAdministratorRole,
      IDS.outsiderAdministratorUser,
    ],
  ]) {
    insert(database, "platform_roles", {
      id,
      user_id: userId,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: null,
      granted_at_ms: 10,
      ended_at_ms: null,
      version: 1,
    });
  }

  insert(database, "league_settings", {
    league_id: IDS.league,
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
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    regular_season_ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    fantasy_playoffs_start_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 8_000,
    fantasy_playoffs_end_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  database
    .prepare(`
      UPDATE leagues
      SET status = 'active',
          commissioner_membership_id = @commissionerMembershipId,
          current_season_id = @seasonId,
          updated_at_ms = 20,
          version = 2
      WHERE id = @leagueId
    `)
    .run({
      commissionerMembershipId: IDS.commissionerMembership,
      seasonId: IDS.season,
      leagueId: IDS.league,
    });

  for (const [id, leagueId, name, normalized] of [
    [IDS.team, IDS.league, "Candidate Team", "candidate team"],
    [IDS.otherTeam, IDS.otherLeague, "Other Team", "other team"],
  ]) {
    insert(database, "teams", {
      id,
      league_id: leagueId,
      name,
      name_normalized: normalized,
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: 20,
      updated_at_ms: 20,
      version: 1,
    });
  }
  insert(database, "team_manager_assignments", {
    id: IDS.managerAssignment,
    league_id: IDS.league,
    team_id: IDS.team,
    user_id: IDS.managerUser,
    membership_id: IDS.managerMembership,
    assigned_by_user_id: IDS.commissionerUser,
    status: "accepted",
    assigned_at_ms: 20,
    accepted_at_ms: 20,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: IDS.week,
    league_id: IDS.league,
    season_id: IDS.season,
    week_key: "W01",
    sequence: 1,
    starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    baseline_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 100,
    locks_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 200,
    ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 1_000,
    rolls_over_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 1_100,
    status: "scheduled",
    created_at_ms: 20,
    updated_at_ms: 20,
    version: 1,
  });
  insert(database, "free_agent_draft_readiness_operations", {
    id: IDS.readiness,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_occurrence_key: `fad:${IDS.season}:readiness`,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    status: "pending",
    attempt_count: 0,
    blockers_json: "[]",
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  insert(database, "free_agent_drafts", {
    id: IDS.fad,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    readiness_occurrence_key: `fad:${IDS.season}:readiness`,
    first_matchup_week_id: IDS.week,
    current_competition_first_matchup_week_id: IDS.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "cards_open",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Side-effect writer fixture.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: HELP_OPENS_AT_MS,
    candidate_deadline_at_ms: CANDIDATE_DEADLINE_AT_MS,
    first_matchup_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    deadline_locked_at_ms: null,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  insert(database, "free_agent_draft_teams", {
    id: IDS.participant,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: IDS.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  });
  insert(database, "candidate_cards", {
    id: IDS.card,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: IDS.team,
    status: "open",
    completeness_code: "incomplete",
    filled_mandatory_count: 0,
    missing_mandatory_count: 18,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    maximum_possible_cap_cents: 0,
    locked_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
}

function createRuntime(t, { leagueOutboxWriter } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-candidate-side-effects-")
  );
  const databasePath = path.join(root, "league.sqlite3");
  fs.copyFileSync(templatePath, databasePath);
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  connection.database.exec(
    "DROP TRIGGER free_agent_drafts_valid_insert"
  );
  seedFixture(connection.database);
  const write =
    createSqliteCandidateCardMutationSideEffectWriter({
      database: connection.database,
      leagueOutboxWriter,
    });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({
    database: connection.database,
    write,
  });
}

function scope(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    cardId: IDS.card,
    teamId: IDS.team,
    ...overrides,
  };
}

function managerAuthority(overrides = {}) {
  return {
    accessReason: "team_manager",
    authorizationEvidence: {
      kind: "manager_assignment",
      id: IDS.managerAssignment,
    },
    actorDisplayName: "Manager",
    decision: {
      actorAuthority: "manager",
      helpWindowOpen: true,
      accessSource: "manager_assignment",
      canReadPrivateCard: true,
      canEditCandidateEntries: true,
      canMoveEligibleCarryovers: true,
      canRemoveCarryovers: false,
      canEditCarryoverContracts: false,
      canRequestHelp: true,
    },
    help: null,
    ...overrides,
  };
}

function managerInput(overrides = {}) {
  return {
    kind: "candidate_card_changed",
    scope: scope(),
    actor: {
      userId: IDS.managerUser,
      membershipId: IDS.managerMembership,
      authority: "manager",
    },
    authority: managerAuthority(),
    action: "candidate_added",
    revisionId: IDS.revision,
    cardVersion: 2,
    changedAtMs: CHANGED_AT_MS,
    ...overrides,
  };
}

function systemInput(overrides = {}) {
  return {
    kind: "candidate_card_carryovers_synchronized",
    scope: scope(),
    actor: {
      userId: null,
      membershipId: null,
      authority: "system",
    },
    action: "carryover_synchronized",
    revisionId: IDS.secondRevision,
    cardVersion: 3,
    changedAtMs: CHANGED_AT_MS,
    ...overrides,
  };
}

function helpInput(overrides = {}) {
  return {
    kind: "candidate_card_help_requested",
    scope: scope(),
    actor: {
      userId: IDS.managerUser,
      membershipId: IDS.managerMembership,
      authority: "manager",
    },
    managerAssignmentId: IDS.managerAssignment,
    helpRequestId: IDS.help,
    requestedAtMs: HELP_OPENS_AT_MS + 1,
    expiresAtMs: CANDIDATE_DEADLINE_AT_MS,
    ...overrides,
  };
}

function seedActiveHelp(database) {
  insert(database, "candidate_card_help_requests", {
    id: IDS.help,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: IDS.card,
    team_id: IDS.team,
    status: "active",
    message: "Please help.",
    requested_by_user_id: IDS.managerUser,
    requested_by_membership_id: IDS.managerMembership,
    requested_at_ms: HELP_OPENS_AT_MS + 1,
    expires_at_ms: CANDIDATE_DEADLINE_AT_MS,
    created_at_ms: HELP_OPENS_AT_MS + 1,
    updated_at_ms: HELP_OPENS_AT_MS + 1,
    version: 1,
  });
}

function audienceProjection(database, eventId) {
  return database
    .prepare(`
      SELECT audience_kind, team_id, user_id
      FROM outbox_event_audiences
      WHERE league_id = @leagueId
        AND outbox_event_id = @eventId
      ORDER BY
        CASE audience_kind
          WHEN 'team' THEN 1
          WHEN 'user' THEN 2
          ELSE 3
        END,
        COALESCE(team_id, user_id)
    `)
    .all({ leagueId: IDS.league, eventId });
}

describe("FAD-09 Candidate Card mutation side-effect writer", () => {
  test("accepts the canonical whole-card save action", (t) => {
    const runtime = createRuntime(t);
    const result = runtime.write(
      managerInput({ action: "candidate_card_saved" })
    );

    assert.equal(result.event.event_type, "candidate_card.changed");
    assert.equal(result.event.aggregate_id, IDS.card);
    assert.deepEqual(
      audienceProjection(runtime.database, IDS.revision),
      [
        {
          audience_kind: "team",
          team_id: IDS.team,
          user_id: null,
        },
      ]
    );
  });

  test("writes one metadata-only team-scoped Candidate invalidation without activity or notification", (t) => {
    const runtime = createRuntime(t);
    const result = runtime.write(managerInput());
    const expectedPayload = createSocketEventEnvelope({
      eventId: IDS.revision,
      type: "candidate_card.changed",
      leagueId: IDS.league,
      resourceId: IDS.card,
      version: 2,
      reasonCode: "card_changed",
      occurredAt: CHANGED_AT_MS,
      related: createEmptySocketRelated({
        fadId: IDS.fad,
        teamId: IDS.team,
        cardId: IDS.card,
      }),
    });

    assert.deepEqual(result.event, {
      id: IDS.revision,
      league_id: IDS.league,
      event_type: "candidate_card.changed",
      aggregate_type: "candidate_card",
      aggregate_id: IDS.card,
      payload_json: JSON.stringify(expectedPayload),
      status: "pending",
      attempt_count: 0,
      available_at_ms: CHANGED_AT_MS,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: CHANGED_AT_MS,
      updated_at_ms: CHANGED_AT_MS,
      version: 1,
    });
    assert.deepEqual(audienceProjection(runtime.database, IDS.revision), [
      {
        audience_kind: "team",
        team_id: IDS.team,
        user_id: null,
      },
    ]);
    assert.deepEqual(
      JSON.parse(result.event.payload_json),
      expectedPayload
    );
    assert.deepEqual(
      Object.keys(JSON.parse(result.event.payload_json)).sort(),
      [
        "eventId",
        "leagueId",
        "occurredAt",
        "reasonCode",
        "related",
        "resourceId",
        "type",
        "version",
      ]
    );
    assert.doesNotMatch(
      result.event.payload_json,
      /player|offer|contract|action|actor|help|membership/i
    );
    assert.equal(count(runtime.database, "league_activity"), 0);
    assert.equal(count(runtime.database, "notifications"), 0);
    assert.equal(
      count(
        runtime.database,
        "outbox_event_audiences",
        "WHERE audience_kind = 'league'"
      ),
      0
    );
  });

  for (const systemCase of SYSTEM_ACTION_CASES) {
    test(`writes private metadata-only invalidation for ${systemCase.action}`, (t) => {
      const runtime = createRuntime(t);
      seedActiveHelp(runtime.database);

      const result = runtime.write(systemInput(systemCase));
      const expectedPayload = createSocketEventEnvelope({
        eventId: systemCase.revisionId,
        type: "candidate_card.changed",
        leagueId: IDS.league,
        resourceId: IDS.card,
        version: systemCase.cardVersion,
        reasonCode: "card_changed",
        occurredAt: CHANGED_AT_MS,
        related: createEmptySocketRelated({
          fadId: IDS.fad,
          teamId: IDS.team,
          cardId: IDS.card,
        }),
      });

      assert.equal(result.event.id, systemCase.revisionId);
      assert.equal(result.event.event_type, "candidate_card.changed");
      assert.equal(result.event.aggregate_type, "candidate_card");
      assert.equal(result.event.aggregate_id, IDS.card);
      assert.deepEqual(
        JSON.parse(result.event.payload_json),
        expectedPayload
      );
      assert.doesNotMatch(
        result.event.payload_json,
        /player|offer|contract|action|actor|help|membership/i
      );
      assert.deepEqual(
        audienceProjection(runtime.database, systemCase.revisionId),
        [
          {
            audience_kind: "team",
            team_id: IDS.team,
            user_id: null,
          },
          {
            audience_kind: "user",
            team_id: null,
            user_id: IDS.commissionerUser,
          },
          {
            audience_kind: "user",
            team_id: null,
            user_id: IDS.administratorUser,
          },
        ]
      );
      assert.equal(count(runtime.database, "league_activity"), 0);
      assert.equal(count(runtime.database, "notifications"), 0);
    });
  }

  test("resolves active-help commissioner and member-administrator audiences authoritatively and supports system synchronization", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);

    runtime.write(managerInput());
    runtime.write(systemInput());
    const expected = [
      {
        audience_kind: "team",
        team_id: IDS.team,
        user_id: null,
      },
      {
        audience_kind: "user",
        team_id: null,
        user_id: IDS.commissionerUser,
      },
      {
        audience_kind: "user",
        team_id: null,
        user_id: IDS.administratorUser,
      },
    ];
    assert.deepEqual(
      audienceProjection(runtime.database, IDS.revision),
      expected
    );
    assert.deepEqual(
      audienceProjection(runtime.database, IDS.secondRevision),
      expected
    );
    assert.equal(
      count(
        runtime.database,
        "outbox_event_audiences",
        "WHERE user_id = @userId",
        { userId: IDS.commissionerUser }
      ),
      2
    );
    assert.equal(
      count(
        runtime.database,
        "outbox_event_audiences",
        "WHERE user_id = @userId",
        { userId: IDS.outsiderAdministratorUser }
      ),
      0
    );
    assert.equal(
      count(
        runtime.database,
        "outbox_event_audiences",
        "WHERE user_id = @userId",
        { userId: IDS.memberUser }
      ),
      0
    );
    assert.equal(count(runtime.database, "league_activity"), 0);
    assert.equal(count(runtime.database, "notifications"), 0);
  });

  test("excludes a category-drifted commissioner and future member-administrator while selecting the current replacement without cross-league leakage", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);
    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET permission_category = 'member',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `)
      .run({
        membershipId: IDS.commissionerMembership,
        updatedAtMs: CHANGED_AT_MS - 2,
      });
    runtime.database
      .prepare(`
        UPDATE platform_roles
        SET status = 'ended',
            ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @roleId
      `)
      .run({
        endedAtMs: CHANGED_AT_MS - 2,
        roleId: IDS.commissionerRole,
      });
    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET joined_at_ms = @joinedAtMs,
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `)
      .run({
        joinedAtMs: CHANGED_AT_MS + 1,
        membershipId: IDS.administratorMembership,
        updatedAtMs: CHANGED_AT_MS - 1,
      });

    runtime.write(managerInput());

    assert.deepEqual(audienceProjection(runtime.database, IDS.revision), [
      {
        audience_kind: "team",
        team_id: IDS.team,
        user_id: null,
      },
    ]);

    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET permission_category = 'commissioner',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `)
      .run({
        membershipId: IDS.memberMembership,
        updatedAtMs: CHANGED_AT_MS,
      });
    runtime.database
      .prepare(`
        UPDATE leagues
        SET commissioner_membership_id = @membershipId,
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @leagueId
      `)
      .run({
        leagueId: IDS.league,
        membershipId: IDS.memberMembership,
        updatedAtMs: CHANGED_AT_MS,
      });
    runtime.write(systemInput());

    assert.deepEqual(
      audienceProjection(runtime.database, IDS.secondRevision),
      [
        {
          audience_kind: "team",
          team_id: IDS.team,
          user_id: null,
        },
        {
          audience_kind: "user",
          team_id: null,
          user_id: IDS.memberUser,
        },
      ]
    );
    for (const eventId of [IDS.revision, IDS.secondRevision]) {
      for (const excludedUserId of [
        IDS.commissionerUser,
        IDS.administratorUser,
        IDS.outsiderAdministratorUser,
      ]) {
        assert.equal(
          count(
            runtime.database,
            "outbox_event_audiences",
            "WHERE outbox_event_id = @eventId AND user_id = @userId",
            { eventId, userId: excludedUserId }
          ),
          0
        );
      }
    }
  });

  test("treats the help expiry boundary as team-only", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);

    runtime.write(
      managerInput({
        revisionId: IDS.thirdRevision,
        changedAtMs: CANDIDATE_DEADLINE_AT_MS,
      })
    );

    assert.deepEqual(
      audienceProjection(runtime.database, IDS.thirdRevision),
      [
        {
          audience_kind: "team",
          team_id: IDS.team,
          user_id: null,
        },
      ]
    );
  });

  test("rejects malformed user and system callback shapes before writing", (t) => {
    let writes = 0;
    const runtime = createRuntime(t, {
      leagueOutboxWriter: {
        write() {
          writes += 1;
        },
      },
    });
    const invalidInputs = [
      { ...managerInput(), unexpected: true },
      managerInput({ kind: "candidate_card_updated" }),
      managerInput({ action: "carryover_synchronized" }),
      managerInput({ cardVersion: 0 }),
      managerInput({ changedAtMs: -1 }),
      managerInput({ revisionId: "not-a-uuid" }),
      managerInput({
        scope: { ...scope(), unexpected: true },
      }),
      managerInput({
        actor: {
          userId: null,
          membershipId: null,
          authority: "system",
        },
      }),
      managerInput({
        authority: managerAuthority({
          accessReason: "help_grant_commissioner",
        }),
      }),
      { ...systemInput(), authority: managerAuthority() },
      systemInput({
        actor: {
          userId: IDS.managerUser,
          membershipId: null,
          authority: "system",
        },
      }),
      systemInput({ action: "candidate_added" }),
    ];
    for (const input of invalidInputs) {
      assert.throws(
        () => runtime.write(input),
        (error) => error?.code === "REPOSITORY_ARGUMENT_INVALID"
      );
    }
    assert.equal(writes, 0);
    assert.equal(count(runtime.database, "outbox_events"), 0);
  });

  test("rejects every mismatched canonical system kind and action before writing", (t) => {
    let writes = 0;
    const runtime = createRuntime(t, {
      leagueOutboxWriter: {
        write() {
          writes += 1;
        },
      },
    });

    for (const systemCase of SYSTEM_ACTION_CASES) {
      for (const mismatchedCase of SYSTEM_ACTION_CASES) {
        if (mismatchedCase.action === systemCase.action) continue;
        assert.throws(
          () =>
            runtime.write(
              systemInput({
                kind: systemCase.kind,
                action: mismatchedCase.action,
              })
            ),
          (error) =>
            error?.code === "REPOSITORY_ARGUMENT_INVALID"
        );
      }
    }

    assert.equal(writes, 0);
    assert.equal(count(runtime.database, "outbox_events"), 0);
  });

  test("fails closed on a cross-league team audience", (t) => {
    const runtime = createRuntime(t);

    assert.throws(
      () =>
        runtime.write(
          managerInput({
            scope: scope({ teamId: IDS.otherTeam }),
          })
        ),
      (error) => error?.code === "REPOSITORY_CONSTRAINT"
    );
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(
      count(runtime.database, "outbox_event_audiences"),
      0
    );
  });

  test("propagates writer failure so the surrounding transaction rolls back every effect", (t) => {
    const runtime = createRuntime(t, {
      leagueOutboxWriter: { write() {} },
    });
    runtime.database.exec(`
      CREATE TABLE candidate_side_effect_probe (
        id INTEGER PRIMARY KEY
      ) STRICT
    `);
    const sharedWriter = createSqliteLeagueOutboxWriter({
      database: runtime.database,
    });
    const failingWrite =
      createSqliteCandidateCardMutationSideEffectWriter({
        database: runtime.database,
        leagueOutboxWriter: {
          write(event) {
            sharedWriter.write(event);
            throw new Error("injected late side-effect failure");
          },
        },
      });
    const transaction = runtime.database.transaction(() => {
      runtime.database
        .prepare(
          "INSERT INTO candidate_side_effect_probe (id) VALUES (1)"
        )
        .run();
      failingWrite(managerInput());
    });

    assert.throws(
      () => transaction.immediate(),
      (error) => error?.code === "REPOSITORY_OPERATION_FAILED"
    );
    assert.equal(
      count(runtime.database, "candidate_side_effect_probe"),
      0
    );
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(
      count(runtime.database, "outbox_event_audiences"),
      0
    );
  });
});

describe("FAD-09 Candidate Card help side-effect writer", () => {
  test("atomically writes private audit, exact authority notifications, and metadata-only scoped invalidation", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);
    const write = createSqliteCandidateCardHelpSideEffectWriter({
      database: runtime.database,
    });

    const result = write(helpInput());

    assert.equal(result.notifications.length, 2);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT event_type, outcome, actor_user_id, target_user_id,
                 league_id, reason_code, occurred_at_ms
          FROM security_audit_events
        `)
        .all(),
      [
        {
          event_type: "fad.candidate_card_help_requested",
          outcome: "success",
          actor_user_id: IDS.managerUser,
          target_user_id: null,
          league_id: IDS.league,
          reason_code: "candidate_card_help_requested",
          occurred_at_ms: HELP_OPENS_AT_MS + 1,
        },
      ]
    );

    const notificationRows = runtime.database
      .prepare(`
        SELECT id, user_id, event_type, message_data_json,
               related_feature, related_record_id,
               delivery_status, deduplication_key,
               created_at_ms, version
        FROM notifications
        ORDER BY user_id
      `)
      .all();
    assert.deepEqual(
      notificationRows.map(({ user_id: userId }) => userId),
      [IDS.commissionerUser, IDS.administratorUser]
    );
    for (const row of notificationRows) {
      assert.equal(row.event_type, "fad_help_requested");
      assert.equal(row.related_feature, "candidate_card_help");
      assert.equal(row.related_record_id, IDS.help);
      assert.equal(row.delivery_status, "pending");
      assert.equal(
        row.deduplication_key,
        `fad:${IDS.fad}:help-requested:${IDS.help}:${row.user_id}`
      );
      assert.deepEqual(JSON.parse(row.message_data_json), {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.team,
        cardId: IDS.card,
        helpRequestId: IDS.help,
        requestingUserId: IDS.managerUser,
        requestingDisplayName: "Manager",
        destination: {
          kind: "private_card",
          leagueId: IDS.league,
          fadId: IDS.fad,
          teamId: IDS.team,
          cardId: IDS.card,
        },
      });
      assert.doesNotMatch(row.message_data_json, /Please help\./);
      const notificationPublication =
        runtime.database.prepare(`
          SELECT *
          FROM outbox_events
          WHERE league_id = @leagueId
            AND event_type = 'notification.created'
            AND aggregate_type = 'notification'
            AND aggregate_id = @notificationId
        `).get({
          leagueId: IDS.league,
          notificationId: row.id,
        });
      assert.ok(notificationPublication);
      assert.deepEqual(
        JSON.parse(
          notificationPublication.payload_json
        ),
        createSocketEventEnvelope({
          eventId: notificationPublication.id,
          type: "notification.created",
          leagueId: IDS.league,
          resourceId: row.id,
          version: row.version,
          reasonCode: "notification_created",
          occurredAt: row.created_at_ms,
          related: createEmptySocketRelated({
            fadId: IDS.fad,
            teamId: IDS.team,
            cardId: IDS.card,
          }),
        })
      );
      assert.deepEqual(
        audienceProjection(
          runtime.database,
          notificationPublication.id
        ),
        [
          {
            audience_kind: "user",
            team_id: null,
            user_id: row.user_id,
          },
        ]
      );
      assert.doesNotMatch(
        notificationPublication.payload_json,
        /Please help\.|requesting|message/iu
      );
    }
    assert.equal(
      notificationRows.some(
        ({ user_id: userId }) =>
          userId === IDS.memberUser ||
          userId === IDS.outsiderAdministratorUser
      ),
      false
    );

    const outboxRow = runtime.database
      .prepare(`
        SELECT id, event_type, aggregate_type, aggregate_id,
               payload_json, status, available_at_ms, created_at_ms
        FROM outbox_events
        WHERE id = @id
      `)
      .get({ id: IDS.help });
    assert.deepEqual(outboxRow, {
      id: IDS.help,
      event_type: "candidate_card_help.changed",
      aggregate_type: "candidate_card_help",
      aggregate_id: IDS.help,
      payload_json: JSON.stringify(
        createSocketEventEnvelope({
          eventId: IDS.help,
          type: "candidate_card_help.changed",
          leagueId: IDS.league,
          resourceId: IDS.help,
          version: 1,
          reasonCode: "help_changed",
          occurredAt: HELP_OPENS_AT_MS + 1,
          related: createEmptySocketRelated({
            fadId: IDS.fad,
            teamId: IDS.team,
            cardId: IDS.card,
          }),
        })
      ),
      status: "pending",
      available_at_ms: HELP_OPENS_AT_MS + 1,
      created_at_ms: HELP_OPENS_AT_MS + 1,
    });
    assert.deepEqual(audienceProjection(runtime.database, IDS.help), [
      {
        audience_kind: "team",
        team_id: IDS.team,
        user_id: null,
      },
      {
        audience_kind: "user",
        team_id: null,
        user_id: IDS.commissionerUser,
      },
      {
        audience_kind: "user",
        team_id: null,
        user_id: IDS.administratorUser,
      },
    ]);
    assert.doesNotMatch(outboxRow.payload_json, /Please help\./);
    assert.equal(
      count(runtime.database, "outbox_events"),
      3
    );
    assert.equal(count(runtime.database, "league_activity"), 0);
    assert.equal(
      count(
        runtime.database,
        "outbox_event_audiences",
        "WHERE audience_kind = 'league'"
      ),
      0
    );
  });

  test("rejects accepted-status manager evidence without an acceptance timestamp before every side effect", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);
    runtime.database
      .prepare(`
        UPDATE team_manager_assignments
        SET accepted_at_ms = NULL
        WHERE id = @assignmentId
      `)
      .run({ assignmentId: IDS.managerAssignment });
    const write = createSqliteCandidateCardHelpSideEffectWriter({
      database: runtime.database,
    });

    assert.throws(
      () => write(helpInput()),
      (error) => error?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
    );
    assert.equal(count(runtime.database, "security_audit_events"), 0);
    assert.equal(count(runtime.database, "notifications"), 0);
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(count(runtime.database, "outbox_event_audiences"), 0);
  });

  test("does not notify a pointed commissioner membership without commissioner permission", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);
    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET permission_category = 'member'
        WHERE id = @membershipId
      `)
      .run({ membershipId: IDS.commissionerMembership });
    runtime.database
      .prepare(`
        UPDATE platform_roles
        SET status = 'ended',
            ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @roleId
      `)
      .run({
        endedAtMs: HELP_OPENS_AT_MS + 1,
        roleId: IDS.commissionerRole,
      });
    const write = createSqliteCandidateCardHelpSideEffectWriter({
      database: runtime.database,
    });

    const result = write(helpInput());

    assert.equal(result.notifications.length, 1);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT user_id
          FROM notifications
          ORDER BY user_id
        `)
        .all(),
      [{ user_id: IDS.administratorUser }]
    );
    assert.equal(
      count(
        runtime.database,
        "outbox_event_audiences",
        "WHERE audience_kind = 'user' AND user_id = @userId",
        { userId: IDS.commissionerUser }
      ),
      0
    );
    assert.deepEqual(audienceProjection(runtime.database, IDS.help), [
      {
        audience_kind: "team",
        team_id: IDS.team,
        user_id: null,
      },
      {
        audience_kind: "user",
        team_id: null,
        user_id: IDS.administratorUser,
      },
    ]);
  });

  test("rejects malformed or non-authoritative help evidence before any side effect", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);
    const write = createSqliteCandidateCardHelpSideEffectWriter({
      database: runtime.database,
    });
    const invalidInputs = [
      { ...helpInput(), unexpected: true },
      helpInput({ kind: "candidate_card_help_changed" }),
      helpInput({ managerAssignmentId: "not-a-uuid" }),
      helpInput({ requestedAtMs: -1 }),
      helpInput({ expiresAtMs: HELP_OPENS_AT_MS + 1 }),
      helpInput({ scope: { ...scope(), unexpected: true } }),
      helpInput({
        actor: {
          userId: IDS.managerUser,
          membershipId: IDS.managerMembership,
          authority: "commissioner",
        },
      }),
    ];
    for (const input of invalidInputs) {
      assert.throws(
        () => write(input),
        (error) => error?.code === "REPOSITORY_ARGUMENT_INVALID"
      );
    }
    for (const input of [
      helpInput({ managerAssignmentId: IDS.revision }),
      helpInput({ helpRequestId: IDS.secondRevision }),
      helpInput({ requestedAtMs: HELP_OPENS_AT_MS + 2 }),
      helpInput({ scope: scope({ teamId: IDS.otherTeam }) }),
    ]) {
      assert.throws(
        () => write(input),
        (error) => error?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
      );
    }
    assert.equal(count(runtime.database, "security_audit_events"), 0);
    assert.equal(count(runtime.database, "notifications"), 0);
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(count(runtime.database, "outbox_event_audiences"), 0);
    assert.equal(count(runtime.database, "league_activity"), 0);
  });

  test("rolls back the inserted help request and every side effect with its outer transaction", (t) => {
    const runtime = createRuntime(t);
    const write = createSqliteCandidateCardHelpSideEffectWriter({
      database: runtime.database,
    });
    const transaction = runtime.database.transaction(() => {
      seedActiveHelp(runtime.database);
      write(helpInput());
      throw new Error("injected Candidate Card help failure");
    });

    assert.throws(
      () => transaction.immediate(),
      /injected Candidate Card help failure/
    );
    assert.equal(
      count(runtime.database, "candidate_card_help_requests"),
      0
    );
    assert.equal(count(runtime.database, "security_audit_events"), 0);
    assert.equal(count(runtime.database, "notifications"), 0);
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(count(runtime.database, "outbox_event_audiences"), 0);
    assert.equal(count(runtime.database, "league_activity"), 0);
  });

  test("rolls back audit, notifications, outbox, and audiences after a late outbox failure", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);
    const sharedOutboxWriter = createSqliteLeagueOutboxWriter({
      database: runtime.database,
    });
    const write = createSqliteCandidateCardHelpSideEffectWriter({
      database: runtime.database,
      leagueOutboxWriter: {
        write(command) {
          sharedOutboxWriter.write(command);
          throw new Error("injected late help outbox failure");
        },
      },
    });

    assert.throws(
      () => write(helpInput()),
      (error) => error?.code === "REPOSITORY_OPERATION_FAILED"
    );
    assert.equal(count(runtime.database, "security_audit_events"), 0);
    assert.equal(count(runtime.database, "notifications"), 0);
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(count(runtime.database, "outbox_event_audiences"), 0);
    assert.equal(count(runtime.database, "league_activity"), 0);
  });
});

describe("FAD-14 private outbox user reauthorization", () => {
  test("requires current protected authority and an unexpired help grant", (t) => {
    const runtime = createRuntime(t);
    seedActiveHelp(runtime.database);
    const repository = createSqliteLeagueOutboxRepository({
      database: runtime.database,
    });
    const related = createEmptySocketRelated({
      fadId: IDS.fad,
      teamId: IDS.team,
      cardId: IDS.card,
    });
    const authorize = (userId, overrides = {}) =>
      repository.isUserAudienceAuthorized({
        leagueId: IDS.league,
        userId,
        eventType: "candidate_card.changed",
        resourceId: IDS.card,
        reasonCode: "card_changed",
        related,
        nowMs: CHANGED_AT_MS,
        ...overrides,
      });

    assert.equal(authorize(IDS.commissionerUser), true);
    assert.equal(authorize(IDS.administratorUser), true);
    assert.equal(authorize(IDS.memberUser), false);
    assert.equal(
      authorize(IDS.commissionerUser, {
        nowMs: CANDIDATE_DEADLINE_AT_MS,
      }),
      false
    );

    runtime.database
      .prepare(`
        UPDATE platform_roles
        SET status = 'ended', ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @roleId
      `)
      .run({
        endedAtMs: CHANGED_AT_MS,
        roleId: IDS.administratorRole,
      });
    assert.equal(authorize(IDS.administratorUser), false);
    assert.equal(
      repository.isUserAudienceAuthorized({
        leagueId: IDS.league,
        userId: IDS.administratorUser,
      }),
      true
    );
    assert.equal(
      repository.isUserAudienceAuthorized({
        leagueId: IDS.league,
        userId: IDS.administratorUser,
        eventType: "candidate_card_help.changed",
        resourceId: IDS.help,
        reasonCode: "help_changed",
        related,
        nowMs: CHANGED_AT_MS,
      }),
      false
    );
    assert.equal(
      repository.isUserAudienceAuthorized({
        leagueId: IDS.league,
        userId: IDS.commissionerUser,
        eventType: "fad_nomination_queue.changed",
        resourceId: IDS.revision,
        reasonCode: "nomination_queued",
        related: createEmptySocketRelated({
          fadId: IDS.fad,
          teamId: IDS.team,
          nominationQueueId: IDS.revision,
        }),
        nowMs: CHANGED_AT_MS,
      }),
      true
    );

    const protectedEventCommands = [
      {
        eventType: "candidate_card.changed",
        resourceId: IDS.card,
        reasonCode: "card_changed",
        related,
      },
      {
        eventType: "candidate_card_help.changed",
        resourceId: IDS.help,
        reasonCode: "help_changed",
        related,
      },
      {
        eventType: "fad_nomination_queue.changed",
        resourceId: IDS.revision,
        reasonCode: "nomination_queued",
        related: createEmptySocketRelated({
          fadId: IDS.fad,
          teamId: IDS.team,
          nominationQueueId: IDS.revision,
        }),
      },
    ];
    const authorizeEveryProtectedEvent = (userId) =>
      protectedEventCommands.map((event) =>
        repository.isUserAudienceAuthorized({
          leagueId: IDS.league,
          userId,
          nowMs: CHANGED_AT_MS,
          ...event,
        })
      );

    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET permission_category = 'member',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `)
      .run({
        membershipId: IDS.commissionerMembership,
        updatedAtMs: CHANGED_AT_MS,
      });
    runtime.database
      .prepare(`
        UPDATE platform_roles
        SET status = 'ended',
            ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @roleId
      `)
      .run({
        endedAtMs: CHANGED_AT_MS,
        roleId: IDS.commissionerRole,
      });
    assert.deepEqual(
      authorizeEveryProtectedEvent(IDS.commissionerUser),
      [false, false, false]
    );
    assert.deepEqual(
      authorizeEveryProtectedEvent(IDS.outsiderAdministratorUser),
      [false, false, false]
    );

    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET permission_category = 'commissioner',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `)
      .run({
        membershipId: IDS.memberMembership,
        updatedAtMs: CHANGED_AT_MS,
      });
    runtime.database
      .prepare(`
        UPDATE leagues
        SET commissioner_membership_id = @membershipId,
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @leagueId
      `)
      .run({
        leagueId: IDS.league,
        membershipId: IDS.memberMembership,
        updatedAtMs: CHANGED_AT_MS,
      });
    assert.deepEqual(
      authorizeEveryProtectedEvent(IDS.memberUser),
      [true, true, true]
    );
    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET joined_at_ms = @joinedAtMs,
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
      `)
      .run({
        joinedAtMs: CHANGED_AT_MS + 1,
        membershipId: IDS.memberMembership,
        updatedAtMs: CHANGED_AT_MS,
      });
    assert.deepEqual(
      authorizeEveryProtectedEvent(IDS.memberUser),
      [false, false, false]
    );
  });
});
