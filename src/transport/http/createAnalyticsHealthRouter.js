"use strict";
const express = require("express");
const { HEALTH_GROUPS } = require("../../analytics/readAnalyticsHealth");
const { resolveAnalyticsPeriod } = require("../../analytics/createAggregateAnalyticsStore");
const ANALYTICS_HEALTH_PATH = "/api/v1/admin/analytics/health";
function parseHealthInput(query, nowMs) {
  const keys = Object.keys(query);
  if (!HEALTH_GROUPS.includes(query.group) || keys.some(key => !["group", "days", "week", "month"].includes(key))) throw new Error("Invalid health selection.");
  const selectors = keys.filter(key => key !== "group");
  if (selectors.length > 1) throw new Error("Choose one period.");
  let selection = 28;
  if (selectors.length) {
    const key = selectors[0], value = query[key];
    if (key === "days" && ["7", "28", "90"].includes(value)) selection = Number(value);
    else if (["week", "month"].includes(key) && typeof value === "string") selection = { [key]: value };
    else throw new Error("Invalid period.");
  }
  resolveAnalyticsPeriod(selection, nowMs);
  return { group: query.group, selection };
}
function createAnalyticsHealthRouter({ reader = null, requestSecurity, platformAuthorization, clock = Date.now } = {}) {
  if (!requestSecurity || typeof platformAuthorization?.requireAdministrator !== "function" || typeof clock !== "function" || (reader !== null && typeof reader?.read !== "function")) throw new TypeError("Health details require administrator and read-only session boundaries.");
  const router = express.Router();
  router.use(requestSecurity.assignRequestId, requestSecurity.securityHeaders, requestSecurity.credentialedCors, requestSecurity.requireAllowedOrigin);
  const fail = (request, response, status, code, message) => response.status(status).json({ error: { code, message, requestId: requestSecurity.getRequestId(request) } });
  router.get(ANALYTICS_HEALTH_PATH, requestSecurity.authenticateBootstrap, (request, response) => {
    try { platformAuthorization.requireAdministrator(requestSecurity.getSessionBootstrap(request)); }
    catch { return fail(request, response, 403, "PLATFORM_ADMINISTRATOR_REQUIRED", "Platform-administrator authority is required."); }
    let input;
    try { input = parseHealthInput(request.query, clock()); }
    catch { return fail(request, response, 400, "ANALYTICS_HEALTH_INPUT_INVALID", "Choose a valid health group and analytics period."); }
    try {
      if (!reader) throw new Error("Reader unavailable.");
      return response.status(200).json({ data: reader.read(input), meta: { requestId: requestSecurity.getRequestId(request) } });
    } catch { return fail(request, response, 503, "ANALYTICS_HEALTH_UNAVAILABLE", "Health details could not be loaded. Try again shortly."); }
  });
  return router;
}
module.exports = { createAnalyticsHealthRouter, ANALYTICS_HEALTH_PATH };
