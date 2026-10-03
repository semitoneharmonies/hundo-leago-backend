const invalid=()=>{throw Object.assign(new Error('Enter a valid catalogue request.'),{code:'CATALOGUE_INVALID'});};
function createPlayerCatalogueControlService({repository,platformAuthorization,provider}){
 const authorize=authenticated=>platformAuthorization.requireAdministrator(authenticated).actorUserId;
 function input(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||typeof value.nhlId!=='string'||!/^[1-9]\d{0,12}$/.test(value.nhlId))invalid();return value;}
 return {
  read({authenticated,search=''}){authorize(authenticated);if(typeof search!=='string'||search.length>100)invalid();return repository.snapshot(()=>({players:search.trim()?repository.search(search.trim()):[],history:repository.history()}));},
  async preview({authenticated,input:value}){authorize(authenticated);input(value,['nhlId']);const row=await provider.lookup(value.nhlId);authorize(authenticated);return repository.snapshot(()=>repository.preview(row));},
  async apply({authenticated,input:value}){
   const actorId=authorize(authenticated);input(value,['nhlId','previewHash','operationId','reason']);
   if(typeof value.previewHash!=='string'||!/^[a-f0-9]{64}$/.test(value.previewHash)||typeof value.operationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.operationId)||typeof value.reason!=='string'||value.reason.trim().length<3||value.reason.length>500)invalid();
   const command={actorId,nhlId:value.nhlId,previewHash:value.previewHash,operationId:value.operationId,reason:value.reason.trim()};
   const prior=repository.replay(command);if(prior)return prior;
   const row=await provider.lookup(value.nhlId);
   return repository.apply(command,row,()=>authorize(authenticated));
  },
 };
}
module.exports={createPlayerCatalogueControlService};
