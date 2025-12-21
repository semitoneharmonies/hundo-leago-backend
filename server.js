// server.js (CommonJS)
// -------------------------------
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 4000;

// -------------------------------
// CORS allowlist (Netlify + local dev)
// -------------------------------
const allowlist = [
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

// -------------------------------
// State helpers
// -------------------------------
function emptyState() {
  return {
    teams: [],
    freeAgents: [],
    leagueLog: [],
    tradeProposals: [],
    tradeBlock: [],
    settings: { frozen: false },
    nextAuctionDeadline: null,
    lastAutoWeeklySnapshotId: null,
    lastAutoAuctionRolloverId: null,
  };
}

function loadLeagueState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.warn("[BACKEND] league-state.json not found, using empty state");
      return emptyState();
    }
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : emptyState();
  } catch (err) {
    console.error("[BACKEND] Failed to read league-state.json:", err);
    return emptyState();
  }
}

function saveLeagueState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
}

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

    const state = loadLeagueState();
    if (state.lastAutoWeeklySnapshotId === snapshotId) return;

    writeSnapshotFile(snapshotId, state);

    state.lastAutoWeeklySnapshotId = snapshotId;
    saveLeagueState(state);

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

    const state = loadLeagueState();
    if (state.lastAutoAuctionRolloverId === rolloverId) return;

    const nowMs = Date.now();
    const { nextTeams, nextFreeAgents, nextLeagueLog, newLogs } = resolveAuctionsServer(state, nowMs);

    state.teams = nextTeams;
    state.freeAgents = nextFreeAgents;
    state.leagueLog = nextLeagueLog;

    state.lastAutoAuctionRolloverId = rolloverId;
    saveLeagueState(state);

    console.log(`[AUTO AUCTIONS] Rollover complete: ${rolloverId} (signings: ${newLogs.length})`);

    const ioRef = app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "autoAuctionRollover", rolloverId });
  } catch (err) {
    console.error("[AUTO AUCTIONS] Failed:", err);
  }
}

// ===============================
// ROUTES
// ===============================
app.get("/", (req, res) => {
  res.send("Hundo Leago backend is running.");
});

app.get("/api/league", (req, res) => {
  const state = loadLeagueState();
  res.json(state);
});

app.post("/api/league", (req, res) => {
  const body = req.body || {};

  try {
    const prev = loadLeagueState();

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
      lastAutoWeeklySnapshotId: prev.lastAutoWeeklySnapshotId || null,
      lastAutoAuctionRolloverId: prev.lastAutoAuctionRolloverId || null,
    };

    saveLeagueState(next);

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "saveLeague" });

    res.json({ ok: true });
  } catch (err) {
    console.error("[BACKEND] Error writing league-state.json:", err);
    res.status(500).json({ ok: false, error: "Failed to save state" });
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

app.post("/api/snapshots/restore", (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "Missing snapshot id in body" });

  const file = path.join(SNAPSHOT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: "Snapshot not found" });

  try {
    const raw = fs.readFileSync(file, "utf8");
    const state = JSON.parse(raw);
    saveLeagueState(state);

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
    const state = loadLeagueState();

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
