const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_RECOVERY_LIMIT = 100;
const MAXIMUM_INTERVAL_MS = 5 * 60_000;

function createAccountEmailDeliveryJob({
  deliveryService,
  logger,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchLimit = DEFAULT_BATCH_LIMIT,
  recoveryLimit = DEFAULT_RECOVERY_LIMIT,
  setIntervalFunction = setInterval,
  clearIntervalFunction = clearInterval,
} = {}) {
  if (
    !deliveryService ||
    typeof deliveryService.deliverDue !== "function" ||
    typeof deliveryService.recoverInterrupted !== "function"
  ) {
    throw new TypeError(
      "account email delivery job requires a delivery service"
    );
  }
  if (!logger || typeof logger.error !== "function") {
    throw new TypeError("account email delivery job requires a safe logger");
  }
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > MAXIMUM_INTERVAL_MS
  ) {
    throw new TypeError("account email delivery job requires a bounded interval");
  }
  if (
    !Number.isSafeInteger(batchLimit) ||
    batchLimit < 1 ||
    batchLimit > 100 ||
    !Number.isSafeInteger(recoveryLimit) ||
    recoveryLimit < 1 ||
    recoveryLimit > 100
  ) {
    throw new TypeError("account email delivery job requires bounded limits");
  }
  if (
    typeof setIntervalFunction !== "function" ||
    typeof clearIntervalFunction !== "function"
  ) {
    throw new TypeError("account email delivery job requires timer functions");
  }

  let started = false;
  let closed = false;
  let intervalHandle = null;
  let inFlight = null;

  function runCycle() {
    if (closed) {
      return Promise.resolve(
        Object.freeze({ status: "skipped", reason: "closed" })
      );
    }
    if (inFlight) {
      return Promise.resolve(
        Object.freeze({ status: "skipped", reason: "overlap" })
      );
    }
    const cycle = (async () => {
      try {
        const outcomes = await deliveryService.deliverDue({
          limit: batchLimit,
        });
        return Object.freeze({
          status: "succeeded",
          delivered: outcomes.length,
          outcomes,
        });
      } catch {
        logger.error("account_email.delivery_cycle_failed", {
          code: "ACCOUNT_EMAIL_DELIVERY_CYCLE_FAILED",
        });
        return Object.freeze({
          status: "failed",
          code: "ACCOUNT_EMAIL_DELIVERY_CYCLE_FAILED",
        });
      }
    })();
    inFlight = cycle;
    cycle.finally(() => {
      if (inFlight === cycle) inFlight = null;
    });
    return cycle;
  }

  function start() {
    if (closed) {
      throw new Error("account email delivery job is closed");
    }
    if (started) {
      throw new Error("account email delivery job is already started");
    }
    const recovered = deliveryService.recoverInterrupted({
      limit: recoveryLimit,
    });
    started = true;
    const initialRun = runCycle();
    intervalHandle = setIntervalFunction(() => {
      void runCycle();
    }, intervalMs);
    if (
      intervalHandle &&
      typeof intervalHandle.unref === "function"
    ) {
      intervalHandle.unref();
    }
    return Object.freeze({ initialRun, recovered });
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (intervalHandle !== null) {
      clearIntervalFunction(intervalHandle);
      intervalHandle = null;
    }
    if (inFlight) await inFlight;
  }

  return Object.freeze({
    close,
    isRunning() {
      return inFlight !== null;
    },
    isStarted() {
      return started;
    },
    runCycle,
    start,
  });
}

module.exports = {
  DEFAULT_BATCH_LIMIT,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RECOVERY_LIMIT,
  MAXIMUM_INTERVAL_MS,
  createAccountEmailDeliveryJob,
};
