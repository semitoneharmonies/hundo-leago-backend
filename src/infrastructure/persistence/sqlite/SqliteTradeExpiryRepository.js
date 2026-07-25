const crypto = require("node:crypto");

const {
  TradeLifecyclePolicyError,
  assertTradeExpiryState,
  validateTradeExpiryCommand,
} = require("../../../domain/trades/tradeLifecyclePolicy");
const {
  createSocketInvalidation,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/;
const JOB_TYPE = "trades:expire:target";

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A trade-expiry object is required."
    );
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "The trade-expiry object shape is invalid."
    );
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A safe timestamp is required."
    );
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A positive version is required."
    );
  }
  return value;
}

function boundedText(value, maximum = 200) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A bounded text value is required."
    );
  }
  return value;
}

function unique(statement, parameters, message) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, message);
  }
  return rows[0] || null;
}

function freeze(value) {
  return value ? Object.freeze({ ...value }) : null;
}

function deterministicUuid(value) {
  const hex = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function createSqliteTradeExpiryRepository({ database } = {}) {
  let activityRepository;
  let outboxRepository;
  let listDueStatement;
  let findTradeStatement;
  let updateTradeStatement;
  let insertEventStatement;
  let findRunStatement;
  let insertRunStatement;
  let retryRunStatement;
  let succeedRunStatement;
  let failRunStatement;
  try {
    activityRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("league_activity"),
    });
    outboxRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("outbox_events"),
    });
    listDueStatement = database.prepare(`
      SELECT
        id AS trade_id,
        league_id,
        season_id,
        effective_deadline_at_ms,
        version
      FROM trades
      WHERE status = 'proposed'
        AND proposal_model_version = 2
        AND effective_deadline_at_ms IS NOT NULL
        AND effective_deadline_at_ms <= @nowMs
      ORDER BY effective_deadline_at_ms ASC, league_id ASC, id ASC
      LIMIT @limit
    `);
    findTradeStatement = database.prepare(`
      SELECT
        id AS trade_id,
        league_id,
        season_id,
        status AS trade_status,
        effective_deadline_at_ms,
        version AS trade_version
      FROM trades
      WHERE league_id = @leagueId
        AND id = @tradeId
      LIMIT 2
    `);
    updateTradeStatement = database.prepare(`
      UPDATE trades
      SET status = 'expired',
        responded_at_ms = @occurredAtMs,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @tradeId
        AND status = 'proposed'
        AND version = @expectedVersion
    `);
    insertEventStatement = database.prepare(`
      INSERT INTO trade_events (
        id, league_id, season_id, trade_id, actor_user_id,
        event_type, reason, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @tradeId, NULL,
        'proposal_expired', 'effective_deadline_elapsed',
        @metadataJson, @occurredAtMs
      )
    `);
    findRunStatement = database.prepare(`
      SELECT * FROM job_runs
      WHERE league_id = @leagueId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
      LIMIT 2
    `);
    insertRunStatement = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type, occurrence_key,
        scheduled_for_ms, status, attempt_count,
        lease_owner, lease_expires_at_ms,
        started_at_ms, completed_at_ms, result_json, last_error_code,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        @jobRunId, @leagueId, @seasonId, '${JOB_TYPE}', @occurrenceKey,
        @scheduledForMs, 'leased', 1,
        @leaseOwner, @leaseExpiresAtMs,
        @nowMs, NULL, NULL, NULL,
        @nowMs, @nowMs, 1
      )
    `);
    retryRunStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'leased',
        attempt_count = attempt_count + 1,
        lease_owner = @leaseOwner,
        lease_expires_at_ms = @leaseExpiresAtMs,
        started_at_ms = @nowMs,
        completed_at_ms = NULL,
        result_json = NULL,
        last_error_code = NULL,
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND version = @expectedVersion
    `);
    succeedRunStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
        lease_owner = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @completedAtMs,
        result_json = @resultJson,
        last_error_code = NULL,
        updated_at_ms = @completedAtMs,
        version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND status = 'leased'
        AND lease_owner = @leaseOwner
        AND version = @expectedVersion
    `);
    failRunStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
        lease_owner = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @completedAtMs,
        result_json = NULL,
        last_error_code = @errorCode,
        updated_at_ms = @completedAtMs,
        version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND status = 'leased'
        AND lease_owner = @leaseOwner
        AND version = @expectedVersion
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTradeExpiryRepository",
    });
  }

  const claimTransaction = database.transaction((command) => {
    const existing = unique(
      findRunStatement,
      command,
      "A trade-expiry occurrence is not unique."
    );
    if (!existing) {
      insertRunStatement.run(command);
      return freeze({
        acquired: true,
        runId: command.jobRunId,
        version: 1,
        attemptCount: 1,
      });
    }
    if (existing.status === "succeeded") {
      return freeze({
        acquired: false,
        reason: "succeeded",
        runId: existing.id,
        version: existing.version,
        attemptCount: existing.attempt_count,
      });
    }
    if (
      ["leased", "running"].includes(existing.status) &&
      existing.lease_expires_at_ms !== null &&
      existing.lease_expires_at_ms > command.nowMs
    ) {
      return freeze({
        acquired: false,
        reason: "leased",
        runId: existing.id,
        version: existing.version,
        attemptCount: existing.attempt_count,
      });
    }
    if (
      retryRunStatement.run({
        ...command,
        runId: existing.id,
        expectedVersion: existing.version,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The trade-expiry lease changed concurrently."
      );
    }
    return freeze({
      acquired: true,
      runId: existing.id,
      version: existing.version + 1,
      attemptCount: existing.attempt_count + 1,
    });
  });

  const expireTransaction = database.transaction((rawCommand) => {
    const command = validateTradeExpiryCommand(rawCommand);
    const context = unique(
      findTradeStatement,
      command,
      "A due trade proposal was not unique."
    );
    if (!context) {
      throw new TradeLifecyclePolicyError("TRADE_LIFECYCLE_NOT_FOUND");
    }
    if (context.trade_status !== "proposed") {
      return freeze({
        completed: false,
        reason: "terminal",
        tradeId: context.trade_id,
        status: context.trade_status,
        version: context.trade_version,
      });
    }
    assertTradeExpiryState({ command, context });
    if (
      context.trade_version !== command.expectedVersion ||
      updateTradeStatement.run(command).changes !== 1
    ) {
      throw new TradeLifecyclePolicyError("TRADE_LIFECYCLE_VERSION_CONFLICT");
    }
    const metadataJson = JSON.stringify({
      schemaVersion: 1,
      occurrenceKey: command.occurrenceKey,
      effectiveDeadlineAtMs: command.effectiveDeadlineAtMs,
      fromStatus: "proposed",
      toStatus: "expired",
    });
    insertEventStatement.run({ ...command, metadataJson });
    activityRepository.insert({
      id: deterministicUuid(`activity:${command.eventId}`),
      league_id: command.leagueId,
      season_id: command.seasonId,
      event_type: "trade_proposal_expired",
      actor_user_id: null,
      actor_authority: "system",
      team_id: null,
      player_id: null,
      related_type: "trade",
      related_id: command.tradeId,
      display_summary: "Trade proposal expired.",
      reason: "effective_deadline_elapsed",
      metadata_json: JSON.stringify({
        schemaVersion: 1,
        proposalId: command.tradeId,
        occurrenceKey: command.occurrenceKey,
        effectiveDeadlineAtMs: command.effectiveDeadlineAtMs,
        fromStatus: "Pending",
        toStatus: "Expired",
      }),
      occurred_at_ms: command.occurredAtMs,
    });
    const payload = createSocketInvalidation({
      eventType: "trade.changed",
      scope: "league",
      scopeId: command.leagueId,
      version: command.expectedVersion + 1,
      changedAtMs: command.occurredAtMs,
    });
    outboxRepository.insert({
      id: deterministicUuid(`outbox:${command.eventId}:trade.changed`),
      league_id: command.leagueId,
      event_type: "trade.changed",
      aggregate_type: "trade",
      aggregate_id: command.tradeId,
      payload_json: JSON.stringify(payload),
      status: "pending",
      attempt_count: 0,
      available_at_ms: command.occurredAtMs,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: command.occurredAtMs,
      updated_at_ms: command.occurredAtMs,
      version: 1,
    });
    return freeze({
      completed: true,
      tradeId: command.tradeId,
      status: "expired",
      version: command.expectedVersion + 1,
      eventId: command.eventId,
    });
  });

  return Object.freeze({
    claimRun(input) {
      exactObject(input, [
        "jobRunId",
        "leagueId",
        "seasonId",
        "occurrenceKey",
        "scheduledForMs",
        "leaseOwner",
        "nowMs",
        "leaseExpiresAtMs",
      ]);
      const command = {
        jobRunId: stableId(input.jobRunId),
        leagueId: stableId(input.leagueId),
        seasonId: stableId(input.seasonId),
        occurrenceKey: boundedText(input.occurrenceKey),
        scheduledForMs: safeTimestamp(input.scheduledForMs),
        leaseOwner: boundedText(input.leaseOwner, 128),
        nowMs: safeTimestamp(input.nowMs),
        leaseExpiresAtMs: safeTimestamp(input.leaseExpiresAtMs),
      };
      if (command.leaseExpiresAtMs <= command.nowMs) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A trade-expiry lease must end after it begins."
        );
      }
      try {
        return claimTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "claimTradeExpiryRun",
          tableName: "job_runs",
        });
      }
    },

    expireProposal(input) {
      try {
        return expireTransaction.immediate(input);
      } catch (error) {
        if (error instanceof TradeLifecyclePolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "expireTradeProposal",
          tableName: "trades",
        });
      }
    },

    failRun(input) {
      exactObject(input, [
        "leagueId",
        "runId",
        "leaseOwner",
        "expectedVersion",
        "completedAtMs",
        "errorCode",
      ]);
      const command = {
        leagueId: stableId(input.leagueId),
        runId: stableId(input.runId),
        leaseOwner: boundedText(input.leaseOwner, 128),
        expectedVersion: positiveVersion(input.expectedVersion),
        completedAtMs: safeTimestamp(input.completedAtMs),
        errorCode: boundedText(input.errorCode, 100),
      };
      if (!SAFE_CODE_PATTERN.test(command.errorCode)) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A safe trade-expiry error code is required."
        );
      }
      try {
        if (failRunStatement.run(command).changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The trade-expiry failure lease is stale."
          );
        }
        return freeze({
          runId: command.runId,
          status: "failed",
          version: command.expectedVersion + 1,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "failTradeExpiryRun",
          tableName: "job_runs",
        });
      }
    },

    listDue({ nowMs, limit } = {}) {
      const query = {
        nowMs: safeTimestamp(nowMs),
        limit:
          Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
            ? limit
            : null,
      };
      if (query.limit === null) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A trade-expiry batch limit from 1 through 100 is required."
        );
      }
      try {
        return Object.freeze(
          listDueStatement.all(query).map((row) =>
            Object.freeze({
              tradeId: row.trade_id,
              leagueId: row.league_id,
              seasonId: row.season_id,
              effectiveDeadlineAtMs: row.effective_deadline_at_ms,
              tradeVersion: row.version,
            })
          )
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listDueTradeExpiries",
          tableName: "trades",
        });
      }
    },

    succeedRun(input) {
      exactObject(input, [
        "leagueId",
        "runId",
        "leaseOwner",
        "expectedVersion",
        "completedAtMs",
        "tradeId",
        "outcome",
      ]);
      if (!["expired", "terminal"].includes(input.outcome)) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A completed trade-expiry outcome is required."
        );
      }
      const command = {
        leagueId: stableId(input.leagueId),
        runId: stableId(input.runId),
        leaseOwner: boundedText(input.leaseOwner, 128),
        expectedVersion: positiveVersion(input.expectedVersion),
        completedAtMs: safeTimestamp(input.completedAtMs),
        resultJson: JSON.stringify({
          tradeId: stableId(input.tradeId),
          outcome: input.outcome,
        }),
      };
      try {
        if (succeedRunStatement.run(command).changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The trade-expiry success lease is stale."
          );
        }
        return freeze({
          runId: command.runId,
          status: "succeeded",
          version: command.expectedVersion + 1,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "succeedTradeExpiryRun",
          tableName: "job_runs",
        });
      }
    },
  });
}

module.exports = {
  JOB_TYPE,
  createSqliteTradeExpiryRepository,
};
