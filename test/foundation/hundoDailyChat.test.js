const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createDailyStore } = require('../../src/daily/createDailyStore');
const { createDailyChatPublisher } = require('../../src/daily/dailyChat');

const host = { id:'host', name:'Host' }, guest = { id:'guest', name:'Guest' }, other = { id:'other', name:'Other', isAdmin:true };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-chat-'));
  const filename = path.join(dir,'daily.sqlite3');
  let now = Date.parse('2026-11-23T18:00:00Z');
  const slate = { date:'2026-11-23',firstGameAt:now+3600000,players:[{id:'1',name:'Skater',team:'VAN',position:'F',opponent:'SEA'}] };
  let store = createDailyStore({filename,clock:()=>now});
  const a=store.createRoom({actor:host,name:'A',capacity:3,slate}).id;
  const b=store.createRoom({actor:other,name:'B',capacity:3,slate}).id;
  store.joinRoom({roomId:a,actor:guest});
  t.after(()=>{store.close(); fs.rmSync(dir,{recursive:true,force:true});});
  return { a,b, filename, get store(){return store;}, advance(ms=1001){now+=ms;},
    reopen(){store.close();store=createDailyStore({filename,clock:()=>now,existingOnly:true});},
    post(actor,text,requestId='message-1',roomId=a){return store.postChat({roomId,actor,input:{text,username:'Impostor'},requestId});} };
}

test('chat enforces membership, text, idempotency and authenticated names without exposing history in room views', t=>{
  const f=fixture(t);
  for(const actor of [other,{id:'missing',name:'Missing'}]) {
    assert.throws(()=>f.store.getChat({roomId:f.a,actor}),{code:'DAILY_MEMBERSHIP_REQUIRED'});
    assert.throws(()=>f.post(actor,'blocked'),{code:'DAILY_MEMBERSHIP_REQUIRED'});
    assert.throws(()=>f.store.canReadChat(f.a,actor.id),{code:'DAILY_MEMBERSHIP_REQUIRED'});
  }
  for(const text of ['', ' \n\t ', 'x'.repeat(281), null, '<ok>\u0000']) assert.throws(()=>f.post(host,text),{code:'DAILY_CHAT_TEXT'});
  const text='<script>alert(1)</script> plain text';
  const first=f.post({...host,name:'Current display name'},text);
  assert.equal(first.messages[0].username,'Current display name');
  assert.equal(first.messages[0].text,text);
  assert.equal(first.messages[0].requestId,undefined);
  assert.deepEqual(f.post(host,text),first);
  assert.throws(()=>f.post(host,'different'),{code:'DAILY_CHAT_CONFLICT'});
  assert.throws(()=>f.post(host,'too fast','message-2'),{code:'DAILY_CHAT_RATE_LIMIT'});
  assert.equal(f.store.getChat({roomId:f.b,actor:other}).messages.length,0);
  assert.equal(f.store.getRoom({roomId:f.a,actor:host}).chat,undefined);
  f.advance(); f.post(guest,'x'.repeat(280));
  assert.equal(f.store.getChat({roomId:f.a,actor:host}).messages.length,2);
});

test('full history survives reopen, GET is read-only, scoring stays open and finalization atomically closes posting',t=>{
  const f=fixture(t); f.post(host,'Before auction');
  f.advance(3600001);
  assert.equal(f.store.getRoom({roomId:f.a,actor:host}).phase,'locked');
  f.post(guest,'While stats arrive');
  f.store.updateScores({roomId:f.a,pointsByPlayerId:{},final:false});
  f.advance(); f.post(host,'Still open','message-2');
  f.reopen();
  const read = new DatabaseSync(f.filename,{readOnly:true});
  const rows=()=>JSON.stringify(read.prepare('SELECT * FROM rooms ORDER BY id').all());
  const before=rows();
  assert.equal(f.store.getChat({roomId:f.a,actor:guest}).messages.length,3);
  assert.equal(rows(),before); read.close();
  f.store.updateScores({roomId:f.a,pointsByPlayerId:{},final:true});
  assert.equal(f.store.getChat({roomId:f.a,actor:guest}).readOnly,true);
  assert.throws(()=>f.post(host,'after final','message-3'),{code:'DAILY_CHAT_READ_ONLY'});
  f.store.closeRoom({roomId:f.a,actor:host}); f.reopen();
  assert.equal(f.store.getChat({roomId:f.a,actor:guest}).messages.length,3);
});

test('authorized realtime signals reach only current room members and recheck expired sessions',t=>{
  const f=fixture(t), events=[];
  const sockets=new Map([host,guest,other].map(actor=>[actor.id,{handshake:actor,emit:(name,payload)=>events.push([actor.id,name,payload])}]));
  let revoked=false;
  const publish=createDailyChatPublisher({getIo:()=>({sockets:{sockets}}),authorizeHandshake:actor=>{
    if(revoked&&actor.id===guest.id)throw Error('revoked'); return {userId:actor.id};
  },canRead:(roomId,userId)=>f.store.canReadChat(roomId,userId)});
  publish(f.a); assert.deepEqual(events.map(e=>e[0]),['host','guest']);
  assert.deepEqual(events[0].slice(1),['daily.chat.changed',{roomId:f.a}]);
  events.length=0; revoked=true; publish(f.a); assert.deepEqual(events.map(e=>e[0]),['host']);
  events.length=0; publish(f.b); assert.deepEqual(events.map(e=>e[0]),['other']);
});
