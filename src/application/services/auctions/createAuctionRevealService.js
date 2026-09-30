const crypto = require('node:crypto');
const { digest, clientKey } = require('../../../domain/leagues/leagueCommunicationPolicy');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

function createAuctionRevealService({ repository, auctionReadRepository, leagueAuthorization, clock }) {
  return {
    reveal({leagueId,auctionId,authenticated,input,idempotencyKey}) {
      leagueAuthorization.requireCommissioner(authenticated,leagueId);
      if (!repository.available()) fail('PRIVATE_REVEAL_UNAVAILABLE');
      if (!uuid(auctionId) || !input || Object.keys(input).sort().join() !== 'bidId,confirmed,reason' ||
          input.confirmed !== true || (input.bidId !== null && !uuid(input.bidId)) || typeof input.reason !== 'string' ||
          input.reason.trim().length < 10 || input.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(input.reason)) fail('PRIVATE_REVEAL_INVALID');
      let key; try { key=clientKey(idempotencyKey); } catch { fail('PRIVATE_REVEAL_INVALID'); }
      return repository.transaction(() => {
        const authority=leagueAuthorization.requireCommissioner(authenticated,leagueId),nowMs=clock.nowMs();
        const auction=auctionReadRepository.readAuction({leagueId,auctionId,viewerUserId:authority.actorUserId,
          viewerMembershipId:authority.membershipId,nowMs},{revealAdministration:true});
        if (!auction) fail('PRIVATE_REVEAL_NOT_FOUND');
        if (![auction.capabilities.adminCancel,auction.capabilities.adminResolve].some(c=>c.reasonCode!=='NOT_AUTHORIZED')) fail('LEAGUE_COMMISSIONER_REQUIRED');
        let terms=null;
        if (input.bidId !== null) {
          const row=repository.bid(leagueId,auctionId,input.bidId);
          if (!row || !auction.administrativeBids.some(b=>b.bidId===row.id)) fail('PRIVATE_REVEAL_NOT_FOUND');
          terms={bidId:row.id,version:row.version,totalValueCents:row.total_value_cents,termYears:row.term_years};
        }
        const hash=digest({auctionId,bidId:input.bidId,reason:input.reason.trim()});
        const prior=repository.replay(leagueId,authority.actorUserId,key);
        if (prior && (prior.request_hash !== hash || nowMs-prior.created_at_ms > 300000)) fail('PRIVATE_REVEAL_CONFLICT');
        const id=prior?.id || crypto.randomUUID();
        if (!prior) repository.insert({id,leagueId,userId:authority.actorUserId,auctionId,bidId:input.bidId,reason:input.reason.trim(),key,hash,nowMs});
        return {leagueId,auctionId,revealId:id,auction,terms,expiresAtMs:(prior?.created_at_ms ?? nowMs)+300000};
      });
    },
  };
}
module.exports={createAuctionRevealService};
