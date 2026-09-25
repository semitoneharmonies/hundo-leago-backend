const assert = require("node:assert/strict");
const { createTradeRouter } = require("../../src/transport/http/createTradeRouter");
const { createTargetApplication, TARGET_ROUTER_KEYS } = require("../../src/bootstrap/createTargetRuntime");

async function runCounterProposalFlow(t, { createRuntime, IDS, NOW_MS, authenticated, creationInput, ordinaryCreationInput, sourceState }) {
  const runtime = createRuntime(t);
  const db = runtime.database;
  const pass = (req, res, next) => next();
  const auth = (req, res, next) => req.get("x-test-user") ? next() : res.sendStatus(401);
  const router = createTradeRouter({
    requestSecurity: { assignRequestId: pass, securityHeaders: pass, credentialedCors: pass,
      requireAllowedOrigin: pass, requireJson: pass, requireCompatibleFetchMetadata: pass,
      authenticateBootstrap: auth, authenticateUnsafe: auth, getRequestId: () => "counter-test",
      getSessionBootstrap: req => authenticated(req.get("x-test-user")),
      getAuthenticatedSession: req => authenticated(req.get("x-test-user")) },
    tradeReadService: runtime.readService, tradeProposalService: { list() { throw Error("unused"); } },
    tradeCreationService: runtime.service, tradeLifecycleService: runtime.lifecycleService,
    tradeAcceptancePreviewService: runtime.acceptancePreviewService, tradeAcceptanceService: runtime.acceptanceService,
  });
  const app = createTargetApplication({ routers: Object.fromEntries(TARGET_ROUTER_KEYS.map(key =>
    [key, key === "trade" ? router : (req, res) => res.sendStatus(404)])) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/leagues/${IDS.league}/trades`;
  let sequence = 0;
  async function request(path, body, user = IDS.receivingManager, key = `counter-${sequence++}`) {
    const response = await fetch(base + path, { method: "POST", headers: {
      "content-type": "application/json", "x-test-user": user, "idempotency-key": key,
    }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  }
  const reverse = input => ({ proposingTeamId: input.receivingTeamId, receivingTeamId: input.proposingTeamId,
    proposingAssets: input.receivingAssets, receivingAssets: input.proposingAssets });
  async function scenario(name, run, input = ordinaryCreationInput()) {
    await t.test(name, async () => {
      db.exec("SAVEPOINT counter_case");
      runtime.setNow(NOW_MS);
      try {
        const original = await request("", input, IDS.manager);
        assert.equal(original.status, 201, JSON.stringify(original));
        const tradeId = original.data.proposal.id;
        await run({ tradeId, input: reverse(input), path: `/${tradeId}/counter` });
      } finally { db.exec("ROLLBACK TO counter_case; RELEASE counter_case"); }
    });
  }
  await scenario("creates the edited reverse proposal and declines the original exactly once", async ({ tradeId, input, path }) => {
    input.receivingAssets = input.receivingAssets.filter(asset => asset.type !== "requested_retention");
    const originalAssets = db.prepare("SELECT * FROM trade_assets WHERE trade_id = ? ORDER BY id").all(tradeId);
    const holdings = sourceState(db);
    const result = await request(path, input, IDS.receivingManager, "same-counter");
    assert.equal(result.status, 201, JSON.stringify(result));
    assert.equal(result.data.code, "TRADE_COUNTER_PROPOSAL_CREATED");
    const createdId = result.data.proposal.id;
    assert.notEqual(createdId, tradeId);
    assert.equal(result.data.proposal.proposingTeamId, IDS.teamB);
    assert.equal(result.data.proposal.receivingTeamId, IDS.teamA);
    assert.equal(db.prepare("SELECT status FROM trades WHERE id = ?").get(tradeId).status, "declined");
    assert.equal(db.prepare("SELECT status FROM trades WHERE id = ?").get(createdId).status, "proposed");
    assert.deepEqual(db.prepare("SELECT * FROM trade_assets WHERE trade_id = ? ORDER BY id").all(tradeId), originalAssets);
    assert.equal(sourceState(db), holdings, "Sending a counter must not move ownership or money");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM trade_events WHERE trade_id = ? AND event_type = 'proposal_rejected'").get(tradeId).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE related_record_id = ?").get(createdId).n, 1);
    const bytes = db.serialize();
    const replay = await request(path, input, IDS.receivingManager, "same-counter");
    assert.equal(replay.status, 201);
    assert.equal(replay.data.code, "TRADE_COUNTER_PROPOSAL_REPLAYED");
    assert.equal(replay.data.proposal.id, createdId);
    assert.equal(bytes.equals(db.serialize()), true);
    const changed = { ...input, receivingAssets: [{ type: "draft_pick", draftPickId: IDS.draftPick }] };
    assert.equal((await request(path, changed, IDS.receivingManager, "same-counter")).status, 409);
    assert.equal((await request(path, input, IDS.receivingManager, "second-counter")).status, 409);
    assert.equal(bytes.equals(db.serialize()), true);
    const accepted = await request(`/${createdId}/accept`, {}, IDS.manager);
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.equal(accepted.data.proposal.storageStatus, "completed");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  });
  await scenario("keeps Future Considerations and retained salary in the reversed offer", async ({ input, path }) => {
    const holdings = sourceState(db);
    const result = await request(path, input);
    assert.equal(result.status, 201, JSON.stringify(result));
    const assets = result.data.proposal.assets;
    assert(assets.some(asset => asset.type === "future_consideration_instruction" && asset.sourceTeamId === IDS.teamB));
    assert(assets.some(asset => asset.type === "requested_retention" && asset.snapshot.retainedAavCents === 400 && asset.sourceTeamId === IDS.teamA));
    assert.equal(sourceState(db), holdings);
    const accepted = await request(`/${result.data.proposal.id}/accept`, {}, IDS.manager);
    assert.equal(accepted.data.code, "TRADE_AWAITING_COMMISSIONER_APPROVAL");
    assert.equal(sourceState(db), holdings);
    const approved = await request(`/${result.data.proposal.id}/approve`, {}, IDS.commissioner);
    assert.equal(approved.status, 200, JSON.stringify(approved));
    assert.equal(approved.data.proposal.storageStatus, "completed");
  }, creationInput());
  for (const user of [IDS.manager, IDS.commissioner, IDS.platformAdministrator]) {
    await scenario(`only the receiving manager can counter (${user})`, async ({ input, path }) => {
      const bytes = db.serialize();
      assert.equal((await request(path, input, user)).status, 403);
      assert.equal(bytes.equals(db.serialize()), true);
    });
  }
  await scenario("cannot change the trading partners", async ({ input, path }) => {
    const bytes = db.serialize();
    assert.equal((await request(path, reverse(input), IDS.manager)).status, 403);
    assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario("cross-league source IDs cannot be countered", async ({ input }) => {
    const bytes = db.serialize();
    const other = db.prepare("SELECT id FROM trades WHERE league_id <> ? LIMIT 1").get(IDS.league);
    const result = await request(`/${other?.id || "99999999-9999-4999-8999-999999999999"}/counter`, input);
    assert.equal(result.status, 404);
    assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario("stale assets reject without declining the original", async ({ input, path }) => {
    db.prepare("UPDATE draft_picks SET current_owner_team_id = ?, version = version + 1 WHERE id = ?").run(IDS.teamB, IDS.draftPick);
    const bytes = db.serialize();
    assert.equal((await request(path, input)).status, 409);
    assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario("a closed original cannot create another offer", async ({ input, path, tradeId }) => {
    assert.equal((await request(`/${tradeId}/decline`, {})).status, 200);
    const bytes = db.serialize();
    assert.equal((await request(path, input)).status, 409);
    assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario("an offer awaiting commissioner approval cannot be countered", async ({ input, path, tradeId }) => {
    assert.equal((await request(`/${tradeId}/accept`, {})).data.code, "TRADE_AWAITING_COMMISSIONER_APPROVAL");
    const bytes = db.serialize();
    assert.equal((await request(path, input)).status, 409);
    assert.equal(bytes.equals(db.serialize()), true);
  }, creationInput());
  await scenario("an expired original rolls back the new offer", async ({ input, path, tradeId }) => {
    db.prepare("UPDATE trades SET effective_deadline_at_ms = ? WHERE id = ?").run(NOW_MS + 1, tradeId);
    runtime.setNow(NOW_MS + 1);
    const bytes = db.serialize();
    assert.equal((await request(path, input)).status, 409);
    assert.equal(bytes.equals(db.serialize()), true);
  });
  await scenario("a late decline failure rolls back proposal, history, notification and idempotency", async ({ input, path, tradeId }) => {
    db.exec(`CREATE TEMP TRIGGER fail_counter_decline BEFORE UPDATE OF status ON trades WHEN OLD.id = '${tradeId}' AND NEW.status = 'declined' BEGIN SELECT RAISE(ABORT, 'counter rollback test'); END`);
    const bytes = db.serialize();
    assert.equal((await request(path, input)).status, 500);
    assert.equal(bytes.equals(db.serialize()), true);
  });
}

module.exports = { runCounterProposalFlow };
