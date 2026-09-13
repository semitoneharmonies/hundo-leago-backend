const express = require("express");

const ROOT_PATH = "/api/v1/operations/statistics";
const ERRORS = Object.freeze({
  PLATFORM_ADMINISTRATOR_REQUIRED: [403, "Platform-administrator authority is required."],
  STATISTICS_OPERATION_INVALID: [400, "The statistics request is invalid."],
  STATISTICS_OPERATION_DISABLED: [503, "Statistics refreshes have not been enabled."],
  STATISTICS_OPERATION_IN_PROGRESS: [409, "A statistics refresh is already running."],
  STATISTICS_OPERATION_NOT_FOUND: [404, "That statistics refresh was not found."],
  STATISTICS_OPERATION_FAILED: [503, "Statistics could not be refreshed. The last successful results remain available."],
});

function createStatisticsOperationsRouter({ requestSecurity, statisticsOperationsService } = {}) {
  for (const method of ["assignRequestId", "securityHeaders", "credentialedCors", "requireAllowedOrigin", "requireCompatibleFetchMetadata", "requireJson", "authenticateUnsafe", "authenticateBootstrap", "getAuthenticatedSession", "getSessionBootstrap", "getRequestId"]) {
    if (typeof requestSecurity?.[method] !== "function") throw new TypeError("Statistics routes require the target request-security boundary.");
  }
  if (!statisticsOperationsService?.refresh || !statisticsOperationsService?.read) throw new TypeError("Statistics routes require an operations service.");
  const router = express.Router();
  router.use(ROOT_PATH, requestSecurity.assignRequestId, requestSecurity.securityHeaders, requestSecurity.credentialedCors, requestSecurity.requireAllowedOrigin, requestSecurity.requireCompatibleFetchMetadata);
  function failure(request, response, error) {
    const code = Object.hasOwn(ERRORS, error?.code) ? error.code : "STATISTICS_OPERATION_FAILED";
    const [status, message] = ERRORS[code];
    return response.status(status).json({ error: { code, message, requestId: requestSecurity.getRequestId(request) } });
  }
  function success(request, response, data) {
    return response.status(200).json({ data, meta: { requestId: requestSecurity.getRequestId(request) } });
  }
  router.post(`${ROOT_PATH}/refresh`, requestSecurity.requireJson, express.json({ limit: "1kb", strict: true }), requestSecurity.authenticateUnsafe, async (request, response) => {
    try { return success(request, response, await statisticsOperationsService.refresh({ authenticated: requestSecurity.getAuthenticatedSession(request), input: request.body })); }
    catch (error) { return failure(request, response, error); }
  });
  router.get(`${ROOT_PATH}/refreshes/:jobId`, requestSecurity.authenticateBootstrap, (request, response) => {
    try { return success(request, response, statisticsOperationsService.read({ authenticated: requestSecurity.getSessionBootstrap(request), jobId: request.params.jobId })); }
    catch (error) { return failure(request, response, error); }
  });
  router.use(ROOT_PATH, (error, request, response, next) => {
    if (response.headersSent) return next(error);
    return failure(request, response, ["entity.parse.failed", "entity.too.large"].includes(error?.type) ? { code: "STATISTICS_OPERATION_INVALID" } : error);
  });
  return router;
}

module.exports = { ROOT_PATH, createStatisticsOperationsRouter };
