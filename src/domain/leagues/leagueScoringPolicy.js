const {normalizeScoringWeights, defaultScoringWeights, EXPANDED_SCORING_VERSION, SCORING_CATEGORIES} = require('../statistics/expandedScoringPolicy');
function fail(message, code='LEAGUE_SCORING_CONFLICT') {const error=new Error(message); error.code=code; throw error;}
function input(value) {
  if (!value || Object.keys(value).sort().join()!=='comparisonWeekId,effectiveWeekSequence,reason,weights' ||
      !Number.isSafeInteger(value.effectiveWeekSequence) || value.effectiveWeekSequence<1 || value.effectiveWeekSequence>1000 ||
      !(value.comparisonWeekId===null || /^[a-f0-9-]{36}$/.test(value.comparisonWeekId)) ||
      typeof value.reason!=='string' || value.reason.trim().length<3 || value.reason.trim().length>500) {
    fail('Choose an effective week, complete scoring values and a reason.','LEAGUE_SCORING_INVALID');
  }
  let weights; try {weights=normalizeScoringWeights(value.weights);} catch(error) {fail(error.message,'LEAGUE_SCORING_INVALID');}
  return {effectiveWeekSequence:value.effectiveWeekSequence, weights, comparisonWeekId:value.comparisonWeekId, reason:value.reason.trim()};
}
function ruleAt(rules, sequence) {
  const row=rules.filter(r=>r.effective_week_sequence<=sequence).sort((a,b)=>b.effective_week_sequence-a.effective_week_sequence||b.revision-a.revision)[0];
  return row?{version:'league-scoring-'+row.id, weights:normalizeScoringWeights(JSON.parse(row.weights_json))}:{version:EXPANDED_SCORING_VERSION, weights:defaultScoringWeights()};
}
function plan(state,value,nowMs) {
  const proposed=input(value), {league,season,weeks,finalWeeks,rules}=state;
  if (!['setup','active','frozen'].includes(league.status) || !season || !['planned','active'].includes(season.status) || season.nhl_season_key!=='20262027')
    fail('Scoring changes require a current season using expanded statistics.');
  if (weeks.length && !weeks.some(w=>w.sequence===proposed.effectiveWeekSequence)) fail('The effective week is not in this season.');
  if (!weeks.length && proposed.effectiveWeekSequence!==1) fail('Before scheduling matchups, choose Week 1.');
  if (weeks.some(w=>w.sequence>=proposed.effectiveWeekSequence && (w.ends_at_ms<=nowMs || ['final','cancelled'].includes(w.status) || finalWeeks.includes(w.id))))
    fail('Choose an unfinished week. Completed results require the explicit result-correction controls.');
  if (proposed.comparisonWeekId!==null && !weeks.some(w=>w.id===proposed.comparisonWeekId)) fail('The comparison week is not in this season.');
  const before=ruleAt(rules,proposed.effectiveWeekSequence);
  if (JSON.stringify(before.weights)===JSON.stringify(proposed.weights)) fail('These values are already effective for that week.','LEAGUE_SCORING_UNCHANGED');
  const next=rules.filter(r=>r.effective_week_sequence>proposed.effectiveWeekSequence).sort((a,b)=>a.effective_week_sequence-b.effective_week_sequence)[0];
  return {proposed,before,endsBeforeWeek:next?.effective_week_sequence||null,
    changes:SCORING_CATEGORIES.flatMap(({key,label})=>['F','D'].filter(position=>before.weights[position][key]!==proposed.weights[position][key])
      .map(position=>({key,label,position,before:before.weights[position][key],after:proposed.weights[position][key]})))};
}
module.exports={fail,input,plan,ruleAt};
