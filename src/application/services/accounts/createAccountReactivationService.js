const {
  inspectPassword,
} = require(
  "../../../domain/accounts/passwordPolicy"
);
const {
  createSecurityNotificationOutboxRecord,
} = require("./accountEmailOutbox");

const INVALID_REACTIVATION_RESULT = Object.freeze({
  reactivated: false,
  code: "ACCOUNT_REACTIVATION_INVALID",
});

class AccountReactivationStateError extends Error {
  constructor() {
    super("Account reactivation state is invalid.");
    this.name = "AccountReactivationStateError";
    this.code = "ACCOUNT_REACTIVATION_STATE_INVALID";
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `account reactivation requires ${description}`
    );
  }
}

function inspectInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return null;
  }
  const expected = ["currentPassword", "token"];
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    !inspectPassword(input.currentPassword).ok
  ) {
    return null;
  }
  const result = {};
  for (const key of expected) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      value: input[key],
      writable: false,
    });
  }
  return Object.freeze(result);
}

function createAccountReactivationService({
  actionTokenService,
  userRepository,
  credentialRepository,
  passwordHasher,
  auditRepository,
  outboxRepository,
  clock,
  secureRandom,
} = {}) {
  for (const method of [
    "consume",
    "recordFailedAttempt",
    "resolve",
  ]) {
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
  assertMethod(
    credentialRepository,
    "findActiveByUserId",
    "a credential repository"
  );
  assertMethod(
    passwordHasher,
    "verify",
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

  async function reactivate(
    input,
    { auditContext = null } = {}
  ) {
    const inspected = inspectInput(input);
    if (!inspected) return INVALID_REACTIVATION_RESULT;
    const resolved = actionTokenService.resolve({
      rawToken: inspected.token,
      expectedPurpose: "self_reactivation",
    });
    if (!resolved.valid) {
      return INVALID_REACTIVATION_RESULT;
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
      user.status !== "deactivated" ||
      !credential
    ) {
      return INVALID_REACTIVATION_RESULT;
    }
    const verified = Boolean(
      (
        await passwordHasher.verify(
          inspected.currentPassword,
          credential.password_hash
        )
      )?.verified
    );
    const audit = auditContext || {};
    const nowMs = clock.nowMs();
    if (!verified) {
      actionTokenService.recordFailedAttempt({
        rawToken: inspected.token,
        expectedPurpose: "self_reactivation",
      });
      auditRepository.append({
        id: secureRandom.id(),
        event_type: "account.reactivation",
        outcome: "failure",
        actor_user_id: user.id,
        target_user_id: user.id,
        league_id: null,
        session_id: null,
        request_correlation_id:
          audit.requestCorrelationId || null,
        reason_code: "current_password_rejected",
        network_key_version:
          audit.networkKeyVersion || null,
        network_metadata_digest:
          audit.networkMetadataDigest || null,
        client_metadata_json:
          audit.clientMetadataJson || null,
        unknown_account_digest: null,
        occurred_at_ms: nowMs,
      });
      return INVALID_REACTIVATION_RESULT;
    }

    const auditId = secureRandom.id();
    const outboxId = secureRandom.id();
    let reactivatedUser;
    try {
      const consumed = actionTokenService.consume({
        rawToken: inspected.token,
        expectedPurpose: "self_reactivation",
        transactionHook(context) {
          const current = userRepository.findById(
            context.userId
          );
          if (
            !current ||
            current.status !== "deactivated" ||
            current.version !== user.version
          ) {
            throw new AccountReactivationStateError();
          }
          reactivatedUser =
            userRepository.updateVersioned({
              key: current.id,
              expectedVersion: current.version,
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
            event_type: "account.reactivated",
            outcome: "success",
            actor_user_id: current.id,
            target_user_id: current.id,
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
              id: outboxId,
              userId: current.id,
              notificationKind:
                "account_reactivated",
              nowMs,
            })
          );
        },
      });
      if (!consumed.valid) {
        return INVALID_REACTIVATION_RESULT;
      }
    } catch (error) {
      if (
        error instanceof AccountReactivationStateError ||
        error?.cause instanceof
          AccountReactivationStateError ||
        [
          "REPOSITORY_VERSION_CONFLICT",
          "REPOSITORY_RECORD_NOT_FOUND",
        ].includes(error?.code)
      ) {
        return INVALID_REACTIVATION_RESULT;
      }
      throw error;
    }

    return Object.freeze({
      reactivated: true,
      code: "ACCOUNT_REACTIVATED_SIGN_IN_REQUIRED",
      signedIn: false,
      user: Object.freeze({
        id: reactivatedUser.id,
        displayName: reactivatedUser.display_name,
        status: reactivatedUser.status,
        version: reactivatedUser.version,
      }),
    });
  }

  return Object.freeze({ reactivate });
}

module.exports = {
  INVALID_REACTIVATION_RESULT,
  AccountReactivationStateError,
  createAccountReactivationService,
  inspectInput,
};
