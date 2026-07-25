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

function nullableStableId(value) {
  return value === null ? null : stableId(value);
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

function normalizedEmail(value) {
  const email = boundedText(value, 320);
  if (email !== email.toLowerCase()) {
    invalid("A normalized invitation email is required.");
  }
  return email;
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

function workflow(value) {
  if (!["create_team", "manage_team"].includes(value)) {
    invalid("An approved invitation workflow is required.");
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteLeagueInvitationRepository({ database } = {}) {
  const memberships = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_memberships"),
  });
  const invitations = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_invitations"),
  });
  const teams = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("teams"),
  });
  const assignments = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("team_manager_assignments"),
  });
  const notifications = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("notifications"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });
  const idempotency = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("idempotency_requests"),
  });

  let findInvitationAggregateStatement;
  let findLeagueContextStatement;
  let findActiveMembershipStatement;
  let findTeamStatement;
  let findPendingTeamInvitationStatement;
  let findIdempotencyByScopeStatement;
  let findIdempotencyByIdStatement;
  let completeIdempotencyStatement;
  try {
    findInvitationAggregateStatement = database.prepare(`
      SELECT
        league_invitations.id AS invitation_id,
        league_invitations.league_id AS league_id,
        league_invitations.invited_user_id AS invited_user_id,
        league_invitations.inviting_user_id AS inviting_user_id,
        league_invitations.membership_id AS membership_id,
        league_invitations.workflow AS workflow,
        league_invitations.team_id AS invited_team_id,
        league_invitations.status AS invitation_status,
        league_invitations.created_at_ms AS invited_at_ms,
        league_invitations.expires_at_ms AS expires_at_ms,
        league_invitations.accepted_at_ms AS accepted_at_ms,
        league_invitations.version AS invitation_version,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.version AS league_version,
        league_memberships.permission_category AS permission_category,
        league_memberships.status AS membership_status,
        league_memberships.joined_at_ms AS joined_at_ms,
        league_memberships.version AS membership_version,
        users.display_name AS invited_user_display_name,
        users.status AS invited_user_status,
        users.version AS invited_user_version,
        teams.id AS team_id,
        teams.name AS team_name,
        teams.name_normalized AS team_name_normalized,
        teams.status AS team_status,
        teams.primary_colour AS primary_colour,
        teams.secondary_colour AS secondary_colour,
        teams.logo_reference AS logo_reference,
        teams.version AS team_version,
        team_manager_assignments.id AS manager_assignment_id,
        team_manager_assignments.status AS manager_assignment_status,
        team_manager_assignments.assigned_at_ms AS manager_assigned_at_ms,
        team_manager_assignments.accepted_at_ms AS manager_accepted_at_ms,
        team_manager_assignments.version AS manager_assignment_version
      FROM league_invitations
      JOIN leagues ON leagues.id = league_invitations.league_id
      JOIN league_memberships
        ON league_memberships.league_id = league_invitations.league_id
       AND league_memberships.id = league_invitations.membership_id
      JOIN users ON users.id = league_invitations.invited_user_id
      LEFT JOIN teams
        ON teams.league_id = league_invitations.league_id
       AND teams.id = league_invitations.team_id
      LEFT JOIN team_manager_assignments
        ON team_manager_assignments.league_id = league_invitations.league_id
       AND team_manager_assignments.team_id = league_invitations.team_id
       AND team_manager_assignments.user_id = league_invitations.invited_user_id
       AND team_manager_assignments.membership_id = league_invitations.membership_id
       AND team_manager_assignments.status = 'accepted'
       AND team_manager_assignments.ended_at_ms IS NULL
      WHERE league_invitations.id = @invitationId
        AND league_invitations.workflow IS NOT NULL
      LIMIT 2
    `);
    findLeagueContextStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.name AS league_name,
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
    findActiveMembershipStatement = database.prepare(`
      SELECT * FROM league_memberships
      WHERE league_id = @leagueId
        AND user_id = @userId
        AND status = 'active'
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 2
    `);
    findTeamStatement = database.prepare(`
      SELECT
        teams.*,
        team_manager_assignments.id AS current_manager_assignment_id,
        team_manager_assignments.user_id AS current_manager_user_id
      FROM teams
      LEFT JOIN team_manager_assignments
        ON team_manager_assignments.league_id = teams.league_id
       AND team_manager_assignments.team_id = teams.id
       AND team_manager_assignments.status = 'accepted'
       AND team_manager_assignments.ended_at_ms IS NULL
      WHERE teams.league_id = @leagueId AND teams.id = @teamId
      LIMIT 2
    `);
    findPendingTeamInvitationStatement = database.prepare(`
      SELECT id FROM league_invitations
      WHERE league_id = @leagueId
        AND workflow = 'manage_team'
        AND team_id = @teamId
        AND status = 'pending'
      ORDER BY created_at_ms ASC, id ASC
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
      SET status = 'completed', result_type = 'league_invitation',
        result_id = @invitationId, completed_at_ms = @completedAtMs
      WHERE id = @id AND league_id = @leagueId AND status = 'started'
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLeagueInvitationRepository",
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
    findInvitationAggregate(invitationId) {
      return uniqueRow(
        findInvitationAggregateStatement,
        { invitationId: stableId(invitationId) },
        {
          operation: "findLeagueInvitationAggregate",
          tableName: "league_invitations",
          message: "A league invitation has ambiguous accepted authority.",
        }
      );
    },
    findLeagueContext(leagueId) {
      try {
        return freezeRow(
          findLeagueContextStatement.get({
            leagueId: stableId(leagueId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findLeagueInvitationLeagueContext",
          tableName: "leagues",
        });
      }
    },
    findActiveMembershipForUser({ leagueId, userId } = {}) {
      return uniqueRow(
        findActiveMembershipStatement,
        {
          leagueId: stableId(leagueId),
          userId: stableId(userId),
        },
        {
          operation: "findLeagueInvitationActiveMembership",
          tableName: "league_memberships",
          message: "A user has multiple active league memberships.",
        }
      );
    },
    findTeam({ leagueId, teamId } = {}) {
      return uniqueRow(
        findTeamStatement,
        {
          leagueId: stableId(leagueId),
          teamId: stableId(teamId),
        },
        {
          operation: "findLeagueInvitationTeam",
          tableName: "teams",
          message: "A team has multiple current manager assignments.",
        }
      );
    },
    findPendingTeamInvitation({ leagueId, teamId } = {}) {
      return uniqueRow(
        findPendingTeamInvitationStatement,
        {
          leagueId: stableId(leagueId),
          teamId: stableId(teamId),
        },
        {
          operation: "findPendingTeamInvitation",
          tableName: "league_invitations",
          message: "A team has multiple pending invitations.",
        }
      );
    },
    insertInvitedManagerMembership(options) {
      exactObject(
        options,
        ["id", "leagueId", "userId", "nowMs"],
        "An exact invited manager membership is required."
      );
      return freezeRow(
        memberships.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          user_id: stableId(options.userId),
          permission_category: "manager",
          status: "invited",
          joined_at_ms: null,
          ended_at_ms: null,
          created_at_ms: safeTimestamp(options.nowMs),
          updated_at_ms: options.nowMs,
          version: 1,
        })
      );
    },
    insertInvitation(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "invitedEmailNormalized",
          "invitedUserId",
          "invitingUserId",
          "membershipId",
          "workflow",
          "teamId",
          "nowMs",
        ],
        "An exact league invitation is required."
      );
      const nowMs = safeTimestamp(options.nowMs);
      const approvedWorkflow = workflow(options.workflow);
      const teamId = nullableStableId(options.teamId);
      if (
        (approvedWorkflow === "create_team" && teamId !== null) ||
        (approvedWorkflow === "manage_team" && teamId === null)
      ) {
        invalid("The invitation workflow and team target do not match.");
      }
      return freezeRow(
        invitations.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          invited_email_normalized: normalizedEmail(
            options.invitedEmailNormalized
          ),
          invited_user_id: stableId(options.invitedUserId),
          inviting_user_id: stableId(options.invitingUserId),
          membership_id: stableId(options.membershipId),
          workflow: approvedWorkflow,
          team_id: teamId,
          status: "pending",
          created_at_ms: nowMs,
          expires_at_ms: Number.MAX_SAFE_INTEGER,
          accepted_at_ms: null,
          version: 1,
        })
      );
    },
    insertInvitationNotification(options) {
      exactObject(
        options,
        [
          "id",
          "userId",
          "leagueId",
          "invitationId",
          "messageDataJson",
          "nowMs",
        ],
        "An exact league invitation notification is required."
      );
      const messageDataJson = boundedText(options.messageDataJson, 2048);
      let messageData;
      try {
        messageData = JSON.parse(messageDataJson);
      } catch {
        invalid("Safe league invitation notification data is required.");
      }
      if (
        !isPlainObject(messageData) ||
        Object.keys(messageData).length !== 5 ||
        messageData.invitationId !== options.invitationId ||
        messageData.leagueId !== options.leagueId ||
        typeof messageData.leagueName !== "string" ||
        !["create_team", "manage_team"].includes(messageData.workflow) ||
        (messageData.teamId !== null &&
          messageData.teamId !== nullableStableId(messageData.teamId))
      ) {
        invalid("Safe league invitation notification data is required.");
      }
      const nowMs = safeTimestamp(options.nowMs);
      return freezeRow(
        notifications.insert({
          id: stableId(options.id),
          user_id: stableId(options.userId),
          league_id: stableId(options.leagueId),
          event_type: "league_invitation_created",
          message_data_json: messageDataJson,
          related_feature: "league_invitation",
          related_record_id: stableId(options.invitationId),
          delivery_status: "delivered",
          created_at_ms: nowMs,
          read_at_ms: null,
          delivered_at_ms: nowMs,
          version: 1,
        })
      );
    },
    appendInvitationActivity(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "actorUserId",
          "actorAuthority",
          "eventType",
          "invitationId",
          "teamId",
          "displaySummary",
          "metadataJson",
          "nowMs",
        ],
        "Exact league invitation activity is required."
      );
      if (
        ![
          "league_invitation_created",
          "league_invitation_accepted",
          "league_invitation_declined",
        ].includes(options.eventType) ||
        !["commissioner", "invited_manager"].includes(
          options.actorAuthority
        )
      ) {
        invalid("Approved league invitation activity is required.");
      }
      const metadataJson = boundedText(options.metadataJson, 2048);
      let metadata;
      try {
        metadata = JSON.parse(metadataJson);
      } catch {
        invalid("Safe league invitation metadata is required.");
      }
      if (
        !isPlainObject(metadata) ||
        Object.keys(metadata).length !== 4 ||
        metadata.invitationId !== options.invitationId ||
        !["pending", "accepted", "declined"].includes(metadata.status) ||
        !["create_team", "manage_team"].includes(metadata.workflow) ||
        metadata.teamId !== options.teamId
      ) {
        invalid("Safe league invitation metadata is required.");
      }
      return freezeRow(
        activity.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          season_id: null,
          event_type: options.eventType,
          actor_user_id: stableId(options.actorUserId),
          actor_authority: options.actorAuthority,
          team_id: nullableStableId(options.teamId),
          player_id: null,
          related_type: "league_invitation",
          related_id: stableId(options.invitationId),
          display_summary: boundedText(options.displaySummary, 256),
          reason: null,
          metadata_json: metadataJson,
          occurred_at_ms: safeTimestamp(options.nowMs),
        })
      );
    },
    activateMembership(options) {
      exactObject(
        options,
        ["leagueId", "membershipId", "expectedVersion", "nowMs"],
        "An exact invited membership activation is required."
      );
      return freezeRow(
        memberships.updateVersioned({
          key: stableId(options.membershipId),
          leagueId: stableId(options.leagueId),
          expectedVersion: positiveInteger(options.expectedVersion),
          changes: {
            status: "active",
            joined_at_ms: safeTimestamp(options.nowMs),
            updated_at_ms: options.nowMs,
          },
        })
      );
    },
    endNeverActiveMembership(options) {
      exactObject(
        options,
        ["leagueId", "membershipId", "expectedVersion", "nowMs"],
        "An exact invited membership ending is required."
      );
      return freezeRow(
        memberships.updateVersioned({
          key: stableId(options.membershipId),
          leagueId: stableId(options.leagueId),
          expectedVersion: positiveInteger(options.expectedVersion),
          changes: {
            status: "ended",
            updated_at_ms: safeTimestamp(options.nowMs),
          },
        })
      );
    },
    insertSetupTeam(options) {
      exactObject(
        options,
        ["id", "leagueId", "name", "nameNormalized", "nowMs"],
        "An exact setup team is required."
      );
      const nowMs = safeTimestamp(options.nowMs);
      return freezeRow(
        teams.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          name: boundedText(options.name, 120),
          name_normalized: boundedText(options.nameNormalized, 120),
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
    insertAcceptedManagerAssignment(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "teamId",
          "userId",
          "membershipId",
          "assignedByUserId",
          "nowMs",
        ],
        "An exact accepted manager assignment is required."
      );
      const nowMs = safeTimestamp(options.nowMs);
      return freezeRow(
        assignments.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          team_id: stableId(options.teamId),
          user_id: stableId(options.userId),
          membership_id: stableId(options.membershipId),
          assigned_by_user_id: stableId(options.assignedByUserId),
          status: "accepted",
          assigned_at_ms: nowMs,
          accepted_at_ms: nowMs,
          ended_at_ms: null,
          version: 1,
        })
      );
    },
    acceptInvitation(options) {
      exactObject(
        options,
        [
          "leagueId",
          "invitationId",
          "teamId",
          "expectedVersion",
          "nowMs",
        ],
        "An exact league invitation acceptance is required."
      );
      return freezeRow(
        invitations.updateVersioned({
          key: stableId(options.invitationId),
          leagueId: stableId(options.leagueId),
          expectedVersion: positiveInteger(options.expectedVersion),
          changes: {
            status: "accepted",
            team_id: stableId(options.teamId),
            accepted_at_ms: safeTimestamp(options.nowMs),
          },
        })
      );
    },
    cancelInvitation(options) {
      exactObject(
        options,
        ["leagueId", "invitationId", "expectedVersion"],
        "An exact league invitation cancellation is required."
      );
      return freezeRow(
        invitations.updateVersioned({
          key: stableId(options.invitationId),
          leagueId: stableId(options.leagueId),
          expectedVersion: positiveInteger(options.expectedVersion),
          changes: { status: "cancelled" },
        })
      );
    },
    findIdempotency(options) {
      exactObject(
        options,
        ["actorUserId", "operation", "clientKey"],
        "An exact invitation idempotency lookup is required."
      );
      return uniqueRow(
        findIdempotencyByScopeStatement,
        {
          actorUserId: stableId(options.actorUserId),
          operation: boundedText(options.operation, 128),
          clientKey: boundedText(options.clientKey, 128),
        },
        {
          operation: "findLeagueInvitationIdempotency",
          tableName: "idempotency_requests",
          message: "Invitation idempotency scope is not unique.",
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
        "An exact started invitation idempotency record is required."
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
        ["id", "leagueId", "invitationId", "completedAtMs"],
        "An exact invitation idempotency completion is required."
      );
      const parameters = {
        id: stableId(options.id),
        leagueId: stableId(options.leagueId),
        invitationId: stableId(options.invitationId),
        completedAtMs: safeTimestamp(options.completedAtMs),
      };
      try {
        const result = completeIdempotencyStatement.run(parameters);
        if (result.changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The invitation idempotency record cannot be completed."
          );
        }
        return freezeRow(
          findIdempotencyByIdStatement.get({ id: parameters.id })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeLeagueInvitationIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },
  });
}

module.exports = {
  IDEMPOTENCY_COLUMNS,
  createSqliteLeagueInvitationRepository,
};
