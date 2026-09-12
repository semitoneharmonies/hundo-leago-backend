const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const Database = require("better-sqlite3");
const { canonicalize } = require("../../src/infrastructure/migration/sourceInventory");
const { INITIAL_RECOVERY_EPOCH, validateRecoveryEpoch, nextRecoveryEpoch, recoveryEpochHeaderValue,
  recoveryRequestKeyIsCurrent } = require("../../src/domain/recovery/recoveryEpochPolicy");
const { RECOVERY_EPOCH_KEY, readRecoveryEpoch } = require("../../src/infrastructure/database/recoveryEpoch");

test("recovery namespaces reject old keys without changing their operation, actor or league identity", () => {
  const first = nextRecoveryEpoch(INITIAL_RECOVERY_EPOCH, crypto.randomUUID());
  const second = nextRecoveryEpoch(first, crypto.randomUUID());
  const original = `trade-proposal:${crypto.randomUUID()}`;
  const firstKey = `recovery:${first.recoveryId}:${original}`;
  const secondKey = `recovery:${second.recoveryId}:${original}`;
  assert.equal(first.generation, 1); assert.equal(second.generation, 2);
  assert.equal(recoveryEpochHeaderValue(INITIAL_RECOVERY_EPOCH), "initial");
  assert.equal(recoveryEpochHeaderValue(second), second.recoveryId);
  assert.equal(recoveryRequestKeyIsCurrent(INITIAL_RECOVERY_EPOCH, original), true);
  assert.equal(recoveryRequestKeyIsCurrent(INITIAL_RECOVERY_EPOCH, firstKey), true, "an initial database preserves opaque-key compatibility");
  assert.equal(recoveryRequestKeyIsCurrent(first, original), false);
  assert.equal(recoveryRequestKeyIsCurrent(first, firstKey), true);
  assert.equal(recoveryRequestKeyIsCurrent(second, firstKey), false);
  assert.equal(recoveryRequestKeyIsCurrent(second, secondKey), true);
  assert.equal(recoveryRequestKeyIsCurrent(second, `recovery:${second.recoveryId}:`), false);
  assert.equal(recoveryRequestKeyIsCurrent(second, undefined), true);
  assert.equal(recoveryRequestKeyIsCurrent(second, null), false);
  assert.ok(`recovery:${second.recoveryId}:${"a".repeat(40)}:${crypto.randomUUID()}`.length <= 128);
});

test("recovery epoch rejects reused identities, malformed values and generation overflow", () => {
  const current = nextRecoveryEpoch(INITIAL_RECOVERY_EPOCH, crypto.randomUUID());
  for (const value of [null, [], {}, { generation: 0, recoveryId: current.recoveryId },
    { generation: 1, recoveryId: null }, { ...current, extra: true }, { ...current, generation: -1 },
    { ...current, generation: 0.5 }, { ...current, recoveryId: "old-session-secret" }]) {
    assert.throws(() => validateRecoveryEpoch(value), { code: "DATABASE_RECOVERY_EPOCH_INVALID" });
  }
  assert.throws(() => nextRecoveryEpoch(current, current.recoveryId), { code: "DATABASE_RECOVERY_EPOCH_INVALID" });
  assert.throws(() => nextRecoveryEpoch({ ...current, generation: Number.MAX_SAFE_INTEGER }, crypto.randomUUID()),
    { code: "DATABASE_RECOVERY_EPOCH_INVALID" });
});

test("epoch metadata reads are side-effect free and damaged or noncanonical state never falls back to initial", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE application_metadata(metadata_key TEXT PRIMARY KEY,metadata_value TEXT NOT NULL)");
    assert.deepEqual(readRecoveryEpoch(database), INITIAL_RECOVERY_EPOCH);
    const epoch = nextRecoveryEpoch(INITIAL_RECOVERY_EPOCH, crypto.randomUUID());
    const write = database.prepare("INSERT OR REPLACE INTO application_metadata VALUES(?,?)");
    write.run(RECOVERY_EPOCH_KEY, canonicalize(epoch));
    const before = database.serialize();
    const changes = database.prepare("SELECT total_changes() AS n").get().n;
    assert.deepEqual(readRecoveryEpoch(database), epoch);
    assert.equal(database.prepare("SELECT total_changes() AS n").get().n, changes);
    assert.deepEqual(database.serialize(), before);
    for (const value of ["not-json", "null", JSON.stringify(epoch, null, 2), canonicalize(INITIAL_RECOVERY_EPOCH)]) {
      write.run(RECOVERY_EPOCH_KEY, value);
      assert.throws(() => readRecoveryEpoch(database), { code: "DATABASE_RECOVERY_EPOCH_INVALID" });
    }
  } finally { database.close(); }
});
