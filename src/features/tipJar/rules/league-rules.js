import {createTipperTimeline} from './tipper.js';
import {createShot,checkTip,goalResult,sampleShotSpread,DIRECTION_RANGE,MIN_SHOT_HEIGHT,MAX_SHOT_HEIGHT,MIN_POWER} from './physics.js';
import {checkGoalCollision,goalPlaneTime,frameResult} from './goal-motion.js';
import {checkGoalieCollision} from './goalie-motion.js';
import {levelInfo,PUCKS_PER_LEVEL} from './campaign.js';

// This module and its pure dependencies are shipped unchanged to the API.
// Scores are derived from legal shot inputs, never from client-supplied totals.
export const RULESET_VERSION='campaign-v1';
export const MAX_RUN_SHOTS=60;
export const MAX_RUN_TIME=86400;
const RELOAD_SECONDS=1.25;

function randomFromSeed(seed){
  let value=seed>>>0;
  return ()=>{
    value=(value+0x6D2B79F5)>>>0;
    let t=value;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}
export function runRandomness(seed){
  if(!Number.isInteger(seed)||seed<0||seed>0xFFFFFFFF)throw new Error('Invalid run seed.');
  // Separate streams mean render/preview frequency cannot change shot spread.
  return {timeline:createTipperTimeline(randomFromSeed(seed^0xA13F920D)),shotRandom:randomFromSeed(seed^0x7B4C201F)};
}
export function validateShot(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid shot.');
  const {time,x,height,power}=input;
  if(Object.keys(input).some(key=>!['time','x','height','power'].includes(key))||
    ![time,x,height,power].every(Number.isFinite)||time<0||time>MAX_RUN_TIME||
    Math.abs(x)>DIRECTION_RANGE||height<MIN_SHOT_HEIGHT||height>MAX_SHOT_HEIGHT||power<MIN_POWER||power>100){
    throw new Error('Shot is outside the game controls.');
  }
  return {time,x,height,power};
}

export function resolveRecordedShot(input,level,cleared,timeline,shotRandom){
  const shot=createShot(input.x,input.power,input.time,timeline,input.height,sampleShotSpread(input.power,shotRandom),level);
  checkTip(shot);
  let result,at;
  if(shot.bodyHit){result={kind:'player-hit',target:-1};at=shot.contactTime;}
  else if(level===3&&checkGoalieCollision(shot,Infinity)){
    result={kind:'goalie-save',target:-1};at=shot.goalieContact.time;
  }else if(level===1){
    while(checkGoalCollision(shot,Infinity)){/* First the iron, then its rebound. */}
    result=frameResult(shot,cleared,Infinity);
    at=shot.frameResolvedAt??goalPlaneTime(shot)+.14/(shot.tipped?-shot.after.vz:shot.speed);
  }else{
    const plane=goalPlaneTime(shot);
    checkGoalCollision(shot,plane);
    result=shot.goalContact?.kind==='post'?{kind:'post',target:-1}:goalResult(shot,cleared);
    at=shot.goalContact?.kind==='post'?shot.goalContact.time:plane;
  }
  return {shot,result,readyAt:shot.start+at+(shot.bodyHit?.85:.30)+RELOAD_SECONDS};
}

export function verifyRun({seed,shots}){
  if(!Array.isArray(shots)||shots.length>MAX_RUN_SHOTS)throw new Error('Invalid shot transcript.');
  const {timeline,shotRandom}=runRandomness(seed);
  let level=1,pucks=PUCKS_PER_LEVEL,levelShots=0,readyAt=0,completed=false,failed=false;
  let highestLevelCompleted=0,shotsToCompletion=null,cleared=[];
  const levelResults=[];
  for(let index=0;index<shots.length;index++){
    if(completed||failed||pucks<=0)throw new Error('This run has already ended.');
    const input=validateShot(shots[index]);
    if(input.time+1e-7<readyAt)throw new Error('The shooter has not retrieved the next puck.');
    const resolved=resolveRecordedShot(input,level,cleared,timeline,shotRandom);
    readyAt=resolved.readyAt;levelShots++;pucks--;
    if(['frame-target','target'].includes(resolved.result.kind))cleared.push(resolved.result.target);
    if(cleared.length===levelInfo(level).count){
      highestLevelCompleted=level;shotsToCompletion=index+1;
      levelResults.push({level,shots:levelShots,totalShots:index+1});
      if(level===3)completed=true;
      else{level++;pucks+=PUCKS_PER_LEVEL;levelShots=0;cleared=[];}
    }else if(pucks===0)failed=true;
  }
  return {highestLevelCompleted,shotsToCompletion,shotsUsed:shots.length,level,pucks,completed,failed,levelResults};
}
