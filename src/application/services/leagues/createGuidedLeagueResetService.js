const {randomUUID}=require('node:crypto');
const {digest,clientKey}=require('../../../domain/leagues/leagueCommunicationPolicy');
const {fail}=require('../../../operations/guidedLeagueReset');
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function createGuidedLeagueResetService({repository,cipher,leagueAuthorization,clock}){
 function authorize(authenticated,leagueId){const actor=leagueAuthorization.requireCommissioner(authenticated,leagueId);if(!repository)fail('Guided reset controls are unavailable.','LEAGUE_RESET_UNAVAILABLE');return actor;}
 function validate(value,apply=false){const keys=apply?['action','archiveId','confirmation','previewHash','reason']:['action','archiveId','reason'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.sort().join()||!['reset','restore'].includes(value.action)||
   (value.action==='reset'?value.archiveId!==null:!ID.test(value.archiveId||''))||typeof value.reason!=='string'||value.reason.trim().length<3||value.reason.length>500||/[\u0000-\u001f\u007f]/.test(value.reason)||
   (apply&&(typeof value.confirmation!=='string'||!/^[a-f0-9]{64}$/.test(value.previewHash||''))))fail('Review the reset or restore and enter a reason.','LEAGUE_RESET_INVALID');
  return {action:value.action,archiveId:value.archiveId,reason:value.reason.trim()};
 }
 function review(leagueId,actor,proposed,at){
  if(proposed.action==='reset'){
   const proof=repository.rehearse(leagueId,actor.actorUserId,at),confirmation='RESET '+proof.manifest.leagueName;
   return {proof,response:{leagueId,action:'reset',archiveId:null,manifest:proof.manifest,recoveryVerified:true,confirmation,previewHash:digest({proposed,beforeHash:proof.beforeHash,actorId:actor.actorUserId})}};
  }
  const archive=repository.archive(leagueId,proposed.archiveId);if(!archive)fail('The recovery archive was not found.','LEAGUE_RESET_NOT_FOUND');if(repository.restored(leagueId,archive.id))fail('This archive was already restored.');
  const snapshot=cipher.open(archive);repository.rehearseRestore(snapshot,archive.after_hash);const manifest=JSON.parse(archive.manifest_json);
  return {archive,snapshot,response:{leagueId,action:'restore',archiveId:archive.id,manifest,recoveryVerified:true,confirmation:'RESTORE '+manifest.leagueName,previewHash:digest({proposed,afterHash:archive.after_hash,actorId:actor.actorUserId})}};
 }
 return {
  read({leagueId,authenticated}){authorize(authenticated,leagueId);return repository.snapshot(()=>repository.read(leagueId,clock.nowMs()));},
  preview({leagueId,authenticated,input}){const actor=authorize(authenticated,leagueId),proposed=validate(input);return repository.snapshot(()=>review(leagueId,actor,proposed,clock.nowMs()).response);},
  apply({leagueId,authenticated,input,idempotencyKey}){
   authorize(authenticated,leagueId);const proposed=validate(input,true);let key;try{key=clientKey(idempotencyKey);}catch{fail('A confirmation key is required.','LEAGUE_RESET_INVALID');}
   return repository.transaction(()=>{
    const actor=authorize(authenticated,leagueId),at=clock.nowMs(),requestHash=digest({proposed,confirmation:input.confirmation,previewHash:input.previewHash}),prior=repository.replay(leagueId,actor.actorUserId,key);
    if(prior){if(prior.request_hash!==requestHash||prior.action_type!==proposed.action)fail('This confirmation key was used for another change.');return {leagueId,id:prior.id,archiveId:prior.archive_id,action:prior.action_type,replayed:true,recoveryVerified:true};}
    const checked=review(leagueId,actor,proposed,at);if(checked.response.previewHash!==input.previewHash||checked.response.confirmation!==input.confirmation)fail('The league changed or the confirmation does not match. Review again.');
    const archiveId=proposed.action==='reset'?randomUUID():proposed.archiveId;
    if(proposed.action==='reset'){
     const sealed=cipher.seal({snapshot:checked.proof.snapshot,archiveId});
     const recovered=cipher.open({id:archiveId,league_id:leagueId,key_version:sealed.keyVersion,nonce:sealed.nonce,ciphertext:sealed.ciphertext,authentication_tag:sealed.authenticationTag});
     if(digest(recovered)!==digest(checked.proof.snapshot))fail('The recovery archive could not be verified.','LEAGUE_RESET_ARCHIVE_UNAVAILABLE');
     repository.reset({review:checked.proof,archiveId,sealed,actor,at});
    }else repository.restore({archive:checked.archive,snapshot:checked.snapshot});
    return repository.record({leagueId,archiveId,actor,action:proposed.action,key,requestHash,reason:proposed.reason,at});
   });
  },
 };
}
module.exports={createGuidedLeagueResetService};
