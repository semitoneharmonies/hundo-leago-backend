const assert = require('node:assert/strict');
const { test } = require('node:test');
const { input, blockedReason, plan } = require('../../src/domain/auctions/auctionTimingPolicy');
const { createAuctionTimingService } = require('../../src/application/services/auctions/createAuctionTimingService');
const id = '00000000-0000-4000-8000-000000000001';
const state = () => ({ auction: { id, league_id: id, season_id: 'season', status: 'open', opened_at_ms: 1, resolves_at_ms: 100, version: 1 },
  league: { status: 'active', current_season_id: 'season', timezone: 'America/Vancouver', version: 1 },
  season: { status: 'active', fantasy_playoffs_start_at_ms: 300, regular_season_ends_at_ms: 400, version: 1 },
  context: { source_kind: 'ordinary_weekly' }, jobCount: 0, resolutionCount: 0 });
test('auction timing validates bounded input and future closing before each season boundary', () => {
  const s = state(), before = structuredClone(s);
  assert.equal(plan(s, { closesAtMs: 200, reason: ' More time ' }, 50).shortened, false);
  assert.equal(plan(s, { closesAtMs: 75, reason: 'Earlier closing' }, 50).shortened, true);
  assert.deepEqual(s, before);
  for (const value of [null, {}, { closesAtMs: 200, reason: 'x' }, { closesAtMs: 200, reason: 'unsafe\nreason' },
    { closesAtMs: 200, reason: 'safe', extra: true }, { closesAtMs: Infinity, reason: 'safe' }]) assert.throws(() => input(value));
  for (const at of [50, 100, 300, 400]) assert.throws(() => plan(s, { closesAtMs: at, reason: 'Change clock' }, 50));
  s.season.fantasy_playoffs_start_at_ms = null; s.season.regular_season_ends_at_ms = 150;
  assert.throws(() => plan(s, { closesAtMs: 200, reason: 'Change clock' }, 50));
});
test('passed deadlines, FAD auctions, old seasons and all resolution jobs remain protected', () => {
  for (const mutate of [s => s.auction.status = 'resolved', s => s.context.source_kind = 'fad_open_rapid',
    s => s.context.source_kind = 'fad_restricted', s => s.league.status = 'archived', s => s.league.current_season_id = 'other',
    s => s.season.status = 'completed', s => s.jobCount = 1, s => s.resolutionCount = 1, s => s.season.fantasy_playoffs_start_at_ms = 50]) {
    const s = state(); mutate(s); assert.ok(blockedReason(s, 50)); assert.throws(() => plan(s, { closesAtMs: 200, reason: 'Change clock' }, 50));
  }
  assert.ok(blockedReason(state(), 100)); assert.equal(blockedReason(state(), 99), null);
});
test('confirmation rechecks authority, clock and version; preview never writes', () => {
  let now = 50, allowed = true, writes = 0; const s = state();
  const service = createAuctionTimingService({ clock: { nowMs: () => now },
    leagueAuthorization: { requireCommissioner() { if (!allowed) throw Error('denied'); return { actorUserId: id, authority: 'commissioner' }; } },
    repository: { state: () => s, history: () => [], transaction: fn => fn(), replay: () => null, apply() { writes++; return { id }; } } });
  const args = { leagueId: id, auctionId: id, authenticated: {} }, proposed = { closesAtMs: 200, reason: 'More time' };
  service.read(args); const preview = service.preview({ ...args, input: proposed }); assert.equal(writes, 0);
  const command = { ...args, input: { ...proposed, confirmed: true, previewHash: preview.previewHash }, idempotencyKey: 'timing-test' };
  allowed = false; assert.throws(() => service.apply(command)); allowed = true;
  s.auction.version++; assert.throws(() => service.apply(command), { code: 'AUCTION_TIMING_PREVIEW_CHANGED' }); s.auction.version--;
  now = 100; assert.throws(() => service.apply(command), { code: 'AUCTION_TIMING_CONFLICT' }); now = 50;
  service.apply(command); assert.equal(writes, 1);
});
