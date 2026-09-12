const crypto = require("node:crypto");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { readManifest } = require("./restoreEncryptedBackupToCleanPath");
const { buildBackupAad } = require("./createEncryptedOffsiteBackup");
const { decryptAndDecompressBackup } = require("../../infrastructure/backups/backupArtifactCrypto");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function invalid() {
  const error = new Error("The external scheduled-backup completion record is invalid.");
  error.code = "BACKUP_OCCURRENCE_RECEIPT_INVALID";
  throw error;
}
function objectKey(value, prefix) {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length > 512 ||
      value.includes("..") || !/^[A-Za-z0-9/_:.-]+$/.test(value)) invalid();
  return value;
}
function occurrenceReceiptKey({ config, claim }) {
  return `${config.objectStorage.prefix}occurrences/${hash(canonicalize({
    environmentId: config.environmentId, databaseId: config.databaseId,
    jobRunId: claim.runId, occurrenceKey: claim.occurrenceKey,
  }))}.json`;
}
function checksum(receipt) {
  const { receiptChecksum, ...body } = receipt;
  return hash(canonicalize(body));
}

function receiptForManifest({ manifest, config, claim }) {
  const receiptObjectKey = occurrenceReceiptKey({ config, claim });
  const occurrence = manifest.scheduledOccurrence;
  const createdAtMs = Date.parse(manifest.createdAt);
  const completedAtMs = Date.parse(manifest.completedAt);
  if (!UUID.test(manifest.backupId || "") || manifest.environment !== config.appEnv ||
      manifest.environmentId !== config.environmentId || manifest.databaseId !== config.databaseId ||
      manifest.reason !== `scheduled-${claim.cadence}` || manifest.retentionClass !== claim.cadence ||
      !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1 ||
      !Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || !Number.isSafeInteger(completedAtMs) || completedAtMs < createdAtMs ||
      !Number.isSafeInteger(manifest.encryptedSize) || manifest.encryptedSize < 1 ||
      ![manifest.manifestChecksum, manifest.plainBackupSha256, manifest.encryptedArtifactSha256].every(value => DIGEST.test(value || "")) ||
      typeof manifest.encryptionKeyVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.encryptionKeyVersion) ||
      typeof manifest.backendBuildId !== "string" || manifest.backendBuildId.length < 1 || manifest.backendBuildId.length > 128 ||
      occurrence?.jobRunId !== claim.runId || occurrence?.occurrenceKey !== claim.occurrenceKey ||
      occurrence?.completionObjectKey !== receiptObjectKey || occurrence?.completionReceiptRequired !== true ||
      manifest.verificationResults?.integrity !== "ok" || manifest.verificationResults?.foreignKeyViolationCount !== 0 ||
      manifest.verificationResults?.remoteByteSizeMatched !== true || manifest.verificationResults?.remoteSha256Matched !== true) invalid();
  objectKey(manifest.storageObjectKey, config.objectStorage.prefix);
  objectKey(manifest.manifestObjectKey, config.objectStorage.prefix);
  const body = { formatVersion: 1, kind: "scheduled_backup_completion", receiptObjectKey,
    environment: config.appEnv, environmentId: config.environmentId, databaseId: config.databaseId,
    jobRunId: claim.runId, occurrenceKey: claim.occurrenceKey, backupId: manifest.backupId,
    manifestObjectKey: manifest.manifestObjectKey, manifestChecksum: manifest.manifestChecksum,
    encryptedArtifactSha256: manifest.encryptedArtifactSha256, plaintextSha256: manifest.plainBackupSha256,
    schemaVersion: manifest.schemaVersion, encryptionKeyVersion: manifest.encryptionKeyVersion,
    backendBuildId: manifest.backendBuildId, backupCreatedAtMs: createdAtMs, backupCompletedAtMs: completedAtMs };
  return Object.freeze({ ...body, receiptChecksum: checksum(body) });
}

async function loadOccurrenceReceipt({ config, claim, objectStorage }) {
  const key = occurrenceReceiptKey({ config, claim });
  let remote;
  try { remote = await objectStorage.getPrivateObject({ objectKey: key }); }
  catch (error) {
    if (error.code === "BACKUP_OBJECT_STORAGE_FAILED" && error.status === 404) return null;
    throw error;
  }
  if (!Buffer.isBuffer(remote.body) || remote.body.length < 1 || remote.body.length > 16 * 1024) invalid();
  let receipt;
  try { receipt = JSON.parse(remote.body.toString("utf8")); } catch { invalid(); }
  if (!receipt || receipt.formatVersion !== 1 || receipt.kind !== "scheduled_backup_completion" ||
      receipt.receiptObjectKey !== key || receipt.environment !== config.appEnv ||
      receipt.environmentId !== config.environmentId || receipt.databaseId !== config.databaseId ||
      receipt.jobRunId !== claim.runId || receipt.occurrenceKey !== claim.occurrenceKey ||
      !UUID.test(receipt.backupId || "") || !DIGEST.test(receipt.receiptChecksum || "") ||
      remote.body.toString("utf8") !== `${canonicalize(receipt)}\n` || checksum(receipt) !== receipt.receiptChecksum) invalid();
  objectKey(receipt.manifestObjectKey, config.objectStorage.prefix);
  const receiptHead = await objectStorage.headPrivateObject({ objectKey: key });
  if (receiptHead?.byteSize !== remote.body.length || receiptHead.sha256 !== hash(remote.body)) invalid();
  const manifestObject = await objectStorage.getPrivateObject({ objectKey: receipt.manifestObjectKey });
  if (!Buffer.isBuffer(manifestObject.body) || manifestObject.body.length > 1024 * 1024) invalid();
  const manifest = readManifest(manifestObject.body);
  if (canonicalize(receiptForManifest({ manifest, config, claim })) !== canonicalize(receipt)) invalid();
  const artifact = await objectStorage.headPrivateObject({ objectKey: manifest.storageObjectKey });
  if (artifact?.byteSize !== manifest.encryptedSize || artifact.sha256 !== manifest.encryptedArtifactSha256) invalid();
  // Storage metadata and unkeyed manifest checksums cannot authenticate a
  // recovered attempt. Verify the actual ciphertext and its bound identity.
  if (manifest.encryptionKeyVersion !== config.encryption.keyVersion) invalid();
  const downloaded = await objectStorage.getPrivateObject({ objectKey: manifest.storageObjectKey });
  if (!Buffer.isBuffer(downloaded.body) || downloaded.body.length !== manifest.encryptedSize ||
      hash(downloaded.body) !== manifest.encryptedArtifactSha256) invalid();
  const aad = buildBackupAad(manifest);
  if (hash(aad) !== manifest.aadSha256) invalid();
  let plaintext;
  try {
    plaintext = await decryptAndDecompressBackup({ ciphertext: downloaded.body,
      key: config.encryption.key.value, aad, iv: Buffer.from(manifest.encryptionIv, "base64url"),
      tag: Buffer.from(manifest.encryptionTag, "base64url") });
    if (hash(plaintext) !== manifest.plainBackupSha256) invalid();
  } catch { invalid(); }
  finally { plaintext?.fill(0); }
  return Object.freeze({ receipt, manifest });
}

async function publishOccurrenceReceipt({ manifest, config, claim, objectStorage }) {
  const receipt = receiptForManifest({ manifest, config, claim });
  const body = Buffer.from(`${canonicalize(receipt)}\n`);
  try {
    await objectStorage.putPrivateObject({ objectKey: receipt.receiptObjectKey, body, contentType: "application/json",
      metadata: { sha256: hash(body) }, ifAbsent: true });
  } catch (error) {
    if (error.code !== "BACKUP_OBJECT_STORAGE_FAILED" || error.status !== 412) throw error;
    // Another attempt won the immutable slot. Its verified artifact is the
    // single external result, including if that worker lost its SQLite lease.
  }
  const committed = await loadOccurrenceReceipt({ config, claim, objectStorage });
  if (!committed) invalid();
  return committed;
}

function catalogEvidence({ receipt }) {
  return { verifiedBackupId: receipt.backupId, plaintextSha256: receipt.plaintextSha256,
    manifestChecksum: receipt.manifestChecksum, encryptedArtifactSha256: receipt.encryptedArtifactSha256,
    schemaVersion: receipt.schemaVersion, manifestObjectKey: receipt.manifestObjectKey,
    encryptionKeyVersion: receipt.encryptionKeyVersion, backupCreatedAtMs: receipt.backupCreatedAtMs,
    occurrenceReceiptObjectKey: receipt.receiptObjectKey, occurrenceReceiptChecksum: receipt.receiptChecksum };
}

module.exports = { occurrenceReceiptKey, receiptForManifest, loadOccurrenceReceipt, publishOccurrenceReceipt, catalogEvidence };
