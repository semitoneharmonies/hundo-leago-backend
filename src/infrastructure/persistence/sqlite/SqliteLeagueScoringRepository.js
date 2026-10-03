const {publishLeagueChangeAnnouncement}=require('./leagueChangeAnnouncement');
const crypto=require('node:crypto');
const {fail,ruleAt}=require('../../../domain/leagues/leagueScoringPolicy');
const {createSqliteNotificationWriter}=require('./SqliteNotificationWriter');
const {resolveSqliteLeagueOutboxWriter}=require('./SqliteLeagueOutboxWriter');
const {createSocketEventMetadata,createEmptySocketRelated}=require('../../../domain/leagues/socketInvalidation');
function createSqliteLeagueScoringRepository({database,leagueOutboxWriter}) {
  const notifications=createSqliteNotificationWriter({database}),outbox=resolveSqliteLeagueOutboxWriter({database,leagueOutboxWriter});
  return {
    transaction:fn=>database.transaction(fn).immediate(),
    state(leagueId) {
      const league=database.prepare('SELECT id,status,current_season_id,version FROM leagues WHERE id=?').get(leagueId);
      if(!league)fail('The league was not found.','LEAGUE_NOT_FOUND');
      return {league,season:database.prepare('SELECT * FROM seasons WHERE league_id=? AND id=?').get(leagueId,league.current_season_id)||null,
        weeks:database.prepare('SELECT * FROM matchup_weeks WHERE league_id=? AND season_id=? ORDER BY sequence').all(leagueId,league.current_season_id),
        finalWeeks:database.prepare("SELECT DISTINCT matchup_week_id FROM matchups WHERE league_id=? AND season_id=? AND status='final' ORDER BY matchup_week_id").all(leagueId,league.current_season_id).map(r=>r.matchup_week_id),
        rules:database.prepare('SELECT r.*,u.display_name AS actor_name FROM league_scoring_rules r JOIN users u ON u.id=r.actor_user_id WHERE r.league_id=? AND r.season_id=? ORDER BY revision DESC').all(leagueId,league.current_season_id)};
    },
    matchups:(leagueId,seasonId,weekId)=>database.prepare(`SELECT m.id,m.status,h.name AS home_name,a.name AS away_name,v.home_score_hundredths,v.away_score_hundredths
      FROM matchups m JOIN teams h ON h.league_id=m.league_id AND h.id=m.home_team_id JOIN teams a ON a.league_id=m.league_id AND a.id=m.away_team_id
      LEFT JOIN matchup_results r ON r.league_id=m.league_id AND r.matchup_id=m.id
      LEFT JOIN matchup_result_versions v ON v.league_id=r.league_id AND v.id=r.current_version_id
      WHERE m.league_id=? AND m.season_id=? AND m.matchup_week_id=? ORDER BY m.id`).all(leagueId,seasonId,weekId),
    replay:(leagueId,userId,key)=>database.prepare('SELECT id,request_hash FROM league_scoring_rules WHERE league_id=? AND actor_user_id=? AND client_key=?').get(leagueId,userId,key),
    apply({state:s,proposed:p,actorUserId,authority,clientKey,requestHash,nowMs}) {
      const id=crypto.randomUUID(),leagueId=s.league.id;
      database.prepare(`INSERT INTO league_scoring_rules(id,league_id,season_id,actor_user_id,actor_authority,revision,effective_week_sequence,weights_json,client_key,request_hash,reason,before_json,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,leagueId,s.season.id,actorUserId,authority,(s.rules[0]?.revision||0)+1,p.effectiveWeekSequence,JSON.stringify(p.weights),clientKey,requestHash,p.reason,JSON.stringify(ruleAt(s.rules,p.effectiveWeekSequence)),nowMs);
      if(database.prepare('UPDATE leagues SET updated_at_ms=max(updated_at_ms,?),version=version+1 WHERE id=? AND version=?').run(nowMs,leagueId,s.league.version).changes!==1)fail('The league changed. Review again.');
      const message='League scoring values change from Week '+p.effectiveWeekSequence+'. View the scoring rules for category values. Completed results are unchanged.';
      database.prepare(`INSERT INTO league_activity(id,league_id,season_id,event_type,actor_user_id,actor_authority,related_type,related_id,display_summary,reason,metadata_json,occurred_at_ms)
        VALUES(?,?,?,'league_scoring_changed',?,?,'league',?,?,?,?,?)`).run(id,leagueId,s.season.id,actorUserId,authority,leagueId,message,p.reason,JSON.stringify({changeId:id,effectiveWeekSequence:p.effectiveWeekSequence}),nowMs);
      for(const user of database.prepare("SELECT DISTINCT u.id FROM league_memberships m JOIN users u ON u.id=m.user_id WHERE m.league_id=? AND m.status='active' AND u.status='active'").all(leagueId))
        notifications.insert({id:crypto.randomUUID(),userId:user.id,leagueId,eventType:'league_scoring_changed',messageDataJson:JSON.stringify({leagueId,message}),relatedFeature:'league',relatedRecordId:leagueId,deliveryStatus:'delivered',createdAtMs:nowMs,deliveredAtMs:nowMs,deduplicationKey:'scoring:'+id+':'+user.id});
      outbox.write({id:crypto.randomUUID(),leagueId,eventType:'league.changed',aggregateType:'league',aggregateId:leagueId,payload:createSocketEventMetadata({
        eventType:'league.changed',version:s.league.version+1,reasonCode:'league_changed',occurredAtMs:nowMs,related:createEmptySocketRelated()}),occurredAtMs:nowMs,audiences:[{kind:'league'}]});
      const previous=ruleAt(s.rules,p.effectiveWeekSequence).weights;
      const changes=Object.entries(p.weights).flatMap(([position,weights])=>Object.entries(weights).filter(([key,value])=>previous[position][key]!==value).map(([key,value])=>key.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2')+' ('+(position==='F'?'Forward':'Defence')+'): '+(previous[position][key]/100).toFixed(2)+' → '+(value/100).toFixed(2)+' FP'));
      publishLeagueChangeAnnouncement(database,{id,leagueId,actorUserId,title:'Scoring values changed',message:message+'\n'+changes.join('\n'),reason:p.reason,nowMs});
      return {id};
    },
  };
}
module.exports={createSqliteLeagueScoringRepository};
