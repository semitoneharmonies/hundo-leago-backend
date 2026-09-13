const {
  assertPasswordConfirmation,
} = require(
  "../../../domain/accounts/passwordPolicy"
);
const {
  createSecurityNotificationOutboxRecord,
} = require("./accountEmailOutbox");

const INVALID_PASSWORD_RESET_RESULT = Object.freeze({
  reset: false,
  code: "PASSWORD_RESET_INVALID",
});

class PasswordResetStateError extends Error {
  constructor() {
    super("Password reset state is invalid.");
    this.name = "PasswordResetStateError";
    this.code = "PASSWORD_RESET_STATE_INVALID";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `password reset requires ${description}`
    );
  }
}

function inspectInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new TypeError("password-reset input is invalid");
  }
  const expected = [
    "newPassword",
    "newPasswordConfirmation",
    "token",
  ];
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("password-reset input is invalid");
  }
  assertPasswordConfirmation(
    input.newPassword,
    input.newPasswordConfirmation
  );
  const result = {};
  for (const key of ["newPassword", "token"]) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      value: input[key],
      writable: false,
    });
  }
  return Object.freeze(result);
}

function createPasswordResetService({
  actionTokenService,
  userRepository,
  credentialRepository,
  sessionRepository,
  sessionService,
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
  assertMethod(
    userRepository,
    "findById",
    "a user repository"
  );
  for (const method of [
    "findActiveByUserId",
    "replaceActive",
  ]) {
    assertMethod(
      credentialRepository,
      method,
      "a credential repository"
    );
  }
  assertMethod(
    sessionRepository,
    "findActiveByUserId",
    "a session repository"
  );
  assertMethod(
    sessionService,
    "revoke",
    "a session service"
  );
  assertMethod(
    passwordHasher,
    "hash",
    "a password hasher"
  );
  assertMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  for (const method of [
    "discardByTokenId",
    "insertPending",
  ]) {
    assertMethod(
      outboxRepository,
      method,
      "an outbox repository"
    );
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );

  async function reset(
    input,
    { auditContext = null } = {}
  ) {
    const inspected = inspectInput(input);
    const resolved = actionTokenService.resolve({
      rawToken: inspected.token,
      expectedPurpose: "password_reset",
    });
    if (!resolved.valid) {
      return INVALID_PASSWORD_RESET_RESULT;
    }
    const user = userRepository.findById(
      resolved.token.userId
    );
    const credential = user
      ? credentialRepository.findActiveByUserId(
          user.id
        )
      : null;
    if (
      !user ||
      user.status !== "active" ||
      !credential
    ) {
      return INVALID_PASSWORD_RESET_RESULT;
    }
    const replacementHash = await passwordHasher.hash(
      inspected.newPassword
    );
    const nowMs = clock.nowMs();
    const replacementId = secureRandom.id();
    const auditId = secureRandom.id();
    const outboxId = secureRandom.id();
    const audit = auditContext || {};

    try {
      const consumed = actionTokenService.consume({
        rawToken: inspected.token,
        expectedPurpose: "password_reset",
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
            currentUser.status !== "active" ||
            !currentCredential ||
            currentCredential.id !== credential.id ||
            currentCredential.version !== credential.version
          ) {
            throw new PasswordResetStateError();
          }
          credentialRepository.replaceActive({
            currentCredentialId:
              currentCredential.id,
            expectedVersion:
              currentCredential.version,
            replacedAtMs: nowMs,
            replacement: {
              id: replacementId,
              user_id: currentUser.id,
              password_hash: replacementHash,
              algorithm: "scrypt",
              algorithm_version: 1,
              status: "active",
              created_at_ms: nowMs,
              replaced_at_ms: null,
              version: 1,
            },
          });
          const activeSession =
            sessionRepository.findActiveByUserId(
              currentUser.id
            );
          if (activeSession) {
            sessionService.revoke({
              sessionId: activeSession.id,
              expectedVersion: activeSession.version,
              reason: "password_reset",
            });
          }
          outboxRepository.discardByTokenId({
            tokenId: context.tokenId,
            nowMs,
            errorCode: "ACCOUNT_ACTION_TOKEN_CONSUMED",
          });
          auditRepository.append({
            id: auditId,
            event_type:
              "account.password_reset_completed",
            outcome: "success",
            actor_user_id: currentUser.id,
            target_user_id: currentUser.id,
            league_id: null,
            session_id: activeSession?.id || null,
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
              id: outboxId,
              userId: currentUser.id,
              notificationKind:
                "password_reset_completed",
              nowMs,
            })
          );
        },
      });
      if (!consumed.valid) {
        return INVALID_PASSWORD_RESET_RESULT;
      }
    } catch (error) {
      if (
        error instanceof PasswordResetStateError ||
        error?.cause instanceof PasswordResetStateError ||
        [
          "REPOSITORY_VERSION_CONFLICT",
          "REPOSITORY_RECORD_NOT_FOUND",
        ].includes(error?.code)
      ) {
        return INVALID_PASSWORD_RESET_RESULT;
      }
      throw error;
    }

    return Object.freeze({
      reset: true,
      code: "PASSWORD_RESET_COMPLETED",
      signedOut: true,
    });
  }

  return Object.freeze({ reset });
}

module.exports = {
  INVALID_PASSWORD_RESET_RESULT,
  PasswordResetStateError,
  createPasswordResetService,
  inspectInput,
};
