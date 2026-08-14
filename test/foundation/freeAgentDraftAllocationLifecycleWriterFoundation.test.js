"use strict";

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
  createFreeAgentDraftAllocationLifecycleService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftAllocationLifecycleService"
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
  createSqliteFreeAgentDraftAllocationLifecycleWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftAllocationLifecycleWriter"
);
const {
  createSqliteFreeAgentDraftRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRepository"
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
const NOW_MS = DEADLINE_AT_MS + 10_000;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${fields.join(", ")}
      ) VALUES (
        ${fields
          .map((field) => `@${field}`)
          .join(", ")}
      )
    `)
    .run(values);
}

function captureAndDropTriggers(database, tableName = null) {
  const rows = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND (@tableName IS NULL OR tbl_name = @tableName)
      ORDER BY name
    `)
    .all({ tableName });
  for (const row of rows) {
    database.exec(
      `DROP TRIGGER "${row.name.replaceAll(
        '"',
        '""'
      )}"`
    );
  }
  return rows;
}

function restoreTriggers(database, triggers) {
  for (const trigger of triggers) {
    database.exec(trigger.sql);
  }
}

function scopeIds(base) {
  return Object.freeze({
    league: uuid(base + 1),
    season: uuid(base + 2),
    user: uuid(base + 3),
    membership: uuid(base + 4),
    team: uuid(base + 5),
    assignment: uuid(base + 6),
    week: uuid(base + 7),
    schedule: uuid(base + 8),
    readiness: uuid(base + 9),
    fad: uuid(base + 10),
    participant: uuid(base + 11),
    card: uuid(base + 12),
    snapshot: uuid(base + 13),
    player: uuid(base + 14),
    sourceEntry: uuid(base + 15),
    allocation: uuid(base + 16),
    allocationJob: uuid(base + 17),
    recovery: uuid(base + 18),
    offerEvent: uuid(base + 19),
    stateEvent: uuid(base + 20),
  });
}

function seedRootFoundation(database, ids, name) {
  insert(database, "leagues", {
    id: ids.league,
    name,
    name_normalized: name.toLowerCase(),
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: ids.season,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "users", {
    id: ids.user,
    email_normalized: `${ids.user}@example.test`,
    email_display: `${ids.user}@example.test`,
    display_name: name,
    display_name_normalized: name.toLowerCase(),
    status: "active",
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
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `${name} Team`,
    name_normalized: `${name.toLowerCase()} team`,
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
    baseline_at_ms: WEEK_ONE_AT_MS + 60 * 60 * 1000,
    locks_at_ms: WEEK_ONE_AT_MS + 2 * 60 * 60 * 1000,
    ends_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "matchup_operations", {
    id: ids.schedule,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: null,
    matchup_id: null,
    actor_user_id: ids.user,
    operation_type: "schedule_generate",
    status: "succeeded",
    reason: null,
    metadata_json: null,
    started_at_ms: 1,
    completed_at_ms: 2,
  });
  insert(database, "season_matchup_schedule_generations", {
    league_id: ids.league,
    season_id: ids.season,
    schedule_version: 1,
    schedule_operation_id: ids.schedule,
    week_one_matchup_week_id: ids.week,
    week_one_starts_at_ms: WEEK_ONE_AT_MS,
    status: "current",
    created_at_ms: 2,
    superseded_at_ms: null,
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
    current_competition_first_matchup_week_id: ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "deadline_locked",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Foundation no-draft path.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms:
      DEADLINE_AT_MS - 48 * 60 * 60 * 1000,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: DEADLINE_AT_MS,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 2,
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
}

function seedCard(database, ids, { candidate }) {
  if (candidate) {
    insert(database, "players", {
      id: ids.player,
      first_name: "Pending",
      last_name: "Candidate",
      full_name: "Pending Candidate",
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }
  insert(database, "candidate_cards", {
    id: ids.card,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    status: "locked_incomplete",
    completeness_code: "incomplete",
    filled_mandatory_count: candidate ? 1 : 0,
    missing_mandatory_count: candidate ? 17 : 18,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    carried_roster_structural_conflict_count: 0,
    maximum_possible_cap_cents: candidate ? 600 : 0,
    locked_at_ms: DEADLINE_AT_MS,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 2,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
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
    filled_mandatory_count: candidate ? 1 : 0,
    missing_mandatory_count: candidate ? 17 : 18,
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
    proposed_candidate_aav_cents: candidate ? 600 : 0,
    maximum_possible_cap_cents: candidate ? 600 : 0,
    maximum_cap_space_cents: candidate ? 9_400 : 10_000,
    effective_deadline_at_ms: DEADLINE_AT_MS,
    processed_at_ms: DEADLINE_AT_MS,
    created_at_ms: DEADLINE_AT_MS,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  const slots = [
    ...Array.from({ length: 12 }, (_, index) => ["F", index + 1]),
    ...Array.from({ length: 6 }, (_, index) => ["D", index + 1]),
    ...Array.from({ length: 4 }, (_, index) => ["B", index + 1]),
  ];
  slots.forEach(([slotGroup, slotNumber], index) => {
    const isCandidate = candidate && index === 0;
    insert(database, "candidate_card_snapshot_entries", {
      id: uuid(Number(ids.snapshot.slice(-12)) + 100 + index),
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      snapshot_id: ids.snapshot,
      card_id: ids.card,
      team_id: ids.team,
      row_kind: "slot",
      occupant_kind: isCandidate ? "candidate" : "empty",
      slot_group: slotGroup,
      slot_number: slotNumber,
      source_entry_id: isCandidate ? ids.sourceEntry : null,
      source_entry_version: isCandidate ? 1 : null,
      player_id: isCandidate ? ids.player : null,
      effective_position_group: isCandidate ? "F" : null,
      conflict_code: null,
      carryover_ownership_id: null,
      carryover_contract_id: null,
      source_roster_category: null,
      carryover_original_total_value_cents: null,
      carryover_original_term_years: null,
      carryover_aav_cents: null,
      remaining_years: null,
      proposed_total_value_cents: isCandidate ? 600 : null,
      proposed_term_years: isCandidate ? 1 : null,
      proposed_aav_cents: isCandidate ? 600 : null,
      eligibility_status: isCandidate ? "valid" : null,
      validation_code: null,
      last_edited_by_user_id: isCandidate ? ids.user : null,
      last_edited_by_membership_id: isCandidate
        ? ids.membership
        : null,
      last_edited_by_authority: isCandidate ? "manager" : null,
      last_edited_at_ms: isCandidate ? DEADLINE_AT_MS - 1 : null,
      created_at_ms: DEADLINE_AT_MS,
      allocation_eligibility: isCandidate ? "eligible" : null,
      allocation_exclusion_reason: null,
    });
  });
  if (candidate) {
    insert(database, "free_agent_draft_player_allocations", {
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
      created_at_ms: DEADLINE_AT_MS,
      updated_at_ms: DEADLINE_AT_MS,
      version: 1,
    });
    insert(database, "job_runs", {
      id: ids.allocationJob,
      league_id: ids.league,
      season_id: ids.season,
      job_type: "fad_allocation",
      occurrence_key:
        `fad:${ids.fad}:allocate:${ids.player}`,
      scheduled_for_ms: DEADLINE_AT_MS,
      status: "pending",
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at_ms: null,
      started_at_ms: null,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      created_at_ms: DEADLINE_AT_MS,
      updated_at_ms: DEADLINE_AT_MS,
      version: 1,
      lease_token: null,
      next_attempt_at_ms: null,
    });
  }
}

function seedCorrectionCompletionEvidence(database, ids) {
  const accountedAtMs = NOW_MS - 1;
  const snapshotEntryId = uuid(
    Number(ids.snapshot.slice(-12)) + 100
  );
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'allocating',
          updated_at_ms = @updatedAtMs,
          version = 3
      WHERE id = @fadId
    `)
    .run({
      fadId: ids.fad,
      updatedAtMs: DEADLINE_AT_MS + 1,
    });
  database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'correction_required',
          last_error_code = 'PERSISTENCE_RACE',
          updated_at_ms = @accountedAtMs,
          version = 2
      WHERE id = @allocationId
    `)
    .run({
      allocationId: ids.allocation,
      accountedAtMs,
    });
  insert(database, "free_agent_draft_allocation_events", {
    id: ids.offerEvent,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    allocation_version: 2,
    player_id: ids.player,
    event_kind: "offer_considered",
    snapshot_entry_id: snapshotEntryId,
    team_id: ids.team,
    offer_valid: 1,
    rank_position: 1,
    offer_outcome_code: "winner",
    decision_code: null,
    resulting_allocation_status: "correction_required",
    contract_id: null,
    ownership_id: null,
    auction_id: null,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: JSON.stringify({ operation: "fixture_offer" }),
    occurred_at_ms: accountedAtMs,
    created_at_ms: accountedAtMs,
    version: 1,
  });
  insert(database, "free_agent_draft_allocation_events", {
    id: ids.stateEvent,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    allocation_version: 2,
    player_id: ids.player,
    event_kind: "decision_recorded",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: null,
    resulting_allocation_status: "correction_required",
    contract_id: null,
    ownership_id: null,
    auction_id: null,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: JSON.stringify({ operation: "fixture_quarantine" }),
    occurred_at_ms: accountedAtMs,
    created_at_ms: accountedAtMs,
    version: 1,
  });
  insert(database, "free_agent_draft_recoveries", {
    id: ids.recovery,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    allocation_id: ids.allocation,
    rollover_id: null,
    auction_id: null,
    job_run_id: ids.allocationJob,
    kind: "allocation_retry",
    status: "correction_required",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: "PERSISTENCE_RACE",
    commissioner_reason: null,
    created_by_operation_id:
      `fad:${ids.fad}:allocate:${ids.player}`,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: accountedAtMs,
    updated_at_ms: accountedAtMs,
    resolved_at_ms: null,
    version: 1,
  });
}

function seedAdditionalUser(database, ids, name) {
  insert(database, "users", {
    id: ids.user,
    email_normalized: `${ids.user}@example.test`,
    email_display: `${ids.user}@example.test`,
    display_name: name,
    display_name_normalized: name.toLowerCase(),
    status: "active",
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
}

function seedAdditionalTeam(database, ids, name, participantId) {
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name,
    name_normalized: name.toLowerCase(),
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
  insert(database, "free_agent_draft_teams", {
    id: participantId,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  });
}

function seedManagerAssignment(database, {
  assignmentId,
  leagueId,
  teamId,
  userId,
  membershipId,
  assignedByUserId,
  replacesAssignmentId = null,
  status = "accepted",
  acceptedAtMs = 1,
  endedAtMs = null,
}) {
  insert(database, "team_manager_assignments", {
    id: assignmentId,
    league_id: leagueId,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: assignedByUserId,
    replaces_assignment_id: replacesAssignmentId,
    status,
    assigned_at_ms: 1,
    accepted_at_ms: acceptedAtMs,
    ended_at_ms: endedAtMs,
    version: 1,
  });
}

function makeSnapshotCandidate(database, {
  entryId,
  playerId,
  sourceEntryId,
  userId,
  membershipId,
  eligibilityStatus = "valid",
  allocationEligibility = "eligible",
  allocationExclusionReason = null,
}) {
  database
    .prepare(`
      UPDATE candidate_card_snapshot_entries
      SET occupant_kind = 'candidate',
          source_entry_id = @sourceEntryId,
          source_entry_version = 1,
          player_id = @playerId,
          effective_position_group = 'F',
          proposed_total_value_cents = 600,
          proposed_term_years = 1,
          proposed_aav_cents = 600,
          eligibility_status = @eligibilityStatus,
          validation_code = NULL,
          last_edited_by_user_id = @userId,
          last_edited_by_membership_id = @membershipId,
          last_edited_by_authority = 'manager',
          last_edited_at_ms = @editedAtMs,
          allocation_eligibility = @allocationEligibility,
          allocation_exclusion_reason = @allocationExclusionReason
      WHERE id = @entryId
    `)
    .run({
      entryId,
      playerId,
      sourceEntryId,
      userId,
      membershipId,
      eligibilityStatus,
      allocationEligibility,
      allocationExclusionReason,
      editedAtMs: DEADLINE_AT_MS - 1,
    });
}

function seedAggregateAllocation(database, {
  ids,
  allocationId,
  playerId,
  status,
  decisionCode,
  winningEntryId = null,
  winningTeamId = null,
  contractId = null,
  ownershipId = null,
  lastErrorCode = null,
}) {
  insert(database, "players", {
    id: playerId,
    first_name: "Aggregate",
    last_name: playerId.slice(-4),
    full_name: `Aggregate ${playerId.slice(-4)}`,
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "free_agent_draft_player_allocations", {
    id: allocationId,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: playerId,
    status,
    decision_code: decisionCode,
    winning_snapshot_entry_id: winningEntryId,
    winning_team_id: winningTeamId,
    contract_id: contractId,
    ownership_id: ownershipId,
    restricted_auction_id: null,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: null,
    restricted_minimum_term_years: null,
    restricted_minimum_aav_cents: null,
    accounted_at_ms: null,
    last_error_code: lastErrorCode,
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: NOW_MS - 1,
    version: 1,
  });
}

function seedAggregateOffer(database, {
  ids,
  eventId,
  allocationId,
  playerId,
  snapshotEntryId,
  teamId,
  status,
  decisionCode,
  offerValid,
  rankPosition,
  offerOutcomeCode,
  contractId = null,
  ownershipId = null,
}) {
  insert(database, "free_agent_draft_allocation_events", {
    id: eventId,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: allocationId,
    allocation_version: 1,
    player_id: playerId,
    event_kind: "offer_considered",
    snapshot_entry_id: snapshotEntryId,
    team_id: teamId,
    offer_valid: offerValid,
    rank_position: rankPosition,
    offer_outcome_code: offerOutcomeCode,
    decision_code: decisionCode,
    resulting_allocation_status: status,
    contract_id: contractId,
    ownership_id: ownershipId,
    auction_id: null,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: JSON.stringify({ operation: "aggregate_fixture" }),
    occurred_at_ms: NOW_MS - 1,
    created_at_ms: NOW_MS - 1,
    version: 1,
  });
}

function seedAggregateProjection(database, ids) {
  const fixture = Object.freeze({
    user2: uuid(54_001),
    membership2: uuid(54_002),
    oldUser: uuid(54_003),
    oldMembership: uuid(54_004),
    team2: uuid(54_005),
    team3: uuid(54_006),
    team4: uuid(54_007),
    oldAssignment: uuid(54_008),
    currentAssignment: uuid(54_009),
    team3Assignment: uuid(54_010),
    participant2: uuid(54_011),
    participant3: uuid(54_012),
    participant4: uuid(54_013),
    team2Card: uuid(51_001),
    team2Snapshot: uuid(51_002),
    team3Card: uuid(52_001),
    team3Snapshot: uuid(52_002),
    team4Card: uuid(53_001),
    team4Snapshot: uuid(53_002),
    automaticPlayer: uuid(55_001),
    restrictedPlayer: uuid(55_002),
    invalidPlayer: uuid(55_003),
    correctionPlayer: uuid(55_004),
    automaticAllocation: uuid(55_101),
    restrictedAllocation: uuid(55_102),
    invalidAllocation: uuid(55_103),
    correctionAllocation: uuid(55_104),
    automaticContract: uuid(55_201),
    automaticOwnership: uuid(55_202),
    team1AutomaticEntry: uuid(50_113),
    team1RestrictedEntry: uuid(50_114),
    team2AutomaticEntry: uuid(51_102),
    team2RestrictedEntry: uuid(51_103),
    team2InvalidEntry: uuid(51_104),
    team2CorrectionEntry: uuid(51_105),
  });
  seedAdditionalUser(
    database,
    {
      league: ids.league,
      user: fixture.user2,
      membership: fixture.membership2,
    },
    "Current Transferred Manager"
  );
  seedAdditionalUser(
    database,
    {
      league: ids.league,
      user: fixture.oldUser,
      membership: fixture.oldMembership,
    },
    "Former Manager"
  );
  for (const [team, name, participant] of [
    [fixture.team2, "Transferred Team", fixture.participant2],
    [fixture.team3, "Second Managed Team", fixture.participant3],
    [fixture.team4, "Unmanaged Team", fixture.participant4],
  ]) {
    seedAdditionalTeam(
      database,
      { ...ids, team },
      name,
      participant
    );
  }
  seedManagerAssignment(database, {
    assignmentId: fixture.oldAssignment,
    leagueId: ids.league,
    teamId: fixture.team2,
    userId: fixture.oldUser,
    membershipId: fixture.oldMembership,
    assignedByUserId: ids.user,
    status: "ended",
    acceptedAtMs: 1,
    endedAtMs: 2,
  });
  seedManagerAssignment(database, {
    assignmentId: fixture.currentAssignment,
    leagueId: ids.league,
    teamId: fixture.team2,
    userId: fixture.user2,
    membershipId: fixture.membership2,
    assignedByUserId: ids.user,
    replacesAssignmentId: fixture.oldAssignment,
  });
  seedManagerAssignment(database, {
    assignmentId: fixture.team3Assignment,
    leagueId: ids.league,
    teamId: fixture.team3,
    userId: ids.user,
    membershipId: ids.membership,
    assignedByUserId: ids.user,
  });
  for (const cardIds of [
    {
      team: fixture.team2,
      user: fixture.user2,
      membership: fixture.membership2,
      card: fixture.team2Card,
      snapshot: fixture.team2Snapshot,
    },
    {
      team: fixture.team3,
      user: ids.user,
      membership: ids.membership,
      card: fixture.team3Card,
      snapshot: fixture.team3Snapshot,
    },
    {
      team: fixture.team4,
      user: ids.user,
      membership: ids.membership,
      card: fixture.team4Card,
      snapshot: fixture.team4Snapshot,
    },
  ]) {
    seedCard(database, { ...ids, ...cardIds }, { candidate: false });
  }

  seedAggregateAllocation(database, {
    ids,
    allocationId: fixture.automaticAllocation,
    playerId: fixture.automaticPlayer,
    status: "automatic_award",
    decisionCode: "highest_total",
    winningEntryId: fixture.team1AutomaticEntry,
    winningTeamId: ids.team,
    contractId: fixture.automaticContract,
    ownershipId: fixture.automaticOwnership,
  });
  seedAggregateAllocation(database, {
    ids,
    allocationId: fixture.restrictedAllocation,
    playerId: fixture.restrictedPlayer,
    status: "restricted_scheduled",
    decisionCode: "exact_total_and_term_tie",
  });
  seedAggregateAllocation(database, {
    ids,
    allocationId: fixture.invalidAllocation,
    playerId: fixture.invalidPlayer,
    status: "no_valid_offer",
    decisionCode: "no_valid_offer",
  });
  seedAggregateAllocation(database, {
    ids,
    allocationId: fixture.correctionAllocation,
    playerId: fixture.correctionPlayer,
    status: "correction_required",
    decisionCode: null,
    lastErrorCode: "PERSISTENCE_RACE",
  });

  for (const candidate of [
    {
      entryId: fixture.team1AutomaticEntry,
      playerId: fixture.automaticPlayer,
      sourceEntryId: uuid(55_301),
      userId: ids.user,
      membershipId: ids.membership,
    },
    {
      entryId: fixture.team2AutomaticEntry,
      playerId: fixture.automaticPlayer,
      sourceEntryId: uuid(55_302),
      userId: fixture.user2,
      membershipId: fixture.membership2,
    },
    {
      entryId: fixture.team1RestrictedEntry,
      playerId: fixture.restrictedPlayer,
      sourceEntryId: uuid(55_303),
      userId: ids.user,
      membershipId: ids.membership,
    },
    {
      entryId: fixture.team2RestrictedEntry,
      playerId: fixture.restrictedPlayer,
      sourceEntryId: uuid(55_304),
      userId: fixture.user2,
      membershipId: fixture.membership2,
    },
    {
      entryId: fixture.team2InvalidEntry,
      playerId: fixture.invalidPlayer,
      sourceEntryId: uuid(55_305),
      userId: fixture.user2,
      membershipId: fixture.membership2,
      allocationEligibility: "excluded_over_cap",
      allocationExclusionReason: "candidate_card_over_cap",
    },
    {
      entryId: fixture.team2CorrectionEntry,
      playerId: fixture.correctionPlayer,
      sourceEntryId: uuid(55_306),
      userId: fixture.user2,
      membershipId: fixture.membership2,
      allocationEligibility: "excluded_structural_conflict",
      allocationExclusionReason: "candidate_card_structural_conflict",
    },
  ]) {
    makeSnapshotCandidate(database, candidate);
  }

  for (const offer of [
    {
      eventId: uuid(55_401),
      allocationId: fixture.automaticAllocation,
      playerId: fixture.automaticPlayer,
      snapshotEntryId: fixture.team1AutomaticEntry,
      teamId: ids.team,
      status: "automatic_award",
      decisionCode: "highest_total",
      offerValid: 1,
      rankPosition: 1,
      offerOutcomeCode: "winner",
      contractId: fixture.automaticContract,
      ownershipId: fixture.automaticOwnership,
    },
    {
      eventId: uuid(55_402),
      allocationId: fixture.automaticAllocation,
      playerId: fixture.automaticPlayer,
      snapshotEntryId: fixture.team2AutomaticEntry,
      teamId: fixture.team2,
      status: "automatic_award",
      decisionCode: "highest_total",
      offerValid: 1,
      rankPosition: 2,
      offerOutcomeCode: "lost_lower_total",
      contractId: fixture.automaticContract,
      ownershipId: fixture.automaticOwnership,
    },
    {
      eventId: uuid(55_403),
      allocationId: fixture.restrictedAllocation,
      playerId: fixture.restrictedPlayer,
      snapshotEntryId: fixture.team1RestrictedEntry,
      teamId: ids.team,
      status: "restricted_scheduled",
      decisionCode: "exact_total_and_term_tie",
      offerValid: 1,
      rankPosition: 1,
      offerOutcomeCode: "restricted_tied",
    },
    {
      eventId: uuid(55_404),
      allocationId: fixture.restrictedAllocation,
      playerId: fixture.restrictedPlayer,
      snapshotEntryId: fixture.team2RestrictedEntry,
      teamId: fixture.team2,
      status: "restricted_scheduled",
      decisionCode: "exact_total_and_term_tie",
      offerValid: 1,
      rankPosition: 1,
      offerOutcomeCode: "restricted_tied",
    },
    {
      eventId: uuid(55_405),
      allocationId: fixture.invalidAllocation,
      playerId: fixture.invalidPlayer,
      snapshotEntryId: fixture.team2InvalidEntry,
      teamId: fixture.team2,
      status: "no_valid_offer",
      decisionCode: "no_valid_offer",
      offerValid: 0,
      rankPosition: 1,
      offerOutcomeCode: "excluded_over_cap",
    },
    {
      eventId: uuid(55_406),
      allocationId: fixture.correctionAllocation,
      playerId: fixture.correctionPlayer,
      snapshotEntryId: fixture.team2CorrectionEntry,
      teamId: fixture.team2,
      status: "correction_required",
      decisionCode: null,
      offerValid: 0,
      rankPosition: 1,
      offerOutcomeCode: "excluded_structural_conflict",
    },
  ]) {
    seedAggregateOffer(database, { ids, ...offer });
  }
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET participating_team_count = 4,
          status = 'rapid',
          allocation_completed_at_ms = @completedAtMs,
          updated_at_ms = @completedAtMs,
          version = 4
      WHERE id = @fadId
    `)
    .run({
      fadId: ids.fad,
      completedAtMs: NOW_MS,
    });
  return fixture;
}

function createLifecycle(database, writer) {
  const lifecycleRepository =
    createSqliteFreeAgentDraftRepository({
      database,
      transitionWriter: writer,
    });
  return Object.freeze({
    lifecycleRepository,
    service:
      createFreeAgentDraftAllocationLifecycleService({
        lifecycleRepository,
        clock: { nowMs: () => NOW_MS },
      }),
  });
}

function count(database, tableName, where = "1 = 1", parameters = {}) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName} WHERE ${where}`
    )
    .get(parameters).count;
}

describe("SQLite FAD allocation lifecycle writer", () => {
  let database;
  let temporaryRoot;
  let zero;
  let nonempty;
  let rollback;
  let correction;
  let aggregate;
  let aggregateFixture;
  let writer;
  let lifecycle;

  before(() => {
    temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-fad-allocation-lifecycle-")
    );
    const connection = openDatabase({
      databasePath: path.join(temporaryRoot, "league.sqlite3"),
      environment: "test",
    });
    database = connection.database;
    applyMigrations({
      database,
      migrations: discoverMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
      }),
      applicationBuildId:
        "fad-allocation-lifecycle-writer-foundation",
      now: () => 1,
    });
    database.pragma("foreign_keys = OFF");
    const triggers = captureAndDropTriggers(database);
    zero = scopeIds(10_000);
    nonempty = scopeIds(20_000);
    rollback = scopeIds(30_000);
    correction = scopeIds(40_000);
    aggregate = scopeIds(50_000);
    seedRootFoundation(database, zero, "Zero Allocation");
    seedCard(database, zero, { candidate: false });
    seedRootFoundation(database, nonempty, "Pending Allocation");
    seedCard(database, nonempty, { candidate: true });
    seedRootFoundation(database, rollback, "Rollback Allocation");
    seedCard(database, rollback, { candidate: false });
    seedRootFoundation(database, correction, "Correction Quarantine");
    seedCard(database, correction, { candidate: true });
    seedCorrectionCompletionEvidence(database, correction);
    seedRootFoundation(database, aggregate, "Aggregate Results");
    seedCard(database, aggregate, { candidate: false });
    aggregateFixture = seedAggregateProjection(database, aggregate);
    restoreTriggers(database, triggers);
    writer =
      createSqliteFreeAgentDraftAllocationLifecycleWriter({
        database,
      });
    lifecycle = createLifecycle(database, writer);
  });

  after(() => {
    if (database?.open) database.close();
    if (temporaryRoot) {
      fs.rmSync(temporaryRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  test("requires the locked rapid barrier and returns a canonical actionable-first durable scan", () => {
    const scanned = writer.listCandidates({
      nowMs: NOW_MS,
      limit: 10,
    });
    assert.equal(scanned.length, 4);
    assert.deepEqual(
      scanned.map(({ fadId }) => fadId),
      [
        zero.fad,
        nonempty.fad,
        rollback.fad,
        correction.fad,
      ].sort()
    );
    for (const root of scanned) {
      assert.ok(Object.isFrozen(root));
      assert.ok(Object.isFrozen(root.schedule));
      assert.ok(
        ["deadline_locked", "allocating"].includes(
          root.status
        )
      );
      assert.equal(root.schedule.version, 1);
    }
    assert.throws(
      () => writer.listCandidates({ nowMs: NOW_MS, limit: 101 }),
      (error) =>
        error.code === REPOSITORY_ERROR_CODES.argumentInvalid
    );

    const rootTriggers = captureAndDropTriggers(
      database,
      "free_agent_drafts"
    );
    const barrier = rootTriggers.find(
      ({ name }) =>
        name ===
        "free_agent_drafts_allocation_completion_barrier"
    );
    assert.ok(barrier);
    assert.throws(
      () =>
        createSqliteFreeAgentDraftAllocationLifecycleWriter({
          database,
        }),
      (error) =>
        error.code ===
        REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    restoreTriggers(database, rootTriggers);
  });

  test("rejects direct transition hooks before any write outside the lifecycle transaction", () => {
    const notificationCount = count(database, "notifications");
    const outboxCount = count(database, "outbox_events");
    for (const invoke of [
      () => writer.beforeTransition({}),
      () => writer.afterTransition({}),
    ]) {
      assert.throws(
        invoke,
        (error) =>
          error.code ===
            REPOSITORY_ERROR_CODES.argumentInvalid &&
          error.details?.reasonCode ===
            "TRANSACTION_REQUIRED"
      );
    }
    assert.equal(count(database, "notifications"), notificationCount);
    assert.equal(count(database, "outbox_events"), outboxCount);
  });

  test("starts nonempty durable work, publishes one root invalidation, replays exactly, and then waits", () => {
    const scanned = writer
      .listCandidates({ nowMs: NOW_MS, limit: 10 })
      .find(({ fadId }) => fadId === nonempty.fad);
    const started = lifecycle.service.coordinateRoot(scanned);
    assert.equal(started.toStatus, "allocating");
    assert.equal(started.outcome, "transitioned");
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, version, allocation_completed_at_ms
          FROM free_agent_drafts WHERE id = ?
        `)
        .get(nonempty.fad),
      {
        status: "allocating",
        version: 3,
        allocation_completed_at_ms: null,
      }
    );
    assert.equal(
      count(
        database,
        "outbox_events",
        "league_id = @leagueId",
        { leagueId: nonempty.league }
      ),
      1
    );
    assert.equal(
      count(
        database,
        "notifications",
        "league_id = @leagueId",
        { leagueId: nonempty.league }
      ),
      0
    );

    const replayed = lifecycle.service.coordinateRoot(scanned);
    assert.equal(replayed.outcome, "replayed");
    assert.equal(
      count(
        database,
        "outbox_events",
        "league_id = @leagueId",
        { leagueId: nonempty.league }
      ),
      1
    );
    const waitingRoot = writer
      .listCandidates({ nowMs: NOW_MS, limit: 10 })
      .find(({ fadId }) => fadId === nonempty.fad);
    const waiting = lifecycle.service.coordinateRoot(waitingRoot);
    assert.equal(waiting.outcome, "waiting");
    assert.equal(waiting.toStatus, null);
  });

  test("moves zero allocations directly to rapid and notifies the current manager with a zero-count aggregate exactly once", () => {
    const scanned = writer
      .listCandidates({ nowMs: NOW_MS, limit: 10 })
      .find(({ fadId }) => fadId === zero.fad);
    const completed = lifecycle.service.coordinateRoot(scanned);
    assert.equal(completed.toStatus, "rapid");
    assert.equal(completed.outcome, "transitioned");
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, version, allocation_completed_at_ms
          FROM free_agent_drafts WHERE id = ?
        `)
        .get(zero.fad),
      {
        status: "rapid",
        version: 3,
        allocation_completed_at_ms: NOW_MS,
      }
    );
    const notifications = database
      .prepare(`
        SELECT * FROM notifications
        WHERE league_id = ?
        ORDER BY id
      `)
      .all(zero.league);
    assert.equal(notifications.length, 1);
    assert.equal(
      notifications[0].event_type,
      "fad_automatic_result"
    );
    assert.deepEqual(
      JSON.parse(notifications[0].message_data_json),
      {
        leagueId: zero.league,
        seasonId: zero.season,
        fadId: zero.fad,
        teamId: zero.team,
        automaticWins: 0,
        losses: 0,
        restrictedPending: 0,
        invalidOffers: 0,
        destination: {
          kind: "fad_results",
          leagueId: zero.league,
          fadId: zero.fad,
        },
      }
    );
    assert.equal(
      count(
        database,
        "outbox_events",
        "league_id = @leagueId",
        { leagueId: zero.league }
      ),
      2
    );
    assert.equal(
      lifecycle.service.coordinateRoot(scanned).outcome,
      "replayed"
    );
    assert.equal(
      count(
        database,
        "notifications",
        "league_id = @leagueId",
        { leagueId: zero.league }
      ),
      1
    );
  });

  test("completes an allocating correction quarantine only with current offer, state, and linked recovery evidence", () => {
    const scanned = writer
      .listCandidates({ nowMs: NOW_MS, limit: 10 })
      .find(({ fadId }) => fadId === correction.fad);
    assert.equal(scanned.status, "allocating");
    assert.equal(scanned.allocationCount, 1);
    assert.equal(scanned.pendingAllocationCount, 0);

    const completed = lifecycle.service.coordinateRoot(scanned);
    assert.equal(completed.outcome, "transitioned");
    assert.equal(completed.toStatus, "rapid");
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, version, allocation_completed_at_ms
          FROM free_agent_drafts WHERE id = ?
        `)
        .get(correction.fad),
      {
        status: "rapid",
        version: 4,
        allocation_completed_at_ms: NOW_MS,
      }
    );
    const message = JSON.parse(
      database
        .prepare(`
          SELECT message_data_json
          FROM notifications
          WHERE league_id = ?
        `)
        .get(correction.league).message_data_json
    );
    assert.deepEqual(
      {
        automaticWins: message.automaticWins,
        losses: message.losses,
        restrictedPending: message.restrictedPending,
        invalidOffers: message.invalidOffers,
      },
      {
        automaticWins: 0,
        losses: 0,
        restrictedPending: 0,
        invalidOffers: 0,
      }
    );
  });

  test("publishes exact aggregate counts to current transferred managers and deduplicates one user managing multiple teams", () => {
    const command = {
      leagueId: aggregate.league,
      seasonId: aggregate.season,
      fadId: aggregate.fad,
      expectedVersion: 3,
      fromStatus: "allocating",
      toStatus: "rapid",
      occurredAtMs: NOW_MS,
      schedule: {
        operationId: aggregate.schedule,
        version: 1,
        weekOneMatchupWeekId: aggregate.week,
        weekOneStartsAtMs: WEEK_ONE_AT_MS,
      },
      scheduleRecoveryId: null,
    };
    const updated = {
      id: aggregate.fad,
      leagueId: aggregate.league,
      seasonId: aggregate.season,
      status: "rapid",
      version: 4,
      updatedAtMs: NOW_MS,
      allocationCompletedAtMs: NOW_MS,
    };
    const publish = database.transaction(() =>
      writer.afterTransition({
        effectiveCommand: command,
        existing: {},
        updated,
      })
    );
    const result = publish.immediate();
    assert.equal(result.notificationIds.length, 3);
    assert.equal(result.outboxEventIds.length, 4);

    const messages = database
      .prepare(`
        SELECT user_id, deduplication_key, message_data_json
        FROM notifications
        WHERE league_id = ?
        ORDER BY deduplication_key
      `)
      .all(aggregate.league)
      .map((row) => ({
        userId: row.user_id,
        deduplicationKey: row.deduplication_key,
        message: JSON.parse(row.message_data_json),
      }));
    assert.equal(messages.length, 3);
    const byTeam = new Map(
      messages.map((item) => [item.message.teamId, item])
    );
    assert.deepEqual(
      {
        userId: byTeam.get(aggregate.team).userId,
        automaticWins:
          byTeam.get(aggregate.team).message.automaticWins,
        losses: byTeam.get(aggregate.team).message.losses,
        restrictedPending:
          byTeam.get(aggregate.team).message.restrictedPending,
        invalidOffers:
          byTeam.get(aggregate.team).message.invalidOffers,
      },
      {
        userId: aggregate.user,
        automaticWins: 1,
        losses: 0,
        restrictedPending: 1,
        invalidOffers: 0,
      }
    );
    assert.deepEqual(
      {
        userId: byTeam.get(aggregateFixture.team2).userId,
        automaticWins:
          byTeam.get(aggregateFixture.team2).message.automaticWins,
        losses:
          byTeam.get(aggregateFixture.team2).message.losses,
        restrictedPending:
          byTeam.get(aggregateFixture.team2).message.restrictedPending,
        invalidOffers:
          byTeam.get(aggregateFixture.team2).message.invalidOffers,
      },
      {
        userId: aggregateFixture.user2,
        automaticWins: 0,
        losses: 1,
        restrictedPending: 1,
        invalidOffers: 2,
      }
    );
    assert.deepEqual(
      {
        userId: byTeam.get(aggregateFixture.team3).userId,
        automaticWins:
          byTeam.get(aggregateFixture.team3).message.automaticWins,
        losses:
          byTeam.get(aggregateFixture.team3).message.losses,
        restrictedPending:
          byTeam.get(aggregateFixture.team3).message.restrictedPending,
        invalidOffers:
          byTeam.get(aggregateFixture.team3).message.invalidOffers,
      },
      {
        userId: aggregate.user,
        automaticWins: 0,
        losses: 0,
        restrictedPending: 0,
        invalidOffers: 0,
      }
    );
    assert.equal(byTeam.has(aggregateFixture.team4), false);
    assert.equal(
      messages.some(
        ({ userId }) => userId === aggregateFixture.oldUser
      ),
      false
    );
    for (const item of messages) {
      assert.equal(
        item.deduplicationKey,
        `fad:${aggregate.fad}:automatic-result:` +
          `${item.message.teamId}:${item.userId}`
      );
      assert.equal(item.message.destination.kind, "fad_results");
    }
    assert.equal(
      messages.filter(({ userId }) => userId === aggregate.user)
        .length,
      2
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT audience.user_id
          FROM outbox_event_audiences AS audience
          JOIN outbox_events AS event
            ON event.league_id = audience.league_id
           AND event.id = audience.outbox_event_id
          WHERE event.league_id = ?
            AND event.event_type = 'notification.created'
          ORDER BY audience.user_id
        `)
        .all(aggregate.league)
        .map(({ user_id: userId }) => userId),
      [aggregate.user, aggregateFixture.user2].sort()
        .flatMap((userId) =>
          userId === aggregate.user
            ? [userId, userId]
            : [userId]
        )
    );
    const notificationPublications = database
      .prepare(`
        SELECT event.id, event.league_id, event.aggregate_type,
               event.aggregate_id, event.payload_json,
               audience.user_id, notification.message_data_json
        FROM outbox_events AS event
        JOIN outbox_event_audiences AS audience
          ON audience.league_id = event.league_id
         AND audience.outbox_event_id = event.id
        JOIN notifications AS notification
          ON notification.league_id = event.league_id
         AND notification.id = event.aggregate_id
        WHERE event.league_id = ?
          AND event.event_type = 'notification.created'
        ORDER BY event.aggregate_id
      `)
      .all(aggregate.league);
    assert.equal(notificationPublications.length, 3);
    for (const publication of notificationPublications) {
      const payload = JSON.parse(publication.payload_json);
      const message = JSON.parse(publication.message_data_json);
      assert.equal(publication.aggregate_type, "notification");
      assert.equal(payload.eventId, publication.id);
      assert.equal(payload.type, "notification.created");
      assert.equal(payload.leagueId, publication.league_id);
      assert.equal(payload.resourceId, publication.aggregate_id);
      assert.equal(payload.version, 1);
      assert.equal(payload.reasonCode, "allocation_changed");
      assert.equal(payload.occurredAt, NOW_MS);
      assert.equal(payload.related.fadId, aggregate.fad);
      assert.equal(payload.related.teamId, message.teamId);
      assert.deepEqual(
        Object.keys(payload.related).sort(),
        [
          "allocationId",
          "auctionId",
          "cardId",
          "fadId",
          "nominationQueueId",
          "recoveryId",
          "scheduleRecoveryOperationId",
          "teamId",
        ]
      );
    }
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(DISTINCT event_type) AS count
          FROM notifications
          WHERE league_id = ?
        `)
        .get(aggregate.league).count,
      1
    );

    const replayed = publish.immediate();
    assert.deepEqual(replayed, result);
    assert.equal(
      count(
        database,
        "notifications",
        "league_id = @leagueId",
        { leagueId: aggregate.league }
      ),
      3
    );
    assert.equal(
      count(
        database,
        "outbox_events",
        "league_id = @leagueId",
        { leagueId: aggregate.league }
      ),
      4
    );
  });

  test("rolls the root, notification, and both outbox events back together on a late failure", () => {
    const forced = new Error("forced allocation lifecycle rollback");
    const rollbackWriter =
      createSqliteFreeAgentDraftAllocationLifecycleWriter({
        database,
        beforeCommit() {
          throw forced;
        },
      });
    const rollbackLifecycle = createLifecycle(
      database,
      rollbackWriter
    );
    const scanned = rollbackWriter
      .listCandidates({ nowMs: NOW_MS, limit: 10 })
      .find(({ fadId }) => fadId === rollback.fad);
    assert.throws(
      () => rollbackLifecycle.service.coordinateRoot(scanned),
      (error) => error.cause === forced || error === forced
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, version, allocation_completed_at_ms
          FROM free_agent_drafts WHERE id = ?
        `)
        .get(rollback.fad),
      {
        status: "deadline_locked",
        version: 2,
        allocation_completed_at_ms: null,
      }
    );
    assert.equal(
      count(
        database,
        "notifications",
        "league_id = @leagueId",
        { leagueId: rollback.league }
      ),
      0
    );
    assert.equal(
      count(
        database,
        "outbox_events",
        "league_id = @leagueId",
        { leagueId: rollback.league }
      ),
      0
    );
  });

  test("ignores an incomplete snapshot row for allocation-completion evidence and publishes zero results", () => {
    const partial = scopeIds(60_000);
    const triggers = captureAndDropTriggers(database);
    database.pragma("foreign_keys = OFF");
    seedRootFoundation(
      database,
      partial,
      "Partial Candidate"
    );
    seedCard(database, partial, {
      candidate: true,
    });
    database.prepare(`
      UPDATE candidate_card_snapshot_entries
      SET proposed_term_years = NULL,
          proposed_aav_cents = NULL,
          eligibility_status = 'invalid',
          validation_code =
            'CANDIDATE_CONTRACT_INCOMPLETE'
      WHERE league_id = @leagueId
        AND fad_id = @fadId
        AND occupant_kind = 'candidate'
    `).run({
      leagueId: partial.league,
      fadId: partial.fad,
    });
    database.prepare(`
      DELETE FROM job_runs
      WHERE league_id = @leagueId
        AND job_type = 'fad_allocation'
    `).run({ leagueId: partial.league });
    database.prepare(`
      DELETE FROM free_agent_draft_player_allocations
      WHERE league_id = @leagueId
    `).run({ leagueId: partial.league });
    restoreTriggers(database, triggers);
    database.pragma("foreign_keys = ON");

    const scanned = writer
      .listCandidates({ nowMs: NOW_MS, limit: 20 })
      .find(({ fadId }) => fadId === partial.fad);
    assert.equal(scanned.allocationCount, 0);
    const completed =
      lifecycle.service.coordinateRoot(scanned);
    assert.equal(completed.toStatus, "rapid");
    assert.equal(completed.outcome, "transitioned");
    assert.deepEqual(
      JSON.parse(
        database.prepare(`
          SELECT message_data_json
          FROM notifications
          WHERE league_id = ?
            AND event_type = 'fad_automatic_result'
        `).get(partial.league).message_data_json
      ),
      {
        leagueId: partial.league,
        seasonId: partial.season,
        fadId: partial.fad,
        teamId: partial.team,
        automaticWins: 0,
        losses: 0,
        restrictedPending: 0,
        invalidOffers: 0,
        destination: {
          kind: "fad_results",
          leagueId: partial.league,
          fadId: partial.fad,
        },
      }
    );
  });
});
