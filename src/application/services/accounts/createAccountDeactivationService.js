const {
  inspectPassword,
} = require(
  "../../../domain/accounts/passwordPolicy"
);
const {
  createSecurityNotificationOutboxRecord,
} = require("./accountEmailOutbox");

const DEACTIVATION_CONFIRMATION = "DEACTIVATE";
const ACCOUNT_DEACTIVATION_DENIED = Object.freeze({
  deactivated: false,
  code: "ACCOUNT_DEACTIVATION_DENIED",
});

class AccountDeactivationServiceError extends Error {
  constructor(code) {
    super("Account deactivation could not be completed.");
    this.name = "AccountDeactivationServiceError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `account deactivation requires ${description}`
    );
  }
}

function inspectInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new AccountDeactivationServiceError(
      "ACCOUNT_DEACTIVATION_INPUT_INVALID"
    );
  }
  const expected = ["confirmation", "currentPassword"];
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    input.confirmation !== DEACTIVATION_CONFIRMATION
  ) {
    throw new AccountDeactivationServiceError(
      "ACCOUNT_DEACTIVATION_CONFIRMATION_INVALID"
    );
  }
  const result = {
    validCurrentPassword:
      inspectPassword(input.currentPassword).ok,
  };
  Object.defineProperty(result, "currentPassword", {
    configurable: false,
    enumerable: false,
    value: input.currentPassword,
    writable: false,
  });
  return Object.freeze(result);
}

function auditRecord({
  id,
  audit,
  nowMs,
  outcome,
  reasonCode,
  sessionId,
  userId,
}) {
  return {
    id,
    event_type: "account.deactivated",
    outcome,
    actor_user_id: userId,
    target_user_id: userId,
    league_id: null,
    session_id: sessionId,
    request_correlation_id:
      audit.requestCorrelationId || null,
    reason_code: reasonCode,
    network_key_version:
      audit.networkKeyVersion || null,
    network_metadata_digest:
      audit.networkMetadataDigest || null,
    client_metadata_json:
      audit.clientMetadataJson || null,
    unknown_account_digest: null,
    occurred_at_ms: nowMs,
  };
}

function createAccountDeactivationService({
  repositoryContext,
  userRepository,
  credentialRepository,
  actionTokenService,
  sessionService,
  passwordHasher,
  auditRepository,
  outboxRepository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    repositoryContext,
    "transaction",
    "a repository transaction boundary"
  );
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
    actionTokenService,
    "invalidateForUserPurpose",
    "an action-token service"
  );
  assertMethod(
    sessionService,
    "revoke",
    "a session service"
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

  async function deactivate({
    input,
    authenticated,
    auditContext = null,
  } = {}) {
    if (!authenticated?.user || !authenticated?.session) {
      throw new AccountDeactivationServiceError(
        "ACCOUNT_DEACTIVATION_SESSION_INVALID"
      );
    }
    const inspected = inspectInput(input);
    const user = userRepository.findById(
      authenticated.user.id
    );
    const credential = user
      ? credentialRepository.findActiveByUserId(
          user.id
        )
      : null;
    const audit = auditContext || {};
    const nowMs = clock.nowMs();
    let verified = false;
    if (
      inspected.validCurrentPassword &&
      user?.status === "active" &&
      credential
    ) {
      verified = Boolean(
        (
          await passwordHasher.verify(
            inspected.currentPassword,
            credential.password_hash
          )
        )?.verified
      );
    }
    if (!verified) {
      auditRepository.append(
        auditRecord({
          id: secureRandom.id(),
          audit,
          nowMs,
          outcome: "failure",
          reasonCode: "current_password_rejected",
          sessionId: authenticated.session.id,
          userId: authenticated.user.id,
        })
      );
      return ACCOUNT_DEACTIVATION_DENIED;
    }

    const auditId = secureRandom.id();
    const outboxId = secureRandom.id();
    repositoryContext.transaction(() => {
      const current = userRepository.findById(user.id);
      if (
        !current ||
        current.status !== "active" ||
        current.version !== user.version
      ) {
        throw new AccountDeactivationServiceError(
          "ACCOUNT_DEACTIVATION_STATE_STALE"
        );
      }
      userRepository.updateVersioned({
        key: current.id,
        expectedVersion: current.version,
        changes: {
          status: "deactivated",
          updated_at_ms: nowMs,
        },
      });
      sessionService.revoke({
        sessionId: authenticated.session.id,
        expectedVersion:
          authenticated.session.version,
        reason: "account_deactivation",
      });
      actionTokenService.invalidateForUserPurpose({
        userId: current.id,
        purpose: "password_reset",
        transactionHook(context) {
          outboxRepository.discardByTokenId({
            tokenId: context.tokenId,
            nowMs,
            errorCode:
              "ACCOUNT_DEACTIVATION_INVALIDATED_TOKEN",
          });
        },
      });
      auditRepository.append(
        auditRecord({
          id: auditId,
          audit,
          nowMs,
          outcome: "success",
          reasonCode: null,
          sessionId: authenticated.session.id,
          userId: current.id,
        })
      );
      outboxRepository.insertPending(
        createSecurityNotificationOutboxRecord({
          id: outboxId,
          userId: current.id,
          notificationKind: "account_deactivated",
          nowMs,
        })
      );
    });
    return Object.freeze({
      deactivated: true,
      code: "ACCOUNT_DEACTIVATED",
      signedOut: true,
    });
  }

  return Object.freeze({ deactivate });
}

module.exports = {
  ACCOUNT_DEACTIVATION_DENIED,
  DEACTIVATION_CONFIRMATION,
  AccountDeactivationServiceError,
  createAccountDeactivationService,
  inspectInput,
};
