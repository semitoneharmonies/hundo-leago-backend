// routes/playersReadRoutes.js (CommonJS)
// Players read endpoints — extracted verbatim from server.js.
// IMPORTANT: /api/players/debug must come BEFORE /api/players/:id

function registerPlayersReadRoutes({
  app,
  fs,
  path,
  PLAYERS_FILE,
  playersCache,
  playersById,
  searchPlayers,
}) {
  if (!app) throw new Error("registerPlayersReadRoutes requires { app }");

  // GET /api/players
  app.get("/api/players", (req, res) => {
    const q = String(req.query?.query || "").trim();

    // If NO query (your preload case), allow a large response, but keep a safety cap.
    // 5000 is plenty (your DB is ~2k) and prevents insane payloads.
    const rawLimit = Number(req.query?.limit);
    const limitNoQuery = Math.max(
      1,
      Math.min(5000, Number.isFinite(rawLimit) ? rawLimit : 5000)
    );

    // If query IS present (typeahead search), keep it small for speed.
    const limitQuery = Math.max(1, Math.min(100, Number(req.query?.limit || 25) || 25));

    // No query: return a large slice (PRELOAD PATH)
    if (!q) {
      return res.json({
        ok: true,
        players: playersCache.slice(0, limitNoQuery),
        count: playersCache.length,
        cacheCount: playersCache.length,
        limitUsed: limitNoQuery,
      });
    }

    // Query: return search results (SEARCH PATH)
    const results = searchPlayers(q, limitQuery);
    return res.json({
      ok: true,
      players: results,
      count: playersCache.length,
      cacheCount: playersCache.length,
      limitUsed: limitQuery,
    });
  });

  // GET /api/players/debug
  app.get("/api/players/debug", (req, res) => {
    try {
      const repoPlayers = path.join(__dirname, "..", "players.json");

      const statSafe = (p) => {
        try {
          if (!fs.existsSync(p)) return { exists: false };
          const st = fs.statSync(p);
          return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
        } catch (e) {
          return { exists: false, error: String(e?.message || e) };
        }
      };

      res.json({
        ok: true,
        PLAYERS_FILE,
        disk: statSafe(PLAYERS_FILE),
        repo: statSafe(repoPlayers),
        cacheCount: playersCache.length,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // GET /api/players/:id
  app.get("/api/players/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "Invalid player id" });
    }

    const p = playersById.get(id);
    if (!p) {
      return res.status(404).json({ ok: false, error: "Player not found" });
    }

    res.json({ ok: true, player: p });
  });
}

module.exports = { registerPlayersReadRoutes };
