"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

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

const CANONICAL_MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

const DAY_MS = 86_400_000;
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const DEADLINE_AT_MS =
  WEEK_ONE_AT_MS - 7 * DAY_MS;
const OPENED_AT_MS =
  DEADLINE_AT_MS - 30 * DAY_MS;
const ROW_AT_MS = DEADLINE_AT_MS + 100;

const EXPECTED_TRIGGER_SQL = `CREATE TRIGGER free_agent_draft_allocations_pending_insert
BEFORE INSERT ON free_agent_draft_player_allocations
BEGIN
  SELECT CASE WHEN NOT (
    NEW.status = 'pending'
    AND NEW.decision_code IS NULL
    AND NEW.winning_snapshot_entry_id IS NULL
    AND NEW.winning_team_id IS NULL
    AND NEW.contract_id IS NULL
    AND NEW.ownership_id IS NULL
    AND NEW.restricted_auction_id IS NULL
    AND NEW.fallback_open_auction_id IS NULL
    AND NEW.restricted_minimum_total_cents IS NULL
    AND NEW.restricted_minimum_term_years IS NULL
    AND NEW.restricted_minimum_aav_cents IS NULL
    AND NEW.accounted_at_ms IS NULL
    AND NEW.last_error_code IS NULL
    AND NEW.updated_at_ms = NEW.created_at_ms
    AND NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM free_agent_drafts
      WHERE free_agent_drafts.league_id = NEW.league_id
        AND free_agent_drafts.season_id = NEW.season_id
        AND free_agent_drafts.id = NEW.fad_id
        AND (
          free_agent_drafts.status IN (
            'deadline_locked',
            'allocating'
          )
          OR (
            free_agent_drafts.status = 'cards_open'
            AND NEW.created_at_ms >=
              free_agent_drafts.candidate_deadline_at_ms
            AND EXISTS (
              SELECT 1
              FROM candidate_card_snapshot_entries
              WHERE candidate_card_snapshot_entries.league_id =
                  NEW.league_id
                AND candidate_card_snapshot_entries.season_id =
                  NEW.season_id
                AND candidate_card_snapshot_entries.fad_id = NEW.fad_id
                AND candidate_card_snapshot_entries.player_id =
                  NEW.player_id
                AND candidate_card_snapshot_entries.occupant_kind =
                  'candidate'
            )
            AND EXISTS (
              SELECT 1
              FROM job_runs
              WHERE job_runs.league_id = NEW.league_id
                AND job_runs.season_id = NEW.season_id
                AND job_runs.job_type = 'fad_deadline'
                AND job_runs.occurrence_key =
                  'fad:' || NEW.fad_id || ':deadline:' ||
                    free_agent_drafts.candidate_deadline_at_ms
                AND job_runs.scheduled_for_ms =
                  free_agent_drafts.candidate_deadline_at_ms
                AND job_runs.status IN ('leased', 'running')
                AND job_runs.attempt_count >= 1
                AND job_runs.lease_owner IS NOT NULL
                AND length(trim(job_runs.lease_owner)) > 0
                AND job_runs.lease_token IS NOT NULL
                AND length(trim(job_runs.lease_token)) > 0
                AND job_runs.lease_expires_at_ms > NEW.created_at_ms
                AND job_runs.updated_at_ms >=
                  job_runs.scheduled_for_ms
                AND job_runs.updated_at_ms <= NEW.created_at_ms
                AND job_runs.completed_at_ms IS NULL
                AND job_runs.result_json IS NULL
                AND job_runs.last_error_code IS NULL
                AND job_runs.next_attempt_at_ms IS NULL
                AND (
                  (
                    job_runs.status = 'leased'
                    AND job_runs.started_at_ms IS NULL
                  )
                  OR (
                    job_runs.status = 'running'
                    AND job_runs.started_at_ms IS NOT NULL
                    AND job_runs.started_at_ms <= NEW.created_at_ms
                  )
                )
            )
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'allocation must begin as uncommitted per-player work'
  ) END;
END`;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function createRuntime(t, prefix) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    root,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
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
  return {
    ...connection,
    migrationsDirectory,
  };
}

function copyMigrations(
  runtime,
  minimumId,
  maximumId
) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (
      migration.id < minimumId ||
      migration.id > maximumId
    ) {
      continue;
    }
    fs.copyFileSync(
      migration.filePath,
      path.join(
        runtime.migrationsDirectory,
        migration.fileName
      )
    );
  }
}

function migrate(runtime, buildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory:
        runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  try {
    return database.prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns
          .map((column) => `@${column}`)
          .join(", ")}
      )
    `).run(values);
  } catch (error) {
    throw new Error(
      `Could not insert ${tableName}: ${error.message}`,
      { cause: error }
    );
  }
}

function captureAndDropTriggers(database) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  for (const { name } of triggers) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const { sql } of triggers) {
    database.exec(sql);
  }
}

function dropTableTriggers(database, tableName) {
  const triggers = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = ?
  `).all(tableName);
  for (const { name } of triggers) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
}

function applicationRows(database) {
  const result = {};
  for (const { name } of database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT IN (
        'application_metadata',
        'schema_migrations'
      )
    ORDER BY name
  `).all()) {
    result[name] = database.prepare(
      `SELECT * FROM "${name.replaceAll('"', '""')}"`
    ).all();
  }
  return result;
}

function schemaObjects(database) {
  return database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}

function triggerSql(database) {
  return database.prepare(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'free_agent_draft_allocations_pending_insert'
  `).get()?.sql;
}

function assertConstraint(callback) {
  assert.throws(callback, (error) => {
    const sqliteError = error?.cause || error;
    assert.ok(
      sqliteError?.code?.startsWith(
        "SQLITE_CONSTRAINT"
      ),
      error?.stack
    );
    assert.match(
      error.message,
      /uncommitted per-player work/
    );
    return true;
  });
}

function assertHealthy(database) {
  assert.equal(
    database.pragma("integrity_check", {
      simple: true,
    }),
    "ok"
  );
  assert.deepEqual(
    database.pragma("foreign_key_check"),
    []
  );
}

function fixtureIds(base = 37_000) {
  return Object.freeze({
    user: uuid(base),
    league: uuid(base + 1),
    membership: uuid(base + 2),
    season: uuid(base + 3),
    team: uuid(base + 4),
    assignment: uuid(base + 5),
    week: uuid(base + 6),
    readiness: uuid(base + 7),
    fad: uuid(base + 8),
    participant: uuid(base + 9),
    card: uuid(base + 10),
    entry: uuid(base + 11),
    snapshot: uuid(base + 12),
    snapshotEntry: uuid(base + 13),
    player: uuid(base + 14),
    otherPlayer: uuid(base + 15),
    job: uuid(base + 16),
    allocation: uuid(base + 17),
    otherAllocation: uuid(base + 18),
    missingFad: uuid(base + 19),
  });
}

function deadlineJob(ids, overrides = {}) {
  return {
    id: ids.job,
    league_id: ids.league,
    season_id: ids.season,
    job_type: "fad_deadline",
    occurrence_key:
      `fad:${ids.fad}:deadline:${DEADLINE_AT_MS}`,
    scheduled_for_ms: DEADLINE_AT_MS,
    status: "running",
    attempt_count: 1,
    lease_owner: "fad-deadline-worker",
    lease_expires_at_ms:
      ROW_AT_MS + 60_000,
    started_at_ms: DEADLINE_AT_MS,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 2,
    lease_token: "fad-deadline-token",
    next_attempt_at_ms: null,
    ...overrides,
  };
}

function allocationRecord(
  ids,
  overrides = {}
) {
  return {
    id: ids.allocation,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    status: "pending",
    decision_code: null,
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: null,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: null,
    restricted_minimum_term_years: null,
    restricted_minimum_aav_cents: null,
    accounted_at_ms: null,
    last_error_code: null,
    created_at_ms: ROW_AT_MS,
    updated_at_ms: ROW_AT_MS,
    version: 1,
    ...overrides,
  };
}

function seedDeadlineFixture(
  database,
  {
    base = 37_000,
    includeJob = true,
    jobOverrides,
    rootStatus = "cards_open",
  } = {}
) {
  const ids = fixtureIds(base);
  const triggers = captureAndDropTriggers(database);
  insert(database, "users", {
    id: ids.user,
    email_normalized:
      `deadline-${base}@example.test`,
    email_display:
      `deadline-${base}@example.test`,
    display_name: `Deadline Manager ${base}`,
    display_name_normalized:
      `deadline manager ${base}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `Deadline League ${base}`,
    name_normalized: `deadline league ${base}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: ids.membership,
    league_id: ids.league,
    user_id: ids.user,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: WEEK_ONE_AT_MS,
    regular_season_ends_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 17 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `Deadline Team ${base}`,
    name_normalized: `deadline team ${base}`,
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    tertiary_colour: null,
    logo_reference: null,
    pattern_template: "even-two",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "team_manager_assignments", {
    id: ids.assignment,
    league_id: ids.league,
    team_id: ids.team,
    user_id: ids.user,
    membership_id: ids.membership,
    assigned_by_user_id: ids.user,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: 1,
    accepted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
    week_key: "2026-W01",
    sequence: 1,
    starts_at_ms: WEEK_ONE_AT_MS,
    baseline_at_ms: WEEK_ONE_AT_MS + 1_000,
    locks_at_ms: WEEK_ONE_AT_MS + 2_000,
    ends_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms:
      WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(
    database,
    "free_agent_draft_readiness_operations",
    {
      id: ids.readiness,
      league_id: ids.league,
      season_id: ids.season,
      readiness_occurrence_key:
        `fad-readiness:${ids.league}:${ids.season}`,
      trigger_kind: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      job_run_id: null,
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
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    }
  );
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key:
      `fad-readiness:${ids.league}:${ids.season}`,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id:
      ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: rootStatus,
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Inaugural fixture.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms:
      DEADLINE_AT_MS - 2 * DAY_MS,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms:
      rootStatus === "cards_open"
        ? null
        : DEADLINE_AT_MS,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms:
      rootStatus === "cards_open"
        ? OPENED_AT_MS
        : DEADLINE_AT_MS,
    version:
      rootStatus === "cards_open" ? 1 : 2,
  });
  insert(database, "free_agent_draft_teams", {
    id: ids.participant,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  });
  insert(database, "players", {
    id: ids.player,
    first_name: "Deadline",
    last_name: "Candidate",
    full_name: "Deadline Candidate",
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "players", {
    id: ids.otherPlayer,
    first_name: "Missing",
    last_name: "Snapshot",
    full_name: "Missing Snapshot",
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "candidate_cards", {
    id: ids.card,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    status: "locked_incomplete",
    completeness_code: "incomplete",
    filled_mandatory_count: 1,
    missing_mandatory_count: 17,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    carried_roster_structural_conflict_count: 0,
    maximum_possible_cap_cents: 600,
    locked_at_ms: DEADLINE_AT_MS,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 2,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
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
    created_by_user_id: ids.user,
    created_by_membership_id: ids.membership,
    created_by_authority: "manager",
    last_edited_by_user_id: ids.user,
    last_edited_by_membership_id: ids.membership,
    last_edited_by_authority: "manager",
    created_at_ms: OPENED_AT_MS + 1,
    updated_at_ms: OPENED_AT_MS + 1,
    version: 1,
  });
  insert(database, "candidate_card_snapshots", {
    id: ids.snapshot,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    locked_card_version: 2,
    locked_status: "locked_incomplete",
    completeness_code: "incomplete",
    filled_mandatory_count: 1,
    missing_mandatory_count: 17,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    carried_roster_structural_conflict_count: 0,
    cap_limit_cents: 10_000,
    carried_active_player_amount_cents: 0,
    retention_obligation_cents: 0,
    buyout_penalty_cents: 0,
    carried_cap_usage_cents: 0,
    proposed_candidate_aav_cents: 600,
    maximum_possible_cap_cents: 600,
    maximum_cap_space_cents: 9_400,
    effective_deadline_at_ms: DEADLINE_AT_MS,
    processed_at_ms: DEADLINE_AT_MS,
    created_at_ms: DEADLINE_AT_MS,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  insert(
    database,
    "candidate_card_snapshot_entries",
    {
      id: ids.snapshotEntry,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      snapshot_id: ids.snapshot,
      card_id: ids.card,
      team_id: ids.team,
      row_kind: "slot",
      occupant_kind: "candidate",
      slot_group: "F",
      slot_number: 1,
      source_entry_id: ids.entry,
      source_entry_version: 1,
      player_id: ids.player,
      effective_position_group: "F",
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
      last_edited_by_user_id: ids.user,
      last_edited_by_membership_id: ids.membership,
      last_edited_by_authority: "manager",
      last_edited_at_ms: OPENED_AT_MS + 1,
      created_at_ms: DEADLINE_AT_MS,
      allocation_eligibility: "eligible",
      allocation_exclusion_reason: null,
    }
  );
  if (includeJob) {
    insert(
      database,
      "job_runs",
      deadlineJob(ids, jobOverrides)
    );
  }
  restoreTriggers(database, triggers);
  return ids;
}

function replaceDeadlineJob(
  database,
  ids,
  overrides = {}
) {
  database.prepare(`
    DELETE FROM job_runs
    WHERE league_id = ? AND id = ?
  `).run(ids.league, ids.job);
  insert(
    database,
    "job_runs",
    deadlineJob(ids, overrides)
  );
}

describe(
  "FAD atomic deadline allocation insert migration",
  () => {
    test(
      "upgrades exact schema 36 and fresh schema 1 through 37 without changing prior hashes, rows, or inventory",
      (t) => {
        const canonical = discoverMigrations({
          migrationsDirectory:
            CANONICAL_MIGRATIONS,
        });
        const migration37 = canonical.find(
          ({ id }) => id === 37
        );
        assert.equal(
          migration37?.fileName,
          "0037_allow_atomic_fad_deadline_allocations.sql"
        );

        const upgrade = createRuntime(
          t,
          "hundo-fad-deadline-allocation-37-upgrade-"
        );
        copyMigrations(upgrade, 1, 36);
        migrate(upgrade, "fad-deadline-37-before");
        insert(upgrade.database, "users", {
          id: uuid(37_900),
          email_normalized:
            "migration-37@example.test",
          email_display:
            "migration-37@example.test",
          display_name: "Migration 37 Sentinel",
          display_name_normalized:
            "migration 37 sentinel",
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
        const ledgerBefore = upgrade.database
          .prepare(`
            SELECT migration_id, file_name, checksum
            FROM schema_migrations
            ORDER BY migration_id
          `)
          .all();
        const rowsBefore = applicationRows(
          upgrade.database
        );
        const schemaBefore = schemaObjects(
          upgrade.database
        );

        copyMigrations(upgrade, 37, 37);
        const upgraded = migrate(
          upgrade,
          "fad-deadline-37-after"
        );
        assert.equal(upgraded.status, "exact");
        assert.equal(
          upgrade.database.pragma("user_version", {
            simple: true,
          }),
          37
        );
        assert.deepEqual(
          upgrade.database.prepare(`
            SELECT metadata_value AS metadataValue,
                   updated_at_ms AS updatedAtMs
            FROM application_metadata
            WHERE metadata_key = 'data_model_version'
          `).get(),
          {
            metadataValue: "37",
            updatedAtMs: 37,
          }
        );
        assert.deepEqual(
          applicationRows(upgrade.database),
          rowsBefore
        );
        const ledgerAfter = upgrade.database
          .prepare(`
            SELECT migration_id, file_name, checksum
            FROM schema_migrations
            ORDER BY migration_id
          `)
          .all();
        assert.deepEqual(
          ledgerAfter.slice(0, 36),
          ledgerBefore
        );
        assert.deepEqual(ledgerAfter[36], {
          migration_id: 37,
          file_name: migration37.fileName,
          checksum: migration37.checksum,
        });
        const schemaAfter = schemaObjects(
          upgrade.database
        );
        assert.equal(
          schemaAfter.length,
          schemaBefore.length
        );
        const schemaAfterByName = new Map(
          schemaAfter.map((row) => [
            `${row.type}:${row.name}`,
            row,
          ])
        );
        for (const row of schemaBefore) {
          const after = schemaAfterByName.get(
            `${row.type}:${row.name}`
          );
          assert.ok(after, row.name);
          if (
            row.name ===
            "free_agent_draft_allocations_pending_insert"
          ) {
            assert.equal(after.type, row.type);
            assert.equal(after.name, row.name);
            assert.equal(
              after.tableName,
              row.tableName
            );
            assert.notEqual(after.sql, row.sql);
          } else {
            assert.deepEqual(after, row);
          }
        }
        assert.equal(
          triggerSql(upgrade.database),
          EXPECTED_TRIGGER_SQL
        );
        assertHealthy(upgrade.database);

        const fresh = createRuntime(
          t,
          "hundo-fad-deadline-allocation-37-fresh-"
        );
        copyMigrations(fresh, 1, 37);
        const freshResult = migrate(
          fresh,
          "fad-deadline-37-fresh"
        );
        assert.equal(freshResult.status, "exact");
        assert.equal(
          fresh.database.pragma("user_version", {
            simple: true,
          }),
          37
        );
        assert.equal(
          fresh.database.prepare(`
            SELECT COUNT(*) AS count
            FROM schema_migrations
          `).get().count,
          37
        );
        assert.deepEqual(
          schemaObjects(fresh.database).map(
            ({ type, name, tableName }) => ({
              type,
              name,
              tableName,
            })
          ),
          schemaAfter.map(
            ({ type, name, tableName }) => ({
              type,
              name,
              tableName,
            })
          )
        );
        assert.equal(
          triggerSql(fresh.database),
          EXPECTED_TRIGGER_SQL
        );
        assertHealthy(fresh.database);
      }
    );

    test(
      "permits only a same-scope snapshotted candidate under the exact due live deadline lease while cards remain open",
      (t) => {
        const runtime = createRuntime(
          t,
          "hundo-fad-deadline-allocation-37-lease-"
        );
        copyMigrations(runtime, 1, 37);
        migrate(runtime, "fad-deadline-37-lease");
        const ids = seedDeadlineFixture(
          runtime.database
        );
        dropTableTriggers(
          runtime.database,
          "job_runs"
        );
        let allocationSequence = 38_000;
        const attempt = (overrides = {}) =>
          insert(
            runtime.database,
            "free_agent_draft_player_allocations",
            allocationRecord(ids, {
              id: uuid(allocationSequence++),
              ...overrides,
            })
          );

        replaceDeadlineJob(runtime.database, ids, {
          job_type: "fad_completion",
        });
        assertConstraint(attempt);

        replaceDeadlineJob(runtime.database, ids, {
          status: "pending",
        });
        assertConstraint(attempt);

        replaceDeadlineJob(runtime.database, ids, {
          occurrence_key:
            `fad:${ids.fad}:deadline:wrong`,
        });
        assertConstraint(attempt);

        replaceDeadlineJob(runtime.database, ids, {
          scheduled_for_ms: DEADLINE_AT_MS + 1,
        });
        assertConstraint(attempt);

        replaceDeadlineJob(runtime.database, ids, {
          updated_at_ms: ROW_AT_MS + 1,
        });
        assertConstraint(attempt);

        replaceDeadlineJob(runtime.database, ids, {
          lease_expires_at_ms: ROW_AT_MS,
        });
        assertConstraint(attempt);

        replaceDeadlineJob(runtime.database, ids);
        assertConstraint(() =>
          attempt({
            player_id: ids.otherPlayer,
          })
        );
        assertConstraint(() =>
          attempt({
            fad_id: ids.missingFad,
          })
        );
        assertConstraint(() =>
          attempt({
            created_at_ms: DEADLINE_AT_MS - 1,
            updated_at_ms: DEADLINE_AT_MS - 1,
          })
        );
        assertConstraint(() =>
          attempt({
            decision_code: "no_valid_offer",
          })
        );
        assertConstraint(() =>
          attempt({ version: 2 })
        );

        const inserted = attempt();
        assert.equal(inserted.changes, 1);
        assert.deepEqual(
          runtime.database.prepare(`
            SELECT fad_id AS fadId,
                   player_id AS playerId,
                   status,
                   version
            FROM free_agent_draft_player_allocations
          `).get(),
          {
            fadId: ids.fad,
            playerId: ids.player,
            status: "pending",
            version: 1,
          }
        );
        assertHealthy(runtime.database);
      }
    );

    test(
      "accepts the canonical leased deadline state and preserves the established post-lock insertion branch",
      (t) => {
        const leased = createRuntime(
          t,
          "hundo-fad-deadline-allocation-37-leased-"
        );
        copyMigrations(leased, 1, 37);
        migrate(leased, "fad-deadline-37-leased");
        const leasedIds = seedDeadlineFixture(
          leased.database,
          {
            base: 37_100,
            jobOverrides: {
              status: "leased",
              started_at_ms: null,
            },
          }
        );
        assert.equal(
          insert(
            leased.database,
            "free_agent_draft_player_allocations",
            allocationRecord(leasedIds)
          ).changes,
          1
        );
        assertHealthy(leased.database);

        const locked = createRuntime(
          t,
          "hundo-fad-deadline-allocation-37-locked-"
        );
        copyMigrations(locked, 1, 37);
        migrate(locked, "fad-deadline-37-locked");
        const lockedIds = seedDeadlineFixture(
          locked.database,
          {
            base: 37_200,
            includeJob: false,
            rootStatus: "deadline_locked",
          }
        );
        assert.equal(
          insert(
            locked.database,
            "free_agent_draft_player_allocations",
            allocationRecord(lockedIds, {
              created_at_ms: DEADLINE_AT_MS - 1,
              updated_at_ms: DEADLINE_AT_MS - 1,
            })
          ).changes,
          1
        );
        assertHealthy(locked.database);
      }
    );
  }
);
