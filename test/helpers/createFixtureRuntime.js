const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURE_NAMES = [
  "league-state.json",
  "players.json",
  "stats-cache.json",
];

function normalizeForComparison(value) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function assertInsideOsTemp(targetPath) {
  const tempRoot = normalizeForComparison(os.tmpdir());
  const target = normalizeForComparison(targetPath);
  const relative = path.relative(tempRoot, target);

  assert.notEqual(relative, "", "fixture runtime must be below the OS temp root");
  assert.equal(
    relative.startsWith("..") || path.isAbsolute(relative),
    false,
    `fixture runtime escaped the OS temp root: ${targetPath}`
  );
  assert.equal(
    target.includes("/opt/render/project/data"),
    false,
    "fixture runtime must never use the Render persistent-disk path"
  );
}

async function createFixtureRuntime({
  fixtureSourceDir = path.join(__dirname, "..", "fixtures", "minimal"),
} = {}) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hundo-leago-br00-")
  );

  assertInsideOsTemp(root);

  const paths = {
    root,
    leagueFile: path.join(root, "league-state.json"),
    playersFile: path.join(root, "players.json"),
    statsFile: path.join(root, "stats-cache.json"),
    snapshotsDir: path.join(root, "snapshots"),
    backupsDir: path.join(root, "backups"),
  };

  try {
    for (const fixtureName of FIXTURE_NAMES) {
      await fs.promises.copyFile(
        path.join(fixtureSourceDir, fixtureName),
        path.join(root, fixtureName)
      );
    }

    await fs.promises.mkdir(paths.snapshotsDir);
    await fs.promises.mkdir(paths.backupsDir);
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;

  return {
    ...paths,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      assertInsideOsTemp(root);
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

module.exports = {
  FIXTURE_NAMES,
  assertInsideOsTemp,
  createFixtureRuntime,
};
