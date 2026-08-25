"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftAllocationOccurrenceKey,
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
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require(
  "../../src/domain/leagues/socketInvalidation"
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
  SqliteRepositoryError,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteNotificationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteNotificationWriter"
);
const {
  ALLOCATION_JOB_TYPE,
  BUYOUT_LOCK_MS,
  CANDIDATE_ALLOCATION_REPOSITORY_METHODS,
  RESTRICTED_ACTIVATION_JOB_TYPE,
  createSqliteCandidateAllocationRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateAllocationRepository"
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
const DEADLINE_AT_MS =
  WEEK_ONE_AT_MS - 7 * DAY_MS;
const OPENED_AT_MS =
  DEADLINE_AT_MS - 30 * DAY_MS;
const ROLLOVER_ONE_AT_MS =
  DEADLINE_AT_MS + DAY_MS;
const ROLLOVER_ONE_CREATION_CUTOFF_AT_MS =
  ROLLOVER_ONE_AT_MS -
  60 * 60 * 1000;
const LEASE_OWNER =
  "fad-allocation-worker-1";
const LEASE_TOKEN =
  "fad-allocation-lease-token-1";

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
  allocationJob: uuid(7),
  player: uuid(8),
  playerSource: uuid(9),
  rolloverOne: uuid(10),
  rolloverTwo: uuid(11),
  commissionerUser: uuid(12),
  commissionerMembership: uuid(13),
});

function roundedAav(
  totalValueCents,
  termYears
) {
  const whole = Math.floor(
    totalValueCents / termYears
  );
  const remainder =
    totalValueCents % termYears;
  return (
    whole +
    (remainder * 2 >= termYears ? 1 : 0)
  );
}

function compareOfferEvidenceRank(left, right) {
  if (
    left.rank_position !== null &&
    right.rank_position !== null
  ) {
    return (
      left.rank_position - right.rank_position ||
      left.snapshot_entry_id.localeCompare(
        right.snapshot_entry_id
      )
    );
  }
  if (left.rank_position !== null) return -1;
  if (right.rank_position !== null) return 1;
  return left.snapshot_entry_id.localeCompare(
    right.snapshot_entry_id
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

function captureAndDropTriggers(database) {
  const triggers = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'trigger'
      ORDER BY name
    `)
    .all();
  for (const trigger of triggers) {
    database.exec(
      `DROP TRIGGER "${trigger.name.replaceAll(
        '"',
        '""'
      )}"`
    );
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const trigger of triggers) {
    database.exec(trigger.sql);
  }
}

function mutateFixtureWithoutGuards(database, mutation) {
  const triggers = captureAndDropTriggers(database);
  database.pragma("ignore_check_constraints = ON");
  try {
    mutation();
  } finally {
    database.pragma("ignore_check_constraints = OFF");
    restoreTriggers(database, triggers);
  }
}

function managerIdentity(index) {
  return Object.freeze({
    userId: uuid(100 + index),
    membershipId: uuid(120 + index),
    teamId: uuid(140 + index),
    assignmentId: uuid(160 + index),
    fadTeamId: uuid(180 + index),
    cardId: uuid(200 + index),
    entryId: uuid(220 + index),
    openedRevisionId: uuid(240 + index),
    candidateRevisionId: uuid(260 + index),
    lockedRevisionId: uuid(280 + index),
    snapshotId: uuid(300 + index),
    snapshotEntryId: uuid(320 + index),
  });
}

function seedBase(database) {
  insert(database, "leagues", {
    id: IDS.league,
    name: "Candidate Allocation League",
    name_normalized:
      "candidate allocation league",
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
  insert(database, "users", {
    id: IDS.commissionerUser,
    email_normalized: "commissioner@example.test",
    email_display: "commissioner@example.test",
    display_name: "Commissioner",
    display_name_normalized: "commissioner",
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
    SET commissioner_membership_id = ?
    WHERE id = ?
  `).run(IDS.commissionerMembership, IDS.league);
  insert(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms:
      WEEK_ONE_AT_MS,
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
    baseline_at_ms:
      WEEK_ONE_AT_MS + 60 * 60 * 1000,
    locks_at_ms:
      WEEK_ONE_AT_MS + 2 * 60 * 60 * 1000,
    ends_at_ms:
      WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms:
      WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "players", {
    id: IDS.player,
    first_name: "Casey",
    last_name: "Candidate",
    full_name: "Casey Candidate",
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
  insert(
    database,
    "free_agent_draft_readiness_operations",
    {
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
    }
  );
  insert(database, "free_agent_drafts", {
    id: IDS.fad,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id:
      IDS.readiness,
    readiness_occurrence_key:
      `fad-readiness:${IDS.league}:${IDS.season}`,
    first_matchup_week_id: IDS.weekOne,
    current_competition_first_matchup_week_id:
      IDS.weekOne,
    schedule_recovery_id: null,
    participating_team_count: 4,
    status: "allocating",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason:
      "Inaugural league has no Entry Draft.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms:
      DEADLINE_AT_MS -
      48 * 60 * 60 * 1000,
    candidate_deadline_at_ms:
      DEADLINE_AT_MS,
    first_matchup_starts_at_ms:
      WEEK_ONE_AT_MS,
    deadline_locked_at_ms:
      DEADLINE_AT_MS,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 3,
  });
  insert(
    database,
    "free_agent_draft_rollovers",
    {
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
      creation_cutoff_at_ms:
        ROLLOVER_ONE_CREATION_CUTOFF_AT_MS,
      rolls_over_at_ms:
        DEADLINE_AT_MS + DAY_MS,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: OPENED_AT_MS,
      updated_at_ms: OPENED_AT_MS,
      version: 1,
    }
  );
  insert(
    database,
    "free_agent_draft_rollovers",
    {
      id: IDS.rolloverTwo,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      sequence: 2,
      window_kind: "initial",
      predecessor_rollover_id:
        IDS.rolloverOne,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms:
        DEADLINE_AT_MS + DAY_MS,
      creation_cutoff_at_ms:
        DEADLINE_AT_MS +
        2 * DAY_MS -
        60 * 60 * 1000,
      rolls_over_at_ms:
        DEADLINE_AT_MS + 2 * DAY_MS,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: OPENED_AT_MS,
      updated_at_ms: OPENED_AT_MS,
      version: 1,
    }
  );
}

function seedOffer(
  database,
  index,
  offer
) {
  const identity = managerIdentity(index);
  const aavCents = roundedAav(
    offer.totalValueCents,
    offer.termYears
  );
  const slotGroup =
    offer.slotGroup || "D";
  const positionGroup =
    offer.positionGroup || "D";
  const candidateStructuralConflict =
    offer.candidateStructuralConflict ===
    true;
  const carriedRosterStructuralConflictCount =
    offer.cardAllocationEligibility ===
      "excluded_structural_conflict"
      ? 1
      : 0;
  const structuralConflictCount =
    carriedRosterStructuralConflictCount +
    (candidateStructuralConflict ? 1 : 0);
  const overCap =
    offer.capStatus === "over_cap" ||
    offer.cardAllocationEligibility ===
      "excluded_over_cap";
  const capStatus = overCap
    ? "over_cap"
    : "compliant";
  const capLimitCents = overCap
    ? Math.max(0, aavCents - 1)
    : 10_000;
  const allocationExclusionReason =
    offer.cardAllocationEligibility ===
    "excluded_structural_conflict"
      ? "candidate_card_structural_conflict"
      : offer.cardAllocationEligibility ===
          "excluded_over_cap"
        ? "candidate_card_over_cap"
        : null;
  const proposedCandidateAavCents =
    candidateStructuralConflict ? 0 : aavCents;
  const missingMandatoryCount =
    candidateStructuralConflict ||
    slotGroup === "B"
      ? 18
      : 17;
  const filledMandatoryCount =
    18 - missingMandatoryCount;
  const filledBenchCount =
    !candidateStructuralConflict &&
    slotGroup === "B"
      ? 1
      : 0;
  const emptyBenchCount =
    4 - filledBenchCount;
  const candidateConflictCode =
    candidateStructuralConflict
      ? "CANDIDATE_POSITION_CHANGED"
      : null;
  const validationCode =
    offer.eligibilityStatus === "valid"
      ? null
      : offer.eligibilityStatus ===
          "warning"
        ? "CANDIDATE_WARNING"
        : "CANDIDATE_INVALID";

  insert(database, "users", {
    id: identity.userId,
    email_normalized:
      `manager-${index}@example.test`,
    email_display:
      `manager-${index}@example.test`,
    display_name: `Manager ${index}`,
    display_name_normalized:
      `manager ${index}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: identity.membershipId,
    league_id: IDS.league,
    user_id: identity.userId,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "teams", {
    id: identity.teamId,
    league_id: IDS.league,
    name: `Candidate Team ${index}`,
    name_normalized:
      `candidate team ${index}`,
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
  insert(
    database,
    "team_manager_assignments",
    {
      id: identity.assignmentId,
      league_id: IDS.league,
      team_id: identity.teamId,
      user_id: identity.userId,
      membership_id:
        identity.membershipId,
      assigned_by_user_id:
        identity.userId,
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: 1,
      accepted_at_ms: 1,
      ended_at_ms: null,
      version: 1,
    }
  );
  insert(
    database,
    "free_agent_draft_teams",
    {
      id: identity.fadTeamId,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      team_id: identity.teamId,
      team_status_at_setup: "active",
      created_at_ms: OPENED_AT_MS,
    }
  );
  insert(database, "candidate_cards", {
    id: identity.cardId,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: identity.teamId,
    status:
      structuralConflictCount > 0
        ? "locked_conflicted"
        : "locked_incomplete",
    completeness_code:
      structuralConflictCount > 0
        ? "conflicted"
        : "incomplete",
    filled_mandatory_count:
      filledMandatoryCount,
    missing_mandatory_count:
      missingMandatoryCount,
    filled_bench_count:
      filledBenchCount,
    empty_bench_count: emptyBenchCount,
    blocking_validation_count:
      offer.eligibilityStatus ===
      "invalid"
        ? 1
        : 0,
    structural_conflict_count:
      structuralConflictCount,
    carried_roster_structural_conflict_count:
      carriedRosterStructuralConflictCount,
    maximum_possible_cap_cents:
      proposedCandidateAavCents,
    locked_at_ms: DEADLINE_AT_MS,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 3,
    cap_status: capStatus,
    allocation_eligibility:
      offer.cardAllocationEligibility,
    allocation_exclusion_reason:
      allocationExclusionReason,
  });
  insert(
    database,
    "candidate_card_entries",
    {
      id: identity.entryId,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      card_id: identity.cardId,
      team_id: identity.teamId,
      entry_kind: "candidate",
      player_id: IDS.player,
      effective_position_group:
        positionGroup,
      requested_slot_group: slotGroup,
      requested_slot_number: 1,
      placement_state:
        candidateStructuralConflict
          ? "conflict"
          : "placed",
      conflict_code: candidateConflictCode,
      carryover_ownership_id: null,
      carryover_contract_id: null,
      source_roster_category: null,
      carryover_original_total_value_cents:
        null,
      carryover_original_term_years: null,
      carryover_aav_cents: null,
      remaining_years: null,
      proposed_total_value_cents:
        offer.totalValueCents,
      proposed_term_years:
        offer.termYears,
      proposed_aav_cents: aavCents,
      eligibility_status:
        offer.eligibilityStatus,
      validation_code: validationCode,
      last_acknowledgement_revision_id:
        null,
      created_by_user_id:
        identity.userId,
      created_by_membership_id:
        identity.membershipId,
      created_by_authority: "manager",
      last_edited_by_user_id:
        identity.userId,
      last_edited_by_membership_id:
        identity.membershipId,
      last_edited_by_authority:
        "manager",
      created_at_ms: OPENED_AT_MS + 1,
      updated_at_ms: OPENED_AT_MS + 1,
      version: 1,
    }
  );
  insert(
    database,
    "candidate_card_revisions",
    {
      id: identity.openedRevisionId,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      card_id: identity.cardId,
      team_id: identity.teamId,
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
    }
  );
  insert(
    database,
    "candidate_card_revisions",
    {
      id: identity.candidateRevisionId,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      card_id: identity.cardId,
      team_id: identity.teamId,
      resulting_card_version: 2,
      action: "candidate_added",
      affected_entry_id:
        identity.entryId,
      player_id: IDS.player,
      actor_user_id: identity.userId,
      actor_membership_id:
        identity.membershipId,
      actor_authority: "manager",
      before_evidence_json: "{}",
      after_evidence_json: "{}",
      potential_illegality_acknowledged: 0,
      warning_codes_json:
        validationCode === null
          ? "[]"
          : `["${validationCode}"]`,
      occurred_at_ms: OPENED_AT_MS + 1,
      created_at_ms: OPENED_AT_MS + 1,
      version: 1,
    }
  );
  insert(
    database,
    "candidate_card_revisions",
    {
      id: identity.lockedRevisionId,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      card_id: identity.cardId,
      team_id: identity.teamId,
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
    }
  );
  insert(
    database,
    "candidate_card_snapshots",
    {
      id: identity.snapshotId,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      card_id: identity.cardId,
      team_id: identity.teamId,
      locked_card_version: 3,
      locked_status:
        structuralConflictCount > 0
          ? "locked_conflicted"
          : "locked_incomplete",
      completeness_code:
        structuralConflictCount > 0
          ? "conflicted"
          : "incomplete",
      filled_mandatory_count:
        filledMandatoryCount,
      missing_mandatory_count:
        missingMandatoryCount,
      filled_bench_count:
        filledBenchCount,
      empty_bench_count: emptyBenchCount,
      blocking_validation_count:
        offer.eligibilityStatus ===
        "invalid"
          ? 1
          : 0,
      structural_conflict_count:
        structuralConflictCount,
      carried_roster_structural_conflict_count:
        carriedRosterStructuralConflictCount,
      cap_limit_cents: capLimitCents,
      carried_active_player_amount_cents:
        0,
      retention_obligation_cents: 0,
      buyout_penalty_cents: 0,
      carried_cap_usage_cents: 0,
      proposed_candidate_aav_cents:
        proposedCandidateAavCents,
      maximum_possible_cap_cents:
        proposedCandidateAavCents,
      maximum_cap_space_cents:
        capLimitCents -
        proposedCandidateAavCents,
      effective_deadline_at_ms:
        DEADLINE_AT_MS,
      processed_at_ms: DEADLINE_AT_MS,
      created_at_ms: DEADLINE_AT_MS,
      cap_status: capStatus,
      allocation_eligibility:
        offer.cardAllocationEligibility,
      allocation_exclusion_reason:
        allocationExclusionReason,
    }
  );
  insert(
    database,
    "candidate_card_snapshot_entries",
    {
      id: identity.snapshotEntryId,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      snapshot_id: identity.snapshotId,
      card_id: identity.cardId,
      team_id: identity.teamId,
      row_kind: candidateStructuralConflict
        ? "conflict"
        : "slot",
      occupant_kind: "candidate",
      slot_group: slotGroup,
      slot_number: 1,
      source_entry_id: identity.entryId,
      source_entry_version: 1,
      player_id: IDS.player,
      effective_position_group:
        positionGroup,
      conflict_code: candidateConflictCode,
      carryover_ownership_id: null,
      carryover_contract_id: null,
      source_roster_category: null,
      carryover_original_total_value_cents:
        null,
      carryover_original_term_years: null,
      carryover_aav_cents: null,
      remaining_years: null,
      proposed_total_value_cents:
        offer.totalValueCents,
      proposed_term_years:
        offer.termYears,
      proposed_aav_cents: aavCents,
      eligibility_status:
        offer.eligibilityStatus,
      validation_code: validationCode,
      last_edited_by_user_id:
        identity.userId,
      last_edited_by_membership_id:
        identity.membershipId,
      last_edited_by_authority:
        "manager",
      last_edited_at_ms:
        OPENED_AT_MS + 1,
      created_at_ms: DEADLINE_AT_MS,
      allocation_eligibility:
        offer.cardAllocationEligibility,
      allocation_exclusion_reason:
        allocationExclusionReason,
    }
  );
  return identity;
}

function seedAllocationJob(
  database,
  nowMs
) {
  insert(
    database,
    "free_agent_draft_player_allocations",
    {
      id: IDS.allocation,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      player_id: IDS.player,
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
    }
  );
  insert(database, "job_runs", {
    id: IDS.allocationJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: ALLOCATION_JOB_TYPE,
    occurrence_key:
      buildFreeAgentDraftAllocationOccurrenceKey({
        fadId: IDS.fad,
        playerId: IDS.player,
      }),
    scheduled_for_ms: DEADLINE_AT_MS,
    status: "leased",
    attempt_count: 1,
    lease_owner: LEASE_OWNER,
    lease_expires_at_ms:
      nowMs + 60 * 60 * 1000,
    started_at_ms: nowMs - 1,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: nowMs - 1,
    version: 3,
    lease_token: LEASE_TOKEN,
    next_attempt_at_ms: null,
  });
}

function createRuntime(
  t,
  {
    offers,
    nowMs,
    allowImmediateRestrictedActivation = false,
    beforeCommit,
  }
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-candidate-allocation-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
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
      migrationsDirectory:
        MIGRATIONS_DIRECTORY,
    }),
    applicationBuildId:
      "candidate-allocation-repository-foundation",
    now: () => 1,
  });

  const triggers = captureAndDropTriggers(
    connection.database
  );
  seedBase(connection.database);
  const identities = offers.map(
    (offer, index) =>
      seedOffer(
        connection.database,
        index + 1,
        offer
      )
  );
  seedAllocationJob(
    connection.database,
    nowMs
  );
  restoreTriggers(
    connection.database,
    triggers
  );

  let generated = 8_000;
  const repository =
    createSqliteCandidateAllocationRepository({
      database: connection.database,
      notificationWriter:
        createSqliteNotificationWriter({
          database: connection.database,
        }),
      createId() {
        generated += 1;
        return uuid(generated);
      },
      createDrawNonce() {
        return Buffer.alloc(32, 0x5a);
      },
      allowImmediateRestrictedActivation,
      beforeCommit,
    });
  const command = Object.freeze({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    playerId: IDS.player,
    expectedAllocationVersion: 1,
    jobRunId: IDS.allocationJob,
    expectedJobVersion: 3,
    leaseOwner: LEASE_OWNER,
    leaseToken: LEASE_TOKEN,
    nowMs,
  });
  return Object.freeze({
    database: connection.database,
    repository,
    command,
    identities,
  });
}

function rows(database, tableName) {
  return database
    .prepare(
      `SELECT * FROM ${tableName} ORDER BY id`
    )
    .all();
}

function injectAllocationSemanticRace(
  runtime,
  kind
) {
  const triggers = captureAndDropTriggers(
    runtime.database
  );
  const winner = runtime.identities[0];
  if (kind === "player_ownership") {
    insert(
      runtime.database,
      "player_ownerships",
      {
        id: uuid(9_001),
        league_id: IDS.league,
        season_id: IDS.season,
        player_id: IDS.player,
        team_id: winner.teamId,
        ownership_kind: "Rostered",
        roster_category: "Active",
        position_group: "D",
        slot_number: 2,
        acquired_transaction_type:
          "commissioner_correction",
        acquired_transaction_id: null,
        created_at_ms: DEADLINE_AT_MS,
        updated_at_ms: DEADLINE_AT_MS,
        version: 1,
      }
    );
  } else if (kind === "active_contract") {
    insert(runtime.database, "contracts", {
      id: uuid(9_004),
      league_id: IDS.league,
      player_id: IDS.player,
      current_team_id: winner.teamId,
      contract_type: "normal",
      original_total_value_cents: 600,
      original_term_years: 1,
      aav_cents: 600,
      start_season_id: IDS.season,
      status: "active",
      acquisition_source_type:
        "commissioner_correction",
      acquisition_source_id: null,
      auction_buyout_lock_expires_at_ms:
        null,
      created_at_ms: DEADLINE_AT_MS,
      updated_at_ms: DEADLINE_AT_MS,
      version: 1,
    });
  } else if (kind === "active_auction") {
    insert(runtime.database, "auctions", {
      id: uuid(9_005),
      league_id: IDS.league,
      season_id: IDS.season,
      player_id: IDS.player,
      status: "open",
      opened_at_ms: DEADLINE_AT_MS,
      resolves_at_ms:
        DEADLINE_AT_MS + DAY_MS,
      opened_by_user_id: null,
      created_at_ms: DEADLINE_AT_MS,
      updated_at_ms: DEADLINE_AT_MS,
      version: 1,
    });
    insert(
      runtime.database,
      "auction_contexts",
      {
        id: uuid(9_005),
        league_id: IDS.league,
        season_id: IDS.season,
        auction_id: uuid(9_005),
        source_kind: "ordinary_weekly",
        fad_id: null,
        fad_rollover_id: null,
        fad_allocation_id: null,
        fad_origin: null,
        created_at_ms: DEADLINE_AT_MS,
      }
    );
  } else if (kind === "requested_slot") {
    const occupantPlayerId = uuid(9_002);
    insert(runtime.database, "players", {
      id: occupantPlayerId,
      first_name: "Existing",
      last_name: "Occupant",
      full_name: "Existing Occupant",
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(
      runtime.database,
      "player_ownerships",
      {
        id: uuid(9_003),
        league_id: IDS.league,
        season_id: IDS.season,
        player_id: occupantPlayerId,
        team_id: winner.teamId,
        ownership_kind: "Rostered",
        roster_category: "Active",
        position_group: "D",
        slot_number: 1,
        acquired_transaction_type:
          "commissioner_correction",
        acquired_transaction_id: null,
        created_at_ms: DEADLINE_AT_MS,
        updated_at_ms: DEADLINE_AT_MS,
        version: 1,
      }
    );
  } else if (
    kind === "destination_mismatch"
  ) {
    runtime.database.prepare(`
      UPDATE candidate_card_entries
      SET version = version + 1,
          updated_at_ms = updated_at_ms + 1
      WHERE league_id = ?
        AND id = ?
    `).run(IDS.league, winner.entryId);
  } else {
    throw new Error(
      `Unsupported semantic race fixture: ${kind}`
    );
  }
  restoreTriggers(runtime.database, triggers);
}

function assertCorrectionRequiredResult(
  runtime,
  result,
  errorCode,
  issueKind
) {
  assert.equal(
    result.status,
    "correction_required"
  );
  assert.equal(result.decisionCode, null);
  assert.equal(result.winner, null);
  assert.equal(
    result.restrictedAuction,
    null
  );
  assert.equal(
    result.recovery.kind,
    "allocation_retry"
  );
  assert.equal(
    result.recovery.status,
    "correction_required"
  );
  assert.equal(
    result.recovery.errorCode,
    errorCode
  );
  const allocation =
    runtime.repository.findAllocation({
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      playerId: IDS.player,
    });
  assert.equal(
    allocation.status,
    "correction_required"
  );
  assert.equal(
    allocation.lastErrorCode,
    errorCode
  );
  assert.equal(allocation.version, 2);

  const recoveries = rows(
    runtime.database,
    "free_agent_draft_recoveries"
  );
  assert.equal(recoveries.length, 1);
  assert.deepEqual(
    {
      id: recoveries[0].id,
      allocationId:
        recoveries[0].allocation_id,
      playerId: recoveries[0].player_id,
      jobRunId: recoveries[0].job_run_id,
      kind: recoveries[0].kind,
      status: recoveries[0].status,
      errorCode:
        recoveries[0].last_error_code,
      createdByOperationId:
        recoveries[0]
          .created_by_operation_id,
      createdAtMs:
        recoveries[0].created_at_ms,
    },
    {
      id: result.recovery.id,
      allocationId: IDS.allocation,
      playerId: IDS.player,
      jobRunId: IDS.allocationJob,
      kind: "allocation_retry",
      status: "correction_required",
      errorCode,
      createdByOperationId:
        IDS.allocationJob,
      createdAtMs:
        runtime.command.nowMs,
    }
  );

  const events = rows(
    runtime.database,
    "free_agent_draft_allocation_events"
  );
  assert.equal(events.length, 2);
  const offerEvents = events.filter(
    (event) =>
      event.event_kind ===
      "offer_considered"
  );
  assert.equal(offerEvents.length, 1);
  assert.deepEqual(
    result.evidence.offerEventIds,
    offerEvents.map((event) => event.id)
  );
  assert.deepEqual(
    {
      snapshotEntryId:
        offerEvents[0]
          .snapshot_entry_id,
      teamId: offerEvents[0].team_id,
      offerValid:
        offerEvents[0].offer_valid,
      rankPosition:
        offerEvents[0].rank_position,
      outcomeCode:
        offerEvents[0]
          .offer_outcome_code,
      decisionCode:
        offerEvents[0].decision_code,
      status:
        offerEvents[0]
          .resulting_allocation_status,
      contractId:
        offerEvents[0].contract_id,
      ownershipId:
        offerEvents[0].ownership_id,
      auctionId:
        offerEvents[0].auction_id,
      occurredAtMs:
        offerEvents[0].occurred_at_ms,
    },
    {
      snapshotEntryId:
        runtime.identities[0]
          .snapshotEntryId,
      teamId: runtime.identities[0].teamId,
      offerValid: 1,
      rankPosition: 1,
      outcomeCode: "winner",
      decisionCode: null,
      status: "correction_required",
      contractId: null,
      ownershipId: null,
      auctionId: null,
      occurredAtMs:
        runtime.command.nowMs,
    }
  );
  const offerEvidence = JSON.parse(
    offerEvents[0].evidence_json
  );
  assert.equal(
    offerEvidence.offer.offerId,
    runtime.identities[0].snapshotEntryId
  );
  assert.equal(
    offerEvidence.outcomeCode,
    "winner"
  );
  assert.equal(
    offerEvidence.offerValid,
    true
  );
  assert.equal(
    offerEvidence.rankPosition,
    1
  );
  const decisionEvents = events.filter(
    (event) =>
      event.event_kind ===
      "decision_recorded"
  );
  assert.equal(decisionEvents.length, 1);
  assert.deepEqual(
    {
      id: decisionEvents[0].id,
      kind: decisionEvents[0].event_kind,
      allocationVersion:
        decisionEvents[0]
          .allocation_version,
      decisionCode:
        decisionEvents[0].decision_code,
      status:
        decisionEvents[0]
          .resulting_allocation_status,
      occurredAtMs:
        decisionEvents[0].occurred_at_ms,
    },
    {
      id: result.evidence.decisionEventId,
      kind: "decision_recorded",
      allocationVersion: 2,
      decisionCode: null,
      status: "correction_required",
      occurredAtMs:
        runtime.command.nowMs,
    }
  );
  const evidence = JSON.parse(
    decisionEvents[0].evidence_json
  );
  assert.equal(
    evidence.operation,
    "free_agent_draft_allocation_quarantined"
  );
  assert.equal(evidence.issue.code, errorCode);
  assert.equal(evidence.issue.kind, issueKind);

  const job = runtime.database.prepare(`
    SELECT *
    FROM job_runs
    WHERE league_id = ? AND id = ?
  `).get(IDS.league, IDS.allocationJob);
  assert.deepEqual(
    {
      status: job.status,
      version: job.version,
      leaseOwner: job.lease_owner,
      leaseToken: job.lease_token,
      leaseExpiresAtMs:
        job.lease_expires_at_ms,
      completedAtMs: job.completed_at_ms,
      resultJson: job.result_json,
      errorCode: job.last_error_code,
      nextAttemptAtMs:
        job.next_attempt_at_ms,
    },
    {
      status: "failed",
      version: 4,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtMs: null,
      completedAtMs:
        runtime.command.nowMs,
      resultJson: null,
      errorCode,
      nextAttemptAtMs:
        8_640_000_000_000_000,
    }
  );
  const notificationRows = rows(
    runtime.database,
    "notifications"
  );
  assert.equal(notificationRows.length, 1);
  const correctionNotification =
    notificationRows[0];
  assert.equal(
    correctionNotification.user_id,
    IDS.commissionerUser
  );
  assert.equal(
    correctionNotification.event_type,
    "fad_correction_required"
  );
  assert.equal(
    correctionNotification.deduplication_key,
    `fad:${IDS.fad}:correction-required:` +
      `${result.recovery.id}:${IDS.commissionerUser}`
  );
  assert.deepEqual(
    JSON.parse(
      correctionNotification.message_data_json
    ),
    {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      auctionId: null,
      recoveryId: result.recovery.id,
      playerId: IDS.player,
      errorCode,
      destination: {
        kind: "fad_recovery",
        leagueId: IDS.league,
        fadId: IDS.fad,
        recoveryId: result.recovery.id,
      },
    }
  );
  const publicationRows = rows(
    runtime.database,
    "outbox_events"
  );
  assert.equal(publicationRows.length, 2);
  assert.deepEqual(
    publicationRows
      .map((row) => row.event_type)
      .sort(),
    [
      "free_agent_draft.changed",
      "notification.created",
    ]
  );
  const related = createEmptySocketRelated({
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    recoveryId: result.recovery.id,
  });
  for (const publication of publicationRows) {
    const notificationPublication =
      publication.event_type ===
      "notification.created";
    assert.deepEqual(
      JSON.parse(publication.payload_json),
      createSocketEventEnvelope({
        eventId: publication.id,
        type: publication.event_type,
        leagueId: IDS.league,
        resourceId: notificationPublication
          ? correctionNotification.id
          : IDS.fad,
        version: notificationPublication ? 1 : 3,
        reasonCode: "allocation_changed",
        occurredAt: runtime.command.nowMs,
        related,
      })
    );
    assert.doesNotMatch(
      publication.payload_json,
      new RegExp(IDS.player, "u")
    );
    const audiences = runtime.database
      .prepare(`
        SELECT audience_kind, team_id, user_id
        FROM outbox_event_audiences
        WHERE league_id = ?
          AND outbox_event_id = ?
      `)
      .all(IDS.league, publication.id);
    assert.deepEqual(
      audiences,
      notificationPublication
        ? [
            {
              audience_kind: "user",
              team_id: null,
              user_id: IDS.commissionerUser,
            },
          ]
        : [
            {
              audience_kind: "league",
              team_id: null,
              user_id: null,
            },
          ]
    );
  }
  assert.equal(
    result.evidence.outboxEventId,
    publicationRows.find(
      (row) =>
        row.event_type ===
        "free_agent_draft.changed"
    ).id
  );
  const replay =
    runtime.repository.resolvePending(
      runtime.command
    );
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    {
      ...replay,
      replayed: false,
    },
    result
  );
}

function assertRepositoryError(
  callback,
  code
) {
  assert.throws(
    callback,
    (error) =>
      error instanceof
        SqliteRepositoryError &&
      error.code === code
  );
}

describe(
  "SQLite Candidate allocation repository foundation",
  () => {
    test(
      "persists one exact warning-offer direct award atomically and replays its immutable result",
      (t) => {
        const nowMs =
          DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "warning",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "B",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 3,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 900,
              termYears: 3,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "excluded_over_cap",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });

        assert.deepEqual(
          CANDIDATE_ALLOCATION_REPOSITORY_METHODS,
          [
            "findAllocation",
            "resolvePending",
          ]
        );
        const result =
          runtime.repository.resolvePending(
            runtime.command
          );

        assert.equal(result.replayed, false);
        assert.equal(
          result.status,
          "automatic_award"
        );
        assert.equal(
          result.decisionCode,
          "highest_equal_total_aav"
        );
        assert.equal(
          result.winner.snapshotEntryId,
          runtime.identities[0]
            .snapshotEntryId
        );
        assert.equal(
          result.winner.teamId,
          runtime.identities[0].teamId
        );
        assert.deepEqual(
          result.winner.requestedSlot,
          {
            rosterCategory: "Bench",
            positionGroup: "D",
            slotNumber: 1,
          }
        );
        assert.equal(
          result.winner
            .buyoutLockExpiresAtMs,
          nowMs + BUYOUT_LOCK_MS
        );

        const allocation =
          runtime.repository.findAllocation({
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            playerId: IDS.player,
          });
        assert.equal(
          allocation.status,
          "automatic_award"
        );
        assert.equal(allocation.version, 2);
        assert.equal(
          allocation.winningTeamId,
          runtime.identities[0].teamId
        );
        assert.equal(
          allocation.contractId,
          result.winner.contractId
        );
        assert.equal(
          allocation.ownershipId,
          result.winner.ownershipId
        );

        const contract = rows(
          runtime.database,
          "contracts"
        )[0];
        assert.equal(
          contract.original_total_value_cents,
          600
        );
        assert.equal(
          contract.original_term_years,
          2
        );
        assert.equal(contract.aav_cents, 300);
        assert.equal(
          contract.acquisition_source_type,
          "free_agent_draft_allocation"
        );
        assert.equal(
          contract.acquisition_source_id,
          IDS.allocation
        );
        assert.equal(
          contract.auction_buyout_lock_expires_at_ms,
          nowMs + BUYOUT_LOCK_MS
        );
        assert.deepEqual(
          rows(
            runtime.database,
            "contract_years"
          ).map((year) => [
            year.year_number,
            year.status,
            year.aav_cents,
          ]),
          [
            [1, "current", 300],
            [2, "future", 300],
          ]
        );
        const ownership = rows(
          runtime.database,
          "player_ownerships"
        )[0];
        assert.equal(
          ownership.team_id,
          runtime.identities[0].teamId
        );
        assert.equal(
          ownership.roster_category,
          "Bench"
        );
        assert.equal(
          ownership.position_group,
          "D"
        );
        assert.equal(
          ownership.slot_number,
          1
        );
        assert.equal(
          ownership.acquired_transaction_type,
          "free_agent_draft_allocation"
        );

        const offerEvents = rows(
          runtime.database,
          "free_agent_draft_allocation_events"
        ).filter(
          (event) =>
            event.event_kind ===
            "offer_considered"
        );
        assert.deepEqual(
          offerEvents
            .sort(compareOfferEvidenceRank)
            .map((event) => [
              event.team_id,
              event.offer_valid,
              event.rank_position,
              event.offer_outcome_code,
            ]),
          [
            [
              runtime.identities[0].teamId,
              1,
              1,
              "winner",
            ],
            [
              runtime.identities[1].teamId,
              1,
              2,
              "lost_lower_aav",
            ],
            [
              runtime.identities[2].teamId,
              0,
              null,
              "excluded_over_cap",
            ],
          ]
        );
        assert.equal(
          rows(
            runtime.database,
            "league_activity"
          ).length,
          1
        );
        assert.equal(
          rows(
            runtime.database,
            "outbox_events"
          ).length,
          2
        );
        const allocationPublications = rows(
          runtime.database,
          "outbox_events"
        );
        assert.deepEqual(
          allocationPublications
            .map((event) => event.event_type)
            .sort(),
          [
            "activity.created",
            "free_agent_draft.changed",
          ]
        );
        const publicationRelated =
          createEmptySocketRelated({
            fadId: IDS.fad,
            teamId:
              runtime.identities[0].teamId,
            cardId:
              runtime.identities[0].cardId,
            allocationId: IDS.allocation,
          });
        for (const publication of
          allocationPublications) {
          const activityPublication =
            publication.event_type ===
            "activity.created";
          assert.deepEqual(
            JSON.parse(publication.payload_json),
            createSocketEventEnvelope({
              eventId: publication.id,
              type: publication.event_type,
              leagueId: IDS.league,
              resourceId:
                activityPublication
                  ? result.evidence.activityId
                  : IDS.fad,
              version:
                activityPublication ? 1 : 3,
              reasonCode:
                "allocation_changed",
              occurredAt: nowMs,
              related: publicationRelated,
            })
          );
        }
        assert.equal(
          rows(
            runtime.database,
            "outbox_event_audiences"
          )[0].audience_kind,
          "league"
        );
        assert.equal(
          rows(
            runtime.database,
            "notifications"
          ).length,
          0
        );
        const job = runtime.database
          .prepare(
            "SELECT * FROM job_runs WHERE id = ?"
          )
          .get(IDS.allocationJob);
        assert.equal(job.status, "succeeded");
        assert.equal(job.version, 4);
        assert.equal(job.lease_owner, null);
        assert.equal(job.lease_token, null);
        assert.equal(job.completed_at_ms, nowMs);

        const countsBeforeReplay = {
          contracts: rows(
            runtime.database,
            "contracts"
          ).length,
          ownerships: rows(
            runtime.database,
            "player_ownerships"
          ).length,
          events: rows(
            runtime.database,
            "free_agent_draft_allocation_events"
          ).length,
          activity: rows(
            runtime.database,
            "league_activity"
          ).length,
          outbox: rows(
            runtime.database,
            "outbox_events"
          ).length,
        };
        const replay =
          runtime.repository.resolvePending(
            runtime.command
          );
        assert.equal(replay.replayed, true);
        assert.deepEqual(
          {
            ...replay,
            replayed: false,
          },
          result
        );
        assert.deepEqual(
          {
            contracts: rows(
              runtime.database,
              "contracts"
            ).length,
            ownerships: rows(
              runtime.database,
              "player_ownerships"
            ).length,
            events: rows(
              runtime.database,
              "free_agent_draft_allocation_events"
            ).length,
            activity: rows(
              runtime.database,
              "league_activity"
            ).length,
            outbox: rows(
              runtime.database,
              "outbox_events"
            ).length,
          },
          countsBeforeReplay
        );
      }
    );

    test(
      "keeps an automatic result league-only when the snapshot manager is no longer active",
      (t) => {
        const nowMs = DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });
        mutateFixtureWithoutGuards(
          runtime.database,
          () => {
            runtime.database.prepare(`
              UPDATE users
              SET status = 'suspended'
              WHERE id = ?
            `).run(runtime.identities[0].userId);
          }
        );

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );
        assert.equal(
          result.status,
          "automatic_award"
        );
        assert.equal(
          rows(runtime.database, "notifications").length,
          0
        );
        assert.deepEqual(
          rows(
            runtime.database,
            "outbox_event_audiences"
          ).map((audience) => ({
            kind: audience.audience_kind,
            teamId: audience.team_id,
            userId: audience.user_id,
          })),
          [
            {
              kind: "league",
              teamId: null,
              userId: null,
            },
            {
              kind: "league",
              teamId: null,
              userId: null,
            },
          ]
        );
        const beforeReplay =
          runtime.database.serialize();
        assert.equal(
          runtime.repository.resolvePending(
            runtime.command
          ).replayed,
          true
        );
        assert.equal(
          beforeReplay.equals(
            runtime.database.serialize()
          ),
          true
        );
      }
    );

    test(
      "excludes a real Candidate conflict snapshot row before ranking otherwise eligible warning offers",
      (t) => {
        const nowMs =
          DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 900,
              termYears: 1,
              eligibilityStatus: "warning",
              cardAllocationEligibility:
                "eligible",
              candidateStructuralConflict:
                true,
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );

        assert.equal(
          result.status,
          "automatic_award"
        );
        assert.equal(
          result.decisionCode,
          "sole_valid_offer"
        );
        assert.equal(
          result.winner.snapshotEntryId,
          runtime.identities[1]
            .snapshotEntryId
        );
        assert.equal(
          result.winner.teamId,
          runtime.identities[1].teamId
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                snapshot_entry.row_kind,
                snapshot_entry.conflict_code,
                current_entry.placement_state,
                current_entry.conflict_code AS current_conflict_code
              FROM candidate_card_snapshot_entries AS snapshot_entry
              JOIN candidate_card_entries AS current_entry
                ON current_entry.id = snapshot_entry.source_entry_id
              WHERE snapshot_entry.id = ?
            `)
            .get(
              runtime.identities[0]
                .snapshotEntryId
            ),
          {
            row_kind: "conflict",
            conflict_code:
              "CANDIDATE_POSITION_CHANGED",
            placement_state: "conflict",
            current_conflict_code:
              "CANDIDATE_POSITION_CHANGED",
          }
        );
        assert.deepEqual(
          rows(
            runtime.database,
            "free_agent_draft_allocation_events"
          )
            .filter(
              (event) =>
                event.event_kind ===
                "offer_considered"
            )
            .sort(compareOfferEvidenceRank)
            .map((event) => [
              event.team_id,
              event.offer_valid,
              event.offer_outcome_code,
            ]),
          [
            [
              runtime.identities[1].teamId,
              1,
              "winner",
            ],
            [
              runtime.identities[0].teamId,
              0,
              "invalid",
            ],
          ]
        );
        assert.equal(
          rows(
            runtime.database,
            "contracts"
          )[0].current_team_id,
          runtime.identities[1].teamId
        );
        assert.equal(
          rows(
            runtime.database,
            "auctions"
          ).length,
          0
        );
      }
    );

    test(
      "binds the rapid milestone to automatic-award activity and scoped outbox evidence",
      (t) => {
        const nowMs =
          DEADLINE_AT_MS + 1_000;
        const offer = {
          totalValueCents: 600,
          termYears: 2,
          eligibilityStatus: "valid",
          cardAllocationEligibility:
            "eligible",
          slotGroup: "D",
          positionGroup: "D",
        };
        const transitionToRapid =
          (database) => {
            database
              .prepare(`
                UPDATE free_agent_drafts
                SET status = 'rapid',
                    allocation_completed_at_ms = @atMs,
                    updated_at_ms = @atMs,
                    version = version + 1
                WHERE id = @fadId
              `)
              .run({
                fadId: IDS.fad,
                atMs: nowMs + 1,
              });
          };

        const complete = createRuntime(t, {
          nowMs,
          offers: [offer],
        });
        complete.repository.resolvePending(
          complete.command
        );
        assert.doesNotThrow(() => {
          transitionToRapid(complete.database);
        });

        const incomplete = createRuntime(t, {
          nowMs,
          offers: [offer],
        });
        incomplete.repository.resolvePending(
          incomplete.command
        );
        const triggers = captureAndDropTriggers(
          incomplete.database
        );
        incomplete.database
          .prepare(`
            UPDATE league_activity
            SET event_type = 'fad_candidate_no_valid_offer'
            WHERE league_id = ?
              AND related_type = 'free_agent_draft_allocation'
              AND related_id = ?
          `)
          .run(IDS.league, IDS.allocation);
        incomplete.database
          .prepare(`
            DELETE FROM outbox_event_audiences
            WHERE league_id = ?
          `)
          .run(IDS.league);
        restoreTriggers(
          incomplete.database,
          triggers
        );

        assert.throws(
          () =>
            transitionToRapid(
              incomplete.database
            ),
          /automatic-award activity and scoped outbox evidence/i
        );
      }
    );

    test(
      "fails closed by scheduling a pre-cutoff exact tie for the complete next rollover by default",
      (t) => {
        const nowMs = DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "warning",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );

        assert.equal(
          result.status,
          "restricted_scheduled"
        );
        assert.equal(
          result.restrictedAuction
            .activationMode,
          "rollover_scheduled"
        );
        assert.equal(
          result.restrictedAuction.rolloverId,
          IDS.rolloverTwo
        );
        assert.equal(
          result.restrictedAuction.openedAtMs,
          ROLLOVER_ONE_AT_MS
        );
        assert.equal(
          result.restrictedAuction
            .activationAtMs,
          ROLLOVER_ONE_AT_MS
        );
        assert.equal(
          result.restrictedAuction.resolvesAtMs,
          DEADLINE_AT_MS + 2 * DAY_MS
        );
        assert.deepEqual(
          runtime.database.prepare(`
            SELECT status, scheduled_for_ms
            FROM job_runs
            WHERE id = ?
          `).get(
            result.restrictedAuction
              .activationJobRunId
          ),
          {
            status: "pending",
            scheduled_for_ms:
              ROLLOVER_ONE_AT_MS,
          }
        );
      }
    );

    test(
      "activates an exact tie before cutoff only through the explicit compatibility capability",
      (t) => {
        const nowMs =
          ROLLOVER_ONE_CREATION_CUTOFF_AT_MS -
          1;
        const runtime = createRuntime(t, {
          nowMs,
          allowImmediateRestrictedActivation:
            true,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "warning",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );

        assert.equal(
          result.status,
          "restricted_active"
        );
        assert.equal(
          result.restrictedAuction
            .activationMode,
          "immediate"
        );
        assert.equal(
          result.restrictedAuction.rolloverId,
          IDS.rolloverOne
        );
        assert.equal(
          result.restrictedAuction.openedAtMs,
          nowMs
        );
        assert.equal(
          result.restrictedAuction.activationAtMs,
          nowMs
        );
        assert.equal(
          result.restrictedAuction.resolvesAtMs,
          DEADLINE_AT_MS + DAY_MS
        );
        assert.equal(
          result.restrictedAuction
            .activationJobRunId,
          null
        );
        assert.equal(
          result.restrictedAuction
            .activationOccurrenceKey,
          null
        );
        assert.equal(
          runtime.repository.findAllocation({
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            playerId: IDS.player,
          }).status,
          "restricted_active"
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT COUNT(*) AS count FROM job_runs WHERE job_type = ?"
            )
            .get(
              RESTRICTED_ACTIVATION_JOB_TYPE
            ).count,
          0
        );
        assert.equal(
          result.restrictedAuction.participants.every(
            (participant) =>
              typeof participant.notificationId === "string"
          ),
          true
        );
        assert.equal(
          runtime.database.prepare(`
            SELECT COUNT(*) AS count
            FROM notifications
            WHERE league_id = ?
              AND event_type = 'fad_restricted_eligible'
          `).get(IDS.league).count,
          2
        );
        assert.equal(
          runtime.database.prepare(`
            SELECT COUNT(*) AS count
            FROM outbox_events
            WHERE league_id = ?
              AND event_type = 'notification.created'
          `).get(IDS.league).count,
          2
        );
        const immediateAuctionPublication =
          runtime.database.prepare(`
            SELECT *
            FROM outbox_events
            WHERE league_id = @leagueId
              AND event_type = 'auction.changed'
              AND aggregate_type = 'auction'
              AND aggregate_id = @auctionId
          `).get({
            leagueId: IDS.league,
            auctionId:
              result.restrictedAuction.auctionId,
          });
        assert.ok(immediateAuctionPublication);
        assert.deepEqual(
          JSON.parse(
            immediateAuctionPublication.payload_json
          ),
          createSocketEventEnvelope({
            eventId:
              immediateAuctionPublication.id,
            type: "auction.changed",
            leagueId: IDS.league,
            resourceId:
              result.restrictedAuction.auctionId,
            version: 1,
            reasonCode: "auction_changed",
            occurredAt: nowMs,
            related: createEmptySocketRelated({
              fadId: IDS.fad,
              allocationId: IDS.allocation,
              auctionId:
                result.restrictedAuction.auctionId,
            }),
          })
        );
        assert.equal(
          rows(
            runtime.database,
            "auction_bids"
          ).length,
          0
        );
        assert.equal(
          runtime.repository.resolvePending(
            runtime.command
          ).replayed,
          true
        );
      }
    );

    test(
      "schedules an exact tie at the current rapid-window creation cutoff",
      (t) => {
        const nowMs =
          ROLLOVER_ONE_CREATION_CUTOFF_AT_MS;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "warning",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );

        assert.equal(
          result.status,
          "restricted_scheduled"
        );
        assert.equal(
          result.restrictedAuction
            .activationMode,
          "rollover_scheduled"
        );
        assert.equal(
          result.restrictedAuction.rolloverId,
          IDS.rolloverTwo
        );
        assert.equal(
          result.restrictedAuction.openedAtMs,
          DEADLINE_AT_MS + DAY_MS
        );
        assert.equal(
          result.restrictedAuction.activationAtMs,
          DEADLINE_AT_MS + DAY_MS
        );
        assert.equal(
          result.restrictedAuction.resolvesAtMs,
          DEADLINE_AT_MS + 2 * DAY_MS
        );

        const activationJobs =
          runtime.database
            .prepare(`
              SELECT
                id,
                job_type,
                league_id,
                season_id,
                occurrence_key,
                scheduled_for_ms,
                status
              FROM job_runs
              WHERE job_type = ?
            `)
            .all(
              RESTRICTED_ACTIVATION_JOB_TYPE
            );
        assert.deepEqual(activationJobs, [
          {
            id:
              result.restrictedAuction
                .activationJobRunId,
            job_type:
              RESTRICTED_ACTIVATION_JOB_TYPE,
            league_id: IDS.league,
            season_id: IDS.season,
            occurrence_key:
              buildFreeAgentDraftRestrictedActivationOccurrenceKey(
                {
                  fadId: IDS.fad,
                  allocationId:
                    IDS.allocation,
                  activationAtMs:
                    DEADLINE_AT_MS +
                    DAY_MS,
                }
              ),
            scheduled_for_ms:
              DEADLINE_AT_MS + DAY_MS,
            status: "pending",
          },
        ]);
      }
    );

    test(
      "persists an exact warning-offer tie as a restricted future-window auction with minimum evidence but no bids",
      (t) => {
        const nowMs =
          DEADLINE_AT_MS +
          DAY_MS -
          30 * 60 * 1000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "warning",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 3,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 900,
              termYears: 3,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "excluded_over_cap",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );

        assert.equal(result.replayed, false);
        assert.equal(
          result.status,
          "restricted_scheduled"
        );
        assert.equal(
          result.decisionCode,
          "exact_total_and_term_tie"
        );
        assert.equal(result.winner, null);
        assert.deepEqual(
          result.restrictedAuction.floor,
          {
            totalValueCents: 600,
            termYears: 2,
            aavCents: 300,
          }
        );
        assert.equal(
          result.restrictedAuction
            .activationMode,
          "rollover_scheduled"
        );
        assert.equal(
          result.restrictedAuction.rolloverId,
          IDS.rolloverTwo
        );
        assert.equal(
          result.restrictedAuction.openedAtMs,
          DEADLINE_AT_MS + DAY_MS
        );
        assert.equal(
          result.restrictedAuction.resolvesAtMs,
          DEADLINE_AT_MS + 2 * DAY_MS
        );
        assert.deepEqual(
          result.restrictedAuction.participants
            .map(
              (participant) =>
                participant.teamId
            )
            .sort(),
          [
            runtime.identities[0].teamId,
            runtime.identities[1].teamId,
          ].sort()
        );
        assert.equal(
          result.restrictedAuction.participants.every(
            (participant) => participant.notificationId === null
          ),
          true
        );

        const allocation =
          runtime.repository.findAllocation({
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            playerId: IDS.player,
          });
        assert.equal(
          allocation.status,
          "restricted_scheduled"
        );
        assert.equal(allocation.version, 2);
        assert.equal(
          allocation.restrictedAuctionId,
          result.restrictedAuction.auctionId
        );
        assert.deepEqual(
          allocation.restrictedMinimum,
          result.restrictedAuction.floor
        );

        const auctions = rows(
          runtime.database,
          "auctions"
        );
        assert.equal(auctions.length, 1);
        assert.equal(
          auctions[0].opened_at_ms,
          DEADLINE_AT_MS + DAY_MS
        );
        assert.equal(
          auctions[0].resolves_at_ms,
          DEADLINE_AT_MS + 2 * DAY_MS
        );
        const context = rows(
          runtime.database,
          "auction_contexts"
        )[0];
        assert.equal(
          context.source_kind,
          "fad_restricted"
        );
        assert.equal(
          context.fad_rollover_id,
          IDS.rolloverTwo
        );
        assert.equal(
          context.fad_allocation_id,
          IDS.allocation
        );

        const participants = rows(
          runtime.database,
          "free_agent_draft_auction_participants"
        );
        assert.equal(participants.length, 2);
        for (const participant of participants) {
          assert.equal(
            participant.status,
            "active"
          );
          assert.equal(
            participant.minimum_total_value_cents,
            600
          );
          assert.equal(
            participant.minimum_term_years,
            2
          );
          assert.equal(
            participant.minimum_aav_cents,
            300
          );
          assert.equal(
            participant.active_improvement_bid_id,
            null
          );
          assert.equal(
            participant.manager_edit_limit,
            1
          );
          assert.equal(
            participant.cooldown_duration_ms,
            4_500_000
          );
        }
        assert.equal(
          rows(
            runtime.database,
            "auction_bids"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "contracts"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "player_ownerships"
          ).length,
          0
        );

        const draw = rows(
          runtime.database,
          "free_agent_draft_draws"
        )[0];
        assert.equal(
          draw.commitment_hex,
          result.restrictedAuction
            .drawCommitmentHex
        );
        assert.equal(
          createFreeAgentDraftAuctionDrawCommitment(
            {
              auctionId:
                result.restrictedAuction
                  .auctionId,
              nonceBytes: draw.nonce_bytes,
            }
          ).commitmentHex,
          draw.commitment_hex
        );
        assert.equal(draw.revealed_at_ms, null);

        const activationJob =
          runtime.database
            .prepare(
              "SELECT * FROM job_runs WHERE id = ?"
            )
            .get(
              result.restrictedAuction
                .activationJobRunId
            );
        assert.equal(
          activationJob.job_type,
          RESTRICTED_ACTIVATION_JOB_TYPE
        );
        assert.equal(
          activationJob.status,
          "pending"
        );
        assert.equal(
          activationJob.scheduled_for_ms,
          DEADLINE_AT_MS + DAY_MS
        );
        assert.equal(
          activationJob.occurrence_key,
          buildFreeAgentDraftRestrictedActivationOccurrenceKey(
            {
              fadId: IDS.fad,
              allocationId: IDS.allocation,
              activationAtMs:
                DEADLINE_AT_MS + DAY_MS,
            }
          )
        );
        const notificationRows = rows(
          runtime.database,
          "notifications"
        );
        assert.equal(notificationRows.length, 0);
        assert.equal(
          runtime.database.prepare(`
            SELECT COUNT(*) AS count
            FROM outbox_events
            WHERE league_id = ?
              AND event_type = 'notification.created'
          `).get(IDS.league).count,
          0
        );
        assert.equal(
          runtime.database.prepare(`
            SELECT COUNT(*) AS count
            FROM outbox_event_audiences
            WHERE league_id = ?
              AND audience_kind = 'user'
          `).get(IDS.league).count,
          0
        );

        const offerEvents = rows(
          runtime.database,
          "free_agent_draft_allocation_events"
        )
          .filter(
            (event) =>
              event.event_kind ===
              "offer_considered"
          )
          .sort(compareOfferEvidenceRank);
        assert.deepEqual(
          offerEvents.map((event) => [
            event.offer_outcome_code,
            event.offer_valid,
          ]),
          [
            ["restricted_tied", 1],
            ["restricted_tied", 1],
            ["lost_lower_aav", 1],
            ["excluded_over_cap", 0],
          ]
        );

        const replay =
          runtime.repository.resolvePending(
            runtime.command
          );
        assert.equal(replay.replayed, true);
        assert.deepEqual(
          {
            ...replay,
            replayed: false,
          },
          result
        );
        assert.equal(
          rows(
            runtime.database,
            "auctions"
          ).length,
          1
        );
        assert.equal(
          rows(
            runtime.database,
            "free_agent_draft_auction_participants"
          ).length,
          2
        );
        assert.equal(
          rows(
            runtime.database,
            "free_agent_draft_draws"
          ).length,
          1
        );
        assert.equal(
          rows(
            runtime.database,
            "notifications"
          ).length,
          0
        );
      }
    );

    test(
      "never publishes restricted eligibility to ended, inactive, or malformed manager authority",
      (t) => {
        const scenarios = [
          {
            label: "ended manager membership",
            mutate(database, identity) {
              database.prepare(`
                UPDATE league_memberships
                SET ended_at_ms = ?
                WHERE league_id = ? AND id = ?
              `).run(
                DEADLINE_AT_MS,
                IDS.league,
                identity.membershipId
              );
            },
          },
          {
            label: "inactive manager user",
            mutate(database, identity) {
              database.prepare(`
                UPDATE users
                SET status = 'suspended'
                WHERE id = ?
              `).run(identity.userId);
            },
          },
          {
            label: "accepted assignment without acceptance evidence",
            mutate(database, identity) {
              database.prepare(`
                UPDATE team_manager_assignments
                SET accepted_at_ms = NULL
                WHERE league_id = ? AND id = ?
              `).run(
                IDS.league,
                identity.assignmentId
              );
            },
          },
        ];
        for (const scenario of scenarios) {
          const nowMs =
            DEADLINE_AT_MS +
            DAY_MS -
            30 * 60 * 1000;
          const runtime = createRuntime(t, {
            nowMs,
            offers: [
              {
                totalValueCents: 600,
                termYears: 2,
                eligibilityStatus: "valid",
                cardAllocationEligibility:
                  "eligible",
                slotGroup: "D",
                positionGroup: "D",
              },
              {
                totalValueCents: 600,
                termYears: 2,
                eligibilityStatus: "warning",
                cardAllocationEligibility:
                  "eligible",
                slotGroup: "D",
                positionGroup: "D",
              },
            ],
          });
          mutateFixtureWithoutGuards(
            runtime.database,
            () =>
              scenario.mutate(
                runtime.database,
                runtime.identities[0]
              )
          );
          const before = runtime.database.serialize();

          for (let attempt = 0; attempt < 2; attempt += 1) {
            assertRepositoryError(
              () =>
                runtime.repository.resolvePending(
                  runtime.command
                ),
              REPOSITORY_ERROR_CODES.versionConflict
            );
            assert.equal(
              before.equals(
                runtime.database.serialize()
              ),
              true,
              scenario.label
            );
          }
          for (const tableName of [
            "auctions",
            "free_agent_draft_auction_participants",
            "free_agent_draft_draws",
            "league_activity",
            "notifications",
            "outbox_events",
            "outbox_event_audiences",
          ]) {
            assert.equal(
              rows(runtime.database, tableName).length,
              0,
              `${scenario.label}: ${tableName}`
            );
          }
          assert.equal(
            runtime.repository.findAllocation({
              leagueId: IDS.league,
              seasonId: IDS.season,
              fadId: IDS.fad,
              allocationId: IDS.allocation,
              playerId: IDS.player,
            }).status,
            "pending",
            scenario.label
          );
        }
      }
    );

    test(
      "quarantines expected ownership, contract, auction, occupied-slot, and authoritative-destination races with exact recovery and failed-job evidence",
      (t) => {
        const scenarios = [
          {
            fixture: "player_ownership",
            errorCode:
              "FAD_ALLOCATION_PLAYER_OWNED",
            issueKind: "player_ownership",
          },
          {
            fixture: "active_contract",
            errorCode:
              "FAD_ALLOCATION_PLAYER_CONTRACTED",
            issueKind: "active_contract",
          },
          {
            fixture: "active_auction",
            errorCode:
              "FAD_ALLOCATION_PLAYER_AUCTION_ACTIVE",
            issueKind: "active_auction",
          },
          {
            fixture: "requested_slot",
            errorCode:
              "FAD_ALLOCATION_DESTINATION_OCCUPIED",
            issueKind:
              "requested_slot_occupied",
          },
          {
            fixture:
              "destination_mismatch",
            errorCode:
              "FAD_ALLOCATION_DESTINATION_MISMATCH",
            issueKind:
              "authoritative_destination_mismatch",
          },
        ];
        for (const scenario of scenarios) {
          const nowMs =
            DEADLINE_AT_MS + 1_000;
          const runtime = createRuntime(t, {
            nowMs,
            offers: [
              {
                totalValueCents: 600,
                termYears: 2,
                eligibilityStatus: "valid",
                cardAllocationEligibility:
                  "eligible",
                slotGroup: "D",
                positionGroup: "D",
              },
            ],
          });
          try {
            injectAllocationSemanticRace(
              runtime,
              scenario.fixture
            );
          } catch (error) {
            throw new Error(
              `Semantic race fixture ${scenario.fixture} failed: ${error.message}`,
              { cause: error }
            );
          }
          const resourceCountsBefore = {
            contracts: rows(
              runtime.database,
              "contracts"
            ).length,
            ownerships: rows(
              runtime.database,
              "player_ownerships"
            ).length,
            auctions: rows(
              runtime.database,
              "auctions"
            ).length,
          };

          let result;
          try {
            result =
              runtime.repository.resolvePending(
                runtime.command
              );
          } catch (error) {
            throw new Error(
              `Semantic race ${scenario.fixture} failed: ${error.message}`,
              { cause: error }
            );
          }

          assertCorrectionRequiredResult(
            runtime,
            result,
            scenario.errorCode,
            scenario.issueKind
          );
          assert.deepEqual(
            {
              contracts: rows(
                runtime.database,
                "contracts"
              ).length,
              ownerships: rows(
                runtime.database,
                "player_ownerships"
              ).length,
              auctions: rows(
                runtime.database,
                "auctions"
              ).length,
            },
            resourceCountsBefore
          );
          assert.equal(
            rows(
              runtime.database,
              "free_agent_draft_recoveries"
            ).length,
            1
          );
          assert.equal(
            rows(
              runtime.database,
              "free_agent_draft_allocation_events"
            ).length,
            2
          );
          if (
            scenario.fixture ===
            "player_ownership"
          ) {
            const snapshotOfferCount =
              runtime.database
                .prepare(`
                  SELECT COUNT(*) AS count
                  FROM candidate_card_snapshot_entries
                  WHERE league_id = @leagueId
                    AND season_id = @seasonId
                    AND fad_id = @fadId
                    AND player_id = @playerId
                    AND occupant_kind = 'candidate'
                `)
                .get(runtime.command).count;
            const currentOfferEventCount =
              runtime.database
                .prepare(`
                  SELECT COUNT(*) AS count
                  FROM free_agent_draft_allocation_events
                  WHERE league_id = @leagueId
                    AND season_id = @seasonId
                    AND fad_id = @fadId
                    AND allocation_id = @allocationId
                    AND player_id = @playerId
                    AND allocation_version = 2
                    AND event_kind = 'offer_considered'
                    AND resulting_allocation_status =
                      'correction_required'
                `)
                .get(runtime.command).count;
            assert.equal(
              currentOfferEventCount,
              snapshotOfferCount
            );
            try {
              runtime.database
                .prepare(`
                  UPDATE free_agent_drafts
                  SET status = 'rapid',
                      allocation_completed_at_ms = @atMs,
                      updated_at_ms = @atMs,
                      version = version + 1
                  WHERE league_id = @leagueId
                    AND season_id = @seasonId
                    AND id = @fadId
                `)
                .run({
                  ...runtime.command,
                  atMs:
                    runtime.command.nowMs +
                    1,
                });
            } catch (error) {
              throw new Error(
                `Correction rapid transition failed: ${error.message}`,
                { cause: error }
              );
            }
          }
        }
      }
    );

    test(
      "rolls quarantine back instead of notifying an ended or inactive commissioner",
      (t) => {
        const scenarios = [
          {
            label: "ended commissioner membership",
            mutate(database) {
              database.prepare(`
                UPDATE league_memberships
                SET ended_at_ms = ?
                WHERE league_id = ? AND id = ?
              `).run(
                DEADLINE_AT_MS,
                IDS.league,
                IDS.commissionerMembership
              );
            },
          },
          {
            label: "inactive commissioner user",
            mutate(database) {
              database.prepare(`
                UPDATE users
                SET status = 'suspended'
                WHERE id = ?
              `).run(IDS.commissionerUser);
            },
          },
        ];
        for (const scenario of scenarios) {
          const nowMs = DEADLINE_AT_MS + 1_000;
          const runtime = createRuntime(t, {
            nowMs,
            offers: [
              {
                totalValueCents: 600,
                termYears: 2,
                eligibilityStatus: "valid",
                cardAllocationEligibility:
                  "eligible",
                slotGroup: "D",
                positionGroup: "D",
              },
            ],
          });
          mutateFixtureWithoutGuards(
            runtime.database,
            () => scenario.mutate(runtime.database)
          );
          injectAllocationSemanticRace(
            runtime,
            "player_ownership"
          );
          const before = runtime.database.serialize();

          for (let attempt = 0; attempt < 2; attempt += 1) {
            assertRepositoryError(
              () =>
                runtime.repository.resolvePending(
                  runtime.command
                ),
              REPOSITORY_ERROR_CODES.versionConflict
            );
            assert.equal(
              before.equals(
                runtime.database.serialize()
              ),
              true,
              scenario.label
            );
          }
          for (const tableName of [
            "free_agent_draft_recoveries",
            "free_agent_draft_allocation_events",
            "league_activity",
            "notifications",
            "outbox_events",
            "outbox_event_audiences",
          ]) {
            assert.equal(
              rows(runtime.database, tableName).length,
              0,
              `${scenario.label}: ${tableName}`
            );
          }
          assert.equal(
            runtime.repository.findAllocation({
              leagueId: IDS.league,
              seasonId: IDS.season,
              fadId: IDS.fad,
              allocationId: IDS.allocation,
              playerId: IDS.player,
            }).status,
            "pending",
            scenario.label
          );
        }
      }
    );

    test(
      "requires complete current-version offer evidence before a correction-required allocation can enter rapid",
      (t) => {
        const nowMs =
          DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 500,
              termYears: 1,
              eligibilityStatus: "warning",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 900,
              termYears: 3,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "excluded_over_cap",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });
        injectAllocationSemanticRace(
          runtime,
          "player_ownership"
        );

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );

        assert.equal(
          result.status,
          "correction_required"
        );
        assert.equal(result.decisionCode, null);
        assert.equal(result.winner, null);
        assert.equal(
          result.recovery.kind,
          "allocation_retry"
        );
        assert.equal(
          result.recovery.jobRunId,
          IDS.allocationJob
        );
        const offerEvents = rows(
          runtime.database,
          "free_agent_draft_allocation_events"
        ).filter(
          (event) =>
            event.event_kind ===
            "offer_considered"
        );
        assert.equal(offerEvents.length, 3);
        assert.deepEqual(
          new Set(
            result.evidence.offerEventIds
          ),
          new Set(
            offerEvents.map(
              (event) => event.id
            )
          )
        );
        assert.deepEqual(
          new Map(
            offerEvents.map((event) => [
              event.snapshot_entry_id,
              {
                valid: event.offer_valid,
                rank: event.rank_position,
                outcome:
                  event.offer_outcome_code,
                status:
                  event.resulting_allocation_status,
              },
            ])
          ),
          new Map([
            [
              runtime.identities[0]
                .snapshotEntryId,
              {
                valid: 1,
                rank: 1,
                outcome: "winner",
                status:
                  "correction_required",
              },
            ],
            [
              runtime.identities[1]
                .snapshotEntryId,
              {
                valid: 1,
                rank: 2,
                outcome:
                  "lost_lower_total",
                status:
                  "correction_required",
              },
            ],
            [
              runtime.identities[2]
                .snapshotEntryId,
              {
                valid: 0,
                rank: null,
                outcome:
                  "excluded_over_cap",
                status:
                  "correction_required",
              },
            ],
          ])
        );

        const transitionToRapid = () =>
          runtime.database
            .prepare(`
              UPDATE free_agent_drafts
              SET status = 'rapid',
                  allocation_completed_at_ms = @atMs,
                  updated_at_ms = @atMs,
                  version = version + 1
              WHERE league_id = @leagueId
                AND season_id = @seasonId
                AND id = @fadId
            `)
            .run({
              ...runtime.command,
              atMs: nowMs + 1,
            });
        const removedOfferEvent =
          offerEvents[1];
        const triggers =
          captureAndDropTriggers(
            runtime.database
          );
        runtime.database
          .prepare(`
            DELETE FROM free_agent_draft_allocation_events
            WHERE league_id = ? AND id = ?
          `)
          .run(
            IDS.league,
            removedOfferEvent.id
          );
        restoreTriggers(
          runtime.database,
          triggers
        );
        assert.throws(
          transitionToRapid,
          /current evidence for every allocation and offer/i
        );
        insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          removedOfferEvent
        );
        assert.doesNotThrow(
          transitionToRapid
        );
      }
    );

    test(
      "accounts for all excluded or invalid immutable offers without fabricating a winner or auction",
      (t) => {
        const nowMs =
          DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 1_200,
              termYears: 3,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "excluded_structural_conflict",
              capStatus: "over_cap",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 900,
              termYears: 3,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "excluded_over_cap",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "invalid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );

        assert.equal(
          result.status,
          "no_valid_offer"
        );
        assert.equal(
          result.decisionCode,
          "no_valid_offer"
        );
        assert.equal(result.winner, null);
        assert.equal(
          result.restrictedAuction,
          null
        );
        assert.equal(
          result.accountedAtMs,
          nowMs
        );
        assert.equal(
          rows(
            runtime.database,
            "contracts"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "player_ownerships"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "auctions"
          ).length,
          0
        );
        assert.deepEqual(
          rows(
            runtime.database,
            "free_agent_draft_allocation_events"
          )
            .filter(
              (event) =>
                event.event_kind ===
                "offer_considered"
            )
            .map(
              (event) =>
                event.offer_outcome_code
            )
            .sort(),
          [
            "excluded_over_cap",
            "excluded_structural_conflict",
            "invalid",
          ]
        );
        assert.equal(
          rows(
            runtime.database,
            "free_agent_draft_allocation_events"
          )
            .filter(
              (event) =>
                event.event_kind ===
                "offer_considered"
            )
            .every(
              (event) =>
                event.offer_valid === 0 &&
                event.rank_position === null
            ),
          true
        );
        const structuralEvidence = rows(
          runtime.database,
          "free_agent_draft_allocation_events"
        ).find(
          (event) =>
            event.offer_outcome_code ===
            "excluded_structural_conflict"
        );
        assert.equal(
          JSON.parse(
            structuralEvidence.evidence_json
          ).exclusionReason,
          "candidate_card_structural_conflict"
        );
        assert.equal(
          runtime.repository.resolvePending(
            runtime.command
          ).replayed,
          true
        );
      }
    );

    test(
      "never ranks or creates an offer event for an incomplete snapshot row",
      (t) => {
        const nowMs = DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 900,
              termYears: 3,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });
        const triggers = captureAndDropTriggers(
          runtime.database
        );
        runtime.database.prepare(`
          UPDATE candidate_card_snapshot_entries
          SET proposed_term_years = NULL,
              proposed_aav_cents = NULL,
              eligibility_status = 'invalid',
              validation_code =
                'CANDIDATE_CONTRACT_INCOMPLETE'
          WHERE id = ?
        `).run(
          runtime.identities[1].snapshotEntryId
        );
        restoreTriggers(runtime.database, triggers);

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );
        assert.equal(
          result.status,
          "automatic_award"
        );
        assert.equal(
          result.winner.snapshotEntryId,
          runtime.identities[0].snapshotEntryId
        );
        assert.deepEqual(
          runtime.database.prepare(`
            SELECT snapshot_entry_id
            FROM free_agent_draft_allocation_events
            WHERE event_kind = 'offer_considered'
            ORDER BY snapshot_entry_id
          `).all(),
          [
            {
              snapshot_entry_id:
                runtime.identities[0]
                  .snapshotEntryId,
            },
          ]
        );
      }
    );

    test(
      "resolves a restricted tie from normalized whole-card save provenance",
      (t) => {
        const nowMs =
          ROLLOVER_ONE_CREATION_CUTOFF_AT_MS -
          1;
        const runtime = createRuntime(t, {
          nowMs,
          allowImmediateRestrictedActivation:
            true,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "warning",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
        });
        const triggers = captureAndDropTriggers(
          runtime.database
        );
        for (const identity of
          runtime.identities) {
          runtime.database.prepare(`
            UPDATE candidate_card_revisions
            SET action = 'candidate_card_saved',
                affected_entry_id = NULL,
                player_id = NULL
            WHERE id = ?
          `).run(identity.candidateRevisionId);
          insert(
            runtime.database,
            "candidate_card_revision_entry_changes",
            {
              league_id: IDS.league,
              season_id: IDS.season,
              fad_id: IDS.fad,
              card_id: identity.cardId,
              team_id: identity.teamId,
              revision_id:
                identity.candidateRevisionId,
              entry_id: identity.entryId,
              player_id: IDS.player,
              change_kind: "add",
              before_slot_key: null,
              after_slot_key: "D01",
              before_total_value_cents: null,
              before_term_years: null,
              after_total_value_cents: 600,
              after_term_years: 2,
              created_at_ms:
                OPENED_AT_MS + 1,
            }
          );
        }
        restoreTriggers(runtime.database, triggers);

        const result =
          runtime.repository.resolvePending(
            runtime.command
          );
        assert.equal(
          result.status,
          "restricted_active"
        );
        assert.equal(
          result.restrictedAuction.participants
            .length,
          2
        );
        assert.equal(
          runtime.database.prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_auction_participants
            WHERE originating_candidate_revision_id IN (?, ?)
          `).get(
            runtime.identities[0]
              .candidateRevisionId,
            runtime.identities[1]
              .candidateRevisionId
          ).count,
          2
        );
      }
    );

    test(
      "validates the immediate-activation capability and rolls an unexpected quarantine failure back completely",
      (t) => {
        const nowMs =
          DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
          beforeCommit() {
            throw new Error(
              "injected-quarantine-failure"
            );
          },
        });
        assert.throws(
          () =>
            createSqliteCandidateAllocationRepository(
              {
                database: runtime.database,
                allowImmediateRestrictedActivation:
                  "yes",
              }
            ),
          /capability must be boolean/i
        );
        injectAllocationSemanticRace(
          runtime,
          "player_ownership"
        );

        assertRepositoryError(
          () =>
            runtime.repository.resolvePending(
              runtime.command
            ),
          REPOSITORY_ERROR_CODES.operationFailed
        );
        assert.equal(
          runtime.repository.findAllocation({
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            playerId: IDS.player,
          }).status,
          "pending"
        );
        assert.equal(
          rows(
            runtime.database,
            "free_agent_draft_recoveries"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "free_agent_draft_allocation_events"
          ).length,
          0
        );
        const job = runtime.database
          .prepare(`
            SELECT status, version,
                   lease_owner, lease_token,
                   completed_at_ms,
                   last_error_code,
                   next_attempt_at_ms
            FROM job_runs
            WHERE id = ?
          `)
          .get(IDS.allocationJob);
        assert.deepEqual(job, {
          status: "leased",
          version: 3,
          lease_owner: LEASE_OWNER,
          lease_token: LEASE_TOKEN,
          completed_at_ms: null,
          last_error_code: null,
          next_attempt_at_ms: null,
        });
      }
    );

    test(
      "fails closed on a stale lease and rolls every direct-award side effect back when the transaction aborts",
      (t) => {
        const nowMs =
          DEADLINE_AT_MS + 1_000;
        const runtime = createRuntime(t, {
          nowMs,
          offers: [
            {
              totalValueCents: 600,
              termYears: 2,
              eligibilityStatus: "valid",
              cardAllocationEligibility:
                "eligible",
              slotGroup: "D",
              positionGroup: "D",
            },
          ],
          beforeCommit() {
            throw new Error(
              "injected-before-commit-failure"
            );
          },
        });

        assertRepositoryError(
          () =>
            runtime.repository.resolvePending({
              ...runtime.command,
              leaseToken:
                "wrong-allocation-lease-token",
            }),
          REPOSITORY_ERROR_CODES.versionConflict
        );
        assert.equal(
          runtime.repository.findAllocation({
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            playerId: IDS.player,
          }).status,
          "pending"
        );

        runtime.database
          .prepare(
            "UPDATE job_runs SET lease_expires_at_ms = ? WHERE id = ?"
          )
          .run(nowMs, IDS.allocationJob);
        assertRepositoryError(
          () =>
            runtime.repository.resolvePending(
              runtime.command
            ),
          REPOSITORY_ERROR_CODES.versionConflict
        );
        runtime.database
          .prepare(
            "UPDATE job_runs SET lease_expires_at_ms = ? WHERE id = ?"
          )
          .run(
            nowMs + 60 * 60 * 1000,
            IDS.allocationJob
          );

        assertRepositoryError(
          () =>
            runtime.repository.resolvePending(
              runtime.command
            ),
          REPOSITORY_ERROR_CODES.operationFailed
        );
        const allocation =
          runtime.repository.findAllocation({
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            playerId: IDS.player,
          });
        assert.equal(allocation.status, "pending");
        assert.equal(allocation.version, 1);
        assert.equal(
          rows(
            runtime.database,
            "contracts"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "contract_years"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "player_ownerships"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "free_agent_draft_allocation_events"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "league_activity"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "outbox_events"
          ).length,
          0
        );
        assert.equal(
          rows(
            runtime.database,
            "seasons"
          ).length,
          1
        );
        const job = runtime.database
          .prepare(
            "SELECT * FROM job_runs WHERE id = ?"
          )
          .get(IDS.allocationJob);
        assert.equal(job.status, "leased");
        assert.equal(job.version, 3);
        assert.equal(
          job.lease_token,
          LEASE_TOKEN
        );
        assert.equal(job.result_json, null);
      }
    );
  }
);
