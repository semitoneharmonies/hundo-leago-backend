const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 86_400_000;
const ROLLOVER_OPENS_AT_MS = 1_000_000;
const ROLLOVER_AT_MS = ROLLOVER_OPENS_AT_MS + DAY_MS;
const CREATION_CUTOFF_AT_MS = ROLLOVER_AT_MS - 3_600_000;
const OPENED_AT_MS = ROLLOVER_OPENS_AT_MS + 1_000;
const FIRST_MATCHUP_STARTS_AT_MS = ROLLOVER_OPENS_AT_MS + 7 * DAY_MS;
const MIGRATION_0044 = Object.freeze({
  byteLength: 32_654,
  fileName: "0044_allow_immediate_fad_open_rapid_starts.sql",
  sha256:
    "79f759030c01281f4a21aeba0584a3681d0ae84982d2b7a48dfcd7a5bf0274ee",
});

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  try {
    database.prepare(`
      INSERT INTO ${tableName} (${columns.join(", ")})
      VALUES (${columns.map((column) => `@${column}`).join(", ")})
    `).run(values);
  } catch (error) {
    throw new Error(`${tableName}: ${error.message}`, { cause: error });
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
    database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const { sql } of triggers) database.exec(sql);
}

function createRuntime(t, schemaVersion, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const migrations = discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  }).filter(({ id }) => id <= schemaVersion);
  const state = applyMigrations({
    database: connection.database,
    migrations,
    applicationBuildId: `${prefix}${schemaVersion}`,
    now: () => 1,
  });
  assert.equal(state.userVersion, schemaVersion);
  return { ...connection, state };
}

function upgradeTo44(runtime) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).filter(({ id }) => id <= 44),
    applicationBuildId: "fad-immediate-start-upgrade-44",
    now: () => 2,
  });
}

function fixtureIds(base) {
  return Object.freeze({
    managerUser: uuid(base + 1),
    commissionerUser: uuid(base + 2),
    managerMembership: uuid(base + 3),
    commissionerMembership: uuid(base + 4),
    assignment: uuid(base + 5),
    league: uuid(base + 10),
    season: uuid(base + 11),
    week: uuid(base + 12),
    readiness: uuid(base + 13),
    fad: uuid(base + 14),
    rollover: uuid(base + 15),
    team: uuid(base + 16),
    player: uuid(base + 17),
    auction: uuid(base + 18),
    draw: uuid(base + 19),
    request: uuid(base + 20),
    job: uuid(base + 21),
    bid: uuid(base + 22),
    event: uuid(base + 23),
  });
}

function seedFixture(database, base, {
  authority = "manager",
  sourceKind = "fad_open_rapid",
  origin = "manager_nomination",
  openedAtMs = OPENED_AT_MS,
  requestOperation = "auction.start",
  requestCreatedAtMs = openedAtMs,
  requestExpiresAtMs = requestCreatedAtMs + DAY_MS,
  includeDraw = sourceKind !== "ordinary_weekly",
  includeJob = sourceKind !== "ordinary_weekly",
} = {}) {
  const ids = fixtureIds(base);
  const triggers = captureAndDropTriggers(database);
  try {
    for (const [id, role] of [
      [ids.managerUser, "manager"],
      [ids.commissionerUser, "commissioner"],
    ]) {
      insert(database, "users", {
        id,
        email_normalized: `${role}-${base}@example.test`,
        email_display: `${role}-${base}@example.test`,
        display_name: `${role} ${base}`,
        display_name_normalized: `${role} ${base}`,
        status: "active",
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
    }
    insert(database, "leagues", {
      id: ids.league,
      name: `FAD start ${base}`,
      name_normalized: `fad start ${base}`,
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
        id: ids.managerMembership,
        userId: ids.managerUser,
        permission: "manager",
      },
      {
        id: ids.commissionerMembership,
        userId: ids.commissionerUser,
        permission: "commissioner",
      },
    ]) {
      insert(database, "league_memberships", {
        id: membership.id,
        league_id: ids.league,
        user_id: membership.userId,
        permission_category: membership.permission,
        status: "active",
        joined_at_ms: 1,
        ended_at_ms: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
    }
    insert(database, "seasons", {
      id: ids.season,
      league_id: ids.league,
      label: `2026-27 ${base}`,
      nhl_season_key: `26${String(base).padStart(6, "0")}`,
      status: "active",
      regular_season_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
      regular_season_ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 180 * DAY_MS,
      fantasy_playoffs_start_at_ms:
        FIRST_MATCHUP_STARTS_AT_MS + 150 * DAY_MS,
      fantasy_playoffs_end_at_ms:
        FIRST_MATCHUP_STARTS_AT_MS + 180 * DAY_MS,
      free_agent_draft_completed_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    database.prepare(`
      UPDATE leagues
      SET commissioner_membership_id = ?, current_season_id = ?
      WHERE id = ?
    `).run(ids.commissionerMembership, ids.season, ids.league);
    insert(database, "teams", {
      id: ids.team,
      league_id: ids.league,
      name: `Team ${base}`,
      name_normalized: `team ${base}`,
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
      user_id: ids.managerUser,
      membership_id: ids.managerMembership,
      assigned_by_user_id: ids.commissionerUser,
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
      week_key: `week-${base}`,
      sequence: 1,
      starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
      baseline_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 1,
      locks_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 2,
      ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 7 * DAY_MS,
      rolls_over_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 7 * DAY_MS,
      status: "scheduled",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "free_agent_draft_readiness_operations", {
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
    });
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
      status: "rapid",
      setup_path: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      prior_season_rollover_id: null,
      no_draft_reason: "Focused immediate-start fixture.",
      opening_authority: "system",
      opened_at_ms: 1,
      help_opens_at_ms: 1,
      candidate_deadline_at_ms: ROLLOVER_OPENS_AT_MS,
      first_matchup_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
      deadline_locked_at_ms: ROLLOVER_OPENS_AT_MS,
      allocation_completed_at_ms: ROLLOVER_OPENS_AT_MS,
      completed_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: ROLLOVER_OPENS_AT_MS,
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
      opens_at_ms: ROLLOVER_OPENS_AT_MS,
      creation_cutoff_at_ms: CREATION_CUTOFF_AT_MS,
      rolls_over_at_ms: ROLLOVER_AT_MS,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "players", {
      id: ids.player,
      first_name: "Start",
      last_name: `Player ${base}`,
      full_name: `Start Player ${base}`,
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    const actorUserId = authority === "manager"
      ? ids.managerUser
      : ids.commissionerUser;
    const actorMembershipId = authority === "manager"
      ? ids.managerMembership
      : ids.commissionerMembership;
    insert(database, "auctions", {
      id: ids.auction,
      league_id: ids.league,
      season_id: ids.season,
      player_id: ids.player,
      status: "open",
      opened_at_ms: openedAtMs,
      resolves_at_ms: sourceKind === "ordinary_weekly"
        ? ROLLOVER_AT_MS
        : ROLLOVER_AT_MS,
      opened_by_user_id: actorUserId,
      created_at_ms: openedAtMs,
      updated_at_ms: openedAtMs,
      version: 1,
    });
    insert(database, "auction_contexts", {
      id: ids.auction,
      league_id: ids.league,
      season_id: ids.season,
      auction_id: ids.auction,
      source_kind: sourceKind,
      fad_id: sourceKind === "ordinary_weekly" ? null : ids.fad,
      fad_rollover_id:
        sourceKind === "ordinary_weekly" ? null : ids.rollover,
      fad_allocation_id: null,
      fad_origin: sourceKind === "ordinary_weekly" ? null : origin,
      created_at_ms: openedAtMs,
    });
    if (includeDraw) {
      const nonce = Buffer.alloc(32, base % 251);
      insert(database, "free_agent_draft_draws", {
        id: ids.draw,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        allocation_id: null,
        auction_id: ids.auction,
        algorithm_version: 1,
        nonce_bytes: nonce,
        commitment_hex: sha256(nonce),
        ordered_tied_bid_ids_json: null,
        ordered_tied_team_ids_json: null,
        rejection_counter: null,
        selected_index: null,
        selected_bid_id: null,
        selected_team_id: null,
        selected_digest_hex: null,
        revealed_at_ms: null,
        created_at_ms: openedAtMs,
        updated_at_ms: openedAtMs,
        version: 1,
      });
    }
    insert(database, "idempotency_requests", {
      id: ids.request,
      league_id: ids.league,
      actor_user_id: actorUserId,
      operation: requestOperation,
      client_key: `start-${base}`,
      request_hash: sha256(`request-${base}`),
      status: "started",
      result_type: null,
      result_id: null,
      created_at_ms: requestCreatedAtMs,
      completed_at_ms: null,
      expires_at_ms: requestExpiresAtMs,
    });
    if (includeJob) {
      insert(database, "job_runs", {
        id: ids.job,
        league_id: ids.league,
        season_id: ids.season,
        job_type: "auction.resolve.target",
        occurrence_key: `auction:${ids.auction}:${ROLLOVER_AT_MS}`,
        scheduled_for_ms: ROLLOVER_AT_MS,
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
        created_at_ms: openedAtMs,
        updated_at_ms: openedAtMs,
        version: 1,
      });
    }
    return Object.freeze({
      ...ids,
      actorUserId,
      actorMembershipId,
      authority,
      openedAtMs,
    });
  } finally {
    restoreTriggers(database, triggers);
  }
}

function insertStarter(database, fixture, {
  bidId = fixture.bid,
  firstSubmittedAtMs = fixture.openedAtMs,
  requestId = fixture.request,
} = {}) {
  insert(database, "auction_bids", {
    id: bidId,
    league_id: fixture.league,
    season_id: fixture.season,
    auction_id: fixture.auction,
    team_id: fixture.team,
    submitted_by_user_id: fixture.actorUserId,
    total_value_cents: 600,
    term_years: 2,
    lowest_offered_aav_cents: 300,
    first_submitted_at_ms: firstSubmittedAtMs,
    last_edited_at_ms: firstSubmittedAtMs,
    edit_count: 0,
    status: "active",
    idempotency_request_id: requestId,
    version: 1,
  });
}

function startedMetadata(fixture, overrides = {}) {
  return JSON.stringify({
    openingTeamId: fixture.team,
    actorMembershipId: fixture.actorMembershipId,
    actorAuthority: fixture.authority,
    playerPosition: "F",
    creationCutoffAtMs: CREATION_CUTOFF_AT_MS,
    bidClosesAtMs: ROLLOVER_AT_MS,
    totalValueCents: 600,
    termYears: 2,
    aavCents: 300,
    bindingIllegalityConfirmed: true,
    fadId: fixture.fad,
    fadRolloverId: fixture.rollover,
    ...overrides,
  });
}

function insertStartedEvent(database, fixture, overrides = {}) {
  insert(database, "auction_events", {
    id: fixture.event,
    league_id: fixture.league,
    season_id: fixture.season,
    auction_id: fixture.auction,
    bid_id: fixture.bid,
    team_id: fixture.team,
    actor_user_id: fixture.actorUserId,
    event_type: "auction_started",
    metadata_json: startedMetadata(fixture, overrides),
    occurred_at_ms: fixture.openedAtMs,
  });
}

function completeRequest(database, fixture) {
  return database.prepare(`
    UPDATE idempotency_requests
    SET status = 'completed',
        result_type = 'auction',
        result_id = @auctionId,
        completed_at_ms = @completedAtMs
    WHERE league_id = @leagueId
      AND id = @requestId
      AND status = 'started'
  `).run({
    leagueId: fixture.league,
    requestId: fixture.request,
    auctionId: fixture.auction,
    completedAtMs: fixture.openedAtMs,
  });
}

function commitStart(database, fixture, metadataOverrides = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    insertStarter(database, fixture);
    insertStartedEvent(database, fixture, metadataOverrides);
    assert.equal(completeRequest(database, fixture).changes, 1);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function assertHealthy(database) {
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(database.pragma("foreign_key_check"), []);
}

describe("FAD immediate auction-start migration 0044", () => {
  test("schema 43 rejects auction.start at the bid seam, then 0044 upgrades and completes the same exact manager start", (t) => {
    const migration44 = discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).find(({ id }) => id === 44);
    assert.ok(migration44);
    assert.equal(migration44.fileName, MIGRATION_0044.fileName);
    assert.equal(
      fs.statSync(migration44.filePath).size,
      MIGRATION_0044.byteLength
    );
    assert.equal(migration44.checksum, MIGRATION_0044.sha256);

    const runtime = createRuntime(
      t,
      43,
      "hundo-fad-immediate-start-upgrade-"
    );
    const fixture = seedFixture(runtime.database, 440_000);

    assert.throws(
      () => insertStarter(runtime.database, fixture),
      /FAD opening bid requires a current actor or exact queued acceptance/
    );
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) FROM auction_bids").pluck().get(),
      0
    );

    const upgraded = upgradeTo44(runtime);
    assert.equal(upgraded.userVersion, 44);
    assert.equal(upgraded.applied.at(-1).id, 44);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT migration_id, file_name, checksum
        FROM schema_migrations
        WHERE migration_id = 44
      `).get(),
      {
        migration_id: 44,
        file_name: MIGRATION_0044.fileName,
        checksum: MIGRATION_0044.sha256,
      }
    );
    commitStart(runtime.database, fixture);

    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, result_type, result_id, completed_at_ms
        FROM idempotency_requests
        WHERE id = ?
      `).get(fixture.request),
      {
        status: "completed",
        result_type: "auction",
        result_id: fixture.auction,
        completed_at_ms: fixture.openedAtMs,
      }
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT metadata_value FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).pluck().get(),
      "44"
    );
    assertHealthy(runtime.database);
  });

  test("fresh 0044 admits both exact manager and current-commissioner direct starters", (t) => {
    for (const [index, authority] of ["manager", "commissioner"].entries()) {
      const runtime = createRuntime(
        t,
        44,
        `hundo-fad-immediate-${authority}-`
      );
      const fixture = seedFixture(
        runtime.database,
        441_000 + index * 100,
        { authority }
      );
      commitStart(runtime.database, fixture);
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT event_type, actor_user_id
          FROM auction_events
          WHERE id = ?
        `).get(fixture.event),
        {
          event_type: "auction_started",
          actor_user_id: fixture.actorUserId,
        }
      );
      assertHealthy(runtime.database);
    }
  });

  test("rejects expired, cutoff, later, and non-manager-nomination uses of auction.start", (t) => {
    const cases = [
      {
        label: "expired",
        base: 442_000,
        mutate(database, fixture) {
          database.pragma("ignore_check_constraints = ON");
          database.prepare(`
            UPDATE idempotency_requests
            SET expires_at_ms = created_at_ms
            WHERE id = ?
          `).run(fixture.request);
          database.pragma("ignore_check_constraints = OFF");
        },
      },
      {
        label: "at-cutoff",
        base: 442_100,
        options: { openedAtMs: CREATION_CUTOFF_AT_MS },
      },
      {
        label: "later-bid",
        base: 442_200,
        options: {
          requestCreatedAtMs: OPENED_AT_MS + 1,
          requestExpiresAtMs: OPENED_AT_MS + DAY_MS,
        },
        bid: { firstSubmittedAtMs: OPENED_AT_MS + 1 },
      },
      {
        label: "queued-origin",
        base: 442_300,
        options: { origin: "queued_nomination" },
      },
    ];
    for (const scenario of cases) {
      const runtime = createRuntime(
        t,
        44,
        `hundo-fad-start-reject-${scenario.label}-`
      );
      const fixture = seedFixture(
        runtime.database,
        scenario.base,
        scenario.options
      );
      scenario.mutate?.(runtime.database, fixture);
      assert.throws(
        () => insertStarter(runtime.database, fixture, scenario.bid),
        /FAD opening bid requires a current actor or exact queued acceptance/
      );
      assert.equal(
        runtime.database.prepare("SELECT COUNT(*) FROM auction_bids").pluck().get(),
        0
      );
    }
  });

  test("rolls back bid and event when binding or canonical resolution-job completion evidence is missing", (t) => {
    for (const [index, variant] of ["binding", "job"].entries()) {
      const runtime = createRuntime(
        t,
        44,
        `hundo-fad-start-rollback-${variant}-`
      );
      const fixture = seedFixture(
        runtime.database,
        443_000 + index * 100,
        { includeJob: variant !== "job" }
      );
      assert.throws(
        () => commitStart(
          runtime.database,
          fixture,
          variant === "binding"
            ? { bindingIllegalityConfirmed: false }
            : {}
        ),
        /FAD immediate auction start must complete against exact private evidence/
      );
      assert.equal(
        runtime.database.prepare("SELECT COUNT(*) FROM auction_bids").pluck().get(),
        0
      );
      assert.equal(
        runtime.database.prepare("SELECT COUNT(*) FROM auction_events").pluck().get(),
        0
      );
      assert.deepEqual(
        runtime.database.prepare(`
          SELECT status, result_type, result_id, completed_at_ms
          FROM idempotency_requests WHERE id = ?
        `).get(fixture.request),
        {
          status: "started",
          result_type: null,
          result_id: null,
          completed_at_ms: null,
        }
      );
    }
  });

  test("makes the completed FAD direct-start backlink update/delete immutable", (t) => {
    const runtime = createRuntime(t, 44, "hundo-fad-start-immutable-");
    const fixture = seedFixture(runtime.database, 444_000);
    commitStart(runtime.database, fixture);
    assert.throws(
      () => runtime.database.prepare(`
        UPDATE idempotency_requests SET completed_at_ms = completed_at_ms + 1
        WHERE id = ?
      `).run(fixture.request),
      /FAD immediate auction start must complete against exact private evidence/
    );
    assert.throws(
      () => runtime.database.prepare(`
        DELETE FROM idempotency_requests WHERE id = ?
      `).run(fixture.request),
      /FAD immediate auction-start request evidence is immutable/
    );
    assertHealthy(runtime.database);
  });

  test("preserves ordinary inserts and existing auction.bid.put plus restricted/fallback/queued trigger branches", (t) => {
    const ordinary = createRuntime(t, 44, "hundo-fad-start-ordinary-");
    const ordinaryFixture = seedFixture(
      ordinary.database,
      445_000,
      {
        sourceKind: "ordinary_weekly",
        origin: null,
        requestOperation: "auction.bid.put",
      }
    );
    insertStarter(ordinary.database, ordinaryFixture);
    assert.equal(
      ordinary.database.prepare("SELECT COUNT(*) FROM auction_bids").pluck().get(),
      1
    );

    const interactive = createRuntime(t, 44, "hundo-fad-start-bid-put-");
    const interactiveFixture = seedFixture(
      interactive.database,
      445_100,
      {
        requestOperation: "auction.bid.put",
        requestCreatedAtMs: OPENED_AT_MS + 1,
        requestExpiresAtMs: OPENED_AT_MS + DAY_MS,
      }
    );
    insertStarter(interactive.database, interactiveFixture, {
      firstSubmittedAtMs: OPENED_AT_MS + 1,
    });
    assert.equal(
      interactive.database.prepare("SELECT COUNT(*) FROM auction_bids").pluck().get(),
      1
    );

    const triggerSql = interactive.database.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'trigger'
        AND name = 'auction_bids_require_context_insert'
    `).pluck().get();
    for (const preserved of [
      "auction.bid.put",
      "queued_nomination",
      "fad_queued_nomination_activation",
      "restricted bid must be an allowlisted strict improvement",
      "fallback bid cannot rank below its Candidate minimum",
    ]) {
      assert.match(triggerSql, new RegExp(preserved.replaceAll(".", "\\.")));
    }
    assertHealthy(ordinary.database);
    assertHealthy(interactive.database);
  });
});
