const assert=require('node:assert/strict');
const {test}=require('node:test');
const crypto=require('node:crypto');
const path=require('node:path');
const Database=require('better-sqlite3');
const {applyMigrations,discoverMigrations}=require('../../src/infrastructure/database/migrate');
const {seedFixture}=require('../../src/operations/release/createReleaseQaFixture');
const {createScryptPasswordHasher}=require('../../src/infrastructure/security/createScryptPasswordHasher');
const {createSqliteLeagueManagementRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteLeagueManagementRepository');
const {createSqliteTradeDeadlineChangeRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteTradeDeadlineChangeRepository');
const deadlinePolicy=require('../../src/domain/leagues/tradeDeadlineChangePolicy');
const {createSqliteLeagueScoringRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteLeagueScoringRepository');
const {defaultScoringWeights}=require('../../src/domain/statistics/expandedScoringPolicy');
const {createSqliteLeagueCommunicationRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteLeagueCommunicationRepository');

test('card progress includes teams without a saved card and deduplicates unfinished-card managers without exposing offers',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE users(id,display_name,status);CREATE TABLE leagues(id,current_season_id);
 CREATE TABLE teams(id,league_id,name,status);CREATE TABLE league_memberships(id,league_id,user_id,status);
 CREATE TABLE team_manager_assignments(team_id,league_id,user_id,membership_id,status,ended_at_ms);
 CREATE TABLE league_invitations(league_id,invited_user_id,status,expires_at_ms);
 CREATE TABLE free_agent_drafts(id,league_id,season_id,status,deadline_locked_at_ms);
 CREATE TABLE candidate_cards(fad_id,league_id,team_id,status,filled_mandatory_count,filled_bench_count,completeness_code,allocation_eligibility,secret_offer);
 CREATE TABLE league_communications(id,league_id,created_by_user_id,kind,title,body,audience,pinned,expires_at_ms,notify,recipient_count,client_key,request_hash,created_at_ms,archived_at_ms,archived_by_user_id,version);
 INSERT INTO users VALUES('manager','Morgan','active');INSERT INTO leagues VALUES('league','season');
 INSERT INTO teams VALUES('empty','league','No saved card','active'),('partial','league','Partial card','active'),('complete','league','Complete card','active'),('old','league','Former team','erased');
 INSERT INTO league_memberships VALUES('membership','league','manager','active');
 INSERT INTO team_manager_assignments VALUES('empty','league','manager','membership','accepted',NULL),('partial','league','manager','membership','accepted',NULL);
 INSERT INTO free_agent_drafts VALUES('draft','league','season','cards_open',NULL);
 INSERT INTO candidate_cards VALUES('draft','league','partial','open',1,0,'incomplete','ineligible','PRIVATE OFFER'),('draft','league','complete','open',18,2,'complete','eligible','OTHER PRIVATE OFFER');`);
 const repo=createSqliteLeagueCommunicationRepository({database:db,notificationWriter:{insert(){throw Error('No writes during read');}}});
 const before=db.prepare('SELECT total_changes() n').get().n,progress=repo.cardProgress('league');
 assert.deepEqual(progress.map(p=>[p.teamId,p.status]),[['complete','complete'],['empty','empty'],['partial','incomplete']]);
 assert(progress.every(p=>Object.keys(p).sort().join()==='displayName,status,teamId,teamName,userId'));
 assert.deepEqual(repo.recipients('league','unfinished_cards',0),[{userId:'manager',displayName:'Morgan'}]);
 assert.deepEqual(repo.cardProgress('different-league'),[]);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});

test('walkthrough changes preserve populated leagues, keep reads private and publish confirmed edits atomically',async t=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');t.after(()=>db.close());
 const migrations=discoverMigrations({migrationsDirectory:path.resolve(__dirname,'../../database/migrations')});
 const now=Date.parse('2026-09-30T00:00:00Z');
 const migrate=list=>applyMigrations({database:db,migrations:list,applicationBuildId:'walkthrough-test',now:()=>now});
 migrate(migrations.filter(m=>m.id<=66));
 const hash=await createScryptPasswordHasher({secureRandom:{bytes:crypto.randomBytes}}).hash('synthetic walkthrough fixture');
 const fixture=db.transaction(()=>seedFixture(db,hash)).immediate();await Promise.all(fixture.acceptancePromises);fixture.assertLateLockCoverage();migrate(migrations);
 let stage='readiness'; try {
 const management=createSqliteLeagueManagementRepository({database:db,nowMs:()=>now});
 const active=db.prepare("SELECT l.id FROM leagues l JOIN seasons s ON s.id=l.current_season_id AND s.league_id=l.id WHERE s.free_agent_draft_completed_at_ms IS NOT NULL").all();
 assert(active.length>0);
 const beforeReads=db.prepare('SELECT total_changes() n').get().n;
 for(const {id}of active){
  const report=management.readiness(id,now);
  assert(report.teams.length>0);
  for(const team of report.teams.filter(x=>x.roster)){
   assert(team.roster.limits);
   assert(!team.roster.reasonCodes.some(code=>/INCOMPLETE|INSUFFICIENT|MISSING|TOO_FEW/.test(code)&&!/CONTRACT|CAP/.test(code)),JSON.stringify(team.roster.reasonCodes));
  }
 }
 assert.equal(db.prepare('SELECT total_changes() n').get().n,beforeReads,'readiness must never write');
 const deadlines=createSqliteTradeDeadlineChangeRepository({database:db});
 const state=db.prepare('SELECT id FROM leagues').all().map(l=>deadlines.state(l.id)).find(s=>!deadlinePolicy.blockedReason(s));
 assert(state,'fixture has editable league');
 const leagueId=state.league.id,actorUserId=db.prepare("SELECT user_id FROM league_memberships WHERE league_id=? AND permission_category='commissioner' AND status='active'").get(leagueId).user_id;
 const protectedTables=['contracts','player_ownerships','auctions','auction_bids','candidate_card_entries','matchup_results'];
 const protectedSnapshot=()=>Object.fromEntries(protectedTables.filter(table=>db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)).map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 const preserved=protectedSnapshot();
 stage='trade deadline';
 const change={state,plan:deadlinePolicy.plan(state,{tradeDeadlineAtMs:now+365*86400000,reason:'Agree a later trade deadline'},now),actorUserId,authority:'commissioner',clientKey:'walkthrough-deadline',requestHash:'a'.repeat(64),nowMs:now};
 const transactionSnapshot=()=>Object.fromEntries(['leagues','league_settings','trades','league_communications','notifications','league_activity','league_trade_deadline_changes'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 const beforeFailed=transactionSnapshot();
 assert.throws(()=>deadlines.transaction(()=>{deadlines.apply(change);throw Error('rollback rehearsal');}),/rollback rehearsal/);
 assert.deepEqual(transactionSnapshot(),beforeFailed);
 const result=deadlines.transaction(()=>deadlines.apply(change));
 const announcement=db.prepare('SELECT * FROM league_communications WHERE client_key=?').get('automatic-change:'+result.id);
 assert(announcement);assert.match(announcement.body,/Trade deadline:/);assert.match(announcement.body,/Agree a later trade deadline/);assert.equal(announcement.notify,0);
 const members=db.prepare("SELECT count(DISTINCT user_id) n FROM league_memberships WHERE league_id=? AND status='active'").get(leagueId).n;
 assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE deduplication_key LIKE ?").get('trade-deadline:'+result.id+':%').n,members);
 stage='scoring';
 const scoring=createSqliteLeagueScoringRepository({database:db}),scoringState=scoring.state(leagueId),weights=defaultScoringWeights();weights.F.hits=10;
 const effectiveWeek=1+Math.max(0,...scoringState.weeks.filter(w=>scoringState.finalWeeks.includes(w.id)||w.ends_at_ms<=now||['final','cancelled'].includes(w.status)).map(w=>w.sequence));
 const score=scoring.transaction(()=>scoring.apply({state:scoringState,proposed:{weights,effectiveWeekSequence:effectiveWeek,reason:'Lower the hit value'},actorUserId,authority:'commissioner',clientKey:'walkthrough-scoring',requestHash:'b'.repeat(64),nowMs:now+1}));
 const scoreNotice=db.prepare('SELECT body FROM league_communications WHERE client_key=?').get('automatic-change:'+score.id);
 assert(scoreNotice.body.includes('Week '+effectiveWeek));assert.match(scoreNotice.body,/hits \(Forward\): 0\.20 → 0\.10 FP/);
 assert.equal(JSON.parse(scoring.state(leagueId).rules[0].before_json).weights.F.hits,20);
 assert.deepEqual(protectedSnapshot(),preserved);
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
 } catch(error){throw new Error(stage+': '+error.message,{cause:error});}
});
