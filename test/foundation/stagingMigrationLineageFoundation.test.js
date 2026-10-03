const assert=require('node:assert/strict');
const path=require('node:path');
const {test}=require('node:test');
const Database=require('better-sqlite3');
const {discoverMigrations,applyMigrations,assertMigrationCompatibility}=require('../../src/infrastructure/database/migrate');
const ROOT=path.resolve(__dirname,'../..');
const canonical=discoverMigrations({migrationsDirectory:path.join(ROOT,'database/migrations')});
const staging=discoverMigrations({migrationsDirectory:path.join(ROOT,'database/staging-migrations')});
const migrate=(database,migrations)=>applyMigrations({database,migrations,applicationBuildId:'staging-lineage-test',now:()=>1785009600000});
test('staging upgrade preserves its applied ledger and converges on the canonical schema without weakening checksum validation',()=>{
 const db=new Database(':memory:'),comparison=new Database(':memory:');
 try{
  db.pragma('foreign_keys=ON');comparison.pragma('foreign_keys=ON');
  migrate(db,staging.filter(m=>m.id<=63));
  const ledger=db.prepare('SELECT * FROM schema_migrations ORDER BY migration_id').all();
  assert.equal(ledger[61].file_name,'0062_add_three_team_trade_participants.sql');
  assert.equal(ledger[62].file_name,'0063_add_global_player_injuries.sql');
  assert.throws(()=>assertMigrationCompatibility(db,canonical),{code:'MIGRATION_FILE_NAME_MISMATCH'});
  migrate(db,staging);migrate(comparison,canonical);
  assert.equal(db.pragma('user_version',{simple:true}),85);
  assert.equal(db.prepare("SELECT metadata_value FROM application_metadata WHERE metadata_key='data_model_version'").get().metadata_value,'85');
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE migration_id<=63 ORDER BY migration_id').all(),ledger);
  const schema=d=>d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.deepEqual(schema(db),schema(comparison));
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const bytes=db.serialize();migrate(db,staging);assert.deepEqual(db.serialize(),bytes);
  assert.throws(()=>assertMigrationCompatibility(db,staging.map(m=>m.id===62?{...m,checksum:'0'.repeat(64)}:m)),{code:'MIGRATION_CHECKSUM_MISMATCH'});
  for(const m of staging.filter(m=>m.id<62||m.id>65))assert.equal(m.checksum,canonical.find(c=>c.id===m.id).checksum);
 }finally{db.close();comparison.close();}
});
