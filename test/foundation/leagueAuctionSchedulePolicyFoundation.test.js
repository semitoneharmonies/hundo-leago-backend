const {test}=require('node:test');const assert=require('node:assert/strict');
const {getAuctionCreationWindow}=require('../../src/domain/auctions/auctionCreationPolicy');
const {plan,input}=require('../../src/domain/leagues/leagueAuctionSchedulePolicy');
const zone='America/Vancouver',at=Date.parse;
test('custom weekly clocks accept starts immediately before the configured gap and reject at the boundary',()=>{
 const schedule={closeWeekday:5,closeMinuteOfDay:1125,creationCutoffMinutes:90};
 const w=getAuctionCreationWindow({nowMs:at('2026-09-29T19:00:00Z'),timeZone:zone,schedule});
 assert.equal(w.bidClosesAtMs,at('2026-10-04T01:45:00Z'));assert.equal(w.newAuctionCutoffAtMs,at('2026-10-04T00:15:00Z'));
 assert.equal(getAuctionCreationWindow({nowMs:w.newAuctionCutoffAtMs-1,timeZone:zone,schedule}).canStart,true);
 assert.equal(getAuctionCreationWindow({nowMs:w.newAuctionCutoffAtMs,timeZone:zone,schedule}).canStart,false);
 assert.equal(getAuctionCreationWindow({nowMs:w.nextOpensAtMs,timeZone:zone,schedule}).canStart,true);
});
test('zero gap permits starts until close and custom clocks handle spring and autumn daylight changes',()=>{
 const schedule={closeWeekday:6,closeMinuteOfDay:150,creationCutoffMinutes:0};
 const spring=getAuctionCreationWindow({nowMs:at('2027-03-10T12:00:00Z'),timeZone:zone,schedule});
 assert.equal(spring.bidClosesAtMs,at('2027-03-14T10:30:00Z'));assert.equal(spring.newAuctionCutoffAtMs,spring.bidClosesAtMs);
 const autumn=getAuctionCreationWindow({nowMs:at('2026-10-28T12:00:00Z'),timeZone:zone,schedule});
 assert.equal(autumn.bidClosesAtMs,at('2026-11-01T10:30:00Z'));
});
test('an unsaved schedule preserves legacy weekly and staging-daily clocks exactly',()=>{
 const args={nowMs:at('2026-10-02T19:00:00Z'),timeZone:zone};
 assert.deepEqual(getAuctionCreationWindow({...args,schedule:null}),getAuctionCreationWindow(args));
 assert.deepEqual(getAuctionCreationWindow({...args,schedule:null,stagingDaily:true}),getAuctionCreationWindow({...args,stagingDaily:true}));
 assert.equal(getAuctionCreationWindow(args).canStart,false);
 assert.equal(getAuctionCreationWindow({...args,stagingDaily:true}).canStart,true);
});
test('schedule preview reports an immediate reopening and rejects invalid or unchanged inputs',()=>{
 const s={league:{status:'active',timezone:zone},current:null,stagingDaily:false};
 const value={closeWeekday:6,closeMinuteOfDay:960,creationCutoffMinutes:60,reason:'League agreed'};
 assert.equal(plan(s,value,at('2026-10-02T19:00:00Z')).opensNow,true);
 for(const changes of [{creationCutoffMinutes:10080},{creationCutoffMinutes:-1},{closeWeekday:7},{closeMinuteOfDay:1440},{closeWeekday:0,closeMinuteOfDay:0},{reason:'x'},{bid:1}])
  assert.throws(()=>input({...value,...changes}),{code:'LEAGUE_AUCTION_SCHEDULE_INVALID'});
 s.current={close_weekday:6,close_minute_of_day:960,creation_cutoff_minutes:60};
 assert.throws(()=>plan(s,value,at('2026-10-02T19:00:00Z')),{code:'LEAGUE_AUCTION_SCHEDULE_UNCHANGED'});
});

