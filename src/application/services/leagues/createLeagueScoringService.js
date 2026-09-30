const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {fail,input,plan,ruleAt}=require('../../../domain/leagues/leagueScoringPolicy');
const {defaultScoringWeights}=require('../../../domain/statistics/expandedScoringPolicy');
function createLeagueScoringService({repository,leagueAuthorization,clock,scoringService,expandedScoringEnabled=false}) {
  function state(id) {if(!repository||!expandedScoringEnabled)fail('Scoring controls await expanded-statistics support.','LEAGUE_SCORING_UNAVAILABLE');return repository.state(id);}
  function project(s,administration) {
    const now=clock.nowMs(), sequence=Math.max(1,...s.weeks.filter(w=>w.starts_at_ms<=now).map(w=>w.sequence));
    return {leagueId:s.league.id,seasonId:s.season?.id||null,current:ruleAt(s.rules,sequence),defaults:defaultScoringWeights(),
      currentWeekSequence:sequence,serverNowMs:now,
      weeks:s.weeks.map(w=>({id:w.id,sequence:w.sequence,status:w.status,startsAtMs:w.starts_at_ms,endsAtMs:w.ends_at_ms,
        editable:!s.weeks.some(later=>later.sequence>=w.sequence&&(later.ends_at_ms<=now||s.finalWeeks.includes(later.id)||['final','cancelled'].includes(later.status)))})),
      rules:s.rules.map(r=>({id:r.id,revision:r.revision,effectiveWeekSequence:r.effective_week_sequence,weights:JSON.parse(r.weights_json),createdAtMs:r.created_at_ms,
        ...(administration?{reason:r.reason,actorName:r.actor_name}:{})}))};
  }
  function review(s,value,actorUserId) {
    const p=plan(s,value,clock.nowMs());
    const week=s.weeks.find(w=>p.proposed.comparisonWeekId?w.id===p.proposed.comparisonWeekId:w.sequence===p.proposed.effectiveWeekSequence);
    const impacts=week?repository.matchups(s.league.id,s.season.id,week.id).map(m=>{
      const basic={matchupId:m.id,homeName:m.home_name,awayName:m.away_name,status:m.status,
        officialHomeScore:m.home_score_hundredths??null,officialAwayScore:m.away_score_hundredths??null};
      const scope={leagueId:s.league.id,seasonId:s.season.id,weekId:week.id,matchupId:m.id,providers:['nhl-completed-games'],nowMs:clock.nowMs()};
      try {
        const before=scoringService.previewRule(scope,undefined),after=scoringService.previewRule(scope,{version:'preview',weights:p.proposed.weights});
        return {...basic,available:true,refreshId:after.source.refreshId,pendingGameCount:after.source.pendingGameCount||0,
          beforeHome:before.home.scoreHundredths,beforeAway:before.away.scoreHundredths,afterHome:after.home.scoreHundredths,afterAway:after.away.scoreHundredths};
      }catch(error){
        if(!String(error.code||'').startsWith('MATCHUP_SCORING_'))throw error;
        return {...basic,available:false,reason:'A complete scoring comparison is not available for this matchup yet.'};
      }
    }):[];
    return {...project(s,true),proposed:p.proposed,changes:p.changes,endsBeforeWeek:p.endsBeforeWeek,comparisonWeekSequence:week?.sequence||null,impacts,
      previewHash:digest({state:s,proposed:p.proposed,actorUserId,impacts})};
  }
  return {
    read({leagueId,authenticated}) {leagueAuthorization.requireCommissioner(authenticated,leagueId);return project(state(leagueId),true);},
    rules({leagueId,authenticated}) {leagueAuthorization.requireActiveMembership(authenticated,leagueId);return project(state(leagueId),false);},
    preview({leagueId,authenticated,input:value}) {const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);return review(state(leagueId),value,actor.actorUserId);},
    apply({leagueId,authenticated,input:value,idempotencyKey}) {
      leagueAuthorization.requireCommissioner(authenticated,leagueId);
      if(!value||Object.keys(value).sort().join()!=='comparisonWeekId,confirmed,effectiveWeekSequence,previewHash,reason,weights'||value.confirmed!==true||!/^[a-f0-9]{64}$/.test(value.previewHash||''))
        fail('Review the proposed scoring before confirming.','LEAGUE_SCORING_INVALID');
      const proposed=input({effectiveWeekSequence:value.effectiveWeekSequence,weights:value.weights,comparisonWeekId:value.comparisonWeekId,reason:value.reason});
      let key;try{key=clientKey(idempotencyKey);}catch{fail('A valid confirmation key is required.','LEAGUE_SCORING_INVALID');}
      if(!repository||!expandedScoringEnabled)state(leagueId);
      return repository.transaction(()=>{
        const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId),requestHash=digest({proposed,previewHash:value.previewHash});
        const prior=repository.replay(leagueId,actor.actorUserId,key);
        if(prior){if(prior.request_hash!==requestHash)fail('This confirmation was used for another change.');return{leagueId,id:prior.id,accepted:true,replayed:true};}
        const s=state(leagueId),preview=review(s,proposed,actor.actorUserId);
        if(preview.previewHash!==value.previewHash)fail('The league, results or statistics changed. Review again.','LEAGUE_SCORING_PREVIEW_CHANGED');
        const result=repository.apply({state:s,proposed,actorUserId:actor.actorUserId,authority:actor.authority,clientKey:key,requestHash,nowMs:clock.nowMs()});
        return{leagueId,id:result.id,accepted:true,replayed:false};
      });
    },
  };
}
module.exports={createLeagueScoringService};
