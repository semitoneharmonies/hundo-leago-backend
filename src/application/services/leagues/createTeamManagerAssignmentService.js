const crypto = require("node:crypto");

const {
  UUID_PATTERN,
  validateDecisionInput,
  validateExpectedVersion,
  validateIdempotencyKey,
  validateProposalInput,
  validateRemovalInput,
  validateStableId,
} = require(
  "../../../domain/leagues/teamManagerAssignmentPolicy"
);

const OPERATIONS = Object.freeze({
  accept: "league.team_manager_assignment.accept.v1",
  decline: "league.team_manager_assignment.decline.v1",
  propose: "league.team_manager_assignment.propose.v1",
  remove: "league.team_manager_assignment.remove.v1",
});
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_CONSTRAINT = "REPOSITORY_CONSTRAINT";

class TeamManagerAssignmentNotFoundError extends Error {
  constructor() {
    super("The team-manager assignment was not found.");
    this.name = "TeamManagerAssignmentNotFoundError";
    this.code = "TEAM_MANAGER_ASSIGNMENT_NOT_FOUND";
  }
}

class TeamManagerAssignmentConflictError extends Error {
  constructor(code = "TEAM_MANAGER_ASSIGNMENT_CONFLICT", details = null) {
    super("The team-manager assignment cannot be changed in its current state.");
    this.name = "TeamManagerAssignmentConflictError";
    this.code = code;
    if (details) this.details = Object.freeze({ ...details });
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`team-manager assignment requires ${description}`);
  }
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError(
      "team-manager assignment requires a safe UTC timestamp"
    );
  }
  return nowMs;
}

function commandHash(operation, values) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ operation, ...values }), "utf8")
    .digest("hex");
}

function safeAssignment(row, code) {
  if (!row) {
    throw new TeamManagerAssignmentConflictError(
      "TEAM_MANAGER_ASSIGNMENT_RESULT_UNAVAILABLE"
    );
  }
  return Object.freeze({
    code,
    assignment: Object.freeze({
      id: row.assignment_id,
      status: row.assignment_status,
      assignedAtMs: row.assigned_at_ms,
      acceptedAtMs: row.accepted_at_ms,
      endedAtMs: row.ended_at_ms,
      assignedByUserId: row.assigned_by_user_id,
      replacesAssignmentId: row.replaces_assignment_id,
      version: row.assignment_version,
    }),
    league: Object.freeze({
      id: row.league_id,
      name: row.league_name,
      status: row.league_status,
      version: row.league_version,
    }),
    team: Object.freeze({
      id: row.team_id,
      name: row.team_name,
      status: row.team_status,
      version: row.team_version,
      currentManager:
        row.current_assignment_id === null
          ? null
          : Object.freeze({
              assignmentId: row.current_assignment_id,
              userId: row.current_manager_user_id,
              displayName: row.current_manager_display_name,
              version: row.current_assignment_version,
            }),
    }),
    proposedUser: Object.freeze({
      id: row.proposed_user_id,
      displayName: row.proposed_user_display_name,
    }),
    membership: Object.freeze({
      id: row.membership_id,
      permissionCategory: row.permission_category,
      status: row.membership_status,
      version: row.membership_version,
    }),
    replacedManager:
      row.replaces_assignment_id === null
        ? null
        : Object.freeze({
            assignmentId: row.replaces_assignment_id,
            userId: row.replaced_manager_user_id,
            displayName: row.replaced_manager_display_name,
            status: row.replaced_assignment_status,
            version: row.replaced_assignment_version,
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
    request_correlation_id: audit.requestCorrelationId || null,
    reason_code: null,
    network_key_version: audit.networkKeyVersion || null,
    network_metadata_digest: audit.networkMetadataDigest || null,
    client_metadata_json: audit.clientMetadataJson || null,
    unknown_account_digest: null,
    occurred_at_ms: nowMs,
  };
}

function createTeamManagerAssignmentService({
  repositoryContext,
  leagueAuthorization,
  userRepository,
  assignmentRepository,
  auditRepository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(repositoryContext, "transaction", "a transaction boundary");
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league commissioner authorization"
  );
  assertMethod(userRepository, "findById", "a user repository");
  for (const method of [
    "acceptAssignment",
    "appendAssignmentActivity",
    "completeIdempotency",
    "declineAssignment",
    "endAssignment",
    "findActiveMembershipForUser",
    "findAssignmentAggregate",
    "findCurrentAssignment",
    "findIdempotency",
    "findPendingAssignment",
    "findTeam",
    "insertPendingAssignment",
    "insertProposalNotification",
    "insertStartedIdempotency",
  ]) {
    assertMethod(
      assignmentRepository,
      method,
      "a team-manager assignment repository"
    );
  }
  assertMethod(auditRepository, "append", "a Security Audit repository");
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function requireActiveUser(authenticated) {
    const userId = authenticated?.user?.id;
    if (
      authenticated?.valid !== true ||
      !UUID_PATTERN.test(userId || "") ||
      authenticated?.session?.userId !== userId
    ) {
      throw new TeamManagerAssignmentNotFoundError();
    }
    const user = userRepository.findById(userId);
    if (!user || user.status !== "active") {
      throw new TeamManagerAssignmentNotFoundError();
    }
    return user;
  }

  function requireOwnedAssignment(assignmentId, authenticated) {
    const user = requireActiveUser(authenticated);
    const row = assignmentRepository.findAssignmentAggregate(assignmentId);
    if (
      !row ||
      row.proposed_user_id !== user.id ||
      row.membership_user_id !== user.id ||
      row.membership_status !== "active" ||
      !["manager", "commissioner"].includes(row.permission_category)
    ) {
      throw new TeamManagerAssignmentNotFoundError();
    }
    return { row, user };
  }

  function assertOperable(row) {
    if (
      !row ||
      !["setup", "active", "frozen"].includes(row.league_status) ||
      !["setup", "active"].includes(row.status || row.team_status)
    ) {
      throw new TeamManagerAssignmentConflictError();
    }
    return row;
  }

  function findReplay({ actorUserId, operation, clientKey, digest, leagueId }) {
    const existing = assignmentRepository.findIdempotency({
      actorUserId,
      operation,
      clientKey,
    });
    if (!existing) return null;
    if (
      existing.league_id !== leagueId ||
      existing.request_hash !== digest
    ) {
      throw new TeamManagerAssignmentConflictError("IDEMPOTENCY_KEY_REUSED");
    }
    if (
      existing.status !== "completed" ||
      existing.result_type !== "team_manager_assignment" ||
      !existing.result_id
    ) {
      throw new TeamManagerAssignmentConflictError(
        "IDEMPOTENCY_REQUEST_UNAVAILABLE"
      );
    }
    return assignmentRepository.findAssignmentAggregate(existing.result_id);
  }

  function startIdempotency({ id, leagueId, actorUserId, operation, clientKey, digest, nowMs }) {
    assignmentRepository.insertStartedIdempotency({
      id,
      leagueId,
      actorUserId,
      operation,
      clientKey,
      requestHash: digest,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
    });
  }

  function completeIdempotency({ id, leagueId, assignmentId, nowMs }) {
    assignmentRepository.completeIdempotency({
      id,
      leagueId,
      assignmentId,
      completedAtMs: nowMs,
    });
  }

  function activityMetadata(row, status) {
    return JSON.stringify({
      assignmentId: row.assignment_id,
      status,
      teamId: row.team_id,
      replacesAssignmentId: row.replaces_assignment_id,
    });
  }

  function propose({
    leagueId,
    teamId,
    input,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const canonicalTeamId = validateStableId(teamId);
    const proposal = validateProposalInput(input);
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const digest = commandHash(OPERATIONS.propose, {
      leagueId: canonicalLeagueId,
      teamId: canonicalTeamId,
      userId: proposal.userId,
    });
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureRandom.id(),
      assignment: secureRandom.id(),
      audit: secureRandom.id(),
      idempotency: secureRandom.id(),
      notification: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority = leagueAuthorization.requireCommissioner(
          authenticated,
          canonicalLeagueId
        );
        const replay = findReplay({
          actorUserId: authority.actorUserId,
          operation: OPERATIONS.propose,
          clientKey,
          digest,
          leagueId: canonicalLeagueId,
        });
        if (replay) {
          return internalResult(
            safeAssignment(replay, "TEAM_MANAGER_ASSIGNMENT_PROPOSED"),
            true
          );
        }
        const team = assertOperable(
          assignmentRepository.findTeam({
            leagueId: canonicalLeagueId,
            teamId: canonicalTeamId,
          })
        );
        const proposedUser = userRepository.findById(proposal.userId);
        const membership = assignmentRepository.findActiveMembershipForUser({
          leagueId: canonicalLeagueId,
          userId: proposal.userId,
        });
        const current = assignmentRepository.findCurrentAssignment({
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
        });
        if (
          !proposedUser ||
          proposedUser.status !== "active" ||
          !membership ||
          !["manager", "commissioner"].includes(
            membership.permission_category
          ) ||
          current?.user_id === proposedUser.id ||
          assignmentRepository.findPendingAssignment({
            leagueId: canonicalLeagueId,
            teamId: canonicalTeamId,
          })
        ) {
          throw new TeamManagerAssignmentConflictError();
        }

        startIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation: OPERATIONS.propose,
          clientKey,
          digest,
          nowMs,
        });
        assignmentRepository.insertPendingAssignment({
          id: ids.assignment,
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
          userId: proposedUser.id,
          membershipId: membership.id,
          assignedByUserId: authority.actorUserId,
          replacesAssignmentId: current?.id || null,
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
            leagueName: team.league_name,
            teamId: canonicalTeamId,
            teamName: team.name,
          }),
          nowMs,
        });
        const row = assignmentRepository.findAssignmentAggregate(ids.assignment);
        assignmentRepository.appendAssignmentActivity({
          id: ids.activity,
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
          actorUserId: authority.actorUserId,
          actorAuthority: "commissioner",
          eventType: "team_manager_assignment_proposed",
          assignmentId: ids.assignment,
          displaySummary: `${proposedUser.display_name} was proposed to manage ${team.name}.`,
          metadataJson: activityMetadata(row, "pending"),
          nowMs,
        });
        auditRepository.append(auditRecord({
          id: ids.audit,
          eventType: "team_manager_assignment.proposed",
          audit,
          nowMs,
          actorUserId: authority.actorUserId,
          targetUserId: proposedUser.id,
          leagueId: canonicalLeagueId,
          sessionId: authenticated.session.id,
        }));
        completeIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          assignmentId: ids.assignment,
          nowMs,
        });
        return internalResult(
          safeAssignment(
            assignmentRepository.findAssignmentAggregate(ids.assignment),
            "TEAM_MANAGER_ASSIGNMENT_PROPOSED"
          ),
          false
        );
      });
    } catch (error) {
      return rethrow(error);
    }
  }

  function read({ assignmentId, authenticated } = {}) {
    const canonicalAssignmentId = validateStableId(assignmentId);
    const { row } = requireOwnedAssignment(canonicalAssignmentId, authenticated);
    return safeAssignment(row, "TEAM_MANAGER_ASSIGNMENT_FOUND");
  }

  function decide(action, {
    assignmentId,
    input,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalAssignmentId = validateStableId(assignmentId);
    validateDecisionInput(input);
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const operation = OPERATIONS[action];
    const digest = commandHash(operation, {
      assignmentId: canonicalAssignmentId,
    });
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureRandom.id(),
      audit: secureRandom.id(),
      idempotency: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const { row, user } = requireOwnedAssignment(
          canonicalAssignmentId,
          authenticated
        );
        const terminalStatus = action === "accept" ? "accepted" : "declined";
        if (row.assignment_status === terminalStatus) {
          return internalResult(
            safeAssignment(
              row,
              action === "accept"
                ? "TEAM_MANAGER_ASSIGNMENT_ACCEPTED"
                : "TEAM_MANAGER_ASSIGNMENT_DECLINED"
            ),
            true
          );
        }
        const replay = findReplay({
          actorUserId: user.id,
          operation,
          clientKey,
          digest,
          leagueId: row.league_id,
        });
        if (replay) {
          return internalResult(
            safeAssignment(
              replay,
              action === "accept"
                ? "TEAM_MANAGER_ASSIGNMENT_ACCEPTED"
                : "TEAM_MANAGER_ASSIGNMENT_DECLINED"
            ),
            true
          );
        }
        assertOperable(row);
        if (
          row.assignment_status !== "pending" ||
          row.proposed_user_status !== "active" ||
          row.membership_status !== "active"
        ) {
          throw new TeamManagerAssignmentConflictError();
        }
        const current = assignmentRepository.findCurrentAssignment({
          leagueId: row.league_id,
          teamId: row.team_id,
        });
        if (
          action === "accept" &&
          (row.replaces_assignment_id === null
            ? current !== null
            : !current || current.id !== row.replaces_assignment_id)
        ) {
          throw new TeamManagerAssignmentConflictError(
            "TEAM_MANAGER_TRANSFER_STALE"
          );
        }

        startIdempotency({
          id: ids.idempotency,
          leagueId: row.league_id,
          actorUserId: user.id,
          operation,
          clientKey,
          digest,
          nowMs,
        });
        if (action === "accept") {
          if (current) {
            assignmentRepository.endAssignment({
              leagueId: row.league_id,
              assignmentId: current.id,
              expectedVersion: current.version,
              nowMs,
            });
          }
          assignmentRepository.acceptAssignment({
            leagueId: row.league_id,
            assignmentId: row.assignment_id,
            expectedVersion: row.assignment_version,
            nowMs,
          });
        } else {
          assignmentRepository.declineAssignment({
            leagueId: row.league_id,
            assignmentId: row.assignment_id,
            expectedVersion: row.assignment_version,
          });
        }
        assignmentRepository.appendAssignmentActivity({
          id: ids.activity,
          leagueId: row.league_id,
          teamId: row.team_id,
          actorUserId: user.id,
          actorAuthority: "proposed_manager",
          eventType: `team_manager_assignment_${terminalStatus}`,
          assignmentId: row.assignment_id,
          displaySummary: `${user.display_name} ${terminalStatus} the manager assignment for ${row.team_name}.`,
          metadataJson: activityMetadata(row, terminalStatus),
          nowMs,
        });
        auditRepository.append(auditRecord({
          id: ids.audit,
          eventType: `team_manager_assignment.${terminalStatus}`,
          audit,
          nowMs,
          actorUserId: user.id,
          targetUserId: user.id,
          leagueId: row.league_id,
          sessionId: authenticated.session.id,
        }));
        completeIdempotency({
          id: ids.idempotency,
          leagueId: row.league_id,
          assignmentId: row.assignment_id,
          nowMs,
        });
        return internalResult(
          safeAssignment(
            assignmentRepository.findAssignmentAggregate(row.assignment_id),
            action === "accept"
              ? "TEAM_MANAGER_ASSIGNMENT_ACCEPTED"
              : "TEAM_MANAGER_ASSIGNMENT_DECLINED"
          ),
          false
        );
      });
    } catch (error) {
      return rethrow(error);
    }
  }

  function remove({
    leagueId,
    teamId,
    input,
    expectedVersion,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const canonicalTeamId = validateStableId(teamId);
    const removal = validateRemovalInput(input);
    const version = validateExpectedVersion(expectedVersion);
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const digest = commandHash(OPERATIONS.remove, {
      assignmentId: removal.assignmentId,
      expectedVersion: version,
      leagueId: canonicalLeagueId,
      teamId: canonicalTeamId,
    });
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureRandom.id(),
      audit: secureRandom.id(),
      idempotency: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority = leagueAuthorization.requireCommissioner(
          authenticated,
          canonicalLeagueId
        );
        const replay = findReplay({
          actorUserId: authority.actorUserId,
          operation: OPERATIONS.remove,
          clientKey,
          digest,
          leagueId: canonicalLeagueId,
        });
        if (replay) {
          return internalResult(
            safeAssignment(replay, "TEAM_MANAGER_ASSIGNMENT_REMOVED"),
            true
          );
        }
        const team = assertOperable(assignmentRepository.findTeam({
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
        }));
        const current = assignmentRepository.findCurrentAssignment({
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
        });
        if (
          !current || current.id !== removal.assignmentId ||
          current.version !== version
        ) {
          throw new TeamManagerAssignmentConflictError(
            "TEAM_MANAGER_ASSIGNMENT_PRECONDITION_FAILED",
            {
              currentVersion: current?.version ?? null,
              refetch: true,
            }
          );
        }
        const row = assignmentRepository.findAssignmentAggregate(current.id);
        startIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation: OPERATIONS.remove,
          clientKey,
          digest,
          nowMs,
        });
        assignmentRepository.endAssignment({
          leagueId: canonicalLeagueId,
          assignmentId: current.id,
          expectedVersion: version,
          nowMs,
        });
        assignmentRepository.appendAssignmentActivity({
          id: ids.activity,
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
          actorUserId: authority.actorUserId,
          actorAuthority: "commissioner",
          eventType: "team_manager_assignment_removed",
          assignmentId: current.id,
          displaySummary: `The manager assignment for ${team.name} was removed.`,
          metadataJson: activityMetadata(row, "ended"),
          nowMs,
        });
        auditRepository.append(auditRecord({
          id: ids.audit,
          eventType: "team_manager_assignment.removed",
          audit,
          nowMs,
          actorUserId: authority.actorUserId,
          targetUserId: row.proposed_user_id,
          leagueId: canonicalLeagueId,
          sessionId: authenticated.session.id,
        }));
        completeIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          assignmentId: current.id,
          nowMs,
        });
        return internalResult(
          safeAssignment(
            assignmentRepository.findAssignmentAggregate(current.id),
            "TEAM_MANAGER_ASSIGNMENT_REMOVED"
          ),
          false
        );
      });
    } catch (error) {
      return rethrow(error);
    }
  }

  function rethrow(error) {
    const domain = [error, error?.cause].find(
      (candidate) =>
        candidate instanceof TeamManagerAssignmentNotFoundError ||
        candidate instanceof TeamManagerAssignmentConflictError
    );
    if (domain) throw domain;
    const authorization = [error, error?.cause].find((candidate) =>
      ["LEAGUE_NOT_FOUND", "LEAGUE_COMMISSIONER_REQUIRED"].includes(
        candidate?.code
      )
    );
    if (authorization) throw authorization;
    const repositoryConstraint = [error, error?.cause].find(
      (candidate) => candidate?.code === REPOSITORY_CONSTRAINT
    );
    if (repositoryConstraint) {
      throw new TeamManagerAssignmentConflictError(
        repositoryConstraint?.details?.tableName === "idempotency_requests"
          ? "IDEMPOTENCY_REQUEST_UNAVAILABLE"
          : "TEAM_MANAGER_ASSIGNMENT_CONFLICT"
      );
    }
    throw error;
  }

  return Object.freeze({
    accept: (command) => decide("accept", command),
    decline: (command) => decide("decline", command),
    propose,
    read,
    remove,
  });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  OPERATIONS,
  TeamManagerAssignmentConflictError,
  TeamManagerAssignmentNotFoundError,
  commandHash,
  createTeamManagerAssignmentService,
  safeAssignment,
};
