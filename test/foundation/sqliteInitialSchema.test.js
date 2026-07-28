const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  discoverMigrations,
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);

const EXPECTED_TABLES = [
  "account_action_tokens",
  "account_events",
  "administrator_requests",
  "application_metadata",
  "auction_bids",
  "auction_events",
  "auction_resolutions",
  "auctions",
  "authentication_rate_limits",
  "backup_catalog",
  "buyout_obligations",
  "buyout_years",
  "commissioner_corrections",
  "contract_events",
  "contract_years",
  "contracts",
  "draft_eligibility_snapshots",
  "draft_eligible_players",
  "draft_events",
  "draft_lottery_results",
  "draft_lottery_runs",
  "draft_pick_ownership_events",
  "draft_picks",
  "draft_queue_items",
  "draft_selections",
  "entry_drafts",
  "future_considerations",
  "idempotency_requests",
  "job_runs",
  "league_activity",
  "league_freezes",
  "league_invitations",
  "league_memberships",
  "league_player_positions",
  "league_settings",
  "leagues",
  "matchup_byes",
  "matchup_operations",
  "matchup_result_versions",
  "matchup_results",
  "matchup_roster_locks",
  "matchup_roster_players",
  "matchup_weeks",
  "matchups",
  "migration_reports",
  "notifications",
  "operational_events",
  "outbox_events",
  "ownership_events",
  "platform_roles",
  "player_external_ids",
  "player_names",
  "player_ownerships",
  "player_source_state",
  "player_stat_totals",
  "players",
  "retention_obligations",
  "retention_years",
  "roster_display_order_entries",
  "roster_display_order_sets",
  "schema_migrations",
  "seasons",
  "security_audit_events",
  "sessions",
  "standings_operations",
  "standings_rows",
  "standings_snapshots",
  "stat_refreshes",
  "stat_snapshot_players",
  "stat_snapshots",
  "stat_sources",
  "team_events",
  "team_logo_objects",
  "team_manager_assignments",
  "teams",
  "trade_assets",
  "trade_events",
  "trades",
  "user_credentials",
  "users",
];

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  const placeholders = columns.map((column) => `@${column}`);
  database
    .prepare(
      `INSERT INTO ${tableName} (${columns.join(
        ", "
      )}) VALUES (${placeholders.join(", ")})`
    )
    .run(values);
}

function assertConstraint(callback, messagePattern) {
  assert.throws(callback, (error) => {
    const isConstraint = error?.code?.startsWith(
      "SQLITE_CONSTRAINT"
    );
    return (
      isConstraint &&
      (!messagePattern || messagePattern.test(error.message))
    );
  });
}

function createMigratedDatabase(
  t,
  prefix,
  migrationsDirectory = MIGRATIONS_DIRECTORY
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "schema.sqlite3"),
    environment: "test",
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const result = migrateDatabase({
    database: connection.database,
    migrationsDirectory,
    applicationBuildId: "m2-04-schema-test",
  });

  return {
    ...connection,
    migrationResult: result,
    temporaryRoot,
  };
}

function seedBase(database) {
  const ids = {
    userA: uuid(1),
    userB: uuid(2),
    userC: uuid(3),
    leagueA: uuid(10),
    leagueB: uuid(11),
    seasonA: uuid(20),
    seasonB: uuid(21),
    membershipA: uuid(30),
    membershipB: uuid(31),
    teamA1: uuid(40),
    teamA2: uuid(41),
    teamA3: uuid(42),
    teamA4: uuid(43),
    teamB1: uuid(44),
    teamB2: uuid(45),
    player1: uuid(50),
    player2: uuid(51),
    player3: uuid(52),
    player4: uuid(53),
    player5: uuid(54),
    player6: uuid(55),
    player7: uuid(56),
    player8: uuid(57),
  };

  [
    [ids.userA, "a@example.test", "Alpha"],
    [ids.userB, "b@example.test", "Bravo"],
    [ids.userC, "c@example.test", "Charlie"],
  ].forEach(([id, email, displayName]) => {
    insert(database, "users", {
      id,
      email_normalized: email,
      email_display: email,
      display_name: displayName,
      display_name_normalized: displayName.toLowerCase(),
      status: "active",
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
  });

  [
    [ids.leagueA, "League Alpha", "league alpha"],
    [ids.leagueB, "League Bravo", "league bravo"],
  ].forEach(([id, name, normalizedName]) => {
    insert(database, "leagues", {
      id,
      name,
      name_normalized: normalizedName,
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
  });

  [
    [ids.seasonA, ids.leagueA, "Season A", "2026A"],
    [ids.seasonB, ids.leagueB, "Season B", "2026B"],
  ].forEach(([id, leagueId, label, seasonKey]) => {
    insert(database, "seasons", {
      id,
      league_id: leagueId,
      label,
      nhl_season_key: seasonKey,
      status: "planned",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
  });

  [
    [
      ids.membershipA,
      ids.leagueA,
      ids.userA,
      "commissioner",
    ],
    [ids.membershipB, ids.leagueB, ids.userB, "commissioner"],
  ].forEach(([id, leagueId, userId, permissionCategory]) => {
    insert(database, "league_memberships", {
      id,
      league_id: leagueId,
      user_id: userId,
      permission_category: permissionCategory,
      status: "active",
      joined_at_ms: 1_000,
      ended_at_ms: null,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
  });

  [
    [ids.teamA1, ids.leagueA, "Alpha One", "alpha one"],
    [ids.teamA2, ids.leagueA, "Alpha Two", "alpha two"],
    [ids.teamA3, ids.leagueA, "Alpha Three", "alpha three"],
    [ids.teamA4, ids.leagueA, "Alpha Four", "alpha four"],
    [ids.teamB1, ids.leagueB, "Bravo One", "bravo one"],
    [ids.teamB2, ids.leagueB, "Bravo Two", "bravo two"],
  ].forEach(([id, leagueId, name, normalizedName]) => {
    insert(database, "teams", {
      id,
      league_id: leagueId,
      name,
      name_normalized: normalizedName,
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
  });

  Object.entries(ids)
    .filter(([key]) => key.startsWith("player"))
    .forEach(([key, id], index) => {
      insert(database, "players", {
        id,
        first_name: "Player",
        last_name: String(index + 1),
        full_name: `Player ${index + 1}`,
        birth_date: null,
        status: "active",
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });

  return ids;
}

function ownershipValues(ids, overrides = {}) {
  return {
    id: uuid(100),
    league_id: ids.leagueA,
    season_id: ids.seasonA,
    player_id: ids.player1,
    team_id: ids.teamA1,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "migration",
    acquired_transaction_id: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function contractValues(ids, overrides = {}) {
  return {
    id: uuid(110),
    league_id: ids.leagueA,
    player_id: ids.player1,
    current_team_id: ids.teamA1,
    contract_type: "normal",
    original_total_value_cents: 3_000,
    original_term_years: 3,
    aav_cents: 1_000,
    start_season_id: ids.seasonA,
    status: "active",
    acquisition_source_type: "migration",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function tradeValues(ids, overrides = {}) {
  return {
    id: uuid(120),
    league_id: ids.leagueA,
    season_id: ids.seasonA,
    proposing_team_id: ids.teamA1,
    receiving_team_id: ids.teamA2,
    proposing_user_id: ids.userA,
    status: "proposed",
    created_at_ms: 1_000,
    expires_at_ms: 2_000,
    responded_at_ms: null,
    completed_at_ms: null,
    commissioner_completion_reference: null,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function draftValues(ids, overrides = {}) {
  return {
    id: uuid(130),
    league_id: ids.leagueA,
    season_id: ids.seasonA,
    status: "setup",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: null,
    completed_at_ms: null,
    created_by_user_id: ids.userA,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function draftPickValues(ids, overrides = {}) {
  return {
    id: uuid(131),
    league_id: ids.leagueA,
    draft_id: uuid(130),
    target_season_id: ids.seasonA,
    round_number: 1,
    position_number: 1,
    original_team_id: ids.teamA1,
    current_owner_team_id: ids.teamA1,
    status: "unused",
    selection_id: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function matchupWeekValues(ids, overrides = {}) {
  return {
    id: uuid(140),
    league_id: ids.leagueA,
    season_id: ids.seasonA,
    week_key: "week-1",
    sequence: 1,
    starts_at_ms: 1_000,
    baseline_at_ms: 1_100,
    locks_at_ms: 1_200,
    ends_at_ms: 2_000,
    rolls_over_at_ms: 2_100,
    status: "scheduled",
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function matchupValues(ids, overrides = {}) {
  return {
    id: uuid(141),
    league_id: ids.leagueA,
    season_id: ids.seasonA,
    matchup_week_id: uuid(140),
    home_team_id: ids.teamA1,
    away_team_id: ids.teamA2,
    home_team_name: "Team A1",
    away_team_name: "Team A2",
    status: "scheduled",
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    ...overrides,
  };
}

function idempotencyValues(ids, overrides = {}) {
  return {
    id: uuid(150),
    league_id: ids.leagueA,
    actor_user_id: ids.userA,
    operation: "test.operation",
    client_key: "client-key",
    request_hash: "a".repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: 1_000,
    completed_at_ms: null,
    expires_at_ms: 2_000,
    ...overrides,
  };
}

function collectRepositoryDatabaseArtifacts() {
  const artifacts = [];
  const skippedDirectories = new Set([".git", "node_modules"]);
  const databaseFilePattern =
    /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i;

  function walk(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (databaseFilePattern.test(entry.name)) {
        artifacts.push(path.relative(ROOT_DIRECTORY, entryPath));
      }
    }
  }

  walk(ROOT_DIRECTORY);
  return artifacts.sort();
}

describe("M2-04 initial relational schema", () => {
  test("applies exactly, remains deterministic, and exposes the complete strict schema", (t) => {
    const { database, migrationResult } = createMigratedDatabase(
      t,
      "hundo-leago-m2-04-structure-"
    );
    const migrations = discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    });

    assert.equal(migrations.length, 22);
    assert.equal(migrations[0].id, 1);
    assert.equal(migrations[0].fileName, "0001_initial.sql");
    assert.equal(migrations[1].id, 2);
    assert.equal(
      migrations[1].fileName,
      "0002_add_pending_credential_setup_user_status.sql"
    );
    assert.equal(migrations[2].id, 3);
    assert.equal(
      migrations[2].fileName,
      "0003_add_league_invitation_team_workflow.sql"
    );
    assert.equal(migrations[3].id, 4);
    assert.equal(
      migrations[3].fileName,
      "0004_add_manager_transfer_intent.sql"
    );
    assert.equal(migrations[4].id, 5);
    assert.equal(
      migrations[4].fileName,
      "0005_add_team_logo_objects.sql"
    );
    assert.equal(migrations[5].id, 6);
    assert.equal(
      migrations[5].fileName,
      "0006_allow_rounded_contract_aav.sql"
    );
    assert.equal(migrations[6].id, 7);
    assert.equal(
      migrations[6].fileName,
      "0007_preserve_released_ownership_history.sql"
    );
    assert.equal(migrations[7].id, 8);
    assert.equal(
      migrations[7].fileName,
      "0008_allow_optional_commissioner_correction_reason.sql"
    );
    assert.equal(migrations[8].id, 9);
    assert.equal(
      migrations[8].fileName,
      "0009_add_free_agent_draft_completion.sql"
    );
    assert.equal(migrations[9].id, 10);
    assert.equal(
      migrations[9].fileName,
      "0010_add_auction_bid_lowest_offered_aav.sql"
    );
    assert.equal(migrations[10].id, 11);
    assert.equal(
      migrations[10].fileName,
      "0011_add_atomic_auction_completion.sql"
    );
    assert.equal(migrations[11].id, 12);
    assert.equal(
      migrations[11].fileName,
      "0012_add_atomic_trade_proposal_assets.sql"
    );
    assert.equal(migrations[12].id, 13);
    assert.equal(
      migrations[12].fileName,
      "0013_add_atomic_trade_execution.sql"
    );
    assert.equal(migrations[13].id, 14);
    assert.equal(
      migrations[13].fileName,
      "0014_add_trade_reversal_and_correction_required.sql"
    );
    assert.equal(migrations[14].id, 15);
    assert.equal(
      migrations[14].fileName,
      "0015_add_matchup_schedule_participants.sql"
    );
    assert.equal(migrations[15].id, 16);
    assert.equal(
      migrations[15].fileName,
      "0016_update_matchup_lifecycle_statuses.sql"
    );
    assert.equal(migrations[16].id, 17);
    assert.equal(
      migrations[16].fileName,
      "0017_add_matchup_lock_legality_evidence.sql"
    );
    assert.equal(migrations[17].id, 18);
    assert.equal(
      migrations[17].fileName,
      "0018_add_job_run_lease_tokens_and_retry_time.sql"
    );
    assert.equal(migrations[18].id, 19);
    assert.equal(
      migrations[18].fileName,
      "0019_add_roster_display_order.sql"
    );
    assert.equal(migrations[19].id, 20);
    assert.equal(
      migrations[19].fileName,
      "0020_add_team_tertiary_colour_and_trade_block.sql"
    );
    assert.equal(migrations[20].id, 21);
    assert.equal(
      migrations[20].fileName,
      "0021_allow_confirmed_roster_overages.sql"
    );
    assert.equal(migrations[21].id, 22);
    assert.equal(
      migrations[21].fileName,
      "0022_add_team_pattern_template.sql"
    );
    assert.equal(migrationResult.status, "exact");
    assert.equal(database.pragma("user_version", { simple: true }), 22);

    const ledgerBefore = database
      .prepare("SELECT * FROM schema_migrations")
      .all();
    assert.equal(ledgerBefore.length, 22);
    assert.equal(ledgerBefore[0].checksum, migrations[0].checksum);
    assert.equal(ledgerBefore[1].checksum, migrations[1].checksum);
    assert.equal(ledgerBefore[2].checksum, migrations[2].checksum);
    assert.equal(ledgerBefore[3].checksum, migrations[3].checksum);
    assert.equal(ledgerBefore[4].checksum, migrations[4].checksum);
    assert.equal(ledgerBefore[5].checksum, migrations[5].checksum);
    assert.equal(ledgerBefore[6].checksum, migrations[6].checksum);
    assert.equal(ledgerBefore[7].checksum, migrations[7].checksum);
    assert.equal(ledgerBefore[8].checksum, migrations[8].checksum);
    assert.equal(ledgerBefore[9].checksum, migrations[9].checksum);
    assert.equal(ledgerBefore[10].checksum, migrations[10].checksum);
    assert.equal(ledgerBefore[11].checksum, migrations[11].checksum);
    assert.equal(ledgerBefore[12].checksum, migrations[12].checksum);
    assert.equal(ledgerBefore[13].checksum, migrations[13].checksum);
    assert.equal(ledgerBefore[14].checksum, migrations[14].checksum);

    const rerun = migrateDatabase({
      database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      applicationBuildId: "m2-04-rerun",
    });
    assert.equal(rerun.status, "exact");
    assert.deepEqual(
      database.prepare("SELECT * FROM schema_migrations").all(),
      ledgerBefore
    );

    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema " +
          "WHERE type = ? AND name NOT LIKE ? ORDER BY name"
      )
      .all("table", "sqlite_%")
      .map(({ name }) => name);
    assert.deepEqual(tables, EXPECTED_TABLES);

    const tableList = new Map(
      database
        .pragma("table_list")
        .filter(({ schema }) => schema === "main")
        .map((row) => [row.name, row])
    );
    for (const tableName of EXPECTED_TABLES) {
      assert.equal(
        tableList.get(tableName)?.strict,
        1,
        `${tableName} must be STRICT`
      );
    }

    assert.deepEqual(
      database
        .prepare(
          "SELECT metadata_key, metadata_value " +
            "FROM application_metadata ORDER BY metadata_key"
        )
        .all(),
      [
        {
          metadata_key: "application_compatibility_version",
          metadata_value: "1",
        },
      {
        metadata_key: "data_model_version",
        metadata_value: "22",
      },
      ]
    );
    assert.equal(
      database.pragma("integrity_check", { simple: true }),
      "ok"
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);

    for (const tableName of EXPECTED_TABLES) {
      const foreignKeys = database.pragma(
        `foreign_key_list(${tableName})`
      );
      assert.equal(
        foreignKeys.some(({ on_delete: onDelete }) => {
          return onDelete === "CASCADE";
        }),
        false,
        `${tableName} must not silently cascade deletes`
      );
    }
  });

  test("gives every league-scoped table a league-first index and leaves no repository database", (t) => {
    const { database } = createMigratedDatabase(
      t,
      "hundo-leago-m2-04-indexes-"
    );
    const leagueTables = EXPECTED_TABLES.filter((tableName) => {
      return database
        .pragma(`table_info(${tableName})`)
        .some(({ name }) => name === "league_id");
    });

    assert.ok(leagueTables.length > 50);
    for (const tableName of leagueTables) {
      const indexes = database.pragma(`index_list(${tableName})`);
      const hasLeagueFirstIndex = indexes.some(({ name }) => {
        return (
          database.pragma(`index_info(${name})`)[0]?.name ===
          "league_id"
        );
      });
      assert.equal(
        hasLeagueFirstIndex,
        true,
        `${tableName} needs a league_id-first index`
      );
    }

    assert.deepEqual(collectRepositoryDatabaseArtifacts(), []);
  });

  test("rejects global duplicates and conflicting current records", (t) => {
    const { database } = createMigratedDatabase(
      t,
      "hundo-leago-m2-04-unique-"
    );
    const ids = seedBase(database);

    assertConstraint(() => {
      insert(database, "users", {
        id: uuid(200),
        email_normalized: "a@example.test",
        email_display: "a@example.test",
        display_name: "Delta",
        display_name_normalized: "delta",
        status: "active",
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });
    assertConstraint(() => {
      insert(database, "leagues", {
        id: uuid(201),
        name: "LEAGUE ALPHA",
        name_normalized: "league alpha",
        status: "setup",
        timezone: "UTC",
        commissioner_membership_id: null,
        current_season_id: null,
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });
    assertConstraint(() => {
      insert(database, "teams", {
        id: uuid(202),
        league_id: ids.leagueA,
        name: "Alpha One",
        name_normalized: "alpha one",
        status: "active",
        primary_colour: null,
        secondary_colour: null,
        logo_reference: null,
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });

    database
      .prepare("UPDATE seasons SET status = ? WHERE id = ?")
      .run("active", ids.seasonA);
    assertConstraint(() => {
      insert(database, "seasons", {
        id: uuid(203),
        league_id: ids.leagueA,
        label: "Season A2",
        nhl_season_key: "2027A",
        status: "active",
        regular_season_starts_at_ms: null,
        regular_season_ends_at_ms: null,
        fantasy_playoffs_start_at_ms: null,
        fantasy_playoffs_end_at_ms: null,
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });
    assertConstraint(() => {
      insert(database, "league_memberships", {
        id: uuid(204),
        league_id: ids.leagueA,
        user_id: ids.userA,
        permission_category: "manager",
        status: "active",
        joined_at_ms: 1_000,
        ended_at_ms: null,
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });

    insert(database, "league_memberships", {
      id: uuid(205),
      league_id: ids.leagueA,
      user_id: ids.userC,
      permission_category: "manager",
      status: "active",
      joined_at_ms: 1_000,
      ended_at_ms: null,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
    insert(database, "team_manager_assignments", {
      id: uuid(206),
      league_id: ids.leagueA,
      team_id: ids.teamA1,
      user_id: ids.userA,
      membership_id: ids.membershipA,
      assigned_by_user_id: ids.userA,
      status: "accepted",
      assigned_at_ms: 1_000,
      accepted_at_ms: 1_000,
      ended_at_ms: null,
      version: 1,
    });
    assertConstraint(() => {
      insert(database, "team_manager_assignments", {
        id: uuid(207),
        league_id: ids.leagueA,
        team_id: ids.teamA1,
        user_id: ids.userC,
        membership_id: uuid(205),
        assigned_by_user_id: ids.userA,
        status: "accepted",
        assigned_at_ms: 1_000,
        accepted_at_ms: 1_000,
        ended_at_ms: null,
        version: 1,
      });
    });

    insert(database, "player_ownerships", ownershipValues(ids));
    assertConstraint(() => {
      insert(
        database,
        "player_ownerships",
        ownershipValues(ids, {
          id: uuid(208),
          roster_category: "Prospect",
          slot_number: null,
        })
      );
    });

    insert(database, "contracts", contractValues(ids));
    assertConstraint(() => {
      insert(
        database,
        "contracts",
        contractValues(ids, { id: uuid(209) })
      );
    });
  });

  test("rejects cross-league composite relationships and deferred pointers", (t) => {
    const { database } = createMigratedDatabase(
      t,
      "hundo-leago-m2-04-cross-league-"
    );
    const ids = seedBase(database);

    insert(
      database,
      "player_ownerships",
      ownershipValues(ids, { id: uuid(218) })
    );
    insert(
      database,
      "player_ownerships",
      ownershipValues(ids, {
        id: uuid(219),
        league_id: ids.leagueB,
        season_id: ids.seasonB,
        player_id: ids.player1,
        team_id: ids.teamB1,
      })
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM player_ownerships WHERE player_id = ?"
        )
        .get(ids.player1).count,
      2
    );

    assertConstraint(
      () => {
        database
          .prepare(
            "UPDATE leagues SET current_season_id = ? WHERE id = ?"
          )
          .run(ids.seasonB, ids.leagueA);
      },
      /invalid current season/
    );
    assertConstraint(
      () => {
        database
          .prepare(
            "UPDATE leagues " +
              "SET commissioner_membership_id = ? WHERE id = ?"
          )
          .run(ids.membershipB, ids.leagueA);
      },
      /invalid active commissioner membership/
    );

    assertConstraint(() => {
      insert(database, "team_manager_assignments", {
        id: uuid(220),
        league_id: ids.leagueA,
        team_id: ids.teamB1,
        user_id: ids.userA,
        membership_id: ids.membershipA,
        assigned_by_user_id: ids.userA,
        status: "accepted",
        assigned_at_ms: 1_000,
        accepted_at_ms: 1_000,
        ended_at_ms: null,
        version: 1,
      });
    });
    assertConstraint(() => {
      insert(
        database,
        "player_ownerships",
        ownershipValues(ids, {
          id: uuid(221),
          season_id: ids.seasonB,
        })
      );
    });
    assertConstraint(() => {
      insert(
        database,
        "player_ownerships",
        ownershipValues(ids, {
          id: uuid(222),
          team_id: ids.teamB1,
        })
      );
    });
    assertConstraint(() => {
      insert(
        database,
        "contracts",
        contractValues(ids, {
          id: uuid(223),
          current_team_id: ids.teamB1,
        })
      );
    });

    insert(database, "contracts", contractValues(ids));
    assertConstraint(() => {
      insert(database, "contract_years", {
        id: uuid(224),
        league_id: ids.leagueA,
        contract_id: uuid(110),
        season_id: ids.seasonB,
        year_number: 1,
        aav_cents: 1_000,
        status: "current",
        rollover_at_ms: null,
        created_at_ms: 1_000,
      });
    });
    assertConstraint(() => {
      insert(database, "retention_obligations", {
        id: uuid(225),
        league_id: ids.leagueA,
        contract_id: uuid(110),
        player_id: ids.player1,
        originating_team_id: ids.teamA1,
        responsible_team_id: ids.teamB1,
        retained_aav_cents: 100,
        creation_trade_id: null,
        status: "active",
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });

    insert(
      database,
      "contracts",
      contractValues(ids, {
        id: uuid(226),
        league_id: ids.leagueB,
        player_id: ids.player4,
        current_team_id: ids.teamB1,
        start_season_id: ids.seasonB,
      })
    );
    insert(database, "trades", tradeValues(ids));
    assertConstraint(() => {
      insert(database, "trade_assets", {
        id: uuid(227),
        league_id: ids.leagueA,
        trade_id: uuid(120),
        direction: "proposing_to_receiving",
        source_team_id: ids.teamA1,
        destination_team_id: ids.teamA2,
        asset_type: "contract",
        contract_id: uuid(226),
        player_id: null,
        draft_pick_id: null,
        retention_obligation_id: null,
        buyout_obligation_id: null,
        future_consideration_id: null,
        requested_retention_cents: null,
        proposal_snapshot_json: null,
        sequence: 1,
        created_at_ms: 1_000,
      });
    });

    insert(database, "entry_drafts", draftValues(ids));
    assertConstraint(() => {
      insert(
        database,
        "draft_picks",
        draftPickValues(ids, {
          id: uuid(228),
          current_owner_team_id: ids.teamB1,
        })
      );
    });

    insert(database, "matchup_weeks", matchupWeekValues(ids));
    assertConstraint(() => {
      insert(
        database,
        "matchups",
        matchupValues(ids, {
          id: uuid(229),
          away_team_id: ids.teamB1,
        })
      );
    });

    assert.deepEqual(database.pragma("foreign_key_check"), []);
  });

  test("enforces roster, contract, money, statistics, time, boolean, and version rules", (t) => {
    const { database } = createMigratedDatabase(
      t,
      "hundo-leago-m2-04-values-"
    );
    const ids = seedBase(database);

    insert(database, "player_ownerships", ownershipValues(ids));
    insert(
      database,
      "player_ownerships",
      ownershipValues(ids, {
        id: uuid(230),
        player_id: ids.player2,
        roster_category: "Prospect",
        slot_number: null,
      })
    );

    [
      {
        id: uuid(231),
        player_id: ids.player3,
        roster_category: "Active",
        position_group: "F",
        slot_number: 13,
      },
      {
        id: uuid(232),
        player_id: ids.player3,
        roster_category: "Active",
        position_group: "D",
        slot_number: 7,
      },
      {
        id: uuid(233),
        player_id: ids.player3,
        roster_category: "Bench",
        slot_number: 5,
      },
      {
        id: uuid(234),
        player_id: ids.player3,
        roster_category: "Prospect",
        slot_number: 1,
      },
      {
        id: uuid(235),
        player_id: ids.player3,
        position_group: "G",
      },
      {
        id: uuid(236),
        player_id: ids.player3,
        roster_category: "Active",
        position_group: "F",
        slot_number: 1,
      },
    ].forEach((overrides) => {
      assertConstraint(() => {
        insert(
          database,
          "player_ownerships",
          ownershipValues(ids, overrides)
        );
      });
    });

    insert(database, "contracts", contractValues(ids));
    [
      {
        id: uuid(237),
        player_id: ids.player3,
        original_term_years: 4,
        original_total_value_cents: 4_000,
      },
      {
        id: uuid(238),
        player_id: ids.player3,
        original_total_value_cents: 2_998,
      },
      {
        id: uuid(239),
        player_id: ids.player3,
        original_total_value_cents: -3,
        aav_cents: -1,
      },
      {
        id: uuid(240),
        player_id: ids.player3,
        version: 0,
      },
    ].forEach((overrides) => {
      assertConstraint(() => {
        insert(database, "contracts", contractValues(ids, overrides));
      });
    });

    assertConstraint(() => {
      insert(database, "league_settings", {
        league_id: ids.leagueA,
        salary_cap_cents: 10_000,
        trade_deadline_at_ms: null,
        maximum_teams: 4,
        active_forward_slots: 12,
        active_defence_slots: 6,
        bench_slots: 4,
        maximum_bench_aav_cents: 400,
        injured_reserve_slots: 4,
        prospect_slots_unlimited: 2,
        scoring_rule_version: 1,
        standings_rule_version: 1,
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });
    assertConstraint(() => {
      insert(database, "player_source_state", {
        id: uuid(241),
        player_id: ids.player3,
        provider: "test",
        source_position: "C",
        normalized_position: "F",
        nhl_team_abbreviation: "VAN",
        active: 2,
        source_version: "1",
        source_payload_json: null,
        effective_at_ms: 1_000,
        ended_at_ms: null,
        created_at_ms: 1_000,
      });
    });

    insert(database, "stat_sources", {
      id: uuid(242),
      provider: "test-provider",
      status: "active",
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
    insert(database, "stat_refreshes", {
      id: uuid(243),
      stat_source_id: uuid(242),
      nhl_season_key: "2026",
      source_version: "1",
      status: "succeeded",
      started_at_ms: 1_000,
      completed_at_ms: 1_100,
      player_count: 1,
      error_code: null,
      metadata_json: null,
      version: 1,
    });
    assertConstraint(() => {
      insert(database, "player_stat_totals", {
        id: uuid(244),
        stat_source_id: uuid(242),
        refresh_id: uuid(243),
        nhl_season_key: "2026",
        player_id: ids.player3,
        games_played: 1,
        goals: 1,
        assists: 1,
        nhl_points: 3,
        fantasy_points_hundredths: -1,
        source_updated_at_ms: 1_100,
        created_at_ms: 1_100,
      });
    });
    assertConstraint(() => {
      insert(database, "authentication_rate_limits", {
        id: uuid(245),
        action: "login",
        key_version: 1,
        bucket_digest: "b".repeat(64),
        window_started_at_ms: 1_000,
        window_ends_at_ms: 2_000,
        attempt_count: -1,
        failure_count: 0,
        blocked_until_ms: null,
        updated_at_ms: 1_000,
        version: 1,
      });
    });
    assertConstraint(() => {
      insert(database, "job_runs", {
        id: uuid(246),
        league_id: ids.leagueA,
        season_id: ids.seasonA,
        job_type: "test",
        occurrence_key: "one",
        scheduled_for_ms: -1,
        status: "pending",
        attempt_count: -1,
        lease_owner: null,
        lease_expires_at_ms: null,
        started_at_ms: null,
        completed_at_ms: null,
        result_json: null,
        last_error_code: null,
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });
  });

  test("enforces auction, bid, trade-team, and typed-asset invariants", (t) => {
    const { database } = createMigratedDatabase(
      t,
      "hundo-leago-m2-04-transactions-"
    );
    const ids = seedBase(database);

    insert(database, "auctions", {
      id: uuid(250),
      league_id: ids.leagueA,
      season_id: ids.seasonA,
      player_id: ids.player1,
      status: "open",
      opened_at_ms: 1_000,
      resolves_at_ms: 2_000,
      opened_by_user_id: ids.userA,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      version: 1,
    });
    assertConstraint(() => {
      insert(database, "auctions", {
        id: uuid(251),
        league_id: ids.leagueA,
        season_id: ids.seasonA,
        player_id: ids.player1,
        status: "resolving",
        opened_at_ms: 1_000,
        resolves_at_ms: 2_000,
        opened_by_user_id: ids.userA,
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        version: 1,
      });
    });
    assertConstraint(() => {
      insert(database, "auctions", {
        id: uuid(252),
        league_id: ids.leagueA,
        season_id: ids.seasonA,
        player_id: ids.player2,
        status: "open",
        opened_at_ms: 2_000,
        resolves_at_ms: 2_000,
        opened_by_user_id: ids.userA,
        created_at_ms: 2_000,
        updated_at_ms: 2_000,
        version: 1,
      });
    });

    const bid = {
      id: uuid(253),
      league_id: ids.leagueA,
      season_id: ids.seasonA,
      auction_id: uuid(250),
      team_id: ids.teamA1,
      submitted_by_user_id: ids.userA,
      total_value_cents: 3_000,
      term_years: 3,
      lowest_offered_aav_cents: 1_000,
      first_submitted_at_ms: 1_100,
      last_edited_at_ms: 1_100,
      edit_count: 0,
      status: "active",
      idempotency_request_id: null,
      version: 1,
    };
    insert(database, "auction_bids", bid);
    assertConstraint(() => {
      insert(database, "auction_bids", {
        ...bid,
        id: uuid(254),
      });
    });
    assertConstraint(() => {
      insert(database, "auction_bids", {
        ...bid,
        id: uuid(255),
        team_id: ids.teamB1,
      });
    });

    assertConstraint(() => {
      insert(
        database,
        "trades",
        tradeValues(ids, {
          id: uuid(256),
          receiving_team_id: ids.teamA1,
        })
      );
    });
    insert(database, "trades", tradeValues(ids));
    insert(database, "contracts", contractValues(ids));

    insert(database, "trade_assets", {
      id: uuid(257),
      league_id: ids.leagueA,
      trade_id: uuid(120),
      direction: "proposing_to_receiving",
      source_team_id: ids.teamA1,
      destination_team_id: ids.teamA2,
      asset_type: "contract",
      contract_id: uuid(110),
      player_id: null,
      draft_pick_id: null,
      retention_obligation_id: null,
      buyout_obligation_id: null,
      future_consideration_id: null,
      requested_retention_cents: null,
      proposal_snapshot_json: "{}",
      sequence: 1,
      created_at_ms: 1_000,
    });
    insert(database, "trade_assets", {
      id: uuid(258),
      league_id: ids.leagueA,
      trade_id: uuid(120),
      direction: "receiving_to_proposing",
      source_team_id: ids.teamA2,
      destination_team_id: ids.teamA1,
      asset_type: "requested_retention",
      contract_id: null,
      player_id: null,
      draft_pick_id: null,
      retention_obligation_id: null,
      buyout_obligation_id: null,
      future_consideration_id: null,
      requested_retention_cents: 100,
      proposal_snapshot_json: "{}",
      sequence: 2,
      created_at_ms: 1_000,
    });
    assertConstraint(() => {
      insert(database, "trade_assets", {
        id: uuid(259),
        league_id: ids.leagueA,
        trade_id: uuid(120),
        direction: "proposing_to_receiving",
        source_team_id: ids.teamA1,
        destination_team_id: ids.teamA2,
        asset_type: "contract",
        contract_id: null,
        player_id: ids.player1,
        draft_pick_id: null,
        retention_obligation_id: null,
        buyout_obligation_id: null,
        future_consideration_id: null,
        requested_retention_cents: null,
        proposal_snapshot_json: null,
        sequence: 3,
        created_at_ms: 1_000,
      });
    });
  });

  test("enforces draft, matchup-versus-bye, and idempotency identities", (t) => {
    const { database } = createMigratedDatabase(
      t,
      "hundo-leago-m2-04-workflows-"
    );
    const ids = seedBase(database);

    insert(database, "entry_drafts", draftValues(ids));
    insert(database, "draft_picks", draftPickValues(ids));
    assertConstraint(() => {
      insert(
        database,
        "draft_picks",
        draftPickValues(ids, { id: uuid(260) })
      );
    });
    insert(
      database,
      "draft_picks",
      draftPickValues(ids, {
        id: uuid(261),
        position_number: 2,
        original_team_id: ids.teamA2,
        current_owner_team_id: ids.teamA2,
      })
    );

    const selection = {
      id: uuid(262),
      league_id: ids.leagueA,
      draft_id: uuid(130),
      draft_pick_id: uuid(131),
      player_id: ids.player1,
      selecting_team_id: ids.teamA1,
      source: "manual",
      actor_user_id: ids.userA,
      selected_at_ms: 1_000,
    };
    insert(database, "draft_selections", selection);
    database
      .prepare("UPDATE draft_picks SET selection_id = ? WHERE id = ?")
      .run(uuid(262), uuid(131));
    assertConstraint(
      () => {
        database
          .prepare(
            "UPDATE draft_picks SET selection_id = ? WHERE id = ?"
          )
          .run(uuid(262), uuid(261));
      },
      /draft pick selection must reference this pick/
    );
    assertConstraint(() => {
      insert(database, "draft_selections", {
        ...selection,
        id: uuid(263),
        player_id: ids.player2,
      });
    });
    assertConstraint(() => {
      insert(database, "draft_selections", {
        ...selection,
        id: uuid(264),
        draft_pick_id: uuid(261),
      });
    });
    assertConstraint(() => {
      insert(database, "draft_selections", {
        ...selection,
        id: uuid(265),
        draft_pick_id: uuid(261),
        player_id: ids.player2,
        selecting_team_id: ids.teamB1,
      });
    });

    insert(database, "matchup_weeks", matchupWeekValues(ids));
    insert(database, "matchups", matchupValues(ids));
    assertConstraint(
      () => {
        insert(
          database,
          "matchups",
          matchupValues(ids, {
            id: uuid(266),
            away_team_id: ids.teamA3,
          })
        );
      },
      /team already has a matchup or bye/
    );
    assertConstraint(
      () => {
        insert(database, "matchup_byes", {
          id: uuid(267),
          league_id: ids.leagueA,
          season_id: ids.seasonA,
          matchup_week_id: uuid(140),
          team_id: ids.teamA1,
          team_display_name: "Team A1",
          created_at_ms: 1_000,
        });
      },
      /team already has a matchup/
    );
    insert(database, "matchup_byes", {
      id: uuid(268),
      league_id: ids.leagueA,
      season_id: ids.seasonA,
      matchup_week_id: uuid(140),
      team_id: ids.teamA3,
      team_display_name: "Team A3",
      created_at_ms: 1_000,
    });
    assertConstraint(
      () => {
        insert(
          database,
          "matchups",
          matchupValues(ids, {
            id: uuid(269),
            home_team_id: ids.teamA3,
            away_team_id: ids.teamA4,
          })
        );
      },
      /team already has a matchup or bye/
    );
    assertConstraint(() => {
      insert(
        database,
        "matchups",
        matchupValues(ids, {
          id: uuid(270),
          home_team_id: ids.teamA4,
          away_team_id: ids.teamA4,
        })
      );
    });

    insert(database, "idempotency_requests", idempotencyValues(ids));
    assertConstraint(() => {
      insert(
        database,
        "idempotency_requests",
        idempotencyValues(ids, { id: uuid(271) })
      );
    });
    insert(
      database,
      "idempotency_requests",
      idempotencyValues(ids, {
        id: uuid(272),
        league_id: null,
        client_key: "global-key",
      })
    );
    assertConstraint(() => {
      insert(
        database,
        "idempotency_requests",
        idempotencyValues(ids, {
          id: uuid(273),
          league_id: null,
          client_key: "global-key",
        })
      );
    });
  });

  test("fails closed when the applied migration checksum changes", (t) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-leago-m2-04-checksum-")
    );
    const copiedMigrations = path.join(
      temporaryRoot,
      "migrations"
    );
    fs.mkdirSync(copiedMigrations);
    fs.copyFileSync(
      path.join(MIGRATIONS_DIRECTORY, "0001_initial.sql"),
      path.join(copiedMigrations, "0001_initial.sql")
    );
    t.after(() => {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    const { database } = createMigratedDatabase(
      t,
      "hundo-leago-m2-04-checksum-db-",
      copiedMigrations
    );
    fs.appendFileSync(
      path.join(copiedMigrations, "0001_initial.sql"),
      "\n-- unauthorized checksum mutation\n",
      "utf8"
    );

    assert.throws(
      () => {
        migrateDatabase({
          database,
          migrationsDirectory: copiedMigrations,
          applicationBuildId: "m2-04-mutated",
        });
      },
      (error) => error?.code === "MIGRATION_CHECKSUM_MISMATCH"
    );
  });
});
