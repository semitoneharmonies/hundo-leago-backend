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
    /[\u0000-\u001f\u007f]/u.test(value)
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

function createSqliteLeagueCreationRepository({ database } = {}) {
  const leagues = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("leagues"),
  });
  const settings = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_settings"),
  });
  const seasons = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("seasons"),
  });
  const memberships = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_memberships"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });
  const idempotency = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("idempotency_requests"),
  });

  let findLeagueByName;
  let findCreationAggregateStatement;
  let findIdempotencyByScope;
  let findIdempotencyById;
  let completeIdempotencyStatement;
  let listActivePlatformAdministratorsStatement;
  try {
    findLeagueByName = database.prepare(
      "SELECT * FROM leagues WHERE name_normalized = @nameNormalized"
    );
    findCreationAggregateStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.current_season_id AS current_season_id,
        leagues.version AS league_version,
        seasons.label AS season_label,
        seasons.nhl_season_key AS nhl_season_key,
        seasons.status AS season_status,
        seasons.version AS season_version,
        league_settings.salary_cap_cents AS salary_cap_cents,
        league_settings.trade_deadline_at_ms AS trade_deadline_at_ms,
        league_settings.maximum_teams AS maximum_teams,
        league_settings.active_forward_slots AS active_forward_slots,
        league_settings.active_defence_slots AS active_defence_slots,
        league_settings.bench_slots AS bench_slots,
        league_settings.maximum_bench_aav_cents AS maximum_bench_aav_cents,
        league_settings.injured_reserve_slots AS injured_reserve_slots,
        league_settings.prospect_slots_unlimited AS prospect_slots_unlimited,
        league_settings.scoring_rule_version AS scoring_rule_version,
        league_settings.standings_rule_version AS standings_rule_version,
        league_settings.version AS settings_version
      FROM leagues
      JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = leagues.current_season_id
      JOIN league_settings
        ON league_settings.league_id = leagues.id
      WHERE leagues.id = @leagueId
    `);
    findIdempotencyByScope = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} ` +
        "FROM idempotency_requests " +
        "WHERE actor_user_id = @actorUserId " +
        "AND operation = @operation AND client_key = @clientKey " +
        "ORDER BY created_at_ms DESC, id DESC LIMIT 2"
    );
    findIdempotencyById = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} ` +
        "FROM idempotency_requests WHERE id = @id"
    );
    completeIdempotencyStatement = database.prepare(
      "UPDATE idempotency_requests SET " +
        "league_id = @leagueId, status = 'completed', " +
        "result_type = 'league', result_id = @leagueId, " +
        "completed_at_ms = @completedAtMs " +
        "WHERE id = @id AND league_id IS NULL AND status = 'started'"
    );
    listActivePlatformAdministratorsStatement = database.prepare(`
      SELECT users.id AS user_id
      FROM platform_roles
      JOIN users ON users.id = platform_roles.user_id
      WHERE platform_roles.role = 'platform_administrator'
        AND platform_roles.status = 'active'
        AND platform_roles.ended_at_ms IS NULL
        AND users.status = 'active'
      ORDER BY users.id
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeagueCreationRepository",
    });
  }

  function findIdempotency(options) {
    exactObject(
      options,
      ["actorUserId", "operation", "clientKey"],
      "An exact idempotency lookup is required."
    );
    const parameters = {
      actorUserId: stableId(options.actorUserId),
      operation: boundedText(options.operation, 128),
      clientKey: boundedText(options.clientKey, 128),
    };
    try {
      const rows = findIdempotencyByScope.all(parameters);
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "Idempotency scope is not unique."
        );
      }
      return freezeRow(rows[0]);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "findLeagueCreationIdempotency",
        tableName: "idempotency_requests",
      });
    }
  }

  return Object.freeze({
    findCreationAggregate(leagueId) {
      try {
        return freezeRow(
          findCreationAggregateStatement.get({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findLeagueCreationAggregate",
          tableName: "leagues",
        });
      }
    },
    findLeagueById(leagueId) {
      return freezeRow(
        leagues.findByKey({ key: stableId(leagueId) })
      );
    },
    findLeagueByNormalizedName(nameNormalized) {
      const value = boundedText(nameNormalized, 120);
      if (value !== value.toLowerCase()) {
        invalid("A normalized league name is required.");
      }
      try {
        return freezeRow(
          findLeagueByName.get({ nameNormalized: value })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findLeagueByNormalizedName",
          tableName: "leagues",
        });
      }
    },
    listActivePlatformAdministrators() {
      try {
        return Object.freeze(
          listActivePlatformAdministratorsStatement
            .all()
            .map((row) => Object.freeze({ ...row }))
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listLeagueCreationPlatformAdministrators",
          tableName: "platform_roles",
        });
      }
    },
    insertProtectedAdministratorMembership(options) {
      exactObject(
        options,
        ["id", "leagueId", "userId", "nowMs"],
        "An exact protected administrator membership is required."
      );
      const nowMs = safeTimestamp(options.nowMs);
      return freezeRow(
        memberships.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          user_id: stableId(options.userId),
          permission_category: "member",
          status: "active",
          joined_at_ms: nowMs,
          ended_at_ms: null,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          version: 1,
        })
      );
    },
    insertSetupLeague(options) {
      exactObject(
        options,
        ["id", "name", "nameNormalized", "nowMs"],
        "An exact setup-league insert is required."
      );
      const nameNormalized = boundedText(
        options.nameNormalized,
        120
      );
      if (nameNormalized !== nameNormalized.toLowerCase()) {
        invalid("A normalized league name is required.");
      }
      return freezeRow(
        leagues.insert({
          id: stableId(options.id),
          name: boundedText(options.name, 120),
          name_normalized: nameNormalized,
          status: "setup",
          timezone: "America/Vancouver",
          commissioner_membership_id: null,
          current_season_id: null,
          created_at_ms: safeTimestamp(options.nowMs),
          updated_at_ms: options.nowMs,
          version: 1,
        })
      );
    },
    insertInitialSettings(options) {
      exactObject(
        options,
        ["leagueId", "nowMs"],
        "Exact initial league settings are required."
      );
      return freezeRow(
        settings.insert({
          league_id: stableId(options.leagueId),
          salary_cap_cents: 10000,
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
          created_at_ms: safeTimestamp(options.nowMs),
          updated_at_ms: options.nowMs,
          version: 1,
        })
      );
    },
    insertPlannedSeason(options) {
      exactObject(
        options,
        ["id", "leagueId", "label", "nhlSeasonKey", "nowMs"],
        "An exact planned-season insert is required."
      );
      return freezeRow(
        seasons.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          label: boundedText(options.label, 32),
          nhl_season_key: boundedText(options.nhlSeasonKey, 32),
          status: "planned",
          regular_season_starts_at_ms: null,
          regular_season_ends_at_ms: null,
          fantasy_playoffs_start_at_ms: null,
          fantasy_playoffs_end_at_ms: null,
          created_at_ms: safeTimestamp(options.nowMs),
          updated_at_ms: options.nowMs,
          version: 1,
        })
      );
    },
    setCurrentSeason(options) {
      exactObject(
        options,
        ["leagueId", "seasonId", "expectedVersion", "nowMs"],
        "An exact current-season update is required."
      );
      return freezeRow(
        leagues.updateVersioned({
          key: stableId(options.leagueId),
          expectedVersion: positiveInteger(
            options.expectedVersion
          ),
          changes: {
            current_season_id: stableId(options.seasonId),
            updated_at_ms: safeTimestamp(options.nowMs),
          },
        })
      );
    },
    appendCreationActivity(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "seasonId",
          "actorUserId",
          "displaySummary",
          "metadataJson",
          "nowMs",
        ],
        "Exact league-creation activity is required."
      );
      const metadata = boundedText(options.metadataJson, 2048);
      try {
        const parsed = JSON.parse(metadata);
        if (
          !isPlainObject(parsed) ||
          Object.keys(parsed).length !== 2 ||
          parsed.leagueStatus !== "setup" ||
          parsed.seasonStatus !== "planned"
        ) {
          invalid("Safe activity metadata is required.");
        }
      } catch (error) {
        if (error?.code === REPOSITORY_ERROR_CODES.argumentInvalid) {
          throw error;
        }
        invalid("Safe activity metadata is required.");
      }
      return freezeRow(
        activity.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          season_id: stableId(options.seasonId),
          event_type: "league_created",
          actor_user_id: stableId(options.actorUserId),
          actor_authority: "platform_administrator",
          team_id: null,
          player_id: null,
          related_type: "league",
          related_id: options.leagueId,
          display_summary: boundedText(
            options.displaySummary,
            256
          ),
          reason: null,
          metadata_json: metadata,
          occurred_at_ms: safeTimestamp(options.nowMs),
        })
      );
    },
    findIdempotency,
    insertStartedIdempotency(options) {
      exactObject(
        options,
        [
          "id",
          "actorUserId",
          "operation",
          "clientKey",
          "requestHash",
          "createdAtMs",
          "expiresAtMs",
        ],
        "An exact started idempotency record is required."
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
          league_id: null,
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
        ["id", "leagueId", "completedAtMs"],
        "An exact idempotency completion is required."
      );
      const parameters = {
        id: stableId(options.id),
        leagueId: stableId(options.leagueId),
        completedAtMs: safeTimestamp(options.completedAtMs),
      };
      try {
        const result = completeIdempotencyStatement.run(parameters);
        if (result.changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The idempotency record cannot be completed."
          );
        }
        return freezeRow(findIdempotencyById.get({ id: parameters.id }));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeLeagueCreationIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },
  });
}

module.exports = {
  IDEMPOTENCY_COLUMNS,
  createSqliteLeagueCreationRepository,
};
