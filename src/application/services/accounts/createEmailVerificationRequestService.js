const {
  normalizeEmail,
} = require(
  "../../../domain/accounts/accountRegistrationPolicy"
);

const GENERIC_VERIFICATION_REQUEST_RESULT =
  Object.freeze({
    accepted: true,
    code: "EMAIL_VERIFICATION_REQUEST_ACCEPTED",
  });

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `email-verification requests require ${description}`
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

function internalResult(issued) {
  const result = {
    ...GENERIC_VERIFICATION_REQUEST_RESULT,
  };
  Object.defineProperty(result, "issued", {
    configurable: false,
    enumerable: false,
    value: issued,
    writable: false,
  });
  return Object.freeze(result);
}

function createEmailVerificationRequestService({
  userRepository,
  actionTokenService,
  auditRepository,
  outboxRepository,
  deliveryEnvelope,
  clock,
  secureRandom,
  publicFrontendOrigin,
} = {}) {
  assertMethod(
    userRepository,
    "findByNormalizedEmail",
    "a user repository"
  );
  assertMethod(
    actionTokenService,
    "issue",
    "an action-token service"
  );
  assertMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  for (const method of [
    "insertPending",
    "discardByTokenId",
  ]) {
    assertMethod(
      outboxRepository,
      method,
      "an outbox repository"
    );
  }
  assertMethod(
    deliveryEnvelope,
    "seal",
    "an encrypted delivery envelope"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );
  let parsedOrigin;
  try {
    parsedOrigin = new URL(publicFrontendOrigin);
  } catch {
    throw new TypeError(
      "email-verification requests require a canonical frontend origin"
    );
  }
  if (parsedOrigin.origin !== publicFrontendOrigin) {
    throw new TypeError(
      "email-verification requests require a canonical frontend origin"
    );
  }

  function request(
    input,
    { auditContext = null } = {}
  ) {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(
        input,
        "email"
      )
    ) {
      throw new TypeError(
        "email-verification request input is invalid"
      );
    }
    const { email } = input;
    const normalized = normalizeEmail(email);
    const user = userRepository.findByNormalizedEmail(
      normalized.normalized
    );
    if (!user || user.status !== "pending_verification") {
      return internalResult(false);
    }
    const audit = auditValues(auditContext);
    const nowMs = clock.nowMs();
    const outboxEventId = secureRandom.id();
    const auditEventId = secureRandom.id();

    actionTokenService.issue({
      userId: user.id,
      purpose: "email_verification",
      transactionHook(context) {
        if (context.previousTokenId !== null) {
          outboxRepository.discardByTokenId({
            tokenId: context.previousTokenId,
            nowMs,
            errorCode: "EMAIL_TOKEN_REPLACED",
          });
        }
        const envelope = deliveryEnvelope.seal({
          rawToken: context.rawToken,
          binding: {
            outboxEventId,
            publicFrontendOrigin,
            purpose: "email_verification",
            tokenId: context.activeTokenId,
            userId: user.id,
          },
        });
        outboxRepository.insertPending({
          id: outboxEventId,
          league_id: null,
          event_type:
            "account.email_verification_requested",
          aggregate_type: "user",
          aggregate_id: user.id,
          payload_json: JSON.stringify({
            deliveryKind: "email_verification",
            envelope,
            expiresAtMs: context.expiresAtMs,
            purpose: "email_verification",
            recipientUserId: user.id,
            schemaVersion: 1,
            tokenId: context.activeTokenId,
          }),
          status: "pending",
          attempt_count: 0,
          available_at_ms: nowMs,
          published_at_ms: null,
          last_error_code: null,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          version: 1,
        });
        auditRepository.append({
          id: auditEventId,
          event_type:
            "account.email_verification_resent",
          outcome: "success",
          actor_user_id: null,
          target_user_id: user.id,
          league_id: null,
          session_id: null,
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
    return internalResult(true);
  }

  return Object.freeze({ request });
}

module.exports = {
  GENERIC_VERIFICATION_REQUEST_RESULT,
  createEmailVerificationRequestService,
};
