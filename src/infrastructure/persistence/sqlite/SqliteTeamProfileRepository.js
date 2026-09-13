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
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
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

function invalid(message) {
  throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, message);
}

function exactObject(value, keys, message) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    invalid(message);
  }
  return value;
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
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

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalid("A bounded positive integer is required.");
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("A safe UTC timestamp is required.");
  }
  return value;
}

function freezeRow(row) {
  if (!row) return null;
  return Object.freeze({
    ...row,
    ...(Buffer.isBuffer(row.content_bytes)
      ? { content_bytes: Buffer.from(row.content_bytes) }
      : {}),
  });
}

function createSqliteTeamProfileRepository({ database } = {}) {
  const teams = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("teams"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });
  const idempotency = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("idempotency_requests"),
  });

  let findTeamStatement;
  let findTeamByNameStatement;
  let findCurrentLogoStatement;
  let insertLogoStatement;
  let findLogoByIdStatement;
  let deleteLogoStatement;
  let findIdempotencyStatement;
  let findIdempotencyByIdStatement;
  let completeIdempotencyStatement;
  try {
    findTeamStatement = database.prepare(`
      SELECT * FROM teams
      WHERE league_id = @leagueId AND id = @teamId
        AND status <> 'erased'
      LIMIT 2
    `);
    findTeamByNameStatement = database.prepare(`
      SELECT * FROM teams
      WHERE league_id = @leagueId
        AND name_normalized = @nameNormalized
        AND id <> @teamId
        AND status <> 'erased'
      LIMIT 2
    `);
    findCurrentLogoStatement = database.prepare(`
      SELECT team_logo_objects.*
      FROM teams
      JOIN team_logo_objects
        ON team_logo_objects.league_id = teams.league_id
       AND team_logo_objects.team_id = teams.id
       AND team_logo_objects.id = teams.logo_reference
      WHERE teams.league_id = @leagueId
        AND teams.id = @teamId
        AND teams.status <> 'erased'
      LIMIT 2
    `);
    insertLogoStatement = database.prepare(`
      INSERT INTO team_logo_objects (
        id, league_id, team_id, media_type, byte_length,
        width, height, content_sha256, content_bytes, created_at_ms
      ) VALUES (
        @id, @leagueId, @teamId, @mediaType, @byteLength,
        @width, @height, @contentSha256, @contentBytes, @createdAtMs
      )
    `);
    findLogoByIdStatement = database.prepare(`
      SELECT * FROM team_logo_objects
      WHERE league_id = @leagueId AND team_id = @teamId AND id = @logoId
    `);
    deleteLogoStatement = database.prepare(`
      DELETE FROM team_logo_objects
      WHERE league_id = @leagueId AND team_id = @teamId AND id = @logoId
    `);
    findIdempotencyStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} FROM idempotency_requests ` +
        "WHERE league_id = @leagueId AND actor_user_id = @actorUserId " +
        "AND operation = @operation " +
        "AND client_key = @clientKey ORDER BY created_at_ms DESC, id DESC LIMIT 2"
    );
    findIdempotencyByIdStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} FROM idempotency_requests WHERE id = @id`
    );
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed', result_type = 'team',
        result_id = @teamId, completed_at_ms = @completedAtMs
      WHERE id = @id AND league_id = @leagueId AND status = 'started'
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTeamProfileRepository",
    });
  }

  function uniqueRow(statement, parameters, details) {
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
    findTeam(options) {
      exactObject(
        options,
        ["leagueId", "teamId"],
        "An exact team-profile lookup is required."
      );
      return uniqueRow(
        findTeamStatement,
        {
          leagueId: stableId(options.leagueId),
          teamId: stableId(options.teamId),
        },
        {
          operation: "findTeamProfile",
          tableName: "teams",
          message: "A team profile is ambiguous.",
        }
      );
    },
    findTeamByNormalizedName(options) {
      exactObject(
        options,
        ["leagueId", "teamId", "nameNormalized"],
        "An exact team-name lookup is required."
      );
      const nameNormalized = boundedText(options.nameNormalized, 120);
      if (nameNormalized !== nameNormalized.toLowerCase()) {
        invalid("A normalized team name is required.");
      }
      return uniqueRow(
        findTeamByNameStatement,
        {
          leagueId: stableId(options.leagueId),
          teamId: stableId(options.teamId),
          nameNormalized,
        },
        {
          operation: "findOtherTeamByNormalizedName",
          tableName: "teams",
          message: "A normalized team name is not unique within its league.",
        }
      );
    },
    findCurrentLogo(options) {
      exactObject(
        options,
        ["leagueId", "teamId"],
        "An exact current-logo lookup is required."
      );
      return uniqueRow(
        findCurrentLogoStatement,
        {
          leagueId: stableId(options.leagueId),
          teamId: stableId(options.teamId),
        },
        {
          operation: "findCurrentTeamLogo",
          tableName: "team_logo_objects",
          message: "A team has multiple current logo objects.",
        }
      );
    },
    insertLogo(options) {
      exactObject(
        options,
        [
          "id", "leagueId", "teamId", "mediaType", "byteLength",
          "width", "height", "contentSha256", "contentBytes", "createdAtMs",
        ],
        "An exact team-logo insert is required."
      );
      if (!MEDIA_TYPES.has(options.mediaType)) {
        invalid("A supported team-logo media type is required.");
      }
      if (
        !Buffer.isBuffer(options.contentBytes) ||
        options.contentBytes.length !== options.byteLength
      ) {
        invalid("Exact inspected team-logo bytes are required.");
      }
      if (!DIGEST_PATTERN.test(options.contentSha256 || "")) {
        invalid("A canonical team-logo digest is required.");
      }
      const parameters = {
        id: stableId(options.id),
        leagueId: stableId(options.leagueId),
        teamId: stableId(options.teamId),
        mediaType: options.mediaType,
        byteLength: positiveInteger(options.byteLength, 524288),
        width: positiveInteger(options.width, 2048),
        height: positiveInteger(options.height, 2048),
        contentSha256: options.contentSha256,
        contentBytes: Buffer.from(options.contentBytes),
        createdAtMs: safeTimestamp(options.createdAtMs),
      };
      try {
        insertLogoStatement.run(parameters);
        return freezeRow(findLogoByIdStatement.get({
          leagueId: parameters.leagueId,
          teamId: parameters.teamId,
          logoId: parameters.id,
        }));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "insertTeamLogo",
          tableName: "team_logo_objects",
        });
      }
    },
    updateTeam(options) {
      exactObject(
        options,
        ["leagueId", "teamId", "expectedVersion", "changes"],
        "An exact versioned team-profile update is required."
      );
      return freezeRow(teams.updateVersioned({
        key: stableId(options.teamId),
        leagueId: stableId(options.leagueId),
        expectedVersion: positiveInteger(options.expectedVersion),
        changes: options.changes,
      }));
    },
    deleteLogo(options) {
      exactObject(
        options,
        ["leagueId", "teamId", "logoId"],
        "An exact team-logo deletion is required."
      );
      const parameters = {
        leagueId: stableId(options.leagueId),
        teamId: stableId(options.teamId),
        logoId: stableId(options.logoId),
      };
      try {
        const result = deleteLogoStatement.run(parameters);
        if (result.changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.recordNotFound,
            "The team-logo object does not exist."
          );
        }
        return true;
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "deleteTeamLogo",
          tableName: "team_logo_objects",
        });
      }
    },
    appendRenameActivity(options) {
      exactObject(
        options,
        [
          "id", "leagueId", "teamId", "actorUserId", "actorAuthority",
          "displaySummary", "metadataJson", "nowMs",
        ],
        "Exact team-rename activity is required."
      );
      if (!["commissioner", "manager"].includes(options.actorAuthority)) {
        invalid("A team-profile activity authority is required.");
      }
      const metadataJson = boundedText(options.metadataJson, 2048);
      let metadata;
      try {
        metadata = JSON.parse(metadataJson);
      } catch {
        invalid("Safe team-rename activity metadata is required.");
      }
      if (
        !isPlainObject(metadata) ||
        Object.keys(metadata).length !== 3 ||
        metadata.teamId !== options.teamId ||
        typeof metadata.previousName !== "string" ||
        typeof metadata.name !== "string"
      ) {
        invalid("Safe team-rename activity metadata is required.");
      }
      return freezeRow(activity.insert({
        id: stableId(options.id),
        league_id: stableId(options.leagueId),
        season_id: null,
        event_type: "team_renamed",
        actor_user_id: stableId(options.actorUserId),
        actor_authority: options.actorAuthority,
        team_id: stableId(options.teamId),
        player_id: null,
        related_type: "team",
        related_id: options.teamId,
        display_summary: boundedText(options.displaySummary, 256),
        reason: null,
        metadata_json: metadataJson,
        occurred_at_ms: safeTimestamp(options.nowMs),
      }));
    },
    findIdempotency(options) {
      exactObject(
        options,
        ["leagueId", "actorUserId", "operation", "clientKey"],
        "An exact team-profile idempotency lookup is required."
      );
      return uniqueRow(
        findIdempotencyStatement,
        {
          leagueId: stableId(options.leagueId),
          actorUserId: stableId(options.actorUserId),
          operation: boundedText(options.operation, 128),
          clientKey: boundedText(options.clientKey, 128),
        },
        {
          operation: "findTeamProfileIdempotency",
          tableName: "idempotency_requests",
          message: "Team-profile idempotency scope is not unique.",
        }
      );
    },
    insertStartedIdempotency(options) {
      exactObject(
        options,
        [
          "id", "leagueId", "actorUserId", "operation", "clientKey",
          "requestHash", "createdAtMs", "expiresAtMs",
        ],
        "An exact started team-profile idempotency record is required."
      );
      if (!DIGEST_PATTERN.test(options.requestHash || "")) {
        invalid("A canonical request digest is required.");
      }
      const createdAtMs = safeTimestamp(options.createdAtMs);
      const expiresAtMs = safeTimestamp(options.expiresAtMs);
      if (expiresAtMs <= createdAtMs) {
        invalid("Idempotency expiry must follow creation.");
      }
      return freezeRow(idempotency.insert({
        id: stableId(options.id),
        league_id: stableId(options.leagueId),
        actor_user_id: stableId(options.actorUserId),
        operation: boundedText(options.operation, 128),
        client_key: boundedText(options.clientKey, 128),
        request_hash: options.requestHash,
        status: "started",
        result_type: null,
        result_id: null,
        created_at_ms: createdAtMs,
        completed_at_ms: null,
        expires_at_ms: expiresAtMs,
      }));
    },
    completeIdempotency(options) {
      exactObject(
        options,
        ["id", "leagueId", "teamId", "completedAtMs"],
        "An exact team-profile idempotency completion is required."
      );
      const parameters = {
        id: stableId(options.id),
        leagueId: stableId(options.leagueId),
        teamId: stableId(options.teamId),
        completedAtMs: safeTimestamp(options.completedAtMs),
      };
      try {
        const result = completeIdempotencyStatement.run(parameters);
        if (result.changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The team-profile idempotency record cannot be completed."
          );
        }
        return freezeRow(findIdempotencyByIdStatement.get({ id: parameters.id }));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeTeamProfileIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },
  });
}

module.exports = { createSqliteTeamProfileRepository };
