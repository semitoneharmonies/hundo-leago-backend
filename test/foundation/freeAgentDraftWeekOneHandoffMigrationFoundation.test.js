'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {before,after,test}=require('node:test');
const Database=require('better-sqlite3');
const {applyMigrations,discoverMigrations}=require('../../src/infrastructure/database/migrate');
let schema,definitions,view;
before(()=>{
 schema=new Database(':memory:');applyMigrations({database:schema,migrations:discoverMigrations({migrationsDirectory:path.resolve(__dirname,'../../database/migrations')}).filter(migration=>migration.id<=63),applicationBuildId:'handoff-regression',now:()=>1});
 definitions=schema.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name})=>`CREATE TABLE "${name}" (${schema.pragma(`table_info("${name}")`).map(c=>`"${c.name}" ${c.type}`).join(',')});`).join('\n');
 view=schema.prepare("SELECT sql FROM sqlite_schema WHERE name='free_agent_draft_approved_week_one_handoffs'").get().sql;
});
after(()=>schema?.close());
function fixture(t){
 const db=new Database(':memory:');db.exec(definitions+'\n'+view+';');t.after(()=>db.close());
 const put=(table,row)=>db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(k=>'@'+k).join(',')})`).run(row);
 const scoped={league_id:'league',season_id:'season'};
 put('free_agent_drafts',{...scoped,id:'draft',status:'rapid',first_matchup_week_id:'week',current_competition_first_matchup_week_id:'week',first_matchup_starts_at_ms:10000,schedule_recovery_id:null});
 put('matchup_weeks',{...scoped,id:'week',sequence:1,status:'scheduled',starts_at_ms:10000,baseline_at_ms:3610000,locks_at_ms:57610000});
 put('season_matchup_schedule_generations',{...scoped,week_one_matchup_week_id:'week',week_one_starts_at_ms:10000,schedule_version:1,status:'current',superseded_at_ms:null});
 put('free_agent_draft_rollovers',{...scoped,id:'last-round',fad_id:'draft',window_kind:'initial',rolls_over_at_ms:10000});
 put('operational_events',{...scoped,id:'removal',event_type:'league.two_team_removal.v1',outcome:'succeeded',actor_user_id:'commissioner',occurred_at_ms:5000});
 const details={format:'fad-week-one-handoff-v1',fadId:'draft',matchupWeekId:'week',scheduleVersion:1,startsAtMs:10000,baselineAtMs:3610000,activeTeamCount:12,removalOperationId:'removal'};
 put('operational_events',{...scoped,id:'approval',event_type:'free_agent_draft.week_one_handoff_approved.v1',feature:'free_agent_draft',outcome:'succeeded',reason_code:'preserve_september_29_week_one',actor_user_id:'commissioner',occurred_at_ms:5000,details_json:JSON.stringify(details)});
 for(let i=0;i<12;i++)put('teams',{id:'team'+i,league_id:'league',status:'active'});
 for(let i=0;i<6;i++)put('matchups',{...scoped,id:'game'+i,matchup_week_id:'week',home_team_id:'team'+(2*i),away_team_id:'team'+(2*i+1),status:'scheduled'});
 put('job_runs',{...scoped,id:'baseline',job_type:'matchup:baseline',status:'pending',attempt_count:0});
 return {db,put,details,count:()=>db.prepare('SELECT count(*) n FROM free_agent_draft_approved_week_one_handoffs').get().n};
}
test('Schema 63 creates no approval or business record',()=>{
 assert.equal(schema.prepare('SELECT count(*) n FROM operational_events').get().n,0);
 assert.equal(schema.prepare('SELECT count(*) n FROM free_agent_draft_approved_week_one_handoffs').get().n,0);
 assert.equal(schema.prepare("SELECT metadata_value FROM application_metadata WHERE metadata_key='data_model_version'").get().metadata_value,'63');
});
test('Only an exact scoped receipt and unstarted week permit the original baseline cutoff',t=>{
 const {db,count}=fixture(t);assert.equal(count(),1);
 assert.deepEqual(db.prepare('SELECT starts_at_ms,baseline_at_ms FROM free_agent_draft_approved_week_one_handoffs').get(),{starts_at_ms:10000,baseline_at_ms:3610000});
 assert.equal(db.prepare("SELECT count(*) n FROM free_agent_draft_approved_week_one_handoffs WHERE league_id='unrelated'").get().n,0);
});
for(const [name,sql]of [
 ['missing approval',"DELETE FROM operational_events WHERE id='approval'"],
 ['wrong league',"UPDATE operational_events SET league_id='other' WHERE id='approval'"],
 ['wrong season',"UPDATE operational_events SET season_id='other' WHERE id='approval'"],
 ['wrong actor',"UPDATE operational_events SET actor_user_id='other' WHERE id='approval'"],
 ['wrong scope payload',"UPDATE operational_events SET details_json=json_set(details_json,'$.fadId','other') WHERE id='approval'"],
 ['extra payload fields',"UPDATE operational_events SET details_json=json_set(details_json,'$.unexpected',1) WHERE id='approval'"],
 ['changed schedule version',"UPDATE season_matchup_schedule_generations SET schedule_version=2"],
 ['changed baseline',"UPDATE matchup_weeks SET baseline_at_ms=baseline_at_ms+1"],
 ['late authorization',"UPDATE operational_events SET occurred_at_ms=10000"],
 ['missing removal receipt',"DELETE FROM operational_events WHERE id='removal'"],
 ['failed removal',"UPDATE operational_events SET outcome='failed' WHERE id='removal'"],
 ['mismatched operation time',"UPDATE operational_events SET occurred_at_ms=4999 WHERE id='removal'"],
 ['thirteen active teams',"INSERT INTO teams(id,league_id,status) VALUES('extra','league','active')"],
 ['erased participant',"UPDATE teams SET status='erased' WHERE id='team0'"],
 ['missing matchup',"DELETE FROM matchups WHERE id='game0'"],
 ['live matchup',"UPDATE matchups SET status='live' WHERE id='game0'"],
 ['started week',"UPDATE matchup_weeks SET status='live'"],
 ['later final auction round',"UPDATE free_agent_draft_rollovers SET rolls_over_at_ms=10001"],
 ['prior recovery',"UPDATE free_agent_drafts SET schedule_recovery_id='recovery'"],
 ['changed draft phase',"UPDATE free_agent_drafts SET status='completed'"],
 ['started matchup job',"UPDATE job_runs SET status='running',attempt_count=1"],
 ['previous matchup job attempt',"UPDATE job_runs SET attempt_count=1"],
 ['existing roster lock',"INSERT INTO matchup_roster_locks(league_id,season_id) VALUES('league','season')"],
 ['existing result',"INSERT INTO matchup_results(league_id,season_id) VALUES('league','season')"],
 ['revoked approval',"INSERT INTO operational_events(league_id,season_id,event_type,details_json) VALUES('league','season','free_agent_draft.week_one_handoff_revoked.v1','{\"approvalId\":\"approval\"}')"],
 ['compensated removal',"INSERT INTO operational_events(league_id,season_id,event_type,details_json) VALUES('league','season','league.two_team_removal.v1.rolled_back','{\"originalOperationId\":\"removal\"}')"],
])test('Handoff rejects '+name,t=>{const {db,count}=fixture(t);db.exec(sql);assert.equal(count(),0);});
test('An unrelated league job, lock or result cannot invalidate this league',t=>{
 const {put,count}=fixture(t);put('job_runs',{league_id:'other',season_id:'other',job_type:'matchup:baseline',status:'running',attempt_count:1});put('matchup_roster_locks',{league_id:'other',season_id:'other'});put('matchup_results',{league_id:'other',season_id:'other'});assert.equal(count(),1);
});
