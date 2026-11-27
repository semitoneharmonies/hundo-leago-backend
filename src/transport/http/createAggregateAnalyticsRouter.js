"use strict";

const express = require("express");
const { validateAggregateInput } = require("../../analytics/createAggregateAnalyticsStore");

const COLLECT_PATH = "/api/v1/analytics/aggregate";
const READ_PATH = "/api/v1/admin/analytics";
const aggregateAnalyticsEndpoints = Object.freeze([["POST", COLLECT_PATH], ["GET", READ_PATH]]);
const HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function createAggregateAnalyticsRouter({
  store = null, adminSecurity, platformAuthorization, isAllowedOrigin, clock = Date.now, maxRequestsPerMinute = 6000,
} = {}) {
  if (!adminSecurity || !platformAuthorization || typeof isAllowedOrigin !== "function" ||
      typeof clock !== "function" || !Number.isSafeInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1) {
    throw new TypeError("Aggregate analytics requires storage and authorization boundaries.");
  }
  const analyticsStore = store || { record() { throw new Error("Analytics unavailable."); }, read() { throw new Error("Analytics unavailable."); } };
  const router = express.Router();
  let rateWindow = null;
  let rateCount = 0;
  const fail = (response, status, code, message, requestId) => response.status(status).json({ error: { code, message, ...(requestId ? { requestId } : {}) } });

  // Collection never resolves a session, uses a network digest, or logs a request.
  router.use((request, response, next) => {
    if (request.path === READ_PATH) {
      return adminSecurity.assignRequestId(request, response, () =>
        adminSecurity.securityHeaders(request, response, () =>
          adminSecurity.credentialedCors(request, response, () =>
            adminSecurity.requireAllowedOrigin(request, response, next))));
    }
    if (request.path !== COLLECT_PATH) return next();
    response.set(HEADERS);
    const origin = request.get("origin");
    response.vary("Origin");
    if (typeof origin !== "string" || !isAllowedOrigin(origin)) {
      return fail(response, 403, "ORIGIN_NOT_ALLOWED", "The browser origin is not allowed.");
    }
    response.set("Access-Control-Allow-Origin", origin);
    if (Object.keys(request.query).length || request.get("cookie") !== undefined ||
        request.get("authorization") !== undefined) {
      return fail(response, 400, "ANALYTICS_INPUT_INVALID", "Only anonymous aggregate counts are accepted.");
    }
    if (request.method === "OPTIONS") {
      const method = request.get("access-control-request-method");
      const headers = request.get("access-control-request-headers");
      if (method !== "POST" || (headers && headers.split(",").some(header => header.trim().toLowerCase() !== "content-type"))) {
        return fail(response, 403, "CORS_PREFLIGHT_INVALID", "The browser preflight is not allowed.");
      }
      response.set({ "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600" });
      return response.status(204).end();
    }
    if (request.method !== "POST") return next();
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.get("content-type") || "") ||
        (request.get("sec-fetch-mode") && !["cors", "same-origin"].includes(request.get("sec-fetch-mode"))) ||
        (request.get("sec-fetch-dest") && request.get("sec-fetch-dest") !== "empty")) {
      return fail(response, 415, "ANALYTICS_INPUT_INVALID", "A JSON aggregate count is required.");
    }
    return next();
  });

  router.post(COLLECT_PATH, express.json({ limit: 512, strict: true, inflate: false }), (request, response) => {
    try { validateAggregateInput(request.body); }
    catch { return fail(response, 400, "ANALYTICS_INPUT_INVALID", "The aggregate count is invalid."); }
    const window = Math.floor(clock() / 60000);
    if (rateWindow !== window) { rateWindow = window; rateCount = 0; }
    if (rateCount >= maxRequestsPerMinute) {
      response.set("Retry-After", "60");
      return fail(response, 429, "ANALYTICS_RATE_LIMITED", "Analytics collection is temporarily busy.");
    }
    rateCount += 1;
    try {
      analyticsStore.record(request.body);
      return response.status(204).end();
    } catch {
      return fail(response, 503, "ANALYTICS_UNAVAILABLE", "Analytics collection is temporarily unavailable.");
    }
  });

  router.get(READ_PATH, adminSecurity.authenticateBootstrap, (request, response) => {
    try {
      platformAuthorization.requireAdministrator(adminSecurity.getSessionBootstrap(request));
    } catch {
      return fail(response, 403, "PLATFORM_ADMINISTRATOR_REQUIRED", "Platform-administrator authority is required.", adminSecurity.getRequestId(request));
    }
    if (Object.keys(request.query).some(key => key !== "days") ||
        (request.query.days !== undefined && !["7", "28", "90"].includes(request.query.days))) {
      return fail(response, 400, "ANALYTICS_INPUT_INVALID", "Choose 7, 28 or 90 days.", adminSecurity.getRequestId(request));
    }
    try {
      return response.status(200).json({ data: analyticsStore.read(request.query.days === undefined ? 28 : Number(request.query.days)),
        meta: { requestId: adminSecurity.getRequestId(request) } });
    } catch {
      return fail(response, 503, "ANALYTICS_UNAVAILABLE", "Analytics could not be loaded. Try again shortly.", adminSecurity.getRequestId(request));
    }
  });

  // Express body-parser errors must not reach a generic handler that logs request data.
  router.use((error, request, response, next) => {
    if (request.path !== COLLECT_PATH) return next(error);
    return fail(response, error?.type === "entity.too.large" ? 413 : 400,
      "ANALYTICS_INPUT_INVALID", "The aggregate count is invalid.");
  });
  return router;
}

module.exports = { createAggregateAnalyticsRouter, aggregateAnalyticsEndpoints };
