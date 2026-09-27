const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('node:path');
const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
const { createSqliteRepositoryContext } = require('../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext');
const { createSqlitePlayerInjuryRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerInjuryRepository');
const { normalizeInjurySnapshot } = require('../../src/infrastructure/espn/EspnInjuryAdapter');
const NOW = Date.parse('2026-09-27T08:00:00Z');
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
function setup(t) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  migrateDatabase({ database: db, migrationsDirectory: path.resolve(__dirname,'../../database/migrations'), applicationBuildId:'injury-test', now:()=>NOW });
  createSqliteRepositoryContext({ database: db });
  db.prepare('INSERT INTO players(id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?)').run(id(1),'Test','Player','Test Player','2000-01-01','active',NOW,NOW);
  let at = NOW;
  t.after(()=>db.close());
  return {db, repo:createSqlitePlayerInjuryRepository({database:db,nowMs:()=>at}), advance:()=>{at+=3600000;return at;} };
}
function snapshot(at=NOW, rows) {return {observedAtMs:at,rows:rows||[{id:'123',name:'Test Player',birthDate:'2000-01-01',team:'Test Team',designation:'Out',injuryType:'Lower Body',eligible:true,reportedAtMs:NOW-60000,observedAtMs:at}]};}
function apply(repo,s){return repo.apply(s,repo.claim(true));}
test('schema is additive, registered, and injury reads perform no writes',t=>{
 const {db,repo}=setup(t);const before=db.prepare('SELECT total_changes() AS n').get().n;
 repo.list();repo.read(id(1));assert.equal(db.prepare('SELECT total_changes() AS n').get().n,before);
 assert.equal(db.pragma('user_version',{simple:true}),65);
});
test('injury import matches unique name and birthdate without editing players',t=>{
 const {db,repo}=setup(t);const before=db.prepare('SELECT * FROM players').all();
 apply(repo,snapshot());assert.equal(repo.read(id(1)).status,'injured');
 assert.deepEqual(db.prepare('SELECT * FROM players').all(),before);
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
test('missing or non-injury report queues a possible return without declaring healthy',t=>{
 const {repo,advance}=setup(t);apply(repo,snapshot());const at=advance();
 apply(repo,snapshot(at,[{...snapshot().rows[0],id:'456',name:'Other Person',birthDate:null,observedAtMs:at}]));
 assert.equal(repo.read(id(1)).status,'injured');assert.equal(repo.read(id(1)).review_reason,'possible_return');
});
test('ambiguous identity never applies an injury to a guessed player',t=>{
 const {repo,db}=setup(t);
 db.prepare('INSERT INTO players SELECT ?,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms,version FROM players WHERE id=?').run(id(2),id(1));
 assert.equal(apply(repo,snapshot()).unresolved,1);assert.equal(repo.read(id(1)),null);
});
test('failed refresh retains the last accepted injury state',t=>{
 const {repo}=setup(t);apply(repo,snapshot());const before=repo.read(id(1));
 const lease=repo.claim(true);repo.fail(lease,'INJURY_FEED_UNAVAILABLE');
 assert.deepEqual(repo.read(id(1)),before);assert.equal(repo.syncState().error_code,'INJURY_FEED_UNAVAILABLE');
});
test('overlapping refresh cannot obtain a second lease or write using a stale lease',t=>{
 const {repo}=setup(t);const token=repo.claim(true);assert.ok(token);assert.equal(repo.claim(true),null);
 assert.throws(()=>repo.apply(snapshot(),'wrong'),{code:'INJURY_REFRESH_CONFLICT'});
});
test('feed timestamps, identities and empty snapshots must be verified',()=>{
 const entry={date:new Date(NOW).toISOString(),status:'Out',details:{type:'Illness'},athlete:{displayName:'Test Player',links:[{href:'https://www.espn.com/nhl/player/_/id/123/test-player'}]}};
 const valid={timestamp:new Date(NOW).toISOString(),injuries:[{id:'1',displayName:'Team',injuries:[entry]}]};
 assert.equal(normalizeInjurySnapshot(valid,NOW).rows[0].eligible,true);
 assert.throws(()=>normalizeInjurySnapshot({...valid,injuries:[]},NOW));
 assert.throws(()=>normalizeInjurySnapshot(valid,NOW+86400000));
 assert.throws(()=>normalizeInjurySnapshot({...valid,injuries:[{...valid.injuries[0],injuries:[entry,entry]}]},NOW));
 assert.equal(normalizeInjurySnapshot({...valid,injuries:[{...valid.injuries[0],injuries:[{...entry,status:'Suspension'}]}]},NOW).rows[0].eligible,false);
});
