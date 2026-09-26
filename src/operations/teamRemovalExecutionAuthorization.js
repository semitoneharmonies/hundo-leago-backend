'use strict';
const assert=require('node:assert/strict');

const TARGET=Object.freeze({environment:'production',serviceId:'srv-d4prd02dbo4c73bg95eg',databasePath:'/data/hundo-production-season2/candidate.sqlite3'});
function assertApprovedExecution({grant,operation,nowMs,wallClockMs,manifestHash,scopeHash,operationId,schema,environment,serviceId,databasePath,buildId,codeHashes}) {
  const reject=message=>assert(false,'EXECUTION_NOT_AUTHORIZED: '+message);
  if(!grant||grant.format!=='team-removal-execution-approval-v1'||grant.approved!==true)reject('explicit approval required');
  if(grant.approvedBy!=='Graem'||typeof grant.approvalReference!=='string'||grant.approvalReference.trim().length<8)reject('recorded user authorization required');
  if(!Array.isArray(grant.operations)||!grant.operations.includes(operation)||grant.operations.some(value=>!['apply','rollback'].includes(value)))reject('operation not approved');
  for(const key of ['issuedAtMs','expiresAtMs'])if(!Number.isSafeInteger(grant[key]))reject('invalid approval time');
  if(!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(wallClockMs)||Math.abs(wallClockMs-nowMs)>1000)reject('current wall clock required');
  if(nowMs<grant.issuedAtMs||nowMs>grant.expiresAtMs||grant.expiresAtMs<=grant.issuedAtMs||grant.expiresAtMs-grant.issuedAtMs>15*60000)reject('approval expired or outside bounded window');
  for(const [key,value]of Object.entries({environment,serviceId,databasePath}))if(value!==TARGET[key]||grant[key]!==TARGET[key])reject('wrong '+key);
  if(!/^[0-9a-f]{40}$/.test(buildId||'')||grant.buildId!==buildId)reject('deployed build mismatch');
  for(const [key,value]of Object.entries({manifestHash,scopeHash,operationId,schema}))if(grant[key]!==value)reject('changed '+key);
  const names=['teamRemovalExecutionAuthorization.js','teamRemovalRecovery.js','teamRemovalWriteFence.js'];
  if(!grant.codeHashes||Object.keys(grant.codeHashes).sort().join('|')!==names.join('|'))reject('exact reviewed operator code required');
  for(const name of names)if(!/^[0-9a-f]{64}$/.test(codeHashes[name]||'')||grant.codeHashes[name]!==codeHashes[name])reject('operator code changed');
  return Object.freeze({authorized:true,operation,manifestHash,approvalReference:grant.approvalReference});
}
module.exports={TARGET,assertApprovedExecution};
