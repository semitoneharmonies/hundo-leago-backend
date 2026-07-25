const express = require("express");

const {
  normalizeEmail,
} = require(
  "../../domain/accounts/accountRegistrationPolicy"
);

const SAFE_MESSAGES = Object.freeze({
  ACCOUNT_REGISTRATION_INVALID:
    "Check the account details and try again.",
  CREDENTIAL_SETUP_INVALID:
    "The credential-setup link is invalid or expired.",
  CREDENTIAL_SETUP_PASSWORD_INVALID:
    "Check the password and try again.",
  EMAIL_VERIFICATION_INVALID:
    "The verification link is invalid or expired.",
  REQUEST_BODY_INVALID:
    "The request body is invalid.",
  RATE_LIMITED:
    "Too many requests. Try again later.",
  ACCOUNT_REQUEST_FAILED:
    "The account request could not be completed.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `account registration routes require ${description}`
    );
  }
}

function exactBody(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (key, index) => key === expected[index]
    )
  );
}

function createAccountRegistrationRouter({
  requestSecurity,
  registrationService,
  verificationService,
  verificationRequestService,
  credentialSetupService,
  rateLimiter,
  sessionCookie,
  networkSourceResolver = (request) => request.ip,
} = {}) {
  for (const method of [
    "assignRequestId",
    "credentialedCors",
    "getRequestId",
    "requireAllowedOrigin",
    "requireCompatibleFetchMetadata",
    "requireJson",
    "securityHeaders",
  ]) {
    assertMethod(
      requestSecurity,
      method,
      "the target request-security boundary"
    );
  }
  assertMethod(
    registrationService,
    "register",
    "a registration service"
  );
  assertMethod(
    verificationService,
    "verify",
    "an email-verification service"
  );
  assertMethod(
    verificationRequestService,
    "request",
    "a verification-request service"
  );
  assertMethod(
    credentialSetupService,
    "complete",
    "a credential-setup service"
  );
  for (const method of ["check", "recordAttempt"]) {
    assertMethod(
      rateLimiter,
      method,
      "a durable authentication rate limiter"
    );
  }
  assertMethod(
    sessionCookie,
    "serialize",
    "a session cookie"
  );
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "account registration routes require a network-source resolver"
    );
  }

  function requestId(request) {
    return requestSecurity.getRequestId(request);
  }

  function errorResponse(
    request,
    response,
    status,
    code,
    { retryAfterSeconds = 0 } = {}
  ) {
    if (retryAfterSeconds > 0) {
      response.set(
        "Retry-After",
        String(retryAfterSeconds)
      );
    }
    return response.status(status).json({
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: requestId(request),
      },
    });
  }

  function successResponse(
    request,
    response,
    status,
    data
  ) {
    return response.status(status).json({
      data,
      meta: { requestId: requestId(request) },
    });
  }

  function canonicalNetworkSource(request) {
    const value = networkSourceResolver(request);
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 128 ||
      value !== value.trim()
    ) {
      throw new TypeError(
        "the canonical network source is unavailable"
      );
    }
    return value;
  }

  function rateIdentities(
    request,
    action,
    subject
  ) {
    return [
      {
        action,
        bucket: "network",
        canonicalIdentifier:
          canonicalNetworkSource(request),
      },
      {
        action,
        bucket: "subject",
        canonicalIdentifier: subject,
      },
    ];
  }

  function checkRateLimit(request, response, identities) {
    const results = identities.map((identity) =>
      rateLimiter.check(identity)
    );
    const retryAfterSeconds = Math.max(
      0,
      ...results.map(
        (result) => result.retryAfterSeconds || 0
      )
    );
    if (results.some((result) => !result.allowed)) {
      errorResponse(
        request,
        response,
        429,
        "RATE_LIMITED",
        { retryAfterSeconds }
      );
      return false;
    }
    return true;
  }

  function recordAttempts(identities, failed = false) {
    for (const identity of identities) {
      rateLimiter.recordAttempt({
        ...identity,
        failed:
          identity.bucket === "subject"
            ? failed
            : false,
      });
    }
  }

  function emailSubject(body) {
    try {
      return normalizeEmail(body?.email).normalized;
    } catch {
      return "invalid_email_input";
    }
  }

  function tokenSubject(body) {
    return typeof body?.token === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(body.token)
      ? body.token
      : "invalid_action_token";
  }

  function auditContext(request) {
    return {
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "unknown",
        origin: request.get("origin"),
      }),
      networkKeyVersion: null,
      networkMetadataDigest: null,
      requestCorrelationId: requestId(request),
    };
  }

  function sessionClientMetadata(request) {
    return {
      networkSourceCategory: "unknown",
      origin: request.get("origin"),
    };
  }

  const router = express.Router();
  router.use(requestSecurity.assignRequestId);
  router.use(requestSecurity.securityHeaders);
  router.use(requestSecurity.credentialedCors);
  router.use(requestSecurity.requireAllowedOrigin);
  router.use(requestSecurity.requireJson);
  router.use(
    requestSecurity.requireCompatibleFetchMetadata
  );
  router.use(
    express.json({
      limit: "16kb",
      strict: true,
    })
  );

  router.post(
    "/api/v1/accounts",
    async (request, response) => {
      const identities = rateIdentities(
        request,
        "sign_up",
        emailSubject(request.body)
      );
      if (!checkRateLimit(request, response, identities)) {
        return;
      }
      recordAttempts(identities);
      try {
        const result = await registrationService.register(
          request.body,
          { auditContext: auditContext(request) }
        );
        successResponse(request, response, 202, {
          accepted: result.accepted,
        });
      } catch (error) {
        if (
          [
            "ACCOUNT_REGISTRATION_INPUT_INVALID",
            "PASSWORD_POLICY_INVALID",
          ].includes(error?.code)
        ) {
          errorResponse(
            request,
            response,
            422,
            "ACCOUNT_REGISTRATION_INVALID"
          );
          return;
        }
        errorResponse(
          request,
          response,
          500,
          "ACCOUNT_REQUEST_FAILED"
        );
      }
    }
  );

  router.post(
    "/api/v1/accounts/email-verifications",
    (request, response) => {
      if (!exactBody(request.body, ["token"])) {
        errorResponse(
          request,
          response,
          400,
          "REQUEST_BODY_INVALID"
        );
        return;
      }
      const identities = rateIdentities(
        request,
        "action_token_completion",
        tokenSubject(request.body)
      );
      if (!checkRateLimit(request, response, identities)) {
        return;
      }
      const result = verificationService.verify({
        rawToken: request.body.token,
        clientMetadata:
          sessionClientMetadata(request),
        auditContext: auditContext(request),
      });
      recordAttempts(identities, !result.verified);
      if (!result.verified) {
        errorResponse(
          request,
          response,
          400,
          "EMAIL_VERIFICATION_INVALID"
        );
        return;
      }
      response.set(
        "Set-Cookie",
        sessionCookie.serialize(
          result.rawSessionToken
        )
      );
      successResponse(request, response, 200, {
        csrfToken: result.rawCsrfToken,
        session: result.session,
        user: result.user,
      });
    }
  );

  router.post(
    "/api/v1/accounts/email-verification-requests",
    (request, response) => {
      if (!exactBody(request.body, ["email"])) {
        errorResponse(
          request,
          response,
          400,
          "REQUEST_BODY_INVALID"
        );
        return;
      }
      const identities = rateIdentities(
        request,
        "verification_resend",
        emailSubject(request.body)
      );
      if (!checkRateLimit(request, response, identities)) {
        return;
      }
      recordAttempts(identities);
      try {
        const result = verificationRequestService.request(
          request.body,
          { auditContext: auditContext(request) }
        );
        successResponse(request, response, 202, {
          accepted: result.accepted,
        });
      } catch (error) {
        if (
          error?.code ===
          "ACCOUNT_REGISTRATION_INPUT_INVALID"
        ) {
          errorResponse(
            request,
            response,
            422,
            "ACCOUNT_REGISTRATION_INVALID"
          );
          return;
        }
        errorResponse(
          request,
          response,
          500,
          "ACCOUNT_REQUEST_FAILED"
        );
      }
    }
  );

  router.post(
    "/api/v1/accounts/credential-setups",
    async (request, response) => {
      if (
        !exactBody(request.body, [
          "password",
          "passwordConfirmation",
          "token",
        ])
      ) {
        errorResponse(
          request,
          response,
          400,
          "REQUEST_BODY_INVALID"
        );
        return;
      }
      const identities = rateIdentities(
        request,
        "action_token_completion",
        tokenSubject(request.body)
      );
      if (!checkRateLimit(request, response, identities)) {
        return;
      }
      try {
        const result = await credentialSetupService.complete(
          request.body,
          { auditContext: auditContext(request) }
        );
        recordAttempts(identities, !result.completed);
        if (!result.completed) {
          errorResponse(
            request,
            response,
            400,
            "CREDENTIAL_SETUP_INVALID"
          );
          return;
        }
        successResponse(request, response, 200, {
          signedOut: result.signedOut,
          user: result.user,
        });
      } catch (error) {
        if (error?.code === "PASSWORD_POLICY_INVALID") {
          errorResponse(
            request,
            response,
            422,
            "CREDENTIAL_SETUP_PASSWORD_INVALID"
          );
          return;
        }
        errorResponse(
          request,
          response,
          500,
          "ACCOUNT_REQUEST_FAILED"
        );
      }
    }
  );

  router.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    errorResponse(
      request,
      response,
      error?.type === "entity.parse.failed" ? 400 : 500,
      error?.type === "entity.parse.failed"
        ? "REQUEST_BODY_INVALID"
        : "ACCOUNT_REQUEST_FAILED"
    );
  });

  return router;
}

module.exports = {
  SAFE_MESSAGES,
  createAccountRegistrationRouter,
  exactBody,
};
