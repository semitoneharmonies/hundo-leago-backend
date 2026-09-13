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

const CLOCK = Object.freeze({
  openedAtMs: 827_190_000,
  helpOpensAtMs: 827_200_000,
  candidateDeadlineAtMs: 1_000_000_000,
  allocationCompletedAtMs: 1_000_000_020,
  auctionOpenedAtMs: 1_000_001_000,
  auctionResolvesAtMs: 1_086_400_000,
  cancellationAtMs: 1_086_400_010,
  correctionAtMs: 1_086_400_100,
  recoveryStartedAtMs: 1_086_400_200,
  recoveryResolvedAtMs: 1_086_400_300,
  firstMatchupStartsAtMs: 1_604_800_000,
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  return database
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

function dropInsertTriggers(database, tableName) {
  for (const trigger of tableTriggers(database, tableName)) {
    if (/\b(?:BEFORE|AFTER)\s+INSERT\b/i.test(trigger.sql)) {
      database.exec(
        `DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`
      );
    }
  }
}

function createRuntime() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-correction-recovery-")
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
      applicationBuildId: "fad-correction-recovery-foundation",
      now: () => 1_000,
    });
    connection.database.pragma("foreign_keys = OFF");

    return {
      ...connection,
      temporaryRoot,
    };
  } catch (error) {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertConstraintError(error) {
  assert.ok(error, "expected the database to reject the write");
  assert.match(
    String(error.code ?? error.message),
    /SQLITE_CONSTRAINT/i
  );
}

function expectConstraintTransaction(database, operation) {
  let caught = null;
  database.exec("BEGIN");
  try {
    operation();
  } catch (error) {
    caught = error;
  } finally {
    database.exec("ROLLBACK");
  }
  assertConstraintError(caught);
}

function commitTransaction(database, operation) {
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

function scenarioIds(base) {
  return Object.freeze({
    league: uuid(base + 1),
    season: uuid(base + 2),
    fad: uuid(base + 3),
    readiness: uuid(base + 4),
    week: uuid(base + 5),
    commissionerUser: uuid(base + 6),
    commissionerMembership: uuid(base + 7),
    player: uuid(base + 8),
    otherPlayer: uuid(base + 9),
    allocation: uuid(base + 10),
    auction: uuid(base + 11),
    rollover: uuid(base + 12),
    job: uuid(base + 13),
    resolution: uuid(base + 14),
    draw: uuid(base + 15),
    recovery: uuid(base + 16),
    priorAllocationEvent: uuid(base + 17),
    correction: uuid(base + 18),
    correctionEvent: uuid(base + 19),
  });
}

function seedIdentity(database, ids, base) {
  for (const tableName of [
    "users",
    "leagues",
    "league_memberships",
  ]) {
    dropInsertTriggers(database, tableName);
  }

  insert(database, "users", {
    id: ids.commissionerUser,
    email_normalized: `fad-correction-${base}@example.test`,
    email_display: `fad-correction-${base}@example.test`,
    display_name: `FAD Commissioner ${base}`,
    display_name_normalized: `fad commissioner ${base}`,
    status: "active",
    created_at_ms: CLOCK.openedAtMs,
    updated_at_ms: CLOCK.openedAtMs,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `FAD correction league ${base}`,
    name_normalized: `fad correction league ${base}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: ids.commissionerMembership,
    current_season_id: ids.season,
    created_at_ms: CLOCK.openedAtMs,
    updated_at_ms: CLOCK.openedAtMs,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: ids.commissionerMembership,
    league_id: ids.league,
    user_id: ids.commissionerUser,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: CLOCK.openedAtMs,
    ended_at_ms: null,
    created_at_ms: CLOCK.openedAtMs,
    updated_at_ms: CLOCK.openedAtMs,
    version: 1,
  });
}

function seedFad(database, ids) {
  dropInsertTriggers(database, "free_agent_drafts");
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key: `fad:${ids.season}:readiness`,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id: ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "rapid",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Focused correction-recovery fixture.",
    opening_authority: "system",
    opened_at_ms: CLOCK.openedAtMs,
    help_opens_at_ms: CLOCK.helpOpensAtMs,
    candidate_deadline_at_ms: CLOCK.candidateDeadlineAtMs,
    first_matchup_starts_at_ms: CLOCK.firstMatchupStartsAtMs,
    deadline_locked_at_ms: CLOCK.candidateDeadlineAtMs + 10,
    allocation_completed_at_ms: CLOCK.allocationCompletedAtMs,
    completed_at_ms: null,
    created_at_ms: CLOCK.openedAtMs,
    updated_at_ms: CLOCK.allocationCompletedAtMs,
    version: 4,
  });
}

function seedCancelledAuction(
  database,
  ids,
  { sourceKind = "fad_restricted" } = {}
) {
  const restricted = sourceKind === "fad_restricted";
  for (const tableName of [
    "auctions",
    "auction_contexts",
    "auction_resolutions",
    "free_agent_draft_draws",
    "job_runs",
  ]) {
    dropInsertTriggers(database, tableName);
  }

  insert(database, "auctions", {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status: "cancelled",
    opened_at_ms: CLOCK.auctionOpenedAtMs,
    resolves_at_ms: CLOCK.auctionResolvesAtMs,
    opened_by_user_id: null,
    created_at_ms: CLOCK.auctionOpenedAtMs,
    updated_at_ms: CLOCK.cancellationAtMs,
    version: 3,
  });
  insert(database, "auction_contexts", {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    source_kind: sourceKind,
    fad_id: ids.fad,
    fad_rollover_id: ids.rollover,
    fad_allocation_id: restricted ? ids.allocation : null,
    fad_origin: restricted
      ? "candidate_tie_restricted"
      : "manager_nomination",
    created_at_ms: CLOCK.auctionOpenedAtMs,
  });
  insert(database, "auction_resolutions", {
    id: ids.resolution,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    scheduled_occurrence_key:
      `auction:${ids.auction}:${CLOCK.auctionResolvesAtMs}`,
    outcome_code: "failed",
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
    idempotency_key: `fixture:${ids.resolution}`,
    status: "cancelled",
    resolved_at_ms: CLOCK.cancellationAtMs,
  });
  insert(database, "free_agent_draft_draws", {
    id: ids.draw,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: restricted ? ids.allocation : null,
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
    created_at_ms: CLOCK.auctionOpenedAtMs,
    updated_at_ms: CLOCK.auctionOpenedAtMs,
    version: 1,
  });
  insert(database, "job_runs", {
    id: ids.job,
    league_id: ids.league,
    season_id: ids.season,
    job_type: "auction.resolve.target",
    occurrence_key:
      `auction:${ids.auction}:${CLOCK.auctionResolvesAtMs}`,
    scheduled_for_ms: CLOCK.auctionResolvesAtMs,
    status: "failed",
    attempt_count: 1,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: CLOCK.auctionResolvesAtMs,
    completed_at_ms: CLOCK.cancellationAtMs,
    result_json: null,
    last_error_code: "AUCTION_RESOLUTION_FAILED",
    created_at_ms: CLOCK.auctionOpenedAtMs,
    updated_at_ms: CLOCK.cancellationAtMs,
    version: 2,
    lease_token: null,
    next_attempt_at_ms: CLOCK.cancellationAtMs + 1,
  });
}

function seedAllocation(
  database,
  ids,
  {
    status = "correction_required",
    sourceKind = "fad_restricted",
  } = {}
) {
  const restricted = sourceKind === "fad_restricted";
  const corrected = status !== "correction_required";
  dropInsertTriggers(
    database,
    "free_agent_draft_player_allocations"
  );

  insert(database, "free_agent_draft_player_allocations", {
    id: ids.allocation,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    status,
    decision_code: corrected ? "corrected" : "exact_total_and_term_tie",
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: restricted ? ids.auction : null,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: restricted ? 600 : null,
    restricted_minimum_term_years: restricted ? 2 : null,
    restricted_minimum_aav_cents: restricted ? 300 : null,
    accounted_at_ms: corrected ? CLOCK.correctionAtMs : null,
    last_error_code: corrected
      ? null
      : "AUCTION_RESOLUTION_FAILED",
    created_at_ms: CLOCK.candidateDeadlineAtMs,
    updated_at_ms: corrected
      ? CLOCK.correctionAtMs
      : CLOCK.cancellationAtMs,
    version: corrected ? 4 : 3,
  });
}

function correctionRecord(ids) {
  return {
    id: ids.correction,
    league_id: ids.league,
    season_id: ids.season,
    feature: "free_agent_draft_allocation",
    feature_record_id: ids.allocation,
    actor_user_id: ids.commissionerUser,
    reason: "Close the quarantined allocation without an award.",
    before_snapshot_json: JSON.stringify({
      status: "correction_required",
    }),
    after_snapshot_json: JSON.stringify({
      status: "invalid",
      decisionCode: "corrected",
    }),
    corrected_at_ms: CLOCK.correctionAtMs,
  };
}

function allocationEvent(
  ids,
  {
    id,
    allocationVersion,
    eventKind,
    status,
    decisionCode,
    correctionId = null,
    actor = "system",
    auctionId = ids.auction,
    occurredAtMs,
  }
) {
  const commissioner = actor === "commissioner";
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    allocation_version: allocationVersion,
    player_id: ids.player,
    event_kind: eventKind,
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: decisionCode,
    resulting_allocation_status: status,
    contract_id: null,
    ownership_id: null,
    auction_id: auctionId,
    activity_id: null,
    correction_id: correctionId,
    actor_user_id: commissioner ? ids.commissionerUser : null,
    actor_membership_id: commissioner
      ? ids.commissionerMembership
      : null,
    actor_authority: actor,
    evidence_json: JSON.stringify({
      auctionId,
      correctionId,
      status,
    }),
    occurred_at_ms: occurredAtMs,
    created_at_ms: occurredAtMs,
    version: 1,
  };
}

function seedRecovery(
  database,
  ids,
  {
    allocationBinding = "exact",
    playerBinding = "exact",
  } = {}
) {
  dropInsertTriggers(database, "free_agent_draft_recoveries");
  insert(database, "free_agent_draft_recoveries", {
    id: ids.recovery,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id:
      playerBinding === "exact" ? ids.player : ids.otherPlayer,
    allocation_id:
      allocationBinding === "exact" ? ids.allocation : null,
    rollover_id: ids.rollover,
    auction_id: ids.auction,
    job_run_id: ids.job,
    kind: "auction_resolution",
    status: "correction_required",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: CLOCK.auctionResolvesAtMs,
    last_error_code: "AUCTION_RESOLUTION_FAILED",
    commissioner_reason: "Cancelled restricted auction correction.",
    created_by_operation_id: `fixture:${ids.recovery}`,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: CLOCK.cancellationAtMs,
    updated_at_ms: CLOCK.cancellationAtMs,
    resolved_at_ms: null,
    version: 1,
  });
}

function seedScenario(
  database,
  base,
  {
    sourceKind = "fad_restricted",
    allocationStatus = "correction_required",
    allocationBinding = "exact",
    playerBinding = "exact",
  } = {}
) {
  const ids = scenarioIds(base);
  seedIdentity(database, ids, base);
  seedFad(database, ids);
  seedCancelledAuction(database, ids, { sourceKind });
  seedAllocation(database, ids, {
    status: allocationStatus,
    sourceKind,
  });
  seedRecovery(database, ids, {
    allocationBinding,
    playerBinding,
  });

  if (allocationStatus === "correction_required") {
    insert(
      database,
      "free_agent_draft_allocation_events",
      allocationEvent(ids, {
        id: ids.priorAllocationEvent,
        allocationVersion: 3,
        eventKind: "restricted_state_changed",
        status: "correction_required",
        decisionCode: "exact_total_and_term_tie",
        occurredAtMs: CLOCK.cancellationAtMs,
      })
    );
  } else {
    insert(database, "commissioner_corrections", correctionRecord(ids));
    insert(
      database,
      "free_agent_draft_allocation_events",
      allocationEvent(ids, {
        id: ids.correctionEvent,
        allocationVersion: 4,
        eventKind: "correction_applied",
        status: allocationStatus,
        decisionCode: "corrected",
        correctionId: ids.correction,
        actor: "commissioner",
        auctionId:
          sourceKind === "fad_restricted"
            ? ids.auction
            : null,
        occurredAtMs: CLOCK.correctionAtMs,
      })
    );
  }

  return ids;
}

function updateAllocationToCorrected(
  database,
  ids,
  {
    allocationId = ids.allocation,
    minimumTotalValueCents = 600,
    minimumTermYears = 2,
    minimumAavCents = 300,
  } = {}
) {
  database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET id = @allocationId,
          status = 'invalid',
          decision_code = 'corrected',
          winning_snapshot_entry_id = NULL,
          winning_team_id = NULL,
          contract_id = NULL,
          ownership_id = NULL,
          restricted_auction_id = @auctionId,
          fallback_open_auction_id = NULL,
          restricted_minimum_total_cents = @minimumTotalValueCents,
          restricted_minimum_term_years = @minimumTermYears,
          restricted_minimum_aav_cents = @minimumAavCents,
          accounted_at_ms = @correctedAtMs,
          last_error_code = NULL,
          updated_at_ms = @correctedAtMs,
          version = version + 1
      WHERE id = @originalAllocationId
    `)
    .run({
      allocationId,
      originalAllocationId: ids.allocation,
      auctionId: ids.auction,
      minimumTotalValueCents,
      minimumTermYears,
      minimumAavCents,
      correctedAtMs: CLOCK.correctionAtMs,
    });
}

function insertCorrectionEvent(
  database,
  ids,
  { correctionId = ids.correction } = {}
) {
  insert(
    database,
    "free_agent_draft_allocation_events",
    allocationEvent(ids, {
      id: ids.correctionEvent,
      allocationVersion: 4,
      eventKind: "correction_applied",
      status: "invalid",
      decisionCode: "corrected",
      correctionId,
      actor: "commissioner",
      occurredAtMs: CLOCK.correctionAtMs,
    })
  );
}

function resolveRecovery(database, ids) {
  database
    .prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'running',
          updated_at_ms = @startedAtMs,
          version = version + 1
      WHERE id = @recoveryId
    `)
    .run({
      recoveryId: ids.recovery,
      startedAtMs: CLOCK.recoveryStartedAtMs,
    });
  database
    .prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = NULL,
          resolved_by_membership_id = NULL,
          resolved_authority = 'system',
          resolved_at_ms = @resolvedAtMs,
          updated_at_ms = @resolvedAtMs,
          version = version + 1
      WHERE id = @recoveryId
    `)
    .run({
      recoveryId: ids.recovery,
      resolvedAtMs: CLOCK.recoveryResolvedAtMs,
    });
}

describe(
  "migration 0030 FAD correction and blind recovery reachability",
  () => {
    let runtime;

    before(() => {
      runtime = createRuntime();
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

    test("advances a quarantined allocation to a corrected terminal state with immutable identity, linkage, and minimums", () => {
      const ids = seedScenario(runtime.database, 710_000);

      expectConstraintTransaction(runtime.database, () => {
        updateAllocationToCorrected(runtime.database, ids);
      });

      insert(
        runtime.database,
        "commissioner_corrections",
        correctionRecord(ids)
      );

      expectConstraintTransaction(runtime.database, () => {
        updateAllocationToCorrected(runtime.database, ids, {
          allocationId: uuid(719_999),
        });
      });
      expectConstraintTransaction(runtime.database, () => {
        updateAllocationToCorrected(runtime.database, ids, {
          minimumTotalValueCents: 700,
          minimumTermYears: 2,
          minimumAavCents: 350,
        });
      });
      expectConstraintTransaction(runtime.database, () => {
        updateAllocationToCorrected(runtime.database, ids);
        insertCorrectionEvent(runtime.database, ids, {
          correctionId: uuid(719_998),
        });
      });

      commitTransaction(runtime.database, () => {
        updateAllocationToCorrected(runtime.database, ids);
        insertCorrectionEvent(runtime.database, ids);
      });

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              id,
              league_id,
              season_id,
              fad_id,
              player_id,
              status,
              decision_code,
              restricted_auction_id,
              restricted_minimum_total_cents,
              restricted_minimum_term_years,
              restricted_minimum_aav_cents,
              accounted_at_ms,
              last_error_code,
              version
            FROM free_agent_draft_player_allocations
            WHERE id = ?
          `)
          .get(ids.allocation),
        {
          id: ids.allocation,
          league_id: ids.league,
          season_id: ids.season,
          fad_id: ids.fad,
          player_id: ids.player,
          status: "invalid",
          decision_code: "corrected",
          restricted_auction_id: ids.auction,
          restricted_minimum_total_cents: 600,
          restricted_minimum_term_years: 2,
          restricted_minimum_aav_cents: 300,
          accounted_at_ms: CLOCK.correctionAtMs,
          last_error_code: null,
          version: 4,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              event_kind,
              resulting_allocation_status,
              decision_code,
              auction_id,
              correction_id,
              actor_user_id,
              actor_membership_id,
              actor_authority,
              occurred_at_ms
            FROM free_agent_draft_allocation_events
            WHERE id = ?
          `)
          .get(ids.correctionEvent),
        {
          event_kind: "correction_applied",
          resulting_allocation_status: "invalid",
          decision_code: "corrected",
          auction_id: ids.auction,
          correction_id: ids.correction,
          actor_user_id: ids.commissionerUser,
          actor_membership_id: ids.commissionerMembership,
          actor_authority: "commissioner",
          occurred_at_ms: CLOCK.correctionAtMs,
        }
      );
    });

    test("resolves a cancelled restricted auction recovery without revealing its private draw", () => {
      const ids = seedScenario(runtime.database, 720_000, {
        allocationStatus: "invalid",
      });
      const drawBefore = runtime.database
        .prepare(`
          SELECT
            commitment_hex,
            ordered_tied_bid_ids_json,
            selected_bid_id,
            revealed_at_ms,
            updated_at_ms,
            version
          FROM free_agent_draft_draws
          WHERE id = ?
        `)
        .get(ids.draw);

      commitTransaction(runtime.database, () => {
        resolveRecovery(runtime.database, ids);
      });

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              status,
              last_error_code,
              resolved_authority,
              resolved_at_ms,
              version
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(ids.recovery),
        {
          status: "resolved",
          last_error_code: null,
          resolved_authority: "system",
          resolved_at_ms: CLOCK.recoveryResolvedAtMs,
          version: 3,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              commitment_hex,
              ordered_tied_bid_ids_json,
              selected_bid_id,
              revealed_at_ms,
              updated_at_ms,
              version
            FROM free_agent_draft_draws
            WHERE id = ?
          `)
          .get(ids.draw),
        drawBefore
      );
      assert.equal(drawBefore.revealed_at_ms, null);
      assert.equal(drawBefore.version, 1);
    });

    test("rejects blind restricted recovery when its causal allocation and player bindings do not match", () => {
      const ids = seedScenario(runtime.database, 730_000, {
        allocationStatus: "invalid",
        allocationBinding: "none",
        playerBinding: "mismatched",
      });

      expectConstraintTransaction(runtime.database, () => {
        resolveRecovery(runtime.database, ids);
      });
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(ids.recovery).status,
        "correction_required"
      );
    });

    test("rejects a private unrevealed draw as recovery proof for a nonrestricted FAD auction", () => {
      const ids = seedScenario(runtime.database, 740_000, {
        sourceKind: "fad_open_rapid",
        allocationStatus: "invalid",
        allocationBinding: "none",
      });

      expectConstraintTransaction(runtime.database, () => {
        resolveRecovery(runtime.database, ids);
      });
      assert.equal(
        runtime.database
          .prepare(`
            SELECT revealed_at_ms
            FROM free_agent_draft_draws
            WHERE id = ?
          `)
          .get(ids.draw).revealed_at_ms,
        null
      );
    });
  }
);
