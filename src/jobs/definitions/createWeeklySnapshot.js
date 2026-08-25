const {
  getPartsInTZ,
} = require("../../domain/matchups/buildSchedule");
const { createJobRunner } = require("../runJob");

const JOB_NAME = "snapshots:createWeekly";

function buildAutoSnapshotId(parts) {
  return `auto-${parts.year}-${parts.month}-${parts.day}-1600PT`;
}

function createWeeklySnapshotJob({
  leagueStore,
  snapshotRepository,
  publisher = { publish() {} },
  clock = { nowMs: Date.now },
  timeZone = "America/Los_Angeles",
  logger = console,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createWeeklySnapshotJob requires a leagueStore"
    );
  }
  if (
    !snapshotRepository ||
    typeof snapshotRepository.writeSnapshot !==
      "function"
  ) {
    throw new TypeError(
      "createWeeklySnapshotJob requires snapshotRepository.writeSnapshot"
    );
  }
  if (
    !clock ||
    typeof clock.nowMs !== "function"
  ) {
    throw new TypeError(
      "createWeeklySnapshotJob requires clock.nowMs"
    );
  }

  return createJobRunner({
    name: JOB_NAME,
    logger,
    async execute() {
      const nowMs = clock.nowMs();
      const parts = getPartsInTZ(
        new Date(nowMs),
        timeZone
      );
      if (parts.weekday !== "Sun") {
        return {
          status: "skipped",
          reason: "notSunday",
        };
      }

      const hour = Number(parts.hour);
      const minute = Number(parts.minute);
      const afterDeadline =
        hour > 16 ||
        (hour === 16 && minute >= 0);
      if (!afterDeadline) {
        return {
          status: "skipped",
          reason: "beforeDeadline",
        };
      }

      const snapshotId = buildAutoSnapshotId(parts);
      const state = leagueStore.loadLeague();
      if (
        state.lastAutoWeeklySnapshotId ===
        snapshotId
      ) {
        return {
          status: "skipped",
          reason: "alreadyCreated",
          snapshotId,
        };
      }

      await snapshotRepository.writeSnapshot(
        snapshotId,
        state
      );
      const nextState = {
        ...state,
        lastAutoWeeklySnapshotId: snapshotId,
      };
      await leagueStore.saveLeague(nextState, {
        savedBy: "system:autoWeeklySnapshot",
      });
      await publisher.publish("league:updated", {
        reason: "autoWeeklySnapshot",
        snapshotId,
      });
      logger.log(
        `[AUTO SNAPSHOT] Created weekly snapshot: ${snapshotId}`
      );

      return {
        status: "succeeded",
        snapshotId,
      };
    },
  });
}

module.exports = {
  JOB_NAME,
  buildAutoSnapshotId,
  createWeeklySnapshotJob,
};
