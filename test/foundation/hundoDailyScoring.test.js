"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createDailyStore } = require("../../src/daily/createDailyStore");
const { createDailyService } = require("../../src/daily/createDailyService");
const { playerScoringDetails, teamScoringDetails } = require("../../src/daily/dailyScoring");
const { CATEGORY_KEYS, emptyScoringStats, calculateExpandedScore } = require("../../src/domain/statistics/expandedScoringPolicy");

const minute = 60_000;
const puck = Date.parse("2026-11-17T03:00:00Z");
const host = { id: "host", name: "Host" };
const guest = { id: "guest", name: "Guest" };
const slate = { date: "2026-11-16", firstGameAt: puck, games: [{ id: "42" }],
  players: ["F", "D", "F"].map((position, i) => ({ id: String(i + 1), name: "Skater " + i,
    position, team: "VAN", opponent: "SEA" })) };
const stats = changes => ({ ...emptyScoringStats(), ...changes });
const detail = (scoringStats, gamesCollected = 1, gamesExpected = 1) => ({ scoringStats,
  statsStatus: gamesCollected === gamesExpected ? "collected" : gamesCollected ? "partial" : "pending",
  gamesCollected, gamesExpected });
const complete = () => ({ "1": detail(stats({ primaryAssists: 1, giveaways: 1 })),
  "2": detail(stats({ hits: 2, blockedShots: 1 })), "3": detail(stats()) });
function report(playerStatsById = complete(), final = true) {
  return { playerStatsById, final, pointsByPlayerId: Object.fromEntries(slate.players.map(player => [player.id,
    playerStatsById[player.id].scoringStats ? calculateExpandedScore(playerStatsById[player.id].scoringStats,
      player.position).fantasyPointsHundredths : 0])) };
}
function fileFixture(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, ".hundo-daily-scoring-test-"));
  const resources = [];
  t.after(() => {
    for (const resource of resources.reverse()) resource.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { filename: path.join(dir, "daily.sqlite"), keep: resource => { resources.push(resource); return resource; } };
}
function setup(t, filename = ":memory:") {
  let now = puck - 30 * minute;
  const clock = () => now;
  const store = createDailyStore({ filename, clock });
  t.after(() => store.close());
  const { id: roomId } = store.createRoom({ actor: host, name: "Stats", capacity: 4, slate });
  store.joinRoom({ roomId, actor: guest });
  for (const player of slate.players) store.bid({ roomId, actor: player.id === "3" ? guest : host,
    playerId: player.id, amount: Number(player.id) + 4 });
  now = puck;
  return { store, roomId, clock, advance: () => { now += minute; },
    view: () => store.getRoom({ roomId, actor: host }),
    update: value => store.updateScores({ roomId, ...value }) };
}

test("verified player categories and team subtotals distinguish pending, partial and collected zero stats", t => {
  const { view, update } = setup(t);
  const initial = view();
  assert.deepEqual(initial.scoringCategories.map(row => row.key), CATEGORY_KEYS);
  assert.ok(initial.members.flatMap(member => member.roster).every(player =>
    player.scoringStats === null && player.statsStatus === "pending"));
  const evidence = complete();
  evidence["1"] = detail(evidence["1"].scoringStats, 1, 2);
  evidence["2"] = detail(null, 0, 1);
  update(report(evidence, false));
  const partial = view();
  assert.equal(partial.phase, "locked");
  assert.deepEqual(partial.winners, []);
  assert.equal(partial.members[0].statsStatus, "partial");
  assert.deepEqual(partial.members[0].scoringStats, evidence["1"].scoringStats);
  assert.deepEqual(partial.members[0].statsCollection, { collected: 0, partial: 1, pending: 1, unavailable: 0, total: 2 });
  assert.equal(partial.members[1].statsStatus, "collected");
  assert.deepEqual(partial.members[1].scoringStats, emptyScoringStats());
  update(report());
  const final = view();
  assert.equal(final.phase, "finished");
  assert.equal(final.members[0].hockeyPoints, 3.2, "F and D category weights preserve authoritative hockey FP");
  assert.equal(final.members[0].points, 3.91);
  assert.deepEqual(final.members[0].scoringStats, stats({ primaryAssists: 1, giveaways: 1, hits: 2, blockedShots: 1 }));
  assert.equal(final.members[0].statsStatus, "collected");
  assert.deepEqual(final.members[0].roster.map(player => player.price), [5, 6]);
  assert.deepEqual(final.winners, [{ ...host, points: 3.91 }]);
});

test("legacy zero and nonzero score entries are unavailable; verified mixed-team subtotals remain visible", () => {
  const room = { scores: { zero: 0, nonzero: 50 } };
  const pending = playerScoringDetails(room, "not-yet-scored");
  assert.equal(pending.statsStatus, "pending");
  for (const id of ["zero", "nonzero"]) {
    assert.deepEqual(playerScoringDetails(room, id), { scoringStats: null, statsStatus: "unavailable",
      gamesCollected: null, gamesExpected: null });
  }
  const team = teamScoringDetails([detail(stats({ shotsOnGoal: 2 })), playerScoringDetails(room, "zero"), pending]);
  assert.equal(team.statsStatus, "partial");
  assert.deepEqual(team.scoringStats, stats({ shotsOnGoal: 2 }));
  assert.deepEqual(team.statsCollection, { collected: 1, partial: 0, pending: 1, unavailable: 1, total: 3 });
});

test("invalid category evidence cannot partially update authoritative points or finish a room", t => {
  const { view, update } = setup(t);
  update(report(complete(), false));
  const before = view();
  const badReports = [];
  const missing = report(); delete missing.playerStatsById["2"].scoringStats.hits; badReports.push(missing);
  const mismatch = report(); mismatch.playerStatsById["2"].scoringStats.hits++; badReports.push(mismatch);
  const incomplete = report(); incomplete.playerStatsById["2"].statsStatus = "partial";
  incomplete.playerStatsById["2"].gamesExpected = 2; badReports.push(incomplete);
  const unknown = report(); delete unknown.playerStatsById["3"]; badReports.push(unknown);
  const unverified = report(); unverified.playerStatsById["3"] = detail(null, 0, 1); badReports.push(unverified);
  for (const value of badReports) {
    assert.throws(() => update(value), TypeError);
    assert.deepEqual(view(), before);
  }
});

test("scoring metadata survives restart and room reads never write or change schema", t => {
  const file = fileFixture(t), { filename } = file;
  const { update, store, roomId, view } = setup(t, filename);
  file.keep(store);
  update(report());
  const expected = view();
  store.close();
  const observer = file.keep(new DatabaseSync(filename));
  const before = observer.prepare("SELECT * FROM rooms").all();
  const version = observer.prepare("PRAGMA data_version").get().data_version;
  const reopened = file.keep(createDailyStore({ filename, clock: () => puck, existingOnly: true }));
  assert.deepEqual(reopened.getRoom({ roomId, actor: host }), expected);
  reopened.listRooms({ actor: host });
  assert.deepEqual(reopened.listStatsHydrationRooms(), []);
  assert.deepEqual(observer.prepare("SELECT * FROM rooms").all(), before);
  assert.equal(observer.prepare("PRAGMA data_version").get().data_version, version);
  assert.equal(observer.prepare("PRAGMA user_version").get().user_version, 1);
});

test("finished legacy hydration validates every signed total atomically and preserves scores, winners and room metadata", t => {
  const file = fileFixture(t), { filename } = file;
  const { update, view, store, roomId } = setup(t, filename);
  file.keep(store);
  const { pointsByPlayerId } = report();
  update({ pointsByPlayerId, final: true });
  const observer = file.keep(new DatabaseSync(filename));
  const row = () => observer.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
  const before = row();
  const resultBefore = view();
  assert.equal(resultBefore.members[0].statsStatus, "unavailable");
  assert.deepEqual(store.listStatsHydrationRooms().map(room => room.id), [roomId]);
  const revised = complete(); revised["2"].scoringStats.hits++;
  assert.throws(() => update({ ...report(revised), hydrateStatsOnly: true }), /authoritative/);
  assert.deepEqual(row(), before, "No partial metadata survives a single player mismatch");
  update({ ...report(), hydrateStatsOnly: true });
  const after = row();
  assert.equal(after.info, before.info);
  const { scoringDetails, ...playAfter } = JSON.parse(after.play);
  assert.deepEqual(playAfter, JSON.parse(before.play));
  assert.deepEqual(Object.keys(scoringDetails), ["1", "2", "3"]);
  assert.deepEqual(scoringDetails["3"].scoringStats, emptyScoringStats());
  assert.deepEqual(view().winners, resultBefore.winners);
  assert.deepEqual(store.listStatsHydrationRooms(), []);
  update({ ...report(revised), hydrateStatsOnly: true });
  assert.deepEqual(row(), after, "Existing finished metadata and results are immutable");
});

test("void and closed rooms cannot be hydrated or have results changed", t => {
  const a = setup(t), b = setup(t);
  a.update({ final: true, voided: true });
  const voidBefore = a.view();
  a.update({ ...report(), hydrateStatsOnly: true });
  assert.deepEqual(a.view(), voidBefore);
  assert.deepEqual(a.store.listStatsHydrationRooms(), []);
  b.update({ final: true, pointsByPlayerId: report().pointsByPlayerId });
  b.store.closeRoom({ roomId: b.roomId, actor: host });
  assert.deepEqual(b.store.listStatsHydrationRooms(), []);
  assert.doesNotThrow(() => b.update({ playerStatsById: "invalid", hydrateStatsOnly: true, final: true }));
});

test("background scoring retains verified details through a feed failure and finalizes with the same FP", async t => {
  const file = fileFixture(t), { filename } = file;
  const { store, roomId, clock, advance, view } = setup(t, filename);
  file.keep(store);
  let calls = 0;
  const errors = [];
  const daily = createDailyService({ filename, clock, logger: { error: (...args) => errors.push(args) }, feed: {
    async getScores() { if (++calls === 2) throw Error("incomplete NHL report"); return report(complete(), calls === 3); },
  } });
  file.keep(daily);
  await daily.runMaintenance();
  const before = view();
  assert.equal(before.members[0].statsStatus, "collected");
  assert.equal(before.phase, "locked");
  advance();
  await daily.runMaintenance();
  assert.deepEqual(view(), before);
  assert.equal(errors.length, 1);
  advance();
  await daily.runMaintenance();
  assert.equal(view().phase, "finished");
  assert.equal(view().members[0].points, before.members[0].points);
  advance();
  await daily.runMaintenance();
  assert.equal(calls, 3);
  assert.deepEqual(store.listStatsHydrationRooms(), []);
  assert.equal(daily.room({ roomId, actor: host }).room.members[0].statsStatus, "collected");
});

test("background hydration retries legacy metadata without changing the existing winner", async t => {
  const file = fileFixture(t), { filename } = file;
  const { store, update, view, clock, advance } = setup(t, filename);
  file.keep(store);
  update({ final: true, pointsByPlayerId: report().pointsByPlayerId });
  const winners = view().winners;
  let calls = 0;
  const daily = createDailyService({ filename, clock, feed: { async getScores() {
    if (++calls === 1) throw Error("temporarily unavailable");
    return report();
  } } });
  file.keep(daily);
  await daily.runMaintenance();
  assert.equal(view().members[0].statsStatus, "unavailable");
  advance();
  await daily.runMaintenance();
  assert.deepEqual(view().winners, winners);
  assert.equal(view().members[0].statsStatus, "collected");
  advance();
  await daily.runMaintenance();
  assert.equal(calls, 2);
});
