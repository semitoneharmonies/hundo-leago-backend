const assert=require('node:assert/strict'),{test}=require('node:test');
const {input,plan}=require('../../src/domain/leagues/leaguePausePolicy');
const state=()=>({league:{status:'active'},freeze:null,originalStatus:null,busyJobs:[],jobs:[{scheduledForMs:100,nextAttemptAtMs:null}],auctions:[{resolvesAtMs:200}],proposals:[{deadlineAtMs:300}]});
test('pause preview retains times and distinguishes the exact due boundaries',()=>{
 const s=state(),before=structuredClone(s);assert.equal(plan(s,{action:'pause',reason:'Review schedule'},99).overdue,false);
 const p=plan(s,{action:'pause',reason:'Review schedule'},300);assert.equal(p.impacts.dueJobs,1);assert.equal(p.impacts.dueAuctions,1);assert.equal(p.impacts.expiredProposals,1);assert.deepEqual(s,before);
});
test('pause refuses even expired running operations until supported recovery completes',()=>{
 const s=state();s.busyJobs=[{status:'running',leaseExpiresAtMs:1}];assert.throws(()=>plan(s,{action:'pause',reason:'Review'},100),/in progress/);
});
test('resume requires an evidenced original operating state',()=>{
 const s=state();s.league.status='frozen';s.freeze={id:'freeze'};assert.throws(()=>plan(s,{action:'resume',reason:'Reviewed'},100),/original operating state/);
 s.originalStatus='setup';assert.equal(plan(s,{action:'resume',reason:'Reviewed'},100).restoredStatus,'setup');
 assert.throws(()=>plan(s,{action:'pause',reason:'Reviewed'},100),/already paused/);
});
test('unknown fields and invalid reasons cannot reach a pause writer',()=>{
 assert.throws(()=>input({action:'pause',reason:'x'}));assert.throws(()=>input({action:'reset',reason:'Review'}));assert.throws(()=>input({action:'pause',reason:'Review',shiftAllClocks:true}));
});
