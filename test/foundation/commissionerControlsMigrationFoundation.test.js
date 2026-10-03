const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const Database=require('better-sqlite3');
const {applyMigrations,discoverMigrations}=require('../../src/infrastructure/database/migrate');
const {createVerifiedBackup,restoreBackupToCleanPath}=require('../../src/infrastructure/database/sqliteBackup');
const {compressAndEncryptBackup,decryptAndDecompressBackup}=require('../../src/infrastructure/backups/backupArtifactCrypto');
const {seedFixture}=require('../../src/operations/release/createReleaseQaFixture');
const {createScryptPasswordHasher}=require('../../src/infrastructure/security/createScryptPasswordHasher');
const ROOT=path.resolve(__dirname,'../..'),MIGRATIONS=path.join(ROOT,'database/migrations');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('commissioner schema 66 to 85 preserves populated leagues and rehearses encrypted rollback without replacing the source',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hundo-controls-migration-'));
 assert.ok(path.relative(os.tmpdir(),root).startsWith('hundo-controls-migration-'));
 const databasePath=path.join(root,'source.sqlite3'),database=new Database(databasePath);
 database.pragma('foreign_keys=ON');database.pragma('journal_mode=WAL');
 t.after(()=>{if(database.open)database.close();});
 const migrations=discoverMigrations({migrationsDirectory:MIGRATIONS});
 const migrate=list=>applyMigrations({database,migrations:list,applicationBuildId:'commissioner-migration-rehearsal',now:()=>1785009600000});
 migrate(migrations.filter(m=>m.id<=66));
 const passwordHash=await createScryptPasswordHasher({secureRandom:{bytes:crypto.randomBytes}}).hash('synthetic migration fixture password');
 const fixture=database.transaction(()=>seedFixture(database,passwordHash)).immediate();
 await Promise.all(fixture.acceptancePromises);fixture.assertLateLockCoverage();
 const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','application_metadata') ORDER BY name").all().map(r=>r.name);
 const snapshot=db=>Object.fromEntries(tables.map(name=>[name,hash(JSON.stringify(db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()))]));
 const original=snapshot(database),metadata=database.prepare("SELECT * FROM application_metadata WHERE metadata_key<>'data_model_version' ORDER BY metadata_key").all();
 for(const table of ['leagues','users','team_manager_assignments','contracts','player_ownerships','auctions','auction_bids','trades','matchup_results'])
  assert.ok(database.prepare('SELECT COUNT(*) n FROM '+table).get().n>0,table+' must be populated');
 assert.ok(database.prepare('SELECT COUNT(*) n FROM leagues').get().n>=2);
 const backupDirectory=path.join(root,'backup');
 const backup=await createVerifiedBackup({databasePath,outputDirectory:backupDirectory,environment:'test',reason:'pre-migration',capturedAtMs:1785009600001});
 const plaintext=fs.readFileSync(path.join(backupDirectory,'database.sqlite3')),key=crypto.randomBytes(32),aad=Buffer.from('commissioner-controls-schema66-rehearsal');
 const encrypted=await compressAndEncryptBackup({plaintext,key,aad});
 assert.notEqual(hash(encrypted.ciphertext),hash(plaintext));
 const restoredPlaintext=await decryptAndDecompressBackup({...encrypted,key,aad});
 assert.equal(hash(restoredPlaintext),backup.plaintextSha256);
 await assert.rejects(decryptAndDecompressBackup({...encrypted,key:crypto.randomBytes(32),aad}));
 migrate(migrations);assert.equal(database.pragma('user_version',{simple:true}),85);
 assert.deepEqual(snapshot(database),original);
 assert.deepEqual(database.prepare("SELECT * FROM application_metadata WHERE metadata_key<>'data_model_version' ORDER BY metadata_key").all(),metadata);
 assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
 const migrated=database.serialize();migrate(migrations);assert.deepEqual(database.serialize(),migrated);
 const targetDatabasePath=path.join(root,'rollback-verification.sqlite3');
 restoreBackupToCleanPath({backupDirectory,targetDatabasePath,environment:'test'});
 const restored=new Database(targetDatabasePath,{readonly:true});
 try{assert.equal(restored.pragma('user_version',{simple:true}),66);assert.deepEqual(snapshot(restored),original);
  assert.deepEqual(restored.pragma('foreign_key_check'),[]);assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');}
 finally{restored.close();}
 assert.deepEqual(database.serialize(),migrated);
 fs.writeFileSync(path.join(root,'preservation-evidence.json'),JSON.stringify({fromSchema:66,toSchema:85,tableCount:tables.length,
  sourcePreserved:true,encryptedRoundTrip:true,isolatedRollback:true,tableHashes:original},null,2));
});
