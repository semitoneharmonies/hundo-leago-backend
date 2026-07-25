const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){1,7}$/;
const ALLOWED_SCOPES = new Set(["user", "league"]);
const ALLOWED_INPUT_KEYS = new Set([
  "changedAtMs",
  "eventType",
  "scope",
  "scopeId",
  "version",
]);

class SocketInvalidationError extends Error {
  constructor() {
    super("The socket invalidation metadata is invalid.");
    this.name = "SocketInvalidationError";
    this.code = "SOCKET_INVALIDATION_INVALID";
  }
}

function invalid() {
  throw new SocketInvalidationError();
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype || prototype === null
  );
}

function createSocketInvalidation(input) {
  if (!isPlainObject(input)) invalid();
  const keys = Object.keys(input);
  if (
    keys.some((key) => !ALLOWED_INPUT_KEYS.has(key)) ||
    !EVENT_TYPE_PATTERN.test(input.eventType || "") ||
    !ALLOWED_SCOPES.has(input.scope) ||
    !UUID_PATTERN.test(input.scopeId || "")
  ) {
    invalid();
  }

  const hasVersion = input.version !== undefined;
  const hasChangedAtMs =
    input.changedAtMs !== undefined;
  if (!hasVersion && !hasChangedAtMs) invalid();
  if (
    hasVersion &&
    (!Number.isSafeInteger(input.version) ||
      input.version < 1)
  ) {
    invalid();
  }
  if (
    hasChangedAtMs &&
    (!Number.isSafeInteger(input.changedAtMs) ||
      input.changedAtMs < 0)
  ) {
    invalid();
  }

  return Object.freeze({
    kind: "invalidation",
    eventType: input.eventType,
    scope: input.scope,
    scopeId: input.scopeId,
    ...(hasVersion ? { version: input.version } : {}),
    ...(hasChangedAtMs
      ? { changedAtMs: input.changedAtMs }
      : {}),
  });
}

module.exports = {
  SocketInvalidationError,
  createSocketInvalidation,
};
