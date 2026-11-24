const { randomUUID } = require("node:crypto");
const { createJobRunner } = require("../runJob");
const { latestEveningOccurrence } = require("./runCompletedGameStatistics");
const JOB_TYPE = "players:nhl_teams";

function createRefreshNhlTeamAssignmentsJob({ repository, teamRepository, provider, nhlSeasonKey, clock, logger = console, owner = randomUUID() } = {}) {
  if (!repository?.claim || !repository?.assertLease || !repository?.complete || !teamRepository?.readPlayers ||
    !teamRepository?.applyAssignments || !provider?.fetchAssignments || !clock?.nowMs || !/^\d{8}$/.test(nhlSeasonKey)) {
    throw new TypeError("The NHL team assignment job requires durable scheduling, team storage and an NHL provider.");
  }
  return createJobRunner({ name: JOB_TYPE, logger, async execute() {
    const nowMs = clock.nowMs();
    const scheduledForMs = latestEveningOccurrence(nowMs, [8 * 60]);
    const lease = repository.claim({ occurrenceKey: `${nhlSeasonKey}:${scheduledForMs}`, scheduledForMs, nowMs, owner });
    if (!lease) return { status: "skipped", reason: "already_claimed_or_completed" };
    try {
      const snapshot = await provider.fetchAssignments({ players: teamRepository.readPlayers() });
      repository.assertLease(lease, clock.nowMs());
      const applied = teamRepository.applyAssignments({ ...snapshot,
        authorizePersist: () => repository.assertLease(lease, clock.nowMs()) });
      const result = { observedAtMs: snapshot.observedAtMs, sourceVersion: snapshot.sourceVersion, counts: snapshot.counts, ...applied };
      repository.complete({ lease, nowMs: clock.nowMs(), result });
      return { status: "succeeded", scheduledForMs, ...result };
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code || "") ? error.code : "NHL_TEAM_ASSIGNMENTS_REFRESH_FAILED";
      try { repository.complete({ lease, nowMs: clock.nowMs(), errorCode: code }); }
      catch { logger.error?.("nhl_team_assignments.lease_lost", { code }); }
      logger.error?.("nhl_team_assignments.failed", { code });
      return { status: "failed", code, scheduledForMs };
    }
  } });
}

module.exports = { JOB_TYPE, createRefreshNhlTeamAssignmentsJob };
