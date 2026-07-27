const APP_ENVIRONMENTS = Object.freeze([
  "local",
  "test",
  "staging",
  "production",
]);

const EXPECTED_NODE_ENV = Object.freeze({
  local: "development",
  test: "test",
  staging: "production",
  production: "production",
});

const LOG_LEVELS = Object.freeze([
  "debug",
  "info",
  "warn",
  "error",
]);
const EMAIL_DELIVERY_MODES = Object.freeze([
  "disabled",
  "capture",
  "sandbox",
  "allowlist",
  "send",
]);
const EMAIL_MODES_BY_ENVIRONMENT = Object.freeze({
  local: Object.freeze(["disabled", "capture"]),
  test: Object.freeze(["disabled", "capture"]),
  staging: Object.freeze(["capture", "sandbox", "allowlist"]),
  production: Object.freeze(["send"]),
});
const RESEND_API_ORIGIN = "https://api.resend.com";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;

const DEPLOYED_ENVIRONMENTS = new Set([
  "staging",
  "production",
]);
const SECRET_MINIMUM_BYTES = 32;
const ACTION_TOKEN_DELIVERY_KEY_BYTES = 32;
const INITIAL_KEY_VERSION = 1;
const MAXIMUM_FRONTEND_ORIGINS = 32;
const PLACEHOLDER_SECRETS = new Set([
  "changeme",
  "change-me",
  "change_me",
  "example",
  "placeholder",
  "replace-me",
  "replace_me",
  "sample",
  "secret",
  "test-secret",
  "todo",
]);

class SecurityConfigError extends Error {
  constructor(field, reason) {
    super(`Invalid security configuration for ${field}: ${reason}`);
    this.name = "SecurityConfigError";
    this.code = "SECURITY_CONFIG_INVALID";
    this.field = field;
  }
}

function fail(field, reason) {
  throw new SecurityConfigError(field, reason);
}

function readTrimmedString(env, field, {
  required = true,
  fallback,
} = {}) {
  const raw = env[field];

  if (raw === undefined || raw === null || raw === "") {
    if (required) {
      fail(field, "a value is required");
    }
    return fallback;
  }

  if (typeof raw !== "string") {
    fail(field, "the value must be a string");
  }

  const value = raw.trim();
  if (!value) {
    fail(field, "the value must not be empty");
  }
  return value;
}

function readEnum(env, field, allowed) {
  const value = readTrimmedString(env, field);
  if (!allowed.includes(value)) {
    fail(field, "the value is not approved");
  }
  return value;
}

function parseCanonicalOrigin(
  field,
  value,
  appEnv
) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    value.includes("*")
  ) {
    fail(field, "a canonical exact origin is required");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(field, "a canonical exact origin is required");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (appEnv === "production" &&
      parsed.protocol !== "https:")
  ) {
    fail(field, "a canonical exact origin is required");
  }

  return value;
}

function readFrontendOrigins(env, appEnv) {
  const raw = env.FRONTEND_ORIGINS;
  if (
    typeof raw !== "string" ||
    raw === "" ||
    raw !== raw.trim()
  ) {
    fail(
      "FRONTEND_ORIGINS",
      "an exact comma-separated allowlist is required"
    );
  }

  const values = raw.split(",");
  if (
    values.length < 1 ||
    values.length > MAXIMUM_FRONTEND_ORIGINS ||
    values.some((value) => value === "")
  ) {
    fail(
      "FRONTEND_ORIGINS",
      "the allowlist size is invalid"
    );
  }

  const origins = values.map((value) =>
    parseCanonicalOrigin(
      "FRONTEND_ORIGINS",
      value,
      appEnv
    )
  );
  if (new Set(origins).size !== origins.length) {
    fail(
      "FRONTEND_ORIGINS",
      "duplicate origins are not allowed"
    );
  }

  return Object.freeze(origins);
}

function createExactOriginMatcher(origins) {
  const allowed = new Set(origins);
  return function isAllowedFrontendOrigin(origin) {
    return (
      typeof origin === "string" &&
      allowed.has(origin)
    );
  };
}

function readBuildId(env, appEnv) {
  const required = DEPLOYED_ENVIRONMENTS.has(appEnv);
  const value = readTrimmedString(env, "APP_BUILD_ID", {
    required,
    fallback: `${appEnv}-unbuilt`,
  });

  if (
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    fail("APP_BUILD_ID", "the value has an invalid format");
  }

  return value;
}

function isObviousPlaceholder(value) {
  const lower = value.toLowerCase();
  const normalized = lower.replace(
    /[^a-z0-9]/g,
    ""
  );
  return (
    PLACEHOLDER_SECRETS.has(lower) ||
    /^(?:(?:change|replace)me|example|placeholder|sample|secret|testsecret|todo)+$/.test(
      normalized
    ) ||
    /^(.)\1{31,}$/.test(value)
  );
}

function validateSecretValue(field, value) {
  if (value !== value.trim()) {
    fail(field, "surrounding whitespace is not allowed");
  }
  if (Buffer.byteLength(value, "utf8") < SECRET_MINIMUM_BYTES) {
    fail(field, "the value is too short");
  }
  if (isObviousPlaceholder(value)) {
    fail(field, "placeholder values are not allowed");
  }
  return value;
}

function createSecretSlot(value) {
  const slot = {
    configured: value !== null,
    keyVersion: INITIAL_KEY_VERSION,
    toJSON() {
      return {
        configured: this.configured,
        keyVersion: this.keyVersion,
      };
    },
  };

  Object.defineProperty(slot, "value", {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });

  return Object.freeze(slot);
}

function readSecret(env, field, appEnv) {
  const required = DEPLOYED_ENVIRONMENTS.has(appEnv);
  const raw = env[field];

  if (raw === undefined || raw === null || raw === "") {
    if (required) {
      fail(field, "a deployed secret is required");
    }
    return createSecretSlot(null);
  }

  if (typeof raw !== "string") {
    fail(field, "the value must be a string");
  }

  return createSecretSlot(
    validateSecretValue(field, raw)
  );
}

function readActionTokenDeliveryKey(env, appEnv) {
  const field = "ACTION_TOKEN_DELIVERY_KEY";
  const required = DEPLOYED_ENVIRONMENTS.has(appEnv);
  const raw = env[field];

  if (raw === undefined || raw === null || raw === "") {
    if (required) {
      fail(field, "a deployed secret is required");
    }
    return createSecretSlot(null);
  }
  if (typeof raw !== "string") {
    fail(field, "the value must be a string");
  }
  if (
    raw !== raw.trim() ||
    !/^[A-Za-z0-9_-]{43}$/.test(raw)
  ) {
    fail(
      field,
      "a canonical unpadded base64url key is required"
    );
  }

  let decoded;
  try {
    decoded = Buffer.from(raw, "base64url");
  } catch {
    fail(
      field,
      "a canonical unpadded base64url key is required"
    );
  }
  if (
    decoded.length !== ACTION_TOKEN_DELIVERY_KEY_BYTES ||
    decoded.toString("base64url") !== raw
  ) {
    fail(field, "the key must decode to exactly 32 bytes");
  }
  decoded.fill(0);

  return createSecretSlot(raw);
}

function validateEmailAddress(field, value, { allowDisplayName = false } = {}) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    value.length > 320
  ) {
    fail(field, "a valid email address is required");
  }
  const displayMatch = allowDisplayName
    ? value.match(/^.{1,200} <([^<>]+)>$/u)
    : null;
  const address = displayMatch ? displayMatch[1] : value;
  if (!EMAIL_PATTERN.test(address)) {
    fail(field, "a valid email address is required");
  }
  return value;
}

function readOptionalEmailAddress(env, field, options) {
  const raw = env[field];
  if (raw === undefined || raw === null || raw === "") return null;
  return validateEmailAddress(field, raw, options);
}

function readStagingEmailRecipientAllowlist(env, deliveryMode) {
  const field = "STAGING_EMAIL_RECIPIENT_ALLOWLIST";
  const raw = env[field];
  if (deliveryMode !== "allowlist") {
    if (raw !== undefined && raw !== null && raw !== "") {
      fail(field, "the allowlist is only allowed in staging allowlist mode");
    }
    return Object.freeze([]);
  }
  if (
    typeof raw !== "string" ||
    raw === "" ||
    raw !== raw.trim()
  ) {
    fail(field, "an exact comma-separated recipient allowlist is required");
  }
  const recipients = raw.split(",").map((value) => {
    if (value !== value.trim()) {
      fail(field, "recipient whitespace is not allowed");
    }
    return validateEmailAddress(field, value).toLowerCase();
  });
  if (
    recipients.length < 1 ||
    recipients.length > 32 ||
    new Set(recipients).size !== recipients.length
  ) {
    fail(field, "the recipient allowlist is invalid");
  }
  return Object.freeze(recipients);
}

function readResendApiKey(env, required) {
  const field = "RESEND_API_KEY";
  const raw = env[field];
  if (raw === undefined || raw === null || raw === "") {
    if (required) fail(field, "a provider credential is required");
    return createSecretSlot(null);
  }
  if (!required) {
    fail(field, "a provider credential is not allowed in this email mode");
  }
  if (
    typeof raw !== "string" ||
    raw !== raw.trim() ||
    raw.length < 20 ||
    raw.length > 256 ||
    !/^re_[A-Za-z0-9_]+$/.test(raw) ||
    isObviousPlaceholder(raw)
  ) {
    fail(field, "a valid provider credential is required");
  }
  return createSecretSlot(raw);
}

function readEmailConfig(env, appEnv) {
  const deliveryMode = readEnum(
    env,
    "EMAIL_DELIVERY_MODE",
    EMAIL_DELIVERY_MODES
  );
  if (!EMAIL_MODES_BY_ENVIRONMENT[appEnv].includes(deliveryMode)) {
    fail(
      "EMAIL_DELIVERY_MODE",
      "the mode is not approved for this application environment"
    );
  }
  const providerEnabled = ["sandbox", "allowlist", "send"].includes(
    deliveryMode
  );
  const from = readOptionalEmailAddress(env, "EMAIL_FROM", {
    allowDisplayName: true,
  });
  const replyTo = readOptionalEmailAddress(env, "EMAIL_REPLY_TO");
  if (providerEnabled && from === null) {
    fail("EMAIL_FROM", "a provider sender is required");
  }
  const apiKey = readResendApiKey(env, providerEnabled);
  const recipientAllowlist = readStagingEmailRecipientAllowlist(
    env,
    deliveryMode
  );

  return Object.freeze({
    apiKey,
    apiOrigin: providerEnabled ? RESEND_API_ORIGIN : null,
    deliveryMode,
    from,
    provider: providerEnabled ? "resend" : null,
    recipientAllowlist,
    replyTo,
  });
}

function loadSecurityConfig({ env } = {}) {
  if (
    env === null ||
    typeof env !== "object" ||
    Array.isArray(env)
  ) {
    throw new TypeError(
      "loadSecurityConfig requires an explicit environment object"
    );
  }

  const appEnv = readEnum(
    env,
    "APP_ENV",
    APP_ENVIRONMENTS
  );
  const nodeEnv = readTrimmedString(env, "NODE_ENV");
  if (nodeEnv !== EXPECTED_NODE_ENV[appEnv]) {
    fail("NODE_ENV", "the value contradicts APP_ENV");
  }

  const buildId = readBuildId(env, appEnv);
  const logLevel = readEnum(env, "LOG_LEVEL", LOG_LEVELS);
  const publicFrontendOrigin = parseCanonicalOrigin(
    "PUBLIC_FRONTEND_ORIGIN",
    env.PUBLIC_FRONTEND_ORIGIN,
    appEnv
  );
  const frontendOrigins = readFrontendOrigins(
    env,
    appEnv
  );
  if (!frontendOrigins.includes(publicFrontendOrigin)) {
    fail(
      "PUBLIC_FRONTEND_ORIGIN",
      "the public origin must be allowlisted"
    );
  }
  const rateLimitKey = readSecret(
    env,
    "RATE_LIMIT_KEY_SECRET",
    appEnv
  );
  const auditMetadataKey = readSecret(
    env,
    "AUDIT_METADATA_SECRET",
    appEnv
  );
  const actionTokenDeliveryKey =
    readActionTokenDeliveryKey(env, appEnv);
  const email = readEmailConfig(env, appEnv);

  const configuredSecrets = [
    ["RATE_LIMIT_KEY_SECRET", rateLimitKey.value],
    ["AUDIT_METADATA_SECRET", auditMetadataKey.value],
    [
      "ACTION_TOKEN_DELIVERY_KEY",
      actionTokenDeliveryKey.value,
    ],
    ["RESEND_API_KEY", email.apiKey.value],
  ].filter(([, value]) => value !== null);
  for (let index = 0; index < configuredSecrets.length; index += 1) {
    for (
      let otherIndex = index + 1;
      otherIndex < configuredSecrets.length;
      otherIndex += 1
    ) {
      if (
        configuredSecrets[index][1] ===
        configuredSecrets[otherIndex][1]
      ) {
        fail(
          configuredSecrets[otherIndex][0],
          "security purposes require independent values"
        );
      }
    }
  }

  return Object.freeze({
    appEnv,
    nodeEnv,
    buildId,
    logLevel,
    publicFrontendOrigin,
    frontendOrigins,
    isAllowedFrontendOrigin:
      createExactOriginMatcher(frontendOrigins),
    rateLimitKey,
    auditMetadataKey,
    actionTokenDeliveryKey,
    email,
  });
}

module.exports = {
  ACTION_TOKEN_DELIVERY_KEY_BYTES,
  APP_ENVIRONMENTS,
  EXPECTED_NODE_ENV,
  EMAIL_DELIVERY_MODES,
  EMAIL_MODES_BY_ENVIRONMENT,
  INITIAL_KEY_VERSION,
  LOG_LEVELS,
  MAXIMUM_FRONTEND_ORIGINS,
  RESEND_API_ORIGIN,
  SECRET_MINIMUM_BYTES,
  SecurityConfigError,
  createExactOriginMatcher,
  loadSecurityConfig,
  parseCanonicalOrigin,
};
