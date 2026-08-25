const crypto = require("node:crypto");

const {
  validateIdempotencyKey,
  validateStableId,
} = require("../../../domain/leagues/teamPolicy");
const {
  TeamProfilePolicyError,
  validateExpectedVersion,
  validateTeamProfileInput,
} = require("../../../domain/leagues/teamProfilePolicy");
const {
  DEFAULT_THREE_TEAM_PATTERN,
  DEFAULT_TWO_TEAM_PATTERN,
  teamPatternColourCount,
} = require("../../../domain/leagues/teamPatternPolicy");
const { safeTeam } = require("./createTeamReadService");

const TEAM_PROFILE_OPERATION = "league.team.profile.update.v1";
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_CONSTRAINT = "REPOSITORY_CONSTRAINT";
const REPOSITORY_VERSION_CONFLICT = "REPOSITORY_VERSION_CONFLICT";

class TeamProfileConflictError extends Error {
  constructor(code = "TEAM_PROFILE_CONFLICT", details = null, options = {}) {
    super("The team profile cannot be changed in its current state.", options);
    this.name = "TeamProfileConflictError";
    this.code = code;
    if (details) this.details = Object.freeze({ ...details });
  }
}

class TeamProfileNotFoundError extends Error {
  constructor(code = "TEAM_NOT_FOUND") {
    super("The team profile was not found.");
    this.name = "TeamProfileNotFoundError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`team profile requires ${description}`);
  }
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("team profile requires a safe UTC timestamp");
  }
  return nowMs;
}

function profileRequestHash({ leagueId, teamId, expectedVersion, profile }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        operation: TEAM_PROFILE_OPERATION,
        leagueId,
        teamId,
        expectedVersion,
        ...(profile.hasName
          ? {
              name: profile.name.name,
              nameNormalized: profile.name.nameNormalized,
            }
          : {}),
        ...(profile.hasPatternTemplate
          ? { patternTemplate: profile.patternTemplate }
          : {}),
        ...(profile.colours
          ? {
              primaryColour: profile.colours.primaryColour,
              secondaryColour: profile.colours.secondaryColour,
              tertiaryColour: profile.colours.tertiaryColour,
            }
          : {}),
        ...(profile.hasLogo
          ? {
              logo:
                profile.logo === null
                  ? null
                  : {
                      mediaType: profile.logo.mediaType,
                      byteLength: profile.logo.byteLength,
                      width: profile.logo.width,
                      height: profile.logo.height,
                      contentSha256: profile.logo.contentSha256,
                    },
            }
          : {}),
      }),
      "utf8"
    )
    .digest("hex");
}

function withLogoDigest(profile) {
  if (!profile.logo) return profile;
  return Object.freeze({
    ...profile,
    logo: Object.freeze({
      ...profile.logo,
      contentSha256: crypto
        .createHash("sha256")
        .update(profile.logo.bytes)
        .digest("hex"),
    }),
  });
}

function internalResult(row, replayed) {
  if (!row) {
    throw new TeamProfileConflictError(
      "TEAM_PROFILE_RESULT_UNAVAILABLE"
    );
  }
  const result = {
    code: "TEAM_PROFILE_UPDATED",
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

function auditRecord({ id, audit, nowMs, authority, authenticated, leagueId }) {
  return {
    id,
    event_type: "team.profile_updated",
    outcome: "success",
    actor_user_id: authority.actorUserId,
    target_user_id: null,
    league_id: leagueId,
    session_id: authenticated.session.id,
    request_correlation_id: audit.requestCorrelationId || null,
    reason_code: null,
    network_key_version: audit.networkKeyVersion || null,
    network_metadata_digest: audit.networkMetadataDigest || null,
    client_metadata_json: audit.clientMetadataJson || null,
    unknown_account_digest: null,
    occurred_at_ms: nowMs,
  };
}

function createTeamProfileService({
  repositoryContext,
  leagueAuthorization,
  teamAuthorization,
  teamProfileRepository,
  teamReadRepository,
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
  for (const method of ["requireManager", "requireTeamVisibility"]) {
    assertMethod(
      teamAuthorization,
      method,
      "team visibility and manager authorization"
    );
  }
  for (const method of [
    "appendRenameActivity",
    "completeIdempotency",
    "deleteLogo",
    "findCurrentLogo",
    "findIdempotency",
    "findTeam",
    "findTeamByNormalizedName",
    "insertLogo",
    "insertStartedIdempotency",
    "updateTeam",
  ]) {
    assertMethod(
      teamProfileRepository,
      method,
      "a team-profile repository"
    );
  }
  assertMethod(teamReadRepository, "findTeam", "a team read repository");
  assertMethod(auditRepository, "append", "a Security Audit repository");
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function requireMutationAuthority(authenticated, leagueId, teamId) {
    const visible = teamAuthorization.requireTeamVisibility(
      authenticated,
      leagueId,
      teamId
    );
    try {
      return leagueAuthorization.requireCommissioner(authenticated, leagueId);
    } catch (error) {
      if (error?.code !== "LEAGUE_COMMISSIONER_REQUIRED") throw error;
    }
    return teamAuthorization.requireManager(authenticated, leagueId, teamId);
  }

  function readLogo({ leagueId, teamId, authenticated } = {}) {
    const canonicalLeagueId = validateStableId(leagueId);
    const canonicalTeamId = validateStableId(teamId);
    teamAuthorization.requireTeamVisibility(
      authenticated,
      canonicalLeagueId,
      canonicalTeamId
    );
    const logo = teamProfileRepository.findCurrentLogo({
      leagueId: canonicalLeagueId,
      teamId: canonicalTeamId,
    });
    if (!logo) throw new TeamProfileNotFoundError("TEAM_LOGO_NOT_FOUND");
    return Object.freeze({
      byteLength: logo.byte_length,
      bytes: Buffer.from(logo.content_bytes),
      contentSha256: logo.content_sha256,
      mediaType: logo.media_type,
    });
  }

  function update({
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
    const version = validateExpectedVersion(expectedVersion);
    const profile = withLogoDigest(validateTeamProfileInput(input));
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const digest = profileRequestHash({
      leagueId: canonicalLeagueId,
      teamId: canonicalTeamId,
      expectedVersion: version,
      profile,
    });
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureRandom.id(),
      audit: secureRandom.id(),
      idempotency: secureRandom.id(),
      logo: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority = requireMutationAuthority(
          authenticated,
          canonicalLeagueId,
          canonicalTeamId
        );
        const existing = teamProfileRepository.findIdempotency({
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation: TEAM_PROFILE_OPERATION,
          clientKey,
        });
        if (existing) {
          if (
            existing.league_id !== canonicalLeagueId ||
            existing.request_hash !== digest
          ) {
            throw new TeamProfileConflictError("IDEMPOTENCY_KEY_REUSED");
          }
          if (
            existing.status !== "completed" ||
            existing.result_type !== "team" ||
            existing.result_id !== canonicalTeamId
          ) {
            throw new TeamProfileConflictError(
              "IDEMPOTENCY_REQUEST_UNAVAILABLE"
            );
          }
          return internalResult(
            teamReadRepository.findTeam({
              leagueId: canonicalLeagueId,
              teamId: canonicalTeamId,
            }),
            true
          );
        }

        const current = teamProfileRepository.findTeam({
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
        });
        if (!current) throw new TeamProfileNotFoundError();
        if (current.version !== version) {
          throw new TeamProfileConflictError(
            "TEAM_PROFILE_PRECONDITION_FAILED",
            { currentVersion: current.version, refetch: true }
          );
        }
        const currentPatternTemplate =
          current.pattern_template ||
          (current.tertiary_colour
            ? DEFAULT_THREE_TEAM_PATTERN
            : DEFAULT_TWO_TEAM_PATTERN);
        const nextPatternTemplate = profile.hasPatternTemplate
          ? profile.patternTemplate
          : currentPatternTemplate;
        const nextPrimaryColour = profile.colours
          ? profile.colours.primaryColour
          : current.primary_colour;
        const nextSecondaryColour = profile.colours
          ? profile.colours.secondaryColour
          : current.secondary_colour;
        const nextTertiaryColour = profile.colours
          ? profile.colours.tertiaryColour
          : current.tertiary_colour;
        const requiredColourCount = teamPatternColourCount(
          nextPatternTemplate
        );
        const coloursAreIncomplete =
          nextPrimaryColour === null && nextSecondaryColour === null;
        if (
          (coloursAreIncomplete &&
            (requiredColourCount !== 2 || nextTertiaryColour !== null)) ||
          (!coloursAreIncomplete &&
            ((requiredColourCount === 2 && nextTertiaryColour !== null) ||
              (requiredColourCount === 3 && nextTertiaryColour === null)))
        ) {
          throw new TeamProfilePolicyError(
            "team_pattern_colour_count_mismatch"
          );
        }
        const currentLogo = teamProfileRepository.findCurrentLogo({
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
        });
        const changes = {};
        let renamed = false;
        let replaceLogo = false;
        if (profile.hasName && profile.name.name !== current.name) {
          if (
            teamProfileRepository.findTeamByNormalizedName({
              leagueId: canonicalLeagueId,
              teamId: canonicalTeamId,
              nameNormalized: profile.name.nameNormalized,
            })
          ) {
            throw new TeamProfileConflictError("TEAM_NAME_UNAVAILABLE");
          }
          changes.name = profile.name.name;
          changes.name_normalized = profile.name.nameNormalized;
          renamed = true;
        }
        if (
          profile.hasPatternTemplate &&
          profile.patternTemplate !== currentPatternTemplate
        ) {
          changes.pattern_template = profile.patternTemplate;
        }
        if (
          profile.colours &&
          (profile.colours.primaryColour !== current.primary_colour ||
            profile.colours.secondaryColour !== current.secondary_colour ||
            profile.colours.tertiaryColour !== current.tertiary_colour)
        ) {
          changes.primary_colour = profile.colours.primaryColour;
          changes.secondary_colour = profile.colours.secondaryColour;
          changes.tertiary_colour = profile.colours.tertiaryColour;
        }
        if (profile.hasLogo) {
          if (profile.logo === null) {
            if (current.logo_reference !== null) changes.logo_reference = null;
          } else if (
            !currentLogo ||
            currentLogo.media_type !== profile.logo.mediaType ||
            currentLogo.content_sha256 !== profile.logo.contentSha256
          ) {
            changes.logo_reference = ids.logo;
            replaceLogo = true;
          }
        }
        if (Object.keys(changes).length === 0) {
          throw new TeamProfileConflictError("TEAM_PROFILE_NO_CHANGES");
        }

        teamProfileRepository.insertStartedIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          actorUserId: authority.actorUserId,
          operation: TEAM_PROFILE_OPERATION,
          clientKey,
          requestHash: digest,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
        });
        if (replaceLogo) {
          teamProfileRepository.insertLogo({
            id: ids.logo,
            leagueId: canonicalLeagueId,
            teamId: canonicalTeamId,
            mediaType: profile.logo.mediaType,
            byteLength: profile.logo.byteLength,
            width: profile.logo.width,
            height: profile.logo.height,
            contentSha256: profile.logo.contentSha256,
            contentBytes: profile.logo.bytes,
            createdAtMs: nowMs,
          });
        }
        changes.updated_at_ms = nowMs;
        teamProfileRepository.updateTeam({
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
          expectedVersion: version,
          changes,
        });
        if (currentLogo && changes.logo_reference !== undefined) {
          teamProfileRepository.deleteLogo({
            leagueId: canonicalLeagueId,
            teamId: canonicalTeamId,
            logoId: currentLogo.id,
          });
        }
        if (renamed) {
          teamProfileRepository.appendRenameActivity({
            id: ids.activity,
            leagueId: canonicalLeagueId,
            teamId: canonicalTeamId,
            actorUserId: authority.actorUserId,
            actorAuthority: authority.authority,
            displaySummary: `${current.name} was renamed to ${profile.name.name}.`,
            metadataJson: JSON.stringify({
              teamId: canonicalTeamId,
              previousName: current.name,
              name: profile.name.name,
            }),
            nowMs,
          });
        }
        auditRepository.append(auditRecord({
          id: ids.audit,
          audit,
          nowMs,
          authority,
          authenticated,
          leagueId: canonicalLeagueId,
        }));
        teamProfileRepository.completeIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
          completedAtMs: nowMs,
        });
        return internalResult(
          teamReadRepository.findTeam({
            leagueId: canonicalLeagueId,
            teamId: canonicalTeamId,
          }),
          false
        );
      });
    } catch (error) {
      const domain = [error, error?.cause].find(
        (candidate) =>
          candidate instanceof TeamProfilePolicyError ||
          candidate instanceof TeamProfileConflictError ||
          candidate instanceof TeamProfileNotFoundError
      );
      if (domain) throw domain;
      const authorization = [error, error?.cause].find((candidate) =>
        [
          "LEAGUE_NOT_FOUND",
          "LEAGUE_COMMISSIONER_REQUIRED",
          "TEAM_MANAGER_REQUIRED",
          "TEAM_NOT_FOUND",
        ].includes(candidate?.code)
      );
      if (authorization) throw authorization;
      const repositoryVersion = [error, error?.cause].find(
        (candidate) => candidate?.code === REPOSITORY_VERSION_CONFLICT
      );
      if (repositoryVersion) {
        const current = teamProfileRepository.findTeam({
          leagueId: canonicalLeagueId,
          teamId: canonicalTeamId,
        });
        throw new TeamProfileConflictError(
          "TEAM_PROFILE_PRECONDITION_FAILED",
          { currentVersion: current?.version ?? null, refetch: true }
        );
      }
      const repositoryConstraint = [error, error?.cause].find(
        (candidate) => candidate?.code === REPOSITORY_CONSTRAINT
      );
      if (repositoryConstraint) {
        throw new TeamProfileConflictError(
          repositoryConstraint?.details?.tableName === "idempotency_requests"
            ? "IDEMPOTENCY_REQUEST_UNAVAILABLE"
            : repositoryConstraint?.details?.tableName === "teams"
              ? "TEAM_NAME_UNAVAILABLE"
              : "TEAM_PROFILE_CONFLICT"
        );
      }
      throw error;
    }
  }

  return Object.freeze({ readLogo, update });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  TEAM_PROFILE_OPERATION,
  TeamProfileConflictError,
  TeamProfileNotFoundError,
  createTeamProfileService,
  profileRequestHash,
};
