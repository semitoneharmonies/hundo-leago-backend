const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  addLocalDays,
} = require("../../src/domain/matchups/matchupSchedulePolicy");
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
const MIGRATION_FILE_NAME =
  "0028_add_final_standings_provenance.sql";
const RESULT_SET_HASH = "a".repeat(64);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_STARTS_AT_MS = 1_791_183_600_000;
const WEEK_ENDS_AT_MS = WEEK_STARTS_AT_MS + WEEK_MS;
const FINALIZED_AT_MS = WEEK_ENDS_AT_MS + 1_000;
const COMPLETED_AT_MS = FINALIZED_AT_MS;
const CORRECTION_AT_MS = FINALIZED_AT_MS + 2;
const SECOND_CORRECTION_AT_MS = CORRECTION_AT_MS + 1_000;
const LORD_HOWE_WEEK_STARTS_AT_MS = Date.parse(
  "2026-09-28T13:30:00.000Z"
);
const LORD_HOWE_WEEK_ENDS_AT_MS = Date.parse(
  "2026-10-05T13:00:00.000Z"
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

function assertDatabaseHealthy(database) {
  assert.equal(
    database.pragma("integrity_check", { simple: true }),
    "ok"
  );
  assert.deepEqual(database.pragma("foreign_key_check"), []);
}

function createRuntime(t, maximumMigrationId = 28) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-standings-0028-")
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "standings-provenance.sqlite3"
    ),
    environment: "test",
  });
  const migrations = discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  });
  const selectedMigrations = migrations.filter(
    ({ id }) => id <= maximumMigrationId
  );
  const migrationState = applyMigrations({
    database: connection.database,
    migrations: selectedMigrations,
    applicationBuildId: `standings-0028-through-${maximumMigrationId}`,
    now: () => maximumMigrationId,
  });

  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });

  return {
    database: connection.database,
    migrationState,
    migrations,
  };
}

function scopeIds(base) {
  return Object.freeze({
    user: uuid(base + 1),
    league: uuid(base + 2),
    membership: uuid(base + 3),
    season: uuid(base + 4),
    homeTeam: uuid(base + 5),
    awayTeam: uuid(base + 6),
    week: uuid(base + 7),
    matchup: uuid(base + 8),
    statSource: uuid(base + 9),
    statRefresh: uuid(base + 10),
    statSnapshot: uuid(base + 11),
    matchupResult: uuid(base + 12),
    resultVersion: uuid(base + 13),
    standingsSnapshot: uuid(base + 14),
    homeRow: uuid(base + 15),
    awayRow: uuid(base + 16),
    homeIdentity: uuid(base + 17),
    awayIdentity: uuid(base + 18),
    resultLink: uuid(base + 19),
    idempotency: uuid(base + 20),
    standingsOperation: uuid(base + 21),
    finalization: uuid(base + 22),
    laterSnapshot: uuid(base + 23),
    correctedResultVersion: uuid(base + 24),
    replacementIdempotency: uuid(base + 25),
    replacementOperation: uuid(base + 26),
    replacementFinalization: uuid(base + 27),
    replacementHomeRow: uuid(base + 28),
    replacementAwayRow: uuid(base + 29),
    replacementHomeIdentity: uuid(base + 30),
    replacementAwayIdentity: uuid(base + 31),
    replacementResultLink: uuid(base + 32),
    omittedWeek: uuid(base + 33),
    otherSeason: uuid(base + 34),
    otherWeek: uuid(base + 35),
    crossSeasonBye: uuid(base + 36),
    scheduleOperation: uuid(base + 37),
    omittedTeam: uuid(base + 38),
    ambiguousScheduleOperation: uuid(base + 39),
    resultCorrectionOperation: uuid(base + 40),
    duplicateResultCorrectionOperation: uuid(base + 41),
    thirdResultVersion: uuid(base + 42),
    secondResultCorrectionOperation: uuid(base + 43),
    secondReplacementIdempotency: uuid(base + 44),
    secondReplacementSnapshot: uuid(base + 45),
    secondReplacementHomeRow: uuid(base + 46),
    secondReplacementAwayRow: uuid(base + 47),
    secondReplacementHomeIdentity: uuid(base + 48),
    secondReplacementAwayIdentity: uuid(base + 49),
    secondReplacementResultLink: uuid(base + 50),
    secondReplacementOperation: uuid(base + 51),
    secondReplacementFinalization: uuid(base + 52),
  });
}

function scheduleMetadata(ids, overrides = {}) {
  return JSON.stringify({
    participantCount: 2,
    participantTeamIds: [
      ids.homeTeam,
      ids.awayTeam,
    ].sort(),
    weekCount: 1,
    matchupCount: 1,
    jobOccurrenceCount: 0,
    ...overrides,
  });
}

function seedQualifyingSeason(
  database,
  base = 1_000,
  {
    leagueTimezone = "America/Vancouver",
    weekStartsAtMs = WEEK_STARTS_AT_MS,
    weekEndsAtMs = WEEK_ENDS_AT_MS,
    scheduleMetadataJson,
  } = {}
) {
  const ids = scopeIds(base);
  const label = `scope-${base}`;
  const nhlRegularStartsAtMs =
    weekStartsAtMs - 2 * 24 * 60 * 60 * 1000;

  insert(database, "users", {
    id: ids.user,
    email_normalized: `${label}@example.test`,
    email_display: `${label}@example.test`,
    display_name: `Commissioner ${base}`,
    display_name_normalized: `commissioner ${base}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `League ${base}`,
    name_normalized: `league ${base}`,
    status: "active",
    timezone: leagueTimezone,
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_settings", {
    league_id: ids.league,
    salary_cap_cents: 10_000,
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
  insert(database, "league_memberships", {
    id: ids.membership,
    league_id: ids.league,
    user_id: ids.user,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `2026-27-${base}`,
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: nhlRegularStartsAtMs,
    regular_season_ends_at_ms: weekEndsAtMs,
    fantasy_playoffs_start_at_ms: weekEndsAtMs,
    fantasy_playoffs_end_at_ms:
      weekEndsAtMs + 2 * WEEK_MS,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  database
    .prepare(`
      UPDATE leagues
      SET commissioner_membership_id = ?,
          current_season_id = ?,
          updated_at_ms = 2,
          version = 2
      WHERE id = ?
    `)
    .run(ids.membership, ids.season, ids.league);

  const insertTeam = database.prepare(`
    INSERT INTO teams (
      id,
      league_id,
      name,
      name_normalized,
      status,
      primary_colour,
      secondary_colour,
      logo_reference,
      created_at_ms,
      updated_at_ms,
      version,
      tertiary_colour,
      pattern_template
    ) VALUES (
      @id,
      @league_id,
      @name,
      @name_normalized,
      'active',
      @primary_colour,
      @secondary_colour,
      NULL,
      1,
      1,
      1,
      NULL,
      'even-two'
    )
  `);
  insertTeam.run({
    id: ids.homeTeam,
    league_id: ids.league,
    name: `Home ${base}`,
    name_normalized: `home ${base}`,
    primary_colour: "#112233",
    secondary_colour: "#445566",
  });
  insertTeam.run({
    id: ids.awayTeam,
    league_id: ids.league,
    name: `Away ${base}`,
    name_normalized: `away ${base}`,
    primary_colour: "#223344",
    secondary_colour: "#556677",
  });

  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
    week_key: "regular-01",
    sequence: 1,
    starts_at_ms: weekStartsAtMs,
    baseline_at_ms: weekStartsAtMs + 60 * 60 * 1000,
    locks_at_ms:
      weekStartsAtMs + 16 * 60 * 60 * 1000,
    ends_at_ms: weekEndsAtMs,
    rolls_over_at_ms: weekEndsAtMs,
    status: "final",
    created_at_ms: 1,
    updated_at_ms: weekEndsAtMs,
    version: 2,
  });
  insert(database, "matchups", {
    id: ids.matchup,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: ids.week,
    home_team_id: ids.homeTeam,
    away_team_id: ids.awayTeam,
    home_team_name: `Home ${base}`,
    away_team_name: `Away ${base}`,
    status: "final",
    created_at_ms: 1,
    updated_at_ms: weekEndsAtMs,
    version: 2,
  });
  insert(database, "matchup_operations", {
    id: ids.scheduleOperation,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: null,
    matchup_id: null,
    actor_user_id: ids.user,
    operation_type: "schedule_generate",
    status: "succeeded",
    reason: null,
    metadata_json:
      scheduleMetadataJson ??
      scheduleMetadata(ids),
    started_at_ms: 1,
    completed_at_ms: 1,
  });
  insert(database, "stat_sources", {
    id: ids.statSource,
    provider: `test-provider-${base}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "stat_refreshes", {
    id: ids.statRefresh,
    stat_source_id: ids.statSource,
    nhl_season_key: "20262027",
    source_version: `final-${base}`,
    status: "succeeded",
    started_at_ms: weekEndsAtMs - 50_000,
    completed_at_ms: weekEndsAtMs,
    player_count: 0,
    error_code: null,
    metadata_json: null,
    version: 1,
  });
  insert(database, "stat_snapshots", {
    id: ids.statSnapshot,
    stat_source_id: ids.statSource,
    source_refresh_id: ids.statRefresh,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: ids.week,
    intended_use: "matchup_final",
    completeness_status: "complete",
    freshness_status: "fresh",
    captured_at_ms: weekEndsAtMs,
    committed: 1,
    created_at_ms: weekEndsAtMs,
  });
  insert(database, "matchup_results", {
    id: ids.matchupResult,
    league_id: ids.league,
    season_id: ids.season,
    matchup_id: ids.matchup,
    current_version_id: null,
    status: "pending",
    finalized_at_ms: null,
    created_at_ms: weekEndsAtMs,
    updated_at_ms: weekEndsAtMs,
    version: 1,
  });
  insert(database, "matchup_result_versions", {
    id: ids.resultVersion,
    league_id: ids.league,
    season_id: ids.season,
    matchup_result_id: ids.matchupResult,
    version_number: 1,
    home_team_id: ids.homeTeam,
    away_team_id: ids.awayTeam,
    home_score_hundredths: 500,
    away_score_hundredths: 300,
    outcome: "home_win",
    source_snapshot_id: ids.statSnapshot,
    source_type: "calculated",
    actor_user_id: null,
    reason: null,
    supersedes_version_id: null,
    created_at_ms: weekEndsAtMs,
  });
  database
    .prepare(`
      UPDATE matchup_results
      SET current_version_id = @resultVersionId,
          status = 'official',
          finalized_at_ms = @weekEndsAtMs,
          updated_at_ms = @weekEndsAtMs,
          version = 2
      WHERE id = @matchupResultId
    `)
    .run({
      resultVersionId: ids.resultVersion,
      weekEndsAtMs,
      matchupResultId: ids.matchupResult,
    });

  return ids;
}

function insertStartedIdempotency(database, ids) {
  insert(database, "idempotency_requests", {
    id: ids.idempotency,
    league_id: ids.league,
    actor_user_id: ids.user,
    operation: "standings.finalize_regular_season.v1",
    client_key: "standings-finalization",
    request_hash: "b".repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: FINALIZED_AT_MS - 100,
    completed_at_ms: null,
    expires_at_ms: FINALIZED_AT_MS + 86_400_000,
  });
}

function insertFinalSnapshot(database, ids) {
  insert(database, "standings_snapshots", {
    id: ids.standingsSnapshot,
    league_id: ids.league,
    season_id: ids.season,
    snapshot_version: 1,
    source_result_version: 1,
    status: "final",
    calculated_at_ms: FINALIZED_AT_MS,
    created_at_ms: FINALIZED_AT_MS,
  });
}

function insertStandingsRows(database, ids) {
  insert(database, "standings_rows", {
    id: ids.homeRow,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.standingsSnapshot,
    team_id: ids.homeTeam,
    rank: 1,
    wins: 1,
    losses: 0,
    ties: 0,
    standings_points: 2,
    fantasy_points_for_hundredths: 500,
    fantasy_points_against_hundredths: 300,
    fantasy_point_differential_hundredths: 200,
    created_at_ms: FINALIZED_AT_MS,
  });
  insert(database, "standings_rows", {
    id: ids.awayRow,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.standingsSnapshot,
    team_id: ids.awayTeam,
    rank: 2,
    wins: 0,
    losses: 1,
    ties: 0,
    standings_points: 0,
    fantasy_points_for_hundredths: 300,
    fantasy_points_against_hundredths: 500,
    fantasy_point_differential_hundredths: -200,
    created_at_ms: FINALIZED_AT_MS,
  });
}

function resultLinkRecord(ids, overrides = {}) {
  return {
    id: ids.resultLink,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.standingsSnapshot,
    matchup_week_id: ids.week,
    matchup_id: ids.matchup,
    matchup_result_id: ids.matchupResult,
    matchup_result_version_id: ids.resultVersion,
    result_version_number: 1,
    created_at_ms: FINALIZED_AT_MS,
    ...overrides,
  };
}

function insertTeamIdentity(database, ids, team) {
  const home = team === "home";
  insert(database, "standings_snapshot_team_identities", {
    id: home ? ids.homeIdentity : ids.awayIdentity,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.standingsSnapshot,
    team_id: home ? ids.homeTeam : ids.awayTeam,
    team_display_name: home ? "Home final" : "Away final",
    primary_colour: home ? "#112233" : "#223344",
    secondary_colour: home ? "#445566" : "#556677",
    tertiary_colour: null,
    pattern_template: "even-two",
    source_logo_object_id: null,
    logo_media_type: null,
    logo_byte_length: null,
    logo_width: null,
    logo_height: null,
    logo_content_sha256: null,
    logo_content_bytes: null,
    created_at_ms: FINALIZED_AT_MS,
  });
}

function insertSucceededOperation(database, ids) {
  insert(database, "standings_operations", {
    id: ids.standingsOperation,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.standingsSnapshot,
    actor_user_id: ids.user,
    actor_membership_id: ids.membership,
    actor_authority: "commissioner",
    operation_type: "finalize_regular_season",
    status: "succeeded",
    reason: null,
    metadata_json: JSON.stringify({
      evidenceSchemaVersion: 1,
    }),
    idempotency_request_id: ids.idempotency,
    started_at_ms: FINALIZED_AT_MS - 100,
    completed_at_ms: FINALIZED_AT_MS,
  });
}

function finalizationRecord(ids, overrides = {}) {
  return {
    id: ids.finalization,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.standingsSnapshot,
    finalization_version: 1,
    evidence_schema_version: 1,
    status: "final",
    cause: "regular_season_completion",
    standings_rule_version: 1,
    result_set_hash: RESULT_SET_HASH,
    result_set_hash_version: 1,
    expected_matchup_count: 1,
    finalized_matchup_count: 1,
    expected_week_count: 1,
    weeks_counted: 1,
    participant_count: 2,
    standings_row_count: 2,
    completeness_status: "complete",
    season_version_before: 1,
    season_version_after: 2,
    authorized_by_user_id: ids.user,
    authorized_by_membership_id: ids.membership,
    authorized_authority: "commissioner",
    standings_operation_id: ids.standingsOperation,
    idempotency_request_id: ids.idempotency,
    replaces_finalization_id: null,
    superseded_by_snapshot_id: null,
    superseded_by_user_id: null,
    superseded_by_membership_id: null,
    superseded_by_authority: null,
    superseded_by_operation_id: null,
    superseded_at_ms: null,
    finalized_at_ms: FINALIZED_AT_MS,
    created_at_ms: FINALIZED_AT_MS,
    updated_at_ms: FINALIZED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function completeIdempotency(
  database,
  ids,
  completedAtMs = COMPLETED_AT_MS
) {
  return database
    .prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type = 'standings_finalization',
          result_id = ?,
          completed_at_ms = ?
      WHERE league_id = ?
        AND id = ?
        AND status = 'started'
    `)
    .run(
      ids.finalization,
      completedAtMs,
      ids.league,
      ids.idempotency
    );
}

function stageCompleteEvidence(
  database,
  ids,
  {
    resultVersionId = ids.resultVersion,
    resultVersionNumber = 1,
  } = {}
) {
  insertStartedIdempotency(database, ids);
  insertFinalSnapshot(database, ids);
  insertStandingsRows(database, ids);
  insert(
    database,
    "standings_snapshot_result_versions",
    resultLinkRecord(ids, {
      matchup_result_version_id: resultVersionId,
      result_version_number: resultVersionNumber,
    })
  );
  insertTeamIdentity(database, ids, "home");
  insertTeamIdentity(database, ids, "away");
  insertSucceededOperation(database, ids);
}

function insertCorrectedResultVersion(
  database,
  ids,
  overrides = {}
) {
  insert(database, "matchup_result_versions", {
    id: ids.correctedResultVersion,
    league_id: ids.league,
    season_id: ids.season,
    matchup_result_id: ids.matchupResult,
    version_number: 2,
    home_team_id: ids.homeTeam,
    away_team_id: ids.awayTeam,
    home_score_hundredths: 450,
    away_score_hundredths: 300,
    outcome: "home_win",
    source_snapshot_id: ids.statSnapshot,
    source_type: "correction",
    actor_user_id: ids.user,
    reason: "Test correction",
    supersedes_version_id: ids.resultVersion,
    created_at_ms: CORRECTION_AT_MS,
    ...overrides,
  });
}

function insertResultCorrectionOperation(
  database,
  ids,
  {
    id = ids.resultCorrectionOperation,
    actorUserId = ids.user,
    reason = "Test correction",
    metadataJson = JSON.stringify({
      resultId: ids.matchupResult,
      resultVersionId: ids.correctedResultVersion,
    }),
    completedAtMs = CORRECTION_AT_MS,
  } = {}
) {
  insert(database, "matchup_operations", {
    id,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: ids.week,
    matchup_id: ids.matchup,
    actor_user_id: actorUserId,
    operation_type: "result_correct",
    status: "succeeded",
    reason,
    metadata_json: metadataJson,
    started_at_ms: completedAtMs,
    completed_at_ms: completedAtMs,
  });
}

function selectCorrectedResultVersion(database, ids) {
  return database
    .prepare(`
      UPDATE matchup_results
      SET current_version_id = ?,
          status = 'corrected',
          updated_at_ms = ${CORRECTION_AT_MS},
          version = version + 1
      WHERE league_id = ?
        AND season_id = ?
        AND id = ?
    `)
    .run(
      ids.correctedResultVersion,
      ids.league,
      ids.season,
      ids.matchupResult
    );
}

function insertStartedCorrectionIdempotency(database, ids) {
  insert(database, "idempotency_requests", {
    id: ids.replacementIdempotency,
    league_id: ids.league,
    actor_user_id: ids.user,
    operation: "matchup.result.correct.v1",
    client_key: "matchup-result-correction",
    request_hash: "d".repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: CORRECTION_AT_MS,
    completed_at_ms: null,
    expires_at_ms: CORRECTION_AT_MS + 86_400_000,
  });
}

function insertReplacementSnapshot(database, ids) {
  insert(database, "standings_snapshots", {
    id: ids.laterSnapshot,
    league_id: ids.league,
    season_id: ids.season,
    snapshot_version: 2,
    source_result_version: 2,
    status: "final",
    calculated_at_ms: CORRECTION_AT_MS,
    created_at_ms: CORRECTION_AT_MS,
  });
}

function insertReplacementRows(database, ids) {
  insert(database, "standings_rows", {
    id: ids.replacementHomeRow,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.laterSnapshot,
    team_id: ids.homeTeam,
    rank: 1,
    wins: 1,
    losses: 0,
    ties: 0,
    standings_points: 2,
    fantasy_points_for_hundredths: 450,
    fantasy_points_against_hundredths: 300,
    fantasy_point_differential_hundredths: 150,
    created_at_ms: CORRECTION_AT_MS,
  });
  insert(database, "standings_rows", {
    id: ids.replacementAwayRow,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.laterSnapshot,
    team_id: ids.awayTeam,
    rank: 2,
    wins: 0,
    losses: 1,
    ties: 0,
    standings_points: 0,
    fantasy_points_for_hundredths: 300,
    fantasy_points_against_hundredths: 450,
    fantasy_point_differential_hundredths: -150,
    created_at_ms: CORRECTION_AT_MS,
  });
}

function insertReplacementIdentities(database, ids) {
  for (const team of ["home", "away"]) {
    const home = team === "home";
    insert(database, "standings_snapshot_team_identities", {
      id: home
        ? ids.replacementHomeIdentity
        : ids.replacementAwayIdentity,
      league_id: ids.league,
      season_id: ids.season,
      standings_snapshot_id: ids.laterSnapshot,
      team_id: home ? ids.homeTeam : ids.awayTeam,
      team_display_name: home ? "Home corrected" : "Away corrected",
      primary_colour: home ? "#112233" : "#223344",
      secondary_colour: home ? "#445566" : "#556677",
      tertiary_colour: null,
      pattern_template: "even-two",
      source_logo_object_id: null,
      logo_media_type: null,
      logo_byte_length: null,
      logo_width: null,
      logo_height: null,
      logo_content_sha256: null,
      logo_content_bytes: null,
      created_at_ms: CORRECTION_AT_MS,
    });
  }
}

function insertReplacementResultLink(database, ids) {
  insert(database, "standings_snapshot_result_versions", {
    id: ids.replacementResultLink,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.laterSnapshot,
    matchup_week_id: ids.week,
    matchup_id: ids.matchup,
    matchup_result_id: ids.matchupResult,
    matchup_result_version_id: ids.correctedResultVersion,
    result_version_number: 2,
    created_at_ms: CORRECTION_AT_MS,
  });
}

function insertCorrectionOperation(
  database,
  ids,
  operationType = "correction_propagation"
) {
  insert(database, "standings_operations", {
    id: ids.replacementOperation,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.laterSnapshot,
    actor_user_id: ids.user,
    actor_membership_id: ids.membership,
    actor_authority: "commissioner",
    operation_type: operationType,
    status: "succeeded",
    reason: "Correct final matchup result",
    metadata_json: JSON.stringify({
      evidenceSchemaVersion: 1,
    }),
    idempotency_request_id: ids.replacementIdempotency,
    started_at_ms: CORRECTION_AT_MS,
    completed_at_ms: CORRECTION_AT_MS,
  });
}

function replacementFinalizationRecord(
  ids,
  overrides = {}
) {
  return finalizationRecord(ids, {
    id: ids.replacementFinalization,
    standings_snapshot_id: ids.laterSnapshot,
    finalization_version: 2,
    cause: "result_correction",
    result_set_hash: "c".repeat(64),
    season_version_before: 2,
    season_version_after: 3,
    standings_operation_id: ids.replacementOperation,
    idempotency_request_id: ids.replacementIdempotency,
    replaces_finalization_id: ids.finalization,
    finalized_at_ms: CORRECTION_AT_MS,
    created_at_ms: CORRECTION_AT_MS,
    updated_at_ms: CORRECTION_AT_MS,
    ...overrides,
  });
}

function supersedeInitialFinalization(database, ids) {
  return database
    .prepare(`
      UPDATE standings_snapshot_finalizations
      SET status = 'superseded',
          superseded_by_snapshot_id = ?,
          superseded_by_user_id = ?,
          superseded_by_membership_id = ?,
          superseded_by_authority = 'commissioner',
          superseded_by_operation_id = ?,
          superseded_at_ms = ${CORRECTION_AT_MS},
          updated_at_ms = ${CORRECTION_AT_MS},
          version = version + 1
      WHERE league_id = ?
        AND id = ?
        AND status = 'final'
    `)
    .run(
      ids.laterSnapshot,
      ids.user,
      ids.membership,
      ids.replacementOperation,
      ids.league,
      ids.finalization
    );
}

function completeCorrectionIdempotency(database, ids) {
  return database
    .prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type = 'matchup_result_correction',
          result_id = ?,
          completed_at_ms = ${CORRECTION_AT_MS}
      WHERE league_id = ?
        AND id = ?
        AND status = 'started'
    `)
    .run(
      ids.correctedResultVersion,
      ids.league,
      ids.replacementIdempotency
    );
}

function commitInitialCanonicalFinalization(database, ids) {
  stageCompleteEvidence(database, ids);
  insert(
    database,
    "standings_snapshot_finalizations",
    finalizationRecord(ids)
  );
  database
    .prepare(`
      UPDATE seasons
      SET version = 2,
          updated_at_ms = ${COMPLETED_AT_MS}
      WHERE league_id = ?
        AND id = ?
        AND version = 1
    `)
    .run(ids.league, ids.season);
  return completeIdempotency(database, ids);
}

function commitSecondCorrectionReplacement(database, ids) {
  insert(database, "matchup_result_versions", {
    id: ids.thirdResultVersion,
    league_id: ids.league,
    season_id: ids.season,
    matchup_result_id: ids.matchupResult,
    version_number: 3,
    home_team_id: ids.homeTeam,
    away_team_id: ids.awayTeam,
    home_score_hundredths: 400,
    away_score_hundredths: 300,
    outcome: "home_win",
    source_snapshot_id: ids.statSnapshot,
    source_type: "correction",
    actor_user_id: ids.user,
    reason: "Second test correction",
    supersedes_version_id: ids.correctedResultVersion,
    created_at_ms: SECOND_CORRECTION_AT_MS,
  });
  insert(database, "matchup_operations", {
    id: ids.secondResultCorrectionOperation,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: ids.week,
    matchup_id: ids.matchup,
    actor_user_id: ids.user,
    operation_type: "result_correct",
    status: "succeeded",
    reason: "Second test correction",
    metadata_json: JSON.stringify({
      resultId: ids.matchupResult,
      resultVersionId: ids.thirdResultVersion,
    }),
    started_at_ms: SECOND_CORRECTION_AT_MS,
    completed_at_ms: SECOND_CORRECTION_AT_MS,
  });
  insert(database, "idempotency_requests", {
    id: ids.secondReplacementIdempotency,
    league_id: ids.league,
    actor_user_id: ids.user,
    operation: "matchup.result.correct.v1",
    client_key: "second-matchup-result-correction",
    request_hash: "e".repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: SECOND_CORRECTION_AT_MS,
    completed_at_ms: null,
    expires_at_ms:
      SECOND_CORRECTION_AT_MS + 86_400_000,
  });
  insert(database, "standings_snapshots", {
    id: ids.secondReplacementSnapshot,
    league_id: ids.league,
    season_id: ids.season,
    snapshot_version: 3,
    source_result_version: 3,
    status: "final",
    calculated_at_ms: SECOND_CORRECTION_AT_MS,
    created_at_ms: SECOND_CORRECTION_AT_MS,
  });
  for (const home of [true, false]) {
    insert(database, "standings_rows", {
      id: home
        ? ids.secondReplacementHomeRow
        : ids.secondReplacementAwayRow,
      league_id: ids.league,
      season_id: ids.season,
      standings_snapshot_id:
        ids.secondReplacementSnapshot,
      team_id: home ? ids.homeTeam : ids.awayTeam,
      rank: home ? 1 : 2,
      wins: home ? 1 : 0,
      losses: home ? 0 : 1,
      ties: 0,
      standings_points: home ? 2 : 0,
      fantasy_points_for_hundredths: home ? 400 : 300,
      fantasy_points_against_hundredths: home ? 300 : 400,
      fantasy_point_differential_hundredths:
        home ? 100 : -100,
      created_at_ms: SECOND_CORRECTION_AT_MS,
    });
    insert(database, "standings_snapshot_team_identities", {
      id: home
        ? ids.secondReplacementHomeIdentity
        : ids.secondReplacementAwayIdentity,
      league_id: ids.league,
      season_id: ids.season,
      standings_snapshot_id:
        ids.secondReplacementSnapshot,
      team_id: home ? ids.homeTeam : ids.awayTeam,
      team_display_name: home
        ? "Home corrected twice"
        : "Away corrected twice",
      primary_colour: home ? "#112233" : "#223344",
      secondary_colour: home ? "#445566" : "#556677",
      tertiary_colour: null,
      pattern_template: "even-two",
      source_logo_object_id: null,
      logo_media_type: null,
      logo_byte_length: null,
      logo_width: null,
      logo_height: null,
      logo_content_sha256: null,
      logo_content_bytes: null,
      created_at_ms: SECOND_CORRECTION_AT_MS,
    });
  }
  insert(database, "standings_snapshot_result_versions", {
    id: ids.secondReplacementResultLink,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.secondReplacementSnapshot,
    matchup_week_id: ids.week,
    matchup_id: ids.matchup,
    matchup_result_id: ids.matchupResult,
    matchup_result_version_id: ids.thirdResultVersion,
    result_version_number: 3,
    created_at_ms: SECOND_CORRECTION_AT_MS,
  });
  insert(database, "standings_operations", {
    id: ids.secondReplacementOperation,
    league_id: ids.league,
    season_id: ids.season,
    standings_snapshot_id: ids.secondReplacementSnapshot,
    actor_user_id: ids.user,
    actor_membership_id: ids.membership,
    actor_authority: "commissioner",
    operation_type: "correction_propagation",
    status: "succeeded",
    reason: "Second corrected final matchup result",
    metadata_json: JSON.stringify({
      evidenceSchemaVersion: 1,
    }),
    idempotency_request_id:
      ids.secondReplacementIdempotency,
    started_at_ms: SECOND_CORRECTION_AT_MS,
    completed_at_ms: SECOND_CORRECTION_AT_MS,
  });
  database
    .prepare(`
      UPDATE standings_snapshot_finalizations
      SET status = 'superseded',
          superseded_by_snapshot_id = ?,
          superseded_by_user_id = ?,
          superseded_by_membership_id = ?,
          superseded_by_authority = 'commissioner',
          superseded_by_operation_id = ?,
          superseded_at_ms = ${SECOND_CORRECTION_AT_MS},
          updated_at_ms = ${SECOND_CORRECTION_AT_MS},
          version = version + 1
      WHERE league_id = ?
        AND id = ?
        AND status = 'final'
    `)
    .run(
      ids.secondReplacementSnapshot,
      ids.user,
      ids.membership,
      ids.secondReplacementOperation,
      ids.league,
      ids.replacementFinalization
    );
  database
    .prepare(`
      UPDATE matchup_results
      SET current_version_id = ?,
          status = 'corrected',
          updated_at_ms = ${SECOND_CORRECTION_AT_MS},
          version = version + 1
      WHERE league_id = ?
        AND season_id = ?
        AND id = ?
    `)
    .run(
      ids.thirdResultVersion,
      ids.league,
      ids.season,
      ids.matchupResult
    );
  insert(
    database,
    "standings_snapshot_finalizations",
    finalizationRecord(ids, {
      id: ids.secondReplacementFinalization,
      standings_snapshot_id: ids.secondReplacementSnapshot,
      finalization_version: 3,
      cause: "result_correction",
      result_set_hash: "f".repeat(64),
      season_version_before: 3,
      season_version_after: 4,
      standings_operation_id: ids.secondReplacementOperation,
      idempotency_request_id:
        ids.secondReplacementIdempotency,
      replaces_finalization_id: ids.replacementFinalization,
      finalized_at_ms: SECOND_CORRECTION_AT_MS,
      created_at_ms: SECOND_CORRECTION_AT_MS,
      updated_at_ms: SECOND_CORRECTION_AT_MS,
    })
  );
  database
    .prepare(`
      UPDATE seasons
      SET version = 4,
          updated_at_ms = ${SECOND_CORRECTION_AT_MS}
      WHERE league_id = ?
        AND id = ?
        AND version = 3
    `)
    .run(ids.league, ids.season);
  return database
    .prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type = 'matchup_result_correction',
          result_id = ?,
          completed_at_ms = ${SECOND_CORRECTION_AT_MS}
      WHERE league_id = ?
        AND id = ?
        AND status = 'started'
    `)
    .run(
      ids.thirdResultVersion,
      ids.league,
      ids.secondReplacementIdempotency
    );
}

describe("T-145 final standings provenance migration", () => {
  test("upgrades schema 27 without inferring final provenance for legacy standings history", (t) => {
    const runtime = createRuntime(t, 27);
    const { database, migrations } = runtime;
    const ids = seedQualifyingSeason(database);

    insertFinalSnapshot(database, ids);
    insertStandingsRows(database, ids);
    insert(database, "standings_operations", {
      id: ids.standingsOperation,
      league_id: ids.league,
      season_id: ids.season,
      standings_snapshot_id: ids.standingsSnapshot,
      actor_user_id: ids.user,
      operation_type: "calculate",
      status: "succeeded",
      reason: "Legacy final standings",
      started_at_ms: FINALIZED_AT_MS - 100,
      completed_at_ms: FINALIZED_AT_MS,
    });

    const snapshotBefore = database
      .prepare(`
        SELECT *
        FROM standings_snapshots
        WHERE id = ?
      `)
      .get(ids.standingsSnapshot);
    const rowsBefore = database
      .prepare(`
        SELECT *
        FROM standings_rows
        WHERE standings_snapshot_id = ?
        ORDER BY id
      `)
      .all(ids.standingsSnapshot);
    const operationBefore = database
      .prepare(`
        SELECT id,
               league_id,
               season_id,
               standings_snapshot_id,
               actor_user_id,
               operation_type,
               status,
               reason,
               started_at_ms,
               completed_at_ms
        FROM standings_operations
        WHERE id = ?
      `)
      .get(ids.standingsOperation);

    const migrationState = applyMigrations({
      database,
      migrations: migrations.filter(({ id }) => id <= 28),
      applicationBuildId: "standings-0028-upgrade",
      now: () => 28,
    });

    assert.equal(migrationState.status, "exact");
    assert.equal(migrationState.applied.length, 28);
    assert.equal(
      database.pragma("user_version", { simple: true }),
      28
    );
    assert.equal(
      database
        .prepare(`
          SELECT metadata_value
          FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "28"
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT migration_id, file_name
          FROM schema_migrations
          ORDER BY migration_id DESC
          LIMIT 1
        `)
        .get(),
      {
        migration_id: 28,
        file_name: MIGRATION_FILE_NAME,
      }
    );
    assert.deepEqual(
      database
        .pragma("table_info(standings_operations)")
        .map(({ name }) => name),
      [
        "id",
        "league_id",
        "season_id",
        "standings_snapshot_id",
        "actor_user_id",
        "actor_membership_id",
        "actor_authority",
        "operation_type",
        "status",
        "reason",
        "metadata_json",
        "idempotency_request_id",
        "started_at_ms",
        "completed_at_ms",
      ]
    );
    for (const tableName of [
      "standings_snapshot_result_versions",
      "standings_snapshot_team_identities",
      "standings_snapshot_finalizations",
    ]) {
      assert.equal(
        database
          .pragma("table_list")
          .find(({ name }) => name === tableName)?.strict,
        1
      );
      assert.equal(
        database
          .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
          .get().count,
        0
      );
    }
    assert.deepEqual(
      database
        .prepare(`
          SELECT *
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(ids.standingsSnapshot),
      snapshotBefore
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT *
          FROM standings_rows
          WHERE standings_snapshot_id = ?
          ORDER BY id
        `)
        .all(ids.standingsSnapshot),
      rowsBefore
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT id,
                 league_id,
                 season_id,
                 standings_snapshot_id,
                 actor_user_id,
                 operation_type,
                 status,
                 reason,
                 started_at_ms,
                 completed_at_ms
          FROM standings_operations
          WHERE id = ?
        `)
        .get(ids.standingsOperation),
      operationBefore
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT actor_membership_id,
                 actor_authority,
                 metadata_json,
                 idempotency_request_id
          FROM standings_operations
          WHERE id = ?
        `)
        .get(ids.standingsOperation),
      {
        actor_membership_id: null,
        actor_authority: null,
        metadata_json: null,
        idempotency_request_id: null,
      }
    );
    assertDatabaseHealthy(database);
  });

  test("accepts the commissioner finalization chain only after exact evidence, season CAS, and final idempotency completion", (t) => {
    const { database } = createRuntime(t);
    const ids = seedQualifyingSeason(database, 2_000);

    insertStartedIdempotency(database, ids);
    assertConstraint(
      () => completeIdempotency(database, ids),
      /idempotency completion is inconsistent/
    );
    assert.equal(
      database
        .prepare(`
          SELECT status
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(ids.idempotency).status,
      "started"
    );

    insertFinalSnapshot(database, ids);
    insertStandingsRows(database, ids);
    insert(
      database,
      "standings_snapshot_result_versions",
      resultLinkRecord(ids)
    );
    insertTeamIdentity(database, ids, "home");
    insertTeamIdentity(database, ids, "away");
    assertConstraint(
      () =>
        insert(
          database,
          "standings_snapshot_finalizations",
          finalizationRecord(ids)
        ),
      /operation evidence is inconsistent/
    );

    insertSucceededOperation(database, ids);
    insert(
      database,
      "standings_snapshot_finalizations",
      finalizationRecord(ids)
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT seasons.version AS season_version,
                 idempotency_requests.status AS idempotency_status,
                 standings_snapshot_finalizations.status
                   AS finalization_status
          FROM seasons
          JOIN standings_snapshot_finalizations
            ON standings_snapshot_finalizations.league_id =
                 seasons.league_id
           AND standings_snapshot_finalizations.season_id =
                 seasons.id
          JOIN idempotency_requests
            ON idempotency_requests.league_id =
                 standings_snapshot_finalizations.league_id
           AND idempotency_requests.id =
                 standings_snapshot_finalizations
                   .idempotency_request_id
          WHERE standings_snapshot_finalizations.id = ?
        `)
        .get(ids.finalization),
      {
        season_version: 1,
        idempotency_status: "started",
        finalization_status: "final",
      }
    );
    assertConstraint(
      () => completeIdempotency(database, ids),
      /idempotency completion is inconsistent/
    );

    const seasonCas = database
      .prepare(`
        UPDATE seasons
        SET version = version + 1,
            updated_at_ms = ${COMPLETED_AT_MS}
        WHERE league_id = ?
          AND id = ?
          AND version = 1
    `)
      .run(ids.league, ids.season);
    assert.equal(seasonCas.changes, 1);
    assertConstraint(
      () =>
        completeIdempotency(
          database,
          ids,
          FINALIZED_AT_MS + 1
        ),
      /idempotency completion is inconsistent/
    );
    assert.equal(completeIdempotency(database, ids).changes, 1);
    assert.deepEqual(
      database
        .prepare(`
          SELECT status,
                 result_type,
                 result_id,
                 completed_at_ms
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(ids.idempotency),
      {
        status: "completed",
        result_type: "standings_finalization",
        result_id: ids.finalization,
        completed_at_ms: COMPLETED_AT_MS,
      }
    );
    assertDatabaseHealthy(database);
  });

  test("accepts an exact seven-local-day week across Lord Howe's 30-minute DST transition", (t) => {
    const { database } = createRuntime(t);
    const ids = seedQualifyingSeason(database, 2_250, {
      leagueTimezone: "Australia/Lord_Howe",
      weekStartsAtMs: LORD_HOWE_WEEK_STARTS_AT_MS,
      weekEndsAtMs: LORD_HOWE_WEEK_ENDS_AT_MS,
    });

    assert.equal(
      addLocalDays(
        LORD_HOWE_WEEK_STARTS_AT_MS,
        7,
        "Australia/Lord_Howe"
      ),
      LORD_HOWE_WEEK_ENDS_AT_MS
    );
    assert.equal(
      LORD_HOWE_WEEK_ENDS_AT_MS -
        LORD_HOWE_WEEK_STARTS_AT_MS,
      167.5 * 60 * 60 * 1000
    );

    stageCompleteEvidence(database, ids);
    insert(
      database,
      "standings_snapshot_finalizations",
      finalizationRecord(ids)
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ?
            AND season_id = ?
            AND status = 'final'
        `)
        .get(ids.league, ids.season).count,
      1
    );
    assertDatabaseHealthy(database);
  });

  test("allows a valid pre-final T097 append to complete against its new result-version id", (t) => {
    const { database } = createRuntime(t);
    const ids = seedQualifyingSeason(database, 2_350);

    insertCorrectedResultVersion(database, ids);
    insertResultCorrectionOperation(database, ids);
    insertStartedCorrectionIdempotency(database, ids);
    database
      .prepare(`
        UPDATE matchup_results
        SET current_version_id = ?,
            status = 'corrected',
            updated_at_ms = ${CORRECTION_AT_MS},
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND id = ?
      `)
      .run(
        ids.correctedResultVersion,
        ids.league,
        ids.season,
        ids.matchupResult
      );

    assert.equal(
      completeCorrectionIdempotency(database, ids).changes,
      1
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, result_type, result_id
          FROM idempotency_requests
          WHERE league_id = ?
            AND id = ?
        `)
        .get(ids.league, ids.replacementIdempotency),
      {
        status: "completed",
        result_type: "matchup_result_correction",
        result_id: ids.correctedResultVersion,
      }
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ?
            AND season_id = ?
        `)
        .get(ids.league, ids.season).count,
      0
    );
    assertDatabaseHealthy(database);
  });

  test("requires one exact immutable result-correction operation and a direct append chain", (t) => {
    const validRuntime = createRuntime(t);
    const valid = seedQualifyingSeason(
      validRuntime.database,
      2_375
    );
    insertCorrectedResultVersion(validRuntime.database, valid);
    insertResultCorrectionOperation(validRuntime.database, valid);
    selectCorrectedResultVersion(validRuntime.database, valid);
    stageCompleteEvidence(validRuntime.database, valid, {
      resultVersionId: valid.correctedResultVersion,
      resultVersionNumber: 2,
    });
    insert(
      validRuntime.database,
      "standings_snapshot_finalizations",
      finalizationRecord(valid)
    );
    assertConstraint(
      () =>
        validRuntime.database
          .prepare(`
            UPDATE matchup_operations
            SET reason = 'Changed'
            WHERE league_id = ?
              AND id = ?
          `)
          .run(
            valid.league,
            valid.resultCorrectionOperation
          ),
      /result-correction operation is immutable/
    );
    assertConstraint(
      () =>
        validRuntime.database
          .prepare(`
            DELETE FROM matchup_operations
            WHERE league_id = ?
              AND id = ?
          `)
          .run(
            valid.league,
            valid.resultCorrectionOperation
          ),
      /result-correction operation cannot be deleted/
    );

    const missingRuntime = createRuntime(t);
    const missing = seedQualifyingSeason(
      missingRuntime.database,
      2_400
    );
    insertCorrectedResultVersion(missingRuntime.database, missing);
    selectCorrectedResultVersion(missingRuntime.database, missing);
    stageCompleteEvidence(missingRuntime.database, missing, {
      resultVersionId: missing.correctedResultVersion,
      resultVersionNumber: 2,
    });
    assertConstraint(
      () =>
        insert(
          missingRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(missing)
        ),
      /correction operation is inconsistent/
    );

    const duplicateRuntime = createRuntime(t);
    const duplicate = seedQualifyingSeason(
      duplicateRuntime.database,
      2_425
    );
    insertCorrectedResultVersion(
      duplicateRuntime.database,
      duplicate
    );
    insertResultCorrectionOperation(
      duplicateRuntime.database,
      duplicate
    );
    insertResultCorrectionOperation(
      duplicateRuntime.database,
      duplicate,
      { id: duplicate.duplicateResultCorrectionOperation }
    );
    selectCorrectedResultVersion(
      duplicateRuntime.database,
      duplicate
    );
    stageCompleteEvidence(
      duplicateRuntime.database,
      duplicate,
      {
        resultVersionId: duplicate.correctedResultVersion,
        resultVersionNumber: 2,
      }
    );
    assertConstraint(
      () =>
        insert(
          duplicateRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(duplicate)
        ),
      /correction operation is inconsistent/
    );

    const mismatchRuntime = createRuntime(t);
    const mismatch = seedQualifyingSeason(
      mismatchRuntime.database,
      2_450
    );
    insertCorrectedResultVersion(
      mismatchRuntime.database,
      mismatch
    );
    insertResultCorrectionOperation(
      mismatchRuntime.database,
      mismatch,
      {
        metadataJson: JSON.stringify({
          resultId: mismatch.matchupResult,
          resultVersionId: mismatch.resultVersion,
        }),
      }
    );
    selectCorrectedResultVersion(
      mismatchRuntime.database,
      mismatch
    );
    stageCompleteEvidence(
      mismatchRuntime.database,
      mismatch,
      {
        resultVersionId: mismatch.correctedResultVersion,
        resultVersionNumber: 2,
      }
    );
    assertConstraint(
      () =>
        insert(
          mismatchRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(mismatch)
        ),
      /correction operation is inconsistent/
    );

    const directRuntime = createRuntime(t);
    const direct = seedQualifyingSeason(
      directRuntime.database,
      2_475
    );
    insertCorrectedResultVersion(
      directRuntime.database,
      direct,
      {
        supersedes_version_id:
          direct.correctedResultVersion,
      }
    );
    insertResultCorrectionOperation(directRuntime.database, direct);
    selectCorrectedResultVersion(directRuntime.database, direct);
    stageCompleteEvidence(directRuntime.database, direct, {
      resultVersionId: direct.correctedResultVersion,
      resultVersionNumber: 2,
    });
    assertConstraint(
      () =>
        insert(
          directRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(direct)
        ),
      /correction chain is inconsistent/
    );

    assertDatabaseHealthy(validRuntime.database);
    assertDatabaseHealthy(missingRuntime.database);
    assertDatabaseHealthy(duplicateRuntime.database);
    assertDatabaseHealthy(mismatchRuntime.database);
    assertDatabaseHealthy(directRuntime.database);
  });

  test("accepts only the exact T097 correction replacement chain and rejects mixed operation evidence", (t) => {
    const { database } = createRuntime(t);
    const ids = seedQualifyingSeason(database, 2_500);

    stageCompleteEvidence(database, ids);
    insert(
      database,
      "standings_snapshot_finalizations",
      finalizationRecord(ids)
    );
    database
      .prepare(`
        UPDATE seasons
        SET version = 2,
            updated_at_ms = ${COMPLETED_AT_MS}
        WHERE league_id = ?
          AND id = ?
          AND version = 1
      `)
      .run(ids.league, ids.season);
    completeIdempotency(database, ids);

    insertCorrectedResultVersion(database, ids);
    insertResultCorrectionOperation(database, ids);
    insertStartedCorrectionIdempotency(database, ids);
    insertReplacementSnapshot(database, ids);
    insertReplacementRows(database, ids);
    insertReplacementResultLink(database, ids);
    insertReplacementIdentities(database, ids);

    insertCorrectionOperation(
      database,
      ids,
      "finalize_regular_season"
    );
    assertConstraint(
      () => supersedeInitialFinalization(database, ids),
      /supersession requires a staged replacement/
    );
    database
      .prepare(`
        DELETE FROM standings_operations
        WHERE league_id = ?
          AND id = ?
      `)
      .run(ids.league, ids.replacementOperation);

    insertCorrectionOperation(database, ids);
    assert.equal(
      supersedeInitialFinalization(database, ids).changes,
      1
    );
    database
      .prepare(`
        UPDATE matchup_results
        SET current_version_id = ?,
            status = 'corrected',
            updated_at_ms = ${CORRECTION_AT_MS},
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND id = ?
      `)
      .run(
        ids.correctedResultVersion,
        ids.league,
        ids.season,
        ids.matchupResult
      );
    assertConstraint(
      () => completeCorrectionIdempotency(database, ids),
      /correction idempotency completion is inconsistent/
    );
    insert(
      database,
      "standings_snapshot_finalizations",
      replacementFinalizationRecord(ids)
    );

    assertConstraint(
      () => completeCorrectionIdempotency(database, ids),
      /correction idempotency completion is inconsistent/
    );
    assert.equal(
      database
        .prepare(`
          UPDATE seasons
          SET version = version + 1,
              updated_at_ms = ${CORRECTION_AT_MS}
          WHERE league_id = ?
            AND id = ?
            AND version = 2
        `)
        .run(ids.league, ids.season).changes,
      1
    );
    assert.equal(
      completeCorrectionIdempotency(database, ids).changes,
      1
    );

    assert.deepEqual(
      database
        .prepare(`
          SELECT initial.status AS initial_status,
                 replacement.status AS replacement_status,
                 replacement.cause AS replacement_cause,
                 replacement.replaces_finalization_id,
                 correction.operation,
                 correction.result_type,
                 correction.result_id,
                 seasons.version AS season_version
          FROM standings_snapshot_finalizations AS replacement
          JOIN standings_snapshot_finalizations AS initial
            ON initial.league_id = replacement.league_id
           AND initial.id =
             replacement.replaces_finalization_id
          JOIN idempotency_requests AS correction
            ON correction.league_id = replacement.league_id
           AND correction.id =
             replacement.idempotency_request_id
          JOIN seasons
            ON seasons.league_id = replacement.league_id
           AND seasons.id = replacement.season_id
          WHERE replacement.id = ?
        `)
        .get(ids.replacementFinalization),
      {
        initial_status: "superseded",
        replacement_status: "final",
        replacement_cause: "result_correction",
        replaces_finalization_id: ids.finalization,
        operation: "matchup.result.correct.v1",
        result_type: "matchup_result_correction",
        result_id: ids.correctedResultVersion,
        season_version: 3,
      }
    );
    assert.equal(
      commitSecondCorrectionReplacement(database, ids).changes,
      1
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT prior.status AS prior_status,
                 current.status AS current_status,
                 current.replaces_finalization_id,
                 correction.result_id,
                 seasons.version AS season_version
          FROM standings_snapshot_finalizations AS current
          JOIN standings_snapshot_finalizations AS prior
            ON prior.league_id = current.league_id
           AND prior.id = current.replaces_finalization_id
          JOIN idempotency_requests AS correction
            ON correction.league_id = current.league_id
           AND correction.id = current.idempotency_request_id
          JOIN seasons
            ON seasons.league_id = current.league_id
           AND seasons.id = current.season_id
          WHERE current.id = ?
        `)
        .get(ids.secondReplacementFinalization),
      {
        prior_status: "superseded",
        current_status: "final",
        replaces_finalization_id:
          ids.replacementFinalization,
        result_id: ids.thirdResultVersion,
        season_version: 4,
      }
    );
    assertDatabaseHealthy(database);
  });

  test("rejects a correction replacement that relinks the prior version instead of one direct append", (t) => {
    const { database } = createRuntime(t);
    const ids = seedQualifyingSeason(database, 2_750);
    assert.equal(
      commitInitialCanonicalFinalization(database, ids).changes,
      1
    );

    insertCorrectedResultVersion(database, ids);
    insertResultCorrectionOperation(database, ids);
    insertStartedCorrectionIdempotency(database, ids);
    insertReplacementSnapshot(database, ids);
    insertReplacementRows(database, ids);
    insert(
      database,
      "standings_snapshot_result_versions",
      resultLinkRecord(ids, {
        id: ids.replacementResultLink,
        standings_snapshot_id: ids.laterSnapshot,
        created_at_ms: CORRECTION_AT_MS,
      })
    );
    insertReplacementIdentities(database, ids);
    insertCorrectionOperation(database, ids);
    assert.equal(
      supersedeInitialFinalization(database, ids).changes,
      1
    );
    assertConstraint(
      () =>
        insert(
          database,
          "standings_snapshot_finalizations",
          replacementFinalizationRecord(ids)
        ),
      /links must contain one direct correction/
    );
    assertDatabaseHealthy(database);
  });

  test("allows an exact T097 replacement for a completed non-current season without borrowing current rules", (t) => {
    const { database } = createRuntime(t);
    const ids = seedQualifyingSeason(database, 2_875);
    assert.equal(
      commitInitialCanonicalFinalization(
        database,
        ids
      ).changes,
      1
    );

    assert.equal(
      database
        .prepare(`
          UPDATE seasons
          SET status = 'completed',
              updated_at_ms = ${CORRECTION_AT_MS - 2},
              version = 3
          WHERE league_id = ?
            AND id = ?
            AND status = 'active'
            AND version = 2
        `)
        .run(ids.league, ids.season).changes,
      1
    );
    insert(database, "seasons", {
      id: ids.otherSeason,
      league_id: ids.league,
      label: "2027-28 historical correction",
      nhl_season_key: "20272028",
      status: "active",
      regular_season_starts_at_ms:
        CORRECTION_AT_MS + WEEK_MS,
      regular_season_ends_at_ms:
        CORRECTION_AT_MS + 2 * WEEK_MS,
      fantasy_playoffs_start_at_ms:
        CORRECTION_AT_MS + 2 * WEEK_MS,
      fantasy_playoffs_end_at_ms:
        CORRECTION_AT_MS + 3 * WEEK_MS,
      created_at_ms: CORRECTION_AT_MS - 1,
      updated_at_ms: CORRECTION_AT_MS - 1,
      version: 1,
    });
    assert.equal(
      database
        .prepare(`
          UPDATE leagues
          SET current_season_id = ?,
              updated_at_ms = ${CORRECTION_AT_MS - 1},
              version = version + 1
          WHERE id = ?
            AND current_season_id = ?
        `)
        .run(
          ids.otherSeason,
          ids.league,
          ids.season
        ).changes,
      1
    );
    assert.equal(
      database
        .prepare(`
          UPDATE league_settings
          SET standings_rule_version = 2,
              updated_at_ms = ${CORRECTION_AT_MS - 1},
              version = version + 1
          WHERE league_id = ?
            AND standings_rule_version = 1
        `)
        .run(ids.league).changes,
      1
    );

    insertCorrectedResultVersion(database, ids);
    insertResultCorrectionOperation(database, ids);
    insertStartedCorrectionIdempotency(database, ids);
    insertReplacementSnapshot(database, ids);
    insertReplacementRows(database, ids);
    insertReplacementResultLink(database, ids);
    insertReplacementIdentities(database, ids);
    insertCorrectionOperation(database, ids);
    assert.equal(
      supersedeInitialFinalization(
        database,
        ids
      ).changes,
      1
    );
    assert.equal(
      selectCorrectedResultVersion(
        database,
        ids
      ).changes,
      1
    );
    insert(
      database,
      "standings_snapshot_finalizations",
      replacementFinalizationRecord(ids, {
        season_version_before: 3,
        season_version_after: 4,
      })
    );
    assert.equal(
      database
        .prepare(`
          UPDATE seasons
          SET version = 4,
              updated_at_ms = ${CORRECTION_AT_MS}
          WHERE league_id = ?
            AND id = ?
            AND status = 'completed'
            AND version = 3
        `)
        .run(ids.league, ids.season).changes,
      1
    );
    assert.equal(
      completeCorrectionIdempotency(
        database,
        ids
      ).changes,
      1
    );

    assert.deepEqual(
      database
        .prepare(`
          SELECT leagues.current_season_id,
                 historical.status AS historical_status,
                 historical.version AS historical_version,
                 current.status AS current_status,
                 league_settings.standings_rule_version,
                 replacement.standings_rule_version AS replacement_rule,
                 replacement.status AS replacement_status
          FROM leagues
          JOIN seasons AS historical
            ON historical.league_id = leagues.id
           AND historical.id = ?
          JOIN seasons AS current
            ON current.league_id = leagues.id
           AND current.id = leagues.current_season_id
          JOIN league_settings
            ON league_settings.league_id = leagues.id
          JOIN standings_snapshot_finalizations AS replacement
            ON replacement.league_id = leagues.id
           AND replacement.id = ?
          WHERE leagues.id = ?
        `)
        .get(
          ids.season,
          ids.replacementFinalization,
          ids.league
        ),
      {
        current_season_id: ids.otherSeason,
        historical_status: "completed",
        historical_version: 4,
        current_status: "active",
        standings_rule_version: 2,
        replacement_rule: 1,
        replacement_status: "final",
      }
    );
    assertDatabaseHealthy(database);
  });

  test("makes exact final evidence immutable and interlocks active final standings against drift", (t) => {
    const { database } = createRuntime(t);
    const ids = seedQualifyingSeason(database, 3_000);

    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE matchup_result_versions
            SET home_score_hundredths = 501
            WHERE id = ?
          `)
          .run(ids.resultVersion),
      /result-version history is immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            DELETE FROM matchup_result_versions
            WHERE id = ?
          `)
          .run(ids.resultVersion),
      /result-version history cannot be deleted/
    );

    stageCompleteEvidence(database, ids);
    insert(
      database,
      "standings_snapshot_finalizations",
      finalizationRecord(ids)
    );
    database
      .prepare(`
        UPDATE seasons
        SET version = 2,
            updated_at_ms = ${COMPLETED_AT_MS}
        WHERE id = ?
      `)
      .run(ids.season);
    completeIdempotency(database, ids);

    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE standings_snapshot_finalizations
            SET result_set_hash = ?
            WHERE id = ?
          `)
          .run("c".repeat(64), ids.finalization),
      /finalization evidence is immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            DELETE FROM standings_snapshot_finalizations
            WHERE id = ?
          `)
          .run(ids.finalization),
      /finalization evidence cannot be deleted/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE standings_snapshot_result_versions
            SET result_version_number = 2
            WHERE id = ?
          `)
          .run(ids.resultLink),
      /result-version links are immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE standings_snapshot_team_identities
            SET team_display_name = 'Changed'
            WHERE id = ?
          `)
          .run(ids.homeIdentity),
      /team identities are immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE standings_rows
            SET rank = 2
            WHERE id = ?
          `)
          .run(ids.homeRow),
      /canonical standings rows are immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE standings_snapshots
            SET source_result_version = 2
            WHERE id = ?
          `)
          .run(ids.standingsSnapshot),
      /canonical standings snapshot is immutable/
    );
    assertConstraint(
      () =>
        insert(database, "standings_snapshots", {
          id: ids.laterSnapshot,
          league_id: ids.league,
          season_id: ids.season,
          snapshot_version: 2,
          source_result_version: 1,
          status: "current",
          calculated_at_ms: CORRECTION_AT_MS,
          created_at_ms: CORRECTION_AT_MS,
        }),
      /active final standings block a current snapshot/
    );

    insertCorrectedResultVersion(database, ids);
    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE matchup_results
            SET current_version_id = ?,
                status = 'corrected',
                updated_at_ms = ${CORRECTION_AT_MS},
                version = version + 1
            WHERE id = ?
          `)
          .run(
            ids.correctedResultVersion,
            ids.matchupResult
          ),
      /active final standings require atomic correction replacement/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            UPDATE matchup_result_versions
            SET home_score_hundredths = 501
            WHERE id = ?
          `)
          .run(ids.resultVersion),
      /result-version history is immutable/
    );
    assertConstraint(
      () =>
        database
          .prepare(`
            DELETE FROM matchup_result_versions
            WHERE id = ?
          `)
          .run(ids.resultVersion),
      /result-version history cannot be deleted/
    );
    assertDatabaseHealthy(database);
  });

  test("requires one strict immutable schedule-generation root and rejects participant or count drift", (t) => {
    const immutableRuntime = createRuntime(t);
    const immutable = seedQualifyingSeason(
      immutableRuntime.database,
      3_050
    );
    assertConstraint(
      () =>
        immutableRuntime.database
          .prepare(`
            UPDATE matchup_operations
            SET metadata_json = '{}'
            WHERE league_id = ?
              AND id = ?
          `)
          .run(
            immutable.league,
            immutable.scheduleOperation
          ),
      /schedule-generation evidence is immutable/
    );
    assertConstraint(
      () =>
        immutableRuntime.database
          .prepare(`
            DELETE FROM matchup_operations
            WHERE league_id = ?
              AND id = ?
          `)
          .run(
            immutable.league,
            immutable.scheduleOperation
          ),
      /schedule-generation evidence cannot be deleted/
    );

    const omittedRuntime = createRuntime(t);
    const omitted = seedQualifyingSeason(
      omittedRuntime.database,
      3_100,
      {
        scheduleMetadataJson: scheduleMetadata(
          scopeIds(3_100),
          {
          participantCount: 3,
          participantTeamIds: [
            scopeIds(3_100).homeTeam,
            scopeIds(3_100).awayTeam,
            scopeIds(3_100).omittedTeam,
          ].sort(),
          weekCount: 1,
          matchupCount: 1,
          jobOccurrenceCount: 0,
          }
        ),
      }
    );
    insert(omittedRuntime.database, "teams", {
      id: omitted.omittedTeam,
      league_id: omitted.league,
      name: "Omitted participant",
      name_normalized: "omitted participant",
      status: "active",
      primary_colour: "#334455",
      secondary_colour: "#667788",
      logo_reference: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
      tertiary_colour: null,
      pattern_template: "even-two",
    });
    stageCompleteEvidence(omittedRuntime.database, omitted);
    assertConstraint(
      () =>
        insert(
          omittedRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(omitted, {
            participant_count: 3,
            standings_row_count: 3,
          })
        ),
      /schedule-generation evidence is inconsistent|schedule matchup and bye counts are invalid/
    );

    const ambiguousRuntime = createRuntime(t);
    const ambiguous = seedQualifyingSeason(
      ambiguousRuntime.database,
      3_150
    );
    insert(ambiguousRuntime.database, "matchup_operations", {
      id: ambiguous.ambiguousScheduleOperation,
      league_id: ambiguous.league,
      season_id: ambiguous.season,
      matchup_week_id: null,
      matchup_id: null,
      actor_user_id: ambiguous.user,
      operation_type: "schedule_generate",
      status: "succeeded",
      reason: null,
      metadata_json: scheduleMetadata(ambiguous),
      started_at_ms: 2,
      completed_at_ms: 2,
    });
    stageCompleteEvidence(
      ambiguousRuntime.database,
      ambiguous
    );
    assertConstraint(
      () =>
        insert(
          ambiguousRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(ambiguous)
        ),
      /requires one schedule-generation root/
    );

    const malformedRuntime = createRuntime(t);
    const malformed = seedQualifyingSeason(
      malformedRuntime.database,
      3_200,
      { scheduleMetadataJson: "{" }
    );
    stageCompleteEvidence(
      malformedRuntime.database,
      malformed
    );
    assertConstraint(
      () =>
        insert(
          malformedRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(malformed)
        ),
      /schedule-generation evidence is inconsistent/
    );

    const mismatchRuntime = createRuntime(t);
    const mismatch = seedQualifyingSeason(
      mismatchRuntime.database,
      3_225,
      {
        scheduleMetadataJson: scheduleMetadata(
          scopeIds(3_225),
          {
          weekCount: 1,
          matchupCount: 2,
          }
        ),
      }
    );
    stageCompleteEvidence(mismatchRuntime.database, mismatch);
    assertConstraint(
      () =>
        insert(
          mismatchRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(mismatch)
        ),
      /schedule-generation evidence is inconsistent/
    );

    const duplicateRuntime = createRuntime(t);
    const duplicateIds = scopeIds(3_230);
    const duplicate = seedQualifyingSeason(
      duplicateRuntime.database,
      3_230,
      {
        scheduleMetadataJson: scheduleMetadata(
          duplicateIds,
          {
            participantTeamIds: [
              duplicateIds.homeTeam,
              duplicateIds.homeTeam,
            ],
          }
        ),
      }
    );
    stageCompleteEvidence(duplicateRuntime.database, duplicate);
    assertConstraint(
      () =>
        insert(
          duplicateRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(duplicate)
        ),
      /schedule-generation evidence is inconsistent/
    );

    const unsortedRuntime = createRuntime(t);
    const unsortedIds = scopeIds(3_235);
    const unsorted = seedQualifyingSeason(
      unsortedRuntime.database,
      3_235,
      {
        scheduleMetadataJson: scheduleMetadata(
          unsortedIds,
          {
            participantTeamIds: [
              unsortedIds.awayTeam,
              unsortedIds.homeTeam,
            ],
          }
        ),
      }
    );
    stageCompleteEvidence(unsortedRuntime.database, unsorted);
    assertConstraint(
      () =>
        insert(
          unsortedRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(unsorted)
        ),
      /schedule-generation evidence is inconsistent/
    );

    const substitutionRuntime = createRuntime(t);
    const substitution = seedQualifyingSeason(
      substitutionRuntime.database,
      3_240
    );
    stageCompleteEvidence(
      substitutionRuntime.database,
      substitution
    );
    insert(substitutionRuntime.database, "teams", {
      id: substitution.omittedTeam,
      league_id: substitution.league,
      name: "Substituted participant",
      name_normalized: "substituted participant",
      status: "active",
      primary_colour: "#334455",
      secondary_colour: "#667788",
      logo_reference: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
      tertiary_colour: null,
      pattern_template: "even-two",
    });
    substitutionRuntime.database
      .prepare(`
        UPDATE matchups
        SET home_team_id = ?,
            home_team_name = 'Substituted participant',
            updated_at_ms = updated_at_ms + 1,
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND id = ?
      `)
      .run(
        substitution.omittedTeam,
        substitution.league,
        substitution.season,
        substitution.matchup
      );
    assertConstraint(
      () =>
        insert(
          substitutionRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(substitution)
        ),
      /schedule-generation evidence is inconsistent|requires exact current result versions/
    );

    assertDatabaseHealthy(immutableRuntime.database);
    assertDatabaseHealthy(omittedRuntime.database);
    assertDatabaseHealthy(ambiguousRuntime.database);
    assertDatabaseHealthy(malformedRuntime.database);
    assertDatabaseHealthy(mismatchRuntime.database);
    assertDatabaseHealthy(duplicateRuntime.database);
    assertDatabaseHealthy(unsortedRuntime.database);
    assertDatabaseHealthy(substitutionRuntime.database);
  });

  test("rejects truncated, omitted-week, and cross-season schedule evidence", (t) => {
    const truncatedRuntime = createRuntime(t);
    const truncated = seedQualifyingSeason(
      truncatedRuntime.database,
      3_250
    );
    truncatedRuntime.database
      .prepare(`
        UPDATE seasons
        SET fantasy_playoffs_start_at_ms = ?,
            fantasy_playoffs_end_at_ms = ?,
            updated_at_ms = updated_at_ms + 1,
            version = version + 1
        WHERE league_id = ?
          AND id = ?
      `)
      .run(
        WEEK_ENDS_AT_MS + WEEK_MS,
        WEEK_ENDS_AT_MS + 3 * WEEK_MS,
        truncated.league,
        truncated.season
      );
    stageCompleteEvidence(
      truncatedRuntime.database,
      truncated
    );
    assertConstraint(
      () =>
        insert(
          truncatedRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(truncated, {
            season_version_before: 2,
            season_version_after: 3,
          })
        ),
      /schedule boundaries are incomplete/
    );

    const omittedRuntime = createRuntime(t);
    const omitted = seedQualifyingSeason(
      omittedRuntime.database,
      3_500,
      {
        scheduleMetadataJson: scheduleMetadata(
          scopeIds(3_500),
          {
          weekCount: 2,
          matchupCount: 1,
          jobOccurrenceCount: 0,
          }
        ),
      }
    );
    omittedRuntime.database
      .prepare(`
        UPDATE seasons
        SET regular_season_starts_at_ms = ?,
            updated_at_ms = updated_at_ms + 1,
            version = version + 1
        WHERE league_id = ?
          AND id = ?
      `)
      .run(
        WEEK_STARTS_AT_MS -
          WEEK_MS -
          2 * 24 * 60 * 60 * 1000,
        omitted.league,
        omitted.season
      );
    omittedRuntime.database
      .prepare(`
        UPDATE matchup_weeks
        SET sequence = 2,
            week_key = 'regular-02',
            updated_at_ms = updated_at_ms + 1,
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND id = ?
      `)
      .run(
        omitted.league,
        omitted.season,
        omitted.week
      );
    insert(omittedRuntime.database, "matchup_weeks", {
      id: omitted.omittedWeek,
      league_id: omitted.league,
      season_id: omitted.season,
      week_key: "regular-01",
      sequence: 1,
      starts_at_ms: WEEK_STARTS_AT_MS - WEEK_MS,
      baseline_at_ms:
        WEEK_STARTS_AT_MS -
        WEEK_MS +
        60 * 60 * 1000,
      locks_at_ms:
        WEEK_STARTS_AT_MS -
        WEEK_MS +
        16 * 60 * 60 * 1000,
      ends_at_ms: WEEK_STARTS_AT_MS,
      rolls_over_at_ms: WEEK_STARTS_AT_MS,
      status: "final",
      created_at_ms: 1,
      updated_at_ms: WEEK_STARTS_AT_MS,
      version: 2,
    });
    stageCompleteEvidence(omittedRuntime.database, omitted);
    assertConstraint(
      () =>
        insert(
          omittedRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(omitted, {
            expected_week_count: 2,
            weeks_counted: 2,
            season_version_before: 2,
            season_version_after: 3,
          })
        ),
      /schedule participant coverage is incomplete/
    );

    const crossRuntime = createRuntime(t);
    const cross = seedQualifyingSeason(
      crossRuntime.database,
      3_750
    );
    insert(crossRuntime.database, "seasons", {
      id: cross.otherSeason,
      league_id: cross.league,
      label: "2027-28-cross-scope",
      nhl_season_key: "20272028",
      status: "planned",
      regular_season_starts_at_ms:
        WEEK_ENDS_AT_MS + WEEK_MS,
      regular_season_ends_at_ms:
        WEEK_ENDS_AT_MS + 2 * WEEK_MS,
      fantasy_playoffs_start_at_ms:
        WEEK_ENDS_AT_MS + 2 * WEEK_MS,
      fantasy_playoffs_end_at_ms:
        WEEK_ENDS_AT_MS + 3 * WEEK_MS,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(crossRuntime.database, "matchup_weeks", {
      id: cross.otherWeek,
      league_id: cross.league,
      season_id: cross.otherSeason,
      week_key: "other-01",
      sequence: 1,
      starts_at_ms: WEEK_ENDS_AT_MS + WEEK_MS,
      baseline_at_ms:
        WEEK_ENDS_AT_MS + WEEK_MS + 60 * 60 * 1000,
      locks_at_ms:
        WEEK_ENDS_AT_MS + WEEK_MS + 16 * 60 * 60 * 1000,
      ends_at_ms: WEEK_ENDS_AT_MS + 2 * WEEK_MS,
      rolls_over_at_ms:
        WEEK_ENDS_AT_MS + 2 * WEEK_MS,
      status: "scheduled",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(crossRuntime.database, "matchup_byes", {
      id: cross.crossSeasonBye,
      league_id: cross.league,
      season_id: cross.season,
      matchup_week_id: cross.otherWeek,
      team_id: cross.homeTeam,
      team_display_name: "Home cross-scope",
      created_at_ms: 1,
    });
    stageCompleteEvidence(crossRuntime.database, cross);
    assertConstraint(
      () =>
        insert(
          crossRuntime.database,
          "standings_snapshot_finalizations",
          finalizationRecord(cross)
        ),
      /schedule assignments cross season scope/
    );

    assertDatabaseHealthy(truncatedRuntime.database);
    assertDatabaseHealthy(omittedRuntime.database);
    assertDatabaseHealthy(crossRuntime.database);
  });

  test("rejects cross-scope, stale, and incomplete finalization evidence", (t) => {
    const { database } = createRuntime(t);
    const ids = seedQualifyingSeason(database, 4_000);
    const otherIds = seedQualifyingSeason(database, 5_000);

    insertStartedIdempotency(database, ids);
    insertFinalSnapshot(database, ids);
    insertStandingsRows(database, ids);
    assertConstraint(() => {
      insert(
        database,
        "standings_snapshot_result_versions",
        resultLinkRecord(ids, {
          matchup_week_id: otherIds.week,
          matchup_id: otherIds.matchup,
          matchup_result_id: otherIds.matchupResult,
          matchup_result_version_id:
            otherIds.resultVersion,
        })
      );
    });

    insert(
      database,
      "standings_snapshot_result_versions",
      resultLinkRecord(ids)
    );
    insertTeamIdentity(database, ids, "home");
    insertSucceededOperation(database, ids);
    assertConstraint(
      () =>
        insert(
          database,
          "standings_snapshot_finalizations",
          finalizationRecord(ids)
        ),
      /identity count is inconsistent/
    );

    insertTeamIdentity(database, ids, "away");
    assertConstraint(
      () =>
        insert(
          database,
          "standings_snapshot_finalizations",
          finalizationRecord(ids, {
            season_version_before: 2,
            season_version_after: 3,
          })
        ),
      /exact eligible season version/
    );

    insertCorrectedResultVersion(database, ids);
    database
      .prepare(`
        UPDATE matchup_results
        SET current_version_id = ?,
            status = 'corrected',
            updated_at_ms = ${CORRECTION_AT_MS},
            version = version + 1
        WHERE id = ?
      `)
      .run(ids.correctedResultVersion, ids.matchupResult);
    assertConstraint(
      () =>
        insert(
          database,
          "standings_snapshot_finalizations",
          finalizationRecord(ids)
        ),
      /exact current result versions/
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ?
        `)
        .get(ids.league).count,
      0
    );
    assertDatabaseHealthy(database);
  });
});
