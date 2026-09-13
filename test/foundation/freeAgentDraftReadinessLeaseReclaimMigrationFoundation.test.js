const assert = require("node:assert/strict");
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
  week: uuid(8),
});
const CREATED_AT_MS = 100;
const STARTED_AT_MS = 200;
const EXPIRED_AT_MS = 300;
const RECLAIMED_AT_MS = EXPIRED_AT_MS;
const NEW_LEASE_EXPIRES_AT_MS = 1_000;
const BLOCKED_AT_MS = 500;
const DEADLINE_AT_MS = 1_800_000_000_000;
const OLD_OWNER = "readiness-worker-old";
const OLD_TOKEN = "readiness-lease-old";
const NEW_OWNER = "readiness-worker-new";
const NEW_TOKEN = "readiness-lease-new";
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
  copyMigrations(runtime, 1, 32);
  migrate(runtime, prefix);
  return runtime;
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

function schemaRows(database, types) {
  const placeholders = types.map(() => "?").join(", ");
  return database
    .prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE type IN (${placeholders})
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all(...types);
}

function metadataRows(database) {
  return database
    .prepare(`
      SELECT metadata_key AS metadataKey,
             metadata_value AS metadataValue,
             updated_at_ms AS updatedAtMs
      FROM application_metadata
      ORDER BY metadata_key
    `)
    .all();
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

function seedIdentity(database) {
  insert(database, "leagues", {
    id: IDS.league,
    name: "Readiness Lease League",
    name_normalized: "readiness lease league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "users", {
    id: IDS.user,
    email_normalized: "readiness-lease@example.test",
    email_display: "readiness-lease@example.test",
    display_name: "Readiness Lease Commissioner",
    display_name_normalized: "readiness lease commissioner",
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
}

function seedExpiredRunningReadiness(
  database,
  {
    oldOwner = OLD_OWNER,
    oldToken = OLD_TOKEN,
  } = {}
) {
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
  insert(database, "free_agent_draft_readiness_operations", {
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
  });

  database
    .prepare(`
      UPDATE job_runs
      SET status = 'running',
          attempt_count = 1,
          lease_owner = ?,
          lease_token = ?,
          lease_expires_at_ms = ?,
          started_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ?
    `)
    .run(
      oldOwner,
      oldToken,
      EXPIRED_AT_MS,
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
          lease_owner = ?,
          lease_token = ?,
          lease_expires_at_ms = ?,
          started_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE league_id = ? AND id = ?
    `)
    .run(
      oldOwner,
      oldToken,
      EXPIRED_AT_MS,
      STARTED_AT_MS,
      STARTED_AT_MS,
      IDS.league,
      IDS.readiness
    );
}

function readJob(database) {
  return database
    .prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = ? AND id = ?
    `)
    .get(IDS.league, IDS.job);
}

function readReadiness(database) {
  return database
    .prepare(`
      SELECT *
      FROM free_agent_draft_readiness_operations
      WHERE league_id = ? AND id = ?
    `)
    .get(IDS.league, IDS.readiness);
}

function updateJobLease(
  database,
  {
    owner = NEW_OWNER,
    token = NEW_TOKEN,
    expiresAtMs = NEW_LEASE_EXPIRES_AT_MS,
    updatedAtMs = RECLAIMED_AT_MS,
    id = IDS.job,
    leagueId = IDS.league,
    seasonId = IDS.season,
    jobType = "fad_readiness",
    occurrenceKey = OCCURRENCE_KEY,
    scheduledForMs = CREATED_AT_MS,
    attemptCount = 1,
    startedAtMs = STARTED_AT_MS,
    versionDelta = 1,
  } = {}
) {
  return database
    .prepare(`
      UPDATE job_runs
      SET id = ?,
          league_id = ?,
          season_id = ?,
          job_type = ?,
          occurrence_key = ?,
          scheduled_for_ms = ?,
          attempt_count = ?,
          lease_owner = ?,
          lease_token = ?,
          lease_expires_at_ms = ?,
          started_at_ms = ?,
          updated_at_ms = ?,
          version = version + ?
      WHERE league_id = ?
        AND id = ?
        AND status = 'running'
    `)
    .run(
      id,
      leagueId,
      seasonId,
      jobType,
      occurrenceKey,
      scheduledForMs,
      attemptCount,
      owner,
      token,
      expiresAtMs,
      startedAtMs,
      updatedAtMs,
      versionDelta,
      IDS.league,
      IDS.job
    );
}

function updateReadinessLease(
  database,
  {
    owner = NEW_OWNER,
    token = NEW_TOKEN,
    expiresAtMs = NEW_LEASE_EXPIRES_AT_MS,
    updatedAtMs = RECLAIMED_AT_MS,
    attemptCount = 1,
    startedAtMs = STARTED_AT_MS,
    blockersJson = "[]",
    scheduleVersionBefore = null,
    scheduleVersionAfter = null,
    scheduleRecoveryId = null,
    createdFadId = null,
    reminderJobRunId = null,
    deadlineJobRunId = null,
    cardsOpenedActivityId = null,
    cardsOpenedOutboxEventId = null,
    nextRetryAtMs = null,
    terminalAtMs = null,
    occurrenceKey = OCCURRENCE_KEY,
    jobRunId = IDS.job,
    id = IDS.readiness,
    leagueId = IDS.league,
    seasonId = IDS.season,
    versionDelta = 1,
  } = {}
) {
  return database
    .prepare(`
      UPDATE free_agent_draft_readiness_operations
      SET id = ?,
          league_id = ?,
          season_id = ?,
          readiness_occurrence_key = ?,
          job_run_id = ?,
          attempt_count = ?,
          lease_owner = ?,
          lease_token = ?,
          lease_expires_at_ms = ?,
          blockers_json = ?,
          matchup_schedule_version_before = ?,
          matchup_schedule_version_after = ?,
          schedule_recovery_id = ?,
          created_fad_id = ?,
          reminder_job_run_id = ?,
          deadline_job_run_id = ?,
          cards_opened_activity_id = ?,
          cards_opened_outbox_event_id = ?,
          started_at_ms = ?,
          next_retry_at_ms = ?,
          terminal_at_ms = ?,
          updated_at_ms = ?,
          version = version + ?
      WHERE league_id = ?
        AND id = ?
        AND status = 'running'
    `)
    .run(
      id,
      leagueId,
      seasonId,
      occurrenceKey,
      jobRunId,
      attemptCount,
      owner,
      token,
      expiresAtMs,
      blockersJson,
      scheduleVersionBefore,
      scheduleVersionAfter,
      scheduleRecoveryId,
      createdFadId,
      reminderJobRunId,
      deadlineJobRunId,
      cardsOpenedActivityId,
      cardsOpenedOutboxEventId,
      startedAtMs,
      nextRetryAtMs,
      terminalAtMs,
      updatedAtMs,
      versionDelta,
      IDS.league,
      IDS.readiness
    );
}

function reclaim(database, { job = {}, readiness = {} } = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(updateJobLease(database, job).changes, 1);
    assert.equal(updateReadinessLease(database, readiness).changes, 1);
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
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

function blockedAttemptProjection() {
  const week = {
    sequence: 1,
    startsAtMs: DEADLINE_AT_MS + 604_800_000,
    version: 1,
    weekId: IDS.week,
  };
  return {
    observedSeasonVersion: 1,
    firstMatchupWeekBefore: week,
    firstMatchupWeekAfter: week,
    candidateDeadlineAtMs: DEADLINE_AT_MS,
    reminderAtMs: DEADLINE_AT_MS - 259_200_000,
    helpOpensAtMs: DEADLINE_AT_MS - 172_800_000,
    initialRollovers: initialRollovers(),
    priorSeasonRollover: null,
    participatingTeamCount: 0,
    teamProjections: [],
    blockers: [PUBLIC_BLOCKER],
    warnings: [],
  };
}

function insertBlockedAttempt(database) {
  const projection = blockedAttemptProjection();
  insert(database, "free_agent_draft_readiness_attempts", {
    id: IDS.attempt,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    job_run_id: IDS.job,
    attempt_number: 1,
    observed_readiness_version: 3,
    outcome: "blocked",
    observed_at_ms: RECLAIMED_AT_MS + 1,
    recorded_at_ms: BLOCKED_AT_MS,
    projection_json: serializeCanonicalJsonV1(projection),
    projection_sha256: hashCanonicalJsonV1(projection),
    version: 1,
  });
}

describe("Free Agent Draft readiness lease-reclaim migration", () => {
  test("pins migrations 0030-0032 and migrates a fresh database to schema 32", (t) => {
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
      assert.equal(migration.checksum, identity.sha256);
    }

    const runtime = migrateFresh(t, "hundo-fad-0032-fresh-");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      32
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
      { metadataValue: "32", updatedAtMs: 32 }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT migration_id AS migrationId,
                 file_name AS fileName,
                 checksum
          FROM schema_migrations
          WHERE migration_id BETWEEN 30 AND 32
          ORDER BY migration_id
        `)
        .all(),
      [30, 31, 32].map((migrationId) => ({
        migrationId,
        fileName: MIGRATION_IDENTITIES[migrationId].fileName,
        checksum: MIGRATION_IDENTITIES[migrationId].sha256,
      }))
    );
    assertHealthy(runtime.database);
  });

  test("upgrades exact schema 31 with no table or index delta and only the intended trigger and metadata changes", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0032-upgrade-");
    copyMigrations(runtime, 1, 31);
    migrate(runtime, "fad-0032-before");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      31
    );

    const tablesAndIndexesBefore = schemaRows(
      runtime.database,
      ["table", "index"]
    );
    const triggersBefore = schemaRows(runtime.database, ["trigger"]);
    const metadataBefore = metadataRows(runtime.database);

    copyMigrations(runtime, 32, 32);
    migrate(runtime, "fad-0032-after");

    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      32
    );
    assert.deepEqual(
      schemaRows(runtime.database, ["table", "index"]),
      tablesAndIndexesBefore
    );

    const triggersAfter = schemaRows(runtime.database, ["trigger"]);
    const triggerNamesBefore = new Set(
      triggersBefore.map(({ name }) => name)
    );
    const triggerNamesAfter = new Set(
      triggersAfter.map(({ name }) => name)
    );
    assert.deepEqual(
      triggersAfter
        .filter(({ name }) => !triggerNamesBefore.has(name))
        .map(({ name }) => name),
      ["free_agent_draft_readiness_job_reclaim_guard"]
    );
    assert.deepEqual(
      triggersBefore
        .filter(({ name }) => !triggerNamesAfter.has(name))
        .map(({ name }) => name),
      []
    );
    assert.deepEqual(
      triggersBefore
        .filter(({ name, sql }) => {
          const after = triggersAfter.find(
            (candidate) => candidate.name === name
          );
          return after && after.sql !== sql;
        })
        .map(({ name }) => name),
      ["free_agent_draft_readiness_operations_forward_update"]
    );

    const jobReclaimGuard = triggersAfter.find(
      ({ name }) =>
        name === "free_agent_draft_readiness_job_reclaim_guard"
    ).sql;
    const oldForwardTrigger = triggersBefore.find(
      ({ name }) =>
        name ===
        "free_agent_draft_readiness_operations_forward_update"
    ).sql;
    const newForwardTrigger = triggersAfter.find(
      ({ name }) =>
        name ===
        "free_agent_draft_readiness_operations_forward_update"
    ).sql;
    assert.doesNotMatch(
      oldForwardTrigger,
      /OLD\.status\s*=\s*'running'[\s\S]*NEW\.status\s*=\s*'running'/
    );
    assert.match(
      newForwardTrigger,
      /OLD\.status\s*=\s*'running'[\s\S]*NEW\.status\s*=\s*'running'/
    );
    assert.match(
      newForwardTrigger,
      /OLD\.lease_expires_at_ms\s*<=\s*NEW\.updated_at_ms/
    );
    assert.match(
      newForwardTrigger,
      /NEW\.lease_token\s*<>\s*OLD\.lease_token/
    );
    assert.match(
      newForwardTrigger,
      /NEW\.attempt_count\s*=\s*OLD\.attempt_count/
    );
    assert.match(
      newForwardTrigger,
      /NEW\.started_at_ms\s+IS\s+OLD\.started_at_ms/
    );
    assert.match(
      newForwardTrigger,
      /job_runs\.version\s*=\s*NEW\.version/
    );
    assert.match(
      jobReclaimGuard,
      /BEFORE UPDATE ON job_runs/
    );
    assert.match(
      jobReclaimGuard,
      /NEW\.version\s*=\s*OLD\.version\s*\+\s*1/
    );
    assert.match(
      jobReclaimGuard,
      /readiness\.version\s*=\s*OLD\.version/
    );
    assert.match(
      jobReclaimGuard,
      /readiness\.lease_token\s*=\s*OLD\.lease_token/
    );

    assert.deepEqual(metadataBefore, [
      {
        metadataKey: "application_compatibility_version",
        metadataValue: "1",
        updatedAtMs: 0,
      },
      {
        metadataKey: "data_model_version",
        metadataValue: "31",
        updatedAtMs: 31,
      },
    ]);
    assert.deepEqual(metadataRows(runtime.database), [
      {
        metadataKey: "application_compatibility_version",
        metadataValue: "1",
        updatedAtMs: 0,
      },
      {
        metadataKey: "data_model_version",
        metadataValue: "32",
        updatedAtMs: 32,
      },
    ]);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT migration_id AS migrationId,
                 file_name AS fileName,
                 checksum
          FROM schema_migrations
          WHERE migration_id = 32
        `)
        .get(),
      {
        migrationId: 32,
        fileName: MIGRATION_IDENTITIES[32].fileName,
        checksum: MIGRATION_IDENTITIES[32].sha256,
      }
    );
    assertHealthy(runtime.database);
  });

  test("reclaims one expired running lease without creating a new attempt or changing start/evidence", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0032-reclaim-"
    );
    seedExpiredRunningReadiness(database);
    const jobBefore = readJob(database);
    const readinessBefore = readReadiness(database);
    assert.deepEqual(
      {
        attemptCount: jobBefore.attempt_count,
        leaseOwner: jobBefore.lease_owner,
        leaseToken: jobBefore.lease_token,
        leaseExpiresAtMs: jobBefore.lease_expires_at_ms,
        startedAtMs: jobBefore.started_at_ms,
        version: jobBefore.version,
      },
      {
        attemptCount: readinessBefore.attempt_count,
        leaseOwner: readinessBefore.lease_owner,
        leaseToken: readinessBefore.lease_token,
        leaseExpiresAtMs: readinessBefore.lease_expires_at_ms,
        startedAtMs: readinessBefore.started_at_ms,
        version: readinessBefore.version,
      }
    );

    reclaim(database);
    const jobAfter = readJob(database);
    const readinessAfter = readReadiness(database);
    assert.equal(jobAfter.version, jobBefore.version + 1);
    assert.equal(readinessAfter.version, readinessBefore.version + 1);
    assert.equal(jobAfter.version, readinessAfter.version);
    assert.equal(jobAfter.attempt_count, jobBefore.attempt_count);
    assert.equal(
      readinessAfter.attempt_count,
      readinessBefore.attempt_count
    );
    assert.equal(jobAfter.started_at_ms, jobBefore.started_at_ms);
    assert.equal(
      readinessAfter.started_at_ms,
      readinessBefore.started_at_ms
    );
    for (const evidenceField of [
      "blockers_json",
      "matchup_schedule_version_before",
      "matchup_schedule_version_after",
      "schedule_recovery_id",
      "created_fad_id",
      "reminder_job_run_id",
      "deadline_job_run_id",
      "cards_opened_activity_id",
      "cards_opened_outbox_event_id",
      "next_retry_at_ms",
      "terminal_at_ms",
    ]) {
      assert.equal(
        readinessAfter[evidenceField],
        readinessBefore[evidenceField],
        evidenceField
      );
    }

    assert.deepEqual(
      database
        .prepare(`
          SELECT status,
                 attempt_count AS attemptCount,
                 lease_owner AS leaseOwner,
                 lease_token AS leaseToken,
                 lease_expires_at_ms AS leaseExpiresAtMs,
                 started_at_ms AS startedAtMs,
                 completed_at_ms AS completedAtMs,
                 result_json AS resultJson,
                 last_error_code AS lastErrorCode,
                 next_attempt_at_ms AS nextAttemptAtMs,
                 updated_at_ms AS updatedAtMs,
                 version
          FROM job_runs
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.job),
      {
        status: "running",
        attemptCount: 1,
        leaseOwner: NEW_OWNER,
        leaseToken: NEW_TOKEN,
        leaseExpiresAtMs: NEW_LEASE_EXPIRES_AT_MS,
        startedAtMs: STARTED_AT_MS,
        completedAtMs: null,
        resultJson: null,
        lastErrorCode: null,
        nextAttemptAtMs: null,
        updatedAtMs: RECLAIMED_AT_MS,
        version: 3,
      }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status,
                 attempt_count AS attemptCount,
                 lease_owner AS leaseOwner,
                 lease_token AS leaseToken,
                 lease_expires_at_ms AS leaseExpiresAtMs,
                 blockers_json AS blockersJson,
                 matchup_schedule_version_before AS scheduleBefore,
                 matchup_schedule_version_after AS scheduleAfter,
                 schedule_recovery_id AS recoveryId,
                 created_fad_id AS createdFadId,
                 started_at_ms AS startedAtMs,
                 next_retry_at_ms AS nextRetryAtMs,
                 terminal_at_ms AS terminalAtMs,
                 updated_at_ms AS updatedAtMs,
                 version
          FROM free_agent_draft_readiness_operations
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.readiness),
      {
        status: "running",
        attemptCount: 1,
        leaseOwner: NEW_OWNER,
        leaseToken: NEW_TOKEN,
        leaseExpiresAtMs: NEW_LEASE_EXPIRES_AT_MS,
        blockersJson: "[]",
        scheduleBefore: null,
        scheduleAfter: null,
        recoveryId: null,
        createdFadId: null,
        startedAtMs: STARTED_AT_MS,
        nextRetryAtMs: null,
        terminalAtMs: null,
        updatedAtMs: RECLAIMED_AT_MS,
        version: 3,
      }
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_readiness_attempts
          WHERE league_id = ?
            AND readiness_operation_id = ?
        `)
        .get(IDS.league, IDS.readiness).count,
      0
    );
    assertHealthy(database);
  });

  test("rejects schema-31 source leases whose old owner and token are control-whitespace", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0032-malformed-schema31-source-"
    );
    copyMigrations(runtime, 1, 31);
    migrate(runtime, "fad-0032-malformed-source-before");
    seedExpiredRunningReadiness(runtime.database, {
      oldOwner: "\t",
      oldToken: "\n",
    });
    copyMigrations(runtime, 32, 32);
    migrate(runtime, "fad-0032-malformed-source-after");

    const originalJob = readJob(runtime.database);
    const originalReadiness = readReadiness(runtime.database);
    assert.equal(originalJob.lease_owner, "\t");
    assert.equal(originalJob.lease_token, "\n");

    runtime.database.exec("BEGIN IMMEDIATE");
    try {
      assertConstraint(
        () => updateJobLease(runtime.database),
        /readiness job reclaim requires one expired matching lease and exact version advance/
      );
    } finally {
      if (runtime.database.inTransaction) {
        runtime.database.exec("ROLLBACK");
      }
    }
    assert.deepEqual(readJob(runtime.database), originalJob);
    assert.deepEqual(
      readReadiness(runtime.database),
      originalReadiness
    );

    runtime.database.exec("BEGIN IMMEDIATE");
    try {
      withoutTableTriggers(runtime.database, ["job_runs"], () => {
        assert.equal(updateJobLease(runtime.database).changes, 1);
      });
      assertConstraint(
        () => updateReadinessLease(runtime.database),
        /FAD readiness must open every team and seven windows or none/
      );
    } finally {
      if (runtime.database.inTransaction) {
        runtime.database.exec("ROLLBACK");
      }
    }
    assert.deepEqual(readJob(runtime.database), originalJob);
    assert.deepEqual(
      readReadiness(runtime.database),
      originalReadiness
    );
    assertHealthy(runtime.database);
  });

  test("job guard rejects live, reused, blank, malformed, version, attempt, start, and binding changes", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0032-job-rejections-"
    );
    seedExpiredRunningReadiness(database);
    const originalJob = readJob(database);
    const originalReadiness = readReadiness(database);
    const invalidCases = [
      {
        name: "one-millisecond-live old lease",
        job: { updatedAtMs: EXPIRED_AT_MS - 1 },
      },
      {
        name: "reused lease token",
        job: { token: OLD_TOKEN },
      },
      { name: "empty owner", job: { owner: "" } },
      { name: "space-only owner", job: { owner: " " } },
      { name: "tab-only owner", job: { owner: "\t" } },
      { name: "newline-only owner", job: { owner: "\n" } },
      { name: "space-edged owner", job: { owner: " new-owner" } },
      { name: "tab-edged owner", job: { owner: "new-owner\t" } },
      { name: "empty token", job: { token: "" } },
      { name: "space-only token", job: { token: " " } },
      { name: "tab-only token", job: { token: "\t" } },
      { name: "newline-only token", job: { token: "\n" } },
      { name: "space-edged token", job: { token: " new-token" } },
      { name: "newline-edged token", job: { token: "new-token\n" } },
      { name: "null new lease expiry", job: { expiresAtMs: null } },
      { name: "job version does not advance", job: { versionDelta: 0 } },
      { name: "job version advances twice", job: { versionDelta: 2 } },
      {
        name: "job attempt-count mutation",
        job: { attemptCount: 2 },
      },
      {
        name: "job start-time mutation",
        job: { startedAtMs: STARTED_AT_MS + 1 },
      },
      {
        name: "job-type binding mutation",
        job: { jobType: "fad_deadline" },
      },
      { name: "job-id binding mutation", job: { id: uuid(300) } },
      {
        name: "job-league binding mutation",
        job: { leagueId: uuid(301) },
      },
      {
        name: "job-season binding mutation",
        job: { seasonId: uuid(302) },
      },
      {
        name: "occurrence binding mutation",
        job: { occurrenceKey: `${OCCURRENCE_KEY}:wrong` },
      },
      {
        name: "scheduled-time binding mutation",
        job: { scheduledForMs: CREATED_AT_MS + 1 },
      },
    ];

    for (const invalidCase of invalidCases) {
      database.exec("BEGIN IMMEDIATE");
      try {
        assertConstraint(
          () => updateJobLease(database, invalidCase.job),
          /readiness job reclaim requires one expired matching lease and exact version advance/
        );
      } finally {
        if (database.inTransaction) database.exec("ROLLBACK");
      }
      assert.deepEqual(
        readJob(database),
        originalJob,
        `${invalidCase.name}: job rollback`
      );
      assert.deepEqual(
        readReadiness(database),
        originalReadiness,
        `${invalidCase.name}: readiness unchanged`
      );
    }
    assertHealthy(database);
  });

  test("operation guard rejects count, start, blocker, schedule, opening, terminal, binding, and new-lease mismatches", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0032-operation-rejections-"
    );
    seedExpiredRunningReadiness(database);
    const originalJob = readJob(database);
    const originalReadiness = readReadiness(database);
    const invalidCases = [
      { name: "attempt count", readiness: { attemptCount: 2 } },
      {
        name: "start time",
        readiness: { startedAtMs: STARTED_AT_MS + 1 },
      },
      {
        name: "blocker evidence",
        readiness: { blockersJson: BLOCKERS_JSON },
      },
      {
        name: "schedule evidence",
        readiness: {
          scheduleVersionBefore: 1,
          scheduleVersionAfter: 1,
        },
      },
      {
        name: "recovery evidence",
        readiness: { scheduleRecoveryId: uuid(200) },
      },
      {
        name: "created FAD opening evidence",
        readiness: { createdFadId: uuid(201) },
      },
      {
        name: "reminder opening evidence",
        readiness: { reminderJobRunId: uuid(202) },
      },
      {
        name: "deadline opening evidence",
        readiness: { deadlineJobRunId: uuid(203) },
      },
      {
        name: "activity opening evidence",
        readiness: { cardsOpenedActivityId: uuid(204) },
      },
      {
        name: "outbox opening evidence",
        readiness: { cardsOpenedOutboxEventId: uuid(205) },
      },
      {
        name: "retry evidence",
        readiness: { nextRetryAtMs: RECLAIMED_AT_MS },
      },
      {
        name: "terminal evidence",
        readiness: { terminalAtMs: RECLAIMED_AT_MS },
      },
      {
        name: "occurrence binding",
        readiness: { occurrenceKey: `${OCCURRENCE_KEY}:wrong` },
      },
      {
        name: "job binding",
        readiness: { jobRunId: uuid(206) },
      },
      {
        name: "operation-id binding",
        readiness: { id: uuid(303) },
      },
      {
        name: "operation-league binding",
        readiness: { leagueId: uuid(304) },
      },
      {
        name: "operation-season binding",
        readiness: { seasonId: uuid(305) },
      },
      { name: "empty owner", readiness: { owner: "" } },
      { name: "space-only owner", readiness: { owner: " " } },
      { name: "tab-only owner", readiness: { owner: "\t" } },
      { name: "newline-only owner", readiness: { owner: "\n" } },
      { name: "empty token", readiness: { token: "" } },
      { name: "space-only token", readiness: { token: " " } },
      { name: "tab-only token", readiness: { token: "\t" } },
      { name: "newline-only token", readiness: { token: "\n" } },
      {
        name: "operation version does not advance",
        readiness: { versionDelta: 0 },
      },
      {
        name: "operation version advances twice",
        readiness: { versionDelta: 2 },
      },
      {
        name: "job lease owner",
        job: { owner: "job-only-worker" },
      },
      {
        name: "job lease token",
        job: { token: "job-only-token" },
      },
      {
        name: "job lease expiry",
        job: { expiresAtMs: NEW_LEASE_EXPIRES_AT_MS + 1 },
      },
    ];

    for (const invalidCase of invalidCases) {
      database.exec("BEGIN IMMEDIATE");
      try {
        assert.equal(
          updateJobLease(database, invalidCase.job).changes,
          1,
          invalidCase.name
        );
        assertConstraint(
          () => updateReadinessLease(
            database,
            invalidCase.readiness
          ),
          /FAD readiness must open every team and seven windows or none/
        );
      } finally {
        if (database.inTransaction) database.exec("ROLLBACK");
      }

      assert.deepEqual(
        readJob(database),
        originalJob,
        `${invalidCase.name}: job rollback`
      );
      assert.deepEqual(
        readReadiness(database),
        originalReadiness,
        `${invalidCase.name}: readiness rollback`
      );
    }
    assertHealthy(database);
  });

  test("job guard rejects every preexisting job-operation lease, version, and start split", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0032-preexisting-split-"
    );
    seedExpiredRunningReadiness(database);
    const originalJob = readJob(database);
    const originalReadiness = readReadiness(database);
    const splitCases = [
      { name: "owner", field: "lease_owner", value: "split-owner" },
      { name: "token", field: "lease_token", value: "split-token" },
      {
        name: "expiry",
        field: "lease_expires_at_ms",
        value: EXPIRED_AT_MS + 1,
      },
      { name: "version", field: "version", value: 3 },
      {
        name: "start",
        field: "started_at_ms",
        value: STARTED_AT_MS + 1,
      },
    ];

    for (const splitCase of splitCases) {
      database.exec("BEGIN IMMEDIATE");
      try {
        withoutTableTriggers(
          database,
          ["free_agent_draft_readiness_operations"],
          () => {
            database
              .prepare(`
                UPDATE free_agent_draft_readiness_operations
                SET ${splitCase.field} = ?
                WHERE league_id = ? AND id = ?
              `)
              .run(splitCase.value, IDS.league, IDS.readiness);
          }
        );
        assertConstraint(
          () => updateJobLease(database),
          /readiness job reclaim requires one expired matching lease and exact version advance/
        );
      } finally {
        if (database.inTransaction) database.exec("ROLLBACK");
      }
      assert.deepEqual(
        readJob(database),
        originalJob,
        `${splitCase.name}: job unchanged`
      );
      assert.deepEqual(
        readReadiness(database),
        originalReadiness,
        `${splitCase.name}: split rolled back`
      );
    }
    assertHealthy(database);
  });

  test("an injected failure after the guarded job CAS rolls the job write back", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0032-injected-rollback-"
    );
    seedExpiredRunningReadiness(database);
    const originalJob = readJob(database);
    const originalReadiness = readReadiness(database);
    const injected = new Error("injected after job CAS");

    // This proves the SQLite transaction seam. The repository-level failure
    // injection that owns this transaction is intentionally the next step.
    assert.throws(() => {
      database.exec("BEGIN IMMEDIATE");
      try {
        assert.equal(updateJobLease(database).changes, 1);
        assert.equal(readJob(database).lease_token, NEW_TOKEN);
        throw injected;
      } catch (error) {
        if (database.inTransaction) database.exec("ROLLBACK");
        throw error;
      }
    }, injected);

    assert.deepEqual(readJob(database), originalJob);
    assert.deepEqual(readReadiness(database), originalReadiness);
    assertHealthy(database);
  });

  test("fresh-token terminal CAS fences the old token and records only the retained attempt", (t) => {
    const { database } = migrateFresh(
      t,
      "hundo-fad-0032-terminal-fence-"
    );
    seedExpiredRunningReadiness(database);
    reclaim(database);
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_readiness_attempts
          WHERE league_id = ?
            AND readiness_operation_id = ?
        `)
        .get(IDS.league, IDS.readiness).count,
      0
    );

    // Caller-token fencing is a repository CAS responsibility. These exact
    // predicates are exercised against schema 32 here; the repository's
    // atomic method and injected seams belong to the next implementation step.
    assert.equal(
      database
        .prepare(`
          UPDATE free_agent_draft_readiness_operations
          SET updated_at_ms = updated_at_ms
          WHERE league_id = ?
            AND id = ?
            AND status = 'running'
            AND lease_token = ?
        `)
        .run(IDS.league, IDS.readiness, OLD_TOKEN).changes,
      0
    );
    assert.equal(
      database
        .prepare(`
          UPDATE job_runs
          SET updated_at_ms = updated_at_ms
          WHERE league_id = ?
            AND id = ?
            AND status = 'running'
            AND lease_token = ?
        `)
        .run(IDS.league, IDS.job, OLD_TOKEN).changes,
      0
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      insertBlockedAttempt(database);
      assert.equal(
        database
          .prepare(`
            UPDATE free_agent_draft_readiness_operations
            SET status = 'blocked',
                blockers_json = ?,
                terminal_at_ms = ?,
                updated_at_ms = ?,
                version = version + 1
            WHERE league_id = ?
              AND id = ?
              AND status = 'running'
              AND attempt_count = 1
              AND lease_token = ?
              AND version = 3
          `)
          .run(
            BLOCKERS_JSON,
            BLOCKED_AT_MS,
            BLOCKED_AT_MS,
            IDS.league,
            IDS.readiness,
            NEW_TOKEN
          ).changes,
        1
      );
      assert.equal(
        database
          .prepare(`
            UPDATE job_runs
            SET status = 'failed',
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at_ms = NULL,
                completed_at_ms = ?,
                last_error_code = 'FAD_READINESS_BLOCKED',
                updated_at_ms = ?,
                version = version + 1
            WHERE league_id = ?
              AND id = ?
              AND status = 'running'
              AND attempt_count = 1
              AND lease_token = ?
              AND version = 3
          `)
          .run(
            BLOCKED_AT_MS,
            BLOCKED_AT_MS,
            IDS.league,
            IDS.job,
            NEW_TOKEN
          ).changes,
        1
      );
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }

    assert.deepEqual(
      database
        .prepare(`
          SELECT attempt_number AS attemptNumber,
                 observed_readiness_version AS observedVersion,
                 outcome
          FROM free_agent_draft_readiness_attempts
          WHERE league_id = ?
            AND readiness_operation_id = ?
          ORDER BY attempt_number
        `)
        .all(IDS.league, IDS.readiness),
      [{ attemptNumber: 1, observedVersion: 3, outcome: "blocked" }]
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, attempt_count AS attemptCount, version
          FROM free_agent_draft_readiness_operations
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.readiness),
      { status: "blocked", attemptCount: 1, version: 4 }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, attempt_count AS attemptCount, version
          FROM job_runs
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.job),
      { status: "failed", attemptCount: 1, version: 4 }
    );
    assertHealthy(database);
  });
});
