const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHundoDailyFeed } = require("../../src/infrastructure/nhl/HundoDailyFeed");
const { normalizeExpandedReports } = require("../../src/infrastructure/nhl/normalizeExpandedReports");
const { calculateExpandedScore } = require("../../src/domain/statistics/expandedScoringPolicy");
const captured = require("../fixtures/nhlExpandedScoringGames.json").games.find(game => game.gameId === 2025020477);

function fixture() {
  const reports = structuredClone(captured);
  const landing = reports.penaltyShotLandings[0];
  const lineup = { ...landing, gameState: "FUT", rosterSpots: [] };
  const box = { ...landing, playerByGameStats: {} };
  const rosters = {};
  for (const side of ["homeTeam", "awayTeam"]) {
    const team = landing[side].abbrev;
    const rows = reports.summary.filter(row => row.teamAbbrev === team);
    box.playerByGameStats[side] = { forwards: rows.slice(0, 12), defense: rows.slice(12) };
    const players = rows.map((row, i) => ({ id: row.playerId, firstName: { default: "First" },
      lastName: { default: String(row.playerId) }, positionCode: i < 12 ? "L" : "D" }));
    rosters[team] = { forwards: players.slice(0, 12), defensemen: players.slice(12), goalies: [{ id: 555 }] };
  }
  rosters.CGY.forwards.push({ id: 999, firstName: { default: "Scratched" }, lastName: { default: "Player" }, positionCode: "C" });
  const day = { date: "2025-12-10", games: [landing] };
  const next = { date: "2025-12-11", games: [] };
  const states = [{ id: landing.id, gameStateId: 7, gameType: 2, season: landing.season,
    easternStartTime: "2025-12-10T20:30:00", homeTeamId: landing.homeTeam.id, visitingTeamId: landing.awayTeam.id }];
  const calls = [];
  let now = Date.parse("2025-12-11T12:00:00Z");
  const feed = createHundoDailyFeed({ nowMs: () => now, fetchImpl: async uri => {
    const url = new URL(uri);
    calls.push(url.pathname);
    const last = url.pathname.split("/").at(-1);
    let data;
    if (url.pathname.includes("/schedule/")) data = { gameWeek: [day, next] };
    else if (url.pathname.includes("/roster/")) data = rosters[url.pathname.split("/").at(-2)];
    else if (last === "play-by-play") data = lineup;
    else if (last === "boxscore") data = box;
    else if (last === "landing") data = landing;
    else {
      const rows = last === "game" ? states : reports[last];
      data = { data: rows, total: rows.length };
    }
    return { ok: true, json: async () => structuredClone(data) };
  } });
  return { feed, day, next, landing, lineup, rosters, calls, reports, states, box, advance: () => { now += 600_000; } };
}

test("Pacific schedule includes a late game from the next Eastern date, skips postponements, and never reads rosters for a lobby check", async () => {
  const { feed, day, next, landing, calls } = fixture();
  day.games.unshift({ ...landing, id: landing.id - 1, startTimeUTC: "2025-12-10T17:30:00Z", gameScheduleState: "PPD" });
  next.games.push({ ...landing, id: landing.id + 1, startTimeUTC: "2025-12-11T06:00:00Z" },
    { ...landing, id: landing.id + 2, startTimeUTC: "2025-12-11T08:00:00Z" });
  const [a, b] = await Promise.all([feed.getSchedule(day.date), feed.getSchedule(day.date)]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.games.map(row => row.id), [String(landing.id), String(landing.id + 1)]);
  assert.equal(a.firstGameAt, Date.parse(landing.startTimeUTC));
  assert.equal(calls.length, 1);
});

test("empty days return no slate; incomplete dates and unknown starts cannot open a room", async () => {
  const { feed, day, landing, next, calls, advance } = fixture();
  day.games = [];
  assert.equal(await feed.getSlate(day.date), null);
  assert.equal(calls.length, 1);
  advance(); day.games = [{ ...landing, gameScheduleState: "TBD" }];
  await assert.rejects(feed.getSlate(day.date), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
  advance(); day.games = [landing]; next.date = "2025-12-12";
  await assert.rejects(feed.getSchedule(day.date), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
  await assert.rejects(feed.getSchedule("2025-02-30"), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
});

test("room slates share official rosters; a duplicated player on two clubs cannot be sold", async () => {
  const { feed, day, calls, rosters, advance } = fixture();
  const [a, b] = await Promise.all([feed.getSlate(day.date), feed.getSlate(day.date)]);
  assert.deepEqual(a, b);
  assert.equal(calls.filter(path => path.includes("/roster/")).length, 2);
  assert.equal(a.players.length, 37);
  assert.deepEqual(a.players.find(p => p.id === "999"), { id: "999", name: "Scratched Player", position: "C",
    team: "CGY", opponent: "DET", lineupStatus: "projected" });
  assert.equal(a.players.some(p => p.id === "555"), false);
  advance(); rosters.DET.forwards.push(rosters.CGY.forwards[0]);
  await assert.rejects(feed.getSlate(day.date), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
});

test("published game-specific lineups replace projections and do not read current club rosters", async () => {
  const { feed, day, landing, lineup, rosters, calls } = fixture();
  lineup.gameState = "PRE";
  for (const side of ["homeTeam", "awayTeam"]) {
    const team = landing[side];
    const roster = rosters[team.abbrev];
    lineup.rosterSpots.push(...[...roster.forwards, ...roster.defensemen].filter(p => p.id !== 999)
      .map(p => ({ ...p, teamId: team.id, playerId: p.id })), { teamId: team.id, playerId: 555, positionCode: "G" });
  }
  const slate = await feed.getSlate(day.date);
  assert.equal(slate.players.length, 36);
  assert.ok(slate.players.every(player => player.lineupStatus === "confirmed"));
  assert.ok(!slate.players.some(player => player.id === "999" || player.id === "555"));
  assert.ok(!calls.some(path => path.includes("/roster/")));
});

test("confirmed player-game evidence reproduces the season scores including signed totals, positional bonuses, and penalty shots", async () => {
  const { feed, day, reports, calls } = fixture();
  const slate = await feed.getSlate(day.date);
  const [result, replay] = await Promise.all([feed.getScores(slate), feed.getScores(slate)]);
  const categories = normalizeExpandedReports({ ...reports, scoring: reports.scoringpergame });
  assert.equal(result.final, true);
  assert.deepEqual(result, replay);
  assert.equal(calls.filter(path => path.endsWith("/boxscore")).length, 1);
  assert.equal(calls.filter(path => path.endsWith("/landing")).length, 1);
  assert.equal(result.pointsByPlayerId["999"], 0);
  assert.equal(Object.keys(result.pointsByPlayerId).length, 37);
  let negative = false;
  for (const p of slate.players.filter(row => row.id !== "999")) {
    const stats = categories.get(reports.gameId + ":" + p.id);
    const target = calculateExpandedScore(stats, p.position === "D" ? "D" : "F").fantasyPointsHundredths;
    assert.equal(result.pointsByPlayerId[p.id], target);
    if (target < 0) negative = true;
  }
  assert.equal(negative, true);
});

test("an unofficial game elsewhere keeps the whole day provisional; missing statistics or box data never produce a winner", async () => {
  const { feed, day, reports, states, advance, landing, box } = fixture();
  const slate = await feed.getSlate(day.date);
  const later = { ...landing, id: landing.id + 1, startTimeUTC: "2025-12-11T03:30:00Z" };
  day.games.push(later);
  states.push({ ...states[0], id: later.id, gameStateId: 6, easternStartTime: "2025-12-10T22:30:00" });
  advance();
  const score = await feed.getScores(slate);
  assert.equal(score.final, false);
  assert.ok(Object.values(score.pointsByPlayerId).some(n => n > 0));
  advance(); day.games.pop(); states.pop();
  const missing = reports.penalties.pop();
  await assert.rejects(feed.getScores(slate), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
  advance(); reports.penalties.push(missing); box.playerByGameStats.homeTeam.defense.pop();
  await assert.rejects(feed.getScores(slate), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
});

test("a vanished game waits for an official move off the slate; an explicitly postponed fixture contributes zero", async () => {
  const { feed, day, landing, states, advance } = fixture();
  const slate = await feed.getSlate(day.date);
  day.games = []; advance();
  await assert.rejects(feed.getScores(slate), { code: "HUNDO_DAILY_FEED_UNAVAILABLE" });
  states[0].easternStartTime = "2026-01-03T20:30:00"; advance();
  const moved = await feed.getScores(slate);
  assert.ok(moved.final && moved.voided && Object.values(moved.pointsByPlayerId).every(n => n === 0));
  advance(); day.games = [{ ...landing, gameScheduleState: "PPD" }];
  assert.deepEqual(await feed.getScores(slate), moved);
});
