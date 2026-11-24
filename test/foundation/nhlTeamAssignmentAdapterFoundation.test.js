const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createNhlTeamAssignmentAdapter } = require("../../src/infrastructure/nhl/NhlTeamAssignmentAdapter");
const NOW = Date.parse("2026-11-24T16:00:00Z");
const player = (number, team = "DET") => ({ playerId: `80000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  providerPlayerId: String(8477000 + number), nhlTeamAbbreviation: team });
const first = player(1), second = player(2, "VAN"), third = player(3, null);
const response = data => ({ ok: true, text: async () => JSON.stringify(data) });
function fixture({ index = [{ playerId: Number(first.providerPlayerId), teamAbbrev: "MTL" }],
  landing = {}, options = {}, fetchResponse } = {}) {
  const calls = [], delays = [];
  const adapter = createNhlTeamAssignmentAdapter({ nowMs: () => NOW, minIndexPlayers: 1,
    delay: async ms => { delays.push(ms); }, ...options,
    fetchImpl: async (url, settings) => {
      calls.push(url); assert.equal(settings.redirect, "error"); assert.ok(settings.signal);
      if (fetchResponse) return fetchResponse(url, settings);
      if (url.startsWith("https://search.d3.nhle.com/")) return response(index);
      const id = url.split("/").at(-2);
      return response({ playerId: Number(id), isActive: true, position: "C", currentTeamId: 8, currentTeamAbbrev: "MTL", ...landing });
    } });
  return { adapter, calls, delays };
}

test("team refresh confirms changed known players and preserves omitted and unchanged assignments", async () => {
  const f = fixture({ index: [{ playerId: Number(first.providerPlayerId), teamAbbrev: "MTL" },
    { playerId: Number(second.providerPlayerId), teamAbbrev: "VAN" }, { playerId: 8999999, teamAbbrev: "TOR" }] });
  const result = await f.adapter.fetchAssignments({ players: [third, second, first] });
  assert.deepEqual(result.assignments, [{ ...first, nhlTeamAbbreviation: "MTL" }]);
  assert.deepEqual(result.counts, { cataloguePlayers: 3, indexPlayers: 3, matchedPlayers: 2, unchangedPlayers: 1, omittedPlayers: 1, confirmedChanges: 1 });
  assert.equal(result.observedAtMs, NOW); assert.match(result.sourceVersion, /^[a-f0-9]{64}$/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0], "https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=50000&q=*&active=true");
});

test("verified landing wins over stale search teams and normalizes NHL aliases", async () => {
  const f = fixture({ landing: { currentTeamId: 26, currentTeamAbbrev: "LA" } });
  assert.equal((await f.adapter.fetchAssignments({ players: [first] })).assignments[0].nhlTeamAbbreviation, "LAK");
  const unchanged = fixture({ index: [{ playerId: Number(first.providerPlayerId), teamAbbrev: "LA" }] });
  assert.deepEqual((await unchanged.adapter.fetchAssignments({ players: [{ ...first, nhlTeamAbbreviation: "LAK" }] })).assignments, []);
  assert.equal(unchanged.calls.length, 1);
});

test("null team evidence and stale changed-index rows never clear or replace the saved assignment", async () => {
  for (const landing of [{ currentTeamId: null, currentTeamAbbrev: null, isActive: false },
    { currentTeamId: 17, currentTeamAbbrev: "DET" }]) {
    const f = fixture({ landing });
    const result = await f.adapter.fetchAssignments({ players: [first] });
    assert.deepEqual(result.assignments, []); assert.equal(result.counts.unchangedPlayers, 1);
  }
  const noTeam = fixture({ index: [{ playerId: Number(first.providerPlayerId), teamAbbrev: null }] });
  const result = await noTeam.adapter.fetchAssignments({ players: [first] });
  assert.deepEqual(result.assignments, []); assert.equal(result.counts.omittedPlayers, 1); assert.equal(noTeam.calls.length, 1);
});

test("team refresh rejects duplicate or conflicting identities before confirming any change", async () => {
  for (const index of [
    [{ playerId: Number(first.providerPlayerId), teamAbbrev: "MTL" }, { playerId: Number(first.providerPlayerId), teamAbbrev: "DET" }],
    [{ playerId: Number(first.providerPlayerId), id: 8999999, teamAbbrev: "MTL" }],
    [{ playerId: Number(first.providerPlayerId), teamAbbrev: "MTL", currentTeamAbbrev: "DET" }],
    [{ playerId: "https://internal", teamAbbrev: "MTL" }],
  ]) {
    const f = fixture({ index });
    await assert.rejects(f.adapter.fetchAssignments({ players: [first] }), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  await assert.rejects(f.adapter.fetchAssignments({ players: [first, first] }), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
  assert.equal(f.calls.length, 0);
});

test("team refresh rejects malformed identity, team, position and contradictory landing evidence", async () => {
  for (const landing of [{ playerId: 8999999 }, { currentTeamId: 17 }, { currentTeamAbbrev: "<script>" },
    { currentTeamId: null }, { position: "X" }, { isActive: undefined }]) {
    await assert.rejects(fixture({ landing }).adapter.fetchAssignments({ players: [first] }), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
  }
});

test("existing catalogue goalies receive team-only assignments without position changes or imports", async () => {
  const f = fixture({ landing: { position: "G" } });
  const result = await f.adapter.fetchAssignments({ players: [first] });
  assert.deepEqual(result.assignments, [{ ...first, nhlTeamAbbreviation: "MTL" }]);
  assert.deepEqual(first, player(1));
  assert.deepEqual(Object.keys(result.assignments[0]).sort(), ["nhlTeamAbbreviation", "playerId", "providerPlayerId"]);
});

test("historical Arizona labels never become new current assignments", async () => {
  const historicalIndex = fixture({ index: [{ playerId: first.providerPlayerId, teamAbbrev: "ARI" }] });
  assert.deepEqual((await historicalIndex.adapter.fetchAssignments({ players: [first] })).assignments, []);
  assert.equal(historicalIndex.calls.length, 1);
  const historicalLanding = fixture({ landing: { currentTeamId: 53, currentTeamAbbrev: "ARI" } });
  assert.deepEqual((await historicalLanding.adapter.fetchAssignments({ players: [first] })).assignments, []);
  const current = fixture({ landing: { currentTeamId: 68, currentTeamAbbrev: "UTA" } });
  assert.equal((await current.adapter.fetchAssignments({ players: [{ ...first, nhlTeamAbbreviation: "ARI" }] })).assignments[0].nhlTeamAbbreviation, "UTA");
});

test("Utah assignments require the verified NHL team identifier 68", async () => {
  const index = [{ playerId: first.providerPlayerId, teamAbbrev: "UTA", teamId: "68" }];
  const current = fixture({ index, landing: { currentTeamId: 68, currentTeamAbbrev: "UTA" } });
  assert.deepEqual((await current.adapter.fetchAssignments({ players: [first] })).assignments, [{ ...first, nhlTeamAbbreviation: "UTA" }]);
  const wrongId = fixture({ index, landing: { currentTeamId: 59, currentTeamAbbrev: "UTA" } });
  await assert.rejects(wrongId.adapter.fetchAssignments({ players: [first] }), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
});

test("bulk size, completeness and change-count guards fail without partial assignments", async () => {
  for (const configuration of [
    { index: [] }, { index: { docs: [{ playerId: Number(first.providerPlayerId), teamAbbrev: "MTL" }], total: 2 } },
    { options: { maxResponseBytes: 5 } },
    { index: [first, second].map(row => ({ playerId: row.providerPlayerId, teamAbbrev: "MTL" })), options: { maxIndexPlayers: 1 } },
    { index: [first, second].map(row => ({ playerId: row.providerPlayerId, teamAbbrev: "MTL" })), options: { maxChangedPlayers: 1 } },
  ]) {
    const f = fixture(configuration);
    await assert.rejects(f.adapter.fetchAssignments({ players: [first, second] }), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
    assert.equal(f.calls.length, 1);
  }
});

test("team requests have bounded request and whole-refresh timeouts", async () => {
  for (const options of [{ timeoutMs: 10, maxDurationMs: 50 }, { timeoutMs: 50, maxDurationMs: 10 }]) {
    const f = fixture({ options, fetchResponse: () => new Promise(() => {}) });
    await assert.rejects(f.adapter.fetchAssignments({ players: [first] }), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
  }
});

test("oversized streamed provider responses are cancelled and rejected", async () => {
  let cancelled = 0;
  const f = fixture({ options: { maxResponseBytes: 8 }, fetchResponse: () => ({ ok: true,
    body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(9) }), cancel: async () => { cancelled++; } }) } }) });
  await assert.rejects(f.adapter.fetchAssignments({ players: [first] }), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
  assert.equal(cancelled, 1);
});

test("landing confirmations are paced and use at most two concurrent requests", async () => {
  let active = 0, maximum = 0;
  const players = [first, player(2), player(3), player(4)], delays = [];
  const index = players.map(row => ({ playerId: row.providerPlayerId, teamAbbrev: "MTL" }));
  const adapter = createNhlTeamAssignmentAdapter({ nowMs: () => NOW, minIndexPlayers: 1,
    delay: async ms => { delays.push(ms); }, fetchImpl: async url => {
      if (url.startsWith("https://search.d3.nhle.com/")) return response(index);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return response({ playerId: Number(url.split("/").at(-2)), isActive: true, position: "C", currentTeamId: 8, currentTeamAbbrev: "MTL" });
    } });
  assert.equal((await adapter.fetchAssignments({ players })).assignments.length, 4);
  assert.equal(maximum, 2); assert.deepEqual(delays, [350, 350, 350]);
});

test("empty known-player set does not fetch or invent catalogue entries", async () => {
  const f = fixture();
  const result = await f.adapter.fetchAssignments({ players: [] });
  assert.deepEqual(result.assignments, []); assert.equal(f.calls.length, 0); assert.equal(result.counts.cataloguePlayers, 0);
});

test("team snapshot keeps its fetch-start timestamp when the clock advances during provider requests", async () => {
  let now = NOW;
  const f = fixture({ options: { nowMs: () => now }, fetchResponse: url => {
    now += 1000;
    return response(url.startsWith("https://search.d3.nhle.com/")
      ? [{ playerId: first.providerPlayerId, teamAbbrev: "MTL" }]
      : { playerId: Number(first.providerPlayerId), isActive: true, position: "C", currentTeamId: 8, currentTeamAbbrev: "MTL" });
  } });
  const result = await f.adapter.fetchAssignments({ players: [first] });
  assert.equal(now, NOW + 2000);
  assert.equal(result.observedAtMs, NOW);
  // A source update made after the request began remains newer than this
  // snapshot, allowing the persistence timestamp guard to reject the write.
  assert.ok(result.observedAtMs < NOW + 500);
  assert.deepEqual(result.assignments, [{ ...first, nhlTeamAbbreviation: "MTL" }]);
});

test("team snapshot rejects a clock that moves before its fetch-start timestamp", async () => {
  let now = NOW;
  const f = fixture({ options: { nowMs: () => now }, fetchResponse: url => {
    now = NOW - 1000;
    return response(url.startsWith("https://search.d3.nhle.com/")
      ? [{ playerId: first.providerPlayerId, teamAbbrev: "MTL" }]
      : { playerId: Number(first.providerPlayerId), isActive: true, position: "C", currentTeamId: 8, currentTeamAbbrev: "MTL" });
  } });
  await assert.rejects(f.adapter.fetchAssignments({ players: [first] }), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" });
  assert.equal(f.calls.length, 2);
});
