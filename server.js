// server.js (CommonJS)
// -------------------------------
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { createLeagueStore } = require("./leagueStore");

const app = express();
const PORT = process.env.PORT || 4000;

// -------------------------------
// CORS allowlist (Netlify + local dev)
// -------------------------------
const allowlist = [
  "http://localhost:5173",
"http://localhost:5174",
"http://127.0.0.1:5173",
"http://127.0.0.1:5174",
  "https://hundoleago.netlify.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

// Express CORS (for fetch /api/league)
app.use(
  cors({
    origin: function (origin, cb) {
      // allow curl/postman/no-origin requests
      if (!origin) return cb(null, true);
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// -------------------------------
// Socket.IO server
// -------------------------------
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowlist,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log("🔌 WebSocket client connected:", socket.id);
  socket.on("disconnect", () => {
    console.log("❌ WebSocket client disconnected:", socket.id);
  });
});

app.set("io", io);

// ===============================
//   PERSISTENT STORAGE PATHS
// ===============================
//
// On Render you set:
//   LEAGUE_FILE  = /opt/render/project/data/hundo/league-state.json
//   SNAPSHOT_DIR = /opt/render/project/data/hundo/snapshots
//
// Locally it will fall back to files next to server.js.

const DATA_FILE =
  process.env.LEAGUE_FILE || path.join(__dirname, "league-state.json");

const SNAPSHOT_DIR =
  process.env.SNAPSHOT_DIR || path.join(__dirname, "snapshots");
// Phase 2A: players database file (separate from league state)
//
// IMPORTANT:
// On Render, do NOT derive this from DATA_FILE. DATA_FILE can be /data/... depending on your env,
// while Render’s persistent disk is /opt/render/project/data.
// Default to the same /opt/render/project/data/hundo folder you use for league-state.json.
const DEFAULT_PLAYERS_FILE = "/opt/render/project/data/hundo/players.json";
const PLAYERS_FILE =
  process.env.PLAYERS_FILE ||
  (String(process.env.LEAGUE_FILE || "").includes("/opt/render/project/data/")
    ? path.join(path.dirname(process.env.LEAGUE_FILE), "players.json")
    : DEFAULT_PLAYERS_FILE);

// Phase 2B: stats cache file (separate from league state + players DB)
const DEFAULT_STATS_FILE = "/opt/render/project/data/hundo/stats-cache.json";
const STATS_FILE =
  process.env.STATS_FILE ||
  (String(process.env.LEAGUE_FILE || "").includes("/opt/render/project/data/")
    ? path.join(path.dirname(process.env.LEAGUE_FILE), "stats-cache.json")
    : DEFAULT_STATS_FILE);

// Ensure dirs exist (important on Render disk paths)
function ensureDirSync(dirPath) {
  try {
    if (!dirPath) return;
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    console.error("[BACKEND] Failed to ensure directory:", dirPath, e);
  }
}
ensureDirSync(path.dirname(DATA_FILE));
ensureDirSync(SNAPSHOT_DIR);
ensureDirSync(path.dirname(PLAYERS_FILE));
ensureDirSync(path.dirname(STATS_FILE));

// If players file is missing on the Render disk, bootstrap it from repo players.json (one-time).
// This avoids “empty DB” in production after deploys.
try {
  if (!fs.existsSync(PLAYERS_FILE)) {
    const repoPlayers = path.join(__dirname, "players.json");
    if (fs.existsSync(repoPlayers)) {
      fs.copyFileSync(repoPlayers, PLAYERS_FILE);
      console.log("[PLAYERS] bootstrapped players.json to", PLAYERS_FILE);
    } else {
      console.warn("[PLAYERS] missing both disk and repo players.json; DB will be empty until synced");
    }
  }
} catch (e) {
  console.error("[PLAYERS] bootstrap copy failed:", e?.message || e);
}

// -------------------------------
// LeagueStore (Phase 1: atomic + queued writes)
// -------------------------------
const BACKUPS_DIR =
  process.env.BACKUPS_DIR || path.join(path.dirname(DATA_FILE), "backups");

ensureDirSync(BACKUPS_DIR);

const leagueStore = createLeagueStore({
  dataFilePath: DATA_FILE,
  backupsDirPath: BACKUPS_DIR,
  maxBackups: Number(process.env.MAX_BACKUPS || 200) || 200,
});

// ===============================
// Phase 2A — Player DB (file-backed)
// ===============================
let playersCache = [];
let playersById = new Map();

function normalizeStr(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchHaystack(p) {
  const full = p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim();
  const first = p.firstName || "";
  const last = p.lastName || "";
  const lastFirst = `${last}, ${first}`.trim();
  return normalizeStr([full, first, last, lastFirst].filter(Boolean).join(" | "));
}

function loadPlayersFromDisk() {
  try {
    if (!fs.existsSync(PLAYERS_FILE)) {
      playersCache = [];
      playersById = new Map();
      return { ok: true, count: 0, source: "missing-file" };
    }

    const raw = fs.readFileSync(PLAYERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.players)
      ? parsed.players
      : [];

    // Helper: pick first non-empty string from several possible keys
    const pickStr = (obj, keys) => {
      for (const k of keys) {
        const v = obj?.[k];
        if (v == null) continue;
        const s = String(v).trim();
        if (s) return s;
      }
      return "";
    };

    const pickNum = (obj, keys) => {
      for (const k of keys) {
        const v = obj?.[k];
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return NaN;
    };

    playersCache = arr
      .filter(Boolean)
      .map((p) => {
        const id = pickNum(p, ["id", "playerId", "player_id"]);
        const fullName = pickStr(p, ["fullName", "full_name", "name", "playerName"]);
        const firstName = pickStr(p, ["firstName", "first_name", "first"]);
        const lastName = pickStr(p, ["lastName", "last_name", "last"]);
        const position = pickStr(p, ["position", "pos"]) || null;
        const teamAbbrev = pickStr(p, ["teamAbbrev", "team_abbrev", "team", "teamAbbreviation"]) || null;
        const birthDate = pickStr(p, ["birthDate", "birth_date", "dob", "dateOfBirth"]) || null;


        // active can be missing; treat missing as true
        const activeRaw = p?.active;
        const active = activeRaw === undefined ? true : activeRaw !== false;

        return {
          id,
          fullName,
          firstName,
          lastName,
          position,
          teamAbbrev,
          active,
          birthDate,
        };
      })
      .filter((p) => Number.isFinite(p.id) && p.id > 0);

    playersById = new Map(playersCache.map((p) => [p.id, p]));

    // 🔎 One very useful debug print so we can see if names loaded

    return { ok: true, count: playersCache.length, source: PLAYERS_FILE };
  } catch (e) {
    console.error("[PLAYERS] Failed to load players:", e);
    playersCache = [];
    playersById = new Map();
    return { ok: false, count: 0, error: String(e?.message || e) };
  }
}

function searchPlayers(query, limit = 25) {
  const q = normalizeStr(query);
  if (!q) return [];

  const tokens = q.split(" ").filter(Boolean);
  const out = [];

  for (const p of playersCache) {
    if (!p?.active) continue;

    const hay = buildSearchHaystack(p);

    // Match ALL tokens anywhere in the haystack
    const ok = tokens.every((t) => hay.includes(t));
    if (ok) out.push(p);

    if (out.length >= limit) break;
  }

  return out;
}


// Load players on boot
const playersLoad = loadPlayersFromDisk();
console.log("[PLAYERS] PLAYERS_FILE =", PLAYERS_FILE);

console.log(
  `[PLAYERS] loaded: ok=${playersLoad.ok} count=${playersLoad.count} source=${playersLoad.source || "?"}`
);

// -------------------------------
// Time helpers (Pacific time window checks)
// -------------------------------
function getPartsInTZ(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out; // { weekday, year, month, day, hour, minute }
}

// -------------------------------
// Snapshots helpers
// -------------------------------
function buildAutoSnapshotId(partsPT) {
  // Example: auto-2025-12-14-1600PT
  return `auto-${partsPT.year}-${partsPT.month}-${partsPT.day}-${partsPT.hour}${partsPT.minute}PT`;
}

function writeSnapshotFile(snapshotId, state) {
  const file = path.join(SNAPSHOT_DIR, `${snapshotId}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  return snapshotId;
}

// -------------------------------
// Auto-weekly snapshot (Sunday 4:00 PM PT)
// -------------------------------
function tryAutoWeeklySnapshot() {
  try {
    const timeZone = "America/Los_Angeles";
    const partsPT = getPartsInTZ(new Date(), timeZone);

    if (partsPT.weekday !== "Sun") return;

    const hour = Number(partsPT.hour);
    const minute = Number(partsPT.minute);
    const inWindow = hour === 16 && minute >= 0 && minute <= 10;
    if (!inWindow) return;

    const snapshotId = buildAutoSnapshotId({
      ...partsPT,
      minute: "00",
    });

    const state = leagueStore.loadLeague();
    if (state.lastAutoWeeklySnapshotId === snapshotId) return;

    writeSnapshotFile(snapshotId, state);

    state.lastAutoWeeklySnapshotId = snapshotId;
    Promise.resolve(
  leagueStore.saveLeague(state, { savedBy: "system:autoWeeklySnapshot" })
).catch((e) => console.error("[AUTO SNAPSHOT] save failed:", e));



    console.log(`[AUTO SNAPSHOT] Created weekly snapshot: ${snapshotId}`);

    const ioRef = app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "autoWeeklySnapshot", snapshotId });
  } catch (err) {
    console.error("[AUTO SNAPSHOT] Failed:", err);
  }
}

// -------------------------------
// Auto-auction rollover (Sunday 4:00 PM PT)
// -------------------------------
const BUYOUT_LOCK_MS = 14 * 24 * 60 * 60 * 1000;

function buildAutoAuctionRolloverId(partsPT) {
  // Example: auction-2025-12-14-1600PT
  return `auction-${partsPT.year}-${partsPT.month}-${partsPT.day}-${partsPT.hour}${partsPT.minute}PT`;
}

function resolveAuctionsServer(state, nowMs) {
  const teams = Array.isArray(state.teams) ? state.teams : [];
  const bids = Array.isArray(state.freeAgents) ? state.freeAgents : [];
  const leagueLog = Array.isArray(state.leagueLog) ? state.leagueLog : [];

  const activeBids = bids.filter((b) => !b.resolved);
  if (activeBids.length === 0) {
    return { nextTeams: teams, nextFreeAgents: bids, nextLeagueLog: leagueLog, newLogs: [] };
  }

 // Group bids by auctionKey (preferred) or normalized player name
const bidsByPlayer = new Map();
for (const bid of activeBids) {
  const key = String(
    bid?.auctionKey || String(bid?.player || "").trim().toLowerCase()
  )
    .trim()
    .toLowerCase();

  if (!key) continue;
  if (!bidsByPlayer.has(key)) bidsByPlayer.set(key, []);
  bidsByPlayer.get(key).push(bid);
}


  const nextTeams = teams.map((t) => ({
    ...t,
    roster: [...(t.roster || [])],
    buyouts: [...(t.buyouts || [])],
  }));

  const resolvedBidIds = new Set();
  const newLogs = [];

  for (const [, playerBids] of bidsByPlayer.entries()) {
    const sorted = [...playerBids].sort((a, b) => {
      const aAmt = Number(a.amount) || 0;
      const bAmt = Number(b.amount) || 0;
      if (bAmt !== aAmt) return bAmt - aAmt;
      const aTs = a.timestamp || 0;
      const bTs = b.timestamp || 0;
      return aTs - bTs; // earlier wins ties
    });

    const winner = sorted[0];
    if (!winner) continue;

    const playerName = winner.player;
    const winningTeamName = winner.team;
    const newSalary = Number(winner.amount) || 0;
    const position = winner.position || "F";

    for (const bid of playerBids) resolvedBidIds.add(bid.id);

    const teamIdx = nextTeams.findIndex((t) => t.name === winningTeamName);
    if (teamIdx === -1) continue;

   nextTeams[teamIdx].roster.push({
  name: playerName,
  salary: newSalary,
  position,
  buyoutLockedUntil: nowMs + BUYOUT_LOCK_MS,
});

// Keep roster ordering consistent after auto-rollover:
// Forwards first, then Defense; salary high -> low; tie-break name A -> Z
nextTeams[teamIdx].roster.sort((a, b) => {
  const aIsD = (a?.position || "F") === "D";
  const bIsD = (b?.position || "F") === "D";
  if (aIsD !== bIsD) return aIsD ? 1 : -1;

  const sa = Number(a?.salary) || 0;
  const sb = Number(b?.salary) || 0;
  if (sb !== sa) return sb - sa;

  return String(a?.name || "").localeCompare(String(b?.name || ""));
});


    newLogs.push({
      type: "faSigned",
      id: nowMs + Math.random(),
      team: winningTeamName,
      player: playerName,
      amount: newSalary,
      position,
      timestamp: nowMs,
    });
  }

  const nextFreeAgents = bids.filter((bid) => !resolvedBidIds.has(bid.id));
  const nextLeagueLog = [...newLogs, ...leagueLog];

  return { nextTeams, nextFreeAgents, nextLeagueLog, newLogs };
}

function tryAutoAuctionRollover() {
  try {
    const timeZone = "America/Los_Angeles";
    const partsPT = getPartsInTZ(new Date(), timeZone);

    if (partsPT.weekday !== "Sun") return;

    const hour = Number(partsPT.hour);
    const minute = Number(partsPT.minute);
    const inWindow = hour === 16 && minute >= 0 && minute <= 10;
    if (!inWindow) return;

    const rolloverId = buildAutoAuctionRolloverId({
      ...partsPT,
      minute: "00",
    });

    const state = leagueStore.loadLeague();
    if (state.lastAutoAuctionRolloverId === rolloverId) return;

    const nowMs = Date.now();
    const { nextTeams, nextFreeAgents, nextLeagueLog, newLogs } = resolveAuctionsServer(state, nowMs);

    state.teams = nextTeams;
    state.freeAgents = nextFreeAgents;
    state.leagueLog = nextLeagueLog;

    state.lastAutoAuctionRolloverId = rolloverId;
    Promise.resolve(
  leagueStore.saveLeague(state, { savedBy: "system:autoAuctionRollover" })
).catch((e) => console.error("[AUTO AUCTIONS] save failed:", e));


    console.log(`[AUTO AUCTIONS] Rollover complete: ${rolloverId} (signings: ${newLogs.length})`);

    const ioRef = app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "autoAuctionRollover", rolloverId });
  } catch (err) {
    console.error("[AUTO AUCTIONS] Failed:", err);
  }
}
function isArray(x) {
  return Array.isArray(x);
}

function looksLikeWipe(prev, incomingTeams) {
  const prevTeams = Array.isArray(prev?.teams) ? prev.teams : [];
  const nextTeams = Array.isArray(incomingTeams) ? incomingTeams : [];

  // If we had teams before, and the incoming save has zero teams -> classic wipe
  return prevTeams.length > 0 && nextTeams.length === 0;
}

function isManagerWriteBlockedByFreeze(prevState, meta) {
  const frozen = Boolean(prevState?.settings?.frozen);
  if (!frozen) return false;

  const role = String(meta?.actorRole || "").toLowerCase();

  // Commissioner can still write while frozen
  if (role === "commissioner") return false;

  // Everyone else blocked while frozen
  return true;
}

// ===============================
// ROUTES
// ===============================
app.get("/", (req, res) => {
  res.send("Hundo Leago backend is running.");
});

app.get("/health", (req, res) => {
  const st = leagueStore.loadLeague();
  res.json({
    ok: true,
    schemaVersion: st.schemaVersion ?? null,
    loadedFromDisk: Boolean(st?.meta?.loadedFromDisk),
    dataFilePath: st?.meta?.dataFilePath || DATA_FILE,
    lastSavedAt: st?.meta?.lastSavedAt || null,
    lastSavedBy: st?.meta?.lastSavedBy || null,
    hasLoadError: Boolean(st?.meta?.loadError),
        backupsDir: leagueStore.backupsDir || BACKUPS_DIR,
    backupsCount: (() => {
      try {
        return leagueStore.listBackups({ limit: 999999 }).length;
      } catch (_) {
        return null;
      }
    })(),

  });
  
});

app.get("/api/league", (req, res) => {
  const state = leagueStore.loadLeague();
  res.json(state);
});

app.post("/api/league", async (req, res) => {
  const body = req.body || {};

  try {
    const prev = leagueStore.loadLeague();


    // ----------------------------
    // Phase 0 write-safety guards
    // ----------------------------
    const meta = body.meta || {};

    // Freeze enforcement: block manager writes while frozen
    if (isManagerWriteBlockedByFreeze(prev, meta)) {
      return res.status(423).json({
        ok: false,
        error: "League is frozen. Manager writes are blocked.",
      });
    }

    // Prevent accidental wipe saves (teams becomes empty)
    if (looksLikeWipe(prev, body.teams)) {
      return res.status(400).json({
        ok: false,
        error: "Refusing save: incoming teams is empty (wipe protection).",
      });
    }

    // Basic shape validation: arrays must be arrays (not null/objects)
    if (
      !isArray(body.teams) ||
      !isArray(body.freeAgents) ||
      !isArray(body.leagueLog) ||
      !isArray(body.tradeProposals) ||
      !isArray(body.tradeBlock)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Refusing save: invalid payload shape (arrays expected).",
      });
    }

    const next = {
      ...prev,
      teams: Array.isArray(body.teams) ? body.teams : [],
      freeAgents: Array.isArray(body.freeAgents) ? body.freeAgents : [],
      leagueLog: Array.isArray(body.leagueLog) ? body.leagueLog : [],
      tradeProposals: Array.isArray(body.tradeProposals) ? body.tradeProposals : [],
      tradeBlock: Array.isArray(body.tradeBlock) ? body.tradeBlock : [],
      settings:
        body.settings && typeof body.settings === "object"
          ? body.settings
          : prev.settings || { frozen: false },
      nextAuctionDeadline: body.nextAuctionDeadline || prev.nextAuctionDeadline || null,

      // preserve auto markers
     lastAutoWeeklySnapshotId: prev.lastAutoWeeklySnapshotId,
lastAutoAuctionRolloverId: prev.lastAutoAuctionRolloverId,
    };

    await leagueStore.saveLeague(next, {
  savedBy:
    String(meta?.actorRole || "").toLowerCase() === "commissioner"
      ? "commissioner"
      : (meta?.actorTeam || "manager"),
});


    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "saveLeague" });

    res.json({ ok: true });
  } catch (err) {
    console.error("[BACKEND] Error writing league-state.json:", err);
    res.status(500).json({ ok: false, error: "Failed to save state" });
  }
});
// ===============================
// Phase 2A — Player API
// ===============================

app.get("/api/players", (req, res) => {
  const q = String(req.query?.query || "").trim();

  // If NO query (your preload case), allow a large response, but keep a safety cap.
  // 5000 is plenty (your DB is ~2k) and prevents insane payloads.
  const rawLimit = Number(req.query?.limit);
  const limitNoQuery = Math.max(1, Math.min(5000, Number.isFinite(rawLimit) ? rawLimit : 5000));

  // If query IS present (typeahead search), keep it small for speed.
  const limitQuery = Math.max(1, Math.min(100, Number(req.query?.limit || 25) || 25));

  // No query: return a large slice (PRELOAD PATH)
  if (!q) {
    return res.json({
      ok: true,
      players: playersCache.slice(0, limitNoQuery),
      count: playersCache.length,
      cacheCount: playersCache.length,
      limitUsed: limitNoQuery,
    });
  }

  // Query: return search results (SEARCH PATH)
  const results = searchPlayers(q, limitQuery);
  return res.json({
    ok: true,
    players: results,
    count: playersCache.length,
    cacheCount: playersCache.length,
    limitUsed: limitQuery,
  });
});





// TEMP DEBUG: verify players file path + existence + size (safe read-only)
// IMPORTANT: must come BEFORE /api/players/:id
app.get("/api/players/debug", (req, res) => {
  try {
    const repoPlayers = path.join(__dirname, "players.json");

    const statSafe = (p) => {
      try {
        if (!fs.existsSync(p)) return { exists: false };
        const st = fs.statSync(p);
        return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
      } catch (e) {
        return { exists: false, error: String(e?.message || e) };
      }
    };

    res.json({
      ok: true,
      PLAYERS_FILE,
      disk: statSafe(PLAYERS_FILE),
      repo: statSafe(repoPlayers),
      cacheCount: playersCache.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


// GET /api/players/8478402
app.get("/api/players/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "Invalid player id" });
  }

  const p = playersById.get(id);
  if (!p) {
    return res.status(404).json({ ok: false, error: "Player not found" });
  }

  res.json({ ok: true, player: p });
});


// POST /api/players/reload  (optional admin utility for dev)
app.post("/api/players/reload", (req, res) => {
  const r = loadPlayersFromDisk();
  res.json({
    ok: r.ok,
    count: r.count,
    source: r.source || null,
    error: r.error || null,
  });
});

// ===============================
// Phase 2B — Stats Cache API (read-only)
// ===============================

app.get("/api/stats", (req, res) => {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      return res.status(200).json({ ok: true, ready: false, byPlayerId: {} });
    }

    const raw = fs.readFileSync(STATS_FILE, "utf8");
    const json = JSON.parse(raw);

    // OPTIONAL: allow fetching a single player's stats
    const playerId = String(req.query?.playerId || "").trim();
    if (playerId) {
      return res.status(200).json({
        ok: true,
        playerId,
        stats: json?.byPlayerId?.[playerId] || null,
      });
    }

    // Default: return full cache
    return res.status(200).json(json);
  } catch (e) {
    console.error("[STATS] Failed to read stats cache:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Failed to load stats cache" });
  }
});

// POST /api/stats/refresh (protected)
// Triggers stats refresh + writes cache to disk.
// Does NOT touch league state.
app.post("/api/stats/refresh", async (req, res) => {
  try {
    const token = req.get("x-stats-token") || "";
    const expected = process.env.STATS_REFRESH_TOKEN || "";

    if (!expected || token !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // We will export this function from scripts/refreshStats.js in the next step.
    const { refreshStatsNow } = require("./scripts/refreshStats");

    const result = await refreshStatsNow();
    return res.json({ ok: true, result });
  } catch (err) {
    console.error("stats refresh failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});


app.get("/api/snapshots", (req, res) => {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return res.json({ snapshots: [] });

    const files = fs.readdirSync(SNAPSHOT_DIR);
    const snapshots = files
      .filter((f) => f.endsWith(".json"))
      .map((file) => {
        const full = path.join(SNAPSHOT_DIR, file);
        const stat = fs.statSync(full);
        return {
          id: path.basename(file, ".json"),
          createdAt: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    res.json({ snapshots });
  } catch (err) {
    console.error("[BACKEND] Error listing snapshots:", err);
    res.status(500).json({ snapshots: [], error: "Failed to load snapshots" });
  }
});

app.post("/api/snapshots/restore", async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "Missing snapshot id in body" });

  const file = path.join(SNAPSHOT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: "Snapshot not found" });

  try {
    const raw = fs.readFileSync(file, "utf8");
const restored = JSON.parse(raw);

// IMPORTANT: merge with defaults so new fields aren't lost
const next = { ...leagueStore.emptyState(), ...restored };


// ✅ Phase 0F: backend-owned restore log (cannot be lost)
const now = Date.now();
const prevLog = Array.isArray(next.leagueLog) ? next.leagueLog : [];
next.leagueLog = [
  {
    id: now + Math.random(),
    type: "commRestoreSnapshot",
    by: "Commissioner",
    snapshotId: id,
    timestamp: now,
  },
  ...prevLog,
];

await leagueStore.saveLeague(next, { savedBy: "commissioner:snapshotRestore" });


const ioRef = req.app.get("io");
if (ioRef) ioRef.emit("league:updated", { reason: "snapshotRestored", snapshotId: id });

res.json({ ok: true });

  } catch (err) {
    console.error("[BACKEND] Error restoring snapshot:", err);
    res.status(500).json({ ok: false, error: "Failed to restore snapshot" });
  }
});

app.post("/api/snapshots/create", (req, res) => {
  try {
    const { name } = req.body || {};
    const state = leagueStore.loadLeague();


    const ts = new Date();
    const stamp = ts
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");

    const rawName = (name || "").trim();
    const safeName = rawName
      ? rawName
          .toLowerCase()
          .replace(/[^a-z0-9-_ ]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 40)
      : "";

    const snapshotId = safeName ? `${stamp}__${safeName}` : stamp;
    const file = path.join(SNAPSHOT_DIR, `${snapshotId}.json`);

    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "snapshotCreated", snapshotId });

    res.json({ ok: true, snapshotId });
  } catch (err) {
    console.error("[BACKEND] Error creating snapshot:", err);
    res.status(500).json({ ok: false, error: "Failed to create snapshot" });
  }
});

// -------------------------------
// Backups (Phase 1: versioned backups)
// -------------------------------

// List backups (newest first)
// GET /api/backups?limit=50
app.get("/api/backups", (req, res) => {
  try {
    const limit = Number(req.query?.limit || 50) || 50;
    const backups = leagueStore.listBackups({ limit });
    res.json({ ok: true, backups, backupsDir: leagueStore.backupsDir });
  } catch (err) {
    console.error("[BACKUPS] list failed:", err);
    res.status(500).json({ ok: false, error: "Failed to list backups" });
  }
});

// Restore a backup by filename id
// POST /api/backups/restore { id, meta? }
app.post("/api/backups/restore", async (req, res) => {
  console.log("[RESTORE] content-type:", req.headers["content-type"]);
console.log("[RESTORE] body:", req.body);

 const body = req.body || {};
const meta = body.meta || {};
const id = body.id || body.backupId; // accept either key

if (!id) {
  return res.status(400).json({
    ok: false,
    error: "Missing backup id in body (expected: id or backupId)",
  });
}


  // Safety: only allow commissioner-triggered restore
  const role = String(meta?.actorRole || "").toLowerCase();
  if (role !== "commissioner") {
    return res.status(403).json({ ok: false, error: "Restore requires commissioner role." });
  }

  try {
    const restoredRaw = await leagueStore.restoreBackup(id, { restoredBy: "commissioner" });
const restored = { ...leagueStore.emptyState(), ...restoredRaw };


    // Add a backend-owned log entry so it can't be “not saved”
    const now = Date.now();
    const prevLog = Array.isArray(restored.leagueLog) ? restored.leagueLog : [];
    restored.leagueLog = [
      {
        id: now + Math.random(),
        type: "commRestoreBackup",
        by: "Commissioner",
        backupId: id,
        timestamp: now,
      },
      ...prevLog,
    ];

    await leagueStore.saveLeague(restored, { savedBy: "commissioner:backupRestore" });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "backupRestored", backupId: id });

    res.json({ ok: true });
  } catch (err) {
    console.error("[BACKUPS] restore failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to restore backup" });
  }
});

// ===============================
// BOOT: auto jobs + server listen
// ===============================
tryAutoWeeklySnapshot();
setInterval(tryAutoWeeklySnapshot, 60 * 1000);

tryAutoAuctionRollover();
setInterval(tryAutoAuctionRollover, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Hundo Leago backend + WebSocket listening on port ${PORT}`);
});
