const {
  normalizeEmail,
} = require(
  "../../../domain/accounts/accountRegistrationPolicy"
);
const {
  createActionLinkOutboxRecord,
} = require("./accountEmailOutbox");

const REQUEST_CONFIG = Object.freeze({
  password_reset: Object.freeze({
    acceptedCode: "PASSWORD_RESET_REQUEST_ACCEPTED",
    auditEventType: "account.password_reset_requested",
    eligibleStatus: "active",
  }),
  self_reactivation: Object.freeze({
    acceptedCode: "REACTIVATION_REQUEST_ACCEPTED",
    auditEventType: "account.reactivation_requested",
    eligibleStatus: "deactivated",
  }),
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `account action-link requests require ${description}`
    );
  }
}

function createResult(code, issued) {
  const result = { accepted: true, code };
  Object.defineProperty(result, "issued", {
    configurable: false,
    enumerable: false,
    value: issued,
    writable: false,
  });
  return Object.freeze(result);
}

function createAccountActionLinkRequestService({
  purpose,
  userRepository,
  actionTokenService,
  auditRepository,
  outboxRepository,
  deliveryEnvelope,
  clock,
  secureRandom,
  publicFrontendOrigin,
} = {}) {
  const config = REQUEST_CONFIG[purpose];
  if (!config) {
    throw new TypeError(
      "an approved account action-link purpose is required"
    );
  }
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
      "account action-link requests require a canonical frontend origin"
    );
  }
  if (parsedOrigin.origin !== publicFrontendOrigin) {
    throw new TypeError(
      "account action-link requests require a canonical frontend origin"
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
        "account action-link request input is invalid"
      );
    }
    const normalized = normalizeEmail(input.email);
    const user = userRepository.findByNormalizedEmail(
      normalized.normalized
    );
    if (!user || user.status !== config.eligibleStatus) {
      return createResult(config.acceptedCode, false);
    }
    const audit = auditContext || {};
    const nowMs = clock.nowMs();
    const outboxId = secureRandom.id();
    const auditId = secureRandom.id();

    actionTokenService.issue({
      userId: user.id,
      purpose,
      transactionHook(context) {
        if (context.previousTokenId !== null) {
          outboxRepository.discardByTokenId({
            tokenId: context.previousTokenId,
            nowMs,
            errorCode: "ACCOUNT_ACTION_TOKEN_REPLACED",
          });
        }
        const envelope = deliveryEnvelope.seal({
          rawToken: context.rawToken,
          binding: {
            outboxEventId: outboxId,
            publicFrontendOrigin,
            purpose,
            tokenId: context.activeTokenId,
            userId: user.id,
          },
        });
        outboxRepository.insertPending(
          createActionLinkOutboxRecord({
            id: outboxId,
            userId: user.id,
            tokenId: context.activeTokenId,
            purpose,
            expiresAtMs: context.expiresAtMs,
            envelope,
            nowMs,
          })
        );
        auditRepository.append({
          id: auditId,
          event_type: config.auditEventType,
          outcome: "success",
          actor_user_id: null,
          target_user_id: user.id,
          league_id: null,
          session_id: null,
          request_correlation_id:
            audit.requestCorrelationId || null,
          reason_code: null,
          network_key_version:
            audit.networkKeyVersion || null,
          network_metadata_digest:
            audit.networkMetadataDigest || null,
          client_metadata_json:
            audit.clientMetadataJson || null,
          unknown_account_digest: null,
          occurred_at_ms: nowMs,
        });
      },
    });
    return createResult(config.acceptedCode, true);
  }

  return Object.freeze({ request });
}

module.exports = {
  REQUEST_CONFIG,
  createAccountActionLinkRequestService,
};
