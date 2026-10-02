// Public schedule metadata only. Never select cards, players, bids or managers.
function leagueCalendarEvents(database, leagueId) {
 const league=database.prepare('SELECT current_season_id FROM leagues WHERE id=?').get(leagueId);
 if(!league?.current_season_id)return [];
 const events=[];
 const add=(id,kind,label,atMs,extra={})=>{if(Number.isSafeInteger(atMs))events.push({id,kind,label,atMs,...extra});};
 const settings=database.prepare('SELECT trade_deadline_at_ms FROM league_settings WHERE league_id=?').get(leagueId);
 add('trade-deadline','trade','Trade deadline',settings?.trade_deadline_at_ms);
 for(const draft of database.prepare('SELECT id,candidate_deadline_at_ms FROM free_agent_drafts WHERE league_id=? AND season_id=? ORDER BY id').all(leagueId,league.current_season_id)) {
  add('fad-target:'+draft.id,'draft','Candidate Card target',draft.candidate_deadline_at_ms,{fadId:draft.id,field:'deadline'});
  for(const round of database.prepare('SELECT id,sequence,opens_at_ms,creation_cutoff_at_ms,rolls_over_at_ms FROM free_agent_draft_rollovers WHERE league_id=? AND fad_id=? ORDER BY sequence').all(leagueId,draft.id)) {
   const prefix='FAD round '+round.sequence;
   add('fad-open:'+round.id,'draft',prefix+' opens',round.opens_at_ms,{fadId:draft.id});
   add('fad-cutoff:'+round.id,'auction',prefix+' new-auction cutoff',round.creation_cutoff_at_ms,{fadId:draft.id});
   add('fad-close:'+round.id,'draft',prefix+' closes',round.rolls_over_at_ms,{fadId:draft.id,field:'round',sequence:round.sequence});
  }
 }
 for(const row of database.prepare("SELECT resolves_at_ms,COUNT(*) AS n FROM auctions WHERE league_id=? AND season_id=? AND status='open' GROUP BY resolves_at_ms ORDER BY resolves_at_ms").all(leagueId,league.current_season_id))
  add('auction-close:'+row.resolves_at_ms,'auction',row.n+' open auction'+(row.n===1?'':'s')+' close',row.resolves_at_ms);
 const entry=database.prepare("SELECT starts_at_ms FROM entry_drafts WHERE league_id=? AND season_id=? AND status<>'cancelled'").get(leagueId,league.current_season_id);
 add('entry-draft','draft','Entry Draft starts',entry?.starts_at_ms);
 return events.sort((a,b)=>a.atMs-b.atMs||a.id.localeCompare(b.id));
}
module.exports={leagueCalendarEvents};
