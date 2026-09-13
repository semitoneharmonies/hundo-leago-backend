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
  createFreeAgentDraftReadinessTriggerPlan,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
  INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
} = require(
  "../../src/domain/leagues/leagueLifecycleTransitionPolicy"
);
const {
  createLeagueLifecycleTransitionService,
} = require(
  "../../src/application/services/leagues/createLeagueLifecycleTransitionService"
);
const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  applyMigrations,
  discoverMigrations,
} = require(
  "../../src/infrastructure/database/migrate"
);
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteFreeAgentDraftReadinessHandoffWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadinessHandoffWriter"
);
const {
  createSqliteLeagueLifecycleTransitionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueLifecycleTransitionRepository"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const SOURCE_AT_MS = 10_000;
const CREATED_AT_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let templateRoot;
let templatePath;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

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

function count(database, tableName) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get().count;
}

function totalChanges(database) {
  return database
    .prepare("SELECT total_changes() AS value")
    .get().value;
}

function pairCounts(database) {
  return {
    jobs: database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM job_runs
         WHERE job_type = 'fad_readiness'`
      )
      .get().count,
    operations: count(
      database,
      "free_agent_draft_readiness_operations"
    ),
  };
}

function transaction(database, callback) {
  return database.transaction(callback).immediate();
}

before(() => {
  templateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-handoff-template-")
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
    applicationBuildId: "fad-readiness-handoff-foundation",
    now: () => 1_000,
  });
  connection.database.close();
});

after(() => {
  if (templateRoot) {
    fs.rmSync(templateRoot, {
      recursive: true,
      force: true,
    });
  }
});

function createRuntime(t, label) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `hundo-fad-handoff-${label}-`)
  );
  const databasePath = path.join(root, "league.sqlite3");
  fs.copyFileSync(templatePath, databasePath);
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return connection.database;
}

function seedUser(database, id, label, updatedAtMs = SOURCE_AT_MS) {
  insert(database, "users", {
    id,
    email_normalized: `${label}@example.test`,
    email_display: `${label}@example.test`,
    display_name: label,
    display_name_normalized: label.toLowerCase(),
    status: "active",
    created_at_ms: SOURCE_AT_MS,
    updated_at_ms: updatedAtMs,
    version: 1,
  });
}

function baseIds(offset = 0) {
  return Object.freeze({
    league: uuid(offset + 1),
    season: uuid(offset + 2),
    users: Object.freeze(
      Array.from({ length: 4 }, (_, index) =>
        uuid(offset + 10 + index)
      )
    ),
    memberships: Object.freeze(
      Array.from({ length: 4 }, (_, index) =>
        uuid(offset + 20 + index)
      )
    ),
    teams: Object.freeze(
      Array.from({ length: 4 }, (_, index) =>
        uuid(offset + 30 + index)
      )
    ),
    assignments: Object.freeze(
      Array.from({ length: 4 }, (_, index) =>
        uuid(offset + 40 + index)
      )
    ),
  });
}

function seedLeague(database, {
  ids = baseIds(),
  leagueStatus = "active",
  seasonStatus = "active",
  teamStatus = "active",
  updatedAtMs = CREATED_AT_MS,
  name = "Handoff League",
} = {}) {
  ids.users.forEach((userId, index) => {
    seedUser(
      database,
      userId,
      `handoff-manager-${ids.league.slice(-4)}-${index}`
    );
  });
  insert(database, "leagues", {
    id: ids.league,
    name,
    name_normalized: name.toLowerCase(),
    status: leagueStatus,
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: SOURCE_AT_MS,
    updated_at_ms: updatedAtMs,
    version: updatedAtMs === SOURCE_AT_MS ? 1 : 2,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `Season ${ids.season.slice(-4)}`,
    nhl_season_key: `key-${ids.season.slice(-4)}`,
    status: seasonStatus,
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: SOURCE_AT_MS,
    updated_at_ms: updatedAtMs,
    version: updatedAtMs === SOURCE_AT_MS ? 1 : 2,
  });
  ids.users.forEach((userId, index) => {
    insert(database, "league_memberships", {
      id: ids.memberships[index],
      league_id: ids.league,
      user_id: userId,
      permission_category:
        index === 0 ? "commissioner" : "manager",
      status: "active",
      joined_at_ms: SOURCE_AT_MS,
      ended_at_ms: null,
      created_at_ms: SOURCE_AT_MS,
      updated_at_ms: SOURCE_AT_MS,
      version: 1,
    });
  });
  database
    .prepare(
      `UPDATE leagues
       SET commissioner_membership_id = ?,
           current_season_id = ?
       WHERE id = ?`
    )
    .run(ids.memberships[0], ids.season, ids.league);
  ids.teams.forEach((teamId, index) => {
    insert(database, "teams", {
      id: teamId,
      league_id: ids.league,
      name: `Handoff Team ${ids.league.slice(-4)}-${index + 1}`,
      name_normalized:
        `handoff team ${ids.league.slice(-4)}-${index + 1}`,
      status: teamStatus,
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: SOURCE_AT_MS,
      updated_at_ms: updatedAtMs,
      version: updatedAtMs === SOURCE_AT_MS ? 1 : 2,
    });
    insert(database, "team_manager_assignments", {
      id: ids.assignments[index],
      league_id: ids.league,
      team_id: teamId,
      user_id: ids.users[index],
      membership_id: ids.memberships[index],
      assigned_by_user_id: ids.users[0],
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: SOURCE_AT_MS,
      accepted_at_ms: SOURCE_AT_MS,
      ended_at_ms: null,
      version: 1,
    });
  });
  return ids;
}

function activateInauguralLeague(database, ids) {
  database
    .prepare(
      `UPDATE teams
       SET status = 'active',
           updated_at_ms = ?,
           version = version + 1
       WHERE league_id = ?`
    )
    .run(CREATED_AT_MS, ids.league);
  database
    .prepare(
      `UPDATE seasons
       SET status = 'active',
           updated_at_ms = ?,
           version = version + 1
       WHERE league_id = ? AND id = ?`
    )
    .run(CREATED_AT_MS, ids.league, ids.season);
  database
    .prepare(
      `UPDATE leagues
       SET status = 'active',
           updated_at_ms = ?,
           version = version + 1
       WHERE id = ?`
    )
    .run(CREATED_AT_MS, ids.league);
}

function handoffInput({
  ids,
  operationId = uuid(100),
  jobRunId = uuid(101),
  triggerKind = "no_draft_inaugural",
  triggerResourceId = ids.season,
  entryDraftId = null,
  setupExemptionId = null,
  createdAtMs = CREATED_AT_MS,
} = {}) {
  return Object.freeze({
    operationId,
    jobRunId,
    leagueId: ids.league,
    seasonId: ids.season,
    triggerKind,
    triggerResourceId,
    entryDraftId,
    setupExemptionId,
    createdAtMs,
  });
}

function seedEntryDraft(database, ids, {
  draftId = uuid(110),
  status = "active",
  completedAtMs = null,
  updatedAtMs = SOURCE_AT_MS + 1,
} = {}) {
  insert(database, "entry_drafts", {
    id: draftId,
    league_id: ids.league,
    season_id: ids.season,
    status,
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: SOURCE_AT_MS,
    completed_at_ms: completedAtMs,
    created_by_user_id: ids.users[0],
    created_at_ms: SOURCE_AT_MS,
    updated_at_ms: updatedAtMs,
    version: status === "completed" ? 2 : 1,
  });
  return draftId;
}

function completeEntryDraft(database, ids, draftId) {
  database
    .prepare(
      `UPDATE entry_drafts
       SET status = 'completed',
           completed_at_ms = ?,
           updated_at_ms = ?,
           version = version + 1
       WHERE league_id = ? AND id = ?`
    )
    .run(
      CREATED_AT_MS,
      CREATED_AT_MS,
      ids.league,
      draftId
    );
}

function seedFinalDraftPick(
  database,
  ids,
  draftId,
  pickId = uuid(111)
) {
  insert(database, "draft_picks", {
    id: pickId,
    league_id: ids.league,
    draft_id: draftId,
    target_season_id: ids.season,
    round_number: 1,
    position_number: 1,
    original_team_id: ids.teams[0],
    current_owner_team_id: ids.teams[0],
    status: "unused",
    selection_id: null,
    created_at_ms: SOURCE_AT_MS,
    updated_at_ms: SOURCE_AT_MS,
    version: 1,
  });
  return pickId;
}

function forfeitFinalDraftPick(database, ids, pickId) {
  database
    .prepare(
      `UPDATE draft_picks
       SET status = 'forfeited',
           updated_at_ms = ?,
           version = version + 1
       WHERE league_id = ? AND id = ?`
    )
    .run(CREATED_AT_MS, ids.league, pickId);
}

function seedResetMigrationMarker(
  database,
  ids,
  reportId = uuid(112)
) {
  insert(database, "migration_reports", {
    id: reportId,
    league_id: ids.league,
    source_bundle_id: "fad-handoff-reset-origin",
    reset_manifest_id: "2026-season-1-reset-v1",
    database_schema_version: 33,
    status: "succeeded",
    source_hashes_json: JSON.stringify({ source: "3".repeat(64) }),
    counts_json: JSON.stringify({ teams: ids.teams.length }),
    totals_json: JSON.stringify({ records: ids.teams.length }),
    warnings_json: "[]",
    rejects_json: "[]",
    started_at_ms: SOURCE_AT_MS + 1,
    completed_at_ms: SOURCE_AT_MS + 2,
    created_at_ms: SOURCE_AT_MS + 1,
  });
}

function seedResetBootstrapMarker(database, ids) {
  const platformRoleId = uuid(113);
  const requestId = uuid(114);
  const activityId = uuid(115);
  const auditId = uuid(116);
  insert(database, "platform_roles", {
    id: platformRoleId,
    user_id: ids.users[0],
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: ids.users[0],
    granted_at_ms: SOURCE_AT_MS,
    ended_at_ms: null,
    version: 1,
  });
  database
    .prepare(
      `UPDATE seasons
       SET label = '2026', nhl_season_key = '20262027'
       WHERE league_id = ? AND id = ?`
    )
    .run(ids.league, ids.season);
  insert(database, "idempotency_requests", {
    id: requestId,
    league_id: ids.league,
    actor_user_id: ids.users[0],
    operation: "admin.league.bootstrap_reset_original.v1",
    client_key: "reset-origin-bootstrap-marker",
    request_hash: "4".repeat(64),
    status: "completed",
    result_type: "league",
    result_id: ids.league,
    created_at_ms: SOURCE_AT_MS,
    completed_at_ms: SOURCE_AT_MS,
    expires_at_ms: SOURCE_AT_MS + DAY_MS,
  });
  insert(database, "league_activity", {
    id: activityId,
    league_id: ids.league,
    season_id: ids.season,
    event_type: "league_created",
    actor_user_id: ids.users[0],
    actor_authority: "platform_administrator",
    team_id: null,
    player_id: null,
    related_type: "league",
    related_id: ids.league,
    display_summary: "Reset-origin bootstrap marker.",
    reason: null,
    metadata_json:
      '{"leagueStatus":"setup","seasonStatus":"planned"}',
    occurred_at_ms: SOURCE_AT_MS,
  });
  insert(database, "security_audit_events", {
    id: auditId,
    event_type:
      "system_bootstrap.reset_original_league_created",
    outcome: "success",
    actor_user_id: ids.users[0],
    target_user_id: null,
    league_id: ids.league,
    session_id: null,
    request_correlation_id: null,
    reason_code: "closed_write_reset_handoff",
    network_key_version: null,
    network_metadata_digest: null,
    client_metadata_json: null,
    unknown_account_digest: null,
    occurred_at_ms: SOURCE_AT_MS,
  });
}

function assertPendingPair(database, input) {
  const plan = createFreeAgentDraftReadinessTriggerPlan(input);
  assert.deepEqual(
    database
      .prepare(
        `SELECT id, league_id, season_id, job_type,
                occurrence_key, scheduled_for_ms, status,
                attempt_count, lease_owner, lease_token,
                lease_expires_at_ms, started_at_ms,
                completed_at_ms, result_json, last_error_code,
                created_at_ms, updated_at_ms, version,
                next_attempt_at_ms
         FROM job_runs
         WHERE id = ?`
      )
      .get(input.jobRunId),
    {
      id: input.jobRunId,
      league_id: input.leagueId,
      season_id: input.seasonId,
      job_type: "fad_readiness",
      occurrence_key: plan.job.occurrenceKey,
      scheduled_for_ms: input.createdAtMs,
      status: "pending",
      attempt_count: 0,
      lease_owner: null,
      lease_token: null,
      lease_expires_at_ms: null,
      started_at_ms: null,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      created_at_ms: input.createdAtMs,
      updated_at_ms: input.createdAtMs,
      version: 1,
      next_attempt_at_ms: null,
    }
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT id, league_id, season_id,
                readiness_occurrence_key, trigger_kind,
                entry_draft_id, setup_exemption_id,
                job_run_id, status, attempt_count,
                lease_owner, lease_token,
                lease_expires_at_ms, blockers_json,
                matchup_schedule_version_before,
                matchup_schedule_version_after,
                schedule_recovery_id, created_fad_id,
                reminder_job_run_id, deadline_job_run_id,
                cards_opened_activity_id,
                cards_opened_outbox_event_id,
                started_at_ms, next_retry_at_ms,
                terminal_at_ms, created_at_ms,
                updated_at_ms, version
         FROM free_agent_draft_readiness_operations
         WHERE id = ?`
      )
      .get(input.operationId),
    {
      id: input.operationId,
      league_id: input.leagueId,
      season_id: input.seasonId,
      readiness_occurrence_key: plan.job.occurrenceKey,
      trigger_kind: input.triggerKind,
      entry_draft_id: input.entryDraftId,
      setup_exemption_id: input.setupExemptionId,
      job_run_id: input.jobRunId,
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
      created_at_ms: input.createdAtMs,
      updated_at_ms: input.createdAtMs,
      version: 1,
    }
  );
}

function insertReadinessJob(database, input, overrides = {}) {
  const plan = createFreeAgentDraftReadinessTriggerPlan(input);
  insert(database, "job_runs", {
    id: input.jobRunId,
    league_id: input.leagueId,
    season_id: input.seasonId,
    job_type: "fad_readiness",
    occurrence_key: plan.job.occurrenceKey,
    scheduled_for_ms:
      overrides.scheduledForMs ?? input.createdAtMs,
    status: overrides.status ?? "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: input.createdAtMs,
    updated_at_ms: input.createdAtMs,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: null,
  });
}

function insertReadinessOperation(database, input) {
  const plan = createFreeAgentDraftReadinessTriggerPlan(input);
  insert(database, "free_agent_draft_readiness_operations", {
    id: input.operationId,
    league_id: input.leagueId,
    season_id: input.seasonId,
    readiness_occurrence_key: plan.job.occurrenceKey,
    trigger_kind: input.triggerKind,
    entry_draft_id: input.entryDraftId,
    setup_exemption_id: input.setupExemptionId,
    job_run_id: input.jobRunId,
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
    created_at_ms: input.createdAtMs,
    updated_at_ms: input.createdAtMs,
    version: 1,
  });
}

function assertRepositoryError(callback, code, reasonCode) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    if (reasonCode !== undefined) {
      assert.equal(error.details?.reasonCode, reasonCode);
    }
    return true;
  });
}

function seedInitialSeason2Evidence(database) {
  const ids = Object.freeze({
    user: uuid(200),
    platformRole: uuid(201),
    league: uuid(202),
    season: uuid(203),
    membership: uuid(204),
    migrationReport: uuid(205),
    bootstrapIdempotency: uuid(206),
    bootstrapActivity: uuid(207),
    bootstrapAudit: uuid(208),
  });
  seedUser(database, ids.user, "handoff-season2-admin");
  insert(database, "platform_roles", {
    id: ids.platformRole,
    user_id: ids.user,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: ids.user,
    granted_at_ms: SOURCE_AT_MS,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: "Lifecycle V2 Handoff League",
    name_normalized: "lifecycle v2 handoff league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: SOURCE_AT_MS,
    updated_at_ms: SOURCE_AT_MS,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: "2026",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: SOURCE_AT_MS,
    updated_at_ms: SOURCE_AT_MS,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: ids.membership,
    league_id: ids.league,
    user_id: ids.user,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: SOURCE_AT_MS,
    ended_at_ms: null,
    created_at_ms: SOURCE_AT_MS,
    updated_at_ms: SOURCE_AT_MS,
    version: 1,
  });
  database
    .prepare(
      `UPDATE leagues
       SET commissioner_membership_id = ?,
           current_season_id = ?,
           version = 2
       WHERE id = ?`
    )
    .run(ids.membership, ids.season, ids.league);
  insert(database, "idempotency_requests", {
    id: ids.bootstrapIdempotency,
    league_id: ids.league,
    actor_user_id: ids.user,
    operation: "admin.league.bootstrap_reset_original.v1",
    client_key: "reset-original-league-bootstrap",
    request_hash: "1".repeat(64),
    status: "completed",
    result_type: "league",
    result_id: ids.league,
    created_at_ms: SOURCE_AT_MS,
    completed_at_ms: SOURCE_AT_MS,
    expires_at_ms: SOURCE_AT_MS + DAY_MS,
  });
  insert(database, "league_activity", {
    id: ids.bootstrapActivity,
    league_id: ids.league,
    season_id: ids.season,
    event_type: "league_created",
    actor_user_id: ids.user,
    actor_authority: "platform_administrator",
    team_id: null,
    player_id: null,
    related_type: "league",
    related_id: ids.league,
    display_summary:
      "Lifecycle V2 Handoff League was created in Setup.",
    reason: null,
    metadata_json:
      '{"leagueStatus":"setup","seasonStatus":"planned"}',
    occurred_at_ms: SOURCE_AT_MS,
  });
  insert(database, "security_audit_events", {
    id: ids.bootstrapAudit,
    event_type:
      "system_bootstrap.reset_original_league_created",
    outcome: "success",
    actor_user_id: ids.user,
    target_user_id: null,
    league_id: ids.league,
    session_id: null,
    request_correlation_id: null,
    reason_code: "closed_write_reset_handoff",
    network_key_version: null,
    network_metadata_digest: null,
    client_metadata_json: null,
    unknown_account_digest: null,
    occurred_at_ms: SOURCE_AT_MS,
  });
  insert(database, "migration_reports", {
    id: ids.migrationReport,
    league_id: ids.league,
    source_bundle_id: "fad-handoff-season2-fixture",
    reset_manifest_id: "2026-season-1-reset-v1",
    database_schema_version: 33,
    status: "succeeded",
    source_hashes_json: JSON.stringify({ source: "2".repeat(64) }),
    counts_json: JSON.stringify({ teams: 1 }),
    totals_json: JSON.stringify({ records: 1 }),
    warnings_json: "[]",
    rejects_json: "[]",
    started_at_ms: SOURCE_AT_MS + 1,
    completed_at_ms: SOURCE_AT_MS + 2,
    created_at_ms: SOURCE_AT_MS + 1,
  });
  return ids;
}

describe("FAD readiness transaction-bound handoff writer", () => {
  test("rejects use outside an outer transaction without writing", (t) => {
    const database = createRuntime(t, "outer-transaction");
    const ids = seedLeague(database);
    const input = handoffInput({ ids });
    const writer =
      createSqliteFreeAgentDraftReadinessHandoffWriter({ database });

    assertRepositoryError(
      () => writer.write(input),
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "OUTER_TRANSACTION_REQUIRED"
    );
    assert.equal(database.inTransaction, false);
    assert.deepEqual(pairCounts(database), {
      jobs: 0,
      operations: 0,
    });
  });

  test("T-036 atomically hands off the genuine inaugural activation", (t) => {
    const database = createRuntime(t, "inaugural");
    const ids = seedLeague(database, {
      leagueStatus: "setup",
      seasonStatus: "planned",
      teamStatus: "setup",
      updatedAtMs: SOURCE_AT_MS,
    });
    const input = handoffInput({ ids });
    const steps = [];
    const writer =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database,
        afterStep(step) {
          steps.push(step);
        },
      });

    const result = transaction(database, () => {
      activateInauguralLeague(database, ids);
      return writer.write(input);
    });

    assert.equal(result.replayed, false);
    assert.equal(result.readiness.id, input.operationId);
    assert.equal(result.readiness.triggerKind, input.triggerKind);
    assert.deepEqual(steps, [
      "after_readiness_job_insert",
      "after_readiness_operation_insert",
    ]);
    assertPendingPair(database, input);
  });

  test("T-037 sees the exact exemption while lifecycle-v2 is still started", async (t) => {
    const database = createRuntime(t, "season2");
    const ids = seedInitialSeason2Evidence(database);
    let handoff = null;
    let handoffInputValue = null;
    let observedRequestStatus = null;
    const writer =
      createSqliteFreeAgentDraftReadinessHandoffWriter({ database });
    const repository =
      createSqliteLeagueLifecycleTransitionRepository({
        database,
      });
    const handoffWriter = Object.freeze({
      write(input) {
        handoffInputValue = input;
          const exemption = database
            .prepare(
              `SELECT id, idempotency_request_id
               FROM free_agent_draft_setup_exemptions
               WHERE league_id = ? AND season_id = ?`
            )
            .get(ids.league, ids.season);
          observedRequestStatus = database
            .prepare(
              `SELECT status
               FROM idempotency_requests
               WHERE id = ?`
            )
            .get(exemption.idempotency_request_id).status;
        handoff = writer.write(input);
        return handoff;
      },
    });
    let generated = 0;
    const service = createLeagueLifecycleTransitionService({
      repositoryContext: Object.freeze({
        transaction(callback) {
          return transaction(database, callback);
        },
      }),
      leagueAuthorization: Object.freeze({
        requireActiveMembership(authenticated, leagueId) {
          assert.equal(authenticated.user.id, ids.user);
          assert.equal(leagueId, ids.league);
          return Object.freeze({
            actorUserId: ids.user,
            membershipId: ids.membership,
          });
        },
        requireCommissioner() {
          throw new Error("commissioner path is not expected");
        },
      }),
      platformAuthorization: Object.freeze({
        requireAdministrator(authenticated) {
          assert.equal(authenticated.user.id, ids.user);
          return Object.freeze({ actorUserId: ids.user });
        },
      }),
      leagueLifecycleTransitionRepository: repository,
      freeAgentDraftReadinessHandoffWriter:
        handoffWriter,
      lateLockCoordinator: Object.freeze({
        async coordinateCommittedRoster() {
          throw new Error("exemption must not coordinate late locks");
        },
      }),
      clock: Object.freeze({
        nowMs() {
          return CREATED_AT_MS;
        },
      }),
      secureRandom: Object.freeze({
        id() {
          generated += 1;
          return uuid(300 + generated);
        },
      }),
    });
    const result = await service.transition({
      leagueId: ids.league,
      input: Object.freeze({
        transitionType:
          INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
        seasonId: ids.season,
        reason: "Approved initial Season 2 handoff fixture.",
        confirmation: INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
      }),
      expectedDraftVersion: null,
      idempotencyKey: "fad-handoff-season2",
      authenticated: Object.freeze({
        user: Object.freeze({ id: ids.user }),
      }),
    });

    assert.equal(result.replayed, false);
    assert.equal(observedRequestStatus, "started");
    assert.equal(handoff.replayed, false);
    assert.equal(
      handoffInputValue.operationId,
      uuid(307)
    );
    assert.equal(
      handoffInputValue.jobRunId,
      uuid(308)
    );
    const input = handoffInput({
      ids,
      operationId: handoffInputValue.operationId,
      jobRunId: handoffInputValue.jobRunId,
      triggerKind: "no_draft_initial_season2",
      triggerResourceId: result.exemptionId,
      setupExemptionId: result.exemptionId,
    });
    assertPendingPair(database, input);
    assert.equal(
      database
        .prepare(
          `SELECT status
           FROM idempotency_requests
           WHERE id = (
             SELECT idempotency_request_id
             FROM free_agent_draft_setup_exemptions
             WHERE id = ?
           )`
        )
        .get(result.exemptionId).status,
      "completed"
    );
    const changesBeforeReplay = totalChanges(database);
    const replay = transaction(database, () =>
      writer.write(input)
    );
    assert.equal(replay.replayed, true);
    assert.equal(
      replay.readiness.id,
      handoffInputValue.operationId
    );
    assert.equal(totalChanges(database), changesBeforeReplay);
    assertPendingPair(database, input);
  });

  test("simulated final T-108 completion and its handoff commit together", (t) => {
    const database = createRuntime(t, "entry-draft");
    const ids = seedLeague(database);
    const draftId = seedEntryDraft(database, ids);
    const pickId = seedFinalDraftPick(database, ids, draftId);
    const input = handoffInput({
      ids,
      operationId: uuid(900),
      jobRunId: uuid(901),
      triggerKind: "entry_draft_completed",
      triggerResourceId: draftId,
      entryDraftId: draftId,
    });
    const writer =
      createSqliteFreeAgentDraftReadinessHandoffWriter({ database });

    const result = transaction(database, () => {
      forfeitFinalDraftPick(database, ids, pickId);
      completeEntryDraft(database, ids, draftId);
      return writer.write(input);
    });

    assert.equal(result.replayed, false);
    assert.deepEqual(
      database
        .prepare(
          `SELECT status, completed_at_ms, updated_at_ms, version
           FROM entry_drafts
           WHERE id = ?`
        )
        .get(draftId),
      {
        status: "completed",
        completed_at_ms: CREATED_AT_MS,
        updated_at_ms: CREATED_AT_MS,
        version: 2,
      }
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT status, selection_id, updated_at_ms, version
           FROM draft_picks
           WHERE id = ?`
        )
        .get(pickId),
      {
        status: "forfeited",
        selection_id: null,
        updated_at_ms: CREATED_AT_MS,
        version: 2,
      }
    );
    assertPendingPair(database, input);
  });

  test("exact replay is write-free and never invokes fresh-write hooks", (t) => {
    const database = createRuntime(t, "replay");
    const ids = seedLeague(database);
    const input = handoffInput({ ids });
    let hookCount = 0;
    const writer =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database,
        afterStep() {
          hookCount += 1;
        },
      });

    transaction(database, () => writer.write(input));
    assert.equal(hookCount, 2);
    const beforeChanges = totalChanges(database);
    const replay = transaction(database, () => writer.write(input));

    assert.equal(replay.replayed, true);
    assert.equal(replay.readiness.id, input.operationId);
    assert.equal(totalChanges(database), beforeChanges);
    assert.equal(hookCount, 2);
    assertPendingPair(database, input);
  });

  test("invalid sources, cross-scope evidence, timestamps, and occurrences fail closed", (t) => {
    const invalidSource = createRuntime(t, "invalid-source");
    const invalidIds = seedLeague(invalidSource);
    const activeDraftId = seedEntryDraft(invalidSource, invalidIds);
    const invalidWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: invalidSource,
      });
    assertRepositoryError(
      () =>
        transaction(invalidSource, () =>
          invalidWriter.write(
            handoffInput({
              ids: invalidIds,
              triggerKind: "entry_draft_completed",
              triggerResourceId: activeDraftId,
              entryDraftId: activeDraftId,
            })
          )
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(pairCounts(invalidSource), {
      jobs: 0,
      operations: 0,
    });

    const wrongTimestamp = createRuntime(t, "wrong-time");
    const timestampIds = seedLeague(wrongTimestamp);
    const completedDraftId = seedEntryDraft(
      wrongTimestamp,
      timestampIds,
      {
        status: "completed",
        completedAtMs: CREATED_AT_MS,
        updatedAtMs: CREATED_AT_MS,
      }
    );
    const timestampWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: wrongTimestamp,
      });
    assertRepositoryError(
      () =>
        transaction(wrongTimestamp, () =>
          timestampWriter.write(
            handoffInput({
              ids: timestampIds,
              triggerKind: "entry_draft_completed",
              triggerResourceId: completedDraftId,
              entryDraftId: completedDraftId,
              createdAtMs: CREATED_AT_MS + 1,
            })
          )
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(pairCounts(wrongTimestamp), {
      jobs: 0,
      operations: 0,
    });

    const incompleteBoard = createRuntime(t, "incomplete-board");
    const incompleteIds = seedLeague(incompleteBoard);
    const incompleteDraftId = seedEntryDraft(
      incompleteBoard,
      incompleteIds,
      {
        status: "completed",
        completedAtMs: CREATED_AT_MS,
        updatedAtMs: CREATED_AT_MS,
      }
    );
    seedFinalDraftPick(
      incompleteBoard,
      incompleteIds,
      incompleteDraftId
    );
    const incompleteWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: incompleteBoard,
      });
    assertRepositoryError(
      () =>
        transaction(incompleteBoard, () =>
          incompleteWriter.write(
            handoffInput({
              ids: incompleteIds,
              triggerKind: "entry_draft_completed",
              triggerResourceId: incompleteDraftId,
              entryDraftId: incompleteDraftId,
            })
          )
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(pairCounts(incompleteBoard), {
      jobs: 0,
      operations: 0,
    });

    const crossScope = createRuntime(t, "cross-scope");
    const sourceIds = seedLeague(crossScope, {
      ids: baseIds(1_000),
      name: "Source Handoff League",
    });
    const otherIds = seedLeague(crossScope, {
      ids: baseIds(2_000),
      name: "Other Handoff League",
    });
    const sourceDraftId = seedEntryDraft(crossScope, sourceIds, {
      draftId: uuid(3_000),
      status: "completed",
      completedAtMs: CREATED_AT_MS,
      updatedAtMs: CREATED_AT_MS,
    });
    const crossWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: crossScope,
      });
    assertRepositoryError(
      () =>
        transaction(crossScope, () =>
          crossWriter.write(
            handoffInput({
              ids: otherIds,
              triggerKind: "entry_draft_completed",
              triggerResourceId: sourceDraftId,
              entryDraftId: sourceDraftId,
            })
          )
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(pairCounts(crossScope), {
      jobs: 0,
      operations: 0,
    });

    const resetOrigin = createRuntime(t, "reset-origin");
    const resetIds = seedLeague(resetOrigin);
    seedResetMigrationMarker(resetOrigin, resetIds);
    const resetWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: resetOrigin,
      });
    assertRepositoryError(
      () =>
        transaction(resetOrigin, () =>
          resetWriter.write(
            handoffInput({ ids: resetIds })
          )
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(pairCounts(resetOrigin), {
      jobs: 0,
      operations: 0,
    });

    const bootstrapOrigin = createRuntime(t, "bootstrap-origin");
    const bootstrapIds = seedLeague(bootstrapOrigin);
    seedResetBootstrapMarker(bootstrapOrigin, bootstrapIds);
    const bootstrapWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: bootstrapOrigin,
      });
    assertRepositoryError(
      () =>
        transaction(bootstrapOrigin, () =>
          bootstrapWriter.write(
            handoffInput({ ids: bootstrapIds })
          )
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(pairCounts(bootstrapOrigin), {
      jobs: 0,
      operations: 0,
    });

    const completeResetOrigin = createRuntime(
      t,
      "complete-reset-origin"
    );
    const completeResetIds = seedLeague(
      completeResetOrigin
    );
    seedResetMigrationMarker(
      completeResetOrigin,
      completeResetIds
    );
    seedResetBootstrapMarker(
      completeResetOrigin,
      completeResetIds
    );
    const completeResetWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: completeResetOrigin,
      });
    assertRepositoryError(
      () =>
        transaction(completeResetOrigin, () =>
          completeResetWriter.write(
            handoffInput({ ids: completeResetIds })
          )
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(pairCounts(completeResetOrigin), {
      jobs: 0,
      operations: 0,
    });

    const occurrenceConflict = createRuntime(
      t,
      "occurrence-conflict"
    );
    const conflictIds = seedLeague(occurrenceConflict);
    const inauguralInput = handoffInput({ ids: conflictIds });
    const conflictWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: occurrenceConflict,
      });
    transaction(occurrenceConflict, () =>
      conflictWriter.write(inauguralInput)
    );
    const conflictDraftId = seedEntryDraft(
      occurrenceConflict,
      conflictIds,
      {
        draftId: uuid(3_100),
        status: "completed",
        completedAtMs: CREATED_AT_MS,
        updatedAtMs: CREATED_AT_MS,
      }
    );
    assertRepositoryError(
      () =>
        transaction(occurrenceConflict, () =>
          conflictWriter.write(
            handoffInput({
              ids: conflictIds,
              operationId: uuid(3_101),
              jobRunId: uuid(3_102),
              triggerKind: "entry_draft_completed",
              triggerResourceId: conflictDraftId,
              entryDraftId: conflictDraftId,
            })
          )
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(pairCounts(occurrenceConflict), {
      jobs: 1,
      operations: 1,
    });
  });

  test("split and malformed existing pairs fail closed", (t) => {
    const splitDatabase = createRuntime(t, "split-pair");
    const splitIds = seedLeague(splitDatabase);
    const splitInput = handoffInput({ ids: splitIds });
    insertReadinessJob(splitDatabase, splitInput);
    const splitWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: splitDatabase,
      });
    const splitBefore = totalChanges(splitDatabase);
    assertRepositoryError(
      () =>
        transaction(splitDatabase, () =>
          splitWriter.write(splitInput)
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assert.equal(totalChanges(splitDatabase), splitBefore);
    assert.deepEqual(pairCounts(splitDatabase), {
      jobs: 1,
      operations: 0,
    });

    const malformedDatabase = createRuntime(t, "malformed-pair");
    const malformedIds = seedLeague(malformedDatabase);
    const malformedInput = handoffInput({ ids: malformedIds });
    insertReadinessJob(malformedDatabase, malformedInput, {
      scheduledForMs: CREATED_AT_MS + 1,
    });
    insertReadinessOperation(malformedDatabase, malformedInput);
    const malformedWriter =
      createSqliteFreeAgentDraftReadinessHandoffWriter({
        database: malformedDatabase,
      });
    const malformedBefore = totalChanges(malformedDatabase);
    assertRepositoryError(
      () =>
        transaction(malformedDatabase, () =>
          malformedWriter.write(malformedInput)
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assert.equal(totalChanges(malformedDatabase), malformedBefore);
    assert.deepEqual(pairCounts(malformedDatabase), {
      jobs: 1,
      operations: 1,
    });
  });

  for (const failingStep of [
    "after_readiness_job_insert",
    "after_readiness_operation_insert",
  ]) {
    test(`caller rollback owns ${failingStep} failure`, (t) => {
      const database = createRuntime(t, failingStep);
      const ids = seedLeague(database, {
        leagueStatus: "setup",
        seasonStatus: "planned",
        teamStatus: "setup",
        updatedAtMs: SOURCE_AT_MS,
      });
      const input = handoffInput({ ids });
      const writer =
        createSqliteFreeAgentDraftReadinessHandoffWriter({
          database,
          afterStep(step) {
            if (step === failingStep) {
              throw new Error(`injected:${step}`);
            }
          },
        });

      assert.throws(() =>
        transaction(database, () => {
          activateInauguralLeague(database, ids);
          writer.write(input);
        })
      );

      assert.deepEqual(pairCounts(database), {
        jobs: 0,
        operations: 0,
      });
      assert.deepEqual(
        database
          .prepare(
            `SELECT status, updated_at_ms, version
             FROM leagues WHERE id = ?`
          )
          .get(ids.league),
        {
          status: "setup",
          updated_at_ms: SOURCE_AT_MS,
          version: 1,
        }
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT status, updated_at_ms, version
             FROM seasons WHERE id = ?`
          )
          .get(ids.season),
        {
          status: "planned",
          updated_at_ms: SOURCE_AT_MS,
          version: 1,
        }
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT DISTINCT status, updated_at_ms, version
             FROM teams WHERE league_id = ?`
          )
          .all(ids.league),
        [
          {
            status: "setup",
            updated_at_ms: SOURCE_AT_MS,
            version: 1,
          },
        ]
      );
    });
  }

  for (const failingStep of [
    "after_readiness_job_insert",
    "after_readiness_operation_insert",
  ]) {
    test(`simulated final T-108 rolls back at ${failingStep}`, (t) => {
      const database = createRuntime(
        t,
        `entry-draft-${failingStep}`
      );
      const ids = seedLeague(database);
      const draftId = seedEntryDraft(database, ids);
      const pickId = seedFinalDraftPick(
        database,
        ids,
        draftId
      );
      const input = handoffInput({
        ids,
        operationId: uuid(920),
        jobRunId: uuid(921),
        triggerKind: "entry_draft_completed",
        triggerResourceId: draftId,
        entryDraftId: draftId,
      });
      const writer =
        createSqliteFreeAgentDraftReadinessHandoffWriter({
          database,
          afterStep(step) {
            if (step === failingStep) {
              throw new Error(`injected ${failingStep}`);
            }
          },
        });

      assert.throws(
        () =>
          transaction(database, () => {
            forfeitFinalDraftPick(database, ids, pickId);
            completeEntryDraft(database, ids, draftId);
            writer.write(input);
          }),
        (error) => {
          assert.equal(
            error.code,
            REPOSITORY_ERROR_CODES.operationFailed
          );
          assert.equal(
            error.cause?.message,
            `injected ${failingStep}`
          );
          return true;
        }
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT status, completed_at_ms, updated_at_ms, version
             FROM entry_drafts
             WHERE id = ?`
          )
          .get(draftId),
        {
          status: "active",
          completed_at_ms: null,
          updated_at_ms: SOURCE_AT_MS + 1,
          version: 1,
        }
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT status, selection_id, updated_at_ms, version
             FROM draft_picks
             WHERE id = ?`
          )
          .get(pickId),
        {
          status: "unused",
          selection_id: null,
          updated_at_ms: SOURCE_AT_MS,
          version: 1,
        }
      );
      assert.deepEqual(pairCounts(database), {
        jobs: 0,
        operations: 0,
      });
    });
  }
});
