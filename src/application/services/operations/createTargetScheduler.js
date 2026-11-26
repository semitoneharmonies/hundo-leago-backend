const DEFAULT_INTERVAL_MS = 30_000;
const MAXIMUM_INTERVAL_MS = 5 * 60_000;
const LIVE_TICK_INTERVAL_MS = 10_000;

function createTargetScheduler({
  enabled,
  emailEnabled,
  leagueWriteMode,
  jobs,
  emailJob = null,
  backupEnabled = false,
  backupJob = null,
  dailyBackupJob = null,
  liveStatisticsJob = null,
  teamAssignmentsJob = null,
  injuryJob = null,
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
  if (typeof backupEnabled !== "boolean" || (backupEnabled && backupJob === null) ||
      (backupJob !== null && (typeof backupJob.start !== "function" || typeof backupJob.close !== "function"))) {
    throw new TypeError("target scheduler requires a controlled backup job when backups are enabled");
  }
  if (liveStatisticsJob !== null && typeof liveStatisticsJob.job?.run !== "function") {
    throw new TypeError("target scheduler requires a controlled live statistics job");
  }
  if (teamAssignmentsJob !== null && typeof teamAssignmentsJob.run !== "function") {
    throw new TypeError("target scheduler requires a controlled team-assignment job");
  }
  if (injuryJob !== null && typeof injuryJob.run !== 'function') {
    throw new TypeError('target scheduler requires a controlled injury job');
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
  let liveIntervalHandle = null;
  let liveInFlight = null;
  let teamAssignmentsIntervalHandle = null;
  let teamAssignmentsInFlight = null;
  let injuryIntervalHandle = null;
  let injuryInFlight = null;
  let startResult = null;
  let closePromise = null;
  let emailStarted = false;
  let backupStarted = false;
  let dailyBackupStarted = false;

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

  // Provisional fetches never sit in front of time-sensitive league jobs.
  // The live service owns its actual polling cadence and provider backoff.
  function runLiveCycle() {
    if (!liveStatisticsJob || state !== "running") return Promise.resolve({ status: "skipped", reason: "not_running" });
    if (inFlight) return Promise.resolve({ status: "skipped", reason: "league_jobs_running" });
    if (liveInFlight) return Promise.resolve({ status: "skipped", reason: "overlap" });
    const cycle = Promise.resolve().then(() => liveStatisticsJob.job.run()).catch(() => {
      logger.error("target_scheduler.live_statistics_failed", { code: "TARGET_LIVE_STATISTICS_FAILED" });
      return { status: "failed", code: "TARGET_LIVE_STATISTICS_FAILED" };
    });
    liveInFlight = cycle;
    cycle.finally(() => { if (liveInFlight === cycle) liveInFlight = null; });
    return cycle;
  }

  // Catalogue fetches have their own overlap guard and durable daily lease.
  // Waiting on the provider must never delay league jobs or live statistics.
  function runTeamAssignmentsCycle() {
    if (!teamAssignmentsJob || state !== "running") return Promise.resolve({ status: "skipped", reason: "not_running" });
    if (teamAssignmentsInFlight) return Promise.resolve({ status: "skipped", reason: "overlap" });
    const cycle = Promise.resolve().then(() => teamAssignmentsJob.run()).catch(() => {
      logger.error("target_scheduler.team_assignments_failed", { code: "TARGET_TEAM_ASSIGNMENTS_FAILED" });
      return { status: "failed", code: "TARGET_TEAM_ASSIGNMENTS_FAILED" };
    });
    teamAssignmentsInFlight = cycle;
    cycle.finally(() => { if (teamAssignmentsInFlight === cycle) teamAssignmentsInFlight = null; });
    return cycle;
  }

  function runInjuryCycle() {
    if (!injuryJob || state !== 'running') return Promise.resolve({ status: 'skipped', reason: 'not_running' });
    if (injuryInFlight) return Promise.resolve({ status: 'skipped', reason: 'overlap' });
    const cycle = Promise.resolve().then(() => injuryJob.run()).catch(() => {
      logger.error('target_scheduler.injuries_failed', { code: 'TARGET_INJURIES_FAILED' });
      return { status: 'failed', code: 'TARGET_INJURIES_FAILED' };
    });
    injuryInFlight = cycle;
    cycle.finally(() => { if (injuryInFlight === cycle) injuryInFlight = null; });
    return cycle;
  }

  function start() {
    if (startResult) return startResult;
    if (closePromise) {
      throw new Error("target scheduler is closed");
    }
    let emailStart = null;
    let backupStart = null;
    try {
      if (backupEnabled) {
        backupStart = backupJob.start();
        backupStarted = true;
      }
      if (enabled && leagueWriteMode === "open" && dailyBackupJob) {
        try {
          const dailyStart = dailyBackupJob.start();
          dailyBackupStarted = true;
          Promise.resolve(dailyStart?.initialRun).catch(() => {
            logger.error("daily_backup.failed", { code: "DAILY_BACKUP_FAILED" });
          });
        } catch {
          logger.error("daily_backup.failed", { code: "DAILY_BACKUP_FAILED" });
        }
      }
      if (emailEnabled) {
        emailStart = emailJob.start();
        emailStarted = true;
      }
      if (state === "disabled" || state === "paused_maintenance") {
        if (backupStarted) {
          startResult = Object.freeze({ status: emailStarted ? "email_and_backup" : "backup_only",
            backupInitialRun: backupStart?.initialRun || null,
            ...(emailStarted ? { emailInitialRun: emailStart?.initialRun || null, emailRecovered: emailStart?.recovered ?? null } : {}),
          });
          return startResult;
        }
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
      if (liveStatisticsJob) {
        liveIntervalHandle = setIntervalFunction(() => { void runLiveCycle(); }, LIVE_TICK_INTERVAL_MS);
        if (liveIntervalHandle && typeof liveIntervalHandle.unref === "function") liveIntervalHandle.unref();
      }
      const teamAssignmentsInitialRun = teamAssignmentsJob ? runTeamAssignmentsCycle() : null;
      const injuryInitialRun = injuryJob ? runInjuryCycle() : null;
      if (injuryJob) {
        injuryIntervalHandle = setIntervalFunction(() => { void runInjuryCycle(); }, intervalMs);
        if (injuryIntervalHandle && typeof injuryIntervalHandle.unref === 'function') injuryIntervalHandle.unref();
      }
      if (teamAssignmentsJob) {
        teamAssignmentsIntervalHandle = setIntervalFunction(() => { void runTeamAssignmentsCycle(); }, intervalMs);
        if (teamAssignmentsIntervalHandle && typeof teamAssignmentsIntervalHandle.unref === "function") teamAssignmentsIntervalHandle.unref();
      }
      startResult = Object.freeze({
        status: "running",
        initialRun,
        emailInitialRun: emailStart?.initialRun || null,
        emailRecovered: emailStart?.recovered ?? null,
        ...(backupStarted ? { backupInitialRun: backupStart?.initialRun || null } : {}),
        ...(teamAssignmentsJob ? { teamAssignmentsInitialRun } : {}),
        ...(injuryJob ? { injuryInitialRun } : {}),
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
      if (liveIntervalHandle !== null) {
        clearIntervalFunction(liveIntervalHandle);
        liveIntervalHandle = null;
      }
      if (teamAssignmentsIntervalHandle !== null) {
        clearIntervalFunction(teamAssignmentsIntervalHandle);
        teamAssignmentsIntervalHandle = null;
      }
      const errors = [];
      if (injuryIntervalHandle !== null) {
        clearIntervalFunction(injuryIntervalHandle);
        injuryIntervalHandle = null;
      }
      if (injuryInFlight) {
        try { await injuryInFlight; } catch (error) { errors.push(error); }
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch (error) {
          errors.push(error);
        }
      }
      if (liveInFlight) {
        try { await liveInFlight; } catch (error) { errors.push(error); }
      }
      if (teamAssignmentsInFlight) {
        try { await teamAssignmentsInFlight; } catch (error) { errors.push(error); }
      }
      if (emailStarted) {
        try {
          await emailJob.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (backupStarted) {
        try { await backupJob.close(); } catch (error) { errors.push(error); }
      }
      if (dailyBackupStarted) {
        try { await dailyBackupJob.close(); } catch {
          logger.error("daily_backup.failed", { code: "DAILY_BACKUP_SHUTDOWN_FAILED" });
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
    runLiveCycle,
    runTeamAssignmentsCycle,
    runInjuryCycle,
    start,
  });
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MAXIMUM_INTERVAL_MS,
  LIVE_TICK_INTERVAL_MS,
  createTargetScheduler,
};
