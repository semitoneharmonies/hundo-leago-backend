const GENERIC_SIGN_IN_FAILURE = Object.freeze({
  signedIn: false,
  code: "SIGN_IN_FAILED",
});
const {
  createSecurityNotificationOutboxRecord,
} = require("./accountEmailOutbox");

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `sign in requires ${description}`
    );
  }
}

function auditValues(auditContext) {
  if (auditContext === null || auditContext === undefined) {
    return {
      clientMetadataJson: null,
      networkKeyVersion: null,
      networkMetadataDigest: null,
      requestCorrelationId: null,
      unknownAccountDigest: null,
    };
  }
  if (
    typeof auditContext !== "object" ||
    Array.isArray(auditContext)
  ) {
    throw new TypeError("sign-in audit context is invalid");
  }
  const expected = [
    "clientMetadataJson",
    "networkKeyVersion",
    "networkMetadataDigest",
    "requestCorrelationId",
    "unknownAccountDigest",
  ];
  const keys = Object.keys(auditContext).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("sign-in audit context is invalid");
  }
  return auditContext;
}

function auditRecord({
  id,
  audit,
  nowMs,
  outcome,
  reasonCode,
  sessionId,
  user,
}) {
  return {
    id,
    event_type: "account.sign_in",
    outcome,
    actor_user_id: user?.id || null,
    target_user_id: user?.id || null,
    league_id: null,
    session_id: sessionId,
    request_correlation_id:
      audit.requestCorrelationId,
    reason_code: reasonCode,
    network_key_version:
      audit.networkKeyVersion,
    network_metadata_digest:
      audit.networkMetadataDigest,
    client_metadata_json:
      audit.clientMetadataJson,
    unknown_account_digest: user
      ? null
      : audit.unknownAccountDigest,
    occurred_at_ms: nowMs,
  };
}

function internalSuccess({ user, sessionIssue, cleared }) {
  const result = {
    signedIn: true,
    code: "SIGN_IN_SUCCEEDED",
    user: Object.freeze({
      id: user.id,
      displayName: user.display_name,
      status: user.status,
      version: user.version,
    }),
    session: sessionIssue.session,
  };
  for (const [key, value] of Object.entries({
    rawSessionToken: sessionIssue.rawSessionToken,
    rawCsrfToken: sessionIssue.rawCsrfToken,
    rateLimitFailuresCleared: cleared,
  })) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function createSignInService({
  credentialAuthenticationService,
  sessionService,
  auditRepository,
  outboxRepository,
  rateLimiter,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    credentialAuthenticationService,
    "authenticate",
    "a credential-authentication service"
  );
  assertMethod(
    sessionService,
    "issueForUser",
    "a session service"
  );
  assertMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  assertMethod(
    outboxRepository,
    "insertPending",
    "an outbox repository"
  );
  assertMethod(
    rateLimiter,
    "clearSignInAccountFailures",
    "a durable authentication rate limiter"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );

  async function signIn(
    input,
    { auditContext = null, clientMetadata = null } = {}
  ) {
    const audit = auditValues(auditContext);
    const authentication =
      await credentialAuthenticationService.authenticate(
        input
      );
    const nowMs = clock.nowMs();
    const auditId = secureRandom.id();
    if (!authentication.authenticated) {
      auditRepository.append(
        auditRecord({
          id: auditId,
          audit,
          nowMs,
          outcome: "failure",
          reasonCode: authentication.reasonCode,
          sessionId: null,
          user: authentication.user,
        })
      );
      return GENERIC_SIGN_IN_FAILURE;
    }

    const user = authentication.user;
    let cleared = false;
    const sessionIssue = sessionService.issueForUser({
      userId: user.id,
      clientMetadata,
      transactionHook(context) {
        auditRepository.append(
          auditRecord({
            id: auditId,
            audit,
            nowMs,
            outcome: "success",
            reasonCode: null,
            sessionId: context.activeSessionId,
            user,
          })
        );
        if (context.previousSessionId) {
          const outboxId = secureRandom.id();
          outboxRepository.insertPending(
            createSecurityNotificationOutboxRecord({
              id: outboxId,
              userId: user.id,
              notificationKind: "session_replaced",
              nowMs,
            })
          );
        }
        cleared =
          rateLimiter.clearSignInAccountFailures({
            canonicalIdentifier:
              user.email_normalized,
          });
      },
    });
    return internalSuccess({
      user,
      sessionIssue,
      cleared,
    });
  }

  return Object.freeze({ signIn });
}

module.exports = {
  GENERIC_SIGN_IN_FAILURE,
  createSignInService,
};
