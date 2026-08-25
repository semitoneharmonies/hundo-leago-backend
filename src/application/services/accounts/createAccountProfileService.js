const {
  normalizeDisplayName,
} = require("../../../domain/accounts/accountRegistrationPolicy");

class AccountProfileError extends Error {
  constructor(code) {
    super("The account profile could not be updated.");
    this.name = "AccountProfileError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`account profile requires ${description}`);
  }
}

function safeUser(row) {
  return Object.freeze({
    id: row.id,
    email: row.email_display,
    displayName: row.display_name,
    status: row.status,
    version: row.version,
  });
}

function validateInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, "displayName")
  ) {
    throw new AccountProfileError("ACCOUNT_PROFILE_INPUT_INVALID");
  }
  try {
    return normalizeDisplayName(input.displayName);
  } catch {
    throw new AccountProfileError("ACCOUNT_PROFILE_INPUT_INVALID");
  }
}

function createAccountProfileService({
  activeUserAuthorization,
  repositoryContext,
  userRepository,
  clock,
} = {}) {
  assertMethod(
    activeUserAuthorization,
    "requireActiveUser",
    "active-user authorization"
  );
  assertMethod(repositoryContext, "transaction", "a transaction boundary");
  for (const method of [
    "findById",
    "findByNormalizedDisplayName",
    "updateVersioned",
  ]) {
    assertMethod(userRepository, method, "a user repository");
  }
  assertMethod(clock, "nowMs", "a clock");

  function read({ authenticated } = {}) {
    const authority =
      activeUserAuthorization.requireActiveUser(authenticated);
    const user = userRepository.findById(authority.actorUserId);
    if (!user || user.status !== "active") {
      throw new AccountProfileError("ACCOUNT_PROFILE_NOT_FOUND");
    }
    return Object.freeze({
      code: "ACCOUNT_PROFILE_FOUND",
      user: safeUser(user),
    });
  }

  function update({ authenticated, input, expectedVersion } = {}) {
    const authority =
      activeUserAuthorization.requireActiveUser(authenticated);
    const displayName = validateInput(input);
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      throw new AccountProfileError("ACCOUNT_PROFILE_INPUT_INVALID");
    }
    try {
      return repositoryContext.transaction(() => {
        const current = userRepository.findById(authority.actorUserId);
        if (!current || current.status !== "active") {
          throw new AccountProfileError("ACCOUNT_PROFILE_NOT_FOUND");
        }
        if (current.version !== expectedVersion) {
          throw new AccountProfileError(
            "ACCOUNT_PROFILE_PRECONDITION_FAILED"
          );
        }
        const duplicate = userRepository.findByNormalizedDisplayName(
          displayName.normalized
        );
        if (duplicate && duplicate.id !== current.id) {
          throw new AccountProfileError(
            "ACCOUNT_DISPLAY_NAME_UNAVAILABLE"
          );
        }
        if (
          current.display_name === displayName.display &&
          current.display_name_normalized === displayName.normalized
        ) {
          throw new AccountProfileError("ACCOUNT_PROFILE_NO_CHANGES");
        }
        const updated = userRepository.updateVersioned({
          key: current.id,
          expectedVersion: current.version,
          changes: {
            display_name: displayName.display,
            display_name_normalized: displayName.normalized,
            updated_at_ms: clock.nowMs(),
          },
        });
        return Object.freeze({
          code: "ACCOUNT_PROFILE_UPDATED",
          user: safeUser(updated),
        });
      });
    } catch (error) {
      if (error?.code === "REPOSITORY_VERSION_CONFLICT") {
        throw new AccountProfileError(
          "ACCOUNT_PROFILE_PRECONDITION_FAILED"
        );
      }
      throw error;
    }
  }

  return Object.freeze({ read, update });
}

module.exports = {
  AccountProfileError,
  createAccountProfileService,
  safeUser,
  validateInput,
};
