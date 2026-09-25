const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTradeRouter } = require('../../src/transport/http/createTradeRouter');
const { createTargetApplication, TARGET_ROUTER_KEYS } = require('../../src/bootstrap/createTargetRuntime');

async function runThreeTeamTradeFlow(t, { createRuntime, IDS, NOW_MS, authenticated, sourceState }) {
  const runtime = createRuntime(t);
  const db = runtime.database;
  const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
  const teamC = uuid(1), managerC = uuid(2), membershipC = uuid(3);
  function clone(table, id, change) {
    const row = { ...db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id), ...change };
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(k => '@' + k).join(',')})`).run(row);
  }
  clone('users', IDS.manager, { id: managerC, email_normalized: 'charlie@example.test', email_display: 'charlie@example.test', display_name: 'Charlie', display_name_normalized: 'charlie' });
  clone('teams', IDS.teamB, { id: teamC, name: 'Charlie', name_normalized: 'charlie' });
  clone('league_memberships', IDS.membership, { id: membershipC, user_id: managerC });
  clone('team_manager_assignments', IDS.assignment, { id: uuid(4), team_id: teamC, user_id: managerC, membership_id: membershipC });
  db.prepare('UPDATE draft_picks SET current_owner_team_id = ? WHERE id = ?').run(teamC, IDS.draftPick);
  const pass = (req, res, next) => next();
  const router = createTradeRouter({ requestSecurity: {
    assignRequestId: pass, securityHeaders: pass, credentialedCors: pass, requireAllowedOrigin: pass, requireJson: pass,
    requireCompatibleFetchMetadata: pass, authenticateBootstrap: pass, authenticateUnsafe: pass, getRequestId: () => 'three-team-test',
    getSessionBootstrap: req => authenticated(req.get('x-test-user')),
    getAuthenticatedSession: req => authenticated(req.get('x-test-user')),
  }, tradeReadService: runtime.readService, tradeProposalService: { list: ({ leagueId, authenticated: auth }) => ({ code: 'TRADE_PROPOSALS_FOUND', proposals: runtime.repository.listVisible({ leagueId, viewerUserId: auth.user.id, viewerMembershipId: auth.user.id === managerC ? membershipC : IDS.membership }) }) },
  tradeCreationService: runtime.service, tradeLifecycleService: runtime.lifecycleService,
  tradeAcceptancePreviewService: runtime.acceptancePreviewService, tradeAcceptanceService: runtime.acceptanceService });
  const app = createTargetApplication({ routers: Object.fromEntries(TARGET_ROUTER_KEYS.map(key => [key, key === 'trade' ? router : (req, res) => res.sendStatus(404)])) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/leagues/${IDS.league}/trades`;
  let sequence = 0;
  async function request(path, body, user = IDS.manager, key = `three-${sequence++}`) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'content-type': 'application/json', 'x-test-user': user, 'idempotency-key': key,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() };
  }
  function input() { return { proposingTeamId: IDS.teamA, participants: [
    { teamId: IDS.teamA, assets: [{ type: 'contract', contractId: IDS.contract, destinationTeamId: IDS.teamB }, { type: 'requested_retention', contractId: IDS.contract, retainedAavCents: 400, destinationTeamId: IDS.teamB }, { type: 'prospect_right', playerId: IDS.prospectPlayer, destinationTeamId: teamC }] },
    { teamId: IDS.teamB, assets: [{ type: 'buyout_obligation', buyoutObligationId: IDS.buyout, destinationTeamId: teamC }] },
    { teamId: teamC, assets: [{ type: 'draft_pick', draftPickId: IDS.draftPick, destinationTeamId: IDS.teamA }] },
  ] }; }
  async function scenario(name, run) {
    await t.test(name, async () => {
      db.exec('SAVEPOINT three_team_case'); runtime.setNow(NOW_MS); runtime.lateLockBatches.splice(0);
      try { await run(); assert.deepEqual(db.pragma('foreign_key_check'), []); }
      finally { db.exec('ROLLBACK TO three_team_case; RELEASE three_team_case'); }
    });
  }
  async function create(body = input(), user = IDS.manager) {
    const bytes = db.serialize();
    const preview = await request('/preview', body, user);
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.equal(preview.data.code, 'TRADE_PROPOSAL_PREVIEWED');
    assert.equal(preview.data.teams.length, 3);
    assert.equal(bytes.equals(db.serialize()), true, 'draft preview must not create a trade or write any state');
    const result = await request('', body, user);
    assert.equal(result.status, 201, JSON.stringify(result));
    assert.equal(result.data.proposal.participants.length, 3);
    return result.data.proposal.id;
  }
  const managers = new Map([[IDS.teamA, IDS.manager], [IDS.teamB, IDS.receivingManager], [teamC, managerC]]);
  await scenario('screenshot-shaped three-player and three-pick cycle previews and completes', async () => {
    for (const [n, teamId] of [[100, IDS.teamB], [200, teamC]]) {
      clone('players', IDS.contractPlayer, { id: uuid(n), full_name: `Cycle player ${n}` });
      clone('contracts', IDS.contract, { id: uuid(n + 1), player_id: uuid(n), current_team_id: teamId });
      clone('contract_years', IDS.contractYear, { id: uuid(n + 2), contract_id: uuid(n + 1) });
      clone('player_ownerships', IDS.ownership, { id: uuid(n + 3), player_id: uuid(n), team_id: teamId });
    }
    clone('draft_picks', IDS.draftPick, { id: uuid(104), round_number: 2, original_team_id: IDS.teamA, current_owner_team_id: IDS.teamA });
    clone('draft_picks', IDS.draftPick, { id: uuid(204), round_number: 1, original_team_id: IDS.teamB, current_owner_team_id: IDS.teamB });
    const body = { proposingTeamId: IDS.teamA, participants: [
      { teamId: IDS.teamA, assets: [{ type: 'contract', contractId: IDS.contract, destinationTeamId: IDS.teamB }, { type: 'draft_pick', draftPickId: uuid(104), destinationTeamId: teamC }] },
      { teamId: IDS.teamB, assets: [{ type: 'contract', contractId: uuid(101), destinationTeamId: teamC }, { type: 'draft_pick', draftPickId: uuid(204), destinationTeamId: IDS.teamA }] },
      { teamId: teamC, assets: [{ type: 'contract', contractId: uuid(201), destinationTeamId: IDS.teamA }, { type: 'draft_pick', draftPickId: IDS.draftPick, destinationTeamId: IDS.teamB }] },
    ] };
    const id = await create(body), before = sourceState(db);
    const draft = await request('/preview', body);
    const acceptance = await request(`/${id}/acceptance-preview`, undefined, IDS.receivingManager);
    assert.deepEqual(draft.data.teams, acceptance.data.teams);
    assert.equal((await request(`/${id}/accept`, {}, IDS.receivingManager)).status, 200);
    assert.equal(sourceState(db), before);
    const final = await request(`/${id}/accept`, {}, managerC);
    assert.equal(final.status, 200, JSON.stringify(final));
    assert.equal(final.data.proposal.storageStatus, 'completed');
    assert.deepEqual(final.data.teams, draft.data.teams);
    for (const side of body.participants) for (const asset of side.assets) {
      const owner = asset.type === 'contract'
        ? db.prepare('SELECT current_team_id team_id FROM contracts WHERE id = ?').get(asset.contractId)
        : db.prepare('SELECT current_owner_team_id team_id FROM draft_picks WHERE id = ?').get(asset.draftPickId);
      assert.equal(owner.team_id, asset.destinationTeamId);
    }
  });
  await scenario('one manager can receive a proposal for two different teams', async () => {
    const receiver = db.prepare("SELECT user_id, membership_id FROM team_manager_assignments WHERE team_id = ? AND status = 'accepted' AND ended_at_ms IS NULL").get(IDS.teamB);
    db.prepare('UPDATE team_manager_assignments SET user_id = ?, membership_id = ? WHERE id = ?').run(receiver.user_id, receiver.membership_id, uuid(4));
    const before = sourceState(db);
    const id = await create();
    const notifications = db.prepare("SELECT id,message_data_json FROM notifications WHERE related_record_id = ? AND user_id = ? ORDER BY id").all(id, receiver.user_id);
    assert.equal(notifications.length, 2);
    assert.equal(new Set(notifications.map(n => n.id)).size, 2);
    assert.deepEqual(notifications.map(n => JSON.parse(n.message_data_json).receivingTeamId).sort(), [IDS.teamB,teamC].sort());
    assert.equal(sourceState(db),before);
    const bytes = db.serialize();
    for (const respondingTeamId of [undefined, IDS.teamA, uuid(99)]) {
      const response = await request(`/${id}/accept`, respondingTeamId ? { respondingTeamId } : {}, receiver.user_id);
      assert.equal(response.status, 403, JSON.stringify(response));
    }
    assert.equal(bytes.equals(db.serialize()), true, 'ambiguous or unauthorized responses never write');
    const firstTeam = { respondingTeamId: IDS.teamB }, secondTeam = { respondingTeamId: teamC };
    assert.equal((await request(`/${id}/acceptance-preview?respondingTeamId=${teamC}`, undefined, receiver.user_id)).status, 200);
    const first = await request(`/${id}/accept`, firstTeam, receiver.user_id, 'shared-first');
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(first.data.proposal.storageStatus, 'proposed');
    assert.equal(sourceState(db), before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE related_record_id = ? AND read_at_ms IS NULL').get(id).n, 1);
    assert.equal((await request(`/${id}/accept`, secondTeam, receiver.user_id, 'shared-first')).status, 409, 'same key cannot switch teams');
    const final = await request(`/${id}/accept`, secondTeam, receiver.user_id, 'shared-final');
    assert.equal(final.status, 200, JSON.stringify(final));
    assert.equal(final.data.proposal.storageStatus, 'completed');
    assert.equal(final.data.teams.length, 3);
    const committed = db.serialize();
    assert.equal((await request(`/${id}/accept`, secondTeam, receiver.user_id, 'shared-final')).data.code, 'TRADE_ACCEPTANCE_REPLAYED');
    assert.equal((await request(`/${id}/accept`, firstTeam, receiver.user_id, 'shared-first')).data.event.id, first.data.event.id);
    assert.equal(committed.equals(db.serialize()), true, 'each team receipt replays without writes');
  });
  for (const counterWhileOpen of [false, true]) await scenario(`shared manager can decline, counter and acknowledge per team (${counterWhileOpen})`, async () => {
    const receiver = db.prepare("SELECT user_id, membership_id FROM team_manager_assignments WHERE team_id = ? AND status = 'accepted' AND ended_at_ms IS NULL").get(IDS.teamB);
    db.prepare('UPDATE team_manager_assignments SET user_id = ?, membership_id = ? WHERE id = ?').run(receiver.user_id, receiver.membership_id, uuid(4));
    const id = await create(), before = sourceState(db);
    if (!counterWhileOpen) {
      assert.equal((await request(`/${id}/decline`, { respondingTeamId: IDS.teamB }, receiver.user_id)).status, 200);
      assert.equal((await request(`/${id}/accept`, { respondingTeamId: teamC }, receiver.user_id)).status, 409);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE related_record_id = ? AND read_at_ms IS NULL').get(id).n, 1);
      assert.equal((await request(`/${id}/acknowledge`, { respondingTeamId: teamC }, receiver.user_id)).status, 200);
    }
    const counter = input(); counter.proposingTeamId = teamC; counter.participants = [counter.participants[2],counter.participants[0],counter.participants[1]];
    const result = await request(`/${id}/counter`, counter, receiver.user_id);
    assert.equal(result.status, 201, JSON.stringify(result));
    assert.deepEqual(result.data.proposal.participants.map(p => p.decision), ['accepted','pending','pending']);
    assert.equal(db.prepare('SELECT status FROM trades WHERE id = ?').get(id).status, 'declined');
    assert.equal(sourceState(db), before);
  });
  for (const proposer of managers.keys()) for (const reverse of [false, true]) await scenario(`all assets move atomically: proposer ${proposer}, reverse acceptance ${reverse}`, async () => {
    const body = input(); body.participants.sort((a, b) => (b.teamId === proposer) - (a.teamId === proposer)); body.proposingTeamId = proposer;
    const before = sourceState(db);
    const id = await create(body, managers.get(proposer));
    const receivers = body.participants.slice(1).map(p => managers.get(p.teamId)); if (reverse) receivers.reverse();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE related_record_id = ?').get(id).n, 2);
    const bytes = db.serialize();
    const preview = await request(`/${id}/acceptance-preview`, undefined, receivers[0]);
    assert.equal(preview.status, 200, JSON.stringify(preview)); assert.equal(preview.data.teams.length, 3);
    assert.equal(bytes.equals(db.serialize()), true, 'GET preview must be read-only');
    const draft = await request('/preview', body, managers.get(proposer));
    assert.deepEqual(draft.data.teams, preview.data.teams, 'draft and acceptance project identical cap, roster and retention impacts');
    assert.equal(bytes.equals(db.serialize()), true);
    const first = await request(`/${id}/accept`, {}, receivers[0], 'first-accept');
    assert.equal(first.status, 200, JSON.stringify(first)); assert.equal(first.data.proposal.storageStatus, 'proposed');
    const otherViewer = await request(`/${id}`, undefined, receivers[1]);
    assert.equal(otherViewer.status, 200);
    assert.equal(otherViewer.data.proposal.participants.find(p => managers.get(p.teamId) === receivers[0]).decision, 'accepted', 'The remaining team sees the first invited team acceptance');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM league_activity WHERE related_id = ? AND event_type = 'trade_participant_accepted'").get(id).n, 1);
    assert.equal(sourceState(db), before); assert.equal(runtime.lateLockBatches.length, 0);
    const afterFirst = db.serialize();
    assert.equal((await request(`/${id}/accept`, {}, receivers[0], 'first-accept')).status, 200);
    assert.equal(afterFirst.equals(db.serialize()), true);
    assert.equal((await request(`/${id}/accept`, {}, receivers[0], 'another-accept')).status, 409);
    const second = await request(`/${id}/accept`, {}, receivers[1], 'final-accept');
    assert.equal(second.status, 200, JSON.stringify(second)); assert.equal(second.data.proposal.storageStatus, 'completed');
    assert.equal(second.data.teams.length, 3);
    assert.equal(db.prepare('SELECT current_team_id FROM contracts WHERE id = ?').get(IDS.contract).current_team_id, IDS.teamB);
    assert.equal(db.prepare('SELECT team_id FROM player_ownerships WHERE player_id = ?').get(IDS.prospectPlayer).team_id, teamC);
    assert.equal(db.prepare('SELECT current_owner_team_id FROM draft_picks WHERE id = ?').get(IDS.draftPick).current_owner_team_id, IDS.teamA);
    assert.equal(db.prepare('SELECT responsible_team_id FROM buyout_obligations WHERE id = ?').get(IDS.buyout).responsible_team_id, teamC);
    assert.equal(runtime.lateLockBatches.at(-1).teams.length, 3);
    const committed = db.serialize();
    assert.equal((await request(`/${id}/accept`, {}, receivers[1], 'final-accept')).status, 200);
    assert.equal(committed.equals(db.serialize()), true);
    runtime.lateLockBatches.splice(0);
  });
  for (const firstAccept of [false, true]) await scenario(`decline rejects globally, per-team OK and fresh counter (${firstAccept})`, async () => {
    const id = await create(); const before = sourceState(db);
    if (firstAccept) assert.equal((await request(`/${id}/accept`, {}, managerC)).status, 200);
    assert.equal((await request(`/${id}/decline`, {}, IDS.receivingManager)).status, 200);
    assert.equal((await request(`/${id}/accept`, {}, managerC)).status, 409);
    const detail = await request(`/${id}`, undefined, managerC);
    assert.equal(detail.status, 200); assert.equal(detail.data.proposal.storageStatus, 'declined');
    assert.equal(detail.data.proposal.participants.find(p => p.teamId === teamC).acknowledgedAtMs, null);
    assert.equal((await request(`/${id}/acknowledge`, {}, IDS.commissioner)).status, 403);
    assert.equal((await request(`/${id}/acknowledge`, {}, managerC)).status, 200);
    const bytes = db.serialize();
    assert.equal((await request(`/${id}/acknowledge`, {}, managerC)).status, 200); assert.equal(bytes.equals(db.serialize()), true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE related_record_id = ? AND user_id = ? AND read_at_ms IS NULL').get(id, managerC).n, 0);
    assert.equal(db.prepare('SELECT acknowledged_at_ms FROM trade_participants WHERE trade_id = ? AND team_id = ?').get(id, IDS.teamA).acknowledged_at_ms, null);
    const counter = input(); counter.proposingTeamId = teamC; counter.participants = [counter.participants[2], counter.participants[0], counter.participants[1]];
    const result = await request(`/${id}/counter`, counter, managerC, 'counter');
    assert.equal(result.status, 201, JSON.stringify(result));
    assert.deepEqual(result.data.proposal.participants.map(p => p.decision), ['accepted', 'pending', 'pending']);
    assert.equal(sourceState(db), before);
    const next = result.data.proposal.id;
    assert.equal((await request(`/${next}/accept`, {}, IDS.manager)).data.proposal.storageStatus, 'proposed');
    assert.equal((await request(`/${next}/accept`, {}, IDS.receivingManager)).data.proposal.storageStatus, 'completed');
  });
  await scenario('sending a counter closes an open offer atomically', async () => {
    const id = await create(); const counter = input(); counter.proposingTeamId = teamC; counter.participants = [counter.participants[2], counter.participants[0], counter.participants[1]];
    db.exec("CREATE TEMP TRIGGER fail_counter BEFORE UPDATE OF status ON trades WHEN NEW.status = 'declined' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    const bytes = db.serialize(); assert.equal((await request(`/${id}/counter`, counter, managerC)).status, 500); assert.equal(bytes.equals(db.serialize()), true);
    db.exec('DROP TRIGGER fail_counter');
    assert.equal((await request(`/${id}/counter`, counter, managerC)).status, 201);
    assert.equal(db.prepare('SELECT status FROM trades WHERE id = ?').get(id).status, 'declined');
  });
  await scenario('Future Considerations require both teams then commissioner approval', async () => {
    const body = input(); body.participants[1].assets.push({ type: 'future_consideration', futureConsiderationId: IDS.futureConsideration, destinationTeamId: teamC });
    for (const side of body.participants) side.assets.push({ type: 'future_consideration_instruction', description: 'Same legal description', destinationTeamId: body.participants.find(p => p.teamId !== side.teamId).teamId });
    const before = sourceState(db), id = await create(body);
    assert.equal((await request(`/${id}/accept`, {}, managerC)).data.proposal.storageStatus, 'proposed');
    assert.equal((await request(`/${id}/approve`, {}, IDS.commissioner)).status, 409);
    const accepted = await request(`/${id}/accept`, {}, IDS.receivingManager);
    assert.equal(accepted.status, 200, JSON.stringify(accepted)); assert.equal(accepted.data.proposal.storageStatus, 'awaiting_commissioner_approval');
    assert.equal(sourceState(db), before);
    const approved = await request(`/${id}/approve`, {}, IDS.commissioner);
    assert.equal(approved.status, 200, JSON.stringify(approved)); assert.equal(approved.data.proposal.storageStatus, 'completed');
  });
  await scenario('final acceptance failure rolls back all transfers and the final consent', async () => {
    const id = await create(); await request(`/${id}/accept`, {}, IDS.receivingManager);
    db.exec("CREATE TEMP TRIGGER fail_transfer BEFORE UPDATE ON draft_picks BEGIN SELECT RAISE(ABORT, 'injected'); END");
    const bytes = db.serialize(); assert.equal((await request(`/${id}/accept`, {}, managerC)).status, 500); assert.equal(bytes.equals(db.serialize()), true);
    db.exec('DROP TRIGGER fail_transfer');
    assert.equal((await request(`/${id}/accept`, {}, managerC)).status, 200);
  });
  for (const [name, change] of [
    ['self destination', b => { b.participants[0].assets[0].destinationTeamId = IDS.teamA; }],
    ['foreign destination', b => { b.participants[0].assets[0].destinationTeamId = uuid(90); }],
    ['duplicate participant', b => { b.participants[2].teamId = IDS.teamB; }],
    ['missing contribution', b => { b.participants[2].assets = []; }],
    ['duplicate asset', b => { b.participants[2].assets.push(b.participants[0].assets[0]); }],
    ['misrouted retention', b => { b.participants[0].assets[1].destinationTeamId = teamC; }],
  ]) await scenario(`invalid ${name} has no writes`, async () => {
    const body = input(); change(body); const bytes = db.serialize(); assert((await request('/preview', body)).status >= 400); assert((await request('', body)).status >= 400); assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario('draft preview requires proposer authority and current ownership', async () => {
    const bytes = db.serialize();
    for (const user of [managerC, IDS.receivingManager, IDS.commissioner]) assert.equal((await request('/preview', input(), user)).status, 403);
    assert.equal(bytes.equals(db.serialize()), true);
    db.prepare('UPDATE draft_picks SET current_owner_team_id = ? WHERE id = ?').run(IDS.teamA, IDS.draftPick);
    const stale = db.serialize();
    assert.equal((await request('/preview', input())).status, 409);
    assert.equal(stale.equals(db.serialize()), true);
  });
  await scenario('stale third-team asset prevents final execution', async () => {
    const id = await create(); await request(`/${id}/accept`, {}, IDS.receivingManager);
    db.prepare('UPDATE draft_picks SET current_owner_team_id = ? WHERE id = ?').run(IDS.teamA, IDS.draftPick);
    const bytes = db.serialize(); assert.equal((await request(`/${id}/accept`, {}, managerC)).status, 409); assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario('outsiders and the proposer cannot accept; pending offers cannot be acknowledged', async () => {
    const id = await create(), bytes = db.serialize();
    for (const user of [IDS.manager, IDS.commissioner, IDS.platformAdministrator]) assert.equal((await request(`/${id}/accept`, {}, user)).status, 403);
    assert.equal((await request(`/${id}/acknowledge`, {}, managerC)).status, 409); assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario('an accepted team can decline while the other response is outstanding', async () => {
    const id = await create(); assert.equal((await request(`/${id}/accept`, {}, IDS.receivingManager)).status, 200);
    assert.equal((await request(`/${id}/decline`, {}, IDS.receivingManager)).status, 200);
    assert.equal((await request(`/${id}/accept`, {}, managerC)).status, 409);
  });
  await scenario('counter after one acceptance resets both invited responses', async () => {
    const id = await create(); await request(`/${id}/accept`, {}, IDS.receivingManager);
    const body = input(); body.proposingTeamId = teamC; body.participants = [body.participants[2], body.participants[0], body.participants[1]];
    const counter = await request(`/${id}/counter`, body, managerC);
    assert.equal(counter.status, 201, JSON.stringify(counter));
    assert.deepEqual(counter.data.proposal.participants.map(p => p.decision), ['accepted', 'pending', 'pending']);
  });
  await scenario('countering a rejected offer acknowledges it only for the countering team', async () => {
    const id = await create(); await request(`/${id}/decline`, {}, IDS.receivingManager);
    const body = input(); body.proposingTeamId = teamC; body.participants = [body.participants[2], body.participants[0], body.participants[1]];
    const counter = await request(`/${id}/counter`, body, managerC);
    assert.equal(counter.status, 201, JSON.stringify(counter));
    const participants = (await request(`/${id}`, undefined, managerC)).data.proposal.participants;
    assert.equal(participants.find(p => p.teamId === teamC).acknowledgedAtMs, NOW_MS);
    assert.equal(participants.find(p => p.teamId === IDS.teamA).acknowledgedAtMs, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE related_record_id = ? AND user_id = ? AND read_at_ms IS NULL').get(id, managerC).n, 0);
  });
  for (const [name, change] of [
    ['expired', () => runtime.setNow(NOW_MS + 3 * 24 * 60 * 60 * 1000)],
    ['league frozen', () => db.prepare("UPDATE leagues SET status = 'frozen' WHERE id = ?").run(IDS.league)],
    ['third team inactive', () => db.prepare("UPDATE teams SET status = 'inactive' WHERE id = ?").run(teamC)],
    ['third manager ended', () => db.prepare("UPDATE team_manager_assignments SET ended_at_ms = ? WHERE id = ?").run(NOW_MS, uuid(4))],
  ]) await scenario(`blocks final acceptance when ${name}`, async () => {
    const id = await create(); await request(`/${id}/accept`, {}, IDS.receivingManager); change(); const bytes = db.serialize();
    assert((await request(`/${id}/accept`, {}, managerC)).status >= 400); assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario('safe commissioner reversal restores the assets of all three teams', async () => {
    const id = await create(); await request(`/${id}/accept`, {}, IDS.receivingManager); await request(`/${id}/accept`, {}, managerC);
    const preview = runtime.recoveryService.preview({ leagueId: IDS.league, input: { tradeId: id }, authenticated: authenticated(IDS.commissioner) });
    assert.equal(preview.preview.recoverable, true);
    await runtime.recoveryService.reverse({ leagueId: IDS.league, input: { tradeId: id, confirmed: true }, idempotencyKey: 'reverse-three', authenticated: authenticated(IDS.commissioner) });
    assert.equal(db.prepare('SELECT current_owner_team_id FROM draft_picks WHERE id = ?').get(IDS.draftPick).current_owner_team_id, teamC);
    assert.equal(db.prepare('SELECT responsible_team_id FROM buyout_obligations WHERE id = ?').get(IDS.buyout).responsible_team_id, IDS.teamB);
    assert.equal(db.prepare('SELECT current_team_id FROM contracts WHERE id = ?').get(IDS.contract).current_team_id, IDS.teamA);
    assert.equal(runtime.lateLockBatches.at(-1).teams.length, 3);
  });
  await scenario('maximum three-team package survives JSON transport and commissioner completion', async () => {
    const body = input();
    for (const side of body.participants) side.assets = Array.from({ length: 100 }, (_, index) => ({ type: 'future_consideration_instruction', description: String(index).padStart(3, '0') + '界'.repeat(497), destinationTeamId: body.participants.find(other => other.teamId !== side.teamId).teamId }));
    const id = await create(body);
    assert.equal((await request(`/${id}/accept`, {}, IDS.receivingManager)).status, 200);
    assert.equal((await request(`/${id}/accept`, {}, managerC)).status, 200);
    const result = await request(`/${id}/approve`, {}, IDS.commissioner);
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.transfers.length, 300);
  });
  await scenario('the additive migration preserves all pre-existing records', async () => {
    db.exec('DROP TABLE trade_participants');
    db.prepare("UPDATE application_metadata SET metadata_value = '61' WHERE metadata_key = 'data_model_version'").run();
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'application_metadata' ORDER BY name").all().map(row => row.name);
    const before = tables.map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()));
    db.exec(fs.readFileSync(path.join(__dirname, '../../database/migrations/0062_add_three_team_trade_participants.sql'), 'utf8'));
    assert.deepEqual(tables.map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())), before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM trade_participants').get().n, 0);
  });
  await scenario('identically worded considerations from one team to two destinations are distinct', async () => {
    const body = input();
    for (const destinationTeamId of [IDS.teamB, teamC]) body.participants[0].assets.push({ type: 'future_consideration_instruction', description: 'Conditional pick', destinationTeamId });
    const id = await create(body);
    assert.equal((await request(`/${id}/accept`, {}, IDS.receivingManager)).status, 200);
    assert.equal((await request(`/${id}/accept`, {}, managerC)).status, 200);
    assert.equal((await request(`/${id}/approve`, {}, IDS.commissioner)).status, 200);
  });
}
module.exports = { runThreeTeamTradeFlow };
