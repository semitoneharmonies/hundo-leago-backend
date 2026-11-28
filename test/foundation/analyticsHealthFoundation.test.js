"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs"), path = require("node:path");
const Database = require("better-sqlite3"), express = require("express");
const { createAnalyticsHealthReader, HEALTH_GROUPS } = require("../../src/analytics/readAnalyticsHealth");
const { createAnalyticsHealthRouter, ANALYTICS_HEALTH_PATH } = require("../../src/transport/http/createAnalyticsHealthRouter");
const { createTargetRequestSecurity } = require("../../src/transport/http/createTargetRequestSecurity");
const { createPlatformAuthorizationService } = require("../../src/application/services/authorization/requirePlatformAdministrator");
const NOW = Date.parse("2026-11-27T20:00:00Z"), ORIGIN = "https://hundoleago.com";
function fixture(t) {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE job_runs(id TEXT,job_type TEXT,status TEXT,attempt_count INTEGER,scheduled_for_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,updated_at_ms INTEGER,lease_expires_at_ms INTEGER,last_error_code TEXT,private_payload TEXT);
    CREATE TABLE stat_refreshes(id TEXT,status TEXT,started_at_ms INTEGER,completed_at_ms INTEGER,error_code TEXT);
    CREATE TABLE player_injury_realtime_runs(id TEXT,status TEXT,scheduled_at_ms INTEGER,attempted_at_ms INTEGER,completed_at_ms INTEGER,error_code TEXT);
    CREATE TABLE matchup_weeks(id TEXT,status TEXT,locks_at_ms INTEGER,updated_at_ms INTEGER);`);
  const reader = createAnalyticsHealthReader({ database: db, dailyFilename: path.join(__dirname,"never-initialize-health.sqlite3"), clock: () => NOW });
  const job = (id, status = "failed", type = "statistics:completed_games", code = "STATISTICS_PROVIDER_FAILED", scheduled = NOW-10000, lease = null) => db.prepare("INSERT INTO job_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(String(id),type,status,2,scheduled,NOW-2000,status==="failed"?NOW-1000:null,NOW-1000,lease,code,"PRIVATE_EMAIL@example.test https://private.example/?token=SECRET");
  return { db, reader, job };
}
test("health groups expose bounded safe facts and exact known reason classifications without writes", t => {
  const f=fixture(t);f.job(1);f.job(2,"failed","PRIVATE_TYPE_secret","https://secret.example/?token=TOKEN");
  f.job(3,"pending","matchup:finalize",null,NOW+10000);f.job(4,"pending");f.job(5,"running","encrypted_database_backup",null,NOW-10000,NOW-1);f.job(6,"leased","auction.resolve.target",null,NOW-10000,NOW+10000);
  f.db.prepare("INSERT INTO stat_refreshes VALUES(?,?,?,?,?)").run("s1","rejected",NOW-10000,NOW-1000,"STATISTICS_RESPONSE_INCOMPLETE");
  f.db.prepare("INSERT INTO player_injury_realtime_runs VALUES(?,?,?,?,?,?)").run("i1","abandoned",NOW-10000,NOW-9000,NOW-1000,"INJURY_LEASE_EXPIRED");
  f.db.prepare("INSERT INTO matchup_weeks VALUES(?,?,?,?)").run("PRIVATE_MATCHUP","awaiting_data",NOW-10000,NOW-1000);
  const before=f.db.serialize(), changes=f.db.prepare("SELECT total_changes() n").get().n;f.db.pragma("query_only=ON");
  const failed=f.reader.read({group:"failed_jobs"});assert.equal(failed.total,2);assert.deepEqual(failed.items.map(row=>row.reasonCode),["provider_unavailable","unknown"]);assert.equal(failed.items[1].kind,"other_job");
  const pending=f.reader.read({group:"pending_jobs"});assert.deepEqual(pending.items.map(row=>row.reasonCode),["scheduled","queued"]);
  assert.deepEqual(f.reader.read({group:"running_jobs"}).items.map(row=>row.reasonCode),["lease_expired","in_progress"]);
  assert.equal(f.reader.read({group:"failed_statistics"}).items[0].reasonCode,"incomplete_data");
  assert.equal(f.reader.read({group:"failed_injuries"}).items[0].reasonCode,"lease_expired");
  assert.equal(f.reader.read({group:"matchups_awaiting_data"}).items[0].reasonCode,"awaiting_matchup_data");
  for(const group of HEALTH_GROUPS) {
    const result=f.reader.read({group});const text=JSON.stringify(result);
    for(const forbidden of ["PRIVATE","TOKEN","https://","example.test","last_error_code","private_payload"])assert.equal(text.includes(forbidden),false);
    for(const row of result.items)assert.deepEqual(Object.keys(row).sort(),["attempts","completedAtMs","kind","reasonCode","scheduledAtMs","startedAtMs","status","updatedAtMs"]);
  }
  assert.equal(f.db.prepare("SELECT total_changes() n").get().n,changes);assert.deepEqual(f.db.serialize(),before);
});
test("health rows use a single bounded snapshot count and fail closed for incompatible sources",t=>{
  const f=fixture(t);for(let n=0;n<71;n++)f.job(n,"failed","encrypted_database_backup","BACKUP_DISK_SPACE_INSUFFICIENT");
  const data=f.reader.read({group:"failed_jobs"});assert.equal(data.total,71);assert.equal(data.items.length,50);assert.equal(data.truncated,true);assert.equal(data.items[0].reasonCode,"disk_space");
  f.db.exec("DROP TABLE job_runs");const missing=f.reader.read({group:"failed_jobs"});assert.equal(missing.status,"unavailable");assert.equal(missing.total,null);assert.deepEqual(missing.items,[]);
  assert.throws(()=>f.reader.read({group:"unknown"}));assert.throws(()=>f.reader.read({group:"failed_jobs",selection:{month:"2026-13"}}));
});
test("historical failure filtering uses UTC-8 completed times while backlogs remain current",t=>{
  const f=fixture(t), start=Date.parse("2026-10-01T08:00:00Z"),end=Date.parse("2026-11-01T08:00:00Z");
  for(const[code,time]of [["before",start-1],["start",start],["end-1",end-1],["end",end]]) {
    f.db.prepare("INSERT INTO stat_refreshes VALUES(?,?,?,?,?)").run(code,"failed",time-1,time,"UNKNOWN");
    f.db.prepare("INSERT INTO player_injury_realtime_runs VALUES(?,?,?,?,?,?)").run(code,"failed",time-2,time-1,time,"UNKNOWN");
  }
  f.job(1);for(const group of["failed_statistics","failed_injuries"]){const data=f.reader.read({group,selection:{month:"2026-10"}});assert.equal(data.total,2);assert.equal(data.scope,"period");assert.deepEqual(data.period,{startDate:"2026-10-01",endDate:"2026-10-31"});}
  const backlog=f.reader.read({group:"failed_jobs",selection:{month:"2026-10"}});assert.equal(backlog.total,1);assert.equal(backlog.scope,"current");
  assert.deepEqual(f.reader.read({group:"failed_statistics",selection:{week:"2026-11-23"}}).period,{startDate:"2026-11-23",endDate:"2026-11-27"});
});
function dailyFixture(t) {
  const root=fs.mkdtempSync(path.resolve(__dirname,"../../../health-test-"));
  t.after(()=>{for(const name of fs.readdirSync(root))fs.unlinkSync(path.join(root,name));fs.rmdirSync(root);});
  const main=new Database(":memory:");t.after(()=>main.close());
  const filename=path.join(root,"daily.sqlite3"),reader=createAnalyticsHealthReader({database:main,dailyFilename:filename,clock:()=>NOW});
  return {root,filename,reader};
}
test("Daily health never initializes a missing database or closed WAL support files",t=>{
  const f=dailyFixture(t);const names=fs.readdirSync(f.root);assert.equal(f.reader.read({group:"daily_scoring_pending"}).status,"not_measured");assert.deepEqual(fs.readdirSync(f.root),names);
  const writer=new Database(f.filename);writer.pragma("journal_mode=WAL");writer.exec("CREATE TABLE placeholder(value TEXT)");writer.close();
  const before=fs.readFileSync(f.filename),files=fs.readdirSync(f.root);assert.equal(f.reader.read({group:"daily_scoring_pending"}).status,"unavailable");assert.deepEqual(fs.readFileSync(f.filename),before);assert.deepEqual(fs.readdirSync(f.root),files);
});
test("Daily health uses the same pending predicate without selecting room identities or JSON payloads",t=>{
  const f=dailyFixture(t),writer=new Database(f.filename);writer.pragma("application_id=1212433457");writer.pragma("user_version=1");writer.exec("CREATE TABLE rooms(id TEXT,first_game_at INTEGER,closed INTEGER,info TEXT,play TEXT)");
  const insert=(id,first,info={},lots=[])=>writer.prepare("INSERT INTO rooms VALUES(?,?,?,?,?)").run(id,first,0,JSON.stringify({name:"PRIVATE_ROOM",members:[{id:"PRIVATE_USER",email:"secret@example.test"}],...info}),JSON.stringify({lots,private:"SECRET"}));
  insert("1",NOW-1);insert("2",NOW+1000,{mode:"practice"},Array.from({length:7},()=>({endsAt:NOW-1})));insert("3",NOW+1000);insert("4",NOW-1,{finished:true});insert("5",NOW-1,{void:true});writer.close();
  const before=fs.readFileSync(f.filename),files=fs.readdirSync(f.root),data=f.reader.read({group:"daily_scoring_pending"});assert.equal(data.total,2);assert.deepEqual(data.items.map(row=>row.kind),["daily_scheduled","daily_practice"]);assert.equal(JSON.stringify(data).includes("PRIVATE"),false);assert.deepEqual(fs.readFileSync(f.filename),before);assert.deepEqual(fs.readdirSync(f.root),files);
});
async function httpFixture(t,{fail=false}={}) {
  let admin=true;const calls=[],user={id:"00000000-0000-4000-8000-000000000001",status:"active"};
  const requestSecurity=createTargetRequestSecurity({isAllowedOrigin:o=>o===ORIGIN,sessionCookie:{read:c=>c==="session=valid"?"valid":null},sessionService:{resolveWithCsrf(){assert.fail("Health GET must not use write authentication");},bootstrap:token=>token==="valid"?{valid:true,user:{id:user.id},session:{userId:user.id}}:{valid:false}}});
  const platformAuthorization=createPlatformAuthorizationService({userRepository:{findById:()=>user},platformRoleRepository:{findActiveByUserId:()=>admin?{id:user.id,user_id:user.id,role:"platform_administrator",status:"active",ended_at_ms:null,version:1}:null}});
  const app=express();app.use(createAnalyticsHealthRouter({reader:{read:input=>{calls.push(input);if(fail)throw Error("SECRET@private.test");return{ok:true};}},requestSecurity,platformAuthorization,clock:()=>NOW}));
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  return{url:"http://127.0.0.1:"+server.address().port+ANALYTICS_HEALTH_PATH,headers:{Origin:ORIGIN,Cookie:"session=valid"},calls,revoke:()=>{admin=false;}};
}
test("health HTTP enforces current admin authority, origin, exact selection and no-store",async t=>{
  const f=await httpFixture(t);
  assert.equal((await fetch(f.url+"?group=failed_jobs",{headers:{Origin:ORIGIN}})).status,401);
  assert.equal((await fetch(f.url+"?group=failed_jobs",{headers:{...f.headers,Origin:"https://evil.test"}})).status,403);
  for(const query of["", "group=unknown", "group=failed_jobs&days=8", "group=failed_jobs&days=7&month=2026-10", "group=failed_jobs&week=2026-11-24", "group=failed_jobs&limit=100", "group=failed_jobs&group=pending_jobs"]){assert.equal((await fetch(f.url+"?"+query,{headers:f.headers})).status,400,query);}
  for(const query of["group=failed_jobs", "group=failed_jobs&days=7", "group=failed_injuries&month=2026-10", "group=failed_statistics&week=2026-11-23"]){const response=await fetch(f.url+"?"+query,{headers:f.headers});assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(response.headers.get("set-cookie"),null);assert.ok((await response.json()).meta.requestId);}
  assert.equal(f.calls.length,4);f.revoke();assert.equal((await fetch(f.url+"?group=bad",{headers:f.headers})).status,403);assert.equal(f.calls.length,4);
});
test("health HTTP failures redact reader errors",async t=>{const f=await httpFixture(t,{fail:true});const response=await fetch(f.url+"?group=failed_jobs",{headers:f.headers});assert.equal(response.status,503);assert.equal((await response.text()).includes("SECRET"),false);});
