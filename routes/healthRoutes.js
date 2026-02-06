// routes/healthRoutes.js (CommonJS)
// Purpose: isolate the minimal "server is up" + health diagnostic endpoints.
// RULE: zero behavior change vs server.js.

function registerHealthRoutes({ app, leagueStore, DATA_FILE, BACKUPS_DIR }) {
  if (!app) throw new Error("registerHealthRoutes requires { app }");
  if (!leagueStore) throw new Error("registerHealthRoutes requires { leagueStore }");

  // GET /
  app.get("/", (req, res) => {
    res.send("Hundo Leago backend is running.");
  });

  // GET /health
  app.get("/health", (req, res) => {
    const st = leagueStore.loadLeague();
    res.json({
      ok: true,
      schemaVersion: st.schemaVersion ?? null,
      loadedFromDisk: Boolean(st?.meta?.loadedFromDisk),
      dataFilePath: st?.meta?.dataFilePath || DATA_FILE,
      lastSavedAt: st?.meta?.lastSavedAt || null,
      lastSavedBy: st?.meta?.lastSavedBy || null,
      hasLoadError: Boolean(st?.meta?.loadError),
      lastAutoWeeklySnapshotId: st?.lastAutoWeeklySnapshotId ?? null,
      lastAutoAuctionRolloverId: st?.lastAutoAuctionRolloverId ?? null,
      backupsDir: leagueStore.backupsDir || BACKUPS_DIR,
      backupsCount: (() => {
        try {
          return leagueStore.listBackups({ limit: 999999 }).length;
        } catch (_) {
          return null;
        }
      })(),
    });
  });
}

module.exports = { registerHealthRoutes };
