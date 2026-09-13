const crypto = require("node:crypto");

const {
  assertDatabaseIdentity,
} = require("../../../infrastructure/database/databaseIdentity");
const {
  PROVIDER_NAME,
} = require("../../../infrastructure/sportsdataio/SportsDataIoNhlAdapter");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require("../../../operations/release/releaseQaFixtureContract");
const {
  StagingMaintenanceExclusionError,
} = require("./createStagingMaintenanceExclusionGuard");

const CONFIRMATION = "IMPORT SPORTSDATAIO STAGING DATA";
const OPERATION = "staging_sportsdataio_import";
const EVENT_TYPE = "staging_sportsdataio_import";
const MAINTENANCE_EXCLUSION = "staging_provider_catalog_import";
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

class StagingSportsDataIoImportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StagingSportsDataIoImportError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new StagingSportsDataIoImportError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `staging SportsDataIO import requires ${description}`
    );
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
      "STAGING_SPORTSDATAIO_IMPORT_INPUT_INVALID",
      "Exact import confirmation and a bounded reason are required."
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
      "STAGING_SPORTSDATAIO_IMPORT_IDEMPOTENCY_INVALID",
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

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("staging SportsDataIO import clock is invalid");
  }
  return value;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}

function normalizeImportResult(result, importedAtMs) {
  const catalog = result?.catalog;
  const statistics = result?.statistics;
  if (
    result?.provider !== PROVIDER_NAME ||
    !catalog ||
    !safeCount(catalog.createdPlayerCount) ||
    !safeCount(catalog.updatedPlayerCount) ||
    !safeCount(catalog.sourceStateChangeCount) ||
    !statistics ||
    !UUID_PATTERN.test(statistics.refreshId || "") ||
    statistics.status !== "succeeded" ||
    !safeCount(statistics.playerCount) ||
    (
      statistics.sourceVersion !== null &&
      (
        typeof statistics.sourceVersion !== "string" ||
        statistics.sourceVersion.length < 1 ||
        statistics.sourceVersion.length > 200 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(
          statistics.sourceVersion
        )
      )
    )
  ) {
    fail(
      "STAGING_SPORTSDATAIO_IMPORT_RESULT_INVALID",
      "The staging provider import returned an invalid result."
    );
  }
  return Object.freeze({
    code: "STAGING_SPORTSDATAIO_IMPORT_COMPLETED",
    importedAtMs,
    provider: PROVIDER_NAME,
    catalog: Object.freeze({
      createdPlayerCount: catalog.createdPlayerCount,
      updatedPlayerCount: catalog.updatedPlayerCount,
      sourceStateChangeCount: catalog.sourceStateChangeCount,
    }),
    statistics: Object.freeze({
      refreshId: statistics.refreshId,
      status: statistics.status,
      playerCount: statistics.playerCount,
      sourceVersion: statistics.sourceVersion,
    }),
  });
}

function parseStoredResult(detailsJson) {
  let details;
  try {
    details = JSON.parse(detailsJson);
  } catch (error) {
    fail(
      "STAGING_SPORTSDATAIO_IMPORT_STATE_INVALID",
      "The prior staging provider import result is unavailable.",
      error
    );
  }
  const result = details?.result;
  if (
    !result ||
    result.code !== "STAGING_SPORTSDATAIO_IMPORT_COMPLETED"
  ) {
    fail(
      "STAGING_SPORTSDATAIO_IMPORT_STATE_INVALID",
      "The prior staging provider import result is unavailable."
    );
  }
  return normalizeImportResult(result, result.importedAtMs);
}

function assertFixtureIdentity(database) {
  try {
    return assertDatabaseIdentity(database, {
      environmentId: FIXTURE_ENVIRONMENT_ID,
      databaseId: FIXTURE_DATABASE_ID,
    });
  } catch (error) {
    fail(
      "STAGING_SPORTSDATAIO_IMPORT_IDENTITY_MISMATCH",
      "The database is not the staging release-QA fixture.",
      error
    );
  }
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
        "STAGING_SPORTSDATAIO_IMPORT_AUTHORITY_CHANGED",
        "Platform-administrator authority changed during provider import."
      );
    }
  }
}

function safeFailureCode(error) {
  const code = error?.code;
  return typeof code === "string" &&
    /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
    ? code
    : "STAGING_SPORTSDATAIO_IMPORT_FAILED";
}

function createStagingSportsDataIoImportService({
  database,
  appEnv,
  environmentId,
  databaseId,
  leagueWriteMode,
  scheduledJobsEnabled,
  providerEnabled,
  maintenanceExclusionGuard,
  platformAuthorization,
  importService,
  clock,
  createId = crypto.randomUUID,
} = {}) {
  if (
    appEnv !== "staging" ||
    environmentId !== FIXTURE_ENVIRONMENT_ID ||
    databaseId !== FIXTURE_DATABASE_ID ||
    leagueWriteMode !== "closed" ||
    scheduledJobsEnabled !== false ||
    providerEnabled !== true
  ) {
    throw new TypeError(
      "staging SportsDataIO import requires the exact closed release-QA staging target"
    );
  }
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function" ||
    typeof createId !== "function"
  ) {
    throw new TypeError(
      "staging SportsDataIO import requires database and ID boundaries"
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
  assertMethod(
    importService,
    "importLastSeason",
    "a provider catalog import service"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertFixtureIdentity(database);

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
      AND event_type = '${EVENT_TYPE}'
      AND outcome = 'succeeded'
    LIMIT 2
  `);
  const insertEvent = database.prepare(`
    INSERT INTO operational_events (
      id, league_id, season_id, event_type, feature, outcome,
      actor_user_id, reason_code, details_json, occurred_at_ms
    ) VALUES (
      ?, NULL, NULL, '${EVENT_TYPE}', 'player_data_provider',
      ?, ?, ?, ?, ?
    )
  `);
  const insertIdempotency = database.prepare(`
    INSERT INTO idempotency_requests (
      id, league_id, actor_user_id, operation, client_key,
      request_hash, status, result_type, result_id,
      created_at_ms, completed_at_ms, expires_at_ms
    ) VALUES (
      ?, NULL, ?, ?, ?, ?, 'completed',
      'operational_event', ?, ?, ?, ?
    )
  `);
  const persistSuccess = database.transaction(({
    authority,
    idempotencyKey,
    hash,
    reason,
    result,
  }) => {
    assertFixtureIdentity(database);
    maintenanceExclusionGuard.assertExclusion(
      MAINTENANCE_EXCLUSION
    );
    const eventId = createId();
    insertEvent.run(
      eventId,
      "succeeded",
      authority.actorUserId,
      "manual_staging_import",
      JSON.stringify({
        result,
        audit: { reason },
      }),
      result.importedAtMs
    );
    insertIdempotency.run(
      createId(),
      authority.actorUserId,
      OPERATION,
      idempotencyKey,
      hash,
      eventId,
      result.importedAtMs,
      result.importedAtMs,
      result.importedAtMs + 24 * 60 * 60 * 1000
    );
    return result;
  });

  function recordFailure({ actorUserId, reason, error }) {
    try {
      assertFixtureIdentity(database);
      maintenanceExclusionGuard.assertExclusion(
        MAINTENANCE_EXCLUSION
      );
      insertEvent.run(
        createId(),
        "failed",
        actorUserId,
        "staging_import_failed",
        JSON.stringify({
          audit: { reason },
          error: { code: safeFailureCode(error) },
        }),
        safeTimestamp(clock.nowMs())
      );
    } catch {
      // Never mask the primary failure or write to an unverified database.
    }
  }

  let importInProgress = false;

  async function run({
    input,
    idempotencyKey,
    authenticated,
  } = {}) {
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
        "STAGING_SPORTSDATAIO_IMPORT_STATE_INVALID",
        "Provider import idempotency state is not unique."
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
          "STAGING_SPORTSDATAIO_IMPORT_IDEMPOTENCY_CONFLICT",
          "The provider import idempotency key conflicts with an earlier request."
        );
      }
      const results = findResult.all(prior.result_id);
      if (results.length !== 1) {
        fail(
          "STAGING_SPORTSDATAIO_IMPORT_STATE_INVALID",
          "The prior staging provider import result is unavailable."
        );
      }
      return Object.freeze({
        ...parseStoredResult(results[0].details_json),
        replayed: true,
      });
    }
    if (importInProgress) {
      fail(
        "STAGING_SPORTSDATAIO_IMPORT_IN_PROGRESS",
        "A staging provider import is already in progress."
      );
    }

    assertFixtureIdentity(database);
    maintenanceExclusionGuard.assertExclusion(
      MAINTENANCE_EXCLUSION
    );
    importInProgress = true;
    try {
      const authorizePersist = async () => {
        const refreshedAuthority =
          platformAuthorization.requireAdministrator(authenticated);
        assertAuthorityUnchanged(authority, refreshedAuthority);
        assertFixtureIdentity(database);
        maintenanceExclusionGuard.assertExclusion(
          MAINTENANCE_EXCLUSION
        );
        return refreshedAuthority;
      };
      const imported = await importService.importLastSeason({
        authorizePersist,
      });
      const refreshedAuthority = await authorizePersist();
      const result = normalizeImportResult(
        imported,
        safeTimestamp(clock.nowMs())
      );
      return persistSuccess.immediate({
        authority: refreshedAuthority,
        idempotencyKey: key,
        hash,
        reason: body.reason,
        result,
      });
    } catch (error) {
      if (!(error instanceof StagingMaintenanceExclusionError)) {
        recordFailure({
          actorUserId: authority.actorUserId,
          reason: body.reason,
          error,
        });
      }
      if (
        error instanceof StagingSportsDataIoImportError ||
        error instanceof StagingMaintenanceExclusionError ||
        error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED"
      ) {
        throw error;
      }
      fail(
        "STAGING_SPORTSDATAIO_IMPORT_FAILED",
        "The staging provider import failed safely.",
        error
      );
    } finally {
      importInProgress = false;
    }
  }

  return Object.freeze({ run });
}

module.exports = {
  CONFIRMATION,
  EVENT_TYPE,
  OPERATION,
  StagingSportsDataIoImportError,
  createStagingSportsDataIoImportService,
};
