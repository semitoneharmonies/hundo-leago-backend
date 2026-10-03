const assert=require('node:assert/strict'),{test}=require('node:test');
const {input,plan,missingPickPlan}=require('../../src/domain/leagues/leaguePickRepairPolicy');
const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
function state(){return {league:{id:id(1),status:'active'},draft:{id:id(2),season_id:id(3),status:'ready',rounds:4},season:{status:'planned'},
  teams:[1,2,3,4].map(n=>({id:id(10+n),name:'Team '+n,status:'active'})),lottery:[],
  picks:[1,2,3,4].flatMap(round=>[1,2,3,4].filter(n=>!(n===4&&round===4)).map(n=>({original_team_id:id(10+n),current_owner_team_id:id(12),round_number:round,position_number:n,target_season_id:id(3),status:'unused'})))};}
const request=s=>({draftId:s.draft.id,reason:'Restore the missing pick',owners:missingPickPlan(s).map(p=>({teamId:p.teamId,round:p.round,ownerTeamId:id(12)}))});
test('repair adds only a missing record and permits an explicitly reviewed different current owner',()=>{
 const s=state(),before=structuredClone(s),result=plan(s,request(s));
 assert.equal(result.additions.length,1);assert.equal(result.preservedCount,15);assert.equal(result.additions[0].position,4);assert.equal(result.additions[0].ownerTeamId,id(12));assert.deepEqual(s,before);
});
test('recorded lottery order and first-round owner are used when a whole matrix is absent',()=>{
 const s=state();s.picks=[];assert.throws(()=>missingPickPlan(s),/lottery order/);
 s.lottery=s.teams.map((t,i)=>({original_team_id:t.id,final_draft_position:4-i,current_pick_owner_team_id:id(12)}));
 const missing=missingPickPlan(s);assert.equal(missing.length,16);assert.equal(missing[0].teamId,id(14));assert.equal(missing[0].ownerTeamId,id(12));assert.equal(missing[4].ownerTeamId,id(14));
});
test('unknown or inconsistent order, duplicate original picks and wrong seasons fail closed',()=>{
 let s=state();s.picks=s.picks.filter(p=>p.original_team_id!==id(14));assert.equal(missingPickPlan(s).length,4);
 s.picks=s.picks.filter(p=>p.original_team_id!==id(13));assert.throws(()=>missingPickPlan(s),/unknown/);
 s=state();s.picks[0].position_number=2;assert.throws(()=>missingPickPlan(s),/disagree/);
 s=state();s.picks.push({...s.picks[0]});assert.throws(()=>missingPickPlan(s),/inconsistent/);
 s=state();s.picks[0].target_season_id=id(99);assert.throws(()=>missingPickPlan(s),/inconsistent/);
});
test('active and completed drafts, removed owners and stale missing lists are refused',()=>{
 const s=state(),p=request(s);for(const status of ['active','completed','cancelled'])assert.throws(()=>plan({...s,draft:{...s.draft,status}},p),/before/);
 assert.throws(()=>plan(s,{...p,owners:[]}),/list changed/);assert.throws(()=>plan(s,{...p,owners:[{...p.owners[0],ownerTeamId:id(99)}]}),/current team/);
 s.teams[1].status='removed';assert.throws(()=>plan(s,p),/current team/);
});
test('malformed requests cannot insert arbitrary fields or duplicate reviewed picks',()=>{
 const p=request(state());assert.throws(()=>input({...p,privateBid:50}));assert.throws(()=>input({...p,owners:[...p.owners,...p.owners]}));
 assert.throws(()=>input({...p,reason:'bad\nreason'}));assert.deepEqual(input(p),p);
});
