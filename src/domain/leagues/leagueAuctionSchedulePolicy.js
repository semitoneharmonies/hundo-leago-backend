const {getAuctionCreationWindow}=require('../auctions/auctionCreationPolicy');
function fail(message,code='LEAGUE_AUCTION_SCHEDULE_CONFLICT'){throw Object.assign(new Error(message),{code});}
function input(value){
 if(!value||Array.isArray(value)||Object.keys(value).sort().join()!=='closeMinuteOfDay,closeWeekday,creationCutoffMinutes,reason'||
  !Number.isInteger(value.closeWeekday)||value.closeWeekday<0||value.closeWeekday>6||
  !Number.isInteger(value.closeMinuteOfDay)||value.closeMinuteOfDay<0||value.closeMinuteOfDay>1439||
  !Number.isInteger(value.creationCutoffMinutes)||value.creationCutoffMinutes<0||
  value.creationCutoffMinutes>=value.closeWeekday*1440+value.closeMinuteOfDay||
  typeof value.reason!=='string'||value.reason.trim().length<3||value.reason.length>500||
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.reason))fail('Choose a closing time after Monday midnight, a gap shorter than that window, and a reason.','LEAGUE_AUCTION_SCHEDULE_INVALID');
 return {closeWeekday:value.closeWeekday,closeMinuteOfDay:value.closeMinuteOfDay,
  creationCutoffMinutes:value.creationCutoffMinutes,reason:value.reason.trim()};
}
const settings=row=>row?{closeWeekday:row.close_weekday,closeMinuteOfDay:row.close_minute_of_day,creationCutoffMinutes:row.creation_cutoff_minutes}:null;
function window(s,nowMs,schedule=settings(s.current)){return getAuctionCreationWindow({nowMs,timeZone:s.league.timezone,stagingDaily:s.stagingDaily,schedule});}
function plan(s,value,nowMs){
 const proposed=input(value);
 if(!['setup','active','frozen'].includes(s.league.status))fail('This league cannot change its auction schedule.');
 const schedule={closeWeekday:proposed.closeWeekday,closeMinuteOfDay:proposed.closeMinuteOfDay,creationCutoffMinutes:proposed.creationCutoffMinutes};
 if(s.current&&JSON.stringify(settings(s.current))===JSON.stringify(schedule))fail('Choose a different schedule.','LEAGUE_AUCTION_SCHEDULE_UNCHANGED');
 const before=window(s,nowMs),after=window(s,nowMs,schedule);
 return {proposed,before,after,opensNow:!before.canStart&&after.canStart,closesNow:before.canStart&&!after.canStart};
}
module.exports={fail,input,settings,window,plan};
