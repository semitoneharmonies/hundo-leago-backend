const express = require("express");

const {
  normalizeEmail,
} = require(
  "../../domain/accounts/accountRegistrationPolicy"
);

const SAFE_MESSAGES = Object.freeze({
  ACCOUNT_REQUEST_FAILED:
    "The account request could not be completed.",
  ACCOUNT_DEACTIVATION_DENIED:
    "The account could not be deactivated with the submitted credentials.",
  ACCOUNT_DEACTIVATION_INVALID:
    "The account-deactivation confirmation is invalid.",
  ACCOUNT_REACTIVATION_INVALID:
    "The account-reactivation request is invalid or expired.",
  RATE_LIMITED:
    "Too many requests. Try again later.",
  REQUEST_BODY_INVALID:
    "The request body is invalid.",
  PASSWORD_CHANGE_DENIED:
    "The current password was not accepted.",
  PASSWORD_CHANGE_INVALID:
    "The new password details are invalid.",
  PASSWORD_RESET_INVALID:
    "The password-reset request is invalid or expired.",
  SIGN_IN_FAILED:
    "The email or password is incorrect, or the account cannot sign in.",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `account session routes require ${description}`
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

function createAccountSessionRouter({
  requestSecurity,
  signInService,
  signOutService,
  passwordChangeService,
  passwordResetRequestService,
  passwordResetService,
  accountDeactivationService,
  reactivationRequestService,
  reactivationService,
  rateLimiter,
  auditPrivacyDigest,
  sessionCookie,
  networkSourceResolver = (request) => request.ip,
} = {}) {
  for (const method of [
    "assignRequestId",
    "authenticateBootstrap",
    "authenticateUnsafe",
    "credentialedCors",
    "getAuthenticatedSession",
    "getRequestId",
    "getSessionBootstrap",
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
    signInService,
    "signIn",
    "a sign-in service"
  );
  assertMethod(
    signOutService,
    "signOut",
    "a sign-out service"
  );
  assertMethod(
    passwordChangeService,
    "change",
    "a password-change service"
  );
  assertMethod(
    passwordResetRequestService,
    "request",
    "a password-reset request service"
  );
  assertMethod(
    passwordResetService,
    "reset",
    "a password-reset service"
  );
  assertMethod(
    accountDeactivationService,
    "deactivate",
    "an account-deactivation service"
  );
  assertMethod(
    reactivationRequestService,
    "request",
    "a reactivation-request service"
  );
  assertMethod(
    reactivationService,
    "reactivate",
    "an account-reactivation service"
  );
  for (const method of ["check", "recordAttempt"]) {
    assertMethod(
      rateLimiter,
      method,
      "a durable authentication rate limiter"
    );
  }
  assertMethod(
    auditPrivacyDigest,
    "digest",
    "an audit privacy digest"
  );
  for (const method of ["clear", "serialize"]) {
    assertMethod(
      sessionCookie,
      method,
      "a session cookie"
    );
  }
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError(
      "account session routes require a network-source resolver"
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
    data
  ) {
    return response.status(200).json({
      data,
      meta: { requestId: requestId(request) },
    });
  }

  function networkSource(request) {
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

  function rateIdentity(action, bucket, identifier) {
    return {
      action,
      bucket,
      canonicalIdentifier: identifier,
    };
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

  function recordAttempt(identity, failed) {
    return rateLimiter.recordAttempt({
      ...identity,
      failed,
    });
  }

  function auditContext(request, subject) {
    const network = auditPrivacyDigest.digest(
      `network\0${networkSource(request)}`
    );
    const unknownAccount = auditPrivacyDigest.digest(
      `account\0${subject}`
    );
    if (
      network.keyVersion !==
      unknownAccount.keyVersion
    ) {
      throw new Error(
        "Audit privacy key versions are inconsistent."
      );
    }
    return {
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "unknown",
        origin: request.get("origin"),
      }),
      networkKeyVersion: network.keyVersion,
      networkMetadataDigest: network.digest,
      requestCorrelationId: requestId(request),
      unknownAccountDigest: unknownAccount.digest,
    };
  }

  function clientMetadata(request) {
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
    express.json({ limit: "16kb", strict: true })
  );

  router.post("/api/v1/session", async (request, response) => {
    if (!exactBody(request.body, ["email", "password"])) {
      errorResponse(
        request,
        response,
        400,
        "REQUEST_BODY_INVALID"
      );
      return;
    }
    const subject = emailSubject(request.body);
    const networkIdentity = rateIdentity(
      "sign_in",
      "network",
      networkSource(request)
    );
    const subjectIdentity = rateIdentity(
      "sign_in",
      "subject",
      subject
    );
    if (
      !checkRateLimit(request, response, [
        networkIdentity,
        subjectIdentity,
      ])
    ) {
      return;
    }
    const networkRecorded = recordAttempt(
      networkIdentity,
      false
    );
    if (!networkRecorded.allowed) {
      errorResponse(
        request,
        response,
        429,
        "RATE_LIMITED",
        {
          retryAfterSeconds:
            networkRecorded.retryAfterSeconds,
        }
      );
      return;
    }

    try {
      const result = await signInService.signIn(
        request.body,
        {
          auditContext: auditContext(
            request,
            subject
          ),
          clientMetadata: clientMetadata(request),
        }
      );
      if (!result.signedIn) {
        const recorded = recordAttempt(
          subjectIdentity,
          true
        );
        if (!recorded.allowed) {
          errorResponse(
            request,
            response,
            429,
            "RATE_LIMITED",
            {
              retryAfterSeconds:
                recorded.retryAfterSeconds,
            }
          );
          return;
        }
        errorResponse(
          request,
          response,
          401,
          "SIGN_IN_FAILED"
        );
        return;
      }
      response.set(
        "Set-Cookie",
        sessionCookie.serialize(
          result.rawSessionToken
        )
      );
      successResponse(request, response, {
        csrfToken: result.rawCsrfToken,
        session: result.session,
        user: result.user,
      });
    } catch (error) {
      errorResponse(
        request,
        response,
        error?.retryable === true ? 503 : 500,
        "ACCOUNT_REQUEST_FAILED"
      );
    }
  });

  router.get(
    "/api/v1/session",
    requestSecurity.authenticateBootstrap,
    (request, response) => {
      const bootstrap =
        requestSecurity.getSessionBootstrap(
          request
        );
      successResponse(request, response, {
        csrfToken: bootstrap.rawCsrfToken,
        session: bootstrap.session,
        user: bootstrap.user,
      });
    }
  );

  router.delete(
    "/api/v1/session",
    requestSecurity.authenticateUnsafe,
    (request, response) => {
      const authenticated =
        requestSecurity.getAuthenticatedSession(
          request
        );
      try {
        const result = signOutService.signOut({
          session: authenticated.session,
          user: authenticated.user,
          auditContext: auditContext(
            request,
            authenticated.user.id
          ),
        });
        response.set(
          "Set-Cookie",
          sessionCookie.clear()
        );
        successResponse(request, response, result);
      } catch {
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
    "/api/v1/session/password",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      if (
        !exactBody(request.body, [
          "currentPassword",
          "newPassword",
          "newPasswordConfirmation",
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
      const authenticated =
        requestSecurity.getAuthenticatedSession(
          request
        );
      const identity = rateIdentity(
        "password_change",
        "subject",
        authenticated.user.id
      );
      if (
        !checkRateLimit(request, response, [identity])
      ) {
        return;
      }
      const recorded = recordAttempt(identity, false);
      if (!recorded.allowed) {
        errorResponse(
          request,
          response,
          429,
          "RATE_LIMITED",
          {
            retryAfterSeconds:
              recorded.retryAfterSeconds,
          }
        );
        return;
      }
      try {
        const result =
          await passwordChangeService.change({
            input: request.body,
            authenticated,
            auditContext: auditContext(
              request,
              authenticated.user.id
            ),
          });
        if (!result.changed) {
          errorResponse(
            request,
            response,
            403,
            "PASSWORD_CHANGE_DENIED"
          );
          return;
        }
        response.set(
          "Set-Cookie",
          sessionCookie.clear()
        );
        successResponse(request, response, result);
      } catch (error) {
        if (
          [
            "PASSWORD_POLICY_INVALID",
            "PASSWORD_CHANGE_INPUT_INVALID",
            "PASSWORD_CHANGE_NEW_PASSWORD_UNCHANGED",
          ].includes(error?.code)
        ) {
          errorResponse(
            request,
            response,
            422,
            "PASSWORD_CHANGE_INVALID"
          );
          return;
        }
        errorResponse(
          request,
          response,
          error?.retryable === true ? 503 : 500,
          "ACCOUNT_REQUEST_FAILED"
        );
      }
    }
  );

  router.post(
    "/api/v1/password-reset-requests",
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
      const subject = emailSubject(request.body);
      const identities = [
        rateIdentity(
          "password_reset_request",
          "network",
          networkSource(request)
        ),
        rateIdentity(
          "password_reset_request",
          "subject",
          subject
        ),
      ];
      if (!checkRateLimit(request, response, identities)) {
        return;
      }
      for (const identity of identities) {
        const recorded = recordAttempt(identity, false);
        if (!recorded.allowed) {
          errorResponse(
            request,
            response,
            429,
            "RATE_LIMITED",
            {
              retryAfterSeconds:
                recorded.retryAfterSeconds,
            }
          );
          return;
        }
      }
      try {
        const result =
          passwordResetRequestService.request(
            request.body,
            {
              auditContext: auditContext(
                request,
                subject
              ),
            }
          );
        return response.status(202).json({
          data: { accepted: result.accepted },
          meta: { requestId: requestId(request) },
        });
      } catch (error) {
        if (
          [
            "ACCOUNT_REGISTRATION_INPUT_INVALID",
            "ERR_INVALID_ARG_TYPE",
          ].includes(error?.code) ||
          error instanceof TypeError
        ) {
          errorResponse(
            request,
            response,
            422,
            "REQUEST_BODY_INVALID"
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
    "/api/v1/password-resets",
    async (request, response) => {
      if (
        !exactBody(request.body, [
          "newPassword",
          "newPasswordConfirmation",
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
      const identities = [
        rateIdentity(
          "action_token_completion",
          "network",
          networkSource(request)
        ),
        rateIdentity(
          "action_token_completion",
          "subject",
          tokenSubject(request.body)
        ),
      ];
      if (!checkRateLimit(request, response, identities)) {
        return;
      }
      const networkRecorded = recordAttempt(
        identities[0],
        false
      );
      if (!networkRecorded.allowed) {
        errorResponse(
          request,
          response,
          429,
          "RATE_LIMITED",
          {
            retryAfterSeconds:
              networkRecorded.retryAfterSeconds,
          }
        );
        return;
      }
      try {
        const result = await passwordResetService.reset(
          request.body,
          {
            auditContext: auditContext(
              request,
              tokenSubject(request.body)
            ),
          }
        );
        const subjectRecorded = recordAttempt(
          identities[1],
          !result.reset
        );
        if (!subjectRecorded.allowed) {
          errorResponse(
            request,
            response,
            429,
            "RATE_LIMITED",
            {
              retryAfterSeconds:
                subjectRecorded.retryAfterSeconds,
            }
          );
          return;
        }
        if (!result.reset) {
          errorResponse(
            request,
            response,
            400,
            "PASSWORD_RESET_INVALID"
          );
          return;
        }
        response.set(
          "Set-Cookie",
          sessionCookie.clear()
        );
        successResponse(request, response, result);
      } catch (error) {
        if (error?.code === "PASSWORD_POLICY_INVALID") {
          errorResponse(
            request,
            response,
            422,
            "PASSWORD_RESET_INVALID"
          );
          return;
        }
        errorResponse(
          request,
          response,
          error?.retryable === true ? 503 : 500,
          "ACCOUNT_REQUEST_FAILED"
        );
      }
    }
  );

  router.post(
    "/api/v1/account/deactivation",
    requestSecurity.authenticateUnsafe,
    async (request, response) => {
      if (
        !exactBody(request.body, [
          "confirmation",
          "currentPassword",
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
      const authenticated =
        requestSecurity.getAuthenticatedSession(
          request
        );
      const identity = rateIdentity(
        "account_deactivation",
        "subject",
        authenticated.user.id
      );
      if (
        !checkRateLimit(request, response, [identity])
      ) {
        return;
      }
      const recorded = recordAttempt(identity, false);
      if (!recorded.allowed) {
        errorResponse(
          request,
          response,
          429,
          "RATE_LIMITED",
          {
            retryAfterSeconds:
              recorded.retryAfterSeconds,
          }
        );
        return;
      }
      try {
        const result =
          await accountDeactivationService.deactivate({
            input: request.body,
            authenticated,
            auditContext: auditContext(
              request,
              authenticated.user.id
            ),
          });
        if (!result.deactivated) {
          errorResponse(
            request,
            response,
            403,
            "ACCOUNT_DEACTIVATION_DENIED"
          );
          return;
        }
        response.set(
          "Set-Cookie",
          sessionCookie.clear()
        );
        successResponse(request, response, result);
      } catch (error) {
        if (
          [
            "ACCOUNT_DEACTIVATION_INPUT_INVALID",
            "ACCOUNT_DEACTIVATION_CONFIRMATION_INVALID",
          ].includes(error?.code)
        ) {
          errorResponse(
            request,
            response,
            422,
            "ACCOUNT_DEACTIVATION_INVALID"
          );
          return;
        }
        errorResponse(
          request,
          response,
          error?.retryable === true ? 503 : 500,
          "ACCOUNT_REQUEST_FAILED"
        );
      }
    }
  );

  router.post(
    "/api/v1/account/reactivation-requests",
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
      const subject = emailSubject(request.body);
      const identities = [
        rateIdentity(
          "reactivation_request",
          "network",
          networkSource(request)
        ),
        rateIdentity(
          "reactivation_request",
          "subject",
          subject
        ),
      ];
      if (!checkRateLimit(request, response, identities)) {
        return;
      }
      for (const identity of identities) {
        const recorded = recordAttempt(identity, false);
        if (!recorded.allowed) {
          errorResponse(
            request,
            response,
            429,
            "RATE_LIMITED",
            {
              retryAfterSeconds:
                recorded.retryAfterSeconds,
            }
          );
          return;
        }
      }
      try {
        const result =
          reactivationRequestService.request(
            request.body,
            {
              auditContext: auditContext(
                request,
                subject
              ),
            }
          );
        return response.status(202).json({
          data: { accepted: result.accepted },
          meta: { requestId: requestId(request) },
        });
      } catch (error) {
        if (
          error?.code ===
            "ACCOUNT_REGISTRATION_INPUT_INVALID" ||
          error instanceof TypeError
        ) {
          errorResponse(
            request,
            response,
            422,
            "REQUEST_BODY_INVALID"
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
    "/api/v1/account/reactivations",
    async (request, response) => {
      if (
        !exactBody(request.body, [
          "currentPassword",
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
      const identities = [
        rateIdentity(
          "action_token_completion",
          "network",
          networkSource(request)
        ),
        rateIdentity(
          "action_token_completion",
          "subject",
          tokenSubject(request.body)
        ),
      ];
      if (!checkRateLimit(request, response, identities)) {
        return;
      }
      const networkRecorded = recordAttempt(
        identities[0],
        false
      );
      if (!networkRecorded.allowed) {
        errorResponse(
          request,
          response,
          429,
          "RATE_LIMITED",
          {
            retryAfterSeconds:
              networkRecorded.retryAfterSeconds,
          }
        );
        return;
      }
      try {
        const result =
          await reactivationService.reactivate(
            request.body,
            {
              auditContext: auditContext(
                request,
                tokenSubject(request.body)
              ),
            }
          );
        const subjectRecorded = recordAttempt(
          identities[1],
          !result.reactivated
        );
        if (!subjectRecorded.allowed) {
          errorResponse(
            request,
            response,
            429,
            "RATE_LIMITED",
            {
              retryAfterSeconds:
                subjectRecorded.retryAfterSeconds,
            }
          );
          return;
        }
        if (!result.reactivated) {
          errorResponse(
            request,
            response,
            400,
            "ACCOUNT_REACTIVATION_INVALID"
          );
          return;
        }
        response.set(
          "Set-Cookie",
          sessionCookie.clear()
        );
        successResponse(request, response, result);
      } catch (error) {
        errorResponse(
          request,
          response,
          error?.retryable === true ? 503 : 500,
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
  createAccountSessionRouter,
  exactBody,
};
