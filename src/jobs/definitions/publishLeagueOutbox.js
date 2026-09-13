const { createJobRunner } = require("../runJob");

const JOB_NAME = "league-outbox:publish:target";

function createPublishLeagueOutboxJob({ service, logger = console } = {}) {
  if (!service || typeof service.publishDue !== "function") {
    throw new TypeError("league-outbox job requires a publication service");
  }
  return createJobRunner({
    name: JOB_NAME,
    logger,
    async execute() {
      const outcomes = await service.publishDue();
      return {
        status: outcomes.some(({ outcome }) => outcome === "failed")
          ? "failed"
          : "succeeded",
        attempted: outcomes.length,
        published: outcomes.filter(({ outcome }) => outcome === "published")
          .length,
        failed: outcomes.filter(({ outcome }) => outcome === "failed").length,
      };
    },
  });
}

module.exports = { JOB_NAME, createPublishLeagueOutboxJob };
