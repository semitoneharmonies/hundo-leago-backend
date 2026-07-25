const INVALID_EMAIL_VERIFICATION_RESULT =
  Object.freeze({
    verified: false,
    code: "EMAIL_VERIFICATION_INVALID",
  });

class EmailVerificationStateError extends Error {
  constructor() {
    super("Email verification could not be completed.");
    this.name = "EmailVerificationStateError";
    this.code = "EMAIL_VERIFICATION_STATE_INVALID";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `email verification requires ${description}`
    );
  }
}

function auditValues(auditContext) {
  if (auditContext === null || auditContext === undefined) {
    return {
      requestCorrelationId: null,
      networkKeyVersion: null,
      networkMetadataDigest: null,
      clientMetadataJson: null,
    };
  }
  return auditContext;
}

function internalSuccess({ user, sessionIssue }) {
  const result = Object.assign(
    {
      verified: true,
      code: "EMAIL_VERIFICATION_COMPLETED",
      user: Object.freeze({
        id: user.id,
        displayName: user.display_name,
        status: user.status,
        version: user.version,
      }),
      session: sessionIssue.session,
    }
  );
  for (const key of [
    "rawSessionToken",
    "rawCsrfToken",
  ]) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      value: sessionIssue[key],
      writable: false,
    });
  }
  return Object.freeze(result);
}

function createEmailVerificationService({
  actionTokenService,
  userRepository,
  sessionService,
  auditRepository,
  outboxRepository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    actionTokenService,
    "consume",
    "an action-token service"
  );
  assertMethod(
    userRepository,
    "findById",
    "a user repository"
  );
  assertMethod(
    userRepository,
    "updateVersioned",
    "a versioned user repository"
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
    "discardByTokenId",
    "an outbox repository"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );

  function verify({
    rawToken,
    clientMetadata = null,
    auditContext = null,
  } = {}) {
    const audit = auditValues(auditContext);
    const nowMs = clock.nowMs();
    const auditEventId = secureRandom.id();
    let activatedUser;
    let sessionIssue;

    try {
      const consumed = actionTokenService.consume({
        rawToken,
        expectedPurpose: "email_verification",
        transactionHook(context) {
          const user = userRepository.findById(
            context.userId
          );
          if (
            !user ||
            user.status !== "pending_verification"
          ) {
            throw new EmailVerificationStateError();
          }
          activatedUser =
            userRepository.updateVersioned({
              key: user.id,
              expectedVersion: user.version,
              changes: {
                status: "active",
                updated_at_ms: nowMs,
              },
            });
          sessionIssue = sessionService.issueForUser({
            userId: user.id,
            clientMetadata,
          });
          outboxRepository.discardByTokenId({
            tokenId: context.tokenId,
            nowMs,
            errorCode: "EMAIL_TOKEN_CONSUMED",
          });
          auditRepository.append({
            id: auditEventId,
            event_type: "account.email_verified",
            outcome: "success",
            actor_user_id: user.id,
            target_user_id: user.id,
            league_id: null,
            session_id: sessionIssue.session.id,
            request_correlation_id:
              audit.requestCorrelationId,
            reason_code: null,
            network_key_version:
              audit.networkKeyVersion,
            network_metadata_digest:
              audit.networkMetadataDigest,
            client_metadata_json:
              audit.clientMetadataJson,
            unknown_account_digest: null,
            occurred_at_ms: nowMs,
          });
        },
      });
      if (!consumed.valid) {
        return INVALID_EMAIL_VERIFICATION_RESULT;
      }
    } catch (error) {
      if (
        error instanceof EmailVerificationStateError ||
        error?.cause instanceof
          EmailVerificationStateError ||
        error?.code === "REPOSITORY_VERSION_CONFLICT" ||
        error?.code === "REPOSITORY_RECORD_NOT_FOUND"
      ) {
        return INVALID_EMAIL_VERIFICATION_RESULT;
      }
      throw error;
    }

    return internalSuccess({
      user: activatedUser,
      sessionIssue,
    });
  }

  return Object.freeze({ verify });
}

module.exports = {
  INVALID_EMAIL_VERIFICATION_RESULT,
  createEmailVerificationService,
};
