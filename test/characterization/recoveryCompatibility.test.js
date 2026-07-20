const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");
const { hashFile, hashTree } = require("../helpers/hashTree");
const { httpRequest } = require("../helpers/httpRequest");
const {
  startCompatibilityServer,
} = require("../helpers/startCompatibilityServer");
const {
  createJsonSnapshotRepository,
} = require(
  "../../src/infrastructure/persistence/json/JsonSnapshotRepository"
);
const {
  createJsonBackupRepository,
} = require(
  "../../src/infrastructure/persistence/json/JsonBackupRepository"
);
const {
  createSnapshotOperations,
  normalizeSnapshotName,
} = require(
  "../../src/operations/snapshots/createSnapshot"
);
const {
  createRestoreSnapshotOperation,
} = require(
  "../../src/operations/snapshots/restoreSnapshot"
);
const {
  createBackupOperations,
} = require("../../src/operations/backups/restoreBackup");
const {
  createFakePublisher,
} = require("../helpers/fakePublisher");

async function postJson(server, requestPath, body) {
  return httpRequest(server.baseUrl, requestPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function withServer(t) {
  const runtime = await createFixtureRuntime();
  const server = await startCompatibilityServer(runtime);

  t.after(async () => {
    await server.stop();
    await runtime.cleanup();
  });

  return { runtime, server };
}

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

describe(
  "current snapshot and backup HTTP compatibility",
  { concurrency: false },
  () => {
    test("lists recovery files without changing the fixture tree", async (t) => {
      const runtime = await createFixtureRuntime();
      const olderSnapshot = path.join(
        runtime.snapshotsDir,
        "older-snapshot.json"
      );
      const newerSnapshot = path.join(
        runtime.snapshotsDir,
        "newer-snapshot.json"
      );
      const olderBackup = path.join(
        runtime.backupsDir,
        "older-backup.json"
      );
      const newerBackup = path.join(
        runtime.backupsDir,
        "newer-backup.json"
      );

      await fs.promises.writeFile(olderSnapshot, "{}", "utf8");
      await fs.promises.writeFile(newerSnapshot, "{}", "utf8");
      await fs.promises.writeFile(olderBackup, "{}", "utf8");
      await fs.promises.writeFile(newerBackup, "{}", "utf8");
      await fs.promises.utimes(olderSnapshot, 1, 1);
      await fs.promises.utimes(newerSnapshot, 2, 2);
      await fs.promises.utimes(olderBackup, 1, 1);
      await fs.promises.utimes(newerBackup, 2, 2);

      const server = await startCompatibilityServer(runtime);
      t.after(async () => {
        await server.stop();
        await runtime.cleanup();
      });

      const before = await hashTree(runtime.root);
      const snapshotsResponse = await httpRequest(
        server.baseUrl,
        "/api/snapshots"
      );
      const backupsResponse = await httpRequest(
        server.baseUrl,
        "/api/backups?limit=1"
      );
      const after = await hashTree(runtime.root);

      assert.equal(snapshotsResponse.status, 200);
      assert.deepEqual(
        snapshotsResponse.json.snapshots.map((snapshot) => snapshot.id),
        ["newer-snapshot", "older-snapshot"]
      );
      assert.equal(backupsResponse.status, 200);
      assert.equal(backupsResponse.json.ok, true);
      assert.deepEqual(
        backupsResponse.json.backups.map((backup) => backup.id),
        ["newer-backup.json"]
      );
      assert.equal(
        path.resolve(backupsResponse.json.backupsDir),
        runtime.backupsDir
      );
      assert.deepEqual(after, before);
    });

    test("creates a sanitized snapshot without changing league state", async (t) => {
      const { runtime, server } = await withServer(t);
      const leagueBefore = await hashFile(runtime.leagueFile);

      const response = await postJson(
        server,
        "/api/snapshots/create",
        {
          name: "  My Recovery! / Snapshot  ",
        }
      );

      assert.equal(response.status, 200);
      assert.equal(response.json.ok, true);
      assert.match(
        response.json.snapshotId,
        /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}__my-recovery-snapshot$/
      );
      const snapshotFile = path.join(
        runtime.snapshotsDir,
        `${response.json.snapshotId}.json`
      );
      const snapshot = await readJson(snapshotFile);

      assert.equal(snapshot.teams[0].name, "Test Team Alpha");
      assert.equal(await hashFile(runtime.leagueFile), leagueBefore);
    });

    test("snapshot restore preserves statuses, logs, hashes, and current traversal behavior", async (t) => {
      const { runtime, server } = await withServer(t);
      const validSnapshot = path.join(
        runtime.snapshotsDir,
        "valid-snapshot.json"
      );
      const malformedSnapshot = path.join(
        runtime.snapshotsDir,
        "malformed-snapshot.json"
      );
      const validState = await readJson(runtime.leagueFile);
      validState.teams[0].name = "Restored From Snapshot";
      await fs.promises.writeFile(
        validSnapshot,
        JSON.stringify(validState),
        "utf8"
      );
      await fs.promises.writeFile(
        malformedSnapshot,
        "{not-json",
        "utf8"
      );

      const missingBefore = await hashFile(runtime.leagueFile);
      const missing = await postJson(
        server,
        "/api/snapshots/restore",
        {}
      );
      const notFound = await postJson(
        server,
        "/api/snapshots/restore",
        { id: "missing-snapshot" }
      );
      const malformed = await postJson(
        server,
        "/api/snapshots/restore",
        { id: "malformed-snapshot" }
      );

      assert.equal(missing.status, 400);
      assert.deepEqual(missing.json, {
        ok: false,
        error: "Missing snapshot id in body",
      });
      assert.equal(notFound.status, 404);
      assert.deepEqual(notFound.json, {
        ok: false,
        error: "Snapshot not found",
      });
      assert.equal(malformed.status, 500);
      assert.deepEqual(malformed.json, {
        ok: false,
        error: "Failed to restore snapshot",
      });
      assert.equal(await hashFile(runtime.leagueFile), missingBefore);

      const restoreBefore = await hashFile(runtime.leagueFile);
      const restoredResponse = await postJson(
        server,
        "/api/snapshots/restore",
        { id: "valid-snapshot" }
      );
      const restoreAfter = await hashFile(runtime.leagueFile);
      const restored = await readJson(runtime.leagueFile);

      assert.equal(restoredResponse.status, 200);
      assert.deepEqual(restoredResponse.json, { ok: true });
      assert.notEqual(restoreAfter, restoreBefore);
      assert.equal(restored.teams[0].name, "Restored From Snapshot");
      assert.equal(restored.meta.lastSavedBy, "commissioner:snapshotRestore");
      assert.equal(restored.leagueLog[0].type, "commRestoreSnapshot");
      assert.equal(restored.leagueLog[0].snapshotId, "valid-snapshot");

      const outsideSnapshot = path.join(
        runtime.root,
        "outside-snapshot.json"
      );
      const outsideState = structuredClone(validState);
      outsideState.teams[0].name = "Traversal Snapshot";
      await fs.promises.writeFile(
        outsideSnapshot,
        JSON.stringify(outsideState),
        "utf8"
      );

      const traversalResponse = await postJson(
        server,
        "/api/snapshots/restore",
        { id: "../outside-snapshot" }
      );
      const traversalState = await readJson(runtime.leagueFile);

      assert.equal(traversalResponse.status, 200);
      assert.equal(traversalState.teams[0].name, "Traversal Snapshot");
      assert.equal(
        traversalState.leagueLog[0].snapshotId,
        "../outside-snapshot"
      );
    });

    test("backup restore preserves role, restore/save order, failure hashes, and current traversal behavior", async (t) => {
      const { runtime, server } = await withServer(t);
      const validBackup = path.join(
        runtime.backupsDir,
        "valid-backup.json"
      );
      const malformedBackup = path.join(
        runtime.backupsDir,
        "malformed-backup.json"
      );
      const validState = await readJson(runtime.leagueFile);
      validState.teams[0].name = "Restored From Backup";
      await fs.promises.writeFile(
        validBackup,
        JSON.stringify(validState),
        "utf8"
      );
      await fs.promises.writeFile(
        malformedBackup,
        "{not-json",
        "utf8"
      );

      const missing = await postJson(
        server,
        "/api/backups/restore",
        {}
      );
      const forbidden = await postJson(
        server,
        "/api/backups/restore",
        {
          id: "valid-backup.json",
          meta: { actorRole: "manager" },
        }
      );
      assert.equal(missing.status, 400);
      assert.deepEqual(missing.json, {
        ok: false,
        error:
          "Missing backup id in body (expected: id or backupId)",
      });
      assert.equal(forbidden.status, 403);
      assert.deepEqual(forbidden.json, {
        ok: false,
        error: "Restore requires commissioner role.",
      });

      const restoreBefore = await hashFile(runtime.leagueFile);
      const restoredResponse = await postJson(
        server,
        "/api/backups/restore",
        {
          backupId: "valid-backup.json",
          meta: { actorRole: "Commissioner" },
        }
      );
      const restoreAfter = await hashFile(runtime.leagueFile);
      const restored = await readJson(runtime.leagueFile);

      assert.equal(restoredResponse.status, 200);
      assert.deepEqual(restoredResponse.json, { ok: true });
      assert.notEqual(restoreAfter, restoreBefore);
      assert.equal(restored.teams[0].name, "Restored From Backup");
      assert.equal(restored.meta.lastRestoredBy, "commissioner");
      assert.equal(restored.meta.lastSavedBy, "commissioner:backupRestore");
      assert.equal(restored.leagueLog[0].type, "commRestoreBackup");
      assert.equal(restored.leagueLog[0].backupId, "valid-backup.json");

      const outsideBackup = path.join(
        runtime.root,
        "outside-backup.json"
      );
      const outsideState = structuredClone(validState);
      outsideState.teams[0].name = "Traversal Backup";
      await fs.promises.writeFile(
        outsideBackup,
        JSON.stringify(outsideState),
        "utf8"
      );

      const traversalResponse = await postJson(
        server,
        "/api/backups/restore",
        {
          id: "../outside-backup.json",
          meta: { actorRole: "commissioner" },
        }
      );
      const traversalState = await readJson(runtime.leagueFile);

      assert.equal(traversalResponse.status, 200);
      assert.equal(traversalState.teams[0].name, "Traversal Backup");
      assert.equal(
        traversalState.leagueLog[0].backupId,
        "../outside-backup.json"
      );

      const failureBefore = await hashFile(runtime.leagueFile);
      const malformed = await postJson(
        server,
        "/api/backups/restore",
        {
          id: "malformed-backup.json",
          meta: { actorRole: "commissioner" },
        }
      );

      assert.equal(malformed.status, 500);
      assert.equal(malformed.json.ok, false);
      assert.equal(await hashFile(runtime.leagueFile), failureBefore);
    });
  }
);

describe("JSON snapshot repository", { concurrency: false }, () => {
  test("owns current snapshot listing, read, write, and path behavior", async (t) => {
    const runtime = await createFixtureRuntime();
    t.after(() => runtime.cleanup());
    const repository = createJsonSnapshotRepository({
      snapshotsDir: runtime.snapshotsDir,
    });
    const sourceState = await readJson(runtime.leagueFile);

    assert.deepEqual(repository.listSnapshots(), []);
    assert.equal(
      repository.writeSnapshot("repository-snapshot", sourceState),
      "repository-snapshot"
    );
    assert.equal(repository.snapshotExists("repository-snapshot"), true);
    assert.equal(
      repository.readSnapshot("repository-snapshot").teams[0].name,
      "Test Team Alpha"
    );
    assert.deepEqual(
      repository.listSnapshots().map((snapshot) => snapshot.id),
      ["repository-snapshot"]
    );
    assert.equal(
      path.resolve(repository.resolveSnapshotPath("../outside")),
      path.join(runtime.root, "outside.json")
    );
  });

  test("returns an empty list when its directory is absent", async (t) => {
    const runtime = await createFixtureRuntime();
    t.after(() => runtime.cleanup());
    const missingDir = path.join(runtime.root, "missing-snapshots");
    const repository = createJsonSnapshotRepository({
      snapshotsDir: missingDir,
    });

    assert.deepEqual(repository.listSnapshots(), []);
    assert.equal(fs.existsSync(missingDir), false);
  });
});

describe("JSON backup repository", { concurrency: false }, () => {
  test("owns current backup write, list, read, prune, and path behavior", async (t) => {
    const runtime = await createFixtureRuntime();
    t.after(() => runtime.cleanup());
    const sourceState = await readJson(runtime.leagueFile);
    const repository = createJsonBackupRepository({
      backupsDir: runtime.backupsDir,
      dataFilePath: runtime.leagueFile,
      maxBackups: 1,
      nowMs: () => Date.UTC(2026, 6, 18, 12, 34, 56, 789),
    });

    const firstPath = repository.writeBackupSync(sourceState, {
      savedBy: "Commissioner Restore!",
    });
    assert.equal(
      path.basename(firstPath),
      "2026-07-18T12-34-56-789Z__by_commissioner_restore_.json"
    );
    assert.equal(
      repository.readBackup(path.basename(firstPath)).teams[0].name,
      "Test Team Alpha"
    );

    const olderPath = path.join(
      runtime.backupsDir,
      "older-manual.json"
    );
    await fs.promises.writeFile(olderPath, "{}", "utf8");
    await fs.promises.utimes(olderPath, 1, 1);
    repository.pruneBackupsBestEffort();

    assert.deepEqual(
      repository.listBackups({ limit: 10 }).map((backup) => backup.id),
      [path.basename(firstPath)]
    );
    assert.equal(
      path.resolve(repository.resolveBackupPath("../outside.json")),
      path.join(runtime.root, "outside.json")
    );
  });

  test("reads before atomically replacing only the temporary live fixture", async (t) => {
    const runtime = await createFixtureRuntime();
    t.after(() => runtime.cleanup());
    const repository = createJsonBackupRepository({
      backupsDir: runtime.backupsDir,
      dataFilePath: runtime.leagueFile,
    });
    const backupState = await readJson(runtime.leagueFile);
    backupState.teams[0].name = "Repository Restore";
    await fs.promises.writeFile(
      path.join(runtime.backupsDir, "restore.json"),
      JSON.stringify(backupState),
      "utf8"
    );

    const parsed = repository.readBackup("restore.json");
    repository.writeLiveStateAtomicSync(parsed);
    const restored = await readJson(runtime.leagueFile);

    assert.equal(restored.teams[0].name, "Repository Restore");
    assert.equal(fs.existsSync(`${runtime.leagueFile}.tmp`), false);
  });

  test("failed backup parse leaves the temporary live fixture unchanged", async (t) => {
    const runtime = await createFixtureRuntime();
    t.after(() => runtime.cleanup());
    const repository = createJsonBackupRepository({
      backupsDir: runtime.backupsDir,
      dataFilePath: runtime.leagueFile,
    });
    await fs.promises.writeFile(
      path.join(runtime.backupsDir, "malformed.json"),
      "{not-json",
      "utf8"
    );
    const before = await hashFile(runtime.leagueFile);

    assert.throws(
      () => repository.readBackup("malformed.json"),
      /JSON/
    );
    assert.equal(await hashFile(runtime.leagueFile), before);
  });
});

describe("snapshot and backup operations", { concurrency: false }, () => {
  test("preserves current snapshot name normalization", () => {
    assert.equal(
      normalizeSnapshotName("  My Recovery! / Snapshot  "),
      "my-recovery-snapshot"
    );
    assert.equal(
      normalizeSnapshotName("A".repeat(50)),
      "a".repeat(40)
    );
    assert.equal(normalizeSnapshotName("!@#$"), "");
  });

  test("creates a snapshot and attempts one compatibility update", async (t) => {
    const runtime = await createFixtureRuntime();
    t.after(() => runtime.cleanup());
    const repository = createJsonSnapshotRepository({
      snapshotsDir: runtime.snapshotsDir,
    });
    const state = await readJson(runtime.leagueFile);
    const publisher = createFakePublisher();
    const operations = createSnapshotOperations({
      snapshotRepository: repository,
      leagueStore: {
        loadLeague: () => state,
      },
      now: () => new Date("2026-07-18T12:34:56.789Z"),
      publisher,
    });

    const snapshotId = await operations.createSnapshot({
      name: "Recovery Point",
    });

    assert.equal(
      snapshotId,
      "2026-07-18_12-34-56-789__recovery-point"
    );
    assert.equal(repository.snapshotExists(snapshotId), true);
    assert.deepEqual(publisher.calls, [
      {
        eventName: "league:updated",
        payload: {
          reason: "snapshotCreated",
          snapshotId,
        },
      },
    ]);
  });

  test("restores a snapshot with defaults, activity, save metadata, and one update", async () => {
    const publisher = createFakePublisher();
    let saved = null;
    const repository = {
      snapshotExists: (id) => id === "snapshot-id",
      readSnapshot: () => ({
        teams: [{ name: "Snapshot Team" }],
        leagueLog: [{ type: "existing" }],
      }),
    };
    const leagueStore = {
      emptyState: () => ({
        schemaVersion: 1,
        teams: [],
        leagueLog: [],
        settings: { frozen: false },
      }),
      async saveLeague(state, options) {
        saved = {
          state: structuredClone(state),
          options,
        };
      },
    };
    const operation = createRestoreSnapshotOperation({
      snapshotRepository: repository,
      leagueStore,
      nowMs: () => 1234,
      random: () => 0.5,
      publisher,
    });

    assert.equal(operation.snapshotExists("snapshot-id"), true);
    await operation.restoreSnapshot("snapshot-id");

    assert.equal(saved.state.settings.frozen, false);
    assert.equal(saved.state.teams[0].name, "Snapshot Team");
    assert.deepEqual(saved.state.leagueLog[0], {
      id: 1234.5,
      type: "commRestoreSnapshot",
      by: "Commissioner",
      snapshotId: "snapshot-id",
      timestamp: 1234,
    });
    assert.deepEqual(saved.options, {
      savedBy: "commissioner:snapshotRestore",
    });
    assert.deepEqual(publisher.calls[0], {
      eventName: "league:updated",
      payload: {
        reason: "snapshotRestored",
        snapshotId: "snapshot-id",
      },
    });
  });

  test("lists and restores a backup with the current two-save activity flow", async () => {
    const publisher = createFakePublisher();
    const calls = [];
    const leagueStore = {
      backupsDir: "C:/temporary/backups",
      emptyState: () => ({
        schemaVersion: 1,
        teams: [],
        leagueLog: [],
        settings: { frozen: false },
      }),
      listBackups(options) {
        calls.push(["list", options]);
        return [{ id: "backup.json" }];
      },
      async restoreBackup(id, options) {
        calls.push(["restore", id, options]);
        return {
          teams: [{ name: "Backup Team" }],
          leagueLog: [],
        };
      },
      async saveLeague(state, options) {
        calls.push([
          "save",
          structuredClone(state),
          options,
        ]);
      },
    };
    const operations = createBackupOperations({
      leagueStore,
      nowMs: () => 5678,
      random: () => 0.25,
      publisher,
    });

    assert.deepEqual(operations.listBackups({ limit: 7 }), {
      backups: [{ id: "backup.json" }],
      backupsDir: "C:/temporary/backups",
    });
    await operations.restoreBackup("backup.json");

    assert.deepEqual(calls[1], [
      "restore",
      "backup.json",
      { restoredBy: "commissioner" },
    ]);
    assert.equal(calls[2][0], "save");
    assert.deepEqual(calls[2][1].leagueLog[0], {
      id: 5678.25,
      type: "commRestoreBackup",
      by: "Commissioner",
      backupId: "backup.json",
      timestamp: 5678,
    });
    assert.deepEqual(calls[2][2], {
      savedBy: "commissioner:backupRestore",
    });
    assert.deepEqual(publisher.calls[0], {
      eventName: "league:updated",
      payload: {
        reason: "backupRestored",
        backupId: "backup.json",
      },
    });
  });
});
