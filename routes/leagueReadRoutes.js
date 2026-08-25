// routes/leagueReadRoutes.js (CommonJS)
// Read-only league endpoints — zero behavior change.

function registerLeagueReadRoutes({ app, leagueStore }) {
  if (!app) throw new Error("registerLeagueReadRoutes requires { app }");
  if (!leagueStore) throw new Error("registerLeagueReadRoutes requires { leagueStore }");

  // GET /api/league
  app.get("/api/league", (req, res) => {
    const state = leagueStore.loadLeague();
    res.json(state);
  });
}

module.exports = { registerLeagueReadRoutes };
