const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHundoDailyFeed } = require("../../src/infrastructure/nhl/HundoDailyFeed");
const { normalizeExpandedReports } = require("../../src/infrastructure/nhl/normalizeExpandedReports");
const { calculateExpandedScore, emptyScoringStats, CATEGORY_KEYS } = require("../../src/domain/statistics/expandedScoringPolicy");
const captured = require("../fixtures/nhlExpandedScoringGames.json").games.find(game => game.gameId === 2025020477);

function fixture() {
  const reports = structuredClone(captured);
  const landing = reports.penaltyShotLandings[0];
  const lineup = { ...landing, gameState: "FUT", rosterSpots: [] };
  const box = { ...landing, playerByGameStats: {} };
  const boxes = new Map([[String(landing.id), box]]);
  const landings = new Map([[String(landing.id), landing]]);
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
    else if (last === "boxscore") data = boxes.get(url.pathname.split("/").at(-2));
    else if (last === "landing") data = landings.get(url.pathname.split("/").at(-2));
    else {
      const rows = last === "game" ? states : reports[last];
      data = { data: rows, total: rows.length };
    }
    return { ok: true, json: async () => structuredClone(data) };
  } });
  return { feed, day, next, landing, lineup, rosters, calls, reports, states, box, boxes, landings,
    advance: () => { now += 600_000; } };
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

test("Vancouver game dates use the 07:00 UTC winter boundary, with the previous 08:00 boundary for historical slates", async () => {
  for (const [date, midnight] of [["2026-11-16", "2026-11-17T07:00:00Z"], ["2025-11-16", "2025-11-17T08:00:00Z"]]) {
    const { feed, day, next, landing } = fixture();
    const cutoff = Date.parse(midnight);
    day.date = date;
    day.games = [];
    next.date = midnight.slice(0, 10);
    next.games = [
      { ...landing, startTimeUTC: new Date(cutoff - 1).toISOString() },
      { ...landing, id: landing.id + 1, startTimeUTC: midnight },
    ];
    const result = await feed.getSchedule(date);
    assert.deepEqual(result.games.map(row => row.id), [String(landing.id)]);
    assert.equal(result.firstGameAt, cutoff - 1);
  }
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
  assert.deepEqual(result.playerStatsById["999"], { scoringStats: emptyScoringStats(), statsStatus: "collected",
    gamesCollected: 1, gamesExpected: 1, collectedGameIds: [String(reports.gameId)] }, "A verified scratch has collected zero categories, not pending data");
  assert.equal(Object.keys(result.pointsByPlayerId).length, 37);
  assert.equal(Object.keys(result.playerStatsById).length, 37);
  let negative = false;
  for (const p of slate.players.filter(row => row.id !== "999")) {
    const stats = categories.get(reports.gameId + ":" + p.id);
    const target = calculateExpandedScore(stats, p.position === "D" ? "D" : "F").fantasyPointsHundredths;
    assert.equal(result.pointsByPlayerId[p.id], target);
    const detail = result.playerStatsById[p.id];
    assert.deepEqual(Object.keys(detail.scoringStats), CATEGORY_KEYS);
    assert.deepEqual(detail, { scoringStats: stats, statsStatus: "collected", gamesCollected: 1, gamesExpected: 1, collectedGameIds: [String(reports.gameId)] });
    if (target < 0) negative = true;
  }
  assert.equal(negative, true);
});

test("uncollected games expose pending null categories instead of collected zeroes", async () => {
  const { feed, day, states, calls } = fixture();
  states[0].gameStateId = 6;
  const slate = await feed.getSlate(day.date);
  const result = await feed.getScores(slate);
  assert.equal(result.final, false);
  for (const player of slate.players) {
    assert.equal(result.pointsByPlayerId[player.id], 0);
    assert.deepEqual(result.playerStatsById[player.id], { scoringStats: null, statsStatus: "pending",
      gamesCollected: 0, gamesExpected: 1, collectedGameIds: [] });
  }
  assert.equal(calls.some(path => path.endsWith("/boxscore")), false);
});

test("player collection completes independently of unfinished games involving other clubs", async () => {
  const { feed, day, landing, states, advance } = fixture();
  const slate = await feed.getSlate(day.date);
  day.games.push({ ...landing, id: landing.id + 1, startTimeUTC: "2025-12-11T03:30:00Z",
    homeTeam: { id: 23, abbrev: "VAN" }, awayTeam: { id: 55, abbrev: "SEA" } });
  states.push({ ...states[0], id: landing.id + 1, gameStateId: 6, homeTeamId: 23, visitingTeamId: 55,
    easternStartTime: "2025-12-10T22:30:00" });
  advance();
  const result = await feed.getScores(slate);
  assert.equal(result.final, false);
  for (const detail of Object.values(result.playerStatsById)) {
    assert.equal(detail.statsStatus, "collected");
    assert.equal(detail.gamesCollected, 1);
    assert.equal(detail.gamesExpected, 1);
  }
});

test("two team games retain partial categories until both validate, then sum every category and authoritative points", async () => {
  const { feed, day, reports, states, advance, landing, box, boxes, landings } = fixture();
  const slate = await feed.getSlate(day.date);
  const later = { ...landing, id: landing.id + 1, startTimeUTC: "2025-12-11T03:30:00Z" };
  day.games.push(later);
  states.push({ ...states[0], id: later.id, gameStateId: 6, easternStartTime: "2025-12-10T22:30:00" });
  advance();
  const partial = await feed.getScores(slate);
  assert.equal(partial.final, false);
  for (const detail of Object.values(partial.playerStatsById)) {
    assert.equal(detail.statsStatus, "partial");
    assert.equal(detail.gamesCollected, 1);
    assert.equal(detail.gamesExpected, 2);
    assert.deepEqual(Object.keys(detail.scoringStats), CATEGORY_KEYS);
  }
  for (const key of ["summary", "realtime", "scoringpergame", "penalties", "penaltyShots"]) {
    reports[key].push(...reports[key].map(row => ({ ...row, gameId: later.id })));
  }
  boxes.set(String(later.id), { ...structuredClone(box), id: later.id, startTimeUTC: later.startTimeUTC });
  landings.set(String(later.id), later);
  states[1].gameStateId = 7;
  advance();
  const complete = await feed.getScores(slate);
  assert.equal(complete.final, true);
  for (const player of slate.players) {
    const first = partial.playerStatsById[player.id].scoringStats;
    const expected = Object.fromEntries(CATEGORY_KEYS.map(key => [key, first[key] * 2]));
    assert.deepEqual(complete.playerStatsById[player.id], { scoringStats: expected, statsStatus: "collected",
      gamesCollected: 2, gamesExpected: 2, collectedGameIds: [String(reports.gameId), String(later.id)].sort() });
    assert.equal(complete.pointsByPlayerId[player.id], partial.pointsByPlayerId[player.id] * 2);
    assert.equal(calculateExpandedScore(expected, player.position === "D" ? "D" : "F").fantasyPointsHundredths,
      complete.pointsByPlayerId[player.id]);
  }
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

test("Daily pool sorting follows season F/D points per game with stable ties, unplayed skaters last and no exposed scores", async () => {
  const { feed, reports, day, calls, advance } = fixture();
  const base = [21, 22, 23, 24].map((playerId, i) => ({ playerId, gamesPlayed: [1, 3, 2, 2][i], goals: 0, assists: 0 }));
  reports.summary = base.map(row => ({ ...row, evGoals: 0, ppGoals: 0, shGoals: 0, shots: 0, gameWinningGoals: 0 }));
  reports.realtime = base.map((row, i) => ({ ...row, hits: [4, 3, 0, 8][i], blockedShots: 0, giveaways: [0, 0, 2, 0][i], takeaways: 0 }));
  reports.scoringpergame = base.map(row => ({ ...row, totalPrimaryAssists: 0, totalSecondaryAssists: 0 }));
  reports.penalties = base.map(row => ({ ...row, penalties: 0, penaltiesDrawn: 0 }));
  reports.penaltyShots = [];
  const pool = [
    { id: "21", name: "Aaron", position: "LW" }, { id: "23", name: "Bob", position: "C" },
    { id: "99", name: "Chris", position: "D" }, { id: "98", name: "Chris", position: "RW" },
    { id: "22", name: "Zane", position: "D" },
    { id: "24", name: "Aaron", position: "F" },
  ];
  const rank = () => feed.orderPlayerPool(day.date, pool);
  // D's 1.05 FP / 3 GP trails LW's 0.80 / 1 and F's 1.60 / 2.
  // The two Aarons tie on FP/G and name; the ID breaks the tie. Played negative FP/G stays above unplayed.
  const expected = [pool[0], pool[5], pool[4], pool[1], pool[3], pool[2]];
  const [first, concurrent] = await Promise.all([rank(), rank()]);
  assert.deepEqual(first, expected);
  assert.deepEqual(concurrent, expected);
  assert.equal(calls.filter(path => path.endsWith("/skater/summary")).length, 1);
  assert.deepEqual(pool.map(player => player.id), ["21", "23", "99", "98", "22", "24"]);
  advance();
  reports.penalties.pop();
  assert.deepEqual(await rank(), expected, "Keep the previous complete ranking through a partial NHL refresh");
  advance();
  reports.penalties.push({ ...base[3], penalties: 0, penaltiesDrawn: 0 });
  reports.realtime[1].hits = 9;
  assert.equal((await rank())[0].id, "22", "Existing rooms see refreshed season averages");
});
