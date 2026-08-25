const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createJsonLeagueRepository,
} = require(
  "../../src/infrastructure/persistence/json/JsonLeagueRepository"
);
const {
  createFixtureRuntime,
} = require("../helpers/createFixtureRuntime");

async function withRuntime(t) {
  const runtime = await createFixtureRuntime();
  t.after(() => runtime.cleanup());
  return runtime;
}

describe("JSON league repository boundary", { concurrency: false }, () => {
  test("exposes explicit methods while preserving legacy store aliases", async (t) => {
    const runtime = await withRuntime(t);
    const repository = createJsonLeagueRepository({
      dataFilePath: runtime.leagueFile,
      backupsDirPath: runtime.backupsDir,
      maxBackups: 10,
    });

    assert.equal(repository.loadLeague, repository.readLeagueState);
    assert.equal(repository.saveLeague, repository.saveLeagueState);
    assert.equal(repository.SCHEMA_VERSION, 1);

    const first = repository.readLeagueState();
    const second = structuredClone(first);
    first.teams[0].name = "Explicit Repository Save";
    second.teams[0].name = "Compatibility Repository Save";

    const explicitSave = repository.saveLeagueState(first, {
      savedBy: "test:explicit-repository",
    });
    const compatibilitySave =
      repository.replaceCompatibilityLeagueState(second, {
        savedBy: "test:compatibility-repository",
      });

    await Promise.all([explicitSave, compatibilitySave]);

    const live = JSON.parse(
      await fs.promises.readFile(runtime.leagueFile, "utf8")
    );
    assert.equal(
      live.teams[0].name,
      "Compatibility Repository Save"
    );
    assert.equal(
      live.meta.lastSavedBy,
      "test:compatibility-repository"
    );
  });

  test("owns deterministic backup pruning in an isolated fixture", async (t) => {
    const runtime = await withRuntime(t);
    const oldBackupPath = path.join(
      runtime.backupsDir,
      "older-manual.json"
    );
    await fs.promises.writeFile(oldBackupPath, "{}", "utf8");
    await fs.promises.utimes(oldBackupPath, 1, 1);

    const repository = createJsonLeagueRepository({
      dataFilePath: runtime.leagueFile,
      backupsDirPath: runtime.backupsDir,
      maxBackups: 1,
    });
    const state = repository.readLeagueState();
    state.teams[0].name = "Pruned Repository Save";

    await repository.saveLeagueState(state, {
      savedBy: "test:prune",
    });

    const backups = repository.listBackups({ limit: 10 });
    assert.equal(backups.length, 1);
    assert.notEqual(backups[0].id, "older-manual.json");
    assert.equal(fs.existsSync(oldBackupPath), false);
  });

  test("keeps the root league store as a compatibility-only adapter", async () => {
    const rootStoreSource = await fs.promises.readFile(
      path.join(__dirname, "..", "..", "leagueStore.js"),
      "utf8"
    );

    assert.match(rootStoreSource, /JsonLeagueRepository/);
    assert.doesNotMatch(rootStoreSource, /require\(["'](?:node:)?fs["']\)/);
    assert.doesNotMatch(rootStoreSource, /function normalizeLeagueState/);
    assert.doesNotMatch(rootStoreSource, /writeFileSync|renameSync/);
  });
});
