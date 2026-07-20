const VALID_STATUSES = new Set([
  "failed",
  "skipped",
  "succeeded",
]);

function createJobRunner({
  name,
  execute,
  logger = console,
} = {}) {
  if (!name) {
    throw new TypeError("createJobRunner requires a name");
  }
  if (typeof execute !== "function") {
    throw new TypeError(
      "createJobRunner requires an execute function"
    );
  }

  let running = false;

  async function run(context) {
    if (running) {
      return {
        job: name,
        status: "skipped",
        reason: "overlap",
      };
    }

    running = true;
    try {
      const result = await execute(context);
      const normalized =
        result &&
        typeof result === "object" &&
        VALID_STATUSES.has(result.status)
          ? result
          : { status: "succeeded" };

      return {
        job: name,
        ...normalized,
      };
    } catch (error) {
      logger.error(`[${name}] Failed:`, error);
      return {
        job: name,
        status: "failed",
        error,
      };
    } finally {
      running = false;
    }
  }

  return {
    isRunning() {
      return running;
    },
    run,
  };
}

module.exports = { createJobRunner };
