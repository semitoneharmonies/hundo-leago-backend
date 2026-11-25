const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createDailyStore } = require("../../src/daily/createDailyStore");
const { createDailyService } = require("../../src/daily/createDailyService");
const { createDailyLiveDisplay } = require("../../src/daily/createDailyLiveDisplay");
const { emptyScoringStats, calculateExpandedScore, addScoringStats } = require("../../src/domain/statistics/expandedScoringPolicy");

const puck = Date.parse("2026-11-19T02:00:00Z"), minute = 60_000;
const host = { id: "host", name: "Host" }, guest = { id: "guest", name: "Guest" };
const slate = { date: "2026-11-18", firstGameAt: puck,
  games: [0, 1].map(index => ({ id: String(2026020344 + index), season: "20262027", gameType: 2,
    startsAtMs: puck + index * 60 * minute, homeTeam: "DET", awayTeam: "BOS", homeTeamId: "17", awayTeamId: "6", excluded: false })),
  players: [{ id: "1", name: "Forward", position: "C", team: "DET", opponent: "BOS" },
    { id: "2", name: "Defence", position: "D", team: "DET", opponent: "BOS" },
    { id: "3", name: "Opponent", position: "LW", team: "BOS", opponent: "DET" }] };
const stats = changes => ({ ...emptyScoringStats(), ...changes });
const first = { "1": stats({ shotsOnGoal: 2 }), "2": stats({ giveaways: 1 }), "3": stats() };
const second = { "1": stats({ primaryAssists: 1, giveaways: 1 }), "2": stats({ hits: 2, blockedShots: 1 }), "3": stats({ powerPlayGoals: 1, penaltiesTaken: 1 }) };
function game(index, values = second, state = "live") {
  const original = slate.games[index];
  return { gameId: original.id, nhlSeasonKey: original.season, startsAtMs: original.startsAtMs, state, updatedAtMs: puck + minute,
    playerGames: slate.players.map(player => ({ providerPlayerId: player.id, providerTeamId: player.team === "DET" ? "17" : "6",
      positionGroup: player.position === "D" ? "D" : "F", gamesPlayed: 1, scoringStats: { ...values[player.id] } })) };
}
function snapshot(games, status = "available") { return { enabled: true, status, updatedAtMs: puck + minute, lastAttemptAtMs: puck + minute, games }; }
function report(values, ids = [], final = false) {
  return { final, pointsByPlayerId: Object.fromEntries(slate.players.map(player => [player.id,
    calculateExpandedScore(values[player.id], player.position === "D" ? "D" : "F").fantasyPointsHundredths])),
  playerStatsById: Object.fromEntries(slate.players.map(player => [player.id, { scoringStats: values[player.id],
    statsStatus: ids.length === 2 ? "collected" : "partial", gamesCollected: ids.length, gamesExpected: 2, collectedGameIds: ids }])) };
}
function setup(t, mode = "scheduled") {
  let now = mode === "practice" ? puck + 75 * minute : puck - 30 * minute;
  const store = createDailyStore({ filename: ":memory:", clock: () => now }); t.after(() => store.close());
  const room = store.createRoom({ actor: host, name: "Live", capacity: 2, mode, slate });
  store.joinRoom({ actor: guest, roomId: room.id });
  for (const player of slate.players) store.bid({ actor: player.id === "3" ? guest : host, roomId: room.id,
    playerId: player.id, amount: Number(player.id) + 4 });
  const clock = value => { now = value; };
  clock(mode === "practice" ? now + 30 * minute : puck);
  return { store, roomId: room.id, clock, view: () => store.getRoom({ actor: host, roomId: room.id }),
    context: () => store.readRoomForDisplay({ actor: host, roomId: room.id }),
    update: value => store.updateScores({ roomId: room.id, ...value }) };
}
function projector(current) { return createDailyLiveDisplay({ liveStatistics: { readSnapshot: () => current } }); }

test("Daily live totals preserve signed roster prices, position bonuses, caps, winners and official data", t => {
  const fixture = setup(t), context = fixture.context(), before = structuredClone(context);
  const liveGame = game(0); liveGame.playerGames[1].positionGroup = "F";
  const projected = projector(snapshot([liveGame])).project(context);
  assert.equal(projected.members[0].hockeyPoints, 3.2, "the saved D position earns the defence hit/block bonus");
  assert.equal(projected.members[1].hockeyPoints, 2.55);
  assert.equal(projected.members[0].points, 3.91, "the team bonus is added after summing live hockey points");
  assert.equal(projected.members[1].points, 3.14);
  assert.deepEqual(projected.members[0].roster.map(player => player.price), [5, 6]);
  assert.equal(projected.members[0].remainingCap, before.room.members[0].remainingCap);
  assert.deepEqual(projected.winners, []);
  assert.equal(projected.phase, "locked");
  assert.equal(projected.live.provisionalGameCount, 1);
  assert.equal(projected.members[0].live.officialPoints, 0);
  assert.deepEqual(context, before);
  assert.deepEqual(fixture.context(), before, "provisional display cannot persist scores");
});

test("legacy live rooms retain raw hockey totals even while new-room bonuses are enabled", t => {
  const fixture = setup(t), context = fixture.context();
  context.room.scoringVersion = "classic-v1";
  context.room.capBonusRatePercent = 0;
  const before = structuredClone(context);
  const projected = projector(snapshot([game(0)])).project(context);
  assert.deepEqual(projected.members.map(member => [member.hockeyPoints, member.capBonusPoints, member.points]),
    [[3.2, 0, 3.2], [2.55, 0, 2.55]]);
  assert.deepEqual(context, before, "legacy live projection remains read-only");
});

test("only exact accepted game IDs remove overlays; a live-feed FINAL label alone never double-counts or settles", t => {
  const fixture = setup(t);
  fixture.update(report(first, [slate.games[0].id]));
  const cache = snapshot([game(0, first, "final"), game(1, second, "final")]);
  const display = projector(cache);
  const provisional = display.project(fixture.context());
  assert.equal(provisional.members[0].hockeyPoints, 3.5);
  assert.equal(provisional.members[0].points, 4.28);
  assert.deepEqual(provisional.live.gameIds, [slate.games[1].id]);
  assert.equal(provisional.phase, "locked");
  assert.deepEqual(provisional.winners, []);
  const total = Object.fromEntries(slate.players.map(player => {
    const combined = { ...first[player.id] }; addScoringStats(combined, second[player.id]); return [player.id, combined];
  }));
  fixture.update(report(total, slate.games.map(row => row.id)));
  const accepted = display.project(fixture.context());
  assert.equal(accepted.members[0].points, provisional.members[0].points);
  assert.equal(accepted.live.provisionalGameCount, 0);
  fixture.update(report(total, slate.games.map(row => row.id), true));
  const finished = fixture.view();
  assert.equal(finished.phase, "finished");
  assert.deepEqual(display.project(fixture.context()), finished);
});

test("every nonzero scoring category reaches player and team totals with saved Daily weights", t => {
  const fixture = setup(t);
  const every = Object.fromEntries(Object.keys(emptyScoringStats()).map(key => [key, 1]));
  const values = { "1": every, "2": every, "3": stats() };
  const result = projector(snapshot([game(0, values)])).project(fixture.context());
  assert.deepEqual(result.members[0].roster[0].scoringStats, every);
  assert.deepEqual(result.members[0].roster[1].scoringStats, every);
  assert.equal(result.members[0].roster[0].points, 14.7);
  assert.equal(result.members[0].roster[1].points, 15);
  assert.equal(result.members[0].hockeyPoints, 29.7);
  assert.equal(result.members[0].points, 36.31);
  assert.deepEqual(result.members[0].scoringStats, Object.fromEntries(Object.keys(every).map(key => [key, 2])));
});

test("official zero-game collection suppresses retained live snapshots after a move or cancellation", t => {
  const fixture = setup(t), completed = report({ "1": stats(), "2": stats(), "3": stats() });
  for (const entry of Object.values(completed.playerStatsById)) {
    entry.statsStatus = "collected";
    entry.gamesExpected = 0;
  }
  fixture.update(completed);
  const before = fixture.view();
  const result = projector(snapshot([game(0)])).project(fixture.context());
  assert.deepEqual(result.members, before.members);
  assert.equal(result.live.provisionalGameCount, 0);
  assert.equal(result.phase, "locked", "other NHL games may still prevent room settlement");
});

test("legacy partial totals await exact game evidence and malformed handoff evidence cannot change saved scores", t => {
  const fixture = setup(t), legacy = report(first, [slate.games[0].id]);
  for (const entry of Object.values(legacy.playerStatsById)) delete entry.collectedGameIds;
  fixture.update(legacy);
  const before = fixture.view();
  const result = projector(snapshot([game(1)])).project(fixture.context());
  assert.equal(result.members[0].points, before.members[0].points);
  assert.deepEqual(result.live.pendingReasons, ["official_game_coverage_pending"]);
  const invalid = report(first, [slate.games[0].id]); invalid.playerStatsById["1"].collectedGameIds = [slate.games[0].id, slate.games[0].id];
  assert.throws(() => fixture.update(invalid), /collected-game identities/);
  assert.deepEqual(fixture.view(), before);
});

test("wrong dates, starts, seasons, unlisted games, excluded games, teams and incomplete categories cannot score", t => {
  const fixture = setup(t);
  for (const alter of [row => { row.gameId = "2026020999"; }, row => { row.startsAtMs += 86400000; }, row => { row.nhlSeasonKey = "20252026"; }]) {
    const row = game(0); alter(row);
    const projected = projector(snapshot([row])).project(fixture.context());
    assert.equal(projected.members[0].points, 0);
  }
  const excluded = fixture.context(); excluded.slate.games[0].excluded = true;
  assert.equal(projector(snapshot([game(0)])).project(excluded).members[0].points, 0);
  for (const alter of [row => { row.playerGames[0].providerTeamId = "6"; }, row => { delete row.playerGames[1].scoringStats.hits; },
    row => { row.playerGames.push(structuredClone(row.playerGames[0])); }]) {
    const row = game(0); alter(row);
    const projected = projector(snapshot([row])).project(fixture.context());
    assert.equal(projected.members[0].points, 0);
    assert.equal(projected.live.status, "unavailable");
  }
});

test("practice retains whole-day scoring after its own lock and auctions do not show provisional totals", t => {
  const fixture = setup(t, "practice"), display = projector(snapshot([game(0)]));
  assert.equal(display.project(fixture.context()).members[0].hockeyPoints, 3.2, "practice includes the original slate even before the practice auction start");
  fixture.clock(puck + 80 * minute);
  const auction = fixture.context();
  assert.equal(auction.room.phase, "auction");
  assert.deepEqual(display.project(auction), auction.room);
});

test("stale replacement snapshots stay labelled and corrections can reduce provisional totals", t => {
  const fixture = setup(t);
  const firstView = projector(snapshot([game(0)], "stale")).project(fixture.context());
  assert.equal(firstView.live.status, "stale");
  assert.equal(firstView.members[0].hockeyPoints, 3.2);
  const corrected = projector(snapshot([game(0, first)])).project(fixture.context());
  assert.equal(corrected.members[0].hockeyPoints, 0.3);
  assert.equal(corrected.members[0].points, 0.37);
  const unavailable = projector(snapshot([], "unavailable")).project(fixture.context());
  assert.equal(unavailable.members[0].points, 0);
  assert.equal(unavailable.live.status, "unavailable");
});

test("live member and spectator reads do not fetch, write the Daily sidecar or bypass authentication", async t => {
  const directory = fs.mkdtempSync(path.join(__dirname, ".daily-live-"));
  const filename = path.join(directory, "daily.sqlite");
  let now = puck - 30 * minute, scoreCalls = 0, cacheReads = 0;
  const daily = createDailyService({ filename, clock: () => now,
    feed: { getSchedule: async () => slate, getSlate: async () => slate,
      getScores: async () => { scoreCalls++; return report(first, [slate.games[0].id]); } },
    liveStatistics: { readSnapshot() { cacheReads++; return snapshot([game(0)]); } } });
  let observer;
  t.after(() => { daily.close(); observer?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const { room } = await daily.create({ actor: host, input: { name: "Read only", capacity: 2, slateDate: slate.date } });
  await daily.bid({ actor: host, roomId: room.id, input: { playerId: "1", amount: 5 } });
  now = puck;
  observer = new DatabaseSync(filename);
  const before = observer.prepare("SELECT * FROM rooms").all();
  const version = observer.prepare("PRAGMA data_version").get().data_version;
  for (let i = 0; i < 25; i++) {
    const member = daily.room({ actor: host, roomId: room.id }).room.members[0];
    assert.equal(member.hockeyPoints, 2.15);
    assert.equal(member.points, 2.66);
  }
  assert.equal(cacheReads, 25);
  assert.equal(scoreCalls, 0);
  assert.deepEqual(observer.prepare("SELECT * FROM rooms").all(), before);
  assert.equal(observer.prepare("PRAGMA data_version").get().data_version, version);
  const spectator = daily.room({ actor: guest, roomId: room.id }).room;
  assert.equal(spectator.joined, false);
  assert.equal(spectator.members[0].points, 2.66);
  assert.equal(spectator.members[0].availableCap, null);
  assert.equal(spectator.members[0].reserved, null);
  assert.equal(cacheReads, 26);
  assert.deepEqual(observer.prepare("SELECT * FROM rooms").all(), before);
  assert.equal(observer.prepare("PRAGMA data_version").get().data_version, version);
  assert.throws(() => daily.room({ roomId: room.id }), { code: "DAILY_SIGN_IN_REQUIRED" });
  assert.equal(cacheReads, 26, "authentication occurs before reading the live cache");
});
