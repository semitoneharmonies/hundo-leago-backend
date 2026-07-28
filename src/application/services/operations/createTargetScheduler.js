const DEFAULT_INTERVAL_MS = 30_000;
const MAXIMUM_INTERVAL_MS = 5 * 60_000;

function createTargetScheduler({
  enabled,
  emailEnabled,
  leagueWriteMode,
  jobs,
  emailJob = null,
  health,
  logger,
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFunction = setInterval,
  clearIntervalFunction = clearInterval,
} = {}) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("target scheduler requires explicit enablement");
  }
  if (typeof emailEnabled !== "boolean") {
    throw new TypeError(
      "target scheduler requires explicit account-email enablement"
    );
  }
  if (!["closed", "open"].includes(leagueWriteMode)) {
    throw new TypeError("target scheduler requires an explicit league write mode");
  }
  if (
    !Array.isArray(jobs) ||
    jobs.length < 1 ||
    jobs.some(
      (entry) =>
        !entry ||
        typeof entry.name !== "string" ||
        entry.name.trim() === "" ||
        typeof entry.runner?.run !== "function"
    ) ||
    new Set(jobs.map(({ name }) => name)).size !== jobs.length
  ) {
    throw new TypeError("target scheduler requires uniquely named job runners");
  }
  if (
    emailJob !== null &&
    (typeof emailJob.start !== "function" ||
      typeof emailJob.close !== "function")
  ) {
    throw new TypeError("target scheduler requires a controlled account-email job");
  }
  if (emailEnabled && emailJob === null) {
    throw new TypeError(
      "target scheduler requires an account-email job when delivery is enabled"
    );
  }
  if (!health || typeof health.setSchedulerState !== "function") {
    throw new TypeError("target scheduler requires runtime health state");
  }
  if (!logger || typeof logger.error !== "function") {
    throw new TypeError("target scheduler requires a safe logger");
  }
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > MAXIMUM_INTERVAL_MS ||
    typeof setIntervalFunction !== "function" ||
    typeof clearIntervalFunction !== "function"
  ) {
    throw new TypeError("target scheduler requires bounded timer configuration");
  }

  let state = enabled
    ? leagueWriteMode === "closed"
      ? "paused_maintenance"
      : "not_started"
    : "disabled";
  let intervalHandle = null;
  let inFlight = null;
  let startResult = null;
  let closePromise = null;
  let emailStarted = false;

  function transition(nextState) {
    state = nextState;
    health.setSchedulerState(nextState);
  }

  function runCycle() {
    if (state !== "running") {
      return Promise.resolve(
        Object.freeze({ status: "skipped", reason: "not_running" })
      );
    }
    if (inFlight) {
      return Promise.resolve(
        Object.freeze({ status: "skipped", reason: "overlap" })
      );
    }
    const cycle = (async () => {
      const outcomes = [];
      for (const entry of jobs) {
        try {
          outcomes.push(
            Object.freeze({ name: entry.name, result: await entry.runner.run() })
          );
        } catch {
          logger.error("target_scheduler.job_failed", {
            code: "TARGET_SCHEDULED_JOB_FAILED",
            job: entry.name,
          });
          outcomes.push(
            Object.freeze({
              name: entry.name,
              result: Object.freeze({
                status: "failed",
                code: "TARGET_SCHEDULED_JOB_FAILED",
              }),
            })
          );
        }
      }
      return Object.freeze({
        status: outcomes.some(({ result }) => result?.status === "failed")
          ? "failed"
          : "succeeded",
        outcomes: Object.freeze(outcomes),
      });
    })();
    inFlight = cycle;
    cycle.finally(() => {
      if (inFlight === cycle) inFlight = null;
    });
    return cycle;
  }

  function start() {
    if (startResult) return startResult;
    if (closePromise) {
      throw new Error("target scheduler is closed");
    }
    let emailStart = null;
    try {
      if (emailEnabled) {
        emailStart = emailJob.start();
        emailStarted = true;
      }
      if (state === "disabled" || state === "paused_maintenance") {
        startResult = emailStarted
          ? Object.freeze({
              status: "email_only",
              emailInitialRun: emailStart?.initialRun || null,
              emailRecovered: emailStart?.recovered ?? null,
            })
          : Object.freeze({ status: state });
        return startResult;
      }

      transition("starting");
      transition("running");
      const initialRun = runCycle();
      intervalHandle = setIntervalFunction(() => {
        void runCycle();
      }, intervalMs);
      if (intervalHandle && typeof intervalHandle.unref === "function") {
        intervalHandle.unref();
      }
      startResult = Object.freeze({
        status: "running",
        initialRun,
        emailInitialRun: emailStart?.initialRun || null,
        emailRecovered: emailStart?.recovered ?? null,
      });
      return startResult;
    } catch (error) {
      if (!["disabled", "paused_maintenance"].includes(state)) {
        transition("failed");
      }
      throw error;
    }
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const leagueSchedulerActive = ![
        "disabled",
        "paused_maintenance",
        "stopped",
      ].includes(state);
      if (leagueSchedulerActive) transition("stopping");
      if (intervalHandle !== null) {
        clearIntervalFunction(intervalHandle);
        intervalHandle = null;
      }
      const errors = [];
      if (inFlight) {
        try {
          await inFlight;
        } catch (error) {
          errors.push(error);
        }
      }
      if (emailStarted) {
        try {
          await emailJob.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (leagueSchedulerActive) transition("stopped");
      if (errors.length > 0) {
        throw new AggregateError(errors, "target scheduler shutdown failed");
      }
    })();
    return closePromise;
  }

  return Object.freeze({
    close,
    getState() {
      return state;
    },
    isRunning() {
      return state === "running";
    },
    runCycle,
    start,
  });
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MAXIMUM_INTERVAL_MS,
  createTargetScheduler,
};
