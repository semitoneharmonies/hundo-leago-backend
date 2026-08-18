"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
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
  FREE_AGENT_DRAFT_CORRECTION_MODE,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);
const {
  deriveFreeAgentDraftCorrectionResourceId,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCorrectionResourceIdentityPolicy"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  FREE_AGENT_DRAFT_CORRECTION_PREVIEW_REPOSITORY_CODES,
  createSqliteFreeAgentDraftCorrectionPreviewRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftCorrectionPreviewRepository"
);
const {
  createSqliteFreeAgentDraftReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadRepository"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DEADLINE_AT_MS = Date.parse(
  "2026-09-28T07:00:00.000Z"
);
const WEEK_ONE_AT_MS =
  DEADLINE_AT_MS + 7 * 24 * 60 * 60 * 1_000;
const OPENED_AT_MS =
  DEADLINE_AT_MS - 30 * 24 * 60 * 60 * 1_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  commissionerUser: uuid(3),
  commissionerMembership: uuid(4),
  administratorUser: uuid(5),
  administratorMembership: uuid(6),
  administratorRole: uuid(7),
  memberUser: uuid(8),
  memberMembership: uuid(9),
  teamCorrect: uuid(10),
  teamWrong: uuid(11),
  week: uuid(12),
  readiness: uuid(13),
  fad: uuid(14),
  player: uuid(15),
  position: uuid(16),
  allocation: uuid(17),
  correctSnapshot: uuid(18),
  wrongSnapshot: uuid(19),
  correctCard: uuid(20),
  wrongCard: uuid(21),
  correctEntry: uuid(22),
  wrongEntry: uuid(23),
  correctSourceEntry: uuid(24),
  wrongSourceEntry: uuid(25),
  correctEvent: uuid(26),
  wrongEvent: uuid(27),
  contract: uuid(28),
  contractYear: uuid(29),
  contractEvent: uuid(30),
  ownership: uuid(31),
  ownershipEvent: uuid(32),
  recovery: uuid(33),
  trade: uuid(34),
  tradeAsset: uuid(35),
  buyout: uuid(36),
  orderSet: uuid(37),
  orderEntry: uuid(38),
  rollover: uuid(39),
  auction: uuid(40),
  draw: uuid(41),
  resolvedRecovery: uuid(42),
  secondUnresolvedRecovery: uuid(43),
});

let suiteRoot;
let templatePath;

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(`
      INSERT INTO "${tableName}" (
        ${columns.map((column) => `"${column}"`).join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function dropAllTriggers(database) {
  for (const { name } of database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
      ORDER BY name
    `)
    .all()) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
}

function seedUser(database, id, name) {
  const normalized = name.toLowerCase();
  const email = `${normalized.replaceAll(" ", "-")}@example.test`;
  insert(database, "users", {
    id,
    email_normalized: email,
    email_display: email,
    display_name: name,
    display_name_normalized: normalized,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
}

function seedMembership(
  database,
  id,
  userId,
  permissionCategory
) {
  insert(database, "league_memberships", {
    id,
    league_id: IDS.league,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
}

function seedTeam(database, id, name, colours) {
  insert(database, "teams", {
    id,
    league_id: IDS.league,
    name,
    name_normalized: name.toLowerCase(),
    status: "active",
    primary_colour: colours[0],
    secondary_colour: colours[1],
    logo_reference: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    tertiary_colour: colours[2] || null,
    pattern_template: "mirrored-centre-band",
  });
}

function seedCore(database) {
  database.pragma("foreign_keys = OFF");
  database.pragma("ignore_check_constraints = ON");
  dropAllTriggers(database);

  seedUser(
    database,
    IDS.commissionerUser,
    "Current Commissioner"
  );
  seedUser(
    database,
    IDS.administratorUser,
    "Platform Administrator"
  );
  seedUser(database, IDS.memberUser, "League Member");
  insert(database, "leagues", {
    id: IDS.league,
    name: "Correction Preview League",
    name_normalized: "correction preview league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id:
      IDS.commissionerMembership,
    current_season_id: IDS.season,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  seedMembership(
    database,
    IDS.commissionerMembership,
    IDS.commissionerUser,
    "commissioner"
  );
  seedMembership(
    database,
    IDS.administratorMembership,
    IDS.administratorUser,
    "member"
  );
  seedMembership(
    database,
    IDS.memberMembership,
    IDS.memberUser,
    "member"
  );
  insert(database, "platform_roles", {
    id: IDS.administratorRole,
    user_id: IDS.administratorUser,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: IDS.commissionerUser,
    granted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: WEEK_ONE_AT_MS,
    regular_season_ends_at_ms:
      WEEK_ONE_AT_MS + 100 * 24 * 60 * 60 * 1_000,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 70 * 24 * 60 * 60 * 1_000,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 98 * 24 * 60 * 60 * 1_000,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  insert(database, "league_settings", {
    league_id: IDS.league,
    salary_cap_cents: 100_000,
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
  seedTeam(database, IDS.teamCorrect, "Snow Owls", [
    "#112233",
    "#ffffff",
  ]);
  seedTeam(database, IDS.teamWrong, "Ice Bears", [
    "#223344",
    "#eeeeee",
    "#556677",
  ]);
  insert(database, "players", {
    id: IDS.player,
    first_name: "Preview",
    last_name: "Player",
    full_name: "Preview Player",
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_player_positions", {
    id: IDS.position,
    league_id: IDS.league,
    player_id: IDS.player,
    position_group: "F",
    reason: "Authoritative test position.",
    corrected_by_user_id: IDS.commissionerUser,
    effective_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "free_agent_drafts", {
    id: IDS.fad,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    readiness_occurrence_key:
      `fad-readiness:${IDS.league}:${IDS.season}`,
    first_matchup_week_id: IDS.week,
    current_competition_first_matchup_week_id:
      IDS.week,
    schedule_recovery_id: null,
    participating_team_count: 2,
    status: "allocating",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Inaugural season.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms:
      DEADLINE_AT_MS - 2 * 24 * 60 * 60 * 1_000,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: DEADLINE_AT_MS,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 2,
  });
}

function seedOffer(
  database,
  {
    snapshotId,
    cardId,
    teamId,
    entryId,
    sourceEntryId,
    slotNumber,
    totalValueCents,
    termYears,
    aavCents,
  }
) {
  insert(database, "candidate_card_snapshots", {
    id: snapshotId,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: cardId,
    team_id: teamId,
    locked_card_version: 1,
    locked_status: "locked_incomplete",
    completeness_code: "incomplete",
    filled_mandatory_count: 1,
    missing_mandatory_count: 17,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    cap_limit_cents: 100_000,
    carried_active_player_amount_cents: 0,
    retention_obligation_cents: 0,
    buyout_penalty_cents: 0,
    carried_cap_usage_cents: 0,
    proposed_candidate_aav_cents: aavCents,
    maximum_possible_cap_cents: aavCents,
    maximum_cap_space_cents: 100_000 - aavCents,
    effective_deadline_at_ms: DEADLINE_AT_MS,
    processed_at_ms: DEADLINE_AT_MS,
    created_at_ms: DEADLINE_AT_MS,
    carried_roster_structural_conflict_count: 0,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  insert(database, "candidate_card_snapshot_entries", {
    id: entryId,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    snapshot_id: snapshotId,
    card_id: cardId,
    team_id: teamId,
    row_kind: "slot",
    occupant_kind: "candidate",
    slot_group: "F",
    slot_number: slotNumber,
    source_entry_id: sourceEntryId,
    source_entry_version: 1,
    player_id: IDS.player,
    effective_position_group: "F",
    conflict_code: null,
    carryover_ownership_id: null,
    carryover_contract_id: null,
    source_roster_category: null,
    carryover_original_total_value_cents: null,
    carryover_original_term_years: null,
    carryover_aav_cents: null,
    remaining_years: null,
    proposed_total_value_cents: totalValueCents,
    proposed_term_years: termYears,
    proposed_aav_cents: aavCents,
    eligibility_status: "valid",
    validation_code: "ELIGIBLE",
    last_edited_by_user_id: IDS.commissionerUser,
    last_edited_by_membership_id:
      IDS.commissionerMembership,
    last_edited_by_authority: "commissioner",
    last_edited_at_ms: DEADLINE_AT_MS - 1,
    created_at_ms: DEADLINE_AT_MS,
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
}

function seedAllocationEvent(
  database,
  {
    id,
    allocationStatus,
    entryId,
    teamId,
    rank,
    outcomeCode,
  }
) {
  insert(database, "free_agent_draft_allocation_events", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    allocation_version: 3,
    player_id: IDS.player,
    event_kind: "offer_considered",
    snapshot_entry_id: entryId,
    team_id: teamId,
    offer_valid: 1,
    rank_position: rank,
    offer_outcome_code: outcomeCode,
    decision_code: null,
    resulting_allocation_status: allocationStatus,
    contract_id: null,
    ownership_id: null,
    auction_id: null,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: "{}",
    occurred_at_ms: DEADLINE_AT_MS + 1_000,
    created_at_ms: DEADLINE_AT_MS + 1_000,
    version: 1,
  });
}

function seedLockedOffers(database) {
  seedOffer(database, {
    snapshotId: IDS.correctSnapshot,
    cardId: IDS.correctCard,
    teamId: IDS.teamCorrect,
    entryId: IDS.correctEntry,
    sourceEntryId: IDS.correctSourceEntry,
    slotNumber: 1,
    totalValueCents: 600,
    termYears: 2,
    aavCents: 300,
  });
  seedOffer(database, {
    snapshotId: IDS.wrongSnapshot,
    cardId: IDS.wrongCard,
    teamId: IDS.teamWrong,
    entryId: IDS.wrongEntry,
    sourceEntryId: IDS.wrongSourceEntry,
    slotNumber: 2,
    totalValueCents: 500,
    termYears: 1,
    aavCents: 500,
  });
}

function seedWrongCompletedResult(database) {
  seedLockedOffers(database);
  insert(database, "contracts", {
    id: IDS.contract,
    league_id: IDS.league,
    player_id: IDS.player,
    current_team_id: IDS.teamWrong,
    contract_type: "normal",
    original_total_value_cents: 500,
    original_term_years: 1,
    aav_cents: 500,
    start_season_id: IDS.season,
    status: "active",
    acquisition_source_type:
      "free_agent_draft_allocation",
    acquisition_source_id: IDS.allocation,
    auction_buyout_lock_expires_at_ms:
      DEADLINE_AT_MS + 14 * 24 * 60 * 60 * 1_000,
    created_at_ms: DEADLINE_AT_MS + 1_000,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 1,
  });
  insert(database, "contract_years", {
    id: IDS.contractYear,
    league_id: IDS.league,
    contract_id: IDS.contract,
    season_id: IDS.season,
    year_number: 1,
    aav_cents: 500,
    status: "current",
    rollover_at_ms: null,
    created_at_ms: DEADLINE_AT_MS + 1_000,
  });
  insert(database, "contract_events", {
    id: IDS.contractEvent,
    league_id: IDS.league,
    contract_id: IDS.contract,
    player_id: IDS.player,
    team_id: IDS.teamWrong,
    actor_user_id: null,
    event_type: "contract_created",
    source_type: "free_agent_draft_allocation",
    source_id: IDS.allocation,
    metadata_json: "{}",
    reason: null,
    occurred_at_ms: DEADLINE_AT_MS + 1_000,
  });
  insert(database, "player_ownerships", {
    id: IDS.ownership,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    team_id: IDS.teamWrong,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 2,
    acquired_transaction_type:
      "free_agent_draft_allocation",
    acquired_transaction_id: IDS.allocation,
    created_at_ms: DEADLINE_AT_MS + 1_000,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 1,
    trade_blocked: 0,
  });
  insert(database, "ownership_events", {
    id: IDS.ownershipEvent,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    team_id: IDS.teamWrong,
    ownership_id: IDS.ownership,
    event_type: "fad_allocation_player_acquired",
    actor_user_id: null,
    source_type: "free_agent_draft_allocation",
    source_id: IDS.allocation,
    before_metadata_json: null,
    after_metadata_json: "{}",
    reason: null,
    occurred_at_ms: DEADLINE_AT_MS + 1_000,
  });
  insert(database, "free_agent_draft_player_allocations", {
    id: IDS.allocation,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    player_id: IDS.player,
    status: "automatic_award",
    decision_code: "highest_total",
    winning_snapshot_entry_id: IDS.wrongEntry,
    winning_team_id: IDS.teamWrong,
    contract_id: IDS.contract,
    ownership_id: IDS.ownership,
    restricted_auction_id: null,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: null,
    restricted_minimum_term_years: null,
    restricted_minimum_aav_cents: null,
    accounted_at_ms: DEADLINE_AT_MS + 1_000,
    last_error_code: null,
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 3,
  });
  seedAllocationEvent(database, {
    id: IDS.wrongEvent,
    allocationStatus: "automatic_award",
    entryId: IDS.wrongEntry,
    teamId: IDS.teamWrong,
    rank: 1,
    outcomeCode: "winner",
  });
  seedAllocationEvent(database, {
    id: IDS.correctEvent,
    allocationStatus: "automatic_award",
    entryId: IDS.correctEntry,
    teamId: IDS.teamCorrect,
    rank: 2,
    outcomeCode: "lost_lower_aav",
  });
}

function seedCorrectionRequired(database) {
  seedLockedOffers(database);
  insert(database, "free_agent_draft_player_allocations", {
    id: IDS.allocation,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    player_id: IDS.player,
    status: "correction_required",
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
    last_error_code: "PLAYER_OWNED",
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 3,
  });
  seedAllocationEvent(database, {
    id: IDS.correctEvent,
    allocationStatus: "correction_required",
    entryId: IDS.correctEntry,
    teamId: IDS.teamCorrect,
    rank: 1,
    outcomeCode: "winner",
  });
  seedAllocationEvent(database, {
    id: IDS.wrongEvent,
    allocationStatus: "correction_required",
    entryId: IDS.wrongEntry,
    teamId: IDS.teamWrong,
    rank: 2,
    outcomeCode: "lost_lower_total",
  });
  insert(database, "free_agent_draft_recoveries", {
    id: IDS.recovery,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    player_id: IDS.player,
    allocation_id: IDS.allocation,
    rollover_id: null,
    auction_id: null,
    job_run_id: null,
    kind: "allocation_retry",
    status: "correction_required",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: "PLAYER_OWNED",
    commissioner_reason: null,
    created_by_operation_id: null,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: DEADLINE_AT_MS + 1_000,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    resolved_at_ms: null,
    version: 1,
    nomination_queue_id: null,
  });
}

function seedExactTieCorrectionRequired(database) {
  seedCorrectionRequired(database);
  database
    .prepare(`
      UPDATE candidate_card_snapshot_entries
      SET proposed_total_value_cents = 600,
          proposed_term_years = 2,
          proposed_aav_cents = 300
      WHERE id = ?
    `)
    .run(IDS.wrongEntry);
  database
    .prepare(`
      UPDATE candidate_card_snapshots
      SET proposed_candidate_aav_cents = 300,
          maximum_possible_cap_cents = 300,
          maximum_cap_space_cents = 99700
      WHERE id = ?
    `)
    .run(IDS.wrongSnapshot);
}

function seedLinkedAuction(
  database,
  { includeDraw = true } = {}
) {
  insert(database, "auctions", {
    id: IDS.auction,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    status: "open",
    opened_at_ms: DEADLINE_AT_MS + 1_000,
    resolves_at_ms:
      DEADLINE_AT_MS + 24 * 60 * 60 * 1_000,
    opened_by_user_id: null,
    created_at_ms: DEADLINE_AT_MS + 1_000,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 1,
  });
  insert(database, "auction_contexts", {
    id: IDS.auction,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: IDS.auction,
    source_kind: "fad_restricted",
    fad_id: IDS.fad,
    fad_rollover_id: IDS.rollover,
    fad_allocation_id: IDS.allocation,
    fad_origin: "candidate_tie_restricted",
    created_at_ms: DEADLINE_AT_MS + 1_000,
  });
  if (!includeDraw) return;
  insert(database, "free_agent_draft_draws", {
    id: IDS.draw,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    auction_id: IDS.auction,
    algorithm_version: 1,
    nonce_bytes: Buffer.alloc(32, 7),
    commitment_hex: "7".repeat(64),
    ordered_tied_bid_ids_json: null,
    ordered_tied_team_ids_json: null,
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: null,
    created_at_ms: DEADLINE_AT_MS + 1_000,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 1,
  });
}

function seedAdditionalRecovery(
  database,
  {
    id,
    status,
    createdAtMs,
    updatedAtMs,
  }
) {
  const resolved = status === "resolved";
  insert(database, "free_agent_draft_recoveries", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    player_id: IDS.player,
    allocation_id: IDS.allocation,
    rollover_id: null,
    auction_id: null,
    job_run_id: null,
    kind: "allocation_retry",
    status,
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: resolved ? null : "SECOND_RECOVERY",
    commissioner_reason: null,
    created_by_operation_id: null,
    resolved_by_user_id:
      resolved ? IDS.commissionerUser : null,
    resolved_by_membership_id:
      resolved ? IDS.commissionerMembership : null,
    resolved_authority:
      resolved ? "commissioner" : null,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    resolved_at_ms: resolved ? updatedAtMs : null,
    version: resolved ? 2 : 1,
    nomination_queue_id: null,
  });
}

function createRuntime(t, seed) {
  const root = fs.mkdtempSync(
    path.join(suiteRoot, "case-")
  );
  const databasePath = path.join(root, "league.sqlite3");
  fs.copyFileSync(templatePath, databasePath);
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  seedCore(connection.database);
  seed(connection.database);
  connection.database.pragma("wal_checkpoint(TRUNCATE)");
  const repository =
    createSqliteFreeAgentDraftCorrectionPreviewRepository({
      database: connection.database,
    });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({
    database: connection.database,
    databasePath,
    repository,
  });
}

function normalizeHashValue(value) {
  if (Buffer.isBuffer(value)) {
    return Object.freeze({
      type: "buffer",
      base64: value.toString("base64"),
    });
  }
  return value;
}

function semanticTableHashes(database) {
  const result = {};
  const tables = database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all();
  for (const { name } of tables) {
    const quoted = name.replaceAll('"', '""');
    const rows = database
      .prepare(`SELECT * FROM "${quoted}"`)
      .all()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            normalizeHashValue(value),
          ])
        )
      )
      .map((row) => JSON.stringify(row))
      .sort();
    result[name] = createHash("sha256")
      .update(JSON.stringify(rows), "utf8")
      .digest("hex");
  }
  return Object.freeze(result);
}

function noWriteSnapshot(runtime) {
  return Object.freeze({
    byteHash: createHash("sha256")
      .update(fs.readFileSync(runtime.databasePath))
      .digest("hex"),
    semanticTableHashes: semanticTableHashes(
      runtime.database
    ),
    totalChanges: runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count,
  });
}

function assertNoWrites(runtime, before) {
  assert.deepEqual(noWriteSnapshot(runtime), before);
}

function assertPreviewAuthorizationDenied(
  runtime,
  input
) {
  const before = noWriteSnapshot(runtime);
  assert.throws(
    () =>
      runtime.repository.previewAllocationCorrection(input),
    (error) => {
      assert.equal(
        error.code,
        FREE_AGENT_DRAFT_CORRECTION_PREVIEW_REPOSITORY_CODES
          .authorizationDenied
      );
      assert.equal(
        error.message,
        "Current commissioner authority is required to preview a FAD allocation correction."
      );
      assert.equal(error.details, undefined);
      return true;
    }
  );
  assertNoWrites(runtime, before);
}

function commissionerInput(overrides = {}) {
  return {
    actorAuthority: "commissioner",
    actorMembershipId: IDS.commissionerMembership,
    actorUserId: IDS.commissionerUser,
    allocationId: IDS.allocation,
    fadId: IDS.fad,
    leagueId: IDS.league,
    mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
    ...overrides,
  };
}

function t140Decision(database) {
  const result = createSqliteFreeAgentDraftReadRepository({
    database,
  }).readAllocationResults({
    leagueId: IDS.league,
    fadId: IDS.fad,
    viewerUserId: IDS.commissionerUser,
    viewerMembershipId: IDS.commissionerMembership,
    nowMs: DEADLINE_AT_MS + 1_000,
    query: {
      q: "preview player",
      status: null,
      limit: 10,
      cursor: null,
    },
  }).data[0];
  return Object.freeze({
    status: result.status,
    decisionCode: result.decisionCode,
    rankedOffers: result.rankedOffers,
    winner: result.winner,
    restricted: result.restricted,
    recoveryStatus: result.recoveryStatus,
  });
}

function seedIrreversibleDrift(database) {
  database
    .prepare(`
      UPDATE contracts
      SET updated_at_ms = updated_at_ms + 10,
          version = 2
      WHERE id = ?
    `)
    .run(IDS.contract);
  database
    .prepare(`
      UPDATE player_ownerships
      SET slot_number = 3,
          updated_at_ms = updated_at_ms + 10,
          version = 2
      WHERE id = ?
    `)
    .run(IDS.ownership);
  insert(database, "trades", {
    id: IDS.trade,
    league_id: IDS.league,
    season_id: IDS.season,
    proposing_team_id: IDS.teamWrong,
    receiving_team_id: IDS.teamCorrect,
    proposing_user_id: IDS.commissionerUser,
    creating_membership_id: IDS.commissionerMembership,
    creating_authority: "commissioner",
    status: "proposed",
    created_at_ms: DEADLINE_AT_MS + 2_000,
    expires_at_ms: DEADLINE_AT_MS + 50_000,
    effective_deadline_at_ms: DEADLINE_AT_MS + 50_000,
    responded_at_ms: null,
    completed_at_ms: null,
    commissioner_completion_reference: null,
    proposal_model_version: 1,
    updated_at_ms: DEADLINE_AT_MS + 2_000,
    version: 2,
  });
  insert(database, "trade_assets", {
    id: IDS.tradeAsset,
    league_id: IDS.league,
    trade_id: IDS.trade,
    direction: "proposing_to_receiving",
    source_team_id: IDS.teamWrong,
    destination_team_id: IDS.teamCorrect,
    asset_type: "contract",
    contract_id: IDS.contract,
    player_id: null,
    draft_pick_id: null,
    retention_obligation_id: null,
    buyout_obligation_id: null,
    future_consideration_id: null,
    requested_retention_contract_id: null,
    requested_retention_cents: null,
    future_consideration_description: null,
    proposal_snapshot_json: "{}",
    asset_model_version: 1,
    sequence: 1,
    created_at_ms: DEADLINE_AT_MS + 2_000,
  });
  insert(database, "buyout_obligations", {
    id: IDS.buyout,
    league_id: IDS.league,
    contract_id: IDS.contract,
    player_id: IDS.player,
    originating_team_id: IDS.teamWrong,
    responsible_team_id: IDS.teamWrong,
    annual_penalty_basis_cents: 250,
    buyout_transaction_id: uuid(300),
    status: "active",
    created_at_ms: DEADLINE_AT_MS + 2_000,
    updated_at_ms: DEADLINE_AT_MS + 2_000,
    version: 3,
  });
  insert(database, "roster_display_order_sets", {
    id: IDS.orderSet,
    league_id: IDS.league,
    season_id: IDS.season,
    team_id: IDS.teamWrong,
    updated_by_user_id: IDS.commissionerUser,
    created_at_ms: DEADLINE_AT_MS + 2_000,
    updated_at_ms: DEADLINE_AT_MS + 3_000,
    version: 4,
  });
  insert(database, "roster_display_order_entries", {
    id: IDS.orderEntry,
    league_id: IDS.league,
    order_set_id: IDS.orderSet,
    ownership_id: IDS.ownership,
    position_group: "F",
    display_order: 1,
    created_at_ms: DEADLINE_AT_MS + 2_000,
  });
}

before(() => {
  suiteRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-t143-")
  );
  templatePath = path.join(suiteRoot, "schema52.sqlite3");
  const connection = openDatabase({
    databasePath: templatePath,
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad-t143-preview-foundation",
    now: () => 1,
  });
  assert.equal(
    connection.database.pragma("user_version", {
      simple: true,
    }),
    52
  );
  connection.database.pragma("wal_checkpoint(TRUNCATE)");
  connection.database.close();
});

after(() => {
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});

describe(
  "Free Agent Draft allocation-correction preview repository foundation",
  () => {
    test("recomputes a wrong completed result, reuses the exact T-140 current decision, and remains byte-for-byte read-only", (t) => {
      const runtime = createRuntime(
        t,
        seedWrongCompletedResult
      );
      const exactT140 = t140Decision(runtime.database);
      const before = noWriteSnapshot(runtime);
      const preview =
        runtime.repository.previewAllocationCorrection(
          commissionerInput()
        );

      assert.deepEqual(preview.currentDecision, exactT140);
      assert.equal(preview.reversible, true);
      assert.equal(
        preview.currentDecision.winner.teamId,
        IDS.teamWrong
      );
      assert.equal(
        preview.recomputedDecision.winner.teamId,
        IDS.teamCorrect
      );
      assert.equal(
        preview.recomputedDecision.decisionCode,
        "highest_total"
      );
      assert.equal(
        preview.previewFingerprint,
        "d3d4dc12bfb2a75466a24d4ee296269dfffa88c6b7f75e7f4c5eea872423b662"
      );
      assert.deepEqual(
        preview.deltas.map(
          ({ resourceType, resourceId, action, beforeVersion }) => ({
            resourceType,
            resourceId,
            action,
            beforeVersion,
          })
        ),
        [
          {
            resourceType: "allocation",
            resourceId: IDS.allocation,
            action: "update",
            beforeVersion: 3,
          },
          {
            resourceType: "contract",
            resourceId: IDS.contract,
            action: "update",
            beforeVersion: 1,
          },
          {
            resourceType: "ownership",
            resourceId: IDS.ownership,
            action: "release",
            beforeVersion: 1,
          },
          {
            resourceType: "roster_entry",
            resourceId: IDS.ownership,
            action: "remove",
            beforeVersion: 1,
          },
          {
            resourceType: "contract",
            resourceId: null,
            action: "create",
            beforeVersion: null,
          },
          {
            resourceType: "ownership",
            resourceId: null,
            action: "create",
            beforeVersion: null,
          },
          {
            resourceType: "roster_entry",
            resourceId: null,
            action: "create",
            beforeVersion: null,
          },
          {
            resourceType: "activity",
            resourceId: null,
            action: "append",
            beforeVersion: null,
          },
        ]
      );
      assert.deepEqual(
        runtime.repository.previewAllocationCorrection(
          commissionerInput()
        ),
        preview
      );
      assertNoWrites(runtime, before);
    });

    test("lets an active league-member platform administrator preview correction-required recovery with stable prospective identities", (t) => {
      const runtime = createRuntime(
        t,
        seedCorrectionRequired
      );
      const before = noWriteSnapshot(runtime);
      const preview =
        runtime.repository.previewAllocationCorrection({
          ...commissionerInput(),
          actorAuthority:
            "platform_administrator_as_commissioner",
          actorMembershipId:
            IDS.administratorMembership,
          actorUserId: IDS.administratorUser,
        });
      const identityBase = {
        leagueId: IDS.league,
        fadId: IDS.fad,
        allocationId: IDS.allocation,
        acceptedFromAllocationVersion: 3,
        targetTeamId: IDS.teamCorrect,
      };
      assert.equal(preview.reversible, true);
      assert.equal(
        preview.currentDecision.status,
        "correction_required"
      );
      assert.equal(
        preview.recomputedDecision.status,
        "automatic_award"
      );
      assert.equal(
        preview.recomputedDecision.recoveryStatus,
        "resolved"
      );
      assert.equal(
        preview.recomputedDecision.winner.contractId,
        deriveFreeAgentDraftCorrectionResourceId({
          ...identityBase,
          resourceType: "contract",
        })
      );
      assert.equal(
        preview.recomputedDecision.winner.ownershipId,
        deriveFreeAgentDraftCorrectionResourceId({
          ...identityBase,
          resourceType: "ownership",
        })
      );
      assert.equal(
        preview.deltas.some(
          (delta) =>
            delta.resourceType === "recovery" &&
            delta.resourceId === IDS.recovery &&
            delta.action === "resolve"
        ),
        true
      );
      assertNoWrites(runtime, before);
    });

    test("denies stale current-authority rows transactionally without returning private correction data or writing", (t) => {
      const runtime = createRuntime(
        t,
        seedCorrectionRequired
      );
      const administratorInput = {
        ...commissionerInput(),
        actorAuthority:
          "platform_administrator_as_commissioner",
        actorMembershipId:
          IDS.administratorMembership,
        actorUserId: IDS.administratorUser,
      };

      runtime.database.prepare(`
        UPDATE league_memberships
        SET ended_at_ms = ?
        WHERE id = ? AND status = 'active'
      `).run(
        DEADLINE_AT_MS + 1,
        IDS.commissionerMembership
      );
      assertPreviewAuthorizationDenied(
        runtime,
        commissionerInput()
      );

      runtime.database.prepare(`
        UPDATE league_memberships
        SET joined_at_ms = NULL,
            ended_at_ms = NULL
        WHERE id = ? AND status = 'active'
      `).run(IDS.commissionerMembership);
      assertPreviewAuthorizationDenied(
        runtime,
        commissionerInput()
      );

      runtime.database.prepare(`
        UPDATE league_memberships
        SET joined_at_ms = 1
        WHERE id = ?
      `).run(IDS.commissionerMembership);
      runtime.database.prepare(`
        UPDATE users
        SET status = 'disabled'
        WHERE id = ?
      `).run(IDS.commissionerUser);
      assertPreviewAuthorizationDenied(
        runtime,
        commissionerInput()
      );

      runtime.database.prepare(`
        UPDATE users
        SET status = 'active'
        WHERE id = ?
      `).run(IDS.commissionerUser);
      runtime.database.prepare(`
        UPDATE platform_roles
        SET ended_at_ms = ?
        WHERE id = ? AND status = 'active'
      `).run(
        DEADLINE_AT_MS + 2,
        IDS.administratorRole
      );
      assertPreviewAuthorizationDenied(
        runtime,
        administratorInput
      );

      runtime.database.prepare(`
        UPDATE platform_roles
        SET ended_at_ms = NULL
        WHERE id = ?
      `).run(IDS.administratorRole);
      runtime.database.prepare(`
        UPDATE league_memberships
        SET ended_at_ms = ?
        WHERE id = ? AND status = 'active'
      `).run(
        DEADLINE_AT_MS + 3,
        IDS.administratorMembership
      );
      assertPreviewAuthorizationDenied(
        runtime,
        administratorInput
      );
    });

    test("fully recomputes an exact Candidate tie but blocks terminal correction while preserving its auction delta", (t) => {
      const runtime = createRuntime(
        t,
        seedExactTieCorrectionRequired
      );
      const exactT140 = t140Decision(runtime.database);
      const before = noWriteSnapshot(runtime);
      const preview =
        runtime.repository.previewAllocationCorrection(
          commissionerInput()
        );

      assert.deepEqual(preview.currentDecision, exactT140);
      assert.equal(
        preview.currentDecision.status,
        "correction_required"
      );
      assert.deepEqual(
        preview.recomputedDecision,
        {
          status: "restricted_scheduled",
          decisionCode: "exact_total_and_term_tie",
          rankedOffers: preview.recomputedDecision.rankedOffers,
          winner: null,
          restricted: {
            auctionId: null,
            status: "scheduled",
            participantTeamIds: [],
            minimumTotalValueCents: 600,
            minimumTermYears: 2,
            minimumAavCents: 300,
          },
          recoveryStatus: "resolved",
        }
      );
      assert.deepEqual(
        preview.recomputedDecision.rankedOffers.map(
          ({
            teamId,
            totalValueCents,
            termYears,
            aavCents,
            valid,
            rank,
            outcomeCode,
          }) => ({
            teamId,
            totalValueCents,
            termYears,
            aavCents,
            valid,
            rank,
            outcomeCode,
          })
        ),
        [
          {
            teamId: IDS.teamCorrect,
            totalValueCents: 600,
            termYears: 2,
            aavCents: 300,
            valid: true,
            rank: 1,
            outcomeCode: "restricted_tied",
          },
          {
            teamId: IDS.teamWrong,
            totalValueCents: 600,
            termYears: 2,
            aavCents: 300,
            valid: true,
            rank: 2,
            outcomeCode: "restricted_tied",
          },
        ]
      );
      assert.equal(preview.reversible, false);
      assert.deepEqual(preview.blockers, [
        {
          code:
            "FAD_CORRECTION_REQUIRES_RESTRICTED_AUCTION",
          message:
            "The locked Candidate result requires a restricted auction and cannot be completed as a terminal allocation correction.",
          resourceId: null,
        },
      ]);
      assert.deepEqual(
        preview.deltas.map(
          ({ resourceType, resourceId, action, beforeVersion }) => ({
            resourceType,
            resourceId,
            action,
            beforeVersion,
          })
        ),
        [
          {
            resourceType: "allocation",
            resourceId: IDS.allocation,
            action: "update",
            beforeVersion: 3,
          },
          {
            resourceType: "auction",
            resourceId: null,
            action: "create",
            beforeVersion: null,
          },
          {
            resourceType: "recovery",
            resourceId: IDS.recovery,
            action: "resolve",
            beforeVersion: 1,
          },
          {
            resourceType: "activity",
            resourceId: null,
            action: "append",
            beforeVersion: null,
          },
        ]
      );
      assert.equal(
        preview.previewFingerprint,
        "9a3fa93b3a2b12e503a4356cb64376985f256853ac43297e9b5dd2d3d053df9c"
      );
      assert.deepEqual(
        runtime.repository.previewAllocationCorrection(
          commissionerInput()
        ),
        preview
      );
      assertNoWrites(runtime, before);
    });

    test("revalidates current authority before returning safe same-league not-found results", (t) => {
      const runtime = createRuntime(
        t,
        seedWrongCompletedResult
      );
      let before = noWriteSnapshot(runtime);
      assert.throws(
        () =>
          runtime.repository.previewAllocationCorrection({
            ...commissionerInput(),
            actorMembershipId: IDS.memberMembership,
            actorUserId: IDS.memberUser,
          }),
        (error) =>
          error.code ===
          FREE_AGENT_DRAFT_CORRECTION_PREVIEW_REPOSITORY_CODES
            .authorizationDenied
      );
      assertNoWrites(runtime, before);

      before = noWriteSnapshot(runtime);
      assert.throws(
        () =>
          runtime.repository.previewAllocationCorrection({
            ...commissionerInput(),
            fadId: uuid(999),
          }),
        (error) =>
          error.code ===
          REPOSITORY_ERROR_CODES.recordNotFound
      );
      assertNoWrites(runtime, before);
    });

    test("fingerprints and blocks irreversible contract, ownership, trade, buyout, and roster drift", (t) => {
      const runtime = createRuntime(
        t,
        seedWrongCompletedResult
      );
      const baseline =
        runtime.repository.previewAllocationCorrection(
          commissionerInput()
        );
      seedIrreversibleDrift(runtime.database);
      runtime.database.pragma("wal_checkpoint(TRUNCATE)");
      const before = noWriteSnapshot(runtime);
      const drifted =
        runtime.repository.previewAllocationCorrection(
          commissionerInput()
        );
      const codes = new Set(
        drifted.blockers.map(({ code }) => code)
      );
      assert.equal(drifted.reversible, false);
      for (const code of [
        "FAD_CORRECTION_CONTRACT_DRIFT",
        "FAD_CORRECTION_OWNERSHIP_ROSTER_DRIFT",
        "FAD_CORRECTION_TRADE_DRIFT",
        "FAD_CORRECTION_BUYOUT_DRIFT",
      ]) {
        assert.equal(codes.has(code), true, code);
      }
      assert.notEqual(
        drifted.previewFingerprint,
        baseline.previewFingerprint
      );
      const rosterDelta = drifted.deltas.find(
        (delta) =>
          delta.resourceType === "roster_entry" &&
          delta.action === "remove"
      );
      assert.equal(rosterDelta.resourceId, IDS.orderEntry);
      assert.equal(rosterDelta.beforeVersion, 4);
      assertNoWrites(runtime, before);
    });

    test("fails closed on corrupt immutable offer-result evidence without writes", (t) => {
      const runtime = createRuntime(
        t,
        seedWrongCompletedResult
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_allocation_events
          SET rank_position = NULL
          WHERE id = ?
        `)
        .run(IDS.correctEvent);
      runtime.database.pragma("wal_checkpoint(TRUNCATE)");
      const before = noWriteSnapshot(runtime);
      assert.throws(
        () =>
          runtime.repository.previewAllocationCorrection(
            commissionerInput()
          ),
        (error) =>
          error.code ===
          REPOSITORY_ERROR_CODES.schemaIncompatible
      );
      assertNoWrites(runtime, before);
    });

    test("requires exactly one immutable draw for every linked auction without writing", (t) => {
      const valid = createRuntime(t, (database) => {
        seedCorrectionRequired(database);
        seedLinkedAuction(database);
      });
      let before = noWriteSnapshot(valid);
      const preview =
        valid.repository.previewAllocationCorrection(
          commissionerInput()
        );
      assert.equal(preview.reversible, true);
      assert.equal(
        preview.deltas.some(
          (delta) =>
            delta.resourceType === "auction" &&
            delta.resourceId === IDS.auction &&
            delta.action === "cancel"
        ),
        true
      );
      assertNoWrites(valid, before);

      const corrupt = createRuntime(t, (database) => {
        seedCorrectionRequired(database);
        seedLinkedAuction(database, {
          includeDraw: false,
        });
      });
      before = noWriteSnapshot(corrupt);
      assert.throws(
        () =>
          corrupt.repository.previewAllocationCorrection(
            commissionerInput()
          ),
        (error) =>
          error.code ===
          REPOSITORY_ERROR_CODES.schemaIncompatible
      );
      assertNoWrites(corrupt, before);
    });

    test("selects the sole unresolved recovery independently of resolved-row order and rejects ambiguous unresolved evidence", (t) => {
      const ordered = createRuntime(t, (database) => {
        seedCorrectionRequired(database);
        seedAdditionalRecovery(database, {
          id: IDS.resolvedRecovery,
          status: "resolved",
          createdAtMs: DEADLINE_AT_MS + 2_000,
          updatedAtMs: DEADLINE_AT_MS + 5_000,
        });
      });
      let before = noWriteSnapshot(ordered);
      const preview =
        ordered.repository.previewAllocationCorrection(
          commissionerInput()
        );
      assert.deepEqual(
        preview.deltas
          .filter(
            (delta) => delta.resourceType === "recovery"
          )
          .map(({ resourceId, action, beforeVersion }) => ({
            resourceId,
            action,
            beforeVersion,
          })),
        [
          {
            resourceId: IDS.recovery,
            action: "resolve",
            beforeVersion: 1,
          },
        ]
      );
      assertNoWrites(ordered, before);

      const ambiguous = createRuntime(t, (database) => {
        seedCorrectionRequired(database);
        seedAdditionalRecovery(database, {
          id: IDS.secondUnresolvedRecovery,
          status: "ready",
          createdAtMs: DEADLINE_AT_MS + 2_000,
          updatedAtMs: DEADLINE_AT_MS + 3_000,
        });
      });
      before = noWriteSnapshot(ambiguous);
      assert.throws(
        () =>
          ambiguous.repository.previewAllocationCorrection(
            commissionerInput()
          ),
        (error) =>
          error.code ===
          REPOSITORY_ERROR_CODES.schemaIncompatible
      );
      assertNoWrites(ambiguous, before);
    });

    test("rejects malformed mode and extended input before reading correction state", (t) => {
      const runtime = createRuntime(
        t,
        seedWrongCompletedResult
      );
      for (const value of [
        commissionerInput({ mode: "choose_winner" }),
        { ...commissionerInput(), winnerId: IDS.teamCorrect },
      ]) {
        const before = noWriteSnapshot(runtime);
        assert.throws(
          () =>
            runtime.repository.previewAllocationCorrection(
              value
            ),
          (error) =>
            error.code ===
            REPOSITORY_ERROR_CODES.argumentInvalid
        );
        assertNoWrites(runtime, before);
      }
    });
  }
);
