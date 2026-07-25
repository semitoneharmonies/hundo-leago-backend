const crypto = require("node:crypto");

const {
  assertPassword,
} = require("../../domain/accounts/passwordPolicy");

const SCRYPT_ALGORITHM = "scrypt";
const SCRYPT_VERSION = 1;
const SCRYPT_COST = 131072;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_MAX_MEMORY_BYTES = 268435456;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 8;

const BASE64URL_PATTERN =
  /^[A-Za-z0-9_-]+$/;
const ENCODED_PASSWORD_PATTERN =
  /^scrypt\$v=([0-9]+)\$N=([0-9]+),r=([0-9]+),p=([0-9]+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

class StoredCredentialError extends Error {
  constructor() {
    super("The stored credential is invalid.");
    this.name = "StoredCredentialError";
    this.code = "STORED_CREDENTIAL_INVALID";
  }
}

class ScryptCapacityError extends Error {
  constructor() {
    super("Password processing is temporarily unavailable.");
    this.name = "ScryptCapacityError";
    this.code = "PASSWORD_PROCESSING_BUSY";
    this.retryable = true;
  }
}

class ScryptOperationError extends Error {
  constructor() {
    super("Password processing failed.");
    this.name = "ScryptOperationError";
    this.code = "PASSWORD_PROCESSING_FAILED";
  }
}

function decodeCanonicalBase64url(value, byteLength) {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new StoredCredentialError();
  }

  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new StoredCredentialError();
  }

  if (
    decoded.byteLength !== byteLength ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    throw new StoredCredentialError();
  }
  return decoded;
}

function parseEncodedPassword(encodedPassword) {
  if (typeof encodedPassword !== "string") {
    throw new StoredCredentialError();
  }

  const match =
    ENCODED_PASSWORD_PATTERN.exec(encodedPassword);
  if (!match) {
    throw new StoredCredentialError();
  }

  const [
    ,
    versionText,
    costText,
    blockSizeText,
    parallelizationText,
    saltText,
    keyText,
  ] = match;
  const version = Number(versionText);
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(
    parallelizationText
  );

  if (
    version !== SCRYPT_VERSION ||
    cost !== SCRYPT_COST ||
    blockSize !== SCRYPT_BLOCK_SIZE ||
    parallelization !== SCRYPT_PARALLELIZATION
  ) {
    throw new StoredCredentialError();
  }

  const salt = decodeCanonicalBase64url(
    saltText,
    SCRYPT_SALT_BYTES
  );
  try {
    const derivedKey = decodeCanonicalBase64url(
      keyText,
      SCRYPT_KEY_BYTES
    );
    return {
      algorithm: SCRYPT_ALGORITHM,
      version,
      cost,
      blockSize,
      parallelization,
      salt,
      derivedKey,
    };
  } catch (error) {
    salt.fill(0);
    throw error;
  }
}

function encodePassword({ salt, derivedKey }) {
  return (
    `${SCRYPT_ALGORITHM}$v=${SCRYPT_VERSION}` +
    `$N=${SCRYPT_COST},r=${SCRYPT_BLOCK_SIZE},p=${SCRYPT_PARALLELIZATION}` +
    `$${salt.toString("base64url")}` +
    `$${derivedKey.toString("base64url")}`
  );
}

function assertCapacityValue(
  value,
  name,
  { minimum }
) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new TypeError(
      `${name} must be a safe integer of at least ${minimum}`
    );
  }
}

function createScryptPasswordHasher({
  secureRandom,
  scrypt = crypto.scrypt,
  timingSafeEqual = crypto.timingSafeEqual,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxQueued = DEFAULT_MAX_QUEUED,
  validatePassword = assertPassword,
} = {}) {
  if (
    !secureRandom ||
    typeof secureRandom.bytes !== "function"
  ) {
    throw new TypeError(
      "createScryptPasswordHasher requires secure randomness"
    );
  }
  if (typeof scrypt !== "function") {
    throw new TypeError(
      "createScryptPasswordHasher requires an asynchronous scrypt function"
    );
  }
  if (typeof timingSafeEqual !== "function") {
    throw new TypeError(
      "createScryptPasswordHasher requires timing-safe comparison"
    );
  }
  if (typeof validatePassword !== "function") {
    throw new TypeError(
      "createScryptPasswordHasher requires password validation"
    );
  }
  assertCapacityValue(
    maxConcurrent,
    "maxConcurrent",
    { minimum: 1 }
  );
  assertCapacityValue(maxQueued, "maxQueued", {
    minimum: 0,
  });

  let activeCount = 0;
  const queue = [];

  function startNext() {
    while (
      activeCount < maxConcurrent &&
      queue.length > 0
    ) {
      const job = queue.shift();
      activeCount += 1;

      Promise.resolve()
        .then(job.operation)
        .then(job.resolve, job.reject)
        .finally(() => {
          activeCount -= 1;
          startNext();
        });
    }
  }

  function schedule(operation) {
    return new Promise((resolve, reject) => {
      if (
        activeCount >= maxConcurrent &&
        queue.length >= maxQueued
      ) {
        reject(new ScryptCapacityError());
        return;
      }

      queue.push({ operation, reject, resolve });
      startNext();
    });
  }

  function derive(password, salt) {
    return schedule(
      () =>
        new Promise((resolve, reject) => {
          let settled = false;
          function callback(error, value) {
            if (settled) return;
            settled = true;

            if (error) {
              reject(new ScryptOperationError());
              return;
            }
            if (
              !Buffer.isBuffer(value) &&
              !(value instanceof Uint8Array)
            ) {
              reject(new ScryptOperationError());
              return;
            }
            if (value.byteLength !== SCRYPT_KEY_BYTES) {
              if (typeof value.fill === "function") {
                value.fill(0);
              }
              reject(new ScryptOperationError());
              return;
            }
            resolve(
              Buffer.isBuffer(value)
                ? value
                : Buffer.from(
                    value.buffer,
                    value.byteOffset,
                    value.byteLength
                  )
            );
          }

          try {
            scrypt(
              password,
              salt,
              SCRYPT_KEY_BYTES,
              {
                N: SCRYPT_COST,
                r: SCRYPT_BLOCK_SIZE,
                p: SCRYPT_PARALLELIZATION,
                maxmem: SCRYPT_MAX_MEMORY_BYTES,
              },
              callback
            );
          } catch {
            reject(new ScryptOperationError());
          }
        })
    );
  }

  async function hash(password) {
    validatePassword(password);
    const salt = secureRandom.bytes(
      SCRYPT_SALT_BYTES
    );
    if (
      !Buffer.isBuffer(salt) ||
      salt.byteLength !== SCRYPT_SALT_BYTES
    ) {
      throw new ScryptOperationError();
    }

    let derivedKey;
    try {
      derivedKey = await derive(password, salt);
      return encodePassword({ salt, derivedKey });
    } finally {
      salt.fill(0);
      derivedKey?.fill(0);
    }
  }

  async function verify(password, encodedPassword) {
    validatePassword(password);
    const parsed = parseEncodedPassword(
      encodedPassword
    );
    let candidate;

    try {
      candidate = await derive(
        password,
        parsed.salt
      );
      const verified = Boolean(
        timingSafeEqual(
          candidate,
          parsed.derivedKey
        )
      );
      return Object.freeze({
        verified,
        needsRehash: false,
      });
    } finally {
      parsed.salt.fill(0);
      parsed.derivedKey.fill(0);
      candidate?.fill(0);
    }
  }

  return Object.freeze({
    capacity() {
      return Object.freeze({
        active: activeCount,
        queued: queue.length,
        maxConcurrent,
        maxQueued,
      });
    },
    hash,
    verify,
  });
}

module.exports = {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUED,
  ENCODED_PASSWORD_PATTERN,
  SCRYPT_ALGORITHM,
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_KEY_BYTES,
  SCRYPT_MAX_MEMORY_BYTES,
  SCRYPT_PARALLELIZATION,
  SCRYPT_SALT_BYTES,
  SCRYPT_VERSION,
  ScryptCapacityError,
  ScryptOperationError,
  StoredCredentialError,
  createScryptPasswordHasher,
};
