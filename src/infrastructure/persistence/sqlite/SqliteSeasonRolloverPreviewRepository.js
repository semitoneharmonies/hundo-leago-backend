const {createSqliteLeagueLifecycleTransitionRepository}=require('./SqliteLeagueLifecycleTransitionRepository');
function createSqliteSeasonRolloverPreviewRepository({database}){
 const lifecycle=createSqliteLeagueLifecycleTransitionRepository({database});
 const seasonSql='SELECT id,label,status,nhl_season_key AS nhlSeasonKey,regular_season_starts_at_ms AS startsAtMs,regular_season_ends_at_ms AS endsAtMs,fantasy_playoffs_start_at_ms AS playoffsStartAtMs,fantasy_playoffs_end_at_ms AS playoffsEndAtMs,free_agent_draft_completed_at_ms AS fadCompletedAtMs FROM seasons';
 return {read(leagueId,at){
  const league=database.prepare('SELECT current_season_id AS seasonId,status FROM leagues WHERE id=?').get(leagueId);
  const source=database.prepare(seasonSql+' WHERE league_id=? AND id=?').get(leagueId,league.seasonId)||null;
  const nextKey=source&&/^\d{8}$/.test(source.nhlSeasonKey)?String(Number(source.nhlSeasonKey)+10001):null;
  const targets=nextKey?database.prepare(seasonSql+' WHERE league_id=? AND nhl_season_key=?').all(leagueId,nextKey):[];
  const target=targets.length===1?targets[0]:null,issues=[];
  if(!source)issues.push('CURRENT_SEASON_MISSING');
  if(!target)issues.push(targets.length>1?'NEXT_SEASON_AMBIGUOUS':'NEXT_SEASON_MISSING');
  if(league.status==='frozen')issues.push('LEAGUE_PAUSED');
  const archived=source?database.prepare(`SELECT (SELECT count(*) FROM matchup_weeks WHERE league_id=@leagueId AND season_id=@seasonId) AS weeks,
   (SELECT count(*) FROM matchup_weeks WHERE league_id=@leagueId AND season_id=@seasonId AND status<>'final') AS unfinishedWeeks,
   (SELECT count(*) FROM matchup_results WHERE league_id=@leagueId AND season_id=@seasonId AND status IN ('official','corrected')) AS results,
   (SELECT count(*) FROM standings_snapshot_finalizations WHERE league_id=@leagueId AND season_id=@seasonId) AS finalizedStandings`).get({leagueId,seasonId:source.id}):{weeks:0,unfinishedWeeks:0,results:0,finalizedStandings:0};
  if(source&&!source.fadCompletedAtMs)issues.push('SOURCE_DRAFT_UNFINISHED');
  if(source&&(!archived.weeks||archived.unfinishedWeeks||!archived.finalizedStandings))issues.push('SOURCE_COMPETITION_UNFINISHED');
  const openAuctions=database.prepare("SELECT count(*) AS n FROM auctions WHERE league_id=? AND status IN ('open','resolving')").get(leagueId).n;
  if(openAuctions)issues.push('AUCTIONS_UNFINISHED');
  const drafts=target?database.prepare('SELECT id,status,starts_at_ms AS startsAtMs FROM entry_drafts WHERE league_id=? AND season_id=? ORDER BY created_at_ms,id').all(leagueId,target.id):[];
  const bindings=target?database.prepare('SELECT id,entry_draft_id AS draftId,status,scheduled_starts_at_ms AS startsAtMs FROM entry_draft_rollover_bindings WHERE league_id=? AND from_season_id=? AND to_season_id=? ORDER BY created_at_ms,id').all(leagueId,source.id,target.id):[];
  if(target&&[target.startsAtMs,target.endsAtMs,target.playoffsStartAtMs,target.playoffsEndAtMs].some(v=>v===null))issues.push('NEXT_CALENDAR_UNSET');
  if(target&&(!drafts.some(d=>d.status==='ready')||!bindings.length))issues.push('NEXT_DRAFT_NOT_SCHEDULED');
  const picks=target?database.prepare(`SELECT p.id,p.round_number AS round,p.position_number AS position,p.status,o.name AS originalTeamName,t.name AS ownerTeamName
   FROM draft_picks p JOIN teams o ON o.league_id=p.league_id AND o.id=p.original_team_id JOIN teams t ON t.league_id=p.league_id AND t.id=p.current_owner_team_id
   WHERE p.league_id=? AND p.target_season_id=? ORDER BY p.round_number,p.position_number,p.id`).all(leagueId,target.id):[];
  const matrix=source&&target?lifecycle.readSeasonRolloverMatrix({leagueId,sourceSeasonId:source.id,targetSeasonId:target.id}):null;
  if(matrix?.violations.length)issues.push('RECORDS_NEED_REVIEW');
  const available=Boolean(matrix&&!matrix.violations.length),player=id=>database.prepare('SELECT full_name AS name FROM players WHERE id=?').get(id)?.name||'Unavailable player',team=id=>database.prepare('SELECT name FROM teams WHERE league_id=? AND id=?').get(leagueId,id)?.name||'Former team';
  const contracts=available?matrix.contractEffects.map(e=>({id:e.entityId,playerName:player(e.before.playerId),teamName:team(e.before.currentTeamId),outcome:e.effectKind==='contract_advanced'?'continue':'expire',
   currentYears:e.before.years.filter(y=>['current','future'].includes(y.status)).length,nextYears:e.effectKind==='contract_advanced'?e.before.years.filter(y=>y.status==='future').length:0,aavCents:e.before.aavCents})):[];
  const obligations=available?[...matrix.retentionEffects.map(e=>({...e,kind:'retention'})),...matrix.buyoutEffects.map(e=>({...e,kind:'buyout'}))].map(e=>({id:e.entityId,kind:e.kind,playerName:player(e.before.playerId),teamName:team(e.before.responsibleTeamId),
   outcome:e.effectKind.endsWith('_completed')?'complete':'continue',currentAmountCents:e.before.years.find(y=>y.seasonId===source.id)?.amountCents||0,nextAmountCents:e.before.years.find(y=>y.seasonId===target.id&&y.status==='future')?.amountCents||0})):[];
  return {leagueId,checkedAtMs:at,readOnly:true,source,target,projectionAvailable:available,issues,archived,openAuctions,drafts,bindings,picks,contracts,obligations,
   summary:available?{contractsContinuing:contracts.filter(c=>c.outcome==='continue').length,contractsExpiring:contracts.filter(c=>c.outcome==='expire').length,
    playersCarried:matrix.ownershipEffects.filter(e=>e.effectKind==='ownership_carried').length,playersReleased:matrix.ownershipEffects.filter(e=>e.effectKind==='ownership_released').length,
    obligationsContinuing:obligations.filter(o=>o.outcome==='continue').length,obligationsCompleting:obligations.filter(o=>o.outcome==='complete').length,tradesCancelled:matrix.tradeEffects.length}:null};
 }};
}
module.exports={createSqliteSeasonRolloverPreviewRepository};
