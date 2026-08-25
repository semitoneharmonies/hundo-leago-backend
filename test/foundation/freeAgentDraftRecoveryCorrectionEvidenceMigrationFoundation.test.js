"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
  applyMigrations,
  discoverMigrations,
} = require(
  "../../src/infrastructure/database/migrate"
);

const CANONICAL_MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 86_400_000;
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const DEADLINE_AT_MS = WEEK_ONE_AT_MS - 7 * DAY_MS;
const OPENED_AT_MS = DEADLINE_AT_MS - 30 * DAY_MS;
const ROLLOVER_AT_MS = DEADLINE_AT_MS + DAY_MS;
const QUEUED_ACCEPTED_AT_MS =
  ROLLOVER_AT_MS - 30 * 60 * 1_000;
const ACTION_AT_MS = DEADLINE_AT_MS + 10_000;
const CORRECTION_AT_MS = DEADLINE_AT_MS + 20_000;
const AUCTION_OPENED_AT_MS = DEADLINE_AT_MS + 30_000;
const AUCTION_RESOLVES_AT_MS = ROLLOVER_AT_MS;
const AUCTION_FAILED_AT_MS = AUCTION_RESOLVES_AT_MS + 100;
const RECOVERY_STARTED_AT_MS = AUCTION_FAILED_AT_MS + 100;
const AUCTION_CANCELLED_AT_MS = RECOVERY_STARTED_AT_MS + 100;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function createRuntime(t, prefix) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    root,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return {
    ...connection,
    migrationsDirectory,
  };
}

function copyMigrations(runtime, minimumId, maximumId) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (
      migration.id < minimumId ||
      migration.id > maximumId
    ) {
      continue;
    }
    fs.copyFileSync(
      migration.filePath,
      path.join(
        runtime.migrationsDirectory,
        migration.fileName
      )
    );
  }
}

function migrate(runtime, buildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory:
        runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  try {
    database.prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns
          .map((column) => `@${column}`)
          .join(", ")}
      )
    `).run(values);
  } catch (error) {
    throw new Error(
      `fixture insert failed for ${tableName}: ${error.message}`,
      { cause: error }
    );
  }
}

function captureAndDropTriggers(database) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  for (const { name } of triggers) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const { sql } of triggers) {
    database.exec(sql);
  }
}

function transaction(database, operation) {
  database.exec("BEGIN");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function assertConstraint(operation, pattern = /constraint|FAD/i) {
  assert.throws(operation, (error) => {
    assert.match(String(error.message), pattern);
    return true;
  });
}

function assertHealthy(database) {
  assert.equal(
    database.pragma("integrity_check", {
      simple: true,
    }),
    "ok"
  );
  assert.deepEqual(
    database.pragma("foreign_key_check"),
    []
  );
}

function fixtureIds(base) {
  return Object.freeze({
    user: uuid(base + 1),
    adminUser: uuid(base + 2),
    inactiveUser: uuid(base + 3),
    membership: uuid(base + 4),
    adminMembership: uuid(base + 5),
    inactiveMembership: uuid(base + 6),
    adminRole: uuid(base + 7),
    inactiveRole: uuid(base + 8),
    league: uuid(base + 10),
    season: uuid(base + 11),
    week: uuid(base + 12),
    readiness: uuid(base + 13),
    fad: uuid(base + 14),
    team: uuid(base + 15),
    player: uuid(base + 16),
    otherPlayer: uuid(base + 17),
    rollover: uuid(base + 18),
    queue: uuid(base + 19),
    job: uuid(base + 20),
    otherJob: uuid(base + 21),
    recovery: uuid(base + 22),
    otherRecovery: uuid(base + 23),
    trueOperationRecovery: uuid(base + 24),
    trueOperation: uuid(base + 25),
    allocation: uuid(base + 26),
    correction: uuid(base + 27),
    correctionEvent: uuid(base + 28),
    activity: uuid(base + 29),
    idempotency: uuid(base + 30),
    commandResult: uuid(base + 31),
    auction: uuid(base + 32),
    context: uuid(base + 33),
    draw: uuid(base + 34),
    failureEvent: uuid(base + 35),
    cancellationEvent: uuid(base + 36),
    resolution: uuid(base + 37),
    adminAllocation: uuid(base + 38),
    inactiveCorrection: uuid(base + 39),
    adminCorrection: uuid(base + 40),
    adminCorrectionEvent: uuid(base + 41),
    adminActivity: uuid(base + 42),
    adminIdempotency: uuid(base + 43),
    adminCommandResult: uuid(base + 44),
    inactiveIdempotency: uuid(base + 45),
    inactiveCommandResult: uuid(base + 46),
    unrelatedCorrection: uuid(base + 47),
    auctionIdempotency: uuid(base + 48),
    auctionCommandResult: uuid(base + 49),
    card: uuid(base + 50),
    cardEntry: uuid(base + 51),
    cardRevision: uuid(base + 52),
    snapshot: uuid(base + 53),
    snapshotEntry: uuid(base + 54),
    contract: uuid(base + 55),
    ownership: uuid(base + 56),
    activationJob: uuid(base + 57),
    activationRecovery: uuid(base + 58),
    fallbackAuction: uuid(base + 59),
    fallbackDraw: uuid(base + 60),
    bid: uuid(base + 61),
    fadTeam: uuid(base + 62),
    assignment: uuid(base + 63),
    acceptanceRequest: uuid(base + 64),
    resolutionRollover: uuid(base + 65),
    nominationAuction: uuid(base + 66),
    nominationDraw: uuid(base + 67),
    nominationBid: uuid(base + 68),
    nominationActivationJob: uuid(base + 69),
    offerEvent: uuid(base + 70),
    replacementAssignment: uuid(base + 71),
    participant: uuid(base + 72),
  });
}

function insertCore(database, base) {
  const ids = fixtureIds(base);
  for (const [kind, userId] of [
    ["commissioner", ids.user],
    ["administrator", ids.adminUser],
    ["inactive", ids.inactiveUser],
  ]) {
    insert(database, "users", {
      id: userId,
      email_normalized: `${kind}-${base}@example.test`,
      email_display: `${kind}-${base}@example.test`,
      display_name: `${kind} ${base}`,
      display_name_normalized: `${kind} ${base}`,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }
  insert(database, "leagues", {
    id: ids.league,
    name: `FAD 39 League ${base}`,
    name_normalized: `fad 39 league ${base}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  for (const membership of [
    {
      id: ids.membership,
      user: ids.user,
      permission: "commissioner",
      status: "active",
      endedAtMs: null,
    },
    {
      id: ids.adminMembership,
      user: ids.adminUser,
      permission: "manager",
      status: "active",
      endedAtMs: null,
    },
    {
      id: ids.inactiveMembership,
      user: ids.inactiveUser,
      permission: "manager",
      status: "ended",
      endedAtMs: 2,
    },
  ]) {
    insert(database, "league_memberships", {
      id: membership.id,
      league_id: ids.league,
      user_id: membership.user,
      permission_category: membership.permission,
      status: membership.status,
      joined_at_ms: 1,
      ended_at_ms: membership.endedAtMs,
      created_at_ms: 1,
      updated_at_ms: membership.endedAtMs ?? 1,
      version: membership.status === "active" ? 1 : 2,
    });
  }
  for (const role of [
    {
      id: ids.adminRole,
      user: ids.adminUser,
    },
    {
      id: ids.inactiveRole,
      user: ids.inactiveUser,
    },
  ]) {
    insert(database, "platform_roles", {
      id: role.id,
      user_id: role.user,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: ids.user,
      granted_at_ms: 1,
      ended_at_ms: null,
      version: 1,
    });
  }
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `2026-27 ${base}`,
    nhl_season_key: `2026${String(base).slice(-4)}`,
    status: "active",
    regular_season_starts_at_ms: WEEK_ONE_AT_MS,
    regular_season_ends_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 17 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?,
        current_season_id = ?
    WHERE id = ?
  `).run(ids.membership, ids.season, ids.league);
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `FAD 39 Team ${base}`,
    name_normalized: `fad 39 team ${base}`,
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
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
    week_key: `2026-W${String(base).slice(-2)}`,
    sequence: 1,
    starts_at_ms: WEEK_ONE_AT_MS,
    baseline_at_ms: WEEK_ONE_AT_MS + 1_000,
    locks_at_ms: WEEK_ONE_AT_MS + 2_000,
    ends_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  for (const [id, firstName] of [
    [ids.player, "Primary"],
    [ids.otherPlayer, "Other"],
  ]) {
    insert(database, "players", {
      id,
      first_name: firstName,
      last_name: `Candidate ${base}`,
      full_name: `${firstName} Candidate ${base}`,
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }
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
    current_competition_first_matchup_week_id:
      ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "rapid",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Focused schema-39 fixture.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: DEADLINE_AT_MS - 2 * DAY_MS,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: DEADLINE_AT_MS,
    allocation_completed_at_ms: DEADLINE_AT_MS + 1_000,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS + 1_000,
    version: 4,
  });
  insert(database, "free_agent_draft_rollovers", {
    id: ids.rollover,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    sequence: 1,
    window_kind: "initial",
    predecessor_rollover_id: null,
    extension_reason: null,
    extension_source_id: null,
    opens_at_ms: DEADLINE_AT_MS,
    creation_cutoff_at_ms: ROLLOVER_AT_MS - 3_600_000,
    rolls_over_at_ms: ROLLOVER_AT_MS,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  return ids;
}

function jobRecord(ids, {
  id = ids.job,
  occurrenceKey = `fad:${ids.fad}:operation`,
  jobType = "fad_deadline.process",
  status = "pending",
  scheduledForMs = ACTION_AT_MS,
  updatedAtMs = 1,
  leaseExpiresAtMs = AUCTION_CANCELLED_AT_MS + 10_000,
} = {}) {
  const active = status === "running" || status === "leased";
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    job_type: jobType,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: scheduledForMs,
    status,
    attempt_count: active ? 1 : 0,
    lease_owner: active ? "fad39-worker" : null,
    lease_expires_at_ms: active
      ? leaseExpiresAtMs
      : null,
    started_at_ms: active ? updatedAtMs : null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: 1,
    updated_at_ms: updatedAtMs,
    version: active ? 2 : 1,
    lease_token: active ? uuid(Number(String(id).slice(-12)) + 500_000) : null,
    next_attempt_at_ms: null,
  };
}

function queueRecord(ids, overrides = {}) {
  return {
    id: ids.queue,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    player_id: ids.player,
    source_rollover_id: ids.rollover,
    target_opening_rollover_id: ids.rollover,
    resolution_rollover_id: null,
    opening_total_value_cents: 600,
    opening_term_years: 2,
    opening_aav_cents: 300,
    binding_illegality_confirmed: 1,
    binding_confirmed_at_ms: ACTION_AT_MS,
    submitted_by_user_id: ids.user,
    submitted_by_membership_id: ids.membership,
    accepted_at_ms: ACTION_AT_MS,
    candidate_card_version_observed: 1,
    team_version_observed: 1,
    status: "queued",
    opened_auction_id: null,
    opened_starter_bid_id: null,
    opened_at_ms: null,
    terminal_at_ms: null,
    validation_code: null,
    created_at_ms: ACTION_AT_MS,
    updated_at_ms: ACTION_AT_MS,
    version: 1,
    ...overrides,
  };
}

function installCandidateEvidence(database, ids) {
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
  insert(database, "free_agent_draft_teams", {
    id: ids.fadTeam,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  });
  insert(database, "candidate_cards", {
    id: ids.card,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    status: "locked_complete",
    completeness_code: "complete",
    filled_mandatory_count: 18,
    missing_mandatory_count: 0,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    maximum_possible_cap_cents: 300,
    locked_at_ms: DEADLINE_AT_MS,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 3,
  });
  insert(database, "candidate_card_entries", {
    id: ids.cardEntry,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    entry_kind: "candidate",
    player_id: ids.player,
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
    proposed_total_value_cents: 600,
    proposed_term_years: 2,
    proposed_aav_cents: 300,
    eligibility_status: "valid",
    validation_code: null,
    last_acknowledgement_revision_id: null,
    created_by_user_id: ids.user,
    created_by_membership_id: ids.membership,
    created_by_authority: "commissioner",
    last_edited_by_user_id: ids.user,
    last_edited_by_membership_id: ids.membership,
    last_edited_by_authority: "commissioner",
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  insert(database, "candidate_card_revisions", {
    id: ids.cardRevision,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    resulting_card_version: 1,
    action: "candidate_added",
    affected_entry_id: ids.cardEntry,
    player_id: ids.player,
    actor_user_id: ids.user,
    actor_membership_id: ids.membership,
    actor_authority: "commissioner",
    before_evidence_json: "{}",
    after_evidence_json: JSON.stringify({
      playerId: ids.player,
    }),
    potential_illegality_acknowledged: 0,
    warning_codes_json: "[]",
    occurred_at_ms: OPENED_AT_MS,
    created_at_ms: OPENED_AT_MS,
    version: 1,
  });
  insert(database, "candidate_card_snapshots", {
    id: ids.snapshot,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    locked_card_version: 3,
    locked_status: "locked_complete",
    completeness_code: "complete",
    filled_mandatory_count: 18,
    missing_mandatory_count: 0,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
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
  });
  insert(database, "candidate_card_snapshot_entries", {
    id: ids.snapshotEntry,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    snapshot_id: ids.snapshot,
    card_id: ids.card,
    team_id: ids.team,
    row_kind: "slot",
    occupant_kind: "candidate",
    slot_group: "F",
    slot_number: 1,
    source_entry_id: ids.cardEntry,
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
    proposed_total_value_cents: 600,
    proposed_term_years: 2,
    proposed_aav_cents: 300,
    eligibility_status: "valid",
    validation_code: null,
    last_edited_by_user_id: ids.user,
    last_edited_by_membership_id: ids.membership,
    last_edited_by_authority: "commissioner",
    last_edited_at_ms: OPENED_AT_MS,
    created_at_ms: DEADLINE_AT_MS,
  });
}

function allocationOfferEventRecord(
  ids,
  {
    offerValid = 0,
    rankPosition = null,
    offerOutcomeCode = "excluded_over_cap",
    allocationId = ids.allocation,
    allocationVersion = 3,
    resultingAllocationStatus = "invalid",
    decisionCode = "invalid_snapshot",
  } = {}
) {
  return {
    id: ids.offerEvent,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: allocationId,
    allocation_version: allocationVersion,
    player_id: ids.player,
    event_kind: "offer_considered",
    snapshot_entry_id: ids.snapshotEntry,
    team_id: ids.team,
    offer_valid: offerValid,
    rank_position: rankPosition,
    offer_outcome_code: offerOutcomeCode,
    decision_code: decisionCode,
    resulting_allocation_status: resultingAllocationStatus,
    contract_id: null,
    ownership_id: null,
    auction_id: null,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: JSON.stringify({
      reason: offerOutcomeCode,
    }),
    occurred_at_ms: DEADLINE_AT_MS + 1_000,
    created_at_ms: DEADLINE_AT_MS + 1_000,
    version: 1,
  };
}

function installQueuedNominationPrerequisites(
  database,
  ids
) {
  installCandidateEvidence(database, ids);
  insert(database, "free_agent_draft_rollovers", {
    id: ids.resolutionRollover,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    sequence: 2,
    window_kind: "initial",
    predecessor_rollover_id: ids.rollover,
    extension_reason: null,
    extension_source_id: null,
    opens_at_ms: ROLLOVER_AT_MS,
    creation_cutoff_at_ms:
      ROLLOVER_AT_MS + DAY_MS - 3_600_000,
    rolls_over_at_ms: ROLLOVER_AT_MS + DAY_MS,
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

function acceptQueuedNomination(
  database,
  ids,
  {
    requestActorUserId = ids.user,
    requestId = ids.acceptanceRequest,
    queueOverrides = {},
  } = {}
) {
  const requestBody = JSON.stringify({
    acceptedAtMs: QUEUED_ACCEPTED_AT_MS,
    fadId: ids.fad,
    playerId: ids.player,
    teamId: ids.team,
  });
  insert(
    database,
    "idempotency_requests",
    idempotencyRecord(ids, {
      id: requestId,
      actorUserId: requestActorUserId,
      operation: "auction.start",
      requestHash: sha256(requestBody),
      createdAtMs: QUEUED_ACCEPTED_AT_MS,
      clientKey: `queued-nomination:${ids.queue}`,
    })
  );
  insert(
    database,
    "free_agent_draft_nomination_queue",
    queueRecord(ids, {
      binding_confirmed_at_ms: QUEUED_ACCEPTED_AT_MS,
      accepted_at_ms: QUEUED_ACCEPTED_AT_MS,
      candidate_card_version_observed: 3,
      created_at_ms: QUEUED_ACCEPTED_AT_MS,
      updated_at_ms: QUEUED_ACCEPTED_AT_MS,
      acceptance_idempotency_request_id: requestId,
      ...queueOverrides,
    })
  );
}

function installQueuedOpeningEvidence(
  database,
  ids,
  {
    auctionPlayerId = ids.player,
    openedAtMs = ROLLOVER_AT_MS,
    activationOccurrenceKey =
      `fad:${ids.fad}:nomination-open:${ids.queue}:${ROLLOVER_AT_MS}`,
    activationStatus = "running",
    replaceManager = false,
    includeUnrelatedRequest = false,
  } = {}
) {
  if (replaceManager) {
    database.prepare(`
      UPDATE team_manager_assignments
      SET status = 'ended',
          ended_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
    `).run(
      ROLLOVER_AT_MS - 1,
      ids.league,
      ids.assignment
    );
    insert(database, "team_manager_assignments", {
      id: ids.replacementAssignment,
      league_id: ids.league,
      team_id: ids.team,
      user_id: ids.adminUser,
      membership_id: ids.adminMembership,
      assigned_by_user_id: ids.user,
      replaces_assignment_id: ids.assignment,
      status: "accepted",
      assigned_at_ms: ROLLOVER_AT_MS - 1,
      accepted_at_ms: ROLLOVER_AT_MS - 1,
      ended_at_ms: null,
      version: 1,
    });
  }
  if (includeUnrelatedRequest) {
    insert(database, "idempotency_requests", {
      ...idempotencyRecord(ids, {
        id: ids.idempotency,
        actorUserId: ids.user,
        operation: "auction.start",
        requestHash: sha256(`unrelated:${ids.queue}`),
        createdAtMs: QUEUED_ACCEPTED_AT_MS,
        clientKey: `unrelated:${ids.queue}`,
      }),
      status: "completed",
      result_type: "auction",
      result_id: ids.nominationAuction,
      completed_at_ms: QUEUED_ACCEPTED_AT_MS,
    });
  }
  insert(database, "auctions", {
    id: ids.nominationAuction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: auctionPlayerId,
    status: "open",
    opened_at_ms: openedAtMs,
    resolves_at_ms: ROLLOVER_AT_MS + DAY_MS,
    opened_by_user_id: ids.user,
    created_at_ms: openedAtMs,
    updated_at_ms: openedAtMs,
    version: 1,
  });
  insert(database, "auction_contexts", {
    id: ids.nominationAuction,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.nominationAuction,
    source_kind: "fad_open_rapid",
    fad_id: ids.fad,
    fad_rollover_id: ids.resolutionRollover,
    fad_allocation_id: null,
    fad_origin: "queued_nomination",
    created_at_ms: openedAtMs,
  });
  insert(
    database,
    "free_agent_draft_draws",
    drawRecord(ids, {
      id: ids.nominationDraw,
      auction_id: ids.nominationAuction,
      nonce_bytes: Buffer.alloc(32, 0x51),
      commitment_hex: sha256(
        `queued-nomination:${ids.nominationAuction}`
      ),
      created_at_ms: openedAtMs,
      updated_at_ms: openedAtMs,
    })
  );
  insert(
    database,
    "job_runs",
    jobRecord(ids, {
      id: ids.nominationActivationJob,
      occurrenceKey: activationOccurrenceKey,
      jobType: "fad_queued_nomination_activation",
      status: activationStatus,
      scheduledForMs: ROLLOVER_AT_MS,
      updatedAtMs: openedAtMs,
      leaseExpiresAtMs: openedAtMs + 3_600_000,
    })
  );
}

function queuedStarterBidRecord(ids, overrides = {}) {
  return {
    id: ids.nominationBid,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.nominationAuction,
    team_id: ids.team,
    submitted_by_user_id: ids.user,
    total_value_cents: 600,
    term_years: 2,
    lowest_offered_aav_cents: 300,
    first_submitted_at_ms: QUEUED_ACCEPTED_AT_MS,
    last_edited_at_ms: QUEUED_ACCEPTED_AT_MS,
    edit_count: 0,
    status: "active",
    idempotency_request_id: ids.acceptanceRequest,
    version: 1,
    ...overrides,
  };
}

function openQueuedNomination(database, ids) {
  database.prepare(`
    UPDATE free_agent_draft_nomination_queue
    SET resolution_rollover_id = ?,
        status = 'opened',
        opened_auction_id = ?,
        opened_starter_bid_id = ?,
        opened_at_ms = ?,
        terminal_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ?
      AND id = ?
  `).run(
    ids.resolutionRollover,
    ids.nominationAuction,
    ids.nominationBid,
    ROLLOVER_AT_MS,
    ROLLOVER_AT_MS,
    ROLLOVER_AT_MS,
    ids.league,
    ids.queue
  );
}

function createQueuedOpeningFixture(
  t,
  prefix,
  base,
  openingOptions = {}
) {
  const fixture = createFreshFixture(
    t,
    prefix,
    base,
    installQueuedNominationPrerequisites
  );
  acceptQueuedNomination(
    fixture.runtime.database,
    fixture.ids
  );
  const triggers = captureAndDropTriggers(
    fixture.runtime.database
  );
  installQueuedOpeningEvidence(
    fixture.runtime.database,
    fixture.ids,
    openingOptions
  );
  restoreTriggers(
    fixture.runtime.database,
    triggers
  );
  return fixture;
}

function installInteractiveFadBidEvidence(
  database,
  ids,
  sourceKind
) {
  installCandidateEvidence(database, ids);
  if (sourceKind === "fad_restricted") {
    installCorrectableFadAuction(database, ids, {
      allocationStatus: "restricted_active",
      auctionStatus: "open",
      sourceKind,
    });
    insert(
      database,
      "free_agent_draft_auction_participants",
      {
        id: ids.participant,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        allocation_id: ids.allocation,
        auction_id: ids.auction,
        team_id: ids.team,
        status: "active",
        source_snapshot_entry_id: ids.snapshotEntry,
        originating_candidate_revision_id: ids.cardRevision,
        minimum_total_value_cents: 600,
        minimum_term_years: 2,
        minimum_aav_cents: 300,
        active_improvement_bid_id: null,
        manager_edit_limit: 1,
        cooldown_duration_ms: 4_500_000,
        first_improvement_at_ms: null,
        current_cooldown_anchor_at_ms: null,
        improvement_committed_at_ms: null,
        originating_actor_user_id: ids.user,
        originating_actor_membership_id: ids.membership,
        originating_actor_authority: "commissioner",
        removed_by_user_id: null,
        removed_by_membership_id: null,
        removed_authority: null,
        removal_reason: null,
        removed_at_ms: null,
        created_at_ms: CORRECTION_AT_MS - 1_000,
        updated_at_ms: CORRECTION_AT_MS - 1_000,
        version: 1,
      }
    );
    return Object.freeze({
      auctionId: ids.auction,
      openedAtMs: CORRECTION_AT_MS - 1_000,
      totalValueCents: 700,
      termYears: 2,
      aavCents: 350,
    });
  }

  insert(database, "auctions", {
    ...auctionRecord(ids, {
      status: "open",
      opened_at_ms: AUCTION_OPENED_AT_MS,
      resolves_at_ms: ROLLOVER_AT_MS,
      created_at_ms: AUCTION_OPENED_AT_MS,
      updated_at_ms: AUCTION_OPENED_AT_MS,
      version: 1,
    }),
  });
  insert(
    database,
    "auction_contexts",
    auctionContextRecord(ids, {
      source_kind: "fad_open_rapid",
      fad_origin: "manager_nomination",
    })
  );
  insert(database, "free_agent_draft_draws", drawRecord(ids));
  return Object.freeze({
    auctionId: ids.auction,
    openedAtMs: AUCTION_OPENED_AT_MS,
    totalValueCents: 600,
    termYears: 2,
    aavCents: 300,
  });
}

function recoveryRecord(ids, overrides = {}) {
  return {
    id: ids.recovery,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: null,
    allocation_id: null,
    rollover_id: null,
    auction_id: null,
    job_run_id: ids.job,
    kind: "deadline_retry",
    status: "pending",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: null,
    commissioner_reason: null,
    created_by_operation_id: ids.job,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: ACTION_AT_MS - 1,
    updated_at_ms: ACTION_AT_MS - 1,
    resolved_at_ms: null,
    version: 1,
    ...overrides,
  };
}

function createFreshFixture(
  t,
  prefix,
  base,
  populate
) {
  const runtime = createRuntime(t, prefix);
  copyMigrations(runtime, 1, 39);
  migrate(runtime, `${prefix}schema39`);
  const triggers = captureAndDropTriggers(runtime.database);
  const ids = insertCore(runtime.database, base);
  populate?.(runtime.database, ids);
  restoreTriggers(runtime.database, triggers);
  assertHealthy(runtime.database);
  return { runtime, ids };
}

function idempotencyRecord(
  ids,
  {
    id = ids.idempotency,
    actorUserId = ids.user,
    operation,
    requestHash,
    createdAtMs,
    clientKey = `command:${id}`,
  }
) {
  return {
    id,
    league_id: ids.league,
    actor_user_id: actorUserId,
    operation,
    client_key: clientKey,
    request_hash: requestHash,
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: createdAtMs,
    completed_at_ms: null,
    expires_at_ms: createdAtMs + DAY_MS,
  };
}

function recoveryRequestJson(ids, reason) {
  return JSON.stringify({
    body: {
      action: "retry_deadline",
      reason,
      resourceId: null,
    },
    domain:
      "hundo-leago.free-agent-draft-recovery-action-request",
    fadId: ids.fad,
    leagueId: ids.league,
    schemaVersion: 1,
  });
}

function recoveryResponseJson(ids, status = "pending") {
  return JSON.stringify({
    acceptedAtMs: ACTION_AT_MS,
    action: "retry_deadline",
    occurrenceKey: `fad:${ids.fad}:operation`,
    operationId: ids.job,
    pollDescriptor: {
      fadId: ids.fad,
      kind: "fad_recovery",
      leagueId: ids.league,
    },
    resourceId: null,
    status,
  });
}

function recoveryCommandResult(
  ids,
  {
    id = ids.commandResult,
    idempotencyRequestId = ids.idempotency,
    actorUserId = ids.user,
    actorMembershipId = ids.membership,
    actorAuthority = "commissioner",
    reason = "Retry the deterministic deadline operation.",
    requestJson = recoveryRequestJson(ids, reason),
  } = {}
) {
  const responseJson = recoveryResponseJson(ids);
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    recovery_id: ids.recovery,
    idempotency_request_id: idempotencyRequestId,
    action: "retry_deadline",
    resource_kind: "fad",
    resource_id: ids.fad,
    operation_id: ids.job,
    job_run_id: ids.job,
    occurrence_key: `fad:${ids.fad}:operation`,
    actor_user_id: actorUserId,
    actor_membership_id: actorMembershipId,
    actor_authority: actorAuthority,
    commissioner_reason: reason,
    request_json: requestJson,
    request_sha256: sha256(requestJson),
    accepted_status: "pending",
    accepted_at_ms: ACTION_AT_MS,
    response_http_status: 202,
    response_json: responseJson,
    response_sha256: sha256(responseJson),
    version: 1,
  };
}

function allocationRecord(
  ids,
  {
    id = ids.allocation,
    playerId = ids.player,
  } = {}
) {
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: playerId,
    status: "invalid",
    decision_code: "invalid_snapshot",
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
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
  };
}

function installAutomaticAwardEvidence(database, ids) {
  insert(database, "free_agent_draft_teams", {
    id: ids.fadTeam,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  });
  insert(database, "candidate_cards", {
    id: ids.card,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    status: "locked_complete",
    completeness_code: "complete",
    filled_mandatory_count: 18,
    missing_mandatory_count: 0,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    maximum_possible_cap_cents: 300,
    locked_at_ms: DEADLINE_AT_MS,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 3,
  });
  insert(database, "candidate_card_entries", {
    id: ids.cardEntry,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    entry_kind: "candidate",
    player_id: ids.player,
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
    proposed_total_value_cents: 600,
    proposed_term_years: 2,
    proposed_aav_cents: 300,
    eligibility_status: "valid",
    validation_code: null,
    last_acknowledgement_revision_id: null,
    created_by_user_id: ids.user,
    created_by_membership_id: ids.membership,
    created_by_authority: "commissioner",
    last_edited_by_user_id: ids.user,
    last_edited_by_membership_id: ids.membership,
    last_edited_by_authority: "commissioner",
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  insert(database, "candidate_card_snapshots", {
    id: ids.snapshot,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    locked_card_version: 3,
    locked_status: "locked_complete",
    completeness_code: "complete",
    filled_mandatory_count: 18,
    missing_mandatory_count: 0,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
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
  });
  insert(database, "candidate_card_snapshot_entries", {
    id: ids.snapshotEntry,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    snapshot_id: ids.snapshot,
    card_id: ids.card,
    team_id: ids.team,
    row_kind: "slot",
    occupant_kind: "candidate",
    slot_group: "F",
    slot_number: 1,
    source_entry_id: ids.cardEntry,
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
    proposed_total_value_cents: 600,
    proposed_term_years: 2,
    proposed_aav_cents: 300,
    eligibility_status: "valid",
    validation_code: null,
    last_edited_by_user_id: ids.user,
    last_edited_by_membership_id: ids.membership,
    last_edited_by_authority: "commissioner",
    last_edited_at_ms: OPENED_AT_MS,
    created_at_ms: DEADLINE_AT_MS,
  });
  insert(database, "contracts", {
    id: ids.contract,
    league_id: ids.league,
    player_id: ids.player,
    current_team_id: ids.team,
    contract_type: "normal",
    original_total_value_cents: 600,
    original_term_years: 2,
    aav_cents: 300,
    start_season_id: ids.season,
    status: "active",
    acquisition_source_type: "free_agent_draft_correction",
    acquisition_source_id: ids.allocation,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: CORRECTION_AT_MS,
    updated_at_ms: CORRECTION_AT_MS,
    version: 1,
  });
  insert(database, "player_ownerships", {
    id: ids.ownership,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    team_id: ids.team,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "free_agent_draft_correction",
    acquired_transaction_id: ids.allocation,
    created_at_ms: CORRECTION_AT_MS,
    updated_at_ms: CORRECTION_AT_MS,
    version: 1,
  });
}

function correctionRecord(
  ids,
  {
    id = ids.correction,
    allocationId = ids.allocation,
    actorUserId = ids.user,
    correctedAtMs = CORRECTION_AT_MS,
    beforeStatus = "invalid",
    beforeVersion = 3,
    afterStatus = "no_valid_offer",
    afterVersion = beforeVersion + 1,
  } = {}
) {
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    feature: "free_agent_draft_allocation",
    feature_record_id: allocationId,
    actor_user_id: actorUserId,
    reason: "Recompute the locked allocation snapshot.",
    before_snapshot_json: JSON.stringify({
      status: beforeStatus,
      version: beforeVersion,
    }),
    after_snapshot_json: JSON.stringify({
      decisionCode: "corrected",
      status: afterStatus,
      version: afterVersion,
    }),
    corrected_at_ms: correctedAtMs,
  };
}

function correctionEventRecord(
  ids,
  {
    id = ids.correctionEvent,
    allocationId = ids.allocation,
    playerId = ids.player,
    correctionId = ids.correction,
    actorUserId = ids.user,
    actorMembershipId = ids.membership,
    actorAuthority = "commissioner",
    occurredAtMs = CORRECTION_AT_MS,
    allocationVersion = 4,
    resultingStatus = "no_valid_offer",
    contractId = null,
    ownershipId = null,
    auctionId = null,
  } = {}
) {
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: allocationId,
    allocation_version: allocationVersion,
    player_id: playerId,
    event_kind: "correction_applied",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: "corrected",
    resulting_allocation_status: resultingStatus,
    contract_id: contractId,
    ownership_id: ownershipId,
    auction_id: auctionId,
    activity_id: null,
    correction_id: correctionId,
    actor_user_id: actorUserId,
    actor_membership_id: actorMembershipId,
    actor_authority: actorAuthority,
    evidence_json: JSON.stringify({
      correctionId,
      mode: "recompute_locked_snapshot",
    }),
    occurred_at_ms: occurredAtMs,
    created_at_ms: occurredAtMs,
    version: 1,
  };
}

function activityRecord(
  ids,
  {
    id = ids.activity,
    allocationId = ids.allocation,
    playerId = ids.player,
    actorUserId = ids.user,
    actorAuthority = "commissioner",
    occurredAtMs = CORRECTION_AT_MS,
  } = {}
) {
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    event_type: "fad_allocation_corrected",
    actor_user_id: actorUserId,
    actor_authority: actorAuthority,
    team_id: null,
    player_id: playerId,
    related_type: "free_agent_draft_allocation",
    related_id: allocationId,
    display_summary: "A locked FAD allocation was corrected.",
    reason: "Recompute the locked allocation snapshot.",
    metadata_json: JSON.stringify({ allocationId }),
    occurred_at_ms: occurredAtMs,
  };
}

function correctionReceiptEvidence(
  ids,
  {
    acceptedVersion = 3,
    resultingVersion = acceptedVersion + 1,
    appliedDeltas = [],
    activityId = ids.activity,
    correctionId = ids.correction,
  } = {}
) {
  const previewJson = JSON.stringify({
    allocationId: ids.allocation,
    allocationVersion: acceptedVersion,
    confirmationText: "APPLY FAD CORRECTION",
    reversible: true,
  });
  const previewFingerprint = sha256(previewJson);
  const requestJson = JSON.stringify({
    allocationId: ids.allocation,
    confirmation: "APPLY FAD CORRECTION",
    domain: "hundo-leago.fad-allocation-correction-request",
    fadId: ids.fad,
    leagueId: ids.league,
    mode: "recompute_locked_snapshot",
    previewFingerprint,
    reason: "Recompute the locked allocation snapshot.",
    schemaVersion: 1,
  });
  const responseJson = JSON.stringify({
    activityId,
    allocation: {
      allocationId: ids.allocation,
      allocationVersion: resultingVersion,
    },
    appliedDeltas,
    completedAtMs: CORRECTION_AT_MS,
    correctionId,
  });
  return {
    previewJson,
    previewFingerprint,
    requestJson,
    requestHash: sha256(requestJson),
    responseJson,
    responseHash: sha256(responseJson),
  };
}

function correctionCommandResult(
  ids,
  evidence,
  {
    actorUserId = ids.user,
    actorMembershipId = ids.membership,
    actorAuthority = "commissioner",
    acceptedVersion = 3,
    resultingVersion = acceptedVersion + 1,
  } = {}
) {
  return {
    id: ids.commandResult,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    player_id: ids.player,
    idempotency_request_id: ids.idempotency,
    commissioner_correction_id: ids.correction,
    activity_id: ids.activity,
    actor_user_id: actorUserId,
    actor_membership_id: actorMembershipId,
    actor_authority: actorAuthority,
    accepted_from_allocation_version: acceptedVersion,
    resulting_allocation_version: resultingVersion,
    preview_json: evidence.previewJson,
    preview_fingerprint: evidence.previewFingerprint,
    request_json: evidence.requestJson,
    request_sha256: evidence.requestHash,
    response_http_status: 200,
    response_json: evidence.responseJson,
    response_sha256: evidence.responseHash,
    completed_at_ms: CORRECTION_AT_MS,
    version: 1,
  };
}

function auctionRecord(ids, overrides = {}) {
  return {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status: "failed",
    opened_at_ms: AUCTION_OPENED_AT_MS,
    resolves_at_ms: AUCTION_RESOLVES_AT_MS,
    opened_by_user_id: ids.user,
    created_at_ms: AUCTION_OPENED_AT_MS,
    updated_at_ms: AUCTION_FAILED_AT_MS,
    version: 2,
    ...overrides,
  };
}

function auctionContextRecord(ids, overrides = {}) {
  return {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    source_kind: "fad_open_rapid",
    fad_id: ids.fad,
    fad_rollover_id: ids.rollover,
    fad_allocation_id: null,
    fad_origin: "manager_nomination",
    created_at_ms: AUCTION_OPENED_AT_MS,
    ...overrides,
  };
}

function drawRecord(ids, overrides = {}) {
  return {
    id: ids.draw,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: null,
    auction_id: ids.auction,
    algorithm_version: 1,
    nonce_bytes: Buffer.alloc(32, 0x39),
    commitment_hex: "a".repeat(64),
    ordered_tied_bid_ids_json: null,
    ordered_tied_team_ids_json: null,
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: null,
    created_at_ms: AUCTION_OPENED_AT_MS,
    updated_at_ms: AUCTION_OPENED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function installCorrectableFadAuction(
  database,
  ids,
  {
    allocationStatus = "restricted_active",
    auctionStatus = "open",
    sourceKind = "fad_restricted",
    includeBid = false,
    includeAutomaticAwardEvidence = false,
    recoveryKind = null,
  } = {}
) {
  if (includeAutomaticAwardEvidence) {
    installAutomaticAwardEvidence(database, ids);
  }
  const fallback = sourceKind === "fad_open_rapid";
  const relevantAuctionId = fallback
    ? ids.fallbackAuction
    : ids.auction;
  const relevantDrawId = fallback
    ? ids.fallbackDraw
    : ids.draw;
  if (fallback) {
    insert(
      database,
      "auctions",
      auctionRecord(ids, {
        status: "no_winner",
        opened_at_ms: CORRECTION_AT_MS - 2_000,
        resolves_at_ms: CORRECTION_AT_MS - 1_500,
        created_at_ms: CORRECTION_AT_MS - 2_000,
        updated_at_ms: CORRECTION_AT_MS - 1_500,
        version: 3,
      })
    );
  }
  insert(
    database,
    "auctions",
    auctionRecord(ids, {
      id: relevantAuctionId,
      status: auctionStatus,
      opened_at_ms: CORRECTION_AT_MS - 1_000,
      resolves_at_ms: ROLLOVER_AT_MS,
      created_at_ms: CORRECTION_AT_MS - 1_000,
      updated_at_ms:
        auctionStatus === "open"
          ? CORRECTION_AT_MS - 1_000
          : CORRECTION_AT_MS - 1,
      version: auctionStatus === "open" ? 1 : 2,
    })
  );
  insert(database, "free_agent_draft_player_allocations", {
    id: ids.allocation,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    status: allocationStatus,
    decision_code: fallback
      ? "restricted_no_improvement_fallback"
      : "exact_total_and_term_tie",
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: ids.auction,
    fallback_open_auction_id: fallback
      ? ids.fallbackAuction
      : null,
    restricted_minimum_total_cents: 600,
    restricted_minimum_term_years: 2,
    restricted_minimum_aav_cents: 300,
    accounted_at_ms: null,
    last_error_code:
      allocationStatus === "correction_required"
        ? "AUCTION_RESOLUTION_FAILED"
        : null,
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: CORRECTION_AT_MS - 1_000,
    version: 3,
  });
  insert(
    database,
    "auction_contexts",
    auctionContextRecord(ids, {
      id: relevantAuctionId,
      auction_id: relevantAuctionId,
      source_kind: sourceKind,
      fad_allocation_id: ids.allocation,
      fad_origin: fallback
        ? "restricted_no_improvement_fallback"
        : "candidate_tie_restricted",
      created_at_ms: CORRECTION_AT_MS - 1_000,
    })
  );
  insert(
    database,
    "free_agent_draft_draws",
    drawRecord(ids, {
      id: relevantDrawId,
      allocation_id: ids.allocation,
      auction_id: relevantAuctionId,
      nonce_bytes: Buffer.alloc(32, 0x44),
      commitment_hex: sha256(
        `correctable:${ids.league}:${relevantAuctionId}`
      ),
      created_at_ms: CORRECTION_AT_MS - 1_000,
      updated_at_ms: CORRECTION_AT_MS - 1_000,
    })
  );
  if (includeBid) {
    insert(database, "auction_bids", {
      id: ids.bid,
      league_id: ids.league,
      season_id: ids.season,
      auction_id: relevantAuctionId,
      team_id: ids.team,
      submitted_by_user_id: ids.user,
      total_value_cents: 700,
      term_years: 2,
      lowest_offered_aav_cents: 350,
      first_submitted_at_ms: CORRECTION_AT_MS - 500,
      last_edited_at_ms: CORRECTION_AT_MS - 500,
      edit_count: 0,
      status: "active",
      idempotency_request_id: null,
      version: 1,
    });
  }
  if (recoveryKind !== null) {
    const jobType =
      recoveryKind === "restricted_activation"
        ? "fad_restricted_activation"
        : recoveryKind === "fallback_activation"
          ? "fad_fallback_activation"
          : "auction.resolve.target";
    insert(database, "job_runs", {
      ...jobRecord(ids, {
        id: ids.activationJob,
        occurrenceKey:
          recoveryKind === "auction_resolution"
            ? `auction:${relevantAuctionId}:${ROLLOVER_AT_MS}`
            : `fad:${ids.fad}:${recoveryKind}:${ids.allocation}`,
        jobType,
        scheduledForMs: CORRECTION_AT_MS - 1_000,
      }),
      status: "failed",
      attempt_count: 1,
      lease_owner: null,
      lease_token: null,
      lease_expires_at_ms: null,
      started_at_ms: CORRECTION_AT_MS - 2,
      completed_at_ms: CORRECTION_AT_MS - 1,
      result_json: null,
      last_error_code: "ACTIVATION_FAILED",
      next_attempt_at_ms: null,
      updated_at_ms: CORRECTION_AT_MS - 1,
      version: 2,
    });
    insert(
      database,
      "free_agent_draft_recoveries",
      recoveryRecord(ids, {
        id: ids.activationRecovery,
        player_id: ids.player,
        allocation_id: ids.allocation,
        rollover_id: ids.rollover,
        auction_id: relevantAuctionId,
        job_run_id: ids.activationJob,
        kind: recoveryKind,
        status: "running",
        earliest_activation_at_ms:
          recoveryKind === "auction_resolution"
            ? null
            : CORRECTION_AT_MS - 1_000,
        target_resolution_at_ms:
          recoveryKind === "auction_resolution"
            ? ROLLOVER_AT_MS
            : null,
        last_error_code: "ACTIVATION_FAILED",
        created_by_operation_id: ids.activationJob,
        created_at_ms: CORRECTION_AT_MS - 2,
        updated_at_ms: CORRECTION_AT_MS - 1,
        version: 2,
      })
    );
  }
  return Object.freeze({
    auctionId: relevantAuctionId,
    drawId: relevantDrawId,
    fallback,
  });
}

function correctedRecoveredResolutionRecord(
  ids,
  auctionId,
  actorUserId = ids.user,
  resolvedAtMs = CORRECTION_AT_MS
) {
  return {
    id: ids.resolution,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: auctionId,
    scheduled_occurrence_key:
      `auction:${auctionId}:${ROLLOVER_AT_MS}`,
    outcome_code: "recovered",
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
    trigger_type: "commissioner",
    triggered_by_user_id: actorUserId,
    idempotency_key: `correction:${auctionId}`,
    status: "cancelled",
    resolved_at_ms: resolvedAtMs,
  };
}

function applyCorrectableFadAuction(
  database,
  ids,
  fixture,
  {
    afterStatus = "no_valid_offer",
    actorUserId = ids.user,
    actorMembershipId = ids.membership,
    actorAuthority = "commissioner",
    recoveryId = null,
    eventMetadata = null,
    resolutionOverrides = {},
    drawOverrides = {},
    leaveAuctionLive = false,
    leaveRecoveryUnresolved = false,
    correctionBeforeVersion = null,
    correctionAfterStatus = null,
  } = {}
) {
  const automatic = afterStatus === "automatic_award";
  const before = database.prepare(`
    SELECT status, version
    FROM free_agent_draft_player_allocations
    WHERE id = ?
  `).get(ids.allocation);
  const auctionBefore = database.prepare(`
    SELECT status, version
    FROM auctions
    WHERE id = ?
  `).get(fixture.auctionId);
  const appliedDeltas = [
    {
      resourceType: "allocation",
      resourceId: ids.allocation,
      action: "update",
      beforeVersion: before.version,
      afterSummary: { status: afterStatus },
    },
    {
      resourceType: "auction",
      resourceId: fixture.auctionId,
      action: "cancel",
      beforeVersion: auctionBefore.version,
      afterSummary: {
        status: "cancelled",
        auctionId: fixture.auctionId,
      },
    },
    {
      resourceType: "activity",
      resourceId: ids.activity,
      action: "append",
      beforeVersion: null,
      afterSummary: { status: "appended" },
    },
  ];
  const evidence = correctionReceiptEvidence(ids, {
    acceptedVersion: before.version,
    resultingVersion: before.version + 1,
    appliedDeltas,
  });
  insert(
    database,
    "idempotency_requests",
    idempotencyRecord(ids, {
      actorUserId,
      operation: "free_agent_draft.allocation.correction",
      requestHash: evidence.requestHash,
      createdAtMs: CORRECTION_AT_MS,
    })
  );
  insert(
    database,
    "commissioner_corrections",
    correctionRecord(ids, {
      actorUserId,
      beforeStatus: before.status,
      beforeVersion:
        correctionBeforeVersion ?? before.version,
      afterStatus: correctionAfterStatus ?? afterStatus,
      afterVersion: before.version + 1,
    })
  );
  if (auctionBefore.status !== "resolving") {
    database.prepare(`
      UPDATE auctions
      SET status = 'resolving',
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
    `).run(CORRECTION_AT_MS, fixture.auctionId);
  }
  insert(database, "auction_events", {
    id: ids.cancellationEvent,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: fixture.auctionId,
    bid_id: null,
    team_id: null,
    actor_user_id: actorUserId,
    event_type: "auction_cancelled",
    metadata_json: JSON.stringify(
      eventMetadata || {
        actorAuthority,
        correctionId: ids.correction,
      }
    ),
    occurred_at_ms: CORRECTION_AT_MS,
  });
  insert(database, "auction_resolutions", {
    ...correctedRecoveredResolutionRecord(
      ids,
      fixture.auctionId,
      actorUserId
    ),
    ...resolutionOverrides,
  });
  database.prepare(`
    UPDATE free_agent_draft_draws
    SET ordered_tied_bid_ids_json = '[]',
        ordered_tied_team_ids_json = '[]',
        rejection_counter = NULL,
        selected_index = NULL,
        selected_bid_id = NULL,
        selected_team_id = NULL,
        selected_digest_hex = NULL,
        revealed_at_ms = ?,
        updated_at_ms = ?,
        version = 2
    WHERE id = ? AND version = 1
  `).run(
    drawOverrides.revealedAtMs ?? CORRECTION_AT_MS,
    drawOverrides.updatedAtMs ?? CORRECTION_AT_MS,
    fixture.drawId
  );
  if (!leaveAuctionLive) {
    database.prepare(`
      UPDATE auctions
      SET status = 'cancelled',
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ? AND status = 'resolving'
    `).run(CORRECTION_AT_MS, fixture.auctionId);
  }
  database.prepare(`
    UPDATE free_agent_draft_player_allocations
    SET status = ?,
        decision_code = 'corrected',
        winning_snapshot_entry_id = ?,
        winning_team_id = ?,
        contract_id = ?,
        ownership_id = ?,
        accounted_at_ms = ?,
        last_error_code = NULL,
        updated_at_ms = ?,
        version = version + 1
    WHERE id = ? AND version = ?
  `).run(
    afterStatus,
    automatic ? ids.snapshotEntry : null,
    automatic ? ids.team : null,
    automatic ? ids.contract : null,
    automatic ? ids.ownership : null,
    CORRECTION_AT_MS,
    CORRECTION_AT_MS,
    ids.allocation,
    before.version
  );
  insert(
    database,
    "free_agent_draft_allocation_events",
    correctionEventRecord(ids, {
      actorUserId,
      actorMembershipId,
      actorAuthority,
      allocationVersion: before.version + 1,
      resultingStatus: afterStatus,
      contractId: automatic ? ids.contract : null,
      ownershipId: automatic ? ids.ownership : null,
      auctionId: ids.auction,
    })
  );
  if (recoveryId !== null && !leaveRecoveryUnresolved) {
    database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = ?,
          resolved_by_membership_id = ?,
          resolved_authority = ?,
          resolved_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ? AND status = 'running'
    `).run(
      actorUserId,
      actorMembershipId,
      actorAuthority,
      CORRECTION_AT_MS,
      CORRECTION_AT_MS,
      recoveryId
    );
  }
  insert(
    database,
    "league_activity",
    activityRecord(ids, {
      actorUserId,
      actorAuthority,
    })
  );
  insert(
    database,
    "free_agent_draft_allocation_correction_command_results",
    correctionCommandResult(ids, evidence, {
      actorUserId,
      actorMembershipId,
      actorAuthority,
      acceptedVersion: before.version,
      resultingVersion: before.version + 1,
    })
  );
  database.prepare(`
    UPDATE idempotency_requests
    SET status = 'completed',
        result_type =
          'free_agent_draft_allocation_correction_command_result',
        result_id = ?,
        completed_at_ms = ?
    WHERE id = ?
  `).run(
    ids.commandResult,
    CORRECTION_AT_MS,
    ids.idempotency
  );
}

function fallbackWindowIds(base) {
  return Object.freeze({
    resolutionJob: uuid(base + 100),
    sourceRolloverJob: uuid(base + 101),
    predecessorRolloverJob: uuid(base + 102),
    restrictedAuction: uuid(base + 103),
    restrictedDraw: uuid(base + 104),
    allocation: uuid(base + 105),
    recovery: uuid(base + 106),
    extension: uuid(base + 107),
    duplicateExtension: uuid(base + 108),
    rollovers: Object.freeze(
      Array.from({ length: 11 }, (_, index) =>
        index === 0 ? null : uuid(base + 110 + index)
      )
    ),
    retryIdempotency: uuid(base + 121),
    retryReceipt: uuid(base + 122),
    laterRetryIdempotency: uuid(base + 123),
    laterRetryReceipt: uuid(base + 124),
  });
}

function rolloverState({
  status,
  jobRunId,
  boundaryAtMs,
  updatedAtMs,
}) {
  if (status === "scheduled") {
    return {
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      updated_at_ms: updatedAtMs,
      version: 1,
    };
  }
  if (status === "processing") {
    return {
      processing_job_run_id: jobRunId,
      processing_started_at_ms: boundaryAtMs,
      completed_at_ms: null,
      last_error_code: null,
      updated_at_ms: boundaryAtMs,
      version: 2,
    };
  }
  if (status === "recovery_required") {
    return {
      processing_job_run_id: jobRunId,
      processing_started_at_ms: boundaryAtMs,
      completed_at_ms: boundaryAtMs + 1,
      last_error_code: "AUCTION_RESOLUTION_RECOVERY_REQUIRED",
      updated_at_ms: boundaryAtMs + 1,
      version: 3,
    };
  }
  throw new TypeError("unsupported focused rollover status");
}

function installFinalHourFallbackEvidence(
  database,
  ids,
  base,
  {
    sourceRolloverStatus = "processing",
    predecessorStatus = "scheduled",
    auctionStatus = "resolving",
    allocationStatus = "restricted_active",
    resolutionJobStatus = "running",
    includeRecovery = sourceRolloverStatus === "recovery_required",
  } = {}
) {
  const evidence = fallbackWindowIds(base);
  const sourceRolloverAtMs =
    DEADLINE_AT_MS + 6 * DAY_MS;
  const predecessorRolloverAtMs =
    DEADLINE_AT_MS + 7 * DAY_MS;
  const extensionRolloverAtMs =
    DEADLINE_AT_MS + 8 * DAY_MS;
  const finalHourAtMs =
    predecessorRolloverAtMs - 30 * 60 * 1_000;

  insert(
    database,
    "job_runs",
    jobRecord(ids, {
      id: evidence.sourceRolloverJob,
      occurrenceKey:
        `fad:${ids.fad}:rollover:6:${sourceRolloverAtMs}`,
      jobType: "fad_rollover",
      status: "running",
      scheduledForMs: sourceRolloverAtMs,
      updatedAtMs: sourceRolloverAtMs,
      leaseExpiresAtMs: finalHourAtMs + 60 * 60 * 1_000,
    })
  );
  insert(
    database,
    "job_runs",
    jobRecord(ids, {
      id: evidence.predecessorRolloverJob,
      occurrenceKey:
        `fad:${ids.fad}:rollover:7:${predecessorRolloverAtMs}`,
      jobType: "fad_rollover",
      status: "running",
      scheduledForMs: predecessorRolloverAtMs,
      updatedAtMs: sourceRolloverAtMs,
      leaseExpiresAtMs: finalHourAtMs + 60 * 60 * 1_000,
    })
  );
  insert(
    database,
    "job_runs",
    jobRecord(ids, {
      id: evidence.resolutionJob,
      occurrenceKey:
        `auction:${evidence.restrictedAuction}:${sourceRolloverAtMs}`,
      jobType: "auction.resolve.target",
      status: resolutionJobStatus,
      scheduledForMs: sourceRolloverAtMs,
      updatedAtMs: finalHourAtMs - 1,
      leaseExpiresAtMs: finalHourAtMs + 60 * 60 * 1_000,
    })
  );

  let predecessorId = ids.rollover;
  for (let sequence = 2; sequence <= 7; sequence += 1) {
    const rolloverId = evidence.rollovers[sequence];
    const opensAtMs =
      DEADLINE_AT_MS + (sequence - 1) * DAY_MS;
    const rollsOverAtMs =
      DEADLINE_AT_MS + sequence * DAY_MS;
    const status =
      sequence === 6
        ? sourceRolloverStatus
        : sequence === 7
          ? predecessorStatus
          : "scheduled";
    const state = rolloverState({
      status,
      jobRunId:
        sequence === 7
          ? evidence.predecessorRolloverJob
          : evidence.sourceRolloverJob,
      boundaryAtMs: rollsOverAtMs,
      updatedAtMs: OPENED_AT_MS,
    });
    insert(database, "free_agent_draft_rollovers", {
      id: rolloverId,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      sequence,
      window_kind: "initial",
      predecessor_rollover_id: predecessorId,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: opensAtMs,
      creation_cutoff_at_ms:
        rollsOverAtMs - 3_600_000,
      rolls_over_at_ms: rollsOverAtMs,
      status,
      ...state,
      created_at_ms: OPENED_AT_MS,
    });
    predecessorId = rolloverId;
  }

  insert(database, "auctions", {
    id: evidence.restrictedAuction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status: auctionStatus,
    opened_at_ms: sourceRolloverAtMs - DAY_MS,
    resolves_at_ms: sourceRolloverAtMs,
    opened_by_user_id: null,
    created_at_ms: sourceRolloverAtMs - DAY_MS,
    updated_at_ms: finalHourAtMs - 1,
    version: auctionStatus === "open" ? 1 : 2,
  });
  insert(database, "free_agent_draft_player_allocations", {
    id: evidence.allocation,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    status: allocationStatus,
    decision_code: "exact_total_and_term_tie",
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: evidence.restrictedAuction,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: 600,
    restricted_minimum_term_years: 2,
    restricted_minimum_aav_cents: 300,
    accounted_at_ms: null,
    last_error_code: null,
    created_at_ms: DEADLINE_AT_MS,
    updated_at_ms: sourceRolloverAtMs - DAY_MS,
    version: 2,
  });
  insert(database, "auction_contexts", {
    id: evidence.restrictedAuction,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: evidence.restrictedAuction,
    source_kind: "fad_restricted",
    fad_id: ids.fad,
    fad_rollover_id: evidence.rollovers[6],
    fad_allocation_id: evidence.allocation,
    fad_origin: "candidate_tie_restricted",
    created_at_ms: sourceRolloverAtMs - DAY_MS,
  });
  insert(
    database,
    "free_agent_draft_draws",
    drawRecord(ids, {
      id: evidence.restrictedDraw,
      allocation_id: evidence.allocation,
      auction_id: evidence.restrictedAuction,
      nonce_bytes: Buffer.alloc(32, base % 255 || 1),
      commitment_hex: crypto
        .createHash("sha256")
        .update(`fallback-window:${base}`)
        .digest("hex"),
      created_at_ms: sourceRolloverAtMs - DAY_MS,
      updated_at_ms: sourceRolloverAtMs - DAY_MS,
    })
  );
  if (includeRecovery) {
    insert(
      database,
      "free_agent_draft_recoveries",
      recoveryRecord(ids, {
        id: evidence.recovery,
        player_id: ids.player,
        allocation_id: evidence.allocation,
        rollover_id: evidence.rollovers[6],
        auction_id: evidence.restrictedAuction,
        job_run_id: evidence.resolutionJob,
        kind: "auction_resolution",
        status: "running",
        target_resolution_at_ms: sourceRolloverAtMs,
        created_by_operation_id: evidence.resolutionJob,
        created_at_ms: sourceRolloverAtMs + 1,
        updated_at_ms: finalHourAtMs - 1,
      })
    );
  }

  return Object.freeze({
    ...evidence,
    sourceRolloverAtMs,
    predecessorRolloverAtMs,
    extensionRolloverAtMs,
    finalHourAtMs,
    sourceRolloverId: evidence.rollovers[6],
    predecessorRolloverId: evidence.rollovers[7],
    extensionSequence: 8,
  });
}

function fallbackExtensionRecord(ids, evidence, overrides = {}) {
  return {
    id: evidence.extension,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    sequence: evidence.extensionSequence,
    window_kind: "extension",
    predecessor_rollover_id: evidence.predecessorRolloverId,
    extension_reason: "fallback_auction",
    extension_source_id: evidence.allocation,
    opens_at_ms: evidence.predecessorRolloverAtMs,
    creation_cutoff_at_ms:
      evidence.extensionRolloverAtMs - 3_600_000,
    rolls_over_at_ms: evidence.extensionRolloverAtMs,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: evidence.finalHourAtMs,
    updated_at_ms: evidence.finalHourAtMs,
    version: 1,
    ...overrides,
  };
}

function installDelayedFinalHourFallbackEvidence(
  database,
  ids,
  base
) {
  const immediate = installFinalHourFallbackEvidence(
    database,
    ids,
    base,
    { sourceRolloverStatus: "recovery_required" }
  );
  const evidence = fallbackWindowIds(base);
  let predecessorId = immediate.predecessorRolloverId;
  for (let sequence = 8; sequence <= 9; sequence += 1) {
    const opensAtMs =
      DEADLINE_AT_MS + (sequence - 1) * DAY_MS;
    const rollsOverAtMs =
      DEADLINE_AT_MS + sequence * DAY_MS;
    insert(database, "free_agent_draft_rollovers", {
      id: evidence.rollovers[sequence],
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      sequence,
      window_kind: "extension",
      predecessor_rollover_id: predecessorId,
      extension_reason:
        sequence === 8 ? "recovery" : "restricted_auction",
      extension_source_id:
        sequence === 8 ? evidence.recovery : evidence.allocation,
      opens_at_ms: opensAtMs,
      creation_cutoff_at_ms: rollsOverAtMs - 3_600_000,
      rolls_over_at_ms: rollsOverAtMs,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: opensAtMs - 1,
      updated_at_ms: opensAtMs - 1,
      version: 1,
    });
    predecessorId = evidence.rollovers[sequence];
  }

  const delayedFinalHourAtMs =
    DEADLINE_AT_MS + 9 * DAY_MS - 30 * 60 * 1_000;
  database.prepare(`
    UPDATE job_runs
    SET attempt_count = 2,
        lease_expires_at_ms = ?,
        started_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE id = ?
  `).run(
    delayedFinalHourAtMs + 60 * 60 * 1_000,
    delayedFinalHourAtMs - 2,
    delayedFinalHourAtMs - 1,
    evidence.resolutionJob
  );
  database.prepare(`
    UPDATE free_agent_draft_recoveries
    SET last_error_code = 'AUCTION_RESOLUTION_FAILED',
        updated_at_ms = ?,
        version = version + 1
    WHERE id = ?
  `).run(delayedFinalHourAtMs - 1, evidence.recovery);
  const recovery = database.prepare(`
    SELECT created_at_ms AS createdAtMs
    FROM free_agent_draft_recoveries
    WHERE id = ?
  `).get(evidence.recovery);
  insert(database, "auction_events", {
    id: uuid(base + 125),
    league_id: ids.league,
    season_id: ids.season,
    auction_id: evidence.restrictedAuction,
    bid_id: null,
    team_id: null,
    actor_user_id: null,
    event_type: "fad_auction_resolution_failed",
    metadata_json: JSON.stringify({
      errorCode: "AUCTION_RESOLUTION_FAILED",
      jobRunId: evidence.resolutionJob,
      recoveryId: evidence.recovery,
    }),
    occurred_at_ms: recovery.createdAtMs,
  });

  const acceptedAtMs = recovery.createdAtMs + 1;
  const occurrenceKey =
    `auction:${evidence.restrictedAuction}:${immediate.sourceRolloverAtMs}`;
  const requestJson = JSON.stringify({
    body: {
      action: "retry_auction_resolution",
      reason: "Retry the delayed restricted resolution.",
      resourceId: evidence.restrictedAuction,
    },
    domain:
      "hundo-leago.free-agent-draft-recovery-action-request",
    fadId: ids.fad,
    leagueId: ids.league,
    schemaVersion: 1,
  });
  const responseJson = JSON.stringify({
    acceptedAtMs,
    action: "retry_auction_resolution",
    occurrenceKey,
    operationId: evidence.resolutionJob,
    pollDescriptor: {
      fadId: ids.fad,
      kind: "fad_recovery",
      leagueId: ids.league,
    },
    resourceId: evidence.restrictedAuction,
    status: "pending",
  });
  insert(database, "idempotency_requests", {
    id: evidence.retryIdempotency,
    league_id: ids.league,
    actor_user_id: ids.user,
    operation: "free_agent_draft.recovery.action",
    client_key: `retry:${evidence.recovery}`,
    request_hash: sha256(requestJson),
    status: "completed",
    result_type:
      "free_agent_draft_recovery_action_command_result",
    result_id: evidence.retryReceipt,
    created_at_ms: acceptedAtMs,
    completed_at_ms: acceptedAtMs,
    expires_at_ms: acceptedAtMs + DAY_MS,
  });
  insert(
    database,
    "free_agent_draft_recovery_action_command_results",
    {
      id: evidence.retryReceipt,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      recovery_id: evidence.recovery,
      idempotency_request_id: evidence.retryIdempotency,
      action: "retry_auction_resolution",
      resource_kind: "auction",
      resource_id: evidence.restrictedAuction,
      operation_id: evidence.resolutionJob,
      job_run_id: evidence.resolutionJob,
      occurrence_key: occurrenceKey,
      actor_user_id: ids.user,
      actor_membership_id: ids.membership,
      actor_authority: "commissioner",
      commissioner_reason:
        "Retry the delayed restricted resolution.",
      request_json: requestJson,
      request_sha256: sha256(requestJson),
      accepted_status: "pending",
      accepted_at_ms: acceptedAtMs,
      response_http_status: 202,
      response_json: responseJson,
      response_sha256: sha256(responseJson),
      version: 1,
    }
  );

  return Object.freeze({
    ...immediate,
    predecessorRolloverAtMs:
      DEADLINE_AT_MS + 9 * DAY_MS,
    extensionRolloverAtMs:
      DEADLINE_AT_MS + 10 * DAY_MS,
    finalHourAtMs: delayedFinalHourAtMs,
    predecessorRolloverId: evidence.rollovers[9],
    extensionSequence: 10,
    retryIdempotency: evidence.retryIdempotency,
    retryReceipt: evidence.retryReceipt,
  });
}

function auctionEventRecord(
  ids,
  {
    id,
    eventType,
    actorUserId,
    metadata,
    occurredAtMs,
  }
) {
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    bid_id: null,
    team_id: null,
    actor_user_id: actorUserId,
    event_type: eventType,
    metadata_json: JSON.stringify(metadata),
    occurred_at_ms: occurredAtMs,
  };
}

function recoveredResolutionRecord(ids) {
  return {
    id: ids.resolution,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    scheduled_occurrence_key:
      `auction:${ids.auction}:${AUCTION_RESOLVES_AT_MS}`,
    outcome_code: "recovered",
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
    trigger_type: "commissioner",
    triggered_by_user_id: ids.user,
    idempotency_key: `recover:${ids.auction}`,
    status: "cancelled",
    resolved_at_ms: AUCTION_CANCELLED_AT_MS,
  };
}

function schemaObjects(database) {
  return database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql, rootpage
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}

describe("FAD recovery and correction evidence migration", () => {
  test("upgrades exact schema 38 in place and normalizes legacy recovery causality", (t) => {
    const runtime = createRuntime(t, "fad39-upgrade-");
    copyMigrations(runtime, 1, 38);
    migrate(runtime, "fad39-before");
    const triggers = captureAndDropTriggers(runtime.database);
    const ids = insertCore(runtime.database, 390_000);
    installCandidateEvidence(runtime.database, ids);
    const fallbackEvidence =
      installFinalHourFallbackEvidence(
        runtime.database,
        ids,
        390_000
      );
    insert(
      runtime.database,
      "free_agent_draft_allocation_events",
      allocationOfferEventRecord(ids, {
        rankPosition: 7,
        allocationId: fallbackEvidence.allocation,
        allocationVersion: 2,
        resultingAllocationStatus: "restricted_active",
        decisionCode: "exact_total_and_term_tie",
      })
    );
    insert(runtime.database, "job_runs", jobRecord(ids));
    insert(
      runtime.database,
      "job_runs",
      jobRecord(ids, {
        id: ids.otherJob,
        occurrenceKey: `fad:${ids.fad}:allocation-pass`,
      })
    );
    insert(
      runtime.database,
      "free_agent_draft_nomination_queue",
      queueRecord(ids)
    );
    insert(
      runtime.database,
      "free_agent_draft_recoveries",
      recoveryRecord(ids, {
        player_id: ids.player,
        rollover_id: ids.rollover,
        kind: "queued_nomination_activation",
        created_by_operation_id: ids.queue,
      })
    );
    insert(
      runtime.database,
      "free_agent_draft_recoveries",
      recoveryRecord(ids, {
        id: ids.otherRecovery,
        job_run_id: ids.otherJob,
        created_by_operation_id:
          `fad:${ids.fad}:allocation-pass`,
      })
    );
    insert(
      runtime.database,
      "free_agent_draft_recoveries",
      recoveryRecord(ids, {
        id: ids.trueOperationRecovery,
        job_run_id: null,
        created_by_operation_id: ids.trueOperation,
      })
    );
    restoreTriggers(runtime.database, triggers);

    const beforeLedger = runtime.database.prepare(`
      SELECT migration_id, file_name, checksum,
             application_build_id, started_at_ms,
             applied_at_ms, duration_ms
      FROM schema_migrations
      ORDER BY migration_id
    `).all();
    const beforeObjects = schemaObjects(runtime.database);
    const recoveryRootpage = beforeObjects.find(
      (object) =>
        object.type === "table" &&
        object.name === "free_agent_draft_recoveries"
    ).rootpage;

    copyMigrations(runtime, 39, 39);
    const result = migrate(runtime, "fad39-upgrade");

    assert.equal(result.status, "exact");
    assert.equal(
      runtime.database.pragma("user_version", {
        simple: true,
      }),
      39
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT migration_id, file_name, checksum,
               application_build_id, started_at_ms,
               applied_at_ms, duration_ms
        FROM schema_migrations
        WHERE migration_id <= 38
        ORDER BY migration_id
      `).all(),
      beforeLedger
    );
    const rows = runtime.database.prepare(`
      SELECT id, job_run_id, nomination_queue_id,
             created_by_operation_id
      FROM free_agent_draft_recoveries
      WHERE league_id = ?
      ORDER BY id
    `).all(ids.league);
    assert.deepEqual(rows, [
      {
        id: ids.recovery,
        job_run_id: ids.job,
        nomination_queue_id: ids.queue,
        created_by_operation_id: ids.job,
      },
      {
        id: ids.otherRecovery,
        job_run_id: ids.otherJob,
        nomination_queue_id: null,
        created_by_operation_id: ids.otherJob,
      },
      {
        id: ids.trueOperationRecovery,
        job_run_id: null,
        nomination_queue_id: null,
        created_by_operation_id: ids.trueOperation,
      },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT acceptance_idempotency_request_id AS acceptanceRequestId
        FROM free_agent_draft_nomination_queue
        WHERE league_id = ?
          AND id = ?
      `).get(ids.league, ids.queue),
      { acceptanceRequestId: null }
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT offer_valid AS offerValid,
               rank_position AS rankPosition,
               offer_outcome_code AS offerOutcomeCode
        FROM free_agent_draft_allocation_events
        WHERE league_id = ?
          AND id = ?
      `).get(ids.league, ids.offerEvent),
      {
        offerValid: 0,
        rankPosition: null,
        offerOutcomeCode: "excluded_over_cap",
      }
    );

    const afterObjects = schemaObjects(runtime.database);
    assert.equal(
      afterObjects.find(
        (object) =>
          object.type === "table" &&
          object.name === "free_agent_draft_recoveries"
      ).rootpage,
      recoveryRootpage
    );
    assert.equal(
      afterObjects.filter((object) => object.type === "table").length,
      beforeObjects.filter((object) => object.type === "table").length + 2
    );
    const intentionallyChanged = new Set([
      "table:free_agent_draft_nomination_queue",
      "table:free_agent_draft_recoveries",
      "trigger:auction_bids_require_context_insert",
      "trigger:auctions_require_context_update",
      "trigger:fad_auction_resolutions_context_insert",
      "trigger:free_agent_draft_allocation_events_valid_insert",
      "trigger:free_agent_draft_allocations_forward_update",
      "trigger:free_agent_draft_nomination_queue_forward_update",
      "trigger:free_agent_draft_nomination_queue_valid_insert",
      "trigger:free_agent_draft_recoveries_forward_update",
      "trigger:free_agent_draft_recoveries_valid_insert",
      "trigger:free_agent_draft_rollovers_valid_insert",
    ]);
    const afterByIdentity = new Map(
      afterObjects.map((object) => [
        `${object.type}:${object.name}`,
        object,
      ])
    );
    for (const object of beforeObjects) {
      const identity = `${object.type}:${object.name}`;
      assert.ok(afterByIdentity.has(identity), identity);
      if (!intentionallyChanged.has(identity)) {
        assert.equal(
          afterByIdentity.get(identity).sql,
          object.sql,
          identity
        );
      }
    }
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE name = 'migration_0039_recovery_causality_guard'
      `).get().count,
      0
    );
    assert.throws(
      () => transaction(runtime.database, () => {
        insert(
          runtime.database,
          "free_agent_draft_rollovers",
          fallbackExtensionRecord(ids, fallbackEvidence)
        );
        throw new Error("ROLL_BACK_FALLBACK_EXTENSION");
      }),
      /ROLL_BACK_FALLBACK_EXTENSION/
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_rollovers
        WHERE league_id = ?
          AND id = ?
      `).get(ids.league, fallbackEvidence.extension).count,
      0
    );
    insert(
      runtime.database,
      "free_agent_draft_rollovers",
      fallbackExtensionRecord(ids, fallbackEvidence)
    );
    assertConstraint(
      () => insert(
        runtime.database,
        "free_agent_draft_rollovers",
        fallbackExtensionRecord(ids, fallbackEvidence, {
          id: fallbackEvidence.duplicateExtension,
        })
      ),
      /unique|FAD/i
    );
    assertHealthy(runtime.database);
  });

  test("installs fresh schema 1 through 39 with exact inventory and health", (t) => {
    const runtime = createRuntime(t, "fad39-fresh-");
    copyMigrations(runtime, 1, 39);
    const result = migrate(runtime, "fad39-fresh");

    assert.equal(result.status, "exact");
    assert.equal(
      runtime.database.pragma("user_version", {
        simple: true,
      }),
      39
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM schema_migrations
      `).get().count,
      39
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT type, COUNT(*) AS count
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        GROUP BY type
        ORDER BY type
      `).all(),
      [
        { type: "index", count: 189 },
        { type: "table", count: 132 },
        { type: "trigger", count: 281 },
        { type: "view", count: 1 },
      ]
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND sql LIKE '%BEFORE DELETE ON%'
      `).get().count,
      75
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table'
          AND name IN (
            'free_agent_draft_recovery_action_command_results',
            'free_agent_draft_allocation_correction_command_results'
          )
        ORDER BY name
      `).all(),
      [
        {
          name: "free_agent_draft_allocation_correction_command_results",
        },
        {
          name: "free_agent_draft_recovery_action_command_results",
        },
      ]
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM pragma_table_info('free_agent_draft_recoveries')
        WHERE name = 'nomination_queue_id'
      `).get().count,
      1
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM pragma_table_info('free_agent_draft_nomination_queue')
        WHERE name = 'acceptance_idempotency_request_id'
      `).get().count,
      1
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM pragma_table_info('free_agent_draft_nomination_queue')
      `).get().count,
      29
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE name IN (
          'free_agent_draft_nomination_queue_acceptance_request',
          'free_agent_draft_nomination_queue_complete_acceptance_request',
          'idempotency_requests_fad_nomination_queue_complete',
          'idempotency_requests_fad_nomination_queue_delete'
        )
        ORDER BY name
      `).all(),
      [
        {
          name:
            "free_agent_draft_nomination_queue_acceptance_request",
        },
        {
          name:
            "free_agent_draft_nomination_queue_complete_acceptance_request",
        },
        {
          name:
            "idempotency_requests_fad_nomination_queue_complete",
        },
        {
          name:
            "idempotency_requests_fad_nomination_queue_delete",
        },
      ]
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT metadata_value
        FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).get().metadata_value,
      "39"
    );
    assertHealthy(runtime.database);
  });

  test("normalizes excluded offer ranks and enforces the exact offer validity rank contract", (t) => {
    const { runtime, ids } = createFreshFixture(
      t,
      "fad39-offer-rank-",
      399_000,
      (database, fixtureIds) => {
        installCandidateEvidence(database, fixtureIds);
        insert(
          database,
          "free_agent_draft_player_allocations",
          allocationRecord(fixtureIds)
        );
      }
    );

    for (const variant of [
      {
        label: "invalid offer with a rank",
        record: allocationOfferEventRecord(ids, {
          offerValid: 0,
          rankPosition: 1,
          offerOutcomeCode: "excluded_over_cap",
        }),
      },
      {
        label: "valid offer without a rank",
        record: allocationOfferEventRecord(ids, {
          offerValid: 1,
          rankPosition: null,
          offerOutcomeCode: "winner",
        }),
      },
    ]) {
      assertConstraint(
        () => insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          variant.record
        ),
        /allocation event/i
      );
      assert.equal(
        runtime.database.prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_allocation_events
          WHERE league_id = ?
            AND id = ?
        `).get(ids.league, ids.offerEvent).count,
        0,
        variant.label
      );
    }

    insert(
      runtime.database,
      "free_agent_draft_allocation_events",
      allocationOfferEventRecord(ids)
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT offer_valid AS offerValid,
               rank_position AS rankPosition,
               offer_outcome_code AS offerOutcomeCode
        FROM free_agent_draft_allocation_events
        WHERE league_id = ?
          AND id = ?
      `).get(ids.league, ids.offerEvent),
      {
        offerValid: 0,
        rankPosition: null,
        offerOutcomeCode: "excluded_over_cap",
      }
    );
    assertHealthy(runtime.database);
  });

  test("binds each queued nomination to one immutable completed auction-start acceptance", (t) => {
    const { runtime, ids } = createFreshFixture(
      t,
      "fad39-queue-acceptance-",
      399_100,
      installQueuedNominationPrerequisites
    );

    assertConstraint(
      () => acceptQueuedNomination(
        runtime.database,
        ids,
        {
          requestActorUserId: ids.adminUser,
          requestId: ids.idempotency,
        }
      ),
      /final-hour nomination/i
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_nomination_queue
        WHERE league_id = ?
      `).get(ids.league).count,
      0
    );

    assert.throws(
      () => transaction(runtime.database, () => {
        acceptQueuedNomination(
          runtime.database,
          ids
        );
        throw new Error("ROLL_BACK_QUEUE_ACCEPTANCE");
      }),
      /ROLL_BACK_QUEUE_ACCEPTANCE/
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM idempotency_requests
        WHERE league_id = ?
          AND id = ?
      `).get(ids.league, ids.acceptanceRequest).count,
      0
    );

    acceptQueuedNomination(runtime.database, ids);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT operation, status,
               result_type AS resultType,
               result_id AS resultId,
               created_at_ms AS createdAtMs,
               completed_at_ms AS completedAtMs
        FROM idempotency_requests
        WHERE league_id = ?
          AND id = ?
      `).get(ids.league, ids.acceptanceRequest),
      {
        operation: "auction.start",
        status: "completed",
        resultType: "fad_nomination_queue",
        resultId: ids.queue,
        createdAtMs: QUEUED_ACCEPTED_AT_MS,
        completedAtMs: QUEUED_ACCEPTED_AT_MS,
      }
    );
    assertConstraint(
      () => runtime.database.prepare(`
        UPDATE idempotency_requests
        SET request_hash = ?
        WHERE league_id = ?
          AND id = ?
      `).run(
        "f".repeat(64),
        ids.league,
        ids.acceptanceRequest
      ),
      /acceptance request/i
    );
    assertConstraint(
      () => runtime.database.prepare(`
        DELETE FROM idempotency_requests
        WHERE league_id = ?
          AND id = ?
      `).run(ids.league, ids.acceptanceRequest),
      /acceptance request/i
    );
    assertHealthy(runtime.database);
  });

  test("opens a delayed queued nomination from its historical manager binding and exact activation evidence", (t) => {
    const { runtime, ids } = createQueuedOpeningFixture(
      t,
      "fad39-queue-open-",
      399_200,
      { replaceManager: true }
    );

    insert(
      runtime.database,
      "auction_bids",
      queuedStarterBidRecord(ids)
    );
    openQueuedNomination(runtime.database, ids);

    assert.deepEqual(
      runtime.database.prepare(`
        SELECT submitted_by_user_id AS submittedByUserId,
               first_submitted_at_ms AS firstSubmittedAtMs,
               last_edited_at_ms AS lastEditedAtMs,
               edit_count AS editCount,
               idempotency_request_id AS idempotencyRequestId
        FROM auction_bids
        WHERE league_id = ?
          AND id = ?
      `).get(ids.league, ids.nominationBid),
      {
        submittedByUserId: ids.user,
        firstSubmittedAtMs: QUEUED_ACCEPTED_AT_MS,
        lastEditedAtMs: QUEUED_ACCEPTED_AT_MS,
        editCount: 0,
        idempotencyRequestId: ids.acceptanceRequest,
      }
    );
    assert.equal(
      QUEUED_ACCEPTED_AT_MS + 4_500_000,
      ROLLOVER_AT_MS + 2_700_000
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status,
               resolution_rollover_id AS resolutionRolloverId,
               opened_auction_id AS openedAuctionId,
               opened_starter_bid_id AS openedStarterBidId,
               acceptance_idempotency_request_id AS acceptanceRequestId,
               opened_at_ms AS openedAtMs,
               version
        FROM free_agent_draft_nomination_queue
        WHERE league_id = ?
          AND id = ?
      `).get(ids.league, ids.queue),
      {
        status: "opened",
        resolutionRolloverId: ids.resolutionRollover,
        openedAuctionId: ids.nominationAuction,
        openedStarterBidId: ids.nominationBid,
        acceptanceRequestId: ids.acceptanceRequest,
        openedAtMs: ROLLOVER_AT_MS,
        version: 2,
      }
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT user_id AS userId, status, ended_at_ms AS endedAtMs
        FROM team_manager_assignments
        WHERE league_id = ?
          AND team_id = ?
        ORDER BY assigned_at_ms, id
      `).all(ids.league, ids.team),
      [
        {
          userId: ids.user,
          status: "ended",
          endedAtMs: ROLLOVER_AT_MS - 1,
        },
        {
          userId: ids.adminUser,
          status: "accepted",
          endedAtMs: null,
        },
      ]
    );
    assertHealthy(runtime.database);
  });

  test("rejects unrelated queued nomination opening evidence with zero starter-bid writes", (t) => {
    const variants = [
      {
        label: "unrelated queue player",
        base: 399_300,
        opening: (ids) => ({
          auctionPlayerId: ids.otherPlayer,
        }),
        bid: () => ({}),
      },
      {
        label: "unrelated request",
        base: 399_400,
        opening: () => ({
          includeUnrelatedRequest: true,
        }),
        bid: (ids) => ({
          idempotency_request_id: ids.idempotency,
        }),
      },
      {
        label: "wrong historical actor",
        base: 399_500,
        opening: () => ({}),
        bid: (ids) => ({
          submitted_by_user_id: ids.adminUser,
        }),
      },
      {
        label: "wrong binding value",
        base: 399_600,
        opening: () => ({}),
        bid: () => ({
          total_value_cents: 700,
          lowest_offered_aav_cents: 350,
        }),
      },
      {
        label: "wrong opening window",
        base: 399_700,
        opening: () => ({
          openedAtMs: ROLLOVER_AT_MS + 1,
        }),
        bid: () => ({}),
      },
      {
        label: "wrong activation occurrence",
        base: 399_800,
        opening: (ids) => ({
          activationOccurrenceKey:
            `fad:${ids.fad}:nomination-open:${ids.queue}:${ROLLOVER_AT_MS + 1}`,
        }),
        bid: () => ({}),
      },
    ];

    for (const variant of variants) {
      const fixture = createQueuedOpeningFixture(
        t,
        `fad39-queue-negative-${variant.base}-`,
        variant.base,
        variant.opening(fixtureIds(variant.base))
      );
      assertConstraint(
        () => insert(
          fixture.runtime.database,
          "auction_bids",
          queuedStarterBidRecord(
            fixture.ids,
            variant.bid(fixture.ids)
          )
        ),
        /FAD opening bid/i
      );
      assert.equal(
        fixture.runtime.database.prepare(`
          SELECT COUNT(*) AS count
          FROM auction_bids
          WHERE league_id = ?
            AND id = ?
        `).get(
          fixture.ids.league,
          fixture.ids.nominationBid
        ).count,
        0,
        variant.label
      );
      assertHealthy(fixture.runtime.database);
    }
  });

  test("preserves interactive open-rapid and restricted FAD bid admission exactly", (t) => {
    for (const [index, sourceKind] of [
      "fad_open_rapid",
      "fad_restricted",
    ].entries()) {
      let evidence;
      const { runtime, ids } = createFreshFixture(
        t,
        `fad39-interactive-${sourceKind}-`,
        399_900 + index * 100,
        (database, fixtureIds) => {
          evidence = installInteractiveFadBidEvidence(
            database,
            fixtureIds,
            sourceKind
          );
        }
      );
      insert(
        runtime.database,
        "idempotency_requests",
        idempotencyRecord(ids, {
          id: ids.auctionIdempotency,
          actorUserId: ids.user,
          operation: "auction.bid.put",
          requestHash: sha256(
            `${sourceKind}:${ids.auction}`
          ),
          createdAtMs: evidence.openedAtMs,
          clientKey: `interactive:${sourceKind}`,
        })
      );
      insert(runtime.database, "auction_bids", {
        id: ids.bid,
        league_id: ids.league,
        season_id: ids.season,
        auction_id: evidence.auctionId,
        team_id: ids.team,
        submitted_by_user_id: ids.user,
        total_value_cents: evidence.totalValueCents,
        term_years: evidence.termYears,
        lowest_offered_aav_cents: evidence.aavCents,
        first_submitted_at_ms: evidence.openedAtMs,
        last_edited_at_ms: evidence.openedAtMs,
        edit_count: 0,
        status: "active",
        idempotency_request_id: ids.auctionIdempotency,
        version: 1,
      });
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT auction_id AS auctionId,
                 total_value_cents AS totalValueCents,
                 status, version
          FROM auction_bids
          WHERE league_id = ?
            AND id = ?
        `).get(ids.league, ids.bid),
        {
          auctionId: evidence.auctionId,
          totalValueCents: evidence.totalValueCents,
          status: "active",
          version: 1,
        },
        sourceKind
      );
      assertHealthy(runtime.database);
    }
  });

  test("admits only the exact final-hour pre-transition fallback extension on fresh schema 39", (t) => {
    const runtime = createRuntime(t, "fad39-fallback-window-");
    copyMigrations(runtime, 1, 39);
    migrate(runtime, "fad39-fallback-window");
    const triggers = captureAndDropTriggers(runtime.database);
    const fixtures = [
      {
        name: "scheduled-source",
        base: 400_000,
        options: { sourceRolloverStatus: "scheduled" },
      },
      {
        name: "processing-source",
        base: 401_000,
        options: { sourceRolloverStatus: "processing" },
      },
      {
        name: "recovery-source",
        base: 402_000,
        options: { sourceRolloverStatus: "recovery_required" },
      },
      {
        name: "wrong-predecessor-status",
        base: 403_000,
        options: { predecessorStatus: "processing" },
      },
      {
        name: "wrong-auction",
        base: 404_000,
        options: { auctionStatus: "open" },
      },
      {
        name: "wrong-allocation",
        base: 405_000,
        options: { allocationStatus: "restricted_scheduled" },
      },
      {
        name: "wrong-job",
        base: 406_000,
        options: { resolutionJobStatus: "pending" },
      },
      {
        name: "missing-recovery",
        base: 407_000,
        options: {
          sourceRolloverStatus: "recovery_required",
          includeRecovery: false,
        },
      },
    ].map((fixture) => {
      const ids = insertCore(runtime.database, fixture.base);
      return {
        ...fixture,
        ids,
        evidence: installFinalHourFallbackEvidence(
          runtime.database,
          ids,
          fixture.base,
          fixture.options
        ),
      };
    });
    restoreTriggers(runtime.database, triggers);

    const processing = fixtures.find(
      (fixture) => fixture.name === "processing-source"
    );
    const foreign = fixtures.find(
      (fixture) => fixture.name === "scheduled-source"
    );
    const malformed = [
      {
        label: "reason",
        overrides: { extension_reason: "queued_nomination" },
      },
      {
        label: "source",
        overrides: { extension_source_id: uuid(999_991) },
      },
      {
        label: "FAD",
        overrides: { fad_id: foreign.ids.fad },
      },
      {
        label: "sequence",
        overrides: { sequence: 9 },
      },
      {
        label: "clocks",
        overrides: {
          creation_cutoff_at_ms:
            processing.evidence.extensionRolloverAtMs -
            3_600_000 + 1,
        },
      },
      {
        label: "predecessor",
        overrides: {
          predecessor_rollover_id:
            processing.evidence.sourceRolloverId,
        },
      },
      {
        label: "window",
        overrides: { window_kind: "initial" },
      },
      {
        label: "non-final-hour",
        overrides: {
          created_at_ms:
            processing.evidence.predecessorRolloverAtMs -
            3_600_000 - 1,
          updated_at_ms:
            processing.evidence.predecessorRolloverAtMs -
            3_600_000 - 1,
        },
      },
    ];
    for (const { label, overrides } of malformed) {
      assert.throws(
        () => insert(
          runtime.database,
          "free_agent_draft_rollovers",
          fallbackExtensionRecord(
            processing.ids,
            processing.evidence,
            overrides
          )
        ),
        /constraint|FAD|foreign key/i
      );
      assert.equal(
        runtime.database.prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_rollovers
          WHERE league_id = ?
            AND sequence = 8
        `).get(processing.ids.league).count,
        0,
        label
      );
    }

    for (const name of [
      "wrong-predecessor-status",
      "wrong-auction",
      "wrong-allocation",
      "wrong-job",
      "missing-recovery",
    ]) {
      const fixture = fixtures.find(
        (candidate) => candidate.name === name
      );
      assert.throws(
        () => insert(
          runtime.database,
          "free_agent_draft_rollovers",
          fallbackExtensionRecord(
            fixture.ids,
            fixture.evidence
          )
        )
      );
    }

    for (const name of [
      "scheduled-source",
      "processing-source",
      "recovery-source",
    ]) {
      const fixture = fixtures.find(
        (candidate) => candidate.name === name
      );
      insert(
        runtime.database,
        "free_agent_draft_rollovers",
        fallbackExtensionRecord(
          fixture.ids,
          fixture.evidence
        )
      );
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT sequence, window_kind AS windowKind,
                 predecessor_rollover_id AS predecessorRolloverId,
                 extension_reason AS extensionReason,
                 extension_source_id AS extensionSourceId,
                 opens_at_ms AS opensAtMs,
                 rolls_over_at_ms AS rollsOverAtMs,
                 status, version
          FROM free_agent_draft_rollovers
          WHERE league_id = ?
            AND id = ?
        `).get(
          fixture.ids.league,
          fixture.evidence.extension
        ),
        {
          sequence: 8,
          windowKind: "extension",
          predecessorRolloverId:
            fixture.evidence.predecessorRolloverId,
          extensionReason: "fallback_auction",
          extensionSourceId: fixture.evidence.allocation,
          opensAtMs:
            fixture.evidence.predecessorRolloverAtMs,
          rollsOverAtMs:
            fixture.evidence.extensionRolloverAtMs,
          status: "scheduled",
          version: 1,
        }
      );
    }
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM schema_migrations
        WHERE migration_id = 39
      `).get().count,
      1
    );
    assertHealthy(runtime.database);
  });

  test("admits delayed multi-boundary fallback only with the exact failed and requeued resolution evidence", (t) => {
    const runtime = createRuntime(t, "fad39-delayed-fallback-");
    copyMigrations(runtime, 1, 39);
    migrate(runtime, "fad39-delayed-fallback");
    const triggers = captureAndDropTriggers(runtime.database);
    const variants = [
      "valid",
      "source-status",
      "job-attempt",
      "recovery-status",
      "error",
      "receipt-action",
      "receipt-source",
      "receipt-occurrence",
      "later-receipt",
    ].map((name, index) => {
      const base = 410_000 + index * 1_000;
      const ids = insertCore(runtime.database, base);
      const evidence = installDelayedFinalHourFallbackEvidence(
        runtime.database,
        ids,
        base
      );
      if (name === "source-status") {
        runtime.database.prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'processing',
              completed_at_ms = NULL,
              last_error_code = NULL,
              version = 2
          WHERE id = ?
        `).run(evidence.sourceRolloverId);
      } else if (name === "job-attempt") {
        runtime.database.prepare(`
          UPDATE job_runs SET attempt_count = 1 WHERE id = ?
        `).run(evidence.resolutionJob);
      } else if (name === "recovery-status") {
        runtime.database.prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'ready'
          WHERE id = ?
        `).run(evidence.recovery);
      } else if (name === "error") {
        runtime.database.prepare(`
          UPDATE free_agent_draft_recoveries
          SET last_error_code = 'DIFFERENT_FAILURE'
          WHERE id = ?
        `).run(evidence.recovery);
      } else if (name === "receipt-action") {
        runtime.database.prepare(`
          UPDATE free_agent_draft_recovery_action_command_results
          SET action = 'retry_deadline'
          WHERE id = ?
        `).run(evidence.retryReceipt);
      } else if (name === "receipt-source") {
        runtime.database.prepare(`
          UPDATE free_agent_draft_recovery_action_command_results
          SET resource_id = ?
          WHERE id = ?
        `).run(ids.auction, evidence.retryReceipt);
      } else if (name === "receipt-occurrence") {
        runtime.database.prepare(`
          UPDATE free_agent_draft_recovery_action_command_results
          SET occurrence_key = 'auction:wrong:occurrence'
          WHERE id = ?
        `).run(evidence.retryReceipt);
      } else if (name === "later-receipt") {
        const request = runtime.database.prepare(`
          SELECT * FROM idempotency_requests WHERE id = ?
        `).get(evidence.retryIdempotency);
        const receipt = runtime.database.prepare(`
          SELECT *
          FROM free_agent_draft_recovery_action_command_results
          WHERE id = ?
        `).get(evidence.retryReceipt);
        insert(runtime.database, "idempotency_requests", {
          ...request,
          id: uuid(base + 123),
          client_key: `later:${evidence.recovery}`,
          result_id: uuid(base + 124),
          created_at_ms: receipt.accepted_at_ms + 1,
          completed_at_ms: receipt.accepted_at_ms + 1,
          expires_at_ms: receipt.accepted_at_ms + DAY_MS + 1,
        });
        insert(
          runtime.database,
          "free_agent_draft_recovery_action_command_results",
          {
            ...receipt,
            id: uuid(base + 124),
            idempotency_request_id: uuid(base + 123),
            accepted_at_ms: receipt.accepted_at_ms + 1,
            occurrence_key: "auction:stale:later",
          }
        );
      }
      return { name, ids, evidence };
    });
    restoreTriggers(runtime.database, triggers);

    const valid = variants[0];
    insert(
      runtime.database,
      "free_agent_draft_rollovers",
      fallbackExtensionRecord(valid.ids, valid.evidence)
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT sequence, window_kind AS windowKind,
               predecessor_rollover_id AS predecessorRolloverId,
               extension_reason AS extensionReason,
               opens_at_ms AS opensAtMs,
               rolls_over_at_ms AS rollsOverAtMs
        FROM free_agent_draft_rollovers
        WHERE id = ?
      `).get(valid.evidence.extension),
      {
        sequence: 10,
        windowKind: "extension",
        predecessorRolloverId:
          valid.evidence.predecessorRolloverId,
        extensionReason: "fallback_auction",
        opensAtMs: valid.evidence.predecessorRolloverAtMs,
        rollsOverAtMs: valid.evidence.extensionRolloverAtMs,
      }
    );

    for (const variant of variants.slice(1)) {
      assert.throws(
        () => insert(
          runtime.database,
          "free_agent_draft_rollovers",
          fallbackExtensionRecord(
            variant.ids,
            variant.evidence
          )
        ),
        /FAD|constraint/i,
        variant.name
      );
      assert.equal(
        runtime.database.prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_rollovers
          WHERE league_id = ? AND sequence = 10
        `).get(variant.ids.league).count,
        0,
        variant.name
      );
    }
    assertHealthy(runtime.database);
  });

  test("rolls back schema 39 when legacy queued recovery causality crosses scope", (t) => {
    const runtime = createRuntime(t, "fad39-rollback-");
    copyMigrations(runtime, 1, 38);
    migrate(runtime, "fad39-rollback-before");
    const triggers = captureAndDropTriggers(runtime.database);
    const left = insertCore(runtime.database, 391_000);
    const right = insertCore(runtime.database, 392_000);
    insert(runtime.database, "job_runs", jobRecord(left));
    insert(
      runtime.database,
      "free_agent_draft_nomination_queue",
      queueRecord(right)
    );
    insert(
      runtime.database,
      "free_agent_draft_recoveries",
      recoveryRecord(left, {
        player_id: left.player,
        rollover_id: left.rollover,
        kind: "queued_nomination_activation",
        created_by_operation_id: right.queue,
      })
    );
    restoreTriggers(runtime.database, triggers);
    copyMigrations(runtime, 39, 39);

    assert.throws(
      () => migrate(runtime, "fad39-rollback"),
      (error) => {
        assert.equal(error.code, "MIGRATION_APPLY_FAILED");
        return true;
      }
    );
    assert.equal(
      runtime.database.pragma("user_version", {
        simple: true,
      }),
      38
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM schema_migrations
        WHERE migration_id = 39
      `).get().count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM pragma_table_info('free_agent_draft_recoveries')
        WHERE name = 'nomination_queue_id'
      `).get().count,
      0
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE name =
          'free_agent_draft_recovery_action_command_results'
      `).get().count,
      0
    );
    assertHealthy(runtime.database);
  });

  test("stores exact immutable T142 replay receipts and enforces resource, scope, and current authority", (t) => {
    let foreignIds;
    const { runtime, ids } = createFreshFixture(
      t,
      "fad39-recovery-receipt-",
      393_000,
      (database, fixture) => {
        insert(database, "job_runs", jobRecord(fixture));
        insert(
          database,
          "free_agent_draft_recoveries",
          recoveryRecord(fixture)
        );
        foreignIds = insertCore(database, 394_000);
      }
    );
    const reason =
      "Retry the deterministic deadline operation.";
    const requestJson = recoveryRequestJson(ids, reason);
    const validResult = recoveryCommandResult(ids, {
      requestJson,
      reason,
    });
    insert(
      runtime.database,
      "idempotency_requests",
      idempotencyRecord(ids, {
        operation: "free_agent_draft.recovery.action",
        requestHash: sha256(requestJson),
        createdAtMs: ACTION_AT_MS,
      })
    );

    const flatRequestJson = JSON.stringify({
      action: "retry_deadline",
      domain:
        "hundo-leago.free-agent-draft-recovery-action-request",
      fadId: ids.fad,
      leagueId: ids.league,
      reason,
      resourceId: null,
      schemaVersion: 1,
    });
    insert(
      runtime.database,
      "idempotency_requests",
      idempotencyRecord(ids, {
        id: ids.inactiveIdempotency,
        operation: "free_agent_draft.recovery.action",
        requestHash: sha256(flatRequestJson),
        createdAtMs: ACTION_AT_MS,
      })
    );
    assertConstraint(
      () => insert(
        runtime.database,
        "free_agent_draft_recovery_action_command_results",
        recoveryCommandResult(ids, {
          id: ids.inactiveCommandResult,
          idempotencyRequestId: ids.inactiveIdempotency,
          requestJson: flatRequestJson,
          reason,
        })
      ),
      /exact request/i
    );

    assertConstraint(
      () => insert(
        runtime.database,
        "free_agent_draft_recovery_action_command_results",
        {
          ...validResult,
          id: ids.inactiveCommandResult,
          actor_membership_id: foreignIds.membership,
        }
      ),
      /constraint|exact request/i
    );

    insert(
      runtime.database,
      "free_agent_draft_recovery_action_command_results",
      validResult
    );
    runtime.database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type =
            'free_agent_draft_recovery_action_command_result',
          result_id = ?,
          completed_at_ms = ?
      WHERE id = ?
    `).run(
      ids.commandResult,
      ACTION_AT_MS,
      ids.idempotency
    );

    const adminRequestId = ids.adminIdempotency;
    insert(
      runtime.database,
      "idempotency_requests",
      idempotencyRecord(ids, {
        id: adminRequestId,
        actorUserId: ids.adminUser,
        operation: "free_agent_draft.recovery.action",
        requestHash: sha256(requestJson),
        createdAtMs: ACTION_AT_MS,
      })
    );
    insert(
      runtime.database,
      "free_agent_draft_recovery_action_command_results",
      recoveryCommandResult(ids, {
        id: ids.adminCommandResult,
        idempotencyRequestId: adminRequestId,
        actorUserId: ids.adminUser,
        actorMembershipId: ids.adminMembership,
        actorAuthority:
          "platform_administrator_as_commissioner",
        requestJson,
        reason,
      })
    );

    const inactiveRequestId = uuid(393_090);
    insert(
      runtime.database,
      "idempotency_requests",
      idempotencyRecord(ids, {
        id: inactiveRequestId,
        actorUserId: ids.inactiveUser,
        operation: "free_agent_draft.recovery.action",
        requestHash: sha256(requestJson),
        createdAtMs: ACTION_AT_MS,
      })
    );
    assertConstraint(
      () => insert(
        runtime.database,
        "free_agent_draft_recovery_action_command_results",
        recoveryCommandResult(ids, {
          id: uuid(393_091),
          idempotencyRequestId: inactiveRequestId,
          actorUserId: ids.inactiveUser,
          actorMembershipId: ids.inactiveMembership,
          actorAuthority:
            "platform_administrator_as_commissioner",
          requestJson,
          reason,
        })
      ),
      /exact request|authority/i
    );

    const triggers = captureAndDropTriggers(runtime.database);
    runtime.database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          attempt_count = 1,
          started_at_ms = ?,
          completed_at_ms = ?,
          result_json = '{"status":"succeeded"}',
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
    `).run(
      ACTION_AT_MS,
      ACTION_AT_MS + 1,
      ACTION_AT_MS + 1,
      ids.job
    );
    runtime.database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          resolved_authority = 'system',
          resolved_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
    `).run(
      ACTION_AT_MS + 1,
      ACTION_AT_MS + 1,
      ids.recovery
    );
    restoreTriggers(runtime.database, triggers);

    assert.deepEqual(
      runtime.database.prepare(`
        SELECT request_json AS requestJson,
               request_sha256 AS requestSha256,
               response_http_status AS responseHttpStatus,
               response_json AS responseJson,
               response_sha256 AS responseSha256
        FROM free_agent_draft_recovery_action_command_results
        WHERE id = ?
      `).get(ids.commandResult),
      {
        requestJson,
        requestSha256: sha256(requestJson),
        responseHttpStatus: 202,
        responseJson: recoveryResponseJson(ids),
        responseSha256: sha256(recoveryResponseJson(ids)),
      }
    );
    assertConstraint(
      () => runtime.database.prepare(`
        UPDATE free_agent_draft_recovery_action_command_results
        SET response_json = '{}'
        WHERE id = ?
      `).run(ids.commandResult),
      /immutable/i
    );
    assertConstraint(
      () => runtime.database.prepare(`
        DELETE FROM free_agent_draft_recovery_action_command_results
        WHERE id = ?
      `).run(ids.commandResult),
      /immutable/i
    );
    assertConstraint(
      () => runtime.database.prepare(`
        UPDATE idempotency_requests
        SET result_id = ?
        WHERE id = ?
      `).run(ids.adminCommandResult, ids.idempotency),
      /immutable/i
    );
    assertHealthy(runtime.database);
  });

  test("corrects terminal allocations with attributable barriers and immutable exact T144 replay evidence", (t) => {
    const { runtime, ids } = createFreshFixture(
      t,
      "fad39-correction-receipt-",
      395_000,
      (database, fixture) => {
        insert(
          database,
          "free_agent_draft_player_allocations",
          allocationRecord(fixture)
        );
        insert(
          database,
          "free_agent_draft_player_allocations",
          allocationRecord(fixture, {
            id: fixture.adminAllocation,
            playerId: fixture.otherPlayer,
          })
        );
      }
    );
    const evidence = correctionReceiptEvidence(ids);
    const insertCorrectionTransaction = ({ badHash = false } = {}) => {
      insert(
        runtime.database,
        "idempotency_requests",
        idempotencyRecord(ids, {
          operation: "free_agent_draft.allocation.correction",
          requestHash: evidence.requestHash,
          createdAtMs: CORRECTION_AT_MS,
        })
      );
      insert(
        runtime.database,
        "commissioner_corrections",
        correctionRecord(ids)
      );
      runtime.database.prepare(`
        UPDATE free_agent_draft_player_allocations
        SET status = 'no_valid_offer',
            decision_code = 'corrected',
            accounted_at_ms = ?,
            last_error_code = NULL,
            updated_at_ms = ?,
            version = version + 1
        WHERE id = ?
          AND version = 3
      `).run(
        CORRECTION_AT_MS,
        CORRECTION_AT_MS,
        ids.allocation
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        correctionEventRecord(ids)
      );
      insert(
        runtime.database,
        "league_activity",
        activityRecord(ids)
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_correction_command_results",
        {
          ...correctionCommandResult(ids, evidence),
          request_sha256: badHash
            ? "0".repeat(64)
            : evidence.requestHash,
        }
      );
      runtime.database.prepare(`
        UPDATE idempotency_requests
        SET status = 'completed',
            result_type =
              'free_agent_draft_allocation_correction_command_result',
            result_id = ?,
            completed_at_ms = ?
        WHERE id = ?
      `).run(
        ids.commandResult,
        CORRECTION_AT_MS,
        ids.idempotency
      );
    };

    assertConstraint(
      () => transaction(
        runtime.database,
        () => insertCorrectionTransaction({ badHash: true })
      ),
      /exact request|bind/i
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, decision_code AS decisionCode, version
        FROM free_agent_draft_player_allocations
        WHERE id = ?
      `).get(ids.allocation),
      {
        status: "invalid",
        decisionCode: "invalid_snapshot",
        version: 3,
      }
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM commissioner_corrections
        WHERE id = ?
      `).get(ids.correction).count,
      0
    );

    transaction(
      runtime.database,
      () => insertCorrectionTransaction()
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT request_json AS requestJson,
               request_sha256 AS requestSha256,
               response_http_status AS responseHttpStatus,
               response_json AS responseJson,
               response_sha256 AS responseSha256,
               accepted_from_allocation_version AS acceptedVersion,
               resulting_allocation_version AS resultingVersion
        FROM free_agent_draft_allocation_correction_command_results
        WHERE id = ?
      `).get(ids.commandResult),
      {
        requestJson: evidence.requestJson,
        requestSha256: evidence.requestHash,
        responseHttpStatus: 200,
        responseJson: evidence.responseJson,
        responseSha256: evidence.responseHash,
        acceptedVersion: 3,
        resultingVersion: 4,
      }
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT activity_id AS activityId
        FROM free_agent_draft_allocation_events
        WHERE id = ?
      `).get(ids.correctionEvent).activityId,
      null
    );
    assertConstraint(
      () => runtime.database.prepare(`
        UPDATE commissioner_corrections
        SET reason = 'Mutated correction evidence.'
        WHERE id = ?
      `).run(ids.correction),
      /immutable/i
    );
    assertConstraint(
      () => runtime.database.prepare(`
        DELETE FROM commissioner_corrections
        WHERE id = ?
      `).run(ids.correction),
      /immutable/i
    );
    assertConstraint(
      () => runtime.database.prepare(`
        UPDATE free_agent_draft_allocation_correction_command_results
        SET response_json = '{}'
        WHERE id = ?
      `).run(ids.commandResult),
      /immutable/i
    );
    assertConstraint(
      () => insert(
        runtime.database,
        "free_agent_draft_allocation_correction_command_results",
        {
          ...correctionCommandResult(ids, evidence),
          id: ids.adminCommandResult,
        }
      ),
      /exact request|unique|constraint/i
    );

    insert(runtime.database, "commissioner_corrections", {
      id: ids.unrelatedCorrection,
      league_id: ids.league,
      season_id: ids.season,
      feature: "roster",
      feature_record_id: ids.team,
      actor_user_id: ids.user,
      reason: "Unrelated correction remains governed as before.",
      before_snapshot_json: "{}",
      after_snapshot_json: "{}",
      corrected_at_ms: CORRECTION_AT_MS + 1,
    });
    runtime.database.prepare(`
      UPDATE commissioner_corrections
      SET reason = 'Updated unrelated correction.'
      WHERE id = ?
    `).run(ids.unrelatedCorrection);
    runtime.database.prepare(`
      DELETE FROM commissioner_corrections
      WHERE id = ?
    `).run(ids.unrelatedCorrection);

    assertConstraint(
      () => transaction(runtime.database, () => {
        insert(
          runtime.database,
          "commissioner_corrections",
          correctionRecord(ids, {
            id: ids.inactiveCorrection,
            allocationId: ids.adminAllocation,
            actorUserId: ids.inactiveUser,
            correctedAtMs: CORRECTION_AT_MS + 10,
          })
        );
        runtime.database.prepare(`
          UPDATE free_agent_draft_player_allocations
          SET status = 'no_valid_offer',
              decision_code = 'corrected',
              accounted_at_ms = ?,
              updated_at_ms = ?,
              version = version + 1
          WHERE id = ?
        `).run(
          CORRECTION_AT_MS + 10,
          CORRECTION_AT_MS + 10,
          ids.adminAllocation
        );
      }),
      /attributable correction/i
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM commissioner_corrections
        WHERE id = ?
      `).get(ids.inactiveCorrection).count,
      0
    );

    transaction(runtime.database, () => {
      insert(
        runtime.database,
        "commissioner_corrections",
        correctionRecord(ids, {
          id: ids.adminCorrection,
          allocationId: ids.adminAllocation,
          actorUserId: ids.adminUser,
          correctedAtMs: CORRECTION_AT_MS + 20,
        })
      );
      runtime.database.prepare(`
        UPDATE free_agent_draft_player_allocations
        SET status = 'no_valid_offer',
            decision_code = 'corrected',
            accounted_at_ms = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE id = ?
      `).run(
        CORRECTION_AT_MS + 20,
        CORRECTION_AT_MS + 20,
        ids.adminAllocation
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        correctionEventRecord(ids, {
          id: ids.adminCorrectionEvent,
          allocationId: ids.adminAllocation,
          playerId: ids.otherPlayer,
          correctionId: ids.adminCorrection,
          actorUserId: ids.adminUser,
          actorMembershipId: ids.adminMembership,
          actorAuthority:
            "platform_administrator_as_commissioner",
          occurredAtMs: CORRECTION_AT_MS + 20,
        })
      );
    });
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, decision_code AS decisionCode, version
        FROM free_agent_draft_player_allocations
        WHERE id = ?
      `).get(ids.adminAllocation),
      {
        status: "no_valid_offer",
        decisionCode: "corrected",
        version: 4,
      }
    );
    assertHealthy(runtime.database);
  });

  test("corrects live restricted and fallback auctions through exact recovered cancellation and resolves linked recoveries", (t) => {
    const runtime = createRuntime(t, "fad39-live-correction-");
    copyMigrations(runtime, 1, 39);
    migrate(runtime, "fad39-live-correction");
    const triggers = captureAndDropTriggers(runtime.database);
    const cases = [
      {
        name: "restricted-no-valid-commissioner",
        base: 420_000,
        install: {
          allocationStatus: "restricted_active",
        },
        apply: {},
      },
      {
        name: "restricted-automatic-platform-admin",
        base: 421_000,
        install: {
          allocationStatus: "restricted_active",
          includeAutomaticAwardEvidence: true,
        },
        apply: {
          afterStatus: "automatic_award",
          actor: "admin",
        },
      },
      {
        name: "correction-required-resolution",
        base: 422_000,
        install: {
          allocationStatus: "correction_required",
          auctionStatus: "resolving",
          recoveryKind: "auction_resolution",
        },
        apply: { recovery: true },
      },
      {
        name: "correction-required-automatic-resolution",
        base: 425_000,
        install: {
          allocationStatus: "correction_required",
          auctionStatus: "resolving",
          includeAutomaticAwardEvidence: true,
          recoveryKind: "auction_resolution",
        },
        apply: {
          afterStatus: "automatic_award",
          recovery: true,
        },
      },
      {
        name: "restricted-activation-recovery",
        base: 423_000,
        install: {
          allocationStatus: "restricted_active",
          recoveryKind: "restricted_activation",
        },
        apply: { recovery: true },
      },
      {
        name: "fallback-activation-recovery",
        base: 424_000,
        install: {
          allocationStatus: "restricted_fallback_open",
          sourceKind: "fad_open_rapid",
          recoveryKind: "fallback_activation",
        },
        apply: { recovery: true },
      },
    ].map((item) => {
      const ids = insertCore(runtime.database, item.base);
      const fixture = installCorrectableFadAuction(
        runtime.database,
        ids,
        item.install
      );
      return { ...item, ids, fixture };
    });
    restoreTriggers(runtime.database, triggers);

    for (const item of cases) {
      const admin = item.apply.actor === "admin";
      transaction(runtime.database, () => {
        applyCorrectableFadAuction(
          runtime.database,
          item.ids,
          item.fixture,
          {
            afterStatus:
              item.apply.afterStatus ?? "no_valid_offer",
            actorUserId: admin
              ? item.ids.adminUser
              : item.ids.user,
            actorMembershipId: admin
              ? item.ids.adminMembership
              : item.ids.membership,
            actorAuthority: admin
              ? "platform_administrator_as_commissioner"
              : "commissioner",
            recoveryId: item.apply.recovery
              ? item.ids.activationRecovery
              : null,
          }
        );
      });
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT allocation.status AS allocationStatus,
                 allocation.decision_code AS decisionCode,
                 auction.status AS auctionStatus,
                 resolution.status AS resolutionStatus,
                 resolution.outcome_code AS outcomeCode,
                 draw.version AS drawVersion,
                 draw.ordered_tied_bid_ids_json AS tiedBidIds,
                 draw.selected_bid_id AS selectedBidId
          FROM free_agent_draft_player_allocations AS allocation
          JOIN auctions AS auction
            ON auction.id = ?
          JOIN auction_resolutions AS resolution
            ON resolution.auction_id = auction.id
          JOIN free_agent_draft_draws AS draw
            ON draw.auction_id = auction.id
          WHERE allocation.id = ?
        `).get(item.fixture.auctionId, item.ids.allocation),
        {
          allocationStatus:
            item.apply.afterStatus ?? "no_valid_offer",
          decisionCode: "corrected",
          auctionStatus: "cancelled",
          resolutionStatus: "cancelled",
          outcomeCode: "recovered",
          drawVersion: 2,
          tiedBidIds: "[]",
          selectedBidId: null,
        },
        item.name
      );
      if (item.apply.recovery) {
        assert.deepEqual(
          runtime.database.prepare(`
            SELECT status, resolved_authority AS authority,
                   resolved_at_ms AS resolvedAtMs
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `).get(item.ids.activationRecovery),
          {
            status: "resolved",
            authority: "commissioner",
            resolvedAtMs: CORRECTION_AT_MS,
          },
          item.name
        );
      }
      assert.equal(
        runtime.database.prepare(`
          SELECT status
          FROM idempotency_requests
          WHERE id = ?
        `).get(item.ids.idempotency).status,
        "completed",
        item.name
      );
    }
    assertHealthy(runtime.database);
  });

  test("rejects every incomplete or mismatched live-auction correction with zero writes", (t) => {
    const runtime = createRuntime(t, "fad39-live-correction-negative-");
    copyMigrations(runtime, 1, 39);
    migrate(runtime, "fad39-live-correction-negative");
    const triggers = captureAndDropTriggers(runtime.database);
    const definitions = [
      { name: "scheduled-before-created", install: {
        allocationStatus: "restricted_scheduled",
      } },
      { name: "bid", install: { includeBid: true } },
      { name: "prior-result", install: {} },
      { name: "prior-reveal", install: {} },
      { name: "missing-draw", install: {} },
      { name: "wrong-context", install: {} },
      { name: "wrong-actor", install: {} },
      { name: "wrong-time", install: {} },
      { name: "wrong-version", install: {} },
      { name: "wrong-status", install: {} },
      { name: "selection", install: { includeBid: true } },
      { name: "wrong-job", install: {
        recoveryKind: "restricted_activation",
      } },
      { name: "live-auction", install: {} },
      { name: "unresolved-recovery", install: {
        recoveryKind: "restricted_activation",
      } },
      { name: "nonterminal-linked-auction", install: {
        allocationStatus: "restricted_fallback_open",
        sourceKind: "fad_open_rapid",
      } },
      { name: "ambiguous-draw", install: {} },
    ].map((definition, index) => {
      const base = 430_000 + index * 1_000;
      const ids = insertCore(runtime.database, base);
      const fixture = installCorrectableFadAuction(
        runtime.database,
        ids,
        definition.install
      );
      if (definition.name === "scheduled-before-created") {
        runtime.database.prepare(`
          UPDATE auctions
          SET opened_at_ms = ?, created_at_ms = ?, updated_at_ms = ?
          WHERE id = ?
        `).run(
          CORRECTION_AT_MS + 1,
          CORRECTION_AT_MS + 1,
          CORRECTION_AT_MS + 1,
          fixture.auctionId
        );
        runtime.database.prepare(`
          UPDATE free_agent_draft_draws
          SET created_at_ms = ?, updated_at_ms = ?
          WHERE id = ?
        `).run(
          CORRECTION_AT_MS + 1,
          CORRECTION_AT_MS + 1,
          fixture.drawId
        );
      } else if (definition.name === "prior-result") {
        insert(
          runtime.database,
          "auction_resolutions",
          correctedRecoveredResolutionRecord(
            ids,
            fixture.auctionId,
            ids.user,
            CORRECTION_AT_MS - 1
          )
        );
      } else if (definition.name === "prior-reveal") {
        runtime.database.prepare(`
          UPDATE free_agent_draft_draws
          SET ordered_tied_bid_ids_json = '[]',
              ordered_tied_team_ids_json = '[]',
              revealed_at_ms = ?, updated_at_ms = ?, version = 2
          WHERE id = ?
        `).run(
          CORRECTION_AT_MS - 1,
          CORRECTION_AT_MS - 1,
          fixture.drawId
        );
      } else if (definition.name === "missing-draw") {
        runtime.database.prepare(`
          DELETE FROM free_agent_draft_draws WHERE id = ?
        `).run(fixture.drawId);
      } else if (definition.name === "wrong-job") {
        runtime.database.prepare(`
          UPDATE job_runs
          SET status = 'running',
              lease_owner = 'stale-worker',
              lease_token = ?,
              lease_expires_at_ms = ?,
              completed_at_ms = NULL,
              last_error_code = NULL
          WHERE id = ?
        `).run(
          uuid(base + 999),
          CORRECTION_AT_MS + 10_000,
          ids.activationJob
        );
      } else if (
        definition.name === "nonterminal-linked-auction"
      ) {
        runtime.database.prepare(`
          UPDATE auctions
          SET status = 'failed'
          WHERE id = ?
        `).run(ids.auction);
      }
      return { ...definition, ids, fixture };
    });
    restoreTriggers(runtime.database, triggers);

    for (const item of definitions) {
      if (item.name === "wrong-context") {
        assertConstraint(
          () => runtime.database.prepare(`
            UPDATE auction_contexts
            SET fad_origin = 'manager_nomination'
            WHERE auction_id = ?
          `).run(item.fixture.auctionId),
          /constraint|context|FAD/i
        );
        continue;
      }
      if (item.name === "ambiguous-draw") {
        assertConstraint(
          () => insert(
            runtime.database,
            "free_agent_draft_draws",
            drawRecord(item.ids, {
              id: uuid(Number(String(item.ids.draw).slice(-12)) + 800),
              allocation_id: item.ids.allocation,
              auction_id: item.fixture.auctionId,
              nonce_bytes: Buffer.alloc(32, 0x55),
              commitment_hex: sha256(
                `ambiguous:${item.fixture.auctionId}`
              ),
              created_at_ms: CORRECTION_AT_MS - 1_000,
              updated_at_ms: CORRECTION_AT_MS - 1_000,
            })
          ),
          /unique|draw|FAD/i
        );
        continue;
      }
      const options = {};
      if (item.name === "wrong-actor") {
        options.eventMetadata = {
          actorAuthority:
            "platform_administrator_as_commissioner",
          correctionId: item.ids.correction,
        };
      } else if (item.name === "wrong-time") {
        options.resolutionOverrides = {
          resolved_at_ms: CORRECTION_AT_MS + 1,
        };
      } else if (item.name === "wrong-version") {
        options.correctionBeforeVersion = 2;
      } else if (item.name === "wrong-status") {
        options.resolutionOverrides = {
          outcome_code: "failed",
        };
      } else if (item.name === "selection") {
        options.resolutionOverrides = {
          winning_bid_id: item.ids.bid,
          winning_team_id: item.ids.team,
        };
      } else if (item.name === "wrong-job") {
        options.recoveryId = item.ids.activationRecovery;
      } else if (item.name === "live-auction") {
        options.leaveAuctionLive = true;
      } else if (item.name === "unresolved-recovery") {
        options.recoveryId = item.ids.activationRecovery;
        options.leaveRecoveryUnresolved = true;
      }
      assertConstraint(
        () => transaction(runtime.database, () => {
          applyCorrectableFadAuction(
            runtime.database,
            item.ids,
            item.fixture,
            options
          );
        }),
        /constraint|FAD|auction|correction|draw|result|recovery/i
      );
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT status, decision_code AS decisionCode, version
          FROM free_agent_draft_player_allocations
          WHERE id = ?
        `).get(item.ids.allocation),
        {
          status: item.install.allocationStatus ??
            "restricted_active",
          decisionCode:
            item.install.sourceKind === "fad_open_rapid"
              ? "restricted_no_improvement_fallback"
              : "exact_total_and_term_tie",
          version: 3,
        },
        item.name
      );
      assert.equal(
        runtime.database.prepare(`
          SELECT COUNT(*) AS count
          FROM commissioner_corrections
          WHERE id = ?
        `).get(item.ids.correction).count,
        0,
        item.name
      );
    }
    assertHealthy(runtime.database);
  });

  test("recovers a failed open-rapid auction through cancellation while restricted recovery stays rejected", (t) => {
    let restrictedIds;
    const { runtime, ids } = createFreshFixture(
      t,
      "fad39-open-cancel-",
      396_000,
      (database, fixture) => {
        insert(
          database,
          "job_runs",
          jobRecord(fixture, {
            occurrenceKey:
              `auction:${fixture.auction}:${AUCTION_RESOLVES_AT_MS}`,
            jobType: "auction.resolve.target",
            status: "running",
            scheduledForMs: AUCTION_RESOLVES_AT_MS,
            updatedAtMs: RECOVERY_STARTED_AT_MS,
          })
        );
        insert(database, "auctions", auctionRecord(fixture));
        insert(
          database,
          "auction_contexts",
          auctionContextRecord(fixture)
        );
        insert(
          database,
          "free_agent_draft_draws",
          drawRecord(fixture)
        );
        insert(
          database,
          "free_agent_draft_recoveries",
          recoveryRecord(fixture, {
            player_id: fixture.player,
            rollover_id: fixture.rollover,
            auction_id: fixture.auction,
            kind: "auction_resolution",
            status: "running",
            target_resolution_at_ms:
              AUCTION_RESOLVES_AT_MS,
            last_error_code:
              "AUCTION_RESOLUTION_FAILED",
            commissioner_reason:
              "Cancel the failed open rapid auction.",
            created_at_ms: AUCTION_FAILED_AT_MS,
            updated_at_ms: RECOVERY_STARTED_AT_MS,
            version: 2,
          })
        );
        insert(
          database,
          "auction_events",
          auctionEventRecord(fixture, {
            id: fixture.failureEvent,
            eventType: "fad_auction_resolution_failed",
            actorUserId: null,
            metadata: {
              errorCode: "AUCTION_RESOLUTION_FAILED",
              jobRunId: fixture.job,
              recoveryId: fixture.recovery,
            },
            occurredAtMs: AUCTION_FAILED_AT_MS,
          })
        );
        insert(
          database,
          "auction_events",
          auctionEventRecord(fixture, {
            id: fixture.cancellationEvent,
            eventType: "auction_cancelled",
            actorUserId: fixture.user,
            metadata: {
              actorAuthority: "commissioner",
              recoveryId: fixture.recovery,
            },
            occurredAtMs: AUCTION_CANCELLED_AT_MS,
          })
        );

        restrictedIds = insertCore(database, 397_000);
        insert(
          database,
          "free_agent_draft_player_allocations",
          {
            ...allocationRecord(restrictedIds),
            status: "correction_required",
            decision_code: "exact_total_and_term_tie",
            accounted_at_ms: null,
            last_error_code: "AUCTION_RESOLUTION_FAILED",
          }
        );
        insert(
          database,
          "job_runs",
          jobRecord(restrictedIds, {
            occurrenceKey:
              `auction:${restrictedIds.auction}:${AUCTION_RESOLVES_AT_MS}`,
            jobType: "auction.resolve.target",
            status: "running",
            scheduledForMs: AUCTION_RESOLVES_AT_MS,
            updatedAtMs: RECOVERY_STARTED_AT_MS,
          })
        );
        insert(
          database,
          "auctions",
          auctionRecord(restrictedIds, {
            status: "resolving",
            updated_at_ms: AUCTION_CANCELLED_AT_MS,
            version: 3,
          })
        );
        insert(
          database,
          "auction_contexts",
          auctionContextRecord(restrictedIds, {
            source_kind: "fad_restricted",
            fad_allocation_id: restrictedIds.allocation,
            fad_origin: "candidate_tie_restricted",
          })
        );
        insert(
          database,
          "free_agent_draft_draws",
          {
            ...drawRecord(restrictedIds),
            allocation_id: restrictedIds.allocation,
          }
        );
        insert(
          database,
          "free_agent_draft_recoveries",
          recoveryRecord(restrictedIds, {
            player_id: restrictedIds.player,
            allocation_id: restrictedIds.allocation,
            rollover_id: restrictedIds.rollover,
            auction_id: restrictedIds.auction,
            kind: "auction_resolution",
            status: "running",
            target_resolution_at_ms:
              AUCTION_RESOLVES_AT_MS,
            last_error_code:
              "AUCTION_RESOLUTION_FAILED",
            commissioner_reason:
              "Restricted recovery must not use open cancellation.",
            created_at_ms: AUCTION_FAILED_AT_MS,
            updated_at_ms: RECOVERY_STARTED_AT_MS,
            version: 2,
          })
        );
        insert(
          database,
          "auction_events",
          auctionEventRecord(restrictedIds, {
            id: restrictedIds.cancellationEvent,
            eventType: "auction_cancelled",
            actorUserId: restrictedIds.user,
            metadata: {
              actorAuthority: "commissioner",
            },
            occurredAtMs: AUCTION_CANCELLED_AT_MS,
          })
        );
      }
    );

    assertConstraint(
      () => insert(
        runtime.database,
        "auction_resolutions",
        recoveredResolutionRecord(restrictedIds)
      ),
      /physical outcome|restricted result/i
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count
        FROM auction_resolutions
        WHERE auction_id = ?
      `).get(restrictedIds.auction).count,
      0
    );

    runtime.database.prepare(`
      UPDATE auctions
      SET status = 'resolving',
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
        AND status = 'failed'
    `).run(AUCTION_CANCELLED_AT_MS, ids.auction);
    insert(
      runtime.database,
      "auction_resolutions",
      recoveredResolutionRecord(ids)
    );
    runtime.database.prepare(`
      UPDATE free_agent_draft_draws
      SET ordered_tied_bid_ids_json = '[]',
          ordered_tied_team_ids_json = '[]',
          rejection_counter = NULL,
          selected_index = NULL,
          selected_bid_id = NULL,
          selected_team_id = NULL,
          selected_digest_hex = NULL,
          revealed_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE id = ?
        AND version = 1
    `).run(
      AUCTION_CANCELLED_AT_MS,
      AUCTION_CANCELLED_AT_MS,
      ids.draw
    );
    runtime.database.prepare(`
      UPDATE auctions
      SET status = 'cancelled',
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
        AND status = 'resolving'
    `).run(AUCTION_CANCELLED_AT_MS, ids.auction);
    runtime.database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = ?,
          resolved_by_membership_id = ?,
          resolved_authority = 'commissioner',
          resolved_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
        AND status = 'running'
    `).run(
      ids.user,
      ids.membership,
      AUCTION_CANCELLED_AT_MS,
      AUCTION_CANCELLED_AT_MS,
      ids.recovery
    );

    const cancelResponseJson = JSON.stringify({
      auctionId: ids.auction,
      cancelledAtMs: AUCTION_CANCELLED_AT_MS,
      status: "cancelled",
    });
    const cancelRequestHash = sha256(JSON.stringify({
      auctionId: ids.auction,
      reason: "Cancel the failed open rapid auction.",
    }));
    insert(
      runtime.database,
      "idempotency_requests",
      idempotencyRecord(ids, {
        id: ids.auctionIdempotency,
        operation: "auction.cancel",
        requestHash: cancelRequestHash,
        createdAtMs: AUCTION_CANCELLED_AT_MS,
      })
    );
    insert(
      runtime.database,
      "auction_administration_command_results",
      {
        id: ids.auctionCommandResult,
        league_id: ids.league,
        season_id: ids.season,
        auction_id: ids.auction,
        bid_id: null,
        idempotency_request_id: ids.auctionIdempotency,
        job_run_id: null,
        action: "cancel_auction",
        actor_user_id: ids.user,
        actor_membership_id: ids.membership,
        actor_authority: "commissioner",
        request_sha256: cancelRequestHash,
        precondition_kind: "auction",
        expected_resource_version: 2,
        resulting_resource_version: 4,
        response_http_status: 200,
        response_json: cancelResponseJson,
        response_sha256: sha256(cancelResponseJson),
        created_at_ms: AUCTION_CANCELLED_AT_MS,
        version: 1,
      }
    );
    runtime.database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type =
            'auction_administration_command_result',
          result_id = ?,
          completed_at_ms = ?
      WHERE id = ?
    `).run(
      ids.auctionCommandResult,
      AUCTION_CANCELLED_AT_MS,
      ids.auctionIdempotency
    );

    assert.deepEqual(
      runtime.database.prepare(`
        SELECT auction.status AS auctionStatus,
               auction.version AS auctionVersion,
               resolution.status AS resolutionStatus,
               resolution.outcome_code AS outcomeCode,
               recovery.status AS recoveryStatus,
               recovery.resolved_authority AS resolvedAuthority,
               draw.ordered_tied_bid_ids_json AS tiedBids,
               draw.selected_bid_id AS selectedBidId
        FROM auctions AS auction
        JOIN auction_resolutions AS resolution
          ON resolution.league_id = auction.league_id
         AND resolution.auction_id = auction.id
        JOIN free_agent_draft_recoveries AS recovery
          ON recovery.league_id = auction.league_id
         AND recovery.auction_id = auction.id
        JOIN free_agent_draft_draws AS draw
          ON draw.league_id = auction.league_id
         AND draw.auction_id = auction.id
        WHERE auction.id = ?
      `).get(ids.auction),
      {
        auctionStatus: "cancelled",
        auctionVersion: 4,
        resolutionStatus: "cancelled",
        outcomeCode: "recovered",
        recoveryStatus: "resolved",
        resolvedAuthority: "commissioner",
        tiedBids: "[]",
        selectedBidId: null,
      }
    );
    assertHealthy(runtime.database);
  });
});
