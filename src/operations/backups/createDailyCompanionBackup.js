const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { assertDatabaseIdentity } = require("../../infrastructure/database/databaseIdentity");
const { inspectDatabase } = require("../../infrastructure/database/sqliteBackup");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { minimumRetentionExpiry, calculateExternalManifestChecksum } = require("./createEncryptedOffsiteBackup");

const APPLICATION_ID = 1212433457;
const MAX_PLAIN_BYTES = 64 * 1024 * 1024;
const MAX_ENCRYPTED_BYTES = 16 * 1024 * 1024;
const HOUR = 3_600_000;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function demand(condition, code = "DAILY_BACKUP_VERIFICATION_FAILED") {
  if (!condition) { const error = new Error("Daily backup verification failed safely."); error.code = code; throw error; }
}
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const jsonBytes = value => Buffer.from(canonicalize(value) + "\n");
async function hashFile(file) { const digest = crypto.createHash("sha256"); for await (const chunk of fs.createReadStream(file)) digest.update(chunk); return digest.digest("hex"); }
function inside(root, target) { const relative = path.relative(root, target); return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); }
function validateConfig(config) {
  demand(config && ["production", "staging"].includes(config.appEnv) && typeof config.environmentId === "string" && typeof config.databaseId === "string", "DAILY_BACKUP_CONFIG_INVALID");
  demand(typeof config.persistentRoot === "string" && path.isAbsolute(config.persistentRoot) && fs.realpathSync(config.persistentRoot) === config.persistentRoot, "DAILY_BACKUP_PATH_UNSAFE");
  demand(typeof config.objectStorage?.prefix === "string" && /^[A-Za-z0-9][A-Za-z0-9/_-]*\/$/.test(config.objectStorage.prefix) && !config.objectStorage.prefix.includes("//"), "DAILY_BACKUP_CONFIG_INVALID");
  demand(config.encryption?.algorithm === "AES-256-GCM" && Buffer.isBuffer(config.encryption.key?.value) && config.encryption.key.value.length === 32 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.encryption.keyVersion || ""), "DAILY_BACKUP_CONFIG_INVALID");
}
function sidecarPath(databasePath, config) {
  demand(typeof databasePath === "string" && path.isAbsolute(databasePath) && inside(config.persistentRoot, databasePath) && fs.realpathSync(databasePath) === databasePath, "DAILY_BACKUP_PATH_UNSAFE");
  const db = openReadonlyDatabase({ databasePath });
  try { assertDatabaseIdentity(db, { environmentId: config.environmentId, databaseId: config.databaseId }); } finally { db.close(); }
  const file = databasePath + ".hundo-daily.sqlite3";
  if (fs.existsSync(file)) demand(fs.realpathSync(file) === file && fs.statSync(file).isFile(), "DAILY_BACKUP_PATH_UNSAFE");
  return file;
}
function dailyType(file) {
  const db = openReadonlyDatabase({ databasePath: file });
  try {
    demand(db.pragma("application_id", { simple: true }) === APPLICATION_ID && db.pragma("user_version", { simple: true }) === 1, "DAILY_BACKUP_TYPE_INVALID");
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name);
    demand(["rooms", "sent_reminders", "slates"].every(name => tables.includes(name)) && tables.every(name => ["rooms", "sent_reminders", "slates", "daily_profiles"].includes(name)), "DAILY_BACKUP_TYPE_INVALID");
  } finally { db.close(); }
}
const namespace = config => config.objectStorage.prefix + "companions/daily/";
const artifactKey = (config, id) => namespace(config) + "artifacts/" + id + ".sqlite3.gz.enc";
const manifestKey = (config, id) => namespace(config) + "artifacts/" + id + ".daily.json";
function aad(manifest) {
  const fields = ["formatVersion", "backupKind", "backupId", "environment", "environmentId", "parentDatabaseId", "createdAt", "backendBuildId", "cadence", "scheduledForMs", "schemaVersion", "applicationId", "encryptionAlgorithm", "encryptionKeyVersion", "storageObjectKey", "manifestObjectKey", "plainBackupSha256", "plainSize", "retentionClass", "expiresAt"];
  return Buffer.from(canonicalize(Object.fromEntries(fields.map(key => [key, manifest[key]]))));
}
async function download(storage, key, maximum) {
  const head = await storage.headPrivateObject({ objectKey: key });
  demand(Number.isSafeInteger(head.byteSize) && head.byteSize > 0 && head.byteSize <= maximum && DIGEST.test(head.sha256));
  const response = await storage.getPrivateObject({ objectKey: key });
  demand(Buffer.isBuffer(response.body) && response.body.length === head.byteSize && hash(response.body) === head.sha256);
  return response.body;
}
async function upload(storage, key, body, contentType) {
  await storage.putPrivateObject({ objectKey: key, body, contentType, metadata: { sha256: hash(body) }, ifAbsent: true });
  const head = await storage.headPrivateObject({ objectKey: key });
  demand(head.byteSize === body.length && head.sha256 === hash(body));
}
function validateManifest(bytes, key, config, expectedOccurrence) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  demand(bytes.equals(jsonBytes(manifest)) && manifest.manifestChecksum === calculateExternalManifestChecksum(manifest));
  demand(manifest.formatVersion === 1 && manifest.backupKind === "hundo-daily-sidecar" && UUID.test(manifest.backupId || ""));
  demand(manifest.environment === config.appEnv && manifest.environmentId === config.environmentId && manifest.parentDatabaseId === config.databaseId && !Object.hasOwn(manifest, "parentBackupId"));
  demand(manifest.schemaVersion === 1 && manifest.applicationId === APPLICATION_ID && manifest.encryptionAlgorithm === "AES-256-GCM" && manifest.encryptionKeyVersion === config.encryption.keyVersion);
  demand(manifest.manifestObjectKey === key && key === manifestKey(config, manifest.backupId) && manifest.storageObjectKey === artifactKey(config, manifest.backupId));
  demand(manifest.cadence === "hourly" && manifest.retentionClass === "hourly" && Number.isSafeInteger(manifest.scheduledForMs) && manifest.scheduledForMs >= 0 && manifest.scheduledForMs % HOUR === 0);
  demand(Number.isFinite(Date.parse(manifest.createdAt)) && Math.floor(Date.parse(manifest.createdAt) / HOUR) * HOUR === manifest.scheduledForMs && manifest.expiresAt === minimumRetentionExpiry(Date.parse(manifest.createdAt), "hourly"));
  demand(!expectedOccurrence || manifest.scheduledForMs === expectedOccurrence.scheduledForMs);
  demand(Number.isSafeInteger(manifest.plainSize) && manifest.plainSize > 0 && manifest.plainSize <= MAX_PLAIN_BYTES && Number.isSafeInteger(manifest.encryptedSize) && manifest.encryptedSize > 0 && manifest.encryptedSize <= MAX_ENCRYPTED_BYTES);
  demand(DIGEST.test(manifest.plainBackupSha256 || "") && DIGEST.test(manifest.encryptedArtifactSha256 || "") && DIGEST.test(manifest.aadSha256 || ""));
  demand(/^[A-Za-z0-9_-]{16}$/.test(manifest.encryptionIv || "") && /^[A-Za-z0-9_-]{22}$/.test(manifest.encryptionTag || ""));
  demand(hash(aad(manifest)) === manifest.aadSha256);
  return manifest;
}
function newTarget(targetDatabasePath, temporaryRoot, config) {
  demand(typeof targetDatabasePath === "string" && path.isAbsolute(targetDatabasePath) && typeof temporaryRoot === "string" && path.isAbsolute(temporaryRoot), "DAILY_BACKUP_PATH_UNSAFE");
  const root = fs.realpathSync(temporaryRoot), parent = fs.realpathSync(path.dirname(targetDatabasePath));
  const target = path.join(parent, path.basename(targetDatabasePath));
  demand(target === targetDatabasePath && inside(root, target) && !inside(config.persistentRoot, target) && target !== config.persistentRoot && !fs.existsSync(target), "DAILY_BACKUP_PATH_UNSAFE");
  return target;
}
function receiptChecksum(receipt) { const { receiptChecksum: ignored, ...body } = receipt; return hash(jsonBytes(body)); }
async function restoreDailyCompanionBackupToCleanPath({ manifestObjectKey, config, objectStorage, targetDatabasePath, temporaryRoot, expectedOccurrence } = {}) {
  validateConfig(config);
  demand(typeof manifestObjectKey === "string" && manifestObjectKey.startsWith(namespace(config) + "artifacts/"), "DAILY_BACKUP_IDENTITY_INVALID");
  const target = newTarget(targetDatabasePath, temporaryRoot, config);
  const manifest = validateManifest(await download(objectStorage, manifestObjectKey, 128 * 1024), manifestObjectKey, config, expectedOccurrence);
  const encrypted = await download(objectStorage, manifest.storageObjectKey, MAX_ENCRYPTED_BYTES);
  demand(encrypted.length === manifest.encryptedSize && hash(encrypted) === manifest.encryptedArtifactSha256);
  const downloadPath = path.join(fs.realpathSync(temporaryRoot), "daily-encrypted-" + crypto.randomUUID());
  let createdTarget = false;
  try {
    fs.writeFileSync(downloadPath, encrypted, { flag: "wx", mode: 0o600 });
    const decipher = crypto.createDecipheriv("aes-256-gcm", config.encryption.key.value, Buffer.from(manifest.encryptionIv, "base64url"));
    decipher.setAAD(aad(manifest)); decipher.setAuthTag(Buffer.from(manifest.encryptionTag, "base64url"));
    let plainBytes = 0;
    const bounded = new Transform({ transform(chunk, encoding, callback) { plainBytes += chunk.length; if (plainBytes > manifest.plainSize) callback(new Error("Daily restore exceeds verified size.")); else callback(null, chunk); } });
    const handle = fs.openSync(target, "wx", 0o600); createdTarget = true;
    await pipeline(fs.createReadStream(downloadPath), decipher, zlib.createGunzip(), bounded, fs.createWriteStream(target, { fd: handle, autoClose: true }));
    demand(plainBytes === manifest.plainSize && await hashFile(target) === manifest.plainBackupSha256);
    dailyType(target);
    const inspection = inspectDatabase(target);
    demand(canonicalize(inspection) === canonicalize(manifest.databaseInspection));
    return Object.freeze({ status: "verified", backupId: manifest.backupId, manifestObjectKey, manifestChecksum: manifest.manifestChecksum, targetDatabasePath: target, plaintextSha256: manifest.plainBackupSha256, inspection });
  } catch (error) { if (createdTarget) fs.rmSync(target, { force: true }); throw error; }
  finally { fs.rmSync(downloadPath, { force: true }); }
}
async function createDailyCompanionBackup({ file, workDirectory, config, objectStorage, backendBuildId, nowMs }) {
  dailyType(file);
  let sourceBytes = fs.statSync(file).size;
  if (fs.existsSync(file + "-wal")) sourceBytes += fs.statSync(file + "-wal").size;
  demand(sourceBytes > 0 && sourceBytes <= MAX_PLAIN_BYTES, "DAILY_BACKUP_SIZE_LIMIT");
  const space = fs.statfsSync(workDirectory);
  demand(space.bavail * space.bsize >= 4 * sourceBytes + 64 * 1024 * 1024, "DAILY_BACKUP_DISK_SPACE_INSUFFICIENT");
  const snapshot = path.join(workDirectory, "snapshot.sqlite3"), source = openReadonlyDatabase({ databasePath: file });
  try { await source.backup(snapshot); } finally { source.close(); }
  fs.chmodSync(snapshot, 0o600); dailyType(snapshot);
  const inspection = inspectDatabase(snapshot), plainSize = fs.statSync(snapshot).size;
  demand(plainSize <= MAX_PLAIN_BYTES, "DAILY_BACKUP_SIZE_LIMIT");
  const id = crypto.randomUUID(), createdAt = new Date(nowMs).toISOString();
  const base = { formatVersion: 1, backupKind: "hundo-daily-sidecar", backupId: id, environment: config.appEnv, environmentId: config.environmentId, parentDatabaseId: config.databaseId, createdAt, backendBuildId, cadence: "hourly", scheduledForMs: Math.floor(nowMs / HOUR) * HOUR, schemaVersion: 1, applicationId: APPLICATION_ID, encryptionAlgorithm: "AES-256-GCM", encryptionKeyVersion: config.encryption.keyVersion, storageObjectKey: artifactKey(config, id), manifestObjectKey: manifestKey(config, id), plainBackupSha256: await hashFile(snapshot), plainSize, retentionClass: "hourly", expiresAt: minimumRetentionExpiry(nowMs, "hourly") };
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", config.encryption.key.value, iv), associatedData = aad(base);
  cipher.setAAD(associatedData);
  const artifact = path.join(workDirectory, "backup.sqlite3.gz.enc");
  await pipeline(fs.createReadStream(snapshot), zlib.createGzip(), cipher, fs.createWriteStream(artifact, { flags: "wx", mode: 0o600 }));
  const encryptedSize = fs.statSync(artifact).size;
  demand(encryptedSize <= MAX_ENCRYPTED_BYTES, "DAILY_BACKUP_SIZE_LIMIT");
  const manifestBase = { ...base, encryptedSize, encryptedArtifactSha256: await hashFile(artifact), encryptionIv: iv.toString("base64url"), encryptionTag: cipher.getAuthTag().toString("base64url"), aadSha256: hash(associatedData), databaseInspection: inspection };
  const manifest = { ...manifestBase, manifestChecksum: calculateExternalManifestChecksum(manifestBase) };
  await upload(objectStorage, base.storageObjectKey, fs.readFileSync(artifact), "application/octet-stream");
  await upload(objectStorage, base.manifestObjectKey, jsonBytes(manifest), "application/json");
  await restoreDailyCompanionBackupToCleanPath({ manifestObjectKey: base.manifestObjectKey, config, objectStorage, temporaryRoot: workDirectory, targetDatabasePath: path.join(workDirectory, "offsite-restored.sqlite3"), expectedOccurrence: base });
  return manifest;
}
function createDailyCompanionBackupJob({ databasePath, config, objectStorage, backendBuildId, logger, cadence = () => "hourly", nowMs = Date.now, temporaryRoot = os.tmpdir(), setIntervalFunction = setInterval, clearIntervalFunction = clearInterval } = {}) {
  validateConfig(config);
  demand(typeof backendBuildId === "string" && backendBuildId.trim() && typeof logger?.info === "function" && typeof logger?.error === "function" && typeof cadence === "function" && typeof nowMs === "function", "DAILY_BACKUP_CONFIG_INVALID");
  demand(["putPrivateObject", "headPrivateObject", "getPrivateObject"].every(name => typeof objectStorage?.[name] === "function"), "DAILY_BACKUP_CONFIG_INVALID");
  const scratch = fs.realpathSync(temporaryRoot);
  demand(!inside(config.persistentRoot, scratch) && scratch !== config.persistentRoot, "DAILY_BACKUP_PATH_UNSAFE");
  let timer = null, inFlight = null, started = null, closed = false, verifiedSlot = null, retryAt = 0;
  const identityKey = hash(Buffer.from(canonicalize({ environment: config.appEnv, environmentId: config.environmentId, parentDatabaseId: config.databaseId })));
  async function execute() {
    let workDirectory;
    const now = nowMs();
    try {
      demand(Number.isSafeInteger(now) && now >= 0 && cadence() === "hourly", "DAILY_BACKUP_CONFIG_INVALID");
      if (now < retryAt) return { status: "skipped", reason: "retry-wait" };
      const file = sidecarPath(databasePath, config);
      if (!fs.existsSync(file)) return { status: "skipped", reason: "daily-absent" };
      dailyType(file);
      const slot = Math.floor(now / HOUR) * HOUR;
      if (verifiedSlot === slot) return { status: "skipped", reason: "not-due" };
      workDirectory = fs.mkdtempSync(path.join(scratch, "hundo-daily-backup-")); fs.chmodSync(workDirectory, 0o700);
      demand(fs.realpathSync(workDirectory) === workDirectory && path.dirname(workDirectory) === scratch, "DAILY_BACKUP_PATH_UNSAFE");
      const receiptKey = namespace(config) + "occurrences/" + identityKey + "-" + slot + ".json";
      let receipt;
      try { receipt = JSON.parse((await download(objectStorage, receiptKey, 16 * 1024)).toString("utf8")); }
      catch (error) { if (error.status !== 404) throw error; }
      if (receipt) {
        demand(receipt.kind === "hundo-daily-backup-occurrence" && receipt.environment === config.appEnv && receipt.environmentId === config.environmentId && receipt.parentDatabaseId === config.databaseId && receipt.scheduledForMs === slot && receipt.cadence === "hourly" && receipt.receiptChecksum === receiptChecksum(receipt));
        const restored = await restoreDailyCompanionBackupToCleanPath({ manifestObjectKey: receipt.manifestObjectKey, config, objectStorage, temporaryRoot: workDirectory, targetDatabasePath: path.join(workDirectory, "offsite-restored.sqlite3"), expectedOccurrence: { scheduledForMs: slot } });
        demand(restored.backupId === receipt.backupId && restored.manifestChecksum === receipt.manifestChecksum);
      } else {
        const manifest = await createDailyCompanionBackup({ file, workDirectory, config, objectStorage, backendBuildId, nowMs: now });
        const base = { kind: "hundo-daily-backup-occurrence", environment: config.appEnv, environmentId: config.environmentId, parentDatabaseId: config.databaseId, scheduledForMs: slot, cadence: "hourly", backupId: manifest.backupId, manifestObjectKey: manifest.manifestObjectKey, manifestChecksum: manifest.manifestChecksum };
        receipt = { ...base, receiptChecksum: receiptChecksum(base) };
        await upload(objectStorage, receiptKey, jsonBytes(receipt), "application/json");
        const verifiedReceipt = JSON.parse((await download(objectStorage, receiptKey, 16 * 1024)).toString("utf8"));
        demand(canonicalize(verifiedReceipt) === canonicalize(receipt));
      }
      verifiedSlot = slot; retryAt = 0;
      logger.info("daily_backup.verified", { backupId: receipt.backupId });
      return { status: "verified", backupId: receipt.backupId, manifestObjectKey: receipt.manifestObjectKey, receiptObjectKey: receiptKey };
    } catch (error) { retryAt = now + 300_000; logger.error("daily_backup.failed", { code: "DAILY_BACKUP_FAILED" }); return { status: "failed", code: "DAILY_BACKUP_FAILED" }; }
    finally {
      if (workDirectory) {
        try { if (path.dirname(workDirectory) === scratch && fs.realpathSync(workDirectory) === workDirectory) fs.rmSync(workDirectory, { recursive: true, force: true }); }
        catch { logger.error("daily_backup.cleanup_failed", { code: "DAILY_BACKUP_CLEANUP_FAILED" }); }
      }
    }
  }
  function run() {
    if (closed) return Promise.resolve({ status: "skipped", reason: "closed" });
    if (inFlight) return Promise.resolve({ status: "skipped", reason: "overlap" });
    const pending = Promise.resolve().then(execute); inFlight = pending;
    pending.then(() => { if (inFlight === pending) inFlight = null; }, () => { if (inFlight === pending) inFlight = null; });
    return pending;
  }
  return Object.freeze({ run, start() { if (closed) throw new Error("Daily backup worker is closed."); if (!started) { timer = setIntervalFunction(() => { void run(); }, 60_000); timer?.unref?.(); started = Object.freeze({ status: "running", initialRun: run() }); } return started; }, async close() { closed = true; if (timer !== null) clearIntervalFunction(timer); if (inFlight) await inFlight; } });
}

module.exports = { APPLICATION_ID, createDailyCompanionBackupJob, restoreDailyCompanionBackupToCleanPath };
