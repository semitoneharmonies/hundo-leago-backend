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

const CANONICAL_MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const FIRST_MATCHUP_STARTS_AT_MS = 2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 604_800_000;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 172_800_000;
const OPENED_AT_MS = HELP_OPENS_AT_MS - 10_000;
const FIXTURE_IDS = Object.freeze({
  user: uuid(34_001),
  rightsLeague: uuid(34_002),
  rightsSeason: uuid(34_003),
  draft: uuid(34_004),
  eligibilitySnapshot: uuid(34_005),
  approvedPlayer: uuid(34_006),
  blockedPlayer: uuid(34_007),
  recoveryPlayer: uuid(34_008),
  approvedReleaseEvent: uuid(34_009),
  blockedReleaseEvent: uuid(34_010),
  newerNoiseEvent: uuid(34_011),
  approvedEligibility: uuid(34_012),
  fadLeague: uuid(34_013),
  fadSeason: uuid(34_014),
  matchupWeek: uuid(34_015),
  readiness: uuid(34_016),
  fad: uuid(34_017),
  recovery: uuid(34_018),
});

const EXPECTED_INDEXES = Object.freeze([
  Object.freeze({
    name: "draft_eligible_players_rights_release_reentry",
    table: "draft_eligible_players",
    columns: Object.freeze([
      Object.freeze({ name: "league_id", desc: 0 }),
      Object.freeze({ name: "player_id", desc: 0 }),
      Object.freeze({ name: "rights_release_event_id", desc: 0 }),
      Object.freeze({ name: "eligibility_snapshot_id", desc: 0 }),
    ]),
    partial: 1,
    predicatePattern:
      / WHERE eligibility_reason = 'rights_release_reentry'$/,
  }),
  Object.freeze({
    name: "free_agent_draft_recoveries_league_player_status",
    table: "free_agent_draft_recoveries",
    columns: Object.freeze([
      Object.freeze({ name: "league_id", desc: 0 }),
      Object.freeze({ name: "player_id", desc: 0 }),
      Object.freeze({ name: "status", desc: 0 }),
    ]),
    partial: 0,
    predicatePattern: null,
  }),
  Object.freeze({
    name: "ownership_events_candidate_release_by_player",
    table: "ownership_events",
    columns: Object.freeze([
      Object.freeze({ name: "league_id", desc: 0 }),
      Object.freeze({ name: "player_id", desc: 0 }),
      Object.freeze({ name: "occurred_at_ms", desc: 1 }),
      Object.freeze({ name: "id", desc: 1 }),
    ]),
    partial: 1,
    predicatePattern:
      / WHERE event_type IN \( 'fantasy_elc_declined', 'unsigned_prospect_rights_released' \)$/,
  }),
]);

const ORDERED_RELEASE_LOOKUP_SQL = `
  SELECT id
  FROM ownership_events
  WHERE league_id = @leagueId
    AND player_id = @playerId
    AND event_type IN (
      'fantasy_elc_declined',
      'unsigned_prospect_rights_released'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM draft_eligible_players AS approved_player
      JOIN draft_eligibility_snapshots AS approved_snapshot
        ON approved_snapshot.league_id = approved_player.league_id
       AND approved_snapshot.id = approved_player.eligibility_snapshot_id
      WHERE approved_player.league_id = ownership_events.league_id
        AND approved_player.player_id = ownership_events.player_id
        AND approved_player.eligibility_reason = 'rights_release_reentry'
        AND approved_player.rights_release_event_id = ownership_events.id
        AND approved_snapshot.status = 'confirmed'
        AND approved_snapshot.confirmed_at_ms > ownership_events.occurred_at_ms
    )
  ORDER BY occurred_at_ms DESC, id DESC
  LIMIT 1
`;

const CORRELATED_ELIGIBILITY_PREDICATES_SQL = `
  SELECT player.id
  FROM players AS player
  WHERE player.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM ownership_events AS event
      WHERE event.league_id = @leagueId
        AND event.player_id = player.id
        AND event.event_type IN (
          'fantasy_elc_declined',
          'unsigned_prospect_rights_released'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM draft_eligible_players AS approved_player
          JOIN draft_eligibility_snapshots AS approved_snapshot
            ON approved_snapshot.league_id = approved_player.league_id
           AND approved_snapshot.id = approved_player.eligibility_snapshot_id
          WHERE approved_player.league_id = event.league_id
            AND approved_player.player_id = event.player_id
            AND approved_player.eligibility_reason = 'rights_release_reentry'
            AND approved_player.rights_release_event_id = event.id
            AND approved_snapshot.status = 'confirmed'
            AND approved_snapshot.confirmed_at_ms > event.occurred_at_ms
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM free_agent_draft_recoveries AS recovery
      WHERE recovery.league_id = @leagueId
        AND recovery.player_id = player.id
        AND recovery.status IN (
          'pending',
          'ready',
          'running',
          'correction_required'
        )
    )
  ORDER BY player.id
  LIMIT @limit
`;

const PLAYER_FAD_QUARANTINE_SQL = `
  SELECT quarantine_kind
  FROM (
    SELECT
      'allocation' AS quarantine_kind,
      allocation.updated_at_ms AS evidence_at_ms,
      allocation.id AS evidence_id
    FROM free_agent_draft_player_allocations AS allocation
    WHERE allocation.league_id = @leagueId
      AND allocation.player_id = @playerId
      AND allocation.status IN (
        'pending',
        'restricted_scheduled',
        'restricted_active',
        'restricted_fallback_open',
        'correction_required'
      )

    UNION ALL

    SELECT
      'recovery' AS quarantine_kind,
      recovery.updated_at_ms AS evidence_at_ms,
      recovery.id AS evidence_id
    FROM free_agent_draft_recoveries AS recovery
    WHERE recovery.league_id = @leagueId
      AND recovery.player_id = @playerId
      AND recovery.status IN (
        'pending',
        'ready',
        'running',
        'correction_required'
      )

    UNION ALL

    SELECT
      'fad_auction' AS quarantine_kind,
      auction.updated_at_ms AS evidence_at_ms,
      auction.id AS evidence_id
    FROM auctions AS auction
    JOIN auction_contexts AS context
      ON context.league_id = auction.league_id
     AND context.season_id = auction.season_id
     AND context.auction_id = auction.id
     AND context.source_kind IN (
       'fad_open_rapid',
       'fad_restricted'
     )
    WHERE auction.league_id = @leagueId
      AND auction.player_id = @playerId
      AND auction.status IN ('open', 'resolving')
  ) AS quarantine
  ORDER BY evidence_at_ms DESC, evidence_id DESC
  LIMIT 1
`;

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

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  try {
    return database
      .prepare(`
        INSERT INTO ${tableName} (
          ${columns.join(", ")}
        ) VALUES (
          ${columns.map((column) => `@${column}`).join(", ")}
        )
      `)
      .run(values);
  } catch (error) {
    throw new Error(
      `Could not seed ${tableName}: ${error.message}`,
      { cause: error }
    );
  }
}

function dropInsertTriggers(database, tableName) {
  for (const { name, sql } of database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name = ?
      ORDER BY name
    `)
    .all(tableName)) {
    if (/\b(?:BEFORE|AFTER)\s+INSERT\b/i.test(sql)) {
      database.exec(
        `DROP TRIGGER "${name.replaceAll('"', '""')}"`
      );
    }
  }
}

function seedLeagueSeason(
  database,
  {
    leagueId,
    seasonId,
    label,
  }
) {
  insert(database, "leagues", {
    id: leagueId,
    name: `${label} League`,
    name_normalized: `${label.toLowerCase()} league`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "seasons", {
    id: seasonId,
    league_id: leagueId,
    label: `${label} Season`,
    nhl_season_key: `2026-${label.toLowerCase()}`,
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
}

function seedPlayer(database, playerId, label) {
  insert(database, "players", {
    id: playerId,
    first_name: label,
    last_name: "Fixture",
    full_name: `${label} Fixture`,
    birth_date: null,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function seedOwnershipEvent(
  database,
  {
    id,
    leagueId,
    seasonId,
    playerId,
    eventType,
    occurredAtMs,
  }
) {
  insert(database, "ownership_events", {
    id,
    league_id: leagueId,
    season_id: seasonId,
    player_id: playerId,
    team_id: null,
    ownership_id: null,
    event_type: eventType,
    actor_user_id: FIXTURE_IDS.user,
    source_type: "candidate_index_migration_fixture",
    source_id: null,
    before_metadata_json: null,
    after_metadata_json: null,
    reason: null,
    occurred_at_ms: occurredAtMs,
  });
}

function seedRepresentativeSchema33Rows(database) {
  insert(database, "users", {
    id: FIXTURE_IDS.user,
    email_normalized: "candidate-index@example.test",
    email_display: "candidate-index@example.test",
    display_name: "Candidate Index Fixture",
    display_name_normalized: "candidate index fixture",
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  seedLeagueSeason(database, {
    leagueId: FIXTURE_IDS.rightsLeague,
    seasonId: FIXTURE_IDS.rightsSeason,
    label: "Rights",
  });
  seedLeagueSeason(database, {
    leagueId: FIXTURE_IDS.fadLeague,
    seasonId: FIXTURE_IDS.fadSeason,
    label: "FAD",
  });
  seedPlayer(
    database,
    FIXTURE_IDS.approvedPlayer,
    "Approved"
  );
  seedPlayer(
    database,
    FIXTURE_IDS.blockedPlayer,
    "Blocked"
  );
  seedPlayer(
    database,
    FIXTURE_IDS.recoveryPlayer,
    "Recovery"
  );

  seedOwnershipEvent(database, {
    id: FIXTURE_IDS.approvedReleaseEvent,
    leagueId: FIXTURE_IDS.rightsLeague,
    seasonId: FIXTURE_IDS.rightsSeason,
    playerId: FIXTURE_IDS.approvedPlayer,
    eventType: "unsigned_prospect_rights_released",
    occurredAtMs: 1_000,
  });
  seedOwnershipEvent(database, {
    id: FIXTURE_IDS.blockedReleaseEvent,
    leagueId: FIXTURE_IDS.rightsLeague,
    seasonId: FIXTURE_IDS.rightsSeason,
    playerId: FIXTURE_IDS.blockedPlayer,
    eventType: "fantasy_elc_declined",
    occurredAtMs: 1_200,
  });
  seedOwnershipEvent(database, {
    id: FIXTURE_IDS.newerNoiseEvent,
    leagueId: FIXTURE_IDS.rightsLeague,
    seasonId: FIXTURE_IDS.rightsSeason,
    playerId: FIXTURE_IDS.blockedPlayer,
    eventType: "candidate_index_fixture_noise",
    occurredAtMs: 1_300,
  });

  insert(database, "entry_drafts", {
    id: FIXTURE_IDS.draft,
    league_id: FIXTURE_IDS.rightsLeague,
    season_id: FIXTURE_IDS.rightsSeason,
    status: "completed",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: 800,
    completed_at_ms: 900,
    created_by_user_id: FIXTURE_IDS.user,
    created_at_ms: 700,
    updated_at_ms: 900,
    version: 1,
  });
  insert(database, "draft_eligibility_snapshots", {
    id: FIXTURE_IDS.eligibilitySnapshot,
    league_id: FIXTURE_IDS.rightsLeague,
    draft_id: FIXTURE_IDS.draft,
    nhl_entry_draft_key: "2026",
    source_version: "candidate-index-fixture",
    snapshot_version: 1,
    status: "confirmed",
    confirmed_by_user_id: FIXTURE_IDS.user,
    confirmed_at_ms: 1_100,
    created_at_ms: 1_050,
  });
  insert(database, "draft_eligible_players", {
    id: FIXTURE_IDS.approvedEligibility,
    league_id: FIXTURE_IDS.rightsLeague,
    eligibility_snapshot_id: FIXTURE_IDS.eligibilitySnapshot,
    player_id: FIXTURE_IDS.approvedPlayer,
    position_group: "F",
    eligibility_reason: "rights_release_reentry",
    nhl_draft_year: null,
    nhl_round: null,
    nhl_overall_selection: null,
    rights_release_event_id: FIXTURE_IDS.approvedReleaseEvent,
    created_at_ms: 1_100,
  });

  insert(database, "matchup_weeks", {
    id: FIXTURE_IDS.matchupWeek,
    league_id: FIXTURE_IDS.fadLeague,
    season_id: FIXTURE_IDS.fadSeason,
    week_key: "W01",
    sequence: 1,
    starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    baseline_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 100,
    locks_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 200,
    ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 1_000,
    rolls_over_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 1_100,
    status: "scheduled",
    created_at_ms: 20,
    updated_at_ms: 20,
    version: 1,
  });
  const readinessOccurrenceKey =
    `fad:${FIXTURE_IDS.fadSeason}:readiness`;
  insert(database, "free_agent_draft_readiness_operations", {
    id: FIXTURE_IDS.readiness,
    league_id: FIXTURE_IDS.fadLeague,
    season_id: FIXTURE_IDS.fadSeason,
    readiness_occurrence_key: readinessOccurrenceKey,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    status: "pending",
    attempt_count: 0,
    blockers_json: "[]",
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  dropInsertTriggers(database, "free_agent_drafts");
  insert(database, "free_agent_drafts", {
    id: FIXTURE_IDS.fad,
    league_id: FIXTURE_IDS.fadLeague,
    season_id: FIXTURE_IDS.fadSeason,
    readiness_operation_id: FIXTURE_IDS.readiness,
    readiness_occurrence_key: readinessOccurrenceKey,
    first_matchup_week_id: FIXTURE_IDS.matchupWeek,
    current_competition_first_matchup_week_id:
      FIXTURE_IDS.matchupWeek,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "cards_open",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Candidate index migration fixture.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: HELP_OPENS_AT_MS,
    candidate_deadline_at_ms: CANDIDATE_DEADLINE_AT_MS,
    first_matchup_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    deadline_locked_at_ms: null,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  insert(database, "free_agent_draft_recoveries", {
    id: FIXTURE_IDS.recovery,
    league_id: FIXTURE_IDS.fadLeague,
    season_id: FIXTURE_IDS.fadSeason,
    fad_id: FIXTURE_IDS.fad,
    player_id: FIXTURE_IDS.recoveryPlayer,
    allocation_id: null,
    rollover_id: null,
    auction_id: null,
    job_run_id: null,
    kind: "allocation_retry",
    status: "pending",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: null,
    commissioner_reason: null,
    created_by_operation_id: null,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: OPENED_AT_MS + 1,
    updated_at_ms: OPENED_AT_MS + 1,
    resolved_at_ms: null,
    version: 1,
  });
}

function applicationRows(database) {
  const result = {};
  const tableNames = database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT IN ('application_metadata', 'schema_migrations')
      ORDER BY name
    `)
    .all()
    .map(({ name }) => name);
  for (const tableName of tableNames) {
    result[tableName] = database
      .prepare(`SELECT * FROM "${tableName}"`)
      .all();
  }
  return result;
}

function stableSchemaObjects(database) {
  return database
    .prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE type IN ('table', 'trigger', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all();
}

function indexColumns(database, indexName) {
  return database
    .pragma(`index_xinfo(${indexName})`)
    .filter(({ key }) => key === 1)
    .map(({ name, desc }) => ({ name, desc }));
}

function compactSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function assertIndexDefinition(database, expected) {
  const schemaRow = database
    .prepare(`
      SELECT tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE type = 'index' AND name = ?
    `)
    .get(expected.name);
  assert.equal(schemaRow?.tableName, expected.table);
  assert.deepEqual(
    indexColumns(database, expected.name),
    expected.columns
  );
  const listRow = database
    .pragma(`index_list(${expected.table})`)
    .find(({ name }) => name === expected.name);
  assert.equal(listRow?.partial, expected.partial);
  if (expected.predicatePattern) {
    assert.match(
      compactSql(schemaRow.sql),
      expected.predicatePattern
    );
  }
}

function queryPlan(database, sql, parameters) {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(parameters)
    .map(({ detail }) => detail);
}

function assertPlanUses(plan, indexName) {
  assert.ok(
    plan.some((detail) => detail.includes(indexName)),
    `expected query plan to use ${indexName}:\n${plan.join("\n")}`
  );
}

function assertHealthy(database) {
  assert.equal(
    database.pragma("integrity_check", { simple: true }),
    "ok"
  );
  assert.deepEqual(database.pragma("foreign_key_check"), []);
}

describe("Candidate eligibility-search index migration", () => {
  test("upgrades exact schema 33 additively and preserves every earlier ledger identity and application row", (t) => {
    const canonical = discoverMigrations({
      migrationsDirectory: CANONICAL_MIGRATIONS,
    });
    const migration34 = canonical.find(({ id }) => id === 34);
    assert.equal(
      migration34?.fileName,
      "0034_add_candidate_eligibility_search_indexes.sql"
    );

    const runtime = createRuntime(
      t,
      "hundo-candidate-eligibility-indexes-"
    );
    copyMigrations(runtime, 1, 33);
    migrate(runtime, "candidate-indexes-before");
    seedRepresentativeSchema33Rows(runtime.database);

    const ledgerBefore = runtime.database
      .prepare(`
        SELECT migration_id, file_name, checksum
        FROM schema_migrations
        ORDER BY migration_id
      `)
      .all();
    const rowsBefore = applicationRows(runtime.database);
    const schemaBefore = stableSchemaObjects(runtime.database);
    for (const expected of EXPECTED_INDEXES) {
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM sqlite_schema
            WHERE type = 'index' AND name = ?
          `)
          .get(expected.name).count,
        0
      );
    }

    copyMigrations(runtime, 34, 34);
    const result = migrate(runtime, "candidate-indexes-after");

    assert.equal(result.status, "exact");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      34
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT metadata_value AS metadataValue,
                 updated_at_ms AS updatedAtMs
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get(),
      { metadataValue: "34", updatedAtMs: 34 }
    );
    assert.deepEqual(applicationRows(runtime.database), rowsBefore);
    assert.deepEqual(
      stableSchemaObjects(runtime.database),
      schemaBefore
    );

    const ledgerAfter = runtime.database
      .prepare(`
        SELECT migration_id, file_name, checksum
        FROM schema_migrations
        ORDER BY migration_id
      `)
      .all();
    assert.deepEqual(ledgerAfter.slice(0, 33), ledgerBefore);
    assert.deepEqual(ledgerAfter[33], {
      migration_id: 34,
      file_name: migration34.fileName,
      checksum: migration34.checksum,
    });

    for (const expected of EXPECTED_INDEXES) {
      assertIndexDefinition(runtime.database, expected);
    }

    assert.equal(
      runtime.database
        .prepare(ORDERED_RELEASE_LOOKUP_SQL)
        .get({
          leagueId: FIXTURE_IDS.rightsLeague,
          playerId: FIXTURE_IDS.approvedPlayer,
        }),
      undefined
    );
    assert.deepEqual(
      runtime.database
        .prepare(ORDERED_RELEASE_LOOKUP_SQL)
        .get({
          leagueId: FIXTURE_IDS.rightsLeague,
          playerId: FIXTURE_IDS.blockedPlayer,
        }),
      { id: FIXTURE_IDS.blockedReleaseEvent }
    );
    assert.deepEqual(
      runtime.database
        .prepare(PLAYER_FAD_QUARANTINE_SQL)
        .get({
          leagueId: FIXTURE_IDS.fadLeague,
          playerId: FIXTURE_IDS.recoveryPlayer,
        }),
      { quarantine_kind: "recovery" }
    );

    const orderedReleasePlan = queryPlan(
      runtime.database,
      ORDERED_RELEASE_LOOKUP_SQL,
      {
        leagueId: FIXTURE_IDS.rightsLeague,
        playerId: FIXTURE_IDS.blockedPlayer,
      }
    );
    assertPlanUses(
      orderedReleasePlan,
      "ownership_events_candidate_release_by_player"
    );
    assertPlanUses(
      orderedReleasePlan,
      "draft_eligible_players_rights_release_reentry"
    );
    assert.equal(
      orderedReleasePlan.some((detail) =>
        detail.includes("USE TEMP B-TREE")
      ),
      false
    );

    const correlatedPlan = queryPlan(
      runtime.database,
      CORRELATED_ELIGIBILITY_PREDICATES_SQL,
      {
        leagueId: FIXTURE_IDS.rightsLeague,
        limit: 25,
      }
    );
    assertPlanUses(
      correlatedPlan,
      "ownership_events_candidate_release_by_player"
    );
    assertPlanUses(
      correlatedPlan,
      "draft_eligible_players_rights_release_reentry"
    );
    assertPlanUses(
      correlatedPlan,
      "free_agent_draft_recoveries_league_player_status"
    );

    const quarantinePlan = queryPlan(
      runtime.database,
      PLAYER_FAD_QUARANTINE_SQL,
      {
        leagueId: FIXTURE_IDS.fadLeague,
        playerId: FIXTURE_IDS.recoveryPlayer,
      }
    );
    assertPlanUses(
      quarantinePlan,
      "free_agent_draft_recoveries_league_player_status"
    );
    assertHealthy(runtime.database);
  });

  test("fresh schema 34 exposes all three exact Candidate lookup indexes", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-candidate-eligibility-indexes-fresh-"
    );
    copyMigrations(runtime, 1, 34);
    migrate(runtime, "candidate-indexes-fresh");

    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      34
    );
    for (const expected of EXPECTED_INDEXES) {
      assertIndexDefinition(runtime.database, expected);
    }
    assertHealthy(runtime.database);
  });
});
