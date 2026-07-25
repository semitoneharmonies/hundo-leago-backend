const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SELECT_COLUMNS = `
  id, league_id, event_type, aggregate_type, aggregate_id, payload_json,
  status, attempt_count, available_at_ms, published_at_ms,
  last_error_code, created_at_ms, updated_at_ms, version
`;

function invalid(message) {
  throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, message);
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid("A canonical league-outbox identifier is required.");
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("A safe league-outbox timestamp is required.");
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid("A positive league-outbox version is required.");
  }
  return value;
}

function safeLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    invalid("A league-outbox batch size from one through 100 is required.");
  }
  return value;
}

function safeErrorCode(value) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value)) {
    invalid("A safe league-outbox error code is required.");
  }
  return value;
}

function freeze(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteLeagueOutboxRepository({ database } = {}) {
  let findByIdStatement;
  let listDueStatement;
  let listInterruptedStatement;
  let claimStatement;
  let publishStatement;
  let failStatement;
  let recoverStatement;
  try {
    findByIdStatement = database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM outbox_events
      WHERE id = @eventId AND league_id = @leagueId
      LIMIT 2
    `);
    listDueStatement = database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM outbox_events
      WHERE league_id IS NOT NULL
        AND status IN ('pending', 'failed')
        AND available_at_ms <= @nowMs
      ORDER BY available_at_ms ASC, created_at_ms ASC, id ASC
      LIMIT @limit
    `);
    listInterruptedStatement = database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM outbox_events
      WHERE league_id IS NOT NULL
        AND status = 'publishing'
        AND updated_at_ms <= @staleBeforeMs
      ORDER BY updated_at_ms ASC, id ASC
      LIMIT @limit
    `);
    claimStatement = database.prepare(`
      UPDATE outbox_events
      SET status = 'publishing', attempt_count = attempt_count + 1,
        last_error_code = NULL, updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @eventId
        AND league_id = @leagueId
        AND status IN ('pending', 'failed')
        AND available_at_ms <= @nowMs
        AND version = @expectedVersion
    `);
    publishStatement = database.prepare(`
      UPDATE outbox_events
      SET status = 'published', published_at_ms = @publishedAtMs,
        last_error_code = NULL, updated_at_ms = @publishedAtMs,
        version = version + 1
      WHERE id = @eventId
        AND league_id = @leagueId
        AND status = 'publishing'
        AND version = @expectedVersion
    `);
    failStatement = database.prepare(`
      UPDATE outbox_events
      SET status = 'failed', available_at_ms = @availableAtMs,
        last_error_code = @errorCode, updated_at_ms = @failedAtMs,
        version = version + 1
      WHERE id = @eventId
        AND league_id = @leagueId
        AND status = 'publishing'
        AND version = @expectedVersion
    `);
    recoverStatement = database.prepare(`
      UPDATE outbox_events
      SET status = 'failed', available_at_ms = @nowMs,
        last_error_code = 'PUBLICATION_INTERRUPTED', updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @eventId
        AND league_id = @leagueId
        AND status = 'publishing'
        AND version = @expectedVersion
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeagueOutboxRepository",
      tableName: "outbox_events",
    });
  }

  function find(parameters) {
    const rows = findByIdStatement.all(parameters);
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "A league-outbox event lookup was not unique."
      );
    }
    return freeze(rows[0]);
  }

  function requireChange(result, message) {
    if (result.changes !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, message);
    }
  }

  const claimTransaction = database.transaction((command) => {
    const before = find(command);
    if (
      !before ||
      !["pending", "failed"].includes(before.status) ||
      before.available_at_ms > command.nowMs ||
      before.version !== command.expectedVersion
    ) {
      return null;
    }
    requireChange(
      claimStatement.run(command),
      "The league-outbox claim changed concurrently."
    );
    return find(command);
  });

  return Object.freeze({
    claim({ eventId, leagueId, expectedVersion, nowMs } = {}) {
      const command = {
        eventId: stableId(eventId),
        leagueId: stableId(leagueId),
        expectedVersion: positiveVersion(expectedVersion),
        nowMs: safeTimestamp(nowMs),
      };
      try {
        return claimTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "claimLeagueOutboxEvent",
          tableName: "outbox_events",
        });
      }
    },
    listDue({ nowMs, limit } = {}) {
      try {
        return Object.freeze(
          listDueStatement
            .all({ nowMs: safeTimestamp(nowMs), limit: safeLimit(limit) })
            .map(freeze)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listDueLeagueOutboxEvents",
          tableName: "outbox_events",
        });
      }
    },
    markFailed({
      eventId,
      leagueId,
      expectedVersion,
      failedAtMs,
      availableAtMs,
      errorCode,
    } = {}) {
      const command = {
        eventId: stableId(eventId),
        leagueId: stableId(leagueId),
        expectedVersion: positiveVersion(expectedVersion),
        failedAtMs: safeTimestamp(failedAtMs),
        availableAtMs: safeTimestamp(availableAtMs),
        errorCode: safeErrorCode(errorCode),
      };
      if (command.availableAtMs < command.failedAtMs) {
        invalid("A league-outbox retry cannot precede its failure.");
      }
      try {
        requireChange(
          failStatement.run(command),
          "The league-outbox failure claim is stale."
        );
        return find(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "failLeagueOutboxEvent",
          tableName: "outbox_events",
        });
      }
    },
    markPublished({
      eventId,
      leagueId,
      expectedVersion,
      publishedAtMs,
    } = {}) {
      const command = {
        eventId: stableId(eventId),
        leagueId: stableId(leagueId),
        expectedVersion: positiveVersion(expectedVersion),
        publishedAtMs: safeTimestamp(publishedAtMs),
      };
      try {
        requireChange(
          publishStatement.run(command),
          "The league-outbox publication claim is stale."
        );
        return find(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "publishLeagueOutboxEvent",
          tableName: "outbox_events",
        });
      }
    },
    recoverInterrupted({ nowMs, staleBeforeMs, limit } = {}) {
      const command = {
        nowMs: safeTimestamp(nowMs),
        staleBeforeMs: safeTimestamp(staleBeforeMs),
        limit: safeLimit(limit),
      };
      if (command.staleBeforeMs > command.nowMs) {
        invalid("The league-outbox recovery cutoff is invalid.");
      }
      try {
        const recovered = [];
        for (const row of listInterruptedStatement.all(command)) {
          const parameters = {
            ...command,
            eventId: row.id,
            leagueId: row.league_id,
            expectedVersion: row.version,
          };
          if (recoverStatement.run(parameters).changes === 1) {
            recovered.push(find(parameters));
          }
        }
        return Object.freeze(recovered);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "recoverInterruptedLeagueOutboxEvents",
          tableName: "outbox_events",
        });
      }
    },
  });
}

module.exports = { createSqliteLeagueOutboxRepository };
