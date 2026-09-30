function fail(code = 'AUCTION_TIMING_CONFLICT') {
  throw Object.assign(new Error(code), { code });
}
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
function input(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join() !== 'closesAtMs,reason' ||
      !timestamp(value.closesAtMs) || typeof value.reason !== 'string' ||
      value.reason.trim().length < 3 || value.reason.length > 500 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.reason)) fail('AUCTION_TIMING_INVALID');
  return { closesAtMs: value.closesAtMs, reason: value.reason.trim() };
}
function blockedReason(state, nowMs) {
  const { auction, league, season, context } = state;
  if (context?.source_kind !== 'ordinary_weekly') return 'Free Agent Draft auctions require a coordinated round schedule change.';
  if (!['active','frozen'].includes(league.status) || league.current_season_id !== auction.season_id || season?.status !== 'active')
    return 'The league must be active in this season.';
  if (auction.status !== 'open' || nowMs >= auction.resolves_at_ms) return 'This auction has closed. Its deadline cannot be reopened here.';
  if (state.jobCount || state.resolutionCount) return 'Resolution has started or needs recovery. Its recorded clock is protected.';
  if ((season.fantasy_playoffs_start_at_ms !== null && nowMs >= season.fantasy_playoffs_start_at_ms) ||
      (season.regular_season_ends_at_ms !== null && nowMs >= season.regular_season_ends_at_ms))
    return 'In-season auctions have ended for this season.';
  return null;
}
function plan(state, value, nowMs) {
  const proposed = input(value);
  if (blockedReason(state, nowMs)) fail();
  if (proposed.closesAtMs <= nowMs || proposed.closesAtMs <= state.auction.opened_at_ms) fail('AUCTION_TIMING_NOT_FUTURE');
  if ([state.season.fantasy_playoffs_start_at_ms, state.season.regular_season_ends_at_ms]
    .some(bound => bound !== null && proposed.closesAtMs >= bound)) fail('AUCTION_TIMING_SEASON_BOUNDARY');
  if (proposed.closesAtMs === state.auction.resolves_at_ms) fail('AUCTION_TIMING_UNCHANGED');
  return { proposed, shortened: proposed.closesAtMs < state.auction.resolves_at_ms };
}
module.exports = { fail, input, blockedReason, plan };
