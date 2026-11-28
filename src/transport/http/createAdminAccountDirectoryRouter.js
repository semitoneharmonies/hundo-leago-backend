"use strict";

const express = require("express");
const { validatePagination } = require("../../infrastructure/persistence/sqlite/SqliteAdminAccountDirectoryReader");
const ACCOUNT_DIRECTORY_PATH = "/api/v1/admin/account-directory";

function parsePagination(query) {
  if (Object.keys(query).some(key => !["limit", "offset", "sort", "direction"].includes(key))) {
    throw new Error("Unexpected account-directory parameter.");
  }
  const input = {};
  for (const key of ["limit", "offset"]) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== "string" || query[key].length > 16 || !/^(0|[1-9][0-9]*)$/.test(query[key])) {
      throw new Error("Invalid account-directory page.");
    }
    input[key] = Number(query[key]);
  }
  for (const key of ["sort", "direction"]) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== "string") throw new Error("Invalid account-directory sort.");
    input[key] = query[key];
  }
  return validatePagination(input);
}

function createAdminAccountDirectoryRouter({ reader = null, requestSecurity, platformAuthorization } = {}) {
  if (!requestSecurity || typeof platformAuthorization?.requireAdministrator !== "function" ||
      (reader !== null && typeof reader?.read !== "function")) {
    throw new TypeError("The account directory requires read-only session and administrator boundaries.");
  }
  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  const fail = (request, response, status, code, message) => response.status(status).json({
    error: { code, message, requestId: requestSecurity.getRequestId(request) },
  });
  router.get(ACCOUNT_DIRECTORY_PATH, requestSecurity.authenticateBootstrap, (request, response) => {
    try { platformAuthorization.requireAdministrator(requestSecurity.getSessionBootstrap(request)); }
    catch { return fail(request, response, 403, "PLATFORM_ADMINISTRATOR_REQUIRED", "Platform-administrator authority is required."); }
    let pagination;
    try { pagination = parsePagination(request.query); }
    catch { return fail(request, response, 400, "ACCOUNT_DIRECTORY_INPUT_INVALID", "Choose a valid account-directory page and sort order."); }
    try {
      if (!reader) throw new Error("The directory reader is unavailable.");
      return response.status(200).json({ data: reader.read(pagination), meta: { requestId: requestSecurity.getRequestId(request) } });
    } catch {
      return fail(request, response, 503, "ACCOUNT_DIRECTORY_UNAVAILABLE", "The account directory could not be loaded. Try again shortly.");
    }
  });
  return router;
}

module.exports = { createAdminAccountDirectoryRouter, ACCOUNT_DIRECTORY_PATH };
