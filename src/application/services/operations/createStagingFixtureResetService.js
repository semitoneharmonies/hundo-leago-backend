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

function resetFixtureRows({
  database,
  passwordHash,
  actorUserId,
  backup,
  idempotency,
  occurredAtMs,
  createId,
  reason,
}) {
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
      const refreshedAuthority =
        platformAuthorization.requireAdministrator(authenticated);
      assertAuthorityUnchanged(authority, refreshedAuthority);
      assertFixtureIdentity(database);
      assertFixtureResetScope(database);
      const passwordHash = requireFixturePasswordHash();
      return resetFixtureRows({
        database,
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
  StagingFixtureResetError,
  createStagingFixtureResetService,
  resetFixtureRows,
};
