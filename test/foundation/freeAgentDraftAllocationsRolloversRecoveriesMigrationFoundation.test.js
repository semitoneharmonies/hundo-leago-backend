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
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FIRST_MATCHUP_STARTS_AT_MS = 2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 7 * DAY_MS;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 48 * HOUR_MS;
const OPENED_AT_MS = HELP_OPENS_AT_MS - 1_000;
const SNAPSHOT_AT_MS = CANDIDATE_DEADLINE_AT_MS + 10;
const NEW_TABLES = Object.freeze([
  "free_agent_draft_allocation_events",
  "free_agent_draft_player_allocations",
  "free_agent_draft_recoveries",
  "free_agent_draft_rollovers",
]);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function numericId(id) {
  return Number(id.slice(-12));
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

function seedScenario(runtime, { base, secondTeam = false }) {
  const ids = {
    commissionerUser: uuid(base + 1),
    managerUser: uuid(base + 2),
    platformRole: uuid(base + 3),
    league: uuid(base + 4),
    commissionerMembership: uuid(base + 5),
    managerMembership: uuid(base + 6),
    sourceSeason: uuid(base + 7),
    targetSeason: uuid(base + 8),
    team: uuid(base + 9),
    managerAssignment: uuid(base + 10),
    week: uuid(base + 11),
    entryDraft: uuid(base + 12),
    seasonRollover: uuid(base + 13),
  };
  if (secondTeam) {
    ids.secondTeam = uuid(base + 900);
    ids.secondManagerAssignment = uuid(base + 901);
  }
  const { database } = runtime;

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
  insert(database, "seasons", {
    id: ids.targetSeason,
    league_id: ids.league,
    label: `Target ${base}`,
    nhl_season_key: `${base}2026`,
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
  if (secondTeam) {
    insert(database, "teams", {
      id: ids.secondTeam,
      league_id: ids.league,
      name: `Second Team ${base}`,
      name_normalized: `second team ${base}`,
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: 20,
      updated_at_ms: 20,
      version: 1,
    });
    insert(database, "team_manager_assignments", {
      id: ids.secondManagerAssignment,
      league_id: ids.league,
      team_id: ids.secondTeam,
      user_id: ids.managerUser,
      membership_id: ids.managerMembership,
      assigned_by_user_id: ids.commissionerUser,
      status: "accepted",
      assigned_at_ms: 20,
      accepted_at_ms: 20,
      ended_at_ms: null,
      version: 1,
    });
  }
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
  insert(database, "season_rollovers", {
    id: ids.seasonRollover,
    league_id: ids.league,
    from_season_id: ids.sourceSeason,
    to_season_id: ids.targetSeason,
    status: "succeeded",
    authorized_by_user_id: ids.commissionerUser,
    authorized_by_membership_id: ids.commissionerMembership,
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

  return ids;
}

function fadRecord(ids, overrides = {}) {
  return {
    id: uuid(numericId(ids.league) + 100),
    league_id: ids.league,
    season_id: ids.targetSeason,
    first_matchup_week_id: ids.week,
    participating_team_count: 1,
    status: "cards_open",
    setup_path: "completed_entry_draft",
    entry_draft_id: ids.entryDraft,
    setup_exemption_id: null,
    prior_season_rollover_id: ids.seasonRollover,
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

function participantRecord(ids, fadId) {
  return {
    id: uuid(numericId(ids.league) + 101),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  };
}

function cardRecord(ids, fadId) {
  return {
    id: uuid(numericId(ids.league) + 102),
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
  };
}

function revisionRecord(ids, fadId, cardId, overrides = {}) {
  return {
    id: uuid(numericId(ids.league) + 103),
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
  const fad = fadRecord(ids, {
    participating_team_count: ids.secondTeam ? 2 : 1,
  });
  const card = cardRecord(ids, fad.id);
  insert(database, "free_agent_drafts", fad);
  insert(
    database,
    "free_agent_draft_teams",
    participantRecord(ids, fad.id)
  );
  insert(database, "candidate_cards", card);
  insert(
    database,
    "candidate_card_revisions",
    revisionRecord(ids, fad.id, card.id)
  );
  return { fad, card };
}

function seedPlayer(database, playerId) {
  if (
    database
      .prepare("SELECT 1 FROM players WHERE id = ?")
      .get(playerId)
  ) {
    return;
  }
  insert(database, "players", {
    id: playerId,
    first_name: `Player ${playerId.slice(-3)}`,
    last_name: "Forward",
    full_name: `Player ${playerId.slice(-3)} Forward`,
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
  playerId
) {
  return {
    id: uuid(numericId(ids.league) + 350),
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
  };
}

function snapshotRecord(ids, fadId, cardId, cardVersion) {
  return {
    id: uuid(numericId(ids.league) + 105),
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
    processed_at_ms: SNAPSHOT_AT_MS,
    created_at_ms: SNAPSHOT_AT_MS,
  };
}

function emptySnapshotEntry(
  ids,
  fixture,
  slotGroup,
  slotNumber,
  sequence
) {
  return {
    id: uuid(numericId(ids.league) + 200 + sequence),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    snapshot_id: fixture.snapshot.id,
    card_id: fixture.card.id,
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
    created_at_ms: SNAPSHOT_AT_MS,
  };
}

function populateCandidateCardSnapshot(
  database,
  ids,
  fixture,
  playerId,
  {
    entryOffset,
    candidateRevisionOffset,
    deadlineRevisionOffset,
    snapshotOffset,
    snapshotEntryBaseOffset,
    entryOverrides = {},
  }
) {
  const base = numericId(ids.league);
  seedPlayer(database, playerId);
  const wantsConflict =
    entryOverrides.placement_state === "conflict";
  const initialEntryOverrides = { ...entryOverrides };
  if (wantsConflict) {
    delete initialEntryOverrides.placement_state;
    delete initialEntryOverrides.conflict_code;
  }
  let entry = {
    ...candidateEntryRecord(
      ids,
      fixture.fad.id,
      fixture.card.id,
      playerId
    ),
    ...initialEntryOverrides,
    id: uuid(base + entryOffset),
  };
  insert(database, "candidate_card_entries", entry);
  const initialOfferCountsTowardCap =
    entry.eligibility_status === "valid" ||
    entry.eligibility_status === "warning";
  const initialBlockingCount =
    entry.eligibility_status === "invalid" ? 1 : 0;
  const initialCandidateAav = initialOfferCountsTowardCap
    ? entry.proposed_aav_cents
    : 0;
  database
    .prepare(`
      UPDATE candidate_cards
      SET filled_mandatory_count = 1,
          missing_mandatory_count = 17,
          blocking_validation_count = ?,
          maximum_possible_cap_cents = ?,
          updated_at_ms = ?,
          version = 2
      WHERE id = ?
    `)
    .run(
      initialBlockingCount,
      initialCandidateAav,
      OPENED_AT_MS + 20,
      fixture.card.id
    );
  insert(
    database,
    "candidate_card_revisions",
    revisionRecord(ids, fixture.fad.id, fixture.card.id, {
      id: uuid(base + candidateRevisionOffset),
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
    })
  );
  let currentCardVersion = 2;
  if (wantsConflict) {
    const synchronizedAtMs = OPENED_AT_MS + 30;
    database
      .prepare(`
        UPDATE candidate_card_entries
        SET placement_state = 'conflict',
            conflict_code = ?,
            last_edited_by_user_id = NULL,
            last_edited_by_membership_id = NULL,
            last_edited_by_authority = 'system',
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(
        entryOverrides.conflict_code,
        synchronizedAtMs,
        entry.id
      );
    entry = {
      ...entry,
      placement_state: "conflict",
      conflict_code: entryOverrides.conflict_code,
      last_edited_by_user_id: null,
      last_edited_by_membership_id: null,
      last_edited_by_authority: "system",
      updated_at_ms: synchronizedAtMs,
      version: 2,
    };
    database
      .prepare(`
        UPDATE candidate_cards
        SET completeness_code = 'conflicted',
            filled_mandatory_count = 0,
            missing_mandatory_count = 18,
            blocking_validation_count = 0,
            structural_conflict_count = 1,
            maximum_possible_cap_cents = 0,
            updated_at_ms = ?,
            version = 3
        WHERE id = ?
      `)
      .run(synchronizedAtMs, fixture.card.id);
    insert(
      database,
      "candidate_card_revisions",
      revisionRecord(ids, fixture.fad.id, fixture.card.id, {
        id: uuid(base + candidateRevisionOffset + 50),
        resulting_card_version: 3,
        action: "summer_state_synchronized",
        affected_entry_id: entry.id,
        player_id: playerId,
        before_evidence_json: '{"placementState":"placed"}',
        after_evidence_json: '{"placementState":"conflict"}',
        occurred_at_ms: synchronizedAtMs,
        created_at_ms: synchronizedAtMs,
      })
    );
    currentCardVersion = 3;
  }
  const lockedStatus = wantsConflict
    ? "locked_conflicted"
    : "locked_incomplete";
  const completenessCode = wantsConflict
    ? "conflicted"
    : "incomplete";
  const lockedCardVersion = currentCardVersion + 1;
  database
    .prepare(`
      UPDATE candidate_cards
      SET status = ?,
          locked_at_ms = ?,
          updated_at_ms = ?,
          version = ?
      WHERE id = ?
    `)
    .run(
      lockedStatus,
      CANDIDATE_DEADLINE_AT_MS,
      CANDIDATE_DEADLINE_AT_MS,
      lockedCardVersion,
      fixture.card.id
    );
  insert(
    database,
    "candidate_card_revisions",
    revisionRecord(ids, fixture.fad.id, fixture.card.id, {
      id: uuid(base + deadlineRevisionOffset),
      resulting_card_version: lockedCardVersion,
      action: "deadline_locked",
      before_evidence_json: '{"status":"open"}',
      after_evidence_json:
        `{"status":"${lockedStatus}"}`,
      occurred_at_ms: CANDIDATE_DEADLINE_AT_MS,
      created_at_ms: CANDIDATE_DEADLINE_AT_MS,
    })
  );
  fixture.snapshot = {
    ...snapshotRecord(
      ids,
      fixture.fad.id,
      fixture.card.id,
      lockedCardVersion
    ),
    locked_status: lockedStatus,
    completeness_code: completenessCode,
    filled_mandatory_count: wantsConflict ? 0 : 1,
    missing_mandatory_count: wantsConflict ? 18 : 17,
    blocking_validation_count:
      initialBlockingCount > 0 ? 1 : 0,
    structural_conflict_count: wantsConflict ? 1 : 0,
    proposed_candidate_aav_cents: wantsConflict
      ? 0
      : initialCandidateAav,
    maximum_possible_cap_cents: wantsConflict
      ? 0
      : initialCandidateAav,
    maximum_cap_space_cents:
      10_000 - (wantsConflict ? 0 : initialCandidateAav),
    id: uuid(base + snapshotOffset),
  };
  insert(database, "candidate_card_snapshots", fixture.snapshot);

  let sequence = 0;
  for (const [slotGroup, maximum] of [
    ["F", 12],
    ["D", 6],
    ["B", 4],
  ]) {
    for (
      let slotNumber = 1;
      slotNumber <= maximum;
      slotNumber += 1
    ) {
      sequence += 1;
      const snapshotEntry = emptySnapshotEntry(
        ids,
        fixture,
        slotGroup,
        slotNumber,
        sequence
      );
      snapshotEntry.id = uuid(
        base + snapshotEntryBaseOffset + sequence
      );
      if (
        !wantsConflict &&
        slotGroup === "F" &&
        slotNumber === 1
      ) {
        Object.assign(snapshotEntry, {
          occupant_kind: "candidate",
          source_entry_id: entry.id,
          source_entry_version: entry.version,
          player_id: entry.player_id,
          effective_position_group:
            entry.effective_position_group,
          proposed_total_value_cents:
            entry.proposed_total_value_cents,
          proposed_term_years: entry.proposed_term_years,
          proposed_aav_cents: entry.proposed_aav_cents,
          eligibility_status: entry.eligibility_status,
          validation_code: entry.validation_code,
          last_edited_by_user_id:
            entry.last_edited_by_user_id,
          last_edited_by_membership_id:
            entry.last_edited_by_membership_id,
          last_edited_by_authority:
            entry.last_edited_by_authority,
          last_edited_at_ms: entry.updated_at_ms,
        });
        fixture.candidateSnapshotEntry = snapshotEntry;
      }
      insert(
        database,
        "candidate_card_snapshot_entries",
        snapshotEntry
      );
    }
  }
  if (wantsConflict) {
    const snapshotEntry = emptySnapshotEntry(
      ids,
      fixture,
      entry.requested_slot_group,
      entry.requested_slot_number,
      100
    );
    Object.assign(snapshotEntry, {
      id: uuid(base + snapshotEntryBaseOffset + 100),
      row_kind: "conflict",
      occupant_kind: "candidate",
      source_entry_id: entry.id,
      source_entry_version: entry.version,
      player_id: entry.player_id,
      effective_position_group: entry.effective_position_group,
      conflict_code: entry.conflict_code,
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
    });
    insert(
      database,
      "candidate_card_snapshot_entries",
      snapshotEntry
    );
    fixture.candidateSnapshotEntry = snapshotEntry;
  }
  fixture.entry = entry;
  return fixture;
}

function createDeadlineFixture(
  database,
  ids,
  playerId,
  {
    entryOverrides = {},
    competingEntryOverrides = {},
  } = {}
) {
  const fixture = setupOpenCard(database, ids);
  populateCandidateCardSnapshot(
    database,
    ids,
    fixture,
    playerId,
    {
      entryOffset: 350,
      candidateRevisionOffset: 104,
      deadlineRevisionOffset: 106,
      snapshotOffset: 105,
      snapshotEntryBaseOffset: 200,
      entryOverrides,
    }
  );

  if (ids.secondTeam) {
    const secondIds = { ...ids, team: ids.secondTeam };
    insert(database, "free_agent_draft_teams", {
      ...participantRecord(secondIds, fixture.fad.id),
      id: uuid(numericId(ids.league) + 902),
    });
    const secondCard = {
      ...cardRecord(secondIds, fixture.fad.id),
      id: uuid(numericId(ids.league) + 903),
    };
    insert(database, "candidate_cards", secondCard);
    insert(
      database,
      "candidate_card_revisions",
      revisionRecord(
        secondIds,
        fixture.fad.id,
        secondCard.id,
        { id: uuid(numericId(ids.league) + 904) }
      )
    );
    const competingFixture = {
      fad: fixture.fad,
      card: secondCard,
    };
    populateCandidateCardSnapshot(
      database,
      secondIds,
      competingFixture,
      playerId,
      {
        entryOffset: 905,
        candidateRevisionOffset: 906,
        deadlineRevisionOffset: 907,
        snapshotOffset: 908,
        snapshotEntryBaseOffset: 920,
        entryOverrides: competingEntryOverrides,
      }
    );
    fixture.competingCard = competingFixture.card;
    fixture.competingSnapshot = competingFixture.snapshot;
    fixture.competingEntry = competingFixture.entry;
    fixture.competingCandidateSnapshotEntry =
      competingFixture.candidateSnapshotEntry;
  }

  return fixture;
}

function rolloverRecord(ids, fadId, sequence, overrides = {}) {
  const rollsOverAtMs =
    CANDIDATE_DEADLINE_AT_MS + sequence * DAY_MS;
  return {
    id: uuid(numericId(ids.league) + 400 + sequence),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    sequence,
    opens_at_ms: rollsOverAtMs - DAY_MS,
    creation_cutoff_at_ms: rollsOverAtMs - HOUR_MS,
    rolls_over_at_ms: rollsOverAtMs,
    status: "scheduled",
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function seedRollovers(database, ids, fadId) {
  const rollovers = [];
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    const rollover = rolloverRecord(ids, fadId, sequence);
    insert(database, "free_agent_draft_rollovers", rollover);
    rollovers.push(rollover);
  }
  return rollovers;
}

function allocationRecord(ids, fixture, overrides = {}) {
  return {
    id: uuid(numericId(ids.league) + 360),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    player_id: fixture.entry.player_id,
    status: "pending",
    decision_code: null,
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: null,
    resolved_at_ms: null,
    last_error_code: null,
    created_at_ms: SNAPSHOT_AT_MS,
    updated_at_ms: SNAPSHOT_AT_MS,
    version: 1,
    ...overrides,
  };
}

function seedPendingAllocation(database, ids, fixture) {
  const allocation = allocationRecord(ids, fixture);
  insert(
    database,
    "free_agent_draft_player_allocations",
    allocation
  );
  return allocation;
}

function jobRunRecord(
  ids,
  id,
  jobType,
  occurrenceKey,
  scheduledForMs
) {
  return {
    id,
    league_id: ids.league,
    season_id: ids.targetSeason,
    job_type: jobType,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: scheduledForMs,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  };
}

function seedDurableJobs(
  database,
  ids,
  fixture,
  allocation,
  { omit = null } = {}
) {
  const jobs = {};
  const base = numericId(ids.league);
  const definitions = [
    {
      key: "reminder",
      id: uuid(base + 600),
      jobType: "fad_deadline_reminder",
      occurrenceKey:
        `fad:${fixture.fad.id}:reminder:` +
        `${CANDIDATE_DEADLINE_AT_MS - 72 * HOUR_MS}`,
      scheduledForMs:
        CANDIDATE_DEADLINE_AT_MS - 72 * HOUR_MS,
    },
    {
      key: "deadline",
      id: uuid(base + 601),
      jobType: "fad_deadline",
      occurrenceKey:
        `fad:${fixture.fad.id}:deadline:` +
        `${CANDIDATE_DEADLINE_AT_MS}`,
      scheduledForMs: CANDIDATE_DEADLINE_AT_MS,
    },
    {
      key: "allocation",
      id: uuid(base + 602),
      jobType: "fad_allocation",
      occurrenceKey:
        `fad:${fixture.fad.id}:allocate:` +
        `${allocation.player_id}`,
      scheduledForMs: CANDIDATE_DEADLINE_AT_MS,
    },
    {
      key: "completion",
      id: uuid(base + 603),
      jobType: "fad_completion",
      occurrenceKey:
        `fad:${fixture.fad.id}:complete:` +
        `${FIRST_MATCHUP_STARTS_AT_MS}`,
      scheduledForMs: FIRST_MATCHUP_STARTS_AT_MS,
    },
  ];
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    const rollsOverAtMs =
      CANDIDATE_DEADLINE_AT_MS + sequence * DAY_MS;
    definitions.push({
      key: `rollover-${sequence}`,
      id: uuid(base + 610 + sequence),
      jobType: "fad_rollover",
      occurrenceKey:
        `fad:${fixture.fad.id}:rollover:${sequence}:` +
        `${rollsOverAtMs}`,
      scheduledForMs: rollsOverAtMs,
    });
  }

  for (const definition of definitions) {
    jobs[definition.key] = jobRunRecord(
      ids,
      definition.id,
      definition.jobType,
      definition.occurrenceKey,
      definition.scheduledForMs
    );
    if (definition.key !== omit) {
      insert(database, "job_runs", jobs[definition.key]);
    }
  }
  return jobs;
}

function leaseJob(database, job, leasedAtMs) {
  database
    .prepare(`
      UPDATE job_runs
      SET status = 'leased',
          attempt_count = attempt_count + 1,
          lease_owner = 'fad-0025-test',
          lease_expires_at_ms = ?,
          started_at_ms = NULL,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          updated_at_ms = ?,
          version = version + 1,
          lease_token = ?,
          next_attempt_at_ms = NULL
      WHERE id = ?
    `)
    .run(
      leasedAtMs + HOUR_MS,
      leasedAtMs,
      `lease-${job.id}`,
      job.id
    );
}

function expireJobLease(database, job, expiresAtMs) {
  database
    .prepare(`
      UPDATE job_runs
      SET lease_expires_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
    `)
    .run(expiresAtMs, expiresAtMs, job.id);
}

function settleJobRun(
  database,
  job,
  status,
  completedAtMs,
  lastErrorCode = null
) {
  assert.ok(status === "succeeded" || status === "failed");
  database
    .prepare(`
      UPDATE job_runs
      SET status = ?,
          started_at_ms =
            COALESCE(started_at_ms, updated_at_ms),
          completed_at_ms = ?,
          result_json = ?,
          last_error_code = ?,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          lease_token = NULL,
          next_attempt_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
    `)
    .run(
      status,
      completedAtMs,
      status === "succeeded" ? "{}" : null,
      status === "failed" ? lastErrorCode : null,
      status === "failed" ? completedAtMs : null,
      completedAtMs,
      job.id
    );
}

function lockDeadline(database, fixture) {
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'deadline_locked',
          deadline_locked_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE id = ?
    `)
    .run(SNAPSHOT_AT_MS, SNAPSHOT_AT_MS, fixture.fad.id);
}

function prepareDeadlineFad(
  database,
  ids,
  playerId,
  options = {}
) {
  const fixture = createDeadlineFixture(
    database,
    ids,
    playerId,
    options
  );
  fixture.rollovers = seedRollovers(
    database,
    ids,
    fixture.fad.id
  );
  fixture.allocation = seedPendingAllocation(
    database,
    ids,
    fixture
  );
  fixture.jobs = seedDurableJobs(
    database,
    ids,
    fixture,
    fixture.allocation
  );
  leaseJob(database, fixture.jobs.deadline, SNAPSHOT_AT_MS);
  lockDeadline(database, fixture);
  leaseJob(
    database,
    fixture.jobs.allocation,
    CANDIDATE_DEADLINE_AT_MS + 20
  );
  return fixture;
}

function allocationEventRecord(
  ids,
  fixture,
  allocation,
  overrides = {}
) {
  return {
    id: uuid(numericId(ids.league) + 700),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    allocation_id: allocation.id,
    allocation_version: allocation.version,
    player_id: allocation.player_id,
    event_kind: "decision_recorded",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: allocation.decision_code,
    resulting_allocation_status: allocation.status,
    contract_id: allocation.contract_id,
    ownership_id: allocation.ownership_id,
    auction_id: allocation.restricted_auction_id,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: "{}",
    occurred_at_ms: CANDIDATE_DEADLINE_AT_MS + 20,
    created_at_ms: CANDIDATE_DEADLINE_AT_MS + 20,
    ...overrides,
  };
}

function allocationOfferEventRecord(
  ids,
  fixture,
  allocation,
  overrides = {}
) {
  const offerIsInvalid =
    allocation.status === "no_valid_offer" ||
    allocation.status === "invalid";
  return allocationEventRecord(ids, fixture, allocation, {
    id: uuid(numericId(ids.league) + 701),
    event_kind: "offer_considered",
    snapshot_entry_id: fixture.candidateSnapshotEntry.id,
    team_id: fixture.candidateSnapshotEntry.team_id,
    offer_valid: offerIsInvalid ? 0 : 1,
    rank_position: offerIsInvalid ? null : 1,
    offer_outcome_code:
      allocation.status === "deferred_restricted_recovery"
        ? "restricted_tied"
        : offerIsInvalid
          ? "invalid"
          : "winner",
    decision_code: null,
    resulting_allocation_status: allocation.status,
    contract_id: null,
    ownership_id: null,
    auction_id: null,
    activity_id: null,
    correction_id: null,
    ...overrides,
  });
}

function insertAllocationOfferEvidence(
  database,
  ids,
  fixture,
  allocation,
  overrides = {}
) {
  const firstOffer = allocationOfferEventRecord(
    ids,
    fixture,
    allocation,
    overrides
  );
  insert(
    database,
    "free_agent_draft_allocation_events",
    firstOffer
  );
  if (!fixture.competingCandidateSnapshotEntry) {
    return [firstOffer];
  }
  const competingOffer = {
    ...firstOffer,
    id: uuid(numericId(firstOffer.id) + 50),
    snapshot_entry_id:
      fixture.competingCandidateSnapshotEntry.id,
    team_id: fixture.competingCandidateSnapshotEntry.team_id,
  };
  insert(
    database,
    "free_agent_draft_allocation_events",
    competingOffer
  );
  return [firstOffer, competingOffer];
}

function updateAllocation(database, allocation, changes) {
  const next = {
    ...allocation,
    ...changes,
    updated_at_ms:
      changes.updated_at_ms ??
      CANDIDATE_DEADLINE_AT_MS + 20,
    version: allocation.version + 1,
  };
  database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = @status,
          decision_code = @decision_code,
          winning_snapshot_entry_id =
            @winning_snapshot_entry_id,
          winning_team_id = @winning_team_id,
          contract_id = @contract_id,
          ownership_id = @ownership_id,
          restricted_auction_id = @restricted_auction_id,
          resolved_at_ms = @resolved_at_ms,
          last_error_code = @last_error_code,
          updated_at_ms = @updated_at_ms,
          version = @version
      WHERE id = @id
    `)
    .run(next);
  return next;
}

function startAllocating(database, fixture) {
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'allocating',
          updated_at_ms = ?,
          version = 3
      WHERE id = ?
    `)
    .run(CANDIDATE_DEADLINE_AT_MS + 21, fixture.fad.id);
}

function finishRapid(
  database,
  fixture,
  completedAtMs = CANDIDATE_DEADLINE_AT_MS + 30
) {
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'rapid',
          allocation_completed_at_ms = ?,
          updated_at_ms = ?,
          version = 4
      WHERE id = ?
    `)
    .run(
      completedAtMs,
      completedAtMs,
      fixture.fad.id
    );

  const deadlineJob = fixture.jobs?.deadline;
  if (deadlineJob) {
    const currentDeadlineJob = database
      .prepare("SELECT status FROM job_runs WHERE id = ?")
      .get(deadlineJob.id);
    if (
      currentDeadlineJob &&
      !["succeeded", "failed", "skipped"].includes(
        currentDeadlineJob.status
      )
    ) {
      settleJobRun(
        database,
        deadlineJob,
        "succeeded",
        completedAtMs
      );
    }
  }

  const allocationJob = fixture.jobs?.allocation;
  if (allocationJob) {
    const currentAllocationJob = database
      .prepare("SELECT status FROM job_runs WHERE id = ?")
      .get(allocationJob.id);
    if (
      currentAllocationJob &&
      !["succeeded", "failed", "skipped"].includes(
        currentAllocationJob.status
      )
    ) {
      const unresolvedRecovery = database
        .prepare(`
          SELECT last_error_code
          FROM free_agent_draft_recoveries
          WHERE job_run_id = ?
            AND status IN (
              'pending',
              'ready',
              'running',
              'correction_required'
            )
          ORDER BY created_at_ms, id
          LIMIT 1
        `)
        .get(allocationJob.id);
      settleJobRun(
        database,
        allocationJob,
        unresolvedRecovery ? "failed" : "succeeded",
        completedAtMs,
        unresolvedRecovery?.last_error_code ??
          "ALLOCATION_FAILED"
      );
    }
  }
}

function advanceToRapid(database, fixture, allocation) {
  startAllocating(database, fixture);
  finishRapid(database, fixture);
  fixture.allocation = allocation;
}

function completeRollover(
  database,
  rollover,
  job,
  recovery = null
) {
  const processingAtMs = rollover.rolls_over_at_ms + 1;
  const completedAtMs = rollover.rolls_over_at_ms + 2;
  leaseJob(database, job, processingAtMs);
  database
    .prepare(`
      UPDATE free_agent_draft_rollovers
      SET status = 'processing',
          processing_started_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE id = ?
    `)
    .run(processingAtMs, processingAtMs, rollover.id);
  if (recovery) {
    insert(
      database,
      "free_agent_draft_recoveries",
      recovery
    );
    assertConstraint(
      () => {
        database
          .prepare(`
            UPDATE free_agent_draft_rollovers
            SET status = 'completed',
                completed_at_ms = ?,
                updated_at_ms = ?,
                version = 3
            WHERE id = ?
          `)
          .run(completedAtMs, completedAtMs, rollover.id);
      },
      /cannot complete with unresolved recovery/i
    );
    database
      .prepare(`
        UPDATE free_agent_draft_rollovers
        SET status = 'recovery_required',
            completed_at_ms = ?,
            last_error_code = ?,
            updated_at_ms = ?,
            version = 3
        WHERE id = ?
      `)
      .run(
        completedAtMs,
        recovery.last_error_code,
        completedAtMs,
        rollover.id
      );
    settleJobRun(
      database,
      job,
      "failed",
      completedAtMs,
      recovery.last_error_code
    );
    return;
  }
  database
    .prepare(`
      UPDATE free_agent_draft_rollovers
      SET status = 'completed',
          completed_at_ms = ?,
          updated_at_ms = ?,
          version = 3
      WHERE id = ?
    `)
    .run(completedAtMs, completedAtMs, rollover.id);
  settleJobRun(
    database,
    job,
    "succeeded",
    completedAtMs
  );
}

function recoveryRecord(ids, fixture, overrides = {}) {
  return {
    id: uuid(numericId(ids.league) + 800),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    player_id: fixture.allocation.player_id,
    allocation_id: fixture.allocation.id,
    rollover_id: null,
    auction_id: null,
    job_run_id: fixture.jobs.allocation.id,
    supersedes_recovery_id: null,
    causal_started_at_ms: null,
    kind: "allocation_retry",
    status: "pending",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: "ALLOCATION_FAILED",
    commissioner_reason: null,
    created_by_operation_id: "allocation-attempt-1",
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: CANDIDATE_DEADLINE_AT_MS + 20,
    updated_at_ms: CANDIDATE_DEADLINE_AT_MS + 20,
    resolved_at_ms: null,
    version: 1,
    ...overrides,
  };
}

function readTables(database, tableNames) {
  return Object.fromEntries(
    tableNames.map((tableName) => [
      tableName,
      database
        .prepare(`SELECT * FROM ${tableName} ORDER BY rowid`)
        .all(),
    ])
  );
}

describe(
  "FAD-01.3 allocation, rollover, recovery, and completion storage",
  () => {
    test("installs fresh and preserves populated schema 24 without fabricating FAD history", (t) => {
      const fresh = createRuntime(t, "hundo-fad-0025-fresh-");
      copyMigrationsThrough(fresh, 25);
      const result = migrate(fresh, "fad-0025-fresh");

      assert.equal(result.status, "exact");
      assert.equal(result.applied.length, 25);
      assert.equal(
        fresh.database.pragma("user_version", { simple: true }),
        25
      );
      assert.equal(
        fresh.database
          .prepare(`
            SELECT metadata_value
            FROM application_metadata
            WHERE metadata_key = 'data_model_version'
          `)
          .get().metadata_value,
        "25"
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
          migration_id: 25,
          file_name:
            "0025_add_free_agent_draft_allocations_rollovers_recoveries.sql",
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
        "hundo-fad-0025-upgrade-"
      );
      copyMigrationsThrough(upgrade, 24);
      migrate(upgrade, "fad-0025-before");
      const ids = seedScenario(upgrade, { base: 1_000 });
      const fixture = setupOpenCard(upgrade.database, ids);
      const existingJob = jobRunRecord(
        ids,
        uuid(1_900),
        "legacy_fad_probe",
        "legacy:fad:probe",
        CANDIDATE_DEADLINE_AT_MS
      );
      insert(upgrade.database, "job_runs", existingJob);
      insert(upgrade.database, "commissioner_corrections", {
        id: uuid(1_901),
        league_id: ids.league,
        season_id: ids.targetSeason,
        feature: "legacy_fad_probe",
        feature_record_id: fixture.fad.id,
        actor_user_id: ids.commissionerUser,
        reason: "Preserve this existing correction.",
        before_snapshot_json: "{}",
        after_snapshot_json: "{}",
        corrected_at_ms: OPENED_AT_MS + 1,
      });
      upgrade.database
        .prepare(`
          UPDATE seasons
          SET free_agent_draft_completed_at_ms = 123
          WHERE id = ?
        `)
        .run(ids.targetSeason);
      const preservedTables = [
        "candidate_card_revisions",
        "candidate_cards",
        "commissioner_corrections",
        "free_agent_draft_teams",
        "free_agent_drafts",
        "job_runs",
        "seasons",
      ];
      const before = readTables(
        upgrade.database,
        preservedTables
      );

      copyMigrationsThrough(upgrade, 25);
      migrate(upgrade, "fad-0025-upgrade");

      assert.equal(
        upgrade.database.pragma("user_version", {
          simple: true,
        }),
        25
      );
      assert.deepEqual(
        readTables(upgrade.database, preservedTables),
        before
      );
      assert.equal(
        upgrade.database
          .prepare(`
            SELECT free_agent_draft_completed_at_ms
            FROM seasons
            WHERE id = ?
          `)
          .get(ids.targetSeason).free_agent_draft_completed_at_ms,
        123
      );
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

    test("moves a zero-Candidate deadline directly into rapid", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-zero-candidates-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-zero-candidates");
      const ids = seedScenario(runtime, { base: 23_000 });
      const fixture = setupOpenCard(runtime.database, ids);
      fixture.rollovers = seedRollovers(
        runtime.database,
        ids,
        fixture.fad.id
      );
      fixture.jobs = seedDurableJobs(
        runtime.database,
        ids,
        fixture,
        { player_id: uuid(230_000) },
        { omit: "allocation" }
      );
      runtime.database
        .prepare(`
          UPDATE candidate_cards
          SET status = 'locked_incomplete',
              locked_at_ms = ?,
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          CANDIDATE_DEADLINE_AT_MS,
          CANDIDATE_DEADLINE_AT_MS,
          fixture.card.id
        );
      insert(
        runtime.database,
        "candidate_card_revisions",
        revisionRecord(ids, fixture.fad.id, fixture.card.id, {
          id: uuid(23_106),
          resulting_card_version: 2,
          action: "deadline_locked",
          before_evidence_json: '{"status":"open"}',
          after_evidence_json:
            '{"status":"locked_incomplete"}',
          occurred_at_ms: CANDIDATE_DEADLINE_AT_MS,
          created_at_ms: CANDIDATE_DEADLINE_AT_MS,
        })
      );
      fixture.snapshot = {
        ...snapshotRecord(
          ids,
          fixture.fad.id,
          fixture.card.id,
          2
        ),
        filled_mandatory_count: 0,
        missing_mandatory_count: 18,
        proposed_candidate_aav_cents: 0,
        maximum_possible_cap_cents: 0,
        maximum_cap_space_cents: 10_000,
      };
      insert(
        runtime.database,
        "candidate_card_snapshots",
        fixture.snapshot
      );
      let sequence = 0;
      for (const [slotGroup, maximum] of [
        ["F", 12],
        ["D", 6],
        ["B", 4],
      ]) {
        for (
          let slotNumber = 1;
          slotNumber <= maximum;
          slotNumber += 1
        ) {
          sequence += 1;
          insert(
            runtime.database,
            "candidate_card_snapshot_entries",
            emptySnapshotEntry(
              ids,
              fixture,
              slotGroup,
              slotNumber,
              sequence
            )
          );
        }
      }
      leaseJob(
        runtime.database,
        fixture.jobs.deadline,
        SNAPSHOT_AT_MS
      );
      lockDeadline(runtime.database, fixture);
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'rapid',
              allocation_completed_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          CANDIDATE_DEADLINE_AT_MS + 30,
          CANDIDATE_DEADLINE_AT_MS + 30,
          fixture.fad.id
        );
      settleJobRun(
        runtime.database,
        fixture.jobs.deadline,
        "succeeded",
        CANDIDATE_DEADLINE_AT_MS + 30
      );

      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_player_allocations
            WHERE fad_id = ?
          `)
          .get(fixture.fad.id).count,
        0
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM free_agent_drafts
            WHERE id = ?
          `)
          .get(fixture.fad.id).status,
        "rapid"
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM job_runs
            WHERE league_id = ?
              AND season_id = ?
              AND job_type = 'fad_allocation'
          `)
          .get(ids.league, ids.targetSeason).count,
        0
      );

      for (const rollover of fixture.rollovers) {
        completeRollover(
          runtime.database,
          rollover,
          fixture.jobs[`rollover-${rollover.sequence}`]
        );
      }
      const completedAtMs = FIRST_MATCHUP_STARTS_AT_MS + 100;
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        completedAtMs - 1
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 4
          WHERE id = ?
        `)
        .run(
          completedAtMs,
          completedAtMs,
          fixture.fad.id
        );

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, completed_at_ms
            FROM free_agent_drafts
            WHERE id = ?
          `)
          .get(fixture.fad.id),
        {
          status: "completed",
          completed_at_ms: completedAtMs,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT free_agent_draft_completed_at_ms
            FROM seasons
            WHERE id = ?
          `)
          .get(ids.targetSeason)
          .free_agent_draft_completed_at_ms,
        completedAtMs
      );
    });

    test("enforces same-league allocation evidence and immutable correction history", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-allocation-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-allocation");
      const ids = seedScenario(runtime, { base: 2_000 });
      const otherIds = seedScenario(runtime, { base: 2_500 });
      const sharedPlayerId = uuid(90_000);
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        sharedPlayerId,
        {
          entryOverrides: {
            eligibility_status: "invalid",
            validation_code: "PLAYER_UNAVAILABLE",
          },
        }
      );
      const otherFixture = prepareDeadlineFad(
        runtime.database,
        otherIds,
        sharedPlayerId,
        {
          entryOverrides: {
            eligibility_status: "invalid",
            validation_code: "PLAYER_UNAVAILABLE",
          },
        }
      );
      let allocation = fixture.allocation;

      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_player_allocations
            WHERE player_id = ?
          `)
          .get(sharedPlayerId).count,
        2
      );
      assertConstraint(() => {
        insert(
          runtime.database,
          "free_agent_draft_player_allocations",
          allocationRecord(ids, fixture, {
            id: uuid(2_999),
          })
        );
      });
      assertConstraint(() => {
        insert(
          runtime.database,
          "free_agent_draft_player_allocations",
          allocationRecord(otherIds, otherFixture, {
            id: uuid(2_998),
            fad_id: fixture.fad.id,
          })
        );
      });

      startAllocating(runtime.database, fixture);
      assertConstraint(() => {
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_player_allocations
            SET status = 'automatic_award',
                decision_code = 'sole_valid_offer',
                resolved_at_ms = ?,
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            CANDIDATE_DEADLINE_AT_MS + 20,
            CANDIDATE_DEADLINE_AT_MS + 20,
            allocation.id
          );
      });

      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "invalid",
          decision_code: "invalid_snapshot",
          resolved_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 20,
        }
      );
      const offerEvent = allocationOfferEventRecord(
        ids,
        fixture,
        allocation,
        { id: uuid(2_700) }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        offerEvent
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...offerEvent,
              id: uuid(2_701),
              snapshot_entry_id:
                otherFixture.candidateSnapshotEntry.id,
            }
          );
        },
        /same-FAD Candidate snapshot/i
      );
      const decisionEvent = allocationEventRecord(
        ids,
        fixture,
        allocation,
        { id: uuid(2_702) }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        decisionEvent
      );
      finishRapid(runtime.database, fixture);
      const originalDecision = runtime.database
        .prepare(`
          SELECT *
          FROM free_agent_draft_allocation_events
          WHERE id = ?
        `)
        .get(decisionEvent.id);

      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_allocation_events
              SET evidence_json = '{"changed":true}'
              WHERE id = ?
            `)
            .run(decisionEvent.id);
        },
        /immutable/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              DELETE FROM free_agent_draft_allocation_events
              WHERE id = ?
            `)
            .run(decisionEvent.id);
        },
        /immutable/i
      );

      const correctionId = uuid(2_703);
      const correctionAtMs =
        CANDIDATE_DEADLINE_AT_MS + 30;
      insert(runtime.database, "commissioner_corrections", {
        id: correctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        feature: "free_agent_draft_allocation",
        feature_record_id: allocation.id,
        actor_user_id: ids.commissionerUser,
        reason: "Reconcile the deterministic allocation.",
        before_snapshot_json: "{}",
        after_snapshot_json: "{}",
        corrected_at_ms: correctionAtMs,
      });
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "invalid",
          decision_code: "corrected",
          resolved_at_ms: correctionAtMs,
          updated_at_ms: correctionAtMs,
        }
      );
      const correctionEvent = allocationEventRecord(
        ids,
        fixture,
        allocation,
        {
          id: uuid(2_704),
          event_kind: "correction_applied",
          correction_id: correctionId,
          actor_user_id: ids.commissionerUser,
          actor_membership_id:
            ids.commissionerMembership,
          actor_authority: "commissioner",
          occurred_at_ms: correctionAtMs,
          created_at_ms: correctionAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        correctionEvent
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT *
            FROM free_agent_draft_allocation_events
            WHERE id = ?
          `)
          .get(decisionEvent.id),
        originalDecision
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              DELETE FROM free_agent_draft_player_allocations
              WHERE id = ?
            `)
            .run(allocation.id);
        },
        /cannot be deleted/i
      );
    });

    test("requires deterministic total-first offer evidence", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-offer-ranking-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-offer-ranking");
      const ids = seedScenario(runtime, {
        base: 11_000,
        secondTeam: true,
      });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(110_000),
        {
          competingEntryOverrides: {
            proposed_total_value_cents: 800,
            proposed_term_years: 3,
            proposed_aav_cents: 267,
          },
        }
      );
      startAllocating(runtime.database, fixture);
      const resolvedAtMs = CANDIDATE_DEADLINE_AT_MS + 22;
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'correction_required',
                  decision_code = 'highest_total',
                  resolved_at_ms = ?,
                  last_error_code = 'AWARD_FAILED',
                  updated_at_ms = ?,
                  version = 2
              WHERE id = ?
            `)
            .run(
              resolvedAtMs,
              resolvedAtMs + 1,
              fixture.allocation.id
            );
        },
        /approved versioned state/i
      );
      const allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "correction_required",
          decision_code: "highest_total",
          resolved_at_ms: resolvedAtMs,
          last_error_code: "AWARD_FAILED",
          updated_at_ms: resolvedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(11_705),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        })
      );

      const lowerOffer = allocationOfferEventRecord(
        ids,
        fixture,
        allocation,
        {
          id: uuid(11_704),
          rank_position: 2,
          offer_outcome_code: "lost_lower_total",
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        }
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...lowerOffer,
              id: uuid(11_710),
              contract_id: uuid(111_111),
            }
          );
        },
        /cannot carry allocation result resources/i
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...lowerOffer,
              id: uuid(11_711),
              offer_valid: 0,
              rank_position: null,
              offer_outcome_code: "invalid",
            }
          );
        },
        /validity must match its immutable snapshot/i
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...lowerOffer,
              id: uuid(11_712),
              rank_position: 1,
              offer_outcome_code: "winner",
            }
          );
        },
        /rank must match|exact top allocation offer/i
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...lowerOffer,
              id: uuid(11_713),
              offer_outcome_code: "lost_lower_aav",
            }
          );
        },
        /equal-total higher-AAV competitor/i
      );

      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        lowerOffer
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        {
          ...lowerOffer,
          id: uuid(11_754),
          snapshot_entry_id:
            fixture.competingCandidateSnapshotEntry.id,
          team_id:
            fixture.competingCandidateSnapshotEntry.team_id,
          rank_position: 1,
          offer_outcome_code: "winner",
        }
      );
      assertConstraint(
        () => finishRapid(runtime.database, fixture),
        /correction-required allocation recovery/i
      );
    });

    test("accounts preserved Candidate conflicts as immutable invalid offers", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-conflict-offer-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-conflict-offer");
      const ids = seedScenario(runtime, { base: 16_000 });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(160_000),
        {
          entryOverrides: {
            placement_state: "conflict",
            conflict_code: "CARRYOVER_SLOT_CONFLICT",
          },
        }
      );
      startAllocating(runtime.database, fixture);
      const resolvedAtMs = CANDIDATE_DEADLINE_AT_MS + 20;
      const allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "invalid",
          decision_code: "invalid_snapshot",
          resolved_at_ms: resolvedAtMs,
        }
      );
      const offer = allocationOfferEventRecord(
        ids,
        fixture,
        allocation,
        {
          id: uuid(160_701),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        }
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...offer,
              id: uuid(160_703),
              offer_valid: 1,
              rank_position: 1,
              offer_outcome_code: "winner",
            }
          );
        },
        /validity must match its immutable snapshot/i
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...offer,
              id: uuid(160_704),
              rank_position: 1,
            }
          );
        },
        /rank and outcome must match validity/i
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...offer,
              id: uuid(160_700),
              occurred_at_ms: resolvedAtMs + 1,
              created_at_ms: resolvedAtMs + 1,
            }
          );
        },
        /current allocation version/i
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        offer
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(160_702),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        })
      );
      assertConstraint(
        () =>
          finishRapid(
            runtime.database,
            fixture,
            resolvedAtMs - 1
          ),
        /cannot precede current allocation evidence/i
      );
      finishRapid(runtime.database, fixture);

      assert.equal(offer.offer_valid, 0);
      assert.equal(offer.offer_outcome_code, "invalid");
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM free_agent_drafts
            WHERE id = ?
          `)
          .get(fixture.fad.id).status,
        "rapid"
      );
    });

    test("preserves an invalid high offer while the sole valid offer wins", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-mixed-validity-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-mixed-validity");
      const ids = seedScenario(runtime, {
        base: 17_000,
        secondTeam: true,
      });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(170_000),
        {
          entryOverrides: {
            proposed_total_value_cents: 600,
            proposed_term_years: 2,
            proposed_aav_cents: 300,
          },
          competingEntryOverrides: {
            proposed_total_value_cents: 900,
            proposed_term_years: 3,
            proposed_aav_cents: 300,
            eligibility_status: "invalid",
            validation_code: "PLAYER_UNAVAILABLE",
          },
        }
      );
      startAllocating(runtime.database, fixture);
      const resolvedAtMs = CANDIDATE_DEADLINE_AT_MS + 20;
      const allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "correction_required",
          decision_code: "sole_valid_offer",
          resolved_at_ms: resolvedAtMs,
          last_error_code: "AWARD_FAILED",
        }
      );
      const validOffer = allocationOfferEventRecord(
        ids,
        fixture,
        allocation,
        {
          id: uuid(170_701),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        }
      );
      const invalidOffer = {
        ...validOffer,
        id: uuid(170_702),
        snapshot_entry_id:
          fixture.competingCandidateSnapshotEntry.id,
        team_id:
          fixture.competingCandidateSnapshotEntry.team_id,
        offer_valid: 0,
        rank_position: null,
        offer_outcome_code: "invalid",
      };
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        validOffer
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        invalidOffer
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(170_703),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        })
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recoveryRecord(ids, { ...fixture, allocation }, {
          id: uuid(170_801),
          last_error_code: "AWARD_FAILED",
          created_by_operation_id: "mixed-validity-award",
          created_at_ms: resolvedAtMs,
          updated_at_ms: resolvedAtMs,
        })
      );

      finishRapid(runtime.database, fixture);
      assert.equal(validOffer.offer_outcome_code, "winner");
      assert.equal(invalidOffer.offer_valid, 0);
    });

    test("records all-invalid Candidate offers as no valid offer", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-all-invalid-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-all-invalid");
      const ids = seedScenario(runtime, {
        base: 18_000,
        secondTeam: true,
      });
      const invalidEntry = {
        eligibility_status: "invalid",
        validation_code: "PLAYER_UNAVAILABLE",
      };
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(180_000),
        {
          entryOverrides: invalidEntry,
          competingEntryOverrides: invalidEntry,
        }
      );
      startAllocating(runtime.database, fixture);
      const resolvedAtMs = CANDIDATE_DEADLINE_AT_MS + 20;
      const allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "no_valid_offer",
          decision_code: "no_valid_offer",
          resolved_at_ms: resolvedAtMs,
        }
      );
      const offers = insertAllocationOfferEvidence(
        runtime.database,
        ids,
        fixture,
        allocation,
        {
          id: uuid(180_701),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(180_703),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        })
      );

      finishRapid(runtime.database, fixture);
      assert.equal(offers.length, 2);
      assert.ok(offers.every((offer) => offer.offer_valid === 0));
    });

    test("uses AAV second when equal total offers have different terms", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-aav-second-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-aav-second");
      const ids = seedScenario(runtime, {
        base: 19_000,
        secondTeam: true,
      });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(190_000),
        {
          entryOverrides: {
            proposed_total_value_cents: 600,
            proposed_term_years: 2,
            proposed_aav_cents: 300,
          },
          competingEntryOverrides: {
            proposed_total_value_cents: 600,
            proposed_term_years: 3,
            proposed_aav_cents: 200,
          },
        }
      );
      startAllocating(runtime.database, fixture);
      const resolvedAtMs = CANDIDATE_DEADLINE_AT_MS + 20;
      const allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "correction_required",
          decision_code: "highest_equal_total_aav",
          resolved_at_ms: resolvedAtMs,
          last_error_code: "AWARD_FAILED",
        }
      );
      const winner = allocationOfferEventRecord(
        ids,
        fixture,
        allocation,
        {
          id: uuid(190_701),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        }
      );
      const lowerAav = {
        ...winner,
        id: uuid(190_702),
        snapshot_entry_id:
          fixture.competingCandidateSnapshotEntry.id,
        team_id:
          fixture.competingCandidateSnapshotEntry.team_id,
        rank_position: 2,
        offer_outcome_code: "lost_lower_aav",
      };
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        winner
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        lowerAav
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(190_703),
          occurred_at_ms: resolvedAtMs,
          created_at_ms: resolvedAtMs,
        })
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recoveryRecord(ids, { ...fixture, allocation }, {
          id: uuid(190_801),
          last_error_code: "AWARD_FAILED",
          created_by_operation_id: "equal-total-aav-second",
          created_at_ms: resolvedAtMs,
          updated_at_ms: resolvedAtMs,
        })
      );

      finishRapid(runtime.database, fixture);
      assert.equal(winner.offer_outcome_code, "winner");
      assert.equal(lowerAav.offer_outcome_code, "lost_lower_aav");
    });

    test("keeps locked deterministic ranking authoritative during corrections", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-corrected-ranking-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-corrected-ranking");
      const ids = seedScenario(runtime, {
        base: 24_000,
        secondTeam: true,
      });
      runtime.database
        .prepare(`
          UPDATE seasons
          SET nhl_season_key = '20262027'
          WHERE id = ?
        `)
        .run(ids.targetSeason);
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(240_000),
        {
          entryOverrides: {
            proposed_total_value_cents: 700,
            proposed_term_years: 1,
            proposed_aav_cents: 700,
          },
          competingEntryOverrides: {
            proposed_total_value_cents: 600,
            proposed_term_years: 1,
            proposed_aav_cents: 600,
          },
        }
      );
      startAllocating(runtime.database, fixture);
      const failedAtMs = CANDIDATE_DEADLINE_AT_MS + 22;
      let allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "correction_required",
          decision_code: "highest_total",
          resolved_at_ms: failedAtMs,
          last_error_code: "AWARD_FAILED",
          updated_at_ms: failedAtMs,
        }
      );
      const topOffer = allocationOfferEventRecord(
        ids,
        fixture,
        allocation,
        {
          id: uuid(240_701),
          occurred_at_ms: failedAtMs,
          created_at_ms: failedAtMs,
        }
      );
      const lowerOffer = {
        ...topOffer,
        id: uuid(240_702),
        snapshot_entry_id:
          fixture.competingCandidateSnapshotEntry.id,
        team_id:
          fixture.competingCandidateSnapshotEntry.team_id,
        rank_position: 2,
        offer_outcome_code: "lost_lower_total",
      };
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        topOffer
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        lowerOffer
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(240_703),
          occurred_at_ms: failedAtMs,
          created_at_ms: failedAtMs,
        })
      );
      const allocationRetryRecovery = recoveryRecord(
        ids,
        { ...fixture, allocation },
        {
          id: uuid(240_800),
          last_error_code: "AWARD_FAILED",
          created_by_operation_id: "corrected-ranking-1",
          created_at_ms: failedAtMs,
          updated_at_ms: failedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        allocationRetryRecovery
      );
      finishRapid(runtime.database, fixture);

      const correctionAtMs = CANDIDATE_DEADLINE_AT_MS + 100;
      const uniqueTopAuctionId = uuid(240_750);
      insert(runtime.database, "auctions", {
        id: uniqueTopAuctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        player_id: allocation.player_id,
        status: "open",
        opened_at_ms: correctionAtMs - 2,
        resolves_at_ms: correctionAtMs - 1,
        opened_by_user_id: null,
        created_at_ms: correctionAtMs - 2,
        updated_at_ms: correctionAtMs - 2,
        version: 1,
      });
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'no_winner',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(correctionAtMs - 1, uniqueTopAuctionId);
      assertConstraint(
        () => updateAllocation(
          runtime.database,
          allocation,
          {
            status: "restricted_resolved",
            decision_code: "corrected",
            restricted_auction_id: uniqueTopAuctionId,
            resolved_at_ms: correctionAtMs,
            last_error_code: null,
            updated_at_ms: correctionAtMs,
          }
        ),
        /exact deterministic top tie/i
      );
      for (const status of ["no_valid_offer", "invalid"]) {
        assertConstraint(
          () => updateAllocation(
            runtime.database,
            allocation,
            {
              status,
              decision_code: "corrected",
              restricted_auction_id: null,
              resolved_at_ms: correctionAtMs,
              last_error_code: null,
              updated_at_ms: correctionAtMs,
            }
          ),
          /cannot discard a valid snapshot offer/i
        );
      }

      const insertAwardResources = (
        offer,
        teamId,
        idBase
      ) => {
        const contractId = uuid(idBase);
        const ownershipId = uuid(idBase + 1);
        insert(runtime.database, "contracts", {
          id: contractId,
          league_id: ids.league,
          player_id: allocation.player_id,
          current_team_id: teamId,
          contract_type: "normal",
          original_total_value_cents:
            offer.proposed_total_value_cents,
          original_term_years: offer.proposed_term_years,
          aav_cents: offer.proposed_aav_cents,
          start_season_id: ids.targetSeason,
          status: "active",
          acquisition_source_type:
            "free_agent_draft_allocation",
          acquisition_source_id: allocation.id,
          auction_buyout_lock_expires_at_ms:
            correctionAtMs + 14 * DAY_MS,
          created_at_ms: correctionAtMs,
          updated_at_ms: correctionAtMs,
          version: 1,
        });
        insert(runtime.database, "player_ownerships", {
          id: ownershipId,
          league_id: ids.league,
          season_id: ids.targetSeason,
          player_id: allocation.player_id,
          team_id: teamId,
          ownership_kind: "Rostered",
          roster_category:
            offer.slot_group === "B" ? "Bench" : "Active",
          position_group: offer.effective_position_group,
          slot_number: offer.slot_number,
          acquired_transaction_type:
            "free_agent_draft_allocation",
          acquired_transaction_id: allocation.id,
          created_at_ms: correctionAtMs,
          updated_at_ms: correctionAtMs,
          version: 1,
          trade_blocked: 0,
        });
        insert(runtime.database, "contract_years", {
          id: uuid(idBase + 2),
          league_id: ids.league,
          contract_id: contractId,
          season_id: ids.targetSeason,
          year_number: 1,
          aav_cents: offer.proposed_aav_cents,
          status: "current",
          rollover_at_ms: null,
          created_at_ms: correctionAtMs,
        });
        return { contractId, ownershipId };
      };

      runtime.database.exec("BEGIN");
      try {
        const retryResources = insertAwardResources(
          fixture.candidateSnapshotEntry,
          ids.team,
          240_780
        );
        assertConstraint(
          () => updateAllocation(
            runtime.database,
            allocation,
            {
              status: "automatic_award",
              decision_code: "highest_total",
              winning_snapshot_entry_id:
                fixture.candidateSnapshotEntry.id,
              winning_team_id: ids.team,
              contract_id: retryResources.contractId,
              ownership_id: retryResources.ownershipId,
              restricted_auction_id: null,
              resolved_at_ms: correctionAtMs,
              last_error_code: null,
              updated_at_ms: correctionAtMs,
            }
          ),
          /exact active recovery lease/i
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(correctionAtMs, allocationRetryRecovery.id);
        expireJobLease(
          runtime.database,
          fixture.jobs.allocation,
          correctionAtMs - 1
        );
        assertConstraint(
          () => updateAllocation(
            runtime.database,
            allocation,
            {
              status: "automatic_award",
              decision_code: "highest_total",
              winning_snapshot_entry_id:
                fixture.candidateSnapshotEntry.id,
              winning_team_id: ids.team,
              contract_id: retryResources.contractId,
              ownership_id: retryResources.ownershipId,
              restricted_auction_id: null,
              resolved_at_ms: correctionAtMs,
              last_error_code: null,
              updated_at_ms: correctionAtMs,
            }
          ),
          /exact active recovery lease/i
        );
        leaseJob(
          runtime.database,
          fixture.jobs.allocation,
          correctionAtMs
        );
        const retriedAllocation = updateAllocation(
          runtime.database,
          allocation,
          {
            status: "automatic_award",
            decision_code: "highest_total",
            winning_snapshot_entry_id:
              fixture.candidateSnapshotEntry.id,
            winning_team_id: ids.team,
            contract_id: retryResources.contractId,
            ownership_id: retryResources.ownershipId,
            restricted_auction_id: null,
            resolved_at_ms: correctionAtMs,
            last_error_code: null,
            updated_at_ms: correctionAtMs,
          }
        );
        insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          allocationEventRecord(
            ids,
            fixture,
            retriedAllocation,
            {
              id: uuid(240_786),
              occurred_at_ms: correctionAtMs,
              created_at_ms: correctionAtMs,
            }
          )
        );
        for (const rollover of fixture.rollovers) {
          completeRollover(
            runtime.database,
            rollover,
            fixture.jobs[`rollover-${rollover.sequence}`]
          );
        }
        const retryCompletionAtMs =
          FIRST_MATCHUP_STARTS_AT_MS + 100;
        leaseJob(
          runtime.database,
          fixture.jobs.completion,
          retryCompletionAtMs - 1
        );
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE free_agent_drafts
                SET status = 'completed',
                    completed_at_ms = ?,
                    updated_at_ms = ?,
                    version = 5
                WHERE id = ?
              `)
              .run(
                retryCompletionAtMs,
                retryCompletionAtMs,
                fixture.fad.id
              );
          },
          /terminal allocation cannot retain unresolved recovery/i
        );

        const assertRecoveredAllocationJobBlocksCompletion = (
          resolvedAtMs,
          jobErrorCode
        ) => {
          runtime.database.exec(
            "SAVEPOINT malformed_allocation_job"
          );
          try {
            runtime.database
              .prepare(`
                UPDATE free_agent_draft_recoveries
                SET status = 'resolved',
                    resolved_authority = 'system',
                    resolved_at_ms = ?,
                    updated_at_ms = ?,
                    version = 3
                WHERE id = ?
              `)
              .run(
                resolvedAtMs,
                resolvedAtMs,
                allocationRetryRecovery.id
              );
            settleJobRun(
              runtime.database,
              fixture.jobs.allocation,
              "failed",
              retryCompletionAtMs - 1,
              jobErrorCode
            );
            assertConstraint(
              () => {
                runtime.database
                  .prepare(`
                    UPDATE free_agent_drafts
                    SET status = 'completed',
                        completed_at_ms = ?,
                        updated_at_ms = ?,
                        version = 5
                    WHERE id = ?
                  `)
                  .run(
                    retryCompletionAtMs,
                    retryCompletionAtMs,
                    fixture.fad.id
                  );
              },
              /terminal allocation occurrences/i
            );
          } finally {
            runtime.database.exec(
              "ROLLBACK TO malformed_allocation_job"
            );
            runtime.database.exec(
              "RELEASE malformed_allocation_job"
            );
          }
        };
        assertRecoveredAllocationJobBlocksCompletion(
          retryCompletionAtMs + 1,
          "AWARD_FAILED"
        );
        assertRecoveredAllocationJobBlocksCompletion(
          retryCompletionAtMs - 1,
          "MISMATCHED_ALLOCATION_FAILURE"
        );

        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'resolved',
                resolved_authority = 'system',
                resolved_at_ms = ?,
                updated_at_ms = ?,
                version = 3
            WHERE id = ?
          `)
          .run(
            retryCompletionAtMs - 1,
            retryCompletionAtMs - 1,
            allocationRetryRecovery.id
          );
        settleJobRun(
          runtime.database,
          fixture.jobs.allocation,
          "succeeded",
          retryCompletionAtMs - 1
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_drafts
            SET status = 'completed',
                completed_at_ms = ?,
                updated_at_ms = ?,
                version = 5
            WHERE id = ?
          `)
          .run(
            retryCompletionAtMs,
            retryCompletionAtMs,
            fixture.fad.id
          );
        const postCompletionFailureAtMs =
          retryCompletionAtMs + 1;
        assertConstraint(
          () => insert(
            runtime.database,
            "free_agent_draft_recoveries",
            recoveryRecord(ids, {
              ...fixture,
              allocation: retriedAllocation,
            }, {
              id: uuid(240_806),
              last_error_code:
                "POST_COMPLETION_CORRECTION_FAILED",
              created_by_operation_id:
                "post-completion-reconciliation-failed",
              created_at_ms: postCompletionFailureAtMs,
              updated_at_ms: postCompletionFailureAtMs,
            })
          ),
          /exact causal occurrence/i
        );
        assertConstraint(
          () => updateAllocation(
            runtime.database,
            retriedAllocation,
            {
              status: "correction_required",
              decision_code: "highest_total",
              resolved_at_ms: postCompletionFailureAtMs,
              last_error_code:
                "POST_COMPLETION_CORRECTION_FAILED",
              updated_at_ms: postCompletionFailureAtMs,
            }
          ),
          /terminal allocation failure requires exact durable recovery/i
        );
        assert.equal(retriedAllocation.status, "automatic_award");
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status, resolved_authority
              FROM free_agent_draft_recoveries
              WHERE id = ?
            `)
            .get(allocationRetryRecovery.id),
          {
            status: "resolved",
            resolved_authority: "system",
          }
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }

      runtime.database.exec("BEGIN");
      try {
        const lowerResources = insertAwardResources(
          fixture.competingCandidateSnapshotEntry,
          ids.secondTeam,
          240_760
        );
        assertConstraint(
          () => updateAllocation(
            runtime.database,
            allocation,
            {
              status: "automatic_award",
              decision_code: "corrected",
              winning_snapshot_entry_id:
                fixture.competingCandidateSnapshotEntry.id,
              winning_team_id: ids.secondTeam,
              contract_id: lowerResources.contractId,
              ownership_id: lowerResources.ownershipId,
              restricted_auction_id: null,
              resolved_at_ms: correctionAtMs,
              last_error_code: null,
              updated_at_ms: correctionAtMs,
            }
          ),
          /unique deterministic top offer/i
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }

      const correctionId = uuid(240_790);
      insert(runtime.database, "commissioner_corrections", {
        id: correctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        feature: "free_agent_draft_allocation",
        feature_record_id: allocation.id,
        actor_user_id: ids.commissionerUser,
        reason: "Recompute the locked deterministic ranking.",
        before_snapshot_json: "{}",
        after_snapshot_json: "{}",
        corrected_at_ms: correctionAtMs,
      });
      const topResources = insertAwardResources(
        fixture.candidateSnapshotEntry,
        ids.team,
        240_770
      );
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "automatic_award",
          decision_code: "corrected",
          winning_snapshot_entry_id:
            fixture.candidateSnapshotEntry.id,
          winning_team_id: ids.team,
          contract_id: topResources.contractId,
          ownership_id: topResources.ownershipId,
          restricted_auction_id: null,
          resolved_at_ms: correctionAtMs,
          last_error_code: null,
          updated_at_ms: correctionAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(240_791),
          event_kind: "correction_applied",
          correction_id: correctionId,
          actor_user_id: ids.commissionerUser,
          actor_membership_id:
            ids.commissionerMembership,
          actor_authority: "commissioner",
          occurred_at_ms: correctionAtMs,
          created_at_ms: correctionAtMs,
        })
      );
      const correctionFailureAtMs = correctionAtMs + 1;
      const moveCorrectedAllocationToRecovery = () =>
        updateAllocation(
          runtime.database,
          allocation,
          {
            status: "correction_required",
            decision_code: "corrected",
            resolved_at_ms: correctionFailureAtMs,
            last_error_code: "CORRECTION_FAILED",
            updated_at_ms: correctionFailureAtMs,
          }
        );
      runtime.database.exec("BEGIN");
      try {
        runtime.database
          .prepare(`
            UPDATE job_runs
            SET status = 'pending',
                attempt_count = 0,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                lease_token = NULL,
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            correctionFailureAtMs,
            fixture.jobs.allocation.id
          );
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          recoveryRecord(ids, {
            ...fixture,
            allocation,
          }, {
            id: uuid(240_807),
            last_error_code: "CORRECTION_FAILED",
            created_by_operation_id:
              "unattempted-correction-failure",
            created_at_ms: correctionFailureAtMs,
            updated_at_ms: correctionFailureAtMs,
          })
        );
        assertConstraint(
          moveCorrectedAllocationToRecovery,
          /terminal allocation failure requires exact durable recovery/i
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }
      assertConstraint(
        moveCorrectedAllocationToRecovery,
        /terminal allocation failure requires exact durable recovery/i
      );
      runtime.database.exec("BEGIN");
      try {
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          recoveryRecord(ids, {
            ...fixture,
            allocation,
          }, {
            id: uuid(240_805),
            last_error_code: "CORRECTION_FAILED",
            created_by_operation_id:
              "corrected-allocation-reconcile-failed",
            created_at_ms: correctionFailureAtMs,
            updated_at_ms: correctionFailureAtMs,
          })
        );
        const quarantinedAllocation =
          moveCorrectedAllocationToRecovery();
        assert.equal(
          quarantinedAllocation.status,
          "correction_required"
        );
        assert.equal(
          quarantinedAllocation.contract_id,
          allocation.contract_id
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }
      assert.equal(
        allocation.winning_snapshot_entry_id,
        fixture.candidateSnapshotEntry.id
      );
    });

    test("requires a complete canonical automatic-award contract schedule", (t) => {
      for (const termYears of [1, 2, 3]) {
        const base = 14_000 + termYears * 1_000;
        const runtime = createRuntime(
          t,
          `hundo-fad-0025-contract-${termYears}-`
        );
        copyMigrationsThrough(runtime, 25);
        migrate(runtime, `fad-0025-contract-${termYears}`);
        const ids = seedScenario(runtime, { base });
        runtime.database
          .prepare(`
            UPDATE seasons
            SET nhl_season_key = '20262027'
            WHERE id = ?
          `)
          .run(ids.targetSeason);
        const futureSeasons = [
          {
            id: uuid(base + 770),
            label: "2027-28",
            nhl_season_key: "20272028",
          },
          {
            id: uuid(base + 771),
            label: "2028-29",
            nhl_season_key: "20282029",
          },
        ];
        for (const season of futureSeasons) {
          insert(runtime.database, "seasons", {
            ...season,
            league_id: ids.league,
            status: "planned",
            regular_season_starts_at_ms: null,
            regular_season_ends_at_ms: null,
            fantasy_playoffs_start_at_ms: null,
            fantasy_playoffs_end_at_ms: null,
            created_at_ms: 30,
            updated_at_ms: 30,
            version: 1,
          });
        }
        const totalValueCents = 600;
        const aavCents = totalValueCents / termYears;
        const fixture = prepareDeadlineFad(
          runtime.database,
          ids,
          uuid(base + 9_000),
          {
            entryOverrides: {
              proposed_total_value_cents: totalValueCents,
              proposed_term_years: termYears,
              proposed_aav_cents: aavCents,
            },
          }
        );
        startAllocating(runtime.database, fixture);
        const resolvedAtMs = CANDIDATE_DEADLINE_AT_MS + 22;
        const contractId = uuid(base + 750);
        const ownershipId = uuid(base + 751);
        insert(runtime.database, "contracts", {
          id: contractId,
          league_id: ids.league,
          player_id: fixture.entry.player_id,
          current_team_id: ids.team,
          contract_type: "normal",
          original_total_value_cents: totalValueCents,
          original_term_years: termYears,
          aav_cents: aavCents,
          start_season_id: ids.targetSeason,
          status: "active",
          acquisition_source_type:
            "free_agent_draft_allocation",
          acquisition_source_id: fixture.allocation.id,
          auction_buyout_lock_expires_at_ms:
            resolvedAtMs + 14 * DAY_MS,
          created_at_ms: resolvedAtMs,
          updated_at_ms: resolvedAtMs,
          version: 1,
        });
        insert(runtime.database, "player_ownerships", {
          id: ownershipId,
          league_id: ids.league,
          season_id: ids.targetSeason,
          player_id: fixture.entry.player_id,
          team_id: ids.team,
          ownership_kind: "Rostered",
          roster_category: "Active",
          position_group: "F",
          slot_number: 1,
          acquired_transaction_type:
            "free_agent_draft_allocation",
          acquired_transaction_id: fixture.allocation.id,
          created_at_ms: resolvedAtMs,
          updated_at_ms: resolvedAtMs,
          version: 1,
          trade_blocked: 0,
        });

        const insertContractYear = (
          yearNumber,
          overrides = {}
        ) => {
          const seasonId =
            yearNumber === 1
              ? ids.targetSeason
              : futureSeasons[yearNumber - 2].id;
          const contractYear = {
            id: uuid(base + 760 + yearNumber),
            league_id: ids.league,
            contract_id: contractId,
            season_id: seasonId,
            year_number: yearNumber,
            aav_cents: aavCents,
            status: yearNumber === 1 ? "current" : "future",
            rollover_at_ms: null,
            created_at_ms: resolvedAtMs,
            ...overrides,
          };
          insert(
            runtime.database,
            "contract_years",
            contractYear
          );
          return contractYear;
        };
        const awardChanges = {
          status: "automatic_award",
          decision_code: "sole_valid_offer",
          winning_snapshot_entry_id:
            fixture.candidateSnapshotEntry.id,
          winning_team_id: ids.team,
          contract_id: contractId,
          ownership_id: ownershipId,
          resolved_at_ms: resolvedAtMs,
          updated_at_ms: resolvedAtMs,
        };
        let lastContractYear = null;

        if (termYears === 3) {
          insertContractYear(1);
          insertContractYear(2);
          assertConstraint(
            () => updateAllocation(
              runtime.database,
              fixture.allocation,
              awardChanges
            ),
            /exact contract and requested slot/i
          );
          const thirdYear = insertContractYear(3, {
            status: "current",
            created_at_ms: resolvedAtMs + 1,
          });
          lastContractYear = thirdYear;
          assertConstraint(
            () => updateAllocation(
              runtime.database,
              fixture.allocation,
              awardChanges
            ),
            /exact contract and requested slot/i
          );
          runtime.database
            .prepare(`
              UPDATE contract_years
              SET status = 'future'
              WHERE id = ?
            `)
            .run(thirdYear.id);
          assertConstraint(
            () => updateAllocation(
              runtime.database,
              fixture.allocation,
              awardChanges
            ),
            /exact contract and requested slot/i
          );
          runtime.database
            .prepare(`
              UPDATE contract_years
              SET created_at_ms = ?
              WHERE id = ?
            `)
            .run(resolvedAtMs, thirdYear.id);
          runtime.database
            .prepare(`
              UPDATE contract_years
              SET aav_cents = aav_cents + 1
              WHERE id = ?
            `)
            .run(thirdYear.id);
          assertConstraint(
            () => updateAllocation(
              runtime.database,
              fixture.allocation,
              awardChanges
            ),
            /exact contract and requested slot/i
          );
          runtime.database
            .prepare(`
              UPDATE contract_years
              SET aav_cents = ?
              WHERE id = ?
            `)
            .run(aavCents, thirdYear.id);
          runtime.database
            .prepare(`
              UPDATE contract_years
              SET rollover_at_ms = ?
              WHERE id = ?
            `)
            .run(resolvedAtMs + 1, thirdYear.id);
          assertConstraint(
            () => updateAllocation(
              runtime.database,
              fixture.allocation,
              awardChanges
            ),
            /exact contract and requested slot/i
          );
          runtime.database
            .prepare(`
              UPDATE contract_years
              SET rollover_at_ms = NULL
              WHERE id = ?
            `)
            .run(thirdYear.id);
          runtime.database
            .prepare(`
              UPDATE seasons
              SET label = '2029-30',
                  nhl_season_key = '20292030'
              WHERE id = ?
            `)
            .run(futureSeasons[1].id);
          assertConstraint(
            () => updateAllocation(
              runtime.database,
              fixture.allocation,
              awardChanges
            ),
            /exact contract and requested slot/i
          );
          runtime.database
            .prepare(`
              UPDATE seasons
              SET label = '2028-29',
                  nhl_season_key = '20282029'
              WHERE id = ?
            `)
            .run(futureSeasons[1].id);
        } else {
          for (
            let yearNumber = 1;
            yearNumber <= termYears;
            yearNumber += 1
          ) {
            lastContractYear = insertContractYear(yearNumber);
          }
        }

        if (termYears === 2) {
          const extraYear = insertContractYear(3);
          assertConstraint(
            () => updateAllocation(
              runtime.database,
              fixture.allocation,
              awardChanges
            ),
            /exact contract and requested slot/i
          );
          runtime.database
            .prepare(`
              DELETE FROM contract_years
              WHERE id = ?
            `)
            .run(extraYear.id);
        }

        const allocation = updateAllocation(
          runtime.database,
          fixture.allocation,
          awardChanges
        );
        insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          allocationOfferEventRecord(
            ids,
            fixture,
            allocation,
            {
              id: uuid(base + 780),
              occurred_at_ms: resolvedAtMs,
              created_at_ms: resolvedAtMs,
            }
          )
        );
        insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          allocationEventRecord(ids, fixture, allocation, {
            id: uuid(base + 781),
            occurred_at_ms: resolvedAtMs,
            created_at_ms: resolvedAtMs,
          })
        );
        if (termYears === 3) {
          runtime.database
            .prepare(`
              UPDATE contract_years
              SET aav_cents = aav_cents + 1
              WHERE id = ?
            `)
            .run(lastContractYear.id);
          assertConstraint(
            () => finishRapid(runtime.database, fixture),
            /durable automatic-award resources/i
          );
          runtime.database
            .prepare(`
              UPDATE contract_years
              SET aav_cents = ?
              WHERE id = ?
            `)
            .run(aavCents, lastContractYear.id);
        }
        finishRapid(runtime.database, fixture);
        if (termYears === 2) {
          assertConstraint(
            () => updateAllocation(
              runtime.database,
              allocation,
              {
                status: "automatic_award",
                decision_code: "corrected",
                resolved_at_ms: resolvedAtMs + 100,
                updated_at_ms: resolvedAtMs + 100,
              }
            ),
            /exact contract and requested slot/i
          );
        }
        if (termYears === 1) {
          for (const rollover of fixture.rollovers) {
            completeRollover(
              runtime.database,
              rollover,
              fixture.jobs[`rollover-${rollover.sequence}`]
            );
          }
          runtime.database
            .prepare(`
              UPDATE player_ownerships
              SET slot_number = 2,
                  updated_at_ms = ?,
                  version = version + 1
              WHERE id = ?
            `)
            .run(
              FIRST_MATCHUP_STARTS_AT_MS + 3,
              ownershipId
            );
          leaseJob(
            runtime.database,
            fixture.jobs.completion,
            FIRST_MATCHUP_STARTS_AT_MS + 9
          );
          assertConstraint(
            () => {
              runtime.database
                .prepare(`
                  UPDATE free_agent_drafts
                  SET status = 'completed',
                      completed_at_ms = ?,
                      updated_at_ms = ?,
                      version = 5
                  WHERE id = ?
                `)
                .run(
                  FIRST_MATCHUP_STARTS_AT_MS + 10,
                  FIRST_MATCHUP_STARTS_AT_MS + 10,
                  fixture.fad.id
                );
            },
            /durable automatic-award resources/i
          );
          runtime.database
            .prepare(`
              UPDATE player_ownerships
              SET slot_number = 1,
                  updated_at_ms = ?,
                  version = version + 1
              WHERE id = ?
            `)
            .run(
              FIRST_MATCHUP_STARTS_AT_MS + 11,
              ownershipId
            );
          leaseJob(
            runtime.database,
            fixture.jobs.completion,
            FIRST_MATCHUP_STARTS_AT_MS + 19
          );
          runtime.database
            .prepare(`
              UPDATE free_agent_drafts
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 5
              WHERE id = ?
            `)
            .run(
              FIRST_MATCHUP_STARTS_AT_MS + 20,
              FIRST_MATCHUP_STARTS_AT_MS + 20,
              fixture.fad.id
            );
        }
      }
    });

    test("defers an exact-tie correction only after the final cutoff", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-correction-deferred-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-correction-deferred");
      const ids = seedScenario(runtime, {
        base: 13_000,
        secondTeam: true,
      });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(130_000)
      );
      startAllocating(runtime.database, fixture);
      const correctionAtMs = CANDIDATE_DEADLINE_AT_MS + 22;
      let allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "correction_required",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: correctionAtMs,
          last_error_code: "RESTRICTED_ACTIVATION_FAILED",
          updated_at_ms: correctionAtMs,
        }
      );
      insertAllocationOfferEvidence(
        runtime.database,
        ids,
        fixture,
        allocation,
        {
          id: uuid(13_704),
          offer_outcome_code: "restricted_tied",
          occurred_at_ms: correctionAtMs,
          created_at_ms: correctionAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(13_705),
          occurred_at_ms: correctionAtMs,
          created_at_ms: correctionAtMs,
        })
      );
      const restrictedActivationAtMs =
        fixture.rollovers[0].rolls_over_at_ms;
      const restrictedResolutionAtMs =
        fixture.rollovers[1].rolls_over_at_ms;
      const restrictedActivationJob = jobRunRecord(
        ids,
        uuid(13_630),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${restrictedActivationAtMs}`,
        restrictedActivationAtMs
      );
      insert(
        runtime.database,
        "job_runs",
        restrictedActivationJob
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recoveryRecord(ids, {
          ...fixture,
          allocation,
        }, {
          id: uuid(13_800),
          rollover_id: fixture.rollovers[1].id,
          job_run_id: restrictedActivationJob.id,
          kind: "restricted_activation",
          earliest_activation_at_ms: restrictedActivationAtMs,
          target_resolution_at_ms: restrictedResolutionAtMs,
          last_error_code: "RESTRICTED_ACTIVATION_FAILED",
          created_by_operation_id:
            "restricted-activation-correction-1",
          created_at_ms: correctionAtMs,
          updated_at_ms: correctionAtMs,
        })
      );
      finishRapid(runtime.database, fixture);

      const finalCutoffAtMs =
        fixture.rollovers[6].creation_cutoff_at_ms;
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'deferred_restricted_recovery',
                  decision_code = 'exact_total_and_term_tie',
                  resolved_at_ms = ?,
                  last_error_code =
                    'FAIR_WINDOW_UNAVAILABLE',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              finalCutoffAtMs,
              finalCutoffAtMs,
              allocation.id
            );
        },
        /exact due activation recovery lease/i
      );
      const scheduledAtMs =
        fixture.rollovers[0].creation_cutoff_at_ms + 1;
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "restricted_scheduled",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: scheduledAtMs,
          last_error_code: null,
          updated_at_ms: scheduledAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(13_706),
          occurred_at_ms: scheduledAtMs,
          created_at_ms: scheduledAtMs,
        })
      );
      const arbitraryActivationAtMs =
        fixture.rollovers[2].rolls_over_at_ms;
      const arbitraryResolutionAtMs =
        finalCutoffAtMs + DAY_MS;
      const arbitraryActivationJob = jobRunRecord(
        ids,
        uuid(13_632),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${arbitraryActivationAtMs}`,
        arbitraryActivationAtMs
      );
      runtime.database.exec(
        "SAVEPOINT fad_0025_arbitrary_activation"
      );
      try {
        insert(
          runtime.database,
          "job_runs",
          arbitraryActivationJob
        );
        const arbitraryRecovery = recoveryRecord(ids, {
          ...fixture,
          allocation,
        }, {
          id: uuid(13_803),
          rollover_id: null,
          job_run_id: arbitraryActivationJob.id,
          kind: "restricted_activation",
          earliest_activation_at_ms:
            arbitraryActivationAtMs,
          target_resolution_at_ms:
            arbitraryResolutionAtMs,
          last_error_code: null,
          created_by_operation_id:
            "restricted-activation-arbitrary-1",
          created_at_ms: scheduledAtMs,
          updated_at_ms: scheduledAtMs,
        });
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          arbitraryRecovery
        );
        leaseJob(
          runtime.database,
          arbitraryActivationJob,
          finalCutoffAtMs
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(finalCutoffAtMs, arbitraryRecovery.id);
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE free_agent_draft_player_allocations
                SET status = 'correction_required',
                    decision_code =
                      'exact_total_and_term_tie',
                    resolved_at_ms = ?,
                    last_error_code =
                      'RESTRICTED_ACTIVATION_FAILED',
                    updated_at_ms = ?,
                    version = 4
                WHERE id = ?
              `)
              .run(
                finalCutoffAtMs,
                finalCutoffAtMs,
                allocation.id
              );
          },
          /exact due activation recovery lease/i
        );
      } finally {
        runtime.database.exec(
          "ROLLBACK TO fad_0025_arbitrary_activation"
        );
        runtime.database.exec(
          "RELEASE fad_0025_arbitrary_activation"
        );
      }
      const scheduledRecovery = recoveryRecord(ids, {
        ...fixture,
        allocation,
      }, {
        id: uuid(13_802),
        rollover_id: fixture.rollovers[1].id,
        job_run_id: restrictedActivationJob.id,
        kind: "restricted_activation",
        earliest_activation_at_ms: restrictedActivationAtMs,
        target_resolution_at_ms: restrictedResolutionAtMs,
        last_error_code: null,
        created_by_operation_id:
          "restricted-activation-scheduled-1",
        created_at_ms: scheduledAtMs,
        updated_at_ms: scheduledAtMs,
      });
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        scheduledRecovery
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'correction_required',
                  decision_code = 'exact_total_and_term_tie',
                  resolved_at_ms = ?,
                  last_error_code =
                    'RESTRICTED_ACTIVATION_FAILED',
                  updated_at_ms = ?,
                  version = 4
              WHERE id = ?
            `)
            .run(
              restrictedActivationAtMs - 1,
              restrictedActivationAtMs - 1,
              allocation.id
            );
        },
        /exact due activation recovery lease/i
      );

      leaseJob(
        runtime.database,
        restrictedActivationJob,
        finalCutoffAtMs - 1
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(finalCutoffAtMs - 1, scheduledRecovery.id);
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'deferred_restricted_recovery',
                  decision_code = 'exact_total_and_term_tie',
                  resolved_at_ms = ?,
                  last_error_code = 'FAIR_WINDOW_UNAVAILABLE',
                  updated_at_ms = ?,
                  version = 4
              WHERE id = ?
            `)
            .run(
              finalCutoffAtMs - 1,
              finalCutoffAtMs - 1,
              allocation.id
            );
        },
        /approved versioned state/i
      );
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "deferred_restricted_recovery",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: finalCutoffAtMs,
          last_error_code: "FAIR_WINDOW_UNAVAILABLE",
          updated_at_ms: finalCutoffAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(13_707),
          occurred_at_ms: finalCutoffAtMs,
          created_at_ms: finalCutoffAtMs,
        })
      );
      const earlyDeferredActivationAtMs =
        FIRST_MATCHUP_STARTS_AT_MS - 2 * HOUR_MS;
      const earlyDeferredResolutionAtMs =
        FIRST_MATCHUP_STARTS_AT_MS - 1;
      const earlyDeferredJob = jobRunRecord(
        ids,
        uuid(13_633),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${earlyDeferredActivationAtMs}`,
        earlyDeferredActivationAtMs
      );
      insert(runtime.database, "job_runs", earlyDeferredJob);
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            recoveryRecord(ids, {
              ...fixture,
              allocation,
            }, {
              id: uuid(13_804),
              job_run_id: earlyDeferredJob.id,
              kind: "deferred_restricted",
              earliest_activation_at_ms:
                earlyDeferredActivationAtMs,
              target_resolution_at_ms:
                earlyDeferredResolutionAtMs,
              last_error_code: "FAIR_WINDOW_UNAVAILABLE",
              created_by_operation_id:
                "deferred-restricted-too-early-1",
              created_at_ms: finalCutoffAtMs,
              updated_at_ms: finalCutoffAtMs,
            })
          );
        },
        /kind does not match its current causal state/i
      );
      const deferredActivationAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + 1;
      const deferredResolutionAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + HOUR_MS + 2;
      const deferredJob = jobRunRecord(
        ids,
        uuid(13_631),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${deferredActivationAtMs}`,
        deferredActivationAtMs
      );
      insert(runtime.database, "job_runs", deferredJob);
      const deferredRecovery = recoveryRecord(ids, {
        ...fixture,
        allocation,
      }, {
        id: uuid(13_801),
        job_run_id: deferredJob.id,
        kind: "deferred_restricted",
        earliest_activation_at_ms: deferredActivationAtMs,
        target_resolution_at_ms: deferredResolutionAtMs,
        last_error_code: "FAIR_WINDOW_UNAVAILABLE",
        created_by_operation_id:
          "deferred-restricted-correction-1",
        created_at_ms: finalCutoffAtMs,
        updated_at_ms: finalCutoffAtMs,
      });
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        deferredRecovery
      );
      leaseJob(
        runtime.database,
        deferredJob,
        deferredActivationAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(deferredActivationAtMs, deferredRecovery.id);
      const prematureAuctionId = uuid(13_750);
      insert(runtime.database, "auctions", {
        id: prematureAuctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        player_id: allocation.player_id,
        status: "open",
        opened_at_ms: deferredActivationAtMs,
        resolves_at_ms: deferredResolutionAtMs,
        opened_by_user_id: null,
        created_at_ms: deferredActivationAtMs,
        updated_at_ms: deferredActivationAtMs,
        version: 1,
      });
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'restricted_active',
                  decision_code =
                    'exact_total_and_term_tie',
                  restricted_auction_id = ?,
                  resolved_at_ms = ?,
                  last_error_code = NULL,
                  updated_at_ms = ?,
                  version = 5
              WHERE id = ?
            `)
            .run(
              prematureAuctionId,
              deferredActivationAtMs,
              deferredActivationAtMs,
              allocation.id
            );
        },
        /approved versioned state/i
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, decision_code, resolved_at_ms
            FROM free_agent_draft_player_allocations
            WHERE id = ?
          `)
          .get(allocation.id),
        {
          status: "deferred_restricted_recovery",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: finalCutoffAtMs,
        }
      );
    });

    test("activates an exact Candidate tie immediately in a fair rapid window", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-restricted-immediate-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-restricted-immediate");
      const ids = seedScenario(runtime, {
        base: 20_000,
        secondTeam: true,
      });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(200_000)
      );
      startAllocating(runtime.database, fixture);
      const activatedAtMs = CANDIDATE_DEADLINE_AT_MS + 20;
      const auctionId = uuid(200_750);
      insert(runtime.database, "auctions", {
        id: auctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        player_id: fixture.entry.player_id,
        status: "open",
        opened_at_ms: activatedAtMs,
        resolves_at_ms: fixture.rollovers[0].rolls_over_at_ms,
        opened_by_user_id: null,
        created_at_ms: activatedAtMs,
        updated_at_ms: activatedAtMs,
        version: 1,
      });
      const allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "restricted_active",
          decision_code: "exact_total_and_term_tie",
          restricted_auction_id: auctionId,
          resolved_at_ms: activatedAtMs,
          updated_at_ms: activatedAtMs,
        }
      );
      const tiedOffers = insertAllocationOfferEvidence(
        runtime.database,
        ids,
        fixture,
        allocation,
        {
          id: uuid(200_701),
          offer_outcome_code: "restricted_tied",
          occurred_at_ms: activatedAtMs,
          created_at_ms: activatedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(200_703),
          event_kind: "restricted_state_changed",
          occurred_at_ms: activatedAtMs,
          created_at_ms: activatedAtMs,
        })
      );

      finishRapid(runtime.database, fixture);
      assert.equal(tiedOffers.length, 2);
      assert.ok(
        tiedOffers.every(
          (offer) =>
            offer.offer_outcome_code === "restricted_tied"
        )
      );
    });

    test("retries an exact-tie correction only with its due activation lease", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-restricted-retry-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-restricted-retry");
      const ids = seedScenario(runtime, {
        base: 21_000,
        secondTeam: true,
      });
      runtime.database
        .prepare(`
          UPDATE seasons
          SET nhl_season_key = '20262027'
          WHERE id = ?
        `)
        .run(ids.targetSeason);
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(210_000),
        {
          entryOverrides: {
            proposed_total_value_cents: 700,
            proposed_term_years: 1,
            proposed_aav_cents: 700,
          },
          competingEntryOverrides: {
            proposed_total_value_cents: 700,
            proposed_term_years: 1,
            proposed_aav_cents: 700,
          },
        }
      );
      startAllocating(runtime.database, fixture);
      const failedAtMs = CANDIDATE_DEADLINE_AT_MS + 20;
      let allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "correction_required",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: failedAtMs,
          last_error_code: "RESTRICTED_CREATION_FAILED",
          updated_at_ms: failedAtMs,
        }
      );
      insertAllocationOfferEvidence(
        runtime.database,
        ids,
        fixture,
        allocation,
        {
          id: uuid(210_701),
          offer_outcome_code: "restricted_tied",
          occurred_at_ms: failedAtMs,
          created_at_ms: failedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(210_703),
          occurred_at_ms: failedAtMs,
          created_at_ms: failedAtMs,
        })
      );
      const activationAtMs = failedAtMs + 20;
      const resolutionAtMs =
        fixture.rollovers[0].rolls_over_at_ms;
      const activationJob = jobRunRecord(
        ids,
        uuid(210_630),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${activationAtMs}`,
        activationAtMs
      );
      insert(runtime.database, "job_runs", activationJob);
      const recovery = recoveryRecord(ids, {
        ...fixture,
        allocation,
      }, {
        id: uuid(210_800),
        rollover_id: fixture.rollovers[0].id,
        job_run_id: activationJob.id,
        kind: "restricted_activation",
        earliest_activation_at_ms: activationAtMs,
        target_resolution_at_ms: resolutionAtMs,
        last_error_code: "RESTRICTED_CREATION_FAILED",
        created_by_operation_id: "restricted-create-retry-1",
        created_at_ms: failedAtMs,
        updated_at_ms: failedAtMs,
      });
      assertConstraint(
        () => insert(
          runtime.database,
          "free_agent_draft_recoveries",
          recoveryRecord(ids, {
            ...fixture,
            allocation,
          }, {
            id: uuid(210_802),
            kind: "allocation_retry",
            last_error_code:
              "RESTRICTED_CREATION_FAILED",
            created_by_operation_id:
              "restricted-create-wrong-retry-kind",
            created_at_ms: failedAtMs,
            updated_at_ms: failedAtMs,
          })
        ),
        /current causal state/i
      );
      assertConstraint(
        () => insert(
          runtime.database,
          "free_agent_draft_recoveries",
          {
            ...recovery,
            id: uuid(210_803),
            job_run_id: null,
            created_by_operation_id:
              "restricted-create-without-job",
          }
        ),
        /CHECK constraint failed/i
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recovery
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            {
              ...recovery,
              id: uuid(210_801),
              created_by_operation_id:
                "restricted-create-retry-substitute",
            }
          );
        },
        /UNIQUE constraint failed/i
      );
      finishRapid(
        runtime.database,
        fixture,
        CANDIDATE_DEADLINE_AT_MS + 30
      );
      runtime.database.exec("BEGIN");
      try {
        const correctedContractId = uuid(210_740);
        const correctedOwnershipId = uuid(210_741);
        insert(runtime.database, "contracts", {
          id: correctedContractId,
          league_id: ids.league,
          player_id: allocation.player_id,
          current_team_id: ids.team,
          contract_type: "normal",
          original_total_value_cents: 700,
          original_term_years: 1,
          aav_cents: 700,
          start_season_id: ids.targetSeason,
          status: "active",
          acquisition_source_type:
            "free_agent_draft_allocation",
          acquisition_source_id: allocation.id,
          auction_buyout_lock_expires_at_ms:
            failedAtMs + 3 + 14 * DAY_MS,
          created_at_ms: failedAtMs + 3,
          updated_at_ms: failedAtMs + 3,
          version: 1,
        });
        insert(runtime.database, "player_ownerships", {
          id: correctedOwnershipId,
          league_id: ids.league,
          season_id: ids.targetSeason,
          player_id: allocation.player_id,
          team_id: ids.team,
          ownership_kind: "Rostered",
          roster_category: "Active",
          position_group: "F",
          slot_number: 1,
          acquired_transaction_type:
            "free_agent_draft_allocation",
          acquired_transaction_id: allocation.id,
          created_at_ms: failedAtMs + 3,
          updated_at_ms: failedAtMs + 3,
          version: 1,
          trade_blocked: 0,
        });
        insert(runtime.database, "contract_years", {
          id: uuid(210_742),
          league_id: ids.league,
          contract_id: correctedContractId,
          season_id: ids.targetSeason,
          year_number: 1,
          aav_cents: 700,
          status: "current",
          rollover_at_ms: null,
          created_at_ms: failedAtMs + 3,
        });
        assertConstraint(
          () => updateAllocation(
            runtime.database,
            allocation,
            {
              status: "automatic_award",
              decision_code: "corrected",
              winning_snapshot_entry_id:
                fixture.candidateSnapshotEntry.id,
              winning_team_id: ids.team,
              contract_id: correctedContractId,
              ownership_id: correctedOwnershipId,
              resolved_at_ms: failedAtMs + 3,
              last_error_code: null,
              updated_at_ms: failedAtMs + 3,
            }
          ),
          /unique deterministic top offer/i
        );
        const correctedAuctionId = uuid(210_749);
        insert(runtime.database, "auctions", {
          id: correctedAuctionId,
          league_id: ids.league,
          season_id: ids.targetSeason,
          player_id: allocation.player_id,
          status: "open",
          opened_at_ms: failedAtMs + 1,
          resolves_at_ms: failedAtMs + 2,
          opened_by_user_id: null,
          created_at_ms: failedAtMs + 1,
          updated_at_ms: failedAtMs + 1,
          version: 1,
        });
        runtime.database
          .prepare(`
            UPDATE auctions
            SET status = 'no_winner',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(failedAtMs + 2, correctedAuctionId);
        const correctedTie = updateAllocation(
          runtime.database,
          allocation,
          {
            status: "restricted_resolved",
            decision_code: "corrected",
            restricted_auction_id: correctedAuctionId,
            resolved_at_ms: failedAtMs + 3,
            last_error_code: null,
            updated_at_ms: failedAtMs + 3,
          }
        );
        assert.equal(correctedTie.status, "restricted_resolved");
      } finally {
        runtime.database.exec("ROLLBACK");
      }

      leaseJob(runtime.database, activationJob, activationAtMs);
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(activationAtMs, recovery.id);
      const auctionId = uuid(210_750);
      insert(runtime.database, "auctions", {
        id: auctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        player_id: allocation.player_id,
        status: "open",
        opened_at_ms: activationAtMs,
        resolves_at_ms: resolutionAtMs,
        opened_by_user_id: null,
        created_at_ms: activationAtMs,
        updated_at_ms: activationAtMs,
        version: 1,
      });
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'restricted_active',
                  restricted_auction_id = ?,
                  resolved_at_ms = ?,
                  last_error_code = NULL,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              auctionId,
              activationAtMs - 1,
              activationAtMs - 1,
              allocation.id
            );
        },
        /due recovery lease/i
      );
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "restricted_active",
          decision_code: "exact_total_and_term_tie",
          restricted_auction_id: auctionId,
          resolved_at_ms: activationAtMs,
          last_error_code: null,
          updated_at_ms: activationAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(210_704),
          event_kind: "restricted_state_changed",
          occurred_at_ms: activationAtMs,
          created_at_ms: activationAtMs,
        })
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              resolved_authority = 'system',
              resolved_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          activationAtMs + 1,
          activationAtMs + 1,
          recovery.id
        );

      assert.equal(allocation.status, "restricted_active");
    });

    test("continues deferred restricted recovery after FAD completion", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-deferred-after-completion-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-deferred-after-completion");
      const ids = seedScenario(runtime, {
        base: 22_000,
        secondTeam: true,
      });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(220_000)
      );
      startAllocating(runtime.database, fixture);
      const deferredAtMs =
        fixture.rollovers[6].creation_cutoff_at_ms;
      leaseJob(
        runtime.database,
        fixture.jobs.allocation,
        deferredAtMs
      );
      let allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "deferred_restricted_recovery",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: deferredAtMs,
          last_error_code: "FAIR_WINDOW_UNAVAILABLE",
          updated_at_ms: deferredAtMs,
        }
      );
      insertAllocationOfferEvidence(
        runtime.database,
        ids,
        fixture,
        allocation,
        {
          id: uuid(220_701),
          offer_outcome_code: "restricted_tied",
          occurred_at_ms: deferredAtMs,
          created_at_ms: deferredAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(220_703),
          occurred_at_ms: deferredAtMs,
          created_at_ms: deferredAtMs,
        })
      );
      const activationAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + DAY_MS;
      const resolutionAtMs = activationAtMs + DAY_MS;
      const activationJob = jobRunRecord(
        ids,
        uuid(220_630),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${activationAtMs}`,
        activationAtMs
      );
      insert(runtime.database, "job_runs", activationJob);
      const deferredRecovery = recoveryRecord(ids, {
        ...fixture,
        allocation,
      }, {
        id: uuid(220_800),
        job_run_id: activationJob.id,
        kind: "deferred_restricted",
        earliest_activation_at_ms: activationAtMs,
        target_resolution_at_ms: resolutionAtMs,
        last_error_code: "FAIR_WINDOW_UNAVAILABLE",
        created_by_operation_id: "deferred-after-fad-1",
        created_at_ms: deferredAtMs,
        updated_at_ms: deferredAtMs,
      });
      runtime.database
        .prepare(`
          UPDATE job_runs
          SET status = 'succeeded'
          WHERE id = ?
        `)
        .run(activationJob.id);
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            deferredRecovery
          );
        },
        /job must match its exact causal occurrence/i
      );
      runtime.database
        .prepare(`
          UPDATE job_runs
          SET status = 'pending'
          WHERE id = ?
        `)
        .run(activationJob.id);
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            {
              ...deferredRecovery,
              id: uuid(220_799),
              kind: "restricted_activation",
              created_by_operation_id:
                "wrong-kind-deferred-after-fad",
            }
          );
        },
        /kind does not match its current causal state/i
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        deferredRecovery
      );
      const staleDeferredRecovery = {
        ...deferredRecovery,
        id: uuid(220_801),
        created_by_operation_id: "stale-deferred-after-fad",
        created_at_ms: deferredAtMs - 1,
        updated_at_ms: deferredAtMs - 1,
      };
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            staleDeferredRecovery
          );
        },
        /kind does not match its current causal state/i
      );
      finishRapid(
        runtime.database,
        fixture,
        deferredAtMs + 1
      );
      for (const rollover of fixture.rollovers) {
        completeRollover(
          runtime.database,
          rollover,
          fixture.jobs[`rollover-${rollover.sequence}`]
        );
      }
      const fadCompletedAtMs = resolutionAtMs + 10;
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        fadCompletedAtMs - 1
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 5
          WHERE id = ?
        `)
        .run(
          fadCompletedAtMs,
          fadCompletedAtMs,
          fixture.fad.id
        );

      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'restricted_scheduled',
                  decision_code = 'exact_total_and_term_tie',
                  restricted_auction_id = NULL,
                  resolved_at_ms = ?,
                  last_error_code = NULL,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              activationAtMs,
              activationAtMs,
              allocation.id
            );
        },
        /approved versioned state/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'correction_required',
                  decision_code =
                    'exact_total_and_term_tie',
                  restricted_auction_id = NULL,
                  resolved_at_ms = ?,
                  last_error_code =
                    'DEFERRED_ACTIVATION_FAILED',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              activationAtMs,
              activationAtMs,
              allocation.id
            );
        },
        /approved versioned state/i
      );
      const rescheduleStartedAtMs = fadCompletedAtMs + 1;
      leaseJob(
        runtime.database,
        activationJob,
        rescheduleStartedAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(rescheduleStartedAtMs, deferredRecovery.id);
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_recoveries
              SET status = 'resolved',
                  resolved_authority = 'system',
                  resolved_at_ms = ?,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              rescheduleStartedAtMs,
              rescheduleStartedAtMs,
              deferredRecovery.id
            );
        },
        /causal state is terminal/i
      );
      const successorActivationAtMs =
        rescheduleStartedAtMs + DAY_MS;
      const successorResolutionAtMs =
        successorActivationAtMs + DAY_MS;
      const successorActivationJob = jobRunRecord(
        ids,
        uuid(220_633),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${successorActivationAtMs}`,
        successorActivationAtMs
      );
      insert(
        runtime.database,
        "job_runs",
        successorActivationJob
      );
      const successorRecovery = {
        ...deferredRecovery,
        id: uuid(220_802),
        job_run_id: successorActivationJob.id,
        supersedes_recovery_id: deferredRecovery.id,
        causal_started_at_ms: deferredAtMs,
        earliest_activation_at_ms: successorActivationAtMs,
        target_resolution_at_ms: successorResolutionAtMs,
        created_at_ms: rescheduleStartedAtMs,
        updated_at_ms: rescheduleStartedAtMs,
      };
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            {
              ...successorRecovery,
              id: uuid(220_806),
              created_at_ms: fadCompletedAtMs - 1,
              updated_at_ms: fadCompletedAtMs - 1,
            }
          );
        },
        /current causal state/i
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        successorRecovery
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE job_runs
              SET occurrence_key = occurrence_key || ':mutated'
              WHERE id = ?
            `)
            .run(successorActivationJob.id);
        },
        /causal identity is immutable/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE job_runs
              SET status = 'succeeded'
              WHERE id = ?
            `)
            .run(successorActivationJob.id);
        },
        /cannot become terminal before recovery resolves/i
      );
      const forkActivationJob = jobRunRecord(
        ids,
        uuid(220_634),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:` +
          `${successorActivationAtMs + DAY_MS}`,
        successorActivationAtMs + DAY_MS
      );
      insert(runtime.database, "job_runs", forkActivationJob);
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            {
              ...successorRecovery,
              id: uuid(220_803),
              job_run_id: forkActivationJob.id,
              earliest_activation_at_ms:
                successorActivationAtMs + DAY_MS,
              target_resolution_at_ms:
                successorResolutionAtMs + DAY_MS,
            }
          );
        },
        /current causal state|unique constraint/i
      );
      const secondRescheduleStartedAtMs =
        successorResolutionAtMs + 10;
      const finalActivationAtMs =
        secondRescheduleStartedAtMs + DAY_MS;
      const finalResolutionAtMs =
        finalActivationAtMs + DAY_MS;
      const finalActivationJob = jobRunRecord(
        ids,
        uuid(220_635),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${finalActivationAtMs}`,
        finalActivationAtMs
      );
      const finalRecovery = {
        ...successorRecovery,
        id: uuid(220_805),
        job_run_id: finalActivationJob.id,
        supersedes_recovery_id: successorRecovery.id,
        earliest_activation_at_ms: finalActivationAtMs,
        target_resolution_at_ms: finalResolutionAtMs,
        created_at_ms: secondRescheduleStartedAtMs + 2,
        updated_at_ms: secondRescheduleStartedAtMs + 2,
      };

      runtime.database.exec("BEGIN");
      try {
        leaseJob(
          runtime.database,
          successorActivationJob,
          successorActivationAtMs
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(successorActivationAtMs, successorRecovery.id);
        const prematureAuctionId = uuid(220_748);
        insert(runtime.database, "auctions", {
          id: prematureAuctionId,
          league_id: ids.league,
          season_id: ids.targetSeason,
          player_id: allocation.player_id,
          status: "open",
          opened_at_ms: successorActivationAtMs,
          resolves_at_ms: successorResolutionAtMs,
          opened_by_user_id: null,
          created_at_ms: successorActivationAtMs,
          updated_at_ms: successorActivationAtMs,
          version: 1,
        });
        assertConstraint(
          () => updateAllocation(
            runtime.database,
            allocation,
            {
              status: "restricted_active",
              decision_code: "exact_total_and_term_tie",
              restricted_auction_id: prematureAuctionId,
              resolved_at_ms: successorActivationAtMs,
              last_error_code: null,
              updated_at_ms: successorActivationAtMs,
            }
          ),
          /due recovery lease/i
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }

      runtime.database.exec("BEGIN");
      try {
        leaseJob(
          runtime.database,
          successorActivationJob,
          secondRescheduleStartedAtMs
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            secondRescheduleStartedAtMs,
            successorRecovery.id
          );
        insert(
          runtime.database,
          "job_runs",
          finalActivationJob
        );
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "free_agent_draft_recoveries",
              finalRecovery
            );
          },
          /current causal state/i
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }

      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              commissioner_reason = ?,
              resolved_by_user_id = ?,
              resolved_by_membership_id = ?,
              resolved_authority = 'commissioner',
              resolved_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          "Open the next complete fair-access window.",
          ids.commissionerUser,
          ids.commissionerMembership,
          secondRescheduleStartedAtMs + 1,
          secondRescheduleStartedAtMs + 1,
          deferredRecovery.id
        );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            {
              ...deferredRecovery,
              id: uuid(220_804),
              created_by_operation_id:
                "deferred-after-fad-fork",
            }
          );
        },
        /unique constraint/i
      );

      runtime.database.exec("BEGIN");
      try {
        leaseJob(
          runtime.database,
          successorActivationJob,
          successorActivationAtMs
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(successorActivationAtMs, successorRecovery.id);
        insert(
          runtime.database,
          "job_runs",
          finalActivationJob
        );
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "free_agent_draft_recoveries",
              {
                ...finalRecovery,
                created_at_ms: successorActivationAtMs,
                updated_at_ms: successorActivationAtMs,
              }
            );
          },
          /current causal state/i
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }

      runtime.database.exec("BEGIN");
      try {
        leaseJob(
          runtime.database,
          successorActivationJob,
          secondRescheduleStartedAtMs
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            secondRescheduleStartedAtMs,
            successorRecovery.id
          );
        insert(
          runtime.database,
          "job_runs",
          finalActivationJob
        );
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "free_agent_draft_recoveries",
              {
                ...finalRecovery,
                created_at_ms: secondRescheduleStartedAtMs,
                updated_at_ms: secondRescheduleStartedAtMs,
              }
            );
          },
          /current causal state/i
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }

      leaseJob(
        runtime.database,
        successorActivationJob,
        secondRescheduleStartedAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          secondRescheduleStartedAtMs,
          successorRecovery.id
        );
      insert(runtime.database, "job_runs", finalActivationJob);
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        finalRecovery
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              resolved_authority = 'system',
              resolved_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          secondRescheduleStartedAtMs + 3,
          secondRescheduleStartedAtMs + 3,
          successorRecovery.id
        );
      leaseJob(
        runtime.database,
        finalActivationJob,
        finalActivationAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(finalActivationAtMs, finalRecovery.id);
      const auctionId = uuid(220_750);
      insert(runtime.database, "auctions", {
        id: auctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        player_id: allocation.player_id,
        status: "open",
        opened_at_ms: finalActivationAtMs,
        resolves_at_ms: finalResolutionAtMs,
        opened_by_user_id: null,
        created_at_ms: finalActivationAtMs,
        updated_at_ms: finalActivationAtMs,
        version: 1,
      });
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "restricted_active",
          decision_code: "exact_total_and_term_tie",
          restricted_auction_id: auctionId,
          resolved_at_ms: finalActivationAtMs,
          last_error_code: null,
          updated_at_ms: finalActivationAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(220_704),
          event_kind: "restricted_state_changed",
          occurred_at_ms: finalActivationAtMs,
          created_at_ms: finalActivationAtMs,
        })
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              resolved_authority = 'system',
              resolved_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          finalActivationAtMs + 1,
          finalActivationAtMs + 1,
          finalRecovery.id
        );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE job_runs
              SET status = 'succeeded',
                  updated_at_ms = ?
              WHERE id = ?
            `)
            .run(
              finalActivationAtMs,
              finalActivationJob.id
            );
        },
        /cannot become terminal before recovery resolves/i
      );
      runtime.database
        .prepare(`
          UPDATE job_runs
          SET status = 'succeeded',
              updated_at_ms = ?
          WHERE id = ?
        `)
        .run(
          finalActivationAtMs + 1,
          finalActivationJob.id
        );

      const resolutionJob = jobRunRecord(
        ids,
        uuid(220_631),
        "auction.resolve.target",
        `auction:${auctionId}:${finalResolutionAtMs}`,
        finalResolutionAtMs
      );
      insert(runtime.database, "job_runs", resolutionJob);
      leaseJob(
        runtime.database,
        resolutionJob,
        finalResolutionAtMs
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'no_winner',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(finalResolutionAtMs, auctionId);
      const substitutedAuctionId = uuid(220_751);
      insert(runtime.database, "auctions", {
        id: substitutedAuctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        player_id: allocation.player_id,
        status: "open",
        opened_at_ms: finalResolutionAtMs - 1,
        resolves_at_ms: finalResolutionAtMs,
        opened_by_user_id: null,
        created_at_ms: finalResolutionAtMs - 1,
        updated_at_ms: finalResolutionAtMs - 1,
        version: 1,
      });
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'no_winner',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(finalResolutionAtMs, substitutedAuctionId);
      const substitutedResolutionJob = jobRunRecord(
        ids,
        uuid(220_632),
        "auction.resolve.target",
        `auction:${substitutedAuctionId}:` +
          `${finalResolutionAtMs}`,
        finalResolutionAtMs
      );
      insert(
        runtime.database,
        "job_runs",
        substitutedResolutionJob
      );
      leaseJob(
        runtime.database,
        substitutedResolutionJob,
        finalResolutionAtMs
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'restricted_resolved',
                  decision_code =
                    'restricted_auction_no_winner',
                  restricted_auction_id = ?,
                  resolved_at_ms = ?,
                  updated_at_ms = ?,
                  version = 4
              WHERE id = ?
            `)
            .run(
              substitutedAuctionId,
              finalResolutionAtMs,
              finalResolutionAtMs,
              allocation.id
            );
        },
        /approved versioned state/i
      );
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "restricted_resolved",
          decision_code: "restricted_auction_no_winner",
          resolved_at_ms: finalResolutionAtMs,
          updated_at_ms: finalResolutionAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(220_705),
          event_kind: "restricted_state_changed",
          occurred_at_ms: finalResolutionAtMs,
          created_at_ms: finalResolutionAtMs,
        })
      );

      assert.equal(allocation.status, "restricted_resolved");
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM free_agent_drafts
            WHERE id = ?
          `)
          .get(fixture.fad.id).status,
        "completed"
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT free_agent_draft_completed_at_ms
            FROM seasons
            WHERE id = ?
          `)
          .get(ids.targetSeason)
          .free_agent_draft_completed_at_ms,
        fadCompletedAtMs
      );
    });

    test("requires atomic recovery sidecars before rapid begins", (t) => {
      const scenarios = [
        {
          name: "correction-required",
          base: 6_000,
          status: "correction_required",
          decisionCode: "invalid_snapshot",
          lastErrorCode: "ALLOCATION_FAILED",
          offerOverrides: {
            offer_valid: 0,
            rank_position: null,
            offer_outcome_code: "invalid",
          },
          rejectionPattern:
            /correction-required allocation recovery/i,
          recoveryKind: "allocation_retry",
        },
        {
          name: "no-valid-retry",
          base: 26_000,
          status: "correction_required",
          decisionCode: "no_valid_offer",
          lastErrorCode: "ALLOCATION_FAILED",
          offerOverrides: {
            offer_valid: 0,
            rank_position: null,
            offer_outcome_code: "invalid",
          },
          rejectionPattern:
            /correction-required allocation recovery/i,
          recoveryKind: "allocation_retry",
        },
        {
          name: "deferred-restricted",
          base: 7_000,
          status: "deferred_restricted_recovery",
          decisionCode: "exact_total_and_term_tie",
          lastErrorCode: "FAIR_WINDOW_UNAVAILABLE",
          offerOverrides: {},
          rejectionPattern: /deferred restricted recovery/i,
          recoveryKind: "deferred_restricted",
        },
        {
          name: "restricted-scheduled",
          base: 8_000,
          status: "restricted_scheduled",
          decisionCode: "exact_total_and_term_tie",
          lastErrorCode: null,
          offerOverrides: {
            offer_outcome_code: "restricted_tied",
          },
          rejectionPattern:
            /restricted scheduled activation recovery/i,
          recoveryKind: "restricted_activation",
        },
      ];

      for (const scenario of scenarios) {
        const runtime = createRuntime(
          t,
          `hundo-fad-0025-${scenario.name}-`
        );
        copyMigrationsThrough(runtime, 25);
        migrate(runtime, `fad-0025-${scenario.name}`);
        const ids = seedScenario(runtime, {
          base: scenario.base,
          secondTeam:
            scenario.decisionCode ===
            "exact_total_and_term_tie",
        });
        const fixture = prepareDeadlineFad(
          runtime.database,
          ids,
          uuid(scenario.base + 9_000),
          scenario.decisionCode === "invalid_snapshot" ||
          scenario.decisionCode === "no_valid_offer"
            ? {
                entryOverrides: {
                  eligibility_status: "invalid",
                  validation_code: "PLAYER_UNAVAILABLE",
                },
              }
            : {}
        );
        startAllocating(runtime.database, fixture);
        let resolvedAtMs = CANDIDATE_DEADLINE_AT_MS + 22;
        if (scenario.status === "restricted_scheduled") {
          resolvedAtMs =
            fixture.rollovers[0].creation_cutoff_at_ms;
        } else if (
          scenario.status === "deferred_restricted_recovery"
        ) {
          resolvedAtMs =
            fixture.rollovers[6].creation_cutoff_at_ms;
        }
        if (resolvedAtMs > CANDIDATE_DEADLINE_AT_MS + HOUR_MS) {
          leaseJob(
            runtime.database,
            fixture.jobs.allocation,
            resolvedAtMs
          );
        }
        const rapidAtMs = resolvedAtMs + 8;
        const allocation = updateAllocation(
          runtime.database,
          fixture.allocation,
          {
            status: scenario.status,
            decision_code: scenario.decisionCode,
            resolved_at_ms: resolvedAtMs,
            last_error_code: scenario.lastErrorCode,
            updated_at_ms: resolvedAtMs,
          }
        );
        const firstOffer = allocationOfferEventRecord(
          ids,
          fixture,
          allocation,
          {
            id: uuid(scenario.base + 704),
            occurred_at_ms: resolvedAtMs,
            created_at_ms: resolvedAtMs,
            ...scenario.offerOverrides,
          }
        );
        insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          firstOffer
        );
        insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          allocationEventRecord(ids, fixture, allocation, {
            id: uuid(scenario.base + 705),
            occurred_at_ms: resolvedAtMs,
            created_at_ms: resolvedAtMs,
          })
        );
        if (fixture.competingCandidateSnapshotEntry) {
          assertConstraint(
            () => finishRapid(
              runtime.database,
              fixture,
              rapidAtMs
            ),
            /allocation decision to be evidenced/i
          );
          insert(
            runtime.database,
            "free_agent_draft_allocation_events",
            {
              ...firstOffer,
              id: uuid(scenario.base + 754),
              snapshot_entry_id:
                fixture.competingCandidateSnapshotEntry.id,
              team_id:
                fixture.competingCandidateSnapshotEntry.team_id,
            }
          );
        }

        assertConstraint(
          () => finishRapid(
            runtime.database,
            fixture,
            rapidAtMs
          ),
          scenario.rejectionPattern
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status, allocation_completed_at_ms, version
              FROM free_agent_drafts
              WHERE id = ?
            `)
            .get(fixture.fad.id),
          {
            status: "allocating",
            allocation_completed_at_ms: null,
            version: 3,
          }
        );

        let jobRunId = fixture.jobs.allocation.id;
        let rolloverId = null;
        let earliestActivationAtMs = null;
        let targetResolutionAtMs = null;
        if (scenario.recoveryKind !== "allocation_retry") {
          if (scenario.recoveryKind === "restricted_activation") {
            earliestActivationAtMs =
              fixture.rollovers[0].rolls_over_at_ms;
            targetResolutionAtMs =
              fixture.rollovers[1].rolls_over_at_ms;
            rolloverId = fixture.rollovers[1].id;
          } else {
            earliestActivationAtMs =
              FIRST_MATCHUP_STARTS_AT_MS + 1;
            targetResolutionAtMs =
              FIRST_MATCHUP_STARTS_AT_MS + HOUR_MS + 2;
          }
          const activationJob = jobRunRecord(
            ids,
            uuid(scenario.base + 630),
            "fad_restricted_activation",
            `fad:${fixture.fad.id}:restricted-activate:` +
              `${allocation.id}:${earliestActivationAtMs}`,
            earliestActivationAtMs
          );
          insert(runtime.database, "job_runs", activationJob);
          jobRunId = activationJob.id;
        }

        let wrongRolloverId = rolloverId;
        let wrongTargetResolutionAtMs = targetResolutionAtMs;
        let wrongCreatedAtMs = resolvedAtMs - 1;
        if (scenario.recoveryKind === "restricted_activation") {
          wrongRolloverId = fixture.rollovers[2].id;
          wrongTargetResolutionAtMs =
            fixture.rollovers[2].rolls_over_at_ms;
        }
        const wrongRecovery = recoveryRecord(ids, {
          ...fixture,
          allocation,
        }, {
          id: uuid(scenario.base + 801),
          rollover_id: wrongRolloverId,
          job_run_id: jobRunId,
          kind: scenario.recoveryKind,
          earliest_activation_at_ms: earliestActivationAtMs,
          target_resolution_at_ms:
            wrongTargetResolutionAtMs,
          last_error_code: scenario.lastErrorCode,
          created_by_operation_id:
            `${scenario.name}-invalid-operation`,
          created_at_ms: wrongCreatedAtMs,
          updated_at_ms: wrongCreatedAtMs,
        });
        if (scenario.recoveryKind === "deferred_restricted") {
          assertConstraint(
            () => {
              insert(
                runtime.database,
                "free_agent_draft_recoveries",
                wrongRecovery
              );
            },
            /kind does not match its current causal state/i
          );
        } else {
          insert(
            runtime.database,
            "free_agent_draft_recoveries",
            wrongRecovery
          );
        }
        assertConstraint(
          () => finishRapid(
            runtime.database,
            fixture,
            rapidAtMs
          ),
          scenario.rejectionPattern
        );

        const matchingRecovery = recoveryRecord(
          ids,
          {
            ...fixture,
            allocation,
          },
          {
            id: uuid(scenario.base + 800),
            rollover_id: rolloverId,
            job_run_id: jobRunId,
            kind: scenario.recoveryKind,
            earliest_activation_at_ms: earliestActivationAtMs,
            target_resolution_at_ms: targetResolutionAtMs,
            last_error_code: scenario.lastErrorCode,
            created_by_operation_id:
              `${scenario.name}-operation`,
            created_at_ms: resolvedAtMs,
            updated_at_ms: resolvedAtMs,
          }
        );
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          matchingRecovery
        );

        finishRapid(runtime.database, fixture, rapidAtMs);
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status, allocation_completed_at_ms, version
              FROM free_agent_drafts
              WHERE id = ?
            `)
            .get(fixture.fad.id),
          {
            status: "rapid",
            allocation_completed_at_ms: rapidAtMs,
            version: 4,
          }
        );
        if (scenario.recoveryKind === "allocation_retry") {
          const retryAtMs = rapidAtMs + 1;
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_recoveries
              SET status = 'running',
                  updated_at_ms = ?,
                  version = 2
              WHERE id = ?
            `)
            .run(retryAtMs, matchingRecovery.id);
          leaseJob(
            runtime.database,
            fixture.jobs.allocation,
            retryAtMs
          );
          const retriedAllocation = updateAllocation(
            runtime.database,
            allocation,
            {
              status:
                scenario.decisionCode === "invalid_snapshot"
                  ? "invalid"
                  : "no_valid_offer",
              decision_code: scenario.decisionCode,
              resolved_at_ms: retryAtMs,
              last_error_code: null,
              updated_at_ms: retryAtMs,
            }
          );
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_recoveries
              SET status = 'resolved',
                  resolved_authority = 'system',
                  resolved_at_ms = ?,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              retryAtMs + 1,
              retryAtMs + 1,
              matchingRecovery.id
            );
          assert.equal(
            retriedAllocation.status,
            scenario.decisionCode === "invalid_snapshot"
              ? "invalid"
              : "no_valid_offer"
          );
        }
      }

      const impossibleClockScenarios = [
        {
          name: "restricted-scheduled-too-early",
          base: 9_000,
          status: "restricted_scheduled",
          recoveryKind: "restricted_activation",
          lastErrorCode: null,
          rejectionPattern:
            /restricted scheduled activation recovery/i,
        },
        {
          name: "deferred-restricted-too-early",
          base: 10_000,
          status: "deferred_restricted_recovery",
          recoveryKind: "deferred_restricted",
          lastErrorCode: "FAIR_WINDOW_UNAVAILABLE",
          rejectionPattern: /deferred restricted recovery/i,
        },
      ];
      for (const scenario of impossibleClockScenarios) {
        const runtime = createRuntime(
          t,
          `hundo-fad-0025-${scenario.name}-`
        );
        copyMigrationsThrough(runtime, 25);
        migrate(runtime, `fad-0025-${scenario.name}`);
        const ids = seedScenario(runtime, {
          base: scenario.base,
          secondTeam: true,
        });
        const fixture = prepareDeadlineFad(
          runtime.database,
          ids,
          uuid(scenario.base + 9_000)
        );
        startAllocating(runtime.database, fixture);
        const resolvedAtMs = CANDIDATE_DEADLINE_AT_MS + 22;
        const allocation = updateAllocation(
          runtime.database,
          fixture.allocation,
          {
            status: scenario.status,
            decision_code: "exact_total_and_term_tie",
            resolved_at_ms: resolvedAtMs,
            last_error_code: scenario.lastErrorCode,
            updated_at_ms: resolvedAtMs,
          }
        );
        insertAllocationOfferEvidence(
          runtime.database,
          ids,
          fixture,
          allocation,
          {
            id: uuid(scenario.base + 704),
            offer_outcome_code: "restricted_tied",
            occurred_at_ms: resolvedAtMs,
            created_at_ms: resolvedAtMs,
          }
        );
        insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          allocationEventRecord(ids, fixture, allocation, {
            id: uuid(scenario.base + 705),
            occurred_at_ms: resolvedAtMs,
            created_at_ms: resolvedAtMs,
          })
        );

        let rolloverId = null;
        let earliestActivationAtMs =
          FIRST_MATCHUP_STARTS_AT_MS + 1;
        let targetResolutionAtMs =
          FIRST_MATCHUP_STARTS_AT_MS + HOUR_MS + 2;
        if (scenario.recoveryKind === "restricted_activation") {
          earliestActivationAtMs =
            fixture.rollovers[0].rolls_over_at_ms;
          targetResolutionAtMs =
            fixture.rollovers[1].rolls_over_at_ms;
          rolloverId = fixture.rollovers[1].id;
        }
        const activationJob = jobRunRecord(
          ids,
          uuid(scenario.base + 630),
          "fad_restricted_activation",
          `fad:${fixture.fad.id}:restricted-activate:` +
            `${allocation.id}:${earliestActivationAtMs}`,
          earliestActivationAtMs
        );
        insert(runtime.database, "job_runs", activationJob);
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          recoveryRecord(ids, {
            ...fixture,
            allocation,
          }, {
            id: uuid(scenario.base + 800),
            rollover_id: rolloverId,
            job_run_id: activationJob.id,
            kind: scenario.recoveryKind,
            earliest_activation_at_ms: earliestActivationAtMs,
            target_resolution_at_ms: targetResolutionAtMs,
            last_error_code: scenario.lastErrorCode,
            created_by_operation_id:
              `${scenario.name}-operation`,
            created_at_ms: resolvedAtMs,
            updated_at_ms: resolvedAtMs,
          })
        );
        assertConstraint(
          () => finishRapid(runtime.database, fixture),
          scenario.rejectionPattern
        );
      }
    });

    test("enforces seven exact rollover windows and their versioned lifecycle", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-rollovers-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-rollovers");
      const ids = seedScenario(runtime, { base: 3_000 });
      const fixture = createDeadlineFixture(
        runtime.database,
        ids,
        uuid(93_000),
        {
          entryOverrides: {
            eligibility_status: "invalid",
            validation_code: "PLAYER_UNAVAILABLE",
          },
        }
      );

      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_rollovers",
            rolloverRecord(ids, fixture.fad.id, 1, {
              rolls_over_at_ms:
                CANDIDATE_DEADLINE_AT_MS + DAY_MS + 1,
            })
          );
        },
        /elapsed-time window/i
      );
      const rollovers = seedRollovers(
        runtime.database,
        ids,
        fixture.fad.id
      );
      assert.equal(rollovers.length, 7);
      for (const rollover of rollovers) {
        assert.equal(
          rollover.opens_at_ms,
          CANDIDATE_DEADLINE_AT_MS +
            (rollover.sequence - 1) * DAY_MS
        );
        assert.equal(
          rollover.creation_cutoff_at_ms,
          rollover.rolls_over_at_ms - HOUR_MS
        );
        assert.equal(
          rollover.rolls_over_at_ms,
          CANDIDATE_DEADLINE_AT_MS +
            rollover.sequence * DAY_MS
        );
      }
      assert.equal(
        rollovers[6].rolls_over_at_ms,
        FIRST_MATCHUP_STARTS_AT_MS
      );
      assertConstraint(() => {
        insert(
          runtime.database,
          "free_agent_draft_rollovers",
          rolloverRecord(ids, fixture.fad.id, 1, {
            id: uuid(3_999),
          })
        );
      });

      const first = rollovers[0];
      const processingAtMs = first.rolls_over_at_ms + 1;
      const completedAtMs = first.rolls_over_at_ms + 2;
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_rollovers
              SET status = 'processing',
                  processing_started_at_ms = ?,
                  updated_at_ms = ?,
                  version = 2
              WHERE id = ?
            `)
            .run(processingAtMs, processingAtMs, first.id);
        },
        /versioned lifecycle/i
      );

      fixture.allocation = seedPendingAllocation(
        runtime.database,
        ids,
        fixture
      );
      fixture.jobs = seedDurableJobs(
        runtime.database,
        ids,
        fixture,
        fixture.allocation
      );
      leaseJob(runtime.database, fixture.jobs.deadline, SNAPSHOT_AT_MS);
      lockDeadline(runtime.database, fixture);
      leaseJob(
        runtime.database,
        fixture.jobs.allocation,
        CANDIDATE_DEADLINE_AT_MS + 20
      );
      startAllocating(runtime.database, fixture);
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "invalid",
          decision_code: "invalid_snapshot",
          resolved_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 22,
          last_error_code: null,
          updated_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 22,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationOfferEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            id: uuid(3_703),
            occurred_at_ms:
              CANDIDATE_DEADLINE_AT_MS + 22,
            created_at_ms:
              CANDIDATE_DEADLINE_AT_MS + 22,
          }
        )
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            occurred_at_ms:
              CANDIDATE_DEADLINE_AT_MS + 22,
            created_at_ms:
              CANDIDATE_DEADLINE_AT_MS + 22,
          }
        )
      );
      finishRapid(runtime.database, fixture);
      leaseJob(
        runtime.database,
        fixture.jobs["rollover-1"],
        processingAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'processing',
              processing_started_at_ms = ?,
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(processingAtMs, processingAtMs, first.id);
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_rollovers
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 2
              WHERE id = ?
            `)
            .run(completedAtMs, completedAtMs, first.id);
        },
        /versioned lifecycle/i
      );
      expireJobLease(
        runtime.database,
        fixture.jobs["rollover-1"],
        completedAtMs - 1
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_rollovers
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(completedAtMs, completedAtMs, first.id);
        },
        /exact active lease/i
      );
      leaseJob(
        runtime.database,
        fixture.jobs["rollover-1"],
        completedAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(completedAtMs, completedAtMs, first.id);
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              DELETE FROM free_agent_draft_rollovers
              WHERE id = ?
            `)
            .run(first.id);
        },
        /cannot be deleted/i
      );

      const second = rollovers[1];
      const secondProcessingAtMs =
        second.rolls_over_at_ms + 1;
      const recoveryAtMs = second.rolls_over_at_ms + 2;
      leaseJob(
        runtime.database,
        fixture.jobs["rollover-2"],
        secondProcessingAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'processing',
              processing_started_at_ms = ?,
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          secondProcessingAtMs,
          secondProcessingAtMs,
          second.id
        );
      runtime.database.exec("BEGIN");
      try {
        const openAuctionId = uuid(3_810);
        const openAuctionJob = jobRunRecord(
          ids,
          uuid(3_811),
          "auction.resolve.target",
          `auction:${openAuctionId}:${second.rolls_over_at_ms}`,
          second.rolls_over_at_ms
        );
        insert(runtime.database, "auctions", {
          id: openAuctionId,
          league_id: ids.league,
          season_id: ids.targetSeason,
          player_id: fixture.allocation.player_id,
          status: "open",
          opened_at_ms: second.opens_at_ms,
          resolves_at_ms: second.rolls_over_at_ms,
          opened_by_user_id: null,
          created_at_ms: second.opens_at_ms,
          updated_at_ms: second.opens_at_ms,
          version: 1,
        });
        insert(runtime.database, "job_runs", openAuctionJob);
        const auctionRecovery = recoveryRecord(ids, fixture, {
          id: uuid(3_812),
          allocation_id: null,
          rollover_id: second.id,
          auction_id: openAuctionId,
          job_run_id: openAuctionJob.id,
          kind: "rollover_finalize",
          last_error_code: "AUCTION_FAILED",
          created_by_operation_id:
            "rollover-2-open-auction",
          created_at_ms: recoveryAtMs,
          updated_at_ms: recoveryAtMs,
        });
        assertConstraint(
          () => insert(
            runtime.database,
            "free_agent_draft_recoveries",
            auctionRecovery
          ),
          /current causal state/i
        );

        const wrongAuctionId = uuid(3_813);
        const wrongAuctionJob = jobRunRecord(
          ids,
          uuid(3_814),
          "auction.resolve.target",
          `auction:${wrongAuctionId}:${first.rolls_over_at_ms}`,
          first.rolls_over_at_ms
        );
        insert(runtime.database, "auctions", {
          id: wrongAuctionId,
          league_id: ids.league,
          season_id: ids.targetSeason,
          player_id: fixture.allocation.player_id,
          status: "failed",
          opened_at_ms: first.opens_at_ms,
          resolves_at_ms: first.rolls_over_at_ms,
          opened_by_user_id: null,
          created_at_ms: first.opens_at_ms,
          updated_at_ms: recoveryAtMs,
          version: 2,
        });
        insert(runtime.database, "job_runs", wrongAuctionJob);
        assertConstraint(
          () => insert(
            runtime.database,
            "free_agent_draft_recoveries",
            {
              ...auctionRecovery,
              id: uuid(3_815),
              auction_id: wrongAuctionId,
              job_run_id: wrongAuctionJob.id,
              created_by_operation_id:
                "rollover-2-wrong-auction-boundary",
            }
          ),
          /current causal state/i
        );

        runtime.database
          .prepare(`
            UPDATE auctions
            SET status = 'failed',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(recoveryAtMs, openAuctionId);
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          auctionRecovery
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_rollovers
            SET status = 'recovery_required',
                completed_at_ms = ?,
                last_error_code = 'AUCTION_FAILED',
                updated_at_ms = ?,
                version = 3
            WHERE id = ?
          `)
          .run(recoveryAtMs, recoveryAtMs, second.id);
        assert.equal(
          runtime.database
            .prepare(`
              SELECT status
              FROM free_agent_draft_rollovers
              WHERE id = ?
            `)
            .get(second.id).status,
          "recovery_required"
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_rollovers
              SET status = 'recovery_required',
                  completed_at_ms = ?,
                  last_error_code = 'ROLLOVER_FAILED',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(recoveryAtMs, recoveryAtMs, second.id);
        },
        /direct recovery evidence/i
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recoveryRecord(ids, fixture, {
          id: uuid(3_800),
          player_id: null,
          allocation_id: null,
          rollover_id: second.id,
          auction_id: null,
          job_run_id: fixture.jobs["rollover-2"].id,
          kind: "rollover_finalize",
          last_error_code: "ROLLOVER_FAILED",
          created_by_operation_id: "rollover-2-attempt-1",
          created_at_ms: recoveryAtMs,
          updated_at_ms: recoveryAtMs,
        })
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'recovery_required',
              completed_at_ms = ?,
              last_error_code = 'ROLLOVER_FAILED',
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(recoveryAtMs, recoveryAtMs, second.id);
      expireJobLease(
        runtime.database,
        fixture.jobs["rollover-2"],
        recoveryAtMs
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_rollovers
              SET status = 'processing',
                  processing_started_at_ms = ?,
                  completed_at_ms = NULL,
                  last_error_code = NULL,
                  updated_at_ms = ?,
                  version = 4
              WHERE id = ?
            `)
            .run(
              recoveryAtMs + 1,
              recoveryAtMs + 1,
              second.id
            );
        },
        /exact active lease/i
      );
      leaseJob(
        runtime.database,
        fixture.jobs["rollover-2"],
        recoveryAtMs + 1
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'processing',
              processing_started_at_ms = ?,
              completed_at_ms = NULL,
              last_error_code = NULL,
              updated_at_ms = ?,
              version = 4
          WHERE id = ?
        `)
        .run(recoveryAtMs + 1, recoveryAtMs + 1, second.id);
      assert.deepEqual(
        runtime.database.pragma("foreign_key_check"),
        []
      );
    });

    test("accepts recovered auction no-winner as terminal", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-auction-recovery-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-auction-recovery");
      const ids = seedScenario(runtime, { base: 12_000 });
      const fixture = createDeadlineFixture(
        runtime.database,
        ids,
        uuid(120_000)
      );
      const auctionId = uuid(12_700);
      const resolvesAtMs = CANDIDATE_DEADLINE_AT_MS + DAY_MS;
      insert(runtime.database, "auctions", {
        id: auctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        player_id: fixture.entry.player_id,
        status: "failed",
        opened_at_ms: CANDIDATE_DEADLINE_AT_MS,
        resolves_at_ms: resolvesAtMs,
        opened_by_user_id: ids.managerUser,
        created_at_ms: CANDIDATE_DEADLINE_AT_MS,
        updated_at_ms: resolvesAtMs,
        version: 2,
      });
      const job = jobRunRecord(
        ids,
        uuid(12_701),
        "auction.resolve.target",
        `auction:${auctionId}:${resolvesAtMs}`,
        resolvesAtMs
      );
      insert(runtime.database, "job_runs", job);
      const recovery = recoveryRecord(ids, {
        ...fixture,
        allocation: {
          id: null,
          player_id: fixture.entry.player_id,
        },
        jobs: { allocation: job },
      }, {
        id: uuid(12_702),
        allocation_id: null,
        auction_id: auctionId,
        job_run_id: job.id,
        kind: "auction_resolution",
        last_error_code: "AUCTION_FAILED",
        created_by_operation_id: "auction-resolution-attempt-1",
        created_at_ms: resolvesAtMs,
        updated_at_ms: resolvesAtMs,
      });
      assertConstraint(() => {
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          {
            ...recovery,
            id: uuid(12_703),
            job_run_id: null,
          }
        );
      });
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recovery
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(resolvesAtMs + 1, recovery.id);
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_recoveries
              SET status = 'resolved',
                  resolved_at_ms = ?,
                  resolved_authority = 'system',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              resolvesAtMs + 2,
              resolvesAtMs + 2,
              recovery.id
            );
        },
        /causal state is terminal/i
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'no_winner',
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(resolvesAtMs + 2, auctionId);
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              resolved_at_ms = ?,
              resolved_authority = 'system',
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          resolvesAtMs + 3,
          resolvesAtMs + 3,
          recovery.id
        );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(recovery.id).status,
        "resolved"
      );
    });

    test("requires auction-linked recovery for a cancelled restricted allocation", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-restricted-cancelled-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-restricted-cancelled");
      const ids = seedScenario(runtime, {
        base: 23_000,
        secondTeam: true,
      });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(230_000)
      );
      startAllocating(runtime.database, fixture);
      const activatedAtMs = CANDIDATE_DEADLINE_AT_MS + 20;
      const resolvesAtMs =
        fixture.rollovers[0].rolls_over_at_ms;
      const auctionId = uuid(230_750);
      insert(runtime.database, "auctions", {
        id: auctionId,
        league_id: ids.league,
        season_id: ids.targetSeason,
        player_id: fixture.allocation.player_id,
        status: "open",
        opened_at_ms: activatedAtMs,
        resolves_at_ms: resolvesAtMs,
        opened_by_user_id: null,
        created_at_ms: activatedAtMs,
        updated_at_ms: activatedAtMs,
        version: 1,
      });
      let allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "restricted_active",
          decision_code: "exact_total_and_term_tie",
          restricted_auction_id: auctionId,
          resolved_at_ms: activatedAtMs,
          updated_at_ms: activatedAtMs,
        }
      );
      insertAllocationOfferEvidence(
        runtime.database,
        ids,
        fixture,
        allocation,
        {
          id: uuid(230_701),
          offer_outcome_code: "restricted_tied",
          occurred_at_ms: activatedAtMs,
          created_at_ms: activatedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(230_703),
          event_kind: "restricted_state_changed",
          occurred_at_ms: activatedAtMs,
          created_at_ms: activatedAtMs,
        })
      );
      finishRapid(
        runtime.database,
        fixture,
        activatedAtMs + 1
      );

      const cancelledAtMs = activatedAtMs + 10;
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'correction_required',
                  decision_code =
                    'exact_total_and_term_tie',
                  resolved_at_ms = ?,
                  last_error_code =
                    'RESTRICTED_AUCTION_CANCELLED',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              cancelledAtMs,
              cancelledAtMs,
              allocation.id
            );
        },
        /exact auction recovery/i
      );
      const resolutionJob = jobRunRecord(
        ids,
        uuid(230_631),
        "auction.resolve.target",
        `auction:${auctionId}:${resolvesAtMs}`,
        resolvesAtMs
      );
      insert(runtime.database, "job_runs", resolutionJob);
      runtime.database.exec("BEGIN");
      try {
        const failedAtMs = resolvesAtMs + 1;
        const retryAtMs = failedAtMs + 1;
        runtime.database
          .prepare(`
            UPDATE auctions
            SET status = 'failed',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(failedAtMs, auctionId);
        const unrelatedAuctionId = uuid(230_802);
        const unrelatedResolutionJob = jobRunRecord(
          ids,
          uuid(230_633),
          "auction.resolve.target",
          `auction:${unrelatedAuctionId}:${resolvesAtMs}`,
          resolvesAtMs
        );
        insert(runtime.database, "auctions", {
          id: unrelatedAuctionId,
          league_id: ids.league,
          season_id: ids.targetSeason,
          player_id: allocation.player_id,
          status: "failed",
          opened_at_ms: activatedAtMs,
          resolves_at_ms: resolvesAtMs,
          opened_by_user_id: null,
          created_at_ms: activatedAtMs,
          updated_at_ms: failedAtMs,
          version: 2,
        });
        insert(
          runtime.database,
          "job_runs",
          unrelatedResolutionJob
        );
        assertConstraint(
          () => insert(
            runtime.database,
            "free_agent_draft_recoveries",
            recoveryRecord(ids, {
              ...fixture,
              allocation,
            }, {
              id: uuid(230_803),
              auction_id: unrelatedAuctionId,
              job_run_id: unrelatedResolutionJob.id,
              kind: "auction_resolution",
              last_error_code: "AUCTION_FAILED",
              created_by_operation_id:
                "unrelated-restricted-auction-failure",
              created_at_ms: failedAtMs,
              updated_at_ms: failedAtMs,
            })
          ),
          /current causal state/i
        );
        const failedRecovery = recoveryRecord(ids, {
          ...fixture,
          allocation,
        }, {
          id: uuid(230_801),
          auction_id: auctionId,
          job_run_id: resolutionJob.id,
          kind: "auction_resolution",
          last_error_code: "AUCTION_FAILED",
          created_by_operation_id:
            "restricted-auction-failed-1",
          created_at_ms: failedAtMs,
          updated_at_ms: failedAtMs,
        });
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          failedRecovery
        );
        const failedAllocation = updateAllocation(
          runtime.database,
          allocation,
          {
            status: "correction_required",
            decision_code: "exact_total_and_term_tie",
            resolved_at_ms: failedAtMs,
            last_error_code: "AUCTION_FAILED",
            updated_at_ms: failedAtMs,
          }
        );
        runtime.database
          .prepare(`
            UPDATE auctions
            SET status = 'no_winner',
                updated_at_ms = ?,
                version = 3
            WHERE id = ?
          `)
          .run(retryAtMs, auctionId);
        const retryNoWinner = () => updateAllocation(
          runtime.database,
          failedAllocation,
          {
            status: "restricted_resolved",
            decision_code: "restricted_auction_no_winner",
            resolved_at_ms: retryAtMs,
            last_error_code: null,
            updated_at_ms: retryAtMs,
          }
        );
        assertConstraint(
          retryNoWinner,
          /exact active recovery lease/i
        );
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(retryAtMs, failedRecovery.id);
        assertConstraint(
          retryNoWinner,
          /exact active recovery lease/i
        );
        leaseJob(runtime.database, resolutionJob, retryAtMs);
        const retriedAllocation = retryNoWinner();
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'resolved',
                resolved_authority = 'system',
                resolved_at_ms = ?,
                updated_at_ms = ?,
                version = 3
            WHERE id = ?
          `)
          .run(
            retryAtMs + 1,
            retryAtMs + 1,
            failedRecovery.id
          );
        assert.equal(
          retriedAllocation.status,
          "restricted_resolved"
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }
      const recovery = recoveryRecord(ids, {
        ...fixture,
        allocation,
      }, {
        id: uuid(230_800),
        auction_id: auctionId,
        job_run_id: resolutionJob.id,
        kind: "auction_resolution",
        status: "correction_required",
        last_error_code: "RESTRICTED_AUCTION_CANCELLED",
        created_by_operation_id:
          "restricted-auction-cancelled-1",
        created_at_ms: cancelledAtMs,
        updated_at_ms: cancelledAtMs,
      });
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recovery
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_player_allocations
              SET status = 'correction_required',
                  decision_code =
                    'exact_total_and_term_tie',
                  resolved_at_ms = ?,
                  last_error_code =
                    'RESTRICTED_AUCTION_CANCELLED',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              cancelledAtMs,
              cancelledAtMs,
              allocation.id
            );
        },
        /exact auction recovery/i
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'cancelled',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(cancelledAtMs, auctionId);
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "correction_required",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: cancelledAtMs,
          last_error_code: "RESTRICTED_AUCTION_CANCELLED",
          updated_at_ms: cancelledAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(230_704),
          event_kind: "restricted_state_changed",
          occurred_at_ms: cancelledAtMs,
          created_at_ms: cancelledAtMs,
        })
      );

      for (const rollover of fixture.rollovers) {
        completeRollover(
          runtime.database,
          rollover,
          fixture.jobs[`rollover-${rollover.sequence}`]
        );
      }
      const completedAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + 10;
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        completedAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 5
          WHERE id = ?
        `)
        .run(
          completedAtMs,
          completedAtMs,
          fixture.fad.id
        );

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, completed_at_ms
            FROM free_agent_drafts
            WHERE id = ?
          `)
          .get(fixture.fad.id),
        {
          status: "completed",
          completed_at_ms: completedAtMs,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT free_agent_draft_completed_at_ms
            FROM seasons
            WHERE id = ?
          `)
          .get(ids.targetSeason)
          .free_agent_draft_completed_at_ms,
        completedAtMs
      );
      runtime.database.exec("BEGIN");
      try {
        const cancelledRetryAtMs = completedAtMs + 1;
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(cancelledRetryAtMs, recovery.id);
        leaseJob(
          runtime.database,
          resolutionJob,
          cancelledRetryAtMs
        );
        assertConstraint(
          () => updateAllocation(
            runtime.database,
            allocation,
            {
              status: "restricted_resolved",
              decision_code:
                "restricted_auction_no_winner",
              resolved_at_ms: cancelledRetryAtMs,
              last_error_code: null,
              updated_at_ms: cancelledRetryAtMs,
            }
          ),
          /exact active recovery lease/i
        );
      } finally {
        runtime.database.exec("ROLLBACK");
      }
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_recoveries
              SET status = 'resolved',
                  resolved_authority = 'system',
                  resolved_at_ms = ?,
                  updated_at_ms = ?,
                  version = 2
              WHERE id = ?
            `)
            .run(
              completedAtMs + 1,
              completedAtMs + 1,
              recovery.id
            );
        },
        /causal state is terminal/i
      );
    });

    test("requires same-cause recovery, terminal state, and current commissioner authority", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-recovery-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-recovery");
      const ids = seedScenario(runtime, { base: 4_000 });
      const fixture = prepareDeadlineFad(
        runtime.database,
        ids,
        uuid(94_000),
        {
          entryOverrides: {
            eligibility_status: "invalid",
            validation_code: "PLAYER_UNAVAILABLE",
          },
        }
      );
      let allocation = fixture.allocation;
      assertConstraint(
        () => insert(
          runtime.database,
          "free_agent_draft_recoveries",
          recoveryRecord(ids, fixture, {
            id: uuid(4_803),
            created_by_operation_id:
              "fabricated-pending-allocation-retry",
          })
        ),
        /current causal state/i
      );
      startAllocating(runtime.database, fixture);
      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "correction_required",
          decision_code: "invalid_snapshot",
          resolved_at_ms: CANDIDATE_DEADLINE_AT_MS + 20,
          last_error_code: "ALLOCATION_FAILED",
          updated_at_ms: CANDIDATE_DEADLINE_AT_MS + 20,
        }
      );
      const wrongActivationAtMs =
        fixture.rollovers[0].rolls_over_at_ms;
      const wrongActivationJob = jobRunRecord(
        ids,
        uuid(4_804),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${wrongActivationAtMs}`,
        wrongActivationAtMs
      );
      insert(runtime.database, "job_runs", wrongActivationJob);
      assertConstraint(
        () => insert(
          runtime.database,
          "free_agent_draft_recoveries",
          recoveryRecord(ids, {
            ...fixture,
            allocation,
          }, {
            id: uuid(4_805),
            rollover_id: fixture.rollovers[1].id,
            job_run_id: wrongActivationJob.id,
            kind: "restricted_activation",
            earliest_activation_at_ms:
              wrongActivationAtMs,
            target_resolution_at_ms:
              fixture.rollovers[1].rolls_over_at_ms,
            created_by_operation_id:
              "non-tie-restricted-activation",
          })
        ),
        /current causal state/i
      );
      const recovery = recoveryRecord(
        ids,
        { ...fixture, allocation }
      );
      assertConstraint(() => {
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          {
            ...recovery,
            id: uuid(4_802),
            job_run_id: null,
            created_by_operation_id:
              "allocation-retry-without-job",
          }
        );
      }, /CHECK constraint failed/i);
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recovery
      );
      assertConstraint(() => {
        insert(
          runtime.database,
          "free_agent_draft_recoveries",
          {
            ...recovery,
            id: uuid(4_801),
          }
        );
      });
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(CANDIDATE_DEADLINE_AT_MS + 21, recovery.id);

      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_recoveries
              SET status = 'resolved',
                  resolved_at_ms = ?,
                  resolved_authority = 'system',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              CANDIDATE_DEADLINE_AT_MS + 22,
              CANDIDATE_DEADLINE_AT_MS + 22,
              recovery.id
            );
        },
        /causal state is terminal/i
      );

      allocation = updateAllocation(
        runtime.database,
        allocation,
        {
          status: "invalid",
          decision_code: "invalid_snapshot",
          resolved_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 22,
          last_error_code: null,
          updated_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 22,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationOfferEventRecord(ids, fixture, allocation, {
          id: uuid(4_703),
          occurred_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 22,
          created_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 22,
        })
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(4_702),
          occurred_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 22,
          created_at_ms:
            CANDIDATE_DEADLINE_AT_MS + 22,
        })
      );

      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_recoveries
              SET status = 'resolved',
                  commissioner_reason =
                    'Manager cannot resolve recovery.',
                  resolved_by_user_id = ?,
                  resolved_by_membership_id = ?,
                  resolved_authority = 'commissioner',
                  resolved_at_ms = ?,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              ids.managerUser,
              ids.managerMembership,
              CANDIDATE_DEADLINE_AT_MS + 23,
              CANDIDATE_DEADLINE_AT_MS + 23,
              recovery.id
            );
        },
        /lacks current commissioner authority/i
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              commissioner_reason =
                'The deterministic retry is complete.',
              resolved_by_user_id = ?,
              resolved_by_membership_id = ?,
              resolved_authority =
                'platform_administrator_as_commissioner',
              resolved_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          ids.commissionerUser,
          ids.commissionerMembership,
          CANDIDATE_DEADLINE_AT_MS + 23,
          CANDIDATE_DEADLINE_AT_MS + 23,
          recovery.id
        );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              DELETE FROM free_agent_draft_recoveries
              WHERE id = ?
            `)
            .run(recovery.id);
        },
        /cannot be deleted/i
      );
    });

    test("gates durable lifecycle work and atomically completes FAD and season without moving Week 1", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0025-completion-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0025-completion");
      const ids = seedScenario(runtime, {
        base: 5_000,
        secondTeam: true,
      });
      const fixture = createDeadlineFixture(
        runtime.database,
        ids,
        uuid(95_000)
      );
      fixture.rollovers = seedRollovers(
        runtime.database,
        ids,
        fixture.fad.id
      );
      fixture.allocation = seedPendingAllocation(
        runtime.database,
        ids,
        fixture
      );
      fixture.jobs = seedDurableJobs(
        runtime.database,
        ids,
        fixture,
        fixture.allocation,
        { omit: "deadline" }
      );

      assertConstraint(
        () => lockDeadline(runtime.database, fixture),
        /exact deadline occurrence/i
      );
      insert(
        runtime.database,
        "job_runs",
        fixture.jobs.deadline
      );
      leaseJob(runtime.database, fixture.jobs.deadline, SNAPSHOT_AT_MS);
      lockDeadline(runtime.database, fixture);
      leaseJob(
        runtime.database,
        fixture.jobs.allocation,
        CANDIDATE_DEADLINE_AT_MS + 20
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'allocating',
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          CANDIDATE_DEADLINE_AT_MS + 21,
          fixture.fad.id
        );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_drafts
              SET status = 'rapid',
                  allocation_completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 4
              WHERE id = ?
            `)
            .run(
              CANDIDATE_DEADLINE_AT_MS + 30,
              CANDIDATE_DEADLINE_AT_MS + 30,
              fixture.fad.id
            );
        },
        /allocation decision to be evidenced/i
      );

      const deferredDecisionAtMs =
        fixture.rollovers[6].creation_cutoff_at_ms;
      const rapidStartedAtMs = deferredDecisionAtMs + 1;
      leaseJob(
        runtime.database,
        fixture.jobs.allocation,
        deferredDecisionAtMs
      );
      let allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "deferred_restricted_recovery",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: deferredDecisionAtMs,
          last_error_code: "FAIR_WINDOW_UNAVAILABLE",
          updated_at_ms: deferredDecisionAtMs,
        }
      );
      insertAllocationOfferEvidence(
        runtime.database,
        ids,
        fixture,
        allocation,
        {
          id: uuid(5_703),
          occurred_at_ms: deferredDecisionAtMs,
          created_at_ms: deferredDecisionAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(ids, fixture, allocation, {
          id: uuid(5_702),
          occurred_at_ms: deferredDecisionAtMs,
          created_at_ms: deferredDecisionAtMs,
        })
      );
      const deferredActivationAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + 1;
      const deferredResolutionAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + HOUR_MS + 2;
      const deferredActivationJob = jobRunRecord(
        ids,
        uuid(5_630),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${allocation.id}:${deferredActivationAtMs}`,
        deferredActivationAtMs
      );
      insert(
        runtime.database,
        "job_runs",
        deferredActivationJob
      );
      const deferredRecovery = recoveryRecord(ids, {
        ...fixture,
        allocation,
      }, {
        id: uuid(5_800),
        kind: "deferred_restricted",
        job_run_id: deferredActivationJob.id,
        earliest_activation_at_ms: deferredActivationAtMs,
        target_resolution_at_ms: deferredResolutionAtMs,
        last_error_code: "FAIR_WINDOW_UNAVAILABLE",
        created_by_operation_id:
          "deferred-restricted-window-1",
        created_at_ms: deferredDecisionAtMs,
        updated_at_ms: deferredDecisionAtMs,
      });
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        deferredRecovery
      );
      finishRapid(
        runtime.database,
        fixture,
        rapidStartedAtMs
      );

      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE seasons
              SET free_agent_draft_completed_at_ms = ?
              WHERE id = ?
            `)
            .run(
              FIRST_MATCHUP_STARTS_AT_MS,
              ids.targetSeason
            );
        },
        /must match its completed FAD/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_drafts
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 5
              WHERE id = ?
            `)
            .run(
              FIRST_MATCHUP_STARTS_AT_MS,
              FIRST_MATCHUP_STARTS_AT_MS,
              fixture.fad.id
            );
        },
        /seven accounted rollovers/i
      );
      const firstRollover = fixture.rollovers[0];
      const rolloverRecoveryCreatedAtMs =
        firstRollover.rolls_over_at_ms + 1;
      const rolloverFinalizeRecovery = recoveryRecord(ids, {
        ...fixture,
        allocation,
      }, {
        id: uuid(5_801),
        player_id: null,
        allocation_id: null,
        rollover_id: firstRollover.id,
        auction_id: null,
        job_run_id: fixture.jobs["rollover-1"].id,
        kind: "rollover_finalize",
        last_error_code: "ROLLOVER_FINALIZE_PENDING",
        created_by_operation_id:
          "rollover-1-finalize-pending",
        created_at_ms: rolloverRecoveryCreatedAtMs,
        updated_at_ms: rolloverRecoveryCreatedAtMs,
      });
      for (const rollover of fixture.rollovers) {
        completeRollover(
          runtime.database,
          rollover,
          fixture.jobs[`rollover-${rollover.sequence}`],
          rollover.sequence === 1
            ? rolloverFinalizeRecovery
            : null
        );
      }
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        FIRST_MATCHUP_STARTS_AT_MS
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_drafts
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 5
              WHERE id = ?
            `)
            .run(
              FIRST_MATCHUP_STARTS_AT_MS + 1,
              FIRST_MATCHUP_STARTS_AT_MS + 1,
              fixture.fad.id
            );
        },
        /actual rollover completion/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_drafts
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 5
              WHERE id = ?
            `)
            .run(
              FIRST_MATCHUP_STARTS_AT_MS - 1,
              FIRST_MATCHUP_STARTS_AT_MS - 1,
              fixture.fad.id
            );
        },
        /cannot precede the seventh rollover/i
      );

      const completedAtMs = FIRST_MATCHUP_STARTS_AT_MS + 100;
      const assertPrerequisiteMutationBlocksCompletion = (
        mutatePrerequisite,
        expectedMessage
      ) => {
        runtime.database.exec("BEGIN");
        try {
          mutatePrerequisite();
          assertConstraint(
            () => {
              runtime.database
                .prepare(`
                  UPDATE free_agent_drafts
                  SET status = 'completed',
                      completed_at_ms = ?,
                      updated_at_ms = ?,
                      version = 5
                  WHERE id = ?
                `)
                .run(
                  completedAtMs,
                  completedAtMs,
                  fixture.fad.id
                );
            },
            expectedMessage
          );
        } finally {
          runtime.database.exec("ROLLBACK");
        }
      };
      const assertStalePrerequisiteBlocksCompletion = (
        job,
        expectedMessage
      ) => assertPrerequisiteMutationBlocksCompletion(
        () => leaseJob(
          runtime.database,
          job,
          completedAtMs - 2
        ),
        expectedMessage
      );
      assertStalePrerequisiteBlocksCompletion(
        fixture.jobs.deadline,
        /terminal deadline occurrence/i
      );
      assertStalePrerequisiteBlocksCompletion(
        fixture.jobs.allocation,
        /terminal allocation occurrences/i
      );
      assertStalePrerequisiteBlocksCompletion(
        fixture.jobs["rollover-2"],
        /terminal rollover occurrences/i
      );
      assertPrerequisiteMutationBlocksCompletion(
        () => runtime.database
          .prepare(`
            UPDATE job_runs
            SET completed_at_ms = NULL,
                version = version + 1
            WHERE id = ?
          `)
          .run(fixture.jobs.deadline.id),
        /terminal deadline occurrence/i
      );
      assertPrerequisiteMutationBlocksCompletion(
        () => runtime.database
          .prepare(`
            UPDATE job_runs
            SET completed_at_ms = ?,
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            completedAtMs + 1,
            completedAtMs + 1,
            fixture.jobs.deadline.id
          ),
        /terminal deadline occurrence/i
      );
      assertPrerequisiteMutationBlocksCompletion(
        () => runtime.database
          .prepare(`
            UPDATE job_runs
            SET lease_owner = 'forged-terminal-owner',
                lease_token = 'forged-terminal-token',
                lease_expires_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            completedAtMs + HOUR_MS,
            fixture.jobs.deadline.id
          ),
        /terminal deadline occurrence/i
      );
      assertPrerequisiteMutationBlocksCompletion(
        () => runtime.database
          .prepare(`
            UPDATE job_runs
            SET last_error_code =
                  'MISMATCHED_ROLLOVER_FAILURE',
                version = version + 1
            WHERE id = ?
          `)
          .run(fixture.jobs["rollover-1"].id),
        /terminal rollover occurrences/i
      );
      assertPrerequisiteMutationBlocksCompletion(
        () => leaseJob(
          runtime.database,
          fixture.jobs.completion,
          completedAtMs + 1
        ),
        /exact durable occurrence/i
      );
      assertPrerequisiteMutationBlocksCompletion(
        () => runtime.database
          .prepare(`
            UPDATE job_runs
            SET started_at_ms = ?,
                result_json = '{}',
                last_error_code =
                  'STALE_COMPLETION_FAILURE',
                next_attempt_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            completedAtMs - 1,
            completedAtMs + 1,
            fixture.jobs.completion.id
          ),
        /exact durable occurrence/i
      );
      assertPrerequisiteMutationBlocksCompletion(
        () => runtime.database
          .prepare(`
            UPDATE job_runs
            SET status = 'running',
                started_at_ms = ?,
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            completedAtMs + 1,
            completedAtMs - 1,
            fixture.jobs.completion.id
          ),
        /exact durable occurrence/i
      );

      const weekBefore = runtime.database
        .prepare("SELECT * FROM matchup_weeks WHERE id = ?")
        .get(ids.week);
      const allocationBefore = runtime.database
        .prepare(`
          SELECT *
          FROM free_agent_draft_player_allocations
          WHERE id = ?
        `)
        .get(allocation.id);
      const recoveryBefore = runtime.database
        .prepare(`
          SELECT *
          FROM free_agent_draft_recoveries
          WHERE id = ?
          `)
          .get(deferredRecovery.id);
      expireJobLease(
        runtime.database,
        fixture.jobs.completion,
        completedAtMs - 1
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_drafts
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 5
              WHERE id = ?
            `)
            .run(
              completedAtMs,
              completedAtMs,
              fixture.fad.id
            );
        },
        /exact durable occurrence/i
      );
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        completedAtMs - 1
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 5
          WHERE id = ?
        `)
        .run(
          completedAtMs,
          completedAtMs,
          fixture.fad.id
        );

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, completed_at_ms
            FROM free_agent_drafts
            WHERE id = ?
          `)
          .get(fixture.fad.id),
        {
          status: "completed",
          completed_at_ms: completedAtMs,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT free_agent_draft_completed_at_ms
            FROM seasons
            WHERE id = ?
          `)
          .get(ids.targetSeason)
          .free_agent_draft_completed_at_ms,
        completedAtMs
      );
      assert.deepEqual(
        runtime.database
          .prepare("SELECT * FROM matchup_weeks WHERE id = ?")
          .get(ids.week),
        weekBefore
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT *
            FROM free_agent_draft_player_allocations
            WHERE id = ?
          `)
          .get(allocation.id),
        allocationBefore
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT *
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(deferredRecovery.id),
        recoveryBefore
      );
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
  }
);
