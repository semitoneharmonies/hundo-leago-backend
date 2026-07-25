const {
  validateAccountIdentity,
} = require(
  "../../../domain/accounts/accountRegistrationPolicy"
);
const {
  createActionLinkOutboxRecord,
} = require("./accountEmailOutbox");

const REPOSITORY_CONSTRAINT =
  "REPOSITORY_CONSTRAINT";

class FirstPlatformAdministratorExistsError extends Error {
  constructor() {
    super("The first platform administrator is already established.");
    this.name = "FirstPlatformAdministratorExistsError";
    this.code = "FIRST_PLATFORM_ADMINISTRATOR_EXISTS";
  }
}

class FirstPlatformAdministratorIdentityError extends Error {
  constructor(options = {}) {
    super(
      "The first platform administrator identity is unavailable.",
      options
    );
    this.name = "FirstPlatformAdministratorIdentityError";
    this.code = "FIRST_PLATFORM_ADMINISTRATOR_IDENTITY_UNAVAILABLE";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `first platform-administrator bootstrap requires ${description}`
    );
  }
}

function assertFrontendOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(
      "first platform-administrator bootstrap requires a canonical frontend origin"
    );
  }
  if (
    parsed.origin !== value ||
    !["http:", "https:"].includes(parsed.protocol)
  ) {
    throw new TypeError(
      "first platform-administrator bootstrap requires a canonical frontend origin"
    );
  }
  return value;
}

function safeResult({
  user,
  role,
  token,
  outboxEventId,
}) {
  const result = {
    created: true,
    code: "FIRST_PLATFORM_ADMINISTRATOR_CREATED",
    userId: user.id,
  };
  for (const [key, value] of Object.entries({
    outboxEventId,
    role,
    token,
    user,
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

function createFirstPlatformAdministratorService({
  repositoryContext,
  userRepository,
  platformRoleRepository,
  actionTokenService,
  auditRepository,
  outboxRepository,
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
  assertMethod(userRepository, "insert", "a user repository");
  assertMethod(
    platformRoleRepository,
    "countPlatformAdministratorHistory",
    "a platform-role repository"
  );
  assertMethod(
    platformRoleRepository,
    "insertActive",
    "a platform-role repository"
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
    deliveryEnvelope,
    "seal",
    "an encrypted delivery envelope"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");
  const frontendOrigin = assertFrontendOrigin(
    publicFrontendOrigin
  );

  function bootstrap(input) {
    const identity = validateAccountIdentity(input);
    const nowMs = clock.nowMs();
    const userId = secureRandom.id();
    const roleId = secureRandom.id();
    const auditEventId = secureRandom.id();
    const outboxEventId = secureRandom.id();

    try {
      return repositoryContext.transaction(() => {
        if (
          platformRoleRepository.countPlatformAdministratorHistory() !==
          0
        ) {
          throw new FirstPlatformAdministratorExistsError();
        }
        const user = userRepository.insert({
          id: userId,
          email_normalized: identity.emailNormalized,
          email_display: identity.emailDisplay,
          display_name: identity.displayName,
          display_name_normalized:
            identity.displayNameNormalized,
          status: "pending_credential_setup",
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          version: 1,
        });
        const role = platformRoleRepository.insertActive({
          id: roleId,
          user_id: userId,
          role: "platform_administrator",
          status: "active",
          granted_by_user_id: null,
          granted_at_ms: nowMs,
          ended_at_ms: null,
          version: 1,
        });
        const issued = actionTokenService.issue({
          userId,
          purpose: "administrator_setup",
          transactionHook(context) {
            const envelope = deliveryEnvelope.seal({
              rawToken: context.rawToken,
              binding: {
                outboxEventId,
                publicFrontendOrigin: frontendOrigin,
                purpose: "administrator_setup",
                tokenId: context.activeTokenId,
                userId,
              },
            });
            outboxRepository.insertPending(
              createActionLinkOutboxRecord({
                id: outboxEventId,
                userId,
                tokenId: context.activeTokenId,
                purpose: "administrator_setup",
                expiresAtMs: context.expiresAtMs,
                envelope,
                nowMs,
              })
            );
            auditRepository.append({
              id: auditEventId,
              event_type:
                "system_bootstrap.platform_administrator_created",
              outcome: "success",
              actor_user_id: null,
              target_user_id: userId,
              league_id: null,
              session_id: null,
              request_correlation_id: null,
              reason_code: "protected_environment",
              network_key_version: null,
              network_metadata_digest: null,
              client_metadata_json: null,
              unknown_account_digest: null,
              occurred_at_ms: nowMs,
            });
          },
        });

        return safeResult({
          user,
          role,
          token: issued.token,
          outboxEventId,
        });
      });
    } catch (error) {
      if (
        error instanceof
          FirstPlatformAdministratorExistsError ||
        error?.cause instanceof
          FirstPlatformAdministratorExistsError
      ) {
        throw (
          error instanceof
          FirstPlatformAdministratorExistsError
            ? error
            : error.cause
        );
      }
      if (
        error?.code === REPOSITORY_CONSTRAINT &&
        ["users", "platform_roles"].includes(
          error?.details?.tableName
        )
      ) {
        throw new FirstPlatformAdministratorIdentityError({
          cause: error,
        });
      }
      throw error;
    }
  }

  return Object.freeze({ bootstrap });
}

module.exports = {
  FirstPlatformAdministratorExistsError,
  FirstPlatformAdministratorIdentityError,
  createFirstPlatformAdministratorService,
};
