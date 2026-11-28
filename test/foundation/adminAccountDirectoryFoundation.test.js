"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const express = require("express");
const { createSqliteAdminAccountDirectoryReader } = require("../../src/infrastructure/persistence/sqlite/SqliteAdminAccountDirectoryReader");
const { createAdminAccountDirectoryRouter, ACCOUNT_DIRECTORY_PATH } = require("../../src/transport/http/createAdminAccountDirectoryRouter");
const { createTargetRequestSecurity } = require("../../src/transport/http/createTargetRequestSecurity");
const { createPlatformAuthorizationService } = require("../../src/application/services/authorization/requirePlatformAdministrator");
const ORIGIN = "https://hundoleago.com";
const id = value => "00000000-0000-4000-8000-" + String(value).padStart(12, "0");

function fixture(t) {
  const database = new Database(":memory:");
  t.after(() => database.close());
  database.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,display_name_normalized TEXT,email_display TEXT,email_normalized TEXT,status TEXT,created_at_ms INTEGER,private_value TEXT);" +
    "CREATE TABLE leagues(id TEXT PRIMARY KEY,name TEXT,name_normalized TEXT,status TEXT);" +
    "CREATE TABLE league_memberships(user_id TEXT,league_id TEXT,status TEXT,ended_at_ms INTEGER);" +
    "CREATE UNIQUE INDEX current_membership ON league_memberships(user_id,league_id) WHERE status='active';"
  );
  const user = (number, name, status = "active", createdAtMs = 1_700_000_000_000 + number) => database.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)")
    .run(id(number), name, name.toLowerCase(), name.toLowerCase().replaceAll(" ", "") + "@example.test", name.toLowerCase().replaceAll(" ", "") + "@example.test", status, createdAtMs, "PRIVATE_CREDENTIAL");
  const league = (number, name, status = "active") => database.prepare("INSERT INTO leagues VALUES(?,?,?,?)")
    .run(id(number), name, name.toLowerCase(), status);
  const membership = (userNumber, leagueNumber, status = "active", endedAt = null) => database.prepare("INSERT INTO league_memberships VALUES(?,?,?,?)")
    .run(id(userNumber), id(leagueNumber), status, endedAt);
  return { database, user, league, membership, reader: createSqliteAdminAccountDirectoryReader({ database }) };
}

test("directory includes every account status and only current nondeleted league memberships", t => {
  const f = fixture(t);
  f.user(1, "Zulu", "disabled");
  f.user(2, "alpha", "active");
  f.user(3, "Beta", "pending_verification");
  f.user(4, "Delta", "pending_credential_setup");
  f.user(5, "Echo", "deactivated");
  for (const [number, name, status] of [[10,"Active","active"],[11,"Completed","completed"],[12,"Frozen","frozen"],
    [13,"Setup","setup"],[14,"Deleted","deleted"],[15,"Invited","active"],[16,"Suspended","active"],[17,"Ended","active"],[18,"Stale active","active"]]) f.league(number,name,status);
  for (const number of [10,11,12,13,14]) f.membership(2,number);
  f.membership(2,15,"invited");f.membership(2,16,"suspended");f.membership(2,17,"ended",100);f.membership(2,18,"active",100);
  f.membership(5,10);
  const before = f.database.serialize();
  const changes = f.database.prepare("SELECT total_changes() n").get().n;
  f.database.pragma("query_only=ON");
  const data = f.reader.read();
  assert.deepEqual(data.accounts.map(account => account.username), ["alpha","Beta","Delta","Echo","Zulu"]);
  assert.deepEqual(data.accounts.map(account => account.status), ["active","pending_verification","pending_credential_setup","deactivated","disabled"]);
  assert.deepEqual(data.accounts[0].leagues, [10,11,12,13].map((number,index)=>({id:id(number),name:["Active","Completed","Frozen","Setup"][index]})));
  assert.deepEqual(data.accounts[1].leagues, []);
  assert.deepEqual(data.accounts[3].leagues, [{id:id(10),name:"Active"}], "inactive account still retains its current membership relationship");
  assert.deepEqual(data.pagination, {limit:50,offset:0,sort:"username",direction:"asc",total:5,hasMore:false});
  assert.equal(data.code,"ADMIN_ACCOUNT_DIRECTORY_FOUND");
  assert.equal(data.accounts[0].createdAtMs,1_700_000_000_002);
  for (const account of data.accounts) assert.deepEqual(Object.keys(account).sort(),["createdAtMs","email","id","leagues","status","username"]);
  assert.equal(JSON.stringify(data).includes("PRIVATE_CREDENTIAL"),false);
  assert.equal(f.database.prepare("SELECT total_changes() n").get().n,changes);
  assert.deepEqual(f.database.serialize(),before);
});

test("directory pagination counts accounts before the membership join and sorts deterministically", t => {
  const f = fixture(t);
  for (let index=104;index>=0;index--) f.user(index+1,"User "+String(index).padStart(3,"0"));
  f.league(1001,"Zebra");f.league(1002,"Apple");f.membership(51,1001);f.membership(51,1002);
  const first=f.reader.read();const second=f.reader.read({limit:50,offset:50});const last=f.reader.read({limit:50,offset:100});
  assert.equal(first.accounts.length,50);assert.equal(first.pagination.hasMore,true);
  assert.equal(second.accounts[0].username,"User 050");assert.deepEqual(second.accounts[0].leagues,[{id:id(1002),name:"Apple"},{id:id(1001),name:"Zebra"}]);
  assert.deepEqual(last.pagination,{limit:50,offset:100,sort:"username",direction:"asc",total:105,hasMore:false});assert.equal(last.accounts.length,5);
  assert.equal(new Set([...first.accounts,...second.accounts,...last.accounts].map(account=>account.id)).size,105);
  assert.deepEqual(f.reader.read({limit:100,offset:105}),{code:"ADMIN_ACCOUNT_DIRECTORY_FOUND",accounts:[],pagination:{limit:100,offset:105,sort:"username",direction:"asc",total:105,hasMore:false}});
});

test("directory rejects invalid numeric bounds and handles an empty source without writes", t => {
  const f=fixture(t);const before=f.database.serialize();
  for (const input of [{limit:0},{limit:101},{limit:1.5},{limit:"50"},{offset:-1},{offset:0.5},{offset:Number.MAX_SAFE_INTEGER+1},{sort:"created_at_ms"},{sort:"username DESC; DROP TABLE users;"},{direction:"DESC"},{direction:"sideways"},{sort:["username"]}]) {
    assert.throws(()=>f.reader.read(input),{code:"ACCOUNT_DIRECTORY_INPUT_INVALID"});
  }
  assert.deepEqual(f.reader.read(),{code:"ADMIN_ACCOUNT_DIRECTORY_FOUND",accounts:[],pagination:{limit:50,offset:0,sort:"username",direction:"asc",total:0,hasMore:false}});
  assert.deepEqual(f.database.serialize(),before);
});

async function httpFixture(t,{failRead=false}={}) {
  const reads=[];let administrator=true;const user={id:id(1),status:"active"};
  const requestSecurity=createTargetRequestSecurity({isAllowedOrigin:origin=>origin===ORIGIN,
    sessionCookie:{read:cookie=>cookie==="session=valid"?"valid":null},
    sessionService:{resolveWithCsrf(){assert.fail("Directory must not use unsafe authentication");},bootstrap:token=>token==="valid"?{valid:true,user:{id:user.id},session:{userId:user.id}}:{valid:false}},
  });
  const platformAuthorization=createPlatformAuthorizationService({userRepository:{findById:()=>user},platformRoleRepository:{findActiveByUserId:()=>administrator?{id:id(2),user_id:user.id,role:"platform_administrator",status:"active",ended_at_ms:null,version:1}:null}});
  const reader={read(pagination){reads.push(pagination);if(failRead)throw new Error("PRIVATE_EMAIL@example.test");return{code:"ADMIN_ACCOUNT_DIRECTORY_FOUND",accounts:[],pagination:{...pagination,total:0,hasMore:false}};}};
  const app=express();app.use(createAdminAccountDirectoryRouter({reader,requestSecurity,platformAuthorization}));
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  t.after(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const url="http://127.0.0.1:"+server.address().port+ACCOUNT_DIRECTORY_PATH;
  const headers={Origin:ORIGIN,Cookie:"session=valid"};
  return{url,headers,reads,user,revoke(){administrator=false;}};
}

test("directory denies missing, non-admin and revoked authority before querying or exposing accounts",async t=>{
  const f=await httpFixture(t);
  assert.equal((await fetch(f.url,{headers:{Origin:ORIGIN}})).status,401);assert.equal(f.reads.length,0);
  const response=await fetch(f.url,{headers:f.headers});assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(response.headers.get("set-cookie"),null);
  const data=await response.json();assert.match(data.meta.requestId,/^[0-9a-f-]+$/);assert.equal(f.reads.length,1);
  f.revoke();const revoked=await fetch(f.url+"?unknown=private",{headers:f.headers});assert.equal(revoked.status,403);assert.equal(f.reads.length,1);
  const denied=await revoked.json();assert.equal(denied.error.code,"PLATFORM_ADMINISTRATOR_REQUIRED");assert.match(denied.error.requestId,/^[0-9a-f-]+$/);
  assert.equal(revoked.headers.get("cache-control"),"no-store");
  assert.equal((await fetch(f.url,{headers:{...f.headers,Origin:"https://other.example"}})).status,403);assert.equal(f.reads.length,1);
});

test("directory validates strict pagination and preserves the standard success and error envelopes",async t=>{
  const f=await httpFixture(t);
  for (const [query,expected] of [["",{limit:50,offset:0}],["?limit=1&offset=0",{limit:1,offset:0}],["?limit=100&offset=100",{limit:100,offset:100}]]) {
    const response=await fetch(f.url+query,{headers:f.headers});assert.equal(response.status,200);assert.deepEqual(f.reads.at(-1),{sort:"username",direction:"asc",...expected});
  }
  for (const query of ["limit=0","limit=101","limit=1.5","limit=-1","offset=-1","offset=1.5","limit=050","offset=","offset=9007199254740992","limit=10&limit=20","offset[x]=1","email=private@example.test","sort=created_at_ms","sort=username%20DESC%3BDROP%20TABLE%20users","sort=__proto__","sort=username&sort=email","direction=ASC","direction=desc&direction=asc","direction[x]=desc","sort="]) {
    const response=await fetch(f.url+"?"+query,{headers:f.headers});assert.equal(response.status,400,query);const data=await response.json();assert.equal(data.error.code,"ACCOUNT_DIRECTORY_INPUT_INVALID");assert.match(data.error.requestId,/^[0-9a-f-]+$/);
  }
  assert.equal(f.reads.length,3);
  for(const sort of ["username","email","createdAt","league","status"]) for(const direction of ["asc","desc"]) {
    const response=await fetch(f.url+"?sort="+sort+"&direction="+direction+"&limit=2&offset=2",{headers:f.headers});
    assert.equal(response.status,200);assert.deepEqual(f.reads.at(-1),{limit:2,offset:2,sort,direction});
  }
});

test("directory read failures return a contained no-store response without private error details",async t=>{
  const f=await httpFixture(t,{failRead:true});const response=await fetch(f.url,{headers:f.headers});
  assert.equal(response.status,503);assert.equal(response.headers.get("cache-control"),"no-store");const data=await response.json();
  assert.equal(data.error.code,"ACCOUNT_DIRECTORY_UNAVAILABLE");assert.match(data.error.requestId,/^[0-9a-f-]+$/);assert.equal(JSON.stringify(data).includes("PRIVATE_EMAIL"),false);
});

test("directory sorts creation time across all pages before limiting results", t => {
  const f=fixture(t);
  for (let index=0;index<105;index++) f.user(index+1,"User "+String(index).padStart(3,"0"),"active",1000+index);
  const first=f.reader.read({sort:"createdAt",direction:"desc"});
  const second=f.reader.read({sort:"createdAt",direction:"desc",offset:50});
  const last=f.reader.read({sort:"createdAt",direction:"desc",offset:100});
  assert.equal(first.accounts[0].username,"User 104");
  assert.equal(first.accounts[0].createdAtMs,1104);
  assert.equal(second.accounts[0].username,"User 054");
  assert.equal(last.accounts.at(-1).username,"User 000");
  assert.equal(new Set([...first.accounts,...second.accounts,...last.accounts].map(account=>account.id)).size,105);
  assert.deepEqual(last.pagination,{limit:50,offset:100,sort:"createdAt",direction:"desc",total:105,hasMore:false});
});

test("directory supports every sort direction and stable username/id tie breaks", t => {
  const f=fixture(t);
  f.user(1,"Zulu","active",100);
  f.user(2,"Beta","pending_verification",200);
  f.user(3,"alpha","pending_credential_setup",200);
  f.user(4,"Delta","disabled",300);
  f.user(5,"Echo","deactivated",400);
  f.database.prepare("UPDATE users SET email_display=?,email_normalized=? WHERE id=?").run("AAA@example.test","aaa@example.test",id(1));
  const names=input=>f.reader.read(input).accounts.map(account=>account.username);
  assert.deepEqual(names({sort:"username",direction:"desc"}),["Zulu","Echo","Delta","Beta","alpha"]);
  assert.equal(names({sort:"email",direction:"asc"})[0],"Zulu");
  assert.equal(names({sort:"email",direction:"desc"}).at(-1),"Zulu");
  assert.deepEqual(names({sort:"createdAt",direction:"asc"}),["Zulu","alpha","Beta","Delta","Echo"]);
  assert.deepEqual(names({sort:"status",direction:"asc"}),["Zulu","alpha","Beta","Echo","Delta"]);
  assert.deepEqual(names({sort:"status",direction:"desc"}),["Delta","Echo","Beta","alpha","Zulu"]);
  // The final ID tie-break remains deterministic even for legacy equal normalized names.
  f.user(6,"same","active",500);f.user(7,"same","active",500);
  const tied=f.reader.read({sort:"createdAt",direction:"desc"}).accounts.slice(0,2);
  assert.deepEqual(tied.map(account=>account.id),[id(6),id(7)]);
});

test("league ordering uses first current nondeleted league and keeps no-league accounts last", t => {
  const f=fixture(t);
  for (const [number,name] of [[1,"Zulu"],[2,"Beta"],[3,"alpha"],[4,"Delta"]]) f.user(number,name);
  f.league(10,"Zebra");f.league(11,"Apple");f.league(12,"Aardvark","deleted");f.league(13,"Birch");
  f.membership(1,10);f.membership(1,11);f.membership(2,13);f.membership(3,12);f.membership(4,11,"ended",100);
  const before=f.database.serialize();f.database.pragma("query_only=ON");
  assert.deepEqual(f.reader.read({sort:"league",direction:"asc"}).accounts.map(account=>account.username),["Zulu","Beta","alpha","Delta"]);
  assert.deepEqual(f.reader.read({sort:"league",direction:"desc"}).accounts.map(account=>account.username),["Beta","Zulu","alpha","Delta"]);
  const limited=f.reader.read({sort:"league",direction:"desc",limit:1,offset:1});
  assert.equal(limited.accounts[0].username,"Zulu");
  assert.deepEqual(limited.accounts[0].leagues,[{id:id(11),name:"Apple"},{id:id(10),name:"Zebra"}]);
  assert.deepEqual(f.database.serialize(),before);
});
