const { calculateExpandedScore, emptyScoringStats, addScoringStats } = require("../../domain/statistics/expandedScoringPolicy");
const { createDailyPoolRanker } = require("./createDailyPoolRanker");
const { vancouverDate } = require("../../daily/vancouverDate");
const { normalizeExpandedReports } = require("./normalizeExpandedReports");
const { easternStart } = require("./NhlCompletedGameAdapter");

const WEB = "https://api-web.nhle.com/v1";
const STATS = "https://api.nhle.com/stats/rest/en";
const MINUTE = 60_000;
const DAY = 86_400_000;
const excluded = state => ["PPD", "CNCL", "CANC"].includes(state);
const positions = { C: "C", L: "LW", R: "RW", D: "D" };

function unavailable() {
  return Object.assign(new Error("Daily is waiting for complete NHL data."), { code: "HUNDO_DAILY_FEED_UNAVAILABLE", status: 503 });
}
function check(condition) {
  if (!condition) throw unavailable();
}
function nhlId(value) {
  check(/^[1-9]\d{0,12}$/.test(String(value)));
  return String(value);
}
function finishedBoxPlayers(box, game) {
  check(String(box.id) === game.id && String(box.season) === game.season && box.gameType === game.gameType &&
    ["OFF", "FINAL"].includes(box.gameState) && Date.parse(box.startTimeUTC) === game.startsAtMs);
  const players = new Map();
  for (const side of ["homeTeam", "awayTeam"]) {
    check(box[side]?.abbrev === game[side] && String(box[side].id) === game[side + "Id"]);
    const lines = box.playerByGameStats?.[side];
    check(Array.isArray(lines?.forwards) && Array.isArray(lines.defense) && lines.forwards.length && lines.defense.length);
    for (const row of [...lines.forwards, ...lines.defense]) {
      const id = nhlId(row.playerId);
      check(!players.has(id) && Number.isSafeInteger(row.goals) && row.goals >= 0 &&
        Number.isSafeInteger(row.assists) && row.assists >= 0 && row.points === row.goals + row.assists);
      players.set(id, { ...row, team: game[side] });
    }
  }
  return players;
}

function createHundoDailyFeed({ fetchImpl = fetch, nowMs = Date.now, timeoutMs = 8000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;

  // Share requests between rooms and tabs. Limit network concurrency across all slates.
  async function json(url, expectedRedirect) {
    if (active >= 4) {
      check(queue.length < 64);
      await new Promise(resolve => queue.push(resolve));
    } else active++;
    try {
      const options = { headers: { Accept: "application/json", "User-Agent": "hundo-leago/1.0" },
        signal: AbortSignal.timeout(timeoutMs), redirect: expectedRedirect ? "manual" : "error" };
      let response = await fetchImpl(url, options);
      if (expectedRedirect && [301, 302, 307, 308].includes(response.status)) {
        // /current redirects to the NHL's active roster. Never substitute a historical season roster.
        check(new URL(response.headers.get("location"), url).href === expectedRedirect);
        response = await fetchImpl(expectedRedirect, { ...options, redirect: "error" });
      }
      check(response.ok);
      return await response.json();
    } catch { throw unavailable(); }
    finally {
      if (queue.length) queue.shift()();
      else active--;
    }
  }

  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && hit.until > nowMs()) {
      if (hit.failed) throw unavailable();
      return hit.value;
    }
    if (pending.has(key)) return pending.get(key);
    check(pending.size < 128);
    const task = (async () => {
      try {
        const value = await load();
        cache.set(key, { value, until: nowMs() + ttl });
        return value;
      } catch {
        cache.set(key, { failed: true, until: nowMs() + 15_000 });
        throw unavailable();
      } finally {
        while (cache.size > 256) cache.delete(cache.keys().next().value);
      }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }

  function dayGames(date) {
    check(typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date));
    const midnight = Date.parse(date + "T00:00:00Z");
    check(Number.isSafeInteger(midnight) && new Date(midnight).toISOString().startsWith(date));
    return cached("schedule:" + date, MINUTE, async () => {
      const body = await json(WEB + "/schedule/" + date);
      const nextDate = new Date(midnight + DAY).toISOString().slice(0, 10);
      const games = [];
      const ids = new Set();
      // The NHL groups games by its Eastern calendar. The Vancouver date can extend into the next group.
      for (const dayLabel of [date, nextDate]) {
        const day = body?.gameWeek?.find(row => row.date === dayLabel);
        check(Array.isArray(day?.games) && day.games.length <= 32);
        for (const raw of day.games) {
          if (![1, 2, 3].includes(raw.gameType)) continue;
          const startsAtMs = Date.parse(raw.startTimeUTC);
          check(Number.isSafeInteger(startsAtMs));
          if (vancouverDate(startsAtMs) !== date) continue;
          const id = nhlId(raw.id), season = String(raw.season);
          const homeTeam = raw.homeTeam?.abbrev, awayTeam = raw.awayTeam?.abbrev;
          check(!ids.has(id) && /^\d{8}$/.test(season) && /^[A-Z]{2,3}$/.test(homeTeam) &&
            /^[A-Z]{2,3}$/.test(awayTeam) && homeTeam !== awayTeam);
          check(excluded(raw.gameScheduleState) || (raw.gameScheduleState === "OK" &&
            ["FUT", "PRE", "LIVE", "CRIT", "FINAL", "OFF"].includes(raw.gameState)));
          ids.add(id);
          games.push({ id, season, gameType: raw.gameType, startsAtMs, homeTeam, awayTeam,
            homeTeamId: nhlId(raw.homeTeam.id), awayTeamId: nhlId(raw.awayTeam.id), excluded: excluded(raw.gameScheduleState) });
        }
      }
      return games.sort((a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id));
    });
  }

  async function getSchedule(date) {
    const games = (await dayGames(date)).filter(game => !game.excluded);
    return games.length ? { date, firstGameAt: games[0].startsAtMs, games } : null;
  }

  function teamRoster(team, season) {
    return cached("roster:" + team + ":" + season, 5 * MINUTE, async () => {
      const base = WEB + "/roster/" + team + "/";
      const body = await json(base + "current", base + season);
      const players = [];
      for (const group of ["forwards", "defensemen"]) {
        check(Array.isArray(body?.[group]) && body[group].length > 0);
        for (const row of body[group]) {
          const position = positions[row.positionCode];
          check(position && (position === "D") === (group === "defensemen"));
          const name = [row.firstName?.default, row.lastName?.default];
          check(name.every(part => typeof part === "string" && part.trim().length));
          players.push({ id: nhlId(row.id), name: name.map(part => part.trim()).join(" "), position, team, lineupStatus: "projected" });
        }
      }
      return players;
    });
  }

  function confirmedLineup(game) {
    return cached("lineup:" + game.id, MINUTE, async () => {
      const body = await json(WEB + "/gamecenter/" + game.id + "/play-by-play");
      check(String(body?.id) === game.id && String(body.season) === game.season && body.gameType === game.gameType &&
        String(body.homeTeam?.id) === game.homeTeamId && String(body.awayTeam?.id) === game.awayTeamId);
      const spots = body.rosterSpots ?? [];
      check(Array.isArray(spots) && spots.length <= 60);
      const players = [];
      for (const row of spots) {
        if (row.positionCode === "G") continue;
        const home = String(row.teamId) === game.homeTeamId;
        const position = positions[row.positionCode];
        check((home || String(row.teamId) === game.awayTeamId) && position);
        const name = [row.firstName?.default, row.lastName?.default];
        check(name.every(part => typeof part === "string" && part.trim().length));
        players.push({ id: nhlId(row.playerId), name: name.map(part => part.trim()).join(" "), position,
          team: home ? game.homeTeam : game.awayTeam, opponent: home ? game.awayTeam : game.homeTeam, lineupStatus: "confirmed" });
      }
      check(new Set(players.map(player => player.id)).size === players.length);
      // An empty or partially posted pregame roster is not a confirmed lineup.
      const complete = [game.homeTeam, game.awayTeam].every(team => {
        const skaters = players.filter(p => p.team === team);
        return skaters.length >= 15 && skaters.length <= 20 && skaters.some(p => p.position === "D");
      });
      if (complete) return players;
      check(["FUT", "PRE"].includes(body.gameState));
      return null;
    });
  }

  async function getSlate(date) {
    const schedule = await getSchedule(date);
    if (!schedule) return null;
    const rows = await Promise.all(schedule.games.map(async game => {
      const confirmed = await confirmedLineup(game);
      if (confirmed) return confirmed;
      const sides = [[game.homeTeam, game.awayTeam], [game.awayTeam, game.homeTeam]];
      return (await Promise.all(sides.map(async ([team, opponent]) =>
        (await teamRoster(team, game.season)).map(player => ({ ...player, opponent }))))).flat();
    }));
    const byPlayer = new Map();
    for (const player of rows.flat()) {
      const previous = byPlayer.get(player.id);
      if (previous) {
        check(previous.team === player.team && previous.position === player.position && previous.opponent !== player.opponent);
        byPlayer.set(player.id, { ...player, opponent: previous.opponent + " / " + player.opponent,
          lineupStatus: previous.lineupStatus === "confirmed" ? player.lineupStatus : "projected" });
      } else byPlayer.set(player.id, player);
    }
    const players = [...byPlayer.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { ...schedule, players };
  }

  async function report(resource, ids) {
    const schedule = resource === "game";
    const property = schedule ? "id" : "gameId";
    const query = new URLSearchParams({ cayenneExp: property + " in (" + ids.join(",") + ")", start: "0", limit: "100",
      sort: JSON.stringify((schedule ? ["id"] : ["gameId", "playerId"]).map(property => ({ property, direction: "ASC" }))) });
    if (!schedule) {
      query.set("isAggregate", "false");
      query.set("isGame", "true");
    }
    const page = await json(STATS + "/" + resource + "?" + query);
    // Batches have at most two games (at most 80 skater rows), so any pagination is unexpected.
    check(Array.isArray(page?.data) && page.data.length === page.total && page.total <= 100);
    return page.data;
  }

  async function completedStats(games) {
    const ids = games.map(game => game.id);
    return cached("stats:" + games.map(game => game.id + "@" + game.startsAtMs).join(","), 5 * MINUTE, async () => {
      const [summary, realtime, scoring, penalties, penaltyShots] = await Promise.all(
        ["summary", "realtime", "scoringpergame", "penalties", "penaltyShots"].map(resource => report("skater/" + resource, ids)));
      const shotGames = new Set(penaltyShots.filter(row => row.penaltyShotsGoals > 0).map(row => String(row.gameId)));
      const penaltyShotLandings = [];
      for (const id of shotGames) {
        const game = games.find(row => row.id === id);
        check(game);
        const landing = await json(WEB + "/gamecenter/" + id + "/landing");
        check(String(landing?.id) === id && String(landing.season) === game.season && landing.gameType === game.gameType);
        penaltyShotLandings.push(landing);
      }
      const categories = normalizeExpandedReports({ summary, realtime, scoring, penalties, penaltyShots, penaltyShotLandings });
      const result = [];
      const boxes = new Map(await Promise.all(games.map(async game => [game.id,
        finishedBoxPlayers(await json(WEB + "/gamecenter/" + game.id + "/boxscore"), game)])));
      for (const row of summary) {
        const game = games.find(game => game.id === String(row.gameId));
        const playerId = nhlId(row.playerId);
        const box = boxes.get(game?.id);
        const player = box?.get(playerId);
        check(player && player.team === row.teamAbbrev && player.goals === row.goals && player.assists === row.assists &&
          row.points === row.goals + row.assists && ["H", "R"].includes(row.homeRoad) &&
          row.teamAbbrev === (row.homeRoad === "H" ? game.homeTeam : game.awayTeam) &&
          row.opponentTeamAbbrev === (row.homeRoad === "H" ? game.awayTeam : game.homeTeam));
        box.delete(playerId);
        result.push({ playerId, stats: categories.get(game.id + ":" + playerId) });
      }
      for (const game of games) {
        const count = summary.filter(row => String(row.gameId) === game.id).length;
        check(count >= 30 && count <= 40);
        // Official boxscores can list a dressed skater with no ice time and no report.
        for (const row of boxes.get(game.id).values()) check(row.toi === "00:00" && row.points === 0);
      }
      return result;
    });
  }

  async function getScores(slate) {
    const current = await dayGames(slate.date);
    const byId = new Map(slate.games.map(game => [game.id, game]));
    for (const game of current) byId.set(game.id, game);
    const games = [...byId.values()].filter(game => !game.excluded).sort((a, b) => a.id.localeCompare(b.id));
    const present = new Set(current.map(game => game.id));
    const completed = [];
    const activeGames = [];
    let final = true;
    if (games.length) {
      const ids = games.map(game => game.id);
      const gameRows = await cached("states:" + ids.join(","), MINUTE, () => report("game", ids));
      const official = new Map(gameRows.map(row => [String(row.id), row]));
      check(official.size === gameRows.length && official.size === games.length);
      for (const game of games) {
        const row = official.get(game.id);
        check(row && String(row.season) === game.season && row.gameType === game.gameType &&
          String(row.homeTeamId) === game.homeTeamId && String(row.visitingTeamId) === game.awayTeamId);
        const startsAtMs = easternStart(row.easternStartTime);
        if (!present.has(game.id)) {
          // A removed game is only a confirmed non-event if the NHL moved it off the room's date.
          check(vancouverDate(startsAtMs) !== slate.date);
          continue;
        }
        check(startsAtMs === game.startsAtMs);
        activeGames.push(game);
        if (row.gameStateId === 7 && startsAtMs <= nowMs()) completed.push(game);
        else final = false;
      }
    }
    const players = new Map(slate.players.map(player => [player.id, player]));
    const pointsByPlayerId = Object.fromEntries([...players.keys()].map(id => [id, 0]));
    const collectedStats = Object.fromEntries([...players.keys()].map(id => [id, emptyScoringStats()]));
    for (let i = 0; i < completed.length; i += 2) {
      for (const { playerId, stats } of await completedStats(completed.slice(i, i + 2))) {
        const player = players.get(playerId);
        if (player) {
          pointsByPlayerId[playerId] += calculateExpandedScore(stats, player.position === "D" ? "D" : "F").fantasyPointsHundredths;
          addScoringStats(collectedStats[playerId], stats);
        }
      }
    }
    const playerStatsById = Object.fromEntries([...players.values()].map(player => {
      const playsFor = game => game.homeTeam === player.team || game.awayTeam === player.team;
      const gamesExpected = activeGames.filter(playsFor).length;
      const gamesCollected = completed.filter(playsFor).length;
      const collectedGameIds = completed.filter(playsFor).map(game => game.id).sort();
      const statsStatus = gamesCollected === gamesExpected ? "collected" : gamesCollected ? "partial" : "pending";
      return [player.id, { scoringStats: statsStatus === "pending" ? null : collectedStats[player.id],
        statsStatus, gamesCollected, gamesExpected, collectedGameIds }];
    }));
    return { final, pointsByPlayerId, playerStatsById, voided: final && completed.length === 0 };
  }
  const orderPlayerPool = createDailyPoolRanker({ json, cached, getSchedule, statsBase: STATS, webBase: WEB });
  return Object.freeze({ getSchedule, getSlate, getScores, orderPlayerPool });
}

module.exports = { createHundoDailyFeed };
