const {
  getPartsInTZ,
} = require("../../domain/matchups/buildSchedule");
const { createJobRunner } = require("../runJob");

const JOB_NAME = "auctions:resolve";

function buildAutoAuctionRolloverId(parts) {
  return `auction-${parts.year}-${parts.month}-${parts.day}-1600PT`;
}

function createResolveAuctionsJob({
  resolutionService,
  clock = { nowMs: Date.now },
  timeZone = "America/Los_Angeles",
  logger = console,
} = {}) {
  if (
    !resolutionService ||
    typeof resolutionService.resolve !== "function"
  ) {
    throw new TypeError(
      "createResolveAuctionsJob requires resolutionService.resolve"
    );
  }
  if (
    !clock ||
    typeof clock.nowMs !== "function"
  ) {
    throw new TypeError(
      "createResolveAuctionsJob requires clock.nowMs"
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

      const rolloverId =
        buildAutoAuctionRolloverId(parts);
      const result = await resolutionService.resolve({
        nowMs,
        rolloverId,
      });
      if (result.status === "succeeded") {
        logger.log(
          `[AUTO AUCTIONS] Rollover complete: ${rolloverId} (signings: ${result.signings})`
        );
      }
      return result;
    },
  });
}

module.exports = {
  JOB_NAME,
  buildAutoAuctionRolloverId,
  createResolveAuctionsJob,
};
