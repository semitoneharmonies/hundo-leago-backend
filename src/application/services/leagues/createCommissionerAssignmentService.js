const crypto = require("node:crypto");

const {
  UUID_PATTERN,
  validateDecisionInput,
  validateIdempotencyKey,
  validateProposalInput,
  validateStableId,
} = require(
  "../../../domain/leagues/commissionerAssignmentPolicy"
);

const PROPOSAL_OPERATION =
  "admin.commissioner_assignment.propose.v1";
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_CONSTRAINT = "REPOSITORY_CONSTRAINT";

class CommissionerAssignmentNotFoundError extends Error {
  constructor() {
    super("The commissioner assignment was not found.");
    this.name = "CommissionerAssignmentNotFoundError";
    this.code = "COMMISSIONER_ASSIGNMENT_NOT_FOUND";
  }
}

class CommissionerAssignmentConflictError extends Error {
  constructor(code = "COMMISSIONER_ASSIGNMENT_CONFLICT") {
    super("The commissioner assignment cannot be changed in its current state.");
    this.name = "CommissionerAssignmentConflictError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `commissioner assignment requires ${description}`
    );
  }
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError(
      "commissioner assignment requires a safe UTC timestamp"
    );
  }
  return nowMs;
}

function proposalRequestHash({ leagueId, userId }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId,
        operation: PROPOSAL_OPERATION,
        userId,
      }),
      "utf8"
    )
    .digest("hex");
}

function assignmentStatus(row) {
  if (row.assignment_status === "accepted") return "accepted";
  if (row.assignment_status === "cancelled") return "declined";
  return row.assignment_status;
}

function safeAssignment(row, code) {
  if (!row) {
    throw new CommissionerAssignmentConflictError(
      "COMMISSIONER_ASSIGNMENT_RESULT_UNAVAILABLE"
    );
  }
  return Object.freeze({
    code,
    assignment: Object.freeze({
      id: row.assignment_id,
      status: assignmentStatus(row),
      proposedAtMs: row.proposed_at_ms,
      acceptedAtMs: row.accepted_at_ms,
      proposedByUserId: row.proposed_by_user_id,
      version: row.assignment_version,
    }),
    league: Object.freeze({
      id: row.league_id,
      name: row.league_name,
      status: row.league_status,
      commissionerMembershipId:
        row.commissioner_membership_id,
      version: row.league_version,
    }),
    proposedUser: Object.freeze({
      id: row.proposed_user_id,
      displayName: row.proposed_user_display_name,
    }),
    membership: Object.freeze({
      id: row.membership_id,
      permissionCategory: row.permission_category,
      status: row.membership_status,
      joinedAtMs: row.joined_at_ms,
      version: row.membership_version,
    }),
  });
}

function internalResult(result, replayed) {
  const copy = { ...result };
  Object.defineProperty(copy, "replayed", {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false,
  });
  return Object.freeze(copy);
}

function auditRecord({
  id,
  eventType,
  audit,
  nowMs,
  actorUserId,
  targetUserId,
  leagueId,
  sessionId,
}) {
  return {
    id,
    event_type: eventType,
    outcome: "success",
    actor_user_id: actorUserId,
    target_user_id: targetUserId,
    league_id: leagueId,
    session_id: sessionId,
    request_correlation_id:
      audit.requestCorrelationId || null,
    reason_code: null,
    network_key_version:
      audit.networkKeyVersion || null,
    network_metadata_digest:
      audit.networkMetadataDigest || null,
    client_metadata_json:
      audit.clientMetadataJson || null,
    unknown_account_digest: null,
    occurred_at_ms: nowMs,
  };
}

function createCommissionerAssignmentService({
  repositoryContext,
  platformAuthorization,
  userRepository,
  assignmentRepository,
  auditRepository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    repositoryContext,
    "transaction",
    "a repository transaction boundary"
  );
  assertMethod(
    platformAuthorization,
    "requireAdministrator",
    "platform authorization"
  );
  assertMethod(userRepository, "findById", "a user repository");
  for (const method of [
    "acceptInvitation",
    "activateMembership",
    "appendAssignmentActivity",
    "appendCommissionerAssignmentChangedPublication",
    "appendMembershipChangedPublication",
    "cancelInvitation",
    "completeIdempotency",
    "endNeverActiveMembership",
    "findAssignmentAggregate",
    "findActiveCommissionerMembership",
    "findActiveMembershipForUser",
    "findIdempotency",
    "findLeagueById",
    "findPendingCommissionerAssignment",
    "insertCommissionerInvitation",
    "insertInvitedCommissionerMembership",
    "insertProposalNotification",
    "insertStartedIdempotency",
    "setLeagueCommissioner",
  ]) {
    assertMethod(
      assignmentRepository,
      method,
      "a commissioner-assignment repository"
    );
  }
  assertMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function requireActiveUser(authenticated) {
    const userId = authenticated?.user?.id;
    if (
      authenticated?.valid !== true ||
      !UUID_PATTERN.test(userId || "") ||
      authenticated?.session?.userId !== userId
    ) {
      throw new CommissionerAssignmentNotFoundError();
    }
    const current = userRepository.findById(userId);
    if (!current || current.status !== "active") {
      throw new CommissionerAssignmentNotFoundError();
    }
    return current;
  }

  function requireOwnedAssignment(assignmentId, authenticated) {
    const user = requireActiveUser(authenticated);
    const row = assignmentRepository.findAssignmentAggregate(
      assignmentId
    );
    if (
      !row ||
      row.proposed_user_id !== user.id ||
      row.permission_category !== "commissioner"
    ) {
      throw new CommissionerAssignmentNotFoundError();
    }
    return { row, user };
  }

  function propose({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const proposal = validateProposalInput(input);
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const digest = proposalRequestHash({
      leagueId: canonicalLeagueId,
      userId: proposal.userId,
    });
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureRandom.id(),
      assignment: secureRandom.id(),
      audit: secureRandom.id(),
      idempotency: secureRandom.id(),
      membership: secureRandom.id(),
      notification: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority =
          platformAuthorization.requireAdministrator(authenticated);
        const existing = assignmentRepository.findIdempotency({
          actorUserId: authority.actorUserId,
          operation: PROPOSAL_OPERATION,
          clientKey,
        });
        if (existing) {
          if (
            existing.request_hash !== digest ||
            existing.league_id !== canonicalLeagueId
          ) {
            throw new CommissionerAssignmentConflictError(
              "IDEMPOTENCY_KEY_REUSED"
            );
          }
          if (
            existing.status !== "completed" ||
            existing.result_type !== "commissioner_assignment" ||
            !existing.result_id
          ) {
            throw new CommissionerAssignmentConflictError(
              "IDEMPOTENCY_REQUEST_UNAVAILABLE"
            );
          }
          return internalResult(
            safeAssignment(
              assignmentRepository.findAssignmentAggregate(
                existing.result_id
              ),
              "COMMISSIONER_ASSIGNMENT_PROPOSED"
            ),
            true
          );
        }

        const league = assignmentRepository.findLeagueById(
          canonicalLeagueId
        );
        const proposedUser = userRepository.findById(proposal.userId);
        if (
          !league ||
          league.status !== "setup" ||
          league.commissioner_membership_id !== null ||
          !proposedUser ||
          proposedUser.status !== "active" ||
          assignmentRepository.findActiveCommissionerMembership(
            canonicalLeagueId
          ) ||
          assignmentRepository.findActiveMembershipForUser({
            leagueId: canonicalLeagueId,
            userId: proposedUser.id,
          }) ||
          assignmentRepository.findPendingCommissionerAssignment(
            canonicalLeagueId
          )
        ) {
          throw new CommissionerAssignmentConflictError();
        }

        assignmentRepository.insertStartedIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation: PROPOSAL_OPERATION,
          clientKey,
          requestHash: digest,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
        });
        assignmentRepository.insertInvitedCommissionerMembership({
          id: ids.membership,
          leagueId: canonicalLeagueId,
          userId: proposedUser.id,
          nowMs,
        });
        assignmentRepository.insertCommissionerInvitation({
          id: ids.assignment,
          leagueId: canonicalLeagueId,
          invitedEmailNormalized: proposedUser.email_normalized,
          invitedUserId: proposedUser.id,
          invitingUserId: authority.actorUserId,
          membershipId: ids.membership,
          nowMs,
        });
        assignmentRepository.insertProposalNotification({
          id: ids.notification,
          userId: proposedUser.id,
          leagueId: canonicalLeagueId,
          assignmentId: ids.assignment,
          messageDataJson: JSON.stringify({
            assignmentId: ids.assignment,
            leagueId: canonicalLeagueId,
            leagueName: league.name,
          }),
          nowMs,
        });
        assignmentRepository.appendAssignmentActivity({
          id: ids.activity,
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          actorAuthority: "platform_administrator",
          eventType: "commissioner_assignment_proposed",
          assignmentId: ids.assignment,
          displaySummary: `${proposedUser.display_name} was proposed as commissioner.`,
          metadataJson: JSON.stringify({
            assignmentId: ids.assignment,
            status: "pending",
          }),
          nowMs,
        });
        auditRepository.append(
          auditRecord({
            id: ids.audit,
            eventType:
              "platform_administration.commissioner_assignment_proposed",
            audit,
            nowMs,
            actorUserId: authority.actorUserId,
            targetUserId: proposedUser.id,
            leagueId: canonicalLeagueId,
            sessionId: authenticated.session.id,
          })
        );
        assignmentRepository.completeIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          assignmentId: ids.assignment,
          completedAtMs: nowMs,
        });
        return internalResult(
          safeAssignment(
            assignmentRepository.findAssignmentAggregate(
              ids.assignment
            ),
            "COMMISSIONER_ASSIGNMENT_PROPOSED"
          ),
          false
        );
      });
    } catch (error) {
      const cause = error?.cause || error;
      if (
        cause?.code === "PLATFORM_ADMINISTRATOR_REQUIRED" ||
        cause instanceof CommissionerAssignmentConflictError
      ) {
        throw cause;
      }
      if (cause?.code === REPOSITORY_CONSTRAINT) {
        if (cause?.details?.tableName === "idempotency_requests") {
          throw new CommissionerAssignmentConflictError(
            "IDEMPOTENCY_REQUEST_UNAVAILABLE"
          );
        }
        if (
          [
            "league_invitations",
            "league_memberships",
            "notifications",
          ].includes(cause?.details?.tableName)
        ) {
          throw new CommissionerAssignmentConflictError();
        }
      }
      throw error;
    }
  }

  function read({ assignmentId, authenticated } = {}) {
    const canonicalAssignmentId = validateStableId(assignmentId);
    const { row } = requireOwnedAssignment(
      canonicalAssignmentId,
      authenticated
    );
    return safeAssignment(row, "COMMISSIONER_ASSIGNMENT_FOUND");
  }

  function accept({
    assignmentId,
    input,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalAssignmentId = validateStableId(assignmentId);
    validateDecisionInput(input);
    const nowMs = safeNow(clock);
    const activityId = secureRandom.id();
    const auditId = secureRandom.id();
    const commissionerAssignmentPublicationId = secureRandom.id();
    const membershipPublicationId = secureRandom.id();
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const { row, user } = requireOwnedAssignment(
        canonicalAssignmentId,
        authenticated
      );
      if (
        row.assignment_status === "accepted" &&
        row.membership_status === "active" &&
        row.joined_at_ms !== null &&
        row.commissioner_membership_id === row.membership_id
      ) {
        return internalResult(
          safeAssignment(
            row,
            "COMMISSIONER_ASSIGNMENT_ACCEPTED"
          ),
          true
        );
      }
      if (
        row.assignment_status !== "pending" ||
        row.membership_status !== "invited" ||
        row.joined_at_ms !== null ||
        row.league_status !== "setup" ||
        row.commissioner_membership_id !== null ||
        row.proposed_user_status !== "active" ||
        assignmentRepository.findActiveCommissionerMembership(
          row.league_id
        ) ||
        assignmentRepository.findActiveMembershipForUser({
          leagueId: row.league_id,
          userId: user.id,
        })
      ) {
        throw new CommissionerAssignmentConflictError();
      }

      const membership = assignmentRepository.activateMembership({
        leagueId: row.league_id,
        membershipId: row.membership_id,
        expectedVersion: row.membership_version,
        nowMs,
      });
      assignmentRepository.setLeagueCommissioner({
        leagueId: row.league_id,
        membershipId: row.membership_id,
        expectedVersion: row.league_version,
        nowMs,
      });
      const assignment = assignmentRepository.acceptInvitation({
        leagueId: row.league_id,
        assignmentId: row.assignment_id,
        expectedVersion: row.assignment_version,
        nowMs,
      });
      assignmentRepository.appendMembershipChangedPublication({
        id: membershipPublicationId,
        leagueId: row.league_id,
        membershipId: membership.id,
        version: membership.version,
        nowMs,
      });
      assignmentRepository.appendCommissionerAssignmentChangedPublication({
        id: commissionerAssignmentPublicationId,
        leagueId: row.league_id,
        assignmentId: assignment.id,
        version: assignment.version,
        nowMs,
      });
      assignmentRepository.appendAssignmentActivity({
        id: activityId,
        leagueId: row.league_id,
        actorUserId: user.id,
        actorAuthority: "proposed_commissioner",
        eventType: "commissioner_assignment_accepted",
        assignmentId: row.assignment_id,
        displaySummary: `${user.display_name} accepted the commissioner assignment.`,
        metadataJson: JSON.stringify({
          assignmentId: row.assignment_id,
          status: "accepted",
        }),
        nowMs,
      });
      auditRepository.append(
        auditRecord({
          id: auditId,
          eventType: "commissioner_assignment.accepted",
          audit,
          nowMs,
          actorUserId: user.id,
          targetUserId: user.id,
          leagueId: row.league_id,
          sessionId: authenticated.session.id,
        })
      );
        return internalResult(
          safeAssignment(
            assignmentRepository.findAssignmentAggregate(
              canonicalAssignmentId
            ),
            "COMMISSIONER_ASSIGNMENT_ACCEPTED"
          ),
          false
        );
      });
    } catch (error) {
      const cause = error?.cause || error;
      if (
        cause instanceof CommissionerAssignmentNotFoundError ||
        cause instanceof CommissionerAssignmentConflictError
      ) {
        throw cause;
      }
      throw error;
    }
  }

  function decline({
    assignmentId,
    input,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalAssignmentId = validateStableId(assignmentId);
    validateDecisionInput(input);
    const nowMs = safeNow(clock);
    const activityId = secureRandom.id();
    const auditId = secureRandom.id();
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const { row, user } = requireOwnedAssignment(
        canonicalAssignmentId,
        authenticated
      );
      if (
        row.assignment_status === "cancelled" &&
        row.membership_status === "ended" &&
        row.joined_at_ms === null &&
        row.commissioner_membership_id === null
      ) {
        return internalResult(
          safeAssignment(
            row,
            "COMMISSIONER_ASSIGNMENT_DECLINED"
          ),
          true
        );
      }
      if (
        row.assignment_status !== "pending" ||
        row.membership_status !== "invited" ||
        row.joined_at_ms !== null ||
        row.league_status !== "setup" ||
        row.commissioner_membership_id !== null ||
        row.proposed_user_status !== "active"
      ) {
        throw new CommissionerAssignmentConflictError();
      }

      assignmentRepository.endNeverActiveMembership({
        leagueId: row.league_id,
        membershipId: row.membership_id,
        expectedVersion: row.membership_version,
        nowMs,
      });
      assignmentRepository.cancelInvitation({
        leagueId: row.league_id,
        assignmentId: row.assignment_id,
        expectedVersion: row.assignment_version,
      });
      assignmentRepository.appendAssignmentActivity({
        id: activityId,
        leagueId: row.league_id,
        actorUserId: user.id,
        actorAuthority: "proposed_commissioner",
        eventType: "commissioner_assignment_declined",
        assignmentId: row.assignment_id,
        displaySummary: `${user.display_name} declined the commissioner assignment.`,
        metadataJson: JSON.stringify({
          assignmentId: row.assignment_id,
          status: "declined",
        }),
        nowMs,
      });
      auditRepository.append(
        auditRecord({
          id: auditId,
          eventType: "commissioner_assignment.declined",
          audit,
          nowMs,
          actorUserId: user.id,
          targetUserId: user.id,
          leagueId: row.league_id,
          sessionId: authenticated.session.id,
        })
      );
        return internalResult(
          safeAssignment(
            assignmentRepository.findAssignmentAggregate(
              canonicalAssignmentId
            ),
            "COMMISSIONER_ASSIGNMENT_DECLINED"
          ),
          false
        );
      });
    } catch (error) {
      const cause = error?.cause || error;
      if (
        cause instanceof CommissionerAssignmentNotFoundError ||
        cause instanceof CommissionerAssignmentConflictError
      ) {
        throw cause;
      }
      throw error;
    }
  }

  return Object.freeze({ accept, decline, propose, read });
}

module.exports = {
  CommissionerAssignmentConflictError,
  CommissionerAssignmentNotFoundError,
  IDEMPOTENCY_LIFETIME_MS,
  PROPOSAL_OPERATION,
  createCommissionerAssignmentService,
  proposalRequestHash,
  safeAssignment,
};
