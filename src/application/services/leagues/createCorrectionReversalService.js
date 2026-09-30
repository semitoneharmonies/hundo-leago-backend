const {randomUUID}=require('node:crypto');
const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {fail}=require('../../../infrastructure/persistence/sqlite/SqliteCorrectionReversalRepository');
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function createCorrectionReversalService({repository,corrections,leagueAuthorization,clock,lateLockCoordinator}){
 function authorize(auth,leagueId){const a=leagueAuthorization.requireCommissioner(auth,leagueId);if(!repository)fail('Correction reversal is unavailable.','CORRECTION_REVERSAL_UNAVAILABLE');return a;}
 function validate(v,apply=false){const keys=apply?['confirmed','correctionId','previewHash','reason']:['correctionId','reason'];if(!v||typeof v!=='object'||Object.keys(v).sort().join()!==keys.sort().join()||!ID.test(v.correctionId||'')||typeof v.reason!=='string'||v.reason.trim().length<3||v.reason.length>500||/[\u0000-\u001f\u007f]/.test(v.reason)||(apply&&(v.confirmed!==true||!/^[a-f0-9]{64}$/.test(v.previewHash||''))))fail('Review a correction and enter a reason.','CORRECTION_REVERSAL_INVALID');return {correctionId:v.correctionId,reason:v.reason.trim()};}
 function command(s,actor,proposed,confirm){const b=s.before,a=s.after,common={correctionId:randomUUID(),activityId:randomUUID(),leagueId:s.league.id,seasonId:s.source.season_id,playerId:a.playerId,expectedVersion:a.version,actorUserId:actor.actorUserId,actorMembershipId:actor.membershipId,actorAuthority:actor.authority,reason:proposed.reason,occurredAtMs:clock.nowMs(),confirmWarnings:confirm};
  return s.source.feature==='roster'?{...common,ownershipEventId:randomUUID(),ownershipId:a.id,correctedTeamId:b.teamId,correctedOwnershipKind:b.ownershipKind,correctedRosterCategory:b.rosterCategory,correctedPositionGroup:b.positionGroup,correctedSlotNumber:b.slotNumber}:{...common,contractEventId:randomUUID(),contractId:a.id,correctedTeamId:b.teamId,correctedContractType:b.contractType,correctedOriginalTotalValueCents:b.originalTotalValueCents,correctedOriginalTermYears:b.originalTermYears,correctedStartSeasonId:b.startSeasonId,correctedStatus:b.status,correctedAuctionBuyoutLockExpiresAtMs:b.auctionBuyoutLockExpiresAtMs,correctedYears:b.years.filter(y=>y.yearNumber<=b.originalTermYears).map(({id,seasonId,yearNumber,status,rolloverAtMs})=>({id,seasonId,yearNumber,status,rolloverAtMs}))};
 }
 function review(s,actor,proposed){const method=s.source.feature==='roster'?'previewRoster':'previewContract';const preview=corrections[method](command(s,actor,proposed,false));return {leagueId:s.league.id,correctionId:s.source.id,feature:s.source.feature,playerName:s.player.full_name,current:s.after,restore:s.before,warnings:preview.warnings,teamNames:s.privateState.teams.map(t=>({id:t.id,name:t.name})),capImpact:preview.teamEvaluations.map(e=>({teamId:e.teamId,cap:e.cap})),previewHash:digest({state:s,proposed,actorId:actor.actorUserId})};}
 return {
  read({leagueId,authenticated}){authorize(authenticated,leagueId);return {leagueId,corrections:repository.list(leagueId)};},
  preview({leagueId,authenticated,input}){const actor=authorize(authenticated,leagueId),proposed=validate(input);return repository.snapshot(()=>review(repository.state(leagueId,proposed.correctionId),actor,proposed));},
  async apply({leagueId,authenticated,input,idempotencyKey}){
   authorize(authenticated,leagueId);const proposed=validate(input,true);let key;try{key=clientKey(idempotencyKey);}catch{fail('A confirmation key is required.','CORRECTION_REVERSAL_INVALID');}
   let committed=null;
   const response=repository.transaction(()=>{
    const actor=authorize(authenticated,leagueId),requestHash=digest({proposed,previewHash:input.previewHash}),prior=repository.replay(leagueId,actor.actorUserId,key);
    if(prior){if(prior.action_type!=='reverse_correction'||prior.request_hash!==requestHash)fail('This confirmation key was used for another change.');return {leagueId,id:prior.id,correctionId:JSON.parse(prior.after_json).correctionId,replayed:true};}
    const state=repository.state(leagueId,proposed.correctionId),preview=review(state,actor,proposed);
    if(preview.previewHash!==input.previewHash)fail('The league changed. Review the reversal again.');
    const correction=command(state,actor,proposed,true),method=state.source.feature==='roster'?'applyRoster':'applyContract';
    const result=corrections[method](correction,{id:randomUUID(),key:'reverse-'+correction.correctionId,operation:state.source.feature==='roster'?'commissioner_roster_correction':'commissioner_contract_correction',requestHash,expiresAtMs:clock.nowMs()+86400000});
    const saved=repository.record({state,actor,reason:proposed.reason,key,requestHash,result,at:clock.nowMs()});committed={mutationKind:state.source.feature==='roster'?'commissioner_correction':'contract_correction',teams:result.committedRoster.teams};return saved;
   });
   if(committed){let lateLockStatus='awaiting_data';try{const lock=await lateLockCoordinator.coordinateCommittedRoster(committed);if(['awaiting_data','completed','not_applicable','still_illegal'].includes(lock?.status))lateLockStatus=lock.status;}catch{/* Existing late-lock recovery retains the saved correction. */}return {...response,lateLockStatus};}
   return response;
  },
 };
}
module.exports={createCorrectionReversalService};
