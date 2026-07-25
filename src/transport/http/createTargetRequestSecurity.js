const crypto = require("node:crypto");

const ALLOWED_METHODS = Object.freeze([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const PREFLIGHT_METHODS = new Set(
  ALLOWED_METHODS.filter(
    (method) => method !== "OPTIONS"
  )
);
const ALLOWED_HEADERS = Object.freeze([
  "Content-Type",
  "X-CSRF-Token",
  "If-Match",
  "Idempotency-Key",
]);
const ALLOWED_HEADER_NAMES = new Set(
  ALLOWED_HEADERS.map((header) =>
    header.toLowerCase()
  )
);
const UNSAFE_METHODS = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const FETCH_SITES = new Set([
  "same-origin",
  "same-site",
  "cross-site",
]);
const FETCH_MODES = new Set([
  "cors",
  "same-origin",
]);
const DEFAULT_PREFLIGHT_MAX_AGE_SECONDS = 600;
const SESSION_BOOTSTRAP_STATE = Symbol(
  "hundo.sessionBootstrap"
);
const AUTHENTICATED_SESSION_STATE = Symbol(
  "hundo.authenticatedSession"
);
const REQUEST_ID_STATE = Symbol(
  "hundo.requestId"
);

const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=()",
  "Cache-Control": "no-store",
});

const SAFE_MESSAGES = Object.freeze({
  ORIGIN_NOT_ALLOWED:
    "The browser origin is not allowed.",
  CORS_PREFLIGHT_INVALID:
    "The browser preflight is not allowed.",
  CONTENT_TYPE_INVALID:
    "This endpoint requires JSON.",
  FETCH_METADATA_INVALID:
    "The browser request context is not allowed.",
  SESSION_REQUIRED:
    "A valid session is required.",
  CSRF_INVALID:
    "The request verification token is invalid.",
});

function sendError(request, response, status, code) {
  const requestId = request[REQUEST_ID_STATE];
  return response.status(status).json({
    error: {
      code,
      message: SAFE_MESSAGES[code],
      ...(requestId ? { requestId } : {}),
    },
  });
}

function parseRequestedHeaders(value) {
  if (value === undefined) return [];
  if (typeof value !== "string") return null;
  const entries = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase());
  if (entries.some((entry) => entry === "")) {
    return null;
  }
  return entries;
}

function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  const parts = value
    .split(";")
    .map((part) => part.trim().toLowerCase());
  if (parts[0] !== "application/json") {
    return false;
  }
  if (parts.length === 1) return true;
  return (
    parts.length === 2 &&
    parts[1] === "charset=utf-8"
  );
}

function defineInternalState(
  request,
  key,
  value
) {
  Object.defineProperty(request, key, {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
}

function createTargetRequestSecurity({
  isAllowedOrigin,
  sessionCookie,
  sessionService,
  requestIdFactory = crypto.randomUUID,
  preflightMaxAgeSeconds =
    DEFAULT_PREFLIGHT_MAX_AGE_SECONDS,
} = {}) {
  if (typeof isAllowedOrigin !== "function") {
    throw new TypeError(
      "target request security requires an exact origin predicate"
    );
  }
  if (
    !sessionCookie ||
    typeof sessionCookie.read !== "function"
  ) {
    throw new TypeError(
      "target request security requires a session cookie"
    );
  }
  if (typeof requestIdFactory !== "function") {
    throw new TypeError(
      "target request security requires a request ID factory"
    );
  }

  function assignRequestId(request, response, next) {
    if (Object.hasOwn(request, REQUEST_ID_STATE)) {
      return next();
    }
    let requestId;
    try {
      requestId = requestIdFactory();
    } catch {
      return response.status(500).json({
        error: {
          code: "REQUEST_ID_UNAVAILABLE",
          message: "The request could not be started.",
        },
      });
    }
    if (
      typeof requestId !== "string" ||
      requestId.length < 1 ||
      requestId.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId)
    ) {
      return response.status(500).json({
        error: {
          code: "REQUEST_ID_UNAVAILABLE",
          message: "The request could not be started.",
        },
      });
    }
    defineInternalState(
      request,
      REQUEST_ID_STATE,
      requestId
    );
    return next();
  }
  if (
    !sessionService ||
    typeof sessionService.bootstrap !==
      "function" ||
    typeof sessionService.resolveWithCsrf !==
      "function"
  ) {
    throw new TypeError(
      "target request security requires a session service"
    );
  }
  if (
    !Number.isSafeInteger(
      preflightMaxAgeSeconds
    ) ||
    preflightMaxAgeSeconds < 0 ||
    preflightMaxAgeSeconds >
      DEFAULT_PREFLIGHT_MAX_AGE_SECONDS
  ) {
    throw new TypeError(
      "target request security requires a bounded preflight age"
    );
  }

  function securityHeaders(
    request,
    response,
    next
  ) {
    response.set(SECURITY_HEADERS);
    next();
  }

  function credentialedCors(
    request,
    response,
    next
  ) {
    const origin = request.get("origin");
    const allowed =
      typeof origin === "string" &&
      isAllowedOrigin(origin);

    response.vary("Origin");
    if (allowed) {
      response.set(
        "Access-Control-Allow-Origin",
        origin
      );
      response.set(
        "Access-Control-Allow-Credentials",
        "true"
      );
    }

    if (request.method !== "OPTIONS") {
      return next();
    }
    if (!allowed) {
      return sendError(
        request,
        response,
        403,
        "ORIGIN_NOT_ALLOWED"
      );
    }

    const requestedMethod = request.get(
      "access-control-request-method"
    );
    const requestedHeaders =
      parseRequestedHeaders(
        request.get(
          "access-control-request-headers"
        )
      );
    if (
      typeof requestedMethod !== "string" ||
      !PREFLIGHT_METHODS.has(
        requestedMethod.toUpperCase()
      ) ||
      requestedHeaders === null ||
      requestedHeaders.some(
        (header) =>
          !ALLOWED_HEADER_NAMES.has(header)
      )
    ) {
      return sendError(
        request,
        response,
        403,
        "CORS_PREFLIGHT_INVALID"
      );
    }

    response.set(
      "Access-Control-Allow-Methods",
      ALLOWED_METHODS.join(", ")
    );
    response.set(
      "Access-Control-Allow-Headers",
      ALLOWED_HEADERS.join(", ")
    );
    response.set(
      "Access-Control-Max-Age",
      String(preflightMaxAgeSeconds)
    );
    return response.status(204).end();
  }

  function requireAllowedOrigin(
    request,
    response,
    next
  ) {
    const origin = request.get("origin");
    if (
      typeof origin !== "string" ||
      !isAllowedOrigin(origin)
    ) {
      return sendError(
        request,
        response,
        403,
        "ORIGIN_NOT_ALLOWED"
      );
    }
    return next();
  }

  function requireJson(
    request,
    response,
    next
  ) {
    if (!UNSAFE_METHODS.has(request.method)) {
      return next();
    }
    if (
      !isJsonContentType(
        request.get("content-type")
      )
    ) {
      return sendError(
        request,
        response,
        415,
        "CONTENT_TYPE_INVALID"
      );
    }
    return next();
  }

  function requireCompatibleFetchMetadata(
    request,
    response,
    next
  ) {
    if (!UNSAFE_METHODS.has(request.method)) {
      return next();
    }
    const site = request.get("sec-fetch-site");
    const mode = request.get("sec-fetch-mode");
    const destination = request.get(
      "sec-fetch-dest"
    );
    if (
      (site !== undefined &&
        !FETCH_SITES.has(site)) ||
      (mode !== undefined &&
        !FETCH_MODES.has(mode)) ||
      (destination !== undefined &&
        destination !== "empty")
    ) {
      return sendError(
        request,
        response,
        403,
        "FETCH_METADATA_INVALID"
      );
    }
    return next();
  }

  function readSessionToken(request) {
    try {
      return sessionCookie.read(
        request.get("cookie")
      );
    } catch {
      return null;
    }
  }

  function authenticateBootstrap(
    request,
    response,
    next
  ) {
    const rawSessionToken =
      readSessionToken(request);
    if (!rawSessionToken) {
      return sendError(
        request,
        response,
        401,
        "SESSION_REQUIRED"
      );
    }
    const bootstrap =
      sessionService.bootstrap(
        rawSessionToken
      );
    if (!bootstrap?.valid) {
      return sendError(
        request,
        response,
        401,
        "SESSION_REQUIRED"
      );
    }
    defineInternalState(
      request,
      SESSION_BOOTSTRAP_STATE,
      bootstrap
    );
    return next();
  }

  function authenticateUnsafe(
    request,
    response,
    next
  ) {
    const rawSessionToken =
      readSessionToken(request);
    if (!rawSessionToken) {
      return sendError(
        request,
        response,
        401,
        "SESSION_REQUIRED"
      );
    }
    const resolution =
      sessionService.resolveWithCsrf({
        rawSessionToken,
        rawCsrfToken: request.get(
          "x-csrf-token"
        ),
      });
    if (
      !resolution?.valid &&
      resolution?.code === "CSRF_INVALID"
    ) {
      return sendError(
        request,
        response,
        403,
        "CSRF_INVALID"
      );
    }
    if (!resolution?.valid) {
      return sendError(
        request,
        response,
        401,
        "SESSION_REQUIRED"
      );
    }
    defineInternalState(
      request,
      AUTHENTICATED_SESSION_STATE,
      resolution
    );
    return next();
  }

  function getSessionBootstrap(request) {
    return request[SESSION_BOOTSTRAP_STATE] || null;
  }

  function getAuthenticatedSession(request) {
    return (
      request[AUTHENTICATED_SESSION_STATE] ||
      null
    );
  }

  function getRequestId(request) {
    return request[REQUEST_ID_STATE] || null;
  }

  return Object.freeze({
    assignRequestId,
    authenticateBootstrap,
    authenticateUnsafe,
    credentialedCors,
    getAuthenticatedSession,
    getRequestId,
    getSessionBootstrap,
    requireAllowedOrigin,
    requireCompatibleFetchMetadata,
    requireJson,
    securityHeaders,
  });
}

module.exports = {
  ALLOWED_HEADERS,
  ALLOWED_METHODS,
  DEFAULT_PREFLIGHT_MAX_AGE_SECONDS,
  SECURITY_HEADERS,
  createTargetRequestSecurity,
  isJsonContentType,
  parseRequestedHeaders,
};
