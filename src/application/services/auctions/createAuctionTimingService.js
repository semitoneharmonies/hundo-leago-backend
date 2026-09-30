const { digest, clientKey } = require('../../../domain/leagues/leagueCommunicationPolicy');
const { fail, input, blockedReason, plan } = require('../../../domain/auctions/auctionTimingPolicy');
function createAuctionTimingService({ repository, leagueAuthorization, clock }) {
  function state(leagueId, auctionId) {
    if (!repository) fail('AUCTION_TIMING_UNAVAILABLE');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(auctionId || '')) fail('AUCTION_TIMING_INVALID');
    return repository.state(leagueId, auctionId);
  }
  function project(s, nowMs) {
    const reason = blockedReason(s, nowMs);
    return { leagueId: s.auction.league_id, auctionId: s.auction.id, timeZone: s.league.timezone,
      closesAtMs: s.auction.resolves_at_ms, playoffsAtMs: s.season?.fantasy_playoffs_start_at_ms ?? null,
      seasonEndsAtMs: s.season?.regular_season_ends_at_ms ?? null, serverNowMs: nowMs, canEdit: reason === null, blockedReason: reason };
  }
  function review(s, value, actorUserId, nowMs) {
    const p = plan(s, value, nowMs);
    return { ...project(s, nowMs), proposed: p.proposed, shortened: p.shortened,
      previewHash: digest({ state: s, proposed: p.proposed, actorUserId }) };
  }
  return {
    read({ leagueId, auctionId, authenticated }) {
      leagueAuthorization.requireCommissioner(authenticated, leagueId);
      const s = state(leagueId, auctionId);
      return { ...project(s, clock.nowMs()), history: repository.history(leagueId, auctionId) };
    },
    preview({ leagueId, auctionId, authenticated, input: value }) {
      const actor = leagueAuthorization.requireCommissioner(authenticated, leagueId);
      return review(state(leagueId, auctionId), value, actor.actorUserId, clock.nowMs());
    },
    apply({ leagueId, auctionId, authenticated, input: value, idempotencyKey }) {
      leagueAuthorization.requireCommissioner(authenticated, leagueId);
      if (!repository) fail('AUCTION_TIMING_UNAVAILABLE');
      if (!value || Object.keys(value).sort().join() !== 'closesAtMs,confirmed,previewHash,reason' ||
          value.confirmed !== true || !/^[a-f0-9]{64}$/.test(value.previewHash || '')) fail('AUCTION_TIMING_INVALID');
      const proposed = input({ closesAtMs: value.closesAtMs, reason: value.reason });
      let key;
      try { key = clientKey(idempotencyKey); } catch { fail('AUCTION_TIMING_INVALID'); }
      return repository.transaction(() => {
        const actor = leagueAuthorization.requireCommissioner(authenticated, leagueId);
        const requestHash = digest({ auctionId, proposed, previewHash: value.previewHash });
        const prior = repository.replay(leagueId, actor.actorUserId, key);
        if (prior) {
          if (prior.request_hash !== requestHash) fail('AUCTION_TIMING_KEY_CONFLICT');
          return { leagueId, auctionId, id: prior.id, accepted: true, replayed: true };
        }
        const s = state(leagueId, auctionId), nowMs = clock.nowMs();
        const preview = review(s, proposed, actor.actorUserId, nowMs);
        if (preview.previewHash !== value.previewHash) fail('AUCTION_TIMING_PREVIEW_CHANGED');
        const result = repository.apply({ state: s, proposed, actorUserId: actor.actorUserId, authority: actor.authority, clientKey: key, requestHash, nowMs });
        return { leagueId, auctionId, id: result.id, accepted: true, replayed: false };
      });
    },
  };
}
module.exports = { createAuctionTimingService };
