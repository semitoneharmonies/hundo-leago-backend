const {
  assertPasswordConfirmation,
  inspectPassword,
} = require(
  "../../../domain/accounts/passwordPolicy"
);
const {
  createSecurityNotificationOutboxRecord,
} = require("./accountEmailOutbox");

const PASSWORD_CHANGE_DENIED = Object.freeze({
  changed: false,
  code: "PASSWORD_CHANGE_DENIED",
});

class PasswordChangeServiceError extends Error {
  constructor(code) {
    super("The password change could not be completed.");
    this.name = "PasswordChangeServiceError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `password change requires ${description}`
    );
  }
}

function inspectInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new PasswordChangeServiceError(
      "PASSWORD_CHANGE_INPUT_INVALID"
    );
  }
  const expected = [
    "currentPassword",
    "newPassword",
    "newPasswordConfirmation",
  ];
  const keys = Object.keys(input).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new PasswordChangeServiceError(
      "PASSWORD_CHANGE_INPUT_INVALID"
    );
  }
  assertPasswordConfirmation(
    input.newPassword,
    input.newPasswordConfirmation
  );
  const currentInspection = inspectPassword(
    input.currentPassword
  );
  if (!currentInspection.ok) {
    return Object.freeze({ validCurrent: false });
  }
  if (input.currentPassword === input.newPassword) {
    throw new PasswordChangeServiceError(
      "PASSWORD_CHANGE_NEW_PASSWORD_UNCHANGED"
    );
  }
  const result = { validCurrent: true };
  for (const key of [
    "currentPassword",
    "newPassword",
  ]) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      value: input[key],
      writable: false,
    });
  }
  return Object.freeze(result);
}

function auditValues(auditContext) {
  if (auditContext === null || auditContext === undefined) {
    return {
      clientMetadataJson: null,
      networkKeyVersion: null,
      networkMetadataDigest: null,
      requestCorrelationId: null,
    };
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
  userId,
}) {
  return {
    id,
    event_type: "account.password_change",
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

function createPasswordChangeService({
  repositoryContext,
  userRepository,
  credentialRepository,
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
    sessionService,
    "revoke",
    "a session service"
  );
  for (const method of ["hash", "verify"]) {
    assertMethod(
      passwordHasher,
      method,
      "a password hasher"
    );
  }
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
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );

  async function change({
    input,
    authenticated,
    auditContext = null,
  } = {}) {
    if (
      !authenticated?.user ||
      !authenticated?.session
    ) {
      throw new PasswordChangeServiceError(
        "PASSWORD_CHANGE_SESSION_INVALID"
      );
    }
    const inspected = inspectInput(input);
    const audit = auditValues(auditContext);
    const user = userRepository.findById(
      authenticated.user.id
    );
    const credential = user
      ? credentialRepository.findActiveByUserId(
          user.id
        )
      : null;
    const nowMs = clock.nowMs();
    if (
      !inspected.validCurrent ||
      !user ||
      user.status !== "active" ||
      !credential
    ) {
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
      return PASSWORD_CHANGE_DENIED;
    }
    const verification = await passwordHasher.verify(
      inspected.currentPassword,
      credential.password_hash
    );
    if (!verification?.verified) {
      auditRepository.append(
        auditRecord({
          id: secureRandom.id(),
          audit,
          nowMs,
          outcome: "failure",
          reasonCode: "current_password_rejected",
          sessionId: authenticated.session.id,
          userId: user.id,
        })
      );
      return PASSWORD_CHANGE_DENIED;
    }

    const replacementHash = await passwordHasher.hash(
      inspected.newPassword
    );
    const replacementId = secureRandom.id();
    const auditId = secureRandom.id();
    const outboxId = secureRandom.id();

    repositoryContext.transaction(() => {
      const currentUser = userRepository.findById(user.id);
      const currentCredential =
        credentialRepository.findActiveByUserId(
          user.id
        );
      if (
        !currentUser ||
        currentUser.status !== "active" ||
        !currentCredential ||
        currentCredential.id !== credential.id ||
        currentCredential.version !== credential.version
      ) {
        throw new PasswordChangeServiceError(
          "PASSWORD_CHANGE_STATE_STALE"
        );
      }
      credentialRepository.replaceActive({
        currentCredentialId: credential.id,
        expectedVersion: credential.version,
        replacedAtMs: nowMs,
        replacement: {
          id: replacementId,
          user_id: user.id,
          password_hash: replacementHash,
          algorithm: "scrypt",
          algorithm_version: 1,
          status: "active",
          created_at_ms: nowMs,
          replaced_at_ms: null,
          version: 1,
        },
      });
      sessionService.revoke({
        sessionId: authenticated.session.id,
        expectedVersion:
          authenticated.session.version,
        reason: "password_change",
      });
      auditRepository.append(
        auditRecord({
          id: auditId,
          audit,
          nowMs,
          outcome: "success",
          reasonCode: null,
          sessionId: authenticated.session.id,
          userId: user.id,
        })
      );
      outboxRepository.insertPending(
        createSecurityNotificationOutboxRecord({
          id: outboxId,
          userId: user.id,
          notificationKind: "password_changed",
          nowMs,
        })
      );
    });

    return Object.freeze({
      changed: true,
      code: "PASSWORD_CHANGED_SIGN_IN_REQUIRED",
      signedOut: true,
    });
  }

  return Object.freeze({ change });
}

module.exports = {
  PASSWORD_CHANGE_DENIED,
  PasswordChangeServiceError,
  createPasswordChangeService,
  inspectInput,
};
