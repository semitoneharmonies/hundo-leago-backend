const crypto = require("node:crypto");
const { promisify } = require("node:util");
const zlib = require("node:zlib");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function requireBuffer(value, description, length) {
  if (!Buffer.isBuffer(value) || (length !== undefined && value.length !== length)) {
    throw new TypeError(`backup crypto requires ${description}`);
  }
  return value;
}

async function compressAndEncryptBackup({ plaintext, key, aad, randomBytes = crypto.randomBytes } = {}) {
  requireBuffer(plaintext, "a plaintext buffer");
  requireBuffer(key, "a 32-byte key", 32);
  requireBuffer(aad, "canonical additional authenticated data");
  if (typeof randomBytes !== "function") {
    throw new TypeError("backup crypto requires secure randomness");
  }
  const iv = randomBytes(IV_BYTES);
  requireBuffer(iv, "a random 12-byte IV", IV_BYTES);
  const compressed = await gzip(plaintext, { level: zlib.constants.Z_BEST_COMPRESSION });
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Object.freeze({
    ciphertext,
    compressedSize: compressed.length,
    iv: Buffer.from(iv),
    tag: cipher.getAuthTag(),
  });
}

async function decryptAndDecompressBackup({ ciphertext, key, aad, iv, tag } = {}) {
  requireBuffer(ciphertext, "an encrypted payload");
  requireBuffer(key, "a 32-byte key", 32);
  requireBuffer(aad, "canonical additional authenticated data");
  requireBuffer(iv, "a 12-byte IV", IV_BYTES);
  requireBuffer(tag, "a 16-byte authentication tag", TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return gunzip(compressed);
}

module.exports = {
  ALGORITHM,
  IV_BYTES,
  TAG_BYTES,
  compressAndEncryptBackup,
  decryptAndDecompressBackup,
};
