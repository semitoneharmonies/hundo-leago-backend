// Verified NHL schedule publications, reviewed 2026-10-02. Never carry dates
// into an unverified season or infer off-days from a missing game feed.
const sources={
 '2025':'https://media.nhl.com/site/vasset/public/attachments/2025/09/19134/2025-26%20Schedule%20Release.pdf',
 '2026':'https://www.nhl.com/news/nhl-stats-pack-2026-27-regular-season-schedule',
};
const seasons={
 2025:[['2025-12-24','2025-12-26','Christmas break'],['2026-02-06','2026-02-24','Olympic break']],
 2026:[['2026-11-20','2026-11-20','NHL day off'],['2026-11-26','2026-11-26','NHL day off'],['2026-12-23','2026-12-25','Christmas break'],['2027-02-04','2027-02-07','All-Star break']],
};
function nhlCalendarBreaks(calendar,timeZone){
 if(!Number.isSafeInteger(calendar?.regularSeasonStartsAtMs))return [];
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone,year:'numeric',month:'numeric'}).formatToParts(calendar.regularSeasonStartsAtMs).map(p=>[p.type,p.value]));
 const year=Number(parts.year)-(Number(parts.month)<7?1:0);
 return (seasons[year]||[]).map(([firstDay,lastDay,label])=>({id:'nhl-break:'+firstDay,kind:'break',firstDay,lastDay,label,source:sources[year]}));
}
module.exports={nhlCalendarBreaks};
