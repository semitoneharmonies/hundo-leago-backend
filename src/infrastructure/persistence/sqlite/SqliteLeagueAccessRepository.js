const crypto = require("node:crypto");

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
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function deterministicUuid(value) {
  const hex = crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function createSqliteLeagueAccessRepository({
  database,
  leagueOutboxWriter,
} = {}) {
  const outbox = resolveSqliteLeagueOutboxWriter({
    database,
    leagueOutboxWriter,
  });
  let listVisibleLeaguesStatement;
  let findActiveMembershipStatement;
  let findLeagueSummaryStatement;
  let findLeagueSettingsStatement;
  let listLeagueMembershipsStatement;
  let listLeagueSeasonsStatement;
  let listInvitableUsersStatement;
  let findMembershipStatement;
  let listEndingManagerAssignmentsStatement;
  let findManagerAssignmentStatement;
  let endMembershipStatement;
  let endManagerAssignmentsStatement;
  let insertMembershipActivityStatement;
  let endMembershipTransaction;
  try {
    listVisibleLeaguesStatement = database.prepare(`
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
        league_memberships.id AS membership_id,
        league_memberships.permission_category AS permission_category,
        league_memberships.status AS membership_status,
        league_memberships.version AS membership_version
      FROM league_memberships
      JOIN leagues
        ON leagues.id = league_memberships.league_id
      LEFT JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = leagues.current_season_id
      WHERE league_memberships.user_id = @userId
        AND league_memberships.status = 'active'
        AND leagues.status <> 'deleted'
      ORDER BY leagues.id ASC
    `);
    findActiveMembershipStatement = database.prepare(`
      SELECT *
      FROM league_memberships
      WHERE league_id = @leagueId
        AND user_id = @userId
        AND status = 'active'
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 2
    `);
    findLeagueSummaryStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.commissioner_membership_id AS commissioner_membership_id,
        leagues.current_season_id AS current_season_id,
        leagues.version AS league_version,
        seasons.label AS season_label,
        seasons.nhl_season_key AS nhl_season_key,
        seasons.status AS season_status,
        seasons.regular_season_starts_at_ms AS regular_season_starts_at_ms,
        seasons.regular_season_ends_at_ms AS regular_season_ends_at_ms,
        seasons.fantasy_playoffs_start_at_ms AS fantasy_playoffs_start_at_ms,
        seasons.fantasy_playoffs_end_at_ms AS fantasy_playoffs_end_at_ms,
        seasons.version AS season_version
      FROM leagues
      LEFT JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = leagues.current_season_id
      WHERE leagues.id = @leagueId
    `);
    findLeagueSettingsStatement = database.prepare(`
      SELECT *
      FROM league_settings
      WHERE league_id = @leagueId
    `);
    listLeagueMembershipsStatement = database.prepare(`
      SELECT
        league_memberships.id AS membership_id,
        league_memberships.league_id AS league_id,
        league_memberships.user_id AS user_id,
        users.display_name AS display_name,
        league_memberships.permission_category AS permission_category,
        league_memberships.status AS membership_status,
        league_memberships.joined_at_ms AS joined_at_ms,
        league_memberships.ended_at_ms AS ended_at_ms,
        league_memberships.created_at_ms AS created_at_ms,
        league_memberships.updated_at_ms AS updated_at_ms,
        league_memberships.version AS membership_version,
        CASE WHEN EXISTS (
          SELECT 1
          FROM platform_roles AS protected_role
          WHERE protected_role.user_id = league_memberships.user_id
            AND protected_role.role = 'platform_administrator'
            AND protected_role.status = 'active'
            AND protected_role.ended_at_ms IS NULL
        ) THEN 1 ELSE 0 END AS is_platform_administrator
      FROM league_memberships
      JOIN users
        ON users.id = league_memberships.user_id
      WHERE league_memberships.league_id = @leagueId
      ORDER BY league_memberships.created_at_ms ASC,
        league_memberships.id ASC
    `);
    listLeagueSeasonsStatement = database.prepare(`
      SELECT *
      FROM seasons
      WHERE league_id = @leagueId
      ORDER BY
        CASE status
          WHEN 'active' THEN 0
          WHEN 'planned' THEN 1
          WHEN 'completed' THEN 2
          ELSE 3
        END,
        regular_season_starts_at_ms DESC,
        created_at_ms DESC,
        id ASC
    `);
    listInvitableUsersStatement = database.prepare(`
      SELECT users.id AS user_id, users.display_name, users.email_display
      FROM users
      WHERE users.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM league_memberships
          WHERE league_memberships.league_id = @leagueId
            AND league_memberships.user_id = users.id
            AND league_memberships.status IN ('active', 'invited')
        )
      ORDER BY users.display_name_normalized ASC, users.id ASC
    `);
    findMembershipStatement = database.prepare(`
      SELECT
        league_memberships.*,
        CASE WHEN EXISTS (
          SELECT 1
          FROM platform_roles AS protected_role
          WHERE protected_role.user_id = league_memberships.user_id
            AND protected_role.role = 'platform_administrator'
            AND protected_role.status = 'active'
            AND protected_role.ended_at_ms IS NULL
        ) THEN 1 ELSE 0 END AS is_platform_administrator
      FROM league_memberships
      WHERE league_memberships.league_id = @leagueId
        AND league_memberships.id = @membershipId
      LIMIT 2
    `);
    listEndingManagerAssignmentsStatement = database.prepare(`
      SELECT id, league_id, team_id, membership_id, status,
        ended_at_ms, version
      FROM team_manager_assignments
      WHERE league_id = @leagueId
        AND membership_id = @membershipId
        AND status IN ('pending', 'accepted')
        AND ended_at_ms IS NULL
      ORDER BY team_id, id
    `);
    findManagerAssignmentStatement = database.prepare(`
      SELECT id, league_id, team_id, membership_id, status,
        ended_at_ms, version
      FROM team_manager_assignments
      WHERE league_id = @leagueId AND id = @assignmentId
      LIMIT 2
    `);
    endMembershipStatement = database.prepare(`
      UPDATE league_memberships
      SET status = 'ended', ended_at_ms = @occurredAtMs,
        updated_at_ms = @occurredAtMs, version = version + 1
      WHERE league_id = @leagueId
        AND id = @membershipId
        AND status IN ('active', 'invited')
        AND version = @expectedVersion
    `);
    endManagerAssignmentsStatement = database.prepare(`
      UPDATE team_manager_assignments
      SET status = 'ended', ended_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND membership_id = @membershipId
        AND status IN ('pending', 'accepted')
        AND ended_at_ms IS NULL
    `);
    insertMembershipActivityStatement = database.prepare(`
      INSERT INTO league_activity (
        id, league_id, season_id, event_type, actor_user_id,
        actor_authority, team_id, player_id, related_type, related_id,
        display_summary, reason, metadata_json, occurred_at_ms
      ) VALUES (
        @activityId, @leagueId, NULL, 'league_membership_ended',
        @actorUserId, 'commissioner', NULL, NULL,
        'league_membership', @membershipId,
        'A league membership was removed.', NULL, @metadataJson,
        @occurredAtMs
      )
    `);
    endMembershipTransaction = database.transaction((command) => {
      const rows = findMembershipStatement.all(command);
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "A league membership is not unique."
        );
      }
      const current = rows[0];
      if (!current) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.recordNotFound,
          "The league membership was not found."
        );
      }
      if (
        !["active", "invited"].includes(current.status) ||
        current.version !== command.expectedVersion
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The league membership changed before removal."
        );
      }
      if (current.is_platform_administrator === 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.constraint,
          "A protected platform-administrator membership cannot be removed.",
          { details: { tableName: "league_memberships" } }
        );
      }
      const currentManagerAssignments =
        listEndingManagerAssignmentsStatement.all(command);
      const endedManagerAssignments =
        endManagerAssignmentsStatement.run(command);
      if (
        endedManagerAssignments.changes !==
        currentManagerAssignments.length
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "A manager assignment changed before membership removal."
        );
      }
      const ended = endMembershipStatement.run(command);
      if (ended.changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The league membership changed before removal."
        );
      }
      insertMembershipActivityStatement.run({
        ...command,
        metadataJson: JSON.stringify({
          membershipId: command.membershipId,
          removedUserId: current.user_id,
        }),
      });
      const endedMembership = findMembershipStatement.get(command);
      outbox.write({
        id: command.publicationId,
        leagueId: command.leagueId,
        eventType: "league.changed",
        aggregateType: "league_membership",
        aggregateId: endedMembership.id,
        occurredAtMs: command.occurredAtMs,
        payload: createSocketEventMetadata({
          eventType: "league.changed",
          version: endedMembership.version,
          reasonCode: "membership_changed",
          occurredAtMs: command.occurredAtMs,
          related: createEmptySocketRelated(),
        }),
      });
      for (const previous of currentManagerAssignments) {
        const endedAssignment = findManagerAssignmentStatement.get({
          leagueId: command.leagueId,
          assignmentId: previous.id,
        });
        if (
          !endedAssignment ||
          endedAssignment.membership_id !== command.membershipId ||
          endedAssignment.team_id !== previous.team_id ||
          endedAssignment.status !== "ended" ||
          endedAssignment.ended_at_ms !== command.occurredAtMs ||
          endedAssignment.version !== previous.version + 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "A manager assignment changed before membership removal."
          );
        }
        outbox.write({
          id: deterministicUuid(
            `${command.publicationId}:manager-assignment:${previous.id}`
          ),
          leagueId: command.leagueId,
          eventType: "team.changed",
          aggregateType: "team_manager_assignment",
          aggregateId: endedAssignment.id,
          occurredAtMs: command.occurredAtMs,
          payload: createSocketEventMetadata({
            eventType: "team.changed",
            version: endedAssignment.version,
            reasonCode: "manager_assignment_changed",
            occurredAtMs: command.occurredAtMs,
            related: createEmptySocketRelated({
              teamId: endedAssignment.team_id,
            }),
          }),
        });
      }
      return endedMembership;
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeagueAccessRepository",
    });
  }

  return Object.freeze({
    listVisibleLeagues(userId) {
      try {
        return freezeRows(
          listVisibleLeaguesStatement.all({
            userId: stableId(userId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listVisibleLeagues",
          tableName: "league_memberships",
        });
      }
    },
    findActiveMembership({ leagueId, userId } = {}) {
      try {
        const rows = findActiveMembershipStatement.all({
          leagueId: stableId(leagueId),
          userId: stableId(userId),
        });
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A user has multiple active memberships in one league."
          );
        }
        return freezeRow(rows[0]);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActiveLeagueMembership",
          tableName: "league_memberships",
        });
      }
    },
    findLeagueSummary(leagueId) {
      try {
        return freezeRow(
          findLeagueSummaryStatement.get({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findLeagueSummary",
          tableName: "leagues",
        });
      }
    },
    findLeagueSettings(leagueId) {
      try {
        return freezeRow(
          findLeagueSettingsStatement.get({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findLeagueSettings",
          tableName: "league_settings",
        });
      }
    },
    listLeagueMemberships(leagueId) {
      try {
        return freezeRows(
          listLeagueMembershipsStatement.all({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listLeagueMemberships",
          tableName: "league_memberships",
        });
      }
    },
    listInvitableUsers(leagueId) {
      try {
        return freezeRows(
          listInvitableUsersStatement.all({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listInvitableLeagueUsers",
          tableName: "users",
        });
      }
    },
    endMembership(command) {
      try {
        return freezeRow(
          endMembershipTransaction.immediate({
            leagueId: stableId(command.leagueId),
            membershipId: stableId(command.membershipId),
            actorUserId: stableId(command.actorUserId),
            activityId: stableId(command.activityId),
            publicationId: stableId(command.publicationId),
            expectedVersion: command.expectedVersion,
            occurredAtMs: command.occurredAtMs,
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "endLeagueMembership",
          tableName: "league_memberships",
        });
      }
    },
    listLeagueSeasons(leagueId) {
      try {
        return freezeRows(
          listLeagueSeasonsStatement.all({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listLeagueSeasons",
          tableName: "seasons",
        });
      }
    },
  });
}

module.exports = {
  UUID_PATTERN,
  createSqliteLeagueAccessRepository,
};
