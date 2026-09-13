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

const HISTORY_TABLES = Object.freeze([
  "free_agent_draft_allocation_events",
  "free_agent_draft_player_allocations",
  "auction_resolutions",
]);

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

function withoutInsertValidationTriggers(
  database,
  tableNames,
  callback
) {
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

function foreignKeys(database, tableName) {
  return database
    .prepare(`PRAGMA foreign_key_list("${tableName}")`)
    .all()
    .map((row) => ({
      from: row.from,
      table: row.table,
      to: row.to,
      onDelete: row.on_delete,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
}

function ownedSchemaObjects(database, tableName) {
  return database
    .prepare(`
      SELECT type, name, sql
      FROM sqlite_schema
      WHERE tbl_name = ?
        AND type IN ('index', 'trigger')
        AND sql IS NOT NULL
      ORDER BY type, name
    `)
    .all(tableName);
}

function seedPopulatedOwnershipHistory(database) {
  const ids = {
    user: uuid(1),
    league: uuid(2),
    membership: uuid(3),
    season: uuid(4),
    team: uuid(5),
    player: uuid(6),
    ownership: uuid(7),
    week: uuid(8),
    fad: uuid(9),
    allocation: uuid(10),
    allocationEvent: uuid(11),
    auction: uuid(12),
    resolution: uuid(13),
  };
  const firstMatchupStartsAtMs = 1_000_000_000;
  const candidateDeadlineAtMs =
    firstMatchupStartsAtMs - 604_800_000;
  const helpOpensAtMs = candidateDeadlineAtMs - 172_800_000;

  withoutInsertValidationTriggers(
    database,
    [
      "users",
      "leagues",
      "seasons",
      "league_memberships",
      "teams",
      "players",
      "player_ownerships",
      "matchup_weeks",
      "free_agent_drafts",
      "free_agent_draft_player_allocations",
      "free_agent_draft_allocation_events",
      "auctions",
      "auction_resolutions",
    ],
    () => {
      insert(database, "users", {
        id: ids.user,
        email_normalized: "legacy@example.test",
        email_display: "legacy@example.test",
        display_name: "Legacy Manager",
        display_name_normalized: "legacy manager",
        status: "active",
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      insert(database, "leagues", {
        id: ids.league,
        name: "Legacy League",
        name_normalized: "legacy league",
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
        regular_season_starts_at_ms: 900_000_000,
        regular_season_ends_at_ms: 2_000_000_000,
        fantasy_playoffs_start_at_ms: 1_997_580_800,
        fantasy_playoffs_end_at_ms: 2_000_000_000,
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      insert(database, "league_memberships", {
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
      insert(database, "teams", {
        id: ids.team,
        league_id: ids.league,
        name: "Legacy Team",
        name_normalized: "legacy team",
        status: "active",
        primary_colour: null,
        secondary_colour: null,
        logo_reference: null,
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      insert(database, "players", {
        id: ids.player,
        first_name: "Legacy",
        last_name: "Player",
        full_name: "Legacy Player",
        birth_date: null,
        status: "active",
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      insert(database, "player_ownerships", {
        id: ids.ownership,
        league_id: ids.league,
        season_id: ids.season,
        player_id: ids.player,
        team_id: ids.team,
        ownership_kind: "Rostered",
        roster_category: "Prospect",
        position_group: "F",
        slot_number: null,
        acquired_transaction_type: "legacy_import",
        acquired_transaction_id: null,
        created_at_ms: 20,
        updated_at_ms: 20,
        version: 1,
      });
      insert(database, "matchup_weeks", {
        id: ids.week,
        league_id: ids.league,
        season_id: ids.season,
        week_key: "2026-W01",
        sequence: 1,
        starts_at_ms: firstMatchupStartsAtMs,
        baseline_at_ms: firstMatchupStartsAtMs,
        locks_at_ms: firstMatchupStartsAtMs + 100,
        ends_at_ms: firstMatchupStartsAtMs + 200,
        rolls_over_at_ms: firstMatchupStartsAtMs + 200,
        status: "scheduled",
        created_at_ms: 20,
        updated_at_ms: 20,
        version: 1,
      });
      insert(database, "free_agent_drafts", {
        id: ids.fad,
        league_id: ids.league,
        season_id: ids.season,
        first_matchup_week_id: ids.week,
        participating_team_count: 1,
        status: "cards_open",
        setup_path: "no_draft_inaugural",
        entry_draft_id: null,
        setup_exemption_id: null,
        prior_season_rollover_id: null,
        no_draft_reason: "Legacy fixture",
        opened_by_user_id: ids.user,
        opened_by_membership_id: ids.membership,
        opened_authority: "commissioner",
        opened_at_ms: 100,
        help_opens_at_ms: helpOpensAtMs,
        candidate_deadline_at_ms: candidateDeadlineAtMs,
        first_matchup_starts_at_ms: firstMatchupStartsAtMs,
        deadline_locked_at_ms: null,
        allocation_completed_at_ms: null,
        completed_at_ms: null,
        created_at_ms: 100,
        updated_at_ms: 100,
        version: 1,
      });
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
        resolved_at_ms: null,
        last_error_code: null,
        created_at_ms: 200,
        updated_at_ms: 200,
        version: 1,
      });
      insert(database, "free_agent_draft_allocation_events", {
        id: ids.allocationEvent,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        allocation_id: ids.allocation,
        allocation_version: 1,
        player_id: ids.player,
        event_kind: "decision_recorded",
        snapshot_entry_id: null,
        team_id: null,
        offer_valid: null,
        rank_position: null,
        offer_outcome_code: null,
        decision_code: "no_valid_offer",
        resulting_allocation_status: "pending",
        contract_id: null,
        ownership_id: ids.ownership,
        auction_id: null,
        activity_id: null,
        correction_id: null,
        actor_user_id: null,
        actor_membership_id: null,
        actor_authority: "system",
        evidence_json: "{}",
        occurred_at_ms: 210,
        created_at_ms: 210,
      });
      insert(database, "auctions", {
        id: ids.auction,
        league_id: ids.league,
        season_id: ids.season,
        player_id: ids.player,
        status: "no_winner",
        opened_at_ms: 200,
        resolves_at_ms: 300,
        opened_by_user_id: ids.user,
        created_at_ms: 200,
        updated_at_ms: 300,
        version: 2,
      });
      insert(database, "auction_resolutions", {
        id: ids.resolution,
        league_id: ids.league,
        season_id: ids.season,
        auction_id: ids.auction,
        scheduled_occurrence_key: "legacy-auction-resolution",
        outcome_code: "no_winner",
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
        ownership_id: ids.ownership,
        trigger_type: "automatic",
        triggered_by_user_id: null,
        idempotency_key: "legacy-auction-resolution",
        status: "no_winner",
        resolved_at_ms: 300,
      });
    }
  );

  return ids;
}

describe("T-037 lifecycle evidence migration", () => {
  test("upgrades populated histories without making live ownership their parent", (t) => {
    const runtime = createRuntime(t, "hundo-t037-populated-");
    copyMigrations(runtime, 1, 28);
    migrate(runtime, "before-t037");

    const ids = seedPopulatedOwnershipHistory(runtime.database);
    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );

    const rowsBefore = Object.fromEntries(
      HISTORY_TABLES.map((tableName) => [
        tableName,
        runtime.database
          .prepare(`SELECT * FROM ${tableName} ORDER BY id`)
          .all(),
      ])
    );
    const objectsBefore = Object.fromEntries(
      HISTORY_TABLES.map((tableName) => [
        tableName,
        ownedSchemaObjects(runtime.database, tableName),
      ])
    );
    const foreignKeysBefore = Object.fromEntries(
      HISTORY_TABLES.map((tableName) => [
        tableName,
        foreignKeys(runtime.database, tableName),
      ])
    );
    for (const tableName of HISTORY_TABLES) {
      assert.ok(
        foreignKeysBefore[tableName].some(
          (foreignKey) =>
            foreignKey.from === "ownership_id" &&
            foreignKey.table === "player_ownerships"
        )
      );
    }

    copyMigrations(runtime, 29, 29);
    migrate(runtime, "after-t037");

    for (const tableName of HISTORY_TABLES) {
      assert.deepEqual(
        runtime.database
          .prepare(`SELECT * FROM ${tableName} ORDER BY id`)
          .all(),
        rowsBefore[tableName]
      );
      assert.deepEqual(
        ownedSchemaObjects(runtime.database, tableName),
        objectsBefore[tableName]
      );
      assert.deepEqual(
        foreignKeys(runtime.database, tableName),
        foreignKeysBefore[tableName].filter(
          (foreignKey) =>
            foreignKey.table !== "player_ownerships"
        )
      );
    }

    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "29"
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'trigger'
            AND name IN (
              'player_ownerships_kind_category_insert_0029',
              'player_ownerships_kind_category_update_0029'
            )
        `)
        .get().count,
      0
    );

    assert.equal(
      runtime.database
        .prepare(`
          UPDATE player_ownerships
          SET updated_at_ms = updated_at_ms + 1,
              version = version + 1
          WHERE id = ?
        `)
        .run(ids.ownership).changes,
      1
    );
    assert.equal(
      runtime.database
        .prepare("DELETE FROM player_ownerships WHERE id = ?")
        .run(ids.ownership).changes,
      1
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT ownership_id
          FROM free_agent_draft_allocation_events
          WHERE id = ?
        `)
        .get(ids.allocationEvent).ownership_id,
      ids.ownership
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT ownership_id
          FROM auction_resolutions
          WHERE id = ?
        `)
        .get(ids.resolution).ownership_id,
      ids.ownership
    );
    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );
    assert.deepEqual(
      runtime.database.prepare("PRAGMA integrity_check").all(),
      [{ integrity_check: "ok" }]
    );
  });

  test("installs closed lifecycle evidence and completion-last guards", (t) => {
    const runtime = createRuntime(t, "hundo-t037-schema-");
    copyMigrations(runtime, 1, 29);
    migrate(runtime, "t037-schema");

    const expectedColumns = [
      "idempotency_request_id",
      "source_fad_id",
      "source_finalization_root_id",
      "source_finalization_id",
      "source_standings_snapshot_id",
      "source_standings_operation_id",
      "source_readiness_json",
      "source_readiness_schema_version",
      "source_readiness_sha256",
      "aggregate_activity_id",
      "security_audit_event_id",
      "outbox_event_id",
      "manifest_schema_version",
      "manifest_sha256",
    ];
    const rolloverColumns = new Set(
      runtime.database
        .prepare("PRAGMA table_info(season_rollovers)")
        .all()
        .map((column) => column.name)
    );
    for (const columnName of expectedColumns) {
      assert.ok(rolloverColumns.has(columnName), columnName);
    }

    const expectedTriggers = [
      "season_rollovers_t037_evidence_insert",
      "season_rollover_items_shape_insert",
      "season_rollover_items_immutable_update",
      "season_rollover_items_immutable_delete",
      "idempotency_requests_lifecycle_insert_0029",
      "idempotency_requests_lifecycle_update_0029",
      "idempotency_requests_lifecycle_complete_0029",
      "idempotency_requests_lifecycle_delete_0029",
      "outbox_events_lifecycle_evidence_update_0029",
      "notifications_exemption_evidence_update_0029",
      "trade_assets_rollover_evidence_update_0029",
    ];
    const installedTriggers = new Set(
      runtime.database
        .prepare(`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'trigger'
        `)
        .all()
        .map((trigger) => trigger.name)
    );
    for (const triggerName of expectedTriggers) {
      assert.ok(installedTriggers.has(triggerName), triggerName);
    }

    const rootTriggerSql = runtime.database
      .prepare(`
        SELECT sql
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND name = 'season_rollovers_t037_evidence_insert'
      `)
      .get().sql;
    assert.match(rootTriggerSql, /WITH RECURSIVE finalization_lineage/);
    assert.match(rootTriggerSql, /regular_season_completion/);
    assert.match(rootTriggerSql, /finalize_regular_season/);
    assert.match(rootTriggerSql, /result_correction/);
    assert.match(rootTriggerSql, /correction_propagation/);

    insert(runtime.database, "users", {
      id: uuid(100),
      email_normalized: "lifecycle@example.test",
      email_display: "lifecycle@example.test",
      display_name: "Lifecycle Actor",
      display_name_normalized: "lifecycle actor",
      status: "active",
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
    insert(runtime.database, "leagues", {
      id: uuid(101),
      name: "Lifecycle League",
      name_normalized: "lifecycle league",
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });

    assertConstraint(
      () =>
        insert(runtime.database, "idempotency_requests", {
          id: uuid(102),
          league_id: uuid(101),
          actor_user_id: uuid(100),
          operation: "league.lifecycle.transition.v1",
          client_key: "invalid-completed",
          request_hash: "a".repeat(64),
          status: "completed",
          result_type: "season_rollover",
          result_id: uuid(103),
          created_at_ms: 20,
          completed_at_ms: 20,
          expires_at_ms: 1_000,
        }),
      /must begin started/
    );

    insert(runtime.database, "idempotency_requests", {
      id: uuid(104),
      league_id: uuid(101),
      actor_user_id: uuid(100),
      operation: "league.lifecycle.transition.v1",
      client_key: "missing-result-evidence",
      request_hash: "b".repeat(64),
      status: "started",
      result_type: null,
      result_id: null,
      created_at_ms: 20,
      completed_at_ms: null,
      expires_at_ms: 1_000,
    });
    assertConstraint(
      () =>
        runtime.database
          .prepare(`
            UPDATE idempotency_requests
            SET status = 'completed',
                result_type = 'season_rollover',
                result_id = ?,
                completed_at_ms = 30
            WHERE id = ?
          `)
          .run(uuid(105), uuid(104)),
      /completion is inconsistent/
    );

    assert.deepEqual(
      runtime.database.prepare("PRAGMA foreign_key_check").all(),
      []
    );
    assert.deepEqual(
      runtime.database.prepare("PRAGMA integrity_check").all(),
      [{ integrity_check: "ok" }]
    );
  });
});
