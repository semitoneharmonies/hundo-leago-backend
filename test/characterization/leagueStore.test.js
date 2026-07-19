const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");
const { hashFile } = require("../helpers/hashTree");

function loadCreateLeagueStore() {
  const modulePath = require.resolve("../../leagueStore");
  delete require.cache[modulePath];
  return require(modulePath).createLeagueStore;
}

async function withRuntime(t) {
  const runtime = await createFixtureRuntime();
  t.after(() => runtime.cleanup());
  return runtime;
}

function createStore(runtime) {
  const createLeagueStore = loadCreateLeagueStore();
  return createLeagueStore({
    dataFilePath: runtime.leagueFile,
    backupsDirPath: runtime.backupsDir,
    maxBackups: 10,
  });
}

describe("current leagueStore behavior", { concurrency: false }, () => {
  test("loads and normalizes valid JSON without writing it", async (t) => {
    const runtime = await withRuntime(t);
    const before = await hashFile(runtime.leagueFile);
    const store = createStore(runtime);

    const state = store.loadLeague();

    assert.equal(state.schemaVersion, 1);
    assert.equal(state.meta.loadedFromDisk, true);
    assert.equal(path.resolve(state.meta.dataFilePath), runtime.leagueFile);
    assert.equal(state.teams.length, 2);
    assert.equal(state.teams[0].roster[0].position, "F");
    assert.equal(state.teams[1].roster[0].position, "D");
    assert.equal(await hashFile(runtime.leagueFile), before);
    assert.deepEqual(await fs.promises.readdir(runtime.backupsDir), []);
  });

  test("returns empty normalized state for a missing file without creating it", async (t) => {
    const runtime = await withRuntime(t);
    await fs.promises.unlink(runtime.leagueFile);
    const store = createStore(runtime);

    const state = store.loadLeague();

    assert.equal(state.meta.loadedFromDisk, false);
    assert.deepEqual(state.teams, []);
    assert.equal(fs.existsSync(runtime.leagueFile), false);
  });

  test("reports malformed JSON without overwriting it", async (t) => {
    const runtime = await withRuntime(t);
    await fs.promises.writeFile(runtime.leagueFile, "{not-json", "utf8");
    const before = await hashFile(runtime.leagueFile);
    t.mock.method(console, "error", () => {});
    const store = createStore(runtime);

    const state = store.loadLeague();

    assert.equal(state.meta.loadedFromDisk, false);
    assert.match(state.meta.loadError, /JSON/);
    assert.equal(await hashFile(runtime.leagueFile), before);
  });

  test("saves atomically and creates a pre-write backup", async (t) => {
    const runtime = await withRuntime(t);
    const store = createStore(runtime);
    const original = store.loadLeague();
    const next = structuredClone(original);
    next.teams[0].name = "Updated Test Team";

    await store.saveLeague(next, { savedBy: "test:save" });

    const saved = JSON.parse(
      await fs.promises.readFile(runtime.leagueFile, "utf8")
    );
    const backups = store.listBackups({ limit: 10 });

    assert.equal(saved.teams[0].name, "Updated Test Team");
    assert.equal(saved.meta.lastSavedBy, "test:save");
    assert.equal(backups.length, 1);
    assert.equal(fs.existsSync(`${runtime.leagueFile}.tmp`), false);

    const backup = JSON.parse(
      await fs.promises.readFile(
        path.join(runtime.backupsDir, backups[0].id),
        "utf8"
      )
    );
    assert.equal(backup.teams[0].name, "Test Team Alpha");
  });

  test("lists newest backups first and respects the requested limit", async (t) => {
    const runtime = await withRuntime(t);
    const store = createStore(runtime);
    const olderPath = path.join(runtime.backupsDir, "older.json");
    const newerPath = path.join(runtime.backupsDir, "newer.json");

    await fs.promises.writeFile(olderPath, "{}", "utf8");
    await fs.promises.writeFile(newerPath, "{}", "utf8");
    await fs.promises.utimes(olderPath, 1, 1);
    await fs.promises.utimes(newerPath, 2, 2);

    const allBackups = store.listBackups({ limit: 10 });
    const limitedBackups = store.listBackups({ limit: 1 });

    assert.deepEqual(
      allBackups.map((backup) => backup.id),
      ["newer.json", "older.json"]
    );
    assert.deepEqual(
      limitedBackups.map((backup) => backup.id),
      ["newer.json"]
    );
  });

  test("restores a listed backup and records restore metadata", async (t) => {
    const runtime = await withRuntime(t);
    const store = createStore(runtime);
    const changed = store.loadLeague();
    changed.teams[0].name = "Changed Before Restore";

    await store.saveLeague(changed, { savedBy: "test:before-restore" });
    const [originalBackup] = store.listBackups({ limit: 1 });

    const restored = await store.restoreBackup(originalBackup.id, {
      restoredBy: "test:restore",
    });
    const live = JSON.parse(
      await fs.promises.readFile(runtime.leagueFile, "utf8")
    );

    assert.equal(restored.teams[0].name, "Test Team Alpha");
    assert.equal(restored.meta.lastRestoredBy, "test:restore");
    assert.equal(live.teams[0].name, "Test Team Alpha");
    assert.equal(live.meta.lastRestoredBy, "test:restore");
  });

  test("rejects an unknown backup without changing live state", async (t) => {
    const runtime = await withRuntime(t);
    const store = createStore(runtime);
    const before = await hashFile(runtime.leagueFile);

    await assert.rejects(
      store.restoreBackup("missing-backup.json", {
        restoredBy: "test:missing",
      }),
      /Backup not found/
    );

    assert.equal(await hashFile(runtime.leagueFile), before);
  });

  test("queues overlapping saves in call order", async (t) => {
    const runtime = await withRuntime(t);
    const store = createStore(runtime);
    const first = store.loadLeague();
    const second = structuredClone(first);

    first.teams[0].name = "First Queued Save";
    second.teams[0].name = "Second Queued Save";

    const firstSave = store.saveLeague(first, {
      savedBy: "test:first-queued",
    });
    const secondSave = store.saveLeague(second, {
      savedBy: "test:second-queued",
    });

    await Promise.all([firstSave, secondSave]);

    const live = JSON.parse(
      await fs.promises.readFile(runtime.leagueFile, "utf8")
    );
    assert.equal(live.teams[0].name, "Second Queued Save");
    assert.equal(live.meta.lastSavedBy, "test:second-queued");
  });

  test("a simulated atomic rename failure preserves the prior live file", async (t) => {
    const runtime = await withRuntime(t);
    const store = createStore(runtime);
    const before = await hashFile(runtime.leagueFile);
    const next = store.loadLeague();
    next.teams[0].name = "Must Not Commit";

    t.mock.method(console, "error", () => {});
    t.mock.method(fs, "renameSync", () => {
      throw new Error("simulated rename failure");
    });

    await assert.rejects(
      store.saveLeague(next, { savedBy: "test:rename-failure" }),
      /simulated rename failure/
    );

    assert.equal(await hashFile(runtime.leagueFile), before);
  });
});
