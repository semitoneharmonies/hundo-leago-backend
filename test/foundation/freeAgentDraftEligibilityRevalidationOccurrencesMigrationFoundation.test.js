const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const CANONICAL_MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

const FIRST_MATCHUP_STARTS_AT_MS = 2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 604_800_000;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 172_800_000;
const OPENED_AT_MS = HELP_OPENS_AT_MS - 10_000;
const APPLIED_AT_MS = OPENED_AT_MS + 1_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const migrationsDirectory = path.join(temporaryRoot, "migrations");
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  return { ...connection, migrationsDirectory };
}

function copyMigrations(runtime, minimumId, maximumId) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (migration.id < minimumId || migration.id > maximumId) continue;
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

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  try {
    return database
      .prepare(`
        INSERT INTO ${tableName} (
          ${columns.join(", ")}
        ) VALUES (
          ${columns.map((column) => `@${column}`).join(", ")}
        )
      `)
      .run(values);
  } catch (error) {
    throw new Error(`Could not seed ${tableName}: ${error.message}`, {
      cause: error,
    });
  }
}

function dropInsertTriggers(database, tableName) {
  for (const { name } of database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name = ?
        AND upper(sql) LIKE '%BEFORE INSERT%'
    `)
    .all(tableName)) {
    database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
}

function seedSchema35Card(database, base = 36_000) {
  const ids = Object.freeze({
    managerUser: uuid(base),
    league: uuid(base + 1),
    season: uuid(base + 2),
    team: uuid(base + 3),
    week: uuid(base + 4),
    readiness: uuid(base + 5),
    fad: uuid(base + 6),
    participant: uuid(base + 7),
    card: uuid(base + 8),
    player: uuid(base + 9),
    entry: uuid(base + 10),
    sourceBefore: uuid(base + 11),
    sourceAfter: uuid(base + 12),
    sourceOperation: uuid(base + 13),
    occurrence: uuid(base + 14),
    job: uuid(base + 15),
    managerMembership: uuid(base + 16),
    managerAssignment: uuid(base + 17),
  });

  insert(database, "users", {
    id: ids.managerUser,
    email_normalized: `eligibility-${base}@example.test`,
    email_display: `eligibility-${base}@example.test`,
    display_name: `Eligibility Manager ${base}`,
    display_name_normalized: `eligibility manager ${base}`,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `Eligibility Migration League ${base}`,
    name_normalized: `eligibility migration league ${base}`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: ids.managerMembership,
    league_id: ids.league,
    user_id: ids.managerUser,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 10,
    ended_at_ms: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `Season ${base}`,
    nhl_season_key: `2026${base}`,
    status: "active",
    regular_season_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    regular_season_ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    fantasy_playoffs_start_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 8_000,
    fantasy_playoffs_end_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `Eligibility Migration Team ${base}`,
    name_normalized: `eligibility migration team ${base}`,
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: 20,
    updated_at_ms: 20,
    version: 1,
  });
  insert(database, "team_manager_assignments", {
    id: ids.managerAssignment,
    league_id: ids.league,
    team_id: ids.team,
    user_id: ids.managerUser,
    membership_id: ids.managerMembership,
    assigned_by_user_id: ids.managerUser,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: 20,
    accepted_at_ms: 20,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
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
  const readinessOccurrenceKey = `fad:${ids.season}:readiness`;
  insert(database, "free_agent_draft_readiness_operations", {
    id: ids.readiness,
    league_id: ids.league,
    season_id: ids.season,
    readiness_occurrence_key: readinessOccurrenceKey,
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
  dropInsertTriggers(database, "free_agent_drafts");
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key: readinessOccurrenceKey,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id: ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "cards_open",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Eligibility occurrence migration fixture.",
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
  dropInsertTriggers(database, "free_agent_draft_teams");
  insert(database, "free_agent_draft_teams", {
    id: ids.participant,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  });
  dropInsertTriggers(database, "candidate_cards");
  insert(database, "candidate_cards", {
    id: ids.card,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    status: "open",
    completeness_code: "incomplete",
    filled_mandatory_count: 1,
    missing_mandatory_count: 17,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    maximum_possible_cap_cents: 600,
    locked_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  insert(database, "players", {
    id: ids.player,
    first_name: "Semantic",
    last_name: "Delta",
    full_name: "Semantic Delta",
    birth_date: null,
    status: "active",
    created_at_ms: 30,
    updated_at_ms: 30,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: ids.sourceBefore,
    player_id: ids.player,
    provider: "sportsdataio-discovery-lab",
    source_position: "C",
    normalized_position: "F",
    nhl_team_abbreviation: "VAN",
    active: 1,
    source_version: "before",
    source_payload_json: null,
    effective_at_ms: 30,
    ended_at_ms: null,
    created_at_ms: 30,
  });
  dropInsertTriggers(database, "candidate_card_entries");
  insert(database, "candidate_card_entries", {
    id: ids.entry,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    entry_kind: "candidate",
    player_id: ids.player,
    effective_position_group: "F",
    requested_slot_group: "F",
    requested_slot_number: 1,
    placement_state: "placed",
    conflict_code: null,
    carryover_ownership_id: null,
    carryover_contract_id: null,
    source_roster_category: null,
    carryover_original_total_value_cents: null,
    carryover_original_term_years: null,
    carryover_aav_cents: null,
    remaining_years: null,
    proposed_total_value_cents: 600,
    proposed_term_years: 1,
    proposed_aav_cents: 600,
    eligibility_status: "valid",
    validation_code: null,
    last_acknowledgement_revision_id: null,
    created_by_user_id: ids.managerUser,
    created_by_membership_id: ids.managerMembership,
    created_by_authority: "manager",
    last_edited_by_user_id: ids.managerUser,
    last_edited_by_membership_id: ids.managerMembership,
    last_edited_by_authority: "manager",
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  return ids;
}

function catalogDetails(ids, overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    code: "PLAYER_CATALOG_APPLIED",
    sourceOperationId: ids.sourceOperation,
    provider: "sportsdataio-discovery-lab",
    capturedAtMs: APPLIED_AT_MS - 1,
    appliedAtMs: APPLIED_AT_MS,
    requestSha256: sha256("catalog-request"),
    rowCount: 1,
    createdPlayerCount: 0,
    updatedPlayerCount: 0,
    sourceStateChangeCount: 1,
    eligibilityChangedPlayerCount: 1,
    eligibilityRevalidationOccurrenceCount: 1,
    ...overrides,
  });
}

function occurrenceRecord(ids, overrides = {}) {
  return {
    id: ids.occurrence,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    source_operation_id: ids.sourceOperation,
    source_provider: "sportsdataio-discovery-lab",
    player_version_before: 1,
    player_version_after: 1,
    player_status_before: "active",
    player_status_after: "active",
    source_state_before_id: ids.sourceBefore,
    source_state_after_id: ids.sourceAfter,
    source_resolved_position_group_before: "F",
    source_resolved_position_group_after: "D",
    league_position_override_id: null,
    effective_position_group_before: "F",
    effective_position_group_after: "D",
    eligibility_delta_sha256: sha256(
      JSON.stringify({
        sourceOperationId: ids.sourceOperation,
        leagueId: ids.league,
        fadId: ids.fad,
        playerId: ids.player,
        before: { status: "active", positionGroup: "F" },
        after: { status: "active", positionGroup: "D" },
      })
    ),
    job_run_id: ids.job,
    occurrence_key:
      `fad:${ids.fad}:eligibility-revalidate:` +
      `${ids.player}:${ids.sourceOperation}`,
    scheduled_for_ms: APPLIED_AT_MS,
    created_at_ms: APPLIED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function jobRecord(ids, overrides = {}) {
  const occurrence = occurrenceRecord(ids);
  return {
    id: ids.job,
    league_id: ids.league,
    season_id: ids.season,
    job_type: "fad_eligibility_revalidation",
    occurrence_key: occurrence.occurrence_key,
    scheduled_for_ms: APPLIED_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: APPLIED_AT_MS,
    updated_at_ms: APPLIED_AT_MS,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: null,
    ...overrides,
  };
}

function applyCatalogDelta(database, ids, { eventOverrides = {} } = {}) {
  return database.transaction(() => {
    database
      .prepare(`
        UPDATE player_source_state
        SET ended_at_ms = ?
        WHERE id = ? AND ended_at_ms IS NULL
      `)
      .run(APPLIED_AT_MS, ids.sourceBefore);
    insert(database, "player_source_state", {
      id: ids.sourceAfter,
      player_id: ids.player,
      provider: "sportsdataio-discovery-lab",
      source_position: "D",
      normalized_position: "D",
      nhl_team_abbreviation: "VAN",
      active: 1,
      source_version: "after",
      source_payload_json: null,
      effective_at_ms: APPLIED_AT_MS,
      ended_at_ms: null,
      created_at_ms: APPLIED_AT_MS,
    });
    insert(
      database,
      "free_agent_draft_eligibility_revalidation_occurrences",
      occurrenceRecord(ids)
    );
    insert(database, "job_runs", jobRecord(ids));
    insert(database, "operational_events", {
      id: ids.sourceOperation,
      league_id: null,
      season_id: null,
      event_type: "player_catalog_applied",
      feature: "player_data_provider",
      outcome: "succeeded",
      actor_user_id: null,
      reason_code: "provider_catalog_import",
      details_json: catalogDetails(ids, eventOverrides),
      occurred_at_ms: APPLIED_AT_MS,
    });
  }).immediate();
}

function applicationRows(database) {
  const result = {};
  for (const { name } of database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT IN ('application_metadata', 'schema_migrations')
      ORDER BY name
    `)
    .all()) {
    result[name] = database
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all();
  }
  return result;
}

function schemaObjects(database) {
  return database
    .prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE type IN ('table', 'index', 'trigger', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all();
}

function assertConstraint(callback, pattern) {
  assert.throws(callback, (error) => {
    const sqliteError = error?.cause || error;
    return (
      sqliteError?.code?.startsWith("SQLITE_CONSTRAINT") &&
      (!pattern || pattern.test(error.message))
    );
  });
}

function assertHealthy(database) {
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(database.pragma("foreign_key_check"), []);
}

describe("FAD eligibility revalidation occurrence migration", () => {
  test("upgrades exact schema 35 additively and preserves every earlier ledger identity and application row", (t) => {
    const canonical = discoverMigrations({
      migrationsDirectory: CANONICAL_MIGRATIONS,
    });
    const migration36 = canonical.find(({ id }) => id === 36);
    assert.equal(
      migration36?.fileName,
      "0036_add_fad_eligibility_revalidation_occurrences.sql"
    );
    const runtime = createRuntime(t, "hundo-fad-eligibility-36-upgrade-");
    copyMigrations(runtime, 1, 35);
    migrate(runtime, "fad-eligibility-before");
    seedSchema35Card(runtime.database);

    const ledgerBefore = runtime.database
      .prepare(`
        SELECT migration_id, file_name, checksum
        FROM schema_migrations
        ORDER BY migration_id
      `)
      .all();
    const rowsBefore = applicationRows(runtime.database);
    const schemaBefore = schemaObjects(runtime.database);

    copyMigrations(runtime, 36, 36);
    const result = migrate(runtime, "fad-eligibility-after");
    assert.equal(result.status, "exact");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      36
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
      { metadataValue: "36", updatedAtMs: 36 }
    );
    assert.deepEqual(
      applicationRows(runtime.database),
      {
        ...rowsBefore,
        free_agent_draft_eligibility_revalidation_occurrences: [],
      }
    );
    const schemaAfterByName = new Map(
      schemaObjects(runtime.database).map((row) => [
        `${row.type}:${row.name}`,
        row,
      ])
    );
    for (const row of schemaBefore) {
      assert.deepEqual(
        schemaAfterByName.get(`${row.type}:${row.name}`),
        row
      );
    }
    const ledgerAfter = runtime.database
      .prepare(`
        SELECT migration_id, file_name, checksum
        FROM schema_migrations
        ORDER BY migration_id
      `)
      .all();
    assert.deepEqual(ledgerAfter.slice(0, 35), ledgerBefore);
    assert.deepEqual(ledgerAfter[35], {
      migration_id: 36,
      file_name: migration36.fileName,
      checksum: migration36.checksum,
    });
    assertHealthy(runtime.database);
  });

  test("seals one exact semantic player/FAD/job occurrence and rejects causal tampering", (t) => {
    const runtime = createRuntime(t, "hundo-fad-eligibility-36-seal-");
    copyMigrations(runtime, 1, 35);
    migrate(runtime, "fad-eligibility-seal-before");
    const ids = seedSchema35Card(runtime.database, 36_100);
    copyMigrations(runtime, 36, 36);
    migrate(runtime, "fad-eligibility-seal-after");

    applyCatalogDelta(runtime.database, ids);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT source_operation_id AS sourceOperationId,
                 player_id AS playerId,
                 fad_id AS fadId,
                 job_run_id AS jobRunId,
                 effective_position_group_before AS beforePosition,
                 effective_position_group_after AS afterPosition,
                 version
          FROM free_agent_draft_eligibility_revalidation_occurrences
        `)
        .get(),
      {
        sourceOperationId: ids.sourceOperation,
        playerId: ids.player,
        fadId: ids.fad,
        jobRunId: ids.job,
        beforePosition: "F",
        afterPosition: "D",
        version: 1,
      }
    );

    assertConstraint(
      () => runtime.database
        .prepare(`
          UPDATE free_agent_draft_eligibility_revalidation_occurrences
          SET eligibility_delta_sha256 = ?
          WHERE id = ?
        `)
        .run(sha256("tampered"), ids.occurrence),
      /occurrences are immutable/
    );
    assertConstraint(
      () => runtime.database
        .prepare("UPDATE operational_events SET reason_code = 'tampered' WHERE id = ?")
        .run(ids.sourceOperation),
      /source events are immutable/
    );
    assertConstraint(
      () => runtime.database
        .prepare("UPDATE job_runs SET occurrence_key = occurrence_key || ':tampered', version = version + 1 WHERE id = ?")
        .run(ids.job),
      /causal identity is immutable/
    );
    assertConstraint(
      () => runtime.database
        .prepare("UPDATE player_source_state SET normalized_position = 'F' WHERE id = ?")
        .run(ids.sourceAfter),
      /source eligibility evidence cannot be changed/
    );

    const orphanJob = { ...ids, job: uuid(36_199) };
    assertConstraint(
      () => insert(runtime.database, "job_runs", jobRecord(orphanJob)),
      /must bind its exact pending occurrence/
    );
    const unsealedOperation = uuid(36_198);
    assertConstraint(
      () => insert(runtime.database, "operational_events", {
        id: unsealedOperation,
        league_id: null,
        season_id: null,
        event_type: "player_catalog_applied",
        feature: "player_data_provider",
        outcome: "succeeded",
        actor_user_id: null,
        reason_code: "provider_catalog_import",
        details_json: catalogDetails(
          { ...ids, sourceOperation: unsealedOperation },
          { eligibilityRevalidationOccurrenceCount: 1 }
        ),
        occurred_at_ms: APPLIED_AT_MS,
      }),
      /must seal its exact eligibility revalidation batch/
    );
    assertHealthy(runtime.database);
  });

  test("fresh schema 36 blocks deadline locking until the exact occurrence is terminal", (t) => {
    const runtime = createRuntime(t, "hundo-fad-eligibility-36-fresh-");
    copyMigrations(runtime, 1, 36);
    migrate(runtime, "fad-eligibility-fresh");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      36
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'table'
            AND name = 'free_agent_draft_eligibility_revalidation_occurrences'
        `)
        .get().count,
      1
    );

    const ids = seedSchema35Card(runtime.database, 36_200);
    applyCatalogDelta(runtime.database, ids);
    for (const { name } of runtime.database
      .prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND tbl_name = 'free_agent_drafts'
          AND upper(sql) LIKE '%BEFORE UPDATE%'
          AND name <> 'free_agent_drafts_fad_eligibility_revalidation_barrier'
      `)
      .all()) {
      runtime.database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
    const lockFad = () => runtime.database
      .prepare(`
        UPDATE free_agent_drafts
        SET status = 'deadline_locked',
            deadline_locked_at_ms = candidate_deadline_at_ms,
            updated_at_ms = candidate_deadline_at_ms,
            version = version + 1
        WHERE league_id = ? AND id = ?
      `)
      .run(ids.league, ids.fad);
    assertConstraint(
      lockFad,
      /must consume every eligibility revalidation occurrence/
    );

    runtime.database
      .prepare(`
        UPDATE job_runs
        SET status = 'skipped',
            attempt_count = 1,
            started_at_ms = ?,
            completed_at_ms = ?,
            result_json = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE league_id = ? AND id = ?
      `)
      .run(
        CANDIDATE_DEADLINE_AT_MS,
        CANDIDATE_DEADLINE_AT_MS,
        JSON.stringify({ code: "FAD_ELIGIBILITY_DEADLINE_RECONCILED" }),
        CANDIDATE_DEADLINE_AT_MS,
        ids.league,
        ids.job
      );
    assert.equal(lockFad().changes, 1);
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM free_agent_drafts WHERE id = ?")
        .get(ids.fad).status,
      "deadline_locked"
    );
    assertHealthy(runtime.database);
  });
});
