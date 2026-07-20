const JOB_ORDER = [
  "applyRosterLocks",
  "captureMatchupBaseline",
  "finalizeMatchupResults",
  "rolloverMatchupWeek",
];

function startMatchupScheduler({
  jobs,
  intervalMs,
  trackInterval = (handle) => handle,
  setIntervalFn = setInterval,
  logger = console,
} = {}) {
  for (const jobName of JOB_ORDER) {
    if (typeof jobs?.[jobName]?.run !== "function") {
      throw new TypeError(
        `startMatchupScheduler requires jobs.${jobName}.run`
      );
    }
  }
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new TypeError(
      "startMatchupScheduler requires a positive intervalMs"
    );
  }

  let cycleRunning = false;

  async function runJob(jobName) {
    try {
      return await jobs[jobName].run();
    } catch (error) {
      logger.error(
        `[MATCHUPS] ${jobName} failed outside its runner:`,
        error
      );
      return {
        job: jobName,
        status: "failed",
        error,
      };
    }
  }

  async function runCycle() {
    if (cycleRunning) {
      return {
        status: "skipped",
        reason: "overlap",
        outcomes: {},
      };
    }

    cycleRunning = true;
    const outcomes = {};
    try {
      outcomes.applyRosterLocks =
        await runJob("applyRosterLocks");
      outcomes.captureMatchupBaseline =
        await runJob("captureMatchupBaseline");
      outcomes.finalizeMatchupResults =
        await runJob("finalizeMatchupResults");

      if (
        outcomes.finalizeMatchupResults.status ===
        "failed"
      ) {
        outcomes.rolloverMatchupWeek = {
          job: "matchups:rolloverWeek",
          status: "skipped",
          reason: "finalizationFailed",
        };
        return {
          status: "failed",
          reason: "finalizationFailed",
          outcomes,
        };
      }

      outcomes.rolloverMatchupWeek =
        await runJob("rolloverMatchupWeek");
      return {
        status:
          outcomes.rolloverMatchupWeek.status ===
          "failed"
            ? "failed"
            : "succeeded",
        outcomes,
      };
    } finally {
      cycleRunning = false;
    }
  }

  const initialRun = runCycle();
  const intervalHandle = trackInterval(
    setIntervalFn(() => {
      runCycle().catch((error) => {
        logger.error(
          "[MATCHUPS] scheduler cycle failed:",
          error
        );
      });
    }, intervalMs)
  );

  return {
    initialRun,
    intervalHandle,
    isRunning() {
      return cycleRunning;
    },
    runCycle,
  };
}

module.exports = {
  JOB_ORDER,
  startMatchupScheduler,
};
