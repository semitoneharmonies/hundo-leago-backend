const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  assertDatabaseIdentity,
} = require("../../../infrastructure/database/databaseIdentity");
const {
  EVENT_TYPE: PROVIDER_IMPORT_EVENT_TYPE,
  OPERATION: PROVIDER_IMPORT_OPERATION,
} = require("./createStagingSportsDataIoImportService");
const {
  StagingMaintenanceExclusionError,
} = require("./createStagingMaintenanceExclusionGuard");
const {
  createVerifiedBackup,
} = require("../../../infrastructure/database/sqliteBackup");
const {
  seedFixture,
} = require("../../../operations/release/createReleaseQaFixture");
const {
  ACCOUNT_ALIASES,
  FIXTURE_BUILD_ID,
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  LEAGUE_ALIASES,
  PLAYER_BLUEPRINTS,
  fixtureId,
} = require("../../../operations/release/releaseQaFixtureContract");

const CONFIRMATION = "RESET STAGING TEST LEAGUES";
const OPERATION = "staging_fixture_reset";
const MAINTENANCE_EXCLUSION = "release_qa_fixture_reset";
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const FIXTURE_LEAGUE_IDS = Object.freeze(
  LEAGUE_ALIASES.map((alias) => fixtureId(`league:${alias}`))
);
const FIXTURE_USER_IDS = Object.freeze(
  ACCOUNT_ALIASES.map((alias) => fixtureId(`account:${alias}`))
);
const FIXTURE_PLAYER_IDS = Object.freeze(
  PLAYER_BLUEPRINTS.map((player) =>
    fixtureId(`player:${player.alias}`)
  )
);
const FIXTURE_RESET_PROTECTED_TRIGGER_NAMES = Object.freeze([
  "auction_administration_command_results_immutable_delete",
  "auction_contexts_immutable_delete",
  "candidate_card_entries_open_delete",
  "candidate_card_entries_valid_carryover_delete",
  "candidate_card_help_command_results_immutable_delete",
  "candidate_card_help_requests_immutable_delete",
  "candidate_card_revisions_immutable_delete",
  "candidate_card_snapshot_entries_immutable_delete",
  "candidate_card_snapshots_immutable_delete",
  "candidate_cards_immutable_delete",
  "commissioner_corrections_fad_allocation_immutable_delete",
  "entry_draft_on_clock_trades_immutable_delete",
  "entry_draft_pick_clocks_immutable_delete",
  "entry_draft_rollover_bindings_immutable_delete",
  "entry_draft_schedule_operations_immutable_delete",
  "fad_auction_bids_immutable_delete",
  "fad_auction_events_immutable_delete",
  "fad_auction_resolutions_immutable_delete",
  "free_agent_draft_allocation_correction_results_immutable_delete",
  "free_agent_draft_allocation_events_immutable_delete",
  "free_agent_draft_allocations_immutable_delete",
  "free_agent_draft_auction_participants_immutable_delete",
  "free_agent_draft_draws_immutable_delete",
  "free_agent_draft_eligibility_revalidation_immutable_delete",
  "free_agent_draft_nomination_queue_immutable_delete",
  "free_agent_draft_readiness_attempts_immutable_delete",
  "free_agent_draft_readiness_corrective_requeues_immutable_delete",
  "free_agent_draft_readiness_operations_immutable_delete",
  "free_agent_draft_readiness_retry_receipts_immutable_delete",
  "free_agent_draft_recoveries_immutable_delete",
  "free_agent_draft_recovery_action_results_immutable_delete",
  "free_agent_draft_rollovers_immutable_delete",
  "free_agent_draft_schedule_recoveries_immutable_delete",
  "free_agent_draft_schedule_recovery_jobs_immutable_delete",
  "free_agent_draft_schedule_recovery_matchups_immutable_delete",
  "free_agent_draft_schedule_recovery_weeks_immutable_delete",
  "free_agent_draft_setup_exemptions_immutable_delete",
  "free_agent_draft_teams_immutable_delete",
  "free_agent_drafts_immutable_delete",
  "idempotency_requests_auction_administration_result_delete",
  "idempotency_requests_candidate_card_help_result_delete",
  "idempotency_requests_entry_draft_schedule_delete",
  "idempotency_requests_fad_allocation_correction_result_delete",
  "idempotency_requests_fad_nomination_queue_delete",
  "idempotency_requests_fad_open_rapid_start_delete",
  "idempotency_requests_fad_recovery_action_result_delete",
  "idempotency_requests_lifecycle_delete_0029",
  "idempotency_requests_lifecycle_v2_delete",
  "idempotency_requests_matchup_schedule_result_delete",
  "idempotency_requests_standings_finalization_immutable_delete",
  "job_runs_fad_eligibility_revalidation_identity_delete",
  "matchup_operations_result_correct_immutable_delete",
  "matchup_operations_schedule_generate_immutable_delete",
  "matchup_result_versions_immutable_delete",
  "matchup_roster_game_exclusion_sets_immutable_delete",
  "matchup_roster_game_exclusions_immutable_delete",
  "matchup_schedule_command_results_immutable_delete",
  "matchup_schedule_job_bindings_immutable_delete",
  "nhl_game_state_observation_snapshots_immutable_delete",
  "nhl_game_state_observations_immutable_delete",
  "operational_events_fad_eligibility_catalog_immutable_delete",
  "player_game_stat_observations_immutable_delete",
  "player_source_state_fad_eligibility_evidence_delete",
  "season_matchup_schedule_generations_immutable_delete",
  "season_rollover_attempts_immutable_delete",
  "season_rollover_items_immutable_delete",
  "season_rollover_occurrences_immutable_delete",
  "season_rollovers_immutable_delete",
  "standings_operations_finalization_immutable_delete",
  "standings_rows_canonical_delete",
  "standings_snapshot_finalizations_immutable_delete",
  "standings_snapshot_result_versions_immutable_delete",
  "standings_snapshot_team_identities_immutable_delete",
  "standings_snapshots_canonical_delete",
  "stat_refresh_player_game_coverage_immutable_delete",
  "stat_refresh_player_game_coverage_immutable_update",
  "stat_refresh_player_game_coverage_stage_before_set",
  "stat_refresh_player_game_sets_immutable_delete",
]);
const FIXTURE_RESET_DELETE_TRIGGER_NAMES =
  FIXTURE_RESET_PROTECTED_TRIGGER_NAMES;
const FIXTURE_RESET_NON_DELETE_TRIGGER_OPERATIONS = Object.freeze({
  stat_refresh_player_game_coverage_immutable_update:
    "BEFORE UPDATE ON",
  stat_refresh_player_game_coverage_stage_before_set:
    "BEFORE INSERT ON",
});

class StagingFixtureResetError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StagingFixtureResetError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new StagingFixtureResetError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`staging fixture reset requires ${description}`);
  }
}

function exactInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, "confirmation") ||
    !Object.hasOwn(input, "reason") ||
    input.confirmation !== CONFIRMATION ||
    typeof input.reason !== "string" ||
    input.reason.trim() !== input.reason ||
    input.reason.length < 1 ||
    input.reason.length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(input.reason)
  ) {
    fail(
      "STAGING_FIXTURE_RESET_INPUT_INVALID",
      "Exact reset confirmation and a bounded reason are required."
    );
  }
  return Object.freeze({ ...input });
}

function canonicalIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !KEY_PATTERN.test(value)
  ) {
    fail(
      "STAGING_FIXTURE_RESET_IDEMPOTENCY_INVALID",
      "A bounded idempotency key is required."
    );
  }
  return value;
}

function requestHash({ actorUserId, idempotencyKey, input }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      actorUserId,
      idempotencyKey,
      operation: OPERATION,
      input,
    }))
    .digest("hex");
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableNames(database) {
  return database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `)
    .all()
    .map(({ name }) => name);
}

function tableColumns(database, tableName) {
  return database
    .pragma(`table_info(${quoteIdentifier(tableName)})`)
    .map(({ name }) => name);
}

function hasOutOfScopeReference({
  database,
  tableName,
  identityColumns,
  identityIds,
}) {
  if (identityColumns.length === 0 || identityIds.length === 0) {
    return false;
  }
  const leaguePlaceholders = FIXTURE_LEAGUE_IDS
    .map(() => "?")
    .join(", ");
  const identityPlaceholders = identityIds
    .map(() => "?")
    .join(", ");
  const predicates = identityColumns.map(
    (column) =>
      `${quoteIdentifier(column)} IN (${identityPlaceholders})`
  );
  return Boolean(
    database
      .prepare(`
        SELECT 1 AS conflict
        FROM ${quoteIdentifier(tableName)}
        WHERE league_id IS NOT NULL
          AND league_id NOT IN (${leaguePlaceholders})
          AND (${predicates.join(" OR ")})
        LIMIT 1
      `)
      .get(
        ...FIXTURE_LEAGUE_IDS,
        ...identityColumns.flatMap(() => identityIds)
      )
  );
}

function assertFixtureResetScope(database) {
  for (const tableName of tableNames(database)) {
    const columns = tableColumns(database, tableName);
    if (!columns.includes("league_id")) continue;

    const userColumns = columns.filter(
      (name) =>
        name === "user_id" || name.endsWith("_user_id")
    );
    const playerColumns = columns.filter(
      (name) =>
        name === "player_id" || name.endsWith("_player_id")
    );
    if (
      hasOutOfScopeReference({
        database,
        tableName,
        identityColumns: userColumns,
        identityIds: FIXTURE_USER_IDS,
      }) ||
      hasOutOfScopeReference({
        database,
        tableName,
        identityColumns: playerColumns,
        identityIds: FIXTURE_PLAYER_IDS,
      })
    ) {
      fail(
        "STAGING_FIXTURE_RESET_SCOPE_CONFLICT",
        "Fixture users or players are referenced outside the staging test leagues."
      );
    }
  }
}

function assertFixtureIdentity(database) {
  let identity;
  try {
    identity = assertDatabaseIdentity(database, {
      environmentId: FIXTURE_ENVIRONMENT_ID,
      databaseId: FIXTURE_DATABASE_ID,
    });
  } catch (error) {
    if (String(error?.code || "").startsWith("DATABASE_IDENTITY_")) {
      fail(
        "STAGING_FIXTURE_RESET_IDENTITY_MISMATCH",
        "The database is not the staging release-QA fixture.",
        error
      );
    }
    throw error;
  }
  if (
    identity.environmentId !== FIXTURE_ENVIRONMENT_ID ||
    identity.databaseId !== FIXTURE_DATABASE_ID
  ) {
    fail(
      "STAGING_FIXTURE_RESET_IDENTITY_MISMATCH",
      "The database is not the staging release-QA fixture."
    );
  }
  return identity;
}

function assertAuthorityUnchanged(before, after) {
  for (const field of [
    "actorUserId",
    "authority",
    "roleId",
    "roleVersion",
    "userVersion",
  ]) {
    if (before?.[field] !== after?.[field]) {
      fail(
        "STAGING_FIXTURE_RESET_AUTHORITY_CHANGED",
        "Platform-administrator authority changed during fixture reset."
      );
    }
  }
}

function parseStoredResult(detailsJson) {
  let details;
  try {
    details = JSON.parse(detailsJson);
  } catch (error) {
    fail(
      "STAGING_FIXTURE_RESET_STATE_INVALID",
      "The prior reset result is unavailable.",
      error
    );
  }
  const result =
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    details.result &&
    typeof details.result === "object" &&
    !Array.isArray(details.result)
      ? details.result
      : details;
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.code !== "STAGING_FIXTURE_RESET_COMPLETED"
  ) {
    fail(
      "STAGING_FIXTURE_RESET_STATE_INVALID",
      "The prior reset result is unavailable."
    );
  }
  return Object.freeze({ ...result });
}

function deleteWhereAnyColumnMatches(database, tableName, columns, ids) {
  if (columns.length === 0 || ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  const predicates = columns.map(
    (column) => `${quoteIdentifier(column)} IN (${placeholders})`
  );
  database
    .prepare(
      `DELETE FROM ${quoteIdentifier(tableName)} WHERE ${predicates.join(" OR ")}`
    )
    .run(...columns.flatMap(() => ids));
}

function expectedFixtureProtectionOperation(name) {
  return (
    FIXTURE_RESET_NON_DELETE_TRIGGER_OPERATIONS[name] ||
    "BEFORE DELETE ON"
  );
}

function suspendFixtureProtectionTriggers(database) {
  const placeholders = FIXTURE_RESET_PROTECTED_TRIGGER_NAMES
    .map(() => "?")
    .join(", ");
  const rows = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name IN (${placeholders})
      ORDER BY name ASC
    `)
    .all(...FIXTURE_RESET_PROTECTED_TRIGGER_NAMES);
  if (
    rows.length !== FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.length ||
    rows.some(({ name, sql }, index) =>
      name !==
        [...FIXTURE_RESET_PROTECTED_TRIGGER_NAMES].sort()[index] ||
      typeof sql !== "string" ||
      !sql.includes(expectedFixtureProtectionOperation(name))
    )
  ) {
    fail(
      "STAGING_FIXTURE_RESET_SCHEMA_INVALID",
      "The staging fixture protections do not match the approved schema."
    );
  }
  for (const { name } of rows) {
    database.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
  }
  return rows;
}

function restoreFixtureProtectionTriggers(database, triggerRows) {
  for (const { sql } of triggerRows) {
    database.exec(sql);
  }
  const restored = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name IN (
          ${triggerRows.map(() => "?").join(", ")}
        )
      ORDER BY name ASC
    `)
    .all(...triggerRows.map(({ name }) => name));
  if (
    restored.length !== triggerRows.length ||
    restored.some(({ name, sql }, index) =>
      name !== triggerRows[index].name ||
      sql !== triggerRows[index].sql
    )
  ) {
    fail(
      "STAGING_FIXTURE_RESET_SCHEMA_INVALID",
      "The staging fixture protections were not restored exactly."
    );
  }
}

function resetFixtureRows({
  database,
  maintenanceExclusionGuard,
  passwordHash,
  actorUserId,
  backup,
  idempotency,
  occurredAtMs,
  createId,
  reason,
}) {
  assertMethod(
    maintenanceExclusionGuard,
    "assertExclusion",
    "a staging maintenance-exclusion guard"
  );
  const leagueIds = FIXTURE_LEAGUE_IDS;
  const userIds = FIXTURE_USER_IDS;
  const playerIds = FIXTURE_PLAYER_IDS;
  const statSourceId = fixtureId("stat-source");
  const tables = tableNames(database);

  const sportsDataIoCountBefore = database
    .prepare(`
      SELECT COUNT(*) AS count
      FROM player_external_ids
      WHERE provider = 'sportsdataio-discovery-lab'
    `)
    .get().count;

  const foreignKeysBefore = database.pragma("foreign_keys", {
    simple: true,
  });
  try {
    database.pragma("foreign_keys = OFF");
    database.exec("BEGIN IMMEDIATE");
    assertFixtureIdentity(database);
    assertFixtureResetScope(database);
    maintenanceExclusionGuard.assertExclusion(
      MAINTENANCE_EXCLUSION
    );
    const suspendedProtectionTriggers =
      suspendFixtureProtectionTriggers(database);

    for (const tableName of tables) {
      const columns = tableColumns(database, tableName);
      if (columns.includes("league_id")) {
        deleteWhereAnyColumnMatches(
          database,
          tableName,
          ["league_id"],
          leagueIds
        );
      }
    }

    for (const tableName of tables) {
      if (
        [
          "idempotency_requests",
          "league_activity",
          "league_memberships",
          "leagues",
          "operational_events",
          "users",
        ].includes(tableName)
      ) {
        continue;
      }
      const userColumns = tableColumns(database, tableName).filter(
        (name) =>
          name === "user_id" ||
          name.endsWith("_user_id")
      );
      deleteWhereAnyColumnMatches(
        database,
        tableName,
        userColumns,
        userIds
      );
    }
    database
      .prepare(`
        DELETE FROM idempotency_requests
        WHERE actor_user_id IN (${userIds.map(() => "?").join(", ")})
          AND NOT (
            league_id IS NULL
            AND operation IN (?, ?)
          )
      `)
      .run(...userIds, OPERATION, PROVIDER_IMPORT_OPERATION);
    database
      .prepare(`
        DELETE FROM operational_events
        WHERE actor_user_id IN (${userIds.map(() => "?").join(", ")})
          AND NOT (
            league_id IS NULL
            AND event_type IN (
              'staging_fixture_reset',
              ?
            )
          )
      `)
      .run(...userIds, PROVIDER_IMPORT_EVENT_TYPE);

    for (const tableName of tables) {
      if (tableName === "players") continue;
      const columns = tableColumns(database, tableName);
      if (columns.includes("player_id")) {
        deleteWhereAnyColumnMatches(
          database,
          tableName,
          ["player_id"],
          playerIds
        );
      }
    }
    database
      .prepare(
        "DELETE FROM player_game_stat_observations WHERE stat_source_id = ?"
      )
      .run(statSourceId);
    database
      .prepare(
        "DELETE FROM stat_refresh_player_game_coverage_entries " +
          "WHERE stat_source_id = ?"
      )
      .run(statSourceId);
    database
      .prepare(
        "DELETE FROM stat_refresh_player_game_sets WHERE stat_source_id = ?"
      )
      .run(statSourceId);
    database
      .prepare("DELETE FROM player_stat_totals WHERE stat_source_id = ?")
      .run(statSourceId);
    database
      .prepare("DELETE FROM stat_refreshes WHERE stat_source_id = ?")
      .run(statSourceId);
    database
      .prepare("DELETE FROM stat_sources WHERE id = ?")
      .run(statSourceId);
    database
      .prepare(
        `DELETE FROM leagues WHERE id IN (${leagueIds.map(() => "?").join(", ")})`
      )
      .run(...leagueIds);
    database
      .prepare(
        `DELETE FROM players WHERE id IN (${playerIds.map(() => "?").join(", ")})`
      )
      .run(...playerIds);
    database
      .prepare(
        `DELETE FROM users WHERE id IN (${userIds.map(() => "?").join(", ")})`
      )
      .run(...userIds);

    restoreFixtureProtectionTriggers(
      database,
      suspendedProtectionTriggers
    );
    seedFixture(database, passwordHash, {
      includeIdentityMetadata: false,
    });

    const sportsDataIoCountAfter = database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM player_external_ids
        WHERE provider = 'sportsdataio-discovery-lab'
      `)
      .get().count;
    if (sportsDataIoCountAfter !== sportsDataIoCountBefore) {
      fail(
        "STAGING_FIXTURE_RESET_CATALOG_CHANGED",
        "The staging provider catalog changed during fixture reset."
      );
    }

    const backupCatalogId = createId();
    database
      .prepare(`
        INSERT INTO backup_catalog (
          id, league_id, environment_identity, backup_kind,
          storage_reference, database_checksum, schema_version,
          source_database_id, status, created_at_ms, verified_at_ms,
          metadata_json
        ) VALUES (
          ?, NULL, ?, 'manual', ?, ?, ?, ?, 'verified', ?, ?, ?
        )
      `)
      .run(
        backupCatalogId,
        FIXTURE_ENVIRONMENT_ID,
        backup.outputDirectory,
        backup.plaintextSha256,
        database.pragma("user_version", { simple: true }),
        FIXTURE_DATABASE_ID,
        occurredAtMs,
        occurredAtMs,
        JSON.stringify({
          backupId: backup.backupId,
          purpose: "pre-staging-fixture-reset",
        })
      );

    const eventId = createId();
    const result = Object.freeze({
      code: "STAGING_FIXTURE_RESET_COMPLETED",
      fixtureBuildId: FIXTURE_BUILD_ID,
      resetAtMs: occurredAtMs,
      backupId: backup.backupId,
      providerCatalogPlayerCount: sportsDataIoCountAfter,
      sessionInvalidated: true,
    });
    database
      .prepare(`
        INSERT INTO operational_events (
          id, league_id, season_id, event_type, feature, outcome,
          actor_user_id, reason_code, details_json, occurred_at_ms
        ) VALUES (
          ?, NULL, NULL, 'staging_fixture_reset', 'release_qa',
          'succeeded', ?, 'manual_test_reset', ?, ?
        )
      `)
      .run(
        eventId,
        actorUserId,
        JSON.stringify({
          result,
          audit: {
            reason,
          },
        }),
        occurredAtMs
      );
    database
      .prepare(`
        INSERT INTO idempotency_requests (
          id, league_id, actor_user_id, operation, client_key,
          request_hash, status, result_type, result_id,
          created_at_ms, completed_at_ms, expires_at_ms
        ) VALUES (
          ?, NULL, ?, ?, ?, ?, 'completed',
          'operational_event', ?, ?, ?, ?
        )
      `)
      .run(
        idempotency.id,
        actorUserId,
        OPERATION,
        idempotency.key,
        idempotency.requestHash,
        eventId,
        occurredAtMs,
        occurredAtMs,
        occurredAtMs + 24 * 60 * 60 * 1000
      );

    const foreignKeyFailures = database.pragma("foreign_key_check");
    if (foreignKeyFailures.length > 0) {
      fail(
        "STAGING_FIXTURE_RESET_FOREIGN_KEY_FAILED",
        "The reset fixture failed foreign-key verification."
      );
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.pragma(
      `foreign_keys = ${foreignKeysBefore === 1 ? "ON" : "OFF"}`
    );
  }
}

function createStagingFixtureResetService({
  database,
  databasePath,
  persistentRoot,
  appEnv,
  environmentId,
  databaseId,
  maintenanceExclusionGuard,
  platformAuthorization,
  clock,
  createId = crypto.randomUUID,
  createBackup = createVerifiedBackup,
  fsModule = fs,
} = {}) {
  if (
    appEnv !== "staging" ||
    environmentId !== FIXTURE_ENVIRONMENT_ID ||
    databaseId !== FIXTURE_DATABASE_ID
  ) {
    throw new TypeError(
      "staging fixture reset requires the exact staging fixture identity"
    );
  }
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.pragma !== "function" ||
    typeof database.exec !== "function" ||
    !path.isAbsolute(databasePath || "") ||
    !path.isAbsolute(persistentRoot || "") ||
    typeof createId !== "function" ||
    typeof createBackup !== "function" ||
    !fsModule ||
    typeof fsModule.mkdirSync !== "function"
  ) {
    throw new TypeError(
      "staging fixture reset requires database, path, backup, and filesystem boundaries"
    );
  }
  assertMethod(
    maintenanceExclusionGuard,
    "assertExclusion",
    "a staging maintenance-exclusion guard"
  );
  assertMethod(
    platformAuthorization,
    "requireAdministrator",
    "platform-administrator authorization"
  );
  assertMethod(clock, "nowMs", "a clock");
  const findIdempotency = database.prepare(`
    SELECT *
    FROM idempotency_requests
    WHERE league_id IS NULL
      AND actor_user_id = ?
      AND operation = ?
      AND client_key = ?
    LIMIT 2
  `);
  const findResult = database.prepare(`
    SELECT details_json
    FROM operational_events
    WHERE id = ?
      AND event_type = 'staging_fixture_reset'
      AND outcome = 'succeeded'
    LIMIT 2
  `);
  const credentialQuery = database.prepare(`
    SELECT credential.password_hash
    FROM user_credentials AS credential
    WHERE credential.user_id = ?
      AND credential.status = 'active'
    LIMIT 2
  `);
  let resetInProgress = false;

  function requireFixturePasswordHash() {
    const credentialRows = credentialQuery.all(
      fixtureId("account:platformAdmin")
    );
    if (
      credentialRows.length !== 1 ||
      typeof credentialRows[0].password_hash !== "string"
    ) {
      fail(
        "STAGING_FIXTURE_RESET_CREDENTIAL_REQUIRED",
        "The deterministic staging credential foundation is unavailable."
      );
    }
    return credentialRows[0].password_hash;
  }

  async function reset({
    input,
    idempotencyKey,
    authenticated,
  } = {}) {
    if (resetInProgress) {
      fail(
        "STAGING_FIXTURE_RESET_IN_PROGRESS",
        "A staging fixture reset is already in progress."
      );
    }
    const body = exactInput(input);
    const key = canonicalIdempotencyKey(idempotencyKey);
    const authority =
      platformAuthorization.requireAdministrator(authenticated);
    const hash = requestHash({
      actorUserId: authority.actorUserId,
      idempotencyKey: key,
      input: body,
    });
    const priorRows = findIdempotency.all(
      authority.actorUserId,
      OPERATION,
      key
    );
    if (priorRows.length > 1) {
      fail(
        "STAGING_FIXTURE_RESET_STATE_INVALID",
        "Reset idempotency state is not unique."
      );
    }
    if (priorRows[0]) {
      const prior = priorRows[0];
      if (
        prior.request_hash !== hash ||
        prior.status !== "completed" ||
        prior.result_type !== "operational_event" ||
        !prior.result_id
      ) {
        fail(
          "STAGING_FIXTURE_RESET_IDEMPOTENCY_CONFLICT",
          "The reset idempotency key conflicts with an earlier request."
        );
      }
      const results = findResult.all(prior.result_id);
      if (results.length !== 1) {
        fail(
          "STAGING_FIXTURE_RESET_STATE_INVALID",
          "The prior reset result is unavailable."
        );
      }
      return Object.freeze({
        ...parseStoredResult(results[0].details_json),
        replayed: true,
      });
    }

    assertFixtureIdentity(database);
    maintenanceExclusionGuard.assertExclusion(
      MAINTENANCE_EXCLUSION
    );
    assertFixtureResetScope(database);
    requireFixturePasswordHash();
    const occurredAtMs = clock.nowMs();
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
      throw new TypeError("staging fixture reset clock is invalid");
    }

    resetInProgress = true;
    try {
      const backupsRoot = path.join(persistentRoot, "backups");
      fsModule.mkdirSync(backupsRoot, { recursive: true });
      const outputDirectory = path.join(
        backupsRoot,
        `staging-fixture-reset-${occurredAtMs}-${createId()}`
      );
      const backup = await createBackup({
        databasePath,
        outputDirectory,
        environment: "staging",
        reason: "pre-reset",
        capturedAtMs: occurredAtMs,
        temporaryRoot: persistentRoot,
      });
      maintenanceExclusionGuard.assertExclusion(
        MAINTENANCE_EXCLUSION
      );
      const refreshedAuthority =
        platformAuthorization.requireAdministrator(authenticated);
      assertAuthorityUnchanged(authority, refreshedAuthority);
      assertFixtureIdentity(database);
      assertFixtureResetScope(database);
      const passwordHash = requireFixturePasswordHash();
      return resetFixtureRows({
        database,
        maintenanceExclusionGuard,
        passwordHash,
        actorUserId: refreshedAuthority.actorUserId,
        backup,
        idempotency: {
          id: createId(),
          key,
          requestHash: hash,
        },
        occurredAtMs,
        createId,
        reason: body.reason,
      });
    } catch (error) {
      if (
        error instanceof StagingFixtureResetError ||
        error instanceof StagingMaintenanceExclusionError ||
        error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED"
      ) {
        throw error;
      }
      fail(
        "STAGING_FIXTURE_RESET_FAILED",
        "The staging fixture reset failed safely.",
        error
      );
    } finally {
      resetInProgress = false;
    }
  }

  return Object.freeze({ reset });
}

module.exports = {
  CONFIRMATION,
  FIXTURE_RESET_DELETE_TRIGGER_NAMES,
  FIXTURE_RESET_PROTECTED_TRIGGER_NAMES,
  StagingFixtureResetError,
  createStagingFixtureResetService,
  resetFixtureRows,
};
