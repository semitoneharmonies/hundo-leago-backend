import {tipperAt,stickContact,playerContact,TIPPER_Z} from './tipper.js';
import {GOAL_Z,GOAL_SCALE_X,GOAL_SCALE_Y,goalTargetDistance} from './goal-layout.js';
import {frameAssist} from './frame-objectives.js';
import {checkGoalCollision,frameResult} from './goal-motion.js';
import {checkGoalieCollision} from './goalie-motion.js';
import {SHOT_Z,GRAVITY,PUCK_ICE_HEIGHT,clamp,positionBeforeTip,positionAt} from './shot-flight.js';
export {SHOT_Z,GRAVITY,PUCK_ICE_HEIGHT,clamp,positionBeforeTip,positionAt} from './shot-flight.js';
export {FRAME_OBJECTIVES} from './frame-objectives.js';
export {GOAL_Z} from './goal-layout.js';
export {BLADE_HALF_LENGTH} from './tipper.js';
// Arcade deflection model. All positions are metres in the rink's coordinate space.
export const TIP_Z = TIPPER_Z;
export const MIN_POWER = 15;
export const CHARGE_SECONDS = .9;
export const CHARGE_TIME_SCALE = .45;
export const SHOT_RELEASE_SECONDS = .18;
export const DEFAULT_SHOT_HEIGHT = .16;
// One extra foot above the former ceiling and beyond each horizontal edge.
export const MIN_SHOT_HEIGHT = PUCK_ICE_HEIGHT;
export const MAX_SHOT_HEIGHT = 1.1298;
export const DIRECTION_RANGE = 1.4048;
export const TARGET_RADIUS = .31;
export const TARGET_ASSIST_RADIUS = .85;
// The 44 cm blade and its collision envelope share dimensions with the artwork.
export const TIP_STEERING = 8.2*GOAL_SCALE_X;
export const TARGETS = [
  { x: -1.46*GOAL_SCALE_X, y: 1.78*GOAL_SCALE_Y, name: 'Top left' },
  { x: 1.46*GOAL_SCALE_X, y: 1.78*GOAL_SCALE_Y, name: 'Top right' },
  { x: -1.46*GOAL_SCALE_X, y: .30*GOAL_SCALE_Y, name: 'Bottom left' },
  { x: 1.46*GOAL_SCALE_X, y: .30*GOAL_SCALE_Y, name: 'Bottom right' },
  { x: 0, y: .30*GOAL_SCALE_Y, name: 'Bottom centre' },
];
export const bladeAt = tipperAt;
export const powerForHold = seconds => {
  const phase=(Math.max(0,seconds)/CHARGE_SECONDS)%2;
  return MIN_POWER+(100-MIN_POWER)*(1-Math.abs(1-phase));
};
// Maximum error in metres at the teammate. Sample once on release, uniformly
// over the disk shown by the orange reticle; previews never consume randomness.
export const spreadFor = power => .06+.32*((clamp(power,MIN_POWER,100)-MIN_POWER)/(100-MIN_POWER))**2;
export function sampleShotSpread(power,random=Math.random){
  const radius=spreadFor(power)*Math.sqrt(random()),angle=random()*Math.PI*2;
  return {x:radius*Math.cos(angle),y:radius*Math.sin(angle)};
}
// Height is selected independently; a softer shot takes longer and therefore
// needs a larger arc to arrive at the same selected height.
export const heightFor = percent => MIN_SHOT_HEIGHT+clamp(percent,0,100)/100*(MAX_SHOT_HEIGHT-MIN_SHOT_HEIGHT);
export const speedFor = power => 5 + clamp(power,MIN_POWER,100) * .20;
export const travelTime = power => (SHOT_Z - TIP_Z) / speedFor(power);
export function createShot(direction, power, time, tipperTimeline=null, height=DEFAULT_SHOT_HEIGHT,scatter={x:0,y:0},level=2) {
  power = clamp(power,MIN_POWER,100);
  const aim={x:clamp(direction,-DIRECTION_RANGE,DIRECTION_RANGE),y:clamp(height,MIN_SHOT_HEIGHT,MAX_SHOT_HEIGHT)};
  const arrivalAim={x:aim.x+scatter.x,y:Math.max(PUCK_ICE_HEIGHT,aim.y+scatter.y)};
  const speed = speedFor(power), duration = travelTime(power);
  const flightHeight=arrivalAim.y<=PUCK_ICE_HEIGHT+.001?arrivalAim.y-.22*(100-power)/85:arrivalAim.y;
  return {
    releaseStart:time,start:time+SHOT_RELEASE_SECONDS, power, speed, duration, tipperTimeline,level, tipChecked:false, tipped:false, resolved:false,
    x:0, y:PUCK_ICE_HEIGHT, z:SHOT_Z, vx:arrivalAim.x/duration,
    vy:(flightHeight-PUCK_ICE_HEIGHT+.5*GRAVITY*duration*duration)/duration, vz:-speed,
    aim:{...aim},arrivalAim,scatter:{...scatter},spread:spreadFor(power), elapsed:0,
  };
}
// Scan moving geometry in small fixed time steps so even a low frame rate
// catches the blade while it swings out of the original tipping plane.
export function checkTip(shot,until=Infinity){
  if(shot.tipChecked)return shot.tipped;
  const first=(SHOT_Z-(TIP_Z+.50))/shot.speed,last=(SHOT_Z-(TIP_Z-1.90))/shot.speed;
  const end=Math.min(until,last),step=.003;
  let t=shot.contactScan??first;
  while(t<=end+1e-10){
    const point=positionBeforeTip(shot,t),pose=bladeAt(shot.start+t,shot.tipperTimeline);
    // Planted poses retain the exact plane test used for precise aiming.
    let hit=pose.transitioning?stickContact(point,pose):null;
    if(!pose.transitioning&&t>=shot.duration&&t-step<shot.duration){
      const exact=positionBeforeTip(shot,shot.duration),at=bladeAt(shot.start+shot.duration,shot.tipperTimeline);
      if(!at.transitioning){const c=stickContact(exact,at);if(c)return registerTip(shot,exact,shot.duration,c);}
    }
    if(hit)return registerTip(shot,point,t,hit);
    if(playerContact(point,pose)){
      shot.tipChecked=true;shot.bodyHit=true;shot.contact=point;shot.contactTime=t;
      shot.after={vx:-shot.vx*.15,vy:1.15,vz:shot.speed*.10};return false;
    }
    t+=step;
  }
  shot.contactScan=t;
  if(until>=last)shot.tipChecked=true;
  return false;
}
function registerTip(shot,point,time,contact){
  shot.tipChecked=true;shot.tipped=true;shot.contactKind=contact.kind;shot.contact=point;shot.contactTime=time;
  const remaining=(point.z-GOAL_Z)/(shot.speed*.78);
  let goalX=contact.worldOffset*TIP_STEERING;
  let goalY=clamp(.18+(point.y-.12)/.68*1.76,.18,1.86)*GOAL_SCALE_Y;
  const pointAtGoal={x:goalX,y:goalY};
  if(shot.level===1){
    const assisted=frameAssist(pointAtGoal);
    if(assisted){shot.assisted=true;shot.frameAim=assisted.index;goalX=assisted.x;goalY=assisted.y;}
  }else{
    const nearest=TARGETS.reduce((best,t)=>goalTargetDistance(pointAtGoal,t)<goalTargetDistance(pointAtGoal,best)?t:best);
    if(goalTargetDistance(pointAtGoal,nearest)<=TARGET_ASSIST_RADIUS){shot.assisted=true;goalX=nearest.x;goalY=nearest.y;}
  }
  shot.after={vx:(goalX-point.x)/remaining,vy:(goalY-point.y+.5*GRAVITY*remaining*remaining)/remaining,vz:-shot.speed*.78};
  return true;
}
export function goalResult(shot, cleared = []) {
  if(shot.goalieContact)return {kind:'goalie-save',target:-1,point:shot.goalieContact.point};
  if(shot.bodyHit)return {kind:'player-hit',target:-1,point:shot.contact};
  const elapsed = shot.tipped ? shot.contactTime+(shot.contact.z-GOAL_Z)/(-shot.after.vz) : (SHOT_Z-GOAL_Z)/shot.speed;
  const p=positionAt(shot,elapsed);
  const target=TARGETS.findIndex(t=>goalTargetDistance(p,t)<=TARGET_RADIUS);
  if (target>=0) return {kind:!shot.tipped?'direct':cleared.includes(target)?'repeat':'target', target, point:p};
  return {kind:shot.tipped?'tip-miss':'miss',target:-1,point:p};
}

// Predict an immediate release using the same flight and arrival-time contact
// as the real shot. Do not advance the live random side-switch timeline.
export function previewShot(direction,power,time,timeline,cleared=[],height=DEFAULT_SHOT_HEIGHT,level=2){
  let future=null;
  if(timeline){
    // The next switch is already scheduled. Any subsequent switch is at least
    // four seconds later, safely beyond this flight; never draw future randomness.
    future={...timeline,events:[...timeline.events],interval:()=>Infinity};
  }
  const shot=createShot(direction,power,time,future,height,{x:0,y:0},level);checkTip(shot);
  if(level===3)checkGoalieCollision(shot,Infinity);
  if(level===1)while(checkGoalCollision(shot,Infinity)){/* Resolve post and subsequent net contact. */}
  const result=level===1?frameResult(shot,cleared,Infinity):goalResult(shot,cleared);
  return {...result,tipped:shot.tipped,shot};
}
