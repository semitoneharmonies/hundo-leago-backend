const http = require("node:http");
const { Server: SocketServer } = require("socket.io");

function createHttpServer({
  app,
  isAllowedOrigin,
  httpModule = http,
  SocketServerClass = SocketServer,
} = {}) {
  if (!app) {
    throw new TypeError("createHttpServer requires an Express application");
  }
  if (typeof isAllowedOrigin !== "function") {
    throw new TypeError(
      "createHttpServer requires an isAllowedOrigin function"
    );
  }

  const server = httpModule.createServer(app);
  const io = new SocketServerClass(server, {
    cors: {
      origin(origin, callback) {
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error("Socket CORS blocked: " + origin));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });
  app.set("io", io);
  io.on("connection", function handleCompatibilityConnection() {});

  function listen({ port, host } = {}) {
    return new Promise((resolve, reject) => {
      function onError(error) {
        server.off("listening", onListening);
        reject(error);
      }

      function onListening() {
        server.off("error", onError);
        resolve(server.address());
      }

      server.once("error", onError);
      server.once("listening", onListening);

      if (host === undefined) {
        server.listen(port);
      } else {
        server.listen(port, host);
      }
    });
  }

  return {
    server,
    io,
    listen,
  };
}

module.exports = { createHttpServer };
