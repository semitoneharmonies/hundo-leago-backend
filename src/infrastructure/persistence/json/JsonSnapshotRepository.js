const fs = require("node:fs");
const path = require("node:path");

function createJsonSnapshotRepository({
  snapshotsDir,
  fsModule = fs,
  pathModule = path,
} = {}) {
  if (!snapshotsDir) {
    throw new TypeError(
      "createJsonSnapshotRepository requires a snapshotsDir"
    );
  }

  function resolveSnapshotPath(snapshotId) {
    return pathModule.join(
      snapshotsDir,
      `${String(snapshotId)}.json`
    );
  }

  function listSnapshots() {
    if (!fsModule.existsSync(snapshotsDir)) return [];

    return fsModule
      .readdirSync(snapshotsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        const fullPath = pathModule.join(snapshotsDir, file);
        const stat = fsModule.statSync(fullPath);
        return {
          id: pathModule.basename(file, ".json"),
          createdAt: stat.mtimeMs,
        };
      })
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  function snapshotExists(snapshotId) {
    return fsModule.existsSync(resolveSnapshotPath(snapshotId));
  }

  function readSnapshot(snapshotId) {
    const raw = fsModule.readFileSync(
      resolveSnapshotPath(snapshotId),
      "utf8"
    );
    return JSON.parse(raw);
  }

  function writeSnapshot(snapshotId, state) {
    fsModule.writeFileSync(
      resolveSnapshotPath(snapshotId),
      JSON.stringify(state, null, 2),
      "utf8"
    );
    return snapshotId;
  }

  return {
    snapshotsDir,
    listSnapshots,
    readSnapshot,
    resolveSnapshotPath,
    snapshotExists,
    writeSnapshot,
  };
}

module.exports = { createJsonSnapshotRepository };
