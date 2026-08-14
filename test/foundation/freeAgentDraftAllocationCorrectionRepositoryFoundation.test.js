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
  FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
  FREE_AGENT_DRAFT_CORRECTION_MODE,
  hashFreeAgentDraftCorrectionApplyRequest,
  serializeFreeAgentDraftCorrectionApplyRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
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
  deriveFreeAgentDraftCorrectionResourceId,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCorrectionResourceIdentityPolicy"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
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
  FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES,
  createSqliteFreeAgentDraftAllocationCorrectionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftAllocationCorrectionRepository"
);
const {
  createSqliteFreeAgentDraftCorrectionPreviewRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftCorrectionPreviewRepository"
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
const COMPLETED_AT_MS = DEADLINE_AT_MS + 10_000;
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
  otherLeague: uuid(2),
  season: uuid(3),
  commissionerUser: uuid(4),
  commissionerMembership: uuid(5),
  administratorUser: uuid(6),
  administratorMembership: uuid(7),
  administratorRole: uuid(8),
  memberUser: uuid(9),
  memberMembership: uuid(10),
  teamCorrect: uuid(11),
  teamWrong: uuid(12),
  week: uuid(13),
  readiness: uuid(14),
  fad: uuid(15),
  player: uuid(16),
  position: uuid(17),
  allocation: uuid(18),
  correctSnapshot: uuid(19),
  wrongSnapshot: uuid(20),
  correctCard: uuid(21),
  wrongCard: uuid(22),
  correctEntry: uuid(23),
  wrongEntry: uuid(24),
  correctSourceEntry: uuid(25),
  wrongSourceEntry: uuid(26),
  correctEvent: uuid(27),
  wrongEvent: uuid(28),
  oldContract: uuid(29),
  oldContractYear: uuid(30),
  oldContractEvent: uuid(31),
  oldOwnership: uuid(32),
  oldOwnershipEvent: uuid(33),
  recovery: uuid(34),
  idempotency: uuid(35),
  result: uuid(36),
  rollover: uuid(37),
  auction: uuid(38),
  draw: uuid(39),
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

function captureAndDropTriggers(database) {
  const triggers = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND sql IS NOT NULL
      ORDER BY name
    `)
    .all();
  for (const { name } of triggers) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
  return triggers.map(({ sql }) => sql);
}

function restoreTriggers(database, definitions) {
  for (const sql of definitions) database.exec(sql);
}

function mutatePastImmutableTrigger(
  database,
  triggerName,
  mutation
) {
  const trigger = database
    .prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger' AND name = ?
    `)
    .get(triggerName);
  assert.equal(typeof trigger?.sql, "string");
  database.exec(
    `DROP TRIGGER "${triggerName.replaceAll('"', '""')}"`
  );
  try {
    mutation();
  } finally {
    database.exec(trigger.sql);
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
    tertiary_colour: colours[2] || null,
    pattern_template: "mirrored-centre-band",
    logo_reference: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
}

function seedCore(database) {
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
    name: "Correction Apply League",
    name_normalized: "correction apply league",
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
      WEEK_ONE_AT_MS + 100 * 86_400_000,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 70 * 86_400_000,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 98 * 86_400_000,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
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
    first_name: "Apply",
    last_name: "Player",
    full_name: "Apply Player",
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
    current_competition_first_matchup_week_id: IDS.week,
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
    help_opens_at_ms: DEADLINE_AT_MS - 2 * 86_400_000,
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

function seedOffers(database) {
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

function seedOfferEvent(
  database,
  { id, entryId, teamId, rank, outcomeCode, status }
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
    resulting_allocation_status: status,
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

function seedWrongCompleted(database) {
  seedOffers(database);
  insert(database, "contracts", {
    id: IDS.oldContract,
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
      DEADLINE_AT_MS + 14 * 86_400_000,
    created_at_ms: DEADLINE_AT_MS + 1_000,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 1,
  });
  insert(database, "contract_years", {
    id: IDS.oldContractYear,
    league_id: IDS.league,
    contract_id: IDS.oldContract,
    season_id: IDS.season,
    year_number: 1,
    aav_cents: 500,
    status: "current",
    rollover_at_ms: null,
    created_at_ms: DEADLINE_AT_MS + 1_000,
  });
  insert(database, "contract_events", {
    id: IDS.oldContractEvent,
    league_id: IDS.league,
    contract_id: IDS.oldContract,
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
    id: IDS.oldOwnership,
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
    id: IDS.oldOwnershipEvent,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    team_id: IDS.teamWrong,
    ownership_id: IDS.oldOwnership,
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
    contract_id: IDS.oldContract,
    ownership_id: IDS.oldOwnership,
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
  seedOfferEvent(database, {
    id: IDS.wrongEvent,
    entryId: IDS.wrongEntry,
    teamId: IDS.teamWrong,
    rank: 1,
    outcomeCode: "winner",
    status: "automatic_award",
  });
  seedOfferEvent(database, {
    id: IDS.correctEvent,
    entryId: IDS.correctEntry,
    teamId: IDS.teamCorrect,
    rank: 2,
    outcomeCode: "lost_lower_aav",
    status: "automatic_award",
  });
}

function seedCorrectionRequired(database) {
  seedOffers(database);
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
  seedOfferEvent(database, {
    id: IDS.correctEvent,
    entryId: IDS.correctEntry,
    teamId: IDS.teamCorrect,
    rank: 1,
    outcomeCode: "winner",
    status: "correction_required",
  });
  seedOfferEvent(database, {
    id: IDS.wrongEvent,
    entryId: IDS.wrongEntry,
    teamId: IDS.teamWrong,
    rank: 2,
    outcomeCode: "lost_lower_total",
    status: "correction_required",
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

function seedExactTie(database) {
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

function seedLinkedPrivateDrawAuction(database) {
  seedCorrectionRequired(database);
  const nonceBytes = Buffer.alloc(32, 7);
  const { commitmentHex } =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.auction,
      nonceBytes,
    });
  database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET restricted_auction_id = ?
      WHERE id = ?
    `)
    .run(IDS.auction, IDS.allocation);
  database
    .prepare(`
      UPDATE free_agent_draft_recoveries
      SET kind = 'auction_resolution',
          rollover_id = ?,
          auction_id = ?,
          last_error_code = 'FAD_AUCTION_RESULT_WRONG'
      WHERE id = ?
    `)
    .run(IDS.rollover, IDS.auction, IDS.recovery);
  insert(database, "auctions", {
    id: IDS.auction,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    status: "open",
    opened_at_ms: DEADLINE_AT_MS + 1_000,
    resolves_at_ms: DEADLINE_AT_MS + 86_400_000,
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
  insert(database, "free_agent_draft_draws", {
    id: IDS.draw,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    auction_id: IDS.auction,
    algorithm_version: 1,
    nonce_bytes: nonceBytes,
    commitment_hex: commitmentHex,
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

function seedNoValidCorrection(database) {
  seedWrongCompleted(database);
  database
    .prepare(`
      UPDATE candidate_card_snapshots
      SET allocation_eligibility = 'excluded_over_cap',
          allocation_exclusion_reason =
            'candidate_card_over_cap',
          cap_status = 'over_cap'
    `)
    .run();
  database
    .prepare(`
      UPDATE candidate_card_snapshot_entries
      SET allocation_eligibility = 'excluded_over_cap',
          allocation_exclusion_reason =
            'candidate_card_over_cap'
    `)
    .run();
}

function createRuntime(
  t,
  seed,
  { failureInjector = () => {} } = {}
) {
  const root = fs.mkdtempSync(
    path.join(suiteRoot, "case-")
  );
  const databasePath = path.join(root, "league.sqlite3");
  fs.copyFileSync(templatePath, databasePath);
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  const triggers = captureAndDropTriggers(
    connection.database
  );
  connection.database.pragma("foreign_keys = OFF");
  connection.database.pragma(
    "ignore_check_constraints = ON"
  );
  seedCore(connection.database);
  seed(connection.database);
  connection.database.pragma(
    "ignore_check_constraints = OFF"
  );
  connection.database.pragma("foreign_keys = ON");
  restoreTriggers(connection.database, triggers);
  connection.database.pragma("wal_checkpoint(TRUNCATE)");
  const repository =
    createSqliteFreeAgentDraftAllocationCorrectionRepository({
      database: connection.database,
      failureInjector,
    });
  const previewRepository =
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
    previewRepository,
  });
}

function previewInput(overrides = {}) {
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

function writeInput(runtime, overrides = {}) {
  const preview =
    overrides.preview ||
    runtime.previewRepository.previewAllocationCorrection(
      previewInput(
        overrides.actorAuthority
          ? {
              actorAuthority: overrides.actorAuthority,
              actorMembershipId:
                overrides.actorMembershipId,
              actorUserId: overrides.actorUserId,
            }
          : {}
      )
    );
  const body = {
    mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
    previewFingerprint: preview.previewFingerprint,
    reason:
      "Reconcile the result to the immutable Candidate Card evidence.",
    confirmation:
      FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
    ...(overrides.body || {}),
  };
  const command = {
    allocationId:
      overrides.allocationId || IDS.allocation,
    body,
    expectedAllocationVersion:
      overrides.expectedAllocationVersion || 3,
    fadId: overrides.fadId || IDS.fad,
    idempotencyKey:
      overrides.clientKey || "fad-correction-apply-1",
    leagueId: overrides.leagueId || IDS.league,
  };
  return {
    actorAuthority:
      overrides.actorAuthority || "commissioner",
    actorMembershipId:
      overrides.actorMembershipId ||
      IDS.commissionerMembership,
    actorUserId:
      overrides.actorUserId || IDS.commissionerUser,
    allocationId: command.allocationId,
    body,
    clientKey: command.idempotencyKey,
    expectedAllocationVersion:
      command.expectedAllocationVersion,
    fadId: command.fadId,
    leagueId: command.leagueId,
    requestJson:
      serializeFreeAgentDraftCorrectionApplyRequest(command),
    requestSha256:
      hashFreeAgentDraftCorrectionApplyRequest(command),
    completedAtMs:
      overrides.completedAtMs || COMPLETED_AT_MS,
    idempotencyExpiresAtMs:
      (overrides.completedAtMs || COMPLETED_AT_MS) +
      86_400_000,
    idempotencyRequestId:
      overrides.idempotencyRequestId || IDS.idempotency,
    commandResultId:
      overrides.commandResultId || IDS.result,
  };
}

function replayInput(write) {
  const {
    commandResultId,
    completedAtMs,
    idempotencyExpiresAtMs,
    idempotencyRequestId,
    ...replay
  } = write;
  return replay;
}

function normalizeHashValue(value) {
  return Buffer.isBuffer(value)
    ? { type: "buffer", base64: value.toString("base64") }
    : value;
}

function semanticHashes(database) {
  const result = {};
  for (const { name } of database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()) {
    const quoted = name.replaceAll('"', '""');
    const rows = database
      .prepare(`SELECT * FROM "${quoted}"`)
      .all()
      .map((row) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              normalizeHashValue(value),
            ])
          )
        )
      )
      .sort();
    result[name] = createHash("sha256")
      .update(JSON.stringify(rows), "utf8")
      .digest("hex");
  }
  return result;
}

function noWriteSnapshot(runtime) {
  runtime.database.pragma("wal_checkpoint(TRUNCATE)");
  return {
    byteHash: createHash("sha256")
      .update(fs.readFileSync(runtime.databasePath))
      .digest("hex"),
    semanticHashes: semanticHashes(runtime.database),
    totalChanges: runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count,
  };
}

function assertNoWrites(runtime, before) {
  assert.deepEqual(noWriteSnapshot(runtime), before);
}

function assertCorrectionAuthorizationDenied(
  runtime,
  write
) {
  const before = noWriteSnapshot(runtime);
  for (const action of [
    () =>
      runtime.repository.findAllocationCorrectionReplay(
        replayInput(write)
      ),
    () =>
      runtime.repository.applyAllocationCorrection(write),
  ]) {
    assert.throws(action, (error) => {
      assert.equal(
        error.code,
        FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
          .authorizationDenied
      );
      assert.equal(
        error.message,
        "Current commissioner authority is required to apply a FAD allocation correction."
      );
      assert.equal(error.details, undefined);
      return true;
    });
  }
  assertNoWrites(runtime, before);
}

before(() => {
  suiteRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-t144-")
  );
  templatePath = path.join(suiteRoot, "schema50.sqlite3");
  const connection = openDatabase({
    databasePath: templatePath,
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad-t144-correction-foundation",
    now: () => 1,
  });
  assert.equal(
    connection.database.pragma("user_version", {
      simple: true,
    }),
    50
  );
  connection.database.pragma("wal_checkpoint(TRUNCATE)");
  connection.database.close();
});

after(() => {
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});

describe(
  "Free Agent Draft allocation-correction repository foundation",
  () => {
    test("atomically replaces a completed wrong winner, preserves history, and replays its exact immutable receipt", (t) => {
      const runtime = createRuntime(t, seedWrongCompleted);
      const write = writeInput(runtime);
      const result =
        runtime.repository.applyAllocationCorrection(write);
      const contractId =
        deriveFreeAgentDraftCorrectionResourceId({
          leagueId: IDS.league,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          acceptedFromAllocationVersion: 3,
          targetTeamId: IDS.teamCorrect,
          resourceType: "contract",
        });
      const ownershipId =
        deriveFreeAgentDraftCorrectionResourceId({
          leagueId: IDS.league,
          fadId: IDS.fad,
          allocationId: IDS.allocation,
          acceptedFromAllocationVersion: 3,
          targetTeamId: IDS.teamCorrect,
          resourceType: "ownership",
        });

      assert.equal(result.httpStatus, 200);
      assert.equal(result.replayed, false);
      assert.equal(result.data.allocation.allocationVersion, 4);
      assert.equal(result.data.allocation.decisionCode, "corrected");
      assert.equal(
        result.data.allocation.winner.teamId,
        IDS.teamCorrect
      );
      assert.equal(
        result.data.allocation.winner.contractId,
        contractId
      );
      assert.equal(
        result.data.allocation.winner.ownershipId,
        ownershipId
      );
      assert.deepEqual(result.committedRoster, {
        teams: [
          {
            leagueId: IDS.league,
            seasonId: IDS.season,
            teamId: IDS.teamCorrect,
            ownershipWitnesses: [
              {
                ownershipId,
                ownershipVersion: 1,
                state: "present",
              },
            ],
          },
          {
            leagueId: IDS.league,
            seasonId: IDS.season,
            teamId: IDS.teamWrong,
            ownershipWitnesses: [
              {
                ownershipId: IDS.oldOwnership,
                ownershipVersion: 1,
                state: "deleted",
              },
            ],
          },
        ],
      });

      assert.deepEqual(
        runtime.database
          .prepare(`SELECT status, version FROM contracts WHERE id = ?`)
          .get(IDS.oldContract),
        { status: "cancelled", version: 2 }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, rollover_at_ms
            FROM contract_years
            WHERE id = ?
          `)
          .get(IDS.oldContractYear),
        {
          status: "eliminated",
          rollover_at_ms: COMPLETED_AT_MS,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`SELECT COUNT(*) AS count FROM player_ownerships WHERE id = ?`)
          .get(IDS.oldOwnership).count,
        0
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, current_team_id, version
            FROM contracts
            WHERE id = ?
          `)
          .get(contractId),
        {
          status: "active",
          current_team_id: IDS.teamCorrect,
          version: 1,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT team_id, roster_category, position_group,
                   slot_number, version
            FROM player_ownerships
            WHERE id = ?
          `)
          .get(ownershipId),
        {
          team_id: IDS.teamCorrect,
          roster_category: "Active",
          position_group: "F",
          slot_number: 1,
          version: 1,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_allocation_events
            WHERE allocation_id = ?
              AND allocation_version = 4
              AND event_kind = 'correction_applied'
              AND activity_id IS NULL
          `)
          .get(IDS.allocation).count,
        1
      );
      assert.equal(
        runtime.database
          .prepare(`SELECT COUNT(*) AS count FROM notifications`)
          .get().count,
        0
      );
      assert.equal(
        runtime.database
          .prepare(`SELECT COUNT(*) AS count FROM outbox_events`)
          .get().count,
        2
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM outbox_events
            WHERE event_type = 'notification.created'
          `)
          .get().count,
        0
      );
      const publications = runtime.database
        .prepare(`
          SELECT *
          FROM outbox_events
          ORDER BY event_type
        `)
        .all();
      assert.deepEqual(
        publications.map((row) => row.event_type),
        [
          "activity.created",
          "free_agent_draft.changed",
        ]
      );
      const publicationRelated =
        createEmptySocketRelated({
          fadId: IDS.fad,
          teamId: IDS.teamCorrect,
          allocationId: IDS.allocation,
        });
      for (const publication of publications) {
        const activityPublication =
          publication.event_type ===
          "activity.created";
        assert.deepEqual(
          JSON.parse(publication.payload_json),
          createSocketEventEnvelope({
            eventId: publication.id,
            type: publication.event_type,
            leagueId: IDS.league,
            resourceId: activityPublication
              ? result.data.activityId
              : IDS.fad,
            version: activityPublication ? 1 : 2,
            reasonCode: "correction_applied",
            occurredAt: COMPLETED_AT_MS,
            related: publicationRelated,
          })
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT audience_kind, team_id, user_id
              FROM outbox_event_audiences
              WHERE league_id = ?
                AND outbox_event_id = ?
            `)
            .all(IDS.league, publication.id),
          [
            {
              audience_kind: "league",
              team_id: null,
              user_id: null,
            },
          ]
        );
      }
      const receipt = runtime.database
        .prepare(`
          SELECT *
          FROM free_agent_draft_allocation_correction_command_results
        `)
        .get();
      assert.equal(receipt.id, IDS.result);
      assert.equal(
        receipt.response_json,
        serializeCanonicalJsonV1(result.data)
      );
      assert.equal(
        receipt.response_sha256,
        createHash("sha256")
          .update(receipt.response_json, "utf8")
          .digest("hex")
      );

      const competingConnection = openDatabase({
        databasePath: runtime.databasePath,
        environment: "test",
      });
      try {
        const competingRepository =
          createSqliteFreeAgentDraftAllocationCorrectionRepository(
            { database: competingConnection.database }
          );
        assert.deepEqual(
          competingRepository.applyAllocationCorrection(write),
          {
            data: result.data,
            httpStatus: 200,
            replayed: true,
          }
        );
      } finally {
        competingConnection.database.close();
      }

      runtime.database
        .prepare(`
          UPDATE teams
          SET name = 'Snow Owls Updated',
              name_normalized = 'snow owls updated',
              version = version + 1
          WHERE id = ?
        `)
        .run(IDS.teamCorrect);
      const replay =
        runtime.repository.findAllocationCorrectionReplay(
          replayInput(write)
        );
      assert.deepEqual(replay, {
        data: result.data,
        httpStatus: 200,
        replayed: true,
      });
      assert.deepEqual(
        runtime.repository.applyAllocationCorrection(write),
        replay
      );

      const conflictWrite = writeInput(runtime, {
        clientKey: write.clientKey,
        expectedAllocationVersion: 3,
        body: {
          reason:
            "A different reason cannot reuse the receipt identity.",
        },
      });
      assert.throws(
        () =>
          runtime.repository.findAllocationCorrectionReplay(
            replayInput(conflictWrite)
          ),
        (error) =>
          error.code ===
          FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
            .idempotencyConflict
      );
    });

    test("lets an active league-member platform administrator correct a recovery and resolves every causal block", (t) => {
      const runtime = createRuntime(
        t,
        seedCorrectionRequired
      );
      const write = writeInput(runtime, {
        actorAuthority:
          "platform_administrator_as_commissioner",
        actorMembershipId:
          IDS.administratorMembership,
        actorUserId: IDS.administratorUser,
      });
      const result =
        runtime.repository.applyAllocationCorrection(write);
      assert.equal(result.replayed, false);
      assert.equal(
        result.data.allocation.recoveryStatus,
        "resolved"
      );
      assert.equal(
        result.data.allocation.winner.teamId,
        IDS.teamCorrect
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, last_error_code,
                   resolved_by_user_id,
                   resolved_by_membership_id,
                   resolved_authority, resolved_at_ms, version
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(IDS.recovery),
        {
          status: "resolved",
          last_error_code: null,
          resolved_by_user_id: IDS.administratorUser,
          resolved_by_membership_id:
            IDS.administratorMembership,
          resolved_authority:
            "platform_administrator_as_commissioner",
          resolved_at_ms: COMPLETED_AT_MS,
          version: 3,
        }
      );
      assert.equal(result.committedRoster.teams.length, 1);
      assert.equal(
        result.committedRoster.teams[0].teamId,
        IDS.teamCorrect
      );
    });

    test("transactionally revalidates current membership, user, and platform-role authority before replay", (t) => {
      const runtime = createRuntime(t, seedWrongCompleted);
      const write = writeInput(runtime);
      const committed =
        runtime.repository.applyAllocationCorrection(write);
      assert.equal(committed.replayed, false);

      assert.equal(
        runtime.database.prepare(`
          UPDATE league_memberships
          SET ended_at_ms = ?
          WHERE id = ? AND status = 'active'
        `).run(
          COMPLETED_AT_MS + 1,
          IDS.commissionerMembership
        ).changes,
        1
      );
      assertCorrectionAuthorizationDenied(runtime, write);

      assert.equal(
        runtime.database.prepare(`
          UPDATE league_memberships
          SET joined_at_ms = NULL,
              ended_at_ms = NULL
          WHERE id = ? AND status = 'active'
        `).run(IDS.commissionerMembership).changes,
        1
      );
      assertCorrectionAuthorizationDenied(runtime, write);

      assert.equal(
        runtime.database.prepare(`
          UPDATE league_memberships
          SET joined_at_ms = 1
          WHERE id = ?
        `).run(IDS.commissionerMembership).changes,
        1
      );
      assert.equal(
        runtime.database.prepare(`
          UPDATE users
          SET status = 'disabled',
              updated_at_ms = ?,
              version = version + 1
          WHERE id = ? AND status = 'active'
        `).run(
          COMPLETED_AT_MS + 2,
          IDS.commissionerUser
        ).changes,
        1
      );
      assertCorrectionAuthorizationDenied(runtime, write);

      const administratorRuntime = createRuntime(
        t,
        seedCorrectionRequired
      );
      const administratorWrite = writeInput(
        administratorRuntime,
        {
          actorAuthority:
            "platform_administrator_as_commissioner",
          actorMembershipId:
            IDS.administratorMembership,
          actorUserId: IDS.administratorUser,
        }
      );
      assert.equal(
        administratorRuntime.repository
          .applyAllocationCorrection(administratorWrite)
          .replayed,
        false
      );
      assert.equal(
        administratorRuntime.database.prepare(`
          UPDATE platform_roles
          SET ended_at_ms = ?
          WHERE id = ? AND status = 'active'
        `).run(
          COMPLETED_AT_MS + 3,
          IDS.administratorRole
        ).changes,
        1
      );
      assertCorrectionAuthorizationDenied(
        administratorRuntime,
        administratorWrite
      );

      assert.equal(
        administratorRuntime.database.prepare(`
          UPDATE platform_roles
          SET ended_at_ms = NULL
          WHERE id = ?
        `).run(IDS.administratorRole).changes,
        1
      );
      assert.equal(
        administratorRuntime.database.prepare(`
          UPDATE league_memberships
          SET ended_at_ms = ?
          WHERE id = ? AND status = 'active'
        `).run(
          COMPLETED_AT_MS + 4,
          IDS.administratorMembership
        ).changes,
        1
      );
      assertCorrectionAuthorizationDenied(
        administratorRuntime,
        administratorWrite
      );
    });

    test("atomically cancels a safely reversible linked restricted auction and reveals its private draw empty", (t) => {
      const runtime = createRuntime(
        t,
        seedLinkedPrivateDrawAuction
      );
      const result =
        runtime.repository.applyAllocationCorrection(
          writeInput(runtime)
        );

      assert.equal(result.replayed, false);
      assert.equal(
        result.data.allocation.status,
        "automatic_award"
      );
      assert.equal(
        result.data.allocation.winner.teamId,
        IDS.teamCorrect
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, version
            FROM auctions
            WHERE id = ?
          `)
          .get(IDS.auction),
        { status: "cancelled", version: 3 }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT outcome_code, status, winning_team_id,
                   winning_bid_id, contract_id, ownership_id
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(IDS.auction),
        {
          outcome_code: "recovered",
          status: "cancelled",
          winning_team_id: null,
          winning_bid_id: null,
          contract_id: null,
          ownership_id: null,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT ordered_tied_bid_ids_json,
                   ordered_tied_team_ids_json,
                   selected_index, selected_team_id,
                   revealed_at_ms, version
            FROM free_agent_draft_draws
            WHERE id = ?
          `)
          .get(IDS.draw),
        {
          ordered_tied_bid_ids_json: "[]",
          ordered_tied_team_ids_json: "[]",
          selected_index: null,
          selected_team_id: null,
          revealed_at_ms: COMPLETED_AT_MS,
          version: 2,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM auction_events
            WHERE auction_id = ?
              AND event_type = 'auction_cancelled'
          `)
          .get(IDS.auction).count,
        1
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, last_error_code, version
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(IDS.recovery),
        {
          status: "resolved",
          last_error_code: null,
          version: 3,
        }
      );
      assert.equal(
        result.data.appliedDeltas.some(
          (delta) =>
            delta.resourceType === "auction" &&
            delta.resourceId === IDS.auction &&
            delta.action === "cancel"
        ),
        true
      );
    });

    test("can release a completed wrong winner to an exact no-valid-offer result while preserving excluded offers", (t) => {
      const runtime = createRuntime(
        t,
        seedNoValidCorrection
      );
      const result =
        runtime.repository.applyAllocationCorrection(
          writeInput(runtime)
        );
      assert.equal(
        result.data.allocation.status,
        "no_valid_offer"
      );
      assert.equal(result.data.allocation.winner, null);
      assert.deepEqual(
        result.data.allocation.rankedOffers.map(
          ({ valid, rank, outcomeCode }) => ({
            valid,
            rank,
            outcomeCode,
          })
        ),
        [
          { valid: false, rank: null, outcomeCode: "invalid" },
          { valid: false, rank: null, outcomeCode: "invalid" },
        ]
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM contracts
            WHERE league_id = ? AND status = 'active'
          `)
          .get(IDS.league).count,
        0
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM player_ownerships
            WHERE league_id = ? AND player_id = ?
          `)
          .get(IDS.league, IDS.player).count,
        0
      );
      assert.deepEqual(result.committedRoster, {
        teams: [
          {
            leagueId: IDS.league,
            seasonId: IDS.season,
            teamId: IDS.teamWrong,
            ownershipWitnesses: [
              {
                ownershipId: IDS.oldOwnership,
                ownershipVersion: 1,
                state: "deleted",
              },
            ],
          },
        ],
      });
    });

    test("fails closed without writes for exact ties, stale previews, denied authority, and cross-allocation scope", (t) => {
      {
        const runtime = createRuntime(t, seedExactTie);
        const write = writeInput(runtime);
        const before = noWriteSnapshot(runtime);
        assert.throws(
          () =>
            runtime.repository.applyAllocationCorrection(write),
          (error) =>
            error.code ===
            FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
              .notApplicable
        );
        assertNoWrites(runtime, before);
      }
      {
        const runtime = createRuntime(t, seedWrongCompleted);
        const write = writeInput(runtime, {
          expectedAllocationVersion: 2,
        });
        const before = noWriteSnapshot(runtime);
        assert.throws(
          () =>
            runtime.repository.applyAllocationCorrection(write),
          (error) => {
            assert.equal(
              error.code,
              REPOSITORY_ERROR_CODES.versionConflict
            );
            assert.deepEqual(error.details, {
              currentVersion: 3,
              refetch: true,
            });
            return true;
          }
        );
        assertNoWrites(runtime, before);
      }
      {
        const runtime = createRuntime(t, seedWrongCompleted);
        const write = writeInput(runtime, {
          body: { previewFingerprint: "a".repeat(64) },
        });
        const before = noWriteSnapshot(runtime);
        assert.throws(
          () =>
            runtime.repository.applyAllocationCorrection(write),
          (error) =>
            error.code ===
            FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
              .notApplicable
        );
        assertNoWrites(runtime, before);
      }
      {
        const runtime = createRuntime(t, seedWrongCompleted);
        const write = writeInput(runtime);
        const denied = {
          ...write,
          actorAuthority: "commissioner",
          actorMembershipId: IDS.memberMembership,
          actorUserId: IDS.memberUser,
        };
        const before = noWriteSnapshot(runtime);
        assert.throws(
          () =>
            runtime.repository.applyAllocationCorrection(denied),
          (error) =>
            error.code ===
            FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
              .authorizationDenied
        );
        assertNoWrites(runtime, before);
      }
      {
        const runtime = createRuntime(t, seedWrongCompleted);
        const write = writeInput(runtime, {
          allocationId: uuid(999),
        });
        const before = noWriteSnapshot(runtime);
        assert.throws(
          () =>
            runtime.repository.applyAllocationCorrection(write),
          (error) =>
            error.code ===
            REPOSITORY_ERROR_CODES.recordNotFound
        );
        assertNoWrites(runtime, before);
      }
    });

    test("fails closed without writes when immutable allocation evidence is corrupt", (t) => {
      const runtime = createRuntime(t, seedWrongCompleted);
      const write = writeInput(runtime);
      mutatePastImmutableTrigger(
        runtime.database,
        "free_agent_draft_allocation_events_immutable_update",
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_allocation_events
              SET rank_position = NULL
              WHERE id = ?
            `)
            .run(IDS.correctEvent);
        }
      );
      const before = noWriteSnapshot(runtime);

      assert.throws(
        () =>
          runtime.repository.applyAllocationCorrection(write),
        (error) =>
          error.code ===
          REPOSITORY_ERROR_CODES.schemaIncompatible
      );
      assertNoWrites(runtime, before);
    });

    test("rolls back every material mutation across destructive and late transaction seams", (t) => {
      for (const { seam, seed } of [
        {
          seam: "afterLinkedAuctionCancellation",
          seed: seedLinkedPrivateDrawAuction,
        },
        {
          seam: "afterCurrentWinnerRelease",
          seed: seedWrongCompleted,
        },
        {
          seam: "afterRecomputedWinnerAssignment",
          seed: seedWrongCompleted,
        },
        {
          seam: "afterAllocationEvents",
          seed: seedWrongCompleted,
        },
        {
          seam: "afterActivityAndSideEffects",
          seed: seedWrongCompleted,
        },
        {
          seam: "afterImmutableResult",
          seed: seedWrongCompleted,
        },
        {
          seam: "beforeCommit",
          seed: seedWrongCompleted,
        },
      ]) {
        const injected = new Error(`rollback injection: ${seam}`);
        const runtime = createRuntime(t, seed, {
          failureInjector(currentSeam) {
            if (currentSeam === seam) throw injected;
          },
        });
        const write = writeInput(runtime);
        const before = noWriteSnapshot(runtime);
        assert.throws(
          () =>
            runtime.repository.applyAllocationCorrection(write),
          (error) =>
            error.code ===
              REPOSITORY_ERROR_CODES.operationFailed &&
            error.cause === injected,
          seam
        );
        const after = noWriteSnapshot(runtime);
        assert.equal(after.byteHash, before.byteHash, seam);
        assert.deepEqual(
          after.semanticHashes,
          before.semanticHashes,
          seam
        );
        assert.equal(runtime.database.inTransaction, false, seam);
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM free_agent_draft_allocation_correction_command_results
            `)
            .get().count,
          0,
          seam
        );
      }
    });
  }
);
