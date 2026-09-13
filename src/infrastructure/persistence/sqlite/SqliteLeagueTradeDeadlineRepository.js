const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteRecordRepository,
  isPlainObject,
} = require("./createSqliteRecordRepository");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_COLUMNS = Object.freeze([
  "id",
  "league_id",
  "actor_user_id",
  "operation",
  "client_key",
  "request_hash",
  "status",
  "result_type",
  "result_id",
  "created_at_ms",
  "completed_at_ms",
  "expires_at_ms",
]);
const TRADE_DEADLINE_ACTIVITY_METADATA_KEYS =
  Object.freeze([
    "leagueId",
    "leagueStatus",
    "leagueTimezone",
    "leagueVersion",
    "recordedAtMs",
    "settingsVersion",
    "tradeDeadlineAtMs",
  ]);

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function exactObject(value, keys, message) {
  if (!isPlainObject(value)) {
    invalid(message);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(message);
  }
  return value;
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid("A canonical stable identifier is required.");
  }
  return value;
}

function boundedText(value, maximum) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    invalid("Bounded canonical text is required.");
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("A safe UTC timestamp is required.");
  }
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid("A positive safe integer is required.");
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function projectRecordedMetadata(
  metadataJson,
  { leagueId, occurredAtMs }
) {
  let metadata;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    invalid(
      "Safe league trade-deadline activity metadata is required."
    );
  }

  const actualKeys = isPlainObject(metadata)
    ? Object.keys(metadata).sort()
    : [];
  const expectedKeys =
    [...TRADE_DEADLINE_ACTIVITY_METADATA_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some(
      (key, index) => key !== expectedKeys[index]
    ) ||
    metadata.leagueId !== leagueId ||
    metadata.leagueStatus !== "setup" ||
    metadata.recordedAtMs !== occurredAtMs ||
    !Number.isSafeInteger(metadata.tradeDeadlineAtMs) ||
    metadata.tradeDeadlineAtMs <= metadata.recordedAtMs ||
    !Number.isSafeInteger(metadata.leagueVersion) ||
    metadata.leagueVersion < 1 ||
    !Number.isSafeInteger(metadata.settingsVersion) ||
    metadata.settingsVersion < 1
  ) {
    invalid(
      "Safe league trade-deadline activity metadata is required."
    );
  }

  return Object.freeze({
    league_id: stableId(metadata.leagueId),
    league_status: metadata.leagueStatus,
    league_timezone: boundedText(
      metadata.leagueTimezone,
      120
    ),
    league_version: positiveInteger(
      metadata.leagueVersion
    ),
    trade_deadline_at_ms: safeTimestamp(
      metadata.tradeDeadlineAtMs
    ),
    settings_version: positiveInteger(
      metadata.settingsVersion
    ),
    recorded_at_ms: safeTimestamp(
      metadata.recordedAtMs
    ),
  });
}

function createSqliteLeagueTradeDeadlineRepository({
  database,
  leagueOutboxWriter,
} = {}) {
  let activity;
  let idempotency;
  let outboxWriter;
  let findContextStatement;
  let findCurrentAggregateStatement;
  let findRecordedResultStatement;
  let findIdempotencyByScopeStatement;
  let findIdempotencyByIdStatement;
  let updateSettingsDeadlineStatement;
  let findSettingsStatement;
  let updateSetupLeagueVersionStatement;
  let findLeagueStatement;
  let completeIdempotencyStatement;

  try {
    activity = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition(
        "league_activity"
      ),
    });
    idempotency = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition(
        "idempotency_requests"
      ),
    });
    outboxWriter = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    findContextStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.version AS league_version,
        league_settings.league_id AS settings_league_id,
        league_settings.trade_deadline_at_ms
          AS trade_deadline_at_ms,
        league_settings.version AS settings_version
      FROM leagues
      LEFT JOIN league_settings
        ON league_settings.league_id = leagues.id
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    findCurrentAggregateStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.version AS league_version,
        league_settings.trade_deadline_at_ms
          AS trade_deadline_at_ms,
        league_settings.version AS settings_version
      FROM leagues
      JOIN league_settings
        ON league_settings.league_id = leagues.id
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    findRecordedResultStatement = database.prepare(`
      SELECT
        id AS activity_id,
        league_id,
        metadata_json,
        occurred_at_ms
      FROM league_activity
      WHERE id = @activityId
        AND league_id = @leagueId
        AND season_id IS NULL
        AND event_type =
          'league_trade_deadline_recorded'
        AND related_type = 'league'
        AND related_id = @leagueId
      LIMIT 2
    `);
    findIdempotencyByScopeStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} ` +
        "FROM idempotency_requests " +
        "WHERE league_id = @leagueId " +
        "AND actor_user_id = @actorUserId " +
        "AND operation = @operation " +
        "AND client_key = @clientKey " +
        "ORDER BY created_at_ms DESC, id DESC LIMIT 2"
    );
    findIdempotencyByIdStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} ` +
        "FROM idempotency_requests " +
        "WHERE league_id = @leagueId " +
        "AND id = @id LIMIT 2"
    );
    updateSettingsDeadlineStatement = database.prepare(`
      UPDATE league_settings
      SET trade_deadline_at_ms = @tradeDeadlineAtMs,
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND version = @expectedVersion
    `);
    findSettingsStatement = database.prepare(`
      SELECT *
      FROM league_settings
      WHERE league_id = @leagueId
      LIMIT 2
    `);
    updateSetupLeagueVersionStatement = database.prepare(`
      UPDATE leagues
      SET updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @leagueId
        AND status = 'setup'
        AND version = @expectedVersion
    `);
    findLeagueStatement = database.prepare(`
      SELECT *
      FROM leagues
      WHERE id = @leagueId
      LIMIT 2
    `);
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
        result_type = 'league_trade_deadline',
        result_id = @activityId,
        completed_at_ms = @completedAtMs
      WHERE id = @id
        AND league_id = @leagueId
        AND status = 'started'
        AND result_type IS NULL
        AND result_id IS NULL
        AND completed_at_ms IS NULL
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareLeagueTradeDeadlineRepository",
    });
  }

  function uniqueRow(
    statement,
    parameters,
    details
  ) {
    try {
      const rows = statement.all(parameters);
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          details.message
        );
      }
      return freezeRow(rows[0]);
    } catch (error) {
      throw mapRepositoryError(error, details);
    }
  }

  return Object.freeze({
    findContext(options) {
      exactObject(
        options,
        ["leagueId"],
        "An exact league trade-deadline context lookup is required."
      );
      return uniqueRow(
        findContextStatement,
        {
          leagueId: stableId(options.leagueId),
        },
        {
          operation: "findLeagueTradeDeadlineContext",
          tableName: "leagues",
          message:
            "The league trade-deadline context is not unique.",
        }
      );
    },
    findIdempotency(options) {
      exactObject(
        options,
        [
          "leagueId",
          "actorUserId",
          "operation",
          "clientKey",
        ],
        "An exact league trade-deadline idempotency lookup is required."
      );
      return uniqueRow(
        findIdempotencyByScopeStatement,
        {
          leagueId: stableId(options.leagueId),
          actorUserId: stableId(
            options.actorUserId
          ),
          operation: boundedText(
            options.operation,
            128
          ),
          clientKey: boundedText(
            options.clientKey,
            128
          ),
        },
        {
          operation:
            "findLeagueTradeDeadlineIdempotency",
          tableName: "idempotency_requests",
          message:
            "League trade-deadline idempotency scope is not unique.",
        }
      );
    },
    findRecordedResult(options) {
      exactObject(
        options,
        ["leagueId", "activityId"],
        "An exact durable league trade-deadline result lookup is required."
      );
      const parameters = {
        leagueId: stableId(options.leagueId),
        activityId: stableId(options.activityId),
      };
      const row = uniqueRow(
        findRecordedResultStatement,
        parameters,
        {
          operation:
            "findDurableLeagueTradeDeadlineResult",
          tableName: "league_activity",
          message:
            "The durable league trade-deadline result is not unique.",
        }
      );
      if (!row) {
        return null;
      }
      return projectRecordedMetadata(
        row.metadata_json,
        {
          leagueId: parameters.leagueId,
          occurredAtMs: safeTimestamp(
            row.occurred_at_ms
          ),
        }
      );
    },
    insertStartedIdempotency(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "actorUserId",
          "operation",
          "clientKey",
          "requestHash",
          "createdAtMs",
          "expiresAtMs",
        ],
        "An exact started league trade-deadline idempotency record is required."
      );
      if (
        !DIGEST_PATTERN.test(
          options.requestHash || ""
        )
      ) {
        invalid(
          "A canonical request digest is required."
        );
      }
      const createdAtMs = safeTimestamp(
        options.createdAtMs
      );
      const expiresAtMs = safeTimestamp(
        options.expiresAtMs
      );
      if (expiresAtMs <= createdAtMs) {
        invalid(
          "Idempotency expiry must follow creation."
        );
      }
      return freezeRow(
        idempotency.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          actor_user_id: stableId(
            options.actorUserId
          ),
          operation: boundedText(
            options.operation,
            128
          ),
          client_key: boundedText(
            options.clientKey,
            128
          ),
          request_hash: options.requestHash,
          status: "started",
          result_type: null,
          result_id: null,
          created_at_ms: createdAtMs,
          completed_at_ms: null,
          expires_at_ms: expiresAtMs,
        })
      );
    },
    updateSettingsDeadline(options) {
      exactObject(
        options,
        [
          "leagueId",
          "tradeDeadlineAtMs",
          "expectedVersion",
          "nowMs",
        ],
        "An exact league trade-deadline settings update is required."
      );
      const parameters = {
        leagueId: stableId(options.leagueId),
        tradeDeadlineAtMs: safeTimestamp(
          options.tradeDeadlineAtMs
        ),
        expectedVersion: positiveInteger(
          options.expectedVersion
        ),
        nowMs: safeTimestamp(options.nowMs),
      };
      try {
        if (
          updateSettingsDeadlineStatement.run(
            parameters
          ).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The league settings could not record the trade deadline."
          );
        }
        return uniqueRow(
          findSettingsStatement,
          {
            leagueId: parameters.leagueId,
          },
          {
            operation:
              "readUpdatedLeagueTradeDeadlineSettings",
            tableName: "league_settings",
            message:
              "The updated league settings are not unique.",
          }
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "updateLeagueTradeDeadlineSettings",
          tableName: "league_settings",
        });
      }
    },
    updateSetupLeagueVersion(options) {
      exactObject(
        options,
        [
          "leagueId",
          "expectedVersion",
          "nowMs",
        ],
        "An exact setup-league version update is required."
      );
      const parameters = {
        leagueId: stableId(options.leagueId),
        expectedVersion: positiveInteger(
          options.expectedVersion
        ),
        nowMs: safeTimestamp(options.nowMs),
      };
      try {
        if (
          updateSetupLeagueVersionStatement.run(
            parameters
          ).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The setup league version could not be advanced."
          );
        }
        return uniqueRow(
          findLeagueStatement,
          {
            leagueId: parameters.leagueId,
          },
          {
            operation:
              "readUpdatedTradeDeadlineLeague",
            tableName: "leagues",
            message:
              "The updated setup league is not unique.",
          }
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "updateTradeDeadlineSetupLeagueVersion",
          tableName: "leagues",
        });
      }
    },
    appendRecordedActivity(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "actorUserId",
          "actorAuthority",
          "displaySummary",
          "metadataJson",
          "nowMs",
        ],
        "Exact league trade-deadline activity is required."
      );
      const leagueId = stableId(options.leagueId);
      const nowMs = safeTimestamp(options.nowMs);
      const metadataJson = boundedText(
        options.metadataJson,
        2048
      );
      projectRecordedMetadata(metadataJson, {
        leagueId,
        occurredAtMs: nowMs,
      });
      if (
        ![
          "commissioner",
          "platform_administrator",
        ].includes(options.actorAuthority)
      ) {
        invalid(
          "Safe league trade-deadline activity authority is required."
        );
      }
      return freezeRow(
        activity.insert({
          id: stableId(options.id),
          league_id: leagueId,
          season_id: null,
          event_type:
            "league_trade_deadline_recorded",
          actor_user_id: stableId(
            options.actorUserId
          ),
          actor_authority:
            options.actorAuthority,
          team_id: null,
          player_id: null,
          related_type: "league",
          related_id: leagueId,
          display_summary: boundedText(
            options.displaySummary,
            256
          ),
          reason: null,
          metadata_json: metadataJson,
          occurred_at_ms: nowMs,
        })
      );
    },
    writeRecordedOutbox(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "leagueVersion",
          "nowMs",
        ],
        "An exact league trade-deadline outbox event is required."
      );
      const leagueId = stableId(options.leagueId);
      const nowMs = safeTimestamp(options.nowMs);
      const leagueVersion = positiveInteger(
        options.leagueVersion
      );
      try {
        return outboxWriter.write({
          id: stableId(options.id),
          leagueId,
          eventType: "league.changed",
          aggregateType: "league",
          aggregateId: leagueId,
          payload: createSocketEventMetadata({
            eventType: "league.changed",
            version: leagueVersion,
            reasonCode: "league_changed",
            occurredAtMs: nowMs,
            related: createEmptySocketRelated(),
          }),
          occurredAtMs: nowMs,
          audiences: [{ kind: "league" }],
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "writeLeagueTradeDeadlineOutbox",
          tableName: "outbox_events",
        });
      }
    },
    completeIdempotency(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "activityId",
          "completedAtMs",
        ],
        "An exact league trade-deadline idempotency completion is required."
      );
      const parameters = {
        id: stableId(options.id),
        leagueId: stableId(options.leagueId),
        activityId: stableId(options.activityId),
        completedAtMs: safeTimestamp(
          options.completedAtMs
        ),
      };
      try {
        if (
          completeIdempotencyStatement.run(
            parameters
          ).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The league trade-deadline idempotency record cannot be completed."
          );
        }
        return uniqueRow(
          findIdempotencyByIdStatement,
          {
            id: parameters.id,
            leagueId: parameters.leagueId,
          },
          {
            operation:
              "readCompletedLeagueTradeDeadlineIdempotency",
            tableName: "idempotency_requests",
            message:
              "The completed league trade-deadline idempotency record is not unique.",
          }
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "completeLeagueTradeDeadlineIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },
    findCurrentAggregate(options) {
      exactObject(
        options,
        ["leagueId"],
        "An exact current league trade-deadline aggregate lookup is required."
      );
      return uniqueRow(
        findCurrentAggregateStatement,
        {
          leagueId: stableId(options.leagueId),
        },
        {
          operation:
            "findCurrentLeagueTradeDeadlineAggregate",
          tableName: "leagues",
          message:
            "The current league trade-deadline aggregate is not unique.",
        }
      );
    },
  });
}

module.exports = {
  IDEMPOTENCY_COLUMNS,
  TRADE_DEADLINE_ACTIVITY_METADATA_KEYS,
  createSqliteLeagueTradeDeadlineRepository,
};
