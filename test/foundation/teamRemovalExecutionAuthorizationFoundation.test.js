'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {TARGET,assertApprovedExecution}=require('../../src/operations/teamRemovalExecutionAuthorization');
function input(){
 const fields={...TARGET,operation:'apply',nowMs:1000,wallClockMs:1000,manifestHash:'manifest',scopeHash:'scope',operationId:'operation',schema:63,buildId:'a'.repeat(40),codeHashes:{'teamRemovalExecutionAuthorization.js':'a'.repeat(64),'teamRemovalRecovery.js':'b'.repeat(64),'teamRemovalWriteFence.js':'c'.repeat(64)}};
 return {...fields,grant:{...fields,codeHashes:{...fields.codeHashes},format:'team-removal-execution-approval-v1',approved:true,approvedBy:'Graem',approvalReference:'test-only explicit instruction',operations:['apply','rollback'],issuedAtMs:900,expiresAtMs:10000}};
}
test('A complete scoped approval validates as data only; no database is opened',()=>{assert.equal(assertApprovedExecution(input()).authorized,true);});
for(const [name,mutate]of [
 ['missing approval',x=>delete x.grant],['pending approval',x=>x.grant.approved=false],['wrong approver',x=>x.grant.approvedBy='other'],['missing instruction',x=>x.grant.approvalReference=''],
 ['unapproved operation',x=>x.grant.operations=['rollback']],['unknown operation',x=>x.operation='reset'],['expired approval',x=>x.grant.expiresAtMs=999],['future approval',x=>x.grant.issuedAtMs=1001],['excessive window',x=>x.grant.expiresAtMs=99999999],
 ['fake execution clock',x=>x.nowMs=3000],['wrong environment',x=>x.environment='staging'],['wrong service',x=>x.serviceId='other'],['wrong database',x=>x.databasePath='/tmp/disposable.sqlite3'],['wrong approved target',x=>x.grant.databasePath='/tmp/other'],
 ['changed build',x=>x.buildId='b'.repeat(40)],['changed schema',x=>x.schema=64],['changed preview',x=>x.manifestHash='new'],['changed scope',x=>x.scopeHash='new'],['changed operation identity',x=>x.operationId='new'],
 ['changed operator code',x=>x.codeHashes['teamRemovalRecovery.js']='d'.repeat(64)],['missing code review',x=>delete x.grant.codeHashes],
])test('Execution refuses '+name,()=>{const x=input();mutate(x);assert.throws(()=>assertApprovedExecution(x),/EXECUTION_NOT_AUTHORIZED/);});
