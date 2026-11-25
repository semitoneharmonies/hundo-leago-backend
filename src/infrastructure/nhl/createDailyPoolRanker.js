const { calculateExpandedScore } = require("../../domain/statistics/expandedScoringPolicy");
const { normalizeExpandedReports } = require("./normalizeExpandedReports");

const MINUTE = 60_000;
const PAGE_SIZE = 1000;

function createDailyPoolRanker({ json, cached, getSchedule, statsBase, webBase }) {
  const lastGood = new Map();

  async function report(season, name) {
    // Season-level rows combine a player's teams. Penalty-shot goals need their
    // original game classification for Hundo's even-strength scoring rule.
    const perGame = name === "penaltyShots";
    const sort = (perGame ? ["gameId", "playerId"] : ["playerId"]).map(property => ({ property, direction: "ASC" }));
    const query = new URLSearchParams({ cayenneExp: "seasonId=" + season + " and gameTypeId=2",
      isAggregate: String(!perGame), isGame: String(perGame), limit: String(PAGE_SIZE), sort: JSON.stringify(sort) });
    const rows = [];
    let total;
    do {
      query.set("start", String(rows.length));
      const page = await json(statsBase + "/skater/" + name + "?" + query);
      if (!Number.isSafeInteger(page?.total) || page.total < 0 || page.total > 5000 ||
          (total !== undefined && total !== page.total) || !Array.isArray(page.data) || page.data.length > PAGE_SIZE ||
          rows.length + page.data.length > page.total || (!page.data.length && rows.length < page.total)) {
        throw new Error("Incomplete NHL season category report");
      }
      total = page.total;
      rows.push(...page.data);
    } while (rows.length < total);
    return rows;
  }

  async function load(season) {
    const [summary, realtime, scoring, penalties, penaltyShots] = await Promise.all(
      ["summary", "realtime", "scoringpergame", "penalties", "penaltyShots"].map(name => report(season, name)));
    const scoringGames = new Set(penaltyShots.filter(row => row.penaltyShotsGoals > 0).map(row => String(row.gameId)));
    const penaltyShotLandings = [];
    for (const id of scoringGames) {
      if (!/^[1-9]\d+$/.test(id)) throw new Error("Invalid NHL penalty-shot game");
      const game = await cached("rank-landing:" + id, 60 * MINUTE, () => json(webBase + "/gamecenter/" + id + "/landing"));
      if (String(game.id) !== id || String(game.season) !== season || game.gameType !== 2) throw new Error("Mismatched NHL penalty-shot game");
      penaltyShotLandings.push(game);
    }
    const categories = normalizeExpandedReports({ summary, realtime, scoring, penalties, penaltyShots, penaltyShotLandings }, { seasonTotals: true });
    const gamesPlayed = new Map(summary.map(row => [String(row.playerId), row.gamesPlayed]));
    const totals = new Map();
    for (const [id, stats] of categories) {
      totals.set(id, { gamesPlayed: gamesPlayed.get(id), F: calculateExpandedScore(stats, "F").fantasyPointsHundredths,
        D: calculateExpandedScore(stats, "D").fantasyPointsHundredths });
    }
    lastGood.set(season, totals);
    while (lastGood.size > 2) lastGood.delete(lastGood.keys().next().value);
    return totals;
  }

  return async function orderPlayerPool(date, players) {
    let season, totals;
    try {
      season = await cached("rank-season:" + date, 24 * 60 * MINUTE, async () => {
        const schedule = await getSchedule(date);
        const key = schedule?.games[0]?.season;
        if (!/^\d{8}$/.test(key) || !schedule.games.every(game => game.season === key)) throw new Error("NHL season unavailable");
        return key;
      });
      totals = await cached("rank-totals:" + season, 5 * MINUTE, () => load(season));
    } catch {
      totals = lastGood.get(season);
    }
    // Keep unplayed skaters after recorded averages, including negative ones.
    // Previously verified ranks survive outages; equal averages remain stable.
    const score = player => {
      const row = totals?.get(player.id);
      return row?.gamesPlayed > 0 ? row[player.position === "D" ? "D" : "F"] / row.gamesPlayed : null;
    };
    return [...players].sort((a, b) => {
      const aScore = score(a), bScore = score(b);
      return Number(bScore !== null) - Number(aScore !== null) || (bScore ?? 0) - (aScore ?? 0) ||
        a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id);
    });
  };
}

module.exports = { createDailyPoolRanker };
