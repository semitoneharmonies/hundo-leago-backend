const assert=require('node:assert/strict'),{test}=require('node:test');
const {defaultScoringWeights,calculateExpandedScore,emptyScoringStats}=require('../../src/domain/statistics/expandedScoringPolicy');
const {plan,ruleAt}=require('../../src/domain/leagues/leagueScoringPolicy');
const state=()=>({league:{status:'active'},season:{status:'active',nhl_season_key:'20262027'},rules:[],finalWeeks:[],
 weeks:[{id:'a',sequence:1,starts_at_ms:100,ends_at_ms:200,status:'live'},{id:'b',sequence:2,starts_at_ms:200,ends_at_ms:300,status:'scheduled'}]});
const proposed=()=>{const weights=defaultScoringWeights();weights.F.hits=5;weights.D.hits=10;return {weights,effectiveWeekSequence:2,comparisonWeekId:null,reason:'Reduce the hit weight'};};
test('custom weights change exact category totals for forwards and defence without mutating source counts',()=>{
 const stats={...emptyScoringStats(),hits:10,blockedShots:2,gameWinningGoals:1,giveaways:3};
 const before=structuredClone(stats),rule={version:'league-scoring-test',weights:proposed().weights};
 assert.equal(calculateExpandedScore(stats,'F',rule).fantasyPointsHundredths,160);
 assert.equal(calculateExpandedScore(stats,'D',rule).fantasyPointsHundredths,240);
 assert.equal(calculateExpandedScore(stats,'F').fantasyPointsHundredths,310);
 assert.deepEqual(stats,before);
 const invalid=structuredClone(rule);invalid.weights.F.hits=0.1;assert.throws(()=>calculateExpandedScore(stats,'F',invalid));
 delete invalid.weights.D.hits;assert.throws(()=>calculateExpandedScore(stats,'D',invalid));
});
test('completed or elapsed weeks cannot be changed and a live week remains a deliberate option',()=>{
 const s=state(),p=proposed();assert.equal(plan(s,{...p,effectiveWeekSequence:1},150).changes.length,2);
 assert.throws(()=>plan(s,{...p,effectiveWeekSequence:1},200),/unfinished/);
 s.finalWeeks=['b'];assert.throws(()=>plan(s,p,150),/unfinished/);
 s.finalWeeks=[];s.weeks[1].status='cancelled';assert.throws(()=>plan(s,p,150),/unfinished/);
});
test('effective-week precedence preserves later scheduled changes and other season defaults',()=>{
 const s=state(),p=proposed(),future=defaultScoringWeights();future.D.hits=90;
 s.rules=[{id:'later',revision:1,effective_week_sequence:2,weights_json:JSON.stringify(future)}];
 assert.equal(ruleAt(s.rules,1).weights.D.hits,35);
 assert.equal(ruleAt(s.rules,2).weights.D.hits,90);
 assert.equal(plan(s,{...p,effectiveWeekSequence:1},150).endsBeforeWeek,2);
 assert.equal(ruleAt([],2).weights.D.hits,35);
});
test('unscheduled leagues can set Week 1 without manufacturing matchup dates',()=>{
 const s=state();s.weeks=[];s.season.status='planned';s.league.status='setup';
 assert.equal(plan(s,{...proposed(),effectiveWeekSequence:1},150).proposed.effectiveWeekSequence,1);
 assert.deepEqual(s.weeks,[]);assert.throws(()=>plan(s,proposed(),150),/Week 1/);
});
