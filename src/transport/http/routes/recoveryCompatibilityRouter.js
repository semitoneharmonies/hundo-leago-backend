const express = require("express");

function createRecoveryCompatibilityRouter({
  snapshotOperations,
  restoreSnapshotOperation,
  backupOperations,
  logger = console,
} = {}) {
  if (!snapshotOperations) {
    throw new TypeError(
      "createRecoveryCompatibilityRouter requires snapshotOperations"
    );
  }
  if (!restoreSnapshotOperation) {
    throw new TypeError(
      "createRecoveryCompatibilityRouter requires restoreSnapshotOperation"
    );
  }
  if (!backupOperations) {
    throw new TypeError(
      "createRecoveryCompatibilityRouter requires backupOperations"
    );
  }

  const router = express.Router();

  router.get("/api/snapshots", (req, res) => {
    try {
      const snapshots = snapshotOperations.listSnapshots();
      res.json({ snapshots });
    } catch (error) {
      logger.error(
        "[BACKEND] Error listing snapshots:",
        error
      );
      res.status(500).json({
        snapshots: [],
        error: "Failed to load snapshots",
      });
    }
  });

  router.post("/api/snapshots/restore", async (req, res) => {
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "Missing snapshot id in body",
      });
    }

    if (!restoreSnapshotOperation.snapshotExists(id)) {
      return res.status(404).json({
        ok: false,
        error: "Snapshot not found",
      });
    }

    try {
      await restoreSnapshotOperation.restoreSnapshot(id);
      return res.json({ ok: true });
    } catch (error) {
      logger.error(
        "[BACKEND] Error restoring snapshot:",
        error
      );
      return res.status(500).json({
        ok: false,
        error: "Failed to restore snapshot",
      });
    }
  });

  router.post("/api/snapshots/create", async (req, res) => {
    try {
      const { name } = req.body || {};
      const snapshotId =
        await snapshotOperations.createSnapshot({ name });
      return res.json({ ok: true, snapshotId });
    } catch (error) {
      logger.error(
        "[BACKEND] Error creating snapshot:",
        error
      );
      return res.status(500).json({
        ok: false,
        error: "Failed to create snapshot",
      });
    }
  });

  router.get("/api/backups", (req, res) => {
    try {
      const limit = Number(req.query?.limit || 50) || 50;
      const result = backupOperations.listBackups({ limit });
      return res.json({
        ok: true,
        backups: result.backups,
        backupsDir: result.backupsDir,
      });
    } catch (error) {
      logger.error("[BACKUPS] list failed:", error);
      return res.status(500).json({
        ok: false,
        error: "Failed to list backups",
      });
    }
  });

  router.post("/api/backups/restore", async (req, res) => {
    logger.log(
      "[RESTORE] content-type:",
      req.headers["content-type"]
    );
    logger.log("[RESTORE] body:", req.body);

    const body = req.body || {};
    const meta = body.meta || {};
    const id = body.id || body.backupId;

    if (!id) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing backup id in body (expected: id or backupId)",
      });
    }

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({
        ok: false,
        error: "Restore requires commissioner role.",
      });
    }

    try {
      await backupOperations.restoreBackup(id);
      return res.json({ ok: true });
    } catch (error) {
      logger.error("[BACKUPS] restore failed:", error);
      return res.status(500).json({
        ok: false,
        error:
          error?.message || "Failed to restore backup",
      });
    }
  });

  return router;
}

module.exports = { createRecoveryCompatibilityRouter };
