"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require(
  "../../src/domain/leagues/socketInvalidation"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
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
  SqliteRepositoryError,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_JOB_TYPE,
  FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_WRITER_METHODS,
  createSqliteFreeAgentDraftRestrictedActivationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRestrictedActivationWriter"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const DEADLINE_AT_MS = WEEK_ONE_AT_MS - 7 * DAY_MS;
const OPENED_AT_MS = DEADLINE_AT_MS - 30 * DAY_MS;
const SCHEDULED_AT_MS = DEADLINE_AT_MS + 1_000;
const ACTIVATION_AT_MS = DEADLINE_AT_MS + DAY_MS;
const RESOLVES_AT_MS = ACTIVATION_AT_MS + DAY_MS;
const ACTIVATED_AT_MS = ACTIVATION_AT_MS + 1_000;
const LEASE_EXPIRES_AT_MS = RESOLVES_AT_MS + 60 * 60 * 1000;
const LEASE_OWNER = "fad-restricted-activation-worker";
const LEASE_TOKEN = "fad-restricted-activation-lease-token";

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  weekOne: uuid(3),
  readiness: uuid(4),
  fad: uuid(5),
  allocation: uuid(6),
  player: uuid(7),
  playerSource: uuid(8),
  rolloverOne: uuid(9),
  rolloverTwo: uuid(10),
  auction: uuid(11),
  draw: uuid(12),
  activationJob: uuid(13),
  recovery: uuid(14),
  sourceStateEvent: uuid(15),
  laterBid: uuid(16),
});

function identity(index) {
  const base = index * 100;
  return Object.freeze({
    user: uuid(base + 20),
    membership: uuid(base + 21),
    team: uuid(base + 22),
    assignment: uuid(base + 23),
    fadTeam: uuid(base + 24),
    card: uuid(base + 25),
    entry: uuid(base + 26),
    openedRevision: uuid(base + 27),
    candidateRevision: uuid(base + 28),
    lockedRevision: uuid(base + 29),
    snapshot: uuid(base + 30),
    snapshotEntry: uuid(base + 31),
    participant: uuid(base + 32),
    sourceOfferEvent: uuid(base + 33),
  });
}

const MANAGERS = Object.freeze([
  identity(1),
  identity(2),
  identity(3),
]);
const REPLACEMENT_MANAGER = Object.freeze({
  user: uuid(420),
  membership: uuid(421),
  assignment: uuid(423),
});

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  try {
    database.prepare(`
      INSERT INTO ${tableName} (${fields.join(", ")})
      VALUES (${fields.map((field) => `@${field}`).join(", ")})
    `).run(values);
  } catch (error) {
    throw new Error(`${tableName}: ${error.message}`, {
      cause: error,
    });
  }
}

function captureAndDropTriggers(database) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  for (const trigger of triggers) {
    database.exec(
      `DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`
    );
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const trigger of triggers) {
    database.exec(trigger.sql);
  }
}

function withoutTriggers(database, mutate) {
  const triggers = captureAndDropTriggers(database);
  try {
    mutate();
  } finally {
    restoreTriggers(database, triggers);
  }
}

function seedBase(database) {
  insert(database, "leagues", {
    id: IDS.league,
    name: "Restricted Activation League",
    name_normalized: "restricted activation league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: IDS.season,
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
  insert(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: WEEK_ONE_AT_MS,
    regular_season_ends_at_ms:
      WEEK_ONE_AT_MS + 20 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 17 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: IDS.weekOne,
    league_id: IDS.league,
    season_id: IDS.season,
    week_key: "2026-W01",
    sequence: 1,
    starts_at_ms: WEEK_ONE_AT_MS,
    baseline_at_ms: WEEK_ONE_AT_MS + 60 * 60 * 1000,
    locks_at_ms: WEEK_ONE_AT_MS + 2 * 60 * 60 * 1000,
    ends_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "players", {
    id: IDS.player,
    first_name: "Riley",
    last_name: "Restricted",
    full_name: "Riley Restricted",
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: IDS.playerSource,
    player_id: IDS.player,
    provider: "foundation",
    source_position: "D",
    normalized_position: "D",
    nhl_team_abbreviation: "VAN",
    active: 1,
    source_version: "1",
    source_payload_json: "{}",
    effective_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
  });
  insert(database, "free_agent_draft_readiness_operations", {
    id: IDS.readiness,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_occurrence_key:
      `fad-readiness:${IDS.league}:${IDS.season}`,
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
  });
  insert(database, "free_agent_drafts", {
    id: IDS.fad,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    readiness_occurrence_key:
      `fad-readiness:${IDS.league}:${IDS.season}`,
    first_matchup_week_id: IDS.weekOne,
    current_competition_first_matchup_week_id: IDS.weekOne,
    schedule_recovery_id: null,
    participating_team_count: 3,
    status: "rapid",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Inaugural league has no Entry Draft.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: DEADLINE_AT_MS - 48 * 60 * 60 * 1000,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: DEADLINE_AT_MS,
    allocation_completed_at_ms: SCHEDULED_AT_MS,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: SCHEDULED_AT_MS,
    version: 4,
  });
  insert(database, "free_agent_draft_rollovers", {
    id: IDS.rolloverOne,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    sequence: 1,
    window_kind: "initial",
    predecessor_rollover_id: null,
    extension_reason: null,
    extension_source_id: null,
    opens_at_ms: DEADLINE_AT_MS,
    creation_cutoff_at_ms: ACTIVATION_AT_MS - 60 * 60 * 1000,
    rolls_over_at_ms: ACTIVATION_AT_MS,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  insert(database, "free_agent_draft_rollovers", {
    id: IDS.rolloverTwo,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    sequence: 2,
    window_kind: "initial",
    predecessor_rollover_id: IDS.rolloverOne,
    extension_reason: null,
    extension_source_id: null,
    opens_at_ms: ACTIVATION_AT_MS,
    creation_cutoff_at_ms: RESOLVES_AT_MS - 60 * 60 * 1000,
    rolls_over_at_ms: RESOLVES_AT_MS,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
}

function seedManager(database, manager, index) {
  insert(database, "users", {
    id: manager.user,
    email_normalized: `manager-${index}@example.test`,
    email_display: `manager-${index}@example.test`,
    display_name: `Manager ${index}`,
    display_name_normalized: `manager ${index}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: manager.membership,
    league_id: IDS.league,
    user_id: manager.user,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "teams", {
    id: manager.team,
    league_id: IDS.league,
    name: `Restricted Team ${index}`,
    name_normalized: `restricted team ${index}`,
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
    id: manager.assignment,
    league_id: IDS.league,
    team_id: manager.team,
    user_id: manager.user,
    membership_id: manager.membership,
    assigned_by_user_id: manager.user,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: 1,
    accepted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "free_agent_draft_teams", {
    id: manager.fadTeam,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: manager.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  });
  insert(database, "candidate_cards", {
    id: manager.card,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: manager.team,
    status: "locked_incomplete",
    completeness_code: "incomplete",
    filled_mandatory_count: 1,
    missing_mandatory_count: 17,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    carried_roster_structural_conflict_count: 0,
    maximum_possible_cap_cents: 300,
    locked_at_ms: DEADLINE_AT_MS,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 3,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  insert(database, "candidate_card_entries", {
    id: manager.entry,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: manager.card,
    team_id: manager.team,
    entry_kind: "candidate",
    player_id: IDS.player,
    effective_position_group: "D",
    requested_slot_group: "D",
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
    proposed_term_years: 2,
    proposed_aav_cents: 300,
    eligibility_status: "valid",
    validation_code: null,
    last_acknowledgement_revision_id: null,
    created_by_user_id: manager.user,
    created_by_membership_id: manager.membership,
    created_by_authority: "manager",
    last_edited_by_user_id: manager.user,
    last_edited_by_membership_id: manager.membership,
    last_edited_by_authority: "manager",
    created_at_ms: OPENED_AT_MS + index,
    updated_at_ms: OPENED_AT_MS + index,
    version: 1,
  });
  insert(database, "candidate_card_revisions", {
    id: manager.openedRevision,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: manager.card,
    team_id: manager.team,
    resulting_card_version: 1,
    action: "card_opened",
    affected_entry_id: null,
    player_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    before_evidence_json: "{}",
    after_evidence_json: "{}",
    potential_illegality_acknowledged: 0,
    warning_codes_json: "[]",
    occurred_at_ms: OPENED_AT_MS,
    created_at_ms: OPENED_AT_MS,
    version: 1,
  });
  insert(database, "candidate_card_revisions", {
    id: manager.candidateRevision,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: manager.card,
    team_id: manager.team,
    resulting_card_version: 2,
    action: "candidate_added",
    affected_entry_id: manager.entry,
    player_id: IDS.player,
    actor_user_id: manager.user,
    actor_membership_id: manager.membership,
    actor_authority: "manager",
    before_evidence_json: "{}",
    after_evidence_json: "{}",
    potential_illegality_acknowledged: 0,
    warning_codes_json: "[]",
    occurred_at_ms: OPENED_AT_MS + index,
    created_at_ms: OPENED_AT_MS + index,
    version: 1,
  });
  insert(database, "candidate_card_revisions", {
    id: manager.lockedRevision,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: manager.card,
    team_id: manager.team,
    resulting_card_version: 3,
    action: "deadline_locked",
    affected_entry_id: null,
    player_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    before_evidence_json: "{}",
    after_evidence_json: "{}",
    potential_illegality_acknowledged: 0,
    warning_codes_json: "[]",
    occurred_at_ms: DEADLINE_AT_MS,
    created_at_ms: DEADLINE_AT_MS,
    version: 1,
  });
  insert(database, "candidate_card_snapshots", {
    id: manager.snapshot,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: manager.card,
    team_id: manager.team,
    locked_card_version: 3,
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
    proposed_candidate_aav_cents: 300,
    maximum_possible_cap_cents: 300,
    maximum_cap_space_cents: 9_700,
    effective_deadline_at_ms: DEADLINE_AT_MS,
    processed_at_ms: DEADLINE_AT_MS,
    created_at_ms: DEADLINE_AT_MS,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  insert(database, "candidate_card_snapshot_entries", {
    id: manager.snapshotEntry,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    snapshot_id: manager.snapshot,
    card_id: manager.card,
    team_id: manager.team,
    row_kind: "slot",
    occupant_kind: "candidate",
    slot_group: "D",
    slot_number: 1,
    source_entry_id: manager.entry,
    source_entry_version: 1,
    player_id: IDS.player,
    effective_position_group: "D",
    conflict_code: null,
    carryover_ownership_id: null,
    carryover_contract_id: null,
    source_roster_category: null,
    carryover_original_total_value_cents: null,
    carryover_original_term_years: null,
    carryover_aav_cents: null,
    remaining_years: null,
    proposed_total_value_cents: 600,
    proposed_term_years: 2,
    proposed_aav_cents: 300,
    eligibility_status: "valid",
    validation_code: null,
    last_edited_by_user_id: manager.user,
    last_edited_by_membership_id: manager.membership,
    last_edited_by_authority: "manager",
    last_edited_at_ms: OPENED_AT_MS + index,
    created_at_ms: DEADLINE_AT_MS,
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
}

function replaceScheduledManager(database) {
  const original = MANAGERS[0];
  withoutTriggers(database, () => {
    database.prepare(`
      UPDATE team_manager_assignments
      SET ended_at_ms = ?, version = version + 1
      WHERE id = ?
    `).run(ACTIVATED_AT_MS - 2, original.assignment);
    database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = ?, updated_at_ms = ?, version = version + 1
      WHERE id = ?
    `).run(
      ACTIVATED_AT_MS - 2,
      ACTIVATED_AT_MS - 2,
      original.membership
    );
    insert(database, "users", {
      id: REPLACEMENT_MANAGER.user,
      email_normalized: "replacement-manager@example.test",
      email_display: "replacement-manager@example.test",
      display_name: "Replacement Manager",
      display_name_normalized: "replacement manager",
      status: "active",
      created_at_ms: ACTIVATED_AT_MS - 2,
      updated_at_ms: ACTIVATED_AT_MS - 2,
      version: 1,
    });
    insert(database, "league_memberships", {
      id: REPLACEMENT_MANAGER.membership,
      league_id: IDS.league,
      user_id: REPLACEMENT_MANAGER.user,
      permission_category: "manager",
      status: "active",
      joined_at_ms: ACTIVATED_AT_MS - 2,
      ended_at_ms: null,
      created_at_ms: ACTIVATED_AT_MS - 2,
      updated_at_ms: ACTIVATED_AT_MS - 2,
      version: 1,
    });
    insert(database, "team_manager_assignments", {
      id: REPLACEMENT_MANAGER.assignment,
      league_id: IDS.league,
      team_id: original.team,
      user_id: REPLACEMENT_MANAGER.user,
      membership_id: REPLACEMENT_MANAGER.membership,
      assigned_by_user_id: REPLACEMENT_MANAGER.user,
      replaces_assignment_id: original.assignment,
      status: "accepted",
      assigned_at_ms: ACTIVATED_AT_MS - 2,
      accepted_at_ms: ACTIVATED_AT_MS - 1,
      ended_at_ms: null,
      version: 1,
    });
  });
}

function seedScheduledActivation(
  database,
  { recovery, missingParticipant }
) {
  insert(database, "auctions", {
    id: IDS.auction,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    status: "open",
    opened_at_ms: ACTIVATION_AT_MS,
    resolves_at_ms: RESOLVES_AT_MS,
    opened_by_user_id: null,
    created_at_ms: SCHEDULED_AT_MS,
    updated_at_ms: SCHEDULED_AT_MS,
    version: 1,
  });
  insert(database, "free_agent_draft_player_allocations", {
    id: IDS.allocation,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    player_id: IDS.player,
    status: "restricted_scheduled",
    decision_code: "exact_total_and_term_tie",
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: IDS.auction,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: 600,
    restricted_minimum_term_years: 2,
    restricted_minimum_aav_cents: 300,
    accounted_at_ms: null,
    last_error_code: null,
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: SCHEDULED_AT_MS,
    version: 2,
  });
  insert(database, "auction_contexts", {
    id: IDS.auction,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: IDS.auction,
    source_kind: "fad_restricted",
    fad_id: IDS.fad,
    fad_rollover_id: IDS.rolloverTwo,
    fad_allocation_id: IDS.allocation,
    fad_origin: "candidate_tie_restricted",
    created_at_ms: SCHEDULED_AT_MS,
  });
  for (const [index, manager] of MANAGERS.entries()) {
    if (missingParticipant && index === MANAGERS.length - 1) {
      continue;
    }
    insert(database, "free_agent_draft_auction_participants", {
      id: manager.participant,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: IDS.allocation,
      auction_id: IDS.auction,
      team_id: manager.team,
      status: "active",
      source_snapshot_entry_id: manager.snapshotEntry,
      originating_candidate_revision_id:
        manager.candidateRevision,
      minimum_total_value_cents: 600,
      minimum_term_years: 2,
      minimum_aav_cents: 300,
      active_improvement_bid_id: null,
      manager_edit_limit: 1,
      cooldown_duration_ms: 75 * 60 * 1000,
      first_improvement_at_ms: null,
      current_cooldown_anchor_at_ms: null,
      improvement_committed_at_ms: null,
      originating_actor_user_id: manager.user,
      originating_actor_membership_id: manager.membership,
      originating_actor_authority: "manager",
      removed_by_user_id: null,
      removed_by_membership_id: null,
      removed_authority: null,
      removal_reason: null,
      removed_at_ms: null,
      created_at_ms: SCHEDULED_AT_MS,
      updated_at_ms: SCHEDULED_AT_MS,
      version: 1,
    });
  }
  const nonceBytes = Buffer.alloc(32, 0x5a);
  const commitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.auction,
      nonceBytes,
    });
  insert(database, "free_agent_draft_draws", {
    id: IDS.draw,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    auction_id: IDS.auction,
    algorithm_version: 1,
    nonce_bytes: nonceBytes,
    commitment_hex: commitment.commitmentHex,
    ordered_tied_bid_ids_json: null,
    ordered_tied_team_ids_json: null,
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: null,
    created_at_ms: ACTIVATION_AT_MS,
    updated_at_ms: ACTIVATION_AT_MS,
    version: 1,
  });
  const occurrenceKey =
    buildFreeAgentDraftRestrictedActivationOccurrenceKey({
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      activationAtMs: ACTIVATION_AT_MS,
    });
  insert(database, "job_runs", {
    id: IDS.activationJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type:
      FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_JOB_TYPE,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: ACTIVATION_AT_MS,
    status: "running",
    attempt_count: recovery ? 2 : 1,
    lease_owner: LEASE_OWNER,
    lease_expires_at_ms: LEASE_EXPIRES_AT_MS,
    started_at_ms: ACTIVATION_AT_MS,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: SCHEDULED_AT_MS,
    updated_at_ms: ACTIVATION_AT_MS,
    version: recovery ? 4 : 2,
    lease_token: LEASE_TOKEN,
    next_attempt_at_ms: null,
  });
  for (let index = 0; index < MANAGERS.length; index += 1) {
    const manager = MANAGERS[index];
    insert(database, "free_agent_draft_allocation_events", {
      id: manager.sourceOfferEvent,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: IDS.allocation,
      allocation_version: 2,
      player_id: IDS.player,
      event_kind: "offer_considered",
      snapshot_entry_id: manager.snapshotEntry,
      team_id: manager.team,
      offer_valid: 1,
      rank_position: 1,
      offer_outcome_code: "restricted_tied",
      decision_code: null,
      resulting_allocation_status: "restricted_scheduled",
      contract_id: null,
      ownership_id: null,
      auction_id: null,
      activity_id: null,
      correction_id: null,
      actor_user_id: null,
      actor_membership_id: null,
      actor_authority: "system",
      evidence_json: serializeCanonicalJsonV1({
        schemaVersion: 1,
        offer: {
          snapshotEntryId: manager.snapshotEntry,
          teamId: manager.team,
          totalValueCents: 600,
          termYears: 2,
          aavCents: 300,
        },
        offerValid: true,
        rankPosition: 1,
        outcomeCode: "restricted_tied",
      }),
      occurred_at_ms: SCHEDULED_AT_MS,
      created_at_ms: SCHEDULED_AT_MS,
      version: 1,
    });
  }
  insert(database, "free_agent_draft_allocation_events", {
    id: IDS.sourceStateEvent,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    allocation_version: 2,
    player_id: IDS.player,
    event_kind: "restricted_state_changed",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: "exact_total_and_term_tie",
    resulting_allocation_status: "restricted_scheduled",
    contract_id: null,
    ownership_id: null,
    auction_id: IDS.auction,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: serializeCanonicalJsonV1({
      schemaVersion: 1,
      operation: "candidate_tie_scheduled",
      allocationId: IDS.allocation,
      auctionId: IDS.auction,
    }),
    occurred_at_ms: SCHEDULED_AT_MS,
    created_at_ms: SCHEDULED_AT_MS,
    version: 1,
  });
  if (recovery) {
    insert(database, "free_agent_draft_recoveries", {
      id: IDS.recovery,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      player_id: IDS.player,
      allocation_id: IDS.allocation,
      rollover_id: IDS.rolloverTwo,
      auction_id: IDS.auction,
      job_run_id: IDS.activationJob,
      kind: "restricted_activation",
      status: "running",
      earliest_activation_at_ms: ACTIVATION_AT_MS,
      target_resolution_at_ms: RESOLVES_AT_MS,
      last_error_code: "FAD_RESTRICTED_ACTIVATION_FAILED",
      commissioner_reason: "Retry the exact delayed activation.",
      created_by_operation_id: IDS.activationJob,
      resolved_by_user_id: null,
      resolved_by_membership_id: null,
      resolved_authority: null,
      created_at_ms: SCHEDULED_AT_MS,
      updated_at_ms: ACTIVATION_AT_MS,
      resolved_at_ms: null,
      version: 2,
      nomination_queue_id: null,
    });
  }
}

function createRuntime(
  t,
  {
    recovery = false,
    missingParticipant = false,
    beforeCommit,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-restricted-activation-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }),
    applicationBuildId:
      "fad-restricted-activation-writer-foundation",
    now: () => 1,
  });
  const triggers = captureAndDropTriggers(connection.database);
  seedBase(connection.database);
  MANAGERS.forEach((manager, index) => {
    seedManager(connection.database, manager, index + 1);
  });
  seedScheduledActivation(connection.database, {
    recovery,
    missingParticipant,
  });
  restoreTriggers(connection.database, triggers);
  assert.deepEqual(
    connection.database.prepare("PRAGMA foreign_key_check").all(),
    []
  );

  let generated = 9_000;
  const writer =
    createSqliteFreeAgentDraftRestrictedActivationWriter({
      database: connection.database,
      createId() {
        generated += 1;
        return uuid(generated);
      },
      beforeCommit,
    });
  const occurrenceKey =
    buildFreeAgentDraftRestrictedActivationOccurrenceKey({
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      activationAtMs: ACTIVATION_AT_MS,
    });
  const command = Object.freeze({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    auctionId: IDS.auction,
    rolloverId: IDS.rolloverTwo,
    activationAtMs: ACTIVATION_AT_MS,
    occurrenceKey,
    expectedAllocationVersion: 2,
    activatedAtMs: ACTIVATED_AT_MS,
    jobExecution: {
      runId: IDS.activationJob,
      expectedVersion: recovery ? 4 : 2,
      leaseOwner: LEASE_OWNER,
      leaseToken: LEASE_TOKEN,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    },
  });
  return {
    database: connection.database,
    writer,
    command,
    generatedCount() {
      return generated;
    },
  };
}

function stateCounts(database) {
  return database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM free_agent_draft_allocation_events)
        AS allocationEvents,
      (SELECT COUNT(*) FROM outbox_events) AS outboxEvents,
      (SELECT COUNT(*) FROM outbox_event_audiences)
        AS outboxAudiences,
      (SELECT COUNT(*) FROM league_activity) AS activities,
      (SELECT COUNT(*) FROM notifications) AS notifications
  `).get();
}

function transactionState(database) {
  return {
    counts: stateCounts(database),
    allocation: database.prepare(`
      SELECT status, updated_at_ms, version
      FROM free_agent_draft_player_allocations
      WHERE id = ?
    `).get(IDS.allocation),
    job: database.prepare(`
      SELECT status, lease_owner, lease_token,
             lease_expires_at_ms, completed_at_ms,
             result_json, last_error_code, next_attempt_at_ms,
             updated_at_ms, version
      FROM job_runs
      WHERE id = ?
    `).get(IDS.activationJob),
    recovery: database.prepare(`
      SELECT status, last_error_code, resolved_authority,
             resolved_at_ms, updated_at_ms, version
      FROM free_agent_draft_recoveries
      WHERE id = ?
    `).get(IDS.recovery) || null,
  };
}

function assertReason(callback, reasonCode) {
  assert.throws(
    callback,
    (error) =>
      error instanceof SqliteRepositoryError &&
      error.details?.reasonCode === reasonCode
  );
}

describe(
  "SQLite Free Agent Draft restricted activation writer",
  () => {
    test("notifies only the current replacement manager at actual activation with exact replay-safe evidence", (t) => {
      const runtime = createRuntime(t);
      replaceScheduledManager(runtime.database);
      assert.equal(
        runtime.database.prepare(
          "SELECT COUNT(*) AS count FROM notifications"
        ).get().count,
        0
      );
      assert.equal(
        runtime.database.prepare(`
          SELECT COUNT(*) AS count
          FROM outbox_events
          WHERE event_type = 'notification.created'
        `).get().count,
        0
      );
      assert.deepEqual(
        FREE_AGENT_DRAFT_RESTRICTED_ACTIVATION_WRITER_METHODS,
        ["findActivation", "executeClaimed"]
      );
      assert.deepEqual(
        runtime.writer.findActivation({
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          activationAtMs: ACTIVATION_AT_MS,
        }),
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          playerId: IDS.player,
          status: "restricted_scheduled",
          allocationVersion: 2,
          auctionId: IDS.auction,
          rolloverId: IDS.rolloverTwo,
          activationAtMs: ACTIVATION_AT_MS,
          resolvesAtMs: RESOLVES_AT_MS,
          activationJobRunId: IDS.activationJob,
          activationOccurrenceKey: runtime.command.occurrenceKey,
          jobStatus: "running",
          jobRunVersion: 2,
        }
      );
      const before = stateCounts(runtime.database);
      const result = runtime.writer.executeClaimed(runtime.command);

      assert.equal(result.outcome, "succeeded");
      assert.equal(result.replayed, false);
      assert.equal(result.leagueId, IDS.league);
      assert.equal(result.seasonId, IDS.season);
      assert.equal(result.fadId, IDS.fad);
      assert.equal(result.allocationId, IDS.allocation);
      assert.equal(result.playerId, IDS.player);
      assert.equal(result.auctionId, IDS.auction);
      assert.equal(result.rolloverId, IDS.rolloverTwo);
      assert.equal(result.activationAtMs, ACTIVATION_AT_MS);
      assert.equal(result.activatedAtMs, ACTIVATED_AT_MS);
      assert.equal(result.allocationVersion, 3);
      assert.equal(result.jobRunId, IDS.activationJob);
      assert.equal(result.jobRunVersion, 3);
      assert.equal(result.sourceRecoveryId, null);
      assert.equal(result.evidence.offerEventIds.length, 3);
      assert.equal(result.evidence.notificationIds.length, 3);
      assert.equal(result.evidence.outboxEventIds.length, 5);
      assert.match(result.evidence.stateEventId, /^[0-9a-f-]{36}$/);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.evidence), true);

      assert.deepEqual(
        runtime.database.prepare(`
          SELECT status, decision_code, restricted_auction_id,
                 fallback_open_auction_id,
                 restricted_minimum_total_cents,
                 restricted_minimum_term_years,
                 restricted_minimum_aav_cents,
                 winning_snapshot_entry_id, winning_team_id,
                 contract_id, ownership_id, accounted_at_ms,
                 last_error_code, updated_at_ms, version
          FROM free_agent_draft_player_allocations
          WHERE id = ?
        `).get(IDS.allocation),
        {
          status: "restricted_active",
          decision_code: "exact_total_and_term_tie",
          restricted_auction_id: IDS.auction,
          fallback_open_auction_id: null,
          restricted_minimum_total_cents: 600,
          restricted_minimum_term_years: 2,
          restricted_minimum_aav_cents: 300,
          winning_snapshot_entry_id: null,
          winning_team_id: null,
          contract_id: null,
          ownership_id: null,
          accounted_at_ms: null,
          last_error_code: null,
          updated_at_ms: ACTIVATED_AT_MS,
          version: 3,
        }
      );
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT event_kind, COUNT(*) AS count
          FROM free_agent_draft_allocation_events
          WHERE allocation_id = ? AND allocation_version = 3
          GROUP BY event_kind
          ORDER BY event_kind
        `).all(IDS.allocation),
        [
          { event_kind: "offer_considered", count: 3 },
          { event_kind: "restricted_state_changed", count: 1 },
        ]
      );
      const outboxRows = runtime.database.prepare(`
        SELECT event_type, aggregate_type, aggregate_id
        FROM outbox_events
        ORDER BY event_type, aggregate_id
      `).all();
      assert.deepEqual(
        outboxRows.map((event) => event.event_type),
        [
          "auction.changed",
          "free_agent_draft.changed",
          "notification.created",
          "notification.created",
          "notification.created",
        ]
      );
      assert.deepEqual(
        outboxRows
          .filter(
            (event) => event.event_type === "notification.created"
          )
          .map((event) => event.aggregate_id)
          .sort(),
        [...result.evidence.notificationIds].sort()
      );
      assert.deepEqual(stateCounts(runtime.database), {
        allocationEvents: before.allocationEvents + 4,
        outboxEvents: before.outboxEvents + 5,
        outboxAudiences: before.outboxAudiences + 5,
        activities: before.activities,
        notifications: before.notifications + 3,
      });
      const expectedRecipients = MANAGERS.map((manager, index) => ({
        teamId: manager.team,
        cardId: manager.card,
        userId:
          index === 0
            ? REPLACEMENT_MANAGER.user
            : manager.user,
      }));
      const notificationRows = runtime.database.prepare(`
        SELECT *
        FROM notifications
        WHERE league_id = ?
          AND event_type = 'fad_restricted_eligible'
        ORDER BY id
      `).all(IDS.league);
      assert.equal(notificationRows.length, expectedRecipients.length);
      assert.equal(
        notificationRows.some(
          (notification) =>
            notification.user_id === MANAGERS[0].user
        ),
        false
      );
      for (let index = 0; index < expectedRecipients.length; index += 1) {
        const recipient = expectedRecipients[index];
        const notificationId = result.evidence.notificationIds[index];
        const notification = notificationRows.find(
          (row) => row.id === notificationId
        );
        const contract = createFreeAgentDraftNotificationContract({
          type: "fad_restricted_eligible",
          recipientUserId: recipient.userId,
          messageData: {
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            auctionId: IDS.auction,
            playerId: IDS.player,
            teamId: recipient.teamId,
            destination: {
              kind: "auction",
              leagueId: IDS.league,
              auctionId: IDS.auction,
            },
          },
        });
        assert.ok(notification);
        assert.equal(notification.user_id, recipient.userId);
        assert.equal(notification.league_id, IDS.league);
        assert.equal(notification.event_type, contract.type);
        assert.equal(
          notification.message_data_json,
          serializeCanonicalJsonV1(contract.messageData)
        );
        assert.equal(
          notification.related_feature,
          "free_agent_draft_auction"
        );
        assert.equal(notification.related_record_id, IDS.auction);
        assert.equal(notification.delivery_status, "pending");
        assert.equal(notification.created_at_ms, ACTIVATED_AT_MS);
        assert.equal(notification.read_at_ms, null);
        assert.equal(notification.delivered_at_ms, null);
        assert.equal(notification.version, 1);
        assert.equal(
          notification.deduplication_key,
          contract.deduplicationKey
        );
        const publication = runtime.database.prepare(`
          SELECT event.*,
                 audience.audience_kind,
                 audience.team_id AS audience_team_id,
                 audience.user_id AS audience_user_id,
                 audience.created_at_ms AS audience_created_at_ms
          FROM outbox_events AS event
          JOIN outbox_event_audiences AS audience
            ON audience.league_id = event.league_id
           AND audience.outbox_event_id = event.id
          WHERE event.league_id = @leagueId
            AND event.id = @outboxEventId
        `).get({
          leagueId: IDS.league,
          outboxEventId: result.evidence.outboxEventIds[index + 2],
        });
        assert.ok(publication);
        assert.equal(publication.event_type, "notification.created");
        assert.equal(publication.aggregate_type, "notification");
        assert.equal(publication.aggregate_id, notificationId);
        assert.equal(publication.audience_kind, "user");
        assert.equal(publication.audience_team_id, null);
        assert.equal(publication.audience_user_id, recipient.userId);
        assert.equal(
          publication.audience_created_at_ms,
          ACTIVATED_AT_MS
        );
        assert.deepEqual(
          JSON.parse(publication.payload_json),
          createSocketEventEnvelope({
            eventId: publication.id,
            type: "notification.created",
            leagueId: IDS.league,
            resourceId: notificationId,
            version: 1,
            reasonCode: "allocation_changed",
            occurredAt: ACTIVATED_AT_MS,
            related: createEmptySocketRelated({
              fadId: IDS.fad,
              teamId: recipient.teamId,
              cardId: recipient.cardId,
              allocationId: IDS.allocation,
              auctionId: IDS.auction,
            }),
          })
        );
      }
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT user_id, event_type, deduplication_key,
                 COUNT(*) AS count
          FROM notifications
          GROUP BY user_id, event_type, deduplication_key
          HAVING COUNT(*) > 1
        `).all(),
        []
      );
      const job = runtime.database.prepare(`
        SELECT status, lease_owner, lease_token,
               lease_expires_at_ms, completed_at_ms,
               result_json, last_error_code, next_attempt_at_ms,
               updated_at_ms, version
        FROM job_runs WHERE id = ?
      `).get(IDS.activationJob);
      assert.equal(job.status, "succeeded");
      assert.equal(job.lease_owner, null);
      assert.equal(job.lease_token, null);
      assert.equal(job.lease_expires_at_ms, null);
      assert.equal(job.completed_at_ms, ACTIVATED_AT_MS);
      assert.equal(job.last_error_code, null);
      assert.equal(job.next_attempt_at_ms, null);
      assert.equal(job.updated_at_ms, ACTIVATED_AT_MS);
      assert.equal(job.version, 3);
      assert.equal(
        serializeCanonicalJsonV1(JSON.parse(job.result_json)),
        job.result_json
      );

      const triggers = captureAndDropTriggers(runtime.database);
      insert(runtime.database, "auction_bids", {
        id: IDS.laterBid,
        league_id: IDS.league,
        season_id: IDS.season,
        auction_id: IDS.auction,
        team_id: MANAGERS[0].team,
        submitted_by_user_id: MANAGERS[0].user,
        total_value_cents: 700,
        term_years: 2,
        lowest_offered_aav_cents: 350,
        first_submitted_at_ms: ACTIVATED_AT_MS + 1,
        last_edited_at_ms: ACTIVATED_AT_MS + 1,
        edit_count: 0,
        status: "active",
        idempotency_request_id: null,
        version: 1,
      });
      runtime.database.prepare(`
        UPDATE free_agent_draft_auction_participants
        SET active_improvement_bid_id = ?,
            first_improvement_at_ms = ?,
            current_cooldown_anchor_at_ms = ?,
            improvement_committed_at_ms = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE id = ?
      `).run(
        IDS.laterBid,
        ACTIVATED_AT_MS + 1,
        ACTIVATED_AT_MS + 1,
        ACTIVATED_AT_MS + 1,
        ACTIVATED_AT_MS + 1,
        MANAGERS[0].participant
      );
      runtime.database.prepare(`
        UPDATE notifications
        SET delivery_status = 'delivered',
            delivered_at_ms = ?,
            version = version + 1
        WHERE league_id = ?
          AND event_type = 'fad_restricted_eligible'
      `).run(ACTIVATED_AT_MS + 2, IDS.league);
      runtime.database.prepare(`
        UPDATE team_manager_assignments
        SET ended_at_ms = ?, version = version + 1
        WHERE id = ?
      `).run(
        ACTIVATED_AT_MS + 2,
        REPLACEMENT_MANAGER.assignment
      );
      runtime.database.prepare(`
        UPDATE league_memberships
        SET ended_at_ms = ?, updated_at_ms = ?,
            version = version + 1
        WHERE id = ?
      `).run(
        ACTIVATED_AT_MS + 2,
        ACTIVATED_AT_MS + 2,
        REPLACEMENT_MANAGER.membership
      );
      restoreTriggers(runtime.database, triggers);

      const countsBeforeReplay = stateCounts(runtime.database);
      const generatedBeforeReplay = runtime.generatedCount();
      const replayed = runtime.writer.executeClaimed({
        ...runtime.command,
        activatedAtMs: LEASE_EXPIRES_AT_MS + DAY_MS,
      });
      assert.deepEqual(replayed, {
        ...result,
        replayed: true,
      });
      assert.deepEqual(stateCounts(runtime.database), countsBeforeReplay);
      assert.equal(runtime.generatedCount(), generatedBeforeReplay);
      assert.deepEqual(
        runtime.writer.findActivation({
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          activationAtMs: ACTIVATION_AT_MS,
        }),
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          playerId: IDS.player,
          status: "restricted_active",
          allocationVersion: 3,
          auctionId: IDS.auction,
          rolloverId: IDS.rolloverTwo,
          activationAtMs: ACTIVATION_AT_MS,
          resolvesAtMs: RESOLVES_AT_MS,
          activationJobRunId: IDS.activationJob,
          activationOccurrenceKey: runtime.command.occurrenceKey,
          jobStatus: "succeeded",
          jobRunVersion: 3,
        }
      );
    });

    test("resolves one exact running restricted-activation recovery in the same commit", (t) => {
      const runtime = createRuntime(t, { recovery: true });
      const result = runtime.writer.executeClaimed(runtime.command);
      assert.equal(result.sourceRecoveryId, IDS.recovery);
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT status, last_error_code, resolved_by_user_id,
                 resolved_by_membership_id, resolved_authority,
                 updated_at_ms, resolved_at_ms, version
          FROM free_agent_draft_recoveries WHERE id = ?
        `).get(IDS.recovery),
        {
          status: "resolved",
          last_error_code: null,
          resolved_by_user_id: null,
          resolved_by_membership_id: null,
          resolved_authority: "system",
          updated_at_ms: ACTIVATED_AT_MS,
          resolved_at_ms: ACTIVATED_AT_MS,
          version: 3,
        }
      );
      assert.equal(
        runtime.writer.executeClaimed({
          ...runtime.command,
          activatedAtMs: ACTIVATED_AT_MS + DAY_MS,
        }).replayed,
        true
      );
    });

    test("rejects a tied-offer allowlist that omits one rightful participant without writes", (t) => {
      const runtime = createRuntime(t, {
        missingParticipant: true,
      });
      const before = transactionState(runtime.database);
      const generatedBefore = runtime.generatedCount();

      assertReason(
        () => runtime.writer.executeClaimed(runtime.command),
        "PARTICIPANT_OFFER_COVERAGE_INVALID"
      );

      assert.deepEqual(transactionState(runtime.database), before);
      assert.equal(runtime.generatedCount(), generatedBefore);
    });

    test("rejects an accepted assignment without acceptance evidence before any activation write", (t) => {
      const runtime = createRuntime(t);
      withoutTriggers(runtime.database, () => {
        runtime.database.prepare(`
          UPDATE team_manager_assignments
          SET accepted_at_ms = NULL
          WHERE id = ?
        `).run(MANAGERS[0].assignment);
      });
      const before = transactionState(runtime.database);
      const generatedBefore = runtime.generatedCount();

      assertReason(
        () => runtime.writer.executeClaimed(runtime.command),
        "ACTIVATION_RECIPIENTS_CHANGED"
      );

      assert.deepEqual(transactionState(runtime.database), before);
      assert.equal(runtime.generatedCount(), generatedBefore);
    });

    test("requires strictly more than sixty minutes of fair access and permits the first valid millisecond", (t) => {
      for (const activatedAtMs of [
        RESOLVES_AT_MS - 60 * 60 * 1000,
        RESOLVES_AT_MS - 60 * 60 * 1000 + 1,
      ]) {
        const runtime = createRuntime(t);
        const before = transactionState(runtime.database);
        const generatedBefore = runtime.generatedCount();

        assertReason(
          () =>
            runtime.writer.executeClaimed({
              ...runtime.command,
              activatedAtMs,
            }),
          "ACTIVATION_FAIR_ACCESS_INSUFFICIENT"
        );
        assert.deepEqual(transactionState(runtime.database), before);
        assert.equal(runtime.generatedCount(), generatedBefore);
      }

      const runtime = createRuntime(t);
      const activatedAtMs =
        RESOLVES_AT_MS - 60 * 60 * 1000 - 1;
      const result = runtime.writer.executeClaimed({
        ...runtime.command,
        activatedAtMs,
      });
      assert.equal(result.outcome, "succeeded");
      assert.equal(result.replayed, false);
      assert.equal(result.activatedAtMs, activatedAtMs);
      assert.equal(result.allocationVersion, 3);
      assert.equal(result.jobRunVersion, 3);
    });

    test("rolls back every activation write when the final transaction hook fails", (t) => {
      const runtime = createRuntime(t, {
        recovery: true,
        beforeCommit() {
          throw new Error("injected restricted activation failure");
        },
      });
      const before = transactionState(runtime.database);
      const generatedBefore = runtime.generatedCount();

      assert.throws(
        () => runtime.writer.executeClaimed(runtime.command),
        (error) =>
          error instanceof SqliteRepositoryError &&
          error.code === "REPOSITORY_OPERATION_FAILED" &&
          error.cause?.message ===
            "injected restricted activation failure"
      );

      assert.deepEqual(transactionState(runtime.database), before);
      assert.equal(
        runtime.database.prepare("PRAGMA foreign_key_check").all()
          .length,
        0
      );
      assert.equal(runtime.generatedCount(), generatedBefore + 12);
    });

    test("fails closed without writes for stale, early, expired, and late execution fences", (t) => {
      const cases = [
        {
          name: "stale allocation version",
          reasonCode: "ACTIVATION_FENCE_CHANGED",
          command(command) {
            return {
              ...command,
              expectedAllocationVersion: 3,
            };
          },
        },
        {
          name: "stale lease token",
          reasonCode: "ACTIVATION_FENCE_CHANGED",
          command(command) {
            return {
              ...command,
              jobExecution: {
                ...command.jobExecution,
                leaseToken: "stale-restricted-activation-token",
              },
            };
          },
        },
        {
          name: "early clock",
          reasonCode: "ACTIVATION_NOT_DUE",
          command(command) {
            return {
              ...command,
              activatedAtMs: ACTIVATION_AT_MS - 1,
            };
          },
        },
        {
          name: "expired lease",
          reasonCode: "ACTIVATION_FENCE_CHANGED",
          setup(database) {
            withoutTriggers(database, () => {
              database.prepare(`
                UPDATE job_runs
                SET lease_expires_at_ms = ?
                WHERE id = ?
              `).run(ACTIVATED_AT_MS, IDS.activationJob);
            });
          },
          command(command) {
            return {
              ...command,
              jobExecution: {
                ...command.jobExecution,
                leaseExpiresAtMs: ACTIVATED_AT_MS,
              },
            };
          },
        },
        {
          name: "closed auction clock",
          reasonCode: "ACTIVATION_WINDOW_CLOSED",
          command(command) {
            return {
              ...command,
              activatedAtMs: RESOLVES_AT_MS,
            };
          },
        },
      ];

      for (const scenario of cases) {
        const runtime = createRuntime(t);
        scenario.setup?.(runtime.database);
        const before = transactionState(runtime.database);
        const generatedBefore = runtime.generatedCount();
        assertReason(
          () =>
            runtime.writer.executeClaimed(
              scenario.command(runtime.command)
            ),
          scenario.reasonCode
        );
        assert.deepEqual(
          transactionState(runtime.database),
          before,
          scenario.name
        );
        assert.equal(
          runtime.generatedCount(),
          generatedBefore,
          scenario.name
        );
      }
    });

    test("rejects malformed draw evidence and premature bids without writes", (t) => {
      const malformedDraw = createRuntime(t);
      withoutTriggers(malformedDraw.database, () => {
        malformedDraw.database.prepare(`
          UPDATE free_agent_draft_draws
          SET commitment_hex = ?
          WHERE id = ?
        `).run("0".repeat(64), IDS.draw);
      });
      const malformedBefore = transactionState(
        malformedDraw.database
      );
      assertReason(
        () =>
          malformedDraw.writer.executeClaimed(
            malformedDraw.command
          ),
        "DRAW_COMMITMENT_INVALID"
      );
      assert.deepEqual(
        transactionState(malformedDraw.database),
        malformedBefore
      );

      const prematureBid = createRuntime(t);
      withoutTriggers(prematureBid.database, () => {
        insert(prematureBid.database, "auction_bids", {
          id: IDS.laterBid,
          league_id: IDS.league,
          season_id: IDS.season,
          auction_id: IDS.auction,
          team_id: MANAGERS[0].team,
          submitted_by_user_id: MANAGERS[0].user,
          total_value_cents: 700,
          term_years: 2,
          lowest_offered_aav_cents: 350,
          first_submitted_at_ms: ACTIVATED_AT_MS,
          last_edited_at_ms: ACTIVATED_AT_MS,
          edit_count: 0,
          status: "active",
          idempotency_request_id: null,
          version: 1,
        });
      });
      const bidBefore = transactionState(prematureBid.database);
      assertReason(
        () =>
          prematureBid.writer.executeClaimed(
            prematureBid.command
          ),
        "ACTIVATION_AUCTION_NOT_PRISTINE"
      );
      assert.deepEqual(
        transactionState(prematureBid.database),
        bidBefore
      );
    });

    test("accepts only an already-running exact recovery and owns the transaction boundary", (t) => {
      const pendingRecovery = createRuntime(t, {
        recovery: true,
      });
      withoutTriggers(pendingRecovery.database, () => {
        pendingRecovery.database.prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'pending'
          WHERE id = ?
        `).run(IDS.recovery);
      });
      const recoveryBefore = transactionState(
        pendingRecovery.database
      );
      assertReason(
        () =>
          pendingRecovery.writer.executeClaimed(
            pendingRecovery.command
          ),
        "RECOVERY_BINDING_INVALID"
      );
      assert.deepEqual(
        transactionState(pendingRecovery.database),
        recoveryBefore
      );

      const transactionRuntime = createRuntime(t);
      const transactionBefore = transactionState(
        transactionRuntime.database
      );
      assertReason(
        () =>
          transactionRuntime.database
            .transaction(() =>
              transactionRuntime.writer.executeClaimed(
                transactionRuntime.command
              )
            )
            .immediate(),
        "TRANSACTION_ALREADY_ACTIVE"
      );
      assert.deepEqual(
        transactionState(transactionRuntime.database),
        transactionBefore
      );
    });

    test("fails closed when immutable replay outbox evidence drifts", (t) => {
      const runtime = createRuntime(t);
      const result = runtime.writer.executeClaimed(runtime.command);
      withoutTriggers(runtime.database, () => {
        runtime.database.prepare(`
          DELETE FROM outbox_event_audiences
          WHERE league_id = ? AND outbox_event_id = ?
        `).run(
          IDS.league,
          result.evidence.outboxEventIds[0]
        );
      });
      const beforeReplay = transactionState(runtime.database);
      const generatedBefore = runtime.generatedCount();

      assertReason(
        () =>
          runtime.writer.executeClaimed({
            ...runtime.command,
            activatedAtMs: LEASE_EXPIRES_AT_MS + DAY_MS,
          }),
        "OUTBOX_EVIDENCE_INVALID"
      );

      assert.deepEqual(
        transactionState(runtime.database),
        beforeReplay
      );
      assert.equal(runtime.generatedCount(), generatedBefore);
    });
  }
);
