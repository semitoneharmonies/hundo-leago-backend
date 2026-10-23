export const PUCKS_PER_LEVEL=20;
export const CAMPAIGN_BEST_KEY='tipjar.best.campaign.v1';
export const LEVELS=Object.freeze([
  Object.freeze({number:1,title:'Off the iron.',objective:'Tip off the left post, right post and crossbar — and into the net.',count:3,label:'POSTS'}),
  Object.freeze({number:2,title:'Find all five.',objective:'Tip the puck into all five targets. Direct hits don’t count.',count:5,label:'TARGETS'}),
  Object.freeze({number:3,title:'Beat the goalie.',objective:'Clear all five targets. Watch the goalie’s repeating movement and find an opening.',count:5,label:'TARGETS'}),
]);
export const levelInfo=level=>LEVELS[Math.max(0,Math.min(2,(level??1)-1))];
export function freshCampaign(){return {level:1,pucks:PUCKS_PER_LEVEL,levelShots:0,failed:false,transition:null,results:[]};}
export function levelOutcome(state){
  // A winning last puck earns the next rack before the empty-rack check.
  if(new Set(state.cleared).size>=levelInfo(state.level).count)return state.level===3?'win':'advance';
  return state.pucks<=0?'lose':'playing';
}
export function advanceLevel(state){
  if(levelOutcome(state)!=='advance')return null;
  const carried=state.pucks,completed=state.level;
  state.results.push({level:completed,shots:state.levelShots,remaining:carried});
  state.level++;state.pucks+=PUCKS_PER_LEVEL;state.levelShots=0;state.cleared=[];
  state.transition={completed,carried,added:PUCKS_PER_LEVEL,total:state.pucks};
  return state.transition;
}
