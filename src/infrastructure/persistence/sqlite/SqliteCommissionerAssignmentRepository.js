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

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function createSqliteCommissionerAssignmentRepository({
  database,
} = {}) {
  const leagues = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("leagues"),
  });
  const memberships = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_memberships"),
  });
  const invitations = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_invitations"),
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

  let findAssignmentAggregateStatement;
  let findActiveCommissionerStatement;
  let findActiveMembershipForUserStatement;
  let findPendingCommissionerStatement;
  let findIdempotencyByScope;
  let findIdempotencyById;
  let completeIdempotencyStatement;
  try {
    findAssignmentAggregateStatement = database.prepare(`
      SELECT
        league_invitations.id AS assignment_id,
        league_invitations.league_id AS league_id,
        league_invitations.invited_user_id AS proposed_user_id,
        league_invitations.inviting_user_id AS proposed_by_user_id,
        league_invitations.membership_id AS membership_id,
        league_invitations.status AS assignment_status,
        league_invitations.created_at_ms AS proposed_at_ms,
        league_invitations.accepted_at_ms AS accepted_at_ms,
        league_invitations.version AS assignment_version,
        league_memberships.permission_category AS permission_category,
        league_memberships.status AS membership_status,
        league_memberships.joined_at_ms AS joined_at_ms,
        league_memberships.version AS membership_version,
        leagues.name AS league_name,
        leagues.status AS league_status,
        leagues.commissioner_membership_id AS commissioner_membership_id,
        leagues.version AS league_version,
        users.display_name AS proposed_user_display_name,
        users.status AS proposed_user_status,
        users.version AS proposed_user_version
      FROM league_invitations
      JOIN league_memberships
        ON league_memberships.league_id = league_invitations.league_id
       AND league_memberships.id = league_invitations.membership_id
      JOIN leagues
        ON leagues.id = league_invitations.league_id
      JOIN users
        ON users.id = league_invitations.invited_user_id
      WHERE league_invitations.id = @assignmentId
    `);
    findPendingCommissionerStatement = database.prepare(`
      SELECT league_invitations.*
      FROM league_invitations
      JOIN league_memberships
        ON league_memberships.league_id = league_invitations.league_id
       AND league_memberships.id = league_invitations.membership_id
      WHERE league_invitations.league_id = @leagueId
        AND league_invitations.status = 'pending'
        AND league_memberships.permission_category = 'commissioner'
      ORDER BY league_invitations.created_at_ms ASC,
        league_invitations.id ASC
      LIMIT 2
    `);
    findActiveCommissionerStatement = database.prepare(`
      SELECT *
      FROM league_memberships
      WHERE league_id = @leagueId
        AND permission_category = 'commissioner'
        AND status = 'active'
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 2
    `);
    findActiveMembershipForUserStatement = database.prepare(`
      SELECT *
      FROM league_memberships
      WHERE league_id = @leagueId
        AND user_id = @userId
        AND status = 'active'
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 2
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
        "status = 'completed', result_type = 'commissioner_assignment', " +
        "result_id = @assignmentId, completed_at_ms = @completedAtMs " +
        "WHERE id = @id AND league_id = @leagueId AND status = 'started'"
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareCommissionerAssignmentRepository",
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
        operation: "findCommissionerAssignmentIdempotency",
        tableName: "idempotency_requests",
      });
    }
  }

  return Object.freeze({
    findLeagueById(leagueId) {
      return freezeRow(
        leagues.findByKey({ key: stableId(leagueId) })
      );
    },
    findAssignmentAggregate(assignmentId) {
      try {
        return freezeRow(
          findAssignmentAggregateStatement.get({
            assignmentId: stableId(assignmentId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findCommissionerAssignmentAggregate",
          tableName: "league_invitations",
        });
      }
    },
    findActiveCommissionerMembership(leagueId) {
      try {
        const rows = findActiveCommissionerStatement.all({
          leagueId: stableId(leagueId),
        });
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A league has multiple active commissioner memberships."
          );
        }
        return freezeRow(rows[0]);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActiveCommissionerMembership",
          tableName: "league_memberships",
        });
      }
    },
    findActiveMembershipForUser(options) {
      exactObject(
        options,
        ["leagueId", "userId"],
        "An exact active membership lookup is required."
      );
      try {
        const rows = findActiveMembershipForUserStatement.all({
          leagueId: stableId(options.leagueId),
          userId: stableId(options.userId),
        });
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A user has multiple active league memberships."
          );
        }
        return freezeRow(rows[0]);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findActiveMembershipForUser",
          tableName: "league_memberships",
        });
      }
    },
    findPendingCommissionerAssignment(leagueId) {
      try {
        const rows = findPendingCommissionerStatement.all({
          leagueId: stableId(leagueId),
        });
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A league has multiple pending commissioner assignments."
          );
        }
        return freezeRow(rows[0]);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findPendingCommissionerAssignment",
          tableName: "league_invitations",
        });
      }
    },
    insertInvitedCommissionerMembership(options) {
      exactObject(
        options,
        ["id", "leagueId", "userId", "nowMs"],
        "An exact invited commissioner membership is required."
      );
      return freezeRow(
        memberships.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          user_id: stableId(options.userId),
          permission_category: "commissioner",
          status: "invited",
          joined_at_ms: null,
          ended_at_ms: null,
          created_at_ms: safeTimestamp(options.nowMs),
          updated_at_ms: options.nowMs,
          version: 1,
        })
      );
    },
    insertCommissionerInvitation(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "invitedEmailNormalized",
          "invitedUserId",
          "invitingUserId",
          "membershipId",
          "nowMs",
        ],
        "An exact commissioner invitation is required."
      );
      const nowMs = safeTimestamp(options.nowMs);
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
          status: "pending",
          created_at_ms: nowMs,
          expires_at_ms: Number.MAX_SAFE_INTEGER,
          accepted_at_ms: null,
          version: 1,
        })
      );
    },
    insertProposalNotification(options) {
      exactObject(
        options,
        ["id", "userId", "leagueId", "assignmentId", "messageDataJson", "nowMs"],
        "An exact commissioner proposal notification is required."
      );
      const messageDataJson = boundedText(
        options.messageDataJson,
        2048
      );
      let messageData;
      try {
        messageData = JSON.parse(messageDataJson);
      } catch {
        invalid("Safe commissioner notification data is required.");
      }
      if (
        !isPlainObject(messageData) ||
        Object.keys(messageData).length !== 3 ||
        messageData.assignmentId !== options.assignmentId ||
        messageData.leagueId !== options.leagueId ||
        typeof messageData.leagueName !== "string"
      ) {
        invalid("Safe commissioner notification data is required.");
      }
      const nowMs = safeTimestamp(options.nowMs);
      return freezeRow(
        notifications.insert({
          id: stableId(options.id),
          user_id: stableId(options.userId),
          league_id: stableId(options.leagueId),
          event_type: "commissioner_assignment_proposed",
          message_data_json: messageDataJson,
          related_feature: "commissioner_assignment",
          related_record_id: stableId(options.assignmentId),
          delivery_status: "delivered",
          created_at_ms: nowMs,
          read_at_ms: null,
          delivered_at_ms: nowMs,
          version: 1,
        })
      );
    },
    appendAssignmentActivity(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "actorUserId",
          "actorAuthority",
          "eventType",
          "assignmentId",
          "displaySummary",
          "metadataJson",
          "nowMs",
        ],
        "Exact commissioner assignment activity is required."
      );
      if (
        ![
          "commissioner_assignment_proposed",
          "commissioner_assignment_accepted",
          "commissioner_assignment_declined",
        ].includes(options.eventType)
      ) {
        invalid("An approved commissioner assignment event is required.");
      }
      if (
        !["platform_administrator", "proposed_commissioner"].includes(
          options.actorAuthority
        )
      ) {
        invalid("An approved commissioner assignment authority is required.");
      }
      const metadataJson = boundedText(options.metadataJson, 2048);
      let metadata;
      try {
        metadata = JSON.parse(metadataJson);
      } catch {
        invalid("Safe commissioner assignment metadata is required.");
      }
      if (
        !isPlainObject(metadata) ||
        Object.keys(metadata).length !== 2 ||
        metadata.assignmentId !== options.assignmentId ||
        !["pending", "accepted", "declined"].includes(metadata.status)
      ) {
        invalid("Safe commissioner assignment metadata is required.");
      }
      return freezeRow(
        activity.insert({
          id: stableId(options.id),
          league_id: stableId(options.leagueId),
          season_id: null,
          event_type: options.eventType,
          actor_user_id: stableId(options.actorUserId),
          actor_authority: options.actorAuthority,
          team_id: null,
          player_id: null,
          related_type: "commissioner_assignment",
          related_id: stableId(options.assignmentId),
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
        "An exact commissioner membership activation is required."
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
    setLeagueCommissioner(options) {
      exactObject(
        options,
        ["leagueId", "membershipId", "expectedVersion", "nowMs"],
        "An exact league commissioner update is required."
      );
      return freezeRow(
        leagues.updateVersioned({
          key: stableId(options.leagueId),
          expectedVersion: positiveInteger(options.expectedVersion),
          changes: {
            commissioner_membership_id: stableId(options.membershipId),
            updated_at_ms: safeTimestamp(options.nowMs),
          },
        })
      );
    },
    acceptInvitation(options) {
      exactObject(
        options,
        ["leagueId", "assignmentId", "expectedVersion", "nowMs"],
        "An exact commissioner invitation acceptance is required."
      );
      return freezeRow(
        invitations.updateVersioned({
          key: stableId(options.assignmentId),
          leagueId: stableId(options.leagueId),
          expectedVersion: positiveInteger(options.expectedVersion),
          changes: {
            status: "accepted",
            accepted_at_ms: safeTimestamp(options.nowMs),
          },
        })
      );
    },
    cancelInvitation(options) {
      exactObject(
        options,
        ["leagueId", "assignmentId", "expectedVersion"],
        "An exact commissioner invitation cancellation is required."
      );
      return freezeRow(
        invitations.updateVersioned({
          key: stableId(options.assignmentId),
          leagueId: stableId(options.leagueId),
          expectedVersion: positiveInteger(options.expectedVersion),
          changes: { status: "cancelled" },
        })
      );
    },
    findIdempotency,
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
        ["id", "leagueId", "assignmentId", "completedAtMs"],
        "An exact commissioner idempotency completion is required."
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
            "The idempotency record cannot be completed."
          );
        }
        return freezeRow(findIdempotencyById.get({ id: parameters.id }));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeCommissionerAssignmentIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },
  });
}

module.exports = {
  IDEMPOTENCY_COLUMNS,
  createSqliteCommissionerAssignmentRepository,
};
