// Shared proportions from the supplied 6 ft x 4 ft goal reference. Coordinates
// are metres; renderer, target placement and net collisions all use this cage.
export const GOAL_Z=-11;
export const GOAL_HALF_WIDTH=.915;
export const GOAL_HEIGHT=1.22;
export const POST_RADIUS=.0254;
export const FRONT_CORNER_RADIUS=.075;
export const GOAL_BOTTOM_DEPTH=1.02;
export const GOAL_TOP_DEPTH=.32;
export const GOAL_BOTTOM_RADIUS=.35;
export const GOAL_TOP_RADIUS=.28;
// Normalize existing target forgiveness to the smaller physical opening.
export const GOAL_SCALE_X=GOAL_HALF_WIDTH/1.83;
export const GOAL_SCALE_Y=GOAL_HEIGHT/2.1;
export const TARGET_RING_RADIUS=.14;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function goalSection(y){
  const t=clamp(y/GOAL_HEIGHT,0,1);
  return {width:GOAL_HALF_WIDTH,depth:GOAL_BOTTOM_DEPTH+(GOAL_TOP_DEPTH-GOAL_BOTTOM_DEPTH)*t,
    radius:GOAL_BOTTOM_RADIUS+(GOAL_TOP_RADIUS-GOAL_BOTTOM_RADIUS)*t};
}
// Rounded U-shaped perimeter, open at the goal line. Arc-length parameter u
// runs from the left post around the back of the cage to the right post.
export function goalRimAt(u,y){
  const {width,depth,radius}=goalSection(y),side=depth-radius,back=2*(width-radius),arc=Math.PI*radius/2;
  let d=clamp(u,0,1)*(2*side+2*arc+back),x,z;
  if(d<=side){x=-width;z=d;}
  else if((d-=side)<=arc){const a=d/radius;x=-width+radius-radius*Math.cos(a);z=side+radius*Math.sin(a);}
  else if((d-=arc)<=back){x=-width+radius+d;z=depth;}
  else if((d-=back)<=arc){const a=d/radius;x=width-radius+radius*Math.sin(a);z=side+radius*Math.cos(a);}
  else{x=width;z=side-(d-arc);}
  return {x,y,z:GOAL_Z-z};
}
// Insetting by the puck radius gives a rounded collision surface rather than
// treating the cage as a rectangular box. Returns depth behind the goal line.
export function goalBackDepth(x,y,inset=0){
  const section=goalSection(y),width=section.width-inset,depth=section.depth-inset,radius=section.radius-inset;
  const a=Math.abs(x),corner=width-radius;
  if(a>width)return -Infinity;
  return a<=corner?depth:depth-radius+Math.sqrt(Math.max(0,radius*radius-(a-corner)**2));
}
export function goalRoofHeight(x,depth){
  const back=goalBackDepth(x,GOAL_HEIGHT);
  const sag=.008*Math.sin(Math.PI*clamp(depth/Math.max(.001,back),0,1))*(1-(x/GOAL_HALF_WIDTH)**2);
  return GOAL_HEIGHT-.008-sag;
}
export const goalTargetDistance=(point,target)=>Math.hypot((point.x-target.x)/GOAL_SCALE_X,(point.y-target.y)/GOAL_SCALE_Y);
