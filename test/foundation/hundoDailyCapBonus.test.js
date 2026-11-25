"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { dailyTeamScore, CAP_SAVINGS_VERSION } = require("../../src/daily/dailyTeamScore");
const { createDailyStore } = require("../../src/daily/createDailyStore");

const bonusRule = { scoringVersion: CAP_SAVINGS_VERSION };
const minute = 60_000, puck = Date.parse("2026-11-25T02:00:00Z");
const actors = ["A", "B", "C"].map(id => ({ id, name: `Manager ${id}` }));
const players = actors.flatMap((actor, index) => ["F", "F", "F", "D", "D", "F", "F"].map((position, slot) => ({
  id: `${index}-${slot}`, name: `Skater ${index}-${slot}`, position, team: "VAN", opponent: "SEA",
})));
const slate = { date: "2026-11-24", firstGameAt: puck, games: [{ id: "42" }], players };
const points = Object.fromEntries(players.map((player, index) => [player.id, index % 7 === 0 ? [4000, 3700, 3400][Math.floor(index / 7)] : 0]));

test("every saved dollar earns an exact quarter-percent bonus, rounded once at team level", () => {
  assert.deepEqual(dailyTeamScore(bonusRule, 3000, 63), { hockeyPoints: 30, capBonusPercent: 9.25, capBonusPoints: 2.78, points: 32.78 });
  assert.deepEqual(dailyTeamScore(bonusRule, 3000, 64), { hockeyPoints: 30, capBonusPercent: 9, capBonusPoints: 2.7, points: 32.7 });
  assert.deepEqual(dailyTeamScore(bonusRule, 3000, 100), { hockeyPoints: 30, capBonusPercent: 0, capBonusPoints: 0, points: 30 });
  assert.equal(dailyTeamScore(bonusRule, 200, 99).capBonusPoints, 0.01, "half a hundredth rounds up");
  assert.equal(dailyTeamScore(bonusRule, 199, 99).capBonusPoints, 0, "below half a hundredth rounds down");
  assert.equal(dailyTeamScore(bonusRule, 400, 99).capBonusPoints, 0.01, "aggregate calculation differs from separately rounding two 2-FP players");
});

test("legacy, zero and negative teams never receive invented points or an extra penalty", () => {
  assert.deepEqual(dailyTeamScore({}, 3000, 7), { hockeyPoints: 30, capBonusPercent: 0, capBonusPoints: 0, points: 30 });
  for (const raw of [0, -1, -300]) {
    const score = dailyTeamScore(bonusRule, raw, 0);
    assert.equal(score.capBonusPoints, 0);
    assert.equal(score.points, raw / 100);
  }
  for (const spent of [-1, 101, 1.5, NaN]) assert.throws(() => dailyTeamScore(bonusRule, 3000, spent));
});

function createDraft(store, mode, requestId = mode, capSavingsBonus) {
  const room = store.createRoom({ actor: actors[0], name: "Bonus room", capacity: 3, slate, mode, requestId, capSavingsBonus });
  for (const actor of actors.slice(1)) store.joinRoom({ actor, roomId: room.id });
  for (const [index, actor] of actors.entries()) {
    for (let slot = 0; slot < 7; slot++) store.bid({ roomId: room.id, actor, playerId: `${index}-${slot}`,
      amount: slot === 0 ? [94, 54, 24][index] : 1 });
  }
  return room;
}

test("new scheduled and practice rooms settle on adjusted totals and winner notifications use the same score", t => {
  for (const mode of ["scheduled", "practice"]) {
    let now = puck - 30 * minute;
    const store = createDailyStore({ filename: ":memory:", clock: () => now });
    t.after(() => store.close());
    const room = createDraft(store, mode);
    assert.equal(room.scoringVersion, CAP_SAVINGS_VERSION);
    assert.equal(room.capBonusRatePercent, 0.25);
    now += 2 * minute;
    store.updateScores({ roomId: room.id, pointsByPlayerId: points, final: false });
    const view = () => store.getRoom({ actor: actors[0], roomId: room.id });
    assert.equal(view().phase, "locked");
    assert.deepEqual(view().members.map(member => [member.spent, member.hockeyPoints, member.capBonusPoints, member.points]),
      [[100, 40, 0, 40], [60, 37, 3.7, 40.7], [30, 34, 5.95, 39.95]]);
    assert.equal(view().members[1].roster[0].points, 37, "player stats retain hockey points only");
    assert.deepEqual(view().winners, []);
    store.updateScores({ roomId: room.id, pointsByPlayerId: points, final: true });
    assert.deepEqual(view().winners, [{ id: "B", name: "Manager B", points: 40.7 }]);
    const win = store.listDueNotifications().find(notice => notice.type === "daily_room_won");
    assert.equal(win.userId, "B");
    assert.equal(win.messageData.points, 40.7);
  }
});

test("room rule survives restart and creation retries cannot upgrade old rooms or change new rules", t => {
  const directory = fs.mkdtempSync(path.join(__dirname, ".daily-cap-"));
  const filename = path.join(directory, "daily.sqlite");
  let now = puck - 30 * minute;
  let store = createDailyStore({ filename, clock: () => now });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const old = createDraft(store, "scheduled", "old");
  const newRoom = store.createRoom({ actor: actors[0], name: "New", capacity: 1, slate, requestId: "new" });
  const offRoom = store.createRoom({ actor: actors[0], name: "Off", capacity: 1, slate, requestId: "off", capSavingsBonus: false });
  store.close();
  const db = new DatabaseSync(filename);
  const oldInfo = JSON.parse(db.prepare("SELECT info FROM rooms WHERE id=?").get(old.id).info);
  delete oldInfo.scoringVersion; // A fixture made to match a room persisted before this release.
  db.prepare("UPDATE rooms SET info=? WHERE id=?").run(JSON.stringify(oldInfo), old.id);
  const legacyBefore = db.prepare("SELECT * FROM rooms WHERE id=?").get(old.id);
  db.close();
  now += 2 * minute;
  store = createDailyStore({ filename, clock: () => now, existingOnly: true });
  assert.equal(store.getRoom({actor:actors[0],roomId:offRoom.id}).capBonusRatePercent,0);
  assert.equal(store.createRoom({ actor:actors[0], name:"Off", capacity:1, slate, requestId:"off", capSavingsBonus:false }).id,offRoom.id);
  assert.throws(() => store.createRoom({ actor:actors[0], name:"Off", capacity:1, slate, requestId:"off", capSavingsBonus:true }), {code:"DAILY_CREATE_CONFLICT"});
  for (let i = 0; i < 3; i++) {
    assert.equal(store.getRoom({ actor: actors[0], roomId: old.id }).capBonusRatePercent, 0);
    assert.equal(store.getRoom({ actor: actors[0], roomId: newRoom.id }).capBonusRatePercent, 0.25);
    const replay = store.createRoom({ actor: actors[0], name: "Bonus room", capacity: 3, slate, mode: "scheduled", requestId: "old" });
    assert.equal(replay.capBonusRatePercent, 0);
    assert.equal(store.createRoom({ actor: actors[0], name: "New", capacity: 1, slate, requestId: "new" }).capBonusRatePercent, 0.25);
  }
  const inspect = new DatabaseSync(filename, { readOnly: true });
  assert.deepEqual(inspect.prepare("SELECT * FROM rooms WHERE id=?").get(old.id), legacyBefore, "reads and replay perform no legacy rewrite");
  store.updateScores({ roomId: old.id, pointsByPlayerId: points, final: true });
  const legacy = store.getRoom({ actor: actors[0], roomId: old.id });
  assert.deepEqual(legacy.members.map(member => member.points), [40, 37, 34]);
  assert.deepEqual(legacy.winners, [{ id: "A", name: "Manager A", points: 40 }]);
  const finalized = inspect.prepare("SELECT * FROM rooms WHERE id=?").get(old.id);
  assert.equal(JSON.parse(finalized.info).scoringVersion, undefined);
  store.updateScores({ roomId: old.id, pointsByPlayerId: { ...points, "1-0": 9000 }, final: true });
  assert.deepEqual(inspect.prepare("SELECT * FROM rooms WHERE id=?").get(old.id), finalized, "already finalized results cannot be retroactively scored");
  inspect.close();
});

test("commissioner can disable the bonus for scheduled and practice rooms including final winners", t => {
  for(const mode of ['scheduled','practice']) {
    let now=puck-30*minute;
    const store=createDailyStore({filename:':memory:',clock:()=>now}); t.after(()=>store.close());
    const room=createDraft(store,mode,mode,false);
    assert.equal(room.capBonusRatePercent,0);
    assert.equal(store.listRooms({actor:actors[0]}).find(r=>r.id===room.id).capBonusRatePercent,0);
    assert.throws(()=>store.createRoom({actor:actors[0],name:'Bonus room',capacity:3,slate,mode,requestId:mode,capSavingsBonus:true}),{code:'DAILY_CREATE_CONFLICT'});
    now+=2*minute;
    store.updateScores({roomId:room.id,pointsByPlayerId:points,final:true});
    const view=store.getRoom({actor:actors[0],roomId:room.id});
    assert.deepEqual(view.members.map(m=>m.points),[40,37,34]);
    assert.deepEqual(view.winners,[{id:'A',name:'Manager A',points:40}]);
  }
});
test("invalid cap bonus choices fail before feed reads or storage initialization", async()=>{
  const {createDailyService}=require('../../src/daily/createDailyService');
  let reads=0,opens=0;
  const service=createDailyService({filename:':memory:',feed:{getSchedule(){reads++;},getSlate(){reads++;}},openStore(){opens++;throw Error('must not open');}});
  for(const capSavingsBonus of [null,'false',0,1,{}]) await assert.rejects(service.create({actor:actors[0],input:{name:'Invalid',capacity:2,capSavingsBonus}}),{code:'DAILY_CAP_BONUS_INVALID'});
  assert.equal(reads,0);assert.equal(opens,0);service.close();
});
