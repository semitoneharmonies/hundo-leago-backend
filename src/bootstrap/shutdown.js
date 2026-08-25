function createShutdown({
  server,
  io,
  processRef = process,
  clearIntervalFn = clearInterval,
  closeTimeoutMs = 2000,
  logger = console,
} = {}) {
  const intervalHandles = new Set();
  const signalHandlers = new Map();
  let shutdownPromise = null;

  function trackInterval(handle) {
    if (handle !== undefined && handle !== null) {
      intervalHandles.add(handle);
    }
    return handle;
  }

  function disposeSignalHandlers() {
    for (const [signal, handler] of signalHandlers) {
      processRef.removeListener(signal, handler);
    }
    signalHandlers.clear();
  }

  function withTimeout(label, invoke) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`${label} did not complete within ${closeTimeoutMs}ms`)
        );
      }, closeTimeoutMs);

      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
        } else {
          resolve();
        }
      }

      try {
        invoke(finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  async function closeSocketServer() {
    if (!io || typeof io.close !== "function") return;
    await withTimeout("Socket.IO shutdown", (finish) => io.close(finish));
  }

  async function closeHttpServer() {
    if (!server || typeof server.close !== "function") return;
    if (server.listening === false) return;
    await withTimeout("HTTP server shutdown", (finish) =>
      server.close(finish)
    );
  }

  async function performShutdown() {
    disposeSignalHandlers();

    for (const handle of intervalHandles) {
      clearIntervalFn(handle);
    }
    intervalHandles.clear();

    let firstError = null;

    try {
      await closeSocketServer();
    } catch (error) {
      firstError = error;
    }

    try {
      await closeHttpServer();
    } catch (error) {
      firstError ||= error;
    }

    if (firstError) throw firstError;
  }

  function shutdown() {
    if (!shutdownPromise) {
      shutdownPromise = performShutdown();
    }
    return shutdownPromise;
  }

  function installSignalHandlers(signals = ["SIGINT", "SIGTERM"]) {
    for (const signal of signals) {
      if (signalHandlers.has(signal)) continue;

      const handler = () => {
        shutdown().catch((error) => {
          logger.error(
            `[BACKEND] ${signal} shutdown failed:`,
            error?.message || error
          );
          processRef.exitCode = 1;
        });
      };

      signalHandlers.set(signal, handler);
      processRef.once(signal, handler);
    }

    return disposeSignalHandlers;
  }

  return {
    disposeSignalHandlers,
    installSignalHandlers,
    shutdown,
    trackInterval,
  };
}

module.exports = { createShutdown };
