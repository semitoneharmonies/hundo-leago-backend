const assert = require("node:assert/strict");
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

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const CANONICAL_MIGRATIONS = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const FIRST_MATCHUP_STARTS_AT_MS = 2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 604_800_000;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 172_800_000;
const OPENED_AT_MS = HELP_OPENS_AT_MS - 1_000;
const NEW_TABLES = Object.freeze([
  "candidate_card_entries",
  "candidate_card_help_requests",
  "candidate_card_revisions",
  "candidate_card_snapshot_entries",
  "candidate_card_snapshots",
  "candidate_cards",
  "free_agent_draft_teams",
  "free_agent_drafts",
]);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

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

function copyMigrationsThrough(runtime, maximumId) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (migration.id > maximumId) continue;
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
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function seedScenario(runtime, {
  base,
  includePriorSeason = true,
  includeEntryDraft = true,
  targetSeasonKey = `${base}2026`,
} = {}) {
  const ids = {
    commissionerUser: uuid(base + 1),
    managerUser: uuid(base + 2),
    platformRole: uuid(base + 3),
    league: uuid(base + 4),
    commissionerMembership: uuid(base + 5),
    managerMembership: uuid(base + 6),
    sourceSeason: includePriorSeason
      ? uuid(base + 7)
      : null,
    targetSeason: uuid(base + 8),
    team: uuid(base + 9),
    managerAssignment: uuid(base + 10),
    week: uuid(base + 11),
    entryDraft: includeEntryDraft
      ? uuid(base + 12)
      : null,
    rollover: includePriorSeason
      ? uuid(base + 13)
      : null,
  };
  const database = runtime.database;

  for (const [kind, id] of [
    ["commissioner", ids.commissionerUser],
    ["manager", ids.managerUser],
  ]) {
    insert(database, "users", {
      id,
      email_normalized: `${kind}-${base}@example.test`,
      email_display: `${kind}-${base}@example.test`,
      display_name: `${kind} ${base}`,
      display_name_normalized: `${kind} ${base}`,
      status: "active",
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
  }

  insert(database, "platform_roles", {
    id: ids.platformRole,
    user_id: ids.commissionerUser,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: 10,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `League ${base}`,
    name_normalized: `league ${base}`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  for (const [id, userId, permission] of [
    [
      ids.commissionerMembership,
      ids.commissionerUser,
      "commissioner",
    ],
    [ids.managerMembership, ids.managerUser, "manager"],
  ]) {
    insert(database, "league_memberships", {
      id,
      league_id: ids.league,
      user_id: userId,
      permission_category: permission,
      status: "active",
      joined_at_ms: 10,
      ended_at_ms: null,
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
  }
  insert(database, "league_settings", {
    league_id: ids.league,
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
  if (includePriorSeason) {
    insert(database, "seasons", {
      id: ids.sourceSeason,
      league_id: ids.league,
      label: `Prior ${base}`,
      nhl_season_key: `${base}2025`,
      status: "completed",
      regular_season_starts_at_ms: 100,
      regular_season_ends_at_ms: 200,
      fantasy_playoffs_start_at_ms: 170,
      fantasy_playoffs_end_at_ms: 200,
      created_at_ms: 10,
      updated_at_ms: 20,
      version: 2,
    });
  }
  insert(database, "seasons", {
    id: ids.targetSeason,
    league_id: ids.league,
    label: `Target ${base}`,
    nhl_season_key: targetSeasonKey,
    status: "active",
    regular_season_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    regular_season_ends_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    fantasy_playoffs_start_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 8_000,
    fantasy_playoffs_end_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    created_at_ms: 20,
    updated_at_ms: 30,
    version: 2,
  });
  database
    .prepare(`
      UPDATE leagues
      SET status = 'active',
          commissioner_membership_id = ?,
          current_season_id = ?,
          updated_at_ms = 30,
          version = 2
      WHERE id = ?
    `)
    .run(
      ids.commissionerMembership,
      ids.targetSeason,
      ids.league
    );
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `Team ${base}`,
    name_normalized: `team ${base}`,
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
    assigned_by_user_id: ids.commissionerUser,
    status: "accepted",
    assigned_at_ms: 20,
    accepted_at_ms: 20,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.targetSeason,
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
  if (includeEntryDraft) {
    insert(database, "entry_drafts", {
      id: ids.entryDraft,
      league_id: ids.league,
      season_id: ids.targetSeason,
      status: "completed",
      rounds: 4,
      pick_clock_seconds: 300,
      starts_at_ms: OPENED_AT_MS - 2_000,
      completed_at_ms: OPENED_AT_MS - 1_000,
      created_by_user_id: ids.commissionerUser,
      created_at_ms: OPENED_AT_MS - 2_000,
      updated_at_ms: OPENED_AT_MS - 1_000,
      version: 2,
    });
  }
  if (includePriorSeason) {
    insert(database, "season_rollovers", {
      id: ids.rollover,
      league_id: ids.league,
      from_season_id: ids.sourceSeason,
      to_season_id: ids.targetSeason,
      status: "succeeded",
      authorized_by_user_id: ids.commissionerUser,
      authorized_by_membership_id:
        ids.commissionerMembership,
      authorized_authority: "commissioner",
      league_version_before: 1,
      league_version_after: 2,
      from_season_version_before: 1,
      from_season_version_after: 2,
      to_season_version_before: 1,
      to_season_version_after: 2,
      target_season_created: 0,
      completed_at_ms: OPENED_AT_MS - 1_000,
      contracts_advanced: 0,
      contracts_expired: 0,
      ownerships_carried: 0,
      ownerships_released: 0,
      retention_years_advanced: 0,
      retention_obligations_completed: 0,
      buyout_years_advanced: 0,
      buyout_obligations_completed: 0,
      trades_cancelled: 0,
      created_at_ms: OPENED_AT_MS - 1_000,
      version: 1,
    });
  }

  return ids;
}

function fadRecord(ids, overrides = {}) {
  return {
    id: uuid(Number(ids.league.slice(-12)) + 100),
    league_id: ids.league,
    season_id: ids.targetSeason,
    first_matchup_week_id: ids.week,
    participating_team_count: 1,
    status: "cards_open",
    setup_path: "completed_entry_draft",
    entry_draft_id: ids.entryDraft,
    setup_exemption_id: null,
    prior_season_rollover_id: ids.rollover,
    no_draft_reason: null,
    opened_by_user_id: ids.commissionerUser,
    opened_by_membership_id: ids.commissionerMembership,
    opened_authority: "commissioner",
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
    ...overrides,
  };
}

function participantRecord(ids, fadId, overrides = {}) {
  return {
    id: uuid(Number(ids.league.slice(-12)) + 101),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
    ...overrides,
  };
}

function cardRecord(ids, fadId, overrides = {}) {
  return {
    id: uuid(Number(ids.league.slice(-12)) + 102),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    team_id: ids.team,
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
    ...overrides,
  };
}

function revisionRecord(ids, fadId, cardId, overrides = {}) {
  return {
    id: uuid(Number(ids.league.slice(-12)) + 103),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    card_id: cardId,
    team_id: ids.team,
    resulting_card_version: 1,
    action: "card_opened",
    affected_entry_id: null,
    player_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    before_evidence_json: "{}",
    after_evidence_json: '{"slots":[]}',
    potential_illegality_acknowledged: 0,
    warning_codes_json: "[]",
    occurred_at_ms: OPENED_AT_MS,
    created_at_ms: OPENED_AT_MS,
    ...overrides,
  };
}

function setupOpenCard(database, ids) {
  const fad = fadRecord(ids);
  const participant = participantRecord(ids, fad.id);
  const card = cardRecord(ids, fad.id);
  const revision = revisionRecord(ids, fad.id, card.id);
  insert(database, "free_agent_drafts", fad);
  insert(database, "free_agent_draft_teams", participant);
  insert(database, "candidate_cards", card);
  insert(database, "candidate_card_revisions", revision);
  return { fad, participant, card, revision };
}

function seedPlayer(database, id, positionGroup) {
  insert(database, "players", {
    id,
    first_name: `Player ${id.slice(-3)}`,
    last_name: positionGroup,
    full_name: `Player ${id.slice(-3)} ${positionGroup}`,
    birth_date: null,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function candidateEntryRecord(
  ids,
  fadId,
  cardId,
  playerId,
  overrides = {}
) {
  return {
    id: uuid(Number(playerId.slice(-12)) + 1_000),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    card_id: cardId,
    team_id: ids.team,
    entry_kind: "candidate",
    player_id: playerId,
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
    proposed_total_value_cents: 700,
    proposed_term_years: 3,
    proposed_aav_cents: 233,
    eligibility_status: "valid",
    validation_code: null,
    last_acknowledgement_revision_id: null,
    created_by_user_id: ids.managerUser,
    created_by_membership_id: ids.managerMembership,
    created_by_authority: "manager",
    last_edited_by_user_id: ids.managerUser,
    last_edited_by_membership_id: ids.managerMembership,
    last_edited_by_authority: "manager",
    created_at_ms: OPENED_AT_MS + 10,
    updated_at_ms: OPENED_AT_MS + 10,
    version: 1,
    ...overrides,
  };
}

function carryoverEntryRecord(
  ids,
  fadId,
  cardId,
  playerId,
  ownershipId,
  contractId,
  overrides = {}
) {
  return {
    ...candidateEntryRecord(
      ids,
      fadId,
      cardId,
      playerId
    ),
    id: uuid(Number(playerId.slice(-12)) + 2_000),
    entry_kind: "carryover",
    requested_slot_number: 1,
    carryover_ownership_id: ownershipId,
    carryover_contract_id: contractId,
    source_roster_category: "Active",
    carryover_original_total_value_cents: 600,
    carryover_original_term_years: 3,
    carryover_aav_cents: 200,
    remaining_years: 1,
    proposed_total_value_cents: null,
    proposed_term_years: null,
    proposed_aav_cents: null,
    eligibility_status: null,
    validation_code: null,
    created_by_user_id: null,
    created_by_membership_id: null,
    created_by_authority: "system",
    last_edited_by_user_id: null,
    last_edited_by_membership_id: null,
    last_edited_by_authority: "system",
    ...overrides,
  };
}

function helpRecord(ids, fadId, cardId, overrides = {}) {
  return {
    id: uuid(Number(ids.league.slice(-12)) + 104),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    card_id: cardId,
    team_id: ids.team,
    status: "active",
    message: "Please help me finish this card.",
    requested_by_user_id: ids.managerUser,
    requested_by_membership_id: ids.managerMembership,
    requested_at_ms: HELP_OPENS_AT_MS,
    expires_at_ms: CANDIDATE_DEADLINE_AT_MS,
    created_at_ms: HELP_OPENS_AT_MS,
    updated_at_ms: HELP_OPENS_AT_MS,
    version: 1,
    ...overrides,
  };
}

function snapshotRecord(
  ids,
  fadId,
  cardId,
  cardVersion,
  overrides = {}
) {
  return {
    id: uuid(Number(ids.league.slice(-12)) + 105),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    card_id: cardId,
    team_id: ids.team,
    locked_card_version: cardVersion,
    locked_status: "locked_incomplete",
    completeness_code: "incomplete",
    filled_mandatory_count: 1,
    missing_mandatory_count: 17,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    cap_limit_cents: 10_000,
    carried_active_player_amount_cents: 0,
    retention_obligation_cents: 0,
    buyout_penalty_cents: 0,
    carried_cap_usage_cents: 0,
    proposed_candidate_aav_cents: 233,
    maximum_possible_cap_cents: 233,
    maximum_cap_space_cents: 9_767,
    effective_deadline_at_ms: CANDIDATE_DEADLINE_AT_MS,
    processed_at_ms: CANDIDATE_DEADLINE_AT_MS + 10,
    created_at_ms: CANDIDATE_DEADLINE_AT_MS + 10,
    ...overrides,
  };
}

function emptySnapshotEntry(
  ids,
  fadId,
  cardId,
  snapshotId,
  slotGroup,
  slotNumber,
  sequence
) {
  return {
    id: uuid(Number(ids.league.slice(-12)) + 200 + sequence),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    snapshot_id: snapshotId,
    card_id: cardId,
    team_id: ids.team,
    row_kind: "slot",
    occupant_kind: "empty",
    slot_group: slotGroup,
    slot_number: slotNumber,
    source_entry_id: null,
    source_entry_version: null,
    player_id: null,
    effective_position_group: null,
    conflict_code: null,
    carryover_ownership_id: null,
    carryover_contract_id: null,
    source_roster_category: null,
    carryover_original_total_value_cents: null,
    carryover_original_term_years: null,
    carryover_aav_cents: null,
    remaining_years: null,
    proposed_total_value_cents: null,
    proposed_term_years: null,
    proposed_aav_cents: null,
    eligibility_status: null,
    validation_code: null,
    last_edited_by_user_id: null,
    last_edited_by_membership_id: null,
    last_edited_by_authority: null,
    last_edited_at_ms: null,
    created_at_ms: CANDIDATE_DEADLINE_AT_MS + 10,
  };
}

function candidateSnapshotEntry(
  ids,
  fadId,
  cardId,
  snapshotId,
  entry,
  overrides = {}
) {
  return {
    ...emptySnapshotEntry(
      ids,
      fadId,
      cardId,
      snapshotId,
      "F",
      1,
      1
    ),
    occupant_kind: "candidate",
    source_entry_id: entry.id,
    source_entry_version: entry.version,
    player_id: entry.player_id,
    effective_position_group: entry.effective_position_group,
    proposed_total_value_cents:
      entry.proposed_total_value_cents,
    proposed_term_years: entry.proposed_term_years,
    proposed_aav_cents: entry.proposed_aav_cents,
    eligibility_status: entry.eligibility_status,
    validation_code: entry.validation_code,
    last_edited_by_user_id: entry.last_edited_by_user_id,
    last_edited_by_membership_id:
      entry.last_edited_by_membership_id,
    last_edited_by_authority:
      entry.last_edited_by_authority,
    last_edited_at_ms: entry.updated_at_ms,
    ...overrides,
  };
}

function insertMigrationReport(database, ids, reportId) {
  insert(database, "migration_reports", {
    id: reportId,
    league_id: ids.league,
    source_bundle_id: `bundle-${ids.league}`,
    reset_manifest_id: "2026-season-1-reset-v1",
    database_schema_version: 23,
    status: "succeeded",
    source_hashes_json: '{"source":"abc"}',
    counts_json: '{"teams":1}',
    totals_json: '{"salaryCapCents":10000}',
    warnings_json: "[]",
    rejects_json: "[]",
    started_at_ms: OPENED_AT_MS - 3_000,
    completed_at_ms: OPENED_AT_MS - 2_000,
    created_at_ms: OPENED_AT_MS - 3_000,
  });
}

function insertExemption(database, ids, {
  id,
  reportId,
  reason = "The Entry Draft is unavailable for this transition.",
} = {}) {
  insert(database, "free_agent_draft_setup_exemptions", {
    id,
    league_id: ids.league,
    season_id: ids.targetSeason,
    exemption_kind: "initial_season2_transition",
    migration_report_id: reportId,
    reason,
    authorized_by_user_id: ids.commissionerUser,
    authorized_by_membership_id:
      ids.commissionerMembership,
    authorized_authority:
      "platform_administrator_as_commissioner",
    authorized_at_ms: OPENED_AT_MS - 2_000,
    consumed_fad_id: null,
    consumed_at_ms: null,
    created_at_ms: OPENED_AT_MS - 2_000,
    updated_at_ms: OPENED_AT_MS - 2_000,
    version: 1,
  });
}

function readSeedRows(database) {
  const tableNames = [
    "entry_drafts",
    "free_agent_draft_setup_exemptions",
    "league_memberships",
    "league_settings",
    "leagues",
    "matchup_weeks",
    "migration_reports",
    "platform_roles",
    "season_rollovers",
    "seasons",
    "team_manager_assignments",
    "teams",
    "users",
  ];
  return Object.fromEntries(
    tableNames.map((tableName) => [
      tableName,
      database
        .prepare(`SELECT * FROM ${tableName} ORDER BY 1`)
        .all(),
    ])
  );
}

describe("FAD-01.2 Candidate Card storage migration", () => {
  test("installs fresh and upgrades populated schema 23 without fabricated FAD history", (t) => {
    const fresh = createRuntime(t, "hundo-fad-0024-fresh-");
    copyMigrationsThrough(fresh, 24);
    const freshResult = migrate(fresh, "fad-0024-fresh");

    assert.equal(freshResult.status, "exact");
    assert.equal(freshResult.applied.length, 24);
    assert.equal(
      fresh.database.pragma("user_version", { simple: true }),
      24
    );
    assert.equal(
      fresh.database
        .prepare(`
          SELECT metadata_value
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "24"
    );
    assert.deepEqual(
      fresh.database
        .prepare(`
          SELECT migration_id, file_name
          FROM schema_migrations
          ORDER BY migration_id DESC
          LIMIT 1
        `)
        .get(),
      {
        migration_id: 24,
        file_name:
          "0024_add_free_agent_draft_candidate_cards.sql",
      }
    );
    for (const tableName of NEW_TABLES) {
      assert.equal(
        fresh.database
          .pragma("table_list")
          .find(({ name }) => name === tableName)?.strict,
        1
      );
      assert.equal(
        fresh.database
          .prepare(
            `SELECT COUNT(*) AS count FROM ${tableName}`
          )
          .get().count,
        0
      );
    }

    const upgrade = createRuntime(
      t,
      "hundo-fad-0024-upgrade-"
    );
    copyMigrationsThrough(upgrade, 23);
    migrate(upgrade, "fad-0024-before");
    const ids = seedScenario(upgrade, { base: 1_000 });
    upgrade.database
      .prepare(`
        UPDATE seasons
        SET free_agent_draft_completed_at_ms = 123
        WHERE id = ?
      `)
      .run(ids.targetSeason);
    const reportId = uuid(1_080);
    const exemptionId = uuid(1_081);
    insertMigrationReport(upgrade.database, ids, reportId);
    insertExemption(upgrade.database, ids, {
      id: exemptionId,
      reportId,
    });
    const before = readSeedRows(upgrade.database);

    copyMigrationsThrough(upgrade, 24);
    migrate(upgrade, "fad-0024-upgrade");

    assert.equal(
      upgrade.database.pragma("user_version", {
        simple: true,
      }),
      24
    );
    assert.deepEqual(readSeedRows(upgrade.database), before);
    for (const tableName of NEW_TABLES) {
      assert.equal(
        upgrade.database
          .prepare(
            `SELECT COUNT(*) AS count FROM ${tableName}`
          )
          .get().count,
        0
      );
    }
    assert.deepEqual(
      upgrade.database
        .prepare(`
          SELECT consumed_fad_id, consumed_at_ms, version
          FROM free_agent_draft_setup_exemptions
          WHERE id = ?
        `)
        .get(exemptionId),
      {
        consumed_fad_id: null,
        consumed_at_ms: null,
        version: 1,
      }
    );
    assert.equal(
      upgrade.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      upgrade.database.pragma("foreign_key_check"),
      []
    );
  });

  test("enforces setup clocks, evidence paths, authority, and one exemption bridge", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0024-setup-");
    copyMigrationsThrough(runtime, 24);
    migrate(runtime, "fad-0024-setup");
    const ids = seedScenario(runtime, { base: 2_000 });
    const otherIds = seedScenario(runtime, { base: 2_500 });

    runtime.database
      .prepare(
        "UPDATE entry_drafts SET status = 'active' WHERE id = ?"
      )
      .run(ids.entryDraft);
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "free_agent_drafts",
          fadRecord(ids)
        );
      },
      /completed target-season Entry Draft/i
    );
    runtime.database
      .prepare(
        "UPDATE entry_drafts SET status = 'completed' WHERE id = ?"
      )
      .run(ids.entryDraft);

    for (const overrides of [
      {
        candidate_deadline_at_ms:
          CANDIDATE_DEADLINE_AT_MS + 1,
      },
      {
        help_opens_at_ms: HELP_OPENS_AT_MS + 1,
      },
      {
        first_matchup_starts_at_ms:
          FIRST_MATCHUP_STARTS_AT_MS + 1,
      },
      {
        entry_draft_id: null,
      },
      {
        entry_draft_id: otherIds.entryDraft,
      },
      {
        first_matchup_week_id: otherIds.week,
      },
      {
        prior_season_rollover_id: null,
      },
      {
        opened_authority: "platform_administrator_as_commissioner",
        opened_by_user_id: ids.managerUser,
        opened_by_membership_id: ids.managerMembership,
      },
    ]) {
      assertConstraint(() => {
        insert(
          runtime.database,
          "free_agent_drafts",
          fadRecord(ids, overrides)
        );
      });
    }

    const valid = fadRecord(ids);
    insert(runtime.database, "free_agent_drafts", valid);
    assert.equal(
      runtime.database
        .prepare(`
          UPDATE matchup_weeks
          SET starts_at_ms = starts_at_ms
          WHERE id = ?
        `)
        .run(ids.week).changes,
      1
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE matchup_weeks
            SET starts_at_ms = starts_at_ms + 1
            WHERE id = ?
          `)
          .run(ids.week);
      },
      /clock is frozen/i
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_drafts
            SET candidate_deadline_at_ms =
                  candidate_deadline_at_ms + 1,
                updated_at_ms = updated_at_ms + 1,
                version = version + 1
            WHERE id = ?
          `)
          .run(valid.id);
      },
      /frozen lifecycle/i
    );

    const exemptIds = seedScenario(runtime, {
      base: 3_000,
      includePriorSeason: false,
      includeEntryDraft: false,
      targetSeasonKey: "20262027",
    });
    const reportId = uuid(3_080);
    const exemptionId = uuid(3_081);
    const exemptFadId = uuid(3_082);
    const reason =
      "The Entry Draft is unavailable for this transition.";
    insertMigrationReport(runtime.database, exemptIds, reportId);
    insertExemption(runtime.database, exemptIds, {
      id: exemptionId,
      reportId,
      reason,
    });
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "free_agent_drafts",
          fadRecord(exemptIds, {
            id: uuid(3_083),
            setup_path: "no_draft_inaugural",
            entry_draft_id: null,
            setup_exemption_id: null,
            prior_season_rollover_id: null,
            no_draft_reason: "This is the league first season.",
          })
        );
      },
      /inaugural no-draft setup/i
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_setup_exemptions
            SET consumed_fad_id = ?,
                consumed_at_ms = ?,
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            valid.id,
            OPENED_AT_MS,
            OPENED_AT_MS,
            exemptionId
          );
      },
      /same-season FAD/i
    );
    assertConstraint(() => {
      insert(
        runtime.database,
        "free_agent_drafts",
        fadRecord(exemptIds, {
          id: exemptFadId,
          setup_path: "no_draft_initial_season2",
          entry_draft_id: null,
          setup_exemption_id: exemptionId,
          prior_season_rollover_id: null,
          no_draft_reason: `${reason} changed`,
        })
      );
    }, /unused exemption/i);

    insert(
      runtime.database,
      "free_agent_drafts",
      fadRecord(exemptIds, {
        id: exemptFadId,
        setup_path: "no_draft_initial_season2",
        entry_draft_id: null,
        setup_exemption_id: exemptionId,
        prior_season_rollover_id: null,
        no_draft_reason: reason,
      })
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT consumed_fad_id, consumed_at_ms, version
          FROM free_agent_draft_setup_exemptions
          WHERE id = ?
        `)
        .get(exemptionId),
      {
        consumed_fad_id: exemptFadId,
        consumed_at_ms: OPENED_AT_MS,
        version: 2,
      }
    );
  });

  test("enforces participants, cards, rounded offers, Bench limits, and help scope", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0024-card-");
    copyMigrationsThrough(runtime, 24);
    migrate(runtime, "fad-0024-card");
    const ids = seedScenario(runtime, { base: 4_000 });
    const { fad, participant, card, revision } = setupOpenCard(
      runtime.database,
      ids
    );

    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_teams
            SET team_status_at_setup = 'inactive'
            WHERE id = ?
          `)
          .run(participant.id);
      },
      /immutable/i
    );
    assertConstraint(() => {
      insert(
        runtime.database,
        "candidate_cards",
        cardRecord(ids, fad.id, { id: uuid(4_190) })
      );
    });
    const forwardId = uuid(4_200);
    const defenceId = uuid(4_201);
    const extraId = uuid(4_202);
    const commissionerCandidateId = uuid(4_203);
    seedPlayer(runtime.database, forwardId, "F");
    seedPlayer(runtime.database, defenceId, "D");
    seedPlayer(runtime.database, extraId, "F");
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "candidate_card_entries",
          candidateEntryRecord(
            ids,
            fad.id,
            card.id,
            extraId,
            {
              id: uuid(4_213),
              requested_slot_number: 3,
              eligibility_status: "warning",
              validation_code: "POTENTIAL_ILLEGALITY",
              last_acknowledgement_revision_id: revision.id,
            }
          )
        );
      },
      /accepted revision/i
    );
    assertConstraint(() => {
      insert(
        runtime.database,
        "candidate_card_entries",
        candidateEntryRecord(
          ids,
          fad.id,
          card.id,
          extraId,
          {
            id: uuid(4_214),
            requested_slot_number: 3,
            created_by_user_id: null,
            created_by_membership_id: null,
            created_by_authority: "system",
            last_edited_by_user_id: null,
            last_edited_by_membership_id: null,
            last_edited_by_authority: "system",
          }
        )
      );
    });
    seedPlayer(
      runtime.database,
      commissionerCandidateId,
      "F"
    );
    const outsiderUserId = uuid(4_230);
    const outsiderMembershipId = uuid(4_231);
    insert(runtime.database, "users", {
      id: outsiderUserId,
      email_normalized: "outsider-4000@example.test",
      email_display: "outsider-4000@example.test",
      display_name: "Outsider 4000",
      display_name_normalized: "outsider 4000",
      status: "active",
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
    insert(runtime.database, "league_memberships", {
      id: outsiderMembershipId,
      league_id: ids.league,
      user_id: outsiderUserId,
      permission_category: "member",
      status: "active",
      joined_at_ms: 10,
      ended_at_ms: null,
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });

    assertConstraint(() => {
      insert(
        runtime.database,
        "candidate_card_entries",
        candidateEntryRecord(
          ids,
          fad.id,
          card.id,
          forwardId,
          { proposed_aav_cents: 232 }
        )
      );
    });
    const forward = candidateEntryRecord(
      ids,
      fad.id,
      card.id,
      forwardId
    );
    insert(runtime.database, "candidate_card_entries", forward);
    assert.equal(
      runtime.database
        .prepare(`
          SELECT proposed_total_value_cents,
                 proposed_term_years,
                 proposed_aav_cents
          FROM candidate_card_entries
          WHERE id = ?
        `)
        .get(forward.id).proposed_aav_cents,
      233
    );

    assertConstraint(() => {
      insert(
        runtime.database,
        "candidate_card_entries",
        candidateEntryRecord(
          ids,
          fad.id,
          card.id,
          defenceId,
          {
            id: uuid(4_210),
            effective_position_group: "D",
            requested_slot_group: "B",
            proposed_total_value_cents: 1_300,
            proposed_term_years: 3,
            proposed_aav_cents: 433,
          }
        )
      );
    });
    insert(
      runtime.database,
      "candidate_card_entries",
      candidateEntryRecord(
        ids,
        fad.id,
        card.id,
        defenceId,
        {
          id: uuid(4_211),
          effective_position_group: "D",
          requested_slot_group: "B",
          proposed_total_value_cents: 1_200,
          proposed_term_years: 3,
          proposed_aav_cents: 400,
        }
      )
    );
    assertConstraint(() => {
      insert(
        runtime.database,
        "candidate_card_entries",
        candidateEntryRecord(
          ids,
          fad.id,
          card.id,
          extraId,
          {
            id: uuid(4_212),
            requested_slot_group: "F",
            requested_slot_number: 1,
          }
        )
      );
    });
    const conflictEntry = candidateEntryRecord(
      ids,
      fad.id,
      card.id,
      extraId,
      {
        id: uuid(4_233),
        requested_slot_number: 3,
      }
    );
    insert(
      runtime.database,
      "candidate_card_entries",
      conflictEntry
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE candidate_card_entries
            SET placement_state = 'conflict',
                conflict_code = 'DUPLICATE_PLAYER',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(OPENED_AT_MS + 30, conflictEntry.id);
      },
      /open pre-deadline card/i
    );

    const commissionerEntry = candidateEntryRecord(
      ids,
      fad.id,
      card.id,
      commissionerCandidateId,
      {
        requested_slot_number: 2,
        created_by_user_id: ids.commissionerUser,
        created_by_membership_id:
          ids.commissionerMembership,
        created_by_authority: "commissioner",
        last_edited_by_user_id: ids.commissionerUser,
        last_edited_by_membership_id:
          ids.commissionerMembership,
        last_edited_by_authority: "commissioner",
        created_at_ms: HELP_OPENS_AT_MS + 1,
        updated_at_ms: HELP_OPENS_AT_MS + 1,
      }
    );
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "candidate_card_entries",
          commissionerEntry
        );
      },
      /active help/i
    );

    assertConstraint(() => {
      insert(
        runtime.database,
        "candidate_card_help_requests",
        helpRecord(ids, fad.id, card.id, {
          id: uuid(4_220),
          requested_at_ms: HELP_OPENS_AT_MS - 1,
          created_at_ms: HELP_OPENS_AT_MS - 1,
          updated_at_ms: HELP_OPENS_AT_MS - 1,
        })
      );
    }, /final 48-hour window/i);
    const help = helpRecord(ids, fad.id, card.id);
    insert(
      runtime.database,
      "candidate_card_help_requests",
      help
    );
    insert(
      runtime.database,
      "candidate_card_entries",
      commissionerEntry
    );
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "candidate_card_entries",
          candidateEntryRecord(
            ids,
            fad.id,
            card.id,
            extraId,
            {
              id: uuid(4_232),
              requested_slot_number: 3,
              created_by_user_id: outsiderUserId,
              created_by_membership_id:
                outsiderMembershipId,
              created_by_authority: "commissioner",
              last_edited_by_user_id: outsiderUserId,
              last_edited_by_membership_id:
                outsiderMembershipId,
              last_edited_by_authority: "commissioner",
              created_at_ms: HELP_OPENS_AT_MS + 1,
              updated_at_ms: HELP_OPENS_AT_MS + 1,
            }
          )
        );
      },
      /active help/i
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE candidate_card_help_requests
            SET message = 'Changed message',
                updated_at_ms = updated_at_ms + 1,
                version = 2
            WHERE id = ?
          `)
          .run(help.id);
      },
      /expire once/i
    );
    runtime.database
      .prepare(`
        UPDATE candidate_card_entries
        SET placement_state = 'conflict',
            conflict_code = 'DUPLICATE_PLAYER',
            last_edited_by_user_id = NULL,
            last_edited_by_membership_id = NULL,
            last_edited_by_authority = 'system',
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(CANDIDATE_DEADLINE_AT_MS, conflictEntry.id);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT placement_state,
                 conflict_code,
                 last_edited_by_authority,
                 updated_at_ms,
                 version
          FROM candidate_card_entries
          WHERE id = ?
        `)
        .get(conflictEntry.id),
      {
        placement_state: "conflict",
        conflict_code: "DUPLICATE_PLAYER",
        last_edited_by_authority: "system",
        updated_at_ms: CANDIDATE_DEADLINE_AT_MS,
        version: 2,
      }
    );
    runtime.database
      .prepare(`
        UPDATE candidate_card_help_requests
        SET status = 'expired',
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(CANDIDATE_DEADLINE_AT_MS, help.id);
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE candidate_card_entries
            SET proposed_total_value_cents = 900,
                proposed_aav_cents = 300,
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(CANDIDATE_DEADLINE_AT_MS, forward.id);
      },
      /open pre-deadline card/i
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE candidate_card_entries
            SET proposed_total_value_cents = 900,
                proposed_aav_cents = 300,
                last_edited_by_user_id = ?,
                last_edited_by_membership_id = ?,
                last_edited_by_authority = 'commissioner',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            ids.commissionerUser,
            ids.commissionerMembership,
            HELP_OPENS_AT_MS + 2,
            commissionerEntry.id
          );
      },
      /active help/i
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE candidate_card_help_requests
            SET status = 'active',
                updated_at_ms = updated_at_ms + 1,
                version = 3
            WHERE id = ?
          `)
          .run(help.id);
      },
      /expire once/i
    );
  });

  test("requires carryovers to copy current ownership, contract, and remaining years", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0024-carryover-"
    );
    copyMigrationsThrough(runtime, 24);
    migrate(runtime, "fad-0024-carryover");
    const ids = seedScenario(runtime, { base: 4_500 });
    const { fad, card } = setupOpenCard(
      runtime.database,
      ids
    );
    const playerId = uuid(4_700);
    const ownershipId = uuid(4_701);
    const contractId = uuid(4_702);
    seedPlayer(runtime.database, playerId, "F");
    insert(runtime.database, "player_ownerships", {
      id: ownershipId,
      league_id: ids.league,
      season_id: ids.targetSeason,
      player_id: playerId,
      team_id: ids.team,
      ownership_kind: "Rostered",
      roster_category: "Active",
      position_group: "F",
      slot_number: 1,
      acquired_transaction_type: "season_rollover",
      acquired_transaction_id: ids.rollover,
      created_at_ms: OPENED_AT_MS - 100,
      updated_at_ms: OPENED_AT_MS - 100,
      version: 1,
    });
    insert(runtime.database, "contracts", {
      id: contractId,
      league_id: ids.league,
      player_id: playerId,
      current_team_id: ids.team,
      contract_type: "normal",
      original_total_value_cents: 600,
      original_term_years: 3,
      aav_cents: 200,
      start_season_id: ids.targetSeason,
      status: "active",
      acquisition_source_type: "season_rollover",
      acquisition_source_id: ids.rollover,
      auction_buyout_lock_expires_at_ms: null,
      created_at_ms: OPENED_AT_MS - 100,
      updated_at_ms: OPENED_AT_MS - 100,
      version: 1,
    });
    insert(runtime.database, "contract_years", {
      id: uuid(4_703),
      league_id: ids.league,
      contract_id: contractId,
      season_id: ids.targetSeason,
      year_number: 2,
      aav_cents: 200,
      status: "current",
      rollover_at_ms: OPENED_AT_MS - 100,
      created_at_ms: OPENED_AT_MS - 100,
    });

    for (const overrides of [
      { remaining_years: 2 },
      { carryover_original_total_value_cents: 700 },
      { carryover_ownership_id: uuid(4_799) },
    ]) {
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "candidate_card_entries",
            carryoverEntryRecord(
              ids,
              fad.id,
              card.id,
              playerId,
              ownershipId,
              contractId,
              overrides
            )
          );
        },
        /copy current ownership and contract evidence/i
      );
    }

    const carryover = carryoverEntryRecord(
      ids,
      fad.id,
      card.id,
      playerId,
      ownershipId,
      contractId
    );
    insert(
      runtime.database,
      "candidate_card_entries",
      carryover
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT entry_kind,
                 carryover_ownership_id,
                 carryover_contract_id,
                 remaining_years
          FROM candidate_card_entries
          WHERE id = ?
        `)
        .get(carryover.id),
      {
        entry_kind: "carryover",
        carryover_ownership_id: ownershipId,
        carryover_contract_id: contractId,
        remaining_years: 1,
      }
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            DELETE FROM candidate_card_entries
            WHERE id = ?
          `)
          .run(carryover.id);
      },
      /valid carryover entry cannot be removed/i
    );
  });

  test("rejects fabricated blocking-validation snapshot summaries", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0024-validation-snapshot-"
    );
    copyMigrationsThrough(runtime, 24);
    migrate(runtime, "fad-0024-validation-snapshot");
    const ids = seedScenario(runtime, { base: 4_800 });
    const { fad, card } = setupOpenCard(
      runtime.database,
      ids
    );
    const playerId = uuid(4_900);
    seedPlayer(runtime.database, playerId, "F");
    const invalidEntry = candidateEntryRecord(
      ids,
      fad.id,
      card.id,
      playerId,
      {
        eligibility_status: "invalid",
        validation_code: "PLAYER_INELIGIBLE",
      }
    );
    insert(
      runtime.database,
      "candidate_card_entries",
      invalidEntry
    );
    runtime.database
      .prepare(`
        UPDATE candidate_cards
        SET filled_mandatory_count = 1,
            missing_mandatory_count = 17,
            maximum_possible_cap_cents = 0,
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(OPENED_AT_MS + 20, card.id);
    insert(
      runtime.database,
      "candidate_card_revisions",
      revisionRecord(ids, fad.id, card.id, {
        id: uuid(4_910),
        resulting_card_version: 2,
        action: "candidate_added",
        affected_entry_id: invalidEntry.id,
        player_id: playerId,
        actor_user_id: ids.managerUser,
        actor_membership_id: ids.managerMembership,
        actor_authority: "manager",
        before_evidence_json: '{"entry":null}',
        after_evidence_json:
          '{"validation":"PLAYER_INELIGIBLE"}',
        occurred_at_ms: OPENED_AT_MS + 20,
        created_at_ms: OPENED_AT_MS + 20,
      })
    );
    runtime.database
      .prepare(`
        UPDATE candidate_cards
        SET status = 'locked_incomplete',
            locked_at_ms = ?,
            updated_at_ms = ?,
            version = 3
        WHERE id = ?
      `)
      .run(
        CANDIDATE_DEADLINE_AT_MS,
        CANDIDATE_DEADLINE_AT_MS,
        card.id
      );
    insert(
      runtime.database,
      "candidate_card_revisions",
      revisionRecord(ids, fad.id, card.id, {
        id: uuid(4_911),
        resulting_card_version: 3,
        action: "deadline_locked",
        before_evidence_json: '{"status":"open"}',
        after_evidence_json:
          '{"status":"locked_incomplete"}',
        occurred_at_ms: CANDIDATE_DEADLINE_AT_MS,
        created_at_ms: CANDIDATE_DEADLINE_AT_MS,
      })
    );
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "candidate_card_snapshots",
          snapshotRecord(ids, fad.id, card.id, 3, {
            id: uuid(4_912),
            proposed_candidate_aav_cents: 0,
            maximum_possible_cap_cents: 0,
            maximum_cap_space_cents: 10_000,
          })
        );
      },
      /blocking validation count must match current entries/i
    );
  });

  test("keeps deadline-created structural conflicts separate from blocking validation", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0024-conflicted-snapshot-"
    );
    copyMigrationsThrough(runtime, 24);
    migrate(runtime, "fad-0024-conflicted-snapshot");
    const ids = seedScenario(runtime, { base: 4_850 });
    const { fad, card } = setupOpenCard(
      runtime.database,
      ids
    );
    const playerId = uuid(4_950);
    seedPlayer(runtime.database, playerId, "F");
    const conflictedEntry = candidateEntryRecord(
      ids,
      fad.id,
      card.id,
      playerId
    );
    insert(
      runtime.database,
      "candidate_card_entries",
      conflictedEntry
    );
    runtime.database
      .prepare(`
        UPDATE candidate_cards
        SET filled_mandatory_count = 1,
            missing_mandatory_count = 17,
            maximum_possible_cap_cents = 233,
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(OPENED_AT_MS + 20, card.id);
    insert(
      runtime.database,
      "candidate_card_revisions",
      revisionRecord(ids, fad.id, card.id, {
        id: uuid(4_951),
        resulting_card_version: 2,
        action: "candidate_added",
        affected_entry_id: conflictedEntry.id,
        player_id: playerId,
        actor_user_id: ids.managerUser,
        actor_membership_id: ids.managerMembership,
        actor_authority: "manager",
        before_evidence_json: '{"entry":null}',
        after_evidence_json: '{"slot":"F01"}',
        occurred_at_ms: OPENED_AT_MS + 20,
        created_at_ms: OPENED_AT_MS + 20,
      })
    );
    runtime.database
      .prepare(`
        UPDATE candidate_card_entries
        SET placement_state = 'conflict',
            conflict_code = 'CARRYOVER_SLOT_CLAIMED',
            last_edited_by_user_id = NULL,
            last_edited_by_membership_id = NULL,
            last_edited_by_authority = 'system',
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(CANDIDATE_DEADLINE_AT_MS, conflictedEntry.id);
    runtime.database
      .prepare(`
        UPDATE candidate_cards
        SET status = 'locked_conflicted',
            completeness_code = 'conflicted',
            filled_mandatory_count = 0,
            missing_mandatory_count = 18,
            blocking_validation_count = 0,
            structural_conflict_count = 1,
            maximum_possible_cap_cents = 0,
            locked_at_ms = ?,
            updated_at_ms = ?,
            version = 3
        WHERE id = ?
      `)
      .run(
        CANDIDATE_DEADLINE_AT_MS,
        CANDIDATE_DEADLINE_AT_MS,
        card.id
      );
    insert(
      runtime.database,
      "candidate_card_revisions",
      revisionRecord(ids, fad.id, card.id, {
        id: uuid(4_952),
        resulting_card_version: 3,
        action: "deadline_locked",
        before_evidence_json: '{"status":"open"}',
        after_evidence_json:
          '{"status":"locked_conflicted"}',
        occurred_at_ms: CANDIDATE_DEADLINE_AT_MS,
        created_at_ms: CANDIDATE_DEADLINE_AT_MS,
      })
    );

    const snapshot = snapshotRecord(
      ids,
      fad.id,
      card.id,
      3,
      {
        id: uuid(4_953),
        locked_status: "locked_conflicted",
        completeness_code: "conflicted",
        filled_mandatory_count: 0,
        missing_mandatory_count: 18,
        blocking_validation_count: 0,
        structural_conflict_count: 1,
        proposed_candidate_aav_cents: 0,
        maximum_possible_cap_cents: 0,
        maximum_cap_space_cents: 10_000,
      }
    );
    insert(
      runtime.database,
      "candidate_card_snapshots",
      snapshot
    );

    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT locked_status,
                 completeness_code,
                 blocking_validation_count,
                 structural_conflict_count
          FROM candidate_card_snapshots
          WHERE id = ?
        `)
        .get(snapshot.id),
      {
        locked_status: "locked_conflicted",
        completeness_code: "conflicted",
        blocking_validation_count: 0,
        structural_conflict_count: 1,
      }
    );
  });

  test("preserves immutable revisions and complete deadline snapshots behind locked barriers", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0024-snapshot-"
    );
    copyMigrationsThrough(runtime, 24);
    migrate(runtime, "fad-0024-snapshot");
    const ids = seedScenario(runtime, { base: 5_000 });
    const { fad, card, revision } = setupOpenCard(
      runtime.database,
      ids
    );
    const playerId = uuid(5_200);
    seedPlayer(runtime.database, playerId, "F");
    const entry = candidateEntryRecord(
      ids,
      fad.id,
      card.id,
      playerId
    );
    insert(runtime.database, "candidate_card_entries", entry);

    runtime.database
      .prepare(`
        UPDATE candidate_cards
        SET filled_mandatory_count = 1,
            missing_mandatory_count = 17,
            maximum_possible_cap_cents = 233,
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(OPENED_AT_MS + 20, card.id);
    assertConstraint(() => {
      insert(
        runtime.database,
        "candidate_card_revisions",
        revisionRecord(ids, fad.id, card.id, {
          id: uuid(5_209),
          resulting_card_version: 2,
          action: "candidate_added",
          actor_user_id: ids.managerUser,
          actor_membership_id: ids.managerMembership,
          actor_authority: "manager",
          before_evidence_json: '{"entry":null}',
          after_evidence_json: '{"slot":"F01"}',
          occurred_at_ms: OPENED_AT_MS + 20,
          created_at_ms: OPENED_AT_MS + 20,
        })
      );
    });
    const addedRevision = revisionRecord(
      ids,
      fad.id,
      card.id,
      {
        id: uuid(5_210),
        resulting_card_version: 2,
        action: "candidate_added",
        affected_entry_id: entry.id,
        player_id: playerId,
        actor_user_id: ids.managerUser,
        actor_membership_id: ids.managerMembership,
        actor_authority: "manager",
        before_evidence_json: '{"entry":null}',
        after_evidence_json: '{"slot":"F01"}',
        occurred_at_ms: OPENED_AT_MS + 20,
        created_at_ms: OPENED_AT_MS + 20,
      }
    );
    insert(
      runtime.database,
      "candidate_card_revisions",
      addedRevision
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE candidate_card_revisions
            SET after_evidence_json = '{"changed":true}'
            WHERE id = ?
          `)
          .run(revision.id);
      },
      /immutable/i
    );

    runtime.database
      .prepare(`
        UPDATE candidate_card_entries
        SET last_edited_by_user_id = NULL,
            last_edited_by_membership_id = NULL,
            last_edited_by_authority = 'system',
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(CANDIDATE_DEADLINE_AT_MS, entry.id);
    runtime.database
      .prepare(`
        UPDATE candidate_cards
        SET updated_at_ms = ?,
            version = 3
        WHERE id = ?
      `)
      .run(CANDIDATE_DEADLINE_AT_MS, card.id);
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "candidate_card_revisions",
          revisionRecord(ids, fad.id, card.id, {
            id: uuid(5_212),
            resulting_card_version: 3,
            action: "candidate_edited",
            affected_entry_id: entry.id,
            player_id: playerId,
            actor_user_id: ids.managerUser,
            actor_membership_id: ids.managerMembership,
            actor_authority: "manager",
            before_evidence_json: '{"eligibility":"valid"}',
            after_evidence_json: '{"eligibility":"valid"}',
            occurred_at_ms: CANDIDATE_DEADLINE_AT_MS,
            created_at_ms: CANDIDATE_DEADLINE_AT_MS,
          })
        );
      },
      /outside its lifecycle phase/i
    );
    insert(
      runtime.database,
      "candidate_card_revisions",
      revisionRecord(ids, fad.id, card.id, {
        id: uuid(5_213),
        resulting_card_version: 3,
        action: "eligibility_revalidated",
        affected_entry_id: entry.id,
        player_id: playerId,
        before_evidence_json: '{"eligibility":"valid"}',
        after_evidence_json: '{"eligibility":"valid"}',
        occurred_at_ms: CANDIDATE_DEADLINE_AT_MS,
        created_at_ms: CANDIDATE_DEADLINE_AT_MS,
      })
    );

    runtime.database
      .prepare(`
        UPDATE candidate_cards
        SET status = 'locked_incomplete',
            locked_at_ms = ?,
            updated_at_ms = ?,
            version = 4
        WHERE id = ?
      `)
      .run(
        CANDIDATE_DEADLINE_AT_MS,
        CANDIDATE_DEADLINE_AT_MS,
        card.id
      );
    const deadlineRevision = revisionRecord(
      ids,
      fad.id,
      card.id,
      {
        id: uuid(5_214),
        resulting_card_version: 4,
        action: "deadline_locked",
        before_evidence_json: '{"status":"open"}',
        after_evidence_json:
          '{"status":"locked_incomplete"}',
        occurred_at_ms: CANDIDATE_DEADLINE_AT_MS,
        created_at_ms: CANDIDATE_DEADLINE_AT_MS,
      }
    );
    insert(
      runtime.database,
      "candidate_card_revisions",
      deadlineRevision
    );

    const snapshot = snapshotRecord(
      ids,
      fad.id,
      card.id,
      4
    );
    assertConstraint(
      () => {
        insert(
          runtime.database,
          "candidate_card_snapshots",
          snapshotRecord(ids, fad.id, card.id, 4, {
            id: uuid(5_215),
            cap_limit_cents: 9_999,
            maximum_cap_space_cents: 9_766,
          })
        );
      },
      /cap limit must match league settings/i
    );
    insert(runtime.database, "candidate_card_snapshots", snapshot);
    let sequence = 0;
    let deferredSlot;
    for (const [slotGroup, maximum] of [
      ["F", 12],
      ["D", 6],
      ["B", 4],
    ]) {
      for (let slotNumber = 1; slotNumber <= maximum; slotNumber += 1) {
        sequence += 1;
        const row =
          slotGroup === "F" && slotNumber === 1
            ? candidateSnapshotEntry(
                ids,
                fad.id,
                card.id,
                snapshot.id,
                {
                  ...entry,
                  last_edited_by_user_id: null,
                  last_edited_by_membership_id: null,
                  last_edited_by_authority: "system",
                  updated_at_ms: CANDIDATE_DEADLINE_AT_MS,
                  version: 2,
                }
              )
            : emptySnapshotEntry(
                ids,
                fad.id,
                card.id,
                snapshot.id,
                slotGroup,
                slotNumber,
                sequence
              );
        if (slotGroup === "B" && slotNumber === 4) {
          deferredSlot = row;
          continue;
        }
        insert(
          runtime.database,
          "candidate_card_snapshot_entries",
          row
        );
      }
    }
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM candidate_card_snapshot_entries
          WHERE snapshot_id = ? AND row_kind = 'slot'
        `)
        .get(snapshot.id).count,
      21
    );
    assertConstraint(
      () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_drafts
            SET status = 'deadline_locked',
                deadline_locked_at_ms = ?,
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            CANDIDATE_DEADLINE_AT_MS + 10,
            CANDIDATE_DEADLINE_AT_MS + 10,
            fad.id
          );
      },
      /complete immutable card snapshots/i
    );
    insert(
      runtime.database,
      "candidate_card_snapshot_entries",
      deferredSlot
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM candidate_card_snapshot_entries
          WHERE snapshot_id = ? AND row_kind = 'slot'
        `)
        .get(snapshot.id).count,
      22
    );

    runtime.database
      .prepare(`
        UPDATE free_agent_drafts
        SET status = 'deadline_locked',
            deadline_locked_at_ms = ?,
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(
        CANDIDATE_DEADLINE_AT_MS + 10,
        CANDIDATE_DEADLINE_AT_MS + 10,
        fad.id
      );

    for (const statement of [
      {
        sql: `
          UPDATE candidate_card_entries
          SET proposed_total_value_cents = 900,
              proposed_aav_cents = 300,
              updated_at_ms = updated_at_ms + 1,
              version = version + 1
          WHERE id = ?
        `,
        id: entry.id,
        pattern: /open pre-deadline card/i,
      },
      {
        sql: "DELETE FROM candidate_card_entries WHERE id = ?",
        id: entry.id,
        pattern: /locked Candidate entry/i,
      },
      {
        sql: `
          UPDATE candidate_card_snapshots
          SET maximum_cap_space_cents = 0
          WHERE id = ?
        `,
        id: snapshot.id,
        pattern: /immutable/i,
      },
      {
        sql: `
          DELETE FROM candidate_card_snapshot_entries
          WHERE snapshot_id = ?
        `,
        id: snapshot.id,
        pattern: /immutable/i,
      },
    ]) {
      assertConstraint(
        () =>
          runtime.database
            .prepare(statement.sql)
            .run(statement.id),
        statement.pattern
      );
    }
    assertConstraint(() => {
      insert(
        runtime.database,
        "candidate_card_snapshot_entries",
        emptySnapshotEntry(
          ids,
          fad.id,
          card.id,
          snapshot.id,
          "F",
          1,
          99
        )
      );
    });
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });
});
