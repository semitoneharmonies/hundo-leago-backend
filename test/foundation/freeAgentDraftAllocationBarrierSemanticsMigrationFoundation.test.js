const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const LOCKED_MIGRATION_ID = 30;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const CLOCK = Object.freeze({
  openedAtMs: 827_190_000,
  helpOpensAtMs: 827_200_000,
  deadlineAtMs: 1_000_000_000,
  firstMatchupAtMs: 1_604_800_000,
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function makeIds(base) {
  return Object.freeze({
    league: uuid(base + 1),
    season: uuid(base + 2),
    fad: uuid(base + 3),
    readiness: uuid(base + 4),
    week: uuid(base + 5),
    player: uuid(base + 6),
    allocation: uuid(base + 7),
    currentRollover: uuid(base + 8),
    targetRollover: uuid(base + 9),
    auction: uuid(base + 10),
    draw: uuid(base + 11),
    job: uuid(base + 12),
    contract: uuid(base + 13),
    ownership: uuid(base + 14),
    teams: [uuid(base + 20), uuid(base + 21), uuid(base + 22)],
    cards: [uuid(base + 30), uuid(base + 31), uuid(base + 32)],
    snapshots: [
      uuid(base + 40),
      uuid(base + 41),
      uuid(base + 42),
    ],
    entries: [uuid(base + 50), uuid(base + 51), uuid(base + 52)],
    sourceEntries: [
      uuid(base + 60),
      uuid(base + 61),
      uuid(base + 62),
    ],
    users: [uuid(base + 70), uuid(base + 71), uuid(base + 72)],
    memberships: [
      uuid(base + 80),
      uuid(base + 81),
      uuid(base + 82),
    ],
    revisions: [
      uuid(base + 90),
      uuid(base + 91),
      uuid(base + 92),
    ],
    participants: [
      uuid(base + 100),
      uuid(base + 101),
      uuid(base + 102),
    ],
    offerEvents: [
      uuid(base + 110),
      uuid(base + 111),
      uuid(base + 112),
    ],
    stateEvent: uuid(base + 120),
  });
}

function createRuntime() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-allocation-semantics-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });

  try {
    const migrations = discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).filter(({ id }) => id <= LOCKED_MIGRATION_ID);
    assert.deepEqual(
      migrations.map(({ id }) => id),
      Array.from(
        { length: LOCKED_MIGRATION_ID },
        (_, index) => index + 1
      )
    );
    applyMigrations({
      database: connection.database,
      migrations,
      applicationBuildId: "fad-allocation-semantics-foundation",
      now: () => 1_000,
    });
    connection.database.pragma("foreign_keys = OFF");
    return { ...connection, temporaryRoot };
  } catch (error) {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
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

function tableTriggers(database, tableName) {
  return database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name = ?
      ORDER BY name
    `)
    .all(tableName);
}

function dropTrigger(database, triggerName) {
  database.exec(
    `DROP TRIGGER "${triggerName.replaceAll('"', '""')}"`
  );
}

function dropInsertTriggers(database, tableName) {
  for (const trigger of tableTriggers(database, tableName)) {
    if (/\b(?:BEFORE|AFTER)\s+INSERT\b/i.test(trigger.sql)) {
      dropTrigger(database, trigger.name);
    }
  }
}

function isolateTableTrigger(database, tableName, triggerName) {
  for (const trigger of tableTriggers(database, tableName)) {
    if (trigger.name !== triggerName) {
      dropTrigger(database, trigger.name);
    }
  }
  assert.ok(
    tableTriggers(database, tableName).some(
      ({ name }) => name === triggerName
    ),
    `missing isolated trigger ${triggerName}`
  );
}

function seedFad(database, ids, status) {
  const rapid = status === "rapid";
  const deadlineLockedAtMs = ["allocating", "rapid"].includes(status)
    ? CLOCK.deadlineAtMs
    : null;
  const allocationCompletedAtMs = rapid
    ? CLOCK.deadlineAtMs + 100
    : null;
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key: `fad:${ids.season}:readiness`,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id: ids.week,
    schedule_recovery_id: null,
    participating_team_count: 3,
    status,
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Isolated allocation-barrier acceptance fixture.",
    opening_authority: "system",
    opened_at_ms: CLOCK.openedAtMs,
    help_opens_at_ms: CLOCK.helpOpensAtMs,
    candidate_deadline_at_ms: CLOCK.deadlineAtMs,
    first_matchup_starts_at_ms: CLOCK.firstMatchupAtMs,
    deadline_locked_at_ms: deadlineLockedAtMs,
    allocation_completed_at_ms: allocationCompletedAtMs,
    completed_at_ms: null,
    created_at_ms: CLOCK.openedAtMs,
    updated_at_ms:
      allocationCompletedAtMs ??
      deadlineLockedAtMs ??
      CLOCK.openedAtMs,
    version: 1,
  });
}

function seedRollover(
  database,
  ids,
  {
    id = ids.currentRollover,
    sequence = 1,
    predecessorRolloverId = null,
    opensAtMs = CLOCK.deadlineAtMs,
  } = {}
) {
  const rollsOverAtMs = opensAtMs + DAY_MS;
  insert(database, "free_agent_draft_rollovers", {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    sequence,
    window_kind: sequence <= 7 ? "initial" : "extension",
    predecessor_rollover_id: predecessorRolloverId,
    extension_reason: sequence <= 7 ? null : "restricted_auction",
    extension_source_id: sequence <= 7 ? null : ids.allocation,
    opens_at_ms: opensAtMs,
    creation_cutoff_at_ms: rollsOverAtMs - HOUR_MS,
    rolls_over_at_ms: rollsOverAtMs,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: opensAtMs,
    updated_at_ms: opensAtMs,
    version: 1,
  });
  return Object.freeze({
    id,
    sequence,
    opensAtMs,
    creationCutoffAtMs: rollsOverAtMs - HOUR_MS,
    rollsOverAtMs,
  });
}

function seedAuction(database, ids, { openedAtMs, resolvesAtMs }) {
  insert(database, "auctions", {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status: "open",
    opened_at_ms: openedAtMs,
    resolves_at_ms: resolvesAtMs,
    opened_by_user_id: null,
    created_at_ms: openedAtMs,
    updated_at_ms: openedAtMs,
    version: 1,
  });
}

function seedAuctionContext(database, ids, rolloverId, createdAtMs) {
  insert(database, "auction_contexts", {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    source_kind: "fad_restricted",
    fad_id: ids.fad,
    fad_rollover_id: rolloverId,
    fad_allocation_id: ids.allocation,
    fad_origin: "candidate_tie_restricted",
    created_at_ms: createdAtMs,
  });
}

function seedOffers(database, ids, contracts) {
  const offers = contracts.map((contract, index) => {
    const aavCents = Math.floor(
      (contract.totalValueCents + Math.floor(contract.termYears / 2)) /
        contract.termYears
    );
    const offer = Object.freeze({
      ...contract,
      index,
      id: ids.entries[index],
      teamId: ids.teams[index],
      aavCents,
    });
    insert(database, "candidate_card_snapshot_entries", {
      id: offer.id,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      snapshot_id: ids.snapshots[index],
      card_id: ids.cards[index],
      team_id: offer.teamId,
      row_kind: "slot",
      occupant_kind: "candidate",
      slot_group: "F",
      slot_number: 1,
      source_entry_id: ids.sourceEntries[index],
      source_entry_version: 1,
      player_id: ids.player,
      effective_position_group: "F",
      conflict_code: null,
      carryover_ownership_id: null,
      carryover_contract_id: null,
      source_roster_category: null,
      carryover_original_total_value_cents: null,
      carryover_original_term_years: null,
      carryover_aav_cents: null,
      remaining_years: null,
      proposed_total_value_cents: offer.totalValueCents,
      proposed_term_years: offer.termYears,
      proposed_aav_cents: offer.aavCents,
      eligibility_status: "valid",
      validation_code: null,
      last_edited_by_user_id: ids.users[index],
      last_edited_by_membership_id: ids.memberships[index],
      last_edited_by_authority: "manager",
      last_edited_at_ms: CLOCK.deadlineAtMs - 1,
      created_at_ms: CLOCK.deadlineAtMs,
      allocation_eligibility: "eligible",
      allocation_exclusion_reason: null,
    });
    return offer;
  });
  return Object.freeze(offers);
}

function seedAllocation(
  database,
  ids,
  {
    status,
    decisionCode,
    updatedAtMs,
    winningOffer = null,
    restricted = false,
  }
) {
  insert(database, "free_agent_draft_player_allocations", {
    id: ids.allocation,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    status,
    decision_code: decisionCode,
    winning_snapshot_entry_id: winningOffer?.id ?? null,
    winning_team_id: winningOffer?.teamId ?? null,
    contract_id: winningOffer ? ids.contract : null,
    ownership_id: winningOffer ? ids.ownership : null,
    restricted_auction_id: restricted ? ids.auction : null,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: restricted ? 600 : null,
    restricted_minimum_term_years: restricted ? 2 : null,
    restricted_minimum_aav_cents: restricted ? 300 : null,
    accounted_at_ms: winningOffer ? updatedAtMs : null,
    last_error_code: null,
    created_at_ms: CLOCK.deadlineAtMs,
    updated_at_ms: updatedAtMs,
    version: 2,
  });
}

function seedAllocationEvents(
  database,
  ids,
  offers,
  {
    status,
    decisionCode,
    updatedAtMs,
    outcomes,
    restricted = false,
  }
) {
  const base = {
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    allocation_version: 2,
    player_id: ids.player,
    resulting_allocation_status: status,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: "{}",
    occurred_at_ms: updatedAtMs,
    created_at_ms: updatedAtMs,
    version: 1,
  };
  for (const offer of offers) {
    insert(database, "free_agent_draft_allocation_events", {
      ...base,
      id: ids.offerEvents[offer.index],
      event_kind: "offer_considered",
      snapshot_entry_id: offer.id,
      team_id: offer.teamId,
      offer_valid: 1,
      rank_position: offer.index + 1,
      offer_outcome_code: outcomes[offer.index],
      decision_code: null,
      contract_id: null,
      ownership_id: null,
      auction_id: null,
    });
  }
  insert(database, "free_agent_draft_allocation_events", {
    ...base,
    id: ids.stateEvent,
    event_kind: restricted
      ? "restricted_state_changed"
      : "decision_recorded",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: decisionCode,
    contract_id: restricted ? null : ids.contract,
    ownership_id: restricted ? null : ids.ownership,
    auction_id: restricted ? ids.auction : null,
  });
}

function seedRestrictedResources(
  database,
  ids,
  offers,
  { rollover, participantIndexes }
) {
  seedAuction(database, ids, {
    openedAtMs: rollover.opensAtMs,
    resolvesAtMs: rollover.rollsOverAtMs,
  });
  seedAuctionContext(database, ids, rollover.id, rollover.opensAtMs);
  insert(database, "free_agent_draft_draws", {
    id: ids.draw,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    auction_id: ids.auction,
    algorithm_version: 1,
    nonce_bytes: Buffer.alloc(32, 0x30),
    commitment_hex: "a".repeat(64),
    ordered_tied_bid_ids_json: null,
    ordered_tied_team_ids_json: null,
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: null,
    created_at_ms: rollover.opensAtMs,
    updated_at_ms: rollover.opensAtMs,
    version: 1,
  });
  for (const index of participantIndexes) {
    const offer = offers[index];
    insert(database, "free_agent_draft_auction_participants", {
      id: ids.participants[index],
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      allocation_id: ids.allocation,
      auction_id: ids.auction,
      team_id: offer.teamId,
      status: "active",
      source_snapshot_entry_id: offer.id,
      originating_candidate_revision_id: ids.revisions[index],
      minimum_total_value_cents: offer.totalValueCents,
      minimum_term_years: offer.termYears,
      minimum_aav_cents: offer.aavCents,
      active_improvement_bid_id: null,
      manager_edit_limit: 1,
      cooldown_duration_ms: 4_500_000,
      first_improvement_at_ms: null,
      current_cooldown_anchor_at_ms: null,
      improvement_committed_at_ms: null,
      originating_actor_user_id: ids.users[index],
      originating_actor_membership_id: ids.memberships[index],
      originating_actor_authority: "manager",
      removed_by_user_id: null,
      removed_by_membership_id: null,
      removed_authority: null,
      removal_reason: null,
      removed_at_ms: null,
      created_at_ms: rollover.opensAtMs,
      updated_at_ms: rollover.opensAtMs,
      version: 1,
    });
  }
}

function seedJob(
  database,
  ids,
  { scheduledForMs, status, leaseExpiresAtMs = null }
) {
  const active = ["leased", "running"].includes(status);
  insert(database, "job_runs", {
    id: ids.job,
    league_id: ids.league,
    season_id: ids.season,
    job_type: "fad_restricted_activation",
    occurrence_key:
      `fad:${ids.fad}:restricted-activate:${ids.allocation}:` +
      `${scheduledForMs}`,
    scheduled_for_ms: scheduledForMs,
    status,
    attempt_count: status === "pending" ? 0 : 1,
    lease_owner: active ? "fad-allocation-semantics" : null,
    lease_expires_at_ms: active ? leaseExpiresAtMs : null,
    started_at_ms: status === "running" ? scheduledForMs : null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: CLOCK.openedAtMs,
    updated_at_ms: active ? scheduledForMs : CLOCK.openedAtMs,
    version: status === "pending" ? 1 : 2,
    lease_token: active ? `lease:${ids.job}` : null,
    next_attempt_at_ms: null,
  });
}

function transitionFadToRapid(database, ids, atMs) {
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'rapid',
          allocation_completed_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
    `)
    .run(atMs, atMs, ids.fad);
}

function transitionScheduledAllocationToActive(database, ids, atMs) {
  database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'restricted_active',
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
    `)
    .run(atMs, ids.allocation);
}

function setupAutomaticCase(database, base, winnerIndex) {
  const ids = makeIds(base);
  seedFad(database, ids, "allocating");
  const offers = seedOffers(database, ids, [
    { totalValueCents: 700, termYears: 1 },
    { totalValueCents: 600, termYears: 1 },
  ]);
  const decidedAtMs = CLOCK.deadlineAtMs + base;
  seedAllocation(database, ids, {
    status: "automatic_award",
    decisionCode: "highest_total",
    updatedAtMs: decidedAtMs,
    winningOffer: offers[winnerIndex],
  });
  seedAllocationEvents(database, ids, offers, {
    status: "automatic_award",
    decisionCode: "highest_total",
    updatedAtMs: decidedAtMs,
    outcomes: winnerIndex === 0
      ? ["winner", "lost_lower_total"]
      : ["lost_lower_total", "winner"],
  });
  return { ids, completionAtMs: decidedAtMs + 1 };
}

function setupActiveTieCase(
  database,
  base,
  { participantIndexes, withActivationJob = false }
) {
  const ids = makeIds(base);
  seedFad(database, ids, "allocating");
  const offers = seedOffers(database, ids, [
    { totalValueCents: 600, termYears: 2 },
    { totalValueCents: 600, termYears: 2 },
    { totalValueCents: 600, termYears: 2 },
  ]);
  const rollover = seedRollover(database, ids);
  const decidedAtMs = rollover.creationCutoffAtMs - 1;
  seedAllocation(database, ids, {
    status: "restricted_active",
    decisionCode: "exact_total_and_term_tie",
    updatedAtMs: decidedAtMs,
    restricted: true,
  });
  seedAllocationEvents(database, ids, offers, {
    status: "restricted_active",
    decisionCode: "exact_total_and_term_tie",
    updatedAtMs: decidedAtMs,
    outcomes: offers.map(() => "restricted_tied"),
    restricted: true,
  });
  const immediateRollover = Object.freeze({
    ...rollover,
    opensAtMs: decidedAtMs,
  });
  seedRestrictedResources(database, ids, offers, {
    rollover: immediateRollover,
    participantIndexes,
  });
  if (withActivationJob) {
    seedJob(database, ids, {
      scheduledForMs: decidedAtMs,
      status: "pending",
    });
  }
  return { ids, completionAtMs: decidedAtMs + 1 };
}

function setupScheduledActivationCase(database, base, jobStatus) {
  const ids = makeIds(base);
  seedFad(database, ids, "rapid");
  const offers = seedOffers(database, ids, [
    { totalValueCents: 600, termYears: 2 },
    { totalValueCents: 600, termYears: 2 },
  ]);
  const current = seedRollover(database, ids);
  const target = seedRollover(database, ids, {
    id: ids.targetRollover,
    sequence: 2,
    predecessorRolloverId: current.id,
    opensAtMs: current.rollsOverAtMs,
  });
  const decidedAtMs = current.creationCutoffAtMs;
  seedAllocation(database, ids, {
    status: "restricted_scheduled",
    decisionCode: "exact_total_and_term_tie",
    updatedAtMs: decidedAtMs,
    restricted: true,
  });
  seedAllocationEvents(database, ids, offers, {
    status: "restricted_scheduled",
    decisionCode: "exact_total_and_term_tie",
    updatedAtMs: decidedAtMs,
    outcomes: offers.map(() => "restricted_tied"),
    restricted: true,
  });
  seedRestrictedResources(database, ids, offers, {
    rollover: target,
    participantIndexes: [0, 1],
  });
  seedJob(database, ids, {
    scheduledForMs: target.opensAtMs,
    status: jobStatus,
    leaseExpiresAtMs:
      jobStatus === "running" ? target.opensAtMs + 60_000 : null,
  });
  return { ids, target };
}

describe("migration 0030 FAD allocation barrier semantics", () => {
  let runtime;

  before(() => {
    runtime = createRuntime();
    isolateTableTrigger(
      runtime.database,
      "free_agent_drafts",
      "free_agent_drafts_allocation_completion_barrier"
    );
    isolateTableTrigger(
      runtime.database,
      "free_agent_draft_player_allocations",
      "free_agent_draft_allocations_forward_update"
    );
    for (const tableName of [
      "candidate_card_snapshot_entries",
      "free_agent_draft_allocation_events",
      "free_agent_draft_rollovers",
      "auctions",
      "auction_contexts",
      "free_agent_draft_draws",
      "free_agent_draft_auction_participants",
      "job_runs",
    ]) {
      dropInsertTriggers(runtime.database, tableName);
    }
  });

  after(() => {
    if (runtime?.database.open) runtime.database.close();
    if (runtime?.temporaryRoot) {
      fs.rmSync(runtime.temporaryRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects a lower-ranked automatic winner even when outcome counts look valid", () => {
    const valid = setupAutomaticCase(runtime.database, 100_000, 0);
    assert.doesNotThrow(() => {
      transitionFadToRapid(
        runtime.database,
        valid.ids,
        valid.completionAtMs
      );
    });

    const invalid = setupAutomaticCase(runtime.database, 110_000, 1);
    assert.throws(() => {
      transitionFadToRapid(
        runtime.database,
        invalid.ids,
        invalid.completionAtMs
      );
    });
  });

  test("rejects an exact tie whose active allowlist omits a top-tied team", () => {
    const valid = setupActiveTieCase(runtime.database, 120_000, {
      participantIndexes: [0, 1, 2],
    });
    assert.doesNotThrow(() => {
      transitionFadToRapid(
        runtime.database,
        valid.ids,
        valid.completionAtMs
      );
    });

    const invalid = setupActiveTieCase(runtime.database, 130_000, {
      participantIndexes: [0, 1],
    });
    assert.throws(() => {
      transitionFadToRapid(
        runtime.database,
        invalid.ids,
        invalid.completionAtMs
      );
    });
  });

  test("rejects an immediate restricted allocation with an activation job", () => {
    const valid = setupActiveTieCase(runtime.database, 140_000, {
      participantIndexes: [0, 1, 2],
    });
    assert.doesNotThrow(() => {
      transitionFadToRapid(
        runtime.database,
        valid.ids,
        valid.completionAtMs
      );
    });

    const invalid = setupActiveTieCase(runtime.database, 150_000, {
      participantIndexes: [0, 1, 2],
      withActivationJob: true,
    });
    assert.throws(() => {
      transitionFadToRapid(
        runtime.database,
        invalid.ids,
        invalid.completionAtMs
      );
    });
  });

  test("rejects scheduled activation before its persisted open time", () => {
    const valid = setupScheduledActivationCase(
      runtime.database,
      160_000,
      "running"
    );
    assert.doesNotThrow(() => {
      transitionScheduledAllocationToActive(
        runtime.database,
        valid.ids,
        valid.target.opensAtMs
      );
    });

    const early = setupScheduledActivationCase(
      runtime.database,
      170_000,
      "running"
    );
    assert.throws(() => {
      transitionScheduledAllocationToActive(
        runtime.database,
        early.ids,
        early.target.opensAtMs - 1
      );
    });
  });

  test("rejects due scheduled activation without its exact live job lease", () => {
    const valid = setupScheduledActivationCase(
      runtime.database,
      180_000,
      "running"
    );
    assert.doesNotThrow(() => {
      transitionScheduledAllocationToActive(
        runtime.database,
        valid.ids,
        valid.target.opensAtMs
      );
    });

    const pending = setupScheduledActivationCase(
      runtime.database,
      190_000,
      "pending"
    );
    assert.throws(() => {
      transitionScheduledAllocationToActive(
        runtime.database,
        pending.ids,
        pending.target.opensAtMs
      );
    });
  });
});
