const TEST_ACCOUNT_STATUSES = new Set([
  "pending_verification",
  "active",
  "deactivated",
  "disabled",
]);

function assertDependency(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `createTestAccount requires ${description}`
    );
  }
  return value;
}

async function createTestAccount({
  repositoryContext,
  userRepository,
  credentialRepository,
  passwordHasher,
  clock,
  secureRandom,
  emailNormalized,
  emailDisplay,
  displayName,
  displayNameNormalized,
  password,
  status = "active",
} = {}) {
  assertDependency(
    repositoryContext,
    "transaction",
    "an explicit temporary repository context"
  );
  assertDependency(
    userRepository,
    "insert",
    "a user repository"
  );
  assertDependency(
    credentialRepository,
    "insertActive",
    "a credential repository"
  );
  assertDependency(
    passwordHasher,
    "hash",
    "a password hasher"
  );
  assertDependency(clock, "nowMs", "a clock");
  assertDependency(
    secureRandom,
    "id",
    "secure randomness"
  );

  for (const [field, value] of Object.entries({
    emailNormalized,
    emailDisplay,
    displayName,
    displayNameNormalized,
  })) {
    if (typeof value !== "string" || value === "") {
      throw new TypeError(
        `createTestAccount requires ${field}`
      );
    }
  }
  if (!TEST_ACCOUNT_STATUSES.has(status)) {
    throw new TypeError(
      "createTestAccount requires an approved account status"
    );
  }

  const passwordHash = await passwordHasher.hash(
    password
  );
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    throw new TypeError(
      "createTestAccount requires a safe UTC timestamp"
    );
  }

  const userId = secureRandom.id();
  const credentialId = secureRandom.id();
  const userRecord = {
    id: userId,
    email_normalized: emailNormalized,
    email_display: emailDisplay,
    display_name: displayName,
    display_name_normalized:
      displayNameNormalized,
    status,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    version: 1,
  };
  const credentialRecord = {
    id: credentialId,
    user_id: userId,
    password_hash: passwordHash,
    algorithm: "scrypt",
    algorithm_version: 1,
    status: "active",
    created_at_ms: nowMs,
    replaced_at_ms: null,
    version: 1,
  };

  return repositoryContext.transaction(() => {
    const user = userRepository.insert(
      userRecord
    );
    credentialRepository.insertActive(
      credentialRecord
    );

    return Object.freeze({
      user,
      credentialId,
    });
  });
}

module.exports = {
  TEST_ACCOUNT_STATUSES,
  createTestAccount,
};
