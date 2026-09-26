const assert = require('node:assert/strict');
const express = require('express');
const { createTradeRouter } = require('../../src/transport/http/createTradeRouter');
const { createActivityNotificationRouter } = require('../../src/transport/http/createActivityNotificationRouter');
const { createLeagueActivityService } = require('../../src/application/services/activity/createLeagueActivityService');
const { createTradeProposalFoundationService } = require('../../src/application/services/trades/createTradeProposalFoundationService');
const { createSqliteLeagueActivityRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteLeagueActivityRepository');

async function runTradeVisibilityFlow(t, { createRuntime, IDS, NOW_MS, authenticated, ordinaryCreationInput, creationInput }) {
  const runtime = createRuntime(t), db = runtime.database;
  const uuid = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
  const thirdTeam = uuid(1), thirdUser = uuid(2), thirdMembership = uuid(3), outsider = uuid(5), outsiderMembership = uuid(6);
  function clone(table, id, changes) {
    const row = { ...db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id), ...changes };
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(k => '@' + k).join(',')})`).run(row);
  }
  for (const [id, membership, name] of [[thirdUser, thirdMembership, 'Charlie'], [outsider, outsiderMembership, 'Observer']]) {
    clone('users', IDS.manager, { id, email_normalized: `${name.toLowerCase()}@example.test`, email_display: `${name.toLowerCase()}@example.test`, display_name: name, display_name_normalized: name.toLowerCase() });
    clone('league_memberships', IDS.membership, { id: membership, user_id: id });
  }
  clone('teams', IDS.teamB, { id: thirdTeam, name: 'Charlie', name_normalized: 'charlie' });
  clone('team_manager_assignments', IDS.assignment, { id: uuid(4), team_id: thirdTeam, user_id: thirdUser, membership_id: thirdMembership });
  const activity = createLeagueActivityService({ leagueAuthorization: runtime.leagueAuthorization, repository: createSqliteLeagueActivityRepository({ database: db }) });
  const list = createTradeProposalFoundationService({ ...runtime, repository: runtime.repository });
  const pass = (req, res, next) => next();
  const security = {
    assignRequestId: pass, securityHeaders: (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, credentialedCors: pass,
    requireAllowedOrigin: pass, requireJson: pass, requireCompatibleFetchMetadata: pass, authenticateBootstrap: pass, authenticateUnsafe: pass,
    getRequestId: () => 'trade-privacy', getSessionBootstrap: req => authenticated(req.get('x-test-user')),
    getAuthenticatedSession: req => authenticated(req.get('x-test-user')),
  };
  const app = express();
  app.use(createTradeRouter({ requestSecurity: security, tradeReadService: runtime.readService, tradeProposalService: list, tradeCreationService: runtime.service,
    tradeLifecycleService: runtime.lifecycleService, tradeAcceptancePreviewService: runtime.acceptancePreviewService, tradeAcceptanceService: runtime.acceptanceService }));
  app.use(createActivityNotificationRouter({ requestSecurity: security, leagueActivityService: activity, notificationService: Object.fromEntries(['list', 'markAllRead', 'markBatchRead', 'markRead'].map(k => [k, () => { throw Error('Unexpected notification call'); }])) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/leagues/${IDS.league}`;
  let serial = 0;
  async function request(path, user = outsider, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user, 'idempotency-key': `privacy-${serial++}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  async function get(path, user = outsider) {
    const result = await request(path, user);
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.cache, 'no-store');
    return result.body.data;
  }
  function create(three, future = false) {
    let input = future ? creationInput() : ordinaryCreationInput();
    if (three) {
      db.prepare('UPDATE draft_picks SET current_owner_team_id = ? WHERE id = ?').run(thirdTeam, IDS.draftPick);
      input = { proposingTeamId: IDS.teamA, participants: [
        { teamId: IDS.teamA, assets: [{ type: 'contract', contractId: IDS.contract, destinationTeamId: IDS.teamB }, { type: 'requested_retention', contractId: IDS.contract, retainedAavCents: 400, destinationTeamId: IDS.teamB }, { type: 'prospect_right', playerId: IDS.prospectPlayer, destinationTeamId: thirdTeam }] },
        { teamId: IDS.teamB, assets: [{ type: 'buyout_obligation', buyoutObligationId: IDS.buyout, destinationTeamId: thirdTeam }, ...(future ? [{ type: 'future_consideration_instruction', description: 'Secret future agreement', destinationTeamId: IDS.teamA }] : [])] },
        { teamId: thirdTeam, assets: [{ type: 'draft_pick', draftPickId: IDS.draftPick, destinationTeamId: IDS.teamA }] },
      ] };
    }
    return runtime.service.create({ leagueId: IDS.league, authenticated: authenticated(), idempotencyKey: `privacy-create-${serial++}`, input }).proposal.id;
  }
  async function hidden(id, user = outsider) {
    const bytes = db.serialize();
    const detail = (await get(`/trades/${id}`, user)).proposal;
    assert.equal(detail.detailsVisible, false); assert.deepEqual(detail.assets, []); assert.deepEqual(detail.history, []);
    assert.equal(detail.proposingTeam.id, IDS.teamA); assert.equal(detail.receivingTeam.id, IDS.teamB);
    if (detail.participants) { assert.equal(detail.participants.length, 3); assert(detail.participants.every(p => Object.keys(p).sort().join(',') === 'name,teamId')); }
    const summary = (await get('/trades', user)).proposals.find(p => p.id === id);
    assert.equal(summary.detailsVisible, false);
    const feed = (await get('/activity?category=trade', user)).activity.filter(item => item.related.id === id);
    assert(feed.length); assert(feed.every(item => item.metadata.detailsVisible === false && item.reason === null && item.player === null));
    const serialized = JSON.stringify({ detail, summary, feed });
    for (const secret of [IDS.contract, IDS.contractPlayer, IDS.prospectPlayer, IDS.buyout, IDS.draftPick, 'Secret future agreement', 'proposalSnapshot', 'assetIds', 'assetCount', 'usageCents']) assert(!serialized.includes(secret), secret);
    assert.equal(bytes.equals(db.serialize()), true, 'all privacy reads are byte-for-byte read-only');
  }
  async function visible(id, user) {
    const detail = (await get(`/trades/${id}`, user)).proposal;
    assert.equal(detail.detailsVisible, true); assert(detail.assets.length > 0); assert(detail.history.length > 0);
    const feed = (await get('/activity?category=trade', user)).activity.filter(item => item.related.id === id);
    assert(feed.some(item => item.metadata?.assets?.length));
  }
  async function scenario(name, run) { await t.test(name, async () => { db.exec('SAVEPOINT privacy'); runtime.setNow(NOW_MS); try { await run(); assert.deepEqual(db.pragma('foreign_key_check'), []); } finally { db.exec('ROLLBACK TO privacy; RELEASE privacy'); } }); }
  for (const three of [false, true]) {
    await scenario(`${three ? 'three' : 'two'} teams: participant-only until actual execution`, async () => {
      const id = create(three);
      for (const user of [outsider, IDS.commissioner, IDS.platformAdministrator]) await hidden(id, user);
      for (const user of [IDS.manager, IDS.receivingManager, ...(three ? [thirdUser] : [])]) await visible(id, user);
      assert.equal((await request(`/trades/${id}/acceptance-preview`, outsider)).status, 403);
      assert.equal((await request(`/trades/${id}/acceptance-preview`, IDS.commissioner)).status, 403);
      assert.equal((await request(`/trades/${id}/accept`, IDS.receivingManager, {})).status, 200);
      if (three) { await hidden(id); await visible(id, thirdUser); assert.equal((await request(`/trades/${id}/accept`, thirdUser, {})).status, 200); }
      await visible(id, outsider);
      const completed = (await get('/activity', outsider)).activity.find(item => item.type === 'trade_completed' && item.related.id === id);
      assert(completed.metadata.assets.length > 0, 'normal league announcement reveals executed assets');
    });
    for (const closure of ['decline', 'cancel', 'expire']) await scenario(`${three ? 'three' : 'two'} teams: ${closure} never reveals an unexecuted offer`, async () => {
      const id = create(three);
      if (closure === 'expire') {
        runtime.setNow(NOW_MS + 8 * 24 * 60 * 60 * 1000); await runtime.expiryJob.run();
        assert.equal(db.prepare('SELECT status FROM trades WHERE id = ?').get(id).status, 'expired');
      }
      else assert.equal((await request(`/trades/${id}/${closure}`, closure === 'decline' ? IDS.receivingManager : IDS.manager, {})).status, 200);
      await hidden(id); await hidden(id, IDS.commissioner); await visible(id, IDS.manager);
    });
    await scenario(`${three ? 'three' : 'two'} teams: commissioner sees only accepted future-considerations review`, async () => {
      const id = create(three, true); await hidden(id, IDS.commissioner);
      assert.equal((await request(`/trades/${id}/accept`, IDS.receivingManager, {})).status, 200);
      if (three) { await hidden(id, IDS.commissioner); assert.equal((await request(`/trades/${id}/accept`, thirdUser, {})).status, 200); }
      await hidden(id); await visible(id, IDS.commissioner);
      assert.equal((await request(`/trades/${id}/acceptance-preview`, IDS.commissioner)).status, 200);
      assert.equal((await request(`/trades/${id}/acceptance-preview`, outsider)).status, 403);
      assert.equal((await request(`/trades/${id}/approve`, IDS.commissioner, {})).status, 200);
      await visible(id, outsider);
    });
  }
  await scenario('revoked assignments lose access immediately; another team cannot counter', async () => {
    const id = create(true); await visible(id, thirdUser);
    db.prepare("UPDATE team_manager_assignments SET status = 'ended', ended_at_ms = ? WHERE id = ?").run(NOW_MS, uuid(4));
    await hidden(id, thirdUser);
    assert.equal((await request(`/trades/${id}/acceptance-preview`, thirdUser)).status, 403);
    const before = db.serialize();
    assert.equal((await request(`/trades/${id}/counter`, outsider, ordinaryCreationInput())).status, 403);
    assert.equal(before.equals(db.serialize()), true);
  });
  await scenario('an executed counter does not reveal its declined original', async () => {
    const id = create(false), input = ordinaryCreationInput();
    const counter = { proposingTeamId: IDS.teamB, receivingTeamId: IDS.teamA, proposingAssets: input.receivingAssets, receivingAssets: input.proposingAssets };
    const result = await request(`/trades/${id}/counter`, IDS.receivingManager, counter); assert.equal(result.status, 201, JSON.stringify(result));
    const next = result.body.data.proposal.id;
    assert.equal((await request(`/trades/${next}/accept`, IDS.manager, {})).status, 200);
    await hidden(id); await visible(next, outsider);
  });
  await scenario('automatic cancellation does not reveal the conflicting offer', async () => {
    const id = create(false), competing = create(false);
    assert.equal((await request(`/trades/${id}/accept`, IDS.receivingManager, {})).status, 200);
    assert.equal(db.prepare('SELECT status FROM trades WHERE id = ?').get(competing).status, 'cancelled');
    await hidden(competing); await visible(id, outsider);
  });
  await scenario('executed details remain public after exact reversal', async () => {
    const id = create(false);
    assert.equal((await request(`/trades/${id}/accept`, IDS.receivingManager, {})).status, 200);
    await runtime.recoveryService.reverse({ leagueId: IDS.league, input: { tradeId: id, confirmed: true }, authenticated: authenticated(IDS.commissioner), idempotencyKey: `privacy-reverse-${serial++}` });
    assert.equal(db.prepare('SELECT status FROM trades WHERE id = ?').get(id).status, 'reversed');
    await visible(id, outsider);
  });
  await scenario('pagination and caller-supplied viewer fields never reveal pending assets', async () => {
    const id = create(true), second = create(true), before = db.serialize();
    const first = await get('/activity?category=trade&limit=1');
    assert.equal(first.activity.length, 1); assert(first.page.nextCursor);
    const next = await get(`/activity?category=trade&limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`);
    assert.equal(next.activity.length, 1); assert.notEqual(next.activity[0].id, first.activity[0].id);
    assert([first.activity[0], next.activity[0]].every(item => item.metadata.detailsVisible === false));
    assert.equal((await get(`/trades/${id}?viewerUserId=${IDS.manager}&viewerMembershipId=${IDS.membership}`)).proposal.detailsVisible, false);
    const otherLeague = await fetch(base.replace(IDS.league, uuid(99)) + `/trades/${second}`, { headers: { 'x-test-user': outsider } });
    assert.equal(otherLeague.status, 404);
    assert.equal(before.equals(db.serialize()), true);
  });
  await scenario('inherited administrator review is restricted to accepted future considerations', async () => {
    runtime.repositories.platform_roles.insert({ id: uuid(90), user_id: IDS.platformAdministrator, role: 'platform_administrator', status: 'active', granted_by_user_id: IDS.commissioner, granted_at_ms: NOW_MS - 1000, ended_at_ms: null, version: 1 });
    const id = create(false, true); await hidden(id, IDS.platformAdministrator);
    assert.equal((await request(`/trades/${id}/accept`, IDS.receivingManager, {})).status, 200);
    await visible(id, IDS.platformAdministrator);
    assert.equal((await request(`/trades/${id}/cancel`, IDS.manager, {})).status, 200);
    await hidden(id, IDS.platformAdministrator); await hidden(id, IDS.commissioner);
  });
}
module.exports = { runTradeVisibilityFlow };
