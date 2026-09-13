const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createFreeAgentDraftReadinessRetryRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  buildMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  planExplicitMatchupSchedule,
} = require("../../src/domain/matchups/matchupSchedulePolicy");
const {
  hashMatchupScheduleCommandRequest,
} = require(
  "../../src/domain/matchups/matchupScheduleCommandPolicy"
);
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
const MIGRATION_IDENTITIES = Object.freeze({
  30: Object.freeze({
    fileName: "0030_apply_locked_fad_decision_package.sql",
    byteLength: 636_077,
    sha256:
      "6f46b7a8c52108adfc0b51dc1eb9cdcab0ed274482ca396a31f7d45e42c07184",
  }),
  31: Object.freeze({
    fileName:
      "0031_add_fad_readiness_attempts_and_retry_receipts.sql",
    byteLength: 46_693,
    sha256:
      "f2c5104f2eb06e261cc902067bd4623b841f2c37a04f73d27487863077b2662a",
  }),
  32: Object.freeze({
    fileName: "0032_add_fad_readiness_lease_reclaim.sql",
    byteLength: 27_882,
    sha256:
      "ec6bf25a00c2a279d5380a11cb99a3f9b8bc22b06e95ff0f2ef58519e786c7f5",
  }),
  33: Object.freeze({
    fileName: "0033_add_fad_readiness_corrective_requeues.sql",
    byteLength: 56_084,
    sha256:
      "93714178a4c89687578ca340afbe69c317239118cb50765838e6123ff6faf7f1",
  }),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  user: uuid(3),
  membership: uuid(4),
  job: uuid(5),
  readiness: uuid(6),
  attempt: uuid(7),
  scheduleIdempotency: uuid(8),
  scheduleOperation: uuid(9),
  week: uuid(10),
  scheduleResult: uuid(11),
  correctiveRequeue: uuid(12),
  retryIdempotency: uuid(13),
  retryReceipt: uuid(14),
  otherLeague: uuid(15),
  otherSeason: uuid(16),
  otherUser: uuid(17),
  otherMembership: uuid(18),
  otherJob: uuid(19),
  otherReadiness: uuid(20),
  otherAttempt: uuid(21),
  otherScheduleResult: uuid(22),
  otherScheduleOperation: uuid(23),
  homeTeam: uuid(24),
  awayTeam: uuid(25),
  matchup: uuid(26),
  teams: Object.freeze([uuid(24), uuid(25), uuid(27), uuid(28)]),
  matchups: Object.freeze([uuid(26), uuid(29)]),
  managerUsers: Object.freeze(
    Array.from({ length: 4 }, (_, index) => uuid(40 + index))
  ),
  managerMemberships: Object.freeze(
    Array.from({ length: 4 }, (_, index) => uuid(44 + index))
  ),
  managerAssignments: Object.freeze(
    Array.from({ length: 4 }, (_, index) => uuid(48 + index))
  ),
  scheduleJobs: Object.freeze(
    Array.from({ length: 6 }, (_, index) => uuid(30 + index))
  ),
});

const CREATED_AT_MS = 100;
const STARTED_AT_MS = 200;
const OBSERVED_AT_MS = 250;
const BLOCKED_AT_MS = 300;
const PREVIOUS_NEXT_RETRY_AT_MS = 450;
const REQUEUED_AT_MS = 500;
const SCHEDULE_COMMAND_STARTED_AT_MS = REQUEUED_AT_MS;
const CLAIMED_AT_MS = 600;
const CLAIM_LEASE_EXPIRES_AT_MS = 1_600;
const DEADLINE_AT_MS = 1_800_000_000_000;
const NHL_REGULAR_SEASON_STARTS_AT_MS = Date.parse(
  "2026-09-01T07:00:00.000Z"
);
const FIRST_WEEK_STARTS_AT_MS = Date.parse(
  "2027-02-01T08:00:00.000Z"
);
const FANTASY_PLAYOFFS_START_AT_MS = Date.parse(
  "2027-02-08T08:00:00.000Z"
);
const NHL_REGULAR_SEASON_ENDS_AT_MS = Date.parse(
  "2027-03-08T08:00:00.000Z"
);
const SCHEDULE_PLAN = planExplicitMatchupSchedule({
  teamIds: IDS.teams,
  nhlSeasonKey: "20262027",
  nhlRegularSeasonStartsAtMs: NHL_REGULAR_SEASON_STARTS_AT_MS,
  nhlRegularSeasonEndsAtMs: NHL_REGULAR_SEASON_ENDS_AT_MS,
  fantasyPlayoffsStartAtMs: FANTASY_PLAYOFFS_START_AT_MS,
  fantasyPlayoffsEndAtMs: NHL_REGULAR_SEASON_ENDS_AT_MS,
  firstWeekStartsAtMs: FIRST_WEEK_STARTS_AT_MS,
  timeZone: "America/Vancouver",
  nowMs: REQUEUED_AT_MS,
});
const FIRST_WEEK_BASELINE_AT_MS =
  SCHEDULE_PLAN.weeks[0].baselineAtMs;
const FIRST_WEEK_LOCKS_AT_MS = SCHEDULE_PLAN.weeks[0].locksAtMs;
const FIRST_WEEK_ENDS_AT_MS = SCHEDULE_PLAN.weeks[0].endsAtMs;
const SCHEDULE_REQUEST_SHA256 =
  hashMatchupScheduleCommandRequest({
    leagueId: IDS.league,
    seasonId: IDS.season,
    expectedSeasonVersion: 1,
    input: {
      confirmed: true,
      nhlRegularSeasonStartsAtMs:
        NHL_REGULAR_SEASON_STARTS_AT_MS,
      nhlRegularSeasonEndsAtMs:
        NHL_REGULAR_SEASON_ENDS_AT_MS,
      fantasyPlayoffsStartAtMs:
        FANTASY_PLAYOFFS_START_AT_MS,
      fantasyPlayoffsEndAtMs:
        NHL_REGULAR_SEASON_ENDS_AT_MS,
      firstWeekStartsAtMs: FIRST_WEEK_STARTS_AT_MS,
    },
  });
const OCCURRENCE_KEY =
  `fad-readiness:${IDS.league}:${IDS.season}:${IDS.season}`;
const BLOCKER = Object.freeze({
  code: "MATCHUP_SCHEDULE_MISSING",
  field: "firstMatchupStartsAtMs",
  resourceType: "season",
  resourceId: IDS.season,
  message: "The first matchup schedule must be confirmed.",
});
const BLOCKERS_JSON = serializeCanonicalJsonV1([BLOCKER]);
const PUBLIC_BLOCKER = Object.freeze({
  code: BLOCKER.code,
  message: BLOCKER.message,
  resourceId: BLOCKER.resourceId,
});

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function assertConstraint(callback, pattern, message) {
  assert.throws(callback, (error) => {
    return (
      error?.code?.startsWith("SQLITE_CONSTRAINT") &&
      (!pattern || pattern.test(error.message))
    );
  }, message);
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    temporaryRoot,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  return {
    ...connection,
    migrationsDirectory,
  };
}

function copyMigrations(runtime, minimumId, maximumId) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (migration.id < minimumId || migration.id > maximumId) {
      continue;
    }
    fs.copyFileSync(
      migration.filePath,
      path.join(runtime.migrationsDirectory, migration.fileName)
    );
  }
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

function migrateFresh(t, prefix, maximumId = 33) {
  const runtime = createRuntime(t, prefix);
  copyMigrations(runtime, 1, maximumId);
  migrate(runtime, prefix);
  return runtime;
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function assertHealthy(database) {
  assert.deepEqual(
    database.prepare("PRAGMA foreign_key_check").all(),
    []
  );
  assert.deepEqual(
    database.prepare("PRAGMA integrity_check").all(),
    [{ integrity_check: "ok" }]
  );
}

function schemaSql(database, type, name) {
  return database
    .prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = ? AND name = ?
    `)
    .get(type, name)?.sql;
}

function schemaNames(database, type) {
  return database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = ?
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all(type)
    .map(({ name }) => name);
}

function tableColumns(database, tableName) {
  return database
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all()
    .map((row) => row.name);
}

function foreignKeys(database, tableName) {
  return database
    .prepare(`PRAGMA foreign_key_list("${tableName}")`)
    .all()
    .map((row) => ({
      id: row.id,
      sequence: row.seq,
      from: row.from,
      table: row.table,
      to: row.to,
    }));
}

function groupedForeignKeys(database, tableName) {
  const groups = new Map();
  for (const row of database
    .prepare(`PRAGMA foreign_key_list("${tableName}")`)
    .all()) {
    if (!groups.has(row.id)) {
      groups.set(row.id, {
        table: row.table,
        columns: [],
      });
    }
    groups.get(row.id).columns.push({
      from: row.from,
      sequence: row.seq,
      to: row.to,
    });
  }
  return [...groups.values()]
    .map((group) => ({
      table: group.table,
      columns: group.columns
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ from, to }) => ({ from, to })),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
}

function withoutTableTriggers(database, tableNames, callback) {
  const placeholders = tableNames.map(() => "?").join(", ");
  const triggers = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name IN (${placeholders})
      ORDER BY name
    `)
    .all(...tableNames);

  for (const trigger of triggers) {
    database.exec(
      `DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`
    );
  }
  try {
    callback();
  } finally {
    for (const trigger of triggers) database.exec(trigger.sql);
  }
}

function initialRollovers() {
  return Array.from({ length: 7 }, (_, index) => {
    const opensAtMs = DEADLINE_AT_MS + index * 86_400_000;
    const rollsOverAtMs = opensAtMs + 86_400_000;
    return {
      creationCutoffAtMs: rollsOverAtMs - 3_600_000,
      opensAtMs,
      rollsOverAtMs,
      sequence: index + 1,
    };
  });
}

function teamName(index) {
  return `Launch Team ${index + 1}`;
}

function teamProjection(index) {
  const teamId = IDS.teams[index];
  return {
    carryoverCount: 0,
    managerAssignmentId: IDS.managerAssignments[index],
    managerReady: true,
    openBenchSlots: 4,
    openDefenceSlots: 6,
    openForwardSlots: 12,
    structuralConflictCount: 0,
    team: {
      logoReference: null,
      name: teamName(index),
      patternTemplate: "even-two",
      primaryColour: "#112233",
      secondaryColour: "#ddeeff",
      teamId,
      tertiaryColour: null,
    },
    teamId,
  };
}

function blockedAttemptProjection() {
  return {
    observedSeasonVersion: 1,
    firstMatchupWeekBefore: null,
    firstMatchupWeekAfter: null,
    candidateDeadlineAtMs: null,
    reminderAtMs: null,
    helpOpensAtMs: null,
    initialRollovers: [],
    priorSeasonRollover: null,
    participatingTeamCount: IDS.teams.length,
    teamProjections: IDS.teams.map((_, index) =>
      teamProjection(index)
    ),
    blockers: [PUBLIC_BLOCKER],
    warnings: [],
  };
}

function seedIdentity(database) {
  insert(database, "leagues", {
    id: IDS.league,
    name: "Corrective Requeue League",
    name_normalized: "corrective requeue league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
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
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "users", {
    id: IDS.user,
    email_normalized: "corrective-requeue@example.test",
    email_display: "corrective-requeue@example.test",
    display_name: "Corrective Commissioner",
    display_name_normalized: "corrective commissioner",
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  insert(database, "league_memberships", {
    id: IDS.membership,
    league_id: IDS.league,
    user_id: IDS.user,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  database
    .prepare(`
      UPDATE leagues
      SET commissioner_membership_id = ?,
          current_season_id = ?
      WHERE id = ?
    `)
    .run(IDS.membership, IDS.season, IDS.league);
  for (let index = 0; index < IDS.teams.length; index += 1) {
    const managerUserId = IDS.managerUsers[index];
    const managerMembershipId = IDS.managerMemberships[index];
    const teamId = IDS.teams[index];
    const name = teamName(index);
    insert(database, "users", {
      id: managerUserId,
      email_normalized: `manager-${index + 1}@example.test`,
      email_display: `manager-${index + 1}@example.test`,
      display_name: `Manager ${index + 1}`,
      display_name_normalized: `manager ${index + 1}`,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "league_memberships", {
      id: managerMembershipId,
      league_id: IDS.league,
      user_id: managerUserId,
      permission_category: "manager",
      status: "active",
      joined_at_ms: 1,
      ended_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "teams", {
      id: teamId,
      league_id: IDS.league,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      primary_colour: "#112233",
      secondary_colour: "#ddeeff",
      logo_reference: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "team_manager_assignments", {
      id: IDS.managerAssignments[index],
      league_id: IDS.league,
      team_id: teamId,
      user_id: managerUserId,
      membership_id: managerMembershipId,
      assigned_by_user_id: IDS.user,
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: 1,
      accepted_at_ms: 1,
      ended_at_ms: null,
      version: 1,
    });
  }
}

function readinessRow(overrides = {}) {
  return {
    id: IDS.readiness,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_occurrence_key: OCCURRENCE_KEY,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: IDS.job,
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
    created_at_ms: CREATED_AT_MS,
    updated_at_ms: CREATED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function seedBlockedReadiness(database) {
  seedIdentity(database);
  insert(database, "job_runs", {
    id: IDS.job,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: "fad_readiness",
    occurrence_key: OCCURRENCE_KEY,
    scheduled_for_ms: CREATED_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: CREATED_AT_MS,
    updated_at_ms: CREATED_AT_MS,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: null,
  });
  insert(
    database,
    "free_agent_draft_readiness_operations",
    readinessRow()
  );

  database
    .prepare(`
      UPDATE job_runs
      SET status = 'running',
          attempt_count = 1,
          lease_owner = 'readiness-worker',
          lease_token = 'readiness-lease',
          lease_expires_at_ms = 1000,
          started_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ?
    `)
    .run(STARTED_AT_MS, STARTED_AT_MS, IDS.league, IDS.job);
  database
    .prepare(`
      UPDATE free_agent_draft_readiness_operations
      SET status = 'running',
          attempt_count = 1,
          lease_owner = 'readiness-worker',
          lease_token = 'readiness-lease',
          lease_expires_at_ms = 1000,
          started_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ?
    `)
    .run(STARTED_AT_MS, STARTED_AT_MS, IDS.league, IDS.readiness);

  const projection = blockedAttemptProjection();
  insert(database, "free_agent_draft_readiness_attempts", {
    id: IDS.attempt,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    job_run_id: IDS.job,
    attempt_number: 1,
    observed_readiness_version: 2,
    outcome: "blocked",
    observed_at_ms: OBSERVED_AT_MS,
    recorded_at_ms: BLOCKED_AT_MS,
    projection_json: serializeCanonicalJsonV1(projection),
    projection_sha256: hashCanonicalJsonV1(projection),
    version: 1,
  });
  database
    .prepare(`
      UPDATE free_agent_draft_readiness_operations
      SET status = 'blocked',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          blockers_json = ?,
          next_retry_at_ms = ?,
          terminal_at_ms = ?,
          updated_at_ms = ?,
          version = 3
      WHERE league_id = ? AND id = ?
    `)
    .run(
      BLOCKERS_JSON,
      PREVIOUS_NEXT_RETRY_AT_MS,
      BLOCKED_AT_MS,
      BLOCKED_AT_MS,
      IDS.league,
      IDS.readiness
    );
  database
    .prepare(`
      UPDATE job_runs
      SET status = 'failed',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = ?,
          last_error_code = 'FAD_READINESS_BLOCKED',
          next_attempt_at_ms = ?,
          updated_at_ms = ?,
          version = 3
      WHERE league_id = ? AND id = ?
    `)
    .run(
      BLOCKED_AT_MS,
      PREVIOUS_NEXT_RETRY_AT_MS,
      BLOCKED_AT_MS,
      IDS.league,
      IDS.job
    );
}

function seedStartedScheduleCommand(database) {
  insert(database, "idempotency_requests", {
    id: IDS.scheduleIdempotency,
    league_id: IDS.league,
    actor_user_id: IDS.user,
    operation: "matchup.schedule.generate.v1",
    client_key: "corrective-t095-key",
    request_hash: SCHEDULE_REQUEST_SHA256,
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: SCHEDULE_COMMAND_STARTED_AT_MS,
    completed_at_ms: null,
    expires_at_ms: REQUEUED_AT_MS + 86_400_000,
  });
  database
    .prepare(`
      UPDATE seasons
      SET regular_season_starts_at_ms = ?,
          regular_season_ends_at_ms = ?,
          fantasy_playoffs_start_at_ms = ?,
          fantasy_playoffs_end_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ? AND version = 1
    `)
    .run(
      NHL_REGULAR_SEASON_STARTS_AT_MS,
      NHL_REGULAR_SEASON_ENDS_AT_MS,
      FANTASY_PLAYOFFS_START_AT_MS,
      NHL_REGULAR_SEASON_ENDS_AT_MS,
      REQUEUED_AT_MS,
      IDS.league,
      IDS.season
    );
  insert(database, "matchup_weeks", {
    id: IDS.week,
    league_id: IDS.league,
    season_id: IDS.season,
    week_key: SCHEDULE_PLAN.weeks[0].weekKey,
    sequence: 1,
    starts_at_ms: FIRST_WEEK_STARTS_AT_MS,
    baseline_at_ms: FIRST_WEEK_BASELINE_AT_MS,
    locks_at_ms: FIRST_WEEK_LOCKS_AT_MS,
    ends_at_ms: FIRST_WEEK_ENDS_AT_MS,
    rolls_over_at_ms: FIRST_WEEK_ENDS_AT_MS,
    status: "scheduled",
    created_at_ms: REQUEUED_AT_MS,
    updated_at_ms: REQUEUED_AT_MS,
    version: 1,
  });
  for (const [index, pair] of
    SCHEDULE_PLAN.weeks[0].pairs.entries()) {
    insert(database, "matchups", {
      id: IDS.matchups[index],
      league_id: IDS.league,
      season_id: IDS.season,
      matchup_week_id: IDS.week,
      home_team_id: pair.homeTeamId,
      away_team_id: pair.awayTeamId,
      home_team_name: teamName(
        IDS.teams.indexOf(pair.homeTeamId)
      ),
      away_team_name: teamName(
        IDS.teams.indexOf(pair.awayTeamId)
      ),
      status: "scheduled",
      created_at_ms: REQUEUED_AT_MS,
      updated_at_ms: REQUEUED_AT_MS,
      version: 1,
    });
  }
  insert(database, "matchup_operations", {
    id: IDS.scheduleOperation,
    league_id: IDS.league,
    season_id: IDS.season,
    matchup_week_id: null,
    matchup_id: null,
    actor_user_id: IDS.user,
    operation_type: "schedule_generate",
    status: "succeeded",
    reason: null,
    metadata_json: JSON.stringify({
      participantCount: IDS.teams.length,
      participantTeamIds: [...IDS.teams].sort(),
      weekCount: 1,
      matchupCount: SCHEDULE_PLAN.weeks[0].pairs.length,
      jobOccurrenceCount: 6,
    }),
    started_at_ms: REQUEUED_AT_MS,
    completed_at_ms: REQUEUED_AT_MS,
  });
  insert(database, "season_matchup_schedule_generations", {
    league_id: IDS.league,
    season_id: IDS.season,
    schedule_version: 1,
    schedule_operation_id: IDS.scheduleOperation,
    week_one_matchup_week_id: IDS.week,
    week_one_starts_at_ms: FIRST_WEEK_STARTS_AT_MS,
    status: "current",
    created_at_ms: REQUEUED_AT_MS,
    superseded_at_ms: null,
    version: 1,
  });
  const scheduleOccurrences = [
    {
      jobType: "matchup:statistics_refresh",
      scheduledForMs: FIRST_WEEK_STARTS_AT_MS,
    },
    {
      jobType: "matchup:baseline",
      scheduledForMs: FIRST_WEEK_BASELINE_AT_MS,
    },
    {
      jobType: "matchup:lock",
      scheduledForMs: FIRST_WEEK_LOCKS_AT_MS,
    },
    {
      jobType: "matchup:statistics_refresh",
      scheduledForMs: FIRST_WEEK_ENDS_AT_MS,
    },
    {
      jobType: "matchup:finalize",
      scheduledForMs: FIRST_WEEK_ENDS_AT_MS,
    },
    {
      jobType: "matchup:rollover",
      scheduledForMs: FIRST_WEEK_ENDS_AT_MS,
    },
  ];
  for (const [index, occurrence] of scheduleOccurrences.entries()) {
    const runId = IDS.scheduleJobs[index];
    const occurrenceKey = buildMatchupOccurrenceKey({
      ...occurrence,
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      scheduleOperationId: IDS.scheduleOperation,
      scheduleVersion: 1,
    });
    insert(database, "job_runs", {
      id: runId,
      league_id: IDS.league,
      season_id: IDS.season,
      job_type: occurrence.jobType,
      occurrence_key: occurrenceKey,
      scheduled_for_ms: occurrence.scheduledForMs,
      status: "pending",
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at_ms: null,
      started_at_ms: null,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      created_at_ms: REQUEUED_AT_MS,
      updated_at_ms: REQUEUED_AT_MS,
      version: 1,
      lease_token: null,
      next_attempt_at_ms: occurrence.scheduledForMs,
    });
    insert(database, "matchup_schedule_job_bindings", {
      id: runId,
      league_id: IDS.league,
      season_id: IDS.season,
      job_run_id: runId,
      job_type: occurrence.jobType,
      schedule_operation_id: IDS.scheduleOperation,
      schedule_version: 1,
      owning_matchup_week_id: IDS.week,
      owning_matchup_id: null,
      created_at_ms: REQUEUED_AT_MS,
      version: 1,
    });
  }
}

function scheduleCommandResultRow(overrides = {}) {
  return {
    id: IDS.scheduleResult,
    league_id: IDS.league,
    season_id: IDS.season,
    action: "generate",
    idempotency_request_id: IDS.scheduleIdempotency,
    idempotency_operation: "matchup.schedule.generate.v1",
    request_sha256: SCHEDULE_REQUEST_SHA256,
    matchup_operation_id: IDS.scheduleOperation,
    actor_user_id: IDS.user,
    actor_membership_id: IDS.membership,
    actor_authority: "commissioner",
    old_schedule_operation_id: null,
    old_schedule_version: null,
    new_schedule_operation_id: IDS.scheduleOperation,
    new_schedule_version: 1,
    season_version_before: 1,
    season_version_after: 2,
    week_one_matchup_week_id: IDS.week,
    week_version_before: null,
    week_version_after: 1,
    previous_first_week_starts_at_ms: null,
    first_week_starts_at_ms: FIRST_WEEK_STARTS_AT_MS,
    last_week_ends_at_ms: FIRST_WEEK_ENDS_AT_MS,
    nhl_regular_season_starts_at_ms:
      NHL_REGULAR_SEASON_STARTS_AT_MS,
    nhl_regular_season_ends_at_ms:
      NHL_REGULAR_SEASON_ENDS_AT_MS,
    fantasy_playoffs_start_at_ms:
      FANTASY_PLAYOFFS_START_AT_MS,
    fantasy_playoffs_end_at_ms:
      NHL_REGULAR_SEASON_ENDS_AT_MS,
    calendar_persisted: 1,
    participant_count: IDS.teams.length,
    week_count: 1,
    matchup_count: SCHEDULE_PLAN.weeks[0].pairs.length,
    bye_count: 0,
    shifted_week_count: null,
    replaced_job_occurrence_count: null,
    response_http_status: 201,
    response_code: "MATCHUP_SCHEDULE_GENERATED",
    result_schema_version: 1,
    created_at_ms: REQUEUED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function correctiveRequeueRow(overrides = {}) {
  return {
    id: IDS.correctiveRequeue,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    readiness_attempt_id: IDS.attempt,
    job_run_id: IDS.job,
    occurrence_key: OCCURRENCE_KEY,
    correction_kind: "matchup_schedule_created",
    matchup_schedule_command_result_id: IDS.scheduleResult,
    schedule_operation_id: IDS.scheduleOperation,
    schedule_version: 1,
    attempt_count: 1,
    readiness_version_before: 3,
    readiness_version_after: 4,
    job_version_before: 3,
    job_version_after: 4,
    blockers_json: BLOCKERS_JSON,
    blocked_at_ms: BLOCKED_AT_MS,
    previous_next_retry_at_ms: PREVIOUS_NEXT_RETRY_AT_MS,
    requeued_at_ms: REQUEUED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function insertCorrectiveEvidence(database, overrides = {}) {
  insert(
    database,
    "free_agent_draft_readiness_corrective_requeues",
    correctiveRequeueRow(overrides)
  );
}

function resetCorrectiveJob(database, overrides = {}) {
  const values = {
    nextAttemptAtMs: REQUEUED_AT_MS,
    updatedAtMs: REQUEUED_AT_MS,
    version: 4,
    ...overrides,
  };
  database
    .prepare(`
      UPDATE job_runs
      SET status = 'pending',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          started_at_ms = NULL,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          next_attempt_at_ms = @nextAttemptAtMs,
          updated_at_ms = @updatedAtMs,
          version = @version
      WHERE league_id = @leagueId AND id = @jobId
    `)
    .run({ ...values, leagueId: IDS.league, jobId: IDS.job });
}

function advanceCorrectiveReadiness(database, overrides = {}) {
  const values = {
    nextRetryAtMs: REQUEUED_AT_MS,
    updatedAtMs: REQUEUED_AT_MS,
    version: 4,
    ...overrides,
  };
  database
    .prepare(`
      UPDATE free_agent_draft_readiness_operations
      SET next_retry_at_ms = @nextRetryAtMs,
          updated_at_ms = @updatedAtMs,
          version = @version
      WHERE league_id = @leagueId AND id = @readinessId
    `)
    .run({
      ...values,
      leagueId: IDS.league,
      readinessId: IDS.readiness,
    });
}

function completeScheduleIdempotency(database) {
  database
    .prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type = 'matchup_schedule_command',
          result_id = ?,
          completed_at_ms = ?
      WHERE league_id = ? AND id = ?
    `)
    .run(
      IDS.scheduleResult,
      REQUEUED_AT_MS,
      IDS.league,
      IDS.scheduleIdempotency
    );
}

function seedCorrectivePrerequisites(database) {
  seedBlockedReadiness(database);
}

function commitCorrectiveRequeue(database, afterStep = () => {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    seedStartedScheduleCommand(database);
    afterStep("after_schedule_writes");
    insert(database, "matchup_schedule_command_results", {
      ...scheduleCommandResultRow(),
    });
    afterStep("after_command_result");
    insertCorrectiveEvidence(database);
    afterStep("after_corrective_evidence");
    resetCorrectiveJob(database);
    afterStep("after_job_reset");
    advanceCorrectiveReadiness(database);
    afterStep("after_readiness_advance");
    completeScheduleIdempotency(database);
    afterStep("after_idempotency_completion");
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function readCorrectiveState(database) {
  return {
    evidence: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_corrective_requeues
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.correctiveRequeue),
    job: database
      .prepare(`SELECT * FROM job_runs WHERE league_id = ? AND id = ?`)
      .get(IDS.league, IDS.job),
    readiness: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.readiness),
    idempotency: database
      .prepare(`
        SELECT * FROM idempotency_requests
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.scheduleIdempotency),
    season: database
      .prepare(`
        SELECT regular_season_starts_at_ms,
               regular_season_ends_at_ms,
               fantasy_playoffs_start_at_ms,
               fantasy_playoffs_end_at_ms,
               updated_at_ms,
               version
        FROM seasons
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.season),
    scheduleCounts: database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM matchup_weeks
            WHERE league_id = @leagueId
              AND season_id = @seasonId) AS weeks,
          (SELECT COUNT(*) FROM matchups
            WHERE league_id = @leagueId
              AND season_id = @seasonId) AS matchups,
          (SELECT COUNT(*) FROM matchup_operations
            WHERE league_id = @leagueId
              AND season_id = @seasonId
              AND operation_type = 'schedule_generate')
            AS operations,
          (SELECT COUNT(*)
            FROM season_matchup_schedule_generations
            WHERE league_id = @leagueId
              AND season_id = @seasonId) AS generations,
          (SELECT COUNT(*)
            FROM matchup_schedule_command_results
            WHERE league_id = @leagueId
              AND season_id = @seasonId) AS commandResults,
          (SELECT COUNT(*) FROM job_runs
            WHERE league_id = @leagueId
              AND season_id = @seasonId
              AND job_type LIKE 'matchup:%') AS jobs,
          (SELECT COUNT(*) FROM matchup_schedule_job_bindings
            WHERE league_id = @leagueId
              AND season_id = @seasonId) AS bindings
      `)
      .get({ leagueId: IDS.league, seasonId: IDS.season }),
  };
}

describe("Free Agent Draft readiness corrective-requeue migration", () => {
  test("preserves migrations 0030-0032 and migrates a fresh database to schema 33 without synthesized evidence", (t) => {
    const migrations = discoverMigrations({
      migrationsDirectory: CANONICAL_MIGRATIONS,
    });

    for (const [idText, identity] of Object.entries(
      MIGRATION_IDENTITIES
    )) {
      const migration = migrations.find(
        ({ id }) => id === Number(idText)
      );
      assert.equal(migration.fileName, identity.fileName);
      assert.equal(
        fs.statSync(migration.filePath).size,
        identity.byteLength
      );
      assert.equal(sha256(migration.filePath), identity.sha256);
      assert.equal(migration.checksum, identity.sha256);
    }

    const migration33 = migrations.find(({ id }) => id === 33);
    assert.equal(
      migration33.fileName,
      "0033_add_fad_readiness_corrective_requeues.sql"
    );
    const runtime = migrateFresh(t, "hundo-fad-0033-fresh-");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      33
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT metadata_value AS metadataValue,
                 updated_at_ms AS updatedAtMs
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get(),
      { metadataValue: "33", updatedAtMs: 33 }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_readiness_corrective_requeues
        `)
        .get().count,
      0
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT migration_id AS migrationId,
                 file_name AS fileName,
                 checksum
          FROM schema_migrations
          WHERE migration_id BETWEEN 30 AND 33
          ORDER BY migration_id
        `)
        .all(),
      [30, 31, 32, 33].map((migrationId) => ({
        migrationId,
        fileName: migrations.find(({ id }) => id === migrationId)
          .fileName,
        checksum: migrations.find(({ id }) => id === migrationId)
          .checksum,
      }))
    );
    assertHealthy(runtime.database);
  });

  test("upgrades exact schema 32 with only the corrective evidence schema and intended readiness guards", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0033-upgrade-");
    copyMigrations(runtime, 1, 32);
    migrate(runtime, "fad-0033-before");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      32
    );
    const tablesBefore = schemaNames(runtime.database, "table");
    const indexesBefore = schemaNames(runtime.database, "index");
    const triggersBefore = new Map(
      runtime.database
        .prepare(`
          SELECT name, sql
          FROM sqlite_schema
          WHERE type = 'trigger'
          ORDER BY name
        `)
        .all()
        .map(({ name, sql }) => [name, sql])
    );

    copyMigrations(runtime, 33, 33);
    migrate(runtime, "fad-0033-after");

    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      33
    );
    assert.deepEqual(
      schemaNames(runtime.database, "table").filter(
        (name) => !tablesBefore.includes(name)
      ),
      ["free_agent_draft_readiness_corrective_requeues"]
    );
    assert.deepEqual(
      tablesBefore.filter(
        (name) => !schemaNames(runtime.database, "table").includes(name)
      ),
      []
    );
    assert.deepEqual(
      schemaNames(runtime.database, "index").filter(
        (name) => !indexesBefore.includes(name)
      ),
      [
        "free_agent_draft_readiness_corrective_requeues_operation_latest",
      ]
    );

    const triggersAfter = new Map(
      runtime.database
        .prepare(`
          SELECT name, sql
          FROM sqlite_schema
          WHERE type = 'trigger'
          ORDER BY name
        `)
        .all()
        .map(({ name, sql }) => [name, sql])
    );
    const addedTriggerNames = [...triggersAfter.keys()].filter(
      (name) => !triggersBefore.has(name)
    );
    assert.deepEqual(addedTriggerNames, [
      "free_agent_draft_readiness_corrective_requeues_immutable_delete",
      "free_agent_draft_readiness_corrective_requeues_immutable_update",
      "free_agent_draft_readiness_corrective_requeues_valid_insert",
      "free_agent_draft_readiness_job_requeue_guard",
      "idempotency_requests_matchup_schedule_corrective_requeue_complete",
    ]);
    const changedTriggerNames = [...triggersBefore].filter(
      ([name, sql]) => triggersAfter.get(name) !== sql
    ).map(([name]) => name);
    assert.deepEqual(changedTriggerNames, [
      "free_agent_draft_readiness_operations_forward_update",
    ]);
    assert.match(
      triggersAfter.get(
        "free_agent_draft_readiness_operations_forward_update"
      ),
      /free_agent_draft_readiness_corrective_requeues/
    );
    assert.match(
      triggersAfter.get(
        "free_agent_draft_readiness_operations_forward_update"
      ),
      /OLD\.status\s*=\s*'running'[\s\S]*NEW\.status\s*=\s*'running'/
    );
    assert.match(
      triggersAfter.get(
        "free_agent_draft_readiness_operations_forward_update"
      ),
      /free_agent_draft_readiness_retry_receipts/
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT metadata_value AS metadataValue,
                 updated_at_ms AS updatedAtMs
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get(),
      { metadataValue: "33", updatedAtMs: 33 }
    );
    assertHealthy(runtime.database);
  });

  test("installs the exact strict columns, same-league keys, uniqueness, index, and immutable guards", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-schema-"
    );
    const tableName =
      "free_agent_draft_readiness_corrective_requeues";
    assert.deepEqual(tableColumns(database, tableName), [
      "id",
      "league_id",
      "season_id",
      "readiness_operation_id",
      "readiness_attempt_id",
      "job_run_id",
      "occurrence_key",
      "correction_kind",
      "matchup_schedule_command_result_id",
      "schedule_operation_id",
      "schedule_version",
      "attempt_count",
      "readiness_version_before",
      "readiness_version_after",
      "job_version_before",
      "job_version_after",
      "blockers_json",
      "blocked_at_ms",
      "previous_next_retry_at_ms",
      "requeued_at_ms",
      "version",
    ]);
    const ddl = schemaSql(database, "table", tableName);
    assert.match(ddl, /\)\s*STRICT$/);
    assert.match(
      ddl,
      /correction_kind\s+TEXT\s+NOT NULL[\s\S]*correction_kind\s*=\s*'matchup_schedule_created'/
    );
    assert.match(ddl, /schedule_version\s*=\s*1/);
    assert.match(
      ddl,
      /readiness_version_after\s*=\s*readiness_version_before\s*\+\s*1/
    );
    assert.match(
      ddl,
      /job_version_after\s*=\s*job_version_before\s*\+\s*1/
    );
    assert.match(
      ddl,
      /UNIQUE\s*\(\s*league_id\s*,\s*matchup_schedule_command_result_id\s*\)/
    );
    assert.match(
      ddl,
      /UNIQUE\s*\(\s*league_id\s*,\s*readiness_operation_id\s*,\s*readiness_version_after\s*\)/
    );
    assert.match(
      ddl,
      /UNIQUE\s*\(\s*league_id\s*,\s*job_run_id\s*,\s*job_version_after\s*\)/
    );
    assert.match(
      ddl,
      /UNIQUE\s*\(\s*league_id\s*,\s*readiness_attempt_id\s*,\s*correction_kind\s*\)/
    );

    const keys = foreignKeys(database, tableName);
    for (const expected of [
      { from: "league_id", table: "leagues", to: "id" },
      { from: "season_id", table: "seasons", to: "id" },
      {
        from: "readiness_operation_id",
        table: "free_agent_draft_readiness_operations",
        to: "id",
      },
      {
        from: "readiness_attempt_id",
        table: "free_agent_draft_readiness_attempts",
        to: "id",
      },
      { from: "job_run_id", table: "job_runs", to: "id" },
      {
        from: "matchup_schedule_command_result_id",
        table: "matchup_schedule_command_results",
        to: "id",
      },
      {
        from: "schedule_operation_id",
        table: "season_matchup_schedule_generations",
        to: "schedule_operation_id",
      },
      {
        from: "schedule_version",
        table: "season_matchup_schedule_generations",
        to: "schedule_version",
      },
    ]) {
      assert.equal(
        keys.some((candidate) =>
          Object.entries(expected).every(
            ([key, value]) => candidate[key] === value
          )
        ),
        true,
        `missing foreign key ${JSON.stringify(expected)}`
      );
    }
    const expectedForeignKeyGroups = [
      {
        table: "leagues",
        columns: [{ from: "league_id", to: "id" }],
      },
      {
        table: "seasons",
        columns: [
          { from: "league_id", to: "league_id" },
          { from: "season_id", to: "id" },
        ],
      },
      {
        table: "free_agent_draft_readiness_operations",
        columns: [
          { from: "league_id", to: "league_id" },
          { from: "readiness_operation_id", to: "id" },
        ],
      },
      {
        table: "free_agent_draft_readiness_attempts",
        columns: [
          { from: "league_id", to: "league_id" },
          { from: "readiness_attempt_id", to: "id" },
        ],
      },
      {
        table: "job_runs",
        columns: [
          { from: "league_id", to: "league_id" },
          { from: "job_run_id", to: "id" },
        ],
      },
      {
        table: "matchup_schedule_command_results",
        columns: [
          { from: "league_id", to: "league_id" },
          {
            from: "matchup_schedule_command_result_id",
            to: "id",
          },
        ],
      },
      {
        table: "season_matchup_schedule_generations",
        columns: [
          { from: "league_id", to: "league_id" },
          { from: "season_id", to: "season_id" },
          {
            from: "schedule_operation_id",
            to: "schedule_operation_id",
          },
          { from: "schedule_version", to: "schedule_version" },
        ],
      },
    ].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
    assert.deepEqual(
      groupedForeignKeys(database, tableName),
      expectedForeignKeyGroups
    );
    assert.match(
      schemaSql(
        database,
        "index",
        "free_agent_draft_readiness_corrective_requeues_operation_latest"
      ),
      /league_id[\s\S]*readiness_operation_id[\s\S]*readiness_version_after\s+DESC/
    );
    for (const triggerName of [
      "free_agent_draft_readiness_corrective_requeues_valid_insert",
      "free_agent_draft_readiness_corrective_requeues_immutable_update",
      "free_agent_draft_readiness_corrective_requeues_immutable_delete",
      "free_agent_draft_readiness_job_requeue_guard",
      "idempotency_requests_matchup_schedule_corrective_requeue_complete",
    ]) {
      assert.equal(
        typeof schemaSql(database, "trigger", triggerName),
        "string",
        triggerName
      );
    }
    assertHealthy(database);
  });

  test("commits the exact T-095 evidence, clean job reset, aligned readiness advance, and idempotency result", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-happy-"
    );
    seedCorrectivePrerequisites(database);
    const observedSteps = [];
    commitCorrectiveRequeue(database, (step) => {
      observedSteps.push(step);
    });
    assert.deepEqual(observedSteps, [
      "after_schedule_writes",
      "after_command_result",
      "after_corrective_evidence",
      "after_job_reset",
      "after_readiness_advance",
      "after_idempotency_completion",
    ]);

    const state = readCorrectiveState(database);
    assert.deepEqual(state.evidence, correctiveRequeueRow());
    assert.equal(SCHEDULE_PLAN.weeks.length, 1);
    assert.deepEqual(state.season, {
      regular_season_starts_at_ms:
        NHL_REGULAR_SEASON_STARTS_AT_MS,
      regular_season_ends_at_ms:
        NHL_REGULAR_SEASON_ENDS_AT_MS,
      fantasy_playoffs_start_at_ms:
        FANTASY_PLAYOFFS_START_AT_MS,
      fantasy_playoffs_end_at_ms:
        NHL_REGULAR_SEASON_ENDS_AT_MS,
      updated_at_ms: REQUEUED_AT_MS,
      version: 2,
    });
    assert.deepEqual(state.scheduleCounts, {
      weeks: 1,
      matchups: 2,
      operations: 1,
      generations: 1,
      commandResults: 1,
      jobs: 6,
      bindings: 6,
    });
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM teams
          JOIN team_manager_assignments AS assignment
            ON assignment.league_id = teams.league_id
           AND assignment.team_id = teams.id
          JOIN league_memberships AS membership
            ON membership.league_id = assignment.league_id
           AND membership.id = assignment.membership_id
           AND membership.user_id = assignment.user_id
          JOIN users ON users.id = assignment.user_id
          WHERE teams.league_id = ?
            AND teams.status = 'active'
            AND assignment.status = 'accepted'
            AND assignment.ended_at_ms IS NULL
            AND membership.status = 'active'
            AND membership.permission_category = 'manager'
            AND users.status = 'active'
        `)
        .get(IDS.league).count,
      4
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM league_settings
          WHERE league_id = ?
        `)
        .get(IDS.league).count,
      1
    );
    assert.deepEqual(
      JSON.parse(
        database
          .prepare(`
            SELECT projection_json
            FROM free_agent_draft_readiness_attempts
            WHERE league_id = ? AND id = ?
          `)
          .get(IDS.league, IDS.attempt).projection_json
      ),
      blockedAttemptProjection()
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT participant_count AS participantCount,
                 matchup_count AS matchupCount,
                 week_count AS weekCount,
                 bye_count AS byeCount
          FROM matchup_schedule_command_results
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.scheduleResult),
      {
        participantCount: 4,
        matchupCount: 2,
        weekCount: 1,
        byeCount: 0,
      }
    );
    assert.deepEqual(
      {
        status: state.job.status,
        attemptCount: state.job.attempt_count,
        leaseOwner: state.job.lease_owner,
        leaseToken: state.job.lease_token,
        leaseExpiresAtMs: state.job.lease_expires_at_ms,
        startedAtMs: state.job.started_at_ms,
        completedAtMs: state.job.completed_at_ms,
        resultJson: state.job.result_json,
        lastErrorCode: state.job.last_error_code,
        nextAttemptAtMs: state.job.next_attempt_at_ms,
        updatedAtMs: state.job.updated_at_ms,
        version: state.job.version,
      },
      {
        status: "pending",
        attemptCount: 1,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        startedAtMs: null,
        completedAtMs: null,
        resultJson: null,
        lastErrorCode: null,
        nextAttemptAtMs: REQUEUED_AT_MS,
        updatedAtMs: REQUEUED_AT_MS,
        version: 4,
      }
    );
    assert.deepEqual(
      {
        status: state.readiness.status,
        attemptCount: state.readiness.attempt_count,
        blockersJson: state.readiness.blockers_json,
        startedAtMs: state.readiness.started_at_ms,
        nextRetryAtMs: state.readiness.next_retry_at_ms,
        terminalAtMs: state.readiness.terminal_at_ms,
        updatedAtMs: state.readiness.updated_at_ms,
        version: state.readiness.version,
      },
      {
        status: "blocked",
        attemptCount: 1,
        blockersJson: BLOCKERS_JSON,
        startedAtMs: STARTED_AT_MS,
        nextRetryAtMs: REQUEUED_AT_MS,
        terminalAtMs: BLOCKED_AT_MS,
        updatedAtMs: REQUEUED_AT_MS,
        version: 4,
      }
    );
    assert.deepEqual(
      {
        status: state.idempotency.status,
        resultType: state.idempotency.result_type,
        resultId: state.idempotency.result_id,
        completedAtMs: state.idempotency.completed_at_ms,
      },
      {
        status: "completed",
        resultType: "matchup_schedule_command",
        resultId: IDS.scheduleResult,
        completedAtMs: REQUEUED_AT_MS,
      }
    );
    assertHealthy(database);
  });

  test("rejects every invalid corrective identity, scope, version, attempt, blocker, and timing axis", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-invalid-row-"
    );
    seedCorrectivePrerequisites(database);
    seedStartedScheduleCommand(database);
    insert(
      database,
      "matchup_schedule_command_results",
      scheduleCommandResultRow()
    );

    const otherBlocker = {
      ...BLOCKER,
      code: "TEAM_MANAGER_MISSING",
    };
    const cases = [
      {
        name: "league scope",
        overrides: { league_id: IDS.otherLeague },
      },
      {
        name: "season scope",
        overrides: { season_id: IDS.otherSeason },
      },
      {
        name: "readiness operation",
        overrides: { readiness_operation_id: IDS.otherReadiness },
      },
      {
        name: "latest blocked attempt",
        overrides: { readiness_attempt_id: IDS.otherAttempt },
      },
      {
        name: "canonical job",
        overrides: { job_run_id: IDS.otherJob },
      },
      {
        name: "occurrence",
        overrides: { occurrence_key: `${OCCURRENCE_KEY}:wrong` },
      },
      {
        name: "correction kind",
        overrides: { correction_kind: "commissioner_retry" },
      },
      {
        name: "schedule result",
        overrides: {
          matchup_schedule_command_result_id: IDS.otherScheduleResult,
        },
      },
      {
        name: "schedule operation",
        overrides: { schedule_operation_id: IDS.otherScheduleOperation },
      },
      {
        name: "schedule version",
        overrides: { schedule_version: 2 },
      },
      {
        name: "attempt count",
        overrides: { attempt_count: 2 },
      },
      {
        name: "readiness version source",
        overrides: {
          readiness_version_before: 2,
          readiness_version_after: 3,
        },
      },
      {
        name: "readiness version advance",
        overrides: { readiness_version_after: 5 },
      },
      {
        name: "job version source",
        overrides: {
          job_version_before: 2,
          job_version_after: 3,
        },
      },
      {
        name: "job version advance",
        overrides: { job_version_after: 5 },
      },
      {
        name: "empty blockers",
        overrides: { blockers_json: "[]" },
      },
      {
        name: "noncanonical blocker order",
        overrides: { blockers_json: JSON.stringify([BLOCKER]) },
      },
      {
        name: "changed blocker",
        overrides: {
          blockers_json: serializeCanonicalJsonV1([otherBlocker]),
        },
      },
      {
        name: "duplicate blocker",
        overrides: {
          blockers_json: serializeCanonicalJsonV1([
            BLOCKER,
            BLOCKER,
          ]),
        },
      },
      {
        name: "blocked time",
        overrides: { blocked_at_ms: BLOCKED_AT_MS - 1 },
      },
      {
        name: "prior retry chronology",
        overrides: {
          previous_next_retry_at_ms: BLOCKED_AT_MS,
        },
      },
      {
        name: "prior retry identity",
        overrides: {
          previous_next_retry_at_ms:
            PREVIOUS_NEXT_RETRY_AT_MS + 1,
        },
      },
      {
        name: "requeue chronology",
        overrides: { requeued_at_ms: BLOCKED_AT_MS },
      },
      {
        name: "schedule/requeue time binding",
        overrides: { requeued_at_ms: REQUEUED_AT_MS + 1 },
      },
      {
        name: "evidence version",
        overrides: { version: 2 },
      },
    ];

    for (const { name, overrides } of cases) {
      assertConstraint(
        () => insertCorrectiveEvidence(database, overrides),
        undefined,
        name
      );
      assert.equal(
        database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_readiness_corrective_requeues
          `)
          .get().count,
        0,
        name
      );
    }
    assertHealthy(database);
  });

  test("requires the canonical missing-schedule blocker even when every blocker mirror agrees", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-required-blocker-"
    );
    seedCorrectivePrerequisites(database);
    seedStartedScheduleCommand(database);
    insert(
      database,
      "matchup_schedule_command_results",
      scheduleCommandResultRow()
    );

    const unrelatedBlocker = {
      code: "TEAM_MANAGER_MISSING",
      field: null,
      message: "A participating team needs an active manager.",
      resourceId: IDS.homeTeam,
      resourceType: "team",
    };
    const unrelatedBlockersJson =
      serializeCanonicalJsonV1([unrelatedBlocker]);
    const unrelatedProjection = {
      ...blockedAttemptProjection(),
      blockers: [
        {
          code: unrelatedBlocker.code,
          message: unrelatedBlocker.message,
          resourceId: unrelatedBlocker.resourceId,
        },
      ],
    };
    withoutTableTriggers(
      database,
      [
        "free_agent_draft_readiness_operations",
        "free_agent_draft_readiness_attempts",
      ],
      () => {
        database
          .prepare(`
            UPDATE free_agent_draft_readiness_operations
            SET blockers_json = ?
            WHERE league_id = ? AND id = ?
          `)
          .run(
            unrelatedBlockersJson,
            IDS.league,
            IDS.readiness
          );
        database
          .prepare(`
            UPDATE free_agent_draft_readiness_attempts
            SET projection_json = ?, projection_sha256 = ?
            WHERE league_id = ? AND id = ?
          `)
          .run(
            serializeCanonicalJsonV1(unrelatedProjection),
            hashCanonicalJsonV1(unrelatedProjection),
            IDS.league,
            IDS.attempt
          );
      }
    );

    assertConstraint(
      () =>
        insertCorrectiveEvidence(database, {
          blockers_json: unrelatedBlockersJson,
        }),
      /canonical missing-schedule blocker/
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_readiness_corrective_requeues
        `)
        .get().count,
      0
    );
    assertHealthy(database);
  });

  test("rejects invalid T-095 action, completed request, generation, readiness state, and job state", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-invalid-source-"
    );
    seedCorrectivePrerequisites(database);
    seedStartedScheduleCommand(database);
    insert(
      database,
      "matchup_schedule_command_results",
      scheduleCommandResultRow()
    );

    function mutateWithoutGuards(tableNames, mutate, restore) {
      withoutTableTriggers(database, tableNames, mutate);
      try {
        assertConstraint(
          () => insertCorrectiveEvidence(database),
          /exact blocked inaugural readiness and new schedule/
        );
        assert.equal(
          database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM free_agent_draft_readiness_corrective_requeues
            `)
            .get().count,
          0
        );
      } finally {
        withoutTableTriggers(database, tableNames, restore);
      }
    }

    database.pragma("ignore_check_constraints = ON");
    mutateWithoutGuards(
      ["matchup_schedule_command_results"],
      () => {
        database
          .prepare(`
            UPDATE matchup_schedule_command_results
            SET action = 'shift_week_one'
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.scheduleResult);
      },
      () => {
        database
          .prepare(`
            UPDATE matchup_schedule_command_results
            SET action = 'generate'
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.scheduleResult);
      }
    );
    database.pragma("ignore_check_constraints = OFF");

    mutateWithoutGuards(
      ["idempotency_requests"],
      () => {
        database
          .prepare(`
            UPDATE idempotency_requests
            SET status = 'completed',
                result_type = 'matchup_schedule_command',
                result_id = ?,
                completed_at_ms = ?
            WHERE league_id = ? AND id = ?
          `)
          .run(
            IDS.scheduleResult,
            REQUEUED_AT_MS,
            IDS.league,
            IDS.scheduleIdempotency
          );
      },
      () => {
        database
          .prepare(`
            UPDATE idempotency_requests
            SET status = 'started',
                result_type = NULL,
                result_id = NULL,
                completed_at_ms = NULL
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.scheduleIdempotency);
      }
    );

    mutateWithoutGuards(
      ["season_matchup_schedule_generations"],
      () => {
        database
          .prepare(`
            UPDATE season_matchup_schedule_generations
            SET status = 'superseded',
                superseded_at_ms = ?,
                version = 2
            WHERE league_id = ? AND schedule_operation_id = ?
          `)
          .run(
            REQUEUED_AT_MS + 1,
            IDS.league,
            IDS.scheduleOperation
          );
      },
      () => {
        database
          .prepare(`
            UPDATE season_matchup_schedule_generations
            SET status = 'current',
                superseded_at_ms = NULL,
                version = 1
            WHERE league_id = ? AND schedule_operation_id = ?
          `)
          .run(IDS.league, IDS.scheduleOperation);
      }
    );

    mutateWithoutGuards(
      ["free_agent_draft_readiness_operations"],
      () => {
        database
          .prepare(`
            UPDATE free_agent_draft_readiness_operations
            SET attempt_count = 2
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.readiness);
      },
      () => {
        database
          .prepare(`
            UPDATE free_agent_draft_readiness_operations
            SET attempt_count = 1
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.readiness);
      }
    );

    mutateWithoutGuards(
      ["job_runs"],
      () => {
        database
          .prepare(`
            UPDATE job_runs
            SET last_error_code = 'OTHER_FAILURE'
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.job);
      },
      () => {
        database
          .prepare(`
            UPDATE job_runs
            SET last_error_code = 'FAD_READINESS_BLOCKED'
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.job);
      }
    );
    assertHealthy(database);
  });

  test("enforces corrective transaction ordering and fails partial writes closed", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-order-"
    );
    seedCorrectivePrerequisites(database);

    assertConstraint(
      () => insertCorrectiveEvidence(database),
      /exact blocked inaugural readiness and new schedule/
    );
    assertConstraint(
      () => resetCorrectiveJob(database),
      /exact retry or corrective evidence/
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      seedStartedScheduleCommand(database);
      insert(
        database,
        "matchup_schedule_command_results",
        scheduleCommandResultRow()
      );
      insertCorrectiveEvidence(database);
      assertConstraint(
        () => advanceCorrectiveReadiness(database),
        /open every team and seven windows or none/
      );
    } finally {
      database.exec("ROLLBACK");
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      seedStartedScheduleCommand(database);
      insert(
        database,
        "matchup_schedule_command_results",
        scheduleCommandResultRow()
      );
      insertCorrectiveEvidence(database);
      resetCorrectiveJob(database);
      assertConstraint(
        () => completeScheduleIdempotency(database),
        /corrective requeue must complete with exact pending readiness/
      );
    } finally {
      database.exec("ROLLBACK");
    }

    const before = readCorrectiveState(database);
    for (const failureStep of [
      "after_schedule_writes",
      "after_command_result",
      "after_corrective_evidence",
      "after_job_reset",
      "after_readiness_advance",
      "after_idempotency_completion",
    ]) {
      assert.throws(
        () =>
          commitCorrectiveRequeue(database, (step) => {
            if (step === failureStep) {
              throw new Error(`injected:${step}`);
            }
          }),
        new RegExp(`injected:${failureStep}`)
      );
      assert.deepEqual(readCorrectiveState(database), before);
      assert.equal(database.inTransaction, false);
    }

    commitCorrectiveRequeue(database);
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_readiness_corrective_requeues
        `)
        .get().count,
      1
    );
    assertHealthy(database);
  });

  test("keeps corrective evidence immutable and makes exact T-095 replay a no-write read", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-immutable-"
    );
    seedCorrectivePrerequisites(database);
    commitCorrectiveRequeue(database);
    const before = readCorrectiveState(database);

    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE free_agent_draft_readiness_corrective_requeues
            SET requeued_at_ms = requeued_at_ms + 1
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.correctiveRequeue),
      /corrective requeues are immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            DELETE FROM free_agent_draft_readiness_corrective_requeues
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.correctiveRequeue),
      /corrective requeues are immutable/
    );
    assertConstraint(
      () =>
        insertCorrectiveEvidence(database, {
          id: uuid(999),
        }),
      undefined
    );

    const replayedCommand = database
      .prepare(`
        SELECT result_id AS resultId
        FROM idempotency_requests
        WHERE league_id = ?
          AND id = ?
          AND status = 'completed'
      `)
      .get(IDS.league, IDS.scheduleIdempotency);
    const replayedEvidence = database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_corrective_requeues
        WHERE league_id = ?
          AND matchup_schedule_command_result_id = ?
      `)
      .get(IDS.league, replayedCommand.resultId);
    assert.deepEqual(replayedEvidence, before.evidence);
    assert.deepEqual(readCorrectiveState(database), before);
    assertHealthy(database);
  });

  test("retains the schema-32 T-128 job-before-receipt retry choreography", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-t128-"
    );
    seedBlockedReadiness(database);
    const retry = createFreeAgentDraftReadinessRetryRequest({
      actorUserId: IDS.user,
      leagueId: IDS.league,
      expectedVersion: 3,
      clientKey: "schema-33-t128-key",
      body: {
        confirmation: "RETRY FREE AGENT DRAFT READINESS",
        readinessOperationId: IDS.readiness,
        seasonId: IDS.season,
      },
    });
    insert(database, "idempotency_requests", {
      id: IDS.retryIdempotency,
      league_id: IDS.league,
      actor_user_id: IDS.user,
      operation: "free_agent_draft.readiness.retry.v1",
      client_key: "schema-33-t128-key",
      request_hash: retry.requestSha256,
      status: "started",
      result_type: null,
      result_id: null,
      created_at_ms: REQUEUED_AT_MS,
      completed_at_ms: null,
      expires_at_ms: REQUEUED_AT_MS + 86_400_000,
    });

    database.exec("BEGIN IMMEDIATE");
    try {
      resetCorrectiveJob(database);
      const response = {
        acceptedAtMs: REQUEUED_AT_MS,
        acceptedFromVersion: 3,
        jobRunId: IDS.job,
        leagueId: IDS.league,
        occurrenceKey: OCCURRENCE_KEY,
        readinessOperationId: IDS.readiness,
        resultingReadinessVersion: 4,
        retryAttemptNumber: 2,
        retryReceiptId: IDS.retryReceipt,
        seasonId: IDS.season,
        status: "accepted",
      };
      insert(database, "free_agent_draft_readiness_retry_receipts", {
        id: IDS.retryReceipt,
        league_id: IDS.league,
        season_id: IDS.season,
        readiness_operation_id: IDS.readiness,
        idempotency_request_id: IDS.retryIdempotency,
        actor_user_id: IDS.user,
        actor_membership_id: IDS.membership,
        actor_authority: "commissioner",
        request_sha256: retry.requestSha256,
        accepted_from_version: 3,
        resulting_readiness_version: 4,
        retry_attempt_number: 2,
        job_run_id: IDS.job,
        occurrence_key: OCCURRENCE_KEY,
        accepted_at_ms: REQUEUED_AT_MS,
        response_http_status: 202,
        response_json: serializeCanonicalJsonV1(response),
        response_sha256: hashCanonicalJsonV1(response),
        version: 1,
      });
      advanceCorrectiveReadiness(database);
      database
        .prepare(`
          UPDATE idempotency_requests
          SET status = 'completed',
              result_type =
                'free_agent_draft_readiness_retry_receipt',
              result_id = ?,
              completed_at_ms = ?
          WHERE league_id = ? AND id = ?
        `)
        .run(
          IDS.retryReceipt,
          REQUEUED_AT_MS,
          IDS.league,
          IDS.retryIdempotency
        );
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }

    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_readiness_corrective_requeues
        `)
        .get().count,
      0
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, attempt_count AS attemptCount,
                 next_attempt_at_ms AS nextAttemptAtMs, version
          FROM job_runs
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.job),
      {
        status: "pending",
        attemptCount: 1,
        nextAttemptAtMs: REQUEUED_AT_MS,
        version: 4,
      }
    );
    assert.equal(
      database
        .prepare(`
          SELECT version
          FROM free_agent_draft_readiness_operations
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.readiness).version,
      4
    );
    assertHealthy(database);
  });

  test("the later worker claim advances attempt count once and retains schema-32 lease reclaim", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0033-claim-"
    );
    seedCorrectivePrerequisites(database);
    commitCorrectiveRequeue(database);

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          UPDATE job_runs
          SET status = 'running',
              attempt_count = 2,
              lease_owner = 'readiness-worker-2',
              lease_token = 'readiness-token-2',
              lease_expires_at_ms = ?,
              started_at_ms = ?,
              next_attempt_at_ms = NULL,
              updated_at_ms = ?,
              version = 5
          WHERE league_id = ? AND id = ?
        `)
        .run(
          CLAIM_LEASE_EXPIRES_AT_MS,
          CLAIMED_AT_MS,
          CLAIMED_AT_MS,
          IDS.league,
          IDS.job
        );
      database
        .prepare(`
          UPDATE free_agent_draft_readiness_operations
          SET status = 'running',
              attempt_count = 2,
              lease_owner = 'readiness-worker-2',
              lease_token = 'readiness-token-2',
              lease_expires_at_ms = ?,
              blockers_json = '[]',
              started_at_ms = ?,
              next_retry_at_ms = NULL,
              terminal_at_ms = NULL,
              updated_at_ms = ?,
              version = 5
          WHERE league_id = ? AND id = ?
        `)
        .run(
          CLAIM_LEASE_EXPIRES_AT_MS,
          CLAIMED_AT_MS,
          CLAIMED_AT_MS,
          IDS.league,
          IDS.readiness
        );
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }

    let job = database
      .prepare(`SELECT * FROM job_runs WHERE league_id = ? AND id = ?`)
      .get(IDS.league, IDS.job);
    let readiness = database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.readiness);
    assert.equal(job.attempt_count, 2);
    assert.equal(readiness.attempt_count, 2);
    assert.equal(job.version, 5);
    assert.equal(readiness.version, 5);
    assert.equal(
      database
        .prepare(`
          SELECT attempt_count AS attemptCount
          FROM free_agent_draft_readiness_corrective_requeues
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.correctiveRequeue).attemptCount,
      1
    );

    const reclaimedAtMs = CLAIM_LEASE_EXPIRES_AT_MS;
    const reclaimedLeaseExpiresAtMs = reclaimedAtMs + 1_000;
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          UPDATE job_runs
          SET lease_owner = 'readiness-worker-3',
              lease_token = 'readiness-token-3',
              lease_expires_at_ms = ?,
              updated_at_ms = ?,
              version = 6
          WHERE league_id = ? AND id = ?
        `)
        .run(
          reclaimedLeaseExpiresAtMs,
          reclaimedAtMs,
          IDS.league,
          IDS.job
        );
      database
        .prepare(`
          UPDATE free_agent_draft_readiness_operations
          SET lease_owner = 'readiness-worker-3',
              lease_token = 'readiness-token-3',
              lease_expires_at_ms = ?,
              updated_at_ms = ?,
              version = 6
          WHERE league_id = ? AND id = ?
        `)
        .run(
          reclaimedLeaseExpiresAtMs,
          reclaimedAtMs,
          IDS.league,
          IDS.readiness
        );
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }
    job = database
      .prepare(`SELECT * FROM job_runs WHERE league_id = ? AND id = ?`)
      .get(IDS.league, IDS.job);
    readiness = database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.readiness);
    assert.equal(job.attempt_count, 2);
    assert.equal(readiness.attempt_count, 2);
    assert.equal(job.started_at_ms, CLAIMED_AT_MS);
    assert.equal(readiness.started_at_ms, CLAIMED_AT_MS);
    assert.equal(job.version, 6);
    assert.equal(readiness.version, 6);
    assertHealthy(database);
  });
});
