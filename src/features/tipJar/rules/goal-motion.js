import {SHOT_Z,PUCK_ICE_HEIGHT,positionAt,clamp} from './shot-flight.js';
import {GOAL_Z,GOAL_HALF_WIDTH,GOAL_HEIGHT,POST_RADIUS,FRONT_CORNER_RADIUS,GOAL_BOTTOM_DEPTH,goalSection,goalBackDepth,goalRoofHeight} from './goal-layout.js';
export {GOAL_HALF_WIDTH,GOAL_HEIGHT} from './goal-layout.js';

// Match the rounded frame and cage in goal.js. This runs after stick contact;
// it does not change the shot's aim, power, tip assistance or target rules.
const STEP=.002;
const unit=v=>{const length=Math.hypot(v.x,v.y,v.z)||1;return {x:v.x/length,y:v.y/length,z:v.z/length};};
export function goalPlaneTime(shot){
  return shot.tipped?shot.contactTime+(shot.contact.z-GOAL_Z)/-shot.after.vz:(SHOT_Z-GOAL_Z)/shot.speed;
}
function surface(point,entered,includeFrame=true){
  const {x,y,z}=point;
  const horizontal=POST_RADIUS+.075,vertical=POST_RADIUS+.0225;
  const frame=(px,py,index)=>{
    const dx=x-px,dy=y-py,dz=z-GOAL_Z;
    return (dx*dx+dz*dz)/(horizontal*horizontal)+dy*dy/(vertical*vertical)<=1?
      {kind:'post',frame:index,normal:unit({x:dx/(horizontal*horizontal),y:dy/(vertical*vertical),z:dz/(horizontal*horizontal)})}:null;
  };
  // The puck is wider than it is tall. Rounded upper elbows share the exact
  // centreline used by the model instead of leaving invisible square corners.
  if(includeFrame)for(const side of [-1,1]){
    const cy=GOAL_HEIGHT-FRONT_CORNER_RADIUS,cx=GOAL_HALF_WIDTH-FRONT_CORNER_RADIUS;
    const post=frame(side*GOAL_HALF_WIDTH,clamp(y,POST_RADIUS,cy),side<0?0:1);if(post)return post;
    const angle=clamp(Math.atan2(y-cy,side*x-cx),0,Math.PI/2);
    const elbow=frame(side*(cx+FRONT_CORNER_RADIUS*Math.cos(angle)),cy+FRONT_CORNER_RADIUS*Math.sin(angle),angle>Math.PI/4?2:side<0?0:1);if(elbow)return elbow;
  }
  if(includeFrame){const bar=frame(clamp(x,-GOAL_HALF_WIDTH+FRONT_CORNER_RADIUS,GOAL_HALF_WIDTH-FRONT_CORNER_RADIUS),GOAL_HEIGHT,2);if(bar)return bar;}
  if(!entered||z>GOAL_Z)return null;
  if(Math.abs(x)>=GOAL_HALF_WIDTH-.075)return {kind:'net',normal:{x:-Math.sign(x),y:0,z:0}};
  const depth=GOAL_Z-z;
  if(depth>=goalBackDepth(x,y,.075)){
    const {width,radius}=goalSection(y),across=Math.max(0,Math.abs(x)-(width-radius));
    const back=Math.sqrt(Math.max(.0001,(radius-.075)**2-across**2));
    return {kind:'net',normal:unit({x:-Math.sign(x)*across/back,y:-.574,z:1})};
  }
  if(y>=goalRoofHeight(x,depth)-.0225)return {kind:'net',normal:{x:0,y:-1,z:0}};
  return null;
}

export function checkGoalCollision(shot,until){
  if(shot.goalieContact)return false;
  if(shot.level===1&&shot.frameContact&&shot.goalContact.kind==='post')return checkFrameRebound(shot,until);
  if(shot.goalContact||shot.bodyHit||!shot.tipChecked)return false;
  const planeTime=goalPlaneTime(shot),speed=shot.tipped?-shot.after.vz:shot.speed;
  const entry=positionAt(shot,planeTime);
  const entered=Math.abs(entry.x)<GOAL_HALF_WIDTH&&entry.y<GOAL_HEIGHT&&entry.y>=0;
  const first=Math.max(0,planeTime-.12/speed),last=planeTime+(GOAL_BOTTOM_DEPTH+.15)/speed;
  let t=shot.goalScan??first;
  while(t<=Math.min(until,last)+1e-10){
    const hit=surface(positionAt(shot,t),entered);
    if(hit){
      let lo=Math.max(first,t-STEP),hi=t;
      for(let i=0;i<12;i++){
        const mid=(lo+hi)/2;
        if(surface(positionAt(shot,mid),entered))hi=mid;else lo=mid;
      }
      const point=positionAt(shot,hi),contact=surface(point,entered)??hit;
      const earlier=positionAt(shot,Math.max(0,hi-.0001));
      const velocity={x:(point.x-earlier.x)/.0001,y:(point.y-earlier.y)/.0001,z:(point.z-earlier.z)/.0001};
      const n=contact.normal,dot=velocity.x*n.x+velocity.y*n.y+velocity.z*n.z;
      const bounce={x:(velocity.x-1.65*dot*n.x)*.72,y:(velocity.y-1.65*dot*n.y)*.55,z:(velocity.z-1.65*dot*n.z)*.72};
      // Arcade post rebounds clear the front of the goal instead of immediately
      // tunnelling through a second surface during the reload animation.
      if(shot.level!==1)bounce.z=Math.max(Math.abs(bounce.z),speed*.18);
      shot.goalContact={...contact,point,time:hi,bounce};
      if(shot.level===1&&contact.kind==='post'){
        shot.frameContact=shot.goalContact;
        if(bounce.z>=0||point.z+bounce.z/2>GOAL_Z-.075){shot.frameResolvedAt=hi;shot.reboundFinished=true;}
      }
      return true;
    }
    t+=STEP;
  }
  shot.goalScan=t;
  return false;
}

function postPosition(contact,elapsed){
  const t=elapsed-contact.time,p=contact.point,v=contact.bounce;
  const slide=(1-Math.exp(-t*2))/2;
  return {x:p.x+v.x*slide,y:Math.max(PUCK_ICE_HEIGHT,p.y+v.y*t-4.9*t*t),z:p.z+v.z*slide};
}

// A glancing Level 1 rebound is allowed to travel through the goal mouth.
// Head-on or outside-edge strikes still rebound out. Only a puck whose full
// radius crosses the line inside the opening counts. A slow puck can settle
// on the ice before reaching the back twine, which is still a valid goal.
function checkFrameRebound(shot,until){
  if(shot.reboundFinished)return false;
  const c=shot.frameContact,first=c.time+STEP,last=c.time+2.5;
  let t=shot.reboundScan??first;
  while(t<=Math.min(until,last)+1e-10){
    const point=postPosition(c,t);
    const inMouth=Math.abs(point.x)<GOAL_HALF_WIDTH-.075&&point.y<GOAL_HEIGHT-.0225;
    if(point.z<=GOAL_Z-.075&&inMouth&&shot.frameEnteredAt===undefined){
      shot.frameEnteredAt=t;shot.frameIn=true;shot.frameResolvedAt=t;
    }
    const hit=surface(point,shot.frameEnteredAt!==undefined||(point.z<=GOAL_Z&&inMouth),false);
    if(hit){
      let lo=Math.max(c.time,t-STEP),hi=t;
      for(let i=0;i<12;i++){
        const mid=(lo+hi)/2,p=postPosition(c,mid);
        if(surface(p,shot.frameEnteredAt!==undefined||(p.z<=GOAL_Z&&Math.abs(p.x)<GOAL_HALF_WIDTH&&p.y<GOAL_HEIGHT),false))hi=mid;else lo=mid;
      }
      shot.goalContact={...hit,point:postPosition(c,hi),time:hi};
      shot.frameResolvedAt??=hi;shot.reboundFinished=true;
      return true;
    }
    // A missed mouth cannot score merely by later crossing the side of the net.
    if(point.z<GOAL_Z-.075&&!inMouth){shot.frameResolvedAt??=t;shot.reboundFinished=true;return false;}
    t+=STEP;
  }
  shot.reboundScan=t;
  if(until>=last){shot.frameResolvedAt??=last;shot.reboundFinished=true;}
  return false;
}

export function frameResult(shot,cleared=[],elapsed=Infinity){
  if(shot.bodyHit)return elapsed>=shot.contactTime?{kind:'player-hit',target:-1,point:shot.contact}:null;
  const frame=shot.frameContact;
  if(frame){
    if(shot.frameResolvedAt===undefined||elapsed<shot.frameResolvedAt)return null;
    const target=frame.frame;
    const kind=!shot.tipped?'frame-direct':!shot.frameIn?'frame-out':cleared.includes(target)?'frame-repeat':'frame-target';
    return {kind,target,point:goalPositionAt(shot,Math.min(elapsed,shot.frameResolvedAt))};
  }
  const deadline=goalPlaneTime(shot)+.14/(shot.tipped?-shot.after.vz:shot.speed);
  if(!shot.tipChecked||elapsed<deadline)return null;
  return {kind:shot.tipped?'tip-miss':'miss',target:-1,point:positionAt(shot,goalPlaneTime(shot))};
}

export function goalSettleTime(shot){
  const c=shot.goalContact;
  if(!c)return Infinity;
  if(c.kind==='post')return c.time+(shot.level===1&&shot.frameIn?2.5:1.5);
  const fall=(Math.sqrt(.04+19.6*Math.max(0,c.point.y-PUCK_ICE_HEIGHT))-.2)/9.8;
  return c.time+Math.max(.16,fall+.10);
}

export function goalPositionAt(shot,elapsed){
  const c=shot.goalContact;
  if(shot.frameContact&&elapsed>shot.frameContact.time&&(!c||elapsed<=c.time))return postPosition(shot.frameContact,elapsed);
  if(!c||elapsed<=c.time)return positionAt(shot,elapsed);
  const t=elapsed-c.time,p=c.point;
  if(c.kind==='net'){
    // The net absorbs forward speed, gives a small soft recoil, then the puck
    // drops inside it. Its centre never passes through the back netting.
    const recoil=1-Math.exp(-t*8);
    return {x:p.x-Math.sign(p.x)*.035*recoil,y:Math.max(PUCK_ICE_HEIGHT,p.y-.2*t-4.9*t*t),z:p.z+.065*recoil};
  }
  return postPosition(c,elapsed);
}

export const pileSizeFor=count=>count<=0?0:count===1?1:count===2?2:count<=7?6:count<=15?14:36;
export function netPileLayout(count){
  const points=[[-.14,.025,-11.7],[.16,.025,-11.8],[-.35,.025,-11.82],[.36,.025,-11.57],[-.03,.071,-11.76],[.10,.025,-11.48]];
  for(let i=6;i<14;i++){
    const j=i-6;
    points.push([-.52+(j%4)*.31,j<4?.025:.071,-11.93+Math.floor(j/4)*.34]);
  }
  for(let i=14;i<36;i++){
    const j=i-14;
    points.push([-.66+(j%6)*.26+(Math.floor(j/6)%2)*.05,.025+(j>=18?.046:0),-11.56+Math.floor(j/6)*.31]);
  }
  return points.slice(0,pileSizeFor(count)).map(([x,y,z])=>[x*.90,y,GOAL_Z+(z-GOAL_Z)*.72]);
}
