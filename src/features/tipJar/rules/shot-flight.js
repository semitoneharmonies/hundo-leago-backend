// Shared trajectories keep the live puck, goal collision scan and previews on
// the same path without a circular dependency between physics and goal motion.
export const SHOT_Z=4;
export const GRAVITY=5.4;
export const PUCK_ICE_HEIGHT=.025;
export const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export function positionBeforeTip(shot,t){
  return {x:shot.vx*t,y:Math.max(PUCK_ICE_HEIGHT,PUCK_ICE_HEIGHT+shot.vy*t-.5*GRAVITY*t*t),z:SHOT_Z-shot.speed*t};
}
export function positionAt(shot,elapsed){
  if((!shot.tipped&&!shot.bodyHit)||elapsed<=shot.contactTime)return positionBeforeTip(shot,elapsed);
  const t=elapsed-shot.contactTime,p=shot.contact,v=shot.after;
  return {x:p.x+v.vx*t,y:Math.max(PUCK_ICE_HEIGHT,p.y+v.vy*t-.5*GRAVITY*t*t),z:p.z+v.vz*t};
}
