const net = require("node:net");

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.unref();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = probe.address();
      const port =
        address && typeof address === "object" ? address.port : null;

      probe.close((error) => {
        if (error) return reject(error);
        if (!Number.isInteger(port) || port <= 0) {
          return reject(new Error("OS did not provide an available port"));
        }
        resolve(port);
      });
    });
  });
}

module.exports = { findAvailablePort };
