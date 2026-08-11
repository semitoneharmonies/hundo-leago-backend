"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftFallbackActivationOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
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
  FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_JOB_TYPE,
  FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_WRITER_METHODS,
  createSqliteFreeAgentDraftFallbackActivationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftFallbackActivationWriter"
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
const SOURCE_OPENS_AT_MS = DEADLINE_AT_MS;
const SOURCE_RESOLVES_AT_MS =
  SOURCE_OPENS_AT_MS + DAY_MS;
const INTERMEDIATE_OPENS_AT_MS = SOURCE_RESOLVES_AT_MS;
const ACTIVATION_AT_MS = INTERMEDIATE_OPENS_AT_MS + DAY_MS;
const RESOLVES_AT_MS = ACTIVATION_AT_MS + DAY_MS;
const HANDOFF_AT_MS = ACTIVATION_AT_MS - 30 * 60 * 1000;
const ACTIVATED_AT_MS = ACTIVATION_AT_MS + 1_000;
const LEASE_EXPIRES_AT_MS = ACTIVATION_AT_MS + 60 * 60 * 1000;
const LEASE_OWNER = "fad-fallback-activation-worker";
const LEASE_TOKEN = "fad-fallback-activation-lease-token";

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
  player: uuid(6),
  sourceAuction: uuid(7),
  fallbackAuction: uuid(8),
  allocation: uuid(9),
  sourceRollover: uuid(10),
  intermediateRollover: uuid(11),
  targetRollover: uuid(12),
  sourceDraw: uuid(13),
  fallbackDraw: uuid(14),
  sourceResolution: uuid(15),
  sourceTerminalEvent: uuid(16),
  stateEvent: uuid(17),
  activationJob: uuid(18),
  resolutionJob: uuid(19),
  recovery: uuid(20),
  bid: uuid(21),
  bidEvent: uuid(22),
});

function teamIdentity(index) {
  const base = 100 + index * 30;
  return Object.freeze({
    user: uuid(base + 1),
    membership: uuid(base + 2),
    team: uuid(base + 3),
    assignment: uuid(base + 4),
    fadTeam: uuid(base + 5),
    card: uuid(base + 6),
    entry: uuid(base + 7),
    snapshot: uuid(base + 8),
    snapshotEntry: uuid(base + 9),
    offerEvent: uuid(base + 10),
  });
}

const TEAMS = Object.freeze([
  teamIdentity(1),
  teamIdentity(2),
]);

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
    name: "Fallback Activation League",
    name_normalized: "fallback activation league",
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
    first_name: "Finley",
    last_name: "Fallback",
    full_name: "Finley Fallback",
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
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
    participating_team_count: TEAMS.length,
    status: "rapid",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Inaugural league has no Entry Draft.",
    opening_authority: "system",
    opened_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
    help_opens_at_ms: DEADLINE_AT_MS - 48 * 60 * 60 * 1000,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: DEADLINE_AT_MS,
    allocation_completed_at_ms: DEADLINE_AT_MS + 1_000,
    completed_at_ms: null,
    created_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 4,
  });
}

function seedRollover(
  database,
  {
    id,
    sequence,
    predecessorId,
    opensAtMs,
    rollsOverAtMs,
    status,
  }
) {
  insert(database, "free_agent_draft_rollovers", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    sequence,
    window_kind: "initial",
    predecessor_rollover_id: predecessorId,
    extension_reason: null,
    extension_source_id: null,
    opens_at_ms: opensAtMs,
    creation_cutoff_at_ms:
      rollsOverAtMs - 60 * 60 * 1000,
    rolls_over_at_ms: rollsOverAtMs,
    status,
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms:
      status === "completed" ? HANDOFF_AT_MS : null,
    last_error_code: null,
    created_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
    updated_at_ms:
      status === "completed"
        ? HANDOFF_AT_MS
        : DEADLINE_AT_MS - 30 * DAY_MS,
    version: status === "completed" ? 2 : 1,
  });
}

function seedTeam(database, team, index, withManager) {
  insert(database, "users", {
    id: team.user,
    email_normalized: `fallback-${index}@example.test`,
    email_display: `fallback-${index}@example.test`,
    display_name: `Fallback Manager ${index}`,
    display_name_normalized: `fallback manager ${index}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: team.membership,
    league_id: IDS.league,
    user_id: team.user,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "teams", {
    id: team.team,
    league_id: IDS.league,
    name: `Fallback Team ${index}`,
    name_normalized: `fallback team ${index}`,
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
  if (withManager) {
    insert(database, "team_manager_assignments", {
      id: team.assignment,
      league_id: IDS.league,
      team_id: team.team,
      user_id: team.user,
      membership_id: team.membership,
      assigned_by_user_id: team.user,
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: 1,
      accepted_at_ms: 1,
      ended_at_ms: null,
      version: 1,
    });
  }
  insert(database, "free_agent_draft_teams", {
    id: team.fadTeam,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: team.team,
    team_status_at_setup: "active",
    created_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
  });
  insert(database, "candidate_cards", {
    id: team.card,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: team.team,
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
    created_at_ms: DEADLINE_AT_MS - 30 * DAY_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 3,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  insert(database, "candidate_card_entries", {
    id: team.entry,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: team.card,
    team_id: team.team,
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
    created_by_user_id: team.user,
    created_by_membership_id: team.membership,
    created_by_authority: "manager",
    last_edited_by_user_id: team.user,
    last_edited_by_membership_id: team.membership,
    last_edited_by_authority: "manager",
    created_at_ms: DEADLINE_AT_MS - index,
    updated_at_ms: DEADLINE_AT_MS - index,
    version: 1,
  });
  insert(database, "candidate_card_snapshots", {
    id: team.snapshot,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: team.card,
    team_id: team.team,
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
    id: team.snapshotEntry,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    snapshot_id: team.snapshot,
    card_id: team.card,
    team_id: team.team,
    row_kind: "slot",
    occupant_kind: "candidate",
    slot_group: "D",
    slot_number: 1,
    source_entry_id: team.entry,
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
    last_edited_by_user_id: team.user,
    last_edited_by_membership_id: team.membership,
    last_edited_by_authority: "manager",
    last_edited_at_ms: DEADLINE_AT_MS - index,
    created_at_ms: DEADLINE_AT_MS,
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
}

function seedAuctionState(
  database,
  { recovery, withBid }
) {
  seedRollover(database, {
    id: IDS.sourceRollover,
    sequence: 1,
    predecessorId: null,
    opensAtMs: SOURCE_OPENS_AT_MS,
    rollsOverAtMs: SOURCE_RESOLVES_AT_MS,
    status: "scheduled",
  });
  seedRollover(database, {
    id: IDS.intermediateRollover,
    sequence: 2,
    predecessorId: IDS.sourceRollover,
    opensAtMs: INTERMEDIATE_OPENS_AT_MS,
    rollsOverAtMs: ACTIVATION_AT_MS,
    status: "scheduled",
  });
  seedRollover(database, {
    id: IDS.targetRollover,
    sequence: 3,
    predecessorId: IDS.intermediateRollover,
    opensAtMs: ACTIVATION_AT_MS,
    rollsOverAtMs: RESOLVES_AT_MS,
    status: "scheduled",
  });
  insert(database, "auctions", {
    id: IDS.sourceAuction,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    status: "no_winner",
    opened_at_ms: SOURCE_OPENS_AT_MS,
    resolves_at_ms: SOURCE_RESOLVES_AT_MS,
    opened_by_user_id: null,
    created_at_ms: SOURCE_OPENS_AT_MS,
    updated_at_ms: HANDOFF_AT_MS,
    version: 2,
  });
  insert(database, "auctions", {
    id: IDS.fallbackAuction,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    status: "open",
    opened_at_ms: ACTIVATION_AT_MS,
    resolves_at_ms: RESOLVES_AT_MS,
    opened_by_user_id: null,
    created_at_ms: ACTIVATION_AT_MS,
    updated_at_ms: ACTIVATION_AT_MS,
    version: 1,
  });
  insert(database, "free_agent_draft_player_allocations", {
    id: IDS.allocation,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    player_id: IDS.player,
    status: "restricted_fallback_open",
    decision_code: "restricted_no_improvement_fallback",
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: IDS.sourceAuction,
    fallback_open_auction_id: IDS.fallbackAuction,
    restricted_minimum_total_cents: 600,
    restricted_minimum_term_years: 2,
    restricted_minimum_aav_cents: 300,
    accounted_at_ms: null,
    last_error_code: null,
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: HANDOFF_AT_MS,
    version: 3,
  });
  insert(database, "auction_contexts", {
    id: IDS.sourceAuction,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: IDS.sourceAuction,
    source_kind: "fad_restricted",
    fad_id: IDS.fad,
    fad_rollover_id: IDS.sourceRollover,
    fad_allocation_id: IDS.allocation,
    fad_origin: "candidate_tie_restricted",
    created_at_ms: SOURCE_OPENS_AT_MS,
  });
  insert(database, "auction_contexts", {
    id: IDS.fallbackAuction,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: IDS.fallbackAuction,
    source_kind: "fad_open_rapid",
    fad_id: IDS.fad,
    fad_rollover_id: IDS.targetRollover,
    fad_allocation_id: IDS.allocation,
    fad_origin: "restricted_no_improvement_fallback",
    created_at_ms: ACTIVATION_AT_MS,
  });

  const sourceNonce = Buffer.alloc(32, 0x31);
  const fallbackNonce = Buffer.alloc(32, 0x41);
  const sourceCommitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.sourceAuction,
      nonceBytes: sourceNonce,
    });
  const fallbackCommitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.fallbackAuction,
      nonceBytes: fallbackNonce,
    });
  insert(database, "free_agent_draft_draws", {
    id: IDS.sourceDraw,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    auction_id: IDS.sourceAuction,
    algorithm_version: 1,
    nonce_bytes: sourceNonce,
    commitment_hex: sourceCommitment.commitmentHex,
    ordered_tied_bid_ids_json: "[]",
    ordered_tied_team_ids_json: "[]",
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: HANDOFF_AT_MS,
    created_at_ms: SOURCE_OPENS_AT_MS,
    updated_at_ms: HANDOFF_AT_MS,
    version: 2,
  });
  insert(database, "free_agent_draft_draws", {
    id: IDS.fallbackDraw,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    auction_id: IDS.fallbackAuction,
    algorithm_version: 1,
    nonce_bytes: fallbackNonce,
    commitment_hex: fallbackCommitment.commitmentHex,
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

  const sourceOccurrenceKey =
    `auction:${IDS.sourceAuction}:${SOURCE_RESOLVES_AT_MS}`;
  const activationOccurrenceKey =
    buildFreeAgentDraftFallbackActivationOccurrenceKey({
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      activationAtMs: ACTIVATION_AT_MS,
    });
  insert(database, "job_runs", {
    id: IDS.activationJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_JOB_TYPE,
    occurrence_key: activationOccurrenceKey,
    scheduled_for_ms: ACTIVATION_AT_MS,
    status: "running",
    attempt_count: recovery ? 2 : 1,
    lease_owner: LEASE_OWNER,
    lease_expires_at_ms: LEASE_EXPIRES_AT_MS,
    started_at_ms: ACTIVATION_AT_MS,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: HANDOFF_AT_MS,
    updated_at_ms: ACTIVATION_AT_MS,
    version: recovery ? 4 : 2,
    lease_token: LEASE_TOKEN,
    next_attempt_at_ms: null,
  });
  insert(database, "job_runs", {
    id: IDS.resolutionJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: "auction.resolve.target",
    occurrence_key:
      `auction:${IDS.fallbackAuction}:${RESOLVES_AT_MS}`,
    scheduled_for_ms: RESOLVES_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: HANDOFF_AT_MS,
    updated_at_ms: HANDOFF_AT_MS,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: RESOLVES_AT_MS,
  });
  insert(database, "auction_resolutions", {
    id: IDS.sourceResolution,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: IDS.sourceAuction,
    scheduled_occurrence_key: sourceOccurrenceKey,
    outcome_code: "no_winner",
    winning_team_id: null,
    winning_bid_id: null,
    highest_bid_cents: null,
    second_price_input_cents: null,
    final_contract_value_cents: null,
    winning_term_years: null,
    final_aav_cents: null,
    general_illegal: 0,
    warnings_json: "[]",
    contract_id: null,
    ownership_id: null,
    trigger_type: "automatic",
    triggered_by_user_id: null,
    idempotency_key: sourceOccurrenceKey,
    status: "no_winner",
    resolved_at_ms: HANDOFF_AT_MS,
  });
  insert(database, "auction_events", {
    id: IDS.sourceTerminalEvent,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: IDS.sourceAuction,
    bid_id: null,
    team_id: null,
    actor_user_id: null,
    event_type: "auction_no_winner",
    metadata_json: JSON.stringify({
      outcome: "no_winner",
      resolutionId: IDS.sourceResolution,
      fallbackAuctionId: IDS.fallbackAuction,
    }),
    occurred_at_ms: HANDOFF_AT_MS,
  });
  insert(database, "free_agent_draft_allocation_events", {
    id: IDS.stateEvent,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    allocation_version: 3,
    player_id: IDS.player,
    event_kind: "fallback_state_changed",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: "restricted_no_improvement_fallback",
    resulting_allocation_status: "restricted_fallback_open",
    contract_id: null,
    ownership_id: null,
    auction_id: IDS.fallbackAuction,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: JSON.stringify({
      schemaVersion: 1,
      occurrenceKey: sourceOccurrenceKey,
      sourceAuctionId: IDS.sourceAuction,
      fallbackAuctionId: IDS.fallbackAuction,
      targetRolloverId: IDS.targetRollover,
      activationJobRunId: IDS.activationJob,
      activationAtMs: ACTIVATION_AT_MS,
      sourceRecoveryId: null,
      activityId: null,
      notificationIds: [],
      outboxEventIds: [],
    }),
    occurred_at_ms: HANDOFF_AT_MS,
    created_at_ms: HANDOFF_AT_MS,
    version: 1,
  });
  for (const team of TEAMS) {
    insert(database, "free_agent_draft_allocation_events", {
      id: team.offerEvent,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: IDS.allocation,
      allocation_version: 3,
      player_id: IDS.player,
      event_kind: "offer_considered",
      snapshot_entry_id: team.snapshotEntry,
      team_id: team.team,
      offer_valid: 1,
      rank_position: 1,
      offer_outcome_code: "restricted_tied",
      decision_code: null,
      resulting_allocation_status: "restricted_fallback_open",
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
          snapshotEntryId: team.snapshotEntry,
          teamId: team.team,
          totalValueCents: 600,
          termYears: 2,
          aavCents: 300,
        },
        offerValid: true,
        rankPosition: 1,
        outcomeCode: "restricted_tied",
      }),
      occurred_at_ms: HANDOFF_AT_MS,
      created_at_ms: HANDOFF_AT_MS,
      version: 1,
    });
  }

  if (withBid) {
    insert(database, "auction_bids", {
      id: IDS.bid,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.fallbackAuction,
      team_id: TEAMS[0].team,
      submitted_by_user_id: TEAMS[0].user,
      total_value_cents: 600,
      term_years: 2,
      lowest_offered_aav_cents: 300,
      first_submitted_at_ms: ACTIVATION_AT_MS + 500,
      last_edited_at_ms: ACTIVATION_AT_MS + 500,
      edit_count: 0,
      status: "active",
      idempotency_request_id: null,
      version: 1,
    });
    insert(database, "auction_events", {
      id: IDS.bidEvent,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.fallbackAuction,
      bid_id: IDS.bid,
      team_id: TEAMS[0].team,
      actor_user_id: TEAMS[0].user,
      event_type: "bid_submitted",
      metadata_json: "{}",
      occurred_at_ms: ACTIVATION_AT_MS + 500,
    });
  }

  if (recovery) {
    insert(database, "free_agent_draft_recoveries", {
      id: IDS.recovery,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      player_id: IDS.player,
      allocation_id: IDS.allocation,
      rollover_id: IDS.targetRollover,
      auction_id: IDS.fallbackAuction,
      job_run_id: IDS.activationJob,
      kind: "fallback_activation",
      status: "running",
      earliest_activation_at_ms: ACTIVATION_AT_MS,
      target_resolution_at_ms: RESOLVES_AT_MS,
      last_error_code: "FAD_FALLBACK_ACTIVATION_FAILED",
      commissioner_reason: "Retry the exact fallback publication.",
      created_by_operation_id: IDS.activationJob,
      resolved_by_user_id: null,
      resolved_by_membership_id: null,
      resolved_authority: null,
      created_at_ms: ACTIVATION_AT_MS,
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
    managerCount = TEAMS.length,
    recovery = false,
    withBid = false,
    beforeCommit,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-fallback-activation-")
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
      "fad-fallback-activation-writer-foundation",
    now: () => 1,
  });
  const triggers = captureAndDropTriggers(connection.database);
  seedBase(connection.database);
  TEAMS.forEach((team, index) => {
    seedTeam(
      connection.database,
      team,
      index + 1,
      index < managerCount
    );
  });
  seedAuctionState(connection.database, {
    recovery,
    withBid,
  });
  restoreTriggers(connection.database, triggers);
  assert.deepEqual(
    connection.database.prepare("PRAGMA foreign_key_check").all(),
    []
  );

  let generated = 8_000;
  const writer =
    createSqliteFreeAgentDraftFallbackActivationWriter({
      database: connection.database,
      createId() {
        generated += 1;
        return uuid(generated);
      },
      beforeCommit,
    });
  const occurrenceKey =
    buildFreeAgentDraftFallbackActivationOccurrenceKey({
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
    sourceAuctionId: IDS.sourceAuction,
    auctionId: IDS.fallbackAuction,
    rolloverId: IDS.targetRollover,
    activationAtMs: ACTIVATION_AT_MS,
    occurrenceKey,
    expectedAllocationVersion: 3,
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
  };
}

function immutableResourceState(database) {
  return Object.freeze({
    allocation: database.prepare(`
      SELECT *
      FROM free_agent_draft_player_allocations
      WHERE id = ?
    `).get(IDS.allocation),
    auction: database.prepare(`
      SELECT * FROM auctions WHERE id = ?
    `).get(IDS.fallbackAuction),
    context: database.prepare(`
      SELECT * FROM auction_contexts WHERE auction_id = ?
    `).get(IDS.fallbackAuction),
    draw: database.prepare(`
      SELECT * FROM free_agent_draft_draws WHERE auction_id = ?
    `).get(IDS.fallbackAuction),
    bids: database.prepare(`
      SELECT * FROM auction_bids
      WHERE auction_id = ?
      ORDER BY id
    `).all(IDS.fallbackAuction),
  });
}

function sideEffectCounts(database) {
  return database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM league_activity) AS activities,
      (SELECT COUNT(*) FROM notifications) AS notifications,
      (SELECT COUNT(*) FROM outbox_events) AS outboxEvents,
      (SELECT COUNT(*) FROM outbox_event_audiences)
        AS outboxAudiences
  `).get();
}

describe("SQLite delayed FAD fallback activation writer", () => {
  test("exports the exact uncomposed writer surface", () => {
    assert.deepEqual(
      FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_WRITER_METHODS,
      ["findActivation", "executeClaimed"]
    );
    assert.equal(
      FREE_AGENT_DRAFT_FALLBACK_ACTIVATION_JOB_TYPE,
      "fad_fallback_activation"
    );
  });

  test("publishes the due fallback with a legitimate bid and immutably replays after lease expiry", (t) => {
    const { database, writer, command } = createRuntime(t, {
      withBid: true,
    });
    const before = immutableResourceState(database);
    assert.deepEqual(
      writer.findActivation({
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
        status: "restricted_fallback_open",
        allocationVersion: 3,
        sourceAuctionId: IDS.sourceAuction,
        auctionId: IDS.fallbackAuction,
        rolloverId: IDS.targetRollover,
        activationAtMs: ACTIVATION_AT_MS,
        resolvesAtMs: RESOLVES_AT_MS,
        activationJobRunId: IDS.activationJob,
        activationOccurrenceKey: command.occurrenceKey,
        jobStatus: "running",
        jobRunVersion: 2,
      }
    );

    const result = writer.executeClaimed(command);
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.replayed, false);
    assert.equal(result.sourceAuctionId, IDS.sourceAuction);
    assert.equal(result.allocationVersion, 3);
    assert.equal(result.jobRunVersion, 3);
    assert.equal(result.sourceRecoveryId, null);
    assert.equal(result.evidence.sourceResolutionId, IDS.sourceResolution);
    assert.equal(result.evidence.stateEventId, IDS.stateEvent);
    assert.equal(result.evidence.notificationIds.length, TEAMS.length);
    assert.equal(result.evidence.outboxEventIds.length, 5);
    assert.deepEqual(immutableResourceState(database), before);
    assert.deepEqual(sideEffectCounts(database), {
      activities: 1,
      notifications: 2,
      outboxEvents: 5,
      outboxAudiences: 5,
    });
    const publications = database.prepare(`
      SELECT event.*, audience.audience_kind,
             audience.user_id
      FROM outbox_events AS event
      JOIN outbox_event_audiences AS audience
        ON audience.league_id = event.league_id
       AND audience.outbox_event_id = event.id
      ORDER BY event.id
    `).all();
    for (const publication of publications) {
      const payload = JSON.parse(publication.payload_json);
      assert.equal(payload.eventId, publication.id);
      assert.equal(payload.type, publication.event_type);
      assert.equal(payload.leagueId, IDS.league);
      assert.equal(payload.resourceId, publication.aggregate_id);
      assert.equal(payload.occurredAt, ACTIVATED_AT_MS);
      assert.equal(payload.related.fadId, IDS.fad);
      assert.equal(payload.related.allocationId, IDS.allocation);
      assert.equal(payload.related.auctionId, IDS.fallbackAuction);
      assert.equal(
        publication.audience_kind,
        publication.event_type === "notification.created"
          ? "user"
          : "league"
      );
    }

    withoutTriggers(database, () => {
      database.prepare(`
        UPDATE team_manager_assignments
        SET status = 'ended',
            ended_at_ms = ?,
            version = version + 1
        WHERE id = ?
      `).run(ACTIVATED_AT_MS + 1, TEAMS[0].assignment);
      database.prepare(`
        UPDATE notifications
        SET delivery_status = 'delivered',
            read_at_ms = ?,
            delivered_at_ms = ?,
            version = version + 1
        WHERE related_record_id = ?
      `).run(
        ACTIVATED_AT_MS + 2,
        ACTIVATED_AT_MS + 1,
        IDS.fallbackAuction
      );
    });
    const replay = writer.executeClaimed({
      ...command,
      activatedAtMs: LEASE_EXPIRES_AT_MS + 1,
    });
    assert.deepEqual(replay, {
      ...result,
      replayed: true,
    });
    assert.deepEqual(sideEffectCounts(database), {
      activities: 1,
      notifications: 2,
      outboxEvents: 5,
      outboxAudiences: 5,
    });
  });

  test("excludes future-ended membership and assignment rows from delayed fallback recipients and immutable replay", (t) => {
    const { database, writer, command } = createRuntime(t, {
      withBid: true,
    });
    assert.equal(
      database.prepare(`
        UPDATE league_memberships
        SET ended_at_ms = @endedAtMs,
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE id = @membershipId
          AND status = 'active'
      `).run({
        endedAtMs: ACTIVATED_AT_MS + DAY_MS,
        membershipId: TEAMS[0].membership,
        updatedAtMs: ACTIVATED_AT_MS - 1,
      }).changes,
      1
    );
    assert.equal(
      database.prepare(`
        UPDATE team_manager_assignments
        SET ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @assignmentId
          AND status = 'accepted'
      `).run({
        assignmentId: TEAMS[1].assignment,
        endedAtMs: ACTIVATED_AT_MS + DAY_MS,
      }).changes,
      1
    );
    const before = immutableResourceState(database);

    const result = writer.executeClaimed(command);

    assert.equal(result.outcome, "succeeded");
    assert.deepEqual(result.evidence.notificationIds, []);
    assert.equal(result.evidence.outboxEventIds.length, 3);
    assert.deepEqual(immutableResourceState(database), before);
    assert.deepEqual(sideEffectCounts(database), {
      activities: 1,
      notifications: 0,
      outboxEvents: 3,
      outboxAudiences: 3,
    });
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_event_audiences
        WHERE audience_kind = 'user'
      `).get().count,
      0
    );

    database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = NULL,
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND status = 'active'
    `).run({
      membershipId: TEAMS[0].membership,
      updatedAtMs: ACTIVATED_AT_MS + 1,
    });
    database.prepare(`
      UPDATE team_manager_assignments
      SET ended_at_ms = NULL,
          version = version + 1
      WHERE id = @assignmentId
        AND status = 'accepted'
    `).run({ assignmentId: TEAMS[1].assignment });
    const replay = writer.executeClaimed({
      ...command,
      activatedAtMs: LEASE_EXPIRES_AT_MS + 1,
    });
    assert.deepEqual(replay, {
      ...result,
      replayed: true,
    });
    assert.deepEqual(sideEffectCounts(database), {
      activities: 1,
      notifications: 0,
      outboxEvents: 3,
      outboxAudiences: 3,
    });
  });

  test("resolves an exact running activation recovery and supports zero recipients", (t) => {
    const { database, writer, command } = createRuntime(t, {
      managerCount: 0,
      recovery: true,
    });
    const before = immutableResourceState(database);
    const result = writer.executeClaimed(command);
    assert.equal(result.replayed, false);
    assert.equal(result.sourceRecoveryId, IDS.recovery);
    assert.deepEqual(result.evidence.notificationIds, []);
    assert.deepEqual(immutableResourceState(database), before);
    assert.deepEqual(sideEffectCounts(database), {
      activities: 1,
      notifications: 0,
      outboxEvents: 3,
      outboxAudiences: 3,
    });
    assert.deepEqual(
      database.prepare(`
        SELECT status, last_error_code AS lastErrorCode,
               resolved_authority AS resolvedAuthority,
               resolved_at_ms AS resolvedAtMs,
               version
        FROM free_agent_draft_recoveries
        WHERE id = ?
      `).get(IDS.recovery),
      {
        status: "resolved",
        lastErrorCode: null,
        resolvedAuthority: "system",
        resolvedAtMs: ACTIVATED_AT_MS,
        version: 3,
      }
    );
  });

  test("rejects the exact resolution boundary without publication", (t) => {
    const { database, writer, command } = createRuntime(t);
    assert.throws(
      () => writer.executeClaimed({
        ...command,
        activatedAtMs: RESOLVES_AT_MS,
      }),
      (error) => {
        assert.ok(error instanceof SqliteRepositoryError);
        assert.equal(
          error.details?.reasonCode,
          "ACTIVATION_WINDOW_CLOSED"
        );
        return true;
      }
    );
    assert.deepEqual(sideEffectCounts(database), {
      activities: 0,
      notifications: 0,
      outboxEvents: 0,
      outboxAudiences: 0,
    });
    assert.equal(
      database.prepare(`
        SELECT status FROM job_runs WHERE id = ?
      `).get(IDS.activationJob).status,
      "running"
    );
  });

  test("rejects a non-rapid FAD and mismatched same-allocation recovery", (t) => {
    const lifecycle = createRuntime(t);
    withoutTriggers(lifecycle.database, () => {
      lifecycle.database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'completed',
            completed_at_ms = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE id = ?
      `).run(ACTIVATED_AT_MS, ACTIVATED_AT_MS, IDS.fad);
    });
    assert.throws(
      () => lifecycle.writer.executeClaimed(lifecycle.command),
      (error) => {
        assert.ok(error instanceof SqliteRepositoryError);
        assert.equal(
          error.details?.reasonCode,
          "ACTIVATION_BINDING_INVALID"
        );
        return true;
      }
    );
    assert.deepEqual(sideEffectCounts(lifecycle.database), {
      activities: 0,
      notifications: 0,
      outboxEvents: 0,
      outboxAudiences: 0,
    });

    const recovery = createRuntime(t, { recovery: true });
    withoutTriggers(recovery.database, () => {
      recovery.database.prepare(`
        UPDATE free_agent_draft_recoveries
        SET auction_id = ?
        WHERE id = ?
      `).run(IDS.sourceAuction, IDS.recovery);
    });
    assert.throws(
      () => recovery.writer.executeClaimed(recovery.command),
      (error) => {
        assert.ok(error instanceof SqliteRepositoryError);
        assert.equal(
          error.details?.reasonCode,
          "RECOVERY_BINDING_INVALID"
        );
        return true;
      }
    );
    assert.deepEqual(sideEffectCounts(recovery.database), {
      activities: 0,
      notifications: 0,
      outboxEvents: 0,
      outboxAudiences: 0,
    });
  });

  test("rolls every publication and job settlement back at the final seam", (t) => {
    const { database, writer, command } = createRuntime(t, {
      recovery: true,
      beforeCommit() {
        throw new Error("fallback activation rollback seam");
      },
    });
    const before = immutableResourceState(database);
    assert.throws(
      () => writer.executeClaimed(command),
      (error) => {
        assert.ok(error instanceof SqliteRepositoryError);
        assert.match(
          error.cause?.message || "",
          /fallback activation rollback seam/
        );
        return true;
      }
    );
    assert.deepEqual(immutableResourceState(database), before);
    assert.deepEqual(sideEffectCounts(database), {
      activities: 0,
      notifications: 0,
      outboxEvents: 0,
      outboxAudiences: 0,
    });
    assert.deepEqual(
      database.prepare(`
        SELECT status, result_json AS resultJson,
               completed_at_ms AS completedAtMs,
               version
        FROM job_runs WHERE id = ?
      `).get(IDS.activationJob),
      {
        status: "running",
        resultJson: null,
        completedAtMs: null,
        version: 4,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, last_error_code AS lastErrorCode,
               resolved_at_ms AS resolvedAtMs,
               version
        FROM free_agent_draft_recoveries
        WHERE id = ?
      `).get(IDS.recovery),
      {
        status: "running",
        lastErrorCode: "FAD_FALLBACK_ACTIVATION_FAILED",
        resolvedAtMs: null,
        version: 2,
      }
    );
  });
});
