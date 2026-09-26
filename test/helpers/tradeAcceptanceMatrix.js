const assert = require("node:assert/strict");
const { createTradeRouter } = require("../../src/transport/http/createTradeRouter");
const { createTargetApplication, TARGET_ROUTER_KEYS } = require("../../src/bootstrap/createTargetRuntime");

// Use the real trade services, authorization, router, and SQLite repository.
// Only the session transport is replaced by explicit local test identities.
async function runTradeAcceptanceMatrix(t, helpers) {
  const { createRuntime, IDS, NOW_MS, uuid, insertPlayer, insertContract,
    authenticated, sourceState } = helpers;
  const runtime = createRuntime(t);
  const db = runtime.database;
  let next = 7_000_000;
  const id = () => uuid(next++);
  const row = (table, key) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(key);
  function insert(table, value) {
    db.prepare(`INSERT INTO ${table} (${Object.keys(value).join(",")}) VALUES (${Object.keys(value).map(k => "@" + k).join(",")})`).run(value);
  }
  function clone(table, key, overrides) {
    const value = { ...row(table, key), id: id(), ...overrides };
    insert(table, value);
    return value;
  }
  const knownUsers = new Set([IDS.manager, IDS.receivingManager, IDS.commissioner]);
  const pass = (request, response, next) => next();
  const authenticate = (request, response, next) => knownUsers.has(request.get("x-test-user"))
    ? next() : response.status(401).json({ error: { code: "AUTH_REQUIRED" } });
  const thirdSeason = clone("seasons", IDS.futureSeason, { label: "2028-29", nhl_season_key: "20282029" });
  const tradeRouter = createTradeRouter({
    requestSecurity: {
      assignRequestId: pass, securityHeaders: pass, credentialedCors: pass,
      requireAllowedOrigin: pass, requireJson: pass, requireCompatibleFetchMetadata: pass,
      authenticateBootstrap: authenticate, authenticateUnsafe: authenticate,
      getRequestId: () => "local-trade-matrix",
      getSessionBootstrap: request => authenticated(request.get("x-test-user")),
      getAuthenticatedSession: request => authenticated(request.get("x-test-user")),
    },
    tradeReadService: runtime.readService,
    tradeProposalService: { list() { throw new Error("Unused matrix route"); } },
    tradeCreationService: runtime.service,
    tradeLifecycleService: runtime.lifecycleService,
    tradeAcceptancePreviewService: runtime.acceptancePreviewService,
    tradeAcceptanceService: runtime.acceptanceService,
  });
  const app = createTargetApplication({ routers: Object.fromEntries(
    TARGET_ROUTER_KEYS.map(key => [key, key === "trade" ? tradeRouter : (req, res) => res.sendStatus(404)])
  ) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/leagues/${IDS.league}/trades`;
  async function request(suffix, user, input, key, expected = 200) {
    const response = await fetch(base + suffix, {
      method: input === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-test-user": user,
        ...(key ? { "idempotency-key": key } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const body = await response.json();
    assert.equal(response.status, expected, `${suffix}: ${JSON.stringify(body)}`);
    assert.equal(body.error, undefined);
    return body.data;
  }

  function seedAsset(kind, teamId) {
    const expected = { kind, teamId, destination: teamId === IDS.teamA ? IDS.teamB : IDS.teamA };
    if (kind === "future_considerations") return { ...expected, assets: [{ type: "future_consideration_instruction", description: "A future consideration agreed by both managers" }] };
    if (kind === "existing_future_consideration") {
      const consideration = clone("future_considerations", IDS.futureConsideration, {
        receiving_team_id: teamId, owing_team_id: expected.destination,
      });
      return { ...expected, consideration, assets: [{ type: "future_consideration", futureConsiderationId: consideration.id }] };
    }
    if (kind === "draft_pick" || kind === "future_pick") {
      let draftId = IDS.entryDraft;
      if (kind === "future_pick") {
        let draft = db.prepare("SELECT id FROM entry_drafts WHERE season_id = ?").get(IDS.futureSeason);
        if (!draft) draft = clone("entry_drafts", IDS.entryDraft, { season_id: IDS.futureSeason, status: "setup", starts_at_ms: null, completed_at_ms: null });
        draftId = draft.id;
      }
      const pick = clone("draft_picks", IDS.draftPick, { draft_id: draftId, target_season_id: kind === "future_pick" ? IDS.futureSeason : IDS.currentSeason,
        current_owner_team_id: teamId, original_team_id: teamId, position_number: next, round_number: 2 });
      return { ...expected, pick, assets: [{ type: "draft_pick", draftPickId: pick.id }] };
    }
    const playerId = id().replace("-4000-", "-5000-");
    insertPlayer(runtime.repositories, playerId, `Matrix${next}`);
    if (kind === "buyout") {
      const contractId = id();
      insertContract(runtime.repositories, { id: contractId, yearId: id(), playerId, teamId, aavCents: 300, status: "eliminated" });
      const buyout = clone("buyout_obligations", IDS.buyout, { contract_id: contractId, player_id: playerId, originating_team_id: teamId,
        responsible_team_id: teamId, buyout_transaction_id: id() });
      clone("buyout_years", IDS.buyoutYear, { buyout_obligation_id: buyout.id });
      return { ...expected, buyout, assets: [{ type: "buyout_obligation", buyoutObligationId: buyout.id }] };
    }
    const prospect = kind.includes("prospect");
    const elc = kind === "signed_prospect" || kind === "active_elc";
    const category = prospect ? "Prospect" : kind === "bench_player" ? "Bench" : kind === "ir_player" ? "Injured Reserve" : "Active";
    const position = kind === "active_defence" ? "D" : "F";
    const slot = prospect ? null : db.prepare("SELECT COALESCE(MAX(slot_number), 0) + 1 n FROM player_ownerships WHERE team_id = ? AND roster_category = ? AND (? <> 'Active' OR position_group = ?)").get(teamId, category, category, position).n;
    const ownership = clone("player_ownerships", IDS.ownership, { player_id: playerId, team_id: teamId, ownership_kind: prospect ? "Prospect Right" : "Rostered",
      roster_category: category, position_group: position, slot_number: slot });
    let contract;
    if (kind !== "unsigned_prospect") {
      const contractId = id();
      insertContract(runtime.repositories, { id: contractId, yearId: id(), playerId, teamId, aavCents: elc ? 100 : 200, status: "active" });
      if (elc) {
        db.prepare("UPDATE contracts SET contract_type = 'fantasy_elc', original_total_value_cents = 300, original_term_years = 3 WHERE id = ?").run(contractId);
        for (const [seasonId, number] of [[IDS.futureSeason, 2], [thirdSeason.id, 3]]) {
          clone("contract_years", IDS.contractYear, { contract_id: contractId, season_id: seasonId, year_number: number, aav_cents: 100, status: "future" });
        }
      }
      else {
        db.prepare("UPDATE contracts SET original_total_value_cents = 400, original_term_years = 2, auction_buyout_lock_expires_at_ms = ? WHERE id = ?").run(NOW_MS + 86400000, contractId);
        clone("contract_years", IDS.contractYear, { contract_id: contractId, season_id: IDS.futureSeason, year_number: 2, aav_cents: 200, status: "future" });
      }
      contract = row("contracts", contractId);
    }
    const assets = prospect ? [{ type: "prospect_right", playerId }] : [{ type: "contract", contractId: contract.id }];
    if (kind === "retained_player") assets.push({ type: "requested_retention", contractId: contract.id, retainedAavCents: 100 });
    return { ...expected, playerId, ownership, contract, assets };
  }

  async function exercise(label, leftKinds, rightKinds, configure = () => {}) {
    await t.test(label, async () => {
      db.exec("SAVEPOINT trade_matrix_case");
      try {
        const left = leftKinds.map(kind => seedAsset(kind, IDS.teamA));
        const right = rightKinds.map(kind => seedAsset(kind, IDS.teamB));
        const holdings = [...left, ...right];
        configure({ left, right, holdings, seedAsset, db, runtime });
        const years = db.prepare("SELECT * FROM contract_years ORDER BY id").all();
        const buyoutYears = db.prepare("SELECT * FROM buyout_years ORDER BY id").all();
        const input = { proposingTeamId: IDS.teamA, receivingTeamId: IDS.teamB,
          proposingAssets: left.flatMap(a => a.assets), receivingAssets: right.flatMap(a => a.assets) };
        const proposed = await request("", IDS.manager, input, `create-${next++}`, 201);
        const tradeId = proposed.proposal.id;
        const beforePreview = db.serialize();
        const preview = await request(`/${tradeId}/acceptance-preview`, IDS.receivingManager);
        await request(`/${tradeId}`, IDS.receivingManager);
        assert.equal(beforePreview.equals(db.serialize()), true, "Preview and detail must not write");
        assert.equal(preview.generallyIllegal, false, JSON.stringify(preview.teams));
        const sourceBefore = sourceState(db);
        const acceptKey = `accept-${next++}`;
        let completed = await request(`/${tradeId}/accept`, IDS.receivingManager, {}, acceptKey);
        const needsApproval = holdings.some(a => a.assets.some(asset => asset.type.startsWith("future_consideration")));
        if (needsApproval) {
          assert.equal(completed.code, "TRADE_AWAITING_COMMISSIONER_APPROVAL");
          assert.equal(sourceState(db), sourceBefore, "Manager acceptance cannot transfer pending Future Considerations");
          const awaitingBytes = db.serialize();
          assert.equal((await request(`/${tradeId}/accept`, IDS.receivingManager, {}, acceptKey)).replayed, true);
          assert.equal(awaitingBytes.equals(db.serialize()), true);
          const approvalKey = `approve-${next++}`;
          completed = await request(`/${tradeId}/approve`, IDS.commissioner, {}, approvalKey);
          const approvedBytes = db.serialize();
          assert.equal((await request(`/${tradeId}/approve`, IDS.commissioner, {}, approvalKey)).replayed, true);
          assert.equal(approvedBytes.equals(db.serialize()), true);
        } else {
          assert.equal(completed.code, "TRADE_ACCEPTED");
          const completedBytes = db.serialize();
          assert.equal((await request(`/${tradeId}/accept`, IDS.receivingManager, {}, acceptKey)).replayed, true);
          assert.equal(completedBytes.equals(db.serialize()), true);
        }
        assert.equal(completed.proposal.storageStatus, "completed");
        assert.deepEqual(completed.teams, preview.teams);
        assert.equal((await request(`/${tradeId}`, IDS.receivingManager)).proposal.storageStatus, "completed");
        assert.deepEqual(db.prepare("SELECT * FROM contract_years ORDER BY id").all(), years);
        assert.deepEqual(db.prepare("SELECT * FROM buyout_years ORDER BY id").all(), buyoutYears);
        const considerations = db.prepare("SELECT owing_team_id, receiving_team_id, description FROM future_considerations WHERE originating_trade_id = ? ORDER BY owing_team_id, description").all(tradeId);
        const expectedConsiderations = holdings.filter(holding => holding.kind === "future_considerations")
          .map(holding => ({ owing_team_id: holding.teamId, receiving_team_id: holding.destination, description: holding.assets[0].description }));
        assert.deepEqual(considerations.map(value => JSON.stringify(value)).sort(), expectedConsiderations.map(value => JSON.stringify(value)).sort());
        for (const holding of holdings) {
          if (holding.playerId && holding.ownership) {
            const moved = db.prepare("SELECT * FROM player_ownerships WHERE player_id = ? AND league_id = ?").get(holding.playerId, IDS.league);
            assert.equal(moved.team_id, holding.destination);
            assert.notEqual(moved.id, holding.ownership.id);
            assert.equal(moved.version, 1);
            assert.equal(moved.roster_category, holding.kind.includes("prospect") ? "Prospect" : holding.expectedCategory ?? "Active");
          }
          if (holding.contract) {
            const actual = row("contracts", holding.contract.id);
            assert.deepEqual(actual, { ...holding.contract, current_team_id: holding.destination, updated_at_ms: NOW_MS, version: 2 });
          }
          if (holding.pick) assert.deepEqual(row("draft_picks", holding.pick.id), { ...holding.pick, current_owner_team_id: holding.destination, updated_at_ms: NOW_MS, version: 2 });
          if (holding.buyout) assert.deepEqual(row("buyout_obligations", holding.buyout.id), { ...holding.buyout, responsible_team_id: holding.destination, updated_at_ms: NOW_MS, version: 2 });
          if (holding.consideration) {
            const resolved = row("future_considerations", holding.consideration.id);
            const returnsToDebtor = holding.consideration.owing_team_id === holding.destination;
            assert.equal(resolved.status, returnsToDebtor ? "cancelled" : "outstanding");
            assert.equal(resolved.receiving_team_id, returnsToDebtor ? holding.teamId : holding.destination);
            assert.equal(resolved.description, holding.consideration.description);
          }
          if (holding.kind === "retained_player") {
            const retention = db.prepare("SELECT * FROM retention_obligations WHERE contract_id = ?").get(holding.contract.id);
            assert.equal(retention.responsible_team_id, holding.teamId);
            assert.equal(retention.retained_aav_cents, holding.retainedCents ?? 100);
            assert.equal(db.prepare("SELECT COUNT(*) n FROM retention_years WHERE retention_obligation_id = ?").get(retention.id).n, 2);
          }
        }
        assert.equal(db.prepare("SELECT COUNT(*) n FROM league_activity WHERE related_id = ? AND event_type = 'trade_completed'").get(tradeId).n, 1);
        assert.deepEqual(db.pragma("foreign_key_check"), []);
      } finally {
        db.exec("ROLLBACK TO trade_matrix_case; RELEASE trade_matrix_case");
      }
    });
  }
  const kinds = ["active_forward", "active_defence", "bench_player", "ir_player", "unsigned_prospect", "signed_prospect", "active_elc", "draft_pick", "future_pick", "buyout", "future_considerations", "existing_future_consideration", "retained_player"];
  for (const left of kinds) for (const right of kinds) await exercise(`${left} for ${right}`, [left], [right]);
  await exercise("mixed package with retention and commissioner approval", ["active_forward", "active_defence", "signed_prospect", "future_pick", "retained_player"], ["active_forward", "unsigned_prospect", "buyout", "future_considerations"]);
  await exercise("uneven multi-player exchange", ["active_forward", "active_forward", "active_defence"], ["future_pick"]);
  await exercise("full Active forwards use legal Bench placement", ["active_forward"], ["future_pick"], ({ left, seedAsset }) => {
    for (let i = 0; i < 12; i++) seedAsset("active_forward", IDS.teamB);
    left[0].expectedCategory = "Bench";
  });
  await exercise("outgoing defence frees the slot before incoming placement", ["active_defence"], ["active_defence"], ({ seedAsset }) => {
    for (let i = 0; i < 5; i++) seedAsset("active_defence", IDS.teamB);
  });
  await exercise("maximum legal prospect package", Array(100).fill("unsigned_prospect"), Array(100).fill("unsigned_prospect"));
  await exercise("maximum legal draft-pick package", Array(100).fill("future_pick"), Array(100).fill("future_pick"));
  await exercise("maximum legal Future Considerations descriptions", Array(100).fill("future_considerations"), Array(100).fill("future_considerations"), ({ holdings }) => {
    holdings.forEach((holding, index) => {
      holding.assets[0].description = (`Consideration ${index}: ` + "\u4ea4".repeat(500)).slice(0, 500);
    });
  });
  await exercise("one-cent retained salary remains exact", ["retained_player"], ["future_pick"], ({ left }) => {
    left[0].assets[1].retainedAavCents = 1;
    left[0].retainedCents = 1;
  });
  await exercise("an existing consideration owed by a third team changes creditor", ["existing_future_consideration"], ["future_pick"], ({ left }) => {
    const thirdTeam = clone("teams", IDS.teamA, { name: "Third team", name_normalized: "third team" });
    db.prepare("UPDATE future_considerations SET owing_team_id = ? WHERE id = ?").run(thirdTeam.id, left[0].consideration.id);
    left[0].consideration = row("future_considerations", left[0].consideration.id);
  });
  await t.test("stale pick ownership returns a clear conflict with no partial transfer", async () => {
    db.exec("SAVEPOINT stale_trade_matrix");
    try {
      const left = seedAsset("draft_pick", IDS.teamA), right = seedAsset("active_forward", IDS.teamB);
      const proposed = await request("", IDS.manager, { proposingTeamId: IDS.teamA, receivingTeamId: IDS.teamB,
        proposingAssets: left.assets, receivingAssets: right.assets }, `stale-create-${next++}`, 201);
      db.prepare("UPDATE draft_picks SET current_owner_team_id = ?, version = version + 1 WHERE id = ?").run(IDS.teamB, left.pick.id);
      const before = db.serialize();
      const response = await fetch(`${base}/${proposed.proposal.id}/accept`, { method: "POST",
        headers: { "content-type": "application/json", "x-test-user": IDS.receivingManager, "idempotency-key": `stale-accept-${next++}` }, body: "{}", signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "TRADE_REQUEST_CONFLICT");
      assert.equal(before.equals(db.serialize()), true);
    } finally { db.exec("ROLLBACK TO stale_trade_matrix; RELEASE stale_trade_matrix"); }
  });
}

module.exports = { runTradeAcceptanceMatrix };
