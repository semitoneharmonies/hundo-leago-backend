const { createHash } = require("node:crypto");

const INDEX_URL = "https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=50000&q=*&active=true";
const TEAM_IDS = Object.freeze({ NJD: 1, NYI: 2, NYR: 3, PHI: 4, PIT: 5, BOS: 6, BUF: 7, MTL: 8, OTT: 9, TOR: 10,
  CAR: 12, FLA: 13, TBL: 14, WSH: 15, CHI: 16, DET: 17, NSH: 18, STL: 19, CGY: 20, COL: 21, EDM: 22,
  VAN: 23, ANA: 24, DAL: 25, LAK: 26, SJS: 28, CBJ: 29, MIN: 30, WPG: 52, ARI: 53, VGK: 54, SEA: 55, UTA: 68 });
const ALIASES = Object.freeze({ LA: "LAK", NJ: "NJD", SJ: "SJS", TB: "TBL", MON: "MTL", WAS: "WSH", CLB: "CBJ", UTAH: "UTA" });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function unavailable() { return Object.assign(new Error("NHL team assignments could not be verified."), { code: "NHL_TEAM_ASSIGNMENTS_UNAVAILABLE" }); }
function check(value) { if (!value) throw unavailable(); }
function identity(value) {
  check((typeof value === "string" || Number.isSafeInteger(value)) && /^[1-9]\d{0,12}$/.test(String(value)));
  return String(value);
}
function team(value) {
  if (value === null || value === undefined || value === "") return null;
  check(typeof value === "string");
  const normalized = value.trim().toUpperCase();
  if (["", "N/A", "FA", "UFA"].includes(normalized)) return null;
  const result = ALIASES[normalized] || normalized;
  check(Object.hasOwn(TEAM_IDS, result));
  return result;
}

function createNhlTeamAssignmentAdapter({ fetchImpl = fetch, nowMs = Date.now, timeoutMs = 8000,
  maxDurationMs = 240_000, maxResponseBytes = 4_000_000, minIndexPlayers = 500, maxIndexPlayers = 5000,
  maxChangedPlayers = 250, requestSpacingMs = 350, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (const value of [timeoutMs, maxDurationMs, maxResponseBytes, maxIndexPlayers, maxChangedPlayers]) check(Number.isSafeInteger(value) && value > 0);
  check(Number.isSafeInteger(minIndexPlayers) && minIndexPlayers >= 0 && minIndexPlayers <= maxIndexPlayers);
  check(Number.isSafeInteger(requestSpacingMs) && requestSpacingMs >= 0);
  check(typeof fetchImpl === "function" && typeof nowMs === "function" && typeof delay === "function");

  async function json(url, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timer;
    try {
      check(!signal.aborted);
      return await Promise.race([(async () => {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: "error",
          headers: { Accept: "application/json", "User-Agent": "hundo-leago/1.0" } });
        check(response.ok);
        const declaredLength = response.headers?.get?.("content-length");
        if (declaredLength !== null && declaredLength !== undefined) check(/^\d+$/.test(declaredLength) && Number(declaredLength) <= maxResponseBytes);
        let body = "", bytes = 0;
        if (response.body?.getReader) {
          const reader = response.body.getReader(), decoder = new TextDecoder();
          try {
            while (true) {
              check(!signal.aborted);
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              check(bytes <= maxResponseBytes);
              body += decoder.decode(chunk.value, { stream: true });
            }
            body += decoder.decode();
          } finally { await reader.cancel().catch(() => {}); }
        } else {
          body = await response.text();
          check(Buffer.byteLength(body, "utf8") <= maxResponseBytes);
        }
        return JSON.parse(body);
      })(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs);
      })]);
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort); }
  }

  async function fetchAssignments({ players } = {}) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([(async () => {
        check(Array.isArray(players) && players.length <= 20_000);
        const ids = new Set(), providerIds = new Set();
        const known = players.map(player => {
          check(player && UUID.test(player.playerId) && !ids.has(player.playerId));
          const providerPlayerId = identity(player.providerPlayerId);
          check(!providerIds.has(providerPlayerId));
          ids.add(player.playerId); providerIds.add(providerPlayerId);
          return { playerId: player.playerId, providerPlayerId, nhlTeamAbbreviation: team(player.nhlTeamAbbreviation) };
        }).sort((a, b) => a.playerId.localeCompare(b.playerId));
        const startedAtMs = nowMs();
        check(Number.isSafeInteger(startedAtMs) && startedAtMs >= 0);
        const payload = known.length ? await json(INDEX_URL, controller.signal) : [];
        const rows = Array.isArray(payload) ? payload : payload?.docs;
        check(Array.isArray(rows) && rows.length <= maxIndexPlayers && (!known.length || rows.length >= minIndexPlayers));
        if (!Array.isArray(payload) && payload.total !== undefined) check(payload.total === rows.length);
        const index = new Map();
        for (const row of rows) {
          check(row && typeof row === "object" && !Array.isArray(row));
          const id = identity(row.playerId ?? row.id);
          if (row.playerId !== undefined && row.id !== undefined) check(identity(row.id) === id);
          check(!index.has(id));
          const values = [row.teamAbbrev, row.teamAbbreviation, row.triCode, row.currentTeamAbbrev].filter(value => value !== undefined);
          const teams = values.map(team);
          check(teams.every(value => value === teams[0]));
          // Former franchises may remain on historical records, but cannot
          // establish a new current NHL assignment.
          index.set(id, teams[0] === "ARI" ? null : teams[0] ?? null);
        }
        const matched = known.filter(player => index.get(player.providerPlayerId) !== undefined && index.get(player.providerPlayerId) !== null);
        const changed = matched.filter(player => index.get(player.providerPlayerId) !== player.nhlTeamAbbreviation);
        check(changed.length <= maxChangedPlayers);
        let next = 0, gate = Promise.resolve(), lastRequestAtMs = null;
        const assignments = [];
        async function worker() {
          while (next < changed.length) {
            const player = changed[next++];
            const turn = gate.then(async () => {
              check(!controller.signal.aborted);
              if (lastRequestAtMs !== null) await delay(Math.max(0, lastRequestAtMs + requestSpacingMs - nowMs()));
              check(!controller.signal.aborted);
              lastRequestAtMs = nowMs();
            });
            gate = turn;
            await turn;
            const landing = await json(`https://api-web.nhle.com/v1/player/${player.providerPlayerId}/landing`, controller.signal);
            // Existing catalogue goalies also need current team metadata. This
            // projection never imports players or changes position/eligibility.
            check(identity(landing?.playerId) === player.providerPlayerId && typeof landing.isActive === "boolean" && ["C", "L", "R", "LW", "RW", "D", "G"].includes(landing.position));
            const nhlTeamAbbreviation = team(landing.currentTeamAbbrev);
            if (nhlTeamAbbreviation === "ARI") continue;
            if (nhlTeamAbbreviation === null || landing.currentTeamId === null || landing.currentTeamId === undefined) {
              check(nhlTeamAbbreviation === null && (landing.currentTeamId === null || landing.currentTeamId === undefined));
              continue;
            }
            check(identity(landing.currentTeamId) === String(TEAM_IDS[nhlTeamAbbreviation]));
            if (nhlTeamAbbreviation !== player.nhlTeamAbbreviation) assignments.push({ playerId: player.playerId, providerPlayerId: player.providerPlayerId, nhlTeamAbbreviation });
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, changed.length) }, worker));
        assignments.sort((a, b) => a.playerId.localeCompare(b.playerId));
        const completedAtMs = nowMs();
        check(Number.isSafeInteger(completedAtMs) && completedAtMs >= startedAtMs && !controller.signal.aborted);
        const counts = { cataloguePlayers: known.length, indexPlayers: rows.length, matchedPlayers: matched.length,
          unchangedPlayers: matched.length - assignments.length, omittedPlayers: known.length - matched.length, confirmedChanges: assignments.length };
        // Preserve a newer source edit made while these provider requests ran.
        return { observedAtMs: startedAtMs, sourceVersion: createHash("sha256").update(JSON.stringify(assignments)).digest("hex"), assignments, counts };
      })(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, maxDurationMs);
      })]);
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return Object.freeze({ fetchAssignments });
}

module.exports = { createNhlTeamAssignmentAdapter };
