const {test}=require('node:test');
const assert=require('node:assert/strict');
const {calendarAuctionEvents}=require('../../src/domain/leagues/calendarAuctionEvents');
const at=Date.parse,timeZone='America/Vancouver';
const season={regular_season_starts_at_ms:at('2026-10-01T07:00Z'),regular_season_ends_at_ms:at('2027-04-12T07:00Z'),fantasy_playoffs_start_at_ms:at('2027-03-15T07:00Z'),free_agent_draft_completed_at_ms:at('2026-10-01T07:00Z')};
test('upcoming default weekly dates follow league-local DST and stop before playoffs without any open auction',()=>{
 const events=calendarAuctionEvents({season,timeZone,nowMs:at('2026-10-28T00:00Z')});
 assert(events.some(e=>e.kind==='auction'&&e.atMs===at('2026-11-02T00:00Z')));
 assert(events.some(e=>e.kind==='auction-cutoff'&&e.atMs===at('2026-10-30T07:00Z')));
 assert(events.every(e=>e.atMs>=at('2026-10-28T00:00Z')&&e.atMs<season.fantasy_playoffs_start_at_ms));
 assert(events.every(e=>e.recurring===true));
});
test('configured rules and daily staging clocks remain authoritative',()=>{
 const custom=calendarAuctionEvents({season,timeZone,nowMs:at('2026-10-28T00:00Z'),schedule:{closeWeekday:5,closeMinuteOfDay:1125,creationCutoffMinutes:90},stagingDaily:true});
 assert(custom.some(e=>e.kind==='auction'&&e.atMs===at('2026-11-01T01:45Z')));
 assert(custom.some(e=>e.kind==='auction-cutoff'&&e.atMs===at('2026-11-01T00:15Z')));
 const daily=calendarAuctionEvents({season,timeZone,nowMs:at('2026-10-28T00:00Z'),stagingDaily:true});
 assert(daily.some(e=>e.label==='Daily auctions close'&&e.atMs===at('2026-10-28T23:00Z')));
 assert.equal(new Set(daily.map(e=>e.id)).size,daily.length);
});
test('unfinished FAD, missing dates and ended seasons do not invent weekly auctions',()=>{
 assert.deepEqual(calendarAuctionEvents({season:{...season,free_agent_draft_completed_at_ms:null},timeZone,nowMs:0}),[]);
 assert.deepEqual(calendarAuctionEvents({season:null,timeZone,nowMs:0}),[]);
 assert.deepEqual(calendarAuctionEvents({season,timeZone,nowMs:season.fantasy_playoffs_start_at_ms}),[]);
});
