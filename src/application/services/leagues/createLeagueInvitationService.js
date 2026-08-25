const crypto = require("node:crypto");

const {
  UUID_PATTERN,
  validateAcceptanceInput,
  validateDeclineInput,
  validateIdempotencyKey,
  validateInvitationInput,
  validateStableId,
} = require("../../../domain/leagues/leagueInvitationPolicy");

const INVITATION_OPERATION = "league.invitation.create.v1";
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_CONSTRAINT = "REPOSITORY_CONSTRAINT";

class LeagueInvitationNotFoundError extends Error {
  constructor() {
    super("The league invitation was not found.");
    this.name = "LeagueInvitationNotFoundError";
    this.code = "LEAGUE_INVITATION_NOT_FOUND";
  }
}

class LeagueInvitationConflictError extends Error {
  constructor(code = "LEAGUE_INVITATION_CONFLICT") {
    super("The league invitation cannot be changed in its current state.");
    this.name = "LeagueInvitationConflictError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league invitation requires ${description}`);
  }
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError(
      "league invitation requires a safe UTC timestamp"
    );
  }
  return nowMs;
}

function invitationRequestHash({ leagueId, invitation }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId,
        operation: INVITATION_OPERATION,
        teamId: invitation.teamId,
        userId: invitation.userId,
        workflow: invitation.workflow,
      }),
      "utf8"
    )
    .digest("hex");
}

function invitationStatus(row) {
  if (row.invitation_status === "cancelled") return "declined";
  return row.invitation_status;
}

function safeInvitation(row, code) {
  if (!row) {
    throw new LeagueInvitationConflictError(
      "LEAGUE_INVITATION_RESULT_UNAVAILABLE"
    );
  }
  return Object.freeze({
    code,
    invitation: Object.freeze({
      id: row.invitation_id,
      status: invitationStatus(row),
      workflow: row.workflow,
      invitedAtMs: row.invited_at_ms,
      acceptedAtMs: row.accepted_at_ms,
      version: row.invitation_version,
    }),
    league: Object.freeze({
      id: row.league_id,
      name: row.league_name,
      status: row.league_status,
      version: row.league_version,
    }),
    invitedUser: Object.freeze({
      id: row.invited_user_id,
      displayName: row.invited_user_display_name,
    }),
    membership: Object.freeze({
      id: row.membership_id,
      permissionCategory: row.permission_category,
      status: row.membership_status,
      joinedAtMs: row.joined_at_ms,
      version: row.membership_version,
    }),
    team:
      row.team_id === null
        ? null
        : Object.freeze({
            id: row.team_id,
            name: row.team_name,
            status: row.team_status,
            primaryColour: row.primary_colour,
            secondaryColour: row.secondary_colour,
            logoReference: row.logo_reference,
            version: row.team_version,
          }),
    managerAssignment:
      row.manager_assignment_id === null
        ? null
        : Object.freeze({
            id: row.manager_assignment_id,
            status: row.manager_assignment_status,
            assignedAtMs: row.manager_assigned_at_ms,
            acceptedAtMs: row.manager_accepted_at_ms,
            version: row.manager_assignment_version,
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

function createLeagueInvitationService({
  repositoryContext,
  leagueAuthorization,
  userRepository,
  invitationRepository,
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
    leagueAuthorization,
    "requireCommissioner",
    "league commissioner authorization"
  );
  assertMethod(userRepository, "findById", "a user repository");
  for (const method of [
    "acceptInvitation",
    "activateMembership",
    "appendManagerAssignmentChangedPublication",
    "appendMembershipChangedPublication",
    "appendInvitationActivity",
    "cancelInvitation",
    "completeIdempotency",
    "endNeverActiveMembership",
    "findActiveMembershipForUser",
    "findIdempotency",
    "findInvitationAggregate",
    "findLeagueContext",
    "findPendingTeamInvitation",
    "findTeam",
    "insertAcceptedManagerAssignment",
    "insertInvitation",
    "insertInvitationNotification",
    "insertInvitedManagerMembership",
    "insertSetupTeam",
    "insertStartedIdempotency",
  ]) {
    assertMethod(
      invitationRepository,
      method,
      "a league-invitation repository"
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
      throw new LeagueInvitationNotFoundError();
    }
    const current = userRepository.findById(userId);
    if (!current || current.status !== "active") {
      throw new LeagueInvitationNotFoundError();
    }
    return current;
  }

  function requireOwnedInvitation(invitationId, authenticated) {
    const user = requireActiveUser(authenticated);
    const row = invitationRepository.findInvitationAggregate(invitationId);
    if (
      !row ||
      row.invited_user_id !== user.id ||
      row.permission_category !== "manager" ||
      !["create_team", "manage_team"].includes(row.workflow)
    ) {
      throw new LeagueInvitationNotFoundError();
    }
    return { row, user };
  }

  function invite({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const invitation = validateInvitationInput(input);
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const requestHash = invitationRequestHash({
      leagueId: canonicalLeagueId,
      invitation,
    });
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureRandom.id(),
      audit: secureRandom.id(),
      idempotency: secureRandom.id(),
      invitation: secureRandom.id(),
      membership: secureRandom.id(),
      notification: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority = leagueAuthorization.requireCommissioner(
          authenticated,
          canonicalLeagueId
        );
        const existing = invitationRepository.findIdempotency({
          actorUserId: authority.actorUserId,
          operation: INVITATION_OPERATION,
          clientKey,
        });
        if (existing) {
          if (
            existing.request_hash !== requestHash ||
            existing.league_id !== canonicalLeagueId
          ) {
            throw new LeagueInvitationConflictError(
              "IDEMPOTENCY_KEY_REUSED"
            );
          }
          if (
            existing.status !== "completed" ||
            existing.result_type !== "league_invitation" ||
            !existing.result_id
          ) {
            throw new LeagueInvitationConflictError(
              "IDEMPOTENCY_REQUEST_UNAVAILABLE"
            );
          }
          return internalResult(
            safeInvitation(
              invitationRepository.findInvitationAggregate(
                existing.result_id
              ),
              "LEAGUE_INVITATION_CREATED"
            ),
            true
          );
        }

        const league = invitationRepository.findLeagueContext(
          canonicalLeagueId
        );
        const invitedUser = userRepository.findById(invitation.userId);
        const activeMembership =
          invitationRepository.findActiveMembershipForUser({
            leagueId: canonicalLeagueId,
            userId: invitation.userId,
          });
        let team = null;
        if (invitation.workflow === "manage_team") {
          team = invitationRepository.findTeam({
            leagueId: canonicalLeagueId,
            teamId: invitation.teamId,
          });
        }
        const workflowAllowed =
          invitation.workflow === "create_team"
            ? league?.league_status === "setup"
            : ["setup", "active"].includes(league?.league_status);
        if (
          !league ||
          !workflowAllowed ||
          !invitedUser ||
          invitedUser.status !== "active" ||
          activeMembership ||
          (invitation.workflow === "create_team" &&
            league.current_team_count >= league.maximum_teams) ||
          (invitation.workflow === "manage_team" &&
            (!team ||
              !["setup", "active"].includes(team.status) ||
              team.current_manager_assignment_id !== null ||
              invitationRepository.findPendingTeamInvitation({
                leagueId: canonicalLeagueId,
                teamId: invitation.teamId,
              })))
        ) {
          throw new LeagueInvitationConflictError();
        }

        invitationRepository.insertStartedIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation: INVITATION_OPERATION,
          clientKey,
          requestHash,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
        });
        invitationRepository.insertInvitedManagerMembership({
          id: ids.membership,
          leagueId: canonicalLeagueId,
          userId: invitedUser.id,
          nowMs,
        });
        invitationRepository.insertInvitation({
          id: ids.invitation,
          leagueId: canonicalLeagueId,
          invitedEmailNormalized: invitedUser.email_normalized,
          invitedUserId: invitedUser.id,
          invitingUserId: authority.actorUserId,
          membershipId: ids.membership,
          workflow: invitation.workflow,
          teamId: invitation.teamId,
          nowMs,
        });
        invitationRepository.insertInvitationNotification({
          id: ids.notification,
          userId: invitedUser.id,
          leagueId: canonicalLeagueId,
          invitationId: ids.invitation,
          messageDataJson: JSON.stringify({
            invitationId: ids.invitation,
            leagueId: canonicalLeagueId,
            leagueName: league.league_name,
            workflow: invitation.workflow,
            teamId: invitation.teamId,
          }),
          nowMs,
        });
        invitationRepository.appendInvitationActivity({
          id: ids.activity,
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          actorAuthority: "commissioner",
          eventType: "league_invitation_created",
          invitationId: ids.invitation,
          teamId: invitation.teamId,
          displaySummary: `${invitedUser.display_name} was invited to join ${league.league_name}.`,
          metadataJson: JSON.stringify({
            invitationId: ids.invitation,
            status: "pending",
            workflow: invitation.workflow,
            teamId: invitation.teamId,
          }),
          nowMs,
        });
        auditRepository.append(
          auditRecord({
            id: ids.audit,
            eventType: "league_invitation.created",
            audit,
            nowMs,
            actorUserId: authority.actorUserId,
            targetUserId: invitedUser.id,
            leagueId: canonicalLeagueId,
            sessionId: authenticated.session.id,
          })
        );
        invitationRepository.completeIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          invitationId: ids.invitation,
          completedAtMs: nowMs,
        });
        return internalResult(
          safeInvitation(
            invitationRepository.findInvitationAggregate(ids.invitation),
            "LEAGUE_INVITATION_CREATED"
          ),
          false
        );
      });
    } catch (error) {
      const cause = error?.cause || error;
      const constraint =
        error?.code === REPOSITORY_CONSTRAINT
          ? error
          : cause?.code === REPOSITORY_CONSTRAINT
            ? cause
            : null;
      if (
        [
          "LEAGUE_COMMISSIONER_REQUIRED",
          "LEAGUE_NOT_FOUND",
        ].includes(cause?.code) ||
        cause instanceof LeagueInvitationConflictError
      ) {
        throw cause;
      }
      if (constraint) {
        if (constraint.details?.tableName === "idempotency_requests") {
          throw new LeagueInvitationConflictError(
            "IDEMPOTENCY_REQUEST_UNAVAILABLE"
          );
        }
        if (
          [
            "league_invitations",
            "league_memberships",
            "notifications",
          ].includes(constraint.details?.tableName)
        ) {
          throw new LeagueInvitationConflictError();
        }
      }
      throw error;
    }
  }

  function read({ invitationId, authenticated } = {}) {
    const canonicalInvitationId = validateStableId(invitationId);
    const { row } = requireOwnedInvitation(
      canonicalInvitationId,
      authenticated
    );
    return safeInvitation(row, "LEAGUE_INVITATION_FOUND");
  }

  function accept({
    invitationId,
    input,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalInvitationId = validateStableId(invitationId);
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureRandom.id(),
      assignment: secureRandom.id(),
      audit: secureRandom.id(),
      managerAssignmentPublication: secureRandom.id(),
      membershipPublication: secureRandom.id(),
      team: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const { row, user } = requireOwnedInvitation(
          canonicalInvitationId,
          authenticated
        );
        const acceptance = validateAcceptanceInput(input, row.workflow);
        if (
          row.invitation_status === "accepted" &&
          row.membership_status === "active" &&
          row.joined_at_ms !== null &&
          row.team_id !== null &&
          row.manager_assignment_status === "accepted"
        ) {
          if (
            row.workflow === "create_team" &&
            acceptance.teamNameNormalized !== row.team_name_normalized
          ) {
            throw new LeagueInvitationConflictError();
          }
          return internalResult(
            safeInvitation(row, "LEAGUE_INVITATION_ACCEPTED"),
            true
          );
        }
        const activeMembership =
          invitationRepository.findActiveMembershipForUser({
            leagueId: row.league_id,
            userId: user.id,
          });
        const league = invitationRepository.findLeagueContext(row.league_id);
        let teamId = row.invited_team_id;
        let team = null;
        if (row.workflow === "manage_team") {
          team = invitationRepository.findTeam({
            leagueId: row.league_id,
            teamId,
          });
        }
        const workflowAllowed =
          row.workflow === "create_team"
            ? league?.league_status === "setup"
            : ["setup", "active"].includes(league?.league_status);
        if (
          row.invitation_status !== "pending" ||
          row.membership_status !== "invited" ||
          row.joined_at_ms !== null ||
          row.invited_user_status !== "active" ||
          !league ||
          !workflowAllowed ||
          activeMembership ||
          (row.workflow === "create_team" &&
            league.current_team_count >= league.maximum_teams) ||
          (row.workflow === "manage_team" &&
            (!team ||
              !["setup", "active"].includes(team.status) ||
              team.current_manager_assignment_id !== null ||
              invitationRepository.findPendingTeamInvitation({
                leagueId: row.league_id,
                teamId,
              })?.id !== row.invitation_id))
        ) {
          throw new LeagueInvitationConflictError();
        }

        if (row.workflow === "create_team") {
          teamId = ids.team;
          invitationRepository.insertSetupTeam({
            id: teamId,
            leagueId: row.league_id,
            name: acceptance.teamName,
            nameNormalized: acceptance.teamNameNormalized,
            nowMs,
          });
        }
        const membership = invitationRepository.activateMembership({
          leagueId: row.league_id,
          membershipId: row.membership_id,
          expectedVersion: row.membership_version,
          nowMs,
        });
        const managerAssignment =
          invitationRepository.insertAcceptedManagerAssignment({
            id: ids.assignment,
            leagueId: row.league_id,
            teamId,
            userId: user.id,
            membershipId: row.membership_id,
            assignedByUserId: row.inviting_user_id,
            nowMs,
          });
        invitationRepository.acceptInvitation({
          leagueId: row.league_id,
          invitationId: row.invitation_id,
          teamId,
          expectedVersion: row.invitation_version,
          nowMs,
        });
        invitationRepository.appendMembershipChangedPublication({
          id: ids.membershipPublication,
          leagueId: row.league_id,
          membershipId: membership.id,
          version: membership.version,
          nowMs,
        });
        invitationRepository.appendManagerAssignmentChangedPublication({
          id: ids.managerAssignmentPublication,
          leagueId: row.league_id,
          teamId,
          assignmentId: managerAssignment.id,
          version: managerAssignment.version,
          nowMs,
        });
        invitationRepository.appendInvitationActivity({
          id: ids.activity,
          leagueId: row.league_id,
          actorUserId: user.id,
          actorAuthority: "invited_manager",
          eventType: "league_invitation_accepted",
          invitationId: row.invitation_id,
          teamId,
          displaySummary: `${user.display_name} accepted the league invitation.`,
          metadataJson: JSON.stringify({
            invitationId: row.invitation_id,
            status: "accepted",
            workflow: row.workflow,
            teamId,
          }),
          nowMs,
        });
        auditRepository.append(
          auditRecord({
            id: ids.audit,
            eventType: "league_invitation.accepted",
            audit,
            nowMs,
            actorUserId: user.id,
            targetUserId: user.id,
            leagueId: row.league_id,
            sessionId: authenticated.session.id,
          })
        );
        return internalResult(
          safeInvitation(
            invitationRepository.findInvitationAggregate(
              canonicalInvitationId
            ),
            "LEAGUE_INVITATION_ACCEPTED"
          ),
          false
        );
      });
    } catch (error) {
      const cause = error?.cause || error;
      const constraint =
        error?.code === REPOSITORY_CONSTRAINT
          ? error
          : cause?.code === REPOSITORY_CONSTRAINT
            ? cause
            : null;
      if (
        cause instanceof LeagueInvitationNotFoundError ||
        cause instanceof LeagueInvitationConflictError ||
        cause?.code === "LEAGUE_INVITATION_INPUT_INVALID"
      ) {
        throw cause;
      }
      if (
        constraint &&
        [
          "league_invitations",
          "league_memberships",
          "team_manager_assignments",
          "teams",
        ].includes(constraint.details?.tableName)
      ) {
        throw new LeagueInvitationConflictError();
      }
      throw error;
    }
  }

  function decline({
    invitationId,
    input,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalInvitationId = validateStableId(invitationId);
    validateDeclineInput(input);
    const nowMs = safeNow(clock);
    const activityId = secureRandom.id();
    const auditId = secureRandom.id();
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const { row, user } = requireOwnedInvitation(
          canonicalInvitationId,
          authenticated
        );
        if (
          row.invitation_status === "cancelled" &&
          row.membership_status === "ended" &&
          row.joined_at_ms === null &&
          row.manager_assignment_id === null
        ) {
          return internalResult(
            safeInvitation(row, "LEAGUE_INVITATION_DECLINED"),
            true
          );
        }
        if (
          row.invitation_status !== "pending" ||
          row.membership_status !== "invited" ||
          row.joined_at_ms !== null ||
          row.invited_user_status !== "active" ||
          row.manager_assignment_id !== null
        ) {
          throw new LeagueInvitationConflictError();
        }
        invitationRepository.endNeverActiveMembership({
          leagueId: row.league_id,
          membershipId: row.membership_id,
          expectedVersion: row.membership_version,
          nowMs,
        });
        invitationRepository.cancelInvitation({
          leagueId: row.league_id,
          invitationId: row.invitation_id,
          expectedVersion: row.invitation_version,
        });
        invitationRepository.appendInvitationActivity({
          id: activityId,
          leagueId: row.league_id,
          actorUserId: user.id,
          actorAuthority: "invited_manager",
          eventType: "league_invitation_declined",
          invitationId: row.invitation_id,
          teamId: row.invited_team_id,
          displaySummary: `${user.display_name} declined the league invitation.`,
          metadataJson: JSON.stringify({
            invitationId: row.invitation_id,
            status: "declined",
            workflow: row.workflow,
            teamId: row.invited_team_id,
          }),
          nowMs,
        });
        auditRepository.append(
          auditRecord({
            id: auditId,
            eventType: "league_invitation.declined",
            audit,
            nowMs,
            actorUserId: user.id,
            targetUserId: user.id,
            leagueId: row.league_id,
            sessionId: authenticated.session.id,
          })
        );
        return internalResult(
          safeInvitation(
            invitationRepository.findInvitationAggregate(
              canonicalInvitationId
            ),
            "LEAGUE_INVITATION_DECLINED"
          ),
          false
        );
      });
    } catch (error) {
      const cause = error?.cause || error;
      if (
        cause instanceof LeagueInvitationNotFoundError ||
        cause instanceof LeagueInvitationConflictError
      ) {
        throw cause;
      }
      throw error;
    }
  }

  return Object.freeze({ accept, decline, invite, read });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  INVITATION_OPERATION,
  LeagueInvitationConflictError,
  LeagueInvitationNotFoundError,
  createLeagueInvitationService,
  invitationRequestHash,
  safeInvitation,
};
