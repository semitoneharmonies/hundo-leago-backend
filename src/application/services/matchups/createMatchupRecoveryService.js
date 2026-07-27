const { randomUUID } = require("node:crypto");

const {
  validateRecoveryCommand,
} = require("../../../domain/matchups/matchupRecoveryPolicy");

const MATCHUP_RECOVERY_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_RECOVERY_CONTEXT_MISSING",
  commissionerRequired: "MATCHUP_RECOVERY_COMMISSIONER_REQUIRED",
  stateInvalid: "MATCHUP_RECOVERY_STATE_INVALID",
  previewStale: "MATCHUP_RECOVERY_PREVIEW_STALE",
});

class MatchupRecoveryServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupRecoveryServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupRecoveryServiceError(code, message);
}

function createMatchupRecoveryService({ repository, standingsService, createId = randomUUID } = {}) {
  if (
    !repository || typeof repository.readMatchupContext !== "function" ||
    typeof repository.readStandingsContext !== "function" ||
    typeof repository.readMatchupOperation !== "function" ||
    typeof repository.readStandingsOperation !== "function" ||
    typeof repository.routeMatchup !== "function" ||
    typeof repository.rebuildStandings !== "function"
  ) throw new TypeError("createMatchupRecoveryService requires a recovery repository");
  if (!standingsService || typeof standingsService.read !== "function") {
    throw new TypeError("createMatchupRecoveryService requires the authoritative standings service");
  }
  if (typeof createId !== "function") throw new TypeError("createMatchupRecoveryService requires an ID factory");

  function previewMatchup(input) {
    const context = repository.readMatchupContext(input);
    if (!context) fail(MATCHUP_RECOVERY_SERVICE_CODES.contextMissing, "The matchup was not found.");
    if (
      context.commissioner_user_id !== input.actorUserId &&
      input.authorizedAsPlatformAdministrator !== true
    ) {
      fail(MATCHUP_RECOVERY_SERVICE_CODES.commissionerRequired, "Current commissioner authority is required.");
    }
    if (!["awaiting_data", "final"].includes(context.status) || !["awaiting_data", "final"].includes(context.week_status)) {
      fail(MATCHUP_RECOVERY_SERVICE_CODES.stateInvalid, "The matchup cannot be routed for correction.");
    }
    return Object.freeze({
      matchupId: context.id,
      matchupStatus: context.status,
      weekStatus: context.week_status,
      expectedVersion: context.version,
      expectedWeekVersion: context.week_version,
    });
  }

  function routeMatchup(input) {
    const validated = validateRecoveryCommand(input);
    if (repository.readMatchupOperation(input)) {
      return repository.routeMatchup({ ...input, reason: validated.reason });
    }
    const preview = previewMatchup(input);
    if (preview.expectedVersion !== validated.expectedVersion || preview.expectedWeekVersion !== input.expectedWeekVersion) {
      fail(MATCHUP_RECOVERY_SERVICE_CODES.previewStale, "The matchup recovery preview is stale.");
    }
    return repository.routeMatchup({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      weekId: input.weekId,
      matchupId: input.matchupId,
      actorUserId: input.actorUserId,
      authorizedAsPlatformAdministrator:
        input.authorizedAsPlatformAdministrator === true,
      operationId: input.operationId,
      expectedVersion: validated.expectedVersion,
      expectedWeekVersion: input.expectedWeekVersion,
      reason: validated.reason,
      nowMs: input.nowMs,
    });
  }

  function previewStandings(input) {
    const context = repository.readStandingsContext(input);
    if (!context) fail(MATCHUP_RECOVERY_SERVICE_CODES.contextMissing, "The standings season was not found.");
    if (
      context.season.commissioner_user_id !== input.actorUserId &&
      input.authorizedAsPlatformAdministrator !== true
    ) {
      fail(MATCHUP_RECOVERY_SERVICE_CODES.commissionerRequired, "Current commissioner authority is required.");
    }
    const projection = standingsService.read(input);
    return Object.freeze({
      currentSnapshotId: context.currentSnapshot?.id || null,
      expectedVersion: context.currentSnapshot?.snapshot_version || 1,
      nextSnapshotVersion: context.maximumSnapshotVersion + 1,
      projection,
    });
  }

  function rebuildStandings(input) {
    const validated = validateRecoveryCommand(input);
    if (repository.readStandingsOperation(input)) {
      return repository.rebuildStandings({ ...input, reason: validated.reason });
    }
    const preview = previewStandings(input);
    if (
      preview.expectedVersion !== validated.expectedVersion ||
      preview.currentSnapshotId !== (input.expectedCurrentSnapshotId ?? null)
    ) fail(MATCHUP_RECOVERY_SERVICE_CODES.previewStale, "The standings recovery preview is stale.");
    const rows = preview.projection.rows.map((row) => Object.freeze({
      rowId: createId(),
      teamId: row.teamId,
      rank: row.rank,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      standingsPoints: row.standingsPoints,
      fantasyPointsForHundredths: row.fantasyPointsForHundredths,
      fantasyPointsAgainstHundredths: row.fantasyPointsAgainstHundredths,
      fantasyPointsDifferentialHundredths: row.fantasyPointsDifferentialHundredths,
    }));
    return repository.rebuildStandings({
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      actorUserId: input.actorUserId,
      authorizedAsPlatformAdministrator:
        input.authorizedAsPlatformAdministrator === true,
      operationId: input.operationId,
      expectedCurrentSnapshotId: input.expectedCurrentSnapshotId ?? null,
      snapshotId: createId(),
      sourceResultVersion: preview.projection.sourceResultVersion,
      rows: Object.freeze(rows),
      reason: validated.reason,
      nowMs: input.nowMs,
    });
  }

  return Object.freeze({ previewMatchup, previewStandings, rebuildStandings, routeMatchup });
}

module.exports = {
  MATCHUP_RECOVERY_SERVICE_CODES,
  MatchupRecoveryServiceError,
  createMatchupRecoveryService,
};
