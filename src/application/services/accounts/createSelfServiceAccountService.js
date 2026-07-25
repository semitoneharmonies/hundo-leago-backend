const {
  validateAccountRegistration,
} = require(
  "../../../domain/accounts/accountRegistrationPolicy"
);
const {
  assertPasswordConfirmation,
} = require(
  "../../../domain/accounts/passwordPolicy"
);

const REPOSITORY_CONSTRAINT =
  "REPOSITORY_CONSTRAINT";
const GENERIC_ACCEPTED_RESULT = Object.freeze({
  accepted: true,
  code: "ACCOUNT_REGISTRATION_ACCEPTED",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `self-service account creation requires ${description}`
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
  if (
    typeof auditContext !== "object" ||
    Array.isArray(auditContext)
  ) {
    throw new TypeError(
      "self-service account audit context is invalid"
    );
  }
  const keys = Object.keys(auditContext).sort();
  const expected = [
    "clientMetadataJson",
    "networkKeyVersion",
    "networkMetadataDigest",
    "requestCorrelationId",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(
      "self-service account audit context is invalid"
    );
  }
  return auditContext;
}

function internalRegistrationResult({
  user,
  credentialId,
  token,
  outboxEventId,
}) {
  const result = { ...GENERIC_ACCEPTED_RESULT };
  for (const [key, value] of Object.entries({
    created: true,
    user,
    credentialId,
    token,
    outboxEventId,
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

function genericDuplicateResult() {
  const result = { ...GENERIC_ACCEPTED_RESULT };
  Object.defineProperty(result, "created", {
    configurable: false,
    enumerable: false,
    value: false,
    writable: false,
  });
  return Object.freeze(result);
}

function createSelfServiceAccountService({
  repositoryContext,
  userRepository,
  credentialRepository,
  actionTokenService,
  auditRepository,
  outboxRepository,
  passwordHasher,
  deliveryEnvelope,
  clock,
  secureRandom,
  publicFrontendOrigin,
} = {}) {
  assertMethod(
    repositoryContext,
    "transaction",
    "a repository transaction boundary"
  );
  assertMethod(
    userRepository,
    "insert",
    "a user repository"
  );
  assertMethod(
    credentialRepository,
    "insertActive",
    "a credential repository"
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
  assertMethod(
    outboxRepository,
    "insertPending",
    "an outbox repository"
  );
  assertMethod(
    passwordHasher,
    "hash",
    "a password hasher"
  );
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
      "self-service account creation requires a canonical frontend origin"
    );
  }
  if (
    parsedOrigin.origin !== publicFrontendOrigin ||
    !["http:", "https:"].includes(parsedOrigin.protocol)
  ) {
    throw new TypeError(
      "self-service account creation requires a canonical frontend origin"
    );
  }

  async function register(
    input,
    { auditContext = null } = {}
  ) {
    const registration =
      validateAccountRegistration(input);
    assertPasswordConfirmation(
      registration.password,
      registration.passwordConfirmation
    );
    const audit = auditValues(auditContext);
    const passwordHash = await passwordHasher.hash(
      registration.password
    );
    const nowMs = clock.nowMs();
    const userId = secureRandom.id();
    const credentialId = secureRandom.id();
    const auditEventId = secureRandom.id();
    const outboxEventId = secureRandom.id();

    try {
      return repositoryContext.transaction(() => {
        const user = userRepository.insert({
          id: userId,
          email_normalized:
            registration.emailNormalized,
          email_display: registration.emailDisplay,
          display_name: registration.displayName,
          display_name_normalized:
            registration.displayNameNormalized,
          status: "pending_verification",
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          version: 1,
        });
        credentialRepository.insertActive({
          id: credentialId,
          user_id: userId,
          password_hash: passwordHash,
          algorithm: "scrypt",
          algorithm_version: 1,
          status: "active",
          created_at_ms: nowMs,
          replaced_at_ms: null,
          version: 1,
        });

        const token = actionTokenService.issue({
          userId,
          purpose: "email_verification",
          transactionHook(context) {
            const envelope = deliveryEnvelope.seal({
              rawToken: context.rawToken,
              binding: {
                outboxEventId,
                publicFrontendOrigin,
                purpose: "email_verification",
                tokenId: context.activeTokenId,
                userId,
              },
            });
            outboxRepository.insertPending({
              id: outboxEventId,
              league_id: null,
              event_type:
                "account.email_verification_requested",
              aggregate_type: "user",
              aggregate_id: userId,
              payload_json: JSON.stringify({
                deliveryKind: "email_verification",
                envelope,
                expiresAtMs: context.expiresAtMs,
                purpose: "email_verification",
                recipientUserId: userId,
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
                "account.self_service_created",
              outcome: "success",
              actor_user_id: null,
              target_user_id: userId,
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

        return internalRegistrationResult({
          user,
          credentialId,
          token: token.token,
          outboxEventId,
        });
      });
    } catch (error) {
      if (
        error?.code === REPOSITORY_CONSTRAINT &&
        error?.details?.tableName === "users"
      ) {
        return genericDuplicateResult();
      }
      throw error;
    }
  }

  return Object.freeze({ register });
}

module.exports = {
  GENERIC_ACCEPTED_RESULT,
  createSelfServiceAccountService,
};
