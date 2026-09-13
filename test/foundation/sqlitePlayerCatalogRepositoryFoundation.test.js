const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createSqlitePlayerCatalogRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");

const ROOT = path.resolve(__dirname, "..", "..");
const PROVIDER = "sportsdataio-discovery-lab";
const FIRST_MATCHUP_STARTS_AT_MS = 2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 604_800_000;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 172_800_000;
const OPENED_AT_MS = HELP_OPENS_AT_MS - 10_000;
const CAPTURED_AT_MS = OPENED_AT_MS + 1_000;
const APPLIED_AT_MS = CAPTURED_AT_MS + 100;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  return database.prepare(`
    INSERT INTO ${tableName} (${columns.join(", ")})
    VALUES (${columns.map((column) => `@${column}`).join(", ")})
  `).run(values);
}

function dropInsertTriggers(database, tableName) {
  for (const { name } of database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'trigger'
      AND tbl_name = ?
      AND upper(sql) LIKE '%BEFORE INSERT%'
  `).all(tableName)) {
    database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
}

function createRuntime(t, prefix, { now = () => APPLIED_AT_MS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const connection = openDatabase({
    databasePath: path.join(root, "catalog.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: path.join(ROOT, "database", "migrations"),
    applicationBuildId: "player-catalog-fad-test",
    now: () => 1_000,
  });
  return {
    ...connection,
    repository: createSqlitePlayerCatalogRepository({
      database: connection.database,
      createId: nextIdFactory(),
      now,
    }),
  };
}

function nextIdFactory() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function catalogRow(overrides = {}) {
  return {
    providerPlayerId: "101",
    firstName: "Ada",
    lastName: "Skater",
    fullName: "Ada Skater",
    birthDate: "1998-02-03",
    status: "active",
    sourcePosition: "LW",
    normalizedPosition: "F",
    nhlTeamAbbreviation: "VAN",
    active: true,
    sourceVersion: "2025-04-18T12:00:00Z",
    sourceUpdatedAtMs: Date.parse("2025-04-18T12:00:00Z"),
    ...overrides,
  };
}

function seedCatalogPlayer(database, {
  base,
  providerPlayerId,
  normalizedPosition = "F",
  sourcePosition = "LW",
  status = "active",
  active = true,
} = {}) {
  const playerId = uuid(base);
  const sourceStateId = uuid(base + 1);
  insert(database, "players", {
    id: playerId,
    first_name: `Player${base}`,
    last_name: "Candidate",
    full_name: `Player${base} Candidate`,
    birth_date: "1998-02-03",
    status,
    created_at_ms: 30,
    updated_at_ms: 30,
    version: 1,
  });
  insert(database, "player_external_ids", {
    id: uuid(base + 2),
    player_id: playerId,
    provider: PROVIDER,
    external_value: providerPlayerId,
    created_at_ms: 30,
  });
  insert(database, "player_source_state", {
    id: sourceStateId,
    player_id: playerId,
    provider: PROVIDER,
    source_position: sourcePosition,
    normalized_position: normalizedPosition,
    nhl_team_abbreviation: "VAN",
    active: active ? 1 : 0,
    source_version: "before",
    source_payload_json: null,
    effective_at_ms: 30,
    ended_at_ms: null,
    created_at_ms: 30,
  });
  return Object.freeze({
    playerId,
    sourceStateId,
    providerPlayerId,
    firstName: `Player${base}`,
    fullName: `Player${base} Candidate`,
  });
}

function seedOpenFad(database, {
  base,
  player,
  teamCount = 1,
  positionOverride = null,
} = {}) {
  const managerUserId = uuid(base);
  const leagueId = uuid(base + 1);
  const seasonId = uuid(base + 2);
  const weekId = uuid(base + 3);
  const readinessId = uuid(base + 4);
  const fadId = uuid(base + 5);
  const managerMembershipId = uuid(base + 6);
  insert(database, "users", {
    id: managerUserId,
    email_normalized: `catalog-${base}@example.test`,
    email_display: `catalog-${base}@example.test`,
    display_name: `Catalog Manager ${base}`,
    display_name_normalized: `catalog manager ${base}`,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "leagues", {
    id: leagueId,
    name: `Catalog FAD League ${base}`,
    name_normalized: `catalog fad league ${base}`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: managerMembershipId,
    league_id: leagueId,
    user_id: managerUserId,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 10,
    ended_at_ms: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "seasons", {
    id: seasonId,
    league_id: leagueId,
    label: `Season ${base}`,
    nhl_season_key: `catalog-${base}`,
    status: "active",
    regular_season_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    regular_season_ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    fantasy_playoffs_start_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 8_000,
    fantasy_playoffs_end_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: weekId,
    league_id: leagueId,
    season_id: seasonId,
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
  const readinessOccurrenceKey = `fad:${seasonId}:readiness`;
  insert(database, "free_agent_draft_readiness_operations", {
    id: readinessId,
    league_id: leagueId,
    season_id: seasonId,
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
    id: fadId,
    league_id: leagueId,
    season_id: seasonId,
    readiness_operation_id: readinessId,
    readiness_occurrence_key: readinessOccurrenceKey,
    first_matchup_week_id: weekId,
    current_competition_first_matchup_week_id: weekId,
    schedule_recovery_id: null,
    participating_team_count: teamCount,
    status: "cards_open",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Catalog eligibility fixture.",
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

  const cardIds = [];
  for (let index = 0; index < teamCount; index += 1) {
    const offset = base + 20 + index * 6;
    const teamId = uuid(offset);
    const assignmentId = uuid(offset + 1);
    const participantId = uuid(offset + 2);
    const cardId = uuid(offset + 3);
    const entryId = uuid(offset + 4);
    insert(database, "teams", {
      id: teamId,
      league_id: leagueId,
      name: `Catalog Team ${base}-${index}`,
      name_normalized: `catalog team ${base}-${index}`,
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: 20,
      updated_at_ms: 20,
      version: 1,
    });
    insert(database, "team_manager_assignments", {
      id: assignmentId,
      league_id: leagueId,
      team_id: teamId,
      user_id: managerUserId,
      membership_id: managerMembershipId,
      assigned_by_user_id: managerUserId,
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: 20,
      accepted_at_ms: 20,
      ended_at_ms: null,
      version: 1,
    });
    dropInsertTriggers(database, "free_agent_draft_teams");
    insert(database, "free_agent_draft_teams", {
      id: participantId,
      league_id: leagueId,
      season_id: seasonId,
      fad_id: fadId,
      team_id: teamId,
      team_status_at_setup: "active",
      created_at_ms: OPENED_AT_MS,
    });
    dropInsertTriggers(database, "candidate_cards");
    insert(database, "candidate_cards", {
      id: cardId,
      league_id: leagueId,
      season_id: seasonId,
      fad_id: fadId,
      team_id: teamId,
      status: "open",
      completeness_code: "incomplete",
      filled_mandatory_count: 1,
      missing_mandatory_count: 17,
      filled_bench_count: 0,
      empty_bench_count: 4,
      blocking_validation_count: 0,
      structural_conflict_count: 0,
      maximum_possible_cap_cents: 600,
      locked_at_ms: null,
      created_at_ms: OPENED_AT_MS,
      updated_at_ms: OPENED_AT_MS,
      version: 1,
      cap_status: "compliant",
      allocation_eligibility: "eligible",
      allocation_exclusion_reason: null,
    });
    dropInsertTriggers(database, "candidate_card_entries");
    insert(database, "candidate_card_entries", {
      id: entryId,
      league_id: leagueId,
      season_id: seasonId,
      fad_id: fadId,
      card_id: cardId,
      team_id: teamId,
      entry_kind: "candidate",
      player_id: player.playerId,
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
      proposed_term_years: 1,
      proposed_aav_cents: 600,
      eligibility_status: "valid",
      validation_code: null,
      last_acknowledgement_revision_id: null,
      created_by_user_id: managerUserId,
      created_by_membership_id: managerMembershipId,
      created_by_authority: "manager",
      last_edited_by_user_id: managerUserId,
      last_edited_by_membership_id: managerMembershipId,
      last_edited_by_authority: "manager",
      created_at_ms: OPENED_AT_MS,
      updated_at_ms: OPENED_AT_MS,
      version: 1,
    });
    cardIds.push(cardId);
  }
  let positionOverrideId = null;
  if (positionOverride !== null) {
    positionOverrideId = uuid(base + 90);
    insert(database, "league_player_positions", {
      id: positionOverrideId,
      league_id: leagueId,
      player_id: player.playerId,
      position_group: positionOverride,
      reason: "Catalog eligibility fixture override.",
      corrected_by_user_id: managerUserId,
      effective_at_ms: 40,
      ended_at_ms: null,
      version: 1,
    });
  }
  return Object.freeze({
    leagueId,
    seasonId,
    fadId,
    cardIds: Object.freeze(cardIds),
    positionOverrideId,
  });
}

function updateRowFor(player, overrides = {}) {
  return catalogRow({
    providerPlayerId: player.providerPlayerId,
    firstName: player.firstName,
    lastName: "Candidate",
    fullName: player.fullName,
    sourceVersion: "after",
    sourceUpdatedAtMs: CAPTURED_AT_MS,
    ...overrides,
  });
}

test("SQLite player catalog persistence is transactional, idempotent, and keeps provider state history", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-player-catalog-"));
  const databasePath = path.join(root, "catalog.sqlite3");
  const connection = openDatabase({ databasePath, environment: "test" });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: path.join(ROOT, "database", "migrations"),
    applicationBuildId: "player-catalog-test",
    now: () => 1_700_000_000_000,
  });
  const repository = createSqlitePlayerCatalogRepository({
    database: connection.database,
    createId: nextIdFactory(),
    now: () => 1_700_000_000_100,
  });
  const command = {
    sourceOperationId: "10000000-0000-4000-8000-000000000001",
    provider: "sportsdataio-discovery-lab",
    capturedAtMs: 1_700_000_000_000,
    rows: [catalogRow(), catalogRow({
      providerPlayerId: "102",
      firstName: "Bea",
      lastName: "Defender",
      fullName: "Bea Defender",
      sourcePosition: "D",
      normalizedPosition: "D",
      nhlTeamAbbreviation: "EDM",
    })],
  };

  const first = repository.applyCatalog(command);
  assert.deepEqual(first, {
    sourceOperationId: command.sourceOperationId,
    requestHash: first.requestHash,
    createdPlayerCount: 2,
    sourceStateChangeCount: 2,
    updatedPlayerCount: 0,
    semanticChangedPlayerCount: 0,
    revalidationOccurrenceCount: 0,
  });
  assert.match(first.requestHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(repository.applyCatalog({
    ...command,
    rows: [...command.rows].reverse(),
  }), first);
  const secondOperation = repository.applyCatalog({
    ...command,
    sourceOperationId: "10000000-0000-4000-8000-000000000002",
    capturedAtMs: command.capturedAtMs + 1,
    rows: [catalogRow({
      nhlTeamAbbreviation: "SEA",
      sourceVersion: "2025-04-19T12:00:00Z",
    }), command.rows[1]],
  });
  assert.deepEqual(secondOperation, {
    sourceOperationId: secondOperation.sourceOperationId,
    requestHash: secondOperation.requestHash,
    createdPlayerCount: 0,
    sourceStateChangeCount: 1,
    updatedPlayerCount: 0,
    semanticChangedPlayerCount: 0,
    revalidationOccurrenceCount: 0,
  });

  assert.equal(
    connection.database.prepare("SELECT COUNT(*) AS count FROM players").get().count,
    2
  );
  assert.equal(
    connection.database.prepare("SELECT COUNT(*) AS count FROM player_external_ids").get().count,
    2
  );
  assert.equal(
    connection.database.prepare("SELECT COUNT(*) AS count FROM player_source_state").get().count,
    3
  );
  assert.deepEqual(
    connection.database.prepare(
      "SELECT nhl_team_abbreviation AS team FROM player_source_state WHERE ended_at_ms IS NULL ORDER BY player_id"
    ).all().map(({ team }) => team),
    ["SEA", "EDM"]
  );
});

test("provider apply creates revalidation only for Candidate semantic changes", (t) => {
  let runtime;
  let clockObservedInTransaction = false;
  runtime = createRuntime(t, "hundo-player-catalog-semantic-", {
    now: () => {
      clockObservedInTransaction = runtime.database.inTransaction;
      return APPLIED_AT_MS;
    },
  });
  const semanticPlayer = seedCatalogPlayer(runtime.database, {
    base: 100_000,
    providerPlayerId: "201",
  });
  const presentationPlayer = seedCatalogPlayer(runtime.database, {
    base: 101_000,
    providerPlayerId: "202",
  });
  const semanticFad = seedOpenFad(runtime.database, {
    base: 200_000,
    player: semanticPlayer,
  });
  seedOpenFad(runtime.database, {
    base: 201_000,
    player: presentationPlayer,
  });

  const result = runtime.repository.applyCatalog({
    sourceOperationId: uuid(900_001),
    provider: PROVIDER,
    capturedAtMs: CAPTURED_AT_MS,
    rows: [
      updateRowFor(semanticPlayer, {
        sourcePosition: "D",
        normalizedPosition: "D",
      }),
      updateRowFor(presentationPlayer, {
        firstName: "Renamed",
        fullName: "Renamed Candidate",
        sourcePosition: "RW",
        nhlTeamAbbreviation: "SEA",
      }),
    ],
  });

  assert.equal(clockObservedInTransaction, true);
  assert.deepEqual(result, {
    sourceOperationId: uuid(900_001),
    requestHash: result.requestHash,
    createdPlayerCount: 0,
    sourceStateChangeCount: 2,
    updatedPlayerCount: 1,
    semanticChangedPlayerCount: 1,
    revalidationOccurrenceCount: 1,
  });
  const occurrences = runtime.database.prepare(`
    SELECT player_id AS playerId, fad_id AS fadId,
      source_resolved_position_group_before AS sourceBefore,
      source_resolved_position_group_after AS sourceAfter,
      effective_position_group_before AS effectiveBefore,
      effective_position_group_after AS effectiveAfter
    FROM free_agent_draft_eligibility_revalidation_occurrences
  `).all();
  assert.deepEqual(occurrences, [{
    playerId: semanticPlayer.playerId,
    fadId: semanticFad.fadId,
    sourceBefore: "F",
    sourceAfter: "D",
    effectiveBefore: "F",
    effectiveAfter: "D",
  }]);
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM job_runs
      WHERE job_type = 'fad_eligibility_revalidation'
        AND status = 'pending'
    `).get().count,
    1
  );
});

test("provider apply deduplicates cards within one FAD and schedules every affected FAD", (t) => {
  const runtime = createRuntime(t, "hundo-player-catalog-multi-fad-");
  const player = seedCatalogPlayer(runtime.database, {
    base: 110_000,
    providerPlayerId: "301",
  });
  const firstFad = seedOpenFad(runtime.database, {
    base: 210_000,
    player,
    teamCount: 2,
  });
  const secondFad = seedOpenFad(runtime.database, {
    base: 220_000,
    player,
  });

  const result = runtime.repository.applyCatalog({
    sourceOperationId: uuid(900_002),
    provider: PROVIDER,
    capturedAtMs: CAPTURED_AT_MS,
    rows: [updateRowFor(player, {
      sourcePosition: "D",
      normalizedPosition: "D",
    })],
  });

  assert.equal(result.semanticChangedPlayerCount, 1);
  assert.equal(result.revalidationOccurrenceCount, 2);
  assert.deepEqual(
    runtime.database.prepare(`
      SELECT fad_id AS fadId, COUNT(*) AS count
      FROM free_agent_draft_eligibility_revalidation_occurrences
      GROUP BY fad_id
      ORDER BY fad_id
    `).all(),
    [firstFad.fadId, secondFad.fadId]
      .sort()
      .map((fadId) => ({ fadId, count: 1 }))
  );
});

test("player status changes schedule revalidation without inventing a source-state change", (t) => {
  const runtime = createRuntime(t, "hundo-player-catalog-status-");
  const player = seedCatalogPlayer(runtime.database, {
    base: 115_000,
    providerPlayerId: "351",
  });
  seedOpenFad(runtime.database, {
    base: 225_000,
    player,
  });

  const result = runtime.repository.applyCatalog({
    sourceOperationId: uuid(900_020),
    provider: PROVIDER,
    capturedAtMs: CAPTURED_AT_MS,
    rows: [updateRowFor(player, {
      status: "historical",
      sourceVersion: "before",
    })],
  });

  assert.equal(result.updatedPlayerCount, 1);
  assert.equal(result.sourceStateChangeCount, 0);
  assert.equal(result.semanticChangedPlayerCount, 1);
  assert.equal(result.revalidationOccurrenceCount, 1);
  assert.deepEqual(
    runtime.database.prepare(`
      SELECT
        player_version_before AS versionBefore,
        player_version_after AS versionAfter,
        player_status_before AS statusBefore,
        player_status_after AS statusAfter,
        source_state_before_id AS sourceBeforeId,
        source_state_after_id AS sourceAfterId
      FROM free_agent_draft_eligibility_revalidation_occurrences
    `).get(),
    {
      versionBefore: 1,
      versionAfter: 2,
      statusBefore: "active",
      statusAfter: "historical",
      sourceBeforeId: player.sourceStateId,
      sourceAfterId: player.sourceStateId,
    }
  );
});

test("a current league override masks a source-position delta only in that league", (t) => {
  const runtime = createRuntime(t, "hundo-player-catalog-override-");
  const player = seedCatalogPlayer(runtime.database, {
    base: 120_000,
    providerPlayerId: "401",
  });
  const maskedFad = seedOpenFad(runtime.database, {
    base: 230_000,
    player,
    positionOverride: "F",
  });
  const effectiveFad = seedOpenFad(runtime.database, {
    base: 240_000,
    player,
  });

  const result = runtime.repository.applyCatalog({
    sourceOperationId: uuid(900_003),
    provider: PROVIDER,
    capturedAtMs: CAPTURED_AT_MS,
    rows: [updateRowFor(player, {
      sourcePosition: "D",
      normalizedPosition: "D",
    })],
  });

  assert.equal(result.semanticChangedPlayerCount, 1);
  assert.equal(result.revalidationOccurrenceCount, 1);
  assert.deepEqual(
    runtime.database.prepare(`
      SELECT league_id AS leagueId, fad_id AS fadId,
        league_position_override_id AS overrideId
      FROM free_agent_draft_eligibility_revalidation_occurrences
    `).all(),
    [{
      leagueId: effectiveFad.leagueId,
      fadId: effectiveFad.fadId,
      overrideId: null,
    }]
  );
  assert.notEqual(maskedFad.leagueId, effectiveFad.leagueId);
});

test("provider semantic changes without an affected open card create no revalidation occurrence", (t) => {
  const runtime = createRuntime(t, "hundo-player-catalog-no-card-");
  const player = seedCatalogPlayer(runtime.database, {
    base: 130_000,
    providerPlayerId: "501",
  });

  const result = runtime.repository.applyCatalog({
    sourceOperationId: uuid(900_004),
    provider: PROVIDER,
    capturedAtMs: CAPTURED_AT_MS,
    rows: [updateRowFor(player, {
      status: "historical",
    })],
  });

  assert.equal(result.semanticChangedPlayerCount, 1);
  assert.equal(result.revalidationOccurrenceCount, 0);
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_draft_eligibility_revalidation_occurrences
    `).get().count,
    0
  );
});

test("provider apply replay is byte-stable and a changed request conflicts without writes", (t) => {
  const runtime = createRuntime(t, "hundo-player-catalog-replay-");
  const player = seedCatalogPlayer(runtime.database, {
    base: 140_000,
    providerPlayerId: "601",
  });
  seedOpenFad(runtime.database, {
    base: 250_000,
    player,
  });
  const command = {
    sourceOperationId: uuid(900_005),
    provider: PROVIDER,
    capturedAtMs: CAPTURED_AT_MS,
    rows: [updateRowFor(player, {
      sourcePosition: "D",
      normalizedPosition: "D",
    })],
  };

  const first = runtime.repository.applyCatalog(command);
  const changesBeforeReplay = runtime.database
    .prepare("SELECT total_changes() AS count")
    .get().count;
  const replay = runtime.repository.applyCatalog(command);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(
    runtime.database.prepare("SELECT total_changes() AS count").get().count,
    changesBeforeReplay
  );

  assert.throws(
    () => runtime.repository.applyCatalog({
      ...command,
      rows: [updateRowFor(player, {
        sourcePosition: "D",
        normalizedPosition: "D",
        nhlTeamAbbreviation: "SEA",
      })],
    }),
    (error) =>
      error?.code === "PLAYER_CATALOG_IDEMPOTENCY_CONFLICT"
  );
  assert.equal(
    runtime.database.prepare("SELECT total_changes() AS count").get().count,
    changesBeforeReplay
  );
  assert.deepEqual(
    runtime.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM operational_events
          WHERE event_type = 'player_catalog_applied') AS eventCount,
        (SELECT COUNT(*) FROM free_agent_draft_eligibility_revalidation_occurrences)
          AS occurrenceCount,
        (SELECT COUNT(*) FROM job_runs
          WHERE job_type = 'fad_eligibility_revalidation') AS jobCount
    `).get(),
    { eventCount: 1, occurrenceCount: 1, jobCount: 1 }
  );
});

test("provider apply rolls back player, source, occurrence, job, and event writes on every late seal failure", (t) => {
  const failures = [
    ["occurrence", "free_agent_draft_eligibility_revalidation_occurrences"],
    ["job", "job_runs"],
    ["event", "operational_events"],
  ];
  for (const [phase, tableName] of failures) {
    const runtime = createRuntime(t, `hundo-player-catalog-rollback-${phase}-`);
    const player = seedCatalogPlayer(runtime.database, {
      base: 150_000 + failures.findIndex(([name]) => name === phase) * 1_000,
      providerPlayerId: String(701 + failures.findIndex(([name]) => name === phase)),
    });
    seedOpenFad(runtime.database, {
      base: 260_000 + failures.findIndex(([name]) => name === phase) * 1_000,
      player,
    });
    runtime.database.exec(`
      CREATE TRIGGER test_catalog_${phase}_failure
      BEFORE INSERT ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, 'test catalog ${phase} failure');
      END
    `);

    assert.throws(
      () => runtime.repository.applyCatalog({
        sourceOperationId: uuid(900_010 + failures.findIndex(([name]) => name === phase)),
        provider: PROVIDER,
        capturedAtMs: CAPTURED_AT_MS,
        rows: [updateRowFor(player, {
          sourcePosition: "D",
          normalizedPosition: "D",
        })],
      }),
      new RegExp(`test catalog ${phase} failure`)
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT status, version
        FROM players
        WHERE id = ?
      `).get(player.playerId),
      { status: "active", version: 1 }
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT id, normalized_position AS positionGroup, ended_at_ms AS endedAtMs
        FROM player_source_state
        WHERE player_id = ?
      `).all(player.playerId),
      [{
        id: player.sourceStateId,
        positionGroup: "F",
        endedAtMs: null,
      }]
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM operational_events
            WHERE event_type = 'player_catalog_applied') AS eventCount,
          (SELECT COUNT(*) FROM free_agent_draft_eligibility_revalidation_occurrences)
            AS occurrenceCount,
          (SELECT COUNT(*) FROM job_runs
            WHERE job_type = 'fad_eligibility_revalidation') AS jobCount
      `).get(),
      { eventCount: 0, occurrenceCount: 0, jobCount: 0 }
    );
  }
});
