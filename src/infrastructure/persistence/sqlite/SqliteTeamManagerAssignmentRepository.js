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
  "id", "league_id", "actor_user_id", "operation", "client_key",
  "request_hash", "status", "result_type", "result_id",
  "created_at_ms", "completed_at_ms", "expires_at_ms",
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

function nullableStableId(value) {
  return value === null ? null : stableId(value);
}

function boundedText(value, maximum) {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > maximum || value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    invalid("Bounded canonical text is required.");
  }
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid("A positive safe integer is required.");
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

function createSqliteTeamManagerAssignmentRepository({ database } = {}) {
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

  let findAggregateStatement;
  let findTeamStatement;
  let findActiveMembershipStatement;
  let findCurrentStatement;
  let findPendingStatement;
  let findIdempotencyStatement;
  let findIdempotencyByIdStatement;
  let completeIdempotencyStatement;
  try {
    findAggregateStatement = database.prepare(`
      SELECT
        proposed.id AS assignment_id,
        proposed.league_id AS league_id,
        proposed.team_id AS team_id,
        proposed.user_id AS proposed_user_id,
        proposed.membership_id AS membership_id,
        proposed.assigned_by_user_id AS assigned_by_user_id,
        proposed.replaces_assignment_id AS replaces_assignment_id,
        proposed.status AS assignment_status,
        proposed.assigned_at_ms AS assigned_at_ms,
        proposed.accepted_at_ms AS accepted_at_ms,
        proposed.ended_at_ms AS ended_at_ms,
        proposed.version AS assignment_version,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.version AS league_version,
        teams.name AS team_name,
        teams.status AS team_status,
        teams.version AS team_version,
        proposed_users.display_name AS proposed_user_display_name,
        proposed_users.status AS proposed_user_status,
        memberships.permission_category AS permission_category,
        memberships.user_id AS membership_user_id,
        memberships.status AS membership_status,
        memberships.version AS membership_version,
        current_assignment.id AS current_assignment_id,
        current_assignment.user_id AS current_manager_user_id,
        current_assignment.version AS current_assignment_version,
        current_users.display_name AS current_manager_display_name,
        replaced.user_id AS replaced_manager_user_id,
        replaced.status AS replaced_assignment_status,
        replaced.version AS replaced_assignment_version,
        replaced_users.display_name AS replaced_manager_display_name
      FROM team_manager_assignments proposed
      JOIN leagues ON leagues.id = proposed.league_id
      JOIN teams
        ON teams.league_id = proposed.league_id
       AND teams.id = proposed.team_id
      JOIN users proposed_users ON proposed_users.id = proposed.user_id
      JOIN league_memberships memberships
        ON memberships.league_id = proposed.league_id
       AND memberships.id = proposed.membership_id
      LEFT JOIN team_manager_assignments current_assignment
        ON current_assignment.league_id = proposed.league_id
       AND current_assignment.team_id = proposed.team_id
       AND current_assignment.status = 'accepted'
       AND current_assignment.ended_at_ms IS NULL
      LEFT JOIN users current_users
        ON current_users.id = current_assignment.user_id
      LEFT JOIN team_manager_assignments replaced
        ON replaced.league_id = proposed.league_id
       AND replaced.id = proposed.replaces_assignment_id
      LEFT JOIN users replaced_users ON replaced_users.id = replaced.user_id
      WHERE proposed.id = @assignmentId
      LIMIT 2
    `);
    findTeamStatement = database.prepare(`
      SELECT teams.*, leagues.name AS league_name,
        leagues.status AS league_status, leagues.version AS league_version
      FROM teams
      JOIN leagues ON leagues.id = teams.league_id
      WHERE teams.league_id = @leagueId AND teams.id = @teamId
      LIMIT 2
    `);
    findActiveMembershipStatement = database.prepare(`
      SELECT * FROM league_memberships
      WHERE league_id = @leagueId AND user_id = @userId AND status = 'active'
      ORDER BY created_at_ms ASC, id ASC LIMIT 2
    `);
    findCurrentStatement = database.prepare(`
      SELECT * FROM team_manager_assignments
      WHERE league_id = @leagueId AND team_id = @teamId
        AND status = 'accepted' AND ended_at_ms IS NULL
      ORDER BY assigned_at_ms ASC, id ASC LIMIT 2
    `);
    findPendingStatement = database.prepare(`
      SELECT * FROM team_manager_assignments
      WHERE league_id = @leagueId AND team_id = @teamId AND status = 'pending'
      ORDER BY assigned_at_ms ASC, id ASC LIMIT 2
    `);
    findIdempotencyStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} FROM idempotency_requests ` +
      "WHERE actor_user_id = @actorUserId AND operation = @operation " +
      "AND client_key = @clientKey ORDER BY created_at_ms DESC, id DESC LIMIT 2"
    );
    findIdempotencyByIdStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} FROM idempotency_requests WHERE id = @id`
    );
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed', result_type = 'team_manager_assignment',
        result_id = @assignmentId, completed_at_ms = @completedAtMs
      WHERE id = @id AND league_id = @leagueId AND status = 'started'
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTeamManagerAssignmentRepository",
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

  function teamScope(options, message) {
    exactObject(options, ["leagueId", "teamId"], message);
    return {
      leagueId: stableId(options.leagueId),
      teamId: stableId(options.teamId),
    };
  }

  return Object.freeze({
    findAssignmentAggregate(assignmentId) {
      return uniqueRow(
        findAggregateStatement,
        { assignmentId: stableId(assignmentId) },
        {
          operation: "findTeamManagerAssignmentAggregate",
          tableName: "team_manager_assignments",
          message: "A team-manager assignment aggregate is ambiguous.",
        }
      );
    },
    findTeam(options) {
      return uniqueRow(
        findTeamStatement,
        teamScope(options, "An exact team lookup is required."),
        {
          operation: "findManagerAssignmentTeam",
          tableName: "teams",
          message: "A team lookup is ambiguous.",
        }
      );
    },
    findActiveMembershipForUser(options) {
      exactObject(
        options,
        ["leagueId", "userId"],
        "An exact active-membership lookup is required."
      );
      return uniqueRow(
        findActiveMembershipStatement,
        {
          leagueId: stableId(options.leagueId),
          userId: stableId(options.userId),
        },
        {
          operation: "findManagerActiveMembership",
          tableName: "league_memberships",
          message: "A user has multiple active league memberships.",
        }
      );
    },
    findCurrentAssignment(options) {
      return uniqueRow(
        findCurrentStatement,
        teamScope(options, "An exact current-assignment lookup is required."),
        {
          operation: "findCurrentTeamManagerAssignment",
          tableName: "team_manager_assignments",
          message: "A team has multiple current manager assignments.",
        }
      );
    },
    findPendingAssignment(options) {
      return uniqueRow(
        findPendingStatement,
        teamScope(options, "An exact pending-assignment lookup is required."),
        {
          operation: "findPendingTeamManagerAssignment",
          tableName: "team_manager_assignments",
          message: "A team has multiple pending manager assignments.",
        }
      );
    },
    insertPendingAssignment(options) {
      exactObject(
        options,
        [
          "id", "leagueId", "teamId", "userId", "membershipId",
          "assignedByUserId", "replacesAssignmentId", "nowMs",
        ],
        "An exact pending manager assignment is required."
      );
      return freezeRow(assignments.insert({
        id: stableId(options.id),
        league_id: stableId(options.leagueId),
        team_id: stableId(options.teamId),
        user_id: stableId(options.userId),
        membership_id: stableId(options.membershipId),
        assigned_by_user_id: stableId(options.assignedByUserId),
        replaces_assignment_id: nullableStableId(options.replacesAssignmentId),
        status: "pending",
        assigned_at_ms: safeTimestamp(options.nowMs),
        accepted_at_ms: null,
        ended_at_ms: null,
        version: 1,
      }));
    },
    acceptAssignment(options) {
      exactObject(
        options,
        ["leagueId", "assignmentId", "expectedVersion", "nowMs"],
        "An exact manager-assignment acceptance is required."
      );
      return freezeRow(assignments.updateVersioned({
        key: stableId(options.assignmentId),
        leagueId: stableId(options.leagueId),
        expectedVersion: positiveInteger(options.expectedVersion),
        changes: {
          status: "accepted",
          accepted_at_ms: safeTimestamp(options.nowMs),
        },
      }));
    },
    declineAssignment(options) {
      exactObject(
        options,
        ["leagueId", "assignmentId", "expectedVersion"],
        "An exact manager-assignment decline is required."
      );
      return freezeRow(assignments.updateVersioned({
        key: stableId(options.assignmentId),
        leagueId: stableId(options.leagueId),
        expectedVersion: positiveInteger(options.expectedVersion),
        changes: { status: "declined" },
      }));
    },
    endAssignment(options) {
      exactObject(
        options,
        ["leagueId", "assignmentId", "expectedVersion", "nowMs"],
        "An exact manager-assignment ending is required."
      );
      return freezeRow(assignments.updateVersioned({
        key: stableId(options.assignmentId),
        leagueId: stableId(options.leagueId),
        expectedVersion: positiveInteger(options.expectedVersion),
        changes: {
          status: "ended",
          ended_at_ms: safeTimestamp(options.nowMs),
        },
      }));
    },
    insertProposalNotification(options) {
      exactObject(
        options,
        ["id", "userId", "leagueId", "assignmentId", "messageDataJson", "nowMs"],
        "An exact manager-assignment notification is required."
      );
      const messageDataJson = boundedText(options.messageDataJson, 2048);
      let messageData;
      try { messageData = JSON.parse(messageDataJson); } catch {
        invalid("Safe manager-assignment notification data is required.");
      }
      if (
        !isPlainObject(messageData) || Object.keys(messageData).length !== 5 ||
        messageData.assignmentId !== options.assignmentId ||
        messageData.leagueId !== options.leagueId ||
        messageData.teamId !== stableId(messageData.teamId) ||
        typeof messageData.leagueName !== "string" ||
        typeof messageData.teamName !== "string"
      ) {
        invalid("Safe manager-assignment notification data is required.");
      }
      const nowMs = safeTimestamp(options.nowMs);
      return freezeRow(notifications.insert({
        id: stableId(options.id),
        user_id: stableId(options.userId),
        league_id: stableId(options.leagueId),
        event_type: "team_manager_assignment_proposed",
        message_data_json: messageDataJson,
        related_feature: "team_manager_assignment",
        related_record_id: stableId(options.assignmentId),
        delivery_status: "delivered",
        created_at_ms: nowMs,
        read_at_ms: null,
        delivered_at_ms: nowMs,
        version: 1,
      }));
    },
    appendAssignmentActivity(options) {
      exactObject(
        options,
        [
          "id", "leagueId", "teamId", "actorUserId", "actorAuthority",
          "eventType", "assignmentId", "displaySummary", "metadataJson", "nowMs",
        ],
        "Exact team-manager assignment activity is required."
      );
      const eventTypes = new Set([
        "team_manager_assignment_proposed",
        "team_manager_assignment_accepted",
        "team_manager_assignment_declined",
        "team_manager_assignment_removed",
      ]);
      if (
        !eventTypes.has(options.eventType) ||
        !["commissioner", "proposed_manager"].includes(options.actorAuthority)
      ) {
        invalid("Approved team-manager assignment activity is required.");
      }
      const metadataJson = boundedText(options.metadataJson, 2048);
      let metadata;
      try { metadata = JSON.parse(metadataJson); } catch {
        invalid("Safe team-manager assignment metadata is required.");
      }
      if (
        !isPlainObject(metadata) || Object.keys(metadata).length !== 4 ||
        metadata.assignmentId !== options.assignmentId ||
        metadata.teamId !== options.teamId ||
        !["pending", "accepted", "declined", "ended"].includes(metadata.status) ||
        metadata.replacesAssignmentId !== nullableStableId(metadata.replacesAssignmentId)
      ) {
        invalid("Safe team-manager assignment metadata is required.");
      }
      return freezeRow(activity.insert({
        id: stableId(options.id),
        league_id: stableId(options.leagueId),
        season_id: null,
        event_type: options.eventType,
        actor_user_id: stableId(options.actorUserId),
        actor_authority: options.actorAuthority,
        team_id: stableId(options.teamId),
        player_id: null,
        related_type: "team_manager_assignment",
        related_id: stableId(options.assignmentId),
        display_summary: boundedText(options.displaySummary, 256),
        reason: null,
        metadata_json: metadataJson,
        occurred_at_ms: safeTimestamp(options.nowMs),
      }));
    },
    findIdempotency(options) {
      exactObject(
        options,
        ["actorUserId", "operation", "clientKey"],
        "An exact manager-assignment idempotency lookup is required."
      );
      return uniqueRow(
        findIdempotencyStatement,
        {
          actorUserId: stableId(options.actorUserId),
          operation: boundedText(options.operation, 128),
          clientKey: boundedText(options.clientKey, 128),
        },
        {
          operation: "findTeamManagerAssignmentIdempotency",
          tableName: "idempotency_requests",
          message: "Manager-assignment idempotency scope is not unique.",
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
        "An exact started manager-assignment idempotency record is required."
      );
      if (!DIGEST_PATTERN.test(options.requestHash || "")) {
        invalid("A canonical request digest is required.");
      }
      const createdAtMs = safeTimestamp(options.createdAtMs);
      const expiresAtMs = safeTimestamp(options.expiresAtMs);
      if (expiresAtMs <= createdAtMs) invalid("Idempotency expiry is invalid.");
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
        ["id", "leagueId", "assignmentId", "completedAtMs"],
        "An exact manager-assignment idempotency completion is required."
      );
      const parameters = {
        id: stableId(options.id),
        leagueId: stableId(options.leagueId),
        assignmentId: stableId(options.assignmentId),
        completedAtMs: safeTimestamp(options.completedAtMs),
      };
      try {
        const result = completeIdempotencyStatement.run(parameters);
        if (result.changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The manager-assignment idempotency record cannot be completed."
          );
        }
        return freezeRow(findIdempotencyByIdStatement.get({ id: parameters.id }));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeTeamManagerAssignmentIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },
  });
}

module.exports = {
  IDEMPOTENCY_COLUMNS,
  createSqliteTeamManagerAssignmentRepository,
};
