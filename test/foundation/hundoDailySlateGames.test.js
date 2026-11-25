"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { roomView } = require("../../src/daily/dailyRoom");
test("room matchups come from its full saved slate in every phase, without changing input", () => {
  const room = { id:"r", name:"Room", date:"2026-11-25", firstGameAt:2000000, members:[], lots:[], scores:{} };
  const slate = { players:[], games:[{id:"1",awayTeam:"TBL",homeTeam:"NYI",season:"private-extra"},{id:"2",awayTeam:"VAN",homeTeam:"EDM"}] };
  const before = JSON.stringify({room,slate});
  const expected = [{id:"1",awayTeam:"TBL",homeTeam:"NYI"},{id:"2",awayTeam:"VAN",homeTeam:"EDM"}];
  for (const now of [0, 500000, 3000000]) assert.deepEqual(roomView(room,slate,{id:"watcher"},now).games,expected);
  assert.deepEqual(roomView({...room,finished:true},slate,{id:"watcher"},3000000).games,expected);
  assert.equal(JSON.stringify({room,slate}),before);
  assert.deepEqual(roomView(room,{players:[]},{id:"watcher"},0).games,[]);
});
