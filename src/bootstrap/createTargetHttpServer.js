const http = require("node:http");
const { Server: SocketServer } = require("socket.io");

function createTargetHttpServer({
  runtime,
  securityConfig = runtime?.securityConfig,
  httpModule = http,
  SocketServerClass = SocketServer,
} = {}) {
  if (
    !runtime?.app ||
    typeof runtime.app !== "function" ||
    typeof runtime?.socketRooms?.middleware !== "function"
  ) {
    throw new TypeError(
      "target HTTP server requires a composed target runtime"
    );
  }
  if (
    !securityConfig ||
    typeof securityConfig.isAllowedFrontendOrigin !== "function" ||
    securityConfig !== runtime.securityConfig
  ) {
    throw new TypeError(
      "target HTTP server requires its runtime frontend-origin configuration"
    );
  }
  if (!httpModule || typeof httpModule.createServer !== "function") {
    throw new TypeError("target HTTP server requires an HTTP module");
  }
  if (typeof SocketServerClass !== "function") {
    throw new TypeError("target HTTP server requires a Socket.IO server");
  }

  const server = httpModule.createServer(runtime.app);
  const io = new SocketServerClass(server, {
    cors: {
      origin(origin, callback) {
        if (securityConfig.isAllowedFrontendOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Socket CORS blocked"));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });
  if (
    typeof io.use !== "function" ||
    typeof io.on !== "function" ||
    typeof io.close !== "function"
  ) {
    throw new TypeError(
      "target HTTP server requires Socket.IO middleware and lifecycle methods"
    );
  }
  io.use(runtime.socketRooms.middleware);
  io.on("connection", function handleAuthenticatedConnection() {});
  runtime.app.set("io", io);
  let closePromise = null;

  function rejectAfterClose(error) {
    return close().then(
      () => Promise.reject(error),
      () => Promise.reject(error)
    );
  }

  function listen({ port, host } = {}) {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      return rejectAfterClose(
        new TypeError("target HTTP server requires a valid port")
      );
    }
    if (
      host !== undefined &&
      (typeof host !== "string" || host.trim() === "")
    ) {
      return rejectAfterClose(
        new TypeError("target HTTP server requires a valid host")
      );
    }
    return new Promise((resolve, reject) => {
      function onError(error) {
        server.off("listening", onListening);
        rejectAfterClose(error).catch(reject);
      }
      function onListening() {
        server.off("error", onError);
        try {
          if (typeof runtime?.health?.markReady === "function") {
            runtime.health.markReady();
          }
          resolve(server.address());
        } catch (error) {
          rejectAfterClose(error).catch(reject);
        }
      }
      server.once("error", onError);
      server.once("listening", onListening);
      if (host === undefined) server.listen(port);
      else server.listen(port, host);
    });
  }

  async function closeResources() {
    const errors = [];
    let serverClosePromise = null;
    function isAlreadyClosed(error) {
      return error?.code === "ERR_SERVER_NOT_RUNNING";
    }
    try {
      if (server.listening) {
        serverClosePromise = new Promise((resolve, reject) => {
          server.close((error) => {
            if (isAlreadyClosed(error)) {
              resolve();
              return;
            }
            if (error) reject(error);
            else resolve();
          });
        });
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (typeof runtime?.scheduler?.close === "function") {
        await runtime.scheduler.close();
      } else if (
        typeof runtime?.services?.accountEmail?.job?.close === "function"
      ) {
        await runtime.services.accountEmail.job.close();
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await new Promise((resolve, reject) => {
        io.close((error) => {
          if (isAlreadyClosed(error)) resolve();
          else if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      errors.push(error);
    }
    if (serverClosePromise) {
      try {
        await serverClosePromise;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (typeof runtime.close === "function") {
        await runtime.close();
      }
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "target HTTP server shutdown failed"
      );
    }
  }

  function close() {
    if (closePromise) return closePromise;
    if (typeof runtime?.health?.markStopping === "function") {
      runtime.health.markStopping();
    }
    closePromise = closeResources();
    return closePromise;
  }

  return Object.freeze({ close, io, listen, server });
}

module.exports = { createTargetHttpServer };
