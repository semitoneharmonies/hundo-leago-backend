const {
  EVENT_TYPES,
  buildAcceleratedSeasonTimeline,
} = require("../../../domain/matchups/acceleratedSeasonPolicy");

const ACCELERATED_SEASON_SERVICE_CODES = Object.freeze({
  seasonMissing: "ACCELERATED_SEASON_MISSING",
  checkpointInvalid: "ACCELERATED_SEASON_CHECKPOINT_INVALID",
  handlerFailed: "ACCELERATED_SEASON_HANDLER_FAILED",
});

class AcceleratedSeasonSimulationError extends Error {
  constructor(message, checkpoint, cause) {
    super(message, { cause });
    this.name = "AcceleratedSeasonSimulationError";
    this.code = ACCELERATED_SEASON_SERVICE_CODES.handlerFailed;
    this.checkpoint = Object.freeze({ ...checkpoint });
  }
}

function createAcceleratedSeasonSimulationService({ repository, handlers } = {}) {
  if (!repository || typeof repository.readSeason !== "function") {
    throw new TypeError("accelerated season simulation requires a repository");
  }
  if (
    !handlers || !EVENT_TYPES.every((type) => typeof handlers[type] === "function") ||
    Object.keys(handlers).some((type) => !EVENT_TYPES.includes(type))
  ) throw new TypeError("accelerated season simulation requires exactly four handlers");

  async function run(input) {
    const season = repository.readSeason(input);
    if (!season) {
      const error = new Error("The accelerated simulation season was not found.");
      error.code = ACCELERATED_SEASON_SERVICE_CODES.seasonMissing;
      throw error;
    }
    const timeline = buildAcceleratedSeasonTimeline(season.weeks);
    const fromEventIndex = input.fromEventIndex ?? 0;
    if (!Number.isSafeInteger(fromEventIndex) || fromEventIndex < 0 || fromEventIndex > timeline.length) {
      const error = new TypeError("The accelerated simulation checkpoint is invalid.");
      error.code = ACCELERATED_SEASON_SERVICE_CODES.checkpointInvalid;
      throw error;
    }
    let completedEventCount = 0;
    for (let index = fromEventIndex; index < timeline.length; index += 1) {
      const event = timeline[index];
      try {
        await handlers[event.eventType](Object.freeze({
          leagueId: season.leagueId,
          seasonId: season.seasonId,
          ...event,
        }));
        completedEventCount += 1;
      } catch (error) {
        throw new AcceleratedSeasonSimulationError(
          "An accelerated season handler failed.",
          {
            failedEventIndex: index,
            completedEventCount,
            resumeFromEventIndex: index,
            event,
          },
          error
        );
      }
    }
    return Object.freeze({
      leagueId: season.leagueId,
      seasonId: season.seasonId,
      weekCount: season.weeks.length,
      totalEventCount: timeline.length,
      fromEventIndex,
      completedEventCount,
      nextEventIndex: timeline.length,
    });
  }

  return Object.freeze({ run });
}

module.exports = {
  ACCELERATED_SEASON_SERVICE_CODES,
  AcceleratedSeasonSimulationError,
  createAcceleratedSeasonSimulationService,
};
