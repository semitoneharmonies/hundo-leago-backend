import {GOAL_Z} from './goal-layout.js';
import {SHOT_Z,PUCK_ICE_HEIGHT,positionAt} from './shot-flight.js';

export const GOALIE_PERIOD=9.6;
export const GOALIE_Z=GOAL_Z+.55;
const STEP=.002;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// One visible, repeatable shuffle and butterfly cycle. Nothing in this motion
// reads aim, power, target progress or randomness, so the openings can be learnt.
export function goaliePoseAt(time){
  const phase=time/GOALIE_PERIOD*Math.PI*2;
  const x=.61*Math.sin(phase),butterfly=(1+Math.cos(phase))/2;
  const b=butterfly,world=(px,y,z=0)=>({x:x+px,y,z:GOALIE_Z+z});
  const hip=world(0,.71-.27*b,-.055),head=world(0,1.43-.34*b,.075);
  const torso=world(0,1.01-.30*b,.04);
  const pads=[-1,1].map(side=>({side,
    ankle:world(side*(.26+.20*b),.12,.21),
    knee:world(side*(.22-.14*b),.64-.41*b,.26),
    foot:world(side*(.26+.20*b),.10,.12),
    bodyKnee:world(side*(.24-.11*b),.49-.23*b,.10),
    width:.30,depth:.17,
  }));
  const glove=world(.43,1.06-.34*b,.24),blocker=world(-.43,.90-.22*b,.27);
  const arms=[{side:'L',shoulder:world(.23,1.22-.31*b),elbow:world(.39,.91-.23*b,.08),hand:glove},
    {side:'R',shoulder:world(-.23,1.22-.31*b),elbow:world(-.41,.91-.25*b,.05),hand:blocker}];
  const stick={top:world(-.43,1.01-.22*b,.27),heel:world(-.10,.065,.45),toe:world(.33,.04,.45)};
  return {time,x,z:GOALIE_Z,butterfly,hip,head,torso,pads,arms,glove,blocker,stick,
    lean:.13+.17*b,skateYaw:.10+.75*b};
}

const ellipsoid=(point,centre,radii)=>{
  const delta={x:point.x-centre.x,y:point.y-centre.y,z:point.z-centre.z};
  const d=(delta.x/radii[0])**2+(delta.y/radii[1])**2+(delta.z/radii[2])**2;
  if(d>1)return null;
  const n={x:delta.x/(radii[0]**2),y:delta.y/(radii[1]**2),z:delta.z/(radii[2]**2)},length=Math.hypot(n.x,n.y,n.z)||1;
  return {x:n.x/length,y:n.y/length,z:n.z/length};
};
const segmentNormal=(p,a,b,radius,verticalScale=1)=>{
  const dx=b.x-a.x,dy=(b.y-a.y)/verticalScale,dz=b.z-a.z;
  const px=p.x-a.x,py=(p.y-a.y)/verticalScale,pz=p.z-a.z;
  const t=clamp((px*dx+py*dy+pz*dz)/(dx*dx+dy*dy+dz*dz||1),0,1);
  const n={x:px-dx*t,y:(py-dy*t)/verticalScale,z:pz-dz*t},distance=Math.hypot(n.x,n.y*verticalScale,n.z);
  if(distance>radius)return null;
  const length=Math.hypot(n.x,n.y,n.z)||1;return {x:n.x/length,y:n.y/length,z:n.z/length};
};

export function goalieContactAt(point,time){
  const pose=goaliePoseAt(time);
  if(Math.abs(point.x-pose.x)>.90||point.y>1.70||Math.abs(point.z-GOALIE_Z)>.68)return null;
  const candidates=[
    ['jersey',ellipsoid(point,pose.torso,[.29,.34,.22])],
    ['pants',ellipsoid(point,pose.hip,[.29,.21,.22])],
    ['mask',ellipsoid(point,pose.head,[.16,.17,.19])],
    ['catcher',ellipsoid(point,pose.glove,[.21,.21,.14])],
    ['blocker',ellipsoid(point,pose.blocker,[.18,.23,.14])],
  ];
  for(const pad of pose.pads){
    // Transform to the pad's long axis. Flat front faces and rounded ends match
    // the protective gear; the extra 75/25 mm is the puck's half width/height.
    const axis={x:pad.knee.x-pad.ankle.x,y:pad.knee.y-pad.ankle.y,z:pad.knee.z-pad.ankle.z};
    const length=Math.hypot(axis.x,axis.y,axis.z),up={x:axis.x/length,y:axis.y/length,z:axis.z/length};
    const side={x:up.y,y:-up.x,z:0},sideLength=Math.hypot(side.x,side.y);side.x/=sideLength;side.y/=sideLength;
    const forward={x:-up.z*side.y,y:up.z*side.x,z:up.x*side.y-up.y*side.x};
    const relative={x:point.x-pad.ankle.x,y:point.y-pad.ankle.y,z:point.z-pad.ankle.z};
    const along=relative.x*up.x+relative.y*up.y+relative.z*up.z;
    const across=relative.x*side.x+relative.y*side.y;
    const depth=relative.x*forward.x+relative.y*forward.y+relative.z*forward.z;
    if(along>=-.07&&along<=length+.07&&Math.abs(across)<pad.width/2+.05&&Math.abs(depth)<pad.depth/2+.055)
      candidates.push(['pad',{x:0,y:.10,z:1}]);
  }
  for(const arm of pose.arms){
    candidates.push(['sleeve',segmentNormal(point,arm.shoulder,arm.elbow,.13)]);
    candidates.push(['sleeve',segmentNormal(point,arm.elbow,arm.hand,.12)]);
  }
  candidates.push(['stick',segmentNormal(point,pose.stick.heel,pose.stick.toe,.065,.45)]);
  candidates.push(['paddle',segmentNormal(point,pose.stick.heel,{
    x:pose.stick.heel.x+(pose.stick.top.x-pose.stick.heel.x)*.45,
    y:pose.stick.heel.y+(pose.stick.top.y-pose.stick.heel.y)*.45,
    z:pose.stick.heel.z+(pose.stick.top.z-pose.stick.heel.z)*.45,
  },.072)]);
  for(const [part,normal] of candidates)if(normal)return {kind:'goalie',part,normal,pose};
  return null;
}

export function checkGoalieCollision(shot,until){
  if(shot.goalieContact||shot.bodyHit||shot.goalContact||!shot.tipChecked)return false;
  const contactTime=shot.tipped?shot.contactTime:0,speed=shot.tipped?-shot.after.vz:shot.speed;
  const origin=shot.tipped?shot.contact.z:SHOT_Z;
  const first=Math.max(contactTime,contactTime+(origin-(GOALIE_Z+.68))/speed);
  const last=contactTime+(origin-(GOALIE_Z-.45))/speed;
  let t=shot.goalieScan??first;
  while(t<=Math.min(until,last)+1e-10){
    const hit=goalieContactAt(positionAt(shot,t),shot.start+t);
    if(hit){
      let lo=Math.max(first,t-STEP),hi=t;
      for(let i=0;i<12;i++){
        const mid=(lo+hi)/2;
        if(goalieContactAt(positionAt(shot,mid),shot.start+mid))hi=mid;else lo=mid;
      }
      const point=positionAt(shot,hi),resolved=goalieContactAt(point,shot.start+hi)??hit;
      const before=positionAt(shot,Math.max(0,hi-.0001));
      const vx=(point.x-before.x)/.0001,vy=(point.y-before.y)/.0001;
      // Goalie gear absorbs most energy. The rebound heads back into the crease
      // and cannot continue through the goalkeeper to claim a target.
      shot.goalieContact={kind:'goalie',part:resolved.part,point,time:hi,normal:resolved.normal,
        bounce:{x:vx*.10+(point.x-resolved.pose.x)*.8,y:Math.max(.2,Math.min(1.3,vy*.12+.7)),z:speed*.18}};
      return true;
    }
    t+=STEP;
  }
  shot.goalieScan=t;return false;
}

export function goaliePositionAt(shot,elapsed){
  const c=shot.goalieContact;
  if(!c||elapsed<=c.time)return positionAt(shot,elapsed);
  const t=elapsed-c.time,slide=(1-Math.exp(-t*2.4))/2.4,p=c.point,v=c.bounce;
  return {x:p.x+v.x*slide,y:Math.max(PUCK_ICE_HEIGHT,p.y+v.y*t-4.9*t*t),z:p.z+v.z*slide};
}
export const goalieSettleTime=shot=>shot.goalieContact?shot.goalieContact.time+1.6:Infinity;
