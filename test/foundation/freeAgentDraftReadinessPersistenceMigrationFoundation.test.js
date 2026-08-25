const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  serializeCanonicalJsonV1,
  hashCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createFreeAgentDraftReadinessRetryRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
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
const MIGRATION_0030 = Object.freeze({
  byteLength: 636_077,
  sha256:
    "6f46b7a8c52108adfc0b51dc1eb9cdcab0ed274482ca396a31f7d45e42c07184",
});
const MIGRATION_0031 = Object.freeze({
  byteLength: 46_693,
  sha256:
    "f2c5104f2eb06e261cc902067bd4623b841f2c37a04f73d27487863077b2662a",
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
  idempotency: uuid(8),
  receipt: uuid(9),
  week: uuid(10),
  otherLeague: uuid(11),
  otherSeason: uuid(12),
  otherUser: uuid(13),
  otherMembership: uuid(14),
  wrongJob: uuid(15),
  wrongIdempotency: uuid(16),
});

const CREATED_AT_MS = 100;
const STARTED_AT_MS = 200;
const OBSERVED_AT_MS = 250;
const BLOCKED_AT_MS = 300;
const ACCEPTED_AT_MS = 400;
const LEASE_EXPIRES_AT_MS = 10_000;
const DEADLINE_AT_MS = 1_800_000_000_000;
const OCCURRENCE_KEY =
  `fad-readiness:${IDS.league}:${IDS.season}:${IDS.season}`;
const BLOCKER = Object.freeze({
  code: "TEAM_MANAGER_MISSING",
  field: null,
  resourceType: "team",
  resourceId: uuid(100),
  message: "A participating team needs an active manager.",
});
const BLOCKERS_JSON = JSON.stringify([BLOCKER]);
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

function assertConstraint(callback, pattern) {
  assert.throws(callback, (error) => {
    return (
      error?.code?.startsWith("SQLITE_CONSTRAINT") &&
      (!pattern || pattern.test(error.message))
    );
  });
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

function migrateFresh(t, prefix) {
  const runtime = createRuntime(t, prefix);
  copyMigrations(runtime, 1, 31);
  migrate(runtime, prefix);
  return runtime;
}

function schemaSql(database, type, name) {
  return database
    .prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = ?
        AND name = ?
    `)
    .get(type, name)?.sql;
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
      from: row.from,
      table: row.table,
      to: row.to,
      deferredTarget: `${row.table}.${row.to}`,
    }));
}

function ownedSchemaNames(database, tableName) {
  return database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE tbl_name = ?
        AND type IN ('index', 'trigger')
        AND sql IS NOT NULL
      ORDER BY name
    `)
    .all(tableName)
    .map((row) => row.name);
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

function seedIdentity(database) {
  for (const league of [
    {
      id: IDS.league,
      name: "Readiness League",
      normalized: "readiness league",
    },
    {
      id: IDS.otherLeague,
      name: "Other Readiness League",
      normalized: "other readiness league",
    },
  ]) {
    insert(database, "leagues", {
      id: league.id,
      name: league.name,
      name_normalized: league.normalized,
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }

  for (const user of [
    {
      id: IDS.user,
      email: "readiness@example.test",
      display: "Readiness Commissioner",
      normalized: "readiness commissioner",
    },
    {
      id: IDS.otherUser,
      email: "other-readiness@example.test",
      display: "Other Commissioner",
      normalized: "other commissioner",
    },
  ]) {
    insert(database, "users", {
      id: user.id,
      email_normalized: user.email,
      email_display: user.email,
      display_name: user.display,
      display_name_normalized: user.normalized,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }

  for (const season of [
    {
      id: IDS.season,
      leagueId: IDS.league,
      label: "2026-27",
      key: "20262027",
    },
    {
      id: IDS.otherSeason,
      leagueId: IDS.otherLeague,
      label: "2027-28",
      key: "20272028",
    },
  ]) {
    insert(database, "seasons", {
      id: season.id,
      league_id: season.leagueId,
      label: season.label,
      nhl_season_key: season.key,
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
  }

  for (const membership of [
    {
      id: IDS.membership,
      leagueId: IDS.league,
      userId: IDS.user,
    },
    {
      id: IDS.otherMembership,
      leagueId: IDS.otherLeague,
      userId: IDS.otherUser,
    },
  ]) {
    insert(database, "league_memberships", {
      id: membership.id,
      league_id: membership.leagueId,
      user_id: membership.userId,
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
      .run(
        membership.id,
        membership.leagueId === IDS.league
          ? IDS.season
          : IDS.otherSeason,
        membership.leagueId
      );
  }
}

function seedReadinessJob(
  database,
  {
    id = IDS.job,
    jobType = "fad_readiness",
    occurrenceKey = OCCURRENCE_KEY,
  } = {}
) {
  insert(database, "job_runs", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: jobType,
    occurrence_key: occurrenceKey,
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

function seedPendingReadiness(database) {
  seedIdentity(database);
  seedReadinessJob(database);
  insert(
    database,
    "free_agent_draft_readiness_operations",
    readinessRow()
  );
}

function startReadiness(database) {
  database
    .prepare(`
      UPDATE job_runs
      SET status = 'running',
          attempt_count = 1,
          lease_owner = 'readiness-worker',
          lease_token = 'readiness-lease',
          lease_expires_at_ms = ?,
          started_at_ms = ?,
          next_attempt_at_ms = NULL,
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ?
    `)
    .run(
      LEASE_EXPIRES_AT_MS,
      STARTED_AT_MS,
      STARTED_AT_MS,
      IDS.league,
      IDS.job
    );
  database
    .prepare(`
      UPDATE free_agent_draft_readiness_operations
      SET status = 'running',
          attempt_count = 1,
          started_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ?
    `)
    .run(
      STARTED_AT_MS,
      STARTED_AT_MS,
      IDS.league,
      IDS.readiness
    );
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

function attemptProjection(overrides = {}) {
  return {
    observedSeasonVersion: 1,
    firstMatchupWeekBefore: {
      sequence: 1,
      startsAtMs: DEADLINE_AT_MS + 604_800_000,
      version: 1,
      weekId: IDS.week,
    },
    firstMatchupWeekAfter: {
      sequence: 1,
      startsAtMs: DEADLINE_AT_MS + 604_800_000,
      version: 1,
      weekId: IDS.week,
    },
    candidateDeadlineAtMs: DEADLINE_AT_MS,
    reminderAtMs: DEADLINE_AT_MS - 259_200_000,
    helpOpensAtMs: DEADLINE_AT_MS - 172_800_000,
    initialRollovers: initialRollovers(),
    priorSeasonRollover: null,
    participatingTeamCount: 0,
    teamProjections: [],
    blockers: [PUBLIC_BLOCKER],
    warnings: [],
    ...overrides,
  };
}

function attemptRow(overrides = {}) {
  const special = {
    projection: overrides.projection,
    projectionJson: overrides.projection_json,
    projectionSha256: overrides.projection_sha256,
  };
  const projection = special.projection ?? attemptProjection();
  const row = {
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
    projection_json: "",
    projection_sha256: "",
    version: 1,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => key !== "projection"
      )
    ),
  };
  row.projection_json =
    special.projectionJson ?? serializeCanonicalJsonV1(projection);
  row.projection_sha256 =
    special.projectionSha256 ?? hashCanonicalJsonV1(projection);
  return row;
}

function insertAttempt(database, overrides = {}) {
  insert(
    database,
    "free_agent_draft_readiness_attempts",
    attemptRow(overrides)
  );
}

function blockReadiness(database, { withAttempt = true } = {}) {
  if (withAttempt) insertAttempt(database);
  database
    .prepare(`
      UPDATE free_agent_draft_readiness_operations
      SET status = 'blocked',
          blockers_json = ?,
          terminal_at_ms = ?,
          next_retry_at_ms = NULL,
          updated_at_ms = ?,
          version = 3
      WHERE league_id = ? AND id = ?
    `)
    .run(
      BLOCKERS_JSON,
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
          next_attempt_at_ms = NULL,
          updated_at_ms = ?,
          version = 3
      WHERE league_id = ? AND id = ?
    `)
    .run(
      BLOCKED_AT_MS,
      BLOCKED_AT_MS,
      IDS.league,
      IDS.job
    );
}

function seedBlockedReadiness(database) {
  seedPendingReadiness(database);
  startReadiness(database);
  blockReadiness(database);
}

function retryRequestHash() {
  return createFreeAgentDraftReadinessRetryRequest({
    actorUserId: IDS.user,
    leagueId: IDS.league,
    expectedVersion: 3,
    clientKey: "readiness-retry-key",
    body: {
      confirmation: "RETRY FREE AGENT DRAFT READINESS",
      readinessOperationId: IDS.readiness,
      seasonId: IDS.season,
    },
  }).requestSha256;
}

function seedIdempotency(database) {
  insert(database, "idempotency_requests", {
    id: IDS.idempotency,
    league_id: IDS.league,
    actor_user_id: IDS.user,
    operation: "free_agent_draft.readiness.retry.v1",
    client_key: "readiness-retry-key",
    request_hash: retryRequestHash(),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: BLOCKED_AT_MS,
    completed_at_ms: null,
    expires_at_ms: 100_000,
  });
  insert(database, "idempotency_requests", {
    id: IDS.wrongIdempotency,
    league_id: IDS.league,
    actor_user_id: IDS.user,
    operation: "free_agent_draft.readiness.retry.v1",
    client_key: "wrong-readiness-retry-key",
    request_hash: "b".repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: BLOCKED_AT_MS,
    completed_at_ms: null,
    expires_at_ms: 100_000,
  });
}

function receiptResponse(row) {
  return {
    acceptedAtMs: row.accepted_at_ms,
    acceptedFromVersion: row.accepted_from_version,
    jobRunId: row.job_run_id,
    leagueId: row.league_id,
    occurrenceKey: row.occurrence_key,
    readinessOperationId: row.readiness_operation_id,
    resultingReadinessVersion: row.resulting_readiness_version,
    retryAttemptNumber: row.retry_attempt_number,
    retryReceiptId: row.id,
    seasonId: row.season_id,
    status: "accepted",
  };
}

function receiptRow(overrides = {}) {
  const special = {
    responseJson: overrides.response_json,
    responseSha256: overrides.response_sha256,
  };
  const row = {
    id: IDS.receipt,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    idempotency_request_id: IDS.idempotency,
    actor_user_id: IDS.user,
    actor_membership_id: IDS.membership,
    actor_authority: "commissioner",
    request_sha256: retryRequestHash(),
    accepted_from_version: 3,
    resulting_readiness_version: 4,
    retry_attempt_number: 2,
    job_run_id: IDS.job,
    occurrence_key: OCCURRENCE_KEY,
    accepted_at_ms: ACCEPTED_AT_MS,
    response_http_status: 202,
    response_json: "",
    response_sha256: "",
    version: 1,
    ...overrides,
  };
  row.response_json =
    special.responseJson ??
    serializeCanonicalJsonV1(receiptResponse(row));
  row.response_sha256 =
    special.responseSha256 ??
    hashCanonicalJsonV1(receiptResponse(row));
  return row;
}

function insertReceipt(database, overrides = {}) {
  insert(
    database,
    "free_agent_draft_readiness_retry_receipts",
    receiptRow(overrides)
  );
}

function requeueJob(database) {
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
          next_attempt_at_ms = ?,
          updated_at_ms = ?,
          version = 4
      WHERE league_id = ? AND id = ?
    `)
    .run(
      ACCEPTED_AT_MS,
      ACCEPTED_AT_MS,
      IDS.league,
      IDS.job
    );
}

function advanceBlockedReadiness(database) {
  database
    .prepare(`
      UPDATE free_agent_draft_readiness_operations
      SET next_retry_at_ms = ?,
          updated_at_ms = ?,
          version = 4
      WHERE league_id = ? AND id = ?
    `)
    .run(
      ACCEPTED_AT_MS,
      ACCEPTED_AT_MS,
      IDS.league,
      IDS.readiness
    );
}

function completeIdempotency(database) {
  database
    .prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type = 'free_agent_draft_readiness_retry_receipt',
          result_id = ?,
          completed_at_ms = ?
      WHERE league_id = ? AND id = ?
    `)
    .run(
      IDS.receipt,
      ACCEPTED_AT_MS,
      IDS.league,
      IDS.idempotency
    );
}

function commitRetry(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    requeueJob(database);
    insertReceipt(database);
    advanceBlockedReadiness(database);
    completeIdempotency(database);
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function assertDeferredCommitRollback(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    callback();
    assertConstraint(
      () => database.exec("COMMIT"),
      /FOREIGN KEY constraint failed/
    );
  } finally {
    if (database.inTransaction) database.exec("ROLLBACK");
  }
}

describe("Free Agent Draft readiness persistence migration", () => {
  test("pins migration 0031 identity and preserves migration 0030 bytes", (t) => {
    const migrations = discoverMigrations({
      migrationsDirectory: CANONICAL_MIGRATIONS,
    });
    const migration30 = migrations.find(({ id }) => id === 30);
    const migration31 = migrations.find(({ id }) => id === 31);
    assert.equal(migration30.fileName,
      "0030_apply_locked_fad_decision_package.sql");
    assert.equal(
      fs.statSync(migration30.filePath).size,
      MIGRATION_0030.byteLength
    );
    assert.equal(migration30.checksum, MIGRATION_0030.sha256);
    assert.equal(
      migration31.fileName,
      "0031_add_fad_readiness_attempts_and_retry_receipts.sql"
    );
    assert.equal(
      fs.statSync(migration31.filePath).size,
      MIGRATION_0031.byteLength
    );
    assert.equal(migration31.checksum, MIGRATION_0031.sha256);

    const runtime = migrateFresh(t, "hundo-fad-0031-fresh-");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      31
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "31"
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT migration_id, file_name, checksum
          FROM schema_migrations
          WHERE migration_id = 31
        `)
        .get(),
      {
        migration_id: 31,
        file_name: migration31.fileName,
        checksum: migration31.checksum,
      }
    );
    assertHealthy(runtime.database);
  });

  test("upgrades an exact schema-30 database to schema 31", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0031-upgrade-");
    copyMigrations(runtime, 1, 30);
    migrate(runtime, "fad-0031-before");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      30
    );
    assert.equal(
      schemaSql(
        runtime.database,
        "table",
        "free_agent_draft_readiness_attempts"
      ),
      undefined
    );

    copyMigrations(runtime, 31, 31);
    migrate(runtime, "fad-0031-after");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      31
    );
    assert.ok(
      schemaSql(
        runtime.database,
        "table",
        "free_agent_draft_readiness_attempts"
      )
    );
    assert.ok(
      schemaSql(
        runtime.database,
        "table",
        "free_agent_draft_readiness_retry_receipts"
      )
    );
    assertHealthy(runtime.database);
  });

  test("installs the exact strict columns, same-league keys, indexes, and triggers", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0031-inventory-"
    );
    assert.deepEqual(
      tableColumns(database, "free_agent_draft_readiness_attempts"),
      [
        "id",
        "league_id",
        "season_id",
        "readiness_operation_id",
        "job_run_id",
        "attempt_number",
        "observed_readiness_version",
        "outcome",
        "observed_at_ms",
        "recorded_at_ms",
        "projection_json",
        "projection_sha256",
        "version",
      ]
    );
    assert.deepEqual(
      tableColumns(
        database,
        "free_agent_draft_readiness_retry_receipts"
      ),
      [
        "id",
        "league_id",
        "season_id",
        "readiness_operation_id",
        "idempotency_request_id",
        "actor_user_id",
        "actor_membership_id",
        "actor_authority",
        "request_sha256",
        "accepted_from_version",
        "resulting_readiness_version",
        "retry_attempt_number",
        "job_run_id",
        "occurrence_key",
        "accepted_at_ms",
        "response_http_status",
        "response_json",
        "response_sha256",
        "version",
      ]
    );
    assert.match(
      schemaSql(
        database,
        "table",
        "free_agent_draft_readiness_attempts"
      ),
      /\) STRICT$/
    );
    assert.match(
      schemaSql(
        database,
        "table",
        "free_agent_draft_readiness_retry_receipts"
      ),
      /\) STRICT$/
    );

    const attemptForeignKeys = foreignKeys(
      database,
      "free_agent_draft_readiness_attempts"
    );
    for (const expected of [
      "seasons.id",
      "free_agent_draft_readiness_operations.id",
      "job_runs.id",
    ]) {
      assert.ok(
        attemptForeignKeys.some(
          ({ deferredTarget }) => deferredTarget === expected
        ),
        expected
      );
    }
    const receiptForeignKeys = foreignKeys(
      database,
      "free_agent_draft_readiness_retry_receipts"
    );
    for (const expected of [
      "seasons.id",
      "free_agent_draft_readiness_operations.id",
      "idempotency_requests.id",
      "league_memberships.id",
      "job_runs.id",
    ]) {
      assert.ok(
        receiptForeignKeys.some(
          ({ deferredTarget }) => deferredTarget === expected
        ),
        expected
      );
    }

    assert.deepEqual(
      ownedSchemaNames(
        database,
        "free_agent_draft_readiness_attempts"
      ),
      [
        "free_agent_draft_readiness_attempts_immutable_delete",
        "free_agent_draft_readiness_attempts_immutable_update",
        "free_agent_draft_readiness_attempts_operation_latest",
        "free_agent_draft_readiness_attempts_valid_insert",
      ]
    );
    assert.deepEqual(
      ownedSchemaNames(
        database,
        "free_agent_draft_readiness_retry_receipts"
      ),
      [
        "free_agent_draft_readiness_retry_receipts_immutable_delete",
        "free_agent_draft_readiness_retry_receipts_immutable_update",
        "free_agent_draft_readiness_retry_receipts_operation_latest",
        "free_agent_draft_readiness_retry_receipts_valid_insert",
      ]
    );
    assert.ok(
      schemaSql(
        database,
        "trigger",
        "free_agent_draft_readiness_operations_forward_update"
      )
    );
    for (const forbiddenName of [
      "free_agent_draft_readiness_operations_schema31_valid_insert",
      "job_runs_fad_readiness_retry_forward_update",
      "idempotency_requests_fad_readiness_retry_complete",
      "idempotency_requests_fad_readiness_retry_immutable",
      "free_agent_draft_readiness_operations_identity_version",
      "job_runs_identity_version",
    ]) {
      assert.equal(
        database
          .prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE name = ?
          `)
          .get(forbiddenName),
        undefined,
        forbiddenName
      );
    }
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'trigger'
            AND name =
              'free_agent_draft_readiness_operations_forward_update'
        `)
        .get().count,
      1
    );
  });

  test("persists one exact blocked attempt and makes it immutable", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0031-attempt-"
    );
    seedPendingReadiness(database);
    startReadiness(database);

    assertConstraint(
      () => blockReadiness(database, { withAttempt: false }),
      /seven windows or none/
    );
    assert.equal(
      database
        .prepare(`
          SELECT status
          FROM free_agent_draft_readiness_operations
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.readiness).status,
      "running"
    );

    assertConstraint(
      () =>
        insertAttempt(database, {
          projection_json: `{ "blockers": [] }`,
        })
    );
    assertConstraint(
      () =>
        insertAttempt(database, {
          projection: attemptProjection({
            warnings: [{ code: "BAD" }],
          }),
        }),
      /public diagnostics require the exact safe shape/
    );
    assertConstraint(
      () =>
        insertAttempt(database, {
          projection_sha256: "A".repeat(64),
        })
    );
    assertConstraint(
      () =>
        insertAttempt(database, {
          recorded_at_ms: OBSERVED_AT_MS - 1,
        })
    );
    assertConstraint(
      () =>
        insertAttempt(database, {
          league_id: IDS.otherLeague,
          season_id: IDS.otherSeason,
        })
    );

    insertAttempt(database);
    const attempt = database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.attempt);
    assert.equal(attempt.attempt_number, 1);
    assert.equal(attempt.outcome, "blocked");
    assert.equal(
      attempt.projection_json,
      serializeCanonicalJsonV1(attemptProjection())
    );
    assert.equal(
      attempt.projection_sha256,
      hashCanonicalJsonV1(attemptProjection())
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE free_agent_draft_readiness_attempts
            SET projection_sha256 = ?
            WHERE league_id = ? AND id = ?
          `)
          .run("b".repeat(64), IDS.league, IDS.attempt),
      /readiness attempts are immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            DELETE FROM free_agent_draft_readiness_attempts
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.attempt),
      /readiness attempts are immutable/
    );
    assertHealthy(database);
  });

  test("rejects stale, cross-scope, wrong-job, wrong-idempotency, hash, and response evidence", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0031-receipt-invalid-"
    );
    seedBlockedReadiness(database);
    seedIdempotency(database);
    requeueJob(database);
    insert(database, "job_runs", {
      id: IDS.wrongJob,
      league_id: IDS.league,
      season_id: IDS.season,
      job_type: "fad_readiness",
      occurrence_key:
        `fad-readiness:${IDS.league}:${IDS.season}:${uuid(999)}`,
      scheduled_for_ms: CREATED_AT_MS,
      status: "pending",
      attempt_count: 1,
      lease_owner: null,
      lease_expires_at_ms: null,
      started_at_ms: null,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      created_at_ms: CREATED_AT_MS,
      updated_at_ms: ACCEPTED_AT_MS,
      version: 4,
      lease_token: null,
      next_attempt_at_ms: ACCEPTED_AT_MS,
    });

    const invalidRows = [
      { resulting_readiness_version: 3 },
      { resulting_readiness_version: 5 },
      {
        accepted_from_version: 2,
        resulting_readiness_version: 3,
      },
      {
        league_id: IDS.otherLeague,
        season_id: IDS.otherSeason,
      },
      {
        job_run_id: IDS.wrongJob,
        occurrence_key:
          `fad-readiness:${IDS.league}:${IDS.season}:${uuid(999)}`,
      },
      {
        idempotency_request_id: IDS.wrongIdempotency,
      },
      { request_sha256: "0".repeat(64) },
      { response_sha256: "A".repeat(64) },
      {
        response_json:
          `{ "acceptedAtMs": ${ACCEPTED_AT_MS} }`,
      },
    ];
    for (const invalid of invalidRows) {
      assertConstraint(() => insertReceipt(database, invalid));
    }
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_readiness_retry_receipts
        `)
        .get().count,
      0
    );
    assertHealthy(database);
  });

  test("guards partial retry evidence and rolls failed transactions back", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0031-retry-rollback-"
    );
    seedBlockedReadiness(database);
    seedIdempotency(database);

    assertConstraint(
      () => insertReceipt(database),
      /pending job/
    );
    assertConstraint(
      () => advanceBlockedReadiness(database),
      /seven windows or none/
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      requeueJob(database);
      assertConstraint(() =>
        insertReceipt(database, {
          response_json: serializeCanonicalJsonV1({ invalid: true }),
        })
      );
    } finally {
      if (database.inTransaction) database.exec("ROLLBACK");
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      requeueJob(database);
      insertReceipt(database);
    } finally {
      if (database.inTransaction) database.exec("ROLLBACK");
    }

    assert.equal(
      database
        .prepare(`
          SELECT version, next_retry_at_ms
          FROM free_agent_draft_readiness_operations
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.readiness).version,
      3
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, version, next_attempt_at_ms
          FROM job_runs
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.job),
      { status: "failed", version: 3, next_attempt_at_ms: null }
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_readiness_retry_receipts
        `)
        .get().count,
      0
    );
    assertHealthy(database);
  });

  test("commits the exact receipt, pending-job requeue, readiness advance, and idempotency result together", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0031-retry-success-"
    );
    seedBlockedReadiness(database);
    seedIdempotency(database);
    commitRetry(database);

    const expected = receiptRow();
    assert.deepEqual(
      database
        .prepare(`
          SELECT *
          FROM free_agent_draft_readiness_retry_receipts
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.receipt),
      expected
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, attempt_count, blockers_json,
                 next_retry_at_ms, terminal_at_ms, version
          FROM free_agent_draft_readiness_operations
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.readiness),
      {
        status: "blocked",
        attempt_count: 1,
        blockers_json: BLOCKERS_JSON,
        next_retry_at_ms: ACCEPTED_AT_MS,
        terminal_at_ms: BLOCKED_AT_MS,
        version: 4,
      }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, attempt_count, last_error_code,
                 started_at_ms, completed_at_ms, result_json,
                 next_attempt_at_ms, version
          FROM job_runs
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.job),
      {
        status: "pending",
        attempt_count: 1,
        last_error_code: null,
        started_at_ms: null,
        completed_at_ms: null,
        result_json: null,
        next_attempt_at_ms: ACCEPTED_AT_MS,
        version: 4,
      }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, result_type, result_id, completed_at_ms
          FROM idempotency_requests
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.idempotency),
      {
        status: "completed",
        result_type: "free_agent_draft_readiness_retry_receipt",
        result_id: IDS.receipt,
        completed_at_ms: ACCEPTED_AT_MS,
      }
    );
    assert.equal(expected.response_http_status, 202);
    assert.equal(
      expected.response_json,
      serializeCanonicalJsonV1(receiptResponse(expected))
    );

    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE free_agent_draft_readiness_retry_receipts
            SET response_sha256 = ?
            WHERE league_id = ? AND id = ?
          `)
          .run("c".repeat(64), IDS.league, IDS.receipt),
      /retry receipts are immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            DELETE FROM free_agent_draft_readiness_retry_receipts
            WHERE league_id = ? AND id = ?
          `)
          .run(IDS.league, IDS.receipt),
      /retry receipts are immutable/
    );
    assertHealthy(database);
  });
});
