const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../../src/infrastructure/database/migrate');
const { createSqliteRepositoryContext } = require('../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext');
const { createSqliteMrBoniRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteMrBoniRepository');
const { createSqliteUserRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteUserRepository');
const { createSqliteLeagueAccessRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository');
const { createSqliteTeamAuthorityRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository');
const { createLeagueAuthorizationService } = require('../../src/application/services/authorization/requireLeagueAuthority');
const { createTeamAuthorizationService } = require('../../src/application/services/authorization/requireTeamManagerAuthority');
const { createMrBoniService } = require('../../src/application/services/games/createMrBoniService');

const DIR = path.resolve(__dirname, '../../database/migrations');
const NOW = Date.parse('2026-10-22T12:00:00Z');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const READER=id(1), MANAGER=id(2), SECOND=id(3), OUTSIDER=id(4), LEAGUE=id(10), OTHER=id(11);
const authenticated = userId => ({ valid: true, user: { id: userId, status: 'active', version: 1 }, session: { id: id(900+Number(userId.slice(-1))), userId } });
const base = (userId=MANAGER, leagueId=LEAGUE) => ({ authenticated: authenticated(userId), leagueId });
function setup(t, verifier=fixtureVerifier) {
  const database=new Database(':memory:');database.pragma('foreign_keys = ON');
  migrateDatabase({database,migrationsDirectory:DIR,applicationBuildId:'mr-boni-test',now:()=>NOW});
  t.after(()=>database.close());
  const context=createSqliteRepositoryContext({database});
  for(const [userId,name] of [[READER,'Commissioner'],[MANAGER,'Alpha manager'],[SECOND,'Beta manager'],[OUTSIDER,'Other manager']]) {
    context.repositories.users.insert({id:userId,email_normalized:`${userId}@example.test`,email_display:`${userId}@example.test`,
      display_name:name,display_name_normalized:name.toLowerCase(),status:'active',created_at_ms:NOW,updated_at_ms:NOW,version:1});
  }
  for(const [leagueId,name] of [[LEAGUE,'Alpha'],[OTHER,'Other']]) {
    context.repositories.leagues.insert({id:leagueId,name,name_normalized:name.toLowerCase(),status:'active',timezone:'America/Vancouver',
      commissioner_membership_id:null,current_season_id:null,created_at_ms:NOW,updated_at_ms:NOW,version:1});
  }
  for(const [userId,leagueId] of [[READER,LEAGUE],[MANAGER,LEAGUE],[SECOND,LEAGUE],[OUTSIDER,OTHER],[MANAGER,OTHER]]) {
    const memberId=id(Number(userId.slice(-1))+Number(leagueId.slice(-2))*10);
    context.repositories.league_memberships.insert({id:memberId,league_id:leagueId,user_id:userId,permission_category:userId===READER?'commissioner':'manager',
      status:'active',joined_at_ms:NOW,ended_at_ms:null,created_at_ms:NOW,updated_at_ms:NOW,version:1});
    if(userId===READER)context.repositories.leagues.updateVersioned({key:leagueId,expectedVersion:1,changes:{commissioner_membership_id:memberId,updated_at_ms:NOW}});
    if(userId!==READER) {
      const teamId=id(Number(userId.slice(-1))+Number(leagueId.slice(-2))*100);
      context.repositories.teams.insert({id:teamId,league_id:leagueId,name:`Team ${teamId}`,name_normalized:`team ${teamId}`,status:'active',
        primary_colour:null,secondary_colour:null,logo_reference:null,created_at_ms:NOW,updated_at_ms:NOW,version:1});
      context.repositories.team_manager_assignments.insert({id:id(Number(userId.slice(-1))+Number(leagueId.slice(-2))*1000),league_id:leagueId,team_id:teamId,
        user_id:userId,membership_id:memberId,assigned_by_user_id:READER,status:'accepted',assigned_at_ms:NOW,accepted_at_ms:NOW,ended_at_ms:null,version:1});
    }
  }
  const leagueAuthorization=createLeagueAuthorizationService({userRepository:createSqliteUserRepository({database}),leagueAccessRepository:createSqliteLeagueAccessRepository({database})});
  const teamAuthorityRepository=createSqliteTeamAuthorityRepository({database});
  const dependencies={repositoryContext:context,repository:createSqliteMrBoniRepository({database}),leagueAuthorization,
    teamAuthorization:createTeamAuthorizationService({leagueAuthorization,teamAuthorityRepository}),teamAuthorityRepository,
    clock:{nowMs:()=>NOW+100},secureRandom:{id:crypto.randomUUID,bytes:crypto.randomBytes},...(verifier?{verifyRun:verifier}:{})};
  return {database,context,dependencies,service:createMrBoniService(dependencies)};
}
const start = (r, args={}) => r.service.start({...base(),input:{clientRunId:crypto.randomUUID()},...args});
const save = (r,run,commands,args={}) => r.service.checkpoint({...base(),runId:run.runId,input:{commands},...args});
function protectedRows(database) {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'mr_boni_%' ORDER BY name").all()
    .map(({name})=>[name,database.prepare(`SELECT * FROM "${name}"`).all()]);
}


function fixtureVerifier({commands}) { const highest=Math.min(3,Math.floor(commands.length/2)); return {highestLevelCompleted:highest,cumulativeTimeMs:highest?commands.slice(0,highest*2).reduce((sum,c)=>sum+c[1]*1000,0):null,completed:highest===3}; }
const record=(count,ticks=1)=>Array.from({length:count},()=>[0,ticks,1,0,0]);
module.exports={setup,base,start,save,protectedRows,record,fixtureVerifier,id,NOW,DIR,READER,MANAGER,SECOND,OUTSIDER,LEAGUE,OTHER,authenticated};
