const crypto = require("node:crypto");

const {
  validateIdempotencyKey,
  validateStableId,
  validateTeamCreationInput,
} = require("../../../domain/leagues/teamPolicy");
const { safeTeam } = require("./createTeamReadService");

const TEAM_CREATION_OPERATION = "league.team.create.v1";
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_CONSTRAINT = "REPOSITORY_CONSTRAINT";

class TeamCreationConflictError extends Error {
  constructor(code = "TEAM_CREATION_CONFLICT", options = {}) {
    super("The team cannot be created in the current league state.", options);
    this.name = "TeamCreationConflictError";
    this.code = code;
  }
}

class TeamCreationIdempotencyError extends Error {
  constructor(code = "IDEMPOTENCY_KEY_REUSED") {
    super("The idempotency key cannot be used for this team request.");
    this.name = "TeamCreationIdempotencyError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`team creation requires ${description}`);
  }
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("team creation requires a safe UTC timestamp");
  }
  return nowMs;
}

function requestHash({ leagueId, team }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId,
        nameNormalized: team.nameNormalized,
        operation: TEAM_CREATION_OPERATION,
      }),
      "utf8"
    )
    .digest("hex");
}

function internalResult(row, replayed) {
  if (!row) {
    throw new TeamCreationIdempotencyError(
      "TEAM_CREATION_RESULT_UNAVAILABLE"
    );
  }
  const result = {
    code: "TEAM_CREATED",
    team: safeTeam(row),
  };
  Object.defineProperty(result, "replayed", {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false,
  });
  return Object.freeze(result);
}

function createTeamCreationService({
  repositoryContext,
  leagueAuthorization,
  teamCreationRepository,
  teamReadRepository,
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
  for (const method of [
    "appendCreationActivity",
    "completeIdempotency",
    "findIdempotency",
    "findLeagueContext",
    "findTeamByNormalizedName",
    "insertSetupTeam",
    "insertStartedIdempotency",
  ]) {
    assertMethod(
      teamCreationRepository,
      method,
      "a team-creation repository"
    );
  }
  assertMethod(teamReadRepository, "findTeam", "a team read repository");
  assertMethod(auditRepository, "append", "a Security Audit repository");
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function create({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const teamInput = validateTeamCreationInput(input);
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const digest = requestHash({
      leagueId: canonicalLeagueId,
      team: teamInput,
    });
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureRandom.id(),
      audit: secureRandom.id(),
      idempotency: secureRandom.id(),
      team: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority = leagueAuthorization.requireCommissioner(
          authenticated,
          canonicalLeagueId
        );
        const existing = teamCreationRepository.findIdempotency({
          actorUserId: authority.actorUserId,
          operation: TEAM_CREATION_OPERATION,
          clientKey,
        });
        if (existing) {
          if (
            existing.league_id !== canonicalLeagueId ||
            existing.request_hash !== digest
          ) {
            throw new TeamCreationIdempotencyError();
          }
          if (
            existing.status !== "completed" ||
            existing.result_type !== "team" ||
            !existing.result_id
          ) {
            throw new TeamCreationIdempotencyError(
              "IDEMPOTENCY_REQUEST_UNAVAILABLE"
            );
          }
          return internalResult(
            teamReadRepository.findTeam({
              leagueId: canonicalLeagueId,
              teamId: existing.result_id,
            }),
            true
          );
        }

        const league =
          teamCreationRepository.findLeagueContext(canonicalLeagueId);
        if (!league || league.league_status !== "setup") {
          throw new TeamCreationConflictError(
            "TEAM_CREATION_NOT_ALLOWED"
          );
        }
        if (
          !Number.isSafeInteger(league.maximum_teams) ||
          !Number.isSafeInteger(league.current_team_count) ||
          league.current_team_count >= league.maximum_teams
        ) {
          throw new TeamCreationConflictError("TEAM_LIMIT_REACHED");
        }
        if (
          teamCreationRepository.findTeamByNormalizedName({
            leagueId: canonicalLeagueId,
            nameNormalized: teamInput.nameNormalized,
          })
        ) {
          throw new TeamCreationConflictError("TEAM_NAME_UNAVAILABLE");
        }

        teamCreationRepository.insertStartedIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation: TEAM_CREATION_OPERATION,
          clientKey,
          requestHash: digest,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
        });
        teamCreationRepository.insertSetupTeam({
          id: ids.team,
          leagueId: canonicalLeagueId,
          name: teamInput.name,
          nameNormalized: teamInput.nameNormalized,
          nowMs,
        });
        teamCreationRepository.appendCreationActivity({
          id: ids.activity,
          leagueId: canonicalLeagueId,
          teamId: ids.team,
          actorUserId: authority.actorUserId,
          displaySummary: `${teamInput.name} was created in Setup.`,
          metadataJson: JSON.stringify({
            teamId: ids.team,
            status: "setup",
          }),
          nowMs,
        });
        auditRepository.append({
          id: ids.audit,
          event_type: "team.created",
          outcome: "success",
          actor_user_id: authority.actorUserId,
          target_user_id: null,
          league_id: canonicalLeagueId,
          session_id: authenticated.session.id,
          request_correlation_id: audit.requestCorrelationId || null,
          reason_code: null,
          network_key_version: audit.networkKeyVersion || null,
          network_metadata_digest: audit.networkMetadataDigest || null,
          client_metadata_json: audit.clientMetadataJson || null,
          unknown_account_digest: null,
          occurred_at_ms: nowMs,
        });
        teamCreationRepository.completeIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          teamId: ids.team,
          completedAtMs: nowMs,
        });
        return internalResult(
          teamReadRepository.findTeam({
            leagueId: canonicalLeagueId,
            teamId: ids.team,
          }),
          false
        );
      });
    } catch (error) {
      const domainError = [error, error?.cause].find(
        (candidate) =>
          candidate instanceof TeamCreationConflictError ||
          candidate instanceof TeamCreationIdempotencyError
      );
      if (domainError) throw domainError;
      const authorizationError = [error, error?.cause].find((candidate) =>
        [
          "LEAGUE_NOT_FOUND",
          "LEAGUE_COMMISSIONER_REQUIRED",
        ].includes(candidate?.code)
      );
      if (authorizationError) throw authorizationError;
      const constraintError = [error, error?.cause].find(
        (candidate) => candidate?.code === REPOSITORY_CONSTRAINT
      );
      if (constraintError) {
        if (constraintError?.details?.tableName === "teams") {
          throw new TeamCreationConflictError(
            "TEAM_NAME_UNAVAILABLE",
            { cause: constraintError }
          );
        }
        if (
          constraintError?.details?.tableName ===
          "idempotency_requests"
        ) {
          throw new TeamCreationIdempotencyError(
            "IDEMPOTENCY_REQUEST_UNAVAILABLE"
          );
        }
      }
      throw error;
    }
  }

  return Object.freeze({ create });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  TEAM_CREATION_OPERATION,
  TeamCreationConflictError,
  TeamCreationIdempotencyError,
  createTeamCreationService,
  requestHash,
};
