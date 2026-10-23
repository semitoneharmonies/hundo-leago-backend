import {GOAL_HALF_WIDTH,GOAL_HEIGHT,FRONT_CORNER_RADIUS} from './goal-layout.js';

export const FRAME_OBJECTIVES=Object.freeze([
  Object.freeze({name:'Left post'}),
  Object.freeze({name:'Right post'}),
  Object.freeze({name:'Crossbar'}),
]);
// Level 1 offers a broad but bounded lane around the iron. The aim is brought
// to the inside edge of the tube; the collision solver must still produce a
// real frame contact and an inward rebound before an objective can count.
export const FRAME_ASSIST_RADIUS=.34;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function frameAssist(point){
  const w=GOAL_HALF_WIDTH,h=GOAL_HEIGHT;
  const candidates=[
    {index:0,x:-w,y:clamp(point.y,.16,h-FRONT_CORNER_RADIUS-.09)},
    {index:1,x:w,y:clamp(point.y,.16,h-FRONT_CORNER_RADIUS-.09)},
    {index:2,x:clamp(point.x,-w+.20,w-.20),y:h},
  ];
  const nearest=candidates.reduce((a,b)=>Math.hypot(point.x-a.x,point.y-a.y)<=Math.hypot(point.x-b.x,point.y-b.y)?a:b);
  if(Math.hypot(point.x-nearest.x,point.y-nearest.y)>FRAME_ASSIST_RADIUS)return null;
  return nearest.index===2?{index:2,x:nearest.x,y:h-.038}:
    {index:nearest.index,x:Math.sign(nearest.x)*(w-.088),y:nearest.y};
}
