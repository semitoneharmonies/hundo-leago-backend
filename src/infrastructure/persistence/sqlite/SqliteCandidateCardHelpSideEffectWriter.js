const crypto = require("node:crypto");

const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
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
  isPlainObject,
} = require("./createSqliteRecordRepository");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");
const {
  createSqliteSecurityAuditRepository,
} = require("./SqliteSecurityAuditRepository");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEYS = Object.freeze([
  "actor",
  "expiresAtMs",
  "helpRequestId",
  "kind",
  "managerAssignmentId",
  "requestedAtMs",
  "scope",
]);
const SCOPE_KEYS = Object.freeze([
  "cardId",
  "fadId",
  "leagueId",
  "seasonId",
  "teamId",
]);
const ACTOR_KEYS = Object.freeze([
  "authority",
  "membershipId",
  "userId",
]);

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function incompatible(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message
  );
}

function exactObject(value, keys, description) {
  if (!isPlainObject(value)) {
    invalid(`An exact ${description} is required.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`An exact ${description} is required.`);
  }
  return value;
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} identifier is required.`);
  }
  return value;
}

function safeTimestamp(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function canonicalDisplayName(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    incompatible(
      "The Candidate Card help requester display evidence is invalid."
    );
  }
  return value;
}

function deterministicUuid(namespace) {
  const bytes = Buffer.from(
    crypto.createHash("sha256").update(namespace).digest().subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `${hex.slice(12, 16)}-${hex.slice(16, 20)}-` +
    hex.slice(20)
  );
}

function normalizeInput(input) {
  exactObject(
    input,
    INPUT_KEYS,
    "Candidate Card help side-effect input"
  );
  if (input.kind !== "candidate_card_help_requested") {
    invalid("A supported Candidate Card help side effect is required.");
  }
  const scope = exactObject(
    input.scope,
    SCOPE_KEYS,
    "Candidate Card help side-effect scope"
  );
  const actor = exactObject(
    input.actor,
    ACTOR_KEYS,
    "Candidate Card help side-effect actor"
  );
  if (actor.authority !== "manager") {
    invalid("Candidate Card help must be requested by a manager.");
  }
  const requestedAtMs = safeTimestamp(
    input.requestedAtMs,
    "Candidate Card help request timestamp"
  );
  const expiresAtMs = safeTimestamp(
    input.expiresAtMs,
    "Candidate Card help expiry timestamp"
  );
  if (requestedAtMs >= expiresAtMs) {
    invalid("Candidate Card help must expire after it is requested.");
  }
  return Object.freeze({
    kind: input.kind,
    scope: Object.freeze({
      leagueId: canonicalId(scope.leagueId, "league"),
      seasonId: canonicalId(scope.seasonId, "season"),
      fadId: canonicalId(scope.fadId, "Free Agent Draft"),
      cardId: canonicalId(scope.cardId, "Candidate Card"),
      teamId: canonicalId(scope.teamId, "team"),
    }),
    actor: Object.freeze({
      userId: canonicalId(actor.userId, "requesting user"),
      membershipId: canonicalId(
        actor.membershipId,
        "requesting membership"
      ),
      authority: "manager",
    }),
    managerAssignmentId: canonicalId(
      input.managerAssignmentId,
      "manager assignment"
    ),
    helpRequestId: canonicalId(
      input.helpRequestId,
      "Candidate Card help request"
    ),
    requestedAtMs,
    expiresAtMs,
  });
}

function uniqueRow(statement, parameters, description) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(`${description} was not unique.`);
  }
  return rows[0] || null;
}

function assertSynchronous(value, description) {
  if (value && typeof value.then === "function") {
    incompatible(`${description} must be synchronous.`);
  }
  return value;
}

function resolveAuditRepository(database, auditRepository) {
  if (auditRepository === undefined) {
    return createSqliteSecurityAuditRepository({ database });
  }
  if (
    !auditRepository ||
    typeof auditRepository.append !== "function"
  ) {
    invalid("A synchronous Candidate Card help audit repository is required.");
  }
  return auditRepository;
}

function createSqliteCandidateCardHelpSideEffectWriter({
  database,
  auditRepository,
  notificationWriter,
  leagueOutboxWriter,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateCardHelpSideEffectWriter requires an opened database"
    );
  }

  let audit;
  let notifications;
  let outbox;
  let requestEvidenceStatement;
  let commissionerStatement;
  let administratorStatement;
  try {
    audit = resolveAuditRepository(database, auditRepository);
    notifications = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    requestEvidenceStatement = database.prepare(`
      SELECT
        requester.display_name AS requesting_display_name,
        help.version AS help_version
      FROM candidate_card_help_requests AS help
      JOIN team_manager_assignments AS assignment
        ON assignment.league_id = help.league_id
       AND assignment.id = @managerAssignmentId
       AND assignment.team_id = help.team_id
       AND assignment.user_id = @actorUserId
       AND assignment.membership_id = @actorMembershipId
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.ended_at_ms IS NULL
      JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
       AND membership.status = 'active'
       AND membership.ended_at_ms IS NULL
      JOIN users AS requester
        ON requester.id = assignment.user_id
       AND requester.status = 'active'
      WHERE help.league_id = @leagueId
        AND help.season_id = @seasonId
        AND help.fad_id = @fadId
        AND help.card_id = @cardId
        AND help.team_id = @teamId
        AND help.id = @helpRequestId
        AND help.status = 'active'
        AND help.requested_by_user_id = @actorUserId
        AND help.requested_by_membership_id = @actorMembershipId
        AND help.requested_at_ms = @requestedAtMs
        AND help.expires_at_ms = @expiresAtMs
      LIMIT 2
    `);
    commissionerStatement = database.prepare(`
      SELECT membership.user_id
      FROM leagues AS league
      JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = league.commissioner_membership_id
      JOIN users AS user
        ON user.id = membership.user_id
      WHERE league.id = @leagueId
        AND membership.status = 'active'
        AND membership.permission_category = 'commissioner'
        AND membership.ended_at_ms IS NULL
        AND user.status = 'active'
      LIMIT 2
    `);
    administratorStatement = database.prepare(`
      SELECT DISTINCT role.user_id
      FROM platform_roles AS role
      JOIN users AS user
        ON user.id = role.user_id
      JOIN league_memberships AS membership
        ON membership.league_id = @leagueId
       AND membership.user_id = role.user_id
      WHERE role.role = 'platform_administrator'
        AND role.status = 'active'
        AND role.ended_at_ms IS NULL
        AND user.status = 'active'
        AND membership.status = 'active'
        AND membership.ended_at_ms IS NULL
      ORDER BY role.user_id
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareCandidateCardHelpSideEffectWriter",
      tableName: "candidate_card_help_requests",
    });
  }

  const writeTransaction = database.transaction((command) => {
    const evidence = uniqueRow(
      requestEvidenceStatement,
      {
        ...command.scope,
        managerAssignmentId: command.managerAssignmentId,
        helpRequestId: command.helpRequestId,
        actorUserId: command.actor.userId,
        actorMembershipId: command.actor.membershipId,
        requestedAtMs: command.requestedAtMs,
        expiresAtMs: command.expiresAtMs,
      },
      "The authoritative Candidate Card help request"
    );
    if (!evidence) {
      incompatible(
        "The authoritative Candidate Card help request evidence is unavailable."
      );
    }
    const requestingDisplayName = canonicalDisplayName(
      evidence.requesting_display_name
    );
    if (
      !Number.isSafeInteger(evidence.help_version) ||
      evidence.help_version < 1
    ) {
      incompatible("The Candidate Card help request version is invalid.");
    }

    const recipientIds = new Set();
    const commissioner = uniqueRow(
      commissionerStatement,
      { leagueId: command.scope.leagueId },
      "The current Candidate Card commissioner recipient"
    );
    if (commissioner) {
      recipientIds.add(
        canonicalId(
          commissioner.user_id,
          "Candidate Card commissioner recipient"
        )
      );
    }
    for (const row of administratorStatement.all({
      leagueId: command.scope.leagueId,
    })) {
      recipientIds.add(
        canonicalId(
          row.user_id,
          "Candidate Card administrator recipient"
        )
      );
    }
    const orderedRecipientIds = [...recipientIds].sort();

    const auditResult = assertSynchronous(
      audit.append({
        id: deterministicUuid(
          `candidate-card-help:audit:${command.helpRequestId}`
        ),
        event_type: "fad.candidate_card_help_requested",
        outcome: "success",
        actor_user_id: command.actor.userId,
        target_user_id: null,
        league_id: command.scope.leagueId,
        session_id: null,
        request_correlation_id: null,
        reason_code: "candidate_card_help_requested",
        network_key_version: null,
        network_metadata_digest: null,
        client_metadata_json: null,
        unknown_account_digest: null,
        occurred_at_ms: command.requestedAtMs,
      }),
      "Candidate Card help audit insertion"
    );

    const notificationResults = [];
    for (const userId of orderedRecipientIds) {
      const notificationId = deterministicUuid(
        `candidate-card-help:notification:${command.helpRequestId}:${userId}`
      );
      const notificationContract =
        createFreeAgentDraftNotificationContract({
          type: "fad_help_requested",
          recipientUserId: userId,
          messageData: {
            leagueId: command.scope.leagueId,
            seasonId: command.scope.seasonId,
            fadId: command.scope.fadId,
            teamId: command.scope.teamId,
            cardId: command.scope.cardId,
            helpRequestId: command.helpRequestId,
            requestingUserId: command.actor.userId,
            requestingDisplayName,
            destination: {
              kind: "private_card",
              leagueId: command.scope.leagueId,
              fadId: command.scope.fadId,
              teamId: command.scope.teamId,
              cardId: command.scope.cardId,
            },
          },
        });
      notificationResults.push(
        assertSynchronous(
          notifications.insert({
            id: notificationId,
            userId: notificationContract.recipientUserId,
            leagueId: command.scope.leagueId,
            eventType: notificationContract.type,
            messageDataJson: JSON.stringify(
              notificationContract.messageData
            ),
            relatedFeature: "candidate_card_help",
            relatedRecordId: command.helpRequestId,
            deliveryStatus: "pending",
            createdAtMs: command.requestedAtMs,
            deliveredAtMs: null,
            deduplicationKey:
              notificationContract.deduplicationKey,
          }),
          "Candidate Card help notification insertion"
        )
      );
      assertSynchronous(
        outbox.write({
          id: deterministicUuid(
            `candidate-card-help:notification-outbox:${command.helpRequestId}:${userId}`
          ),
          leagueId: command.scope.leagueId,
          eventType: "notification.created",
          aggregateType: "notification",
          aggregateId: notificationId,
          payload: createSocketEventMetadata({
            eventType: "notification.created",
            version: 1,
            reasonCode: "notification_created",
            occurredAtMs: command.requestedAtMs,
            related: createEmptySocketRelated({
              fadId: command.scope.fadId,
              teamId: command.scope.teamId,
              cardId: command.scope.cardId,
            }),
          }),
          occurredAtMs: command.requestedAtMs,
          audiences: [{ kind: "user", userId }],
        }),
        "Candidate Card help notification outbox insertion"
      );
    }

    const audiences = [
      Object.freeze({
        kind: "team",
        teamId: command.scope.teamId,
      }),
      ...orderedRecipientIds.map((userId) =>
        Object.freeze({ kind: "user", userId })
      ),
    ];
    const outboxResult = assertSynchronous(
      outbox.write({
        id: command.helpRequestId,
        leagueId: command.scope.leagueId,
        eventType: "candidate_card_help.changed",
        aggregateType: "candidate_card_help",
        aggregateId: command.helpRequestId,
        payload: createSocketEventMetadata({
          eventType: "candidate_card_help.changed",
          version: evidence.help_version,
          reasonCode: "help_changed",
          occurredAtMs: command.requestedAtMs,
          related: createEmptySocketRelated({
            fadId: command.scope.fadId,
            teamId: command.scope.teamId,
            cardId: command.scope.cardId,
          }),
        }),
        occurredAtMs: command.requestedAtMs,
        audiences,
      }),
      "Candidate Card help outbox insertion"
    );

    return Object.freeze({
      audit: auditResult,
      notifications: Object.freeze(notificationResults),
      outbox: outboxResult,
    });
  });

  return function writeCandidateCardHelpSideEffects(input) {
    const command = normalizeInput(input);
    try {
      return writeTransaction.immediate(command);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "writeCandidateCardHelpSideEffects",
        tableName: "candidate_card_help_requests",
      });
    }
  };
}

module.exports = {
  createSqliteCandidateCardHelpSideEffectWriter,
};
