const { createHash } = require("node:crypto");
const { assertNhlSeasonKey } = require("../../domain/statistics/statisticsPolicy");

const PROVIDER_NAME = "nhl-completed-games";
const PLAYER_IDENTITY_PROVIDER = "nhl";
const STATS_ORIGIN = "https://api.nhle.com";
const WEB_ORIGIN = "https://api-web.nhle.com";
const DAY_MS = 86_400_000;
const STATES = Object.freeze({ FUT: "scheduled", PRE: "pre_game", LIVE: "in_progress", CRIT: "in_progress", FINAL: "final", OFF: "final" });

function fail(message, code = "NHL_COMPLETED_SNAPSHOT_INVALID") {
  throw Object.assign(new Error(message), { code });
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`NHL ${label} is invalid.`);
  return value;
}
function identity(value) {
  const result = String(value);
  if (!/^[1-9][0-9]{0,12}$/.test(result)) fail("An NHL identity is invalid.");
  return result;
}
function easternStart(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) fail("An NHL game start is invalid.");
  const target = Date.parse(`${value}Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const p = Object.fromEntries(formatter.formatToParts(candidate).map(({ type, value: part }) => [type, part]));
    const actual = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (actual === target) return candidate;
    candidate += target - actual;
  }
  fail("An NHL game start is ambiguous.");
}

function createNhlCompletedGameAdapter({ fetchImpl = fetch, nowMs = Date.now, readCatalogPlayers, timeoutMs = 20_000, retryDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof fetchImpl !== "function" || typeof nowMs !== "function" || typeof readCatalogPlayers !== "function" || typeof retryDelay !== "function") throw new TypeError("NHL completed-game statistics require fetch, clock and catalog readers.");
  integer(timeoutMs, "request timeout", 1);
  let gameStateSnapshot = null;
  let webRequestGate = Promise.resolve();
  let lastWebRequestAtMs = null;

  async function paceWebRequest() {
    const previous = webRequestGate;
    let release;
    webRequestGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const delayMs = lastWebRequestAtMs === null ? 0 : Math.max(0, lastWebRequestAtMs + 350 - nowMs());
      if (delayMs > 0) await retryDelay(delayMs);
      lastWebRequestAtMs = nowMs();
    } finally { release(); }
  }

  function rateLimitDelay(response) {
    const raw = response.headers?.get?.("retry-after");
    const seconds = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;
    const date = typeof raw === "string" ? Date.parse(raw) : NaN;
    const delayMs = seconds !== null ? seconds * 1000 : Number.isFinite(date) ? date - nowMs() : 30_000;
    // A long provider hold must fail this capture instead of retrying before it expires.
    if (delayMs > 60_000) fail("The NHL service requires a later refresh.", "NHL_COMPLETED_REQUEST_RATE_LIMITED");
    return Math.max(1000, delayMs);
  }

  async function json(url) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (new URL(url).origin === WEB_ORIGIN) await paceWebRequest();
        const response = await fetchImpl(url, { headers: { "User-Agent": "hundo-leago/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
        if (!response.ok) {
          if (response.status === 429) throw Object.assign(new Error("NHL service temporarily unavailable."), { retryAfterMs: rateLimitDelay(response) });
          if (response.status >= 500) throw new Error("NHL service temporarily unavailable.");
          fail("The NHL request was rejected.", "NHL_COMPLETED_REQUEST_REJECTED");
        }
        return await response.json();
      } catch (error) {
        const rejectedContract = typeof error.code === "string" && error.code.startsWith("NHL_");
        if (rejectedContract || attempt === 2 || error instanceof SyntaxError) throw error;
        await retryDelay(error.retryAfterMs ?? 250 * (2 ** attempt));
      }
    }
  }

  async function pages(resource, expression, { aggregate = false } = {}) {
    const sort = resource === "game"
      ? [{ property: "id", direction: "ASC" }]
      : [{ property: "playerId", direction: "ASC" }, { property: "gameId", direction: "ASC" }];
    async function readPage(start, expectedTotal = null) {
      const query = new URLSearchParams({ start: String(start), limit: "100", cayenneExp: expression, sort: JSON.stringify(sort) });
      if (resource !== "game") { query.set("isAggregate", String(aggregate)); query.set("isGame", "true"); }
      const page = await json(`${STATS_ORIGIN}/stats/rest/en/${resource}?${query}`);
      integer(page?.total, "page total");
      if (page.total > 200_000) fail("The NHL response exceeded its bounded page count.");
      if (!Array.isArray(page.data) || (expectedTotal !== null && page.total !== expectedTotal)) fail("NHL pagination changed during the refresh.");
      if (page.data.length !== Math.min(100, page.total - start)) fail("The NHL response is incomplete.");
      return page;
    }
    const first = await readPage(0);
    const result = [...first.data];
    // Bounded parallel reads keep a complete season within the capture window.
    for (let start = 100; start < first.total; start += 400) {
      const offsets = [start, start + 100, start + 200, start + 300].filter((offset) => offset < first.total);
      const batch = await Promise.all(offsets.map((offset) => readPage(offset, first.total)));
      for (const page of batch) result.push(...page.data);
    }
    return result;
  }

  async function boxscore(game, season) {
    const box = await json(`${WEB_ORIGIN}/v1/gamecenter/${game.id}/boxscore`);
    if (identity(box?.id) !== game.id || String(box.season) !== season || box.gameType !== 2 || Date.parse(box.startTimeUTC) !== game.startsAtMs || identity(box.homeTeam?.id) !== game.homeTeamId || identity(box.awayTeam?.id) !== game.awayTeamId) fail("The NHL boxscore does not match its season and scheduled game.");
    const state = box.gameScheduleState === "PPD" ? "postponed" : STATES[box.gameState];
    if (!state) fail("The NHL game state is unsupported.");
    const players = new Map();
    if (state === "final") {
      for (const side of ["homeTeam", "awayTeam"]) {
        const stats = box.playerByGameStats?.[side];
        if (!Array.isArray(stats?.forwards) || !Array.isArray(stats?.defense)) fail("A completed NHL boxscore has no complete skater list.");
        const teamPlayers = [...stats.forwards, ...stats.defense];
        if (teamPlayers.length < 1) fail("A completed NHL boxscore has no skaters.");
        for (const row of teamPlayers) {
          const id = identity(row.playerId);
          if (players.has(id)) fail("An NHL boxscore repeats a skater.");
          const goals = integer(row.goals, "goals"), assists = integer(row.assists, "assists");
          if (row.points !== goals + assists) fail("An NHL boxscore has inconsistent points.");
          players.set(id, { goals, assists, teamId: identity(box[side].id) });
        }
      }
    }
    return { game, state, players };
  }

  async function fetchLiveSnapshot({ nhlSeasonKey, requiredPlayers, requiredPlayerGames = [] } = {}) {
    const season = assertNhlSeasonKey(nhlSeasonKey);
    const startedAtMs = integer(nowMs(), "capture time");
    if (!Array.isArray(requiredPlayers) || !Array.isArray(requiredPlayerGames)) fail("Required NHL identities are missing.");
    const catalog = readCatalogPlayers();
    if (!Array.isArray(catalog) || catalog.length === 0) fail("The NHL player catalog is unavailable.");
    const totals = new Map();
    for (const player of catalog) {
      const id = identity(player.providerPlayerId);
      if (totals.has(id)) fail("The NHL catalog contains duplicate identities.");
      totals.set(id, { playerId: id, gamesPlayed: 0, goals: 0, assists: 0 });
    }
    for (const required of requiredPlayers) if (!totals.has(identity(required.providerPlayerId))) fail("A required NHL player is missing from the catalog.");
    const rawGames = await pages("game", `season=${season} and gameType=2`);
    if (rawGames.length === 0) fail("The NHL season schedule is unavailable.");
    const games = new Map();
    for (const row of rawGames) {
      const id = identity(row.id);
      if (String(row.season) !== season || row.gameType !== 2 || games.has(id)) fail("NHL schedule identities are inconsistent.");
      games.set(id, { id, startsAtMs: easternStart(row.easternStartTime), homeTeamId: identity(row.homeTeamId), awayTeamId: identity(row.visitingTeamId), final: row.gameStateId === 7 });
    }
    const completed = [...games.values()].filter((game) => game.final);
    const appearancesByPlayer = new Map();
    if (completed.some((game) => game.startsAtMs > startedAtMs)) fail("A completed NHL game starts in the future.");
    // Restrict rows to explicitly completed games and verify each game, including zero scorers.
    for (let offset = 0; offset < completed.length; offset += 200) {
      const batch = completed.slice(offset, offset + 200);
      const rows = await pages("skater/summary", `gameId in (${batch.map(({ id }) => id).join(",")})`);
      if (rows.length === 0) fail("Completed NHL games have no statistics.");
      const seen = new Set();
      const appearances = new Map(batch.map(({ id }) => [id, 0]));
      for (const row of rows) {
        const id = identity(row.playerId);
        const gameId = identity(row.gameId);
        const pair = `${gameId}:${id}`;
        if (seen.has(pair) || !appearances.has(gameId)) fail("NHL statistics repeat a player-game or include an unrequested game.");
        seen.add(pair);
        const gp = integer(row.gamesPlayed, "games played", 1), goals = integer(row.goals, "goals"), assists = integer(row.assists, "assists");
        if (gp !== 1 || row.points !== goals + assists) fail("NHL game statistics are inconsistent.");
        appearances.set(gameId, appearances.get(gameId) + 1);
        const total = totals.get(id);
        if (total) { total.gamesPlayed += gp; total.goals += goals; total.assists += assists; }
        if (!["H", "R"].includes(row.homeRoad)) fail("An NHL player-game team is missing.");
        const game = games.get(gameId);
        const playerAppearances = appearancesByPlayer.get(id) || [];
        playerAppearances.push({ game, teamId: row.homeRoad === "H" ? game.homeTeamId : game.awayTeamId, goals, assists });
        appearancesByPlayer.set(id, playerAppearances);
      }
      if ([...appearances.values()].some((count) => count < 30 || count > 40)) fail("Completed NHL game coverage is incomplete.");
    }
    const boxscores = new Map();
    const getBox = async (game) => {
      if (!boxscores.has(game.id)) boxscores.set(game.id, await boxscore(game, season));
      return boxscores.get(game.id);
    };
    const coverage = [], playerGameRows = [];
    const landings = new Map();
    for (let offset = 0; offset < requiredPlayers.length; offset += 4) {
      await Promise.all(requiredPlayers.slice(offset, offset + 4).map(async (player) => {
        const id = identity(player.providerPlayerId);
        landings.set(id, await json(`${WEB_ORIGIN}/v1/player/${id}/landing`));
      }));
    }
    for (const player of requiredPlayers) {
      const playerId = identity(player.providerPlayerId);
      const landing = landings.get(playerId);
      if (identity(landing?.playerId) !== playerId || !["C", "L", "R", "D"].includes(landing.position)) fail("NHL player identity or position is invalid.");
      const teamId = landing.currentTeamId == null ? null : identity(landing.currentTeamId);
      if (teamId === null && landing.isActive !== false) fail("The NHL player has no affirmative team disposition.");
      const selected = new Map((appearancesByPlayer.get(playerId) || []).map((entry) => [entry.game.id, entry]));
      for (const game of games.values()) {
        if (!selected.has(game.id) && game.startsAtMs >= startedAtMs - 8 * DAY_MS && game.startsAtMs <= startedAtMs + DAY_MS && (game.homeTeamId === teamId || game.awayTeamId === teamId)) selected.set(game.id, { game, teamId });
      }
      for (const required of requiredPlayerGames.filter((row) => row.playerId === player.playerId)) {
        const game = games.get(String(required.nhlGameId));
        const historicalTeam = identity(required.providerTeamId);
        if (!game || required.providerPlayerId !== player.providerPlayerId || game.startsAtMs !== required.nhlGameScheduledStartsAtMs || ![game.homeTeamId, game.awayTeamId].includes(historicalTeam)) fail("A required historical NHL game binding changed.");
        if (!selected.has(game.id)) selected.set(game.id, { game, teamId: historicalTeam });
        else if (selected.get(game.id).teamId !== historicalTeam) fail("A required historical player-game changed team.");
      }
      const entries = [];
      for (const selectedGame of selected.values()) {
        const { game, teamId: gameTeamId } = selectedGame;
        const box = Object.hasOwn(selectedGame, "goals") && game.startsAtMs < startedAtMs - 8 * DAY_MS
          ? { state: "final", players: new Map([[playerId, { goals: selectedGame.goals, assists: selectedGame.assists, teamId: gameTeamId }]]) }
          : await getBox(game);
        // A newly completed game requires a new consistent aggregate capture.
        if (game.final !== (box.state === "final")) fail("The NHL game changed state during the snapshot.");
        const stats = box.players.get(playerId);
        if (stats && stats.teamId !== gameTeamId) fail("An NHL player-game team binding changed.");
        // Complete team boxscores affirm a non-participant's zero, including scratches.
        const goals = stats?.goals ?? 0, assists = stats?.assists ?? 0;
        if (Object.hasOwn(selectedGame, "goals") && (goals !== selectedGame.goals || assists !== selectedGame.assists)) fail("NHL totals and player-game evidence disagree.");
        entries.push({ providerTeamId: gameTeamId, nhlGameId: game.id, nhlGameScheduledStartsAtMs: game.startsAtMs, observedGameState: box.state });
        playerGameRows.push({ playerId, nhlGameId: game.id, nhlGameScheduledStartsAtMs: game.startsAtMs, observedGameState: box.state, goals, assists, sourceUpdatedAtMs: startedAtMs });
      }
      coverage.push({ playerId: player.playerId, providerPlayerId: player.providerPlayerId, providerTeamId: teamId, disposition: entries.length ? "expected_game" : teamId === null ? "no_team" : "no_due_game", games: entries });
    }
    const capturedAtMs = integer(nowMs(), "capture time");
    if (capturedAtMs < startedAtMs || capturedAtMs - startedAtMs > 5 * 60_000) fail("NHL snapshot capture exceeded its consistency window.");
    const sourceVersion = `nhl-completed-v1:${createHash("sha256").update(JSON.stringify({ season, completed: completed.map(({ id }) => id), totals: [...totals.values()], coverage, playerGameRows })).digest("hex")}`;
    gameStateSnapshot = { season, observedAtMs: startedAtMs, sourceVersion, games: new Map([...boxscores].map(([id, box]) => [id, { nhlGameId: id, nhlGameScheduledStartsAtMs: box.game.startsAtMs, observedGameState: box.state }])) };
    return { provider: PROVIDER_NAME, sourceVersion, capturedAtMs, totalsSourceUpdatedAtMs: startedAtMs, totalsRows: [...totals.values()], playerGameRows, playerGameCoverage: { schemaVersion: 1, throughAtMs: capturedAtMs, players: coverage } };
  }

  async function fetchGameStates({ nhlSeasonKey, requestedAtMs, games }) {
    if (!gameStateSnapshot || gameStateSnapshot.season !== nhlSeasonKey || requestedAtMs < gameStateSnapshot.observedAtMs || requestedAtMs - gameStateSnapshot.observedAtMs > 5 * 60_000) fail("NHL game-state evidence awaits the next scheduled refresh.", "NHL_GAME_STATE_AWAITING_REFRESH");
    const result = games.map((game) => {
      const observed = gameStateSnapshot.games.get(game.nhlGameId);
      if (!observed || observed.nhlGameScheduledStartsAtMs !== game.nhlGameScheduledStartsAtMs) fail("NHL game-state coverage is incomplete.");
      if (["scheduled", "pre_game"].includes(observed.observedGameState) && observed.nhlGameScheduledStartsAtMs <= requestedAtMs) fail("An NHL game may have started after observation.", "NHL_GAME_STATE_AWAITING_REFRESH");
      return observed;
    });
    return { provider: PROVIDER_NAME, sourceVersion: gameStateSnapshot.sourceVersion, observedAtMs: gameStateSnapshot.observedAtMs, games: result };
  }
  return Object.freeze({ fetchLiveSnapshot, fetchGameStates });
}

module.exports = { PROVIDER_NAME, PLAYER_IDENTITY_PROVIDER, createNhlCompletedGameAdapter, easternStart };
