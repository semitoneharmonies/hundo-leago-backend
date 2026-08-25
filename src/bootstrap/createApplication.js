const cors = require("cors");
const express = require("express");

function createApplication({
  isAllowedOrigin,
  bodyLimit = "10mb",
  expressModule = express,
  corsMiddleware = cors,
} = {}) {
  if (typeof isAllowedOrigin !== "function") {
    throw new TypeError(
      "createApplication requires an isAllowedOrigin function"
    );
  }

  const app = expressModule();
  app.disable("x-powered-by");

  app.use(
    corsMiddleware({
      origin(origin, callback) {
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error("CORS blocked: " + origin));
      },
      credentials: true,
    })
  );

  app.use(expressModule.json({ limit: bodyLimit }));
  app.use(
    expressModule.urlencoded({
      extended: true,
      limit: bodyLimit,
    })
  );

  return app;
}

module.exports = { createApplication };
