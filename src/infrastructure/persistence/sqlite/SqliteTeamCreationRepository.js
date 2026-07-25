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
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
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

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("A safe UTC timestamp is required.");
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteTeamCreationRepository({ database } = {}) {
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

  let findLeagueContextStatement;
  let findTeamByNameStatement;
  let findIdempotencyByScopeStatement;
  let findIdempotencyByIdStatement;
  let completeIdempotencyStatement;
  try {
    findLeagueContextStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.status AS league_status,
        leagues.version AS league_version,
        league_settings.maximum_teams AS maximum_teams,
        COUNT(teams.id) AS current_team_count
      FROM leagues
      JOIN league_settings ON league_settings.league_id = leagues.id
      LEFT JOIN teams
        ON teams.league_id = leagues.id
       AND teams.status <> 'erased'
      WHERE leagues.id = @leagueId
      GROUP BY leagues.id, league_settings.league_id
    `);
    findTeamByNameStatement = database.prepare(`
      SELECT * FROM teams
      WHERE league_id = @leagueId
        AND name_normalized = @nameNormalized
      LIMIT 2
    `);
    findIdempotencyByScopeStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} ` +
        "FROM idempotency_requests " +
        "WHERE actor_user_id = @actorUserId " +
        "AND operation = @operation AND client_key = @clientKey " +
        "ORDER BY created_at_ms DESC, id DESC LIMIT 2"
    );
    findIdempotencyByIdStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} ` +
        "FROM idempotency_requests WHERE id = @id"
    );
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed', result_type = 'team',
        result_id = @teamId, completed_at_ms = @completedAtMs
      WHERE id = @id AND league_id = @leagueId AND status = 'started'
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTeamCreationRepository",
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
    findLeagueContext(leagueId) {
      try {
        return freezeRow(
          findLeagueContextStatement.get({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findTeamCreationLeagueContext",
          tableName: "leagues",
        });
      }
    },
    findTeamByNormalizedName({ leagueId, nameNormalized } = {}) {
      const canonicalName = boundedText(nameNormalized, 120);
      if (canonicalName !== canonicalName.toLowerCase()) {
        invalid("A normalized team name is required.");
      }
      return uniqueRow(
        findTeamByNameStatement,
        {
          leagueId: stableId(leagueId),
          nameNormalized: canonicalName,
        },
        {
          operation: "findTeamByNormalizedName",
          tableName: "teams",
          message: "A normalized team name is not unique within its league.",
        }
      );
    },
    insertSetupTeam(options) {
      exactObject(
        options,
        ["id", "leagueId", "name", "nameNormalized", "nowMs"],
        "An exact setup-team insert is required."
      );
      const nowMs = safeTimestamp(options.nowMs);
      const nameNormalized = boundedText(options.nameNormalized, 120);
      if (nameNormalized !== nameNormalized.toLowerCase()) {
        invalid("A normalized team name is required.");
      }
      return freezeRow(
        teams.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          name: boundedText(options.name, 120),
          name_normalized: nameNormalized,
          status: "setup",
          primary_colour: null,
          secondary_colour: null,
          logo_reference: null,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          version: 1,
        })
      );
    },
    appendCreationActivity(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "teamId",
          "actorUserId",
          "displaySummary",
          "metadataJson",
          "nowMs",
        ],
        "Exact team-creation activity is required."
      );
      const metadataJson = boundedText(options.metadataJson, 2048);
      let metadata;
      try {
        metadata = JSON.parse(metadataJson);
      } catch {
        invalid("Safe team-creation activity metadata is required.");
      }
      if (
        !isPlainObject(metadata) ||
        Object.keys(metadata).length !== 2 ||
        metadata.teamId !== options.teamId ||
        metadata.status !== "setup"
      ) {
        invalid("Safe team-creation activity metadata is required.");
      }
      return freezeRow(
        activity.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          season_id: null,
          event_type: "team_created",
          actor_user_id: stableId(options.actorUserId),
          actor_authority: "commissioner",
          team_id: stableId(options.teamId),
          player_id: null,
          related_type: "team",
          related_id: options.teamId,
          display_summary: boundedText(options.displaySummary, 256),
          reason: null,
          metadata_json: metadataJson,
          occurred_at_ms: safeTimestamp(options.nowMs),
        })
      );
    },
    findIdempotency(options) {
      exactObject(
        options,
        ["actorUserId", "operation", "clientKey"],
        "An exact team-creation idempotency lookup is required."
      );
      return uniqueRow(
        findIdempotencyByScopeStatement,
        {
          actorUserId: stableId(options.actorUserId),
          operation: boundedText(options.operation, 128),
          clientKey: boundedText(options.clientKey, 128),
        },
        {
          operation: "findTeamCreationIdempotency",
          tableName: "idempotency_requests",
          message: "Team-creation idempotency scope is not unique.",
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
        "An exact started team-creation idempotency record is required."
      );
      if (!DIGEST_PATTERN.test(options.requestHash || "")) {
        invalid("A canonical request digest is required.");
      }
      const createdAtMs = safeTimestamp(options.createdAtMs);
      const expiresAtMs = safeTimestamp(options.expiresAtMs);
      if (expiresAtMs <= createdAtMs) {
        invalid("Idempotency expiry must follow creation.");
      }
      return freezeRow(
        idempotency.insert({
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
        })
      );
    },
    completeIdempotency(options) {
      exactObject(
        options,
        ["id", "leagueId", "teamId", "completedAtMs"],
        "An exact team-creation idempotency completion is required."
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
            "The team-creation idempotency record cannot be completed."
          );
        }
        return freezeRow(
          findIdempotencyByIdStatement.get({ id: parameters.id })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeTeamCreationIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },
  });
}

module.exports = {
  IDEMPOTENCY_COLUMNS,
  createSqliteTeamCreationRepository,
};
