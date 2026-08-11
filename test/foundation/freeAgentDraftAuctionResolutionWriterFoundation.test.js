"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  hashFreeAgentDraftRecoveryActionRequest,
  serializeFreeAgentDraftRecoveryActionRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftRecoveryPolicy"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketInvalidation,
} = require("../../src/domain/leagues/socketInvalidation");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE,
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE,
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_WRITER_METHODS,
  createSqliteFreeAgentDraftAuctionResolutionWriter,
  isFreeAgentDraftAuctionResolutionTerminalFailure,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftAuctionResolutionWriter"
);
const {
  createSqliteRestrictedNoImprovementFallbackWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRestrictedNoImprovementFallbackWriter"
);
const {
  createSqliteLeagueOutboxWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxWriter"
);
const {
  createSqliteFreeAgentDraftRecoveryActionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRecoveryActionRepository"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 86_400_000;
const WEEK_ONE_AT_MS = Date.parse("2026-10-05T07:00:00.000Z");
const DEADLINE_AT_MS = WEEK_ONE_AT_MS - 7 * DAY_MS;
const OPENED_AT_MS = DEADLINE_AT_MS - 30 * DAY_MS;
const AUCTION_OPENS_AT_MS = DEADLINE_AT_MS + DAY_MS;
const RESOLVES_AT_MS = AUCTION_OPENS_AT_MS + DAY_MS;
const EXECUTES_AT_MS = RESOLVES_AT_MS;
const LEASE_EXPIRES_AT_MS = EXECUTES_AT_MS + 60 * 60 * 1000;
const LEASE_OWNER = "fad-resolution-foundation";

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
  rolloverThree: uuid(11),
  restrictedAuction: uuid(12),
  fallbackAuction: uuid(13),
  draw: uuid(14),
  resolutionJob: uuid(15),
  sourceStateEvent: uuid(16),
  leaseToken: uuid(17),
  commissionerUser: uuid(18),
  commissionerMembership: uuid(19),
});

function manager(index) {
  const base = 100 + index * 30;
  return Object.freeze({
    user: uuid(base + 1),
    membership: uuid(base + 2),
    team: uuid(base + 3),
    assignment: uuid(base + 4),
    fadTeam: uuid(base + 5),
    card: uuid(base + 6),
    entry: uuid(base + 7),
    openedRevision: uuid(base + 8),
    candidateRevision: uuid(base + 9),
    lockedRevision: uuid(base + 10),
    snapshot: uuid(base + 11),
    snapshotEntry: uuid(base + 12),
    participant: uuid(base + 13),
    sourceOfferEvent: uuid(base + 14),
    bid: uuid(base + 15),
    bidEvent: uuid(base + 16),
  });
}

const MANAGERS = Object.freeze([manager(1), manager(2)]);

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  try {
    database.prepare(`
      INSERT INTO ${tableName} (${fields.join(", ")})
      VALUES (${fields.map((field) => `@${field}`).join(", ")})
    `).run(values);
  } catch (error) {
    throw new Error(`${tableName}: ${error.message}`);
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
  for (const trigger of triggers) database.exec(trigger.sql);
}

function seedBase(database) {
  insert(database, "leagues", {
    id: IDS.league,
    name: "FAD Resolution League",
    name_normalized: "fad resolution league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: IDS.season,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "users", {
    id: IDS.commissionerUser,
    email_normalized: "resolution-commissioner@example.test",
    email_display: "resolution-commissioner@example.test",
    display_name: "Resolution Commissioner",
    display_name_normalized: "resolution commissioner",
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: IDS.commissionerMembership,
    league_id: IDS.league,
    user_id: IDS.commissionerUser,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = @membershipId
    WHERE id = @leagueId
  `).run({
    leagueId: IDS.league,
    membershipId: IDS.commissionerMembership,
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
    regular_season_ends_at_ms: WEEK_ONE_AT_MS + 20 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms: WEEK_ONE_AT_MS + 17 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms: WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
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
    last_name: "Resolver",
    full_name: "Riley Resolver",
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
    participating_team_count: MANAGERS.length,
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
    allocation_completed_at_ms: DEADLINE_AT_MS + 1_000,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 4,
  });
  for (const [index, values] of [
    {
      id: IDS.rolloverOne,
      sequence: 1,
      predecessor: null,
      opensAtMs: DEADLINE_AT_MS,
      resolvesAtMs: AUCTION_OPENS_AT_MS,
    },
    {
      id: IDS.rolloverTwo,
      sequence: 2,
      predecessor: IDS.rolloverOne,
      opensAtMs: AUCTION_OPENS_AT_MS,
      resolvesAtMs: RESOLVES_AT_MS,
    },
    {
      id: IDS.rolloverThree,
      sequence: 3,
      predecessor: IDS.rolloverTwo,
      opensAtMs: RESOLVES_AT_MS,
      resolvesAtMs: RESOLVES_AT_MS + DAY_MS,
    },
  ].entries()) {
    insert(database, "free_agent_draft_rollovers", {
      id: values.id,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      sequence: values.sequence,
      window_kind: "initial",
      predecessor_rollover_id: values.predecessor,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: values.opensAtMs,
      creation_cutoff_at_ms: values.resolvesAtMs - 60 * 60 * 1000,
      rolls_over_at_ms: values.resolvesAtMs,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: OPENED_AT_MS + index,
      updated_at_ms: OPENED_AT_MS + index,
      version: 1,
    });
  }
}

function seedManager(database, value, index) {
  insert(database, "users", {
    id: value.user,
    email_normalized: `resolution-${index}@example.test`,
    email_display: `resolution-${index}@example.test`,
    display_name: `Resolution Manager ${index}`,
    display_name_normalized: `resolution manager ${index}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: value.membership,
    league_id: IDS.league,
    user_id: value.user,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "teams", {
    id: value.team,
    league_id: IDS.league,
    name: `Resolution Team ${index}`,
    name_normalized: `resolution team ${index}`,
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
    id: value.assignment,
    league_id: IDS.league,
    team_id: value.team,
    user_id: value.user,
    membership_id: value.membership,
    assigned_by_user_id: value.user,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: 1,
    accepted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "free_agent_draft_teams", {
    id: value.fadTeam,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: value.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  });
  insert(database, "candidate_cards", {
    id: value.card,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: value.team,
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
    id: value.entry,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: value.card,
    team_id: value.team,
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
    created_by_user_id: value.user,
    created_by_membership_id: value.membership,
    created_by_authority: "manager",
    last_edited_by_user_id: value.user,
    last_edited_by_membership_id: value.membership,
    last_edited_by_authority: "manager",
    created_at_ms: OPENED_AT_MS + index,
    updated_at_ms: OPENED_AT_MS + index,
    version: 1,
  });
  for (const revision of [
    {
      id: value.openedRevision,
      version: 1,
      action: "card_opened",
      entryId: null,
      playerId: null,
      actorUserId: null,
      actorMembershipId: null,
      actorAuthority: "system",
      occurredAtMs: OPENED_AT_MS,
    },
    {
      id: value.candidateRevision,
      version: 2,
      action: "candidate_added",
      entryId: value.entry,
      playerId: IDS.player,
      actorUserId: value.user,
      actorMembershipId: value.membership,
      actorAuthority: "manager",
      occurredAtMs: OPENED_AT_MS + index,
    },
    {
      id: value.lockedRevision,
      version: 3,
      action: "deadline_locked",
      entryId: null,
      playerId: null,
      actorUserId: null,
      actorMembershipId: null,
      actorAuthority: "system",
      occurredAtMs: DEADLINE_AT_MS,
    },
  ]) {
    insert(database, "candidate_card_revisions", {
      id: revision.id,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      card_id: value.card,
      team_id: value.team,
      resulting_card_version: revision.version,
      action: revision.action,
      affected_entry_id: revision.entryId,
      player_id: revision.playerId,
      actor_user_id: revision.actorUserId,
      actor_membership_id: revision.actorMembershipId,
      actor_authority: revision.actorAuthority,
      before_evidence_json: "{}",
      after_evidence_json: "{}",
      potential_illegality_acknowledged: 0,
      warning_codes_json: "[]",
      occurred_at_ms: revision.occurredAtMs,
      created_at_ms: revision.occurredAtMs,
      version: 1,
    });
  }
  insert(database, "candidate_card_snapshots", {
    id: value.snapshot,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    card_id: value.card,
    team_id: value.team,
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
    id: value.snapshotEntry,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    snapshot_id: value.snapshot,
    card_id: value.card,
    team_id: value.team,
    row_kind: "slot",
    occupant_kind: "candidate",
    slot_group: "D",
    slot_number: 1,
    source_entry_id: value.entry,
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
    last_edited_by_user_id: value.user,
    last_edited_by_membership_id: value.membership,
    last_edited_by_authority: "manager",
    last_edited_at_ms: OPENED_AT_MS + index,
    created_at_ms: DEADLINE_AT_MS,
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
}

function seedAllocationEvidence(database, allocationVersion, status) {
  for (const value of MANAGERS) {
    insert(database, "free_agent_draft_allocation_events", {
      id: value.sourceOfferEvent,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: IDS.allocation,
      allocation_version: allocationVersion,
      player_id: IDS.player,
      event_kind: "offer_considered",
      snapshot_entry_id: value.snapshotEntry,
      team_id: value.team,
      offer_valid: 1,
      rank_position: 1,
      offer_outcome_code: "restricted_tied",
      decision_code: null,
      resulting_allocation_status: status,
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
          snapshotEntryId: value.snapshotEntry,
          teamId: value.team,
          totalValueCents: 600,
          termYears: 2,
          aavCents: 300,
        },
        offerValid: true,
        rankPosition: 1,
        outcomeCode: "restricted_tied",
      }),
      occurred_at_ms: AUCTION_OPENS_AT_MS,
      created_at_ms: AUCTION_OPENS_AT_MS,
      version: 1,
    });
  }
  insert(database, "free_agent_draft_allocation_events", {
    id: IDS.sourceStateEvent,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    allocation_version: allocationVersion,
    player_id: IDS.player,
    event_kind: status === "restricted_active"
      ? "restricted_state_changed"
      : "fallback_state_changed",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: status === "restricted_active"
      ? "exact_total_and_term_tie"
      : "restricted_no_improvement_fallback",
    resulting_allocation_status: status,
    contract_id: null,
    ownership_id: null,
    auction_id: status === "restricted_active"
      ? IDS.restrictedAuction
      : IDS.fallbackAuction,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: serializeCanonicalJsonV1({
      schemaVersion: 1,
      operation: "resolution_fixture",
      allocationId: IDS.allocation,
    }),
    occurred_at_ms: AUCTION_OPENS_AT_MS,
    created_at_ms: AUCTION_OPENS_AT_MS,
    version: 1,
  });
}

function seedBid(
  database,
  value,
  auctionId,
  { totalValueCents, termYears, starting = false }
) {
  const submittedAtMs = AUCTION_OPENS_AT_MS + 1_000;
  insert(database, "auction_bids", {
    id: value.bid,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: auctionId,
    team_id: value.team,
    submitted_by_user_id: value.user,
    total_value_cents: totalValueCents,
    term_years: termYears,
    lowest_offered_aav_cents: Math.round(totalValueCents / termYears),
    first_submitted_at_ms: submittedAtMs,
    last_edited_at_ms: submittedAtMs,
    edit_count: 0,
    status: "active",
    version: 1,
  });
  insert(database, "auction_events", {
    id: value.bidEvent,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: auctionId,
    bid_id: value.bid,
    team_id: value.team,
    actor_user_id: value.user,
    event_type: starting ? "auction_started" : "bid_submitted",
    metadata_json: JSON.stringify({
      actorAuthority: "manager",
      actorMembershipId: value.membership,
      totalValueCents,
      termYears,
      aavCents: Math.round(totalValueCents / termYears),
      editCount: 0,
    }),
    occurred_at_ms: submittedAtMs,
  });
}

function seedResolutionScenario(database, mode) {
  const standaloneOpenSource =
    mode.startsWith("direct_") || mode.startsWith("queued_");
  const queuedSource = mode.startsWith("queued_");
  const fallbackSource = mode.startsWith("fallback_");
  const auctionId = fallbackSource
    ? IDS.fallbackAuction
    : IDS.restrictedAuction;
  const allocationVersion = fallbackSource ? 4 : 3;
  const allocationStatus = fallbackSource
    ? "restricted_fallback_open"
    : "restricted_active";

  if (fallbackSource) {
    insert(database, "auctions", {
      id: IDS.restrictedAuction,
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.player,
      status: "no_winner",
      opened_at_ms: DEADLINE_AT_MS,
      resolves_at_ms: AUCTION_OPENS_AT_MS,
      opened_by_user_id: null,
      created_at_ms: DEADLINE_AT_MS,
      updated_at_ms: AUCTION_OPENS_AT_MS,
      version: 3,
    });
  }
  insert(database, "auctions", {
    id: auctionId,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    status: "open",
    opened_at_ms: AUCTION_OPENS_AT_MS,
    resolves_at_ms: RESOLVES_AT_MS,
    opened_by_user_id: null,
    created_at_ms: AUCTION_OPENS_AT_MS,
    updated_at_ms: AUCTION_OPENS_AT_MS,
    version: 1,
  });
  if (!standaloneOpenSource) {
    insert(database, "free_agent_draft_player_allocations", {
      id: IDS.allocation,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      player_id: IDS.player,
      status: allocationStatus,
      decision_code: fallbackSource
        ? "restricted_no_improvement_fallback"
        : "exact_total_and_term_tie",
      winning_snapshot_entry_id: null,
      winning_team_id: null,
      contract_id: null,
      ownership_id: null,
      restricted_auction_id: IDS.restrictedAuction,
      fallback_open_auction_id: fallbackSource
        ? IDS.fallbackAuction
        : null,
      restricted_minimum_total_cents: 600,
      restricted_minimum_term_years: 2,
      restricted_minimum_aav_cents: 300,
      accounted_at_ms: null,
      last_error_code: null,
      created_at_ms: DEADLINE_AT_MS,
      updated_at_ms: AUCTION_OPENS_AT_MS,
      version: allocationVersion,
    });
  }
  insert(database, "auction_contexts", {
    id: auctionId,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: auctionId,
    source_kind: fallbackSource || standaloneOpenSource
      ? "fad_open_rapid"
      : "fad_restricted",
    fad_id: IDS.fad,
    fad_rollover_id: IDS.rolloverTwo,
    fad_allocation_id: standaloneOpenSource ? null : IDS.allocation,
    fad_origin: standaloneOpenSource
      ? queuedSource
        ? "queued_nomination"
        : "manager_nomination"
      : fallbackSource
        ? "restricted_no_improvement_fallback"
        : "candidate_tie_restricted",
    created_at_ms: AUCTION_OPENS_AT_MS,
  });
  if (mode === "restricted_winner") {
    seedBid(database, MANAGERS[0], auctionId, {
      totalValueCents: 900,
      termYears: 2,
    });
  } else if (mode === "restricted_tie") {
    for (const value of MANAGERS) {
      seedBid(database, value, auctionId, {
        totalValueCents: 900,
        termYears: 2,
      });
    }
  } else if (mode === "restricted_removed") {
    seedBid(database, MANAGERS[0], auctionId, {
      totalValueCents: 1_200,
      termYears: 2,
    });
    seedBid(database, MANAGERS[1], auctionId, {
      totalValueCents: 900,
      termYears: 2,
    });
  } else if (mode === "fallback_winner") {
    seedBid(database, MANAGERS[0], auctionId, {
      totalValueCents: 600,
      termYears: 2,
    });
  } else if (mode === "direct_winner") {
    seedBid(database, MANAGERS[0], auctionId, {
      totalValueCents: 600,
      termYears: 2,
      starting: true,
    });
  } else if (mode === "queued_tie") {
    seedBid(database, MANAGERS[0], auctionId, {
      totalValueCents: 600,
      termYears: 2,
      starting: true,
    });
    seedBid(database, MANAGERS[1], auctionId, {
      totalValueCents: 600,
      termYears: 2,
    });
  }
  if (!fallbackSource && !standaloneOpenSource) {
    for (const [index, value] of MANAGERS.entries()) {
      const removed = mode === "restricted_removed" && index === 0;
      const hasImprovement =
        (mode === "restricted_winner" && index === 0) ||
        mode === "restricted_tie" ||
        (mode === "restricted_removed" && index === 1);
      insert(database, "free_agent_draft_auction_participants", {
        id: value.participant,
        league_id: IDS.league,
        season_id: IDS.season,
        fad_id: IDS.fad,
        allocation_id: IDS.allocation,
        auction_id: auctionId,
        team_id: value.team,
        status: removed ? "removed" : "active",
        source_snapshot_entry_id: value.snapshotEntry,
        originating_candidate_revision_id: value.candidateRevision,
        minimum_total_value_cents: 600,
        minimum_term_years: 2,
        minimum_aav_cents: 300,
        active_improvement_bid_id: hasImprovement ? value.bid : null,
        manager_edit_limit: 1,
        cooldown_duration_ms: 75 * 60 * 1000,
        first_improvement_at_ms: hasImprovement
          ? AUCTION_OPENS_AT_MS + 1_000
          : null,
        current_cooldown_anchor_at_ms: hasImprovement
          ? AUCTION_OPENS_AT_MS + 1_000
          : null,
        improvement_committed_at_ms: hasImprovement
          ? AUCTION_OPENS_AT_MS + 1_000
          : null,
        originating_actor_user_id: value.user,
        originating_actor_membership_id: value.membership,
        originating_actor_authority: "manager",
        removed_by_user_id: removed ? value.user : null,
        removed_by_membership_id: removed ? value.membership : null,
        removed_authority: removed ? "commissioner" : null,
        removal_reason: removed
          ? "Removed before the resolution boundary."
          : null,
        removed_at_ms: removed ? AUCTION_OPENS_AT_MS + 2_000 : null,
        created_at_ms: AUCTION_OPENS_AT_MS,
        updated_at_ms: removed
          ? AUCTION_OPENS_AT_MS + 2_000
          : hasImprovement
          ? AUCTION_OPENS_AT_MS + 1_000
          : AUCTION_OPENS_AT_MS,
        version: removed || hasImprovement ? 2 : 1,
      });
    }
  }
  const nonceBytes = Buffer.alloc(32, fallbackSource ? 0x6b : 0x5a);
  const commitment = createFreeAgentDraftAuctionDrawCommitment({
    auctionId,
    nonceBytes,
  });
  insert(database, "free_agent_draft_draws", {
    id: IDS.draw,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: standaloneOpenSource ? null : IDS.allocation,
    auction_id: auctionId,
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
    created_at_ms: AUCTION_OPENS_AT_MS,
    updated_at_ms: AUCTION_OPENS_AT_MS,
    version: 1,
  });
  const key = `auction:${auctionId}:${RESOLVES_AT_MS}`;
  insert(database, "job_runs", {
    id: IDS.resolutionJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: "auction.resolve.target",
    occurrence_key: key,
    scheduled_for_ms: RESOLVES_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: AUCTION_OPENS_AT_MS,
    updated_at_ms: AUCTION_OPENS_AT_MS,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: null,
  });
  if (!standaloneOpenSource) {
    seedAllocationEvidence(database, allocationVersion, allocationStatus);
  }

  return {
    auctionId,
    allocationId: standaloneOpenSource ? null : IDS.allocation,
    allocationVersion: standaloneOpenSource ? 0 : allocationVersion,
    key,
  };
}

function withDatabase(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-auction-resolution-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }),
    applicationBuildId:
      "fad-auction-resolution-writer-foundation",
    now: () => 1,
  });
  return connection.database;
}

function createWriter(database) {
  return createSqliteFreeAgentDraftAuctionResolutionWriter({
    database,
    candidateCardSummerSynchronizer: {
      synchronize() {},
    },
    restrictedFallbackWriter: {
      openFallback() {
        throw new Error("not used by the preparation foundation");
      },
    },
  });
}

function createScenarioRuntime(
  t,
  mode,
  { missingJob = false, beforeCommit } = {}
) {
  const database = withDatabase(t);
  const triggers = captureAndDropTriggers(database);
  seedBase(database);
  MANAGERS.forEach((value, index) =>
    seedManager(database, value, index + 1)
  );
  const scenario = seedResolutionScenario(database, mode);
  if (missingJob) {
    database.prepare("DELETE FROM job_runs WHERE id = @runId").run({
      runId: IDS.resolutionJob,
    });
  }
  restoreTriggers(database, triggers);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

  let nextId = 9_000;
  const createId = () => {
    nextId += 1;
    return uuid(nextId);
  };
  const sharedFallbackWriter =
    createSqliteRestrictedNoImprovementFallbackWriter({
      database,
      createDrawNonce: () => Buffer.alloc(32, 0x7c),
    });
  const summerCalls = [];
  const writer = createSqliteFreeAgentDraftAuctionResolutionWriter({
    database,
    createId,
    candidateCardSummerSynchronizer: {
      synchronize(command) {
        summerCalls.push(command);
      },
    },
    restrictedFallbackWriter: sharedFallbackWriter,
    beforeCommit,
  });
  return { database, writer, summerCalls, ...scenario };
}

function claimDue(runtime) {
  const due = runtime.writer.listDue({
    nowMs: EXECUTES_AT_MS,
    limit: 10,
  });
  assert.equal(due.length, 1);
  const claimed = runtime.writer.claimDue({
    leagueId: IDS.league,
    seasonId: IDS.season,
    auctionId: runtime.auctionId,
    occurrenceKey: runtime.key,
    expectedAuctionVersion: due[0].auctionVersion,
    expectedJobVersion: due[0].jobRunVersion ?? 0,
    nowMs: EXECUTES_AT_MS,
    jobExecution: {
      runId: IDS.resolutionJob,
      leaseOwner: LEASE_OWNER,
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    },
  });
  assert.equal(claimed.acquired, true);
  return claimed;
}

function claimedExecutionInput(runtime, claimed, overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: runtime.allocationId,
    playerId: IDS.player,
    rolloverId: IDS.rolloverTwo,
    auctionId: runtime.auctionId,
    occurrenceKey: runtime.key,
    expectedAuctionVersion: claimed.auctionVersion,
    expectedAllocationVersion: claimed.allocationVersion,
    expectedJobVersion: claimed.jobRunVersion,
    resolvedAtMs: EXECUTES_AT_MS,
    jobExecution: {
      runId: IDS.resolutionJob,
      leaseOwner: LEASE_OWNER,
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    },
    ...overrides,
  };
}

function executeClaimed(runtime, claimed, overrides = {}) {
  let result;
  try {
    result = runtime.writer.executeClaimed(
      claimedExecutionInput(runtime, claimed, overrides)
    );
  } catch (error) {
    throw new Error(
      `${error.message} Cause: ${error.cause?.message || "none"}`
    );
  }
  return result;
}

function recordFailure(runtime, claimed, overrides = {}) {
  return runtime.writer.recordFailure({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: runtime.allocationId,
    playerId: IDS.player,
    rolloverId: IDS.rolloverTwo,
    auctionId: runtime.auctionId,
    occurrenceKey: runtime.key,
    expectedAuctionVersion: claimed.auctionVersion,
    expectedAllocationVersion: claimed.allocationVersion,
    expectedJobVersion: claimed.jobRunVersion,
    failedAtMs: EXECUTES_AT_MS,
    jobExecution: {
      runId: IDS.resolutionJob,
      leaseOwner: LEASE_OWNER,
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
    },
    ...overrides,
  });
}

function acceptResolutionRetry(runtime, acceptedAtMs, sequence = 0) {
  const body = {
    action: "retry_auction_resolution",
    resourceId: runtime.auctionId,
    reason: "Retry the exact failed FAD auction resolution.",
  };
  const request = {
    body,
    fadId: IDS.fad,
    leagueId: IDS.league,
  };
  return createSqliteFreeAgentDraftRecoveryActionRepository({
    database: runtime.database,
  }).acceptRecoveryAction({
    acceptedAtMs,
    actorAuthority: "commissioner",
    actorMembershipId: IDS.commissionerMembership,
    actorUserId: IDS.commissionerUser,
    body,
    clientKey:
      `fad-resolution-retry-${sequence}-${runtime.auctionId}`,
    commandResultId: uuid(7_810 + sequence * 10),
    fadId: IDS.fad,
    idempotencyExpiresAtMs: acceptedAtMs + DAY_MS,
    idempotencyRequestId: uuid(7_811 + sequence * 10),
    leagueId: IDS.league,
    requestJson: serializeFreeAgentDraftRecoveryActionRequest(request),
    requestSha256: hashFreeAgentDraftRecoveryActionRequest(request),
  });
}

function claimAndExecute(runtime) {
  const claimed = claimDue(runtime);
  return {
    claimed,
    result: executeClaimed(runtime, claimed),
  };
}

function assertRapidResultPublicationEvidence(
  runtime,
  result,
  expectedRecipients
) {
  const notifications = runtime.database.prepare(`
    SELECT *
    FROM notifications
    WHERE league_id = @leagueId
      AND event_type = 'fad_rapid_auction_result'
      AND related_record_id = @auctionId
    ORDER BY
      json_extract(message_data_json, '$.teamId'),
      user_id,
      id
  `).all({
    leagueId: IDS.league,
    auctionId: runtime.auctionId,
  });
  assert.deepEqual(
    result.evidence.notificationIds,
    notifications.map((notification) => notification.id)
  );
  assert.equal(notifications.length, expectedRecipients.length);
  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];
    const expected = expectedRecipients[index];
    assert.equal(notification.user_id, expected.userId);
    assert.equal(notification.related_feature, "auction");
    assert.equal(notification.delivery_status, "pending");
    assert.equal(notification.version, 1);
    const message = JSON.parse(notification.message_data_json);
    assert.deepEqual(message, {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      teamId: expected.teamId,
      allocationId: runtime.allocationId,
      auctionId: runtime.auctionId,
      playerId: IDS.player,
      outcomeCode: expected.outcomeCode,
      destination: {
        kind: "auction",
        leagueId: IDS.league,
        auctionId: runtime.auctionId,
      },
    });
    assert.equal(
      notification.deduplication_key,
      `fad:${IDS.fad}:rapid-result:${runtime.auctionId}:` +
        `${expected.teamId}:${expected.userId}`
    );
  }

  const fadVersion = runtime.database.prepare(`
    SELECT version
    FROM free_agent_drafts
    WHERE id = @fadId
  `).get({ fadId: IDS.fad }).version;
  const related = createEmptySocketRelated({
    fadId: IDS.fad,
    allocationId: runtime.allocationId,
    auctionId: runtime.auctionId,
  });
  const expectedOutboxes = [
    {
      id: result.evidence.outboxEventIds[0],
      eventType: "free_agent_draft.changed",
      aggregateType: "free_agent_draft",
      aggregateId: IDS.fad,
      version: fadVersion,
      reasonCode: "allocation_changed",
      audienceKind: "league",
      audienceUserId: null,
      related,
    },
    {
      id: result.evidence.outboxEventIds[1],
      eventType: "auction.changed",
      aggregateType: "auction",
      aggregateId: runtime.auctionId,
      version: result.auctionVersion,
      reasonCode: "auction_changed",
      audienceKind: "league",
      audienceUserId: null,
      related,
    },
    {
      id: result.evidence.outboxEventIds[2],
      eventType: "activity.created",
      aggregateType: "league_activity",
      aggregateId: result.evidence.activityId,
      version: 1,
      reasonCode: "auction_changed",
      audienceKind: "league",
      audienceUserId: null,
      related,
    },
    ...notifications.map((notification, index) => ({
      id: result.evidence.outboxEventIds[index + 3],
      eventType: "notification.created",
      aggregateType: "notification",
      aggregateId: notification.id,
      version: 1,
      reasonCode: "auction_changed",
      audienceKind: "user",
      audienceUserId: notification.user_id,
      related: createEmptySocketRelated({
        fadId: IDS.fad,
        teamId: expectedRecipients[index].teamId,
        allocationId: runtime.allocationId,
        auctionId: runtime.auctionId,
      }),
    })),
  ];
  assert.equal(
    result.evidence.outboxEventIds.length,
    expectedOutboxes.length
  );
  for (const expected of expectedOutboxes) {
    const publication = runtime.database.prepare(`
      SELECT
        event.*,
        audience.audience_kind,
        audience.team_id AS audience_team_id,
        audience.user_id AS audience_user_id
      FROM outbox_events AS event
      JOIN outbox_event_audiences AS audience
        ON audience.outbox_event_id = event.id
      WHERE event.id = @outboxEventId
    `).get({ outboxEventId: expected.id });
    assert.ok(publication);
    assert.equal(publication.event_type, expected.eventType);
    assert.equal(publication.aggregate_type, expected.aggregateType);
    assert.equal(publication.aggregate_id, expected.aggregateId);
    assert.equal(publication.audience_kind, expected.audienceKind);
    assert.equal(publication.audience_team_id, null);
    assert.equal(
      publication.audience_user_id,
      expected.audienceUserId
    );
    assert.deepEqual(
      JSON.parse(publication.payload_json),
      createSocketEventEnvelope({
        eventId: expected.id,
        type: expected.eventType,
        leagueId: IDS.league,
        resourceId: expected.aggregateId,
        version: expected.version,
        reasonCode: expected.reasonCode,
        occurredAt: EXECUTES_AT_MS,
        related: expected.related,
      })
    );
  }
}

function assertRestrictedFallbackPublicationEvidence(
  runtime,
  result,
  {
    delayed = false,
    expectedManagers,
    resolvedAtMs = EXECUTES_AT_MS,
  }
) {
  const fallback = runtime.database.prepare(`
    SELECT version, resolves_at_ms
    FROM auctions
    WHERE league_id = @leagueId
      AND id = @auctionId
  `).get({
    leagueId: IDS.league,
    auctionId: result.fallbackAuctionId,
  });
  assert.ok(fallback);

  const notifications = runtime.database.prepare(`
    SELECT *
    FROM notifications
    WHERE league_id = @leagueId
      AND event_type = 'fad_restricted_fallback_opened'
      AND related_feature = 'auction'
      AND related_record_id = @auctionId
      AND created_at_ms = @resolvedAtMs
    ORDER BY
      json_extract(message_data_json, '$.teamId'),
      user_id,
      id
  `).all({
    leagueId: IDS.league,
    auctionId: result.fallbackAuctionId,
    resolvedAtMs,
  });
  assert.deepEqual(
    result.evidence.notificationIds,
    notifications.map((notification) => notification.id)
  );
  assert.equal(notifications.length, expectedManagers.length);
  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];
    const manager = expectedManagers[index];
    assert.equal(notification.user_id, manager.user);
    assert.equal(notification.related_feature, "auction");
    assert.equal(
      notification.related_record_id,
      result.fallbackAuctionId
    );
    assert.equal(notification.delivery_status, "pending");
    assert.equal(notification.created_at_ms, resolvedAtMs);
    assert.equal(notification.delivered_at_ms, null);
    assert.equal(notification.read_at_ms, null);
    assert.equal(notification.version, 1);
    assert.deepEqual(
      JSON.parse(notification.message_data_json),
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: manager.team,
        allocationId: runtime.allocationId,
        auctionId: result.fallbackAuctionId,
        playerId: IDS.player,
        resolvesAtMs: fallback.resolves_at_ms,
        destination: {
          kind: "auction",
          leagueId: IDS.league,
          auctionId: result.fallbackAuctionId,
        },
      }
    );
    assert.equal(
      notification.deduplication_key,
      `fad:${IDS.fad}:fallback-opened:` +
        `${result.fallbackAuctionId}:${manager.team}:${manager.user}`
    );
  }

  const fadVersion = runtime.database.prepare(`
    SELECT version
    FROM free_agent_drafts
    WHERE id = @fadId
  `).get({ fadId: IDS.fad }).version;
  const fallbackRelated = createEmptySocketRelated({
    fadId: IDS.fad,
    allocationId: runtime.allocationId,
    auctionId: result.fallbackAuctionId,
  });
  const sourceRelated = createEmptySocketRelated({
    fadId: IDS.fad,
    allocationId: runtime.allocationId,
    auctionId: runtime.auctionId,
  });
  const expectedOutboxes = delayed
    ? [
        {
          id: result.evidence.outboxEventIds[0],
          eventType: "auction.changed",
          aggregateType: "auction",
          aggregateId: runtime.auctionId,
          version: result.auctionVersion,
          reasonCode: "auction_changed",
          audienceKind: "league",
          audienceUserId: null,
          related: sourceRelated,
        },
      ]
    : [
        {
          id: result.evidence.outboxEventIds[0],
          eventType: "free_agent_draft.changed",
          aggregateType: "free_agent_draft",
          aggregateId: IDS.fad,
          version: fadVersion,
          reasonCode: "fallback_opened",
          audienceKind: "league",
          audienceUserId: null,
          related: fallbackRelated,
        },
        {
          id: result.evidence.outboxEventIds[1],
          eventType: "auction.changed",
          aggregateType: "auction",
          aggregateId: result.fallbackAuctionId,
          version: fallback.version,
          reasonCode: "auction_changed",
          audienceKind: "league",
          audienceUserId: null,
          related: fallbackRelated,
        },
        {
          id: result.evidence.outboxEventIds[2],
          eventType: "auction.changed",
          aggregateType: "auction",
          aggregateId: runtime.auctionId,
          version: result.auctionVersion,
          reasonCode: "auction_changed",
          audienceKind: "league",
          audienceUserId: null,
          related: sourceRelated,
        },
        {
          id: result.evidence.outboxEventIds[3],
          eventType: "activity.created",
          aggregateType: "league_activity",
          aggregateId: result.evidence.activityId,
          version: 1,
          reasonCode: "fallback_opened",
          audienceKind: "league",
          audienceUserId: null,
          related: fallbackRelated,
        },
        ...notifications.map((notification, index) => ({
          id: result.evidence.outboxEventIds[index + 4],
          eventType: "notification.created",
          aggregateType: "notification",
          aggregateId: notification.id,
          version: 1,
          reasonCode: "fallback_opened",
          audienceKind: "user",
          audienceUserId: notification.user_id,
          related: createEmptySocketRelated({
            fadId: IDS.fad,
            teamId: expectedManagers[index].team,
            allocationId: runtime.allocationId,
            auctionId: result.fallbackAuctionId,
          }),
        })),
      ];
  assert.equal(
    result.evidence.outboxEventIds.length,
    expectedOutboxes.length
  );
  for (const expected of expectedOutboxes) {
    const publications = runtime.database.prepare(`
      SELECT
        event.*,
        audience.audience_kind,
        audience.team_id AS audience_team_id,
        audience.user_id AS audience_user_id
      FROM outbox_events AS event
      JOIN outbox_event_audiences AS audience
        ON audience.league_id = event.league_id
       AND audience.outbox_event_id = event.id
      WHERE event.league_id = @leagueId
        AND event.id = @outboxEventId
    `).all({
      leagueId: IDS.league,
      outboxEventId: expected.id,
    });
    assert.equal(publications.length, 1);
    const publication = publications[0];
    assert.equal(publication.event_type, expected.eventType);
    assert.equal(publication.aggregate_type, expected.aggregateType);
    assert.equal(publication.aggregate_id, expected.aggregateId);
    assert.equal(publication.created_at_ms, resolvedAtMs);
    assert.equal(publication.audience_kind, expected.audienceKind);
    assert.equal(publication.audience_team_id, null);
    assert.equal(
      publication.audience_user_id,
      expected.audienceUserId
    );
    assert.deepEqual(
      JSON.parse(publication.payload_json),
      createSocketEventEnvelope({
        eventId: expected.id,
        type: expected.eventType,
        leagueId: IDS.league,
        resourceId: expected.aggregateId,
        version: expected.version,
        reasonCode: expected.reasonCode,
        occurredAt: resolvedAtMs,
        related: expected.related,
      })
    );
  }
}

describe("SQLite FAD auction resolution writer foundation", () => {
  test("prepares only the uncomposed context-aware resolution surface against latest real SQLite", (t) => {
    const database = withDatabase(t);
    const writer = createWriter(database);

    assert.equal(
      FREE_AGENT_DRAFT_AUCTION_RESOLUTION_JOB_TYPE,
      "auction.resolve.target"
    );
    assert.deepEqual(
      Object.keys(writer).sort(),
      [...FREE_AGENT_DRAFT_AUCTION_RESOLUTION_WRITER_METHODS].sort()
    );
    assert.deepEqual(writer.listDue({ nowMs: 0, limit: 10 }), []);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  });

  test("atomically resolves a restricted winner with sole-bid pricing sentinel and exact replay", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "winner");
    assert.equal(result.winner.teamId, MANAGERS[0].team);
    assert.equal(result.winner.highestCompetingAavCents, null);
    assert.equal(result.winner.persistedSecondPriceInputCents, 0);
    assert.equal(result.drawReveal.selectionUsed, false);
    assert.equal(runtime.summerCalls.length, 1);
    assertRapidResultPublicationEvidence(runtime, result, [
      {
        teamId: MANAGERS[0].team,
        userId: MANAGERS[0].user,
        outcomeCode: "won",
      },
    ]);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          auction.status AS auction_status,
          allocation.status AS allocation_status,
          allocation.decision_code,
          resolution.second_price_input_cents,
          draw.version AS draw_version,
          job.status AS job_status,
          job.result_json
        FROM auctions AS auction
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = auction.league_id
         AND allocation.restricted_auction_id = auction.id
        JOIN auction_resolutions AS resolution
          ON resolution.league_id = auction.league_id
         AND resolution.auction_id = auction.id
        JOIN free_agent_draft_draws AS draw
          ON draw.league_id = auction.league_id
         AND draw.auction_id = auction.id
        JOIN job_runs AS job
          ON job.league_id = auction.league_id
         AND job.id = @jobRunId
        WHERE auction.id = @auctionId
      `).get({
        auctionId: IDS.restrictedAuction,
        jobRunId: IDS.resolutionJob,
      }),
      {
        auction_status: "resolved",
        allocation_status: "restricted_resolved",
        decision_code: "restricted_auction_result",
        second_price_input_cents: 0,
        draw_version: 2,
        job_status: "succeeded",
        result_json: JSON.stringify({
          auctionId: IDS.restrictedAuction,
          outcome: "resolved",
        }),
      }
    );
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: IDS.restrictedAuction,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.resolutionId, result.resolutionId);
    const triggers = captureAndDropTriggers(runtime.database);
    runtime.database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'correction_required',
          last_error_code = 'FAD_LATER_CORRECTION_REQUIRED',
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @allocationId
    `).run({
      allocationId: IDS.allocation,
      updatedAtMs: EXECUTES_AT_MS + 1,
    });
    restoreTriggers(runtime.database, triggers);
    const replayAfterDrift = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: IDS.restrictedAuction,
      occurrenceKey: runtime.key,
    });
    assert.equal(
      replayAfterDrift.allocationVersion,
      result.allocationVersion
    );
    assert.equal(
      replayAfterDrift.evidence.stateEventId,
      result.evidence.stateEventId
    );
    assert.equal(
      replayAfterDrift.resolutionId,
      result.resolutionId
    );
    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );
  });

  test("resolves from historical bid evidence but excludes an active-status manager membership ended before result publication", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    runtime.database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = @endedAtMs,
          updated_at_ms = @endedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND status = 'active'
    `).run({
      endedAtMs: EXECUTES_AT_MS - 1,
      membershipId: MANAGERS[0].membership,
    });

    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "winner");
    assert.equal(result.winner.teamId, MANAGERS[0].team);
    assertRapidResultPublicationEvidence(runtime, result, []);
    assert.equal(result.evidence.notificationIds.length, 0);
    assert.equal(result.evidence.outboxEventIds.length, 3);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_rapid_auction_result'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: MANAGERS[0].user,
      }).count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_event_audiences AS audience
        JOIN outbox_events AS event
          ON event.league_id = audience.league_id
         AND event.id = audience.outbox_event_id
        WHERE event.league_id = @leagueId
          AND event.created_at_ms = @createdAtMs
          AND audience.audience_kind = 'user'
          AND audience.user_id = @userId
      `).get({
        leagueId: IDS.league,
        createdAtMs: EXECUTES_AT_MS,
        userId: MANAGERS[0].user,
      }).count,
      0
    );

    runtime.database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = NULL,
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND status = 'active'
    `).run({
      membershipId: MANAGERS[0].membership,
      updatedAtMs: EXECUTES_AT_MS + 1,
    });
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evidence, result.evidence);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_rapid_auction_result'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: MANAGERS[0].user,
      }).count,
      0
    );
  });

  test("resolves from historical bid evidence but excludes an active-status manager membership with a future end timestamp", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    runtime.database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = @endedAtMs,
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND status = 'active'
    `).run({
      endedAtMs: EXECUTES_AT_MS + DAY_MS,
      membershipId: MANAGERS[0].membership,
      updatedAtMs: EXECUTES_AT_MS - 1,
    });

    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "winner");
    assert.equal(result.winner.teamId, MANAGERS[0].team);
    assertRapidResultPublicationEvidence(runtime, result, []);
    assert.deepEqual(result.evidence.notificationIds, []);
    assert.equal(result.evidence.outboxEventIds.length, 3);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_rapid_auction_result'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: MANAGERS[0].user,
      }).count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_event_audiences AS audience
        JOIN outbox_events AS event
          ON event.league_id = audience.league_id
         AND event.id = audience.outbox_event_id
        WHERE event.league_id = @leagueId
          AND event.created_at_ms = @createdAtMs
          AND audience.audience_kind = 'user'
          AND audience.user_id = @userId
      `).get({
        leagueId: IDS.league,
        createdAtMs: EXECUTES_AT_MS,
        userId: MANAGERS[0].user,
      }).count,
      0
    );

    runtime.database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = NULL,
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND status = 'active'
    `).run({
      membershipId: MANAGERS[0].membership,
      updatedAtMs: EXECUTES_AT_MS + 1,
    });
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evidence, result.evidence);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_rapid_auction_result'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: MANAGERS[0].user,
      }).count,
      0
    );
  });

  test("lists a due restricted auction without a precreated job and atomically ensures its canonical job during claim", (t) => {
    const runtime = createScenarioRuntime(
      t,
      "restricted_winner",
      { missingJob: true }
    );
    const due = runtime.writer.listDue({
      nowMs: EXECUTES_AT_MS,
      limit: 10,
    });
    assert.equal(due.length, 1);
    assert.equal(due[0].jobRunId, null);
    assert.equal(due[0].jobRunVersion, null);

    const { claimed, result } = claimAndExecute(runtime);
    assert.equal(claimed.jobRunId, IDS.resolutionJob);
    assert.equal(claimed.jobRunVersion, 2);
    assert.equal(result.outcome, "winner");
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          job_type,
          occurrence_key,
          scheduled_for_ms,
          status,
          attempt_count,
          result_json,
          version
        FROM job_runs
        WHERE id = @runId
      `).get({ runId: IDS.resolutionJob }),
      {
        job_type: "auction.resolve.target",
        occurrence_key: runtime.key,
        scheduled_for_ms: RESOLVES_AT_MS,
        status: "succeeded",
        attempt_count: 1,
        result_json: JSON.stringify({
          auctionId: IDS.restrictedAuction,
          outcome: "resolved",
        }),
        version: 3,
      }
    );
  });

  test("reclaims an expired first transient lease without inventing recovery evidence", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const due = runtime.writer.listDue({
      nowMs: EXECUTES_AT_MS,
      limit: 10,
    })[0];
    const firstLeaseExpiresAtMs = EXECUTES_AT_MS + 1_000;
    const first = runtime.writer.claimDue({
      leagueId: IDS.league,
      seasonId: IDS.season,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
      expectedAuctionVersion: due.auctionVersion,
      expectedJobVersion: due.jobRunVersion,
      nowMs: EXECUTES_AT_MS,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: IDS.leaseToken,
        leaseExpiresAtMs: firstLeaseExpiresAtMs,
      },
    });
    const reclaimAtMs = firstLeaseExpiresAtMs + 1;
    const secondDue = runtime.writer.listDue({
      nowMs: reclaimAtMs,
      limit: 10,
    });
    assert.equal(secondDue.length, 1);
    assert.equal(secondDue[0].auctionStatus, "resolving");
    const secondToken = uuid(7_820);
    const secondExpiresAtMs = reclaimAtMs + 60 * 60 * 1000;
    const second = runtime.writer.claimDue({
      leagueId: IDS.league,
      seasonId: IDS.season,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
      expectedAuctionVersion: first.auctionVersion,
      expectedJobVersion: first.jobRunVersion,
      nowMs: reclaimAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: secondToken,
        leaseExpiresAtMs: secondExpiresAtMs,
      },
    });
    assert.equal(second.attemptCount, 2);
    assert.equal(second.auctionVersion, first.auctionVersion);
    assert.equal(second.recoveryResumed, false);
    const result = executeClaimed(runtime, second, {
      resolvedAtMs: reclaimAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: secondToken,
        leaseExpiresAtMs: secondExpiresAtMs,
      },
    });
    assert.equal(result.outcome, "winner");
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_recoveries
        WHERE auction_id = @auctionId
      `).get({ auctionId: runtime.auctionId }).count,
      0
    );
  });

  test("replays only state-bound outboxes when another auction publishes for the same FAD in the same millisecond", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const { result } = claimAndExecute(runtime);
    const otherAuctionId = uuid(7_701);
    const outbox = createSqliteLeagueOutboxWriter({
      database: runtime.database,
    });
    for (const event of [
      {
        id: uuid(7_702),
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: IDS.fad,
      },
      {
        id: uuid(7_703),
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: otherAuctionId,
      },
    ]) {
      outbox.write({
        id: event.id,
        leagueId: IDS.league,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: createSocketInvalidation({
          eventType: event.eventType,
          scope: "league",
          scopeId: IDS.league,
          changedAtMs: EXECUTES_AT_MS,
        }),
        occurredAtMs: EXECUTES_AT_MS,
        audiences: [{ kind: "league" }],
      });
    }

    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: IDS.restrictedAuction,
      occurrenceKey: runtime.key,
    });
    assert.deepEqual(
      replay.evidence.outboxEventIds,
      result.evidence.outboxEventIds
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_events
        WHERE league_id = @leagueId
          AND created_at_ms = @createdAtMs
      `).get({
        leagueId: IDS.league,
        createdAtMs: EXECUTES_AT_MS,
      }).count,
      6
    );
  });

  test("persists the committed exact-top draw and freezes only its selected winner and tied loser", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_tie");
    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "winner");
    assert.equal(result.drawReveal.selectionUsed, true);
    assert.deepEqual(
      result.drawReveal.orderedBidIds,
      MANAGERS.map((value) => value.bid).sort()
    );
    assert.equal(Number.isSafeInteger(result.drawReveal.counter), true);
    assert.equal(result.drawReveal.digestHex.length, 64);
    assert.equal(result.drawReveal.selectedBidId, result.winner.bidId);
    assert.equal(result.drawReveal.selectedTeamId, result.winner.teamId);
    const bids = runtime.database.prepare(`
      SELECT id, team_id, status
      FROM auction_bids
      WHERE auction_id = @auctionId
      ORDER BY id
    `).all({ auctionId: IDS.restrictedAuction });
    assert.equal(bids.filter((bid) => bid.status === "won").length, 1);
    assert.equal(bids.filter((bid) => bid.status === "lost").length, 1);
    assert.equal(
      bids.find((bid) => bid.status === "won").id,
      result.drawReveal.selectedBidId
    );
    const draw = runtime.database.prepare(`
      SELECT
        ordered_tied_bid_ids_json,
        ordered_tied_team_ids_json,
        rejection_counter,
        selected_index,
        selected_bid_id,
        selected_team_id,
        selected_digest_hex,
        version
      FROM free_agent_draft_draws
      WHERE auction_id = @auctionId
    `).get({ auctionId: IDS.restrictedAuction });
    assert.deepEqual(
      JSON.parse(draw.ordered_tied_bid_ids_json),
      result.drawReveal.orderedBidIds
    );
    assert.equal(draw.rejection_counter, result.drawReveal.counter);
    assert.equal(draw.selected_index, result.drawReveal.selectedIndex);
    assert.equal(draw.selected_bid_id, result.drawReveal.selectedBidId);
    assert.equal(draw.selected_team_id, result.drawReveal.selectedTeamId);
    assert.equal(draw.selected_digest_hex, result.drawReveal.digestHex);
    assert.equal(draw.version, 2);
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: IDS.restrictedAuction,
      occurrenceKey: runtime.key,
    });
    assert.deepEqual(replay.drawReveal, result.drawReveal);
    assert.equal(replay.winner.bidId, result.winner.bidId);
  });

  test("excludes a removed participant's higher current bid and invalidates it before draw freezing", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_removed");
    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "winner");
    assert.equal(result.winner.bidId, MANAGERS[1].bid);
    assert.equal(result.winner.teamId, MANAGERS[1].team);
    assert.equal(result.drawReveal.selectionUsed, false);
    assertRapidResultPublicationEvidence(runtime, result, [
      {
        teamId: MANAGERS[0].team,
        userId: MANAGERS[0].user,
        outcomeCode: "removed",
      },
      {
        teamId: MANAGERS[1].team,
        userId: MANAGERS[1].user,
        outcomeCode: "won",
      },
    ]);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT id, status
        FROM auction_bids
        WHERE auction_id = @auctionId
        ORDER BY id
      `).all({ auctionId: IDS.restrictedAuction }),
      [
        { id: MANAGERS[0].bid, status: "invalid" },
        { id: MANAGERS[1].bid, status: "won" },
      ]
    );
  });

  test("rolls back every execution write when the late synchronous commit hook fails", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner", {
      beforeCommit() {
        throw new Error("late FAD resolution rollback");
      },
    });
    const claimed = claimDue(runtime);
    let executionError;
    try {
      runtime.writer.executeClaimed(
        claimedExecutionInput(runtime, claimed)
      );
    } catch (error) {
      executionError = error;
    }
    assert.ok(executionError);
    assert.match(
      executionError.cause?.message ?? "",
      /late FAD resolution rollback/
    );
    assert.equal(
      isFreeAgentDraftAuctionResolutionTerminalFailure(
        executionError
      ),
      false
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          auction.status AS auction_status,
          auction.version AS auction_version,
          allocation.status AS allocation_status,
          allocation.version AS allocation_version,
          draw.version AS draw_version,
          bid.status AS bid_status,
          job.status AS job_status,
          job.version AS job_version,
          (SELECT COUNT(*) FROM auction_resolutions) AS resolution_count,
          (SELECT COUNT(*) FROM contracts) AS contract_count,
          (SELECT COUNT(*) FROM player_ownerships) AS ownership_count,
          (SELECT COUNT(*) FROM league_activity) AS activity_count,
          (SELECT COUNT(*) FROM outbox_events) AS outbox_count
        FROM auctions AS auction
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.restricted_auction_id = auction.id
        JOIN free_agent_draft_draws AS draw
          ON draw.auction_id = auction.id
        JOIN auction_bids AS bid
          ON bid.auction_id = auction.id
        JOIN job_runs AS job
          ON job.id = @jobRunId
        WHERE auction.id = @auctionId
      `).get({
        auctionId: IDS.restrictedAuction,
        jobRunId: IDS.resolutionJob,
      }),
      {
        auction_status: "resolving",
        auction_version: 2,
        allocation_status: "restricted_active",
        allocation_version: 3,
        draw_version: 1,
        bid_status: "active",
        job_status: "running",
        job_version: 2,
        resolution_count: 0,
        contract_count: 0,
        ownership_count: 0,
        activity_count: 0,
        outbox_count: 0,
      }
    );
  });

  test("marks only a deterministic FAD policy failure as terminal for the runner", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const claimed = claimDue(runtime);
    const triggers = captureAndDropTriggers(runtime.database);
    insert(runtime.database, "player_ownerships", {
      id: uuid(8_899),
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.player,
      team_id: MANAGERS[0].team,
      ownership_kind: "Prospect Right",
      roster_category: "Prospect",
      position_group: "F",
      slot_number: null,
      acquired_transaction_type: "foundation_setup",
      acquired_transaction_id: null,
      created_at_ms: EXECUTES_AT_MS,
      updated_at_ms: EXECUTES_AT_MS,
      version: 1,
    });
    restoreTriggers(runtime.database, triggers);

    let executionError;
    try {
      runtime.writer.executeClaimed(
        claimedExecutionInput(runtime, claimed)
      );
    } catch (error) {
      executionError = error;
    }
    assert.ok(executionError);
    assert.equal(
      isFreeAgentDraftAuctionResolutionTerminalFailure(
        executionError
      ),
      true
    );
    assert.deepEqual(executionError.details, {
      terminalFailure: true,
      policyCode: "FAD_AUCTION_RESOLUTION_AUCTION_INVALID",
      reasonCode: "player_already_owned",
    });
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          auction.status AS auction_status,
          allocation.status AS allocation_status,
          job.status AS job_status,
          (SELECT COUNT(*) FROM auction_resolutions)
            AS resolution_count,
          (SELECT COUNT(*) FROM free_agent_draft_recoveries)
            AS recovery_count
        FROM auctions AS auction
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.restricted_auction_id = auction.id
        JOIN job_runs AS job
          ON job.id = @jobRunId
        WHERE auction.id = @auctionId
      `).get({
        auctionId: IDS.restrictedAuction,
        jobRunId: IDS.resolutionJob,
      }),
      {
        auction_status: "resolving",
        allocation_status: "restricted_active",
        job_status: "running",
        resolution_count: 0,
        recovery_count: 0,
      }
    );
  });

  test("rejects a stale lease token before any execution write", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const claimed = claimDue(runtime);
    const staleToken = uuid(8_888);
    assert.throws(
      () =>
        executeClaimed(runtime, claimed, {
          jobExecution: {
            runId: IDS.resolutionJob,
            leaseOwner: LEASE_OWNER,
            leaseToken: staleToken,
            leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
          },
        }),
      /active job lease changed/
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          auction.status AS auction_status,
          allocation.status AS allocation_status,
          draw.version AS draw_version,
          bid.status AS bid_status,
          job.status AS job_status,
          job.lease_token,
          (SELECT COUNT(*) FROM auction_resolutions) AS resolution_count,
          (SELECT COUNT(*) FROM contracts) AS contract_count,
          (SELECT COUNT(*) FROM player_ownerships) AS ownership_count,
          (SELECT COUNT(*) FROM league_activity) AS activity_count,
          (SELECT COUNT(*) FROM outbox_events) AS outbox_count
        FROM auctions AS auction
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.restricted_auction_id = auction.id
        JOIN free_agent_draft_draws AS draw
          ON draw.auction_id = auction.id
        JOIN auction_bids AS bid
          ON bid.auction_id = auction.id
        JOIN job_runs AS job
          ON job.id = @jobRunId
        WHERE auction.id = @auctionId
      `).get({
        auctionId: IDS.restrictedAuction,
        jobRunId: IDS.resolutionJob,
      }),
      {
        auction_status: "resolving",
        allocation_status: "restricted_active",
        draw_version: 1,
        bid_status: "active",
        job_status: "running",
        lease_token: IDS.leaseToken,
        resolution_count: 0,
        contract_count: 0,
        ownership_count: 0,
        activity_count: 0,
        outbox_count: 0,
      }
    );
  });

  test("atomically quarantines an explicit terminal automatic failure and exactly replays it", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const claimed = claimDue(runtime);
    const result = recordFailure(runtime, claimed);

    assert.equal(result.recorded, true);
    assert.equal(result.replayed, false);
    assert.equal(
      result.errorCode,
      FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE
    );
    assert.equal(result.allocationVersion, claimed.allocationVersion + 1);
    assert.equal(result.auctionVersion, claimed.auctionVersion + 1);
    assert.equal(result.jobRunVersion, claimed.jobRunVersion + 1);
    assert.equal(result.evidence.notificationIds.length, 1);
    assert.equal(result.evidence.outboxEventIds.length, 3);
    const correctionNotification = runtime.database.prepare(`
      SELECT *
      FROM notifications
      WHERE id = @notificationId
    `).get({
      notificationId: result.evidence.notificationIds[0],
    });
    assert.equal(
      correctionNotification.user_id,
      IDS.commissionerUser
    );
    assert.equal(
      correctionNotification.event_type,
      "fad_correction_required"
    );
    assert.deepEqual(
      JSON.parse(correctionNotification.message_data_json),
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        allocationId: IDS.allocation,
        auctionId: IDS.restrictedAuction,
        recoveryId: result.recoveryId,
        playerId: IDS.player,
        errorCode: FREE_AGENT_DRAFT_AUCTION_RESOLUTION_FAILURE_CODE,
        destination: {
          kind: "fad_recovery",
          leagueId: IDS.league,
          fadId: IDS.fad,
          recoveryId: result.recoveryId,
        },
      }
    );
    assert.equal(
      correctionNotification.deduplication_key,
      `fad:${IDS.fad}:correction-required:` +
        `${result.recoveryId}:${IDS.commissionerUser}`
    );
    const failureRelated = createEmptySocketRelated({
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      auctionId: IDS.restrictedAuction,
      recoveryId: result.recoveryId,
    });
    const failureOutboxes = result.evidence.outboxEventIds.map(
      (outboxEventId) => runtime.database.prepare(`
        SELECT
          event.*,
          audience.audience_kind,
          audience.user_id AS audience_user_id
        FROM outbox_events AS event
        JOIN outbox_event_audiences AS audience
          ON audience.outbox_event_id = event.id
        WHERE event.id = @outboxEventId
      `).get({ outboxEventId })
    );
    assert.deepEqual(
      failureOutboxes.map((event) => event.event_type),
      [
        "free_agent_draft.changed",
        "auction.changed",
        "notification.created",
      ]
    );
    const failureVersions = [4, result.auctionVersion, 1];
    const failureReasons = [
      "allocation_changed",
      "auction_changed",
      "auction_changed",
    ];
    for (let index = 0; index < failureOutboxes.length; index += 1) {
      const publication = failureOutboxes[index];
      assert.deepEqual(
        JSON.parse(publication.payload_json),
        createSocketEventEnvelope({
          eventId: publication.id,
          type: publication.event_type,
          leagueId: IDS.league,
          resourceId: publication.aggregate_id,
          version: failureVersions[index],
          reasonCode: failureReasons[index],
          occurredAt: EXECUTES_AT_MS,
          related: failureRelated,
        })
      );
    }
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          auction.status AS auction_status,
          allocation.status AS allocation_status,
          allocation.last_error_code,
          draw.version AS draw_version,
          draw.revealed_at_ms,
          bid.status AS bid_status,
          job.status AS job_status,
          job.last_error_code AS job_error_code,
          recovery.status AS recovery_status,
          recovery.last_error_code AS recovery_error_code,
          failure.event_type AS failure_event_type,
          (SELECT COUNT(*) FROM auction_resolutions)
            AS resolution_count
        FROM auctions AS auction
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.restricted_auction_id = auction.id
        JOIN free_agent_draft_draws AS draw
          ON draw.auction_id = auction.id
        JOIN auction_bids AS bid
          ON bid.auction_id = auction.id
        JOIN job_runs AS job
          ON job.id = @jobRunId
        JOIN free_agent_draft_recoveries AS recovery
          ON recovery.id = @recoveryId
        JOIN auction_events AS failure
          ON failure.id = @failureEventId
        WHERE auction.id = @auctionId
      `).get({
        auctionId: IDS.restrictedAuction,
        failureEventId: result.failureEventId,
        jobRunId: IDS.resolutionJob,
        recoveryId: result.recoveryId,
      }),
      {
        auction_status: "failed",
        allocation_status: "correction_required",
        last_error_code: "AUCTION_RESOLUTION_FAILED",
        draw_version: 1,
        revealed_at_ms: null,
        bid_status: "active",
        job_status: "failed",
        job_error_code: "AUCTION_RESOLUTION_FAILED",
        recovery_status: "correction_required",
        recovery_error_code: "AUCTION_RESOLUTION_FAILED",
        failure_event_type: "fad_auction_resolution_failed",
        resolution_count: 0,
      }
    );
    const replay = recordFailure(runtime, claimed);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay, { ...result, replayed: true });
    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );
  });

  test("fails closed without correction evidence when the commissioner membership is active-status but already ended", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const claimed = claimDue(runtime);
    runtime.database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = @endedAtMs,
          updated_at_ms = @endedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND status = 'active'
    `).run({
      endedAtMs: EXECUTES_AT_MS - 1,
      membershipId: IDS.commissionerMembership,
    });
    const failureState = () => runtime.database.prepare(`
      SELECT
        auction.status AS auction_status,
        auction.version AS auction_version,
        allocation.status AS allocation_status,
        allocation.version AS allocation_version,
        job.status AS job_status,
        job.version AS job_version,
        (SELECT COUNT(*) FROM free_agent_draft_recoveries)
          AS recovery_count,
        (SELECT COUNT(*) FROM auction_events
          WHERE event_type = 'fad_auction_resolution_failed')
          AS failure_event_count,
        (SELECT COUNT(*) FROM notifications)
          AS notification_count,
        (SELECT COUNT(*) FROM outbox_events)
          AS outbox_count,
        (SELECT COUNT(*) FROM outbox_event_audiences)
          AS audience_count
      FROM auctions AS auction
      JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.restricted_auction_id = auction.id
      JOIN job_runs AS job
        ON job.id = @jobRunId
      WHERE auction.id = @auctionId
    `).get({
      auctionId: runtime.auctionId,
      jobRunId: IDS.resolutionJob,
    });
    const before = failureState();

    assert.throws(
      () => recordFailure(runtime, claimed),
      (error) =>
        error.details?.reasonCode ===
        "CORRECTION_RECIPIENT_MISSING"
    );

    assert.deepEqual(failureState(), before);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_correction_required'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: IDS.commissionerUser,
      }).count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_event_audiences
        WHERE league_id = @leagueId
          AND audience_kind = 'user'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: IDS.commissionerUser,
      }).count,
      0
    );
  });

  test("rolls back every terminal-failure write when the late commit hook fails", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner", {
      beforeCommit() {
        throw new Error("late FAD failure rollback");
      },
    });
    const claimed = claimDue(runtime);
    let failureError;
    try {
      recordFailure(runtime, claimed);
    } catch (error) {
      failureError = error;
    }
    assert.ok(failureError);
    assert.match(
      failureError.cause?.message ?? "",
      /late FAD failure rollback/
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          auction.status AS auction_status,
          auction.version AS auction_version,
          allocation.status AS allocation_status,
          allocation.version AS allocation_version,
          job.status AS job_status,
          job.version AS job_version,
          draw.version AS draw_version,
          draw.revealed_at_ms,
          bid.status AS bid_status,
          (SELECT COUNT(*) FROM auction_resolutions)
            AS resolution_count,
          (SELECT COUNT(*) FROM free_agent_draft_recoveries)
            AS recovery_count,
          (SELECT COUNT(*) FROM auction_events
            WHERE event_type = 'fad_auction_resolution_failed')
            AS failure_event_count
        FROM auctions AS auction
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.restricted_auction_id = auction.id
        JOIN job_runs AS job
          ON job.id = @jobRunId
        JOIN free_agent_draft_draws AS draw
          ON draw.auction_id = auction.id
        JOIN auction_bids AS bid
          ON bid.auction_id = auction.id
        WHERE auction.id = @auctionId
      `).get({
        auctionId: IDS.restrictedAuction,
        jobRunId: IDS.resolutionJob,
      }),
      {
        auction_status: "resolving",
        auction_version: claimed.auctionVersion,
        allocation_status: "restricted_active",
        allocation_version: claimed.allocationVersion,
        job_status: "running",
        job_version: claimed.jobRunVersion,
        draw_version: 1,
        revealed_at_ms: null,
        bid_status: "active",
        resolution_count: 0,
        recovery_count: 0,
        failure_event_count: 0,
      }
    );
  });

  test("claims a commissioner-requeued physical failure through 0041 and settles its recovery on success", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const firstClaim = claimDue(runtime);
    const failure = recordFailure(runtime, firstClaim);
    const acceptedAtMs = EXECUTES_AT_MS + 1_000;
    const retryAtMs = acceptedAtMs + 1_000;
    const retryLeaseToken = uuid(7_812);
    const retryLeaseExpiresAtMs = retryAtMs + 60 * 60 * 1000;
    acceptResolutionRetry(runtime, acceptedAtMs);

    const due = runtime.writer.listDue({ nowMs: retryAtMs, limit: 10 });
    assert.equal(due.length, 1);
    assert.equal(due[0].auctionStatus, "failed");
    assert.equal(due[0].jobStatus, "pending");
    assert.equal(due[0].attemptCount, 1);
    const retryClaim = runtime.writer.claimDue({
      leagueId: IDS.league,
      seasonId: IDS.season,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
      expectedAuctionVersion: due[0].auctionVersion,
      expectedJobVersion: due[0].jobRunVersion,
      nowMs: retryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: retryLeaseToken,
        leaseExpiresAtMs: retryLeaseExpiresAtMs,
      },
    });
    assert.equal(retryClaim.acquired, true);
    assert.equal(retryClaim.recoveryResumed, true);
    assert.equal(retryClaim.recoveryId, failure.recoveryId);
    assert.equal(retryClaim.attemptCount, 2);
    assert.equal(
      retryClaim.allocationVersion,
      failure.allocationVersion + 1
    );
    assert.equal(
      retryClaim.auctionVersion,
      failure.auctionVersion + 1
    );
    assert.equal(
      retryClaim.recoveryResumeEvidence.clonedOfferEventIds.length,
      MANAGERS.length
    );

    const result = executeClaimed(runtime, retryClaim, {
      resolvedAtMs: retryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: retryLeaseToken,
        leaseExpiresAtMs: retryLeaseExpiresAtMs,
      },
    });
    assert.equal(result.outcome, "winner");
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          auction.status AS auction_status,
          allocation.status AS allocation_status,
          recovery.status AS recovery_status,
          recovery.last_error_code AS recovery_error_code,
          recovery.resolved_authority,
          job.status AS job_status,
          job.attempt_count
        FROM auctions AS auction
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.restricted_auction_id = auction.id
        JOIN free_agent_draft_recoveries AS recovery
          ON recovery.id = @recoveryId
        JOIN job_runs AS job
          ON job.id = @jobRunId
        WHERE auction.id = @auctionId
      `).get({
        auctionId: IDS.restrictedAuction,
        jobRunId: IDS.resolutionJob,
        recoveryId: failure.recoveryId,
      }),
      {
        auction_status: "resolved",
        allocation_status: "restricted_resolved",
        recovery_status: "resolved",
        recovery_error_code: null,
        resolved_authority: "system",
        job_status: "succeeded",
        attempt_count: 2,
      }
    );
  });

  test("settles a requeued allocation-linked fallback winner through the 0043 system recovery guard", (t) => {
    const runtime = createScenarioRuntime(t, "fallback_winner");
    const firstClaim = claimDue(runtime);
    const failure = recordFailure(runtime, firstClaim);
    const acceptedAtMs = EXECUTES_AT_MS + 1_000;
    const retryAtMs = acceptedAtMs + 1_000;
    const retryLeaseToken = uuid(7_813);
    const retryLeaseExpiresAtMs = retryAtMs + 60 * 60 * 1000;
    acceptResolutionRetry(runtime, acceptedAtMs);
    const due = runtime.writer.listDue({ nowMs: retryAtMs, limit: 10 });
    assert.equal(due.length, 1);
    const retryClaim = runtime.writer.claimDue({
      leagueId: IDS.league,
      seasonId: IDS.season,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
      expectedAuctionVersion: due[0].auctionVersion,
      expectedJobVersion: due[0].jobRunVersion,
      nowMs: retryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: retryLeaseToken,
        leaseExpiresAtMs: retryLeaseExpiresAtMs,
      },
    });
    assert.equal(retryClaim.recoveryId, failure.recoveryId);
    const result = executeClaimed(runtime, retryClaim, {
      resolvedAtMs: retryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: retryLeaseToken,
        leaseExpiresAtMs: retryLeaseExpiresAtMs,
      },
    });
    assert.equal(result.outcome, "winner");
    assert.equal(
      runtime.database.prepare(`
        SELECT status
        FROM free_agent_draft_recoveries
        WHERE id = @recoveryId
      `).get({ recoveryId: failure.recoveryId }).status,
      "resolved"
    );
  });

  test("reuses one causal recovery across a repeated 0043 failure and resolves from the latest retry", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_winner");
    const firstClaim = claimDue(runtime);
    const firstFailure = recordFailure(runtime, firstClaim);
    const firstAcceptedAtMs = EXECUTES_AT_MS + 1_000;
    const firstRetryAtMs = firstAcceptedAtMs + 1_000;
    const firstRetryToken = uuid(7_830);
    const firstRetryExpiresAtMs = firstRetryAtMs + 60 * 60 * 1000;
    acceptResolutionRetry(runtime, firstAcceptedAtMs, 0);
    const firstDue = runtime.writer.listDue({
      nowMs: firstRetryAtMs,
      limit: 10,
    })[0];
    const firstRetryClaim = runtime.writer.claimDue({
      leagueId: IDS.league,
      seasonId: IDS.season,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
      expectedAuctionVersion: firstDue.auctionVersion,
      expectedJobVersion: firstDue.jobRunVersion,
      nowMs: firstRetryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: firstRetryToken,
        leaseExpiresAtMs: firstRetryExpiresAtMs,
      },
    });
    const secondFailure = recordFailure(runtime, firstRetryClaim, {
      failedAtMs: firstRetryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: firstRetryToken,
        leaseExpiresAtMs: firstRetryExpiresAtMs,
      },
    });
    assert.equal(secondFailure.recoveryId, firstFailure.recoveryId);
    assert.equal(secondFailure.recoveryVersion, 3);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_recoveries
        WHERE auction_id = @auctionId
      `).get({ auctionId: runtime.auctionId }).count,
      1
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM auction_events
        WHERE auction_id = @auctionId
          AND event_type = 'fad_auction_resolution_failed'
      `).get({ auctionId: runtime.auctionId }).count,
      2
    );

    const secondAcceptedAtMs = firstRetryAtMs + 1_000;
    const secondRetryAtMs = secondAcceptedAtMs + 1_000;
    const secondRetryToken = uuid(7_831);
    const secondRetryExpiresAtMs =
      secondRetryAtMs + 60 * 60 * 1000;
    acceptResolutionRetry(runtime, secondAcceptedAtMs, 1);
    const secondDue = runtime.writer.listDue({
      nowMs: secondRetryAtMs,
      limit: 10,
    })[0];
    const secondRetryClaim = runtime.writer.claimDue({
      leagueId: IDS.league,
      seasonId: IDS.season,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
      expectedAuctionVersion: secondDue.auctionVersion,
      expectedJobVersion: secondDue.jobRunVersion,
      nowMs: secondRetryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: secondRetryToken,
        leaseExpiresAtMs: secondRetryExpiresAtMs,
      },
    });
    assert.equal(secondRetryClaim.attemptCount, 3);
    assert.equal(secondRetryClaim.recoveryId, firstFailure.recoveryId);
    const result = executeClaimed(runtime, secondRetryClaim, {
      resolvedAtMs: secondRetryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: secondRetryToken,
        leaseExpiresAtMs: secondRetryExpiresAtMs,
      },
    });
    assert.equal(result.outcome, "winner");
    assert.equal(
      runtime.database.prepare(`
        SELECT status
        FROM free_agent_draft_recoveries
        WHERE id = @recoveryId
      `).get({ recoveryId: firstFailure.recoveryId }).status,
      "resolved"
    );
  });

  test("atomically resolves and exactly replays an allocation-null manager nomination winner", (t) => {
    const runtime = createScenarioRuntime(t, "direct_winner");
    const claimed = claimDue(runtime);
    for (const invalidBinding of [
      {
        allocationId: null,
        expectedAllocationVersion: 1,
      },
      {
        allocationId: IDS.allocation,
        expectedAllocationVersion: 0,
      },
    ]) {
      assert.throws(
        () => runtime.writer.executeClaimed(
          claimedExecutionInput(runtime, claimed, invalidBinding)
        ),
        (error) =>
          error.code === "REPOSITORY_ARGUMENT_INVALID" &&
          error.details?.reasonCode ===
            "ALLOCATION_BINDING_INVALID"
      );
    }
    const result = executeClaimed(runtime, claimed);

    assert.equal(claimed.allocationId, null);
    assert.equal(claimed.allocationVersion, 0);
    assert.equal(result.outcome, "winner");
    assert.equal(result.allocationId, null);
    assert.equal(result.allocationVersion, 0);
    assert.equal(result.winner.bidId, MANAGERS[0].bid);
    assert.equal(result.winner.highestCompetingAavCents, null);
    assert.equal(result.winner.persistedSecondPriceInputCents, 0);
    assert.equal(result.drawReveal.selectionUsed, false);
    assert.deepEqual(result.evidence.clonedOfferEventIds, []);
    assert.equal(result.evidence.stateEventId, null);
    assert.equal(runtime.summerCalls.length, 1);

    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.resolutionId, result.resolutionId);
    assert.deepEqual(replay.evidence, result.evidence);
    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );
  });

  test("persists an allocation-null queued-nomination exact tie through its committed private draw", (t) => {
    const runtime = createScenarioRuntime(t, "queued_tie");
    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "winner");
    assert.equal(result.allocationId, null);
    assert.equal(result.allocationVersion, 0);
    assert.equal(result.drawReveal.selectionUsed, true);
    assert.deepEqual(
      result.drawReveal.orderedBidIds,
      MANAGERS.map((value) => value.bid).sort()
    );
    assert.equal(result.drawReveal.selectedBidId, result.winner.bidId);
    assert.equal(result.drawReveal.selectedTeamId, result.winner.teamId);
    assert.equal(result.winner.highestCompetingAavCents, 300);
    assertRapidResultPublicationEvidence(
      runtime,
      result,
      MANAGERS.map((manager) => ({
        teamId: manager.team,
        userId: manager.user,
        outcomeCode:
          result.winner.teamId === manager.team ? "won" : "lost",
      }))
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT id, status
        FROM auction_bids
        WHERE auction_id = @auctionId
        ORDER BY id
      `).all({ auctionId: runtime.auctionId }),
      [
        { id: MANAGERS[0].bid, status: result.winner.bidId === MANAGERS[0].bid ? "won" : "lost" },
        { id: MANAGERS[1].bid, status: result.winner.bidId === MANAGERS[1].bid ? "won" : "lost" },
      ]
    );
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.deepEqual(replay.drawReveal, result.drawReveal);
    assert.equal(replay.winner.bidId, result.winner.bidId);
  });

  test("atomically closes an allocation-null queued nomination with no eligible bid", (t) => {
    const runtime = createScenarioRuntime(t, "queued_no_bid");
    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "no_winner");
    assert.equal(result.allocationId, null);
    assert.equal(result.allocationVersion, 0);
    assert.equal(result.drawReveal.selectionUsed, false);
    assert.equal(result.fallbackAuctionId, null);
    assert.deepEqual(result.evidence.clonedOfferEventIds, []);
    assert.equal(result.evidence.stateEventId, null);
    assert.equal(runtime.summerCalls.length, 0);
    assertRapidResultPublicationEvidence(runtime, result, []);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          auction.status AS auction_status,
          resolution.status AS resolution_status,
          job.status AS job_status,
          job.result_json
        FROM auctions AS auction
        JOIN auction_resolutions AS resolution
          ON resolution.league_id = auction.league_id
         AND resolution.auction_id = auction.id
        JOIN job_runs AS job
          ON job.id = @jobRunId
        WHERE auction.id = @auctionId
      `).get({
        auctionId: runtime.auctionId,
        jobRunId: IDS.resolutionJob,
      }),
      {
        auction_status: "no_winner",
        resolution_status: "no_winner",
        job_status: "succeeded",
        result_json: JSON.stringify({
          auctionId: runtime.auctionId,
          outcome: "no_winner",
        }),
      }
    );
  });

  test("retries an allocation-null manager nomination after one durable terminal failure", (t) => {
    const runtime = createScenarioRuntime(t, "direct_winner");
    const firstClaim = claimDue(runtime);
    const failure = recordFailure(runtime, firstClaim);

    assert.equal(failure.allocationId, null);
    assert.equal(failure.allocationVersion, 0);
    assert.deepEqual(failure.evidence.clonedOfferEventIds, []);
    assert.equal(failure.evidence.stateEventId, null);
    const replay = recordFailure(runtime, firstClaim);
    assert.equal(replay.replayed, true);
    assert.equal(replay.recoveryId, failure.recoveryId);

    const acceptedAtMs = EXECUTES_AT_MS + 1_000;
    const retryAtMs = acceptedAtMs + 1_000;
    const retryLeaseToken = uuid(7_870);
    const retryLeaseExpiresAtMs = retryAtMs + 60 * 60 * 1000;
    acceptResolutionRetry(runtime, acceptedAtMs, 7);
    const due = runtime.writer.listDue({ nowMs: retryAtMs, limit: 10 });
    assert.equal(due.length, 1);
    assert.equal(due[0].allocationId, null);
    assert.equal(due[0].allocationVersion, 0);
    const retryClaim = runtime.writer.claimDue({
      leagueId: IDS.league,
      seasonId: IDS.season,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
      expectedAuctionVersion: due[0].auctionVersion,
      expectedJobVersion: due[0].jobRunVersion,
      nowMs: retryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: retryLeaseToken,
        leaseExpiresAtMs: retryLeaseExpiresAtMs,
      },
    });
    assert.equal(retryClaim.recoveryResumed, true);
    assert.equal(retryClaim.recoveryId, failure.recoveryId);
    assert.equal(retryClaim.allocationId, null);
    assert.equal(retryClaim.allocationVersion, 0);
    assert.deepEqual(retryClaim.recoveryResumeEvidence, {
      clonedOfferEventIds: [],
      stateEventId: null,
    });
    const result = executeClaimed(runtime, retryClaim, {
      resolvedAtMs: retryAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: retryLeaseToken,
        leaseExpiresAtMs: retryLeaseExpiresAtMs,
      },
    });
    assert.equal(result.outcome, "winner");
    assert.equal(
      runtime.database.prepare(`
        SELECT status
        FROM free_agent_draft_recoveries
        WHERE id = @recoveryId
      `).get({ recoveryId: failure.recoveryId }).status,
      "resolved"
    );
  });

  test("delegates zero restricted improvements to the shared full-window fallback in the same transaction", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_zero");
    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "restricted_fallback");
    assert.equal(result.drawReveal.selectionUsed, false);
    assert.equal(result.fallbackAuctionId !== null, true);
    assert.equal(runtime.summerCalls.length, 0);
    const state = runtime.database.prepare(`
      SELECT
        allocation.status AS allocation_status,
        allocation.decision_code,
        allocation.fallback_open_auction_id,
        source.status AS source_status,
        fallback.status AS fallback_status,
        fallback.opened_at_ms AS fallback_opened_at_ms,
        fallback.resolves_at_ms AS fallback_resolves_at_ms,
        job.status AS source_job_status,
        job.result_json
      FROM free_agent_draft_player_allocations AS allocation
      JOIN auctions AS source
        ON source.league_id = allocation.league_id
       AND source.id = allocation.restricted_auction_id
      JOIN auctions AS fallback
        ON fallback.league_id = allocation.league_id
       AND fallback.id = allocation.fallback_open_auction_id
      JOIN job_runs AS job
        ON job.league_id = allocation.league_id
       AND job.id = @jobRunId
      WHERE allocation.id = @allocationId
    `).get({
      allocationId: IDS.allocation,
      jobRunId: IDS.resolutionJob,
    });
    assert.deepEqual(state, {
      allocation_status: "restricted_fallback_open",
      decision_code: "restricted_no_improvement_fallback",
      fallback_open_auction_id: result.fallbackAuctionId,
      source_status: "no_winner",
      fallback_status: "open",
      fallback_opened_at_ms: RESOLVES_AT_MS,
      fallback_resolves_at_ms: RESOLVES_AT_MS + DAY_MS,
      source_job_status: "succeeded",
      result_json: JSON.stringify({
        auctionId: IDS.restrictedAuction,
        outcome: "no_winner",
      }),
    });
    assertRestrictedFallbackPublicationEvidence(runtime, result, {
      expectedManagers: MANAGERS,
    });
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evidence, result.evidence);
    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );
  });

  test("publishes an immediate restricted fallback to the one exact active manager", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_zero");
    const triggers = captureAndDropTriggers(runtime.database);
    runtime.database.prepare(`
      UPDATE users
      SET status = 'disabled',
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @userId
    `).run({
      updatedAtMs: EXECUTES_AT_MS - 1,
      userId: MANAGERS[1].user,
    });
    restoreTriggers(runtime.database, triggers);

    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "restricted_fallback");
    assert.equal(result.evidence.notificationIds.length, 1);
    assert.equal(result.evidence.outboxEventIds.length, 5);
    assertRestrictedFallbackPublicationEvidence(runtime, result, {
      expectedManagers: [MANAGERS[0]],
    });
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evidence, result.evidence);
  });

  test("keeps immediate-fallback recipient sizing aligned when an active-status manager membership has ended", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_zero");
    runtime.database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = @endedAtMs,
          updated_at_ms = @endedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND status = 'active'
    `).run({
      endedAtMs: EXECUTES_AT_MS - 1,
      membershipId: MANAGERS[1].membership,
    });

    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "restricted_fallback");
    assert.equal(result.evidence.notificationIds.length, 1);
    assert.equal(result.evidence.outboxEventIds.length, 5);
    assertRestrictedFallbackPublicationEvidence(runtime, result, {
      expectedManagers: [MANAGERS[0]],
    });
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_restricted_fallback_opened'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: MANAGERS[1].user,
      }).count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_event_audiences AS audience
        JOIN outbox_events AS event
          ON event.league_id = audience.league_id
         AND event.id = audience.outbox_event_id
        WHERE event.league_id = @leagueId
          AND event.created_at_ms = @createdAtMs
          AND audience.audience_kind = 'user'
          AND audience.user_id = @userId
      `).get({
        leagueId: IDS.league,
        createdAtMs: EXECUTES_AT_MS,
        userId: MANAGERS[1].user,
      }).count,
      0
    );

    runtime.database.prepare(`
      UPDATE league_memberships
      SET ended_at_ms = NULL,
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND status = 'active'
    `).run({
      membershipId: MANAGERS[1].membership,
      updatedAtMs: EXECUTES_AT_MS + 1,
    });
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evidence, result.evidence);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_restricted_fallback_opened'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: MANAGERS[1].user,
      }).count,
      0
    );
  });

  test("keeps immediate-fallback recipient sizing aligned when a current-looking assignment has a future end timestamp", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_zero");
    runtime.database.prepare(`
      UPDATE team_manager_assignments
      SET ended_at_ms = @endedAtMs,
          version = version + 1
      WHERE id = @assignmentId
        AND status = 'accepted'
    `).run({
      assignmentId: MANAGERS[1].assignment,
      endedAtMs: EXECUTES_AT_MS + DAY_MS,
    });

    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "restricted_fallback");
    assert.equal(result.evidence.notificationIds.length, 1);
    assert.equal(result.evidence.outboxEventIds.length, 5);
    assertRestrictedFallbackPublicationEvidence(runtime, result, {
      expectedManagers: [MANAGERS[0]],
    });
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_restricted_fallback_opened'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: MANAGERS[1].user,
      }).count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM outbox_event_audiences AS audience
        JOIN outbox_events AS event
          ON event.league_id = audience.league_id
         AND event.id = audience.outbox_event_id
        WHERE event.league_id = @leagueId
          AND event.created_at_ms = @createdAtMs
          AND audience.audience_kind = 'user'
          AND audience.user_id = @userId
      `).get({
        leagueId: IDS.league,
        createdAtMs: EXECUTES_AT_MS,
        userId: MANAGERS[1].user,
      }).count,
      0
    );

    runtime.database.prepare(`
      UPDATE team_manager_assignments
      SET ended_at_ms = NULL,
          version = version + 1
      WHERE id = @assignmentId
        AND status = 'accepted'
    `).run({ assignmentId: MANAGERS[1].assignment });
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evidence, result.evidence);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_restricted_fallback_opened'
          AND user_id = @userId
      `).get({
        leagueId: IDS.league,
        userId: MANAGERS[1].user,
      }).count,
      0
    );
  });

  test("replays a delayed restricted fallback from its source-auction publication only", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_zero");
    const delayedResolutionAtMs = EXECUTES_AT_MS + 30 * 60 * 1000;
    const triggers = captureAndDropTriggers(runtime.database);
    insert(runtime.database, "free_agent_draft_rollovers", {
      id: uuid(8_900),
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      sequence: 4,
      window_kind: "initial",
      predecessor_rollover_id: IDS.rolloverThree,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: RESOLVES_AT_MS + DAY_MS,
      creation_cutoff_at_ms:
        RESOLVES_AT_MS + 2 * DAY_MS - 60 * 60 * 1000,
      rolls_over_at_ms: RESOLVES_AT_MS + 2 * DAY_MS,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: OPENED_AT_MS + 4,
      updated_at_ms: OPENED_AT_MS + 4,
      version: 1,
    });
    restoreTriggers(runtime.database, triggers);
    const delayedLeaseExpiresAtMs =
      RESOLVES_AT_MS + 3 * DAY_MS;
    const due = runtime.writer.listDue({
      nowMs: EXECUTES_AT_MS,
      limit: 10,
    });
    assert.equal(due.length, 1);
    const claimed = runtime.writer.claimDue({
      leagueId: IDS.league,
      seasonId: IDS.season,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
      expectedAuctionVersion: due[0].auctionVersion,
      expectedJobVersion: due[0].jobRunVersion,
      nowMs: EXECUTES_AT_MS,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: IDS.leaseToken,
        leaseExpiresAtMs: delayedLeaseExpiresAtMs,
      },
    });
    assert.equal(claimed.acquired, true);

    const result = executeClaimed(runtime, claimed, {
      resolvedAtMs: delayedResolutionAtMs,
      jobExecution: {
        runId: IDS.resolutionJob,
        leaseOwner: LEASE_OWNER,
        leaseToken: IDS.leaseToken,
        leaseExpiresAtMs: delayedLeaseExpiresAtMs,
      },
    });

    assert.equal(result.outcome, "restricted_fallback");
    assert.equal(result.evidence.activityId, null);
    assert.deepEqual(result.evidence.notificationIds, []);
    assert.equal(result.evidence.outboxEventIds.length, 1);
    assertRestrictedFallbackPublicationEvidence(runtime, result, {
      delayed: true,
      expectedManagers: [],
      resolvedAtMs: delayedResolutionAtMs,
    });
    const delayedState = runtime.database.prepare(`
      SELECT
        auction.opened_at_ms,
        auction.resolves_at_ms,
        activation.status AS activation_status,
        activation.scheduled_for_ms AS activation_scheduled_for_ms
      FROM auctions AS auction
      JOIN job_runs AS activation
        ON activation.league_id = auction.league_id
       AND activation.season_id = auction.season_id
       AND activation.job_type = 'fad_fallback_activation'
       AND activation.scheduled_for_ms = auction.opened_at_ms
      WHERE auction.id = @auctionId
    `).get({ auctionId: result.fallbackAuctionId });
    assert.deepEqual(delayedState, {
      opened_at_ms: RESOLVES_AT_MS + DAY_MS,
      resolves_at_ms: RESOLVES_AT_MS + 2 * DAY_MS,
      activation_status: "pending",
      activation_scheduled_for_ms: RESOLVES_AT_MS + DAY_MS,
    });
    const replay = runtime.writer.findResolution({
      leagueId: IDS.league,
      auctionId: runtime.auctionId,
      occurrenceKey: runtime.key,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evidence, result.evidence);
  });

  test("rejects a restricted-fallback replay with a corrupted notification audience", (t) => {
    const runtime = createScenarioRuntime(t, "restricted_zero");
    const { result } = claimAndExecute(runtime);
    assertRestrictedFallbackPublicationEvidence(runtime, result, {
      expectedManagers: MANAGERS,
    });
    const triggers = captureAndDropTriggers(runtime.database);
    runtime.database.prepare(`
      UPDATE outbox_event_audiences
      SET user_id = @userId
      WHERE league_id = @leagueId
        AND outbox_event_id = @outboxEventId
    `).run({
      leagueId: IDS.league,
      outboxEventId: result.evidence.outboxEventIds[4],
      userId: IDS.commissionerUser,
    });
    restoreTriggers(runtime.database, triggers);

    assert.throws(
      () => runtime.writer.findResolution({
        leagueId: IDS.league,
        auctionId: runtime.auctionId,
        occurrenceKey: runtime.key,
      }),
      (error) =>
        error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
        error.details?.reasonCode === "RESOLUTION_OUTBOX_INVALID"
    );
  });

  test("atomically resolves an allocation-linked fallback winner at the Candidate floor", (t) => {
    const runtime = createScenarioRuntime(t, "fallback_winner");
    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "winner");
    assert.equal(result.winner.teamId, MANAGERS[0].team);
    assert.equal(result.winner.highestCompetingAavCents, null);
    assert.equal(result.winner.persistedSecondPriceInputCents, 0);
    assert.equal(result.drawReveal.selectionUsed, false);
    assert.equal(runtime.summerCalls.length, 1);
    const allocation = runtime.database.prepare(`
      SELECT
        status,
        decision_code,
        winning_snapshot_entry_id,
        winning_team_id,
        contract_id,
        ownership_id
      FROM free_agent_draft_player_allocations
      WHERE id = @allocationId
    `).get({ allocationId: IDS.allocation });
    assert.equal(allocation.status, "fallback_open_resolved");
    assert.equal(allocation.decision_code, "fallback_open_result");
    assert.equal(allocation.winning_snapshot_entry_id, null);
    assert.equal(allocation.winning_team_id, MANAGERS[0].team);
    assert.equal(typeof allocation.contract_id, "string");
    assert.equal(typeof allocation.ownership_id, "string");
    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );
  });

  test("atomically closes an allocation-linked fallback with no bid and no resources", (t) => {
    const runtime = createScenarioRuntime(t, "fallback_no_bid");
    const { result } = claimAndExecute(runtime);

    assert.equal(result.outcome, "no_winner");
    assert.equal(result.drawReveal.selectionUsed, false);
    assert.equal(runtime.summerCalls.length, 0);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          allocation.status AS allocation_status,
          allocation.decision_code,
          allocation.winning_team_id,
          allocation.contract_id,
          allocation.ownership_id,
          auction.status AS auction_status,
          resolution.status AS resolution_status,
          job.status AS job_status,
          job.result_json
        FROM free_agent_draft_player_allocations AS allocation
        JOIN auctions AS auction
          ON auction.league_id = allocation.league_id
         AND auction.id = allocation.fallback_open_auction_id
        JOIN auction_resolutions AS resolution
          ON resolution.league_id = auction.league_id
         AND resolution.auction_id = auction.id
        JOIN job_runs AS job
          ON job.league_id = auction.league_id
         AND job.id = @jobRunId
        WHERE allocation.id = @allocationId
      `).get({
        allocationId: IDS.allocation,
        jobRunId: IDS.resolutionJob,
      }),
      {
        allocation_status: "fallback_open_resolved",
        decision_code: "fallback_open_no_winner",
        winning_team_id: null,
        contract_id: null,
        ownership_id: null,
        auction_status: "no_winner",
        resolution_status: "no_winner",
        job_status: "succeeded",
        result_json: JSON.stringify({
          auctionId: IDS.fallbackAuction,
          outcome: "no_winner",
        }),
      }
    );
    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );
  });
});
