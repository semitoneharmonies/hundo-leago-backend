function createBackupOperations({
  leagueStore,
  nowMs = Date.now,
  random = Math.random,
  publisher,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createBackupOperations requires a leagueStore"
    );
  }

  function listBackups({ limit } = {}) {
    return {
      backups: leagueStore.listBackups({ limit }),
      backupsDir: leagueStore.backupsDir,
    };
  }

  async function restoreBackup(backupId) {
    const restoredRaw = await leagueStore.restoreBackup(backupId, {
      restoredBy: "commissioner",
    });
    const restored = {
      ...leagueStore.emptyState(),
      ...restoredRaw,
    };
    const timestamp = nowMs();
    const previousLog = Array.isArray(restored.leagueLog)
      ? restored.leagueLog
      : [];

    restored.leagueLog = [
      {
        id: timestamp + random(),
        type: "commRestoreBackup",
        by: "Commissioner",
        backupId,
        timestamp,
      },
      ...previousLog,
    ];

    await leagueStore.saveLeague(restored, {
      savedBy: "commissioner:backupRestore",
    });

    if (publisher?.publish) {
      await publisher.publish("league:updated", {
        reason: "backupRestored",
        backupId,
      });
    }

    return restored;
  }

  return {
    listBackups,
    restoreBackup,
  };
}

module.exports = { createBackupOperations };
