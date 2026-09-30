const { buildMatchupOccurrenceKey, parseMatchupOccurrenceKey } = require('../matchups/matchupJobPolicy');
const { validateWeekBoundaries } = require('../matchups/matchupWeekPolicy');
const SEASON_FIELDS = Object.freeze({
 regularSeasonStartsAtMs:'regular_season_starts_at_ms', regularSeasonEndsAtMs:'regular_season_ends_at_ms',
 fantasyPlayoffsStartAtMs:'fantasy_playoffs_start_at_ms', fantasyPlayoffsEndAtMs:'fantasy_playoffs_end_at_ms',
});
const WEEK_FIELDS = Object.freeze({
 startsAtMs:'starts_at_ms', baselineAtMs:'baseline_at_ms', locksAtMs:'locks_at_ms',
 endsAtMs:'ends_at_ms', rollsOverAtMs:'rolls_over_at_ms',
});
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
function fail(message, code='LEAGUE_CALENDAR_CONFLICT') { throw Object.assign(new Error(message), {code}); }
function exact(value, keys) {
 if (!value || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join())
  fail('Enter the complete calendar and a reason.', 'LEAGUE_CALENDAR_INVALID');
}
function input(value) {
 exact(value,['calendar','weeks','reason']); exact(value.calendar,Object.keys(SEASON_FIELDS));
 if (!Object.values(value.calendar).every(validTime) || !Array.isArray(value.weeks) || value.weeks.length>100 ||
  typeof value.reason!=='string' || value.reason.trim().length<3 || value.reason.length>500 ||
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.reason))
  fail('Enter valid dates and a reason.', 'LEAGUE_CALENDAR_INVALID');
 const seen=new Set();
 const weeks=value.weeks.map(row=>{
  exact(row,['id',...Object.keys(WEEK_FIELDS)]);
  if(typeof row.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.id)||seen.has(row.id)||
   !Object.keys(WEEK_FIELDS).every(k=>validTime(row[k])))fail('Each week needs one valid set of dates.','LEAGUE_CALENDAR_INVALID');
  seen.add(row.id);try{validateWeekBoundaries(row);}catch{fail('Week dates must run from start, through baseline and lock, to end and rollover.','LEAGUE_CALENDAR_INVALID');}
  return {...row};
 });
 return {calendar:{...value.calendar},weeks:weeks.sort((a,b)=>a.id.localeCompare(b.id)),reason:value.reason.trim()};
}
function projectDates(row,fields) { return Object.fromEntries(Object.entries(fields).map(([key,column])=>[key,row[column]])); }
function calendar(s) { return {calendar:projectDates(s.season,SEASON_FIELDS),weeks:s.weeks.map(w=>({id:w.id,...projectDates(w,WEEK_FIELDS)}))}; }
function blockedReason(s) {
 return s.currentGeneration&&s.unfinishedDraft
  ? 'The matchup calendar is bound to unfinished Free Agent Draft processing. Use the draft timing or schedule recovery controls. Season calendar editing becomes available when the draft completes.' : null;
}
function plan(s,value,nowMs) {
 const proposed=input(value);
 if(blockedReason(s))fail(blockedReason(s));
 if(!s.season||!['planned','active'].includes(s.season.status)||!['setup','active','frozen'].includes(s.league.status))fail('Select an active or planned season.');
 const c=proposed.calendar;
 if(!(c.regularSeasonStartsAtMs<c.fantasyPlayoffsStartAtMs && c.fantasyPlayoffsStartAtMs<c.fantasyPlayoffsEndAtMs &&
  c.fantasyPlayoffsEndAtMs<=c.regularSeasonEndsAtMs))fail('Playoffs must fit inside the NHL season, after its start.');
 const requested=new Map(proposed.weeks.map(w=>[w.id,w]));
 if(proposed.weeks.some(w=>!s.weeks.some(old=>old.id===w.id)))fail('A selected week no longer belongs to this season.');
 const changes=[],jobChanges=[];
 const weeks=s.weeks.map(old=>{
  const next=requested.get(old.id)||{id:old.id,...projectDates(old,WEEK_FIELDS)};
  const fields=Object.keys(WEEK_FIELDS).filter(k=>old[WEEK_FIELDS[k]]!==next[k]);
  if(!fields.length)return next;
  if(!s.currentGeneration)fail('This schedule needs recovery before its dates can change.');
  if(!['scheduled','baseline_ready','live'].includes(old.status)||(s.resultWeekIds||[]).includes(old.id))fail('Week '+old.sequence+' has processed results. Use result correction or schedule recovery.');
  if(fields.includes('startsAtMs')&&old.sequence===1&&s.currentGeneration)
   fail('Week 1 start is tied to its draft and schedule history. Use the Free Agent Draft schedule recovery control.');
  for(const key of fields) {
   if(next[key]<=nowMs)fail('Week '+old.sequence+': choose a future boundary. Processed work cannot be replayed.');
   if(old[WEEK_FIELDS[key]]<=nowMs&&key!=='locksAtMs')fail('Week '+old.sequence+': a processed or elapsed boundary cannot move here. Use the existing recovery control.');
   if(['startsAtMs','baselineAtMs','locksAtMs'].includes(key)&&s.lockedWeekIds.includes(old.id))fail('Week '+old.sequence+' has roster locks; its start, baseline and lock are preserved.');
  }
  changes.push({id:old.id,sequence:old.sequence,fields,before:projectDates(old,WEEK_FIELDS),after:projectDates(next,Object.fromEntries(Object.keys(WEEK_FIELDS).map(k=>[k,k])))});
  const covered=new Set();
  for(const job of s.jobs.filter(j=>j.weekId===old.id)) {
   const slot=job.job_type==='matchup:statistics_refresh'?(job.scheduled_for_ms===old.starts_at_ms?'startsAtMs':job.scheduled_for_ms===old.ends_at_ms?'endsAtMs':null):
    ({'matchup:baseline':'baselineAtMs','matchup:lock':'locksAtMs','matchup:finalize':'endsAtMs','matchup:rollover':'rollsOverAtMs'})[job.job_type];
   if(!slot)fail('Week '+old.sequence+' has an inconsistent scheduled operation; use recovery.');
   if(!fields.includes(slot))continue;
   covered.add(slot);
   if(job.status!=='pending'||job.attempt_count!==0||job.lease_owner!==null||job.lease_token!=null||job.lease_expires_at_ms!=null||job.started_at_ms!==null||job.result_json!==null||job.last_error_code!=null)
    fail('Week '+old.sequence+' has work already claimed or attempted. Complete its recovery first.');
   let parsed;try{parsed=parseMatchupOccurrenceKey({jobType:job.job_type,leagueId:s.league.id,seasonId:s.season.id,occurrenceKey:job.occurrence_key,scheduledForMs:job.scheduled_for_ms});}catch{fail('A scheduled operation needs recovery.');}
   const scheduledForMs=next[slot];
   const occurrenceKey=parsed.scheduleOperationId===null
    ?job.job_type+':'+s.league.id+':'+s.season.id+':'+old.id+':'+scheduledForMs
    :buildMatchupOccurrenceKey({...parsed,scheduledForMs});
   jobChanges.push({id:job.id,version:job.version,previousScheduledForMs:job.scheduled_for_ms,previousOccurrenceKey:job.occurrence_key,scheduledForMs,occurrenceKey});
  }
  if(fields.some(k=>!covered.has(k)))fail('Week '+old.sequence+' is missing a scheduled operation. Use recovery before changing its dates.');
  return next;
 });
 const sorted=weeks.map(w=>({...w,sequence:s.weeks.find(old=>old.id===w.id).sequence})).sort((a,b)=>a.sequence-b.sequence);
 for(const [i,w]of sorted.entries()) {
  if(w.startsAtMs<c.regularSeasonStartsAtMs||w.endsAtMs>c.fantasyPlayoffsStartAtMs)fail('Regular-season matchup weeks must fit before playoffs. Adjust the affected weeks in the same preview.');
  if(i&&sorted[i-1].endsAtMs>w.startsAtMs)fail('Matchup weeks cannot overlap.');
 }
 const seasonFields=Object.keys(SEASON_FIELDS).filter(k=>s.season[SEASON_FIELDS[k]]!==c[k]);
 if(!seasonFields.length&&!changes.length)fail('Choose at least one different date.','LEAGUE_CALENDAR_UNCHANGED');
 if(s.openAuctions.some(a=>a.resolves_at_ms>=c.fantasyPlayoffsStartAtMs||a.resolves_at_ms>=c.regularSeasonEndsAtMs))
  fail('An open auction would close after the new auction-season boundary. Adjust that auction first.');
 return {proposed,changes,jobChanges,seasonFields,before:calendar(s),after:{calendar:c,weeks},
  recoversUnprocessedLock:changes.some(change=>change.fields.includes('locksAtMs')&&change.before.locksAtMs<=nowMs),
  reopensAuctions:s.season.fantasy_playoffs_start_at_ms<=nowMs&&c.fantasyPlayoffsStartAtMs>nowMs,
  closesAuctions:s.season.fantasy_playoffs_start_at_ms>nowMs&&c.fantasyPlayoffsStartAtMs<=nowMs};
}
module.exports={SEASON_FIELDS,WEEK_FIELDS,fail,input,projectDates,calendar,plan,blockedReason};
