// scripts/refreshStats.js
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/opt/render/project/data/hundo";
const STATS_FILE = process.env.STATS_FILE || path.join(DATA_DIR, "stats-cache.json");
const LOCK_FILE = process.env.STATS_LOCK_FILE || path.join(DATA_DIR, "stats-refresh.lock");

// NHL API settings
const SEASON_ID = process.env.STATS_SEASON_ID || guessSeasonId(); // e.g. 20252026
const GAME_TYPE_ID = 2; // regular season only
const PAGE_SIZE = 100;

function guessSeasonId() {
  // NHL seasons cross years. If we're in Jan–Jun, we're in the season that started last year.
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  const startYear = m <= 6 ? y - 1 : y;
  const endYear = startYear + 1;
  return `${startYear}${endYear}`; // "20252026"
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function acquireLock(maxAgeMs = 15 * 60 * 1000) {
  // If lock exists and is fresh, abort.
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const raw = fs.readFileSync(LOCK_FILE, "utf8");
      const { ts } = JSON.parse(raw);
      if (typeof ts === "number" && Date.now() - ts < maxAgeMs) {
        return false;
      }
      // stale lock -> continue (we'll overwrite)
    } catch {
      // malformed lock -> continue
    }
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }), "utf8");
  return true;
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "hundo-leago/1.0" } });
  if (!res.ok) throw new Error(`NHL stats fetch failed: ${res.status} ${res.statusText}`);
  return res.json();
}

function buildUrl(start) {
  // Minimal fields needed: goals, assists, points, gamesPlayed, playerId
  // We include gamesPlayed>=1 to limit to players who actually appeared.
  const sort = encodeURIComponent(
    JSON.stringify([
      { property: "points", direction: "DESC" },
      { property: "playerId", direction: "ASC" },
    ])
  );

  const cayenneExp = encodeURIComponent(
    `gameTypeId=${GAME_TYPE_ID} and seasonId>=${SEASON_ID} and seasonId<=${SEASON_ID}`
  );

  const factCayenneExp = encodeURIComponent("gamesPlayed>=1");

  return `https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&isGame=false&sort=${sort}&start=${start}&limit=${PAGE_SIZE}&factCayenneExp=${factCayenneExp}&cayenneExp=${cayenneExp}`;
}

async function refreshStatsNow() {
  ensureDirSync(DATA_DIR);

  if (!acquireLock()) {
    console.log("Stats refresh already running; exiting.");
    return;
  }

  try {
    console.log(`Refreshing stats season=${SEASON_ID} gameType=${GAME_TYPE_ID}...`);

    // First page to learn total
    const first = await fetchJson(buildUrl(0));
    const total = Number(first?.total || 0);
    const pages = Math.ceil(total / PAGE_SIZE);

    if (!Array.isArray(first?.data) || total <= 0) {
      throw new Error(`Unexpected NHL response (total=${total})`);
    }

    const byPlayerId = Object.create(null);

    const consume = (rows) => {
      for (const r of rows) {
        const pid = r?.playerId;
        if (!pid) continue;
        byPlayerId[String(pid)] = {
          goals: Number(r?.goals || 0),
          assists: Number(r?.assists || 0),
          points: Number(r?.points || 0),
          gamesPlayed: Number(r?.gamesPlayed || 0),
        };
      }
    };

    consume(first.data);

    for (let p = 1; p < pages; p++) {
      const start = p * PAGE_SIZE;
      const page = await fetchJson(buildUrl(start));
      if (!Array.isArray(page?.data)) throw new Error("Unexpected NHL page shape");
      consume(page.data);
    }

    // Basic sanity check: don't overwrite cache with suspiciously tiny data
    const count = Object.keys(byPlayerId).length;
    if (count < 200) throw new Error(`Refusing to write: only ${count} players returned`);

    const payload = {
      ok: true,
      seasonId: String(SEASON_ID),
      gameTypeId: GAME_TYPE_ID,
      lastUpdatedAt: Date.now(),
      byPlayerId,
    };

    const tmp = `${STATS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, STATS_FILE); // atomic swap on same filesystem

    console.log(`Stats refreshed: ${count} players`);
  } finally {
    releaseLock();
  }
}

module.exports = { refreshStatsNow };

// If run directly (cron / manual CLI), execute it
if (require.main === module) {
  refreshStatsNow().catch((err) => {
    console.error("Stats refresh failed:", err?.message || err);
    process.exitCode = 1;
  });
}

