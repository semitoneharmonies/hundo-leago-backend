const CATEGORIES = Object.freeze(["Active", "Bench", "Injured Reserve"]);
const MAX_SEARCH_NODES = 12_000_000;

function blocked(code) {
  return Object.freeze({ status: "blocked", reasonCodes: Object.freeze([code]),
    assignments: Object.freeze([]), metrics: null });
}

function amount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Each normal-roster player stays owned and keeps the same contract. Search
// Active/inactive subsets; at most eight players can be inactive. Choosing the
// Bench/IR allocation within a subset is a small, exact minimum-change problem.
function solveRosterRepair(input, { maxSearchNodes = MAX_SEARCH_NODES } = {}) {
  if (!input || !Array.isArray(input.players) || typeof input.scheduleAvailable !== "boolean" ||
      !amount(input.capLimitCents) || !amount(input.fixedObligationsCents) ||
      !Number.isSafeInteger(maxSearchNodes) || maxSearchNodes < 1 || maxSearchNodes > MAX_SEARCH_NODES) {
    return blocked("ROSTER_REPAIR_INPUT_INVALID");
  }
  if (input.players.length > 26) return blocked("ROSTER_REPAIR_ROSTER_TOO_LARGE");
  const ids = new Set();
  const players = [];
  for (const row of input.players) {
    if (!row || typeof row.playerId !== "string" || !row.playerId.trim() || ids.has(row.playerId) ||
        !CATEGORIES.includes(row.rosterCategory) || !["F", "D"].includes(row.positionGroup) ||
        !amount(row.aavCents) || !amount(row.retainedAavCents) || row.retainedAavCents > row.aavCents ||
        typeof row.irEligible !== "boolean" || !["healthy", "injured", "unknown"].includes(row.injuryStatus) ||
        (input.scheduleAvailable && !amount(row.scheduledGames))) {
      return blocked("ROSTER_REPAIR_PLAYER_INVALID");
    }
    ids.add(row.playerId);
    players.push({ ...row, cost: row.aavCents - row.retainedAavCents,
      games: input.scheduleAvailable && row.injuryStatus !== "injured" ? row.scheduledGames : 0,
      bench: row.aavCents <= 400,
      // Existing unknown IR is allowed by the current legality policy. New IR
      // placement still requires authoritative eligibility; healthy always fails.
      ir: row.injuryStatus !== "healthy" && (row.irEligible || row.rosterCategory === "Injured Reserve") });
  }
  players.sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
  const budget = input.capLimitCents - input.fixedObligationsCents;
  if (budget < 0) return blocked("ROSTER_REPAIR_NO_LEGAL_PLAN");
  const suffixGames = Array(players.length + 1).fill(0);
  for (let index = players.length - 1; index >= 0; index -= 1) {
    suffixGames[index] = suffixGames[index + 1] + players[index].games;
    if (!Number.isSafeInteger(suffixGames[index])) return blocked("ROSTER_REPAIR_PLAYER_INVALID");
  }
  let best = null, nodes = 0, exhausted = false;
  const inactive = [];
  const destinations = Array(players.length).fill("Active");

  function consider({ cost, games, activeInjured, activeMoves, forwards, defence, benchOnly, irOnly }) {
    const flexible = inactive.filter(index => players[index].bench && players[index].ir);
    flexible.sort((a, b) => {
      const delta = index => Number(players[index].rosterCategory !== "Injured Reserve") - Number(players[index].rosterCategory !== "Bench");
      // A stable-ID tie keeps the earlier player in the earlier category.
      return delta(a) - delta(b) || b - a;
    });
    const minimumIr = Math.max(0, benchOnly + flexible.length - 4);
    const maximumIr = Math.min(flexible.length, 4 - irOnly);
    for (let count = minimumIr; count <= maximumIr; count += 1) {
      let moves = activeMoves;
      for (const index of inactive) destinations[index] = players[index].bench ? "Bench" : "Injured Reserve";
      for (let index = 0; index < count; index += 1) destinations[flexible[index]] = "Injured Reserve";
      for (const index of inactive) moves += Number(destinations[index] !== players[index].rosterCategory);
      if (best && (games < best.games ||
          (games === best.games && input.scheduleAvailable && activeInjured > best.activeInjured) ||
          (games === best.games && (!input.scheduleAvailable || activeInjured === best.activeInjured) && moves > best.moves))) continue;
      const signature = destinations.map(category => CATEGORIES.indexOf(category)).join("");
      if (best && games === best.games && (!input.scheduleAvailable || activeInjured === best.activeInjured) &&
          moves === best.moves && signature >= best.signature) continue;
      best = { games, activeInjured, moves, signature, cost, forwards, defence,
        bench: benchOnly + flexible.length - count, ir: irOnly + count, destinations: [...destinations] };
    }
    for (const index of inactive) destinations[index] = "Active";
  }

  function search(index, forwards, defence, cost, games, activeInjured, activeMoves, benchOnly, irOnly, inactiveMoveFloor) {
    nodes += 1;
    if (nodes > maxSearchNodes) { exhausted = true; return; }
    if (forwards > 12 || defence > 6 || cost > budget || inactive.length > 8 || benchOnly > 4 || irOnly > 4) return;
    if (players.length - index > (12 - forwards) + (6 - defence) + (8 - inactive.length)) return;
    if (best) {
      const possibleGames = games + suffixGames[index];
      if (possibleGames < best.games) return;
      if (possibleGames === best.games) {
        if (input.scheduleAvailable && activeInjured > best.activeInjured) return;
        if ((!input.scheduleAvailable || activeInjured === best.activeInjured) && activeMoves + inactiveMoveFloor > best.moves) return;
      }
    }
    if (index === players.length) {
      consider({ cost, games, activeInjured, activeMoves, forwards, defence, benchOnly, irOnly });
      return;
    }
    const player = players[index];
    search(index + 1, forwards + Number(player.positionGroup === "F"), defence + Number(player.positionGroup === "D"),
      cost + player.cost, games + player.games, activeInjured + Number(player.injuryStatus === "injured"),
      activeMoves + Number(player.rosterCategory !== "Active"), benchOnly, irOnly, inactiveMoveFloor);
    if (exhausted) return;
    if (player.bench || player.ir) {
      inactive.push(index);
      search(index + 1, forwards, defence, cost, games, activeInjured, activeMoves,
        benchOnly + Number(player.bench && !player.ir), irOnly + Number(player.ir && !player.bench),
        inactiveMoveFloor + Number(player.rosterCategory === "Active" ||
          (player.rosterCategory === "Bench" && !player.bench) || (player.rosterCategory === "Injured Reserve" && !player.ir)));
      inactive.pop();
    }
  }

  search(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  if (exhausted) return blocked("ROSTER_REPAIR_SEARCH_LIMIT");
  if (!best) return blocked("ROSTER_REPAIR_NO_LEGAL_PLAN");
  return Object.freeze({ status: "plan", reasonCodes: Object.freeze([]),
    assignments: Object.freeze(players.map((player, index) => Object.freeze({ playerId: player.playerId, rosterCategory: best.destinations[index] }))),
    metrics: Object.freeze({ scheduleAvailable: input.scheduleAvailable, scheduledGames: input.scheduleAvailable ? best.games : null,
      moveCount: best.moves, activeInjured: best.activeInjured, activeForwards: best.forwards, activeDefence: best.defence,
      active: best.forwards + best.defence, bench: best.bench, injuredReserve: best.ir,
      capUsageCents: best.cost + input.fixedObligationsCents, capLimitCents: input.capLimitCents }) });
}

module.exports = Object.freeze({ solveRosterRepair, MAX_SEARCH_NODES });
