const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { createNhlCompletedGameAdapter, PROVIDER_NAME, easternStart } = require("../../src/infrastructure/nhl/NhlCompletedGameAdapter");
const { createLiveStatisticsService } = require("../../src/application/services/statistics/createLiveStatisticsService");
const { createSqliteStatisticsRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");
const { createSqliteMatchupLockRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupLockRepository");
const { createMatchupLockService } = require("../../src/application/services/matchups/createMatchupLockService");
const { createMatchupLegalityService } = require("../../src/application/services/matchups/createMatchupLegalityService");
const { createLateLockCoordinator } = require("../../src/application/services/matchups/createLateLockCoordinator");
const { createSqliteLateLockCoordinatorRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteLateLockCoordinatorRepository");
const { createMatchupWeekService } = require("../../src/application/services/matchups/createMatchupWeekService");
const { createSqliteMatchupWeekRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupWeekRepository");
const { createMatchupScoringService } = require("../../src/application/services/matchups/createMatchupScoringService");
const { createSqliteMatchupScoringRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupScoringRepository");
const { createMatchupResultService } = require("../../src/application/services/matchups/createMatchupResultService");
const { createSqliteMatchupResultRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupResultRepository");
const { createMatchupStandingsService } = require("../../src/application/services/matchups/createMatchupStandingsService");
const { createSqliteMatchupStandingsRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupStandingsRepository");
const { inspectNhlStatisticsReadiness } = require("../../src/operations/statistics/inspectNhlStatisticsReadiness");

const uuid = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const START = Date.parse("2026-10-12T07:00:00Z"), HOUR = 3_600_000, END = START + 168 * HOUR;

function setup(t) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  t.after(() => database.close());
  migrateDatabase({ database, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "nhl-week-acceptance", now: () => 1 });
  database.prepare("INSERT INTO leagues (id,name,name_normalized,status,timezone,created_at_ms,updated_at_ms,version) VALUES (?,'NHL Acceptance','nhl acceptance','active','America/Vancouver',1,1,1)").run(uuid(1));
  database.prepare("INSERT INTO seasons (id,league_id,label,nhl_season_key,status,created_at_ms,updated_at_ms,version) VALUES (?,?,'2026-27','20262027','active',1,1,1)").run(uuid(2),uuid(1));
  for (let side = 0; side < 2; side += 1) {
    database.prepare("INSERT INTO users (id,email_normalized,email_display,display_name,display_name_normalized,status,created_at_ms,updated_at_ms,version) VALUES (?,?,?,?,?,'active',1,1,1)").run(uuid(10+side),`user${side}@example.test`,`user${side}@example.test`,`User ${side}`,`user ${side}`);
    database.prepare("INSERT INTO league_memberships (id,league_id,user_id,permission_category,status,joined_at_ms,created_at_ms,updated_at_ms,version) VALUES (?,?,?,?,'active',1,1,1,1)").run(uuid(20+side),uuid(1),uuid(10+side),side ? "manager" : "commissioner");
    database.prepare("INSERT INTO teams (id,league_id,name,name_normalized,status,created_at_ms,updated_at_ms,version) VALUES (?,?,?,?,'active',1,1,1)").run(uuid(30+side),uuid(1),`Team ${side}`,`team ${side}`);
    database.prepare("INSERT INTO team_manager_assignments (id,league_id,team_id,user_id,membership_id,assigned_by_user_id,status,assigned_at_ms,accepted_at_ms,version) VALUES (?,?,?,?,?,?,'accepted',1,1,1)").run(uuid(40+side),uuid(1),uuid(30+side),uuid(10+side),uuid(20+side),uuid(10));
  }
  database.prepare("UPDATE leagues SET commissioner_membership_id=?,current_season_id=?,version=2,updated_at_ms=2 WHERE id=?").run(uuid(20),uuid(2),uuid(1));
  database.prepare("INSERT INTO matchup_weeks (id,league_id,season_id,week_key,sequence,starts_at_ms,baseline_at_ms,locks_at_ms,ends_at_ms,rolls_over_at_ms,status,created_at_ms,updated_at_ms,version) VALUES (?,?,?,'regular-01',1,?,?,?,?,?,'scheduled',1,1,1)").run(uuid(3),uuid(1),uuid(2),START,START+HOUR,START+16*HOUR,END,END);
  database.prepare("INSERT INTO matchups (id,league_id,season_id,matchup_week_id,home_team_id,away_team_id,home_team_name,away_team_name,status,created_at_ms,updated_at_ms,version) VALUES (?,?,?,?,?,?,'Team 0','Team 1','scheduled',1,1,1)").run(uuid(4),uuid(1),uuid(2),uuid(3),uuid(30),uuid(31));
  const catalog = [];
  for (let i=0;i<36;i+=1) {
    const id=uuid(100+i), providerPlayerId=String(8478000+i), slot=i%18;
    database.prepare("INSERT INTO players (id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms,version) VALUES (?,'Player',?,?,'2000-01-01','active',1,1,1)").run(id,String(i),`Player ${i}`);
    database.prepare("INSERT INTO player_external_ids (id,player_id,provider,external_value,created_at_ms) VALUES (?,?,'nhl',?,1)").run(uuid(200+i),id,providerPlayerId);
    database.prepare("INSERT INTO player_ownerships (id,league_id,season_id,player_id,team_id,ownership_kind,roster_category,position_group,slot_number,acquired_transaction_type,created_at_ms,updated_at_ms,version) VALUES (?,?,?,?,?,'Rostered',?,?,?,'acceptance_fixture',1,1,1)").run(uuid(300+i),uuid(1),uuid(2),id,uuid(i<18?30:31),i===18?"Bench":"Active",slot<12?"F":"D",i===18?1:slot<12?slot+1:slot-11);
    catalog.push({ playerId:id,providerPlayerId });
  }
  return { database, catalog };
}

test("NHL readiness detects missing roster identities without changing persisted state", (t) => {
  const { database } = setup(t);
  const before = database.serialize();
  const ready = inspectNhlStatisticsReadiness({ database, nhlSeasonKey: "20262027", minimumPlayerCount: 30 });
  assert.equal(ready.readyForStatistics, true);
  assert.equal(ready.latestSuccessfulRefresh, null);
  assert.deepEqual(database.serialize(), before);
  database.prepare("DELETE FROM player_external_ids WHERE player_id = ?").run(uuid(100));
  const missingBefore = database.serialize();
  const missing = inspectNhlStatisticsReadiness({ database, nhlSeasonKey: "20262027", minimumPlayerCount: 30 });
  assert.equal(missing.readyForStatistics, false);
  assert.deepEqual(missing.missingRosterIdentities.map(({ playerId }) => playerId), [uuid(100)]);
  assert.deepEqual(database.serialize(), missingBefore);
});

test("NHL completed-game source carries an accelerated week through locks, late exclusions, failure recovery and official standings", async (t) => {
  const { database,catalog }=setup(t);
  let now=START,offline=false,calls=0;
  const games=[
    { id:2026020001,easternStartTime:"2026-10-11T19:00:00",goals:1,assists:0 },
    { id:2026020002,easternStartTime:"2026-10-12T19:30:00",goals:1,assists:0 },
    { id:2026020003,easternStartTime:"2026-10-14T19:00:00",goals:0,assists:1 },
    { id:2026020004,easternStartTime:"2026-10-19T01:30:00",goals:0,assists:0 },
    { id:2026020005,easternStartTime:"2026-10-19T19:00:00",goals:3,assists:0 },
    { id:2026020006,easternStartTime:"2026-10-12T02:30:00",goals:2,assists:0 },
  ].map((game)=>({...game,season:20262027,gameType:2,homeTeamId:13,visitingTeamId:16,startsAtMs:easternStart(game.easternStartTime)}));
  const final=(game)=>now>=game.startsAtMs+3*HOUR;
  const stats=(game)=>catalog.map((player,i)=>({ playerId:Number(player.providerPlayerId),gameId:game.id,homeRoad:i<18?"H":"R",gamesPlayed:1,goals:game.goals,assists:game.assists,points:game.goals+game.assists }));
  const fetchImpl=async(uri)=>{
    calls+=1;
    if(offline) return {ok:false,status:503};
    const url=new URL(uri);let data;
    if(url.pathname.endsWith("/game")) data={data:games.map((game)=>({...game,gameStateId:final(game)?7:now>=game.startsAtMs?3:1})),total:games.length};
    else if(url.pathname.endsWith("/summary")) {
      const selected=url.searchParams.get("cayenneExp").match(/\d{10}/g).map(Number);
      const rows=games.filter((game)=>selected.includes(game.id)).flatMap(stats).sort((a,b)=>a.playerId-b.playerId||a.gameId-b.gameId);
      const start=Number(url.searchParams.get("start"));data={data:rows.slice(start,start+100),total:rows.length};
    } else if(url.pathname.endsWith("/landing")) {const id=Number(url.pathname.split("/").at(-2));data={playerId:id,position:"D",currentTeamId:id<8478018?13:16,isActive:true};}
    else {const game=games.find((row)=>String(row.id)===url.pathname.split("/").at(-2));const rows=stats(game);data={id:game.id,season:20262027,gameType:2,startTimeUTC:new Date(game.startsAtMs).toISOString(),homeTeam:{id:13},awayTeam:{id:16},gameState:final(game)?"OFF":now>=game.startsAtMs?"LIVE":"FUT",gameScheduleState:"OK",playerByGameStats:{homeTeam:{forwards:rows.slice(0,18),defense:[]},awayTeam:{forwards:rows.slice(18),defense:[]}}};}
    return {ok:true,json:async()=>data};
  };
  const statsRepository=createSqliteStatisticsRepository({database});
  const adapter=createNhlCompletedGameAdapter({fetchImpl,nowMs:()=>now,readCatalogPlayers:()=>catalog,retryDelay:async()=>{}});
  const statistics=createLiveStatisticsService({repository:statsRepository,provider:adapter,nhlSeasonKey:"20262027",providerName:PROVIDER_NAME,playerIdentityProvider:"nhl",minimumPlayerCount:36,nowMs:()=>now});
  const lockRepository=createSqliteMatchupLockRepository({database});
  const legality=createMatchupLegalityService({repository:lockRepository,normalLockService:createMatchupLockService({repository:lockRepository}),gameStateProvider:adapter,nowMs:()=>now});
  const coordinator=createLateLockCoordinator({targetRepository:createSqliteLateLockCoordinatorRepository({database}),legalityService:legality,statisticsService:statistics,provider:PROVIDER_NAME,clock:{nowMs:()=>now},refreshOnRosterChange:false});
  const weeks=createMatchupWeekService({repository:createSqliteMatchupWeekRepository({database})});
  const scoring=createMatchupScoringService({repository:createSqliteMatchupScoringRepository({database})});
  const results=createMatchupResultService({repository:createSqliteMatchupResultRepository({database}),scoringService:scoring});
  const standings=createMatchupStandingsService({repository:createSqliteMatchupStandingsRepository({database})});
  const scope={leagueId:uuid(1),seasonId:uuid(2),weekId:uuid(3),matchupId:uuid(4),provider:PROVIDER_NAME};
  const input=()=>({...scope,nowMs:now});
  await statistics.refresh();
  now=START+HOUR;weeks.advance(input());
  now=START+16*HOUR;weeks.advance(input());
  legality.lockAtBoundary({...input(),teamId:uuid(30),lockId:uuid(400)});
  legality.lockAtBoundary({...input(),teamId:uuid(31),lockId:uuid(401)});
  assert.equal(database.prepare("SELECT legal FROM matchup_roster_locks WHERE id=?").get(uuid(401)).legal,0);
  now=START+17*HOUR;
  database.prepare("UPDATE player_ownerships SET roster_category='Active',slot_number=1,updated_at_ms=?,version=version+1 WHERE id=?").run(now,uuid(318));
  const before=calls;
  await assert.rejects(legality.lockLate({...input(),teamId:uuid(31),lockId:uuid(401)}));
  assert.equal(calls,before);
  now=START+18*HOUR;
  await statistics.refresh();
  assert.equal((await coordinator.retryAfterStatisticsRefresh({nhlSeasonKey:"20262027"})).completed,1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_roster_game_exclusions").get().count,18);
  now=START+22*HOUR;await statistics.refresh();
  assert.equal(scoring.readLive(input()).home.scoreHundredths,2250);
  assert.equal(scoring.readLive(input()).away.scoreHundredths,0);
  const prior=statsRepository.readLatestSeason({provider:PROVIDER_NAME,nhlSeasonKey:"20262027"}).refresh.id;
  offline=true;now+=HOUR;await assert.rejects(statistics.refresh());
  assert.equal(statsRepository.readLatestSeason({provider:PROVIDER_NAME,nhlSeasonKey:"20262027"}).refresh.id,prior);
  offline=false;now=END;await statistics.refresh();weeks.advance(input());
  assert.equal(results.finalize({...input(),operationId:uuid(500)}).waiting.reasonCode,"NHL_GAMES_NOT_COMPLETE");
  // Delay until the following Monday's game has also completed: it must not enter this week's result.
  now=END+23*HOUR;await statistics.refresh();
  const score=scoring.readLive(input());assert.equal(score.home.scoreHundredths,4050);assert.equal(score.away.scoreHundredths,1800);
  const command={...input(),operationId:uuid(501)};
  assert.equal(results.finalize(command).finalized,true);
  assert.equal(results.finalize(command).replayed,true);
  assert.equal(database.prepare("SELECT status FROM matchup_weeks WHERE id=?").get(uuid(3)).status,"final");
  const table=standings.read({leagueId:uuid(1),seasonId:uuid(2)});
  assert.equal(table.rows[0].teamId,uuid(30));assert.equal(table.rows[0].wins,1);
  assert.deepEqual(database.pragma("foreign_key_check"),[]);
});
