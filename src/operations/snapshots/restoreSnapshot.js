function createRestoreSnapshotOperation({
  snapshotRepository,
  leagueStore,
  nowMs = Date.now,
  random = Math.random,
  publisher,
} = {}) {
  if (!snapshotRepository) {
    throw new TypeError(
      "createRestoreSnapshotOperation requires a snapshotRepository"
    );
  }
  if (!leagueStore) {
    throw new TypeError(
      "createRestoreSnapshotOperation requires a leagueStore"
    );
  }

  function snapshotExists(snapshotId) {
    return snapshotRepository.snapshotExists(snapshotId);
  }

  async function restoreSnapshot(snapshotId) {
    const restored = snapshotRepository.readSnapshot(snapshotId);
    const next = {
      ...leagueStore.emptyState(),
      ...restored,
    };
    const timestamp = nowMs();
    const previousLog = Array.isArray(next.leagueLog)
      ? next.leagueLog
      : [];

    next.leagueLog = [
      {
        id: timestamp + random(),
        type: "commRestoreSnapshot",
        by: "Commissioner",
        snapshotId,
        timestamp,
      },
      ...previousLog,
    ];

    await leagueStore.saveLeague(next, {
      savedBy: "commissioner:snapshotRestore",
    });

    if (publisher?.publish) {
      await publisher.publish("league:updated", {
        reason: "snapshotRestored",
        snapshotId,
      });
    }

    return next;
  }

  return {
    restoreSnapshot,
    snapshotExists,
  };
}

module.exports = { createRestoreSnapshotOperation };
