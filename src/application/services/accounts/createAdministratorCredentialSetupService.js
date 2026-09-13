const {
  assertPasswordConfirmation,
} = require(
  "../../../domain/accounts/passwordPolicy"
);
const {
  createSecurityNotificationOutboxRecord,
} = require("./accountEmailOutbox");

const INVALID_CREDENTIAL_SETUP_RESULT =
  Object.freeze({
    completed: false,
    code: "CREDENTIAL_SETUP_INVALID",
  });

class AdministratorCredentialSetupStateError extends Error {
  constructor() {
    super("Administrator credential setup state is invalid.");
    this.name = "AdministratorCredentialSetupStateError";
    this.code = "CREDENTIAL_SETUP_STATE_INVALID";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `administrator credential setup requires ${description}`
    );
  }
}

function inspectInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new TypeError("credential-setup input is invalid");
  }
  const expected = [
    "password",
    "passwordConfirmation",
    "token",
  ];
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("credential-setup input is invalid");
  }
  assertPasswordConfirmation(
    input.password,
    input.passwordConfirmation
  );
  const result = {};
  for (const key of ["password", "token"]) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      value: input[key],
      writable: false,
    });
  }
  return Object.freeze(result);
}

function createAdministratorCredentialSetupService({
  actionTokenService,
  userRepository,
  credentialRepository,
  passwordHasher,
  auditRepository,
  outboxRepository,
  clock,
  secureRandom,
} = {}) {
  for (const method of ["resolve", "consume"]) {
    assertMethod(
      actionTokenService,
      method,
      "an action-token service"
    );
  }
  for (const method of ["findById", "updateVersioned"]) {
    assertMethod(
      userRepository,
      method,
      "a user repository"
    );
  }
  for (const method of ["findActiveByUserId", "insertActive"]) {
    assertMethod(
      credentialRepository,
      method,
      "a credential repository"
    );
  }
  assertMethod(passwordHasher, "hash", "a password hasher");
  assertMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  for (const method of ["discardByTokenId", "insertPending"]) {
    assertMethod(
      outboxRepository,
      method,
      "an outbox repository"
    );
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  async function complete(
    input,
    { auditContext = null } = {}
  ) {
    const inspected = inspectInput(input);
    const resolved = actionTokenService.resolve({
      rawToken: inspected.token,
      expectedPurpose: "administrator_setup",
    });
    if (!resolved.valid) {
      return INVALID_CREDENTIAL_SETUP_RESULT;
    }
    const user = userRepository.findById(
      resolved.token.userId
    );
    if (
      !user ||
      user.status !== "pending_credential_setup" ||
      credentialRepository.findActiveByUserId(user.id)
    ) {
      return INVALID_CREDENTIAL_SETUP_RESULT;
    }
    const passwordHash = await passwordHasher.hash(
      inspected.password
    );
    const nowMs = clock.nowMs();
    const credentialId = secureRandom.id();
    const auditId = secureRandom.id();
    const notificationId = secureRandom.id();
    const audit = auditContext || {};
    let activatedUser;

    try {
      const consumed = actionTokenService.consume({
        rawToken: inspected.token,
        expectedPurpose: "administrator_setup",
        transactionHook(context) {
          const currentUser = userRepository.findById(
            context.userId
          );
          const currentCredential =
            credentialRepository.findActiveByUserId(
              context.userId
            );
          if (
            !currentUser ||
            currentUser.status !==
              "pending_credential_setup" ||
            currentCredential
          ) {
            throw new AdministratorCredentialSetupStateError();
          }
          credentialRepository.insertActive({
            id: credentialId,
            user_id: currentUser.id,
            password_hash: passwordHash,
            algorithm: "scrypt",
            algorithm_version: 1,
            status: "active",
            created_at_ms: nowMs,
            replaced_at_ms: null,
            version: 1,
          });
          activatedUser = userRepository.updateVersioned({
            key: currentUser.id,
            expectedVersion: currentUser.version,
            changes: {
              status: "active",
              updated_at_ms: nowMs,
            },
          });
          outboxRepository.discardByTokenId({
            tokenId: context.tokenId,
            nowMs,
            errorCode: "ACCOUNT_ACTION_TOKEN_CONSUMED",
          });
          auditRepository.append({
            id: auditId,
            event_type: "account.credential_setup_completed",
            outcome: "success",
            actor_user_id: currentUser.id,
            target_user_id: currentUser.id,
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
          outboxRepository.insertPending(
            createSecurityNotificationOutboxRecord({
              id: notificationId,
              userId: currentUser.id,
              notificationKind:
                "administrator_setup_completed",
              nowMs,
            })
          );
        },
      });
      if (!consumed.valid) {
        return INVALID_CREDENTIAL_SETUP_RESULT;
      }
    } catch (error) {
      if (
        error instanceof
          AdministratorCredentialSetupStateError ||
        error?.cause instanceof
          AdministratorCredentialSetupStateError ||
        [
          "REPOSITORY_VERSION_CONFLICT",
          "REPOSITORY_RECORD_NOT_FOUND",
          "REPOSITORY_CONSTRAINT",
        ].includes(error?.code)
      ) {
        return INVALID_CREDENTIAL_SETUP_RESULT;
      }
      throw error;
    }

    return Object.freeze({
      completed: true,
      code: "CREDENTIAL_SETUP_COMPLETED",
      signedOut: true,
      user: Object.freeze({
        id: activatedUser.id,
        displayName: activatedUser.display_name,
        status: activatedUser.status,
        version: activatedUser.version,
      }),
    });
  }

  return Object.freeze({ complete });
}

module.exports = {
  AdministratorCredentialSetupStateError,
  INVALID_CREDENTIAL_SETUP_RESULT,
  createAdministratorCredentialSetupService,
  inspectInput,
};
