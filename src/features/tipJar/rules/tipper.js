// One rigid-stick pose shared by the renderer and collision model.
export const TIPPER_Z = -6.5;
export const SWITCH_DURATION = .7;
export const STICK_HEEL = [1.20, -.64, 0];
export const BLADE_LIE = .235;
export const STICK_BLADE = [1.20+.22*Math.cos(BLADE_LIE), -.64+.22*Math.sin(BLADE_LIE), 0];
export const BLADE_HALF_LENGTH = .22;
export const STICK_SWEEP_SPEED = 1.25;
export const ICE_HOLD_SECONDS = .12;
export const BLADE_ICE_HEIGHT = .0365; // 35 mm blade half-height + bevel.
const PIVOT_HEIGHT=BLADE_ICE_HEIGHT+STICK_BLADE[0]*Math.sin(BLADE_LIE)-STICK_BLADE[1]*Math.cos(BLADE_LIE);
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
export function createTipperTimeline(random=Math.random) {
  const interval=()=>4+7*clamp(random(),0,1);
  return {events:[{at:0,side:1}],nextAt:interval(),interval};
}
export function tipperAt(time,timeline=null) {
  let event={at:0,side:1};
  if(timeline){
    while(timeline.nextAt<=time){
      const previous=timeline.events.at(-1);
      timeline.events.push({at:timeline.nextAt,side:-previous.side});
      timeline.nextAt+=timeline.interval();
    }
    for(let i=timeline.events.length-1;i>=0;i--)if(timeline.events[i].at<=time){event=timeline.events[i];break;}
  }
  const u=event.at===0?1:clamp((time-event.at)/SWITCH_DURATION,0,1);
  const ease=u*u*(3-2*u),blend=event.at===0?1:-event.side+2*event.side*ease;
  const period=2*Math.PI/STICK_SWEEP_SPEED,phase=((time%period)+period)%period;
  const onIce=phase<=ICE_HOLD_SECONDS;
  const swing=onIce?0:(phase-ICE_HOLD_SECONDS)/(period-ICE_HOLD_SECONDS)*2*Math.PI;
  const yaw=(1-blend)*Math.PI/2,angle=-BLADE_LIE+.60*(1-Math.cos(swing))/2;
  const angularVelocity=onIce?0:.30*Math.sin(swing)*2*Math.PI/(period-ICE_HOLD_SECONDS);
  const pivot={x:-1.40*blend,y:PIVOT_HEIGHT,z:TIPPER_Z};
  const transform=([x,y,z])=>{
    const rx=x*Math.cos(angle)-y*Math.sin(angle),ry=x*Math.sin(angle)+y*Math.cos(angle);
    return {x:pivot.x+Math.cos(yaw)*rx+Math.sin(yaw)*z,y:pivot.y+ry,z:pivot.z-Math.sin(yaw)*rx+Math.cos(yaw)*z};
  };
  const blade=transform(STICK_BLADE),heel=transform(STICK_HEEL);
  const lower=transform(STICK_HEEL.map(v=>v*.43));
  const axis={x:Math.cos(yaw)*Math.cos(angle+BLADE_LIE),y:Math.sin(angle+BLADE_LIE),z:-Math.sin(yaw)*Math.cos(angle+BLADE_LIE)};
  // Keep the torso behind the hands, including while turning across the net.
  // The stick's world-space pivot and sweep remain fixed; the skater steps
  // back from that plane instead of holding the shaft through his sweater.
  const bodyYaw=1.425*(1-blend)-.25;
  // A little extra room ahead of the chest and a step toward the lower hand
  // let the top elbow open outward without moving either contact surface.
  const actorX=-1.48*blend-.36*Math.sin(bodyYaw)+.16*Math.cos(bodyYaw);
  const actorZ=TIPPER_Z-.18+.15*(1-blend)-.36*Math.cos(bodyYaw)-.16*Math.sin(bodyYaw);
  return {...blade,pivot,heel,lower,axis,angle,yaw,side:event.side,blend,
    actorX,actorZ,bodyYaw,transitioning:u<1,active:true,
    onIce:onIce&&u===1,
    velocity:(STICK_BLADE[0]*Math.cos(angle)-STICK_BLADE[1]*Math.sin(angle))*angularVelocity,
    mode:u<1?'CHANGING SIDES':event.side===1?'FOREHAND':'BACKHAND'};
}
export function bladeContact(point,pose) {
  if(!pose.active)return null;
  const d={x:point.x-pose.x,y:point.y-pose.y,z:point.z-pose.z};
  const along=d.x*pose.axis.x+d.y*pose.axis.y+d.z*pose.axis.z;
  const perpendicular=Math.hypot(d.x-along*pose.axis.x,d.y-along*pose.axis.y,d.z-along*pose.axis.z);
  return Math.abs(along)<=BLADE_HALF_LENGTH+.055&&perpendicular<=.14 ? {kind:'blade',along,worldOffset:along*clamp(pose.axis.x/.35,-1,1)} : null;
}

// The exposed shaft below the lower glove is a second real contact surface.
// Use the same transformed endpoints as the rendered stick, including its yaw.
export function stickContact(point,pose) {
  const blade=bladeContact(point,pose);
  if(blade||!pose.active)return blade;
  const a={x:pose.pivot.x+(pose.heel.x-pose.pivot.x)*.49,y:pose.pivot.y+(pose.heel.y-pose.pivot.y)*.49,z:pose.pivot.z+(pose.heel.z-pose.pivot.z)*.49};
  const b=pose.heel,d={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};
  const length2=d.x*d.x+d.y*d.y+d.z*d.z;
  const t=clamp(((point.x-a.x)*d.x+(point.y-a.y)*d.y+(point.z-a.z)*d.z)/length2,0,1);
  const distance=Math.hypot(point.x-a.x-t*d.x,point.y-a.y-t*d.y,point.z-a.z-t*d.z);
  return distance<=.085?{kind:'shaft',along:t,worldOffset:(t-.5)*.44*clamp(pose.axis.x/.35,-1,1)}:null;
}

// Simple capsules follow the same root, crouch and grip locations as the rig.
export function playerContact(point,pose){
  // Add up to 5 cm of body forgiveness through the middle of a crossing,
  // fading smoothly to the planted hitbox at either side.
  const crossingPadding=pose.transitioning?.05*(1-pose.blend*pose.blend):0;
  const z=pose.actorZ,x=pose.actorX;
  const hip={x:x+.075*pose.blend,y:.65,z};
  const yaw=pose.bodyYaw;
  const chest={x:hip.x+Math.sin(yaw)*.13,y:1.10,z:z+Math.cos(yaw)*.13};
  const capsules=[
    [hip,chest,.21],
    [{...chest,y:1.30},{...chest,y:1.43},.13],
    ...[-1,1].map(side=>[{x:hip.x+side*.11,y:.60,z},{x:x+side*.32,y:.16,z:z+(side<0?-.12:.20)},.12]),
    [{x:chest.x+.19,y:1.08,z:chest.z},pose.pivot,.10],
    [{x:chest.x-.19,y:1.08,z:chest.z},pose.lower,.10],
  ];
  return capsules.some(([a,b,r])=>{
    const d={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},len=d.x*d.x+d.y*d.y+d.z*d.z;
    const t=clamp(((point.x-a.x)*d.x+(point.y-a.y)*d.y+(point.z-a.z)*d.z)/len,0,1);
    return Math.hypot(point.x-a.x-t*d.x,point.y-a.y-t*d.y,point.z-a.z-t*d.z)<=r+.045+crossingPadding;
  });
}
