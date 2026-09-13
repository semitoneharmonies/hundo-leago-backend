const express = require("express");

function createPublicHealthRouter({ healthService } = {}) {
  if (
    !healthService ||
    typeof healthService.readLiveness !== "function" ||
    typeof healthService.readReadiness !== "function"
  ) {
    throw new TypeError("public health routes require a health service");
  }
  const router = express.Router();
  router.use((request, response, next) => {
    response.set({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  router.get("/api/v1/health/live", (request, response) =>
    response.status(200).json({ data: healthService.readLiveness() })
  );
  router.get("/api/v1/health/ready", (request, response) => {
    const readiness = healthService.readReadiness();
    return response
      .status(readiness.status === "ready" ? 200 : 503)
      .json({ data: readiness });
  });
  return router;
}

module.exports = { createPublicHealthRouter };
