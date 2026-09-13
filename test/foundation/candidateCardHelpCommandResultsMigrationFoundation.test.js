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

const CANONICAL_MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

const FIRST_MATCHUP_STARTS_AT_MS = 2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 604_800_000;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 172_800_000;
const OPENED_AT_MS = HELP_OPENS_AT_MS - 10_000;
const HELP_AT_MS = HELP_OPENS_AT_MS + 1;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const migrationsDirectory = path.join(temporaryRoot, "migrations");
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
    if (migration.id < minimumId || migration.id > maximumId) continue;
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

function seedOpenCandidateCard(database, base = 35_000) {
  const ids = {
    managerUser: uuid(base + 1),
    managerMembership: uuid(base + 2),
    league: uuid(base + 3),
    season: uuid(base + 4),
    team: uuid(base + 5),
    managerAssignment: uuid(base + 6),
    week: uuid(base + 7),
    readiness: uuid(base + 8),
    fad: uuid(base + 9),
    participant: uuid(base + 10),
    card: uuid(base + 11),
  };

  insert(database, "users", {
    id: ids.managerUser,
    email_normalized: `manager-${base}@example.test`,
    email_display: `manager-${base}@example.test`,
    display_name: `Manager ${base}`,
    display_name_normalized: `manager ${base}`,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `Help Result League ${base}`,
    name_normalized: `help result league ${base}`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: ids.managerMembership,
    league_id: ids.league,
    user_id: ids.managerUser,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 10,
    ended_at_ms: null,
    created_at_ms: 10,
    updated_at_ms: 10,
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
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `Season ${base}`,
    nhl_season_key: `${base}2027`,
    status: "active",
    regular_season_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    regular_season_ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    fantasy_playoffs_start_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 8_000,
    fantasy_playoffs_end_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `Help Result Team ${base}`,
    name_normalized: `help result team ${base}`,
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: 20,
    updated_at_ms: 20,
    version: 1,
  });
  insert(database, "team_manager_assignments", {
    id: ids.managerAssignment,
    league_id: ids.league,
    team_id: ids.team,
    user_id: ids.managerUser,
    membership_id: ids.managerMembership,
    assigned_by_user_id: ids.managerUser,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: 20,
    accepted_at_ms: 20,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
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
  const readinessOccurrenceKey = `fad:${ids.season}:readiness`;
  insert(database, "free_agent_draft_readiness_operations", {
    id: ids.readiness,
    league_id: ids.league,
    season_id: ids.season,
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
  database.exec("DROP TRIGGER free_agent_drafts_valid_insert");
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key: readinessOccurrenceKey,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id: ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "cards_open",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Candidate Card help result foundation fixture.",
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
  insert(database, "free_agent_draft_teams", {
    id: ids.participant,
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
    status: "open",
    completeness_code: "incomplete",
    filled_mandatory_count: 0,
    missing_mandatory_count: 18,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    maximum_possible_cap_cents: 0,
    locked_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });

  return ids;
}

function insertStartedRequest(
  database,
  ids,
  {
    id,
    clientKey,
    requestHash,
    createdAtMs,
  }
) {
  insert(database, "idempotency_requests", {
    id,
    league_id: ids.league,
    actor_user_id: ids.managerUser,
    operation: "candidate_card.help",
    client_key: clientKey,
    request_hash: requestHash,
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: createdAtMs,
    completed_at_ms: null,
    expires_at_ms: CANDIDATE_DEADLINE_AT_MS + 10_000,
  });
}

function insertHelpRequest(
  database,
  ids,
  {
    id,
    message = "Please help me finish my Candidate Card.",
  }
) {
  insert(database, "candidate_card_help_requests", {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    status: "active",
    message,
    requested_by_user_id: ids.managerUser,
    requested_by_membership_id: ids.managerMembership,
    requested_at_ms: HELP_AT_MS,
    expires_at_ms: CANDIDATE_DEADLINE_AT_MS,
    created_at_ms: HELP_AT_MS,
    updated_at_ms: HELP_AT_MS,
    version: 1,
  });
}

function canonicalHelpResponse(database, ids, helpRequestId) {
  const row = database
    .prepare(`
      SELECT
        help.id AS helpRequestId,
        help.league_id AS leagueId,
        help.season_id AS seasonId,
        help.fad_id AS fadId,
        help.card_id AS cardId,
        help.team_id AS teamId,
        help.message,
        help.requested_by_user_id AS requestedByUserId,
        requester.display_name AS requestedByDisplayName,
        help.requested_at_ms AS requestedAtMs,
        help.expires_at_ms AS expiresAtMs
      FROM candidate_card_help_requests AS help
      JOIN users AS requester
        ON requester.id = help.requested_by_user_id
      WHERE help.league_id = ? AND help.id = ?
    `)
    .get(ids.league, helpRequestId);

  return JSON.stringify({
    helpRequestId: row.helpRequestId,
    leagueId: row.leagueId,
    seasonId: row.seasonId,
    fadId: row.fadId,
    cardId: row.cardId,
    teamId: row.teamId,
    status: "active",
    message: row.message,
    requestedByUserId: row.requestedByUserId,
    requestedByDisplayName: row.requestedByDisplayName,
    requestedAtMs: row.requestedAtMs,
    expiresAtMs: row.expiresAtMs,
    version: 1,
  });
}

function commandResultRecord(
  database,
  ids,
  {
    id,
    helpRequestId,
    idempotencyRequestId,
    requestHash,
    httpStatus,
    createdAtMs,
    overrides = {},
  }
) {
  const responseJson = canonicalHelpResponse(
    database,
    ids,
    helpRequestId
  );
  const response = JSON.parse(responseJson);
  return {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.card,
    team_id: ids.team,
    help_request_id: helpRequestId,
    idempotency_request_id: idempotencyRequestId,
    actor_user_id: ids.managerUser,
    actor_membership_id: ids.managerMembership,
    actor_authority: "manager",
    manager_assignment_id: ids.managerAssignment,
    request_sha256: requestHash,
    requested_by_display_name: response.requestedByDisplayName,
    response_http_status: httpStatus,
    response_json: responseJson,
    response_sha256: sha256(responseJson),
    created_at_ms: createdAtMs,
    version: 1,
    ...overrides,
  };
}

function completeRequest(database, ids, requestId, resultId, completedAtMs) {
  database
    .prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type = 'candidate_card_help_command_result',
          result_id = ?,
          completed_at_ms = ?
      WHERE league_id = ? AND id = ?
    `)
    .run(resultId, completedAtMs, ids.league, requestId);
}

function assertHealthy(database) {
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(database.pragma("foreign_key_check"), []);
}

describe("Candidate Card help command-result migration", () => {
  test("upgrades exact schema 34 without changing earlier ledger identities and accepts a pre-migration help intent", (t) => {
    const canonical = discoverMigrations({
      migrationsDirectory: CANONICAL_MIGRATIONS,
    });
    const migration35 = canonical.find(({ id }) => id === 35);
    assert.equal(
      migration35?.fileName,
      "0035_add_candidate_card_help_command_results.sql"
    );

    const runtime = createRuntime(t, "hundo-candidate-help-result-upgrade-");
    copyMigrations(runtime, 1, 34);
    migrate(runtime, "candidate-help-result-before");
    const ids = seedOpenCandidateCard(runtime.database);
    const helpRequestId = uuid(35_100);
    const requestId = uuid(35_101);
    const resultId = uuid(35_102);
    const requestHash = "a".repeat(64);
    insertStartedRequest(runtime.database, ids, {
      id: requestId,
      clientKey: "candidate-help-create",
      requestHash,
      createdAtMs: HELP_AT_MS,
    });
    insertHelpRequest(runtime.database, ids, { id: helpRequestId });

    const ledgerBefore = runtime.database
      .prepare(`
        SELECT migration_id, file_name, checksum
        FROM schema_migrations
        ORDER BY migration_id
      `)
      .all();
    copyMigrations(runtime, 35, 35);
    const migrationResult = migrate(runtime, "candidate-help-result-after");

    assert.equal(migrationResult.status, "exact");
    assert.equal(
      runtime.database.pragma("user_version", { simple: true }),
      35
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
      { metadataValue: "35", updatedAtMs: 35 }
    );
    const ledgerAfter = runtime.database
      .prepare(`
        SELECT migration_id, file_name, checksum
        FROM schema_migrations
        ORDER BY migration_id
      `)
      .all();
    assert.deepEqual(ledgerAfter.slice(0, 34), ledgerBefore);
    assert.deepEqual(ledgerAfter[34], {
      migration_id: 35,
      file_name: migration35.fileName,
      checksum: migration35.checksum,
    });

    insert(
      runtime.database,
      "candidate_card_help_command_results",
      commandResultRecord(runtime.database, ids, {
        id: resultId,
        helpRequestId,
        idempotencyRequestId: requestId,
        requestHash,
        httpStatus: 201,
        createdAtMs: HELP_AT_MS,
      })
    );
    completeRequest(runtime.database, ids, requestId, resultId, HELP_AT_MS);

    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT response_http_status AS responseHttpStatus,
                 response_json AS responseJson,
                 response_sha256 AS responseSha256
          FROM candidate_card_help_command_results
          WHERE league_id = ? AND id = ?
        `)
        .get(ids.league, resultId),
      {
        responseHttpStatus: 201,
        responseJson: canonicalHelpResponse(
          runtime.database,
          ids,
          helpRequestId
        ),
        responseSha256: sha256(
          canonicalHelpResponse(runtime.database, ids, helpRequestId)
        ),
      }
    );
    assertHealthy(runtime.database);
  });

  test("stores the created 201 and later active-intent 200 as exact immutable replay results", (t) => {
    const runtime = createRuntime(t, "hundo-candidate-help-result-lifecycle-");
    copyMigrations(runtime, 1, 35);
    migrate(runtime, "candidate-help-result-lifecycle");
    const ids = seedOpenCandidateCard(runtime.database);
    const helpRequestId = uuid(35_200);
    const createRequestId = uuid(35_201);
    const createResultId = uuid(35_202);
    const existingRequestId = uuid(35_203);
    const existingResultId = uuid(35_204);
    const createHash = "b".repeat(64);
    const existingHash = "c".repeat(64);

    insertStartedRequest(runtime.database, ids, {
      id: createRequestId,
      clientKey: "candidate-help-created",
      requestHash: createHash,
      createdAtMs: HELP_AT_MS,
    });
    insertHelpRequest(runtime.database, ids, {
      id: helpRequestId,
      message: null,
    });
    const createdRecord = commandResultRecord(runtime.database, ids, {
        id: createResultId,
        helpRequestId,
        idempotencyRequestId: createRequestId,
        requestHash: createHash,
        httpStatus: 201,
        createdAtMs: HELP_AT_MS,
      });
    insert(
      runtime.database,
      "candidate_card_help_command_results",
      createdRecord
    );
    completeRequest(
      runtime.database,
      ids,
      createRequestId,
      createResultId,
      HELP_AT_MS
    );

    runtime.database
      .prepare(`
        UPDATE users
        SET display_name = 'Renamed Manager',
            display_name_normalized = 'renamed manager',
            updated_at_ms = ?,
            version = 2
        WHERE id = ?
      `)
      .run(HELP_AT_MS + 1, ids.managerUser);

    insertStartedRequest(runtime.database, ids, {
      id: existingRequestId,
      clientKey: "candidate-help-already-active",
      requestHash: existingHash,
      createdAtMs: HELP_AT_MS + 1,
    });
    const existingRecord = commandResultRecord(runtime.database, ids, {
        id: existingResultId,
        helpRequestId,
        idempotencyRequestId: existingRequestId,
        requestHash: existingHash,
        httpStatus: 200,
        createdAtMs: HELP_AT_MS + 1,
        overrides: {
          requested_by_display_name:
            createdRecord.requested_by_display_name,
          response_json: createdRecord.response_json,
          response_sha256: createdRecord.response_sha256,
        },
      });
    insert(
      runtime.database,
      "candidate_card_help_command_results",
      existingRecord
    );
    completeRequest(
      runtime.database,
      ids,
      existingRequestId,
      existingResultId,
      HELP_AT_MS + 1
    );

    const rowsBeforeExpiry = runtime.database
      .prepare(`
        SELECT result.response_http_status AS responseHttpStatus,
               result.response_json AS responseJson,
               request.status AS requestStatus,
               request.result_type AS resultType,
               request.result_id AS resultId
        FROM candidate_card_help_command_results AS result
        JOIN idempotency_requests AS request
          ON request.league_id = result.league_id
         AND request.id = result.idempotency_request_id
        WHERE result.league_id = ?
        ORDER BY result.created_at_ms, result.id
      `)
      .all(ids.league);
    assert.deepEqual(
      rowsBeforeExpiry.map(({ responseHttpStatus }) => responseHttpStatus),
      [201, 200]
    );
    assert.equal(
      rowsBeforeExpiry[0].responseJson,
      rowsBeforeExpiry[1].responseJson
    );
    assert.deepEqual(
      rowsBeforeExpiry.map(({ requestStatus, resultType, resultId }) => ({
        requestStatus,
        resultType,
        resultId,
      })),
      [
        {
          requestStatus: "completed",
          resultType: "candidate_card_help_command_result",
          resultId: createResultId,
        },
        {
          requestStatus: "completed",
          resultType: "candidate_card_help_command_result",
          resultId: existingResultId,
        },
      ]
    );

    runtime.database
      .prepare(`
        UPDATE candidate_card_help_requests
        SET status = 'expired',
            updated_at_ms = ?,
            version = 2
        WHERE league_id = ? AND id = ?
      `)
      .run(CANDIDATE_DEADLINE_AT_MS, ids.league, helpRequestId);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT response_http_status AS responseHttpStatus,
                 response_json AS responseJson
          FROM candidate_card_help_command_results
          WHERE league_id = ?
          ORDER BY created_at_ms, id
        `)
        .all(ids.league),
      rowsBeforeExpiry.map(({ responseHttpStatus, responseJson }) => ({
        responseHttpStatus,
        responseJson,
      }))
    );
    assert.equal(JSON.parse(rowsBeforeExpiry[0].responseJson).status, "active");
    assertHealthy(runtime.database);
  });

  test("rejects incomplete lifecycle evidence, cross-scope grants, noncanonical responses, and tampering", (t) => {
    const runtime = createRuntime(t, "hundo-candidate-help-result-guards-");
    copyMigrations(runtime, 1, 35);
    migrate(runtime, "candidate-help-result-guards");
    const ids = seedOpenCandidateCard(runtime.database);
    const helpRequestId = uuid(35_300);
    const createRequestId = uuid(35_301);
    const createResultId = uuid(35_302);
    const prematureRequestId = uuid(35_303);
    const createHash = "d".repeat(64);
    const prematureHash = "e".repeat(64);

    insertHelpRequest(runtime.database, ids, { id: helpRequestId });
    insertStartedRequest(runtime.database, ids, {
      id: prematureRequestId,
      clientKey: "candidate-help-premature-200",
      requestHash: prematureHash,
      createdAtMs: HELP_AT_MS + 1,
    });
    assert.throws(
      () =>
        insert(
          runtime.database,
          "candidate_card_help_command_results",
          commandResultRecord(runtime.database, ids, {
            id: uuid(35_304),
            helpRequestId,
            idempotencyRequestId: prematureRequestId,
            requestHash: prematureHash,
            httpStatus: 200,
            createdAtMs: HELP_AT_MS + 1,
          })
        ),
      /must bind its exact request, manager, grant, status, and response/
    );

    insertStartedRequest(runtime.database, ids, {
      id: createRequestId,
      clientKey: "candidate-help-valid-create",
      requestHash: createHash,
      createdAtMs: HELP_AT_MS,
    });
    assert.throws(
      () => completeRequest(
        runtime.database,
        ids,
        createRequestId,
        createResultId,
        HELP_AT_MS
      ),
      /must complete against its exact immutable result/
    );

    const valid = commandResultRecord(runtime.database, ids, {
      id: createResultId,
      helpRequestId,
      idempotencyRequestId: createRequestId,
      requestHash: createHash,
      httpStatus: 201,
      createdAtMs: HELP_AT_MS,
    });
    for (const overrides of [
      { request_sha256: "f".repeat(64) },
      { manager_assignment_id: uuid(99_999) },
      { requested_by_display_name: "Wrong Manager" },
      { response_http_status: 202 },
      { response_json: `{ ${valid.response_json.slice(1)}` },
      { response_sha256: "A".repeat(64) },
    ]) {
      assert.throws(() =>
        insert(runtime.database, "candidate_card_help_command_results", {
          ...valid,
          id: uuid(35_310 + Object.keys(overrides)[0].length),
          ...overrides,
        })
      );
    }

    insert(runtime.database, "candidate_card_help_command_results", valid);
    assert.throws(
      () =>
        runtime.database
          .prepare(`
            UPDATE idempotency_requests
            SET status = 'failed', completed_at_ms = ?
            WHERE league_id = ? AND id = ?
          `)
          .run(HELP_AT_MS, ids.league, createRequestId),
      /must complete against its exact immutable result/
    );
    completeRequest(
      runtime.database,
      ids,
      createRequestId,
      createResultId,
      HELP_AT_MS
    );

    const duplicateCreateRequestId = uuid(35_320);
    insertStartedRequest(runtime.database, ids, {
      id: duplicateCreateRequestId,
      clientKey: "candidate-help-second-create",
      requestHash: "1".repeat(64),
      createdAtMs: HELP_AT_MS,
    });
    assert.throws(
      () =>
        insert(
          runtime.database,
          "candidate_card_help_command_results",
          commandResultRecord(runtime.database, ids, {
            id: uuid(35_321),
            helpRequestId,
            idempotencyRequestId: duplicateCreateRequestId,
            requestHash: "1".repeat(64),
            httpStatus: 201,
            createdAtMs: HELP_AT_MS,
          })
        ),
      /UNIQUE constraint failed/
    );

    assert.throws(
      () =>
        runtime.database
          .prepare(`
            UPDATE candidate_card_help_command_results
            SET response_http_status = 200
            WHERE league_id = ? AND id = ?
          `)
          .run(ids.league, createResultId),
      /help command results are immutable/
    );
    assert.throws(
      () =>
        runtime.database
          .prepare(`
            DELETE FROM candidate_card_help_command_results
            WHERE league_id = ? AND id = ?
          `)
          .run(ids.league, createResultId),
      /help command results are immutable/
    );
    assert.throws(
      () =>
        runtime.database
          .prepare(`
            UPDATE idempotency_requests
            SET result_id = ?
            WHERE league_id = ? AND id = ?
          `)
          .run(uuid(35_399), ids.league, createRequestId),
      /completed Candidate Card help request evidence is immutable/
    );
    assert.throws(
      () =>
        runtime.database
          .prepare(`
            DELETE FROM idempotency_requests
            WHERE league_id = ? AND id = ?
          `)
          .run(ids.league, createRequestId),
      /help result request evidence is immutable/
    );
    assertHealthy(runtime.database);
  });
});
