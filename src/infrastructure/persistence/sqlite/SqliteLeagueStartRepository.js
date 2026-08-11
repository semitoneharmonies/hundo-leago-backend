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
const START_ACTIVITY_METADATA_KEYS = Object.freeze([
  "activatedTeamCount",
  "leagueId",
  "leagueName",
  "leagueStatus",
  "leagueTimezone",
  "leagueVersion",
  "seasonId",
  "seasonLabel",
  "nhlSeasonKey",
  "seasonStatus",
  "seasonVersion",
  "startedAtMs",
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

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid("A positive safe integer is required.");
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function projectStartedMetadata(
  metadataJson,
  { leagueId, seasonId }
) {
  let metadata;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    invalid("Safe league-start activity metadata is required.");
  }
  const metadataKeys = isPlainObject(metadata)
    ? Object.keys(metadata).sort()
    : [];
  const expectedKeys =
    [...START_ACTIVITY_METADATA_KEYS].sort();
  if (
    metadataKeys.length !== expectedKeys.length ||
    metadataKeys.some(
      (key, index) => key !== expectedKeys[index]
    ) ||
    metadata.leagueId !== leagueId ||
    metadata.seasonId !== seasonId ||
    metadata.leagueStatus !== "active" ||
    metadata.seasonStatus !== "active" ||
    !Number.isSafeInteger(
      metadata.activatedTeamCount
    ) ||
    metadata.activatedTeamCount < 4 ||
    !Number.isSafeInteger(metadata.leagueVersion) ||
    metadata.leagueVersion < 1 ||
    !Number.isSafeInteger(metadata.seasonVersion) ||
    metadata.seasonVersion < 1
  ) {
    invalid("Safe league-start activity metadata is required.");
  }
  return Object.freeze({
    league_id: stableId(metadata.leagueId),
    league_name: boundedText(
      metadata.leagueName,
      120
    ),
    league_status: metadata.leagueStatus,
    league_timezone: boundedText(
      metadata.leagueTimezone,
      120
    ),
    current_season_id:
      stableId(metadata.seasonId),
    league_version:
      positiveInteger(metadata.leagueVersion),
    season_id: stableId(metadata.seasonId),
    season_label: boundedText(
      metadata.seasonLabel,
      120
    ),
    nhl_season_key: boundedText(
      metadata.nhlSeasonKey,
      120
    ),
    season_status: metadata.seasonStatus,
    season_version:
      positiveInteger(metadata.seasonVersion),
    activated_team_count:
      positiveInteger(
        metadata.activatedTeamCount
      ),
    non_erased_team_count:
      positiveInteger(
        metadata.activatedTeamCount
      ),
    started_at_ms:
      safeTimestamp(metadata.startedAtMs),
  });
}

function createSqliteLeagueStartRepository({
  database,
  leagueOutboxWriter,
} = {}) {
  let activity;
  let idempotency;
  let outboxWriter;
  let findStartContextStatement;
  let findStartedAggregateStatement;
  let findStartedResultStatement;
  let findIdempotencyByScopeStatement;
  let findIdempotencyByIdStatement;
  let activateSetupTeamsStatement;
  let activatePlannedSeasonStatement;
  let findSeasonStatement;
  let activateSetupLeagueStatement;
  let findLeagueStatement;
  let completeIdempotencyStatement;

  try {
    activity = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("league_activity"),
    });
    idempotency = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("idempotency_requests"),
    });
    outboxWriter = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    findStartContextStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.current_season_id AS current_season_id,
        leagues.version AS league_version,
        league_settings.league_id AS settings_league_id,
        league_settings.trade_deadline_at_ms AS trade_deadline_at_ms,
        league_settings.maximum_teams AS maximum_teams,
        current_season.id AS current_season_row_id,
        current_season.label AS season_label,
        current_season.nhl_season_key AS nhl_season_key,
        current_season.status AS season_status,
        current_season.version AS season_version,
        (
          SELECT COUNT(*)
          FROM seasons
          WHERE seasons.league_id = leagues.id
        ) AS season_count,
        (
          SELECT COUNT(*)
          FROM teams
          WHERE teams.league_id = leagues.id
            AND teams.status <> 'erased'
        ) AS non_erased_team_count,
        (
          SELECT COUNT(*)
          FROM teams
          WHERE teams.league_id = leagues.id
            AND teams.status = 'setup'
        ) AS setup_team_count,
        (
          SELECT COUNT(*)
          FROM teams
          WHERE teams.league_id = leagues.id
            AND teams.status NOT IN ('setup', 'erased')
        ) AS invalid_team_state_count,
        (
          SELECT COUNT(*)
          FROM league_invitations
          WHERE league_invitations.league_id = leagues.id
            AND league_invitations.workflow IN (
              'create_team',
              'manage_team'
            )
        ) AS launch_invitation_count,
        (
          SELECT COUNT(*)
          FROM league_invitations
          WHERE league_invitations.league_id = leagues.id
            AND league_invitations.workflow IN (
              'create_team',
              'manage_team'
            )
            AND league_invitations.status = 'pending'
        ) AS pending_launch_invitation_count,
        (
          SELECT COUNT(*)
          FROM league_invitations
          WHERE league_invitations.league_id = leagues.id
            AND league_invitations.workflow IN (
              'create_team',
              'manage_team'
            )
            AND league_invitations.status = 'accepted'
        ) AS accepted_launch_invitation_count,
        (
          SELECT COUNT(*)
          FROM league_invitations AS invitation
          WHERE invitation.league_id = leagues.id
            AND invitation.workflow IN (
              'create_team',
              'manage_team'
            )
            AND invitation.status = 'accepted'
            AND (
              invitation.accepted_at_ms IS NULL
              OR invitation.invited_user_id IS NULL
              OR invitation.membership_id IS NULL
              OR invitation.team_id IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM league_memberships AS membership
                JOIN users AS manager_user
                  ON manager_user.id = membership.user_id
                JOIN teams AS invited_team
                  ON invited_team.league_id = membership.league_id
                 AND invited_team.id = invitation.team_id
                JOIN team_manager_assignments AS assignment
                  ON assignment.league_id = invited_team.league_id
                 AND assignment.team_id = invited_team.id
                 AND assignment.user_id = membership.user_id
                 AND assignment.membership_id = membership.id
                WHERE membership.league_id = invitation.league_id
                  AND membership.id = invitation.membership_id
                  AND membership.user_id =
                    invitation.invited_user_id
                  AND membership.permission_category IN (
                    'manager',
                    'commissioner'
                  )
                  AND membership.status = 'active'
                  AND membership.joined_at_ms IS NOT NULL
                  AND membership.ended_at_ms IS NULL
                  AND manager_user.status = 'active'
                  AND invited_team.status = 'setup'
                  AND assignment.status = 'accepted'
                  AND assignment.accepted_at_ms IS NOT NULL
                  AND assignment.ended_at_ms IS NULL
              )
            )
        ) AS invalid_accepted_invitation_count,
        (
          SELECT COUNT(*)
          FROM teams AS launch_team
          WHERE launch_team.league_id = leagues.id
            AND launch_team.status <> 'erased'
            AND NOT EXISTS (
              SELECT 1
              FROM team_manager_assignments AS current_assignment
              JOIN league_memberships AS current_membership
                ON current_membership.league_id =
                  current_assignment.league_id
               AND current_membership.id =
                  current_assignment.membership_id
               AND current_membership.user_id =
                  current_assignment.user_id
              JOIN users AS current_manager
                ON current_manager.id = current_assignment.user_id
              WHERE current_assignment.league_id =
                  launch_team.league_id
                AND current_assignment.team_id = launch_team.id
                AND current_assignment.status = 'accepted'
                AND current_assignment.accepted_at_ms IS NOT NULL
                AND current_assignment.ended_at_ms IS NULL
                AND current_membership.permission_category IN (
                  'manager',
                  'commissioner'
                )
                AND current_membership.status = 'active'
                AND current_membership.joined_at_ms IS NOT NULL
                AND current_membership.ended_at_ms IS NULL
                AND current_manager.status = 'active'
            )
        ) AS unmanaged_team_count
      FROM leagues
      LEFT JOIN league_settings
        ON league_settings.league_id = leagues.id
      LEFT JOIN seasons AS current_season
        ON current_season.league_id = leagues.id
       AND current_season.id = leagues.current_season_id
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    findStartedAggregateStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.current_season_id AS current_season_id,
        leagues.updated_at_ms AS started_at_ms,
        leagues.version AS league_version,
        seasons.id AS season_id,
        seasons.label AS season_label,
        seasons.nhl_season_key AS nhl_season_key,
        seasons.status AS season_status,
        seasons.updated_at_ms AS season_updated_at_ms,
        seasons.version AS season_version,
        (
          SELECT COUNT(*)
          FROM teams
          WHERE teams.league_id = leagues.id
            AND teams.status = 'active'
        ) AS activated_team_count,
        (
          SELECT COUNT(*)
          FROM teams
          WHERE teams.league_id = leagues.id
            AND teams.status <> 'erased'
        ) AS non_erased_team_count
      FROM leagues
      LEFT JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = leagues.current_season_id
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    findStartedResultStatement = database.prepare(`
      SELECT
        id AS activity_id,
        league_id,
        season_id,
        metadata_json
      FROM league_activity
      WHERE id = @activityId
        AND league_id = @leagueId
        AND event_type = 'league_started'
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
        "WHERE league_id = @leagueId AND id = @id LIMIT 2"
    );
    activateSetupTeamsStatement = database.prepare(`
      UPDATE teams
      SET status = 'active',
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND status = 'setup'
    `);
    activatePlannedSeasonStatement = database.prepare(`
      UPDATE seasons
      SET status = 'active',
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @seasonId
        AND status = 'planned'
        AND version = @expectedVersion
    `);
    findSeasonStatement = database.prepare(`
      SELECT *
      FROM seasons
      WHERE league_id = @leagueId AND id = @seasonId
      LIMIT 2
    `);
    activateSetupLeagueStatement = database.prepare(`
      UPDATE leagues
      SET status = 'active',
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @leagueId
        AND current_season_id = @seasonId
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
        result_type = 'league_start',
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
      operation: "prepareLeagueStartRepository",
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
    findStartContext(options) {
      exactObject(
        options,
        ["leagueId"],
        "An exact league-start context lookup is required."
      );
      return uniqueRow(
        findStartContextStatement,
        { leagueId: stableId(options.leagueId) },
        {
          operation: "findLeagueStartContext",
          tableName: "leagues",
          message: "The league-start context is not unique.",
        }
      );
    },
    findStartedAggregate(options) {
      exactObject(
        options,
        ["leagueId"],
        "An exact started-league lookup is required."
      );
      return uniqueRow(
        findStartedAggregateStatement,
        { leagueId: stableId(options.leagueId) },
        {
          operation: "findStartedLeagueAggregate",
          tableName: "leagues",
          message: "The started league aggregate is not unique.",
        }
      );
    },
    findStartedResult(options) {
      exactObject(
        options,
        ["leagueId", "activityId"],
        "An exact durable league-start result lookup is required."
      );
      const parameters = {
        leagueId: stableId(options.leagueId),
        activityId: stableId(options.activityId),
      };
      const row = uniqueRow(
        findStartedResultStatement,
        parameters,
        {
          operation: "findDurableLeagueStartResult",
          tableName: "league_activity",
          message:
            "The durable league-start result is not unique.",
        }
      );
      if (!row || row.season_id === null) {
        return null;
      }
      return projectStartedMetadata(
        row.metadata_json,
        {
          leagueId: parameters.leagueId,
          seasonId: stableId(row.season_id),
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
        "An exact league-start idempotency lookup is required."
      );
      return uniqueRow(
        findIdempotencyByScopeStatement,
        {
          leagueId: stableId(options.leagueId),
          actorUserId: stableId(options.actorUserId),
          operation: boundedText(options.operation, 128),
          clientKey: boundedText(options.clientKey, 128),
        },
        {
          operation: "findLeagueStartIdempotency",
          tableName: "idempotency_requests",
          message: "League-start idempotency scope is not unique.",
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
        "An exact started league-start idempotency record is required."
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
    activateSetupTeams(options) {
      exactObject(
        options,
        ["leagueId", "expectedTeamCount", "nowMs"],
        "An exact setup-team activation is required."
      );
      const parameters = {
        leagueId: stableId(options.leagueId),
        expectedTeamCount: positiveInteger(
          options.expectedTeamCount
        ),
        nowMs: safeTimestamp(options.nowMs),
      };
      try {
        const result = activateSetupTeamsStatement.run({
          leagueId: parameters.leagueId,
          nowMs: parameters.nowMs,
        });
        if (result.changes !== parameters.expectedTeamCount) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The setup-team activation count changed."
          );
        }
        return Object.freeze({
          activatedTeamCount: result.changes,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "activateLeagueStartTeams",
          tableName: "teams",
        });
      }
    },
    activatePlannedSeason(options) {
      exactObject(
        options,
        [
          "leagueId",
          "seasonId",
          "expectedVersion",
          "nowMs",
        ],
        "An exact planned-season activation is required."
      );
      const parameters = {
        leagueId: stableId(options.leagueId),
        seasonId: stableId(options.seasonId),
        expectedVersion: positiveInteger(
          options.expectedVersion
        ),
        nowMs: safeTimestamp(options.nowMs),
      };
      try {
        if (
          activatePlannedSeasonStatement.run(parameters).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The planned season could not be activated."
          );
        }
        return uniqueRow(
          findSeasonStatement,
          {
            leagueId: parameters.leagueId,
            seasonId: parameters.seasonId,
          },
          {
            operation: "readActivatedLeagueStartSeason",
            tableName: "seasons",
            message: "The activated season is not unique.",
          }
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "activateLeagueStartSeason",
          tableName: "seasons",
        });
      }
    },
    activateSetupLeague(options) {
      exactObject(
        options,
        [
          "leagueId",
          "seasonId",
          "expectedVersion",
          "nowMs",
        ],
        "An exact setup-league activation is required."
      );
      const parameters = {
        leagueId: stableId(options.leagueId),
        seasonId: stableId(options.seasonId),
        expectedVersion: positiveInteger(
          options.expectedVersion
        ),
        nowMs: safeTimestamp(options.nowMs),
      };
      try {
        if (
          activateSetupLeagueStatement.run(parameters).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The setup league could not be activated."
          );
        }
        return uniqueRow(
          findLeagueStatement,
          { leagueId: parameters.leagueId },
          {
            operation: "readActivatedSetupLeague",
            tableName: "leagues",
            message: "The activated league is not unique.",
          }
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "activateSetupLeague",
          tableName: "leagues",
        });
      }
    },
    appendStartedActivity(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "seasonId",
          "actorUserId",
          "actorAuthority",
          "displaySummary",
          "metadataJson",
          "nowMs",
        ],
        "Exact league-start activity is required."
      );
      const leagueId = stableId(options.leagueId);
      const seasonId = stableId(options.seasonId);
      const metadataJson = boundedText(options.metadataJson, 2048);
      projectStartedMetadata(metadataJson, {
        leagueId,
        seasonId,
      });
      if (
        !["commissioner", "platform_administrator"].includes(
          options.actorAuthority
        )
      ) {
        invalid("Safe league-start activity metadata is required.");
      }
      return freezeRow(
        activity.insert({
          id: stableId(options.id),
          league_id: leagueId,
          season_id: seasonId,
          event_type: "league_started",
          actor_user_id: stableId(options.actorUserId),
          actor_authority: options.actorAuthority,
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
          occurred_at_ms: safeTimestamp(options.nowMs),
        })
      );
    },
    writeStartedOutbox(options) {
      exactObject(
        options,
        ["id", "leagueId", "leagueVersion", "nowMs"],
        "An exact league-start outbox event is required."
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
          operation: "writeLeagueStartOutbox",
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
        "An exact league-start idempotency completion is required."
      );
      const parameters = {
        id: stableId(options.id),
        leagueId: stableId(options.leagueId),
        activityId: stableId(options.activityId),
        completedAtMs: safeTimestamp(options.completedAtMs),
      };
      try {
        if (
          completeIdempotencyStatement.run(parameters).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The league-start idempotency record cannot be completed."
          );
        }
        return uniqueRow(
          findIdempotencyByIdStatement,
          {
            id: parameters.id,
            leagueId: parameters.leagueId,
          },
          {
            operation: "readCompletedLeagueStartIdempotency",
            tableName: "idempotency_requests",
            message:
              "The completed league-start idempotency record is not unique.",
          }
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeLeagueStartIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },
  });
}

module.exports = {
  IDEMPOTENCY_COLUMNS,
  START_ACTIVITY_METADATA_KEYS,
  createSqliteLeagueStartRepository,
};
