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
  migrateDatabase,
} = require(
  "../../src/infrastructure/database/migrate"
);
const {
  buildFreeAgentDraftAllocationOccurrenceKey,
  buildFreeAgentDraftDeadlineOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createSqliteFreeAgentDraftDeadlineWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftDeadlineWriter"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  readiness: uuid(4),
  deadlineJob: uuid(5),
  leaseToken: uuid(6),
  scheduleOperation: uuid(7),
  weekOne: uuid(8),
  user: uuid(9),
  membership: uuid(10),
  teamOne: uuid(11),
  teamTwo: uuid(12),
  teamThree: uuid(13),
  cardOne: uuid(14),
  cardTwo: uuid(15),
  cardThree: uuid(16),
  participantOne: uuid(17),
  participantTwo: uuid(18),
  participantThree: uuid(19),
  playerA: uuid(20),
  playerB: uuid(21),
  playerC: uuid(22),
  carryoverPlayer: uuid(23),
  candidateOne: uuid(30),
  candidateTwoA: uuid(31),
  candidateTwoC: uuid(32),
  candidateThreeB: uuid(33),
  carryoverConflict: uuid(34),
  carryoverOwnership: uuid(35),
  carryoverContract: uuid(36),
  helpRequest: uuid(37),
});
const DEADLINE_AT_MS = Date.parse(
  "2027-09-01T07:00:00.000Z"
);
const STARTED_AT_MS = DEADLINE_AT_MS + 100;
const EXECUTED_AT_MS = DEADLINE_AT_MS + 200;
const LEASE_EXPIRES_AT_MS =
  DEADLINE_AT_MS + 60_000;
const LEASE_OWNER = "fad-deadline-worker";
const OCCURRENCE_KEY =
  buildFreeAgentDraftDeadlineOccurrenceKey({
    fadId: IDS.fad,
    deadlineAtMs: DEADLINE_AT_MS,
  });

function createSchema(database) {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE leagues (
      id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TABLE league_memberships (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      ended_at_ms INTEGER
    ) STRICT;

    CREATE TABLE free_agent_draft_readiness_operations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      readiness_occurrence_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_fad_id TEXT,
      deadline_job_run_id TEXT
    ) STRICT;

    CREATE TABLE free_agent_drafts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      readiness_operation_id TEXT NOT NULL,
      readiness_occurrence_key TEXT NOT NULL,
      participating_team_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      candidate_deadline_at_ms INTEGER NOT NULL,
      current_competition_first_matchup_week_id TEXT NOT NULL,
      deadline_locked_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE matchup_operations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at_ms INTEGER
    ) STRICT;

    CREATE TABLE matchup_weeks (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      starts_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE season_matchup_schedule_generations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      schedule_operation_id TEXT NOT NULL,
      schedule_version INTEGER NOT NULL,
      week_one_matchup_week_id TEXT NOT NULL,
      week_one_starts_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE free_agent_draft_teams (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      team_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE candidate_cards (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      status TEXT NOT NULL,
      completeness_code TEXT NOT NULL,
      filled_mandatory_count INTEGER NOT NULL,
      missing_mandatory_count INTEGER NOT NULL,
      filled_bench_count INTEGER NOT NULL,
      empty_bench_count INTEGER NOT NULL,
      blocking_validation_count INTEGER NOT NULL,
      structural_conflict_count INTEGER NOT NULL,
      carried_roster_structural_conflict_count INTEGER NOT NULL,
      maximum_possible_cap_cents INTEGER NOT NULL,
      cap_status TEXT NOT NULL,
      allocation_eligibility TEXT NOT NULL,
      allocation_exclusion_reason TEXT,
      locked_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (league_id, id),
      UNIQUE (league_id, fad_id, team_id)
    ) STRICT;

    CREATE TABLE contracts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      contract_type TEXT NOT NULL
    ) STRICT;

    CREATE TABLE candidate_card_entries (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      entry_kind TEXT NOT NULL,
      player_id TEXT NOT NULL,
      effective_position_group TEXT NOT NULL,
      requested_slot_group TEXT NOT NULL,
      requested_slot_number INTEGER NOT NULL,
      placement_state TEXT NOT NULL,
      conflict_code TEXT,
      carryover_ownership_id TEXT,
      carryover_contract_id TEXT,
      source_roster_category TEXT,
      carryover_original_total_value_cents INTEGER,
      carryover_original_term_years INTEGER,
      carryover_aav_cents INTEGER,
      remaining_years INTEGER,
      proposed_total_value_cents INTEGER,
      proposed_term_years INTEGER,
      proposed_aav_cents INTEGER,
      eligibility_status TEXT,
      validation_code TEXT,
      last_edited_by_user_id TEXT,
      last_edited_by_membership_id TEXT,
      last_edited_by_authority TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (league_id, card_id, player_id)
    ) STRICT;

    CREATE TABLE candidate_card_revisions (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      resulting_card_version INTEGER NOT NULL,
      action TEXT NOT NULL,
      affected_entry_id TEXT,
      player_id TEXT,
      actor_user_id TEXT,
      actor_membership_id TEXT,
      actor_authority TEXT NOT NULL,
      before_evidence_json TEXT NOT NULL,
      after_evidence_json TEXT NOT NULL,
      potential_illegality_acknowledged INTEGER NOT NULL,
      warning_codes_json TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (league_id, card_id, resulting_card_version)
    ) STRICT;

    CREATE TABLE candidate_card_help_requests (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE candidate_card_snapshots (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      locked_card_version INTEGER NOT NULL,
      locked_status TEXT NOT NULL,
      completeness_code TEXT NOT NULL,
      filled_mandatory_count INTEGER NOT NULL,
      missing_mandatory_count INTEGER NOT NULL,
      filled_bench_count INTEGER NOT NULL,
      empty_bench_count INTEGER NOT NULL,
      blocking_validation_count INTEGER NOT NULL,
      structural_conflict_count INTEGER NOT NULL,
      cap_limit_cents INTEGER NOT NULL,
      carried_active_player_amount_cents INTEGER NOT NULL,
      retention_obligation_cents INTEGER NOT NULL,
      buyout_penalty_cents INTEGER NOT NULL,
      carried_cap_usage_cents INTEGER NOT NULL,
      proposed_candidate_aav_cents INTEGER NOT NULL,
      maximum_possible_cap_cents INTEGER NOT NULL,
      maximum_cap_space_cents INTEGER NOT NULL,
      effective_deadline_at_ms INTEGER NOT NULL,
      processed_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      carried_roster_structural_conflict_count INTEGER NOT NULL,
      cap_status TEXT NOT NULL,
      allocation_eligibility TEXT NOT NULL,
      allocation_exclusion_reason TEXT,
      UNIQUE (league_id, card_id),
      UNIQUE (league_id, fad_id, team_id)
    ) STRICT;

    CREATE TRIGGER snapshot_after_card_lock_and_help_expiry
    BEFORE INSERT ON candidate_card_snapshots
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM candidate_card_help_requests
        WHERE fad_id = NEW.fad_id AND status = 'active'
      ) THEN RAISE(
        ABORT,
        'snapshot requires expired help'
      ) END;
      SELECT CASE WHEN (
        SELECT COUNT(*) FROM candidate_cards
        WHERE fad_id = NEW.fad_id
          AND status IN (
            'locked_complete',
            'locked_incomplete',
            'locked_conflicted'
          )
      ) <> (
        SELECT participating_team_count
        FROM free_agent_drafts WHERE id = NEW.fad_id
      ) THEN RAISE(
        ABORT,
        'snapshot requires every locked card'
      ) END;
    END;

    CREATE TABLE candidate_card_snapshot_entries (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      row_kind TEXT NOT NULL,
      occupant_kind TEXT NOT NULL,
      slot_group TEXT NOT NULL,
      slot_number INTEGER NOT NULL,
      source_entry_id TEXT,
      source_entry_version INTEGER,
      player_id TEXT,
      effective_position_group TEXT,
      conflict_code TEXT,
      carryover_ownership_id TEXT,
      carryover_contract_id TEXT,
      source_roster_category TEXT,
      carryover_original_total_value_cents INTEGER,
      carryover_original_term_years INTEGER,
      carryover_aav_cents INTEGER,
      remaining_years INTEGER,
      proposed_total_value_cents INTEGER,
      proposed_term_years INTEGER,
      proposed_aav_cents INTEGER,
      eligibility_status TEXT,
      validation_code TEXT,
      last_edited_by_user_id TEXT,
      last_edited_by_membership_id TEXT,
      last_edited_by_authority TEXT,
      last_edited_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      allocation_eligibility TEXT,
      allocation_exclusion_reason TEXT
    ) STRICT;

    CREATE UNIQUE INDEX snapshot_one_slot
      ON candidate_card_snapshot_entries (
        league_id, snapshot_id, slot_group, slot_number
      ) WHERE row_kind = 'slot';

    CREATE UNIQUE INDEX snapshot_one_source
      ON candidate_card_snapshot_entries (
        league_id, snapshot_id, source_entry_id
      ) WHERE source_entry_id IS NOT NULL;

    CREATE TABLE free_agent_draft_player_allocations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      status TEXT NOT NULL,
      decision_code TEXT,
      winning_snapshot_entry_id TEXT,
      winning_team_id TEXT,
      contract_id TEXT,
      ownership_id TEXT,
      restricted_auction_id TEXT,
      fallback_open_auction_id TEXT,
      restricted_minimum_total_cents INTEGER,
      restricted_minimum_term_years INTEGER,
      restricted_minimum_aav_cents INTEGER,
      accounted_at_ms INTEGER,
      last_error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (league_id, fad_id, player_id)
    ) STRICT;

    CREATE TABLE job_runs (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      lease_owner TEXT,
      lease_expires_at_ms INTEGER,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      result_json TEXT,
      last_error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL,
      lease_token TEXT,
      next_attempt_at_ms INTEGER,
      UNIQUE (league_id, job_type, occurrence_key)
    ) STRICT;

    CREATE TABLE league_activity (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT,
      event_type TEXT NOT NULL,
      actor_user_id TEXT,
      actor_authority TEXT NOT NULL,
      team_id TEXT,
      player_id TEXT,
      related_type TEXT,
      related_id TEXT,
      display_summary TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT,
      occurred_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TRIGGER cards_published_after_root_lock
    BEFORE INSERT ON league_activity
    WHEN NEW.event_type =
      'free_agent_draft_cards_published'
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM free_agent_drafts
        WHERE id = NEW.related_id
          AND status = 'deadline_locked'
      ) THEN RAISE(
        ABORT,
        'cards publication requires locked root'
      ) END;
    END;

    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      league_id TEXT,
      event_type TEXT NOT NULL,
      message_data_json TEXT NOT NULL,
      related_feature TEXT,
      related_record_id TEXT,
      delivery_status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      read_at_ms INTEGER,
      delivered_at_ms INTEGER,
      version INTEGER NOT NULL,
      deduplication_key TEXT
    ) STRICT;

    CREATE UNIQUE INDEX notifications_deduplication
      ON notifications (
        user_id, event_type, deduplication_key
      ) WHERE deduplication_key IS NOT NULL;

    CREATE TABLE outbox_events (
      id TEXT PRIMARY KEY,
      league_id TEXT,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      available_at_ms INTEGER NOT NULL,
      published_at_ms INTEGER,
      last_error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE outbox_event_audiences (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      outbox_event_id TEXT NOT NULL,
      audience_kind TEXT NOT NULL,
      team_id TEXT,
      user_id TEXT,
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TRIGGER allocation_requires_deadline_snapshot
    BEFORE INSERT ON free_agent_draft_player_allocations
    BEGIN
      SELECT CASE WHEN NOT (
        NEW.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM free_agent_drafts AS fad
          WHERE fad.id = NEW.fad_id
            AND fad.status = 'cards_open'
            AND NEW.created_at_ms >= fad.candidate_deadline_at_ms
            AND EXISTS (
              SELECT 1 FROM candidate_card_snapshot_entries AS entry
              WHERE entry.fad_id = NEW.fad_id
                AND entry.player_id = NEW.player_id
                AND entry.occupant_kind = 'candidate'
            )
            AND EXISTS (
              SELECT 1 FROM job_runs AS job
              WHERE job.id = '${IDS.deadlineJob}'
                AND job.job_type = 'fad_deadline'
                AND job.status = 'running'
                AND job.lease_expires_at_ms > NEW.created_at_ms
            )
        )
      ) THEN RAISE(
        ABORT,
        'allocation requires live deadline publication'
      ) END;
    END;

    CREATE TRIGGER fad_deadline_root_barrier
    BEFORE UPDATE OF status ON free_agent_drafts
    WHEN OLD.status = 'cards_open'
      AND NEW.status = 'deadline_locked'
    BEGIN
      SELECT CASE WHEN (
        SELECT COUNT(*) FROM candidate_cards
        WHERE fad_id = NEW.id
          AND status IN (
            'locked_complete',
            'locked_incomplete',
            'locked_conflicted'
          )
      ) <> NEW.participating_team_count
      THEN RAISE(ABORT, 'root requires locked cards') END;

      SELECT CASE WHEN (
        SELECT COUNT(*) FROM candidate_card_snapshot_entries
        WHERE fad_id = NEW.id AND row_kind = 'slot'
      ) <> NEW.participating_team_count * 22
      THEN RAISE(ABORT, 'root requires 22 slots per card') END;

      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM candidate_card_help_requests
        WHERE fad_id = NEW.id AND status = 'active'
      ) THEN RAISE(ABORT, 'root requires expired help') END;

      SELECT CASE WHEN (
        SELECT COUNT(*) FROM free_agent_draft_player_allocations
        WHERE fad_id = NEW.id AND status = 'pending'
      ) <> (
        SELECT COUNT(DISTINCT player_id)
        FROM candidate_card_snapshot_entries
        WHERE fad_id = NEW.id AND occupant_kind = 'candidate'
          AND proposed_total_value_cents IS NOT NULL
          AND proposed_term_years IS NOT NULL
          AND proposed_aav_cents IS NOT NULL
      ) THEN RAISE(ABORT, 'root requires exact allocations') END;
    END;
  `);
}

function insertEntry(database, input) {
  database.prepare(`
    INSERT INTO candidate_card_entries (
      id, league_id, season_id, fad_id, card_id, team_id,
      entry_kind, player_id, effective_position_group,
      requested_slot_group, requested_slot_number,
      placement_state, conflict_code, carryover_ownership_id,
      carryover_contract_id, source_roster_category,
      carryover_original_total_value_cents,
      carryover_original_term_years, carryover_aav_cents,
      remaining_years, proposed_total_value_cents,
      proposed_term_years, proposed_aav_cents,
      eligibility_status, validation_code,
      last_edited_by_user_id, last_edited_by_membership_id,
      last_edited_by_authority, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      @id, '${IDS.league}', '${IDS.season}', '${IDS.fad}',
      @cardId, @teamId, @entryKind, @playerId, @position,
      @slotGroup, @slotNumber, @placementState, @conflictCode,
      @ownershipId, @contractId, @rosterCategory,
      @originalTotal, @originalTerm, @carryoverAav,
      @remainingYears, @proposedTotal, @proposedTerm,
      @proposedAav, @eligibilityStatus, @validationCode,
      NULL, NULL, 'system', 100, 100, 1
    )
  `).run({
    ownershipId: null,
    contractId: null,
    rosterCategory: null,
    originalTotal: null,
    originalTerm: null,
    carryoverAav: null,
    remainingYears: null,
    proposedTotal: null,
    proposedTerm: null,
    proposedAav: null,
    eligibilityStatus: null,
    validationCode: null,
    conflictCode: null,
    ...input,
  });
}

function seed(database, { zeroCandidates = false } = {}) {
  database.prepare(
    "INSERT INTO users (id, status) VALUES (?, 'active')"
  ).run(IDS.user);
  database.prepare(
    "INSERT INTO leagues (id) VALUES (?)"
  ).run(IDS.league);
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, status, ended_at_ms
    ) VALUES (?, ?, ?, 'active', NULL)
  `).run(
    IDS.membership,
    IDS.league,
    IDS.user
  );
  database.prepare(`
    INSERT INTO free_agent_draft_readiness_operations (
      id, league_id, season_id, readiness_occurrence_key,
      status, created_fad_id, deadline_job_run_id
    ) VALUES (?, ?, ?, 'readiness:key', 'succeeded', ?, ?)
  `).run(
    IDS.readiness,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.deadlineJob
  );
  const teamIds = zeroCandidates
    ? [IDS.teamOne]
    : [IDS.teamOne, IDS.teamTwo, IDS.teamThree];
  const cardIds = zeroCandidates
    ? [IDS.cardOne]
    : [IDS.cardOne, IDS.cardTwo, IDS.cardThree];
  const participantIds = zeroCandidates
    ? [IDS.participantOne]
    : [
        IDS.participantOne,
        IDS.participantTwo,
        IDS.participantThree,
      ];
  database.prepare(`
    INSERT INTO free_agent_drafts (
      id, league_id, season_id, readiness_operation_id,
      readiness_occurrence_key, participating_team_count,
      status, candidate_deadline_at_ms,
      current_competition_first_matchup_week_id,
      deadline_locked_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'readiness:key', ?, 'cards_open',
      ?, ?, NULL, 100, 1)
  `).run(
    IDS.fad,
    IDS.league,
    IDS.season,
    IDS.readiness,
    teamIds.length,
    DEADLINE_AT_MS,
    IDS.weekOne
  );
  database.prepare(`
    INSERT INTO matchup_operations (
      id, league_id, season_id, operation_type,
      status, completed_at_ms
    ) VALUES (?, ?, ?, 'schedule_generate', 'succeeded', 90)
  `).run(
    IDS.scheduleOperation,
    IDS.league,
    IDS.season
  );
  database.prepare(`
    INSERT INTO matchup_weeks (
      id, league_id, season_id, sequence, starts_at_ms
    ) VALUES (?, ?, ?, 1, ?)
  `).run(
    IDS.weekOne,
    IDS.league,
    IDS.season,
    DEADLINE_AT_MS + 7 * 24 * 60 * 60 * 1000
  );
  database.prepare(`
    INSERT INTO season_matchup_schedule_generations (
      id, league_id, season_id, schedule_operation_id,
      schedule_version, week_one_matchup_week_id,
      week_one_starts_at_ms, status
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 'current')
  `).run(
    uuid(40),
    IDS.league,
    IDS.season,
    IDS.scheduleOperation,
    IDS.weekOne,
    DEADLINE_AT_MS + 7 * 24 * 60 * 60 * 1000
  );
  const insertParticipant = database.prepare(`
    INSERT INTO free_agent_draft_teams (
      id, league_id, season_id, fad_id, team_id
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertCard = database.prepare(`
    INSERT INTO candidate_cards (
      id, league_id, season_id, fad_id, team_id, status,
      completeness_code, filled_mandatory_count,
      missing_mandatory_count, filled_bench_count,
      empty_bench_count, blocking_validation_count,
      structural_conflict_count,
      carried_roster_structural_conflict_count,
      maximum_possible_cap_cents, cap_status,
      allocation_eligibility, allocation_exclusion_reason,
      locked_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, 'open', 'incomplete', 0, 18,
      0, 4, 0, 0, 0, 0, 'compliant', 'eligible', NULL,
      NULL, 100, 100, 1)
  `);
  for (let index = 0; index < teamIds.length; index += 1) {
    insertParticipant.run(
      participantIds[index],
      IDS.league,
      IDS.season,
      IDS.fad,
      teamIds[index]
    );
    insertCard.run(
      cardIds[index],
      IDS.league,
      IDS.season,
      IDS.fad,
      teamIds[index]
    );
  }
  database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type, occurrence_key,
      scheduled_for_ms, status, attempt_count, lease_owner,
      lease_expires_at_ms, started_at_ms, completed_at_ms,
      result_json, last_error_code, created_at_ms,
      updated_at_ms, version, lease_token, next_attempt_at_ms
    ) VALUES (?, ?, ?, 'fad_deadline', ?, ?, 'running', 1,
      ?, ?, ?, NULL, NULL, NULL, 100, ?, 2, ?, NULL)
  `).run(
    IDS.deadlineJob,
    IDS.league,
    IDS.season,
    OCCURRENCE_KEY,
    DEADLINE_AT_MS,
    LEASE_OWNER,
    LEASE_EXPIRES_AT_MS,
    STARTED_AT_MS,
    STARTED_AT_MS,
    IDS.leaseToken
  );

  if (zeroCandidates) return;
  database.prepare(`
    INSERT INTO contracts (
      id, league_id, contract_type
    ) VALUES (?, ?, 'normal')
  `).run(IDS.carryoverContract, IDS.league);
  insertEntry(database, {
    id: IDS.candidateOne,
    cardId: IDS.cardOne,
    teamId: IDS.teamOne,
    entryKind: "candidate",
    playerId: IDS.playerA,
    position: "F",
    slotGroup: "F",
    slotNumber: 1,
    placementState: "placed",
    proposedTotal: 600,
    proposedTerm: 2,
    proposedAav: 300,
    eligibilityStatus: "valid",
  });
  insertEntry(database, {
    id: IDS.candidateTwoA,
    cardId: IDS.cardTwo,
    teamId: IDS.teamTwo,
    entryKind: "candidate",
    playerId: IDS.playerA,
    position: "F",
    slotGroup: "F",
    slotNumber: 1,
    placementState: "placed",
    proposedTotal: 600,
    proposedTerm: 2,
    proposedAav: 300,
    eligibilityStatus: "valid",
  });
  insertEntry(database, {
    id: IDS.candidateTwoC,
    cardId: IDS.cardTwo,
    teamId: IDS.teamTwo,
    entryKind: "candidate",
    playerId: IDS.playerC,
    position: "F",
    slotGroup: "F",
    slotNumber: 2,
    placementState: "placed",
    proposedTotal: 2000,
    proposedTerm: 1,
    proposedAav: 2000,
    eligibilityStatus: "valid",
  });
  insertEntry(database, {
    id: IDS.candidateThreeB,
    cardId: IDS.cardThree,
    teamId: IDS.teamThree,
    entryKind: "candidate",
    playerId: IDS.playerB,
    position: "F",
    slotGroup: "F",
    slotNumber: 1,
    placementState: "placed",
    proposedTotal: 300,
    proposedTerm: 1,
    proposedAav: 300,
    eligibilityStatus: "warning",
    validationCode: "SOURCE_WARNING",
  });
  insertEntry(database, {
    id: IDS.carryoverConflict,
    cardId: IDS.cardThree,
    teamId: IDS.teamThree,
    entryKind: "carryover",
    playerId: IDS.carryoverPlayer,
    position: "D",
    slotGroup: "D",
    slotNumber: 1,
    placementState: "conflict",
    conflictCode: "CARRYOVER_SLOT_CONFLICT",
    ownershipId: IDS.carryoverOwnership,
    contractId: IDS.carryoverContract,
    rosterCategory: "Active",
    originalTotal: 900,
    originalTerm: 3,
    carryoverAav: 300,
    remainingYears: 2,
  });
  database.prepare(`
    INSERT INTO candidate_card_help_requests (
      id, league_id, season_id, fad_id, card_id,
      team_id, status, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', 100, 1)
  `).run(
    IDS.helpRequest,
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.cardOne,
    IDS.teamOne
  );
}

function mapDraft(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    status: row.status,
    candidateDeadlineAtMs:
      row.candidate_deadline_at_ms,
    participatingTeamCount:
      row.participating_team_count,
    currentCompetitionFirstMatchupWeekId:
      row.current_competition_first_matchup_week_id,
    deadlineLockedAtMs:
      row.deadline_locked_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
  });
}

function createLifecycleRepository(database, writer, calls) {
  const transition = database.transaction((command) => {
    calls.push("lifecycle:before");
    const existing = mapDraft(
      database.prepare(`
        SELECT * FROM free_agent_drafts WHERE id = ?
      `).get(command.fadId)
    );
    writer.beforeTransition({
      ...command,
      targetSchedule: command.schedule,
      scheduleRecoveryId: null,
      existing,
    });
    calls.push("lifecycle:root-update");
    const update = database.prepare(`
      UPDATE free_agent_drafts
      SET status = 'deadline_locked',
          deadline_locked_at_ms = @occurredAtMs,
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE id = @fadId
        AND status = 'cards_open'
        AND version = @expectedVersion
    `).run(command);
    assert.equal(update.changes, 1);
    const updated = mapDraft(
      database.prepare(`
        SELECT * FROM free_agent_drafts WHERE id = ?
      `).get(command.fadId)
    );
    writer.afterTransition({
      effectiveCommand: {
        ...command,
        targetSchedule: command.schedule,
        scheduleRecoveryId: null,
      },
      existing,
      updated,
    });
    calls.push("lifecycle:after");
    return Object.freeze({
      replayed: false,
      draft: updated,
    });
  });
  return Object.freeze({
    advanceStatus(command) {
      return transition.immediate(command);
    },
  });
}

function command(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    deadlineAtMs: DEADLINE_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: DEADLINE_AT_MS,
    executedAtMs: EXECUTED_AT_MS,
    jobExecution: {
      runId: IDS.deadlineJob,
      leaseOwner: LEASE_OWNER,
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      startedAtMs: STARTED_AT_MS,
      attemptCount: 1,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function createRuntime(
  t,
  {
    zeroCandidates = false,
    beforeCommit,
    revalidate = true,
    asyncReconciliation = false,
  } = {}
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-deadline-")
  );
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  createSchema(connection.database);
  seed(connection.database, { zeroCandidates });
  const calls = [];
  const reconciler = Object.freeze({
    reconcileInCurrentTransaction(input) {
      assert.equal(
        connection.database.inTransaction,
        true
      );
      calls.push("reconcile");
      if (revalidate && !zeroCandidates) {
        connection.database.prepare(`
          UPDATE candidate_card_entries
          SET eligibility_status = 'invalid',
              validation_code = 'FINAL_INELIGIBLE',
              updated_at_ms = @nowMs,
              version = version + 1
          WHERE id = @entryId
        `).run({
          nowMs: input.nowMs,
          entryId: IDS.candidateThreeB,
        });
      }
      const result = Object.freeze({
        outcome: "deadline_reconciled",
        leagueId: input.leagueId,
        seasonId: input.seasonId,
        fadId: input.fadId,
        deadlineOperationId:
          input.deadlineOperationId,
      });
      return asyncReconciliation
        ? Promise.resolve(result)
        : result;
    },
  });
  const capReadRepository = Object.freeze({
    calculate({ teamId }) {
      calls.push(`cap:${teamId}`);
      return Object.freeze({
        complete: true,
        capLimitCents: 1000,
        breakdown: Object.freeze({
          activePlayerCents:
            teamId === IDS.teamThree ? 300 : 0,
          retentionCents: 0,
          buyoutCents: 0,
        }),
      });
    },
  });
  const writer =
    createSqliteFreeAgentDraftDeadlineWriter({
      database: connection.database,
      eligibilityDeadlineReconciler: reconciler,
      capReadRepository,
      beforeCommit:
        beforeCommit === undefined
          ? ({ result }) => {
              const job = connection.database
                .prepare(
                  "SELECT status FROM job_runs WHERE id = ?"
                )
                .get(IDS.deadlineJob);
              const fad = connection.database
                .prepare(
                  "SELECT status FROM free_agent_drafts WHERE id = ?"
                )
                .get(IDS.fad);
              assert.equal(job.status, "succeeded");
              assert.equal(fad.status, "deadline_locked");
              assert.equal(result.fadVersion, 2);
              calls.push("writer:before-commit");
            }
          : beforeCommit,
    });
  const lifecycleRepository =
    createLifecycleRepository(
      connection.database,
      writer,
      calls
    );
  return Object.freeze({
    database: connection.database,
    writer,
    lifecycleRepository,
    calls,
  });
}

function counts(database) {
  return Object.freeze({
    snapshots: database.prepare(
      "SELECT COUNT(*) AS count FROM candidate_card_snapshots"
    ).get().count,
    snapshotEntries: database.prepare(
      "SELECT COUNT(*) AS count FROM candidate_card_snapshot_entries"
    ).get().count,
    allocations: database.prepare(
      "SELECT COUNT(*) AS count FROM free_agent_draft_player_allocations"
    ).get().count,
    activities: database.prepare(
      "SELECT COUNT(*) AS count FROM league_activity"
    ).get().count,
    notifications: database.prepare(
      "SELECT COUNT(*) AS count FROM notifications"
    ).get().count,
    outbox: database.prepare(
      "SELECT COUNT(*) AS count FROM outbox_events"
    ).get().count,
  });
}

describe("SQLite Free Agent Draft deadline writer foundation", () => {
  test("prepares against a fresh migrated schema at or beyond 37 without creating deadline state", (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-fad-deadline-schema-")
    );
    const connection = openDatabase({
      databasePath: path.join(root, "league.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      connection.database.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    migrateDatabase({
      database: connection.database,
      migrationsDirectory: path.resolve(
        __dirname,
        "..",
        "..",
        "database",
        "migrations"
      ),
      applicationBuildId:
        "fad-deadline-writer-foundation",
      now: () => 1,
    });

    assert.doesNotThrow(() =>
      createSqliteFreeAgentDraftDeadlineWriter({
        database: connection.database,
        eligibilityDeadlineReconciler: {
          reconcileInCurrentTransaction() {},
        },
      })
    );
    assert.ok(
      Number(connection.database.prepare(`
        SELECT metadata_value
        FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).get().metadata_value) >= 37
    );
    assert.equal(
      connection.database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_player_allocations
      `).get().count,
      0
    );
  });

  test("publishes multiple cards and the exact distinct snapshot player set atomically", (t) => {
    const runtime = createRuntime(t);
    const result = runtime.writer.executeClaimed(
      command(),
      runtime.lifecycleRepository
    );

    assert.deepEqual(
      {
        outcome: result.outcome,
        replayed: result.replayed,
        cardCount: result.cardCount,
        allocationCount: result.allocationCount,
        jobVersion: result.jobVersion,
        fadVersion: result.fadVersion,
      },
      {
        outcome: "succeeded",
        replayed: false,
        cardCount: 3,
        allocationCount: 3,
        jobVersion: 3,
        fadVersion: 2,
      }
    );
    assert.deepEqual(runtime.calls, [
      "lifecycle:before",
      "reconcile",
      `cap:${IDS.teamOne}`,
      `cap:${IDS.teamTwo}`,
      `cap:${IDS.teamThree}`,
      "lifecycle:root-update",
      "writer:before-commit",
      "lifecycle:after",
    ]);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, allocation_eligibility,
               allocation_exclusion_reason
        FROM candidate_cards ORDER BY team_id
      `).all(),
      [
        {
          status: "locked_incomplete",
          allocation_eligibility: "eligible",
          allocation_exclusion_reason: null,
        },
        {
          status: "locked_incomplete",
          allocation_eligibility: "excluded_over_cap",
          allocation_exclusion_reason:
            "candidate_card_over_cap",
        },
        {
          status: "locked_conflicted",
          allocation_eligibility:
            "excluded_structural_conflict",
          allocation_exclusion_reason:
            "candidate_card_structural_conflict",
        },
      ]
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_snapshot_entries
        WHERE row_kind = 'slot'
      `).get().count,
      66
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_snapshot_entries
        WHERE row_kind = 'conflict'
      `).get().count,
      1
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT player_id
        FROM free_agent_draft_player_allocations
        ORDER BY player_id
      `).all().map(({ player_id: playerId }) => playerId),
      [IDS.playerA, IDS.playerB, IDS.playerC]
    );
    const allocations = runtime.database.prepare(`
      SELECT player_id, status, decision_code,
             winning_snapshot_entry_id, winning_team_id,
             contract_id, ownership_id, restricted_auction_id,
             fallback_open_auction_id,
             restricted_minimum_total_cents,
             restricted_minimum_term_years,
             restricted_minimum_aav_cents, accounted_at_ms,
             last_error_code, created_at_ms, updated_at_ms,
             version
      FROM free_agent_draft_player_allocations
      ORDER BY player_id
    `).all();
    assert.deepEqual(
      allocations.map(({ player_id: playerId }) => playerId),
      [IDS.playerA, IDS.playerB, IDS.playerC]
    );
    for (const allocation of allocations) {
      assert.deepEqual(
        {
          ...allocation,
          player_id: undefined,
        },
        {
          player_id: undefined,
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
          created_at_ms: EXECUTED_AT_MS,
          updated_at_ms: EXECUTED_AT_MS,
          version: 1,
        }
      );
    }
    const allocationJobs = runtime.database.prepare(`
      SELECT job.id, job.occurrence_key,
             job.scheduled_for_ms, job.status,
             job.attempt_count, job.lease_owner,
             job.lease_token, job.lease_expires_at_ms,
             job.started_at_ms, job.completed_at_ms,
             job.result_json, job.last_error_code,
             job.next_attempt_at_ms, job.created_at_ms,
             job.updated_at_ms, job.version
      FROM job_runs AS job
      WHERE job.job_type = 'fad_allocation'
      ORDER BY job.occurrence_key
    `).all();
    assert.equal(allocationJobs.length, 3);
    const playerIds = [
      IDS.playerA,
      IDS.playerB,
      IDS.playerC,
    ];
    for (const [index, job] of allocationJobs.entries()) {
      assert.deepEqual(
        job.occurrence_key,
        buildFreeAgentDraftAllocationOccurrenceKey({
          fadId: IDS.fad,
          playerId: playerIds[index],
        })
      );
      assert.match(job.id, /^[0-9a-f-]{36}$/u);
      assert.deepEqual(
        {
          ...job,
          id: undefined,
          occurrence_key: undefined,
        },
        {
          id: undefined,
          occurrence_key: undefined,
          scheduled_for_ms: DEADLINE_AT_MS,
          status: "pending",
          attempt_count: 0,
          lease_owner: null,
          lease_token: null,
          lease_expires_at_ms: null,
          started_at_ms: null,
          completed_at_ms: null,
          result_json: null,
          last_error_code: null,
          next_attempt_at_ms: null,
          created_at_ms: EXECUTED_AT_MS,
          updated_at_ms: EXECUTED_AT_MS,
          version: 1,
        }
      );
    }
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT player_id, eligibility_status,
               validation_code, allocation_eligibility
        FROM candidate_card_snapshot_entries
        WHERE source_entry_id = ?
      `).get(IDS.candidateThreeB),
      {
        player_id: IDS.playerB,
        eligibility_status: "invalid",
        validation_code: "FINAL_INELIGIBLE",
        allocation_eligibility:
          "excluded_structural_conflict",
      }
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT status FROM candidate_card_help_requests
        WHERE id = ?
      `).get(IDS.helpRequest).status,
      "expired"
    );
    assert.deepEqual(counts(runtime.database), {
      snapshots: 3,
      snapshotEntries: 67,
      allocations: 3,
      activities: 1,
      notifications: 1,
      outbox: 3,
    });
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT event_type, audience_kind
        FROM outbox_events
        JOIN outbox_event_audiences
          ON outbox_event_audiences.outbox_event_id =
             outbox_events.id
        ORDER BY event_type
      `).all(),
      [
        {
          event_type: "activity.created",
          audience_kind: "league",
        },
        {
          event_type: "free_agent_draft.changed",
          audience_kind: "league",
        },
        {
          event_type: "notification.created",
          audience_kind: "user",
        },
      ]
    );
    for (const event of runtime.database
      .prepare(`
        SELECT * FROM outbox_events ORDER BY event_type
      `)
      .all()) {
      const payload = JSON.parse(event.payload_json);
      assert.equal(payload.eventId, event.id);
      assert.equal(payload.type, event.event_type);
      assert.equal(payload.leagueId, IDS.league);
      assert.equal(payload.resourceId, event.aggregate_id);
      assert.equal(payload.reasonCode, "cards_published");
      assert.equal(payload.occurredAt, EXECUTED_AT_MS);
      assert.equal(payload.related.fadId, IDS.fad);
      assert.equal(Object.keys(payload.related).length, 8);
    }
  });

  test("snapshots a partial Candidate offer but creates no allocation or allocation job for it", (t) => {
    const runtime = createRuntime(t, {
      zeroCandidates: true,
    });
    insertEntry(runtime.database, {
      id: IDS.candidateOne,
      cardId: IDS.cardOne,
      teamId: IDS.teamOne,
      entryKind: "candidate",
      playerId: IDS.playerA,
      position: "F",
      slotGroup: "F",
      slotNumber: 1,
      placementState: "placed",
      proposedTotal: 900,
      proposedTerm: null,
      proposedAav: null,
      eligibilityStatus: "invalid",
      validationCode:
        "CANDIDATE_CONTRACT_INCOMPLETE",
    });
    const result = runtime.writer.executeClaimed(
      command(),
      runtime.lifecycleRepository
    );
    assert.equal(result.cardCount, 1);
    assert.equal(result.allocationCount, 0);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT occupant_kind,
               proposed_total_value_cents,
               proposed_term_years,
               proposed_aav_cents,
               eligibility_status,
               validation_code
        FROM candidate_card_snapshot_entries
        WHERE source_entry_id = ?
      `).get(IDS.candidateOne),
      {
        occupant_kind: "candidate",
        proposed_total_value_cents: 900,
        proposed_term_years: null,
        proposed_aav_cents: null,
        eligibility_status: "invalid",
        validation_code:
          "CANDIDATE_CONTRACT_INCOMPLETE",
      }
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_player_allocations
      `).get().count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM job_runs
        WHERE job_type = 'fad_allocation'
      `).get().count,
      0
    );
  });

  test("replays the durable terminal result without re-running deadline work", (t) => {
    const runtime = createRuntime(t);
    const first = runtime.writer.executeClaimed(
      command(),
      runtime.lifecycleRepository
    );
    const before = counts(runtime.database);
    const callCount = runtime.calls.length;
    const replay = runtime.writer.executeClaimed(
      command(),
      runtime.lifecycleRepository
    );

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.completedAtMs, first.completedAtMs);
    assert.deepEqual(counts(runtime.database), before);
    assert.equal(runtime.calls.length, callCount);

    const notification = runtime.database.prepare(`
      SELECT id, message_data_json
      FROM notifications
      WHERE event_type = 'fad_cards_locked'
      LIMIT 1
    `).get();
    const messageData = JSON.parse(
      notification.message_data_json
    );
    runtime.database.prepare(`
      UPDATE notifications
      SET message_data_json = ?
      WHERE id = ?
    `).run(
      JSON.stringify({
        ...messageData,
        unexpectedEvidence: "must-fail-closed",
      }),
      notification.id
    );
    assert.throws(
      () =>
        runtime.writer.executeClaimed(
          command(),
          runtime.lifecycleRepository
        ),
      (error) =>
        error.code ===
          "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
        error.details.reasonCode ===
          "PUBLICATION_NOTIFICATION_INVALID"
    );
    runtime.database.prepare(`
      UPDATE notifications
      SET message_data_json = ?
      WHERE id = ?
    `).run(
      notification.message_data_json,
      notification.id
    );

    runtime.database.prepare(
      "DELETE FROM league_activity WHERE id = ?"
    ).run(first.activityId);
    assert.throws(
      () =>
        runtime.writer.executeClaimed(
          command(),
          runtime.lifecycleRepository
        ),
      (error) =>
        error.code ===
          "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
        error.details.reasonCode ===
          "PUBLICATION_ACTIVITY_INVALID"
    );
  });

  test("supports the zero-candidate path while preserving the root barrier", (t) => {
    const runtime = createRuntime(t, {
      zeroCandidates: true,
    });
    const result = runtime.writer.executeClaimed(
      command(),
      runtime.lifecycleRepository
    );

    assert.equal(result.cardCount, 1);
    assert.equal(result.allocationCount, 0);
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_snapshot_entries
        WHERE row_kind = 'slot'
      `).get().count,
      22
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM job_runs WHERE job_type = 'fad_allocation'
      `).get().count,
      0
    );
  });

  test("fences a stale lease before any reconciliation or publication", (t) => {
    const runtime = createRuntime(t);
    assert.throws(
      () =>
        runtime.writer.executeClaimed(
          command({
            jobExecution: {
              ...command().jobExecution,
              leaseToken: uuid(999),
            },
          }),
          runtime.lifecycleRepository
        ),
      (error) =>
        error.code === "REPOSITORY_VERSION_CONFLICT" &&
        error.details.reasonCode === "JOB_LEASE_CHANGED"
    );
    assert.deepEqual(runtime.calls, []);
    assert.deepEqual(counts(runtime.database), {
      snapshots: 0,
      snapshotEntries: 0,
      allocations: 0,
      activities: 0,
      notifications: 0,
      outbox: 0,
    });
  });

  test("rolls back cards, snapshots, publications, root, and job on a late hook failure", (t) => {
    const runtime = createRuntime(t, {
      beforeCommit() {
        assert.equal(
          runtime.database.prepare(`
            SELECT status FROM free_agent_drafts WHERE id = ?
          `).get(IDS.fad).status,
          "deadline_locked"
        );
        assert.equal(
          runtime.database.prepare(`
            SELECT status FROM job_runs WHERE id = ?
          `).get(IDS.deadlineJob).status,
          "succeeded"
        );
        throw new Error("late deadline failure");
      },
    });
    assert.throws(
      () =>
        runtime.writer.executeClaimed(
          command(),
          runtime.lifecycleRepository
        ),
      (error) =>
        error.cause?.message ===
        "late deadline failure"
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, deadline_locked_at_ms, version
        FROM free_agent_drafts WHERE id = ?
      `).get(IDS.fad),
      {
        status: "cards_open",
        deadline_locked_at_ms: null,
        version: 1,
      }
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, version, result_json
        FROM job_runs WHERE id = ?
      `).get(IDS.deadlineJob),
      {
        status: "running",
        version: 2,
        result_json: null,
      }
    );
    assert.deepEqual(counts(runtime.database), {
      snapshots: 0,
      snapshotEntries: 0,
      allocations: 0,
      activities: 0,
      notifications: 0,
      outbox: 0,
    });
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count FROM candidate_card_revisions
      `).get().count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT status FROM candidate_card_help_requests
        WHERE id = ?
      `).get(IDS.helpRequest).status,
      "active"
    );
  });

  test("rejects asynchronous reconciliation and late hooks transactionally", (t) => {
    assert.throws(
      () =>
        createSqliteFreeAgentDraftDeadlineWriter({
          database: {},
          eligibilityDeadlineReconciler: {},
        }),
      /opened database/
    );
    const asyncReconciliationRuntime = createRuntime(t, {
      asyncReconciliation: true,
    });
    assert.throws(
      () =>
        asyncReconciliationRuntime.writer.executeClaimed(
          command(),
          asyncReconciliationRuntime.lifecycleRepository
        ),
      (error) =>
        error.code === "REPOSITORY_TRANSACTION_ASYNC"
    );
    assert.deepEqual(
      counts(asyncReconciliationRuntime.database),
      {
        snapshots: 0,
        snapshotEntries: 0,
        allocations: 0,
        activities: 0,
        notifications: 0,
        outbox: 0,
      }
    );

    const runtime = createRuntime(t, {
      beforeCommit() {
        return Promise.resolve();
      },
    });
    assert.throws(
      () =>
        runtime.writer.executeClaimed(
          command(),
          runtime.lifecycleRepository
        ),
      (error) =>
        error.code === "REPOSITORY_TRANSACTION_ASYNC"
    );
    assert.deepEqual(counts(runtime.database), {
      snapshots: 0,
      snapshotEntries: 0,
      allocations: 0,
      activities: 0,
      notifications: 0,
      outbox: 0,
    });
  });
});
