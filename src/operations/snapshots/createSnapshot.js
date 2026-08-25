function normalizeSnapshotName(name) {
  const rawName = String(name || "").trim();
  return rawName
    ? rawName
        .toLowerCase()
        .replace(/[^a-z0-9-_ ]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 40)
    : "";
}

function createManualSnapshotId({
  name,
  date,
}) {
  const stamp = date
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const safeName = normalizeSnapshotName(name);
  return safeName ? `${stamp}__${safeName}` : stamp;
}

function createSnapshotOperations({
  snapshotRepository,
  leagueStore,
  now = () => new Date(),
  publisher,
} = {}) {
  if (!snapshotRepository) {
    throw new TypeError(
      "createSnapshotOperations requires a snapshotRepository"
    );
  }
  if (!leagueStore) {
    throw new TypeError(
      "createSnapshotOperations requires a leagueStore"
    );
  }

  function listSnapshots() {
    return snapshotRepository.listSnapshots();
  }

  async function createSnapshot({ name } = {}) {
    const state = leagueStore.loadLeague();
    const snapshotId = createManualSnapshotId({
      name,
      date: now(),
    });

    snapshotRepository.writeSnapshot(snapshotId, state);

    if (publisher?.publish) {
      await publisher.publish("league:updated", {
        reason: "snapshotCreated",
        snapshotId,
      });
    }

    return snapshotId;
  }

  return {
    createSnapshot,
    listSnapshots,
  };
}

module.exports = {
  createManualSnapshotId,
  createSnapshotOperations,
  normalizeSnapshotName,
};
