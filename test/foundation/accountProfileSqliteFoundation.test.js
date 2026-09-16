const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { createSqliteRepositoryContext } = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const { createSqliteUserRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const { createAccountProfileService } = require("../../src/application/services/accounts/createAccountProfileService");

test("account profile outcomes survive the real SQLite transaction boundary", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-account-profile-outcomes-"));
  const connection = openDatabase({ databasePath: path.join(temporaryRoot, "profile.sqlite3"), environment: "test" });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), path.resolve(temporaryRoot));
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const database = connection.database;
  migrateDatabase({ database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "account-profile-outcomes", now: () => 1000 });
  const repositoryContext = createSqliteRepositoryContext({ database });
  const firstId = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
  for (const [id, email, name] of [[firstId, "first@example.test", "First Manager"], [otherId, "other@example.test", "Other Manager"]]) {
    repositoryContext.repositories.users.insert({ id, email_normalized: email, email_display: email, display_name: name, display_name_normalized: name.toLowerCase(), status: "active", created_at_ms: 1000, updated_at_ms: 1000, version: 1 });
  }
  const userRepository = createSqliteUserRepository({ database });
  const dependencies = { repositoryContext, userRepository, clock: { nowMs: () => 2000 }, activeUserAuthorization: { requireActiveUser: () => ({ actorUserId: firstId }) } };
  const service = createAccountProfileService(dependencies), otherBefore = userRepository.findById(otherId);
  const update = (displayName, expectedVersion = 2) => service.update({ authenticated: { userId: firstId }, input: { displayName }, expectedVersion });
  await t.test("profile reads make no database writes", () => { const before = database.serialize();assert.equal(service.read({ authenticated: { userId: firstId } }).user.id, firstId);assert.deepEqual(database.serialize(), before); });
  await t.test("the approved Unicode display name saves once without changing identity or another account", () => {
    const result = update("🙂".repeat(50), 1);assert.equal(result.user.displayName, "🙂".repeat(50));assert.equal(result.user.version, 2);assert.equal(result.user.id, firstId);assert.equal(result.user.email, "first@example.test");assert.deepEqual(userRepository.findById(otherId), otherBefore);
  });
  for (const [name, value, version, code] of [
    ["stale profile", "New Name", 1, "ACCOUNT_PROFILE_PRECONDITION_FAILED"],
    ["duplicate name", "Other Manager", 2, "ACCOUNT_DISPLAY_NAME_UNAVAILABLE"],
    ["unchanged name", "🙂".repeat(50), 2, "ACCOUNT_PROFILE_NO_CHANGES"],
    ["overlength name", "x".repeat(51), 2, "ACCOUNT_PROFILE_INPUT_INVALID"],
  ]) await t.test(name + " keeps its expected domain error and leaves the database unchanged", () => {
    const before = database.serialize();assert.throws(() => update(value, version), { code });assert.deepEqual(database.serialize(), before);
  });
  await t.test("unexpected persistence failure remains a repository error without any profile writes", () => {
    const failing = createAccountProfileService({ ...dependencies, userRepository: { ...userRepository, updateVersioned() { throw new Error("simulated persistence failure"); } } });
    const before = database.serialize();assert.throws(() => failing.update({ authenticated: { userId: firstId }, input: { displayName: "Allowed Name" }, expectedVersion: 2 }), { code: "REPOSITORY_OPERATION_FAILED" });assert.deepEqual(database.serialize(), before);
  });
  assert.deepEqual(database.pragma("foreign_key_check"), []);
});
