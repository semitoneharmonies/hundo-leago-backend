const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PLATFORM_ADMINISTRATOR_AUTHORITY =
  "platform_administrator";

class PlatformAuthorizationError extends Error {
  constructor() {
    super("Platform-administrator authority is required.");
    this.name = "PlatformAuthorizationError";
    this.code = "PLATFORM_ADMINISTRATOR_REQUIRED";
  }
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `platform authorization requires ${description}`
    );
  }
  return value;
}

function deny() {
  throw new PlatformAuthorizationError();
}

function createPlatformAuthorizationService({
  userRepository,
  platformRoleRepository,
} = {}) {
  requireMethod(
    userRepository,
    "findById",
    "a user repository"
  );
  requireMethod(
    platformRoleRepository,
    "findActiveByUserId",
    "a platform-role repository"
  );

  function requireAdministrator(authenticated) {
    const userId = authenticated?.user?.id;
    if (
      authenticated?.valid !== true ||
      !UUID_PATTERN.test(userId || "") ||
      authenticated?.session?.userId !== userId
    ) {
      deny();
    }

    const currentUser = userRepository.findById(userId);
    if (
      !currentUser ||
      currentUser.id !== userId ||
      currentUser.status !== "active"
    ) {
      deny();
    }

    const currentRole =
      platformRoleRepository.findActiveByUserId(userId);
    if (
      !currentRole ||
      currentRole.user_id !== userId ||
      currentRole.role !==
        PLATFORM_ADMINISTRATOR_AUTHORITY ||
      currentRole.status !== "active" ||
      currentRole.ended_at_ms !== null
    ) {
      deny();
    }

    return Object.freeze({
      authorized: true,
      code: "PLATFORM_ADMINISTRATOR_AUTHORIZED",
      actorUserId: userId,
      authority: PLATFORM_ADMINISTRATOR_AUTHORITY,
      roleId: currentRole.id,
      roleVersion: currentRole.version,
      userVersion: currentUser.version,
    });
  }

  return Object.freeze({ requireAdministrator });
}

module.exports = {
  PLATFORM_ADMINISTRATOR_AUTHORITY,
  PlatformAuthorizationError,
  createPlatformAuthorizationService,
};
