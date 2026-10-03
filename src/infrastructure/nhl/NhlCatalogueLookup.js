const {createHash}=require('node:crypto');
function invalid(){throw Object.assign(new Error('The NHL player could not be verified.'),{code:'CATALOGUE_PROVIDER_UNAVAILABLE'});}
function normalizeNhlCataloguePlayer(value,id){
 const name=v=>typeof v?.default==='string'?v.default.trim():'';
 const firstName=name(value?.firstName),lastName=name(value?.lastName);
 if(String(value?.playerId)!==id||!firstName||!lastName||firstName.length>100||lastName.length>100||
  /[\u0000-\u001f\u007f]/.test(firstName+lastName)||typeof value.isActive!=='boolean'||
  !['C','L','R','LW','RW','D'].includes(value.position)||!/^\d{4}-\d{2}-\d{2}$/.test(value.birthDate||'')||
  new Date(value.birthDate).toISOString().slice(0,10)!==value.birthDate||
  (value.currentTeamAbbrev!=null&&!/^[A-Z]{2,3}$/.test(value.currentTeamAbbrev)))invalid();
 const row={providerPlayerId:id,firstName,lastName,fullName:`${firstName} ${lastName}`,birthDate:value.birthDate,
  status:value.isActive?'active':'historical',sourcePosition:value.position,normalizedPosition:value.position==='D'?'D':'F',
  nhlTeamAbbreviation:value.currentTeamAbbrev||null,active:value.isActive};
 return {...row,sourceVersion:createHash('sha256').update(JSON.stringify(row)).digest('hex')};
}
function createNhlCatalogueLookup({fetchImpl=fetch,timeoutMs=6000}={}){
 let running=0;
 return {async lookup(id){
  if(!/^[1-9]\d{0,12}$/.test(id)||running>=2)invalid();
  running++;const controller=new AbortController();let timer;
  try{return await Promise.race([(async()=>{
   const response=await fetchImpl(`https://api-web.nhle.com/v1/player/${id}/landing`,{signal:controller.signal,redirect:'error',headers:{Accept:'application/json'}});
   if(!response.ok)invalid();const body=await response.text();if(body.length>1_000_000)invalid();
   return normalizeNhlCataloguePlayer(JSON.parse(body),id);
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('NHL lookup timed out.'),{code:'CATALOGUE_PROVIDER_UNAVAILABLE'}));},timeoutMs);})]);}
  catch {invalid();}finally{clearTimeout(timer);running--;}
 }};
}
module.exports={createNhlCatalogueLookup,normalizeNhlCataloguePlayer};
