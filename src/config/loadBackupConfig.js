const path = require("node:path");

const BACKUP_ENVIRONMENTS = Object.freeze(["staging", "production"]);
const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class BackupConfigError extends Error {
  constructor(field, reason) {
    super(`Invalid backup configuration for ${field}: ${reason}`);
    this.name = "BackupConfigError";
    this.code = "BACKUP_CONFIG_INVALID";
    this.field = field;
  }
}

function fail(field, reason) {
  throw new BackupConfigError(field, reason);
}

function required(env, field) {
  const value = env[field];
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    fail(field, "a non-empty trimmed value is required");
  }
  return value;
}

function exactBoolean(env, field) {
  const value = required(env, field);
  if (!new Set(["true", "false"]).has(value)) {
    fail(field, "the value must be exactly true or false");
  }
  return value === "true";
}

function secretSlot(value, field, transform = (input) => input) {
  let secret;
  try {
    secret = transform(value);
  } catch {
    fail(field, "the secret encoding is invalid");
  }
  const slot = { configured: true };
  Object.defineProperty(slot, "value", {
    enumerable: false,
    configurable: false,
    writable: false,
    value: secret,
  });
  return Object.freeze(slot);
}

function normalizedAbsoluteChild(env, field, parent) {
  const value = required(env, field);
  const relative = path.relative(parent, value);
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(field, "a normalized child path of PERSISTENT_DATA_ROOT is required");
  }
  return value;
}

function canonicalEndpoint(env) {
  const value = required(env, "BACKUP_OBJECT_ENDPOINT");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("BACKUP_OBJECT_ENDPOINT", "a canonical HTTPS origin is required");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password
  ) {
    fail("BACKUP_OBJECT_ENDPOINT", "a canonical HTTPS origin is required");
  }
  return value;
}

function boundedName(env, field, pattern) {
  const value = required(env, field);
  if (!pattern.test(value)) fail(field, "the value is not canonical");
  return value;
}

function decodeKey(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("invalid key");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32) throw new Error("invalid key");
  return decoded;
}

function loadBackupConfig({ env, runtimeConfig } = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("loadBackupConfig requires an environment object");
  }
  if (
    !runtimeConfig ||
    !BACKUP_ENVIRONMENTS.includes(runtimeConfig.appEnv) ||
    typeof runtimeConfig.persistentRoot !== "string" ||
    typeof runtimeConfig.environmentId !== "string" ||
    typeof runtimeConfig.databaseId !== "string"
  ) {
    throw new TypeError("loadBackupConfig requires deployed runtime identity");
  }
  const prefix = boundedName(
    env,
    "BACKUP_OBJECT_PREFIX",
    /^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}\/$/
  );
  if (prefix.includes("//") || prefix.startsWith("/")) {
    fail("BACKUP_OBJECT_PREFIX", "the object prefix is not canonical");
  }
  const encryptionKeyVersion = boundedName(
    env,
    "BACKUP_ENCRYPTION_KEY_VERSION",
    KEY_VERSION_PATTERN
  );
  return Object.freeze({
    appEnv: runtimeConfig.appEnv,
    environmentId: runtimeConfig.environmentId,
    databaseId: runtimeConfig.databaseId,
    persistentRoot: runtimeConfig.persistentRoot,
    localDirectory: normalizedAbsoluteChild(
      env,
      "BACKUP_LOCAL_DIR",
      runtimeConfig.persistentRoot
    ),
    objectStorage: Object.freeze({
      endpoint: canonicalEndpoint(env),
      region: boundedName(
        env,
        "BACKUP_OBJECT_REGION",
        /^[a-z0-9][a-z0-9-]{0,62}$/
      ),
      bucket: boundedName(
        env,
        "BACKUP_OBJECT_BUCKET",
        /^[a-z0-9][a-z0-9.-]{1,62}$/
      ),
      prefix,
      accessKeyId: secretSlot(
        required(env, "BACKUP_OBJECT_ACCESS_KEY_ID"),
        "BACKUP_OBJECT_ACCESS_KEY_ID"
      ),
      secretAccessKey: secretSlot(
        required(env, "BACKUP_OBJECT_SECRET_ACCESS_KEY"),
        "BACKUP_OBJECT_SECRET_ACCESS_KEY"
      ),
    }),
    encryption: Object.freeze({
      algorithm: "AES-256-GCM",
      keyVersion: encryptionKeyVersion,
      key: secretSlot(
        required(env, "BACKUP_ENCRYPTION_KEY"),
        "BACKUP_ENCRYPTION_KEY",
        decodeKey
      ),
    }),
    scheduleEnabled: exactBoolean(env, "BACKUP_SCHEDULE_ENABLED"),
  });
}

module.exports = {
  BACKUP_ENVIRONMENTS,
  BackupConfigError,
  KEY_VERSION_PATTERN,
  loadBackupConfig,
};
