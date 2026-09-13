const assert = require("node:assert/strict");
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

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const CANONICAL_MIGRATIONS = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
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

function assertConstraint(callback, pattern) {
  assert.throws(callback, (error) => {
    return (
      error?.code?.startsWith("SQLITE_CONSTRAINT") &&
      (!pattern || pattern.test(error.message))
    );
  });
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    temporaryRoot,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
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
    if (migration.id < minimumId || migration.id > maximumId) {
      continue;
    }
    fs.copyFileSync(
      migration.filePath,
      path.join(runtime.migrationsDirectory, migration.fileName)
    );
  }
}

function migrate(runtime, buildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function schemaSql(database, type, name) {
  return database
    .prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = ?
        AND name = ?
    `)
    .get(type, name)?.sql;
}

function assertHealthy(database) {
  assert.deepEqual(
    database.prepare("PRAGMA foreign_key_check").all(),
    []
  );
  assert.deepEqual(
    database.prepare("PRAGMA integrity_check").all(),
    [{ integrity_check: "ok" }]
  );
}

function withoutTableTriggers(database, tableNames, callback) {
  const placeholders = tableNames.map(() => "?").join(", ");
  const triggers = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name IN (${placeholders})
      ORDER BY name
    `)
    .all(...tableNames);

  for (const trigger of triggers) {
    database.exec(
      `DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`
    );
  }
  try {
    callback();
  } finally {
    for (const trigger of triggers) {
      database.exec(trigger.sql);
    }
  }
}

function assertScheduleAuthorityGuard(sql, triggerName) {
  assert.ok(sql, triggerName);
  assert.match(
    sql,
    /NEW\.scheduled_by_authority\s*=\s*'commissioner'/
  );
  assert.match(
    sql,
    /leagues\.commissioner_membership_id\s*=\s*NEW\.scheduled_by_membership_id/
  );
  assert.match(
    sql,
    /NEW\.scheduled_by_authority\s*=\s*'platform_administrator_as_commissioner'/
  );
  assert.match(
    sql,
    /platform_roles\.user_id\s*=\s*NEW\.scheduled_by_user_id/
  );
  assert.match(
    sql,
    /platform_roles\.role\s*=\s*'platform_administrator'/
  );
  assert.match(
    sql,
    /platform_roles\.status\s*=\s*'active'/
  );
}

function seedOrdinaryAuction(database) {
  const ids = {
    league: uuid(1),
    season: uuid(2),
    player: uuid(3),
    auction: uuid(4),
    context: uuid(4),
  };

  withoutTableTriggers(
    database,
    [
      "leagues",
      "seasons",
      "players",
      "auctions",
      "auction_contexts",
    ],
    () => {
      insert(database, "leagues", {
        id: ids.league,
        name: "Ordinary Auction League",
        name_normalized: "ordinary auction league",
        status: "active",
        timezone: "America/Vancouver",
        commissioner_membership_id: null,
        current_season_id: null,
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      insert(database, "seasons", {
        id: ids.season,
        league_id: ids.league,
        label: "2026",
        nhl_season_key: "20262027",
        status: "active",
        regular_season_starts_at_ms: null,
        regular_season_ends_at_ms: null,
        fantasy_playoffs_start_at_ms: null,
        fantasy_playoffs_end_at_ms: null,
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
        free_agent_draft_completed_at_ms: null,
      });
      insert(database, "players", {
        id: ids.player,
        first_name: "Ordinary",
        last_name: "Player",
        full_name: "Ordinary Player",
        birth_date: null,
        status: "active",
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      insert(database, "auctions", {
        id: ids.auction,
        league_id: ids.league,
        season_id: ids.season,
        player_id: ids.player,
        status: "open",
        opened_at_ms: 100,
        resolves_at_ms: 200,
        opened_by_user_id: null,
        created_at_ms: 100,
        updated_at_ms: 100,
        version: 1,
      });
      insert(database, "auction_contexts", {
        id: ids.context,
        league_id: ids.league,
        season_id: ids.season,
        auction_id: ids.auction,
        source_kind: "ordinary_weekly",
        fad_id: null,
        fad_rollover_id: null,
        fad_allocation_id: null,
        created_at_ms: 100,
      });
    }
  );

  return ids;
}

function seedAuctionCommissioner(database, leagueId) {
  const ids = {
    user: uuid(80),
    membership: uuid(81),
  };

  withoutTableTriggers(
    database,
    ["users", "league_memberships", "leagues"],
    () => {
      insert(database, "users", {
        id: ids.user,
        email_normalized: "auction-admin@example.test",
        email_display: "auction-admin@example.test",
        display_name: "Auction Administrator",
        display_name_normalized: "auction administrator",
        status: "active",
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      insert(database, "league_memberships", {
        id: ids.membership,
        league_id: leagueId,
        user_id: ids.user,
        permission_category: "commissioner",
        status: "active",
        joined_at_ms: 10,
        ended_at_ms: null,
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      database
        .prepare(`
          UPDATE leagues
          SET commissioner_membership_id = ?
          WHERE id = ?
        `)
        .run(ids.membership, leagueId);
    }
  );

  return ids;
}

describe("locked Free Agent Draft decision-package migration", () => {
  test("installs the exact v2, schedule-authority, and bid guards", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0030-schema-");
    copyMigrations(runtime, 1, 30);
    migrate(runtime, "fad-0030-schema");

    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      30
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "30"
    );

    for (const tableName of [
      "season_matchup_schedule_generations",
      "entry_draft_rollover_bindings",
      "season_rollover_occurrences",
      "entry_draft_schedule_operations",
      "free_agent_draft_readiness_operations",
      "free_agent_draft_schedule_recoveries",
      "matchup_roster_game_exclusions",
      "player_game_stat_observations",
      "stat_refresh_player_game_sets",
    ]) {
      assert.ok(
        schemaSql(runtime.database, "table", tableName),
        tableName
      );
    }
    assert.ok(
      schemaSql(runtime.database, "view", "fad_frozen_eligible_bids")
    );
    assert.equal(
      schemaSql(
        runtime.database,
        "view",
        "fad_restricted_eligible_bids"
      ),
      undefined
    );

    const exemptionSql = schemaSql(
      runtime.database,
      "trigger",
      "fad_setup_exemptions_t037_evidence_insert"
    );
    assert.match(
      exemptionSql,
      /'league\.lifecycle\.transition\.v2'/
    );
    assert.doesNotMatch(
      exemptionSql,
      /'league\.lifecycle\.transition\.v1'/
    );
    for (const evidenceToken of [
      "2026-season-1-reset-v1",
      "migration_reports",
      "admin.league.bootstrap_reset_original.v1",
      "fad_setup_exemption_authorized",
      "fad.setup_exemption_authorized",
      "notifications",
      "outbox_event_audiences",
    ]) {
      assert.ok(exemptionSql.includes(evidenceToken), evidenceToken);
    }

    const lifecycleCompletionSql = schemaSql(
      runtime.database,
      "trigger",
      "idempotency_requests_lifecycle_v2_update"
    );
    assert.match(
      lifecycleCompletionSql,
      /NEW\.result_type\s*=\s*'free_agent_draft_setup_exemption'/
    );
    assert.match(
      lifecycleCompletionSql,
      /free_agent_draft_setup_exemptions\s*\.idempotency_request_id\s*=\s*NEW\.id/
    );

    for (const triggerName of [
      "entry_draft_rollover_bindings_valid_insert",
      "season_rollover_occurrences_valid_insert",
      "entry_draft_rollover_bindings_forward_update",
      "entry_draft_schedule_operations_valid_insert",
    ]) {
      assertScheduleAuthorityGuard(
        schemaSql(runtime.database, "trigger", triggerName),
        triggerName
      );
    }

    const bidUpdateSql = schemaSql(
      runtime.database,
      "trigger",
      "fad_auction_bids_forward_update"
    );
    const activeBidSql = bidUpdateSql.split(
      "NEW.status = 'withdrawn'"
    )[0];
    assert.match(
      activeBidSql,
      /NEW\.edit_count\s*=\s*OLD\.edit_count\s*\+\s*1/
    );
    assert.match(activeBidSql, /fad_open_rapid/);
    assert.match(activeBidSql, /OLD\.first_submitted_at_ms/);
    assert.match(activeBidSql, /auctions\.opened_at_ms/);
    assert.match(activeBidSql, /THEN\s+2\s+ELSE\s+1\s+END/);
    assert.match(activeBidSql, /manager_edit_limit/);
    assert.match(
      activeBidSql,
      /OLD\.last_edited_at_ms\s*\+\s*4500000/
    );
    assert.match(activeBidSql, /team_manager_assignments/);
    assert.match(
      activeBidSql,
      /NEW\.edit_count\s*=\s*OLD\.edit_count(?!\s*\+)/
    );
    assert.match(activeBidSql, /platform_roles/);
    assert.doesNotMatch(activeBidSql, /commissioner_bid_removed/);
    assert.match(bidUpdateSql, /commissioner_bid_removed/);
    assert.match(
      bidUpdateSql,
      /attributable commissioner removal/
    );

    assertHealthy(runtime.database);
  });

  test("accepts v2 setup authority before enforcing later evidence", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0030-exemption-");
    copyMigrations(runtime, 1, 30);
    migrate(runtime, "fad-0030-exemption");

    const ids = {
      user: uuid(20),
      league: uuid(21),
      membership: uuid(22),
      platformRole: uuid(23),
      request: uuid(24),
      exemption: uuid(25),
      season: uuid(26),
      migrationReport: uuid(27),
      bootstrapRequest: uuid(28),
      bootstrapActivity: uuid(29),
      bootstrapAudit: uuid(30),
      authorizationActivity: uuid(31),
      authorizationAudit: uuid(32),
      notification: uuid(33),
      outbox: uuid(34),
    };

    insert(runtime.database, "users", {
      id: ids.user,
      email_normalized: "fad-v2@example.test",
      email_display: "fad-v2@example.test",
      display_name: "FAD V2 Administrator",
      display_name_normalized: "fad v2 administrator",
      status: "active",
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
    insert(runtime.database, "leagues", {
      id: ids.league,
      name: "FAD V2 League",
      name_normalized: "fad v2 league",
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
    insert(runtime.database, "league_memberships", {
      id: ids.membership,
      league_id: ids.league,
      user_id: ids.user,
      permission_category: "commissioner",
      status: "active",
      joined_at_ms: 10,
      ended_at_ms: null,
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
    insert(runtime.database, "platform_roles", {
      id: ids.platformRole,
      user_id: ids.user,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: ids.user,
      granted_at_ms: 10,
      ended_at_ms: null,
      version: 1,
    });
    insert(runtime.database, "idempotency_requests", {
      id: ids.request,
      league_id: ids.league,
      actor_user_id: ids.user,
      operation: "league.lifecycle.transition.v2",
      client_key: "setup-exemption-v2",
      request_hash: "a".repeat(64),
      status: "started",
      result_type: null,
      result_id: null,
      created_at_ms: 20,
      completed_at_ms: null,
      expires_at_ms: 1_000,
    });

    assertConstraint(
      () =>
        insert(runtime.database, "free_agent_draft_setup_exemptions", {
          id: ids.exemption,
          league_id: ids.league,
          season_id: ids.season,
          exemption_kind: "initial_season2_transition",
          migration_report_id: ids.migrationReport,
          reason: "Locked reset transition",
          authorized_by_user_id: ids.user,
          authorized_by_membership_id: ids.membership,
          authorized_authority:
            "platform_administrator_as_commissioner",
          authorized_at_ms: 20,
          consumed_fad_id: null,
          consumed_at_ms: null,
          created_at_ms: 20,
          updated_at_ms: 20,
          version: 1,
          idempotency_request_id: ids.request,
          migration_report_sha256: "b".repeat(64),
          bootstrap_identity_sha256: "c".repeat(64),
          bootstrap_idempotency_request_id:
            ids.bootstrapRequest,
          bootstrap_activity_id: ids.bootstrapActivity,
          bootstrap_security_audit_event_id:
            ids.bootstrapAudit,
          bootstrap_actor_user_id: ids.user,
          authorization_activity_id:
            ids.authorizationActivity,
          authorization_security_audit_event_id:
            ids.authorizationAudit,
          commissioner_notification_id: ids.notification,
          outbox_event_id: ids.outbox,
        }),
      /target is not the reset Season 2/
    );

    assertHealthy(runtime.database);
  });

  test("upgrades a schema-22 database through migration 0030", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0030-upgrade-");
    copyMigrations(runtime, 1, 22);
    migrate(runtime, "fad-0030-schema-22");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      22
    );

    copyMigrations(runtime, 23, 30);
    migrate(runtime, "fad-0030-upgrade");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      30
    );
    assertHealthy(runtime.database);
  });

  test("refuses to reinterpret pre-amendment FAD business rows", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0030-guard-");
    copyMigrations(runtime, 1, 29);
    migrate(runtime, "fad-0030-pre-amendment");

    withoutTableTriggers(runtime.database, ["job_runs"], () => {
      insert(runtime.database, "job_runs", {
        id: uuid(40),
        league_id: null,
        season_id: null,
        job_type: "free_agent_draft_guard_probe",
        occurrence_key: "guard-probe",
        scheduled_for_ms: 100,
        status: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at_ms: null,
        started_at_ms: null,
        completed_at_ms: null,
        result_json: null,
        last_error_code: null,
        created_at_ms: 100,
        updated_at_ms: 100,
        version: 1,
        lease_token: null,
        next_attempt_at_ms: null,
      });
    });

    copyMigrations(runtime, 30, 30);
    assert.throws(
      () => migrate(runtime, "fad-0030-must-refuse"),
      (error) =>
        /business_row_count = 0/.test(error.message) ||
        /business_row_count = 0/.test(error.cause?.message ?? "")
    );
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      29
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM job_runs")
        .get().count,
      1
    );
  });

  test("requires and permanently binds immutable auction administration results", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-0030-auction-admin-replay-"
    );
    copyMigrations(runtime, 1, 30);
    migrate(runtime, "fad-0030-auction-admin-replay");

    const auctionIds = seedOrdinaryAuction(runtime.database);
    const actorIds = seedAuctionCommissioner(
      runtime.database,
      auctionIds.league
    );

    for (const [offset, operation] of [
      [0, "auction.bid.remove"],
      [1, "auction.cancel"],
      [2, "auction.resolve.request"],
      [3, "unrelated.operation"],
    ]) {
      const requestId = uuid(90 + offset);
      insert(runtime.database, "idempotency_requests", {
        id: requestId,
        league_id: auctionIds.league,
        actor_user_id: actorIds.user,
        operation,
        client_key: `missing-result-${offset}`,
        request_hash: String(offset + 1).repeat(64),
        status: "started",
        result_type: null,
        result_id: null,
        created_at_ms: 120 + offset,
        completed_at_ms: null,
        expires_at_ms: 1_000,
      });

      assertConstraint(
        () =>
          runtime.database
            .prepare(`
              UPDATE idempotency_requests
              SET status = 'completed',
                  result_type =
                    'auction_administration_command_result',
                  result_id = ?,
                  completed_at_ms = ?
              WHERE id = ?
            `)
            .run(uuid(100 + offset), 120 + offset, requestId),
        /requires its exact immutable result/
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM idempotency_requests
            WHERE id = ?
          `)
          .get(requestId).status,
        "started"
      );
    }

    const requestId = uuid(110);
    const resultId = uuid(111);
    const occurredAtMs = 150;
    const requestSha256 = "a".repeat(64);
    insert(runtime.database, "idempotency_requests", {
      id: requestId,
      league_id: auctionIds.league,
      actor_user_id: actorIds.user,
      operation: "auction.cancel",
      client_key: "valid-cancel-result",
      request_hash: requestSha256,
      status: "started",
      result_type: null,
      result_id: null,
      created_at_ms: occurredAtMs,
      completed_at_ms: null,
      expires_at_ms: 1_000,
    });
    runtime.database
      .prepare(`
        UPDATE auctions
        SET status = 'cancelled',
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
          AND version = 1
      `)
      .run(occurredAtMs, auctionIds.auction);
    const administrationResult = {
      id: resultId,
      league_id: auctionIds.league,
      season_id: auctionIds.season,
      auction_id: auctionIds.auction,
      bid_id: null,
      idempotency_request_id: requestId,
      job_run_id: null,
      action: "cancel_auction",
      actor_user_id: actorIds.user,
      actor_membership_id: actorIds.membership,
      actor_authority: "commissioner",
      request_sha256: requestSha256,
      precondition_kind: "auction",
      expected_resource_version: 1,
      resulting_resource_version: 2,
      response_http_status: 200,
      response_json: JSON.stringify({
        auctionId: auctionIds.auction,
        version: 2,
      }),
      response_sha256: "b".repeat(64),
      created_at_ms: occurredAtMs,
      version: 1,
    };
    assertConstraint(
      () =>
        insert(
          runtime.database,
          "auction_administration_command_results",
          {
            ...administrationResult,
            precondition_kind: "bid",
          }
        ),
      /CHECK constraint failed/
    );
    insert(
      runtime.database,
      "auction_administration_command_results",
      administrationResult
    );
    assert.equal(
      runtime.database
        .prepare(`
          UPDATE idempotency_requests
          SET status = 'completed',
              result_type =
                'auction_administration_command_result',
              result_id = ?,
              completed_at_ms = ?
          WHERE id = ?
        `)
        .run(resultId, occurredAtMs, requestId).changes,
      1
    );

    assertConstraint(
      () =>
        runtime.database
          .prepare(`
            UPDATE idempotency_requests
            SET client_key = 'rewritten-result'
            WHERE id = ?
          `)
          .run(requestId),
      /completed auction administration request evidence is immutable/
    );
    assertConstraint(
      () =>
        runtime.database
          .prepare(
            "DELETE FROM idempotency_requests WHERE id = ?"
          )
          .run(requestId),
      /auction administration result request evidence is immutable/
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            status,
            result_type,
            result_id,
            completed_at_ms
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(requestId),
      {
        status: "completed",
        result_type: "auction_administration_command_result",
        result_id: resultId,
        completed_at_ms: occurredAtMs,
      }
    );
    assertHealthy(runtime.database);
  });

  test("preserves ordinary weekly auction contexts exactly", (t) => {
    const runtime = createRuntime(t, "hundo-fad-0030-ordinary-");
    copyMigrations(runtime, 1, 29);
    migrate(runtime, "fad-0030-before-ordinary");
    const ids = seedOrdinaryAuction(runtime.database);
    const before = runtime.database
      .prepare("SELECT * FROM auction_contexts WHERE id = ?")
      .get(ids.context);

    copyMigrations(runtime, 30, 30);
    migrate(runtime, "fad-0030-preserve-ordinary");

    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      30
    );
    const after = runtime.database
      .prepare("SELECT * FROM auction_contexts WHERE id = ?")
      .get(ids.context);
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(before).map((column) => [column, after[column]])
      ),
      before
    );
    assert.equal(after.fad_origin, null);
    assertHealthy(runtime.database);
  });
});
