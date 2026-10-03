const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createFadDeadlineControlService } = require("../../src/application/services/freeAgentDraft/createFadDeadlineControlService");
const id = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const nowMs = 1_000_000;
const scope = { leagueId: id(1), fadId: id(2), authenticated: { current: true } };

function fixture() {
  const state = {
    draft: { id: scope.fadId, league_id: scope.leagueId, season_id: id(3), status: "cards_open",
      league_status: "active", candidate_deadline_at_ms: nowMs, participating_team_count: 1 },
    control: { mode: "held", version: 1 },
    cards: [{ teamId: id(4), teamName: "Team North", completeness: "incomplete", eligibility: "eligible", filled: 0, version: 1 }],
    jobs: [{ id: id(5), status: "pending", version: 3 }],
    nextRolloverAtMs: nowMs + 86_400_000,
  };
  let writes = 0;
  const service = createFadDeadlineControlService({
    repository: { state: () => state, transaction: work => work(), replay: () => null,
      proceed: () => { writes += 1; return { id: id(6) }; } },
    leagueAuthorization: { requireCommissioner(auth) {
      if (!auth?.current) throw Object.assign(new Error("Denied"), { code: "LEAGUE_COMMISSIONER_REQUIRED" });
      return { actorUserId: id(7), authority: "commissioner" };
    } },
    clock: { nowMs: () => nowMs },
  });
  return { state, service, writes: () => writes };
}

test("manual deadline processing refuses early, closed, frozen, missing and busy state", () => {
  for (const change of [
    f => { f.state.draft.candidate_deadline_at_ms = nowMs + 1; },
    f => { f.state.draft.status = "deadline_locked"; },
    f => { f.state.draft.league_status = "frozen"; },
    f => { f.state.cards = []; },
    f => { f.state.jobs = []; },
    f => { f.state.jobs.push({ id: id(8), status: "pending" }); },
    f => { f.state.jobs[0].status = "failed"; },
    f => { f.state.jobs[0].status = "running"; },
    f => { f.state.nextRolloverAtMs = nowMs + 3_600_000; },
    f => { f.state.nextRolloverAtMs = null; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(f.service.read(scope).canProceed, false);
    assert.throws(() => f.service.preview({ ...scope, input: { reason: "Proceed now" } }), { code: "FAD_DEADLINE_CONTROL_CONFLICT" });
    assert.equal(f.writes(), 0);
  }
});

test("deadline previews bind actor, reason and card version; malformed or stale confirmation never writes", () => {
  const f = fixture();
  const preview = f.service.preview({ ...scope, input: { reason: "Proceed now" } });
  const command = { ...scope, input: { reason: preview.reason, previewHash: preview.previewHash, confirmed: true }, idempotencyKey: "deadline-confirm-1" };
  assert.equal(f.writes(), 0);
  for (const reason of ["", "a", "x".repeat(501), "Line\nbreak"]) {
    assert.throws(() => f.service.preview({ ...scope, input: { reason } }), { code: "FAD_DEADLINE_CONTROL_INVALID" });
  }
  assert.throws(() => f.service.proceed({ ...command, input: { ...command.input, confirmed: false } }), { code: "FAD_DEADLINE_CONTROL_INVALID" });
  assert.throws(() => f.service.proceed({ ...command, authenticated: { current: false } }), { code: "LEAGUE_COMMISSIONER_REQUIRED" });
  f.state.cards[0].version += 1;
  assert.throws(() => f.service.proceed(command), { code: "FAD_DEADLINE_CONTROL_PREVIEW_CHANGED" });
  assert.equal(f.writes(), 0);
});


test('short rapid rounds use the configured nomination gap for manual processing',()=>{
 const f=fixture();f.state.nextRolloverAtMs=nowMs+900000;f.state.cutoffGapMs=0;assert.equal(f.service.read(scope).canProceed,true);
 f.state.cutoffGapMs=900000;assert.equal(f.service.read(scope).canProceed,false);
});
